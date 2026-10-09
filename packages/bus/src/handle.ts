/**
 * `EventHandle` — the awaitable returned by `dispatch()` (ARCHITECTURE.md §4.2).
 *
 * Two settlement views over one run:
 *  - `await handle` resolves when **all** handlers have settled, rejecting with the first handler
 *    error (a timeout counts as one);
 *  - `handle.eventResult(...)` yields the single meaningful handler return value.
 *
 * The underlying settlement promise never rejects; each `then`/`catch`/`finally` derives a fresh
 * promise from it. An un-awaited `dispatch()` therefore cannot raise an unhandled rejection, which
 * matters because dispatch is fire-and-forget in most watchdog code.
 */

import type { BaseEvent } from './event.ts';
import { NoHandlerResultError } from './errors.ts';
import type { EventHandle, EventResultOptions, HandlerOutcome } from './types.ts';

/**
 * First rejected outcome, in handler-registration order.
 *
 * Returns the outcome rather than the error itself so that a handler which threw a falsy or
 * `undefined` reason is still detected.
 */
export function firstRejected<T>(outcomes: readonly HandlerOutcome<T>[]): HandlerOutcome<T> | undefined {
	return outcomes.find((outcome) => outcome.status === 'rejected');
}

/** Outcomes that returned something other than `undefined` ("no opinion"). `null` is meaningful. */
export function meaningfulOutcomes<T>(outcomes: readonly HandlerOutcome<T>[]): HandlerOutcome<T>[] {
	return outcomes.filter((o) => o.status === 'fulfilled' && o.value !== undefined);
}

class EventHandleImpl<T> implements EventHandle<T> {
	readonly #settled: Promise<readonly HandlerOutcome<T>[]>;

	constructor(readonly event: BaseEvent<T>, settled: Promise<readonly HandlerOutcome<T>[]>) {
		// The run promise is contractually non-rejecting; guard anyway so a bug here can never surface
		// as an unhandled rejection on a dispatch nobody awaited.
		this.#settled = settled.catch((error) => [{
			handlerName: '<bus>',
			status: 'rejected' as const,
			value: undefined,
			error,
			durationMs: 0,
		}]);
	}

	get [Symbol.toStringTag](): string {
		return 'EventHandle';
	}

	outcomes(): Promise<readonly HandlerOutcome<T>[]> {
		return this.#settled.then((outcomes) => outcomes);
	}

	#completion(): Promise<void> {
		return this.#settled.then((outcomes) => {
			const rejected = firstRejected(outcomes);
			if (rejected !== undefined) throw rejected.error;
		});
	}

	then<TResult1 = void, TResult2 = never>(
		onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.#completion().then(onfulfilled, onrejected);
	}

	catch<TResult = never>(
		onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
	): Promise<void | TResult> {
		return this.#completion().catch(onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<void> {
		return this.#completion().finally(onfinally);
	}

	eventResult(options: EventResultOptions & { raiseIfNone: true }): Promise<T>;
	eventResult(options?: EventResultOptions): Promise<T | undefined>;
	async eventResult(options?: EventResultOptions): Promise<T | undefined> {
		const outcomes = await this.#settled;
		if (options?.raiseIfAny === true) {
			const rejected = firstRejected(outcomes);
			if (rejected !== undefined) throw rejected.error;
		}
		const meaningful = meaningfulOutcomes(outcomes);
		const first = meaningful[0];
		if (first === undefined) {
			if (options?.raiseIfNone === true) {
				throw new NoHandlerResultError(this.event.eventType, this.event.eventId, outcomes.length);
			}
			return undefined;
		}
		return first.value;
	}
}

/** Builds a handle over a settlement promise that resolves with per-handler outcomes. */
export function createEventHandle<T>(
	event: BaseEvent<T>,
	settled: Promise<readonly HandlerOutcome<T>[]>,
): EventHandle<T> {
	return new EventHandleImpl(event, settled);
}

/** Builds an already-settled handle (no handlers ran) — used by the post-`stop()` no-op path. */
export function createSettledHandle<T>(
	event: BaseEvent<T>,
	outcomes: readonly HandlerOutcome<T>[] = [],
): EventHandle<T> {
	return new EventHandleImpl(event, Promise.resolve(outcomes));
}
