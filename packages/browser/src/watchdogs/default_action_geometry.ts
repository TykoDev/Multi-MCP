/**
 * @module
 * The click cascade's geometry half: `scrollIntoViewIfNeeded` → the geometry fallback chain → the
 * occlusion check → mouse move/press/release under the 3 s / 5 s caps.
 *
 * Contract owners: SPECS/ARCHITECTURE.md §6.10 ("CDP-native click (scrollIntoView → geometry fallback
 * chain → occlusion check → mouse move/press/release with 3s/5s caps)") and §8 ("Fine-grained CDP
 * interaction caps … 3s/5s mouse press/release … preserved verbatim — they encode CDP behavior").
 *
 * ## Coordinate spaces, which is where this gets subtle
 *
 * `Input.dispatchMouseEvent` takes **main-frame viewport** CSS pixels. `DOM.getContentQuads` and
 * `DOM.getBoxModel` answer in the same space *for nodes in the page session*, including same-process
 * iframes, because one renderer lays the whole frame tree out together. A cross-process iframe
 * (OOPIF) has its own session and its own origin, so its quads are frame-local and unusable as click
 * coordinates. For those the chain falls through to `absolutePosition` — page-absolute CSS px with
 * accumulated frame offsets already applied (DATA-MODEL.md §6.1) — minus the page scroll offset.
 *
 * The occlusion check sidesteps the whole problem by never leaving the element's own document: it
 * asks the element for its own centre and hit-tests *there*, so the verdict is correct in every frame
 * regardless of which space the click point came from.
 */

import type { CdpClient, SessionId } from '@tykotech/cdp';
import { CdpRequestTimeoutError } from '@tykotech/cdp';
import type { MouseButton } from '../types.ts';
import type { DomRect } from '../dom/types.ts';
import { callOnNode, ensureDomEnabled, isStaleNodeError, type NodeHandle } from './default_action_dom.ts';

// ---------------------------------------------------------------------------
// timing constants (ARCHITECTURE.md §8 — load-bearing, DECISION-REGISTER rule §2.5:
// changing one needs real-browser evidence)
// ---------------------------------------------------------------------------

/** Cap on the `mousePressed` CDP round trip (ARCHITECTURE.md §6.10, §8). */
export const MOUSE_PRESS_TIMEOUT_MS = 3_000;

/** Cap on the `mouseReleased` CDP round trip (ARCHITECTURE.md §6.10, §8). */
export const MOUSE_RELEASE_TIMEOUT_MS = 5_000;

/** Cap on the `mouseMoved` that precedes a press. Not speced; kept equal to the press cap. */
export const MOUSE_MOVE_TIMEOUT_MS = MOUSE_PRESS_TIMEOUT_MS;

/** CDP `Input` button bitfield for the `buttons` field of a press. */
const BUTTON_BITS: Readonly<Record<MouseButton, number>> = { left: 1, right: 2, middle: 4 };

// ---------------------------------------------------------------------------
// viewport
// ---------------------------------------------------------------------------

/** The layout facts a click point is clamped and converted against. */
export interface ViewportMetrics {
	readonly width: number;
	readonly height: number;
	readonly scrollX: number;
	readonly scrollY: number;
	readonly pageWidth: number;
	readonly pageHeight: number;
}

/**
 * One `Page.getLayoutMetrics`, preferring the `css*` variants.
 *
 * The non-`css` fields are in device pixels on a scaled display; mixing the two is how a click lands
 * at half the intended coordinates on a HiDPI screen.
 */
export async function readViewportMetrics(client: CdpClient, sessionId: SessionId): Promise<ViewportMetrics> {
	const metrics = await client.send.Page.getLayoutMetrics(undefined, sessionId);
	// Every field is optional-at-runtime on purpose: a session that answers a partial payload (a
	// crashed renderer, a target mid-swap) must degrade to "viewport unknown", not crash a click.
	const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? null;
	const visual = metrics.cssVisualViewport ?? metrics.visualViewport ?? null;
	const content = metrics.cssContentSize ?? metrics.contentSize ?? null;
	return {
		width: layout?.clientWidth ?? 0,
		height: layout?.clientHeight ?? 0,
		scrollX: visual?.pageX ?? 0,
		scrollY: visual?.pageY ?? 0,
		pageWidth: content?.width ?? 0,
		pageHeight: content?.height ?? 0,
	};
}

// ---------------------------------------------------------------------------
// the geometry fallback chain
// ---------------------------------------------------------------------------

/** Which link of the chain produced the point — the R5 audit surface. */
export type ClickPointStrategy =
	| 'contentQuads'
	| 'boxModel'
	| 'boundingClientRect'
	| 'absolutePosition';

export interface ClickPoint {
	readonly x: number;
	readonly y: number;
	readonly strategy: ClickPointStrategy;
	/** `true` when the point had to be pulled back inside the viewport to be clickable. */
	readonly clamped: boolean;
}

/** Centre and area of one CDP quad (8 numbers, 4 points). `null` for a degenerate quad. */
export function quadCentre(quad: readonly number[]): { x: number; y: number; area: number } | null {
	if (quad.length < 8) return null;
	let sumX = 0;
	let sumY = 0;
	for (let index = 0; index < 8; index += 2) {
		sumX += quad[index] ?? 0;
		sumY += quad[index + 1] ?? 0;
	}
	// Shoelace formula: robust for the rotated/skewed quads a CSS transform produces.
	let twiceArea = 0;
	for (let index = 0; index < 8; index += 2) {
		const nextIndex = (index + 2) % 8;
		twiceArea += (quad[index] ?? 0) * (quad[nextIndex + 1] ?? 0) - (quad[nextIndex] ?? 0) * (quad[index + 1] ?? 0);
	}
	const area = Math.abs(twiceArea) / 2;
	if (!Number.isFinite(area) || area <= 0) return null;
	return { x: sumX / 4, y: sumY / 4, area };
}

/** The largest non-degenerate quad — an inline element wrapped across lines has one per line. */
export function largestQuadCentre(quads: readonly (readonly number[])[]): { x: number; y: number } | null {
	let best: { x: number; y: number; area: number } | null = null;
	for (const quad of quads) {
		const centre = quadCentre(quad);
		if (centre === null) continue;
		if (best === null || centre.area > best.area) best = centre;
	}
	return best === null ? null : { x: best.x, y: best.y };
}

/**
 * Pulls a point inside `[0, width) × [0, height)`; a point outside cannot receive mouse input.
 *
 * A viewport of zero size means "unknown" (see {@linkcode readViewportMetrics}), and an unknown
 * viewport is not a constraint: the point passes through untouched rather than being pinned to the
 * origin, which would silently click the wrong thing.
 */
export function clampToViewport(
	point: { x: number; y: number },
	metrics: ViewportMetrics,
): { x: number; y: number; clamped: boolean } {
	if (metrics.width <= 0 || metrics.height <= 0) return { x: point.x, y: point.y, clamped: false };
	const maxX = Math.max(0, metrics.width - 1);
	const maxY = Math.max(0, metrics.height - 1);
	const x = Math.min(Math.max(point.x, 0), maxX);
	const y = Math.min(Math.max(point.y, 0), maxY);
	return { x, y, clamped: x !== point.x || y !== point.y };
}

/** Inputs to {@linkcode resolveClickPoint}. */
export interface ClickPointOptions {
	readonly handle: NodeHandle;
	/**
	 * `true` when the node's session *is* the page session, which is what makes CDP geometry usable as
	 * main-frame viewport coordinates. `false` for an OOPIF: the chain skips straight to
	 * `absolutePosition`.
	 */
	readonly sameSessionAsPage: boolean;
	/** DATA-MODEL §6.1 `absolutePosition` — page-absolute CSS px, frame offsets included. */
	readonly absolutePosition: DomRect | null;
	readonly metrics: ViewportMetrics;
}

/** `getBoundingClientRect()` on the element, in its own frame's viewport space. */
const BOUNDING_RECT_FUNCTION = `function () {
	const rect = this.getBoundingClientRect();
	return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}`;

/**
 * The geometry fallback chain, in ARCHITECTURE.md §6.10's order.
 *
 * 1. `DOM.getContentQuads` — the truth for transformed, wrapped and multi-box elements;
 * 2. `DOM.getBoxModel` — one border box, for nodes Chrome refuses quads for;
 * 3. `getBoundingClientRect()` in the page — survives when the DOM domain disagrees with layout;
 * 4. `absolutePosition − scroll` — the IR's own geometry, and the only link that works for an OOPIF.
 *
 * Returns `null` when every link failed, which the caller reports as an un-clickable element rather
 * than clicking a guessed coordinate.
 */
export async function resolveClickPoint(options: ClickPointOptions): Promise<ClickPoint | null> {
	const { handle, metrics } = options;
	if (options.sameSessionAsPage) {
		const quads = await tryQuads(handle);
		if (quads !== null) return finish(quads, 'contentQuads', metrics);

		const box = await tryBoxModel(handle);
		if (box !== null) return finish(box, 'boxModel', metrics);

		const rect = await tryBoundingRect(handle);
		if (rect !== null) return finish(rect, 'boundingClientRect', metrics);
	}

	const absolute = options.absolutePosition;
	if (absolute !== null && absolute.width > 0 && absolute.height > 0) {
		const point = {
			x: absolute.x + absolute.width / 2 - metrics.scrollX,
			y: absolute.y + absolute.height / 2 - metrics.scrollY,
		};
		return finish(point, 'absolutePosition', metrics);
	}
	return null;
}

function finish(
	point: { x: number; y: number },
	strategy: ClickPointStrategy,
	metrics: ViewportMetrics,
): ClickPoint {
	const clamped = clampToViewport(point, metrics);
	return { x: round(clamped.x), y: round(clamped.y), strategy, clamped: clamped.clamped };
}

/** Half-pixel coordinates are legal but make assertions and logs noisy; CDP rounds them anyway. */
function round(value: number): number {
	return Math.round(value * 100) / 100;
}

async function tryQuads(handle: NodeHandle): Promise<{ x: number; y: number } | null> {
	await ensureDomEnabled(handle.client, handle.sessionId);
	try {
		const result = await handle.client.send.DOM.getContentQuads(
			{ backendNodeId: handle.backendNodeId },
			handle.sessionId,
		);
		return largestQuadCentre(result.quads ?? []);
	} catch (error) {
		if (isStaleNodeError(error)) return null;
		// Chrome answers "Could not compute content quads" for a display:none or detached node.
		return null;
	}
}

async function tryBoxModel(handle: NodeHandle): Promise<{ x: number; y: number } | null> {
	try {
		const result = await handle.client.send.DOM.getBoxModel(
			{ backendNodeId: handle.backendNodeId },
			handle.sessionId,
		);
		return largestQuadCentre([result.model.border]);
	} catch {
		return null;
	}
}

async function tryBoundingRect(handle: NodeHandle): Promise<{ x: number; y: number } | null> {
	try {
		const rect = await callOnNode<DomRect>(handle, BOUNDING_RECT_FUNCTION);
		if (rect === null || rect.width <= 0 || rect.height <= 0) return null;
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	} catch {
		return null;
	}
}

/** Scrolls the element into view; never fatal — the geometry chain reports what it can see. */
export async function scrollNodeIntoView(handle: NodeHandle): Promise<boolean> {
	await ensureDomEnabled(handle.client, handle.sessionId);
	try {
		await handle.client.send.DOM.scrollIntoViewIfNeeded({ backendNodeId: handle.backendNodeId }, handle.sessionId);
		return true;
	} catch {
		// Chrome refuses for nodes without a layout object (display:none, detached). The occlusion
		// check catches the consequences.
		return false;
	}
}

// ---------------------------------------------------------------------------
// occlusion
// ---------------------------------------------------------------------------

/** Verdict of the occlusion check. */
export interface OcclusionVerdict {
	/** `true` when something else owns the pixel at the element's centre. */
	readonly occluded: boolean;
	/** Tag of whatever the hit test found, for the log line and the result payload. */
	readonly hitTag: string | null;
	/** Why the check could not be conclusive, when it could not. */
	readonly reason: 'ok' | 'zero-size' | 'outside-viewport' | 'unavailable';
}

/**
 * Hit-tests the element's own centre **inside its own document**, piercing open shadow roots.
 *
 * Frame-local by construction: `getBoundingClientRect` and `elementFromPoint` share the element's
 * document's coordinate space, so the verdict is correct for the top document, a same-process iframe
 * and an OOPIF alike — no frame-offset arithmetic, nothing to get wrong.
 *
 * A hit that is the element, an ancestor of it, or a descendant of it counts as reaching it: a click
 * on a `<button><span>Go</span></button>` lands on the span, and a click on a label-wrapped input
 * lands on the label.
 */
const OCCLUSION_FUNCTION = `function () {
	const element = this;
	const doc = element.ownerDocument;
	if (doc === null || doc.defaultView === null) return { reason: 'unavailable' };
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return { reason: 'zero-size' };
	const x = rect.left + rect.width / 2;
	const y = rect.top + rect.height / 2;
	const view = doc.defaultView;
	if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return { reason: 'outside-viewport' };
	let hit = doc.elementFromPoint(x, y);
	for (let depth = 0; depth < 16 && hit !== null && hit.shadowRoot !== null; depth++) {
		const inner = hit.shadowRoot.elementFromPoint(x, y);
		if (inner === null || inner === hit) break;
		hit = inner;
	}
	if (hit === null) return { reason: 'outside-viewport' };
	const reaches = hit === element || element.contains(hit) || hit.contains(element);
	return { reason: 'ok', occluded: !reaches, hitTag: hit.tagName.toLowerCase() };
}`;

/** Raw shape returned by {@linkcode OCCLUSION_FUNCTION}. */
interface OcclusionProbe {
	reason: OcclusionVerdict['reason'];
	occluded?: boolean;
	hitTag?: string;
}

/** Runs the occlusion check. A probe that cannot run is reported, never thrown. */
export async function checkOcclusion(handle: NodeHandle): Promise<OcclusionVerdict> {
	try {
		const probe = await callOnNode<OcclusionProbe | null>(handle, OCCLUSION_FUNCTION);
		if (probe === null) return { occluded: true, hitTag: null, reason: 'unavailable' };
		return {
			occluded: probe.reason === 'ok' ? probe.occluded === true : true,
			hitTag: probe.hitTag ?? null,
			reason: probe.reason,
		};
	} catch {
		return { occluded: true, hitTag: null, reason: 'unavailable' };
	}
}

// ---------------------------------------------------------------------------
// mouse synthesis
// ---------------------------------------------------------------------------

export interface MouseClickOptions {
	readonly client: CdpClient;
	/** The **page** session: input is dispatched to the frame tree's owner, not to an iframe. */
	readonly sessionId: SessionId;
	readonly x: number;
	readonly y: number;
	readonly button: MouseButton;
	readonly clickCount?: number;
	readonly modifiers?: number;
	/** Overrides {@linkcode MOUSE_PRESS_TIMEOUT_MS}; the default is the §8 contract tests pin. */
	readonly pressTimeoutMs?: number;
	/** Overrides {@linkcode MOUSE_RELEASE_TIMEOUT_MS}. */
	readonly releaseTimeoutMs?: number;
}

/** What the three dispatches actually did — timeouts are data, not exceptions. */
export interface MouseClickOutcome {
	readonly moveTimedOut: boolean;
	readonly pressTimedOut: boolean;
	readonly releaseTimedOut: boolean;
}

/**
 * Move → press → release, with the §8 caps on the press (3 s) and release (5 s).
 *
 * ERRATUM(M1-watchdogs-action-2): §8 fixes the two caps but not what happens when one expires. They
 * are treated as **non-fatal**: a press that does not answer inside 3 s almost always means the click
 * already did its job and the renderer is busy with the consequences (a synchronous `alert`, a
 * same-thread navigation, a heavy re-render). Aborting the action there would report a failure for a
 * click that landed, so the outcome is recorded on the result instead and the release is still
 * attempted — an un-released button would leave the page in a dragging state.
 */
export async function dispatchMouseClick(options: MouseClickOptions): Promise<MouseClickOutcome> {
	const { client, sessionId, x, y, button } = options;
	const clickCount = options.clickCount ?? 1;
	const modifiers = options.modifiers ?? 0;
	const buttons = BUTTON_BITS[button];
	const pressMs = options.pressTimeoutMs ?? MOUSE_PRESS_TIMEOUT_MS;
	const releaseMs = options.releaseTimeoutMs ?? MOUSE_RELEASE_TIMEOUT_MS;

	const moveTimedOut = await dispatch(
		() =>
			client.send.Input.dispatchMouseEvent(
				{ type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers },
				sessionId,
				{ requestTimeoutMs: Math.min(pressMs, MOUSE_MOVE_TIMEOUT_MS) },
			),
	);
	const pressTimedOut = await dispatch(
		() =>
			client.send.Input.dispatchMouseEvent(
				{ type: 'mousePressed', x, y, button, buttons, clickCount, modifiers },
				sessionId,
				{ requestTimeoutMs: pressMs },
			),
	);
	const releaseTimedOut = await dispatch(
		() =>
			client.send.Input.dispatchMouseEvent(
				{ type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers },
				sessionId,
				{ requestTimeoutMs: releaseMs },
			),
	);
	return { moveTimedOut, pressTimedOut, releaseTimedOut };
}

/**
 * The move on its own — the first third of {@linkcode dispatchMouseClick}, with nothing pressed.
 *
 * ERRATUM(E-49). A hover is the move a click already performs before it presses, so it shares the
 * cap and the timeout-is-data rule rather than inventing its own. Returns whether the move timed
 * out; like the click's, a timeout is recorded and not thrown, because a `mouseMoved` that does not
 * answer inside the cap has almost always already reached the renderer.
 */
export async function dispatchMouseMove(
	options: Pick<MouseClickOptions, 'client' | 'sessionId' | 'x' | 'y' | 'modifiers'>,
): Promise<{ moveTimedOut: boolean }> {
	const moveTimedOut = await dispatch(
		() =>
			options.client.send.Input.dispatchMouseEvent(
				{
					type: 'mouseMoved',
					x: options.x,
					y: options.y,
					button: 'none',
					buttons: 0,
					modifiers: options.modifiers ?? 0,
				},
				options.sessionId,
				{ requestTimeoutMs: MOUSE_MOVE_TIMEOUT_MS },
			),
	);
	return { moveTimedOut };
}

/** Runs one dispatch, converting only the *timeout* into a boolean; other failures still throw. */
async function dispatch(send: () => Promise<unknown>): Promise<boolean> {
	try {
		await send();
		return false;
	} catch (error) {
		if (error instanceof CdpRequestTimeoutError) return true;
		throw error;
	}
}

/** The last-resort click: `element.click()` in the page, for an element the mouse cannot reach. */
const JAVASCRIPT_CLICK_FUNCTION = `function () {
	if (typeof this.click === 'function') { this.click(); return true; }
	const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: this.ownerDocument.defaultView });
	return this.dispatchEvent(event);
}`;

/** Dispatches a real `click` from inside the page. Used when every candidate point is occluded. */
export async function javascriptClick(handle: NodeHandle): Promise<boolean> {
	return await callOnNode<boolean>(handle, JAVASCRIPT_CLICK_FUNCTION) === true;
}
