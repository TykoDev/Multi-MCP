/**
 * `DOMSnapshot.captureSnapshot` decoding — the geometry + computed-style third of the merge.
 *
 * Contract: SPECS/DATA-MODEL.md §6.2 (`EnhancedSnapshotNode`, the 10 whitelisted computed styles).
 *
 * The wire format is column-oriented and string-table-encoded: every string is an index into
 * `strings`, every `Rare*Data` is a sparse `{index, value}` column pair, and geometry lives in a
 * second table (`layout`) that points back into the node table via `layout.nodeIndex`. This module
 * turns all of that into a `backendNodeId → EnhancedSnapshotNode` map per document, which is the only
 * shape the merge cares about.
 */

import type { CdpResult } from '@tykotech/cdp';
import type { DomRect, EnhancedSnapshotNode, RequiredComputedStyle } from './types.ts';
import { REQUIRED_COMPUTED_STYLES } from './types.ts';

/** `DOMSnapshot.captureSnapshot` result, as recorded into the fixture corpus. */
export type CapturedSnapshot = CdpResult['DOMSnapshot.captureSnapshot'];

/** One `DOMSnapshot.DocumentSnapshot`. */
export type CapturedSnapshotDocument = CapturedSnapshot['documents'][number];

/** One decoded document of a capture — a frame that lives in this session's process. */
export interface DecodedSnapshotDocument {
	/** `Page.Frame.id` of the frame this document belongs to. */
	readonly frameId: string;
	readonly documentUrl: string;
	/** Document scroll offset in CSS px; subtracted when rebasing child-frame geometry. */
	readonly scrollOffsetX: number;
	readonly scrollOffsetY: number;
	readonly contentWidth: number;
	readonly contentHeight: number;
	readonly byBackendNodeId: ReadonlyMap<number, EnhancedSnapshotNode>;
}

/** The whole capture, decoded. */
export interface DecodedSnapshot {
	readonly documents: readonly DecodedSnapshotDocument[];
	/**
	 * Union across every document in the session. `backendNodeId` is unique per session — Chrome
	 * partitions the ids across the session's documents rather than restarting them per frame
	 * (verified against Chrome 141 headless), so the union never collides.
	 */
	readonly byBackendNodeId: ReadonlyMap<number, EnhancedSnapshotNode>;
	/** `frameId` → index into {@linkcode DecodedSnapshot.documents}. */
	readonly documentIndexByFrameId: ReadonlyMap<string, number>;
	/**
	 * `backendNodeId` of an iframe host → index into {@linkcode DecodedSnapshot.documents} of the
	 * document it hosts. Decoded from `nodes.contentDocumentIndex`; used only as a cross-check
	 * because the merge resolves child documents through `frameId`.
	 */
	readonly documentIndexByHostBackendNodeId: ReadonlyMap<number, number>;
}

/**
 * The `computedStyles` argument for `DOMSnapshot.captureSnapshot`.
 *
 * DATA-MODEL §6.2 makes the list normative rather than advisory ("requesting more crashes Chrome on
 * heavy sites"), so it is passed through untouched from the seam and pinned by a test.
 */
export const SNAPSHOT_COMPUTED_STYLES: readonly string[] = REQUIRED_COMPUTED_STYLES;

/** A `Rare*Data` index column, decoded to a set of the indices it marks. */
export function decodeRareBooleanSet(rare: { index: number[] } | undefined): ReadonlySet<number> {
	return new Set(rare?.index ?? []);
}

/** A `RareIntegerData`/`RareStringData` column pair, decoded to a map. */
export function decodeRarePairs(
	rare: { index: number[]; value: number[] } | undefined,
): ReadonlyMap<number, number> {
	const out = new Map<number, number>();
	if (rare === undefined) return out;
	for (let i = 0; i < rare.index.length; i++) {
		const key = rare.index[i];
		const value = rare.value[i];
		if (key === undefined || value === undefined) continue;
		out.set(key, value);
	}
	return out;
}

/** `[x, y, width, height]` → {@linkcode DomRect}, dividing by `scale`. `null` for a malformed row. */
export function toRect(row: readonly number[] | undefined, scale = 1): DomRect | null {
	if (row === undefined || row.length < 4) return null;
	const [x, y, width, height] = row as [number, number, number, number];
	if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
	if (scale === 1) return { x, y, width, height };
	return { x: x / scale, y: y / scale, width: width / scale, height: height / scale };
}

/**
 * Decode one capture.
 *
 * ERRATUM(M1-dom-extract-3): `devicePixelRatio` divides **`bounds` only**. DATA-MODEL §6.2 marks
 * `bounds` as "device px ÷ devicePixelRatio → CSS px" and `clientRects`/`scrollRects` as "raw"
 * without saying what "raw" is measured in; they are already CSS px in Chrome's encoding
 * (`clientLeft`/`scrollWidth`-family values), so scaling them would halve every frame inset on a 2×
 * display. See also ERRATUM(M1-dom-extract-1) for what `clientRects` actually contains.
 */
export function decodeSnapshot(snapshot: CapturedSnapshot, devicePixelRatio: number): DecodedSnapshot {
	const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
	const strings = snapshot.strings;
	const documents: DecodedSnapshotDocument[] = [];
	const union = new Map<number, EnhancedSnapshotNode>();
	const documentIndexByFrameId = new Map<string, number>();
	const documentIndexByHostBackendNodeId = new Map<number, number>();

	for (let d = 0; d < snapshot.documents.length; d++) {
		const doc = snapshot.documents[d];
		if (doc === undefined) continue;
		const decoded = decodeDocument(doc, strings, scale);
		documents.push(decoded);
		for (const [backendNodeId, node] of decoded.byBackendNodeId) union.set(backendNodeId, node);
		if (decoded.frameId !== '' && !documentIndexByFrameId.has(decoded.frameId)) {
			documentIndexByFrameId.set(decoded.frameId, d);
		}
		// `contentDocumentIndex` maps a *host* snapshot-node index in THIS document to an index into
		// `documents`; resolve the host index back to its backendNodeId so callers can join on it.
		const hosts = decodeRarePairs(doc.nodes.contentDocumentIndex);
		const backendIds = doc.nodes.backendNodeId ?? [];
		for (const [hostNodeIndex, documentIndex] of hosts) {
			const hostBackendNodeId = backendIds[hostNodeIndex];
			if (hostBackendNodeId === undefined) continue;
			documentIndexByHostBackendNodeId.set(hostBackendNodeId, documentIndex);
		}
	}

	return { documents, byBackendNodeId: union, documentIndexByFrameId, documentIndexByHostBackendNodeId };
}

function decodeDocument(
	doc: CapturedSnapshotDocument,
	strings: readonly string[],
	scale: number,
): DecodedSnapshotDocument {
	const nodes = doc.nodes;
	const layout = doc.layout;
	const backendIds = nodes.backendNodeId ?? [];
	const clickable = decodeRareBooleanSet(nodes.isClickable);
	// ERRATUM(E-39): the value columns, decoded alongside `isClickable` because they are node-level
	// columns too and would otherwise be lost for nodes with no layout box (an un-rendered `<option>`
	// still has `optionSelected`).
	const inputValues = decodeRarePairs(nodes.inputValue);
	const textValues = decodeRarePairs(nodes.textValue);
	const inputChecked = decodeRareBooleanSet(nodes.inputChecked);
	const optionSelected = decodeRareBooleanSet(nodes.optionSelected);
	const stacking = decodeRareBooleanSet(layout.stackingContexts);
	const cursorColumn = REQUIRED_COMPUTED_STYLES.indexOf('cursor');

	// Layout rows first: one pass builds the geometry for every rendered node.
	const layoutByNodeIndex = new Map<number, number>();
	for (let li = 0; li < layout.nodeIndex.length; li++) {
		const ni = layout.nodeIndex[li];
		if (ni === undefined) continue;
		// A node can own several layout boxes (fragmented inline content). The first is the one the
		// snapshot orders as primary; taking it keeps the decode deterministic.
		if (!layoutByNodeIndex.has(ni)) layoutByNodeIndex.set(ni, li);
	}

	const byBackendNodeId = new Map<number, EnhancedSnapshotNode>();
	const nodeCount = nodes.nodeName?.length ?? backendIds.length;
	const valueColumns = (ni: number) => {
		const valueIndex = inputValues.get(ni);
		const textIndex = textValues.get(ni);
		return {
			inputValue: valueIndex === undefined ? null : strings[valueIndex] ?? null,
			inputChecked: nodes.inputChecked === undefined ? null : inputChecked.has(ni),
			optionSelected: nodes.optionSelected === undefined ? null : optionSelected.has(ni),
			textValue: textIndex === undefined ? null : strings[textIndex] ?? null,
		};
	};
	for (let ni = 0; ni < nodeCount; ni++) {
		const backendNodeId = backendIds[ni];
		if (backendNodeId === undefined) continue;
		const li = layoutByNodeIndex.get(ni);
		if (li === undefined) {
			// No layout box — `display:none`, `<head>` content, un-rendered `<option>`s. The node still
			// exists in the DOM tree, so it gets a snapshot projection with null geometry rather than
			// none at all: `isClickable` is a node-level column and would otherwise be lost.
			byBackendNodeId.set(backendNodeId, {
				bounds: null,
				computedStyles: null,
				cursorStyle: null,
				paintOrder: null,
				clientRects: null,
				scrollRects: null,
				stackingContexts: null,
				isClickable: clickable.has(ni),
				...valueColumns(ni),
			});
			continue;
		}
		const styleIndices = layout.styles[li] ?? [];
		const computedStyles = decodeComputedStyles(styleIndices, strings);
		const cursorIndex = styleIndices[cursorColumn];
		const cursorStyle = cursorIndex === undefined ? null : strings[cursorIndex] ?? null;
		byBackendNodeId.set(backendNodeId, {
			bounds: toRect(layout.bounds[li], scale),
			computedStyles,
			cursorStyle,
			paintOrder: layout.paintOrders?.[li] ?? null,
			clientRects: toRect(layout.clientRects?.[li]),
			scrollRects: toRect(layout.scrollRects?.[li]),
			// ERRATUM(M1-dom-extract-2): the seam types `stackingContexts` as `number | null` but CDP
			// models it as `RareBooleanData`. Encoded as 1/0 so no information is invented.
			stackingContexts: stacking.has(li) ? 1 : 0,
			isClickable: clickable.has(ni),
			...valueColumns(ni),
		});
	}

	// `DocumentSnapshot.frameId` is a `StringIndex`, not the frame id itself — one of the places the
	// column encoding is easy to read straight past.
	return {
		frameId: strings[doc.frameId] ?? '',
		documentUrl: strings[doc.documentURL] ?? '',
		scrollOffsetX: doc.scrollOffsetX ?? 0,
		scrollOffsetY: doc.scrollOffsetY ?? 0,
		contentWidth: doc.contentWidth ?? 0,
		contentHeight: doc.contentHeight ?? 0,
		byBackendNodeId,
	};
}

/**
 * `styles[li]` is positional: entry `k` is the value of `REQUIRED_COMPUTED_STYLES[k]`, because that
 * is the array handed to `captureSnapshot`. Empty values are kept verbatim — dropping them would
 * make "absent" and "computed to the empty string" indistinguishable downstream.
 */
function decodeComputedStyles(
	styleIndices: readonly number[],
	strings: readonly string[],
): Partial<Record<RequiredComputedStyle, string>> | null {
	if (styleIndices.length === 0) return null;
	const out: Partial<Record<RequiredComputedStyle, string>> = {};
	for (let k = 0; k < REQUIRED_COMPUTED_STYLES.length; k++) {
		const name = REQUIRED_COMPUTED_STYLES[k];
		const index = styleIndices[k];
		if (name === undefined || index === undefined) continue;
		const value = strings[index];
		if (value === undefined) continue;
		out[name] = value;
	}
	return out;
}

/**
 * Paint-order comparison: Chrome assigns a higher `paintOrder` to whatever paints later, i.e. on top.
 *
 * Exported so the serializer's `ignoredByPaintOrder` filter (DATA-MODEL §6.3) and this module agree on
 * the direction of the comparison. Nodes without paint order never win.
 */
export function paintsAbove(a: EnhancedSnapshotNode | null, b: EnhancedSnapshotNode | null): boolean {
	const pa = a?.paintOrder;
	const pb = b?.paintOrder;
	if (pa === undefined || pa === null || pb === undefined || pb === null) return false;
	return pa > pb;
}
