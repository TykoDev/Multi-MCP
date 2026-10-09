import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { DIFF_EXCLUDES, diffScript, fitDiff, parseDiff } from './diff.ts';
import { LIMITS } from './limits.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const NUL = String.fromCharCode(0);

const onePatch = (path: string, body = '-one\n+two\n') =>
	`diff --git a/${path} b/${path}\nindex 5626abf..5ea2ed4 100644\n--- a/${path}\n+++ b/${path}\n` +
	`@@ -1 +1 @@\n${body}`;

Deno.test("diff: git works on a temporary index and object store, never the checkout's", () => {
	const script = diffScript();
	assertStringIncludes(script, 'GIT_INDEX_FILE=/tmp/.harbour-diff/index');
	assertStringIncludes(script, 'GIT_OBJECT_DIRECTORY=/tmp/.harbour-diff/objects');
	assertStringIncludes(script, 'GIT_ALTERNATE_OBJECT_DIRECTORIES=/workspace/.git/objects');
	assertStringIncludes(script, 'GIT_CONFIG_GLOBAL=/dev/null');
	// Staging, then the list, then the patch: against HEAD, renames as delete and add.
	const order = [
		'read-tree HEAD',
		'add -A',
		'--name-status -z HEAD',
		"printf '=\\000'",
		'--no-ext-diff',
	];
	const at = order.map((step) => script.indexOf(step));
	assert(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]!)), JSON.stringify(at));
	assertStringIncludes(script, '--no-renames --no-color --no-ext-diff --no-textconv HEAD');
	// Nothing git could be told by the repository runs: no external diff, no text conversion.
	assertStringIncludes(script, '-c core.fsmonitor=false');
	// R12: a checkout may come from a remote; no hook ever runs in a diff, on every git call of it.
	const calls = script.split("git -c safe.directory='*'").length - 1;
	assertEquals(calls, 4);
	assertEquals(script.split('-c core.hooksPath=/dev/null').length - 1, calls);
	for (const folder of DIFF_EXCLUDES) assertStringIncludes(script, folder);
});

Deno.test('diff: the list and the patch are read apart', () => {
	const patch = onePatch('src/a.txt') + onePatch('new.txt', '+new\n');
	const out = bytes(
		`M${NUL}src/a.txt${NUL}A${NUL}new.txt${NUL}D${NUL}old.txt${NUL}T${NUL}link${NUL}=${NUL}${patch}`,
	);
	assertEquals(parseDiff(out, true), {
		patch,
		files: [
			{ path: 'src/a.txt', change: 'modified' },
			{ path: 'new.txt', change: 'added' },
			{ path: 'old.txt', change: 'deleted' },
			{ path: 'link', change: 'modified' },
		],
		truncated: false,
	});
});

Deno.test('diff: nothing changed is an empty patch and no files', () => {
	assertEquals(parseDiff(bytes(`=${NUL}`), true), { patch: '', files: [], truncated: false });
});

Deno.test('diff: a name with spaces, or one that looks like the separator, is a name', () => {
	const out = bytes(`A${NUL}a b/=${NUL}A${NUL}=${NUL}=${NUL}`);
	assertEquals(parseDiff(out, true).files, [
		{ path: 'a b/=', change: 'added' },
		{ path: '=', change: 'added' },
	]);
});

Deno.test('diff: a cut patch keeps whole files, and says it was cut', () => {
	const first = onePatch('a.txt');
	const second = onePatch('b.txt');
	const cut = bytes(`M${NUL}a.txt${NUL}M${NUL}b.txt${NUL}=${NUL}${first}${second.slice(0, 30)}`);
	const result = parseDiff(cut, false);
	assertEquals(result.patch, first);
	assertEquals(result.files.length, 2);
	assertEquals(result.truncated, true);
});

Deno.test('diff: output that ends inside the list is a truncated list and no patch', () => {
	const result = parseDiff(bytes(`M${NUL}a.txt${NUL}M${NUL}b.t`), false);
	assertEquals(result, {
		patch: '',
		files: [{ path: 'a.txt', change: 'modified' }],
		truncated: true,
	});
});

Deno.test('diff: a very long list stops at the limit', () => {
	const list = Array.from({ length: LIMITS.diffFiles + 5 }, (_, i) => `A${NUL}f${i}${NUL}`).join(
		'',
	);
	const result = parseDiff(bytes(`${list}=${NUL}`), true);
	assertEquals(result.files.length, LIMITS.diffFiles);
	assertEquals(result.truncated, true);
});

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

Deno.test('SB-6 diff: a reply that fits is left as it is', () => {
	const result = {
		patch: onePatch('a.txt'),
		files: [{ path: 'a.txt', change: 'modified' as const }],
		truncated: false,
	};
	assertEquals(fitDiff(result, LIMITS.responseBytes), result);
});

Deno.test('SB-6 diff: a patch of control bytes, six times longer as JSON, is cut to whole files that fit', () => {
	// A 7 MiB patch is within patchBytes, but each control byte is six bytes once escaped.
	const control = String.fromCharCode(1).repeat(1024 * 1024);
	const patch = Array.from({ length: 7 }, (_, i) => onePatch(`f${i}.bin`, `+${control}\n`)).join('');
	const files = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.bin`, change: 'added' as const }));
	assert(new TextEncoder().encode(patch).length <= LIMITS.patchBytes);
	const fitted = fitDiff({ patch, files, truncated: false }, LIMITS.responseBytes);
	assert(jsonBytes(fitted) <= LIMITS.responseBytes, String(jsonBytes(fitted)));
	assertEquals(fitted.truncated, true);
	assertEquals(fitted.files, files);
	assert(fitted.patch.startsWith('diff --git a/f0.bin'));
	// Whole files only: one escaped file is 6 MiB, so one fits in 9 MiB and two do not.
	assertEquals(fitted.patch.split(/^diff --git /m).length - 1, 1);
});

Deno.test('SB-6 diff: a file list of escaped names keeps at most a quarter of the room', () => {
	const name = String.fromCharCode(2).repeat(4000);
	const files = Array.from({ length: 200 }, (_, i) => ({ path: `${i}${name}`, change: 'added' as const }));
	const fitted = fitDiff({ patch: onePatch('a.txt'), files, truncated: false }, 1024 * 1024);
	assert(jsonBytes(fitted) <= 1024 * 1024);
	assert(fitted.files.length > 0 && fitted.files.length < files.length);
	assertEquals(fitted.patch, onePatch('a.txt'));
	assertEquals(fitted.truncated, true);
});
