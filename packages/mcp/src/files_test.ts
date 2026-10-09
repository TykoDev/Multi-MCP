/**
 * `SessionFiles` (E-33): the read side of the download pipeline, against a fake
 * ledger and real files under `tests/.scratch`.
 *
 * The ledger is faked because the watchdog has its own contract suite; what is
 * under test here is everything retrieval adds on top of a record — status
 * mapping, refusal of anything not retrievable, re-validation at read time,
 * the bounded inline read, the leased stream, and the directory's lifetime.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { exists } from '@std/fs';
import { fromFileUrl, join, SEPARATOR as SEP } from '@std/path';
import type { DownloadRecord } from '@tykotech/browser';
import { ToolError } from './errors.ts';
import { encodeHex } from '@std/encoding/hex';
import {
	DOWNLOAD_TRANSFER_DEADLINE_MS,
	MAX_DOWNLOAD_BYTES,
	MAX_SESSION_DOWNLOAD_BYTES,
	MAX_TRACKED_DOWNLOADS,
} from '@tykotech/browser';
import {
	ARTIFACT_ID_PREFIX,
	attachmentDisposition,
	type DownloadLedger,
	FILE_LEASE_GRACE_MS,
	fileInfoOf,
	filePolicyOf,
	fileStatusOf,
	INLINE_FILE_LIMIT_BYTES,
	MAX_SESSION_ARTIFACT_BYTES,
	MAX_SESSION_ARTIFACTS,
	mimeTypeFor,
	parseByteRange,
	SessionFiles,
	UPLOAD_STAGE_DIR,
} from './files.ts';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));

async function scratchDir(prefix: string): Promise<string> {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	return await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix });
}

function record(dir: string, guid: string, overrides: Partial<DownloadRecord> = {}): DownloadRecord {
	return {
		guid,
		url: 'http://127.0.0.1:1/x?token=secret',
		suggestedFilename: 'report.txt',
		fileName: 'report.txt',
		path: join(dir, guid),
		fileSize: 5,
		receivedBytes: 5,
		totalBytes: 5,
		fileType: 'txt',
		mimeType: null,
		autoDownload: false,
		state: 'completed',
		startedAt: 1_000,
		completedAt: 2_000,
		error: null,
		...overrides,
	};
}

function ledger(records: DownloadRecord[], remote = false): DownloadLedger {
	return {
		downloads: records,
		isRemoteBrowser: remote,
		lookup: (guid) => records.find((r) => r.guid === guid),
	};
}

async function completedFile(dir: string, guid: string, body: string | Uint8Array): Promise<DownloadRecord> {
	const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
	await Deno.writeFile(join(dir, guid), bytes);
	return record(dir, guid, { fileSize: bytes.length, receivedBytes: bytes.length, totalBytes: bytes.length });
}

// ---------------------------------------------------------------------------
// pure views
// ---------------------------------------------------------------------------

Deno.test('files: status follows the record, and completed means validated', () => {
	const dir = '/d';
	assertEquals(fileStatusOf(record(dir, 'a', { state: 'inProgress', completedAt: null })), 'pending');
	assertEquals(fileStatusOf(record(dir, 'a')), 'completed');
	// `state: completed` with an error is a failure, not a file.
	assertEquals(fileStatusOf(record(dir, 'a', { error: 'no file exists at the vetted path' })), 'failed');
	assertEquals(fileStatusOf(record(dir, 'a', { state: 'canceled', error: 'canceled' })), 'canceled');
	// A completed record that was never given a terminal timestamp is still pending.
	assertEquals(fileStatusOf(record(dir, 'a', { completedAt: null })), 'pending');
});

Deno.test('files: the wire view carries no path and no source URL', () => {
	const info = fileInfoOf(record('/downloads', 'G1'));
	const serialized = JSON.stringify(info);
	assert(!serialized.includes('/downloads'), 'no absolute path on the wire');
	assert(!serialized.includes('token=secret'), 'no source URL on the wire');
	assertEquals(info.file_id, 'G1');
	assertEquals(info.name, 'report.txt');
	assertEquals(info.available, true);
	assertEquals(info.size, 5);
	assertEquals(info.mime_type, 'text/plain');
	assertEquals(info.started_at, new Date(1_000).toISOString());
	// A remote browser's file is listed but never available here.
	assertEquals(fileInfoOf(record('/downloads', 'G1'), true).available, false);
	// A failed record carries its reason.
	assertEquals(fileInfoOf(record('/downloads', 'G1', { error: 'boom' })).error, 'boom');
});

Deno.test('files: MIME lookup is conservative and never renders inline', () => {
	assertEquals(mimeTypeFor('a.pdf'), 'application/pdf');
	assertEquals(mimeTypeFor('a.CSV'), 'text/csv');
	assertEquals(mimeTypeFor('a.html'), 'application/octet-stream');
	assertEquals(mimeTypeFor('a.svg'), 'application/octet-stream');
	assertEquals(mimeTypeFor('a.js'), 'application/octet-stream');
	assertEquals(mimeTypeFor('README'), 'application/octet-stream');
});

Deno.test('files: the attachment disposition survives quotes, unicode and empty names', () => {
	assertEquals(attachmentDisposition('report.txt'), `attachment; filename="report.txt"; filename*=UTF-8''report.txt`);
	const hostile = attachmentDisposition('a"b\\c.txt');
	assertStringIncludes(hostile, 'filename="a_b_c.txt"');
	const unicode = attachmentDisposition('rapport été.pdf');
	assertStringIncludes(unicode, 'filename="rapport _t_.pdf"');
	assertStringIncludes(unicode, "filename*=UTF-8''rapport%20%C3%A9t%C3%A9.pdf");
	assertStringIncludes(attachmentDisposition('日本'), 'filename="download"');
});

// ---------------------------------------------------------------------------
// resolve / refusals
// ---------------------------------------------------------------------------

Deno.test('B2.5: staging for upload gives the page the DISPLAY name, not the guid', async () => {
	const dir = await scratchDir('files-stage-');
	try {
		const files = new SessionFiles({ dir, ledger: ledger([await completedFile(dir, 'G1', 'hello')]) });
		const staged = await files.stageForUpload('G1');
		// The whole point: `DOM.setFileInputFiles` hands the page the basename of this path as
		// `File.name`, and Chromium wrote the download under its guid. Measured on the browser tier
		// before the staging existed — the fixture's own change handler reported the guid.
		assertEquals(staged.path.endsWith(`${SEP}report.txt`), true, staged.path);
		assert(!staged.path.endsWith('G1'), 'the guid path is not what the page is shown');
		assertEquals(staged.info.name, 'report.txt');
		assertEquals(staged.size, 5);
		assertEquals(new TextDecoder().decode(await Deno.readFile(staged.path)), 'hello');
		// A copy, not a link: the caller can still read the original through `browser_get_file`, and a
		// shared inode would make the upload a write path into the session's own ledger.
		assertEquals(await exists(join(dir, 'G1')), true, 'the source is untouched');
		// Inside the session's own directory, so the existing sweep removes it.
		assertEquals(staged.path.startsWith(await Deno.realPath(dir)), true, staged.path);
		await files.dispose();
		assertEquals(await exists(dir), false, 'the staged copy dies with the session directory');
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('B2.5: staging refuses exactly what resolve refuses, before any copy happens', async () => {
	const dir = await scratchDir('files-stage-refuse-');
	try {
		const files = new SessionFiles({ dir, ledger: ledger([await completedFile(dir, 'G1', 'hello')]) });
		for (const id of ['G2', '../G1', '']) {
			const error = await assertRejects(() => files.stageForUpload(id), ToolError, undefined, id);
			assertEquals(error.code, 'unknown-file', id);
		}
		assertEquals(await exists(join(dir, UPLOAD_STAGE_DIR)), false, 'nothing was staged for a refused id');
		await files.dispose();
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('B2.5/SEC-09: a file that escapes the download directory is refused AT UPLOAD TIME', async () => {
	const dir = await scratchDir('files-stage-escape-');
	const outside = await scratchDir('files-stage-outside-');
	try {
		await Deno.writeTextFile(join(outside, 'stolen.txt'), 'secret');
		// The clause is about a path that was inside when the download completed and resolves outside
		// now. A real symlink is the faithful shape and is tried first; on a host that refuses to create
		// one (Windows without developer mode) the same escape is modelled by a record whose path is
		// simply outside the directory, which is what `realPath` would have returned anyway. Either way
		// the assertion is on `isContainedIn` over the REALPATH, which is the control under test.
		let escaped = join(outside, 'stolen.txt');
		let viaSymlink = false;
		try {
			await Deno.symlink(join(outside, 'stolen.txt'), join(dir, 'G1'));
			escaped = join(dir, 'G1');
			viaSymlink = true;
		} catch {
			// No symlink privilege on this host; the direct-path arm covers the same predicate.
		}
		const escapee = record(dir, 'G1', { path: escaped, fileSize: 6, receivedBytes: 6, totalBytes: 6 });
		const files = new SessionFiles({ dir, ledger: ledger([escapee]) });

		// Staging is where an upload gets its path, so this is the refusal at upload time rather than
		// only at capture time — the half SEC-09 says is insufficient on its own.
		const staging = await assertRejects(() => files.stageForUpload('G1'), ToolError);
		assertEquals(staging.code, 'file-unavailable', viaSymlink ? 'symlink arm' : 'direct-path arm');
		assertStringIncludes(staging.message, 'outside');
		// And the same refusal on the read path, from the same predicate.
		const reading = await assertRejects(() => files.resolve('G1'), ToolError);
		assertEquals(reading.code, 'file-unavailable');
		// Nothing was staged, so no copy of the escaping file exists inside the session directory.
		assertEquals(await exists(join(dir, UPLOAD_STAGE_DIR)), false);
		await files.dispose();
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
		await Deno.remove(outside, { recursive: true }).catch(() => {});
	}
});

Deno.test('files: a session without a ledger lists nothing and knows no file', async () => {
	const files = new SessionFiles({ dir: null, ledger: null });
	assertEquals(files.list(), []);
	const error = await assertRejects(() => files.resolve('G1'), ToolError);
	assertEquals(error.code, 'unknown-file');
	await files.dispose();
});

Deno.test('files: ids that could not be guids are unknown, never paths', async () => {
	const dir = await scratchDir('files-ids-');
	try {
		const files = new SessionFiles({ dir, ledger: ledger([await completedFile(dir, 'G1', 'hello')]) });
		for (const id of ['../G1', 'G1/..', '..', 'a b', '']) {
			const error = await assertRejects(() => files.resolve(id), ToolError, undefined, id);
			assertEquals(error.code, 'unknown-file', id);
		}
		assertEquals(files.lookup('../G1'), undefined);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('files: pending, failed, canceled and remote records are unavailable with a reason', async () => {
	const dir = await scratchDir('files-states-');
	try {
		const records = [
			record(dir, 'P', { state: 'inProgress', completedAt: null, receivedBytes: 2, totalBytes: 9 }),
			record(dir, 'F', { error: 'the browser reported report.txt as complete but no file exists at the vetted path' }),
			record(dir, 'C', { state: 'canceled', error: 'the download exceeds the per-file limit of 100 bytes' }),
		];
		const files = new SessionFiles({ dir, ledger: ledger(records) });
		assertEquals(files.list().map((f) => [f.status, f.available]), [['pending', false], ['failed', false], [
			'canceled',
			false,
		]]);

		const pending = await assertRejects(() => files.resolve('P'), ToolError);
		assertEquals(pending.code, 'file-unavailable');
		assertStringIncludes(pending.message, 'still downloading (2/9 bytes)');
		const failed = await assertRejects(() => files.resolve('F'), ToolError);
		assertStringIncludes(failed.message, 'no file exists');
		const canceled = await assertRejects(() => files.resolve('C'), ToolError);
		assertStringIncludes(canceled.message, 'per-file limit');

		const remote = new SessionFiles({ dir, ledger: ledger([await completedFile(dir, 'R', 'x')], true) });
		const remoteError = await assertRejects(() => remote.resolve('R'), ToolError);
		assertEquals(remoteError.code, 'file-unavailable');
		assertStringIncludes(remoteError.message, 'remote browser');
		await files.dispose();
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('files: a completed record whose file vanished, or is not a file, is unavailable at read time', async () => {
	const dir = await scratchDir('files-gone-');
	try {
		const gone = record(dir, 'GONE');
		const notFile = record(dir, 'DIR');
		await Deno.mkdir(join(dir, 'DIR'));
		const files = new SessionFiles({ dir, ledger: ledger([gone, notFile]) });
		// The ledger still says completed; the disk disagrees, and the disk wins.
		assertEquals(files.list()[0]?.available, true);
		const missing = await assertRejects(() => files.resolve('GONE'), ToolError);
		assertEquals(missing.code, 'file-unavailable');
		assertStringIncludes(missing.message, 'no longer on disk');
		const directory = await assertRejects(() => files.resolve('DIR'), ToolError);
		assertStringIncludes(directory.message, 'not a regular file');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('files: a record pointing outside the directory is refused even when the ledger trusted it', async () => {
	const dir = await scratchDir('files-escape-');
	const outside = await scratchDir('files-outside-');
	try {
		await Deno.writeTextFile(join(outside, 'leak.txt'), 'secret');
		const files = new SessionFiles({ dir, ledger: ledger([record(dir, 'E', { path: join(outside, 'leak.txt') })]) });
		const error = await assertRejects(() => files.resolve('E'), ToolError);
		assertEquals(error.code, 'file-unavailable');
		assertStringIncludes(error.message, 'outside');
	} finally {
		await Deno.remove(dir, { recursive: true });
		await Deno.remove(outside, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// inline reads
// ---------------------------------------------------------------------------

Deno.test('files: inline reads return exact bytes, including an empty file', async () => {
	const dir = await scratchDir('files-inline-');
	try {
		const payload = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0]);
		const files = new SessionFiles({
			dir,
			ledger: ledger([await completedFile(dir, 'B', payload), await completedFile(dir, 'Z', '')]),
		});
		const binary = await files.readInline('B');
		assertEquals([...binary.bytes], [...payload]);
		assertEquals(binary.info.size, payload.length);
		const empty = await files.readInline('Z');
		assertEquals(empty.bytes.length, 0);
		assertEquals(empty.info.available, true);
		// Repeated reads are stable.
		assertEquals([...(await files.readInline('B')).bytes], [...payload]);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('files: the inline limit is exact — limit passes, limit + 1 is refused and names the link path', async () => {
	const dir = await scratchDir('files-limit-');
	try {
		const limit = 1_024;
		const files = new SessionFiles({
			dir,
			ledger: ledger([
				await completedFile(dir, 'AT', new Uint8Array(limit).fill(7)),
				await completedFile(dir, 'OVER', new Uint8Array(limit + 1).fill(7)),
			]),
		});
		assertEquals((await files.readInline('AT', limit)).bytes.length, limit);
		const error = await assertRejects(() => files.readInline('OVER', limit), ToolError);
		assertEquals(error.code, 'file-unavailable');
		assertStringIncludes(error.message, `${limit + 1} bytes, over the ${limit}-byte inline limit`);
		assertStringIncludes(error.message, 'delivery: "link"');
		assertEquals(INLINE_FILE_LIMIT_BYTES, 1024 * 1024, 'the product default is 1 MiB');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('files: a file that grew after its record was written is still bounded by the read, not the stat', async () => {
	const dir = await scratchDir('files-grew-');
	try {
		// The ledger believes 5 bytes; the disk holds more than the limit.
		const stale = record(dir, 'GREW');
		await Deno.writeFile(join(dir, 'GREW'), new Uint8Array(64).fill(1));
		const files = new SessionFiles({ dir, ledger: ledger([stale]) });
		const error = await assertRejects(() => files.readInline('GREW', 32), ToolError);
		assertStringIncludes(error.message, 'over the 32-byte inline limit');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// leased streams and directory lifetime
// ---------------------------------------------------------------------------

Deno.test('files: a streamed read delivers the bytes and releases its lease', async () => {
	const dir = await scratchDir('files-stream-');
	try {
		const body = new Uint8Array(200_000).map((_, i) => i % 251);
		const files = new SessionFiles({ dir, ledger: ledger([await completedFile(dir, 'S', body)]) });
		const opened = await files.open('S');
		assertEquals(files.openReads, 1);
		assertEquals(opened.size, body.length);
		const received = new Uint8Array(await new Response(opened.stream).arrayBuffer());
		assertEquals(received.length, body.length);
		assertEquals(received.every((value, i) => value === body[i]), true, 'byte-for-byte');
		assertEquals(files.openReads, 0, 'the lease was released at EOF');
		await files.dispose();
		assertEquals(await exists(dir), false, 'dispose removed the directory');
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('files: a cancelled stream releases its lease too', async () => {
	const dir = await scratchDir('files-cancel-');
	try {
		const files = new SessionFiles({ dir, ledger: ledger([await completedFile(dir, 'S', new Uint8Array(300_000))]) });
		const opened = await files.open('S');
		const reader = opened.stream.getReader();
		const first = await reader.read();
		assert(!first.done && first.value.length > 0);
		await reader.cancel();
		assertEquals(files.openReads, 0);
		await files.dispose();
		assertEquals(await exists(dir), false);
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('files: closing a session defers directory removal until the open read finishes', async () => {
	const dir = await scratchDir('files-defer-');
	try {
		const files = new SessionFiles({ dir, ledger: ledger([await completedFile(dir, 'S', new Uint8Array(150_000))]) });
		const opened = await files.open('S');
		const reader = opened.stream.getReader();
		await reader.read();

		await files.dispose();
		assertEquals(await exists(dir), true, 'the directory survives while a read is open');
		// No further reads are handed out once the session is closed.
		const error = await assertRejects(() => files.resolve('S'), ToolError);
		assertEquals(error.code, 'unknown-file');

		// Drain the read: the last release removes the directory.
		while (!(await reader.read()).done) { /* drain */ }
		// Removal runs from the release; give the microtask a turn.
		for (let i = 0; i < 50 && await exists(dir); i += 1) await new Promise((r) => setTimeout(r, 5));
		assertEquals(await exists(dir), false);
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('files: a reader that never finishes is closed after the grace and the directory removed', async () => {
	const dir = await scratchDir('files-grace-');
	try {
		const files = new SessionFiles({
			dir,
			ledger: ledger([await completedFile(dir, 'S', new Uint8Array(150_000))]),
			leaseGraceMs: 30,
		});
		const opened = await files.open('S');
		const reader = opened.stream.getReader();
		await reader.read();
		await files.dispose();
		for (let i = 0; i < 100 && await exists(dir); i += 1) await new Promise((r) => setTimeout(r, 5));
		assertEquals(await exists(dir), false, 'the grace cap closed the handle and removed the directory');
		assertEquals(files.openReads, 0);
		// The stalled reader now fails rather than hanging forever.
		await reader.read().catch(() => {});
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('files: dispose tolerates a directory that is already gone', async () => {
	const dir = await scratchDir('files-gone-dir-');
	await Deno.remove(dir, { recursive: true });
	const files = new SessionFiles({ dir, ledger: ledger([]) });
	await files.dispose();
	await files.dispose(); // idempotent
});

// ---------------------------------------------------------------------------
// B2.9: byte ranges, digests, and the policy
// ---------------------------------------------------------------------------

Deno.test('B2.9: parseByteRange understands the three RFC 9110 spellings', () => {
	assertEquals(parseByteRange('bytes=0-4', 10), { kind: 'range', range: { start: 0, end: 4 } });
	assertEquals(parseByteRange('bytes=5-', 10), { kind: 'range', range: { start: 5, end: 9 } });
	assertEquals(parseByteRange('bytes=-3', 10), { kind: 'range', range: { start: 7, end: 9 } });
	// A suffix longer than the file is the whole file — the one case RFC 9110 bounds rather than
	// refuses, and the only clamp in this parser.
	assertEquals(parseByteRange('bytes=-99', 10), { kind: 'range', range: { start: 0, end: 9 } });
	// An end past the file, with a valid start, is bounded to the last byte, which is also the
	// specification's rule and not a silent truncation of what the caller can have.
	assertEquals(parseByteRange('bytes=8-99', 10), { kind: 'range', range: { start: 8, end: 9 } });
	assertEquals(parseByteRange(' bytes=0-0 ', 10), { kind: 'range', range: { start: 0, end: 0 } });
});

Deno.test('B2.9: an unsatisfiable range is refused, never clamped to something the caller did not ask for', () => {
	for (const header of ['bytes=10-12', 'bytes=99-', 'bytes=5-2', 'bytes=-0']) {
		assertEquals(parseByteRange(header, 10).kind, 'unsatisfiable', header);
	}
	// A zero-length file can satisfy no range at all.
	assertEquals(parseByteRange('bytes=0-0', 0).kind, 'unsatisfiable');
});

Deno.test('B2.9: a header this server does not implement means the whole file, never an error', () => {
	// A multi-range set, a unit that is not bytes, and no header at all. Serving the whole file is
	// what RFC 9110 permits, and it is far better than a `multipart/byteranges` body nobody reads.
	for (const header of [null, undefined, 'bytes=0-1,4-5', 'items=0-1', 'bytes=', 'nonsense']) {
		assertEquals(parseByteRange(header, 10).kind, 'none', String(header));
	}
});

Deno.test('B2.9: a ranged open returns exactly the requested bytes, and memory stays bounded', async () => {
	const dir = await scratchDir('range-');
	// Larger than one read chunk, so the bounded loop is actually exercised rather than fitting in one.
	const body = new Uint8Array(200_000);
	for (let i = 0; i < body.length; i++) body[i] = i % 251;
	const one = await completedFile(dir, 'g-range', body);
	const files = new SessionFiles({ dir, ledger: ledger([one]) });
	try {
		for (
			const range of [{ start: 0, end: 0 }, { start: 1, end: 9 }, { start: 65_535, end: 131_072 }, {
				start: 199_999,
				end: 199_999,
			}]
		) {
			const opened = await files.open('g-range', range);
			assertEquals(opened.range, { ...range, total: body.length });
			const got = new Uint8Array(await new Response(opened.stream).arrayBuffer());
			// Byte-exact, not merely the right length: an off-by-one in the seek would keep the length.
			assertEquals(got, body.subarray(range.start, range.end + 1));
		}
		// And the whole-file path is unchanged, with no `range` on the result at all.
		const whole = await files.open('g-range');
		assertEquals(whole.range, undefined);
		assertEquals((await new Response(whole.stream).arrayBuffer()).byteLength, body.length);
		assertEquals(files.openReads, 0, 'every lease is released when its stream ends');
	} finally {
		await files.dispose();
	}
});

Deno.test('B2.9: a range past the end of the file is refused at the lease, not clamped', async () => {
	const dir = await scratchDir('range-past-');
	const one = await completedFile(dir, 'g-past', 'hello');
	const files = new SessionFiles({ dir, ledger: ledger([one]) });
	try {
		const error = await assertRejects(() => files.open('g-past', { start: 3, end: 99 }), ToolError);
		assertEquals(error.code, 'invalid-arguments');
		assertStringIncludes(error.message, '5 bytes');
		assertEquals(files.openReads, 0, 'a refused range opens no handle');
	} finally {
		await files.dispose();
	}
});

Deno.test('B2.9: sha256 matches an independently computed digest and is cached', async () => {
	const dir = await scratchDir('digest-');
	const body = new TextEncoder().encode('the quick brown fox');
	const one = await completedFile(dir, 'g-digest', body);
	const files = new SessionFiles({ dir, ledger: ledger([one]) });
	try {
		// The independent computation: the whole buffer through the platform digest, which is a
		// different code path from the module's chunked stream.
		const expected = encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', body)));
		assertEquals(await files.digest('g-digest'), expected);

		// The synchronous listing now carries it from the cache, and a second call recomputes nothing:
		// the file is deleted underneath and the cached answer stands, which is what "cached" means.
		assertEquals(files.list()[0]?.sha256, expected);
		await Deno.remove(join(dir, 'g-digest'));
		assertEquals(await files.digest('g-digest'), expected);
	} finally {
		await files.dispose();
	}
});

Deno.test('B2.9: an empty file has a digest; an unavailable one has null rather than a failure', async () => {
	const dir = await scratchDir('digest-edge-');
	const empty = await completedFile(dir, 'g-empty', '');
	const pending = record(dir, 'g-pending', { completedAt: null, state: 'inProgress' });
	const files = new SessionFiles({ dir, ledger: ledger([empty, pending]) });
	try {
		// `null` means "not computed", never "empty file": the empty file gets the well-known digest.
		assertEquals(await files.digest('g-empty'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		// A pending record cannot be read, and that costs the digest rather than the listing.
		assertEquals(await files.digest('g-pending'), null);
		const listed = await files.listDigested();
		assertEquals(listed.find((file) => file.file_id === 'g-pending')?.sha256, null);
		assert(listed.find((file) => file.file_id === 'g-empty')?.sha256 !== null);
	} finally {
		await files.dispose();
	}
});

Deno.test('B2.9: two concurrent listings hash once', async () => {
	const dir = await scratchDir('digest-once-');
	const one = await completedFile(dir, 'g-once', 'abcdefghij');
	const files = new SessionFiles({ dir, ledger: ledger([one]) });
	try {
		const [a, b, c] = await Promise.all([
			files.digest('g-once'),
			files.digest('g-once'),
			files.listDigested(),
		]);
		assertEquals(a, b);
		assertEquals(c[0]?.sha256, a);
		assertEquals(files.openReads, 0);
	} finally {
		await files.dispose();
	}
});

Deno.test('B2.9: the policy reads the constants the enforcement path uses', () => {
	const policy = filePolicyOf(1_800_000);
	assertEquals(policy.retention.mode, 'session-lifetime');
	assertEquals(policy.retention.session_idle_ttl_s, 1800);
	assertEquals(policy.retention.open_read_grace_ms, FILE_LEASE_GRACE_MS);
	assertEquals(policy.max_files_per_session, MAX_TRACKED_DOWNLOADS);
	assertEquals(policy.max_file_bytes, MAX_DOWNLOAD_BYTES);
	assertEquals(policy.max_session_bytes, MAX_SESSION_DOWNLOAD_BYTES);
	assertEquals(policy.inline_limit_bytes, INLINE_FILE_LIMIT_BYTES);
	assertEquals(policy.transfer_deadline_ms, DOWNLOAD_TRANSFER_DEADLINE_MS);
	assertEquals(policy.range_supported, true);
	// The requirement's own numbers, spelled out once so a change to any of them is visible here as
	// well as at the constant: 100 files, 100 MiB per file, 500 MiB per session, a 5-minute deadline.
	assertEquals(
		[policy.max_files_per_session, policy.max_file_bytes, policy.max_session_bytes, policy.transfer_deadline_ms],
		[100, 100 * 1024 * 1024, 500 * 1024 * 1024, 5 * 60_000],
	);
});

// ---------------------------------------------------------------------------
// R10 / D-119: server-made artifacts beside the ledger (F12: no vendored edit)
// ---------------------------------------------------------------------------

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 artifact body');

Deno.test('D-119: an artifact is stored under an art- id and read through every path a download is', async () => {
	const dir = await scratchDir('art-read-');
	const download = await completedFile(dir, 'g-download', 'downloaded');
	const files = new SessionFiles({ dir, ledger: ledger([download]) });
	try {
		const info = await files.addArtifact({ name: 'page.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES });
		assert(info.file_id.startsWith(ARTIFACT_ID_PREFIX), info.file_id);
		assertEquals(info.status, 'completed');
		assertEquals(info.available, true);
		assertEquals(info.size, PDF_BYTES.length);
		assertEquals(info.mime_type, 'application/pdf');
		assertEquals(info.sha256, encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', PDF_BYTES))));
		// Listed after the ledger's downloads, and by the same lookup a download id takes.
		assertEquals(files.list().map((file) => file.file_id), ['g-download', info.file_id]);
		assertEquals(files.lookup(info.file_id)?.fileName, 'page.pdf');
		// The bytes, inline and streamed, and the digest the listing promised.
		assertEquals((await files.readInline(info.file_id)).bytes, PDF_BYTES);
		const opened = await files.open(info.file_id, { start: 0, end: 3 });
		assertEquals(new TextDecoder().decode(await new Response(opened.stream).bytes()), '%PDF');
		assertEquals(await files.digest(info.file_id), info.sha256);
		// On disk under the id, inside the session's own directory, with no temporary left behind.
		const names: string[] = [];
		for await (const entry of Deno.readDir(dir)) names.push(entry.name);
		assertEquals(names.sort(), ['g-download', info.file_id].sort());
		// And it can be staged for upload like any download (B2.5): the display name, not the id.
		const staged = await files.stageForUpload(info.file_id);
		assert(staged.path.endsWith(`${SEP}page.pdf`), staged.path);
	} finally {
		await files.dispose();
	}
	assertEquals(await exists(dir), false, 'the artifact went with the session directory');
});

Deno.test('D-119: two artifacts never share a display name, and a non-guid id is still unknown', async () => {
	const dir = await scratchDir('art-name-');
	const files = new SessionFiles({ dir, ledger: null });
	try {
		const first = await files.addArtifact({ name: 'page.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES });
		const second = await files.addArtifact({ name: 'page.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES });
		assertEquals([first.name, second.name], ['page.pdf', 'page (1).pdf']);
		assertEquals(files.lookup(`../${first.file_id}`), undefined);
		await assertRejects(() => files.resolve('art-not-there'), ToolError, 'no file with id');
	} finally {
		await files.dispose();
	}
});

Deno.test('D-119: the artifact caps hold by count, by artifact bytes, and with the ledger together', async () => {
	assertEquals([MAX_SESSION_ARTIFACTS, MAX_SESSION_ARTIFACT_BYTES], [32, 128 * 1024 * 1024]);
	const bytes = (n: number) => new Uint8Array(n);
	const dir = await scratchDir('art-cap-');
	// The ledger already holds 60 bytes: a completed 40-byte file and a transfer 20 bytes in.
	const done = await completedFile(dir, 'g-done', 'x'.repeat(40));
	const running = record(dir, 'g-running', { state: 'inProgress', completedAt: null, receivedBytes: 20, fileSize: 0 });
	const files = new SessionFiles({
		dir,
		ledger: ledger([done, running]),
		artifactLimits: { count: 3, bytes: 30, sessionBytes: 100 },
	});
	try {
		await files.addArtifact({ name: 'a.pdf', mimeType: 'application/pdf', bytes: bytes(10) });
		// 60 in the ledger + 10 + 21 would pass the session cap but not the 30-byte artifact cap.
		await assertRejects(
			() => files.addArtifact({ name: 'b.pdf', mimeType: 'application/pdf', bytes: bytes(21) }),
			ToolError,
			'server-made files past 30 bytes',
		);
		// 60 + 10 + 20 = 90 fits both.
		await files.addArtifact({ name: 'b.pdf', mimeType: 'application/pdf', bytes: bytes(20) });
		await assertRejects(
			() => files.addArtifact({ name: 'c.pdf', mimeType: 'application/pdf', bytes: bytes(1) }),
			ToolError,
			'past 30 bytes',
		);
	} finally {
		await files.dispose();
	}

	// The combined rule on its own: plenty of artifact room, but the ledger's bytes count against the session cap.
	const dir2 = await scratchDir('art-cap2-');
	const big = await completedFile(dir2, 'g-big', 'y'.repeat(95));
	const combined = new SessionFiles({
		dir: dir2,
		ledger: ledger([big]),
		artifactLimits: { count: 5, bytes: 1000, sessionBytes: 100 },
	});
	try {
		await combined.addArtifact({ name: 'fits.pdf', mimeType: 'application/pdf', bytes: bytes(5) });
		const error = await assertRejects(
			() => combined.addArtifact({ name: 'over.pdf', mimeType: 'application/pdf', bytes: bytes(1) }),
			ToolError,
		);
		assertEquals(error.code, 'file-unavailable');
		assertStringIncludes(error.message, 'files past 100 bytes');
	} finally {
		await combined.dispose();
	}

	// And by count.
	const dir3 = await scratchDir('art-cap3-');
	const counted = new SessionFiles({ dir: dir3, ledger: null, artifactLimits: { count: 2 } });
	try {
		await counted.addArtifact({ name: 'one.pdf', mimeType: 'application/pdf', bytes: bytes(1) });
		await counted.addArtifact({ name: 'two.pdf', mimeType: 'application/pdf', bytes: bytes(1) });
		await assertRejects(
			() => counted.addArtifact({ name: 'three.pdf', mimeType: 'application/pdf', bytes: bytes(1) }),
			ToolError,
			'already holds 2 server-made files',
		);
	} finally {
		await counted.dispose();
	}
});

Deno.test('D-119: concurrent artifacts reserve before they write, so two cannot squeeze under one cap', async () => {
	const dir = await scratchDir('art-race-');
	const files = new SessionFiles({ dir, ledger: null, artifactLimits: { bytes: 15 } });
	try {
		const outcomes = await Promise.allSettled([
			files.addArtifact({ name: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array(10) }),
			files.addArtifact({ name: 'b.pdf', mimeType: 'application/pdf', bytes: new Uint8Array(10) }),
		]);
		assertEquals(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
		assertEquals(files.list().length, 1);
	} finally {
		await files.dispose();
	}
});

Deno.test('D-119: an artifact needs a directory and an open session', async () => {
	const none = new SessionFiles({ dir: null, ledger: null });
	const noDir = await assertRejects(
		() => none.addArtifact({ name: 'p.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }),
		ToolError,
	);
	assertEquals(noDir.code, 'file-unavailable');
	const dir = await scratchDir('art-closed-');
	const files = new SessionFiles({ dir, ledger: null });
	await files.dispose();
	const closed = await assertRejects(
		() => files.addArtifact({ name: 'p.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }),
		ToolError,
	);
	assertEquals(closed.code, 'unknown-file');
});
