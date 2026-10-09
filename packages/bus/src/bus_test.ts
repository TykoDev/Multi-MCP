import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from '@std/assert';
import { expect } from '@std/expect';
import { FakeTime } from '@std/testing/time';
import {
	BaseEvent,
	type BusLogger,
	DuplicateHandlerError,
	EventBus,
	type EventBusOptions,
	EventNameCollisionError,
	EventNameRegistry,
	EventTimeoutError,
	type HandlerWrapper,
	NoHandlerResultError,
	silentBusLogger,
} from '../mod.ts';

class BusPingEvent extends BaseEvent<string> {
	static override timeoutSec = 5;
}
class BusQuietEvent extends BaseEvent<void> {}
class BusChainEvent extends BaseEvent<void> {
	constructor(readonly tag: string, readonly depth: number = 0) {
		super();
	}
}
class BusLeafEvent extends BaseEvent<void> {
	constructor(readonly tag: string) {
		super();
	}
}
class BusSlowEvent extends BaseEvent<void> {
	static override timeoutSec = 5;
}
class BusConfigurableEvent extends BaseEvent<void> {
	static override timeoutSec = 9;
}

function makeBus(options: EventBusOptions = {}): EventBus {
	return new EventBus({ registry: new EventNameRegistry(), logger: silentBusLogger, ...options });
}

function recordingLogger(): { logger: BusLogger; warns: string[]; errors: string[] } {
	const warns: string[] = [];
	const errors: string[] = [];
	return {
		warns,
		errors,
		logger: { debug: () => {}, warn: (m) => warns.push(m), error: (m) => errors.push(m) },
	};
}

Deno.test('bus: dispatch enqueues and returns before any handler runs', async () => {
	const bus = makeBus();
	const calls: string[] = [];
	bus.on(BusPingEvent, () => {
		calls.push('handler');
		return 'pong';
	});
	const handle = bus.dispatch(new BusPingEvent());
	assertEquals(calls, [], 'handlers must not run synchronously inside dispatch()');
	assertEquals(await handle.eventResult(), 'pong');
	assertEquals(calls, ['handler']);
});

Deno.test('bus: dispatch never throws — a bad event class comes back as a rejected handle', async () => {
	const { logger, errors } = recordingLogger();
	const bus = makeBus({ logger });
	const handle = bus.dispatch(new (class extends BaseEvent<void> {})());
	await assertRejects(async () => await handle, EventNameCollisionError);
	assertEquals(errors, ['dispatch failed']);
});

Deno.test('bus: awaiting the handle waits for all handlers, in registration order', async () => {
	const bus = makeBus();
	const order: string[] = [];
	bus.on(BusQuietEvent, async () => {
		await Promise.resolve();
		await Promise.resolve();
		order.push('first');
	});
	bus.on(BusQuietEvent, () => {
		order.push('second');
	});
	bus.on(BusQuietEvent, async () => {
		await Promise.resolve();
		order.push('third');
	});
	await bus.dispatch(new BusQuietEvent());
	assertEquals(order, ['first', 'second', 'third']);
});

Deno.test('bus: every handler runs even when an earlier one throws', async () => {
	const bus = makeBus();
	const ran: string[] = [];
	const boom = new Error('handler exploded');
	bus.on(BusQuietEvent, () => {
		throw boom;
	});
	bus.on(BusQuietEvent, () => {
		ran.push('second');
	});
	const handle = bus.dispatch(new BusQuietEvent());
	const error = await assertRejects(async () => await handle);
	assertEquals(error, boom);
	assertEquals(ran, ['second']);
	const outcomes = await handle.outcomes();
	assertEquals(outcomes.map((o) => o.status), ['rejected', 'fulfilled']);
});

Deno.test('bus: eventResult returns the single meaningful handler value', async () => {
	const bus = makeBus();
	bus.on(BusPingEvent, () => undefined);
	bus.on(BusPingEvent, () => 'pong');
	bus.on(BusPingEvent, () => undefined);
	assertEquals(await bus.dispatch(new BusPingEvent()).eventResult(), 'pong');
});

Deno.test('bus: eventResult treats null as meaningful and undefined as no opinion', async () => {
	const bus = makeBus();
	const nullable = new EventBus({ registry: new EventNameRegistry(), logger: silentBusLogger });
	bus.on(BusQuietEvent, () => undefined);
	expect(await bus.dispatch(new BusQuietEvent()).eventResult()).toBeUndefined();
	nullable.on(BusQuietEvent, () => null);
	assertEquals(await nullable.dispatch(new BusQuietEvent()).eventResult(), null);
});

Deno.test('bus: eventResult({ raiseIfAny }) rethrows the handler error, otherwise it is swallowed', async () => {
	const bus = makeBus();
	const boom = new Error('nope');
	bus.on(BusPingEvent, () => {
		throw boom;
	});
	bus.on(BusPingEvent, () => 'pong');
	const handle = bus.dispatch(new BusPingEvent());
	assertEquals(await handle.eventResult(), 'pong');
	assertEquals(await assertRejects(() => handle.eventResult({ raiseIfAny: true })), boom);
});

Deno.test('bus: eventResult({ raiseIfNone }) throws when no handler returned a value', async () => {
	const bus = makeBus();
	bus.on(BusPingEvent, () => undefined);
	const handle = bus.dispatch(new BusPingEvent());
	const error = await assertRejects(() => handle.eventResult({ raiseIfNone: true }), NoHandlerResultError);
	assertEquals(error.handlerCount, 1);
	assertEquals(error.eventType, 'BusPingEvent');
	// With no subscribers at all it is still "none", not an error, unless asked for.
	const empty = makeBus();
	expect(await empty.dispatch(new BusPingEvent()).eventResult()).toBeUndefined();
});

Deno.test('bus: an un-awaited dispatch with a failing handler raises no unhandled rejection', async () => {
	const bus = makeBus();
	bus.on(BusQuietEvent, () => {
		throw new Error('ignored by design');
	});
	bus.dispatch(new BusQuietEvent());
	bus.dispatch(new BusQuietEvent());
	await bus.stop();
});

Deno.test('bus: a handler timeout rejects the handle instead of hanging', async () => {
	using time = new FakeTime();
	const bus = makeBus();
	let release: () => void = () => {};
	bus.on(BusSlowEvent, () => new Promise<void>((resolve) => (release = resolve)));
	const handle = bus.dispatch(new BusSlowEvent());
	await time.tickAsync(4_999);
	let settled = false;
	handle.outcomes().then(() => (settled = true));
	await time.tickAsync(0);
	assertEquals(settled, false, 'must not settle before the 5s budget elapses');
	await time.tickAsync(1);
	const error = await assertRejects(async () => await handle, EventTimeoutError);
	assertEquals(error.timeoutSec, 5);
	assertEquals(error.eventType, 'BusSlowEvent');
	release();
});

Deno.test('bus: the handler context signal aborts when the timeout fires', async () => {
	using time = new FakeTime();
	const bus = makeBus();
	let reason: unknown = null;
	bus.on(BusSlowEvent, (_event, context) =>
		new Promise<void>((resolve) => {
			context.signal.addEventListener('abort', () => {
				reason = context.signal.reason;
				resolve();
			}, { once: true });
		}));
	const handle = bus.dispatch(new BusSlowEvent());
	await time.tickAsync(5_000);
	await assertRejects(async () => await handle, EventTimeoutError);
	assertInstanceOf(reason, EventTimeoutError);
});

Deno.test('bus: a timed-out handler still running holds back the next handler (E-56)', async () => {
	using time = new FakeTime();
	const { logger, warns } = recordingLogger();
	const bus = makeBus({ logger });
	const order: string[] = [];
	let release: () => void = () => {};
	bus.on(BusSlowEvent, async () => {
		order.push('first:start');
		await new Promise<void>((resolve) => (release = resolve));
		order.push('first:end');
	});
	bus.on(BusSlowEvent, () => {
		order.push('second:start');
	});

	const handle = bus.dispatch(new BusSlowEvent());
	await time.tickAsync(5_000);
	// Drain generously past the timeout: the assertion below must fail because the bus *decided* to
	// move on, never because it had not yet had a turn in which to do so.
	for (let i = 0; i < 8; i += 1) await time.tickAsync(0);
	assertEquals(
		order,
		['first:start'],
		'the bus promises registration order; a timed-out handler is still executing, so nothing may follow it',
	);

	release();
	await time.tickAsync(0);
	assertEquals(order, ['first:start', 'first:end', 'second:start']);
	// The dispatch result keeps its shape: the overrun is still reported as a timeout.
	const error = await assertRejects(async () => await handle, EventTimeoutError);
	assertEquals(error.timeoutSec, 5);
	const outcomes = await handle.outcomes();
	assertEquals(outcomes.map((outcome) => outcome.status), ['rejected', 'fulfilled']);
	assertInstanceOf(outcomes[0]?.error, EventTimeoutError);
	assertEquals(warns, [], 'a handler that unwinds inside the grace period is not an abandonment');
});

Deno.test('bus: a handler that ignores its abort is abandoned after the grace period (E-56)', async () => {
	using time = new FakeTime();
	const { logger, warns } = recordingLogger();
	const bus = makeBus({ logger, abandonGraceMs: 1_000 });
	const order: string[] = [];
	// Ignores `context.signal` entirely and never settles — the case a bounded join exists for.
	bus.on(BusSlowEvent, () => new Promise<void>(() => {}));
	bus.on(BusSlowEvent, () => {
		order.push('second');
	});

	const handle = bus.dispatch(new BusSlowEvent());
	await time.tickAsync(5_000);
	for (let i = 0; i < 8; i += 1) await time.tickAsync(0);
	assertEquals(order, [], 'the timeout alone must not release the next handler');
	await time.tickAsync(999);
	assertEquals(order, [], 'the join must hold for the whole grace period');

	await time.tickAsync(1);
	for (let i = 0; i < 8; i += 1) await time.tickAsync(0);
	assertEquals(order, ['second'], 'the bus must not wait forever on a handler that ignores cancellation');
	assertEquals(warns, ['handler abandoned after its grace period; registration order not guaranteed']);
	await assertRejects(async () => await handle, EventTimeoutError);
	const outcomes = await handle.outcomes();
	assertEquals(outcomes.map((outcome) => outcome.status), ['rejected', 'fulfilled']);
});

Deno.test('bus: abandonGraceMs <= 0 restores the pre-E-56 behaviour', async () => {
	using time = new FakeTime();
	const bus = makeBus({ abandonGraceMs: 0 });
	const order: string[] = [];
	let release: () => void = () => {};
	bus.on(BusSlowEvent, async () => {
		await new Promise<void>((resolve) => (release = resolve));
		order.push('first:end');
	});
	bus.on(BusSlowEvent, () => {
		order.push('second');
	});
	const handle = bus.dispatch(new BusSlowEvent());
	await time.tickAsync(5_000);
	for (let i = 0; i < 8; i += 1) await time.tickAsync(0);
	assertEquals(order, ['second'], 'a disabled join must not hold the chain at all');
	release();
	await assertRejects(async () => await handle, EventTimeoutError);
});

Deno.test('bus: TIMEOUT_<EventClassName> is re-read from the env on every dispatch', async () => {
	using time = new FakeTime();
	const env = new Map<string, string>([['TIMEOUT_BusConfigurableEvent', '2']]);
	const bus = makeBus({ env: (name) => env.get(name) });
	const releases: (() => void)[] = [];
	bus.on(BusConfigurableEvent, () => new Promise<void>((resolve) => releases.push(resolve)));

	const first = bus.dispatch(new BusConfigurableEvent());
	await time.tickAsync(2_000);
	assertEquals((await assertRejects(async () => await first, EventTimeoutError)).timeoutSec, 2);

	env.set('TIMEOUT_BusConfigurableEvent', '4');
	const second = bus.dispatch(new BusConfigurableEvent());
	await time.tickAsync(2_000);
	let settled = false;
	second.outcomes().then(() => (settled = true));
	await time.tickAsync(0);
	assertEquals(settled, false, 'the new 4s budget must apply to the second dispatch');
	await time.tickAsync(2_000);
	assertEquals((await assertRejects(async () => await second, EventTimeoutError)).timeoutSec, 4);
	for (const release of releases) release();
});

Deno.test('bus: a timeout of 0 disables the budget', async () => {
	using time = new FakeTime();
	const env = new Map([['TIMEOUT_BusSlowEvent', '0']]);
	const bus = makeBus({ env: (name) => env.get(name) });
	let release: () => void = () => {};
	bus.on(BusSlowEvent, () => new Promise<void>((resolve) => (release = resolve)));
	const handle = bus.dispatch(new BusSlowEvent());
	await time.tickAsync(600_000);
	let settled = false;
	handle.outcomes().then(() => (settled = true));
	await time.tickAsync(0);
	assertEquals(settled, false);
	release();
	await handle;
});

Deno.test('bus: a nested dispatch inherits the triggering event id as eventParentId', async () => {
	const bus = makeBus();
	const leaves: BusLeafEvent[] = [];
	bus.on(BusChainEvent, async (event) => {
		await Promise.resolve();
		bus.dispatch(new BusLeafEvent(event.tag));
	});
	bus.on(BusLeafEvent, (event) => {
		leaves.push(event);
	});
	const parent = new BusChainEvent('solo');
	await bus.dispatch(parent);
	await bus.stop();
	assertEquals(leaves.length, 1);
	assertEquals(leaves[0]?.eventParentId, parent.eventId);
});

Deno.test('bus: lineage stays correct when two dispatches interleave', async () => {
	const bus = makeBus();
	const leaves: BusLeafEvent[] = [];
	bus.on(BusChainEvent, async (event) => {
		for (let i = 0; i < event.depth; i += 1) await Promise.resolve();
		bus.dispatch(new BusLeafEvent(event.tag));
	});
	bus.on(BusLeafEvent, (event) => {
		leaves.push(event);
	});
	const first = new BusChainEvent('a', 1);
	const second = new BusChainEvent('b', 4);
	await Promise.all([bus.dispatch(first), bus.dispatch(second)]);
	await bus.stop();
	const byTag = new Map(leaves.map((leaf) => [leaf.tag, leaf.eventParentId]));
	assertEquals(byTag.get('a'), first.eventId);
	assertEquals(byTag.get('b'), second.eventId);
});

Deno.test('bus: an event built outside a handler is attributed at dispatch time', async () => {
	const bus = makeBus();
	const preBuilt = new BusLeafEvent('pre-built');
	assertEquals(preBuilt.eventParentId, null);
	bus.on(BusChainEvent, async () => {
		await Promise.resolve();
		bus.dispatch(preBuilt);
	});
	const parent = new BusChainEvent('outer');
	await bus.dispatch(parent);
	await bus.stop();
	assertEquals(preBuilt.eventParentId, parent.eventId);
});

Deno.test('bus: duplicate handler registration throws', () => {
	const bus = makeBus();
	const handler = () => 'pong';
	bus.on(BusPingEvent, handler);
	assertThrows(() => bus.on(BusPingEvent, handler), DuplicateHandlerError);
	const owner = { tag: 'watchdog' };
	bus.on(BusQuietEvent, () => {}, { owner, key: 'onBusQuietEvent' });
	assertThrows(
		() => bus.on(BusQuietEvent, () => {}, { owner, key: 'onBusQuietEvent' }),
		DuplicateHandlerError,
	);
	assertEquals(bus.handlerCount(BusPingEvent), 1);
});

Deno.test('bus: unsubscribing removes the handler', async () => {
	const bus = makeBus();
	const seen: string[] = [];
	const off = bus.on(BusPingEvent, () => {
		seen.push('called');
		return 'pong';
	});
	await bus.dispatch(new BusPingEvent());
	off();
	off(); // idempotent
	assertEquals(bus.handlerCount(BusPingEvent), 0);
	await bus.dispatch(new BusPingEvent());
	assertEquals(seen, ['called']);
});

Deno.test('bus: history is a bounded ring in dispatch order', async () => {
	const bus = makeBus({ historyLimit: 3 });
	for (let i = 0; i < 5; i += 1) await bus.dispatch(new BusChainEvent(`e${i}`));
	const tags = bus.history.map((event) => (event as BusChainEvent).tag);
	assertEquals(tags, ['e2', 'e3', 'e4']);
	assertEquals(bus.recentEvents(2).map((event) => (event as BusChainEvent).tag), ['e3', 'e4']);
	assertEquals(bus.history.length, 3);
});

Deno.test('bus: dispatch after stop is a logged no-op', async () => {
	const { logger, warns } = recordingLogger();
	const bus = makeBus({ logger });
	const seen: string[] = [];
	bus.on(BusPingEvent, () => {
		seen.push('called');
		return 'pong';
	});
	await bus.stop();
	assertEquals(bus.stopped, true);
	const handle = bus.dispatch(new BusPingEvent());
	await handle;
	expect(await handle.eventResult()).toBeUndefined();
	assertEquals(seen, []);
	assertEquals(warns, ['dispatch after stop ignored']);
	await bus.stop(); // idempotent
});

Deno.test('bus: stop drains in-flight handlers before returning', async () => {
	const bus = makeBus();
	let done = false;
	bus.on(BusQuietEvent, async () => {
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
		done = true;
	});
	bus.dispatch(new BusQuietEvent());
	await bus.stop();
	assertEquals(done, true);
});

Deno.test('bus: stop aborts handlers that outlive the grace period', async () => {
	using time = new FakeTime();
	const { logger, warns } = recordingLogger();
	const bus = makeBus({ logger });
	let aborted = false;
	bus.on(BusQuietEvent, (_event, context) =>
		new Promise<void>((resolve) => {
			context.signal.addEventListener('abort', () => {
				aborted = true;
				resolve();
			}, { once: true });
		}));
	bus.dispatch(new BusQuietEvent());
	await time.tickAsync(0);
	const stopping = bus.stop(1_000);
	await time.tickAsync(1_000);
	await stopping;
	assertEquals(aborted, true);
	assertEquals(warns, ['stop deadline elapsed, aborting in-flight handlers']);
});

Deno.test('bus: wrapHandler decorates every handler and can be opted out per subscription', async () => {
	const wrapped: string[] = [];
	const wrapper: HandlerWrapper = (handler, meta) => (event, context) => {
		wrapped.push(meta.handlerName);
		return handler(event, context);
	};
	const bus = makeBus({ wrapHandler: wrapper });
	bus.on(BusPingEvent, function named() {
		return 'pong';
	});
	bus.on(BusQuietEvent, () => {}, { wrap: null, handlerName: 'bare' });
	await bus.dispatch(new BusPingEvent());
	await bus.dispatch(new BusQuietEvent());
	assertEquals(wrapped, ['named']);
});

Deno.test('bus: exposes registry, name and handler counts for introspection', async () => {
	const registry = new EventNameRegistry();
	const bus = new EventBus({ registry, name: 'probe', logger: silentBusLogger });
	assertEquals(bus.name, 'probe');
	assertEquals(bus.registry, registry);
	assertEquals(bus.handlerCount(BusPingEvent), 0);
	bus.on(BusPingEvent, () => 'pong');
	assertEquals(bus.handlerCount(BusPingEvent), 1);
	assert(registry.has(BusPingEvent));
	await bus.dispatch(new BusPingEvent());
	assertEquals(bus.history.length, 1);
});
