/**
 * Browser-layer type surface for `@tykotech/browser` (AGENTS.md §3: shared types live in `src/types.ts`).
 *
 * Contract owner: SPECS/DATA-MODEL.md §5.2 (`BrowserProfile` field surface + defaults), §5.3
 * (`BrowserStateSummary`, `PageInfo`, `NetworkRequest`), §5.4 (`TabInfo` + the 4-char `tabId`), and
 * the §5.1.7 trailing note (`CaptchaWaitResult`, consumed by AGENT-RUNTIME.md §4 Phase 0).
 *
 * This file owns **types and their defaults only**. Launch-argument composition/dedup, display
 * detection, and the storage-state read/write pipeline are behavior contracts owned by
 * `src/browser/*` and the watchdogs; nothing here touches the filesystem, the network, or `Deno.env`.
 */

import type { BrowserChannel, TargetId } from '@tykotech/cdp';
import type { SerializedDomState } from './dom/types.ts';
import type { FrameRecord } from './dom/extract_merge.ts';

// ---------------------------------------------------------------------------------------------
// Small shared unions and geometry primitives
// ---------------------------------------------------------------------------------------------

/** Navigation readiness levels accepted by `NavigateToUrlEvent` (DATA-MODEL.md §5.1.1). */
export const WAIT_UNTIL_LEVELS = ['load', 'domcontentloaded', 'networkidle', 'commit'] as const;
export type WaitUntil = (typeof WAIT_UNTIL_LEVELS)[number];

/** Mouse buttons the input synthesizer accepts (DATA-MODEL.md §5.1.1). */
export const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

/** Scroll directions (DATA-MODEL.md §5.1.1 `ScrollEvent`). */
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

/** `Browser.downloadProgress` states, re-broadcast by `DownloadProgressEvent` (§5.1.6). */
export const DOWNLOAD_STATES = ['inProgress', 'completed', 'canceled'] as const;
export type DownloadState = (typeof DOWNLOAD_STATES)[number];

/** JavaScript dialog kinds surfaced by `DialogOpenedEvent` (§5.1.7; ARCHITECTURE.md §6.4). */
export const DIALOG_TYPES = ['alert', 'confirm', 'prompt', 'beforeunload'] as const;
export type DialogType = (typeof DIALOG_TYPES)[number];

/** Outcome vocabulary of {@linkcode CaptchaWaitResult} (DATA-MODEL.md §5.1.7). */
export const CAPTCHA_WAIT_OUTCOMES = ['success', 'failed', 'timeout', 'unknown'] as const;
export type CaptchaWaitOutcome = (typeof CAPTCHA_WAIT_OUTCOMES)[number];

/** CSS-pixel size, used for viewport/screen/window/video dimensions (DATA-MODEL.md §5.2). */
export interface ViewportSize {
	width: number;
	height: number;
}

/** Screen-space window origin in CSS pixels (DATA-MODEL.md §5.2). */
export interface WindowPosition {
	x: number;
	y: number;
}

/** Capture region for `ScreenshotEvent` (DATA-MODEL.md §5.1.1). */
export interface ScreenshotClip {
	x: number;
	y: number;
	width: number;
	height: number;
}

// ---------------------------------------------------------------------------------------------
// §5.2 — BrowserProfile
// ---------------------------------------------------------------------------------------------

/** Proxy configuration; credentials are answered over CDP `Fetch` auth (DATA-MODEL.md §5.2). */
export interface ProxySettings {
	server: string;
	bypass?: string;
	username?: string;
	password?: string;
}

/**
 * One cookie in Playwright storage-state format (DATA-MODEL.md §5.2, §9 R9.2).
 *
 * ERRATUM(M1-events-types-4): §5.2 names the format ("Playwright format") but never enumerates the
 * cookie fields; these are the documented Playwright/CDP field names, kept verbatim because the file
 * is an external interop contract, not internal state.
 */
export interface Cookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** Unix seconds; `-1` marks a session cookie. */
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: 'Strict' | 'Lax' | 'None';
}

/** One `origin` entry of a storage-state document (DATA-MODEL.md §5.2). */
export interface StorageOriginState {
	origin: string;
	localStorage: { name: string; value: string }[];
	sessionStorage: { name: string; value: string }[];
}

/** Playwright-format storage state; round-trip rules in DATA-MODEL.md §9 R9.2. */
export interface StorageState {
	cookies: Cookie[];
	origins: StorageOriginState[];
}

/** HAR body-capture modes (DATA-MODEL.md §5.2 "Observation / recording"). See ERRATUM 4. */
export const RECORD_HAR_CONTENT_MODES = ['embed', 'attach', 'omit'] as const;
export type RecordHarContent = (typeof RECORD_HAR_CONTENT_MODES)[number];

/** HAR verbosity modes (DATA-MODEL.md §5.2). See ERRATUM 4. */
export const RECORD_HAR_MODES = ['full', 'minimal'] as const;
export type RecordHarMode = (typeof RECORD_HAR_MODES)[number];

/**
 * ERRATUM(E-114): the values of {@linkcode BrowserProfile.requestScope} — `TTK_ALLOWED_DOMAINS_SCOPE` once it reaches
 * the vendored profile (D-138).
 */
export const REQUEST_SCOPES = ['documents', 'all'] as const;
export type RequestScope = (typeof REQUEST_SCOPES)[number];

/**
 * The full `BrowserProfile` field surface (DATA-MODEL.md §5.2). Unknown extra fields are ignored,
 * so callers hand in a {@linkcode BrowserProfileInit} and get every default filled by
 * {@linkcode createBrowserProfile}.
 *
 * Fields whose spec default is "resolved later" (display detection, temp-dir allocation, docker
 * probing) are `null` here: `null` means *unresolved*, and resolution is the launcher's job, not the
 * type's. The three viewport invariants of §5.2 (`noViewport ⇒ viewport === null`; viewport mode ⇒
 * `deviceScaleFactor ≥ 1`; never `headless ∧ noViewport`) are therefore enforced by the resolver in
 * `src/browser/`, not by this declaration.
 */
export interface BrowserProfile {
	// ---- connection ----
	/** Attach mode when set (D-BROWSER1). */
	cdpUrl: string | null;
	/** `null` = infer via {@linkcode resolveIsLocal}: local iff no `cdpUrl` and not cloud. */
	isLocal: boolean | null;
	/** Extra HTTP headers for the CDP handshake. */
	headers: Record<string, string> | null;
	/** Opt-in cloud browser connector (D-OBS1 posture: off unless asked for). */
	useCloud: boolean;
	cloudBrowserParams: Record<string, unknown> | null;

	// ---- launch ----
	/** Explicit binary; otherwise per-OS discovery runs (D-BROWSER1). */
	executablePath: string | null;
	/** `null` → chromium. */
	channel: BrowserChannel | null;
	/** `null` = auto: headful iff a display exists. */
	headless: boolean | null;
	/** Extra launch args; each MUST start with `--`. */
	args: string[];
	/** `true` drops every default arg; an array drops the named ones. See ERRATUM 3. */
	ignoreDefaultArgs: string[] | true;
	/** `null` inherits the parent environment. */
	env: Record<string, string> | null;
	/** Spec default is `!IN_DOCKER`; the docker probe is applied by the launcher. See ERRATUM 3. */
	chromiumSandbox: boolean;
	/** Asserted incompatible with `headless` by the launcher. */
	devtools: boolean;
	/** `null` = allocate a unique temp dir at start (auto-created). See ERRATUM 3. */
	downloadsPath: string | null;
	tracesDir: string | null;
	/** `null` → a fresh temp profile dir. Real Chrome profiles are copied, never locked. */
	userDataDir: string | null;
	profileDirectory: string;
	/** uBlock Origin Lite, cookie handler, force-background-tab. */
	enableDefaultExtensions: boolean;
	/** Patched into the bundled cookie-handler extension. */
	cookieWhitelistDomains: string[];

	// ---- display / viewport ----
	windowSize: ViewportSize | null;
	windowPosition: WindowPosition | null;
	/** `null` until display detection resolves it. */
	viewport: ViewportSize | null;
	/** `null` until display detection resolves it. */
	screen: ViewportSize | null;
	/** `null` until display detection resolves it. */
	noViewport: boolean | null;
	/** Setting it forces viewport mode (and then MUST be ≥ 1). */
	deviceScaleFactor: number | null;
	userAgent: string | null;

	// ---- security / domains ----
	/** Allowed takes precedence over prohibited (SECURITY-AUTH.md §4.1 owns the matcher). */
	allowedDomains: string[] | null;
	prohibitedDomains: string[] | null;
	/** IPv4/IPv6 including exotic encodings. */
	blockIpAddresses: boolean;
	/**
	 * ERRATUM(E-114): which requests the pre-request veto judges once `allowedDomains` arms it (D-138). `documents`
	 * (the default) is E-94's document veto plus the hints of ERRATUM(E-115); `all` judges every http(s)/ws(s) request
	 * of every target but `worker` (whose requests pause on the owning page) — subresources, beacons, workers'
	 * fetches, service workers — and refuses the off-list ones before they are sent. Without an allowlist it is inert.
	 */
	requestScope: RequestScope;
	disableSecurity: boolean;
	/** CDP `Browser.PermissionType` values, granted browser-wide on connect. */
	permissions: string[];
	/** Default `true` — gate ruling I-11; conformance tests pin `true`. */
	crossOriginIframes: boolean;
	/** DOM-capture caps (DATA-MODEL.md §6). */
	maxIframes: number;
	maxIframeDepth: number;

	// ---- proxy ----
	proxy: ProxySettings | null;

	// ---- storage / downloads ----
	/** Path to a storage-state document, or the document itself. */
	storageState: string | StorageState | null;
	acceptDownloads: boolean;
	/** Network-sniffing PDF pipeline. */
	autoDownloadPdfs: boolean;

	// ---- timing (load-bearing; DECISION-REGISTER rule §2.5 — changes need real-browser evidence) ----
	/** Seconds. */
	minimumWaitPageLoadTime: number;
	/** Seconds. */
	waitForNetworkIdlePageLoadTime: number;
	/** Seconds. */
	waitBetweenActions: number;
	keepAlive: boolean | null;

	// ---- observation / recording (optional features) ----
	/** mp4 encoding is deferred (D-SCOPE1); screencast frames are captured. */
	recordVideoDir: string | null;
	recordVideoSize: ViewportSize | null;
	recordVideoFramerate: number;
	recordHarPath: string | null;
	recordHarContent: RecordHarContent;
	recordHarMode: RecordHarMode;
	/** Interaction flash (cosmetic). */
	highlightElements: boolean;
	/** Debug overlay; mutually exclusive with `highlightElements` — dom wins. */
	domHighlightElements: boolean;
	filterHighlightIds: boolean;
	interactionHighlightColor: string;
	/** Seconds. */
	interactionHighlightDuration: number;
	/** DATA-MODEL.md §6.3. */
	paintOrderFiltering: boolean;
	/** Vendor CDP captcha events (§5.1.7). */
	captchaSolver: boolean;
	demoMode: boolean;
	/** Cosmetic; warns. */
	deterministicRendering: boolean;
}

/** Caller-supplied profile overrides; every omitted field takes its §5.2 default. */
export type BrowserProfileInit = Partial<BrowserProfile>;

/**
 * Default value of `ignoreDefaultArgs`.
 *
 * ERRATUM(M1-events-types-3): §5.2 gives the *type* ("curated list | `true`") in the Default column
 * but never enumerates the curated list. Empty is the only non-inventing choice; the launch-arg
 * composer (`src/browser/profile.ts`) owns the membership question.
 */
export const DEFAULT_IGNORE_DEFAULT_ARGS: readonly string[] = [];

/** Cookie-handler extension whitelist (DATA-MODEL.md §5.2). */
export const DEFAULT_COOKIE_WHITELIST_DOMAINS: readonly string[] = ['nature.com', 'qatarairways.com'];

/** Browser-wide permissions granted on connect (DATA-MODEL.md §5.2; ARCHITECTURE.md §6.5). */
export const DEFAULT_BROWSER_PERMISSIONS: readonly string[] = ['clipboardReadWrite', 'notifications'];

/** A fresh profile carrying exactly the DATA-MODEL.md §5.2 defaults. Never shares mutable state. */
export function defaultBrowserProfile(): BrowserProfile {
	return {
		cdpUrl: null,
		isLocal: null,
		headers: null,
		useCloud: false,
		cloudBrowserParams: null,

		executablePath: null,
		channel: null,
		headless: null,
		args: [],
		ignoreDefaultArgs: [...DEFAULT_IGNORE_DEFAULT_ARGS],
		env: null,
		chromiumSandbox: true,
		devtools: false,
		downloadsPath: null,
		tracesDir: null,
		userDataDir: null,
		profileDirectory: 'Default',
		enableDefaultExtensions: true,
		cookieWhitelistDomains: [...DEFAULT_COOKIE_WHITELIST_DOMAINS],

		windowSize: null,
		windowPosition: { x: 0, y: 0 },
		viewport: null,
		screen: null,
		noViewport: null,
		deviceScaleFactor: null,
		userAgent: null,

		allowedDomains: null,
		prohibitedDomains: null,
		blockIpAddresses: false,
		requestScope: 'documents',
		disableSecurity: false,
		permissions: [...DEFAULT_BROWSER_PERMISSIONS],
		crossOriginIframes: true,
		maxIframes: 100,
		maxIframeDepth: 5,

		proxy: null,

		storageState: null,
		acceptDownloads: true,
		autoDownloadPdfs: true,

		minimumWaitPageLoadTime: 0.25,
		waitForNetworkIdlePageLoadTime: 0.5,
		waitBetweenActions: 0.1,
		keepAlive: null,

		recordVideoDir: null,
		recordVideoSize: null,
		recordVideoFramerate: 30,
		recordHarPath: null,
		recordHarContent: 'embed',
		recordHarMode: 'full',
		highlightElements: true,
		domHighlightElements: false,
		filterHighlightIds: true,
		interactionHighlightColor: 'rgb(255,127,39)',
		interactionHighlightDuration: 1.0,
		paintOrderFiltering: true,
		captchaSolver: true,
		demoMode: false,
		deterministicRendering: false,
	};
}

/**
 * The §5.2 defaults as a frozen reference value (documentation + conformance pinning).
 * Use {@linkcode createBrowserProfile} to get a mutable profile; this one is deliberately immutable.
 */
export const DEFAULT_BROWSER_PROFILE: Readonly<BrowserProfile> = Object.freeze(defaultBrowserProfile());

/**
 * Fills every §5.2 default that `init` does not override. Explicit `undefined` is treated as
 * "not supplied" so `{ headless: maybeFlag }` behaves the way callers expect.
 */
export function createBrowserProfile(init: BrowserProfileInit = {}): BrowserProfile {
	const profile = defaultBrowserProfile();
	const target = profile as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(init)) {
		if (value === undefined) continue;
		target[key] = value;
	}
	return profile;
}

/** `isLocal` when set explicitly, else the §5.2 inference: local iff no `cdpUrl` and not cloud. */
export function resolveIsLocal(profile: Pick<BrowserProfile, 'cdpUrl' | 'isLocal' | 'useCloud'>): boolean {
	if (profile.isLocal !== null) return profile.isLocal;
	return profile.cdpUrl === null && !profile.useCloud;
}

// ---------------------------------------------------------------------------------------------
// §5.4 — TabInfo and the 4-char tab id
// ---------------------------------------------------------------------------------------------

/** One open tab as the LLM sees it (DATA-MODEL.md §5.4). */
export interface TabInfo {
	/** Full CDP TargetID. */
	targetId: TargetId;
	/** The last {@linkcode TAB_ID_LENGTH} characters of `targetId` — the id actions carry. */
	tabId: string;
	url: string;
	title: string;
}

/** Length of the LLM-visible tab id (DATA-MODEL.md §5.4; `switch`/`close` params are exactly 4). */
export const TAB_ID_LENGTH = 4;

/** The LLM-visible tab id for a target: the last 4 characters of its `targetId`. */
export function tabIdFor(targetId: string): string {
	return targetId.slice(-TAB_ID_LENGTH);
}

/** Builds a {@linkcode TabInfo}, deriving `tabId` so the two can never drift apart. */
export function toTabInfo(target: { targetId: TargetId; url: string; title: string }): TabInfo {
	return { targetId: target.targetId, tabId: tabIdFor(target.targetId), url: target.url, title: target.title };
}

/**
 * Every target whose id ends with `tabId`. A full `targetId` matches itself, so callers may pass
 * either form. Comparison is case-sensitive: CDP target ids are upper-case hex.
 */
export function findTargetIdsByTabId(tabId: string, targetIds: Iterable<TargetId>): TargetId[] {
	if (tabId.length === 0) return [];
	const matches: TargetId[] = [];
	for (const targetId of targetIds) {
		if (targetId.endsWith(tabId)) matches.push(targetId);
	}
	return matches;
}

/**
 * Resolves a 4-char `tabId` back to its full target id (DATA-MODEL.md §5.4 "suffix match").
 *
 * ERRATUM(M1-events-types-5): §5.4 does not say what a suffix *collision* means. Resolution is
 * fail-closed — an ambiguous suffix yields `null` rather than an arbitrary winner, because the
 * callers (`switch`/`close`, §7.4 #11/#12) are specified never to error and would otherwise act on
 * the wrong tab. Use {@linkcode findTargetIdsByTabId} when the ambiguity itself is interesting.
 */
export function resolveTargetIdByTabId(tabId: string, targetIds: Iterable<TargetId>): TargetId | null {
	const matches = findTargetIdsByTabId(tabId, targetIds);
	return matches.length === 1 ? matches[0] ?? null : null;
}

// ---------------------------------------------------------------------------------------------
// §5.3 — BrowserStateSummary and friends
// ---------------------------------------------------------------------------------------------

/** Viewport/page geometry, from one `Page.getLayoutMetrics` (DATA-MODEL.md §5.3). */
export interface PageInfo {
	viewportWidth: number;
	viewportHeight: number;
	pageWidth: number;
	pageHeight: number;
	scrollX: number;
	scrollY: number;
	pixelsAbove: number;
	pixelsBelow: number;
	pixelsLeft: number;
	pixelsRight: number;
}

/** One in-flight request in the pending-network probe (DATA-MODEL.md §5.3; ≤20, filtered). */
export interface NetworkRequest {
	url: string;
	method: string;
	loadingDurationMs: number;
	resourceType: string;
}

/**
 * Result of `BrowserStateRequestEvent` and the input to MessageManager (DATA-MODEL.md §5.3).
 *
 * `stateError` is set only on the synthesized non-actionable fallback state, which carries an empty
 * `selectorMap` so the LLM cannot act on stale indices (R6.4).
 */
export interface BrowserStateSummary {
	url: string;
	title: string;
	tabs: TabInfo[];
	/** base64 PNG; captured every step regardless of `useVision` (invariant I-14). */
	screenshot: string | null;
	/** Empty fast-path for non-http(s) URLs (DATA-MODEL.md §6.3). */
	domState: SerializedDomState;
	pageInfo: PageInfo;
	/** URL heuristic. */
	isPdfViewer: boolean;
	/** ≤20, ads/trackers/stale excluded. */
	pendingNetworkRequests: NetworkRequest[];
	browserErrors: string[];
	/** Last 10 bus events as JSON; opt-in. */
	recentEvents: string | null;
	/** Auto-handled JS dialogs, rendered `"[type] message"`. */
	closedPopupMessages: string[];
	paginationButtonsDetected: boolean;
	stateError: string | null;
	/**
	 * ERRATUM(E-36) — I-1. Identity of the index table in `domState`, minted by the serializer, or
	 * `null` when there is no table to address (recovery and fail-safe states). A caller that acted on
	 * an index from a token that is not this one is addressing a page the browser has left, and
	 * `nodeAt` refuses rather than resolving.
	 */
	stateToken: string | null;
	/**
	 * ERRATUM(E-40). Every frame the DOM walk descended into, root first, each with the composition
	 * marker of architecture §5.5. Empty on the fast path and on recovery states.
	 */
	frames: FrameRecord[];
	/** ERRATUM(E-40). True when the capture stopped at `MAX_CAPTURE_SESSIONS` and deeper OOPIFs are absent. */
	captureTruncated: boolean;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle + captcha result shapes
// ---------------------------------------------------------------------------------------------

/** Result of `BrowserLaunchEvent` (DATA-MODEL.md §5.1.2). */
export interface BrowserLaunchResult {
	cdpUrl: string;
}

/** Result of `BrowserStartEvent` — `{ cdpUrl }` per DATA-MODEL.md §5.1.2. */
export type BrowserStartResult = BrowserLaunchResult;

/**
 * Outcome of `browserSession.waitIfCaptchaSolving()` (DATA-MODEL.md §5.1.7 trailing note), consumed
 * by AGENT-RUNTIME.md §4 Phase 0: a wait resets the step timer and appends an `ActionResult` whose
 * `longTermMemory` narrates vendor, duration, and outcome.
 */
export interface CaptchaWaitResult {
	waited: boolean;
	vendor?: string;
	url?: string;
	durationMs?: number;
	result: CaptchaWaitOutcome;
}
