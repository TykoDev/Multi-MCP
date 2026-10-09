/**
 * R8 — per-principal session ownership (`TTK_SESSION_OWNERSHIP`, design §2.16, D-128), at the registry and at every
 * MCP surface that looks a session up: tools, resources, notifications and capabilities. The gateway's own surfaces
 * (admin REST, files, SSE, live tickets, recordings) are covered in `packages/gateway/src/session_ownership_test.ts`.
 *
 * `shared` mode must be byte-for-byte what it was (AC27): the shared-mode cases here pin the S0 pass-through
 * semantics, and every pre-existing test runs in `shared` mode unchanged.
 */
import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { dispatchToolCall } from './dispatch.ts';
import { ToolError } from './errors.ts';
import {
	CHILD_ENV_BLANKED,
	childEnvOverrides,
	DEFAULT_SESSION_ID,
	type SessionAccess,
	type SessionOwnership,
	sessionProfile,
	SessionRegistry,
} from './registry.ts';
import { resourceUris } from './resources.ts';
import { watchResourceChanges } from './resource_notifications.ts';
import { capabilitiesFor, createBuildServer, registerCatalog, serverSessionAccess } from './server.ts';

const ALICE: SessionAccess = { owner: 'api-key:alice', admin: false };
const BOB: SessionAccess = { owner: 'api-key:bob', admin: false };
const ADMIN: SessionAccess = { owner: 'api-key:root', admin: true };

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'ownership-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

function registry(ownership?: SessionOwnership, extra: { dataDir?: string; launchDelayMs?: number } = {}) {
	const launched: string[] = [];
	const sessions = new SessionRegistry({
		reapIntervalMs: 0,
		...(ownership === undefined ? {} : { ownership }),
		...(extra.dataDir === undefined ? {} : { dataDir: extra.dataDir }),
		launch: async (id) => {
			launched.push(id);
			if (extra.launchDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, extra.launchDelayMs));
			return fakeSession();
		},
	});
	return { sessions, launched };
}

/** An `AuthInfo` as the gateway's bearer gate mints it: the bare id as `clientId`, the owner on `extra.owner`. */
function authOf(access: SessionAccess, scopes: readonly string[] = ['mcp:invoke']): AuthInfo {
	const id = access.owner.slice('api-key:'.length);
	return {
		token: 't',
		clientId: id,
		scopes: [...scopes, ...(access.admin ? ['admin'] : [])],
		extra: { owner: access.owner },
	};
}

async function call(
	sessions: SessionRegistry,
	access: SessionAccess,
	name: string,
	args: Record<string, unknown> = {},
): Promise<CallToolResult> {
	const server = new McpServer({ name: 'ownership-test', version: '0' });
	try {
		const dispatch = registerCatalog(server, { registry: sessions, version: '0' }, authOf(access));
		return await dispatchToolCall(dispatch, name, args) as CallToolResult;
	} finally {
		await server.close();
	}
}

function errorCode(result: CallToolResult): string | undefined {
	return (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
}

// --- shared mode: the S0 pass-through, unchanged --------------------------------------------------------------------

Deno.test('R8 shared: the default mode, every caller reaches every session and `default` is one session', async () => {
	const { sessions } = registry();
	try {
		assertEquals(sessions.ownership, 'shared');
		const a = await sessions.resolve(undefined, ALICE);
		const b = await sessions.resolve(undefined, BOB);
		assertEquals(a.id, DEFAULT_SESSION_ID);
		assertEquals(b, a, 'one default for everyone');
		assertEquals(a.owner, null, 'shared mode stamps no owner');
		const named = await sessions.createNew('x', undefined, ALICE);
		assertEquals(named.owner, null);
		assertEquals(sessions.peekFor(named.id, BOB), named);
		assertEquals(sessions.peekFor(undefined, BOB), a);
		assert(sessions.canAccess(named, BOB) && sessions.canAccess(named, undefined));
		assertEquals(sessions.visibleTo(BOB).map((r) => r.id), [DEFAULT_SESSION_ID, named.id]);
		assertEquals(sessions.listFor(BOB), sessions.list());
		assertEquals(await sessions.resolve(named.id), named, 'no access needed in shared mode');
	} finally {
		await sessions.shutdown();
	}
});

// --- owner mode at the registry ---------------------------------------------------------------------------------------

Deno.test('R8 owner: `default` is per owner, `default-<ulid>`, and owned by its creator', async () => {
	const { sessions, launched } = registry('owner');
	try {
		const a = await sessions.resolve(undefined, ALICE);
		const again = await sessions.resolve(DEFAULT_SESSION_ID, ALICE);
		const b = await sessions.resolve(undefined, BOB);
		assertEquals(again, a, "the same owner's default is reused");
		assertNotEquals(a.id, b.id, 'default differs per owner');
		assert(/^default-[0-9a-z]{26}$/.test(a.id), a.id);
		assertEquals(a.owner, ALICE.owner);
		assertEquals(b.owner, BOB.owner);
		assertEquals(launched.length, 2);
		assertEquals(sessions.peekFor(undefined, ALICE), a);
		assertEquals(sessions.peekFor('default', BOB), b);
		assertEquals(sessions.peek(DEFAULT_SESSION_ID), undefined, 'no shared default exists');
	} finally {
		await sessions.shutdown();
	}
});

Deno.test("R8 owner: another owner's session is unknown-session — never forbidden — and admin reaches all", async () => {
	const { sessions } = registry('owner');
	try {
		const a = await sessions.createNew('alice', undefined, ALICE);
		const error = await assertRejects(() => sessions.resolve(a.id, BOB), ToolError);
		assertEquals(error.code, 'unknown-session');
		const absent = await assertRejects(() => sessions.resolve('01NOSUCHSESSION', BOB), ToolError);
		assertEquals(
			error.message.replace(a.id, '<id>'),
			absent.message.replace('01NOSUCHSESSION', '<id>'),
			'the same answer an absent id gets',
		);
		assertEquals(sessions.peekFor(a.id, BOB), undefined);
		assertEquals(sessions.canAccess(a, BOB), false);
		assertEquals(sessions.visibleTo(BOB), []);
		assertEquals(sessions.listFor(BOB), []);
		assertEquals(await sessions.resolve(a.id, ADMIN), a, 'admin reaches it');
		assertEquals(sessions.peekFor(a.id, ADMIN), a);
		assertEquals(sessions.visibleTo(ADMIN).map((r) => r.id), [a.id]);
		assertEquals(sessions.listFor(ALICE).map((s) => s.session_id), [a.id]);
		assertEquals(Object.keys(sessions.listFor(ALICE)[0]!).includes('owner'), false, 'a summary carries no owner');
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('R8 owner: no access at all fails closed', async () => {
	const { sessions } = registry('owner');
	try {
		const a = await sessions.resolve(undefined, ALICE);
		assertEquals((await assertRejects(() => sessions.resolve(undefined), ToolError)).code, 'unknown-session');
		assertEquals((await assertRejects(() => sessions.resolve(a.id), ToolError)).code, 'unknown-session');
		assertEquals((await assertRejects(() => sessions.createNew('x'), ToolError)).code, 'unknown-session');
		assertEquals(sessions.peekFor(a.id), undefined);
		assertEquals(sessions.visibleTo(), []);
		assertEquals(sessions.canAccess(a), false);
	} finally {
		await sessions.shutdown();
	}
});

Deno.test("R8 owner: an admin's default and created sessions are the admin's own", async () => {
	const { sessions } = registry('owner');
	try {
		const a = await sessions.resolve(undefined, ALICE);
		const root = await sessions.resolve(undefined, ADMIN);
		assertNotEquals(root.id, a.id, "an admin's `default` is its own, not someone else's");
		assertEquals(root.owner, ADMIN.owner);
		const created = await sessions.createNew(undefined, undefined, ADMIN);
		assertEquals(created.owner, ADMIN.owner);
		assertEquals(sessions.peekFor(created.id, ALICE), undefined);
	} finally {
		await sessions.shutdown();
	}
});

Deno.test("R8 owner: two first calls from one owner share one browser; closing it frees the owner's default", async () => {
	const { sessions, launched } = registry('owner', { launchDelayMs: 20 });
	try {
		const [first, second] = await Promise.all([sessions.resolve(undefined, ALICE), sessions.resolve(undefined, ALICE)]);
		assertEquals(first, second);
		assertEquals(launched.length, 1);
		assert(await sessions.close(first.id));
		assertEquals(sessions.peekFor(undefined, ALICE), undefined);
		const fresh = await sessions.resolve(undefined, ALICE);
		assertNotEquals(fresh.id, first.id, 'a closed default is replaced by a fresh one');
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('R8 owner (F4): the profile-held refusal names the session only to a caller who could reach it', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dataDir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'ownership-profile-' });
	const { sessions } = registry('owner', { dataDir });
	try {
		const held = await sessions.createNew(undefined, 'work', ALICE);
		const own = await assertRejects(() => sessions.createNew(undefined, 'work', ALICE), ToolError);
		assertStringIncludes(own.message, held.id);
		const foreign = await assertRejects(() => sessions.createNew(undefined, 'work', BOB), ToolError);
		assertEquals(foreign.code, 'session-limit');
		assertEquals(foreign.message, 'session-limit: profile work is already open in another session');
		assert(!foreign.message.includes(held.id));
		const admin = await assertRejects(() => sessions.createNew(undefined, 'work', ADMIN), ToolError);
		assertStringIncludes(admin.message, held.id);
	} finally {
		await sessions.shutdown();
		await Deno.remove(dataDir, { recursive: true }).catch(() => {});
	}
});

Deno.test('R8 shared (F4): the profile-held refusal is unchanged', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dataDir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'ownership-profile-' });
	const { sessions } = registry(undefined, { dataDir });
	try {
		const held = await sessions.createNew(undefined, 'work');
		const refused = await assertRejects(() => sessions.createNew(undefined, 'work', BOB), ToolError);
		assertEquals(refused.message, `session-limit: profile work is already open as session ${held.id}; close it first`);
	} finally {
		await sessions.shutdown();
		await Deno.remove(dataDir, { recursive: true }).catch(() => {});
	}
});

// --- owner mode at the tools ------------------------------------------------------------------------------------------

Deno.test("R8 owner: tools never reach another owner's session; list, health and close filter", async () => {
	const { sessions } = registry('owner');
	try {
		const a = await sessions.createNew('alice', undefined, ALICE);
		const b = await sessions.resolve(undefined, BOB);

		const listed = await call(sessions, BOB, 'browser_list_sessions');
		const ids = (listed.structuredContent as { sessions: Array<{ session_id: string }> }).sessions.map((s) =>
			s.session_id
		);
		assertEquals(ids, [b.id]);
		const text = (listed.content[0] as { text: string }).text;
		assert(!text.includes(a.id), 'the text block names no foreign session');
		const details = (listed.structuredContent as { details: Array<{ session_id: string }> }).details;
		assertEquals(details.map((d) => d.session_id), [b.id]);

		const health = await call(sessions, BOB, 'browser_health');
		assertEquals((health.structuredContent as { sessions: { total: number } }).sessions.total, 1);

		for (
			const [tool, args] of [
				['browser_get_session', { session_id: a.id }],
				['browser_list_files', { session_id: a.id }],
				['browser_audit', { session_id: a.id }],
				['browser_close_session', { session_id: a.id }],
			] as const
		) {
			const result = await call(sessions, BOB, tool, args);
			assertEquals(errorCode(result), 'unknown-session', `${tool}: ${JSON.stringify(result.content)}`);
			assert(result.isError === true);
		}
		assert(sessions.peek(a.id) !== undefined, "bob's close did not close alice's session");

		const own = await call(sessions, ALICE, 'browser_close_session', { session_id: a.id });
		assert(own.isError !== true, JSON.stringify(own.content));
		assertEquals(sessions.peek(a.id), undefined);

		const adminList = await call(sessions, ADMIN, 'browser_list_sessions');
		assertEquals((adminList.structuredContent as { sessions: unknown[] }).sessions.length, 1);
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('R8 owner: browser_navigate {new_session} creates a session the caller owns', async () => {
	const { sessions } = registry('owner');
	try {
		// The navigation itself fails on the stand-in browser; the creation is what this asserts.
		await call(sessions, ALICE, 'browser_navigate', { url: 'https://example.com/', new_session: true });
		const created = sessions.records;
		assertEquals(created.length, 1);
		assertEquals(created[0]!.owner, ALICE.owner);
		assertEquals(sessions.visibleTo(BOB), []);
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('R8 owner: the agent tools resolve with the caller access', async () => {
	const { sessions } = registry('owner');
	try {
		const a = await sessions.createNew(undefined, undefined, ALICE);
		const scopes = ['mcp:invoke', 'task'];
		const server = new McpServer({ name: 'ownership-agent', version: '0' });
		try {
			const dispatch = registerCatalog(server, { registry: sessions, version: '0' }, authOf(BOB, scopes));
			for (
				const [tool, args] of [
					['browser_extract_content', { query: 'q', session_id: a.id }],
					['browser_run_task', { task: 't', session_id: a.id }],
				] as const
			) {
				const result = await dispatchToolCall(dispatch, tool, args) as CallToolResult;
				assertEquals(errorCode(result), 'unknown-session', `${tool}: ${JSON.stringify(result.content)}`);
			}
		} finally {
			await server.close();
		}
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('R8 owner: browser_record binds a recording to its starter through the controller', async () => {
	const { sessions } = registry('owner');
	try {
		const a = await sessions.resolve(undefined, ALICE);
		const started: Array<[string, string, string | undefined]> = [];
		const recorder = {
			start: (sessionId: string, name: string, owner?: string) => {
				started.push([sessionId, name, owner]);
				return Promise.resolve({ session_id: sessionId, name, recording: true, frames: 0, duration_ms: 0 });
			},
			stop: () => Promise.reject(new Error('unused')),
			status: () => null,
			list: () => [],
		};
		const server = new McpServer({ name: 'ownership-record', version: '0' });
		try {
			const dispatch = registerCatalog(server, { registry: sessions, version: '0', recorder }, authOf(ALICE));
			const result = await dispatchToolCall(dispatch, 'browser_record', { action: 'start', name: 'clip' });
			assert((result as CallToolResult).isError !== true, JSON.stringify((result as CallToolResult).content));
			assertEquals(started, [[a.id, 'clip', ALICE.owner]]);
			const foreign = await registerCatalog(new McpServer({ name: 'b', version: '0' }), {
				registry: sessions,
				version: '0',
				recorder,
			}, authOf(BOB));
			const refused = await dispatchToolCall(foreign, 'browser_record', { action: 'start', session_id: a.id });
			assertEquals(errorCode(refused as CallToolResult), 'unknown-session');
			assertEquals(started.length, 1);
		} finally {
			await server.close();
		}
	} finally {
		await sessions.shutdown();
	}
});

// --- capabilities, resources and notifications ---------------------------------------------------------------------

Deno.test('R8: capabilities.tykotech.sessions reports the mode to mcp:invoke holders only', () => {
	for (const ownership of ['shared', 'owner'] as const) {
		const { sessions } = registry(ownership);
		const caps = capabilitiesFor({ registry: sessions, version: '0' }, authOf(ALICE));
		assertEquals(caps.sessions, { ownership });
		const viewer = capabilitiesFor({ registry: sessions, version: '0' }, authOf(ALICE, ['view:watch']));
		assertEquals(viewer.sessions, undefined);
		void sessions.shutdown();
	}
});

Deno.test('R8 owner: a built server carries its caller access for its notification watcher', async () => {
	const { sessions } = registry('owner');
	const build = createBuildServer({ registry: sessions, version: '0' });
	const built = await build({ authInfo: authOf(ADMIN), era: 'legacy' } as never) as McpServer;
	const bare = new McpServer({ name: 'ownership-access', version: '0' });
	try {
		assertEquals(serverSessionAccess(built), ADMIN);
		assertEquals(serverSessionAccess(bare), undefined, 'a server this factory did not build carries nothing');
	} finally {
		await built.close();
		await bare.close();
		await sessions.shutdown();
	}
});

type Change = { kind: 'session-added' | 'session-removed' | 'page-changed' | 'files-changed'; sessionId: string };

function notifyHarness() {
	const server = new McpServer({ name: 'notify-owner', version: '0' });
	const sent: string[] = [];
	server.isConnected = () => true;
	server.sendResourceListChanged = () => void sent.push('list_changed');
	server.server.sendResourceUpdated = (params: { uri: string }) => {
		sent.push(`updated ${params.uri}`);
		return Promise.resolve();
	};
	return { server, sent };
}

Deno.test("R8 owner: a connection hears only of its own sessions' changes", async () => {
	const { sessions } = registry('owner');
	try {
		const early = await sessions.createNew(undefined, undefined, BOB);
		const h = notifyHarness();
		const watch = watchResourceChanges(h.server, sessions, 'modern', BOB);
		const a = await sessions.createNew(undefined, undefined, ALICE);
		const b = await sessions.createNew(undefined, undefined, BOB);
		assertEquals(h.sent, ['list_changed'], "alice's session-added was not announced to bob; bob's was");
		h.sent.length = 0;
		await sessions.close(a.id);
		assertEquals(h.sent, [], "alice's removal is not announced");
		await sessions.close(b.id);
		await sessions.close(early.id);
		assertEquals(h.sent, ['list_changed', 'list_changed'], 'both of bob’s removals, including one seen at start');
		watch.close();
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('R8 owner: page changes of a foreign session send no resource update', async () => {
	const { sessions } = registry('owner');
	try {
		const a = await sessions.createNew(undefined, undefined, ALICE);
		const h = notifyHarness();
		// A stand-in registry that forwards to the real one, so a page change can be fired by hand.
		const watchers = new Set<(change: Change) => void>();
		const stand = {
			ownership: sessions.ownership,
			peek: (id: string) => sessions.peek(id),
			canAccess: (record: Parameters<SessionRegistry['canAccess']>[0], access?: SessionAccess) =>
				sessions.canAccess(record, access),
			visibleTo: (access?: SessionAccess) => sessions.visibleTo(access),
			watch: (watcher: (change: Change) => void) => {
				watchers.add(watcher);
				return () => watchers.delete(watcher);
			},
		};
		watchResourceChanges(h.server, stand as never, 'modern', BOB);
		for (const watcher of watchers) watcher({ kind: 'page-changed', sessionId: a.id });
		for (const watcher of watchers) watcher({ kind: 'files-changed', sessionId: a.id });
		assertEquals(h.sent, []);
		watchResourceChanges(h.server, stand as never, 'modern', ALICE);
		for (const watcher of watchers) watcher({ kind: 'page-changed', sessionId: a.id });
		assertEquals(h.sent, resourceUris(a.id).map((uri) => `updated ${uri}`));
	} finally {
		await sessions.shutdown();
	}
});

// --- R7 child environments --------------------------------------------------------------------------------------------

Deno.test('D-127: every launch profile blanks the OTel and inline-secret names, and only them', () => {
	const profile = sessionProfile({
		headless: true,
		downloadsDir: '/data/downloads/x',
		browserPath: null,
		browserArgs: [],
		userDataDir: null,
		storageState: null,
		chromiumSandbox: true,
		allowedDomains: [],
	});
	const env = profile.env ?? {};
	for (
		const name of [
			'OTEL_DENO',
			'OTEL_DENO_CONSOLE',
			'OTEL_SERVICE_NAME',
			'OTEL_RESOURCE_ATTRIBUTES',
			'OTEL_PROPAGATORS',
			'OTEL_EXPORTER_OTLP_ENDPOINT',
			'OTEL_EXPORTER_OTLP_HEADERS',
			'OTEL_EXPORTER_OTLP_PROTOCOL',
			'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
			'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
			'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
			'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
			'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
			'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
			'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
			'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
			'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
			'TTK_API_KEYS',
			'TTK_SECRETS',
			'TTK_ADMIN_USER',
			'TTK_SANDBOX_TOKEN',
			'TTK_AGENT_BRIDGE_TOKEN',
			// D-143 / D-145: the three model-key names an operator shell may export; never read by the gateway.
			'ANTHROPIC_API_KEY',
			'OPENAI_API_KEY',
			'TTK_MODEL_API_KEY',
		]
	) {
		assertEquals(env[name], '', `${name} is blanked`);
	}
	assertEquals(Object.keys(env).length, 25);
	assertEquals([...CHILD_ENV_BLANKED].sort(), Object.keys(env).sort());
	// No `clearEnv`, and nothing a browser needs is touched: proxies, locale and time zone still inherit (F6).
	for (const kept of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'LANG', 'TZ', 'PATH', 'HOME']) {
		assertEquals(kept in env, false, `${kept} is not overridden`);
	}
	assertEquals('clearEnv' in profile, false);
	// A fresh object each time: a caller adding to one cannot change the next child's.
	const first = childEnvOverrides();
	first.EXTRA = 'x';
	assertEquals('EXTRA' in childEnvOverrides(), false);
});
