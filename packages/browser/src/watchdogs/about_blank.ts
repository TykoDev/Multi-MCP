/**
 * @module
 * `AboutBlankWatchdog` — the "never zero tabs" guarantee (ARCHITECTURE.md §6.3).
 *
 * > guarantees the browser never reaches zero tabs: on `TabClosedEvent` with no page targets
 * > remaining, opens a new `about:blank` tab.
 *
 * A browser with no page target is not merely empty, it is *unusable*: `getOrCreateCdpSession`
 * throws (`no page target is available`), every screenshot and state build fails, and the agent has
 * nowhere to navigate. This watchdog is the cheap invariant that makes the rest of the layer able to
 * assume a tab exists.
 *
 * ## The cosmetic screensaver is DROPPED (○, D-SCOPE1)
 *
 * §6.3's second sentence ("also injects the animated 'agent is starting' screensaver into about:blank
 * tabs") is marked ○ MAY be dropped, and DECISION-REGISTER.md §3 D-SCOPE1 names the "DVD-screensaver
 * tab animation" as a port-optional cosmetic that MAY go without a parity violation. It is dropped
 * whole, not half-built: this watchdog does not handle `TabCreatedEvent`, injects no script, and
 * never emits `AboutBlankDVDScreensaverShownEvent` (the event class stays defined in the 44-event
 * catalog, per ARCHITECTURE.md §5). ERRATUM(M1-watchdogs-rest-3) records the drop.
 *
 * ## Why it also watches the stop events
 *
 * DATA-MODEL.md §5.1.2 lists AboutBlank among `BrowserStopEvent`'s handlers and §5.1.3 lists it
 * among `BrowserStoppedEvent`'s consumers, without saying what it does with either. It disarms: a
 * teardown that closes the last tab must not race a fresh `about:blank` into a browser that is on its
 * way out. The disarm is scoped to the `SessionManager` instance that was live at stop time, so a
 * later `reset()`/reconnect — which builds a new manager — re-arms automatically rather than leaving
 * the invariant silently switched off (ERRATUM(M1-watchdogs-rest-4)).
 *
 * ## Why the decision is taken behind a round-trip barrier
 *
 * ERRATUM(M1-hardening-3): §6.3 states the trigger ("on `TabClosedEvent` with no page targets
 * remaining") without saying *when* "remaining" is measured. Measured at handler entry it is a
 * check-then-act on a value another producer is concurrently changing: real Chrome opens its own
 * replacement tab when the last one closes, and whether its `Target.targetCreated` had been
 * processed by the time this handler ran was luck. Losing that race put two tabs in a browser the
 * spec asks to have one. The observation is now taken *after* a CDP round trip: one socket, ordered
 * frames, and `SessionManager`'s `Target.targetCreated` listener writes its map synchronously, so
 * everything Chrome sent before it answered has been recorded by the time the barrier resolves. What
 * remains outside the barrier — a replacement Chrome had not yet sent — is not a race this watchdog
 * can lose, because at that instant the browser really did have zero tabs.
 */

import { delay } from '@std/async';
import type { HandlerContext } from '@tykotech/bus';
import type { TargetId } from '@tykotech/cdp';
import { BrowserStopEvent, BrowserStoppedEvent, TabClosedEvent } from '../events.ts';
import type { SessionManager } from '../browser/session_manager.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The URL a rescued browser parks on. Always allowed by the domain policy (SECURITY-AUTH §4.2 §1). */
export const ABOUT_BLANK_URL = 'about:blank';

/**
 * How long the rescue waits for the created target to appear in the `SessionManager` maps.
 *
 * Derived, not invented: `TabClosedEvent` carries a **3 s** per-handler budget (DATA-MODEL.md
 * §5.1.3), and this wait runs inside that handler alongside one `Target.createTarget` round trip.
 * 1 s leaves the round trip two thirds of the budget.
 *
 * The wait exists because `SessionManager`'s detach-driven focus recovery runs immediately *after*
 * `TabClosedEvent` and creates its own `about:blank` when it sees no page target — returning before
 * Chrome's `Target.targetCreated` lands would produce two tabs where the spec asks for one.
 */
export const ABOUT_BLANK_TAB_REGISTER_WAIT_MS = 1_000;

/** Poll cadence of that wait. Internal: the 1 s cap is the contract, not the interval. */
export const ABOUT_BLANK_TAB_POLL_INTERVAL_MS = 20;

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/** Injection seams; every default is the real implementation. */
export interface AboutBlankWatchdogOptions {
	/** Injected clock, so `FakeTime` can drive the registration wait. */
	readonly now?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class AboutBlankWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [TabClosedEvent, BrowserStopEvent, BrowserStoppedEvent];
	static override readonly EMITS = [];

	readonly #now: () => number;
	/** The manager instance a stop was observed on; a newer instance re-arms the watchdog. */
	#stoppedManager: SessionManager | null = null;
	#creating: Promise<TargetId | null> | null = null;
	#created = 0;

	constructor(host: WatchdogHost, options: AboutBlankWatchdogOptions = {}) {
		super(host);
		this.#now = options.now ?? Date.now;
	}

	// -- public surface ----------------------------------------------------------------------------

	/** How many rescue tabs this watchdog has opened. */
	get tabsCreated(): number {
		return this.#created;
	}

	/** `false` while a stop is in flight on the current `SessionManager`. */
	get armed(): boolean {
		const manager = this.host.sessionManager;
		if (manager === null || !manager.started) return false;
		if (this.#stoppedManager !== null && this.#stoppedManager === manager) return false;
		return this.host.cdpClient?.state === 'open';
	}

	// -- handlers ----------------------------------------------------------------------------------

	/** The whole contract: a closed tab that leaves the browser empty gets replaced. */
	async onTabClosedEvent(_event: TabClosedEvent, _context?: HandlerContext): Promise<void> {
		await this.ensurePageTarget();
	}

	/** Disarm before the socket goes: a teardown must not spawn tabs (E-16 handler-set reading). */
	onBrowserStopEvent(_event: BrowserStopEvent, _context?: HandlerContext): void {
		this.#stoppedManager = this.host.sessionManager;
	}

	/** Same disarm from the other direction, for stops this session did not initiate. */
	onBrowserStoppedEvent(_event: BrowserStoppedEvent, _context?: HandlerContext): void {
		this.#stoppedManager = this.host.sessionManager;
	}

	// -- the guarantee -----------------------------------------------------------------------------

	/**
	 * Opens `about:blank` iff the browser currently has no page target. Returns the new target id, or
	 * `null` when nothing was needed (or the session is not in a state to be rescued).
	 *
	 * Concurrent callers share one in-flight rescue — two tabs closing in the same tick must not
	 * produce two replacements.
	 */
	async ensurePageTarget(): Promise<TargetId | null> {
		const inflight = this.#creating;
		if (inflight !== null) return await inflight;
		if (!this.armed) return null;
		const manager = this.host.sessionManager;
		if (manager === null || manager.pageTargets().length > 0) return null;

		const run = this.#rescue(manager);
		this.#creating = run;
		try {
			return await run;
		} finally {
			this.#creating = null;
		}
	}

	/**
	 * The barrier of the module note, then the decision, then the tab.
	 *
	 * DELIBERATELY UNCANCELLABLE — bare `manager.client`, not a signal-bound view (ERRATUM(E-62)).
	 * Two independent reasons, either sufficient:
	 *
	 * 1. This watchdog *is* a guarantee — "the browser never reaches zero tabs". A guarantee that
	 *    declines to fire under load is the SecurityWatchdog containment case again: firing late beats
	 *    not firing. The cost of skipping is a browser with no page target, which every subsequent
	 *    handler then fails against.
	 * 2. `ensurePageTarget` **shares one in-flight rescue between concurrent callers** (`#creating`).
	 *    Binding it to any one caller's signal would let an abandoned `TabClosedEvent` cancel a rescue
	 *    a live caller is awaiting — cancellation leaking across callers, which is worse than no
	 *    cancellation at all.
	 *
	 * It is bounded rather than unbounded: two CDP round trips plus `#awaitRegistration`, which has
	 * its own budget.
	 */
	async #rescue(manager: SessionManager): Promise<TargetId | null> {
		if (!await this.#browserIsEmpty(manager)) {
			this.logger.debug('a replacement page target appeared before the rescue; standing down');
			return null;
		}
		return await this.#createBlankTab(manager);
	}

	/**
	 * `true` when the browser still has no page target *after* a CDP round trip has flushed whatever
	 * Chrome had already sent. See the module note on the barrier.
	 *
	 * A failed barrier means the socket is gone, and a browser we cannot talk to is not one we can
	 * rescue: the answer is then "not empty" so nothing is created.
	 */
	async #browserIsEmpty(manager: SessionManager): Promise<boolean> {
		try {
			// Bare on purpose — see `#rescue`.
			await manager.client.send.Browser.getVersion();
		} catch (error) {
			this.logger.debug('the rescue barrier could not complete; standing down', { error });
			return false;
		}
		if (!this.armed) return false;
		return manager.pageTargets().length === 0;
	}

	async #createBlankTab(manager: SessionManager): Promise<TargetId | null> {
		let targetId: TargetId;
		try {
			// Bare on purpose — see `#rescue`. This is the replacement tab itself.
			const created = await manager.client.send.Target.createTarget({ url: ABOUT_BLANK_URL });
			targetId = created.targetId;
		} catch (error) {
			// Never thrown onward: `TabClosedEvent` is a notification, and SessionManager's own focus
			// recovery reports `FocusRecoveryFailed` for exactly this situation a moment later.
			this.logger.error('could not open a replacement about:blank tab', { error });
			return null;
		}

		this.#created += 1;
		await this.#awaitRegistration(manager, targetId);
		this.logger.debug('opened a replacement about:blank tab', { targetId });
		return targetId;
	}

	/**
	 * Waits (≤ {@linkcode ABOUT_BLANK_TAB_REGISTER_WAIT_MS}) for Chrome's `Target.targetCreated`.
	 *
	 * Polls the target map directly rather than `SessionManager.whenIdle()`: this runs inside the
	 * `TabClosedEvent` dispatch, which is itself one of the manager's tracked promises, so awaiting
	 * "everything the manager has in flight" would be awaiting ourselves. The map is written
	 * synchronously by the `Target.targetCreated` listener, so polling it is sufficient anyway.
	 */
	async #awaitRegistration(manager: SessionManager, targetId: TargetId): Promise<void> {
		const deadline = this.#now() + ABOUT_BLANK_TAB_REGISTER_WAIT_MS;
		for (;;) {
			if (manager.targets.has(targetId)) return;
			if (this.#now() >= deadline) {
				this.logger.warn('replacement tab did not register within the wait; focus recovery may add a second', {
					targetId,
					waitMs: ABOUT_BLANK_TAB_REGISTER_WAIT_MS,
				});
				return;
			}
			await delay(ABOUT_BLANK_TAB_POLL_INTERVAL_MS);
		}
	}
}
