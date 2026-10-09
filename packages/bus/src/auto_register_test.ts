import { assertEquals, assertThrows } from '@std/assert';
import {
	BaseEvent,
	EventBus,
	EventNameRegistry,
	findHandlerMethods,
	HandlerDeclarationError,
	readDeclarations,
	registerHandlers,
	silentBusLogger,
} from '../mod.ts';

class ArAlphaEvent extends BaseEvent<void> {}
class ArBetaEvent extends BaseEvent<string> {}
class ArGammaEvent extends BaseEvent<void> {}
class ArOrphanEvent extends BaseEvent<void> {}

function makeBus(): EventBus {
	return new EventBus({ registry: new EventNameRegistry(), logger: silentBusLogger });
}

class BaseProbeWatchdog {
	readonly seen: string[] = [];
	onArGammaEvent(): void {
		this.seen.push('gamma');
	}
}

class ProbeWatchdog extends BaseProbeWatchdog {
	static LISTENS_TO = [ArAlphaEvent, ArBetaEvent, ArGammaEvent];
	static EMITS = [ArOrphanEvent];

	onArAlphaEvent(event: ArAlphaEvent): void {
		this.seen.push(`alpha:${event.eventType}`);
	}
	onArBetaEvent(): string {
		this.seen.push('beta');
		return 'beta-result';
	}
	/** Not a handler: lower-case after `on`. */
	onlyBookkeeping(): void {
		this.seen.push('never');
	}
}

Deno.test('auto-register: subscribes every on<EventName> method, including inherited ones', async () => {
	const bus = makeBus();
	const watchdog = new ProbeWatchdog();
	const detach = registerHandlers(bus, watchdog);
	assertEquals(bus.handlerCount(ArAlphaEvent), 1);
	assertEquals(bus.handlerCount(ArBetaEvent), 1);
	assertEquals(bus.handlerCount(ArGammaEvent), 1);
	await bus.dispatch(new ArAlphaEvent());
	assertEquals(await bus.dispatch(new ArBetaEvent()).eventResult(), 'beta-result');
	await bus.dispatch(new ArGammaEvent());
	assertEquals(watchdog.seen, ['alpha:ArAlphaEvent', 'beta', 'gamma']);
	detach();
});

Deno.test('auto-register: detach unsubscribes every handler', async () => {
	const bus = makeBus();
	const watchdog = new ProbeWatchdog();
	const detach = registerHandlers(bus, watchdog);
	detach();
	detach(); // idempotent
	assertEquals(bus.handlerCount(ArAlphaEvent), 0);
	await bus.dispatch(new ArAlphaEvent());
	assertEquals(watchdog.seen, []);
	// Re-attaching after detach is legal — a watchdog may be re-attached to a fresh session.
	registerHandlers(bus, watchdog)();
});

Deno.test('auto-register: attaching the same owner twice throws', () => {
	const bus = makeBus();
	const watchdog = new ProbeWatchdog();
	registerHandlers(bus, watchdog);
	assertThrows(() => registerHandlers(bus, watchdog));
	assertEquals(bus.handlerCount(ArAlphaEvent), 1);
});

Deno.test('auto-register: a partially failing attach rolls back its subscriptions', () => {
	const bus = makeBus();
	const watchdog = new ProbeWatchdog();
	// Pre-claim the (owner, key) slot of the *last* handler so the attach fails midway.
	bus.on(ArGammaEvent, () => {}, { owner: watchdog, key: 'onArGammaEvent' });
	assertThrows(() => registerHandlers(bus, watchdog));
	assertEquals(bus.handlerCount(ArAlphaEvent), 0, 'earlier subscriptions must be rolled back');
	assertEquals(bus.handlerCount(ArBetaEvent), 0);
	assertEquals(bus.handlerCount(ArGammaEvent), 1);
});

Deno.test('auto-register: a handler missing from LISTENS_TO is rejected', () => {
	const bus = makeBus();
	class UnderdeclaredWatchdog {
		static LISTENS_TO = [ArAlphaEvent];
		onArAlphaEvent(): void {}
		onArBetaEvent(): void {}
	}
	const error = assertThrows(
		() => registerHandlers(bus, new UnderdeclaredWatchdog()),
		HandlerDeclarationError,
	);
	assertEquals(error.message.includes('LISTENS_TO'), true);
});

Deno.test('auto-register: a LISTENS_TO entry with no handler method is rejected', () => {
	const bus = makeBus();
	class OverdeclaredWatchdog {
		static LISTENS_TO = [ArAlphaEvent, ArBetaEvent];
		onArAlphaEvent(): void {}
	}
	const error = assertThrows(
		() => registerHandlers(bus, new OverdeclaredWatchdog()),
		HandlerDeclarationError,
	);
	assertEquals(error.message.includes('onArBetaEvent'), true);
});

Deno.test('auto-register: LISTENS_TO/EMITS entries must be event classes and are registered', () => {
	const bus = makeBus();
	class EmitterWatchdog {
		static LISTENS_TO = [ArAlphaEvent];
		static EMITS = [ArOrphanEvent];
		onArAlphaEvent(): void {}
	}
	registerHandlers(bus, new EmitterWatchdog());
	assertEquals(bus.registry.has(ArOrphanEvent), true, 'emitted-only events join the name registry');

	class BrokenWatchdog {
		static LISTENS_TO = [ArAlphaEvent];
		static EMITS = ['ArOrphanEvent'];
		onArAlphaEvent(): void {}
	}
	assertThrows(() => registerHandlers(makeBus(), new BrokenWatchdog()), HandlerDeclarationError);
});

Deno.test('auto-register: an undeclared owner resolves handlers through the bus registry', async () => {
	const bus = makeBus();
	bus.registry.register(ArAlphaEvent);
	const seen: string[] = [];
	const service = {
		onArAlphaEvent(): void {
			seen.push('alpha');
		},
	};
	registerHandlers(bus, service);
	await bus.dispatch(new ArAlphaEvent());
	assertEquals(seen, ['alpha']);
});

Deno.test('auto-register: an unknown event name throws unless ignoreUnknown is set', () => {
	const bus = makeBus();
	const service = { onArNeverRegisteredEvent(): void {} };
	assertThrows(() => registerHandlers(bus, service), HandlerDeclarationError, 'unknown event');
	registerHandlers(bus, service, { ignoreUnknown: true });
	assertEquals(bus.registry.size, 0);
});

Deno.test('auto-register: findHandlerMethods ignores accessors and non-handler names', () => {
	const owner = {
		onlyBookkeeping() {},
		on() {},
		onArAlphaEvent() {},
		get onArBetaEvent(): () => void {
			throw new Error('accessors must never be invoked during discovery');
		},
	};
	assertEquals(findHandlerMethods(owner).map((m) => m.methodName), ['onArAlphaEvent']);
	assertEquals(findHandlerMethods(owner)[0]?.eventName, 'ArAlphaEvent');
});

Deno.test('auto-register: readDeclarations falls back to instance-level declarations', () => {
	const instanceDeclared = { LISTENS_TO: [ArAlphaEvent], EMITS: [ArOrphanEvent], onArAlphaEvent(): void {} };
	const declarations = readDeclarations(instanceDeclared);
	assertEquals(declarations.LISTENS_TO, [ArAlphaEvent]);
	assertEquals(declarations.EMITS, [ArOrphanEvent]);
	assertEquals(readDeclarations(new BaseProbeWatchdog()).LISTENS_TO, undefined);
});
