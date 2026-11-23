/**
 * What `README.md` and `docs/` claim about the tool surface, pinned to the code: every tool is named somewhere, and
 * every stated tool count is the count the code defines. Reads every Markdown file, so pages can move or merge.
 */
import { assert, assertEquals } from '@std/assert';
import { walk } from '@std/fs/walk';
import { CATALOG, type ExtensionActions, extensionTools, LibraryStore, libraryTools } from '@tykotech/mcp';

async function docs(): Promise<Array<[string, string]>> {
	const files: Array<[string, string]> = [['README.md', await Deno.readTextFile('README.md')]];
	for await (const entry of walk('docs', { exts: ['.md'], includeDirs: false })) {
		files.push([entry.path, await Deno.readTextFile(entry.path)]);
	}
	return files;
}

Deno.test('docs: every tool is named, and every stated tool count matches the code', async () => {
	const files = await docs();
	const library = libraryTools(new LibraryStore({ dataDir: 'tests/.scratch/never-created' }));
	// Every extension tool, `agent_delegate` included: an action for every name.
	const extension = extensionTools(new Proxy({}, { get: () => () => Promise.resolve({}) }) as ExtensionActions);
	const counts: Record<string, number> = {
		'**N browser tools**': CATALOG.length,
		'**N tools**': CATALOG.length + library.length + extension.length,
		'N library tools': library.length,
		'N extension tools': extension.length,
	};
	const wrong: string[] = [];
	const stated = new Set<string>();
	for (const [path, text] of files) {
		for (const match of text.matchAll(/(\*\*)?(\d+) (browser |library |extension )?tools\b(\*\*)?/g)) {
			const bold = match[1] !== undefined && match[4] !== undefined;
			const kind = `${bold ? '**' : ''}N ${match[3] ?? ''}tools${bold ? '**' : ''}`;
			if (!(kind in counts)) continue;
			stated.add(kind);
			if (Number(match[2]) !== counts[kind]) wrong.push(`${path}: "${match[0]}", the code defines ${counts[kind]}`);
		}
	}
	assertEquals(wrong, []);
	assert(stated.has('**N browser tools**'), 'no file states the browser tool count');

	const text = files.filter(([path]) => path !== 'README.md').map(([, body]) => body).join('\n');
	const names = [...CATALOG, ...library, ...extension].map((tool) => tool.name);
	assertEquals(names.length, counts['**N tools**']);
	assertEquals(names.filter((name) => !text.includes(name)), [], 'a callable tool is not named in docs/');
});
