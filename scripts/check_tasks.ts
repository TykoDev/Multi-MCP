/**
 * @module
 * The `deno.json` task gate.
 *
 * [COMPLETIONS-CRITERIA.md](../SPECS/COMPLETIONS-CRITERIA.md) §0 has listed a
 * "permission gate" among the standing gates since M1. It did not exist. Two
 * defects then shipped in the task table itself, both of the kind a five-line
 * check catches and no amount of reading catches reliably:
 *
 *  - **E-29** — `deno task doctor` never ran. Its `--allow-env=` value was
 *    unquoted and contained `PROGRAMFILES(X86)`; the task shell reads `(…)` as
 *    a subshell, so the command was cut in three and `deno run` was invoked
 *    with no script. Exit 127, and the key-generation command in
 *    `secrets/README.md` and in the README's five-minute path could not work.
 *  - **E-30** — `deno task resolve:chromium` interpolated four environment
 *    variables straight into `--allow-read=`. Unset variables leave adjacent
 *    commas, and Deno reads `,,` as an *escaped comma*, so the paths on either
 *    side are silently welded into one that cannot exist.
 *
 * Both are invisible in review — the strings look right — and both are trivial
 * to detect mechanically. Hence this.
 *
 * Run: `deno run --allow-read=deno.json scripts/check_tasks.ts`
 */

/**
 * A task that must not hold an unscoped permission: these are shipped surfaces, not tooling. R3-2: `admin:generate`
 * runs the doctor, as `doctor` does, so it is held to the same rules.
 */
const SHIPPED_TASKS = ['dev', 'stdio', 'acp', 'serve:cluster', 'doctor', 'admin:generate', 'setup', 'seed'] as const;

/** Permission flags that are meaningless-but-total when given without a value. */
const SCOPABLE = ['run', 'env', 'net', 'read', 'write', 'ffi', 'sys', 'import'] as const;

export interface Violation {
	readonly task: string;
	readonly rule: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';
	readonly detail: string;
}

/**
 * Positions of parentheses the task shell will read as syntax.
 *
 * `$( … )` is legitimate — it is how the tier tasks compute their grants — so
 * only parentheses that are neither quoted nor part of a substitution count.
 * Tracking quote state is what separates `PROGRAMFILES(X86)` inside a quoted
 * flag (fine) from the same text bare (three commands).
 */
export function bareParens(command: string): number[] {
	const found: number[] = [];
	let single = false;
	let double = false;
	let substitutions = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === '\\' && double) {
			i++; // an escaped character inside double quotes is literal
			continue;
		}
		if (ch === "'" && !double) {
			single = !single;
			continue;
		}
		if (ch === '"' && !single) {
			double = !double;
			continue;
		}
		if (single) continue;

		// `$(` opens a substitution in unquoted text and inside double quotes alike.
		if (ch === '$' && command[i + 1] === '(') {
			substitutions++;
			i++;
			continue;
		}
		if (double) continue;

		if (ch === ')' && substitutions > 0) {
			substitutions--;
			continue;
		}
		if (ch === '(' || ch === ')') found.push(i);
	}
	return found;
}

/** Every `--allow-x=…` / `--deny-x=…` value in a command, with the flag that carried it. */
export function permissionValues(command: string): Array<{ flag: string; value: string }> {
	const out: Array<{ flag: string; value: string }> = [];
	const pattern = /--(?:allow|deny)-[a-z-]+=/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(command)) !== null) {
		const start = match.index + match[0].length;
		// The value runs to the first unescaped whitespace or quote that closes it.
		let end = start;
		let depth = 0;
		while (end < command.length) {
			const ch = command[end];
			if (ch === '$' && command[end + 1] === '(') depth++;
			else if (ch === ')' && depth > 0) depth--;
			else if (depth === 0 && (ch === ' ' || ch === '"' || ch === "'" || ch === '\t')) break;
			end++;
		}
		out.push({ flag: match[0].slice(0, -1), value: command.slice(start, end) });
	}
	return out;
}

/** A bare `$IDENT` expansion, which is the E-30 hazard. `$(…)` is not one. */
function interpolations(value: string): string[] {
	return [...value.matchAll(/\$(?!\()([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[0]);
}

/** Unscoped permission flags in a command: `--allow-run` with no `=`, or `-A`. */
function unscoped(command: string): string[] {
	const found: string[] = [];
	if (/(?:^|\s)-A(?:\s|$)/.test(command) || /--allow-all(?:\s|$)/.test(command)) found.push('-A');
	for (const name of SCOPABLE) {
		if (new RegExp(`--allow-${name}(?![=\\w-])`).test(command)) found.push(`--allow-${name}`);
	}
	return found;
}

/**
 * The simple commands of a task-shell command line, each as its words with the quotes taken off.
 *
 * `&&`, `||`, `;`, `|`, `&`, newlines and bare parentheses end a command. Every `$( … )` is a process of its own: its
 * text is read as a command line in turn (its commands come first in the result), and in the word that held it a
 * placeholder stands in, so `"--allow-read=$(…)"` is still one `--allow-read=` word. Backslash escapes the next
 * character outside single quotes. Enough of the shell to find every Deno invocation and its flags; nothing runs.
 */
export function simpleCommands(command: string): string[][] {
	const commands: string[][] = [];
	/**
	 * The index of the `)` that closes the substitution whose `(` is at `open`, or the end of the text. A substitution
	 * starts a quoting context of its own, so one nested inside it (quoted or not) is skipped whole.
	 */
	const closing = (text: string, open: number): number => {
		let depth = 0;
		let single = false;
		let double = false;
		for (let i = open; i < text.length; i++) {
			const ch = text[i];
			if (single) {
				if (ch === "'") single = false;
				continue;
			}
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '$' && text[i + 1] === '(') {
				i = closing(text, i + 1);
				continue;
			}
			if (ch === "'" && !double) single = true;
			else if (ch === '"') double = !double;
			else if (double) continue;
			else if (ch === '(') depth++;
			else if (ch === ')' && --depth === 0) return i;
		}
		return text.length;
	};
	const walk = (text: string): void => {
		let words: string[] = [];
		let word = '';
		let started = false;
		let single = false;
		let double = false;
		const endWord = (): void => {
			if (started) words.push(word);
			word = '';
			started = false;
		};
		const endCommand = (): void => {
			endWord();
			if (words.length > 0) commands.push(words);
			words = [];
		};
		for (let i = 0; i < text.length; i++) {
			const ch = text[i]!;
			if (single) {
				if (ch === "'") single = false;
				else word += ch;
				continue;
			}
			if (ch === '\\' && i + 1 < text.length) {
				word += text[++i];
				started = true;
				continue;
			}
			if (ch === '$' && text[i + 1] === '(') {
				const end = closing(text, i + 1);
				walk(text.slice(i + 2, end));
				word += '$(…)';
				started = true;
				i = end;
				continue;
			}
			if (double) {
				if (ch === '"') double = false;
				else word += ch;
				continue;
			}
			if (ch === "'" || ch === '"') {
				if (ch === "'") single = true;
				else double = true;
				started = true;
			} else if (ch === ' ' || ch === '\t') endWord();
			else if ('\n;&|()'.includes(ch)) endCommand();
			else {
				word += ch;
				started = true;
			}
		}
		endCommand();
	};
	walk(command);
	return commands;
}

/** Deno subcommands that run a program with the flags before its script path. */
const RUNNERS = new Set(['run', 'test', 'serve']);
/** Deno flags whose value may be the next word; that word is the flag's, not the script path. */
const VALUE_FLAGS = new Set([
	'-c',
	'--config',
	'--import-map',
	'--lock',
	'--cert',
	'--location',
	'--seed',
	'--ext',
	'--filter',
	'-L',
	'--log-level',
	'--reporter',
	'--junit-path',
	'--preload',
	'--require',
	'--port',
	'--host',
]);

/** Whether one word grants a permission: `--allow-*`, `--permission-set`, or a short form (`-A -R -W -N -E -S -I -P`). */
function grants(word: string): boolean {
	if (word.startsWith('--allow-') || word === '--permission-set' || word.startsWith('--permission-set=')) return true;
	return /^-[A-Za-z]*[ARWNESIP][A-Za-z]*(?:=.*)?$/.test(word);
}

/**
 * Whether one simple command, if it runs a Deno program, denies FFI before its first grant. Only the flags before the
 * script path are Deno's: what follows is the program's arguments, grants and denials alike.
 */
function invocationDeniesFfiFirst(words: readonly string[]): boolean {
	let at = 0;
	while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++; // `NAME=value deno …`
	const program = words[at]?.split(/[\\/]/).at(-1)?.toLowerCase();
	if (program !== 'deno' && program !== 'deno.exe') return true;
	const next = words[at + 1] ?? '';
	if (RUNNERS.has(next)) at += 2;
	// `deno [flags] main.ts` is `deno run`; any other subcommand (`task`, `fmt`, `compile`, …) runs no program here.
	else if (next.startsWith('-') || /\.[cm]?[jt]sx?$/.test(next)) at += 1;
	else return true;
	let denied = false;
	for (; at < words.length; at++) {
		const word = words[at]!;
		if (word === '--' || !word.startsWith('-') || word === '-') break; // the script path: the flags end here
		if (word === '--deny-ffi') denied = true;
		else if (grants(word)) return denied;
		else if (VALUE_FLAGS.has(word)) at++;
	}
	return true;
}

/**
 * ERRATUM(E-103), rule T4: whether a shipped task's command denies FFI ahead of its first grant.
 *
 * `--deny-ffi` first is the matrix rule every image `CMD` and the compiled binaries already follow (a deny outranks
 * any later allow, and a reader sees it before the grants). `dev`, `stdio`, `serve:cluster` and `doctor` shipped
 * without it while `acp` and the tier tasks had it, and nothing noticed, because no gate read the task table for
 * it. A command that grants nothing (`deno run x.ts`) holds no FFI either and passes; `-A` is T3's business.
 *
 * R3-2: judged per Deno invocation. A search of the whole string let a `--deny-ffi` belonging to an earlier `&&`
 * step, to a `$( … )` substitution, or to the script's own arguments satisfy a grant that another process holds.
 * Every `deno run|test|serve` in the command, substitutions included, must deny FFI among its own flags — the words
 * before its script path — ahead of its first grant. A scoped `--deny-ffi=<path>` is not the deny.
 */
export function deniesFfiFirst(command: string): boolean {
	return simpleCommands(command).every(invocationDeniesFfiFirst);
}

/**
 * D-137, rule T5: the six `OTEL_*` names the CLI's egress gate reads (`packages/cli/otel_gate.ts`). A **copy** — this
 * script runs with `--allow-read=deno.json` and imports nothing from the packages — pinned equal to
 * `OTEL_GATE_ENV_NAMES` by `tests/unit/check_tasks_test.ts`.
 */
export const OTEL_GATE_ENV_NAMES_COPY = [
	'OTEL_DENO',
	'OTEL_DENO_VSOCK',
	'OTEL_EXPORTER_OTLP_ENDPOINT',
	'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
	'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
	'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/**
 * Why one `--allow-env` entry may not appear on a shipped surface, or `null` when it may (T5). An `OTEL`-prefixed grant
 * must be one of the six names exactly — `OTEL_EXPORTER_OTLP_HEADERS` and every `*_HEADERS`, `*_CERTIFICATE` or
 * `*_CLIENT_KEY` name carries a collector credential the process never reads — and a wildcard may not reach the
 * `OTEL_` prefix from either side (`OTEL_*`, `OTEL_EXPORTER_*`, `O*`). Anything naming `HEADERS` is refused outright.
 */
export function otelGrantProblem(entry: string): string | null {
	const name = entry.trim();
	if (/HEADERS/i.test(name)) return `${name} names a headers variable, which carries collector credentials`;
	if (name.endsWith('*')) {
		const prefix = name.slice(0, -1).toUpperCase();
		if (prefix.startsWith('OTEL') || 'OTEL_'.startsWith(prefix)) {
			return `${name} is a wildcard over OTEL_* names; grant the six names (D-137) explicitly`;
		}
		return null;
	}
	if (/^OTEL/i.test(name) && !(OTEL_GATE_ENV_NAMES_COPY as readonly string[]).includes(name)) {
		return `${name} is not one of the six OTEL_* names the egress gate reads (D-137)`;
	}
	return null;
}

/**
 * D-137, rule T5: every `--allow-env=` grant in a shipped task names all six `OTEL_*` names, and no other `OTEL` name
 * or wildcard (see {@linkcode otelGrantProblem}). A shipped task with no `--allow-env=` at all is a violation too: the
 * gate could not read a single name, and refuses to run while the runtime exports. Judged per word of each simple
 * command, so a grant inside a `$( … )` substitution answers for itself.
 */
export function otelGrantViolations(command: string): string[] {
	const problems: string[] = [];
	const grantsEnv = simpleCommands(command).flat().filter((word) => word.startsWith('--allow-env='));
	if (grantsEnv.length === 0) problems.push('no --allow-env= grant: the OpenTelemetry egress gate could read nothing');
	for (const word of grantsEnv) {
		const entries = word.slice('--allow-env='.length).split(',');
		const missing = OTEL_GATE_ENV_NAMES_COPY.filter((name) => !entries.includes(name));
		if (missing.length > 0) problems.push(`--allow-env= lacks ${missing.join(', ')} (D-137)`);
		for (const entry of entries) {
			const problem = otelGrantProblem(entry);
			if (problem !== null) problems.push(problem);
		}
	}
	return problems;
}

/**
 * The text inside every `$( … )` of a command line, outermost first and nested ones after, quoting-aware in the same
 * way as {@linkcode simpleCommands}: a substitution inside single quotes is literal text, not a process.
 */
export function substitutionBodies(command: string): string[] {
	const bodies: string[] = [];
	const scan = (text: string): void => {
		let single = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (single) {
				if (ch === "'") single = false;
				continue;
			}
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === "'") {
				single = true;
				continue;
			}
			if (ch === '$' && text[i + 1] === '(') {
				let depth = 0;
				let end = i + 1;
				for (let quote: string | null = null; end < text.length; end++) {
					const c = text[end];
					if (quote !== null) {
						if (c === quote) quote = null;
						continue;
					}
					if (c === "'" || c === '"') quote = c;
					else if (c === '(') depth++;
					else if (c === ')' && --depth === 0) break;
				}
				const body = text.slice(i + 2, end);
				bodies.push(body);
				scan(body);
				i = end;
			}
		}
	};
	scan(command);
	return bodies;
}

/**
 * D-137, rule T5 (SEC-1): a `$( … )` substitution that starts a Deno process runs **before** the gated
 * `packages/cli/mod.ts`, so the egress gate never judges it — and with `OTEL_DENO=true` inherited, Deno exports that
 * helper's logs and metrics to whatever endpoint is set, an off-list one included (measured, review SEC-1). Every Deno
 * invocation inside a shipped task's substitution must therefore carry an `OTEL_DENO=false` prefix, which Deno 2.9.7
 * reads as off and exports nothing (probe leg H2). An empty value is off too, but Deno warns "'OTEL_DENO' env var
 * value not recognized" on every launch, operators who never set OTEL_DENO included, so only `false` passes.
 */
export function substitutionOtelViolations(command: string): string[] {
	const problems: string[] = [];
	for (const body of substitutionBodies(command)) {
		for (const words of simpleCommands(body)) {
			let at = 0;
			let blanked = false;
			while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) {
				if (words[at] === 'OTEL_DENO=false') blanked = true;
				at++;
			}
			const program = words[at]?.split(/[\\/]/).at(-1)?.toLowerCase();
			if ((program === 'deno' || program === 'deno.exe') && !blanked) {
				problems.push(
					`$(${body.trim()}) starts Deno ahead of the egress gate without an OTEL_DENO=false prefix ` +
						'(D-137, SEC-1): it would export to any OTLP endpoint while OTEL_DENO=true',
				);
			}
		}
	}
	return problems;
}

/**
 * D-137, rule T5 (SEC-1W): the launcher pre-step that judges OTLP egress before a process the gate cannot reach.
 * `packages/cli/gate.ts` runs `enforceOtelEgress` alone; it reads `TTK_OTEL_ENDPOINTS` and the six names, nothing else.
 */
export const OTEL_GATE_PRESTEP = 'deno run --no-prompt --deny-ffi --allow-env=TTK_OTEL_ENDPOINTS,' +
	OTEL_GATE_ENV_NAMES_COPY.join(',') + ' packages/cli/gate.ts';

/**
 * D-137, rule T5 (SEC-1W): a shipped task that runs Deno under `--watch` must start with {@linkcode OTEL_GATE_PRESTEP}
 * joined by `&&`. Under `deno run --watch` the gated module runs inside the watcher's own process (measured, one pid),
 * and the watcher logs its "Watcher Process started." / "… finished …" lines through the OTLP exporter around the
 * module's gate — to an off-list collector included (review SEC-1W). `OTEL_DENO` is read once per process, so no
 * variable or grant can split the two: the gate has to run first, and only `&&` ends the task on its refusal (`;` runs
 * the next step and exits 0; `||` runs it only on a refusal).
 */
export function watchGateViolations(command: string): string[] {
	const watches = simpleCommands(command).some((words) => {
		let at = 0;
		while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++;
		const program = words[at]?.split(/[\\/]/).at(-1)?.toLowerCase();
		if (program !== 'deno' && program !== 'deno.exe') return false;
		return words.slice(at + 1).some((word) =>
			word === '--watch' || word.startsWith('--watch=') || word === '--watch-hmr'
		);
	});
	if (!watches) return [];
	if (command.startsWith(`${OTEL_GATE_PRESTEP} && `)) return [];
	return [
		'runs Deno under --watch without first running the egress gate (start the task with ' +
		`"${OTEL_GATE_PRESTEP} && "): the watcher shares the gated module's process and exports around it (D-137, SEC-1W)`,
	];
}

/**
 * D-143 / D-145, rule T6: the providers-file variable the gateway reads (`MODEL_PROVIDERS_ENV` in
 * `packages/gateway/src/model_providers.ts`). A **copy**, as {@linkcode OTEL_GATE_ENV_NAMES_COPY} is — this script
 * imports nothing from the packages — pinned equal to the gateway's name by `tests/unit/check_tasks_test.ts`.
 */
export const MODEL_PROVIDERS_ENV_COPY = 'TTK_MODEL_PROVIDERS_FILE';

/**
 * D-143 / D-145, rule T6: a provider key lives in the providers file and nowhere else. A shipped task that granted a
 * named key variable — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TTK_MODEL_API_KEY` or any `*_API_KEY` — would let the
 * gateway (and, through `/proc/self/environ`, Chromium) read a key the file discipline exists to keep out of the
 * environment. The test-only `tier:paths` and `test:browser` tasks name such variables and are not shipped surfaces.
 *
 * `_API_KEY` is anchored to the end of the name (B4): the design's bare `/(_API_KEY|…)/` also matched
 * `TTK_API_KEYS` and `TTK_API_KEYS_FILE`, the gateway's own key store, so a shipped task granting that `*_FILE`
 * twin by name was a false violation. Exported so `tests/unit/images_test.ts` judges the image grants by the same
 * spelling.
 */
export const PROVIDER_KEY_VARIABLE = /(_API_KEY$|OPENAI|ANTHROPIC)/i;
const KEY_VARIABLE = PROVIDER_KEY_VARIABLE;

/** Whether one `--allow-env` entry covers `name`: the name itself, or a wildcard whose prefix the name starts with. */
export function envEntryCovers(entry: string, name: string): boolean {
	const trimmed = entry.trim();
	if (trimmed === name) return true;
	return trimmed.endsWith('*') && name.startsWith(trimmed.slice(0, -1));
}

/**
 * D-143 / D-145, rule T6, two halves. (1) Every `--allow-env=` grant of a process that runs the gateway or the doctor
 * — a top-level Deno invocation of a shipped task — covers {@linkcode MODEL_PROVIDERS_ENV_COPY}, by name or by a
 * wildcard such as `TTK_*`; the SEC-1W gate pre-step (`packages/cli/gate.ts`, which reads only `TTK_OTEL_ENDPOINTS`
 * and the six names, pinned by {@linkcode OTEL_GATE_PRESTEP}) and the grant-computing `$( … )` helpers are not that
 * process and are not held to it. (2) No `--allow-env=` entry anywhere in the task — helpers and pre-step included —
 * names a provider-key variable ({@linkcode KEY_VARIABLE}), and no command in the task *sets* one inline
 * (`OPENAI_API_KEY=… deno run …`, the `TTK_BROWSER_PATH="$(…)" deno run` shape the serve tasks use for a path): a
 * grant lets the gateway read a key, an inline assignment puts one in its environment and, before D-143 blanked the
 * three names, in Chromium's. A task with no `--allow-env=` at all is T5's violation already, not repeated here.
 */
export function modelProvidersGrantViolations(command: string): string[] {
	const problems: string[] = [];
	const nested = new Set(substitutionBodies(command).flatMap(simpleCommands).map((words) => words.join('\0')));
	for (const words of simpleCommands(command)) {
		const judged = !nested.has(words.join('\0')) && !words.includes('packages/cli/gate.ts');
		// The leading `NAME=value` words are the command's environment prefix; the first other word ends the run.
		for (const word of words) {
			const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
			if (assigned === null) break;
			if (KEY_VARIABLE.test(assigned[1]!)) {
				problems.push(
					`${assigned[1]} is set inline: a provider key lives in ${MODEL_PROVIDERS_ENV_COPY}, never in the ` +
						'environment (D-145)',
				);
			}
		}
		for (const word of words.filter((word) => word.startsWith('--allow-env='))) {
			const entries = word.slice('--allow-env='.length).split(',');
			if (judged && !entries.some((entry) => envEntryCovers(entry, MODEL_PROVIDERS_ENV_COPY))) {
				problems.push(`--allow-env= does not cover ${MODEL_PROVIDERS_ENV_COPY} (D-143): grant it, or TTK_*`);
			}
			for (const entry of entries) {
				if (KEY_VARIABLE.test(entry.trim())) {
					problems.push(
						`${entry.trim()} names a provider-key variable: keys live in ${MODEL_PROVIDERS_ENV_COPY}, never in ` +
							'the environment (D-145)',
					);
				}
			}
		}
	}
	return problems;
}

/** Every violation in a task table, in task order. */
export function checkTasks(tasks: Readonly<Record<string, string>>): Violation[] {
	const violations: Violation[] = [];
	for (const [task, command] of Object.entries(tasks)) {
		for (const at of bareParens(command)) {
			violations.push({
				task,
				rule: 'T1',
				detail: `unquoted "${command[at]}" at offset ${at} — the task shell reads it as a subshell; ` +
					`quote the flag that contains it (…${command.slice(Math.max(0, at - 24), at + 8)}…)`,
			});
		}
		for (const { flag, value } of permissionValues(command)) {
			for (const found of interpolations(value)) {
				violations.push({
					task,
					rule: 'T2',
					detail: `${flag}= interpolates ${found} — an unset variable leaves adjacent commas, and Deno ` +
						`reads ",," as an escaped comma, welding the neighbouring paths into one. Compute the ` +
						`list in a script (see scripts/tier_paths.ts) and substitute it with $(…).`,
				});
			}
		}
		if ((SHIPPED_TASKS as readonly string[]).includes(task)) {
			for (const flag of unscoped(command)) {
				violations.push({ task, rule: 'T3', detail: `${flag} is unscoped, and this task is a shipped surface` });
			}
			if (!deniesFfiFirst(command)) {
				violations.push({
					task,
					rule: 'T4',
					detail: '--deny-ffi must come before the first --allow-* on a shipped surface (E-103)',
				});
			}
			for (const detail of otelGrantViolations(command)) violations.push({ task, rule: 'T5', detail });
			for (const detail of substitutionOtelViolations(command)) violations.push({ task, rule: 'T5', detail });
			for (const detail of watchGateViolations(command)) violations.push({ task, rule: 'T5', detail });
			for (const detail of modelProvidersGrantViolations(command)) violations.push({ task, rule: 'T6', detail });
		}
	}
	return violations;
}

/** Reads the task table out of a `deno.json`. */
export function tasksOf(config: unknown): Record<string, string> {
	const raw = (config as { tasks?: Record<string, unknown> }).tasks ?? {};
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw)) {
		// Deno also accepts an object form carrying `command` plus `dependencies`.
		if (typeof value === 'string') out[name] = value;
		else if (typeof (value as { command?: unknown }).command === 'string') {
			out[name] = (value as { command: string }).command;
		}
	}
	return out;
}

if (import.meta.main) {
	const path = Deno.args[0] ?? 'deno.json';
	const tasks = tasksOf(JSON.parse(await Deno.readTextFile(path)));
	const violations = checkTasks(tasks);

	if (violations.length === 0) {
		console.log(`task gate: ${Object.keys(tasks).length} tasks, no violations`);
		Deno.exit(0);
	}
	for (const violation of violations) {
		console.error(`${path} task "${violation.task}" [${violation.rule}]: ${violation.detail}`);
	}
	console.error(`\ntask gate: ${violations.length} violation(s)`);
	Deno.exit(1);
}
