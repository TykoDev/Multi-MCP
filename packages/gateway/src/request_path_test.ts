/**
 * R1-5: the credential decision and the router judge the same path.
 *
 * Deno keeps a request target's raw dot segments in `request.url`, the WHATWG parser behind `new URL()` resolves
 * them (and `%2e`) away, and Hono routes the raw path, percent-decoded. So `GET /a2a/v1/../../live/x/ws` was public to
 * the auth middleware — it saw `/live/x/ws` — while the router sent it into the authenticated `/a2a/v1/*` wildcard.
 * The front now refuses a target that is not in canonical form (a dot segment, raw or encoded; an encoded slash or
 * backslash; an empty segment), and the auth middleware judges public-ness on the router's own path.
 *
 * A `Request` built in a test normalizes its URL, so the dot-segment rows go over a real socket on an ephemeral
 * loopback port, exactly as a client would send them.
 */
import { assert, assertEquals } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { pathRefusal, rawPathOf } from './request_path.ts';

Deno.test('R1-5: rawPathOf keeps the target as sent; pathRefusal names every non-canonical form', () => {
	assertEquals(rawPathOf('http://h:1/a2a/v1/../../live/x/ws?y=1'), '/a2a/v1/../../live/x/ws');
	assertEquals(rawPathOf('http://h:1/a#frag'), '/a');
	assertEquals(rawPathOf('http://h:1'), '/');
	assertEquals(rawPathOf('http://h:1?x=/y'), '/');
	assertEquals(rawPathOf('http://[::1]:8787//api/v1/x'), '//api/v1/x');

	for (
		const canonical of [
			'/',
			'/healthz',
			'/mcp',
			'/mcp/',
			'/api/v1/sessions/01J0/files/x.pdf',
			'/assets/app.js',
			'/live/default/ws',
			'/.well-known/agent-card.json',
			'/a2a/v1/message:send',
			'/api/v1/share/file',
			'/x/..y/y..',
			'/%41',
		]
	) {
		assertEquals(pathRefusal(canonical), null, canonical);
	}
	for (
		const [path, why] of [
			['/a2a/v1/../../live/x/ws', 'dot segment'],
			['/a2a/v1/%2e%2e/live', 'dot segment'],
			['/a2a/v1/%2E%2e/live', 'dot segment'],
			['/a2a/v1/.%2E/live', 'dot segment'],
			['/./healthz', 'dot segment'],
			['/a2a/v1/%2e', 'dot segment'],
			['/live/..', 'dot segment'],
			['//api/v1/x', 'empty segment'],
			['/api//v1', 'empty segment'],
			['/api/v1%2fsessions', 'encoded slash'],
			['/api/v1%2Fsessions', 'encoded slash'],
			['/api/v1%5csessions', 'encoded slash'],
			['/api\\v1', 'backslash'],
			['', 'not a path'],
			['api', 'not a path'],
		] as const
	) {
		const refusal = pathRefusal(path);
		assert(refusal !== null && refusal.includes(why), `${path}: ${refusal}`);
	}
});

/** One raw HTTP/1.1 request over a fresh connection: the status and the body. */
async function rawRequest(port: number, target: string): Promise<{ status: number; body: string }> {
	const conn = await Deno.connect({ hostname: '127.0.0.1', port });
	try {
		await conn.write(
			new TextEncoder().encode(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`),
		);
		const chunks: Uint8Array[] = [];
		const buffer = new Uint8Array(16 * 1024);
		for (;;) {
			const read = await conn.read(buffer);
			if (read === null) break;
			chunks.push(buffer.slice(0, read));
		}
		const text = new TextDecoder().decode(new Uint8Array(chunks.flatMap((chunk) => [...chunk])));
		const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
		return { status, body: text.slice(text.indexOf('\r\n\r\n') + 4) };
	} finally {
		try {
			conn.close();
		} catch {
			// Already closed by the server.
		}
	}
}

Deno.test('R1-5: a non-canonical request target is refused before auth and routing, over a real socket', async () => {
	const key = await generateApiKey('ops', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_API_KEYS: JSON.stringify([key.record]) });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
	});
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		(request, info) => gateway.app.fetch(request, { remoteAddr: info.remoteAddr }),
	);
	try {
		const port = server.addr.port;
		// The baseline: a canonical public path answers, and Deno really does hand the raw target through.
		assertEquals((await rawRequest(port, '/healthz')).status, 200);
		for (
			const target of [
				'/a2a/v1/../../live/x/ws',
				'/a2a/v1/%2e%2e/%2E%2E/live/x/ws',
				'/a2a/v1/./tasks',
				'/assets/../a2a/v1/tasks',
				'//api/v1/sessions',
				'/api/v1/sessions%2Fx',
			]
		) {
			const { status, body } = await rawRequest(port, target);
			assertEquals(status, 400, `${target}: ${body}`);
			assertEquals(JSON.parse(body).type, 'https://tykotech.eu/problems/invalid-request', target);
		}
	} finally {
		await server.shutdown();
		await gateway.close();
		await registry.shutdown();
	}
});

Deno.test('R1-5: the auth middleware judges public-ness on the path the router matches', async () => {
	const key = await generateApiKey('ops', ['mcp:invoke']);
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_API_KEYS: JSON.stringify([key.record]) });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
	});
	try {
		// `%6C` is `l`: the router decodes it and matches `/live/:sessionId/ws`, the ticket-checked socket route.
		// Judged on the undecoded path the middleware demanded a bearer the browser socket can never send; judged on
		// the router's path, the ticket check answers, as it does for `/live/default/ws`.
		for (const path of ['/%6Cive/default/ws', '/live/default/ws']) {
			const response = await gateway.app.request(`http://127.0.0.1:8787${path}`, {
				headers: { host: '127.0.0.1:8787', upgrade: 'websocket', connection: 'Upgrade' },
			});
			assertEquals(response.status, 403, path);
			assertEquals((await response.json()).type, 'https://tykotech.eu/problems/ticket-invalid', path);
		}
		// And the other way round: an encoded spelling of a protected route stays protected.
		const hidden = await gateway.app.request('http://127.0.0.1:8787/api/v1/%73essions', {
			headers: { host: '127.0.0.1:8787' },
		});
		assertEquals(hidden.status, 401);
		await hidden.body?.cancel();
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});
