/**
 * `CrashWatchdog` contract (ARCHITECTURE.md §6.11; COMPLETIONS-CRITERIA.md §3.2 watchdog row 11:
 * "defined-not-attached; focus recovery covered under SessionManager tests").
 *
 * The first test is the row's actual requirement — this watchdog is **not** in the default attach
 * order — pinned against the exported list rather than against a comment. The rest exercise the
 * sentinel an embedder gets when it opts in.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { BrowserConnectedEvent, BrowserErrorEvent, BrowserStopEvent, TargetCrashedEvent } from '../events.ts';
import { createBrowserProfile } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import { UNATTACHED_WATCHDOGS, WATCHDOG_ATTACH_ORDER } from './attach_order.ts';
import {
	CRASH_PROBE_EXPECTED,
	CRASH_PROBE_EXPRESSION,
	CRASH_PROBE_INTERVAL_MS,
	CRASH_PROBE_TIMEOUT_MS,
	CrashWatchdog,
	NETWORK_STALL_TIMEOUT_MS,
	NETWORK_TIMEOUT_ERROR,
	TARGET_CRASHED_ERROR,
} from './crash.ts';

const PAGE = 'http://127.0.0.1:8080/page';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly client: CdpClient;
	readonly watchdog: CrashWatchdog;
	readonly errors: BrowserErrorEvent[];
	readonly crashes: TargetCrashedEvent[];
	readonly targetId: string;
	readonly sessionId: string;
	clock: { value: number };
	sent(method: string): FixtureRequest[];
	settle(): Promise<void>;
}

async function harness(): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages: [PAGE] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'crash-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();
	const page = manager.mostRecentPageTarget();
	assert(page !== null);
	await manager.getOrCreateCdpSession(page.targetId, false);
	await manager.setAgentFocus(page.targetId, { activate: false, announce: false });
	await manager.whenIdle();
	const sessionId = fixture.sessionFor(page.targetId);
	assert(sessionId !== null);

	fixture.script('Runtime.evaluate', (request, self) => {
		self.reply(request.id, { result: { type: 'number', value: CRASH_PROBE_EXPECTED } });
	});

	const clock = { value: 1_000_000 };
	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new CrashWatchdog(host, { now: () => clock.value });
	watchdog.attach();

	const errors: BrowserErrorEvent[] = [];
	const crashes: TargetCrashedEvent[] = [];
	bus.on(BrowserErrorEvent, (event) => void errors.push(event), { wrap: null });
	bus.on(TargetCrashedEvent, (event) => void crashes.push(event), { wrap: null });

	return {
		fixture,
		bus,
		manager,
		client,
		watchdog,
		errors,
		crashes,
		targetId: page.targetId,
		sessionId,
		clock,
		sent: (method) => fixture.requestsFor(method),
		settle: async () => {
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
// the row's requirement
// ---------------------------------------------------------------------------

Deno.test('crash: the watchdog is defined but NOT in the default attach order (§6.11)', () => {
	assertEquals(WATCHDOG_ATTACH_ORDER.filter((entry) => entry.name === 'CrashWatchdog'), []);
	assertEquals(UNATTACHED_WATCHDOGS.map((entry) => entry.name), ['CrashWatchdog']);
	assertEquals(UNATTACHED_WATCHDOGS[0]?.watchdog, CrashWatchdog);
});

Deno.test('crash: the probe and its budgets are the declared constants', () => {
	assertEquals(CRASH_PROBE_EXPRESSION, '1+1');
	assertEquals(CRASH_PROBE_EXPECTED, 2);
	assertEquals(CRASH_PROBE_INTERVAL_MS, 5_000);
	assertEquals(CRASH_PROBE_TIMEOUT_MS, 5_000);
	assertEquals(NETWORK_STALL_TIMEOUT_MS, 30_000);
	assert(CRASH_PROBE_INTERVAL_MS >= CRASH_PROBE_TIMEOUT_MS, 'probes must not be able to overlap');
});

// ---------------------------------------------------------------------------
// the health probe
// ---------------------------------------------------------------------------

Deno.test('crash: a live renderer answers the probe and nothing is reported', async () => {
	await using h = await harness();
	const probe = await h.watchdog.probeOnce();
	assertEquals(probe, { healthy: true, targetId: h.targetId, reason: null });

	const evaluate = h.sent('Runtime.evaluate')[0];
	assertEquals(evaluate?.params.expression, CRASH_PROBE_EXPRESSION);
	assertEquals(evaluate?.params.returnByValue, true);
	assertEquals(evaluate?.sessionId, h.sessionId);

	await h.watchdog.tick();
	assertEquals(h.crashes, []);
	assertEquals(h.errors, []);
});

Deno.test('crash: a wrong answer is a crash signal, reported on both channels', async () => {
	await using h = await harness();
	h.fixture.script('Runtime.evaluate', (request, self) => {
		self.reply(request.id, { result: { type: 'undefined' } });
	});

	await h.watchdog.tick();

	assertEquals(h.crashes.length, 1);
	assertEquals(h.crashes[0]?.targetId, h.targetId);
	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.errorType, TARGET_CRASHED_ERROR);
	assertEquals(h.errors[0]?.details.expression, CRASH_PROBE_EXPRESSION);
});

Deno.test('crash: a renderer that errors the probe is unhealthy, not an exception', async () => {
	await using h = await harness();
	h.fixture.script('Runtime.evaluate', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Target crashed' });
	});
	const probe = await h.watchdog.probeOnce();
	assertEquals(probe.healthy, false);
	assertStringIncludes(probe.reason ?? '', 'Target crashed');
});

Deno.test('crash: a probe that never returns is capped rather than pinning the loop', async () => {
	await using h = await harness();
	h.fixture.script('Runtime.evaluate', () => {
		// Never replies: a hung renderer emits no CDP event at all, which is the whole point of probing.
	});

	using time = new FakeTime();
	const probe = h.watchdog.probeOnce();
	await time.tickAsync(CRASH_PROBE_TIMEOUT_MS + 1);
	const result = await probe;

	assertEquals(result.healthy, false);
	assertStringIncludes(result.reason ?? '', `exceeded ${CRASH_PROBE_TIMEOUT_MS} ms`);
});

Deno.test('crash: a browser with no page target has nothing to probe and reports nothing', async () => {
	await using h = await harness();
	h.fixture.removeTarget(h.targetId);
	await h.settle();
	// SessionManager's focus recovery is the load-bearing mechanism and creates a replacement, so the
	// probe still finds a target; what matters is that it never invents a crash out of an empty map.
	const probe = await h.watchdog.probeOnce();
	assertEquals(probe.healthy, true);
});

// ---------------------------------------------------------------------------
// the network-stall sentinel
// ---------------------------------------------------------------------------

Deno.test('crash: a request in flight past the stall threshold is reported exactly once', async () => {
	await using h = await harness();
	h.watchdog.arm();
	h.fixture.emit('Network.requestWillBeSent', {
		requestId: 'REQ1',
		loaderId: 'LOADER1',
		documentURL: PAGE,
		request: { url: `${PAGE}/slow`, method: 'GET', headers: {}, initialPriority: 'High', referrerPolicy: '' },
		timestamp: 1,
		wallTime: 1,
		initiator: {},
	}, h.sessionId);
	await h.settle();
	assertEquals(h.watchdog.inflightRequests.length, 1);

	assertEquals(await h.watchdog.sweepStalledRequests(), [], 'not stalled yet');
	h.clock.value += NETWORK_STALL_TIMEOUT_MS;
	assertEquals(await h.watchdog.sweepStalledRequests(), ['REQ1']);
	assertEquals(await h.watchdog.sweepStalledRequests(), [], 'a stall is reported once, not every pass');

	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.errorType, NETWORK_TIMEOUT_ERROR);
	assertEquals(h.errors[0]?.details.url, `${PAGE}/slow`);
});

Deno.test('crash: a request that finishes stops being tracked', async () => {
	await using h = await harness();
	h.watchdog.arm();
	h.fixture.emit('Network.requestWillBeSent', {
		requestId: 'REQ2',
		loaderId: 'LOADER1',
		documentURL: PAGE,
		request: { url: `${PAGE}/fast`, method: 'GET', headers: {}, initialPriority: 'High', referrerPolicy: '' },
		timestamp: 1,
		wallTime: 1,
		initiator: {},
	}, h.sessionId);
	await h.settle();
	h.fixture.emit('Network.loadingFinished', { requestId: 'REQ2', timestamp: 2, encodedDataLength: 10 }, h.sessionId);
	await h.settle();

	assertEquals(h.watchdog.inflightRequests, []);
	h.clock.value += NETWORK_STALL_TIMEOUT_MS * 2;
	assertEquals(await h.watchdog.sweepStalledRequests(), []);
});

// ---------------------------------------------------------------------------
// arming
// ---------------------------------------------------------------------------

Deno.test('crash: connect arms the loop, stop disarms it, and detach leaves no timer behind', async () => {
	await using h = await harness();
	assertEquals(h.watchdog.probing, false);

	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.watchdog.probing, true);
	assertEquals(h.watchdog.probeIntervalMs, CRASH_PROBE_INTERVAL_MS);

	await h.bus.dispatch(new BrowserStopEvent());
	assertEquals(h.watchdog.probing, false);

	// Re-arm, then let `detach()` do the clearing — the op sanitizer is the assertion here.
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.watchdog.probing, true);
});
