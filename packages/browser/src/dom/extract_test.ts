/**
 * `dom-extraction` unit tier — recorded CDP payloads in, `EnhancedDomTreeNode` IR out.
 *
 * Every test here replays a fixture from `packages/core/fixtures/dom/`, captured from real headless
 * Chrome 145 against the **shared** corpus in `tests/fixtures/pages/` — the same bytes the Python
 * reference was recorded against. A recorded payload is data, not a mock (D-TEST1): this is the same
 * merge code the browser path runs, and no CDP client, event bus or HTTP surface is faked anywhere in
 * the file.
 *
 * **This file is the R1 audit surface.** Each heuristic in the merge is named below with the test that
 * pins it; if a heuristic changes, exactly one of these fails, which is the whole point.
 *
 * | # | Heuristic | Test | Corpus page |
 * |---|---|---|---|
 * | H1 | three-tree join on `backendNodeId` | "joins all three trees" | `form_attributes`, `visibility_edge_cases` |
 * | H2 | exactly the 10 whitelisted computed styles | "requests and decodes exactly the whitelist" | `form_attributes` |
 * | H3 | CSS visibility gate (display / visibility / opacity) | "CSS gate" | `visibility_edge_cases` |
 * | H4 | `opacity:0` propagates to descendants | "opacity propagates" | `visibility_edge_cases` |
 * | H5 | zero-area bounding-box filter | "bbox filter" | `visibility_edge_cases` |
 * | H6 | frame-chain viewport test, ±1000 px vertical slack | "viewport slack" | `scroll_page`, `visibility_edge_cases` |
 * | H7 | page-absolute geometry: DPR, frame content box, frame scroll | "absolute geometry" | `iframe_nested`, `iframe_oopif_scrolled` |
 * | H8 | same-origin pierce vs OOPIF session recursion | "frame traversal" | `iframe_nested`, `iframe_same_site_port`, `iframe_crossorigin` |
 * | H9 | shadow roots out of `childrenNodes`, type preserved | "shadow roots" | `shadow_open`, `shadow_closed`, `form_attributes`, `select_native` |
 * | H10 | `isClickable` / `paintOrder` / `stackingContexts` decode | "paint order and clickability" | `occlusion_paint_order`, `stacking_contexts`, `js_click_listeners` |
 * | H11 | listener census index alignment + caps + delegation | "listener census" | `js_click_listeners` |
 * | H12 | AX property whitelist, relation drop, non-ignored preference | "AX projection" | `form_attributes`, `radio_checkbox_group`, `react_controlled_inputs` |
 * | H13 | capture context (`targetId`/`frameId`/`sessionId`) per node | "capture context" | `iframe_crossorigin` |
 * | H14 | `hiddenElementsInfo` cap + ordering | "hidden element hints" | `iframe_hidden_elements`, `iframe_oopif_scrolled` |
 * | H15 | attribute folding, node-type normalisation | "structural decoding" | `form_attributes`, `baseline_button`, `svg_children` |
 * | H16 | budget / recovery contract | "recovery state" | `empty_page` |
 *
 * ERRATUM(M1-dom-test-repair): the corpus moved from 30 programmatic pages to the 32 shared static
 * pages, so every heuristic above changed page. Two legs could not follow it and are called out at
 * their test: `visibility: collapse` (no corpus page uses it — pinned on the primitive instead) and a
 * top-level *scrolled* document (no corpus page scrolls the main frame — pinned on a capture derived
 * from a recorded one, exactly as the H11 census-mismatch test derives its own).
 */

import { assert, assertAlmostEquals, assertEquals, assertGreater, assertLess, assertNotEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import {
	computeVisibility,
	DOM_BUILD_BUDGET_MS,
	type DomCapture,
	extractFromCapture,
	foldAttributes,
	intersectsWithSlack,
	isFullyTransparent,
	LISTENER_CENSUS_MAX_ELEMENTS,
	LISTENER_CENSUS_MAX_LISTENERS,
	mergeDomTrees,
	NETWORK_PROBE_MAX_MS,
	NETWORK_STABILITY_MS,
	nodeKey,
	paintsAbove,
	passesCssGate,
	recoveryState,
	SNAPSHOT_COMPUTED_STYLES,
	VIEWPORT_VERTICAL_SLACK_PX,
	walkTree,
} from './extract.ts';
import { KNOWN_AX_PROPERTIES } from './extract_ax.ts';
import { MAX_HIDDEN_ELEMENT_HINTS } from './extract_merge.ts';
import { type EnhancedDomTreeNode, type EnhancedSnapshotNode, REQUIRED_COMPUTED_STYLES } from './types.ts';
import { DOM_FIXTURE_PAGES } from '../../fixtures/dom/pages.ts';

const FIXTURE_DIR = fromFileUrl(new URL('../../fixtures/dom', import.meta.url));

async function loadCapture(name: string): Promise<DomCapture> {
	const text = await Deno.readTextFile(`${FIXTURE_DIR}/${name}.capture.json`);
	return JSON.parse(text) as DomCapture;
}

async function loadTree(name: string): Promise<EnhancedDomTreeNode> {
	const merged = mergeDomTrees(await loadCapture(name));
	assert(merged.root !== null, `${name}: merge produced no root`);
	return merged.root;
}

function byId(root: EnhancedDomTreeNode, id: string): EnhancedDomTreeNode {
	for (const node of walkTree(root)) {
		if (node.attributes.id === id) return node;
	}
	throw new Error(`#${id} not found in the merged tree`);
}

function maybeById(root: EnhancedDomTreeNode, id: string): EnhancedDomTreeNode | null {
	for (const node of walkTree(root)) {
		if (node.attributes.id === id) return node;
	}
	return null;
}

function findByTag(root: EnhancedDomTreeNode, nodeName: string): EnhancedDomTreeNode[] {
	return walkTree(root).filter((node) => node.nodeName === nodeName);
}

/** A snapshot projection carrying nothing but the styles under test. */
function styledSnapshot(computedStyles: EnhancedSnapshotNode['computedStyles']): EnhancedSnapshotNode {
	return {
		bounds: null,
		computedStyles,
		cursorStyle: null,
		paintOrder: null,
		clientRects: null,
		scrollRects: null,
		stackingContexts: null,
		isClickable: false,
		inputValue: null,
		inputChecked: null,
		optionSelected: null,
		textValue: null,
	};
}

/** The recorded page-absolute geometry of every node, keyed by composite id. */
function geometryOf(root: EnhancedDomTreeNode): Map<string, string> {
	const out = new Map<string, string>();
	for (const node of walkTree(root)) {
		out.set(nodeKey(node.sessionId, node.backendNodeId), JSON.stringify(node.absolutePosition));
	}
	return out;
}

// ---------------------------------------------------------------------------
// corpus-wide invariants
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: the recorded corpus covers the ≥20 pages COMPLETIONS-CRITERIA §3.2 asks for', async () => {
	const names = DOM_FIXTURE_PAGES.map((page) => page.name);
	assertGreater(names.length, 19);
	assertEquals(new Set(names).size, names.length, 'fixture page names must be unique');
	for (const name of names) {
		const stat = await Deno.stat(`${FIXTURE_DIR}/${name}.capture.json`);
		assert(stat.isFile, `${name}: no recorded capture`);
	}
});

Deno.test('dom-extraction: every fixture merges into a tree with no warnings', async () => {
	const problems: string[] = [];
	for (const page of DOM_FIXTURE_PAGES) {
		const merged = mergeDomTrees(await loadCapture(page.name));
		if (merged.root === null) problems.push(`${page.name}: no root`);
		if (merged.warnings.length > 0) problems.push(`${page.name}: ${merged.warnings.join('; ')}`);
		if (merged.nodeCount !== merged.byKey.size) problems.push(`${page.name}: node count disagrees with the key map`);
	}
	assertEquals(problems, []);
});

Deno.test('dom-extraction: the merge is deterministic apart from node uuids', async () => {
	const capture = await loadCapture('form_attributes');
	const strip = (root: EnhancedDomTreeNode): unknown =>
		walkTree(root).map((node) => ({
			backendNodeId: node.backendNodeId,
			nodeName: node.nodeName,
			isVisible: node.isVisible,
			absolutePosition: node.absolutePosition,
			attributes: node.attributes,
			hasJsClickListener: node.hasJsClickListener,
		}));
	const first = mergeDomTrees(capture);
	const second = mergeDomTrees(capture);
	assert(first.root !== null && second.root !== null);
	assertEquals(strip(first.root), strip(second.root));
	assertNotEquals(first.root.uuid, second.root.uuid, 'uuids are freshly generated per merge');
});

// ---------------------------------------------------------------------------
// H1 — the three-tree join
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: joins all three trees on backendNodeId (H1)', async () => {
	const root = await loadTree('form_attributes');
	const button = findByTag(root, 'BUTTON').find((node) => node.attributes.type === 'submit');
	assert(button !== undefined);

	// DOM provenance.
	assertEquals(button.nodeName, 'BUTTON');
	assertEquals(button.nodeType, 1);
	assertEquals(button.attributes.id, 'f-submit');
	assertEquals(button.attributes.type, 'submit');
	// DOMSnapshot provenance.
	assert(button.snapshotNode !== null, 'no snapshot projection');
	assert(button.snapshotNode.bounds !== null);
	assertEquals(button.snapshotNode.computedStyles?.display, 'inline-block');
	// Accessibility provenance.
	assert(button.axNode !== null, 'no AX projection');
	assertEquals(button.axNode.role, 'button');
	assertEquals(button.axNode.name, 'Submit');

	const link = byId(root, 'f-link-role');
	assertEquals(link.nodeName, 'A');
	assertEquals(link.axNode?.role, 'link');
	assertEquals(link.attributes.title, 'role equals tag anchor');

	// A native `disabled` reaches the IR only through the AX tree — it is not a DOM attribute here.
	const disabled = byId(await loadTree('visibility_edge_cases'), 'v-disabled');
	assertEquals(disabled.axNode?.properties?.find((p) => p.name === 'disabled')?.value, true);
});

// ---------------------------------------------------------------------------
// H2 — the computed-style whitelist
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: requests and decodes exactly the 10 whitelisted computed styles (H2)', async () => {
	// The list is normative, not advisory: DATA-MODEL §6.2 states that asking for more crashes Chrome
	// on heavy sites, so the request array must be the seam constant itself.
	assertEquals([...SNAPSHOT_COMPUTED_STYLES], [...REQUIRED_COMPUTED_STYLES]);
	assertEquals(SNAPSHOT_COMPUTED_STYLES.length, 10);

	const root = await loadTree('form_attributes');
	const styled = walkTree(root).filter((node) => node.snapshotNode?.computedStyles != null);
	assertGreater(styled.length, 3);
	const whitelist = new Set<string>(REQUIRED_COMPUTED_STYLES);
	for (const node of styled) {
		for (const key of Object.keys(node.snapshotNode?.computedStyles ?? {})) {
			assert(whitelist.has(key), `computed style outside the whitelist leaked in: ${key}`);
		}
	}
	// `cursorStyle` mirrors the `cursor` column rather than being a second request.
	const cursored = styled.find((node) => node.snapshotNode?.cursorStyle != null);
	assert(cursored !== undefined);
	assertEquals(cursored.snapshotNode?.cursorStyle, cursored.snapshotNode?.computedStyles?.cursor);
	// And it carries a real, non-default value somewhere on the page rather than a constant.
	assertEquals(byId(root, 'f-link-role').snapshotNode?.cursorStyle, 'pointer');
});

// ---------------------------------------------------------------------------
// H3/H4/H5 — the CSS gate, opacity propagation, the bbox filter
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: CSS gate rejects display:none, visibility:hidden and collapse (H3)', async () => {
	const root = await loadTree('visibility_edge_cases');
	assertEquals(byId(root, 'v-visible').isVisible, true);
	assertEquals(byId(root, 'v-display-none').isVisible, false);
	assertEquals(byId(root, 'v-visibility-hidden').isVisible, false);

	// `display:none` leaves no layout row at all, which is why a missing style set fails the gate.
	assertEquals(byId(root, 'v-display-none').snapshotNode?.computedStyles, null);
	assertEquals(byId(root, 'v-display-none').absolutePosition, null);
	assertEquals(passesCssGate(byId(root, 'v-display-none').snapshotNode), false);
	assertEquals(byId(root, 'v-visibility-hidden').snapshotNode?.computedStyles?.visibility, 'hidden');

	// `visibility: collapse` is fixture-backed again (`visibility_collapse.html`, added by M1-parity-fixes
	// to restore the leg the corpus reconciliation dropped). Inside a table it removes the row the way
	// `display: none` does — Chrome emits no layout row at all, which is the strongest form of the gate —
	// and outside one it behaves as `visibility: hidden`, which a descendant can undo.
	const collapsed = await loadTree('visibility_collapse');
	assertEquals(byId(collapsed, 'vc-b1').isVisible, true, 'the uncollapsed row is untouched');
	assertEquals(byId(collapsed, 'vc-b2').isVisible, false, 'a collapsed table row hides its contents');
	assertEquals(byId(collapsed, 'vc-row-collapsed').snapshotNode?.computedStyles?.visibility, 'collapse');
	assertEquals(byId(collapsed, 'vc-b4').isVisible, false, 'outside a table, collapse reads as hidden');
	assertEquals(byId(collapsed, 'vc-block').snapshotNode?.computedStyles?.visibility, 'collapse');
	// Inherited, and reversible by an explicit `visibility: visible` — which is exactly why the gate is
	// per-node and not propagated the way opacity once was.
	assertEquals(byId(collapsed, 'vc-outer').isVisible, false);
	assertEquals(byId(collapsed, 'vc-b5').snapshotNode?.computedStyles?.visibility, 'visible');
	assertEquals(byId(collapsed, 'vc-b5').isVisible, true, 'a descendant can undo an inherited collapse');

	assertEquals(passesCssGate(styledSnapshot({ display: 'block', visibility: 'collapse' })), false);
	assertEquals(passesCssGate(styledSnapshot({ display: 'block', visibility: 'visible' })), true);
	assertEquals(passesCssGate(styledSnapshot({ display: 'none' })), false);
	assertEquals(passesCssGate(styledSnapshot(null)), false, 'no layout row is the strongest signal');
});

Deno.test('dom-extraction: opacity is NOT part of the visibility gate (H4)', async () => {
	// ERRATUM(M1-parity-12): this leg used to assert the opposite — an `opacity: 0` wrapper hid its
	// subtree. The reference indexes `#v-opacity-zero` and renders its sibling span's text, so opacity
	// is not a hiding signal at all: neither on the node nor propagated (DECISION-REGISTER §9.6 (E-23)).
	const root = await loadTree('visibility_edge_cases');
	const wrapper = byId(root, 'v-opacity-zero').parentNode;
	assert(wrapper !== null);
	assertEquals(wrapper.snapshotNode?.computedStyles?.opacity, '0');
	assertEquals(isFullyTransparent(wrapper.snapshotNode), true, 'the predicate still describes the node');
	assertEquals(passesCssGate(wrapper.snapshotNode), true, 'but the CSS gate does not consult it');
	assertEquals(wrapper.isVisible, true);
	// The child's own computed opacity is 1 — opacity does not inherit.
	assertEquals(byId(root, 'v-opacity-zero').snapshotNode?.computedStyles?.opacity, '1');
	assertEquals(byId(root, 'v-opacity-zero').isVisible, true);
});

Deno.test('dom-extraction: a zero-area box is visible; there is no area gate (H5)', async () => {
	// ERRATUM(M1-parity-12): this leg used to assert that a zero-area box is invisible. §6.1 names a CSS
	// gate and a frame-chain viewport test and no third gate, and the reference indexes both
	// `#v-zero-size` (0x0) and `#l-empty` (an anchor with no content at all).
	const root = await loadTree('visibility_edge_cases');
	const box = byId(root, 'v-zero-size');
	assert(box.absolutePosition !== null);
	assertEquals(box.absolutePosition.width * box.absolutePosition.height, 0);
	assertEquals(passesCssGate(box.snapshotNode), true, 'nothing in the CSS gate objects to a zero-area box');
	assertEquals(box.isVisible, true, 'a zero-area box is still in the viewport band');

	const label = box.childrenNodes[0];
	assert(label !== undefined && label.nodeType === 3);
	assert(label.absolutePosition !== null);
	assertGreater(label.absolutePosition.width * label.absolutePosition.height, 0);
	// The ancestor `overflow:hidden` clip chain is deliberately outside the gate, so the clipped child
	// reads visible too — §6.1 specifies the FRAME chain, not an arbitrary clip chain.
	assertEquals(label.isVisible, true);

	// The viewport test is written on the rect's edges, not on its area, which is what lets a degenerate
	// rect through while an off-screen one still fails.
	const viewport = { x: 0, y: 0, width: 800, height: 600 };
	assertEquals(intersectsWithSlack({ x: 10, y: 10, width: 0, height: 0 }, viewport, 1000), true);
	assertEquals(intersectsWithSlack({ x: 0, y: 10, width: 0, height: 0 }, viewport, 1000), false, 'x=0 is the edge');
});

// ---------------------------------------------------------------------------
// H6 — the frame-chain viewport test
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: the viewport test grants ±1000px of vertical slack and none horizontally (H6)', async () => {
	assertEquals(VIEWPORT_VERTICAL_SLACK_PX, 1000);
	// 900 px viewport, 400 px blocks: the control at y≈1697 is inside viewport+1000, the one at y≈2097
	// is not. This only holds at the manifest's recorded 1280×900 viewport.
	const scroll = await loadTree('scroll_page');
	assertEquals(byId(scroll, 'p-b1').isVisible, true);
	assertEquals(byId(scroll, 'p-b5').isVisible, true, 'y≈1697 is inside the 900+1000px window');
	assertEquals(byId(scroll, 'p-b6').isVisible, false, 'y≈2097 is past viewport+1000px');

	const edges = await loadTree('visibility_edge_cases');
	assertEquals(byId(edges, 'v-offscreen-left').isVisible, false, 'horizontal overflow gets no slack');
	assertEquals(byId(edges, 'v-offscreen-above').isVisible, false, '5000px up is past the slack');
	assertEquals(byId(edges, 'v-offscreen-below').isVisible, false);

	// The primitive itself, away from any fixture.
	const viewport = { x: 0, y: 0, width: 800, height: 600 };
	assertEquals(intersectsWithSlack({ x: 0, y: 1599, width: 10, height: 10 }, viewport, 1000), true);
	assertEquals(intersectsWithSlack({ x: 0, y: 1600, width: 10, height: 10 }, viewport, 1000), false);
	assertEquals(intersectsWithSlack({ x: 0, y: -1009, width: 10, height: 10 }, viewport, 1000), true);
	assertEquals(intersectsWithSlack({ x: 0, y: -1010, width: 10, height: 10 }, viewport, 1000), false);
	assertEquals(intersectsWithSlack({ x: 800, y: 0, width: 10, height: 10 }, viewport, 1000), false);

	// Non-visual node types report "unknown", not "invisible": a shadow root's children are visible.
	assertEquals(computeVisibility(11, null, null, viewport, 1000), null);
	assertEquals(computeVisibility(9, null, null, viewport, 1000), null);
	assertEquals(computeVisibility(1, null, null, viewport, 1000), false);
});

Deno.test('dom-extraction: a scrolled document moves the test band and nothing else (H6)', async () => {
	// ERRATUM(M1-dom-test-repair): no page in the shared corpus scrolls the *main* frame, so the band
	// is moved here instead — `layoutMetrics.scrollY` is the only input the merge reads for it
	// (`visibleRect.y = metrics.scrollY`). Same technique as the H11 census-mismatch test: the recorded
	// geometry is untouched, one scalar of the capture is not. The frame-level equivalent against a
	// genuinely scrolled document is the `iframe_oopif_scrolled` test under H7.
	const capture = await loadCapture('scroll_page');
	assertEquals(capture.sessions[0]?.layoutMetrics.scrollY, 0, 'the recorded page is at the top');
	const scrolled: DomCapture = {
		...capture,
		sessions: capture.sessions.map((session) => ({
			...session,
			layoutMetrics: { ...session.layoutMetrics, scrollY: 1500 },
		})),
	};

	const before = mergeDomTrees(capture);
	const after = mergeDomTrees(scrolled);
	assert(before.root !== null && after.root !== null);

	// Page-absolute, i.e. unaffected by the scroll — every box keeps its document coordinates.
	assertEquals(geometryOf(after.root), geometryOf(before.root), 'a scroll must not move page-absolute geometry');
	assertAlmostEquals(byId(after.root, 'p-b1').absolutePosition?.y ?? -1, 96.6875, 0.01);
	assertAlmostEquals(byId(after.root, 'p-b5').absolutePosition?.y ?? -1, 1696.6875, 0.01);

	// Only the *test band* moves: [1500, 2400] ± 1000 px.
	assertEquals(byId(after.root, 'p-b1').isVisible, false, 'y≈97 is 1383px above the band, past the slack');
	assertEquals(byId(before.root, 'p-b1').isVisible, true, 'and was visible before the band moved');
	assertEquals(byId(after.root, 'p-b5').isVisible, true);
	assertEquals(byId(after.root, 'p-b9').isVisible, true, 'y≈3297 is inside band+1000');
	assertEquals(byId(after.root, 'p-b10').isVisible, false, 'y≈3697 is past it');
	assertEquals(byId(before.root, 'p-b9').isVisible, false, 'and was invisible before the band moved');
});

// ---------------------------------------------------------------------------
// H7/H8 — geometry composition and frame traversal
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: frame geometry composes through the content box (H7)', async () => {
	const root = await loadTree('iframe_nested');
	const frame = byId(root, 'frame-depth-1');
	assert(frame.contentDocument !== null);
	const document = frame.contentDocument;
	assert(frame.absolutePosition !== null && document.absolutePosition !== null);
	const client = frame.snapshotNode?.clientRects;
	assert(client != null, 'the frame host must carry clientRects');

	// `clientRects.x/y` is Chrome's `clientLeft`/`clientTop` — the border+padding inset. Adding it to
	// the host's border-box origin lands exactly on the child document's origin, so no approximation
	// of the iframe border is needed.
	assertEquals(client.x, 1, 'the corpus iframes carry a 1px border');
	assertEquals(client.y, 1);
	assertAlmostEquals(document.absolutePosition.x, frame.absolutePosition.x + client.x, 0.01);
	assertAlmostEquals(document.absolutePosition.y, frame.absolutePosition.y + client.y, 0.01);
	assertEquals(document.absolutePosition.width, client.width, 'the child document fills the content box');

	// And a control inside that document lands inside the composed box, not at its own frame-local y.
	const inner = byId(document, 'd1-button');
	assert(inner.absolutePosition !== null);
	assertGreater(inner.absolutePosition.x, document.absolutePosition.x);
	assertGreater(inner.absolutePosition.y, document.absolutePosition.y);
});

Deno.test('dom-extraction: an inner-frame scroll offset is subtracted from child geometry (H7)', async () => {
	const capture = await loadCapture('iframe_oopif_scrolled');
	// The child document is genuinely scrolled: `frame_prescrolled.html` runs `scrollTo(0, 260)`.
	assertEquals(capture.sessions.map((session) => session.layoutMetrics.scrollY), [0, 260]);
	const merged = mergeDomTrees(capture);
	assert(merged.root !== null);
	const frame = byId(merged.root, 'oos-frame');
	assert(frame.contentDocument !== null && frame.absolutePosition !== null);
	const document = frame.contentDocument;
	assert(document.absolutePosition !== null);
	const client = frame.snapshotNode?.clientRects;
	assert(client != null);

	// The document origin is the content-box top *minus* the frame's own scroll offset, so the rows
	// scrolled off the top land at negative page coordinates rather than being silently clamped.
	assertAlmostEquals(document.absolutePosition.y, frame.absolutePosition.y + client.y - 260, 0.01);
	const first = byId(document, 'fp-b01');
	assert(first.absolutePosition !== null);
	assertLess(first.absolutePosition.y, frame.absolutePosition.y);
	assertLess(first.absolutePosition.y, 0);
});

Deno.test('dom-extraction: nested same-origin frames accumulate offsets in one session (H8)', async () => {
	const capture = await loadCapture('iframe_nested');
	assertEquals(capture.sessions.length, 1, 'same-site frames stay in-process and are pierced');
	const root = await loadTree('iframe_nested');
	const outer = byId(root, 'frame-depth-1');
	assert(outer.contentDocument !== null);
	const inner = byId(outer.contentDocument, 'frame-depth-2');
	assert(inner.contentDocument !== null);
	const leaf = byId(inner.contentDocument, 'd2-button');

	assert(outer.absolutePosition !== null && inner.absolutePosition !== null && leaf.absolutePosition !== null);
	assertGreater(inner.absolutePosition.x, outer.absolutePosition.x);
	assertGreater(leaf.absolutePosition.x, inner.absolutePosition.x);
	// All three frames share one session; only the frameId changes.
	assertEquals(leaf.sessionId, outer.sessionId);
	assertNotEquals(leaf.frameId, outer.frameId);
	assertNotEquals(inner.frameId, outer.frameId);
});

Deno.test('dom-extraction: a cross-origin but same-site frame is still pierced (H8)', async () => {
	// FINDING(M1-dom-test-repair): `iframe_same_site_port` points at `http://127.0.0.1:38112`, which
	// nothing bound at record time (the secondary origin binds the *host* `localhost`), so the frame
	// that got captured is Chrome's network-error document. The heuristic under test survives intact —
	// a same-site child is inlined by `DOM.getDocument` into the host session rather than recursed into
	// as its own target — but the child document's *content* is Chrome's, not the corpus's. Reported,
	// not repaired: the corpus HTML is hash-pinned by `tests/fixtures/manifest.json`.
	const capture = await loadCapture('iframe_same_site_port');
	assertEquals(capture.sessions.length, 1);
	const root = await loadTree('iframe_same_site_port');
	const frame = byId(root, 'ssp-frame');
	assert(frame.contentDocument !== null, 'a same-site frame must be inlined by DOM.getDocument');
	assertEquals(frame.contentDocument.sessionId, frame.sessionId);
	assertEquals(frame.contentDocument.targetId, frame.targetId);
	assertNotEquals(frame.contentDocument.frameId, frame.frameId, 'one session, but its own frame');
});

Deno.test('dom-extraction: an OOPIF recurses into its own session and id space (H8, H13)', async () => {
	const capture = await loadCapture('iframe_crossorigin');
	assertEquals(capture.sessions.length, 2, 'a cross-site frame gets its own target');
	const merged = mergeDomTrees(capture);
	assert(merged.root !== null);
	const frame = byId(merged.root, 'xorigin-frame');
	assert(frame.contentDocument !== null);

	assertNotEquals(frame.contentDocument.sessionId, frame.sessionId);
	assertNotEquals(frame.contentDocument.targetId, frame.targetId);
	const inner = byId(frame.contentDocument, 'xo-button');
	// backendNodeId restarts in the child process: on its own it is ambiguous, so the composite key is
	// what the selectorMap and the replay cascade must be built on.
	assertLess(inner.backendNodeId, frame.backendNodeId);
	assertEquals(merged.byKey.get(nodeKey(inner.sessionId, inner.backendNodeId)), inner);
	const collision = merged.byKey.get(nodeKey(frame.sessionId, inner.backendNodeId));
	assert(collision !== undefined, 'the host session really does reuse this backendNodeId');
	assertNotEquals(collision, inner, 'the same backendNodeId in the host session addresses a different node');

	// Geometry still composes across the process boundary.
	const client = frame.snapshotNode?.clientRects;
	assert(client != null && frame.absolutePosition !== null && frame.contentDocument.absolutePosition !== null);
	assertAlmostEquals(frame.contentDocument.absolutePosition.x, frame.absolutePosition.x + client.x, 0.01);
	assert(inner.absolutePosition !== null);
	assertGreater(inner.absolutePosition.x, frame.absolutePosition.x);
});

Deno.test('dom-extraction: every node carries its capture context (H13)', async () => {
	const merged = mergeDomTrees(await loadCapture('iframe_crossorigin'));
	assert(merged.root !== null);
	const sessions = new Set<string>();
	for (const node of walkTree(merged.root)) {
		assertNotEquals(node.sessionId, '', 'a node without a sessionId is unactionable');
		assertNotEquals(node.targetId, '');
		assertNotEquals(node.frameId, '');
		sessions.add(node.sessionId);
	}
	assertEquals(sessions.size, 2);
});

// ---------------------------------------------------------------------------
// H9 — shadow DOM
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: shadow roots are captured out of childrenNodes with their type (H9)', async () => {
	for (
		const [name, hostId, expected] of [
			['shadow_open', 'open-host-a', 'open'],
			['shadow_closed', 'closed-host', 'closed'],
		] as const
	) {
		const root = await loadTree(name);
		const host = byId(root, hostId);
		assertEquals(host.childrenNodes.length, 0, `${name}: shadow content leaked into childrenNodes`);
		assert(host.shadowRoots !== null && host.shadowRoots.length === 1);
		const shadowRoot = host.shadowRoots[0];
		assert(shadowRoot !== undefined);
		assertEquals(shadowRoot.shadowRootType, expected);
		assertEquals(shadowRoot.nodeType, 11);
		assertEquals(shadowRoot.isVisible, null, 'a fragment has no visibility of its own');
		assertEquals(shadowRoot.parentNode, host);

		// Shadow content is laid out in the host document, so it joins the snapshot normally.
		const button = shadowRoot.childrenNodes.find((child) => child.nodeName === 'BUTTON');
		assert(button !== undefined, `${name}: shadow button missing`);
		assertEquals(button.isVisible, true);
		assert(button.absolutePosition !== null);
	}

	// A shadow root nested inside a shadow root is reached the same way, at any depth and either mode.
	const nested = byId(await loadTree('shadow_open'), 'open-host-nested');
	assertEquals(nested.shadowRoots?.[0]?.shadowRootType, 'open');
	const openInClosed = byId(await loadTree('shadow_closed'), 'inner-open-host');
	assertEquals(openInClosed.shadowRoots?.[0]?.shadowRootType, 'open');
	assertEquals(openInClosed.parentNode?.nodeType, 11, 'its host lives inside the closed root above it');
});

Deno.test('dom-extraction: user-agent shadow roots are captured and marked (H9)', async () => {
	const dateInput = byId(await loadTree('form_attributes'), 'f-date');
	assert(dateInput.shadowRoots !== null);
	assertEquals(dateInput.shadowRoots[0]?.shadowRootType, 'user-agent');
	assertEquals(dateInput.childrenNodes.length, 0);

	const select = byId(await loadTree('select_native'), 'sel-simple');
	assertEquals(select.childrenNodes.filter((child) => child.nodeName === 'OPTION').length, 4);
	assert(select.shadowRoots !== null, 'the select keeps its user-agent shadow root alongside its options');
	assertEquals(select.shadowRoots[0]?.shadowRootType, 'user-agent');
});

// ---------------------------------------------------------------------------
// H10 — paint order, stacking contexts, Chrome-detected clickability
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: paint order, stacking contexts and isClickable decode faithfully (H10)', async () => {
	const root = await loadTree('occlusion_paint_order');
	const under = byId(root, 'occluded-button');
	const over = byId(root, 'cover-layer');
	assert(under.snapshotNode?.paintOrder != null && over.snapshotNode?.paintOrder != null);
	assertGreater(over.snapshotNode.paintOrder, under.snapshotNode.paintOrder);
	assertEquals(paintsAbove(over.snapshotNode, under.snapshotNode), true);
	assertEquals(paintsAbove(under.snapshotNode, over.snapshotNode), false);
	assertEquals(paintsAbove(over.snapshotNode, null), false, 'a node without paint order never wins');

	// The opaque cover contains the button's rect entirely, and both pass every gate the merge has —
	// occlusion is decidable at this tier only from paint order.
	assert(under.absolutePosition !== null && over.absolutePosition !== null);
	assertLess(over.absolutePosition.x, under.absolutePosition.x);
	assertLess(over.absolutePosition.y, under.absolutePosition.y);
	assertGreater(
		over.absolutePosition.x + over.absolutePosition.width,
		under.absolutePosition.x + under.absolutePosition.width,
	);
	assertGreater(
		over.absolutePosition.y + over.absolutePosition.height,
		under.absolutePosition.y + under.absolutePosition.height,
	);
	assertEquals(under.isVisible, true, 'the visibility gate cannot see occlusion');
	assertEquals(over.isVisible, true);

	// `stackingContexts` is CDP's `RareBooleanData`, encoded 1/0 (ERRATUM M1-dom-extract-2).
	const stacking = await loadTree('stacking_contexts');
	assertEquals(byId(stacking, 'l-mid').snapshotNode?.stackingContexts, 1, 'transform creates one');
	assertEquals(byId(stacking, 'l-opacity').snapshotNode?.stackingContexts, 1, 'opacity < 1 creates one');
	assertEquals(byId(stacking, 'l-top').snapshotNode?.stackingContexts, 1, 'isolation:isolate creates one');
	assertEquals(byId(stacking, 'sc-base').snapshotNode?.stackingContexts, 0, 'a static button creates none');
	// Negative z-index paints below its positioned siblings, and the decoded order says so.
	const negative = byId(stacking, 'l-neg').snapshotNode?.paintOrder;
	const base = byId(stacking, 'l-base').snapshotNode?.paintOrder;
	assert(negative != null && base != null);
	assertLess(negative, base);

	// `isClickable` is Chrome's own detection, decoded from a second RareBooleanData column.
	const listeners = await loadTree('js_click_listeners');
	assertEquals(byId(listeners, 'js-onclick-attr').snapshotNode?.isClickable, true);
	assertEquals(byId(listeners, 'js-no-listener').snapshotNode?.isClickable, false);
});

// ---------------------------------------------------------------------------
// H11 — the getEventListeners census
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: the listener census attributes hits to the right nodes (H11)', async () => {
	const merged = mergeDomTrees(await loadCapture('js_click_listeners'));
	assert(merged.root !== null);
	assertEquals(merged.warnings, [], 'a census/DOM element-count mismatch would have been reported');
	const root = merged.root;

	assertEquals(byId(root, 'js-addlistener').hasJsClickListener, true, 'addEventListener("click")');
	assertEquals(byId(root, 'js-onclick-attr').hasJsClickListener, true, 'inline onclick');
	assertEquals(byId(root, 'js-mousedown-only').hasJsClickListener, true, 'mousedown counts as click-initiating');
	assertEquals(byId(root, 'js-keydown-only').hasJsClickListener, false, 'keydown deliberately does not');
	assertEquals(byId(root, 'js-span-listener').hasJsClickListener, true);
	assertEquals(byId(root, 'js-delegated-parent').hasJsClickListener, true);
	assertEquals(
		byId(root, 'js-delegated-child').hasJsClickListener,
		false,
		'a delegating ancestor must not be attributed to its child',
	);
	assertEquals(byId(root, 'js-no-listener').hasJsClickListener, false);
	assertEquals(byId(root, 'native-button').hasJsClickListener, false, 'a native control needs no listener');
	assertEquals(
		byId(root, 'js-pointer-only').hasJsClickListener,
		false,
		'cursor:pointer is a style, not a listener — it is carried on cursorStyle instead',
	);
	assertEquals(byId(root, 'js-pointer-only').snapshotNode?.cursorStyle, 'pointer');
	// The control for the pair above: the same style *plus* a real listener still reads true.
	assertEquals(byId(root, 'js-cursor-pointer').hasJsClickListener, true);
	assertEquals(byId(root, 'js-cursor-pointer').snapshotNode?.cursorStyle, 'pointer');
});

Deno.test('dom-extraction: a census/DOM element-count mismatch drops the frame instead of shifting it (H11)', async () => {
	const capture = await loadCapture('js_click_listeners');
	const session = capture.sessions[0];
	assert(session?.listeners != null);
	const frame = session.listeners.frames[0];
	assert(frame !== undefined);
	assertGreater(frame.hits.length, 0);

	// Simulate a page that gained an element between the DOM read and the census: the indices no
	// longer address the same nodes, so every hit must be discarded rather than mis-applied.
	const tampered: DomCapture = {
		...capture,
		sessions: [{
			...session,
			listeners: { ...session.listeners, frames: [{ ...frame, total: frame.total + 1 }] },
		}],
	};
	const merged = mergeDomTrees(tampered);
	assert(merged.root !== null);
	assertEquals(merged.warnings.length, 1);
	assert(merged.warnings[0]?.includes('listener census skipped'));
	assertEquals(walkTree(merged.root).filter((node) => node.hasJsClickListener).length, 0);
});

Deno.test('dom-extraction: the census caps are the speced 10k elements / 100 listeners (H11)', () => {
	assertEquals(LISTENER_CENSUS_MAX_ELEMENTS, 10_000);
	assertEquals(LISTENER_CENSUS_MAX_LISTENERS, 100);
});

// ---------------------------------------------------------------------------
// H12 — the AX projection
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: AX properties are whitelisted, scalar-only, and keep CDP spelling (H12)', async () => {
	const root = await loadTree('form_attributes');
	const listbox = byId(root, 'aria-listbox-target');
	assertEquals(listbox.axNode?.role, 'listbox');
	assertEquals(listbox.axNode?.name, 'Attribute demo listbox');

	const options = listbox.childrenNodes.filter((child) => child.axNode?.role === 'option');
	assertEquals(options.length, 2);
	assertEquals(options[0]?.axNode?.properties?.find((p) => p.name === 'selected')?.value, true);
	assertEquals(options[1]?.axNode?.properties?.find((p) => p.name === 'selected')?.value, false);

	// `aria-describedby` is relation-valued; it cannot be represented as string|boolean|null and is
	// dropped rather than encoded (ERRATUM M1-dom-extract-4).
	const described = byId(root, 'f-aria');
	assertEquals(described.attributes['aria-describedby'], 'pw-help', 'the markup relation is still there');
	assertEquals(described.axNode?.properties?.find((p) => p.name === 'describedby'), undefined);
	// CDP spells it `hasPopup`; DATA-MODEL §6.5 spells the *emitted attribute* `haspopup`. The IR keeps
	// the wire spelling — case folding for emission is the serializer's job.
	assertEquals(described.axNode?.properties?.find((p) => p.name === 'hasPopup')?.value, 'listbox');

	const slider = byId(root, 'f-meter');
	assertEquals(slider.axNode?.role, 'slider');
	// Numbers are stringified to fit the seam's `string | boolean | null`.
	assertEquals(slider.axNode?.properties?.find((p) => p.name === 'valuemin')?.value, '0');
	assertEquals(slider.axNode?.properties?.find((p) => p.name === 'valuemax')?.value, '100');
	assertEquals(slider.axNode?.properties?.find((p) => p.name === 'valuetext')?.value, 'forty two percent');

	// A tri-state control keeps the third state as the string CDP sends, not as a coerced boolean.
	const tristate = byId(await loadTree('radio_checkbox_group'), 'c-indeterminate');
	assertEquals(tristate.axNode?.properties?.find((p) => p.name === 'checked')?.value, 'mixed');

	for (const page of ['form_attributes', 'radio_checkbox_group', 'aria_listbox_combobox']) {
		for (const node of walkTree(await loadTree(page))) {
			for (const property of node.axNode?.properties ?? []) {
				assert(KNOWN_AX_PROPERTIES.has(property.name), `unwhitelisted AX property survived: ${property.name}`);
				const type = typeof property.value;
				assert(type === 'string' || type === 'boolean' || property.value === null, `non-scalar AX value: ${type}`);
			}
		}
	}
});

Deno.test('dom-extraction: form controls keep their live value alongside the markup attribute (H12)', async () => {
	const root = await loadTree('react_controlled_inputs');
	const input = byId(root, 'ctrl-text');
	assertEquals(input.attributes.value, 'initial-state', 'the markup attribute survives the merge');
	assertEquals(input.axNode?.role, 'textbox');

	// §6.5 makes the *live* value the override source, and it reaches the IR through a channel the
	// attribute cannot reach: Chrome's user-agent shadow root, whose inner editor carries the rendered
	// text. The merge preserves both so the serializer can choose.
	const shadowRoot = input.shadowRoots?.[0];
	assert(shadowRoot !== undefined);
	assertEquals(shadowRoot.shadowRootType, 'user-agent');
	const live = walkTree(shadowRoot).filter((node) => node.nodeType === 3).map((node) => node.nodeValue);
	assert(live.includes('initial-state'), `the inner editor lost the live value: ${JSON.stringify(live)}`);
	assert(live.includes('controlled text'), 'and the placeholder is a separate node, not the value');

	assertEquals(byId(root, 'mirror').childrenNodes[0]?.nodeValue, 'mirror: initial-state');
});

Deno.test('dom-extraction: the live value and the markup attribute really can disagree (H12b)', async () => {
	// The leg the corpus reconciliation dropped, restored by `live_value_vs_attribute.html`: every write
	// on that page sets the DOM *property* and never the attribute, which is the exact state §6.5's
	// "AX value overrides DOM value" rule exists for. Without a page where they disagree the rule is
	// unfalsifiable — every assertion passes whether the override fires or not.
	const root = await loadTree('live_value_vs_attribute');
	const axProperty = (node: EnhancedDomTreeNode, name: string): string | null => {
		for (const property of node.axNode?.properties ?? []) {
			if (property.name === name) return String(property.value);
		}
		return null;
	};

	const number = byId(root, 'lv-number');
	assertEquals(number.attributes.value, '7', 'the markup attribute keeps the authored value');
	assertEquals(axProperty(number, 'valuetext'), '42', 'and the AX tree reports the live one');

	const on = byId(root, 'lv-check-on');
	assertEquals(on.attributes.checked, undefined, 'no checked attribute in the markup');
	assertEquals(axProperty(on, 'checked'), 'true', 'ticked by script, visible only through AX');
	const off = byId(root, 'lv-check-off');
	assertEquals(off.attributes.checked, '', 'a checked attribute in the markup');
	assertEquals(axProperty(off, 'checked'), 'false', 'unticked by script, visible only through AX');

	// The same disagreement on a listbox: markup selects Alpha, the script selects Gamma.
	assert(root !== null);
	const options = walkTree(root).filter((node) => node.nodeName === 'OPTION');
	assertEquals(options.length, 3);
	assertEquals(options[0]?.attributes.selected, '', 'the markup still says Alpha');
	assertEquals(axProperty(options[0] as EnhancedDomTreeNode, 'selected'), 'false');
	assertEquals(axProperty(options[2] as EnhancedDomTreeNode, 'selected'), 'true', 'the AX tree says Gamma');

	// Recorded as a limit, not asserted away: a plain text input's live value reaches the AX tree only
	// through `AXNode.value`, a field `EnhancedAxNode` (§6.2) does not model, so the override cannot see
	// it. The user-agent shadow editor still carries it, which is the channel H12 pins.
	const text = byId(root, 'lv-text');
	assertEquals(text.attributes.value, 'markup-only-value');
	assertEquals(axProperty(text, 'valuetext'), null);
	const editor = text.shadowRoots?.[0];
	assert(editor !== undefined);
	const live = walkTree(editor).filter((node) => node.nodeType === 3).map((node) => node.nodeValue);
	assert(live.includes('live-typed-value'), `the inner editor lost the live value: ${JSON.stringify(live)}`);
});

Deno.test('dom-extraction: page-absolute geometry does not move with the scroll offset (H6b)', async () => {
	// The leg the corpus reconciliation dropped, restored by `scroll_page_prescrolled.html`: the recorded
	// 25 all capture at rest, so "DOMSnapshot bounds are document coordinates" had no fixture that could
	// tell a document-coordinate implementation from a viewport-relative one. Here the main frame is
	// scrolled 2000px before the capture and the two pages are otherwise identical block-for-block.
	const rest = await loadTree('scroll_page');
	const scrolled = await loadTree('scroll_page_prescrolled');
	const restCapture = await loadCapture('scroll_page');
	const scrolledCapture = await loadCapture('scroll_page_prescrolled');
	assertEquals(restCapture.sessions[0]?.layoutMetrics.scrollY, 0);
	assertGreater(scrolledCapture.sessions[0]?.layoutMetrics.scrollY ?? 0, 1500);

	// Same block, same page-absolute y on both captures — the geometry is unmoved.
	const restY = byId(rest, 'p-b1').absolutePosition?.y ?? -1;
	const scrolledY = byId(scrolled, 'ps-b1').absolutePosition?.y ?? -2;
	assertAlmostEquals(scrolledY, restY, 1, 'page-absolute bounds must not be rebased on the scroll offset');

	// What DOES move is the band. At rest block 6 (y≈2097) is past viewport+1000 and block 1 is in;
	// scrolled by 2000 the verdicts swap.
	assertEquals(byId(rest, 'p-b1').isVisible, true);
	assertEquals(byId(rest, 'p-b6').isVisible, false);
	assertEquals(byId(scrolled, 'ps-b1').isVisible, false, 'block 1 is now 2000px above the band');
	assertEquals(byId(scrolled, 'ps-b6').isVisible, true, 'and block 6 is inside it');
});

// ---------------------------------------------------------------------------
// H14 — iframe hidden-element hints
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: iframe hidden-element hints are capped and distance-sorted (H14)', async () => {
	// ERRATUM(M1-parity-15): a hint means "the serializer did not render this", so the candidate set is
	// gated on `isVisible === false`. `iframe_hidden_elements`' rows sit inside the ±1000px slack and are
	// therefore rendered — they produce no hints any more, and `iframe_hidden_far` was added to put
	// frame content genuinely outside the band.
	const near = byId(await loadTree('iframe_hidden_elements'), 'ihe-frame');
	assertEquals(near.hasHiddenContent, false, 'content inside the slack is rendered, not hinted at');

	const root = await loadTree('iframe_hidden_far');
	const frame = byId(root, 'ihf-frame');
	assertEquals(frame.hasHiddenContent, true);
	// A 100px frame parked mid-document over 15 rows: 3 sit ~1500px above the fold and 12 sit ~1700px
	// below it, so 15 candidates compete for 10 slots and the cap is observed as a truncation rather
	// than asserted as a constant alone.
	assertEquals(MAX_HIDDEN_ELEMENT_HINTS, 10);
	assertEquals(frame.hiddenElementsInfo.length, MAX_HIDDEN_ELEMENT_HINTS);
	assertEquals(frame.hiddenElementsInfo[0]?.tagName, 'button');

	// The row that *is* inside the frame's box produces no hint.
	assert(frame.contentDocument !== null);
	const visible = byId(frame.contentDocument, 'ff-near1');
	const visibleText = visible.childrenNodes[0]?.nodeValue;
	assertEquals(frame.hiddenElementsInfo.some((hint) => hint.text === visibleText), false, 'ff-near1 produced a hint');

	// The frame is parked mid-document, so content sits above *and* below its fold; the sort is on
	// |pagesAway|, so the two directions interleave rather than one running out first.
	const away = frame.hiddenElementsInfo.map((hint) => hint.pagesAway);
	assert(away.some((value) => value > 0) && away.some((value) => value < 0), 'both directions must be represented');
	for (let i = 1; i < away.length; i++) {
		assertGreater(Math.abs(away[i] ?? 0), Math.abs(away[i - 1] ?? 0), 'hints must be sorted by absolute distance');
	}
	// Every hint names the element it points at; a hint with an empty label tells the model nothing.
	for (const hint of frame.hiddenElementsInfo) assertNotEquals(hint.text, '');

	// A page with no frames carries no hints anywhere.
	const plain = await loadTree('baseline_button');
	assertEquals(walkTree(plain).some((node) => node.hasHiddenContent), false);
});

// ---------------------------------------------------------------------------
// H15 — structural decoding
// ---------------------------------------------------------------------------

Deno.test("dom-extraction: attributes fold from CDP's flat pair list (H15)", async () => {
	assertEquals(foldAttributes(['a', '1', 'b', '2']), { a: '1', b: '2' });
	assertEquals(foldAttributes(['a', '1', 'dangling']), { a: '1' }, 'an odd tail is dropped, not guessed');
	assertEquals(foldAttributes(undefined), {});
	assertEquals(foldAttributes([]), {});

	const root = await loadTree('form_attributes');
	assertEquals(byId(root, 'f-tel').attributes, {
		'id': 'f-tel',
		'name': 'fTel',
		'type': 'tel',
		'pattern': '[0-9]{3}-[0-9]{3}-[0-9]{4}',
		'placeholder': '123-456-7890',
		'autocomplete': 'tel',
		'inputmode': 'tel',
	});
	assertEquals(byId(root, 'f-password').attributes.required, '', 'a bare boolean attribute folds to ""');
	assertEquals(byId(root, 'f-empty-value').attributes.value, '', 'and so does an explicitly empty one');
});

Deno.test('dom-extraction: document, doctype and comment nodes report unknown visibility (H15)', async () => {
	const root = await loadTree('baseline_button');
	assertEquals(root.nodeType, 9);
	assertEquals(root.isVisible, null);
	assertEquals(root.parentNode, null);
	const doctype = root.childrenNodes.find((node) => node.nodeType === 10);
	assert(doctype !== undefined);
	assertEquals(doctype.nodeName, 'html');
	assertEquals(doctype.isVisible, null);

	// Text nodes get the full gate, because they carry the LLM-visible text.
	const text = walkTree(root).filter((node) => node.nodeType === 3);
	assertGreater(text.length, 3);
	assert(text.some((node) => node.isVisible === true));
	assert(text.some((node) => node.isVisible === false), '<style>/<head> text is not visible');
});

Deno.test('dom-extraction: SVG survives as a subtree with geometry (H15)', async () => {
	const root = await loadTree('svg_children');
	const svg = byId(root, 'plain-svg');
	assertEquals(svg.nodeName, 'svg', 'CDP reports SVG element names in their original case');
	assertEquals(svg.isVisible, true);
	assertEquals(svg.axNode?.name, 'Plain decorative svg');
	const circle = svg.childrenNodes.find((node) => node.nodeName === 'circle');
	assert(circle?.absolutePosition != null);
	assertGreater(circle.absolutePosition.width, 0);
	// `<title>` inside SVG generates no box, so it fails the gate like any un-rendered node.
	const title = svg.childrenNodes.find((node) => node.nodeName === 'title');
	assertEquals(title?.isVisible, false);
});

// ---------------------------------------------------------------------------
// H16 — budget and recovery
// ---------------------------------------------------------------------------

Deno.test('dom-extraction: the budget constants are ARCHITECTURE §6.7 verbatim (H16)', () => {
	assertEquals(DOM_BUILD_BUDGET_MS, 20_000);
	assertEquals(NETWORK_PROBE_MAX_MS, 2_000);
	assertEquals(NETWORK_STABILITY_MS, 300);
});

Deno.test('dom-extraction: the recovery state is empty, flagged, and carries browserErrors (H16)', () => {
	const state = recoveryState(['DOM build exceeded its 20000 ms budget'], { timedOut: true, durationMs: 20_001 });
	assertEquals(state.root, null);
	assertEquals(state.nodeCount, 0);
	assertEquals(state.byKey.size, 0, 'a recovery state must expose no actionable node');
	assertEquals(state.recovered, true);
	assertEquals(state.timedOut, true);
	assertEquals(state.browserErrors.length, 1);
});

Deno.test('dom-extraction: a capture with no sessions degrades instead of throwing (H16)', () => {
	const result = extractFromCapture({ rootSessionId: 'gone', sessions: [], warnings: [] });
	assertEquals(result.root, null);
	assertEquals(result.nodeCount, 0);
	assertEquals(result.warnings, ['capture carried no sessions']);
});

Deno.test('dom-extraction: an empty page still yields a usable document root (H16)', async () => {
	const root = await loadTree('empty_page');
	assertEquals(root.nodeType, 9);
	assertEquals(maybeById(root, 'nothing'), null);
	assertGreater(walkTree(root).length, 2);
	assertEquals(root.childrenNodes.some((node) => node.nodeName === 'HTML'), true);
});
