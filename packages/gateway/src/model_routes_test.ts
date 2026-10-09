/**
 * D-143 (model-providers-ui S0): the REST seam for the built-in model agent, with no provider configured —
 * `GET /api/v1/agent/providers` in both shapes (§3.3, gate F9), the widened `POST /api/v1/agent/tasks` body (§3.4,
 * addendum C), `GET /api/v1/a2ui/actions` (addendum B), the diagnostics facts (§3.7), and the K2 pin that keeps
 * `restFailure` byte-identical so the frozen `/a2a/v1` mapping cannot drift while the tasks route shares it.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { SLOPLORD } from '@tykotech/agents';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp, type GatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';

interface Harness {
	app: GatewayApp;
	keys: Record<'alice' | 'carol' | 'ordinary' | 'admin', string>;
	request(path: string, key: string | null, body?: unknown): Promise<Response>;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * Four credentials: alice may submit tasks, carol may also name a provider, `ordinary` holds the default grant only,
 * and `admin` reads the diagnostics. No bridge, no providers file: the S0 state of every deployment.
 */
async function harness(env: Record<string, string> = {}): Promise<Harness> {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const carol = await generateApiKey('carol', ['mcp:invoke', 'agent:invoke', 'model:invoke']);
	const ordinary = await generateApiKey('ordinary', ['mcp:invoke']);
	const admin = await generateApiKey('admin', ['mcp:invoke', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([alice.record, carol.record, ordinary.record, admin.record]),
		...env,
	});
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const app = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'model-routes-test',
		logger: createLogger({ level: 'error', write: (): void => {} }),
	});
	return {
		app,
		keys: { alice: alice.key, carol: carol.key, ordinary: ordinary.key, admin: admin.key },
		request: async (path, key, body) =>
			await app.app.request(`${ORIGIN}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					host: '127.0.0.1:8787',
					...(key === null ? {} : { authorization: `Bearer ${key}` }),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		async [Symbol.asyncDispose]() {
			await app.close();
			await registry.shutdown();
		},
	};
}

const NO_TEXT_BACKEND = 'Text execution requires a configured ACP agent or a model provider';
/** D-156: the built-in profiles the route lists — SlopLord, unavailable here (no sandbox, no provider). */
const AGENTS = [{
	id: 'sloplord',
	name: 'SlopLord',
	description: SLOPLORD.description,
	available: false,
	card_url: `${ORIGIN}/a2a/agents/sloplord/.well-known/agent-card.json`,
}];

Deno.test('D-143 §3.3: GET /api/v1/agent/providers answers the empty seam, in the caller-shaped form', async () => {
	await using h = await harness();
	// Without `model:invoke`: the list, `invocable: false`, and `acp` (no bridge is configured here).
	const plain = await h.request('/api/v1/agent/providers', h.keys.alice);
	assertEquals(plain.status, 200);
	assertEquals(await plain.json(), { invocable: false, acp: false, default: null, providers: [], agents: AGENTS });
	// With it: `invocable: true`, same (empty) list.
	const holder = await h.request('/api/v1/agent/providers', h.keys.carol);
	assertEquals(holder.status, 200);
	assertEquals(await holder.json(), { invocable: true, acp: false, default: null, providers: [], agents: AGENTS });
	// The route sits behind `owner()`: `agent:invoke` is the read scope, as for every other agent route.
	const denied = await h.request('/api/v1/agent/providers', h.keys.ordinary);
	assertEquals(denied.status, 403);
	await denied.body?.cancel();
	const anon = await h.request('/api/v1/agent/providers', null);
	assertEquals(anon.status, 401);
	await anon.body?.cancel();
});

Deno.test('D-143 §3.4: POST /api/v1/agent/tasks takes message, provider and model; provider needs model:invoke first', async () => {
	await using h = await harness();
	const problem = async (response: Response, status: number, slug: string): Promise<Record<string, unknown>> => {
		assertEquals(response.status, status);
		const body = await response.json();
		assertStringIncludes(String(body.type), slug);
		return body;
	};
	// A provider named without the scope: refused before submit, as `forbidden-scope`, whatever the provider.
	await problem(
		await h.request('/api/v1/agent/tasks', h.keys.alice, { message: 'hi', provider: 'openai' }),
		403,
		'forbidden-scope',
	);
	// A 65-character provider, a non-string model, an empty provider and an unknown key: `invalid-request`.
	for (
		const body of [
			{ message: 'hi', provider: 'p'.repeat(65) },
			{ message: 'hi', model: 5 },
			{ message: 'hi', provider: '' },
			{ message: 'hi', extra: true },
		]
	) await problem(await h.request('/api/v1/agent/tasks', h.keys.carol, body), 400, 'invalid-request');
	// A 64-character provider passes the shape check and reaches the runtime, which has no provider at all (S0): the
	// §3.10 `-32004` arrives as `400 invalid-request` with the runtime's text as `detail` (gate F18) — the proof the
	// route's mapper is `restFailure` now, since `failure()` carried no detail.
	const sixtyFour = await problem(
		await h.request('/api/v1/agent/tasks', h.keys.carol, { message: 'hi', provider: 'p'.repeat(64) }),
		400,
		'invalid-request',
	);
	assertEquals(sixtyFour.detail, NO_TEXT_BACKEND);
	// No selection, no bridge: the same text, to a caller with or without the scope (rows 5 and 6).
	for (const key of [h.keys.alice, h.keys.carol]) {
		const refused = await problem(
			await h.request('/api/v1/agent/tasks', key, { message: 'hi' }),
			400,
			'invalid-request',
		);
		assertEquals(refused.detail, NO_TEXT_BACKEND);
	}
	// CR-1 / BUG-6: `model` alone is a valid shape but never a valid selection — refused before submit, with or without
	// the scope, as `invalid-request` carrying the one text; no task exists afterwards.
	for (const key of [h.keys.alice, h.keys.carol]) {
		const modelOnly = await problem(
			await h.request('/api/v1/agent/tasks', key, { message: 'hi', model: 'gpt-4.1' }),
			400,
			'invalid-request',
		);
		assertEquals(modelOnly.detail, 'model requires provider');
	}
	assertEquals((await (await h.request('/api/v1/agent/tasks', h.keys.carol)).json()).tasks, []);
});

Deno.test('K2 (gate F18): restFailure is byte-identical to its text at ab66988, so the /a2a/v1 mapping cannot drift', async () => {
	// The tasks route now shares this mapper with the frozen HTTP+JSON binding (`error-codes.md`: `-32001` → 404,
	// `-32002` → 409, `-32603` → 503, the rest → 400). Any edit to the function fails here, by design: a new mapping
	// is a register entry and a change to this pin, never a quiet drift.
	const source = await Deno.readTextFile(new URL('./expansion.ts', import.meta.url));
	const match = /^function restFailure\(cause: unknown, requestId: string\): Response \{\n[\s\S]*?\n\}\n/m.exec(source);
	assert(match !== null, 'restFailure is declared as a plain function');
	assertEquals(
		match[0],
		'function restFailure(cause: unknown, requestId: string): Response {\n' +
			'\tif (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId, cause.detail);\n' +
			'\tif (cause instanceof AgentError) {\n' +
			'\t\tconst slug = cause.code === -32001\n' +
			"\t\t\t? 'not-found'\n" +
			'\t\t\t: cause.code === -32002\n' +
			"\t\t\t? 'conflict'\n" +
			'\t\t\t: cause.code === -32603\n' +
			"\t\t\t? 'service-unavailable'\n" +
			"\t\t\t: 'invalid-request';\n" +
			'\t\treturn problemResponse(slug, requestId, cause.message);\n' +
			'\t}\n' +
			"\treturn problemResponse('internal', requestId);\n" +
			'}\n',
	);
	// And the tasks route reads it: the one `restFailure(` call inside the route beside the `/a2a/v1` one.
	assertEquals(source.match(/return restFailure\(cause, (c\.get\('requestId'\)|requestId)\);/g)?.length, 2);
});

Deno.test('D-143 addendum B: GET /api/v1/a2ui/actions lists the built-ins and the configured names, sorted, names only', async () => {
	await using h = await harness({
		TTK_A2UI_ACTIONS: JSON.stringify([{
			name: 'openDocs',
			tool: 'browser_navigate',
			arguments: { url: 'https://docs.example' },
		}]),
	});
	const listed = await h.request('/api/v1/a2ui/actions', h.keys.alice);
	assertEquals(listed.status, 200);
	const text = await listed.text();
	assertEquals(JSON.parse(text), { names: ['cancelTask', 'openDocs', 'permissionDecision'] });
	// The tool behind a configured button is not told: a reader holding `agent:invoke` but not `mcp:invoke` must not
	// learn it (the `scope-required`-names-nothing rule).
	assert(!text.includes('browser_navigate') && !text.includes('tool'), text);
	// `agent:invoke` is the read scope, as for `GET /api/v1/a2ui/surfaces`.
	const denied = await h.request('/api/v1/a2ui/actions', h.keys.ordinary);
	assertEquals(denied.status, 403);
	await denied.body?.cancel();
	const anon = await h.request('/api/v1/a2ui/actions', null);
	assertEquals(anon.status, 401);
	await anon.body?.cancel();
});

Deno.test('D-143 addendum B: with no configured actions the list is the two built-ins', async () => {
	await using h = await harness();
	assertEquals(await (await h.request('/api/v1/a2ui/actions', h.keys.carol)).json(), {
		names: ['cancelTask', 'permissionDecision'],
	});
});

Deno.test('D-143 §3.7: the diagnostics carry modelProviders and builtinAgent, empty and false in the seam', async () => {
	await using h = await harness();
	const diagnostics = await h.request('/api/v1/system/diagnostics', h.keys.admin);
	assertEquals(diagnostics.status, 200);
	const config = (await diagnostics.json()).config as Record<string, unknown>;
	assertEquals(config.modelProviders, []);
	assertEquals(config.builtinAgent, false);
});
