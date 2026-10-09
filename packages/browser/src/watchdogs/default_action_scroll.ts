/**
 * @module
 * Scrolling and scroll-to-text.
 *
 * Contract owner: SPECS/ARCHITECTURE.md §6.10 — "scroll (page gesture / element wheel / iframe JS)"
 * and "scroll-to-text (`DOM.performSearch` + fallback)". `ScrollEvent` carries `direction`, an
 * `amount` in pixels, and a `node` that is `null` for the page (SPECS/DATA-MODEL.md §5.1.1).
 *
 * Every path is **wheel first, script second**. A synthesized wheel is a real input event: it fires
 * `wheel`, it is cancellable, it drives CSS scroll-snap, it moves whichever scroll container is under
 * the cursor, and infinite-scroll listeners see it. `window.scrollBy` does none of that. But a wheel
 * cannot move an element that swallows the event or is scrolled by a framework, so each path verifies
 * that the scroll offset actually changed and falls through to the script when it did not — which is
 * also why the outcome names the strategy that worked: it is the only way to tell "the page ignored
 * the wheel" from "the page has nothing left to scroll".
 */

import type { CdpClient, SessionId } from '@tykotech/cdp';
import type { ScrollDirection } from '../types.ts';
import { callOnNode, ensureDomEnabled, evaluateJson, type NodeHandle } from './default_action_dom.ts';
import type { ViewportMetrics } from './default_action_geometry.ts';

/** How many `DOM.performSearch` hits scroll-to-text inspects before giving up. */
export const SCROLL_TO_TEXT_MAX_CANDIDATES = 10;

/**
 * Frames the settle probe waits for a wheel's animation to finish before reading the offset.
 *
 * ERRATUM(M1-watchdogs-action-12): §6.10 describes the scroll paths but not that Chrome scrolls a
 * synthesized wheel **asynchronously and with animation**. Reading the offset in the same turn the
 * wheel was dispatched in reports a partial or zero delta, so the wheel looks like it failed and the
 * script fallback fires — which then fights the still-running animation and lands the page somewhere
 * neither asked for. Every path therefore settles first: poll `requestAnimationFrame` until the
 * offset is stable across two frames, capped here (~1 s at 60 Hz) so a page animating something else
 * forever cannot stall the 8 s `ScrollEvent` budget.
 */
export const SCROLL_SETTLE_MAX_FRAMES = 60;

/** Which mechanism actually moved the content — the audit surface for the three §6.10 paths. */
export type ScrollStrategy =
	| 'pageGesture'
	| 'pageScript'
	| 'elementWheel'
	| 'elementScript'
	| 'iframeScript'
	| 'none';

export interface ScrollOutcome {
	readonly strategy: ScrollStrategy;
	readonly deltaX: number;
	readonly deltaY: number;
	/** Pixels the target actually moved, summed over both axes. `0` means nothing scrolled. */
	readonly movedBy: number;
}

/** Signed wheel deltas for a direction/amount pair. CDP deltas point the way the *content* moves. */
export function scrollDeltas(direction: ScrollDirection, amount: number): { deltaX: number; deltaY: number } {
	const magnitude = Math.abs(amount);
	switch (direction) {
		case 'up':
			return { deltaX: 0, deltaY: -magnitude };
		case 'down':
			return { deltaX: 0, deltaY: magnitude };
		case 'left':
			return { deltaX: -magnitude, deltaY: 0 };
		case 'right':
			return { deltaX: magnitude, deltaY: 0 };
	}
}

/** Reads a window's scroll offsets. */
const PAGE_OFFSET_EXPRESSION = 'JSON.stringify([window.scrollX, window.scrollY])';

/** Waits for the window's scroll animation to settle, then reads the offsets. */
const PAGE_SETTLE_EXPRESSION = `new Promise(function (resolve) {
	let previous = null;
	let stable = 0;
	let frames = 0;
	function tick() {
		const current = window.scrollX + ',' + window.scrollY;
		if (current === previous) stable += 1;
		else { stable = 0; previous = current; }
		frames += 1;
		if (stable >= 2 || frames >= ${SCROLL_SETTLE_MAX_FRAMES}) {
			resolve(JSON.stringify([window.scrollX, window.scrollY]));
			return;
		}
		requestAnimationFrame(tick);
	}
	requestAnimationFrame(tick);
})`;

/** Reads an element's own scroll offsets. */
const ELEMENT_OFFSET_FUNCTION = `function () { return [this.scrollLeft, this.scrollTop]; }`;

/** Waits for an element's scroll animation to settle, then reads its offsets. */
const ELEMENT_SETTLE_FUNCTION = `function () {
	const element = this;
	return new Promise(function (resolve) {
		let previous = null;
		let stable = 0;
		let frames = 0;
		function tick() {
			const current = element.scrollLeft + ',' + element.scrollTop;
			if (current === previous) stable += 1;
			else { stable = 0; previous = current; }
			frames += 1;
			if (stable >= 2 || frames >= ${SCROLL_SETTLE_MAX_FRAMES}) {
				resolve([element.scrollLeft, element.scrollTop]);
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}`;

/** Scrolls an element by a delta, preferring the element's own scroll box. */
const ELEMENT_SCROLL_FUNCTION = `function (deltaX, deltaY) {
	if (typeof this.scrollBy === 'function') this.scrollBy(deltaX, deltaY);
	else { this.scrollLeft += deltaX; this.scrollTop += deltaY; }
	return [this.scrollLeft, this.scrollTop];
}`;

async function readPageOffsets(client: CdpClient, sessionId: SessionId): Promise<[number, number]> {
	const raw = await evaluateJson<string>(client, sessionId, PAGE_OFFSET_EXPRESSION);
	const parsed = JSON.parse(raw) as [number, number];
	return [parsed[0] ?? 0, parsed[1] ?? 0];
}

/** Post-wheel read: waits out the scroll animation first (see {@linkcode SCROLL_SETTLE_MAX_FRAMES}). */
async function settlePageOffsets(client: CdpClient, sessionId: SessionId): Promise<[number, number]> {
	try {
		const raw = await evaluateJson<string>(client, sessionId, PAGE_SETTLE_EXPRESSION);
		const parsed = JSON.parse(raw) as [number, number];
		return [parsed[0] ?? 0, parsed[1] ?? 0];
	} catch {
		// A page without `requestAnimationFrame` (or one that navigated mid-scroll): read plainly.
		return await readPageOffsets(client, sessionId);
	}
}

async function dispatchWheel(
	client: CdpClient,
	sessionId: SessionId,
	x: number,
	y: number,
	deltaX: number,
	deltaY: number,
): Promise<void> {
	await client.send.Input.dispatchMouseEvent({
		type: 'mouseWheel',
		x,
		y,
		button: 'none',
		deltaX,
		deltaY,
		pointerType: 'mouse',
	}, sessionId);
}

/**
 * The page gesture: a wheel at the viewport centre, then `window.scrollBy` if nothing moved.
 *
 * The centre matters — a wheel at `(0, 0)` lands on whatever sticky header or nav rail occupies the
 * corner and scrolls *that* instead of the document.
 */
export async function scrollPage(options: {
	readonly client: CdpClient;
	readonly sessionId: SessionId;
	readonly direction: ScrollDirection;
	readonly amount: number;
	readonly metrics: ViewportMetrics;
}): Promise<ScrollOutcome> {
	const { client, sessionId, metrics } = options;
	const { deltaX, deltaY } = scrollDeltas(options.direction, options.amount);
	const [beforeX, beforeY] = await readPageOffsets(client, sessionId);

	await dispatchWheel(client, sessionId, metrics.width / 2, metrics.height / 2, deltaX, deltaY);
	let [afterX, afterY] = await settlePageOffsets(client, sessionId);
	let moved = Math.abs(afterX - beforeX) + Math.abs(afterY - beforeY);
	if (moved > 0) return { strategy: 'pageGesture', deltaX, deltaY, movedBy: moved };

	await evaluateJson<unknown>(client, sessionId, `window.scrollBy(${deltaX}, ${deltaY})`);
	[afterX, afterY] = await settlePageOffsets(client, sessionId);
	moved = Math.abs(afterX - beforeX) + Math.abs(afterY - beforeY);
	return { strategy: moved > 0 ? 'pageScript' : 'none', deltaX, deltaY, movedBy: moved };
}

/**
 * The element path: a wheel positioned over the element, then the element's own `scrollBy`.
 *
 * `point` is in main-frame viewport coordinates (the click cascade's geometry chain produced it);
 * `null` means the element has no reachable geometry, so only the script path is available.
 */
export async function scrollElement(options: {
	readonly handle: NodeHandle;
	readonly pageSessionId: SessionId;
	readonly point: { x: number; y: number } | null;
	readonly direction: ScrollDirection;
	readonly amount: number;
}): Promise<ScrollOutcome> {
	const { handle, point } = options;
	const { deltaX, deltaY } = scrollDeltas(options.direction, options.amount);
	const before = await callOnNode<[number, number]>(handle, ELEMENT_OFFSET_FUNCTION);

	if (point !== null) {
		await dispatchWheel(handle.client, options.pageSessionId, point.x, point.y, deltaX, deltaY);
		const after = await callOnNode<[number, number]>(handle, ELEMENT_SETTLE_FUNCTION);
		const moved = offsetDelta(before, after);
		if (moved > 0) return { strategy: 'elementWheel', deltaX, deltaY, movedBy: moved };
	}

	const scrolled = await callOnNode<[number, number]>(handle, ELEMENT_SCROLL_FUNCTION, [deltaX, deltaY]);
	const moved = offsetDelta(before, scrolled);
	return { strategy: moved > 0 ? 'elementScript' : 'none', deltaX, deltaY, movedBy: moved };
}

/**
 * The iframe path: script inside the frame's own session.
 *
 * A wheel dispatched to the page session scrolls whatever is under the cursor in the *main* frame's
 * coordinate space, which for a cross-process iframe is the wrong document entirely — the child
 * renderer never sees the event. Scripting the child session is the only path that reaches it.
 */
export async function scrollFrame(options: {
	readonly client: CdpClient;
	readonly frameSessionId: SessionId;
	readonly direction: ScrollDirection;
	readonly amount: number;
}): Promise<ScrollOutcome> {
	const { client, frameSessionId } = options;
	const { deltaX, deltaY } = scrollDeltas(options.direction, options.amount);
	const [beforeX, beforeY] = await readPageOffsets(client, frameSessionId);
	await evaluateJson<unknown>(client, frameSessionId, `window.scrollBy(${deltaX}, ${deltaY})`);
	const [afterX, afterY] = await settlePageOffsets(client, frameSessionId);
	const moved = Math.abs(afterX - beforeX) + Math.abs(afterY - beforeY);
	return { strategy: moved > 0 ? 'iframeScript' : 'none', deltaX, deltaY, movedBy: moved };
}

/** Scrolls the document inside a same-origin `<iframe>` element, from the parent's session. */
const FRAME_ELEMENT_SCROLL_FUNCTION = `function (deltaX, deltaY) {
	const view = this.contentWindow;
	if (view === null) return null;
	const before = [view.scrollX, view.scrollY];
	view.scrollBy(deltaX, deltaY);
	return [before[0], before[1], view.scrollX, view.scrollY];
}`;

/**
 * The same-process iframe path: script the child document through the element's `contentWindow`.
 *
 * A same-process frame has no session of its own, so {@linkcode scrollFrame} cannot reach it, and a
 * wheel dispatched over the `<iframe>` element scrolls whatever the hit test finds — often the parent
 * document, because the frame's own scrollable area is not where the cursor landed. Cross-origin
 * frames deny `contentWindow` access and report `strategy: 'none'`; those arrive as OOPIFs with their
 * own session anyway.
 */
export async function scrollFrameElement(
	handle: NodeHandle,
	direction: ScrollDirection,
	amount: number,
): Promise<ScrollOutcome> {
	const { deltaX, deltaY } = scrollDeltas(direction, amount);
	try {
		const offsets = await callOnNode<[number, number, number, number] | null>(
			handle,
			FRAME_ELEMENT_SCROLL_FUNCTION,
			[deltaX, deltaY],
		);
		if (offsets === null) return { strategy: 'none', deltaX, deltaY, movedBy: 0 };
		const moved = Math.abs((offsets[2] ?? 0) - (offsets[0] ?? 0)) + Math.abs((offsets[3] ?? 0) - (offsets[1] ?? 0));
		return { strategy: moved > 0 ? 'iframeScript' : 'none', deltaX, deltaY, movedBy: moved };
	} catch {
		// Cross-origin `contentWindow` access throws a SecurityError inside the page.
		return { strategy: 'none', deltaX, deltaY, movedBy: 0 };
	}
}

function offsetDelta(before: [number, number] | null, after: [number, number] | null): number {
	if (before === null || after === null) return 0;
	return Math.abs((after[0] ?? 0) - (before[0] ?? 0)) + Math.abs((after[1] ?? 0) - (before[1] ?? 0));
}

// ---------------------------------------------------------------------------
// scroll-to-text
// ---------------------------------------------------------------------------

/** Which mechanism found the text. */
export type ScrollToTextStrategy = 'performSearch' | 'textWalker';

export interface ScrollToTextResult {
	readonly found: boolean;
	readonly strategy: ScrollToTextStrategy | null;
	/** Candidates the search produced, before direction filtering. */
	readonly candidates: number;
}

/** Page-absolute top edge of a node (or of a text node's parent element). */
const NODE_TOP_FUNCTION = `function () {
	const element = this.nodeType === 1 ? this : this.parentElement;
	if (element === null) return null;
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 && rect.height <= 0) return null;
	const view = element.ownerDocument.defaultView;
	return rect.top + (view === null ? 0 : view.scrollY);
}`;

/**
 * The fallback walker: first visible element whose own text contains the query, scrolled into view.
 *
 * `DOM.performSearch` matches attributes and markup as well as rendered text, and misses text inside
 * a closed shadow root; this walks what the user can actually read. Direction picks the first match
 * below (or the last above) the current scroll offset.
 */
const TEXT_WALKER_FUNCTION = `(function (needle, direction) {
	const wanted = needle.toLowerCase();
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	const hits = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const text = (node.textContent || '').toLowerCase();
		if (!text.includes(wanted)) continue;
		const element = node.parentElement;
		if (element === null) continue;
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0 && rect.height <= 0) continue;
		const style = getComputedStyle(element);
		if (style.visibility === 'hidden' || style.display === 'none') continue;
		hits.push({ element: element, top: rect.top + window.scrollY });
	}
	if (hits.length === 0) return JSON.stringify({ found: false, candidates: 0 });
	let chosen = hits[0];
	if (direction === 'down') chosen = hits.find(function (hit) { return hit.top > window.scrollY; }) || hits[0];
	if (direction === 'up') {
		const above = hits.filter(function (hit) { return hit.top < window.scrollY; });
		chosen = above.length > 0 ? above[above.length - 1] : hits[0];
	}
	chosen.element.scrollIntoView({ block: 'center', inline: 'nearest' });
	return JSON.stringify({ found: true, candidates: hits.length });
})`;

/**
 * `DOM.performSearch` → pick a candidate honouring `direction` → `DOM.scrollIntoViewIfNeeded`, then
 * the text walker when the search found nothing usable.
 *
 * ERRATUM(M1-watchdogs-action-8): §5.1.1 gives `ScrollToTextEvent` an optional `direction` without
 * saying what it does. It **orders candidates relative to the current scroll offset** — `'down'`
 * takes the first match below the fold, `'up'` the last match above it — which is the only reading
 * under which "find the next occurrence in this direction" behaves like a reader's expectation.
 * `'left'`/`'right'` carry no vertical ordering and fall through to document order.
 */
export async function scrollToText(options: {
	readonly client: CdpClient;
	readonly sessionId: SessionId;
	readonly text: string;
	readonly direction: ScrollDirection | null;
}): Promise<ScrollToTextResult> {
	const { client, sessionId, text } = options;
	const viaSearch = await searchAndScroll(client, sessionId, text, options.direction);
	if (viaSearch.found) return viaSearch;

	const expression = `${TEXT_WALKER_FUNCTION}(${JSON.stringify(text)}, ${JSON.stringify(options.direction)})`;
	try {
		const raw = await evaluateJson<string>(client, sessionId, expression);
		const parsed = JSON.parse(raw) as { found: boolean; candidates: number };
		return {
			found: parsed.found,
			strategy: parsed.found ? 'textWalker' : null,
			candidates: viaSearch.candidates + parsed.candidates,
		};
	} catch {
		return { found: false, strategy: null, candidates: viaSearch.candidates };
	}
}

async function searchAndScroll(
	client: CdpClient,
	sessionId: SessionId,
	text: string,
	direction: ScrollDirection | null,
): Promise<ScrollToTextResult> {
	await ensureDomEnabled(client, sessionId);
	let searchId: string | null = null;
	try {
		// `getSearchResults` hands back nodeIds, which only exist once the document has been requested.
		await client.send.DOM.getDocument({ depth: 0 }, sessionId);
		const search = await client.send.DOM.performSearch({ query: text }, sessionId);
		searchId = search.searchId;
		if (search.resultCount === 0) return { found: false, strategy: null, candidates: 0 };

		const limit = Math.min(search.resultCount, SCROLL_TO_TEXT_MAX_CANDIDATES);
		const results = await client.send.DOM.getSearchResults({ searchId, fromIndex: 0, toIndex: limit }, sessionId);
		const scrollY = (await readPageOffsets(client, sessionId))[1];

		const candidates: { nodeId: number; backendNodeId: number; top: number }[] = [];
		for (const nodeId of results.nodeIds) {
			try {
				const described = await client.send.DOM.describeNode({ nodeId }, sessionId);
				const handle: NodeHandle = { client, sessionId, backendNodeId: described.node.backendNodeId };
				const top = await callOnNode<number | null>(handle, NODE_TOP_FUNCTION);
				if (top === null) continue;
				candidates.push({ nodeId, backendNodeId: described.node.backendNodeId, top });
			} catch {
				// A search hit inside a detached or cross-process subtree: skip it, try the next.
			}
		}
		if (candidates.length === 0) return { found: false, strategy: null, candidates: 0 };

		const chosen = chooseCandidate(candidates, scrollY, direction);
		await client.send.DOM.scrollIntoViewIfNeeded({ backendNodeId: chosen.backendNodeId }, sessionId);
		return { found: true, strategy: 'performSearch', candidates: candidates.length };
	} catch {
		return { found: false, strategy: null, candidates: 0 };
	} finally {
		if (searchId !== null) {
			try {
				await client.send.DOM.discardSearchResults({ searchId }, sessionId);
			} catch {
				// The document navigated away; the search results went with it.
			}
		}
	}
}

/** Direction ordering, exported so the rule is testable without a browser. */
export function chooseCandidate<T extends { top: number }>(
	candidates: readonly T[],
	scrollY: number,
	direction: ScrollDirection | null,
): T {
	const first = candidates[0] as T;
	if (direction === 'down') return candidates.find((candidate) => candidate.top > scrollY) ?? first;
	if (direction === 'up') {
		const above = candidates.filter((candidate) => candidate.top < scrollY);
		return above[above.length - 1] ?? first;
	}
	return first;
}
