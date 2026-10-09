/**
 * Event lineage context (ARCHITECTURE.md §4.4).
 *
 * An event created or dispatched inside a handler inherits the triggering event's id as its
 * `eventParentId`. `AsyncLocalStorage` is the only mechanism in the runtime that keeps that
 * attribution correct when several dispatches interleave across `await` points — a plain
 * module-level "current event" variable would leak between concurrent handler chains.
 *
 * `node:async_hooks` is a runtime builtin (rung (a) of the D-DEP1 ladder), not a dependency: nothing
 * is fetched, locked, or vendored, and the whole surface used is one class. It is deliberately
 * confined to this file so a future register decision touches exactly one import.
 *
 * ERRATUM(M0-bus-3): the repo lint config enables `no-external-import`, whose stated purpose is
 * blocking remote `https:` imports (SECURITY-AUTH.md §9, COMPLETIONS-CRITERIA.md Q2), but the rule
 * also fires on `node:` builtin specifiers. Deno exposes no non-`node:` `AsyncLocalStorage`
 * equivalent (`Deno.AsyncVariable` / `AsyncContext` do not exist in 2.9.5), and a plain
 * module-scoped "current event" variable is provably wrong under concurrent dispatch, so the rule is
 * suppressed here with justification rather than trading correctness away.
 */

// deno-lint-ignore no-external-import -- node: builtin, not a remote/vendored dependency; see ERRATUM(M0-bus-3) above
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BaseEvent } from './event.ts';

interface EventContext {
	readonly event: BaseEvent<unknown>;
}

const storage = new AsyncLocalStorage<EventContext>();

/** The event whose handler is currently executing, or `null` at the top level. */
export function currentEvent(): BaseEvent<unknown> | null {
	return storage.getStore()?.event ?? null;
}

/** Convenience accessor for the id used as `eventParentId`. */
export function currentEventId(): string | null {
	return currentEvent()?.eventId ?? null;
}

/** Runs `fn` with `event` as the ambient triggering event, including across its `await` points. */
export function runInEventContext<T>(event: BaseEvent<unknown>, fn: () => T): T {
	return storage.run({ event }, fn);
}
