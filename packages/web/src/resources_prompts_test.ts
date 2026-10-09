/// <reference lib="deno.ns" />
/**
 * The Prompts group's listing rule (run model-providers-ui, F2): the union of the stored prompts (`prompt_list`) and
 * the served ones (`prompts/list`), one entry per name, the stored one winning a clash and keeping its editor; a
 * served-only prompt has no `stored` and is what the tree marks with the lock.
 */
import { assertEquals } from '@std/assert';
import type { Prompt } from './resources_drawer.ts';
import { mergePrompts } from './resources_prompts.ts';

const stored = (name: string, title?: string): Prompt => ({
	name,
	title,
	arguments: [{ name: 'input', required: true }],
	template: '{{input}}',
	updated_at: '2026-10-05T00:00:00Z',
});

Deno.test('prompts: stored prompts come first and keep their editor; served-only ones follow without one', () => {
	const merged = mergePrompts(
		[stored('summarise', 'Summarise'), stored('translate')],
		[{ name: 'skill:code-review', description: 'The code-review skill' }, { name: 'summarise', title: 'served' }],
	);
	assertEquals(merged.map((entry) => entry.name), ['summarise', 'translate', 'skill:code-review']);
	assertEquals(merged[0]?.title, 'Summarise', 'the stored prompt wins the clash');
	assertEquals(merged[0]?.stored?.template, '{{input}}');
	assertEquals(merged[2]?.stored, undefined, 'a served-only prompt is read-only');
	assertEquals(merged[2]?.description, 'The code-review skill');
});

Deno.test('prompts: a name appears once however many lists carry it, and arguments default to none', () => {
	const merged = mergePrompts([], [
		{ name: 'a', arguments: [{ name: 'x' }] },
		{ name: 'a', arguments: [{ name: 'y' }] },
		{ name: 'b' },
	]);
	assertEquals(merged.length, 2);
	assertEquals(merged[0]?.arguments, [{ name: 'x' }], 'the first served entry stands');
	assertEquals(merged[1]?.arguments, []);
});

Deno.test('prompts: nothing stored and nothing served is an empty list, not a failure', () => {
	assertEquals(mergePrompts([], []), []);
});
