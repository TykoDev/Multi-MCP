/**
 * @module
 * The `deno.json` task gate: defects a reader misses and a mechanical check catches.
 *
 * - T1 bare parentheses: an unquoted `PROGRAMFILES(X86)` is a subshell to the task shell (exit 127).
 * - T2 interpolated grant lists: an unset `$VAR` leaves `,,`, which Deno reads as an escaped comma.
 * - T3 unscoped grants, T4 `--deny-ffi` before the first grant, T7 absolute `--allow-run` paths: every task
 *   ({@linkcode MATRIX_EXEMPTIONS} names the excused).
 * - T6 the providers-file variable is granted and no provider-key variable is: the shipped surface.
 *
 * T5 is retired; its number is not reused. Run: `deno run --deny-ffi --allow-read=deno.json scripts/check_tasks.ts`
 */

/** The tasks a deployment runs. They and every helper they reach through `deno task` are never excused. */
const SHIPPED_TASKS = ['dev', 'stdio', 'doctor', 'setup', 'seed'] as const;

/** Permission flags that grant everything of their kind when given without a value. */
const SCOPABLE = ['run', 'env', 'net', 'read', 'write', 'ffi', 'sys', 'import'] as const;

/** The rules the gate reports. */
export type Rule = 'T1' | 'T2' | 'T3' | 'T4' | 'T6' | 'T7';

/** One finding. */
export interface Violation {
	readonly task: string;
	readonly rule: Rule;
	readonly detail: string;
}

/**
 * Tooling tasks excused from the named matrix rules (T3, T4, T7), each for its reason. An entry for a task in the
 * shipped closure is ignored; `tests/unit/check_tasks_test.ts` fails on an excuse that is not needed.
 */
export const MATRIX_EXEMPTIONS: Readonly<Record<string, { readonly rules: readonly Rule[]; readonly why: string }>> = {
	'build:web': {
		rules: ['T4'],
		why: 'its two script steps grant only packages/web reads and dist writes, and packages/web/src/web_test.ts pins ' +
			'that text; add --deny-ffi to both steps and to that pin together, then drop this entry',
	},
	cov: {
		rules: ['T3'],
		why: "-A on scripts/coverage.ts: runs `deno coverage` through Deno.execPath() over three tiers' profiles",
	},
	'test:unit': {
		rules: ['T3'],
		why: 'bare --allow-read/--allow-write: Deno.symlink refuses path-scoped grants, and suites use temp directories',
	},
	'test:stdio': {
		rules: ['T3'],
		why: 'bare --allow-run and --allow-env: the suite spawns Deno.execPath() under matrices it composes per case, ' +
			'and hands the child environments it builds',
	},
	'test:container': {
		rules: ['T3', 'T7'],
		why: 'runs `docker` by name and probes the container over any published port; the verifier is also run as-is ' +
			'by .github/workflows/ci.yml',
	},
	'tier:paths': {
		rules: ['T3'],
		why: "bare --allow-read: the browser tier's --ffmpeg mode stats ffmpeg in every PATH entry and --read looks for " +
			'the model config beside the checkout; the shipped tasks use paths:serve, which reads no file',
	},
	'resolve:docker': {
		rules: ['T3'],
		why:
			'bare --allow-read: stats `docker` in every PATH entry, which no grant written before PATH is read can name; ' +
			'reached only from the Docker test tiers',
	},
};

/** Offsets of parentheses the task shell reads as syntax: neither quoted nor part of a `$( … )` (rule T1). */
export function bareParens(command: string): number[] {
	const found: number[] = [];
	let single = false;
	let double = false;
	let substitutions = 0;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === '\\' && double) {
			i++;
			continue;
		}
		if (ch === "'" && !double) single = !single;
		else if (ch === '"' && !single) double = !double;
		else if (single) continue;
		else if (ch === '$' && command[i + 1] === '(') {
			substitutions++;
			i++;
		} else if (double) continue;
		else if (ch === ')' && substitutions > 0) substitutions--;
		else if (ch === '(' || ch === ')') found.push(i);
	}
	return found;
}

/** Every `--allow-x=…` / `--deny-x=…` value in a command, with the flag that carried it. */
export function permissionValues(command: string): Array<{ flag: string; value: string }> {
	const out: Array<{ flag: string; value: string }> = [];
	for (const match of command.matchAll(/--(?:allow|deny)-[a-z-]+=/g)) {
		const start = match.index + match[0].length;
		let end = start;
		let depth = 0;
		for (; end < command.length; end++) {
			const ch = command[end];
			if (ch === '$' && command[end + 1] === '(') depth++;
			else if (ch === ')' && depth > 0) depth--;
			else if (depth === 0 && (ch === ' ' || ch === '"' || ch === "'" || ch === '\t')) break;
		}
		out.push({ flag: match[0].slice(0, -1), value: command.slice(start, end) });
	}
	return out;
}

/** The short permission letters `deno` accepts, by the long flag each stands for. */
const SHORT_GRANTS: Readonly<Record<string, string>> = {
	A: '--allow-all',
	R: '--allow-read',
	W: '--allow-write',
	N: '--allow-net',
	E: '--allow-env',
	S: '--allow-sys',
	I: '--allow-import',
	P: '--permission-set',
};

/**
 * Why one Deno flag word grants more than it names, or `null` (rule T3). Short forms and clusters count; a cluster
 * with one value is refused (which letter it scopes is not obvious); a permission set is refused (its grants live in
 * a file this gate cannot read); an empty value scopes nothing.
 */
export function unscopedGrant(word: string): string | null {
	if (word === '--allow-all' || word.startsWith('--allow-all=')) return `${word} grants everything`;
	if (word === '--permission-set' || word.startsWith('--permission-set=')) {
		return `${word} takes its grants from the config file, which this gate cannot judge`;
	}
	const long = /^--allow-([a-z-]+)(=?)(.*)$/.exec(word);
	if (long !== null) {
		if (!(SCOPABLE as readonly string[]).includes(long[1]!)) return null;
		return long[3] === '' ? `${word} is unscoped` : null;
	}
	const short = /^-([A-Za-z]+)(?:=(.*))?$/.exec(word);
	if (short === null) return null;
	const letters = [...short[1]!].filter((letter) => letter in SHORT_GRANTS);
	if (letters.length === 0) return null;
	if (letters.includes('A')) return `${word} is ${SHORT_GRANTS.A}, which grants everything`;
	if (letters.includes('P')) return `${word} is ${SHORT_GRANTS.P}, whose grants this gate cannot judge`;
	if (short[2] !== undefined && short[2] !== '' && letters.length === 1) return null;
	return `${word} is ${letters.map((letter) => SHORT_GRANTS[letter]).join(' ')}, unscoped`;
}

/** Every unscoped grant among the Deno flags of every invocation, substitutions included (rule T3). */
export function unscoped(command: string): string[] {
	return simpleCommands(command).flatMap((words) =>
		(denoFlags(words) ?? []).map(unscopedGrant).filter((problem): problem is string => problem !== null)
	);
}

/**
 * Rule T7: every `--allow-run=` entry is an absolute path or a whole `$( … )`. A bare name resolves through `PATH`
 * at spawn time, so the grant would follow whatever a writable `PATH` entry puts first.
 */
export function runGrantViolations(command: string): string[] {
	const problems: string[] = [];
	for (const words of simpleCommands(command)) {
		for (const word of denoFlags(words) ?? []) {
			if (!word.startsWith('--allow-run=')) continue;
			for (const entry of word.slice('--allow-run='.length).split(',')) {
				if (entry === '$(…)' || entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) continue;
				problems.push(`--allow-run= entry "${entry}" is not an absolute path; name the binary by its full path`);
			}
		}
	}
	return problems;
}

/** Flags of `deno task` that take the next word as their value. */
const TASK_VALUE_FLAGS = new Set(['--cwd', '-c', '--config', '-f', '--filter']);

/** The index of the word after `deno` (past leading `NAME=value` assignments), or -1 when the program is not Deno. */
function afterDeno(words: readonly string[]): number {
	let at = 0;
	while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++;
	const program = words[at]?.split(/[\\/]/).at(-1)?.toLowerCase();
	return program === 'deno' || program === 'deno.exe' ? at + 1 : -1;
}

/** The tasks a command runs through `deno task <name>`, substitutions included, in order of appearance. */
export function taskReferences(command: string): string[] {
	const names: string[] = [];
	for (const words of simpleCommands(command)) {
		let at = afterDeno(words);
		if (at < 0 || words[at] !== 'task') continue;
		for (at += 1; at < words.length; at++) {
			const word = words[at]!;
			if (TASK_VALUE_FLAGS.has(word)) at++;
			else if (!word.startsWith('-')) {
				names.push(word);
				break;
			}
		}
	}
	return names;
}

/**
 * The shipped tasks and every task they reach through `deno task`, transitively: a helper runs inside the shipped
 * command line, so it is held to the matrix rules unexcused and to T6's key half.
 */
export function shippedClosure(tasks: Readonly<Record<string, string>>): Set<string> {
	const reached = new Set<string>();
	const queue: string[] = (SHIPPED_TASKS as readonly string[]).filter((name) => name in tasks);
	while (queue.length > 0) {
		const name = queue.shift()!;
		if (reached.has(name)) continue;
		reached.add(name);
		for (const next of taskReferences(tasks[name]!)) if (next in tasks && !reached.has(next)) queue.push(next);
	}
	return reached;
}

/** One simple command: its words, unquoted, and whether it runs inside a `$( … )`. */
interface SimpleCommand {
	readonly words: string[];
	readonly nested: boolean;
}

/**
 * The simple commands of a task-shell command line. `&&`, `||`, `;`, `|`, `&`, newlines and bare parentheses end a
 * command; every `$( … )` is read as a command line of its own (its commands come first) and stands as `$(…)` in the
 * word that held it. Enough of the shell to find every Deno invocation and its flags; nothing runs.
 */
function parseCommands(command: string): SimpleCommand[] {
	const commands: SimpleCommand[] = [];
	/** The `)` closing the substitution opened at `open`; a nested one, quoted or not, is skipped whole. */
	const closing = (text: string, open: number): number => {
		let depth = 0;
		let single = false;
		let double = false;
		for (let i = open; i < text.length; i++) {
			const ch = text[i];
			if (single) {
				if (ch === "'") single = false;
			} else if (ch === '\\') i++;
			else if (ch === '$' && text[i + 1] === '(') i = closing(text, i + 1);
			else if (ch === "'" && !double) single = true;
			else if (ch === '"') double = !double;
			else if (double) continue;
			else if (ch === '(') depth++;
			else if (ch === ')' && --depth === 0) return i;
		}
		return text.length;
	};
	const walk = (text: string, nested: boolean): void => {
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
			if (words.length > 0) commands.push({ words, nested });
			words = [];
		};
		for (let i = 0; i < text.length; i++) {
			const ch = text[i]!;
			if (single) {
				if (ch === "'") single = false;
				else word += ch;
			} else if (ch === '\\' && i + 1 < text.length) {
				word += text[++i];
				started = true;
			} else if (ch === '$' && text[i + 1] === '(') {
				const end = closing(text, i + 1);
				walk(text.slice(i + 2, end), true);
				word += '$(…)';
				started = true;
				i = end;
			} else if (double) {
				if (ch === '"') double = false;
				else word += ch;
			} else if (ch === "'" || ch === '"') {
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
	walk(command, false);
	return commands;
}

/** The simple commands of a command line, each as its unquoted words (see {@linkcode parseCommands}). */
function simpleCommands(command: string): string[][] {
	return parseCommands(command).map(({ words }) => words);
}

/** Deno subcommands that take permission flags before their script path. */
const RUNNERS = new Set(['run', 'test', 'serve', 'bench', 'compile', 'eval', 'install', 'repl']);
/** Deno flags whose value may be the next word. */
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
	'-o',
	'--output',
	'--include',
	'--exclude',
	'--target',
	'--icon',
]);

/** Whether one word grants a permission: `--allow-*`, `--permission-set`, or a short form. */
function grants(word: string): boolean {
	if (word.startsWith('--allow-') || word === '--permission-set' || word.startsWith('--permission-set=')) return true;
	return /^-[A-Za-z]*[ARWNESIP][A-Za-z]*(?:=.*)?$/.test(word);
}

/**
 * The Deno flags of one simple command — the words before its script path, a flag's separate value left out — or
 * `null` when it runs no Deno program with permissions. What follows the script path is the program's arguments.
 */
function denoFlags(words: readonly string[]): string[] | null {
	let at = afterDeno(words);
	if (at < 0) return null;
	const next = words[at] ?? '';
	if (RUNNERS.has(next)) at += 1;
	else if (!next.startsWith('-') && !/\.[cm]?[jt]sx?$/.test(next)) return null; // `deno [flags] main.ts` is `deno run`
	const flags: string[] = [];
	for (; at < words.length; at++) {
		const word = words[at]!;
		if (word === '--' || !word.startsWith('-') || word === '-') break;
		flags.push(word);
		if (VALUE_FLAGS.has(word)) at++;
	}
	return flags;
}

/**
 * Rule T4: every Deno invocation, substitutions included, denies FFI among its own flags ahead of its first grant.
 * Judged per invocation so a `--deny-ffi` of an earlier `&&` step, a substitution or the script's arguments cannot
 * stand in. A scoped `--deny-ffi=<path>` is not the deny.
 */
export function deniesFfiFirst(command: string): boolean {
	return simpleCommands(command).every((words) => {
		for (const word of denoFlags(words) ?? []) {
			if (word === '--deny-ffi') return true;
			if (grants(word)) return false;
		}
		return true;
	});
}

/** The providers-file variable (`MODEL_PROVIDERS_ENV` in the gateway); a copy, pinned equal by the unit test. */
export const MODEL_PROVIDERS_ENV_COPY = 'TTK_MODEL_PROVIDERS_FILE';

/**
 * A provider-key variable name. `_API_KEY` is anchored to the end so the gateway's own `TTK_API_KEYS_FILE` is not one.
 * Exported so `tests/unit/images_test.ts` judges the image grants by the same spelling.
 */
export const PROVIDER_KEY_VARIABLE = /(_API_KEY$|OPENAI|ANTHROPIC)/i;

/** Whether one `--allow-env` entry covers `name`: the name itself, or a trailing wildcard prefix of it. */
export function envEntryCovers(entry: string, name: string): boolean {
	const trimmed = entry.trim();
	return trimmed === name || (trimmed.endsWith('*') && name.startsWith(trimmed.slice(0, -1)));
}

/**
 * Rule T6. (1) With `coverage`, every top-level `--allow-env=` covers {@linkcode MODEL_PROVIDERS_ENV_COPY} and one
 * exists (a `$( … )` helper is not the gateway's process). (2) Nowhere — helpers included — does an `--allow-env=`
 * entry name a provider-key variable, nor does a command set one inline: a key lives in the providers file only.
 */
export function modelProvidersGrantViolations(command: string, coverage = true): string[] {
	const problems: string[] = [];
	let granted = false;
	for (const { words, nested } of parseCommands(command)) {
		const judged = coverage && !nested;
		for (const word of words) {
			const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
			if (assigned === null) break;
			if (PROVIDER_KEY_VARIABLE.test(assigned[1]!)) {
				problems.push(
					`${assigned[1]} is set inline: a provider key lives in ${MODEL_PROVIDERS_ENV_COPY}, never in the environment`,
				);
			}
		}
		for (const word of words.filter((word) => word.startsWith('--allow-env='))) {
			if (judged) granted = true;
			const entries = word.slice('--allow-env='.length).split(',');
			if (judged && !entries.some((entry) => envEntryCovers(entry, MODEL_PROVIDERS_ENV_COPY))) {
				problems.push(`--allow-env= does not cover ${MODEL_PROVIDERS_ENV_COPY}: grant it, or TTK_*`);
			}
			for (const entry of entries.filter((entry) => PROVIDER_KEY_VARIABLE.test(entry.trim()))) {
				problems.push(
					`${entry.trim()} names a provider-key variable: keys live in ${MODEL_PROVIDERS_ENV_COPY}, never in the ` +
						'environment',
				);
			}
		}
	}
	if (coverage && !granted) {
		problems.push(`no --allow-env= grant: the gateway could not read ${MODEL_PROVIDERS_ENV_COPY}`);
	}
	return problems;
}

/** Every violation in a task table, in task order. */
export function checkTasks(tasks: Readonly<Record<string, string>>): Violation[] {
	const violations: Violation[] = [];
	const closure = shippedClosure(tasks);
	const held = (task: string, rule: Rule): boolean =>
		closure.has(task) || !(MATRIX_EXEMPTIONS[task]?.rules.includes(rule) ?? false);
	for (const [task, command] of Object.entries(tasks)) {
		const add = (rule: Rule, detail: string): number => violations.push({ task, rule, detail });
		for (const at of bareParens(command)) {
			add(
				'T1',
				`unquoted "${command[at]}" at offset ${at} — the task shell reads it as a subshell; ` +
					`quote the flag that contains it (…${command.slice(Math.max(0, at - 24), at + 8)}…)`,
			);
		}
		for (const { flag, value } of permissionValues(command)) {
			for (const [found] of value.matchAll(/\$(?!\()[A-Za-z_][A-Za-z0-9_]*/g)) {
				add(
					'T2',
					`${flag}= interpolates ${found} — an unset variable leaves adjacent commas, and Deno reads ",," as an ` +
						'escaped comma, welding the neighbouring paths into one. Compute the list in a script ' +
						'(see scripts/tier_paths.ts) and substitute it with $(…).',
				);
			}
		}
		const shipped = (SHIPPED_TASKS as readonly string[]).includes(task);
		const surface = shipped
			? 'a shipped surface'
			: closure.has(task)
			? 'a helper a shipped task reaches'
			: 'a task MATRIX_EXEMPTIONS does not excuse';
		if (held(task, 'T3')) { for (const problem of unscoped(command)) add('T3', `${problem}, in ${surface}`); }
		if (held(task, 'T4') && !deniesFfiFirst(command)) {
			add('T4', `--deny-ffi must come before the first grant of every Deno invocation in ${surface}`);
		}
		if (held(task, 'T7')) { for (const detail of runGrantViolations(command)) add('T7', detail); }
		if (closure.has(task)) {
			for (const detail of modelProvidersGrantViolations(command, shipped)) add('T6', detail);
		}
	}
	return violations;
}

/** Reads the task table (string or `{ command }` form) out of a `deno.json`. */
export function tasksOf(config: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries((config as { tasks?: Record<string, unknown> }).tasks ?? {})) {
		const command = typeof value === 'string' ? value : (value as { command?: unknown }).command;
		if (typeof command === 'string') out[name] = command;
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
