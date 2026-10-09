/**
 * Shared type surface for `@tykotech/bus` (AGENTS.md §3: shared types live in `src/types.ts`).
 *
 * This file declares types only — no runtime values — so it can be imported from anywhere in the
 * package without creating an initialisation cycle.
 */

import type { BaseEvent } from './event.ts';

/**
 * Reads a single environment variable, returning `undefined` when unset or unreadable.
 *
 * Injectable so that timeout overrides are testable without `--allow-env` and so that embedders can
 * supply their own config source. D-CFG1 requires env to be read through a getter at use time, never
 * snapshotted at import.
 */
export type EnvSource = (name: string) => string | undefined;

/**
 * Minimal structured logger seam.
 *
 * `@tykotech/bus` is leaf infrastructure and MUST NOT import `@tykotech/browser` (which owns the `@std/log`
 * facade), so it accepts this three-method shape instead. `@tykotech/browser`'s `Logger` satisfies it
 * structurally.
 */
export interface BusLogger {
	debug(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

/** Static members every event class carries (see {@linkcode BaseEvent}). */
export interface EventStatics {
	/** Class name; globally unique and non-substring-overlapping across the registry. */
	readonly eventName: string;
	/** Default per-handler timeout in seconds; `<= 0` disables the timeout. */
	timeoutSec: number;
}

/**
 * A constructable (or abstract) event class token, usable as a subscription key.
 *
 * `never[]` in the constructor signature keeps arbitrary concrete constructor parameter lists
 * assignable without reaching for `any`.
 */
export type EventClass<E extends BaseEvent<unknown> = BaseEvent<unknown>> =
	& (abstract new (...args: never[]) => E)
	& EventStatics;

/** Extracts the result type a given event class promises. */
export type EventResultOf<E> = E extends BaseEvent<infer R> ? R : never;

/** Per-invocation context handed to every handler as its second argument. */
export interface HandlerContext {
	/** Aborts when the handler's timeout elapses or when the bus is force-stopped. */
	readonly signal: AbortSignal;
	/** Stable label used in logs and timeout errors. */
	readonly handlerName: string;
	/** Effective timeout for this invocation, in seconds (`0` = disabled). */
	readonly timeoutSec: number;
}

/** A subscriber. Returning `undefined` means "no opinion" and is not a meaningful `eventResult`. */
export type EventHandler<E extends BaseEvent<unknown> = BaseEvent<unknown>> = (
	event: E,
	context: HandlerContext,
) => unknown;

/** Identifying metadata passed to a {@linkcode HandlerWrapper}. */
export interface HandlerMeta {
	readonly eventName: string;
	readonly handlerName: string;
	readonly owner: object | null;
}

/** Decorates every handler registered on a bus (used for the circuit breaker and repair hook). */
export type HandlerWrapper = (
	handler: EventHandler<BaseEvent<unknown>>,
	meta: HandlerMeta,
) => EventHandler<BaseEvent<unknown>>;

/** Result of one handler invocation. */
export interface HandlerOutcome<T = unknown> {
	readonly handlerName: string;
	readonly status: 'fulfilled' | 'rejected';
	readonly value: T | undefined;
	readonly error: unknown;
	/** Wall-clock duration of the invocation in milliseconds. */
	readonly durationMs: number;
}

/**
 * Options for {@linkcode EventHandle.eventResult}.
 *
 * ERRATUM(M0-bus-6): the specs never state the defaults. Both flags default to `false`, matching the
 * ARCHITECTURE.md §4 example which passes `{ raiseIfAny: true }` explicitly.
 */
export interface EventResultOptions {
	/** Re-throw the first handler error (including timeouts) instead of ignoring it. */
	raiseIfAny?: boolean;
	/** Throw {@linkcode NoHandlerResultError} when no handler returned a meaningful value. */
	raiseIfNone?: boolean;
}

/**
 * Awaitable handle returned by `dispatch()`.
 *
 * Awaiting the handle resolves once **all** handlers have settled, and rejects with the first
 * handler error (a timeout counts as one). Attaching no continuation is safe: the underlying
 * settlement promise never rejects, so an un-awaited dispatch cannot produce an unhandled rejection.
 */
export interface EventHandle<T> extends Promise<void> {
	/** The dispatched event instance. */
	readonly event: BaseEvent<T>;
	/** Per-handler outcomes, in registration order. Never rejects. */
	outcomes(): Promise<readonly HandlerOutcome<T>[]>;
	eventResult(options: EventResultOptions & { raiseIfNone: true }): Promise<T>;
	eventResult(options?: EventResultOptions): Promise<T | undefined>;
}

/**
 * Injected connection-state provider backing the circuit breaker.
 *
 * `@tykotech/bus` deliberately knows nothing about CDP; `@tykotech/browser` supplies the CDP-flavoured
 * implementation (ARCHITECTURE.md §4.6, §7.4).
 */
export interface ConnectionPolicy {
	/** `true` when the underlying transport is usable right now. */
	isConnected(): boolean;
	/**
	 * `true` while a reconnect attempt sequence is in flight. Absent means "never reconnecting".
	 *
	 * ERRATUM(M0-bus-7): ARCHITECTURE.md §4.6 needs "disconnected → skip" and "reconnecting → wait" to
	 * be distinguishable, which `isConnected()` alone cannot express.
	 */
	isReconnecting?(): boolean;
	/** Resolves `true` once reconnected, `false` if the attempt sequence gave up. */
	waitForReconnect(signalOrMs: AbortSignal | number): Promise<boolean>;
	/** Lifecycle events bypass the breaker entirely and always run. */
	isLifecycleEvent(event: BaseEvent<unknown>): boolean;
}
