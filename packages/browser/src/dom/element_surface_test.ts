/**
 * The three B1.5 errata on the vendored DOM pipeline, each pinned against a recorded capture rather
 * than a hand-built node (D-TEST1): E-39 decodes the value columns the capture already carried,
 * E-40 publishes the frame tree with its composition marker, and E-41 splits "not rendered" from
 * "rendered but off-screen" so `include_hidden` can admit the second class only.
 */
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { type DomCapture, extractFromCapture, mergeDomTrees, walkTree } from './extract.ts';
import { isOffscreenOnly, serializeDomState } from './serialize.ts';
import type { EnhancedDomTreeNode } from './types.ts';
import { DOM_FIXTURE_PAGES } from '../../fixtures/dom/pages.ts';

const FIXTURE_DIR = fromFileUrl(new URL('../../fixtures/dom', import.meta.url));

async function loadCapture(name: string): Promise<DomCapture> {
	return JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/${name}.capture.json`)) as DomCapture;
}

function byId(root: EnhancedDomTreeNode, id: string): EnhancedDomTreeNode {
	for (const node of walkTree(root)) if (node.attributes['id'] === id) return node;
	throw new Error(`no element with id ${id}`);
}

// --- E-39: the value columns ------------------------------------------------------------------------

Deno.test('E-39: the live input value, checked state and option selection are decoded from the capture', async () => {
	// `live_value_vs_attribute.html` writes every value through the DOM *property*, never the
	// attribute, so this is the one page where the decoded column and the markup provably differ.
	const merged = mergeDomTrees(await loadCapture('live_value_vs_attribute'));
	assert(merged.root !== null);

	const text = byId(merged.root, 'lv-text');
	assertEquals(text.attributes['value'], 'markup-only-value', 'the attribute keeps the authored value');
	assertEquals(text.snapshotNode?.inputValue, 'live-typed-value', 'the column carries what the script typed');

	const number = byId(merged.root, 'lv-number');
	assertEquals(number.attributes['value'], '7');
	assertEquals(number.snapshotNode?.inputValue, '42');

	// The checked column is present on this capture, so "unchecked" is a real `false` rather than an
	// absent column read as `null`.
	assertEquals(byId(merged.root, 'lv-check-on').snapshotNode?.inputChecked, true, 'ticked by script');
	assertEquals(byId(merged.root, 'lv-check-off').snapshotNode?.inputChecked, false, 'unticked by script');

	// The markup selects Alpha; the script selects Gamma. The column follows the script.
	const select = byId(merged.root, 'lv-select');
	const options = select.childrenNodes.filter((child) => child.nodeName === 'OPTION');
	assertEquals(options.map((option) => option.snapshotNode?.optionSelected), [false, false, true]);

	// A control with no value column entry reads `null`, never `''`: absence and emptiness differ.
	assertEquals(byId(merged.root, 'lv-tail').snapshotNode?.inputValue, null);
});

Deno.test('E-39: a capture recorded without a column reads null for every node, not false', async () => {
	// `textValue` is present-but-empty on the live-value page; a page with no `<textarea>` writes at
	// all still yields `null` per node, so a consumer can tell "no such state" from "empty".
	const merged = mergeDomTrees(await loadCapture('baseline_button'));
	assert(merged.root !== null);
	for (const node of walkTree(merged.root)) {
		if (node.snapshotNode === null) continue;
		assertEquals(node.snapshotNode.textValue, null);
	}
});

// --- E-40: the frame tree ---------------------------------------------------------------------------

Deno.test('E-40: an OOPIF and a pierced frame are both listed, with the composition marker true', async () => {
	const oopif = mergeDomTrees(await loadCapture('iframe_crossorigin'));
	assertEquals(oopif.frames.length, 2, 'the top document plus one cross-site frame');
	const [top, child] = oopif.frames;
	assert(top !== undefined && child !== undefined);
	assertEquals(top.parentFrameId, null);
	assertEquals(top.isOopif, false);
	assertEquals(top.composed, true);
	assertEquals(child.parentFrameId, top.frameId);
	assertEquals(child.isOopif, true, 'a cross-site frame is its own session');
	assertEquals(child.captured, true);
	assertEquals(child.composed, true, 'the host had a box and the child session had a snapshot document');
	assertNotEquals(child.url, '', 'the frame carries its own URL, in full');
	assert(child.hostBounds !== null && child.hostBounds.width > 0, 'the host <iframe> box is on the record');
	// The record's frameId is the join key every element inside the frame carries.
	assert(oopif.root !== null);
	assertEquals(byId(oopif.root, 'xo-button').frameId, child.frameId);

	const nested = mergeDomTrees(await loadCapture('iframe_nested'));
	assertEquals(nested.frames.length, 3, 'the top document plus two nested same-site frames');
	const [, outer, inner] = nested.frames;
	assert(outer !== undefined && inner !== undefined);
	assertEquals(outer.isOopif, false, 'a same-site frame is pierced in-process');
	assertEquals(inner.parentFrameId, outer.frameId, 'depth two hangs off depth one, not off the root');
	assertEquals(nested.frames.every((frame) => frame.composed), true);
	assertEquals(nested.captureTruncated, false);
});

Deno.test('E-40: the marker is false when the host has no box, and the tree still builds', async () => {
	// Strip the host iframe's layout row from a recorded capture: this is architecture §5.3 case 3,
	// the silent degradation where a whole subtree stacks at the page origin. The point of the marker
	// is that this state is now visible on the record rather than only in the wrong numbers.
	const capture = await loadCapture('iframe_crossorigin');
	const merged = mergeDomTrees(capture);
	assert(merged.root !== null);
	const hostBackendNodeId = byId(merged.root, 'xorigin-frame').backendNodeId;
	const session = capture.sessions[0];
	assert(session !== undefined);
	const doc = session.snapshot.documents[0];
	assert(doc !== undefined);
	const hostIndex = (doc.nodes.backendNodeId ?? []).indexOf(hostBackendNodeId);
	assert(hostIndex >= 0);
	const layoutRow = doc.layout.nodeIndex.indexOf(hostIndex);
	assert(layoutRow >= 0, 'the recorded host has a layout row to remove');
	const degraded: DomCapture = {
		...capture,
		sessions: capture.sessions.map((entry, i) =>
			i !== 0 ? entry : {
				...entry,
				snapshot: {
					...entry.snapshot,
					documents: entry.snapshot.documents.map((document, d) =>
						d !== 0 ? document : {
							...document,
							layout: {
								...document.layout,
								nodeIndex: document.layout.nodeIndex.filter((_, row) => row !== layoutRow),
								bounds: document.layout.bounds.filter((_, row) => row !== layoutRow),
								styles: document.layout.styles.filter((_, row) => row !== layoutRow),
							},
						}
					),
				},
			}
		),
	};
	const result = mergeDomTrees(degraded);
	const child = result.frames[1];
	assert(child !== undefined);
	assertEquals(child.composed, false, 'no host box: the composition is not established');
	assertEquals(child.hostBounds, null);
	assertEquals(child.captured, true, 'the child session was still captured; only its placement is unknown');
});

Deno.test('E-40: capture truncation is a flag on the result, not only a warning string', async () => {
	const capture = await loadCapture('iframe_crossorigin');
	assertEquals(extractFromCapture(capture).captureTruncated, false, 'recorded captures predate the flag');
	const truncated = extractFromCapture({ ...capture, truncated: true });
	assertEquals(truncated.captureTruncated, true);
	assertEquals(truncated.frameTree.length, 2, 'the flag does not change what was walked');
});

Deno.test('E-40: every recorded capture lists exactly the frames its nodes belong to, root first', async () => {
	for (const page of DOM_FIXTURE_PAGES) {
		const merged = mergeDomTrees(await loadCapture(page.name));
		assert(merged.root !== null, page.name);
		const listed = new Set(merged.frames.map((frame) => frame.frameId));
		const seen = new Set<string>();
		for (const node of walkTree(merged.root)) seen.add(node.frameId);
		for (const frameId of seen) assert(listed.has(frameId), `${page.name}: nodes in unlisted frame ${frameId}`);
		assertEquals(merged.frames[0]?.parentFrameId, null, `${page.name}: the root is first`);
		assertEquals(new Set(merged.frames.map((frame) => frame.frameId)).size, merged.frames.length, page.name);
	}
});

// --- E-41: the offscreen split ----------------------------------------------------------------------

Deno.test('E-41: an element beyond the slack is admitted only when asked, and only if it is rendered', async () => {
	// `scroll_page` puts controls one viewport apart down a long page at the pinned 1280x900 viewport;
	// the last ones sit past the ±1000 px band and are absent from every golden.
	const merged = mergeDomTrees(await loadCapture('scroll_page'));
	assert(merged.root !== null);
	const far = byId(merged.root, 'p-b10');
	assertEquals(far.isVisible, false, 'the corpus element really is outside the band');
	assertEquals(isOffscreenOnly(far), true, 'and it failed only the viewport test');

	const strict = serializeDomState(merged.root);
	const admitted = serializeDomState(merged.root, { includeOffscreen: true });
	const strictIndices = new Set(strict.state.selectorMap.values());
	const admittedIndices = new Set(admitted.state.selectorMap.values());
	assert(!strictIndices.has(far), 'default behaviour is unchanged: the far control is not indexed');
	assert(admittedIndices.has(far), 'with includeOffscreen the far control is indexed');
	assert(admitted.state.selectorMap.size > strict.state.selectorMap.size);
	// Every element the default admitted is still admitted with the same index: the option adds,
	// never renumbers, because index assignment is document order and backendNodeId first.
	for (const [index, node] of strict.state.selectorMap) assertEquals(admitted.state.selectorMap.get(index), node);
});

Deno.test('E-41: a display:none element is never admitted, whatever the option says', async () => {
	// `visibility_edge_cases` carries controls that fail the CSS gate outright. They have no box and
	// no styles, so `isOffscreenOnly` is false and the walk keeps hiding them.
	const merged = mergeDomTrees(await loadCapture('visibility_edge_cases'));
	assert(merged.root !== null);
	const notRendered = [...walkTree(merged.root)].filter((node) =>
		node.nodeType === 1 && node.isVisible === false && node.snapshotNode?.computedStyles === null
	);
	assert(notRendered.length > 0, 'the fixture carries unrendered elements');
	const admitted = serializeDomState(merged.root, { includeOffscreen: true });
	const indexed = new Set(admitted.state.selectorMap.values());
	for (const node of notRendered) {
		assertEquals(isOffscreenOnly(node), false);
		assert(!indexed.has(node), `an unrendered ${node.nodeName} was indexed`);
	}
});
