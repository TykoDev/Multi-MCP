/**
 * @module
 * Drop detection, auto-reconnect, and the {@linkcode ConnectionPolicy} the bus circuit breaker
 * consumes (ARCHITECTURE.md §7.4, §4.6).
 *
 * The policy split is deliberate: `@tykotech/bus` owns *waiting* (the ≤54 s budget in `resilientHandler`)
 * and knows nothing about CDP; this module owns *the truth* — connected or not, reconnecting or not,
 * and which events are lifecycle events that bypass the breaker entirely. The lifecycle list lives
 * here because the bus has no opinion about `BrowserStartEvent`.
 *
 * Reconnect shape (§7.4): **3 attempts, delays 1 s / 2 s / 4 s**, each attempt capped at 15 s, gated
 * on `CdpCloseInfo.intentional === false`. `BrowserReconnectingEvent` per attempt,
 * `BrowserReconnectedEvent` on success, `BrowserErrorEvent('ReconnectionFailed')` after exhaustion.
 * Worst case is 1+15 + 2+15 + 4+15 = 52 s, which is what the 54 s
 * {@linkcode RECONNECT_WAIT_TIMEOUT_MS} handler budget is sized to cover with slack.
 */

import { type BaseEvent, type ConnectionPolicy, RECONNECT_WAIT_TIMEOUT_MS } from '@tykotech/bus';
import type { BusLogger, EventBus } from '@tykotech/bus';
import type { CdpCloseInfo } from '@tykotech/cdp';
import { delay } from '@std/async';
import {
	BrowserErrorEvent,
	BrowserKillEvent,
	BrowserLaunchEvent,
	BrowserReconnectedEvent,
	BrowserReconnectingEvent,
	BrowserStartEvent,
	BrowserStopEvent,
	BrowserStoppedEvent,
} from '../events.ts';
import { BrowserError } from '../errors.ts';

// ---------------------------------------------------------------------------
// timing constants (ARCHITECTURE.md §7.4, §8 — load-bearing, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/** `connect()` overall cap, with teardown-on-timeout so a retry starts clean (§7.4, §8). */
export const CONNECT_TIMEOUT_MS = 15_000;

/** Reconnect attempts, including the first (§7.4). */
export const RECONNECT_MAX_ATTEMPTS = 3;

/** Delay before attempt 1, 2 and 3 respectively (§7.4). */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];

/** Longest a blocked handler waits mid-reconnect; owned by `@tykotech/bus`, re-exported here (§7.4). */
export { RECONNECT_WAIT_TIMEOUT_MS };

/**
 * The lifecycle events that bypass the circuit breaker (ARCHITECTURE.md §4.6):
 * `BrowserStart/Stop/Stopped/Launch/Error/Kill/Reconnecting/Reconnected`.
 *
 * Skipping the breaker for these is what lets a session start, stop, kill, or report an error while
 * the transport is down — every other handler would only fail against a dead socket.
 */
export const LIFECYCLE_EVENT_NAMES: readonly string[] = [
	BrowserStartEvent.eventName,
	BrowserStopEvent.eventName,
	BrowserStoppedEvent.eventName,
	BrowserLaunchEvent.eventName,
	BrowserErrorEvent.eventName,
	BrowserKillEvent.eventName,
	BrowserReconnectingEvent.eventName,
	BrowserReconnectedEvent.eventName,
];

const LIFECYCLE_EVENT_SET: ReadonlySet<string> = new Set(LIFECYCLE_EVENT_NAMES);

/** `true` for the eight lifecycle events of ARCHITECTURE.md §4.6. */
export function isLifecycleEventName(eventType: string): boolean {
	return LIFECYCLE_EVENT_SET.has(eventType);
}

// ---------------------------------------------------------------------------
// timeout helper
// ---------------------------------------------------------------------------

/** Result of {@linkcode withTimeout}. `value` is `undefined` exactly when the deadline won. */
export interface TimeoutOutcome<T> {
	readonly timedOut: boolean;
	readonly value: T | undefined;
}

/**
 * Races a promise against a deadline, always clearing the timer.
 *
 * `@tykotech/bus` has an equivalent internally but does not export it, and a cross-package deep import is
 * forbidden (AGENTS.md §3). Rejections propagate unchanged; only the *timeout* is reported as data,
 * because both callers here (connect cap, reconnect attempt cap) need to run teardown on it.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<TimeoutOutcome<T>> {
	if (!Number.isFinite(ms) || ms <= 0) return { timedOut: false, value: await promise };
	const expired = Symbol('bua.timeout');
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof expired>((resolve) => {
		timer = setTimeout(() => resolve(expired), ms);
	});
	try {
		const winner = await Promise.race([promise, deadline]);
		return winner === expired ? { timedOut: true, value: undefined } : { timedOut: false, value: winner };
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// ReconnectController
// ---------------------------------------------------------------------------

/** Everything the controller needs from its owner. `connect` rebuilds client + SessionManager. */
export interface ReconnectControllerOptions {
	readonly bus: EventBus;
	/**
	 * Rebuilds the whole connection: new `CdpClient`, new `SessionManager`, root autoAttach, proxy
	 * auth, and the previous focus target restored if it is still alive (§7.4). Throwing fails one
	 * attempt; the controller owns the retry policy, never the connect implementation.
	 */
	readonly connect: (signal: AbortSignal) => Promise<void>;
	/** Live connection state, read from the current `CdpClient`. */
	readonly isConnected: () => boolean;
	/** The endpoint being reconnected to, for the reconnect events' `cdpUrl` field. */
	readonly cdpUrl: () => string | null;
	readonly logger?: BusLogger | undefined;
	readonly maxAttempts?: number | undefined;
	readonly backoffMs?: readonly number[] | undefined;
	/** Per-attempt cap; defaults to the 15 s connect cap of §7.4. */
	readonly attemptTimeoutMs?: number | undefined;
	/** Injected clock, so `FakeTime` can drive downtime accounting. */
	readonly now?: (() => number) | undefined;
}

/**
 * Owns drop detection and the retry ladder, and *is* the {@linkcode ConnectionPolicy} the bus wraps
 * every handler with (`resilientWrapper({ connection })`).
 */
export class ReconnectController implements ConnectionPolicy {
	readonly #options: ReconnectControllerOptions;
	readonly #maxAttempts: number;
	readonly #backoffMs: readonly number[];
	readonly #attemptTimeoutMs: number;
	readonly #now: () => number;
	#run: Promise<boolean> | null = null;
	#controller: AbortController | null = null;
	#disconnectedAt: number | null = null;
	#enabled = true;
	#attemptsMade = 0;

	constructor(options: ReconnectControllerOptions) {
		this.#options = options;
		this.#maxAttempts = options.maxAttempts ?? RECONNECT_MAX_ATTEMPTS;
		this.#backoffMs = options.backoffMs ?? RECONNECT_BACKOFF_MS;
		this.#attemptTimeoutMs = options.attemptTimeoutMs ?? CONNECT_TIMEOUT_MS;
		this.#now = options.now ?? Date.now;
	}

	// -- ConnectionPolicy --------------------------------------------------------------------------

	isConnected(): boolean {
		return this.#options.isConnected();
	}

	isReconnecting(): boolean {
		return this.#run !== null;
	}

	/**
	 * Resolves `true` once reconnected, `false` when the ladder gave up (or the caller's budget or
	 * signal expired first). Never rejects — the breaker converts `false` into `ConnectionError`.
	 */
	async waitForReconnect(signalOrMs: AbortSignal | number): Promise<boolean> {
		if (this.isConnected()) return true;
		const run = this.#run;
		if (run === null) return false;
		if (typeof signalOrMs === 'number') {
			const outcome = await withTimeout(run, signalOrMs);
			return outcome.timedOut ? false : outcome.value === true;
		}
		if (signalOrMs.aborted) return false;
		return await Promise.race([run, _whenAborted(signalOrMs)]);
	}

	isLifecycleEvent(event: BaseEvent<unknown>): boolean {
		return isLifecycleEventName(event.eventType);
	}

	// -- drop detection ----------------------------------------------------------------------------

	/** Attempts made by the ladder currently or most recently in flight. */
	get attemptsMade(): number {
		return this.#attemptsMade;
	}

	/**
	 * Called from `CdpClient.onClose`. Auto-reconnect is gated on `intentional === false`: a
	 * `session.stop()` closed the socket on purpose and must not be fought (§7.4).
	 */
	notifyClosed(info: CdpCloseInfo): Promise<boolean> | null {
		if (info.intentional || !this.#enabled) return null;
		return this.start();
	}

	/** Starts (or joins) the retry ladder. Idempotent while a ladder is in flight. */
	start(): Promise<boolean> {
		const existing = this.#run;
		if (existing !== null) return existing;
		this.#disconnectedAt = this.#now();
		const controller = new AbortController();
		this.#controller = controller;
		const run = this.#ladder(controller.signal).finally(() => {
			this.#run = null;
			this.#controller = null;
		});
		this.#run = run;
		return run;
	}

	/** Stops any further reconnect work; used by `stop()`/`kill()` so teardown is not fought. */
	disable(): void {
		this.#enabled = false;
		this.#controller?.abort(new BrowserError('reconnect cancelled'));
	}

	/** Re-arms drop detection after a deliberate teardown/restart cycle. */
	enable(): void {
		this.#enabled = true;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	async #ladder(signal: AbortSignal): Promise<boolean> {
		this.#attemptsMade = 0;
		const cdpUrl = this.#options.cdpUrl() ?? '';
		let lastError: unknown = null;

		for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
			if (signal.aborted) return false;
			this.#attemptsMade = attempt;
			this.#options.bus.dispatch(
				new BrowserReconnectingEvent({ cdpUrl, attempt, maxAttempts: this.#maxAttempts }),
			);
			const backoff = this.#backoffMs[attempt - 1] ?? this.#backoffMs.at(-1) ?? 0;
			try {
				await delay(backoff, { signal });
			} catch {
				return false; // aborted mid-backoff
			}
			if (signal.aborted) return false;

			try {
				const outcome = await withTimeout(this.#options.connect(signal), this.#attemptTimeoutMs);
				if (outcome.timedOut) {
					throw new BrowserError(`reconnect attempt ${attempt} exceeded the ${this.#attemptTimeoutMs}ms cap`);
				}
				const downtimeMs = this.#now() - (this.#disconnectedAt ?? this.#now());
				this.#options.bus.dispatch(
					new BrowserReconnectedEvent({ cdpUrl, attempt, downtimeSeconds: downtimeMs / 1_000 }),
				);
				return true;
			} catch (error) {
				lastError = error;
				this.#options.logger?.warn('reconnect attempt failed', { attempt, maxAttempts: this.#maxAttempts, error });
			}
		}

		this.#options.bus.dispatch(
			new BrowserErrorEvent({
				errorType: 'ReconnectionFailed',
				message: `CDP reconnection failed after ${this.#maxAttempts} attempts`,
				details: {
					cdpUrl,
					attempts: this.#maxAttempts,
					backoffMs: [...this.#backoffMs],
					lastError: lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError),
				},
			}),
		);
		return false;
	}
}

function _whenAborted(signal: AbortSignal): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		signal.addEventListener('abort', () => resolve(false), { once: true });
	});
}
