/**
 * CDP `DOM` domain — document tree, geometry, search, file inputs, scroll-into-view.
 *
 * Source of the DOM third of `EnhancedDomTreeNode` (SPECS/DATA-MODEL.md §6.1). The action layer
 * uses `scrollIntoViewIfNeeded` + `getContentQuads`/`getBoxModel` for the click cascade,
 * `setFileInputFiles` for upload, and `performSearch` for scroll-to-text
 * (SPECS/ARCHITECTURE.md §6.10).
 */

import type {
	BackendNodeId,
	EmptyResult,
	ExecutionContextId,
	FrameId,
	NodeId,
	NoParams,
	Quad,
	RemoteObject,
} from './common.ts';

/** DOM-spec node type ints (`ELEMENT_NODE = 1`, `TEXT_NODE = 3`, `DOCUMENT_FRAGMENT_NODE = 11`, …). */
export type NodeType = number;

/** `DOM.Node`. `attributes` is CDP's flat `[k1, v1, k2, v2, …]` — the DOM layer folds it. */
export interface DomNode {
	nodeId: NodeId;
	parentId?: NodeId;
	backendNodeId: BackendNodeId;
	nodeType: NodeType;
	nodeName: string;
	localName: string;
	nodeValue: string;
	childNodeCount?: number;
	children?: DomNode[];
	attributes?: string[];
	documentURL?: string;
	baseURL?: string;
	publicId?: string;
	systemId?: string;
	internalSubset?: string;
	xmlVersion?: string;
	name?: string;
	value?: string;
	pseudoType?: string;
	pseudoIdentifier?: string;
	shadowRootType?: 'user-agent' | 'open' | 'closed';
	frameId?: FrameId;
	contentDocument?: DomNode;
	shadowRoots?: DomNode[];
	templateContent?: DomNode;
	pseudoElements?: DomNode[];
	distributedNodes?: BackendNode[];
	isSVG?: boolean;
	compatibilityMode?: string;
	assignedSlot?: BackendNode;
	isScrollable?: boolean;
}

/** `DOM.BackendNode` — the thin `{nodeType, nodeName, backendNodeId}` reference. */
export interface BackendNode {
	nodeType: NodeType;
	nodeName: string;
	backendNodeId: BackendNodeId;
}

/** `DOM.BoxModel`. Each quad is 8 numbers (4 points). */
export interface BoxModel {
	content: Quad;
	padding: Quad;
	border: Quad;
	margin: Quad;
	width: number;
	height: number;
	shapeOutside?: Record<string, unknown>;
}

/** The three interchangeable ways CDP addresses a node. Exactly one should be set. */
export interface NodeRef {
	nodeId?: NodeId;
	backendNodeId?: BackendNodeId;
	objectId?: string;
}

export interface DomParams {
	'DOM.describeNode': NodeRef & { depth?: number; pierce?: boolean };
	'DOM.disable': NoParams;
	'DOM.discardSearchResults': { searchId: string };
	'DOM.enable': { includeWhitespace?: 'none' | 'all' };
	'DOM.focus': NodeRef;
	'DOM.getAttributes': { nodeId: NodeId };
	'DOM.getBoxModel': NodeRef;
	'DOM.getContentQuads': NodeRef;
	'DOM.getDocument': { depth?: number; pierce?: boolean };
	'DOM.getFrameOwner': { frameId: FrameId };
	'DOM.getNodeForLocation': {
		x: number;
		y: number;
		includeUserAgentShadowDOM?: boolean;
		ignorePointerEventsNone?: boolean;
	};
	'DOM.getOuterHTML': NodeRef;
	'DOM.getSearchResults': { searchId: string; fromIndex: number; toIndex: number };
	'DOM.performSearch': { query: string; includeUserAgentShadowDOM?: boolean };
	'DOM.requestNode': { objectId: string };
	'DOM.resolveNode': {
		nodeId?: NodeId;
		backendNodeId?: BackendNodeId;
		objectGroup?: string;
		executionContextId?: ExecutionContextId;
	};
	'DOM.scrollIntoViewIfNeeded': NodeRef & { rect?: { x: number; y: number; width: number; height: number } };
	'DOM.setFileInputFiles': NodeRef & { files: string[] };
}

export interface DomResults {
	'DOM.describeNode': { node: DomNode };
	'DOM.disable': EmptyResult;
	'DOM.discardSearchResults': EmptyResult;
	'DOM.enable': EmptyResult;
	'DOM.focus': EmptyResult;
	'DOM.getAttributes': { attributes: string[] };
	'DOM.getBoxModel': { model: BoxModel };
	'DOM.getContentQuads': { quads: Quad[] };
	'DOM.getDocument': { root: DomNode };
	'DOM.getFrameOwner': { backendNodeId: BackendNodeId; nodeId?: NodeId };
	'DOM.getNodeForLocation': { backendNodeId: BackendNodeId; frameId: FrameId; nodeId?: NodeId };
	'DOM.getOuterHTML': { outerHTML: string };
	'DOM.getSearchResults': { nodeIds: NodeId[] };
	'DOM.performSearch': { searchId: string; resultCount: number };
	'DOM.requestNode': { nodeId: NodeId };
	'DOM.resolveNode': { object: RemoteObject };
	'DOM.scrollIntoViewIfNeeded': EmptyResult;
	'DOM.setFileInputFiles': EmptyResult;
}

export interface DomEvents {
	/** "Rebuild state", not "crash" — stale-id CDP errors follow this (DATA-MODEL §6.3 R6.3). */
	'DOM.documentUpdated': Record<never, never>;
	'DOM.childNodeCountUpdated': { nodeId: NodeId; childNodeCount: number };
	'DOM.setChildNodes': { parentId: NodeId; nodes: DomNode[] };
}

export const DOM_METHODS = [
	'describeNode',
	'disable',
	'discardSearchResults',
	'enable',
	'focus',
	'getAttributes',
	'getBoxModel',
	'getContentQuads',
	'getDocument',
	'getFrameOwner',
	'getNodeForLocation',
	'getOuterHTML',
	'getSearchResults',
	'performSearch',
	'requestNode',
	'resolveNode',
	'scrollIntoViewIfNeeded',
	'setFileInputFiles',
] as const;
