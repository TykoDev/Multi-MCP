/**
 * BUG-9 (model-providers-ui fix round): the composer's key placeholder has two homes — the SPA writes it
 * (`packages/web/src/config_composer.ts`, `KEY_PLACEHOLDER`) and the parser refuses it
 * (`packages/gateway/src/model_providers.ts`, `PLACEHOLDER_KEY`). Neither module may import the other (the SPA is
 * framework-free and ships to the browser; the gateway never imports web code), so this test reads both sources and
 * pins the two literals to each other: a placeholder the SPA renames would otherwise be admitted as a key again.
 */
import { assert, assertEquals } from '@std/assert';

const SOURCES = {
	parser: ['packages/gateway/src/model_providers.ts', /export const PLACEHOLDER_KEY = '([^']+)';/],
	composer: ['packages/web/src/config_composer.ts', /export const KEY_PLACEHOLDER = '([^']+)';/],
} as const;

async function literal(name: keyof typeof SOURCES): Promise<string> {
	const [path, pattern] = SOURCES[name];
	const match = (await Deno.readTextFile(path)).match(pattern);
	assert(match !== null, `${path} defines the placeholder literal`);
	return match[1]!;
}

Deno.test('BUG-9: the parser refuses exactly the placeholder the composer writes', async () => {
	const [parser, composer] = await Promise.all([literal('parser'), literal('composer')]);
	assertEquals(parser, composer);
	assertEquals(parser, 'REPLACE_WITH_KEY');
});
