/**
 * `CaptchaWatchdog` contract (ARCHITECTURE.md §6.14; COMPLETIONS-CRITERIA.md §3.2 watchdog row 14:
 * "vendor event re-broadcast; `waitIfCaptchaSolving(≤120 s)` called pre-step").
 *
 * Real bus, real `CdpClient`, real vendor `BrowserUse.captchaSolver*` frames over `ChromeFixture` —
 * the same frames a cloud proxy browser sends, which a stock Chromium simply never does.
 */

import { assert, assertEquals } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import {
	BrowserConnectedEvent,
	BrowserStoppedEvent,
	CaptchaSolverFinishedEvent,
	CaptchaSolverStartedEvent,
} from '../events.ts';
import { type BrowserProfileInit, createBrowserProfile } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import {
	CAPTCHA_WAIT_TIMEOUT_ENV,
	CAPTCHA_WAIT_TIMEOUT_MS,
	CaptchaWatchdog,
	resolveCaptchaWaitTimeoutMs,
	shouldAttachCaptchaWatchdog,
	UNKNOWN_CAPTCHA_VENDOR,
} from './captcha.ts';

const PAGE = 'http://127.0.0.1:8080/protected';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly client: CdpClient;
	readonly manager: SessionManager;
	readonly watchdog: CaptchaWatchdog;
	readonly started: CaptchaSolverStartedEvent[];
	readonly finished: CaptchaSolverFinishedEvent[];
	readonly targetId: string;
	clock: { value: number };
	vendor(method: 'captchaSolverStarted' | 'captchaSolverFinished', params: Record<string, unknown>): void;
	settle(): Promise<void>;
}

async function harness(profile: BrowserProfileInit = {}): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages: [PAGE] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'captcha-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();
	const page = manager.mostRecentPageTarget();
	assert(page !== null);
	await manager.getOrCreateCdpSession(page.targetId, false);
	await manager.setAgentFocus(page.targetId, { activate: false, announce: false });
	await manager.whenIdle();

	const clock = { value: 1_000_000 };
	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(profile),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new CaptchaWatchdog(host, { now: () => clock.value, env: () => undefined });
	watchdog.attach();

	const started: CaptchaSolverStartedEvent[] = [];
	const finished: CaptchaSolverFinishedEvent[] = [];
	bus.on(CaptchaSolverStartedEvent, (event) => void started.push(event), { wrap: null });
	bus.on(CaptchaSolverFinishedEvent, (event) => void finished.push(event), { wrap: null });

	const settle = async (): Promise<void> => {
		await client.send.Browser.getVersion();
		await manager.whenIdle();
		await watchdog.whenIdle();
	};

	return {
		fixture,
		bus,
		client,
		manager,
		watchdog,
		started,
		finished,
		targetId: page.targetId,
		clock,
		vendor: (method, params) => fixture.emit(`BrowserUse.${method}`, params),
		settle,
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
// conditional attachment + the timeout ceiling
// ---------------------------------------------------------------------------

Deno.test('captcha: the watchdog is conditional on captchaSolver, which defaults on', () => {
	assertEquals(shouldAttachCaptchaWatchdog({ captchaSolver: true }), true);
	assertEquals(shouldAttachCaptchaWatchdog({ captchaSolver: false }), false);
	assertEquals(createBrowserProfile().captchaSolver, true);
	assertEquals(CAPTCHA_WAIT_TIMEOUT_MS, 120_000);
	assertEquals(CAPTCHA_WAIT_TIMEOUT_ENV, 'TIMEOUT_CaptchaSolverWait');
});

Deno.test('captcha: the wait budget is overridable but never above the 120 s ceiling', () => {
	const none = (): undefined => undefined;
	assertEquals(resolveCaptchaWaitTimeoutMs(undefined, none), CAPTCHA_WAIT_TIMEOUT_MS);
	assertEquals(resolveCaptchaWaitTimeoutMs(5_000, none), 5_000);
	assertEquals(resolveCaptchaWaitTimeoutMs(10 * CAPTCHA_WAIT_TIMEOUT_MS, none), CAPTCHA_WAIT_TIMEOUT_MS);
	assertEquals(resolveCaptchaWaitTimeoutMs(-1, none), 0);
	// The env var is in seconds, per the TIMEOUT_<name> convention.
	assertEquals(resolveCaptchaWaitTimeoutMs(undefined, () => '30'), 30_000);
	assertEquals(resolveCaptchaWaitTimeoutMs(undefined, () => '9999'), CAPTCHA_WAIT_TIMEOUT_MS);
	assertEquals(resolveCaptchaWaitTimeoutMs(undefined, () => 'not-a-number'), CAPTCHA_WAIT_TIMEOUT_MS);
	assertEquals(resolveCaptchaWaitTimeoutMs(undefined, () => ''), CAPTCHA_WAIT_TIMEOUT_MS);
});

Deno.test('captcha: LISTENS_TO is connect + stopped, EMITS is the two §5.1.7 events', async () => {
	await using h = await harness();
	assertEquals(CaptchaWatchdog.LISTENS_TO.map((cls) => cls.eventName), [
		'BrowserConnectedEvent',
		'BrowserStoppedEvent',
	]);
	assertEquals(CaptchaWatchdog.EMITS.map((cls) => cls.eventName), [
		'CaptchaSolverStartedEvent',
		'CaptchaSolverFinishedEvent',
	]);
	assertEquals(h.watchdog.armed, false, 'nothing is registered before connect');
});

// ---------------------------------------------------------------------------
// re-broadcast
// ---------------------------------------------------------------------------

Deno.test('captcha: vendor frames become bus events', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.watchdog.armed, true);

	h.vendor('captchaSolverStarted', {
		targetId: h.targetId,
		vendor: 'cloudflare',
		url: PAGE,
		startedAt: '2026-08-13T10:00:00.000Z',
	});
	await h.settle();

	assertEquals(h.watchdog.solving, true);
	assertEquals(h.started.length, 1);
	assertEquals(h.started[0]?.vendor, 'cloudflare');
	assertEquals(h.started[0]?.targetId, h.targetId);
	assertEquals(h.started[0]?.startedAt, '2026-08-13T10:00:00.000Z');

	h.clock.value += 4_200;
	h.vendor('captchaSolverFinished', { targetId: h.targetId, vendor: 'cloudflare', success: true });
	await h.settle();

	assertEquals(h.watchdog.solving, false);
	assertEquals(h.finished.length, 1);
	assertEquals(h.finished[0]?.success, true);
	assertEquals(h.finished[0]?.durationMs, 4_200, 'a vendor that omits durationMs gets one synthesized');
});

Deno.test('captcha: a payload with nothing but the method still degrades cleanly', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));

	h.vendor('captchaSolverStarted', {});
	await h.settle();

	assertEquals(h.watchdog.currentSolve?.vendor, UNKNOWN_CAPTCHA_VENDOR);
	assertEquals(h.watchdog.currentSolve?.targetId, h.targetId, 'the focused target stands in');
	assertEquals(h.started[0]?.url, PAGE);

	h.vendor('captchaSolverFinished', {});
	await h.settle();
	assertEquals(h.finished[0]?.success, false, 'the event field is boolean and defaults to false');
	assertEquals(h.watchdog.lastResult, null, 'nobody waited, so there is no wait result');
});

Deno.test('captcha: a stock browser that never sends these frames is simply idle', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	await h.settle();
	assertEquals(h.watchdog.solving, false);
	assertEquals(h.started, []);
	assertEquals(await h.watchdog.waitIfCaptchaSolving(), { waited: false, result: 'unknown' });
});

Deno.test('captcha: captchaSolver=false leaves the vendor frames unsubscribed', async () => {
	await using h = await harness({ captchaSolver: false });
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.watchdog.armed, false);
	h.vendor('captchaSolverStarted', { vendor: 'cloudflare' });
	await h.settle();
	assertEquals(h.started, []);
	assertEquals(h.watchdog.solving, false);
});

// ---------------------------------------------------------------------------
// the pre-step wait (AGENT-RUNTIME.md §4 Phase 0)
// ---------------------------------------------------------------------------

Deno.test('captcha: a wait resolves when the vendor finishes, carrying vendor/url/duration', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.vendor('captchaSolverStarted', { targetId: h.targetId, vendor: 'recaptcha', url: PAGE });
	await h.settle();

	const wait = h.watchdog.waitIfCaptchaSolving();
	h.clock.value += 7_000;
	h.vendor('captchaSolverFinished', { targetId: h.targetId, success: true });
	await h.settle();

	assertEquals(await wait, {
		waited: true,
		vendor: 'recaptcha',
		url: PAGE,
		durationMs: 7_000,
		result: 'success',
	});
	assertEquals(h.watchdog.lastResult?.result, 'success');
});

Deno.test('captcha: a failed solve is reported as failed, an unstated one as unknown', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));

	h.vendor('captchaSolverStarted', { vendor: 'v1' });
	await h.settle();
	const failing = h.watchdog.waitIfCaptchaSolving();
	h.vendor('captchaSolverFinished', { success: false });
	await h.settle();
	assertEquals((await failing).result, 'failed');

	h.vendor('captchaSolverStarted', { vendor: 'v2' });
	await h.settle();
	const silent = h.watchdog.waitIfCaptchaSolving();
	h.vendor('captchaSolverFinished', {});
	await h.settle();
	assertEquals((await silent).result, 'unknown', 'a vendor that does not say did not fail');
});

Deno.test('captcha: a solve that never finishes times out at the ceiling', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.vendor('captchaSolverStarted', { vendor: 'stuck', url: PAGE });
	await h.settle();

	using time = new FakeTime();
	const wait = h.watchdog.waitIfCaptchaSolving();
	await time.tickAsync(CAPTCHA_WAIT_TIMEOUT_MS - 1);
	h.clock.value += CAPTCHA_WAIT_TIMEOUT_MS;
	await time.tickAsync(2);

	const result = await wait;
	assertEquals(result.result, 'timeout');
	assertEquals(result.waited, true);
	assertEquals(result.vendor, 'stuck');
});

Deno.test('captcha: an explicit shorter budget is honoured', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.vendor('captchaSolverStarted', { vendor: 'stuck' });
	await h.settle();

	using time = new FakeTime();
	const wait = h.watchdog.waitIfCaptchaSolving({ timeoutMs: 1_500 });
	await time.tickAsync(1_501);
	assertEquals((await wait).result, 'timeout');
});

Deno.test('captcha: an aborted wait ends without raising — the checkpoint owns the interrupt', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.vendor('captchaSolverStarted', { vendor: 'slow' });
	await h.settle();

	const controller = new AbortController();
	const wait = h.watchdog.waitIfCaptchaSolving({ signal: controller.signal });
	controller.abort();
	const result = await wait;
	assertEquals(result.waited, true);
	assertEquals(result.result, 'unknown');
	assertEquals(h.watchdog.solving, true, 'aborting the wait does not cancel the vendor');
});

Deno.test('captcha: a second start supersedes the first so a step cannot be pinned forever', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.vendor('captchaSolverStarted', { vendor: 'first' });
	await h.settle();
	const wait = h.watchdog.waitIfCaptchaSolving();

	h.vendor('captchaSolverStarted', { vendor: 'second' });
	await h.settle();

	assertEquals((await wait).result, 'unknown');
	assertEquals(h.watchdog.currentSolve?.vendor, 'second');
});

Deno.test('captcha: a stopped browser releases waiters instead of hanging the step loop', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.vendor('captchaSolverStarted', { vendor: 'cloudflare' });
	await h.settle();
	const wait = h.watchdog.waitIfCaptchaSolving();

	await h.bus.dispatch(new BrowserStoppedEvent({ reason: 'requested' }));

	assertEquals((await wait).result, 'unknown');
	assertEquals(h.watchdog.armed, false);
	assertEquals(h.watchdog.solving, false);
});
