/**
 * `scripts/model_endpoint.ts`, the opt-in real-model leg's resolver. Every failure mode is silent ("no model
 * configured" looks like a host without one), and `netAuthority` becomes the tier's `--allow-net`.
 */
import { assertEquals } from '@std/assert';
import { findConfigFile, parseConfig, resolveModelEndpoint } from '../../scripts/model_endpoint.ts';

const SCRATCH = 'tests/.scratch/model-endpoint';
const NAMES = ['TTK_MODEL_CONFIG', 'TTK_MODEL_BASE_URL', 'TTK_MODEL_NAME', 'TTK_MODEL_API_KEY', 'ANTHROPIC_API_KEY'];

/** Resolves with exactly `values` set among the resolver's variables (a `config` text becomes the file), restoring after. */
async function resolveWith(values: Record<string, string> & { config?: string }) {
	const previous = NAMES.map((name) => [name, Deno.env.get(name)] as const);
	const { config, ...env } = values;
	await Deno.mkdir(SCRATCH, { recursive: true });
	const path = `${SCRATCH}/${crypto.randomUUID()}`;
	if (config !== undefined) await Deno.writeTextFile(path, config);
	for (const name of NAMES) Deno.env.delete(name);
	Deno.env.set('TTK_MODEL_CONFIG', path);
	for (const [name, value] of Object.entries(env)) Deno.env.set(name, value);
	try {
		return { endpoint: resolveModelEndpoint(), file: findConfigFile() };
	} finally {
		for (const [name, value] of previous) value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
	}
}

Deno.test('parseConfig reads the hand-written shape: loose keys, comments, quotes, colons inside a URL', () => {
	assertEquals(
		parseConfig(
			`# the local box\n// also a comment\nBaseURL: "http://10.0.0.5:8610/v1"\napi_key: 'vllm'\n\nnonsense\nmodel: gemma\n`,
		),
		{ baseurl: 'http://10.0.0.5:8610/v1', apikey: 'vllm', model: 'gemma' },
	);
	for (const spelling of ['BaseURL', 'base_url', 'BASE-URL', 'baseUrl']) {
		assertEquals(parseConfig(`${spelling}: http://x:1/v1`).baseurl, 'http://x:1/v1');
	}
});

Deno.test('a config file resolves to an openai endpoint with its models in order', async () => {
	const { endpoint } = await resolveWith({ config: 'BaseURL: http://10.0.0.5:8610/v1/\napi_key: vllm\nmodel: m\n' });
	assertEquals(endpoint?.kind, 'openai');
	assertEquals(endpoint?.baseUrl, 'http://10.0.0.5:8610/v1', 'no trailing slash');
	assertEquals(endpoint?.apiKey, 'vllm');
	assertEquals(endpoint?.netAuthority, '10.0.0.5:8610', 'no scheme or path in the --allow-net value');
	const numbered = 'BaseURL: http://h:1/v1\nmodel_2: m2\nmodel_10: m10\nmodel_1: m1\nmodel_9: m9\n';
	assertEquals((await resolveWith({ config: numbered })).endpoint?.models, ['m1', 'm2', 'm9', 'm10']);
	assertEquals((await resolveWith({ config: 'BaseURL: http://h:1/v1\nmodels: a, b , a\n' })).endpoint?.models, [
		'a',
		'b',
	]);
	assertEquals((await resolveWith({ config: numbered, TTK_MODEL_NAME: 'm9' })).endpoint?.models, ['m9']);
	assertEquals((await resolveWith({ config: numbered, TTK_MODEL_API_KEY: 'env' })).endpoint?.apiKey, 'env');
});

Deno.test('precedence: the environment, then the file, then an Anthropic key; half a config is none', async () => {
	const file = 'BaseURL: http://h:1/v1\nmodel: m\n';
	const env = await resolveWith({ config: file, TTK_MODEL_BASE_URL: 'http://elsewhere:9/v1', TTK_MODEL_NAME: 'o' });
	assertEquals([env.endpoint?.baseUrl, env.endpoint?.models, env.endpoint?.source], [
		'http://elsewhere:9/v1',
		['o'],
		'TTK_MODEL_BASE_URL',
	]);
	assertEquals((await resolveWith({ config: file, ANTHROPIC_API_KEY: 'sk-ant' })).endpoint?.kind, 'openai');
	const anthropic = (await resolveWith({ ANTHROPIC_API_KEY: 'sk-ant' })).endpoint;
	assertEquals([anthropic?.kind, anthropic?.netAuthority], ['anthropic', 'api.anthropic.com']);
	assertEquals(await resolveWith({}), { endpoint: null, file: null });
	assertEquals((await resolveWith({ config: 'BaseURL: http://h:1/v1\n' })).endpoint, null, 'no model');
	assertEquals((await resolveWith({ config: 'BaseURL: not a url\nmodel: m\n' })).endpoint, null, 'no valid URL');
});
