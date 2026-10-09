/**
 * DOM intermediate representation — the merged IR of three CDP trees.
 *
 * Contract owner: SPECS/DATA-MODEL.md §6.1 (EnhancedDomTreeNode), §6.2 (EnhancedAxNode /
 * EnhancedSnapshotNode), §6.3 (SerializedDomState + selectorMap), §6.6 (replay keys).
 *
 * This file is **orchestrator-owned**: it is the seam between the extraction builder (which
 * populates these nodes from `DOMSnapshot` + `DOM` + `Accessibility`) and the serialization builder
 * (which renders them to the LLM-visible text of §6.4). Neither may edit it; a change here is a
 * boundary rewind. Declarations only — no runtime logic lives here.
 */

/** Page-absolute CSS-pixel rectangle. */
export interface DomRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** DOM-spec node type integers (subset actually observed in extraction). */
export type NodeType =
	| 1 // ELEMENT_NODE
	| 3 // TEXT_NODE
	| 8 // COMMENT_NODE
	| 9 // DOCUMENT_NODE
	| 10 // DOCUMENT_TYPE_NODE
	| 11; // DOCUMENT_FRAGMENT_NODE (shadow roots)

export type ShadowRootType = 'open' | 'closed' | 'user-agent';

/**
 * The 10 whitelisted computed styles (DATA-MODEL §6.2). Exactly these — requesting more crashes
 * Chrome on heavy sites, which is why the list is normative rather than advisory.
 */
export const REQUIRED_COMPUTED_STYLES = [
	'display',
	'visibility',
	'opacity',
	'overflow',
	'overflow-x',
	'overflow-y',
	'cursor',
	'pointer-events',
	'position',
	'background-color',
] as const;

export type RequiredComputedStyle = (typeof REQUIRED_COMPUTED_STYLES)[number];

/** Accessibility-tree projection, joined to the DOM node by `backendNodeId` (§6.2). */
export interface EnhancedAxNode {
	axNodeId: string;
	ignored: boolean;
	role: string | null;
	name: string | null;
	description: string | null;
	/** Unknown property names are dropped at merge time. */
	properties: { name: string; value: string | boolean | null }[] | null;
	childIds: string[] | null;
}

/** DOMSnapshot projection, joined to the DOM node by `backendNodeId` (§6.2). */
export interface EnhancedSnapshotNode {
	/** Device px ÷ devicePixelRatio → CSS px; document coordinates. */
	bounds: DomRect | null;
	/** ONLY the {@link REQUIRED_COMPUTED_STYLES} keys. */
	computedStyles: Partial<Record<RequiredComputedStyle, string>> | null;
	cursorStyle: string | null;
	paintOrder: number | null;
	/** Raw, viewport-relative. */
	clientRects: DomRect | null;
	/** Raw; x/y = scroll offset, w/h = scrollable extent. */
	scrollRects: DomRect | null;
	stackingContexts: number | null;
	/** Chrome-detected click handler (`RareBooleanData` → set). */
	isClickable: boolean;
	/**
	 * ERRATUM(E-39). The four value columns `DOMSnapshot.captureSnapshot` already returns and the
	 * decode used to discard: the **live** `value` property of an input (`inputValue`), the live
	 * `checked` state (`inputChecked`), an `<option>`'s live `selected` state (`optionSelected`) and a
	 * `<textarea>`'s live text (`textValue`). `null` when the column carries no entry for the node,
	 * which is what Chrome emits for every element that has no such state. These are decoded, not
	 * fetched: the capture already paid for them.
	 */
	inputValue: string | null;
	inputChecked: boolean | null;
	optionSelected: boolean | null;
	textValue: string | null;
}

/** Scroll geometry surfaced in the serialized output's scroll suffixes (§6.4). */
export interface ScrollInfo {
	pagesAbove: number;
	pagesBelow: number;
	horizontalPercent: number | null;
}

/** Hidden-element hint carried out of iframes (§6.4 `... (N more elements below …)`). */
export interface HiddenElementInfo {
	tagName: string;
	text: string;
	pagesAway: number;
}

/**
 * The merged IR (§6.1). **Cyclic** via `parentNode` — any JSON serialization MUST strip
 * parent/children cycles (see `ElementSelectedEvent`, §5.1).
 */
export interface EnhancedDomTreeNode {
	// ---- DOM provenance ----
	/** `DOM.getDocument`; session-scoped and reusable — NOT a stable handle. */
	nodeId: number;
	/** The stable action handle. Valid ONLY within its originating session. */
	backendNodeId: number;
	nodeType: NodeType;
	/** Uppercase, as CDP reports it. */
	nodeName: string;
	/** Text content for TEXT_NODE. */
	nodeValue: string;
	/** Flat CDP `[k1,v1,k2,v2,…]` folded to a record. */
	attributes: Record<string, string>;
	isScrollable: boolean | null;

	// ---- computed / merged ----
	/** CSS gate + frame-chain viewport test, ±1000 px vertical slack. */
	isVisible: boolean | null;
	/** DOMSnapshot bounds + accumulated frame offset, in page-absolute CSS px. */
	absolutePosition: DomRect | null;

	// ---- capture context (keeps multi-target trees actionable) ----
	targetId: string;
	frameId: string;
	sessionId: string;

	// ---- structure ----
	/** DOM pierce (same-origin) or OOPIF recursion. */
	contentDocument: EnhancedDomTreeNode | null;
	shadowRootType: ShadowRootType | null;
	/** Filtered out of `childrenNodes`. */
	shadowRoots: EnhancedDomTreeNode[] | null;
	parentNode: EnhancedDomTreeNode | null;
	childrenNodes: EnhancedDomTreeNode[];

	// ---- joined trees ----
	axNode: EnhancedAxNode | null;
	snapshotNode: EnhancedSnapshotNode | null;

	// ---- synthesized ----
	/** Synthesized by the serializer for compound controls. */
	compoundChildren: Record<string, string>[];
	/** Runtime `getEventListeners` census; capped at 10k elements / 100 listeners. */
	hasJsClickListener: boolean;
	hiddenElementsInfo: HiddenElementInfo[];
	hasHiddenContent: boolean;
	/** uuid v7. */
	uuid: string;
}

/**
 * Derived members of {@link EnhancedDomTreeNode} (§6.1 "Derived members (contract, not storage)").
 * Implemented alongside the node rather than stored on it, so the IR stays JSON-shaped.
 */
export interface DomNodeDerived {
	/** Lowercase `nodeName`. */
	tagName(node: EnhancedDomTreeNode): string;
	/** 1-based same-tag positions; passes shadow roots; stops at iframe boundaries. */
	xpath(node: EnhancedDomTreeNode): string;
	isActuallyScrollable(node: EnhancedDomTreeNode): boolean;
	shouldShowScrollInfo(node: EnhancedDomTreeNode): boolean;
	scrollInfo(node: EnhancedDomTreeNode): ScrollInfo | null;
	getAllChildrenText(node: EnhancedDomTreeNode, maxDepth: number): string;
	/** First of `value`/`aria-label`/`title`/`placeholder`/`alt`, else children text. */
	getMeaningfulTextForLlm(node: EnhancedDomTreeNode): string;

	// ---- replay keys (§6.1 element hashes, consumed by §6.6) ----
	/** sha256[:16 hex] over parent-tag-path | sorted static attrs | AX name. */
	elementHash(node: EnhancedDomTreeNode): Promise<string>;
	/** As `elementHash`, with dynamic CSS class tokens filtered out. */
	stableHash(node: EnhancedDomTreeNode): Promise<string>;
	/** Tag path only. */
	parentBranchHash(node: EnhancedDomTreeNode): Promise<string>;
}

/** §6.3 — the serializer's output tree. */
export interface SimplifiedNode {
	originalNode: EnhancedDomTreeNode;
	children: SimplifiedNode[];
	shouldDisplay: boolean;
	isInteractive: boolean;
	/** R6.1: the node's `backendNodeId`, or a synthetic index on collision. */
	selectorIndex: number | null;
	/** R6.2: absent from the previous step's `(sessionId, backendNodeId)` set. */
	isNew: boolean;
	ignoredByPaintOrder: boolean;
	excludedByParent: boolean;
	isShadowHost: boolean;
	isCompoundComponent: boolean;
}

/** §6.3 — what the DOM pipeline hands to `BrowserStateSummary`. */
export interface SerializedDomState {
	root: SimplifiedNode | null;
	/** LLM index → node. Rebuilt every `BrowserStateRequestEvent` (R6.3). */
	selectorMap: Map<number, EnhancedDomTreeNode>;
}

/**
 * §6.6 — persisted per executed action, consumed by the replay cascade.
 * Note `MatchLevel` is a const object rather than a TS `enum` (AGENTS.md §3 bans enums); the numeric
 * values are load-bearing because the cascade tries them in ascending order.
 */
export const MatchLevel = {
	EXACT: 1,
	STABLE: 2,
	XPATH: 3,
	AX_NAME: 4,
	ATTRIBUTE: 5,
} as const;

export type MatchLevel = (typeof MatchLevel)[keyof typeof MatchLevel];

export interface DomInteractedElement {
	elementHash: string;
	stableHash: string;
	xPath: string;
	axName: string | null;
	/** At minimum `name`/`id`/`aria-label` when present. */
	attributes: Record<string, string>;
	frameId: string | null;
}
