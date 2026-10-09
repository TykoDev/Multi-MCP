/**
 * Browser downloads and file retrieval (E-33; MCP-FILE-TOOL-PLAN.md), against a
 * real Chromium.
 *
 * The 2026-09-05 diagnostic against real Chrome found two defects in the old
 * pipeline: a clicked attachment was downloaded twice (the response sniffer
 * re-triggered what Chromium was already downloading), and a second file with
 * the same suggested name overwrote the first while the ledger recorded a
 * ` (1)` file that did not exist. This suite is the regression for both, and the
 * proof that retrieval returns the bytes the browser actually fetched — through
 * a cookie the fixture requires, so a server-side re-fetch could not have
 * produced them.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { harness, skipUnlessBrowser, textOf } from '../support/harness.ts';

const ignore = skipUnlessBrowser('files e2e');

interface PageState {
	interactive_elements: Array<{ index: number; tag: string; href?: string; label?: string }>;
}

interface FileInfo {
	file_id: string;
	name: string;
	status: string;
	available: boolean;
	size: number;
	mime_type: string;
	auto_download: boolean;
	error?: string;
}

interface Listing {
	session_id: string;
	files: FileInfo[];
	inline_limit_bytes: number;
}

const decoder = new TextDecoder();

function blobOf(result: { content: unknown }): { bytes: Uint8Array; mimeType: string; uri: string } {
	const blocks = result.content as Array<
		{ type: string; resource?: { blob?: string; mimeType?: string; uri?: string } }
	>;
	const block = blocks.find((b) => b.type === 'resource');
	assert(block?.resource?.blob !== undefined, `no embedded resource in ${JSON.stringify(blocks)}`);
	return {
		bytes: Uint8Array.from(atob(block.resource.blob), (c) => c.charCodeAt(0)),
		mimeType: block.resource.mimeType ?? '',
		uri: block.resource.uri ?? '',
	};
}

Deno.test({
	name: 'e2e files: clicked attachments are captured once each, stored by guid, and retrieved byte-for-byte',
	ignore,
	async fn(t) {
		await using h = await harness();
		const nonce = h.site.nonce;

		/** Polls the listing until `predicate` holds or the deadline passes; returns the last listing. */
		const listUntil = async (predicate: (files: FileInfo[]) => boolean, what: string): Promise<Listing> => {
			const deadline = Date.now() + 20_000;
			let last: Listing = { session_id: '', files: [], inline_limit_bytes: 0 };
			while (Date.now() < deadline) {
				last = await h.callJson<Listing>('browser_list_files', {});
				if (predicate(last.files)) return last;
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			throw new Error(`timed out waiting for ${what}; last listing: ${JSON.stringify(last.files)}`);
		};
		const settled = (files: FileInfo[]) => files.every((f) => f.status !== 'pending');
		const completedCount = (files: FileInfo[]) => files.filter((f) => f.status === 'completed').length;

		const clickLink = async (hrefPart: string): Promise<void> => {
			const state = await h.callJson<PageState>('browser_get_state', {});
			const link = state.interactive_elements.find((e) => e.tag === 'a' && (e.href ?? '').includes(hrefPart));
			assert(link !== undefined, `no link containing ${hrefPart} in ${JSON.stringify(state.interactive_elements)}`);
			await h.callText('browser_click', { index: link.index });
		};

		await t.step('an empty session lists no files', async () => {
			await h.callText('browser_navigate', { url: h.site.page('downloads') });
			const listing = await h.callJson<Listing>('browser_list_files', {});
			assertEquals(listing.session_id, 'default');
			assertEquals(listing.files, []);
			assertEquals(listing.inline_limit_bytes, 1024 * 1024);
		});

		let first: FileInfo;
		await t.step('a clicked attachment becomes exactly one completed, available file', async () => {
			await clickLink('body=first');
			const listing = await listUntil((files) => files.length >= 1 && settled(files), 'the first download');
			// The regression: one click, one record — not one click, two records.
			assertEquals(listing.files.length, 1, JSON.stringify(listing.files));
			first = listing.files[0] as FileInfo;
			assertEquals(first.name, 'report.txt');
			assertEquals(first.status, 'completed');
			assertEquals(first.available, true);
			assertEquals(first.size, 5);
			assertEquals(first.mime_type, 'text/plain');
			assertEquals(first.error, undefined);
			// The fixture refused anything without the page's cookie, so the browser's
			// own session fetched this — nothing here re-fetched the URL server-side.
			assert(h.site.hits.includes('/download'), 'the attachment endpoint was requested');
		});

		let second: FileInfo;
		await t.step('a second download with the same suggested name keeps both payloads', async () => {
			await clickLink('body=second');
			const listing = await listUntil((files) => files.length >= 2 && settled(files), 'the second download');
			assertEquals(listing.files.length, 2, JSON.stringify(listing.files));
			assertEquals(completedCount(listing.files), 2, 'no missing-file errors');
			second = listing.files.find((f) => f.file_id !== first.file_id) as FileInfo;
			assertEquals(second.name, 'report (1).txt', 'display names are disambiguated');
			assertEquals(second.size, 6);
			assert(second.file_id !== first.file_id);

			// Re-read the *first* after the second finished: the E-33 overwrite would show here.
			const firstBytes = blobOf(await h.call('browser_get_file', { file_id: first.file_id }));
			assertEquals(decoder.decode(firstBytes.bytes), 'first');
			assertEquals(firstBytes.mimeType, 'text/plain');
			assertEquals(firstBytes.uri, `ttk://session/default/files/${first.file_id}`);
			const secondBytes = blobOf(await h.call('browser_get_file', { file_id: second.file_id }));
			assertEquals(decoder.decode(secondBytes.bytes), 'second');
		});

		await t.step('a hostile suggested filename is a safe display name and an ordinary file', async () => {
			await clickLink('/hostile');
			const listing = await listUntil((files) => files.length >= 3 && settled(files), 'the hostile download');
			const hostile = listing.files.find((f) => f.name.includes('evil'));
			assert(hostile !== undefined, JSON.stringify(listing.files));
			assertEquals(hostile.name, 'evil.txt');
			assertEquals(hostile.status, 'completed');
			const bytes = blobOf(await h.call('browser_get_file', { file_id: hostile.file_id }));
			assertEquals(decoder.decode(bytes.bytes), `hostile-${nonce}`);
		});

		await t.step('a zero-byte attachment is a valid, retrievable file', async () => {
			await clickLink('name=empty.bin');
			const listing = await listUntil((files) => files.length >= 4 && settled(files), 'the empty download');
			const empty = listing.files.find((f) => f.name === 'empty.bin');
			assert(empty !== undefined, JSON.stringify(listing.files));
			assertEquals(empty.status, 'completed');
			assertEquals(empty.available, true);
			assertEquals(empty.size, 0);
			const bytes = blobOf(await h.call('browser_get_file', { file_id: empty.file_id }));
			assertEquals(bytes.bytes.length, 0);
		});

		await t.step('a slow export is listed as pending, is refused until complete, then arrives whole', async () => {
			await clickLink('/slowdownload');
			const pending = await listUntil(
				(files) => files.some((f) => f.name === 'slow.bin'),
				'the slow download to start',
			);
			const slow = pending.files.find((f) => f.name === 'slow.bin') as FileInfo;
			if (slow.status === 'pending') {
				const refused = await h.callError('browser_get_file', { file_id: slow.file_id });
				assertStringIncludes(refused, 'Error: file-unavailable');
				assertStringIncludes(refused, 'still downloading');
			}
			const done = await listUntil(
				(files) => files.some((f) => f.name === 'slow.bin' && f.status === 'completed'),
				'the slow download to complete',
			);
			const finished = done.files.find((f) => f.name === 'slow.bin') as FileInfo;
			const bytes = blobOf(await h.call('browser_get_file', { file_id: finished.file_id }));
			assertEquals(
				decoder.decode(bytes.bytes),
				`chunk0-${nonce};chunk1-${nonce};chunk2-${nonce};chunk3-${nonce};`,
				'every chunk, in order',
			);
		});

		await t.step('link delivery streams the same bytes over authenticated HTTP', async () => {
			const link = await h.call('browser_get_file', { file_id: second.file_id, delivery: 'link' });
			assertEquals(link.isError, undefined, textOf(link));
			const payload = link.structuredContent as { http_url: string; resource_uri: string; file: FileInfo };
			assertEquals(payload.resource_uri, `ttk://session/default/files/${second.file_id}`);
			assert(payload.http_url.endsWith(`/api/v1/sessions/default/files/${second.file_id}`), payload.http_url);
			const resourceLink = (link.content as Array<{ type: string; uri?: string; size?: number }>)
				.find((b) => b.type === 'resource_link');
			assertEquals(resourceLink?.uri, payload.resource_uri);
			assertEquals(resourceLink?.size, 6);

			// The harness key holds mcp:invoke; the path is the one the tool named.
			const response = await h.fetch(new URL(payload.http_url).pathname);
			assertEquals(response.status, 200);
			assertEquals(response.headers.get('content-type'), 'text/plain');
			assertEquals(response.headers.get('content-length'), '6');
			assertEquals(response.headers.get('cache-control'), 'no-store');
			assertEquals(response.headers.get('x-content-type-options'), 'nosniff');
			assertStringIncludes(response.headers.get('content-disposition') ?? '', 'attachment; filename="report (1).txt"');
			assertEquals(response.headers.get('access-control-allow-origin'), null);
			assertEquals(await response.text(), 'second');

			const anonymous = await fetch(`${h.url}${new URL(payload.http_url).pathname}`);
			assertEquals(anonymous.status, 401);
			await anonymous.body?.cancel();
			// R1-5: refused by the front (an encoded slash) before authentication or routing ever see it.
			const traversal = await h.fetch('/api/v1/sessions/default/files/..%2F..%2Fdeno.json');
			assertEquals(traversal.status, 400);
			await traversal.body?.cancel();
		});

		await t.step('the same file is readable as an MCP resource', async () => {
			const read = await h.client.readResource({ uri: `ttk://session/default/files/${first.file_id}` });
			const content = read.contents[0] as { blob?: string; mimeType?: string };
			assertEquals(content.mimeType, 'text/plain');
			assertEquals(decoder.decode(Uint8Array.from(atob(content.blob ?? ''), (c) => c.charCodeAt(0))), 'first');
			const listed = await h.client.listResources({});
			assert(
				listed.resources.some((r) => r.uri === `ttk://session/default/files/${first.file_id}`),
				'completed files are listed as resources',
			);
		});

		await t.step('an unknown or traversal file id is an unknown-file error, never a read', async () => {
			assertStringIncludes(await h.callError('browser_get_file', { file_id: 'not-a-file' }), 'Error: unknown-file');
			assertStringIncludes(await h.callError('browser_get_file', { file_id: '../deno.json' }), 'Error: unknown-file');
			assertStringIncludes(
				await h.callError('browser_list_files', { session_id: 'no-such-session' }),
				'Error: unknown-session',
			);
		});

		await t.step('a rendered PDF is auto-downloaded once and retrievable', async () => {
			await clickLink('/manual.pdf');
			const listing = await listUntil(
				(files) => files.some((f) => f.name === 'manual.pdf' && f.status !== 'pending'),
				'the PDF auto-download',
			);
			const pdfs = listing.files.filter((f) => f.name.startsWith('manual'));
			assertEquals(pdfs.length, 1, `exactly one PDF record: ${JSON.stringify(pdfs)}`);
			const pdf = pdfs[0] as FileInfo;
			assertEquals(pdf.status, 'completed');
			assertEquals(pdf.auto_download, true);
			assertEquals(pdf.mime_type, 'application/pdf');
			const bytes = blobOf(await h.call('browser_get_file', { file_id: pdf.file_id }));
			assertEquals(decoder.decode(bytes.bytes.subarray(0, 8)), '%PDF-1.4');
		});

		await t.step('every download of the session settled to exactly one completed record', async () => {
			const listing = await h.callJson<Listing>('browser_list_files', {});
			assertEquals(listing.files.filter((f) => f.status !== 'completed'), [], 'no failed or canceled records');
			assertEquals(listing.files.length, 6, JSON.stringify(listing.files.map((f) => f.name)));
			assertEquals(new Set(listing.files.map((f) => f.file_id)).size, 6, 'file ids are distinct');
		});

		await t.step('an export over the per-file limit is cancelled in the browser, leaving nothing behind', async () => {
			// The PDF step left the browser in Chromium's viewer, so the links are gone.
			await h.callText('browser_navigate', { url: h.site.page('downloads') });
			const dir = h.gateway.registry.peek('default')?.files.dir;
			assert(dir !== undefined && dir !== null, 'a real session owns a download directory');
			const before = new Set<string>();
			for await (const entry of Deno.readDir(dir)) before.add(entry.name);

			// The fixture advertises 200 MiB against a 100 MiB per-file limit, so the
			// breach is decided from the first progress event rather than by moving
			// the bytes. This is the one place `Browser.cancelDownload` meets a real
			// Chromium: the unit tier can only prove the command was sent.
			await clickLink('/hugedownload');
			const listing = await listUntil(
				(files) => files.length >= 7 && settled(files),
				'the oversized export to settle',
			);
			const huge = listing.files.find((file) => file.name === 'oversized.bin');
			assert(huge !== undefined, JSON.stringify(listing.files.map((file) => file.name)));
			assertEquals(huge.status, 'canceled');
			assertEquals(huge.available, false);
			assertStringIncludes(huge.error ?? '', 'per-file limit');
			assertStringIncludes(
				await h.callError('browser_get_file', { file_id: huge.file_id }),
				'Error: file-unavailable',
			);

			// Cleanup is the half a cancellation is usually missing: neither the guid
			// file nor a `.crdownload` partial may survive in the session's directory.
			const leftovers = async (): Promise<string[]> => {
				const left: string[] = [];
				for await (const entry of Deno.readDir(dir)) if (!before.has(entry.name)) left.push(entry.name);
				return left;
			};
			// **Bounded, and the bound is the finding.** A cancellation is *reported* before its cleanup
			// completes: `#abort` writes the canceled record and notifies listeners, and only then cancels
			// through CDP and removes the partial — so a listing that says `canceled` is not yet a promise
			// about the directory. ERRATUM(E-54) additionally made the removal retry, because Chromium
			// still holds the `.crdownload` handle for a moment after `Browser.cancelDownload` returns and
			// Windows refuses the unlink until it does; measured at ~100 ms across three runs. The window
			// is bounded at 5 s and the assertion is still that the file GOES: a partial that survived
			// would fail here exactly as it did before E-54.
			let left = await leftovers();
			const t0 = Date.now();
			while (left.length > 0 && Date.now() - t0 < 5_000) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				left = await leftovers();
			}
			console.log(`[E-54] the cancelled transfer's partial was gone ${Date.now() - t0} ms after it read canceled`);
			assertEquals(left, [], 'the cancelled transfer left no file behind');
		});

		await t.step('closing the session removes its download directory and invalidates its ids', async () => {
			const record = h.gateway.registry.peek('default');
			assert(record !== undefined);
			const dir = record.files.dir;
			assert(dir !== null, 'a real session owns a download directory');
			await Deno.stat(dir);
			await h.callText('browser_close_session', { session_id: 'default' });
			let present = true;
			try {
				await Deno.stat(dir);
			} catch {
				present = false;
			}
			assertEquals(present, false, 'the directory went with the session');
			assertStringIncludes(
				await h.callError('browser_get_file', { file_id: first.file_id }),
				'Error: unknown-session',
				'a closed session never launches a new browser to answer a file read',
			);
		});
	},
});
