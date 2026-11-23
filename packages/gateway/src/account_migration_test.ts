/** The default grant excludes `admin`, and a scope-less version-1 account keeps the grant that includes it. */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { DEFAULT_SCOPES, SCOPELESS_ACCOUNT_SCOPES } from '@tykotech/mcp';
import { generateAdminUser } from './admin_auth.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startGateway } from './server.ts';
import { apiKeyAdminWarning, grantScopesInFile, USERS_SCHEMA_VERSION, UserStore, UserStoreError } from './users.ts';
import { scratch } from './support_test.ts';

const sorted = (names: readonly string[]) => [...names].sort();

/** A logger that keeps what it was told. */
function recorder() {
	const lines: Array<['info' | 'warn', string]> = [];
	return {
		lines,
		info: (message: string) => void lines.push(['info', message]),
		warn: (message: string) => void lines.push(['warn', message]),
	};
}

/** A stored account as a version-1 store holds it: no `scopes` means the grant that includes `admin`. */
async function versionOneAccount(username: string, scopes?: string[]) {
	const { record, password } = await generateAdminUser(username, 'correct horse battery');
	const { scopes: _dropped, ...bare } = record;
	const at = '2026-09-01T00:00:00.000Z';
	return { password, stored: { ...bare, ...(scopes === undefined ? {} : { scopes }), created_at: at, updated_at: at } };
}

Deno.test('users: a version-1 store is upgraded once; a scope-less admin keeps admin', async () => {
	const dir = await scratch();
	try {
		const root = await versionOneAccount('root');
		const narrow = await versionOneAccount('watcher', ['view:watch']);
		const path = join(dir, 'users.json');
		await Deno.writeTextFile(path, JSON.stringify({ version: 1, users: [root.stored, narrow.stored] }));

		const log = recorder();
		const store = new UserStore({ dataDir: dir, seed: null, logger: log });
		assertEquals(store.status, 'ok');
		assertEquals(sorted([...store.scopesOf('root')!]), sorted(SCOPELESS_ACCOUNT_SCOPES), 'root still holds admin');
		assert(store.scopesOf('root')!.has('admin'));
		assertEquals([...store.scopesOf('watcher')!], ['view:watch'], 'an account that named its scopes is untouched');
		assertEquals(log.lines, [['info', 'user store migrated: 1 account given explicit scopes']]);

		const file = JSON.parse(await Deno.readTextFile(path)) as {
			version: number;
			users: Array<{ username: string; scopes?: string[]; updated_at: string }>;
		};
		assertEquals(file.version, USERS_SCHEMA_VERSION);
		assertEquals(file.users.find((user) => user.username === 'root')?.scopes, [...SCOPELESS_ACCOUNT_SCOPES]);
		assertEquals(file.users.find((user) => user.username === 'root')?.updated_at, root.stored.updated_at);
		assert((await store.verify('root', root.password)) !== null, 'the password still verifies');

		// Idempotent: a second start finds version 2, changes nothing and says nothing.
		const before = await Deno.readTextFile(path);
		const again = recorder();
		const second = new UserStore({ dataDir: dir, seed: null, logger: again });
		assertEquals(again.lines, []);
		assertEquals(await Deno.readTextFile(path), before);
		assert(second.scopesOf('root')!.has('admin'));

		// After the upgrade, an account created without scopes gets the defaults — no admin.
		const fresh = await second.create({ username: 'fresh', password: 'correct horse battery' });
		assertEquals(sorted(fresh.scopes), sorted(DEFAULT_SCOPES));
		assert(!fresh.scopes.includes('admin'));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('users: an API key record without scopes resolves to the defaults, without admin', async () => {
	const key = await generateApiKey('bot');
	assertEquals(key.record.scopes, undefined);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([key.record]) }),
		allowAnonymous: false,
	});
	const principal = await verifier.resolve(key.key);
	assertEquals(sorted([...principal!.scopes]), sorted(DEFAULT_SCOPES));
	assert(!principal!.scopes.has('admin'), 'a key that names no scopes is not an administrator');
});

Deno.test('users: a scope-less seed seeds the store with SCOPELESS_ACCOUNT_SCOPES, on disk and in memory', async () => {
	const dir = await scratch();
	try {
		const { record, password } = await generateAdminUser('root', 'correct horse battery');
		const { scopes: _dropped, ...bare } = record;
		const log = recorder();
		const seeded = new UserStore({ dataDir: dir, seed: bare, logger: log });
		assertEquals(seeded.status, 'seeded');
		assert(seeded.scopesOf('root')!.has('admin'));
		const file = JSON.parse(await Deno.readTextFile(join(dir, 'users.json')));
		assertEquals(file.version, USERS_SCHEMA_VERSION);
		assertEquals(file.users[0].scopes, [...SCOPELESS_ACCOUNT_SCOPES]);
		assertEquals(log.lines, [[
			'info',
			'user store migrated: 1 account given explicit scopes (the TTK_ADMIN_USER seed)',
		]]);

		const memory = new UserStore({ dataDir: null, seed: bare });
		assert((await memory.verify('root', password))?.scopes.includes('admin'));

		// A seed that names its scopes is taken as it is, and is not reported as migrated.
		const quiet = recorder();
		const named = new UserStore({ dataDir: null, seed: { ...bare, scopes: ['mcp:invoke'] }, logger: quiet });
		assertEquals([...named.scopesOf('root')!], ['mcp:invoke']);
		assertEquals(quiet.lines, []);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('users: a store with accounts but no enabled admin is warned about at startup', async () => {
	const dir = await scratch();
	try {
		const watcher = await versionOneAccount('watcher', ['view:watch']);
		const path = join(dir, 'users.json');
		await Deno.writeTextFile(path, JSON.stringify({ version: 2, users: [watcher.stored] }));
		const warning = new UserStore({ dataDir: dir, seed: null }).adminWarning();
		assert(warning !== null);
		assertStringIncludes(warning, 'no enabled account holds the admin scope');
		assertStringIncludes(warning, 'doctor --grant');

		// A disabled administrator is no administrator.
		const disabled = await versionOneAccount('root', ['admin']);
		await Deno.writeTextFile(path, JSON.stringify({ version: 2, users: [{ ...disabled.stored, disabled: true }] }));
		assert(new UserStore({ dataDir: dir, seed: null }).adminWarning() !== null);

		await Deno.writeTextFile(path, JSON.stringify({ version: 2, users: [disabled.stored, watcher.stored] }));
		assertEquals(new UserStore({ dataDir: dir, seed: null }).adminWarning(), null);
		// No accounts at all is not this warning's business (the bind policy speaks to that).
		assertEquals(new UserStore({ dataDir: null, seed: null }).adminWarning(), null);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('doctor --grant (file): repairs one account offline, upgrading a v1 store in the same write', async () => {
	const dir = await scratch();
	try {
		const root = await versionOneAccount('root');
		const alice = await versionOneAccount('alice', ['view:watch']);
		const path = join(dir, 'users.json');
		await Deno.writeTextFile(path, JSON.stringify({ version: 1, users: [root.stored, alice.stored] }));

		const granted = await grantScopesInFile(dir, 'alice', ['mcp:invoke', 'admin']);
		assertEquals(granted.user.scopes, ['mcp:invoke', 'admin']);
		assertEquals(granted.migrated, 1, 'root was given SCOPELESS_ACCOUNT_SCOPES in the same write');
		const file = JSON.parse(await Deno.readTextFile(path));
		assertEquals(file.version, USERS_SCHEMA_VERSION);

		// Round trip: the gateway's next start sees exactly that, and has nothing left to upgrade.
		const log = recorder();
		const store = new UserStore({ dataDir: dir, seed: null, logger: log });
		assertEquals(log.lines, []);
		assert(store.scopesOf('alice')!.has('admin'));
		assert(store.scopesOf('root')!.has('admin'));
		assertEquals(store.enabledAdminCount(), 2);

		// Refusals: an unknown account, an unknown scope, no scopes, and leaving no enabled admin.
		await assertRejects(() => grantScopesInFile(dir, 'ghost', ['admin']), UserStoreError, 'no user');
		await assertRejects(() => grantScopesInFile(dir, 'alice', ['nonsense']), UserStoreError, 'unknown scope');
		await assertRejects(() => grantScopesInFile(dir, 'alice', undefined), UserStoreError, '--scopes');
		await grantScopesInFile(dir, 'root', ['mcp:invoke']);
		await assertRejects(() => grantScopesInFile(dir, 'alice', ['mcp:invoke']), UserStoreError, 'admin scope');
		await assertRejects(() => grantScopesInFile(join(dir, 'nowhere'), 'alice', ['admin']), UserStoreError, 'start');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('users: keys configured and no key or enabled account holding admin is warned about, naming the remedy', async () => {
	assertEquals(apiKeyAdminWarning([], 0), null, 'no keys: the account warning and the bind policy speak to that');
	const warning = apiKeyAdminWarning([{ scopes: ['mcp:invoke'] }, {}], 0);
	assert(warning !== null);
	assertStringIncludes(warning, 'no API key and no enabled account holds the admin scope');
	assertStringIncludes(warning, `add "admin" to a key's "scopes"`);
	assertStringIncludes(warning, 'which do not include admin', 'a scope-less key is named as the likely cause');
	assertEquals(apiKeyAdminWarning([{}, { scopes: ['mcp:invoke', 'admin'] }], 0), null, 'one admin key is enough');
	assertEquals(apiKeyAdminWarning([{}], 1), null, 'an enabled admin account manages the control plane');

	// At startup, through the real composition: a deployment whose only intended administrator is a scope-less key.
	const scopeless = await generateApiKey('scopeless');
	const reader = await generateApiKey('reader', ['mcp:invoke']);
	const started = async (records: unknown[]): Promise<string[]> => {
		const lines: string[] = [];
		const gateway = await startGateway({
			config: loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '0', TTK_API_KEYS: JSON.stringify(records) }),
			version: 'test',
			logger: createLogger({ level: 'warn', write: (line) => lines.push(line) }),
			launch: () => Promise.reject(new Error('no browser in this test')),
		});
		await gateway.shutdown();
		await gateway.finished;
		return lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
	};
	const warned = await started([scopeless.record, reader.record]);
	assert(warned.some((msg) => msg.startsWith('no API key and no enabled account holds the admin scope')), `${warned}`);
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'admin']);
	const quiet = await started([scopeless.record, admin.record]);
	assert(!quiet.some((msg) => msg.includes('admin scope')), `${quiet}`);
});
