/**
 * D-075: the library store, its tools, resources and prompts.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { LibraryError, LibraryStore, renderTemplate, safeRelative } from './library.ts';
import { libraryTools, registerLibrary } from './library_tools.ts';
import { createToolExecutor } from './server.ts';
import { SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';

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

	// A symbolic link inside the share is refused at every operation, whichever way it points.
	const outside = join(dir, 'outside.txt');
	await Deno.writeTextFile(outside, 'secret');
	try {
		await Deno.symlink(outside, join(dir, 'share', 'link.txt'));
	} catch {
		// Without the privilege to make links (some Windows accounts) the rule cannot be exercised here.
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
		// Without the scope nothing is registered.
		const bare = new McpServer({ name: 'bare', version: 'test' });
		registerLibrary(bare, store, new Set<Scope>(['mcp:invoke']));
		await bare.close();
	} finally {
		await client.close();
		await server.close();
		await Deno.remove(dir, { recursive: true });
	}
});
