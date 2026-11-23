/**
 * @module
 * Line coverage across tiers, merged on LCOV.
 *
 * `deno coverage` over one directory written by several tiers resolves a file to one run instead of summing hits,
 * so a second tier can make a covered file look untested. Here hit counts are summed per file and line.
 *
 * Usage: deno run -A scripts/coverage.ts <dir>... [--include <regex>] [--threshold 60]
 */
import { parseArgs } from '@std/cli/parse-args';

/** Sums `DA:` hit counts per source file and line across LCOV documents. */
function mergeLcov(documents: readonly string[]): Map<string, Map<number, number>> {
	const files = new Map<string, Map<number, number>>();
	for (const document of documents) {
		let current: Map<number, number> | null = null;
		for (const raw of document.split(/\r?\n/)) {
			const line = raw.trim();
			if (line.startsWith('SF:')) {
				const path = line.slice(3);
				current = files.get(path) ?? new Map();
				files.set(path, current);
			} else if (line === 'end_of_record') {
				current = null;
			} else if (current !== null && line.startsWith('DA:')) {
				const [number, hits] = line.slice(3).split(',').map(Number);
				if (Number.isFinite(number)) current.set(number!, (current.get(number!) ?? 0) + (hits || 0));
			}
		}
	}
	return files;
}

async function lcovOf(dir: string): Promise<string> {
	const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
		args: ['coverage', dir, '--lcov'],
		stdout: 'piped',
		stderr: 'piped',
	}).output();
	if (code !== 0) throw new Error(`deno coverage ${dir} failed: ${new TextDecoder().decode(stderr).slice(-500)}`);
	return new TextDecoder().decode(stdout);
}

if (import.meta.main) {
	const args = parseArgs(Deno.args, {
		string: ['include', 'threshold'],
		default: { include: 'packages/(mcp|gateway)/src', threshold: '60' },
	});
	const dirs = args._.map(String);
	if (dirs.length === 0) {
		console.error('usage: coverage.ts <coverage-dir>... [--include <regex>] [--threshold 60]');
		Deno.exit(1);
	}
	const include = new RegExp(args.include.replaceAll('/', '[\\\\/]'));
	const merged = mergeLcov(await Promise.all(dirs.map(lcovOf)));

	const rows: Array<[string, number, number]> = [];
	let lines = 0;
	let hit = 0;
	for (const [path, file] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
		if (!include.test(path) || /_test\.ts$|[\\/]tests[\\/]/.test(path)) continue;
		const fileHit = [...file.values()].filter((hits) => hits > 0).length;
		const slash = path.replace(/\\/g, '/');
		const marker = slash.indexOf('/packages/');
		rows.push([marker < 0 ? slash : slash.slice(marker + 1), fileHit, file.size]);
		lines += file.size;
		hit += fileHit;
	}
	const percent = (h: number, total: number): number => total === 0 ? 100 : (h / total) * 100;
	const width = Math.max(24, ...rows.map(([path]) => path.length));
	console.log(`${'File'.padEnd(width)}  Line %`);
	for (const [path, h, total] of rows) {
		console.log(`${path.padEnd(width)}  ${percent(h, total).toFixed(1).padStart(6)}`);
	}
	const linePct = percent(hit, lines);
	console.log(`${'TOTAL'.padEnd(width)}  ${linePct.toFixed(1).padStart(6)}\n\nmerged from ${dirs.join(', ')}`);

	const threshold = Number(args.threshold);
	if (linePct < threshold) {
		console.error(`\nFAIL: line coverage ${linePct.toFixed(1)}% is below the ${threshold}% gate`);
		Deno.exit(1);
	}
	console.log(`\nOK: line coverage ${linePct.toFixed(1)}% meets the ${threshold}% gate`);
}
