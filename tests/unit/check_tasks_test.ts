/** The `deno.json` task gate (`scripts/check_tasks.ts`): each rule fails on the shape it exists to catch. */
import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import {
	bareParens,
	checkTasks,
	deniesFfiFirst,
	envEntryCovers,
	MATRIX_EXEMPTIONS,
	MODEL_PROVIDERS_ENV_COPY,
	modelProvidersGrantViolations,
	permissionValues,
	runGrantViolations,
	shippedClosure,
	taskReferences,
	tasksOf,
	unscoped,
	unscopedGrant,
} from '../../scripts/check_tasks.ts';
import { NO_FFMPEG_SENTINEL, serveFfmpegGrant } from '../../scripts/tier_paths.ts';
import { ENV_NAMES } from '@tykotech/gateway';
import { MODEL_PROVIDERS_ENV } from '../../packages/gateway/src/model_providers.ts';

const SHIPPED = ['dev', 'stdio', 'doctor', 'setup', 'seed'] as const;
const only = (rule: string, violations: ReturnType<typeof checkTasks>) => violations.filter((v) => v.rule === rule);
const table = async () => tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));

Deno.test('the shipped deno.json passes its own gate, and the providers-file name is the gateway’s', async () => {
	const tasks = await table();
	assert(Object.keys(tasks).length > 20, 'the task table should be fully readable');
	assertEquals(checkTasks(tasks), []);
	assertEquals(MODEL_PROVIDERS_ENV_COPY, MODEL_PROVIDERS_ENV);
	assert((ENV_NAMES as readonly string[]).includes(MODEL_PROVIDERS_ENV_COPY));
	assert(tasks.dev!.includes('TTK_BROWSER_PATH="$('), 'the serve tasks really carry an inline prefix');
	assertEquals(tasksOf({ tasks: { a: 'x', b: { command: 'y', dependencies: ['a'] }, c: {} } }), { a: 'x', b: 'y' });
});

Deno.test('T1: an unquoted PROGRAMFILES(X86) is a subshell; quoted or substituted parentheses are not', () => {
	const violations = only(
		'T1',
		checkTasks({
			doctor: 'deno run --allow-read=. --allow-env=TTK_*,PROGRAMFILES(X86),PATH packages/cli/mod.ts doctor',
		}),
	);
	assertEquals(violations.length, 2, 'one for each parenthesis');
	assertStringIncludes(violations[0]?.detail ?? '', 'subshell');
	assertEquals(bareParens('deno run --allow-read=. "--allow-env=TTK_*,PROGRAMFILES(X86),PATH" m.ts'), []);
	assertEquals(bareParens("deno run '--allow-env=PROGRAMFILES(X86)' x.ts"), []);
	assertEquals(bareParens('X="$(a || echo)" deno test "--allow-run=$(b --grant),$(c --ffmpeg)" t/'), []);
});

Deno.test('T2: an interpolated grant list is a violation; a substituted one or an assignment is not', () => {
	const violations = only(
		'T2',
		checkTasks({ t: 'deno run "--allow-read=.,$LOCALAPPDATA,$PROGRAMFILES,$USERPROFILE,$HOME,/usr/bin" s.ts' }),
	);
	assertEquals(violations.length, 4, 'one per interpolated variable');
	assertStringIncludes(violations[0]?.detail ?? '', 'escaped comma');
	assertEquals(
		checkTasks({ t: 'deno test --deny-ffi "--allow-read=$(deno task -q tier:paths --read)" tests/e2e/' }),
		[],
	);
	assertEquals(checkTasks({ t: 'FOO=$BAR deno run --deny-ffi --allow-read=. x.ts' }), []);
	assertEquals(permissionValues('deno test --allow-net=127.0.0.1,localhost "--allow-read=$(x --read)" t/'), [
		{ flag: '--allow-net', value: '127.0.0.1,localhost' },
		{ flag: '--allow-read', value: '$(x --read)' },
	]);
});

Deno.test('T3: every spelling of an unscoped grant fails, on any task MATRIX_EXEMPTIONS does not excuse', () => {
	for (
		const command of [
			'deno run --deny-ffi --allow-run m.ts',
			'deno run --deny-ffi "--allow-env" m.ts',
			'deno run --deny-ffi --allow-read= m.ts',
			'deno run --deny-ffi -RN m.ts',
			'deno run --deny-ffi -qA m.ts',
			"deno run --deny-ffi '--allow-all' m.ts",
			'deno run --deny-ffi -P=server m.ts',
			'deno run --deny-ffi --permission-set m.ts',
			'deno --deny-ffi -A m.ts',
			'deno compile --deny-ffi -A m.ts',
			'deno run --deny-ffi "--allow-read=$(deno run --deny-ffi -A x.ts)" m.ts',
		]
	) {
		assertEquals(unscoped(command).length, 1, command);
		assertEquals(only('T3', checkTasks({ dev: command })).length, 1, command);
		assertEquals(only('T3', checkTasks({ 'some:tool': command })).length, 1, `${command} (a tooling task)`);
	}
	for (const word of ['-R=.', '--allow-read=.', '-q', '-L', '--unstable-kv', '--deny-net', '--allow-scripts']) {
		assertEquals(unscopedGrant(word), null, word);
	}
	assert(unscopedGrant('-RW=.') !== null, 'a cluster with one value is refused');
	assertEquals(unscoped('deno run --deny-ffi m.ts -A --allow-read'), [], 'after the script it is an argument');
	assertEquals(unscoped('deno task -q x -A'), []);
	// An excuse covers its task and its rules only.
	assertEquals(checkTasks({ cov: 'deno run --deny-ffi -A scripts/coverage.ts' }), []);
	assertEquals(only('T4', checkTasks({ cov: 'deno run -A scripts/coverage.ts' })).length, 1);
});

Deno.test('T4: --deny-ffi must precede the first grant of every Deno invocation', () => {
	for (
		const command of [
			'deno run --allow-net=127.0.0.1 --deny-ffi m.ts',
			'deno run --deny-ffi-x --allow-read=. m.ts',
			'deno run --deny-ffi=./lib.so --allow-read=. m.ts',
			'deno run -R m.ts',
			'deno test -P t/',
			'deno serve --allow-net=127.0.0.1 m.ts',
			'deno run --config deno.json --allow-read=. m.ts',
			// A --deny-ffi of another invocation, or after the script path, does not count.
			'deno run --deny-ffi scripts/a.ts && deno run --allow-read=. packages/cli/mod.ts serve',
			'X="$(deno run --deny-ffi scripts/a.ts)" deno run --allow-read=. packages/cli/mod.ts serve',
			'deno run scripts/a.ts --deny-ffi; deno run --allow-net=127.0.0.1 packages/cli/mod.ts serve',
			'deno run m.ts --deny-ffi "$(deno run --allow-read=. y.ts)"',
			'deno run --deny-ffi "--allow-read=$(deno run --allow-env y.ts)" m.ts',
			'X="$(a "$(deno run --allow-read=. y.ts)")" deno run --deny-ffi m.ts',
			'X="$(a "$(b)" \')\')" deno run --allow-read=. m.ts',
		]
	) {
		assertFalse(deniesFfiFirst(command), command);
		assertEquals(only('T4', checkTasks({ dev: command })).length, 1, command);
	}
	for (
		const command of [
			'deno run m.ts',
			'deno run m.ts --allow-read=.',
			'deno run --no-prompt --deny-ffi --unstable-kv "--allow-read=." m.ts',
			'deno run -c deno.json --deny-ffi --allow-read=. m.ts',
			'deno run --deny-ffi --allow-read=. a.ts && deno test --deny-ffi --allow-net=127.0.0.1 t/',
			'deno run --deny-ffi "--allow-read=$(deno run --deny-ffi --allow-env y.ts)" m.ts',
			'deno task -q x --allow-read=.',
		]
	) {
		assert(deniesFfiFirst(command), command);
	}
	// build:web is excused from T4 alone, by name.
	assertEquals(checkTasks({ 'build:web': 'deno run --allow-read=packages/web scripts/build_icons.ts' }), []);
	assertEquals(only('T4', checkTasks({ 'some:tool': 'deno run --allow-read=packages/web scripts/build_icons.ts' })), [
		{
			task: 'some:tool',
			rule: 'T4',
			detail: '--deny-ffi must come before the first grant of every Deno invocation in a task MATRIX_EXEMPTIONS ' +
				'does not excuse',
		},
	]);
});

Deno.test('T6: a shipped task covers the providers file and never grants or sets a provider-key variable', () => {
	const keyed = only('T6', checkTasks({ dev: 'deno run --deny-ffi --allow-env=TTK_*,ANTHROPIC_API_KEY m.ts serve' }));
	assertEquals(keyed.length, 1);
	assertStringIncludes(keyed[0]?.detail ?? '', 'ANTHROPIC_API_KEY names a provider-key variable');
	for (const extra of ['OPENAI_API_KEY', 'TTK_MODEL_API_KEY', 'openai_base_url', 'ANTHROPIC_BASE_URL', 'X_API_KEY']) {
		assertEquals(modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${extra} m.ts`).length, 1, extra);
	}
	// The gateway's own key store is not a provider key: `_API_KEY` is anchored to the end.
	for (const own of ['TTK_API_KEYS', 'TTK_API_KEYS_FILE']) {
		assertEquals(modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${own} m.ts`), [], own);
	}
	// Coverage: by wildcard or by name, at the top level; a helper's grant is not the gateway's.
	assert(envEntryCovers('TTK_*', MODEL_PROVIDERS_ENV_COPY));
	assertFalse(envEntryCovers('TTK_MODEL_*_FILE', MODEL_PROVIDERS_ENV_COPY), 'only a trailing wildcard covers');
	assertFalse(envEntryCovers('TTK_MODEL_PROVIDERS', MODEL_PROVIDERS_ENV_COPY));
	assertEquals(modelProvidersGrantViolations('deno run --deny-ffi --allow-env=TTK_HOST m.ts').length, 1);
	assertEquals(
		modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_HOST,${MODEL_PROVIDERS_ENV_COPY} m.ts`),
		[],
	);
	assertStringIncludes(modelProvidersGrantViolations('deno run --deny-ffi m.ts')[0] ?? '', 'no --allow-env= grant');
	assertEquals(modelProvidersGrantViolations('deno run --deny-ffi m.ts', false), []);
	assertEquals(
		modelProvidersGrantViolations('deno run --deny-ffi "--allow-read=$(deno run --allow-env=TTK_* x.ts)" m.ts').length,
		1,
	);
	assertEquals(
		modelProvidersGrantViolations('deno run --deny-ffi --allow-env=TTK_* a.ts && deno run --allow-env=TTK_HOST m.ts')
			.length,
		1,
		'a later top-level step is judged too',
	);
	// A helper substitution need not cover the file, but may not name or set a key either.
	const helper = (inner: string): string => `deno run --deny-ffi "--allow-read=$(${inner})" --allow-env=TTK_* m.ts`;
	assertEquals(modelProvidersGrantViolations(helper('deno run --allow-env=TMPDIR,PATH x.ts')), []);
	assertEquals(modelProvidersGrantViolations(helper('deno run --allow-env=OPENAI_API_KEY x.ts')).length, 1);
	assertEquals(modelProvidersGrantViolations(helper('OPENAI_API_KEY=x deno run --allow-env=PATH x.ts')).length, 1);
	// Inline assignments: a path prefix is fine, a key is not; an argument after the script is not an assignment.
	const serve = (prefix: string): string => `${prefix}deno run --deny-ffi --allow-env=TTK_* packages/cli/mod.ts serve`;
	assertEquals(modelProvidersGrantViolations(serve('TTK_BROWSER_PATH="$(deno task -q resolve:chromium --pin)" ')), []);
	for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TTK_MODEL_API_KEY', 'X_API_KEY']) {
		assertEquals(only('T6', checkTasks({ stdio: serve(`${name}=x `) })).map((v) => v.detail), [
			`${name} is set inline: a provider key lives in ${MODEL_PROVIDERS_ENV_COPY}, never in the environment`,
		]);
	}
	assertEquals(modelProvidersGrantViolations('deno run --allow-env=TTK_* m.ts OPENAI_API_KEY=x'), []);
	// Test-only tasks are outside the rule.
	assertEquals(
		only('T6', checkTasks({ 'test:browser': 'ANTHROPIC_API_KEY=x deno test --allow-env=TTK_*,X_API_KEY t/' })),
		[],
	);
});

Deno.test('T7: --allow-run names absolute paths or a whole substitution', () => {
	assertEquals(runGrantViolations('deno run --deny-ffi --allow-run=/usr/bin/chromium,/usr/bin/ffmpeg m.ts'), []);
	assertEquals(
		runGrantViolations('deno run --deny-ffi "--allow-run=C:/tools/x.exe,$(deno task -q a || echo x)" m.ts'),
		[],
	);
	for (const value of ['docker', 'bin/chromium', './ffmpeg', '/usr/bin/a,git', '$(a)x']) {
		assertStringIncludes(runGrantViolations(`deno run --deny-ffi "--allow-run=${value}" m.ts`)[0] ?? '', 'absolute');
		assertEquals(only('T7', checkTasks({ 'some:tool': `deno run --deny-ffi "--allow-run=${value}" m.ts` })).length, 1);
	}
	assertEquals(runGrantViolations('deno run --deny-ffi m.ts --allow-run=docker'), []);
});

Deno.test('shipped closure: helpers a shipped task reaches are held to the matrix and the key rule, unexcused', () => {
	assertEquals(taskReferences('X="$(deno task -q a --grant || echo)" deno task --cwd d b && echo c'), ['a', 'b']);
	const tasks = {
		dev: `deno run --deny-ffi "--allow-read=$(deno task -q helper)" --allow-env=TTK_* m.ts serve`,
		helper: 'deno run --allow-read "--allow-env=PATH,ANTHROPIC_API_KEY" "--allow-read=$(deno task -q nested)" h.ts',
		nested: 'deno run --deny-ffi --allow-run=docker n.ts',
		'test:unit': 'deno test --deny-ffi --allow-read t/',
	};
	assertEquals([...shippedClosure(tasks)].sort(), ['dev', 'helper', 'nested']);
	const of = (t: Record<string, string>, task: string) =>
		checkTasks(t).filter((v) => v.task === task).map((v) => v.rule).sort();
	assertEquals(of(tasks, 'dev'), []);
	assertEquals(of(tasks, 'helper'), ['T3', 'T4', 'T6'], 'the key half only: a helper is not the gateway');
	assertEquals(of(tasks, 'nested'), ['T7']);
	assertEquals(of(tasks, 'test:unit'), []);
	const reaching = { ...tasks, nested: 'deno run --deny-ffi "--allow-read=$(deno task -q test:unit)" n.ts' };
	assertEquals(of(reaching, 'test:unit'), ['T3'], 'an excuse stops holding once a shipped task reaches the task');
});

Deno.test('exemptions name real tasks outside the shipped closure, and each is still needed', async () => {
	const tasks = await table();
	const closure = shippedClosure(tasks);
	assertEquals(
		[...closure].sort(),
		[...SHIPPED.filter((name) => name in tasks), 'chromium:read', 'paths:serve', 'resolve:chromium'].sort(),
	);
	for (const [task, { rules, why }] of Object.entries(MATRIX_EXEMPTIONS)) {
		const command = tasks[task];
		assert(command !== undefined, `${task}: an exemption for a task that does not exist`);
		assertFalse(closure.has(task), `${task} is on the shipped surface and cannot be excused`);
		assert(why.length > 20, `${task}: say why`);
		for (const rule of rules) {
			const fires = rule === 'T3'
				? unscoped(command).length > 0
				: rule === 'T4'
				? !deniesFfiFirst(command)
				: rule === 'T7' && runGrantViolations(command).length > 0;
			assert(fires, `${task}: the ${rule} excuse is not needed; remove it`);
		}
	}
	// paths:serve, the helper the serve tasks reach, reads no file and names only what its two modes read.
	assertEquals(
		tasks['paths:serve'],
		'deno run --no-prompt --deny-ffi --allow-env=TMPDIR,TEMP,TMP,TTK_FFMPEG scripts/tier_paths.ts',
	);
	for (const name of ['dev', 'stdio']) assertFalse(tasks[name]!.includes('tier:paths'), name);
});

Deno.test('server tasks: dev and stdio pin the browser they grant and never prompt (stdio cannot answer one)', async () => {
	const tasks = await table();
	for (const name of ['dev', 'stdio']) {
		const command = tasks[name]!;
		assert(command.startsWith('TTK_BROWSER_PATH="$(deno task -q resolve:chromium --pin --serve || echo)" deno run '));
		assertStringIncludes(command, '--no-prompt');
		assertStringIncludes(
			command,
			'"--allow-run=$(deno task -q resolve:chromium --grant --serve || echo ttk-tier/no-chromium-resolved),' +
				'$(deno task -q paths:serve --serve-ffmpeg || echo ttk-tier/no-ffmpeg-resolved)"',
		);
		assertStringIncludes(command, '"--allow-write=$(deno task -q paths:serve --write),data"');
		assertFalse(/OTEL/.test(command), 'no OTEL_* name: the server exports none');
	}
	// The ffmpeg grant is the operator's TTK_FFMPEG or the inert placeholder, never a PATH find.
	assertEquals(serveFfmpegGrant(undefined), NO_FFMPEG_SENTINEL);
	assertEquals(serveFfmpegGrant('C:\\tools\\ffmpeg.exe'), 'C:/tools/ffmpeg.exe');
	assertEquals(serveFfmpegGrant('/opt/a,b/ffmpeg'), NO_FFMPEG_SENTINEL, 'a comma cannot be spelled in a grant list');
});
