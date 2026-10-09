/**
 * @module
 * The navigation readiness state machine (ARCHITECTURE.md §7.5).
 *
 * All five steps, in order:
 *
 * 1. `Page.navigate({url, transitionType: 'address_bar'})`, capped at the event timeout. A CDP
 *    `errorText` in the result is a **hard error** — Chrome answered, and it answered "no".
 * 2. `waitUntil: 'commit'` ⇒ done the moment `navigate` returns.
 * 3. No `loaderId` in the result ⇒ same-document navigation (fragment / History API) ⇒ done
 *    immediately. Chrome emits no new lifecycle events for those, so polling would only ever time out.
 * 4. Otherwise poll the SessionManager's per-target lifecycle ring buffer every
 *    {@linkcode LIFECYCLE_POLL_INTERVAL_MS} for an acceptable event. Staleness: a record whose
 *    `loaderId` differs from the navigation's is ignored outright; a record with no `loaderId` counts
 *    only if it was received after the navigation started.
 * 5. The readiness timeout is **non-fatal**. Explicit `timeoutMs` when given, else the heuristic
 *    {@linkcode READINESS_TIMEOUT_SAME_DOMAIN_MS} / {@linkcode READINESS_TIMEOUT_CROSS_DOMAIN_MS}. On
 *    expiry the navigation *succeeds* carrying `loadingStatus`, so the agent sees a slow page rather
 *    than an error it will pointlessly retry.
 *
 * This module owns readiness only. Target resolution, focus, the security veto, and the
 * `NavigationStarted`/`NavigationComplete` events belong to `BrowserSession` (§7.5 preamble).
 */

import type { CdpClient, SessionId, TargetId } from '@tykotech/cdp';
import { delay } from '@std/async';
import { BrowserError } from '../errors.ts';
import type { WaitUntil } from '../types.ts';
import type { LifecycleRecord, SessionManager } from './session_manager.ts';

// ---------------------------------------------------------------------------
// timing constants (ARCHITECTURE.md §8 — load-bearing, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/** Ring-buffer poll cadence while waiting for readiness (ARCHITECTURE.md §7.5 step 4, §8). */
export const LIFECYCLE_POLL_INTERVAL_MS = 50;

/** Heuristic readiness budget when the navigation stays on the same domain (§7.5 step 5). */
export const READINESS_TIMEOUT_SAME_DOMAIN_MS = 3_000;

/** Heuristic readiness budget for a cross-domain navigation (§7.5 step 5). */
export const READINESS_TIMEOUT_CROSS_DOMAIN_MS = 8_000;

/** `Page.navigate` is issued with this transition type (ARCHITECTURE.md §7.5 step 1). */
export const NAVIGATE_TRANSITION_TYPE = 'address_bar';

/**
 * Lifecycle event names that satisfy each `waitUntil` level (ARCHITECTURE.md §7.5 step 4):
 * `networkIdle` always counts; `load` counts for load/domcontentloaded; `DOMContentLoaded` counts for
 * domcontentloaded. `commit` never reaches the poller (step 2 returns first) but is listed so the
 * table is total.
 */
export const ACCEPTABLE_LIFECYCLE_EVENTS: Readonly<Record<WaitUntil, readonly string[]>> = Object.freeze({
	networkidle: ['networkIdle'],
	load: ['load', 'networkIdle'],
	domcontentloaded: ['DOMContentLoaded', 'load', 'networkIdle'],
	commit: [],
});

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/**
 * How the wait ended.
 *
 * `'abandoned'` (ERRATUM(E-62)) is the readiness wait stopping because the *caller* was cancelled
 * rather than because the budget ran out. It is a separate member rather than another `'timeout'`
 * because `loadingStatus` becomes prompt content: reporting "timeout after 8s" on a wait that lasted
 * 200 ms would put a false number in front of the model.
 */
export type NavigationResolution = 'commit' | 'same-document' | 'lifecycle' | 'timeout' | 'abandoned';

/** Options for {@linkcode navigateAndWait}. */
export interface NavigateOptions {
	/** Readiness level (DATA-MODEL.md §5.1.1, default `'load'`). */
	readonly waitUntil?: WaitUntil | undefined;
	/** Explicit readiness cap; `null`/omitted selects the same/cross-domain heuristic. */
	readonly timeoutMs?: number | null | undefined;
	/** Cap on `Page.navigate` itself — the event timeout (ARCHITECTURE.md §7.5 step 1). */
	readonly navigateTimeoutMs?: number | undefined;
	/** The target's url before the navigation; drives the same/cross-domain heuristic. */
	readonly fromUrl?: string | null | undefined;
	/** Poll cadence override; the default is the normative 50 ms. */
	readonly pollIntervalMs?: number | undefined;
	/**
	 * Cancellation. Gates **entry** to step 1 and is honoured throughout the readiness wait; it is
	 * deliberately **not** bound to the `Page.navigate` call itself — ERRATUM(E-62), see the note on
	 * {@linkcode navigateAndWait}.
	 */
	readonly signal?: AbortSignal | undefined;
	/** Injected clock so `FakeTime` can drive the readiness budget. */
	readonly now?: (() => number) | undefined;
}

/** Outcome of one navigation. `loadingStatus` is non-null exactly when readiness timed out. */
export interface NavigationResult {
	readonly frameId: string;
	readonly loaderId: string | null;
	/** `true` when Chrome reported no `loaderId` (fragment / History API navigation). */
	readonly sameDocument: boolean;
	readonly resolution: NavigationResolution;
	/** `'timeout after Xs waiting for <level> (saw: …)'`, or `null` on a clean navigation. */
	readonly loadingStatus: string | null;
	/** Distinct lifecycle names that survived the staleness filter, in arrival order. */
	readonly observed: readonly string[];
	/** Wall-clock milliseconds spent in the readiness wait (0 for commit/same-document). */
	readonly waitedMs: number;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Runs the full §7.5 machine against one already-focused target.
 *
 * ## Cancellation, and the one step that is deliberately uncancellable — ERRATUM(E-62)
 *
 * The two phases have opposite answers to *"what is safe to abandon mid-flight?"*, so they get
 * opposite treatment:
 *
 * - **Steps 4–5, the readiness wait, are fully cancellable.** Abandoning them changes nothing about
 *   the browser — the page goes on loading exactly as it was. All that stops is our waiting, and this
 *   is the phase that actually spends the budget (up to 8 s on the cross-domain heuristic). An
 *   abandoned wait returns the ordinary non-fatal `'timeout'` result, so the caller still gets a
 *   `NavigationResult` describing what was observed.
 * - **Step 1, `Page.navigate`, is NOT bound to the signal.** Once that command is on the wire Chrome
 *   navigates whether or not we are still listening, so binding a signal there does not *cancel* a
 *   navigation — it converts "the page navigated and we know where it went" into "the page navigated
 *   and we told the caller it failed", leaving the next handler to observe a page nobody recorded.
 *   That is strictly worse than not binding. The signal instead gates **entry**: an already-abandoned
 *   handler throws before the command is composed, which is the honest cancellation on offer and the
 *   one with all of the value. The call cannot outlive the socket either way — `@tykotech/cdp` composes
 *   the client's own lifetime signal into every request, so a closed transport settles it at once.
 *
 * ERRATUM(E-62) note: `options.signal` *was* spread into the `Page.navigate` call, and that branch
 * had never executed — no caller passed a signal until this change. Making the option live without
 * re-deciding its semantics would have shipped the hazard above on the first real use.
 *
 * @throws {BrowserError} only for a hard `Page.navigate` failure (step 1). A readiness timeout is a
 * success carrying {@linkcode NavigationResult.loadingStatus} — that asymmetry is the whole point of
 * step 5 and is asserted by the contract tests.
 * @throws the signal's abort reason when the caller was already abandoned before step 1.
 */
export async function navigateAndWait(
	sessions: SessionManager,
	targetId: TargetId,
	sessionId: SessionId,
	url: string,
	options: NavigateOptions = {},
): Promise<NavigationResult> {
	const client: CdpClient = sessions.client;
	const now = options.now ?? Date.now;
	const waitUntil: WaitUntil = options.waitUntil ?? 'load';
	const startedAt = now();

	// Step 1 — navigate, capped at the event timeout; `errorText` is a hard error.
	//
	// The entry gate, and the whole of this step's cancellation: refusing to start is honest, while
	// abandoning a navigate already on the wire is not (see the note above). DELIBERATELY UNBOUND —
	// `client.send`, not a signal-bound view.
	options.signal?.throwIfAborted();
	const result = await client.send.Page.navigate(
		{ url, transitionType: NAVIGATE_TRANSITION_TYPE },
		sessionId,
		options.navigateTimeoutMs === undefined ? undefined : { requestTimeoutMs: options.navigateTimeoutMs },
	);
	if (result.errorText !== undefined && result.errorText !== '') {
		throw new BrowserError(`navigation to ${url} failed: ${result.errorText}`, {
			longTermMemory: `Navigation to ${url} failed: ${result.errorText}`,
		});
	}

	const loaderId = result.loaderId ?? null;

	// Step 2 — 'commit' is satisfied by the navigate call returning.
	if (waitUntil === 'commit') {
		return _clean(result.frameId, loaderId, 'commit', [], 0);
	}

	// Step 3 — no loaderId ⇒ same-document navigation; Chrome emits no new lifecycle events.
	if (loaderId === null) {
		return _clean(result.frameId, null, 'same-document', [], 0);
	}

	// Steps 4 + 5 — poll the ring buffer, then fall through to the non-fatal timeout.
	const budgetMs = resolveReadinessTimeoutMs(options.timeoutMs ?? null, options.fromUrl ?? null, url);
	const pollMs = options.pollIntervalMs ?? LIFECYCLE_POLL_INTERVAL_MS;
	const accepted = ACCEPTABLE_LIFECYCLE_EVENTS[waitUntil];
	const deadline = startedAt + budgetMs;
	let observed: string[] = [];
	let abandoned = false;

	for (;;) {
		const records = sessions.lifecycleEventsFor(targetId);
		const fresh = records.filter((record) => isFreshFor(record, loaderId, startedAt));
		observed = _distinctNames(fresh);
		if (fresh.some((record) => accepted.includes(record.name))) {
			return _clean(result.frameId, loaderId, 'lifecycle', observed, now() - startedAt);
		}
		const remaining = deadline - now();
		if (remaining <= 0) break;
		try {
			await delay(Math.min(pollMs, remaining), options.signal === undefined ? undefined : { signal: options.signal });
		} catch {
			// Abandoned — the only way `delay` rejects is its signal, whether that signal was already
			// aborted when we got here or aborted while the timer was pending. Both are the same event and
			// take the same exit, so there is deliberately no second `signal.aborted` pre-check above:
			// a redundant branch nothing can distinguish is a branch no test can defend (ERRATUM(E-62) —
			// it was written, and a mutation removing it survived).
			//
			// Step 5's contract is that running out of *time* is a non-fatal result; running out of
			// *permission* is the same kind of event — the page is still loading, we simply stopped
			// watching — so this falls through to a result rather than becoming a rejection. Turning an
			// observation into a failure here would make the agent retry a navigation that succeeded.
			abandoned = true;
			break;
		}
	}

	const waitedMs = now() - startedAt;
	return {
		frameId: result.frameId,
		loaderId,
		sameDocument: false,
		resolution: abandoned ? 'abandoned' : 'timeout',
		loadingStatus: abandoned
			? formatAbandonedStatus(waitedMs, waitUntil, observed)
			: formatLoadingStatus(budgetMs, waitUntil, observed),
		observed,
		waitedMs,
	};
}

// ---------------------------------------------------------------------------
// the rules, exported so the contract tests can pin them individually
// ---------------------------------------------------------------------------

/**
 * §7.5 step 5: explicit `timeoutMs` wins; otherwise 3 s same-domain / 8 s cross-domain.
 *
 * An unparseable or absent `fromUrl` is treated as cross-domain: the longer budget is the safe
 * direction, since overrunning it costs latency while undershooting costs a `loadingStatus` on a page
 * that was merely slow.
 */
export function resolveReadinessTimeoutMs(
	explicitMs: number | null,
	fromUrl: string | null,
	toUrl: string,
): number {
	if (explicitMs !== null && Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;
	return isSameDomain(fromUrl, toUrl) ? READINESS_TIMEOUT_SAME_DOMAIN_MS : READINESS_TIMEOUT_CROSS_DOMAIN_MS;
}

/** Hostname equality through the WHATWG parser — never a string prefix (SECURITY-AUTH.md §4.1 M9). */
export function isSameDomain(fromUrl: string | null, toUrl: string): boolean {
	if (fromUrl === null || fromUrl === '') return false;
	const from = URL.parse(fromUrl);
	const to = URL.parse(toUrl);
	if (from === null || to === null) return false;
	if (from.hostname === '' || to.hostname === '') return false;
	return from.hostname.toLowerCase() === to.hostname.toLowerCase();
}

/**
 * §7.5 step 4 staleness rule. A record counts when it belongs to this navigation's `loaderId`, or —
 * for records Chrome sent without one — when it arrived after the navigation started.
 */
export function isFreshFor(record: LifecycleRecord, loaderId: string, navStartedAt: number): boolean {
	if (record.loaderId === null) return record.receivedAt >= navStartedAt;
	return record.loaderId === loaderId;
}

/** `'timeout after 3s waiting for load (saw: init, DOMContentLoaded)'` (ARCHITECTURE.md §7.5). */
export function formatLoadingStatus(budgetMs: number, waitUntil: WaitUntil, observed: readonly string[]): string {
	return _formatStatus('timeout', budgetMs, waitUntil, observed);
}

/**
 * `'abandoned after 0.2s waiting for load (saw: init)'` — ERRATUM(E-62).
 *
 * Carries the time actually **waited**, not the budget: the budget is not what ended this wait, and
 * the number reaches the model.
 */
export function formatAbandonedStatus(waitedMs: number, waitUntil: WaitUntil, observed: readonly string[]): string {
	return _formatStatus('abandoned', waitedMs, waitUntil, observed);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _clean(
	frameId: string,
	loaderId: string | null,
	resolution: NavigationResolution,
	observed: readonly string[],
	waitedMs: number,
): NavigationResult {
	return {
		frameId,
		loaderId,
		sameDocument: resolution === 'same-document',
		resolution,
		loadingStatus: null,
		observed,
		waitedMs,
	};
}

/** One body behind both status lines, so the two wordings cannot drift into disagreeing shapes. */
function _formatStatus(reason: string, ms: number, waitUntil: WaitUntil, observed: readonly string[]): string {
	const saw = observed.length === 0 ? 'nothing' : observed.join(', ');
	return `${reason} after ${_formatSeconds(ms)}s waiting for ${waitUntil} (saw: ${saw})`;
}

function _distinctNames(records: readonly LifecycleRecord[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const record of records) {
		if (seen.has(record.name)) continue;
		seen.add(record.name);
		names.push(record.name);
	}
	return names;
}

/** `3000 → '3'`, `1500 → '1.5'` — whole seconds stay whole, so the spec's `Xs` reads naturally. */
function _formatSeconds(ms: number): string {
	const seconds = ms / 1_000;
	return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}
