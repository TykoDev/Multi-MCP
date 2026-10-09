/**
 * `scripts/model_endpoint.ts` — how the opt-in real-model test leg is configured.
 *
 * Worth pinning because every failure mode here is *silent*. A key this
 * resolver does not recognise, a path it cannot read, or a precedence rule that
 * runs the wrong way all present identically: "no real model is configured",
 * which is exactly what a host with no model legitimately reports. The leg then
 * skips while looking like it decided to, and nobody finds out until a release.
 */
import { assert, assertEquals } from '@std/assert';
import { CONFIG_FILENAME, findConfigFile, parseConfig, resolveModelEndpoint } from '../../scripts/model_endpoint.ts';

const SCRATCH = 'tests/.scratch/model-endpoint';

/** Sets the variables for one case and puts back whatever was there. */
async function withEnv(
	values: Record<string, string | undefined>,
	body: () => void | Promise<void>,
): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(values)) {
		previous.set(name, Deno.env.get(name));
		if (value === undefined) Deno.env.delete(name);
		else Deno.env.set(name, value);
	}
	try {
		await body();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) Deno.env.delete(name);
			else Deno.env.set(name, value);
		}
	}
}

/** Writes a config file and returns its path. */
async function writeConfig(name: string, text: string): Promise<string> {
	await Deno.mkdir(SCRATCH, { recursive: true });
	const path = `${SCRATCH}/${name}`;
	await Deno.writeTextFile(path, text);
	return path;
}

/** The exact shape the file is written in by hand, with a neutral host. */
const OWNER_FILE = `BaseURL: http://10.0.0.5:8610/v1
api_key: vllm
model: example-model-id-q4-k-xl
`;

Deno.test('parseConfig reads the file in the shape it is written by hand', () => {
	const config = parseConfig(OWNER_FILE);
	assertEquals(config.baseurl, 'http://10.0.0.5:8610/v1');
	assertEquals(config.apikey, 'vllm');
	assertEquals(config.model, 'example-model-id-q4-k-xl');
});

Deno.test('parseConfig matches keys loosely, because the file is written by hand', () => {
	// `BaseURL`, `base_url` and `BASE-URL` are one key. A resolver that insisted
	// on one spelling would answer "not configured" to a file that plainly is.
	for (const spelling of ['BaseURL', 'base_url', 'BASE-URL', 'baseUrl']) {
		assertEquals(parseConfig(`${spelling}: http://x/v1`).baseurl, 'http://x/v1');
	}
});

Deno.test('parseConfig ignores comments, blanks and quoting', () => {
	const config = parseConfig(`
# the local box
// also a comment
BaseURL: "http://10.0.0.5:8610/v1"
api_key: 'vllm'

nonsense-without-a-colon
model: gemma
`);
	assertEquals(config.baseurl, 'http://10.0.0.5:8610/v1');
	assertEquals(config.apikey, 'vllm');
	assertEquals(config.model, 'gemma');
});

Deno.test('parseConfig keeps the colons inside a URL', () => {
	// Splitting on the last colon, or on every colon, would truncate the port.
	assertEquals(parseConfig('BaseURL: http://host:8610/v1').baseurl, 'http://host:8610/v1');
});

Deno.test('a config file resolves to an openai endpoint', async () => {
	const path = await writeConfig('owner', OWNER_FILE);
	await withEnv({ TTK_MODEL_CONFIG: path, TTK_MODEL_BASE_URL: undefined }, () => {
		const endpoint = resolveModelEndpoint();
		assert(endpoint !== null);
		assertEquals(endpoint.kind, 'openai');
		assertEquals(endpoint.baseUrl, 'http://10.0.0.5:8610/v1');
		assertEquals(endpoint.models, ['example-model-id-q4-k-xl']);
		// This is the value that becomes `--allow-net`; the scheme and path must
		// not survive into it or the grant is malformed and denies everything.
		assertEquals(endpoint.netAuthority, '10.0.0.5:8610');
	});
});

Deno.test('numbered model keys become an ordered list', async () => {
	// The shape the file grows into when a second model is added to it.
	const path = await writeConfig(
		'two',
		'BaseURL: http://host:1/v1\napi_key: k\nmodel_1: big-one\nmodel_2: small-one\n',
	);
	await withEnv({ TTK_MODEL_CONFIG: path, TTK_MODEL_BASE_URL: undefined, TTK_MODEL_NAME: undefined }, () => {
		assertEquals(resolveModelEndpoint()?.models, ['big-one', 'small-one']);
	});
});

Deno.test('numbered model keys sort numerically, not as text', async () => {
	// `model_10` must follow `model_9`. Sorting the keys as strings would run the
	// suites in an order that silently differs from the one the file lists.
	const lines = ['BaseURL: http://host:1/v1'];
	for (const n of [2, 10, 1, 9]) lines.push(`model_${n}: m${n}`);
	const path = await writeConfig('numbered', `${lines.join('\n')}\n`);
	await withEnv({ TTK_MODEL_CONFIG: path, TTK_MODEL_BASE_URL: undefined, TTK_MODEL_NAME: undefined }, () => {
		assertEquals(resolveModelEndpoint()?.models, ['m1', 'm2', 'm9', 'm10']);
	});
});

Deno.test('a comma-separated models key works too, and duplicates collapse', async () => {
	const path = await writeConfig('csv', 'BaseURL: http://host:1/v1\nmodels: a, b , a\n');
	await withEnv({ TTK_MODEL_CONFIG: path, TTK_MODEL_BASE_URL: undefined, TTK_MODEL_NAME: undefined }, () => {
		assertEquals(resolveModelEndpoint()?.models, ['a', 'b']);
	});
});

Deno.test('TTK_MODEL_NAME narrows a multi-model file to the named models', async () => {
	// How you reproduce a failure on just the model that failed, without editing
	// the file and risking forgetting to put it back.
	const path = await writeConfig('narrow', 'BaseURL: http://host:1/v1\nmodel_1: big\nmodel_2: small\n');
	await withEnv({ TTK_MODEL_CONFIG: path, TTK_MODEL_BASE_URL: undefined, TTK_MODEL_NAME: 'small' }, () => {
		assertEquals(resolveModelEndpoint()?.models, ['small']);
	});
});

Deno.test('a trailing slash on the base URL does not become a double slash', async () => {
	const path = await writeConfig('slash', 'BaseURL: http://host:1/v1/\nmodel: m\n');
	await withEnv({ TTK_MODEL_CONFIG: path, TTK_MODEL_BASE_URL: undefined }, () => {
		assertEquals(resolveModelEndpoint()?.baseUrl, 'http://host:1/v1');
	});
});

Deno.test('the environment overrides the file', async () => {
	const path = await writeConfig('owner2', OWNER_FILE);
	await withEnv({
		TTK_MODEL_CONFIG: path,
		TTK_MODEL_BASE_URL: 'http://elsewhere:9/v1',
		TTK_MODEL_NAME: 'other-model',
	}, () => {
		const endpoint = resolveModelEndpoint();
		// A deliberate override must not be shadowed by a file left lying around,
		// or CI would run against whatever happened to be in the parent directory.
		assertEquals(endpoint?.baseUrl, 'http://elsewhere:9/v1');
		assertEquals(endpoint?.models, ['other-model']);
		assertEquals(endpoint?.source, 'TTK_MODEL_BASE_URL');
	});
});

Deno.test('the key may come from the environment while the rest comes from the file', async () => {
	const path = await writeConfig('nokey', 'BaseURL: http://host:1/v1\nmodel: m\n');
	await withEnv({
		TTK_MODEL_CONFIG: path,
		TTK_MODEL_BASE_URL: undefined,
		TTK_MODEL_API_KEY: 'from-env',
	}, () => {
		assertEquals(resolveModelEndpoint()?.apiKey, 'from-env');
	});
});

Deno.test('a file missing the model is not a usable endpoint', async () => {
	const path = await writeConfig('partial', 'BaseURL: http://host:1/v1\n');
	await withEnv({
		TTK_MODEL_CONFIG: path,
		TTK_MODEL_BASE_URL: undefined,
		ANTHROPIC_API_KEY: undefined,
	}, () => {
		// Half a config is not better than none: an endpoint with no model id
		// would fail on the first call, several layers from the cause.
		assertEquals(resolveModelEndpoint(), null);
	});
});

Deno.test('an unparseable base URL is refused rather than passed on', async () => {
	const path = await writeConfig('bad-url', 'BaseURL: not a url\nmodel: m\n');
	await withEnv({
		TTK_MODEL_CONFIG: path,
		TTK_MODEL_BASE_URL: undefined,
		ANTHROPIC_API_KEY: undefined,
	}, () => {
		assertEquals(resolveModelEndpoint(), null);
	});
});

Deno.test('an Anthropic key is the last resort, not the first', async () => {
	const path = await writeConfig('owner3', OWNER_FILE);
	await withEnv({
		TTK_MODEL_CONFIG: path,
		TTK_MODEL_BASE_URL: undefined,
		ANTHROPIC_API_KEY: 'sk-ant-test',
	}, () => {
		assertEquals(resolveModelEndpoint()?.kind, 'openai', 'a configured local endpoint wins');
	});

	await withEnv({
		TTK_MODEL_CONFIG: `${SCRATCH}/does-not-exist`,
		TTK_MODEL_BASE_URL: undefined,
		ANTHROPIC_API_KEY: 'sk-ant-test',
	}, () => {
		const endpoint = resolveModelEndpoint();
		assertEquals(endpoint?.kind, 'anthropic');
		assertEquals(endpoint?.netAuthority, 'api.anthropic.com');
	});
});

Deno.test('nothing configured is null, not a half-built endpoint', async () => {
	await withEnv({
		TTK_MODEL_CONFIG: `${SCRATCH}/does-not-exist`,
		TTK_MODEL_BASE_URL: undefined,
		ANTHROPIC_API_KEY: undefined,
	}, () => {
		assertEquals(resolveModelEndpoint(), null);
		assertEquals(findConfigFile(), null);
	});
});

Deno.test('the searched filename is the one the README documents', () => {
	// The README, the .gitignore rule and the search all have to name the same
	// file; this is the one place that can catch them drifting apart.
	assertEquals(CONFIG_FILENAME, 'openai_compatible_api');
});
