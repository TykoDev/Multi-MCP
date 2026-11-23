/**
 * The REST seam for the built-in model agent, with no provider configured — `GET /api/v1/agent/providers` in both
 * shapes, the `POST /api/v1/agent/tasks` body (`message`, `provider`, `model`) and its problem mapping, and the
 * diagnostics facts.
 */
import { assertEquals, assertStringIncludes } from '@std/assert';
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
 * and `admin` reads the diagnostics.
 */
async function harness(): Promise<Harness> {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const carol = await generateApiKey('carol', ['mcp:invoke', 'agent:invoke', 'model:invoke']);
	const ordinary = await generateApiKey('ordinary', ['mcp:invoke']);
	const admin = await generateApiKey('admin', ['mcp:invoke', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([alice.record, carol.record, ordinary.record, admin.record]),
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

const NO_TEXT_BACKEND = 'Text execution requires a model provider';
/** The built-in profiles the route lists — SlopLord, unavailable here (no sandbox, no provider). */
const AGENTS = [{
	id: 'sloplord',
	name: 'SlopLord',
	description: SLOPLORD.description,
	available: false,
	card_url: `${ORIGIN}/a2a/agents/sloplord/.well-known/agent-card.json`,
}];

Deno.test('GET /api/v1/agent/providers answers the empty seam, in the caller-shaped form', async () => {
	await using h = await harness();
	// Without `model:invoke`: the list and `invocable: false`.
	const plain = await h.request('/api/v1/agent/providers', h.keys.alice);
	assertEquals(plain.status, 200);
	assertEquals(await plain.json(), { invocable: false, default: null, providers: [], agents: AGENTS });
	// With it: `invocable: true`, same (empty) list.
	const holder = await h.request('/api/v1/agent/providers', h.keys.carol);
	assertEquals(holder.status, 200);
	assertEquals(await holder.json(), { invocable: true, default: null, providers: [], agents: AGENTS });
	// The route sits behind `owner()`: `agent:invoke` is the read scope, as for every other agent route.
	const denied = await h.request('/api/v1/agent/providers', h.keys.ordinary);
	assertEquals(denied.status, 403);
	await denied.body?.cancel();
	const anon = await h.request('/api/v1/agent/providers', null);
	assertEquals(anon.status, 401);
	await anon.body?.cancel();
});

Deno.test('POST /api/v1/agent/tasks takes message, provider and model; provider needs model:invoke first', async () => {
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
	// A 64-character provider passes the shape check and reaches the runtime, which has no provider at all: the
	// runtime's `-32004` arrives as `400 invalid-request` with its text as `detail` (`taskFailure` carries the
	// runtime's message).
	const sixtyFour = await problem(
		await h.request('/api/v1/agent/tasks', h.keys.carol, { message: 'hi', provider: 'p'.repeat(64) }),
		400,
		'invalid-request',
	);
	assertEquals(sixtyFour.detail, NO_TEXT_BACKEND);
	// No selection: the same text, to a caller with or without the scope.
	for (const key of [h.keys.alice, h.keys.carol]) {
		const refused = await problem(
			await h.request('/api/v1/agent/tasks', key, { message: 'hi' }),
			400,
			'invalid-request',
		);
		assertEquals(refused.detail, NO_TEXT_BACKEND);
	}
	// `model` alone is a valid shape but never a valid selection — refused before submit, with or without the scope, as
	// `invalid-request` carrying the one text; no task exists afterwards.
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

Deno.test('the diagnostics carry modelProviders and builtinAgent, empty and false in the seam', async () => {
	await using h = await harness();
	const diagnostics = await h.request('/api/v1/system/diagnostics', h.keys.admin);
	assertEquals(diagnostics.status, 200);
	const config = (await diagnostics.json()).config as Record<string, unknown>;
	assertEquals(config.modelProviders, []);
	assertEquals(config.builtinAgent, false);
});
