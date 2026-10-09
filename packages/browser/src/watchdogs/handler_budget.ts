/**
 * @module
 * The cooperative handler budget — ERRATUM(KILL-1), lifted out of `local_browser.ts` by
 * ERRATUM(CANCEL-0) so the three watchdogs that needed the same repair share one implementation.
 *
 * ## Why a budget rather than an abort
 *
 * `EventBus.#invoke` aborts the handler's `AbortController` and rejects the dispatch at `timeoutSec`,
 * but it cannot *stop* a handler — nothing joins a straggler, and `bus.stop()` finds `#inflight`
 * already settled. A handler that spends its budget to the last millisecond therefore always loses
 * that race and keeps writing to the filesystem after the system gave up on it. Finishing early is
 * the only way not to be that straggler.
 *
 * ## Why cooperative rather than raced
 *
 * Neither `Deno.remove` nor `Deno.writeFile` nor `Deno.ChildProcess.kill` takes an `AbortSignal`, so
 * the only honest cancellation on offer is "check before starting the next operation". Racing a timer
 * against an op does not cancel the op — `withTimeout(Deno.remove(…), ms)` merely stops *awaiting*
 * it, which is how the side effect escaped in the first place and how Deno's op sanitizer found it.
 * The working shape is many small operations with {@linkcode HandlerBudget.expired} consulted between
 * them, so that "stop now" genuinely means "stop with nothing in flight".
 *
 * ## Why `context` is optional at every call site
 *
 * A handler invoked directly — from a test, from a timer, from another watchdog — has no dispatch and
 * therefore no budget. That case must keep the old unbudgeted behaviour rather than silently receive a
 * zero budget, which would turn every direct call into an immediate no-op. `handlerBudget(undefined)`
 * is deliberately infinite.
 *
 * Not a spec constant: ARCHITECTURE.md §8 fixes the *budgets* (`BrowserStopEvent.timeoutSec` = 45,
 * `BrowserKillEvent.timeoutSec` = 30, …), not how a handler spends one.
 */

import type { HandlerContext } from '@tykotech/bus';

/**
 * Slice of a handler's budget kept in reserve so the work returns *before* the bus's own timer fires.
 *
 * One second is enough for the last started operation to land and for the handler to unwind, and it
 * is small against the smallest budget any of the consumers runs under (30 s).
 */
export const HANDLER_BUDGET_RESERVE_MS = 1_000;

/**
 * What is left of a handler's budget, as two predicates the work consults between steps.
 */
export interface HandlerBudget {
	/** `true` once the bus aborted this handler or the budget is spent. */
	expired(): boolean;
	/** `ms`, reduced to what the budget can still pay for (`0` when it is spent). */
	clamp(ms: number): number;
	/**
	 * The context this budget was derived from, `undefined` outside a dispatch.
	 *
	 * Carried so that work threading a budget down through helpers can also reach
	 * `BaseWatchdog.cdpFor(budget.context)` — ERRATUM(E-52). Passing the budget *and* the context as
	 * two parameters would be two spellings of one fact, free to disagree; this keeps it one.
	 */
	readonly context: HandlerContext | undefined;
}

/**
 * Derives the budget from the bus's per-invocation context; no context means no budget at all.
 *
 * A synthetic context is a legitimate argument: work that runs outside a dispatch but under some
 * other cancellation (a monitor loop that a `detach()` disarms, say) can pass its own signal with
 * `timeoutSec: 0`, which yields "no deadline, but cancellable".
 */
export function handlerBudget(context: HandlerContext | undefined): HandlerBudget {
	const signal = context?.signal;
	const timeoutSec = context?.timeoutSec ?? 0;
	// `timeoutSec <= 0` is the bus's own "timeout disabled"; so is being called outside a dispatch.
	const spendable = Number.isFinite(timeoutSec) && timeoutSec > 0
		? Math.max(0, timeoutSec * 1_000 - HANDLER_BUDGET_RESERVE_MS)
		: Number.POSITIVE_INFINITY;
	const deadline = Date.now() + spendable;
	const remaining = (): number => spendable === Number.POSITIVE_INFINITY ? spendable : deadline - Date.now();
	// One predicate, two consumers: an abort must zero the clamps too, or a ladder would keep spending
	// its windows on a handler the bus has already abandoned.
	const expired = (): boolean => signal?.aborted === true || remaining() <= 0;
	return {
		expired,
		clamp: (ms) => expired() ? 0 : Math.max(0, Math.min(ms, remaining())),
		context,
	};
}
