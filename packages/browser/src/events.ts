/**
 * The browser event catalog; events live in the owning package's `events.ts`.
 *
 * Grouped as **19 command + 4 lifecycle + 8 notification + 3 error/reconnect + 4 storage +
 * 3 download + 4 misc = 45** events.
 *
 * Conventions used throughout, so the catalog reads the same way for every class:
 *
 * - Every class extends `BaseEvent<TResult>` from `@tykotech/bus`; the envelope (`eventId`,
 *   `eventParentId`, `eventCreatedAt`, `eventType`, `eventTimeout`) comes from there.
 * - `static override timeoutSec` is set **only** where an event has its own budget. The others
 *   inherit `DEFAULT_EVENT_TIMEOUT_SEC` (30 s); restating 30 on those classes would turn an
 *   inherited default into a copy that can drift, so they deliberately declare nothing.
 *   Every class stays overridable at runtime via `TIMEOUT_<EventClassName>`.
 * - Constructors take a single init object. Positional argument lists across dozens of classes
 *   with optional trailing fields are exactly the "easy to get wrong" API the house style rejects.
 * - Optional fields (`timeoutMs?`, `clip?`, …) are stored as `T | null` with a `null` default,
 *   the same rule `@tykotech/bus` follows for its envelope.
 *
 * The module footer calls `registerEvents(...)`, which is the import-time uniqueness +
 * non-substring assertion of the bus's event-name registry.
 */

import { BaseEvent, type EventClass, registerEvents } from '@tykotech/bus';
import type { TargetId } from '@tykotech/cdp';
import type { EnhancedDomTreeNode } from './dom/types.ts';
import type {
	BrowserLaunchResult,
	BrowserProfileInit,
	BrowserStartResult,
	BrowserStateSummary,
	DialogType,
	DownloadState,
	MouseButton,
	ScreenshotClip,
	ScrollDirection,
	WaitUntil,
} from './types.ts';

// ---------------------------------------------------------------------------------------------
// ElementSelectedEvent — the serializable-node base
// ---------------------------------------------------------------------------------------------

/**
 * Deep-copies `node` with its circular references nulled: `parentNode`, `childrenNodes`,
 * `contentDocument`, `axNode`, `snapshotNode` (nothing serialized may carry a cyclic node graph).
 *
 * `childrenNodes` is typed `EnhancedDomTreeNode[]` and cannot literally hold `null`, so it is
 * cleared to `[]`. `shadowRoots` is a second cycle path (a shadow root's `parentNode` points back
 * at its host), so each entry is sanitized recursively instead of being dropped: the result keeps
 * the shadow content and is still acyclic. Scalar and record fields are copied, so mutating the event's node never touches the
 * live DOM IR.
 */
export function sanitizeNodeForEvent(node: EnhancedDomTreeNode): EnhancedDomTreeNode {
	return sanitizeNode(node, new WeakSet<EnhancedDomTreeNode>());
}

function sanitizeNode(node: EnhancedDomTreeNode, seen: WeakSet<EnhancedDomTreeNode>): EnhancedDomTreeNode {
	const revisited = seen.has(node);
	seen.add(node);
	return {
		nodeId: node.nodeId,
		backendNodeId: node.backendNodeId,
		nodeType: node.nodeType,
		nodeName: node.nodeName,
		nodeValue: node.nodeValue,
		attributes: { ...node.attributes },
		isScrollable: node.isScrollable,
		isVisible: node.isVisible,
		absolutePosition: node.absolutePosition === null ? null : { ...node.absolutePosition },
		targetId: node.targetId,
		frameId: node.frameId,
		sessionId: node.sessionId,
		// The five circular references, nulled.
		parentNode: null,
		childrenNodes: [],
		contentDocument: null,
		axNode: null,
		snapshotNode: null,
		shadowRootType: node.shadowRootType,
		// Recursively sanitized rather than nulled; `revisited` breaks a pathological self-reference.
		shadowRoots: node.shadowRoots === null || revisited
			? null
			: node.shadowRoots.map((root) => sanitizeNode(root, seen)),
		compoundChildren: node.compoundChildren.map((entry) => ({ ...entry })),
		hasJsClickListener: node.hasJsClickListener,
		hiddenElementsInfo: node.hiddenElementsInfo.map((info) => ({ ...info })),
		hasHiddenContent: node.hasHiddenContent,
		uuid: node.uuid,
	};
}

/**
 * Abstract base of the element-targeted commands: `ClickElementEvent`, `TypeTextEvent`,
 * `ScrollEvent`, `UploadFileEvent`, `GetDropdownOptionsEvent`, `SelectDropdownOptionEvent`,
 * `HoverEvent` and `SendKeysEvent`.
 *
 * Its validation rule is the whole point: `node` is stored as the sanitized copy produced by
 * {@linkcode sanitizeNodeForEvent}, so the event survives `JSON.stringify` no matter how tangled the
 * live IR is. `TNode` exists only because `ScrollEvent` targets `node | null` (null = the page).
 */
export abstract class ElementSelectedEvent<
	TResult = void,
	TNode extends EnhancedDomTreeNode | null = EnhancedDomTreeNode,
> extends BaseEvent<TResult> {
	/** The cycle-stripped copy of the targeted node. */
	readonly node: TNode;

	protected constructor(node: TNode) {
		super();
		this.node = (node === null ? null : sanitizeNodeForEvent(node)) as TNode;
	}
}

// ---------------------------------------------------------------------------------------------
// Command events (agent/tools → browser): 19
// ---------------------------------------------------------------------------------------------

/** Navigate the focused tab (or a new one). Handler: BrowserSession + SecurityWatchdog pre-check. */
export class NavigateToUrlEvent extends BaseEvent<void> {
	static override timeoutSec = 30;
	readonly url: string;
	readonly waitUntil: WaitUntil;
	/** Explicit readiness cap; `null` selects the 3 s same-domain / 8 s cross-domain heuristic. */
	readonly timeoutMs: number | null;
	readonly newTab: boolean;

	constructor(init: { url: string; waitUntil?: WaitUntil; timeoutMs?: number | null; newTab?: boolean }) {
		super();
		this.url = init.url;
		this.waitUntil = init.waitUntil ?? 'load';
		this.timeoutMs = init.timeoutMs ?? null;
		this.newTab = init.newTab ?? false;
	}
}

/**
 * Click an element. Result carries `clickX`/`clickY` and download info. Handler: DefaultAction.
 *
 * `clickCount` is settable so a tool can produce a `dblclick`: what a human does through the Live
 * View socket must be reproducible by the tools. {@linkcode dispatchMouseClick} carries it on both
 * the press and the release. The field is 1..3 and the handler ramps it — see
 * `DefaultActionWatchdog.#clickNode`.
 */
export class ClickElementEvent extends ElementSelectedEvent<Record<string, unknown> | null> {
	static override timeoutSec = 15;
	readonly button: MouseButton;
	/** 1 for a single click, 2 for a double click. Clamped to 1..3 by the handler's ramp. */
	readonly clickCount: number;

	constructor(init: { node: EnhancedDomTreeNode; button?: MouseButton; clickCount?: number }) {
		super(init.node);
		this.button = init.button ?? 'left';
		this.clickCount = init.clickCount ?? 1;
	}
}

/**
 * Click raw viewport coordinates (the coordinate `click` variant).
 *
 * `button` defaults to `'left'`, as on `ClickElementEvent`: a required `button` on one click
 * sibling and a defaulted one on the other would be a footgun.
 */
export class ClickCoordinateEvent extends BaseEvent<Record<string, unknown>> {
	static override timeoutSec = 15;
	readonly coordinateX: number;
	readonly coordinateY: number;
	readonly button: MouseButton;
	/** Skips the occlusion check. */
	readonly force: boolean;
	/** 1 for a single click, 2 for a double click. */
	readonly clickCount: number;

	constructor(
		init: { coordinateX: number; coordinateY: number; button?: MouseButton; force?: boolean; clickCount?: number },
	) {
		super();
		this.coordinateX = init.coordinateX;
		this.coordinateY = init.coordinateY;
		this.button = init.button ?? 'left';
		this.force = init.force ?? false;
		this.clickCount = init.clickCount ?? 1;
	}
}

/**
 * Move the pointer onto an element, or to a raw viewport point, without pressing anything
 * (`browser_hover`).
 *
 * A hover is its own event because clicking is a different gesture with different consequences:
 * `dispatchMouseClick` opens with exactly this `mouseMoved` and then presses. `node: null` means
 * "the raw point", the same shape {@linkcode ScrollEvent} uses for "the page rather than an
 * element", so the hover is one event class rather than an element/coordinate pair.
 * The element arm reuses the click cascade's own geometry (scroll into view, viewport metrics,
 * `resolveClickPoint`), so a hover lands where a click on the same index would have landed.
 */
export class HoverEvent extends ElementSelectedEvent<Record<string, unknown>, EnhancedDomTreeNode | null> {
	static override timeoutSec = 15;
	/** Used only when `node` is null. */
	readonly coordinateX: number;
	readonly coordinateY: number;

	constructor(init: { node?: EnhancedDomTreeNode | null; coordinateX?: number; coordinateY?: number }) {
		super(init.node ?? null);
		this.coordinateX = init.coordinateX ?? 0;
		this.coordinateY = init.coordinateY ?? 0;
	}
}

/** Type into an element. Result carries `inputX`/`inputY` and `actualValue?`. */
export class TypeTextEvent extends ElementSelectedEvent<Record<string, unknown> | null> {
	static override timeoutSec = 60;
	readonly text: string;
	readonly clear: boolean;
	/** `true` only when the text came from `sensitiveData`; drives log/history redaction. */
	readonly isSensitive: boolean;
	/** The `<secret>key</secret>` name the text was substituted from, for redacted messages. */
	readonly sensitiveKeyName: string | null;

	constructor(init: {
		node: EnhancedDomTreeNode;
		text: string;
		clear?: boolean;
		isSensitive?: boolean;
		sensitiveKeyName?: string | null;
	}) {
		super(init.node);
		this.text = init.text;
		this.clear = init.clear ?? true;
		this.isSensitive = init.isSensitive ?? false;
		this.sensitiveKeyName = init.sensitiveKeyName ?? null;
	}
}

/** Scroll the page or one element. `node: null` means the page gesture. */
export class ScrollEvent extends ElementSelectedEvent<void, EnhancedDomTreeNode | null> {
	static override timeoutSec = 8;
	readonly direction: ScrollDirection;
	/** Pixels. */
	readonly amount: number;

	constructor(init: { direction: ScrollDirection; amount: number; node?: EnhancedDomTreeNode | null }) {
		super(init.node ?? null);
		this.direction = init.direction;
		this.amount = init.amount;
	}
}

/** Focus another tab. `targetId: null` selects the most recent page. Result: the focused TargetID. */
export class SwitchTabEvent extends BaseEvent<TargetId> {
	static override timeoutSec = 10;
	readonly targetId: TargetId | null;

	constructor(init: { targetId?: TargetId | null } = {}) {
		super();
		this.targetId = init.targetId ?? null;
	}
}

/** Close one tab. AboutBlankWatchdog guarantees the browser never reaches zero tabs. */
export class CloseTabEvent extends BaseEvent<void> {
	static override timeoutSec = 10;
	readonly targetId: TargetId;

	constructor(init: { targetId: TargetId }) {
		super();
		this.targetId = init.targetId;
	}
}

/** Capture a PNG. Result is base64 (no data-URI prefix). Handler: ScreenshotWatchdog. */
export class ScreenshotEvent extends BaseEvent<string> {
	static override timeoutSec = 15;
	readonly fullPage: boolean;
	readonly clip: ScreenshotClip | null;

	constructor(init: { fullPage?: boolean; clip?: ScreenshotClip | null } = {}) {
		super();
		this.fullPage = init.fullPage ?? false;
		this.clip = init.clip ?? null;
	}
}

/** Build the agent-visible browser state. Handler: DOMWatchdog (+ DownloadsWatchdog side handler). */
export class BrowserStateRequestEvent extends BaseEvent<BrowserStateSummary> {
	static override timeoutSec = 30;
	readonly includeDom: boolean;
	readonly includeScreenshot: boolean;
	readonly includeRecentEvents: boolean;
	/** Index offscreen-but-rendered elements too (`browser_get_state {include_hidden}`). */
	readonly includeOffscreen: boolean;

	constructor(
		init: {
			includeDom?: boolean;
			includeScreenshot?: boolean;
			includeRecentEvents?: boolean;
			includeOffscreen?: boolean;
		} = {},
	) {
		super();
		this.includeDom = init.includeDom ?? true;
		this.includeScreenshot = init.includeScreenshot ?? true;
		this.includeRecentEvents = init.includeRecentEvents ?? false;
		this.includeOffscreen = init.includeOffscreen ?? false;
	}
}

/** Back in the navigation history. */
export class GoBackEvent extends BaseEvent<void> {
	static override timeoutSec = 15;
}

/** Forward in the navigation history. */
export class GoForwardEvent extends BaseEvent<void> {
	static override timeoutSec = 15;
}

/** Reload the focused tab. */
export class RefreshEvent extends BaseEvent<void> {
	static override timeoutSec = 15;
}

/** Deliberate wait. The handler clamps `seconds` against `maxSeconds`. */
export class WaitEvent extends BaseEvent<void> {
	static override timeoutSec = 60;
	readonly seconds: number;
	readonly maxSeconds: number;

	constructor(init: { seconds?: number; maxSeconds?: number } = {}) {
		super();
		this.seconds = init.seconds ?? 3;
		this.maxSeconds = init.maxSeconds ?? 10;
	}
}

/**
 * Send a key or combo, e.g. `'ctrl+a'`, `'Enter'`.
 *
 * `node` is optional and, when given, focused before the first combo, so `browser_press_key` can aim
 * a chord at a *named element* without clicking it first — a click would fire that element's own
 * handlers as a side effect of pressing a key. `null` sends to whatever holds focus, the same "null
 * means the session rather than an element" shape {@linkcode ScrollEvent} carries.
 */
export class SendKeysEvent extends ElementSelectedEvent<void, EnhancedDomTreeNode | null> {
	static override timeoutSec = 60;
	readonly keys: string;

	constructor(init: { keys: string; node?: EnhancedDomTreeNode | null }) {
		super(init.node ?? null);
		this.keys = init.keys;
	}
}

/** Set a file input's files (`DOM.setFileInputFiles`). Path authorization happens in the action. */
export class UploadFileEvent extends ElementSelectedEvent<void> {
	static override timeoutSec = 30;
	readonly filePath: string;

	constructor(init: { node: EnhancedDomTreeNode; filePath: string }) {
		super(init.node);
		this.filePath = init.filePath;
	}
}

/** Inspect a dropdown. Result keys are `shortTermMemory` / `longTermMemory`. */
export class GetDropdownOptionsEvent extends ElementSelectedEvent<Record<string, string>> {
	static override timeoutSec = 15;

	constructor(init: { node: EnhancedDomTreeNode }) {
		super(init.node);
	}
}

/** Select a dropdown option by exact text/value. Failure returns options as data, never a throw. */
export class SelectDropdownOptionEvent extends ElementSelectedEvent<Record<string, string>> {
	static override timeoutSec = 8;
	readonly text: string;

	constructor(init: { node: EnhancedDomTreeNode; text: string }) {
		super(init.node);
		this.text = init.text;
	}
}

/** Scroll to visible text (`DOM.performSearch` + fallback). The handler throws when not found. */
export class ScrollToTextEvent extends BaseEvent<void> {
	static override timeoutSec = 15;
	readonly text: string;
	readonly direction: ScrollDirection | null;

	constructor(init: { text: string; direction?: ScrollDirection | null }) {
		super();
		this.text = init.text;
		this.direction = init.direction ?? null;
	}
}

// ---------------------------------------------------------------------------------------------
// Lifecycle commands: 4
// ---------------------------------------------------------------------------------------------

/** Start the session: launch or attach, converging on one `connect(cdpUrl)` path. */
export class BrowserStartEvent extends BaseEvent<BrowserStartResult> {
	static override timeoutSec = 30;
	/** Attach to this endpoint instead of launching. */
	readonly cdpUrl: string | null;
	/** Per-start profile overrides applied on top of the session's `BrowserProfile`. */
	readonly launchOptions: BrowserProfileInit | null;

	constructor(init: { cdpUrl?: string | null; launchOptions?: BrowserProfileInit | null } = {}) {
		super();
		this.cdpUrl = init.cdpUrl ?? null;
		this.launchOptions = init.launchOptions ?? null;
	}
}

/** Stop the session. Handled by BrowserSession, LocalBrowser, StorageState, AboutBlank, Recording. */
export class BrowserStopEvent extends BaseEvent<void> {
	static override timeoutSec = 45;
	/** Skips graceful teardown (`keepAlive` is ignored). */
	readonly force: boolean;

	constructor(init: { force?: boolean } = {}) {
		super();
		this.force = init.force ?? false;
	}
}

/** Spawn the local browser subprocess. Handler: LocalBrowserWatchdog. */
export class BrowserLaunchEvent extends BaseEvent<BrowserLaunchResult> {
	static override timeoutSec = 30;
}

/** Kill the local browser subprocess (SIGTERM → 5 s → SIGKILL, temp-dir cleanup). */
export class BrowserKillEvent extends BaseEvent<void> {
	static override timeoutSec = 30;
}

// ---------------------------------------------------------------------------------------------
// Notifications (browser → everyone): 8
// ---------------------------------------------------------------------------------------------

/** The CDP socket is open. Consumers: Permissions, StorageState, Recording, HarRecording, Captcha. */
export class BrowserConnectedEvent extends BaseEvent<void> {
	readonly cdpUrl: string;

	constructor(init: { cdpUrl: string }) {
		super();
		this.cdpUrl = init.cdpUrl;
	}
}

/** The session stopped. Consumers: AboutBlank, Downloads, Captcha. */
export class BrowserStoppedEvent extends BaseEvent<void> {
	readonly reason: string;

	constructor(init: { reason: string }) {
		super();
		this.reason = init.reason;
	}
}

/** A page target appeared. Consumers: session (viewport), AboutBlank, Popups, Downloads, Security, DOM. */
export class TabCreatedEvent extends BaseEvent<void> {
	readonly targetId: TargetId;
	readonly url: string;

	constructor(init: { targetId: TargetId; url: string }) {
		super();
		this.targetId = init.targetId;
		this.url = init.url;
	}
}

/** A page target was fully removed. Consumers: session (focus fixup), AboutBlank. */
export class TabClosedEvent extends BaseEvent<void> {
	static override timeoutSec = 3;
	readonly targetId: TargetId;

	constructor(init: { targetId: TargetId }) {
		super();
		this.targetId = init.targetId;
	}
}

/** The agent's current tab changed. Consumers: session (cache clear + viewport), Recording. */
export class AgentFocusChangedEvent extends BaseEvent<void> {
	static override timeoutSec = 10;
	readonly targetId: TargetId;
	readonly url: string;

	constructor(init: { targetId: TargetId; url: string }) {
		super();
		this.targetId = init.targetId;
		this.url = init.url;
	}
}

/** A target crashed. Defined; in practice crash paths dispatch `BrowserErrorEvent`. */
export class TargetCrashedEvent extends BaseEvent<void> {
	static override timeoutSec = 10;
	readonly targetId: TargetId;
	readonly error: string;

	constructor(init: { targetId: TargetId; error: string }) {
		super();
		this.targetId = init.targetId;
		this.error = init.error;
	}
}

/** Emitted by the session immediately before `Page.navigate`. */
export class NavigationStartedEvent extends BaseEvent<void> {
	readonly targetId: TargetId;
	readonly url: string;

	constructor(init: { targetId: TargetId; url: string }) {
		super();
		this.targetId = init.targetId;
		this.url = init.url;
	}
}

/**
 * Navigation finished. Consumers: Security (redirect check), Downloads (PDF auto-download).
 *
 * `loadingStatus` is non-null exactly when readiness timed out — a non-fatal outcome carrying
 * `'timeout after Xs waiting for <level> (saw: …)'` so the agent sees a slow page, not an error.
 */
export class NavigationCompleteEvent extends BaseEvent<void> {
	readonly targetId: TargetId;
	readonly url: string;
	/** HTTP status of the main resource, when the transport reported one. */
	readonly status: number | null;
	readonly errorMessage: string | null;
	readonly loadingStatus: string | null;

	constructor(init: {
		targetId: TargetId;
		url: string;
		status?: number | null;
		errorMessage?: string | null;
		loadingStatus?: string | null;
	}) {
		super();
		this.targetId = init.targetId;
		this.url = init.url;
		this.status = init.status ?? null;
		this.errorMessage = init.errorMessage ?? null;
		this.loadingStatus = init.loadingStatus ?? null;
	}
}

// ---------------------------------------------------------------------------------------------
// Error / reconnect: 3 (all inherit the bus default timeout)
// ---------------------------------------------------------------------------------------------

/** Structured browser-layer failure, e.g. `'NavigationBlocked'`, `'ReconnectionFailed'`. */
export class BrowserErrorEvent extends BaseEvent<void> {
	readonly errorType: string;
	readonly message: string;
	readonly details: Record<string, unknown>;

	constructor(init: { errorType: string; message: string; details?: Record<string, unknown> }) {
		super();
		this.errorType = init.errorType;
		this.message = init.message;
		this.details = init.details ?? {};
	}
}

/** One reconnect attempt is starting (3 attempts, 1 s/2 s/4 s backoff). */
export class BrowserReconnectingEvent extends BaseEvent<void> {
	readonly cdpUrl: string;
	readonly attempt: number;
	readonly maxAttempts: number;

	constructor(init: { cdpUrl: string; attempt: number; maxAttempts: number }) {
		super();
		this.cdpUrl = init.cdpUrl;
		this.attempt = init.attempt;
		this.maxAttempts = init.maxAttempts;
	}
}

/** The socket is back; blocked handlers may proceed. */
export class BrowserReconnectedEvent extends BaseEvent<void> {
	readonly cdpUrl: string;
	readonly attempt: number;
	readonly downtimeSeconds: number;

	constructor(init: { cdpUrl: string; attempt: number; downtimeSeconds: number }) {
		super();
		this.cdpUrl = init.cdpUrl;
		this.attempt = init.attempt;
		this.downtimeSeconds = init.downtimeSeconds;
	}
}

// ---------------------------------------------------------------------------------------------
// Storage state: 4
// ---------------------------------------------------------------------------------------------

/** Persist cookies + origins. `path: null` uses the profile's `storageState` path. */
export class SaveStorageStateEvent extends BaseEvent<void> {
	static override timeoutSec = 45;
	readonly path: string | null;

	constructor(init: { path?: string | null } = {}) {
		super();
		this.path = init.path ?? null;
	}
}

/** Load cookies + origins before the first navigation. */
export class LoadStorageStateEvent extends BaseEvent<void> {
	static override timeoutSec = 45;
	readonly path: string | null;

	constructor(init: { path?: string | null } = {}) {
		super();
		this.path = init.path ?? null;
	}
}

/** Storage state was written (atomic `.tmp`/`.bak` write completed). */
export class StorageStateSavedEvent extends BaseEvent<void> {
	readonly path: string;
	readonly cookiesCount: number;
	readonly originsCount: number;

	constructor(init: { path: string; cookiesCount: number; originsCount: number }) {
		super();
		this.path = init.path;
		this.cookiesCount = init.cookiesCount;
		this.originsCount = init.originsCount;
	}
}

/** Storage state was applied to the browser. */
export class StorageStateLoadedEvent extends BaseEvent<void> {
	readonly path: string;
	readonly cookiesCount: number;
	readonly originsCount: number;

	constructor(init: { path: string; cookiesCount: number; originsCount: number }) {
		super();
		this.path = init.path;
		this.cookiesCount = init.cookiesCount;
		this.originsCount = init.originsCount;
	}
}

// ---------------------------------------------------------------------------------------------
// Downloads: 3
// ---------------------------------------------------------------------------------------------

/** `Browser.downloadWillBegin` re-broadcast. */
export class DownloadStartedEvent extends BaseEvent<void> {
	static override timeoutSec = 5;
	readonly guid: string;
	readonly url: string;
	readonly suggestedFilename: string;
	/** `true` when the PDF/attachment sniffer started this download rather than a click. */
	readonly autoDownload: boolean;

	constructor(init: { guid: string; url: string; suggestedFilename: string; autoDownload?: boolean }) {
		super();
		this.guid = init.guid;
		this.url = init.url;
		this.suggestedFilename = init.suggestedFilename;
		this.autoDownload = init.autoDownload ?? false;
	}
}

/** `Browser.downloadProgress` re-broadcast. `totalBytes` is 0 while the size is unknown. */
export class DownloadProgressEvent extends BaseEvent<void> {
	static override timeoutSec = 5;
	readonly guid: string;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly state: DownloadState;

	constructor(init: { guid: string; receivedBytes: number; totalBytes: number; state: DownloadState }) {
		super();
		this.guid = init.guid;
		this.receivedBytes = init.receivedBytes;
		this.totalBytes = init.totalBytes;
		this.state = init.state;
	}
}

/**
 * A download finished and is available. Remote browsers never touch the local filesystem: the path
 * is synthesized and `fileSize` is 0.
 */
export class FileDownloadedEvent extends BaseEvent<void> {
	static override timeoutSec = 30;
	/** Absent for downloads that were never tracked through `Browser.downloadWillBegin`. */
	readonly guid: string | null;
	readonly url: string;
	readonly path: string;
	readonly fileName: string;
	readonly fileSize: number;
	/** Extension-derived kind, e.g. `'pdf'`. */
	readonly fileType: string | null;
	readonly mimeType: string | null;
	readonly fromCache: boolean;
	readonly autoDownload: boolean;

	constructor(init: {
		url: string;
		path: string;
		fileName: string;
		fileSize: number;
		guid?: string | null;
		fileType?: string | null;
		mimeType?: string | null;
		fromCache?: boolean;
		autoDownload?: boolean;
	}) {
		super();
		this.guid = init.guid ?? null;
		this.url = init.url;
		this.path = init.path;
		this.fileName = init.fileName;
		this.fileSize = init.fileSize;
		this.fileType = init.fileType ?? null;
		this.mimeType = init.mimeType ?? null;
		this.fromCache = init.fromCache ?? false;
		this.autoDownload = init.autoDownload ?? false;
	}
}

// ---------------------------------------------------------------------------------------------
// Misc: 4
// ---------------------------------------------------------------------------------------------

/** Cosmetic about:blank animation was injected (optional feature). */
export class AboutBlankDVDScreensaverShownEvent extends BaseEvent<void> {
	readonly targetId: TargetId;
	/** Injection failure text; non-fatal by construction. */
	readonly error: string | null;

	constructor(init: { targetId: TargetId; error?: string | null }) {
		super();
		this.targetId = init.targetId;
		this.error = init.error ?? null;
	}
}

/** A JS dialog opened. PopupsWatchdog records `"[type] message"` and accepts/dismisses it. */
export class DialogOpenedEvent extends BaseEvent<void> {
	readonly dialogType: DialogType;
	readonly message: string;
	readonly url: string;
	readonly frameId: string | null;
	/**
	 * The id `browser_handle_dialog` answers by.
	 *
	 * The id makes the announcement *addressable*, so a consumer can choose how a dialog is answered
	 * rather than only learn how the watchdog answered it: while manual handling is armed the watchdog
	 * holds the dialog open under this id until a caller answers it or the hold expires. Empty string
	 * on the automatic path.
	 */
	readonly dialogId: string;

	constructor(
		init: { dialogType: DialogType; message: string; url: string; frameId?: string | null; dialogId?: string },
	) {
		super();
		this.dialogType = init.dialogType;
		this.message = init.message;
		this.url = init.url;
		this.frameId = init.frameId ?? null;
		this.dialogId = init.dialogId ?? '';
	}
}

/**
 * Vendor `BrowserUse.captchaSolver*` CDP event re-broadcast (cloud proxy browsers only).
 *
 * `startedAt`/`finishedAt` are ISO-8601 strings, matching the envelope's `eventCreatedAt` — one
 * timestamp spelling per wire surface beats mixing epoch numbers into event payloads.
 */
export class CaptchaSolverStartedEvent extends BaseEvent<void> {
	static override timeoutSec = 5;
	readonly targetId: TargetId;
	readonly vendor: string;
	readonly url: string;
	/** ISO-8601. */
	readonly startedAt: string;

	constructor(init: { targetId: TargetId; vendor: string; url: string; startedAt: string }) {
		super();
		this.targetId = init.targetId;
		this.vendor = init.vendor;
		this.url = init.url;
		this.startedAt = init.startedAt;
	}
}

/** Vendor captcha solve finished; `waitIfCaptchaSolving()` resolves off this. */
export class CaptchaSolverFinishedEvent extends BaseEvent<void> {
	static override timeoutSec = 5;
	readonly targetId: TargetId;
	readonly vendor: string | null;
	readonly url: string | null;
	readonly durationMs: number;
	/** ISO-8601, like `CaptchaSolverStartedEvent.startedAt`. */
	readonly finishedAt: string;
	readonly success: boolean;

	constructor(init: {
		targetId: TargetId;
		durationMs: number;
		finishedAt: string;
		success: boolean;
		vendor?: string | null;
		url?: string | null;
	}) {
		super();
		this.targetId = init.targetId;
		this.vendor = init.vendor ?? null;
		this.url = init.url ?? null;
		this.durationMs = init.durationMs;
		this.finishedAt = init.finishedAt;
		this.success = init.success;
	}
}

// ---------------------------------------------------------------------------------------------
// Catalog + registration (the import-time uniqueness / non-substring assertion)
// ---------------------------------------------------------------------------------------------

/** The 19 result-bearing commands dispatched by Tools handlers and BrowserSession. */
export const COMMAND_EVENTS: readonly EventClass[] = [
	NavigateToUrlEvent,
	ClickElementEvent,
	ClickCoordinateEvent,
	HoverEvent,
	TypeTextEvent,
	ScrollEvent,
	SwitchTabEvent,
	CloseTabEvent,
	ScreenshotEvent,
	BrowserStateRequestEvent,
	GoBackEvent,
	GoForwardEvent,
	RefreshEvent,
	WaitEvent,
	SendKeysEvent,
	UploadFileEvent,
	GetDropdownOptionsEvent,
	SelectDropdownOptionEvent,
	ScrollToTextEvent,
];

/** 4 lifecycle commands. */
export const LIFECYCLE_EVENTS: readonly EventClass[] = [
	BrowserStartEvent,
	BrowserStopEvent,
	BrowserLaunchEvent,
	BrowserKillEvent,
];

/** 8 notifications. */
export const NOTIFICATION_EVENTS: readonly EventClass[] = [
	BrowserConnectedEvent,
	BrowserStoppedEvent,
	TabCreatedEvent,
	TabClosedEvent,
	AgentFocusChangedEvent,
	TargetCrashedEvent,
	NavigationStartedEvent,
	NavigationCompleteEvent,
];

/** 3 error / reconnect events. */
export const ERROR_EVENTS: readonly EventClass[] = [
	BrowserErrorEvent,
	BrowserReconnectingEvent,
	BrowserReconnectedEvent,
];

/** 4 storage-state events. */
export const STORAGE_EVENTS: readonly EventClass[] = [
	SaveStorageStateEvent,
	LoadStorageStateEvent,
	StorageStateSavedEvent,
	StorageStateLoadedEvent,
];

/** 3 download events. */
export const DOWNLOAD_EVENTS: readonly EventClass[] = [
	DownloadStartedEvent,
	DownloadProgressEvent,
	FileDownloadedEvent,
];

/** 4 misc events (all optional features). */
export const MISC_EVENTS: readonly EventClass[] = [
	AboutBlankDVDScreensaverShownEvent,
	DialogOpenedEvent,
	CaptchaSolverStartedEvent,
	CaptchaSolverFinishedEvent,
];

/**
 * The whole catalog: 19 + 4 + 8 + 3 + 4 + 3 + 4 = **45**.
 * `ElementSelectedEvent` is abstract plumbing and is deliberately not a member.
 */
export const BROWSER_EVENTS: readonly EventClass[] = [
	...COMMAND_EVENTS,
	...LIFECYCLE_EVENTS,
	...NOTIFICATION_EVENTS,
	...ERROR_EVENTS,
	...STORAGE_EVENTS,
	...DOWNLOAD_EVENTS,
	...MISC_EVENTS,
];

registerEvents(BROWSER_EVENTS);
