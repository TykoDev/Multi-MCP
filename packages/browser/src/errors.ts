/**
 * Core error taxonomy for `@tykotech/browser`.
 *
 * Contract: AGENTS.md §3 ("use the typed taxonomy in DATA-MODEL.md §4.4 ... plus
 * `BrowserError {shortTermMemory?, longTermMemory?}` and per-package subclasses. Never throw
 * strings."), ARCHITECTURE.md §4 (`UrlNotAllowedError` aborts a navigation through `eventResult()`),
 * SECURITY-AUTH.md §4.3 (pre-navigation veto), AGENT-RUNTIME.md §11.1 (`InterruptedError`).
 *
 * Division of labour with the LLM layer: `ModelError` / `ModelProviderError` /
 * `ModelRateLimitError` / `ModelOutputTruncatedError` (DATA-MODEL.md §4.4) belong to `@bua/llm` and
 * are deliberately NOT redeclared here — one taxonomy, one owner.
 *
 * Inside action handlers, *expected* failures return an `ActionResult` with `error` set; throwing is
 * reserved for bugs and transport death (AGENTS.md §3).
 */

/** Memory hints an error can carry into the agent's prompt (AGENTS.md §3). */
export interface BrowserErrorMemory {
	/**
	 * Detail for the one-shot `<read_state>` block of the next state message
	 * (DATA-MODEL.md §2.6 routing rule 1) — e.g. the list of options a dropdown actually had.
	 */
	shortTermMemory?: string | null;
	/** Durable line appended to the step's Result block in `<agent_history>` (§2.6 rule 2). */
	longTermMemory?: string | null;
}

/** Constructor bag for {@linkcode BrowserError}. */
export interface BrowserErrorInit extends BrowserErrorMemory {
	cause?: unknown;
}

/**
 * Base class for every browser-layer error raised by `@tykotech/browser`.
 *
 * The two memory fields exist so a watchdog can hand the agent a *usable* failure ("here are the
 * options that do exist") instead of a stack trace. They are `string | null` rather than optional
 * per the AGENTS.md §3 house rule (mirrors ERRATUM(M0-bus-1) in `@tykotech/bus`).
 */
export class BrowserError extends Error {
	override readonly name: string = 'BrowserError';
	readonly shortTermMemory: string | null;
	readonly longTermMemory: string | null;

	constructor(message: string, init: BrowserErrorInit = {}) {
		super(message, init.cause === undefined ? undefined : { cause: init.cause });
		this.shortTermMemory = init.shortTermMemory ?? null;
		this.longTermMemory = init.longTermMemory ?? null;
	}
}

/**
 * A navigation target failed the domain policy (SECURITY-AUTH.md §4.1/§4.3).
 *
 * Thrown by `SecurityWatchdog.onNavigateToUrlEvent` **and** by `BrowserSession`'s own navigation
 * path: per build-run erratum E-3 a throwing handler does not abort its siblings, so enforcement
 * lives in the shared `isUrlAllowed` matcher that both call — never in handler registration order.
 */
export class UrlNotAllowedError extends BrowserError {
	override readonly name: string = 'UrlNotAllowedError';
	readonly url: string;
	/** Which rule rejected the URL, for the `BrowserErrorEvent.details` payload. */
	readonly reason: string;

	constructor(url: string, reason = 'blocked by domain policy', init: BrowserErrorInit = {}) {
		super(`Navigation to ${url} is not allowed: ${reason}`, {
			longTermMemory: `Navigation to ${url} was blocked by the configured domain policy`,
			...init,
		});
		this.url = url;
		this.reason = reason;
	}
}

/**
 * The CDP transport is gone and the operation needs it.
 *
 * The bus circuit breaker (D-BUS1, ARCHITECTURE.md §4.6) skips non-lifecycle handlers while
 * disconnected; this is what surfaces to a caller that asked anyway, or after the ≤54 s reconnect
 * wait expired (OBSERVABILITY-TESTING-CICD.md §"CDP disconnect storms").
 */
export class CdpDisconnectedError extends BrowserError {
	override readonly name: string = 'CdpDisconnectedError';
	/** Present when the disconnect was scoped to one target rather than the whole browser. */
	readonly targetId: string | null;

	constructor(
		message = 'CDP connection is not available',
		targetId: string | null = null,
		init: BrowserErrorInit = {},
	) {
		super(message, init);
		this.targetId = targetId;
	}
}

/**
 * Cooperative interrupt raised at the three stop/pause checkpoints of the step loop
 * (AGENT-RUNTIME.md §11.1: before state fetch, after LLM output, before each action).
 *
 * Deliberately NOT a {@linkcode BrowserError}: the error funnel (§4) logs it and returns without
 * counting a failure, so it must not be caught by handlers bracketing browser faults.
 */
export class InterruptedError extends Error {
	override readonly name: string = 'InterruptedError';

	constructor(message = 'Agent run interrupted', options?: { cause?: unknown }) {
		super(message, options);
	}
}
