/**
 * Derived-member contract (DATA-MODEL §6.1 "Derived members").
 *
 * Two halves: recorded-fixture tests, which prove the members against real Chrome geometry from the
 * shared corpus in `tests/fixtures/pages/`, and hand-built IR nodes for the edge cases no corpus page
 * reaches on demand (a `null` snapshot, an unlimited-depth text walk, a partially scrolled container).
 *
 * ERRATUM(M1-dom-test-repair): the corpus moved from 30 programmatic pages to the 32 shared static
 * ones, so every fixture-backed test here changed page. Two legs had to move from a fixture to
 * hand-built IR because no corpus page can express them: a container scrolled to a non-zero offset
 * (every corpus page is captured at rest) and therefore a mid-range `horizontalPercent`.
 */

import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import {
	domNodeDerived,
	getAllChildrenText,
	getMeaningfulTextForLlm,
	isActuallyScrollable,
	isPasswordField,
	MEANINGFUL_TEXT_ATTRIBUTES,
	normalizeWhitespace,
	SCROLLABLE_EPSILON_PX,
	scrollInfo,
	shouldShowScrollInfo,
	tagName,
	xpath,
} from './derived.ts';
import { type DomCapture, mergeDomTrees, walkTree } from './extract.ts';
import type { DomRect, EnhancedDomTreeNode, EnhancedSnapshotNode, NodeType, RequiredComputedStyle } from './types.ts';

const FIXTURE_DIR = fromFileUrl(new URL('../../fixtures/dom', import.meta.url));

async function loadTree(name: string): Promise<EnhancedDomTreeNode> {
	const capture = JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/${name}.capture.json`)) as DomCapture;
	const merged = mergeDomTrees(capture);
	assert(merged.root !== null);
	return merged.root;
}

function byId(root: EnhancedDomTreeNode, id: string): EnhancedDomTreeNode {
	for (const node of walkTree(root)) {
		if (node.attributes.id === id) return node;
	}
	throw new Error(`#${id} not found`);
}

// ---------------------------------------------------------------------------
// hand-built IR
// ---------------------------------------------------------------------------

let nextBackendNodeId = 1;

interface NodeSpec {
	readonly nodeName: string;
	readonly nodeType?: NodeType;
	readonly nodeValue?: string;
	readonly attributes?: Record<string, string>;
	readonly children?: NodeSpec[];
	readonly shadowRoots?: NodeSpec[];
	readonly contentDocument?: NodeSpec;
	readonly isVisible?: boolean | null;
	readonly isScrollable?: boolean | null;
	readonly scrollRects?: DomRect;
	readonly clientRects?: DomRect;
	readonly computedStyles?: Partial<Record<RequiredComputedStyle, string>>;
}

/** Builds a linked `EnhancedDomTreeNode` tree; the only place a test constructs IR by hand. */
function build(spec: NodeSpec, parent: EnhancedDomTreeNode | null = null): EnhancedDomTreeNode {
	const snapshotNode: EnhancedSnapshotNode | null = spec.scrollRects === undefined &&
			spec.clientRects === undefined && spec.computedStyles === undefined
		? null
		: {
			bounds: null,
			computedStyles: spec.computedStyles ?? null,
			cursorStyle: null,
			paintOrder: null,
			clientRects: spec.clientRects ?? null,
			scrollRects: spec.scrollRects ?? null,
			stackingContexts: null,
			isClickable: false,
			inputValue: null,
			inputChecked: null,
			optionSelected: null,
			textValue: null,
		};
	const node: EnhancedDomTreeNode = {
		nodeId: nextBackendNodeId,
		backendNodeId: nextBackendNodeId++,
		nodeType: spec.nodeType ?? (spec.nodeName === '#text' ? 3 : 1),
		nodeName: spec.nodeName,
		nodeValue: spec.nodeValue ?? '',
		attributes: { ...spec.attributes },
		isScrollable: spec.isScrollable ?? null,
		isVisible: spec.isVisible ?? true,
		absolutePosition: null,
		targetId: 'target',
		frameId: 'frame',
		sessionId: 'session',
		contentDocument: null,
		shadowRootType: spec.nodeType === 11 ? 'open' : null,
		shadowRoots: null,
		parentNode: parent,
		childrenNodes: [],
		axNode: null,
		snapshotNode,
		compoundChildren: [],
		hasJsClickListener: false,
		hiddenElementsInfo: [],
		hasHiddenContent: false,
		uuid: `uuid-${nextBackendNodeId}`,
	};
	for (const child of spec.children ?? []) node.childrenNodes.push(build(child, node));
	if (spec.shadowRoots !== undefined) node.shadowRoots = spec.shadowRoots.map((child) => build(child, node));
	if (spec.contentDocument !== undefined) node.contentDocument = build(spec.contentDocument, node);
	return node;
}

const text = (value: string): NodeSpec => ({ nodeName: '#text', nodeType: 3, nodeValue: value });

// ---------------------------------------------------------------------------
// tagName / normalizeWhitespace
// ---------------------------------------------------------------------------

Deno.test('dom-derived: tagName lowercases the CDP node name', async () => {
	const root = await loadTree('baseline_button');
	const button = walkTree(root).find((node) => node.nodeName === 'BUTTON');
	assert(button !== undefined);
	assertEquals(tagName(button), 'button');
	assertEquals(tagName(root), '#document');
	// SVG element names already arrive lowercase; lowercasing must be idempotent.
	const svg = await loadTree('svg_children');
	assertEquals(tagName(byId(svg, 'plain-svg')), 'svg');
});

Deno.test('dom-derived: whitespace normalisation collapses runs and trims', () => {
	assertEquals(normalizeWhitespace('  a \n\t b  '), 'a b');
	assertEquals(normalizeWhitespace('\n\n'), '');
	assertEquals(normalizeWhitespace(''), '');
});

// ---------------------------------------------------------------------------
// xpath
// ---------------------------------------------------------------------------

Deno.test('dom-derived: xpath numbers only tags that actually have same-tag siblings', async () => {
	const root = await loadTree('same_tag_siblings');
	// `#sts-a` interleaves p, span, p, p, span, p — the fourth `p` must be `p[4]`, not `p[6]`.
	const fourth = byId(root, 'sts-b1').parentNode;
	assert(fourth !== null && fourth.nodeName === 'P');
	assertEquals(xpath(fourth), 'html/body/main/section[1]/p[4]');
	const spans = walkTree(root).filter((node) => node.nodeName === 'SPAN');
	assertEquals(spans.map((node) => xpath(node)), [
		'html/body/main/section[1]/span[1]',
		'html/body/main/section[1]/span[2]',
	]);
	// `html`, `body` and `main` are lone children of their tag and carry no position at all — the
	// reference spelling (DECISION-REGISTER §9.6 (E-23) item 2), pinned here so it cannot drift back.
	assertEquals(xpath(byId(root, 'sts-b1')).startsWith('html/body/main/'), true);
	// Sibling counting restarts inside each parent, so the second section's controls index from 1.
	assertEquals(xpath(byId(root, 'sts-b2')), 'html/body/main/section[2]/button[1]');
	assertEquals(xpath(byId(root, 'sts-l2')), 'html/body/main/section[2]/a[2]');
	// A text node contributes no step of its own; it reports its parent element's path.
	const firstParagraph = walkTree(root).find((node) => node.nodeName === 'P');
	assert(firstParagraph !== undefined);
	const textNode = firstParagraph.childrenNodes[0];
	assert(textNode !== undefined && textNode.nodeType === 3);
	assertEquals(xpath(textNode), xpath(firstParagraph));
	// The document root itself has no path.
	assertEquals(xpath(root), '');
});

Deno.test('dom-derived: xpath passes straight through shadow boundaries', async () => {
	const root = await loadTree('shadow_open');
	const deep = byId(root, 'shadow-nested-button');
	// Two shadow roots sit on this chain — `#open-host-b`'s and `#open-host-nested`'s — and neither
	// contributes a step.
	assertEquals(xpath(deep), 'html/body/main/div[2]/div/button');
	assertEquals(xpath(deep).includes('document-fragment'), false);
	assertEquals(deep.parentNode?.nodeType, 11, 'its immediate parent really is a fragment');
});

Deno.test('dom-derived: xpath stops at the iframe boundary', async () => {
	const root = await loadTree('iframe_nested');
	const frame = byId(root, 'frame-depth-1');
	assert(frame.contentDocument !== null);
	const inner = byId(frame.contentDocument, 'd1-button');
	// The chain up from the inner button crosses its own document, whose parent is the host <iframe>.
	assertEquals(inner.parentNode?.parentNode?.parentNode?.parentNode, frame.contentDocument);
	assertEquals(frame.contentDocument.parentNode, frame, 'the frame document stays navigable upward');
	assertEquals(xpath(inner), 'html/body/main/button');
	assertEquals(xpath(frame), 'html/body/main/iframe');
});

Deno.test('dom-derived: xpath handles a node reachable only through shadowRoots', () => {
	const host = build({
		nodeName: 'MY-HOST',
		shadowRoots: [{ nodeName: '#document-fragment', nodeType: 11, children: [{ nodeName: 'BUTTON' }] }],
	});
	const shadowRoot = host.shadowRoots?.[0];
	assert(shadowRoot !== undefined);
	const button = shadowRoot.childrenNodes[0];
	assert(button !== undefined);
	// The fragment is not in its parent's `childrenNodes`, so its own step is a lone-child step.
	assertEquals(xpath(button), 'my-host/button');
});

// ---------------------------------------------------------------------------
// scrollability
// ---------------------------------------------------------------------------

/**
 * Gate 1 — ERRATUM(E-33). `DOM.Node.isScrollable` is an **optional** field (`packages/cdp/src/domains/
 * dom.ts:56`) that Blink sets only when the box owns a scrollable area; it is never emitted as
 * `false`. Measured: all 24 occurrences across the 37 recorded captures are `true`, zero are `false`,
 * and `extract_merge.ts` maps "absent" to `null`. So a gate written `isScrollable === false` can never
 * fire, and the predicate silently degrades into "recompute Blink's answer from computed `overflow`
 * plus snapshot rects" — dropping the authority's own verdict.
 *
 * This test pins the tri-state directly so the dead branch cannot come back.
 */
Deno.test('dom-derived: isActuallyScrollable requires Chrome to have flagged the box', () => {
	const geometry = {
		scrollRects: { x: 0, y: 0, width: 200, height: 999 },
		clientRects: { x: 0, y: 0, width: 200, height: 100 },
		computedStyles: { overflow: 'auto', 'overflow-x': 'auto', 'overflow-y': 'auto' },
	} as const;
	// `false` never reaches us from CDP, but if it ever did it must still mean "no".
	assertEquals(isActuallyScrollable(build({ nodeName: 'DIV', isScrollable: false, ...geometry })), false);
	// `null` is what CDP actually emits for an unflagged box, and it means "no" for the same reason:
	// only Blink knows whether a scrollable area exists. Overflow + geometry are corroboration, not a
	// substitute. This is the discriminating input the two implementations disagreed on.
	assertEquals(
		isActuallyScrollable(build({ nodeName: 'DIV', isScrollable: null, ...geometry })),
		false,
		'an unflagged box is not scrollable however far its content overflows',
	);
	assertEquals(isActuallyScrollable(build({ nodeName: 'DIV', isScrollable: true, ...geometry })), true);
});

/**
 * The concrete page shape the drift would have mis-rendered, taken from the corpus rather than
 * invented: `select_native`'s `<select multiple>` carries the UA's `overflow-y: scroll` and is
 * **not** flagged by Chrome. Its options happen to fit exactly (66×64 in 66×64), which is the only
 * reason the disagreement never showed up in the recorded output. One more `<option>` and a
 * flag-ignoring gate calls it a scroll container.
 */
Deno.test('dom-derived: an unflagged UA-scrollable <select multiple> is not a scroll element', async () => {
	const root = await loadTree('select_native');
	const select = byId(root, 'sel-multi');
	assertEquals(select.isScrollable, null, 'Chrome does not flag a <select multiple> as scrollable');
	assertEquals(select.snapshotNode?.computedStyles?.['overflow-y'], 'scroll', 'but the UA stylesheet does');
	assertEquals(isActuallyScrollable(select), false);

	// Same node, one option taller: the content now really overflows its box.
	const overflowing: EnhancedDomTreeNode = {
		...select,
		snapshotNode: {
			...select.snapshotNode!,
			scrollRects: { ...select.snapshotNode!.scrollRects!, height: 80 },
		},
	};
	assertEquals(
		isActuallyScrollable(overflowing),
		false,
		'the reference renders every <select> bare — no |scroll element| marker, no pages suffix',
	);
	assertEquals(shouldShowScrollInfo(overflowing), false);
});

Deno.test('dom-derived: a flagged box still has to overflow, with a 1px epsilon', () => {
	assertEquals(SCROLLABLE_EPSILON_PX, 1);
	const make = (scrollHeight: number, scrollWidth = 200): EnhancedDomTreeNode =>
		build({
			nodeName: 'DIV',
			isScrollable: true,
			scrollRects: { x: 0, y: 0, width: scrollWidth, height: scrollHeight },
			clientRects: { x: 0, y: 0, width: 200, height: 100 },
		});
	assertEquals(isActuallyScrollable(make(100)), false);
	assertEquals(isActuallyScrollable(make(101)), false, 'exactly one px of overflow is rounding noise');
	assertEquals(isActuallyScrollable(make(102)), true);
	assertEquals(isActuallyScrollable(make(100, 202)), true, 'horizontal overflow counts too');

	// With no geometry at all the flag is the only signal left — and it is enough. This is the
	// document node's case: Chrome flags it, DOMSnapshot emits no layout row for it.
	assertEquals(isActuallyScrollable(build({ nodeName: 'DIV', isScrollable: true })), true);
	assertEquals(isActuallyScrollable(build({ nodeName: 'DIV' })), false);
});

Deno.test('dom-derived: scrollInfo reports pages above/below and a horizontal percentage', async () => {
	const root = await loadTree('scroll_element');
	const scroller = byId(root, 'scroller');
	const info = scrollInfo(scroller);
	assert(info !== null);
	// 490px of content in a 178px box, at rest: nothing above, 1.75 pages below.
	assertEquals(info.pagesAbove, 0, 'a corpus page is captured at rest, so no container starts scrolled');
	assertAlmostEquals(info.pagesBelow, 1.7528, 0.001);
	assertEquals(info.horizontalPercent, null, 'no horizontal overflow, no percentage');
	assertEquals(isActuallyScrollable(scroller), true);
	assertEquals(shouldShowScrollInfo(scroller), true);
	// `overflow:auto` that actually overflows is scrollable in exactly the same way.
	assertEquals(shouldShowScrollInfo(byId(root, 'auto-scroller')), true);

	// A control that fits its own box has nothing to say.
	const flat = byId(root, 's-b1');
	assertEquals(isActuallyScrollable(flat), false);
	assertEquals(shouldShowScrollInfo(flat), false);

	// `#hidden-overflow` is `overflow:hidden` and overflows by 42px. Chrome leaves
	// `DOM.Node.isScrollable` unset for it, so the flag gate cannot decide and the geometry gate sees a
	// real overflow — the `overflow` computed style is the only signal that says "clipped, not
	// scrollable". The reference golden emits `|scroll element|` for `#scroller` and `#auto-scroller`
	// and renders `#hidden-overflow`'s buttons bare (DECISION-REGISTER §9.6 (E-23) item 3).
	const clipped = byId(root, 'hidden-overflow');
	assertEquals(clipped.isScrollable, null, 'Chrome does not flag an overflow:hidden box as scrollable');
	assertEquals(clipped.snapshotNode?.computedStyles?.overflow, 'hidden');
	assertEquals(isActuallyScrollable(clipped), false, 'a clipped box is not reachable by a scroll action');

	const horizontal = await loadTree('scroll_horizontal');
	const strip = byId(horizontal, 'hstrip');
	const info2 = scrollInfo(strip);
	assert(info2 !== null);
	assertEquals(info2.horizontalPercent, 0, 'a horizontal overflow at rest is 0%, not "no overflow"');
	assertEquals(info2.pagesAbove, 0);
	assertEquals(info2.pagesBelow, 0, 'overflow-y:hidden on a strip leaves nothing below');
	assertEquals(shouldShowScrollInfo(strip), true, 'a horizontal percentage alone is worth reporting');

	// A both-axis scroller reports both, independently.
	const both = scrollInfo(byId(horizontal, 'bothstrip'));
	assert(both !== null);
	assertEquals(both.horizontalPercent, 0);
	assertAlmostEquals(both.pagesBelow, 2.8835, 0.001);
});

Deno.test('dom-derived: scrollInfo clamps rather than reporting negative or absent geometry', () => {
	assertEquals(scrollInfo(build({ nodeName: 'DIV' })), null);
	assertEquals(
		scrollInfo(build({
			nodeName: 'DIV',
			scrollRects: { x: 0, y: 0, width: 10, height: 10 },
			clientRects: { x: 0, y: 0, width: 10, height: 0 },
		})),
		null,
		'a zero-height client box has no pages',
	);
	// ERRATUM(M1-dom-test-repair): every corpus page is captured at rest, so a *partially scrolled*
	// container — the only state in which `pagesAbove` and a mid-range `horizontalPercent` are both
	// non-trivial — is hand-built here rather than replayed.
	const midScroll = scrollInfo(build({
		nodeName: 'DIV',
		scrollRects: { x: 200, y: 120, width: 600, height: 360 },
		clientRects: { x: 0, y: 0, width: 200, height: 120 },
	}));
	assert(midScroll !== null);
	// 360px of content in a 120px box, scrolled to 120: exactly one page each way.
	assertAlmostEquals(midScroll.pagesAbove, 1, 0.01);
	assertAlmostEquals(midScroll.pagesBelow, 1, 0.01);
	// 600px wide in a 200px box: a 400px range, and 200px along it is halfway.
	assertEquals(midScroll.horizontalPercent, 50);

	// An over-scrolled box (elastic/rubber-band positions do occur) must not report pages below zero.
	const overscrolled = scrollInfo(build({
		nodeName: 'DIV',
		scrollRects: { x: -5, y: 400, width: 200, height: 300 },
		clientRects: { x: 0, y: 0, width: 200, height: 100 },
	}));
	assert(overscrolled !== null);
	assertEquals(overscrolled.pagesBelow, 0);
	assertEquals(overscrolled.pagesAbove, 4);
	assertEquals(overscrolled.horizontalPercent, null);
});

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

Deno.test('dom-derived: getAllChildrenText joins visible descendant text, depth-capped', () => {
	const tree = build({
		nodeName: 'DIV',
		children: [
			text(' outer  text '),
			{ nodeName: 'SPAN', children: [text('depth two')] },
			{ nodeName: 'DIV', children: [{ nodeName: 'B', children: [text('depth three')] }] },
			{ nodeName: 'SCRIPT', children: [text('never()')] },
			{ nodeName: 'STYLE', children: [text('.a{}')] },
			{ nodeName: 'DIV', isVisible: false, children: [text('display none copy')] },
			{ nodeName: 'IFRAME', contentDocument: { nodeName: '#document', nodeType: 9, children: [text('frame text')] } },
		],
		shadowRoots: [{ nodeName: '#document-fragment', nodeType: 11, children: [text('shadow text')] }],
	});
	assertEquals(getAllChildrenText(tree, -1), 'outer text depth two depth three shadow text');
	assertEquals(getAllChildrenText(tree, 1), 'outer text');
	// The shadow root sits at depth 1 like any child, so its text arrives at depth 2 alongside the
	// light-DOM span — and after it, because `childrenNodes` are walked before `shadowRoots`.
	assertEquals(getAllChildrenText(tree, 2), 'outer text depth two shadow text');
	assertEquals(getAllChildrenText(tree, 0), '', 'depth 0 sees no children');
	// `<script>`/`<style>` are markup, an invisible subtree is not LLM-visible, and an iframe's text
	// belongs to the iframe (ERRATUM M1-dom-extract-8).
	assertEquals(getAllChildrenText(tree, -1).includes('never()'), false);
	assertEquals(getAllChildrenText(tree, -1).includes('display none copy'), false);
	assertEquals(getAllChildrenText(tree, -1).includes('frame text'), false);
});

Deno.test('dom-derived: getAllChildrenText normalises whitespace from real markup', async () => {
	const root = await loadTree('text_nodes_and_links');
	const paragraphs = walkTree(root).filter((node) => node.nodeName === 'P');
	// Leading and trailing runs are trimmed away entirely.
	assertEquals(getAllChildrenText(paragraphs[0]!, -1), 'Leading and trailing whitespace around this sentence.');
	// Embedded newlines collapse to single spaces.
	assertEquals(getAllChildrenText(paragraphs[5]!, -1), 'Multi line text node with embedded newlines.');
	// Inline children are joined with their surrounding text, in document order.
	const strong = walkTree(root).find((node) => node.nodeName === 'STRONG');
	assert(strong?.parentNode != null);
	assertEquals(getAllChildrenText(strong.parentNode, -1), 'Text with nested strong and nested em inline children.');
	// A whitespace-only paragraph normalises to nothing rather than to a stray space.
	assertEquals(getAllChildrenText(paragraphs[3]!, -1), '');

	// Depth is counted in hops, and an anchor's two inline spans are two hops down.
	const anchor = byId(root, 'l-three');
	assertEquals(getAllChildrenText(anchor, -1), 'Third link');
	assertEquals(getAllChildrenText(anchor, 1), '', 'the two spans, not the text, sit at depth 1 here');

	// `display:none` and `visibility:hidden` copy never reaches the joined text.
	const main = walkTree(root).find((node) => node.nodeName === 'MAIN');
	assert(main !== undefined);
	const joined = getAllChildrenText(main, -1);
	assertEquals(joined.includes('display none container'), false);
	assertEquals(joined.includes('visibility hidden span'), false);
	assertEquals(joined.includes('First link'), true);
});

Deno.test('dom-derived: getMeaningfulTextForLlm walks the §6.1 attribute ladder before children text', async () => {
	assertEquals([...MEANINGFUL_TEXT_ATTRIBUTES], ['value', 'aria-label', 'title', 'placeholder', 'alt']);
	const withAll = build({
		nodeName: 'INPUT',
		attributes: { 'value': 'v', 'aria-label': 'a', 'title': 't', 'placeholder': 'p', 'alt': 'l' },
	});
	assertEquals(getMeaningfulTextForLlm(withAll), 'v');
	assertEquals(
		getMeaningfulTextForLlm(build({ nodeName: 'INPUT', attributes: { 'aria-label': 'a', 'title': 't' } })),
		'a',
	);
	assertEquals(getMeaningfulTextForLlm(build({ nodeName: 'IMG', attributes: { alt: 'a photo' } })), 'a photo');
	// An attribute that is present but blank is skipped, not returned as ''.
	assertEquals(
		getMeaningfulTextForLlm(build({ nodeName: 'INPUT', attributes: { value: '   ', title: 'fallback' } })),
		'fallback',
	);
	assertEquals(
		getMeaningfulTextForLlm(build({ nodeName: 'BUTTON', children: [text('Click  me')] })),
		'Click me',
	);
	assertEquals(getMeaningfulTextForLlm(build({ nodeName: 'DIV' })), '');

	// The same ladder against real markup: `#l-two` has both a title and link text, and title wins.
	const links = await loadTree('text_nodes_and_links');
	assertEquals(getMeaningfulTextForLlm(byId(links, 'l-two')), 'Second link title');
	assertEquals(getMeaningfulTextForLlm(byId(links, 'l-one')), 'First link', 'with no attribute, children text');
});

Deno.test('dom-derived: a password field never yields its value (DATA-MODEL §6.5)', async () => {
	const root = await loadTree('form_attributes');
	const password = byId(root, 'f-password');
	assertEquals(isPasswordField(password), true);
	assertEquals(password.attributes.type, 'password');
	const sentinel = password.attributes.value ?? '';
	assertEquals(sentinel, 'P4ssw0rd-SENTINEL-DO-NOT-LEAK-9f3a2b', 'the attribute is still in the IR');
	assertEquals(getMeaningfulTextForLlm(password), 'Account password', 'the ladder skips value, lands on aria-label');
	assertEquals(getMeaningfulTextForLlm(password).includes(sentinel), false);

	// FINDING(M1-dom-test-repair): Chrome's user-agent shadow root for `<input type=password>` carries
	// the *unmasked* value in its inner-editor text node, so the merged IR does contain the secret in a
	// second place besides `attributes.value`. What stops it is the visibility gate — that node is
	// `isVisible: false`, and `getAllChildrenText` skips invisible subtrees (ERRATUM M1-dom-extract-8).
	// The reference agrees on the outcome: no golden in `tests/fixtures/python-golden/` contains the
	// sentinel. Pinned here so that a future change to either rule fails loudly rather than silently
	// opening the channel.
	const shadowText = (password.shadowRoots ?? []).flatMap((shadowRoot) =>
		walkTree(shadowRoot).filter((node) => node.nodeType === 3)
	);
	assertEquals(shadowText.map((node) => node.nodeValue), [sentinel]);
	assertEquals(shadowText.map((node) => node.isVisible), [false]);
	assertEquals(getAllChildrenText(password, -1), '', 'and so nothing derived from it reaches the model');

	// A non-password field in the same form is unaffected: its value is the first rung of the ladder.
	assertEquals(getMeaningfulTextForLlm(byId(root, 'f-long')), 'short-value');
	assertEquals(isPasswordField(byId(root, 'f-long')), false);
	// Case-insensitive, as HTML attribute values are.
	assertEquals(isPasswordField(build({ nodeName: 'INPUT', attributes: { type: 'PASSWORD' } })), true);
	assertEquals(isPasswordField(build({ nodeName: 'DIV', attributes: { type: 'password' } })), false);
});

// ---------------------------------------------------------------------------
// the contract object
// ---------------------------------------------------------------------------

Deno.test("dom-derived: domNodeDerived exposes exactly this file's half of DomNodeDerived", async () => {
	assertEquals(Object.keys(domNodeDerived).sort(), [
		'getAllChildrenText',
		'getMeaningfulTextForLlm',
		'isActuallyScrollable',
		'scrollInfo',
		'shouldShowScrollInfo',
		'tagName',
		'xpath',
	]);
	// The three replay hashes belong to the serializer's `hashes.ts` and must NOT appear here.
	assertEquals('elementHash' in domNodeDerived, false);
	assertEquals('stableHash' in domNodeDerived, false);
	assertEquals('parentBranchHash' in domNodeDerived, false);

	const root = await loadTree('baseline_button');
	const button = walkTree(root).find((node) => node.nodeName === 'BUTTON');
	assert(button !== undefined);
	assertEquals(domNodeDerived.tagName(button), tagName(button));
	assertEquals(domNodeDerived.xpath(button), xpath(button));
});

/**
 * The password-predicate matrix (SEC-04, BF-7, E-37).
 *
 * The predicate is a security control, not a heuristic convenience: it is the single gate on `value`
 * reaching the attribute string, `getMeaningfulTextForLlm`, `browser_get_state` labels (E-34) and the
 * `state_token` content half (E-36). So every arm is pinned positively AND its nearest false positive
 * is pinned negatively, because a predicate that scrubs half the page is abandoned and then the
 * control is gone.
 */
Deno.test('dom-derived: the password predicate covers all five arms (SEC-04, E-37)', () => {
	const input = (attributes: Record<string, string>, axName?: string) => {
		const node = build({ nodeName: 'INPUT', attributes });
		if (axName !== undefined) {
			node.axNode = {
				axNodeId: 'a',
				ignored: false,
				role: 'textbox',
				name: axName,
				description: null,
				properties: null,
				childIds: null,
			};
		}
		return node;
	};

	// Arm 1 — the declared type.
	assertEquals(isPasswordField(input({ type: 'password' })), true);
	// Arm 2 — what a password manager fills, including the OTP spelling.
	assertEquals(isPasswordField(input({ type: 'text', autocomplete: 'one-time-code' })), true);
	// Arm 3 — the page's own name for the field, on `name` and on `id`, in the four separator
	// spellings HTML form names actually use.
	for (const name of ['password', 'user_password', 'login-passwd', 'form.pwd', 'creds[passphrase]', 'otp', 'cvv']) {
		assertEquals(isPasswordField(input({ type: 'text', name })), true, `name=${name} is a credential field`);
		assertEquals(isPasswordField(input({ type: 'text', id: name })), true, `id=${name} is a credential field`);
	}
	// Arm 4 — what a human reading the page would call it.
	assertEquals(isPasswordField(input({ type: 'text', 'aria-label': 'Password' })), true);
	assertEquals(isPasswordField(input({ type: 'text', placeholder: 'Enter your passphrase' })), true);
	assertEquals(isPasswordField(input({ type: 'text' }, 'One-time code')), true);
	// Arm 5 — the reveal toggle. This is the arm that matters most: the widget flips `input.type` to
	// `text` at exactly the moment the secret is on screen, and every type-based predicate goes quiet.
	assertEquals(isPasswordField(input({ type: 'text', class: 'form-control password-input' })), true);
	assertEquals(isPasswordField(input({ type: 'text', 'data-testid': 'login-password' })), true);

	// --- and the false positives that would make the control unusable ---------------------------
	// A bare substring predicate would scrub every one of these.
	for (const name of ['passenger_name', 'compass', 'bypass_cache', 'passive_mode', 'passing_score']) {
		assertEquals(isPasswordField(input({ type: 'text', name })), false, `name=${name} is not a credential field`);
	}
	// Accepted over-scrubs, recorded rather than engineered away. `password_hint_shown` opens on the
	// token `password`; `boarding_pass` ends on the token `pass`, which E-38 added because `name="pass"`
	// is the commonest credential field name in PHP and Rails forms. The bias is deliberate and the
	// alternative rules are worse: requiring the token to be the whole name misses `password_confirm`,
	// and dropping `pass` misses the field the arm exists for.
	assertEquals(isPasswordField(input({ type: 'text', name: 'password_hint_shown' })), true);
	assertEquals(isPasswordField(input({ type: 'text', name: 'boarding_pass' })), true);

	// --- E-38: the arms the security review of E-37 found missing ---------------------------------
	// The evasion that made the whole predicate optional: HTML renders an unrecognised `type` keyword
	// as a text box, and the old ALLOWLIST of scrubbable types returned false before arms 2-5 ran.
	assertEquals(isPasswordField(input({ type: 'passcode', name: 'password', autocomplete: 'current-password' })), true);
	assertEquals(isPasswordField(input({ type: 'hidden', name: 'user_password' })), true);
	// `name="pass"` — the commonest credential field name there is — and the other missing spellings.
	for (const name of ['pass', 'user_pass', 'pw', 'account.secret', 'api_key', 'access_token', 'pin']) {
		assertEquals(isPasswordField(input({ type: 'text', name })), true, `name=${name} is a credential field`);
	}
	// A product that visits arbitrary sites meets more than one language, and the visible label is
	// exactly what arms 1 and 2 cannot see on a hand-rolled login form.
	for (
		const label of ['Contraseña', 'Mot de passe', 'Passwort', 'Senha', 'Wachtwoord', 'пароль', '密码', 'パスワード']
	) {
		assertEquals(isPasswordField(input({ type: 'text', 'aria-label': label })), true, `label ${label}`);
	}
	// A card number is not a password, but it is the same class of value DD-7 exists to keep out of a
	// transcript, and arm 3 already scrubbed the `cvv` name spelling.
	assertEquals(isPasswordField(input({ type: 'text', autocomplete: 'cc-number' })), true);
	// The common reveal-widget shape marks the WRAPPER; the input itself carries only `form-control`.
	const wrapped = build({
		nodeName: 'DIV',
		attributes: { class: 'input-group password-toggle' },
		children: [{ nodeName: 'INPUT', attributes: { type: 'text', class: 'form-control' } }],
	});
	const wrappedInput = wrapped.childrenNodes[0];
	assert(wrappedInput !== undefined);
	assertEquals(isPasswordField(wrappedInput), true, 'a wrapper-marked reveal widget is detected');
	// A type that cannot hold a credential is a preference, not a secret: scrubbing it would cost the
	// model a control it can legitimately act on and protect nothing.
	assertEquals(isPasswordField(input({ type: 'checkbox', name: 'save_password' })), false);
	assertEquals(isPasswordField(input({ type: 'submit', name: 'password_submit' })), false);
	// Only `<input>`; `value` means something else everywhere else.
	assertEquals(isPasswordField(build({ nodeName: 'DIV', attributes: { type: 'password' } })), false);
	assertEquals(isPasswordField(build({ nodeName: 'TEXTAREA', attributes: { name: 'password' } })), false);

	// The property the whole predicate exists for, on a widened arm rather than only on `type`.
	const revealed = input({ type: 'text', name: 'user_password', value: 'hunter2' });
	assertEquals(getMeaningfulTextForLlm(revealed).includes('hunter2'), false);
	assertEquals(getAllChildrenText(revealed, 5).includes('hunter2'), false);
});

Deno.test('dom-derived: a password field is detected by autocomplete, not only by type (E-29)', () => {
	// Surfaced by assembling packages/core/mod.ts: two definitions of "is a password field" existed —
	// this one (type only) and serialize_attrs.ts's (type OR autocomplete). They had drifted, and the
	// narrower one guards the §6.5 anti-exfiltration path, so a text-typed input that a password
	// manager fills would have had its value emitted into LLM-visible text.
	const byAutocomplete = build({
		nodeName: 'INPUT',
		attributes: { type: 'text', autocomplete: 'current-password', value: 'hunter2' },
	});
	assertEquals(isPasswordField(byAutocomplete), true, 'autocomplete=current-password is a password field');

	const newPassword = build({
		nodeName: 'INPUT',
		attributes: { type: 'text', autocomplete: 'NEW-PASSWORD' },
	});
	assertEquals(isPasswordField(newPassword), true, 'the match is case-insensitive and trimmed');

	// The value must not survive into derived text — that is the property the predicate exists for.
	assertEquals(getAllChildrenText(byAutocomplete, 5).includes('hunter2'), false);
	assertEquals(getMeaningfulTextForLlm(byAutocomplete).includes('hunter2'), false);

	// Still not over-broad: an ordinary autofill hint is not a password field.
	const ordinary = build({ nodeName: 'INPUT', attributes: { type: 'text', autocomplete: 'email' } });
	assertEquals(isPasswordField(ordinary), false);
});
