/**
 * Capture-side units: the `getEventListeners` census payload and the pending-network probe
 * (ARCHITECTURE §6.7).
 *
 * The probe is exercised against a **real** `CdpClient` over a **real** loopback WebSocket served by
 * `Deno.serve` + `Deno.upgradeWebSocket`. Nothing is mocked: the fixture server pushes genuine CDP
 * event frames, which is exactly what a browser does (D-TEST1 — fixtures are real servers).
 *
 * `FakeTime` is deliberately not used here. The probe's timers are entangled with live socket I/O, and
 * a faked clock stops the runtime turning the frames over, which would test the harness rather than the
 * probe. The *durations* are asserted as constants in `extract_test.ts`; this file compresses them via
 * the documented `maxMs`/`stableMs` overrides so it stays sub-second.
 */

import { assert, assertEquals, assertGreater, assertGreaterOrEqual, assertLess } from '@std/assert';
import { CdpClient } from '@tykotech/cdp';
import {
	CLICK_LISTENER_TYPES,
	findOopifFrameIds,
	isFrameElement,
	LISTENER_CENSUS_MAX_ELEMENTS,
	LISTENER_CENSUS_MAX_LISTENERS,
	listenerCensusExpression,
	parseListenerCensus,
	waitForNetworkStability,
} from './extract_capture.ts';

// ---------------------------------------------------------------------------
// census payload
// ---------------------------------------------------------------------------

Deno.test('dom-capture: the census expression carries both caps and the click-initiating types', () => {
	const expression = listenerCensusExpression();
	assert(expression.includes(String(LISTENER_CENSUS_MAX_ELEMENTS)), 'element cap missing');
	assert(expression.includes(String(LISTENER_CENSUS_MAX_LISTENERS)), 'listener cap missing');
	for (const type of CLICK_LISTENER_TYPES) {
		assert(expression.includes(`"${type}"`), `listener type ${type} missing`);
	}
	// The element budget is shared across frames, so it is decremented, not reset per document.
	assert(expression.includes('budget -= limit'));
	// Inline handlers are not reported by `getEventListeners`, so they are probed separately.
	assert(expression.includes('el.onclick'));
	// Frames are walked by `contentDocument`, which is null for cross-origin children — those are
	// covered by their own session's census instead.
	assert(expression.includes('contentDocument'));

	const custom = listenerCensusExpression(5, 3, ['click']);
	assert(custom.includes('const MAX_ELEMENTS = 5'));
	assert(custom.includes('const MAX_LISTENERS = 3'));
	assert(!custom.includes('"pointerdown"'));
});

Deno.test('dom-capture: the census payload parses defensively', () => {
	const good = parseListenerCensus(JSON.stringify({
		frames: [{ frame: '', total: 12, scanned: 12, hits: [3, 7] }, { frame: '0', total: 4, scanned: 4, hits: [] }],
		truncated: false,
	}));
	assertEquals(good?.frames.length, 2);
	assertEquals(good?.frames[0]?.hits, [3, 7]);
	assertEquals(good?.truncated, false);

	assertEquals(parseListenerCensus('not json'), null);
	assertEquals(parseListenerCensus('null'), null);
	assertEquals(parseListenerCensus('{"frames":"nope"}'), null);
	// A malformed frame entry is dropped; the rest of the census still counts.
	const partial = parseListenerCensus(JSON.stringify({
		frames: [{ frame: '', total: 'x', hits: [] }, { frame: '1', total: 2, hits: [0, 'y'] }],
		truncated: true,
	}));
	assertEquals(partial?.frames.length, 1);
	assertEquals(partial?.frames[0]?.hits, [0]);
	assertEquals(partial?.frames[0]?.scanned, 2, 'a missing scanned count defaults to total');
	assertEquals(partial?.truncated, true);
});

// ---------------------------------------------------------------------------
// OOPIF detection
// ---------------------------------------------------------------------------

Deno.test('dom-capture: an iframe with a frameId but no contentDocument is out-of-process', () => {
	assertEquals(isFrameElement('IFRAME'), true);
	assertEquals(isFrameElement('FRAME'), true);
	assertEquals(isFrameElement('iframe'), false, 'CDP reports HTML tag names uppercase');

	const document = {
		nodeId: 1,
		backendNodeId: 1,
		nodeType: 9,
		nodeName: '#document',
		localName: '',
		nodeValue: '',
		children: [
			{
				nodeId: 2,
				backendNodeId: 2,
				nodeType: 1,
				nodeName: 'IFRAME',
				localName: 'iframe',
				nodeValue: '',
				frameId: 'oopif-frame',
			},
			{
				nodeId: 3,
				backendNodeId: 3,
				nodeType: 1,
				nodeName: 'IFRAME',
				localName: 'iframe',
				nodeValue: '',
				frameId: 'inline-frame',
				contentDocument: {
					nodeId: 4,
					backendNodeId: 4,
					nodeType: 9,
					nodeName: '#document',
					localName: '',
					nodeValue: '',
					children: [
						{
							nodeId: 5,
							backendNodeId: 5,
							nodeType: 1,
							nodeName: 'IFRAME',
							localName: 'iframe',
							nodeValue: '',
							frameId: 'nested-oopif',
						},
					],
				},
			},
			// A `frameId` on a non-frame element (Chrome puts one on <html>) must not be mistaken for one.
			{ nodeId: 6, backendNodeId: 6, nodeType: 1, nodeName: 'HTML', localName: 'html', nodeValue: '', frameId: 'main' },
		],
	};
	assertEquals(findOopifFrameIds(document), ['oopif-frame', 'nested-oopif']);
});

// ---------------------------------------------------------------------------
// pending-network probe
// ---------------------------------------------------------------------------

/** A loopback CDP endpoint that pushes whatever event frames the test dictates. */
interface CdpFixture {
	readonly client: CdpClient;
	/** Push one CDP event frame down the socket. */
	emit(method: string, params: Record<string, unknown>, sessionId?: string): void;
	close(): Promise<void>;
}

async function startCdpFixture(): Promise<CdpFixture> {
	const controller = new AbortController();
	let socket: WebSocket | null = null;
	const opened = Promise.withResolvers<void>();
	const server = Deno.serve({
		hostname: '127.0.0.1',
		port: 0,
		signal: controller.signal,
		onListen: () => {},
	}, (request) => {
		const upgrade = Deno.upgradeWebSocket(request);
		socket = upgrade.socket;
		upgrade.socket.onopen = () => opened.resolve();
		return upgrade.response;
	});
	const port = (server.addr as Deno.NetAddr).port;
	const client = await CdpClient.connect(`ws://127.0.0.1:${port}/devtools/browser/test`);
	await opened.promise;
	return {
		client,
		emit: (method, params, sessionId) => {
			const frame: Record<string, unknown> = { method, params };
			if (sessionId !== undefined) frame.sessionId = sessionId;
			socket?.send(JSON.stringify(frame));
		},
		close: async () => {
			await client.close();
			controller.abort();
			await server.finished;
		},
	};
}

Deno.test('dom-capture: the probe settles after a full quiet window on an idle connection', async () => {
	const fixture = await startCdpFixture();
	try {
		const result = await waitForNetworkStability({
			client: fixture.client,
			maxMs: 1_000,
			stableMs: 80,
		});
		assertEquals(result.stable, true);
		assertEquals(result.pending, 0);
		assertGreaterOrEqual(result.waitedMs, 70);
		assertLess(result.waitedMs, 1_000);
	} finally {
		await fixture.close();
	}
});

Deno.test('dom-capture: an in-flight request restarts the quiet window and a finished one ends it', async () => {
	const fixture = await startCdpFixture();
	try {
		const pending = waitForNetworkStability({ client: fixture.client, maxMs: 2_000, stableMs: 120 });
		// Keep the connection busy past what one quiet window would have covered.
		fixture.emit('Network.requestWillBeSent', { requestId: 'r1' });
		await new Promise((resolve) => setTimeout(resolve, 60));
		fixture.emit('Network.requestWillBeSent', { requestId: 'r2' });
		await new Promise((resolve) => setTimeout(resolve, 60));
		fixture.emit('Network.loadingFinished', { requestId: 'r1' });
		await new Promise((resolve) => setTimeout(resolve, 60));
		// Still one request outstanding, so no quiet window can have completed yet.
		fixture.emit('Network.loadingFailed', { requestId: 'r2' });

		const result = await pending;
		assertEquals(result.stable, true);
		assertEquals(result.pending, 0);
		assertGreater(result.waitedMs, 180, 'the window restarted rather than firing on the first lull');
	} finally {
		await fixture.close();
	}
});

Deno.test('dom-capture: the probe gives up at its cap and reports what is still in flight', async () => {
	const fixture = await startCdpFixture();
	try {
		const pending = waitForNetworkStability({ client: fixture.client, maxMs: 250, stableMs: 100 });
		fixture.emit('Network.requestWillBeSent', { requestId: 'never-finishes' });
		const result = await pending;
		assertEquals(result.stable, false, 'a page that never goes quiet must not block the build');
		assertEquals(result.pending, 1);
		assertGreaterOrEqual(result.waitedMs, 200);
	} finally {
		await fixture.close();
	}
});

Deno.test('dom-capture: the probe filters by sessionId and honours an abort signal', async () => {
	const fixture = await startCdpFixture();
	try {
		// Traffic on another session must not hold this session's probe open.
		const scoped = waitForNetworkStability({
			client: fixture.client,
			sessionId: 'session-a',
			maxMs: 2_000,
			stableMs: 100,
		});
		fixture.emit('Network.requestWillBeSent', { requestId: 'other' }, 'session-b');
		const result = await scoped;
		assertEquals(result.stable, true);
		assertEquals(result.pending, 0);

		const controller = new AbortController();
		const aborted = waitForNetworkStability({
			client: fixture.client,
			maxMs: 5_000,
			stableMs: 4_000,
			signal: controller.signal,
		});
		controller.abort();
		const abortedResult = await aborted;
		assertEquals(abortedResult.stable, false);
		assertLess(abortedResult.waitedMs, 1_000);

		// An already-aborted signal settles immediately and leaks no timer.
		const preAborted = await waitForNetworkStability({
			client: fixture.client,
			maxMs: 5_000,
			stableMs: 4_000,
			signal: AbortSignal.abort(),
		});
		assertEquals(preAborted.stable, false);
	} finally {
		await fixture.close();
	}
});

Deno.test('dom-capture: the probe unsubscribes every listener it registered', async () => {
	const fixture = await startCdpFixture();
	try {
		assertEquals(fixture.client.listenerCount('Network.requestWillBeSent'), 0);
		const pending = waitForNetworkStability({ client: fixture.client, maxMs: 300, stableMs: 50 });
		assertEquals(fixture.client.listenerCount('Network.requestWillBeSent'), 1);
		assertEquals(fixture.client.listenerCount('Network.loadingFinished'), 1);
		assertEquals(fixture.client.listenerCount('Network.loadingFailed'), 1);
		await pending;
		assertEquals(fixture.client.listenerCount('Network.requestWillBeSent'), 0);
		assertEquals(fixture.client.listenerCount('Network.loadingFinished'), 0);
		assertEquals(fixture.client.listenerCount('Network.loadingFailed'), 0);
	} finally {
		await fixture.close();
	}
});
