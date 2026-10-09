/**
 * @module
 * `BaseWatchdog` — the shared attach/detach contract every watchdog of ARCHITECTURE.md §6 extends.
 *
 * Contract owners: SPECS/ARCHITECTURE.md §4.5 (`on<EventName>` auto-registration, `LISTENS_TO` /
 * `EMITS` declarations asserted at registration), §4.6/§4.7 (handlers are wrapped by the bus's
 * circuit breaker and repair hook — a watchdog never implements either itself), §6 (the 14
 * watchdogs), AGENTS.md §3 ("subscribe in `attach()`, unsubscribe in `detach()`, never hold the bus
 * across a CDP disconnect").
 *
 * ## What a subclass gets
 *
 * ```ts
 * class PermissionsWatchdog extends BaseWatchdog {
 * 	static override readonly LISTENS_TO = [BrowserConnectedEvent];
 * 	static override readonly EMITS = [BrowserErrorEvent];
 *
 * 	async onBrowserConnectedEvent(_event: BrowserConnectedEvent, context?: HandlerContext): Promise<void> {
 * 		await this.cdpFor(context).send.Browser.grantPermissions({ permissions: this.profile.permissions });
 * 	}
 * }
 * const watchdog = new PermissionsWatchdog(session);
 * watchdog.attach();   // registers every on<EventName> method, asserts the declarations
 * watchdog.detach();   // unregisters all of them; safe to call twice
 * ```
 *
 * - {@linkcode BaseWatchdog.attach} wires every `on<EventName>` method through `registerHandlers`,
 *   which asserts `LISTENS_TO` against the actual method set. A stale declaration fails at attach
 *   time, not in production.
 * - {@linkcode BaseWatchdog.bus}, {@linkcode BaseWatchdog.cdpFor}, {@linkcode BaseWatchdog.sessions},
 *   {@linkcode BaseWatchdog.profile} and {@linkcode BaseWatchdog.logger} are the whole surface a
 *   watchdog needs. `cdp`/`sessions` throw {@linkcode CdpDisconnectedError} rather than handing back
 *   `null`, so a handler that runs anyway gets a typed failure instead of a `TypeError`.
 * - **A handler reaches CDP through {@linkcode BaseWatchdog.cdpFor}, never through
 *   {@linkcode BaseWatchdog.cdp}** — ERRATUM(E-52/E-56); see `cdpFor`'s own note and
 *   `packages/core/scripts/cdp_facade_gate.ts`.
 * - Optional setup/teardown hooks are named {@linkcode BaseWatchdog.afterAttach} and
 *   {@linkcode BaseWatchdog.beforeDetach} — **deliberately not** `onAttach`/`onDetach`, because
 *   `registerHandlers` treats every `on<Capital…>` method as a handler for an event of that name and
 *   would reject the class at attach time. Subclasses must keep that rule: no method may be named
 *   `on<Something>` unless `Something` is a real event class.
 */

import { type EventBus, type EventClass, registerHandlers } from '@tykotech/bus';
import type { BusLogger, HandlerContext } from '@tykotech/bus';
import type { CdpClient } from '@tykotech/cdp';
import { BrowserError, CdpDisconnectedError } from '../errors.ts';
import type { BrowserProfile } from '../types.ts';
import type { SessionManager } from '../browser/session_manager.ts';
import { cdpBoundTo } from '../browser/cdp_signal.ts';

/**
 * What a watchdog may read from its owning session.
 *
 * Declared structurally rather than as `BrowserSession` so a watchdog contract test can stand one up
 * without a browser, and so `base.ts` does not import `session.ts` (which imports the watchdogs).
 */
export interface WatchdogHost {
	readonly eventBus: EventBus;
	readonly profile: BrowserProfile;
	readonly logger: BusLogger;
	/** `null` until `connect()` has run and after teardown. */
	readonly cdpClient: CdpClient | null;
	/** `null` until `connect()` has run and after teardown. */
	readonly sessionManager: SessionManager | null;
	/** The endpoint this session is attached to, `null` before start. */
	readonly cdpUrl: string | null;
	/** `true` when this process owns the browser subprocess (launch mode, D-BROWSER1). */
	readonly isLocal: boolean;
}

/** Thrown for attach/detach misuse; never a bare string (AGENTS.md §3). */
export class WatchdogError extends BrowserError {
	override readonly name: string = 'WatchdogError';
}

/**
 * Base class for the 14 watchdogs of ARCHITECTURE.md §6.
 *
 * Attach order is significant (LocalBrowserWatchdog must exist before `BrowserLaunchEvent` is
 * dispatched); ordering is the session's job, not the base class's.
 */
export abstract class BaseWatchdog {
	/**
	 * Event classes this watchdog handles. `registerHandlers` asserts it matches the `on<EventName>`
	 * methods exactly — every declared class needs a method and every method needs a declaration.
	 */
	static readonly LISTENS_TO: readonly EventClass[] = [];

	/** Event classes this watchdog dispatches. Registered for the global name-uniqueness assertion. */
	static readonly EMITS: readonly EventClass[] = [];

	protected readonly host: WatchdogHost;
	#detach: (() => void) | null = null;

	constructor(host: WatchdogHost) {
		this.host = host;
	}

	/** Class name, used in logs and errors. */
	get name(): string {
		return this.constructor.name;
	}

	get attached(): boolean {
		return this.#detach !== null;
	}

	protected get bus(): EventBus {
		return this.host.eventBus;
	}

	protected get profile(): BrowserProfile {
		return this.host.profile;
	}

	protected get logger(): BusLogger {
		return this.host.logger;
	}

	/**
	 * The live CDP client, with **no** cancellation bound. Throws when the transport is gone rather
	 * than returning `null`.
	 *
	 * Reserved for work that is not running inside a bus dispatch (`afterAttach` listeners, monitor
	 * timers) and for the two SecurityWatchdog containment handlers that must not be cancellable.
	 * Everything reached from a handler goes through {@linkcode BaseWatchdog.cdpFor} instead;
	 * `packages/core/scripts/cdp_facade_gate.ts` holds that as a closed set.
	 */
	protected get cdp(): CdpClient {
		const client = this.host.cdpClient;
		if (client === null || client.state !== 'open') {
			throw new CdpDisconnectedError(`${this.name} needs a CDP connection`);
		}
		return client;
	}

	/**
	 * The live CDP client with `context`'s abort signal pre-bound to every command — ERRATUM(E-52).
	 *
	 * ## What this is for
	 *
	 * The bus gives each handler an `AbortSignal` and rejects its dispatch at `timeoutSec`, but it
	 * cannot *stop* the handler: 53 of the 54 handlers audited never read the signal, so a handler that
	 * blew its budget kept issuing CDP traffic against a browser the system had already given up on,
	 * and nothing observed it. Filesystem escapes were caught by Deno's op sanitizer; CDP escapes are
	 * audited by nothing.
	 *
	 * A call made through this accessor after the budget blows is rejected by `@tykotech/cdp`'s
	 * `AbortSignal.any` composition **before it reaches the socket**, and an in-flight call is settled
	 * at the abort instead of waiting out its own 60 s request timeout.
	 *
	 * ## Why a facade and not a check
	 *
	 * A lint rule for "this handler takes side effects" needs interprocedural analysis through several
	 * layers of helpers, and any approximation becomes another check that cannot fire (§9.45). A
	 * type-level requirement is impossible: TypeScript accepts a lower-arity function wherever a
	 * higher-arity one is expected, so a handler may always simply omit the `context` parameter. What
	 * *is* enforceable is a syntactic one — "no watchdog handler references bare `this.cdp`" — and this
	 * accessor is what makes obeying it possible.
	 *
	 * ## Why `context` is optional
	 *
	 * Same reason as `handlerBudget(undefined)`: a handler invoked directly — from a test, a timer, or
	 * another watchdog — has no dispatch and therefore no budget, and must keep the unbudgeted
	 * behaviour rather than silently receive an already-aborted signal. `cdpFor(undefined)` is the bare
	 * client.
	 *
	 * A caller that passes its own `opts.signal` keeps it: the two are composed, not replaced.
	 */
	protected cdpFor(context: HandlerContext | undefined): CdpClient {
		return cdpBoundTo(this.cdp, context?.signal);
	}

	/** The session/target pool. Throws when the session has not connected yet. */
	protected get sessions(): SessionManager {
		const manager = this.host.sessionManager;
		if (manager === null) throw new CdpDisconnectedError(`${this.name} needs an active SessionManager`);
		return manager;
	}

	/**
	 * Subscribes every `on<EventName>` method to the session's bus.
	 *
	 * Handlers are wrapped by the bus-level {@linkcode HandlerWrapper} (the circuit breaker + repair
	 * hook of §4.6/§4.7) — a watchdog never re-implements either. Attaching twice throws, matching the
	 * D-BUS1 rule that duplicate registration is an error.
	 */
	attach(): void {
		if (this.#detach !== null) throw new WatchdogError(`${this.name} is already attached`);
		this.#detach = registerHandlers(this.bus, this);
		this.afterAttach();
	}

	/** Unsubscribes everything. Idempotent: detaching a detached watchdog is a no-op, not an error. */
	detach(): void {
		const off = this.#detach;
		if (off === null) return;
		this.#detach = null;
		try {
			this.beforeDetach();
		} finally {
			off();
		}
	}

	/**
	 * Optional post-subscription setup (CDP listeners, timers).
	 *
	 * NOT named `onAttach`: `registerHandlers` would read that as a handler for an `AttachEvent`.
	 */
	protected afterAttach(): void {}

	/** Optional pre-unsubscription teardown. NOT named `onDetach`, for the same reason. */
	protected beforeDetach(): void {}
}
