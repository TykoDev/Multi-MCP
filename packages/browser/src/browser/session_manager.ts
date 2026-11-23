/**
 * @module
 * `SessionManager` — the single source of truth for CDP targets and sessions.
 *
 * It owns the state maps, push-based discovery and the attach/detach/focus rules. One global handler
 * per CDP event, routed by `sessionId`, is kept even though `@tykotech/cdp`'s registry is
 * multi-listener — that design is what keeps per-target state coherent. It also owns the lifecycle
 * ring buffer the navigation readiness poller reads, the `TabCreatedEvent` / `TabClosedEvent` /
 * `AgentFocusChangedEvent` announcements, and the 4-char `tabId`.
 *
 * Everything about a target that anyone else needs — is it attached, what is its url, what lifecycle
 * events has it seen, is it the agent's current tab — lives here and nowhere else.
 * {@linkcode SessionManager.getOrCreateCdpSession} is the ONLY sanctioned way to obtain a session id;
 * reaching into `sessions` and calling CDP with a raw id bypasses focus validation and the attach
 * race, which is exactly the class of bug this class exists to prevent.
 *
 * CDP's `Page.lifecycleEvent.timestamp` is a monotonic value from an arbitrary epoch and is therefore
 * not comparable with the wall clock a navigation start is measured on. The readiness staleness rule
 * ("loaderId-less events count only if received after nav start") needs a wall-clock time, so every
 * buffered record also carries `receivedAt` (`Date.now()` at reception), and the rule is evaluated
 * against that field.
 *
 * The attach cascade (`Page.enable`, `Page.setLifecycleEventsEnabled`, `Network.enable`, …) is
 * started from a synchronous CDP listener and runs in the background, so `Target.attachedToTarget`
 * lands *before* `Network.enable` has been issued. A navigation issued on a session id handed out at
 * that moment would race the enable and could commit its first document with `Network.*` switched
 * off: no `requestWillBeSent` for the main resource, so `HarRecordingWatchdog` would lose the first
 * document (an empty, green HAR for a one-page run) and `DOMWatchdog`'s pending-network probe could
 * not see the requests it is supposed to wait for. The accessor therefore awaits the session's own
 * configuration before returning, and the cascade runs *before* a debugger-paused renderer is
 * resumed, so "you have a session id" means "this session is instrumented".
 *
 * **The pre-request document veto (enforcement point E0).** With a document filter
 * (a deployment allowlist, handed down by `BrowserSession`), every page and iframe session arms
 * `Fetch` for `Document` requests and one fail-closed `Fetch.requestPaused` handler refuses an
 * off-list document **before** its request is sent — a clicked link, `location =`, a meta refresh, a
 * form POST, each redirect hop, a pop-up's first document and an iframe's. The SecurityWatchdog's
 * E2/E3 only contain those after the fact, once the off-list host has already been reached. Without
 * a filter none of this is armed: new targets are not held, and no `Fetch.enable` is sent for it.
 *
 * **A page-driven main-frame commit is checked after the fact.** Measured on Chrome 154: a
 * speculation-rules `prefetch` — and a cross-site `prerender`, which Chrome runs as a prefetch first —
 * is issued by the browser's prefetch service, outside every `Fetch` interception point, so it reaches
 * an off-list host; the navigation that follows (a click, a `location =`) is then served from the
 * prefetch cache, sends no request, pauses nothing, and commits the off-list document with no record
 * at all. Pausing `Prefetch` like `Document` is impossible on that build (see {@linkcode JUDGED_RESOURCE_TYPES}); the
 * request-side control is the launcher's preloading preference. Behind it, every page target's
 * main-frame commit of an http(s) document is re-checked here: an off-list one is parked on `about:blank` and
 * reported as an E2 block with `trigger: 'commit'`, so E2's after-the-fact containment covers navigations the page
 * made as well as those this process issued. Each E0 report also carries `chainStart`, the URL the request's redirect
 * chain began at, and `resourceType`, so the host can tell a tool's own navigation from one the page made.
 *
 * **The request scope.** Under a filter, `BrowserProfile.requestScope` (handed down by
 * `BrowserSession`) says which requests the one answerer judges. `documents` — the default — is the document veto
 * above plus the hints below. `all` arms `Fetch` `*` on every attached target that can take it — page, iframe, the prerender
 * host (`other`), service and shared workers, `browser_ui`, `background_page` and any type a later Chrome adds (fail
 * closed: armed unless it is a dedicated `worker`, whose requests pause on the owning page's session, measured) — and
 * refuses every off-list http(s)/ws(s) subresource with `BlockedByClient` before it is sent. A non-page target is
 * armed **before** its debugger resume, under a bounded wait, and resumed whatever the arming did. A refused
 * subresource is reported once per origin per target per document (at most {@linkcode REQUEST_BLOCK_ORIGIN_LIMIT}, then
 * one overflow report) as an E0 `BrowserErrorEvent` carrying `requestKind`, and only for page and iframe targets: a
 * refusal on any other target type is a `debug` line and a count ({@linkcode SessionManager.requestRefusals}), because
 * those targets never commit a document that would reset the aggregation. WebSocket handshakes never
 * reach `Fetch` (measured); the resolver layer the host composes into the launch arguments covers them.
 *
 * **Hints are refused in both scopes.** A request whose `Sec-Purpose` (or legacy `Purpose`)
 * starts with `prefetch` — `<link rel=prefetch>` (a `Fetch`), the NoState prefetch `<link rel=prerender>` runs on an
 * `other` target (a `Document`) — is judged like a document even in `documents` scope. That scope's page/iframe pattern
 * therefore adds `Fetch` to `Document` (which also pauses fetch/XHR/EventSource, continued unjudged: measured +~0.5 ms
 * per request), and an `other` target is armed for `Document`. `<link rel=preload|modulepreload>` carry no
 * `Sec-Purpose` on Chrome 154 and arrive as `Script`/`Other`: subresources, continued in `documents`.
 *
 * **`all` also locks WebRTC away.** ICE traffic never reaches `Fetch`,
 * so under `all` every attached target that can hold a window — every type but the worker types of
 * {@linkcode WINDOWLESS_TARGET_TYPES}, unknown types included (fail closed) — gets {@linkcode WEBRTC_LOCKDOWN_SOURCE}
 * through `Page.addScriptToEvaluateOnNewDocument` (`runImmediately`), sent before the target's debugger resume like the
 * other renderer-bound setup calls. The preference and resolver layers that stand behind it, and why, are in
 * `webrtc_lockdown.ts`. `documents` is unchanged.
 */

import type { EventBus } from '@tykotech/bus';
import type { BusLogger } from '@tykotech/bus';
import type { CdpClient, CdpEventParams, CdpParams, SessionId, TargetId } from '@tykotech/cdp';
import { delay } from '@std/async';
import { AgentFocusChangedEvent, BrowserErrorEvent, TabClosedEvent, TabCreatedEvent } from '../events.ts';
import { BrowserError, CdpDisconnectedError } from '../errors.ts';
import type { ProxySettings, RequestScope } from '../types.ts';
import { NAVIGATION_BLOCKED_ERROR } from '../watchdogs/security.ts';
import { cdpBoundTo } from './cdp_signal.ts';
import { WEBRTC_LOCKDOWN_SOURCE } from './webrtc_lockdown.ts';

/** `Target.TargetInfo`, taken from the typed event surface so no deep import is needed. */
export type CdpTargetInfo = CdpEventParams['Target.targetCreated']['targetInfo'];

/** Payload of the one global `Page.lifecycleEvent` router. */
export type CdpLifecycleParams = CdpEventParams['Page.lifecycleEvent'];

// ---------------------------------------------------------------------------
// timing + capacity constants (load-bearing: the tests pin each value)
// ---------------------------------------------------------------------------

/** Per-target lifecycle ring buffer capacity. */
export const LIFECYCLE_RING_CAPACITY = 50;

/** How long `getOrCreateCdpSession` waits for Chrome's attach event. */
export const ATTACH_WAIT_TIMEOUT_MS = 2_000;

/** Cadence of that wait. Internal: only the 2 s cap is part of the contract, not the polling interval. */
export const ATTACH_POLL_INTERVAL_MS = 20;

/** Discovery filter: pages and iframes only. */
export const DISCOVERY_FILTER: readonly { type: string }[] = [{ type: 'page' }, { type: 'iframe' }];

/** The only target type allowed to hold the agent's focus. */
export const PAGE_TARGET_TYPE = 'page';

/**
 * `Fetch.failRequest` reason for a document request the filter refuses.
 *
 * Measured on Chrome 154: `Aborted` cancels the navigation and the frame keeps the document it had (the
 * tool reports `net::ERR_ABORTED`); `BlockedByClient` commits Chrome's error page
 * (`chrome-error://chromewebdata/`) in place of it, which would leave a tab on a document nobody chose.
 */
export const DOCUMENT_BLOCK_ERROR_REASON = 'Aborted';

/**
 * The `Fetch` pattern that pauses document requests only. Every other resource type
 * passes untouched, so a filter costs one round trip per document, never one per subresource.
 */
export const DOCUMENT_REQUEST_PATTERN = { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' } as const;

/**
 * The resource types the document filter judges when a paused request reaches
 * the handler. `Prefetch` — the response a later navigation would be served from without a request of its own — is
 * judged like a document, fail closed. It is **not** in the `Fetch.enable` pattern, because it cannot be: measured on
 * Chrome 154, `Fetch.enable` refuses the whole call with `-32602 Unknown resource
 * type in fetch filter: 'Prefetch'`, which would leave the target with no veto at all; and with an unfiltered pattern
 * (page session or browser root alike) a speculation-rules
 * prefetch is never paused. A `Prefetch` therefore only arrives here under the proxy-credential `*` pattern, if a later
 * Chrome routes one through `Fetch`. What stops speculation on Chrome 154 is the launcher's preloading preference
 * (`LocalBrowserWatchdog`), and what contains a speculative document that commits anyway is the
 * commit check below.
 */
export const JUDGED_RESOURCE_TYPES: readonly string[] = ['Document', 'Prefetch'];

/**
 * How many paused requests' chain starts are remembered (one per redirect hop still in
 * flight); the oldest is forgotten first. A chain longer than this only loses its start, which then reads as the hop.
 */
export const CHAIN_MEMORY_LIMIT = 64;

/**
 * Cap on the commit check's park on `about:blank` — the same bound, and the same reason, as the SecurityWatchdog's
 * `SECURITY_CONTAINMENT_TIMEOUT_MS`; restated because the watchdog imports this module.
 */
export const COMMIT_CONTAINMENT_TIMEOUT_MS = 5_000;

/**
 * How long a commit-check park suppresses the SecurityWatchdog's own E2 for the same tab
 * (one block, one record) — the watchdog's `E0_MEMORY_MS`, restated for the same import-direction reason.
 */
export const COMMIT_PARK_MEMORY_MS = 5_000;

/** The most commit-check parks remembered at once. */
export const E0_COMMIT_PARK_LIMIT = 64;

/**
 * `Fetch.failRequest` reason for a refused subresource or hint. A failed subresource
 * reaches the page as an ordinary network error, and `Network.loadingFailed` names it `net::ERR_BLOCKED_BY_CLIENT`, so
 * the request log shows what was refused. A hint that arrives as a `Document` (the prerender host's NoState prefetch)
 * is failed with {@linkcode DOCUMENT_BLOCK_ERROR_REASON} instead, as every document is.
 */
export const SUBRESOURCE_BLOCK_ERROR_REASON = 'BlockedByClient';

/**
 * The second `documents`-scope pattern on page and iframe sessions. Measured on Chrome 154:
 * `<link rel=prefetch>` arrives as `Fetch` with `Sec-Purpose: prefetch`, and this pattern also pauses every
 * fetch/XHR/EventSource — which the answerer continues unjudged in that scope.
 */
export const FETCH_REQUEST_PATTERN = { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' } as const;

/** The `all`-scope pattern — every request of the target, at the request stage. */
export const ALL_REQUESTS_PATTERN = { urlPattern: '*', requestStage: 'Request' } as const;

/** The target type Chrome 154 runs a `<link rel=prerender>` NoState prefetch in (measured). */
export const PRERENDER_HOST_TARGET_TYPE = 'other';

/**
 * The one target type never armed — `Fetch.enable` answers `-32601` on a dedicated worker, whose
 * requests pause on the owning page's session instead (measured).
 */
export const UNARMED_TARGET_TYPE = 'worker';

/**
 * Target types whose `Fetch.enable` is known to answer `-32601` (method not found), logged at `debug`
 * rather than `warn`. Measured: every type Chrome 154 attaches but `worker` accepts it, so the set is empty; a
 * later Chrome that refuses one is warned about until it is measured and added here.
 */
export const FETCH_UNSUPPORTED: ReadonlySet<string> = new Set<string>();

/**
 * The target types that never hold a window, so never take the WebRTC lockdown.
 * `RTCPeerConnection` is exposed to windows only; a type not named here — a later Chrome's, `other`, `browser_ui` —
 * is sent the script anyway (fail closed), and a refusal there is a `debug` line.
 */
export const WINDOWLESS_TARGET_TYPES: ReadonlySet<string> = new Set<string>([
	'worker',
	'service_worker',
	'shared_worker',
	'shared_storage_worklet',
	'auction_worklet',
]);

/**
 * How long the attach path waits for one target's `Fetch.enable` before resuming it
 * anyway. `Fetch` is browser-side and answers at once (measured); the bound exists so that a target type which never
 * answers can never be left paused for the debugger. An expired wait is reported at `warn`, like a failure.
 */
export const FETCH_ARM_TIMEOUT_MS = 2_000;

/** The URL schemes the request scope judges; `ws:`/`wss:` are judged as `http:`/`https:`. */
export const JUDGED_REQUEST_SCHEMES: readonly string[] = ['http:', 'https:', 'ws:', 'wss:'];

/**
 * Distinct refused origins reported per target per document; the next one is reported once more with
 * `overflow: true`, and nothing further until that target commits its next document.
 */
export const REQUEST_BLOCK_ORIGIN_LIMIT = 32;

/** Targets whose refused origins are remembered at once; the oldest is forgotten first. */
export const REQUEST_BLOCK_TARGET_LIMIT = 64;

/** What one paused request is, for the answerer — see {@linkcode requestKindOf}. */
export type RequestKind = 'document' | 'hint' | 'subresource';

/**
 * Classifies one paused request. A `hint` names itself in `Sec-Purpose` (or the legacy
 * `Purpose`) with a value starting `prefetch`, case-insensitive; otherwise a {@linkcode JUDGED_RESOURCE_TYPES} type is
 * a `document`; everything else is a `subresource`. Never throws: a malformed header map reads as no header.
 */
export function requestKindOf(params: {
	readonly resourceType: string;
	readonly request: { readonly headers?: Readonly<Record<string, unknown>> | undefined };
}): RequestKind {
	const headers = params.request.headers;
	if (headers !== null && typeof headers === 'object') {
		for (const [name, value] of Object.entries(headers)) {
			const key = name.toLowerCase();
			if ((key === 'sec-purpose' || key === 'purpose') && typeof value === 'string') {
				if (value.trim().toLowerCase().startsWith('prefetch')) return 'hint';
			}
		}
	}
	return JUDGED_RESOURCE_TYPES.includes(params.resourceType) ? 'document' : 'subresource';
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** One attached CDP session in flat-session mode. */
export interface CdpSessionRecord {
	readonly sessionId: SessionId;
	readonly targetId: TargetId;
	/** Target type at attach time: `page`, `iframe`, `worker`, … */
	readonly type: string;
	/** Monotonically increasing attach order; ties in `Date.now()` are common on Windows. */
	readonly sequence: number;
}

/** One known target. Mutable in `url`/`title` because `targetInfoChanged` is the update path. */
export interface TargetRecord {
	readonly targetId: TargetId;
	type: string;
	url: string;
	title: string;
	/** Discovery order; `mostRecentPageTarget()` picks the highest. */
	readonly sequence: number;
}

/** One buffered `Page.lifecycleEvent`, keyed back to its target by the global router. */
export interface LifecycleRecord {
	readonly name: string;
	/** `null` only if Chrome omitted it; the readiness staleness rule treats the two cases differently. */
	readonly loaderId: string | null;
	readonly frameId: string;
	/** CDP monotonic timestamp (seconds since an arbitrary epoch). Not wall-clock comparable. */
	readonly timestamp: number;
	/** `Date.now()` at reception — the field the "after nav start" staleness rule is evaluated against. */
	readonly receivedAt: number;
}

/** Construction options. */
export interface SessionManagerOptions {
	readonly bus: EventBus;
	readonly logger?: BusLogger | undefined;
	/** Credentials are answered over CDP `Fetch` auth when `username` is set. */
	readonly proxy?: ProxySettings | null | undefined;
	/** Override for {@linkcode ATTACH_WAIT_TIMEOUT_MS}; tests pin the default. */
	readonly attachWaitMs?: number | undefined;
	/** Injected clock, so the ring buffer's `receivedAt` is drivable by `FakeTime`. */
	readonly now?: (() => number) | undefined;
	/**
	 * The document veto. `null`/absent means no policy and no `Fetch` arming; a
	 * function answers whether a document URL may be requested, and a `false` — or a throw — refuses it
	 * before the request is sent (E0). `BrowserSession` hands down the E1 matcher over its compiled policy.
	 */
	readonly documentFilter?: ((url: string) => boolean) | null | undefined;
	/**
	 * Which requests the filter judges — `documents` (the default) or `all`. Inert without a
	 * `documentFilter`, so the no-filter attach path arms nothing.
	 */
	readonly requestScope?: RequestScope | undefined;
	/** Override for {@linkcode FETCH_ARM_TIMEOUT_MS}; tests pin the default. */
	readonly fetchArmTimeoutMs?: number | undefined;
	/** Override for {@linkcode FETCH_UNSUPPORTED}; tests exercise the `debug` path with it. */
	readonly fetchUnsupported?: ReadonlySet<string> | undefined;
}

// ---------------------------------------------------------------------------
// ring buffer
// ---------------------------------------------------------------------------

/** Fixed-capacity FIFO. Oldest entries are dropped, never resized. */
export class RingBuffer<T> {
	readonly capacity: number;
	#items: T[] = [];

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity <= 0) {
			throw new BrowserError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	get size(): number {
		return this.#items.length;
	}

	push(item: T): void {
		this.#items.push(item);
		if (this.#items.length > this.capacity) this.#items.splice(0, this.#items.length - this.capacity);
	}

	/** Oldest first. A copy: callers scan it while new events keep arriving. */
	toArray(): T[] {
		return [...this.#items];
	}

	clear(): void {
		this.#items = [];
	}
}

/**
 * Cancellation for the two methods a bus handler drives.
 *
 * ## Why an options bag rather than a bound facade
 *
 * `BaseWatchdog.cdpFor(context)` returns a signal-bound *view* of the CDP client, because every
 * method on that surface is a pure passthrough: binding a signal to all of them is uniformly correct.
 * `SessionManager` is the opposite — `getOrCreateCdpSession` moves the agent's focus pointer, waits
 * for Chrome's attach event, registers the session in five maps and runs the attach cascade. A proxy
 * that silently bound a signal across that surface would be cancelling **bookkeeping**, not traffic:
 * an attach abandoned between `Target.attachToTarget` and `#recordSession` leaves Chrome holding a
 * session these maps have never heard of, which is a leak, not a saving.
 *
 * So the signal is explicit, per method, and obeys one rule stated once here:
 *
 * > **The decision is cancellable; the transaction is not.** An aborted signal refuses *entry* — the
 * > method throws `signal.reason` before touching anything. Once entered, the sequence runs to
 * > completion, because a half-recorded attach is worse than a late one.
 *
 * That is the same asymmetry `storage_state`'s `#writeAtomic` and the reaping of a superseded
 * launch follow.
 */
export interface CancelOptions {
	/** Cancellation from the calling handler's {@linkcode HandlerContext}, if it has one. */
	readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
	readonly #client: CdpClient;
	readonly #bus: EventBus;
	readonly #logger: BusLogger | null;
	readonly #proxy: ProxySettings | null;
	readonly #attachWaitMs: number;
	readonly #now: () => number;
	/** The document veto, or `null` for no policy. */
	readonly #documentFilter: ((url: string) => boolean) | null;
	/** The request scope the filter judges. */
	readonly #requestScope: RequestScope;
	readonly #fetchArmTimeoutMs: number;
	readonly #fetchUnsupported: ReadonlySet<string>;

	readonly #targets = new Map<TargetId, TargetRecord>();
	readonly #sessions = new Map<SessionId, CdpSessionRecord>();
	readonly #targetSessions = new Map<TargetId, Set<SessionId>>();
	readonly #sessionTargets = new Map<SessionId, TargetId>();
	readonly #lifecycle = new Map<TargetId, RingBuffer<LifecycleRecord>>();
	/**
	 * The per-session attach cascade, in flight. Registered synchronously by the
	 * `Target.attachedToTarget` handler and awaited by {@linkcode getOrCreateCdpSession} — see
	 * the attach-cascade paragraph in the module note.
	 */
	readonly #configuring = new Map<SessionId, Promise<void>>();
	/** Targets whose `TabCreatedEvent` has already been dispatched (or deliberately suppressed). */
	readonly #announced = new Set<TargetId>();
	readonly #unsubscribes: (() => void)[] = [];
	/** Work started from a synchronous CDP listener; `whenIdle()` awaits it. */
	readonly #pending = new Set<Promise<unknown>>();

	#focusTargetId: TargetId | null = null;
	#sequence = 0;
	#started = false;
	#stopped = false;
	#proxyArmed = false;
	/** The one `Fetch.requestPaused` listener is installed. */
	#fetchArmed = false;
	/**
	 * The URL each judged request's redirect chain began at, keyed by its `Fetch`
	 * interception id (each hop names the one before it in `redirectedRequestId`, measured on Chrome 154). In-process
	 * only; bounded by {@linkcode CHAIN_MEMORY_LIMIT}.
	 */
	readonly #chainStarts = new Map<string, string>();
	/** Recent commit-check parks, oldest first. */
	readonly #parked: { readonly targetId: TargetId; readonly at: number }[] = [];
	/**
	 * The origins refused per target since its last document commit, oldest target first — bounded by
	 * {@linkcode REQUEST_BLOCK_TARGET_LIMIT} targets and {@linkcode REQUEST_BLOCK_ORIGIN_LIMIT} origins each.
	 */
	readonly #requestBlocks = new Map<TargetId, { readonly origins: Map<string, RequestKind>; overflowed: boolean }>();
	/** Subresource and hint refusals per target type — the only record of most types. */
	readonly #refusals = new Map<string, number>();

	constructor(client: CdpClient, options: SessionManagerOptions) {
		this.#client = client;
		this.#bus = options.bus;
		this.#logger = options.logger ?? null;
		this.#proxy = options.proxy ?? null;
		this.#attachWaitMs = options.attachWaitMs ?? ATTACH_WAIT_TIMEOUT_MS;
		this.#now = options.now ?? Date.now;
		this.#documentFilter = options.documentFilter ?? null;
		this.#requestScope = options.requestScope ?? 'documents';
		this.#fetchArmTimeoutMs = options.fetchArmTimeoutMs ?? FETCH_ARM_TIMEOUT_MS;
		this.#fetchUnsupported = options.fetchUnsupported ?? FETCH_UNSUPPORTED;
	}

	/** Whether a document filter is armed — the attach path pauses new targets only then. */
	get filtersDocuments(): boolean {
		return this.#documentFilter !== null;
	}

	/** The request scope in force — `documents` whenever there is no filter. */
	get requestScope(): RequestScope {
		return this.#documentFilter === null ? 'documents' : this.#requestScope;
	}

	/**
	 * Subresource and hint refusals so far, per target type. A refusal on a target that is
	 * not a page or an iframe — a service or shared worker, the prerender host, Chrome's own `browser_ui` and
	 * `background_page` — is counted here and logged at `debug`, and never reported as an event.
	 */
	get requestRefusals(): ReadonlyMap<string, number> {
		return this.#refusals;
	}

	// -- read-only state surface --------------------------------------------

	get client(): CdpClient {
		return this.#client;
	}

	get targets(): ReadonlyMap<TargetId, TargetRecord> {
		return this.#targets;
	}

	get sessions(): ReadonlyMap<SessionId, CdpSessionRecord> {
		return this.#sessions;
	}

	get targetSessions(): ReadonlyMap<TargetId, ReadonlySet<SessionId>> {
		return this.#targetSessions;
	}

	/** The reverse map of {@linkcode targetSessions}. */
	get sessionTargets(): ReadonlyMap<SessionId, TargetId> {
		return this.#sessionTargets;
	}

	/** The one mutable "current tab" pointer. Only page targets may hold it. */
	get agentFocusTargetId(): TargetId | null {
		return this.#focusTargetId;
	}

	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	/** Buffered `Page.lifecycleEvent`s for one target, oldest first. */
	lifecycleEventsFor(targetId: TargetId): LifecycleRecord[] {
		return this.#lifecycle.get(targetId)?.toArray() ?? [];
	}

	/** Ring capacity for a target, for tests that pin the maxlen-50 contract. */
	lifecycleBufferSize(targetId: TargetId): number {
		return this.#lifecycle.get(targetId)?.size ?? 0;
	}

	/** Page targets, most recently discovered first. */
	pageTargets(): TargetRecord[] {
		return [...this.#targets.values()]
			.filter((record) => record.type === PAGE_TARGET_TYPE)
			.sort((a, b) => b.sequence - a.sequence);
	}

	/** The most recently discovered page target, or `null` when the browser has none. */
	mostRecentPageTarget(): TargetRecord | null {
		return this.pageTargets()[0] ?? null;
	}

	/** Resolves everything started from a CDP listener. Tests await this instead of sleeping. */
	async whenIdle(): Promise<void> {
		// Attach handling can itself start more work (per-session autoAttach cascades), so drain to a
		// fixed point rather than snapshotting once.
		for (let guard = 0; guard < 100 && this.#pending.size > 0; guard++) {
			await Promise.allSettled([...this.#pending]);
		}
	}

	// -- lifecycle ---------------------------------------------------------------------------------

	/**
	 * Registers the root handlers, seeds the target map from `Target.getTargets`, and switches on
	 * push-based discovery. Seeded targets are marked as already-announced: the post-connect sequence
	 * replays `TabCreatedEvent` for pre-existing tabs itself, in its own defined order.
	 */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#registerRootHandlers();
		// Installed before discovery and before any session can issue `Fetch.enable`, so a
		// request paused by the first attach cascade always has an answerer.
		this.#armFetch();

		const existing = await this.#client.send.Target.getTargets({ filter: [...DISCOVERY_FILTER] });
		for (const info of existing.targetInfos) {
			this.#recordTarget(info);
			this.#announced.add(info.targetId);
		}

		await this.#client.send.Target.setDiscoverTargets({ discover: true, filter: [...DISCOVERY_FILTER] });
	}

	/**
	 * Re-reads every target from Chrome and updates the map.
	 *
	 * The map is fed by `Target.targetInfoChanged`, and Chrome does not send that event promptly for
	 * a *title* change: measured against Chrome 141, a page whose `<title>` has long since parsed (a
	 * full DOM state build has already completed against it) can still have `record.title` set to the
	 * host-and-path fallback Chrome uses before a title exists, while `Target.getTargets` in the same
	 * tick reports the real title. Every tab listing a model or a live viewer sees is built from that
	 * map, and the title is the one field a human uses to tell two tabs apart.
	 *
	 * One round trip, and it is the caller's choice when to pay for it: listings do, hot paths need
	 * not. It never announces, so it cannot double-fire `TabCreatedEvent` for a tab that arrived
	 * between the push event and this call.
	 */
	async resyncTargets(): Promise<void> {
		if (!this.#started || this.#stopped) return;
		const current = await this.#client.send.Target.getTargets({ filter: [...DISCOVERY_FILTER] });
		const seen = new Set<TargetId>();
		for (const info of current.targetInfos) {
			seen.add(info.targetId);
			this.#recordTarget(info);
			this.#announced.add(info.targetId);
		}
		// A target Chrome no longer lists is gone, whether or not its
		// `targetDestroyed` has been delivered yet.
		for (const targetId of [...this.#targets.keys()]) {
			if (!seen.has(targetId)) this.#targets.delete(targetId);
		}
	}

	/** Detaches every listener and drops all state. Idempotent; never touches the socket. */
	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const off of this.#unsubscribes) off();
		this.#unsubscribes.length = 0;
		await this.whenIdle();
		this.#targets.clear();
		this.#sessions.clear();
		this.#targetSessions.clear();
		this.#sessionTargets.clear();
		this.#lifecycle.clear();
		this.#configuring.clear();
		this.#announced.clear();
		this.#chainStarts.clear();
		this.#parked.length = 0;
		this.#requestBlocks.clear();
		this.#focusTargetId = null;
	}

	/**
	 * Pre-existing tabs, in discovery order, for the post-connect `TabCreatedEvent` replay. Returns page
	 * targets only — the replay exists so watchdogs see the tabs that were open before we attached.
	 */
	seededPageTargets(): TargetRecord[] {
		return [...this.#targets.values()]
			.filter((record) => record.type === PAGE_TARGET_TYPE && this.#announced.has(record.targetId))
			.sort((a, b) => a.sequence - b.sequence);
	}

	// -- the sole sanctioned accessor ---------------------------------------

	/**
	 * Returns (attaching if necessary) the CDP session for a target.
	 *
	 * The ONLY sanctioned way to get a session id. It:
	 * 1. resolves `targetId` — explicit, else the agent's focus, else the most recent page;
	 * 2. validates focus — only page targets may hold it, so `focus: true` on an iframe/worker throws
	 *    rather than silently pointing the agent at a non-page target;
	 * 3. polls ≤ {@linkcode ATTACH_WAIT_TIMEOUT_MS} for Chrome's `Target.attachedToTarget` event so the
	 *    state maps are populated before the caller issues a command on the session;
	 * 4. resumes a debugger-paused target;
	 * 5. awaits that session's attach cascade, so the id it returns names an *instrumented* session —
	 *    `Network.enable` has been issued and a navigation on it cannot outrun it.
	 */
	async getOrCreateCdpSession(
		targetId?: TargetId | null,
		focus = true,
		options: CancelOptions = {},
	): Promise<CdpSessionRecord> {
		this.#assertUsable();
		// The entry gate. A handler the bus has already abandoned must not go on
		// attaching targets and moving the agent's focus — but everything below this line is a
		// transaction over five maps plus Chrome's own session table, so it is not interruptible once
		// begun. See {@linkcode CancelOptions} for why that split, and not a bound facade.
		options.signal?.throwIfAborted();
		const resolved = this.#resolveTargetId(targetId ?? null);
		const record = this.#targets.get(resolved);

		if (focus) {
			if (record !== undefined && record.type !== PAGE_TARGET_TYPE) {
				throw new BrowserError(
					`target ${resolved} is a '${record.type}' target and cannot hold the agent's focus ` +
						'(only page targets may)',
				);
			}
			this.#focusTargetId = resolved;
		}

		const existing = this.#firstSessionFor(resolved);
		if (existing !== null) return await this.#whenConfigured(existing);

		const attached = await this.#client.send.Target.attachToTarget({ targetId: resolved, flatten: true });
		const seen = await this.#waitForAttachEvent(attached.sessionId);
		if (seen !== null) return await this.#whenConfigured(seen);

		// The ≤2 s poll for Chrome's attach event expired. Chrome answered the *command*, so the returned session id is authoritative:
		// registering it (with a warning) beats failing an otherwise usable session on a slow event.
		this.#logger?.warn('attach event did not arrive within the attach budget; registering from the command result', {
			targetId: resolved,
			sessionId: attached.sessionId,
			attachWaitMs: this.#attachWaitMs,
		});
		const type = record?.type ?? PAGE_TARGET_TYPE;
		const registered = this.#recordSession(attached.sessionId, resolved, type);
		// The event this session was *not* built from is also what would have
		// run the attach cascade. Run it here, so the fallback path returns an instrumented session too
		// rather than one with `Network`/`Page` silently off.
		if (!this.#configuring.has(attached.sessionId)) {
			this.#configuring.set(attached.sessionId, this.#configureAttached(attached.sessionId, type, false));
		}
		return await this.#whenConfigured(registered);
	}

	/**
	 * Points the agent's focus at a page target, optionally activating it in the browser and
	 * announcing the change. Rejects non-page targets.
	 */
	async setAgentFocus(
		targetId: TargetId,
		options: { readonly activate?: boolean; readonly announce?: boolean } & CancelOptions = {},
	): Promise<TargetRecord> {
		this.#assertUsable();
		options.signal?.throwIfAborted();
		const record = this.#targets.get(targetId);
		if (record !== undefined && record.type !== PAGE_TARGET_TYPE) {
			throw new BrowserError(`cannot focus '${record.type}' target ${targetId}: only page targets may hold focus`);
		}
		this.#focusTargetId = targetId;
		if (options.activate !== false) {
			try {
				// Bound rather than gated: `activateTarget` is cosmetic and its failure is already
				// swallowed below ("focus pointer still moved"), so an abort here costs nothing that the
				// existing catch does not already tolerate.
				await this.#cdpFor(options.signal).send.Target.activateTarget({ targetId });
			} catch (error) {
				this.#logger?.warn('activateTarget failed; focus pointer still moved', { targetId, error });
			}
		}
		const resolved = this.#targets.get(targetId) ??
			{ targetId, type: PAGE_TARGET_TYPE, url: '', title: '', sequence: 0 };
		if (options.announce === true) {
			await this.#bus.dispatch(new AgentFocusChangedEvent({ targetId, url: resolved.url }));
		}
		return resolved;
	}

	/**
	 * Arms proxy authentication: `Fetch.enable({handleAuthRequests: true})` is issued per attached
	 * session (see `#configureSession`); this installs the browser-wide answering handlers
	 * (step 6 of the post-connect sequence).
	 * A no-op when the profile carries no proxy credentials.
	 */
	armProxyAuth(): void {
		if (this.#proxyArmed || !this.#hasProxyCredentials()) return;
		this.#proxyArmed = true;
		const proxy = this.#proxy as ProxySettings & { username: string };
		const credentials = { username: proxy.username, password: proxy.password ?? '' };

		this.#unsubscribes.push(this.#client.on('Fetch.authRequired', (params, sessionId) => {
			// Only the proxy's own challenge gets the proxy's credentials: `Fetch.authRequired` also fires for
			// a *site's* 401, and answering every challenge would hand the proxy username and password to any page
			// that asked for Basic auth. A server challenge gets `Default`, the
			// browser's own behaviour (headless: no prompt, the 401 stands).
			const isProxy = params.authChallenge?.source === 'Proxy';
			this.#track(
				this.#client.send.Fetch.continueWithAuth({
					requestId: params.requestId,
					authChallengeResponse: isProxy ? { response: 'ProvideCredentials', ...credentials } : { response: 'Default' },
				}, sessionId).catch((error: unknown) => {
					this.#logger?.warn('proxy auth response failed', { error });
				}),
			);
		}));

		// Paused requests are answered by `#armFetch`'s one listener, shared with the document veto. Two
		// independent listeners would race to answer the same paused request, and the loser's call would fail
		// on an interception id that no longer exists.
		this.#armFetch();
	}

	/**
	 * The **one** `Fetch.requestPaused` answerer, installed whenever a document filter or proxy
	 * credentials exist (`Fetch.enable` pauses requests in either case, and a paused request nobody answers
	 * hangs the page). With no filter its answer is to continue every request.
	 */
	#armFetch(): void {
		if (this.#fetchArmed) return;
		if (this.#documentFilter === null && !this.#hasProxyCredentials()) return;
		this.#fetchArmed = true;
		this.#unsubscribes.push(this.#client.on('Fetch.requestPaused', (params, sessionId) => {
			this.#track(this.#answerPaused(params, sessionId));
		}));
	}

	/**
	 * Judges one paused request and answers it **exactly once**.
	 *
	 * A document the filter refuses — or a filter that throws: the veto fails closed — is failed with
	 * {@linkcode DOCUMENT_BLOCK_ERROR_REASON} and reported as an E0 `BrowserErrorEvent`; everything else is
	 * continued. Each redirect hop arrives as a fresh pause (`redirectedRequestId`) and is judged on its own
	 * URL. The block is reported **before** the request is failed, so the record exists by the time the
	 * navigation that carried the request reports its failure to whoever issued it. A rejected answer is
	 * ignored: the request is already gone (its target closed, or the browser cancelled it).
	 *
	 * The request is classified first ({@linkcode requestKindOf}). A hint — in either scope — and,
	 * in `all`, a subresource are judged too and, when refused, failed with {@linkcode SUBRESOURCE_BLOCK_ERROR_REASON}
	 * and reported through the aggregation of `#reportRequestBlock`. Still one answerer, still exactly one answer.
	 */
	async #answerPaused(params: CdpEventParams['Fetch.requestPaused'], sessionId: SessionId | undefined): Promise<void> {
		const requestId = params.requestId;
		let answered = false;
		try {
			// What the request is decides whether — and how — the scope judges it.
			const kind = requestKindOf(params);
			const refused = this.#refusesRequest(kind, params);
			if (refused) {
				try {
					if (kind === 'document') this.#reportDocumentBlock(params, sessionId, this.#chainStartOf(params));
					else this.#reportRequestBlock(params, sessionId, kind);
				} catch {
					// Reporting must never be the reason a refused request goes through.
				}
				answered = true;
				await this.#client.send.Fetch.failRequest({ requestId, errorReason: _failReasonFor(kind, params) }, sessionId)
					.catch(() => {});
				return;
			}
			// A judged document that goes through starts (or extends) a chain a later hop may be refused in.
			if (this.#documentFilter !== null && kind === 'document') {
				try {
					this.#chainStartOf(params);
				} catch {
					// Bookkeeping must never be the reason a request is stranded.
				}
			}
			answered = true;
			await this.#client.send.Fetch.continueRequest({ requestId }, sessionId).catch(() => {});
		} finally {
			// Unreachable by construction; kept so a later edit cannot strand a paused request. A kind the scope judges
			// fails closed under a filter, anything else is released.
			if (!answered) {
				const closed = this.#judgesKindOf(params);
				await (closed
					? this.#client.send.Fetch.failRequest({ requestId, errorReason: DOCUMENT_BLOCK_ERROR_REASON }, sessionId)
					: this.#client.send.Fetch.continueRequest({ requestId }, sessionId)).catch(() => {});
			}
		}
	}

	/**
	 * The E0 decision. Fails closed on a throwing filter. A `Prefetch` is judged
	 * like a `Document` — it is the response a later navigation would be served from without a request of its own.
	 * A hint is judged in both scopes and a subresource in `all` only; for those two kinds only
	 * http(s) and ws(s) URLs are judged (a `ws:` URL as `http:`), so `data:`, `blob:`, `chrome:` and an extension's own
	 * resources pass. A document is judged on its own URL.
	 */
	#refusesRequest(kind: RequestKind, params: CdpEventParams['Fetch.requestPaused']): boolean {
		const filter = this.#documentFilter;
		if (filter === null) return false;
		if (kind === 'subresource' && this.#requestScope !== 'all') return false;
		const url = kind === 'document' ? params.request.url : _judgedRequestUrl(params.request.url);
		if (url === null) return false;
		try {
			return filter(url) !== true;
		} catch {
			return true;
		}
	}

	/** Whether the scope judges this request's kind — the fail-closed answer when everything else went wrong. */
	#judgesKindOf(params: CdpEventParams['Fetch.requestPaused']): boolean {
		if (this.#documentFilter === null) return false;
		try {
			return requestKindOf(params) !== 'subresource' || this.#requestScope === 'all';
		} catch {
			return true;
		}
	}

	/**
	 * A refused subresource or hint, reported without flooding. Every refusal is counted by
	 * target type. The **first** refusal of an origin on a target since its last document commit is logged at `debug`
	 * (origin only, never the path or query) and — on a page or iframe target only — dispatched as one E0
	 * `BrowserErrorEvent` carrying `requestKind`; past {@linkcode REQUEST_BLOCK_ORIGIN_LIMIT} origins one more report says
	 * `overflow: true` and the rest are only counted until the next commit. The URL stays in-process, as E0's does.
	 */
	#reportRequestBlock(
		params: CdpEventParams['Fetch.requestPaused'],
		sessionId: SessionId | undefined,
		kind: Exclude<RequestKind, 'document'>,
	): void {
		const url = params.request.url;
		const origin = _originOf(url);
		const targetId = sessionId === undefined ? null : this.#sessionTargets.get(sessionId) ?? null;
		const targetType = (sessionId === undefined ? undefined : this.#sessions.get(sessionId)?.type) ??
			(targetId === null ? undefined : this.#targets.get(targetId)?.type) ?? 'unknown';
		this.#refusals.set(targetType, (this.#refusals.get(targetType) ?? 0) + 1);
		if (targetId === null) return;
		const blocks = this.#requestBlocksFor(targetId);
		if (blocks.overflowed || blocks.origins.has(origin)) return;
		const overflow = blocks.origins.size >= REQUEST_BLOCK_ORIGIN_LIMIT;
		if (overflow) blocks.overflowed = true;
		else blocks.origins.set(origin, kind);
		this.#logger?.debug('request refused before it was sent', {
			enforcementPoint: 'E0',
			requestKind: kind,
			origin,
			targetId,
			targetType,
			...(overflow ? { overflow: true } : {}),
		});
		if (targetType !== PAGE_TARGET_TYPE && targetType !== 'iframe') return;
		const handle = this.#bus.dispatch(
			new BrowserErrorEvent({
				errorType: NAVIGATION_BLOCKED_ERROR,
				message: `Request to ${url} is not allowed by the configured domain policy`,
				details: {
					enforcementPoint: 'E0',
					containment: 'request-blocked',
					requestKind: kind,
					url,
					targetId,
					targetType,
					frameId: params.frameId,
					resourceType: params.resourceType,
					...(overflow ? { overflow: true } : {}),
				},
			}),
		);
		this.#track(handle.catch((error: unknown) => {
			this.#logger?.debug('a BrowserErrorEvent consumer failed', { error });
		}));
	}

	/** One target's refused origins, created on first use; the oldest target is forgotten first. */
	#requestBlocksFor(targetId: TargetId): { readonly origins: Map<string, RequestKind>; overflowed: boolean } {
		const existing = this.#requestBlocks.get(targetId);
		if (existing !== undefined) return existing;
		const created = { origins: new Map<string, RequestKind>(), overflowed: false };
		this.#requestBlocks.set(targetId, created);
		while (this.#requestBlocks.size > REQUEST_BLOCK_TARGET_LIMIT) {
			const oldest = this.#requestBlocks.keys().next().value;
			if (oldest === undefined) break;
			this.#requestBlocks.delete(oldest);
		}
		return created;
	}

	/**
	 * The URL this request's redirect chain began at — its own URL for a first request, the
	 * remembered start of the hop it continues otherwise — recorded under its own interception id for the next hop.
	 */
	#chainStartOf(params: CdpEventParams['Fetch.requestPaused']): string {
		const url = params.request.url;
		const previous = params.redirectedRequestId;
		let start = url;
		if (previous !== undefined) {
			start = this.#chainStarts.get(previous) ?? url;
			this.#chainStarts.delete(previous);
		}
		this.#chainStarts.set(params.requestId, start);
		while (this.#chainStarts.size > CHAIN_MEMORY_LIMIT) {
			const oldest = this.#chainStarts.keys().next().value;
			if (oldest === undefined) break;
			this.#chainStarts.delete(oldest);
		}
		return start;
	}

	/**
	 * The E0 report, in the vocabulary the SecurityWatchdog's E1–E3 use. The log line names the
	 * origin only, at `debug`: the refused URL is where a one-time code would be. The event keeps
	 * the URL in-process for the host, which logs and records it redacted.
	 */
	#reportDocumentBlock(
		params: CdpEventParams['Fetch.requestPaused'],
		sessionId: SessionId | undefined,
		chainStart: string,
	): void {
		const url = params.request.url;
		const targetId = sessionId === undefined ? null : this.#sessionTargets.get(sessionId) ?? null;
		this.#logger?.debug('document request refused before it was sent', {
			enforcementPoint: 'E0',
			origin: _originOf(url),
			targetId,
		});
		// A target armed only by the request scope — the prerender host, a worker, Chrome's
		// own UI — commits no tab document a record could describe; its refused document is counted, never an event.
		const targetType = sessionId === undefined ? undefined : this.#sessions.get(sessionId)?.type;
		if (targetType !== undefined && targetType !== PAGE_TARGET_TYPE && targetType !== 'iframe') {
			this.#refusals.set(targetType, (this.#refusals.get(targetType) ?? 0) + 1);
			return;
		}
		const handle = this.#bus.dispatch(
			new BrowserErrorEvent({
				errorType: NAVIGATION_BLOCKED_ERROR,
				message: `Navigation to ${url} is not allowed by the configured domain policy`,
				details: {
					enforcementPoint: 'E0',
					url,
					targetId,
					frameId: params.frameId,
					containment: 'request-blocked',
					// `Prefetch` for a refused speculative request, which is no one's navigation (yet).
					resourceType: params.resourceType,
					// Where the refused hop's chain began, so a host can attribute the block. In-process only,
					// like `url`.
					chainStart,
				},
			}),
		);
		this.#track(handle.catch((error: unknown) => {
			// A consumer of the error event failing must not mask the block itself.
			this.#logger?.debug('a BrowserErrorEvent consumer failed', { error });
		}));
	}

	#hasProxyCredentials(): boolean {
		return this.#proxy !== null && this.#proxy.username !== undefined;
	}

	// -- root CDP handlers (one global handler per method, routed by sessionId) ------------------

	/**
	 * The CDP client with a caller's cancellation bound.
	 *
	 * `undefined` yields the bare client, for the reason `handlerBudget(undefined)` is infinite: this
	 * manager is also driven from `connect()`, from CDP listeners and from tests, none of which run
	 * under a dispatch.
	 */
	#cdpFor(signal: AbortSignal | undefined): CdpClient {
		return cdpBoundTo(this.#client, signal);
	}

	#registerRootHandlers(): void {
		this.#unsubscribes.push(
			this.#client.on('Target.targetCreated', (params) => {
				this.#recordTarget(params.targetInfo);
				this.#track(this.#announce(params.targetInfo));
			}),
			this.#client.on('Target.targetInfoChanged', (params) => {
				this.#recordTarget(params.targetInfo);
				this.#track(this.#announce(params.targetInfo));
			}),
			this.#client.on('Target.targetDestroyed', (params) => {
				this.#track(this.#removeTarget(params.targetId));
			}),
			this.#client.on('Target.attachedToTarget', (params) => {
				this.#track(this.#onAttached(params));
			}),
			this.#client.on('Target.detachedFromTarget', (params) => {
				this.#track(this.#onDetached(params.sessionId, params.targetId ?? null));
			}),
			// The single global lifecycle router: one handler, keyed by
			// sessionId, feeding per-target ring buffers. Kept even though the client registry is
			// multi-listener, because per-target state coherence depends on exactly one writer.
			this.#client.on('Page.lifecycleEvent', (params, sessionId) => {
				this.#recordLifecycle(params, sessionId);
			}),
		);
		// The page-driven commit check, under a filter only — without one no `Page.frameNavigated`
		// handler is registered here.
		if (this.#documentFilter !== null) {
			this.#unsubscribes.push(this.#client.on('Page.frameNavigated', (params, sessionId) => {
				// A target's new document starts its refused-origin aggregation afresh.
				this.#resetRequestBlocks(params, sessionId);
				this.#track(this.#checkCommit(params, sessionId));
			}));
		}
	}

	/**
	 * Forgets a target's refused origins when its own top frame commits — a page's main frame, or an
	 * out-of-process iframe's root (whose frame id is its target id) — so each document reports its own first refusals.
	 */
	#resetRequestBlocks(params: CdpEventParams['Page.frameNavigated'], sessionId: SessionId | undefined): void {
		if (sessionId === undefined) return;
		const targetId = this.#sessionTargets.get(sessionId);
		if (targetId === undefined) return;
		if (params.frame.parentId === undefined || params.frame.id === targetId) this.#requestBlocks.delete(targetId);
	}

	/**
	 * Whether this manager parked `targetId` on `about:blank` for an off-list commit in the
	 * last {@linkcode COMMIT_PARK_MEMORY_MS}. The SecurityWatchdog reads it so its own E2 does not contain — and record —
	 * the same navigation a second time.
	 */
	parkedRecently(targetId: TargetId): boolean {
		const horizon = this.#now() - COMMIT_PARK_MEMORY_MS;
		while (this.#parked.length > 0 && (this.#parked[0]?.at ?? 0) < horizon) this.#parked.shift();
		return this.#parked.some((entry) => entry.targetId === targetId);
	}

	/**
	 * Defence in depth behind E0: a page target's main frame that **committed** an
	 * off-list http(s) document is parked on `about:blank` and reported as an E2 block (`trigger: 'commit'`).
	 *
	 * E0 refuses requests; a document that needs no request of its own — measured on Chrome 154, a navigation served
	 * from a speculation-rules prefetch — is never paused, and the SecurityWatchdog's E2 re-checks only navigations this process issued. The
	 * commit is the one event every path to a new main-frame document produces. Only http(s) URLs are judged: a
	 * `chrome-error:` page, `about:blank`, `data:` and `blob:` are not network documents (the URL matcher allows the latter, and the
	 * error page is what a failed on-list navigation commits). The off-list document has run by the time it is parked —
	 * this is containment after the fact, the reason it is the second layer and not the first. The park is
	 * uncancellable and capped, like E2's; it is remembered **before** the first await, so the watchdog's E2 for the
	 * same navigation (which follows its commit) finds it.
	 */
	async #checkCommit(params: CdpEventParams['Page.frameNavigated'], sessionId: SessionId | undefined): Promise<void> {
		const filter = this.#documentFilter;
		if (filter === null || sessionId === undefined || this.#stopped) return;
		const frame = params.frame;
		if (frame.parentId !== undefined) return;
		const targetId = this.#sessionTargets.get(sessionId);
		if (targetId === undefined || this.#targets.get(targetId)?.type !== PAGE_TARGET_TYPE) return;
		const url = frame.url;
		const parsed = URL.parse(url);
		if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return;
		let allowed = false;
		try {
			allowed = filter(url) === true;
		} catch {
			allowed = false;
		}
		if (allowed) return;
		this.#parked.push({ targetId, at: this.#now() });
		if (this.#parked.length > E0_COMMIT_PARK_LIMIT) this.#parked.splice(0, this.#parked.length - E0_COMMIT_PARK_LIMIT);
		const contained = await this.#parkOnBlank(sessionId);
		// A tab that is gone (the SecurityWatchdog's E3 closed a pop-up first, or it closed itself) holds no document to
		// report: E3 already recorded it, or nothing remains.
		if (!contained && !this.#targets.has(targetId)) return;
		this.#logger?.debug('an off-list document committed and was parked', {
			enforcementPoint: 'E2',
			origin: _originOf(url),
			targetId,
			contained,
		});
		await this.#bus.dispatch(
			new BrowserErrorEvent({
				errorType: NAVIGATION_BLOCKED_ERROR,
				message: `Navigation to ${url} is not allowed by the configured domain policy`,
				details: {
					enforcementPoint: 'E2',
					url,
					targetId,
					containment: contained ? 'about:blank' : 'failed',
					trigger: 'commit',
				},
			}),
		).catch((error: unknown) => {
			this.#logger?.debug('a BrowserErrorEvent consumer failed', { error });
		});
	}

	/** The commit check's containment write: bare client (uncancellable), capped, never throws. */
	async #parkOnBlank(sessionId: SessionId): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const capped = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), COMMIT_CONTAINMENT_TIMEOUT_MS);
		});
		try {
			const outcome = await Promise.race([
				this.#client.send.Page.navigate({ url: 'about:blank', transitionType: 'address_bar' }, sessionId)
					.then(() => 'ok' as const, () => 'failed' as const),
				capped,
			]);
			if (outcome !== 'ok') this.#logger?.error('the commit check could not park a tab', { outcome });
			return outcome === 'ok';
		} finally {
			clearTimeout(timer);
		}
	}

	async #onAttached(params: CdpEventParams['Target.attachedToTarget']): Promise<void> {
		const info = params.targetInfo;
		this.#recordTarget(info);
		this.#recordSession(params.sessionId, info.targetId, info.type);

		// Registered *synchronously*, before the first await, so a caller that finds this session already
		// in the maps still has something to wait on. Registering it after the first await would reopen
		// the window in which an uninstrumented session id can be handed out.
		const configured = this.#configureAttached(params.sessionId, info.type, params.waitingForDebugger);
		this.#configuring.set(params.sessionId, configured);
		await configured;
		await this.#announce(info);
	}

	/**
	 * The attach cascade for one session.
	 *
	 * The cascade runs **before** a debugger-paused renderer is resumed: a target Chrome is holding
	 * for us is the one moment where instrumenting it is free of races, and resuming first would hand
	 * the first document a head start on `Network.enable`.
	 */
	async #configureAttached(sessionId: SessionId, type: string, waitingForDebugger: boolean): Promise<void> {
		if (this.#documentFilter !== null) {
			await this.#configureFiltered(sessionId, type, waitingForDebugger);
			return;
		}
		await this.#configureSession(sessionId, type);
		if (waitingForDebugger) await this.#resumeIfPaused(sessionId);
	}

	/** Resolves once this session's attach cascade has finished. Never rejects — see `#safe`. */
	async #whenConfigured(record: CdpSessionRecord): Promise<CdpSessionRecord> {
		const pending = this.#configuring.get(record.sessionId);
		if (pending !== undefined) await pending.catch(() => {});
		return record;
	}

	async #onDetached(sessionId: SessionId, targetIdHint: TargetId | null): Promise<void> {
		const targetId = this.#sessionTargets.get(sessionId) ?? targetIdHint;
		this.#sessions.delete(sessionId);
		this.#sessionTargets.delete(sessionId);
		this.#configuring.delete(sessionId);
		if (targetId === null) return;

		const set = this.#targetSessions.get(targetId);
		set?.delete(sessionId);
		if (set !== undefined && set.size > 0) return;

		// Last session gone ⇒ the target is dead as far as we are concerned.
		await this.#removeTarget(targetId);
	}

	/**
	 * Full removal of a target: the only path that fires `TabClosedEvent`.
	 *
	 * Removal is "TabClosedEvent, then focus recovery", but the focus pointer is dropped in the same
	 * synchronous step as the target record. Clearing it *after* the dispatch would leave the pointer
	 * naming a deleted target for the whole `TabClosedEvent` fan-out — a 3 s budget with real handlers
	 * in it — and anything reaching {@linkcode getOrCreateCdpSession} in that window would resolve
	 * `null` to the dead id and get `attachToTarget: No target with given id found`. So no observer can
	 * see a focus that is not a live tab; recovery still runs after the dispatch.
	 */
	async #removeTarget(targetId: TargetId): Promise<void> {
		const record = this.#targets.get(targetId);
		if (record === undefined) return;
		this.#targets.delete(targetId);
		this.#lifecycle.delete(targetId);
		this.#announced.delete(targetId);
		this.#requestBlocks.delete(targetId);
		for (const sessionId of this.#targetSessions.get(targetId) ?? []) {
			this.#sessions.delete(sessionId);
			this.#sessionTargets.delete(sessionId);
			this.#configuring.delete(sessionId);
		}
		this.#targetSessions.delete(targetId);

		const wasFocused = this.#focusTargetId === targetId;
		if (wasFocused) this.#focusTargetId = null;

		if (record.type === PAGE_TARGET_TYPE) {
			await this.#bus.dispatch(new TabClosedEvent({ targetId }));
		}
		if (wasFocused) await this.#recoverFocus();
	}

	/**
	 * Focus recovery: most-recent page → else create `about:blank` → activate →
	 * `AgentFocusChangedEvent` → emergency-fallback tab on failure.
	 *
	 * This is the load-bearing mechanism that lets CrashWatchdog be skipped, so it never throws: a failure becomes a
	 * `BrowserErrorEvent` and leaves focus null rather than poisoning an unrelated handler.
	 */
	async #recoverFocus(): Promise<void> {
		if (this.#stopped) return;
		const candidate = this.mostRecentPageTarget();
		if (candidate !== null) {
			await this.#focusRecovered(candidate.targetId, candidate.url);
			return;
		}
		try {
			const created = await this.#client.send.Target.createTarget({ url: 'about:blank' });
			await this.#focusRecovered(created.targetId, 'about:blank');
		} catch (error) {
			await this.#emergencyFallbackTab(error);
		}
	}

	async #focusRecovered(targetId: TargetId, url: string): Promise<void> {
		this.#focusTargetId = targetId;
		try {
			await this.#client.send.Target.activateTarget({ targetId });
		} catch (error) {
			this.#logger?.warn('focus recovery could not activate the target', { targetId, error });
		}
		await this.#bus.dispatch(new AgentFocusChangedEvent({ targetId, url }));
	}

	/** One last `about:blank` attempt; if that fails too the failure is reported, never thrown. */
	async #emergencyFallbackTab(cause: unknown): Promise<void> {
		try {
			const created = await this.#client.send.Target.createTarget({ url: 'about:blank' });
			this.#focusTargetId = created.targetId;
			await this.#bus.dispatch(new AgentFocusChangedEvent({ targetId: created.targetId, url: 'about:blank' }));
		} catch (error) {
			await this.#bus.dispatch(
				new BrowserErrorEvent({
					errorType: 'FocusRecoveryFailed',
					message: 'no page target could be focused and an emergency about:blank tab could not be created',
					details: { cause: _describe(cause), error: _describe(error) },
				}),
			);
		}
	}

	// -- per-session configuration ------------------------------------------------------------------

	async #configureSession(sessionId: SessionId, type: string): Promise<void> {
		// Cascade: OOPIFs and workers below this target attach through this session, not the root.
		await this.#safe(
			'Target.setAutoAttach',
			() =>
				this.#client.send.Target.setAutoAttach(
					{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
					sessionId,
				),
		);
		if (type !== PAGE_TARGET_TYPE && type !== 'iframe') return;

		await this.#safe('Page.enable', () => this.#client.send.Page.enable(undefined, sessionId));
		await this.#safe(
			'Page.setLifecycleEventsEnabled',
			() => this.#client.send.Page.setLifecycleEventsEnabled({ enabled: true }, sessionId),
		);
		await this.#safe('Network.enable', () => this.#client.send.Network.enable(undefined, sessionId));
		if (this.#proxy !== null && this.#proxy.username !== undefined) {
			await this.#safe(
				'Fetch.enable',
				() => this.#client.send.Fetch.enable({ handleAuthRequests: true }, sessionId),
			);
		}
	}

	/**
	 * The attach cascade under a document filter.
	 *
	 * New targets are attached **paused** (`waitForDebuggerOnStart: true`, here and on the root auto-attach),
	 * so a pop-up's or an out-of-process iframe's first document request cannot leave before this session's
	 * `Fetch.enable` is in place. The order differs from the unfiltered cascade, and the difference is
	 * load-bearing: measured on Chrome 154, a `noopener` pop-up held for the debugger has no renderer yet,
	 * and every renderer-bound command — `Page.enable`, `Network.enable` — waits for one, so "configure
	 * everything, then resume" deadlocks: the pop-up never loads at all, on-list or off. `Fetch`
	 * and `Target` are browser-side and answer immediately, so they are awaited first; the renderer-bound
	 * commands are **sent** before the resume (so an existing renderer applies them before the first
	 * document, which keeps the "a session id means an instrumented session" guarantee) and **awaited** after it. The session is
	 * still reported configured only once all of them have answered.
	 */
	async #configureFiltered(sessionId: SessionId, type: string, waitingForDebugger: boolean): Promise<void> {
		await this.#safe(
			'Target.setAutoAttach',
			() =>
				this.#client.send.Target.setAutoAttach(
					{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
					sessionId,
				),
		);
		const fetchParams = this.#fetchEnableParams(type);
		if (type !== PAGE_TARGET_TYPE && type !== 'iframe') {
			// A non-page target this scope arms is armed before it is resumed — so its
			// first request (a worker script's import, a service worker's install fetch, the prerender host's prefetch)
			// cannot leave unjudged — under a bounded wait, and resumed whatever the arming did.
			try {
				if (fetchParams !== null) await this.#armRequestFilter(sessionId, type, fetchParams);
			} finally {
				// The WebRTC lockdown is sent before the resume, never awaited here — a window-less or
				// renderer-less target must not hold the resume (or this cascade) on a command it may never answer.
				if (this.#locksWebRtc(type)) this.#track(this.#lockWebRtc(sessionId, type));
				if (waitingForDebugger) await this.#resumeIfPaused(sessionId);
			}
			return;
		}
		if (fetchParams !== null) await this.#armRequestFilter(sessionId, type, fetchParams);
		const rendererBound = [
			this.#safe('Page.enable', () => this.#client.send.Page.enable(undefined, sessionId)),
			this.#safe(
				'Page.setLifecycleEventsEnabled',
				() => this.#client.send.Page.setLifecycleEventsEnabled({ enabled: true }, sessionId),
			),
			this.#safe('Network.enable', () => this.#client.send.Network.enable(undefined, sessionId)),
			// The WebRTC lockdown is queued before the resume, so the first document's script cannot run
			// before it; `runImmediately` covers a document that is already there (a seeded tab).
			...(this.#locksWebRtc(type) ? [this.#lockWebRtc(sessionId, type)] : []),
		];
		if (waitingForDebugger) await this.#resumeIfPaused(sessionId);
		await Promise.all(rendererBound);
	}

	/**
	 * One `Fetch.enable` per armed session, its patterns merged — calling it again would replace the
	 * earlier configuration. Never `Prefetch`, which Chrome 154 refuses in a filter (see {@linkcode JUDGED_RESOURCE_TYPES});
	 * the patterns themselves are `#fetchEnableParams`'. A failure is
	 * **logged at `warn`**, by target type only, rather than swallowed at `debug` like the other setup calls: an unarmed
	 * filter is a containment that silently falls back to after-the-fact (E2/E3 and the commit check), or — on a
	 * non-page target in `all` — to the resolver layer alone, and an operator must be able to see that.
	 */
	async #armRequestFilter(sessionId: SessionId, type: string, params: CdpParams['Fetch.enable']): Promise<void> {
		// Bounded, and never rejecting — the caller resumes the target right after.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const capped = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), this.#fetchArmTimeoutMs);
		});
		let outcome: 'ok' | 'timeout' | { readonly error: unknown };
		try {
			outcome = await Promise.race([
				this.#client.send.Fetch.enable(params, sessionId).then(
					() => 'ok' as const,
					(error: unknown) => ({ error }),
				),
				capped,
			]);
		} finally {
			clearTimeout(timer);
		}
		if (outcome === 'ok') return;
		const pageLike = type === PAGE_TARGET_TYPE || type === 'iframe';
		const error = outcome === 'timeout' ? `no answer within ${this.#fetchArmTimeoutMs} ms` : _describe(outcome.error);
		// A type measured to refuse `Fetch` outright is expected, not news.
		if (outcome !== 'timeout' && _cdpCode(outcome.error) === -32601 && this.#fetchUnsupported.has(type)) {
			this.#logger?.debug('Fetch is unavailable on this target type; its requests are not judged', {
				targetType: type,
			});
			return;
		}
		this.#logger?.warn(
			pageLike
				? 'the document filter could not be armed on a target; E2/E3 containment remains'
				: 'the request filter could not be armed on a target; its requests are not judged',
			{ targetType: type, error },
		);
	}

	/**
	 * The `Fetch.enable` parameters a target of `type` is armed with under a filter, or `null` for
	 * a target this scope leaves alone. One call per session — a second would replace the first.
	 *
	 * - `worker`: never (`-32601`; its requests pause on the owning page).
	 * - Proxy credentials: every request, plus `handleAuthRequests`, on any target armed at all — still one answerer.
	 * - `all`: every request (`*`), on every other type — unknown types included, fail closed.
	 * - `documents`: `Document` + `Fetch` (hints) on pages and iframes; `Document` on the prerender host (`other`);
	 *   nothing on any other type.
	 */
	#fetchEnableParams(type: string): CdpParams['Fetch.enable'] | null {
		if (type === UNARMED_TARGET_TYPE) return null;
		const pageLike = type === PAGE_TARGET_TYPE || type === 'iframe';
		const all = this.#requestScope === 'all';
		if (!all && !pageLike && type !== PRERENDER_HOST_TARGET_TYPE) return null;
		if (this.#hasProxyCredentials()) return { patterns: [{ urlPattern: '*' }], handleAuthRequests: true };
		if (all) return { patterns: [{ ...ALL_REQUESTS_PATTERN }] };
		return pageLike
			? { patterns: [{ ...DOCUMENT_REQUEST_PATTERN }, { ...FETCH_REQUEST_PATTERN }] }
			: { patterns: [{ ...DOCUMENT_REQUEST_PATTERN }] };
	}

	/** Whether a target of `type` takes the WebRTC lockdown — `all`, with a window. */
	#locksWebRtc(type: string): boolean {
		return this.requestScope === 'all' && !WINDOWLESS_TARGET_TYPES.has(type);
	}

	/**
	 * Registers {@linkcode WEBRTC_LOCKDOWN_SOURCE} on one session. Never rejects. A
	 * failure on a page or iframe is a `warn` by target type — WebRTC there then rests on the preference and resolver
	 * layers alone, and an operator must be able to see that; on any other type it is a `debug` line, and the wait is
	 * bounded by the arming budget, because nothing awaits it but `whenIdle()` (and so `stop()`).
	 */
	async #lockWebRtc(sessionId: SessionId, type: string): Promise<void> {
		const pageLike = type === PAGE_TARGET_TYPE || type === 'iframe';
		try {
			await this.#client.send.Page.addScriptToEvaluateOnNewDocument(
				{ source: WEBRTC_LOCKDOWN_SOURCE, runImmediately: true },
				sessionId,
				pageLike ? undefined : { requestTimeoutMs: this.#fetchArmTimeoutMs },
			);
		} catch (error) {
			const fields = { targetType: type, error: _describe(error) };
			if (pageLike) this.#logger?.warn('the WebRTC lockdown could not be registered on a target', fields);
			else this.#logger?.debug('the WebRTC lockdown was not taken by this target type', fields);
		}
	}

	async #resumeIfPaused(sessionId: SessionId): Promise<void> {
		// Not part of the typed CDP surface; `sendRaw` is the sanctioned escape hatch.
		await this.#safe(
			'Runtime.runIfWaitingForDebugger',
			() => this.#client.sendRaw('Runtime.runIfWaitingForDebugger', undefined, sessionId),
		);
	}

	// -- bookkeeping -------------------------------------------------------------------------------

	#recordTarget(info: CdpTargetInfo): TargetRecord {
		const existing = this.#targets.get(info.targetId);
		if (existing !== undefined) {
			existing.type = info.type;
			existing.url = info.url;
			existing.title = info.title;
			return existing;
		}
		const record: TargetRecord = {
			targetId: info.targetId,
			type: info.type,
			url: info.url,
			title: info.title,
			sequence: ++this.#sequence,
		};
		this.#targets.set(info.targetId, record);
		return record;
	}

	#recordSession(sessionId: SessionId, targetId: TargetId, type: string): CdpSessionRecord {
		const existing = this.#sessions.get(sessionId);
		if (existing !== undefined) return existing;
		const record: CdpSessionRecord = { sessionId, targetId, type, sequence: ++this.#sequence };
		this.#sessions.set(sessionId, record);
		this.#sessionTargets.set(sessionId, targetId);
		const set = this.#targetSessions.get(targetId) ?? new Set<SessionId>();
		set.add(sessionId);
		this.#targetSessions.set(targetId, set);
		if (!this.#lifecycle.has(targetId)) this.#lifecycle.set(targetId, new RingBuffer(LIFECYCLE_RING_CAPACITY));
		return record;
	}

	async #announce(info: CdpTargetInfo): Promise<void> {
		if (info.type !== PAGE_TARGET_TYPE || this.#announced.has(info.targetId)) return;
		this.#announced.add(info.targetId);
		await this.#bus.dispatch(new TabCreatedEvent({ targetId: info.targetId, url: info.url }));
	}

	#recordLifecycle(params: CdpLifecycleParams, sessionId: SessionId | undefined): void {
		if (sessionId === undefined) return;
		const targetId = this.#sessionTargets.get(sessionId);
		if (targetId === undefined) return;
		const buffer = this.#lifecycle.get(targetId) ?? new RingBuffer<LifecycleRecord>(LIFECYCLE_RING_CAPACITY);
		this.#lifecycle.set(targetId, buffer);
		buffer.push({
			name: params.name,
			loaderId: params.loaderId ?? null,
			frameId: params.frameId,
			timestamp: params.timestamp,
			receivedAt: this.#now(),
		});
	}

	#firstSessionFor(targetId: TargetId): CdpSessionRecord | null {
		for (const sessionId of this.#targetSessions.get(targetId) ?? []) {
			const record = this.#sessions.get(sessionId);
			if (record !== undefined) return record;
		}
		return null;
	}

	async #waitForAttachEvent(sessionId: SessionId): Promise<CdpSessionRecord | null> {
		const deadline = this.#now() + this.#attachWaitMs;
		for (;;) {
			const record = this.#sessions.get(sessionId);
			if (record !== undefined) return record;
			const remaining = deadline - this.#now();
			if (remaining <= 0) return null;
			await delay(Math.min(ATTACH_POLL_INTERVAL_MS, remaining));
		}
	}

	#resolveTargetId(explicit: TargetId | null): TargetId {
		if (explicit !== null && explicit.length > 0) return explicit;
		if (this.#focusTargetId !== null) return this.#focusTargetId;
		const candidate = this.mostRecentPageTarget();
		if (candidate === null) {
			throw new BrowserError('no page target is available: the browser has no tabs to talk to');
		}
		return candidate.targetId;
	}

	#assertUsable(): void {
		if (this.#stopped) throw new CdpDisconnectedError('SessionManager has been stopped');
		if (this.#client.state !== 'open') throw new CdpDisconnectedError('CDP connection is closed');
	}

	#track(promise: Promise<unknown>): void {
		this.#pending.add(promise);
		promise.then(() => {}, (error: unknown) => {
			this.#logger?.warn('session manager background task failed', { error });
		}).finally(() => this.#pending.delete(promise));
	}

	/** A per-target CDP setup call that must never take down the attach path. */
	async #safe(label: string, run: () => Promise<unknown>): Promise<void> {
		try {
			await run();
		} catch (error) {
			this.#logger?.debug('session setup call failed', { call: label, error });
		}
	}
}

function _describe(value: unknown): string {
	return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

/** A CDP protocol error's numeric code (`CdpProtocolError.code`), read structurally; `null` for anything else. */
function _cdpCode(error: unknown): number | null {
	const code = (error as { readonly code?: unknown } | null)?.code;
	return typeof code === 'number' ? code : null;
}

/**
 * The URL the filter judges a subresource or hint on — `ws:`/`wss:` read as `http:`/`https:` (the
 * matcher's navigation schemes) — or `null` when its scheme is not a network one the scope judges. An unparseable URL
 * is handed to the filter as it is, which refuses it (fail closed).
 */
function _judgedRequestUrl(url: string): string | null {
	const parsed = URL.parse(url);
	if (parsed === null) return url;
	if (!JUDGED_REQUEST_SCHEMES.includes(parsed.protocol)) return null;
	if (parsed.protocol === 'ws:') return `http:${url.slice('ws:'.length)}`;
	if (parsed.protocol === 'wss:') return `https:${url.slice('wss:'.length)}`;
	return url;
}

/**
 * How a refused request is failed. A document — and a hint that is one, the prerender host's
 * NoState prefetch — with `Aborted` (measured: the frame keeps the document it had); everything else with
 * `BlockedByClient`, which the request log reports as `net::ERR_BLOCKED_BY_CLIENT`.
 */
function _failReasonFor(kind: RequestKind, params: { readonly resourceType: string }): string {
	if (kind === 'document' || JUDGED_RESOURCE_TYPES.includes(params.resourceType)) return DOCUMENT_BLOCK_ERROR_REASON;
	return SUBRESOURCE_BLOCK_ERROR_REASON;
}

/** A URL's origin for a log line, never its path or query; `''` when unparseable. */
function _originOf(url: string): string {
	const parsed = URL.parse(url);
	if (parsed === null) return '';
	return parsed.origin === 'null' ? parsed.protocol : parsed.origin;
}
