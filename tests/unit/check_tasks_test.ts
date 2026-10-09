/**
 * The `deno.json` task gate (`scripts/check_tasks.ts`).
 *
 * The two positive cases are the shipped defects verbatim. A gate written after
 * the fact is worth only as much as its ability to fail on the original bug, so
 * that is what these assert — and then that the *fixed* table passes, which is
 * the property `deno task ok` depends on.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import {
	bareParens,
	checkTasks,
	deniesFfiFirst,
	envEntryCovers,
	MODEL_PROVIDERS_ENV_COPY,
	modelProvidersGrantViolations,
	OTEL_GATE_ENV_NAMES_COPY,
	OTEL_GATE_PRESTEP,
	otelGrantProblem,
	otelGrantViolations,
	permissionValues,
	substitutionOtelViolations,
	tasksOf,
	watchGateViolations,
} from '../../scripts/check_tasks.ts';
import { OTEL_GATE_ENV_NAMES } from '@tykotech/cli';
import { ENV_NAMES } from '@tykotech/gateway';
import { MODEL_PROVIDERS_ENV } from '../../packages/gateway/src/model_providers.ts';

/** Only the violations of one rule: the older rules' tests read their own rule, now that T5 (D-137) reports beside them. */
const only = (rule: string, violations: ReturnType<typeof checkTasks>) => violations.filter((v) => v.rule === rule);

Deno.test('T1: the doctor task as it shipped is a violation', () => {
	// E-29 verbatim. `deno task doctor` exited 127 and printed "X86: command not
	// found": the shell read `(X86)` as a subshell and cut the command in three.
	// T1 alone: the verbatim string also predates `--deny-ffi`, which T4 (E-103) now reports beside it.
	const violations = checkTasks({
		doctor: 'deno run --allow-read=. --allow-env=TTK_*,PROGRAMFILES(X86),PATH packages/cli/mod.ts doctor',
	}).filter((violation) => violation.rule === 'T1');
	assertEquals(violations.length, 2, 'one for each parenthesis');
	assertEquals(violations[0]?.rule, 'T1');
	assertStringIncludes(violations[0]?.detail ?? '', 'subshell');
});

Deno.test('T1: the same flag quoted is fine', () => {
	// Which is the fix, and also why the sibling `resolve:chromium` task always
	// worked while `doctor` never did — they differed only in the quoting.
	assertEquals(
		checkTasks({
			doctor: 'deno run --allow-read=. "--allow-env=TTK_*,PROGRAMFILES(X86),PATH" packages/cli/mod.ts doctor',
		}).filter((violation) => violation.rule === 'T1'),
		[],
	);
});

Deno.test('T1: a command substitution is not a bare parenthesis', () => {
	assertEquals(bareParens('deno test "--allow-read=$(deno task -q tier:paths --read)" tests/'), []);
	// Nested, and inside double quotes, both of which the tier tasks really use.
	assertEquals(bareParens('X="$(a || echo)" deno test "--allow-run=$(b --grant),$(c --ffmpeg)" t/'), []);
});

Deno.test('T1: single quotes hide parentheses too', () => {
	assertEquals(bareParens("deno run '--allow-env=PROGRAMFILES(X86)' x.ts"), []);
});

Deno.test('T2: the resolve:chromium task as it shipped is a violation', () => {
	// E-30 verbatim.
	const violations = checkTasks({
		'resolve:chromium': 'deno run "--allow-read=.,$LOCALAPPDATA,$PROGRAMFILES,$USERPROFILE,$HOME,/usr/bin" s.ts',
	});
	assertEquals(violations.length, 4, 'one per interpolated variable');
	assert(violations.every((violation) => violation.rule === 'T2'));
	assertStringIncludes(violations[0]?.detail ?? '', 'escaped comma');
});

Deno.test('T2: a computed grant substituted in is the sanctioned form', () => {
	assertEquals(
		checkTasks({ t: 'deno test "--allow-read=$(deno task -q tier:paths --read)" tests/e2e/' }),
		[],
	);
});

Deno.test("T2: an interpolation outside a permission flag is not this rule's business", () => {
	// `BUA_TEST_CHROMIUM="$(…)"` and friends are ordinary and safe: a variable
	// assignment has no comma-separated list to corrupt.
	assertEquals(checkTasks({ t: 'FOO=$BAR deno run --allow-read=. x.ts' }), []);
});

Deno.test('permissionValues reads the value up to the flag boundary', () => {
	const values = permissionValues('deno test --allow-net=127.0.0.1,localhost "--allow-read=$(x --read)" t/');
	assertEquals(values.length, 2);
	assertEquals(values[0], { flag: '--allow-net', value: '127.0.0.1,localhost' });
	assertEquals(values[1]?.value, '$(x --read)');
});

Deno.test('T3: a shipped surface may not hold an unscoped permission', () => {
	// `--deny-ffi` leads each command so T4 (E-103) stays quiet, and T5 (D-137) is filtered out: this test reads T3.
	for (
		const command of [
			'deno run --deny-ffi -A m.ts serve',
			'deno run --deny-ffi --allow-run m.ts serve',
			'deno run --deny-ffi --allow-env m.ts',
		]
	) {
		const violations = only('T3', checkTasks({ dev: command }));
		assertEquals(violations.length, 1, command);
		assertEquals(violations[0]?.rule, 'T3');
	}
});

Deno.test('T3: tooling tasks are not shipped surfaces', () => {
	// `compile` really does use `-A`, and that is a decision rather than a slip:
	// it drives `deno compile`, which needs the whole toolchain. The rule names
	// the four tasks a deployment actually runs, so it stays enforceable.
	assertEquals(checkTasks({ compile: 'deno run -A scripts/compile.ts' }), []);
});

Deno.test('T3: a scoped grant on a shipped surface passes', () => {
	assertEquals(
		only(
			'T3',
			checkTasks({ stdio: 'deno run --deny-ffi --allow-net=127.0.0.1 --allow-read=. --allow-env=TTK_* m.ts stdio' }),
		),
		[],
	);
});

// --- T4 (E-103): `--deny-ffi` before the first grant on every shipped surface ---------------------------------------

/** The `stdio` and `doctor` tasks as they shipped at 0d00ab7, verbatim: neither denied FFI. */
const SHIPPED_WITHOUT_DENY = {
	stdio: 'TTK_BROWSER_PATH="$(deno task -q resolve:chromium --pin --serve || echo)" deno run --no-prompt ' +
		'--allow-net=127.0.0.1 "--allow-read=.,$(deno task -q tier:paths --write),$(deno task -q resolve:chromium ' +
		'--grant --serve || echo ttk-tier/no-chromium-resolved)" "--allow-write=$(deno task -q tier:paths --write)" ' +
		'"--allow-run=$(deno task -q resolve:chromium --grant --serve || echo ttk-tier/no-chromium-resolved),' +
		'$(deno task -q tier:paths --serve-ffmpeg || echo ttk-tier/no-ffmpeg-resolved)" ' +
		'--allow-env=TTK_*,HOME,USERPROFILE,LOCALAPPDATA,PROGRAMFILES,PATH packages/cli/mod.ts stdio',
	doctor: 'deno run "--allow-read=.,$(deno task -q chromium:read || echo .)" --allow-write=secrets ' +
		'"--allow-env=TTK_*,HOME,USERPROFILE,LOCALAPPDATA,PROGRAMFILES,PROGRAMFILES(X86),PATH" packages/cli/mod.ts doctor',
};

Deno.test('T4: the stdio and doctor tasks as they shipped are violations', () => {
	const violations = only('T4', checkTasks(SHIPPED_WITHOUT_DENY));
	assertEquals(violations.map((violation) => [violation.task, violation.rule]), [['stdio', 'T4'], ['doctor', 'T4']]);
	assertStringIncludes(violations[0]?.detail ?? '', '--deny-ffi');
});

Deno.test('T4: --deny-ffi after a grant is still a violation, before every grant is not', () => {
	assertEquals(deniesFfiFirst('deno run --allow-net=127.0.0.1 --deny-ffi m.ts'), false);
	assertEquals(deniesFfiFirst('deno run --deny-ffi --allow-net=127.0.0.1 m.ts'), true);
	assertEquals(deniesFfiFirst('deno run --no-prompt --deny-ffi --unstable-kv "--allow-read=." m.ts'), true);
	// A look-alike flag is not the deny.
	assertEquals(deniesFfiFirst('deno run --deny-ffi-x --allow-read=. m.ts'), false);
	// No grant at all holds no FFI either.
	assertEquals(deniesFfiFirst('deno run m.ts'), true);
	assertEquals(checkTasks({ dev: 'deno run --allow-read=. --deny-ffi m.ts serve' })[0]?.rule, 'T4');
});

Deno.test('T4: tooling tasks are not held to it', () => {
	assertEquals(checkTasks({ 'build:web': 'deno run --allow-read=packages/web scripts/build_icons.ts' }), []);
});

Deno.test('T4: every shipped task in deno.json denies FFI first', async () => {
	const tasks = tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));
	for (const name of ['dev', 'stdio', 'acp', 'serve:cluster', 'doctor', 'admin:generate', 'setup', 'seed']) {
		const command = tasks[name];
		assert(command !== undefined, `${name} exists`);
		assert(deniesFfiFirst(command), `${name}: --deny-ffi must precede its first --allow-*`);
	}
});

// --- R3-2: T4 per `deno run|test|serve` invocation, up to its script path ---------------------------------------------

/** `admin:generate` as it shipped at 4b15048, verbatim: it runs the doctor and denied no FFI. */
const ADMIN_GENERATE_AS_SHIPPED = 'deno run --allow-read=. --allow-write=secrets ' +
	'"--allow-env=TTK_*,HOME,USERPROFILE,LOCALAPPDATA,PROGRAMFILES,PROGRAMFILES(X86),PATH" packages/cli/mod.ts doctor ' +
	'--new-admin admin';

Deno.test('R3-2 T4: admin:generate is a shipped surface, and as it shipped it is a violation', () => {
	// Held to T4 only if the gate counts it shipped: a tooling task with the same string passes.
	assertEquals(
		only('T4', checkTasks({ 'admin:generate': ADMIN_GENERATE_AS_SHIPPED })).map((violation) => violation.rule),
		['T4'],
	);
	assertEquals(checkTasks({ 'some:tool': ADMIN_GENERATE_AS_SHIPPED }), []);
});

Deno.test('R3-2 T4: a --deny-ffi that belongs to another invocation, or follows the script, does not count', () => {
	// The reviewer's three shapes. Each held a --deny-ffi ahead of the first --allow-* in the string, which was all
	// the whole-string search asked; none of them denies FFI to the invocation that holds the grant.
	const crafted = {
		// An earlier `&&` step.
		'earlier step': 'deno run --deny-ffi scripts/a.ts && deno run --allow-read=. packages/cli/mod.ts serve',
		// Inside a command substitution, which is a process of its own.
		substitution: 'X="$(deno run --deny-ffi scripts/a.ts)" deno run --allow-read=. packages/cli/mod.ts serve',
		// After the script path, where it is the script's argument, not Deno's flag.
		'after the script': 'deno run scripts/a.ts --deny-ffi; deno run --allow-net=127.0.0.1 packages/cli/mod.ts serve',
		// After the script path and a grant in a substitution beside it.
		'after the script, grant nested': 'deno run m.ts --deny-ffi "$(deno run --allow-read=. y.ts)"',
	};
	for (const [shape, command] of Object.entries(crafted)) {
		assertEquals(deniesFfiFirst(command), false, shape);
		assertEquals(only('T4', checkTasks({ dev: command })).map((violation) => violation.rule), ['T4'], shape);
	}
	// A grant after the script path is the script's argument and holds nothing.
	assertEquals(deniesFfiFirst('deno run m.ts --allow-read=.'), true);
	// Every deno invocation in the command answers for itself: both deny, so it passes.
	assertEquals(
		deniesFfiFirst('deno run --deny-ffi --allow-read=. a.ts && deno test --deny-ffi --allow-net=127.0.0.1 t/'),
		true,
	);
	// A grant in a substitution is held by that substitution's process: it must deny FFI too.
	assertEquals(deniesFfiFirst('deno run --deny-ffi "--allow-read=$(deno run --allow-env y.ts)" m.ts'), false);
	assertEquals(deniesFfiFirst('deno run --deny-ffi "--allow-read=$(deno run --deny-ffi --allow-env y.ts)" m.ts'), true);
	// A substitution nested in a quoted substitution is found too, and the text after it is still read.
	assertEquals(deniesFfiFirst('X="$(a "$(deno run --allow-read=. y.ts)")" deno run --deny-ffi m.ts'), false);
	assertEquals(deniesFfiFirst('X="$(a "$(b)" \')\')" deno run --allow-read=. m.ts'), false);
	// `deno serve` is held to it as well; `deno task` names another task, which the gate reads on its own.
	assertEquals(deniesFfiFirst('deno serve --allow-net=127.0.0.1 m.ts'), false);
	assertEquals(deniesFfiFirst('deno task -q x --allow-read=.'), true);
});

Deno.test('R3-2 T4: short permission flags are grants, and a scoped --deny-ffi= is not the deny', () => {
	for (const command of ['deno run -A m.ts', 'deno run -R m.ts', 'deno run -RN m.ts', 'deno test -P t/']) {
		assertEquals(deniesFfiFirst(command), false, command);
	}
	assertEquals(deniesFfiFirst('deno run --deny-ffi -A m.ts'), true);
	assertEquals(deniesFfiFirst('deno run --deny-ffi=./lib.so --allow-read=. m.ts'), false);
	// A flag that takes its value in the next word does not end the flags early: the grant after it still counts.
	assertEquals(deniesFfiFirst('deno run --config deno.json --allow-read=. m.ts'), false);
	assertEquals(deniesFfiFirst('deno run -c deno.json --deny-ffi --allow-read=. m.ts'), true);
});

Deno.test('tasksOf accepts the object form as well as the string form', () => {
	assertEquals(
		tasksOf({ tasks: { a: 'deno run a.ts', b: { command: 'deno run b.ts', dependencies: ['a'] }, c: {} } }),
		{ a: 'deno run a.ts', b: 'deno run b.ts' },
	);
});

Deno.test('the shipped deno.json passes its own gate', async () => {
	// The gate runs in `deno task ok`; this is the same assertion, so a table
	// edit that breaks it fails here too rather than only in CI.
	const config = JSON.parse(await Deno.readTextFile('deno.json'));
	const tasks = tasksOf(config);
	assert(Object.keys(tasks).length > 20, 'the task table should be fully readable');
	assertEquals(checkTasks(tasks), []);
});

// --- T5 (D-137): the six OTEL_* names on every shipped surface, and nothing wider -------------------------------------

const SIX = OTEL_GATE_ENV_NAMES_COPY.join(',');

Deno.test('T5 (D-137): the copied list is the gate list itself', () => {
	assertEquals([...OTEL_GATE_ENV_NAMES_COPY], [...OTEL_GATE_ENV_NAMES]);
	assertEquals(OTEL_GATE_ENV_NAMES_COPY.length, 6);
});

Deno.test('T5 (D-137): every shipped task as it stood at S0 lacks the six names', async () => {
	// Red before green: the S0 table, verbatim for these six tasks, granted only TTK_* and the platform names.
	const table = tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));
	const shipped = ['dev', 'stdio', 'acp', 'serve:cluster', 'doctor', 'admin:generate'];
	// The SEC-1W gate pre-step did not exist at S0 either; this test reads only the grant ("lacks") half of T5.
	const asAtS0 = Object.fromEntries(
		shipped.map((name) => [name, table[name]!.replace(`${OTEL_GATE_PRESTEP} && `, '').replace(`,${SIX}`, '')]),
	);
	const violations = only('T5', checkTasks(asAtS0)).filter((violation) => violation.detail.includes('lacks'));
	assertEquals(violations.map((violation) => violation.task).sort(), [...shipped].sort());
	for (const violation of violations) assertStringIncludes(violation.detail, 'lacks OTEL_DENO, OTEL_DENO_VSOCK');
});

Deno.test('T5 (D-137): the six granted and nothing else OTEL passes; a seventh name or a wildcard does not', () => {
	assertEquals(otelGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${SIX} m.ts`), []);
	// Quoted, as the doctor tasks quote theirs.
	assertEquals(otelGrantViolations(`deno run --deny-ffi "--allow-env=TTK_*,PROGRAMFILES(X86),${SIX}" m.ts doctor`), []);
	for (
		const extra of [
			'OTEL_*',
			'OTEL_EXPORTER_*',
			'OTEL_EXPORTER_OTLP_*',
			'O*',
			'OT*',
			'OTEL*',
			'OTEL_EXPORTER_OTLP_HEADERS',
		]
	) {
		const problems = otelGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${SIX},${extra} m.ts`);
		assertEquals(problems.length, 1, `${extra}: ${problems.join('; ')}`);
		assert(otelGrantProblem(extra) !== null, extra);
	}
	for (const extra of ['OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'OTEL_EXPORTER_OTLP_CERTIFICATE', 'OTEL_SERVICE_NAME']) {
		assert(otelGrantProblem(extra) !== null, `${extra} is not one of the six`);
	}
	// A wildcard that cannot reach OTEL_ is not T5's business; T3 judges bare grants.
	assertEquals(otelGrantProblem('TTK_*'), null);
	assertEquals(otelGrantProblem('BUA_*'), null);
	// Missing one name, or no env grant at all, is a violation on a shipped surface.
	assertEquals(otelGrantViolations('deno run --deny-ffi --allow-env=TTK_*,OTEL_DENO m.ts').length, 1);
	assertEquals(otelGrantViolations('deno run --deny-ffi --allow-read=. m.ts').length, 1);
	// Tooling tasks are not shipped surfaces.
	assertEquals(checkTasks({ 'some:tool': 'deno run --allow-env=OTEL_* x.ts' }), []);
	assertEquals(only('T5', checkTasks({ dev: 'deno run --deny-ffi --allow-env=OTEL_*,TTK_* m.ts serve' })).length, 2);
});

// --- T5 (D-137, SEC-1): a grant-computing `$( … deno … )` substitution runs ungated, so it must not export ----------

Deno.test('T5 (D-137, SEC-1): a shipped substitution that runs deno without OTEL_DENO=false is a violation', () => {
	// SEC-1 (review, measured on Deno 2.9.7): `$(deno task -q tier:paths --write)` starts a Deno process before the
	// gated `packages/cli/mod.ts`, inherits `OTEL_DENO=true` and exports /v1/logs and /v1/metrics to whatever endpoint
	// is set — the off-list one included. `OTEL_DENO=false` turns that export off (probe leg H2).
	const bare = 'deno run --deny-ffi "--allow-read=.,$(deno task -q tier:paths --write)" ' +
		`--allow-env=TTK_*,${SIX} packages/cli/mod.ts serve`;
	const problems = substitutionOtelViolations(bare);
	assertEquals(problems.length, 1, problems.join('; '));
	assertStringIncludes(problems[0] ?? '', 'OTEL_DENO=false');
	assertEquals(only('T5', checkTasks({ dev: bare })).length, 1);
	// Blanked: passes.
	const blanked = bare.replace('$(deno task', '$(OTEL_DENO=false deno task');
	assertEquals(substitutionOtelViolations(blanked), []);
	assertEquals(only('T5', checkTasks({ dev: blanked })), []);
	// Only `false`: `true` exports, and an empty value, though off, makes Deno warn on every launch.
	for (const value of ['true', '', '0', 'FALSE ']) {
		assertEquals(substitutionOtelViolations(bare.replace('$(deno task', `$(OTEL_DENO=${value} deno task`)).length, 1);
	}
	// A substitution that runs no Deno (`$(echo x)`) is not this rule's business; nor is a tooling task.
	assertEquals(substitutionOtelViolations('deno run --deny-ffi "--allow-read=$(echo .)" m.ts'), []);
	assertEquals(only('T5', checkTasks({ 'some:tool': 'deno run "--allow-read=$(deno task -q x)" m.ts' })), []);
	// Every substitution in the command answers for itself: one blanked, one not, is one violation.
	const mixed = 'deno run --deny-ffi "--allow-read=$(OTEL_DENO=false deno task -q a),$(deno task -q b)" m.ts';
	assertEquals(substitutionOtelViolations(mixed).length, 1);
});

Deno.test('T5 (D-137, SEC-1): every grant substitution in the shipped deno.json is blanked', async () => {
	const table = tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));
	let judged = 0;
	for (const name of ['dev', 'stdio', 'acp', 'serve:cluster', 'doctor', 'admin:generate']) {
		const command = table[name]!;
		assertEquals(substitutionOtelViolations(command), [], name);
		judged += (command.match(/\$\(OTEL_DENO=false deno /g) ?? []).length;
	}
	// Non-vacuity: dev, stdio and serve:cluster carry six substitutions each, doctor one.
	assertEquals(judged, 19);
});

// --- T5 (D-137, SEC-1W): a shipped `--watch` runner is the gated module's own process, so the gate runs first ------

Deno.test('T5 (D-137, SEC-1W): a shipped --watch task must start with the gate pre-step, joined by &&', () => {
	// SEC-1W (review re-verification, measured on Deno 2.9.7): under `deno run --watch` the gated module runs inside the
	// watcher's own process, and the watcher logs "Watcher Process started." / "… finished …" through the OTLP exporter
	// around the gate — one record to an off-list collector. `OTEL_DENO` is read once per process, so the only place
	// to judge is before the watcher starts: `packages/cli/gate.ts`, with `&&` so a refusal ends the task.
	const watch = `deno run --watch --no-prompt --deny-ffi --allow-env=TTK_*,${SIX} packages/cli/mod.ts serve`;
	const bare = watchGateViolations(watch);
	assertEquals(bare.length, 1, bare.join('; '));
	assertStringIncludes(bare[0] ?? '', 'packages/cli/gate.ts');
	assertEquals(only('T5', checkTasks({ dev: watch })).length, 1);
	const gated = `${OTEL_GATE_PRESTEP} && ${watch}`;
	assertEquals(watchGateViolations(gated), []);
	assertEquals(only('T5', checkTasks({ dev: gated })), []);
	// `;` and `||` do not stop the chain on a refusal (measured: `;` runs the next step and the task exits 0).
	for (const join of [' ; ', ' || ']) {
		assertEquals(watchGateViolations(`${OTEL_GATE_PRESTEP}${join}${watch}`).length, 1, join);
	}
	// The pre-step must be the exact one: another script, or a grant missing a name, is not the gate.
	assertEquals(
		watchGateViolations(`deno run --deny-ffi --allow-env=${SIX} packages/cli/other.ts && ${watch}`).length,
		1,
	);
	// No --watch, no pre-step needed; tooling tasks are not shipped surfaces.
	assertEquals(watchGateViolations(`deno run --deny-ffi --allow-env=TTK_*,${SIX} packages/cli/mod.ts stdio`), []);
	assertEquals(only('T5', checkTasks({ 'some:tool': 'deno run --watch x.ts' })), []);
	// The pre-step itself passes T3, T4 and T5's grant rule.
	assertEquals(
		checkTasks({ doctor: `${OTEL_GATE_PRESTEP} && deno run --deny-ffi --allow-env=TTK_*,${SIX} m.ts doctor` }),
		[],
	);
});

Deno.test('T5 (D-137, SEC-1W): the shipped dev task starts with the gate pre-step', async () => {
	const table = tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));
	assert(table.dev!.includes('--watch'), 'dev is the --watch task');
	assert(table.dev!.startsWith(`${OTEL_GATE_PRESTEP} && `), 'dev judges OTLP before the watcher starts');
	assertEquals(watchGateViolations(table.dev!), []);
	// Only dev runs a watcher; the other shipped tasks need no pre-step.
	for (const name of ['stdio', 'acp', 'serve:cluster', 'doctor', 'admin:generate']) {
		assertFalse(table[name]!.includes('--watch'), name);
	}
});

// --- T6 (D-143 / D-145): the providers-file variable under every shipped --allow-env, and no key variable there -------

Deno.test('T6 (D-143): the copied name is the gateway’s', () => {
	assertEquals(MODEL_PROVIDERS_ENV_COPY, MODEL_PROVIDERS_ENV);
	assert((ENV_NAMES as readonly string[]).includes(MODEL_PROVIDERS_ENV_COPY), 'the gateway declares it in ENV_NAMES');
});

Deno.test('T6 (D-143): the shipped deno.json passes', async () => {
	const table = tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));
	for (const name of ['dev', 'stdio', 'acp', 'serve:cluster', 'doctor', 'admin:generate']) {
		assertEquals(modelProvidersGrantViolations(table[name]!), [], name);
	}
	assertEquals(only('T6', checkTasks(table)), []);
	// Non-vacuity: every shipped task covers the name through `TTK_*` today; by name would pass too.
	assert(envEntryCovers('TTK_*', MODEL_PROVIDERS_ENV_COPY));
	assert(envEntryCovers(MODEL_PROVIDERS_ENV_COPY, MODEL_PROVIDERS_ENV_COPY));
	assertFalse(envEntryCovers('TTK_MODEL_*_FILE', MODEL_PROVIDERS_ENV_COPY), 'only a trailing wildcard covers');
	assertFalse(envEntryCovers('OTEL_*', MODEL_PROVIDERS_ENV_COPY));
	assertFalse(envEntryCovers('TTK_MODEL_PROVIDERS', MODEL_PROVIDERS_ENV_COPY));
});

Deno.test('T6 (D-145): a shipped task naming ANTHROPIC_API_KEY is a violation; the test-only tasks are not shipped', () => {
	const keyed = `deno run --deny-ffi --allow-env=TTK_*,${SIX},ANTHROPIC_API_KEY packages/cli/mod.ts serve`;
	const violations = only('T6', checkTasks({ dev: keyed }));
	assertEquals(violations.length, 1, violations.map((v) => v.detail).join('; '));
	assertStringIncludes(violations[0]?.detail ?? '', 'ANTHROPIC_API_KEY');
	assertStringIncludes(violations[0]?.detail ?? '', 'never in the environment');
	// Every spelling the rule names: `*_API_KEY`, `OPENAI*`, `ANTHROPIC*`, case-insensitively.
	for (const extra of ['OPENAI_API_KEY', 'TTK_MODEL_API_KEY', 'openai_base_url', 'ANTHROPIC_BASE_URL', 'X_API_KEY']) {
		assertEquals(
			modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${SIX},${extra} m.ts`).length,
			1,
			extra,
		);
	}
	// B4: the gateway's own key store, granted by name, is not a provider key — `_API_KEY` is anchored to the end of
	// the name, so `TTK_API_KEYS` and `TTK_API_KEYS_FILE` pass where the design's bare substring match flagged them.
	for (const own of ['TTK_API_KEYS', 'TTK_API_KEYS_FILE', 'TTK_API_KEYS_REF']) {
		assertEquals(
			modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${own},${SIX} m.ts`),
			[],
			own,
		);
	}
	// A grant that covers the name neither by wildcard nor by name is the other half of the rule.
	const uncovered = modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_HOST,${SIX} m.ts`);
	assertEquals(uncovered.length, 1);
	assertStringIncludes(uncovered[0] ?? '', MODEL_PROVIDERS_ENV_COPY);
	assertEquals(
		modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_HOST,${MODEL_PROVIDERS_ENV_COPY},${SIX} m.ts`),
		[],
	);
	// A helper substitution is not the gateway process: it need not cover the file, but it may not name a key either.
	const helper = (grant: string): string =>
		`deno run --deny-ffi "--allow-read=$(OTEL_DENO=false deno run --allow-env=${grant} x.ts)" ` +
		`--allow-env=TTK_*,${SIX} m.ts`;
	assertEquals(modelProvidersGrantViolations(helper('TMPDIR,PATH')), []);
	// B4: each of the three blanked names, named inside the substitution, is caught there, not only at the top level.
	for (const name of ['TTK_MODEL_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
		const violations = modelProvidersGrantViolations(helper(name));
		assertEquals(violations.length, 1, name);
		assertStringIncludes(violations[0] ?? '', name);
	}
	// The SEC-1W gate pre-step reads its seven names only (T5 pins its exact text); it is not held to the coverage half.
	assertEquals(
		modelProvidersGrantViolations(`${OTEL_GATE_PRESTEP} && deno run --deny-ffi --allow-env=TTK_*,${SIX} m.ts`),
		[],
	);
	assertEquals(
		modelProvidersGrantViolations(`${OTEL_GATE_PRESTEP} && deno run --deny-ffi --allow-env=TTK_HOST,${SIX} m.ts`)
			.length,
		1,
		'the gateway process after the pre-step is still judged',
	);
	// `tier:paths` and `test:browser` name key variables and are tooling, not shipped surfaces.
	assertEquals(checkTasks({ 'tier:paths': 'deno run --allow-env=TTK_MODEL_API_KEY,ANTHROPIC_API_KEY,PATH s.ts' }), []);
	assertEquals(checkTasks({ 'test:browser': `deno test --allow-env=TTK_*,ANTHROPIC_API_KEY tests/e2e/` }), []);
	// No `--allow-env=` at all is T5's violation, not repeated by T6.
	assertEquals(modelProvidersGrantViolations('deno run --deny-ffi --allow-read=. m.ts'), []);
});

Deno.test('T6 (D-145, B4): a shipped task that sets a provider-key variable inline is a violation', async () => {
	// The serve tasks' own shape, `TTK_BROWSER_PATH="$(…)" deno run …`, is a path, not a key: fine.
	const serve = (prefix: string): string =>
		`${prefix}deno run --deny-ffi --allow-net=127.0.0.1 --allow-env=TTK_*,${SIX} packages/cli/mod.ts serve`;
	assertEquals(modelProvidersGrantViolations(serve('TTK_BROWSER_PATH="$(deno task -q resolve:chromium --pin)" ')), []);
	assertEquals(modelProvidersGrantViolations(serve('OTEL_DENO=false ')), []);
	// Each blanked name, and the generic `*_API_KEY` spelling, set in front of the gateway: one violation naming it.
	for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TTK_MODEL_API_KEY', 'X_API_KEY']) {
		const violations = modelProvidersGrantViolations(serve(`${name}="$(cat key)" `));
		assertEquals(violations.length, 1, name);
		assertStringIncludes(violations[0] ?? '', `${name} is set inline`);
		assertEquals(only('T6', checkTasks({ stdio: serve(`${name}=x `) })).length, 1, `${name} through checkTasks`);
	}
	// Inside a helper substitution too — a helper is a process whose environment the key would enter all the same.
	const nested = `deno run --deny-ffi "--allow-read=$(OPENAI_API_KEY=x deno run --allow-env=PATH x.ts)" ` +
		`--allow-env=TTK_*,${SIX} m.ts`;
	assertEquals(modelProvidersGrantViolations(nested).length, 1);
	// Only the leading run is an environment prefix: `--allow-env=` words and script paths never read as assignments,
	// and a word after the command (`deno run x.ts OPENAI_API_KEY=x`) is an argument, which no shipped task passes.
	assertEquals(modelProvidersGrantViolations(`deno run --allow-env=TTK_*,${SIX} m.ts OPENAI_API_KEY=x`), []);
	// The test-only tasks stay exempt from the rule as a whole.
	assertEquals(checkTasks({ 'test:browser': `ANTHROPIC_API_KEY=x deno test --allow-env=TTK_* tests/e2e/` }), []);
	// Non-vacuity on the shipped table: every shipped task's prefixes are paths or OTEL_DENO=false, never a key.
	const table = tasksOf(JSON.parse(await Deno.readTextFile('deno.json')));
	assertEquals(only('T6', checkTasks(table)), []);
	assert(table.dev!.includes('TTK_BROWSER_PATH="$('), 'the serve tasks really carry an inline prefix');
});
