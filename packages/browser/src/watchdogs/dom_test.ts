/**
 * `DOMWatchdog` contract tests (ARCHITECTURE.md §6.7; COMPLETIONS-CRITERIA.md §3.2 watchdog row 7
 * and the "DOMWatchdog budget" row; DATA-MODEL.md §5.3, §6.3 R6.1–R6.4).
 *
 * What is real here: a real `Deno.serve` CDP endpoint (`ChromeFixture`), a real `CdpClient`, a real
 * `SessionManager`, a real `EventBus` and the real `src/dom/` pipeline. The DOM payloads the fixture
 * serves are the **recorded captures** under `packages/core/fixtures/dom/` — recorded CDP data is
 * data, not a mock (D-TEST1), and replaying it through the socket exercises exactly the code path a
 * browser drives.
 *
 * The five behaviours the completions criteria name, and where each is proved:
 *
 * | Contract | Test |
 * |---|---|
 * | 20 s combined budget | "the budget constants…", "DOM build and the screenshot run in parallel…", "a build that overruns…" |
 * | ≤2 s network probe | "the pending-network probe gives up at the 2 s cap" |
 * | 0.3 s stability pause | "a quiet page still waits the 0.3 s stability window" |
 * | recovery state on failure | "a failed DOM build returns a recovery state carrying browserErrors, never a throw" |
 * | non-actionable state on whole-event timeout | "a whole-event timeout yields a non-actionable state…" |
 */

import { assert, assertEquals, assertGreaterOrEqual, assertLess, assertStringIncludes } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import type { BusLogger } from '@tykotech/bus';
import {
	BrowserStateRequestEvent,
	DialogOpenedEvent,
	NavigateToUrlEvent,
	ScreenshotEvent,
	TypeTextEvent,
} from '../events.ts';
import { createBrowserProfile } from '../types.ts';
import { BrowserSession } from '../browser/session.ts';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import type { DomCapture } from '../dom/extract.ts';
import type { EnhancedDomTreeNode } from '../dom/types.ts';
import {
	detectPaginationButtons,
	DOM_BUILD_BUDGET_MS,
	DOMWatchdog,
	isHttpUrl,
	isPdfViewerUrl,
	isTrackerUrl,
	NETWORK_PROBE_MAX_MS,
	NETWORK_STABILITY_MS,
	PENDING_NETWORK_LIMIT,
	PENDING_NETWORK_STALE_MS,
	RECENT_EVENTS_COUNT,
	STATE_BUDGET_MS,
	summarizeEvent,
	toPageInfo,
	zeroPageInfo,
} from './dom.ts';

// ---------------------------------------------------------------------------
// fixture wiring — a recorded capture, served over a real CDP socket
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = fromFileUrl(new URL('../../fixtures/dom/', import.meta.url));

/**
 * Loads a recorded capture by preference, falling back to whatever the corpus holds.
 *
 * The corpus under `packages/core/fixtures/dom/` is owned by the fixture recorder and its member
 * names have changed once already. These tests care about *a page with interactive elements*, not
 * about a particular page, so they name preferences and degrade to the first available capture
 * rather than breaking every time the corpus is regenerated.
 */
async function loadCapture(preferred: readonly string[]): Promise<DomCapture> {
	const available: string[] = [];
	for await (const entry of Deno.readDir(FIXTURE_ROOT)) {
		if (entry.isFile && entry.name.endsWith('.capture.json')) available.push(entry.name);
	}
	available.sort();
	const chosen = preferred.map((name) => `${name}.capture.json`).find((name) => available.includes(name)) ??
		available[0];
	assert(chosen !== undefined, 'the DOM fixture corpus must contain at least one capture');
	return JSON.parse(await Deno.readTextFile(`${FIXTURE_ROOT}${chosen}`)) as DomCapture;
}

/** A page whose merge yields interactive elements. */
const INTERACTIVE_CAPTURE = ['baseline_button', 'basic-text', 'text_nodes_and_links', 'form_attributes'];

/** A page recorded mid-scroll, so `PageInfo` has non-trivial geometry to reproduce. */
const SCROLLED_CAPTURE = ['scroll_page', 'viewport-scrolled', 'scroll_element'];

/**
 * Teaches the fixture to answer the five capture reads from a recorded session.
 *
 * `Page.getLayoutMetrics` is rebuilt from the recorded `layoutMetrics` so the geometry the watchdog
 * derives `PageInfo` from is the geometry the page actually had when it was recorded.
 */
function serveCapture(fixture: ChromeFixture, capture: DomCapture, options: { delayMs?: number } = {}): void {
	const session = capture.sessions[0];
	assert(session !== undefined, 'the recorded capture must carry at least one session');
	const reply = (request: FixtureRequest, result: unknown): void => {
		if (options.delayMs === undefined) {
			fixture.reply(request.id, result, request.sessionId);
			return;
		}
		setTimeout(() => fixture.reply(request.id, result, request.sessionId), options.delayMs);
	};

	fixture
		.script('DOM.getDocument', (request) => reply(request, { root: session.document }))
		.script('DOMSnapshot.captureSnapshot', (request) => reply(request, session.snapshot))
		.script('Accessibility.getFullAXTree', (request) => reply(request, { nodes: session.axNodes }))
		.script('Runtime.evaluate', (request) => replyEvaluate(fixture, request, session.devicePixelRatio));
	serveLayoutMetrics(fixture, session.layoutMetrics);
}

/** The page title every fixture page reports; the DOM watchdog reads it from the page, not the target. */
const FIXTURE_PAGE_TITLE = 'fixture page';

/**
 * Answers `Runtime.evaluate` the way a page would: `document.title` and `location.href` are strings,
 * the device-pixel probe is a number. One handler, because the fixture keys scripts by CDP method.
 *
 * `location.href` answers with the URL of the target this session belongs to, i.e. a page that agrees
 * with its own target record. The E-30 test is the one that pulls the two apart.
 */
function replyEvaluate(fixture: ChromeFixture, request: FixtureRequest, devicePixelRatio: number): void {
	const expression = String(request.params.expression ?? '');
	const value = expression === 'document.title'
		? FIXTURE_PAGE_TITLE
		: expression === 'location.href'
		? pageUrlFor(fixture, request.sessionId)
		: devicePixelRatio;
	const type = typeof value === 'string' ? 'string' : 'number';
	fixture.reply(request.id, { result: { type, value } }, request.sessionId);
}

/** The URL of the target a session is attached to, as the page itself would report it. */
function pageUrlFor(fixture: ChromeFixture, sessionId: string | undefined): string {
	if (sessionId === undefined) return '';
	return fixture.targets.find((target) => fixture.sessionFor(target.targetId) === sessionId)?.url ?? '';
}

/** Geometry every page has, whether or not the test also serves a recorded DOM. */
const DEFAULT_LAYOUT = {
	scrollX: 0,
	scrollY: 0,
	viewportWidth: 800,
	viewportHeight: 600,
	contentWidth: 800,
	contentHeight: 600,
};

function serveLayoutMetrics(fixture: ChromeFixture, metrics: typeof DEFAULT_LAYOUT): void {
	fixture.script('Page.getLayoutMetrics', (request) =>
		fixture.reply(request.id, {
			layoutViewport: {
				pageX: metrics.scrollX,
				pageY: metrics.scrollY,
				clientWidth: metrics.viewportWidth,
				clientHeight: metrics.viewportHeight,
			},
			visualViewport: {
				offsetX: 0,
				offsetY: 0,
				pageX: metrics.scrollX,
				pageY: metrics.scrollY,
				clientWidth: metrics.viewportWidth,
				clientHeight: metrics.viewportHeight,
				scale: 1,
			},
			contentSize: { x: 0, y: 0, width: metrics.contentWidth, height: metrics.contentHeight },
		}, request.sessionId));
}

/** A connected session plus its DOMWatchdog, torn down together. */
interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly session: BrowserSession;
	readonly watchdog: DOMWatchdog;
	readonly logs: LogRecord[];
}

interface LogRecord {
	readonly level: 'debug' | 'warn' | 'error';
	readonly message: string;
	readonly fields: Record<string, unknown>;
}

function recordingLogger(sink: LogRecord[]): BusLogger {
	return {
		debug: (message, fields) => sink.push({ level: 'debug', message, fields: fields ?? {} }),
		warn: (message, fields) => sink.push({ level: 'warn', message, fields: fields ?? {} }),
		error: (message, fields) => sink.push({ level: 'error', message, fields: fields ?? {} }),
	};
}

async function harness(options: {
	pages?: readonly string[];
	capture?: DomCapture;
	captureDelayMs?: number;
	budgetMs?: number;
	screenshot?: (() => string) | undefined;
} = {}): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages: options.pages ?? ['http://127.0.0.1:1/index.html'] });
	if (options.capture === undefined) {
		serveLayoutMetrics(fixture, DEFAULT_LAYOUT);
		fixture.script('Runtime.evaluate', (request) => replyEvaluate(fixture, request, 1));
	} else {
		serveCapture(
			fixture,
			options.capture,
			options.captureDelayMs === undefined ? {} : { delayMs: options.captureDelayMs },
		);
	}
	const logs: LogRecord[] = [];
	const session = new BrowserSession({
		profile: createBrowserProfile({ cdpUrl: fixture.wsUrl }),
		logger: recordingLogger(logs),
	});
	const watchdog = new DOMWatchdog(session, {
		includeListenerCensus: false,
		...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
	});
	watchdog.attach();
	if (options.screenshot !== undefined) {
		const capture = options.screenshot;
		session.eventBus.on(ScreenshotEvent, () => capture(), { wrap: null });
	}
	await session.start();
	return {
		fixture,
		session,
		watchdog,
		logs,
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await session.stop({ force: true });
			await session.eventBus.stop();
			await fixture.close();
		},
	};
}

function requestState(harness: Harness, init: ConstructorParameters<typeof BrowserStateRequestEvent>[0] = {}) {
	return harness.session.eventBus
		.dispatch(new BrowserStateRequestEvent(init))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
}

// ---------------------------------------------------------------------------
// constants (COMPLETIONS-CRITERIA.md §3.2: "all timing constants encoded verbatim")
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: the ARCHITECTURE §6.7 budget constants are encoded verbatim', () => {
	assertEquals(STATE_BUDGET_MS, 20_000);
	assertEquals(NETWORK_PROBE_MAX_MS, 2_000);
	assertEquals(NETWORK_STABILITY_MS, 300);
	assertEquals(PENDING_NETWORK_LIMIT, 20);
	assertEquals(PENDING_NETWORK_STALE_MS, 10_000);
	assertEquals(RECENT_EVENTS_COUNT, 10);
	// One 20 s, two names: the watchdog's combined budget IS the pipeline's ceiling.
	assertEquals(STATE_BUDGET_MS, DOM_BUILD_BUDGET_MS);
});

Deno.test('dom-watchdog: a watchdog built with no options runs on the 20 s combined budget', async () => {
	const bus = new EventBus({ name: 'dom', logger: silentBusLogger });
	try {
		const watchdog = new DOMWatchdog({
			eventBus: bus,
			profile: createBrowserProfile(),
			logger: silentBusLogger,
			cdpClient: null,
			sessionManager: null,
			cdpUrl: null,
			isLocal: true,
		});
		assertEquals(watchdog.budgetMs, STATE_BUDGET_MS);
	} finally {
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// the probe: ≤2 s cap, 0.3 s stability pause
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: a quiet page still waits the 0.3 s stability window', async () => {
	await using h = await harness({ capture: await loadCapture(INTERACTIVE_CAPTURE) });
	const startedAt = performance.now();
	const state = await requestState(h);
	const elapsed = performance.now() - startedAt;

	assertEquals(state.stateError, null);
	// Nothing is in flight, yet the probe must observe NETWORK_STABILITY_MS of quiet before it calls
	// the page stable — that pause is the contract, not an implementation artefact.
	assertGreaterOrEqual(elapsed, NETWORK_STABILITY_MS);
	assertLess(elapsed, NETWORK_PROBE_MAX_MS);

	const probe = h.logs.find((record) => record.message === 'pending-network probe finished');
	assert(probe !== undefined, 'the probe must run for an http(s) page');
	assertEquals(probe.fields.stable, true);
});

Deno.test('dom-watchdog: the pending-network probe gives up at the 2 s cap', async () => {
	await using h = await harness({ capture: await loadCapture(INTERACTIVE_CAPTURE) });
	const targetId = h.fixture.targets[0]?.targetId;
	assert(targetId !== undefined);
	const sessionId = h.fixture.sessionFor(targetId);
	assert(sessionId !== null);

	// A request that never finishes, re-announced for as long as the state request runs: the quiet
	// window can never elapse, so only the cap can end it. Re-announcing the *same* `requestId` keeps
	// the in-flight set at exactly one entry — this is one hung request, not a flood — and makes the
	// test independent of whether the first announcement crossed the socket before or after the probe
	// registered its listeners, which is a property of how many round trips precede the probe.
	const announce = (): void =>
		h.fixture.emit('Network.requestWillBeSent', {
			requestId: 'REQ-forever',
			loaderId: 'L1',
			documentURL: 'http://127.0.0.1:1/index.html',
			request: {
				url: 'http://127.0.0.1:1/slow.json',
				method: 'GET',
				headers: {},
				initialPriority: 'High',
				referrerPolicy: 'no-referrer',
			},
			timestamp: 1,
			wallTime: 1,
			initiator: {},
			type: 'XHR',
		}, sessionId);
	announce();
	const heartbeat = setInterval(announce, NETWORK_STABILITY_MS / 3);

	const startedAt = performance.now();
	let state;
	try {
		state = await requestState(h);
	} finally {
		clearInterval(heartbeat);
	}
	const elapsed = performance.now() - startedAt;

	const probe = h.logs.find((record) => record.message === 'pending-network probe finished');
	assert(probe !== undefined);
	assertEquals(probe.fields.stable, false, 'a page that never goes quiet cannot be reported stable');
	assertGreaterOrEqual(elapsed, NETWORK_PROBE_MAX_MS - 50);
	assertLess(elapsed, NETWORK_PROBE_MAX_MS * 2, 'the probe is capped, not open-ended');
	assertEquals(state.stateError, null, 'an unstable network is not a failure');

	// The same in-flight request is what `pendingNetworkRequests` reports (§5.3).
	assertEquals(state.pendingNetworkRequests.length, 1);
	assertEquals(state.pendingNetworkRequests[0]?.url, 'http://127.0.0.1:1/slow.json');
	assertEquals(state.pendingNetworkRequests[0]?.resourceType, 'XHR');
});

// ---------------------------------------------------------------------------
// the 20 s combined budget
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: DOM build and the screenshot run in parallel under one budget', async () => {
	let screenshotStartedAt = 0;
	await using h = await harness({
		capture: await loadCapture(INTERACTIVE_CAPTURE),
		captureDelayMs: 250,
		screenshot: () => {
			screenshotStartedAt = performance.now();
			return 'iVBORw0KGgo=';
		},
	});

	const startedAt = performance.now();
	const state = await requestState(h);
	const elapsed = performance.now() - startedAt;

	assertEquals(state.screenshot, 'iVBORw0KGgo=');
	assert(state.domState.selectorMap.size > 0, 'the DOM build must have produced a selector map');
	// The screenshot answered while `DOM.getDocument` was still 250 ms from replying: had the two been
	// sequential, the screenshot could not have started before the DOM build finished.
	const screenshotOffset = screenshotStartedAt - startedAt;
	assertLess(screenshotOffset, elapsed - 200, 'the screenshot must not wait for the DOM build');
	assertLess(elapsed, STATE_BUDGET_MS);
});

Deno.test('dom-watchdog: a build that overruns the budget yields a non-actionable state', async () => {
	const fixture = ChromeFixture.start({ pages: ['http://127.0.0.1:1/index.html'] });
	// `DOM.getDocument` never replies: only the budget can end this request.
	fixture.script('DOM.getDocument', () => {});
	const session = new BrowserSession({
		profile: createBrowserProfile({ cdpUrl: fixture.wsUrl }),
		logger: silentBusLogger,
	});
	const watchdog = new DOMWatchdog(session, { budgetMs: 200, includeListenerCensus: false });
	try {
		watchdog.attach();
		await session.start();
		const state = await session.eventBus
			.dispatch(new BrowserStateRequestEvent({ includeScreenshot: false }))
			.eventResult({ raiseIfAny: true, raiseIfNone: true });

		assert(state.stateError !== null, 'an exhausted budget must set stateError (R6.4)');
		assertStringIncludes(state.stateError, 'budget');
		assertEquals(state.domState.selectorMap.size, 0, 'no stale index may survive a timed-out build');
		assertEquals(state.domState.root, null);
		assert(state.browserErrors.length > 0, 'the reason is carried, not swallowed');
		assertEquals(watchdog.selectorMap.size, 0, 'the cached map is dropped with the state');
	} finally {
		watchdog.detach();
		await session.stop({ force: true });
		await session.eventBus.stop();
		await fixture.close();
	}
});

// ---------------------------------------------------------------------------
// recovery state on failure
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: a failed DOM build returns a recovery state carrying browserErrors, never a throw', async () => {
	const fixture = ChromeFixture.start({ pages: ['http://127.0.0.1:1/index.html'] });
	fixture.script('DOM.getDocument', (request) => {
		fixture.replyError(request.id, { code: -32000, message: 'Could not find node with given id' });
	});
	const session = new BrowserSession({
		profile: createBrowserProfile({ cdpUrl: fixture.wsUrl }),
		logger: silentBusLogger,
	});
	const watchdog = new DOMWatchdog(session, { includeListenerCensus: false });
	try {
		watchdog.attach();
		await session.start();
		const state = await session.eventBus
			.dispatch(new BrowserStateRequestEvent({ includeScreenshot: false }))
			.eventResult({ raiseIfAny: true, raiseIfNone: true });

		// The distinction the spec draws: a *failure* is recoverable and reported through
		// `browserErrors`; only a *timeout* is non-actionable and sets `stateError`.
		assertEquals(state.stateError, null);
		assert(state.browserErrors.length > 0);
		assertStringIncludes(state.browserErrors.join(' '), 'DOM build failed');
		assertEquals(state.domState.selectorMap.size, 0);
		assertEquals(state.url, 'http://127.0.0.1:1/index.html', 'the recovery state still names the page');
	} finally {
		watchdog.detach();
		await session.stop({ force: true });
		await session.eventBus.stop();
		await fixture.close();
	}
});

Deno.test('dom-watchdog: a screenshot failure degrades to browserErrors, not a failed state', async () => {
	await using h = await harness({
		capture: await loadCapture(INTERACTIVE_CAPTURE),
		screenshot: () => {
			throw new Error('capture surface unavailable');
		},
	});
	const state = await requestState(h);
	assertEquals(state.screenshot, null);
	assertEquals(state.stateError, null);
	assertStringIncludes(state.browserErrors.join(' '), 'screenshot failed');
	assert(state.domState.selectorMap.size > 0, 'the DOM half still succeeded');
});

// ---------------------------------------------------------------------------
// non-actionable state on whole-event timeout (ARCHITECTURE.md §6.7, R6.4)
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: a whole-event timeout yields a non-actionable state with an empty selectorMap', async () => {
	// The bus reads `TIMEOUT_<EventClassName>` through an injected source (D-BUS1), so the 30 s
	// default is overridden here without touching the process environment.
	const bus = new EventBus({
		name: 'dom-timeout',
		logger: silentBusLogger,
		env: (name) => (name === 'TIMEOUT_BrowserStateRequestEvent' ? '1' : undefined),
	});
	const session = new BrowserSession({ profile: createBrowserProfile(), bus, logger: silentBusLogger });
	// A handler that never answers, but cooperates with the abort signal so nothing leaks.
	bus.on(BrowserStateRequestEvent, (_event, context) =>
		new Promise<never>((_resolve, reject) => {
			context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		}), { wrap: null });
	try {
		const state = await session.getBrowserStateSummary();
		assert(state.stateError !== null, 'the session synthesizes stateError when the event times out');
		assertEquals(state.domState.selectorMap.size, 0, 'R6.4: no index may outlive its tree');
		assertEquals(state.domState.root, null);
		assertEquals(state.screenshot, null);
		assertEquals(state.browserErrors, [state.stateError]);
		assertEquals(state.pageInfo, zeroPageInfo());
	} finally {
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// the fast path
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: a non-http(s) URL takes the fast path — no DOM build, no probe', async () => {
	await using h = await harness({ pages: ['about:blank'] });
	const state = await requestState(h, { includeScreenshot: false });

	assertEquals(state.domState.root, null);
	assertEquals(state.domState.selectorMap.size, 0);
	assertEquals(state.stateError, null, 'the fast path is empty, not failed');
	assertEquals(state.browserErrors, []);
	assertEquals(h.fixture.requestsFor('DOM.getDocument').length, 0, 'about:blank has no DOM worth building');
	assertEquals(
		h.logs.filter((record) => record.message === 'pending-network probe finished').length,
		0,
		'nothing is loading on about:blank',
	);
	// The live-URL read of ERRATUM(M1-hardening-4) must not turn the fast path into a round trip:
	// `document.title` is the only evaluate a non-http(s) state is allowed to cost.
	assertEquals(
		h.fixture.requestsFor('Runtime.evaluate').filter((request) => request.params.expression === 'location.href')
			.length,
		0,
		'about:blank has no location worth asking for',
	);
	// PageInfo still comes from exactly one `Page.getLayoutMetrics` (ARCHITECTURE.md §6.7).
	assertEquals(h.fixture.requestsFor('Page.getLayoutMetrics').length, 1);
});

Deno.test('dom-watchdog: includeDom=false skips the build even on an http(s) page', async () => {
	await using h = await harness({ capture: await loadCapture(INTERACTIVE_CAPTURE) });
	const state = await requestState(h, { includeDom: false, includeScreenshot: false });
	assertEquals(state.domState.selectorMap.size, 0);
	assertEquals(h.fixture.requestsFor('DOM.getDocument').length, 0);
});

// ---------------------------------------------------------------------------
// E-30 — the summary's url and its domState must describe the same page
// ---------------------------------------------------------------------------

/**
 * The measured shape of E-30: right after a click that navigates, the renderer has committed the new
 * document while `Target.targetInfoChanged` has not arrived yet, so `SessionManager`'s record still
 * names the previous page. Reproduced here by moving the *page* without touching the target record —
 * which is exactly what the lag is.
 */
Deno.test("dom-watchdog: the summary url is the page's own, not the lagging target record (E-30)", async () => {
	const capture = await loadCapture(INTERACTIVE_CAPTURE);
	await using h = await harness({ capture });
	const target = h.fixture.targets[0];
	assert(target !== undefined);
	const lagging = target.url;
	const live = 'http://127.0.0.1:1/submitted?ok=1';
	assert(lagging !== live);

	const devicePixelRatio = capture.sessions[0]?.devicePixelRatio ?? 1;
	h.fixture.script('Runtime.evaluate', (request, self) => {
		if (String(request.params.expression ?? '') !== 'location.href') {
			replyEvaluate(self, request, devicePixelRatio);
			return;
		}
		self.reply(request.id, { result: { type: 'string', value: live } }, request.sessionId);
	});

	const state = await requestState(h, { includeScreenshot: false });

	assertEquals(
		h.session.sessionManager?.targets.get(target.targetId)?.url,
		lagging,
		'the record must still lag, or this test is not reproducing E-30',
	);
	assertEquals(state.url, live, 'the summary reports the page whose DOM it just extracted');
	assert(state.domState.selectorMap.size > 0, "and it is the same summary that carries that page's elements");
	assertEquals(state.isPdfViewer, false, 'the url heuristics run on the live url too');
});

// ---------------------------------------------------------------------------
// assembly: selector map cache, tabs, popups, recent events
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: the selector map is assembled, cached and resolvable by index (R6.3)', async () => {
	await using h = await harness({ capture: await loadCapture(INTERACTIVE_CAPTURE) });
	const state = await requestState(h, { includeScreenshot: false });

	assert(state.domState.selectorMap.size > 0);
	assertEquals(h.watchdog.selectorMap.size, state.domState.selectorMap.size, 'the map is cached on the watchdog');
	assert(h.watchdog.reverseMap.size > 0, 'R6.3 caches the reverse map alongside');
	assert(h.watchdog.serializedText.length > 0);

	const [index, node] = [...state.domState.selectorMap][0] ?? [];
	assert(index !== undefined && node !== undefined);
	assertEquals(h.watchdog.nodeForIndex(index)?.backendNodeId, node.backendNodeId);
	assertEquals(h.watchdog.nodeForIndex(-1), null);

	// R6.1: the LLM index IS the backendNodeId unless it collided.
	assertEquals(index, node.backendNodeId);

	h.watchdog.clearCache();
	assertEquals(h.watchdog.selectorMap.size, 0);
	assertEquals(h.watchdog.cachedState, null);
});

Deno.test('dom-watchdog: tabs, title and PageInfo come from the session manager and one layout read', async () => {
	const capture = await loadCapture(SCROLLED_CAPTURE);
	await using h = await harness({ capture });
	const state = await requestState(h, { includeScreenshot: false });

	assertEquals(state.tabs.length, 1);
	assertEquals(state.tabs[0]?.tabId, state.tabs[0]?.targetId.slice(-4));
	assertEquals(state.title, FIXTURE_PAGE_TITLE, 'the title is read from the page, not from targetInfo');

	const recorded = capture.sessions[0];
	assert(recorded !== undefined);
	assertEquals(state.pageInfo.viewportWidth, recorded.layoutMetrics.viewportWidth);
	assertEquals(state.pageInfo.scrollY, recorded.layoutMetrics.scrollY);
	assertEquals(state.pageInfo.pixelsAbove, Math.round(recorded.layoutMetrics.scrollY));
});

Deno.test('dom-watchdog: auto-handled dialogs surface once as "[type] message"', async () => {
	await using h = await harness({ pages: ['about:blank'] });
	await h.session.eventBus.dispatch(
		new DialogOpenedEvent({ dialogType: 'alert', message: 'saved!', url: 'about:blank' }),
	);
	const first = await requestState(h, { includeScreenshot: false });
	assertEquals(first.closedPopupMessages, ['[alert] saved!']);

	const second = await requestState(h, { includeScreenshot: false });
	assertEquals(second.closedPopupMessages, [], 'a dialog is reported once, not on every step');
});

Deno.test('dom-watchdog: recentEvents is opt-in and never carries typed text (D-SEC2)', async () => {
	await using h = await harness({ pages: ['about:blank'] });
	const off = h.session.eventBus.on(NavigateToUrlEvent, () => {}, { wrap: null });
	try {
		await h.session.eventBus.dispatch(new NavigateToUrlEvent({ url: 'http://127.0.0.1:1/login' }));
	} finally {
		off();
	}

	const without = await requestState(h, { includeScreenshot: false });
	assertEquals(without.recentEvents, null, 'recentEvents is opt-in (§5.3)');

	const with_ = await requestState(h, { includeScreenshot: false, includeRecentEvents: true });
	assert(with_.recentEvents !== null);
	assertStringIncludes(with_.recentEvents, 'NavigateToUrlEvent');
	assertStringIncludes(with_.recentEvents, 'http://127.0.0.1:1/login');
	const parsed = JSON.parse(with_.recentEvents) as unknown[];
	assert(parsed.length <= RECENT_EVENTS_COUNT);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

Deno.test('dom-watchdog: the fast-path and PDF URL heuristics', () => {
	assertEquals(isHttpUrl('http://127.0.0.1:1/x'), true);
	assertEquals(isHttpUrl('https://127.0.0.1:1/x'), true);
	assertEquals(isHttpUrl('about:blank'), false);
	assertEquals(isHttpUrl('chrome://newtab'), false);
	assertEquals(isHttpUrl('file:///tmp/x.html'), false);
	assertEquals(isHttpUrl(''), false);
	assertEquals(isHttpUrl('not a url'), false);

	assertEquals(isPdfViewerUrl('http://127.0.0.1:1/report.PDF'), true);
	assertEquals(isPdfViewerUrl('http://127.0.0.1:1/report.pdf?download=1'), true);
	assertEquals(isPdfViewerUrl('http://127.0.0.1:1/report.html'), false);
	assertEquals(isPdfViewerUrl('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'), true);
	assertEquals(isPdfViewerUrl(''), false);
});

Deno.test('dom-watchdog: tracker URLs are excluded from pendingNetworkRequests', () => {
	// Known-answer table for the host matcher: parsed by `new URL()`, never fetched — the same
	// exemption the url-matcher KATs carry.
	// test-policy-allow: KAT input, not a request.
	assertEquals(isTrackerUrl('https://www.google-analytics.com/collect'), true);
	// test-policy-allow: same — a KAT input, not a request.
	assertEquals(isTrackerUrl('https://stats.g.doubleclick.net/x'), true);
	assertEquals(isTrackerUrl('http://127.0.0.1:1/api/items'), false);
	assertEquals(isTrackerUrl('not a url'), false);
});

Deno.test('dom-watchdog: PageInfo is derived from one getLayoutMetrics, css values winning', () => {
	const info = toPageInfo({
		layoutViewport: { pageX: 0, pageY: 0, clientWidth: 400, clientHeight: 300 },
		contentSize: { width: 400, height: 300 },
		cssLayoutViewport: { pageX: 10, pageY: 200, clientWidth: 800, clientHeight: 600 },
		cssContentSize: { width: 1200, height: 2000 },
	});
	assertEquals(info.viewportWidth, 800);
	assertEquals(info.pageHeight, 2000);
	assertEquals(info.scrollY, 200);
	assertEquals(info.pixelsAbove, 200);
	assertEquals(info.pixelsBelow, 2000 - 200 - 600);
	assertEquals(info.pixelsLeft, 10);
	assertEquals(info.pixelsRight, 1200 - 10 - 800);

	// A page shorter than its viewport reports zero below, never a negative.
	const short = toPageInfo({
		layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
		contentSize: { width: 800, height: 100 },
	});
	assertEquals(short.pageHeight, 600);
	assertEquals(short.pixelsBelow, 0);
});

Deno.test('dom-watchdog: pagination detection matches labels, rel and accessible names', () => {
	const map = new Map<number, EnhancedDomTreeNode>();
	assertEquals(detectPaginationButtons(map), false);

	map.set(1, paginationNode({ 'aria-label': 'Next page' }));
	assertEquals(detectPaginationButtons(map), true);

	assertEquals(detectPaginationButtons(new Map([[1, paginationNode({ rel: 'next' })]])), true);
	assertEquals(detectPaginationButtons(new Map([[1, paginationNode({ title: '»' })]])), true);
	assertEquals(detectPaginationButtons(new Map([[1, paginationNode({ 'aria-label': 'Load more' })]])), true);
	assertEquals(detectPaginationButtons(new Map([[1, paginationNode({ 'aria-label': 'Submit order' })]])), false);
});

Deno.test('dom-watchdog: summarizeEvent emits the envelope plus an allow-list, never typed text', () => {
	const event = new TypeTextEvent({ node: bareNode(), text: 'hunter2', isSensitive: true });
	const summary = summarizeEvent(event);
	assertEquals(summary.eventType, 'TypeTextEvent');
	assert(typeof summary.eventId === 'string');
	assertEquals(Object.values(summary).includes('hunter2'), false, 'D-SEC2: typed text never reaches the prompt');
	assertEquals(JSON.stringify(summary).includes('hunter2'), false);

	const navigation = new NavigateToUrlEvent({ url: 'http://127.0.0.1:1/x' });
	assertEquals(summarizeEvent(navigation).url, 'http://127.0.0.1:1/x');
});

// ---------------------------------------------------------------------------
// node builders (plain IR values — the serializer's own fixtures cover the real trees)
// ---------------------------------------------------------------------------

function bareNode(attributes: Record<string, string> = {}): EnhancedDomTreeNode {
	return {
		nodeId: 1,
		backendNodeId: 1,
		nodeType: 1,
		nodeName: 'A',
		nodeValue: '',
		attributes,
		isScrollable: false,
		isVisible: true,
		absolutePosition: null,
		targetId: 'T1',
		frameId: 'F1',
		sessionId: 'S1',
		parentNode: null,
		childrenNodes: [],
		contentDocument: null,
		axNode: null,
		snapshotNode: null,
		shadowRootType: null,
		shadowRoots: null,
		compoundChildren: [],
		hasJsClickListener: false,
		hiddenElementsInfo: [],
		hasHiddenContent: false,
		uuid: 'u1',
	};
}

function paginationNode(attributes: Record<string, string>): EnhancedDomTreeNode {
	return bareNode(attributes);
}
