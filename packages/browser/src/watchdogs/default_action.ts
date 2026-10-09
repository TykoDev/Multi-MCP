/**
 * @module
 * `DefaultActionWatchdog` — every element and page interaction command (ARCHITECTURE.md §6.10).
 *
 * Handles 13 of the 18 command events of DATA-MODEL.md §5.1.1: `ClickElementEvent`,
 * `ClickCoordinateEvent`, `TypeTextEvent`, `ScrollEvent`, `GoBackEvent`, `GoForwardEvent`,
 * `RefreshEvent`, `WaitEvent`, `SendKeysEvent`, `UploadFileEvent`, `GetDropdownOptionsEvent`,
 * `SelectDropdownOptionEvent`, `ScrollToTextEvent`.
 *
 * This is parity risk **R5** (SPECS/ROADMAP.md, "Input-synthesis fidelity"): the differences that
 * matter here are not the ones a test notices, they are the ones a real site notices. A click that
 * lands on an overlay, a keystroke without a virtual-key code, a value assignment React reverts on
 * its next render — each of those looks like success from the outside and fails the task. So every
 * branch of every cascade names the mechanism it used, and those names are asserted against real
 * pages in `packages/core/tests/integration/watchdog_action_test.ts`.
 *
 * ## The click cascade, in §6.10's order
 *
 * 1. **guard rails first** — clicking a `<select>` or a file input returns `{validationError}` *as
 *    data*, never an exception. A `<select>`'s popup is browser chrome no synthetic event can reach,
 *    and a file input opens an OS dialog no agent can answer. Both are recoverable mistakes with an
 *    obvious next action, and turning them into throws turns a recoverable step into a failed run;
 * 2. `DOM.scrollIntoViewIfNeeded`;
 * 3. the **geometry fallback chain** (`default_action_geometry.ts`);
 * 4. the **occlusion check** — hit-test inside the element's own document;
 * 5. **mouse move → press → release** under the §8 3 s / 5 s caps,
 *
 * all of it wrapped in download detection (0.5 s start grace, 30 s completion wait) through the
 * DownloadsWatchdog callback seam (`default_action_downloads.ts`), and with print-dialog clicks
 * diverted into `Page.printToPDF` before any of it runs.
 *
 * Division of labour with the rest of the browser layer: SessionManager owns *which* session
 * (`getOrCreateCdpSession` is the only accessor, ARCHITECTURE.md §7.3), BrowserSession owns
 * navigation-by-URL (§7.5), DownloadsWatchdog owns the download pipeline (§6.8). This watchdog owns
 * synthesized input and nothing else.
 */

import type { HandlerContext } from '@tykotech/bus';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { delay } from '@std/async';
import { isAbsolute } from '@std/path';
import {
	ClickCoordinateEvent,
	ClickElementEvent,
	GetDropdownOptionsEvent,
	GoBackEvent,
	GoForwardEvent,
	HoverEvent,
	RefreshEvent,
	ScrollEvent,
	ScrollToTextEvent,
	SelectDropdownOptionEvent,
	SendKeysEvent,
	TypeTextEvent,
	UploadFileEvent,
	WaitEvent,
} from '../events.ts';
import type { EnhancedDomTreeNode } from '../dom/types.ts';
import type { MouseButton } from '../types.ts';
import { isContainedIn } from '../security/containment.ts';
import { type CdpSessionRecord, PAGE_TARGET_TYPE } from '../browser/session_manager.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';
import {
	ActionError,
	attributeOf,
	describeNode,
	isFileInput,
	isNativeSelect,
	isTypable,
	type NodeHandle,
	tagNameOf,
} from './default_action_dom.ts';
import {
	checkOcclusion,
	clampToViewport,
	type ClickPoint,
	dispatchMouseClick,
	dispatchMouseMove,
	javascriptClick,
	type MouseClickOutcome,
	readViewportMetrics,
	resolveClickPoint,
	scrollNodeIntoView,
	type ViewportMetrics,
} from './default_action_geometry.ts';
import { parseKeys } from './default_action_keys.ts';
import { focusNode, type KeyTarget, pressCombo, typeIntoNode } from './default_action_input.ts';
import { scrollElement, scrollFrame, scrollFrameElement, scrollPage, scrollToText } from './default_action_scroll.ts';
import {
	findAriaOptionNode,
	formatOptions,
	inspectDropdown,
	needsExpansion,
	selectNativeOption,
} from './default_action_dropdown.ts';
import {
	type ClickDownloadRecord,
	type ClickDownloadSource,
	DOWNLOAD_COMPLETION_TIMEOUT_MS,
	DOWNLOAD_START_GRACE_MS,
	withDownloadDetection,
} from './default_action_downloads.ts';

// ERRATUM(G4-5): the mouse timeout re-export line is gone — both constants live in
// `default_action_geometry.ts`, are used there, and were forwarded through this module for nobody.
export { DOWNLOAD_COMPLETION_TIMEOUT_MS, DOWNLOAD_START_GRACE_MS } from './default_action_downloads.ts';

// ---------------------------------------------------------------------------
// timing constants (ARCHITECTURE.md §8 + AGENT-RUNTIME.md §3.1 "Inner ops" —
// load-bearing, DECISION-REGISTER rule §2.5: changing one needs real-browser evidence)
// ---------------------------------------------------------------------------

/** Inner cap on `Page.printToPDF` (AGENT-RUNTIME.md §3.1 "printToPDF 30 s"). */
export const PRINT_TO_PDF_TIMEOUT_MS = 30_000;

/** Inner cap on producing a dropdown result (AGENT-RUNTIME.md §3.1 "dropdown result 3 s"). */
export const DROPDOWN_RESULT_TIMEOUT_MS = 3_000;

/**
 * Readiness wait after a history navigation or a reload.
 *
 * ERRATUM(M1-watchdogs-action-9): §6.10 requires go back/forward "via navigation history" but states
 * no readiness model for it — §7.5's machine is scoped to `NavigateToUrlEvent`. The same-domain
 * heuristic (3 s) is reused, and expiry is **non-fatal** exactly as §7.5 makes it: a history entry is
 * a page this browser has already loaded, so a slow one is a slow page, not an error.
 */
export const HISTORY_READINESS_TIMEOUT_MS = 3_000;

/** Poll cadence of that readiness wait, matching the §7.5 lifecycle poll. */
export const HISTORY_READINESS_POLL_MS = 50;

/** Lifecycle names that end the readiness wait (ARCHITECTURE.md §7.5 step 4). */
const READY_LIFECYCLE_NAMES: readonly string[] = ['load', 'DOMContentLoaded', 'networkIdle'];

/** Accessible labels that identify a print trigger (see {@linkcode isPrintDialogTrigger}). */
export const PRINT_TRIGGER_LABELS: readonly string[] = [
	'print',
	'print page',
	'print this page',
	'print document',
];

// ---------------------------------------------------------------------------
// result shapes (DATA-MODEL.md §5.1.1: `Record | null`)
// ---------------------------------------------------------------------------

/**
 * Result of `ClickElementEvent` / `ClickCoordinateEvent`.
 *
 * A `type` alias rather than an `interface` on purpose: only aliases get the implicit index signature
 * that makes them assignable to the `Record<string, unknown>` the event declares.
 */
export type ClickResult = {
	clickX: number;
	clickY: number;
	/** Which link of the geometry chain produced the point. */
	strategy?: string;
	/** `'mouse'` for synthesized input, `'javascript'` for the occlusion fallback. */
	method?: 'mouse' | 'javascript';
	occluded?: boolean;
	occlusionReason?: string;
	hitTag?: string | null;
	clamped?: boolean;
	/** ERRATUM(E-48): how many press/release pairs the ramp sent. Absent on the JavaScript fallback. */
	clickCount?: number;
	/** §8's 3 s / 5 s caps expired. Non-fatal; see ERRATUM(M1-watchdogs-action-2). */
	pressTimedOut?: boolean;
	releaseTimedOut?: boolean;
	download?: Record<string, unknown>;
	printDialogIntercepted?: boolean;
	pdfBytes?: number;
	pdfBase64?: string;
	validationError?: string;
};

/** Result of `TypeTextEvent`. */
export type TypeResult = {
	inputX: number;
	inputY: number;
	strategy?: string;
	clearStrategy?: string | null;
	focused?: boolean;
	/** Present only on a mismatch, and never for sensitive text — see ERRATUM(M1-watchdogs-action-6). */
	actualValue?: string;
	actualValueMatched?: boolean;
	validationError?: string;
};

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface DefaultActionWatchdogOptions {
	/**
	 * The DownloadsWatchdog seam (ARCHITECTURE.md §6.8). Without it clicks still work; they just
	 * cannot report a download they triggered.
	 */
	readonly downloads?: ClickDownloadSource | undefined;
	/**
	 * Fall back to a JS `element.click()` when every candidate point is occluded. Default `true` —
	 * see ERRATUM(M1-watchdogs-action-1).
	 */
	readonly clickThroughOcclusion?: boolean | undefined;
	/**
	 * Include the intercepted print job's base64 PDF on the click result. Default `false`: event
	 * results are re-serialized into `BrowserStateSummary.recentEvents`, and a multi-megabyte string
	 * there is a prompt-budget accident waiting to happen.
	 */
	readonly includePrintPdfData?: boolean | undefined;
	/**
	 * Directories an upload path must resolve inside (SECURITY-AUTH.md §8.2). Defaults to the
	 * profile's `downloadsPath` when it is set; an empty list means "no watchdog-level containment",
	 * which is the correct posture once the action layer's authorization chain is in front of it.
	 */
	readonly uploadRoots?: readonly string[] | undefined;
	/** Overrides the platform for the select-all modifier; tests pin both arms. */
	readonly os?: typeof Deno.build.os | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class DefaultActionWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [
		ClickElementEvent,
		ClickCoordinateEvent,
		HoverEvent,
		TypeTextEvent,
		ScrollEvent,
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

	static override readonly EMITS = [];

	#options: DefaultActionWatchdogOptions;
	#downloads: ClickDownloadSource | null;

	constructor(host: WatchdogHost, options: DefaultActionWatchdogOptions = {}) {
		super(host);
		this.#options = options;
		this.#downloads = options.downloads ?? null;
	}

	/**
	 * Wires the DownloadsWatchdog callback channel after construction.
	 *
	 * Attach order (ARCHITECTURE.md §6) puts Downloads first, but the two watchdogs are constructed by
	 * whoever owns the session, so late binding is the seam that does not force a construction order.
	 */
	setDownloadChannel(channel: ClickDownloadSource | null): void {
		this.#downloads = channel;
	}

	/** The channel currently wired, or `null`. */
	get downloadChannel(): ClickDownloadSource | null {
		return this.#downloads;
	}

	// -- clicks ------------------------------------------------------------------------------------

	/**
	 * The §6.10 click cascade.
	 *
	 * Returns `{validationError}` as data for the two guard-railed element kinds, and
	 * `{printDialogIntercepted}` when the click would have opened a print dialog.
	 */
	async onClickElementEvent(
		event: ClickElementEvent,
		context?: HandlerContext,
	): Promise<Record<string, unknown> | null> {
		const node = event.node;
		const guard = clickGuardRail(node);
		if (guard !== null) return guard;

		const scope = await this.#resolveSessions(node);
		if (isPrintDialogTrigger(node)) return await this.#interceptPrintDialog(scope.page.sessionId, context);

		const handle = this.#handleFor(node, scope.nodeSessionId, context);
		return await this.#clickNode({
			context,
			handle,
			page: scope.page,
			absolutePosition: node.absolutePosition,
			sameSessionAsPage: scope.sameSessionAsPage,
			button: event.button,
			clickCount: event.clickCount,
			label: describeNode(node),
		});
	}

	/**
	 * Move the pointer onto an element, or to a raw viewport point — ERRATUM(E-49).
	 *
	 * The element arm is the click cascade minus the press: the same scroll-into-view, the same
	 * viewport metrics and the same {@linkcode resolveClickPoint}, so a hover lands exactly where a
	 * click on the same node would have landed. There is deliberately **no occlusion fallback**: the
	 * JavaScript-click escape hatch exists because a click has to reach its target, while a hover on
	 * an occluded element is a truthful non-event — the pointer really is over whatever is on top —
	 * and dispatching a synthetic `mouseover` would be a lie about where the cursor is. The occluding
	 * tag is reported instead so the caller can see what it hit.
	 */
	async onHoverEvent(event: HoverEvent, context?: HandlerContext): Promise<Record<string, unknown>> {
		const client = this.cdpFor(context);
		const node = event.node;
		if (node === null) {
			const page = await this.sessions.getOrCreateCdpSession(null, true);
			const metrics = await readViewportMetrics(client, page.sessionId);
			const point = clampToViewport({ x: event.coordinateX, y: event.coordinateY }, metrics);
			const hitTag = await this.#hitTestTag(page.sessionId, point.x, point.y, context);
			const moved = await dispatchMouseMove({ client, sessionId: page.sessionId, x: point.x, y: point.y });
			return {
				hoverX: point.x,
				hoverY: point.y,
				clamped: point.clamped,
				hitTag,
				moveTimedOut: moved.moveTimedOut,
			};
		}

		const scope = await this.#resolveSessions(node);
		const handle = this.#handleFor(node, scope.nodeSessionId, context);
		await scrollNodeIntoView(handle);
		const metrics: ViewportMetrics = await readViewportMetrics(client, scope.page.sessionId);
		const point: ClickPoint | null = await resolveClickPoint({
			handle,
			sameSessionAsPage: scope.sameSessionAsPage,
			absolutePosition: node.absolutePosition,
			metrics,
		});
		if (point === null) {
			throw new ActionError(`${describeNode(node)} has no hoverable geometry (it is not laid out)`, {
				shortTermMemory: `${describeNode(node)} could not be hovered: the element has no visible box`,
			});
		}
		const occlusion = await checkOcclusion(handle);
		const moved = await dispatchMouseMove({ client, sessionId: scope.page.sessionId, x: point.x, y: point.y });
		return {
			hoverX: point.x,
			hoverY: point.y,
			strategy: point.strategy,
			clamped: point.clamped,
			occluded: occlusion.occluded,
			hitTag: occlusion.hitTag,
			moveTimedOut: moved.moveTimedOut,
		};
	}

	/** Raw viewport coordinates; `force` skips the hit test (DATA-MODEL.md §5.1.1). */
	async onClickCoordinateEvent(
		event: ClickCoordinateEvent,
		context?: HandlerContext,
	): Promise<Record<string, unknown>> {
		const page = await this.sessions.getOrCreateCdpSession(null, true);
		const client = this.cdpFor(context);
		const metrics = await readViewportMetrics(client, page.sessionId);
		const point = clampToViewport({ x: event.coordinateX, y: event.coordinateY }, metrics);

		let hitTag: string | null = null;
		if (!event.force) hitTag = await this.#hitTestTag(page.sessionId, point.x, point.y, context);

		const detection = await withDownloadDetection(
			this.#downloads,
			{ graceMs: DOWNLOAD_START_GRACE_MS, completionMs: DOWNLOAD_COMPLETION_TIMEOUT_MS },
			() =>
				clickRamp(event.clickCount, (clickCount) =>
					dispatchMouseClick({
						client,
						sessionId: page.sessionId,
						x: point.x,
						y: point.y,
						button: event.button,
						clickCount,
					})),
		);

		const result: ClickResult = {
			clickX: point.x,
			clickY: point.y,
			method: 'mouse',
			clamped: point.clamped,
			hitTag,
			clickCount: detection.value.sent,
			pressTimedOut: detection.value.pressTimedOut,
			releaseTimedOut: detection.value.releaseTimedOut,
		};
		attachDownload(result, detection.download);
		return result;
	}

	// -- typing ------------------------------------------------------------------------------------

	/** Per-character `keyDown`/`char`/`keyUp` with VK codes, clear strategies and framework events. */
	async onTypeTextEvent(event: TypeTextEvent, context?: HandlerContext): Promise<Record<string, unknown> | null> {
		const node = event.node;
		const guard = typeGuardRail(node);
		if (guard !== null) return guard;

		const scope = await this.#resolveSessions(node);
		const handle = this.#handleFor(node, scope.nodeSessionId, context);
		await scrollNodeIntoView(handle);

		const metrics = await readViewportMetrics(this.cdpFor(context), scope.page.sessionId);
		const point = await resolveClickPoint({
			handle,
			sameSessionAsPage: scope.sameSessionAsPage,
			absolutePosition: node.absolutePosition,
			metrics,
		});

		const keys: KeyTarget = { client: this.cdpFor(context), sessionId: scope.page.sessionId };
		const outcome = await typeIntoNode({
			handle,
			keys,
			node,
			text: event.text,
			clear: event.clear,
			...(this.#options.os === undefined ? {} : { os: this.#options.os }),
		});

		const result: TypeResult = {
			inputX: point?.x ?? 0,
			inputY: point?.y ?? 0,
			strategy: outcome.strategy,
			clearStrategy: outcome.clearStrategy,
			focused: outcome.focused,
		};
		if (!outcome.matched) {
			// D-SEC2: a secret must not travel back through an event result into history or logs.
			if (event.isSensitive) result.actualValueMatched = false;
			else result.actualValue = outcome.actualValue;
		}
		return result;
	}

	/** `sendKeys` combos: `'Enter'`, `'ctrl+a'`, `'ctrl+shift+t'` (ARCHITECTURE.md §6.10). */
	async onSendKeysEvent(event: SendKeysEvent, context?: HandlerContext): Promise<void> {
		const page = await this.sessions.getOrCreateCdpSession(null, true);
		// ERRATUM(E-50). The focus is moved with `DOM.focus` rather than by clicking, because a click
		// fires the element's own handlers — a chord aimed at a button must not first press it. The
		// keys are still dispatched to the **page** session: `Input.dispatchKeyEvent` goes to the frame
		// tree's owner, and the focused element receives them wherever in the tree it lives.
		const target: KeyTarget = { client: this.cdpFor(context), sessionId: page.sessionId };
		if (event.node === null) {
			for (const combo of parseKeys(event.keys)) await pressCombo(target, combo);
			return;
		}
		const scope = await this.#resolveSessions(event.node);
		const handle = this.#handleFor(event.node, scope.nodeSessionId, context);
		const focused = await focusNode(handle);
		if (!focused) {
			throw new ActionError(`${describeNode(event.node)} could not take keyboard focus`, {
				shortTermMemory: `${describeNode(event.node)} could not be focused, so the keys were not sent`,
			});
		}
		// Security review B2-SR4-8. The combos are parsed **before** the last focus check and the check
		// is repeated immediately before the first dispatch, so a `focus`/`focusin` handler that moves
		// focus away between the two cannot leave the result claiming a chord landed on this element.
		// Parsing first also means a malformed chord is refused without having moved focus at all.
		const combos = parseKeys(event.keys);
		if (!await focusNode(handle)) {
			throw new ActionError(`${describeNode(event.node)} lost keyboard focus before the keys were sent`, {
				shortTermMemory: `${describeNode(event.node)} lost focus before the keys were sent; nothing was pressed`,
			});
		}
		for (const combo of combos) await pressCombo(target, combo);
	}

	// -- scrolling ---------------------------------------------------------------------------------

	/** Page gesture, element wheel, or iframe script — whichever the target calls for (§6.10). */
	async onScrollEvent(event: ScrollEvent, context?: HandlerContext): Promise<void> {
		const node = event.node;
		const scope = await this.#resolveSessions(node);
		const client = this.cdpFor(context);
		const metrics = await readViewportMetrics(client, scope.page.sessionId);

		if (node === null) {
			const outcome = await scrollPage({
				client,
				sessionId: scope.page.sessionId,
				direction: event.direction,
				amount: event.amount,
				metrics,
			});
			this.logger.debug('scrolled the page', { ...outcome });
			return;
		}

		const handle = this.#handleFor(node, scope.nodeSessionId, context);

		// A cross-process iframe's content only moves from inside its own session.
		if (!scope.sameSessionAsPage) {
			const outcome = await scrollFrame({
				client,
				frameSessionId: scope.nodeSessionId,
				direction: event.direction,
				amount: event.amount,
			});
			this.logger.debug('scrolled an out-of-process frame', { ...outcome });
			return;
		}

		const tag = tagNameOf(node);
		if (tag === 'iframe' || tag === 'frame') {
			const outcome = await scrollFrameElement(handle, event.direction, event.amount);
			this.logger.debug('scrolled a same-process frame', { ...outcome });
			return;
		}

		await scrollNodeIntoView(handle);
		const point = await resolveClickPoint({
			handle,
			sameSessionAsPage: true,
			absolutePosition: node.absolutePosition,
			metrics,
		});
		const outcome = await scrollElement({
			handle,
			pageSessionId: scope.page.sessionId,
			point: point === null ? null : { x: point.x, y: point.y },
			direction: event.direction,
			amount: event.amount,
		});
		this.logger.debug('scrolled an element', { ...outcome });
	}

	/** `DOM.performSearch` + the text-walker fallback. Throws when the text is nowhere (§5.1.1). */
	async onScrollToTextEvent(event: ScrollToTextEvent, context?: HandlerContext): Promise<void> {
		const page = await this.sessions.getOrCreateCdpSession(null, true);
		const result = await scrollToText({
			client: this.cdpFor(context),
			sessionId: page.sessionId,
			text: event.text,
			direction: event.direction,
		});
		if (!result.found) {
			throw new ActionError(`text '${event.text}' was not found on the page`, {
				longTermMemory: `Text '${event.text}' not found or not visible on page`,
			});
		}
		this.logger.debug('scrolled to text', { text: event.text, strategy: result.strategy });
	}

	// -- history + waiting -------------------------------------------------------------------------

	/** Back one navigation-history entry. A history with nowhere to go back to is a no-op, not an error. */
	async onGoBackEvent(_event: GoBackEvent, context?: HandlerContext): Promise<void> {
		await this.#navigateHistory(-1, context);
	}

	/** Forward one navigation-history entry. */
	async onGoForwardEvent(_event: GoForwardEvent, context?: HandlerContext): Promise<void> {
		await this.#navigateHistory(1, context);
	}

	/** Reload the focused tab. */
	async onRefreshEvent(_event: RefreshEvent, context?: HandlerContext): Promise<void> {
		const page = await this.sessions.getOrCreateCdpSession(null, true);
		const startedAt = Date.now();
		await this.cdpFor(context).send.Page.reload({ ignoreCache: false }, page.sessionId);
		await this.#awaitReadiness(page.targetId, startedAt);
	}

	/**
	 * A deliberate pause, clamped to `maxSeconds`.
	 *
	 * ERRATUM(M1-watchdogs-action-10): §7.4 #4 describes the *action* sleeping
	 * `min(max(seconds−1, 0), 30)`; the −1 and the 30 belong to the action's own budget arithmetic.
	 * The event's contract (DATA-MODEL.md §5.1.1, `seconds` = 3, `maxSeconds` = 10) is a plain clamp,
	 * so the handler does exactly `min(max(seconds, 0), maxSeconds)` and leaves the action's
	 * adjustment to the action.
	 */
	async onWaitEvent(event: WaitEvent, context?: HandlerContext): Promise<void> {
		const seconds = Math.min(Math.max(event.seconds, 0), event.maxSeconds);
		const signal = context?.signal;
		await delay(seconds * 1_000, signal === undefined ? undefined : { signal });
	}

	// -- upload ------------------------------------------------------------------------------------

	/** `DOM.setFileInputFiles` on the node, or on the file input it stands for (§6.10). */
	async onUploadFileEvent(event: UploadFileEvent, context?: HandlerContext): Promise<void> {
		// Containment first: the cheapest check, and a refused path must not touch the page at all.
		const filePath = await this.#authorizeUploadPath(event.filePath);

		const node = event.node;
		const scope = await this.#resolveSessions(node);
		const handle = this.#handleFor(node, scope.nodeSessionId, context);

		const backendNodeId = isFileInput(node) ? node.backendNodeId : await this.#findFileInput(handle);
		if (backendNodeId === null) {
			throw new ActionError(`${describeNode(node)} is not a file input and contains none`, {
				longTermMemory: 'Upload failed: the element is not a file input',
			});
		}

		await this.cdpFor(context).send.DOM.setFileInputFiles({ backendNodeId, files: [filePath] }, scope.nodeSessionId);
		this.logger.debug('set file input files', { backendNodeId, filePath });
	}

	// -- dropdowns ---------------------------------------------------------------------------------

	/** Inspect a dropdown, native or ARIA. Result keys are exactly `shortTermMemory`/`longTermMemory`. */
	async onGetDropdownOptionsEvent(
		event: GetDropdownOptionsEvent,
		context?: HandlerContext,
	): Promise<Record<string, string>> {
		const node = event.node;
		const scope = await this.#resolveSessions(node);
		const handle = this.#handleFor(node, scope.nodeSessionId, context);

		let info = await inspectDropdown(handle);
		if (needsExpansion(info) && info.options.length === 0) {
			await this.#expandDropdown(handle, scope, context);
			info = await inspectDropdown(handle);
		}
		if (info.kind === 'none') {
			return {
				shortTermMemory: `${describeNode(node)} is not a dropdown; no options to list`,
				longTermMemory: 'Element is not a dropdown',
			};
		}
		const label = describeNode(node);
		return {
			shortTermMemory: `Options for ${label} (${info.kind}):\n${formatOptions(info.options)}`,
			longTermMemory: `Found ${info.options.length} options for ${label}`,
		};
	}

	/**
	 * Select an option by exact text or value.
	 *
	 * ERRATUM(M1-watchdogs-action-5): §6.10 lists "native select + ARIA/framework paths" without
	 * saying they use different mechanisms, but they must. A native `<select>`'s option list is
	 * browser chrome outside the page's coordinate space, so no synthesized mouse event can reach it —
	 * assignment plus the framework event pair *is* the native path. An ARIA option is ordinary DOM
	 * whose framework handlers are the only thing that commits a selection, so that path expands the
	 * control and presses the option through the full click cascade.
	 *
	 * A miss never throws: the available options come back as structured memory (§7.4 #20).
	 */
	async onSelectDropdownOptionEvent(
		event: SelectDropdownOptionEvent,
		context?: HandlerContext,
	): Promise<Record<string, string>> {
		const node = event.node;
		const scope = await this.#resolveSessions(node);
		const handle = this.#handleFor(node, scope.nodeSessionId, context);
		const label = describeNode(node);

		if (isNativeSelect(node)) {
			const outcome = await selectNativeOption(handle, event.text);
			if (outcome.selected) {
				return {
					shortTermMemory: `Selected '${outcome.text ?? event.text}' in ${label}`,
					longTermMemory: `Selected dropdown option '${event.text}'`,
				};
			}
			const info = await inspectDropdown(handle);
			return {
				shortTermMemory: `Could not select '${event.text}' in ${label}.\n${formatOptions(info.options)}`,
				longTermMemory: `Dropdown option '${event.text}' is not available`,
				validationError: outcome.disabled ? `option '${event.text}' is disabled` : `no option matches '${event.text}'`,
			};
		}

		let info = await inspectDropdown(handle);
		if (needsExpansion(info)) {
			await this.#expandDropdown(handle, scope, context);
			info = await inspectDropdown(handle);
		}
		const optionNode = await findAriaOptionNode(handle, event.text);
		if (optionNode === null) {
			return {
				shortTermMemory: `Could not select '${event.text}' in ${label}.\n${formatOptions(info.options)}`,
				longTermMemory: `Dropdown option '${event.text}' is not available`,
				validationError: `no option matches '${event.text}'`,
			};
		}
		await this.#clickNode({
			context,
			handle: { client: this.cdpFor(context), sessionId: scope.nodeSessionId, backendNodeId: optionNode },
			page: scope.page,
			absolutePosition: null,
			sameSessionAsPage: scope.sameSessionAsPage,
			button: 'left',
			label: `option '${event.text}'`,
		});
		return {
			shortTermMemory: `Selected '${event.text}' in ${label}`,
			longTermMemory: `Selected dropdown option '${event.text}'`,
		};
	}

	// -- internals ---------------------------------------------------------------------------------

	/** The full click cascade for an already-resolved node. */
	async #clickNode(options: {
		/** The dispatch this click belongs to; `undefined` outside one (ERRATUM(E-52)). */
		context: HandlerContext | undefined;
		handle: NodeHandle;
		page: CdpSessionRecord;
		absolutePosition: EnhancedDomTreeNode['absolutePosition'];
		sameSessionAsPage: boolean;
		button: MouseButton;
		/** ERRATUM(E-48). Omitted means a single click, which is what every caller sent before it. */
		clickCount?: number;
		label: string;
	}): Promise<ClickResult> {
		const { context, handle, page } = options;
		await scrollNodeIntoView(handle);
		const metrics: ViewportMetrics = await readViewportMetrics(this.cdpFor(context), page.sessionId);
		const point: ClickPoint | null = await resolveClickPoint({
			handle,
			sameSessionAsPage: options.sameSessionAsPage,
			absolutePosition: options.absolutePosition,
			metrics,
		});
		if (point === null) {
			throw new ActionError(`${options.label} has no clickable geometry (it is not laid out)`, {
				shortTermMemory: `${options.label} could not be clicked: the element has no visible box`,
			});
		}

		const occlusion = await checkOcclusion(handle);
		const clickThrough = this.#options.clickThroughOcclusion !== false;
		const useJavascript = occlusion.occluded && clickThrough;

		const detection = await withDownloadDetection(
			this.#downloads,
			{ graceMs: DOWNLOAD_START_GRACE_MS, completionMs: DOWNLOAD_COMPLETION_TIMEOUT_MS },
			async () => {
				if (useJavascript) {
					await javascriptClick(handle);
					return null;
				}
				return await clickRamp(options.clickCount, (clickCount) =>
					dispatchMouseClick({
						client: this.cdpFor(context),
						sessionId: page.sessionId,
						x: point.x,
						y: point.y,
						button: options.button,
						clickCount,
					}));
			},
		);

		const result: ClickResult = {
			clickX: point.x,
			clickY: point.y,
			strategy: point.strategy,
			method: useJavascript ? 'javascript' : 'mouse',
			occluded: occlusion.occluded,
			occlusionReason: occlusion.reason,
			hitTag: occlusion.hitTag,
			clamped: point.clamped,
			// The JavaScript fallback dispatches no mouse events at all, so it has no click count to
			// report; a `2` there would claim a `dblclick` the page never received (ERRATUM(E-48)).
			...(useJavascript || detection.value === null ? {} : { clickCount: detection.value.sent }),
			pressTimedOut: detection.value?.pressTimedOut ?? false,
			releaseTimedOut: detection.value?.releaseTimedOut ?? false,
		};
		attachDownload(result, detection.download);
		return result;
	}

	/** `Page.printToPDF` in place of a click that would have opened the print dialog (§6.10). */
	async #interceptPrintDialog(sessionId: SessionId, context: HandlerContext | undefined): Promise<ClickResult> {
		const printed = await this.cdpFor(context).send.Page.printToPDF(
			{ printBackground: true, transferMode: 'ReturnAsBase64' },
			sessionId,
			{ requestTimeoutMs: PRINT_TO_PDF_TIMEOUT_MS },
		);
		const result: ClickResult = {
			clickX: 0,
			clickY: 0,
			printDialogIntercepted: true,
			pdfBytes: base64ByteLength(printed.data),
		};
		if (this.#options.includePrintPdfData === true) result.pdfBase64 = printed.data;
		this.logger.debug('print dialog intercepted into Page.printToPDF', { pdfBytes: result.pdfBytes });
		return result;
	}

	/** Resolves the page session and the node's own session through the sole sanctioned accessor. */
	async #resolveSessions(node: EnhancedDomTreeNode | null): Promise<{
		page: CdpSessionRecord;
		nodeSessionId: SessionId;
		sameSessionAsPage: boolean;
	}> {
		const manager = this.sessions;
		const record = node === null ? undefined : manager.targets.get(node.targetId);
		const isPage = record !== undefined && record.type === PAGE_TARGET_TYPE;
		const page = await manager.getOrCreateCdpSession(isPage && node !== null ? node.targetId : null, true);
		if (node === null || node.targetId === page.targetId || node.targetId === '') {
			return { page, nodeSessionId: page.sessionId, sameSessionAsPage: true };
		}
		try {
			const owner = await manager.getOrCreateCdpSession(node.targetId, false);
			return {
				page,
				nodeSessionId: owner.sessionId,
				sameSessionAsPage: owner.sessionId === page.sessionId,
			};
		} catch (error) {
			// The capture session is gone (an OOPIF navigated away). The page session still addresses
			// same-process nodes, and the geometry chain degrades to `absolutePosition` for the rest.
			this.logger.debug('node target has no session; falling back to the page session', {
				targetId: node.targetId,
				error,
			});
			return { page, nodeSessionId: page.sessionId, sameSessionAsPage: true };
		}
	}

	#handleFor(node: EnhancedDomTreeNode, sessionId: SessionId, context: HandlerContext | undefined): NodeHandle {
		return { client: this.cdpFor(context), sessionId, backendNodeId: node.backendNodeId };
	}

	/** Clicks a collapsed ARIA control so its options exist before they are read. */
	async #expandDropdown(
		handle: NodeHandle,
		scope: { page: CdpSessionRecord; sameSessionAsPage: boolean },
		context: HandlerContext | undefined,
	): Promise<void> {
		try {
			await this.#clickNode({
				context,
				handle,
				page: scope.page,
				absolutePosition: null,
				sameSessionAsPage: scope.sameSessionAsPage,
				button: 'left',
				label: 'dropdown control',
			});
		} catch (error) {
			this.logger.debug('could not expand the dropdown before reading its options', { error });
		}
	}

	/** Tag name of whatever occupies a viewport point, for the coordinate-click result. */
	async #hitTestTag(
		sessionId: SessionId,
		x: number,
		y: number,
		context: HandlerContext | undefined,
	): Promise<string | null> {
		try {
			const cdp = this.cdpFor(context);
			const located = await cdp.send.DOM.getNodeForLocation({ x, y, includeUserAgentShadowDOM: false }, sessionId);
			const described = await cdp.send.DOM.describeNode({ backendNodeId: located.backendNodeId }, sessionId);
			return described.node.nodeName.toLowerCase();
		} catch {
			// Nothing at that point, or the DOM domain refused: the click still happens.
			return null;
		}
	}

	/** Back/forward through `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`. */
	async #navigateHistory(delta: -1 | 1, context: HandlerContext | undefined): Promise<void> {
		const page = await this.sessions.getOrCreateCdpSession(null, true);
		const history = await this.cdpFor(context).send.Page.getNavigationHistory(undefined, page.sessionId);
		const entry = history.entries[history.currentIndex + delta];
		if (entry === undefined) {
			this.logger.debug('navigation history has no entry in that direction', {
				delta,
				currentIndex: history.currentIndex,
				entries: history.entries.length,
			});
			return;
		}
		const startedAt = Date.now();
		await this.cdpFor(context).send.Page.navigateToHistoryEntry({ entryId: entry.id }, page.sessionId);
		await this.#awaitReadiness(page.targetId, startedAt);
	}

	/** Non-fatal readiness wait; see {@linkcode HISTORY_READINESS_TIMEOUT_MS}. */
	async #awaitReadiness(targetId: TargetId, startedAt: number): Promise<void> {
		const deadline = startedAt + HISTORY_READINESS_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const seen = this.sessions.lifecycleEventsFor(targetId).some((record) =>
				record.receivedAt >= startedAt && READY_LIFECYCLE_NAMES.includes(record.name)
			);
			if (seen) return;
			await delay(HISTORY_READINESS_POLL_MS);
		}
		this.logger.debug('history navigation did not report readiness inside its budget', { targetId });
	}

	/** The nearest file input the node stands for: itself, a descendant, or a `label[for]` target. */
	async #findFileInput(handle: NodeHandle): Promise<number | null> {
		return await findRelatedFileInput(handle);
	}

	/**
	 * Local containment for an upload path (SECURITY-AUTH.md §8.2).
	 *
	 * Remote (attached-browser) sessions are exempt by spec: the path names a file on the machine the
	 * browser runs on, which this process cannot see, "documented as such" in §8.2. Locally the path
	 * must be absolute (a path resolved against this process's cwd is not a security property), must
	 * resolve — through symlinks, which is the GHSA-j9hj-92j8-jv9h contract — to an existing regular
	 * file, and must sit inside a configured root when roots are configured.
	 */
	async #authorizeUploadPath(filePath: string): Promise<string> {
		if (!this.host.isLocal) return filePath;
		if (!isAbsolute(filePath)) {
			throw new ActionError(`upload path must be absolute, got '${filePath}'`, {
				longTermMemory: 'Upload failed: the file path must be absolute',
			});
		}

		let real: string;
		try {
			real = await Deno.realPath(filePath);
			const info = await Deno.stat(real);
			if (!info.isFile) throw new ActionError(`upload path '${filePath}' is not a file`);
		} catch (error) {
			if (error instanceof ActionError) throw error;
			throw new ActionError(`upload path '${filePath}' could not be resolved: ${describeError(error)}`, {
				longTermMemory: `Upload failed: ${filePath} is not readable`,
				cause: error,
			});
		}

		const roots = this.#uploadRoots();
		if (roots.length === 0) return real;
		if (roots.some((root) => isContainedIn(root, real))) return real;
		throw new ActionError(`upload path '${filePath}' resolves outside the permitted directories`, {
			longTermMemory: 'Upload failed: the file is outside the permitted directories',
		});
	}

	#uploadRoots(): string[] {
		const configured = this.#options.uploadRoots;
		if (configured !== undefined) return [...configured];
		const downloads = this.profile.downloadsPath;
		return downloads === null ? [] : [downloads];
	}
}

// ---------------------------------------------------------------------------
// guard rails — data, not exceptions (ARCHITECTURE.md §6.10)
// ---------------------------------------------------------------------------

/**
 * The two click guard rails.
 *
 * Both are recoverable mistakes with an obvious next action, which is exactly why they are data: a
 * `{validationError}` lets the agent's next step do the right thing, while a throw costs it a step
 * and a retry it has no new information for.
 */
export function clickGuardRail(node: EnhancedDomTreeNode): ClickResult | null {
	if (isNativeSelect(node)) {
		return {
			clickX: 0,
			clickY: 0,
			validationError: `${describeNode(node)} is a <select>: its option list is browser chrome, not page content. ` +
				'Use dropdown_options to read the choices and select_dropdown to pick one.',
		};
	}
	if (isFileInput(node)) {
		return {
			clickX: 0,
			clickY: 0,
			validationError: `${describeNode(node)} is a file input: clicking it opens an OS file dialog no agent can ` +
				'answer. Use upload_file with a path instead.',
		};
	}
	return null;
}

/** Typing guard rails: the click ones, plus "this element does not take text". */
export function typeGuardRail(node: EnhancedDomTreeNode): TypeResult | null {
	if (isNativeSelect(node)) {
		return {
			inputX: 0,
			inputY: 0,
			validationError: `${describeNode(node)} is a <select>: use select_dropdown to choose an option.`,
		};
	}
	if (isFileInput(node)) {
		return {
			inputX: 0,
			inputY: 0,
			validationError: `${describeNode(node)} is a file input: use upload_file with a path.`,
		};
	}
	if (!isTypable(node)) {
		return {
			inputX: 0,
			inputY: 0,
			validationError: `${describeNode(node)} does not accept text input.`,
		};
	}
	return null;
}

/**
 * Does clicking this element open the print dialog?
 *
 * ERRATUM(M1-watchdogs-action-3): §6.10 requires "print-dialog clicks are intercepted into
 * `Page.printToPDF`" but states no detection rule. The rule implemented here is deliberately narrow,
 * because a false positive silently *does not click* something the agent asked to click:
 *
 * - an `onclick` (or `javascript:` href) that calls `print(…)` / `window.print(…)`, which is what
 *   every "Print this page" link in the wild is; **or**
 * - an accessible label that is exactly one of {@linkcode PRINT_TRIGGER_LABELS} on a
 *   button-ish element — so `<button aria-label="Print">` matches and "3D printing services" does not.
 *
 * The event's node is cycle-stripped (`childrenNodes: []`, DATA-MODEL.md §5.1), so the label comes
 * from attributes only; text-content-only print buttons take the ordinary click path and are handled
 * by PopupsWatchdog if a dialog does appear.
 */
export function isPrintDialogTrigger(node: EnhancedDomTreeNode): boolean {
	const onclick = attributeOf(node, 'onclick') ?? '';
	const href = attributeOf(node, 'href') ?? '';
	const printCall = /(?:^|[^\w.$])(?:window\s*\.\s*)?print\s*\(/;
	if (printCall.test(onclick)) return true;
	if (href.toLowerCase().startsWith('javascript:') && printCall.test(href)) return true;

	const tag = tagNameOf(node);
	const role = (attributeOf(node, 'role') ?? '').toLowerCase();
	const buttonish = tag === 'button' || role === 'button' ||
		(tag === 'input' && ['button', 'submit'].includes((attributeOf(node, 'type') ?? '').toLowerCase()));
	if (!buttonish) return false;

	const label = (attributeOf(node, 'aria-label') ?? attributeOf(node, 'title') ?? attributeOf(node, 'value') ?? '')
		.trim()
		.toLowerCase()
		.replaceAll(/\s+/g, ' ');
	return label !== '' && PRINT_TRIGGER_LABELS.includes(label);
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------

/** Finds the file input a node stands for: itself, a descendant, or the target of a `label[for]`. */
const FIND_FILE_INPUT_FUNCTION = `function () {
	const isFileInput = function (candidate) {
		return candidate !== null && candidate.tagName !== undefined &&
			candidate.tagName.toLowerCase() === 'input' && candidate.type === 'file';
	};
	if (isFileInput(this)) return this;
	const descendant = this.querySelector === undefined ? null : this.querySelector('input[type="file"]');
	if (descendant !== null) return descendant;
	const forId = this.getAttribute === undefined ? null : this.getAttribute('for');
	if (forId) {
		const labelled = this.ownerDocument.getElementById(forId);
		if (isFileInput(labelled)) return labelled;
	}
	const label = this.closest === undefined ? null : this.closest('label');
	if (label !== null) {
		const inside = label.querySelector('input[type="file"]');
		if (inside !== null) return inside;
		const target = label.getAttribute('for');
		if (target) {
			const referenced = this.ownerDocument.getElementById(target);
			if (isFileInput(referenced)) return referenced;
		}
	}
	return null;
}`;

async function findRelatedFileInput(handle: NodeHandle): Promise<number | null> {
	const { client, sessionId } = handle;
	let controlObjectId: string | null = null;
	let inputObjectId: string | null = null;
	try {
		const resolved = await client.send.DOM.resolveNode({ backendNodeId: handle.backendNodeId }, sessionId);
		controlObjectId = resolved.object.objectId ?? null;
		if (controlObjectId === null) return null;
		const outcome = await client.send.Runtime.callFunctionOn({
			functionDeclaration: FIND_FILE_INPUT_FUNCTION,
			objectId: controlObjectId,
			returnByValue: false,
			awaitPromise: true,
		}, sessionId);
		if (outcome.exceptionDetails !== undefined) return null;
		inputObjectId = outcome.result.objectId ?? null;
		if (inputObjectId === null) return null;
		const requested = await client.send.DOM.requestNode({ objectId: inputObjectId }, sessionId);
		const described = await client.send.DOM.describeNode({ nodeId: requested.nodeId }, sessionId);
		return described.node.backendNodeId;
	} catch {
		return null;
	} finally {
		for (const objectId of [controlObjectId, inputObjectId]) {
			if (objectId === null) continue;
			try {
				await client.send.Runtime.releaseObject({ objectId }, sessionId);
			} catch {
				// The context went away with the navigation the click caused.
			}
		}
	}
}

/**
 * The multi-click ramp — ERRATUM(E-48).
 *
 * A double click is **not** one press/release pair carrying `clickCount: 2`. It is the second pair
 * of a sequence: the browser fires `click` at count 1 and `dblclick` at count 2, so a page with both
 * handlers must see both. This is exactly the sequence the Live View produces when a human
 * double-clicks — the SPA sends one `input.mouse` per physical click, carrying the browser's own
 * `detail` — which is what makes §10's "reproducible by the tools" true for this gesture rather than
 * merely claimed. The count is clamped to 1..3 because that is the range
 * `packages/wire/src/messages.ts` already accepts from the socket, and the two paths must not differ.
 */
async function clickRamp(
	clickCount: number | undefined,
	send: (count: number) => Promise<MouseClickOutcome>,
): Promise<MouseClickOutcome & { sent: number }> {
	// `Math.trunc(NaN)` is NaN and `Math.max(1, NaN)` is NaN, so a non-finite request fails closed to
	// a single click rather than to a loop bound of NaN.
	const requested = Math.trunc(clickCount ?? 1);
	const total = Number.isFinite(requested) ? Math.min(3, Math.max(1, requested)) : 1;
	let outcome = await send(1);
	for (let count = 2; count <= total; count += 1) outcome = await send(count);
	// Security review B2-SR4-10: the **sent** total, not the requested one. The result's `clickCount`
	// is a claim about what the page received, and reporting the request would make it a false claim
	// the moment the clamp did any work.
	return { ...outcome, sent: total };
}

/** Folds the download-detection outcome onto a click result. */
function attachDownload(result: ClickResult, download: ClickDownloadRecord | null): void {
	if (download === null) return;
	result.download = {
		guid: download.guid,
		url: download.url,
		suggestedFilename: download.suggestedFilename,
		fileName: download.fileName,
		path: download.path,
		fileSize: download.fileSize,
		state: download.state,
		completed: download.state === 'completed',
		...(download.error === null ? {} : { error: download.error }),
	};
}

/** Decoded byte length of a base64 payload, without decoding it. */
export function base64ByteLength(data: string): number {
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor(data.length / 4) * 3 - padding);
}

function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
