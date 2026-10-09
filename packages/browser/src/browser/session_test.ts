/**
 * `BrowserSession` lifecycle + navigation contract tests (ARCHITECTURE.md §7.4, §7.5;
 * COMPLETIONS-CRITERIA.md §3.2 "BrowserSession lifecycle" and "Navigation readiness" rows;
 * SECURITY-AUTH.md §4.2/§4.3 and build decision B-12 / build-run erratum E-3).
 *
 * Everything runs against the real {@linkcode ChromeFixture}: a real `Deno.serve` listener, a real
 * WebSocket, real CDP frames, the real `@tykotech/bus`. Nothing is mocked (D-TEST1).
 */

import { assert, assertEquals, assertInstanceOf, assertRejects } from '@std/assert';
import { delay } from '@std/async';
import { type EventClass, type HandlerContext, silentBusLogger } from '@tykotech/bus';
import {
	AgentFocusChangedEvent,
	BrowserConnectedEvent,
	BrowserErrorEvent,
	BrowserKillEvent,
	BrowserLaunchEvent,
	BrowserReconnectedEvent,
	BrowserStateRequestEvent,
	BrowserStopEvent,
	BrowserStoppedEvent,
	CloseTabEvent,
	NavigateToUrlEvent,
	NavigationCompleteEvent,
	NavigationStartedEvent,
	SwitchTabEvent,
	TabCreatedEvent,
} from '../events.ts';
import { UrlNotAllowedError } from '../errors.ts';
import type { BrowserProfileInit, BrowserStateSummary } from '../types.ts';
import { tabIdFor } from '../types.ts';
import { BrowserSession, CHROME_NEW_TAB_URLS } from './session.ts';
import { ChromeFixture, type ChromeFixtureOptions } from './cdp_fixture_test.ts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const RECORDED_EVENTS: readonly EventClass[] = [
	BrowserConnectedEvent,
	BrowserStoppedEvent,
	BrowserLaunchEvent,
	BrowserKillEvent,
	TabCreatedEvent,
	AgentFocusChangedEvent,
	NavigationStartedEvent,
	NavigationCompleteEvent,
];

interface SessionHarness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly session: BrowserSession;
	readonly log: string[];
	readonly completions: NavigationCompleteEvent[];
}

interface HarnessOptions {
	readonly fixture?: ChromeFixtureOptions | undefined;
	readonly profile?: BrowserProfileInit | undefined;
	readonly connectTimeoutMs?: number | undefined;
	/** Skip `start()` so a test can drive it itself. */
	readonly autoStart?: boolean | undefined;
	/** Attach mode by http(s) URL rather than the `ws://` endpoint. */
	readonly viaHttp?: boolean | undefined;
}

async function sessionHarness(options: HarnessOptions = {}): Promise<SessionHarness> {
	const fixture = ChromeFixture.start(options.fixture ?? {});
	const session = new BrowserSession({
		profile: { cdpUrl: options.viaHttp === true ? fixture.httpUrl : fixture.wsUrl, ...options.profile },
		logger: silentBusLogger,
		...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
	});
	const log: string[] = [];
	const completions: NavigationCompleteEvent[] = [];
	// `wrap: null` keeps the recorder outside the circuit breaker, so it also sees what happens while
	// the transport is down.
	for (const cls of RECORDED_EVENTS) {
		session.eventBus.on(cls, (event) => void log.push(event.eventType), { wrap: null });
	}
	session.eventBus.on(NavigationCompleteEvent, (event) => void completions.push(event), { wrap: null });
	if (options.autoStart !== false) await session.start();
	return {
		fixture,
		session,
		log,
		completions,
		[Symbol.asyncDispose]: async () => {
			await session.stop({ force: true });
			await session.eventBus.stop();
			await fixture.close();
		},
	};
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// §7.4 — the post-connect sequence
// ---------------------------------------------------------------------------

Deno.test('§7.4: the post-connect sequence runs in the speced order', async () => {
	await using h = await sessionHarness({ fixture: { pages: ['https://127.0.0.1/one', 'https://127.0.0.1/two'] } });

	const methods = h.fixture.requests.map((request) => request.method);
	const first = (method: string) => methods.indexOf(method);
	// (1) SessionManager start seeds via getTargets, then switches on push discovery…
	assert(first('Target.getTargets') >= 0);
	assert(first('Target.getTargets') < first('Target.setDiscoverTargets'));
	// (2) …before the root autoAttach that starts the attach cascade.
	assert(first('Target.setDiscoverTargets') < first('Target.setAutoAttach'));
	const rootAutoAttach = h.fixture.requestsFor('Target.setAutoAttach').find((r) => r.sessionId === undefined);
	assertEquals(rootAutoAttach?.params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

	// (5)(7)(8): focus set, then the pre-existing tabs replayed, then the focus announced, and only
	// then is the session declared connected.
	const order = h.log.filter((name) =>
		name === TabCreatedEvent.eventName || name === AgentFocusChangedEvent.eventName ||
		name === BrowserConnectedEvent.eventName
	);
	assertEquals(order, [
		TabCreatedEvent.eventName,
		TabCreatedEvent.eventName,
		AgentFocusChangedEvent.eventName,
		BrowserConnectedEvent.eventName,
	]);
	assert(h.session.agentFocusTargetId !== null);
	assertEquals(h.session.tabs.length, 2);
	assertEquals(h.session.tabs[0]?.tabId, tabIdFor(h.session.tabs[0]?.targetId ?? ''));
});

Deno.test('§7.4 step 3: chrome new-tab pages are redirected to about:blank', async () => {
	await using h = await sessionHarness({ fixture: { pages: ['chrome://newtab'] } });
	const navigated = h.fixture.requestsFor('Page.navigate');
	assertEquals(navigated.length, 1);
	assertEquals(navigated[0]?.params.url, 'about:blank');
	assert(CHROME_NEW_TAB_URLS.includes('chrome://new-tab-page'));
});

Deno.test('§7.4 step 4: a browser with no page targets gets one', async () => {
	await using h = await sessionHarness({ fixture: { pages: [] } });
	assertEquals(h.fixture.requestsFor('Target.createTarget').length, 1);
	assertEquals(h.fixture.requestsFor('Target.createTarget')[0]?.params.url, 'about:blank');
	assert(h.session.agentFocusTargetId !== null);
});

// ---------------------------------------------------------------------------
// launch vs connect convergence (D-BROWSER1)
// ---------------------------------------------------------------------------

Deno.test('attach mode: an http(s) cdpUrl goes through the /json/version handshake', async () => {
	await using h = await sessionHarness({ viaHttp: true });
	assertEquals(h.session.cdpUrl, h.fixture.httpUrl);
	assert(h.session.isConnected);
	// No launch was requested: the browser was already there.
	assertEquals(h.log.includes(BrowserLaunchEvent.eventName), false);
});

Deno.test('launch mode: BrowserLaunchEvent supplies the cdpUrl and the same connect path runs', async () => {
	const fixture = ChromeFixture.start();
	const session = new BrowserSession({ logger: silentBusLogger });
	let launches = 0;
	session.eventBus.on(BrowserLaunchEvent, () => {
		launches += 1;
		return { cdpUrl: fixture.wsUrl };
	}, { wrap: null });
	try {
		const started = await session.start();
		assertEquals(started.cdpUrl, fixture.wsUrl);
		assertEquals(launches, 1);
		assert(session.isConnected);
		assertEquals(session.isLocal, true, 'a launched browser is owned by this process');
		assert(session.sessionManager !== null);
	} finally {
		await session.stop({ force: true });
		await session.eventBus.stop();
		await fixture.close();
	}
});

Deno.test('start() is idempotent, sequentially and concurrently', async () => {
	await using h = await sessionHarness({ autoStart: false });
	const [a, b] = await Promise.all([h.session.start(), h.session.start()]);
	assertEquals(a.cdpUrl, b.cdpUrl);
	const c = await h.session.start();
	assertEquals(c.cdpUrl, a.cdpUrl);
	// One connect only: the target map was seeded exactly once.
	assertEquals(h.fixture.requestsFor('Target.getTargets').length, 1);
	assertEquals(h.log.filter((name) => name === BrowserConnectedEvent.eventName).length, 1);
});

Deno.test('connect() is capped and tears down on timeout so a retry starts clean', async () => {
	const fixture = ChromeFixture.start();
	// A browser that accepts the socket and then never answers: exactly the hang the cap exists for.
	fixture.script('Target.getTargets', () => {});
	const session = new BrowserSession({
		profile: { cdpUrl: fixture.wsUrl },
		logger: silentBusLogger,
		connectTimeoutMs: 150,
	});
	try {
		await assertRejects(() => session.connect(fixture.wsUrl), Error, 'exceeded the 150ms cap');
		assertEquals(session.cdpClient, null, 'the half-built client must be torn down');
		assertEquals(session.sessionManager, null, 'the half-built SessionManager must be torn down');
		assertEquals(session.isConnected, false);
	} finally {
		await session.eventBus.stop();
		await fixture.close();
	}
});

// ---------------------------------------------------------------------------
// stop / kill / reset / keepAlive
// ---------------------------------------------------------------------------

Deno.test('stop() tears the transport down and announces BrowserStoppedEvent', async () => {
	await using h = await sessionHarness();
	await h.session.stop();
	assertEquals(h.session.isConnected, false);
	assertEquals(h.session.sessionManager, null);
	assert(h.log.includes(BrowserStoppedEvent.eventName));
	await h.session.stop(); // idempotent
});

Deno.test('keepAlive makes a non-forced stop a no-op; force overrides it', async () => {
	await using h = await sessionHarness({ profile: { keepAlive: true } });
	await h.session.stop();
	assertEquals(h.session.isConnected, true, 'keepAlive keeps the browser connected');
	assertEquals(h.log.includes(BrowserStoppedEvent.eventName), false);
	await h.session.stop({ force: true });
	assertEquals(h.session.isConnected, false);
	assert(h.log.includes(BrowserStoppedEvent.eventName));
});

Deno.test('kill() force-stops and dispatches BrowserKillEvent', async () => {
	await using h = await sessionHarness({ profile: { keepAlive: true } });
	await h.session.kill();
	assertEquals(h.session.isConnected, false);
	assert(h.log.includes(BrowserKillEvent.eventName));
});

Deno.test('reset() force-stops and starts again on the same profile', async () => {
	await using h = await sessionHarness({ profile: { keepAlive: true } });
	const before = h.session.cdpUrl;
	const after = await h.session.reset();
	assertEquals(after.cdpUrl, before);
	assert(h.session.isConnected);
	assertEquals(h.log.filter((name) => name === BrowserConnectedEvent.eventName).length, 2);
});

Deno.test('the session tears the socket down LAST, so other stop handlers still have one', async () => {
	await using h = await sessionHarness({ autoStart: false });
	let sawConnection: boolean | null = null;
	// Registered *before* `start()` calls `attach()` — which is exactly the ordering rule watchdogs
	// must follow: handlers run in registration order (E-2), and the session closes the socket.
	h.session.eventBus.on(BrowserStopEvent, () => {
		sawConnection = h.session.isConnected;
	}, { wrap: null });
	await h.session.start();
	await h.session.stop();
	assertEquals(sawConnection, true, 'a stop handler registered before the session must still see a live socket');
	assertEquals(h.session.isConnected, false);
});

// ---------------------------------------------------------------------------
// B-12 / E-3 — the security enforcement point
// ---------------------------------------------------------------------------

// A blocked-domain literal used purely as *data*: the point of these tests is that the matcher
// test-policy-allow: refuses it before any CDP call, so nothing ever resolves or fetches it (D-TEST1).
const BLOCKED_URL = 'https://evil.test/steal';

Deno.test('B-12/E-3: a blocked URL is refused by BrowserSession itself, with NO SecurityWatchdog', async () => {
	await using h = await sessionHarness({ profile: { allowedDomains: ['127.0.0.1'] } });

	// The premise of the test: the session is the *only* handler of NavigateToUrlEvent. A regression
	// that moved enforcement into SecurityWatchdog would pass a test that attached one, and fail here.
	assertEquals(h.session.eventBus.handlerCount(NavigateToUrlEvent), 1);

	const handle = h.session.eventBus.dispatch(new NavigateToUrlEvent({ url: BLOCKED_URL }));
	const error = await assertRejects(() => handle.eventResult({ raiseIfAny: true }));
	assertInstanceOf(error, UrlNotAllowedError);
	assertEquals(error.url, BLOCKED_URL);
	assertEquals(h.fixture.requestsFor('Page.navigate').length, 0, 'no CDP navigation may be issued');
	assertEquals(h.completions.length, 0);
});

Deno.test('B-12/E-3: the handler method itself throws, independent of any bus wiring', async () => {
	await using h = await sessionHarness({ profile: { prohibitedDomains: ['evil.test'] } });
	await assertRejects(
		() => h.session.onNavigateToUrlEvent(new NavigateToUrlEvent({ url: BLOCKED_URL })),
		UrlNotAllowedError,
	);
	assertEquals(h.fixture.requestsFor('Page.navigate').length, 0);
});

Deno.test('B-12/E-3 positive control: an allowed URL still navigates', async () => {
	await using h = await sessionHarness({ profile: { allowedDomains: ['127.0.0.1'] } });
	await h.session.eventBus.dispatch(new NavigateToUrlEvent({ url: 'https://127.0.0.1/ok' }));
	assertEquals(h.fixture.requestsFor('Page.navigate').length, 1);
	assertEquals(h.completions.length, 1);
	assertEquals(h.completions[0]?.url, 'https://127.0.0.1/ok');
});

// ---------------------------------------------------------------------------
// navigation
// ---------------------------------------------------------------------------

Deno.test('navigation emits Started → Complete → FocusChanged and clears the state cache', async () => {
	await using h = await sessionHarness();
	await h.session.eventBus.dispatch(new NavigateToUrlEvent({ url: 'https://127.0.0.1/page' }));
	const order = h.log.filter((name) =>
		name === NavigationStartedEvent.eventName || name === NavigationCompleteEvent.eventName ||
		name === AgentFocusChangedEvent.eventName
	);
	assertEquals(order.slice(-3), [
		NavigationStartedEvent.eventName,
		NavigationCompleteEvent.eventName,
		AgentFocusChangedEvent.eventName,
	]);
	assertEquals(h.completions[0]?.loadingStatus, null);
	assertEquals(h.session.cachedBrowserState, null);
});

Deno.test('a readiness timeout is non-fatal and rides on NavigationCompleteEvent.loadingStatus', async () => {
	await using h = await sessionHarness({ fixture: { navigate: { loaderId: 'L1', lifecycle: ['init'] } } });
	await h.session.eventBus.dispatch(
		new NavigateToUrlEvent({ url: 'https://127.0.0.1/slow', waitUntil: 'networkidle', timeoutMs: 60 }),
	);
	assertEquals(h.completions.length, 1);
	assertEquals(h.completions[0]?.errorMessage, null);
	assertEquals(h.completions[0]?.loadingStatus, 'timeout after 0.1s waiting for networkidle (saw: init)');
});

Deno.test('a hard navigation failure reports errorMessage and rethrows', async () => {
	await using h = await sessionHarness({ fixture: { navigate: { errorText: 'net::ERR_CONNECTION_REFUSED' } } });
	const handle = h.session.eventBus.dispatch(new NavigateToUrlEvent({ url: 'https://127.0.0.1/dead' }));
	await assertRejects(() => handle.eventResult({ raiseIfAny: true }));
	assertEquals(h.completions.length, 1);
	assert(h.completions[0]?.errorMessage?.includes('ERR_CONNECTION_REFUSED'));
});

Deno.test('newTab reuses a blank tab and otherwise creates one', async () => {
	await using h = await sessionHarness({ fixture: { pages: ['about:blank'] } });
	const before = h.session.tabs.length;
	await h.session.eventBus.dispatch(new NavigateToUrlEvent({ url: 'https://127.0.0.1/a', newTab: true }));
	assertEquals(h.session.tabs.length, before, 'a blank tab is reused, not duplicated');

	await h.session.eventBus.dispatch(new NavigateToUrlEvent({ url: 'https://127.0.0.1/b', newTab: true }));
	await waitUntil(() => h.session.tabs.length === before + 1, 'the second tab');
	assertEquals(h.fixture.requestsFor('Target.createTarget').length, 1);
});

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

Deno.test('switch/close accept the 4-char tabId as well as the full targetId', async () => {
	await using h = await sessionHarness({ fixture: { pages: ['https://127.0.0.1/a', 'https://127.0.0.1/b'] } });
	const [first, second] = h.session.tabs;
	assert(first !== undefined && second !== undefined);

	const switched = await h.session.eventBus.dispatch(new SwitchTabEvent({ targetId: second.tabId }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(switched, second.targetId);
	assertEquals(h.session.agentFocusTargetId, second.targetId);

	await h.session.eventBus.dispatch(new CloseTabEvent({ targetId: first.targetId }));
	await waitUntil(() => h.session.tabs.length === 1, 'the tab to close');
	assertEquals(h.session.tabs[0]?.targetId, second.targetId);
});

Deno.test('switching to an unknown tab is an error, not a silent focus change', async () => {
	await using h = await sessionHarness();
	const handle = h.session.eventBus.dispatch(new SwitchTabEvent({ targetId: 'ZZZZ' }));
	await assertRejects(() => handle.eventResult({ raiseIfAny: true }), Error, 'no tab matches');
});

// ---------------------------------------------------------------------------
// browser state
// ---------------------------------------------------------------------------

Deno.test('getBrowserStateSummary delegates to the DOM watchdog via BrowserStateRequestEvent', async () => {
	await using h = await sessionHarness();
	let requested: BrowserStateRequestEvent | null = null;
	h.session.eventBus.on(BrowserStateRequestEvent, (event) => {
		requested = event;
		return { url: 'https://127.0.0.1/x', title: 'x', stateError: null } as unknown as BrowserStateSummary;
	}, { wrap: null });

	const summary = await h.session.getBrowserStateSummary({ includeScreenshot: false });
	assertEquals(summary.url, 'https://127.0.0.1/x');
	assertEquals(h.session.cachedBrowserState, summary);
	assertEquals((requested as unknown as BrowserStateRequestEvent | null)?.includeScreenshot, false);
});

Deno.test('G-1: a DOM-less state request never overwrites the index table (E-36)', async () => {
	await using h = await sessionHarness();
	const withDom = {
		url: 'https://127.0.0.1/x',
		title: 'x',
		stateError: null,
		stateToken: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
		domState: { root: null, selectorMap: new Map([[3, {} as never]]) },
	} as unknown as BrowserStateSummary;
	const withoutDom = {
		url: 'https://127.0.0.1/y',
		title: 'y',
		stateError: null,
		stateToken: null,
		domState: { root: null, selectorMap: new Map() },
	} as unknown as BrowserStateSummary;

	let includeDom = true;
	h.session.eventBus.on(BrowserStateRequestEvent, (event) => {
		includeDom = event.includeDom !== false;
		return includeDom ? withDom : withoutDom;
	}, { wrap: null });

	await h.session.getBrowserStateSummary({ includeDom: true });
	assertEquals(h.session.cachedBrowserState?.domState.selectorMap.size, 1);

	// This is the exact call `identify()` issues after every navigation and before every secret
	// substitution. Before E-36 it wrote its empty `selectorMap` over the cache, and the next
	// `browser_click`/`browser_type` carrying an index failed with `unknown-index` for no reason the
	// caller could see.
	const dropped = await h.session.getBrowserStateSummary({ includeDom: false });
	assertEquals(dropped.url, 'https://127.0.0.1/y', 'the DOM-less read still answers the caller');
	assertEquals(h.session.cachedBrowserState?.domState.selectorMap.size, 1, 'the index table was clobbered');
	assertEquals(h.session.cachedBrowserState?.url, 'https://127.0.0.1/x');
});

Deno.test('G-1: a failed state request clears the index table rather than leaving the old page (E-36)', async () => {
	await using h = await sessionHarness();
	const good = {
		url: 'https://127.0.0.1/x',
		title: 'x',
		stateError: null,
		stateToken: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
		domState: { root: null, selectorMap: new Map([[3, {} as never]]) },
	} as unknown as BrowserStateSummary;
	let answer = true;
	const unsubscribe = h.session.eventBus.on(BrowserStateRequestEvent, () => {
		if (!answer) throw new Error('state read failed');
		return good;
	}, { wrap: null });

	await h.session.getBrowserStateSummary();
	assertEquals(h.session.cachedBrowserState?.domState.selectorMap.size, 1);

	// A read that fails means "I do not know what is on the page". Leaving the previous summary
	// standing left `nodeAt` resolving indices from a page the browser had already left.
	answer = false;
	const failed = await h.session.getBrowserStateSummary();
	assert(failed.stateError !== null);
	assertEquals(h.session.cachedBrowserState, null);
	unsubscribe?.();
});

Deno.test('a failed state request yields a non-actionable state, never a throw', async () => {
	await using h = await sessionHarness();
	// No DOMWatchdog is attached, so nothing answers the request.
	const summary = await h.session.getBrowserStateSummary();
	assert(summary.stateError !== null);
	assertEquals(summary.domState.selectorMap.size, 0, 'an empty selectorMap is what blocks stale-index actions');
	assertEquals(summary.screenshot, null);
	assertEquals(summary.browserErrors.length, 1);
	assertEquals(summary.tabs.length, 1);
});

// ---------------------------------------------------------------------------
// auto-reconnect against a real dropped socket
// ---------------------------------------------------------------------------

Deno.test('a dropped socket reconnects to the same endpoint and restores focus', async () => {
	await using h = await sessionHarness({ fixture: { pages: ['https://127.0.0.1/kept'] } });
	const reconnected: BrowserReconnectedEvent[] = [];
	h.session.eventBus.on(BrowserReconnectedEvent, (event) => void reconnected.push(event), { wrap: null });
	const focusBefore = h.session.agentFocusTargetId;

	h.fixture.drop();
	await waitUntil(() => reconnected.length === 1, 'the reconnect to land');
	assertEquals(reconnected[0]?.attempt, 1);
	assert(h.session.isConnected);
	assertEquals(h.session.agentFocusTargetId, focusBefore, 'the previous focus target is restored');
	assert(h.session.cdpClient !== null);
});

Deno.test('an intentional close does not trigger auto-reconnect', async () => {
	await using h = await sessionHarness();
	const reconnected: BrowserReconnectedEvent[] = [];
	h.session.eventBus.on(BrowserReconnectedEvent, (event) => void reconnected.push(event), { wrap: null });
	await h.session.stop();
	await delay(1_300); // longer than the first 1 s backoff would need
	assertEquals(reconnected.length, 0);
	assertEquals(h.session.isConnected, false);
});

// ---------------------------------------------------------------------------
// the handler cancellation contract — ERRATUM(E-52), the BrowserSession half
// ---------------------------------------------------------------------------

/**
 * The context the bus hands a handler, with the signal the test wants.
 *
 * Same shape and the same precedent as `storage_state_test.ts`'s `stopContext`: a `HandlerContext` is
 * a plain value object, so building one directly is a real object, not a mock (D-TEST1).
 */
function handlerContext(signal: AbortSignal, timeoutSec = 10): HandlerContext {
	return { signal, handlerName: 'BrowserSession.probe', timeoutSec };
}

Deno.test('E-52: an abandoned SwitchTabEvent handler issues no CDP at all', async () => {
	await using h = await sessionHarness({ fixture: { pages: ['about:blank', 'about:blank'] } });
	const second = h.fixture.targets[1]?.targetId ?? '';
	// Deltas, not absolutes: `start()`'s §7.4 sequence has already activated the focused tab, and an
	// absolute `=== 0` here would be a test that passes for the wrong reason on the day it breaks.
	const before = h.fixture.requests.length;
	const activatesBefore = h.fixture.requestsFor('Target.activateTarget').length;
	await assertRejects(() =>
		h.session.onSwitchTabEvent(
			new SwitchTabEvent({ targetId: second }),
			handlerContext(AbortSignal.abort(new Error('budget blown'))),
		)
	);
	assertEquals(
		h.fixture.requestsFor('Target.activateTarget').length,
		activatesBefore,
		'a handler the bus has abandoned must not go on activating tabs',
	);
	assertEquals(h.fixture.requests.length, before, 'no CDP command of any kind reached the browser');
});

Deno.test('E-52: an abandoned CloseTabEvent handler never sends Target.closeTarget', async () => {
	await using h = await sessionHarness({ fixture: { pages: ['about:blank', 'about:blank'] } });
	const second = h.fixture.targets[1]?.targetId ?? '';
	await assertRejects(() =>
		h.session.onCloseTabEvent(
			new CloseTabEvent({ targetId: second }),
			handlerContext(AbortSignal.abort(new Error('budget blown'))),
		)
	);
	assertEquals(h.fixture.requestsFor('Target.closeTarget').length, 0);
	assertEquals(h.fixture.targets.length, 2, 'the tab is still open — the close never happened');
});

Deno.test('E-52: an abandoned TabCreatedEvent handler applies no viewport override', async () => {
	await using h = await sessionHarness({ profile: { viewport: { width: 800, height: 600 } } });
	const targetId = h.fixture.targets[0]?.targetId ?? '';
	const before = h.fixture.requestsFor('Emulation.setDeviceMetricsOverride').length;
	// `#applyViewport` swallows its own failures by design (a tab without the override still works), so
	// this handler must decline silently rather than throw.
	await h.session.onTabCreatedEvent(
		new TabCreatedEvent({ targetId, url: 'about:blank' }),
		handlerContext(AbortSignal.abort(new Error('budget blown'))),
	);
	assertEquals(h.fixture.requestsFor('Emulation.setDeviceMetricsOverride').length, before);
});

Deno.test('E-52: an abandoned NavigateToUrlEvent handler never issues Page.navigate', async () => {
	await using h = await sessionHarness();
	await assertRejects(() =>
		h.session.onNavigateToUrlEvent(
			new NavigateToUrlEvent({ url: 'https://127.0.0.1/next' }),
			handlerContext(AbortSignal.abort(new Error('budget blown'))),
		)
	);
	assertEquals(
		h.fixture.requestsFor('Page.navigate').length,
		0,
		'refusing to start is the only honest cancellation for a navigation',
	);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-94) — the allowlist reaches the SessionManager as the E0 document veto
// ---------------------------------------------------------------------------

Deno.test('E-94: an allowlist pauses new targets at the root and hands the E1 matcher down as the document veto', async () => {
	await using h = await sessionHarness({
		fixture: { pages: ['http://127.0.0.1:8080/start'] },
		profile: { allowedDomains: ['127.0.0.1'] },
	});
	const root = h.fixture.requestsFor('Target.setAutoAttach').find((r) => r.sessionId === undefined);
	assertEquals(root?.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	const manager = h.session.sessionManager;
	assert(manager !== null && manager.filtersDocuments);

	const blocks: Record<string, unknown>[] = [];
	h.session.eventBus.on(BrowserErrorEvent, (event) => void blocks.push(event.details), { wrap: null });
	const focus = h.session.agentFocusTargetId ?? '';
	const cdp = await manager.getOrCreateCdpSession(focus, false);
	const pause = (requestId: string, url: string): void =>
		h.fixture.emit('Fetch.requestPaused', {
			requestId,
			frameId: focus,
			resourceType: 'Document',
			request: { url, method: 'GET', headers: {} },
		}, cdp.sessionId);
	pause('ALLOWED', 'http://127.0.0.1:8080/next');
	pause('REFUSED', 'http://localhost:9090/away?code=x');
	await manager.client.send.Browser.getVersion();
	await manager.whenIdle();
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['ALLOWED']);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['REFUSED']);
	assertEquals(blocks.map((details) => details.enforcementPoint), ['E0']);
});

Deno.test('E-94: prohibitedDomains alone arms no document veto — the attach parameters are the donor’s', async () => {
	await using h = await sessionHarness({ profile: { prohibitedDomains: ['localhost'] } });
	const root = h.fixture.requestsFor('Target.setAutoAttach').find((r) => r.sessionId === undefined);
	assertEquals(root?.params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	assertEquals(h.session.sessionManager?.filtersDocuments, false);
	assertEquals(h.fixture.requestsFor('Fetch.enable').length, 0);
});
