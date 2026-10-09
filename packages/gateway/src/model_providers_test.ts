/**
 * D-143 (model-providers-ui W1): the providers file parser — schema, key sources, headers, the C2 `base_url` predicate
 * branch by branch (gate F21–F23), the `default` rule (gate F19) and the short-key warning (gate F12).
 *
 * The security claim under every refusal test: the error names a fixed phrase, the entry and the field, and never the
 * key. `refused()` asserts the absence of {@linkcode KEY} on every path, including branch (v), where the key is the
 * very reason for the refusal.
 */
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

type Disk = Readonly<Record<string, string>>;

function disk(files: Disk): (path: string) => Promise<string> {
	return (path) => path in files ? Promise.resolve(files[path]!) : Promise.reject(new Deno.errors.NotFound(path));
}

function provider(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { id: 'local', kind: 'openai', base_url: 'http://127.0.0.1:11434/v1', models: ['llama3'], ...over };
}

function fileOf(providers: unknown[], extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ version: 1, providers, ...extra })}\n`;
}

interface LoadOptions {
	readonly extra?: Record<string, unknown>;
	readonly files?: Disk;
	readonly warn?: (line: string) => void;
	readonly raw?: string;
}

function load(providers: unknown[], options: LoadOptions = {}): Promise<ModelProvidersConfig | null> {
	const raw = options.raw ?? fileOf(providers, options.extra);
	return loadModelProviders({ [MODEL_PROVIDERS_ENV]: FILE }, {
		readFile: disk({ [FILE]: raw, ...(options.files ?? {}) }),
		...(options.warn === undefined ? {} : { warn: options.warn }),
	});
}

async function admitted(providers: unknown[], options: LoadOptions = {}): Promise<ModelProvidersConfig> {
	const config = await load(providers, options);
	assert(config !== null);
	return config;
}

/** Every refusal is a `SecretError` naming the variable and the file, and never the key. */
async function refused(providers: unknown[], options: LoadOptions = {}): Promise<string> {
	const warnings: string[] = [];
	const error = await assertRejects(
		() => load(providers, { ...options, warn: (line) => warnings.push(line) }),
		SecretError,
	);
	assertStringIncludes(error.message, `${MODEL_PROVIDERS_ENV} (${FILE}): `);
	assert(!error.message.includes(KEY), `the key leaked into: ${error.message}`);
	assert(!error.message.includes(SHORT_KEY), `the short key leaked into: ${error.message}`);
	assertEquals(warnings, [], 'a refused file emits no warning');
	return error.message;
}

// --- the file -----------------------------------------------------------------------------------------------------

Deno.test('providers file: an unset or blank variable means the feature is absent', async () => {
	assertEquals(await loadModelProviders({}, { readFile: disk({}) }), null);
	assertEquals(await loadModelProviders({ [MODEL_PROVIDERS_ENV]: '  ' }, { readFile: disk({}) }), null);
});

Deno.test('providers file: unreadable, oversized, non-JSON and BOM files are refused with a fixed phrase', async () => {
	const unreadable = await assertRejects(
		() => loadModelProviders({ [MODEL_PROVIDERS_ENV]: FILE }, { readFile: disk({}) }),
		SecretError,
	);
	assertStringIncludes(unreadable.message, 'the file cannot be read');
	const big = fileOf([provider({ label: 'x'.repeat(64) })]).padEnd(MODEL_PROVIDERS_FILE_MAX_BYTES + 1, ' ');
	assertStringIncludes(await refused([], { raw: big }), 'the file is larger than 128 KiB');
	assertStringIncludes(await refused([], { raw: '{"version": 1, "providers": [\n' }), 'the file is not valid JSON');
	assertStringIncludes(await refused([], { raw: `﻿${fileOf([provider()])}` }), 'byte-order mark');
	assertStringIncludes(await refused([], { raw: `${fileOf([provider()])}\n\n` }), 'trailing whitespace');
});

Deno.test('providers file: the shape — version, unknown fields, provider count — names the field', async () => {
	assertStringIncludes(await refused([], { raw: '{"version": 2, "providers": []}\n' }), 'field version');
	assertStringIncludes(await refused([provider()], { extra: { extra: true } }), 'unknown field extra, field (file)');
	assertStringIncludes(await refused([]), 'too short or too few, field providers');
	const seventeen = Array.from({ length: 17 }, (_, i) => provider({ id: `p${i}` }));
	assertStringIncludes(await refused(seventeen), 'too long or too many, field providers');
	assertStringIncludes(await refused([provider({ bogus: 1 })]), 'unknown field bogus, entry 1, field (entry)');
	assertStringIncludes(await refused([provider(), provider({ id: 'b', kind: 'other' })]), 'entry 2, field kind');
	assertStringIncludes(await refused([provider({ models: 'llama3' })]), 'wrong type, entry 1, field models');
});

Deno.test('providers file: ids match the pattern and are unique', async () => {
	assertStringIncludes(await refused([provider({ id: 'Local' })]), 'malformed, entry 1, field id');
	assertStringIncludes(await refused([provider({ id: '9x' })]), 'entry 1, field id');
	assertStringIncludes(await refused([provider({ id: `a${'b'.repeat(32)}` })]), 'entry 1, field id');
	assertStringIncludes(await refused([provider(), provider()]), 'duplicate provider id, entry 2, field id');
	const config = await admitted([provider({ id: 'a-b_c9' })]);
	assertEquals(config.providers[0]!.id, 'a-b_c9');
});

Deno.test('providers file: models — one to sixty-four, each matching the pattern; default_model is one of them', async () => {
	assertStringIncludes(await refused([provider({ models: [] })]), 'too short or too few, entry 1, field models');
	const many = Array.from({ length: 65 }, (_, i) => `m${i}`);
	assertStringIncludes(await refused([provider({ models: many })]), 'too long or too many, entry 1, field models');
	assertStringIncludes(
		await refused([provider({ models: ['ok', 'bad model'] })]),
		'malformed, entry 1, field models[1]',
	);
	assertStringIncludes(await refused([provider({ models: ['-x'] })]), 'entry 1, field models[0]');
	assertStringIncludes(
		await refused([provider({ default_model: 'other' })]),
		'not one of the listed models, entry 1, field default_model',
	);
	const config = await admitted([provider({ models: ['a/b:1.0', 'c.d'], default_model: 'c.d' })]);
	assertEquals(config.providers[0]!.models, ['a/b:1.0', 'c.d']);
	assertEquals(config.providers[0]!.defaultModel, 'c.d');
	const first = await admitted([provider({ models: ['x', 'y'] })]);
	assertEquals(first.providers[0]!.defaultModel, 'x', 'the first model is the default when none is named');
});

Deno.test('providers file: defaults and bounds — label, max_tokens_param, max_steps, max_output_tokens, token_budget', async () => {
	const defaults = (await admitted([provider()])).providers[0]!;
	assertEquals(defaults.label, 'local');
	assertEquals(defaults.maxTokensParam, 'max_tokens');
	assertEquals(defaults.maxSteps, MODEL_PROVIDER_BOUNDS.maxSteps.default);
	assertEquals(defaults.maxOutputTokens, MODEL_PROVIDER_BOUNDS.maxOutputTokens.default);
	assertEquals(defaults.tokenBudget, MODEL_PROVIDER_BOUNDS.tokenBudget.default);
	assertEquals(defaults.headers, {});
	assertEquals(defaults.allowHttp, false);
	assertEquals(defaults.apiKey, null);
	assertEquals(defaults.keySource, 'none');

	const set = (await admitted([provider({
		label: 'Local llama',
		max_tokens_param: 'max_completion_tokens',
		max_steps: 64,
		max_output_tokens: 256,
		token_budget: 4_000_000,
	})])).providers[0]!;
	assertEquals(set.label, 'Local llama');
	assertEquals(set.maxTokensParam, 'max_completion_tokens');
	assertEquals([set.maxSteps, set.maxOutputTokens, set.tokenBudget], [64, 256, 4_000_000]);

	assertStringIncludes(await refused([provider({ max_tokens_param: 'tokens' })]), 'entry 1, field max_tokens_param');
	assertStringIncludes(await refused([provider({ max_steps: 0 })]), 'entry 1, field max_steps');
	assertStringIncludes(await refused([provider({ max_steps: 65 })]), 'entry 1, field max_steps');
	assertStringIncludes(await refused([provider({ max_steps: 2.5 })]), 'entry 1, field max_steps');
	assertStringIncludes(await refused([provider({ max_output_tokens: 255 })]), 'entry 1, field max_output_tokens');
	assertStringIncludes(await refused([provider({ max_output_tokens: 32_769 })]), 'entry 1, field max_output_tokens');
	assertStringIncludes(await refused([provider({ token_budget: 999 })]), 'entry 1, field token_budget');
	assertStringIncludes(await refused([provider({ token_budget: 4_000_001 })]), 'entry 1, field token_budget');
	assertStringIncludes(await refused([provider({ label: '' })]), 'entry 1, field label');
	assertStringIncludes(await refused([provider({ label: 'x'.repeat(65) })]), 'entry 1, field label');
});

// --- the key --------------------------------------------------------------------------------------------------------

Deno.test('providers file: at most one of api_key and api_key_file; the refusal names the field, never the key', async () => {
	assertStringIncludes(
		await refused([provider({ api_key: KEY, api_key_file: KEY_FILE })], { files: { [KEY_FILE]: `${KEY}\n` } }),
		'set one of api_key or api_key_file, entry 1, field api_key',
	);
});

Deno.test('providers file: an inline key is non-empty, at most 512 characters and free of whitespace', async () => {
	assertStringIncludes(await refused([provider({ api_key: '' })]), 'the key is empty, entry 1, field api_key');
	assertStringIncludes(
		await refused([provider({ api_key: 'a'.repeat(513) })]),
		'the key is longer than 512 characters, entry 1, field api_key',
	);
	assertStringIncludes(
		await refused([provider({ api_key: `${KEY} ${KEY}` })]),
		'the key contains whitespace, entry 1, field api_key',
	);
	assertStringIncludes(await refused([provider({ api_key: `${KEY}\n` })]), 'the key contains whitespace');
	assertStringIncludes(await refused([provider({ api_key: 42 })]), 'wrong type, entry 1, field api_key');
	const config = await admitted([provider({ api_key: 'a'.repeat(512) })]);
	assertEquals(config.providers[0]!.apiKey, 'a'.repeat(512));
	assertEquals(config.providers[0]!.keySource, 'inline');
});

Deno.test('providers file: api_key_file is an absolute path read through the injected reader and normalised', async () => {
	const config = await admitted([provider({ api_key_file: KEY_FILE })], { files: { [KEY_FILE]: `${KEY}\n` } });
	assertEquals(config.providers[0]!.apiKey, KEY, 'exactly one trailing newline is stripped');
	assertEquals(config.providers[0]!.keySource, 'file');

	assertStringIncludes(
		await refused([provider({ api_key_file: 'secrets/key' })], { files: { 'secrets/key': KEY } }),
		'an absolute path is required, entry 1, field api_key_file',
	);
	assertStringIncludes(
		await refused([provider({ api_key_file: KEY_FILE })]),
		'the key file cannot be read, entry 1, field api_key_file',
	);
	// `normalizeSecret`'s refusals keep their fixed phrase and are re-addressed to the entry and field.
	assertStringIncludes(
		await refused([provider({ api_key_file: KEY_FILE })], { files: { [KEY_FILE]: `${KEY}\n\n` } }),
		'trailing whitespace after the final line, entry 1, field api_key_file',
	);
	assertStringIncludes(
		await refused([provider({ api_key_file: KEY_FILE })], { files: { [KEY_FILE]: ` ${KEY}` } }),
		'leading or trailing whitespace, entry 1, field api_key_file',
	);
	assertStringIncludes(
		await refused([provider({ api_key_file: KEY_FILE })], { files: { [KEY_FILE]: '' } }),
		'file is empty, entry 1, field api_key_file',
	);
	assertStringIncludes(
		await refused([provider({ api_key_file: KEY_FILE })], { files: { [KEY_FILE]: `${KEY} tail\n` } }),
		'the key contains whitespace, entry 1, field api_key_file',
	);
});

Deno.test('providers file: an anthropic provider needs a key; an openai one does not (local servers)', async () => {
	assertStringIncludes(
		await refused([provider({ kind: 'anthropic', base_url: 'https://api.anthropic.com' })]),
		'an anthropic provider needs a key, entry 1, field api_key',
	);
	const anthropic = await admitted([
		provider({ kind: 'anthropic', base_url: 'https://api.anthropic.com', api_key: KEY }),
	]);
	assertEquals(anthropic.providers[0]!.apiKey, KEY);
	const openai = await admitted([provider()]);
	assertEquals(openai.providers[0]!.apiKey, null);
});

Deno.test('providers file (gate F12): a key shorter than 16 characters is admitted with one warning; a longer one is silent', async () => {
	assert(SHORT_KEY.length < MODEL_KEY_REDACTION_MIN_CHARS && KEY.length >= MODEL_KEY_REDACTION_MIN_CHARS);
	const warnings: string[] = [];
	const config = await admitted([provider({ api_key: SHORT_KEY }), provider({ id: 'long', api_key: KEY })], {
		warn: (line) => warnings.push(line),
	});
	assertEquals(config.providers[0]!.apiKey, SHORT_KEY);
	assertEquals(warnings, ['model provider local: short key: not redacted from task output']);
	assert(!warnings[0]!.includes(SHORT_KEY), 'the warning never carries the key');
	const sixteen = 'k'.repeat(16);
	const quiet: string[] = [];
	await admitted([provider({ api_key: sixteen })], { warn: (line) => quiet.push(line) });
	assertEquals(quiet, [], 'sixteen characters is the threshold, inclusive');
});

Deno.test('providers file: warnings are emitted only once the whole file is admitted', async () => {
	// Entry 1 would warn; entry 2 is refused — so nothing is emitted (asserted by `refused`).
	await refused([provider({ api_key: SHORT_KEY }), provider({ id: 'b', models: [] })]);
});

// --- headers --------------------------------------------------------------------------------------------------------

Deno.test('providers file: headers — at most eight, lower-case names, no credential names, bounded values', async () => {
	const kept = await admitted([provider({ headers: { 'x-tenant': 'acme', 'user-agent': 'tykotech/1' } })]);
	assertEquals(kept.providers[0]!.headers, { 'x-tenant': 'acme', 'user-agent': 'tykotech/1' });

	const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`h${i}`, 'v']));
	assertStringIncludes(await refused([provider({ headers: nine })]), 'more than 8 headers, entry 1, field headers');
	assertStringIncludes(
		await refused([provider({ headers: { 'X-Tenant': 'acme' } })]),
		'a header name is not lower-case [a-z0-9-], entry 1, field headers',
	);
	assertStringIncludes(await refused([provider({ headers: { 'x tenant': 'a' } })]), 'entry 1, field headers');
	assertStringIncludes(
		await refused([provider({ headers: { 'x-tenant': 'x'.repeat(257) } })]),
		'the value is longer than 256 characters, entry 1, field headers.x-tenant',
	);
	assertStringIncludes(
		await refused([provider({ headers: { 'x-tenant': 'a\r\nx-other: b' } })]),
		'the value contains a line break, entry 1, field headers.x-tenant',
	);
	assertStringIncludes(await refused([provider({ headers: { 'x-tenant': 1 } })]), 'wrong type, entry 1, field headers');
});

Deno.test('providers file: every credential header name is refused by name, suffix included', async () => {
	assertEquals([...REFUSED_HEADER_NAMES], ['authorization', 'x-api-key', 'proxy-authorization', 'cookie']);
	const names = [...REFUSED_HEADER_NAMES, 'api-key', 'x-auth-token', 'my-secret', 'openai-key'];
	for (const name of names) {
		assertStringIncludes(
			await refused([provider({ base_url: 'https://api.example.com/v1', api_key: KEY, headers: { [name]: KEY } })]),
			`a credential header is refused; use api_key, entry 1, field headers.${name}`,
		);
	}
});

// --- base_url: the shared service rules -----------------------------------------------------------------------------

Deno.test('providers file: base_url follows the serviceUrl rules — no userinfo, query, fragment or wildcard; slash stripped', async () => {
	const phrase = 'an HTTP(S) URL without credentials, query or fragment is required, entry 1, field base_url';
	for (
		const bad of ['https://user:pw@host/v1', 'https://host/v1?x=1', 'https://host/v1#frag', 'ftp://host', 'nope', '']
	) {
		assertStringIncludes(await refused([provider({ base_url: bad })]), bad === '' ? 'field base_url' : phrase);
	}
	assertStringIncludes(
		await refused([provider({ base_url: 'https://*.example.com' })]),
		'wildcard host, entry 1, field base_url',
	);
	const config = await admitted([provider({ base_url: 'https://api.example.com/v1/' })]);
	assertEquals(config.providers[0]!.baseUrl, 'https://api.example.com/v1');
	assertEquals(config.providers[0]!.host, 'api.example.com');
	const ported = await admitted([provider({ base_url: 'https://api.example.com:8443/' })]);
	assertEquals(ported.providers[0]!.baseUrl, 'https://api.example.com:8443/');
	assertEquals(ported.providers[0]!.host, 'api.example.com:8443', 'host is hostname[:port], the grant spelling');
});

// --- base_url: the C2 predicate, one branch at a time ---------------------------------------------------------------

Deno.test('C2 (i): https is admitted for any serviceUrl-valid host, except a link-local literal', async () => {
	for (
		const url of [
			'https://api.openai.com/v1',
			'https://10.0.0.5',
			'https://[::1]',
			'https://8.8.8.8',
			'https://100.64.0.1',
		]
	) {
		const config = await admitted([provider({ base_url: url, api_key: KEY })]);
		assertEquals(config.providers[0]!.allowHttp, false);
	}
	assertStringIncludes(
		await refused([provider({ base_url: 'https://169.254.169.254', api_key: KEY })]),
		'link-local address, entry 1, field base_url',
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'https://[fe80::1]', api_key: KEY })]),
		'link-local address',
	);
});

Deno.test('C2 (ii): http without a flag is admitted only for localhost, 127.0.0.0/8 and [::1]', async () => {
	for (
		const url of ['http://localhost:11434', 'http://127.0.0.1:11434/v1', 'http://127.200.1.1', 'http://[::1]:8080']
	) {
		const config = await admitted([provider({ base_url: url, api_key: KEY })]);
		assertEquals(config.providers[0]!.allowHttp, false);
		assertEquals(config.providers[0]!.apiKey, KEY, 'a key on loopback plaintext is fine: it never leaves the host');
	}
	// Not loopback, no flag: refused on the flag's absence, both for a private literal and for a name.
	assertStringIncludes(
		await refused([provider({ base_url: 'http://10.0.0.5:11434' })]),
		'plaintext HTTP needs allow_http, entry 1, field base_url',
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://ollama:11434' })]),
		'plaintext HTTP needs allow_http',
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://api.localhost' })]),
		'plaintext HTTP needs allow_http',
	);
});

Deno.test('C2 (iii): http with allow_http is admitted for private literals and non-literal names, with one warning each', async () => {
	for (
		const url of [
			'http://10.0.0.5:11434',
			'http://172.16.0.1',
			'http://192.168.1.10:8080',
			'http://[fd12::1]',
			'http://vllm.internal:8000',
		]
	) {
		const warnings: string[] = [];
		const config = await admitted([provider({ base_url: url, allow_http: true })], { warn: (l) => warnings.push(l) });
		assertEquals(config.providers[0]!.allowHttp, true);
		assertEquals(warnings, [
			`model provider local: allow_http is set, plaintext HTTP to ${new URL(url).host} is permitted`,
		]);
	}
});

Deno.test('C2 (iii): http://ollama:11434 with the flag is admitted as a named host', async () => {
	const config = await admitted([provider({ base_url: 'http://ollama:11434', allow_http: true })]);
	assertEquals(config.providers[0]!.host, 'ollama:11434');
	assertEquals(config.providers[0]!.baseUrl, 'http://ollama:11434/');
});

Deno.test('C2 (iv): http to a public literal is refused whatever the flag — http://8.8.8.8', async () => {
	const phrase = 'plaintext HTTP to a public address, entry 1, field base_url';
	assertStringIncludes(await refused([provider({ base_url: 'http://8.8.8.8' })]), phrase);
	assertStringIncludes(await refused([provider({ base_url: 'http://8.8.8.8', allow_http: true })]), phrase);
	assertStringIncludes(await refused([provider({ base_url: 'http://[2001:db8::1]', allow_http: true })]), phrase);
});

Deno.test('C2 (iv): http to a link-local literal is refused whatever the flag — http://169.254.169.254', async () => {
	const phrase = 'link-local address, entry 1, field base_url';
	assertStringIncludes(await refused([provider({ base_url: 'http://169.254.169.254' })]), phrase);
	assertStringIncludes(await refused([provider({ base_url: 'http://169.254.169.254', allow_http: true })]), phrase);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://[fe80::1%25eth0]', allow_http: true })]),
		'field base_url',
	);
	assertStringIncludes(await refused([provider({ base_url: 'http://[fe80::1]', allow_http: true })]), phrase);
});

Deno.test('C2 (iv) / gate F23: CGNAT 100.64/10 is unnamed by C2 and falls to "public → refused" — http://100.64.0.1 + flag', async () => {
	assertStringIncludes(
		await refused([provider({ base_url: 'http://100.64.0.1', allow_http: true })]),
		'plaintext HTTP to a public address, entry 1, field base_url',
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://100.127.255.254', allow_http: true })]),
		'public address',
	);
});

Deno.test('C2 (iv) / gate F23: 0/8, multicast, benchmarking, 192.0.0/24 and :: are unnamed by C2 and fall to "public → refused"', async () => {
	for (
		const url of [
			'http://0.0.0.0',
			'http://0.1.2.3',
			'http://224.0.0.1',
			'http://255.255.255.255',
			'http://198.18.0.1',
			'http://192.0.0.1',
			'http://[::]',
			'http://[ff02::1]',
		]
	) {
		assertStringIncludes(
			await refused([provider({ base_url: url, allow_http: true })]),
			'plaintext HTTP to a public address, entry 1, field base_url',
		);
	}
});

Deno.test('C2 (v): allow_http with a key off the host is refused — http://ollama:11434 + flag + key', async () => {
	const phrase = 'a key never travels in plaintext off the host, entry 1, field allow_http';
	assertStringIncludes(
		await refused([provider({ base_url: 'http://ollama:11434', allow_http: true, api_key: KEY })]),
		phrase,
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://10.0.0.5', allow_http: true, api_key: KEY })]),
		phrase,
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://ollama:11434', allow_http: true, api_key_file: KEY_FILE })], {
			files: { [KEY_FILE]: `${KEY}\n` },
		}),
		phrase,
	);
	// The flag is judged as written, on either scheme: the combination has no honest reading off the host.
	assertStringIncludes(
		await refused([provider({ base_url: 'https://api.openai.com/v1', allow_http: true, api_key: KEY })]),
		phrase,
	);
	// Loopback is the one exception: the key never leaves the host.
	const loop = await admitted([provider({ base_url: 'http://127.0.0.1:11434', allow_http: true, api_key: KEY })]);
	assertEquals(loop.providers[0]!.apiKey, KEY);
	assertEquals(loop.providers[0]!.allowHttp, true);
});

Deno.test('C2 / gate F21: http://[::ffff:10.0.0.1]:11434 + flag is admitted as private (IPv4-mapped, folded as head.ts folds it)', async () => {
	const config = await admitted([provider({ base_url: 'http://[::ffff:10.0.0.1]:11434', allow_http: true })]);
	assertEquals(config.providers[0]!.host, '[::ffff:a00:1]:11434', 'the WHATWG serialisation of the literal');
	assertEquals(classifyHost('[::ffff:10.0.0.1]'), 'private');
	assertEquals(classifyHost('[::ffff:a00:1]'), 'private');
	assertEquals(classifyHost('[::ffff:0:10.0.0.1]'), 'private', 'the deprecated SIIT form folds the same way');
	// Without the flag the mapped private literal is as refused as the plain one; a mapped public one is refused with it.
	assertStringIncludes(await refused([provider({ base_url: 'http://[::ffff:10.0.0.1]:11434' })]), 'needs allow_http');
	assertStringIncludes(
		await refused([provider({ base_url: 'http://[::ffff:8.8.8.8]', allow_http: true })]),
		'public address',
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://[::ffff:169.254.169.254]', allow_http: true })]),
		'link-local',
	);
});

Deno.test('C2 / gate F21: http://0x7f.1:11434 is admitted as loopback without the flag (the URL parser canonicalises it)', async () => {
	const config = await admitted([provider({ base_url: 'http://0x7f.1:11434' })]);
	assertEquals(config.providers[0]!.host, '127.0.0.1:11434');
	assertEquals(config.providers[0]!.baseUrl, 'http://127.0.0.1:11434/');
	// The same canonicalisation closes the public and link-local spellings too.
	assertStringIncludes(
		await refused([provider({ base_url: 'http://0x08080808', allow_http: true })]),
		'public address',
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'http://0251.0376.0251.0376', allow_http: true })]),
		'link-local',
	);
	// And a decimal spelling of loopback is loopback: the flag and a key together are the one admitted combination.
	const decimal = await admitted([provider({ base_url: 'http://2130706433', allow_http: true, api_key: KEY })]);
	assertEquals(decimal.providers[0]!.host, '127.0.0.1');
	assertEquals(decimal.providers[0]!.apiKey, KEY);
});

Deno.test('C2: classifyHost tells loopback, private, link-local, public and named apart from parsed bytes', () => {
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
});

Deno.test('C2: judgeBaseUrl names the field each branch refuses', () => {
	assertEquals(judgeBaseUrl(new URL('https://api.openai.com/v1'), false, true), null);
	assertEquals(judgeBaseUrl(new URL('http://127.0.0.1'), false, true), null);
	assertEquals(judgeBaseUrl(new URL('http://ollama'), true, false), null);
	assertEquals(judgeBaseUrl(new URL('https://*.x'), false, false)?.field, 'base_url');
	assertEquals(judgeBaseUrl(new URL('https://169.254.0.1'), true, false)?.field, 'base_url');
	assertEquals(judgeBaseUrl(new URL('http://8.8.8.8'), true, false)?.field, 'base_url');
	assertEquals(judgeBaseUrl(new URL('http://ollama'), false, false)?.field, 'base_url');
	assertEquals(judgeBaseUrl(new URL('http://ollama'), true, true)?.field, 'allow_http');
});

// --- default --------------------------------------------------------------------------------------------------------

Deno.test('providers file (gate F19): default must name a listed id', async () => {
	const config = await admitted([provider(), provider({ id: 'b' })], { extra: { default: 'b' } });
	assertEquals(config.default, 'b');
	assertStringIncludes(
		await refused([provider()], { extra: { default: 'other' } }),
		'default names no listed provider, field default',
	);
	assertStringIncludes(await refused([provider()], { extra: { default: '' } }), 'field default');
});

Deno.test('providers file (gate F19): a sole provider without default is the default', async () => {
	assertEquals((await admitted([provider()])).default, 'local');
});

Deno.test('providers file (gate F19): several providers without default leave default null', async () => {
	const config = await admitted([provider(), provider({ id: 'b' }), provider({ id: 'c' })]);
	assertEquals(config.default, null);
	assertEquals(config.providers.map((p) => p.id), ['local', 'b', 'c']);
});

// --- fix round: BUG-9, BUG-4, CR2-9, QR-7 ---------------------------------------------------------------------------

Deno.test('BUG-9: the composer placeholder REPLACE_WITH_KEY is refused as a key, inline and file-backed, by a fixed phrase', async () => {
	assertEquals(PLACEHOLDER_KEY, 'REPLACE_WITH_KEY');
	assertStringIncludes(
		await refused([provider({ base_url: 'https://api.openai.com/v1', api_key: PLACEHOLDER_KEY })]),
		'the key is the composer placeholder, entry 1, field api_key',
	);
	assertStringIncludes(
		await refused([provider({ base_url: 'https://api.openai.com/v1', api_key_file: KEY_FILE })], {
			files: { [KEY_FILE]: `${PLACEHOLDER_KEY}\n` },
		}),
		'the key is the composer placeholder, entry 1, field api_key_file',
	);
	// The second entry is the one at fault: the phrase names it.
	assertStringIncludes(
		await refused([provider(), provider({ id: 'b', base_url: 'https://api.openai.com/v1', api_key: PLACEHOLDER_KEY })]),
		'the key is the composer placeholder, entry 2, field api_key',
	);
});

Deno.test('BUG-4: a providers file with CRLF line endings is admitted identically; trailing whitespace is still refused', async () => {
	const pretty = `${JSON.stringify({ version: 1, providers: [provider({ api_key: KEY })] }, null, 2)}\n`;
	const lf = await admitted([], { raw: pretty });
	const crlf = await admitted([], { raw: pretty.replaceAll('\n', '\r\n') });
	assertEquals(crlf, lf);
	assertEquals(crlf.providers[0]!.apiKey, KEY);
	// A genuine trailing-whitespace problem keeps its phrase, on either line ending.
	const phrase = 'trailing whitespace after the final line';
	assertStringIncludes(await refused([], { raw: `${pretty} \n` }), phrase);
	assertStringIncludes(await refused([], { raw: `${pretty.replaceAll('\n', '\r\n')} \r\n` }), phrase);
	// Only the providers file is normalised: a CRLF key file is still a multi-line secret, refused as before.
	assertStringIncludes(
		await refused([provider({ api_key_file: KEY_FILE })], { files: { [KEY_FILE]: `${KEY}\r\n` } }),
		'field api_key_file',
	);
});

Deno.test('CR-8 / CR2-9: the gateway redaction threshold equals the loop redactor threshold', () => {
	assertEquals(MODEL_KEY_REDACTION_MIN_CHARS, REDACTION_MIN_LENGTH);
});

Deno.test('QR-7 / C2 (v): the loopback exception admits a file-backed key with allow_http, keySource file', async () => {
	const config = await admitted([
		provider({ base_url: 'http://127.0.0.1:11434', allow_http: true, api_key_file: KEY_FILE }),
	], {
		files: { [KEY_FILE]: `${KEY}\n` },
	});
	assertEquals(config.providers[0]!.keySource, 'file');
	assertEquals(config.providers[0]!.apiKey, KEY);
	assertEquals(config.providers[0]!.allowHttp, true);
});
