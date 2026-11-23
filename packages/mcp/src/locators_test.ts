/**
 * The locator model against the recorded corpus: the kinds, their spellings, the ranking, the
 * uniqueness count in the element's own document, and the single `core` locator's rule.
 */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { type EnhancedDomTreeNode, extractFromCapture } from '@tykotech/browser';
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
	parseLocator,
	searchQueryOf,
	testIdOf,
} from './locators.ts';
import { observe } from './observe.ts';
import { type ObservedElement, resolveFields } from './element_record.ts';
import { ToolError } from './errors.ts';
import {
	compileHrefPattern,
	FIND_BUDGET_CHECK_INTERVAL,
	FIND_BUDGET_MS,
	HREF_PATTERN_MAX_CHARS,
	HREF_PATTERN_MAX_HREF_CHARS,
	HREF_PATTERN_MAX_HREFS,
	rankElements,
} from './find.ts';
import * as tools from './tools.ts';

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
	let deep = anchor;
	for (let i = 0; i < MAX_CSS_SEGMENTS + 1; i++) deep = element({ nodeName: 'DIV' }, deep);
	assertEquals(cssPathOf(deep), undefined);
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

Deno.test('locators: a bare id, testid or name value means its selector; a full selector passes unchanged', () => {
	const query = (kind: 'id' | 'testid' | 'name' | 'css', value: string) => searchQueryOf(parseLocator(kind, value));
	assertEquals(query('id', 'username'), '#username');
	assertEquals(query('id', '1st'), '[id="1st"]');
	assertEquals(query('testid', 'submit'), '[data-testid="submit"]');
	assertEquals(query('name', 'q'), '[name="q"]');
	assertEquals(query('name', 'say "hi"'), '[name="say \\"hi\\""]');
	assertEquals(query('id', '#username'), '#username');
	assertEquals(query('id', '[id="1st"]'), '[id="1st"]');
	assertEquals(query('testid', '[data-testid="submit"]'), '[data-testid="submit"]');
	assertEquals(query('name', 'input[name="q"]'), 'input[name="q"]');
	assertEquals(query('css', 'username'), 'username');
});

// --- `browser_find`'s ranking against the recorded corpus and against a fixed record set: the conjunction rule, the scores, the tie-break, `near`'s exclusion of boxless elements, and the three `href_pattern` mitigations (the cap, the budget, the malformed refusal). ---

function el(index: number, extra: Partial<ObservedElement> = {}): ObservedElement {
	return { index, tag: 'a', ...extra };
}

Deno.test('find: every named predicate must hold, and the score is their mean', () => {
	const records = [
		el(1, { label: 'Sign in', href: '/login', bounds: { x: 0, y: 0, w: 10, h: 10 } }),
		el(2, { label: 'sign in', href: '/signin', bounds: { x: 100, y: 0, w: 10, h: 10 } }),
		el(3, { label: 'Register', href: '/register', bounds: { x: 200, y: 0, w: 10, h: 10 } }),
	];
	const exact = rankElements(records, { name: 'Sign in' });
	assertEquals(exact.map((m) => [m.element.index, m.score]), [[1, 1], [2, 0.95]]);
	const both = rankElements(records, { name: 'Sign in', href_pattern: '^/sign' });
	assertEquals(both.map((m) => m.element.index), [2]);
	assertEquals(both[0]?.score, (0.95 + 0.9) / 2);
	assertEquals(rankElements(records, { name: 'IGN' }).map((m) => m.score), [0.8, 0.8]);
});

Deno.test('find: ties break by ascending index, so a replay is deterministic', () => {
	const records = [el(9, { label: 'Go' }), el(3, { label: 'Go' }), el(5, { label: 'Go' })];
	assertEquals(rankElements(records, { name: 'Go' }).map((m) => m.element.index), [3, 5, 9]);
});

Deno.test('find: near ranks by distance to the bounds centre and excludes a boxless element', () => {
	const records = [
		el(1, { bounds: { x: 0, y: 0, w: 10, h: 10 } }),
		el(2, { bounds: { x: 95, y: 0, w: 10, h: 10 } }),
		el(3, { bounds: null }),
	];
	const ranked = rankElements(records, { near: { x: 100, y: 5 } });
	assertEquals(ranked.map((m) => m.element.index), [2, 1]);
	assertEquals(ranked[0]?.score, 1);
	assertEquals(ranked[1]?.score, 1 / (1 + 95 / 100));
});

Deno.test('find: role matches the ARIA role, else the tag; frame_id restricts', () => {
	const records = [
		el(1, { tag: 'a', role: 'link', frame_id: 'top' }),
		el(2, { tag: 'button', frame_id: 'top' }),
		el(3, { tag: 'button', frame_id: 'child' }),
	];
	assertEquals(rankElements(records, { role: 'button' }).map((m) => m.element.index), [2, 3]);
	assertEquals(rankElements(records, { role: 'button', frame_id: 'child' }).map((m) => m.element.index), [3]);
	assertEquals(rankElements(records, { role: 'link' }).map((m) => m.element.index), [1]);
});

Deno.test('find: href_pattern is capped in length, refused when malformed, and tests at most 2000 hrefs', () => {
	assertThrows(() => compileHrefPattern('('), ToolError, 'not a valid regular expression');
	assertThrows(() => compileHrefPattern('a'.repeat(HREF_PATTERN_MAX_CHARS + 1)), ToolError, 'longer than');
	const many = Array.from({ length: HREF_PATTERN_MAX_HREFS + 10 }, (_, i) => el(i, { href: `/p/${i}` }));
	const ranked = rankElements(many, { href_pattern: '^/p/' });
	assertEquals(ranked.length, HREF_PATTERN_MAX_HREFS, 'hrefs beyond the cap are not tested and do not match');
});

Deno.test('find: ordinary href patterns are admitted', () => {
	for (
		const pattern of [
			'/docs/.*\\.pdf$',
			'^https://example\\.com/a[0-9]+',
			'^https?://[^/]+/docs/.*\\.pdf$',
			'^https?://(?:www\\.)?example\\.com/',
			'\\.(pdf|docx?)$',
			'^/sign',
			'[?&]page=\\d+',
			'^/p/\\d{1,4}$',
			'^/(?<section>blog)/',
			'[(]x[)]+', // parentheses inside a class are literals, not a group
			'a{,3}', // Annex B: a `{` that spells no quantifier is a literal
		]
	) {
		compileHrefPattern(pattern);
	}
	const ranked = rankElements([el(1, { href: '/docs/a/b.pdf' }), el(2, { href: '/docs/a.html' })], {
		href_pattern: '/docs/.*\\.pdf$',
	});
	assertEquals(ranked.map((m) => m.element.index), [1]);
});

Deno.test('find: patterns that can backtrack catastrophically are refused before anything is tested', () => {
	const refused: Array<[string, string]> = [
		['^https?://[^/]+/([\\w-]|[\\w-])+\\.zzz$', 'quantifies a group'], // the finding's pattern
		['(a+)+$', 'quantifies a group'],
		['(a|b)*', 'quantifies a group'],
		['(?:ab)+', 'quantifies a group'],
		['(?:a?)?', 'quantifies a group'],
		['(?<n>a)\\k<n>', 'backreference'],
		['(a)\\1', 'backreference'],
		['foo(?=bar)', 'lookaround'],
		['foo(?!bar)', 'lookaround'],
		['(?<=a)b', 'lookaround'],
		['(?<!a)b', 'lookaround'],
		['.*.*x', 'unbounded quantifiers'],
		['^.*.*.*x', 'unbounded quantifiers'],
		['^a|.*.*x', 'unbounded quantifiers'], // a top-level `|` does not anchor
		['a.{0,1000}b.*c', 'unbounded quantifiers'], // a wide bounded span is costed as unbounded
		['a?'.repeat(20) + 'a'.repeat(20), 'combined choices'],
		['(a|a)'.repeat(20), 'combined choices'],
	];
	for (const [pattern, reason] of refused) {
		const error = assertThrows(() => compileHrefPattern(pattern), ToolError, reason, pattern);
		assertEquals(error.code, 'invalid-arguments');
	}
	assertThrows(() => rankElements([el(1, { href: 'x' })], { href_pattern: '(a+)+$' }), ToolError, 'quantifies');
});

Deno.test('find: an href over the length cap is not tested and does not match', () => {
	const long = `/p/${'a'.repeat(HREF_PATTERN_MAX_HREF_CHARS)}`;
	const ranked = rankElements([el(1, { href: long }), el(2, { href: '/p/b' })], { href_pattern: '^/p/' });
	assertEquals(ranked.map((m) => m.element.index), [2]);
});

Deno.test('find: the budget is checked after every href test', () => {
	const many = Array.from({ length: 3 }, (_, i) => el(i, { href: `/p/${i}` }));
	let calls = 0;
	const now = () => (calls++ === 0 ? 0 : FIND_BUDGET_MS + 1);
	const error = assertThrows(() => rankElements(many, { href_pattern: '^/p/' }, { now }), ToolError);
	assertEquals(error.code, 'timeout');
	assertEquals(calls, 2, 'the first test already answered timeout, long before the 256-element check');
});

Deno.test('find: the wall-clock budget is checked every 256 elements and answers timeout, never hangs', () => {
	const many = Array.from({ length: FIND_BUDGET_CHECK_INTERVAL * 3 }, (_, i) => el(i, { label: 'x' }));
	let calls = 0;
	const now = () => (calls++ === 0 ? 0 : FIND_BUDGET_MS + 1);
	const error = assertThrows(() => rankElements(many, { name: 'x' }, { now }), ToolError);
	assertEquals(error.code, 'timeout');
});

Deno.test('find: on a recorded page, role+name, href_pattern and near all return the same element', async () => {
	const h = await captureHarness('text_nodes_and_links');
	try {
		const observation = await observe(h.record, { fields: resolveFields(['core']), elementLimit: 5000 });
		const link = observation.elements.find((e) => e.href !== undefined && e.label !== undefined);
		assert(link !== undefined && link.bounds !== null && link.bounds !== undefined, 'the fixture has a labelled link');
		const byName = rankElements(observation.elements, { role: 'link', name: link.label! });
		const byHref = rankElements(observation.elements, {
			href_pattern: `^${link.href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
		});
		const byNear = rankElements(observation.elements, {
			near: { x: link.bounds.x + link.bounds.w / 2, y: link.bounds.y + link.bounds.h / 2 },
		});
		assertEquals(byName[0]?.element.index, link.index);
		assertEquals(byHref[0]?.element.index, link.index);
		assertEquals(byNear[0]?.element.index, link.index);
		assertEquals(byNear[0]?.score, 1, 'distance zero scores 1');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('find tool: an empty query is a caller error, and the result carries the token, total and truncation', async () => {
	const h = await captureHarness('text_nodes_and_links');
	try {
		await assertRejects(() => tools.browserFind({ query: {} }, h.ctx), ToolError, 'at least one');
		const result = await tools.browserFind({ query: { role: 'link' }, limit: 1 }, h.ctx) as {
			structuredContent: {
				matches: Array<Record<string, unknown>>;
				total: number;
				truncated: boolean;
				state_token: string;
			};
		};
		const payload = result.structuredContent;
		assertEquals(payload.matches.length, 1);
		assert(payload.total > 1);
		assertEquals(payload.truncated, true);
		assert(typeof payload.state_token === 'string');
		const match = payload.matches[0]!;
		assert('score' in match && 'bounds' in match, 'core fields plus the score');
		assert(!('text' in match), 'text was read for the predicate only');
	} finally {
		await h.registry.shutdown();
	}
});
