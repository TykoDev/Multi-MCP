/**
 * `on<EventName>` auto-registration (ARCHITECTURE.md §4.5, D-BUS1).
 *
 * Watchdogs and services declare handlers as methods named `on<EventClassName>`; `attach()` calls
 * {@linkcode registerHandlers} to subscribe them all and keeps the returned function for `detach()`.
 * When the owner declares `LISTENS_TO` / `EMITS`, registration asserts that the declaration and the
 * method set agree — a stale declaration is a bug that surfaces at attach time, not in production.
 */

import type { EventBus } from './bus.ts';
import { HandlerDeclarationError } from './errors.ts';
import type { BaseEvent } from './event.ts';
import type { EventClass, EventHandler, HandlerWrapper } from './types.ts';

/** Methods whose name starts with `on` followed by an upper-case letter are handler candidates. */
const HANDLER_METHOD_PATTERN = /^on([A-Z][A-Za-z0-9]*)$/;

/** Static declarations an owner may carry (read from the constructor, or from the instance). */
export interface EventDeclarations {
	LISTENS_TO?: readonly EventClass[];
	EMITS?: readonly EventClass[];
}

/** One discovered `on<EventName>` method. */
export interface HandlerMethod {
	readonly methodName: string;
	readonly eventName: string;
	readonly fn: EventHandler<BaseEvent<unknown>>;
}

/** Options for {@linkcode registerHandlers}. */
export interface RegisterHandlersOptions {
	/** Skip `on<Name>` methods whose event class is unknown instead of throwing. */
	ignoreUnknown?: boolean;
	/** Overrides the bus-level handler wrapper for these subscriptions. */
	wrap?: HandlerWrapper | null;
}

/**
 * Discovers `on<EventName>` methods on `owner`, walking its prototype chain (subclass overrides win).
 * Getters are never invoked — only data properties holding functions qualify.
 */
export function findHandlerMethods(owner: object): HandlerMethod[] {
	const found = new Map<string, HandlerMethod>();
	let current: object | null = owner;
	while (current !== null && current !== Object.prototype) {
		for (const methodName of Object.getOwnPropertyNames(current)) {
			if (found.has(methodName)) continue;
			const match = HANDLER_METHOD_PATTERN.exec(methodName);
			if (match === null) continue;
			const eventName = match[1];
			if (eventName === undefined) continue;
			const descriptor = Object.getOwnPropertyDescriptor(current, methodName);
			if (descriptor === undefined || typeof descriptor.value !== 'function') continue;
			// Owner methods are typed against their concrete event; the bus only ever hands them an
			// instance of the class they were resolved from.
			const fn = (descriptor.value as (...args: never[]) => unknown).bind(owner) as EventHandler<BaseEvent<unknown>>;
			found.set(methodName, { methodName, eventName, fn });
		}
		current = Object.getPrototypeOf(current);
	}
	return [...found.values()];
}

/** Reads `LISTENS_TO` / `EMITS` from the owner's constructor, falling back to the instance. */
export function readDeclarations(owner: object): EventDeclarations {
	const fromClass = owner.constructor as unknown as EventDeclarations | undefined;
	const fromInstance = owner as EventDeclarations;
	return {
		LISTENS_TO: fromClass?.LISTENS_TO ?? fromInstance.LISTENS_TO,
		EMITS: fromClass?.EMITS ?? fromInstance.EMITS,
	};
}

/**
 * Subscribes every `on<EventName>` method of `owner` to `bus` and returns the detach function.
 *
 * Attaching the same owner twice throws {@linkcode DuplicateHandlerError} (subscriptions made before
 * the throw are rolled back, so a failed attach leaves no half-registered owner behind).
 */
export function registerHandlers(
	bus: EventBus,
	owner: object,
	options: RegisterHandlersOptions = {},
): () => void {
	const methods = findHandlerMethods(owner);
	const declarations = readDeclarations(owner);
	const listensTo = declarations.LISTENS_TO;
	const byName = new Map<string, EventClass>();

	// Declared classes are registered here so the global uniqueness/substring assertion also covers
	// events an owner only emits.
	for (const cls of listensTo ?? []) {
		_assertEventClass(cls, owner, 'LISTENS_TO');
		bus.registry.register(cls);
		byName.set(cls.eventName, cls);
	}
	for (const cls of declarations.EMITS ?? []) {
		_assertEventClass(cls, owner, 'EMITS');
		bus.registry.register(cls);
	}

	const resolved: { cls: EventClass; method: HandlerMethod }[] = [];
	for (const method of methods) {
		const declared = byName.get(method.eventName);
		if (declared === undefined && listensTo !== undefined) {
			throw new HandlerDeclarationError(
				`${_ownerName(owner)}.${method.methodName} handles ${method.eventName}, ` +
					'which is missing from its LISTENS_TO declaration',
			);
		}
		const cls = declared ?? bus.registry.get(method.eventName);
		if (cls === undefined) {
			if (options.ignoreUnknown === true) continue;
			throw new HandlerDeclarationError(
				`${_ownerName(owner)}.${method.methodName} references unknown event ${method.eventName}: ` +
					'declare LISTENS_TO, register the event class, or pass { ignoreUnknown: true }',
			);
		}
		resolved.push({ cls, method });
	}

	if (listensTo !== undefined) {
		const handled = new Set(resolved.map((r) => r.cls.eventName));
		for (const cls of listensTo) {
			if (handled.has(cls.eventName)) continue;
			throw new HandlerDeclarationError(
				`${_ownerName(owner)} declares LISTENS_TO ${cls.eventName} but has no on${cls.eventName} method`,
			);
		}
	}

	const unsubscribes: (() => void)[] = [];
	try {
		for (const { cls, method } of resolved) {
			unsubscribes.push(bus.on(cls, method.fn, {
				owner,
				key: method.methodName,
				handlerName: `${_ownerName(owner)}.${method.methodName}`,
				wrap: options.wrap,
			}));
		}
	} catch (error) {
		for (const off of unsubscribes) off();
		throw error;
	}

	return () => {
		for (const off of unsubscribes) off();
		unsubscribes.length = 0;
	};
}

function _assertEventClass(cls: EventClass | undefined, owner: object, field: 'LISTENS_TO' | 'EMITS'): void {
	if (cls === undefined || typeof cls !== 'function' || typeof cls.eventName !== 'string') {
		throw new HandlerDeclarationError(`${_ownerName(owner)}.${field} contains a value that is not an event class`);
	}
}

function _ownerName(owner: object): string {
	return owner.constructor?.name ?? 'anonymous';
}
