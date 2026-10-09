/**
 * D-154: the database, its vault, seeding, and the secrets moved into it.
 *
 * Proven here: the file is created owner-only and migrated once; a secret is sealed (its plaintext appears nowhere in
 * the database file), bound to its name and context, and a wrong or missing key refuses by name; seeding copies a
 * source only into an empty, never-seeded destination, `force` replaces, and a keyed source with no vault refuses;
 * the browser secrets and the link-signing key are served from the vault.
 */
import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { join, resolve } from '@std/path';
import { parseSecrets } from '@tykotech/mcp';
import { loadConfig } from './config.ts';
import { openDataStore } from './data_store.ts';
import { Database, DATABASE_FILE, DatabaseError } from './database.ts';
import type { ModelProvidersConfig, ModelProviderSettings } from './model_providers.ts';
import { ModelProvidersAdmin, providerKeyName, readRows } from './model_providers_admin.ts';
import { LINK_KEY_FILE_NAME, LINK_KEY_SECRET_NAME, loadLinkSigningKey, SecretError } from './secrets.ts';
import { BROWSER_SECRETS_NAME, seedDatabase, SeedError } from './seed.ts';
import { decodeDbKey, generateDbKey, Vault, VaultError } from './vault.ts';

const KEY = decodeDbKey(generateDbKey())!;
const OTHER_KEY = decodeDbKey(generateDbKey())!;
const PROVIDER_KEY = 'sk-provider-0123456789abcdefghijklmnop';
const BROWSER_SECRET = 'browser-pw-ZYXWVUTSRQPONMLK';

async function scratch(): Promise<{ dir: string } & AsyncDisposable> {
	const dir = resolve(`tests/.scratch/database-${crypto.randomUUID()}`);
	await Deno.mkdir(dir, { recursive: true });
	return { dir, [Symbol.asyncDispose]: () => Deno.remove(dir, { recursive: true }).catch(() => {}) };
}

/** Every byte of the database's files, as text — what a backup of the data volume would carry. */
async function bytesOnDisk(dir: string): Promise<string> {
	let text = '';
	for await (const entry of Deno.readDir(dir)) {
		if (entry.isFile) text += new TextDecoder('latin1').decode(await Deno.readFile(join(dir, entry.name)));
	}
	return text;
}

function provider(id: string, overrides: Partial<ModelProviderSettings> = {}): ModelProviderSettings {
	return {
		id,
		kind: 'openai',
		label: id,
		baseUrl: 'https://api.example.com/v1',
		host: 'api.example.com',
		models: ['m1'],
		defaultModel: 'm1',
		apiKey: PROVIDER_KEY,
		keySource: 'file',
		headers: {},
		allowHttp: false,
		maxTokensParam: 'max_tokens',
		maxSteps: 8,
		maxOutputTokens: 512,
		tokenBudget: 10_000,
		...overrides,
	};
}

const FILE: ModelProvidersConfig = { default: 'cloud', providers: [provider('cloud')], file: '/run/secrets/p.json' };

// --- the database -------------------------------------------------------------------------------------------------

Deno.test('D-154: the database file is created 0600, migrated once, and reopened as is', async () => {
	await using s = await scratch();
	const db = Database.open(s.dir);
	db.setSetting('probe', 'one');
	db.close();
	if (Deno.build.os !== 'windows') assertEquals((await Deno.stat(join(s.dir, DATABASE_FILE))).mode! & 0o777, 0o600);
	const again = Database.open(s.dir);
	assertEquals(again.setting('probe'), 'one');
	assertEquals(Number(again.get('PRAGMA user_version')?.user_version), 1);
	again.setSetting('probe', null);
	assertEquals(again.setting('probe'), null);
	again.close();
	assertEquals(Database.inspect(s.dir)?.providers, 0);
});

Deno.test('D-154: a file that is not a database refuses by path', async () => {
	await using s = await scratch();
	await Deno.writeTextFile(join(s.dir, DATABASE_FILE), 'not a database at all, just text'.repeat(64));
	const refused = assertThrows(() => Database.open(s.dir), DatabaseError);
	assertStringIncludes(refused.message, join(s.dir, DATABASE_FILE));
});

Deno.test('D-154: transactions roll back on a throw', () => {
	const db = Database.memory();
	assertThrows(() =>
		db.transaction(() => {
			db.setSetting('half', 'written');
			throw new Error('abort');
		})
	);
	assertEquals(db.setting('half'), null);
	db.close();
});

// --- the vault ----------------------------------------------------------------------------------------------------

Deno.test('D-154: the key file accepts 32 bytes as base64url, padded base64 or hex, nothing else', () => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	assertEquals(decodeDbKey(hex), bytes);
	assertEquals(decodeDbKey(btoa(String.fromCharCode(...bytes))), bytes);
	assertEquals(decodeDbKey(generateDbKey())?.byteLength, 32);
	for (const bad of ['', 'short', hex.slice(2), `${hex}00`, '!'.repeat(43), 'x'.repeat(42)]) {
		assertEquals(decodeDbKey(bad), null);
	}
});

Deno.test('D-154: a sealed secret never rests in plaintext and opens only under its name and context', async () => {
	await using s = await scratch();
	const db = Database.open(s.dir);
	const vault = await Vault.open(db, KEY);
	await vault.put('model-provider/a', PROVIDER_KEY, 'api.example.com:443');
	assertEquals(await vault.get('model-provider/a', 'api.example.com:443'), PROVIDER_KEY);
	// The context is authenticated: the same row read for another host does not open.
	await assertRejects(() => vault.get('model-provider/a', 'evil.example.com:443'), VaultError);
	// So is the name: a row copied under another name does not open there.
	db.run(
		"INSERT INTO secrets (name, nonce, sealed, key_id, updated_at) SELECT 'model-provider/b', nonce, sealed, key_id, " +
			"updated_at FROM secrets WHERE name = 'model-provider/a'",
	);
	await assertRejects(() => vault.get('model-provider/b', 'api.example.com:443'), VaultError);
	// A flipped bit is refused, never decrypted to something else.
	const row = db.get("SELECT sealed FROM secrets WHERE name = 'model-provider/a'")!;
	const tampered = new Uint8Array(row.sealed as Uint8Array);
	tampered[0]! ^= 1;
	db.run("UPDATE secrets SET sealed = ? WHERE name = 'model-provider/a'", tampered);
	const refused = await assertRejects(() => vault.get('model-provider/a', 'api.example.com:443'), VaultError);
	assertFalse(refused.message.includes(PROVIDER_KEY));
	assertEquals(vault.names('model-provider/'), ['model-provider/a', 'model-provider/b']);
	db.close();
	assertFalse((await bytesOnDisk(s.dir)).includes(PROVIDER_KEY), 'no plaintext on disk, WAL included');
});

Deno.test('D-154: a wrong key, or no key over sealed secrets, refuses to open', async () => {
	const db = Database.memory();
	await (await Vault.open(db, KEY)).put('x', 'value', '');
	const wrong = await assertRejects(() => Vault.open(db, OTHER_KEY), VaultError);
	assertStringIncludes(wrong.message, 'TTK_DB_KEY_FILE: the key does not open this database');
	const missing = await assertRejects(() => Vault.open(db, null), VaultError);
	assertStringIncludes(missing.message, 'holds encrypted secrets and no key is set');
	db.close();
	// Locked over an empty vault: lists, never reads or writes.
	const empty = await Vault.open(Database.memory(), null);
	assertFalse(empty.unlocked);
	await assertRejects(() => empty.put('x', 'v', ''), VaultError);
	assertEquals(empty.names(''), []);
});

// --- seeding ------------------------------------------------------------------------------------------------------

Deno.test('D-154: the providers file seeds an empty database once; force replaces; keys are sealed per host', async () => {
	const db = Database.memory();
	const vault = await Vault.open(db, KEY);
	const store = { db, vault };
	const sources = { providers: FILE, secrets: null };
	assertEquals((await seedDatabase(store, sources))[0]!.outcome, 'seeded');
	assertEquals(readRows(db).map((row) => [row.id, row.origin, row.keyHost]), [[
		'cloud',
		'seed',
		'api.example.com:443',
	]]);
	assertEquals(await vault.get(providerKeyName('cloud'), 'api.example.com:443'), PROVIDER_KEY);
	assertFalse(JSON.stringify(readRows(db)).includes(PROVIDER_KEY), 'a row carries no key');

	// Changed file, no force: the database is the source now.
	const changed = { providers: { default: 'other', providers: [provider('other')] }, secrets: null };
	assertEquals((await seedDatabase(store, changed))[0]!.outcome, 'already-seeded');
	assertEquals(readRows(db).map((row) => row.id), ['cloud']);
	// Emptied by an administrator: still seeded, so nothing comes back on a restart.
	db.run('DELETE FROM model_providers');
	assertEquals((await seedDatabase(store, sources))[0]!.outcome, 'already-seeded');
	assertEquals(readRows(db), []);
	// Force replaces, and a key no row needs any more goes with its row.
	assertEquals((await seedDatabase(store, changed, { force: true }))[0]!.outcome, 'seeded');
	assertEquals(readRows(db).map((row) => row.id), ['other']);
	assertEquals(vault.names('model-provider/'), ['model-provider/other']);
	assertEquals(db.setting('model_providers.default'), 'other');
	db.close();
});

Deno.test('D-154: a database that holds providers but was never seeded is not overwritten without force', async () => {
	const db = Database.memory();
	const vault = await Vault.open(db, KEY);
	db.run(
		"INSERT INTO model_providers (id, position, origin, entry, key_host, updated_at) VALUES ('mine', 0, 'admin', " +
			"'{}', NULL, 'now')",
	);
	assertEquals((await seedDatabase({ db, vault }, { providers: FILE, secrets: null }))[0]!.outcome, 'not-empty');
	assertEquals(readRows(db).map((row) => row.id), ['mine']);
	db.close();
});

Deno.test('D-154: a source carrying a secret refuses to seed into a locked vault, naming the fix', async () => {
	const db = Database.memory();
	const vault = await Vault.open(db, null);
	const refused = await assertRejects(
		() => seedDatabase({ db, vault }, { providers: FILE, secrets: null }),
		SeedError,
	);
	assertStringIncludes(refused.message, 'TTK_MODEL_PROVIDERS_FILE: provider cloud has a key');
	assertStringIncludes(refused.message, 'doctor --new-db-key');
	assertFalse(refused.message.includes(PROVIDER_KEY));
	assertEquals(readRows(db), [], 'nothing half-written');
	// A keyless file seeds without a vault key.
	const keyless = { default: 'local', providers: [provider('local', { apiKey: null, keySource: 'none' })] };
	assertEquals((await seedDatabase({ db, vault }, { providers: keyless, secrets: null }))[0]!.outcome, 'seeded');
	const secrets = await assertRejects(
		() => seedDatabase({ db, vault }, { providers: null, secrets: parseSecrets(`{"pw":"${BROWSER_SECRET}"}`) }),
		SeedError,
	);
	assertStringIncludes(secrets.message, 'TTK_SECRETS: browser secrets are configured');
	db.close();
});

Deno.test('D-154: openDataStore serves browser secrets from the vault; a REF source is never seeded', async () => {
	await using s = await scratch();
	const config = (secrets: string, ref = false) => ({
		...loadConfig({ TTK_DATA_DIR: s.dir }, { secrets: { TTK_SECRETS: secrets } }),
		dbKey: KEY,
		...(ref ? { secretsSource: 'TTK_SECRETS_REF' as const } : {}),
	});
	const first = await openDataStore(config(`{"pw":{"value":"${BROWSER_SECRET}","domains":["example.com"]}}`));
	assertEquals(first.seeded.find((result) => result.target === 'secrets')?.outcome, 'seeded');
	assertEquals(first.secrets, [{ name: 'pw', value: BROWSER_SECRET, domains: ['example.com'] }]);
	assert(first.store!.vault.has(BROWSER_SECRETS_NAME));
	first.close();
	// The file changed; the vault is in force until a forced seed, and startup says so without a name or value.
	const lines: string[] = [];
	const second = await openDataStore(config('{"pw":"changed-value-0123456789"}'), {
		logger: { info: (line) => void lines.push(line), warn: (line) => void lines.push(line) },
	});
	assertEquals(second.secrets[0]?.value, BROWSER_SECRET);
	assert(lines.some((line) => line.includes('differs from the database; the database is in force')), lines.join('\n'));
	assertFalse(lines.join('\n').includes('changed-value') || lines.join('\n').includes(BROWSER_SECRET));
	second.close();
	const forced = await openDataStore(config('{"pw":"changed-value-0123456789"}'), { seed: { force: true } });
	assertEquals(forced.secrets[0]?.value, 'changed-value-0123456789');
	forced.close();
	// An external manager's values are used as read, every start, and never copied in.
	const ref = await openDataStore(config('{"vaulted":"from-the-manager-0123456789"}', true));
	assertEquals(ref.secrets.map((entry) => entry.name), ['vaulted']);
	assertEquals(ref.seeded.find((result) => result.target === 'secrets')?.outcome, 'no-source');
	ref.close();
	assertFalse((await bytesOnDisk(s.dir)).includes(BROWSER_SECRET), 'browser secrets rest sealed');
});

Deno.test('D-154: without a data directory nothing is opened and the configuration is used as is', async () => {
	const config = loadConfig({}, { secrets: { TTK_SECRETS: `{"pw":"${BROWSER_SECRET}"}` } });
	const opened = await openDataStore(config);
	assertEquals([opened.store, opened.secrets.length, opened.seeded.length], [null, 1, 0]);
	opened.close();
});

Deno.test('D-154: the seeded providers load through the provider store with their keys opened', async () => {
	const db = Database.memory();
	const vault = await Vault.open(db, KEY);
	await seedDatabase({ db, vault }, { providers: FILE, secrets: null });
	const admin = await ModelProvidersAdmin.load({ operator: FILE, store: { db, vault } });
	const loaded = admin.effective()!;
	assertEquals([loaded.default, loaded.providers[0]?.apiKey, loaded.providers[0]?.keySource], [
		'cloud',
		PROVIDER_KEY,
		'stored',
	]);
	db.close();
});

// --- the link-signing key -----------------------------------------------------------------------------------------

Deno.test('D-154: the generated link-signing key is sealed in the vault, reused, and never written in plaintext', async () => {
	await using s = await scratch();
	const db = Database.open(s.dir);
	const vault = await Vault.open(db, KEY);
	const first = await loadLinkSigningKey({ key: null, dataDir: s.dir, vault });
	const second = await loadLinkSigningKey({ key: null, dataDir: s.dir, vault });
	assertEquals(second, first, 'a restart signs with the same key');
	assert(first.byteLength >= 32);
	assert(vault.has(LINK_KEY_SECRET_NAME));
	await assertRejects(() => Deno.stat(join(s.dir, LINK_KEY_FILE_NAME)), Deno.errors.NotFound);
	// The operator's file wins.
	const operator = 'k'.repeat(40);
	assertEquals(await loadLinkSigningKey({ key: operator, dataDir: s.dir, vault }), new TextEncoder().encode(operator));
	db.close();
	assertFalse((await bytesOnDisk(s.dir)).includes(new TextDecoder().decode(first)));
});

Deno.test('D-154: a plaintext link key from an earlier release moves into the vault and is deleted', async () => {
	await using s = await scratch();
	const legacy = 'L'.repeat(43);
	await Deno.writeTextFile(join(s.dir, LINK_KEY_FILE_NAME), `${legacy}\n`);
	const db = Database.open(s.dir);
	const vault = await Vault.open(db, KEY);
	assertEquals(
		await loadLinkSigningKey({ key: null, dataDir: s.dir, vault }),
		new TextEncoder().encode(legacy),
		'links signed before the upgrade keep verifying',
	);
	await assertRejects(() => Deno.stat(join(s.dir, LINK_KEY_FILE_NAME)), Deno.errors.NotFound);
	assertEquals(await vault.get(LINK_KEY_SECRET_NAME, ''), legacy);
	db.close();
});

Deno.test('D-154: with no key file and no unlocked vault a link key is refused, never generated in plaintext', async () => {
	await using s = await scratch();
	const locked = await Vault.open(Database.memory(), null);
	for (const vault of [null, locked]) {
		const refused = await assertRejects(
			() => loadLinkSigningKey({ key: null, dataDir: s.dir, vault }),
			SecretError,
		);
		assertStringIncludes(refused.message, 'TTK_DB_KEY_FILE');
	}
	await assertRejects(() => Deno.stat(join(s.dir, LINK_KEY_FILE_NAME)), Deno.errors.NotFound);
});

Deno.test('D-154: loadConfig decodes TTK_DB_KEY_FILE, refuses a malformed one, and gates generated link keys on it', () => {
	const key = generateDbKey();
	assertEquals(loadConfig({}, { secrets: { TTK_DB_KEY: key } }).dbKey, decodeDbKey(key));
	assertThrows(() => loadConfig({}, { secrets: { TTK_DB_KEY: 'not-a-key' } }), Error, 'TTK_DB_KEY_FILE');
	// Defaulted links: on with a data directory and a vault key, off (with a note) with a data directory alone.
	const withKey = loadConfig({ TTK_DATA_DIR: 'tests/.scratch/x' }, { secrets: { TTK_DB_KEY: key } });
	assert(withKey.signedLinks !== null);
	const without = loadConfig({ TTK_DATA_DIR: 'tests/.scratch/x' });
	assertEquals(without.signedLinks, null);
	assert(without.featureNotes.some((note) => note.includes('TTK_DB_KEY_FILE')));
	assertThrows(
		() => loadConfig({ TTK_DATA_DIR: 'tests/.scratch/x', TTK_SIGNED_LINKS: 'true' }),
		Error,
		'TTK_DB_KEY_FILE',
	);
});
