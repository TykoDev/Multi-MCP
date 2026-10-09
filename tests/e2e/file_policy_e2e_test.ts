/**
 * B2.9 — `sha256`, `Range` and `browser_file_policy` against a real download.
 *
 * The unit tier proves the range arithmetic, the digest and the policy constants against files on
 * disk. This suite proves the three of them on a file **the browser actually downloaded**, over the
 * HTTP endpoint a client would use, because that is the seam the unit tier cannot reach: the digest
 * is started by the download-completion hook rather than by a test calling it, and the range is
 * served by the gateway route rather than by `SessionFiles` directly.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { encodeHex } from '@std/encoding/hex';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('file_policy e2e');

/**
 * A body long enough that a range is a genuine window rather than the whole file, and short enough
 * that it fits in the query string `browser_download` accepts (the tool caps a URL at 2048).
 */
const BODY = Array.from({ length: 20 }, (_, i) => `line ${i} of the downloaded attachment\n`).join('');

interface FileInfo {
	file_id: string;
	name: string;
	status: string;
	available: boolean;
	size: number;
	sha256: string | null;
}
interface Listing {
	session_id: string;
	files: FileInfo[];
	inline_limit_bytes: number;
}
interface Policy {
	retention: { mode: string; session_idle_ttl_s: number; open_read_grace_ms: number };
	max_files_per_session: number;
	max_file_bytes: number;
	max_session_bytes: number;
	inline_limit_bytes: number;
	transfer_deadline_ms: number;
	range_supported: boolean;
}
interface GetFile {
	delivery: string;
	http_url: string | null;
	range_supported?: boolean;
	file: FileInfo;
}

Deno.test({
	name: 'e2e file_policy (B2.9): a real download reports its sha256, serves a Range, and the policy is the constants',
	ignore,
	async fn(t) {
		await using h = await harness();
		let file: FileInfo | undefined;

		await t.step('the policy answers before any file exists, and reports the enforced numbers', async () => {
			const policy = await h.callJson<Policy>('browser_file_policy', {});
			console.log(`[B2.9] browser_file_policy: ${JSON.stringify(policy)}`);
			assertEquals(policy.retention.mode, 'session-lifetime');
			assertEquals(policy.max_files_per_session, 100);
			assertEquals(policy.max_file_bytes, 100 * 1024 * 1024);
			assertEquals(policy.max_session_bytes, 500 * 1024 * 1024);
			assertEquals(policy.transfer_deadline_ms, 5 * 60_000);
			assertEquals(policy.inline_limit_bytes, 1024 * 1024);
			assertEquals(policy.range_supported, true);
			assert(policy.retention.session_idle_ttl_s > 0);
			assert(policy.retention.open_read_grace_ms > 0);
		});

		await t.step('a downloaded file carries a sha256 that matches an independent digest', async () => {
			// `browser_download`, not `browser_navigate`: navigating to an attachment ends in
			// `net::ERR_ABORTED` because the document never commits, and the download tool is the one that
			// knows that is the expected outcome (B1.12).
			await h.callJson('browser_download', {
				url: `${h.site.url}opendownload?name=b29.txt&body=${encodeURIComponent(BODY)}`,
			});
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				const listing = await h.callJson<Listing>('browser_list_files', {});
				const done = listing.files.find((entry) => entry.status === 'completed' && entry.available);
				if (done !== undefined && done.sha256 !== null) {
					file = done;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			assert(file !== undefined, 'the download never completed with a digest');
			console.log(`[B2.9] listing entry: ${JSON.stringify(file)}`);
			assertEquals(file.size, new TextEncoder().encode(BODY).length);

			// The independent computation: the whole body through the platform digest, which is a
			// different code path from the module's chunked stream over the file on disk.
			const expected = encodeHex(
				new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BODY))),
			);
			console.log(`[B2.9] sha256 reported=${file.sha256} independent=${expected}`);
			assertEquals(file.sha256, expected);
		});

		await t.step('delivery "stream" hands back the URL and says the endpoint takes a Range', async () => {
			assert(file !== undefined);
			const result = await h.call('browser_get_file', { file_id: file.file_id, delivery: 'stream' });
			assertEquals(result.isError, undefined, JSON.stringify(result.content));
			const payload = result.structuredContent as GetFile;
			console.log(`[B2.9] browser_get_file delivery=stream: ${JSON.stringify(payload)}`);
			assertEquals(payload.delivery, 'stream');
			assertEquals(payload.range_supported, true);
			assertEquals(payload.file.sha256, file.sha256);
			assert(payload.http_url !== null && payload.http_url.endsWith(`/files/${file.file_id}`), `${payload.http_url}`);
		});

		await t.step('the endpoint serves the requested window byte-for-byte, and refuses one past the end', async () => {
			assert(file !== undefined);
			const path = `/api/v1/sessions/default/files/${file.file_id}`;
			const bytes = new TextEncoder().encode(BODY);

			const ranged = await h.fetch(path, { headers: { range: 'bytes=100-199' } });
			console.log(
				`[B2.9] Range bytes=100-199 -> ${ranged.status} content-range=${ranged.headers.get('content-range')}`,
			);
			assertEquals(ranged.status, 206);
			assertEquals(ranged.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
			assertEquals(ranged.headers.get('content-length'), '100');
			assertEquals(new Uint8Array(await ranged.arrayBuffer()), bytes.slice(100, 200));

			// The tail, through the suffix spelling a resumed download uses.
			const tail = await h.fetch(path, { headers: { range: 'bytes=-50' } });
			assertEquals(tail.status, 206);
			assertEquals(new Uint8Array(await tail.arrayBuffer()), bytes.slice(bytes.length - 50));

			const past = await h.fetch(path, { headers: { range: `bytes=${bytes.length}-${bytes.length + 10}` } });
			console.log(`[B2.9] Range past the end -> ${past.status} content-range=${past.headers.get('content-range')}`);
			assertEquals(past.status, 416, 'refused, never clamped');
			assertEquals(past.headers.get('content-range'), `bytes */${bytes.length}`);
			await past.body?.cancel();

			// And the whole file still answers 200 with the full length, advertising that it takes ranges.
			const whole = await h.fetch(path);
			assertEquals(whole.status, 200);
			assertEquals(whole.headers.get('accept-ranges'), 'bytes');
			assertEquals(whole.headers.get('content-length'), String(bytes.length));
			assertEquals(new Uint8Array(await whole.arrayBuffer()), bytes);
			console.log('[B2.9] whole-file read is unchanged: 200, full length, accept-ranges advertised');
		});
	},
});
