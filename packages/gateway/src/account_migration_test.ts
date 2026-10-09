/**
 * G15 / D-098 (AC21): `admin` left the default grant (C7), and the accounts that relied on the old default keep it.
 *
 * A version-1 store is upgraded once — every scope-less account is given `LEGACY_DEFAULT_SCOPES` in writing and the
 * file becomes version 2 — and never again; a seed without scopes seeds with the same grant; the cluster's KV is
 * upgraded under its own marker key, outside the accounts' prefix (N2); a store with accounts and no enabled admin
 * is warned about; and `doctor --grant` repairs one account offline, in the file or in the KV.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { DEFAULT_SCOPES, LEGACY_DEFAULT_SCOPES } from '@tykotech/mcp';
import { generateAdminUser } from './admin_auth.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startGateway } from './server.ts';
import {
	apiKeyAdminWarning,
	grantScopesInCluster,
	grantScopesInFile,
	USERS_SCHEMA_KEY,
	USERS_SCHEMA_VERSION,
	UserStore,
	UserStoreError,
} from './users.ts';

const sorted = (names: readonly string[]) => [...names].sort();

async function scratch(): Promise<string> {
	const dir = join('tests/.scratch', `migrate-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	return dir;
}

/** A logger that keeps what it was told. */
function recorder() {
	const lines: Array<['info' | 'warn', string]> = [];
	return {
		lines,
		info: (message: string) => void lines.push(['info', message]),
		warn: (message: string) => void lines.push(['warn', message]),
	};
}

/** A stored account as a 0.2.0 store wrote it: no `scopes` meant the default grant, `admin` included. */
async function legacyAccount(username: string, scopes?: string[]) {
	const { record, password } = await generateAdminUser(username, 'correct horse battery');
	const { scopes: _dropped, ...bare } = record;
	const at = '2026-09-01T00:00:00.000Z';
	return { password, stored: { ...bare, ...(scopes === undefined ? {} : { scopes }), created_at: at, updated_at: at } };
}

Deno.test('users: a version-1 store is upgraded once; a scope-less admin keeps admin (G15, AC21)', async () => {
	const dir = await scratch();
	try {
		const root = await legacyAccount('root');
		const narrow = await legacyAccount('watcher', ['view:watch']);
		const path = join(dir, 'users.json');
		await Deno.writeTextFile(path, JSON.stringify({ version: 1, users: [root.stored, narrow.stored] }));

		const log = recorder();
		const store = new UserStore({ dataDir: dir, seed: null, logger: log });
		assertEquals(store.status, 'ok');
		assertEquals(sorted([...store.scopesOf('root')!]), sorted(LEGACY_DEFAULT_SCOPES), 'root still holds admin');
		assert(store.scopesOf('root')!.has('admin'));
		assertEquals([...store.scopesOf('watcher')!], ['view:watch'], 'an account that named its scopes is untouched');
		assertEquals(log.lines, [['info', 'user store migrated: 1 account given explicit scopes']]);

		const file = JSON.parse(await Deno.readTextFile(path)) as {
			version: number;
			users: Array<{ username: string; scopes?: string[]; updated_at: string }>;
		};
		assertEquals(file.version, USERS_SCHEMA_VERSION);
		assertEquals(file.users.find((user) => user.username === 'root')?.scopes, [...LEGACY_DEFAULT_SCOPES]);
		assertEquals(file.users.find((user) => user.username === 'root')?.updated_at, root.stored.updated_at);
		assert((await store.verify('root', root.password)) !== null, 'the password still verifies');

		// Idempotent: a second start finds version 2, changes nothing and says nothing.
		const before = await Deno.readTextFile(path);
		const again = recorder();
		const second = new UserStore({ dataDir: dir, seed: null, logger: again });
		assertEquals(again.lines, []);
		assertEquals(await Deno.readTextFile(path), before);
		assert(second.scopesOf('root')!.has('admin'));

		// After the upgrade, an account created without scopes gets the new defaults — no admin.
		const fresh = await second.create({ username: 'fresh', password: 'correct horse battery' });
		assertEquals(sorted(fresh.scopes), sorted(DEFAULT_SCOPES));
		assert(!fresh.scopes.includes('admin'));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('users: an API key record without scopes resolves to the new defaults, without admin (C7)', async () => {
	const key = await generateApiKey('bot');
	assertEquals(key.record.scopes, undefined);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([key.record]) }),
		allowAnonymous: false,
	});
	const principal = await verifier.resolve(key.key);
	assertEquals(sorted([...principal!.scopes]), sorted(DEFAULT_SCOPES));
	assert(!principal!.scopes.has('admin'), 'a key that names no scopes is not an administrator any more');
});

Deno.test('users: a scope-less seed seeds the store with the legacy grant, on disk and in memory (G15)', async () => {
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
		assertEquals(file.users[0].scopes, [...LEGACY_DEFAULT_SCOPES]);
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

Deno.test('users: a store with accounts but no enabled admin is warned about at startup (G15)', async () => {
	const dir = await scratch();
	try {
		const watcher = await legacyAccount('watcher', ['view:watch']);
		const path = join(dir, 'users.json');
		await Deno.writeTextFile(path, JSON.stringify({ version: 2, users: [watcher.stored] }));
		const warning = new UserStore({ dataDir: dir, seed: null }).adminWarning();
		assert(warning !== null);
		assertStringIncludes(warning, 'no enabled account holds the admin scope');
		assertStringIncludes(warning, 'doctor --grant');

		// A disabled administrator is no administrator.
		const disabled = await legacyAccount('root', ['admin']);
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

Deno.test({
	name: 'users: the cluster KV is upgraded once, under its own marker key outside the accounts (G15, N2, AC21)',
	sanitizeResources: false,
	sanitizeOps: false,
	fn: async () => {
		const dir = await scratch();
		const file = join(dir, 'cluster.kv');
		const kvA = await Deno.openKv(file);
		const kvB = await Deno.openKv(file);
		const kvC = await Deno.openKv(file);
		const root = await legacyAccount('root');
		const narrow = await legacyAccount('watcher', ['view:watch']);
		// A cluster as 0.2.0 left it: scope-less accounts under ['ttk','users'] and that collection's change counter.
		await kvA.atomic()
			.set(['ttk', 'users', 'root'], root.stored)
			.set(['ttk', 'users', 'watcher'], narrow.stored)
			.set(['ttk', 'users', '\u0000version'], crypto.randomUUID())
			.commit();
		const logA = recorder();
		const logB = recorder();
		const nodeA = new UserStore({ dataDir: null, seed: null, logger: logA });
		const nodeB = new UserStore({ dataDir: null, seed: null, logger: logB });
		const nodeC = new UserStore({ dataDir: null, seed: null });
		try {
			await nodeA.attachCluster(kvA, { pollMs: 50 });
			assert(nodeA.scopesOf('root')!.has('admin'), 'root keeps admin across the upgrade');
			assertEquals([...nodeA.scopesOf('watcher')!], ['view:watch']);
			assertEquals(logA.lines, [['info', 'user store migrated: 1 account given explicit scopes (cluster store)']]);
			const stored = await kvA.get<{ scopes?: string[] }>(['ttk', 'users', 'root']);
			assertEquals(stored.value?.scopes, [...LEGACY_DEFAULT_SCOPES], 'written into the KV, not only memory');
			assertEquals((await kvA.get(USERS_SCHEMA_KEY)).value, USERS_SCHEMA_VERSION);
			// The marker is not under the accounts' prefix: the replica never lists it as an account.
			const listed: string[] = [];
			for await (const entry of kvA.list({ prefix: ['ttk', 'users'] })) listed.push(String(entry.key.at(-1)));
			assertEquals(listed.filter((key) => key !== '\u0000version').sort(), ['root', 'watcher']);

			// A second node finds the marker and does nothing.
			await nodeB.attachCluster(kvB, { pollMs: 50 });
			assertEquals(logB.lines, []);
			assert(nodeB.scopesOf('root')!.has('admin'));

			// The marker, not the change counter, says the upgrade ran: a scope-less record written after it (by
			// anything) moves the counter and is still not upgraded by a node that attaches later.
			const late = await legacyAccount('late');
			await kvA.atomic()
				.set(['ttk', 'users', 'late'], late.stored)
				.set(['ttk', 'users', '\u0000version'], crypto.randomUUID())
				.commit();
			await nodeC.attachCluster(kvC, { pollMs: 50 });
			assertEquals(sorted([...nodeC.scopesOf('late')!]), sorted(DEFAULT_SCOPES), 'the new defaults, no admin');
			assertEquals((await kvA.get<{ scopes?: string[] }>(['ttk', 'users', 'late'])).value?.scopes, undefined);
		} finally {
			nodeA.detachCluster();
			nodeB.detachCluster();
			nodeC.detachCluster();
			kvA.close();
			kvB.close();
			kvC.close();
			await new Promise((resolve) => setTimeout(resolve, 100));
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		}
	},
});

Deno.test('doctor --grant (file): repairs one account offline, upgrading a v1 store in the same write (G15, AC21)', async () => {
	const dir = await scratch();
	try {
		const root = await legacyAccount('root');
		const alice = await legacyAccount('alice', ['view:watch']);
		const path = join(dir, 'users.json');
		await Deno.writeTextFile(path, JSON.stringify({ version: 1, users: [root.stored, alice.stored] }));

		const granted = await grantScopesInFile(dir, 'alice', ['mcp:invoke', 'admin']);
		assertEquals(granted.user.scopes, ['mcp:invoke', 'admin']);
		assertEquals(granted.migrated, 1, 'root was given its legacy grant in the same write');
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

Deno.test({
	name: 'doctor --grant (cluster): writes the KV through the replica, and a running node picks it up (N2, AC21)',
	sanitizeResources: false,
	sanitizeOps: false,
	fn: async () => {
		const dir = await scratch();
		const file = join(dir, 'cluster.kv');
		const kvNode = await Deno.openKv(file);
		const kvDoctor = await Deno.openKv(file);
		const watcher = await legacyAccount('watcher', ['view:watch']);
		await kvNode.atomic()
			.set(['ttk', 'users', 'watcher'], watcher.stored)
			.set(['ttk', 'users', '\u0000version'], crypto.randomUUID())
			.commit();
		const node = new UserStore({ dataDir: null, seed: null });
		try {
			await node.attachCluster(kvNode, { pollMs: 50 });
			assert(node.adminWarning() !== null, 'the cluster has no administrator');

			const { user, migrated } = await grantScopesInCluster(kvDoctor, 'watcher', ['view:watch', 'admin']);
			assertEquals(user.scopes, ['view:watch', 'admin']);
			assertEquals(migrated, 0, 'the node already upgraded the cluster');
			const deadline = Date.now() + 5_000;
			while (!node.scopesOf('watcher')?.has('admin')) {
				if (Date.now() > deadline) throw new Error('the running node never saw the grant');
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assertEquals(node.adminWarning(), null);
			await assertRejects(() => grantScopesInCluster(kvDoctor, 'ghost', ['admin']), UserStoreError, 'no user');
			await assertRejects(
				() => grantScopesInCluster(kvDoctor, 'watcher', ['view:watch']),
				UserStoreError,
				'admin scope',
			);
		} finally {
			node.detachCluster();
			kvNode.close();
			kvDoctor.close();
			await new Promise((resolve) => setTimeout(resolve, 100));
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		}
	},
});

Deno.test('R1-10: keys configured and no key or enabled account holding admin is warned about, naming the remedy', async () => {
	assertEquals(apiKeyAdminWarning([], 0), null, 'no keys: the account warning and the bind policy speak to that');
	const warning = apiKeyAdminWarning([{ scopes: ['mcp:invoke'] }, {}], 0);
	assert(warning !== null);
	assertStringIncludes(warning, 'no API key and no enabled account holds the admin scope');
	assertStringIncludes(warning, `add "admin" to a key's "scopes"`);
	assertStringIncludes(warning, 'no longer include admin', 'a scope-less key is named as the likely cause');
	assertEquals(apiKeyAdminWarning([{}, { scopes: ['mcp:invoke', 'admin'] }], 0), null, 'one admin key is enough');
	assertEquals(apiKeyAdminWarning([{}], 1), null, 'an enabled admin account manages the control plane');

	// At startup, through the real composition: an upgrade whose only administrator was a scope-less key.
	const legacy = await generateApiKey('legacy');
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
	const warned = await started([legacy.record, reader.record]);
	assert(warned.some((msg) => msg.startsWith('no API key and no enabled account holds the admin scope')), `${warned}`);
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'admin']);
	const quiet = await started([legacy.record, admin.record]);
	assert(!quiet.some((msg) => msg.includes('admin scope')), `${quiet}`);
});
