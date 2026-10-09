/**
 * Agent-expansion authority, end to end through the real gateway: tasks and streams stay bound to the exact
 * credential that created them (GW-1, GW-3), owners never collide across realms or with the administrator
 * (GW-4, GW-5), and the public login route is no oracle for delegated bearers (GW-11).
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { extensionTools, registerCatalog, SessionRegistry } from '@tykotech/mcp';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { generateAdminUser } from './admin_auth.ts';
import { createGatewayApp } from './app.ts';
import { expansionOwner, generateApiKey, type Principal, principalFromAuthInfo, VerifierChain } from './auth.ts';
import { ConfigError, loadConfig, parseApiKeys } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const quiet = (): ReturnType<typeof createLogger> => createLogger({ level: 'error', write: (): void => {} });

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'agent-authority-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

/** A registry whose first browser launch waits for the test, so tool-calling tasks hold their slots. */
function blockedRegistry(): { registry: SessionRegistry; release(): void } {
	let release: () => void = (): void => {};
	const launched = new Promise<BrowserSession>((resolve) => release = () => resolve(fakeSession()));
	return { registry: new SessionRegistry({ reapIntervalMs: 0, launch: () => launched }), release: () => release() };
}

type App = ReturnType<typeof createGatewayApp>['app'];

function call(
	app: App,
	path: string,
	token: string,
	init: { method?: string; body?: unknown } = {},
): Promise<Response> {
	return Promise.resolve(app.request(`${ORIGIN}${path}`, {
		method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
		headers: {
			host: '127.0.0.1:8787',
			authorization: `Bearer ${token}`,
			...(init.body === undefined ? {} : { 'content-type': 'application/json', 'a2a-version': '1.0' }),
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	}));
}

async function json(response: Response | Promise<Response>): Promise<Record<string, unknown>> {
	return await (await response).json() as Record<string, unknown>;
}

function sendMessage(tool: string, returnImmediately = true): Record<string, unknown> {
	return {
		jsonrpc: '2.0',
		id: 1,
		method: 'SendMessage',
		params: {
			message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ data: { tool, arguments: {} } }] },
			configuration: { returnImmediately },
		},
	};
}

async function submit(app: App, token: string, tool = 'browser_list_tabs'): Promise<string> {
	const body = await json(call(app, '/a2a', token, { body: sendMessage(tool) }));
	const result = body.result as { task?: { id: string } } | undefined;
	assert(result?.task, JSON.stringify(body));
	return result.task.id;
}

type TaskView = { status: { state: string; message?: { parts: { text?: string }[] } }; artifacts: unknown[] };
async function task(app: App, token: string, id: string): Promise<TaskView> {
	const response = await call(app, `/api/v1/agent/tasks/${id}`, token);
	assertEquals(response.status, 200);
	return (await response.json() as { task: TaskView }).task;
}

async function settle(rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** Reads a stream until it ends or `ms` passes, so a stream that never closes fails the test instead of hanging it. */
async function drain(body: ReadableStream<Uint8Array>, ms: number): Promise<{ text: string; ended: boolean }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + ms;
	let text = '';
	try {
		while (Date.now() < deadline) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const next = await Promise.race([
				reader.read(),
				new Promise<'timeout'>((resolve) => timer = setTimeout(() => resolve('timeout'), deadline - Date.now())),
			]);
			clearTimeout(timer);
			if (next === 'timeout') break;
			if (next.done) return { text, ended: true };
			text += decoder.decode(next.value, { stream: true });
		}
		return { text, ended: false };
	} finally {
		await reader.cancel().catch(() => {});
	}
}

const statusText = (view: TaskView): string => view.status.message?.parts.map((part) => part.text ?? '').join('') ?? '';

// --- GW-1 -------------------------------------------------------------------------------------------------------

Deno.test('GW-1 PROBE-1: rotating a key fails its queued and running tasks and ends their event streams', async () => {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const rotated = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([alice.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const { registry, release } = blockedRegistry();
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	try {
		const running = [];
		for (let i = 0; i < 4; i++) running.push(await submit(gateway.app, alice.key));
		const queued = await submit(gateway.app, alice.key);
		await settle();
		assertEquals((await task(gateway.app, alice.key, queued)).status.state, 'TASK_STATE_SUBMITTED');
		const events = await call(gateway.app, `/api/v1/agent/tasks/${queued}/events`, alice.key);
		assertEquals(events.status, 200);

		// The operator rotates alice's key. Her pre-rotation work must not run on the old credential's authority.
		assert(verifier.replaceApiKeys([rotated.record]));
		for (const id of [queued, ...running]) {
			const view = await task(gateway.app, rotated.key, id);
			assertEquals(view.status.state, 'TASK_STATE_FAILED', id === queued ? 'queued' : 'running');
			assertStringIncludes(statusText(view), 'no longer authorized');
		}
		assert((await drain(events.body!, 2_000)).ended, 'the task event stream ends with its credential');
	} finally {
		release();
		await gateway.close();
		await registry.shutdown();
	}
});

Deno.test('GW-1 PROBE-1: a key narrowed while its task waits never lends that task the scopes it lost', async () => {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([alice.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const { registry, release } = blockedRegistry();
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	try {
		for (let i = 0; i < 4; i++) await submit(gateway.app, alice.key);
		const queued = await submit(gateway.app, alice.key);
		await settle();
		// Same key, same hash, narrower grant: the task may still exist, but it may not invoke a tool.
		assert(verifier.replaceApiKeys([{ ...alice.record, scopes: ['agent:invoke'] }]));
		release();
		let view = await task(gateway.app, alice.key, queued);
		const deadline = Date.now() + 10_000;
		while (!['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'].includes(view.status.state) && Date.now() < deadline) {
			await settle();
			view = await task(gateway.app, alice.key, queued);
		}
		assertEquals(view.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(statusText(view), 'mcp:invoke');
		assertEquals(view.artifacts, [], 'no tool ran on the submit-time scopes');
	} finally {
		release();
		await gateway.close();
		await registry.shutdown();
	}
});

Deno.test('GW-1 PROBE-2: a delegation is never issued to a pre-rotation task, even after the new key authenticates', async () => {
	const original = await generateApiKey('rotating', ['mcp:invoke', 'agent:invoke', 'sandbox:execute']);
	const replacement = await generateApiKey('rotating', ['mcp:invoke', 'agent:invoke', 'sandbox:execute']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([original.record]) }),
		allowAnonymous: false,
	});
	const requested = new Set(['mcp:invoke', 'sandbox:execute']);
	try {
		// The task was submitted under the original key; this is the credential it carries.
		const before = principalFromAuthInfo(await verifier.verifyAccessToken(original.key));
		assert(before.credential, 'the bearer gate fingerprints the credential');
		verifier.replaceApiKeys([replacement.record]);
		// The owner keeps working with the new key, which refreshes the owner's cached authority.
		const after = principalFromAuthInfo(await verifier.verifyAccessToken(replacement.key));
		assertEquals(expansionOwner(before), expansionOwner(after));
		assertEquals(await verifier.delegateMcp('api-key:rotating', requested, before.credential), null);
		assertEquals(await verifier.delegateMcp('api-key:rotating', requested, undefined), null);
		const fresh = await verifier.delegateMcp('api-key:rotating', requested, after.credential);
		assert(fresh, 'the replacement credential’s own tasks still get one');
		fresh.close();
		// The task-authority check agrees with the delegation one.
		assertEquals(verifier.authorizeTask('api-key:rotating', requested, before.credential), null);
		assertEquals([...verifier.authorizeTask('api-key:rotating', requested, after.credential)!], [...requested]);
	} finally {
		verifier.closeDelegations();
	}
});

// --- GW-3 -------------------------------------------------------------------------------------------------------

Deno.test('GW-3: an A2UI event stream ends when its key is rotated and never sees the new key’s surfaces', async () => {
	const alice = await generateApiKey('alice', ['agent:invoke', 'a2ui:publish']);
	const rotated = await generateApiKey('alice', ['agent:invoke', 'a2ui:publish']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([alice.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	try {
		const stream = await call(gateway.app, '/api/v1/a2ui/events', alice.key);
		assertEquals(stream.status, 200);
		assert(verifier.replaceApiKeys([rotated.record]));
		const published = await call(gateway.app, '/api/v1/a2ui/surfaces', rotated.key, {
			body: { version: 'v0.9', createSurface: { surfaceId: 'after-rotation', catalogId: A2UI_CATALOG_ID } },
		});
		assertEquals(published.status, 200);
		await published.body?.cancel();
		const { text, ended } = await drain(stream.body!, 2_000);
		assert(ended, 'the pre-rotation stream was closed');
		assertStringIncludes(text, 'event: bye');
		assertEquals(text.includes('after-rotation'), false, 'no surface reached the old credential');
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});

// --- GW-11 ------------------------------------------------------------------------------------------------------

Deno.test('GW-11: the public login route refuses delegated bearers instead of describing them', async () => {
	const parent = await generateApiKey('parent', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([parent.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	try {
		const principal = principalFromAuthInfo(await verifier.verifyAccessToken(parent.key));
		const delegated = await verifier.delegateMcp('api-key:parent', new Set(['mcp:invoke']), principal.credential);
		assert(delegated);
		const response = await gateway.app.request(`${ORIGIN}/api/v1/auth/login`, {
			method: 'POST',
			headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' },
			body: JSON.stringify({ apiKey: delegated.token }),
		});
		assertEquals(response.status, 401);
		assertEquals(JSON.stringify(await response.json()).includes('parent'), false);
		delegated.close();
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});

// --- GW-4 -------------------------------------------------------------------------------------------------------

Deno.test('GW-4: an API-key id cannot claim the administrator’s owner, a control character or an unbounded length', async () => {
	const key = await generateApiKey('placeholder');
	for (const id of ['admin:admin', 'ADMIN:root', 'line\nbreak', 'tab\there', 'x'.repeat(129)]) {
		assertThrows(
			() => loadConfig({ TTK_API_KEYS: JSON.stringify([{ ...key.record, id }]) }),
			ConfigError,
			'TTK_API_KEYS',
			JSON.stringify(id),
		);
		// The reload path parses with the same function, so a reloaded file cannot introduce one either.
		assertThrows(() => parseApiKeys(JSON.stringify([{ ...key.record, id }]), 'TTK_API_KEYS_FILE'), ConfigError);
	}
	assertEquals(parseApiKeys(JSON.stringify([{ ...key.record, id: 'x'.repeat(128) }]), 'test').length, 1);
	assertEquals(parseApiKeys(JSON.stringify([{ ...key.record, id: 'administrator' }]), 'test').length, 1);
});

Deno.test('GW-4: administrator authority is the admin record and a live session, never an id prefix', async () => {
	const { record, password } = await generateAdminUser('admin', 'correct horse battery', ['agent:invoke', 'admin']);
	const config = loadConfig({ TTK_ADMIN_USER: JSON.stringify(record) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const forged: Principal = { kind: 'api-key', id: 'admin:someone', scopes: new Set(['admin']) };
	assertEquals(verifier.stillAuthorized(forged), false, 'an admin: id with no admin record behind it');
	assertEquals(verifier.stillAuthorized({ ...forged, id: 'admin:admin' }), false, 'no session credential');
	const admin = await verifier.verifyAdmin('admin', password);
	assert(admin);
	const { token } = await verifier.mintSession(admin);
	const session = principalFromAuthInfo(await verifier.verifyAccessToken(token));
	assertEquals(verifier.stillAuthorized(session), true);
	const owner = expansionOwner(session);
	assert(verifier.authorizeTask(owner, new Set(['agent:invoke']), session.credential));
	// Logging out ends the session's authority: its streams at the next re-check, its tasks at once.
	await verifier.closeSession(token);
	assertEquals(verifier.stillAuthorized(session), false);
	assertEquals(verifier.authorizeTask(owner, new Set(['agent:invoke']), session.credential), null);
	// A second verifier with no admin record does not honour a session-shaped credential either.
	const bare = new VerifierChain({ config: loadConfig({}), allowAnonymous: false });
	assertEquals(bare.stillAuthorized(session), false);
});

// --- GW-5 -------------------------------------------------------------------------------------------------------

// The fixture substitutes only signature verification; the gate, owner composition, runtime and stores are real.
const OAUTH_FIXTURE = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzYW1lLWlkIn0.';
class RealmFixtureVerifier extends VerifierChain {
	override async resolve(token: string): Promise<Principal | null> {
		if (token === OAUTH_FIXTURE) {
			return {
				kind: 'oauth',
				id: 'same-id',
				scopes: new Set(['mcp:invoke', 'agent:invoke', 'a2ui:publish']),
				credential: `oauth:${Date.now() + 3_600_000}`,
			};
		}
		return await super.resolve(token);
	}
}

async function mcpTool(app: App, token: string, name: string, args: Record<string, unknown>): Promise<{
	isError?: boolean;
	structuredContent?: { result?: Record<string, unknown> };
}> {
	const response = await app.request(`${ORIGIN}/mcp`, {
		method: 'POST',
		headers: {
			host: '127.0.0.1:8787',
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
	});
	const text = await response.text();
	assertEquals(response.status, 200, text);
	const line = text.trimStart().startsWith('{')
		? text
		: text.split('\n').find((entry) => entry.startsWith('data:'))!.slice(5);
	const body = JSON.parse(line) as { result?: Record<string, unknown>; error?: unknown };
	assert(body.result, line);
	return body.result;
}

Deno.test('GW-5: matching API-key and OAuth ids never share tasks over /a2a, REST or MCP extension tools', async () => {
	const api = await generateApiKey('same-id', ['mcp:invoke', 'agent:invoke', 'a2ui:publish']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([api.record]) });
	const verifier = new RealmFixtureVerifier({ config, allowAnonymous: false });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	const app = gateway.app;
	try {
		const body = await json(call(app, '/a2a', api.key, { body: sendMessage('browser_list_sessions', false) }));
		const id = (body.result as { task: { id: string } }).task.id;
		// REST, as the colliding OAuth subject.
		assertEquals((await json(call(app, '/api/v1/agent/tasks', OAUTH_FIXTURE))).tasks, []);
		for (
			const [path, method] of [
				[`/api/v1/agent/tasks/${id}`, 'GET'],
				[`/api/v1/agent/tasks/${id}/events`, 'GET'],
				[`/api/v1/agent/tasks/${id}/cancel`, 'POST'],
			] as const
		) {
			const response = await call(app, path, OAUTH_FIXTURE, { method });
			assertEquals(response.status, 404, `${method} ${path}`);
			await response.body?.cancel();
		}
		// A2A, as the colliding OAuth subject.
		const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
			json(call(app, '/a2a', OAUTH_FIXTURE, { body: { jsonrpc: '2.0', id: 2, method, params } }));
		assertEquals(((await rpc('GetTask', { id })).error as { code: number }).code, -32001);
		assertEquals(((await rpc('CancelTask', { id })).error as { code: number }).code, -32001);
		assertEquals(((await rpc('ListTasks', {})).result as { tasks: unknown[] }).tasks, []);
		// MCP extension tools, whose owner the MCP mount now reads from the gate's stamp.
		assertEquals((await mcpTool(app, OAUTH_FIXTURE, 'agent_get_task', { task_id: id })).isError, true);
		const own = await mcpTool(app, api.key, 'agent_get_task', { task_id: id });
		assertEquals((own.structuredContent?.result?.task as { id?: string } | undefined)?.id, id);
		await mcpTool(app, OAUTH_FIXTURE, 'a2ui_publish', {
			message: { version: 'v0.9', createSurface: { surfaceId: 'oauth-owned', catalogId: A2UI_CATALOG_ID } },
		});
		assertEquals((await json(call(app, '/api/v1/a2ui/surfaces', api.key))).surfaces, []);
		const mine = (await json(call(app, '/api/v1/a2ui/surfaces', OAUTH_FIXTURE))).surfaces as { surfaceId: string }[];
		assertEquals(mine.map((surface) => surface.surfaceId), ['oauth-owned']);
		// And the owner itself appears in the API key's own task list.
		const listed = (await json(call(app, '/api/v1/agent/tasks', api.key))).tasks as { id: string }[];
		assertEquals(listed.map((entry) => entry.id), [id]);
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});

Deno.test('GW-5: the MCP mount reads the gate-stamped owner and offers extension tools to no unstamped caller', async () => {
	const api = await generateApiKey('same-id', ['mcp:invoke', 'agent:invoke']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([api.record]) }),
		allowAnonymous: false,
	});
	const stamped = await verifier.verifyAccessToken(api.key);
	assertEquals(stamped.extra?.owner, 'api-key:same-id');
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const extraTools = extensionTools({ agent_peers: () => Promise.resolve({ peers: [] }) });
	const servers: McpServer[] = [];
	const dispatch = (authInfo: AuthInfo | undefined): ReturnType<typeof registerCatalog> => {
		const server = new McpServer({ name: 'gw-5', version: '1' });
		servers.push(server);
		return registerCatalog(server, { registry, version: 'gw-5', extraTools }, authInfo);
	};
	try {
		const fromGate = dispatch(stamped);
		assertEquals(fromGate.ctx.extensionPrincipal, 'api-key:same-id');
		assert(fromGate.permitted.has('agent_peers'));
		// One derivation: whatever the gate stamped is the owner, whatever kind it names.
		const other = dispatch({ ...stamped, extra: { ...stamped.extra, principalKind: 'oauth', owner: 'oauth:same-id' } });
		assertEquals(other.ctx.extensionPrincipal, 'oauth:same-id');
		// An AuthInfo the gateway did not stamp gets no extension tool rather than a guessed realm.
		const unstamped = dispatch({ ...stamped, extra: { principalKind: 'api-key' } });
		assertEquals(unstamped.ctx.extensionPrincipal, undefined);
		assertEquals(unstamped.permitted.has('agent_peers'), false);
		assert(unstamped.permitted.has('browser_list_sessions'), 'the browser catalog is unaffected');
		// The credential-less mounts have one principal, the same owner the gateway composes for it.
		assertEquals(
			dispatch(undefined).ctx.extensionPrincipal,
			expansionOwner({ kind: 'anonymous-loopback', id: 'anonymous:127.0.0.1', scopes: new Set() }),
		);
	} finally {
		await Promise.all(servers.map((server) => server.close()));
		await registry.shutdown();
	}
});
