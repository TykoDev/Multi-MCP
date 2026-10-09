/**
 * B4 / D-097: the control plane's sign-in cookie, its CSRF proof, and the rules around both (AC3).
 *
 * Every rule of design §2.3 is exercised through the real middleware stack (`createGatewayApp().app`, the outer
 * front included): a cookie sign-in needs an allowed Origin and returns no token; the cookie authenticates reads; a
 * cookie-authenticated change without the CSRF header, with a wrong one or without an allowed Origin is refused
 * `403 csrf-failed`; the Authorization header wins and bearer clients carry no CSRF obligation; only `ttks_` values
 * are read from the cookie; the live-view socket never accepts it; logout clears it.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import { encodeBase64Url } from '@std/encoding/base64url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SessionRegistry } from '@tykotech/mcp';
import { generateAdminUser } from './admin_auth.ts';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { Cluster } from './cluster.ts';
import { type Config, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { LoginStore, sha256Hex } from './logins.ts';
import {
	clearedSessionCookie,
	clearedSessionCookies,
	cookieOriginAllowed,
	csrfFor,
	csrfMatches,
	parseSessionCookie,
	readSessionCookie,
	SECURE_SESSION_COOKIE,
	SESSION_COOKIE,
	sessionCookie,
	sessionCookieSpec,
} from './session_cookie.ts';
import { UserStore } from './users.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const HOST = '127.0.0.1:8787';

Deno.test('session cookie: the CSRF value is SHA-256 over the label and the raw token, never the stored hash', async () => {
	const token = `ttks_${'ab'.repeat(32)}`;
	const label = new TextEncoder().encode('ttk-csrf-v1\0');
	const raw = new TextEncoder().encode(token);
	const input = new Uint8Array([...label, ...raw]);
	const expected = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
	assertEquals(await csrfFor(token), expected);
	assertEquals((await csrfFor(token)).length, 43, 'unpadded base64url of 32 bytes');
	assertEquals(await csrfFor(token), await csrfFor(token), 'stateless: the same on every node and every restart');
	// A copy of logins.json (or the cluster KV) holds sha256(token); the CSRF value must not follow from it.
	const stored = await sha256Hex(token);
	assert((await csrfFor(stored)) !== expected);
	assert(!expected.includes(stored.slice(0, 16)));

	assert(csrfMatches(expected, expected));
	assert(!csrfMatches(undefined, expected));
	assert(!csrfMatches('', expected));
	const tampered = `${expected.slice(0, -1)}${expected.endsWith('A') ? 'B' : 'A'}`;
	assert(!csrfMatches(tampered, expected));
});

Deno.test('session cookie: name and attributes follow the public URL; only ttks_ values are read', () => {
	const http = sessionCookieSpec(new URL('http://127.0.0.1:8787'));
	assertEquals(http, { name: SESSION_COOKIE, secure: false });
	const set = sessionCookie(http, 'ttks_abc', 120.7);
	assertEquals(set, 'ttk_session=ttks_abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=120');
	assertEquals(clearedSessionCookie(http), 'ttk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');

	const https = sessionCookieSpec(new URL('https://mcp.example.com'));
	assertEquals(https, { name: SECURE_SESSION_COOKIE, secure: true });
	assertEquals(
		sessionCookie(https, 'ttks_abc', 5),
		'__Host-ttk_session=ttks_abc; HttpOnly; SameSite=Strict; Path=/; Secure; Max-Age=5',
	);

	assertEquals(readSessionCookie('a=1; ttk_session=ttks_00ff; b=2', 'ttk_session'), 'ttks_00ff');
	assertEquals(readSessionCookie('ttk_session=ttk_rawapikey', 'ttk_session'), null, 'an API key is never read');
	assertEquals(readSessionCookie('ttk_session=ttkd_delegated', 'ttk_session'), null, 'nor a delegation');
	assertEquals(readSessionCookie('ttk_session=eyJhbGciOi.x.y', 'ttk_session'), null, 'nor a JWT');
	assertEquals(readSessionCookie('ttk_session=ttks_a;b', 'ttk_session'), 'ttks_a');
	assertEquals(readSessionCookie('ttk_session=ttks_ok', SECURE_SESSION_COOKIE), null, 'only the configured name');
	assertEquals(readSessionCookie(undefined, 'ttk_session'), null);
});

Deno.test('R1-2: the cookie jar is judged whole; the origin is compared whole; clearing covers every path', () => {
	const name = SESSION_COOKIE;
	const token = `ttks_${'ab'.repeat(32)}`;
	assertEquals(parseSessionCookie(undefined, name), { kind: 'absent' });
	assertEquals(parseSessionCookie('theme=dark; ttk_sessionx=1', name), { kind: 'absent' });
	assertEquals(parseSessionCookie(`a=1; ${name}=${token}`, name), { kind: 'token', token });
	assertEquals(parseSessionCookie(`${name}=ttks_aa; ${name}=${token}`, name), { kind: 'refused', reason: 'duplicate' });
	assertEquals(parseSessionCookie(`${name}=${token}; ${name}=${token}`, name), {
		kind: 'refused',
		reason: 'duplicate',
	});
	for (const value of ['garbage', '', 'ttk_rawkey', 'ttkd_x', '"ttks_aa"', 'ttks_a b']) {
		assertEquals(parseSessionCookie(`${name}=${value}`, name), { kind: 'refused', reason: 'malformed' }, value);
	}
	assertEquals(readSessionCookie(`${name}=ttks_aa; ${name}=${token}`, name), null, 'never first-wins');

	const http = new URL('http://127.0.0.1:8787');
	assert(cookieOriginAllowed('http://127.0.0.1:8787', http, '127.0.0.1:8787'));
	assert(cookieOriginAllowed('http://127.0.0.1:8787', http, 'proxy.internal:9000'), 'the public origin, whatever Host');
	assert(cookieOriginAllowed('http://localhost:8787', http, 'localhost:8787'), 'the address the browser fetched');
	assert(cookieOriginAllowed('http://[::1]:8787', http, '[::1]:8787'));
	for (
		const [origin, host] of [
			['http://127.0.0.1:3000', '127.0.0.1:8787'],
			['https://127.0.0.1:8787', '127.0.0.1:8787'],
			['http://localhost:3000', 'localhost:8787'],
			['http://127.0.0.1:8787/', '127.0.0.1:8787'],
			['HTTP://127.0.0.1:8787', 'x'],
			['null', '127.0.0.1:8787'],
			['', '127.0.0.1:8787'],
			[undefined, '127.0.0.1:8787'],
			['http://localhost:8787', undefined],
		] as const
	) {
		assert(!cookieOriginAllowed(origin, http, host), `${origin} via ${host}`);
	}
	const https = new URL('https://mcp.example.com');
	assert(cookieOriginAllowed('https://mcp.example.com', https, 'backend:8787'));
	assert(!cookieOriginAllowed('http://mcp.example.com', https, 'mcp.example.com'), "the scheme is the public URL's");

	assertEquals(
		clearedSessionCookies(sessionCookieSpec(http), '/api/v1/auth/me').map((line) => /Path=([^;]*)/.exec(line)?.[1]),
		[
			'/',
			'/api',
			'/api/',
			'/api/v1',
			'/api/v1/',
			'/api/v1/auth',
			'/api/v1/auth/',
			'/api/v1/auth/me',
			'/api/v1/auth/me/',
		],
	);
	assertEquals(
		clearedSessionCookies(sessionCookieSpec(http), '/a/b;c/d').length,
		3,
		'a segment that is not plain text ends the list',
	);
	assertEquals(
		clearedSessionCookies(sessionCookieSpec(http), '/$&/x')[1],
		'ttk_session=; HttpOnly; SameSite=Strict; Path=/$&; Max-Age=0',
	);
	assertEquals(clearedSessionCookies(sessionCookieSpec(https), '/api/v1/auth/me'), [
		'__Host-ttk_session=; HttpOnly; SameSite=Strict; Path=/; Secure; Max-Age=0',
	]);
});

interface Fixture {
	readonly config: Config;
	readonly gateway: ReturnType<typeof createGatewayApp>;
	readonly registry: SessionRegistry;
	readonly password: string;
	readonly key: string;
	readonly logins: LoginStore;
	readonly users: UserStore;
	readonly verifier: VerifierChain;
	request(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: unknown },
	): Promise<Response>;
	close(): Promise<void>;
}

async function fixture(env: Record<string, string> = {}): Promise<Fixture> {
	const { record, password } = await generateAdminUser('root');
	const key = await generateApiKey('ops', ['mcp:invoke', 'view:watch', 'view:control', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_ADMIN_USER: JSON.stringify(record),
		TTK_API_KEYS: JSON.stringify([key.record]),
		...env,
	});
	const users = new UserStore({ dataDir: null, seed: config.adminUser });
	const logins = new LoginStore({ dataDir: null });
	const verifier = new VerifierChain({ config, allowAnonymous: false, users, logins });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier,
		registry,
		version: 'test',
		logger: createLogger({ level: 'error' }),
	});
	return {
		config,
		gateway,
		registry,
		password,
		key: key.key,
		logins,
		users,
		verifier,
		request: async (path, init = {}) =>
			await gateway.app.request(`${ORIGIN}${path}`, {
				method: init.method ?? 'GET',
				headers: {
					host: HOST,
					...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
					...init.headers,
				},
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			}),
		close: async () => {
			await gateway.close();
			await registry.shutdown();
		},
	};
}

/** Signs in with the cookie and returns the cookie pair (`name=value`) and the CSRF value. */
async function cookieSignIn(
	f: Fixture,
	credentials: Record<string, unknown>,
): Promise<{ cookie: string; csrf: string }> {
	const response = await f.request('/api/v1/auth/login', {
		method: 'POST',
		headers: { origin: ORIGIN },
		body: { ...credentials, session: 'cookie' },
	});
	assertEquals(response.status, 200, await response.clone().text());
	const setCookie = response.headers.get('set-cookie') ?? '';
	const body = await response.json() as Record<string, unknown>;
	return { cookie: setCookie.split(';')[0]!, csrf: body.csrf as string };
}

Deno.test('session cookie: a cookie sign-in sets the cookie, returns the CSRF value and no token', async () => {
	const f = await fixture();
	try {
		const response = await f.request('/api/v1/auth/login', {
			method: 'POST',
			headers: { origin: ORIGIN },
			body: { username: 'root', password: f.password, session: 'cookie' },
		});
		assertEquals(response.status, 200);
		const setCookie = response.headers.get('set-cookie') ?? '';
		assertMatch(setCookie, /^ttk_session=ttks_[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
		const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
		assert(maxAge > 604_700 && maxAge <= 604_800, `Max-Age is the remaining TTL, got ${maxAge}`);
		assertEquals(response.headers.get('cache-control'), 'no-store');
		const text = await response.text();
		assertEquals(text.includes('ttks_'), false, 'no token in the body');
		const body = JSON.parse(text) as { expires: number; csrf: string; user: { username: string }; token?: string };
		assertEquals(body.token, undefined);
		assertEquals(body.user.username, 'root');
		assert(body.expires > Date.now());
		const token = setCookie.split(';')[0]!.slice('ttk_session='.length);
		assertEquals(body.csrf, await csrfFor(token));

		// An API key signs in to a cookie too, and the key never comes back.
		const keyed = await f.request('/api/v1/auth/login', {
			method: 'POST',
			headers: { origin: ORIGIN },
			body: { apiKey: f.key, session: 'cookie' },
		});
		assertEquals(keyed.status, 200);
		const keyedText = await keyed.text();
		assertEquals(keyedText.includes(f.key), false);
		assertEquals(keyedText.includes('ttks_'), false);
		assertStringIncludes(keyed.headers.get('set-cookie') ?? '', 'ttk_session=ttks_');

		// Without the option, the bearer sign-in is exactly as before: a token in the body, no cookie.
		const bearer = await f.request('/api/v1/auth/login', {
			method: 'POST',
			body: { username: 'root', password: f.password },
		});
		assertEquals(bearer.status, 200);
		assertEquals(bearer.headers.get('set-cookie'), null);
		assert(((await bearer.json()) as { token: string }).token.startsWith('ttks_'));

		// An unknown session mode is refused rather than ignored.
		const odd = await f.request('/api/v1/auth/login', {
			method: 'POST',
			headers: { origin: ORIGIN },
			body: { username: 'root', password: f.password, session: 'bearer' },
		});
		assertEquals(odd.status, 400);
		await odd.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: a cookie sign-in needs an allowed Origin, checked before the credential (M6)', async () => {
	const f = await fixture();
	try {
		const missing = await f.request('/api/v1/auth/login', {
			method: 'POST',
			body: { username: 'root', password: f.password, session: 'cookie' },
		});
		assertEquals(missing.status, 403);
		assertEquals((await missing.json()).type, 'https://tykotech.eu/problems/origin-forbidden');
		assertEquals(missing.headers.get('set-cookie'), null);

		// A foreign page is refused whatever the credential — and a wrong password says nothing more.
		for (const password of [f.password, 'wrong password']) {
			const foreign = await f.request('/api/v1/auth/login', {
				method: 'POST',
				headers: { origin: 'https://evil.example' },
				body: { username: 'root', password, session: 'cookie' },
			});
			assertEquals(foreign.status, 403);
			assertEquals((await foreign.json()).type, 'https://tykotech.eu/problems/origin-forbidden');
		}
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: the cookie authenticates reads; changes need the CSRF header and an allowed Origin', async () => {
	const f = await fixture();
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });

		// Reads: no CSRF needed, and `me` hands a reloaded page its CSRF value back.
		const me = await f.request('/api/v1/auth/me', { headers: { cookie } });
		assertEquals(me.status, 200);
		const meBody = await me.json() as { user: { id: string }; csrf?: string };
		assertEquals(meBody.user.id, 'admin:root');
		assertEquals(meBody.csrf, csrf);
		assertEquals((await f.request('/api/v1/sessions', { headers: { cookie } })).status, 200);

		const change = (headers: Record<string, string>) =>
			f.request('/api/v1/live/ticket', { method: 'POST', headers: { cookie, ...headers }, body: {} });
		const expectCsrfFailed = async (response: Response, why: string) => {
			assertEquals(response.status, 403, why);
			const problem = await response.json() as { type: string; title: string };
			assertEquals(problem.type, 'https://tykotech.eu/problems/csrf-failed', why);
			assertEquals(problem.title, 'CSRF check failed');
		};
		await expectCsrfFailed(await change({ origin: ORIGIN }), 'no CSRF header');
		await expectCsrfFailed(await change({ origin: ORIGIN, 'x-ttk-csrf': 'not-the-value' }), 'a wrong CSRF header');
		await expectCsrfFailed(await change({ 'x-ttk-csrf': csrf }), 'no Origin header');
		// A foreign origin never reaches the CSRF check: the front refuses it first.
		const foreign = await change({ origin: 'https://evil.example', 'x-ttk-csrf': csrf });
		assertEquals(foreign.status, 403);
		assertEquals((await foreign.json()).type, 'https://tykotech.eu/problems/origin-forbidden');

		// The ticket mint, a session, and every other unsafe method, with both proofs.
		const minted = await change({ origin: ORIGIN, 'x-ttk-csrf': csrf });
		assertEquals(minted.status, 201);
		await minted.body?.cancel();
		// The check stands in front of the handler: a refused change never reaches it (no browser is launched here).
		await expectCsrfFailed(
			await f.request('/api/v1/sessions', { method: 'POST', headers: { cookie, origin: ORIGIN }, body: {} }),
			'POST without CSRF',
		);
		await expectCsrfFailed(
			await f.request('/api/v1/sessions/nope', { method: 'DELETE', headers: { cookie, origin: ORIGIN } }),
			'DELETE without CSRF',
		);
		await expectCsrfFailed(
			await f.request('/api/v1/live/origins', {
				method: 'PUT',
				headers: { cookie, origin: ORIGIN },
				body: { origins: [] },
			}),
			'PUT without CSRF',
		);
		await expectCsrfFailed(
			await f.request('/api/v1/users/root', { method: 'PATCH', headers: { cookie, origin: ORIGIN }, body: {} }),
			'PATCH without CSRF',
		);
		// With both proofs the handler answers on its own terms.
		const unknown = await f.request('/api/v1/sessions/nope', {
			method: 'DELETE',
			headers: { cookie, origin: ORIGIN, 'x-ttk-csrf': csrf },
		});
		assertEquals(unknown.status, 404);
		await unknown.body?.cancel();
		const patched = await f.request('/api/v1/users/root', {
			method: 'PATCH',
			headers: { cookie, origin: ORIGIN, 'x-ttk-csrf': csrf },
			body: {},
		});
		assertEquals(patched.status, 409, 'past the CSRF check, the memory store refuses the write itself');
		await patched.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: /mcp accepts the cookie for the SPA under the same CSRF rule', async () => {
	const f = await fixture();
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });
		const rpc = (headers: Record<string, string>) =>
			f.request('/mcp', {
				method: 'POST',
				headers: { cookie, accept: 'application/json, text/event-stream', ...headers },
				body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
			});
		const refused = await rpc({ origin: ORIGIN });
		assertEquals(refused.status, 403);
		assertEquals((await refused.json()).type, 'https://tykotech.eu/problems/csrf-failed');
		const listed = await rpc({ origin: ORIGIN, 'x-ttk-csrf': csrf });
		assertEquals(listed.status, 200);
		assertStringIncludes(await listed.text(), 'browser_navigate');
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: bearer clients are unaffected, and the Authorization header wins', async () => {
	const f = await fixture();
	try {
		const { cookie } = await cookieSignIn(f, { username: 'root', password: f.password });
		// A bearer change needs no CSRF header and no Origin: a browser never attaches one on its own.
		const bearer = await f.request('/api/v1/live/ticket', {
			method: 'POST',
			headers: { authorization: `Bearer ${f.key}` },
			body: {},
		});
		assertEquals(bearer.status, 201);
		const meBearer = await f.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${f.key}` } });
		assertEquals(
			((await meBearer.json()) as { csrf?: string }).csrf,
			undefined,
			'only a cookie request gets a CSRF value',
		);

		// With both, the header decides: a bad bearer is refused even beside a good cookie.
		const both = await f.request('/api/v1/auth/me', { headers: { cookie, authorization: 'Bearer ttk_nope' } });
		assertEquals(both.status, 401);
		await both.body?.cancel();
		// A bearer change beside a cookie carries no CSRF obligation either.
		const bearerBeside = await f.request('/api/v1/live/ticket', {
			method: 'POST',
			headers: { cookie, authorization: `Bearer ${f.key}` },
			body: {},
		});
		assertEquals(bearerBeside.status, 201);
		await bearerBeside.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: only a ttks_ value is read from the cookie; an API key there is refused', async () => {
	const f = await fixture();
	try {
		const planted = await f.request('/api/v1/auth/me', { headers: { cookie: `ttk_session=${f.key}` } });
		assertEquals(planted.status, 401, 'a raw API key in the cookie authenticates nothing');
		// R1-2: and, being a value this server never sets, it is cleared rather than left to refuse every request.
		assertStringIncludes(planted.headers.get('set-cookie') ?? '', 'ttk_session=; ');
		await planted.body?.cancel();
		const forged = await f.request('/api/v1/auth/me', { headers: { cookie: `ttk_session=ttks_${'0'.repeat(64)}` } });
		assertEquals(forged.status, 401);
		// A dead cookie is cleared along with the refusal.
		assertStringIncludes(forged.headers.get('set-cookie') ?? '', 'ttk_session=; ');
		assertStringIncludes(forged.headers.get('set-cookie') ?? '', 'Max-Age=0');
		await forged.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: the live-view socket never accepts the cookie (M6)', async () => {
	const f = await fixture();
	try {
		const { cookie } = await cookieSignIn(f, { username: 'root', password: f.password });
		const upgrade = await f.request('/live/default/ws', {
			headers: { cookie, origin: ORIGIN, upgrade: 'websocket', connection: 'Upgrade' },
		});
		assertEquals(upgrade.status, 403);
		assertEquals((await upgrade.json()).type, 'https://tykotech.eu/problems/ticket-invalid');
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: logout ends the session and clears the cookie', async () => {
	const f = await fixture();
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });
		const unproven = await f.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin: ORIGIN } });
		assertEquals(unproven.status, 403, 'a forged logout is a change too');
		await unproven.body?.cancel();

		const out = await f.request('/api/v1/auth/logout', {
			method: 'POST',
			headers: { cookie, origin: ORIGIN, 'x-ttk-csrf': csrf },
		});
		assertEquals(out.status, 204);
		assertEquals(out.headers.get('set-cookie'), 'ttk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
		assertEquals(f.logins.size, 0, 'the session is gone server-side, not only in the browser');
		const after = await f.request('/api/v1/auth/me', { headers: { cookie } });
		assertEquals(after.status, 401);
		await after.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: an https deployment uses the __Host- cookie with Secure, and ignores the plain name', async () => {
	const f = await fixture({ TTK_PUBLIC_URL: 'https://127.0.0.1:8787' });
	try {
		const response = await f.request('/api/v1/auth/login', {
			method: 'POST',
			headers: { origin: 'https://127.0.0.1:8787' },
			body: { username: 'root', password: f.password, session: 'cookie' },
		});
		assertEquals(response.status, 200);
		const setCookie = response.headers.get('set-cookie') ?? '';
		assertMatch(
			setCookie,
			/^__Host-ttk_session=ttks_[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Secure; Max-Age=\d+$/,
		);
		await response.body?.cancel();
		const value = setCookie.split(';')[0]!.slice(`${SECURE_SESSION_COOKIE}=`.length);
		assertEquals(
			(await f.request('/api/v1/auth/me', { headers: { cookie: `__Host-ttk_session=${value}` } })).status,
			200,
		);
		const plain = await f.request('/api/v1/auth/me', { headers: { cookie: `ttk_session=${value}` } });
		assertEquals(plain.status, 401, 'a cookie a sibling host could have set is not read on https');
		await plain.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: a second node with the same sign-in store derives the same CSRF value (F3)', async () => {
	const f = await fixture();
	const other = createGatewayApp({
		config: f.config,
		verifier: new VerifierChain({ config: f.config, allowAnonymous: false, users: f.users, logins: f.logins }),
		registry: f.registry,
		version: 'test',
		logger: createLogger({ level: 'error' }),
	});
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });
		const me = await other.app.request(`${ORIGIN}/api/v1/auth/me`, { headers: { host: HOST, cookie } });
		assertEquals(((await me.json()) as { csrf: string }).csrf, csrf);
		const minted = await other.app.request(`${ORIGIN}/api/v1/live/ticket`, {
			method: 'POST',
			headers: { host: HOST, cookie, origin: ORIGIN, 'x-ttk-csrf': csrf, 'content-type': 'application/json' },
			body: '{}',
		});
		assertEquals(minted.status, 201);
		await minted.body?.cancel();
	} finally {
		await other.close();
		await f.close();
	}
});

Deno.test('login: a ttks_ session token offered as an apiKey is refused, not exchanged (C14)', async () => {
	const f = await fixture();
	try {
		const bearer = await f.request('/api/v1/auth/login', {
			method: 'POST',
			body: { username: 'root', password: f.password },
		});
		const { token } = await bearer.json() as { token: string };
		for (const field of ['apiKey', 'token']) {
			const response = await f.request('/api/v1/auth/login', { method: 'POST', body: { [field]: token } });
			assertEquals(response.status, 400);
			const problem = await response.json() as { type: string; detail: string };
			assertEquals(problem.type, 'https://tykotech.eu/problems/invalid-request');
			assertEquals(problem.detail, 'use the session token as a bearer token');
		}
		assertEquals(f.logins.size, 1, 'no session was minted from a session');
	} finally {
		await f.close();
	}
});

Deno.test('session cookie: an OAuth access token cannot open a cookie session; it stays a bearer', async () => {
	const { publicKey, privateKey } = await generateKeyPair('RS256');
	const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		() => Response.json({ keys: [jwk] }),
	);
	const issuer = `http://127.0.0.1:${server.addr.port}/realms/x`;
	const f = await fixture({
		TTK_OAUTH_ISSUER: issuer,
		TTK_OAUTH_JWKS_URL: `http://127.0.0.1:${server.addr.port}/certs`,
		TTK_OAUTH_AUDIENCE: 'tykotech',
	});
	try {
		const token = await new SignJWT({ scope: 'mcp:invoke admin' })
			.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
			.setIssuer(issuer)
			.setAudience('tykotech')
			.setSubject('alice')
			.setExpirationTime('5m')
			.sign(privateKey);
		const cookie = await f.request('/api/v1/auth/login', {
			method: 'POST',
			headers: { origin: ORIGIN },
			body: { apiKey: token, session: 'cookie' },
		});
		assertEquals(cookie.status, 400);
		assertEquals(cookie.headers.get('set-cookie'), null);
		assertStringIncludes(((await cookie.json()) as { detail: string }).detail, 'bearer');
		// The bearer exchange is unchanged: the token comes back as it went.
		const bearer = await f.request('/api/v1/auth/login', { method: 'POST', body: { apiKey: token } });
		assertEquals(bearer.status, 200);
		assertEquals(((await bearer.json()) as { token: string }).token, token);
	} finally {
		await f.close();
		await server.shutdown();
	}
});

/** A request with an exact `Content-Type` (or none) and a raw body, for the rules the JSON helper would hide. */
async function raw(
	f: Fixture,
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string; base?: string },
): Promise<Response> {
	const base = init.base ?? ORIGIN;
	return await f.gateway.app.request(`${base}${path}`, {
		method: init.method ?? 'POST',
		headers: { host: new URL(base).host, ...init.headers },
		...(init.body === undefined ? {} : { body: init.body }),
	});
}

Deno.test('R1-2: a cookie sign-in must come from the server origin (scheme, host and port), not its hostname', async () => {
	const f = await fixture();
	try {
		const credentials = { username: 'root', password: f.password, session: 'cookie' };
		// Same hostname, so the process-wide (hostname-only) Origin allowlist admits every one of these.
		for (
			const origin of ['http://127.0.0.1:3000', 'https://127.0.0.1:9443', 'https://127.0.0.1:8787', 'http://127.0.0.1']
		) {
			const response = await f.request('/api/v1/auth/login', {
				method: 'POST',
				headers: { origin },
				body: credentials,
			});
			assertEquals(response.status, 403, origin);
			assertEquals((await response.json()).type, 'https://tykotech.eu/problems/origin-forbidden', origin);
			assertEquals(response.headers.get('set-cookie'), null, `${origin}: no cookie is set`);
		}
		// The loopback alias the operator typed is this server's own origin too: the page and the request agree.
		const alias = await raw(f, '/api/v1/auth/login', {
			base: 'http://localhost:8787',
			headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' },
			body: JSON.stringify(credentials),
		});
		assertEquals(alias.status, 200, await alias.clone().text());
		await alias.body?.cancel();
		// ... but not on another port of it.
		const aliasOtherPort = await raw(f, '/api/v1/auth/login', {
			base: 'http://localhost:8787',
			headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
			body: JSON.stringify(credentials),
		});
		assertEquals(aliasOtherPort.status, 403);
		await aliasOtherPort.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('R1-2: a cookie sign-in must be sent as application/json, so a cross-origin attempt needs a preflight', async () => {
	const f = await fixture();
	try {
		const body = JSON.stringify({ username: 'root', password: f.password, session: 'cookie' });
		for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', null]) {
			const response = await raw(f, '/api/v1/auth/login', {
				headers: { origin: ORIGIN, ...(type === null ? {} : { 'content-type': type }) },
				body,
			});
			assertEquals(response.status, 400, String(type));
			const problem = await response.json() as { type: string; detail: string };
			assertEquals(problem.type, 'https://tykotech.eu/problems/invalid-request');
			assertStringIncludes(problem.detail, 'application/json');
			assertEquals(response.headers.get('set-cookie'), null);
		}
		assertEquals(f.logins.size, 0, 'no sign-in was minted');
		// Bearer clients are unaffected: a sign-in that asks for a token in the body reads the body whatever its type.
		const bearer = await raw(f, '/api/v1/auth/login', {
			headers: { 'content-type': 'text/plain' },
			body: JSON.stringify({ username: 'root', password: f.password }),
		});
		assertEquals(bearer.status, 200);
		assert(((await bearer.json()) as { token: string }).token.startsWith('ttks_'));
	} finally {
		await f.close();
	}
});

Deno.test('R1-2: a cookie-authenticated change from another port of the same host is refused', async () => {
	const f = await fixture();
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });
		for (const origin of ['http://127.0.0.1:3000', 'https://127.0.0.1:8787']) {
			const response = await f.request('/api/v1/live/ticket', {
				method: 'POST',
				headers: { cookie, origin, 'x-ttk-csrf': csrf },
				body: {},
			});
			assertEquals(response.status, 403, origin);
			assertEquals((await response.json()).type, 'https://tykotech.eu/problems/csrf-failed', origin);
		}
		// Bearer clients carry no Origin obligation at all.
		const bearer = await f.request('/api/v1/live/ticket', {
			method: 'POST',
			headers: { authorization: `Bearer ${f.key}`, origin: 'http://127.0.0.1:3000' },
			body: {},
		});
		assertEquals(bearer.status, 201);
		await bearer.body?.cancel();
		// Outside a cluster nothing is ever forwarded, so the forward marker relaxes nothing.
		const notACluster = await f.request('/api/v1/live/ticket', {
			method: 'POST',
			headers: { cookie, origin: 'http://127.0.0.1:3000', 'x-ttk-csrf': csrf, 'x-ttk-forwarded-by': 'node-a' },
			body: {},
		});
		assertEquals(notACluster.status, 403);
		await notACluster.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('R1-2: in a cluster, a peer-forwarded cookie change keeps the hostname rule and the CSRF value', async () => {
	const f = await fixture();
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'kv-cookie-' });
	const cluster = await Cluster.open({
		kvPath: `${dir}/cluster.kv`,
		nodeId: 'node-b',
		nodeUrl: 'http://127.0.0.1:8788',
		role: 'all',
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
	});
	const node = createGatewayApp({
		config: f.config,
		verifier: f.verifier,
		registry: f.registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
		cluster,
	});
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });
		const mint = (headers: Record<string, string>) =>
			node.app.request(`${ORIGIN}/api/v1/live/ticket`, {
				method: 'POST',
				headers: { host: '127.0.0.1:8788', cookie, 'content-type': 'application/json', ...headers },
				body: '{}',
			});
		// The browser addressed node A, so its Origin is not this node's; the peer marked the forward. The marker is
		// not CORS-safelisted, so no cross-origin page can attach it without a preflight this server never grants.
		const forwarded = await mint({ origin: 'http://localhost:8787', 'x-ttk-csrf': csrf, 'x-ttk-forwarded-by': 'a' });
		assertEquals(forwarded.status, 201, await forwarded.clone().text());
		await forwarded.body?.cancel();
		// The CSRF value still applies, and so does the process-wide hostname list.
		const noCsrf = await mint({ origin: 'http://localhost:8787', 'x-ttk-forwarded-by': 'a' });
		assertEquals(noCsrf.status, 403);
		await noCsrf.body?.cancel();
		const foreign = await mint({ origin: 'https://evil.example', 'x-ttk-csrf': csrf, 'x-ttk-forwarded-by': 'a' });
		assertEquals(foreign.status, 403);
		await foreign.body?.cancel();
		// Without the marker, a cookie change on this node must come from this node's own origin.
		const unmarked = await mint({ origin: 'http://localhost:8787', 'x-ttk-csrf': csrf });
		assertEquals(unmarked.status, 403);
		assertEquals((await unmarked.json()).type, 'https://tykotech.eu/problems/csrf-failed');
		const own = await mint({ origin: 'http://127.0.0.1:8788', 'x-ttk-csrf': csrf });
		assertEquals(own.status, 201);
		await own.body?.cancel();
	} finally {
		await node.close();
		await cluster.close();
		await f.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('R1-2: duplicate or malformed sign-in cookies are refused and cleared, never resolved first-wins', async () => {
	const f = await fixture();
	try {
		const victim = await cookieSignIn(f, { username: 'root', password: f.password });
		const attacker = await cookieSignIn(f, { apiKey: f.key });
		/** Every clearing `Set-Cookie` of a response, by the path it clears. */
		const cleared = (response: Response): string[] =>
			response.headers.getSetCookie()
				.filter((line) => line.startsWith('ttk_session=;') && line.includes('Max-Age=0'))
				.map((line) => /Path=([^;]*)/.exec(line)?.[1] ?? '?');

		// (b) A planted cookie on a longer path is sent first; first-wins would answer as the attacker.
		const both = await f.request('/api/v1/auth/me', { headers: { cookie: `${attacker.cookie}; ${victim.cookie}` } });
		assertEquals(both.status, 401);
		const paths = cleared(both);
		await both.body?.cancel();
		for (const path of ['/', '/api', '/api/', '/api/v1', '/api/v1/auth', '/api/v1/auth/me']) {
			assert(paths.includes(path), `the clearing covers Path=${path}; got ${paths.join(' ')}`);
		}
		// (c) A junk first value no longer locks the browser out silently: it is refused *and* cleared.
		for (
			const jar of [
				`ttk_session=garbage; ${victim.cookie}`,
				'ttk_session=garbage',
				'ttk_session=',
				`ttk_session=${f.key}`,
			]
		) {
			const response = await f.request('/api/v1/sessions', { headers: { cookie: jar } });
			assertEquals(response.status, 401, jar);
			assert(cleared(response).includes('/'), `${jar}: cleared`);
			assert(cleared(response).includes('/api/v1/sessions'), `${jar}: cleared on the request's own path`);
			await response.body?.cancel();
		}
		// A single good cookie beside unrelated cookies still signs in.
		const fine = await f.request('/api/v1/auth/me', { headers: { cookie: `theme=dark; ${victim.cookie}; x=1` } });
		assertEquals(fine.status, 200);
		await fine.body?.cancel();
		// Bearer clients are unaffected by whatever the cookie jar holds.
		const bearer = await f.request('/api/v1/auth/me', {
			headers: { authorization: `Bearer ${f.key}`, cookie: `${attacker.cookie}; ttk_session=garbage` },
		});
		assertEquals(bearer.status, 200);
		assertEquals(bearer.headers.get('set-cookie'), null);
		await bearer.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('R1-3: logout clears the cookie even when the session cannot be ended, and says so', async () => {
	const lines: string[] = [];
	const f = await fixture();
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });
		const original = f.verifier.closeSession.bind(f.verifier);
		f.verifier.closeSession = () => Promise.reject(new Error('cluster store unavailable'));
		const gateway = createGatewayApp({
			config: f.config,
			verifier: f.verifier,
			registry: f.registry,
			version: 'test',
			logger: createLogger({ level: 'warn', write: (line) => lines.push(line) }),
		});
		try {
			const out = await gateway.app.request(`${ORIGIN}/api/v1/auth/logout`, {
				method: 'POST',
				headers: { host: HOST, cookie, origin: ORIGIN, 'x-ttk-csrf': csrf },
			});
			assertEquals(out.status, 500, 'the failure is reported, not hidden behind a 204');
			assertEquals(out.headers.get('set-cookie'), 'ttk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
			await out.body?.cancel();
			const logged = lines.map((line) => JSON.parse(line) as { msg: string });
			assert(logged.some((entry) => entry.msg === 'auth.logout_failed'), lines.join('\n'));
			assert(!lines.join('\n').includes('ttks_'), 'the token is never logged');
		} finally {
			f.verifier.closeSession = original;
			await gateway.close();
		}
	} finally {
		await f.close();
	}
});

Deno.test('R1-3: logout is not rate-limited, so a spent budget cannot keep a browser signed in', async () => {
	const f = await fixture({ TTK_RATE_RPM: '2' });
	try {
		const { cookie, csrf } = await cookieSignIn(f, { username: 'root', password: f.password });
		for (let i = 0; i < 3; i += 1) await (await f.request('/api/v1/auth/me', { headers: { cookie } })).body?.cancel();
		const spent = await f.request('/api/v1/auth/me', { headers: { cookie } });
		assertEquals(spent.status, 429, 'the budget is spent');
		await spent.body?.cancel();
		const out = await f.request('/api/v1/auth/logout', {
			method: 'POST',
			headers: { cookie, origin: ORIGIN, 'x-ttk-csrf': csrf },
		});
		assertEquals(out.status, 204);
		assertStringIncludes(out.headers.get('set-cookie') ?? '', 'Max-Age=0');
		assertEquals(f.logins.size, 0);
	} finally {
		await f.close();
	}
});

Deno.test('R1-7: GET /api/v1/auth/me is never cached: it carries the CSRF value', async () => {
	const f = await fixture();
	try {
		const { cookie } = await cookieSignIn(f, { username: 'root', password: f.password });
		const me = await f.request('/api/v1/auth/me', { headers: { cookie } });
		assertEquals(me.status, 200);
		assertEquals(me.headers.get('cache-control'), 'no-store');
		await me.body?.cancel();
		const bearer = await f.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${f.key}` } });
		assertEquals(bearer.headers.get('cache-control'), 'no-store');
		await bearer.body?.cancel();
	} finally {
		await f.close();
	}
});
