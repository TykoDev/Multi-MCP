/**
 * The element record (B1.5), proven over the recorded corpus rather than hand-built nodes.
 *
 * Four things are measured here rather than asserted: A-1 (the OOPIF composition arithmetic at the
 * pinned 1280x900 viewport), A-4 (bytes per element under each preset, with the default's cost on
 * the heaviest capture as the plan's gate), I-15 (at most one focused element, and `focused_index`
 * agrees with the array) and the DD-7 masking of a real password field with a real sentinel value.
 */
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
import { observationPayload, observationStructured, observe } from './observe.ts';

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
	// D-035: `locator` is opt-in, not in the default (see the A-4 measurement below).
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
	// The frame list itself is not filtered: it is one row per frame and always the whole page.
	assertEquals(named.frames.length, 2);
});

Deno.test('element record: element_limit keeps the elements painted last, in index order, and says so', async () => {
	const full = await elementsOf('truncation_large', ['minimal']);
	assertEquals(full.elementsTotal, 1201);
	assertEquals(full.elementsTruncated, false);

	// The helper pins a 5000 limit so the other tests see whole arrays; here the limit is left to the
	// contract, which implies 500 for `full`.
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

// --- I-15 -------------------------------------------------------------------------------------------

Deno.test('I-15: at most one element is focused on every recorded capture, and focused_index agrees', async () => {
	// Observed, not assumed: no recorded capture carries a focused AX node, so this pins the
	// negative case only; the positive case (exactly one, the autofocused field) is on the browser
	// tier, because a recorded page has no focus to report.
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

Deno.test('B1.9: a state read over a capture with no focus mints no focus record', async () => {
	// The honest negative, and the only half of the producer the unit tier can
	// reach: the corpus was recorded without focus, so a read finds none and must
	// mint nothing. A `focus` record on a page with no focused node would be an
	// event that did not happen. The positive case — focus moving between two
	// reads — is on the browser tier for the same reason I-15's positive case is.
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

// --- A-1 --------------------------------------------------------------------------------------------

Deno.test('A-1: bounds is absolutePosition minus the top scroll, and document_bounds is absolutePosition', async () => {
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

Deno.test('A-1: the OOPIF composition at 1280x900 — recorded numbers, host box plus border, child scroll subtracted', async () => {
	// `iframe_crossorigin`: the host <iframe> sits at (12, 143.28) with a 1 px border; the child
	// button's local box is (8, 55.6) in a 520 px-wide frame. The composed number is what the action
	// path clicks at for an OOPIF element (`default_action_geometry.ts`), so publishing it publishes
	// the number the server already trusts.
	const crossorigin = await elementsOf('iframe_crossorigin', ['full']);
	const host = byId(crossorigin.elements, 'xorigin-frame');
	const button = byId(crossorigin.elements, 'xo-button');
	assertEquals(host.bounds, { x: 12, y: 143.28125, w: 520, h: 200 });
	assertEquals(button.bounds, { x: 21, y: 199.875, w: 127.890625, h: 21 });
	assertNotEquals(button.frame_id, host.frame_id, 'the button is in the child frame');
	assertEquals(button.frame?.url, 'http://localhost:38112/frames/frame_crossorigin_child.html');
	// Inside the host's content box, which is the whole claim.
	assert(button.bounds!.x >= host.bounds!.x + 1 && button.bounds!.y >= host.bounds!.y + 1);
	assert(button.bounds!.x + button.bounds!.w <= host.bounds!.x + host.bounds!.w);

	// `iframe_oopif_scrolled`: the child document is scrolled by 260 px, so its first row sits above
	// the host box — a negative viewport y is the correct answer and is not clamped.
	const scrolled = await elementsOf('iframe_oopif_scrolled', ['full']);
	const frame = byId(scrolled.elements, 'oos-frame');
	assertEquals(frame.bounds, { x: 12, y: 109.6875, w: 480, h: 200 });
	assertEquals(byId(scrolled.elements, 'fp-b01').bounds, { x: 25, y: -137.3125, w: 111.5625, h: 21 });
	assertEquals(byId(scrolled.elements, 'fp-b03').bounds, { x: 25, y: -17.3125, w: 111.5625, h: 21 });

	// `scroll_page_prescrolled`: the TOP document is scrolled 2000 px, so `bounds` and
	// `document_bounds` differ by exactly that, and the band ±1000 px around the viewport is what
	// the index admits.
	const prescrolled = await elementsOf('scroll_page_prescrolled', ['full']);
	assertEquals(prescrolled.scroll.y, 2000);
	const b6 = byId(prescrolled.elements, 'ps-b6');
	assertEquals(b6.document_bounds, { x: 20, y: 2096.6875, w: 128.625, h: 21 });
	assertEquals(b6.bounds, { x: 20, y: 96.6875, w: 128.625, h: 21 });
	for (const element of prescrolled.elements) {
		assert(element.bounds!.y >= -1000 - element.bounds!.h && element.bounds!.y <= 900 + 1000, `${element.attrs?.id}`);
	}

	// `iframe_oopif_index_collision`: the same backendNodeId in two sessions composes into two
	// different places, which is exactly what the composite key exists to keep apart.
	const collision = await elementsOf('iframe_oopif_index_collision', ['full']);
	assertEquals(byId(collision.elements, 'cc-c01').bounds, { x: 22, y: 282.40625, w: 12, h: 12 });
	assertEquals(byId(collision.elements, 'hc-b01').bounds, { x: 13, y: 89.6875, w: 100, h: 19.1875 });
	// And the same-site control: a pierced frame composes through the same code.
	const sameSite = await elementsOf('iframe_same_site_port', ['full']);
	assertEquals(byId(sameSite.elements, 'd2-button').bounds, { x: 21, y: 219.46875, w: 99.75, h: 21 });
	assertEquals(byId(sameSite.elements, 'd2-button').frame?.url, 'http://127.0.0.1:38112/frames/frame_depth2.html');
});

// --- A-4 --------------------------------------------------------------------------------------------

Deno.test('A-4: the default set costs at most 310 B/element on the heaviest recorded capture', async () => {
	const perElement = async (fields: Parameters<typeof resolveFields>[0]) => {
		const observation = await elementsOf('truncation_large', fields);
		return JSON.stringify(observation.elements).length / observation.elements.length;
	};
	const minimal = await perElement(['minimal']);
	const core = await perElement(['core']);
	const withLocator = await perElement(['core', 'locator']);
	// The numbers, so the report carries what was measured rather than what was predicted:
	// minimal 106.5, core 250.4, core+locator 368.4 on `truncation_large` (1201 elements).
	assertAlmostEquals(minimal, 106.5, 0.1);
	assertAlmostEquals(core, 250.4, 0.1);
	assertAlmostEquals(withLocator, 368.4, 0.1);
	assert(core <= 310, `the default costs ${core.toFixed(1)} B/element; the plan's gate is 310`);
	// D-035, on the record: the design's default included `locator` and measured 307 with placeholder
	// strings; the real candidate carries a 32-hex frame id and pushes the set to 368. It was cut.
	assertGreater(withLocator, 310);
});

Deno.test('A-4: the mean over the corpus, so a later change to any field shows up as a number', async () => {
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
	// Measured 2026-09-09: minimal 61.9, core ~215, full ~990 (full is a floor: labels vary by page).
	assertAlmostEquals(sums.minimal / sums.n, 61.9, 0.5);
	assertLess(sums.core / sums.n, 260);
	assertLess(sums.full / sums.n, 1100);
});

// --- DD-7 -------------------------------------------------------------------------------------------

Deno.test('DD-7: a real password field with a real value discloses nothing on any element surface', async () => {
	const observation = await elementsOf('form_attributes', ['full']);
	const field = byId(observation.elements, 'f-password');
	assertEquals(field.input?.value, MASKED_INPUT_VALUE, 'a value is present; that is all a consumer learns');
	assertEquals(field.input?.type, 'password');
	assert(!('value' in (field.attrs ?? {})), 'attrs never carries value');
	assertEquals(field.text, undefined, 'text is empty and therefore omitted');
	assertEquals(field.label, 'Account password', 'the accessible name is not a secret');
	// And nothing, anywhere, in either half.
	assert(!JSON.stringify(observationStructured(observation)).includes(SENTINEL));
	assert(!JSON.stringify(observationPayload(observation)).includes(SENTINEL));
	assert(!observation.page.includes(SENTINEL));
	// The sentinel really is in the capture, so the test is not passing on an absent value.
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

Deno.test('I-4: the text payload carries the five frozen fields whatever fields were requested', async () => {
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
	// Rule 4 of `isInteractiveElement` refuses disabled controls, so `enabled` is `true` for every
	// element this tool can emit today. It is emitted anyway because the contract names it and a
	// later change to rule 4 would make it load-bearing; recorded here so nobody reads it as a bug.
	for (const page of DOM_FIXTURE_PAGES) {
		const observation = await elementsOf(page.name, ['enabled']);
		assert(observation.elements.every((element) => element.enabled === true), page.name);
	}
});
