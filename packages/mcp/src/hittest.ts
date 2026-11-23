/** The hit test in the browser. */
import { type BrowserSession, type EnhancedDomTreeNode, walkTree } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import { BRAND_GUARD, brandArguments, inIsolatedWorld, isWorldMismatch, StaleWorldError } from './isolated_world.ts';
import type { SessionRecord } from './registry.ts';
import { nodeAt } from './tools/shared.ts';

/** Process boundaries a hit test descends through at most; a deeper frameset answers the frame host. */
export const HIT_TEST_MAX_DESCENT = 8;

/** The DOM `DOCUMENT_NODE` type: the ancestor walk stops here so a hit never resolves across documents. */
const DOCUMENT_NODE = 9;

/** One `DOM.getNodeForLocation` round trip, recorded verbatim so the evidence is the raw fields. */
interface HitProbe {
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
	 * When `backend_node_id` is a pseudo-element, the element it belongs to, as the browser reported it
	 * from an isolated world. Absent for every other hit.
	 */
	readonly pseudo_host_backend_node_id?: number;
}

/** How the index was reached. */
type HitResolution =
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

/** The composite key the serializer's reverse map is keyed on (`selectorKey`). */
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
 * Asks the browser what is at `(x, y)` — top-document viewport CSS px — and joins the answer to the element table the
 * session holds.
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

		const child = await oopifUnder(client, sessionId, located.backendNodeId, frames);
		if (child === null) break;
		let childSession: SessionId;
		try {
			childSession = (await manager.getOrCreateCdpSession(child.frameId as TargetId, false)).sessionId;
		} catch {
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

/** Runs on the resolved node in the isolated world. */
const PSEUDO_HOST_FUNCTION = `function (brandKey, brandNonce) { ${BRAND_GUARD} ` +
	'return typeof CSSPseudoElement === "function" && this instanceof CSSPseudoElement ? this.element : null; }';

/**
 * The `backendNodeId` of the element a pseudo-element belongs to, or `null` when `backendNodeId` is not a
 * pseudo-element or the browser cannot say.
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
				await client.send.Runtime.releaseObjectGroup({ objectGroup: PSEUDO_OBJECT_GROUP }, sessionId).catch(() => {});
			}
		});
	} catch {
		return null;
	}
}

/** The layout viewport's scroll offset of one session, read live. */
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
 * The out-of-process frame hosted by `backendNodeId`, or `null` when the node is not a frame owner or its frame is
 * captured in this same session.
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
	const frameId = described.node.frameId;
	if (frameId === undefined) return null;
	const frame = frames.find((entry) => entry.frameId === frameId);
	return frame?.isOopif === true ? { frameId } : null;
}

// --- The server-drawn highlight behind the live view's `live.highlight`. -----------------------------------------

/** `ttl_ms` bounds and default. */
export const HIGHLIGHT_TTL_DEFAULT_MS = 2000;
export const HIGHLIGHT_TTL_MIN_MS = 100;
export const HIGHLIGHT_TTL_MAX_MS = 30_000;

/** The outline colour, chosen to be visible on light and dark pages alike. */
const OUTLINE = { r: 255, g: 92, b: 0, a: 1 };
const FILL = { r: 255, g: 160, b: 0, a: 0.25 };

/** Exactly one of `index` (an element of the held table) or `bounds` (top-document viewport CSS px). */
interface HighlightTarget {
	readonly index?: number;
	readonly bounds?: { x: number; y: number; w: number; h: number };
}

/** What a highlight did, for the caller's own bookkeeping (the socket sends no reply). */
interface HighlightOutcome {
	readonly ttlMs: number;
	/** The session the overlay was drawn in — the page's, or an OOPIF's own. */
	readonly sessionId: string;
}

/** Clamps a requested TTL into the contract's bounds; absent means the default. */
export function clampTtl(ttlMs: number | undefined): number {
	if (ttlMs === undefined || !Number.isFinite(ttlMs)) return HIGHLIGHT_TTL_DEFAULT_MS;
	return Math.min(HIGHLIGHT_TTL_MAX_MS, Math.max(HIGHLIGHT_TTL_MIN_MS, Math.round(ttlMs)));
}

/** Draws the highlight and arms its expiry. */
export async function highlight(
	record: SessionRecord,
	target: HighlightTarget,
	ttlMs?: number,
): Promise<HighlightOutcome> {
	const session = record.session;
	const client = session.cdpClient;
	const manager = session.sessionManager;
	const focus = session.agentFocusTargetId;
	if (client === null || manager === null || focus === null) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	if ((target.index === undefined) === (target.bounds === undefined)) {
		throw new ToolError('invalid-arguments', 'exactly one of index or bounds is required');
	}
	const ttl = clampTtl(ttlMs);
	const page = await manager.getOrCreateCdpSession(focus, true);

	// A replacement hides the previous outline first, whichever session it was drawn in.
	await hideHighlight(record);

	let drawnIn = page.sessionId;
	const armed = async (sessionId: string): Promise<void> => {
		// Measured: the overlay refuses to draw until `Overlay.enable`, which itself refuses
		// until `DOM.enable` on the same session. Both are idempotent, and both are undone on hide.
		await client.send.DOM.enable({}, sessionId);
		await client.send.Overlay.enable(undefined, sessionId);
	};
	if (target.index !== undefined) {
		const node = nodeAt(session, target.index);
		// An OOPIF's node lives in its own session, and so does its overlay.
		if (node.targetId !== '' && node.targetId !== focus) {
			try {
				drawnIn = (await manager.getOrCreateCdpSession(node.targetId as TargetId, false)).sessionId;
			} catch {
				drawnIn = page.sessionId;
			}
		}
		await armed(drawnIn);
		await client.send.Overlay.highlightNode({
			highlightConfig: { contentColor: FILL, borderColor: OUTLINE, showInfo: false },
			backendNodeId: node.backendNodeId,
		}, drawnIn);
	} else {
		const bounds = target.bounds as { x: number; y: number; w: number; h: number };
		await armed(page.sessionId);
		await client.send.Overlay.highlightRect({
			x: Math.round(bounds.x),
			y: Math.round(bounds.y),
			width: Math.max(1, Math.round(bounds.w)),
			height: Math.max(1, Math.round(bounds.h)),
			color: FILL,
			outlineColor: OUTLINE,
		}, page.sessionId);
	}

	record.highlight = {
		sessionId: drawnIn,
		timer: setTimeout(() => void hideHighlight(record).catch(() => {}), ttl),
	};
	Deno.unrefTimer(record.highlight.timer);
	return { ttlMs: ttl, sessionId: drawnIn };
}

/** Hides the session's highlight, if any, and disarms its timer. Never throws. */
export async function hideHighlight(record: SessionRecord): Promise<void> {
	const current = record.highlight;
	if (current === undefined) return;
	record.highlight = undefined;
	clearTimeout(current.timer);
	const client = record.session.cdpClient;
	if (client === null) return;
	try {
		await client.send.Overlay.hideHighlight(undefined, current.sessionId);
		// Leave the session as it was found: an enabled overlay domain is a standing capability
		// nothing else in this process uses, and disabling it also hides anything still drawn.
		await client.send.Overlay.disable(undefined, current.sessionId);
	} catch {
		// The target may be gone; there is nothing left to hide.
	}
}
