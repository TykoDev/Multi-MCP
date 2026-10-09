import { assertEquals, assertThrows } from '@std/assert';
import { expect } from '@std/expect';
import {
	BaseEvent,
	EventNameCollisionError,
	EventNameRegistry,
	globalEventRegistry,
	registerEvent,
	registerEvents,
} from '../mod.ts';

class RegAlphaEvent extends BaseEvent<void> {}
class RegBetaEvent extends BaseEvent<void> {}
/** Contains `RegAlphaEvent` as a substring — the second rule of the D-BUS1 name contract. */
class RegAlphaEventDeluxe extends BaseEvent<void> {}

function makeNamedDuplicate(): [typeof RegAlphaEvent, typeof RegAlphaEvent] {
	const first = (() => {
		class RegClashEvent extends BaseEvent<void> {}
		return RegClashEvent;
	})();
	const second = (() => {
		class RegClashEvent extends BaseEvent<void> {}
		return RegClashEvent;
	})();
	return [first, second];
}

Deno.test('registry: registers an event class and resolves it by name', () => {
	const registry = new EventNameRegistry();
	registerEvent(RegAlphaEvent, registry);
	assertEquals(registry.get('RegAlphaEvent'), RegAlphaEvent);
	assertEquals(registry.has(RegAlphaEvent), true);
	assertEquals(registry.has(RegBetaEvent), false);
	assertEquals(registry.size, 1);
	assertEquals(registry.names(), ['RegAlphaEvent']);
});

Deno.test('registry: re-registering the same class is idempotent', () => {
	const registry = new EventNameRegistry();
	registerEvent(RegAlphaEvent, registry);
	registerEvent(RegAlphaEvent, registry);
	assertEquals(registry.size, 1);
});

Deno.test('registry: rejects a second class reusing a registered name', () => {
	const registry = new EventNameRegistry();
	const [first, second] = makeNamedDuplicate();
	registry.register(first);
	const error = assertThrows(() => registry.register(second), EventNameCollisionError);
	assertEquals(error.kind, 'duplicate');
	assertEquals(error.eventName, 'RegClashEvent');
});

Deno.test('registry: rejects a name that contains an already-registered name', () => {
	const registry = new EventNameRegistry();
	registry.register(RegAlphaEvent);
	const error = assertThrows(() => registry.register(RegAlphaEventDeluxe), EventNameCollisionError);
	assertEquals(error.kind, 'substring');
	assertEquals(error.conflictsWith, 'RegAlphaEvent');
});

Deno.test('registry: rejects a name that is contained by an already-registered name', () => {
	const registry = new EventNameRegistry();
	registry.register(RegAlphaEventDeluxe);
	const error = assertThrows(() => registry.register(RegAlphaEvent), EventNameCollisionError);
	assertEquals(error.kind, 'substring');
	assertEquals(error.conflictsWith, 'RegAlphaEventDeluxe');
});

Deno.test('registry: rejects anonymous and non-PascalCase event names', () => {
	const registry = new EventNameRegistry();
	const lowercase = (() => {
		class lowerCaseEvent extends BaseEvent<void> {}
		return lowerCaseEvent;
	})();
	// Passed inline so the class expression keeps an empty `name` (no named evaluation).
	assertEquals(
		assertThrows(() => registry.register(class extends BaseEvent<void> {}), EventNameCollisionError).kind,
		'invalid',
	);
	assertEquals(assertThrows(() => registry.register(lowercase), EventNameCollisionError).kind, 'invalid');
	assertEquals(registry.size, 0);
});

Deno.test('registry: registerEvents batches and clear() empties the namespace', () => {
	const registry = new EventNameRegistry();
	registerEvents([RegAlphaEvent, RegBetaEvent], registry);
	assertEquals(registry.size, 2);
	registry.clear();
	assertEquals(registry.size, 0);
	expect(registry.get('RegAlphaEvent')).toBeUndefined();
});

Deno.test('registry: registerEvent defaults to the process-wide registry and returns the class', () => {
	class RegGlobalProbeEvent extends BaseEvent<void> {}
	assertEquals(registerEvent(RegGlobalProbeEvent), RegGlobalProbeEvent);
	assertEquals(globalEventRegistry.get('RegGlobalProbeEvent'), RegGlobalProbeEvent);
});
