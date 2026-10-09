/**
 * D-156: SlopLord as the gateway mounts it — its public card, its JSON-RPC and HTTP+JSON endpoints behind the same
 * bearer gate as `/a2a`, `agent` on `POST /api/v1/agent/tasks`, and the providers route's `agents` list. The positive
 * path runs the real loop on the loopback fake provider against a stubbed sandbox service, through the gateway's own
 * executor: SlopLord's prompt reaches the provider, its tools are the allowlist narrowed by the caller's rights, and
 * `sandbox_create` → `sandbox_exec` reach the sandbox.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { SANDBOX_EXECUTE_SCOPE_REQUIRED, SLOPLORD, SLOPLORD_SYSTEM_PROMPT, SLOPLORD_TOOLS } from '@tykotech/agents';
import { SessionRegistry } from '@tykotech/mcp';
import { SandboxClient } from '@tykotech/sandbox';
import { startFakeProvider } from '../../../tests/support/fake_provider.ts';
import { createGatewayApp, type GatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import type { ModelProvidersConfig } from './model_providers.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const BASE = '/a2a/agents/sloplord';
const CARD = `${BASE}/.well-known/agent-card.json`;
const WORKSPACE = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const LIMITS = {
	disk_budget_bytes: 1,
	disk_used_bytes: 0,
	file_bytes: 262144,
	exec_timeout_default_ms: 300000,
	exec_timeout_max_ms: 900000,
	exec_output_bytes: 1048576,
	session_idle_ms: 1800000,
	session_lifetime_ms: 14400000,
	session_input_bytes: 16384,
};

/** A stub sandbox service: `create` lands a workspace, `exec` prints 42; every operation is recorded. */
async function stubSandbox(calls: string[]): Promise<SandboxClient> {
	const sandbox = new SandboxClient({
		url: 'http://sandbox:8080',
		token: 'test-only-sandbox-service-token-0123456789',
		fetch: ((input: RequestInfo | URL): Promise<Response> => {
			const path = new URL(String(input)).pathname;
			if (path === '/healthz') return Promise.resolve(Response.json({ ok: true, backend: 'bwrap' }));
			calls.push(path);
			if (path === '/v1/exec') {
				return Promise.resolve(Response.json({
					exitCode: 0,
					timedOut: false,
					killed: null,
					durationMs: 5,
					output: '42\n',
					truncated: false,
				}));
			}
			return Promise.resolve(
				Response.json({ workspace_id: WORKSPACE, created_at: new Date(0).toISOString(), limits: LIMITS }),
			);
		}) as typeof fetch,
	});
	await sandbox.ready();
	return sandbox;
}

interface Harness {
	app: GatewayApp;
	keys: Record<'coder' | 'nosandbox' | 'plain', string>;
	request(path: string, key: string | null, body?: unknown, headers?: Record<string, string>): Promise<Response>;
	rpc(path: string, key: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
	[Symbol.asyncDispose](): Promise<void>;
}

/** `coder` holds every grant SlopLord needs, `nosandbox` all but `sandbox:execute`, `plain` only `mcp:invoke`. */
async function harness(
	options: { providers?: ModelProvidersConfig; sandbox?: SandboxClient } = {},
): Promise<Harness> {
	const coder = await generateApiKey('coder', ['mcp:invoke', 'agent:invoke', 'model:invoke', 'sandbox:execute']);
	const nosandbox = await generateApiKey('nosandbox', ['mcp:invoke', 'agent:invoke', 'model:invoke']);
	const plain = await generateApiKey('plain', ['mcp:invoke']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([coder.record, nosandbox.record, plain.record]),
	}, options.providers === undefined ? {} : { modelProviders: options.providers });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const app = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'sloplord-routes-test',
		logger: createLogger({ level: 'error', write: (): void => {} }),
		// An unscoped grant: the fake provider is reachable.
		permissions: { querySync: () => ({ state: 'granted' }) as Deno.PermissionStatus },
		...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
	});
	const request = async (
		path: string,
		key: string | null,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<Response> =>
		await app.app.request(`${ORIGIN}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				host: '127.0.0.1:8787',
				...(key === null ? {} : { authorization: `Bearer ${key}` }),
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return {
		app,
		keys: { coder: coder.key, nosandbox: nosandbox.key, plain: plain.key },
		request,
		rpc: async (path, key, method, params) =>
			await (await request(path, key, { jsonrpc: '2.0', id: 1, method, params }, { 'a2a-version': '1.0' })).json(),
		async [Symbol.asyncDispose]() {
			await app.close();
			await registry.shutdown();
		},
	};
}

function message(text: string): Record<string, unknown> {
	return { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }] };
}

Deno.test('D-156: without the sandbox the public card is honest and every entrance refuses with the fixed text', async () => {
	await using h = await harness();
	// Public: no credential. Metadata only, and it says nothing is accepted here.
	const card = await h.request(CARD, null);
	assertEquals(card.status, 200);
	const body = await card.json();
	assertEquals(body.name, 'SlopLord');
	assertEquals(
		(body.supportedInterfaces as Array<{ url: string }>).map((entry) => entry.url),
		[`${ORIGIN}${BASE}`, `${ORIGIN}${BASE}/v1`],
	);
	assertEquals([body.defaultInputModes, body.skills], [[], []]);
	const main = await (await h.request('/.well-known/agent-card.json', null)).json();
	assert(!(main.skills as Array<{ id: string }>).some((skill) => skill.id === 'sloplord'));
	// The endpoints sit behind the bearer gate and `agent:invoke`, as `/a2a` does.
	const anonymous = await h.request(BASE, null, { jsonrpc: '2.0', id: 1, method: 'ListTasks' });
	assertEquals(anonymous.status, 401);
	await anonymous.body?.cancel();
	const scopeless = await h.request(BASE, h.keys.plain, { jsonrpc: '2.0', id: 1, method: 'ListTasks' });
	assertEquals(scopeless.status, 403);
	await scopeless.body?.cancel();
	// JSON-RPC, HTTP+JSON and REST: the runtime's one -32004 text.
	const rpc = await h.rpc(BASE, h.keys.coder, 'SendMessage', { message: message('hi') });
	assertEquals(rpc.error, { code: -32004, message: SLOPLORD.unavailable });
	const rest = await h.request(`${BASE}/v1/message:send`, h.keys.coder, { message: message('hi') }, {
		'a2a-version': '1.0',
	});
	assertEquals(rest.status, 400);
	assertEquals((await rest.json()).detail, SLOPLORD.unavailable);
	const task = await h.request('/api/v1/agent/tasks', h.keys.coder, { message: 'hi', agent: 'sloplord' });
	assertEquals(task.status, 400);
	assertEquals((await task.json()).detail, SLOPLORD.unavailable);
	const unknown = await h.request('/api/v1/agent/tasks', h.keys.coder, { message: 'hi', agent: 'slopqueen' });
	assertEquals(unknown.status, 400);
	await unknown.body?.cancel();
	assertEquals((await (await h.request('/api/v1/agent/tasks', h.keys.coder)).json()).tasks, []);
	const providers = await (await h.request('/api/v1/agent/providers', h.keys.coder)).json();
	assertEquals(providers.agents, [{
		id: 'sloplord',
		name: 'SlopLord',
		description: SLOPLORD.description,
		available: false,
		card_url: `${ORIGIN}${CARD}`,
	}]);
});

Deno.test('D-156: with a provider and the sandbox, a message to SlopLord runs its prompt and allowlist through the sandbox', async () => {
	const fake = startFakeProvider();
	const calls: string[] = [];
	try {
		await using h = await harness({
			providers: {
				default: 'fake',
				providers: [{
					id: 'fake',
					kind: 'openai',
					label: 'Fake',
					host: new URL(fake.url).host,
					baseUrl: fake.url,
					models: ['test-model'],
					defaultModel: 'test-model',
					apiKey: 'sk-test-0123456789abcdefghijklmnop',
					keySource: 'inline',
					headers: {},
					allowHttp: false,
					maxTokensParam: 'max_tokens',
					maxSteps: 8,
					maxOutputTokens: 512,
					tokenBudget: 10_000,
				}],
			},
			sandbox: await stubSandbox(calls),
		});
		const card = await (await h.request(CARD, null)).json();
		assertEquals(card.defaultInputModes, ['text/plain']);
		const main = await (await h.request('/.well-known/agent-card.json', null)).json();
		assert((main.skills as Array<{ id: string }>).some((skill) => skill.id === 'sloplord'));
		fake.script = [
			{ calls: [{ id: 'a', name: 'sandbox_create', arguments: { name: 'proof' } }] },
			{ calls: [{ id: 'b', name: 'browser_navigate', arguments: { url: 'https://example.com' } }] },
			{ calls: [{ id: 'c', name: 'sandbox_exec', arguments: { workspace_id: WORKSPACE, command: 'deno test' } }] },
			{ text: 'Workspace proof: tests print 42.' },
		];
		const sent = await h.rpc(BASE, h.keys.coder, 'SendMessage', { message: message('make it print 42') });
		const task = (sent.result as Record<string, Record<string, unknown>>).task!;
		assertEquals((task.status as Record<string, unknown>).state, 'TASK_STATE_COMPLETED', JSON.stringify(sent));
		assertEquals((task.metadata as Record<string, unknown>).agent, 'sloplord');
		assertEquals(calls, ['/v1/create', '/v1/exec']);
		const first = fake.requests[0]!.body;
		assertEquals((first.messages as Record<string, unknown>[])[0]!.content, SLOPLORD_SYSTEM_PROMPT);
		const offered = (first.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
		assert(offered.includes('sandbox_exec') && offered.every((name) => SLOPLORD_TOOLS.has(name)), offered.join());
		const results = (fake.requests[3]!.body.messages as Record<string, unknown>[])
			.filter((entry) => entry.role === 'tool').map((entry) => String(entry.content));
		assertEquals(results[1], 'Unknown tool: browser_navigate');
		assertStringIncludes(results[2]!, '42');
		// REST sees the profile in the task's metadata; the profile endpoint lists only its own tasks.
		fake.script = [{ text: 'plain answer' }];
		const plain = await h.request('/api/v1/agent/tasks', h.keys.coder, { message: 'hello' });
		assertEquals(plain.status, 202);
		const listed = (await (await h.request('/api/v1/agent/tasks', h.keys.coder)).json()).tasks as Array<
			{ metadata?: { agent?: string } }
		>;
		assertEquals(listed.map((entry) => entry.metadata?.agent ?? null).sort(), ['sloplord', null].sort());
		const own = await (await h.request(`${BASE}/v1/tasks`, h.keys.coder, undefined, { 'a2a-version': '1.0' }))
			.json();
		assertEquals(own.totalSize, 1);
		// The grants: without `sandbox:execute`, a fixed -32600 and nothing created.
		const refused = await h.rpc(BASE, h.keys.nosandbox, 'SendMessage', { message: message('hi') });
		assertEquals(refused.error, { code: -32600, message: SANDBOX_EXECUTE_SCOPE_REQUIRED });
		// `metadata.agent` naming another agent at SlopLord's endpoint is refused.
		const mismatch = await h.rpc(BASE, h.keys.coder, 'SendMessage', {
			message: message('hi'),
			metadata: { agent: 'other' },
		});
		assertEquals((mismatch.error as Record<string, unknown>).code, -32602);
		const providers = await (await h.request('/api/v1/agent/providers', h.keys.coder)).json();
		assertEquals(providers.agents[0].available, true);
	} finally {
		await fake.close();
	}
});
