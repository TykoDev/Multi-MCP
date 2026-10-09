/**
 * D-073 / D-074: the account store, the sign-in store, and the routes over them.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { createGatewayApp } from './app.ts';
import { generateAdminUser } from './admin_auth.ts';
import { expansionOwner, generateApiKey, type Principal, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { LoginStore, MAX_LOGINS_PER_BACKING, sha256Hex } from './logins.ts';
import { SessionRegistry } from '@tykotech/mcp';
import { UserStore, UserStoreError } from './users.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const quiet = () => createLogger({ level: 'error' });

async function scratch(): Promise<string> {
	const dir = join('tests/.scratch', `users-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	return dir;
}

Deno.test('users: the secret seeds the store once, then the file is the authority (D-074)', async () => {
	const dir = await scratch();
	const { record } = await generateAdminUser('root');
	const first = new UserStore({ dataDir: dir, seed: record });
	assertEquals(first.status, 'seeded');
	assertEquals(first.list().map((u) => u.username), ['root']);
	await first.create({ username: 'ops', password: 'correct horse', scopes: ['mcp:invoke'] });

	// A second start with a *different* secret keeps the file's accounts and ignores the secret.
	const { record: other } = await generateAdminUser('intruder');
	const second = new UserStore({ dataDir: dir, seed: other });
	assertEquals(second.status, 'ok');
	assertEquals(second.list().map((u) => u.username).sort(), ['ops', 'root']);
	assertEquals(second.get('intruder'), null);

	// No data dir: the seed is served from memory and nothing can be changed.
	const memory = new UserStore({ dataDir: null, seed: record });
	assertEquals(memory.status, 'memory');
	assertEquals(memory.writable, false);
	await assertRejects(
		() => memory.create({ username: 'x', password: 'correct horse' }),
		UserStoreError,
		'TTK_DATA_DIR',
	);
	await Deno.remove(dir, { recursive: true });
});

Deno.test('users: a corrupt store loads empty and refuses writes, never wider', async () => {
	const dir = await scratch();
	await Deno.writeTextFile(join(dir, 'users.json'), '{"version":1,"users":[{"username":"x"}]}');
	const { record } = await generateAdminUser('root');
	const store = new UserStore({ dataDir: dir, seed: record, logger: quiet() });
	assertEquals(store.status, 'unreadable');
	assertEquals(store.size, 0);
	assertEquals(await store.verify('root', 'anything'), null);
	await assertRejects(() => store.create({ username: 'x', password: 'correct horse' }), UserStoreError, 'unreadable');
	await Deno.remove(dir, { recursive: true });
});

Deno.test('users: validation, the last-admin guard, disabling and password changes', async () => {
	const dir = await scratch();
	const { record, password } = await generateAdminUser('root');
	const store = new UserStore({ dataDir: dir, seed: record });

	await assertRejects(
		() => store.create({ username: 'bad\nname', password: 'correct horse' }),
		UserStoreError,
		'printable',
	);
	await assertRejects(() => store.create({ username: 'short', password: 'abc' }), UserStoreError, '8 to 256');
	await assertRejects(
		() => store.create({ username: 'scoped', password: 'correct horse', scopes: ['admin', 'nope'] }),
		UserStoreError,
		'"nope"',
	);
	await assertRejects(() => store.create({ username: 'root', password: 'correct horse' }), UserStoreError, 'exists');

	// Only one enabled admin: it cannot be disabled, de-scoped or removed.
	await assertRejects(() => store.update('root', { disabled: true }), UserStoreError, 'admin scope');
	await assertRejects(() => store.update('root', { scopes: ['mcp:invoke'] }), UserStoreError, 'admin scope');
	await assertRejects(() => store.remove('root'), UserStoreError, 'admin scope');

	// A second admin frees the first.
	await store.create({ username: 'second', password: 'correct horse', scopes: ['admin'] });
	assertEquals(store.enabledAdminCount(), 2);
	const disabled = await store.update('root', { disabled: true });
	assertEquals(disabled.disabled, true);
	assertEquals(await store.verify('root', password), null, 'a disabled account fails like an unknown one');
	assertEquals(store.scopesOf('root'), null);
	await store.update('root', { disabled: false });
	assert((await store.verify('root', password)) !== null);

	await store.setPassword('root', 'new password here');
	assertEquals(await store.verify('root', password), null);
	assert((await store.verify('root', 'new password here')) !== null);
	await assertRejects(() => store.setPassword('ghost', 'new password here'), UserStoreError, 'no user');

	await store.remove('second');
	assertEquals(store.list().map((u) => u.username), ['root']);
	// The public view never carries password material.
	const [view] = store.list();
	assertEquals('hash' in view!, false);
	assertEquals('salt' in view!, false);
	await Deno.remove(dir, { recursive: true });
});

Deno.test('D-140: credentialDigest moves with the password, is null for a disabled or removed account, and is never listed', async () => {
	const dir = await scratch();
	try {
		const { record } = await generateAdminUser('root');
		const store = new UserStore({ dataDir: dir, seed: record });
		await store.create({ username: 'alice', password: 'correct horse', scopes: ['mcp:invoke'] });
		const first = store.credentialDigest('alice');
		assert(first !== null);
		assertEquals(first.split('.').length, 3, 'salt.hash.iterations');
		assertEquals(store.credentialDigest('root'), `${record.salt}.${record.hash}.${record.iterations}`);
		// A scope change is not a credential change.
		await store.update('alice', { scopes: ['mcp:invoke', 'view:watch'] });
		assertEquals(store.credentialDigest('alice'), first);
		// A password change — even to the same password — writes a new salt and hash.
		await store.setPassword('alice', 'correct horse');
		const second = store.credentialDigest('alice');
		assert(second !== null && second !== first, 'a new salt, a new digest');
		await store.update('alice', { disabled: true });
		assertEquals(store.credentialDigest('alice'), null, 'disabled');
		await store.update('alice', { disabled: false });
		assertEquals(store.credentialDigest('alice'), second);
		await store.remove('alice');
		assertEquals(store.credentialDigest('alice'), null, 'removed');
		assertEquals(store.credentialDigest('ghost'), null, 'never existed');
		// Nothing a route renders carries it.
		const listed = JSON.stringify([store.list(), store.get('root')]);
		assert(!listed.includes(record.salt) && !listed.includes(record.hash));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-140: ownerCredentialDigest answers per realm, and null exactly where ownerScopes does', async () => {
	const { record: root } = await generateAdminUser('root');
	const key = await generateApiKey('bot', ['mcp:invoke']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([key.record]) }),
		allowAnonymous: false,
		users: new UserStore({ dataDir: null, seed: root }),
	});
	assertEquals(verifier.ownerCredentialDigest('api-key:bot'), key.record.sha256);
	assertEquals(verifier.ownerCredentialDigest('api-key:admin:root'), `${root.salt}.${root.hash}.${root.iterations}`);
	for (const gone of ['api-key:ghost', 'api-key:admin:ghost', 'oauth:subject', 'anonymous-loopback:local', 'user:x']) {
		assertEquals(verifier.ownerCredentialDigest(gone), null, gone);
		assertEquals(verifier.ownerScopes(gone), null, gone);
	}
	const oauth = new VerifierChain({
		config: loadConfig({ TTK_OAUTH_ISSUER: 'https://issuer.example.test' }),
		allowAnonymous: false,
	});
	assertEquals(oauth.ownerCredentialDigest('oauth:subject'), 'oauth');
	assertEquals(oauth.ownerCredentialDigest('oauth:'), null);
	const anonymous = new VerifierChain({ config: loadConfig({}), allowAnonymous: true });
	assertEquals(anonymous.ownerCredentialDigest('anonymous-loopback:local'), 'anonymous');
});

Deno.test('logins: a sign-in survives a restart, expires on time, and dies with its backing (D-073)', async () => {
	const dir = await scratch();
	const { record, password } = await generateAdminUser('root');
	const key = await generateApiKey('bot', ['mcp:invoke']);
	const config = loadConfig({
		TTK_ADMIN_USER: JSON.stringify(record),
		TTK_API_KEYS: JSON.stringify([key.record]),
		TTK_LOGIN_TTL_S: '120',
	});
	const users = new UserStore({ dataDir: dir, seed: record });
	const first = new VerifierChain({ config, allowAnonymous: false, users, logins: new LoginStore({ dataDir: dir }) });
	assertEquals(first.loginTtlMs, 120_000);

	const admin = await first.verifyAdmin('root', password);
	assert(admin);
	const session = await first.mintSession(admin);
	assert(session.token.startsWith('ttks_'));
	assert(session.expires - Date.now() > 110_000 && session.expires - Date.now() <= 120_000);
	const bot = await first.resolve(key.key);
	assert(bot);
	const botSession = await first.mintSession(bot);
	await first.logins.flush();

	// The file holds hashes only.
	const onDisk = await Deno.readTextFile(join(dir, 'logins.json'));
	assertEquals(onDisk.includes(session.token), false);
	assertEquals(onDisk.includes(botSession.token), false);

	// A new process resolves both.
	const second = new VerifierChain({
		config,
		allowAnonymous: false,
		users: new UserStore({ dataDir: dir, seed: null }),
		logins: new LoginStore({ dataDir: dir }),
	});
	const resumed = await second.resolve(session.token);
	assertEquals(resumed?.id, 'admin:root');
	assert(resumed?.scopes.has('admin'));
	const resumedBot = await second.resolve(botSession.token);
	assertEquals(resumedBot?.id, 'bot');
	assertEquals([...resumedBot!.scopes], ['mcp:invoke']);

	// Scope edits reach an open session on its next request; disabling ends it.
	await second.users.update('root', { scopes: ['admin', 'evaluate'] });
	assert((await second.resolve(session.token))?.scopes.has('evaluate'));
	await second.users.create({ username: 'other', password: 'correct horse', scopes: ['admin'] });
	await second.users.update('root', { disabled: true });
	assertEquals(await second.resolve(session.token), null);
	assertEquals(second.logins.countFor('user:root'), 0, 'the dead sign-in was dropped');

	// A rotated key ends the key-backed sign-in, and the task authority with it.
	const owner = expansionOwner(resumedBot!);
	assert(second.authorizeTask(owner, new Set(['mcp:invoke']), resumedBot!.credential));
	const rotated = await generateApiKey('bot', ['mcp:invoke']);
	assert(second.replaceApiKeys([rotated.record]));
	assertEquals(await second.resolve(botSession.token), null);
	assertEquals(second.authorizeTask(owner, new Set(['mcp:invoke']), resumedBot!.credential), null);

	// One backing holds at most MAX_LOGINS_PER_BACKING sign-ins; the oldest goes first.
	const capped = new LoginStore({ dataDir: null });
	const oldest = await capped.mint({ kind: 'api-key', id: 'admin:x', scopes: new Set(['admin']) }, 'user:x', 60_000);
	for (let i = 0; i < MAX_LOGINS_PER_BACKING; i += 1) {
		await capped.mint({ kind: 'api-key', id: 'admin:x', scopes: new Set(['admin']) }, 'user:x', 60_000);
	}
	assertEquals(capped.countFor('user:x'), MAX_LOGINS_PER_BACKING);
	assertEquals(capped.get(await sha256Hex(oldest.token)), null, 'the oldest sign-in was dropped');

	// An expired entry is dropped on load.
	const expired = new LoginStore({ dataDir: dir });
	const principal: Principal = { kind: 'api-key', id: 'admin:other', scopes: new Set(['admin']) };
	const brief = await expired.mint(principal, 'user:other', 1);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assertEquals(expired.get(brief.token), null);
	await expired.flush();
	await second.logins.flush();
	await Deno.remove(dir, { recursive: true });
});

Deno.test('users: the routes manage accounts and sign-ins with the guards the design names', async () => {
	const dir = await scratch();
	const { record, password } = await generateAdminUser('root');
	const watcher = await generateApiKey('watcher', ['view:watch']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
		TTK_API_KEYS: JSON.stringify([watcher.record]),
		TTK_DATA_DIR: dir,
	});
	const users = new UserStore({ dataDir: dir, seed: record });
	const logins = new LoginStore({ dataDir: dir });
	const verifier = new VerifierChain({ config, allowAnonymous: false, users, logins });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	const call = async (method: string, path: string, token: string | null, body?: unknown) => {
		const response = await gateway.app.request(`${ORIGIN}${path}`, {
			method,
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
	try {
		// Password login mints a session; an API key logs in to a session of its own, never echoed back (D2).
		const login = await call('POST', '/api/v1/auth/login', null, { username: 'root', password });
		assertEquals(login.status, 200);
		const root: string = login.json.token;
		assert(root.startsWith('ttks_'));
		assert(typeof login.json.expires === 'number');
		const keyLogin = await call('POST', '/api/v1/auth/login', null, { apiKey: watcher.key });
		assertEquals(keyLogin.status, 200);
		const watcherSession: string = keyLogin.json.token;
		assert(watcherSession.startsWith('ttks_'));
		assertEquals(JSON.stringify(keyLogin.json).includes(watcher.key), false);

		const me = await call('GET', '/api/v1/auth/me', root);
		assertEquals(me.json.user.username, 'root');
		assertEquals(me.json.session.backing, 'user');

		// A narrowed credential is refused.
		assertEquals((await call('GET', '/api/v1/users', watcherSession)).status, 403);
		assertEquals((await call('GET', '/api/v1/users', null)).status, 401);

		const list = await call('GET', '/api/v1/users', root);
		assertEquals(list.status, 200);
		assertEquals(list.json.users.length, 1);
		assertEquals(list.json.users[0].self, true);
		assertEquals(list.json.users[0].sessions, 1);
		assertEquals(list.json.store.writable, true);
		assertEquals(list.json.login_ttl_s, 604_800);

		// Create with a generated password, returned once; then with a chosen one.
		const created = await call('POST', '/api/v1/users', root, { username: 'ops', scopes: ['mcp:invoke', 'admin'] });
		assertEquals(created.status, 201);
		assert(typeof created.json.password === 'string' && created.json.password.length === 20);
		const chosen = await call('POST', '/api/v1/users', root, { username: 'viewer', password: 'correct horse' });
		assertEquals(chosen.status, 201);
		assertEquals(chosen.json.password, undefined);
		assertEquals(
			(await call('POST', '/api/v1/users', root, { username: 'ops', password: 'correct horse' })).status,
			409,
		);
		assertEquals((await call('POST', '/api/v1/users', root, { username: 'x', password: 'short' })).status, 400);
		assertEquals((await call('POST', '/api/v1/users', root, { username: 'x', scopes: ['nope'] })).status, 400);

		// The new account signs in with the generated password.
		const opsLogin = await call('POST', '/api/v1/auth/login', null, {
			username: 'ops',
			password: created.json.password,
		});
		assertEquals(opsLogin.status, 200);
		const ops: string = opsLogin.json.token;

		// Self-protection and the last-admin guard.
		assertEquals((await call('DELETE', '/api/v1/users/root', root)).status, 409);
		assertEquals((await call('PATCH', '/api/v1/users/root', root, { disabled: true })).status, 409);
		assertEquals((await call('PATCH', '/api/v1/users/root', root, { scopes: ['mcp:invoke'] })).status, 409);
		assertEquals((await call('PATCH', '/api/v1/users/ghost', root, { disabled: true })).status, 404);

		// An admin reset closes the account's sign-ins and the old password stops working.
		const reset = await call('POST', '/api/v1/users/ops/password', root, {});
		assertEquals(reset.status, 200);
		assert(typeof reset.json.password === 'string');
		assertEquals((await call('GET', '/api/v1/auth/me', ops)).status, 401);
		assertEquals(
			(await call('POST', '/api/v1/auth/login', null, { username: 'ops', password: created.json.password })).status,
			401,
		);
		const opsAgain =
			(await call('POST', '/api/v1/auth/login', null, { username: 'ops', password: reset.json.password }))
				.json.token as string;

		// Own password change: wrong current is refused; a right one keeps this session and ends the others.
		const opsSecond =
			(await call('POST', '/api/v1/auth/login', null, { username: 'ops', password: reset.json.password }))
				.json.token as string;
		assertEquals(
			(await call('POST', '/api/v1/auth/password', opsAgain, { current: 'wrong', next: 'brand new pass' })).status,
			401,
		);
		assertEquals(
			(await call('POST', '/api/v1/auth/password', opsAgain, { current: reset.json.password, next: 'brand new pass' }))
				.status,
			204,
		);
		assertEquals((await call('GET', '/api/v1/auth/me', opsAgain)).status, 200);
		assertEquals((await call('GET', '/api/v1/auth/me', opsSecond)).status, 401);
		// A key-backed session has no password to change.
		assertEquals(
			(await call('POST', '/api/v1/auth/password', watcherSession, { current: 'a', next: 'brand new pass' })).status,
			400,
		);

		// Sign out everywhere, disable, delete.
		const opsThird = (await call('POST', '/api/v1/auth/login', null, { username: 'ops', password: 'brand new pass' }))
			.json.token as string;
		assertEquals((await call('DELETE', '/api/v1/users/ops/sessions', root)).json.closed, 2);
		assertEquals((await call('GET', '/api/v1/auth/me', opsThird)).status, 401);
		assertEquals((await call('DELETE', '/api/v1/users/ghost/sessions', root)).status, 404);
		const viewerToken =
			(await call('POST', '/api/v1/auth/login', null, { username: 'viewer', password: 'correct horse' }))
				.json.token as string;
		assertEquals((await call('PATCH', '/api/v1/users/viewer', root, { disabled: true })).json.user.disabled, true);
		assertEquals((await call('GET', '/api/v1/auth/me', viewerToken)).status, 401);
		assertEquals((await call('DELETE', '/api/v1/users/viewer', root)).status, 204);
		assertEquals((await call('DELETE', '/api/v1/users/viewer', root)).status, 404);

		// Logout ends exactly the presented session.
		assertEquals((await call('POST', '/api/v1/auth/logout', root)).status, 204);
		assertEquals((await call('GET', '/api/v1/auth/me', root)).status, 401);

		// Diagnostics reports the stores.
		const admin2 = (await call('POST', '/api/v1/auth/login', null, { username: 'root', password })).json
			.token as string;
		const diag = await call('GET', '/api/v1/system/diagnostics', admin2);
		assertEquals(diag.json.config.userCount, 2);
		assertEquals(diag.json.config.userStore, 'ok');
		assertEquals(diag.json.config.loginTtlSeconds, 604_800);
	} finally {
		await gateway.close();
		await registry.shutdown();
		await logins.flush();
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('users: without a data directory the routes answer persistence-required (D-A3)', async () => {
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
		const auth = { ...headers, authorization: `Bearer ${token}` };
		const list = await gateway.app.request(`${ORIGIN}/api/v1/users`, {
			headers: { host: headers.host, authorization: auth.authorization },
		});
		assertEquals((await list.json()).store, { writable: false, status: 'memory' });
		const create = await gateway.app.request(`${ORIGIN}/api/v1/users`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ username: 'ops', password: 'correct horse' }),
		});
		assertEquals(create.status, 409);
		assertEquals((await create.json()).type, 'https://tykotech.eu/problems/persistence-required');
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});
