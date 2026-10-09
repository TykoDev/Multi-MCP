/**
 * @module
 * Signal binding for a CDP client — ERRATUM(E-52), lifted out of `watchdogs/base.ts` by
 * ERRATUM(E-62) so the watchdogs and `BrowserSession` share one implementation.
 *
 * Moved **verbatim**, for the reason ERRATUM(CANCEL-0) gives: copying it into the second consumer is
 * the `isActuallyScrollable` failure mode `gate:duplicates` exists to catch, and importing it *from*
 * `watchdogs/base.ts` would make the browser layer depend on a leaf watchdog. `browser/` is where
 * both consumers can reach it without either owning it.
 *
 * ## What this is for
 *
 * The bus gives each handler an `AbortSignal` and rejects its dispatch at `timeoutSec`, but it cannot
 * *stop* the handler: 53 of the 54 handlers audited never read the signal, so a handler that blew its
 * budget kept issuing CDP traffic at a browser the system had already given up on, and nothing
 * observed it. Filesystem escapes were caught by Deno's op sanitizer; CDP escapes are audited by
 * nothing.
 *
 * A call made through a bound view after the budget blows is rejected by `@tykotech/cdp`'s
 * `AbortSignal.any` composition **before it reaches the socket**, and an in-flight call settles at the
 * abort instead of waiting out its own 60 s request timeout.
 *
 * ## The one property every consumer relies on
 *
 * The handler's signal is **composed with**, never **replaces**, one the call site supplied itself.
 * A call that already had its own cancellation keeps it and gains a second reason to stop.
 */

import type { CdpClient } from '@tykotech/cdp';

/**
 * The one field of a CDP call's `opts` this module has an opinion about.
 *
 * Deliberately *not* a restatement of `@tykotech/cdp`'s `CdpSendOptions`, which is not on that package's
 * export surface: the rest of the options object is spread through untouched, so there is no second
 * declaration of that shape to drift out of step with the first.
 */
export interface CdpCallSignal {
	signal?: AbortSignal;
}

/**
 * A view of `client` whose every command carries `signal`.
 *
 * Implemented as a `Proxy` rather than a hand-built object for two reasons. It stays correct as
 * `@tykotech/cdp`'s domain manifest grows — a facade enumerating domains would silently omit any method
 * added later, which is the "check that cannot fire" shape this whole exercise exists to avoid. And
 * `CdpClient` carries `#private` fields, so no object literal is assignable to it; a facade with a
 * narrower type would force every helper that takes a `CdpClient` to be re-typed, turning a
 * cancellation fix into a package-wide signature churn.
 *
 * `Reflect.get(target, prop, target)` — receiver `target`, not the proxy — is load-bearing: the
 * client's getters read `#private` state, which is unreachable through any other receiver.
 */
export function bindCdpSignal(client: CdpClient, signal: AbortSignal): CdpClient {
	const domains = new Map<string, unknown>();
	const send = new Proxy(client.send, {
		get(target, domain, receiver) {
			if (typeof domain !== 'string') return Reflect.get(target, domain, receiver);
			const cached = domains.get(domain);
			if (cached !== undefined) return cached;
			const methods: unknown = Reflect.get(target, domain, receiver);
			if (typeof methods !== 'object' || methods === null) return methods;
			const bound = new Proxy(methods as Record<string, unknown>, {
				get(methodTarget, method, methodReceiver) {
					const command: unknown = Reflect.get(methodTarget, method, methodReceiver);
					if (typeof command !== 'function') return command;
					const call = command as (params?: unknown, sessionId?: string, opts?: CdpCallSignal) => unknown;
					return (params?: unknown, sessionId?: string, opts?: CdpCallSignal): unknown =>
						call(params, sessionId, withSignal(opts, signal));
				},
			});
			domains.set(domain, bound);
			return bound;
		},
	});

	return new Proxy(client, {
		get(target, prop, _receiver) {
			if (prop === 'send') return send;
			if (prop === 'sendRaw') {
				return (method: string, params?: Record<string, unknown>, sessionId?: string, opts?: CdpCallSignal) =>
					target.sendRaw(method, params, sessionId, withSignal(opts, signal));
			}
			const value: unknown = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

/** The handler's signal, composed with (never replacing) one the call site supplied itself. */
export function withSignal<T extends CdpCallSignal>(opts: T | undefined, signal: AbortSignal): T & CdpCallSignal {
	const own = opts?.signal;
	return {
		...(opts ?? {} as T),
		signal: own === undefined ? signal : AbortSignal.any([own, signal]),
	};
}

/**
 * `client`, bound to `signal` when there is one — the shared body of every `cdpFor(context)`.
 *
 * `signal === undefined` returns the bare client, for the reason `handlerBudget(undefined)` is
 * infinite: work invoked outside a dispatch (a test, a timer, another watchdog) has no budget and
 * must keep the unbudgeted behaviour rather than silently receive an already-aborted signal.
 */
export function cdpBoundTo(client: CdpClient, signal: AbortSignal | undefined): CdpClient {
	return signal === undefined ? client : bindCdpSignal(client, signal);
}
