/**
 * Core error taxonomy for `@tykotech/browser`.
 *
 * A typed taxonomy rooted at `BrowserError {shortTermMemory, longTermMemory}`; never throw strings.
 * `UrlNotAllowedError` is the pre-navigation veto and aborts a navigation through `eventResult()`;
 * `InterruptedError` is the cooperative stop/pause interrupt.
 *
 * Model errors (`ModelError`, `ModelProviderError`, `ModelRateLimitError`,
 * `ModelOutputTruncatedError`) belong to the LLM layer and are deliberately NOT redeclared here —
 * one taxonomy, one owner.
 *
 * Inside action handlers, *expected* failures return an `ActionResult` with `error` set; throwing is
 * reserved for bugs and transport death.
 */

/** Memory hints an error can carry into the agent's prompt. */
export interface BrowserErrorMemory {
	/**
	 * Detail for the one-shot `<read_state>` block of the next state message — e.g. the list of
	 * options a dropdown actually had.
	 */
	shortTermMemory?: string | null;
	/** Durable line appended to the step's Result block in `<agent_history>`. */
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
 * options that do exist") instead of a stack trace. They are `string | null` rather than optional,
 * the same house rule `@tykotech/bus` follows for its envelope fields.
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
 * A navigation target failed the domain policy.
 *
 * Thrown by `SecurityWatchdog.onNavigateToUrlEvent` **and** by `BrowserSession`'s own navigation
 * path: a throwing bus handler does not abort its siblings, so enforcement
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
 * The bus circuit breaker skips non-lifecycle handlers while disconnected; this is what surfaces to
 * a caller that asked anyway, or after the ≤54 s reconnect wait expired.
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
 * Cooperative interrupt raised at the three stop/pause checkpoints of the step loop: before state
 * fetch, after LLM output, before each action.
 *
 * Deliberately NOT a {@linkcode BrowserError}: the error funnel logs it and returns without
 * counting a failure, so it must not be caught by handlers bracketing browser faults.
 */
export class InterruptedError extends Error {
	override readonly name: string = 'InterruptedError';

	constructor(message = 'Agent run interrupted', options?: { cause?: unknown }) {
		super(message, options);
	}
}
