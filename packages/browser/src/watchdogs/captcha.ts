/**
 * @module
 * `CaptchaWatchdog` ○ — vendor captcha-solver bridge (ARCHITECTURE.md §6.14).
 *
 * > **conditional: `captchaSolver`, default on** — listens for vendor `BrowserUse.captchaSolver*`
 * > CDP events (emitted only by cloud proxy browsers; harmless elsewhere), re-broadcasts them as bus
 * > events, and exposes `waitIfCaptchaSolving(timeout ≤ 120 s)` which the agent step loop calls
 * > before each step.
 *
 * Two halves, and it is worth being precise about which is which:
 *
 * 1. **Re-broadcast.** `BrowserUse.captchaSolverStarted` / `…Finished` are a *vendor* CDP domain
 *    (`@tykotech/cdp` `src/domains/browser_use.ts`): a cloud proxy browser emits them, a stock Chromium
 *    never does, and subscribing to a method nobody sends is free. They become
 *    `CaptchaSolverStartedEvent` / `CaptchaSolverFinishedEvent` (DATA-MODEL.md §5.1.7) so that
 *    everything downstream — history, telemetry, the web client — sees one event vocabulary.
 * 2. **The wait.** {@linkcode CaptchaWatchdog.waitIfCaptchaSolving} is what AGENT-RUNTIME.md §4
 *    Phase 0 calls *before every step*: if a solve is in flight the step blocks until it finishes,
 *    then the step timer is reset and an `ActionResult` narrates the wait. Without it the agent would
 *    photograph a captcha overlay, reason about it, and act on a page that has since changed.
 *
 * Every field of the vendor payload is optional (the domain is outside our control), so a missing
 * field degrades the result — `vendor: 'unknown'`, `result: 'unknown'` — and never throws.
 */

import type { HandlerContext } from '@tykotech/bus';
import type { CdpClient, CdpEventParams, TargetId } from '@tykotech/cdp';
import {
	BrowserConnectedEvent,
	BrowserStoppedEvent,
	CaptchaSolverFinishedEvent,
	CaptchaSolverStartedEvent,
} from '../events.ts';
import type { BrowserProfile, CaptchaWaitOutcome, CaptchaWaitResult } from '../types.ts';
import { withTimeout } from '../browser/reconnect.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Hard ceiling on the pre-step wait (ARCHITECTURE.md §6.14: "timeout ≤ 120 s"). */
export const CAPTCHA_WAIT_TIMEOUT_MS = 120_000;

/** Env override, in **seconds**, per the `TIMEOUT_<name>` convention (AGENT-RUNTIME.md §4 Phase 0). */
export const CAPTCHA_WAIT_TIMEOUT_ENV = 'TIMEOUT_CaptchaSolverWait';

/** Vendor name used when the payload omits one. */
export const UNKNOWN_CAPTCHA_VENDOR = 'unknown';

/** The conditional-attachment predicate (ARCHITECTURE.md §6.14; default `true`, DATA-MODEL §5.2). */
export function shouldAttachCaptchaWatchdog(profile: Pick<BrowserProfile, 'captchaSolver'>): boolean {
	return profile.captchaSolver;
}

/**
 * The effective wait budget: explicit override, else the env var (seconds), else the default —
 * always clamped to `≤ 120 s`, because §6.14 states the ceiling and not a configurable maximum.
 */
export function resolveCaptchaWaitTimeoutMs(
	explicitMs?: number | undefined,
	env: (name: string) => string | undefined = _denoEnv,
): number {
	if (explicitMs !== undefined && Number.isFinite(explicitMs)) {
		return Math.min(Math.max(0, explicitMs), CAPTCHA_WAIT_TIMEOUT_MS);
	}
	const raw = env(CAPTCHA_WAIT_TIMEOUT_ENV);
	if (raw !== undefined && raw.trim() !== '') {
		const seconds = Number(raw.trim());
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(seconds * 1_000, CAPTCHA_WAIT_TIMEOUT_MS);
		}
	}
	return CAPTCHA_WAIT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** A solve currently in flight. */
export interface CaptchaSolveState {
	readonly targetId: TargetId;
	readonly vendor: string;
	readonly url: string;
	/** ISO-8601, as the vendor reported it (or reception time when it omitted one). */
	readonly startedAt: string;
	/** `Date.now()` at reception — the base for a synthesized `durationMs`. */
	readonly startedAtMs: number;
}

/** Injection seams; every default is the real implementation. */
export interface CaptchaWatchdogOptions {
	/** Injected clock, so `FakeTime` drives the wait. */
	readonly now?: (() => number) | undefined;
	/** Injected env reader, so the timeout override is testable without touching the process env. */
	readonly env?: ((name: string) => string | undefined) | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class CaptchaWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [BrowserConnectedEvent, BrowserStoppedEvent];
	static override readonly EMITS = [CaptchaSolverStartedEvent, CaptchaSolverFinishedEvent];

	readonly #now: () => number;
	readonly #env: (name: string) => string | undefined;
	readonly #pending = new Set<Promise<unknown>>();
	#unsubscribes: (() => void)[] = [];
	#armedClient: CdpClient | null = null;

	#solve: CaptchaSolveState | null = null;
	#settled: Promise<CaptchaWaitOutcome> | null = null;
	#resolve: ((outcome: CaptchaWaitOutcome) => void) | null = null;
	#lastResult: CaptchaWaitResult | null = null;

	constructor(host: WatchdogHost, options: CaptchaWatchdogOptions = {}) {
		super(host);
		this.#now = options.now ?? Date.now;
		this.#env = options.env ?? _denoEnv;
	}

	// -- public surface ----------------------------------------------------------------------------

	/** `true` while a vendor solve is in flight. */
	get solving(): boolean {
		return this.#solve !== null;
	}

	/** The in-flight solve, or `null`. */
	get currentSolve(): CaptchaSolveState | null {
		return this.#solve;
	}

	/** The result of the most recent completed wait, for diagnostics. */
	get lastResult(): CaptchaWaitResult | null {
		return this.#lastResult;
	}

	/** `true` while the vendor listeners are registered. */
	get armed(): boolean {
		return this.#unsubscribes.length > 0;
	}

	/** Resolves when every in-flight re-broadcast has settled. Tests await this, never a sleep. */
	async whenIdle(): Promise<void> {
		for (let guard = 0; guard < 10 && this.#pending.size > 0; guard++) {
			await Promise.allSettled([...this.#pending]);
		}
	}

	/**
	 * The M2 seam (AGENT-RUNTIME.md §4 Phase 0). Blocks while a vendor captcha solve is in flight.
	 *
	 * Returns immediately with `{ waited: false, result: 'unknown' }` when nothing is solving — the
	 * overwhelmingly common case, and the reason this is cheap enough to call before every step.
	 *
	 * Never throws. An aborted `signal` ends the wait with `result: 'unknown'`; raising the
	 * interrupt belongs to the checkpoint that owns the signal, not to this method.
	 */
	async waitIfCaptchaSolving(
		options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
	): Promise<CaptchaWaitResult> {
		const solve = this.#solve;
		const settled = this.#settled;
		if (solve === null || settled === null) return { waited: false, result: 'unknown' };

		const timeoutMs = resolveCaptchaWaitTimeoutMs(options.timeoutMs, this.#env);
		const signal = options.signal;
		const race = signal === undefined
			? settled
			: Promise.race([settled, _whenAborted(signal).then((): CaptchaWaitOutcome => 'unknown')]);
		const outcome = await withTimeout(race, timeoutMs);
		const result: CaptchaWaitResult = {
			waited: true,
			vendor: solve.vendor,
			url: solve.url,
			durationMs: Math.max(0, this.#now() - solve.startedAtMs),
			result: outcome.timedOut ? 'timeout' : outcome.value ?? 'unknown',
		};
		this.#lastResult = result;
		return result;
	}

	// -- handlers ----------------------------------------------------------------------------------

	onBrowserConnectedEvent(_event: BrowserConnectedEvent, _context?: HandlerContext): void {
		if (!shouldAttachCaptchaWatchdog(this.profile)) return;
		this.arm();
	}

	/** A stopped browser cannot finish a solve; release anyone waiting rather than hanging the step. */
	onBrowserStoppedEvent(_event: BrowserStoppedEvent, _context?: HandlerContext): void {
		this.disarm();
	}

	protected override beforeDetach(): void {
		this.disarm();
	}

	// -- arming ------------------------------------------------------------------------------------

	arm(): void {
		const client = this.host.cdpClient;
		if (client === null || client.state !== 'open') return;
		if (this.#armedClient === client && this.armed) return;
		this.#unsubscribeAll();
		this.#armedClient = client;
		this.#unsubscribes = [
			client.on('BrowserUse.captchaSolverStarted', (params) => this.#onSolverStarted(params)),
			client.on('BrowserUse.captchaSolverFinished', (params) => this.#onSolverFinished(params)),
		];
	}

	/** Unregisters and releases waiters with `unknown` — a pending wait must never outlive the socket. */
	disarm(): void {
		this.#unsubscribeAll();
		this.#release('unknown');
	}

	// -- vendor bridge -----------------------------------------------------------------------------

	#onSolverStarted(params: CdpEventParams['BrowserUse.captchaSolverStarted']): void {
		const targetId = params.targetId ?? this.host.sessionManager?.agentFocusTargetId ?? '';
		const solve: CaptchaSolveState = {
			targetId,
			vendor: params.vendor ?? UNKNOWN_CAPTCHA_VENDOR,
			url: params.url ?? this.host.sessionManager?.targets.get(targetId)?.url ?? '',
			startedAt: params.startedAt ?? new Date(this.#now()).toISOString(),
			startedAtMs: this.#now(),
		};
		// A second `started` without a `finished` supersedes the first; its waiters are released so a
		// step loop cannot be pinned by a solve the vendor forgot to close.
		this.#release('unknown');
		this.#solve = solve;
		this.#settled = new Promise<CaptchaWaitOutcome>((resolve) => {
			this.#resolve = resolve;
		});
		this.logger.debug('vendor captcha solve started', { vendor: solve.vendor, targetId: solve.targetId });
		this.#track(
			this.bus.dispatch(
				new CaptchaSolverStartedEvent({
					targetId: solve.targetId,
					vendor: solve.vendor,
					url: solve.url,
					startedAt: solve.startedAt,
				}),
			),
		);
	}

	#onSolverFinished(params: CdpEventParams['BrowserUse.captchaSolverFinished']): void {
		const solve = this.#solve;
		const targetId = params.targetId ?? solve?.targetId ?? '';
		const durationMs = params.durationMs ?? (solve === null ? 0 : Math.max(0, this.#now() - solve.startedAtMs));
		// `success` absent means the vendor did not say — reported as `unknown`, never as a failure.
		const outcome: CaptchaWaitOutcome = params.success === undefined
			? 'unknown'
			: (params.success ? 'success' : 'failed');

		this.logger.debug('vendor captcha solve finished', { vendor: params.vendor ?? solve?.vendor, outcome });
		this.#track(
			this.bus.dispatch(
				new CaptchaSolverFinishedEvent({
					targetId,
					vendor: params.vendor ?? solve?.vendor ?? null,
					url: params.url ?? solve?.url ?? null,
					durationMs,
					finishedAt: params.finishedAt ?? new Date(this.#now()).toISOString(),
					success: params.success ?? false,
				}),
			),
		);
		this.#release(outcome);
	}

	// -- internals ---------------------------------------------------------------------------------

	#release(outcome: CaptchaWaitOutcome): void {
		const resolve = this.#resolve;
		this.#resolve = null;
		this.#settled = null;
		this.#solve = null;
		resolve?.(outcome);
	}

	#unsubscribeAll(): void {
		for (const off of this.#unsubscribes) off();
		this.#unsubscribes = [];
		this.#armedClient = null;
	}

	#track(promise: PromiseLike<unknown>): void {
		const tracked = Promise.resolve(promise).then(() => {}, (error: unknown) => {
			this.logger.debug('captcha re-broadcast failed', { error });
		});
		this.#pending.add(tracked);
		void tracked.finally(() => this.#pending.delete(tracked));
	}
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------

/** Missing `--allow-env` is indistinguishable from "unset" here (mirrors `@tykotech/bus`'s env source). */
function _denoEnv(name: string): string | undefined {
	try {
		return Deno.env.get(name);
	} catch {
		return undefined;
	}
}

function _whenAborted(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}
