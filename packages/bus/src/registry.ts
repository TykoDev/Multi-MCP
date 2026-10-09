/**
 * Event-name registry (ARCHITECTURE.md §4.1, D-BUS1).
 *
 * Event names MUST be globally unique AND MUST NOT be substrings of one another. The substring rule
 * exists because downstream tooling (log greps, `TIMEOUT_<EventClassName>` env vars, prompt
 * "recent events" blocks) matches event names as text; `TabClosedEvent` vs `TabClosedEventV2` would
 * make those matches ambiguous.
 *
 * The check runs at registration, which is import time when a module calls
 * {@linkcode registerEvent} next to its class declarations.
 */

import { EventNameCollisionError } from './errors.ts';
import type { EventClass } from './types.ts';

const VALID_EVENT_NAME = /^[A-Z][A-Za-z0-9]*$/;

/** A namespace of event names. One process-wide instance is the norm; tests may make their own. */
export class EventNameRegistry {
	readonly #byName = new Map<string, EventClass>();

	/** Number of registered event classes. */
	get size(): number {
		return this.#byName.size;
	}

	/** Registered names, in registration order. */
	names(): readonly string[] {
		return [...this.#byName.keys()];
	}

	/** Looks up a class by its event name. */
	get(name: string): EventClass | undefined {
		return this.#byName.get(name);
	}

	/** `true` when this exact class is registered under its own name. */
	has(cls: EventClass): boolean {
		return this.#byName.get(cls.eventName) === cls;
	}

	/**
	 * Registers `cls`. Idempotent for the same class; throws {@linkcode EventNameCollisionError} on a
	 * different class with the same name, on a substring overlap, or on a non-PascalCase name.
	 */
	register(cls: EventClass): void {
		const name = cls.eventName;
		if (typeof name !== 'string' || !VALID_EVENT_NAME.test(name)) {
			throw new EventNameCollisionError(String(name), '', 'invalid');
		}
		const existing = this.#byName.get(name);
		if (existing !== undefined) {
			if (existing === cls) return;
			throw new EventNameCollisionError(name, name, 'duplicate');
		}
		for (const other of this.#byName.keys()) {
			if (other.includes(name) || name.includes(other)) {
				throw new EventNameCollisionError(name, other, 'substring');
			}
		}
		this.#byName.set(name, cls);
	}

	/** Drops every registration. Test seam; production code registers once at import. */
	clear(): void {
		this.#byName.clear();
	}
}

/** The registry every bus uses unless handed its own. */
export const globalEventRegistry: EventNameRegistry = new EventNameRegistry();

/**
 * Registers an event class and returns it, so declarations can stay a single statement:
 *
 * ```ts
 * export class NavigateToUrlEvent extends BaseEvent<void> { static override timeoutSec = 30; }
 * registerEvent(NavigateToUrlEvent);
 * ```
 */
export function registerEvent<C extends EventClass>(cls: C, registry: EventNameRegistry = globalEventRegistry): C {
	registry.register(cls);
	return cls;
}

/** Registers a batch of event classes in one call (an `events.ts` module footer). */
export function registerEvents(
	classes: readonly EventClass[],
	registry: EventNameRegistry = globalEventRegistry,
): void {
	for (const cls of classes) registry.register(cls);
}
