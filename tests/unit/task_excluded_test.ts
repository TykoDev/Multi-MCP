/**
 * D-143 (design §3.12, gate F6): the SPA's `TASK_EXCLUDED_TOOLS` is the gateway's `NOT_TASKABLE`, member for member.
 *
 * The SPA keeps a literal copy because it ships in the browser bundle and must not import the server's graph
 * (`task_kinds.ts` imports nothing from the gateway); this test is what keeps the copy honest. The gateway set is
 * read through a deep import of its leaf module so the comparison is against the judge itself — the set the runtime
 * refuses at `invoke` — not a re-export that could be redefined.
 */
import { assertEquals } from '@std/assert';
import { NOT_TASKABLE } from '../../packages/gateway/src/taskable.ts';
import { TASK_EXCLUDED_TOOLS } from '../../packages/web/src/task_kinds.ts';

Deno.test('TASK_EXCLUDED_TOOLS equals the gateway NOT_TASKABLE set (D-143 §3.12)', () => {
	const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();
	assertEquals(sorted(TASK_EXCLUDED_TOOLS), sorted(NOT_TASKABLE));
});

Deno.test('TASK_EXCLUDED_TOOLS is a literal: task_kinds.ts imports nothing from the gateway', async () => {
	const source = await Deno.readTextFile(new URL('../../packages/web/src/task_kinds.ts', import.meta.url));
	const imports = source.match(/^import .*$/gm) ?? [];
	assertEquals(imports.filter((line) => /gateway|@tykotech\/mcp|taskable/.test(line)), []);
});
