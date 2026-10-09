/**
 * @module
 * `DOMWatchdog` — the bridge from `BrowserStateRequestEvent` to the DOM pipeline
 * (ARCHITECTURE.md §6.7, DATA-MODEL.md §5.3, §6.3 R6.1–R6.4).
 *
 * This watchdog is a **bridge, not a pipeline**. Capture, merge, index assignment and rendering all
 * live in `src/dom/` and none of it is reimplemented here. What this file owns is the *budget and
 * the assembly*:
 *
 * ```text
 * t=0     ┌ pending-network probe ─────────────► ≤ NETWORK_PROBE_MAX_MS (2 s),
 * │       │                                       needing NETWORK_STABILITY_MS (0.3 s) of quiet
 * │       ├ DOM build ────────────┐
 * │       ├ screenshot ───────────┤ in parallel, on the *remaining* budget
 * │       └ Page.getLayoutMetrics ┘
 * t≤20s   └ assemble BrowserStateSummary
 * ```
 *
 * The whole handler runs under one {@linkcode STATE_BUDGET_MS} deadline — probe, build, screenshot
 * and metrics share it, which is what "20 s combined" means once the probe is inside the same
 * request. The deadline is an `AbortSignal`, so a timeout at this level aborts the CDP sends beneath
 * it (ARCHITECTURE.md §8's level-N/level-N+1 rule).
 *
 * ## The two failure behaviours are contracts
 *
 * - **Failure → recovery state.** Anything that goes wrong inside the handler produces a *minimal
 *   recovery state* carrying `browserErrors`, and the handler returns it. It never throws. A throw
 *   would propagate through `eventResult({raiseIfAny: true})` and cost the agent its whole step for
 *   what is often a transient CDP hiccup.
 * - **Budget exhausted → non-actionable state.** When the deadline fires, the state carries
 *   `stateError` and an **empty** `selectorMap` (R6.4). The same shape is synthesized by
 *   `BrowserSession.getBrowserStateSummary()` when the *event* times out at the bus level. Both
 *   exist for one reason: an LLM must never be handed indices that no longer resolve, because the
 *   next thing it does with them is click.
 *
 * ## The summary's `url` is read from the page, not from the target record
 *
 * ERRATUM(M1-hardening-4): DATA-MODEL.md §5.3 gives `BrowserStateSummary.url` as "current tab url"
 * without naming a source, and `SessionManager`'s `TargetRecord.url` is the obvious free one. It is
 * also the wrong one: that record is written by `Target.targetInfoChanged`, which real Chrome emits
 * on its own schedule — measured at ~1.5 s behind `location.href` after a form-submit click. Since
 * `domState` in the *same* summary is extracted live, the record turns a summary into a lie: the
 * prompt's `Current tab:` line, `AgentHistory.state.url` and §6.6 replay all resolve the previous
 * page's URL beside the new page's elements. The URL is therefore read from the focused session the
 * way `Agent`'s `#pageSnapshot` reads it — `Runtime.evaluate('location.href')`, with the target
 * record as the fallback for a session that cannot answer. The §6.7 non-http fast path is decided
 * *first* and short-circuits the read entirely, so `about:blank` and `chrome://` states cost no
 * round trip and behave exactly as before.
 *
 * ## Naming trap
 *
 * `BaseWatchdog` documents it and this class obeys it: no helper may be named `on<Word>`, because
 * `registerHandlers` reads that as a handler for an event of that name. The state-assembly helpers
 * here are `#build…` / `#collect…` for exactly that reason.
 */

import type { SessionId, TargetId } from '@tykotech/cdp';
import type { BaseEvent, HandlerContext } from '@tykotech/bus';
import { BrowserStateRequestEvent, DialogOpenedEvent, ScreenshotEvent, TabCreatedEvent } from '../events.ts';
import {
	DOM_BUILD_BUDGET_MS,
	type DomExtractionResult,
	extractDomTree,
	NETWORK_PROBE_MAX_MS,
	NETWORK_STABILITY_MS,
	waitForNetworkStability,
} from '../dom/extract.ts';
import { type DomSerializationResult, serializeDomState } from '../dom/serialize.ts';
import { getMeaningfulTextForLlm } from '../dom/derived.ts';
import type { EnhancedDomTreeNode } from '../dom/types.ts';
import { type BrowserStateSummary, type NetworkRequest, type PageInfo, type TabInfo, toTabInfo } from '../types.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants (ARCHITECTURE.md §6.7, §8 — load-bearing, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/**
 * The combined budget DOM build + screenshot share (ARCHITECTURE.md §6.7).
 *
 * Pinned equal to the DOM pipeline's own {@linkcode DOM_BUILD_BUDGET_MS} by `dom_test.ts`: they are
 * the same 20 s, and two constants that must agree are one constant with an extra failure mode.
 */
export const STATE_BUDGET_MS = 20_000;

/**
 * Re-exported so a caller pins one import for the whole §6.7 budget: the 20 s pipeline ceiling, the
 * 2 s probe cap and the 0.3 s stability window.
 */
export { DOM_BUILD_BUDGET_MS, NETWORK_PROBE_MAX_MS, NETWORK_STABILITY_MS };

/** `pendingNetworkRequests` cap (DATA-MODEL.md §5.3: "≤20, filtered"). */
export const PENDING_NETWORK_LIMIT = 20;

/**
 * A request in flight longer than this is *stale*, not pending: it is a hung connection, a long-poll
 * or a server-sent-events stream, none of which mean "the page is still loading".
 *
 * ERRATUM(M1-watchdogs-data-1): §5.3 says `pendingNetworkRequests` excludes "ads/trackers/stale"
 * without defining stale. 10 s is chosen as 5× the 2 s probe cap: anything the probe waited out and
 * that is still running is by construction not something the next screenshot is waiting for.
 */
export const PENDING_NETWORK_STALE_MS = 10_000;

/** Bound on the in-flight tracker so a long run cannot grow it without limit. */
export const PENDING_NETWORK_TRACKER_LIMIT = 500;

/** How many bus events `includeRecentEvents` surfaces (DATA-MODEL.md §5.3: "last 10"). */
export const RECENT_EVENTS_COUNT = 10;

/**
 * Host fragments whose requests are excluded from `pendingNetworkRequests` (§5.3 "ads/trackers").
 *
 * ERRATUM(M1-watchdogs-data-2): §5.3 requires the filter but names no list. These are the
 * highest-volume third-party analytics/ad hosts; the list is a *display* filter on a diagnostic
 * field, never a security control (SecurityWatchdog owns blocking — SECURITY-AUTH.md §4).
 */
export const TRACKER_HOST_FRAGMENTS: readonly string[] = [
	'doubleclick.net',
	'googlesyndication.com',
	'googletagmanager.com',
	'google-analytics.com',
	'googleadservices.com',
	'analytics.',
	'facebook.net',
	'connect.facebook',
	'hotjar.com',
	'segment.io',
	'segment.com',
	'mixpanel.com',
	'amplitude.com',
	'sentry.io',
	'newrelic.com',
	'scorecardresearch.com',
	'adservice.',
	'adsystem.com',
	'criteo.com',
	'taboola.com',
	'outbrain.com',
];

/**
 * Labels that mark an element as a pagination control.
 *
 * ERRATUM(M1-watchdogs-data-5): `paginationButtonsDetected` is declared in DATA-MODEL.md §5.3 with
 * no detection rule anywhere in the spec set. Implemented as a label match over the interactive
 * elements the serializer already selected — accessible name, `aria-label`, `title`, `rel` and the
 * element's own meaningful text. It is a *hint* for the prompt layer, so a false negative costs
 * nothing and a false positive costs one sentence; the vocabulary is therefore deliberately narrow.
 */
export const PAGINATION_LABEL_PATTERNS: readonly RegExp[] = [
	/^\s*(?:next|previous|prev)\b/i,
	/\b(?:next|previous|prev)\s+page\b/i,
	/^\s*page\s+\d+\s*$/i,
	/^\s*(?:›|»|‹|«|→|←|>>|<<)\s*$/,
	/\b(?:older|newer)\s+(?:posts?|entries|results)\b/i,
	/\bload\s+more\b/i,
	/\bshow\s+more\s+results?\b/i,
];

/** `rel` values that mark a link as pagination regardless of its text. */
export const PAGINATION_REL_VALUES: readonly string[] = ['next', 'prev', 'previous'];

/**
 * Event fields safe to surface in `recentEvents`.
 *
 * ERRATUM(M1-watchdogs-data-6): §5.3 says `recentEvents` is "last 10 bus events as JSON". Serializing
 * events whole would put `TypeTextEvent.text` — which carries substituted `sensitiveData` (D-SEC2) —
 * straight into the prompt and the history file. Only the envelope plus this allow-list is emitted.
 */
export const RECENT_EVENT_FIELDS: readonly string[] = [
	'url',
	'targetId',
	'errorType',
	'message',
	'reason',
	'direction',
	'amount',
	'keys',
	'seconds',
	'fileName',
	'suggestedFilename',
	'loadingStatus',
	'status',
];

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/** Construction options. Every default is the real implementation. */
export interface DomWatchdogOptions {
	/** Overrides {@linkcode STATE_BUDGET_MS}; the contract test pins the default. */
	readonly budgetMs?: number | undefined;
	/** Injected clock, so the budget is drivable without wall-clock waits. */
	readonly now?: (() => number) | undefined;
	/**
	 * Optional reader for the session's auto-handled-dialog list. When a `PopupsWatchdog` keeps its
	 * own list, hand it in; otherwise this watchdog collects `DialogOpenedEvent` itself.
	 */
	readonly readClosedPopupMessages?: (() => readonly string[]) | undefined;
	/** Off skips the `Runtime.getEventListeners` census (one round trip per session). */
	readonly includeListenerCensus?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class DOMWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [BrowserStateRequestEvent, TabCreatedEvent, DialogOpenedEvent];
	static override readonly EMITS = [ScreenshotEvent];

	readonly #options: DomWatchdogOptions;
	readonly #now: () => number;
	readonly #budgetMs: number;
	/** In-flight network requests, for the `pendingNetworkRequests` field of §5.3. */
	readonly #inflight = new Map<string, TrackedRequest>();
	readonly #cdpUnsubscribes: (() => void)[] = [];
	/** Auto-handled JS dialogs awaiting their one appearance in a state summary. */
	#popupMessages: string[] = [];

	#lastSerialization: DomSerializationResult | null = null;
	#cachedState: BrowserStateSummary | null = null;

	constructor(host: WatchdogHost, options: DomWatchdogOptions = {}) {
		super(host);
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#budgetMs = options.budgetMs ?? STATE_BUDGET_MS;
	}

	// -- public surface (the DefaultActionWatchdog / Tools seam) ------------------------------------

	/** The effective combined budget. Defaults to {@linkcode STATE_BUDGET_MS} (ARCHITECTURE.md §6.7). */
	get budgetMs(): number {
		return this.#budgetMs;
	}

	/**
	 * The cached selector map from the most recent successful build (R6.3).
	 *
	 * Empty after a recovery or non-actionable state — deliberately: those states exist so nothing
	 * downstream can act on indices whose tree is gone.
	 */
	get selectorMap(): ReadonlyMap<number, EnhancedDomTreeNode> {
		return this.#lastSerialization?.state.selectorMap ?? new Map();
	}

	/** R6.3's cached reverse map: `sessionId:backendNodeId` → LLM index. */
	get reverseMap(): ReadonlyMap<string, number> {
		return this.#lastSerialization?.reverseMap ?? new Map();
	}

	/** The `[index]<tag …/>` text of §6.4 from the most recent build, or `''`. */
	get serializedText(): string {
		return this.#lastSerialization?.text ?? '';
	}

	/** The most recent summary this watchdog produced, or `null`. */
	get cachedState(): BrowserStateSummary | null {
		return this.#cachedState;
	}

	/** Resolves an LLM index to its node, or `null` when the index is not in the current map. */
	nodeForIndex(index: number): EnhancedDomTreeNode | null {
		return this.#lastSerialization?.state.selectorMap.get(index) ?? null;
	}

	/** Drops the cached map. Call when the page moved on in a way this watchdog did not observe. */
	clearCache(): void {
		this.#lastSerialization = null;
		this.#cachedState = null;
	}

	// -- handlers ----------------------------------------------------------------------------------

	/**
	 * Builds the agent-visible state. Never throws — see the module note on the two failure
	 * behaviours.
	 */
	async onBrowserStateRequestEvent(
		event: BrowserStateRequestEvent,
		context?: HandlerContext,
	): Promise<BrowserStateSummary> {
		const startedAt = this.#now();
		const budget = new AbortController();
		const timer = setTimeout(
			() => budget.abort(new DOMException(`browser state exceeded its ${this.#budgetMs} ms budget`, 'TimeoutError')),
			this.#budgetMs,
		);
		try {
			return await this.#buildState(event, this.#stateContext(budget.signal, context), startedAt);
		} catch (error) {
			// The recovery contract: a failure is data, not an exception.
			const reason = budget.signal.aborted
				? `browser state exceeded its ${this.#budgetMs} ms budget (ARCHITECTURE.md §6.7)`
				: `browser state could not be built: ${describeError(error)}`;
			this.logger.warn('browser state build failed; returning a recovery state', { error });
			return this.#assembleRecovery([reason], { stateError: budget.signal.aborted ? reason : null });
		} finally {
			clearTimeout(timer);
		}
	}

	/** Arms the network tracker for a newly created tab (DATA-MODEL.md §5.1.3 lists DOM as a consumer). */
	onTabCreatedEvent(_event: TabCreatedEvent, _context?: HandlerContext): void {
		this.#armNetworkTracker();
	}

	/**
	 * Records an auto-handled dialog as `"[type] message"` for the next state summary
	 * (DATA-MODEL.md §5.3 `closedPopupMessages`).
	 */
	onDialogOpenedEvent(event: DialogOpenedEvent, _context?: HandlerContext): void {
		this.#popupMessages.push(`[${event.dialogType}] ${event.message}`);
	}

	protected override beforeDetach(): void {
		this.#disarmNetworkTracker();
	}

	// -- state assembly ----------------------------------------------------------------------------

	/**
	 * The §6.7 budget composed with the bus's own — ERRATUM(E-52).
	 *
	 * Two deadlines govern a state build: this watchdog's `#budgetMs` and the dispatch's `timeoutSec`.
	 * They are not the same number and either can be the tighter one, so the CDP traffic must answer to
	 * both. `timeoutSec: 0` because the composite signal already carries every deadline in play; a
	 * second copy of the number here would be free to disagree with the timer that owns it.
	 */
	#stateContext(signal: AbortSignal, context: HandlerContext | undefined): HandlerContext {
		const handlerName = context?.handlerName ?? 'DomWatchdog.onBrowserStateRequestEvent';
		const composed = context === undefined ? signal : AbortSignal.any([signal, context.signal]);
		return { signal: composed, handlerName, timeoutSec: 0 };
	}

	async #buildState(
		event: BrowserStateRequestEvent,
		context: HandlerContext,
		startedAt: number,
	): Promise<BrowserStateSummary> {
		const signal = context.signal;
		this.#armNetworkTracker();
		const manager = this.sessions;
		const session = await manager.getOrCreateCdpSession(null, true);
		const targetId = session.targetId;
		const target = manager.targets.get(targetId);
		const recordedUrl = target?.url ?? '';
		// The §6.7 fast path: a non-http(s) URL has no DOM worth building and no network to wait for —
		// and no `location.href` worth a round trip either. Decided on the record, so the short-circuit
		// stays a short-circuit; only an http(s) page pays for the live read (ERRATUM(M1-hardening-4)).
		const url = isHttpUrl(recordedUrl) ? await this.#readUrl(session.sessionId, recordedUrl, context) : recordedUrl;
		const browserErrors: string[] = [];

		const fastPath = !isHttpUrl(url) || !event.includeDom;

		if (!fastPath) {
			const probe = await waitForNetworkStability({
				client: this.cdpFor(context),
				sessionId: session.sessionId,
				signal,
			});
			this.logger.debug('pending-network probe finished', {
				stable: probe.stable,
				waitedMs: Math.round(probe.waitedMs),
				pending: probe.pending,
			});
		}

		const remainingMs = Math.max(0, this.#budgetMs - (this.#now() - startedAt));
		const [extraction, screenshot, metrics, title] = await Promise.all([
			fastPath ? Promise.resolve(null) : this.#buildDom(session, remainingMs, context),
			event.includeScreenshot ? this.#captureScreenshot(browserErrors) : Promise.resolve(null),
			this.#readLayoutMetrics(session.sessionId, browserErrors, context),
			this.#readTitle(session.sessionId, target?.title ?? '', context),
		]);

		// R6.4: the deadline can fire *inside* the pipeline, which absorbs the abort and answers with its
		// own recovery state. That is still a whole-request timeout, and it still owes the caller a
		// non-actionable state — checked here rather than trusting the inner result's `timedOut` flag.
		if (signal.aborted) {
			const reason = `browser state exceeded its ${this.#budgetMs} ms budget (ARCHITECTURE.md §6.7)`;
			// The live URL is already in hand: a timed-out state is still a state about a *page*, and the
			// one field it can still be honest about must not fall back to the lagging record.
			return this.#assembleRecovery([reason, ...(extraction?.browserErrors ?? [])], { stateError: reason, url });
		}

		const pageInfo = metrics ?? zeroPageInfo();
		const serialized = this.#serialize(extraction, pageInfo, url, event.includeOffscreen);
		this.#lastSerialization = serialized;
		if (extraction !== null) browserErrors.push(...extraction.browserErrors);

		const summary: BrowserStateSummary = {
			url,
			title,
			tabs: this.#collectTabs(),
			screenshot,
			domState: serialized.state,
			pageInfo,
			isPdfViewer: isPdfViewerUrl(url),
			pendingNetworkRequests: this.#collectPendingRequests(),
			browserErrors,
			recentEvents: event.includeRecentEvents ? this.#collectRecentEvents() : null,
			closedPopupMessages: this.#drainPopupMessages(),
			paginationButtonsDetected: detectPaginationButtons(serialized.state.selectorMap),
			stateError: serialized.stateError,
			stateToken: serialized.stateToken,
			// ERRATUM(E-40): the frame list and the session-cap flag, straight from the extraction.
			frames: extraction === null ? [] : [...extraction.frameTree],
			captureTruncated: extraction?.captureTruncated ?? false,
		};
		this.#cachedState = summary;
		this.logger.debug('browser state assembled', {
			url,
			durationMs: Math.round(this.#now() - startedAt),
			selectorCount: serialized.state.selectorMap.size,
			browserErrors: browserErrors.length,
		});
		return summary;
	}

	/**
	 * The DOM half of the parallel phase.
	 *
	 * `waitForNetwork: false` because the probe already ran at this level — running it again inside
	 * the pipeline would double the 2 s cap.
	 */
	#buildDom(
		session: { targetId: TargetId; sessionId: SessionId },
		budgetMs: number,
		context: HandlerContext,
	): Promise<DomExtractionResult> {
		const manager = this.sessions;
		return extractDomTree({
			client: this.cdpFor(context),
			root: { targetId: session.targetId, sessionId: session.sessionId },
			waitForNetwork: false,
			budgetMs,
			signal: context.signal,
			resolveChildSession: async (frameId) => {
				if (!this.profile.crossOriginIframes) return null;
				try {
					// §7.3: SessionManager is the only sanctioned way to obtain a session id. An OOPIF's
					// target id is its frame id, and it must never take the agent's focus.
					const child = await manager.getOrCreateCdpSession(frameId, false);
					return { targetId: child.targetId, sessionId: child.sessionId, frameId };
				} catch {
					return null;
				}
			},
			...(this.#options.includeListenerCensus === undefined
				? {}
				: { includeListenerCensus: this.#options.includeListenerCensus }),
		});
	}

	/**
	 * Dispatches `ScreenshotEvent` nested inside the state request.
	 *
	 * ScreenshotWatchdog is a peer; this codes against the event contract only. No handler at all is
	 * a configuration fact (`screenshot: null`); a handler that *throws* is a browser error.
	 */
	async #captureScreenshot(browserErrors: string[]): Promise<string | null> {
		try {
			const result = await this.bus.dispatch(new ScreenshotEvent()).eventResult({ raiseIfAny: true });
			return result ?? null;
		} catch (error) {
			browserErrors.push(`screenshot failed: ${describeError(error)}`);
			return null;
		}
	}

	/**
	 * The page's own `location.href` — see the module note on ERRATUM(M1-hardening-4).
	 *
	 * Deliberately the same shape as `Agent.#pageSnapshot`: evaluate on the focused session, fall back
	 * to the cached record when there is no live answer. A navigation in flight can make the evaluate
	 * fail or return a non-string; the record is then the best available.
	 */
	async #readUrl(sessionId: SessionId, fallback: string, context: HandlerContext): Promise<string> {
		try {
			const result = await this.cdpFor(context).send.Runtime.evaluate({
				expression: 'location.href',
				returnByValue: true,
			}, sessionId);
			const value = result.result.value;
			return typeof value === 'string' && value !== '' ? value : fallback;
		} catch {
			return fallback;
		}
	}

	/**
	 * The page's own `document.title`.
	 *
	 * ERRATUM(M1-watchdogs-data-7): `Target.targetInfo.title` — the obvious free source — is what
	 * SessionManager tracks, and Chrome seeds it with the *host* until the document title propagates
	 * through `targetInfoChanged`. Verified against real headless Chrome: a page titled `listing`
	 * reports `127.0.0.1:52139` at state-request time. `BrowserStateSummary.title` is prompt content,
	 * so it is read from the page, with the target record as the fallback.
	 */
	async #readTitle(sessionId: SessionId, fallback: string, context: HandlerContext): Promise<string> {
		try {
			const result = await this.cdpFor(context).send.Runtime.evaluate({
				expression: 'document.title',
				returnByValue: true,
			}, sessionId);
			const value = result.result.value;
			return typeof value === 'string' ? value : fallback;
		} catch {
			return fallback;
		}
	}

	/** The single `Page.getLayoutMetrics` of §6.7 — PageInfo comes from exactly one call. */
	async #readLayoutMetrics(
		sessionId: SessionId,
		browserErrors: string[],
		context: HandlerContext,
	): Promise<PageInfo | null> {
		try {
			const metrics = await this.cdpFor(context).send.Page.getLayoutMetrics(undefined, sessionId);
			return toPageInfo(metrics);
		} catch (error) {
			browserErrors.push(`page geometry unavailable: ${describeError(error)}`);
			return null;
		}
	}

	#serialize(
		extraction: DomExtractionResult | null,
		pageInfo: PageInfo,
		url: string,
		includeOffscreen = false,
	): DomSerializationResult {
		if (extraction === null) {
			// Fast path: an empty state, not a failed one — no `stateError`, so it stays actionable.
			return {
				state: { root: null, selectorMap: new Map() },
				text: '',
				reverseMap: new Map(),
				keys: new Set(),
				stateError: null,
				truncated: false,
				stateToken: null,
			};
		}
		const serialized = serializeDomState(extraction.root, {
			topUrl: url,
			frames: extraction.frames,
			previousKeys: this.#lastSerialization?.keys,
			paintOrderFiltering: this.profile.paintOrderFiltering,
			pixelsAbove: pageInfo.pixelsAbove,
			pixelsBelow: pageInfo.pixelsBelow,
			// ERRATUM(E-41): the offscreen class is admitted only when the request asked for it.
			includeOffscreen,
		});
		// R6.4: a build that ran out of budget yields a state the LLM must not act on. `recovered`
		// without `timedOut` is an ordinary failure — recoverable, reported through `browserErrors`.
		if (extraction.timedOut && serialized.stateError === null) {
			return {
				...serialized,
				state: { root: null, selectorMap: new Map() },
				reverseMap: new Map(),
				stateError: extraction.browserErrors[0] ?? 'DOM build exceeded its budget',
				stateToken: null,
			};
		}
		return serialized;
	}

	/** The minimal recovery state of §6.7. Carries `browserErrors`; never throws on the way out. */
	#assembleRecovery(
		browserErrors: readonly string[],
		options: { stateError?: string | null; url?: string } = {},
	): BrowserStateSummary {
		const manager = this.host.sessionManager;
		const focus = manager?.agentFocusTargetId ?? null;
		// The record is the fallback of last resort here and only here: this path exists because the
		// live read is exactly what failed.
		const url = options.url ?? (focus === null ? '' : manager?.targets.get(focus)?.url ?? '');
		this.#lastSerialization = null;
		const summary: BrowserStateSummary = {
			url,
			title: focus === null ? '' : manager?.targets.get(focus)?.title ?? '',
			tabs: this.#collectTabs(),
			screenshot: null,
			domState: { root: null, selectorMap: new Map() },
			pageInfo: zeroPageInfo(),
			isPdfViewer: isPdfViewerUrl(url),
			pendingNetworkRequests: [],
			browserErrors: [...browserErrors],
			recentEvents: null,
			closedPopupMessages: this.#drainPopupMessages(),
			paginationButtonsDetected: false,
			stateError: options.stateError ?? null,
			// No table, so nothing to address: `nodeAt` reports `no-state` rather than `stale-token`.
			stateToken: null,
			frames: [],
			captureTruncated: false,
		};
		this.#cachedState = summary;
		return summary;
	}

	// -- collectors --------------------------------------------------------------------------------

	#collectTabs(): TabInfo[] {
		const manager = this.host.sessionManager;
		if (manager === null) return [];
		return manager.pageTargets().reverse().map((record) => toTabInfo(record));
	}

	#collectPendingRequests(): NetworkRequest[] {
		const now = this.#now();
		const requests: NetworkRequest[] = [];
		for (const tracked of this.#inflight.values()) {
			const loadingDurationMs = Math.max(0, now - tracked.startedAt);
			if (loadingDurationMs > PENDING_NETWORK_STALE_MS) continue;
			if (isTrackerUrl(tracked.url)) continue;
			requests.push({
				url: tracked.url,
				method: tracked.method,
				loadingDurationMs,
				resourceType: tracked.resourceType,
			});
		}
		requests.sort((a, b) => b.loadingDurationMs - a.loadingDurationMs);
		return requests.slice(0, PENDING_NETWORK_LIMIT);
	}

	#collectRecentEvents(): string {
		const events = this.bus.recentEvents(RECENT_EVENTS_COUNT);
		return JSON.stringify(events.map((event) => summarizeEvent(event)));
	}

	/** Popup messages are reported once: the agent sees each auto-handled dialog exactly one step. */
	#drainPopupMessages(): string[] {
		const injected = this.#options.readClosedPopupMessages?.() ?? [];
		const messages = [...injected, ...this.#popupMessages];
		this.#popupMessages = [];
		return [...new Set(messages)];
	}

	// -- network tracker ---------------------------------------------------------------------------

	#armNetworkTracker(): void {
		if (this.#cdpUnsubscribes.length > 0) return;
		const client = this.host.cdpClient;
		if (client === null || client.state !== 'open') return;
		this.#cdpUnsubscribes.push(
			client.on('Network.requestWillBeSent', (params) => {
				if (this.#inflight.size >= PENDING_NETWORK_TRACKER_LIMIT) {
					const oldest = this.#inflight.keys().next();
					if (!oldest.done) this.#inflight.delete(oldest.value);
				}
				this.#inflight.set(params.requestId, {
					url: params.request.url,
					method: params.request.method,
					resourceType: params.type ?? 'Other',
					startedAt: this.#now(),
				});
			}),
			client.on('Network.loadingFinished', (params) => {
				this.#inflight.delete(params.requestId);
			}),
			client.on('Network.loadingFailed', (params) => {
				this.#inflight.delete(params.requestId);
			}),
		);
	}

	#disarmNetworkTracker(): void {
		for (const off of this.#cdpUnsubscribes) off();
		this.#cdpUnsubscribes.length = 0;
		this.#inflight.clear();
	}
}

interface TrackedRequest {
	readonly url: string;
	readonly method: string;
	readonly resourceType: string;
	readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// module helpers (pure — unit-testable without a browser)
// ---------------------------------------------------------------------------

/** The §6.7 fast-path predicate: only http(s) URLs get a DOM build. */
export function isHttpUrl(url: string): boolean {
	if (url === '') return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * `isPdfViewer` (DATA-MODEL.md §5.3: "url heuristic").
 *
 * A `.pdf` path on any scheme Chrome can render one from, plus Chrome's built-in PDF viewer
 * extension origin, which is what the URL looks like once the viewer has taken over.
 */
export function isPdfViewerUrl(url: string): boolean {
	if (url === '') return false;
	if (url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')) return true;
	try {
		const parsed = new URL(url);
		return parsed.pathname.toLowerCase().endsWith('.pdf');
	} catch {
		return url.toLowerCase().endsWith('.pdf');
	}
}

/** `true` when a URL belongs to one of the {@linkcode TRACKER_HOST_FRAGMENTS}. */
export function isTrackerUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return TRACKER_HOST_FRAGMENTS.some((fragment) => host.includes(fragment));
}

/** `Page.getLayoutMetrics` → the `PageInfo` of DATA-MODEL.md §5.3, from exactly one call. */
export function toPageInfo(metrics: {
	layoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
	contentSize: { width: number; height: number };
	cssLayoutViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
	cssContentSize?: { width: number; height: number };
}): PageInfo {
	const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
	const content = metrics.cssContentSize ?? metrics.contentSize;
	const viewportWidth = viewport.clientWidth;
	const viewportHeight = viewport.clientHeight;
	const pageWidth = Math.max(content.width, viewportWidth);
	const pageHeight = Math.max(content.height, viewportHeight);
	const scrollX = viewport.pageX;
	const scrollY = viewport.pageY;
	return {
		viewportWidth,
		viewportHeight,
		pageWidth,
		pageHeight,
		scrollX,
		scrollY,
		pixelsAbove: Math.max(0, Math.round(scrollY)),
		pixelsBelow: Math.max(0, Math.round(pageHeight - scrollY - viewportHeight)),
		pixelsLeft: Math.max(0, Math.round(scrollX)),
		pixelsRight: Math.max(0, Math.round(pageWidth - scrollX - viewportWidth)),
	};
}

/** All-zero geometry, used by the recovery and fast-failure paths. */
export function zeroPageInfo(): PageInfo {
	return {
		viewportWidth: 0,
		viewportHeight: 0,
		pageWidth: 0,
		pageHeight: 0,
		scrollX: 0,
		scrollY: 0,
		pixelsAbove: 0,
		pixelsBelow: 0,
		pixelsLeft: 0,
		pixelsRight: 0,
	};
}

/** The label a pagination match is tested against: AX name, aria-label, title, rel, and text. */
export function paginationLabelsOf(node: EnhancedDomTreeNode): string[] {
	const labels: string[] = [];
	const push = (value: string | null | undefined): void => {
		if (value !== null && value !== undefined && value.trim() !== '') labels.push(value.trim());
	};
	push(node.axNode?.name);
	push(node.attributes['aria-label']);
	push(node.attributes['title']);
	push(node.attributes['rel']);
	push(getMeaningfulTextForLlm(node));
	return labels;
}

/** `paginationButtonsDetected` (DATA-MODEL.md §5.3) — see ERRATUM(M1-watchdogs-data-5). */
export function detectPaginationButtons(selectorMap: ReadonlyMap<number, EnhancedDomTreeNode>): boolean {
	for (const node of selectorMap.values()) {
		const rel = node.attributes['rel']?.toLowerCase().trim();
		if (rel !== undefined && PAGINATION_REL_VALUES.includes(rel)) return true;
		for (const label of paginationLabelsOf(node)) {
			if (PAGINATION_LABEL_PATTERNS.some((pattern) => pattern.test(label))) return true;
		}
	}
	return false;
}

/**
 * One `recentEvents` entry: the envelope plus {@linkcode RECENT_EVENT_FIELDS}.
 *
 * Never the whole event — see ERRATUM(M1-watchdogs-data-6).
 */
export function summarizeEvent(event: BaseEvent<unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {
		eventType: event.eventType,
		eventId: event.eventId,
		eventCreatedAt: event.eventCreatedAt,
	};
	const source = event as unknown as Record<string, unknown>;
	for (const field of RECENT_EVENT_FIELDS) {
		const value = source[field];
		if (value === undefined || value === null) continue;
		if (typeof value === 'object') continue;
		summary[field] = value;
	}
	return summary;
}

function describeError(value: unknown): string {
	return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}
