/**
 * Tier 2 — the `/json/version` handshake against local `Deno.serve` fixtures
 * (ARCHITECTURE.md §7.4; OBSERVABILITY-TESTING-CICD.md §4.3).
 *
 * No browser is required here, but the suite lives in `tests/` because it needs `--allow-net`, which
 * the pure-unit tier does not get (SECURITY-AUTH.md §3.6).
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { BrowserLaunchError, CDP_PACKAGE_VERSION, fetchWebSocketDebuggerUrl, readEnv } from '../src/launch.ts';
import { startFixtureServer } from './_helpers.ts';

function versionDocument(wsUrl: string): Response {
	return Response.json({
		'Browser': 'Chrome/141.0.0.0',
		'Protocol-Version': '1.3',
		'User-Agent': 'Mozilla/5.0',
		'webSocketDebuggerUrl': wsUrl,
	});
}

Deno.test('handshake: returns webSocketDebuggerUrl from /json/version', async () => {
	const wsUrl = 'ws://127.0.0.1:9999/devtools/browser/abc-123';
	const fixture = startFixtureServer({ '/json/version': () => versionDocument(wsUrl) });
	try {
		assertEquals(await fetchWebSocketDebuggerUrl(fixture.baseUrl), wsUrl);
		assertEquals(fixture.requests, ['/json/version']);
	} finally {
		await fixture.close();
	}
});

Deno.test('handshake: sends User-Agent bua/<version> plus caller headers', async () => {
	let seen: Headers | null = null;
	const fixture = startFixtureServer({
		'/json/version': (req) => {
			seen = req.headers;
			return versionDocument('ws://127.0.0.1:1/devtools/browser/x');
		},
	});
	try {
		await fetchWebSocketDebuggerUrl(fixture.baseUrl, { 'x-profile-header': 'from-profile' });
		const headers = seen as unknown as Headers;
		assertEquals(headers.get('user-agent'), `bua/${CDP_PACKAGE_VERSION}`);
		assertEquals(headers.get('x-profile-header'), 'from-profile');
	} finally {
		await fixture.close();
	}
});

Deno.test('handshake: caller headers may override the default User-Agent', async () => {
	let seen: Headers | null = null;
	const fixture = startFixtureServer({
		'/json/version': (req) => {
			seen = req.headers;
			return versionDocument('ws://127.0.0.1:1/devtools/browser/x');
		},
	});
	try {
		await fetchWebSocketDebuggerUrl(fixture.baseUrl, { 'user-agent': 'custom/9' });
		assertEquals((seen as unknown as Headers).get('user-agent'), 'custom/9');
	} finally {
		await fixture.close();
	}
});

Deno.test('handshake: a chunked response is de-chunked correctly', async () => {
	const wsUrl = 'ws://127.0.0.1:9999/devtools/browser/chunked';
	const fixture = startFixtureServer({
		'/json/version': () => {
			const body = JSON.stringify({ webSocketDebuggerUrl: wsUrl });
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode(body.slice(0, 10)));
					controller.enqueue(encoder.encode(body.slice(10)));
					controller.close();
				},
			});
			// No content-length ⇒ Deno.serve uses chunked transfer-encoding.
			return new Response(stream, { headers: { 'content-type': 'application/json' } });
		},
	});
	try {
		assertEquals(await fetchWebSocketDebuggerUrl(fixture.baseUrl), wsUrl);
	} finally {
		await fixture.close();
	}
});

Deno.test('handshake: a non-200 status is a typed error, not a hang', async () => {
	const fixture = startFixtureServer({
		'/json/version': () => new Response('nope', { status: 503 }),
	});
	try {
		const error = await assertRejects(
			() => fetchWebSocketDebuggerUrl(fixture.baseUrl),
			BrowserLaunchError,
		);
		assertStringIncludes(error.message, 'HTTP 503');
	} finally {
		await fixture.close();
	}
});

Deno.test('handshake: a document without webSocketDebuggerUrl is rejected', async () => {
	const fixture = startFixtureServer({
		'/json/version': () => Response.json({ Browser: 'Chrome/141.0.0.0' }),
	});
	try {
		const error = await assertRejects(
			() => fetchWebSocketDebuggerUrl(fixture.baseUrl),
			BrowserLaunchError,
		);
		assertStringIncludes(error.message, 'no webSocketDebuggerUrl');
	} finally {
		await fixture.close();
	}
});

Deno.test('handshake: non-JSON is rejected with a typed error', async () => {
	const fixture = startFixtureServer({ '/json/version': () => new Response('<html>nope</html>') });
	try {
		await assertRejects(() => fetchWebSocketDebuggerUrl(fixture.baseUrl), BrowserLaunchError, 'non-JSON');
	} finally {
		await fixture.close();
	}
});

Deno.test('handshake: an unreachable port fails fast instead of hanging', async () => {
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0, transport: 'tcp' });
	const port = (listener.addr as Deno.NetAddr).port;
	listener.close();
	const started = Date.now();
	await assertRejects(() => fetchWebSocketDebuggerUrl(`http://127.0.0.1:${port}`), BrowserLaunchError);
	assert(Date.now() - started < 30_000);
});

/**
 * ARCHITECTURE.md §7.4: proxy env MUST NOT intercept localhost. Deno's `fetch` honours
 * `HTTP_PROXY`/`ALL_PROXY` and does not exempt loopback, so the handshake speaks raw HTTP/1.1 over
 * `Deno.connect` for loopback hosts. With a black-hole proxy configured, a proxying implementation
 * would fail; ours must not.
 *
 * Needs `--allow-env=HTTP_PROXY,HTTPS_PROXY,ALL_PROXY`; skips cleanly when the matrix omits them.
 */
const canSetProxyEnv = (() => {
	try {
		const previous = Deno.env.get('HTTP_PROXY');
		Deno.env.set('HTTP_PROXY', previous ?? '');
		if (previous === undefined) Deno.env.delete('HTTP_PROXY');
		else Deno.env.set('HTTP_PROXY', previous);
		return true;
	} catch {
		return false;
	}
})();

Deno.test({
	name: 'handshake: proxy env does not intercept the loopback CDP handshake',
	ignore: !canSetProxyEnv,
	fn: async () => {
		const deadListener = Deno.listen({ hostname: '127.0.0.1', port: 0, transport: 'tcp' });
		const deadPort = (deadListener.addr as Deno.NetAddr).port;
		deadListener.close();

		const wsUrl = 'ws://127.0.0.1:9999/devtools/browser/no-proxy';
		const fixture = startFixtureServer({ '/json/version': () => versionDocument(wsUrl) });
		const previous = readEnv('HTTP_PROXY');
		Deno.env.set('HTTP_PROXY', `http://127.0.0.1:${deadPort}`);
		Deno.env.set('HTTPS_PROXY', `http://127.0.0.1:${deadPort}`);
		try {
			assertEquals(await fetchWebSocketDebuggerUrl(fixture.baseUrl), wsUrl);
			assertEquals(fixture.requests, ['/json/version']);
		} finally {
			if (previous === undefined) Deno.env.delete('HTTP_PROXY');
			else Deno.env.set('HTTP_PROXY', previous);
			Deno.env.delete('HTTPS_PROXY');
			await fixture.close();
		}
	},
});
