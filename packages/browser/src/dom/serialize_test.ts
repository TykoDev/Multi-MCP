/**
 * `dom-serializer` tier-1 suite (OBSERVABILITY-TESTING-CICD §4.2): IR fixtures in → §6.4 text out,
 * compared byte-exact against checked-in goldens, plus the §6.3 index rules R6.1–R6.4.
 *
 * Every golden in `fixtures/serializer/` was authored from DATA-MODEL §6.4/§6.5 by hand — they are the
 * regression contract *today*, and the Python-recorded corpus COMPLETIONS-CRITERIA §3.2 asks for drops
 * in later as a second comparison against the same fixture trees.
 */

import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { buildIr, type FixtureNode, loadFixture, loadGolden } from '../../fixtures/serializer/_ir.ts';
import { domNodeDerived } from './derived.ts';
import {
	failSafeDomState,
	isStaleNodeIdError,
	MAX_CLICKABLE_ELEMENTS_LENGTH,
	selectorKey,
	serializeDomState,
	type SerializerDerived,
} from './serialize.ts';

/** Every golden pair rendered with the options its fixture declares. */
const GOLDEN_CASES = [
	'basic_page',
	'paint_order',
	'visibility',
	'selector_collision',
	'shadow_dom',
	'iframe_scroll',
	'scroll_containers',
	'svg_collapse',
	'attributes',
] as const;

for (const name of GOLDEN_CASES) {
	Deno.test(`dom-serializer/golden: ${name}`, async () => {
		const { file, ir } = await loadFixture(name);
		const expected = await loadGolden(name);
		const result = serializeDomState(ir, { ...(file.options ?? {}) });
		assertEquals(result.text, expected, file.pins);
	});
}

Deno.test('dom-serializer: R6.2 new-element marking across two consecutive states', async () => {
	const before = await loadFixture('new_marking_before');
	const after = await loadFixture('new_marking_after');

	const first = serializeDomState(before.ir);
	assertEquals(first.text, await loadGolden('new_marking_before'));
	// Step 1 has no previous state at all, so nothing is new.
	assert(!first.text.includes('*['), 'step 1 must not mark anything new');

	const second = serializeDomState(after.ir, { previousKeys: first.keys });
	assertEquals(second.text, await loadGolden('new_marking_after'));
});

Deno.test('dom-serializer: R6.2 an explicitly empty previous set marks every element new', async () => {
	const { ir } = await loadFixture('new_marking_before');
	const result = serializeDomState(ir, { previousKeys: new Set<string>() });
	assertEquals(result.text.split('\n').filter((line) => line.startsWith('*[')).length, 2);
});

Deno.test('dom-serializer: R6.1 selectorMap indices are backendNodeIds until they collide', async () => {
	const { ir } = await loadFixture('selector_collision');
	const result = serializeDomState(ir);
	const entries = [...result.state.selectorMap.entries()];
	// 600 is the host <iframe>, which the reference indexes like any other control (E-23 item 4), and
	// which is assigned before its own content because index assignment is document order.
	assertEquals(entries.map(([index]) => index).sort((a, b) => a - b), [500, 600, 700, 701]);
	assertEquals(entries.map(([index]) => index), [500, 600, 701, 700], 'document order, host frame first');

	// CC §3.2: index ↔ backendNodeId stability. Every index either *is* the node's backend id, or is a
	// synthetic allocated above the reserved pool because that id was already taken.
	const reserved = 700;
	for (const [index, node] of entries) {
		if (index === node.backendNodeId) continue;
		assert(index > reserved, `synthetic index ${index} must sit above max(reservedBackendIds)`);
	}
	const collided = result.state.selectorMap.get(701);
	assertEquals(collided?.backendNodeId, 500);
	assertEquals(collided?.sessionId, 'session-oopif');

	// R6.3 — the reverse map is keyed by (sessionId, backendNodeId), which is what makes the two
	// same-numbered nodes distinguishable at all.
	assertEquals(result.reverseMap.get(selectorKey('session-main', 500)), 500);
	assertEquals(result.reverseMap.get(selectorKey('session-oopif', 500)), 701);
	assertEquals(result.keys.size, 4, 'three buttons plus the host frame');
});

Deno.test('dom-serializer: paint-order filtering is a profile switch, not a law of nature', async () => {
	const { ir } = await loadFixture('paint_order');
	const filtered = serializeDomState(ir);
	assert(!filtered.state.selectorMap.has(800), 'occluded button must not be actionable');

	const unfiltered = serializeDomState(ir, { paintOrderFiltering: false });
	assert(unfiltered.state.selectorMap.has(800), 'with filtering off the covered button comes back');
	assert(unfiltered.text.includes('Under the modal'));
});

Deno.test('dom-serializer: occluded nodes keep their §6.3 flags but never reach the selector map', async () => {
	const { ir } = await loadFixture('paint_order');
	const result = serializeDomState(ir);
	const flatten = (node: { children: unknown[] } | null): Record<string, unknown>[] => {
		if (node === null) return [];
		const self = node as unknown as Record<string, unknown>;
		const children = (node.children as { children: unknown[] }[]).flatMap((child) => flatten(child));
		return [self, ...children];
	};
	const occluded = flatten(result.state.root).filter((node) => node['ignoredByPaintOrder'] === true);
	assertEquals(occluded.length, 1);
	assertEquals(occluded[0]?.['shouldDisplay'], false);
	assertEquals(occluded[0]?.['selectorIndex'], null);
});

/** A page wide enough to blow the §6.4 cap. */
function bigPage(buttons: number): FixtureNode {
	const children: FixtureNode[] = [];
	for (let index = 0; index < buttons; index++) {
		children.push({
			tag: 'BUTTON',
			id: 100_000 + index,
			attrs: { name: `control-number-${index}` },
			children: [{ text: `Press me number ${index}` }],
		});
	}
	return { tag: 'HTML', children: [{ tag: 'BODY', children }] };
}

Deno.test('dom-serializer: the 40k cap is opt-in — the serializer never truncates by default', () => {
	// ERRATUM(M1-corpus-1). Pinned against the recorded corpus: the reference's serialized output for
	// the equivalent page is 225 423 chars with its tail intact, so §6.4's cap belongs to the prompt
	// layer (M2), not here. A default cap would silently drop page content the reference exposes.
	const ir = buildIr(bigPage(1200));
	const uncapped = serializeDomState(ir);
	assert(
		uncapped.text.length > MAX_CLICKABLE_ELEMENTS_LENGTH,
		'fixture must exceed the cap, or this test proves nothing',
	);
	assert(!uncapped.truncated, 'the serializer must not truncate unless a cap is passed');

	// The capability still exists for the prompt layer to invoke explicitly.
	const capped = serializeDomState(ir, { maxClickableElementsLength: MAX_CLICKABLE_ELEMENTS_LENGTH });
	assert(capped.truncated);
	assertEquals(capped.text.length, MAX_CLICKABLE_ELEMENTS_LENGTH);
	assertEquals(capped.text, uncapped.text.slice(0, MAX_CLICKABLE_ELEMENTS_LENGTH));
	// The cut is hard: it may land mid-line, and the selector map is NOT trimmed with it.
	assert(capped.state.selectorMap.size > 0);
});

Deno.test('dom-serializer: the truncation boundary is exclusive', () => {
	const ir = buildIr({ tag: 'HTML', children: [{ tag: 'BODY', children: [{ text: 'abcdefghij' }] }] });
	const exact = serializeDomState(ir, { maxClickableElementsLength: 10 });
	assertEquals(exact.truncated, false);
	assertEquals(exact.text, 'abcdefghij');
	const clipped = serializeDomState(ir, { maxClickableElementsLength: 9 });
	assertEquals(clipped.truncated, true);
	assertEquals(clipped.text, 'abcdefghi');
});

Deno.test('dom-serializer: R6.4 a blown budget yields an empty selectorMap, not a partial one', () => {
	const ir = buildIr(bigPage(400));
	const control = serializeDomState(ir);
	assertEquals(control.stateError, null);
	assert(control.state.selectorMap.size > 0);

	// A clock that has already passed the deadline by the time the first budget check fires.
	let tick = 0;
	const result = serializeDomState(ir, { budgetMs: 0, now: () => tick++ });

	assertNotEquals(result.stateError, null);
	assertEquals(result.state.selectorMap.size, 0);
	assertEquals(result.state.root, null);
	assertEquals(result.text, '');
	assertEquals(result.keys.size, 0);
	assertEquals(result.reverseMap.size, 0);
});

Deno.test('dom-serializer: R6.4 the fail-safe state carries stateError and nothing actionable', () => {
	const state = failSafeDomState('BrowserStateRequestEvent timed out');
	assertEquals(state.stateError, 'BrowserStateRequestEvent timed out');
	assertEquals(state.state.selectorMap.size, 0);
	assertEquals(state.state.root, null);
	assertEquals(state.text, '');
	assert((failSafeDomState().stateError ?? '').length > 0, 'the default reason must say something');
});

Deno.test('dom-serializer: R6.3 stale-node CDP errors are recognised as "rebuild", not "crash"', () => {
	assert(isStaleNodeIdError(new Error('No node with given id found')));
	assert(isStaleNodeIdError('Could not find node with given id'));
	assert(isStaleNodeIdError({ message: 'Node with given id does not belong to the document' }));
	assert(!isStaleNodeIdError(new Error('Target closed')));
	assert(!isStaleNodeIdError(null));
	assert(!isStaleNodeIdError(42));
});

Deno.test('dom-serializer: a null tree serializes to an empty, non-crashing state', () => {
	const result = serializeDomState(null, { pixelsAbove: 0, pixelsBelow: 0 });
	assertEquals(result.state.root, null);
	assertEquals(result.state.selectorMap.size, 0);
	assertEquals(result.text, '[Start of page]\n[End of page]');
});

Deno.test('dom-serializer: page markers appear only when the page is scrolled to that edge', () => {
	const ir = buildIr({ tag: 'HTML', children: [{ tag: 'BODY', children: [{ text: 'middle' }] }] });
	assertEquals(serializeDomState(ir, { pixelsAbove: 120, pixelsBelow: 300 }).text, 'middle');
	assertEquals(serializeDomState(ir, { pixelsAbove: 0, pixelsBelow: 300 }).text, '[Start of page]\nmiddle');
	assertEquals(serializeDomState(ir, { pixelsAbove: 120, pixelsBelow: 0 }).text, 'middle\n[End of page]');
	assertEquals(serializeDomState(ir).text, 'middle');
});

Deno.test("dom-serializer: the extraction half's derived members render byte-identical goldens", async () => {
	// The seam of ERRATUM(M1-dom-serialize-1). `serialize_derived.ts` exists so this suite can run
	// before `derived.ts` lands; now that it has, injecting the real implementation must not move a
	// single byte. If this test ever fails, one of the two implementations of §6.1's derived members
	// has drifted — which is a serialization drift (R1), not a test problem.
	const derived: SerializerDerived = domNodeDerived;
	for (const name of GOLDEN_CASES) {
		const { file, ir } = await loadFixture(name);
		const expected = await loadGolden(name);
		assertEquals(serializeDomState(ir, { ...(file.options ?? {}), derived }).text, expected, name);
	}
});

Deno.test('dom-serializer: the selector map is rebuilt from scratch on every request (R6.3)', async () => {
	const { ir } = await loadFixture('new_marking_before');
	const first = serializeDomState(ir);
	const second = serializeDomState(ir, { previousKeys: first.keys });
	assert(first.state.selectorMap !== second.state.selectorMap, 'a fresh Map every request, never a mutated one');
	assertEquals([...first.state.selectorMap.keys()], [...second.state.selectorMap.keys()]);
	assertEquals(second.text, first.text, 'an unchanged page marks nothing new');
});
