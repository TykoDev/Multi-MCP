/**
 * The hit test in the browser (B2.1; `report_architecture.md` §5.4).
 *
 * `browser_element_at` and the live view's `live.hover` both answer "what is under this point" by
 * asking Chromium — `DOM.getNodeForLocation` — rather than by searching the cached element table
 * for the nearest composed rectangle. The browser's answer is transform-correct, occlusion-correct
 * and stacking-correct by construction; the composed `bounds` B1.5 demoted to descriptive never
 * enter it, and no coordinate arithmetic over element geometry happens here.
 *
 * **What U-2 measured, and the one translation this module does perform.** On real Chromium the
 * page session's hit test does not pierce an out-of-process frame: for a point inside an OOPIF it
 * returns the host `<iframe>` element, in the top document's id space, because the child renderer
 * is another process. Same-process frames *are* pierced (Chromium hit-tests local child frames
 * itself). So for an OOPIF this module descends one level per process boundary: it reads the host
 * element's **live content box** from the browser (`DOM.getBoxModel`, the same primitive the click
 * cascade trusts for a top-document element), subtracts that origin so the point is in the child's
 * own viewport space, and repeats the hit test in the child's session. That is a frame-origin
 * translation from a live read, not the composed-bounds arithmetic the contract removed: the
 * element is still found by the browser, in its own frame, and the resolved id is the child
 * session's — which is exactly what the serializer's `reverseMap` is keyed on.
 *
 * **The second thing U-2 measured: `DOM.getNodeForLocation` takes *document* coordinates, not
 * viewport coordinates.** With the main document scrolled 307 px, a viewport point resolved the
 * element 307 px above the one under it; adding the layout viewport's `pageY` resolved the right
 * one. The tool's contract is top-document viewport CSS px (§10's one system, the same space as
 * `bounds`), so every level adds that session's **live** scroll offset — `Page.getLayoutMetrics`,
 * read in the same session immediately before the hit test — before asking. That is the
 * primitive's own coordinate space, read from the browser; the cached state is never consulted for
 * it. Under a visual viewport scale other than 1 the layout and visual scrolls diverge (architecture
 * §5.3 case 2); the layout viewport is used, which is the document space the primitive hit-tests in.
 *
 * The `backendNodeId` the browser returns is joined to the LLM index through the composite key the
 * serializer uses (`sessionId:backendNodeId`); this is that map's first production consumer. A hit
 * on a non-interactive descendant (the text inside a button, the icon inside a link) resolves to
 * its nearest indexed ancestor within the same document, which is what "the interactive element at
 * this point" means to a caller. Nothing here writes to the event ring.
 *
 * **A1: when the browser's node is not in the table at all.** Two measured cases used to answer `none`
 * where a click lands on a control (W1 probes, 2026-10-04):
 *
 * - A control under a `pointer-events: none` cover. Chromium hit-tests through the cover and names the
 *   control, but the serializer's paint-order filter treated the cover as an occluder and never indexed
 *   it. That is repaired at its cause, in the serializer (ERRATUM(E-76)): the control is now indexed and
 *   resolves `direct` here.
 * - A pseudo-element. `DOM.getNodeForLocation` answers the `::before`/`::after` box itself — an icon
 *   font's glyph inside a button, a "stretched link" overlay, a modal backdrop — and pseudo-elements are
 *   not in the merged tree, so the ancestor walk had nowhere to start. The browser is asked which element
 *   the pseudo-element belongs to ({@linkcode pseudoHost}), and that element enters the same
 *   direct/ancestor join; a pseudo-element is its element's child, so the answer reads `ancestor`. A
 *   backdrop drawn by a non-interactive element therefore still answers `none` — a click there lands on
 *   that element, not on the control beneath it.
 *
 * The design (report_design.md §2.10, A1) also named a search of the element records by bounds and paint
 * order for an indexed **descendant**. It is deliberately not taken: a descendant the browser did not hit is
 * one a click at this point does not reach (a clipped item, the gap between a wrapped link's line boxes),
 * and composed bounds are not clip-correct — answering it would put back the geometry this module was
 * built to keep out. Every answer here is still the browser's.
 */
import type { BrowserSession, EnhancedDomTreeNode } from '@tykotech/browser';
import { walkTree } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import { BRAND_GUARD, brandArguments, inIsolatedWorld, isWorldMismatch, StaleWorldError } from './isolated_world.ts';
import type { SessionRecord } from './registry.ts';

/** Process boundaries a hit test descends through at most; a deeper frameset answers the frame host. */
export const HIT_TEST_MAX_DESCENT = 8;

/** The DOM `DOCUMENT_NODE` type: the ancestor walk stops here so a hit never resolves across documents. */
const DOCUMENT_NODE = 9;

/** One `DOM.getNodeForLocation` round trip, recorded verbatim so the U-2 evidence is the raw fields. */
export interface HitProbe {
	readonly session_id: string;
	/** The point in the session's own viewport CSS px. */
	readonly x: number;
	readonly y: number;
	/** The layout viewport's live scroll offset, read from the browser and added before the hit test. */
	readonly scroll: { readonly x: number; readonly y: number };
	/** The point actually sent: document CSS px, which is the coordinate space the primitive uses. */
	readonly document: { readonly x: number; readonly y: number };
	/** `frameId` as the browser returned it. */
	readonly frame_id: string;
	/** `backendNodeId` as the browser returned it, in `session_id`'s space. */
	readonly backend_node_id: number;
	/**
	 * A1: when `backend_node_id` is a pseudo-element, the element it belongs to, as the browser reported it
	 * from an isolated world. Absent for every other hit.
	 */
	readonly pseudo_host_backend_node_id?: number;
}

/** How the index was reached. */
export type HitResolution =
	/** The browser's node is itself in the element table. */
	| 'direct'
	/** The browser's node is a descendant of an indexed element in the same document. */
	| 'ancestor'
	/** The browser named a node, but nothing indexed contains it (page chrome, static text). */
	| 'none'
	/** The browser found no node at the point (outside the document). */
	| 'no-node';

export interface HitTest {
	readonly probes: readonly HitProbe[];
	readonly resolution: HitResolution;
	/** The LLM index, or `null` when nothing interactive is there. */
	readonly index: number | null;
	readonly node: EnhancedDomTreeNode | null;
	/** The frame the hit landed in — the resolved node's frame, else the browser's `frameId`; `null` for no node. */
	readonly frameId: string | null;
}

/** The composite key the serializer's reverse map is keyed on (`selectorKey`, R6.3). */
function keyOf(sessionId: string, backendNodeId: number): string {
	return `${sessionId}:${backendNodeId}`;
}

/** The connected session pieces, or a `browser-unavailable` refusal. */
function connected(session: BrowserSession) {
	const client = session.cdpClient;
	const manager = session.sessionManager;
	const focus = session.agentFocusTargetId;
	if (client === null || manager === null || focus === null) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	return { client, manager, focus };
}

/** True for Chromium's "no node at the given location" refusal, which is an answer rather than a fault. */
function isNoNodeError(cause: unknown): boolean {
	const message = cause instanceof Error ? cause.message : String(cause);
	return /no node .*location|could not compute|not found/i.test(message);
}

/**
 * Asks the browser what is at `(x, y)` — top-document viewport CSS px — and joins the answer to the
 * element table the session holds.
 *
 * Read-only: nothing is dispatched to the page and nothing is written to the ring. The table it
 * joins against is the cached one, so a page that moved since the last `browser_get_state` can
 * answer `null` for a point that is visibly on a control; the caller re-reads the state, which is
 * the same contract every index-taking tool has.
 */
export async function hitTest(record: SessionRecord, x: number, y: number): Promise<HitTest> {
	const session = record.session;
	const { client, manager, focus } = connected(session);
	const state = session.cachedBrowserState;
	const frames = state?.frames ?? [];
	const page = await manager.getOrCreateCdpSession(focus, true);

	const probes: HitProbe[] = [];
	let sessionId: SessionId = page.sessionId;
	let px = x;
	let py = y;
	let located: { backendNodeId: number; frameId: string } | null = null;

	for (let depth = 0; depth <= HIT_TEST_MAX_DESCENT; depth++) {
		const scroll = await liveScroll(client, sessionId);
		const document = { x: Math.round(px + scroll.x), y: Math.round(py + scroll.y) };
		try {
			located = await client.send.DOM.getNodeForLocation(
				{ x: document.x, y: document.y, includeUserAgentShadowDOM: false },
				sessionId,
			);
		} catch (cause) {
			if (cause instanceof ToolError) throw cause;
			if (isNoNodeError(cause)) {
				return { probes, resolution: 'no-node', index: null, node: null, frameId: null };
			}
			throw new ToolError('browser-unavailable', cause instanceof Error ? cause.message : String(cause));
		}
		probes.push({
			session_id: sessionId,
			x: px,
			y: py,
			scroll,
			document,
			frame_id: located.frameId,
			backend_node_id: located.backendNodeId,
		});

		// An out-of-process child frame under the point: the browser returned its host element (it
		// cannot pierce another renderer), so descend into the child's own session. Same-process
		// frames never reach this branch — Chromium's own hit test already pierced them.
		const child = await oopifUnder(client, sessionId, located.backendNodeId, frames);
		if (child === null) break;
		let childSession: SessionId;
		try {
			childSession = (await manager.getOrCreateCdpSession(child.frameId as TargetId, false)).sessionId;
		} catch {
			// The child target detached since the capture; the host element is the honest answer.
			break;
		}
		let box: { x: number; y: number } | null = null;
		try {
			const model = await client.send.DOM.getBoxModel({ backendNodeId: located.backendNodeId }, sessionId);
			const content = model.model.content;
			box = { x: content[0] ?? 0, y: content[1] ?? 0 };
		} catch {
			break;
		}
		sessionId = childSession;
		px -= box.x;
		py -= box.y;
	}
	if (located === null) return { probes, resolution: 'no-node', index: null, node: null, frameId: null };

	// Join to the element table through the serializer's own key.
	const reverse = new Map<string, number>();
	for (const [index, node] of state?.domState.selectorMap ?? []) {
		reverse.set(keyOf(node.sessionId, node.backendNodeId), index);
	}
	const hitKey = keyOf(sessionId, located.backendNodeId);
	const direct = reverse.get(hitKey);
	if (direct !== undefined) {
		const node = state?.domState.selectorMap.get(direct) ?? null;
		return { probes, resolution: 'direct', index: direct, node, frameId: node?.frameId ?? located.frameId };
	}

	// Not indexed itself: the nearest indexed ancestor in the same document, found over the cached
	// merged tree (an in-memory walk over data already held — no CDP call, no geometry).
	const root = state?.domState.root?.originalNode ?? null;
	const inTree = (key: string): EnhancedDomTreeNode | null => {
		if (root === null) return null;
		for (const candidate of walkTree(root)) {
			if (keyOf(candidate.sessionId, candidate.backendNodeId) === key) return candidate;
		}
		return null;
	};
	let cursor = inTree(hitKey);
	if (cursor === null) {
		// A1: absent from the tree. A pseudo-element is the measured case; its element is asked for and
		// joined like any other node, starting with the element itself. A node newer than the capture has no
		// element to name and falls through to `none`, which is the stale-table contract above.
		const host = await pseudoHost(record, client, sessionId, located.frameId, located.backendNodeId);
		if (host !== null) {
			const last = probes.length - 1;
			const probe = probes[last];
			if (probe !== undefined) probes[last] = { ...probe, pseudo_host_backend_node_id: host };
			const hostKey = keyOf(sessionId, host);
			const hostIndex = reverse.get(hostKey);
			if (hostIndex !== undefined) {
				const node = state?.domState.selectorMap.get(hostIndex) ?? null;
				return { probes, resolution: 'ancestor', index: hostIndex, node, frameId: node?.frameId ?? located.frameId };
			}
			cursor = inTree(hostKey);
		}
	}
	while (cursor !== null) {
		cursor = cursor.parentNode;
		if (cursor === null || cursor.nodeType === DOCUMENT_NODE) break;
		const index = reverse.get(keyOf(cursor.sessionId, cursor.backendNodeId));
		if (index !== undefined) {
			return { probes, resolution: 'ancestor', index, node: cursor, frameId: cursor.frameId };
		}
	}
	return { probes, resolution: 'none', index: null, node: null, frameId: located.frameId };
}

/** Object group for the handles {@linkcode pseudoHost} allocates; released in one call. */
const PSEUDO_OBJECT_GROUP = 'ttk-hit-test';

/**
 * Runs on the resolved node in the isolated world. `CSSPseudoElement` and its `element` getter are that
 * world's own, so the page cannot answer for them; anything that is not a pseudo-element answers `null`.
 *
 * It first proves it IS that world (R3-2): the brand the world was created with is checked in this same
 * evaluation, so a cached id that a cross-process navigation handed to a page's main world throws rather than
 * answering with that page's getter.
 */
const PSEUDO_HOST_FUNCTION = `function (brandKey, brandNonce) { ${BRAND_GUARD} ` +
	'return typeof CSSPseudoElement === "function" && this instanceof CSSPseudoElement ? this.element : null; }';

/**
 * The `backendNodeId` of the element a pseudo-element belongs to, or `null` when `backendNodeId` is not a
 * pseudo-element or the browser cannot say.
 *
 * Three browser reads, all in `frameId`'s cached, branded isolated world (see `isolated_world.ts` for why not
 * the main world, and why a cached id is never trusted unproven): `DOM.resolveNode` for a handle,
 * `CSSPseudoElement.element` (behind the brand check) for the originating element, and
 * `DOM.describeNode` for that element's id. Never a guess from geometry, and never fatal: any failure is
 * "cannot say", which leaves the hit test answering what it answered before A1.
 */
async function pseudoHost(
	record: SessionRecord,
	client: BrowserSession['cdpClient'] & object,
	sessionId: SessionId,
	frameId: string,
	backendNodeId: number,
): Promise<number | null> {
	try {
		return await inIsolatedWorld(record, client, sessionId, frameId, async (world) => {
			try {
				const resolved = await client.send.DOM.resolveNode(
					{ backendNodeId, executionContextId: world.contextId, objectGroup: PSEUDO_OBJECT_GROUP },
					sessionId,
				);
				// The class name is the wrapper's interface name as V8 reports it, which page script cannot set, so a
				// node that is not a pseudo-element is answered without running anything in the world.
				if (resolved.object.className !== 'CSSPseudoElement' || resolved.object.objectId === undefined) return null;
				const element = await client.send.Runtime.callFunctionOn({
					functionDeclaration: PSEUDO_HOST_FUNCTION,
					objectId: resolved.object.objectId,
					arguments: brandArguments(world.brand),
					objectGroup: PSEUDO_OBJECT_GROUP,
					silent: true,
				}, sessionId);
				if (isWorldMismatch(element.exceptionDetails)) throw new StaleWorldError();
				if (element.exceptionDetails !== undefined || element.result.objectId === undefined) return null;
				const described = await client.send.DOM.describeNode({ objectId: element.result.objectId }, sessionId);
				return described.node.backendNodeId;
			} finally {
				// The handles are this read's alone; a renderer that went away freed them by going away.
				await client.send.Runtime.releaseObjectGroup({ objectGroup: PSEUDO_OBJECT_GROUP }, sessionId).catch(() => {});
			}
		});
	} catch {
		return null;
	}
}

/**
 * The layout viewport's scroll offset of one session, read live. A session that cannot answer
 * (a frame mid-navigation) reads as unscrolled rather than failing the hit test.
 */
async function liveScroll(
	client: BrowserSession['cdpClient'] & object,
	sessionId: SessionId,
): Promise<{ x: number; y: number }> {
	try {
		const metrics = await client.send.Page.getLayoutMetrics(undefined, sessionId);
		const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport;
		return { x: layout.pageX, y: layout.pageY };
	} catch {
		return { x: 0, y: 0 };
	}
}

/**
 * The out-of-process frame hosted by `backendNodeId`, or `null` when the node is not a frame owner
 * or its frame is captured in this same session.
 *
 * `DOM.describeNode` reports `frameId` on frame-owner elements only — `<iframe>`, `<frame>`, `<object>`,
 * `<embed>` alike — and the state's own frame list says whether that frame lives in another renderer — the two
 * facts that decide a descent.
 */
async function oopifUnder(
	client: BrowserSession['cdpClient'] & object,
	sessionId: SessionId,
	backendNodeId: number,
	frames: ReadonlyArray<{ frameId: string; isOopif: boolean }>,
): Promise<{ frameId: string } | null> {
	let described: { node: { frameId?: string } };
	try {
		described = await client.send.DOM.describeNode({ backendNodeId }, sessionId);
	} catch {
		return null;
	}
	// Every frame owner, not a list of tag names (R3-1): `<object>`/`<embed>` (and `<fencedframe>`) carry a
	// `frameId` exactly as `<iframe>` does, and their out-of-process content is hit-tested the same way.
	const frameId = described.node.frameId;
	if (frameId === undefined) return null;
	const frame = frames.find((entry) => entry.frameId === frameId);
	return frame?.isOopif === true ? { frameId } : null;
}
