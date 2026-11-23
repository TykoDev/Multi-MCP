/**
 * Agent-expansion authority, end to end through the real gateway: tasks and streams stay bound to the exact credential
 * that created them, owners never collide across realms or with the administrator, and the public login route is no
 * oracle for delegated bearers.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { BrowserSession } from '@tykotech/browser';
import { extensionTools, registerCatalog, SessionRegistry } from '@tykotech/mcp';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { generateAdminUser } from './admin_auth.ts';
import { createGatewayApp } from './app.ts';
import { expansionOwner, generateApiKey, type Principal, principalFromAuthInfo, VerifierChain } from './auth.ts';
import { ConfigError, loadConfig, parseApiKeys } from './config.ts';
import { fakeSession, quiet } from './support_test.ts';

const ORIGIN = 'http://127.0.0.1:8787';

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
			'a2a-version': '1.0',
			...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
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

// --- Tasks stay bound to the credential that created them -------------------------------------------------------

Deno.test('agent authority: rotating a key fails its queued and running tasks and ends their event streams', async () => {
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
		const events = await call(gateway.app, `/a2a/v1/tasks/${queued}:subscribe`, alice.key);
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

Deno.test('agent authority: a key narrowed while its task waits never lends that task the scopes it lost', async () => {
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

Deno.test('agent authority: a pre-rotation task is never authorized, even after the new key authenticates', async () => {
	const original = await generateApiKey('rotating', ['mcp:invoke', 'agent:invoke', 'sandbox:execute']);
	const replacement = await generateApiKey('rotating', ['mcp:invoke', 'agent:invoke', 'sandbox:execute']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([original.record]) }),
		allowAnonymous: false,
	});
	const requested = new Set(['mcp:invoke', 'sandbox:execute']);
	// The task was submitted under the original key; this is the credential it carries.
	const before = principalFromAuthInfo(await verifier.verifyAccessToken(original.key));
	assert(before.credential, 'the bearer gate fingerprints the credential');
	verifier.replaceApiKeys([replacement.record]);
	// The owner keeps working with the new key.
	const after = principalFromAuthInfo(await verifier.verifyAccessToken(replacement.key));
	assertEquals(expansionOwner(before), expansionOwner(after));
	assertEquals(verifier.authorizeTask('api-key:rotating', requested, before.credential), null);
	assertEquals([...verifier.authorizeTask('api-key:rotating', requested, after.credential)!], [...requested]);
});

// --- Event streams stay bound to the credential that opened them ------------------------------------------------

Deno.test('agent authority: an A2UI event stream ends when its key is rotated and never sees the new key’s surfaces', async () => {
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

// --- No owner collides with the administrator -------------------------------------------------------------------

Deno.test('agent authority: an API-key id cannot claim the administrator’s owner, a control character or an unbounded length', async () => {
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

Deno.test('agent authority: administrator authority is the admin record and a live session, never an id prefix', async () => {
	const { record, password } = await generateAdminUser('admin', 'correct horse battery', ['agent:invoke', 'admin']);
	const config = loadConfig({ TTK_ADMIN_USER: JSON.stringify(record) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const forged: Principal = { kind: 'api-key', id: 'admin:someone', scopes: new Set(['admin']) };
	assertEquals(verifier.currentScopes(forged), null, 'an admin: id with no admin record behind it');
	assertEquals(verifier.currentScopes({ ...forged, id: 'admin:admin' }), null, 'no session credential');
	const admin = await verifier.verifyAdmin('admin', password);
	assert(admin);
	const { token } = await verifier.mintSession(admin);
	const session = principalFromAuthInfo(await verifier.verifyAccessToken(token));
	assert(verifier.currentScopes(session) !== null);
	const owner = expansionOwner(session);
	assert(verifier.authorizeTask(owner, new Set(['agent:invoke']), session.credential));
	// Logging out ends the session's authority: its streams at the next re-check, its tasks at once.
	await verifier.closeSession(token);
	assertEquals(verifier.currentScopes(session), null);
	assertEquals(verifier.authorizeTask(owner, new Set(['agent:invoke']), session.credential), null);
	// A second verifier with no admin record does not honour a session-shaped credential either.
	const bare = new VerifierChain({ config: loadConfig({}), allowAnonymous: false });
	assertEquals(bare.currentScopes(session), null);
});

// --- Owners are the gate's stamp -----------------------------------------------------------------------------------

Deno.test('agent authority: the MCP mount reads the gate-stamped owner and offers extension tools to no unstamped caller', async () => {
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
		const other = dispatch({
			...stamped,
			extra: { ...stamped.extra, principalKind: 'anonymous-loopback', owner: 'other:same-id' },
		});
		assertEquals(other.ctx.extensionPrincipal, 'other:same-id');
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
