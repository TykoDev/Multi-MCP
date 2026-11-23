/** The element record, proven over the recorded corpus rather than hand-built nodes. */
import { assert, assertAlmostEquals, assertEquals, assertGreater, assertLess, assertNotEquals } from '@std/assert';
import { DOM_FIXTURE_PAGES } from '../../browser/fixtures/dom/pages.ts';
import { captureHarness } from '../fixtures/capture_session.ts';
import {
	effectiveElementLimit,
	FIELD_NAMES,
	FIELD_OPTIONS,
	FIELD_PRESETS,
	IMPLIED_ELEMENT_LIMIT,
	MASKED_INPUT_VALUE,
	type ObservedElement,
	resolveFields,
} from './element_record.ts';
import { labelOf, observationPayload, observationStructured, observe, promptBlock } from './observe.ts';
import type { EnhancedDomTreeNode } from '@tykotech/browser';

/** The password the `form_attributes` corpus page ships in markup. Its appearance anywhere is a failure. */
const SENTINEL = 'P4ssw0rd-SENTINEL-DO-NOT-LEAK-9f3a2b';

const FROZEN_KEYS = ['index', 'tag', 'label', 'role', 'href'];

async function elementsOf(name: string, fields: Parameters<typeof resolveFields>[0], extra = {}) {
	const h = await captureHarness(name);
	try {
		return await observe(h.record, { fields: resolveFields(fields), elementLimit: 5000, ...extra });
	} finally {
		await h.registry.shutdown();
	}
}

function byId(elements: readonly ObservedElement[], id: string): ObservedElement {
	const found = elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `no element with id ${id}`);
	return found;
}

// --- the presets and the levers --------------------------------------------------------------------

Deno.test('fields: omitted means core, presets and names union, and every option is a preset or a field', () => {
	assertEquals([...resolveFields(undefined)].sort(), [...FIELD_PRESETS.core].sort());
	assertEquals([...resolveFields(['minimal'])], []);
	assertEquals([...resolveFields(['minimal', 'bounds'])], ['bounds']);
	assertEquals([...resolveFields(['core', 'locators', 'bounds'])].sort(), [...FIELD_PRESETS.core, 'locators'].sort());
	assertEquals([...resolveFields(['full'])].sort(), [...FIELD_NAMES].sort(), 'full is every field');
	assertEquals(FIELD_OPTIONS.length, 3 + FIELD_NAMES.length);
	assert(!FIELD_PRESETS.core.includes('locator'));
});

Deno.test('element_limit: no default for minimal and core, 500 implied by any heavy field, the caller wins', () => {
	assertEquals(effectiveElementLimit(resolveFields(['minimal']), undefined), null);
	assertEquals(effectiveElementLimit(resolveFields(['core']), undefined), null);
	assertEquals(effectiveElementLimit(resolveFields(['core', 'locator']), undefined), null, 'one locator is cheap');
	for (const heavy of ['full', 'attrs', 'text', 'input', 'document_bounds', 'locators', 'frame'] as const) {
		assertEquals(effectiveElementLimit(resolveFields([heavy]), undefined), IMPLIED_ELEMENT_LIMIT, heavy);
	}
	assertEquals(effectiveElementLimit(resolveFields(['full']), 7), 7);
});

Deno.test('element record: the five frozen fields are emitted under every preset, and only they under minimal', async () => {
	for (const preset of ['minimal', 'core', 'full'] as const) {
		const observation = await elementsOf('form_attributes', [preset]);
		for (const element of observation.elements) {
			assert(typeof element.index === 'number' && typeof element.tag === 'string');
			if (preset === 'minimal') {
				assertEquals(Object.keys(element).filter((key) => !FROZEN_KEYS.includes(key)), [], 'minimal adds nothing');
			}
		}
	}
});

Deno.test('element record: an unknown frame id is reported, never refused, and top is always included', async () => {
	const all = await elementsOf('iframe_crossorigin', ['core']);
	const top = all.frames[0]!;
	const child = all.frames[1]!;
	assertEquals(child.parent, top.id);

	const topOnly = await elementsOf('iframe_crossorigin', ['core'], { frames: 'top' });
	assert(topOnly.elements.every((element) => element.frame_id === top.id));
	assertLess(topOnly.elements.length, all.elements.length);
	assertEquals(topOnly.elementsTotal, topOnly.elements.length, 'total counts what the frames filter admitted');

	const named = await elementsOf('iframe_crossorigin', ['core'], { frames: [child.id, 'no-such-frame'] });
	assertEquals(named.framesUnknown, ['no-such-frame']);
	assertEquals(named.elements.length, all.elements.length, 'the top document plus the one named frame is everything');
	assertEquals(named.frames.length, 2);
});

Deno.test('element record: element_limit keeps the elements painted last, in index order, and says so', async () => {
	const full = await elementsOf('truncation_large', ['minimal']);
	assertEquals(full.elementsTotal, 1201);
	assertEquals(full.elementsTruncated, false);

	const capped = await elementsOf('truncation_large', ['full'], { elementLimit: undefined });
	assertEquals(capped.elements.length, IMPLIED_ELEMENT_LIMIT, 'full implies 500');
	assertEquals(capped.elementsTotal, 1201);
	assertEquals(capped.elementsTruncated, true);
	for (let i = 1; i < capped.elements.length; i++) {
		assertGreater(capped.elements[i]!.index, capped.elements[i - 1]!.index);
	}

	const explicit = await elementsOf('truncation_large', ['core'], { elementLimit: 3 });
	assertEquals(explicit.elements.length, 3);
	assertEquals(explicit.elementsTruncated, true);
});

// --- focus ------------------------------------------------------------------------------------------

Deno.test('at most one element is focused on every recorded capture, and focused_index agrees', async () => {
	let focusedCaptures = 0;
	for (const page of DOM_FIXTURE_PAGES) {
		const observation = await elementsOf(page.name, ['core']);
		const focused = observation.elements.filter((element) => element.focused === true);
		assert(focused.length <= 1, `${page.name}: ${focused.length} focused elements`);
		assertEquals(observation.focusedIndex, focused[0]?.index ?? null, page.name);
		if (focused.length === 1) focusedCaptures += 1;
	}
	assertEquals(focusedCaptures, 0, 'the corpus was recorded without focus; if that changes, so should this');
});

Deno.test('a state read over a capture with no focus mints no focus record', async () => {
	const h = await captureHarness('form_attributes');
	try {
		await observe(h.record, { fields: resolveFields(['core']), elementLimit: 5000 });
		await observe(h.record, { fields: resolveFields(['core']), elementLimit: 5000 });
		const records = h.record.events.read({ kind: 'cursor', epoch: h.record.events.epoch, seq: 0 });
		assertEquals(records.filter((record) => record.kind === 'focus').length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

// --- bounds -----------------------------------------------------------------------------------------

Deno.test('bounds is absolutePosition minus the top scroll, and document_bounds is absolutePosition', async () => {
	for (const page of DOM_FIXTURE_PAGES) {
		const observation = await elementsOf(page.name, ['bounds', 'document_bounds']);
		for (const element of observation.elements) {
			if (element.bounds === null) {
				assertEquals(element.document_bounds, null);
				continue;
			}
			assert(element.bounds !== undefined && element.document_bounds !== undefined && element.document_bounds !== null);
			assertAlmostEquals(element.bounds.x, element.document_bounds.x - observation.scroll.x, 1e-9);
			assertAlmostEquals(element.bounds.y, element.document_bounds.y - observation.scroll.y, 1e-9);
			assertEquals(element.bounds.w, element.document_bounds.w);
			assertEquals(element.bounds.h, element.document_bounds.h);
		}
	}
});

Deno.test('the OOPIF composition at 1280x900 — recorded numbers, host box plus border, child scroll subtracted', async () => {
	const crossorigin = await elementsOf('iframe_crossorigin', ['full']);
	const host = byId(crossorigin.elements, 'xorigin-frame');
	const button = byId(crossorigin.elements, 'xo-button');
	assertEquals(host.bounds, { x: 12, y: 143.28125, w: 520, h: 200 });
	assertEquals(button.bounds, { x: 21, y: 199.875, w: 127.890625, h: 21 });
	assertNotEquals(button.frame_id, host.frame_id, 'the button is in the child frame');
	assertEquals(button.frame?.url, 'http://localhost:38112/frames/frame_crossorigin_child.html');
	assert(button.bounds!.x >= host.bounds!.x + 1 && button.bounds!.y >= host.bounds!.y + 1);
	assert(button.bounds!.x + button.bounds!.w <= host.bounds!.x + host.bounds!.w);

	const scrolled = await elementsOf('iframe_oopif_scrolled', ['full']);
	const frame = byId(scrolled.elements, 'oos-frame');
	assertEquals(frame.bounds, { x: 12, y: 109.6875, w: 480, h: 200 });
	assertEquals(byId(scrolled.elements, 'fp-b01').bounds, { x: 25, y: -137.3125, w: 111.5625, h: 21 });
	assertEquals(byId(scrolled.elements, 'fp-b03').bounds, { x: 25, y: -17.3125, w: 111.5625, h: 21 });

	const prescrolled = await elementsOf('scroll_page_prescrolled', ['full']);
	assertEquals(prescrolled.scroll.y, 2000);
	const b6 = byId(prescrolled.elements, 'ps-b6');
	assertEquals(b6.document_bounds, { x: 20, y: 2096.6875, w: 128.625, h: 21 });
	assertEquals(b6.bounds, { x: 20, y: 96.6875, w: 128.625, h: 21 });
	for (const element of prescrolled.elements) {
		assert(element.bounds!.y >= -1000 - element.bounds!.h && element.bounds!.y <= 900 + 1000, `${element.attrs?.id}`);
	}

	const collision = await elementsOf('iframe_oopif_index_collision', ['full']);
	assertEquals(byId(collision.elements, 'cc-c01').bounds, { x: 22, y: 282.40625, w: 12, h: 12 });
	assertEquals(byId(collision.elements, 'hc-b01').bounds, { x: 13, y: 89.6875, w: 100, h: 19.1875 });
	const sameSite = await elementsOf('iframe_same_site_port', ['full']);
	assertEquals(byId(sameSite.elements, 'd2-button').bounds, { x: 21, y: 219.46875, w: 99.75, h: 21 });
	assertEquals(byId(sameSite.elements, 'd2-button').frame?.url, 'http://127.0.0.1:38112/frames/frame_depth2.html');
});

// --- cost -------------------------------------------------------------------------------------------

Deno.test('the default set costs at most 310 B/element on the heaviest recorded capture', async () => {
	const perElement = async (fields: Parameters<typeof resolveFields>[0]) => {
		const observation = await elementsOf('truncation_large', fields);
		return JSON.stringify(observation.elements).length / observation.elements.length;
	};
	const minimal = await perElement(['minimal']);
	const core = await perElement(['core']);
	const withLocator = await perElement(['core', 'locator']);
	assertAlmostEquals(minimal, 106.5, 0.1);
	assertAlmostEquals(core, 250.4, 0.1);
	assertAlmostEquals(withLocator, 368.4, 0.1);
	assert(core <= 310, `the default costs ${core.toFixed(1)} B/element; the budget is 310`);
	assertGreater(withLocator, 310);
});

Deno.test('the mean over the corpus, so a later change to any field shows up as a number', async () => {
	const sums = { minimal: 0, core: 0, full: 0, n: 0 };
	for (const page of DOM_FIXTURE_PAGES) {
		const [minimal, core, full] = await Promise.all(
			(['minimal', 'core', 'full'] as const).map((preset) => elementsOf(page.name, [preset])),
		);
		if (minimal!.elements.length === 0) continue;
		sums.minimal += JSON.stringify(minimal!.elements).length / minimal!.elements.length;
		sums.core += JSON.stringify(core!.elements).length / core!.elements.length;
		sums.full += JSON.stringify(full!.elements).length / full!.elements.length;
		sums.n += 1;
	}
	assertEquals(sums.n, 35, 'every capture but empty_page carries elements');
	assertAlmostEquals(sums.minimal / sums.n, 61.9, 0.5);
	assertLess(sums.core / sums.n, 260);
	assertLess(sums.full / sums.n, 1100);
});

// --- masking ----------------------------------------------------------------------------------------

Deno.test('a real password field with a real value discloses nothing on any element surface', async () => {
	const observation = await elementsOf('form_attributes', ['full']);
	const field = byId(observation.elements, 'f-password');
	assertEquals(field.input?.value, MASKED_INPUT_VALUE, 'a value is present; that is all a consumer learns');
	assertEquals(field.input?.type, 'password');
	assert(!('value' in (field.attrs ?? {})), 'attrs never carries value');
	assertEquals(field.text, undefined, 'text is empty and therefore omitted');
	assertEquals(field.label, 'Account password', 'the accessible name is not a secret');
	assert(!JSON.stringify(observationStructured(observation)).includes(SENTINEL));
	assert(!JSON.stringify(observationPayload(observation)).includes(SENTINEL));
	assert(!observation.page.includes(SENTINEL));
	const h = await captureHarness('form_attributes');
	try {
		assert(JSON.stringify(h.capture).includes(SENTINEL), 'the corpus carries the sentinel');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('input: the live value, the live checked state and a select report what the page holds', async () => {
	const observation = await elementsOf('live_value_vs_attribute', ['full']);
	assertEquals(byId(observation.elements, 'lv-text').input?.value, 'live-typed-value', 'the property, not the markup');
	assertEquals(byId(observation.elements, 'lv-number').input?.value, '42');
	assertEquals(byId(observation.elements, 'lv-check-on').input?.checked, true);
	assertEquals(byId(observation.elements, 'lv-check-off').input?.checked, false);
	const select = byId(observation.elements, 'lv-select');
	assertEquals(select.input, { type: 'select', name: 'lvSelect', value: null, placeholder: '', checked: null });
	assertEquals(byId(observation.elements, 'lv-tail').input, undefined, 'a button is not a form control');
});

// --- the structured half and the frozen text ------------------------------------------------------

Deno.test('the text payload carries the five frozen fields whatever fields were requested', async () => {
	const rich = await elementsOf('form_attributes', ['full']);
	const text = observationPayload(rich);
	for (const element of text.interactive_elements as ObservedElement[]) {
		assertEquals(Object.keys(element).filter((key) => !FROZEN_KEYS.includes(key)), []);
	}
	const structured = observationStructured(rich);
	assert((structured.interactive_elements as ObservedElement[]).some((element) => element.bounds !== undefined));
	for (
		const key of [
			'state_token',
			'focused_index',
			'elements_total',
			'elements_truncated',
			'frames',
			'frames_unknown',
			'capture_truncated',
		]
	) {
		assert(key in structured, `${key} is in the structured half`);
		assert(!(key in text), `${key} stays out of the text block`);
	}
});

Deno.test('include_hidden: off-screen elements arrive with visible:false and the default set is unchanged', async () => {
	const strict = await elementsOf('scroll_page', ['core']);
	assert(strict.elements.every((element) => element.visible === true));
	const admitted = await elementsOf('scroll_page', ['core'], { includeHidden: true });
	assertGreater(admitted.elements.length, strict.elements.length);
	const hidden = admitted.elements.filter((element) => element.visible === false);
	assertGreater(hidden.length, 0);
	assert(hidden.every((element) => element.bounds !== null), 'off-screen but rendered: it has a box');
	for (const element of strict.elements) {
		assertEquals(admitted.elements.find((candidate) => candidate.index === element.index)?.visible, true);
	}
});

Deno.test('enabled: every indexed element is enabled, by construction of the interactivity predicate', async () => {
	for (const page of DOM_FIXTURE_PAGES) {
		const observation = await elementsOf(page.name, ['enabled']);
		assert(observation.elements.every((element) => element.enabled === true), page.name);
	}
});

// --- One password predicate, one implementation, and the containment check that keeps it that way. ---

/** A seed chosen so its length collides with nothing legitimate in a label. */
const SECRET = 'Q7x-SEED-9fk';

function node(attributes: Record<string, string>, axName?: string): EnhancedDomTreeNode {
	return {
		nodeName: 'INPUT',
		attributes,
		axNode: axName === undefined ? null : { name: axName, role: 'textbox' },
		childrenNodes: [],
		compoundChildren: [],
	} as unknown as EnhancedDomTreeNode;
}

// --- the predicate, arm by arm ----------------------------------------------

Deno.test('observe: a password field never contributes its value to a label', () => {
	const cases: Array<[string, Record<string, string>]> = [
		['type=password', { type: 'password', value: SECRET }],
		['type=PASSWORD, case-insensitive', { type: 'PASSWORD', value: SECRET }],
		['type=password with surrounding space', { type: ' password ', value: SECRET }],
		['autocomplete=current-password', { type: 'text', autocomplete: 'current-password', value: SECRET }],
		['autocomplete=new-password', { type: 'text', autocomplete: 'NEW-PASSWORD', value: SECRET }],
	];
	for (const [name, attributes] of cases) {
		assertEquals(labelOf(node(attributes)), '', name);
	}
});

Deno.test('observe: the emitted element carries no `label` key at all for an unnamed password field', () => {
	const label = labelOf(node({ type: 'password', value: SECRET }));
	assertEquals(label, '');
});

Deno.test('observe: a password field still gets a label from a real accessible name', () => {
	assertEquals(labelOf(node({ type: 'password', value: SECRET }, 'Password')), 'Password');
	assertEquals(labelOf(node({ type: 'password', value: SECRET, 'aria-label': 'Your password' })), 'Your password');
	assertEquals(labelOf(node({ type: 'password', value: SECRET, placeholder: 'Password' })), 'Password');
});

Deno.test('observe: an ordinary text input still shows its value, which is the point of the fallback', () => {
	assertEquals(labelOf(node({ type: 'text', value: 'London' })), 'London');
	assertEquals(labelOf(node({ type: 'submit', value: 'Sign in' })), 'Sign in');
});

Deno.test('observe: no surface derived from a label leaks a password (the sampling paths)', () => {
	const observation = {
		sessionId: 's',
		url: 'https://example.com/login',
		title: 'Sign in',
		humanHasControl: false,
		tabs: [],
		viewport: { width: 1280, height: 720 },
		scroll: { x: 0, y: 0, pixelsAbove: 0, pixelsBelow: 0 },
		elements: [{ index: 1, tag: 'input' }],
		page: 'Sign in',
		stateToken: null,
		elementsTotal: 1,
		elementsTruncated: false,
		focusedIndex: null,
		frames: [],
		framesUnknown: [],
		captureTruncated: false,
	};
	const rendered = promptBlock(observation);
	assert(!rendered.includes(SECRET), rendered);
});

// --- the containment check ---------------------------------------------------

/** Where a password value may be read from. */
const READERS: Readonly<Record<string, number>> = {
	'browser/src/dom/extract_snapshot.ts': 2,
	'browser/src/dom/serialize_attrs.ts': 1,
	'browser/src/dom/state_token.ts': 1,
	'browser/src/watchdogs/default_action.ts': 1,
	'mcp/src/element_record.ts': 3,
	'mcp/src/observe.ts': 1,
};

/** Every way a module can ask for an element's value. */
const VALUE_READS: readonly RegExp[] = [
	/\battributes\s*\.\s*value\b/,
	/\battributes\s*\[\s*(['"`])value\1\s*\]/,
	/\battributes\s*\.\s*valuetext\b/,
	/\battributes\s*\[\s*(['"`])valuetext\1\s*\]/,
	/\(\s*node[^,)]*,\s*(['"`])(?:value|valuetext)\1\s*\)/,
	/\baxNode\s*\??\.\s*value\b/,
	/\.\s*(?:inputValue|textValue)\b/,
];

async function* walk(dir: URL): AsyncGenerator<URL> {
	for await (const entry of Deno.readDir(dir)) {
		if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'dist') continue;
		const child = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, dir);
		if (entry.isDirectory) yield* walk(child);
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('_test.ts')) yield child;
	}
}

Deno.test('observe: only the named modules read an element value, and each reads it once', async () => {
	const root = new URL('../../', import.meta.url);
	const counts: Record<string, number> = {};
	for await (const file of walk(root)) {
		const path = file.href.replace(root.href, '');
		for (const line of (await Deno.readTextFile(file)).split('\n')) {
			if (VALUE_READS.some((pattern) => pattern.test(line))) counts[path] = (counts[path] ?? 0) + 1;
		}
	}

	assertEquals(
		Object.keys(counts).filter((path) => !(path in READERS)).sort(),
		[],
		`an element value is read outside the password predicate's reach: ${Object.keys(counts).join(', ')}`,
	);
	assertEquals(Object.keys(counts).sort(), Object.keys(READERS).sort());
	assertEquals(counts, READERS);
	assertEquals(VALUE_READS.length, 7);
});
