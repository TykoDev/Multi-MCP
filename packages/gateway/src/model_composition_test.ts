/**
 * D-143 (model-providers-ui W3/B3): the gateway composition of the built-in model agent — the grant proof
 * (`modelGrantProven`), one client per configured provider, the runtime's `model` option, the provider views the
 * route and the diagnostics show, and the `capabilities.tykotech.model` block. The provider is a loopback fake
 * (`tests/support/fake_provider.ts`); the net grant is an injected permissions API, so both answers of the proof are
 * exercised in one process. Every body a caller can read is checked for the provider key, which never leaves the
 * client (§3.3, §3.7, gate F9; condition 4 of `gatekeeper_judgment_r3.md`).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import { startFakeProvider } from '../../../tests/support/fake_provider.ts';
import { createGatewayApp, type GatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { modelGrantProven } from './expansion.ts';
import { createLogger } from './logger.ts';
import type { ModelProvidersConfig, ModelProviderSettings } from './model_providers.ts';

const ORIGIN = 'http://127.0.0.1:8787';
/** Sixteen-plus characters, so the client's redactor applies to it as well (§3.12, gate F12). */
const KEY = 'sk-test-0123456789abcdefghijklmnop';

/** A permissions API answering `granted` for the listed hosts (`net` alone means an unscoped grant), `prompt` otherwise. */
function permissions(granted: readonly string[]): Pick<Deno.Permissions, 'querySync'> {
	return {
		querySync: (descriptor: Deno.PermissionDescriptor): Deno.PermissionStatus => {
			const net = descriptor as Deno.NetPermissionDescriptor;
			const key = net.host === undefined ? 'net' : net.host;
			return { state: granted.includes(key) ? 'granted' : 'prompt' } as Deno.PermissionStatus;
		},
	};
}

/** One provider's resolved settings, as `loadModelProviders` would hand them to `loadConfig` (B1's shape). */
function settings(overrides: Partial<ModelProviderSettings> & { baseUrl: string }): ModelProviderSettings {
	const url = new URL(overrides.baseUrl);
	return {
		id: 'fake',
		kind: 'openai',
		label: 'Fake',
		host: url.host,
		models: ['test-model'],
		defaultModel: 'test-model',
		apiKey: KEY,
		keySource: 'inline',
		headers: {},
		allowHttp: false,
		maxTokensParam: 'max_tokens',
		maxSteps: 8,
		maxOutputTokens: 512,
		tokenBudget: 10_000,
		...overrides,
	};
}

interface Harness {
	app: GatewayApp;
	keys: Record<'alice' | 'carol' | 'admin', string>;
	warnings: string[];
	request(path: string, key: string | null, body?: unknown): Promise<Response>;
	capabilities(key: string): Promise<Record<string, unknown>>;
	[Symbol.asyncDispose](): Promise<void>;
}

/** alice may submit tasks, carol may also name a provider, admin reads the diagnostics. */
async function harness(
	modelProviders: ModelProvidersConfig,
	grant: Pick<Deno.Permissions, 'querySync'>,
): Promise<Harness> {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const carol = await generateApiKey('carol', ['mcp:invoke', 'agent:invoke', 'model:invoke']);
	const admin = await generateApiKey('admin', ['mcp:invoke', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([alice.record, carol.record, admin.record]),
	}, { modelProviders });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const warnings: string[] = [];
	const app = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'model-composition-test',
		logger: createLogger({
			level: 'warn',
			write: (line: string): void => {
				warnings.push(line);
			},
		}),
		permissions: grant,
	});
	const request = async (path: string, key: string | null, body?: unknown): Promise<Response> =>
		await app.app.request(`${ORIGIN}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				host: '127.0.0.1:8787',
				...(key === null ? {} : { authorization: `Bearer ${key}` }),
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return {
		app,
		keys: { alice: alice.key, carol: carol.key, admin: admin.key },
		warnings,
		request,
		capabilities: async (key: string): Promise<Record<string, unknown>> => {
			const response = await app.app.request(`${ORIGIN}/mcp`, {
				method: 'POST',
				headers: {
					host: '127.0.0.1:8787',
					authorization: `Bearer ${key}`,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'mcp-protocol-version': '2025-06-18',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
				}),
			});
			const text = await response.text();
			const line = text.split('\n').find((entry) => entry.startsWith('data: '));
			const rpc = JSON.parse(line === undefined ? text : line.slice('data: '.length));
			return rpc.result.capabilities.tykotech as Record<string, unknown>;
		},
		async [Symbol.asyncDispose]() {
			await app.close();
			await registry.shutdown();
		},
	};
}

/** Reads an SSE body until `until` matches the text so far or the stream ends; never longer than `timeoutMs`. */
async function readEvents(body: ReadableStream<Uint8Array>, until: string, timeoutMs = 5_000): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	const deadline = Date.now() + timeoutMs;
	try {
		while (!text.includes(until) && Date.now() < deadline) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expiry = new Promise<{ done: true; value: undefined }>((resolve) => {
				timer = setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now()));
			});
			const next = await Promise.race([reader.read(), expiry]).finally(() => clearTimeout(timer));
			if (next.done) break;
			text += decoder.decode(next.value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return text;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test('W3: modelGrantProven — unscoped net reaches all; else each host at its port, 443/80 by scheme; a throw is false', () => {
	const https = settings({ id: 'a', baseUrl: 'https://api.example' });
	const http = settings({ id: 'b', baseUrl: 'http://10.0.0.5', allowHttp: true, apiKey: null, keySource: 'none' });
	const ported = settings({ id: 'c', baseUrl: 'https://api.example:8443' });
	const v6 = settings({ id: 'd', baseUrl: 'http://[::1]:11434', allowHttp: true, apiKey: null, keySource: 'none' });
	assertEquals(
		[...modelGrantProven([https, http, ported, v6], permissions(['net']))],
		[['a', true], ['b', true], ['c', true], ['d', true]],
	);
	// The WHATWG host drops a default port; the proof puts it back by scheme, as `--allow-net` spells it.
	assertEquals(
		[...modelGrantProven([https, http, ported, v6], permissions(['api.example:443', '10.0.0.5:80', '[::1]:11434']))],
		[['a', true], ['b', true], ['c', false], ['d', true]],
	);
	assertEquals([...modelGrantProven([https], permissions([]))], [['a', false]]);
	assertEquals(
		[...modelGrantProven([https], {
			querySync: (): Deno.PermissionStatus => {
				throw new Error('no permissions API');
			},
		})],
		[['a', false]],
	);
	assertEquals(modelGrantProven([], permissions([])).size, 0);
});

Deno.test('W3 (a): the providers route lists a configured provider; host and reason only when invocable (gate F9)', async () => {
	const fake = startFakeProvider();
	try {
		await using h = await harness({ default: 'fake', providers: [settings({ baseUrl: fake.url })] }, permissions([]));
		const holder = await (await h.request('/api/v1/agent/providers', h.keys.carol)).json();
		assertEquals(holder, {
			invocable: true,
			acp: false,
			default: 'fake',
			providers: [{
				id: 'fake',
				kind: 'openai',
				label: 'Fake',
				host: new URL(fake.url).host,
				models: ['test-model'],
				default_model: 'test-model',
				reachable: false,
				reason: 'no-net-grant',
			}],
			// D-156: SlopLord is listed, unavailable — no reachable provider and no sandbox here.
			agents: [{
				id: 'sloplord',
				name: 'SlopLord',
				description: holder.agents[0].description,
				available: false,
				card_url: holder.agents[0].card_url,
			}],
		});
		assert(String(holder.agents[0].card_url).endsWith('/a2a/agents/sloplord/.well-known/agent-card.json'));
		const plain = await (await h.request('/api/v1/agent/providers', h.keys.alice)).json();
		assertEquals(plain, {
			invocable: false,
			acp: false,
			default: 'fake',
			providers: [{
				id: 'fake',
				kind: 'openai',
				label: 'Fake',
				models: ['test-model'],
				default_model: 'test-model',
				reachable: false,
			}],
			agents: holder.agents,
		});
		for (const body of [holder, plain]) assert(!JSON.stringify(body).includes(KEY));
	} finally {
		await fake.close();
	}
});

Deno.test('W3 (b): without a net grant the provider is listed unreachable, warned once, refused with -32004 and never dialled', async () => {
	const fake = startFakeProvider();
	try {
		await using h = await harness({ default: 'fake', providers: [settings({ baseUrl: fake.url })] }, permissions([]));
		const host = new URL(fake.url).host;
		// One startup warning naming the host and the `--allow-net` entry to add; never the key.
		const warned = h.warnings.filter((line) => line.includes('model provider fake'));
		assertEquals(warned.length, 1, h.warnings.join('\n'));
		assertStringIncludes(warned[0]!, host);
		assertStringIncludes(warned[0]!, '--allow-net');
		assert(!h.warnings.some((line) => line.includes(KEY)));
		const diagnostics = (await (await h.request('/api/v1/system/diagnostics', h.keys.admin)).json()).config;
		assertEquals(diagnostics.modelProviders, [{ id: 'fake', kind: 'openai', models: 1, reachable: false }]);
		assertEquals(diagnostics.builtinAgent, false);
		// The capabilities block says the same to a `model:invoke` holder.
		assertEquals((await h.capabilities(h.keys.carol)).model, { providers: 1, builtin_agent: false });
		// A selected and a defaulted task both fall to §3.10's "not reachable" and no request reaches the provider.
		for (const body of [{ message: 'hi', provider: 'fake' }, { message: 'hi' }]) {
			const refused = await h.request('/api/v1/agent/tasks', h.keys.carol, body);
			assertEquals(refused.status, 400);
			const problem = await refused.json();
			assertStringIncludes(String(problem.type), 'invalid-request');
			assertEquals(problem.detail, 'Model provider is not reachable: no outbound net grant');
		}
		await sleep(50);
		assertEquals(fake.requests.length, 0, 'an unreachable provider is never dialled');
		assertEquals((await (await h.request('/api/v1/agent/tasks', h.keys.carol)).json()).tasks, []);
	} finally {
		await fake.close();
	}
});

Deno.test('W3 (c): with the grant a submitted task runs the loop on the fake, calls one tool, completes; the key is nowhere', async () => {
	const fake = startFakeProvider();
	try {
		const host = new URL(fake.url).host;
		await using h = await harness(
			{ default: 'fake', providers: [settings({ baseUrl: fake.url })] },
			permissions([host]),
		);
		assertEquals(h.warnings.filter((line) => line.includes('model provider')), []);
		fake.script = [{ calls: [{ name: 'browser_list_sessions', arguments: {} }] }, { text: 'All done.' }];
		const submitted = await h.request('/api/v1/agent/tasks', h.keys.carol, { message: 'list the sessions' });
		assertEquals(submitted.status, 202);
		const { task } = await submitted.json();
		const id = task.id as string;
		assertEquals(task.metadata.kind, 'text');
		assertEquals(task.metadata.provider, 'fake');
		assertEquals(task.metadata.model, 'test-model');
		// Subscribed before the first provider turn can answer: the stream carries the tool call as `{ model: … }`.
		const stream = await h.request(`/api/v1/agent/tasks/${id}/events`, h.keys.carol);
		assertEquals(stream.status, 200);
		const events = await readEvents(stream.body!, '"kind":"tool_call"');
		assert(events.includes('"kind":"tool_call"'), events);
		const frame = events.split('\n\n').map((line) => line.trim()).filter((line) => line.startsWith('data: '))
			.map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
			.find((entry) => JSON.stringify(entry).includes('"kind":"tool_call"'))!;
		const parts = (frame.statusUpdate as Record<string, unknown>).status as Record<string, unknown>;
		const data = ((parts.message as Record<string, unknown>).parts as Record<string, unknown>[])[0]!.data as Record<
			string,
			unknown
		>;
		assertEquals((data.model as Record<string, unknown>).kind, 'tool_call');
		assertEquals((data.model as Record<string, unknown>).name, 'browser_list_sessions');
		let view: Record<string, unknown> = {};
		for (let i = 0; i < 100; i++) {
			view = (await (await h.request(`/api/v1/agent/tasks/${id}`, h.keys.carol)).json()).task;
			if ((view.status as Record<string, unknown>).state === 'TASK_STATE_COMPLETED') break;
			await sleep(50);
		}
		assertEquals((view.status as Record<string, unknown>).state, 'TASK_STATE_COMPLETED', JSON.stringify(view));
		const metadata = view.metadata as Record<string, unknown>;
		assert(typeof metadata.steps === 'number' && metadata.steps >= 1, JSON.stringify(metadata));
		assertEquals(fake.requests.length, 2, 'one turn for the call, one for the answer');
		// The client sent the key in its header and the gateway's tool list to the provider — and nowhere else.
		assertEquals(fake.requests[0]!.headers['authorization'], `Bearer ${KEY}`);
		const sent = fake.requests[0]!.body.tools as Record<string, unknown>[];
		assert(sent.some((tool) => (tool.function as Record<string, unknown>).name === 'browser_list_sessions'));
		assert(!sent.some((tool) => JSON.stringify(tool).includes('agent_run_tool')), 'NOT_TASKABLE never offered');
		const readable = [
			events,
			JSON.stringify(view),
			JSON.stringify(await (await h.request('/api/v1/agent/providers', h.keys.carol)).json()),
			JSON.stringify(await (await h.request('/api/v1/system/diagnostics', h.keys.admin)).json()),
			JSON.stringify(await h.capabilities(h.keys.carol)),
			JSON.stringify(await (await h.request('/api/v1/agent/tasks', h.keys.carol)).json()),
		];
		for (const text of readable) assert(!text.includes(KEY), 'the key never leaves the client');
	} finally {
		await fake.close();
	}
});

Deno.test('W3 (d): an unknown provider is 400 invalid-request with the runtime -32602 text as detail (K2)', async () => {
	const fake = startFakeProvider();
	try {
		const host = new URL(fake.url).host;
		await using h = await harness(
			{ default: 'fake', providers: [settings({ baseUrl: fake.url })] },
			permissions([host]),
		);
		const refused = await h.request('/api/v1/agent/tasks', h.keys.carol, { message: 'hi', provider: 'nope' });
		assertEquals(refused.status, 400);
		const problem = await refused.json();
		assertStringIncludes(String(problem.type), 'invalid-request');
		assertEquals(problem.detail, 'Unknown model provider');
		const badModel = await h.request('/api/v1/agent/tasks', h.keys.carol, {
			message: 'hi',
			provider: 'fake',
			model: 'other',
		});
		assertEquals(badModel.status, 400);
		assertEquals((await badModel.json()).detail, 'Unknown model for provider');
		// CR-1 / BUG-6: a model alone never reaches the default provider — refused before submit, with a default present.
		const modelOnly = await h.request('/api/v1/agent/tasks', h.keys.carol, { message: 'hi', model: 'other' });
		assertEquals(modelOnly.status, 400);
		assertEquals((await modelOnly.json()).detail, 'model requires provider');
		assertEquals(fake.requests.length, 0);
	} finally {
		await fake.close();
	}
});

Deno.test('W3 (e): the capabilities model block is told only to a model:invoke holder and counts providers and reachable', async () => {
	const fake = startFakeProvider();
	try {
		const host = new URL(fake.url).host;
		const two: ModelProvidersConfig = {
			default: null,
			providers: [
				settings({ baseUrl: fake.url }),
				settings({ id: 'far', kind: 'anthropic', label: 'Far', baseUrl: 'https://api.anthropic.com' }),
			],
		};
		await using h = await harness(two, permissions([host]));
		assertEquals((await h.capabilities(h.keys.carol)).model, { providers: 2, builtin_agent: true });
		assertEquals((await h.capabilities(h.keys.alice)).model, undefined);
		const diagnostics = (await (await h.request('/api/v1/system/diagnostics', h.keys.admin)).json()).config;
		assertEquals(diagnostics.modelProviders, [
			{ id: 'fake', kind: 'openai', models: 1, reachable: true },
			{ id: 'far', kind: 'anthropic', models: 1, reachable: false },
		]);
		assertEquals(diagnostics.builtinAgent, true);
		// Only the unreachable one is warned about, naming its `--allow-net` entry.
		const warned = h.warnings.filter((line) => line.includes('model provider'));
		assertEquals(warned.length, 1, h.warnings.join('\n'));
		assertStringIncludes(warned[0]!, 'api.anthropic.com:443');
		// Several providers without a default: route `default: null`, and a selection-less task is row 6 (§3.10).
		assertEquals((await (await h.request('/api/v1/agent/providers', h.keys.carol)).json()).default, null);
		const noDefault = await h.request('/api/v1/agent/tasks', h.keys.carol, { message: 'hi' });
		assertEquals(noDefault.status, 400);
		assertEquals(
			(await noDefault.json()).detail,
			'Text execution requires a configured ACP agent or a model provider',
		);
	} finally {
		await fake.close();
	}
});
