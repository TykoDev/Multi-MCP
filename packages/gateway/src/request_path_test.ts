/** The credential decision and the router judge the same path. */
import { assert, assertEquals } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { pathRefusal, rawPathOf } from './request_path.ts';

Deno.test('rawPathOf keeps the target as sent; pathRefusal names every non-canonical form', () => {
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
			// Escapes of reserved, space and non-ASCII characters stay legal — only unreserved and control ones go.
			'/api/v1/sessions/01J0/files/a%20b.pdf',
			'/api/v1/sessions/01J0/files/%C3%A9t%C3%A9.txt',
			'/a2a/v1/message%3Asend',
			'/x/%25',
			'/x/%21',
			'/x/%40%5B%7B%60',
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
			// An encoded unreserved character (A-Z, a-z, 0-9, - . _ ~) or control character (C0, DEL).
			['/%41', 'unreserved or control'],
			['/%61pi/v1/live/ticket', 'unreserved or control'],
			['/api/v1/%73essions', 'unreserved or control'],
			['/%6Cive/default/ws', 'unreserved or control'],
			['/mcp%5F', 'unreserved or control'],
			['/m%63p', 'unreserved or control'],
			['/x/%30', 'unreserved or control'],
			['/x/%2D', 'unreserved or control'],
			['/x/a%2eb', 'unreserved or control'],
			['/x/%7e', 'unreserved or control'],
			['/x/%5A', 'unreserved or control'],
			['/x/%7a', 'unreserved or control'],
			['/x/%0A', 'unreserved or control'],
			['/x/%0d', 'unreserved or control'],
			['/x/%09', 'unreserved or control'],
			['/x/%00', 'unreserved or control'],
			['/x/%1F', 'unreserved or control'],
			['/x/%7F', 'unreserved or control'],
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

Deno.test('a non-canonical request target is refused before auth and routing, over a real socket', async () => {
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

Deno.test('the auth middleware judges public-ness on the path the router matches', async () => {
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
		// The public socket route is judged public and answered by its ticket check.
		const socket = await gateway.app.request('http://127.0.0.1:8787/live/default/ws', {
			headers: { host: '127.0.0.1:8787', upgrade: 'websocket', connection: 'Upgrade' },
		});
		assertEquals(socket.status, 403);
		assertEquals((await socket.json()).type, 'https://tykotech.eu/problems/ticket-invalid');
		// An encoded spelling of either a public or a protected route (`%6C` is `l`, `%73` is `s`) never reaches the
		// middleware at all — the front refuses it, so the raw and routed paths cannot disagree there either.
		for (const path of ['/%6Cive/default/ws', '/api/v1/%73essions']) {
			const response = await gateway.app.request(`http://127.0.0.1:8787${path}`, {
				headers: { host: '127.0.0.1:8787', upgrade: 'websocket', connection: 'Upgrade' },
			});
			assertEquals(response.status, 400, path);
			assertEquals((await response.json()).type, 'https://tykotech.eu/problems/invalid-request', path);
		}
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});

Deno.test('an encoded spelling cannot slip a body past the cap or a ticket mint past the drain gate', async () => {
	const key = await generateApiKey('ops', ['mcp:invoke', 'view:control']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([key.record]),
		TTK_MAX_BODY_KB: '1',
	});
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
	});
	const mint = (path: string, body: string) =>
		gateway.app.request(`http://127.0.0.1:8787${path}`, {
			method: 'POST',
			// Not JSON-typed, so the per-path rule applies — the one an encoded raw path would dodge.
			headers: { host: '127.0.0.1:8787', authorization: `Bearer ${key.key}`, 'content-type': 'text/plain' },
			body,
		});
	try {
		// `%61` is `a`: the router would serve this as `/api/v1/live/ticket`, uncapped.
		const big = 'x'.repeat(4096);
		const canonical = await mint('/api/v1/live/ticket', big);
		assertEquals(canonical.status, 413);
		await canonical.body?.cancel();
		const encoded = await mint('/%61pi/v1/live/ticket', big);
		assertEquals(encoded.status, 400);
		assertEquals((await encoded.json()).type, 'https://tykotech.eu/problems/invalid-request');

		// And while draining: the drain gate does not recognise the encoded spelling, and does not have to — the path
		// refusal right behind it answers, so the mint is never reached.
		gateway.drain();
		const drained = await mint('/api/v1/live/ticket', '');
		assertEquals(drained.status, 503);
		await drained.body?.cancel();
		const drainedEncoded = await mint('/%61pi/v1/live/ticket', '');
		assertEquals(drainedEncoded.status, 400);
		await drainedEncoded.body?.cancel();
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});
