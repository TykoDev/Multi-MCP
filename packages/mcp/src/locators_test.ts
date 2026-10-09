/**
 * The locator model (DD-4) against the recorded corpus: the kinds, their spellings, the ranking, the
 * uniqueness count in the element's own document, and the single `core` locator's rule.
 */
import { assert, assertEquals } from '@std/assert';
import type { EnhancedDomTreeNode } from '@tykotech/browser';
import { extractFromCapture } from '@tykotech/browser';
import { DOM_FIXTURE_PAGES } from '../../browser/fixtures/dom/pages.ts';
import { captureHarness, loadCapture } from '../fixtures/capture_session.ts';
import {
	bestLocator,
	buildDocumentIndex,
	cssPathOf,
	LOCATOR_KINDS,
	type LocatorCandidate,
	locatorCandidates,
	MAX_CSS_SEGMENTS,
	MAX_TEXT_LOCATOR_CHARS,
	ownTextOf,
	testIdOf,
} from './locators.ts';
import { observe } from './observe.ts';
import { resolveFields } from './element_record.ts';

function element(
	overrides: Partial<EnhancedDomTreeNode> & { attributes?: Record<string, string> },
	parent: EnhancedDomTreeNode | null = null,
): EnhancedDomTreeNode {
	const node = {
		nodeType: 1,
		nodeName: 'DIV',
		nodeValue: '',
		attributes: {},
		frameId: 'F',
		sessionId: 'S',
		backendNodeId: 1,
		childrenNodes: [],
		shadowRoots: null,
		contentDocument: null,
		parentNode: parent,
		axNode: null,
		snapshotNode: null,
		isVisible: true,
		...overrides,
	} as unknown as EnhancedDomTreeNode;
	if (parent !== null) parent.childrenNodes.push(node);
	return node;
}

function text(value: string, parent: EnhancedDomTreeNode): void {
	parent.childrenNodes.push(
		{
			nodeType: 3,
			nodeName: '#text',
			nodeValue: value,
			childrenNodes: [],
			shadowRoots: null,
			contentDocument: null,
			isVisible: true,
		} as unknown as EnhancedDomTreeNode,
	);
}

Deno.test('locators: the ranking is the array order and there is at most one candidate per kind', async () => {
	for (const page of DOM_FIXTURE_PAGES) {
		const observation = await (async () => {
			const h = await captureHarness(page.name);
			try {
				return await observe(h.record, { fields: resolveFields(['locators', 'frame_id']), elementLimit: 5000 });
			} finally {
				await h.registry.shutdown();
			}
		})();
		for (const el of observation.elements) {
			const kinds = (el.locators ?? []).map((candidate) => candidate.kind);
			assertEquals(new Set(kinds).size, kinds.length, `${page.name}#${el.index}: one per kind`);
			const ranks = kinds.map((kind) => LOCATOR_KINDS.indexOf(kind));
			assertEquals([...ranks].sort((a, b) => a - b), ranks, `${page.name}#${el.index}: kind order`);
			assert((el.locators ?? []).length <= 7);
			for (const candidate of el.locators ?? []) {
				assertEquals(candidate.unique, candidate.matches === 1);
				assertEquals(candidate.frame_id, el.frame_id, 'counted in the element own document');
			}
		}
	}
});

Deno.test('locators: the four test-id spellings all emit as data-testid', () => {
	for (const spelling of ['data-testid', 'data-test-id', 'data-test', 'data-qa']) {
		const node = element({ nodeName: 'BUTTON', attributes: { [spelling]: 'go' } });
		assertEquals(testIdOf(node), 'go');
		const index = buildDocumentIndex(node);
		const [first] = locatorCandidates(node, index);
		assertEquals(first, { kind: 'testid', value: '[data-testid="go"]', unique: true, matches: 1, frame_id: 'F' });
	}
	// The first spelling wins when a page carries two.
	assertEquals(testIdOf(element({ attributes: { 'data-qa': 'b', 'data-test': 'a' } })), 'a');
});

Deno.test('locators: id is spelled #id or [id="…"], name is tag-qualified, aria is role plus name', () => {
	const root = element({ nodeName: 'FORM' });
	const plain = element({
		nodeName: 'INPUT',
		attributes: { id: 'q', name: 'q' },
		axNode: { role: 'searchbox', name: 'Search' } as never,
	}, root);
	const odd = element({ nodeName: 'INPUT', attributes: { id: '1st:field', name: 'q' } }, root);
	const index = buildDocumentIndex(root);
	const plainCandidates = locatorCandidates(plain, index);
	assertEquals(plainCandidates.map((candidate) => `${candidate.kind} ${candidate.value} ${candidate.matches}`), [
		'id #q 1',
		'name input[name="q"] 2',
		'aria role=searchbox[name="Search"] 1',
	]);
	assertEquals(locatorCandidates(odd, index)[0]?.value, '[id="1st:field"]');
	// The name kind counts per tag: a `<select name=q>` would not collide with an `<input name=q>`.
	assertEquals(plainCandidates[1]?.unique, false);
});

Deno.test('locators: label comes from <label for>, a wrapping <label>, or aria-label — never the value', () => {
	const root = element({ nodeName: 'FORM' });
	const label = element({ nodeName: 'LABEL', attributes: { for: 'pw' } }, root);
	text('Password', label);
	const field = element({ nodeName: 'INPUT', attributes: { id: 'pw', type: 'password', value: 'hunter2' } }, root);
	const wrap = element({ nodeName: 'LABEL' }, root);
	text('Remember me', wrap);
	const box = element({ nodeName: 'INPUT', attributes: { type: 'checkbox', value: 'yes' } }, wrap);
	const aria = element({ nodeName: 'BUTTON', attributes: { 'aria-label': 'Close', value: 'x' } }, root);
	const index = buildDocumentIndex(root);
	const of = (node: EnhancedDomTreeNode, kind: string) => locatorCandidates(node, index).find((c) => c.kind === kind);
	assertEquals(of(field, 'label')?.value, 'label=Password');
	assertEquals(of(box, 'label')?.value, 'label=Remember me');
	assertEquals(of(aria, 'label')?.value, 'label=Close');
	for (const node of [field, box, aria]) {
		assert(!JSON.stringify(locatorCandidates(node, index)).includes('hunter2'));
		assert(!JSON.stringify(locatorCandidates(node, index)).includes('"yes"'));
	}
});

Deno.test('locators: css is a path from the nearest id-bearing ancestor, nth-of-type only where ambiguous, at most 6 segments', () => {
	const anchor = element({ attributes: { id: 'list' } });
	const ul = element({ nodeName: 'UL' }, anchor);
	const li1 = element({ nodeName: 'LI' }, ul);
	const li2 = element({ nodeName: 'LI' }, ul);
	const a = element({ nodeName: 'A' }, li2);
	assertEquals(cssPathOf(a), '#list > ul > li:nth-of-type(2) > a');
	assertEquals(cssPathOf(li1), '#list > ul > li:nth-of-type(1)');
	const index = buildDocumentIndex(anchor);
	assertEquals(locatorCandidates(a, index).find((c) => c.kind === 'css'), {
		kind: 'css',
		value: '#list > ul > li:nth-of-type(2) > a',
		unique: true,
		matches: 1,
		frame_id: 'F',
	});
	// Deeper than the cap from any anchor: no css candidate rather than a fragile one.
	let deep = anchor;
	for (let i = 0; i < MAX_CSS_SEGMENTS + 1; i++) deep = element({ nodeName: 'DIV' }, deep);
	assertEquals(cssPathOf(deep), undefined);
	// No anchor at all: none either.
	assertEquals(cssPathOf(element({ nodeName: 'SPAN' }, element({ nodeName: 'BODY' }))), undefined);
});

Deno.test('locators: text names the innermost element, is capped at 80 characters, and counts duplicates', () => {
	const root = element({ attributes: { id: 'r' } });
	const wrap = element({ nodeName: 'DIV' }, root);
	const button = element({ nodeName: 'BUTTON' }, wrap);
	text('Save', button);
	const twin = element({ nodeName: 'BUTTON' }, root);
	text('Save', twin);
	const long = element({ nodeName: 'P' }, root);
	text('x'.repeat(200), long);
	const index = buildDocumentIndex(root);
	const of = (node: EnhancedDomTreeNode) => locatorCandidates(node, index).find((c) => c.kind === 'text');
	assertEquals(of(button), { kind: 'text', value: 'text=Save', unique: false, matches: 2, frame_id: 'F' });
	assertEquals(of(wrap), undefined, 'the wrapper is not the innermost carrier of the text');
	assertEquals(ownTextOf(long).length, MAX_TEXT_LOCATOR_CHARS);
});

Deno.test('locators: uniqueness is per document — the same id in two frames is unique in each', async () => {
	const capture = await loadCapture('iframe_oopif_index_collision');
	const extraction = extractFromCapture(capture);
	assert(extraction.root !== null);
	const index = buildDocumentIndex(extraction.root);
	assertEquals(index.byFrame.size, 2, 'two documents, two count tables');
	const h = await captureHarness('iframe_oopif_index_collision');
	try {
		const observation = await observe(h.record, {
			fields: resolveFields(['locators', 'frame_id']),
			elementLimit: 5000,
		});
		const frames = new Set(observation.elements.map((el) => el.frame_id));
		assertEquals(frames.size, 2);
		for (const el of observation.elements) {
			const id = el.locators?.find((c) => c.kind === 'id');
			if (id !== undefined) assertEquals(id.unique, true, `${el.index}: ids in this corpus are unique per frame`);
		}
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('locators: the core locator is the first unique candidate, else the first, else null', () => {
	const unique: LocatorCandidate = { kind: 'css', value: '#a > b', unique: true, matches: 1, frame_id: 'F' };
	const dup: LocatorCandidate = { kind: 'name', value: 'input[name="q"]', unique: false, matches: 2, frame_id: 'F' };
	assertEquals(bestLocator([dup, unique]), unique);
	assertEquals(bestLocator([dup]), dup);
	assertEquals(bestLocator([]), null);
});

Deno.test('locators: a bare element with a click listener has no candidate at all', () => {
	const root = element({ nodeName: 'BODY' });
	const div = element({ nodeName: 'DIV', hasJsClickListener: true }, root);
	assertEquals(locatorCandidates(div, buildDocumentIndex(root)), []);
});
