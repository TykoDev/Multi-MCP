/// <reference lib="deno.ns" />
/**
 * The pure decisions of the Files group (run model-providers-ui, F2): a path as crumbs (the root named "Files",
 * each crumb carrying the path up to it), the ancestors a folder's tree item needs listed first, the selection key
 * of a folder, the kind a file name reads as, and the listing cache's subtree purge (BUG-1).
 */
import { assertEquals } from '@std/assert';
import { kindOfName } from './resources_drawer.ts';
import { ancestorsOf, crumbsOf, forgetSubtree, keyOf, parentOf } from './resources_files.ts';

Deno.test('files: the crumbs of a path start at the share root and carry the path up to each segment', () => {
	assertEquals(crumbsOf(''), [{ name: 'Files', path: '' }]);
	assertEquals(crumbsOf('docs'), [{ name: 'Files', path: '' }, { name: 'docs', path: 'docs' }]);
	assertEquals(crumbsOf('docs/reports/2026'), [
		{ name: 'Files', path: '' },
		{ name: 'docs', path: 'docs' },
		{ name: 'reports', path: 'docs/reports' },
		{ name: '2026', path: 'docs/reports/2026' },
	]);
});

Deno.test('files: the ancestors of a path are the root and every folder above it, in listing order', () => {
	assertEquals(ancestorsOf(''), []);
	assertEquals(ancestorsOf('docs'), ['']);
	assertEquals(ancestorsOf('docs/reports/2026'), ['', 'docs', 'docs/reports']);
	assertEquals(parentOf('docs/reports'), 'docs');
	assertEquals(parentOf('docs'), '');
	assertEquals(parentOf(''), '');
});

Deno.test('files: the root folder is the group itself; a sub-folder is its own key', () => {
	assertEquals(keyOf(''), 'group:files');
	assertEquals(keyOf('docs/reports'), 'folder:docs/reports');
});

Deno.test('files: a name reads as a kind by its extension, case-insensitively; none or unknown is other', () => {
	assertEquals(kindOfName('notes.md'), 'text');
	assertEquals(kindOfName('app.TS'), 'code');
	assertEquals(kindOfName('data.json'), 'json');
	assertEquals(kindOfName('photo.jpeg'), 'image');
	assertEquals(kindOfName('archive.tar.gz'), 'archive');
	assertEquals(kindOfName('README'), 'other');
	assertEquals(kindOfName('.env'), 'other');
	assertEquals(kindOfName('thing.unknownext'), 'other');
});

Deno.test('files (BUG-1): forgetting a subtree drops the folder and everything under it, nothing beside it', () => {
	const cache = new Map<string, number>([
		['', 0],
		['docs', 1],
		['docs/reports', 2],
		['docs/reports/2026', 3],
		['docs-archive', 4],
		['notes', 5],
	]);
	forgetSubtree(cache, 'docs');
	assertEquals([...cache.keys()], ['', 'docs-archive', 'notes']);
	forgetSubtree(cache, '');
	assertEquals(cache.size, 0);
});
