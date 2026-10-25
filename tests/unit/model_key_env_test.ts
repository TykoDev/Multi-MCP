/**
 * D-143 / D-145 (model-providers-ui B4): the three model-key names — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `TTK_MODEL_API_KEY` — are blanked for every child the server spawns, refused in every shipped grant, and never read
 * by the server. Three registers say the same thing and this file pins them to one another: `CHILD_ENV_BLANKED`
 * (`packages/mcp/src/registry.ts`), rule T6's spelling (`scripts/check_tasks.ts`) and the docs row that says the
 * server never reads them (`docs/reference/environment-variables.md`). The container tier proves the blanks in a real
 * Chromium environ (`tests/container/verify_container.ts`, AC25 / MB8); this is the unit-tier half.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { CHILD_ENV_BLANKED, childEnvOverrides } from '@tykotech/mcp';
import { MODEL_PROVIDERS_ENV } from '../../packages/gateway/src/model_providers.ts';
import { modelProvidersGrantViolations, PROVIDER_KEY_VARIABLE } from '../../scripts/check_tasks.ts';

const MODEL_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TTK_MODEL_API_KEY'] as const;

Deno.test('D-143: the three model-key names are in CHILD_ENV_BLANKED, and every child gets them empty', () => {
	for (const name of MODEL_KEY_NAMES) {
		assert(CHILD_ENV_BLANKED.includes(name), `${name} is blanked for children`);
		assertEquals(childEnvOverrides()[name], '', `${name} is overridden with the empty string, not removed`);
	}
	// 22 (D-127) + 3 (D-143); the register entry and the ownership test carry the same figure.
	assertEquals(CHILD_ENV_BLANKED.length, 25);
});

Deno.test('D-145: the blanked names are exactly what rule T6 refuses in a shipped grant, by the same spelling', () => {
	for (const name of MODEL_KEY_NAMES) {
		assert(PROVIDER_KEY_VARIABLE.test(name), `${name} matches T6's provider-key spelling`);
		const violations = modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${name} m.ts`);
		assertEquals(violations.length, 1, name);
		assertStringIncludes(violations[0] ?? '', name);
	}
	// And the server's own secret names are not: they are blanked for children (D-127) but legitimately granted.
	for (const own of CHILD_ENV_BLANKED.filter((name) => name.startsWith('TTK_') && name !== 'TTK_MODEL_API_KEY')) {
		assert(!PROVIDER_KEY_VARIABLE.test(own), `${own} is a gateway secret, not a provider key`);
	}
});

/**
 * Every `.ts` under `packages/` that is not a test, so the "never read" claim is checked against the code rather than
 * asserted. The vendored stack is included on purpose: a browser-side read would be the leak the blanks exist for.
 */
async function serverSources(dir: string): Promise<string[]> {
	const found: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory) {
			if (entry.name === 'dist' || entry.name === 'node_modules') continue;
			found.push(...await serverSources(path));
		} else if (entry.isFile && entry.name.endsWith('.ts') && !entry.name.endsWith('_test.ts')) found.push(path);
	}
	return found.sort();
}

Deno.test('D-145: the server never reads a model-key name — the only mention under packages/ is the blank list', async () => {
	const mentions: string[] = [];
	for (const path of await serverSources('packages')) {
		const text = await Deno.readTextFile(path);
		for (const name of MODEL_KEY_NAMES) if (text.includes(name)) mentions.push(`${path}:${name}`);
	}
	assertEquals(
		mentions,
		MODEL_KEY_NAMES.map((name) => `packages/mcp/src/registry.ts:${name}`),
		'a new mention under packages/ is a read to justify, or a comment to move',
	);
	// The docs row that makes the same claim is still there, for the test-only names the sampling leg reads.
	const docs = await Deno.readTextFile('docs/reference/environment-variables.md');
	const row = docs.split('\n').find((line) =>
		line.includes('`TTK_MODEL_API_KEY`') && line.includes('`ANTHROPIC_API_KEY`')
	);
	assert(row !== undefined, 'environment-variables.md keeps the row naming TTK_MODEL_API_KEY and ANTHROPIC_API_KEY');
	assertStringIncludes(row, 'The server itself never reads these');
});

Deno.test('D-143: the compose opt-in and the container fixture name the gateway’s variable and carry no key', async () => {
	const overlay = await Deno.readTextFile('docker-compose.providers.yml');
	assert(
		overlay.includes(`      ${MODEL_PROVIDERS_ENV}: /run/secrets/ttk_model_providers`),
		'the opt-in overlay sets it',
	);
	const fixture = JSON.parse(await Deno.readTextFile('tests/container/model_providers.fixture.json')) as {
		version: number;
		providers: Array<Record<string, unknown>>;
	};
	assertEquals(fixture.version, 1);
	assertEquals(fixture.providers.length, 1);
	const [provider] = fixture.providers;
	assertEquals(provider?.kind, 'openai');
	assertEquals(provider?.base_url, 'https://api.openai.com/v1');
	assert(!('api_key' in provider!) && !('api_key_file' in provider!), 'the fixture needs no secret');
});

/**
 * The page that enumerates the blanked names (`docs/concepts/security-model.md`). Once it names `OPENAI_API_KEY` it
 * must name all three and must not carry the retired "a model API key, say, still reaches them" caveat.
 */
const PAGES = ['docs/concepts/security-model.md'];
const pages = await Promise.all(PAGES.map(async (path) => [path, await Deno.readTextFile(path)] as const));
const docsUpdated = pages.some(([, text]) => text.includes('OPENAI_API_KEY'));
Deno.test({
	name: 'D-143 (W5/D5 debt): the pages that enumerate the blanked names name all three and drop the old caveat',
	ignore: !docsUpdated,
	fn: () => {
		for (const [path, text] of pages) {
			if (!text.includes('OPENAI_API_KEY')) continue;
			for (const name of MODEL_KEY_NAMES) assert(text.includes(name), `${path} names ${name}`);
			assert(!text.includes('a model API key, say'), `${path} dropped the D-127 caveat D-143 retires`);
		}
	},
});
