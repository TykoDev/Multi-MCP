import { assertEquals, assertInstanceOf, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { FakeTime } from '@std/testing/time';

import { CdpError } from './errors.ts';
import { CdpFixtureServer } from './testing/cdp_fixture.ts';
import {
	CdpTransport,
	type CdpWireFrame,
	DEFAULT_CONNECT_TIMEOUT_MS,
	extractFrameId,
	MAX_INBOUND_FRAME_BYTES,
	measureFrameBytes,
	parseCdpWebSocketUrl,
} from './transport.ts';

Deno.test('cdp transport: the inbound frame budget is 200 MB', () => {
	assertEquals(MAX_INBOUND_FRAME_BYTES, 209_715_200);
	assertEquals(MAX_INBOUND_FRAME_BYTES, 200 * 1024 * 1024);
});

Deno.test('cdp transport: the WebSocket handshake budget is 15 s', () => {
	assertEquals(DEFAULT_CONNECT_TIMEOUT_MS, 15_000);
});

Deno.test('cdp transport: measureFrameBytes handles text, ArrayBuffer and views', () => {
	assertEquals(measureFrameBytes('abcd'), 4);
	assertEquals(measureFrameBytes(new ArrayBuffer(64)), 64);
	assertEquals(measureFrameBytes(new Uint8Array(32)), 32);
});

Deno.test('cdp transport: extractFrameId recovers a correlation id from a frame prefix', () => {
	assertEquals(extractFrameId('{"id":42,"result":{"data":"AAAA"}}'), 42);
	assertEquals(extractFrameId('{ "id" : 7 , "result": {} }'), 7);
	assertEquals(extractFrameId('{"method":"Page.lifecycleEvent","params":{}}'), null);
	assertEquals(extractFrameId('not json at all'), null);
	// Beyond the scanned prefix the id is deliberately not found — the scan stays O(1).
	assertEquals(extractFrameId(`{"pad":"${'x'.repeat(600)}","id":9}`), null);
});

Deno.test('cdp transport: parseCdpWebSocketUrl accepts ws(s) and points http(s) at the handshake helper', () => {
	assertEquals(
		parseCdpWebSocketUrl('ws://127.0.0.1:9222/devtools/browser/x'),
		'ws://127.0.0.1:9222/devtools/browser/x',
	);
	assertEquals(parseCdpWebSocketUrl('wss://127.0.0.1/x'), 'wss://127.0.0.1/x');

	const httpError = assertThrows(() => parseCdpWebSocketUrl('http://127.0.0.1:9222'), CdpError);
	assertStringIncludes(httpError.message, 'fetchWebSocketDebuggerUrl');

	assertThrows(() => parseCdpWebSocketUrl('ftp://127.0.0.1/x'), CdpError, 'unsupported CDP URL scheme');
	assertThrows(() => parseCdpWebSocketUrl('nonsense'), CdpError, 'invalid CDP URL');
});

Deno.test('cdp transport: opens against a real local socket, delivers frames, and reports a clean close', async () => {
	await using fixture = CdpFixtureServer.start();
	const frames: CdpWireFrame[] = [];
	let closeCount = 0;

	const transport = await CdpTransport.open(fixture.url, {
		onFrame: (frame) => void frames.push(frame),
		onFrameError: () => {},
		onClose: () => void closeCount++,
	});
	try {
		assertEquals(transport.state, 'open');
		assertEquals(transport.url, fixture.url);

		transport.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
		await fixture.waitForRequest('Browser.getVersion');
		fixture.emit('Page.lifecycleEvent', { name: 'load' }, 'S1');

		const closed = transport.closed;
		transport.close();
		const info = await closed;

		assertEquals(info.intentional, true);
		assertEquals(transport.state, 'closed');
		assertEquals(closeCount, 1);
		assertEquals(frames.length, 2);
		assertEquals(frames[0]?.id, 1);
		assertEquals(frames[1]?.method, 'Page.lifecycleEvent');
		assertEquals(frames[1]?.sessionId, 'S1');
	} finally {
		transport.close();
	}
});

Deno.test('cdp transport: send after close throws instead of silently dropping', async () => {
	await using fixture = CdpFixtureServer.start();
	const transport = await CdpTransport.open(fixture.url, {
		onFrame: () => {},
		onFrameError: () => {},
		onClose: () => {},
	});
	transport.close();
	await transport.closed;
	assertThrows(() => transport.send('{}'), CdpError, 'closed CDP WebSocket');
});

Deno.test('cdp transport: an undecodable frame is reported, not thrown into the read loop', async () => {
	await using fixture = CdpFixtureServer.start();
	const errors: CdpError[] = [];
	const seen = Promise.withResolvers<void>();
	const transport = await CdpTransport.open(fixture.url, {
		onFrame: () => {},
		onFrameError: (error) => {
			errors.push(error);
			seen.resolve();
		},
		onClose: () => {},
	});
	try {
		fixture.sendRaw('{not json');
		await seen.promise;
		assertInstanceOf(errors[0], CdpError);
		assertStringIncludes(errors[0].message, 'failed to parse inbound CDP frame');
		assertEquals(transport.state, 'open');
	} finally {
		transport.close();
		await transport.closed;
	}
});

Deno.test('cdp transport: decodes binary frames and rejects non-object JSON', async () => {
	await using fixture = CdpFixtureServer.start();
	const frames: CdpWireFrame[] = [];
	const errors = Promise.withResolvers<CdpError>();
	const transport = await CdpTransport.open(fixture.url, {
		onFrame: (frame) => void frames.push(frame),
		onFrameError: (error) => errors.resolve(error),
		onClose: () => {},
	});
	try {
		// Some CDP proxies frame their JSON as binary; the transport must not choke on it.
		fixture.sendBinary(new TextEncoder().encode(JSON.stringify({ method: 'Page.loadEventFired', params: {} })));
		await waitFor(() => frames.length === 1);
		assertEquals(frames[0]?.method, 'Page.loadEventFired');

		fixture.sendRaw('42');
		const error = await errors.promise;
		assertStringIncludes(error.message, 'not a JSON object');
		assertEquals(transport.state, 'open');
	} finally {
		transport.close();
		await transport.closed;
	}
});

Deno.test('cdp transport: a stalled handshake times out and tears the socket down', async () => {
	// A server that completes the TCP/HTTP connection but never answers the upgrade.
	const stalled = new AbortController();
	const serverAbort = new AbortController();
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, signal: serverAbort.signal, onListen: () => {} },
		() =>
			new Promise<Response>((resolve) => {
				stalled.signal.addEventListener('abort', () => resolve(new Response('released')), { once: true });
			}),
	);
	const url = `ws://127.0.0.1:${server.addr.port}/stalled`;
	try {
		using time = new FakeTime();
		const opening = CdpTransport.open(url, { onFrame: () => {}, onFrameError: () => {}, onClose: () => {} }, {
			connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
		}).catch((error: unknown) => error);

		await time.tickAsync(DEFAULT_CONNECT_TIMEOUT_MS);
		const error = await opening;
		assertInstanceOf(error, CdpError);
		assertStringIncludes(error.message, 'timed out after 15000ms');
	} finally {
		stalled.abort();
		serverAbort.abort();
		await server.finished;
	}
});

Deno.test('cdp transport: refuses an http(s) CDP URL before opening a socket', async () => {
	await assertRejects(
		() => CdpTransport.open('http://127.0.0.1:9222', { onFrame: () => {}, onFrameError: () => {}, onClose: () => {} }),
		CdpError,
		'fetchWebSocketDebuggerUrl',
	);
});

Deno.test('cdp transport: an aborted signal fails the open instead of leaking a socket', async () => {
	await using fixture = CdpFixtureServer.start();
	await assertRejects(
		() =>
			CdpTransport.open(fixture.url, { onFrame: () => {}, onFrameError: () => {}, onClose: () => {} }, {
				signal: AbortSignal.abort(new CdpError('caller cancelled')),
			}),
		CdpError,
		'caller cancelled',
	);
});

/** Yield an event-loop turn so pending socket reads are delivered. Not a sleep; no duration semantics. */
async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
	for (let index = 0; index < attempts; index++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
	}
	throw new Error('waitFor: predicate never became true');
}
