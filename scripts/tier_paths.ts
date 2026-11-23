/**
 * @module
 * Computes grant lists for the test tiers and the server tasks. Interpolating `$TMPDIR,$TEMP,$TMP` into a flag
 * breaks where one is unset: Deno reads the resulting `,,` as an escaped comma and welds the neighbouring paths into
 * one (gate rule T2), so the lists are computed here, without empty entries or duplicates.
 *
 * Usage: `tier_paths.ts --read|--write|--net|--ffmpeg|--ffmpeg-pin|--model-pin|--serve-ffmpeg`
 */
import { parseArgs } from '@std/cli/parse-args';
import { findConfigFile, resolveModelEndpoint } from './model_endpoint.ts';

function readEnv(name: string): string | undefined {
	try {
		return Deno.env.get(name)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Every temp directory this host has, plus `/tmp` (the only answer in a container that sets none). */
function tempDirs(): string[] {
	return [...['TMPDIR', 'TEMP', 'TMP'].map(readEnv).filter((value): value is string => value !== undefined), '/tmp'];
}

/** The inert `--allow-run` stand-in when there is no ffmpeg: a separator and no leading slash, so nothing runs it. */
export const NO_FFMPEG_SENTINEL = 'ttk-tier/no-ffmpeg-resolved';

/** `TTK_FFMPEG`, else the first ffmpeg in the well-known directories or on `PATH` (an absolute path), or `null`. */
function findFfmpeg(): string | null {
	const configured = readEnv('TTK_FFMPEG');
	if (configured !== undefined) return configured;
	const windows = Deno.build.os === 'windows';
	const names = windows ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat'] : ['ffmpeg'];
	const dirs = [
		...(windows ? [] : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']),
		...(readEnv('PATH') ?? '').split(windows ? ';' : ':').filter((entry) => entry.trim() !== ''),
	];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = `${dir.replace(/[\\/]+$/, '')}${windows ? '\\' : '/'}${name}`;
			try {
				if (Deno.statSync(candidate).isFile) return candidate;
			} catch { /* keep looking */ }
		}
	}
	return null;
}

/**
 * The ffmpeg grant for `dev` and `stdio`: `TTK_FFMPEG` when set, else the sentinel — never a `PATH` lookup, so a
 * shipped task grants no binary it was not told about. `/` separators: a task-shell substitution eats backslashes.
 */
export function serveFfmpegGrant(configured: string | undefined = readEnv('TTK_FFMPEG')): string {
	if (configured === undefined || configured.includes(',')) return NO_FFMPEG_SENTINEL;
	return configured.replaceAll('\\', '/');
}

const emit = (paths: readonly string[]): void =>
	console.log([...new Set(paths)].filter((path) => path !== '').join(','));

if (import.meta.main) {
	const args = parseArgs(Deno.args, {
		boolean: ['read', 'write', 'net', 'ffmpeg', 'ffmpeg-pin', 'model-pin', 'serve-ffmpeg'],
	});
	if (args.write) emit(['tests/.scratch', ...tempDirs()]);
	// The model config is granted by exact path: it usually sits beside the checkout, and its parent is far wider.
	else if (args.read) emit(['.', ...tempDirs(), ...[findConfigFile()].filter((path) => path !== null)]);
	else if (args.net) emit(['127.0.0.1', 'localhost', ...[resolveModelEndpoint()?.netAuthority ?? '']]);
	// `--ffmpeg` feeds `--allow-run` (always well-formed); `--ffmpeg-pin` the environment (empty means none).
	else if (args.ffmpeg) console.log(findFfmpeg() ?? NO_FFMPEG_SENTINEL);
	else if (args['ffmpeg-pin']) console.log(findFfmpeg() ?? '');
	else if (args['serve-ffmpeg']) console.log(serveFfmpegGrant());
	// Pins the config the grants were computed from, so the narrower test process does not find another.
	else if (args['model-pin']) console.log(findConfigFile() ?? '');
	else {
		console.error(
			'usage: tier_paths.ts --read | --write | --net | --ffmpeg | --ffmpeg-pin | --model-pin | --serve-ffmpeg',
		);
		Deno.exit(1);
	}
}
