/**
 * @module
 * `BrowserSession` — lifecycle, the launch/attach convergence point, and the navigation entry point
 * (ARCHITECTURE.md §7.4, §7.5; DATA-MODEL.md §5.1.1–§5.1.3).
 *
 * Launch and attach converge on **one** `connect(cdpUrl)` path (D-BROWSER1): a local launch is just
 * "ask `BrowserLaunchEvent` for a cdpUrl first". Everything after the socket opens is identical, and
 * that sequence is fixed by §7.4:
 *
 * 1. SessionManager start
 * 2. root `Target.setAutoAttach({flatten: true})`
 * 3. chrome-newtab pages redirected to `about:blank`
 * 4. ≥1 page target ensured
 * 5. initial focus set
 * 6. proxy auth armed
 * 7. `TabCreatedEvent` replayed for pre-existing tabs
 * 8. `AgentFocusChangedEvent`
 *
 * ## Attach order (load-bearing)
 *
 * `BrowserSession` registers its own handlers through {@linkcode BrowserSession.attach}, which
 * `start()` calls if you have not. **Attach the watchdogs first.** Handlers of one event run
 * sequentially in registration order (E-2), and the session's `BrowserStopEvent` handler is what
 * closes the CDP socket — StorageStateWatchdog's cookie save and the LocalBrowserWatchdog's teardown
 * both want a live connection, so the session must run last.
 *
 * ERRATUM(M1-session-3): DATA-MODEL.md §5.1.2 lists `BrowserStopEvent`'s handlers as "BrowserSession,
 * LocalBrowser, StorageState, AboutBlank, Recording". Read as an order it is unimplementable — every
 * watchdog after the first would be handed a closed socket. It is read as a *set*, and the session
 * registers last so the socket outlives the handlers that need it.
 *
 * ## Security (B-12 / build-run erratum E-3)
 *
 * A throwing handler does **not** abort its siblings. `SecurityWatchdog` raising on a blocked URL
 * therefore cannot stop this class from navigating; {@linkcode BrowserSession.onNavigateToUrlEvent}
 * calls the shared `isUrlAllowed` matcher itself and throws {@linkcode UrlNotAllowedError} before
 * issuing `Page.navigate`. Enforcement lives in the matcher, never in handler registration order —
 * which is why the regression test for it attaches no SecurityWatchdog at all.
 */

import { type BaseEvent, consoleBusLogger, EventBus, registerHandlers, resilientWrapper } from '@tykotech/bus';
import type { BusLogger, ConnectionPolicy, HandlerContext } from '@tykotech/bus';
import { CdpClient, fetchWebSocketDebuggerUrl } from '@tykotech/cdp';
import type { CdpCloseInfo, TargetId } from '@tykotech/cdp';
import { delay } from '@std/async';
import { v7 } from '@std/uuid';
import {
	AgentFocusChangedEvent,
	BrowserConnectedEvent,
	BrowserKillEvent,
	BrowserLaunchEvent,
	BrowserStartEvent,
	BrowserStateRequestEvent,
	BrowserStopEvent,
	BrowserStoppedEvent,
	CloseTabEvent,
	NavigateToUrlEvent,
	NavigationCompleteEvent,
	NavigationStartedEvent,
	SwitchTabEvent,
	TabClosedEvent,
	TabCreatedEvent,
} from '../events.ts';
import { BrowserError, CdpDisconnectedError, UrlNotAllowedError } from '../errors.ts';
import { type CompiledDomainPolicy, compileDomainPolicy, isUrlAllowed } from '../security/url_matcher.ts';
import {
	type BrowserProfile,
	type BrowserProfileInit,
	type BrowserStartResult,
	type BrowserStateSummary,
	createBrowserProfile,
	type PageInfo,
	resolveIsLocal,
	resolveTargetIdByTabId,
	type TabInfo,
	toTabInfo,
} from '../types.ts';
import { navigateAndWait, type NavigationResult } from './navigation.ts';
import { cdpBoundTo } from './cdp_signal.ts';
import { CONNECT_TIMEOUT_MS, isLifecycleEventName, ReconnectController, withTimeout } from './reconnect.ts';
import { SessionManager } from './session_manager.ts';

/** Chrome's own new-tab pages, redirected to `about:blank` on connect (ARCHITECTURE.md §7.4 step 3). */
export const CHROME_NEW_TAB_URLS: readonly string[] = [
	'chrome://new-tab-page',
	'chrome://new-tab-page/',
	'chrome://newtab',
	'chrome://newtab/',
];

/** How long step 4 waits for a freshly created bootstrap tab to register. */
const BOOTSTRAP_TAB_WAIT_MS = 2_000;

/** Construction options (ARCHITECTURE.md §3 sketch: `{ profile?, cdpUrl? }`, plus test seams). */
export interface BrowserSessionOptions {
	/** A full profile or a partial one; omitted fields take their DATA-MODEL.md §5.2 defaults. */
	readonly profile?: BrowserProfile | BrowserProfileInit | undefined;
	/** Attach mode. Overrides `profile.cdpUrl`. */
	readonly cdpUrl?: string | null | undefined;
	/** Supply your own bus to share one across sessions; it is then expected to be wired already. */
	readonly bus?: EventBus | undefined;
	readonly logger?: BusLogger | undefined;
	readonly id?: string | undefined;
	/** Overrides the 15 s connect cap; tests pin the default. */
	readonly connectTimeoutMs?: number | undefined;
	/** Injected clock, so `FakeTime` can drive the timing paths. */
	readonly now?: (() => number) | undefined;
}

/** Options accepted by {@linkcode BrowserSession.stop}. */
export interface StopOptions {
	/** Skips graceful teardown and overrides `keepAlive`. */
	readonly force?: boolean | undefined;
	readonly reason?: string | undefined;
}

export class BrowserSession {
	/**
	 * Declared so `registerHandlers` asserts the declaration against the actual `on<EventName>` method
	 * set — the same discipline every watchdog carries (ARCHITECTURE.md §4.5).
	 */
	static readonly LISTENS_TO = [
		BrowserStartEvent,
		BrowserStopEvent,
		NavigateToUrlEvent,
		SwitchTabEvent,
		CloseTabEvent,
		TabCreatedEvent,
		TabClosedEvent,
		AgentFocusChangedEvent,
	];

	static readonly EMITS = [
		BrowserLaunchEvent,
		BrowserKillEvent,
		BrowserConnectedEvent,
		BrowserStoppedEvent,
		BrowserStateRequestEvent,
		NavigationStartedEvent,
		NavigationCompleteEvent,
		AgentFocusChangedEvent,
		TabCreatedEvent,
	];

	readonly id: string;
	readonly profile: BrowserProfile;
	readonly eventBus: EventBus;
	readonly logger: BusLogger;

	readonly #reconnect: ReconnectController;
	readonly #connectTimeoutMs: number;
	readonly #now: () => number;

	#policy: CompiledDomainPolicy;
	#client: CdpClient | null = null;
	#sessionManager: SessionManager | null = null;
	#cdpUrl: string | null = null;
	#ownsBrowser = false;
	#closeUnsubscribe: (() => void) | null = null;
	#detachHandlers: (() => void) | null = null;
	#startPromise: Promise<BrowserStartResult> | null = null;
	#cachedBrowserState: BrowserStateSummary | null = null;

	constructor(options: BrowserSessionOptions = {}) {
		this.id = options.id ?? v7.generate();
		this.profile = _asProfile(options.profile);
		if (options.cdpUrl !== undefined) this.profile.cdpUrl = options.cdpUrl;
		this.logger = options.logger ?? consoleBusLogger;
		this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
		this.#now = options.now ?? Date.now;
		this.#policy = this.#compilePolicy();

		// The breaker's policy delegates to `#reconnect`, which needs the bus, which needs the
		// breaker: the indirection breaks that cycle without any of the three being half-built.
		const connection: ConnectionPolicy = {
			isConnected: () => this.isConnected,
			isReconnecting: () => this.#reconnect.isReconnecting(),
			waitForReconnect: (signalOrMs) => this.#reconnect.waitForReconnect(signalOrMs),
			isLifecycleEvent: (event: BaseEvent<unknown>) => isLifecycleEventName(event.eventType),
		};
		this.eventBus = options.bus ?? new EventBus({
			name: `session.${this.id}`,
			logger: this.logger,
			wrapHandler: resilientWrapper({
				connection,
				repair: () => this.#repairFocusedSession(),
				logger: this.logger,
			}),
		});
		this.#reconnect = new ReconnectController({
			bus: this.eventBus,
			connect: (signal) => this.#reconnectOnce(signal),
			isConnected: () => this.isConnected,
			cdpUrl: () => this.#cdpUrl,
			logger: this.logger,
			now: this.#now,
		});
	}

	// -- WatchdogHost surface ----------------------------------------------------------------------

	get cdpClient(): CdpClient | null {
		return this.#client;
	}

	get sessionManager(): SessionManager | null {
		return this.#sessionManager;
	}

	get cdpUrl(): string | null {
		return this.#cdpUrl;
	}

	/** `true` when this process owns the browser subprocess (launch mode, D-BROWSER1). */
	get isLocal(): boolean {
		return this.#ownsBrowser || resolveIsLocal(this.profile);
	}

	get isConnected(): boolean {
		return this.#client !== null && this.#client.state === 'open';
	}

	/** The {@linkcode ConnectionPolicy} the bus circuit breaker consumes (ARCHITECTURE.md §4.6). */
	get connectionPolicy(): ConnectionPolicy {
		return this.#reconnect;
	}

	/** The agent's current tab, or `null` before connect. */
	get agentFocusTargetId(): TargetId | null {
		return this.#sessionManager?.agentFocusTargetId ?? null;
	}

	/** Open tabs as the LLM sees them, oldest first (DATA-MODEL.md §5.4). */
	get tabs(): TabInfo[] {
		const manager = this.#sessionManager;
		if (manager === null) return [];
		return manager.pageTargets().reverse().map((record) => toTabInfo(record));
	}

	/** The most recent `BrowserStateSummary`; cleared on every focus change. */
	get cachedBrowserState(): BrowserStateSummary | null {
		return this.#cachedBrowserState;
	}

	// -- registration ------------------------------------------------------------------------------

	/**
	 * Subscribes the session's own handlers. Idempotent.
	 *
	 * Call it **after** attaching the watchdogs: registration order is handler order (E-2), and this
	 * class's `BrowserStopEvent` handler closes the socket every other stop handler still needs.
	 */
	attach(): void {
		if (this.#detachHandlers !== null) return;
		this.#detachHandlers = registerHandlers(this.eventBus, this);
	}

	/** Unsubscribes the session's handlers. Does not stop the browser. */
	detach(): void {
		const off = this.#detachHandlers;
		this.#detachHandlers = null;
		off?.();
	}

	// -- public lifecycle --------------------------------------------------------------------------

	/**
	 * Starts the session: launch or attach, converging on `connect(cdpUrl)`.
	 *
	 * Idempotent in both senses — a second call on a live session returns the same `cdpUrl` without
	 * touching the browser, and concurrent calls share one in-flight start.
	 */
	start(): Promise<BrowserStartResult> {
		this.attach();
		if (this.isConnected && this.#cdpUrl !== null) return Promise.resolve({ cdpUrl: this.#cdpUrl });
		const inflight = this.#startPromise;
		if (inflight !== null) return inflight;
		const started = this.#dispatchStart().finally(() => {
			this.#startPromise = null;
		});
		this.#startPromise = started;
		return started;
	}

	/**
	 * Stops the session. `keepAlive` makes a non-forced stop a no-op (AGENT-RUNTIME.md §4 step 8:
	 * "kills the browser unless `keepAlive`"); `force: true` overrides it.
	 */
	async stop(options: StopOptions = {}): Promise<void> {
		const force = options.force ?? false;
		if (force || this.profile.keepAlive !== true) {
			// Drop detection goes off *before* the event fans out. LocalBrowserWatchdog kills the browser
			// from its own `BrowserStopEvent` handler, and a socket that dies because we asked for it
			// must not start a reconnect ladder behind the teardown.
			this.#reconnect.disable();
		}
		await this.eventBus.dispatch(new BrowserStopEvent({ force }));
	}

	/** Force-stops and kills the local browser subprocess. */
	async kill(): Promise<void> {
		await this.stop({ force: true, reason: 'killed' });
		await this.eventBus.dispatch(new BrowserKillEvent());
	}

	/**
	 * Force-stops and starts again on the same profile.
	 *
	 * ERRATUM(M1-session-1): COMPLETIONS-CRITERIA.md §3.2 requires `reset()` semantics but no spec
	 * section defines them. Implemented as force-stop → start: it is the only reading under which
	 * `reset` differs from `stop` (it ignores `keepAlive`, since a session you asked to reset is not a
	 * session you want kept warm) and still leaves a usable session behind.
	 */
	async reset(): Promise<BrowserStartResult> {
		await this.stop({ force: true, reason: 'reset' });
		this.#reconnect.enable();
		return await this.start();
	}

	/**
	 * The agent-visible browser state, produced by DOMWatchdog via `BrowserStateRequestEvent`.
	 *
	 * On failure or whole-event timeout the session synthesizes a **non-actionable** state carrying
	 * `stateError` and an empty `selectorMap`, so the LLM can never act on stale indices
	 * (ARCHITECTURE.md §6.7, DATA-MODEL.md §5.3).
	 */
	async getBrowserStateSummary(
		options: {
			includeDom?: boolean;
			includeScreenshot?: boolean;
			includeRecentEvents?: boolean;
			/** ERRATUM(E-41): see `BrowserStateRequestEvent.includeOffscreen`. */
			includeOffscreen?: boolean;
		} = {},
	): Promise<BrowserStateSummary> {
		const handle = this.eventBus.dispatch(new BrowserStateRequestEvent(options));
		try {
			const summary = await handle.eventResult({ raiseIfAny: true, raiseIfNone: true });
			// ERRATUM(E-36) — G-1, invariant I-1. The cache is the ONE index table `nodeAt` resolves
			// against, so only a request that actually built a DOM may write it. A DOM-less request
			// (`includeDom: false`, which `identify()` issues after every navigation) returns a summary
			// whose `selectorMap` is empty by construction; writing that over the cache silently emptied
			// the index table, and every `browser_click`/`browser_type` carrying an index then failed
			// with `unknown-index` until the caller re-read the state. Single writer, one condition.
			if (options.includeDom !== false) this.#cachedBrowserState = summary;
			return summary;
		} catch (error) {
			this.logger.warn('browser state request failed; returning a non-actionable state', { error });
			// ERRATUM(E-36) — G-1. This branch used to LEAVE THE PREVIOUS SUMMARY STANDING. A state read
			// that failed after a navigation therefore left `nodeAt` resolving indices from a page the
			// browser had already left: the caller received an element, acted on it, and the action
			// landed somewhere else entirely. A failed read means "I do not know what is on the page",
			// and the only honest index table for that is none at all.
			this.#cachedBrowserState = null;
			return this.#nonActionableState(error);
		}
	}

	// -- handlers (ARCHITECTURE.md §4.5 `on<EventName>` convention) ---------------------------------

	/**
	 * Launch-or-attach, then the §7.4 post-connect sequence.
	 *
	 * DELIBERATELY UNCANCELLABLE — the `HandlerContext` is declared and not used (ERRATUM(E-62)).
	 * `connect()` already owns a bounded cap **with teardown on timeout**, so it cannot straggle; and
	 * abandoning it partway would leave a live socket, a half-seeded SessionManager and possibly a
	 * spawned Chrome with nothing in-process aware of them. That is the orphan ERRATUM(CANCEL-4) was
	 * written to prevent, reached from the other end.
	 */
	async onBrowserStartEvent(event: BrowserStartEvent, _context?: HandlerContext): Promise<BrowserStartResult> {
		if (this.isConnected && this.#cdpUrl !== null) return { cdpUrl: this.#cdpUrl };
		if (event.launchOptions !== null) this.#applyLaunchOptions(event.launchOptions);

		const configured = event.cdpUrl ?? this.profile.cdpUrl;
		let cdpUrl: string;
		if (configured !== null && configured !== '') {
			cdpUrl = configured;
			this.#ownsBrowser = false;
		} else {
			// One handler awaiting an event it dispatched itself — the flow E-2 exists to keep working.
			const launched = await this.eventBus.dispatch(new BrowserLaunchEvent())
				.eventResult({ raiseIfAny: true, raiseIfNone: true });
			cdpUrl = launched.cdpUrl;
			this.#ownsBrowser = true;
		}

		this.#reconnect.enable();
		await this.connect(cdpUrl);
		await this.eventBus.dispatch(new BrowserConnectedEvent({ cdpUrl }));
		return { cdpUrl };
	}

	/**
	 * Tears the transport down. Registered last, so every other stop handler still had a socket.
	 *
	 * DELIBERATELY UNCANCELLABLE — the `HandlerContext` is declared and not used (ERRATUM(E-62)). This
	 * is the teardown itself: a stop that gives up halfway leaves the socket open and the reconnect
	 * policy disabled, which is strictly worse than a late one. Same ruling as the SecurityWatchdog
	 * containment writes — a control that must fire beats one that fires on time.
	 */
	async onBrowserStopEvent(event: BrowserStopEvent, _context?: HandlerContext): Promise<void> {
		if (!event.force && this.profile.keepAlive === true) {
			this.logger.warn('keepAlive is set: leaving the browser connected', { sessionId: this.id });
			return;
		}
		this.#reconnect.disable();
		if (this.#client === null && this.#sessionManager === null) return;
		await this.#teardownTransport();
		await this.eventBus.dispatch(new BrowserStoppedEvent({ reason: event.force ? 'forced' : 'requested' }));
	}

	/**
	 * The navigation entry point and the second of the two `isUrlAllowed` call sites (E-3 / B-12).
	 *
	 * @throws {UrlNotAllowedError} before any CDP call when the domain policy refuses the URL.
	 */
	async onNavigateToUrlEvent(event: NavigateToUrlEvent, context?: HandlerContext): Promise<void> {
		if (!isUrlAllowed(event.url, this.#policy)) {
			throw new UrlNotAllowedError(event.url, 'blocked by the session domain policy');
		}

		const manager = this.#requireSessionManager();
		const targetId = await this.#resolveNavigationTarget(event.newTab, context);
		const session = await manager.getOrCreateCdpSession(targetId, true, _cancel(context));
		const fromUrl = manager.targets.get(targetId)?.url ?? null;

		await this.eventBus.dispatch(new NavigationStartedEvent({ targetId, url: event.url }));

		let result: NavigationResult;
		try {
			result = await navigateAndWait(manager, targetId, session.sessionId, event.url, {
				waitUntil: event.waitUntil,
				timeoutMs: event.timeoutMs,
				fromUrl,
				now: this.#now,
				..._cancel(context),
			});
		} catch (error) {
			await this.eventBus.dispatch(
				new NavigationCompleteEvent({ targetId, url: event.url, errorMessage: _describe(error) }),
			);
			throw error;
		}

		const landed = manager.targets.get(targetId)?.url ?? '';
		const finalUrl = landed === '' ? event.url : landed;
		this.#cachedBrowserState = null;
		await this.eventBus.dispatch(
			new NavigationCompleteEvent({ targetId, url: finalUrl, loadingStatus: result.loadingStatus }),
		);
		await this.eventBus.dispatch(new AgentFocusChangedEvent({ targetId, url: finalUrl }));
	}

	/** Focus another tab. `targetId: null` selects the most recent page (DATA-MODEL.md §5.1.1). */
	async onSwitchTabEvent(event: SwitchTabEvent, context?: HandlerContext): Promise<TargetId> {
		const manager = this.#requireSessionManager();
		const targetId = event.targetId === null
			? manager.mostRecentPageTarget()?.targetId ?? null
			: this.#resolveTabId(event.targetId);
		if (targetId === null) {
			throw new BrowserError(`no tab matches ${event.targetId ?? '<most recent>'}`);
		}
		await manager.getOrCreateCdpSession(targetId, true, _cancel(context));
		await manager.setAgentFocus(targetId, { activate: true, announce: true, ..._cancel(context) });
		return targetId;
	}

	/** Close one tab; `TabClosedEvent` and focus recovery come from SessionManager's detach path. */
	async onCloseTabEvent(event: CloseTabEvent, context?: HandlerContext): Promise<void> {
		const manager = this.#requireSessionManager();
		const targetId = this.#resolveTabId(event.targetId);
		if (targetId === null) throw new BrowserError(`no tab matches ${event.targetId}`);
		await this.#cdpFor(manager, context).send.Target.closeTarget({ targetId });
	}

	/** Applies the profile viewport to a newly created tab (DATA-MODEL.md §5.1.3 "session (viewport)"). */
	async onTabCreatedEvent(event: TabCreatedEvent, context?: HandlerContext): Promise<void> {
		await this.#applyViewport(event.targetId, context);
	}

	/** Focus fixup: SessionManager owns recovery; the session drops state that named the dead tab. */
	onTabClosedEvent(event: TabClosedEvent, _context?: HandlerContext): void {
		if (this.#cachedBrowserState !== null) this.#cachedBrowserState = null;
		this.logger.debug('tab closed', { targetId: event.targetId });
	}

	/** Cache clear + viewport, per DATA-MODEL.md §5.1.3. */
	async onAgentFocusChangedEvent(event: AgentFocusChangedEvent, context?: HandlerContext): Promise<void> {
		this.#cachedBrowserState = null;
		await this.#applyViewport(event.targetId, context);
	}

	// -- connect (ARCHITECTURE.md §7.4) ------------------------------------------------------------

	/**
	 * The single convergence point for launch and attach.
	 *
	 * Capped at {@linkcode CONNECT_TIMEOUT_MS} **with teardown on timeout**, so a retry starts from a
	 * clean slate instead of racing a half-built SessionManager against a socket that may still open.
	 */
	async connect(cdpUrl: string): Promise<void> {
		const controller = new AbortController();
		let failure: unknown = null;
		const attempt = this.#connectOnce(cdpUrl, controller.signal).catch((error: unknown) => {
			failure = error;
		});
		const outcome = await withTimeout(attempt, this.#connectTimeoutMs);
		if (outcome.timedOut) {
			controller.abort(new BrowserError('connect timed out'));
			await this.#teardownTransport();
			throw new BrowserError(
				`connect(${cdpUrl}) exceeded the ${this.#connectTimeoutMs}ms cap (ARCHITECTURE.md §7.4)`,
			);
		}
		if (failure !== null) {
			await this.#teardownTransport();
			throw failure instanceof Error ? failure : new BrowserError(String(failure));
		}
	}

	async #connectOnce(cdpUrl: string, signal: AbortSignal): Promise<void> {
		const headers = this.profile.headers ?? undefined;
		const wsUrl = _isWebSocketUrl(cdpUrl) ? cdpUrl : await fetchWebSocketDebuggerUrl(cdpUrl, headers);
		const client = await CdpClient.connect(wsUrl, {
			...(headers === undefined ? {} : { headers }),
			connectTimeoutMs: this.#connectTimeoutMs,
			signal,
		});
		this.#client = client;
		this.#cdpUrl = cdpUrl;
		this.#closeUnsubscribe = client.onClose((info) => this.#onTransportClosed(info));

		// (1) SessionManager start — seeds the target map before autoAttach can fire.
		// ERRATUM(E-94): with an allowlist the manager also gets the document veto (E0), over the same matcher
		// and compiled policy as E1 — read at call time, so a policy recompiled by launch options applies.
		const documentFilter = this.#documentFilter();
		const manager = new SessionManager(client, {
			bus: this.eventBus,
			logger: this.logger,
			proxy: this.profile.proxy,
			now: this.#now,
			documentFilter,
			// ERRATUM(E-114): which requests that veto judges (D-138) — `documents` unless the host asked for `all`. Inert
			// without a filter, so the no-allowlist attach path is unchanged.
			requestScope: this.profile.requestScope,
		});
		this.#sessionManager = manager;
		await manager.start();

		// (2) root autoAttach in flat session mode.
		// ERRATUM(E-94): new targets are held for the debugger only under a document filter, so a pop-up's first
		// document request cannot leave before its session's `Fetch.enable` (M5). Without one the parameters are
		// the donor's, byte for byte.
		await client.send.Target.setAutoAttach({
			autoAttach: true,
			waitForDebuggerOnStart: documentFilter !== null,
			flatten: true,
		});

		// (3) chrome-newtab pages redirected to about:blank.
		await this.#redirectNewTabPages(manager);
		// (4) at least one page target.
		await this.#ensurePageTarget(manager);
		// (5) initial focus.
		const focus = manager.mostRecentPageTarget();
		if (focus !== null) await manager.setAgentFocus(focus.targetId, { activate: true, announce: false });
		// (6) proxy auth.
		manager.armProxyAuth();
		// (7) replay TabCreatedEvent for pre-existing tabs.
		for (const record of manager.seededPageTargets()) {
			await this.eventBus.dispatch(new TabCreatedEvent({ targetId: record.targetId, url: record.url }));
		}
		// (8) announce the focus.
		const focused = manager.agentFocusTargetId;
		if (focused !== null) {
			const url = manager.targets.get(focused)?.url ?? 'about:blank';
			await this.eventBus.dispatch(new AgentFocusChangedEvent({ targetId: focused, url }));
		}
	}

	async #redirectNewTabPages(manager: SessionManager): Promise<void> {
		for (const record of manager.pageTargets()) {
			if (!CHROME_NEW_TAB_URLS.includes(record.url)) continue;
			try {
				const session = await manager.getOrCreateCdpSession(record.targetId, false);
				// Bare `manager.client` on purpose (ERRATUM(E-62) allowlist): step 6 of the §7.4 connect
				// sequence, reached from `connect()`, which owns its own cap and tears down on timeout.
				// There is no handler context here, and a half-run bootstrap is what that cap exists to
				// avoid.
				await manager.client.send.Page.navigate({ url: 'about:blank' }, session.sessionId);
			} catch (error) {
				this.logger.warn('could not redirect a chrome new-tab page to about:blank', {
					targetId: record.targetId,
					error,
				});
			}
		}
	}

	async #ensurePageTarget(manager: SessionManager): Promise<void> {
		if (manager.mostRecentPageTarget() !== null) return;
		// Bare `manager.client` on purpose (ERRATUM(E-62) allowlist): the same connect-sequence path as
		// `#redirectNewTabPages`. A browser with zero page targets is not a usable session, so this one
		// is not optional either.
		const created = await manager.client.send.Target.createTarget({ url: 'about:blank' });
		const deadline = this.#now() + BOOTSTRAP_TAB_WAIT_MS;
		while (!manager.targets.has(created.targetId) && this.#now() < deadline) {
			await manager.whenIdle();
			if (manager.targets.has(created.targetId)) break;
			await delay(20);
		}
		if (!manager.targets.has(created.targetId)) {
			throw new BrowserError(`bootstrap tab ${created.targetId} never registered within ${BOOTSTRAP_TAB_WAIT_MS}ms`);
		}
	}

	// -- reconnect (ARCHITECTURE.md §7.4) ----------------------------------------------------------

	#onTransportClosed(info: CdpCloseInfo): void {
		this.logger.warn('CDP connection closed', {
			sessionId: this.id,
			code: info.code,
			reason: info.reason,
			intentional: info.intentional,
		});
		const run = this.#reconnect.notifyClosed(info);
		if (run === null) return;
		run.then((ok) => {
			if (!ok) this.logger.error('auto-reconnect gave up', { sessionId: this.id });
		}, (error: unknown) => this.logger.error('auto-reconnect crashed', { error }));
	}

	/** Rebuilds client + SessionManager and restores the previous focus target if it is still alive. */
	async #reconnectOnce(signal: AbortSignal): Promise<void> {
		const cdpUrl = this.#cdpUrl;
		if (cdpUrl === null) throw new BrowserError('cannot reconnect: this session has never connected');
		const previousFocus = this.#sessionManager?.agentFocusTargetId ?? null;
		await this.#teardownTransport();
		await this.#connectOnce(cdpUrl, signal);
		const manager = this.#sessionManager;
		if (previousFocus !== null && manager !== null && manager.targets.has(previousFocus)) {
			await manager.setAgentFocus(previousFocus, { activate: true, announce: true });
		}
	}

	async #teardownTransport(): Promise<void> {
		this.#closeUnsubscribe?.();
		this.#closeUnsubscribe = null;
		const manager = this.#sessionManager;
		this.#sessionManager = null;
		if (manager !== null) await manager.stop();
		const client = this.#client;
		this.#client = null;
		if (client !== null) await client.close();
		this.#cachedBrowserState = null;
	}

	/** The §4.7 repair hook: one focused-session re-acquisition, never masking the original error. */
	async #repairFocusedSession(): Promise<void> {
		const manager = this.#sessionManager;
		if (manager === null || !this.isConnected) return;
		try {
			await manager.getOrCreateCdpSession(null, true);
		} catch (error) {
			this.logger.debug('focused-session repair failed', { error });
		}
	}

	// -- helpers -----------------------------------------------------------------------------------

	async #dispatchStart(): Promise<BrowserStartResult> {
		const handle = this.eventBus.dispatch(new BrowserStartEvent({ cdpUrl: this.profile.cdpUrl }));
		return await handle.eventResult({ raiseIfAny: true, raiseIfNone: true });
	}

	/**
	 * New-tab reuse rule (ARCHITECTURE.md §7.5 preamble): a `newTab` navigation that finds the agent
	 * already parked on a blank/new-tab page reuses it instead of littering the browser with tabs.
	 */
	async #resolveNavigationTarget(newTab: boolean, context?: HandlerContext): Promise<TargetId> {
		const manager = this.#requireSessionManager();
		const current = manager.agentFocusTargetId ?? manager.mostRecentPageTarget()?.targetId ?? null;
		if (!newTab) {
			if (current !== null) return current;
		} else if (current !== null) {
			const record = manager.targets.get(current);
			if (record !== undefined && _isBlankTab(record.url)) return current;
		}
		const created = await this.#cdpFor(manager, context).send.Target.createTarget({ url: 'about:blank' });
		await manager.getOrCreateCdpSession(created.targetId, true, _cancel(context));
		return created.targetId;
	}

	#resolveTabId(candidate: string): TargetId | null {
		const manager = this.#requireSessionManager();
		const ids = [...manager.targets.keys()];
		if (manager.targets.has(candidate)) return candidate;
		return resolveTargetIdByTabId(candidate, ids);
	}

	async #applyViewport(targetId: TargetId, context?: HandlerContext): Promise<void> {
		const viewport = this.profile.viewport;
		const manager = this.#sessionManager;
		if (viewport === null || manager === null || !this.isConnected) return;
		try {
			const session = await manager.getOrCreateCdpSession(targetId, false, _cancel(context));
			await this.#cdpFor(manager, context).send.Emulation.setDeviceMetricsOverride({
				width: viewport.width,
				height: viewport.height,
				deviceScaleFactor: this.profile.deviceScaleFactor ?? 1,
				mobile: false,
			}, session.sessionId);
		} catch (error) {
			// Cosmetic: a tab without the override is still fully usable.
			this.logger.debug('viewport override failed', { targetId, error });
		}
	}

	#applyLaunchOptions(init: BrowserProfileInit): void {
		const target = this.profile as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries(init)) {
			if (value === undefined) continue;
			target[key] = value;
		}
		this.#policy = this.#compilePolicy();
	}

	/**
	 * ERRATUM(E-94): the document veto handed to the `SessionManager`, or `null` when the profile names no
	 * allowlist. Only an allowlist arms it: `prohibitedDomains` alone keeps the donor's after-the-fact path, and
	 * an empty list is unrestricted (the §4.2 precedence rule).
	 */
	#documentFilter(): ((url: string) => boolean) | null {
		const allowed = this.profile.allowedDomains;
		if (allowed === null || allowed === undefined || allowed.length === 0) return null;
		return (url) => isUrlAllowed(url, this.#policy);
	}

	#compilePolicy(): CompiledDomainPolicy {
		return compileDomainPolicy({
			allowedDomains: this.profile.allowedDomains,
			prohibitedDomains: this.profile.prohibitedDomains,
			blockIpAddresses: this.profile.blockIpAddresses,
		}, { onWarn: (warning) => this.logger.warn('domain pattern refused', { ...warning }) });
	}

	/**
	 * The CDP client with a handler's cancellation bound — ERRATUM(E-62), the `BrowserSession` twin of
	 * `BaseWatchdog.cdpFor`. `context === undefined` yields the bare client, for the same reason
	 * `handlerBudget(undefined)` is infinite: `connect()` and the tests run under no dispatch.
	 *
	 * Takes the manager rather than re-resolving it, so a caller that already holds one cannot end up
	 * binding a signal to a different client than the one it is otherwise using.
	 */
	#cdpFor(manager: SessionManager, context: HandlerContext | undefined): CdpClient {
		return cdpBoundTo(manager.client, context?.signal);
	}

	#requireSessionManager(): SessionManager {
		const manager = this.#sessionManager;
		if (manager === null) throw new CdpDisconnectedError('browser session is not connected');
		return manager;
	}

	#nonActionableState(error: unknown): BrowserStateSummary {
		const message = _describe(error);
		const focus = this.agentFocusTargetId;
		const url = focus === null ? '' : this.#sessionManager?.targets.get(focus)?.url ?? '';
		return {
			url,
			title: '',
			tabs: this.tabs,
			screenshot: null,
			domState: { root: null, selectorMap: new Map() },
			pageInfo: _zeroPageInfo(),
			isPdfViewer: false,
			pendingNetworkRequests: [],
			browserErrors: [message],
			recentEvents: null,
			closedPopupMessages: [],
			paginationButtonsDetected: false,
			stateError: message,
			// ERRATUM(E-36): no table, so nothing to address — `nodeAt` answers `no-state`.
			stateToken: null,
			frames: [],
			captureTruncated: false,
		};
	}
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------

/**
 * A handler context rendered as a spreadable {@linkcode CancelOptions} fragment — ERRATUM(E-62).
 *
 * An **absent** key, not `{ signal: undefined }`: the two are distinguishable to the strict optional
 * rules this workspace compiles under, and "no cancellation" has to be the absent one so a caller
 * outside a dispatch keeps the unbudgeted behaviour.
 */
function _cancel(context: HandlerContext | undefined): { signal?: AbortSignal } {
	return context === undefined ? {} : { signal: context.signal };
}

function _asProfile(profile: BrowserProfile | BrowserProfileInit | undefined): BrowserProfile {
	return createBrowserProfile(profile ?? {});
}

function _isWebSocketUrl(url: string): boolean {
	return url.startsWith('ws://') || url.startsWith('wss://');
}

/** A tab the new-tab reuse rule is allowed to take over. */
function _isBlankTab(url: string): boolean {
	return url === '' || url === 'about:blank' || CHROME_NEW_TAB_URLS.includes(url);
}

function _describe(value: unknown): string {
	return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

function _zeroPageInfo(): PageInfo {
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
