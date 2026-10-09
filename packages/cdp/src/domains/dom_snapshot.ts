/**
 * CDP `DOMSnapshot` domain — the flat, string-table-encoded page snapshot.
 *
 * This is the geometry + computed-style third of `EnhancedDomTreeNode`
 * (SPECS/DATA-MODEL.md §6.1, §6.2). Everything is index-into-`strings`; `Rare*Data` arrays are
 * sparse `{index, value}` column pairs. `REQUIRED_COMPUTED_STYLES` is exactly 10 properties —
 * asking for more crashes Chrome on heavy pages (DATA-MODEL §6.2).
 */

import type { BackendNodeId, EmptyResult, NoParams } from './common.ts';

/** Index into the snapshot's `strings` table. */
export type StringIndex = number;

/** `DOMSnapshot.RareBooleanData` — presence in `index` means `true`. */
export interface RareBooleanData {
	index: number[];
}

/** `DOMSnapshot.RareIntegerData`. */
export interface RareIntegerData {
	index: number[];
	value: number[];
}

/** `DOMSnapshot.RareStringData`. */
export interface RareStringData {
	index: number[];
	value: StringIndex[];
}

/** `DOMSnapshot.NameValue` pairs, column-encoded. */
export interface NameValueColumns {
	name: StringIndex[];
	value: StringIndex[];
}

/** `DOMSnapshot.NodeTreeSnapshot` — one column per node attribute. */
export interface NodeTreeSnapshot {
	parentIndex?: number[];
	nodeType?: number[];
	shadowRootType?: RareStringData;
	nodeName?: StringIndex[];
	nodeValue?: StringIndex[];
	backendNodeId?: BackendNodeId[];
	attributes?: StringIndex[][];
	textValue?: RareStringData;
	inputValue?: RareStringData;
	inputChecked?: RareBooleanData;
	optionSelected?: RareBooleanData;
	contentDocumentIndex?: RareIntegerData;
	pseudoType?: RareStringData;
	pseudoIdentifier?: RareStringData;
	isClickable?: RareBooleanData;
	currentSourceURL?: RareStringData;
	originURL?: RareStringData;
}

/** `DOMSnapshot.LayoutTreeSnapshot` — geometry, paint order, stacking contexts. */
export interface LayoutTreeSnapshot {
	nodeIndex: number[];
	styles: StringIndex[][];
	/** `[x, y, width, height]` in device px; divide by `devicePixelRatio` for CSS px. */
	bounds: number[][];
	text: StringIndex[];
	stackingContexts: RareBooleanData;
	paintOrders?: number[];
	offsetRects?: number[][];
	scrollRects?: number[][];
	clientRects?: number[][];
	blendedBackgroundColors?: StringIndex[];
	textColorOpacities?: number[];
}

/** `DOMSnapshot.TextBoxSnapshot`. */
export interface TextBoxSnapshot {
	layoutIndex: number[];
	bounds: number[][];
	start: number[];
	length: number[];
}

/** `DOMSnapshot.DocumentSnapshot` — one per document/frame in the capture. */
export interface DocumentSnapshot {
	documentURL: StringIndex;
	title: StringIndex;
	baseURL: StringIndex;
	contentLanguage: StringIndex;
	encodingName: StringIndex;
	publicId: StringIndex;
	systemId: StringIndex;
	frameId: StringIndex;
	nodes: NodeTreeSnapshot;
	layout: LayoutTreeSnapshot;
	textBoxes: TextBoxSnapshot;
	scrollOffsetX?: number;
	scrollOffsetY?: number;
	contentWidth?: number;
	contentHeight?: number;
}

export interface DomSnapshotParams {
	'DOMSnapshot.captureSnapshot': {
		/** Whitelist of computed style names to return; exactly the 10 in DATA-MODEL §6.2. */
		computedStyles: string[];
		includePaintOrder?: boolean;
		includeDOMRects?: boolean;
		includeBlendedBackgroundColors?: boolean;
		includeTextColorOpacities?: boolean;
	};
	'DOMSnapshot.disable': NoParams;
	'DOMSnapshot.enable': NoParams;
}

export interface DomSnapshotResults {
	'DOMSnapshot.captureSnapshot': { documents: DocumentSnapshot[]; strings: string[] };
	'DOMSnapshot.disable': EmptyResult;
	'DOMSnapshot.enable': EmptyResult;
}

/** `DOMSnapshot` is pull-only; it emits no events. */
export type DomSnapshotEvents = Record<never, never>;

export const DOM_SNAPSHOT_METHODS = ['captureSnapshot', 'disable', 'enable'] as const;
