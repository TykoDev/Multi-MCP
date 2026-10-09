/**
 * `SecurityWatchdog` contract (ARCHITECTURE.md §6.2; SECURITY-AUTH.md §4.3; COMPLETIONS-CRITERIA.md
 * §3.2 watchdog row 2: "3 enforcement points: pre-nav block-and-throw, post-nav redirect→about:blank,
 * blocked new-tab close").
 *
 * **Every test here drives the watchdog's own handler.** The bus carries no `BrowserSession` — no
 * `onNavigateToUrlEvent` other than this watchdog's is registered, asserted by `handlerCount === 1`
 * in the first test. That is deliberate: build-run erratum E-3 makes `BrowserSession` refuse the same
 * URL through the same matcher, so a test that dispatched `NavigateToUrlEvent` at an assembled
 * session would stay green with this entire file deleted.
 *
 * Real bus, real `CdpClient`, real `SessionManager`, real CDP frames over `ChromeFixture` (D-TEST1).
 * Every URL is loopback: `localhost` is the allowed host and `127.0.0.1` the blocked one — two
 * genuinely different hostnames to the matcher (M6 vs M8), and no remote name anywhere.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { type BusLogger, EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { BrowserErrorEvent, NavigateToUrlEvent, NavigationCompleteEvent, TabCreatedEvent } from '../events.ts';
import { UrlNotAllowedError } from '../errors.ts';
import { type BrowserProfileInit, createBrowserProfile } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import {
	CONTAINMENT_URL,
	E0_MEMORY_LIMIT,
	E0_MEMORY_MS,
	NAVIGATION_BLOCKED_ERROR,
	SECURITY_CONTAINMENT_TIMEOUT_MS,
	SECURITY_ENFORCEMENT_POINTS,
	SecurityWatchdog,
} from './security.ts';

const ALLOWED = 'http://localhost:8080/dashboard';
const BLOCKED = 'http://127.0.0.1:8080/exfiltrate';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly host: WatchdogHost;
	readonly watchdog: SecurityWatchdog;
	readonly errors: BrowserErrorEvent[];
	sent(method: string): FixtureRequest[];
	/**
	 * Waits for everything the fixture has already written to be processed.
	 *
	 * One CDP round trip is enough: a WebSocket preserves order, so a reply that has arrived proves
	 * every frame the fixture wrote before it has too. Then `whenIdle()` drains the work those frames
	 * started. Deterministic, and not a sleep.
	 */
	settle(): Promise<void>;
}

async function harness(
	profile: BrowserProfileInit = { allowedDomains: ['localhost'] },
	logger: BusLogger = silentBusLogger,
): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages: [ALLOWED] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'security-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();
	const page = manager.mostRecentPageTarget();
	if (page !== null) {
		// Force the attach to completion here rather than letting it land mid-test: a CDP request whose
		// reply arrives after a `FakeTime` install would clear a *real* timer through the *faked*
		// `clearTimeout`, which the op sanitizer reports as a leak far from its cause.
		await manager.getOrCreateCdpSession(page.targetId, false);
		await manager.setAgentFocus(page.targetId, { activate: false, announce: false });
	}
	await manager.whenIdle();

	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(profile),
		logger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new SecurityWatchdog(host);
	watchdog.attach();

	const errors: BrowserErrorEvent[] = [];
	bus.on(BrowserErrorEvent, (event) => void errors.push(event), { wrap: null });

	return {
		fixture,
		bus,
		manager,
		host,
		watchdog,
		errors,
		sent: (method) => fixture.requestsFor(method),
		settle: async () => {
			await client.send.Browser.getVersion();
			await manager.whenIdle();
			await client.send.Browser.getVersion();
			await manager.whenIdle();
		},
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await manager.stop();
			await bus.stop();
			await client.close();
			await fixture.close();
		},
	};
}

// ---------------------------------------------------------------------------
// registration + policy compilation
// ---------------------------------------------------------------------------

Deno.test('security: LISTENS_TO is exactly the enforcement triggers, and nothing else handles them', async () => {
	await using h = await harness();
	// ERRATUM(E-94): `BrowserErrorEvent` carries E0 blocks from SessionManager to this watchdog.
	assertEquals(SecurityWatchdog.LISTENS_TO.map((cls) => cls.eventName), [
		'NavigateToUrlEvent',
		'NavigationCompleteEvent',
		'TabCreatedEvent',
		'BrowserErrorEvent',
	]);
	// The claim the whole file rests on: this watchdog is the only handler of these events here.
	assertEquals(h.bus.handlerCount(NavigateToUrlEvent), 1);
	assertEquals(h.bus.handlerCount(NavigationCompleteEvent), 1);
	assertEquals(h.bus.handlerCount(TabCreatedEvent), 1);
});

Deno.test('security: the policy is compiled once and reused across decisions', async () => {
	await using h = await harness({ allowedDomains: ['localhost', 'ex*mple.com'] });
	const first = h.watchdog.policy;
	h.watchdog.allows(ALLOWED);
	h.watchdog.allows(BLOCKED);
	assert(h.watchdog.policy === first, 'compileDomainPolicy must not run per decision');
	// M3 refusals are reported at compile time, which is why compiling once matters.
	assertEquals(first.warnings.length, 1);
	assertEquals(first.warnings[0]?.pattern, 'ex*mple.com');
});

Deno.test('security: a profile whose domain lists changed recompiles rather than serving a stale policy', async () => {
	await using h = await harness({ allowedDomains: ['localhost'] });
	assertEquals(h.watchdog.allows(BLOCKED), false);
	const first = h.watchdog.policy;

	// What `BrowserSession.#applyLaunchOptions` does with `BrowserStartEvent.launchOptions`.
	h.host.profile.allowedDomains = ['localhost', '127.0.0.1'];

	assert(h.watchdog.policy !== first, 'a changed domain list must be recompiled');
	assertEquals(h.watchdog.allows(BLOCKED), true);
});

// ---------------------------------------------------------------------------
// E1 — pre-navigation veto (SECURITY-AUTH.md §4.3 E1)
// ---------------------------------------------------------------------------

Deno.test('security E1: a blocked pre-navigation dispatches NavigationBlocked and throws', async () => {
	await using h = await harness();
	const handle = h.bus.dispatch(new NavigateToUrlEvent({ url: BLOCKED }));

	const error = await assertRejects(
		() => handle.eventResult({ raiseIfAny: true }),
		UrlNotAllowedError,
		'is not allowed',
	);
	assertEquals(error.url, BLOCKED);
	assertStringIncludes(error.reason, 'pre-navigation veto');

	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.errorType, NAVIGATION_BLOCKED_ERROR);
	assertEquals(h.errors[0]?.details.enforcementPoint, 'E1');
	assertEquals(h.errors[0]?.details.url, BLOCKED);
	assertEquals(h.errors[0]?.details.containment, 'none');

	// A veto is a refusal, not a containment: nothing was navigated or closed.
	assertEquals(h.sent('Page.navigate').length, 0);
	assertEquals(h.sent('Target.closeTarget').length, 0);
	assertEquals(h.watchdog.blocks.map((block) => block.enforcementPoint), ['E1']);
});

Deno.test('security E1: the error event is delivered before the throw surfaces', async () => {
	await using h = await harness();
	const order: string[] = [];
	h.bus.on(BrowserErrorEvent, () => void order.push('error-event'), { wrap: null });

	await h.bus.dispatch(new NavigateToUrlEvent({ url: BLOCKED })).catch(() => void order.push('throw'));

	assertEquals(order, ['error-event', 'throw'], 'the observable signal must not be lost to the throw');
});

Deno.test('security E1: an allowed URL passes silently', async () => {
	await using h = await harness();
	await h.bus.dispatch(new NavigateToUrlEvent({ url: ALLOWED })).eventResult({ raiseIfAny: true });
	assertEquals(h.errors, []);
	assertEquals(h.watchdog.blocks, []);
});

Deno.test('security E1: blockIpAddresses is enforced through the shared matcher', async () => {
	await using h = await harness({ blockIpAddresses: true });
	assertEquals(h.watchdog.allows(ALLOWED), true, 'localhost is a name, not an IP literal');
	await assertRejects(
		() => h.bus.dispatch(new NavigateToUrlEvent({ url: BLOCKED })).eventResult({ raiseIfAny: true }),
		UrlNotAllowedError,
	);
	// The obfuscated-encoding table is the url-matcher suite's job; this only proves the wiring.
	// test-policy-allow: a known-answer input for the hex-IP form of 127.0.0.1, never fetched
	assertEquals(h.watchdog.allows('http://0x7f000001/'), false);
});

// ---------------------------------------------------------------------------
// E2 — post-navigation containment (redirects, JS navigations)
// ---------------------------------------------------------------------------

Deno.test('security E2: a redirect that lands on a blocked URL is driven to about:blank', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	assert(targetId !== '');

	// No throw: this is a notification the session awaits, and rejecting it would report a completed
	// navigation as failed.
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));

	const navigations = h.sent('Page.navigate');
	assertEquals(navigations.length, 1);
	assertEquals(navigations[0]?.params.url, CONTAINMENT_URL);
	assertEquals(navigations[0]?.sessionId, h.manager.sessions.keys().next().value);

	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.errorType, NAVIGATION_BLOCKED_ERROR);
	assertEquals(h.errors[0]?.details.enforcementPoint, 'E2');
	assertEquals(h.errors[0]?.details.containment, CONTAINMENT_URL);
	assertEquals(h.errors[0]?.details.targetId, targetId);
});

Deno.test('security: ERRATUM(E-78) a block is logged by origin only, at debug — the event keeps the URL', async () => {
	const lines: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = [];
	const capture: BusLogger = {
		debug: (message, fields) => void lines.push({ level: 'debug', message, fields }),
		warn: (message, fields) => void lines.push({ level: 'warn', message, fields }),
		error: (message, fields) => void lines.push({ level: 'error', message, fields }),
	};
	await using h = await harness(undefined, capture);
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	assert(targetId !== '');
	// The off-allowlist OAuth redirect: the code in the query is the credential the containment protects.
	const landed = 'http://127.0.0.1:8080/callback?code=Zq8-OAUTH-CODE-3vP#state';
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: landed }));

	assertEquals(h.errors[0]?.details.url, landed, 'the in-process event still carries the URL for the host');
	const block = lines.filter((line) => line.message.includes('navigation blocked'));
	assertEquals(block.length, 1);
	assertEquals(block[0]?.level, 'debug', 'the host logs the block at its own level; this line is not a warning');
	assertEquals(block[0]?.fields?.origin, 'http://127.0.0.1:8080');
	const written = JSON.stringify(lines);
	assert(!written.includes('Zq8-OAUTH-CODE'), `a token reached the log: ${written}`);
	assert(!written.includes('/callback'), `a path reached the log: ${written}`);
});

Deno.test('security E2: an allowed landing URL is left alone', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: ALLOWED }));
	assertEquals(h.sent('Page.navigate').length, 0);
	assertEquals(h.errors, []);
});

Deno.test('security E2: a containment that fails is reported as failed, still without throwing', async () => {
	await using h = await harness();
	h.fixture.script('Page.navigate', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Cannot navigate to invalid URL' });
	});
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';

	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));

	assertEquals(h.errors[0]?.details.containment, 'failed');
	assertEquals(h.watchdog.blocks[0]?.containment, 'failed');
});

Deno.test('security E2: a containment call that hangs is capped, not left to blow the event budget', async () => {
	await using h = await harness();
	h.fixture.script('Page.navigate', () => {
		// Deliberately never replies: the cap is the only thing that can end this.
	});
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';

	using time = new FakeTime();
	const done = h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));
	await time.tickAsync(SECURITY_CONTAINMENT_TIMEOUT_MS - 1);
	assertEquals(h.errors.length, 0, 'the cap has not elapsed yet');
	await time.tickAsync(2);
	await done;

	assertEquals(SECURITY_CONTAINMENT_TIMEOUT_MS, 5_000);
	assertEquals(h.errors[0]?.details.containment, 'failed');
});

// ---------------------------------------------------------------------------
// E3 — new-tab containment (window.open)
// ---------------------------------------------------------------------------

Deno.test('security E3: a tab that opens on a blocked URL is closed', async () => {
	await using h = await harness();
	// The realistic path: the fixture opens a tab, SessionManager announces it, this watchdog is the
	// only `TabCreatedEvent` handler on the bus, and it closes it.
	const opened = h.fixture.addPage(BLOCKED);
	await h.settle();

	const closes = h.sent('Target.closeTarget');
	assert(closes.length >= 1, 'the blocked tab must be closed');
	assertEquals(new Set(closes.map((request) => request.params.targetId)), new Set([opened]));
	assertEquals(h.errors[0]?.details.enforcementPoint, 'E3');
	assertEquals(h.errors[0]?.details.containment, 'tab-closed');
	// Closed, not merely blanked: a `window.open` onto a blocked origin leaves no tab behind.
	assertEquals(h.sent('Page.navigate').length, 0);
});

Deno.test('security E3: an allowed new tab survives', async () => {
	await using h = await harness();
	h.fixture.addPage(ALLOWED);
	await h.settle();
	assertEquals(h.sent('Target.closeTarget').length, 0);
	assertEquals(h.errors, []);
});

Deno.test('security E3: ERRATUM(E-79) Chrome’s own *.top-chrome UI targets are left alone; other chrome: pages are not', async () => {
	await using h = await harness();
	// Measured at browser close on real Chrome: the omnibox popup and a sub-page of it, as page targets.
	h.fixture.addPage('chrome://omnibox-popup.top-chrome/');
	h.fixture.addPage('chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html');
	await h.settle();
	assertEquals(h.sent('Target.closeTarget').length, 0, 'browser UI is not web content to contain');
	assertEquals(h.errors, []);

	// The exemption is the `.top-chrome` host, not the scheme: any other chrome: page is still judged.
	const settings = h.fixture.addPage('chrome://settings/');
	await h.settle();
	// A Set, as in the E3 test above: the fixture announces a new tab from two CDP events.
	assertEquals(new Set(h.sent('Target.closeTarget').map((request) => request.params.targetId)), new Set([settings]));
	assertEquals(h.errors[0]?.details.enforcementPoint, 'E3');
});

Deno.test('security E3: about:blank is never contained — the agent must be able to park', async () => {
	await using h = await harness();
	const opened = h.fixture.addPage('about:blank');
	await h.settle();
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId: opened, url: 'about:blank' }));
	assertEquals(h.sent('Target.closeTarget').length, 0);
	assertEquals(h.errors, []);
});

// ---------------------------------------------------------------------------
// all three, one policy
// ---------------------------------------------------------------------------

Deno.test('security: prohibitedDomains drives the same three points as allowedDomains', async () => {
	await using h = await harness({ prohibitedDomains: ['127.0.0.1'] });
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';

	await assertRejects(
		() => h.bus.dispatch(new NavigateToUrlEvent({ url: BLOCKED })).eventResult({ raiseIfAny: true }),
		UrlNotAllowedError,
	);
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));
	h.fixture.addPage(BLOCKED);
	await h.settle();

	assertEquals(
		new Set(h.watchdog.blocks.map((block) => block.enforcementPoint)),
		new Set(['E1', 'E2', 'E3']),
		'one policy, all three enforcement points',
	);
	assertEquals(new Set(h.errors.map((event) => event.errorType)), new Set([NAVIGATION_BLOCKED_ERROR]));
	// An unrestricted profile stays unrestricted: no allowlist, no prohibition, everything passes.
	assertEquals(h.watchdog.allows(ALLOWED), true);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-94) — E0's aftermath: one block, one record; a never-committed pop-up is closed
// ---------------------------------------------------------------------------

/** What `SessionManager` dispatches for a document it refused before sending it. */
function e0(targetId: string, url: string, frameId: string = targetId): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: NAVIGATION_BLOCKED_ERROR,
		message: `Navigation to ${url} is not allowed by the configured domain policy`,
		details: { enforcementPoint: 'E0', url, targetId, frameId, containment: 'request-blocked' },
	});
}

Deno.test('security E0: the vocabulary carries E0 and request-blocked', () => {
	assertEquals([...SECURITY_ENFORCEMENT_POINTS], ['E0', 'E1', 'E2', 'E3']);
	assertEquals(E0_MEMORY_MS, 5_000);
	assertEquals(E0_MEMORY_LIMIT, 64);
});

Deno.test('security E0: a refused document suppresses E2 for the same navigation — one block, one record', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.bus.dispatch(e0(targetId, BLOCKED));
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));
	assertEquals(h.sent('Page.navigate').length, 0, 'the tab kept its document; there is nothing to park');
	assertEquals(h.errors.map((event) => event.details.enforcementPoint), ['E0']);
	assertEquals(h.watchdog.blocks.map((block) => [block.enforcementPoint, block.containment]), [
		['E0', 'request-blocked'],
	]);
	// A committed tab is not closed either: the request was refused, not the tab.
	assertEquals(h.sent('Target.closeTarget').length, 0);
});

Deno.test('security E0: a different blocked URL on the same tab is still E2’s to contain', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.bus.dispatch(e0(targetId, BLOCKED));
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: `${BLOCKED}/elsewhere` }));
	assertEquals(h.sent('Page.navigate').length, 1);
	assertEquals(h.errors.map((event) => event.details.enforcementPoint), ['E0', 'E2']);
});

Deno.test('security E0: a pop-up whose first document was refused is closed, and E3 adds nothing', async () => {
	await using h = await harness();
	// Chrome's "created, never navigated" state (E-16): the target reports url ''.
	const popup = h.fixture.addPage('');
	await h.settle();
	await h.bus.dispatch(e0(popup, BLOCKED));
	await h.settle();
	assertEquals(h.sent('Target.closeTarget').map((request) => request.params.targetId), [popup]);
	assertEquals(h.errors.map((event) => event.details.enforcementPoint), ['E0']);
	assertEquals(h.watchdog.blocks.map((block) => block.enforcementPoint), ['E0']);
});

Deno.test('security E0: a frame’s refused document closes nothing', async () => {
	await using h = await harness();
	const popup = h.fixture.addPage('');
	await h.settle();
	await h.bus.dispatch(e0(popup, BLOCKED, 'CHILD-FRAME'));
	await h.settle();
	assertEquals(h.sent('Target.closeTarget').length, 0);
});

Deno.test('security E0: E3 is suppressed for a target E0 already recorded', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.bus.dispatch(e0(targetId, BLOCKED));
	await h.bus.dispatch(new TabCreatedEvent({ targetId, url: BLOCKED }));
	assertEquals(h.sent('Target.closeTarget').length, 0);
	assertEquals(h.errors.map((event) => event.details.enforcementPoint), ['E0']);
});

Deno.test('security E0: the suppression lasts E0_MEMORY_MS and no longer', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	using time = new FakeTime();
	await h.bus.dispatch(e0(targetId, BLOCKED));
	time.tick(E0_MEMORY_MS + 1);
	const done = h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));
	await time.runMicrotasks();
	await time.tickAsync(1);
	await done;
	assertEquals(h.sent('Page.navigate').length, 1, 'an old block no longer speaks for a new navigation');
	assertEquals(h.errors.map((event) => event.details.enforcementPoint), ['E0', 'E2']);
});

// ---------------------------------------------------------------------------
// Review R2-1 — the main-frame commit check's E2: one record, and this watchdog stands down for that tab
// ---------------------------------------------------------------------------

/** What `SessionManager`'s commit check dispatches after parking a tab. */
function commitPark(targetId: string, url: string): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: NAVIGATION_BLOCKED_ERROR,
		message: `Navigation to ${url} is not allowed by the configured domain policy`,
		details: { enforcementPoint: 'E2', url, targetId, containment: 'about:blank', trigger: 'commit' },
	});
}

Deno.test('security R2-1: the commit check’s E2 is recorded here once', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.bus.dispatch(commitPark(targetId, BLOCKED));
	assertEquals(h.watchdog.blocks.map((block) => [block.enforcementPoint, block.containment]), [
		['E2', CONTAINMENT_URL],
	]);
	assertEquals(h.sent('Page.navigate').length, 0, 'the manager already parked it');
	assertEquals(h.errors.length, 1, 'no second event from the watchdog');
});

Deno.test('security R2-1: E2 and E3 stand down for a tab the commit check parked', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	(h.manager as unknown as { parkedRecently(id: string): boolean }).parkedRecently = (id) => id === targetId;
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId: targetId as never, url: BLOCKED }));
	await h.bus.dispatch(new TabCreatedEvent({ targetId: targetId as never, url: BLOCKED }));
	assertEquals(h.sent('Page.navigate').length, 0);
	assertEquals(h.sent('Target.closeTarget').length, 0);
	assertEquals(h.errors, []);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-116) — a refused subresource or hint is not a navigation (AC11)
// ---------------------------------------------------------------------------

/** What `SessionManager` dispatches for a subresource or hint it refused (ERRATUM(E-114/E-115)). */
function requestBlock(
	targetId: string,
	url: string,
	requestKind: 'subresource' | 'hint',
	frameId: string = targetId,
): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: NAVIGATION_BLOCKED_ERROR,
		message: `Request to ${url} is not allowed by the configured domain policy`,
		details: {
			enforcementPoint: 'E0',
			containment: 'request-blocked',
			requestKind,
			url,
			targetId,
			targetType: 'page',
			frameId,
			resourceType: requestKind === 'hint' ? 'Fetch' : 'Image',
		},
	});
}

for (const requestKind of ['subresource', 'hint'] as const) {
	Deno.test(`security E-116 (AC11): a refused ${requestKind} enters no E0 memory — E2 still contains`, async () => {
		await using h = await harness();
		const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
		await h.bus.dispatch(requestBlock(targetId, BLOCKED, requestKind));
		// The same tab then really lands on the same off-list URL: E2 must not stand down for it.
		await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));
		assertEquals(h.sent('Page.navigate').length, 1, 'E2 drove the tab to about:blank');
		assertEquals(h.watchdog.blocks.map((block) => block.enforcementPoint), ['E2'], 'no E0 record for a request');
	});

	Deno.test(`security E-116 (AC11): a refused ${requestKind} on a never-committed pop-up closes nothing`, async () => {
		await using h = await harness();
		const popup = h.fixture.addPage('');
		await h.settle();
		await h.bus.dispatch(requestBlock(popup, BLOCKED, requestKind));
		await h.settle();
		assertEquals(h.sent('Target.closeTarget').length, 0);
		assertEquals(h.watchdog.blocks, []);
	});

	Deno.test(`security E-116 (AC11): a refused ${requestKind} does not suppress E3`, async () => {
		await using h = await harness();
		const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
		await h.bus.dispatch(requestBlock(targetId, BLOCKED, requestKind));
		await h.bus.dispatch(new TabCreatedEvent({ targetId, url: BLOCKED }));
		assertEquals(h.sent('Target.closeTarget').map((request) => request.params.targetId), [targetId]);
		assertEquals(h.watchdog.blocks.map((block) => block.enforcementPoint), ['E3']);
	});
}

Deno.test('security E-116: an E0 that says requestKind document is still a document', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	const event = e0(targetId, BLOCKED);
	(event.details as Record<string, unknown>).requestKind = 'document';
	await h.bus.dispatch(event);
	await h.bus.dispatch(new NavigationCompleteEvent({ targetId, url: BLOCKED }));
	assertEquals(h.sent('Page.navigate').length, 0);
	assertEquals(h.watchdog.blocks.map((block) => block.enforcementPoint), ['E0']);
});
