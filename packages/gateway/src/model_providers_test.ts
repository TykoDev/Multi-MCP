/** The providers file parser: schema, key sources, headers, the `base_url` predicate branch by branch, `default`. */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
	classifyHost,
	judgeBaseUrl,
	loadModelProviders,
	MODEL_KEY_REDACTION_MIN_CHARS,
	MODEL_PROVIDER_BOUNDS,
	MODEL_PROVIDERS_ENV,
	MODEL_PROVIDERS_FILE_MAX_BYTES,
	type ModelProvidersConfig,
	PLACEHOLDER_KEY,
	REFUSED_HEADER_NAMES,
} from './model_providers.ts';
import { SecretError } from './secrets.ts';
import { REDACTION_MIN_LENGTH } from '@tykotech/agents';

const FILE = '/etc/tykotech/providers.json';
const KEY_FILE = '/run/secrets/model_key';
/** Long enough to be redacted; distinctive enough that a grep for it in an error is meaningful. */
const KEY = 'sk-tt-0123456789abcdefghijklmnopqrstuv';
const SHORT_KEY = 'sk-short';
const KEYED_FILE = { files: { [KEY_FILE]: `${KEY}\n` } };

interface LoadOptions {
	readonly extra?: Record<string, unknown>;
	readonly files?: Readonly<Record<string, string>>;
	readonly warn?: (line: string) => void;
	readonly raw?: string;
}

const provider = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: 'local',
	kind: 'openai',
	base_url: 'http://127.0.0.1:11434/v1',
	models: ['llama3'],
	...over,
});

const fileOf = (providers: unknown[], extra: Record<string, unknown> = {}): string =>
	`${JSON.stringify({ version: 1, providers, ...extra })}\n`;

function load(providers: unknown[], options: LoadOptions = {}): Promise<ModelProvidersConfig | null> {
	const files: Record<string, string> = { [FILE]: options.raw ?? fileOf(providers, options.extra), ...options.files };
	return loadModelProviders({ [MODEL_PROVIDERS_ENV]: FILE }, {
		readFile: (path) => path in files ? Promise.resolve(files[path]!) : Promise.reject(new Deno.errors.NotFound(path)),
		...(options.warn === undefined ? {} : { warn: options.warn }),
	});
}

async function admitted(providers: unknown[], options: LoadOptions = {}): Promise<ModelProvidersConfig> {
	const config = await load(providers, options);
	assert(config !== null);
	return config;
}

/** The first provider of an admitted file of one, with the warnings it drew. */
async function one(over: Record<string, unknown>, options: LoadOptions = {}) {
	const warnings: string[] = [];
	const config = await admitted([provider(over)], { ...options, warn: (line) => warnings.push(line) });
	return { ...config.providers[0]!, warnings };
}

/** Every refusal is a `SecretError` naming the variable and the file, never the key, and emits no warning. */
async function refused(providers: unknown[], options: LoadOptions = {}): Promise<string> {
	const warnings: string[] = [];
	const error = await assertRejects(
		() => load(providers, { ...options, warn: (line) => warnings.push(line) }),
		SecretError,
	);
	assertStringIncludes(error.message, `${MODEL_PROVIDERS_ENV} (${FILE}): `);
	assert(!error.message.includes(KEY) && !error.message.includes(SHORT_KEY), `a key leaked into: ${error.message}`);
	assertEquals(warnings, [], 'a refused file emits no warning');
	return error.message;
}

/** Each single-provider override is refused with its phrase. */
async function refuses(cases: ReadonlyArray<readonly [Record<string, unknown>, string, LoadOptions?]>): Promise<void> {
	for (const [over, phrase, options] of cases) {
		assertStringIncludes(await refused([provider(over)], options), phrase, JSON.stringify(over));
	}
}

// --- the file -----------------------------------------------------------------------------------------------------

Deno.test('providers file: absent when unset; unreadable, oversized, non-JSON, BOM and malformed shapes are refused', async () => {
	const none = { readFile: () => Promise.reject(new Deno.errors.NotFound('x')) };
	assertEquals(await loadModelProviders({}, none), null);
	assertEquals(await loadModelProviders({ [MODEL_PROVIDERS_ENV]: '  ' }, none), null);
	const unreadable = await assertRejects(() => loadModelProviders({ [MODEL_PROVIDERS_ENV]: FILE }, none), SecretError);
	assertStringIncludes(unreadable.message, 'the file cannot be read');
	const big = fileOf([provider({ label: 'x'.repeat(64) })]).padEnd(MODEL_PROVIDERS_FILE_MAX_BYTES + 1, ' ');
	for (
		const [raw, phrase] of [
			[big, 'the file is larger than 128 KiB'],
			['{"version": 1, "providers": [\n', 'the file is not valid JSON'],
			[`﻿${fileOf([provider()])}`, 'byte-order mark'],
			[`${fileOf([provider()])}\n\n`, 'trailing whitespace'],
			['{"version": 2, "providers": []}\n', 'field version'],
			[fileOf([provider()], { extra: true }), 'unknown field extra, field (file)'],
			[fileOf([]), 'too short or too few, field providers'],
			[
				fileOf(Array.from({ length: 17 }, (_, i) => provider({ id: `p${i}` }))),
				'too long or too many, field providers',
			],
		] as const
	) assertStringIncludes(await refused([], { raw }), phrase);
	await refuses([
		[{ bogus: 1 }, 'unknown field bogus, entry 1, field (entry)'],
		[{ models: 'llama3' }, 'wrong type, entry 1, field models'],
		[{ id: 'Local' }, 'malformed, entry 1, field id'],
		[{ id: '9x' }, 'entry 1, field id'],
		[{ id: `a${'b'.repeat(32)}` }, 'entry 1, field id'],
	]);
	assertStringIncludes(await refused([provider(), provider({ id: 'b', kind: 'other' })]), 'entry 2, field kind');
	assertStringIncludes(await refused([provider(), provider()]), 'duplicate provider id, entry 2, field id');
	assertEquals((await one({ id: 'a-b_c9' })).id, 'a-b_c9');
});

Deno.test('providers file: models, default_model and the bounded settings, with their defaults', async () => {
	await refuses([
		[{ models: [] }, 'too short or too few, entry 1, field models'],
		[{ models: Array.from({ length: 65 }, (_, i) => `m${i}`) }, 'too long or too many, entry 1, field models'],
		[{ models: ['ok', 'bad model'] }, 'malformed, entry 1, field models[1]'],
		[{ models: ['-x'] }, 'entry 1, field models[0]'],
		[{ default_model: 'other' }, 'not one of the listed models, entry 1, field default_model'],
		[{ max_tokens_param: 'tokens' }, 'entry 1, field max_tokens_param'],
		[{ max_steps: 0 }, 'entry 1, field max_steps'],
		[{ max_steps: 65 }, 'entry 1, field max_steps'],
		[{ max_steps: 2.5 }, 'entry 1, field max_steps'],
		[{ max_output_tokens: 255 }, 'entry 1, field max_output_tokens'],
		[{ max_output_tokens: 32_769 }, 'entry 1, field max_output_tokens'],
		[{ token_budget: 999 }, 'entry 1, field token_budget'],
		[{ token_budget: 4_000_001 }, 'entry 1, field token_budget'],
		[{ label: '' }, 'entry 1, field label'],
		[{ label: 'x'.repeat(65) }, 'entry 1, field label'],
	]);
	const named = await one({ models: ['a/b:1.0', 'c.d'], default_model: 'c.d' });
	assertEquals([named.models, named.defaultModel], [['a/b:1.0', 'c.d'], 'c.d']);
	assertEquals((await one({ models: ['x', 'y'] })).defaultModel, 'x', 'the first model when none is named');
	const d = await one({});
	assertEquals(
		[
			d.label,
			d.maxTokensParam,
			d.maxSteps,
			d.maxOutputTokens,
			d.tokenBudget,
			d.headers,
			d.allowHttp,
			d.apiKey,
			d.keySource,
		],
		[
			'local',
			'max_tokens',
			MODEL_PROVIDER_BOUNDS.maxSteps.default,
			MODEL_PROVIDER_BOUNDS.maxOutputTokens.default,
			MODEL_PROVIDER_BOUNDS.tokenBudget.default,
			{},
			false,
			null,
			'none',
		],
	);
	const set = await one({
		label: 'Local llama',
		max_tokens_param: 'max_completion_tokens',
		max_steps: 64,
		max_output_tokens: 256,
		token_budget: 4_000_000,
	});
	assertEquals(
		[set.label, set.maxTokensParam, set.maxSteps, set.maxOutputTokens, set.tokenBudget],
		['Local llama', 'max_completion_tokens', 64, 256, 4_000_000],
	);
});

// --- the key --------------------------------------------------------------------------------------------------------

Deno.test('providers file: one key source; an inline key or a key file is judged and refused by field, never echoed', async () => {
	await refuses([
		[
			{ api_key: KEY, api_key_file: KEY_FILE },
			'set one of api_key or api_key_file, entry 1, field api_key',
			KEYED_FILE,
		],
		[{ api_key: '' }, 'the key is empty, entry 1, field api_key'],
		[{ api_key: 'a'.repeat(513) }, 'the key is longer than 512 characters, entry 1, field api_key'],
		[{ api_key: `${KEY} ${KEY}` }, 'the key contains whitespace, entry 1, field api_key'],
		[{ api_key: `${KEY}\n` }, 'the key contains whitespace'],
		[{ api_key: 42 }, 'wrong type, entry 1, field api_key'],
		[{ api_key_file: 'secrets/key' }, 'an absolute path is required, entry 1, field api_key_file', {
			files: { 'secrets/key': KEY },
		}],
		[{ api_key_file: KEY_FILE }, 'the key file cannot be read, entry 1, field api_key_file'],
		[{ api_key_file: KEY_FILE }, 'trailing whitespace after the final line, entry 1, field api_key_file', {
			files: { [KEY_FILE]: `${KEY}\n\n` },
		}],
		[{ api_key_file: KEY_FILE }, 'leading or trailing whitespace, entry 1, field api_key_file', {
			files: { [KEY_FILE]: ` ${KEY}` },
		}],
		[{ api_key_file: KEY_FILE }, 'file is empty, entry 1, field api_key_file', { files: { [KEY_FILE]: '' } }],
		[{ api_key_file: KEY_FILE }, 'the key contains whitespace, entry 1, field api_key_file', {
			files: { [KEY_FILE]: `${KEY} tail\n` },
		}],
		// A CRLF key file is still a multi-line secret.
		[{ api_key_file: KEY_FILE }, 'field api_key_file', { files: { [KEY_FILE]: `${KEY}\r\n` } }],
		[
			{ kind: 'anthropic', base_url: 'https://api.anthropic.com' },
			'an anthropic provider needs a key, entry 1, field api_key',
		],
		// The drafted-file placeholder is never a key, inline or file-backed.
		[
			{ base_url: 'https://api.openai.com/v1', api_key: PLACEHOLDER_KEY },
			'the key is the composer placeholder, entry 1, field api_key',
		],
		[
			{ base_url: 'https://api.openai.com/v1', api_key_file: KEY_FILE },
			'composer placeholder, entry 1, field api_key_file',
			{
				files: { [KEY_FILE]: `${PLACEHOLDER_KEY}\n` },
			},
		],
	]);
	assertStringIncludes(
		await refused([provider(), provider({ id: 'b', base_url: 'https://api.openai.com/v1', api_key: PLACEHOLDER_KEY })]),
		'the key is the composer placeholder, entry 2, field api_key',
	);
	const inline = await one({ api_key: 'a'.repeat(512) });
	assertEquals([inline.apiKey, inline.keySource], ['a'.repeat(512), 'inline']);
	const fromFile = await one({ api_key_file: KEY_FILE }, KEYED_FILE);
	assertEquals([fromFile.apiKey, fromFile.keySource], [KEY, 'file'], 'exactly one trailing newline is stripped');
	assertEquals((await one({ kind: 'anthropic', base_url: 'https://api.anthropic.com', api_key: KEY })).apiKey, KEY);
	assertEquals((await one({})).apiKey, null, 'an openai provider needs no key (local servers)');
});

Deno.test('providers file: a key under the redaction threshold is admitted with one warning, emitted only once admitted', async () => {
	assertEquals(MODEL_KEY_REDACTION_MIN_CHARS, REDACTION_MIN_LENGTH, 'the gateway and the loop redactor agree');
	const warnings: string[] = [];
	const config = await admitted([provider({ api_key: SHORT_KEY }), provider({ id: 'long', api_key: KEY })], {
		warn: (line) => warnings.push(line),
	});
	assertEquals(config.providers[0]!.apiKey, SHORT_KEY);
	assertEquals(warnings, ['model provider local: short key: not redacted from task output']);
	assertEquals((await one({ api_key: 'k'.repeat(16) })).warnings, [], 'sixteen characters is the threshold, inclusive');
	// Entry 1 would warn; entry 2 is refused — so nothing is emitted (asserted by `refused`).
	await refused([provider({ api_key: SHORT_KEY }), provider({ id: 'b', models: [] })]);
});

Deno.test('providers file: headers are bounded, lower-case, and never a credential or a routing header', async () => {
	assertEquals((await one({ headers: { 'x-tenant': 'acme', 'user-agent': 'tykotech/1' } })).headers, {
		'x-tenant': 'acme',
		'user-agent': 'tykotech/1',
	});
	await refuses([
		[{ headers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`h${i}`, 'v'])) }, 'more than 8 headers'],
		[{ headers: { 'X-Tenant': 'acme' } }, 'a header name is not lower-case [a-z0-9-], entry 1, field headers'],
		[{ headers: { 'x tenant': 'a' } }, 'entry 1, field headers'],
		[{ headers: { ':authority': 'other.example' } }, 'a header name is not lower-case'],
		[
			{ headers: { 'x-tenant': 'x'.repeat(257) } },
			'the value is longer than 256 characters, entry 1, field headers.x-tenant',
		],
		[
			{ headers: { 'x-tenant': 'a\r\nx-other: b' } },
			'the value contains a line break, entry 1, field headers.x-tenant',
		],
		[{ headers: { 'x-tenant': 1 } }, 'wrong type, entry 1, field headers'],
		[
			{ headers: { host: 'other.example' } },
			'a routing header is refused; the host is base_url, entry 1, field headers.host',
		],
		...[...REFUSED_HEADER_NAMES, 'api-key', 'x-auth-token', 'my-secret', 'openai-key'].map((name) =>
			[
				{ base_url: 'https://api.example.com/v1', api_key: KEY, headers: { [name]: KEY } },
				`a credential header is refused; use api_key, entry 1, field headers.${name}`,
			] as const
		),
	]);
});

// --- base_url --------------------------------------------------------------------------------------------------------

const PUBLIC = 'plaintext HTTP to a public address, entry 1, field base_url';
const LINK_LOCAL = 'link-local address, entry 1, field base_url';

Deno.test('base_url: the serviceUrl rules — no userinfo, query, fragment or wildcard; trailing slash stripped', async () => {
	const phrase = 'an HTTP(S) URL without credentials, query or fragment is required, entry 1, field base_url';
	await refuses([
		...['https://user:pw@host/v1', 'https://host/v1?x=1', 'https://host/v1#frag', 'ftp://host', 'nope'].map((url) =>
			[{ base_url: url }, phrase] as const
		),
		...['', 'https://host/v1?', 'https://host/v1#', 'https://host/v1/?'].map((url) =>
			[{ base_url: url }, 'field base_url'] as const
		),
		[{ base_url: 'https://*.example.com' }, 'wildcard host, entry 1, field base_url'],
	]);
	const slash = await one({ base_url: 'https://api.example.com/v1/' });
	assertEquals([slash.baseUrl, slash.host], ['https://api.example.com/v1', 'api.example.com']);
	const ported = await one({ base_url: 'https://api.example.com:8443/' });
	assertEquals([ported.baseUrl, ported.host], ['https://api.example.com:8443/', 'api.example.com:8443']);
});

Deno.test('base_url (i)–(ii): https anywhere but link-local; plaintext without the flag only to loopback', async () => {
	for (
		const url of [
			'https://api.openai.com/v1',
			'https://10.0.0.5',
			'https://[::1]',
			'https://8.8.8.8',
			'https://100.64.0.1',
		]
	) {
		assertEquals((await one({ base_url: url, api_key: KEY })).allowHttp, false, url);
	}
	// A key on loopback plaintext is fine: it never leaves the host. The URL parser canonicalises other spellings.
	for (
		const [url, host] of [
			['http://localhost:11434', 'localhost:11434'],
			['http://127.0.0.1:11434/v1', '127.0.0.1:11434'],
			['http://127.200.1.1', '127.200.1.1'],
			['http://[::1]:8080', '[::1]:8080'],
			['http://0x7f.1:11434', '127.0.0.1:11434'],
		]
	) {
		const admittedOne = await one({ base_url: url, api_key: KEY });
		assertEquals([admittedOne.host, admittedOne.apiKey, admittedOne.allowHttp], [host, KEY, false], url);
	}
	await refuses([
		[{ base_url: 'https://169.254.169.254', api_key: KEY }, LINK_LOCAL],
		[{ base_url: 'https://[fe80::1]', api_key: KEY }, 'link-local address'],
		[{ base_url: 'http://10.0.0.5:11434' }, 'plaintext HTTP needs allow_http, entry 1, field base_url'],
		[{ base_url: 'http://ollama:11434' }, 'plaintext HTTP needs allow_http'],
		[{ base_url: 'http://api.localhost' }, 'plaintext HTTP needs allow_http'],
		[{ base_url: 'http://[::ffff:10.0.0.1]:11434' }, 'needs allow_http'],
	]);
});

Deno.test('base_url (iii)–(v): allow_http admits private and named hosts with a warning, and a key travels in plaintext', async () => {
	for (
		const url of [
			'http://ollama:11434',
			'http://10.0.0.5',
			'http://172.16.0.1',
			'http://192.168.1.10:8080',
			'http://[fd12::1]',
			'http://[::ffff:10.0.0.1]:11434',
			'http://vllm.internal:8000',
		]
	) {
		const permitted = `model provider local: allow_http is set, plaintext HTTP to ${new URL(url).host} is permitted`;
		const bare = await one({ base_url: url, allow_http: true });
		assertEquals([bare.allowHttp, bare.warnings], [true, [permitted]], url);
		const keyed = await one({ base_url: url, allow_http: true, api_key: KEY });
		assertEquals(keyed.apiKey, KEY);
		assertEquals(keyed.warnings, [`${permitted}; its API key travels in plaintext`], 'and never the key itself');
	}
	const ollama = await one({ base_url: 'http://ollama:11434', allow_http: true });
	assertEquals([ollama.host, ollama.baseUrl], ['ollama:11434', 'http://ollama:11434/']);
	// IPv4-mapped literals fold as head.ts folds them.
	assertEquals(
		(await one({ base_url: 'http://[::ffff:10.0.0.1]:11434', allow_http: true })).host,
		'[::ffff:a00:1]:11434',
	);
	assertEquals(
		(await one({ base_url: 'http://ollama:11434', allow_http: true, api_key_file: KEY_FILE }, KEYED_FILE)).apiKey,
		KEY,
	);
	// Over https the key is not in plaintext, and the warning says no more than the flag permits.
	assertEquals((await one({ base_url: 'https://api.openai.com/v1', allow_http: true, api_key: KEY })).warnings, [
		'model provider local: allow_http is set, plaintext HTTP to api.openai.com is permitted',
	]);
	// Loopback keeps the key at home, flag or not; a decimal spelling of loopback is loopback.
	for (const url of ['http://127.0.0.1:11434', 'http://2130706433']) {
		const loop = await one({ base_url: url, allow_http: true, api_key: KEY });
		assertEquals([loop.apiKey, loop.allowHttp], [KEY, true], url);
	}
	const loopFile = await one(
		{ base_url: 'http://127.0.0.1:11434', allow_http: true, api_key_file: KEY_FILE },
		KEYED_FILE,
	);
	assertEquals([loopFile.keySource, loopFile.apiKey], ['file', KEY]);
});

Deno.test('base_url (iv): public and link-local addresses are refused whatever the flag or the key, in any spelling', async () => {
	const publicUrls = [
		'http://8.8.8.8',
		'http://[2001:db8::1]',
		// CGNAT, 0/8, multicast, benchmarking, 192.0.0/24 and :: are unnamed by the range table: public.
		'http://100.64.0.1',
		'http://100.127.255.254',
		'http://0.0.0.0',
		'http://0.1.2.3',
		'http://224.0.0.1',
		'http://255.255.255.255',
		'http://198.18.0.1',
		'http://192.0.0.1',
		'http://[::]',
		'http://[ff02::1]',
		'http://[::ffff:8.8.8.8]',
		'http://0x08080808',
	];
	const linkLocal = [
		'http://169.254.169.254',
		'http://[fe80::1]',
		'https://169.254.169.254',
		'http://0251.0376.0251.0376',
	];
	await refuses([
		[{ base_url: 'http://8.8.8.8' }, PUBLIC],
		[{ base_url: 'http://169.254.169.254' }, LINK_LOCAL],
		[{ base_url: 'http://[fe80::1%25eth0]', allow_http: true }, 'field base_url'],
		[{ base_url: 'http://[::ffff:169.254.169.254]', allow_http: true }, 'link-local'],
		...publicUrls.flatMap((url) => [
			[{ base_url: url, allow_http: true }, PUBLIC] as const,
			[{ base_url: url, allow_http: true, api_key: KEY }, PUBLIC] as const,
		]),
		...linkLocal.map((url) => [{ base_url: url, allow_http: true, api_key: KEY }, 'link-local address'] as const),
		// Over https a public literal with the flag and a key names no host the flag admits.
		[
			{ base_url: 'https://8.8.8.8/v1', allow_http: true, api_key: KEY },
			'allow_http with a key needs a loopback, private or named host, entry 1, field allow_http',
		],
		[{ base_url: 'https://8.8.8.8/v1', allow_http: true, api_key_file: KEY_FILE }, 'field allow_http', KEYED_FILE],
	]);
});

Deno.test('base_url: classifyHost and judgeBaseUrl decide from parsed bytes and name the refused field', () => {
	const table: Record<string, ReturnType<typeof classifyHost>> = {
		'localhost': 'loopback',
		'LOCALHOST': 'loopback',
		'127.0.0.1': 'loopback',
		'127.255.255.255': 'loopback',
		'[::1]': 'loopback',
		'10.1.2.3': 'private',
		'172.16.0.1': 'private',
		'172.31.255.255': 'private',
		'172.32.0.1': 'public',
		'192.168.0.1': 'private',
		'[fc00::1]': 'private',
		'[fdff::1]': 'private',
		'[::ffff:10.0.0.1]': 'private',
		'[::ffff:a00:1]': 'private',
		'[::ffff:0:10.0.0.1]': 'private',
		'169.254.1.1': 'link-local',
		'[fe80::1]': 'link-local',
		'[febf::1]': 'link-local',
		'[fec0::1]': 'public',
		'8.8.8.8': 'public',
		'100.64.0.1': 'public',
		'0.0.0.0': 'public',
		'224.0.0.1': 'public',
		'[::]': 'public',
		'[2001:db8::1]': 'public',
		'[2002:0a00:0001::]': 'public',
		'[64:ff9b::a00:1]': 'public',
		'[not-an-address]': 'public',
		'ollama': 'named',
		'vllm.internal': 'named',
		'api.localhost': 'named',
		'example.com': 'named',
	};
	for (const [host, expected] of Object.entries(table)) assertEquals(classifyHost(host), expected, host);
	for (
		const [url, allowHttp, keyed, field] of [
			['https://api.openai.com/v1', false, true, undefined],
			['http://127.0.0.1', false, true, undefined],
			['http://ollama', true, false, undefined],
			['http://ollama', true, true, undefined],
			['http://10.0.0.5', true, true, undefined],
			['https://*.x', false, false, 'base_url'],
			['https://169.254.0.1', true, false, 'base_url'],
			['http://8.8.8.8', true, false, 'base_url'],
			['http://ollama', false, false, 'base_url'],
			['http://8.8.8.8', true, true, 'base_url'],
			['https://8.8.8.8', true, true, 'allow_http'],
		] as const
	) assertEquals(judgeBaseUrl(new URL(url), allowHttp, keyed)?.field, field, `${url} ${allowHttp} ${keyed}`);
});

Deno.test('providers file: default names a listed id, else the sole provider, else none; CRLF files parse the same', async () => {
	assertEquals((await admitted([provider(), provider({ id: 'b' })], { extra: { default: 'b' } })).default, 'b');
	assertStringIncludes(
		await refused([provider()], { extra: { default: 'other' } }),
		'default names no listed provider, field default',
	);
	assertStringIncludes(await refused([provider()], { extra: { default: '' } }), 'field default');
	assertEquals((await admitted([provider()])).default, 'local');
	const several = await admitted([provider(), provider({ id: 'b' }), provider({ id: 'c' })]);
	assertEquals([several.default, several.providers.map((p) => p.id)], [null, ['local', 'b', 'c']]);

	const pretty = `${JSON.stringify({ version: 1, providers: [provider({ api_key: KEY })] }, null, 2)}\n`;
	assertEquals(await admitted([], { raw: pretty.replaceAll('\n', '\r\n') }), await admitted([], { raw: pretty }));
	for (const raw of [`${pretty} \n`, `${pretty.replaceAll('\n', '\r\n')} \r\n`]) {
		assertStringIncludes(await refused([], { raw }), 'trailing whitespace after the final line');
	}
});
