/**
 * @module
 * Emits the filesystem grant list for the browser tier.
 *
 * ERRATUM(E-19). The tasks used to interpolate the temp-directory variables
 * straight into the flag:
 *
 * ```
 * --allow-write=tests/.scratch,$TMPDIR,$TEMP,$TMP,/tmp
 * ```
 *
 * On a host where any of those is unset the expansion leaves **two adjacent
 * commas**, and Deno reads `,,` as an *escaped comma* rather than as an empty
 * entry — so the paths on either side are silently welded into one that cannot
 * exist. Measured on 2.9.5, Windows and Linux alike:
 * `--allow-write=tests/.scratch,,/tmp` grants one path spelled
 * `tests/.scratch,/tmp` and denies a write that `--allow-write=tests/.scratch`
 * permits. A *leading* or *trailing* lone comma is a hard
 * `error: Empty values are not allowed`; only the middle of the list fails
 * quietly, which is where interpolation puts it. Nothing warns.
 *
 * Which host it bites depends on which variables that host happens to set —
 * the worst possible distribution for a permission bug, because the declared
 * scope and the effective scope differ per machine. The same construction was
 * still live in `resolve:chromium` long after this note existed (E-30), which
 * is why the ban is now mechanical: `deno task gate:tasks`, rule T2.
 *
 * So the list is computed rather than interpolated. Empty entries cannot occur,
 * duplicates are dropped, and the paths a tier genuinely needs are named in one
 * place instead of being repeated across four task strings.
 *
 * Usage: `deno run … scripts/tier_paths.ts --read|--write|--ffmpeg|--net|--serve-ffmpeg`
 */
import { parseArgs } from '@std/cli/parse-args';
import { findConfigFile, resolveModelEndpoint } from './model_endpoint.ts';

/** Temp-directory variables, in the order a host is likely to set them. */
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;

function readEnv(name: string): string | undefined {
	try {
		const value = Deno.env.get(name);
		return value === undefined || value.trim() === '' ? undefined : value.trim();
	} catch {
		return undefined;
	}
}

/** Every temp directory this host actually has, plus the POSIX default. */
function tempDirs(): string[] {
	const found = TEMP_VARS.map(readEnv).filter((value): value is string => value !== undefined);
	// `/tmp` is always included: harmless where it does not exist, and the only
	// answer on a container whose environment carries none of the variables.
	return [...found, '/tmp'];
}

/**
 * Chromium writes its temporary profile into the system temp directory, and the
 * suites write fixtures and data roots under the repo's scratch directory.
 */
function writePaths(): string[] {
	return ['tests/.scratch', ...tempDirs()];
}

/**
 * The ffmpeg the recording tier may run, or an inert placeholder.
 *
 * Same shape as the Chromium grant: `--allow-run` must name a real path, and a
 * host without ffmpeg must still produce a *well-formed* flag or the whole task
 * fails before a single test registers (the ERRATUM(SKIP-9) failure, one tier
 * over). The placeholder carries a separator and no leading slash so MSYS
 * cannot rewrite it and Deno cannot find it on PATH.
 */
export const NO_FFMPEG_SENTINEL = 'ttk-tier/no-ffmpeg-resolved';

/**
 * The ffmpeg on this host, or `null`.
 *
 * `--allow-run` needs an absolute path, so this is a `which` rather than a
 * "does the name resolve" check: the well-known install locations first, then
 * every `PATH` entry, with the Windows executable extensions applied. An
 * explicit `TTK_FFMPEG` short-circuits all of it, which is how the container
 * (and anyone with a private build) says where theirs is.
 */
export function findFfmpeg(): string | null {
	const configured = readEnv('TTK_FFMPEG');
	if (configured !== undefined) return configured;

	const windows = Deno.build.os === 'windows';
	const names = windows ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat'] : ['ffmpeg'];
	const wellKnown = windows ? [] : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
	const fromPath = (readEnv('PATH') ?? '').split(windows ? ';' : ':').filter((entry) => entry.trim() !== '');

	const separator = windows ? '\\' : '/';
	for (const dir of [...wellKnown, ...fromPath]) {
		const base = dir.replace(/[\\/]+$/, '');
		for (const name of names) {
			try {
				const candidate = `${base}${separator}${name}`;
				if (Deno.statSync(candidate).isFile) return candidate;
			} catch { /* keep looking */ }
		}
	}
	return null;
}

/** The value for `--allow-run`: a real path, or an inert, well-formed placeholder. */
export function ffmpegPath(): string {
	return findFfmpeg() ?? NO_FFMPEG_SENTINEL;
}

/**
 * The ffmpeg grant for the server tasks (`dev`, `stdio`, `serve:cluster`; E-82): `TTK_FFMPEG` when the operator set
 * it, else the inert placeholder. Never a `PATH` lookup — unlike the recording tier, a server records only when told
 * to, and granting a binary it was not told about would widen a shipped task's matrix for nothing. Separators are
 * normalized to `/` because the value crosses a command substitution, which eats backslashes.
 */
export function serveFfmpegGrant(configured: string | undefined = readEnv('TTK_FFMPEG')): string {
	if (configured === undefined || configured.includes(',')) return NO_FFMPEG_SENTINEL;
	return configured.replaceAll('\\', '/');
}

/**
 * Everything writable, plus the repo itself for sources and fixtures.
 *
 * The real-model config file is added by exact path when there is one. It
 * usually sits beside the checkout rather than inside it, so `.` does not reach
 * it — and granting the parent directory to reach one file would be a far wider
 * grant than the tier needs.
 */
function readPaths(): string[] {
	const config = findConfigFile();
	return ['.', ...tempDirs(), ...(config === null ? [] : [config])];
}

/**
 * The hosts the browser tier may reach.
 *
 * The fixture site and the gateway are loopback; the only outbound host is the
 * model endpoint of the opt-in real-model leg, and it is added *only* when one
 * is configured. Resolving it here rather than hardcoding it means the host the
 * tier is permitted to reach and the host the responder actually calls come
 * from one answer and cannot drift apart.
 */
function netHosts(): string[] {
	const endpoint = resolveModelEndpoint();
	return ['127.0.0.1', 'localhost', ...(endpoint === null ? [] : [endpoint.netAuthority])];
}

function emit(paths: readonly string[]): void {
	const unique: string[] = [];
	for (const path of paths) {
		if (path !== '' && !unique.includes(path)) unique.push(path);
	}
	console.log(unique.join(','));
}

if (import.meta.main) {
	const args = parseArgs(Deno.args, {
		boolean: ['read', 'write', 'net', 'ffmpeg', 'ffmpeg-pin', 'model-pin', 'serve-ffmpeg'],
	});
	if (args.write) emit(writePaths());
	else if (args.read) emit(readPaths());
	else if (args.net) emit(netHosts());
	// `--ffmpeg` feeds `--allow-run`, which must always be well-formed;
	// `--ffmpeg-pin` feeds the environment, where an empty value is how a suite
	// learns there is nothing to run (the ERRATUM(SKIP-9) split, again).
	else if (args.ffmpeg) console.log(ffmpegPath());
	else if (args['ffmpeg-pin']) console.log(findFfmpeg() ?? '');
	else if (args['serve-ffmpeg']) console.log(serveFfmpegGrant());
	// Pins the config file the grants above were computed from, so the test
	// process resolves the same one — it runs with a narrower read grant and a
	// different cwd, and must not re-search and find something else.
	else if (args['model-pin']) console.log(findConfigFile() ?? '');
	else {
		console.error(
			'usage: tier_paths.ts --read | --write | --net | --ffmpeg | --ffmpeg-pin | --model-pin | --serve-ffmpeg',
		);
		Deno.exit(1);
	}
}

export { netHosts, readPaths, tempDirs, writePaths };
