/**
 * The diff of a checkout: everything that differs from its HEAD commit — the empty initial commit the workspace
 * service made when it created the workspace (a command cannot commit, since `.git` is read-only to it) — whoever
 * changed it: the agent's file tools or the commands it ran.
 *
 * git runs in a cage like any command, with the whole checkout read-only. It stages the working
 * tree into a temporary index, and writes the blobs that takes into a temporary object store; the
 * repository's own objects are read through `GIT_ALTERNATE_OBJECT_DIRECTORIES`. So nothing in the
 * checkout, its `.git` included, changes by being diffed. Untracked files count, except what the
 * repository ignores and the dependency and cache folders in DIFF_EXCLUDES, which no patch wants.
 *
 * The cage prints the file list first (`--name-status -z`), then a separator, then the patch, so
 * one capped stream carries both and the list survives a patch that had to be cut.
 */
import { LIMITS } from './limits.ts';
import { WORKSPACE } from './cage.ts';

/** Untracked folders left out of a diff even when the repository does not ignore them. */
export const DIFF_EXCLUDES = [
	'node_modules/',
	'.venv/',
	'__pycache__/',
	'.pytest_cache/',
	'.mypy_cache/',
	'.ruff_cache/',
	'.deno/',
];

/** Where the temporary index and object store go: the run's /tmp, on the work volume (bwrap). */
export const DIFF_SCRATCH = '/tmp/.harbour-diff';
/** Printed between the file list and the patch: a token git never prints as a status. */
const SEPARATOR = '=';

/**
 * The script the diff cage runs: no part of it comes from the request. `scratch` is where git stages, a fixed
 * path: the run's /tmp for bwrap, the workspace's home for the Docker backend (D-108), whose /tmp is a small tmpfs.
 */
export function diffScript(scratch: string = DIFF_SCRATCH): string {
	const SCRATCH = scratch;
	const git = [
		'git',
		"-c safe.directory='*'",
		'-c core.fsmonitor=false',
		// R12: a checkout may now come from a remote; no hook of it, or of anything, ever runs in a diff.
		'-c core.hooksPath=/dev/null',
		'-c core.untrackedCache=false',
		`-c core.excludesFile=${SCRATCH}/exclude`,
		'-c core.quotePath=true',
		'-c diff.noprefix=false',
		'-c diff.mnemonicPrefix=false',
		'-c diff.relative=false',
		'-c gc.auto=0',
		'-c maintenance.auto=false',
	].join(' ');
	return [
		`export GIT_INDEX_FILE=${SCRATCH}/index GIT_OBJECT_DIRECTORY=${SCRATCH}/objects`,
		`export GIT_ALTERNATE_OBJECT_DIRECTORIES=${WORKSPACE}/.git/objects`,
		'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat',
		`rm -rf ${SCRATCH} && mkdir -p ${SCRATCH}/objects || exit 1`,
		`for p in ${DIFF_EXCLUDES.join(' ')}; do echo "$p"; done >${SCRATCH}/exclude`,
		`${git} read-tree HEAD || exit 1`,
		`${git} add -A || exit 1`,
		`${git} diff --cached --no-renames --name-status -z HEAD || exit 1`,
		`printf '${SEPARATOR}\\000'`,
		`${git} diff --cached --no-renames --no-color --no-ext-diff --no-textconv HEAD || exit 1`,
		`rm -rf ${SCRATCH}`,
	].join('\n');
}

export type Change = 'added' | 'modified' | 'deleted';

export interface DiffResult {
	patch: string;
	files: { path: string; change: Change }[];
	/** Files or patch text were left out to stay within the limits; `files` is complete otherwise. */
	truncated: boolean;
}

const STATUS: Record<string, Change> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted' };

/**
 * Reads what the diff cage printed. `complete` is false when the output was cut at the limit, in
 * which case the patch keeps only whole files.
 */
export function parseDiff(bytes: Uint8Array, complete: boolean): DiffResult {
	const decoder = new TextDecoder('utf-8', { fatal: false });
	const files: DiffResult['files'] = [];
	let truncated = !complete;
	let at = 0;
	let patchStart = -1;
	const token = (): string | null => {
		const end = bytes.indexOf(0, at);
		if (end < 0) return null;
		const text = decoder.decode(bytes.subarray(at, end));
		at = end + 1;
		return text;
	};
	for (;;) {
		const status = token();
		if (status === null) break;
		if (status === SEPARATOR) {
			patchStart = at;
			break;
		}
		const path = token();
		if (path === null) break;
		if (files.length >= LIMITS.diffFiles) {
			truncated = true;
			continue;
		}
		files.push({ path, change: STATUS[status[0] ?? ''] ?? 'modified' });
	}
	if (patchStart < 0) return { patch: '', files, truncated: true };
	let patch = bytes.subarray(patchStart);
	if (!complete || patch.length > LIMITS.patchBytes) {
		patch = wholeFiles(patch.subarray(0, LIMITS.patchBytes));
		truncated = true;
	}
	return { patch: decoder.decode(patch), files, truncated };
}

/** The patch up to the last file that is complete in `bytes`. */
function wholeFiles(bytes: Uint8Array): Uint8Array {
	const marker = new TextEncoder().encode('\ndiff --git ');
	let last = 0;
	for (let i = bytes.indexOf(10); i >= 0 && i + marker.length <= bytes.length;) {
		if (marker.every((byte, j) => bytes[i + j] === byte)) last = i + 1;
		i = bytes.indexOf(10, i + 1);
	}
	return bytes.subarray(0, last);
}

const encoder = new TextEncoder();
/** Bytes `value` takes as JSON, escapes included. */
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/**
 * SB-6: the diff cut to at most `max` bytes as JSON. patchBytes bounds the patch's own bytes, but
 * escaping can make it six times longer in a reply (a control byte becomes \u0001), and paths can
 * carry control bytes too. So when the reply would be too long, the file list keeps up to a
 * quarter of the room and the patch keeps whole files in what is left; either cut says truncated.
 */
export function fitDiff(result: DiffResult, max: number): DiffResult {
	if (jsonBytes(result) <= max) return result;
	const files: DiffResult['files'] = [];
	let used = jsonBytes({ patch: '', files: [], truncated: true });
	for (const file of result.files) {
		const cost = jsonBytes(file) + 1;
		if (used + cost > max / 4) break;
		files.push(file);
		used += cost;
	}
	let patch = '';
	for (const piece of result.patch.split(/(?=^diff --git )/m)) {
		// Each piece's escapes are its own: the quotes around one string are counted once, in `used`.
		const cost = jsonBytes(piece) - 2;
		if (used + cost > max) break;
		patch += piece;
		used += cost;
	}
	return { patch, files, truncated: true };
}
