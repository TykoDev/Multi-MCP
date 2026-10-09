/**
 * R8: the opt-in stateful 2025-era transport.
 *
 * Driven over real HTTP against a real gateway, with the JSON-RPC written by
 * hand — the SDK client speaks whichever era it negotiates, and the thing under
 * test is precisely what a *legacy* client sees: an `Mcp-Session-Id` coming
 * back, subsequent calls routing to the same session, and a standalone stream
 * that exists at all.
 *
 * The browser is not involved, so this is a unit-tier suite: the registry's
 * launcher is replaced with a fake session, exactly as `gateway_test.ts` does.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { generateApiKey } from './auth.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { type RunningGateway, startGateway } from './server.ts';
import { SESSION_HEADER, wantsStatefulSession } from './stateful.ts';

/** A browser session stand-in: this suite never touches a page. */
function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		eventBus: new EventBus({ name: 'stateful-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

interface Fixture {
	url: string;
	key: string;
	gateway: RunningGateway;
	[Symbol.asyncDispose](): Promise<void>;
}

async function fixture(
	overrides: Record<string, string> = {},
	launch?: () => Promise<unknown>,
): Promise<Fixture> {
	const { key, record } = await generateApiKey('stateful');
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([record]),
		TTK_LOG_LEVEL: 'error',
		TTK_MCP_STATEFUL: 'true',
		...overrides,
	});
	const gateway = await startGateway({
		config,
		version: '0.1.0-test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: (launch ?? (() => Promise.resolve(fakeSession()))) as never,
	});
	return {
		url: gateway.url,
		key,
		gateway,
		async [Symbol.asyncDispose]() {
			await gateway.shutdown();
			await gateway.finished;
		},
	};
}

/** One JSON-RPC POST, exactly as a 2025 client would send it. */
function rpc(
	f: Fixture,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(`${f.url}/mcp`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${f.key}`,
			...headers,
		},
		body: JSON.stringify(body),
	});
}

const LEGACY_INITIALIZE = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'legacy-client', version: '1' },
	},
};

// --- routing ----------------------------------------------------------------

Deno.test('stateful: routing picks the mount from what the client declared', () => {
	// The body a router sees is the *parsed* one, passed separately; the request
	// only has to be a POST with the right headers.
	const post = (headers: Record<string, string> = {}) =>
		new Request('http://x/mcp', { method: 'POST', headers, body: '{}' });

	// A 2025 initialize opts in...
	assertEquals(wantsStatefulSession(post(), LEGACY_INITIALIZE), true);
	// ...a 2026 one does not.
	assertEquals(
		wantsStatefulSession(post(), { method: 'initialize', params: { protocolVersion: '2026-07-28' } }),
		false,
	);
	// An ordinary call with no session header stays stateless.
	assertEquals(wantsStatefulSession(post(), { method: 'tools/list' }), false);
	// A session header always routes to the session.
	assertEquals(wantsStatefulSession(post({ [SESSION_HEADER]: 'abc' }), { method: 'tools/list' }), true);
	// A GET is a standalone stream, which only the stateful world has.
	assertEquals(wantsStatefulSession(new Request('http://x/mcp'), undefined), true);
	// A batch is judged by its first message, as the transport would.
	assertEquals(wantsStatefulSession(post(), [LEGACY_INITIALIZE]), true);
	// A body that is not an initialize at all cannot opt in.
	assertEquals(wantsStatefulSession(post(), 'nonsense'), false);
	assertEquals(wantsStatefulSession(post(), undefined), false);
});

// --- the session lifecycle ---------------------------------------------------

Deno.test('stateful: a 2025 client is given a session it can keep using', async () => {
	await using f = await fixture();

	const initialized = await rpc(f, LEGACY_INITIALIZE);
	assertEquals(initialized.status, 200);
	const sessionId = initialized.headers.get(SESSION_HEADER);
	assert(sessionId !== null && sessionId !== '', 'no Mcp-Session-Id came back');
	await initialized.body?.cancel();

	// The same session id lists the same catalog the stateless mount serves.
	const listed = await rpc(f, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { [SESSION_HEADER]: sessionId });
	assertEquals(listed.status, 200);
	const text = await listed.text();
	assertStringIncludes(text, 'browser_navigate');
	assertStringIncludes(text, 'browser_get_state');

	// Deleting it ends the session...
	const deleted = await fetch(`${f.url}/mcp`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${f.key}`, [SESSION_HEADER]: sessionId },
	});
	assert(deleted.status < 400, `delete answered ${deleted.status}`);
	await deleted.body?.cancel();

	// ...and the id is then unknown, which is what tells a client to re-initialize.
	const after = await rpc(f, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { [SESSION_HEADER]: sessionId });
	assertEquals(after.status, 404);
	assertStringIncludes(await after.text(), 'Session not found');
});

/** The JSON-RPC result of a response the legacy mount may have framed as SSE. */
async function resultOf(response: Response): Promise<Record<string, unknown>> {
	const body = await response.text();
	const line = body.includes('data: ') ? body.slice(body.lastIndexOf('data: ') + 6).split('\n')[0] ?? '' : body;
	return (JSON.parse(line) as { result?: Record<string, unknown> }).result ?? {};
}

Deno.test('stateful: a 2025 client gets the file tools and their embedded bytes (E-33)', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'stateful-files-' });
	const payload = new Uint8Array(2048).map((_, index) => (index * 11) % 256);
	await Deno.writeFile(`${dir}/G1`, payload);
	const records = [{
		guid: 'G1',
		url: 'http://127.0.0.1:1/export',
		suggestedFilename: 'export.bin',
		fileName: 'export.bin',
		path: `${dir}/G1`,
		fileSize: payload.length,
		receivedBytes: payload.length,
		totalBytes: payload.length,
		fileType: 'bin',
		mimeType: null,
		autoDownload: false,
		state: 'completed' as const,
		startedAt: 1,
		completedAt: 2,
		error: null,
	}];
	const session = fakeSession();
	try {
		// D-150: `owner` is the default; the session is created below with no caller, so it is shared here.
		await using f = await fixture(
			{ TTK_SESSION_OWNERSHIP: 'shared' },
			() =>
				Promise.resolve({
					session,
					downloads: {
						downloads: records,
						isRemoteBrowser: false,
						lookup: (g: string) => records.find((r) => r.guid === g),
					},
					downloadsDir: dir,
				}),
		);
		// The session must exist before a file can be read from it.
		await f.gateway.registry.resolve(undefined);

		const initialized = await rpc(f, LEGACY_INITIALIZE);
		const sessionId = initialized.headers.get(SESSION_HEADER);
		assert(sessionId !== null && sessionId !== '');
		await initialized.body?.cancel();

		const listed = await rpc(f, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { [SESSION_HEADER]: sessionId });
		const catalog = await listed.text();
		assertStringIncludes(catalog, 'browser_list_files');
		assertStringIncludes(catalog, 'browser_get_file');

		// The content blocks are what a 2025-era client actually has to parse: an
		// embedded blob resource, base64, over the era's own envelope.
		const called = await rpc(f, {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'browser_get_file', arguments: { file_id: 'G1' } },
		}, { [SESSION_HEADER]: sessionId });
		assertEquals(called.status, 200);
		const result = await resultOf(called);
		assertEquals(result.isError, undefined, JSON.stringify(result));
		const blocks = result.content as Array<{ type: string; resource?: { blob?: string; uri?: string } }>;
		const embedded = blocks.find((block) => block.type === 'resource')?.resource;
		assert(embedded?.blob !== undefined, JSON.stringify(blocks));
		assertEquals(embedded.uri, 'ttk://session/default/files/G1');
		const bytes = Uint8Array.from(atob(embedded.blob), (character) => character.charCodeAt(0));
		assertEquals(bytes.length, payload.length);
		assertEquals(bytes.every((value, index) => value === payload[index]), true, 'byte equality');
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('stateful: an unknown session id is refused rather than silently created', async () => {
	await using f = await fixture();
	const response = await rpc(f, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
		[SESSION_HEADER]: 'not-a-real-session',
	});
	assertEquals(response.status, 404);
	assertStringIncludes(await response.text(), 'Session not found');
});

Deno.test('stateful: two clients get two independent sessions', async () => {
	await using f = await fixture();
	const first = await rpc(f, LEGACY_INITIALIZE);
	const second = await rpc(f, LEGACY_INITIALIZE);
	const a = first.headers.get(SESSION_HEADER);
	const b = second.headers.get(SESSION_HEADER);
	await first.body?.cancel();
	await second.body?.cancel();

	assert(a !== null && b !== null);
	assert(a !== b, 'two initializations produced one session');
});

Deno.test('stateful: the modern client is untouched by the option', async () => {
	await using f = await fixture();
	// A 2026-era initialize gets no session header: it went to the stateless
	// mount, which is the whole point of routing on the declared revision.
	const response = await rpc(f, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'modern', version: '1' } },
	});
	assertEquals(response.headers.get(SESSION_HEADER), null);
	await response.body?.cancel();
});

Deno.test('stateful: the mount does not exist unless it is switched on', async () => {
	await using f = await fixture({ TTK_MCP_STATEFUL: 'false' });
	const response = await rpc(f, LEGACY_INITIALIZE);
	// Served by the stateless mount, so no session is minted. The call still
	// works — the default path serves both eras — it is only *sessions* that
	// are off.
	assertEquals(response.headers.get(SESSION_HEADER), null);
	await response.body?.cancel();
});

Deno.test('stateful: shutdown closes the sessions it opened', async () => {
	const f = await fixture();
	const opened = await rpc(f, LEGACY_INITIALIZE);
	const sessionId = opened.headers.get(SESSION_HEADER);
	assert(sessionId !== null);
	await opened.body?.cancel();

	// A clean shutdown with a live transport session must not hang or leak.
	await f.gateway.shutdown();
	await f.gateway.finished;
});

// --- D-080: the standalone stream carries resource changes -----------------------

Deno.test('stateful: the standalone stream carries list_changed, and updated only for subscribed URIs', async () => {
	const { createBuildServer, resourceUris, SessionRegistry } = await import('@tykotech/mcp');
	const { StatefulMount } = await import('./stateful.ts');
	type Change = { kind: 'session-added' | 'session-removed' | 'page-changed' | 'files-changed'; sessionId: string };
	const watchers = new Set<(change: Change) => void>();
	const fire = (change: Change) => {
		for (const watcher of watchers) watcher(change);
	};
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const mount = new StatefulMount({
		buildServer: createBuildServer({ registry, version: 'test' }),
		logger: createLogger({ level: 'error', write: () => {} }),
		registry: {
			watch: (watcher) => {
				watchers.add(watcher as (change: Change) => void);
				return () => watchers.delete(watcher as (change: Change) => void);
			},
		},
	});
	const auth = { authInfo: { token: 't', clientId: 'c', scopes: ['mcp:invoke', 'view:watch'], extra: {} } };
	const post = (body: unknown, session?: string) =>
		mount.fetch(
			new Request('http://127.0.0.1/mcp', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					...(session === undefined ? {} : { [SESSION_HEADER]: session, 'mcp-protocol-version': '2025-06-18' }),
				},
				body: JSON.stringify(body),
			}),
			auth,
		);
	try {
		const init = await post(LEGACY_INITIALIZE);
		const session = init.headers.get(SESSION_HEADER)!;
		const capabilities = (await resultOf(init)).capabilities as { resources?: { subscribe?: boolean } };
		assertEquals(capabilities.resources?.subscribe, true, 'resources.subscribe is advertised');
		await (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)).body?.cancel();

		const [watched, other] = [resourceUris('alpha')[0]!, resourceUris('beta')[0]!];
		const subscribed = await post(
			{ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: watched } },
			session,
		);
		assertEquals(subscribed.status, 200);
		await subscribed.body?.cancel();

		const stream = await mount.fetch(
			new Request('http://127.0.0.1/mcp', {
				headers: { accept: 'text/event-stream', [SESSION_HEADER]: session, 'mcp-protocol-version': '2025-06-18' },
			}),
			auth,
		);
		assertEquals(stream.status, 200);
		const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
		await new Promise((resolve) => setTimeout(resolve, 50));
		fire({ kind: 'session-added', sessionId: 'beta' });
		fire({ kind: 'page-changed', sessionId: 'beta' });
		fire({ kind: 'page-changed', sessionId: 'alpha' });
		let text = '';
		const deadline = Date.now() + 3_000;
		while (Date.now() < deadline && !text.includes(watched)) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const next = await Promise.race([
				reader.read(),
				new Promise<{ value?: string; done: boolean }>((r) => timer = setTimeout(() => r({ done: false }), 200)),
			]);
			clearTimeout(timer);
			if (next.value) text += next.value;
			if (next.done) break;
		}
		await reader.cancel();
		assertStringIncludes(text, 'notifications/resources/list_changed');
		assertStringIncludes(text, `"uri":"${watched}"`);
		assert(!text.includes(other), 'an unsubscribed URI was announced');

		// Closing the session stops its watch.
		const before = watchers.size;
		await mount.fetch(
			new Request('http://127.0.0.1/mcp', { method: 'DELETE', headers: { [SESSION_HEADER]: session } }),
			auth,
		).then((r) => r.body?.cancel());
		assertEquals(watchers.size, before - 1);
	} finally {
		await mount.close();
		await registry.shutdown('test');
	}
});

Deno.test('C8: TTK_MCP_STATEFUL with TTK_CLUSTER_KV is refused at startup, naming both variables', () => {
	// A transport session lives in one process; the cluster routes a request to the node holding its *browser*
	// session, so a 2025-era client's next request could reach a node that never saw its Mcp-Session-Id.
	const error = assertThrows(
		() => loadConfig({ TTK_MCP_STATEFUL: 'true', TTK_CLUSTER_KV: 'tests/.scratch/kv', TTK_NODE_URL: 'http://n1:8787' }),
		ConfigError,
	);
	assertStringIncludes(error.message, 'TTK_MCP_STATEFUL');
	assertStringIncludes(error.message, 'TTK_CLUSTER_KV');
	// Either alone is a valid configuration.
	assertEquals(loadConfig({ TTK_MCP_STATEFUL: 'true' }).mcpStateful, true);
	assertEquals(loadConfig({ TTK_CLUSTER_KV: 'tests/.scratch/kv' }).cluster?.kvPath, 'tests/.scratch/kv');
	assertEquals(loadConfig({ TTK_MCP_STATEFUL: 'false', TTK_CLUSTER_KV: 'tests/.scratch/kv' }).mcpStateful, false);
});
