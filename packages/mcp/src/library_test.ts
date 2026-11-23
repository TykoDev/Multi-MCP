/** The library store, its tools, resources and prompts. */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { fromFileUrl, join } from '@std/path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { LibraryError, LibraryStore, renderTemplate, safeRelative } from './library.ts';
import { LIBRARY_OUTPUT, libraryTools, registerLibrary } from './library_tools.ts';
import { createToolExecutor } from './server.ts';
import { SessionRegistry } from './registry.ts';
import { DEFAULT_SCOPES, type Scope, SCOPES } from './scopes.ts';
import { encodeHex } from '@std/encoding/hex';
import type { DownloadRecord } from '@tykotech/browser';
import { captureSession, loadCapture } from '../fixtures/capture_session.ts';
import type { ToolResult } from './types.ts';

async function scratch(): Promise<string> {
	const dir = join('tests/.scratch', `library-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	return dir;
}

Deno.test('library: path rules refuse traversal, absolute paths, control characters and depth', () => {
	assertEquals(safeRelative(''), '');
	assertEquals(safeRelative('./a/b/'), 'a/b');
	assertEquals(safeRelative('.'), '', 'a lone dot is the root');
	for (const bad of ['../x', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', 'a/\u0000b', 'a//b', 'a/./b', 'x'.repeat(256)]) {
		let thrown: unknown = null;
		try {
			safeRelative(bad);
		} catch (cause) {
			thrown = cause;
		}
		assert(thrown instanceof LibraryError, `${JSON.stringify(bad)} was accepted`);
	}
	let deep: unknown = null;
	try {
		safeRelative(Array(33).fill('a').join('/'));
	} catch (cause) {
		deep = cause;
	}
	assert(deep instanceof LibraryError);
});

Deno.test('library: the share reads, writes, lists, moves and deletes inside its root, never through a link', async () => {
	const dir = await scratch();
	const store = new LibraryStore({ dataDir: dir });
	await store.initialize();
	const written = await store.writeBytes('docs/notes.txt', new TextEncoder().encode('hello'));
	assertEquals(written.path, 'docs/notes.txt');
	assertEquals(written.kind, 'file');
	assertEquals(new TextDecoder().decode((await store.readBytes('docs/notes.txt')).bytes), 'hello');
	await store.mkdir('docs/empty');
	const listing = await store.list('docs');
	assertEquals(listing.entries.map((entry) => `${entry.kind}:${entry.name}`), ['directory:empty', 'file:notes.txt']);
	await assertRejects(() => store.remove('docs'), LibraryError, 'not empty');
	await store.move('docs/notes.txt', 'archive/notes.txt');
	assertEquals((await store.stat('archive/notes.txt')).size, 5);
	await assertRejects(() => store.move('archive', 'archive/inner'), LibraryError, 'into itself');
	await assertRejects(() => store.readBytes('archive'), LibraryError, 'not a file');
	await assertRejects(() => store.readBytes('missing.txt'), LibraryError, 'no such path');

	const outside = join(dir, 'outside.txt');
	await Deno.writeTextFile(outside, 'secret');
	try {
		await Deno.symlink(await Deno.realPath(outside), join(dir, 'share', 'link.txt'));
	} catch {
		await Deno.remove(dir, { recursive: true });
		return;
	}
	await assertRejects(() => store.readBytes('link.txt'), LibraryError, 'symbolic');
	await assertRejects(() => store.writeBytes('link.txt', new Uint8Array(1)), LibraryError, 'symbolic');
	assertEquals(
		(await store.list('')).entries.some((entry) => entry.name === 'link.txt'),
		false,
		'links are not listed',
	);
	await store.remove('archive', true);
	await Deno.remove(dir, { recursive: true });
});

Deno.test('library: skills need a SKILL.md with a matching name and a description; prompts render arguments', async () => {
	const dir = await scratch();
	const store = new LibraryStore({ dataDir: dir });
	await store.initialize();
	await assertRejects(() => store.putSkill('Bad Name', { 'SKILL.md': 'x' }), LibraryError, 'lowercase');
	await assertRejects(() => store.putSkill('review', { 'notes.md': 'x' }), LibraryError, 'needs a SKILL.md');
	await assertRejects(
		() => store.putSkill('review', { 'SKILL.md': '---\nname: other\ndescription: d\n---\nbody' }),
		LibraryError,
		'names "other"',
	);
	const skill = await store.putSkill('review', {
		'SKILL.md': '---\nname: review\ndescription: Review a change\n---\nRead the diff.',
		'checklist.md': '- tests',
	});
	assertEquals(skill.description, 'Review a change');
	assertEquals(skill.files, ['SKILL.md', 'checklist.md']);
	assertEquals((await store.readSkillFile('review', 'checklist.md')).text, '- tests');
	assertEquals(store.cached().skills.map((entry) => entry.name), ['review']);
	await store.deleteSkill('review');
	assertEquals((await store.listSkills()).length, 0);

	const prompt = await store.putPrompt('greet', {
		title: 'Greeting',
		arguments: [{ name: 'who', required: true }, { name: 'tone' }],
		template: 'Hello {{who}}, in a {{tone}} tone. {{unknown}}',
	});
	assertEquals(prompt.arguments.length, 2);
	assertEquals((await store.renderPrompt('greet', { who: 'Ada', tone: 'warm' })).text, 'Hello Ada, in a warm tone. ');
	await assertRejects(() => store.renderPrompt('greet', { tone: 'warm' }), LibraryError, 'required');
	assertEquals(renderTemplate(prompt, { who: 'x' }), 'Hello x, in a  tone. ');
	await assertRejects(() => store.putPrompt('greet', { template: '' }), LibraryError, 'non-empty');
	assertEquals(store.cached().prompts.map((entry) => entry.name), ['greet']);
	await store.deletePrompt('greet');
	assertEquals(store.cached().prompts.length, 0);
	await Deno.remove(dir, { recursive: true });
});

Deno.test('library: tools are gated on files:read and files:write through the shared dispatcher', async () => {
	const dir = await scratch();
	const store = new LibraryStore({ dataDir: dir });
	await store.initialize();
	const registry = new SessionRegistry();
	const extraTools = libraryTools(store);
	try {
		assertEquals(libraryTools(null), []);
		const names = extraTools.map((tool) => tool.name);
		assert(names.includes('file_write') && names.includes('skill_put') && names.includes('prompt_render'));
		const reader = createToolExecutor(
			{ registry, version: 'test', extraTools },
			'owner',
			new Set<Scope>(['mcp:invoke', 'files:read']),
		);
		const denied = await reader('file_write', { path: 'a.txt', content: 'x' });
		assert('isError' in denied && denied.isError, 'a reader cannot write');
		const listed = await reader('file_list', {});
		assert('structuredContent' in listed);
		const writer = createToolExecutor(
			{ registry, version: 'test', extraTools },
			'owner',
			new Set<Scope>(['mcp:invoke', 'files:read', 'files:write']),
		);
		const wrote = await writer('file_write', { path: 'a.txt', content: 'x' });
		assert('structuredContent' in wrote);
		const read = await reader('file_read', { path: 'a.txt' });
		assertEquals((read.structuredContent as { result: { content: string } }).result.content, 'x');
		const escaped = await reader('file_read', { path: '../a.txt' });
		assert('isError' in escaped && escaped.isError);
	} finally {
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('library: resources and prompts are served over MCP to a files:read principal', async () => {
	const dir = await scratch();
	const store = new LibraryStore({ dataDir: dir });
	await store.initialize();
	await store.writeBytes('readme.md', new TextEncoder().encode('# hi'));
	await store.putSkill('plan', { 'SKILL.md': '---\nname: plan\ndescription: Plan work\n---\nPlan it.' });
	await store.putPrompt('ask', { arguments: [{ name: 'q', required: true }], template: 'Q: {{q}}' });
	const server = new McpServer({ name: 'test', version: 'test' });
	registerLibrary(server, store, new Set<Scope>(['files:read']));
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'c', version: '0' });
	try {
		await server.connect(serverSide);
		await client.connect(clientSide);
		const resources = await client.listResources();
		assert(resources.resources.some((entry) => entry.uri === 'ttk://share/readme.md'));
		assert(resources.resources.some((entry) => entry.uri === 'ttk://skill/plan'));
		const read = await client.readResource({ uri: 'ttk://share/readme.md' });
		assertEquals((read.contents[0] as { text: string }).text, '# hi');
		const prompts = await client.listPrompts();
		assertEquals(prompts.prompts.map((entry) => entry.name).sort(), ['ask', 'skill:plan']);
		const rendered = await client.getPrompt({ name: 'ask', arguments: { q: 'why' } });
		assertEquals((rendered.messages[0]!.content as { text: string }).text, 'Q: why');
		const skill = await client.getPrompt({ name: 'skill:plan' });
		assert((skill.messages[0]!.content as { text: string }).text.includes('Plan it.'));
		const bare = new McpServer({ name: 'bare', version: 'test' });
		registerLibrary(bare, store, new Set<Scope>(['mcp:invoke']));
		await bare.close();
	} finally {
		await client.close();
		await server.close();
		await Deno.remove(dir, { recursive: true });
	}
});

// --- `browser_save_to_share`: a session file streamed into the library share, through the real dispatcher (`createToolExecutor`) against a real store and real files under `tests/.scratch`. ---

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

Deno.test('browser_save_to_share streams a session file into the share and returns its SHA-256', async () => {
	await using f = await fixture();
	const body = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);
	const art = await f.record.files.addArtifact({ name: 'page.pdf', mimeType: 'application/pdf', bytes: body });
	const saved = ok(await f.call('browser_save_to_share', { file_id: art.file_id, path: 'reports/page.pdf' }));
	assertEquals(saved, { path: 'reports/page.pdf', size: body.length, sha256: await sha256(body) });
	assertEquals(saved.sha256, art.sha256, 'the bytes written are the bytes the session held');
	const { bytes } = await f.store.readBytes('reports/page.pdf', 1024 * 1024);
	assertEquals(bytes, body);
	const names: string[] = [];
	for await (const entry of Deno.readDir(join(f.root, 'data', 'share', 'reports'))) names.push(entry.name);
	assertEquals(names, ['page.pdf']);
	assertEquals(f.record.files.openReads, 0);
});

Deno.test('an existing share path is refused without overwrite, and replaced with it', async () => {
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

Deno.test('a file over the share’s 64 MiB is refused before a byte is copied', async () => {
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

Deno.test('unknown sessions and files, and paths outside the share, are refused; nothing launches', async () => {
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

Deno.test('without files:write the tool is refused, and the message never names the scope', async () => {
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
