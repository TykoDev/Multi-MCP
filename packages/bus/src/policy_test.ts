import { assertEquals, assertRejects } from '@std/assert';
import { expect } from '@std/expect';
import { FakeTime } from '@std/testing/time';
import {
	BaseEvent,
	type BusLogger,
	ConnectionError,
	type ConnectionPolicy,
	EventBus,
	EventNameRegistry,
	type HandlerContext,
	RECONNECT_WAIT_TIMEOUT_MS,
	resilientHandler,
	resilientWrapper,
	silentBusLogger,
} from '../mod.ts';

class PolCommandEvent extends BaseEvent<string> {}
class PolLifecycleEvent extends BaseEvent<void> {}

/**
 * A hand-driven {@linkcode ConnectionPolicy}: the seam `@tykotech/browser` fills with the CDP client's real
 * state in M1. Nothing is faked here that the bus would otherwise own — the policy *is* the input.
 */
class ManualConnectionPolicy implements ConnectionPolicy {
	connected = true;
	reconnecting = false;
	reconnectDelayMs: number | null = 1_000;
	reconnectSucceeds = true;
	waitCalls = 0;

	isConnected(): boolean {
		return this.connected;
	}

	isReconnecting(): boolean {
		return this.reconnecting;
	}

	waitForReconnect(signalOrMs: AbortSignal | number): Promise<boolean> {
		this.waitCalls += 1;
		expect(signalOrMs).toBe(RECONNECT_WAIT_TIMEOUT_MS);
		const delayMs = this.reconnectDelayMs;
		if (delayMs === null) return new Promise<boolean>(() => {});
		return new Promise<boolean>((resolve) =>
			setTimeout(() => {
				this.connected = this.reconnectSucceeds;
				this.reconnecting = false;
				resolve(this.reconnectSucceeds);
			}, delayMs)
		);
	}

	isLifecycleEvent(event: BaseEvent<unknown>): boolean {
		return event.eventType === 'PolLifecycleEvent';
	}
}

function context(handlerName = 'probe'): HandlerContext {
	return { signal: new AbortController().signal, handlerName, timeoutSec: 0 };
}

function recordingLogger(): { logger: BusLogger; warns: string[] } {
	const warns: string[] = [];
	return { warns, logger: { debug: () => {}, warn: (m) => warns.push(m), error: () => {} } };
}

Deno.test('policy: RECONNECT_WAIT_TIMEOUT is 54s (3 attempts x 15s cap + 1/2/4s backoff)', () => {
	assertEquals(RECONNECT_WAIT_TIMEOUT_MS, 54_000);
});

Deno.test('policy: a connected handler runs untouched', async () => {
	const connection = new ManualConnectionPolicy();
	const wrapped = resilientHandler(() => 'ran', { connection });
	assertEquals(await wrapped(new PolCommandEvent(), context()), 'ran');
	assertEquals(connection.waitCalls, 0);
});

Deno.test('policy: a non-lifecycle handler is skipped while disconnected', async () => {
	const { logger, warns } = recordingLogger();
	const connection = new ManualConnectionPolicy();
	connection.connected = false;
	let ran = false;
	const wrapped = resilientHandler(() => {
		ran = true;
		return 'ran';
	}, { connection, logger });
	expect(await wrapped(new PolCommandEvent(), context())).toBeUndefined();
	assertEquals(ran, false);
	assertEquals(warns, ['handler skipped while disconnected']);
	assertEquals(connection.waitCalls, 0);
});

Deno.test('policy: lifecycle handlers run while disconnected', async () => {
	const connection = new ManualConnectionPolicy();
	connection.connected = false;
	const wrapped = resilientHandler(() => 'ran', { connection });
	assertEquals(await wrapped(new PolLifecycleEvent(), context()), 'ran');
});

Deno.test('policy: waits for an in-flight reconnect, then runs the handler', async () => {
	using time = new FakeTime();
	const connection = new ManualConnectionPolicy();
	connection.connected = false;
	connection.reconnecting = true;
	connection.reconnectDelayMs = 3_000;
	const wrapped = resilientHandler(() => 'ran', { connection });
	const running = wrapped(new PolCommandEvent(), context());
	await time.tickAsync(3_000);
	assertEquals(await running, 'ran');
	assertEquals(connection.waitCalls, 1);
});

Deno.test('policy: throws ConnectionError when the reconnect wait budget is exhausted', async () => {
	using time = new FakeTime();
	const { logger, warns } = recordingLogger();
	const connection = new ManualConnectionPolicy();
	connection.connected = false;
	connection.reconnecting = true;
	connection.reconnectDelayMs = null; // never resolves
	let ran = false;
	const wrapped = resilientHandler(() => {
		ran = true;
	}, { connection, logger });
	const running = wrapped(new PolCommandEvent(), context());
	await time.tickAsync(RECONNECT_WAIT_TIMEOUT_MS);
	const error = await assertRejects(async () => await running, ConnectionError);
	assertEquals(error.waitedMs, RECONNECT_WAIT_TIMEOUT_MS);
	assertEquals(ran, false);
	assertEquals(warns, ['reconnect wait budget exhausted']);
});

Deno.test('policy: a reconnect that gives up becomes a ConnectionError', async () => {
	using time = new FakeTime();
	const connection = new ManualConnectionPolicy();
	connection.connected = false;
	connection.reconnecting = true;
	connection.reconnectDelayMs = 500;
	connection.reconnectSucceeds = false;
	const wrapped = resilientHandler(() => 'ran', { connection });
	const running = wrapped(new PolCommandEvent(), context());
	await time.tickAsync(500);
	await assertRejects(async () => await running, ConnectionError);
});

Deno.test('policy: a waitForReconnect that throws becomes a ConnectionError', async () => {
	const { logger, warns } = recordingLogger();
	const connection: ConnectionPolicy = {
		isConnected: () => false,
		isReconnecting: () => true,
		waitForReconnect: () => Promise.reject(new Error('socket gone')),
		isLifecycleEvent: () => false,
	};
	const wrapped = resilientHandler(() => 'ran', { connection, logger });
	await assertRejects(() => Promise.resolve(wrapped(new PolCommandEvent(), context())), ConnectionError);
	assertEquals(warns, ['reconnect wait failed']);
});

Deno.test('policy: repair runs once on failure and the original error is re-thrown', async () => {
	const boom = new Error('handler exploded');
	let repairs = 0;
	const wrapped = resilientHandler(() => {
		throw boom;
	}, {
		repair: () => {
			repairs += 1;
		},
	});
	const error = await assertRejects(() => Promise.resolve(wrapped(new PolCommandEvent(), context())));
	assertEquals(error, boom);
	assertEquals(repairs, 1);
});

Deno.test('policy: a failing repair never masks the original error', async () => {
	const { logger, warns } = recordingLogger();
	const boom = new Error('handler exploded');
	const wrapped = resilientHandler(() => {
		throw boom;
	}, {
		repair: () => Promise.reject(new Error('repair also exploded')),
		logger,
	});
	const error = await assertRejects(() => Promise.resolve(wrapped(new PolCommandEvent(), context())));
	assertEquals(error, boom);
	assertEquals(warns, ['session repair failed']);
});

Deno.test('policy: resilientWrapper applies the breaker to every handler on a bus', async () => {
	const connection = new ManualConnectionPolicy();
	connection.connected = false;
	let commandRuns = 0;
	let lifecycleRuns = 0;
	const bus = new EventBus({
		registry: new EventNameRegistry(),
		logger: silentBusLogger,
		wrapHandler: resilientWrapper({ connection }),
	});
	bus.on(PolCommandEvent, () => {
		commandRuns += 1;
		return 'ran';
	});
	bus.on(PolLifecycleEvent, () => {
		lifecycleRuns += 1;
	});

	expect(await bus.dispatch(new PolCommandEvent()).eventResult()).toBeUndefined();
	await bus.dispatch(new PolLifecycleEvent());
	assertEquals(commandRuns, 0);
	assertEquals(lifecycleRuns, 1);

	connection.connected = true;
	assertEquals(await bus.dispatch(new PolCommandEvent()).eventResult({ raiseIfAny: true }), 'ran');
	assertEquals(commandRuns, 1);
});
