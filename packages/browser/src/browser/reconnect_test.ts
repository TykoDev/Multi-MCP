/**
 * Reconnect + `ConnectionPolicy` contract tests (ARCHITECTURE.md §7.4, §4.6;
 * COMPLETIONS-CRITERIA.md §3.2 auto-reconnect row).
 *
 * This is the R2 timing surface, so every number is driven by `FakeTime` rather than by sleeping:
 * the ladder's clock is `setTimeout`/`Date.now`, both of which `FakeTime` owns. The `connect` hook is
 * a constructor parameter of the controller — an injected seam, not a mocked transport; the real
 * socket-drop → reconnect path is covered end to end in `session_test.ts` and in
 * `tests/integration/session_lifecycle_test.ts`.
 */

import { assert, assertEquals, assertInstanceOf } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { ConnectionError, type ConnectionPolicy, EventBus, resilientWrapper, silentBusLogger } from '@tykotech/bus';
import {
	BrowserErrorEvent,
	BrowserKillEvent,
	BrowserLaunchEvent,
	BrowserReconnectedEvent,
	BrowserReconnectingEvent,
	BrowserStartEvent,
	BrowserStopEvent,
	BrowserStoppedEvent,
	WaitEvent,
} from '../events.ts';
import { BrowserError } from '../errors.ts';
import {
	CONNECT_TIMEOUT_MS,
	isLifecycleEventName,
	LIFECYCLE_EVENT_NAMES,
	RECONNECT_BACKOFF_MS,
	RECONNECT_MAX_ATTEMPTS,
	RECONNECT_WAIT_TIMEOUT_MS,
	ReconnectController,
	withTimeout,
} from './reconnect.ts';

// ---------------------------------------------------------------------------
// constants (the R2 audit surface)
// ---------------------------------------------------------------------------

Deno.test('ARCHITECTURE §7.4/§8 reconnect constants are encoded verbatim', () => {
	assertEquals(CONNECT_TIMEOUT_MS, 15_000);
	assertEquals(RECONNECT_MAX_ATTEMPTS, 3);
	assertEquals(RECONNECT_BACKOFF_MS, [1_000, 2_000, 4_000]);
	assertEquals(RECONNECT_WAIT_TIMEOUT_MS, 54_000);
	// §7.4 derives 54 s from "3 attempts × 15 s cap + backoff"; the worst case must fit inside it.
	const worstCase = RECONNECT_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0) +
		RECONNECT_MAX_ATTEMPTS * CONNECT_TIMEOUT_MS;
	assertEquals(worstCase, 52_000);
	assert(worstCase <= RECONNECT_WAIT_TIMEOUT_MS);
});

Deno.test('the lifecycle list is exactly the eight events of §4.6', () => {
	assertEquals([...LIFECYCLE_EVENT_NAMES].sort(), [
		'BrowserErrorEvent',
		'BrowserKillEvent',
		'BrowserLaunchEvent',
		'BrowserReconnectedEvent',
		'BrowserReconnectingEvent',
		'BrowserStartEvent',
		'BrowserStopEvent',
		'BrowserStoppedEvent',
	]);
	for (
		const cls of [
			BrowserStartEvent,
			BrowserStopEvent,
			BrowserStoppedEvent,
			BrowserLaunchEvent,
			BrowserErrorEvent,
			BrowserKillEvent,
			BrowserReconnectingEvent,
			BrowserReconnectedEvent,
		]
	) {
		assert(isLifecycleEventName(cls.eventName), `${cls.eventName} must bypass the breaker`);
	}
	assert(!isLifecycleEventName(WaitEvent.eventName));
});

Deno.test('withTimeout reports the deadline as data and always clears its timer', async () => {
	using time = new FakeTime();
	const hanging = withTimeout(new Promise<string>(() => {}), 1_000);
	await time.tickAsync(999);
	const settled = withTimeout(Promise.resolve('now'), 1_000);
	assertEquals((await settled).value, 'now');
	await time.tickAsync(2);
	assertEquals((await hanging).timedOut, true);
	// A non-positive budget disables the deadline entirely.
	assertEquals((await withTimeout(Promise.resolve(7), 0)).value, 7);
});

// ---------------------------------------------------------------------------
// the ladder
// ---------------------------------------------------------------------------

interface LadderProbe {
	readonly bus: EventBus;
	readonly controller: ReconnectController;
	readonly attemptsAt: number[];
	readonly reconnecting: number[];
	readonly reconnected: BrowserReconnectedEvent[];
	readonly errors: BrowserErrorEvent[];
	readonly t0: number;
}

function ladder(options: {
	connect: (attempt: number, signal: AbortSignal) => Promise<void>;
	connected?: () => boolean;
	attemptTimeoutMs?: number;
}): LadderProbe {
	const bus = new EventBus({ name: 'reconnect', logger: silentBusLogger });
	const attemptsAt: number[] = [];
	const reconnecting: number[] = [];
	const reconnected: BrowserReconnectedEvent[] = [];
	const errors: BrowserErrorEvent[] = [];
	const t0 = Date.now();
	let attempt = 0;
	bus.on(BrowserReconnectingEvent, (event) => void reconnecting.push(event.attempt));
	bus.on(BrowserReconnectedEvent, (event) => void reconnected.push(event));
	bus.on(BrowserErrorEvent, (event) => void errors.push(event));
	const controller = new ReconnectController({
		bus,
		connect: (signal) => {
			attempt += 1;
			attemptsAt.push(Date.now() - t0);
			return options.connect(attempt, signal);
		},
		isConnected: options.connected ?? (() => false),
		cdpUrl: () => 'ws://127.0.0.1:9222/devtools/browser/x',
		logger: silentBusLogger,
		...(options.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: options.attemptTimeoutMs }),
	});
	return { bus, controller, attemptsAt, reconnecting, reconnected, errors, t0 };
}

Deno.test('ladder: 3 attempts at 1 s / 2 s / 4 s, then BrowserErrorEvent(ReconnectionFailed)', async () => {
	using time = new FakeTime();
	const probe = ladder({ connect: () => Promise.reject(new BrowserError('socket refused')) });
	try {
		const run = probe.controller.start();
		assertEquals(probe.controller.isReconnecting(), true);

		await time.tickAsync(999);
		assertEquals(probe.attemptsAt, [], 'attempt 1 must wait the full 1 s backoff');
		await time.tickAsync(1);
		assertEquals(probe.attemptsAt, [1_000]);

		await time.tickAsync(1_999);
		assertEquals(probe.attemptsAt.length, 1, 'attempt 2 must wait 2 s');
		await time.tickAsync(1);
		assertEquals(probe.attemptsAt, [1_000, 3_000]);

		await time.tickAsync(3_999);
		assertEquals(probe.attemptsAt.length, 2, 'attempt 3 must wait 4 s');
		await time.tickAsync(1);
		assertEquals(probe.attemptsAt, [1_000, 3_000, 7_000]);

		assertEquals(await run, false);
		await time.runMicrotasks();
		assertEquals(probe.reconnecting, [1, 2, 3]);
		assertEquals(probe.controller.attemptsMade, RECONNECT_MAX_ATTEMPTS);
		assertEquals(probe.errors.length, 1);
		assertEquals(probe.errors[0]?.errorType, 'ReconnectionFailed');
		assertEquals(probe.errors[0]?.details.attempts, 3);
		assertEquals(probe.errors[0]?.details.backoffMs, [1_000, 2_000, 4_000]);
		assertEquals(probe.controller.isReconnecting(), false);
	} finally {
		await probe.bus.stop();
	}
});

Deno.test('ladder: success on attempt 2 emits BrowserReconnectedEvent with the downtime', async () => {
	using time = new FakeTime();
	let connected = false;
	const probe = ladder({
		connect: (attempt) => {
			if (attempt < 2) return Promise.reject(new BrowserError('still down'));
			connected = true;
			return Promise.resolve();
		},
		connected: () => connected,
	});
	try {
		const run = probe.controller.start();
		// Ticked to each scheduled boundary: `tickAsync` advances the clock before flushing, so a timer
		// created *during* a tick is scheduled from the already-advanced now and a single large tick
		// would step straight over it.
		await time.tickAsync(1_000);
		assertEquals(probe.attemptsAt, [1_000]);
		await time.tickAsync(2_000);
		assertEquals(await run, true);
		await time.runMicrotasks();
		assertEquals(probe.reconnecting, [1, 2]);
		assertEquals(probe.reconnected.length, 1);
		assertEquals(probe.reconnected[0]?.attempt, 2);
		assertEquals(probe.reconnected[0]?.downtimeSeconds, 3);
		assertEquals(probe.errors.length, 0);
	} finally {
		await probe.bus.stop();
	}
});

Deno.test('ladder: each attempt is capped at 15 s, so the worst case is 52 s', async () => {
	using time = new FakeTime();
	const probe = ladder({ connect: () => new Promise<void>(() => {}) });
	try {
		const run = probe.controller.start();
		await time.tickAsync(1_000);
		assertEquals(probe.attemptsAt, [1_000]);
		// The hung attempt must be abandoned exactly at the 15 s cap, not left to hang.
		await time.tickAsync(CONNECT_TIMEOUT_MS);
		assertEquals(probe.attemptsAt.length, 1);
		await time.tickAsync(2_000);
		assertEquals(probe.attemptsAt, [1_000, 18_000]);
		await time.tickAsync(CONNECT_TIMEOUT_MS);
		await time.tickAsync(4_000);
		assertEquals(probe.attemptsAt, [1_000, 18_000, 37_000]);
		await time.tickAsync(CONNECT_TIMEOUT_MS);
		assertEquals(await run, false);
		assertEquals(Date.now() - probe.t0, 52_000);
		assert(Date.now() - probe.t0 <= RECONNECT_WAIT_TIMEOUT_MS);
	} finally {
		await probe.bus.stop();
	}
});

Deno.test('auto-reconnect is gated on CdpCloseInfo.intentional === false', async () => {
	using time = new FakeTime();
	const probe = ladder({ connect: () => Promise.reject(new BrowserError('down')) });
	try {
		assertEquals(
			probe.controller.notifyClosed({ code: 1000, reason: 'client closed', wasClean: true, intentional: true }),
			null,
		);
		assertEquals(probe.controller.isReconnecting(), false);
		assertEquals(probe.attemptsAt.length, 0);

		const run = probe.controller.notifyClosed({ code: 1006, reason: 'gone', wasClean: false, intentional: false });
		assert(run !== null);
		assertEquals(probe.controller.isReconnecting(), true);
		for (const backoff of RECONNECT_BACKOFF_MS) await time.tickAsync(backoff);
		assertEquals(await run, false);
		assertEquals(probe.attemptsAt.length, 3);
	} finally {
		await probe.bus.stop();
	}
});

Deno.test('disable() stops the ladder and suppresses further drop handling', async () => {
	using time = new FakeTime();
	const probe = ladder({ connect: () => Promise.reject(new BrowserError('down')) });
	try {
		const run = probe.controller.start();
		await time.tickAsync(1_000);
		assertEquals(probe.attemptsAt.length, 1);
		probe.controller.disable();
		assertEquals(await run, false);
		assertEquals(probe.attemptsAt.length, 1, 'no further attempts after disable()');
		assertEquals(probe.errors.length, 0, 'a cancelled ladder is not a ReconnectionFailed');
		assertEquals(
			probe.controller.notifyClosed({ code: 1006, reason: 'gone', wasClean: false, intentional: false }),
			null,
		);
		probe.controller.enable();
		assertEquals(probe.controller.enabled, true);
	} finally {
		await probe.bus.stop();
	}
});

// ---------------------------------------------------------------------------
// ConnectionPolicy ⇄ the bus circuit breaker
// ---------------------------------------------------------------------------

interface BreakerProbe {
	readonly bus: EventBus;
	readonly controller: ReconnectController;
	readonly ran: string[];
}

function breaker(options: {
	connect: (attempt: number) => Promise<void>;
	connected: () => boolean;
	attemptTimeoutMs?: number;
}): BreakerProbe {
	const ran: string[] = [];
	// The policy is handed to the bus before the controller exists (the same cycle `BrowserSession`
	// resolves in its constructor), so it reads through a holder rather than a captured binding.
	const ref: { controller: ReconnectController | null } = { controller: null };
	const connection: ConnectionPolicy = {
		isConnected: () => options.connected(),
		isReconnecting: () => ref.controller?.isReconnecting() ?? false,
		waitForReconnect: (signalOrMs) => ref.controller?.waitForReconnect(signalOrMs) ?? Promise.resolve(false),
		isLifecycleEvent: (event) => isLifecycleEventName(event.eventType),
	};
	const bus = new EventBus({
		name: 'breaker',
		logger: silentBusLogger,
		wrapHandler: resilientWrapper({ connection, logger: silentBusLogger }),
	});
	let attempt = 0;
	const controller = new ReconnectController({
		bus,
		connect: () => options.connect(++attempt),
		isConnected: options.connected,
		cdpUrl: () => 'ws://127.0.0.1:9222/x',
		logger: silentBusLogger,
		...(options.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: options.attemptTimeoutMs }),
	});
	ref.controller = controller;
	bus.on(WaitEvent, () => void ran.push('wait'));
	bus.on(BrowserStartEvent, () => {
		ran.push('start');
		return { cdpUrl: 'ws://127.0.0.1:9222/x' };
	});
	return { bus, controller, ran };
}

Deno.test('breaker: a non-lifecycle handler is skipped while disconnected and not reconnecting', async () => {
	const probe = breaker({ connect: () => Promise.resolve(), connected: () => false });
	try {
		await probe.bus.dispatch(new WaitEvent({ seconds: 0 }));
		assertEquals(probe.ran, []);
		// Lifecycle events always run — that is what lets a session start on a dead transport.
		await probe.bus.dispatch(new BrowserStartEvent());
		assertEquals(probe.ran, ['start']);
	} finally {
		await probe.bus.stop();
	}
});

Deno.test('breaker: a handler blocked mid-reconnect waits, then runs once the ladder succeeds', async () => {
	using time = new FakeTime();
	let connected = false;
	const probe = breaker({
		connect: (attempt) => {
			if (attempt < 2) return Promise.reject(new BrowserError('still down'));
			connected = true;
			return Promise.resolve();
		},
		connected: () => connected,
	});
	try {
		probe.controller.start();
		const handle = probe.bus.dispatch(new WaitEvent({ seconds: 0 }));
		await time.tickAsync(1_000);
		assertEquals(probe.ran, [], 'the handler must still be parked on waitForReconnect');
		await time.tickAsync(2_000);
		await handle;
		assertEquals(probe.ran, ['wait']);
	} finally {
		await probe.bus.stop();
	}
});

Deno.test('breaker: a handler still blocked at RECONNECT_WAIT_TIMEOUT gets ConnectionError', async () => {
	using time = new FakeTime();
	const probe = breaker({
		// One attempt that hangs well past the 54 s handler budget: the *handler's* deadline is what
		// this test is about, not the ladder's.
		connect: () => new Promise<void>(() => {}),
		connected: () => false,
		attemptTimeoutMs: 120_000,
	});
	try {
		probe.controller.start();
		const handle = probe.bus.dispatch(new WaitEvent({ seconds: 0 }));
		await time.tickAsync(1_000);
		await time.tickAsync(RECONNECT_WAIT_TIMEOUT_MS - 1_001);
		assertEquals(probe.ran.length, 0);
		await time.tickAsync(2);
		const outcomes = await handle.outcomes();
		assertEquals(outcomes.length, 1);
		assertEquals(outcomes[0]?.status, 'rejected');
		assertInstanceOf(outcomes[0]?.error, ConnectionError);
		assertEquals(probe.ran, []);
	} finally {
		probe.controller.disable();
		await time.tickAsync(180_000);
		await probe.bus.stop();
	}
});

Deno.test('waitForReconnect: true when already connected, false when no ladder is running', async () => {
	let connected = true;
	const probe = breaker({ connect: () => Promise.resolve(), connected: () => connected });
	try {
		assertEquals(await probe.controller.waitForReconnect(1_000), true);
		connected = false;
		assertEquals(await probe.controller.waitForReconnect(1_000), false);
	} finally {
		await probe.bus.stop();
	}
});

Deno.test('waitForReconnect honours an AbortSignal as well as a millisecond budget', async () => {
	using time = new FakeTime();
	const probe = breaker({ connect: () => new Promise<void>(() => {}), connected: () => false });
	try {
		probe.controller.start();
		const abort = new AbortController();
		const waiting = probe.controller.waitForReconnect(abort.signal);
		abort.abort();
		assertEquals(await waiting, false);
		// An already-aborted signal short-circuits.
		assertEquals(await probe.controller.waitForReconnect(AbortSignal.abort()), false);
	} finally {
		probe.controller.disable();
		await time.tickAsync(180_000);
		await probe.bus.stop();
	}
});
