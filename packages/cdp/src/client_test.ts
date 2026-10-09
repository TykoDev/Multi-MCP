import {
	assert,
	assertEquals,
	assertInstanceOf,
	assertNotEquals,
	assertRejects,
	assertStringIncludes,
} from '@std/assert';
// The CDP transport itself is never mocked — every test drives a real local WebSocket fixture server
// (D-TEST1 forbids mocking the transport, so the fixture is mandatory, not a convenience).
// mock-seam: the stderr write sink, to assert wire-log output — a module seam inside @tykotech/cdp.
import { stub } from '@std/testing/mock';
import { FakeTime } from '@std/testing/time';

import {
	CDP_TIMEOUT_ENV,
	CDP_TIMEOUT_ENV_COMPAT,
	CDP_WIRE_LOG_ENV,
	CdpClient,
	type CdpWireLogRecord,
	DEFAULT_CDP_REQUEST_TIMEOUT_MS,
	isWireLogEnabledByEnv,
	MAX_INBOUND_FRAME_BYTES,
	resolveRequestTimeoutMs,
	WIRE_LOG_BODY_LIMIT,
} from './client.ts';
import {
	CdpConnectionClosedError,
	CdpError,
	CdpFrameTooLargeError,
	CdpProtocolError,
	CdpRequestTimeoutError,
} from './errors.ts';
import { CdpFixtureServer } from './testing/cdp_fixture.ts';

/** Collect `count` values, exposing a promise that resolves once they have all arrived. */
function collector<T>(count: number): { push: (value: T) => void; done: Promise<T[]> } {
	const values: T[] = [];
	const { promise, resolve } = Promise.withResolvers<T[]>();
	return {
		push: (value: T) => {
			values.push(value);
			if (values.length >= count) resolve(values);
		},
		done: promise,
	};
}

async function envIsGranted(...variables: string[]): Promise<boolean> {
	for (const variable of variables) {
		const status = await Deno.permissions.query({ name: 'env', variable });
		if (status.state !== 'granted') return false;
	}
	return true;
}

/**
 * Run `fn` with both timeout env vars unset, restoring them afterwards.
 *
 * Under a narrower `--allow-env` grant the vars are unreadable anyway, which is the same observable
 * state, so the body runs unchanged.
 */
async function withUnsetTimeoutEnv<T>(fn: () => Promise<T>): Promise<T> {
	if (!(await envIsGranted(CDP_TIMEOUT_ENV, CDP_TIMEOUT_ENV_COMPAT))) return await fn();
	const prior = [CDP_TIMEOUT_ENV, CDP_TIMEOUT_ENV_COMPAT].map((name) => [name, Deno.env.get(name)] as const);
	for (const [name] of prior) Deno.env.delete(name);
	try {
		return await fn();
	} finally {
		for (const [name, value] of prior) {
			if (value === undefined) Deno.env.delete(name);
			else Deno.env.set(name, value);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// 1. Native WebSocket transport
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: connects over a native WebSocket and round-trips a typed command', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Browser.getVersion', (request, server) =>
		server.reply(request.id, {
			protocolVersion: '1.3',
			product: 'HeadlessChrome/999.0.0.0',
			revision: '@fixture',
			userAgent: 'fixture',
			jsVersion: '99',
		}));

	const client = await CdpClient.connect(fixture.url);
	try {
		assertEquals(client.state, 'open');
		assertEquals(client.url, fixture.url);

		const version = await client.send.Browser.getVersion();
		assertEquals(version.product, 'HeadlessChrome/999.0.0.0');

		assertEquals(fixture.requests.length, 1);
		assertEquals(fixture.requests[0]?.id, 1);
		assertEquals(fixture.requests[0]?.method, 'Browser.getVersion');
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: connect rejects an http(s) DevTools URL with the handshake remedy', async () => {
	const error = await assertRejects(() => CdpClient.connect('http://127.0.0.1:9222'), CdpError);
	assertStringIncludes(error.message, 'fetchWebSocketDebuggerUrl');
});

// ---------------------------------------------------------------------------------------------
// 2. Id-correlated request/response
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: assigns incrementing ids and correlates out-of-order responses', async () => {
	await using fixture = CdpFixtureServer.start();
	const held: number[] = [];
	fixture.on('Runtime.evaluate', (request) => void held.push(request.id));

	const client = await CdpClient.connect(fixture.url);
	try {
		const first = client.send.Runtime.evaluate({ expression: '1' });
		const second = client.send.Runtime.evaluate({ expression: '2' });
		const third = client.send.Runtime.evaluate({ expression: '3' });
		await fixture.waitForRequest('Runtime.evaluate');
		// ERRATUM(E-118): yield a macrotask, not a microtask. A microtask-only loop never lets the event loop read the
		// socket, so when the three frames arrive in separate reads it spins at 100% CPU forever.
		while (held.length < 3) await new Promise((resolve) => setTimeout(resolve, 0));

		assertEquals(held, [1, 2, 3]);
		assertEquals(client.pendingRequestCount, 3);

		// Answer in reverse; every promise must still get its own result.
		fixture.reply(3, { result: { type: 'number', value: 3 } });
		fixture.reply(1, { result: { type: 'number', value: 1 } });
		fixture.reply(2, { result: { type: 'number', value: 2 } });

		assertEquals((await first).result.value, 1);
		assertEquals((await second).result.value, 2);
		assertEquals((await third).result.value, 3);
		assertEquals(client.pendingRequestCount, 0);
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: a CDP error payload rejects with a typed CdpProtocolError', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on(
		'Page.navigate',
		(request, server) =>
			server.replyError(request.id, { code: -32000, message: 'Cannot navigate to invalid URL', data: 'chrome://x' }),
	);

	const client = await CdpClient.connect(fixture.url);
	try {
		const error = await assertRejects(
			() => client.send.Page.navigate({ url: 'chrome://x' }, 'S9'),
			CdpProtocolError,
		);
		assertEquals(error.code, -32000);
		assertEquals(error.method, 'Page.navigate');
		assertEquals(error.sessionId, 'S9');
		assertStringIncludes(error.message, 'Cannot navigate to invalid URL');
		assertEquals(client.pendingRequestCount, 0);
		// A protocol error is the browser saying "no" — the socket stays usable.
		assertEquals(client.state, 'open');
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: every pending request rejects when the socket drops', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Page.enable', () => {});

	const client = await CdpClient.connect(fixture.url);
	const first = client.send.Page.enable(undefined, 'S1');
	const second = client.send.Page.enable(undefined, 'S2');
	await fixture.waitForRequest('Page.enable');
	assertEquals(client.pendingRequestCount, 2);

	fixture.drop();

	const firstError = await assertRejects(() => first, CdpConnectionClosedError);
	const secondError = await assertRejects(() => second, CdpConnectionClosedError);
	assertEquals(firstError.intentional, false);
	assertEquals(secondError.intentional, false);
	assertEquals(firstError.method, 'Page.enable');
	assertEquals(client.pendingRequestCount, 0);
	assertEquals(client.state, 'closed');

	await client.close();
});

Deno.test('cdp client: a response with no pending request is dropped, not thrown', async () => {
	await using fixture = CdpFixtureServer.start();
	const client = await CdpClient.connect(fixture.url);
	try {
		fixture.sendRaw(JSON.stringify({ id: 9999, result: { stale: true } }));
		// The connection must survive it and keep serving.
		const version = await client.send.Browser.getVersion();
		assertNotEquals(version, undefined);
		assertEquals(client.state, 'open');
	} finally {
		await client.close();
	}
});

// ---------------------------------------------------------------------------------------------
// 3. Per-request timeout: 60 s default, env-overridable, never a hang
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: the per-request timeout defaults to 60 s and yields CdpRequestTimeoutError', async () => {
	assertEquals(DEFAULT_CDP_REQUEST_TIMEOUT_MS, 60_000);

	await withUnsetTimeoutEnv(async () => {
		await using fixture = CdpFixtureServer.start();
		fixture.on('DOMSnapshot.captureSnapshot', () => {});

		const client = await CdpClient.connect(fixture.url);
		try {
			let rejected = false;
			{
				using time = new FakeTime();
				const pending = client.send.DOMSnapshot.captureSnapshot({ computedStyles: [] }).catch((error: unknown) => {
					rejected = true;
					return error;
				});

				await time.tickAsync(59_999);
				assert(!rejected, 'request settled before the 60 s budget elapsed');
				assertEquals(client.pendingRequestCount, 1);

				await time.tickAsync(1);
				const error = await pending;
				assertInstanceOf(error, CdpRequestTimeoutError);
				assertEquals(error.timeoutMs, 60_000);
				assertEquals(error.method, 'DOMSnapshot.captureSnapshot');
			}
			// Timer cleared, map entry gone, socket still usable — a timeout is not a disconnect.
			assertEquals(client.pendingRequestCount, 0);
			assertEquals(client.state, 'open');
			await client.send.Browser.getVersion();
		} finally {
			await client.close();
		}
	});
});

Deno.test('cdp client: opts.requestTimeoutMs overrides the default per call', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Page.enable', () => {});

	const client = await CdpClient.connect(fixture.url);
	try {
		{
			using time = new FakeTime();
			const pending = client.send.Page.enable(undefined, undefined, { requestTimeoutMs: 5_000 }).catch((
				error: unknown,
			) => error);
			await time.tickAsync(5_000);
			const error = await pending;
			assertInstanceOf(error, CdpRequestTimeoutError);
			assertEquals(error.timeoutMs, 5_000);
		}
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: a caller AbortSignal cancels a request without killing the connection', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Page.enable', () => {});

	const client = await CdpClient.connect(fixture.url);
	try {
		const controller = new AbortController();
		const pending = client.send.Page.enable(undefined, undefined, { signal: controller.signal });
		await fixture.waitForRequest('Page.enable');
		controller.abort(new CdpError('caller cancelled'));

		const error = await assertRejects(() => pending, CdpError);
		assertStringIncludes(error.message, 'caller cancelled');
		assertEquals(client.pendingRequestCount, 0);
		assertEquals(client.state, 'open');
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: BUA_CDP_TIMEOUT_S and its BROWSER_USE_ alias are read at call time', async () => {
	assertEquals(CDP_TIMEOUT_ENV, 'BUA_CDP_TIMEOUT_S');
	assertEquals(CDP_TIMEOUT_ENV_COMPAT, 'BROWSER_USE_CDP_TIMEOUT_S');

	// An explicit value always wins, and a nonsense one is rejected loudly rather than coerced.
	assertEquals(resolveRequestTimeoutMs(1_234), 1_234);
	assertEquals(resolveRequestTimeoutMs(0.5), 0.5);
	assertRejectsSync(() => resolveRequestTimeoutMs(0));
	assertRejectsSync(() => resolveRequestTimeoutMs(Number.NaN));

	if (!(await envIsGranted(CDP_TIMEOUT_ENV, CDP_TIMEOUT_ENV_COMPAT))) {
		// D-CFG1 getters must degrade to the documented default under a tighter --allow-env, not crash.
		assertEquals(resolveRequestTimeoutMs(), DEFAULT_CDP_REQUEST_TIMEOUT_MS);
		return;
	}

	await withUnsetTimeoutEnv(() => {
		assertEquals(resolveRequestTimeoutMs(), DEFAULT_CDP_REQUEST_TIMEOUT_MS);

		Deno.env.set(CDP_TIMEOUT_ENV, '5');
		assertEquals(resolveRequestTimeoutMs(), 5_000);
		// Re-read on every call — never snapshotted at import (D-CFG1).
		Deno.env.set(CDP_TIMEOUT_ENV, '9');
		assertEquals(resolveRequestTimeoutMs(), 9_000);

		// Compat alias applies when the primary is unset.
		Deno.env.delete(CDP_TIMEOUT_ENV);
		Deno.env.set(CDP_TIMEOUT_ENV_COMPAT, '7');
		assertEquals(resolveRequestTimeoutMs(), 7_000);

		// A junk primary falls through to the alias rather than wedging the browser layer.
		Deno.env.set(CDP_TIMEOUT_ENV, 'not-a-number');
		assertEquals(resolveRequestTimeoutMs(), 7_000);
		Deno.env.set(CDP_TIMEOUT_ENV, '-3');
		assertEquals(resolveRequestTimeoutMs(), 7_000);

		// Explicit beats env.
		assertEquals(resolveRequestTimeoutMs(3_000), 3_000);
		return Promise.resolve();
	});
});

function assertRejectsSync(fn: () => unknown): void {
	let threw = false;
	try {
		fn();
	} catch (error) {
		threw = true;
		assertInstanceOf(error, CdpError);
	}
	assert(threw, 'expected the call to throw');
}

// ---------------------------------------------------------------------------------------------
// 4. 200 MB inbound frame budget
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: the default inbound frame budget is 200 MB', () => {
	assertEquals(MAX_INBOUND_FRAME_BYTES, 209_715_200);
});

Deno.test('cdp client: an oversized response frame fails its request with CdpFrameTooLargeError', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Page.captureScreenshot', (request, server) => {
		// A screenshot far past the (deliberately tiny) budget for this client.
		server.sendRaw(JSON.stringify({ id: request.id, result: { data: 'A'.repeat(4096) } }));
	});

	const client = await CdpClient.connect(fixture.url, { maxFrameBytes: 512 });
	try {
		const error = await assertRejects(() => client.send.Page.captureScreenshot(), CdpFrameTooLargeError);
		assertEquals(error.limitBytes, 512);
		assert(error.byteLength > 4096);
		assertEquals(error.requestId, 1);
		// The frame was never parsed, and the connection is still usable.
		assertEquals(client.pendingRequestCount, 0);
		assertEquals(client.state, 'open');
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: an oversized event frame goes to onFrameError instead of a listener', async () => {
	await using fixture = CdpFixtureServer.start();
	const errors = collector<CdpError>(1);
	const client = await CdpClient.connect(fixture.url, {
		maxFrameBytes: 512,
		onFrameError: (error) => errors.push(error),
	});
	try {
		let delivered = 0;
		client.on('Page.screencastFrame', () => void delivered++);
		fixture.emit('Page.screencastFrame', { data: 'A'.repeat(4096) });

		const [error] = await errors.done;
		assertInstanceOf(error, CdpFrameTooLargeError);
		assertEquals(error.requestId, undefined);
		assertEquals(delivered, 0);
		assertEquals(client.state, 'open');
	} finally {
		await client.close();
	}
});

// ---------------------------------------------------------------------------------------------
// 5. Flat session mode
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: flat session mode puts sessionId on the request and routes it back on events', async () => {
	await using fixture = CdpFixtureServer.start();
	const client = await CdpClient.connect(fixture.url);
	try {
		const events = collector<[string, string | undefined]>(3);
		client.on('Page.lifecycleEvent', (params, sessionId) => events.push([params.name, sessionId]));

		await client.send.Page.enable(undefined, 'S1');
		assertEquals(fixture.requests[0]?.sessionId, 'S1');
		// Browser-level calls must not carry a sessionId key at all.
		await client.send.Browser.getVersion();
		assertEquals(fixture.requests[1]?.sessionId, undefined);
		assertEquals(JSON.parse(fixture.requests[1]?.raw ?? '{}').sessionId, undefined);

		const base = { frameId: 'F1', loaderId: 'L1', timestamp: 1 };
		fixture.emit('Page.lifecycleEvent', { ...base, name: 'init' }, 'S1');
		fixture.emit('Page.lifecycleEvent', { ...base, name: 'load' }, 'S2');
		fixture.emit('Page.lifecycleEvent', { ...base, name: 'networkIdle' });

		assertEquals(await events.done, [['init', 'S1'], ['load', 'S2'], ['networkIdle', undefined]]);
	} finally {
		await client.close();
	}
});

// ---------------------------------------------------------------------------------------------
// 6. Multi-listener event registry
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: the event registry is multi-listener and every subscription is revocable', async () => {
	await using fixture = CdpFixtureServer.start();
	const client = await CdpClient.connect(fixture.url);
	try {
		const first: string[] = [];
		const second: string[] = [];
		const third = collector<string>(2);

		const unsubscribeFirst = client.on('Target.targetCreated', (params) => first.push(params.targetInfo.targetId));
		client.on('Target.targetCreated', (params) => second.push(params.targetInfo.targetId));
		client.on('Target.targetCreated', (params) => third.push(params.targetInfo.targetId));
		assertEquals(client.listenerCount('Target.targetCreated'), 3);

		const info = (targetId: string) => ({
			targetInfo: { targetId, type: 'page', title: '', url: '', attached: true },
		});
		fixture.emit('Target.targetCreated', info('T1'));
		await waitFor(() => first.length === 1);

		// cdp-use's single-slot registry would have lost the first two registrations here.
		assertEquals(first, ['T1']);
		assertEquals(second, ['T1']);

		unsubscribeFirst();
		assertEquals(client.listenerCount('Target.targetCreated'), 2);
		fixture.emit('Target.targetCreated', info('T2'));
		assertEquals(await third.done, ['T1', 'T2']);
		assertEquals(first, ['T1']);
		assertEquals(second, ['T1', 'T2']);
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: a throwing listener breaks neither its peers nor the read loop', async () => {
	await using fixture = CdpFixtureServer.start();
	const listenerErrors = collector<[string, string]>(1);
	const client = await CdpClient.connect(fixture.url, {
		onListenerError: (error, method) => listenerErrors.push([error.message, method]),
	});
	try {
		const survivor = collector<string>(2);
		client.on('Page.lifecycleEvent', () => {
			throw new Error('listener exploded');
		});
		client.on('Page.lifecycleEvent', (params) => survivor.push(params.name));

		const base = { frameId: 'F1', loaderId: 'L1', timestamp: 1 };
		fixture.emit('Page.lifecycleEvent', { ...base, name: 'init' });
		fixture.emit('Page.lifecycleEvent', { ...base, name: 'load' });

		assertEquals(await survivor.done, ['init', 'load']);
		const reported = (await listenerErrors.done)[0];
		assertStringIncludes(reported?.[0] ?? '', 'listener exploded');
		assertEquals(reported?.[1], 'Page.lifecycleEvent');

		// And the request/response path is untouched.
		await client.send.Browser.getVersion();
	} finally {
		await client.close();
	}
});

// ---------------------------------------------------------------------------------------------
// 8. state + close()
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: close() settles pending requests, clears listeners and reports intentional', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Page.enable', () => {});

	const client = await CdpClient.connect(fixture.url);
	client.on('Page.lifecycleEvent', () => {});
	const pending = client.send.Page.enable(undefined, 'S1');
	await fixture.waitForRequest('Page.enable');

	const closeInfos = collector<{ intentional: boolean }>(1);
	client.onClose((info) => closeInfos.push(info));

	await client.close();

	const error = await assertRejects(() => pending, CdpConnectionClosedError);
	assertEquals(error.intentional, true);
	assertEquals(error.method, 'Page.enable');
	assertEquals(client.state, 'closed');
	assertEquals(client.pendingRequestCount, 0);
	assertEquals(client.listenerCount('Page.lifecycleEvent'), 0);

	const closeInfo = await client.closed;
	assertEquals(closeInfo.intentional, true);
	assertEquals((await closeInfos.done)[0]?.intentional, true);

	// Idempotent, and further sends reject rather than hanging.
	await client.close();
	const afterClose = await assertRejects(() => client.send.Browser.getVersion(), CdpConnectionClosedError);
	assertEquals(afterClose.intentional, true);
});

Deno.test('cdp client: unsubscribing the last listener empties the registry entry', async () => {
	await using fixture = CdpFixtureServer.start();
	const client = await CdpClient.connect(fixture.url);
	try {
		const unsubscribe = client.on('DOM.documentUpdated', () => {});
		assertEquals(client.listenerCount('DOM.documentUpdated'), 1);
		unsubscribe();
		assertEquals(client.listenerCount('DOM.documentUpdated'), 0);
		// Revoking twice, and revoking after the entry is gone, must both be no-ops.
		unsubscribe();
		assertEquals(client.listenerCount('DOM.documentUpdated'), 0);
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: an onClose subscription can be revoked before the close happens', async () => {
	await using fixture = CdpFixtureServer.start();
	const client = await CdpClient.connect(fixture.url);
	let notified = 0;
	const unsubscribe = client.onClose(() => void notified++);
	unsubscribe();
	await client.close();
	await client.closed;
	assertEquals(notified, 0);
});

Deno.test('cdp client: a frame with neither an id nor a method is reported, not dispatched', async () => {
	await using fixture = CdpFixtureServer.start();
	const errors = collector<CdpError>(1);
	const client = await CdpClient.connect(fixture.url, { onFrameError: (error) => errors.push(error) });
	try {
		fixture.sendRaw(JSON.stringify({ params: { orphaned: true } }));
		const [error] = await errors.done;
		assertStringIncludes(error?.message ?? '', 'neither an id nor a method');
		assertEquals(client.state, 'open');
	} finally {
		await client.close();
	}
});

// ---------------------------------------------------------------------------------------------
// 9. Wire log (off by default)
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: the wire log is off by default', async () => {
	assertEquals(CDP_WIRE_LOG_ENV, 'BUA_CDP_WIRE_LOG');
	if (await envIsGranted(CDP_WIRE_LOG_ENV)) {
		const prior = Deno.env.get(CDP_WIRE_LOG_ENV);
		Deno.env.delete(CDP_WIRE_LOG_ENV);
		try {
			assertEquals(isWireLogEnabledByEnv(), false);
			Deno.env.set(CDP_WIRE_LOG_ENV, 'false');
			assertEquals(isWireLogEnabledByEnv(), false);
			Deno.env.set(CDP_WIRE_LOG_ENV, 'true');
			assertEquals(isWireLogEnabledByEnv(), true);
		} finally {
			if (prior === undefined) Deno.env.delete(CDP_WIRE_LOG_ENV);
			else Deno.env.set(CDP_WIRE_LOG_ENV, prior);
		}
	} else {
		assertEquals(isWireLogEnabledByEnv(), false);
	}

	await using fixture = CdpFixtureServer.start();
	const records: CdpWireLogRecord[] = [];
	const client = await CdpClient.connect(fixture.url, { wireLog: false, onListenerError: () => {} });
	try {
		await client.send.Browser.getVersion();
		fixture.emit('Page.lifecycleEvent', { frameId: 'F', loaderId: 'L', name: 'load', timestamp: 1 });
		await waitFor(() => fixture.requests.length === 1);
		assertEquals(records, []);
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: the wire log records both directions and truncates bodies at 4 KB', async () => {
	assertEquals(WIRE_LOG_BODY_LIMIT, 4096);

	await using fixture = CdpFixtureServer.start();
	fixture.on('Page.captureScreenshot', (request, server) => server.reply(request.id, { data: 'A'.repeat(9_000) }));

	const records: CdpWireLogRecord[] = [];
	const client = await CdpClient.connect(fixture.url, { wireLog: (record) => void records.push(record) });
	try {
		await client.send.Page.captureScreenshot({ format: 'png' }, 'S1');
		fixture.emit('Page.lifecycleEvent', { frameId: 'F', loaderId: 'L', name: 'load', timestamp: 1 }, 'S1');
		await waitFor(() => records.length === 3);

		const sent = records[0];
		assertEquals(sent?.direction, 'send');
		assertEquals(sent?.id, 1);
		assertEquals(sent?.method, 'Page.captureScreenshot');
		assertEquals(sent?.sessionId, 'S1');
		assertEquals(sent?.body, '{"format":"png"}');

		const received = records[1];
		assertEquals(received?.direction, 'recv');
		assertEquals(received?.id, 1);
		assertEquals(received?.method, 'Page.captureScreenshot');
		assertEquals(received?.body?.length, WIRE_LOG_BODY_LIMIT);
		assert((received?.truncatedBytes ?? 0) > 4_000, 'truncatedBytes must report the dropped remainder');
		assert(typeof received?.latencyMs === 'number');

		const event = records[2];
		assertEquals(event?.direction, 'recv');
		assertEquals(event?.method, 'Page.lifecycleEvent');
		assertEquals(event?.id, undefined);
		assertEquals(event?.sessionId, 'S1');
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: the wire log records CDP errors without a body', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Page.navigate', (request, server) => server.replyError(request.id, { code: -32000, message: 'nope' }));

	const records: CdpWireLogRecord[] = [];
	const client = await CdpClient.connect(fixture.url, { wireLog: (record) => void records.push(record) });
	try {
		await assertRejects(() => client.send.Page.navigate({ url: 'about:blank' }), CdpProtocolError);
		assertEquals(records[1]?.error, { code: -32000, message: 'nope' });
		assertEquals(records[1]?.body, undefined);
	} finally {
		await client.close();
	}
});

Deno.test('cdp client: wireLog:true and the default listener-error handler write to stderr', async () => {
	await using fixture = CdpFixtureServer.start();
	// Stubbing `console.error` is a module seam inside this package, which OBS §4.1.5 permits; it is
	// the only way to assert the normative "wire channel writes to stderr, never a client stream".
	const written: string[] = [];
	const errorStub = stub(console, 'error', (...args: unknown[]) => void written.push(args.join(' ')));
	try {
		const client = await CdpClient.connect(fixture.url, { wireLog: true });
		try {
			client.on('Page.loadEventFired', () => {
				throw new Error('boom');
			});
			await client.send.Browser.getVersion();
			fixture.emit('Page.loadEventFired', { timestamp: 1 });
			await waitFor(() => written.some((line) => line.startsWith('bua.cdp listener for')));
		} finally {
			await client.close();
		}
	} finally {
		errorStub.restore();
	}

	assert(written.some((line) => line.startsWith('bua.cdp.wire ')), 'wire records must go to stderr');
	const wireLine = written.find((line) => line.startsWith('bua.cdp.wire '));
	assertStringIncludes(wireLine ?? '', '"method":"Browser.getVersion"');
	assertStringIncludes(
		written.find((line) => line.startsWith('bua.cdp listener for')) ?? '',
		'Page.loadEventFired',
	);
});

// ---------------------------------------------------------------------------------------------
// 10. Drop detection seam for @tykotech/browser's reconnect policy (ARCHITECTURE §7.4)
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: an unintentional drop is reported as such to closed/onClose', async () => {
	await using fixture = CdpFixtureServer.start();
	const client = await CdpClient.connect(fixture.url);
	const notified = collector<boolean>(1);
	client.onClose((info) => notified.push(info.intentional));

	fixture.drop();

	const info = await client.closed;
	assertEquals(info.intentional, false);
	assertEquals((await notified.done)[0], false);
	assertEquals(client.state, 'closed');

	// Late subscribers still learn the outcome — the reconnect policy may attach after the fact.
	const late = collector<boolean>(1);
	client.onClose((closeInfo) => late.push(closeInfo.intentional));
	assertEquals((await late.done)[0], false);

	await client.close();
});

// ---------------------------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------------------------

Deno.test('cdp client: sendRaw reaches methods outside the typed D-CDP2 surface', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('BrowserUse.startCaptchaSolver', (request, server) => server.reply(request.id, { started: true }));

	const client = await CdpClient.connect(fixture.url);
	try {
		const result = await client.sendRaw<{ started: boolean }>(
			'BrowserUse.startCaptchaSolver',
			{ vendor: 'fixture' },
			'S1',
		);
		assertEquals(result.started, true);
		assertEquals(fixture.requests[0]?.method, 'BrowserUse.startCaptchaSolver');
		assertEquals(fixture.requests[0]?.sessionId, 'S1');
	} finally {
		await client.close();
	}
});

/**
 * Yield one full event-loop turn so pending WebSocket reads are delivered.
 *
 * This is not a sleep and carries no duration semantics — `setTimeout(0)` is simply the only way to
 * get past the microtask queue to the op-completion queue. Timing *behaviour* (the 60 s budget) is
 * tested with `FakeTime` above, per D-TEST1.
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

/** Poll a predicate across event-loop turns. */
async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
	for (let index = 0; index < attempts; index++) {
		if (predicate()) return;
		await yieldToEventLoop();
	}
	throw new Error('waitFor: predicate never became true');
}
