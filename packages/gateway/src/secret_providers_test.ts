/**
 * R15 (D-123, AC18): external secret providers, through an injected `fetch` only — no unit test opens a socket.
 *
 * Every failure is asserted twice: that it refuses (the start would stop), and that its message carries none of the
 * three things it must never carry — the provider token, the secret value, and the reference's path. Sentinels make
 * the second check exact: each is a string that can only appear in a message by being copied there.
 */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { generateApiKey } from './auth.ts';
import { ENV_NAMES, loadConfig } from './config.ts';
import {
	configuredSecretRefs,
	describeSecretRefs,
	OnePasswordConnectProvider,
	parseProviderAddress,
	parseSecretRef,
	ProviderReadError,
	type SecretFetch,
	SecretProviderError,
	VaultKv2Provider,
} from './secret_providers.ts';
import { resolveSecrets, SecretError } from './secrets.ts';

const TOKEN = 'hvs.TOKEN-SENTINEL-0123456789abcdef';
const VALUE = 'VALUE-SENTINEL-9f8e7d';
const REF_PATH = 'team-alpha/browser-login';
const VAULT_ADDR = 'https://vault.internal.test:8200';
const OP_URL = 'https://connect.internal.test';

/** No message may carry the token, the value, or the reference's path. */
function assertClean(message: string): void {
	for (const sentinel of [TOKEN, VALUE, REF_PATH, 'team-alpha']) {
		assert(!message.includes(sentinel), `a failure message leaked ${JSON.stringify(sentinel)}: ${message}`);
	}
}

interface Seen {
	url: string;
	headers: Headers;
	redirect: RequestRedirect | undefined;
	client: boolean;
}

/** A fetch that records each request and answers with `answer`. */
function fakeFetch(answer: (url: URL) => Response | Promise<Response>, seen: Seen[] = []): SecretFetch {
	return (input, init) => {
		seen.push({
			url: input.href,
			headers: new Headers(init.headers),
			redirect: init.redirect,
			client: init.client !== undefined,
		});
		return Promise.resolve(answer(input));
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const vaultBody = (data: Record<string, unknown>) => ({ data: { data, metadata: { version: 3 } } });

// --- references --------------------------------------------------------------------------------------------------

Deno.test('R15: parseSecretRef reads both reference forms', () => {
	assertEquals(parseSecretRef('TTK_SECRETS_REF', `vault:kv/${REF_PATH}#json`), {
		provider: 'vault',
		mount: 'kv',
		path: REF_PATH,
		key: 'json',
	});
	assertEquals(parseSecretRef('TTK_API_KEYS_REF', 'op:abcdefghijklmnopqrstuvwxyz/0123456789abcdefghijklmn#api keys'), {
		provider: '1password',
		vault: 'abcdefghijklmnopqrstuvwxyz',
		item: '0123456789abcdefghijklmn',
		field: 'api keys',
	});
});

Deno.test('R15: a malformed reference is refused, naming the variable and never repeating the value', () => {
	for (
		const raw of [
			`vault:kv/${REF_PATH}`, // no key
			`vault:${REF_PATH.split('/')[0]}#k`, // a mount and no path
			`vault:kv/../${REF_PATH}#k`, // climbs
			`vault:kv/./${REF_PATH}#k`,
			`vault:kv//${REF_PATH}#k`,
			`vault:kv/${REF_PATH}#`, // empty key
			`vault:kv/${REF_PATH}#a\u0000b`,
			`op:vault/item/extra#field`,
			`op:va ult/item#field`,
			`aws:${REF_PATH}#k`,
			REF_PATH,
		]
	) {
		const error = assertThrows(() => parseSecretRef('TTK_SECRETS_REF', raw), SecretProviderError);
		assertEquals(error.variable, 'TTK_SECRETS_REF', raw);
		assertClean(error.message);
	}
});

Deno.test('R15: configuredSecretRefs names the provider by prefix and nothing else', () => {
	assertEquals(
		configuredSecretRefs({ TTK_API_KEYS_REF: `vault:kv/${REF_PATH}#keys`, TTK_SECRETS_REF: 'op:v/i#f' }),
		[{ variable: 'TTK_API_KEYS_REF', provider: 'vault' }, { variable: 'TTK_SECRETS_REF', provider: '1password' }],
	);
	assertEquals(configuredSecretRefs({ TTK_SECRETS_REF: 'garbage' }), []);
	assertEquals(configuredSecretRefs({}), []);
});

Deno.test('AC18: doctor says "configured, not contacted", naming the variable and provider and never the reference', () => {
	const lines = describeSecretRefs({ TTK_API_KEYS_REF: `vault:kv/${REF_PATH}#keys`, TTK_SECRETS_REF: 'op:v/i#f' });
	assertEquals(lines, [
		'secret provider vault for TTK_API_KEYS_REF: configured, not contacted',
		'secret provider 1password for TTK_SECRETS_REF: configured, not contacted',
	]);
	for (const line of lines) assertClean(line);
});

Deno.test('R15: a provider address is https, or http on loopback, with no credentials, query or fragment', () => {
	assertEquals(parseProviderAddress('TTK_VAULT_ADDR', `${VAULT_ADDR}/`).href, `${VAULT_ADDR}/`);
	assertEquals(parseProviderAddress('TTK_VAULT_ADDR', 'https://vault.test/prefix/').pathname, '/prefix');
	assertEquals(parseProviderAddress('TTK_OP_CONNECT_URL', 'http://127.0.0.1:8080').protocol, 'http:');
	assertEquals(parseProviderAddress('TTK_OP_CONNECT_URL', 'http://localhost:8080').hostname, 'localhost');
	assertEquals(parseProviderAddress('TTK_OP_CONNECT_URL', 'http://[::1]:8080').hostname, '[::1]');
	for (
		const raw of [
			'http://vault.internal.test:8200',
			`https://user:${TOKEN}@vault.internal.test`,
			'https://vault.internal.test/?token=x',
			'https://vault.internal.test/#x',
			'ftp://vault.internal.test',
			'not a url',
		]
	) {
		const error = assertThrows(() => parseProviderAddress('TTK_VAULT_ADDR', raw), SecretProviderError);
		assertEquals(error.variable, 'TTK_VAULT_ADDR');
		assertClean(error.message);
	}
});

// --- Vault KV v2 --------------------------------------------------------------------------------------------------

const vaultRef = parseSecretRef('TTK_SECRETS_REF', `vault:kv/${REF_PATH}#json`);

Deno.test('R15: Vault KV v2 is read with the token header, no redirects, and the value of data.data[key]', async () => {
	const seen: Seen[] = [];
	const provider = new VaultKv2Provider({
		url: parseProviderAddress('TTK_VAULT_ADDR', VAULT_ADDR),
		token: TOKEN,
		namespace: 'team/alpha',
		fetch: fakeFetch(() => json(vaultBody({ json: VALUE, other: 'x' })), seen),
	});
	assertEquals(await provider.read(vaultRef, new AbortController().signal), VALUE);
	assertEquals(seen.length, 1);
	assertEquals(seen[0]!.url, `${VAULT_ADDR}/v1/kv/data/${REF_PATH}`);
	assertEquals(seen[0]!.headers.get('x-vault-token'), TOKEN);
	assertEquals(seen[0]!.headers.get('x-vault-namespace'), 'team/alpha');
	assertEquals(seen[0]!.headers.get('authorization'), null, 'the token travels in one header only');
	assertEquals(seen[0]!.redirect, 'error', 'a redirect could carry the token to another host');
	assertEquals(seen[0]!.client, false, 'no private CA configured, no custom client');
});

Deno.test('R15: a structured Vault value is serialized, so TTK_SECRETS may be stored either way', async () => {
	const secrets = { github: { value: VALUE, domains: ['github.com'] } };
	const provider = new VaultKv2Provider({
		url: new URL(VAULT_ADDR),
		token: TOKEN,
		fetch: fakeFetch(() => json(vaultBody({ json: secrets }))),
	});
	assertEquals(JSON.parse(await provider.read(vaultRef, new AbortController().signal)), secrets);
});

/** A provider read that must fail, with a clean message whose detail is `detail`. */
async function refuses(read: () => Promise<string>, detail: string | RegExp): Promise<void> {
	const error = await assertRejects(read, ProviderReadError);
	if (typeof detail === 'string') assertEquals(error.detail, detail);
	else assert(detail.test(error.detail), error.detail);
	assertClean(error.message);
}

Deno.test('R15: every Vault failure is a fixed phrase or a status class, never the token, value or path', async () => {
	const read = (answer: (url: URL) => Response | Promise<Response>) => () =>
		new VaultKv2Provider({ url: new URL(VAULT_ADDR), token: TOKEN, fetch: fakeFetch(answer) })
			.read(vaultRef, new AbortController().signal);
	await refuses(read(() => json({ errors: [`permission denied on ${REF_PATH} for ${TOKEN}`] }, 403)), 'answered 4xx');
	await refuses(read(() => json({ errors: ['sealed'] }, 503)), 'answered 5xx');
	await refuses(
		read(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })),
		'answered 3xx',
	);
	await refuses(read(() => json(vaultBody({ other: VALUE }))), 'the secret has no such key');
	await refuses(read(() => json({ data: { data: null } })), 'the secret has no current version');
	await refuses(read(() => json(vaultBody({ json: 42 }))), 'the key does not hold text or a JSON document');
	await refuses(read(() => new Response(`not json ${VALUE}`)), 'answered a body that is not JSON');
	await refuses(read(() => new Response('x'.repeat(1_048_577))), 'answered more than 1 MiB');
	await refuses(
		read(() => new Response('{}', { headers: { 'content-length': String(2 * 1_048_576) } })),
		'answered more than 1 MiB',
	);
	// Deno's own fetch error text names the request URL, and so the reference's path: it is never quoted.
	await refuses(
		read(() => Promise.reject(new TypeError(`error sending request for url (${VAULT_ADDR}/v1/kv/data/${REF_PATH})`))),
		'unreachable, redirected, or its TLS certificate was not trusted',
	);
	await refuses(
		read(() => Promise.reject(new Deno.errors.NotCapable(`Requires net access to "vault.internal.test:8200"`))),
		'this process holds no --allow-net grant for the provider address',
	);
});

Deno.test('R15: a provider that does not answer in time is cut off, and the timer is cleared', async () => {
	const provider = new VaultKv2Provider({
		url: new URL(VAULT_ADDR),
		token: TOKEN,
		timeoutMs: 30,
		fetch: (_input, init) =>
			new Promise<Response>((_resolve, reject) =>
				init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
			),
	});
	await refuses(() => provider.read(vaultRef, new AbortController().signal), 'timed out after 0.03 s');
});

// --- 1Password Connect --------------------------------------------------------------------------------------------

const opRef = parseSecretRef('TTK_SECRETS_REF', 'op:vaultid/itemid#credential');

Deno.test('R15: 1Password Connect is read with a bearer token, matching the field by id, then by label', async () => {
	const seen: Seen[] = [];
	const fields = [
		{ id: 'username', label: 'username', value: 'operator' },
		{ id: 'f2', label: 'credential', value: VALUE },
		{ id: 'credential', label: 'other', value: 'BY-ID' },
	];
	const provider = new OnePasswordConnectProvider({
		url: parseProviderAddress('TTK_OP_CONNECT_URL', OP_URL),
		token: TOKEN,
		fetch: fakeFetch(() => json({ id: 'itemid', fields }), seen),
	});
	assertEquals(await provider.read(opRef, new AbortController().signal), 'BY-ID', 'an id match wins');
	assertEquals(seen[0]!.url, `${OP_URL}/v1/vaults/vaultid/items/itemid`);
	assertEquals(seen[0]!.headers.get('authorization'), `Bearer ${TOKEN}`);
	assertEquals(seen[0]!.redirect, 'error');

	const byLabel = new OnePasswordConnectProvider({
		url: new URL(OP_URL),
		token: TOKEN,
		fetch: fakeFetch(() => json({ fields: fields.slice(0, 2) })),
	});
	assertEquals(await byLabel.read(opRef, new AbortController().signal), VALUE);
});

Deno.test('R15: an ambiguous, missing or empty 1Password field is refused, not guessed', async () => {
	const read = (fields: unknown) => () =>
		new OnePasswordConnectProvider({ url: new URL(OP_URL), token: TOKEN, fetch: fakeFetch(() => json({ fields })) })
			.read(opRef, new AbortController().signal);
	await refuses(
		read([{ id: 'a', label: 'credential', value: VALUE }, { id: 'b', label: 'credential', value: 'x' }]),
		'more than one field carries that label',
	);
	await refuses(read([{ id: 'a', label: 'username', value: VALUE }]), 'the item has no such field');
	await refuses(read([{ id: 'credential', label: 'credential' }]), 'the field holds no text');
	await refuses(read('not a list'), 'the item has no such field');
});

// --- resolveSecrets ------------------------------------------------------------------------------------------------

/** A filesystem stand-in: the named files, and NotFound for every other path. */
function files(map: Record<string, string>): (path: string) => Promise<string> {
	return (path) =>
		path in map ? Promise.resolve(map[path]!) : Promise.reject(new Deno.errors.NotFound(`No such file: ${path}`));
}

const VAULT_ENV = {
	TTK_VAULT_ADDR: VAULT_ADDR,
	TTK_VAULT_TOKEN_FILE: '/run/secrets/vault_token',
} as const;
const TOKEN_FILES = { '/run/secrets/vault_token': `${TOKEN}\n`, '/run/secrets/op_token': TOKEN };

Deno.test('AC18: a Vault reference resolves into the logical key, so loadConfig reads it like a file', async () => {
	const { record } = await generateApiKey('from-vault', ['mcp:invoke']);
	const seen: Seen[] = [];
	const env = { ...VAULT_ENV, TTK_API_KEYS_REF: `vault:kv/${REF_PATH}#keys` };
	const resolved = await resolveSecrets({
		env,
		readFile: files(TOKEN_FILES),
		fetch: fakeFetch(() => json(vaultBody({ keys: JSON.stringify([record]) })), seen),
	});
	assertEquals(JSON.parse(resolved.TTK_API_KEYS!), [record]);
	assertEquals(seen[0]!.headers.get('x-vault-token'), TOKEN, 'the token file is normalised (one newline stripped)');
	const config = loadConfig(env, { secrets: resolved });
	assertEquals(config.apiKeys.map((key) => key.id), ['from-vault']);
	assertEquals(config.apiKeysFile, null, 'no file to watch: a provider value is read once, at startup');
	assertEquals(config.secretProviders, ['vault']);
});

Deno.test('AC18: a 1Password reference resolves TTK_SECRETS', async () => {
	const secrets = JSON.stringify({ login: VALUE });
	const resolved = await resolveSecrets({
		env: {
			TTK_OP_CONNECT_URL: OP_URL,
			TTK_OP_CONNECT_TOKEN_FILE: '/run/secrets/op_token',
			TTK_SECRETS_REF: 'op:vaultid/itemid#secrets',
		},
		readFile: files(TOKEN_FILES),
		fetch: fakeFetch(() => json({ fields: [{ id: 'x', label: 'secrets', value: secrets }] })),
	});
	assertEquals(resolved.TTK_SECRETS, secrets);
	assertEquals(
		loadConfig({ TTK_SECRETS_REF: 'op:vaultid/itemid#secrets' }, { secrets: resolved }).secrets.map((s) => s.name),
		['login'],
	);
});

/** resolveSecrets must refuse with a SecretError naming `variable` and carrying nothing secret. */
async function refusesStart(
	options: Parameters<typeof resolveSecrets>[0],
	variable: string,
	detail?: string,
): Promise<SecretError> {
	const error = await assertRejects(() => resolveSecrets(options), SecretError);
	assert(error.message.startsWith(`${variable} (`), `expected ${variable} named first: ${error.message}`);
	if (detail !== undefined) assert(error.message.endsWith(detail), error.message);
	assertClean(error.message);
	return error;
}

Deno.test('AC18: a reference with its inline or file twin refuses the start', async () => {
	const ref = `vault:kv/${REF_PATH}#k`;
	const noFetch: SecretFetch = () => Promise.reject(new Error('must not be contacted'));
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_API_KEYS_REF: ref, TTK_API_KEYS: '[]' }, readFile: files(TOKEN_FILES), fetch: noFetch },
		'TTK_API_KEYS_REF',
	);
	await refusesStart(
		{
			env: { ...VAULT_ENV, TTK_SECRETS_REF: ref, TTK_SECRETS_FILE: '/run/secrets/s' },
			readFile: files({ ...TOKEN_FILES, '/run/secrets/s': '{}' }),
			fetch: noFetch,
		},
		'TTK_SECRETS_REF',
	);
});

Deno.test('AC18: a provider 403, a timeout-class failure or a missing key refuses the start, naming the provider', async () => {
	const env = { ...VAULT_ENV, TTK_SECRETS_REF: `vault:kv/${REF_PATH}#json` };
	const error = await refusesStart(
		{ env, readFile: files(TOKEN_FILES), fetch: fakeFetch(() => json({ errors: [TOKEN] }, 403)) },
		'TTK_SECRETS_REF',
		'answered 4xx',
	);
	assertEquals(error.message, 'TTK_SECRETS_REF (vault): answered 4xx');
	await refusesStart(
		{
			env,
			readFile: files(TOKEN_FILES),
			fetch: () =>
				Promise.reject(new TypeError(`error sending request for url (${VAULT_ADDR}/v1/kv/data/${REF_PATH})`)),
		},
		'TTK_SECRETS_REF',
	);
	await refusesStart(
		{ env, readFile: files(TOKEN_FILES), fetch: fakeFetch(() => json(vaultBody({ nope: VALUE }))) },
		'TTK_SECRETS_REF',
		'the secret has no such key',
	);
});

Deno.test('AC18: missing or broken provider settings refuse the start before anything is contacted', async () => {
	const ref = `vault:kv/${REF_PATH}#k`;
	const contacted: string[] = [];
	const fetch: SecretFetch = (input) => {
		contacted.push(input.href);
		return Promise.resolve(json(vaultBody({ k: VALUE })));
	};
	await refusesStart({ env: { TTK_SECRETS_REF: ref }, fetch }, 'TTK_VAULT_ADDR');
	await refusesStart({ env: { TTK_SECRETS_REF: ref, TTK_VAULT_ADDR: VAULT_ADDR }, fetch }, 'TTK_VAULT_TOKEN_FILE');
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_VAULT_ADDR: 'http://vault.internal.test', TTK_SECRETS_REF: ref }, fetch },
		'TTK_VAULT_ADDR',
	);
	await refusesStart({ env: { ...VAULT_ENV, TTK_SECRETS_REF: 'vault:nopath' }, fetch }, 'TTK_SECRETS_REF');
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_SECRETS_REF: ref, TTK_VAULT_NAMESPACE: 'a\nb' }, fetch },
		'TTK_VAULT_NAMESPACE',
	);
	// The 1Password half needs its own settings even when Vault's are complete.
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_SECRETS_REF: ref, TTK_API_KEYS_REF: 'op:v/i#f' }, fetch },
		'TTK_OP_CONNECT_URL',
	);
	// The token file: unreadable, empty, or holding whitespace.
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_SECRETS_REF: ref }, readFile: files({}), fetch },
		'TTK_VAULT_TOKEN_FILE',
	);
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_SECRETS_REF: ref }, readFile: files({ '/run/secrets/vault_token': '' }), fetch },
		'TTK_VAULT_TOKEN_FILE',
	);
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_SECRETS_REF: ref }, readFile: files({ '/run/secrets/vault_token': 'a b' }), fetch },
		'TTK_VAULT_TOKEN_FILE',
	);
	assertEquals(contacted, [], 'no refusal above reached a provider');
});

Deno.test('R1-7: references and provider settings are checked before any file is read', async () => {
	// The test above passes no `readFile`, so it used to read the default administrator file through the real
	// filesystem first: in a checkout where `secrets/ttk_admin_user.json` was a directory (a compose run's side effect)
	// the refusal named TTK_ADMIN_USER_FILE instead of the setting at fault. A configuration check needs no file.
	const reads: string[] = [];
	const readFile = (path: string): Promise<string> => {
		reads.push(path);
		return Promise.reject(new Error('Incorrect function. (os error 1)'));
	};
	const fetch: SecretFetch = () => Promise.reject(new Error('must not be contacted'));
	const ref = `vault:kv/${REF_PATH}#k`;
	await refusesStart({ env: { TTK_SECRETS_REF: ref }, readFile, fetch }, 'TTK_VAULT_ADDR');
	await refusesStart({ env: { ...VAULT_ENV, TTK_SECRETS_REF: 'vault:nopath' }, readFile, fetch }, 'TTK_SECRETS_REF');
	await refusesStart(
		{
			env: { ...VAULT_ENV, TTK_SECRETS_REF: ref, TTK_VAULT_NAMESPACE: 'a\nb', TTK_API_KEYS_FILE: '/run/keys' },
			readFile,
			fetch,
		},
		'TTK_VAULT_NAMESPACE',
	);
	assertEquals(reads, [], 'no file — named or default — was read to reach any of these refusals');
});

Deno.test('AC18: a private CA file must hold a parseable PEM certificate', async () => {
	const env = { ...VAULT_ENV, TTK_SECRETS_REF: `vault:kv/${REF_PATH}#k`, TTK_SECRET_PROVIDER_CA_FILE: '/run/ca.pem' };
	const fetch = fakeFetch(() => json(vaultBody({ k: VALUE })));
	await refusesStart({ env, readFile: files(TOKEN_FILES), fetch }, 'TTK_SECRET_PROVIDER_CA_FILE');
	await refusesStart(
		{ env, readFile: files({ ...TOKEN_FILES, '/run/ca.pem': 'not a certificate' }), fetch },
		'TTK_SECRET_PROVIDER_CA_FILE',
		'no PEM certificate in the file',
	);
	await refusesStart(
		{
			env,
			readFile: files({
				...TOKEN_FILES,
				'/run/ca.pem': '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
			}),
			fetch,
		},
		'TTK_SECRET_PROVIDER_CA_FILE',
		'the PEM certificate cannot be parsed',
	);
});

Deno.test('AC18: doctor mode checks every setting but contacts nothing and reads no token', async () => {
	const read: string[] = [];
	const resolved = await resolveSecrets({
		env: { ...VAULT_ENV, TTK_API_KEYS_REF: `vault:kv/${REF_PATH}#keys`, TTK_SECRET_PROVIDER_CA_FILE: '/run/ca.pem' },
		readFile: (path) => {
			read.push(path);
			return Promise.reject(new Deno.errors.NotFound(path));
		},
		fetch: () => Promise.reject(new Error('doctor must not contact a provider')),
		contactProviders: false,
	});
	assertEquals(resolved.TTK_API_KEYS, undefined);
	assertEquals(read, ['secrets/ttk_admin_user.json'], 'only the implicit admin file is probed, as before');
	// …and a broken setting is still reported.
	await assertRejects(
		() =>
			resolveSecrets({
				env: { TTK_API_KEYS_REF: `vault:kv/${REF_PATH}#keys` },
				readFile: files({}),
				contactProviders: false,
			}),
		SecretError,
		'TTK_VAULT_ADDR',
	);
});

Deno.test('R15: every provider variable is in ENV_NAMES, so processEnv hands it to resolveSecrets', () => {
	for (
		const name of [
			'TTK_API_KEYS_REF',
			'TTK_SECRETS_REF',
			'TTK_VAULT_ADDR',
			'TTK_OP_CONNECT_URL',
			'TTK_VAULT_TOKEN_FILE',
			'TTK_OP_CONNECT_TOKEN_FILE',
			'TTK_VAULT_NAMESPACE',
			'TTK_SECRET_PROVIDER_CA_FILE',
		]
	) assert((ENV_NAMES as readonly string[]).includes(name), `${name} would read as undefined`);
});

Deno.test('AC18: nothing a provider supplies is written to the environment', async () => {
	const names = ['TTK_API_KEYS', 'TTK_SECRETS', 'TTK_VAULT_TOKEN', 'TTK_OP_CONNECT_TOKEN'];
	const before = names.map((name) => Deno.env.get(name));
	await resolveSecrets({
		env: { ...VAULT_ENV, TTK_SECRETS_REF: `vault:kv/${REF_PATH}#json` },
		readFile: files(TOKEN_FILES),
		fetch: fakeFetch(() => json(vaultBody({ json: JSON.stringify({ login: VALUE }) }))),
	});
	assertEquals(names.map((name) => Deno.env.get(name)), before);
});
