/// <reference lib="deno.ns" />
import { assert, assertEquals } from '@std/assert';
import { byClass, fake, FakeDocument, type FakeElement } from './test_document.ts';
import { entryIcon, fileTree, joinPath, parentOf, sortEntries, type TreeListing } from './workspace_tree.ts';

/** A workspace as the sandbox would list it, one directory per call, in no particular order. */
const WORKSPACE: Readonly<Record<string, TreeListing>> = {
	'': {
		entries: [
			{ name: 'README.md', type: 'file' },
			{ name: 'src', type: 'directory' },
			{ name: 'file10.txt', type: 'file' },
			{ name: 'file2.txt', type: 'file' },
			{ name: 'docs', type: 'directory' },
			{ name: 'latest', type: 'symlink' },
		],
		truncated: false,
	},
	src: { entries: [{ name: 'main.py', type: 'file' }, { name: 'pkg', type: 'directory' }], truncated: false },
	'src/pkg': { entries: [{ name: '__init__.py', type: 'file' }], truncated: false },
	docs: { entries: [], truncated: false },
};

/** Installs a fake document for the whole (async) test; `withDocument` restores before a promise settles. */
async function withFakeDocument(fn: (document: FakeDocument) => Promise<void>): Promise<void> {
	const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const document = new FakeDocument();
	Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
	try {
		await fn(document);
	} finally {
		if (prior === undefined) delete (globalThis as { document?: unknown }).document;
		else Object.defineProperty(globalThis, 'document', prior);
	}
}

function harness(listings: Record<string, TreeListing | Error> = { ...WORKSPACE }) {
	const asked: string[] = [];
	const opened: string[] = [];
	const tree = fileTree({
		list: (path) => {
			asked.push(path);
			const listing = listings[path];
			if (listing === undefined) return Promise.reject(new Error(`no such directory: ${path}`));
			if (listing instanceof Error) return Promise.reject(listing);
			return Promise.resolve(listing);
		},
		onOpen: (path) => opened.push(path),
	});
	const root = fake(tree.element);
	const rows = (): FakeElement[] => byClass(root, 'ws-tree-row');
	const names = (): string[] => rows().map((row) => row.getAttribute('data-path') ?? '');
	const row = (path: string): FakeElement => {
		const found = rows().find((candidate) => candidate.getAttribute('data-path') === path);
		if (found === undefined) throw new Error(`no row ${path} among ${names().join(', ')}`);
		return found;
	};
	return { tree, root, asked, opened, rows, names, row, listings };
}

/** Lets the tree's pending listings settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test('workspace tree: entries sort folders first, then names naturally', () => {
	assertEquals(sortEntries(WORKSPACE['']!.entries).map((entry) => entry.name), [
		'docs',
		'src',
		'file2.txt',
		'file10.txt',
		'latest',
		'README.md',
	]);
	assertEquals(joinPath('', 'a'), 'a');
	assertEquals(joinPath('a/b', 'c'), 'a/b/c');
	assertEquals(parentOf('a/b/c'), 'a/b');
	assertEquals(parentOf('a'), '');
	assertEquals(entryIcon({ name: 'x', type: 'directory' }, true), 'folder-open');
	assertEquals(entryIcon({ name: 'main.py', type: 'file' }, false), 'file-code');
	assertEquals(entryIcon({ name: 'notes.txt', type: 'file' }, false), 'file');
	assertEquals(entryIcon({ name: 'l', type: 'symlink' }, false), 'link');
});

Deno.test('workspace tree: the root lists on refresh; a folder lists once, when first expanded', async () => {
	await withFakeDocument(async () => {
		const h = harness();
		await h.tree.refresh();
		assertEquals(h.asked, ['']);
		assertEquals(h.names(), ['docs', 'src', 'file2.txt', 'file10.txt', 'latest', 'README.md']);
		assertEquals(fake(h.tree.element).getAttribute('role'), 'tree');
		h.row('src').fire('click');
		await settle();
		assertEquals(h.asked, ['', 'src']);
		assertEquals(h.names(), [
			'docs',
			'src',
			'src/pkg',
			'src/main.py',
			'file2.txt',
			'file10.txt',
			'latest',
			'README.md',
		]);
		assertEquals(h.tree.expanded(), ['src']);
		// Collapsing and expanding again uses what was listed.
		h.row('src').fire('click');
		h.row('src').fire('click');
		await settle();
		assertEquals(h.asked, ['', 'src']);
		// An empty folder says so rather than showing nothing.
		h.row('docs').fire('click');
		await settle();
		assert(byClass(h.root, 'ws-tree-note').some((note) => note.textContent === '(empty)'));
	});
});

Deno.test('workspace tree: a file opens, a link does not, and the open file is selected and revealed', async () => {
	await withFakeDocument(async () => {
		const h = harness();
		await h.tree.refresh();
		h.row('README.md').fire('click');
		h.row('latest').fire('click');
		assertEquals(h.opened, ['README.md'], 'a symbolic link is not opened');
		assertEquals(h.row('latest').disabled || h.row('latest').hasAttribute('disabled'), true);
		// Selecting a nested file expands the folders above it and marks its row.
		h.tree.select('src/pkg/__init__.py');
		await settle();
		await settle();
		assertEquals(h.tree.expanded(), ['src', 'src/pkg']);
		const item = h.row('src/pkg/__init__.py').parentNode!;
		assertEquals(item.getAttribute('aria-selected'), 'true');
		assertEquals(item.getAttribute('aria-level'), '3');
		assertEquals(h.row('README.md').parentNode!.getAttribute('aria-selected'), 'false');
	});
});

Deno.test('workspace tree: refresh keeps open folders, shows new files and drops folders that vanished', async () => {
	await withFakeDocument(async () => {
		const h = harness();
		await h.tree.refresh();
		h.row('src').fire('click');
		await settle();
		h.row('src/pkg').fire('click');
		await settle();
		// The shell adds a file and removes a folder.
		h.listings.src = {
			entries: [{ name: 'main.py', type: 'file' }, { name: 'new.py', type: 'file' }],
			truncated: false,
		};
		await h.tree.refresh();
		assertEquals(h.tree.expanded(), ['src']);
		assert(h.names().includes('src/new.py'));
		assert(!h.names().some((name) => name.startsWith('src/pkg')));
	});
});

Deno.test('workspace tree: keyboard moves through visible rows and opens and closes folders', async () => {
	await withFakeDocument(async (document) => {
		const h = harness();
		await h.tree.refresh();
		const key = (name: string) => h.root.fire('keydown', { key: name });
		h.row('docs').focus();
		key('ArrowDown');
		assertEquals(document.activeElement?.getAttribute('data-path'), 'src');
		key('ArrowRight');
		await settle();
		assertEquals(h.tree.expanded(), ['src']);
		key('ArrowRight');
		assertEquals(document.activeElement?.getAttribute('data-path'), 'src/pkg', 'Right on an open folder enters it');
		key('ArrowLeft');
		assertEquals(
			document.activeElement?.getAttribute('data-path'),
			'src',
			'Left on a closed folder goes to its parent',
		);
		key('ArrowLeft');
		assertEquals(h.tree.expanded(), [], 'Left on an open folder closes it');
		key('End');
		assertEquals(document.activeElement?.getAttribute('data-path'), 'README.md');
		key('Enter');
		assertEquals(h.opened, ['README.md']);
		// One tab stop: the focused row.
		assertEquals(h.rows().filter((row) => row.getAttribute('tabindex') === '0').length, 1);
	});
});

Deno.test('workspace tree: a listing that fails says why, and a truncated one says so', async () => {
	await withFakeDocument(async () => {
		const h = harness({
			'': { entries: [{ name: 'big', type: 'directory' }, { name: 'locked', type: 'directory' }], truncated: false },
			big: { entries: [{ name: 'a', type: 'file' }], truncated: true },
			locked: new Error('the sandbox is at capacity; retry later'),
		});
		await h.tree.refresh();
		h.row('big').fire('click');
		h.row('locked').fire('click');
		await settle();
		const notes = byClass(h.root, 'ws-tree-note').map((note) => note.textContent);
		assert(notes.includes('More entries are not shown (1000 per folder)'), notes.join(' | '));
		assert(notes.includes('the sandbox is at capacity; retry later'), notes.join(' | '));
	});
});
