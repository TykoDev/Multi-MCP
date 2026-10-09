/**
 * @module
 * File containment — download filename sanitisation and directory containment predicates.
 *
 * Contract owner: SPECS/SECURITY-AUTH.md §8 (the three containment contracts), specifically §8.3
 * "download containment": `suggestedFilename` is sanitised (strip NUL, backslash→slash, basename
 * only, reject empty/`.`/`..`), written files get ` (1)`-style unique names, and the final real path
 * MUST resolve inside the configured downloads dir. The same predicates gate profile/user-data-dir
 * paths (storage-state files, temp profile dirs) — SECURITY-AUTH.md §3.3/§8.
 *
 * Design notes:
 *
 * - **Traversal-proof by construction, then checked anyway.** Sanitisation reduces every name to a
 *   basename, so `join(dir, name)` cannot escape `dir`. {@linkcode containedJoin} still verifies the
 *   result, because "by construction" is a claim that rots the moment someone edits the function.
 * - **Pure.** Nothing here touches the filesystem: existence is an injected predicate, path flavour
 *   is an injected parameter. That keeps the suite hermetic (no `--allow-write`), lets Windows
 *   semantics be tested on a POSIX runner and vice versa, and keeps `Deno.realPath` — the one part
 *   that must hit the disk — in the watchdog that owns the I/O.
 * - **NFKC is applied here** (unlike `url_matcher.ts`, where folding would widen a policy): folding
 *   `＼` and `／` to real separators can only ever make a name *more* contained.
 */

import * as posix from '@std/path/posix';
import * as windows from '@std/path/windows';

/** Which platform's path semantics to apply. Injected so both are testable everywhere. */
export type PathFlavor = 'posix' | 'windows';

export type ContainmentOptions = {
	readonly flavor?: PathFlavor;
	/** Cap on ` (n)` disambiguation attempts. */
	readonly maxAttempts?: number;
};

/** A sanitised, unique, contained download destination. */
export type DownloadTarget = {
	readonly name: string;
	readonly path: string;
};

/** POSIX `NAME_MAX` and the Windows component limit both sit at 255. */
export const MAX_FILENAME_LENGTH = 255;

/** Longest suffix still treated as an extension worth preserving through truncation. */
const MAX_EXTENSION_LENGTH = 16;

/** Default ` (n)` budget before a download is refused rather than silently overwriting. */
export const DEFAULT_UNIQUE_ATTEMPTS = 1000;

/**
 * Everything that acts as a path separator on some platform, after NFKC has already folded `＼`
 * (U+FF3C) and `／` (U+FF0F). The rest have no NFKC decomposition and must be listed explicitly.
 */
const SEPARATOR_LIKE: readonly string[] = ['\\', '/', '\u2215', '\u2044', '\u2216', '\u29F5', '\uFE68'];

/** C0/C1 controls, DEL, and the bidi overrides used to disguise an extension (`evil\u202Egnp.exe`). */
// deno-lint-ignore no-control-regex -- stripping control chars is the point; they must never reach a filename.
const CONTROL_AND_BIDI = /[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Windows device names: reserved with *any* extension, and refused even on POSIX for portability. */
export const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
	'con',
	'prn',
	'aux',
	'nul',
	'com1',
	'com2',
	'com3',
	'com4',
	'com5',
	'com6',
	'com7',
	'com8',
	'com9',
	'lpt1',
	'lpt2',
	'lpt3',
	'lpt4',
	'lpt5',
	'lpt6',
	'lpt7',
	'lpt8',
	'lpt9',
]);

/**
 * Maps an OS name onto a path flavour. Split out from {@linkcode currentPathFlavor} so both arms are
 * reachable from a single-platform test run — a platform ternary is otherwise a permanent coverage
 * hole that says nothing about correctness.
 */
export function pathFlavorFor(os: typeof Deno.build.os): PathFlavor {
	return os === 'windows' ? 'windows' : 'posix';
}

/** The running platform's flavour. `Deno.build` needs no permission. */
export function currentPathFlavor(): PathFlavor {
	return pathFlavorFor(Deno.build.os);
}

/** The slice of `@std/path` this module uses; both flavour modules satisfy it structurally. */
type PathOps = {
	readonly SEPARATOR: string;
	isAbsolute(path: string): boolean;
	normalize(path: string): string;
	join(...paths: string[]): string;
};

function pathModuleFor(flavor: PathFlavor): PathOps {
	return flavor === 'windows' ? windows : posix;
}

/** Windows paths compare case-insensitively; POSIX paths do not. */
function fold(text: string, flavor: PathFlavor): string {
	return flavor === 'windows' ? text.toLowerCase() : text;
}

function trimTrailingSeparators(text: string, separator: string): string {
	let result = text;
	while (result.endsWith(separator)) result = result.slice(0, -separator.length);
	return result;
}

function isReservedDeviceName(name: string): boolean {
	const dot = name.indexOf('.');
	const stem = dot < 0 ? name : name.slice(0, dot);
	return RESERVED_DEVICE_NAMES.has(stem.toLowerCase());
}

function truncateFilename(name: string, max: number): string {
	if (name.length <= max) return name;
	const dot = name.lastIndexOf('.');
	const extension = dot > 0 && name.length - dot <= MAX_EXTENSION_LENGTH ? name.slice(dot) : '';
	return name.slice(0, max - extension.length) + extension;
}

/**
 * Reduces an attacker-influenced `suggestedFilename` to a safe basename, or `null` when nothing
 * usable survives (SECURITY-AUTH.md §8.3 "reject empty/`.`/`..`").
 *
 * The pipeline, in order — each step exists because of a named escape:
 *
 * 1. NFKC fold — `／` and `＼` become real separators instead of surviving as "letters";
 * 2. separator unification — POSIX, Windows, and the Unicode look-alike slashes all become `/`;
 * 3. control/bidi strip — NUL and the RTL override that disguises `…gnp.exe` as `…exe.png`;
 * 4. basename — everything up to the last `/` is discarded, so `../../etc/passwd` and
 *    `C:\Windows\System32\x.dll` both collapse to their last component (traversal-proof);
 * 5. `:` → `_` — kills NTFS alternate data streams (`report.pdf:payload.exe`) and drive-relative
 *    names (`C:evil.txt`) without discarding the visible name;
 * 6. truncation to {@linkcode MAX_FILENAME_LENGTH}, extension preserved;
 * 7. trailing dot/space strip — Windows silently drops them, so `evil.exe.` and `evil.exe ` would
 *    otherwise resolve to a different file than the one that was checked;
 * 8. reject `""` / `.` / `..`; prefix reserved device names with `_`.
 *
 * Percent-escapes are deliberately NOT decoded: `%2e%2e%2fpasswd` is a perfectly good flat filename
 * and decoding it would only create a traversal string for step 4 to undo.
 */
export function sanitizeFilename(suggested: string): string | null {
	let unified = suggested.normalize('NFKC');
	for (const separator of SEPARATOR_LIKE) unified = unified.replaceAll(separator, '/');
	const stripped = unified.replace(CONTROL_AND_BIDI, '');
	const basename = stripped.slice(stripped.lastIndexOf('/') + 1);
	const withoutStreams = basename.replaceAll(':', '_');
	const truncated = truncateFilename(withoutStreams, MAX_FILENAME_LENGTH);
	const trimmed = truncated.replace(/^\s+/, '').replace(/[\s.]+$/, '');
	if (trimmed === '') return null;
	return isReservedDeviceName(trimmed) ? `_${trimmed}` : trimmed;
}

/**
 * ` (1)`-style disambiguation (SECURITY-AUTH.md §8.3). `taken` is injected so this stays pure;
 * returns `null` once `maxAttempts` is exhausted rather than overwriting an existing file.
 */
export function uniqueFilename(
	name: string,
	taken: (candidate: string) => boolean,
	maxAttempts: number = DEFAULT_UNIQUE_ATTEMPTS,
): string | null {
	if (!taken(name)) return name;
	const dot = name.lastIndexOf('.');
	const split = dot > 0 ? { stem: name.slice(0, dot), extension: name.slice(dot) } : { stem: name, extension: '' };
	for (let index = 1; index <= maxAttempts; index += 1) {
		const candidate = `${split.stem} (${index})${split.extension}`;
		if (!taken(candidate)) return candidate;
	}
	return null;
}

/**
 * `true` iff `candidate` is `baseDir` itself or lies beneath it. Both paths MUST be absolute — a
 * relative path is refused rather than resolved against the process cwd, because "contained
 * relative to wherever this process happens to be running" is not a security property.
 *
 * Callers holding a real filesystem path SHOULD pass `Deno.realPath` output for both arguments, so
 * a symlink out of the directory is caught (§8.2's GHSA-j9hj-92j8-jv9h contract).
 */
export function isContainedIn(
	baseDir: string,
	candidate: string,
	flavor: PathFlavor = currentPathFlavor(),
): boolean {
	const path = pathModuleFor(flavor);
	if (!path.isAbsolute(baseDir) || !path.isAbsolute(candidate)) return false;
	const base = fold(trimTrailingSeparators(path.normalize(baseDir), path.SEPARATOR), flavor);
	const target = fold(trimTrailingSeparators(path.normalize(candidate), path.SEPARATOR), flavor);
	if (base === target) return true;
	return target.startsWith(base + path.SEPARATOR);
}

/**
 * Sanitises `unsafeName` and joins it under `baseDir`, returning `null` when the name is
 * unusable or — belt and braces — when the join somehow left the directory.
 */
export function containedJoin(
	baseDir: string,
	unsafeName: string,
	flavor: PathFlavor = currentPathFlavor(),
): string | null {
	const name = sanitizeFilename(unsafeName);
	if (name === null) return null;
	const path = pathModuleFor(flavor);
	const joined = path.join(baseDir, name);
	return isContainedIn(baseDir, joined, flavor) ? joined : null;
}

/**
 * The DownloadsWatchdog seam: sanitise → disambiguate → contain, in one call.
 *
 * `taken` receives the **absolute** candidate path so the caller can stat it. Returns `null` when
 * the suggested name is unusable or the ` (n)` budget is exhausted; the caller then reports a
 * download error rather than writing somewhere surprising.
 */
export function resolveDownloadPath(
	downloadsDir: string,
	suggestedFilename: string,
	taken: (absolutePath: string) => boolean,
	options: ContainmentOptions = {},
): DownloadTarget | null {
	const flavor = options.flavor ?? currentPathFlavor();
	const path = pathModuleFor(flavor);
	const sanitized = sanitizeFilename(suggestedFilename);
	if (sanitized === null) return null;
	const unique = uniqueFilename(
		sanitized,
		(candidate) => taken(path.join(downloadsDir, candidate)),
		options.maxAttempts,
	);
	if (unique === null) return null;
	const absolute = containedJoin(downloadsDir, unique, flavor);
	if (absolute === null) return null;
	return { name: unique, path: absolute };
}
