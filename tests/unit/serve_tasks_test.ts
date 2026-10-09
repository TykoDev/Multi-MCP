/**
 * ERRATUM(E-82): the server tasks (`dev`, `stdio`, `serve:cluster`) launch a browser without a permission prompt.
 *
 * They used to carry no `--allow-run` and no temp-directory grant, so every launch rode on interactive prompts —
 * which `stdio` can never answer, because an MCP client owns its stdin. Each task now resolves its grants the way the
 * browser tier does, pins `TTK_BROWSER_PATH` to the granted binary, and runs with `--no-prompt`, because a defensive
 * read of an ungranted variable *blocked on a prompt* on Windows instead of answering "unset". End to end this was
 * proven by driving `deno task stdio` through a real Chrome launch with piped stdio; here the shape is held.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { NO_FFMPEG_SENTINEL, serveFfmpegGrant } from '../../scripts/tier_paths.ts';
import { checkTasks, OTEL_GATE_PRESTEP, tasksOf } from '../../scripts/check_tasks.ts';

const SERVER_TASKS = ['dev', 'stdio', 'serve:cluster'] as const;

async function tasks(): Promise<Record<string, string>> {
	return tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));
}

Deno.test('E-82: each server task resolves its run grant, pins the browser it grants, and never prompts', async () => {
	const table = await tasks();
	// D-137 / SEC-1: every grant substitution runs its helper with OTEL_DENO=false, so it cannot export ahead of the gate.
	for (const name of SERVER_TASKS) {
		const raw = table[name];
		assert(raw !== undefined, `${name} exists`);
		// SEC-1W (D-137): dev, the one --watch task, judges OTLP egress before its watcher starts; the rest is the matrix.
		if (name === 'dev') assert(raw.startsWith(`${OTEL_GATE_PRESTEP} && `), 'dev runs the gate pre-step first');
		const command = raw.replace(`${OTEL_GATE_PRESTEP} && `, '');
		assertStringIncludes(
			command,
			'--no-prompt',
			`${name}: a prompt cannot be answered under stdio, and blocked on Windows`,
		);
		assertStringIncludes(
			command,
			'"--allow-run=$(OTEL_DENO=false deno task -q resolve:chromium --grant --serve || echo ttk-tier/no-chromium-resolved),' +
				'$(OTEL_DENO=false deno task -q tier:paths --serve-ffmpeg || echo ttk-tier/no-ffmpeg-resolved)"',
			`${name}: the grant is the resolved browser plus the operator's ffmpeg, never bare`,
		);
		assert(
			command.startsWith(
				'TTK_BROWSER_PATH="$(OTEL_DENO=false deno task -q resolve:chromium --pin --serve || echo)" deno run ',
			),
			`${name}: the server launches the very binary the grant names`,
		);
		assertStringIncludes(
			command,
			'"--allow-write=$(OTEL_DENO=false deno task -q tier:paths --write),data"',
			`${name}: temp profiles, and (D-154) the local data directory`,
		);
	}
	// The three are one matrix, differing only in what they run.
	const differences = [`${OTEL_GATE_PRESTEP} && `, ' --watch', ' --unstable-kv', ',localhost', / (serve|stdio)$/];
	const shape = (command: string) => differences.reduce<string>((text, part) => text.replace(part, ''), command);
	assertEquals(shape(table.dev!), shape(table.stdio!));
	assertEquals(shape(table['serve:cluster']!), shape(table.stdio!));
	assertEquals(checkTasks(table), [], 'and the task gate still passes');
});

Deno.test('E-82: the server ffmpeg grant is the operator\u2019s TTK_FFMPEG or an inert placeholder, never a PATH find', () => {
	assertEquals(serveFfmpegGrant(undefined), NO_FFMPEG_SENTINEL);
	assertEquals(serveFfmpegGrant('/usr/bin/ffmpeg'), '/usr/bin/ffmpeg');
	assertEquals(serveFfmpegGrant('C:\\tools\\ffmpeg\\bin\\ffmpeg.exe'), 'C:/tools/ffmpeg/bin/ffmpeg.exe');
	assertEquals(serveFfmpegGrant('/opt/a,b/ffmpeg'), NO_FFMPEG_SENTINEL, 'a comma cannot be spelled in a grant list');
});

/**
 * D-137 (design §2.3, AC3, F4/F5): the CLI's static module graph before the egress gate is `@std/cli/parse-args` and
 * the import-free `otel_gate.ts`, and the gate runs at module top level before `main()` — so no gateway, MCP or
 * browser module is evaluated, and nothing is exported, before a refusal. Every other module is an `await import(…)`.
 */
Deno.test('D-137 (AC3): the CLI imports only parse-args and the gate statically, and gates every subcommand', async () => {
	const source = await Deno.readTextFile('packages/cli/mod.ts');
	const statics = [...source.matchAll(/^(?:import|export)\s(?!type\b)[^;]*?\sfrom\s+'([^']+)';/gms)].map((m) => m[1]);
	assertEquals([...new Set(statics)].sort(), ['./otel_gate.ts', '@std/cli/parse-args']);
	assert(!/^import\s+'[^']+';/m.test(source), 'no side-effect import');
	// The gate's own module is a leaf.
	const gate = await Deno.readTextFile('packages/cli/otel_gate.ts');
	assert(
		!/^\s*(?:import|export)\s[^;]*\sfrom\s/m.test(gate) && !/^import\s/m.test(gate),
		'otel_gate.ts imports nothing',
	);
	// The tail: the gate first, for every subcommand (`version`, `help` and an unknown one included); `main` only after.
	const tail = source.match(/^if \(import\.meta\.main[^\n]*$/gm) ?? [];
	assertEquals(tail, ['if (import.meta.main && enforceOtelEgress(Deno.args)) Deno.exit(await main(Deno.args));']);
	assert(
		!/enforceOtelEgress\(/.test(
			source.slice(source.indexOf('export async function main'), source.indexOf('\nif (import.meta.main')),
		),
		'main() itself stays ungated',
	);
});
