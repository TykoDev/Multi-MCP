/** `browser_health` — the counts, the `degraded` state, and the promise that a poll costs nothing. */
import { assert, assertEquals } from '@std/assert';
import { blankSession } from '../fixtures/capture_session.ts';
import { OUTPUT } from './schemas.ts';
import { DEFAULT_SESSION_ID, SessionRegistry } from './registry.ts';
import { browserHealth, HEALTH_PROBE_TIMEOUT_MS } from './tools/session.ts';
import type { ToolContext } from './types.ts';

const fakeSession = () =>
	blankSession({ tabs: [{ tabId: 'aaaa', targetId: 'aaaa', url: 'https://example.com/', title: 'Example' }] }) as
		& ReturnType<typeof blankSession>
		& { cdpClient: unknown };

function ctxFor(registry: SessionRegistry, capabilities?: ToolContext['capabilities']): ToolContext {
	return {
		registry,
		allowedDomains: [],
		principal: 'test',
		...(capabilities === undefined ? {} : { capabilities }),
	};
}

async function payloadOf(ctx: ToolContext): Promise<Record<string, unknown>> {
	const result = await browserHealth({}, ctx);
	const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
	assert(structured !== undefined, 'browser_health returned no structuredContent');
	return OUTPUT.browser_health.parse(structured) as unknown as Record<string, unknown>;
}

Deno.test('browser_health: an empty server is ok with zero counts, and mints nothing', async () => {
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => {
			throw new Error('browser_health must never launch a browser');
		},
	});
	try {
		const payload = await payloadOf(ctxFor(registry));
		assertEquals(payload.status, 'ok');
		assertEquals(payload.sessions, {
			total: 0,
			browser_ok: 0,
			browser_unresponsive: 0,
			human_has_control: 0,
			viewers: 0,
			tabs: 0,
		});
		assertEquals(registry.size, 0);
	} finally {
		await registry.shutdown();
	}
});

/**
 * A CDP client stand-in that answers `Browser.getVersion` the way the test says: in time, with an error, or never.
 */
function versionClient(answer: 'ok' | 'error' | 'hang', sent: unknown[] = []) {
	return {
		send: {
			Browser: {
				getVersion(_params: unknown, _sessionId: unknown, options: unknown) {
					sent.push(options);
					if (answer === 'ok') return Promise.resolve({ product: 'Chrome/140', protocolVersion: '1.3' });
					if (answer === 'error') return Promise.reject(new Error('Target closed'));
					return new Promise(() => {});
				},
			},
		},
	};
}

Deno.test('browser_health: counts sessions, tabs and browsers that answered the probe', async () => {
	const sessions: Array<{ cdpClient: unknown }> = [];
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => {
			const session = fakeSession();
			sessions.push(session);
			return Promise.resolve(session);
		},
	});
	try {
		await registry.resolve(DEFAULT_SESSION_ID);
		await registry.createNew('second');
		const sent: unknown[] = [];
		for (const session of sessions) session.cdpClient = versionClient('ok', sent);
		const payload = await payloadOf(ctxFor(registry));
		assertEquals(payload.status, 'ok');
		assertEquals(payload.sessions, {
			total: 2,
			browser_ok: 2,
			browser_unresponsive: 0,
			human_has_control: 0,
			viewers: 0,
			tabs: 2,
		});
		assertEquals(sent, [{ requestTimeoutMs: HEALTH_PROBE_TIMEOUT_MS }, { requestTimeoutMs: HEALTH_PROBE_TIMEOUT_MS }]);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('browser_health: a connected browser that does not answer is unresponsive, in parallel, never launched', async () => {
	const sessions: Array<{ cdpClient: unknown }> = [];
	let launches = 0;
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => {
			launches += 1;
			const session = fakeSession();
			sessions.push(session);
			return Promise.resolve(session);
		},
	});
	try {
		await registry.resolve(DEFAULT_SESSION_ID);
		await registry.createNew('wedged');
		await registry.createNew('erroring');
		const [healthy, wedged, erroring] = sessions;
		assert(healthy !== undefined && wedged !== undefined && erroring !== undefined);
		healthy.cdpClient = versionClient('ok');
		wedged.cdpClient = versionClient('hang');
		erroring.cdpClient = versionClient('error');
		const started = performance.now();
		const payload = await payloadOf(ctxFor(registry));
		const elapsed = performance.now() - started;
		assertEquals(payload.status, 'degraded', 'a wedged Chromium does not report healthy');
		const counts = payload.sessions as Record<string, number>;
		assertEquals(counts.total, 3);
		assertEquals(counts.browser_ok, 1);
		assertEquals(counts.browser_unresponsive, 2, 'both the hung and the erroring browser');
		assert(elapsed >= HEALTH_PROBE_TIMEOUT_MS - 50, `returned before the probe deadline (${elapsed} ms)`);
		assert(elapsed < HEALTH_PROBE_TIMEOUT_MS * 2, `the probes ran one after another (${elapsed} ms)`);
		assertEquals(launches, 3, 'the poll itself launched nothing');
	} finally {
		await registry.shutdown();
	}
});

Deno.test('browser_health: a session with no CDP client makes the server degraded', async () => {
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve(fakeSession()),
	});
	try {
		await registry.resolve(DEFAULT_SESSION_ID);
		const payload = await payloadOf(ctxFor(registry));
		assertEquals(payload.status, 'degraded');
		assertEquals((payload.sessions as { browser_ok: number }).browser_ok, 0);
		assertEquals((payload.sessions as { total: number }).total, 1);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('browser_health: carries the capabilities block it was given, unchanged', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	try {
		const capabilities = { version: '9.9.9-test', state_token: { version: 'v1', indices_stable: true } } as const;
		const payload = await payloadOf(ctxFor(registry, capabilities));
		assertEquals(payload.version, '9.9.9-test');
		assertEquals(payload.capabilities, capabilities);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('browser_health: a handler driven with no capabilities reports a null version, never a guess', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	try {
		const payload = await payloadOf(ctxFor(registry));
		assertEquals(payload.version, null);
		assert(!Object.hasOwn(payload, 'capabilities'), 'an absent block must be absent, not an empty object');
	} finally {
		await registry.shutdown();
	}
});
