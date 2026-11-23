/**
 * Event lineage context.
 *
 * An event created or dispatched inside a handler inherits the triggering event's id as its
 * `eventParentId`. `AsyncLocalStorage` is the only mechanism in the runtime that keeps that
 * attribution correct when several dispatches interleave across `await` points — a plain
 * module-level "current event" variable would leak between concurrent handler chains.
 *
 * `node:async_hooks` is a runtime builtin, not a dependency: nothing
 * is fetched, locked, or vendored, and the whole surface used is one class. It is deliberately
 * confined to this file so replacing it touches exactly one import.
 *
 * The repo lint config enables `no-external-import`, whose purpose is blocking remote `https:`
 * imports, but the rule also fires on `node:` builtin specifiers. Deno exposes no non-`node:` `AsyncLocalStorage`
 * equivalent (`Deno.AsyncVariable` / `AsyncContext` do not exist in 2.9.5), and a plain
 * module-scoped "current event" variable is provably wrong under concurrent dispatch, so the rule is
 * suppressed here with justification rather than trading correctness away.
 */

// deno-lint-ignore no-external-import -- node: builtin, not a remote/vendored dependency; see the module note above
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
