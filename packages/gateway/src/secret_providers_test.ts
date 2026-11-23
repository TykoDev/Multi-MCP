/** External secret providers, through an injected `fetch` only — no unit test opens a socket. */
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
const REF = `vault:kv/${REF_PATH}#k`;
const VAULT_ADDR = 'https://vault.internal.test:8200';
const OP_URL = 'https://connect.internal.test';
const VAULT_ENV = { TTK_VAULT_ADDR: VAULT_ADDR, TTK_VAULT_TOKEN_FILE: '/run/secrets/vault_token' } as const;
const TOKEN_FILES = { '/run/secrets/vault_token': `${TOKEN}\n`, '/run/secrets/op_token': TOKEN };
const SIGNAL = new AbortController().signal;

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

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const vaultBody = (data: Record<string, unknown>) => ({ data: { data, metadata: { version: 3 } } });

/** A filesystem stand-in: the named files, and NotFound for every other path. */
const files = (map: Record<string, string>) => (path: string): Promise<string> =>
	path in map ? Promise.resolve(map[path]!) : Promise.reject(new Deno.errors.NotFound(`No such file: ${path}`));

/** A provider read that must fail, with a clean message whose detail is `detail`. */
async function refuses(read: () => Promise<string>, detail: string): Promise<void> {
	const error = await assertRejects(read, ProviderReadError);
	assertEquals(error.detail, detail);
	assertClean(error.message);
}

/** resolveSecrets must refuse with a SecretError naming `variable` first and carrying nothing secret. */
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

Deno.test('secret providers: references and provider addresses parse, or are refused naming the variable only', () => {
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
	for (
		const raw of [
			`vault:kv/${REF_PATH}`,
			`vault:${REF_PATH.split('/')[0]}#k`,
			`vault:kv/../${REF_PATH}#k`,
			`vault:kv/./${REF_PATH}#k`,
			`vault:kv//${REF_PATH}#k`,
			`vault:kv/${REF_PATH}#`,
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
	const refs = { TTK_API_KEYS_REF: `vault:kv/${REF_PATH}#keys`, TTK_SECRETS_REF: 'op:v/i#f' };
	assertEquals(configuredSecretRefs(refs), [
		{ variable: 'TTK_API_KEYS_REF', provider: 'vault' },
		{ variable: 'TTK_SECRETS_REF', provider: '1password' },
	]);
	assertEquals([configuredSecretRefs({ TTK_SECRETS_REF: 'garbage' }), configuredSecretRefs({})], [[], []]);
	const lines = describeSecretRefs(refs);
	assertEquals(lines, [
		'secret provider vault for TTK_API_KEYS_REF: configured, not contacted',
		'secret provider 1password for TTK_SECRETS_REF: configured, not contacted',
	]);
	for (const line of lines) assertClean(line);

	// https, or http on loopback, with no credentials, query or fragment.
	assertEquals(parseProviderAddress('TTK_VAULT_ADDR', `${VAULT_ADDR}/`).href, `${VAULT_ADDR}/`);
	assertEquals(parseProviderAddress('TTK_VAULT_ADDR', 'https://vault.test/prefix/').pathname, '/prefix');
	for (const loopback of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
		assertEquals(parseProviderAddress('TTK_OP_CONNECT_URL', loopback).protocol, 'http:');
	}
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
	) assert((ENV_NAMES as readonly string[]).includes(name), `${name} would never reach resolveSecrets`);
});

const vaultRef = parseSecretRef('TTK_SECRETS_REF', `vault:kv/${REF_PATH}#json`);

Deno.test('secret providers: Vault KV v2 reads data.data[key] with one token header and no redirects', async () => {
	const seen: Seen[] = [];
	const provider = new VaultKv2Provider({
		url: parseProviderAddress('TTK_VAULT_ADDR', VAULT_ADDR),
		token: TOKEN,
		namespace: 'team/alpha',
		fetch: fakeFetch(() => json(vaultBody({ json: VALUE, other: 'x' })), seen),
	});
	assertEquals(await provider.read(vaultRef, SIGNAL), VALUE);
	assertEquals(seen.length, 1);
	assertEquals(seen[0]!.url, `${VAULT_ADDR}/v1/kv/data/${REF_PATH}`);
	assertEquals(seen[0]!.headers.get('x-vault-token'), TOKEN);
	assertEquals(seen[0]!.headers.get('x-vault-namespace'), 'team/alpha');
	assertEquals(seen[0]!.headers.get('authorization'), null, 'the token travels in one header only');
	assertEquals(seen[0]!.redirect, 'error', 'a redirect could carry the token to another host');
	assertEquals(seen[0]!.client, false, 'no private CA configured, no custom client');
	// A structured value is serialized, so TTK_SECRETS may be stored either way.
	const secrets = { github: { value: VALUE, domains: ['github.com'] } };
	const structured = new VaultKv2Provider({
		url: new URL(VAULT_ADDR),
		token: TOKEN,
		fetch: fakeFetch(() => json(vaultBody({ json: secrets }))),
	});
	assertEquals(JSON.parse(await structured.read(vaultRef, SIGNAL)), secrets);
});

Deno.test('secret providers: every Vault failure is a fixed phrase or a status class, never the token, value or path', async () => {
	const read = (answer: (url: URL) => Response | Promise<Response>) => () =>
		new VaultKv2Provider({ url: new URL(VAULT_ADDR), token: TOKEN, fetch: fakeFetch(answer) }).read(vaultRef, SIGNAL);
	for (
		const [answer, detail] of [
			[() => json({ errors: [`permission denied on ${REF_PATH} for ${TOKEN}`] }, 403), 'answered 4xx'],
			[() => json({ errors: ['sealed'] }, 503), 'answered 5xx'],
			[() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }), 'answered 3xx'],
			[() => json(vaultBody({ other: VALUE })), 'the secret has no such key'],
			[() => json({ data: { data: null } }), 'the secret has no current version'],
			[() => json(vaultBody({ json: 42 })), 'the key does not hold text or a JSON document'],
			[() => new Response(`not json ${VALUE}`), 'answered a body that is not JSON'],
			[() => new Response('x'.repeat(1_048_577)), 'answered more than 1 MiB'],
			[() => new Response('{}', { headers: { 'content-length': String(2 * 1_048_576) } }), 'answered more than 1 MiB'],
			// Deno's own fetch error names the request URL, and so the reference's path: it is never quoted.
			[
				() => Promise.reject(new TypeError(`error sending request for url (${VAULT_ADDR}/v1/kv/data/${REF_PATH})`)),
				'unreachable, redirected, or its TLS certificate was not trusted',
			],
			[
				() => Promise.reject(new Deno.errors.NotCapable(`Requires net access to "vault.internal.test:8200"`)),
				'this process holds no --allow-net grant for the provider address',
			],
		] as const
	) await refuses(read(answer), detail);
	// A provider that does not answer in time is cut off.
	const slow = new VaultKv2Provider({
		url: new URL(VAULT_ADDR),
		token: TOKEN,
		timeoutMs: 30,
		fetch: (_input, init) =>
			new Promise<Response>((_resolve, reject) =>
				init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
			),
	});
	await refuses(() => slow.read(vaultRef, SIGNAL), 'timed out after 0.03 s');
});

Deno.test('secret providers: 1Password Connect matches a field by id, then by label, and never guesses', async () => {
	const opRef = parseSecretRef('TTK_SECRETS_REF', 'op:vaultid/itemid#credential');
	const read = (fields: unknown, seen?: Seen[]) =>
		new OnePasswordConnectProvider({
			url: parseProviderAddress('TTK_OP_CONNECT_URL', OP_URL),
			token: TOKEN,
			fetch: fakeFetch(() => json({ id: 'itemid', fields }), seen),
		}).read(opRef, SIGNAL);
	const fields = [
		{ id: 'username', label: 'username', value: 'operator' },
		{ id: 'f2', label: 'credential', value: VALUE },
		{ id: 'credential', label: 'other', value: 'BY-ID' },
	];
	const seen: Seen[] = [];
	assertEquals(await read(fields, seen), 'BY-ID', 'an id match wins');
	assertEquals(seen[0]!.url, `${OP_URL}/v1/vaults/vaultid/items/itemid`);
	assertEquals(seen[0]!.headers.get('authorization'), `Bearer ${TOKEN}`);
	assertEquals(seen[0]!.redirect, 'error');
	assertEquals(await read(fields.slice(0, 2)), VALUE);
	for (
		const [bad, detail] of [
			[
				[{ id: 'a', label: 'credential', value: VALUE }, { id: 'b', label: 'credential', value: 'x' }],
				'more than one field carries that label',
			],
			[[{ id: 'a', label: 'username', value: VALUE }], 'the item has no such field'],
			[[{ id: 'credential', label: 'credential' }], 'the field holds no text'],
			['not a list', 'the item has no such field'],
		] as const
	) await refuses(() => read(bad), detail);
});

Deno.test('secret providers: a reference resolves into the logical key, read once at startup, never into the environment', async () => {
	const { record } = await generateApiKey('from-vault', ['mcp:invoke']);
	const seen: Seen[] = [];
	const env = { ...VAULT_ENV, TTK_API_KEYS_REF: `vault:kv/${REF_PATH}#keys` };
	const names = ['TTK_API_KEYS', 'TTK_SECRETS', 'TTK_VAULT_TOKEN', 'TTK_OP_CONNECT_TOKEN'];
	const before = names.map((name) => Deno.env.get(name));
	const resolved = await resolveSecrets({
		env,
		readFile: files(TOKEN_FILES),
		fetch: fakeFetch(() => json(vaultBody({ keys: JSON.stringify([record]) })), seen),
	});
	assertEquals(JSON.parse(resolved.TTK_API_KEYS!), [record]);
	assertEquals(seen[0]!.headers.get('x-vault-token'), TOKEN, 'the token file is normalised');
	const config = loadConfig(env, { secrets: resolved });
	assertEquals(config.apiKeys.map((key) => key.id), ['from-vault']);
	assertEquals([config.apiKeysFile, config.secretProviders], [null, ['vault']], 'no file to watch');
	assertEquals(names.map((name) => Deno.env.get(name)), before);

	const secrets = JSON.stringify({ login: VALUE });
	const op = await resolveSecrets({
		env: {
			TTK_OP_CONNECT_URL: OP_URL,
			TTK_OP_CONNECT_TOKEN_FILE: '/run/secrets/op_token',
			TTK_SECRETS_REF: 'op:vaultid/itemid#secrets',
		},
		readFile: files(TOKEN_FILES),
		fetch: fakeFetch(() => json({ fields: [{ id: 'x', label: 'secrets', value: secrets }] })),
	});
	assertEquals(op.TTK_SECRETS, secrets);
	assertEquals(
		loadConfig({ TTK_SECRETS_REF: 'op:vaultid/itemid#secrets' }, { secrets: op }).secrets.map((s) => s.name),
		[
			'login',
		],
	);
});

Deno.test('secret providers: a twin source, a provider failure or a broken setting refuses the start, contacting nothing early', async () => {
	const noFetch: SecretFetch = () => Promise.reject(new Error('must not be contacted'));
	await refusesStart(
		{ env: { ...VAULT_ENV, TTK_API_KEYS_REF: REF, TTK_API_KEYS: '[]' }, readFile: files(TOKEN_FILES), fetch: noFetch },
		'TTK_API_KEYS_REF',
	);
	await refusesStart({
		env: { ...VAULT_ENV, TTK_SECRETS_REF: REF, TTK_SECRETS_FILE: '/run/secrets/s' },
		readFile: files({ ...TOKEN_FILES, '/run/secrets/s': '{}' }),
		fetch: noFetch,
	}, 'TTK_SECRETS_REF');

	const env = { ...VAULT_ENV, TTK_SECRETS_REF: `vault:kv/${REF_PATH}#json` };
	const denied = await refusesStart(
		{ env, readFile: files(TOKEN_FILES), fetch: fakeFetch(() => json({ errors: [TOKEN] }, 403)) },
		'TTK_SECRETS_REF',
	);
	assertEquals(denied.message, 'TTK_SECRETS_REF (vault): answered 4xx');
	await refusesStart({
		env,
		readFile: files(TOKEN_FILES),
		fetch: () => Promise.reject(new TypeError(`error sending request for url (${VAULT_ADDR}/v1/kv/data/${REF_PATH})`)),
	}, 'TTK_SECRETS_REF');
	await refusesStart(
		{ env, readFile: files(TOKEN_FILES), fetch: fakeFetch(() => json(vaultBody({ nope: VALUE }))) },
		'TTK_SECRETS_REF',
		'the secret has no such key',
	);

	const contacted: string[] = [];
	const fetch: SecretFetch = (input) => {
		contacted.push(input.href);
		return Promise.resolve(json(vaultBody({ k: VALUE })));
	};
	for (
		const [overrides, variable, tokenFile] of [
			[{ TTK_SECRETS_REF: REF, TTK_VAULT_ADDR: undefined, TTK_VAULT_TOKEN_FILE: undefined }, 'TTK_VAULT_ADDR'],
			[{ TTK_SECRETS_REF: REF, TTK_VAULT_TOKEN_FILE: undefined }, 'TTK_VAULT_TOKEN_FILE'],
			[{ TTK_SECRETS_REF: REF, TTK_VAULT_ADDR: 'http://vault.internal.test' }, 'TTK_VAULT_ADDR'],
			[{ TTK_SECRETS_REF: 'vault:nopath' }, 'TTK_SECRETS_REF'],
			[{ TTK_SECRETS_REF: REF, TTK_VAULT_NAMESPACE: 'a\nb' }, 'TTK_VAULT_NAMESPACE'],
			// The 1Password half needs its own settings even when Vault's are complete.
			[{ TTK_SECRETS_REF: REF, TTK_API_KEYS_REF: 'op:v/i#f' }, 'TTK_OP_CONNECT_URL'],
			// The token file: unreadable, empty, or holding whitespace.
			[{ TTK_SECRETS_REF: REF }, 'TTK_VAULT_TOKEN_FILE', {}],
			[{ TTK_SECRETS_REF: REF }, 'TTK_VAULT_TOKEN_FILE', { '/run/secrets/vault_token': '' }],
			[{ TTK_SECRETS_REF: REF }, 'TTK_VAULT_TOKEN_FILE', { '/run/secrets/vault_token': 'a b' }],
		] as const
	) {
		const merged = Object.fromEntries(
			Object.entries({ ...VAULT_ENV, ...overrides }).filter(([, value]) => value !== undefined),
		) as Record<string, string>;
		await refusesStart(
			{ env: merged, fetch, ...(tokenFile === undefined ? {} : { readFile: files(tokenFile) }) },
			variable,
		);
	}
	assertEquals(contacted, [], 'no refusal above reached a provider');
});

Deno.test('secret providers: settings are checked before any file is read; a CA file must hold a parseable PEM', async () => {
	// Were files read first, a `secrets/ttk_admin_user.json` that is a directory would mask the setting at fault.
	const reads: string[] = [];
	const readFile = (path: string): Promise<string> => {
		reads.push(path);
		return Promise.reject(new Error('Incorrect function. (os error 1)'));
	};
	const fetch: SecretFetch = () => Promise.reject(new Error('must not be contacted'));
	await refusesStart({ env: { TTK_SECRETS_REF: REF }, readFile, fetch }, 'TTK_VAULT_ADDR');
	await refusesStart({ env: { ...VAULT_ENV, TTK_SECRETS_REF: 'vault:nopath' }, readFile, fetch }, 'TTK_SECRETS_REF');
	await refusesStart({
		env: { ...VAULT_ENV, TTK_SECRETS_REF: REF, TTK_VAULT_NAMESPACE: 'a\nb', TTK_API_KEYS_FILE: '/run/keys' },
		readFile,
		fetch,
	}, 'TTK_VAULT_NAMESPACE');
	assertEquals(reads, [], 'no file — named or default — was read');

	const env = { ...VAULT_ENV, TTK_SECRETS_REF: REF, TTK_SECRET_PROVIDER_CA_FILE: '/run/ca.pem' };
	const ok = fakeFetch(() => json(vaultBody({ k: VALUE })));
	await refusesStart({ env, readFile: files(TOKEN_FILES), fetch: ok }, 'TTK_SECRET_PROVIDER_CA_FILE');
	for (
		const [pem, detail] of [
			['not a certificate', 'no PEM certificate in the file'],
			['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', 'the PEM certificate cannot be parsed'],
		]
	) {
		await refusesStart(
			{ env, readFile: files({ ...TOKEN_FILES, '/run/ca.pem': pem! }), fetch: ok },
			'TTK_SECRET_PROVIDER_CA_FILE',
			detail,
		);
	}
});

Deno.test('secret providers: doctor mode checks every setting but contacts nothing and reads no token', async () => {
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
	assertEquals(read, ['secrets/ttk_admin_user.json'], 'only the implicit admin file is probed');
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
