/**
 * `browser_save_to_share` (R10, design §2.7, D-119): a session file streamed into the library share, through the
 * real dispatcher (`createToolExecutor`) against a real store and real files under `tests/.scratch`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { encodeHex } from '@std/encoding/hex';
import { fromFileUrl, join } from '@std/path';
import type { DownloadRecord } from '@tykotech/browser';
import { captureSession, loadCapture } from '../fixtures/capture_session.ts';
import { LibraryStore } from './library.ts';
import { LIBRARY_OUTPUT } from './library_tools.ts';
import { SessionRegistry } from './registry.ts';
import { DEFAULT_SCOPES, SCOPES } from './scopes.ts';
import { createToolExecutor } from './server.ts';
import type { ToolResult } from './types.ts';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));

async function fixture() {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	const root = await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix: 'save-share-' });
	const downloads = join(root, 'downloads');
	await Deno.mkdir(downloads);
	const records: DownloadRecord[] = [];
	const ledger = {
		downloads: records,
		isRemoteBrowser: false,
		lookup: (guid: string) => records.find((record) => record.guid === guid),
	};
	const session = captureSession(await loadCapture('baseline_button'));
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session, downloads: ledger as never, downloadsDir: downloads }),
	});
	const store = new LibraryStore({ dataDir: join(root, 'data') });
	await store.initialize();
	const record = await registry.resolve(undefined);
	const call = createToolExecutor({ registry, version: 'test', library: store }, 'api-key:owner', new Set(SCOPES));
	return {
		root,
		downloads,
		records,
		record,
		store,
		call,
		registry,
		async [Symbol.asyncDispose]() {
			await registry.shutdown();
			await Deno.remove(root, { recursive: true }).catch(() => {});
		},
	};
}

function ok(result: ToolResult): { path: string; size: number; sha256: string } {
	const call = result as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: unknown };
	assertEquals(call.isError, undefined, call.content[0]?.text);
	const raw = JSON.parse(call.content[0]?.text ?? 'null') as { result: { path: string; size: number; sha256: string } };
	assertEquals(call.structuredContent, raw, 'the dispatcher passed the result unchanged');
	assertEquals(LIBRARY_OUTPUT.browser_save_to_share!.parse(raw.result), raw.result);
	return raw.result;
}

function failure(result: ToolResult): string {
	const call = result as { isError?: boolean; content: Array<{ text?: string }> };
	assertEquals(call.isError, true);
	return call.content[0]?.text ?? '';
}

async function sha256(bytes: Uint8Array): Promise<string> {
	return encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

Deno.test('R10: browser_save_to_share streams a session file into the share and returns its SHA-256', async () => {
	await using f = await fixture();
	const body = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);
	const art = await f.record.files.addArtifact({ name: 'page.pdf', mimeType: 'application/pdf', bytes: body });
	const saved = ok(await f.call('browser_save_to_share', { file_id: art.file_id, path: 'reports/page.pdf' }));
	assertEquals(saved, { path: 'reports/page.pdf', size: body.length, sha256: await sha256(body) });
	assertEquals(saved.sha256, art.sha256, 'the bytes written are the bytes the session held');
	const { bytes } = await f.store.readBytes('reports/page.pdf', 1024 * 1024);
	assertEquals(bytes, body);
	// No temporary left in the share, and the session file's lease is released.
	const names: string[] = [];
	for await (const entry of Deno.readDir(join(f.root, 'data', 'share', 'reports'))) names.push(entry.name);
	assertEquals(names, ['page.pdf']);
	assertEquals(f.record.files.openReads, 0);
});

Deno.test('R10: an existing share path is refused without overwrite, and replaced with it', async () => {
	await using f = await fixture();
	await f.store.writeBytes('kept.txt', new TextEncoder().encode('original'));
	const art = await f.record.files.addArtifact({
		name: 'new.txt',
		mimeType: 'text/plain',
		bytes: new TextEncoder().encode('replacement'),
	});
	const refused = failure(await f.call('browser_save_to_share', { file_id: art.file_id, path: 'kept.txt' }));
	assertStringIncludes(refused, 'Error: invalid-arguments:');
	assertStringIncludes(refused, 'overwrite');
	assertEquals(new TextDecoder().decode((await f.store.readBytes('kept.txt')).bytes), 'original');
	ok(await f.call('browser_save_to_share', { file_id: art.file_id, path: 'kept.txt', overwrite: true }));
	assertEquals(new TextDecoder().decode((await f.store.readBytes('kept.txt')).bytes), 'replacement');
});

Deno.test('R10: a file over the share’s 64 MiB is refused before a byte is copied', async () => {
	await using f = await fixture();
	const path = join(f.downloads, 'g-huge');
	const file = await Deno.open(path, { create: true, write: true });
	await file.truncate(64 * 1024 * 1024 + 1);
	file.close();
	f.records.push({
		guid: 'g-huge',
		url: '',
		suggestedFilename: 'huge.bin',
		fileName: 'huge.bin',
		path,
		fileSize: 64 * 1024 * 1024 + 1,
		receivedBytes: 64 * 1024 * 1024 + 1,
		totalBytes: 64 * 1024 * 1024 + 1,
		fileType: 'bin',
		mimeType: null,
		autoDownload: false,
		state: 'completed',
		startedAt: 1,
		completedAt: 2,
		error: null,
	});
	const refused = failure(await f.call('browser_save_to_share', { file_id: 'g-huge', path: 'huge.bin' }));
	assertStringIncludes(refused, 'Error: file-unavailable:');
	assertStringIncludes(refused, String(64 * 1024 * 1024));
	assertEquals((await f.store.list('')).entries, [], 'nothing reached the share');
});

Deno.test('R10: unknown sessions and files, and paths outside the share, are refused; nothing launches', async () => {
	await using f = await fixture();
	const art = await f.record.files.addArtifact({ name: 'a.txt', mimeType: 'text/plain', bytes: new Uint8Array(1) });
	assertStringIncludes(
		failure(await f.call('browser_save_to_share', { file_id: art.file_id, path: 'a.txt', session_id: 'other' })),
		'Error: unknown-session:',
	);
	assertEquals(f.registry.size, 1, 'a missing session is not created');
	assertStringIncludes(
		failure(await f.call('browser_save_to_share', { file_id: 'art-missing', path: 'a.txt' })),
		'Error: unknown-file:',
	);
	for (const path of ['../escape.txt', '/abs.txt']) {
		assertStringIncludes(
			failure(await f.call('browser_save_to_share', { file_id: art.file_id, path })),
			'Error: invalid-arguments:',
		);
	}
});

Deno.test('R10: without files:write the tool is refused, and the message never names the scope', async () => {
	await using f = await fixture();
	const narrow = createToolExecutor(
		{ registry: f.registry, version: 'test', library: f.store },
		'api-key:viewer',
		new Set(DEFAULT_SCOPES),
	);
	assert(!DEFAULT_SCOPES.includes('files:write'));
	const refused = failure(await narrow('browser_save_to_share', { file_id: 'x', path: 'y' }));
	assertStringIncludes(refused, 'Error: scope-required:');
	assert(!refused.includes('files:write'));
});
