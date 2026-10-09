/**
 * Typed error taxonomy for `@tykotech/bus` (AGENTS.md §3: never throw strings).
 *
 * Every error thrown by this package derives from {@linkcode BusError} so callers can discriminate
 * bus-infrastructure failures from handler-domain failures without string matching.
 */

/** Base class for every error raised by the event bus. */
export class BusError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'BusError';
	}
}

/**
 * Thrown at registration time when an event name is already taken by a different class, or when it
 * overlaps an existing name by substring containment (ARCHITECTURE.md §4.1).
 */
export class EventNameCollisionError extends BusError {
	constructor(
		readonly eventName: string,
		readonly conflictsWith: string,
		readonly kind: 'duplicate' | 'substring' | 'invalid',
	) {
		super(
			kind === 'invalid'
				? `Invalid event name ${JSON.stringify(eventName)}: event classes must have a non-empty PascalCase name`
				: kind === 'duplicate'
				? `Event name ${JSON.stringify(eventName)} is already registered by a different class`
				: `Event name ${JSON.stringify(eventName)} overlaps ${JSON.stringify(conflictsWith)}: ` +
					'event names must not be substrings of one another',
		);
		this.name = 'EventNameCollisionError';
	}
}

/** Thrown when a single handler invocation exceeds the event's resolved timeout. */
export class EventTimeoutError extends BusError {
	constructor(
		readonly eventType: string,
		readonly eventId: string,
		readonly handlerName: string,
		readonly timeoutSec: number,
	) {
		super(`Handler ${handlerName} for ${eventType} timed out after ${timeoutSec}s (event ${eventId})`);
		this.name = 'EventTimeoutError';
	}
}

/** Thrown when the same handler (by function identity, or by owner+method) is subscribed twice. */
export class DuplicateHandlerError extends BusError {
	constructor(readonly eventType: string, readonly handlerName: string) {
		super(`Handler ${handlerName} is already registered for ${eventType}`);
		this.name = 'DuplicateHandlerError';
	}
}

/**
 * Thrown when an `on<EventName>` method cannot be reconciled with the registry or with the owner's
 * `LISTENS_TO` / `EMITS` declarations.
 */
export class HandlerDeclarationError extends BusError {
	constructor(message: string) {
		super(message);
		this.name = 'HandlerDeclarationError';
	}
}

/** Thrown by `eventResult({ raiseIfNone: true })` when no handler produced a meaningful value. */
export class NoHandlerResultError extends BusError {
	constructor(readonly eventType: string, readonly eventId: string, readonly handlerCount: number) {
		super(
			`No handler returned a result for ${eventType} (event ${eventId}, ${handlerCount} handler(s) ran)`,
		);
		this.name = 'NoHandlerResultError';
	}
}

/**
 * Thrown by the circuit breaker when the injected connection policy never reports a successful
 * reconnect within the reconnect wait budget (ARCHITECTURE.md §4.6).
 */
export class ConnectionError extends BusError {
	constructor(readonly eventType: string, readonly waitedMs: number) {
		super(`Connection unavailable for ${eventType} after waiting ${waitedMs}ms for reconnect`);
		this.name = 'ConnectionError';
	}
}
