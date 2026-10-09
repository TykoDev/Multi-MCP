/// <reference lib="deno.ns" />
/** `task_kinds.ts`: the kind a card shows, its fallback for older tasks, and the chip words. */
import { assert, assertEquals } from '@std/assert';
import { backendChip, KIND_LOOK, TASK_EXCLUDED_TOOLS, taskKindOf } from './task_kinds.ts';
import { ICONS } from './icon_names.ts';

Deno.test('task_kinds: metadata.kind wins and is never second-guessed from history', () => {
	assertEquals(taskKindOf({ metadata: { kind: 'text' } }), 'text');
	assertEquals(taskKindOf({ metadata: { kind: 'tool' } }), 'tool');
	assertEquals(taskKindOf({ metadata: { kind: 'delegation' } }), 'delegation');
	// C6: a task that carries metadata is read from it even when its history would say otherwise.
	assertEquals(
		taskKindOf({ metadata: { kind: 'text' }, history: [{ parts: [{ data: { tool: 'browser_navigate' } }] }] }),
		'text',
	);
});

Deno.test('task_kinds: an older task without metadata is read from its first message and artifacts', () => {
	assertEquals(taskKindOf({}), 'text');
	assertEquals(taskKindOf({ metadata: null }), 'text');
	assertEquals(taskKindOf({ metadata: { kind: 'something-new' } }), 'text', 'an unknown kind falls through');
	assertEquals(taskKindOf({ history: [{ parts: [{ text: 'Open the docs' }] }] }), 'text');
	assertEquals(taskKindOf({ history: [{ parts: [{ data: { tool: 'browser_navigate', arguments: {} } }] }] }), 'tool');
	assertEquals(
		taskKindOf({ artifacts: [{ name: 'delegated-task' }], history: [{ parts: [{ text: 'x' }] }] }),
		'delegation',
	);
	assertEquals(taskKindOf({ artifacts: [{ name: 'Result' }], history: [{ parts: [{ text: 'x' }] }] }), 'text');
});

Deno.test('task_kinds: every kind has a glyph the sprite draws', () => {
	for (const [kind, look] of Object.entries(KIND_LOOK)) {
		assert(look.glyph in ICONS, `${kind} → ${look.glyph}`);
		assertEquals(look.label, kind === 'delegation' ? 'delegation' : kind);
	}
});

Deno.test('task_kinds: the backend chip names provider · model, the coding agent, or nothing', () => {
	assertEquals(backendChip({ backend: 'model', provider: 'openai-main', model: 'gpt-4.1' }), 'openai-main · gpt-4.1');
	assertEquals(backendChip({ backend: 'model', provider: 'openai-main' }), 'openai-main');
	assertEquals(backendChip({ backend: 'acp' }), 'Coding agent');
	assertEquals(backendChip({ kind: 'tool' } as { backend?: unknown }), null);
	assertEquals(backendChip(undefined), null);
	assertEquals(backendChip(null), null);
	// D-156: a SlopLord task names the profile, then what it ran on.
	assertEquals(
		backendChip({ backend: 'model', provider: 'fake', model: 'proof-1', agent: 'sloplord' }),
		'SlopLord · fake · proof-1',
	);
});

Deno.test('task_kinds: the excluded set is a literal of tool names, none offered twice', () => {
	// The gateway comparison lives in tests/unit/task_excluded_test.ts; here only the shape.
	assert(TASK_EXCLUDED_TOOLS.size >= 13);
	for (const name of TASK_EXCLUDED_TOOLS) assert(/^[a-z][a-z0-9_]+$/.test(name), name);
	assert(TASK_EXCLUDED_TOOLS.has('browser_run_task'));
	assert(TASK_EXCLUDED_TOOLS.has('a2ui_delete'));
});
