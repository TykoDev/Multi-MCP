/**
 * The two claims `docs/` makes about the catalog, pinned to the catalog itself.
 *
 * Every shipped file that states the current catalog size is read and compared against `CATALOG.length`, so the
 * front door cannot go stale when a tool is added. `CHANGELOG.md` states historical counts and is deliberately not
 * pinned; the files below are listed by name and each names the claim it makes.
 *
 * The second test requires every catalog name to occur somewhere in `docs/`, so no tool a client can call is missing
 * from the operator-facing documentation.
 *
 * @module
 */
import { assert, assertEquals } from '@std/assert';
import { CATALOG } from '../../packages/mcp/src/catalog.ts';

/** Every shipped file that states the size of the catalog as it stands, with the claim it makes. */
const CLAIMS: ReadonlyArray<{ readonly file: string; readonly claim: RegExp }> = [
	{ file: 'README.md', claim: /\*\*(\d+) browser tools\*\*/g },
	{ file: 'docs/index.md', claim: /\*\*(\d+) browser tools\*\*/g },
	{ file: 'docs/reference/mcp-tools.md', claim: /\*\*(\d+) browser tools\*\*/g },
];

Deno.test('docs: every shipped catalog-size claim states the catalog size', async () => {
	const wrong: string[] = [];
	let claimsFound = 0;
	for (const { file, claim } of CLAIMS) {
		const text = await Deno.readTextFile(file);
		const matches = [...text.matchAll(claim)];
		assert(matches.length > 0, `${file} no longer states a catalog size in the form this test pins`);
		for (const match of matches) {
			claimsFound++;
			if (Number(match[1]) !== CATALOG.length) wrong.push(`${file} says ${match[1]}`);
		}
	}
	assertEquals(wrong, [], `the catalog holds ${CATALOG.length} tools`);
	// Non-vacuity: one claim per file. A file that stops making its claim fails above; a claim added or
	// silently dropped fails here.
	assertEquals(claimsFound, 3, 'a shipped catalog-size claim was added or removed');
});

/** Every Markdown file under `docs/`, concatenated once. */
async function docsText(): Promise<string> {
	const parts: string[] = [];
	for await (const entry of Deno.readDir('docs')) {
		if (entry.isFile && entry.name.endsWith('.md')) parts.push(await Deno.readTextFile(`docs/${entry.name}`));
		if (!entry.isDirectory) continue;
		for await (const inner of Deno.readDir(`docs/${entry.name}`)) {
			if (inner.isFile && inner.name.endsWith('.md')) {
				parts.push(await Deno.readTextFile(`docs/${entry.name}/${inner.name}`));
			}
		}
	}
	return parts.join('\n');
}

Deno.test('docs: every shipped tool is named somewhere under docs/', async () => {
	const text = await docsText();
	assert(text.length > 10_000, 'docs/ did not read; the assertion below would pass vacuously');
	const undocumented = CATALOG.map((tool) => tool.name).filter((name) => !text.includes(name));
	assertEquals(
		undocumented,
		[],
		'a tool a client can call and an operator cannot read about is a tool nobody can deploy deliberately',
	);
});
