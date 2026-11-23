/**
 * File operations inside a cage, for a workspace with a live session: the service's own lstat-then-open is sound
 * only while nothing swaps a checked directory for a link, and a session's shell can. Inside the cage a link such as
 * `sub -> ../.owners` resolves nowhere. The scripts are fixed text: the normalised path arrives as `TTK_PATH`, a
 * write's content on stdin, and each refuses a link on the way (`realpath -m` must return the path unchanged).
 */
import type { CageResult } from './cage.ts';
import { RequestError } from './request.ts';
import { ApiError, cageFailed } from './sandbox.ts';

/** What a caller may ask of a caged file operation. */
export type CagedFileOp =
	| { kind: 'read'; path: string }
	| { kind: 'write'; path: string; content: string }
	| { kind: 'list'; path: string };

/** The largest file read or written through the API; one byte more is read to tell "too large". */
export const CAGED_FILE_BYTES = 256 * 1024;
/** What a caged operation may print before it is stopped: a whole file and room to spare. */
export const CAGED_OUTPUT_BYTES = CAGED_FILE_BYTES + 64 * 1024;
/** Directory entries a listing returns before it says it was cut. */
export const CAGED_LIST_ENTRIES = 1000;

/** Exit statuses the scripts use for the refusals the fast path makes. */
export const EXIT = {
	notFound: 64,
	link: 65,
	notRegular: 66,
	tooLarge: 67,
	notDirectory: 68,
} as const;

const PREAMBLE = [
	'umask 077',
	'T="/workspace/$TTK_PATH"',
	// A link anywhere on the way is refused; inside a cage it could not leave the checkout, but the answer
	// matches the service's own path checks.
	`[ "$(realpath -m -- "$T")" = "$(realpath -ms -- "$T")" ] || exit ${EXIT.link}`,
	`[ -L "$T" ] && exit ${EXIT.link}`,
].join('\n');

/** The script for one operation; pure, so tests can read it. */
export function cagedScript(kind: CagedFileOp['kind']): string {
	if (kind === 'read') {
		return [
			PREAMBLE,
			`[ -e "$T" ] || exit ${EXIT.notFound}`,
			`[ -f "$T" ] || exit ${EXIT.notRegular}`,
			`[ "$(stat -c %s -- "$T")" -le ${CAGED_FILE_BYTES} ] || exit ${EXIT.tooLarge}`,
			`exec head -c ${CAGED_FILE_BYTES + 1} -- "$T"`,
		].join('\n');
	}
	if (kind === 'write') {
		return [
			PREAMBLE,
			`if [ -e "$T" ]; then [ -f "$T" ] || exit ${EXIT.notRegular}; fi`,
			'D=$(dirname -- "$T")',
			`if [ -e "$D" ]; then [ -d "$D" ] || exit ${EXIT.link}; fi`,
			// A file where a parent directory should be: refused like the fast path refuses it.
			`mkdir -p -- "$D" 2>/dev/null || exit ${EXIT.link}`,
			'N="$D/.tmp-$$"',
			'cat >"$N" || { rm -f -- "$N"; exit 71; }',
			'if [ -f "$T" ]; then chmod --reference="$T" -- "$N"; fi',
			'mv -f -- "$N" "$T" || { rm -f -- "$N"; exit 72; }',
			'stat -c %s -- "$T"',
		].join('\n');
	}
	return [
		PREAMBLE,
		`[ -e "$T" ] || exit ${EXIT.notFound}`,
		`[ -d "$T" ] || exit ${EXIT.notDirectory}`,
		// Type letter, a tab, the name; NUL between entries, so any name survives. `.git` is left out, as the
		// service's own listing does.
		`find "$T" -mindepth 1 -maxdepth 1 ! -iname .git -printf '%y\\t%f\\0' | head -z -n ${CAGED_LIST_ENTRIES + 1}`,
	].join('\n');
}

/** Turns a script's run and output into the reply, or the error the fast path would have raised. */
export function cagedResult(
	op: CagedFileOp,
	result: CageResult,
	output: Uint8Array,
	signal: AbortSignal,
): Record<string, unknown> {
	if (!result.started) throw cageFailed(result.diagnostics);
	if (result.killed === 'cancelled') signal.throwIfAborted();
	if (result.killed === 'timeout') throw new ApiError(504, 'file_timeout', 'The file operation took too long.');
	// Cut short for size: only a read can say this much, and it says "too large".
	const exitCode = result.killed === 'output' ? EXIT.tooLarge : result.exitCode;
	if (exitCode === EXIT.notFound) throw new ApiError(404, 'not_found', 'Path not found.');
	if (exitCode === EXIT.link) {
		throw new RequestError('path', 'symbolic links and non-directory parents are forbidden');
	}
	if (exitCode === EXIT.notRegular) {
		if (op.kind === 'write') throw new RequestError('path', 'must name a regular file');
		throw new ApiError(413, 'too_large', 'Only regular files up to 256 KiB may be read.');
	}
	if (exitCode === EXIT.tooLarge) throw new ApiError(413, 'too_large', 'Only regular files up to 256 KiB may be read.');
	if (exitCode === EXIT.notDirectory) throw new RequestError('path', 'must name a directory');
	if (exitCode !== 0) {
		const said = new TextDecoder().decode(output.subarray(Math.max(0, output.length - 500))).trim();
		throw new ApiError(500, 'file_failed', `The file operation failed: ${said || `exit ${exitCode}`}`);
	}
	if (op.kind === 'read') {
		if (output.length > CAGED_FILE_BYTES) throw new ApiError(413, 'too_large', 'File is too large.');
		return { content: new TextDecoder().decode(output), bytes: output.length };
	}
	if (op.kind === 'write') {
		const bytes = Number(new TextDecoder().decode(output).trim());
		return { written: true, bytes: Number.isFinite(bytes) ? bytes : new TextEncoder().encode(op.content).length };
	}
	const entries: Record<string, unknown>[] = [];
	const decoder = new TextDecoder();
	let start = 0;
	for (let i = 0; i < output.length; i++) {
		if (output[i] !== 0) continue;
		const record = decoder.decode(output.subarray(start, i));
		start = i + 1;
		const tab = record.indexOf('\t');
		if (tab < 0) continue;
		if (entries.length >= CAGED_LIST_ENTRIES) return { entries, truncated: true };
		const type = record.slice(0, tab);
		entries.push({
			name: record.slice(tab + 1),
			type: type === 'l' ? 'symlink' : type === 'd' ? 'directory' : 'file',
		});
	}
	return { entries, truncated: false };
}
