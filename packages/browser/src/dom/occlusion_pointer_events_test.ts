/**
 * ERRATUM(E-76): a `pointer-events: none` cover is not an occluder.
 *
 * Measured first (U-2, `tests/e2e/element_at_e2e_test.ts`): Chromium's hit test passes through such a cover
 * and names the button underneath, while the paint-order filter treated the cover as opaque and dropped the
 * button from the table — so `browser_element_at` answered "nothing" where a click would land. These tests
 * pin the repaired filter against the recorded capture of that exact page (D-TEST1), and against a
 * hand-built tree for the inheritance rule the capture does not exercise.
 */
import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { buildIr } from '../../fixtures/serializer/_ir.ts';
import { type DomCapture, mergeDomTrees, walkTree } from './extract.ts';
import { serializeDomState } from './serialize.ts';
import type { EnhancedDomTreeNode } from './types.ts';

const FIXTURE_DIR = fromFileUrl(new URL('../../fixtures/dom', import.meta.url));

async function loadCapture(name: string): Promise<DomCapture> {
	return JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/${name}.capture.json`)) as DomCapture;
}

function byId(root: EnhancedDomTreeNode, id: string): EnhancedDomTreeNode {
	for (const node of walkTree(root)) if (node.attributes['id'] === id) return node;
	throw new Error(`no element with id ${id}`);
}

Deno.test('E-76: the control under a pointer-events:none cover is indexed; one under an opaque cover is not', async () => {
	const merged = mergeDomTrees(await loadCapture('occlusion_paint_order'));
	assert(merged.root !== null);
	const root = merged.root;
	const cover = byId(root, 'pe-none-cover');
	const covered = byId(root, 'pe-none-covered-button');
	// The capture is the measurement: the cover really is pointer-transparent, paints later, and covers the
	// button's whole box — every precondition the old filter used to call this an occlusion.
	assertEquals(cover.snapshotNode?.computedStyles?.['pointer-events'], 'none');
	assert((cover.snapshotNode?.paintOrder ?? 0) > (covered.snapshotNode?.paintOrder ?? 0));

	const { state } = serializeDomState(root);
	const indexed = new Set(state.selectorMap.values());
	assert(indexed.has(covered), 'the button under a pointer-events:none cover must be actionable');
	assert(!indexed.has(byId(root, 'occluded-button')), 'an opaque, pointer-receiving cover still occludes');
	assert(indexed.has(byId(root, 'partly-occluded-button')), 'a partly covered control was never occluded');
	assert(!indexed.has(cover), 'the cover itself is not interactive (rule 3)');
});

Deno.test('E-76: a descendant that turns pointer-events back on still occludes', () => {
	const tree = buildIr({
		tag: 'HTML',
		children: [{
			tag: 'BODY',
			children: [
				{ tag: 'BUTTON', id: 10, rect: [10, 10, 100, 30], paintOrder: 1, children: [{ text: 'Under a cover' }] },
				{ tag: 'BUTTON', id: 11, rect: [10, 60, 100, 30], paintOrder: 1, children: [{ text: 'Under a panel' }] },
				{
					tag: 'DIV',
					id: 20,
					rect: [0, 0, 400, 200],
					paintOrder: 5,
					styles: { 'background-color': 'rgba(0, 0, 0, 0.5)', 'pointer-events': 'none' },
					children: [{
						// Inside the transparent-to-clicks cover, but it takes the pointer back: a click on
						// (10..110, 60..90) lands on this panel, so the second button is occluded.
						tag: 'DIV',
						id: 21,
						rect: [0, 50, 400, 50],
						paintOrder: 6,
						styles: { 'background-color': 'rgb(255, 255, 255)', 'pointer-events': 'auto' },
					}],
				},
			],
		}],
	});
	const { state } = serializeDomState(tree);
	const indexed = new Set([...state.selectorMap.values()].map((node) => node.backendNodeId));
	assert(indexed.has(10), 'covered only by the pointer-transparent layer: actionable');
	assert(!indexed.has(11), 'covered by a pointer-receiving descendant of that layer: occluded');

	// The switch still turns the whole filter off, as before.
	const unfiltered = serializeDomState(tree, { paintOrderFiltering: false });
	assert(new Set([...unfiltered.state.selectorMap.values()].map((node) => node.backendNodeId)).has(11));
});
