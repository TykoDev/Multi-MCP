/**
 * CDP `Accessibility` domain — the AX tree, joined onto the DOM tree by `backendNodeId`.
 *
 * Source of `EnhancedAxNode` (SPECS/DATA-MODEL.md §6.2): role, name, description, properties,
 * childIds. Unknown property names are dropped by the DOM layer, not here.
 */

import type { BackendNodeId, EmptyResult, FrameId, NodeId, NoParams } from './common.ts';

export type AxNodeId = string;

/** `Accessibility.AXValue`. `value` is deliberately `unknown` — it is a union of 8 shapes. */
export interface AxValue {
	type: string;
	value?: unknown;
	relatedNodes?: AxRelatedNode[];
	sources?: Record<string, unknown>[];
}

/** `Accessibility.AXRelatedNode`. */
export interface AxRelatedNode {
	backendDOMNodeId: BackendNodeId;
	idref?: string;
	text?: string;
}

/** `Accessibility.AXProperty`. */
export interface AxProperty {
	name: string;
	value: AxValue;
}

/** `Accessibility.AXNode`. */
export interface AxNode {
	nodeId: AxNodeId;
	ignored: boolean;
	ignoredReasons?: AxProperty[];
	role?: AxValue;
	chromeRole?: AxValue;
	name?: AxValue;
	description?: AxValue;
	value?: AxValue;
	properties?: AxProperty[];
	parentId?: AxNodeId;
	childIds?: AxNodeId[];
	backendDOMNodeId?: BackendNodeId;
	frameId?: FrameId;
}

export interface AccessibilityParams {
	'Accessibility.disable': NoParams;
	'Accessibility.enable': NoParams;
	'Accessibility.getFullAXTree': { depth?: number; frameId?: FrameId };
	'Accessibility.getPartialAXTree': {
		nodeId?: NodeId;
		backendNodeId?: BackendNodeId;
		objectId?: string;
		fetchRelatives?: boolean;
	};
	'Accessibility.getRootAXNode': { frameId?: FrameId };
	'Accessibility.queryAXTree': {
		nodeId?: NodeId;
		backendNodeId?: BackendNodeId;
		objectId?: string;
		accessibleName?: string;
		role?: string;
	};
}

export interface AccessibilityResults {
	'Accessibility.disable': EmptyResult;
	'Accessibility.enable': EmptyResult;
	'Accessibility.getFullAXTree': { nodes: AxNode[] };
	'Accessibility.getPartialAXTree': { nodes: AxNode[] };
	'Accessibility.getRootAXNode': { node: AxNode };
	'Accessibility.queryAXTree': { nodes: AxNode[] };
}

/** `Accessibility.loadComplete`/`nodesUpdated` exist but are experimental and unused (D-CDP2). */
export type AccessibilityEvents = Record<never, never>;

export const ACCESSIBILITY_METHODS = [
	'disable',
	'enable',
	'getFullAXTree',
	'getPartialAXTree',
	'getRootAXNode',
	'queryAXTree',
] as const;
