/**
 * R3 (D-115, ERRATUM(E-94)) on the MCP side: what an E0 block — a document request the browser refused before
 * sending it — leaves in the registry, and what the tools that issued the navigation answer.
 *
 * The browser is a stand-in with a **real** event bus: the vendored `SessionManager` reports E0 as a
 * `BrowserErrorEvent` on that bus, so dispatching the same event here exercises exactly the registry path the
 * browser tier does. The vendored half (the veto itself) is proven in `session_manager_test.ts` and on Chrome 154
 * in `tests/e2e/containment_e2e_test.ts`.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
	BrowserErrorEvent,
	type BrowserSession,
	GoBackEvent,
	NavigateToUrlEvent,
	NavigationCompleteEvent,
} from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { isToolError } from './errors.ts';
import {
	blockedSince,
	browserArgsUseProxy,
	DEFAULT_SESSION_ID,
	DOCUMENT_BLOCK_MEMORY,
	PROXY_WEBSOCKET_CAVEAT,
	resolverLayerRules,
	sessionProfile,
	type SessionRecord,
	SessionRegistry,
} from './registry.ts';
import { browserDownload, browserGoBack, browserNavigate } from './tools.ts';
import type { ToolContext } from './types.ts';

const TOP = 'T-top';
const OFF = 'https://idp.evil.test/callback?code=Zq8-E0-CODE-3vP';

function e0(
	url: string,
	targetId: string = TOP,
	frameId: string = targetId,
	extra: Record<string, unknown> = {},
): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: 'NavigationBlocked',
		message: `Navigation to ${url} is not allowed by the configured domain policy`,
		details: { enforcementPoint: 'E0', url, targetId, frameId, containment: 'request-blocked', ...extra },
	});
}

/**
 * The slice of a CDP client the registry arms (`client.on`), with a way to deliver an event — enough to drive the
 * main-frame commits review R2-2 attributes blocks by.
 */
class FakeClient {
	readonly #listeners = new Map<string, Array<(params: unknown, sessionId?: string) => void>>();
	on(method: string, listener: (params: unknown, sessionId?: string) => void): () => void {
		const list = this.#listeners.get(method) ?? [];
		list.push(listener);
		this.#listeners.set(method, list);
		return () => {};
	}
	emit(method: string, params: unknown): void {
		for (const listener of this.#listeners.get(method) ?? []) listener(params, 'S-top');
	}
	/** A main-frame commit of `url` on the tab, as Chrome reports it. */
	commit(url: string, frameId = TOP): void {
		this.emit('Page.frameNavigated', { frame: { id: frameId, loaderId: 'L', url, securityOrigin: '', mimeType: '' } });
	}
}

interface Fixture extends AsyncDisposable {
	readonly registry: SessionRegistry;
	readonly record: SessionRecord;
	readonly bus: EventBus;
	readonly infos: string[];
	readonly ctx: ToolContext;
	advance(ms: number): void;
}

async function fixture(client: FakeClient | null = null): Promise<Fixture> {
	let now = 50_000;
	const infos: string[] = [];
	const bus = new EventBus({ name: 'containment' });
	const session = {
		cdpClient: client,
		sessionManager: null,
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: TOP,
		eventBus: bus,
		getBrowserStateSummary: () => Promise.resolve({ url: 'https://example.com/home', title: 'home' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		now: () => now,
		allowedDomains: ['example.com'],
		logger: {
			warn: () => {},
			info: (message) => void (message.includes('TTK_ALLOWED_DOMAINS') && infos.push(message)),
		},
		launch: () => Promise.resolve(session),
	});
	const record = await registry.resolve(DEFAULT_SESSION_ID);
	return {
		registry,
		record,
		bus,
		infos,
		ctx: { registry, allowedDomains: ['example.com'], principal: 'test' },
		advance: (ms) => void (now += ms),
		[Symbol.asyncDispose]: async () => {
			await registry.shutdown();
		},
	};
}

function ring(record: SessionRecord) {
	return record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
}

Deno.test('R3: an E0 block is one navigation record — blocked, request-blocked, not committed, redacted', async () => {
	await using f = await fixture();
	await f.bus.dispatch(e0(OFF));
	// The session's own completion for the same URL (a navigation that reported the refused URL) adds nothing.
	await f.bus.dispatch(
		new NavigationCompleteEvent({ targetId: TOP as never, url: OFF, errorMessage: 'net::ERR_ABORTED' }),
	);
	const records = ring(f.record);
	assertEquals(records.length, 1, JSON.stringify(records));
	const [navigation] = records;
	assertEquals(navigation?.kind, 'navigation');
	assertEquals(navigation?.payload.blocked, true);
	assertEquals(navigation?.payload.containment, 'request-blocked');
	assertEquals(navigation?.payload.committed, false);
	assertEquals(navigation?.payload.origin, 'https://idp.evil.test');
	assertEquals(navigation?.payload.path, '/callback');
	assertEquals(navigation?.payload.has_query, true);
	assertEquals(navigation?.payload.frame_id, TOP);
	assertEquals(navigation?.tab_id, TOP);
	assert(!JSON.stringify(records).includes('Zq8-E0-CODE'), 'a token reached the ring');
	// The log names the origin only (E-78), and says what happened.
	assertEquals(f.infos.length, 1);
	assertStringIncludes(f.infos[0] ?? '', 'document request refused before it was sent');
	assertStringIncludes(f.infos[0] ?? '', 'https://idp.evil.test');
	assert(!(f.infos[0] ?? '').includes('/callback'), f.infos[0]);
	// What `blockedSince` reads: origin only.
	assertEquals(f.record.documentBlocks, [
		{ targetId: TOP, frameId: TOP, origin: 'https://idp.evil.test', at: 50_000, chainHost: null },
	]);
});

Deno.test('R3 (F25): a frame’s block keeps its frame id, and only a main-frame block answers blockedSince', async () => {
	await using f = await fixture();
	await f.bus.dispatch(e0('https://frame.evil.test/x', TOP, 'F-child'));
	await f.bus.dispatch(e0('https://popup.evil.test/x', 'T-popup'));
	assertEquals(ring(f.record).map((record) => record.payload.frame_id), ['F-child', 'T-popup']);
	assertEquals(blockedSince(f.record, TOP, 0), null, 'a child frame is not the tab’s own navigation');
	assertEquals(blockedSince(f.record, 'T-popup', 0), 'https://popup.evil.test');
	assertEquals(blockedSince(f.record, null, 0), null);
	f.advance(10);
	await f.bus.dispatch(e0('https://top.evil.test/x'));
	assertEquals(blockedSince(f.record, TOP, 50_005), 'https://top.evil.test');
	assertEquals(blockedSince(f.record, TOP, 50_011), null, 'a block before `since` is not this navigation’s');
});

Deno.test('R3: the session remembers at most DOCUMENT_BLOCK_MEMORY blocks, newest last', async () => {
	await using f = await fixture();
	for (let index = 0; index < DOCUMENT_BLOCK_MEMORY + 4; index++) {
		await f.bus.dispatch(e0(`https://n${index}.evil.test/`));
	}
	assertEquals(f.record.documentBlocks.length, DOCUMENT_BLOCK_MEMORY);
	assertEquals(f.record.documentBlocks.at(-1)?.origin, `https://n${DOCUMENT_BLOCK_MEMORY + 3}.evil.test`);
	assertEquals(DOCUMENT_BLOCK_MEMORY, 16);
});

async function toolError(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
	const error = await assertRejects(run);
	assert(isToolError(error), String(error));
	return { code: error.code, message: error.message };
}

Deno.test('R3 (AC1): browser_navigate through a refused redirect answers navigation-blocked, origin only', async () => {
	await using f = await fixture();
	// The browser's own answer to a refused hop: the navigation fails with ERR_ABORTED, after E0 was reported.
	f.bus.on(NavigateToUrlEvent, async (event) => {
		await f.bus.dispatch(e0(OFF));
		throw new Error(`navigation to ${event.url} failed: net::ERR_ABORTED`);
	});
	const refused = await toolError(() => browserNavigate({ url: 'https://example.com/redirect?to=x' }, f.ctx));
	assertEquals(refused, {
		code: 'navigation-blocked',
		message: "navigation-blocked: https://idp.evil.test is not in the server's allowed-domain list",
	});
});

Deno.test('R3: the success path is checked too — a block during the tool’s navigation is its answer', async () => {
	await using f = await fixture();
	f.bus.on(NavigateToUrlEvent, async () => {
		await f.bus.dispatch(e0(OFF));
	});
	assertEquals(
		(await toolError(() => browserNavigate({ url: 'https://example.com/' }, f.ctx))).code,
		'navigation-blocked',
	);
});

Deno.test('R3 (F25): a frame’s block does not turn the tool’s own failure into navigation-blocked', async () => {
	await using f = await fixture();
	f.bus.on(NavigateToUrlEvent, async () => {
		await f.bus.dispatch(e0(OFF, TOP, 'F-child'));
		throw new Error('navigation failed: net::ERR_CONNECTION_REFUSED');
	});
	assertEquals(
		(await toolError(() => browserNavigate({ url: 'https://example.com/' }, f.ctx))).code,
		'browser-unavailable',
	);
});

Deno.test('R3: browser_go_back whose history entry is refused answers navigation-blocked', async () => {
	await using f = await fixture();
	f.bus.on(GoBackEvent, async () => {
		await f.bus.dispatch(e0(OFF));
		throw new Error('net::ERR_ABORTED');
	});
	const refused = await toolError(() => browserGoBack({}, f.ctx));
	assertEquals(refused.code, 'navigation-blocked');
	assert(!refused.message.includes('/callback'), refused.message);
});

Deno.test('R3 (F23): browser_download {url} checks right after dispatch, on the ERR_ABORTED swallow path too', async () => {
	await using f = await fixture();
	f.bus.on(NavigateToUrlEvent, async () => {
		await f.bus.dispatch(e0('https://files.evil.test/export.csv?sig=Zq8'));
		throw new Error('navigation failed: net::ERR_ABORTED');
	});
	const started = Date.now();
	const refused = await toolError(() => browserDownload({ url: 'https://example.com/redirect' }, f.ctx));
	assertEquals(refused, {
		code: 'navigation-blocked',
		message:
			"navigation-blocked: the download resolved to https://files.evil.test, which is not in the server's allowed-domain list",
	});
	assert(Date.now() - started < 2_000, 'answered at once, not after the detection window');
	assertEquals(f.record.files.list(), [], 'no ledger row: nothing reached the network');
});

// ---------------------------------------------------------------------------
// Review R2-2: a tool answers navigation-blocked only for its own request chain
// ---------------------------------------------------------------------------

Deno.test('R2-2: browser_navigate to an on-list page whose script leaves at once succeeds — the block is the page’s', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	// What Chrome 154 does for `/auto` (tests/.scratch/fxb_probe_base.log, L6): the tool's navigation commits, then the
	// landed page's own `location.href = <off-list>` is refused before it is sent.
	f.bus.on(NavigateToUrlEvent, async (event) => {
		f.advance(5);
		client.commit(event.url);
		f.advance(5);
		await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: OFF, resourceType: 'Document' }));
	});
	const result = await browserNavigate({ url: 'https://example.com/auto' }, f.ctx);
	assert(result.isError !== true, JSON.stringify(result));
	// The block is still on the ring — visible, just not the tool's failure.
	const blocked = ring(f.record).filter((record) => record.payload.blocked === true);
	assertEquals(blocked.length, 1);
	assertEquals(blocked[0]?.payload.containment, 'request-blocked');
});

Deno.test('R2-2: the tool’s own refused redirect hop still answers navigation-blocked (no commit, its chain)', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	f.bus.on(NavigateToUrlEvent, async (event) => {
		f.advance(5);
		await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: event.url, resourceType: 'Document' }));
		throw new Error(`navigation to ${event.url} failed: net::ERR_ABORTED`);
	});
	const refused = await toolError(() => browserNavigate({ url: 'https://example.com/redirect?to=x' }, f.ctx));
	assertEquals(refused.message, "navigation-blocked: https://idp.evil.test is not in the server's allowed-domain list");
});

Deno.test('R2-2: a page spinning blocked navigations does not fail a tool navigation that is in flight', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	// The previous page's script keeps trying to leave while the tool's (failing for another reason) navigation runs:
	// those chains began off-list, not at the URL the tool asked for.
	f.bus.on(NavigateToUrlEvent, async () => {
		f.advance(5);
		await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: OFF, resourceType: 'Document' }));
		throw new Error('navigation failed: net::ERR_CONNECTION_REFUSED');
	});
	assertEquals(
		(await toolError(() => browserNavigate({ url: 'https://example.com/' }, f.ctx))).code,
		'browser-unavailable',
	);
});

Deno.test('R2-2: blockedSince — a commit after `since` ends the tool’s chain; a chain begun elsewhere is not the tool’s', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	f.advance(10);
	await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: 'https://example.com/start' }));
	assertEquals(blockedSince(f.record, TOP, 50_000, 'https://example.com/start'), 'https://idp.evil.test');
	assertEquals(blockedSince(f.record, TOP, 50_000, 'http://EXAMPLE.com:8080/other'), 'https://idp.evil.test', 'host');
	assertEquals(blockedSince(f.record, TOP, 50_000, 'https://other.example.org/'), null, 'another chain');
	assertEquals(blockedSince(f.record, TOP, 50_000), 'https://idp.evil.test', 'no URL: the commit rule alone');
	f.advance(10);
	client.commit('https://example.com/start');
	assertEquals(blockedSince(f.record, TOP, 50_000), null, 'the tab committed after since');
	assertEquals(f.record.commits.get(TOP), 50_020);
	// A child frame's commit is not the tab's.
	client.emit('Page.frameNavigated', {
		frame: {
			id: 'F-child',
			parentId: TOP,
			loaderId: 'L',
			url: 'https://example.com/f',
			securityOrigin: '',
			mimeType: '',
		},
	});
	assertEquals(f.record.commits.has('F-child'), false);
});

Deno.test('R2-1: a refused speculative request is recorded but never answers a tool', async () => {
	await using f = await fixture();
	await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: OFF, resourceType: 'Prefetch' }));
	assertEquals(ring(f.record).filter((record) => record.payload.blocked === true).length, 1);
	assertEquals(f.record.documentBlocks, []);
	assertEquals(blockedSince(f.record, TOP, 0), null);
});

Deno.test('R2-1: the commit check’s E2 is one blocked, committed record parked on about:blank', async () => {
	await using f = await fixture();
	await f.bus.dispatch(
		new BrowserErrorEvent({
			errorType: 'NavigationBlocked',
			message: `Navigation to ${OFF} is not allowed by the configured domain policy`,
			details: { enforcementPoint: 'E2', url: OFF, targetId: TOP, containment: 'about:blank', trigger: 'commit' },
		}),
	);
	const records = ring(f.record);
	assertEquals(records.length, 1);
	assertEquals(records[0]?.payload.containment, 'about:blank');
	assertEquals(records[0]?.payload.committed, true);
	assert(!JSON.stringify(records).includes('Zq8-E0-CODE'));
	assertEquals(blockedSince(f.record, TOP, 0), null, 'E2 is not a refused request');
});

// ---------------------------------------------------------------------------
// D-138 / D-139 — the request scope on the MCP side: where subresource and hint refusals surface (AC12), the resolver
// layer composed into the launch profile (AC13), and the startup notices (AC8)
// ---------------------------------------------------------------------------

/** What the vendored `SessionManager` dispatches for a refused subresource or hint (ERRATUM(E-114/E-115)). */
function requestBlock(url: string, requestKind: 'subresource' | 'hint', targetId: string = TOP): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: 'NavigationBlocked',
		message: `Request to ${url} is not allowed by the configured domain policy`,
		details: {
			enforcementPoint: 'E0',
			containment: 'request-blocked',
			requestKind,
			url,
			targetId,
			targetType: 'page',
			frameId: targetId,
			resourceType: requestKind === 'hint' ? 'Fetch' : 'Image',
		},
	});
}

for (const requestKind of ['subresource', 'hint'] as const) {
	Deno.test(`D-138 (AC12): a refused ${requestKind} is a log line only — no ring record, no documentBlocks`, async () => {
		await using f = await fixture();
		const changes: unknown[] = [];
		const unwatch = f.registry.watch((change) => void changes.push(change));
		try {
			await f.bus.dispatch(requestBlock(OFF, requestKind));
			assertEquals(ring(f.record), [], 'nothing on the ring');
			assertEquals(f.record.documentBlocks, [], 'nothing blockedSince reads');
			assertEquals(blockedSince(f.record, TOP, 0), null);
			assertEquals(changes, [], 'no page-changed announce');
			// The rate-limited, origin-only info line counts it.
			assertEquals(f.infos.length, 1);
			assertStringIncludes(f.infos[0] ?? '', `request refused before it was sent (${requestKind})`);
			assertStringIncludes(f.infos[0] ?? '', 'https://idp.evil.test');
			assert(!(f.infos[0] ?? '').includes('/callback') && !(f.infos[0] ?? '').includes('Zq8'), f.infos[0]);
		} finally {
			unwatch();
		}
	});
}

Deno.test('D-138 (AC12): request refusals share the block line’s rate limit, and never enter containedNavigations', async () => {
	await using f = await fixture();
	for (let index = 0; index < 10; index++) {
		await f.bus.dispatch(requestBlock(`https://n${index}.evil.test/p.png`, 'subresource'));
	}
	assertEquals(f.infos.length, 1, 'one line per BLOCK_LOG_INTERVAL_MS');
	f.advance(1_000);
	await f.bus.dispatch(requestBlock('https://late.evil.test/p.png', 'subresource'));
	assertEquals(f.infos.length, 2);
	assertStringIncludes(f.infos[1] ?? '', '(10 blocks since the last report)');
	// A refused subresource is not a contained navigation: the session's own completion for that URL is not hidden.
	await f.bus.dispatch(
		new NavigationCompleteEvent({ targetId: TOP as never, url: 'https://late.evil.test/p.png' }),
	);
	assertEquals(ring(f.record).filter((record) => record.payload.blocked === true), []);
});

Deno.test('D-138 (AC12): a document E0 next to request refusals is still one record that answers blockedSince', async () => {
	await using f = await fixture();
	await f.bus.dispatch(requestBlock('https://img.evil.test/p.png', 'subresource'));
	await f.bus.dispatch(e0(OFF));
	await f.bus.dispatch(requestBlock('https://pf.evil.test/x', 'hint'));
	assertEquals(ring(f.record).length, 1);
	assertEquals(blockedSince(f.record, TOP, 0), 'https://idp.evil.test');
});

const PROFILE_BASE = {
	headless: true,
	downloadsDir: '/data/downloads/x',
	browserPath: null,
	userDataDir: null,
	storageState: null,
	chromiumSandbox: true,
} as const;

Deno.test('D-138 (AC13): all composes exactly one --host-resolver-rules, in the designed order', () => {
	const skipped: string[] = [];
	const allowedDomains = ['Example.com.', '10.0.0.5', '[::1]', '%%bad'];
	const browserArgs = ['--host-resolver-rules=MAP x 127.0.0.1', '--proxy-server=http://p:3128'];
	const expected = 'MAP x 127.0.0.1, EXCLUDE example.com, EXCLUDE *.example.com, EXCLUDE 10.0.0.5, EXCLUDE ::1, ' +
		'EXCLUDE p, MAP * ~NOTFOUND';
	assertEquals(resolverLayerRules(allowedDomains, browserArgs, (message) => void skipped.push(message)), expected);
	assertEquals(skipped.length, 1, 'the unreadable entry is skipped with a warning (F9)');
	assertStringIncludes(skipped[0] ?? '', '"%%bad"');

	const profile = sessionProfile({ ...PROFILE_BASE, allowedDomains, browserArgs, allowedDomainsScope: 'all' });
	assertEquals(profile.args, ['--proxy-server=http://p:3128', `--host-resolver-rules=${expected}`]);
	assertEquals(profile.requestScope, 'all');
	assertEquals(profile.args?.filter((arg) => arg.startsWith('--host-resolver-rules')).length, 1);
});

Deno.test('D-138 (AC13): documents — and an unrestricted deployment — leave the profile byte-identical', () => {
	const browserArgs = ['--host-resolver-rules=MAP x 127.0.0.1', '--proxy-server=http://p:3128'];
	const documents = sessionProfile({ ...PROFILE_BASE, allowedDomains: ['example.com'], browserArgs });
	assertEquals(
		sessionProfile({ ...PROFILE_BASE, allowedDomains: ['example.com'], browserArgs, allowedDomainsScope: 'documents' }),
		documents,
	);
	assertEquals(documents.args, browserArgs);
	assertEquals(documents.requestScope, undefined);
	// `all` over an empty allowlist (which config refuses) changes nothing either: there is no list to scope.
	const open = sessionProfile({ ...PROFILE_BASE, allowedDomains: [], browserArgs, allowedDomainsScope: 'all' });
	assertEquals(open, sessionProfile({ ...PROFILE_BASE, allowedDomains: [], browserArgs }));
	// No operator args at all: the layer is the only one.
	const bare = sessionProfile({
		...PROFILE_BASE,
		allowedDomains: ['example.com'],
		browserArgs: [],
		allowedDomainsScope: 'all',
	});
	assertEquals(bare.args, ['--host-resolver-rules=EXCLUDE example.com, EXCLUDE *.example.com, MAP * ~NOTFOUND']);
});

Deno.test('D-138 (N7): an underscore host is left out of the layer with a warning — it does not resolve (fail closed)', () => {
	const skipped: string[] = [];
	const rules = resolverLayerRules(['my_host.example', 'ok.example'], [], (message) => void skipped.push(message));
	assertEquals(rules, 'EXCLUDE ok.example, EXCLUDE *.ok.example, MAP * ~NOTFOUND');
	assertEquals(skipped.length, 1);
	assertStringIncludes(skipped[0] ?? '', 'my_host.example');
});

Deno.test('D-138 (SB-1): an allowlist entry holding `*` is left out with a warning — it never writes `EXCLUDE *…`', () => {
	// An `EXCLUDE` voids every `MAP` for the hosts it matches (measured, Chrome 154), so `EXCLUDE *` would cancel
	// `MAP * ~NOTFOUND` for every name and `EXCLUDE *.org` for every `.org` name: WebSockets, dns-prefetch and
	// preconnect would silently resolve again under `all`. Such an entry matches nothing in either other layer
	// (`browserAllowedDomains` makes it `*.*…`, which the matcher refuses; `isHostAllowed` compares canonical hosts),
	// so it must match nothing here either.
	for (const wildcard of ['*', '*.org', 'a*b.example']) {
		const skipped: string[] = [];
		const rules = resolverLayerRules(['example.com', wildcard], [], (message) => void skipped.push(message));
		assertEquals(rules, 'EXCLUDE example.com, EXCLUDE *.example.com, MAP * ~NOTFOUND', wildcard);
		assertEquals(skipped.length, 1, wildcard);
		assertStringIncludes(skipped[0] ?? '', JSON.stringify(wildcard));
	}
});

Deno.test('D-138: the last operator --host-resolver-rules wins, and every proxy host of a rule list is excluded', () => {
	const rules = resolverLayerRules(['a.example'], [
		'--host-resolver-rules=MAP old 127.0.0.1',
		'--host-resolver-rules=MAP new 127.0.0.1',
		'--proxy-server=http=p1:3128;https=https://P2:443,direct://',
	]);
	assertEquals(
		rules,
		'MAP new 127.0.0.1, EXCLUDE a.example, EXCLUDE *.a.example, EXCLUDE p1, EXCLUDE p2, MAP * ~NOTFOUND',
	);
	assertEquals(browserArgsUseProxy(['--proxy-pac-url=http://pac/x.pac']), true);
	assertEquals(browserArgsUseProxy(['--proxy-auto-detect']), true);
	assertEquals(browserArgsUseProxy(['--no-proxy-server']), false);
});

Deno.test('D-138: an allowlisted host the operator maps is not excluded — an EXCLUDE would void the operator MAP', () => {
	// Measured on Chrome 154 (request_scope_e2e_test.ts): with `EXCLUDE ttk-site-b.test` after the operator's
	// `MAP ttk-site-b.test 127.0.0.1`, the name stopped resolving at all.
	assertEquals(
		resolverLayerRules(['127.0.0.1', 'ttk-site-b.test'], ['--host-resolver-rules=MAP ttk-site-b.test 127.0.0.1']),
		'MAP ttk-site-b.test 127.0.0.1, EXCLUDE 127.0.0.1, EXCLUDE *.ttk-site-b.test, MAP * ~NOTFOUND',
	);
	// Glob patterns, a port suffix and an operator catch-all are read the way Chromium matches them.
	assertEquals(
		resolverLayerRules(['a.example', 'b.example'], ['--host-resolver-rules=MAP *.a.example:443 10.0.0.1']),
		'MAP *.a.example:443 10.0.0.1, EXCLUDE a.example, EXCLUDE b.example, EXCLUDE *.b.example, MAP * ~NOTFOUND',
	);
	assertEquals(
		resolverLayerRules(['a.example'], ['--host-resolver-rules=MAP * 10.0.0.1']),
		'MAP * 10.0.0.1, MAP * ~NOTFOUND',
		'an operator catch-all admits everything (the documented residual)',
	);
});

function startupWarnings(options: ConstructorParameters<typeof SessionRegistry>[0]): Promise<string[]> {
	const warnings: string[] = [];
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		...options,
		logger: { warn: (message) => void warnings.push(message), info: () => {} },
	});
	return registry.shutdown().then(() => warnings);
}

Deno.test('D-138 (AC8, F11): all with a proxy flag logs the WebSocket caveat once at startup; documents does not', async () => {
	for (const flag of ['--proxy-server=http://p:3128', '--proxy-pac-url=http://pac/p.pac', '--proxy-auto-detect']) {
		const warnings = await startupWarnings({
			allowedDomains: ['example.com'],
			allowedDomainsScope: 'all',
			browserArgs: [flag],
		});
		assertEquals(warnings.filter((message) => message === PROXY_WEBSOCKET_CAVEAT).length, 1, flag);
		assertStringIncludes(PROXY_WEBSOCKET_CAVEAT, 'WebSockets to off-list hosts are not refused');
	}
	assertEquals(
		await startupWarnings({ allowedDomains: ['example.com'], browserArgs: ['--proxy-server=http://p:3128'] }),
		[],
	);
	assertEquals(
		await startupWarnings({ allowedDomains: ['example.com'], allowedDomainsScope: 'all', browserArgs: [] }),
		[],
		'no proxy, no caveat',
	);
});

Deno.test('D-138 (AC13, F9): the registry names an unreadable allowlist entry once at startup, under all only', async () => {
	const all = await startupWarnings({ allowedDomains: ['example.com', '%%bad'], allowedDomainsScope: 'all' });
	assertEquals(all.length, 1);
	assertStringIncludes(all[0] ?? '', '"%%bad"');
	assertEquals(await startupWarnings({ allowedDomains: ['example.com', '%%bad'] }), []);
	// An injected launcher (an edge node, a test) never launches the profile the layer would change.
	assertEquals(
		await startupWarnings({
			allowedDomains: ['%%bad'],
			allowedDomainsScope: 'all',
			browserArgs: ['--proxy-server=http://p:3128'],
			launch: () => Promise.reject(new Error('unused')),
		}),
		[],
	);
});
