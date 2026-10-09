/**
 * The three-tree merge — `DOM` × `DOMSnapshot` × `Accessibility`, joined on `backendNodeId`.
 *
 * Contract: SPECS/DATA-MODEL.md §6.1 (field-by-field provenance of `EnhancedDomTreeNode`), §6.2.
 *
 * Parity risk R1 lives here. Every heuristic below is named, tested against a recorded fixture, and
 * listed in the module's test file — the LLM-visible text is downstream of these decisions, so silent
 * drift is indistinguishable from a behaviour change.
 */

import { v7 } from '@std/uuid';
import type {
	DomRect,
	EnhancedAxNode,
	EnhancedDomTreeNode,
	EnhancedSnapshotNode,
	HiddenElementInfo,
	NodeType,
	ShadowRootType,
} from './types.ts';
import { getOffscreenTextForLlm, isFrameTag, tagName } from './derived.ts';
import { decodeAxTree, type DecodedAxTree } from './extract_ax.ts';
import { type DecodedSnapshot, type DecodedSnapshotDocument, decodeSnapshot } from './extract_snapshot.ts';
import type { CapturedDomNode, CapturedSession, DomCapture, ListenerCensus } from './extract_capture.ts';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const KNOWN_NODE_TYPES: ReadonlySet<number> = new Set([1, 3, 8, 9, 10, 11]);

/**
 * Vertical slack on the frame-chain viewport test, in CSS px (DATA-MODEL §6.1).
 *
 * One viewport of pre-render on each side: content the user would reach with a single scroll counts as
 * visible, so the LLM can act on it without a scroll round trip, while content pages away does not.
 */
export const VIEWPORT_VERTICAL_SLACK_PX = 1000;

/** `hiddenElementsInfo` is capped at 10 entries, sorted by distance (DATA-MODEL §6.4). */
export const MAX_HIDDEN_ELEMENT_HINTS = 10;

/** Text carried in a hidden-element hint is truncated to this many chars. */
export const HIDDEN_HINT_TEXT_LIMIT = 100;

/** Tags that are interactive by their own definition, independent of any listener. */
export const NATIVELY_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
	'A',
	'BUTTON',
	'INPUT',
	'SELECT',
	'TEXTAREA',
	'SUMMARY',
	'OPTION',
	'LABEL',
	'DETAILS',
]);

/** Result of {@linkcode mergeDomTrees}. */
export interface MergedDomTree {
	/** The root `#document` of the root session, or `null` when the capture carried no sessions. */
	readonly root: EnhancedDomTreeNode | null;
	/**
	 * `${sessionId}:${backendNodeId}` → node.
	 *
	 * The composite key is not decoration: `backendNodeId` restarts per session (verified — an OOPIF's
	 * document root is `backendNodeId` 1 while its host page is well past that), so the pair is the
	 * only globally unique handle. It is also exactly the identity R6.2's new-element marking and
	 * R6.3's reverse map are defined over.
	 */
	readonly byKey: ReadonlyMap<string, EnhancedDomTreeNode>;
	readonly nodeCount: number;
	readonly warnings: readonly string[];
	/**
	 * ERRATUM(E-40). One record per frame the merge walked, root first, in document order — the frame
	 * list `browser_get_frames` and the state root's `frames[]` publish. Built here because this is the
	 * one place that knows, per frame, whether the geometry composition of `#childFrameContext` was
	 * established or silently fell back to the page origin (`composed`).
	 */
	readonly frames: readonly FrameRecord[];
	/**
	 * ERRATUM(E-40). True when the capture stopped at `MAX_CAPTURE_SESSIONS` and deeper OOPIFs are
	 * absent from this tree. Before this flag the overrun was a warning string nothing merged into
	 * `browserErrors`, so a missing element inside a deep frame was unexplainable from the wire.
	 */
	readonly captureTruncated: boolean;
}

/**
 * ERRATUM(E-40). One frame of the merged tree, as the wire publishes it.
 *
 * `composed` is architecture §5.5's honesty marker: `false` when this frame's snapshot document was
 * missing or its host had no `absolutePosition` — the two cases where `#childFrameContext` falls back
 * to a zero offset and the whole subtree stacks at the page origin. Elements inside such a frame still
 * carry geometry, and it is still what the action path uses, but a client is told the composition is
 * not established rather than left to discover it.
 */
export interface FrameRecord {
	/** CDP `frameId` — the join key for `EnhancedDomTreeNode.frameId`. */
	readonly frameId: string;
	/** `null` for the top document. */
	readonly parentFrameId: string | null;
	/** The frame's own document URL, in full; `''` when the frame's content was not captured. */
	readonly url: string;
	/** The host element's `name` attribute; `''` for the top document or an unnamed frame. */
	readonly name: string;
	/** Page-absolute box of the host `<iframe>` element; `null` for the top document or when unknown. */
	readonly hostBounds: DomRect | null;
	/** True when the frame lives in its own renderer and was captured as its own CDP session. */
	readonly isOopif: boolean;
	/** False when the frame is out-of-process and no session was captured for it. */
	readonly captured: boolean;
	readonly composed: boolean;
}

/** Options for {@linkcode mergeDomTrees}. */
export interface MergeOptions {
	/** Overrides {@linkcode VIEWPORT_VERTICAL_SLACK_PX}; exposed for tests, not for tuning. */
	readonly verticalSlackPx?: number;
}

/** The composite node key: `${sessionId}:${backendNodeId}`. */
export function nodeKey(sessionId: string, backendNodeId: number): string {
	return `${sessionId}:${backendNodeId}`;
}

interface SessionIndex {
	readonly session: CapturedSession;
	readonly snapshot: DecodedSnapshot;
	readonly ax: DecodedAxTree;
}

interface FrameContext {
	readonly index: SessionIndex;
	/** Page-absolute origin of this frame's content box, CSS px. */
	readonly offsetX: number;
	readonly offsetY: number;
	/** Page-absolute rect this frame can actually show, already intersected with every ancestor. */
	readonly visibleRect: DomRect;
	readonly frameId: string;
	/** Census frame path within this session (`''` = top document). */
	readonly framePath: string;
	readonly depth: number;
	/** `querySelectorAll('*')` order of the document being walked; filled in by `buildDocument`. */
	readonly elementOrder: readonly CapturedDomNode[];
}

/**
 * Merge a capture into the `EnhancedDomTreeNode` IR.
 *
 * Pure: the same capture always produces the same tree, which is what makes the fixture corpus a
 * regression harness rather than a smoke test.
 */
export function mergeDomTrees(capture: DomCapture, options: MergeOptions = {}): MergedDomTree {
	const warnings: string[] = [...capture.warnings];
	const byKey = new Map<string, EnhancedDomTreeNode>();
	const slack = options.verticalSlackPx ?? VIEWPORT_VERTICAL_SLACK_PX;

	const indices = new Map<string, SessionIndex>();
	const indicesByFrameId = new Map<string, SessionIndex>();
	for (const session of capture.sessions) {
		const index: SessionIndex = {
			session,
			snapshot: decodeSnapshot(session.snapshot, session.devicePixelRatio),
			ax: decodeAxTree(session.axNodes),
		};
		indices.set(session.sessionId, index);
		indicesByFrameId.set(session.frameId, index);
	}

	const rootIndex = indices.get(capture.rootSessionId) ??
		(capture.sessions.length > 0 ? indices.get(capture.sessions[0]?.sessionId ?? '') : undefined);
	if (rootIndex === undefined) {
		warnings.push('capture carried no sessions');
		return { root: null, byKey, nodeCount: 0, warnings, frames: [], captureTruncated: capture.truncated === true };
	}

	const metrics = rootIndex.session.layoutMetrics;
	const rootContext: FrameContext = {
		index: rootIndex,
		offsetX: 0,
		offsetY: 0,
		visibleRect: {
			x: metrics.scrollX,
			y: metrics.scrollY,
			width: metrics.viewportWidth,
			height: metrics.viewportHeight,
		},
		frameId: rootIndex.session.frameId,
		framePath: '',
		depth: 0,
		elementOrder: [],
	};

	const frames: FrameRecord[] = [{
		frameId: rootIndex.session.frameId,
		parentFrameId: null,
		url: rootIndex.session.url,
		name: '',
		hostBounds: null,
		isOopif: false,
		captured: true,
		composed: true,
	}];
	const builder = new TreeBuilder(indicesByFrameId, byKey, warnings, slack, frames);
	const root = builder.buildDocument(rootIndex.session.document, rootContext, null);
	return { root, byKey, nodeCount: byKey.size, warnings, frames, captureTruncated: capture.truncated === true };
}

class TreeBuilder {
	readonly #indicesByFrameId: ReadonlyMap<string, SessionIndex>;
	readonly #byKey: Map<string, EnhancedDomTreeNode>;
	readonly #warnings: string[];
	readonly #slack: number;
	/** ERRATUM(E-40): appended to as frames are descended into, so the list is in document order. */
	readonly #frames: FrameRecord[];

	constructor(
		indicesByFrameId: ReadonlyMap<string, SessionIndex>,
		byKey: Map<string, EnhancedDomTreeNode>,
		warnings: string[],
		slack: number,
		frames: FrameRecord[],
	) {
		this.#indicesByFrameId = indicesByFrameId;
		this.#byKey = byKey;
		this.#warnings = warnings;
		this.#slack = slack;
		this.#frames = frames;
	}

	/** Build one document root plus everything under it. */
	buildDocument(
		documentNode: CapturedDomNode,
		baseContext: FrameContext,
		parent: EnhancedDomTreeNode | null,
	): EnhancedDomTreeNode {
		const context: FrameContext = { ...baseContext, elementOrder: collectElementOrder(documentNode) };
		const listeners = this.#listenerHits(context);
		const listenerBackendIds = resolveListenerBackendIds(context.elementOrder, listeners, context, this.#warnings);
		return this.#build(documentNode, context, parent, listenerBackendIds);
	}

	#listenerHits(context: FrameContext): ListenerCensusFrameView | null {
		const census: ListenerCensus | null = context.index.session.listeners;
		if (census === null) return null;
		const frame = census.frames.find((entry) => entry.frame === context.framePath);
		if (frame === undefined) return null;
		return { total: frame.total, scanned: frame.scanned, hits: new Set(frame.hits) };
	}

	#build(
		cdpNode: CapturedDomNode,
		context: FrameContext,
		parent: EnhancedDomTreeNode | null,
		listenerBackendIds: ReadonlySet<number>,
	): EnhancedDomTreeNode {
		const { session, snapshot, ax } = context.index;
		const backendNodeId = cdpNode.backendNodeId;
		const snapshotNode: EnhancedSnapshotNode | null = snapshot.byBackendNodeId.get(backendNodeId) ?? null;
		const axNode: EnhancedAxNode | null = ax.byBackendNodeId.get(backendNodeId) ?? null;
		const nodeType = this.#nodeType(cdpNode);
		const absolutePosition = translateBounds(snapshotNode?.bounds ?? null, context);

		const node: EnhancedDomTreeNode = {
			nodeId: cdpNode.nodeId,
			backendNodeId,
			nodeType,
			nodeName: cdpNode.nodeName,
			nodeValue: cdpNode.nodeValue,
			attributes: foldAttributes(cdpNode.attributes),
			isScrollable: cdpNode.isScrollable ?? null,
			isVisible: computeVisibility(
				nodeType,
				snapshotNode,
				absolutePosition,
				context.visibleRect,
				this.#slack,
			),
			absolutePosition,
			targetId: session.targetId,
			frameId: context.frameId,
			sessionId: session.sessionId,
			contentDocument: null,
			shadowRootType: normalizeShadowRootType(cdpNode.shadowRootType),
			shadowRoots: null,
			parentNode: parent,
			childrenNodes: [],
			axNode,
			snapshotNode,
			compoundChildren: [],
			hasJsClickListener: listenerBackendIds.has(backendNodeId),
			hiddenElementsInfo: [],
			hasHiddenContent: false,
			uuid: v7.generate(),
		};
		this.#byKey.set(nodeKey(session.sessionId, backendNodeId), node);

		for (const child of cdpNode.children ?? []) {
			node.childrenNodes.push(this.#build(child, context, node, listenerBackendIds));
		}

		const shadowRoots = cdpNode.shadowRoots ?? [];
		if (shadowRoots.length > 0) {
			node.shadowRoots = shadowRoots.map((shadowRoot) => this.#build(shadowRoot, context, node, listenerBackendIds));
		}

		if (isFrameTag(node)) this.#attachFrameContent(cdpNode, node, context);
		return node;
	}

	/**
	 * Descend into an iframe: same-process via the pierced `contentDocument`, out-of-process via the
	 * child session captured for that `frameId`.
	 */
	#attachFrameContent(
		cdpNode: CapturedDomNode,
		node: EnhancedDomTreeNode,
		context: FrameContext,
	): void {
		const frameId = cdpNode.frameId;
		if (frameId === undefined) return;

		const inlineDocument = cdpNode.contentDocument;
		if (inlineDocument !== undefined) {
			const documentIndex = context.index.snapshot.documentIndexByFrameId.get(frameId);
			const snapshotDoc = documentIndex === undefined ? null : context.index.snapshot.documents[documentIndex] ?? null;
			this.#recordFrame(node, context, frameId, {
				url: snapshotDoc?.documentUrl ?? inlineDocument.documentURL ?? '',
				isOopif: false,
				captured: true,
				composed: snapshotDoc !== null && node.absolutePosition !== null,
			});
			const childContext = this.#childFrameContext(node, context, context.index, frameId, snapshotDoc, {
				framePath: appendFramePath(context.framePath, frameIndexOf(cdpNode, context)),
			});
			node.contentDocument = this.buildDocument(inlineDocument, childContext, node);
			this.#annotateHiddenContent(node, childContext);
			return;
		}

		// No inline document ⇒ out-of-process. Its `backendNodeId`s belong to the child session, so the
		// child context switches session index as well as coordinates.
		const childIndex = this.#indicesByFrameId.get(frameId);
		if (childIndex === undefined) {
			// ERRATUM(E-40): a frame the capture did not reach (the session cap, or no session for it) is
			// still a frame the page has; it is listed so its absence from the tree is explicable.
			this.#recordFrame(node, context, frameId, { url: '', isOopif: true, captured: false, composed: false });
			return;
		}
		const snapshotDoc = childIndex.snapshot.documents[0] ?? null;
		this.#recordFrame(node, context, frameId, {
			url: childIndex.session.url,
			isOopif: true,
			captured: true,
			composed: snapshotDoc !== null && node.absolutePosition !== null,
		});
		const childContext = this.#childFrameContext(node, context, childIndex, frameId, snapshotDoc, {
			framePath: '',
		});
		node.contentDocument = this.buildDocument(childIndex.session.document, childContext, node);
		this.#annotateHiddenContent(node, childContext);
	}

	/** ERRATUM(E-40): one {@linkcode FrameRecord} per descended frame, host geometry included. */
	#recordFrame(
		host: EnhancedDomTreeNode,
		context: FrameContext,
		frameId: string,
		facts: Pick<FrameRecord, 'url' | 'isOopif' | 'captured' | 'composed'>,
	): void {
		this.#frames.push({
			frameId,
			parentFrameId: context.frameId,
			name: host.attributes['name'] ?? '',
			hostBounds: host.absolutePosition === null ? null : { ...host.absolutePosition },
			...facts,
		});
	}

	#childFrameContext(
		host: EnhancedDomTreeNode,
		parentContext: FrameContext,
		index: SessionIndex,
		frameId: string,
		snapshotDoc: DecodedSnapshotDocument | null,
		extra: { framePath: string },
	): FrameContext {
		const contentBox = frameContentBox(host);
		const scrollX = snapshotDoc?.scrollOffsetX ?? 0;
		const scrollY = snapshotDoc?.scrollOffsetY ?? 0;
		return {
			index,
			offsetX: contentBox.x - scrollX,
			offsetY: contentBox.y - scrollY,
			visibleRect: intersectRects(parentContext.visibleRect, contentBox),
			frameId,
			framePath: extra.framePath,
			depth: parentContext.depth + 1,
			elementOrder: [],
		};
	}

	/**
	 * `hiddenElementsInfo` / `hasHiddenContent` — §6.4's
	 * `... (N more elements below - scroll to reveal)` hints, carried on the host iframe.
	 *
	 * ERRATUM(M1-dom-extract-9): §6.1 names the fields and §6.4 shows the rendering, but nothing
	 * defines the candidate set. Implemented as: descendants of the frame that are CSS-visible, have
	 * geometry, look interactive by {@linkcode isHiddenHintCandidate}, and sit outside the frame's own
	 * visible rect. Capped at {@linkcode MAX_HIDDEN_ELEMENT_HINTS}, sorted by absolute distance.
	 *
	 * ERRATUM(M1-parity-15): an element the serializer already renders is not hidden content, so the
	 * candidate set is additionally gated on `isVisible === false`. The frame's `visibleRect` carries no
	 * vertical slack while `computeVisibility` does, so without this gate the same element was both
	 * indexed in the tree *and* advertised as "scroll to reveal" — `iframe_inner_scroll` indexed all
	 * twelve rows and then listed eight of them again as hidden, where the reference lists none.
	 */
	#annotateHiddenContent(host: EnhancedDomTreeNode, childContext: FrameContext): void {
		const content = host.contentDocument;
		if (content === null) return;
		const visible = childContext.visibleRect;
		if (visible.height <= 0) return;

		const hints: HiddenElementInfo[] = [];
		const visit = (node: EnhancedDomTreeNode): void => {
			if (node.nodeType === ELEMENT_NODE && node.isVisible === false && isHiddenHintCandidate(node)) {
				const pagesAway = pagesOutsideRect(node.absolutePosition, visible);
				if (pagesAway !== null) {
					hints.push({
						tagName: tagName(node),
						text: truncate(getOffscreenTextForLlm(node), HIDDEN_HINT_TEXT_LIMIT),
						pagesAway,
					});
				}
			}
			for (const child of node.childrenNodes) visit(child);
			for (const shadowRoot of node.shadowRoots ?? []) visit(shadowRoot);
		};
		visit(content);

		hints.sort((a, b) => Math.abs(a.pagesAway) - Math.abs(b.pagesAway));
		host.hiddenElementsInfo = hints.slice(0, MAX_HIDDEN_ELEMENT_HINTS);
		host.hasHiddenContent = hints.length > 0;
	}

	/**
	 * ERRATUM(M1-dom-extract-5): the seam's `NodeType` union is closed over the six types extraction
	 * observes. An unobserved type (CDATA, processing instruction) is mapped to `COMMENT_NODE`, which
	 * every consumer already treats as inert, and a warning is recorded rather than the type widened.
	 */
	#nodeType(cdpNode: CapturedDomNode): NodeType {
		if (KNOWN_NODE_TYPES.has(cdpNode.nodeType)) return cdpNode.nodeType as NodeType;
		this.#warnings.push(`unmapped nodeType ${cdpNode.nodeType} on <${cdpNode.nodeName}> treated as a comment`);
		return COMMENT_NODE;
	}
}

interface ListenerCensusFrameView {
	readonly total: number;
	readonly scanned: number;
	readonly hits: ReadonlySet<number>;
}

/**
 * `document.querySelectorAll('*')` order, reproduced from the DOM tree.
 *
 * `querySelectorAll` neither pierces shadow roots nor descends into frames, so neither does this walk.
 * The result is index-aligned with the census's `hits`, which is what lets a page-side scan of
 * anonymous elements be attributed to `backendNodeId`s.
 */
export function collectElementOrder(documentNode: CapturedDomNode): CapturedDomNode[] {
	const out: CapturedDomNode[] = [];
	const visit = (node: CapturedDomNode): void => {
		if (node.nodeType === ELEMENT_NODE) out.push(node);
		for (const child of node.children ?? []) visit(child);
	};
	for (const child of documentNode.children ?? []) visit(child);
	return out;
}

function resolveListenerBackendIds(
	elementOrder: readonly CapturedDomNode[],
	frame: ListenerCensusFrameView | null,
	context: FrameContext,
	warnings: string[],
): ReadonlySet<number> {
	if (frame === null) return new Set();
	if (frame.total !== elementOrder.length) {
		// The page mutated between the DOM read and the census: the indices no longer address the same
		// elements. Dropping the frame's data is the only safe move — a shifted index would mark the
		// wrong element clickable, which is worse than marking none.
		warnings.push(
			`listener census skipped for frame ${context.frameId}: ` +
				`${frame.total} elements in the census vs ${elementOrder.length} in the DOM`,
		);
		return new Set();
	}
	const out = new Set<number>();
	for (const hit of frame.hits) {
		const element = elementOrder[hit];
		if (element === undefined) continue;
		out.add(element.backendNodeId);
	}
	return out;
}

/** Position of `frame` among the IFRAME/FRAME elements of its document, in document order. */
function frameIndexOf(frameNode: CapturedDomNode, context: FrameContext): number {
	let k = 0;
	for (const element of context.elementOrder) {
		if (element.nodeName !== 'IFRAME' && element.nodeName !== 'FRAME') continue;
		if (element.backendNodeId === frameNode.backendNodeId) return k;
		k += 1;
	}
	return -1;
}

function appendFramePath(path: string, index: number): string {
	if (index < 0) return `${path}?`;
	return path === '' ? String(index) : `${path}.${index}`;
}

/**
 * The page-absolute content box of a frame host: its border-box origin shifted by `clientRects.x/y`
 * and sized by `clientRects.width/height`. This is the exact origin the child document's own
 * coordinates are measured from, so frame geometry composes without an approximation.
 *
 * ERRATUM(M1-dom-extract-1): DATA-MODEL §6.2 calls `clientRects` "viewport-relative"; it is not. CDP
 * puts `[clientLeft, clientTop, clientWidth, clientHeight]` there — an inset and a size, not a
 * position. Reading it as a viewport position would stack every iframe's content at the top-left of
 * the page.
 */
export function frameContentBox(host: EnhancedDomTreeNode): DomRect {
	const outer = host.absolutePosition;
	if (outer === null) return { x: 0, y: 0, width: 0, height: 0 };
	const client = host.snapshotNode?.clientRects ?? null;
	if (client === null) return { ...outer };
	return {
		x: outer.x + client.x,
		y: outer.y + client.y,
		width: client.width,
		height: client.height,
	};
}

/** DOMSnapshot bounds (already CSS px) rebased into page-absolute coordinates. */
export function translateBounds(bounds: DomRect | null, context: FrameContext): DomRect | null {
	if (bounds === null) return null;
	return {
		x: bounds.x + context.offsetX,
		y: bounds.y + context.offsetY,
		width: bounds.width,
		height: bounds.height,
	};
}

/**
 * `isVisible` (DATA-MODEL §6.1) — a CSS gate, then the frame-chain viewport test with ±`slack` px of
 * vertical give. Exactly the two gates §6.1 names, and no third.
 *
 * `null` for node types with no visual presence of their own (documents, doctypes, comments, shadow
 * roots): "unknown", not "invisible", because a shadow root's *children* are perfectly visible.
 *
 * ERRATUM(M1-parity-12): an **area gate** (`width <= 0 || height <= 0`) used to sit between the two.
 * §6.1 specifies no such test and the reference indexes both `#v-zero-size` (a 0x0 button) and
 * `#l-empty` (an anchor with no content). A zero-area box still passes the viewport test below, because
 * the intersection is written on the rect's edges rather than on its area
 * (DECISION-REGISTER §9.6 (E-23) item 3).
 */
export function computeVisibility(
	nodeType: NodeType,
	snapshotNode: EnhancedSnapshotNode | null,
	absolutePosition: DomRect | null,
	visibleRect: DomRect,
	slack: number,
): boolean | null {
	if (nodeType !== ELEMENT_NODE && nodeType !== TEXT_NODE) return null;
	if (!passesCssGate(snapshotNode)) return false;
	if (absolutePosition === null) return false;
	return intersectsWithSlack(absolutePosition, visibleRect, slack);
}

/**
 * `opacity: 0` on the node itself.
 *
 * ERRATUM(M1-dom-extract-6, WITHDRAWN by M1-parity-12): this used to be propagated down the tree so
 * that an `opacity: 0` wrapper hid its subtree, since `opacity` does not inherit and `DOMSnapshot`
 * reports `1` for every child of a transparent wrapper. The reference does not hide them: it indexes
 * `#v-opacity-zero` (a button under an `opacity: 0` div) and renders that div's text. Opacity is
 * therefore not part of the CSS gate at all, and this predicate survives only as a description of a
 * node — nothing consumes it for visibility.
 */
export function isFullyTransparent(snapshotNode: EnhancedSnapshotNode | null): boolean {
	const opacity = snapshotNode?.computedStyles?.opacity;
	if (opacity === undefined || opacity === '') return false;
	const parsed = Number.parseFloat(opacity);
	return Number.isFinite(parsed) && parsed <= 0;
}

/**
 * The CSS half of the visibility gate: `display` and `visibility`, and nothing else.
 *
 * A missing `computedStyles` is the strongest possible signal: `DOMSnapshot` emits a layout row only
 * for nodes that generate a box, so `display:none` (and `<head>` content, and un-rendered `<option>`s)
 * arrive with no styles at all rather than with `display: none` spelled out.
 *
 * `opacity` is deliberately absent — see {@linkcode isFullyTransparent}.
 */
export function passesCssGate(snapshotNode: EnhancedSnapshotNode | null): boolean {
	const styles = snapshotNode?.computedStyles ?? null;
	if (styles === null) return false;
	if (styles.display === 'none') return false;
	const visibility = styles.visibility;
	if (visibility === 'hidden' || visibility === 'collapse') return false;
	return true;
}

/** Proper (non-degenerate) overlap with `viewport` grown by `slack` px top and bottom. */
export function intersectsWithSlack(rect: DomRect, viewport: DomRect, slack: number): boolean {
	const top = viewport.y - slack;
	const bottom = viewport.y + viewport.height + slack;
	const left = viewport.x;
	const right = viewport.x + viewport.width;
	return rect.x < right && rect.x + rect.width > left && rect.y < bottom && rect.y + rect.height > top;
}

/** Intersection of two rects; a non-overlapping pair yields a zero-size rect, never a negative one. */
export function intersectRects(a: DomRect, b: DomRect): DomRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * How many `rect.height`-sized pages `target` sits outside `rect`; `null` when it is inside.
 * Positive = below, negative = above.
 */
export function pagesOutsideRect(target: DomRect | null, rect: DomRect): number | null {
	if (target === null || rect.height <= 0) return null;
	const below = target.y - (rect.y + rect.height);
	if (below > 0) return below / rect.height;
	const above = rect.y - (target.y + target.height);
	if (above > 0) return -(above / rect.height);
	return null;
}

/**
 * Deliberately NOT the serializer's `isInteractive` (DATA-MODEL §6.3): this is the narrower question
 * "would a user consider this worth scrolling to", used only for iframe hidden-element hints.
 */
export function isHiddenHintCandidate(node: EnhancedDomTreeNode): boolean {
	if (node.absolutePosition === null) return false;
	if (!passesCssGate(node.snapshotNode)) return false;
	if (NATIVELY_INTERACTIVE_TAGS.has(node.nodeName)) return true;
	if (node.snapshotNode?.isClickable === true) return true;
	if (node.hasJsClickListener) return true;
	return node.snapshotNode?.cursorStyle === 'pointer';
}

/** CDP's flat `[k1, v1, k2, v2, …]` attribute list, folded to a record (DATA-MODEL §6.1). */
export function foldAttributes(flat: readonly string[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (flat === undefined) return out;
	for (let i = 0; i + 1 < flat.length; i += 2) {
		const key = flat[i];
		const value = flat[i + 1];
		if (key === undefined || value === undefined) continue;
		out[key] = value;
	}
	return out;
}

function normalizeShadowRootType(value: string | undefined): ShadowRootType | null {
	if (value === 'open' || value === 'closed' || value === 'user-agent') return value;
	return null;
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

/** Every node of the tree, in the order the merge created them. Used by tests and by the serializer. */
export function walkTree(root: EnhancedDomTreeNode): EnhancedDomTreeNode[] {
	const out: EnhancedDomTreeNode[] = [];
	const visit = (node: EnhancedDomTreeNode): void => {
		out.push(node);
		for (const child of node.childrenNodes) visit(child);
		for (const shadowRoot of node.shadowRoots ?? []) visit(shadowRoot);
		if (node.contentDocument !== null) visit(node.contentDocument);
	};
	visit(root);
	return out;
}

// ERRATUM(G4-6): `NODE_TYPE_DOCUMENT` was an alias of `DOCUMENT_NODE` "exported so callers can
// branch without re-declaring the DOM constants" — for callers that never existed.
