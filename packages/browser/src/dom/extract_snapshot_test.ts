/**
 * `DOMSnapshot` decoding units (DATA-MODEL §6.2).
 *
 * The fixture corpus proves the decode against real Chrome payloads; this file pins the wire-format
 * edge cases that a fixture cannot reach on demand — a device pixel ratio other than 1, a malformed
 * geometry row, a `RareBooleanData` column with gaps.
 */

import { assertEquals } from '@std/assert';
import {
	type CapturedSnapshot,
	decodeRareBooleanSet,
	decodeRarePairs,
	decodeSnapshot,
	paintsAbove,
	SNAPSHOT_COMPUTED_STYLES,
	toRect,
} from './extract_snapshot.ts';
import { REQUIRED_COMPUTED_STYLES } from './types.ts';

/**
 * A hand-built snapshot in CDP's exact column encoding.
 *
 * Node 0 is `#document`, node 1 an `<a>` with a layout row, node 2 a `<div>` with none (`display:none`)
 * but marked clickable, node 3 an `<iframe>` hosting document 1.
 */
function snapshotFixture(): CapturedSnapshot {
	const strings = [
		'#document', // 0
		'A', // 1
		'DIV', // 2
		'IFRAME', // 3
		'block', // 4
		'visible', // 5
		'1', // 6
		'auto', // 7
		'pointer', // 8
		'rgba(0, 0, 0, 0)', // 9
		'frame-main', // 10
		'http://127.0.0.1/main', // 11
		'frame-child', // 12
		'http://127.0.0.1/child', // 13
		'static', // 14
	];
	const styleRow = [4, 5, 6, 7, 7, 7, 8, 7, 14, 9];
	return {
		strings,
		documents: [
			{
				documentURL: 11,
				title: 0,
				baseURL: 11,
				contentLanguage: 0,
				encodingName: 0,
				publicId: 0,
				systemId: 0,
				frameId: 10,
				scrollOffsetX: 5,
				scrollOffsetY: 25,
				contentWidth: 800,
				contentHeight: 2000,
				nodes: {
					parentIndex: [-1, 0, 0, 0],
					nodeType: [9, 1, 1, 1],
					nodeName: [0, 1, 2, 3],
					nodeValue: [0, 0, 0, 0],
					backendNodeId: [100, 101, 102, 103],
					isClickable: { index: [1, 2] },
					contentDocumentIndex: { index: [3], value: [1] },
				},
				layout: {
					// Layout rows exist for nodes 1 and 3 only; node 2 has no box.
					nodeIndex: [1, 3],
					styles: [styleRow, styleRow],
					bounds: [[20, 40, 200, 100], [0, 500, 300, 150]],
					text: [0, 0],
					stackingContexts: { index: [1] },
					paintOrders: [7, 9],
					offsetRects: [[20, 40, 200, 100], [0, 500, 300, 150]],
					scrollRects: [[0, 0, 200, 100], [0, 0, 300, 150]],
					clientRects: [[0, 0, 200, 100], [2, 2, 296, 146]],
				},
				textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
			},
			{
				documentURL: 13,
				title: 0,
				baseURL: 13,
				contentLanguage: 0,
				encodingName: 0,
				publicId: 0,
				systemId: 0,
				frameId: 12,
				scrollOffsetX: 0,
				scrollOffsetY: 60,
				contentWidth: 296,
				contentHeight: 900,
				nodes: {
					parentIndex: [-1],
					nodeType: [9],
					nodeName: [0],
					nodeValue: [0],
					backendNodeId: [200],
				},
				layout: { nodeIndex: [], styles: [], bounds: [], text: [], stackingContexts: { index: [] } },
				textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
			},
		],
	};
}

Deno.test('dom-snapshot: the requested style list is the seam constant, unmodified', () => {
	assertEquals([...SNAPSHOT_COMPUTED_STYLES], [...REQUIRED_COMPUTED_STYLES]);
	assertEquals(SNAPSHOT_COMPUTED_STYLES.length, 10);
});

Deno.test('dom-snapshot: RareBooleanData decodes to a set and RareIntegerData to a map', () => {
	assertEquals([...decodeRareBooleanSet({ index: [1, 4, 9] })], [1, 4, 9]);
	assertEquals([...decodeRareBooleanSet(undefined)], []);
	assertEquals([...decodeRarePairs({ index: [3, 7], value: [1, 2] })], [[3, 1], [7, 2]]);
	// A truncated column pair contributes nothing rather than an undefined entry.
	assertEquals([...decodeRarePairs({ index: [3, 7], value: [1] })], [[3, 1]]);
	assertEquals([...decodeRarePairs(undefined)], []);
});

Deno.test('dom-snapshot: geometry rows convert by scale and reject malformed input', () => {
	assertEquals(toRect([10, 20, 30, 40]), { x: 10, y: 20, width: 30, height: 40 });
	assertEquals(toRect([10, 20, 30, 40], 2), { x: 5, y: 10, width: 15, height: 20 });
	assertEquals(toRect([10, 20, 30]), null, 'a short row is malformed, not a zero rect');
	assertEquals(toRect(undefined), null);
	assertEquals(toRect([Number.NaN, 0, 1, 1]), null);
});

Deno.test('dom-snapshot: computed styles decode positionally against the requested whitelist', () => {
	const decoded = decodeSnapshot(snapshotFixture(), 1);
	const anchor = decoded.byBackendNodeId.get(101);
	assertEquals(anchor?.computedStyles, {
		'display': 'block',
		'visibility': 'visible',
		'opacity': '1',
		'overflow': 'auto',
		'overflow-x': 'auto',
		'overflow-y': 'auto',
		'cursor': 'pointer',
		'pointer-events': 'auto',
		'position': 'static',
		'background-color': 'rgba(0, 0, 0, 0)',
	});
	assertEquals(anchor?.cursorStyle, 'pointer', 'cursorStyle mirrors the cursor column');
});

Deno.test('dom-snapshot: a node with no layout row keeps isClickable but loses geometry', () => {
	const decoded = decodeSnapshot(snapshotFixture(), 1);
	const hidden = decoded.byBackendNodeId.get(102);
	// `display:none` nodes exist in the node table but not the layout table. Dropping them entirely
	// would lose `isClickable`, which is a node-level column, so they get a null-geometry projection.
	assertEquals(hidden, {
		bounds: null,
		computedStyles: null,
		cursorStyle: null,
		paintOrder: null,
		clientRects: null,
		scrollRects: null,
		stackingContexts: null,
		isClickable: true,
		inputValue: null,
		inputChecked: null,
		optionSelected: null,
		textValue: null,
	});
	assertEquals(decoded.byBackendNodeId.get(101)?.isClickable, true);
	assertEquals(decoded.byBackendNodeId.get(103)?.isClickable, false);
});

Deno.test('dom-snapshot: bounds divide by the device pixel ratio, clientRects and scrollRects do not', () => {
	// DATA-MODEL §6.2 marks `bounds` as device px and the other two as raw; a 2x screen must not
	// halve `clientLeft`, which is already CSS px in Chrome's encoding.
	const decoded = decodeSnapshot(snapshotFixture(), 2);
	const iframe = decoded.byBackendNodeId.get(103);
	assertEquals(iframe?.bounds, { x: 0, y: 250, width: 150, height: 75 });
	assertEquals(iframe?.clientRects, { x: 2, y: 2, width: 296, height: 146 });
	assertEquals(iframe?.scrollRects, { x: 0, y: 0, width: 300, height: 150 });

	// A nonsensical ratio falls back to 1 rather than producing infinities.
	const safe = decodeSnapshot(snapshotFixture(), 0);
	assertEquals(safe.byBackendNodeId.get(103)?.bounds, { x: 0, y: 500, width: 300, height: 150 });
});

Deno.test('dom-snapshot: stacking contexts encode as 1/0 and paint order compares later-on-top', () => {
	const decoded = decodeSnapshot(snapshotFixture(), 1);
	// ERRATUM(M1-dom-extract-2): the seam types this `number | null` while CDP models it as a boolean.
	assertEquals(decoded.byBackendNodeId.get(103)?.stackingContexts, 1);
	assertEquals(decoded.byBackendNodeId.get(101)?.stackingContexts, 0);
	assertEquals(decoded.byBackendNodeId.get(102)?.stackingContexts, null, 'no layout row, no answer');

	const above = decoded.byBackendNodeId.get(103) ?? null;
	const below = decoded.byBackendNodeId.get(101) ?? null;
	assertEquals(paintsAbove(above, below), true);
	assertEquals(paintsAbove(below, above), false);
	assertEquals(paintsAbove(null, below), false);
	assertEquals(paintsAbove(above, decoded.byBackendNodeId.get(102) ?? null), false);
});

Deno.test('dom-snapshot: documents index by frameId and by their host backendNodeId', () => {
	const decoded = decodeSnapshot(snapshotFixture(), 1);
	assertEquals(decoded.documents.length, 2);
	assertEquals(decoded.documents[0]?.frameId, 'frame-main');
	assertEquals(decoded.documents[0]?.documentUrl, 'http://127.0.0.1/main');
	assertEquals(decoded.documents[0]?.scrollOffsetX, 5);
	assertEquals(decoded.documents[0]?.scrollOffsetY, 25);
	assertEquals(decoded.documents[1]?.frameId, 'frame-child');
	assertEquals(decoded.documentIndexByFrameId.get('frame-child'), 1);
	// `contentDocumentIndex` is keyed by snapshot node index on the wire; the decode re-keys it to the
	// host's backendNodeId so callers never have to carry snapshot indices around.
	assertEquals(decoded.documentIndexByHostBackendNodeId.get(103), 1);

	// The union spans documents: backendNodeIds are unique per session, not per document.
	assertEquals(decoded.byBackendNodeId.size, 5);
	assertEquals(decoded.byBackendNodeId.has(200), true);
});
