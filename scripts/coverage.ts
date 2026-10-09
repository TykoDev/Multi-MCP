/**
 * @module
 * Coverage across tiers, merged correctly.
 *
 * ERRATUM(E-25). The completion criteria ask for line coverage "across the unit
 * and browser tiers combined", and the obvious way to get it — point both runs
 * at one `--coverage` directory and report on it — **does not do that**.
 * Measured on Deno 2.9.5: with both tiers written to one directory,
 * `gateway/src/secrets.ts` reported 17.9% line coverage and
 * `gateway/src/stateful.ts` 4.5%, while the unit tier *alone* reported 100% and
 * 81.2% for the same files. `deno coverage` resolves a file that appears in two
 * runs to one of them rather than summing their hit counts, so adding a second
 * tier can make a well-covered file look untested. Nothing warns; the number
 * simply gets worse the more you test.
 *
 * So the merge is done here, on LCOV, where it is defined: per source file,
 * per line, hit counts are summed, and a line is covered if any tier reached
 * it. That is the number the criteria were always asking for.
 *
 * Usage:
 *   deno run -A scripts/coverage.ts <dir>... [--include <regex>] [--threshold 80]
 */
import { parseArgs } from '@std/cli/parse-args';

/** One source file's merged counters. */
interface FileCoverage {
	path: string;
	/** line number → total hits across every tier */
	lines: Map<number, number>;
	/** `line:block:branch` → total taken across every tier */
	branches: Map<string, number>;
}

/** Parses one LCOV document into per-file counters. */
export function parseLcov(text: string): Map<string, FileCoverage> {
	const files = new Map<string, FileCoverage>();
	let current: FileCoverage | null = null;

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('SF:')) {
			const path = line.slice(3);
			current = files.get(path) ?? { path, lines: new Map(), branches: new Map() };
			files.set(path, current);
			continue;
		}
		if (current === null) continue;
		if (line === 'end_of_record') {
			current = null;
			continue;
		}
		if (line.startsWith('DA:')) {
			const [number, hits] = line.slice(3).split(',');
			const key = Number(number);
			if (!Number.isFinite(key)) continue;
			current.lines.set(key, (current.lines.get(key) ?? 0) + Number(hits ?? 0));
			continue;
		}
		if (line.startsWith('BRDA:')) {
			const [number, block, branch, taken] = line.slice(5).split(',');
			const key = `${number}:${block}:${branch}`;
			// `-` means the branch was never reached in this run, which is a zero.
			const count = taken === '-' ? 0 : Number(taken ?? 0);
			current.branches.set(key, (current.branches.get(key) ?? 0) + count);
		}
	}
	return files;
}

/** Merges several LCOV documents by summing hit counts. */
export function mergeLcov(documents: readonly string[]): Map<string, FileCoverage> {
	const merged = new Map<string, FileCoverage>();
	for (const document of documents) {
		for (const [path, file] of parseLcov(document)) {
			const target = merged.get(path) ?? { path, lines: new Map(), branches: new Map() };
			for (const [number, hits] of file.lines) target.lines.set(number, (target.lines.get(number) ?? 0) + hits);
			for (const [key, taken] of file.branches) target.branches.set(key, (target.branches.get(key) ?? 0) + taken);
			merged.set(path, target);
		}
	}
	return merged;
}

export interface Totals {
	lines: number;
	linesHit: number;
	branches: number;
	branchesHit: number;
}

/** Line and branch totals for one file. */
export function totalsOf(file: FileCoverage): Totals {
	let linesHit = 0;
	for (const hits of file.lines.values()) if (hits > 0) linesHit++;
	let branchesHit = 0;
	for (const taken of file.branches.values()) if (taken > 0) branchesHit++;
	return { lines: file.lines.size, linesHit, branches: file.branches.size, branchesHit };
}

function percent(hit: number, total: number): number {
	return total === 0 ? 100 : (hit / total) * 100;
}

/** Runs `deno coverage --lcov` over one directory. */
async function lcovOf(dir: string): Promise<string> {
	const command = new Deno.Command(Deno.execPath(), {
		args: ['coverage', dir, '--lcov'],
		stdout: 'piped',
		stderr: 'piped',
	});
	const { code, stdout, stderr } = await command.output();
	if (code !== 0) throw new Error(`deno coverage ${dir} failed: ${new TextDecoder().decode(stderr).slice(-500)}`);
	return new TextDecoder().decode(stdout);
}

if (import.meta.main) {
	const args = parseArgs(Deno.args, {
		string: ['include', 'threshold'],
		default: { include: 'packages/(mcp|gateway)/src', threshold: '80' },
	});
	const dirs = args._.map(String);
	if (dirs.length === 0) {
		console.error('usage: coverage.ts <coverage-dir>... [--include <regex>] [--threshold 80]');
		Deno.exit(1);
	}

	const include = new RegExp(args.include.replaceAll('/', '[\\\\/]'));
	const merged = mergeLcov(await Promise.all(dirs.map(lcovOf)));

	const rows: Array<{ path: string; totals: Totals }> = [];
	const overall: Totals = { lines: 0, linesHit: 0, branches: 0, branchesHit: 0 };
	for (const [path, file] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
		if (!include.test(path)) continue;
		if (/_test\.ts$|[\\/]tests[\\/]/.test(path)) continue;
		const totals = totalsOf(file);
		rows.push({ path, totals });
		overall.lines += totals.lines;
		overall.linesHit += totals.linesHit;
		overall.branches += totals.branches;
		overall.branchesHit += totals.branchesHit;
	}

	const width = Math.max(24, ...rows.map((row) => shortPath(row.path).length));
	console.log(`${'File'.padEnd(width)}  Line %  Branch %`);
	console.log('-'.repeat(width + 18));
	for (const { path, totals } of rows) {
		console.log(
			`${shortPath(path).padEnd(width)}  ${percent(totals.linesHit, totals.lines).toFixed(1).padStart(6)}  ${
				percent(totals.branchesHit, totals.branches).toFixed(1).padStart(8)
			}`,
		);
	}
	console.log('-'.repeat(width + 18));
	const linePct = percent(overall.linesHit, overall.lines);
	const branchPct = percent(overall.branchesHit, overall.branches);
	console.log(
		`${'TOTAL'.padEnd(width)}  ${linePct.toFixed(1).padStart(6)}  ${branchPct.toFixed(1).padStart(8)}`,
	);
	console.log(`\nmerged from ${dirs.length} tier(s): ${dirs.join(', ')}`);

	const threshold = Number(args.threshold);
	if (linePct + 1e-9 < threshold) {
		console.error(`\nFAIL: line coverage ${linePct.toFixed(1)}% is below the ${threshold}% gate`);
		Deno.exit(1);
	}
	console.log(`\nOK: line coverage ${linePct.toFixed(1)}% meets the ${threshold}% gate`);
}

/** The repo-relative path, for a table that fits on a screen. */
function shortPath(path: string): string {
	const marker = path.replace(/\\/g, '/').indexOf('/packages/');
	return marker < 0 ? path : path.slice(marker + 1).replace(/\\/g, '/');
}
