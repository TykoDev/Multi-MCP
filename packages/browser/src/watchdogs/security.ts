/**
 * @module
 * `SecurityWatchdog` — the browser's domain-policy enforcement, ARCHITECTURE.md §6.2 and the three
 * enforcement points of SECURITY-AUTH.md §4.3.
 *
 * | # | Point | Trigger | Action |
 * |---|-------|---------|--------|
 * | E0 | pre-request document veto (ERRATUM(E-94)) | a `Document` request paused by `Fetch` in `SessionManager` | request failed before it is sent; `BrowserErrorEvent`; here: suppress E2/E3 for it, close a pop-up that never committed |
 * | E1 | pre-navigation veto | `NavigateToUrlEvent` | `BrowserErrorEvent` **and throw** |
 * | E2 | post-navigation (redirects, JS navigations) | `NavigationCompleteEvent` | error event + drive that target to `about:blank` |
 * | E3 | tab containment (`window.open`) | `TabCreatedEvent` | error event + close the tab |
 *
 * ERRATUM(E-94), amended by review R2-1: E0 also judges `Prefetch` requests, and `SessionManager` re-checks every page
 * target's main-frame commit under a filter — an off-list one is parked on `about:blank` and reported as **E2** with
 * `details.trigger: 'commit'` (the post-navigation containment E2 names, now for page-driven navigations too). This
 * watchdog records it and stands its own E2/E3 down for that tab, so one commit yields one record.
 *
 * ERRATUM(E-116): E0 reports now also cover refused subresources and hints (ERRATUM(E-114/E-115), marked by
 * `details.requestKind`). Those are ignored here entirely: they are not navigations, so they neither suppress E2/E3
 * nor close a pop-up.
 *
 * (E3 of SECURITY-AUTH §4.3's own numbering is registry filtering, which lives in the M2 action
 * registry, not here. The table above numbers this watchdog's three obligations; the mapping is
 * E1 → §4.3 E1, E2 → §4.3 E2 "disallowed landing URL", E3 → §4.3 E2 "disallowed new tab".)
 *
 * ## This watchdog is defence in depth, not the enforcement (B-12 / build-run erratum E-3)
 *
 * A throwing handler does **not** abort its siblings: all handlers of an event run, and the first
 * error rejects the handle. `SecurityWatchdog` throwing therefore cannot by itself stop
 * `BrowserSession.onNavigateToUrlEvent` from calling `Page.navigate`. E-3's ruling is that **both**
 * call `isUrlAllowed`, and enforcement lives in the shared matcher rather than in registration order.
 * What this watchdog adds is the *observable* signal (`BrowserErrorEvent`), post-navigation redirect
 * containment, and new-tab containment — three things the session's own check does not do.
 *
 * The unit tests here therefore drive **this class's handlers directly**, on a bus with no
 * `BrowserSession` attached at all. A test that dispatched `NavigateToUrlEvent` at a full session
 * would pass even if this file were deleted, which is precisely the failure mode E-3 warns about.
 *
 * ## Policy compilation
 *
 * `compileDomainPolicy` is the M3 warning site (an unsafe pattern is refused *and reported* there,
 * once), and `isUrlAllowed` over a compiled policy is allocation-free. The compiled policy is cached
 * and rebuilt only when the profile's three policy inputs change identity — which happens exactly
 * once per `BrowserStartEvent.launchOptions` application.
 */

import type { HandlerContext } from '@tykotech/bus';
import type { TargetId } from '@tykotech/cdp';
import { BrowserErrorEvent, NavigateToUrlEvent, NavigationCompleteEvent, TabCreatedEvent } from '../events.ts';
import { UrlNotAllowedError } from '../errors.ts';
import { type CompiledDomainPolicy, compileDomainPolicy, isUrlAllowed } from '../security/url_matcher.ts';
import { withTimeout } from '../browser/reconnect.ts';
import { BaseWatchdog } from './base.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/**
 * The one `errorType` this watchdog uses, for all three points.
 *
 * ERRATUM(M1-watchdogs-rest-1): SECURITY-AUTH.md §4.3 names `'NavigationBlocked'` for E1 and says
 * only "error event" for the two containment points. Minting two more `errorType` strings would put
 * vocabulary into a wire-visible field (`BrowserErrorEvent.errorType` reaches the agent through
 * `recentEvents`, DATA-MODEL.md §5.3) that no spec section defines. The speced name is reused and the
 * point is carried in `details.enforcementPoint` instead, so consumers matching on `errorType` see
 * every block and consumers that care about *which* block can still tell them apart.
 */
export const NAVIGATION_BLOCKED_ERROR = 'NavigationBlocked';

/**
 * Values of `BrowserErrorEvent.details.enforcementPoint`.
 *
 * ERRATUM(E-94): `E0` is the pre-request document veto, enforced by `SessionManager` (a paused `Fetch` request
 * failed before it is sent) and reported in this watchdog's vocabulary. It precedes E1 in the numbering
 * because it precedes everything else in time: no request, so nothing to contain.
 */
export const SECURITY_ENFORCEMENT_POINTS = ['E0', 'E1', 'E2', 'E3'] as const;
export type SecurityEnforcementPoint = (typeof SECURITY_ENFORCEMENT_POINTS)[number];

/**
 * Values of `BrowserErrorEvent.details.containment`. ERRATUM(E-94): `request-blocked` is E0's — the request was
 * refused before it was sent, so the frame kept the document it had.
 */
export type SecurityContainment = 'none' | 'about:blank' | 'tab-closed' | 'failed' | 'request-blocked';

/**
 * ERRATUM(E-94): how long an E0 block suppresses this watchdog's own E2/E3 for the same navigation or target, so
 * one refused document yields one record. Bounded by {@linkcode E0_MEMORY_LIMIT} entries as well.
 */
export const E0_MEMORY_MS = 5_000;

/** ERRATUM(E-94): the most E0 blocks remembered at once; the oldest is forgotten first. */
export const E0_MEMORY_LIMIT = 64;

/** Where a blocked tab is parked (SECURITY-AUTH.md §4.2 step 1 always allows it). */
export const CONTAINMENT_URL = 'about:blank';

/**
 * Cap on one containment CDP call.
 *
 * ERRATUM(M1-watchdogs-rest-2): §4.3 states the containment actions but no budget for them. One is
 * required: E2/E3 run inside *notification* handlers, and `await handle` rejects with the first
 * handler error (`@tykotech/bus` `EventHandle`), so a containment call that hung until the per-event
 * timeout would turn a completed navigation into a failed one inside
 * `BrowserSession.onNavigateToUrlEvent`. 5 s sits under every per-event budget those notifications
 * carry (bus default 30 s — E-1) and above any realistic `Page.navigate`/`Target.closeTarget`.
 */
export const SECURITY_CONTAINMENT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

/** One recorded enforcement, for tests and for `bua doctor`-style introspection. */
export interface SecurityBlockRecord {
	readonly enforcementPoint: SecurityEnforcementPoint;
	readonly url: string;
	readonly targetId: TargetId | null;
	readonly containment: SecurityContainment;
}

export class SecurityWatchdog extends BaseWatchdog {
	/** ERRATUM(E-94): `BrowserErrorEvent` joins the triggers — it is how E0 blocks reach this watchdog. */
	static override readonly LISTENS_TO = [
		NavigateToUrlEvent,
		NavigationCompleteEvent,
		TabCreatedEvent,
		BrowserErrorEvent,
	];
	static override readonly EMITS = [BrowserErrorEvent];

	#policy: CompiledDomainPolicy | null = null;
	#signature: readonly unknown[] | null = null;
	readonly #blocks: SecurityBlockRecord[] = [];
	/** Targets created before they had a URL, awaiting their first real one (E-16). */
	readonly #pending = new Set<TargetId>();
	#pendingOff: (() => void) | null = null;
	/** ERRATUM(E-94): recent E0 blocks, newest last, bounded by {@linkcode E0_MEMORY_LIMIT} and {@linkcode E0_MEMORY_MS}. */
	readonly #e0: { readonly targetId: TargetId | null; readonly url: string; readonly at: number }[] = [];

	// -- public surface ----------------------------------------------------------------------------

	/**
	 * The compiled domain policy. Compiled once and cached; rebuilt only when the profile's
	 * `allowedDomains` / `prohibitedDomains` / `blockIpAddresses` change identity.
	 */
	get policy(): CompiledDomainPolicy {
		const profile = this.profile;
		const signature: readonly unknown[] = [
			profile.allowedDomains,
			profile.prohibitedDomains,
			profile.blockIpAddresses,
		];
		if (this.#policy === null || !_sameSignature(this.#signature, signature)) {
			this.#policy = compileDomainPolicy({
				allowedDomains: profile.allowedDomains,
				prohibitedDomains: profile.prohibitedDomains,
				blockIpAddresses: profile.blockIpAddresses,
			}, { onWarn: (warning) => this.logger.warn('domain pattern refused', { ...warning }) });
			this.#signature = signature;
		}
		return this.#policy;
	}

	/** Every block this watchdog has enforced, oldest first. */
	get blocks(): readonly SecurityBlockRecord[] {
		return this.#blocks;
	}

	/** The shared matcher, over the cached policy. Pure; safe to call from anywhere. */
	allows(url: string): boolean {
		return isUrlAllowed(url, this.policy);
	}

	// -- E1: pre-navigation veto -------------------------------------------------------------------

	/**
	 * Blocks a navigation before it executes: `BrowserErrorEvent('NavigationBlocked')` **and throw**
	 * (SECURITY-AUTH.md §4.3 E1).
	 *
	 * The throw is what `eventResult({raiseIfAny: true})` surfaces to the action layer. It does NOT
	 * stop `BrowserSession` (E-3) — the session refuses the same URL through the same matcher.
	 *
	 * @throws {UrlNotAllowedError} whenever the domain policy refuses `event.url`.
	 */
	async onNavigateToUrlEvent(event: NavigateToUrlEvent, _context?: HandlerContext): Promise<void> {
		if (this.allows(event.url)) return;
		await this.#report('E1', event.url, null, 'none', { newTab: event.newTab });
		throw new UrlNotAllowedError(event.url, 'blocked by the SecurityWatchdog pre-navigation veto');
	}

	// -- E2: post-navigation containment (redirects, JS navigations) --------------------------------

	/**
	 * Catches what the pre-check cannot see: a redirect chain, a `location =` from page script, a
	 * meta-refresh. The landing URL is re-checked and a blocked tab is driven to `about:blank`.
	 *
	 * Never throws: this runs on a notification the session awaits, and a rejection here would report
	 * a *successful* navigation as failed (see {@linkcode SECURITY_CONTAINMENT_TIMEOUT_MS}).
	 */
	async onNavigationCompleteEvent(event: NavigationCompleteEvent, _context?: HandlerContext): Promise<void> {
		if (this.allows(event.url)) return;
		// ERRATUM(E-94): E0 already refused this document before its request was sent; a second record (and a
		// drive to about:blank of a tab that kept its previous document) would describe something that did not
		// happen. Review R2-1: likewise when the commit check already parked this tab for this navigation's commit.
		if (this.#e0Blocked(event.targetId, event.url) || this.#parkedByCommitCheck(event.targetId)) return;
		const contained = await this.#driveToBlank(event.targetId);
		await this.#report('E2', event.url, event.targetId, contained ? CONTAINMENT_URL : 'failed', {
			loadingStatus: event.loadingStatus,
		});
	}

	// -- E3: new-tab containment (window.open) ------------------------------------------------------

	/**
	 * A tab that opened straight onto a blocked URL is closed, not merely parked.
	 *
	 * ERRATUM(E-16). Chrome reports `url: ''` for a target that has been created but has not yet
	 * navigated, and **every** `window.open` / `target="_blank"` popup passes through that state
	 * before its first navigation. `isUrlAllowed('')` cannot parse it and answers `false`, so this
	 * containment closed every popup in every deployment — including deployments with no domain
	 * policy at all, where nothing was supposed to be enforced. Measured: clicking an ordinary
	 * `target="_blank"` link produced `Target.targetCreated` → `attachedToTarget` →
	 * `targetDestroyed` within a second, and the tab never appeared in `session.tabs`.
	 *
	 * Simply allowing the blank URL would open a hole rather than close one: E2
	 * (`NavigationCompleteEvent`) only fires for navigations *this session issued*, so a popup that
	 * navigates itself to a prohibited domain would never be re-checked. So the decision is
	 * **deferred**, not skipped: the target is remembered, and the policy is applied to the first
	 * real URL it reports. A tab that never navigates stays on `about:blank`, which §4.2 step 1
	 * always allows.
	 */
	async onTabCreatedEvent(event: TabCreatedEvent, _context?: HandlerContext): Promise<void> {
		if (event.url.trim() === '') {
			this.#deferUntilNavigated(event.targetId);
			return;
		}
		if (this.allows(event.url) || _isBrowserUi(event.url)) return;
		// ERRATUM(E-94): one block, one record — E0 already recorded (and, for a pop-up, closed) this target; review
		// R2-1: or the commit check already parked it on about:blank.
		if (this.#e0Blocked(event.targetId, null) || this.#parkedByCommitCheck(event.targetId)) return;
		const contained = await this.#closeTab(event.targetId);
		await this.#report('E3', event.url, event.targetId, contained ? 'tab-closed' : 'failed', {});
	}

	// -- E0: the pre-request veto's aftermath (ERRATUM(E-94)) ----------------------------------------

	/**
	 * Receives the E0 blocks `SessionManager` reports. Two duties, and nothing else:
	 *
	 * 1. **Remember** the block for {@linkcode E0_MEMORY_MS}, so this watchdog's E2/E3 do not mint a second
	 *    record for the same refused document.
	 * 2. **Close a pop-up that never committed a document.** A main-frame block on a page target whose URL is
	 *    still `''` (Chrome's "created, never navigated" state, E-16) leaves an empty tab nobody asked for —
	 *    the off-list pop-up E3 used to close after its request had reached the network. It is closed under the
	 *    same uncancellable cap as E3; a tab that had a document keeps it (the request was refused, not the tab).
	 *
	 * Never throws, and never dispatches: E0 is reported once, by `SessionManager`.
	 */
	async onBrowserErrorEvent(event: BrowserErrorEvent, _context?: HandlerContext): Promise<void> {
		if (event.errorType !== NAVIGATION_BLOCKED_ERROR) return;
		const url = typeof event.details.url === 'string' ? event.details.url : '';
		const targetId = typeof event.details.targetId === 'string' ? event.details.targetId as TargetId : null;
		// Review R2-1: the commit check's report — recorded here like any E2, contained already by `SessionManager`.
		if (event.details.enforcementPoint === 'E2' && event.details.trigger === 'commit') {
			const containment = event.details.containment === 'about:blank' ? CONTAINMENT_URL : 'failed';
			this.#blocks.push({ enforcementPoint: 'E2', url, targetId, containment });
			return;
		}
		if (event.details.enforcementPoint !== 'E0') return;
		// ERRATUM(E-116): a refused subresource or hint (ERRATUM(E-114/E-115), `requestKind`) is no one's navigation. It
		// must not enter the E0 memory — that would stand down E2/E3 for an off-list document the same tab really
		// commits — nor close a pop-up whose first document was never refused, nor become a record here.
		if (_isRequestBlock(event.details)) return;
		const frameId = typeof event.details.frameId === 'string' ? event.details.frameId : null;
		this.#rememberE0(targetId, url);
		this.#blocks.push({ enforcementPoint: 'E0', url, targetId, containment: 'request-blocked' });
		if (targetId === null || frameId !== targetId || !this.#neverCommitted(targetId)) return;
		this.#pending.delete(targetId);
		await this.#closeTab(targetId);
	}

	/** A page target Chrome still reports with an empty URL: created, never navigated (E-16). */
	#neverCommitted(targetId: TargetId): boolean {
		try {
			const record = this.sessions.targets.get(targetId);
			return record !== undefined && record.type === 'page' && record.url.trim() === '';
		} catch {
			// No session manager (torn down mid-event): nothing to close through.
			return false;
		}
	}

	/** Review R2-1: whether `SessionManager`'s commit check parked this tab moments ago (its E2 is the record). */
	#parkedByCommitCheck(targetId: TargetId): boolean {
		try {
			return this.sessions.parkedRecently(targetId);
		} catch {
			// No session manager (torn down mid-event): nothing was parked through it.
			return false;
		}
	}

	#rememberE0(targetId: TargetId | null, url: string): void {
		this.#pruneE0();
		this.#e0.push({ targetId, url, at: Date.now() });
		if (this.#e0.length > E0_MEMORY_LIMIT) this.#e0.splice(0, this.#e0.length - E0_MEMORY_LIMIT);
	}

	/** Whether a recent E0 block covers this target — and, when `url` is given, this exact URL. */
	#e0Blocked(targetId: TargetId, url: string | null): boolean {
		this.#pruneE0();
		return this.#e0.some((block) => block.targetId === targetId && (url === null || block.url === url));
	}

	#pruneE0(): void {
		const horizon = Date.now() - E0_MEMORY_MS;
		let stale = 0;
		while (stale < this.#e0.length && (this.#e0[stale]?.at ?? 0) < horizon) stale += 1;
		if (stale > 0) this.#e0.splice(0, stale);
	}

	/** Remembers a not-yet-navigated target and arms the re-check listener (E-16). */
	#deferUntilNavigated(targetId: TargetId): void {
		this.#pending.add(targetId);
		if (this.#pendingOff !== null) return;
		this.#pendingOff = this.cdp.on('Target.targetInfoChanged', (params) => {
			const info = params.targetInfo;
			if (!this.#pending.has(info.targetId)) return;
			const url = info.url.trim();
			// Still unnavigated: keep waiting rather than judging an empty string.
			if (url === '') return;
			this.#pending.delete(info.targetId);
			if (this.allows(url) || _isBrowserUi(url)) return;
			// ERRATUM(E-94): an E0 block on this target already produced its one record (review R2-1: or a commit park).
			if (this.#e0Blocked(info.targetId, null) || this.#parkedByCommitCheck(info.targetId)) return;
			void (async () => {
				const contained = await this.#closeTab(info.targetId);
				await this.#report('E3', url, info.targetId, contained ? 'tab-closed' : 'failed', { deferred: true });
			})();
		});
	}

	protected override beforeDetach(): void {
		this.#pendingOff?.();
		this.#pendingOff = null;
		this.#pending.clear();
	}

	// -- internals ---------------------------------------------------------------------------------

	async #report(
		enforcementPoint: SecurityEnforcementPoint,
		url: string,
		targetId: TargetId | null,
		containment: SecurityContainment,
		extra: Record<string, unknown>,
	): Promise<void> {
		this.#blocks.push({ enforcementPoint, url, targetId, containment });
		// ERRATUM(E-78). The donor wrote the whole blocked URL to `warn`. Once a deployment's allowlist reaches
		// this watchdog (D-095) that line fires for real, and the URL it names is exactly where a one-time code
		// or session token sits — an off-allowlist OAuth redirect is the case this containment exists for
		// (SECURITY-AUTH §8.3). The line also had no rate bound, and a page can spin blocked pop-ups. So it
		// names the origin only and drops to `debug`; the host reads `BrowserErrorEvent` — which still carries
		// the URL, in-process — and logs the block at its own level, redacted and throttled (the MCP registry).
		this.logger.debug('navigation blocked by the domain policy', {
			enforcementPoint,
			origin: _originOf(url),
			targetId,
			containment,
		});
		await this.bus
			.dispatch(
				new BrowserErrorEvent({
					errorType: NAVIGATION_BLOCKED_ERROR,
					message: `Navigation to ${url} is not allowed by the configured domain policy`,
					details: { enforcementPoint, url, targetId, containment, ...extra },
				}),
			)
			.catch((error: unknown) => {
				// A consumer of the error event failing must not mask the block itself.
				this.logger.debug('a BrowserErrorEvent consumer failed', { error });
			});
	}

	async #driveToBlank(targetId: TargetId): Promise<boolean> {
		return await this.#contain('Page.navigate', targetId, async () => {
			const session = await this.sessions.getOrCreateCdpSession(targetId, false);
			// DELIBERATELY UNCANCELLABLE — bare `this.cdp`, not `cdpFor(context)` (ERRATUM(E-52), §9.45).
			// This is the E2 containment write. Binding the handler's signal here would mean that a
			// `NavigationCompleteEvent` handler which overran its budget stops driving a blocked tab to
			// `about:blank` — i.e. the domain policy would fail *open* under exactly the load that makes
			// budgets blow. A security control firing late beats one that does not fire. Its own bound is
			// `SECURITY_CONTAINMENT_TIMEOUT_MS`, applied by `#contain`, and its failures are reported.
			await this.cdp.send.Page.navigate(
				{ url: CONTAINMENT_URL, transitionType: 'address_bar' },
				session.sessionId,
			);
		});
	}

	async #closeTab(targetId: TargetId): Promise<boolean> {
		return await this.#contain('Target.closeTarget', targetId, async () => {
			// DELIBERATELY UNCANCELLABLE — see `#driveToBlank`. This is the E3 containment close; the same
			// ruling applies, and leaving a tab open on a blocked URL is the failure mode it prevents.
			await this.cdp.send.Target.closeTarget({ targetId });
		});
	}

	/** Runs one containment action under the cap, reporting success as data. Never throws. */
	async #contain(label: string, targetId: TargetId, run: () => Promise<void>): Promise<boolean> {
		// Mapped to a non-rejecting promise first: `withTimeout` leaves the loser running, and a CDP
		// call that rejects after the cap expired would otherwise be an unhandled rejection.
		const settled = run().then(() => null, (error: unknown) => error ?? new Error(label));
		const outcome = await withTimeout(settled, SECURITY_CONTAINMENT_TIMEOUT_MS);
		if (outcome.timedOut) {
			this.logger.error('domain-policy containment exceeded its cap', {
				call: label,
				targetId,
				capMs: SECURITY_CONTAINMENT_TIMEOUT_MS,
			});
			return false;
		}
		if (outcome.value !== null && outcome.value !== undefined) {
			this.logger.error('domain-policy containment failed', { call: label, targetId, error: outcome.value });
			return false;
		}
		return true;
	}
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------

/**
 * ERRATUM(E-79): Chrome's own browser UI, which Chrome itself opens as `page` targets — measured on real Chrome
 * as `chrome://omnibox-popup.top-chrome/` (and a sub-page of it) appearing while the browser closes. With a
 * deployment allowlist (D-095) E3 judged them like web content, failed to close them (`Target.closeTarget`:
 * "No target with given id found") and logged a containment *error* on every session close. They are not
 * web content: a page cannot navigate a tab to a `chrome:` URL, and the tools refuse every scheme but
 * http/https. The exemption is that narrow — `chrome:` with a `*.top-chrome` host, Chrome's name for its
 * own UI surfaces — and E1/E2 are unchanged.
 */
function _isBrowserUi(url: string): boolean {
	const parsed = URL.parse(url);
	return parsed !== null && parsed.protocol === 'chrome:' && parsed.hostname.endsWith('.top-chrome');
}

/**
 * ERRATUM(E-116): whether an E0 report is a refused subresource or hint rather than a document — it names a
 * `requestKind` other than `document` (`SessionManager` sets it on those reports only).
 */
function _isRequestBlock(details: Record<string, unknown>): boolean {
	const kind = details.requestKind;
	return kind !== undefined && kind !== 'document';
}

/** ERRATUM(E-78): a URL's origin for a log line, never its path or query; `''` when it does not parse. */
function _originOf(url: string): string {
	const parsed = URL.parse(url);
	if (parsed === null) return '';
	return parsed.origin === 'null' ? parsed.protocol : parsed.origin;
}

function _sameSignature(previous: readonly unknown[] | null, next: readonly unknown[]): boolean {
	if (previous === null || previous.length !== next.length) return false;
	return previous.every((value, index) => value === next[index]);
}
