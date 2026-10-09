/**
 * D-154: model providers in the database, seeded once from the operator's providers file, keys sealed in the vault.
 *
 * Proven here, on loopback and under `tests/.scratch` only: without a database the file is used as is and nothing can
 * change; with one, the file seeds it once and is never written; every provider (seeded or added) is edited through
 * one PUT, installed live and read back without a key; a typed key is sealed (absent from every byte on disk), reaches
 * its provider's client and is redacted from task output; `keep` cannot follow a provider to another host; a removed
 * provider's sealed key goes with it; without a vault key a key is refused, never stored in plaintext. The net grants
 * are an injected permissions API; the file system is real.
 */
import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes } from '@std/assert';
import { join, resolve } from '@std/path';
import { AgentError } from '@tykotech/agents';
import { SessionRegistry } from '@tykotech/mcp';
import { startFakeProvider } from '../../../tests/support/fake_provider.ts';
import { createGatewayApp, type GatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { openDataStore, type OpenedDataStore } from './data_store.ts';
import { createExpansionServices } from './expansion.ts';
import { createLogger } from './logger.ts';
import { loadModelProviders, type ModelProvidersConfig, type ModelProviderSettings } from './model_providers.ts';
import { ModelProvidersAdmin, providerKeyName } from './model_providers_admin.ts';
import { AGENT_SETTINGS_KEY, AgentSettingsStore } from './agent_settings.ts';
import { SeedError } from './seed.ts';
import { generateDbKey } from './vault.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const ROUTE = '/api/v1/system/model-providers';
/** The operator's inline key; sixteen-plus characters, so it would be redacted if it ever leaked. */
const KEY = 'sk-inline-0123456789abcdefghijklmnop';
/** The key an administrator types in the web app. */
const TYPED = 'sk-typed-abcdefghijklmnopqrstuvwxyz0123';
/** Two loopback hosts: the first is never granted (unreachable), the second is. */
const UNGRANTED = 'http://127.0.0.1:9/v1';
const UNGRANTED_HOST = '127.0.0.1:9';
const GRANTED_HOST = '127.0.0.1:11434';
const GRANTED = `http://${GRANTED_HOST}/v1`;
const NO_TEXT_BACKEND = 'Text execution requires a configured ACP agent or a model provider';
const DB_KEY = generateDbKey();

/** A permissions API granting `net` for the listed hosts only. */
function permissions({ net = [GRANTED_HOST] }: { net?: readonly string[] } = {}): Pick<Deno.Permissions, 'querySync'> {
	const status = (granted: boolean): Deno.PermissionStatus =>
		({ state: granted ? 'granted' : 'prompt' }) as Deno.PermissionStatus;
	return {
		querySync: (descriptor: Deno.PermissionDescriptor): Deno.PermissionStatus => {
			if (descriptor.name === 'net') {
				const host = (descriptor as Deno.NetPermissionDescriptor).host;
				return status(host !== undefined && net.includes(host));
			}
			return status(descriptor.name === 'read' || descriptor.name === 'write');
		},
	};
}

/** The operator's file: one provider, an inline key, an ungranted loopback host (so it is the default, as sole). */
const OPERATOR = {
	version: 1,
	providers: [{ id: 'local', kind: 'openai', label: 'Local', base_url: UNGRANTED, models: ['m1'], api_key: KEY }],
};

interface Scratch {
	readonly dir: string;
	/** The operator's providers file. */
	readonly operator: string;
	/** `TTK_DATA_DIR`. */
	readonly data: string;
	[Symbol.asyncDispose](): Promise<void>;
}

async function scratch(operator: unknown = OPERATOR): Promise<Scratch> {
	const dir = resolve(`tests/.scratch/model-providers-admin-${crypto.randomUUID()}`);
	const data = `${dir}/data`;
	await Deno.mkdir(data, { recursive: true });
	await Deno.writeTextFile(`${dir}/providers.json`, `${JSON.stringify(operator, null, '\t')}\n`);
	return {
		dir,
		operator: `${dir}/providers.json`,
		data,
		async [Symbol.asyncDispose]() {
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

/** Every byte under `dir`, as text — what a backup of the data volume would carry. */
async function bytesOnDisk(dir: string): Promise<string> {
	let text = '';
	for await (const entry of Deno.readDir(dir)) {
		const path = join(dir, entry.name);
		if (entry.isFile) text += new TextDecoder('latin1').decode(await Deno.readFile(path));
		else if (entry.isDirectory) text += await bytesOnDisk(path);
	}
	return text;
}

/** A parsed JSON body, read field by field in assertions. */
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

interface Harness {
	readonly app: GatewayApp;
	readonly store: ModelProvidersAdmin;
	readonly data: OpenedDataStore;
	readonly lines: string[];
	readonly keys: { readonly admin: string; readonly agent: string };
	request(method: string, path: string, key: string | null, body?: unknown): Promise<Response>;
	get(): Promise<Json>;
	put(body: unknown): Promise<Response>;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * A gateway on the operator `file` (or none) and the data directory `data` (or none), its database opened and seeded
 * and its provider store loaded exactly as `startGateway` does. `vault: false` leaves `TTK_DB_KEY_FILE` unset.
 */
async function harness(
	file: string | null,
	data: string | null,
	options: { vault?: boolean; net?: readonly string[] } = {},
): Promise<Harness> {
	const admin = await generateApiKey('admin', ['admin', 'mcp:invoke']);
	const agent = await generateApiKey('agent', ['agent:invoke', 'model:invoke', 'mcp:invoke']);
	const operator = file === null ? null : await loadModelProviders({ TTK_MODEL_PROVIDERS_FILE: file });
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([admin.record, agent.record]),
		...(data === null ? {} : { TTK_DATA_DIR: data }),
	}, { modelProviders: operator, ...(options.vault === false ? {} : { secrets: { TTK_DB_KEY: DB_KEY } }) });
	const lines: string[] = [];
	const logger = createLogger({ level: 'info', write: (line: string): void => void lines.push(line) });
	const grant = permissions(options.net === undefined ? {} : { net: options.net });
	const opened = await openDataStore(config, { logger });
	const store = await ModelProvidersAdmin.load({ operator, store: opened.store, logger });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const app = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'model-providers-admin-test',
		logger,
		permissions: grant,
		modelProviderStore: store,
		agentSettings: new AgentSettingsStore(opened.store?.db ?? null),
	});
	const request = async (method: string, path: string, key: string | null, body?: unknown): Promise<Response> =>
		await app.app.request(`${ORIGIN}${path}`, {
			method,
			headers: {
				host: '127.0.0.1:8787',
				...(key === null ? {} : { authorization: `Bearer ${key}` }),
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
		});
	return {
		app,
		store,
		data: opened,
		lines,
		keys: { admin: admin.key, agent: agent.key },
		request,
		get: async () => await (await request('GET', ROUTE, admin.key)).json(),
		put: (body) => request('PUT', ROUTE, admin.key, body),
		async [Symbol.asyncDispose]() {
			await app.close();
			await registry.shutdown();
			opened.close();
		},
	};
}

/** A problem body: its slug (the `type`'s last segment), status and detail, and the raw text. */
async function problem(response: Response): Promise<{ slug: string; status: number; detail?: string; text: string }> {
	const text = await response.text();
	const body = JSON.parse(text) as { type: string; status: number; detail?: string };
	return {
		slug: body.type.split('/').pop()!,
		status: body.status,
		...(body.detail ? { detail: body.detail } : {}),
		text,
	};
}

/** The seeded provider, as a body entry that keeps everything it has. */
function seeded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'local',
		kind: 'openai',
		label: 'Local',
		base_url: UNGRANTED,
		models: ['m1'],
		key: { mode: 'keep' },
		...overrides,
	};
}

/** A provider the parser admits as it stands: keyless openai on the granted loopback host. */
function added(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { id: 'second', kind: 'openai', base_url: GRANTED, models: ['s1'], key: { mode: 'none' }, ...overrides };
}

/** The read-back of one provider row with no key, at the given values. */
function view(id: string, origin: 'seed' | 'admin', key: string, extra: Record<string, unknown> = {}): Json {
	return { id, origin, key: { source: key }, ...extra };
}

// --- without a database -------------------------------------------------------------------------------------------

Deno.test('D-154: with neither a providers file nor a data directory nothing is managed', async () => {
	await using h = await harness(null, null);
	assertEquals(await h.get(), {
		seed: { file: null, seeded_at: null },
		store: {
			available: false,
			reason: 'TTK_DATA_DIR is not set, so there is no database for providers; the providers file is used as is',
			database: null,
			vault: 'none',
		},
		default: null,
		providers: [],
	});
	const put = await problem(await h.put({ providers: [added()] }));
	assertEquals([put.status, put.slug], [409, 'persistence-required']);
});

Deno.test('D-154: without a data directory the providers file is used as is, never written, and read back keyless', async () => {
	await using s = await scratch();
	await using h = await harness(s.operator, null);
	const text = await (await h.request('GET', ROUTE, h.keys.admin)).text();
	assertFalse(text.includes(KEY), 'the inline key is never in the read-back');
	const document = JSON.parse(text);
	assertEquals(document.seed, { file: s.operator, seeded_at: null });
	assertEquals([document.store.available, document.store.vault], [false, 'none']);
	assertEquals(document.providers, [{
		id: 'local',
		kind: 'openai',
		label: 'Local',
		base_url: UNGRANTED,
		models: ['m1'],
		default_model: 'm1',
		headers: {},
		allow_http: false,
		max_tokens_param: 'max_tokens',
		max_steps: 24,
		max_output_tokens: 4096,
		token_budget: 400_000,
		origin: 'seed',
		key: { source: 'inline' },
		host: UNGRANTED_HOST,
		reachable: false,
		reason: 'no-net-grant',
	}]);
	assertEquals((await problem(await h.put({ providers: [] }))).status, 409);
});

// --- seeding and the database ------------------------------------------------------------------------------------

Deno.test('D-154: the providers file seeds the database once; its key is sealed and the file is never written', async () => {
	await using s = await scratch();
	const operatorBytes = await Deno.readTextFile(s.operator);
	{
		await using h = await harness(s.operator, s.data);
		const document = await h.get();
		assertEquals(document.seed.file, s.operator);
		assert(typeof document.seed.seeded_at === 'string');
		assertEquals(document.store, { available: true, database: `${s.data}/ttk.db`, vault: 'unlocked' });
		assertEquals(document.default, 'local');
		assertEquals(
			document.providers.map((p: Json) => view(p.id, p.origin, p.key.source)),
			[view('local', 'seed', 'stored')],
		);
		assertStringIncludes(h.lines.join('\n'), 'model providers: seeded 1 from the configured source');
		assert(h.data.store!.vault.has(providerKeyName('local')));
	}
	assertEquals(await Deno.readTextFile(s.operator), operatorBytes, 'the providers file is untouched');
	assertFalse((await bytesOnDisk(s.data)).includes(KEY), 'the key rests sealed, WAL included');

	// The file changes; a restart keeps the database's providers and says why.
	await Deno.writeTextFile(
		s.operator,
		JSON.stringify({ version: 1, providers: [{ id: 'other', kind: 'openai', base_url: GRANTED, models: ['o1'] }] }),
	);
	await using again = await harness(s.operator, s.data);
	assertEquals((await again.get()).providers.map((p: Json) => p.id), ['local']);
	assertStringIncludes(again.lines.join('\n'), 'the providers file differs from the database');
});

Deno.test('D-154: a PUT replaces every provider, seals a typed key, applies live, and survives a restart', async () => {
	await using s = await scratch();
	const operatorBytes = await Deno.readTextFile(s.operator);
	await using h = await harness(s.operator, s.data);
	const card = async (): Promise<{ skills: string[]; modes: string[] }> => {
		const body = await (await h.request('GET', '/.well-known/agent-card.json', null)).json();
		return { skills: body.skills.map((skill: { id: string }) => skill.id), modes: body.defaultInputModes };
	};
	assertFalse((await card()).skills.includes('builtin-model'), 'the seeded provider is unreachable');

	const response = await h.put({
		default: 'second',
		providers: [
			seeded({ models: ['m1', 'm2'] }),
			added({ kind: 'anthropic', models: ['c1', 'c2'], key: { mode: 'set', value: TYPED } }),
		],
	});
	assertEquals(response.status, 200);
	const text = await response.text();
	assertFalse(text.includes(TYPED) || text.includes(KEY), 'no key in the answer');
	const document = JSON.parse(text);
	assertEquals(document.default, 'second');
	assertEquals(
		document.providers.map((p: Json) => [p.id, p.origin, p.models, p.key]),
		[
			['local', 'seed', ['m1', 'm2'], { source: 'stored' }],
			['second', 'admin', ['c1', 'c2'], { source: 'stored' }],
		],
	);
	assertEquals([document.providers[1].host, document.providers[1].reachable], [GRANTED_HOST, true]);

	// Nothing but the database on the data volume; the file untouched; no key in any byte.
	assertEquals(await Deno.readTextFile(s.operator), operatorBytes);
	const files: string[] = [];
	for await (const entry of Deno.readDir(s.data)) files.push(entry.name);
	assert(files.every((name) => name.startsWith('ttk.db') || name === 'agents'), files.join(', '));
	const disk = await bytesOnDisk(s.data);
	assertFalse(disk.includes(TYPED) || disk.includes(KEY), 'both keys rest sealed');

	// Live: the read-back, the providers route, the diagnostics, the agent card.
	assertEquals(await h.get(), document);
	const route = await (await h.request('GET', '/api/v1/agent/providers', h.keys.agent)).json();
	assertEquals([route.default, route.providers.map((p: { id: string }) => p.id)], ['second', ['local', 'second']]);
	const diagnostics = (await (await h.request('GET', '/api/v1/system/diagnostics', h.keys.admin)).json()).config;
	assertEquals(diagnostics.modelProviders, [
		{ id: 'local', kind: 'openai', models: 2, reachable: false },
		{ id: 'second', kind: 'anthropic', models: 2, reachable: true },
	]);
	assertEquals(diagnostics.builtinAgent, true);
	const after = await card();
	assert(after.skills.includes('builtin-model') && after.modes.includes('text/plain'));

	// One audit line, carrying ids, never a key.
	const log = h.lines.join('\n');
	assertStringIncludes(log, 'model_providers.updated');
	assertFalse(log.includes(TYPED) || log.includes(KEY));

	// A restart (same database, same vault key) reads the same set back, keys opened.
	await using restarted = await harness(s.operator, s.data);
	const reloaded = restarted.store.effective()!;
	assertEquals(reloaded.providers.map((p) => [p.id, p.models, p.apiKey]), [
		['local', ['m1', 'm2'], KEY],
		['second', ['c1', 'c2'], TYPED],
	]);
	assertEquals(reloaded.default, 'second');
});

Deno.test('D-154: a typed key reaches its provider, and the agent redacts it from the task', async () => {
	await using s = await scratch();
	const fake = startFakeProvider();
	try {
		const host = new URL(fake.url).host;
		await using h = await harness(s.operator, s.data, { net: [host] });
		fake.script = [{ echo: true }];
		const put = await h.put({
			providers: [seeded(), added({ id: 'fake', base_url: fake.url, key: { mode: 'set', value: TYPED } })],
		});
		assertEquals(put.status, 200);
		const submitted = await h.request('POST', '/api/v1/agent/tasks', h.keys.agent, { message: 'hi', provider: 'fake' });
		assertEquals(submitted.status, 202);
		const id = (await submitted.json()).task.id as string;
		let task: Json = {};
		for (let i = 0; i < 200; i++) {
			task = (await (await h.request('GET', `/api/v1/agent/tasks/${id}`, h.keys.agent)).json()).task;
			if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'].includes(task.status.state)) break;
			await new Promise((done) => setTimeout(done, 10));
		}
		assertEquals(task.status.state, 'TASK_STATE_COMPLETED');
		assertEquals(fake.requests[0]?.headers.authorization, `Bearer ${TYPED}`);
		const shown = JSON.stringify(task);
		assertFalse(shown.includes(TYPED), 'the echoed key is redacted from the task');
		assertStringIncludes(shown, '[REDACTED]');
	} finally {
		await fake.close();
	}
});

Deno.test('D-154: a typed key is judged by the parser’s key rules before anything is sealed, and never echoed', async () => {
	await using s = await scratch();
	await using h = await harness(null, s.data);
	const cases: Array<[Record<string, unknown>, string, string?]> = [
		[
			added({ key: { mode: 'set', value: 'sk-has a-space-0123456789abcdef' } }),
			'the key contains whitespace, entry 1, field key.value',
			'sk-has a-space',
		],
		[
			added({ key: { mode: 'set', value: 'REPLACE_WITH_KEY' } }),
			'the key is the composer placeholder, entry 1, field key.value',
		],
		[
			added({ key: { mode: 'set', value: 'k'.repeat(513) } }),
			'the key is longer than 512 characters, entry 1, field key.value',
			'k'.repeat(64),
		],
		[added({ kind: 'anthropic' }), 'an anthropic provider needs a key, entry 1, field key'],
		[
			added({ base_url: 'http://10.0.0.5/v1', allow_http: true, key: { mode: 'set', value: TYPED } }),
			'a key never travels in plaintext off the host, entry 1, field allow_http',
		],
		[
			added({ base_url: 'http://203.0.113.7/v1' }),
			'plaintext HTTP to a public address, entry 1, field base_url',
			'203.0.113.7',
		],
		[
			added({ headers: { 'x-auth-token': 'header-secret-value' } }),
			'a credential header is refused; use api_key, entry 1, field headers.x-auth-token',
			'header-secret-value',
		],
		[added({ default_model: 'zz' }), 'not one of the listed models, entry 1, field default_model'],
		[added({ id: 'Bad Id' }), 'malformed, entry 1, field id', 'Bad Id'],
	];
	for (const [provider, detail, secret] of cases) {
		const put = await problem(await h.put({ providers: [provider] }));
		assertEquals([put.status, put.slug, put.detail], [400, 'invalid-request', detail]);
		assertFalse(put.text.includes(TYPED), 'a typed key is never echoed');
		if (secret !== undefined) assertFalse(put.text.includes(secret), `${secret} is not echoed`);
	}
	assertEquals(h.data.store!.vault.names('model-provider/'), [], 'nothing was sealed');
	assertFalse(h.lines.join('\n').includes(TYPED));
});

Deno.test('D-154: the body is strict — no inline key, no key file — and both routes need admin', async () => {
	await using s = await scratch();
	await using h = await harness(null, s.data);
	const bodies: Array<[unknown, string]> = [
		[{ providers: [added({ api_key: TYPED })] }, 'unknown field api_key, entry 1, field (entry)'],
		[{ providers: [added({ api_key_file: '/run/secrets/k' })] }, 'unknown field api_key_file, entry 1, field (entry)'],
		[{ providers: [added({ key: { mode: 'file', file: '/run/secrets/k' } })] }, 'invalid, entry 1, field key.mode'],
		[{ providers: [added({ key: { mode: 'set', value: TYPED, x: 1 } })] }, 'unknown field x, entry 1, field key'],
		[{ providers: [], extra_models: {} }, 'unknown field extra_models, field (file)'],
	];
	for (const [body, detail] of bodies) {
		const put = await problem(await h.put(body));
		assertEquals([put.status, put.slug, put.detail], [400, 'invalid-request', detail]);
		assertFalse(put.text.includes(TYPED));
	}
	for (const method of ['GET', 'PUT']) {
		const body = method === 'PUT' ? { providers: [] } : undefined;
		assertEquals((await problem(await h.request(method, ROUTE, h.keys.agent, body))).status, 403);
		assertEquals((await h.request(method, ROUTE, null, body)).status, 401);
	}
	const big = await problem(await h.put({ providers: [added({ label: 'x'.repeat(130 * 1024) })] }));
	assertEquals([big.status, big.slug], [413, 'payload-too-large']);
	assertEquals((await problem(await h.put('[]'))).status, 400);
	const many = await problem(await h.put({ providers: Array.from({ length: 17 }, (_, i) => added({ id: `p${i}` })) }));
	assertEquals(many.detail, 'more than 16 providers, field providers');
});

Deno.test('D-154: keep binds a sealed key to its host; the same host keeps it untouched; an unknown id cannot keep', async () => {
	await using s = await scratch();
	await using h = await harness(null, s.data);
	assertEquals((await h.put({ providers: [added({ key: { mode: 'set', value: TYPED } })] })).status, 200);
	const sealedRow = () => h.data.store!.db.get('SELECT nonce FROM secrets WHERE name = ?', providerKeyName('second'));
	const before = sealedRow();
	for (const base_url of ['http://127.0.0.1:10/v1', 'http://localhost:11434/v1', 'https://127.0.0.1/v1']) {
		const put = await problem(await h.put({ providers: [added({ base_url, key: { mode: 'keep' } })] }));
		assertEquals(
			[put.status, put.detail],
			[400, 'a kept key cannot follow its provider to another host, entry 1, field key'],
		);
	}
	const fresh = await problem(await h.put({ providers: [added({ id: 'fresh', key: { mode: 'keep' } })] }));
	assertEquals(fresh.detail, 'key mode keep names no stored provider, entry 1, field key');
	const kept = await h.put({ providers: [added({ base_url: `http://${GRANTED_HOST}/v2`, key: { mode: 'keep' } })] });
	assertEquals(kept.status, 200);
	assertEquals((await kept.json()).providers[0].key, { source: 'stored' });
	assertEquals(sealedRow(), before, 'kept, not re-sealed');
	assertEquals(h.store.effective()?.providers[0]?.apiKey, TYPED);
	// A provider without a key may move.
	assertEquals((await h.put({ providers: [added({ id: 'bare' })] })).status, 200);
	assertEquals(
		(await h.put({ providers: [added({ id: 'bare', base_url: 'http://127.0.0.1:12/v1', key: { mode: 'keep' } })] }))
			.status,
		200,
	);
});

Deno.test('D-154: a seeded provider can be edited and removed; a removed or keyless provider leaves no sealed key', async () => {
	await using s = await scratch();
	await using h = await harness(s.operator, s.data);
	const vault = h.data.store!.vault;
	assertEquals(vault.names('model-provider/'), [providerKeyName('local')]);
	const edited = await (await h.put({ providers: [seeded({ label: 'Renamed', key: { mode: 'none' } })] })).json();
	assertEquals([edited.providers[0].label, edited.providers[0].key, edited.providers[0].origin], [
		'Renamed',
		{ source: 'none' },
		'seed',
	]);
	assertEquals(vault.names('model-provider/'), [], 'mode none deletes the sealed key');
	assertEquals((await h.put({ providers: [added({ key: { mode: 'set', value: TYPED } })] })).status, 200);
	assertEquals(vault.names('model-provider/'), [providerKeyName('second')]);
	const emptied = await (await h.put({ providers: [] })).json();
	assertEquals([emptied.providers, emptied.default], [[], null]);
	assertEquals(vault.names('model-provider/'), []);
	// Emptied stays emptied across a restart: the database was seeded, so the file is not copied in again.
	await using again = await harness(s.operator, s.data);
	assertEquals((await again.get()).providers, []);
});

Deno.test('D-154: the default is the one named, else a sole provider, else none; a ghost default is refused', async () => {
	await using s = await scratch();
	await using h = await harness(null, s.data);
	const defaultOf = async (body: unknown): Promise<unknown> => {
		const response = await h.put(body);
		assertEquals(response.status, 200);
		return (await response.json()).default;
	};
	assertEquals(await defaultOf({ providers: [added()] }), 'second');
	assertEquals(await defaultOf({ default: 'third', providers: [added(), added({ id: 'third' })] }), 'third');
	assertEquals(await defaultOf({ providers: [added(), added({ id: 'third' })] }), null);
	const ghost = await problem(await h.put({ default: 'ghost', providers: [added()] }));
	assertEquals([ghost.status, ghost.detail], [400, 'default names no listed provider, field default']);
});

Deno.test('D-154: without TTK_DB_KEY_FILE a key is never stored — a keyed file refuses startup, a typed key 409s', async () => {
	await using s = await scratch();
	await assertRejects(() => harness(s.operator, s.data, { vault: false }), SeedError, 'provider local has a key');
	await using bare = await scratch();
	await using h = await harness(null, bare.data, { vault: false });
	assertEquals((await h.get()).store.vault, 'locked');
	assertEquals((await h.put({ providers: [added()] })).status, 200, 'a keyless provider needs no vault key');
	const refused = await problem(await h.put({ providers: [added({ key: { mode: 'set', value: TYPED } })] }));
	assertEquals([refused.status, refused.slug], [409, 'conflict']);
	assertStringIncludes(refused.detail ?? '', 'TTK_DB_KEY_FILE is not set');
	assertFalse((await bytesOnDisk(bare.data)).includes(TYPED));
});

Deno.test('D-154: a gateway started with no providers file but a data directory gains providers live', async () => {
	await using s = await scratch();
	await using h = await harness(null, s.data);
	const card = async () => await (await h.request('GET', '/.well-known/agent-card.json', null)).json();
	assertFalse((await card()).defaultInputModes.includes('text/plain'));
	// Empty, the runtime answers exactly as one composed without providers (§3.10).
	const refused = await h.request('POST', '/api/v1/agent/tasks', h.keys.agent, { message: 'hi', provider: 'second' });
	assertEquals([refused.status, (await refused.json()).detail], [400, NO_TEXT_BACKEND]);
	assertEquals((await (await h.request('GET', '/api/v1/agent/providers', h.keys.agent)).json()).providers, []);

	assertEquals((await h.put({ providers: [added()] })).status, 200);
	const route = await (await h.request('GET', '/api/v1/agent/providers', h.keys.agent)).json();
	assertEquals([route.default, route.providers.map((p: { id: string }) => p.id)], ['second', ['second']]);
	const after = await card();
	assert(after.defaultInputModes.includes('text/plain'));
	assert(after.skills.some((skill: { id: string }) => skill.id === 'builtin-model'));
	assertEquals((await h.get()).seed, { file: null, seeded_at: null });
});

// --- the expansion, unit level ------------------------------------------------------------------------------------

/** One provider's resolved settings, in memory (as `loadModelProviders` resolves them). */
function settings(id: string, baseUrl: string, models: readonly string[] = ['m1']): ModelProviderSettings {
	return {
		id,
		kind: 'openai',
		label: id,
		baseUrl,
		host: new URL(baseUrl).host,
		models,
		defaultModel: models[0]!,
		apiKey: null,
		keySource: 'none',
		headers: {},
		allowHttp: false,
		maxTokensParam: 'max_tokens',
		maxSteps: 8,
		maxOutputTokens: 512,
		tokenBudget: 10_000,
	};
}

const SCOPES = new Set(['agent:invoke', 'model:invoke', 'mcp:invoke']);
const prompt = (text: string) => ({ messageId: crypto.randomUUID(), role: 'ROLE_USER' as const, parts: [{ text }] });

Deno.test('D-152/D-153: applyModelProviders swaps the runtime map and default in place; a queued task is judged again', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const initial: ModelProvidersConfig = { default: 'local', providers: [settings('local', UNGRANTED)] };
	const services = createExpansionServices(
		loadConfig({}).expansion,
		{ registry, version: 't' },
		undefined,
		undefined,
		undefined,
		{
			modelProviders: initial,
			permissions: permissions(),
		},
	);
	try {
		assertEquals(services.runtime.reachableProviders, 0);
		let unknown: unknown;
		try {
			services.runtime.submit('owner', SCOPES, prompt('hi'), undefined, { model: { provider: 'second' } });
		} catch (cause) {
			unknown = cause;
		}
		assert(unknown instanceof AgentError && unknown.code === -32602, 'the provider is unknown before the swap');

		services.applyModelProviders!({
			default: 'second',
			providers: [settings('local', UNGRANTED), settings('second', GRANTED, ['s1', 's2'])],
		});
		assertEquals(services.runtime.reachableProviders, 1, 'the runtime reads the refilled map');
		assertEquals(services.modelProviders.default, 'second');
		const routed = services.runtime.submit('owner', SCOPES, prompt('hi'));
		assertEquals([routed.metadata?.provider, routed.metadata?.model], ['second', 's1']);
		services.runtime.cancel('owner', routed.id);

		// A task submitted for `second` and still queued when `second` is removed never dials it.
		const queued = services.runtime.submit('owner', SCOPES, prompt('hi'), undefined, { model: { provider: 'second' } });
		services.applyModelProviders!({ default: 'local', providers: [settings('local', UNGRANTED)] });
		let task = services.runtime.get('owner', queued.id);
		for (let i = 0; i < 100 && task.status.state !== 'TASK_STATE_FAILED'; i++) {
			await new Promise((done) => setTimeout(done, 10));
			task = services.runtime.get('owner', queued.id);
		}
		assertEquals(task.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(JSON.stringify(task.status), 'Model provider is no longer configured');
	} finally {
		await services.close();
		await registry.shutdown();
	}
});

Deno.test('D-153: a data directory composes the runtime able to gain providers; empty, it routes as none', async () => {
	await using s = await scratch();
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const without = createExpansionServices(loadConfig({}).expansion, { registry, version: 't' });
	const managed = createExpansionServices(
		loadConfig({}).expansion,
		{ registry, version: 't' },
		undefined,
		undefined,
		undefined,
		{
			dataDir: s.data,
			permissions: permissions(),
		},
	);
	try {
		assertEquals(without.applyModelProviders, undefined, 'stdio without a file: nothing to manage');
		assert(managed.applyModelProviders !== undefined);
		assertEquals(managed.modelProviders, { default: null, providers: [] });
		for (const services of [without, managed]) {
			let refused: unknown;
			try {
				services.runtime.submit('owner', SCOPES, prompt('hi'), undefined, { model: { provider: 'x' } });
			} catch (cause) {
				refused = cause;
			}
			assert(refused instanceof AgentError && refused.code === -32004 && refused.message === NO_TEXT_BACKEND);
			assertFalse(services.runtime.supportsText);
		}
		managed.applyModelProviders!({ default: null, providers: [settings('x', GRANTED)] });
		assert(managed.runtime.supportsText);
	} finally {
		await without.close();
		await managed.close();
		await registry.shutdown();
	}
});

// --- D-158: the model list --------------------------------------------------------------------------------------------

const MODELS = '/api/v1/system/model-providers/models';

Deno.test('D-158: a saved provider’s models are listed with its sealed key; the answer is sorted and de-duplicated', async () => {
	await using s = await scratch();
	const fake = startFakeProvider();
	try {
		const host = new URL(fake.url).host;
		await using h = await harness(s.operator, s.data, { net: [host] });
		const saved = added({ id: 'fake', base_url: fake.url, key: { mode: 'set', value: TYPED } });
		assertEquals((await h.put({ providers: [seeded(), saved] })).status, 200);
		fake.models = ['zeta', 'alpha', 'alpha', ' beta '];
		const probe = { id: 'fake', kind: 'openai', base_url: fake.url, key: { mode: 'keep' } };
		const listed = await h.request('POST', MODELS, h.keys.admin, probe);
		assertEquals(listed.status, 200);
		assertEquals(await listed.json(), { models: ['alpha', 'beta', 'zeta'] });
		const sent = fake.requests.at(-1)!;
		assertEquals([sent.path, sent.headers.authorization], ['/v1/models', `Bearer ${TYPED}`]);
		assertEquals(sent.headers['content-type'], undefined, 'a GET describes no body');
		// A typed key is used for the one call and never stored: the vault holds the saved key only.
		const other = 'sk-other-abcdefghijklmnopqrstuvwxyz0123';
		const typed = await h.request('POST', MODELS, h.keys.admin, { ...probe, key: { mode: 'set', value: other } });
		assertEquals(typed.status, 200);
		assertEquals(fake.requests.at(-1)!.headers.authorization, `Bearer ${other}`);
		assertFalse((await bytesOnDisk(s.data)).includes(other));
		assertFalse(h.lines.join('\n').includes(other));
	} finally {
		await fake.close();
	}
});

Deno.test('D-158: the model list dials only a saved provider’s host, needs admin, and says why it cannot list', async () => {
	await using s = await scratch();
	const fake = startFakeProvider();
	try {
		const host = new URL(fake.url).host;
		await using h = await harness(s.operator, s.data, { net: [host] });
		const draft = { id: 'draft', kind: 'openai', base_url: fake.url, key: { mode: 'none' } };
		// Not saved yet: the set in force stays the only allowlist for model hosts, so nothing is dialled.
		const unsaved = await problem(await h.request('POST', MODELS, h.keys.admin, draft));
		assertEquals([unsaved.status, unsaved.slug], [409, 'conflict']);
		assertStringIncludes(unsaved.detail ?? '', 'save the provider');
		assertEquals(fake.requests.length, 0);
		assertEquals((await h.request('POST', MODELS, h.keys.agent, draft)).status, 403);
		assertEquals((await h.put({ providers: [seeded(), added({ id: 'fake', base_url: fake.url })] })).status, 200);
		fake.models = null;
		const missing = await problem(await h.request('POST', MODELS, h.keys.admin, { ...draft, id: 'fake' }));
		assertEquals([missing.status, missing.detail], [
			503,
			'the provider does not list its models (404): type them by hand',
		]);
		// The draft is judged like a saved row: a strict body, and `keep` never follows a key to another host.
		const strict = await problem(await h.request('POST', MODELS, h.keys.admin, { ...draft, models: [] }));
		assertEquals(strict.status, 400);
	} finally {
		await fake.close();
	}
});

// --- D-158: the agents' settings ----------------------------------------------------------------------------------

const AGENTS = '/api/v1/system/agents';

Deno.test('D-158: the agents are listed with their defaults; a change is judged against the providers, stored and applied', async () => {
	await using s = await scratch();
	await using h = await harness(s.operator, s.data);
	assertEquals((await h.put({ providers: [seeded(), added()] })).status, 200);
	const first: Json = await (await h.request('GET', AGENTS, h.keys.admin)).json();
	assertEquals(first.store, { writable: true });
	assertEquals(first.agents.map((agent: Json) => agent.id), ['builtin', 'sloplord', 'acp']);
	assertEquals(first.agents[0].settings, { model: null, a2a: true, acp: false, a2ui: true, memory: true });
	assertEquals(first.agents[2].applies.model, false);
	assertEquals(first.models.map((entry: Json) => `${entry.provider}/${entry.model}`), ['local/m1', 'second/s1']);

	const saved = await h.request('PUT', AGENTS, h.keys.admin, {
		agents: { builtin: { model: { provider: 'second', model: 's1' }, memory: false } },
	});
	assertEquals(saved.status, 200);
	const after: Json = await saved.json();
	assertEquals(after.agents[0].settings.model, { provider: 'second', model: 's1' });
	assertEquals(after.agents[0].settings.memory, false);
	// The chat's providers route offers the chosen model first.
	const providers: Json = await (await h.request('GET', '/api/v1/agent/providers', h.keys.agent)).json();
	assertEquals(providers.agent_default, { provider: 'second', model: 's1' });
	// Stored in the database: a store opened on it again reads the same.
	assertEquals(new AgentSettingsStore(h.data.store!.db).current().builtin.memory, false);
	assertStringIncludes(h.data.store!.db.setting(AGENT_SETTINGS_KEY) ?? '', '"second"');

	for (
		const [body, detail] of [
			[{ agents: { builtin: { model: { provider: 'second', model: 'nope' } } } }, 'field builtin.model'],
			[{ agents: { acp: { model: { provider: 'second', model: 's1' } } } }, 'field acp.model'],
			[{ agents: { ghost: {} } }, 'field ghost'],
			[{ agents: {}, extra: 1 }, 'field agents'],
		] as const
	) {
		const refused = await problem(await h.request('PUT', AGENTS, h.keys.admin, body));
		assertEquals(refused.status, 400, JSON.stringify(body));
		assert(refused.detail?.endsWith(detail), refused.detail);
	}
	assertEquals((await h.request('GET', AGENTS, h.keys.agent)).status, 403);
	assertEquals((await h.request('PUT', AGENTS, h.keys.agent, { agents: {} })).status, 403);
});

Deno.test('D-158: without a data directory the agents read their defaults and a change is refused', async () => {
	await using s = await scratch();
	await using h = await harness(s.operator, null);
	const document: Json = await (await h.request('GET', AGENTS, h.keys.admin)).json();
	assertEquals(document.store.writable, false);
	const refused = await problem(await h.request('PUT', AGENTS, h.keys.admin, { agents: { builtin: { a2a: false } } }));
	assertEquals([refused.status, refused.slug], [409, 'persistence-required']);
});
