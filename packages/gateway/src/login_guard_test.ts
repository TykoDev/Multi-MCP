/**
 * D-078: the sign-in route's guard, body cap, equal timing and audit trail.
 */
import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { SessionRegistry } from '@tykotech/mcp';
import { generateAdminUser } from './admin_auth.ts';
import { cappedJson, createGatewayApp, PUBLIC_BODY_BYTES } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { LoginGuard } from './login_guard.ts';
import { LoginStore } from './logins.ts';
import { UserStore } from './users.ts';

const ORIGIN = 'http://127.0.0.1:8787';

Deno.test('login guard: free failures, then doubling delays to a ceiling; success clears only the name', () => {
	let now = 0;
	const guard = new LoginGuard({
		now: () => now,
		source: { free: 3, baseMs: 1_000, maxMs: 8_000, windowMs: 60_000 },
		user: { free: 5, baseMs: 1_000, maxMs: 2_000, windowMs: 60_000 },
	});
	for (let i = 0; i < 3; i += 1) assertEquals(guard.fail('10.0.0.1', null), 0);
	assertEquals(guard.check('10.0.0.1', null), { allowed: true });
	assertEquals(guard.fail('10.0.0.1', null), 1);
	assertEquals(guard.check('10.0.0.1', null), { allowed: false, retryAfterS: 1 });
	assertEquals(guard.fail('10.0.0.1', null), 2);
	assertEquals(guard.fail('10.0.0.1', null), 4);
	assertEquals(guard.fail('10.0.0.1', null), 8);
	assertEquals(guard.fail('10.0.0.1', null), 8, 'capped at the source ceiling');
	// Another source is not affected.
	assertEquals(guard.check('10.0.0.2', null), { allowed: true });

	// Many sources against one name: the name's own counter, with its low ceiling.
	for (let i = 0; i < 5; i += 1) guard.fail(`192.0.2.${i}`, 'root');
	assertEquals(guard.check('192.0.2.99', 'root').allowed, true);
	guard.fail('192.0.2.98', 'root');
	assertEquals(guard.check('192.0.2.99', 'root'), { allowed: false, retryAfterS: 1 });
	for (let i = 0; i < 10; i += 1) guard.fail('192.0.2.97', 'ROOT');
	assertEquals(guard.check('192.0.2.99', 'root'), { allowed: false, retryAfterS: 2 }, 'names compare case-blind');
	// A success clears the name, never the source.
	guard.succeed('root');
	assertEquals(guard.check('192.0.2.99', 'root').allowed, true);
	assertEquals(guard.check('10.0.0.1', 'root').allowed, false);

	// Counters idle past their window are forgotten.
	now += 120_000;
	assertEquals(guard.check('10.0.0.1', null), { allowed: true });
	assertEquals(guard.sweep(), 0);
});

Deno.test('login guard: memory stays bounded under a flood of sources', () => {
	const guard = new LoginGuard({ maxEntries: 100 });
	for (let i = 0; i < 1_000; i += 1) guard.fail(`198.51.100.${i}`, null);
	assert(guard.sweep() <= 100);
});

Deno.test('cappedJson: counts the bytes that arrive, whatever the declared length says', async () => {
	const big = JSON.stringify({ username: 'x'.repeat(PUBLIC_BODY_BYTES) });
	assertEquals(await cappedJson(new Request(ORIGIN, { method: 'POST', body: big }), PUBLIC_BODY_BYTES), 'too-large');
	// A stream with no declared length is still cut at the cap.
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < 20; i += 1) controller.enqueue(new Uint8Array(1024).fill(32));
			controller.close();
		},
	});
	assertEquals(await cappedJson(new Request(ORIGIN, { method: 'POST', body: stream }), PUBLIC_BODY_BYTES), 'too-large');
	assertEquals(await cappedJson(new Request(ORIGIN, { method: 'POST', body: '{"a":1}' }), PUBLIC_BODY_BYTES), { a: 1 });
	assertEquals(await cappedJson(new Request(ORIGIN, { method: 'POST', body: '[1]' }), PUBLIC_BODY_BYTES), null);
	assertEquals(await cappedJson(new Request(ORIGIN, { method: 'POST', body: 'nope' }), PUBLIC_BODY_BYTES), null);
});

Deno.test('login route: throttled with Retry-After, capped, problem+json, equal timing, audited (D-078)', async () => {
	const dir = join('tests/.scratch', `guard-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const { record, password } = await generateAdminUser('root');
	const key = await generateApiKey('bot', ['mcp:invoke']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
		TTK_API_KEYS: JSON.stringify([key.record]),
		TTK_DATA_DIR: dir,
	});
	const lines: string[] = [];
	const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
	const users = new UserStore({ dataDir: dir, seed: record });
	const verifier = new VerifierChain({
		config,
		allowAnonymous: false,
		users,
		logins: new LoginStore({ dataDir: dir }),
	});
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger });
	const login = async (body: unknown, raw?: string) => {
		const response = await gateway.app.request(`${ORIGIN}/api/v1/auth/login`, {
			method: 'POST',
			headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' },
			body: raw ?? JSON.stringify(body),
		});
		const text = await response.text();
		return { response, json: text === '' ? null : JSON.parse(text) };
	};
	try {
		// A body over the cap is refused before it is parsed.
		const huge = await login(null, JSON.stringify({ username: 'root', password: 'x'.repeat(PUBLIC_BODY_BYTES) }));
		assertEquals(huge.response.status, 413);
		assertEquals(huge.response.headers.get('content-type'), 'application/problem+json');

		// Failures are problem+json 401s with a request id, the same for an unknown name and a wrong password.
		const unknown = await login({ username: 'ghost', password: 'wrong password' });
		const wrong = await login({ username: 'root', password: 'wrong password' });
		for (const { response, json } of [unknown, wrong]) {
			assertEquals(response.status, 401);
			assertEquals(response.headers.get('content-type'), 'application/problem+json');
			assertEquals(json.type, 'https://tykotech.eu/problems/unauthenticated');
			assert(typeof json['x-request-id'] === 'string');
		}
		assertEquals(unknown.json.detail, wrong.json.detail);

		// Equal timing: an unknown name now pays for the hash a real one does (it used to answer at once).
		const time = async (username: string) => {
			const started = performance.now();
			assertEquals(await users.verify(username, 'not the password'), null);
			return performance.now() - started;
		};
		await time('root');
		const real = [await time('root'), await time('root'), await time('root')].sort((a, b) => a - b)[1]!;
		const ghost = [await time('ghost'), await time('ghost'), await time('ghost')].sort((a, b) => a - b)[1]!;
		assert(ghost > real * 0.5 && ghost < real * 2, `unknown ${ghost.toFixed(1)} ms vs real ${real.toFixed(1)} ms`);

		// Three more failures spend the source's free five (the 413 counted for nothing); the sixth starts the
		// backoff, and the next attempt, even with the right password, is answered 429 without checking anything.
		await login({ username: 'root', password: 'wrong 1' });
		await login({ apiKey: 'ttk_wrong' });
		assertEquals((await login({ username: 'root', password: 'wrong 2' })).response.status, 401);
		const sixth = await login({ apiKey: 'ttk_wrong_again' });
		assertEquals(sixth.response.status, 401);
		const throttled = await login({ username: 'root', password });
		assertEquals(throttled.response.status, 429);
		assertEquals(throttled.json.type, 'https://tykotech.eu/problems/rate-limited');
		assert(Number(throttled.response.headers.get('retry-after')) >= 1);

		// The trail: failures name a real account but never an unknown name, never a password; the throttle is logged.
		const failed = lines.filter((line) => line.includes('auth.login_failed'));
		assertEquals(failed.length, 6);
		assert(failed.some((line) => line.includes('"user":"root"')));
		assert(failed.some((line) => line.includes('"user":"(unknown)"')));
		assert(!lines.some((line) => line.includes('ghost') || line.includes('wrong password')));
		assert(lines.some((line) => line.includes('auth.login_throttled')));
	} finally {
		await verifier.logins.flush();
		await gateway.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('account changes each leave one audit line naming actor and target (D-078)', async () => {
	const dir = join('tests/.scratch', `audit-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const { record, password } = await generateAdminUser('root');
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
		TTK_DATA_DIR: dir,
	});
	const lines: string[] = [];
	const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
	const users = new UserStore({ dataDir: dir, seed: record });
	const verifier = new VerifierChain({
		config,
		allowAnonymous: false,
		users,
		logins: new LoginStore({ dataDir: dir }),
	});
	const gateway = createGatewayApp({
		config,
		verifier,
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger,
	});
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
		const token: string = (await call('POST', '/api/v1/auth/login', null, { username: 'root', password })).json.token;
		assertEquals(
			(await call('POST', '/api/v1/users', token, { username: 'ops', password: 'correct horse' })).status,
			201,
		);
		assertEquals((await call('PATCH', '/api/v1/users/ops', token, { scopes: ['mcp:invoke'] })).status, 200);
		assertEquals((await call('POST', '/api/v1/users/ops/password', token, {})).status, 200);
		assertEquals((await call('DELETE', '/api/v1/users/ops', token)).status, 204);
		for (const event of ['user.created', 'user.updated', 'user.password_reset', 'user.deleted']) {
			const line = lines.find((l) => l.includes(`"${event}"`));
			assert(line !== undefined, `${event} was not logged`);
			assert(line.includes('"actor":"admin:root"') && line.includes('"user":"ops"'), line);
		}
		assert(!lines.some((line) => line.includes('correct horse')), 'a password reached the log');
		assert(lines.some((line) => line.includes('"auth.login"') && line.includes('"kind":"password"')));
	} finally {
		await verifier.logins.flush();
		await gateway.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});
