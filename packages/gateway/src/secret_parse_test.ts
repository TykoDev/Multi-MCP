/**
 * Review R1-1 (D-123, S-10): a secret-bearing value that is not the JSON it should be refuses the start naming the
 * variable and the kind of fault — a fixed phrase, a position at most — and never any part of the value.
 *
 * V8's `JSON.parse` message quotes its input: the whole of it when it is short (`Unexpected token 'h', "hunter2-…" is
 * not valid JSON`), its first characters otherwise, and the offending character either way. An operator who stores a
 * bare key where a JSON record list belongs — in a file, inline, or in Vault or 1Password behind a `*_REF` — would
 * have it printed to stderr and the container log by the refusal meant to protect it. Every source of every secret
 * JSON is driven here: inline, `*_FILE`, `*_REF` (both providers), and the key-file reload's parser.
 */
import { assert, assertMatch, assertThrows } from '@std/assert';
import { ConfigError, loadConfig, parseApiKeys } from './config.ts';
import type { SecretFetch } from './secret_providers.ts';
import { resolveSecrets } from './secrets.ts';

/**
 * Values an operator could plausibly put where JSON belongs. Each carries a sentinel that can only reach a message by
 * being copied there: a bare token (short, quoted whole by V8), a long one (quoted by prefix), and malformed JSON
 * whose fault lies before or after the secret.
 */
const SENTINEL = 'Q7SENTINEL';
const NOT_JSON: readonly string[] = [
	`${SENTINEL}-pw`,
	`ttk_live_${SENTINEL}_${'9f8e7d6c5b4a'.repeat(4)}`,
	`{"login": "${SENTINEL}-value",, "other": "x"}`,
	`[{"id": "k1", "sha256": "${SENTINEL}" "label": "x"}]`,
	`{"login": "${SENTINEL}-value"} ${SENTINEL}-trailer`,
	`"${SENTINEL}-unterminated`,
];

/** The refusal names no part of the value: not the sentinel, not its first characters, not the offending token. */
function assertClean(message: string, value: string): void {
	assert(!message.includes(SENTINEL), `the refusal quotes the value: ${message}`);
	for (const fragment of ['Unexpected token', 'is not valid JSON', value.slice(0, 6)]) {
		assert(!message.includes(fragment), `the refusal carries the parser's own text (${fragment}): ${message}`);
	}
	assertMatch(message, /not valid JSON( at position \d+)?$/, 'a fixed phrase, a position at most');
}

function files(map: Record<string, string>): (path: string) => Promise<string> {
	return (path) =>
		path in map ? Promise.resolve(map[path]!) : Promise.reject(new Deno.errors.NotFound(`No such file: ${path}`));
}

const VAULT_ENV = { TTK_VAULT_ADDR: 'https://vault.internal.test:8200', TTK_VAULT_TOKEN_FILE: '/run/vault_token' };
const OP_ENV = { TTK_OP_CONNECT_URL: 'https://connect.internal.test', TTK_OP_CONNECT_TOKEN_FILE: '/run/op_token' };
const TOKENS = { '/run/vault_token': 'hvs.provider-token', '/run/op_token': 'op-provider-token' };

/** A Vault KV v2 answer holding `value` under every key, or a 1Password item with one field per label asked. */
function providerAnswering(value: string): SecretFetch {
	return (input) => {
		const body = input.href.startsWith(VAULT_ENV.TTK_VAULT_ADDR)
			? { data: { data: { keys: value, secrets: value }, metadata: { version: 1 } } }
			: { fields: [{ id: 'f1', label: 'keys', value }, { id: 'f2', label: 'secrets', value }] };
		return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
	};
}

/** `resolveSecrets` then `loadConfig`, as the CLI starts: the refusal it would print, or a failed assertion. */
async function startupRefusal(env: Record<string, string>, readable: Record<string, string>, value: string) {
	const secrets = await resolveSecrets({
		env,
		readFile: files({ ...TOKENS, ...readable }),
		fetch: providerAnswering(value),
	});
	return assertThrows(() => loadConfig(env, { secrets }), ConfigError);
}

/** Each source, and the variable its refusal names (the logical name plus this suffix). */
const SOURCES: ReadonlyArray<[source: 'inline' | 'file' | 'vault' | '1password', suffix: string]> = [
	['inline', ''],
	['file', '_FILE'],
	['vault', '_REF'],
	['1password', '_REF'],
];

for (const logical of ['TTK_API_KEYS', 'TTK_SECRETS'] as const) {
	Deno.test(`R1-1: ${logical} that is not JSON is refused without quoting it — inline, file and provider`, async () => {
		for (const value of NOT_JSON) {
			for (const [source, suffix] of SOURCES) {
				let error: ConfigError;
				if (source === 'inline') {
					error = assertThrows(() => loadConfig({ [logical]: value }), ConfigError);
				} else if (source === 'file') {
					// A file's one trailing newline is stripped; the value is otherwise read as written.
					const env = { [`${logical}_FILE`]: '/run/value' };
					error = await startupRefusal(env, { '/run/value': `${value}\n` }, value);
				} else {
					const ref = source === 'vault'
						? `vault:kv/team/item#${logical === 'TTK_API_KEYS' ? 'keys' : 'secrets'}`
						: `op:vaultid/itemid#${logical === 'TTK_API_KEYS' ? 'keys' : 'secrets'}`;
					const env = { ...(source === 'vault' ? VAULT_ENV : OP_ENV), [`${logical}_REF`]: ref };
					error = await startupRefusal(env, {}, value);
				}
				assert(error.message.startsWith(`${logical}${suffix}: `), `${source}: names the variable: ${error.message}`);
				assertClean(error.message, value);
			}
		}
	});
}

Deno.test('R1-1: the key-file reload parser refuses a non-JSON file without quoting it', () => {
	for (const value of NOT_JSON) {
		const error = assertThrows(() => parseApiKeys(value, 'TTK_API_KEYS_FILE'), ConfigError);
		assertClean(error.message, value);
	}
});

Deno.test('R1-1: valid JSON of the wrong shape names the fault and still never the value', () => {
	const shapes = [
		`"${SENTINEL}-a-json-string"`,
		`["${SENTINEL}"]`,
		`[{"id": "k1", "sha256": "${SENTINEL}"}]`,
		`[{"id": "k1", "sha256": "${'a'.repeat(64)}", "scopes": ["${SENTINEL}"]}]`,
	];
	for (const value of shapes) {
		const error = assertThrows(() => loadConfig({ TTK_API_KEYS: value }), ConfigError);
		assert(!error.message.includes(SENTINEL), `the refusal quotes the value: ${error.message}`);
	}
	for (
		const value of [`"${SENTINEL}"`, `{"${SENTINEL}/${'x'.repeat(80)}": "github"}`, `{"a": "${SENTINEL}", "b": 7}`]
	) {
		const error = assertThrows(() => loadConfig({ TTK_SECRETS: value }), ConfigError);
		assert(!error.message.includes(SENTINEL), `the refusal quotes the value: ${error.message}`);
	}
});

Deno.test('R1-1: the administrator seed, inline and from its file, is refused the same way', async () => {
	for (const value of NOT_JSON) {
		const inline = assertThrows(() => loadConfig({ TTK_ADMIN_USER: value }), ConfigError);
		assertClean(inline.message, value);
		const env = { TTK_ADMIN_USER_FILE: '/run/admin' };
		const fromFile = await startupRefusal(env, { '/run/admin': `${value}\n` }, value);
		assert(fromFile.message.startsWith('TTK_ADMIN_USER_FILE: '), fromFile.message);
		assertClean(fromFile.message, value);
	}
});
