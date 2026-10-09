/**
 * D-146: accounts hold API keys minted from the control plane — the store, the verifier and the routes.
 *
 * The properties pinned here: the store never holds a raw key and never lists a hash; a key never holds a scope its
 * account does not, and narrowing the account narrows the key; a key authenticates **as its account**
 * (`admin:<username>`) under its own credential (`user-key:<sha256>`), so revoking it — or disabling or deleting the
 * account — ends its sign-ins, tasks and streams at once while the password sign-in carries on.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateAdminUser } from './admin_auth.ts';
import { expansionOwner, generateAccountKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { LoginStore, sha256Hex } from './logins.ts';
import { grantScopesInFile, MAX_KEYS_PER_ACCOUNT, UserStore, UserStoreError } from './users.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const quiet = () => createLogger({ level: 'error', write: (): void => {} });

async function scratch(): Promise<string> {
	const dir = join('tests/.scratch', `account-keys-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	return dir;
}

/** A freshly minted key as the route hands it to the store: never the secret. */
async function minted(scopes?: string[], label?: string) {
	const key = await generateAccountKey();
	return {
		secret: key.secret,
		input: {
			id: key.id,
			prefix: key.prefix,
			sha256: key.sha256,
			...(scopes === undefined ? {} : { scopes }),
			...(label === undefined ? {} : { label }),
		},
	};
}

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

Deno.test('D-146: generateAccountKey mints a ttk_ key, a path-safe id and the prefix and hash the store keeps', async () => {
	const key = await generateAccountKey();
	assert(key.secret.startsWith('ttk_'));
	assert(/^k_[a-z2-7]{10}$/.test(key.id), key.id);
	assertEquals(key.prefix, key.secret.slice(0, 8));
	assertEquals(key.sha256, await sha256Hex(key.secret));
	assert((await generateAccountKey()).id !== key.id);
});

Deno.test('D-146: the store adds, finds and removes keys under the account rules, and persists only hashes', async () => {
	const dir = await scratch();
	try {
		const { record } = await generateAdminUser('root');
		const store = new UserStore({ dataDir: dir, seed: record });
		await store.create({ username: 'alice', password: 'correct horse', scopes: ['mcp:invoke', 'view:watch'] });

		const first = await minted(['mcp:invoke'], '  CI runner  ');
		const added = await store.addKey('alice', first.input);
		assertEquals(added, {
			id: first.input.id,
			label: 'CI runner',
			prefix: first.input.prefix,
			scopes: ['mcp:invoke'],
			created_at: added.created_at,
		});
		const hit = store.findKey(first.input.sha256);
		assertEquals(hit?.username, 'alice');
		assertEquals([...hit!.scopes], ['mcp:invoke']);
		assertEquals(store.findKey('0'.repeat(64)), null);

		// Omitted scopes are the account's at the moment of the write; an omitted or blank label is none.
		const second = await minted(undefined, '   ');
		const defaulted = await store.addKey('alice', second.input);
		assertEquals(defaulted.scopes, ['mcp:invoke', 'view:watch']);
		assertEquals(defaulted.label, null);

		// A key never widens its account.
		await assertRejects(
			async () => store.addKey('alice', (await minted(['mcp:invoke', 'admin'])).input),
			UserStoreError,
			'a key cannot hold a scope its account does not: admin',
		);
		await assertRejects(async () => store.addKey('alice', (await minted(['nope'])).input), UserStoreError, '"nope"');
		for (const label of ['<b>', 'tab\there', 'x'.repeat(65), 42]) {
			const error = await assertRejects(
				async () => store.addKey('alice', (await minted(undefined, label as string)).input),
				UserStoreError,
			);
			assertEquals(error.code, 'invalid-label', String(label));
		}
		const badId = await assertRejects(
			async () => store.addKey('alice', { ...(await minted()).input, id: 'has/slash' }),
			UserStoreError,
		);
		assertEquals(badId.code, 'invalid-key');
		const duplicateId = await assertRejects(
			async () => store.addKey('alice', { ...(await minted()).input, id: first.input.id }),
			UserStoreError,
		);
		assertEquals(duplicateId.code, 'duplicate');
		// A hash is unique across every account, not only within one.
		const duplicateHash = await assertRejects(
			async () => store.addKey('root', { ...(await minted()).input, sha256: first.input.sha256 }),
			UserStoreError,
		);
		assertEquals(duplicateHash.code, 'duplicate');
		const ghost = await assertRejects(async () => store.addKey('ghost', (await minted()).input), UserStoreError);
		assertEquals(ghost.code, 'not-found');

		// The public view lists the keys and never a hash; the file holds the hash and never the key.
		const listed = JSON.stringify(store.list());
		assertEquals(store.get('alice')?.keys.map((key) => key.id), [first.input.id, second.input.id]);
		assert(!listed.includes(first.input.sha256) && !listed.includes(first.secret));
		const onDisk = await Deno.readTextFile(join(dir, 'users.json'));
		assertStringIncludes(onDisk, first.input.sha256);
		assert(!onDisk.includes(first.secret) && !onDisk.includes(second.secret));
		assertEquals(JSON.parse(onDisk).version, 2, 'an additive field: the schema version is unchanged');

		// A restart reads them back, and the index answers from the new process's map.
		const reloaded = new UserStore({ dataDir: dir, seed: null });
		assertEquals(reloaded.findKey(first.input.sha256)?.username, 'alice');
		assertEquals(reloaded.get('alice')?.keys.length, 2);

		// Narrowing the account narrows the key, without rewriting it; widening it back restores the key's own grant.
		await store.update('alice', { scopes: ['view:watch'] });
		assertEquals([...store.findKey(first.input.sha256)!.scopes], []);
		assertEquals(store.get('alice')?.keys[0]?.scopes, ['mcp:invoke'], 'the stored scopes stay');
		await store.update('alice', { scopes: ['mcp:invoke', 'view:watch'] });
		assertEquals([...store.findKey(first.input.sha256)!.scopes], ['mcp:invoke']);

		// A disabled account's keys find nothing; enabling it brings them back.
		await store.update('alice', { disabled: true });
		assertEquals(store.findKey(first.input.sha256), null);
		await store.update('alice', { disabled: false });
		assert(store.findKey(first.input.sha256) !== null);

		// `doctor --grant` keeps the keys (it spreads the record it changes).
		await grantScopesInFile(dir, 'alice', ['mcp:invoke', 'view:watch', 'evaluate']);
		assertEquals(new UserStore({ dataDir: dir, seed: null }).get('alice')?.keys.length, 2);

		// Removing a key answers its hash, once.
		assertEquals(await store.removeKey('alice', first.input.id), { sha256: first.input.sha256 });
		assertEquals(store.findKey(first.input.sha256), null);
		const again = await assertRejects(() => store.removeKey('alice', first.input.id), UserStoreError, 'holds no key');
		assertEquals(again.code, 'not-found');
		await assertRejects(() => store.removeKey('ghost', 'k_x'), UserStoreError, 'no user');
		await store.removeKey('alice', second.input.id);
		const bare = JSON.parse(await Deno.readTextFile(join(dir, 'users.json'))).users.find(
			(user: { username: string }) => user.username === 'alice',
		);
		assertEquals('keys' in bare, false, 'an account with no keys is written as before D-146');

		// Deleting the account deletes its keys.
		const third = await minted();
		await store.addKey('alice', third.input);
		await store.remove('alice');
		assertEquals(store.findKey(third.input.sha256), null);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-146: an account holds at most 25 keys; a refused first key creates no account; memory is read-only', async () => {
	const dir = await scratch();
	try {
		const { record } = await generateAdminUser('root');
		const store = new UserStore({ dataDir: dir, seed: record });
		for (let i = 0; i < MAX_KEYS_PER_ACCOUNT; i += 1) await store.addKey('root', (await minted()).input);
		const capped = await assertRejects(async () => store.addKey('root', (await minted()).input), UserStoreError);
		assertEquals(capped.code, 'too-many-keys');
		assertEquals(store.get('root')?.keys.length, MAX_KEYS_PER_ACCOUNT);

		// The account and its first key are one write.
		const key = await minted(['admin']);
		await assertRejects(
			() => store.create({ username: 'ops', password: 'correct horse', scopes: ['mcp:invoke'], key: key.input }),
			UserStoreError,
			'cannot hold a scope',
		);
		assertEquals(store.get('ops'), null, 'nothing was created');
		const ok = await minted();
		const created = await store.create({
			username: 'ops',
			password: 'correct horse',
			scopes: ['mcp:invoke'],
			key: ok.input,
		});
		assertEquals(created.keys.map((entry) => [entry.id, entry.scopes]), [[ok.input.id, ['mcp:invoke']]]);
		assertEquals(store.findKey(ok.input.sha256)?.username, 'ops');

		const memory = new UserStore({ dataDir: null, seed: record });
		await assertRejects(async () => memory.addKey('root', (await minted()).input), UserStoreError, 'TTK_DATA_DIR');
		await assertRejects(() => memory.removeKey('root', 'k_x'), UserStoreError, 'TTK_DATA_DIR');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-146: an account key authenticates as its account, narrowed, and its revocation ends its work now', async () => {
	const { record } = await generateAdminUser('root');
	const dir = await scratch();
	try {
		const users = new UserStore({ dataDir: dir, seed: record });
		await users.create({
			username: 'alice',
			password: 'correct horse',
			scopes: ['mcp:invoke', 'view:watch', 'agent:invoke'],
		});
		const verifier = new VerifierChain({
			config: loadConfig({ TTK_ADMIN_USER: JSON.stringify(record) }),
			allowAnonymous: false,
			users,
			logins: new LoginStore({ dataDir: null }),
		});
		let changes = 0;
		verifier.onCredentialsChanged(() => void (changes += 1));

		const key = await minted(['mcp:invoke', 'agent:invoke']);
		await users.addKey('alice', key.input);
		const principal = await verifier.resolve(key.secret);
		assert(principal);
		assertEquals(principal.kind, 'api-key');
		assertEquals(principal.id, 'admin:alice', 'the account, so it owns what the account owns');
		assertEquals(principal.label, 'Administrator (alice)');
		assertEquals(principal.credential, `user-key:${key.input.sha256}`);
		assertEquals([...principal.scopes].sort(), ['agent:invoke', 'mcp:invoke']);
		const owner = expansionOwner(principal);
		assertEquals(owner, 'api-key:admin:alice');
		// The bearer gate takes it; a stranger's key, and a key with a stripped prefix, are not it.
		assertEquals((await verifier.verifyAccessToken(key.secret)).clientId, 'admin:alice');
		assertEquals(await verifier.resolve(`ttk_${'A'.repeat(43)}`), null);
		assertEquals(await verifier.resolve(key.secret.slice(4)), null);

		// GW-1: work bound to the key answers for the key, and only as its own account.
		assertEquals(
			[...verifier.authorizeTask(owner, new Set(['mcp:invoke', 'view:watch']), principal.credential)!],
			['mcp:invoke'],
			'a task never holds more than the key',
		);
		assertEquals(verifier.authorizeTask('api-key:admin:root', new Set(['mcp:invoke']), principal.credential), null);
		assert(verifier.stillAuthorized(principal));
		// D-148: a signed link minted under the key answers for the key (its id is the link's `k`); one with no key — a
		// password sign-in's, or any minted before D-148 — for the account.
		assert(verifier.ownerScopes(owner)?.has('view:watch'));
		assertEquals([...verifier.ownerScopes(owner, key.input.id)!].sort(), ['agent:invoke', 'mcp:invoke']);

		// Narrowing the account narrows the key at its next use.
		await users.update('alice', { scopes: ['mcp:invoke', 'view:watch'] });
		assertEquals([...(await verifier.resolve(key.secret))!.scopes], ['mcp:invoke']);
		assertEquals([...verifier.currentScopes(principal)!], ['mcp:invoke']);

		// Exchanging the key at the login route opens a sign-in backed by the key itself.
		const session = await verifier.mintSession(principal);
		const login = verifier.logins.get(await sha256Hex(session.token));
		assertEquals(login?.backing, `user-key:${key.input.sha256}`);
		const viaSession = await verifier.resolve(session.token);
		assertEquals(viaSession?.id, 'admin:alice');
		assertEquals([...viaSession!.scopes], ['mcp:invoke']);
		assert(verifier.authorizeTask(owner, new Set(['mcp:invoke']), viaSession!.credential));

		// The password sign-in is a different credential, and survives the key's revocation.
		const password = await verifier.verifyAdmin('alice', 'correct horse');
		const passwordSession = await verifier.mintSession(password!);

		// Revoking: the store write stops resolution; `revokeCredential` ends what the key backed, and says so.
		const { sha256 } = await users.removeKey('alice', key.input.id);
		const before = changes;
		assertEquals(verifier.revokeCredential(`user-key:${sha256}`), 1);
		assert(changes > before, 'listeners are told, so tasks and streams fail now');
		assertEquals(verifier.logins.get(await sha256Hex(session.token)), null);
		assertEquals(await verifier.resolve(key.secret), null);
		assertEquals(await verifier.resolve(session.token), null);
		assertEquals(verifier.authorizeTask(owner, new Set(['mcp:invoke']), principal.credential), null);
		assertEquals(verifier.authorizeTask(owner, new Set(['mcp:invoke']), viaSession!.credential), null);
		assertEquals(verifier.stillAuthorized(principal), false);
		assertEquals((await verifier.resolve(passwordSession.token))?.id, 'admin:alice');

		// Disabling the account ends its keys' sign-ins through the lapsed sweep.
		const other = await minted();
		await users.addKey('alice', other.input);
		const otherPrincipal = await verifier.resolve(other.secret);
		const otherSession = await verifier.mintSession(otherPrincipal!);
		assertEquals(verifier.revokeLapsedAccountKeys(), 0, 'nothing lapsed while the account is enabled');
		await users.update('alice', { disabled: true });
		assertEquals(await verifier.resolve(other.secret), null);
		assertEquals(verifier.revokeLapsedAccountKeys(), 1);
		assertEquals(verifier.logins.get(await sha256Hex(otherSession.token)), null);
		assertEquals(verifier.stillAuthorized(otherPrincipal!), false);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-146: the routes mint a key once, list it without its secret or hash, and revoke what it backed', async () => {
	const dir = await scratch();
	const { record, password } = await generateAdminUser('root');
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
		TTK_DATA_DIR: dir,
	});
	const users = new UserStore({ dataDir: dir, seed: record });
	const logins = new LoginStore({ dataDir: dir });
	const verifier = new VerifierChain({ config, allowAnonymous: false, users, logins });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	const call = async (method: string, path: string, token: string | null, body?: unknown, raw?: string) => {
		const response = await gateway.app.request(`${ORIGIN}${path}`, {
			method,
			headers: {
				host: '127.0.0.1:8787',
				...(body === undefined && raw === undefined ? {} : { 'content-type': 'application/json' }),
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
			},
			...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		// A malformed JSON body is refused by the MCP adapter's body parser before any route, as plain text.
		let json = null;
		try {
			json = text === '' ? null : JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: response.status, headers: response.headers, text, json };
	};
	try {
		const root = (await call('POST', '/api/v1/auth/login', null, { username: 'root', password })).json.token as string;

		// A new account is issued its first key in the creating response, beside its generated password.
		const created = await call('POST', '/api/v1/users', root, {
			username: 'ops',
			scopes: ['mcp:invoke', 'view:watch'],
			api_key: { label: 'CI', scopes: ['mcp:invoke'] },
		});
		assertEquals(created.status, 201, created.text);
		assertEquals(created.headers.get('cache-control'), 'no-store');
		assert(typeof created.json.password === 'string');
		const secret: string = created.json.api_key.secret;
		assert(secret.startsWith('ttk_'));
		assertEquals(created.json.api_key.key, {
			id: created.json.api_key.key.id,
			label: 'CI',
			prefix: secret.slice(0, 8),
			scopes: ['mcp:invoke'],
			created_at: created.json.api_key.key.created_at,
		});
		assertEquals(created.json.user.keys, [created.json.api_key.key], 'the user view reflects the key');
		const sha = await sha256Hex(secret);
		assert(!JSON.stringify(created.json.user).includes(sha));

		// `true` is a key with the account's scopes; no `api_key` is no key, as before.
		const plain = await call('POST', '/api/v1/users', root, { username: 'plain', password: 'correct horse' });
		assertEquals(plain.json.user.keys, []);
		assertEquals(plain.json.api_key, undefined);
		const whole = await call('POST', '/api/v1/users', root, {
			username: 'whole',
			password: 'correct horse',
			scopes: ['view:watch'],
			api_key: true,
		});
		assertEquals(whole.json.api_key.key.scopes, ['view:watch']);
		assertEquals(whole.json.password, undefined);
		// A refused key refuses the account with it.
		const beyond = await call('POST', '/api/v1/users', root, {
			username: 'beyond',
			password: 'correct horse',
			scopes: ['view:watch'],
			api_key: { scopes: ['admin'] },
		});
		assertEquals(beyond.status, 400);
		assertStringIncludes(beyond.json.detail, 'a key cannot hold a scope its account does not: admin');
		assertEquals(
			(await call('POST', '/api/v1/users', root, { username: 'odd', password: 'correct horse', api_key: 'yes' }))
				.status,
			400,
		);

		// The list carries the keys, and nowhere the secret or the hash.
		const list = await call('GET', '/api/v1/users', root);
		assertEquals(list.json.users.find((user: { username: string }) => user.username === 'ops').keys.length, 1);
		assertEquals(list.json.users.some((user: { username: string }) => user.username === 'beyond'), false);
		assert(!list.text.includes(secret) && !list.text.includes(sha));

		// The key is a bearer credential for the account, narrowed to the key.
		const me = await call('GET', '/api/v1/auth/me', secret);
		assertEquals(me.status, 200);
		assertEquals(me.json.user.id, 'admin:ops');
		assertEquals(me.json.user.username, 'ops');
		assertEquals(me.json.user.scopes, ['mcp:invoke']);
		// ...without admin, so it reaches none of these routes.
		assertEquals((await call('GET', '/api/v1/users', secret)).status, 403);
		assertEquals((await call('POST', '/api/v1/users/ops/keys', secret, {})).status, 403);
		assertEquals((await call('DELETE', `/api/v1/users/ops/keys/${created.json.api_key.key.id}`, secret)).status, 403);

		// Exchanged at the login route, it opens a sign-in backed by the key.
		const exchanged = await call('POST', '/api/v1/auth/login', null, { apiKey: secret });
		assertEquals(exchanged.status, 200);
		assertEquals(exchanged.json.user.username, 'ops');
		const keySession: string = exchanged.json.token;
		assertEquals((await call('GET', '/api/v1/auth/me', keySession)).json.session.backing, 'user-key');
		// D-148: it may change its account's password, but only given the current one (pinned in full below).
		assertEquals(
			(await call('POST', '/api/v1/auth/password', keySession, { current: 'a', next: 'brand new pass' })).status,
			401,
		);

		// Minting more: a label and narrower scopes, an empty body for the defaults; malformed bodies are refused.
		const second = await call('POST', '/api/v1/users/ops/keys', root, { label: 'laptop', scopes: ['view:watch'] });
		assertEquals(second.status, 201, second.text);
		assertEquals(second.headers.get('cache-control'), 'no-store');
		assertEquals(second.json.key.label, 'laptop');
		assertEquals(second.json.key.scopes, ['view:watch']);
		assert((second.json.secret as string).startsWith('ttk_'));
		const defaults = await call('POST', '/api/v1/users/ops/keys', root);
		assertEquals(defaults.status, 201, defaults.text);
		assertEquals(defaults.json.key.scopes, ['mcp:invoke', 'view:watch']);
		assertEquals((await call('POST', '/api/v1/users/ops/keys', root, undefined, '{not json')).status, 400);
		assertEquals((await call('POST', '/api/v1/users/ops/keys', root, undefined, '[]')).status, 400);
		assertEquals((await call('POST', '/api/v1/users/ops/keys', root, { scopes: ['admin'] })).status, 400);
		assertEquals((await call('POST', '/api/v1/users/ops/keys', root, { label: '<script>' })).status, 400);
		assertEquals((await call('POST', '/api/v1/users/ghost/keys', root, {})).status, 404);
		// An administrator may hold keys on their own account.
		const own = await call('POST', '/api/v1/users/root/keys', root, { label: 'mine' });
		assertEquals(own.status, 201);
		assertEquals((await call('GET', '/api/v1/auth/me', own.json.secret)).json.user.id, 'admin:root');

		// Revoking ends the key and the sign-in it backed; the account's other keys carry on.
		const revoked = await call('DELETE', `/api/v1/users/ops/keys/${created.json.api_key.key.id}`, root);
		assertEquals(revoked.status, 204);
		assertEquals((await call('GET', '/api/v1/auth/me', secret)).status, 401);
		assertEquals((await call('GET', '/api/v1/auth/me', keySession)).status, 401);
		assertEquals((await call('GET', '/api/v1/auth/me', second.json.secret)).status, 200);
		assertEquals((await call('DELETE', `/api/v1/users/ops/keys/${created.json.api_key.key.id}`, root)).status, 404);
		assertEquals((await call('DELETE', '/api/v1/users/ghost/keys/k_x', root)).status, 404);

		// Disabling the account ends its keys' sign-ins now; deleting it removes them.
		const laptopSession = (await call('POST', '/api/v1/auth/login', null, { apiKey: second.json.secret })).json
			.token as string;
		assertEquals((await call('PATCH', '/api/v1/users/ops', root, { disabled: true })).status, 200);
		assertEquals(verifier.logins.get(await sha256Hex(laptopSession)), null, 'closed by the route, not lazily');
		assertEquals((await call('GET', '/api/v1/auth/me', second.json.secret)).status, 401);
		assertEquals((await call('PATCH', '/api/v1/users/ops', root, { disabled: false })).status, 200);
		assertEquals((await call('GET', '/api/v1/auth/me', second.json.secret)).status, 200, 'the key itself survives');
		const lastSession = (await call('POST', '/api/v1/auth/login', null, { apiKey: second.json.secret })).json
			.token as string;
		assertEquals((await call('DELETE', '/api/v1/users/ops', root)).status, 204);
		assertEquals(verifier.logins.get(await sha256Hex(lastSession)), null);
		assertEquals((await call('GET', '/api/v1/auth/me', second.json.secret)).status, 401);
	} finally {
		await gateway.close();
		await registry.shutdown();
		await logins.flush();
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-146: the routes answer persistence-required without a data directory', async () => {
	const { record, password } = await generateAdminUser('root');
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_ADMIN_USER: JSON.stringify(record) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	try {
		const headers = { host: '127.0.0.1:8787', 'content-type': 'application/json' };
		const login = await gateway.app.request(`${ORIGIN}/api/v1/auth/login`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ username: 'root', password }),
		});
		const { token } = await login.json();
		const minted = await gateway.app.request(`${ORIGIN}/api/v1/users/root/keys`, {
			method: 'POST',
			headers: { ...headers, authorization: `Bearer ${token}` },
			body: '{}',
		});
		assertEquals(minted.status, 409);
		assertEquals((await minted.json()).type, 'https://tykotech.eu/problems/persistence-required');
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});

Deno.test({
	name: 'D-146: a key minted on one cluster node resolves on the other, and its revocation reaches both',
	sanitizeResources: false,
	sanitizeOps: false,
	fn: async () => {
		const dir = await scratch();
		const file = join(dir, 'cluster.kv');
		const { record } = await generateAdminUser('root');
		const config = loadConfig({ TTK_ADMIN_USER: JSON.stringify(record) });
		const kvA = await Deno.openKv(file);
		const kvB = await Deno.openKv(file);
		const usersA = new UserStore({ dataDir: join(dir, 'a'), seed: record });
		const usersB = new UserStore({ dataDir: join(dir, 'b'), seed: null });
		try {
			await usersA.attachCluster(kvA, { pollMs: 50 });
			await usersB.attachCluster(kvB, { pollMs: 50 });
			const nodeB = new VerifierChain({ config, allowAnonymous: false, users: usersB });
			const key = await minted(['mcp:invoke']);
			await usersA.addKey('root', key.input);
			await until(() => usersB.findKey(key.input.sha256) !== null, 'B seeing the key');
			assertEquals((await nodeB.resolve(key.secret))?.id, 'admin:root');
			// Concurrent mints on both nodes both land: the loser retries against the fresh record.
			const [fromA, fromB] = [await minted(), await minted()];
			await Promise.all([usersA.addKey('root', fromA.input), usersB.addKey('root', fromB.input)]);
			await until(
				() => usersA.get('root')?.keys.length === 3 && usersB.get('root')?.keys.length === 3,
				'both mints on both nodes',
			);
			await usersB.removeKey('root', key.input.id);
			await until(() => usersA.findKey(key.input.sha256) === null, 'A seeing the revocation');
			assertEquals(await nodeB.resolve(key.secret), null);
		} finally {
			usersA.detachCluster();
			usersB.detachCluster();
			kvA.close();
			kvB.close();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		}
	},
});

Deno.test('D-148: a link minted under an account key binds that key; a password sign-in, or no credential, binds the account', async () => {
	const { record } = await generateAdminUser('root');
	const dir = await scratch();
	try {
		const users = new UserStore({ dataDir: dir, seed: record });
		await users.create({ username: 'alice', password: 'correct horse', scopes: ['mcp:invoke', 'view:watch'] });
		const verifier = new VerifierChain({
			config: loadConfig({ TTK_ADMIN_USER: JSON.stringify(record) }),
			allowAnonymous: false,
			users,
			logins: new LoginStore({ dataDir: null }),
		});
		const owner = 'api-key:admin:alice';
		const [one, two] = [await minted(['mcp:invoke']), await minted()];
		await users.addKey('alice', one.input);
		await users.addKey('alice', two.input);
		const account = verifier.ownerCredentialDigest(owner)!;
		const viaKey = (await verifier.resolve(one.secret))!;

		// The key as a bearer, and a sign-in opened with it, bind the key: its id travels as `k`, its hash only inside
		// the digest the epoch is keyed over.
		const bound = verifier.linkBinding(owner, viaKey.credential);
		assertEquals(bound?.key, one.input.id);
		assertEquals(bound?.digest, verifier.ownerCredentialDigest(owner, one.input.id));
		assert(bound!.digest !== account && bound!.digest !== verifier.ownerCredentialDigest(owner, two.input.id));
		const keySession = await verifier.mintSession(viaKey);
		const viaKeySession = (await verifier.resolve(keySession.token))!;
		assertEquals(viaKeySession.credential?.startsWith('session:'), true);
		assertEquals(verifier.linkBinding(owner, viaKeySession.credential), bound);
		// A password sign-in, and a call with no credential bound at all (every link before D-148), bind the account.
		const password = await verifier.mintSession((await verifier.verifyAdmin('alice', 'correct horse'))!);
		const viaPassword = (await verifier.resolve(password.token))!;
		assertEquals(verifier.linkBinding(owner, viaPassword.credential), { digest: account });
		assertEquals(verifier.linkBinding(owner, undefined), { digest: account });
		// Another account's owner, or a sign-in closed since the call was authenticated: not in force.
		assertEquals(verifier.linkBinding('api-key:admin:root', viaKey.credential), null);
		await verifier.closeSession(keySession.token);
		assertEquals(verifier.linkBinding(owner, viaKeySession.credential), null);

		// The route's questions, by key id: the key's scopes now (narrowed to the account's), only on its own account.
		assertEquals([...verifier.ownerScopes(owner, one.input.id)!], ['mcp:invoke']);
		assertEquals(verifier.ownerScopes(owner, 'k_unknown000'), null);
		assertEquals(verifier.ownerScopes('api-key:admin:root', one.input.id), null);
		assertEquals(verifier.ownerScopes('api-key:e2e', one.input.id), null);
		assertEquals(verifier.ownerCredentialDigest('api-key:e2e', one.input.id), null);
		await users.update('alice', { scopes: ['view:watch'] });
		assertEquals([...verifier.ownerScopes(owner, one.input.id)!], [], 'narrowing the account narrows the key');
		await users.update('alice', { scopes: ['mcp:invoke', 'view:watch'] });

		// Deleting the key ends its binding; the account's other key and its password keep theirs.
		const twoDigest = verifier.ownerCredentialDigest(owner, two.input.id);
		await users.removeKey('alice', one.input.id);
		assertEquals(verifier.linkBinding(owner, viaKey.credential), null);
		assertEquals(verifier.ownerScopes(owner, one.input.id), null);
		assertEquals(verifier.ownerCredentialDigest(owner, one.input.id), null);
		assertEquals(verifier.ownerCredentialDigest(owner, two.input.id), twoDigest);
		assertEquals(verifier.ownerCredentialDigest(owner), account);

		// A password change moves every binding of the account, its keys' included; disabling ends them, enabling
		// restores them (D-140's residual, unchanged).
		await users.setPassword('alice', 'another horse');
		assert(verifier.ownerCredentialDigest(owner, two.input.id) !== twoDigest);
		assert(verifier.ownerCredentialDigest(owner) !== account);
		await users.update('alice', { disabled: true });
		assertEquals(verifier.ownerScopes(owner, two.input.id), null);
		assertEquals(verifier.ownerCredentialDigest(owner, two.input.id), null);
		await users.update('alice', { disabled: false });
		assert(verifier.ownerCredentialDigest(owner, two.input.id) !== null);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-148: a sign-in opened with an account key changes its account’s password, given the current one', async () => {
	const dir = await scratch();
	const { record } = await generateAdminUser('root');
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
		TTK_DATA_DIR: dir,
	});
	const users = new UserStore({ dataDir: dir, seed: record });
	const logins = new LoginStore({ dataDir: dir });
	const verifier = new VerifierChain({ config, allowAnonymous: false, users, logins });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const lines: Array<Record<string, unknown>> = [];
	const logger = createLogger({ level: 'info', write: (line) => void lines.push(JSON.parse(line)) });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger });
	const call = async (path: string, token: string | null, body?: unknown) => {
		const response = await gateway.app.request(`${ORIGIN}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				host: '127.0.0.1:8787',
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		return { status: response.status, json: text === '' ? null : JSON.parse(text) };
	};
	const change = (token: string, current: string) =>
		call('/api/v1/auth/password', token, { current, next: 'brand new pass' });
	try {
		await users.create({ username: 'alice', password: 'correct horse', scopes: ['mcp:invoke'] });
		const key = await minted();
		await users.addKey('alice', key.input);
		const signIn = async (body: unknown) => (await call('/api/v1/auth/login', null, body)).json.token as string;
		const viaKey = await signIn({ apiKey: key.secret });
		assertEquals((await call('/api/v1/auth/me', viaKey)).json.session.backing, 'user-key');
		const passwordA = await signIn({ username: 'alice', password: 'correct horse' });
		const passwordB = await signIn({ username: 'alice', password: 'correct horse' });

		// A wrong current password is refused and logged, as for a password sign-in, and changes nothing.
		assertEquals((await change(viaKey, 'not it')).status, 401);
		assert(lines.some((line) => line.msg === 'auth.password_change_refused' && line.user === 'alice'));
		assertEquals((await call('/api/v1/auth/me', passwordA)).status, 200);
		// A raw bearer is no sign-in: the key presented directly is refused, as before — with the right password too.
		const raw = await change(key.secret, 'correct horse');
		assertEquals(raw.status, 400);
		assertStringIncludes(raw.json.detail, 'only a sign-in to an account');

		assertEquals((await change(viaKey, 'correct horse')).status, 204);
		// The account's password sign-ins end; the key's own sign-in, and the key, carry on.
		assertEquals((await call('/api/v1/auth/me', passwordA)).status, 401);
		assertEquals((await call('/api/v1/auth/me', passwordB)).status, 401);
		assertEquals((await call('/api/v1/auth/me', viaKey)).status, 200);
		assertEquals((await call('/api/v1/auth/me', key.secret)).status, 200);
		// The new password signs in; the old one does not.
		assertEquals(
			(await call('/api/v1/auth/login', null, { username: 'alice', password: 'correct horse' })).status,
			401,
		);
		assertEquals(
			(await call('/api/v1/auth/login', null, { username: 'alice', password: 'brand new pass' })).status,
			200,
		);
		// The audit line names the account, the actor and the key the change was made from — never a password.
		const audit = lines.find((line) => line.msg === 'user.password_changed');
		assertEquals([audit?.user, audit?.actor, audit?.key], ['alice', 'admin:alice', key.input.id]);
		const logged = JSON.stringify(lines);
		assert(!logged.includes('brand new pass') && !logged.includes('correct horse') && !logged.includes(key.secret));

		// A password sign-in's change is as before: no key on its audit line, and it keeps itself.
		const viaPassword = await signIn({ username: 'alice', password: 'brand new pass' });
		assertEquals(
			(await call('/api/v1/auth/password', viaPassword, { current: 'brand new pass', next: 'third pass!' }))
				.status,
			204,
		);
		assertEquals((await call('/api/v1/auth/me', viaPassword)).status, 200);
		assertEquals(lines.filter((line) => line.msg === 'user.password_changed').at(-1)?.key, undefined);
	} finally {
		await gateway.close();
		await registry.shutdown();
		await logins.flush();
		await Deno.remove(dir, { recursive: true });
	}
});
