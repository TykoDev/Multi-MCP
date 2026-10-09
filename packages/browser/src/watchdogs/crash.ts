/**
 * @module
 * `CrashWatchdog` ○ — **defined, not attached** (ARCHITECTURE.md §6.11).
 *
 * > optional target-crash and network-timeout sentinel (`Runtime.evaluate('1+1')` health probes).
 * > SessionManager's detach-driven focus recovery is the load-bearing mechanism; a port MUST keep
 * > that and MAY skip this watchdog.
 *
 * It is therefore absent from `WATCHDOG_ATTACH_ORDER` — pinned by a test in
 * `attach_order_test.ts`, not by a comment — and an embedder that wants it opts in explicitly:
 *
 * ```ts
 * const crash = new CrashWatchdog(session);
 * crash.attach();          // arms on the next BrowserConnectedEvent
 * ```
 *
 * ## What "load-bearing" means here
 *
 * The mechanism that actually keeps a crashed tab from wedging the agent is
 * `SessionManager`'s detach handling: when the last session of the focused target goes away it
 * removes the target, fires `TabClosedEvent`, and runs focus recovery (most-recent page → new
 * `about:blank` → emergency fallback → `BrowserErrorEvent`). That path is covered by the
 * `SessionManager` contract tests and does not involve this file at all. This watchdog adds *early*
 * detection — a renderer that is hung rather than detached emits no CDP event whatsoever, so the only
 * way to notice is to ask it something and see whether it answers.
 *
 * ## The probe cadence is an invented number (ERRATUM(M1-watchdogs-rest-8))
 *
 * §6.11 names the probe (`Runtime.evaluate('1+1')`) but gives no interval, no per-probe cap, and no
 * network-stall threshold. All three are declared here as named constants, asserted in tests, and
 * inert by default (nothing attaches this watchdog). They are sized off constants the spec does fix:
 * the probe cap equals `LocalBrowserWatchdog`'s graceful-kill grace (5 s, ARCHITECTURE.md §6.1), the
 * interval equals the cap so probes cannot overlap, and the network-stall threshold is 30 s — the bus
 * default event budget (E-1), i.e. the longest a request may stall before *some* handler would have
 * timed out anyway.
 */

import type { HandlerContext } from '@tykotech/bus';
import type { CdpClient, CdpEventParams, SessionId } from '@tykotech/cdp';
import { BrowserConnectedEvent, BrowserErrorEvent, BrowserStopEvent, TargetCrashedEvent } from '../events.ts';
import { withTimeout } from '../browser/reconnect.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants (see the module note: invented, inert, asserted)
// ---------------------------------------------------------------------------

/** The health probe of §6.11, verbatim. */
export const CRASH_PROBE_EXPRESSION = '1+1';

/** What a live renderer answers. Anything else is a crash signal. */
export const CRASH_PROBE_EXPECTED = 2;

/** Cadence of the probe loop. Equal to the cap, so two probes can never overlap. */
export const CRASH_PROBE_INTERVAL_MS = 5_000;

/** Cap on one probe. A renderer that cannot add two numbers in 5 s is not usable. */
export const CRASH_PROBE_TIMEOUT_MS = 5_000;

/** How long a request may stay in flight before it counts as stalled. */
export const NETWORK_STALL_TIMEOUT_MS = 30_000;

/** `errorType` of the network-stall report. */
export const NETWORK_TIMEOUT_ERROR = 'NetworkTimeout';

/** `errorType` of the crash report that accompanies `TargetCrashedEvent`. */
export const TARGET_CRASHED_ERROR = 'TargetCrashed';

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** Outcome of one health probe. */
export interface CrashProbeResult {
	readonly healthy: boolean;
	/** `null` when there was nothing to probe (no focused page target). */
	readonly targetId: string | null;
	/** Rendered failure reason; `null` when healthy. */
	readonly reason: string | null;
}

/** One in-flight request, for the network-stall sentinel. */
interface TrackedRequest {
	readonly requestId: string;
	readonly url: string;
	/** `Date.now()` at reception — never CDP's monotonic `timestamp` (the E-17 clock lesson). */
	readonly startedAt: number;
	readonly sessionId: SessionId | undefined;
}

/** Injection seams; every default is the real implementation. */
export interface CrashWatchdogOptions {
	/** Injected clock, so `FakeTime` drives the stall sentinel. */
	readonly now?: (() => number) | undefined;
	/** Overrides {@linkcode CRASH_PROBE_INTERVAL_MS}; the contract test pins the default. */
	readonly probeIntervalMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class CrashWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [BrowserConnectedEvent, BrowserStopEvent];
	static override readonly EMITS = [TargetCrashedEvent, BrowserErrorEvent];

	readonly #now: () => number;
	readonly #probeIntervalMs: number;
	readonly #inflight = new Map<string, TrackedRequest>();
	readonly #reportedStalls = new Set<string>();
	#timer: ReturnType<typeof setInterval> | null = null;
	#networkUnsubscribes: (() => void)[] = [];
	#armedClient: CdpClient | null = null;

	constructor(host: WatchdogHost, options: CrashWatchdogOptions = {}) {
		super(host);
		this.#now = options.now ?? Date.now;
		this.#probeIntervalMs = options.probeIntervalMs ?? CRASH_PROBE_INTERVAL_MS;
	}

	// -- public surface ----------------------------------------------------------------------------

	/** `true` while the probe loop and the network sentinel are running. */
	get probing(): boolean {
		return this.#timer !== null;
	}

	/** Effective probe cadence. Defaults to {@linkcode CRASH_PROBE_INTERVAL_MS}. */
	get probeIntervalMs(): number {
		return this.#probeIntervalMs;
	}

	/** Requests currently in flight, oldest first. */
	get inflightRequests(): readonly { requestId: string; url: string; startedAt: number }[] {
		return [...this.#inflight.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	// -- handlers ----------------------------------------------------------------------------------

	onBrowserConnectedEvent(_event: BrowserConnectedEvent, _context?: HandlerContext): void {
		this.arm();
	}

	/** Disarm before the socket goes: a probe fired into a closing transport is pure noise. */
	onBrowserStopEvent(_event: BrowserStopEvent, _context?: HandlerContext): void {
		this.disarm();
	}

	protected override beforeDetach(): void {
		this.disarm();
	}

	// -- arming ------------------------------------------------------------------------------------

	arm(): void {
		const client = this.host.cdpClient;
		if (client === null || client.state !== 'open') return;
		if (this.#armedClient === client && this.#timer !== null) return;
		this.disarm();
		this.#armedClient = client;
		this.#networkUnsubscribes = [
			client.on('Network.requestWillBeSent', (params, sessionId) => this.#onRequestStarted(params, sessionId)),
			client.on('Network.loadingFinished', (params) => this.#onRequestSettled(params.requestId)),
			client.on('Network.loadingFailed', (params) => this.#onRequestSettled(params.requestId)),
		];
		this.#timer = setInterval(() => void this.tick(), this.#probeIntervalMs);
	}

	/** Timer + listener hygiene: nothing may outlive `detach()` (the op sanitizer proves it). */
	disarm(): void {
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		for (const off of this.#networkUnsubscribes) off();
		this.#networkUnsubscribes = [];
		this.#armedClient = null;
		this.#inflight.clear();
		this.#reportedStalls.clear();
	}

	// -- the sentinel ------------------------------------------------------------------------------

	/**
	 * One pass: health probe plus network-stall sweep. Exactly what the interval runs, exposed so the
	 * contract test drives it without waiting on a timer.
	 *
	 * Never throws — it runs off a timer, where a rejection has nobody to catch it.
	 */
	async tick(): Promise<void> {
		try {
			await this.sweepStalledRequests();
			const probe = await this.probeOnce();
			if (probe.healthy || probe.targetId === null) return;
			await this.bus.dispatch(new TargetCrashedEvent({ targetId: probe.targetId, error: probe.reason ?? 'unknown' }));
			await this.bus.dispatch(
				new BrowserErrorEvent({
					errorType: TARGET_CRASHED_ERROR,
					message: `target ${probe.targetId} failed its health probe: ${probe.reason ?? 'unknown'}`,
					details: { targetId: probe.targetId, expression: CRASH_PROBE_EXPRESSION },
				}),
			);
		} catch (error) {
			this.logger.debug('crash sentinel pass failed', { error });
		}
	}

	/** `Runtime.evaluate('1+1')` against the focused page session, capped. Never throws. */
	async probeOnce(): Promise<CrashProbeResult> {
		const manager = this.host.sessionManager;
		if (manager === null || !manager.started) return { healthy: true, targetId: null, reason: null };
		const targetId = manager.agentFocusTargetId ?? manager.mostRecentPageTarget()?.targetId ?? null;
		if (targetId === null) return { healthy: true, targetId: null, reason: null };

		const probe = this.#evaluate(targetId).then(
			(value) => (value === CRASH_PROBE_EXPECTED ? null : `probe returned ${JSON.stringify(value)}`),
			(error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
		);
		const outcome = await withTimeout(probe, CRASH_PROBE_TIMEOUT_MS);
		if (outcome.timedOut) {
			return { healthy: false, targetId, reason: `probe exceeded ${CRASH_PROBE_TIMEOUT_MS} ms` };
		}
		const reason = outcome.value ?? null;
		return { healthy: reason === null, targetId, reason };
	}

	/** Reports requests older than {@linkcode NETWORK_STALL_TIMEOUT_MS}, once each. */
	async sweepStalledRequests(): Promise<readonly string[]> {
		const cutoff = this.#now() - NETWORK_STALL_TIMEOUT_MS;
		const stalled = [...this.#inflight.values()]
			.filter((request) => request.startedAt <= cutoff && !this.#reportedStalls.has(request.requestId));
		for (const request of stalled) {
			this.#reportedStalls.add(request.requestId);
			await this.bus.dispatch(
				new BrowserErrorEvent({
					errorType: NETWORK_TIMEOUT_ERROR,
					message: `request has been in flight for more than ${NETWORK_STALL_TIMEOUT_MS} ms: ${request.url}`,
					details: {
						requestId: request.requestId,
						url: request.url,
						elapsedMs: this.#now() - request.startedAt,
					},
				}),
			);
		}
		return stalled.map((request) => request.requestId);
	}

	// -- internals ---------------------------------------------------------------------------------

	async #evaluate(targetId: string): Promise<unknown> {
		const session = await this.sessions.getOrCreateCdpSession(targetId, false);
		// Bare `this.cdp` on purpose (ERRATUM(E-52) allowlist): the crash sentinel runs from `setInterval`,
		// not from a dispatch, so there is no `HandlerContext` in scope to bind. Its bound is
		// `CRASH_PROBE_TIMEOUT_MS`, applied by `probeOnce`, and `disarm()` stops the loop.
		const outcome = await this.cdp.send.Runtime.evaluate(
			{ expression: CRASH_PROBE_EXPRESSION, returnByValue: true },
			session.sessionId,
		);
		return outcome.result.value;
	}

	#onRequestStarted(params: CdpEventParams['Network.requestWillBeSent'], sessionId: SessionId | undefined): void {
		this.#inflight.set(params.requestId, {
			requestId: params.requestId,
			url: params.request.url,
			startedAt: this.#now(),
			sessionId,
		});
	}

	#onRequestSettled(requestId: string): void {
		this.#inflight.delete(requestId);
		this.#reportedStalls.delete(requestId);
	}
}
