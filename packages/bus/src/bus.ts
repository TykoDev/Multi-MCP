/**
 * `EventBus` — the typed async event bus (D-BUS1, ARCHITECTURE.md §4).
 *
 * Semantics that are contract, not implementation detail:
 *  - `dispatch()` enqueues and returns immediately; it never throws (a synchronous failure comes
 *    back as an already-rejected handle instead).
 *  - Handlers for one event run **sequentially in registration order**; every handler runs even if
 *    an earlier one threw, because awaiting the handle must mean "all handlers finished"
 *    (ERRATUM(M0-bus-5): the spec's SecurityWatchdog example reads as if a throw aborts the chain;
 *    the normative sentence in ARCHITECTURE.md §4.2 wins, so M1 must veto navigation explicitly).
 *    ERRATUM(E-56): registration order holds **through a timeout too** — see
 *    {@linkcode DEFAULT_HANDLER_ABANDON_GRACE_MS}.
 *  - Handlers for *different* events run concurrently (ERRATUM(M0-bus-8)). A serial cross-event queue
 *    would deadlock the moment a handler awaited an event it dispatched itself, which the browser
 *    layer does routinely (`BrowserStartEvent` → `BrowserLaunchEvent`).
 *  - Each handler invocation gets its own timeout budget and its own `AbortSignal`.
 */

import { withDeadline } from './deadline.ts';
import { BusError, DuplicateHandlerError, EventTimeoutError } from './errors.ts';
import { type BaseEvent, eventStaticsOf, linkToParent, resolveEventTimeoutSec } from './event.ts';
import { createEventHandle, createSettledHandle } from './handle.ts';
import { DEFAULT_HISTORY_LIMIT, EventHistory } from './history.ts';
import { currentEventId, runInEventContext } from './lineage.ts';
import { consoleBusLogger } from './logger.ts';
import { type EventNameRegistry, globalEventRegistry } from './registry.ts';
import type {
	BusLogger,
	EnvSource,
	EventClass,
	EventHandle,
	EventHandler,
	HandlerContext,
	HandlerOutcome,
	HandlerWrapper,
} from './types.ts';

/** Grace period `stop()` gives in-flight handlers before it aborts them. */
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/**
 * How long a **timed-out** handler is joined before the bus starts the next one — ERRATUM(E-56).
 *
 * ## The defect
 *
 * `#invoke` settles at the deadline, but settling the *dispatch* does not stop the *handler*: its
 * promise is still running. Before this, `#runHandlers` took that settlement as permission to start
 * the next entry, so the documented "sequential in registration order" guarantee — the one E-16's
 * teardown ordering rests on — was void in precisely the condition where ordering matters. Two
 * teardown handlers could interleave, which is exactly what registering them in order was meant to
 * prevent.
 *
 * ## Why a bounded join rather than an unbounded one
 *
 * Waiting for the straggler unconditionally restores ordering perfectly and hands any handler that
 * ignores its `AbortSignal` the power to wedge the dispatch forever — trading a violated ordering
 * promise for a liveness bug, which is the worse of the two. Waiting for a bounded grace after the
 * abort keeps ordering for every handler that unwinds cooperatively (the abort has already fired, so
 * a handler built on `HandlerBudget`/`AbortSignal` returns almost immediately) and degrades to the
 * old behaviour *only* for a handler that ignores cancellation — where the bus records the fact
 * rather than pretending the guarantee held.
 *
 * One second is the same figure `@tykotech/browser`'s `HANDLER_BUDGET_RESERVE_MS` reserves for a handler to
 * unwind, and it is small (≈3 %) against the smallest real budget in ARCHITECTURE.md §8 (30 s).
 *
 * ## What is deliberately *not* joined
 *
 * The join runs **between** handlers, never after the last one. Ordering is a relation between
 * handlers; nothing follows the final entry whose order could be violated, so joining there would
 * add the grace to the latency of every timed-out dispatch, buy no ordering, and erode the separate
 * promise that a timeout rejects promptly instead of hanging. A straggler in the last slot therefore
 * still outlives its dispatch — that is E-52's escape, and it is answered on the handler side by
 * `BaseWatchdog.cdpFor(context)`, not here.
 */
export const DEFAULT_HANDLER_ABANDON_GRACE_MS = 1_000;

/** Construction options for {@linkcode EventBus}. */
export interface EventBusOptions {
	/** Label used in log fields; helps when several buses coexist. */
	name?: string;
	/** Ring capacity for {@linkcode EventBus.history}. */
	historyLimit?: number;
	/** Env getter for `TIMEOUT_<EventClassName>` overrides (D-CFG1). */
	env?: EnvSource;
	/** Structured logger; defaults to a stderr console logger. */
	logger?: BusLogger;
	/** Name registry to assert against; defaults to the process-wide one. */
	registry?: EventNameRegistry;
	/** Decorates every handler registered on this bus (circuit breaker, repair hook). */
	wrapHandler?: HandlerWrapper;
	/** Default grace period for {@linkcode EventBus.stop}. */
	stopTimeoutMs?: number;
	/**
	 * How long a timed-out handler is joined before the next one starts
	 * ({@linkcode DEFAULT_HANDLER_ABANDON_GRACE_MS}). `<= 0` disables the join, restoring the
	 * pre-E-56 behaviour; a non-finite value joins without a bound and can wedge the dispatch.
	 */
	abandonGraceMs?: number;
}

/** Options for a single subscription. */
export interface SubscribeOptions {
	/** Object that owns the handler; `(owner, key)` pairs are deduplicated. */
	owner?: object;
	/** Method name (or other stable key) within `owner`. */
	key?: string;
	/** Display name for logs and timeout errors. */
	handlerName?: string;
	/** Overrides the bus-level {@linkcode EventBusOptions.wrapHandler} for this subscription. */
	wrap?: HandlerWrapper | null;
}

interface HandlerEntry {
	readonly eventName: string;
	readonly handlerName: string;
	readonly owner: object | null;
	readonly key: string | null;
	/** Identity used for duplicate detection: the function the caller handed us. */
	readonly original: EventHandler<BaseEvent<unknown>>;
	/** Possibly wrapped function actually invoked. */
	readonly invoke: EventHandler<BaseEvent<unknown>>;
}

/**
 * One in-progress handler invocation, split into the two facts `#runHandlers` needs separately:
 * *what the dispatch will report* and *whether the handler is actually done*. Before E-56 these were
 * one promise, which is why a timeout read as "finished".
 */
interface HandlerRun<T> {
	/** The recorded outcome. Settles at the deadline when the handler overruns. */
	readonly outcome: Promise<HandlerOutcome<T>>;
	/** Settles — never rejects — when the handler's own promise settles, however late. */
	readonly finished: Promise<void>;
	/** `true` once the handler's own promise has settled. */
	isFinished(): boolean;
}

export class EventBus {
	readonly #handlers = new Map<string, HandlerEntry[]>();
	readonly #history: EventHistory;
	readonly #inflight = new Set<Promise<unknown>>();
	readonly #controllers = new Set<AbortController>();
	readonly #logger: BusLogger;
	readonly #registry: EventNameRegistry;
	readonly #env: EnvSource | undefined;
	readonly #wrapHandler: HandlerWrapper | undefined;
	readonly #stopTimeoutMs: number;
	readonly #abandonGraceMs: number;
	readonly name: string;
	#stopped = false;

	constructor(options: EventBusOptions = {}) {
		this.name = options.name ?? 'bus';
		this.#history = new EventHistory(options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
		this.#logger = options.logger ?? consoleBusLogger;
		this.#registry = options.registry ?? globalEventRegistry;
		this.#env = options.env;
		this.#wrapHandler = options.wrapHandler;
		this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		this.#abandonGraceMs = options.abandonGraceMs ?? DEFAULT_HANDLER_ABANDON_GRACE_MS;
	}

	/** `true` once {@linkcode stop} has been called; further dispatches are no-ops. */
	get stopped(): boolean {
		return this.#stopped;
	}

	/** The name registry this bus asserts against (shared process-wide unless overridden). */
	get registry(): EventNameRegistry {
		return this.#registry;
	}

	/** Bounded ring of dispatched events, oldest first. */
	get history(): readonly BaseEvent<unknown>[] {
		return this.#history.toArray();
	}

	/** The `n` most recent dispatched events, oldest first (`recentEvents` prompt block). */
	recentEvents(n: number): readonly BaseEvent<unknown>[] {
		return this.#history.recent(n);
	}

	/** Number of handlers currently subscribed to an event class. */
	handlerCount(cls: EventClass): number {
		return this.#handlers.get(cls.eventName)?.length ?? 0;
	}

	/**
	 * Subscribes `handler` to `cls`. Returns an unsubscribe function.
	 *
	 * Registering the same function twice — or the same `(owner, key)` pair twice — throws
	 * {@linkcode DuplicateHandlerError} (D-BUS1: duplicate registration MUST throw).
	 */
	on<E extends BaseEvent<unknown>>(
		cls: EventClass<E>,
		handler: EventHandler<E>,
		options: SubscribeOptions = {},
	): () => void {
		this.#registry.register(cls);
		const eventName = cls.eventName;
		const entries = this.#handlers.get(eventName) ?? [];
		// Handlers are stored erased to the base event type; `on()`'s signature keeps the call site
		// honest, and the bus only ever passes an instance of `cls` back in.
		const original = handler as EventHandler<BaseEvent<unknown>>;
		const owner = options.owner ?? null;
		const key = options.key ?? null;
		const handlerName = options.handlerName ?? _handlerLabel(owner, key, original, eventName);

		for (const entry of entries) {
			if (entry.original === original) throw new DuplicateHandlerError(eventName, handlerName);
			if (owner !== null && entry.owner === owner && entry.key === key) {
				throw new DuplicateHandlerError(eventName, handlerName);
			}
		}

		const wrapper = options.wrap === undefined ? this.#wrapHandler : options.wrap ?? undefined;
		const invoke = wrapper === undefined ? original : wrapper(original, { eventName, handlerName, owner });
		const entry: HandlerEntry = { eventName, handlerName, owner, key, original, invoke };
		entries.push(entry);
		this.#handlers.set(eventName, entries);

		return () => {
			const current = this.#handlers.get(eventName);
			if (current === undefined) return;
			const index = current.indexOf(entry);
			if (index >= 0) current.splice(index, 1);
			if (current.length === 0) this.#handlers.delete(eventName);
		};
	}

	/**
	 * Enqueues `event` and returns its handle. Never throws.
	 *
	 * Handlers are snapshotted at dispatch time and start on the next microtask, so a handler can
	 * never run synchronously inside `dispatch()`.
	 */
	dispatch<T>(event: BaseEvent<T>): EventHandle<T> {
		try {
			if (this.#stopped) {
				this.#logger.warn('dispatch after stop ignored', { bus: this.name, eventType: event.eventType });
				return createSettledHandle(event);
			}
			const statics = eventStaticsOf(event);
			this.#registry.register(event.constructor as unknown as EventClass);
			const parentId = currentEventId();
			if (parentId !== null) linkToParent(event, parentId);
			this.#history.push(event);
			const entries = [...(this.#handlers.get(event.eventType) ?? [])];
			const timeoutSec = resolveEventTimeoutSec(statics, this.#env, this.#logger);
			const settled = this.#runHandlers(event, entries, timeoutSec);
			this.#track(settled);
			return createEventHandle(event, settled);
		} catch (error) {
			this.#logger.error('dispatch failed', { bus: this.name, eventType: event.eventType, error });
			return createSettledHandle(event, [{
				handlerName: '<bus>',
				status: 'rejected',
				value: undefined,
				error,
				durationMs: 0,
			}]);
		}
	}

	/**
	 * Stops the bus: drains in-flight handlers for at most `timeoutMs`, aborting the stragglers, then
	 * makes every further dispatch a logged no-op (ARCHITECTURE.md §4.8 warm-resume protection).
	 * Idempotent and non-throwing.
	 */
	async stop(timeoutMs: number = this.#stopTimeoutMs): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		const pending = [...this.#inflight];
		if (pending.length === 0) return;
		const { timedOut } = await withDeadline(Promise.allSettled(pending), timeoutMs);
		if (!timedOut) return;
		this.#logger.warn('stop deadline elapsed, aborting in-flight handlers', {
			bus: this.name,
			pending: pending.length,
			timeoutMs,
		});
		const reason = new BusError(`event bus ${this.name} stopped`);
		for (const controller of this.#controllers) controller.abort(reason);
	}

	#track(promise: Promise<unknown>): void {
		this.#inflight.add(promise);
		promise.then(() => {}, () => {}).finally(() => this.#inflight.delete(promise));
	}

	async #runHandlers<T>(
		event: BaseEvent<T>,
		entries: readonly HandlerEntry[],
		timeoutSec: number,
	): Promise<readonly HandlerOutcome<T>[]> {
		// Yield once so `dispatch()` has returned before any handler observes the event.
		await Promise.resolve();
		const outcomes: HandlerOutcome<T>[] = [];
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (entry === undefined) continue;
			const run = this.#invoke(entry, event, timeoutSec);
			outcomes.push(await run.outcome);
			// ERRATUM(E-56): the outcome settling is not the handler finishing. Starting the next entry
			// while this one is still executing is what voided the registration-order guarantee. There is
			// nothing after the last entry to order, so the tail is deliberately not joined.
			if (index + 1 < entries.length) await this.#joinStraggler(entry, event, run);
		}
		return outcomes;
	}

	/**
	 * Holds the chain until a timed-out handler unwinds, for at most `abandonGraceMs`.
	 *
	 * Returning without the handler having finished is the abandonment the warning names: from that
	 * point the two handlers really are concurrent, and saying so beats a silent violation of a
	 * documented guarantee.
	 */
	async #joinStraggler<T>(entry: HandlerEntry, event: BaseEvent<T>, run: HandlerRun<T>): Promise<void> {
		if (run.isFinished()) return;
		// `withDeadline` reads `ms <= 0` as "no deadline", which here would mean an *unbounded* join —
		// the exact liveness bug the bound exists to avoid. Zero must mean "do not join at all".
		if (!(this.#abandonGraceMs > 0)) return;
		const { timedOut } = await withDeadline(run.finished, this.#abandonGraceMs);
		if (!timedOut) return;
		this.#logger.warn('handler abandoned after its grace period; registration order not guaranteed', {
			bus: this.name,
			eventType: event.eventType,
			handler: entry.handlerName,
			graceMs: this.#abandonGraceMs,
		});
	}

	#invoke<T>(entry: HandlerEntry, event: BaseEvent<T>, timeoutSec: number): HandlerRun<T> {
		const controller = new AbortController();
		this.#controllers.add(controller);
		const context: HandlerContext = {
			signal: controller.signal,
			handlerName: entry.handlerName,
			timeoutSec,
		};
		const startedAt = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finished = false;
		const done = Promise.withResolvers<void>();
		// Resolve on *either* settlement: `finished` reports that the handler stopped running, not how
		// it stopped, and it must never itself reject or the join would surface a second failure.
		const markFinished = (): void => {
			finished = true;
			done.resolve();
		};

		const outcome = (async (): Promise<HandlerOutcome<T>> => {
			try {
				const value = await new Promise<unknown>((resolve, reject) => {
					if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
						timer = setTimeout(() => {
							const error = new EventTimeoutError(event.eventType, event.eventId, entry.handlerName, timeoutSec);
							controller.abort(error);
							reject(error);
						}, timeoutSec * 1_000);
					}
					try {
						const returned = Promise.resolve(runInEventContext(event, () => entry.invoke(event, context)));
						returned.then(markFinished, markFinished);
						returned.then(resolve, reject);
					} catch (error) {
						markFinished();
						reject(error);
					}
				});
				return {
					handlerName: entry.handlerName,
					status: 'fulfilled',
					value: value as T | undefined,
					error: undefined,
					durationMs: Date.now() - startedAt,
				};
			} catch (error) {
				this.#logger.debug('handler failed', {
					bus: this.name,
					eventType: event.eventType,
					handler: entry.handlerName,
					error,
				});
				return {
					handlerName: entry.handlerName,
					status: 'rejected',
					value: undefined,
					error,
					durationMs: Date.now() - startedAt,
				};
			} finally {
				clearTimeout(timer);
				// The controller was already aborted by the timer on the only path that reaches here with
				// the handler still running, so keeping it registered would buy `stop()` nothing.
				this.#controllers.delete(controller);
			}
		})();

		return { outcome, finished: done.promise, isFinished: () => finished };
	}
}

function _handlerLabel(
	owner: object | null,
	key: string | null,
	handler: EventHandler<BaseEvent<unknown>>,
	eventName: string,
): string {
	if (owner !== null) {
		const ownerName = owner.constructor?.name ?? 'anonymous';
		return `${ownerName}.${key ?? handler.name ?? `on${eventName}`}`;
	}
	return handler.name === '' ? `anonymous:${eventName}` : handler.name;
}
