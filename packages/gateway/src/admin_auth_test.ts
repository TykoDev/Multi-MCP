import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { join } from '@std/path';
import { generateAdminUser, hashPassword, parseAdminUser, verifyPassword } from './admin_auth.ts';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { UserStore } from './users.ts';
import { SessionRegistry } from '@tykotech/mcp';
import { EventBus } from '@tykotech/bus';
import type { BrowserSession } from '@tykotech/browser';

Deno.test('admin_auth: password hashing and verification', async () => {
	const password = 'CorrectHorseBatteryStaple123!';
	const hashed = await hashPassword(password);
	assertEquals(typeof hashed.salt, 'string');
	assertEquals(typeof hashed.hash, 'string');
	assertEquals(hashed.hash.length, 64);
	assertEquals(hashed.iterations, 100_000);

	const valid = await verifyPassword(password, hashed);
	assertEquals(valid, true, 'correct password must verify');

	const wrong = await verifyPassword('WrongPassword', hashed);
	assertEquals(wrong, false, 'incorrect password must not verify');

	const tampered = await verifyPassword(password, { ...hashed, hash: '0'.repeat(64) });
	assertEquals(tampered, false, 'tampered hash must fail verification');
});

Deno.test('admin_auth: generate and parse admin user record', async () => {
	const { record, password } = await generateAdminUser('superadmin');
	assertEquals(record.username, 'superadmin');
	assert(password.length >= 16);
	assert(record.scopes?.includes('admin'));

	const serialized = JSON.stringify(record);
	const parsed = parseAdminUser(serialized);
	assertNotEquals(parsed, null);
	assertEquals(parsed?.username, 'superadmin');

	const valid = await verifyPassword(password, parsed!);
	assertEquals(valid, true);

	const invalid = parseAdminUser('not valid json');
	assertEquals(invalid, null);
});

Deno.test('admin_auth: verifier chain with admin user and sessions', async () => {
	const { record, password } = await generateAdminUser('admin');
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
	});

	const verifier = new VerifierChain({ config, allowAnonymous: false });
	assertEquals(verifier.credentialed, true);

	const principal = await verifier.verifyAdmin('admin', password);
	assertNotEquals(principal, null);
	assertEquals(principal?.id, 'admin:admin');
	assert(principal?.scopes.has('admin'));

	const wrong = await verifier.verifyAdmin('admin', 'wrong_pass');
	assertEquals(wrong, null);

	const wrongUser = await verifier.verifyAdmin('unknown', password);
	assertEquals(wrongUser, null);

	// Session minting and resolution
	const { token, expires } = await verifier.mintSession(principal!);
	assert(token.startsWith('ttks_'));
	assert(expires > Date.now());

	const resolved = await verifier.resolve(token);
	assertEquals(resolved?.id, principal?.id);
	assertEquals(verifier.stillAuthorized(resolved!), true);

	// Logout / session close
	assertEquals(await verifier.closeSession(token), true);
	const afterClose = await verifier.resolve(token);
	assertEquals(afterClose, null);
});

Deno.test('admin_auth: gateway auth and diagnostics endpoints', async () => {
	const { record, password } = await generateAdminUser('admin');
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
	});
	const logger = createLogger({ level: 'error' });
	const registry = new SessionRegistry({
		maxSessions: 4,
		sessionTtlMs: 60_000,
		browserPath: null,
		dataDir: 'tests/.scratch',
		browserArgs: [],
		headless: true,
		allowedDomains: [],
		logger,
		launch: () =>
			Promise.resolve({
				eventBus: new EventBus(),
				tabs: [],
				cachedBrowserState: null,
				agentFocusTargetId: null,
				cdpClient: { on: () => () => {}, off: () => {} },
				sessionManager: null,
				stop: () => Promise.resolve(),
				kill: () => Promise.resolve(),
			} as unknown as BrowserSession),
	});
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const gateway = createGatewayApp({
		config,
		registry,
		verifier,
		logger,
		version: '0.2.0',
	});

	try {
		const reqHeaders = { Host: '127.0.0.1', 'Content-Type': 'application/json' };

		// 1. Login with bad credentials -> 401
		const badLogin = await gateway.app.request('http://127.0.0.1:8787/api/v1/auth/login', {
			method: 'POST',
			headers: reqHeaders,
			body: JSON.stringify({ username: 'admin', password: 'incorrect' }),
		});
		assertEquals(badLogin.status, 401);

		// 2. Login with valid admin credentials -> 200 + token
		const loginRes = await gateway.app.request('http://127.0.0.1:8787/api/v1/auth/login', {
			method: 'POST',
			headers: reqHeaders,
			body: JSON.stringify({ username: 'admin', password }),
		});
		assertEquals(loginRes.status, 200);
		const loginBody = await loginRes.json() as { token: string; user: { username: string; scopes: string[] } };
		assert(loginBody.token.startsWith('ttks_'));
		assertEquals(loginBody.user.username, 'admin');

		// 3. /api/v1/auth/me using token
		const meRes = await gateway.app.request('http://127.0.0.1:8787/api/v1/auth/me', {
			headers: { Host: '127.0.0.1', 'Authorization': `Bearer ${loginBody.token}` },
		});
		assertEquals(meRes.status, 200);
		const meBody = await meRes.json() as { user: { id: string } };
		assertEquals(meBody.user.id, 'admin:admin');

		// 4. /api/v1/system/diagnostics
		const diagRes = await gateway.app.request('http://127.0.0.1:8787/api/v1/system/diagnostics', {
			headers: { Host: '127.0.0.1', 'Authorization': `Bearer ${loginBody.token}` },
		});
		assertEquals(diagRes.status, 200);
		const diagBody = await diagRes.json() as { status: string; config: { hasAdminUser: boolean } };
		assertEquals(diagBody.status, 'ok');
		assertEquals(diagBody.config.hasAdminUser, true);

		// 5. /api/v1/sessions POST
		const createSessionRes = await gateway.app.request('http://127.0.0.1:8787/api/v1/sessions', {
			method: 'POST',
			headers: {
				Host: '127.0.0.1',
				'Authorization': `Bearer ${loginBody.token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ label: 'test-session' }),
		});
		assertEquals(createSessionRes.status, 201);
		const sessionBody = await createSessionRes.json() as { session_id: string };
		assert(sessionBody.session_id.length > 0);

		// 6. /api/v1/auth/logout
		const logoutRes = await gateway.app.request('http://127.0.0.1:8787/api/v1/auth/logout', {
			method: 'POST',
			headers: { Host: '127.0.0.1', 'Authorization': `Bearer ${loginBody.token}` },
		});
		assertEquals(logoutRes.status, 204);

		// 7. Verify token no longer works
		const afterLogout = await gateway.app.request('http://127.0.0.1:8787/api/v1/auth/me', {
			headers: { Host: '127.0.0.1', 'Authorization': `Bearer ${loginBody.token}` },
		});
		assertEquals(afterLogout.status, 401);
	} finally {
		await gateway.close();
		await registry.shutdown('server-shutdown');
	}
});

Deno.test('AC31 / RV-14: hasAdminUser counts enabled accounts holding admin, not accounts', async () => {
	const dir = join('tests/.scratch', `rv14-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	// The diagnostics reader is an admin API key, so the answer is about the accounts alone.
	const reader = await generateApiKey('reader', ['mcp:invoke', 'admin']);
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_API_KEYS: JSON.stringify([reader.record]) });
	const logger = createLogger({ level: 'error' });
	const hasAdminUser = async (users: UserStore): Promise<{ hasAdminUser: boolean; userCount: number }> => {
		const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('unused')) });
		const gateway = createGatewayApp({
			config,
			registry,
			verifier: new VerifierChain({ config, allowAnonymous: false, users }),
			logger,
			version: 'test',
		});
		try {
			const response = await gateway.app.request('http://127.0.0.1:8787/api/v1/system/diagnostics', {
				headers: { Host: '127.0.0.1', Authorization: `Bearer ${reader.key}` },
			});
			assertEquals(response.status, 200);
			const { config: reported } = await response.json() as {
				config: { hasAdminUser: boolean; userCount: number };
			};
			return { hasAdminUser: reported.hasAdminUser, userCount: reported.userCount };
		} finally {
			await gateway.close();
			await registry.shutdown('server-shutdown');
		}
	};
	try {
		const { record: admin } = await generateAdminUser('root');
		// An account that holds no admin scope is an account, not an administrator.
		const viewer = { ...admin, username: 'viewer', scopes: ['mcp:invoke' as const] };
		assertEquals(await hasAdminUser(new UserStore({ dataDir: null, seed: viewer })), {
			hasAdminUser: false,
			userCount: 1,
		});
		// A disabled administrator administers nothing (the store refuses to disable the last one, so the file says so).
		const now = new Date().toISOString();
		await Deno.writeTextFile(
			join(dir, 'users.json'),
			JSON.stringify({ version: 2, users: [{ ...admin, disabled: true, created_at: now, updated_at: now }] }),
		);
		assertEquals(await hasAdminUser(new UserStore({ dataDir: dir, seed: null })), {
			hasAdminUser: false,
			userCount: 1,
		});
		// An enabled administrator is one; no accounts at all is none.
		assertEquals((await hasAdminUser(new UserStore({ dataDir: null, seed: admin }))).hasAdminUser, true);
		assertEquals(await hasAdminUser(new UserStore({ dataDir: null, seed: null })), {
			hasAdminUser: false,
			userCount: 0,
		});
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
