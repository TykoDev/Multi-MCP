/** The SSE event transport's controls. */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Hono } from 'hono';
import { type SessionRecord, SessionRegistry } from '@tykotech/mcp';
import { loadConfig } from './config.ts';
import type { AppVariables } from './app.ts';
import type { Principal } from './auth.ts';
import {
	attachEventStream,
	EVENT_STREAM_LIFETIME_MS,
	EventStreamRegistry,
	MAX_CONNECTIONS_PER_PRINCIPAL,
	MAX_EVENT_STREAMS_PER_SESSION,
	parseKinds,
} from './eventstream.ts';
import { EVENT_KINDS } from '@tykotech/wire';
import { fakeSession, quiet } from './support_test.ts';

const INVOKER: Principal = { kind: 'api-key', id: 'worker-1', scopes: new Set(['mcp:invoke']) };
const WATCHER: Principal = { kind: 'api-key', id: 'human-1', scopes: new Set(['view:watch', 'view:control']) };
const EVENTS = '/api/v1/sessions/default/events';

interface Rig {
	fetch(path: string, principal?: Principal | null): Promise<Response>;
	open(path?: string): Promise<Sse>;
	registry: SessionRegistry;
	streams: EventStreamRegistry;
	record: SessionRecord;
	setNow(ms: number): void;
}

type RigOptions = {
	lifetimeMs?: number;
	keepAliveMs?: number;
	revalidateMs?: number;
	scopesNow?: (principal: Principal) => ReadonlySet<string> | null;
	producing?: ReadonlySet<string>;
};

/** Runs `body` against the route over a registry holding the `default` session. */
async function withRig(options: RigOptions, body: (r: Rig) => Promise<void>): Promise<void> {
	let now = 1_760_000_000_000;
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	const streams = new EventStreamRegistry();
	const app = new Hono<{ Variables: AppVariables }>();
	let current: Principal | null = INVOKER;
	app.use('*', async (c, next) => {
		c.set('requestId', 'req-test');
		if (current !== null) c.set('principal', current);
		await next();
	});
	attachEventStream({
		app,
		registry,
		streams,
		logger: quiet(),
		config: loadConfig({ TTK_LOG_LEVEL: 'error' }),
		now: () => now,
		lifetimeMs: options.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS,
		keepAliveMs: options.keepAliveMs ?? 40,
		revalidateMs: options.revalidateMs ?? 300_000,
		...(options.scopesNow === undefined ? {} : { scopesNow: options.scopesNow }),
		...(options.producing === undefined ? {} : { producing: options.producing }),
	});
	const fetch = async (path: string, principal: Principal | null = INVOKER) => {
		current = principal;
		return await app.fetch(new Request(`http://gateway.test${path}`));
	};
	try {
		await body({
			fetch,
			open: async (path = EVENTS) => new Sse(await fetch(path)),
			registry,
			streams,
			record: await registry.resolve(undefined),
			setNow: (ms) => (now = ms),
		});
	} finally {
		await registry.shutdown('server-shutdown');
	}
}

/** One held reader over an SSE body: releasing it between reads would cancel the stream. */
class Sse {
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	readonly #decoder = new TextDecoder();
	text = '';

	constructor(readonly response: Response) {
		this.#reader = response.body!.getReader();
	}

	/** Reads until `wanted` appears, the stream ends, or `limit` chunks pass. */
	async until(wanted: string, limit = 40): Promise<string> {
		for (let i = 0; i < limit && !this.text.includes(wanted); i++) {
			const { value, done } = await this.#reader.read();
			if (value !== undefined) this.text += this.#decoder.decode(value, { stream: true });
			if (done) break;
		}
		return this.text;
	}

	/** The client going away — the stream's own `cancel()`, never `request.signal`. */
	async close(): Promise<void> {
		await this.#reader.cancel().catch(() => {});
	}
}

async function statusOf(response: Response): Promise<number> {
	await response.body?.cancel();
	return response.status;
}

Deno.test('sse: the stream takes mcp:invoke; view:watch, a query ticket, no principal and an unknown session are refused', async () => {
	await withRig({}, async (r) => {
		const denied = await r.fetch(EVENTS, WATCHER);
		const body = await denied.json();
		// The stream carries page content: watching a browser is permission to see pixels, not to read the page.
		assertEquals(denied.status, 403);
		assertStringIncludes(String(body.type), 'forbidden-scope');
		assertStringIncludes(String(body.detail), 'mcp:invoke');
		// A credential in a query string ends up in logs, so there is no ticket path at all.
		assertEquals(await statusOf(await r.fetch(`${EVENTS}?ticket=anything`, WATCHER)), 403);
		assertEquals(await statusOf(await r.fetch(EVENTS, null)), 401);
		assertEquals(await statusOf(await r.fetch('/api/v1/sessions/nope/events')), 404);
		const allowed = await r.fetch(EVENTS);
		assertEquals(allowed.headers.get('content-type'), 'text/event-stream; charset=utf-8');
		// A compressed or proxy-buffered event stream stalls.
		assertStringIncludes(allowed.headers.get('cache-control') ?? '', 'no-transform');
		assertEquals(allowed.headers.get('x-accel-buffering'), 'no');
		for (const header of ['authorization', 'set-cookie']) assertEquals(allowed.headers.get(header), null);
		const sse = new Sse(allowed);
		assert(!(await sse.until('stream-open')).toLowerCase().includes('bearer'), 'no credential on the stream');
		await sse.close();
	});
});

Deno.test('sse: the per-session and per-principal caps are their own, apart from the viewer seats; cancel frees a seat', async () => {
	await withRig({}, async (r) => {
		const open: Response[] = [];
		for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) {
			const response = await r.fetch(EVENTS);
			assertEquals(response.status, 200, `stream ${i}`);
			open.push(response);
		}
		const refused = await r.fetch(EVENTS);
		assertEquals([refused.status, refused.headers.get('retry-after')], [429, '5']);
		assertStringIncludes(String((await refused.json()).type), 'rate-limited');
		assertEquals(r.record.viewers.size, 0, 'a stream is not a viewer');
		for (let i = 0; i < 4; i++) {
			r.registry.addViewer(r.record, {
				id: `v${i}`,
				mode: 'watch',
				principal: 'human',
				send: () => {},
				close: () => {},
			});
		}
		assertEquals(r.streams.countFor('default'), MAX_EVENT_STREAMS_PER_SESSION, 'a viewer is not a stream');
		await open[0]!.body?.cancel();
		assertEquals(r.streams.countFor('default'), MAX_EVENT_STREAMS_PER_SESSION - 1);
		open[0] = await r.fetch(EVENTS);
		assertEquals(open[0].status, 200, 'the freed seat is reusable');

		// 4 + 4 reaches the per-principal ceiling before a third session.
		const second = (await r.registry.createNew()).id;
		const third = (await r.registry.createNew()).id;
		for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) {
			open.push(await r.fetch(`/api/v1/sessions/${second}/events`));
		}
		assertEquals(r.streams.countForPrincipal(INVOKER.id), MAX_CONNECTIONS_PER_PRINCIPAL);
		const principalFull = await r.fetch(`/api/v1/sessions/${third}/events`);
		assertEquals(principalFull.status, 429);
		assertStringIncludes(String((await principalFull.json()).detail), 'per principal');
		for (const response of open) await response.body?.cancel();
	});
});

Deno.test('sse: live-view sockets and event streams share one per-principal ceiling, apart from the session budget', () => {
	const streams = new EventStreamRegistry();
	for (let i = 0; i < 4; i++) assertEquals(streams.admit(`s${i}`, 'p'), 'ok');
	for (let i = 0; i < 4; i++) assert(streams.admitPrincipal('p'), `socket ${i}`);
	assertEquals(streams.countForPrincipal('p'), MAX_CONNECTIONS_PER_PRINCIPAL);
	assertEquals(streams.admit('s9', 'p'), 'principal-full');
	assertEquals(streams.admitPrincipal('p'), false);
	assertEquals(streams.admit('s0', 'other'), 'ok', 'per principal, not global');
	// Released at zero, the entry is deleted: the map is bounded by construction.
	const fresh = new EventStreamRegistry();
	assert(fresh.admitPrincipal('p'));
	fresh.releasePrincipal('p');
	assertEquals(fresh.countForPrincipal('p'), 0);
	for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) assertEquals(fresh.admit('s', `p${i}`), 'ok');
	assertEquals(fresh.admit('s', 'p9'), 'session-full', 'the session budget binds across principals');
});

Deno.test('sse: the lifetime cap ends a stream with stream-expired, read or not', async () => {
	// A long-lived stream is a cached authorization decision.
	await withRig({ lifetimeMs: 1 }, async (r) => {
		const sse = await r.open();
		r.setNow(1_760_000_100_000);
		const text = await sse.until('"stream-expired"');
		assertStringIncludes(text, 'event: bye');
		assertStringIncludes(text, '"reason":"stream-expired"');
		await sse.close();
	});
	// `pull` runs only while the consumer drains, so the cap must not depend on it.
	await withRig({ lifetimeMs: 20 }, async (r) => {
		const response = await r.fetch(EVENTS);
		assertEquals(r.streams.countFor('default'), 1);
		await new Promise((resolve) => setTimeout(resolve, 120));
		assertEquals([r.streams.countFor('default'), r.streams.countForPrincipal(INVOKER.id)], [0, 0]);
		await response.body?.cancel().catch(() => {});
	});
});

Deno.test('sse: a stream states its epoch first, frames each record on one data line, and never ids a synthesized frame', async () => {
	await withRig({}, async (r) => {
		const sse = await r.open();
		const opened = await sse.until('stream-open');
		for (
			const part of [
				'retry: 2000',
				'event: control',
				'"event":"stream-open"',
				`"epoch":"${r.record.events.epoch}"`,
				'"seq":0',
			]
		) {
			assertStringIncludes(opened, part);
		}
		assert(!opened.slice(0, opened.indexOf('event: control')).includes('id: '), 'a synthesized frame carries no id');
		r.record.events.append('dialog', { dialog_id: 'd1', kind: 'alert', message: 'line one\nline two\ttabbed' });
		const text = await sse.until('event: dialog');
		for (const line of text.split('\n').filter((l) => l.startsWith('data: '))) JSON.parse(line.slice(6));
		assertStringIncludes(text, '\\nline two', 'the newline survives escaped and never splits the frame');
		await sse.close();

		// Reconnecting behind the mark with an unknown kind: only replayed ring records carry ids.
		for (let i = 0; i < 4; i++) r.record.events.append('tab', { action: 'opened' });
		const replay = await r.open(`${EVENTS}?since=${r.record.events.epoch}:1&kinds=tab,nope`);
		const ids = [...(await replay.until('event: tab')).matchAll(/^id: (.+)$/gm)].map((m) =>
			Number(m[1]!.split(':')[1])
		);
		assert(ids.length > 0 && ids.every((seq) => seq <= 5), `ids ${ids}`);
		await replay.close();
	});
});

Deno.test('sse: another epoch gaps with dropped null; a same-epoch cursor above the mark waits', async () => {
	await withRig({ keepAliveMs: 20 }, async (r) => {
		r.record.events.append('tab', { action: 'opened' });
		const old = await r.open(`${EVENTS}?since=OLDEPOCH:1`);
		const gap = await old.until('event: gap');
		assertStringIncludes(gap, '"reason":"epoch-changed"');
		assertStringIncludes(gap, '"dropped":null', 'null, not zero: the previous ring is gone');
		await old.close();
		const ahead = await r.open(`${EVENTS}?since=${r.record.events.epoch}:99`);
		const text = await ahead.until('keep-alive');
		assertStringIncludes(text, ': keep-alive');
		assert(!text.includes('event: gap'), 'nothing since is not a gap');
		await ahead.close();
	});
});

Deno.test('sse: kinds — an unknown or unproduced kind is answered, console arms only when asked, a hostile list is bounded', async () => {
	await withRig({ producing: new Set(['console', 'navigation']) }, async (r) => {
		const unknown = await r.open(`${EVENTS}?kinds=navigation,not-a-kind`);
		const text = await unknown.until('kind-unavailable');
		assertStringIncludes(text, '"event":"kind-unavailable"');
		assertStringIncludes(text, '"kind":"not-a-kind"');
		await unknown.close();
		for (const path of [EVENTS, `${EVENTS}?kinds=navigation`]) {
			const quietStream = await r.open(path);
			await quietStream.until('stream-open');
			assertEquals(r.record.events.consoleSubscribers, 0, `${path} arms nothing`);
			await quietStream.close();
		}
		const consoleStream = await r.open(`${EVENTS}?kinds=console`);
		await consoleStream.until('stream-open');
		assertEquals(r.record.events.consoleSubscribers, 1);
		await consoleStream.close();
		assertEquals(r.record.events.consoleSubscribers, 0, 'cancel() is the disarm path');
	});
	// Claiming coverage nothing can mint would make the silence that follows read as "the page was quiet".
	await withRig({ producing: new Set(['navigation']) }, async (r) => {
		const sse = await r.open(`${EVENTS}?kinds=console`);
		const text = await sse.until('kind-unavailable');
		assertStringIncludes(text, '"kind":"console"');
		assert(!text.includes('console-armed'));
		assertEquals(r.record.events.consoleSubscribers, 0);
		await sse.close();
	});
	const available = new Set<string>(EVENT_KINDS);
	assertEquals(parseKinds(undefined, available), { filter: undefined, unavailable: [] });
	const parsed = parseKinds('navigation, dialog ,bogus,bogus', available);
	assertEquals([[...parsed.filter!].sort(), parsed.unavailable], [['dialog', 'navigation'], ['bogus']]);
	// A 64 KB query must not stall the event loop or be echoed back whole.
	const started = performance.now();
	const hostile = parseKinds(Array.from({ length: 20_000 }, (_, i) => `k${i}`).join(','), available);
	assert(performance.now() - started < 50);
	assert(hostile.unavailable.length <= 8 && hostile.unavailable.every((entry) => entry.length <= 64));
	assertEquals(parseKinds('x'.repeat(50_000), available).unavailable.map((entry) => entry.length), [64]);
});

Deno.test('sse: a stream re-earns its authority — a lapsed or narrowed credential ends it, at once on revalidateAll', async () => {
	let authorized = true;
	await withRig({ revalidateMs: 1, scopesNow: () => authorized ? new Set(['mcp:invoke']) : null }, async (r) => {
		const sse = await r.open();
		await sse.until('stream-open');
		authorized = false;
		r.setNow(1_760_000_010_000);
		assertStringIncludes(await sse.until('stream-expired'), '"reason":"stream-expired"');
		await sse.close();
	});
	// The credential still exists but no longer holds the scope the stream was opened under.
	let held: ReadonlySet<string> | null = new Set(['mcp:invoke']);
	await withRig({ revalidateMs: 3_600_000, scopesNow: () => held }, async (r) => {
		const sse = await r.open();
		await sse.until('stream-open');
		r.streams.revalidateAll();
		assertEquals(r.streams.size, 1, 'a re-check that finds the scope changes nothing');
		held = new Set(['view:watch']);
		r.streams.revalidateAll();
		assertStringIncludes(await sse.until('stream-expired'), '"reason":"stream-expired"');
		assertEquals([r.streams.size, r.streams.countForPrincipal(INVOKER.id)], [0, 0]);
		held = new Set(['mcp:invoke']);
		const again = await r.open();
		await again.until('stream-open');
		held = null;
		r.streams.revalidateAll();
		assertStringIncludes(await again.until('stream-expired'), '"reason":"stream-expired"');
	});
});

Deno.test('sse: shutdown and a closed session end open streams with a bye rather than stranding them', async () => {
	await withRig({}, async (r) => {
		const sse = await r.open();
		await sse.until('stream-open');
		assertEquals(r.streams.size, 1);
		r.streams.closeAll('server-shutdown');
		const text = await sse.until('server-shutdown');
		assertStringIncludes(text, 'event: bye');
		assertStringIncludes(text, '"reason":"server-shutdown"');
		assertEquals(r.streams.size, 0);
		const second = await r.open();
		await second.until('stream-open');
		await r.registry.close(r.record.id, 'session-closed');
		assertStringIncludes(await second.until('session-closed'), 'event: bye');
	});
});
