/**
 * The model-key names — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TTK_MODEL_API_KEY` — are blanked for every child the
 * server spawns (`CHILD_ENV_BLANKED`), refused in every shipped grant (rule T6), and never read by the server. The
 * container tier proves the blanks in a real Chromium environ.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { walk } from '@std/fs/walk';
import { CHILD_ENV_BLANKED, childEnvOverrides } from '@tykotech/mcp';
import { modelProvidersGrantViolations, PROVIDER_KEY_VARIABLE } from '../../scripts/check_tasks.ts';

const MODEL_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TTK_MODEL_API_KEY'] as const;

Deno.test('model-key names: every child gets them empty, and rule T6 refuses them by the same spelling', () => {
	for (const name of MODEL_KEY_NAMES) {
		assertEquals(childEnvOverrides()[name], '', `${name} is overridden with the empty string, not removed`);
		assert(PROVIDER_KEY_VARIABLE.test(name), `${name} matches T6's provider-key spelling`);
		const violations = modelProvidersGrantViolations(`deno run --deny-ffi --allow-env=TTK_*,${name} m.ts`);
		assertStringIncludes(violations[0] ?? '', name);
	}
	// 21 server and secret names + the 3 model-key names.
	assertEquals(CHILD_ENV_BLANKED.length, 24);
	for (const own of CHILD_ENV_BLANKED.filter((name) => name.startsWith('TTK_') && name !== 'TTK_MODEL_API_KEY')) {
		assert(!PROVIDER_KEY_VARIABLE.test(own), `${own} is a gateway secret the tasks may grant, not a provider key`);
	}
});

Deno.test('model-key names: the only mention in server code under packages/ is the blank list', async () => {
	// The vendored stack is included on purpose: a browser-side read would be the leak the blanks exist for.
	const mentions: string[] = [];
	for await (const entry of walk('packages', { exts: ['.ts'], includeDirs: false, skip: [/[\\/]dist[\\/]/] })) {
		if (entry.name.endsWith('_test.ts')) continue;
		const text = await Deno.readTextFile(entry.path);
		for (const name of MODEL_KEY_NAMES) {
			if (text.includes(name)) mentions.push(`${entry.path.replaceAll('\\', '/')}:${name}`);
		}
	}
	assertEquals(mentions.sort(), MODEL_KEY_NAMES.map((name) => `packages/mcp/src/registry.ts:${name}`));
});
