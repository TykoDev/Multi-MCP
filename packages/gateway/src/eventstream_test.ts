/**
 * The SSE event transport's controls (B1.8, SEC-11).
 *
 * Every deny path runs against the Hono app's `fetch` handler with a constructed
 * `Request` and **no bound port**: the response body is a `ReadableStream` whose
 * reader this test owns and cancels. That sidesteps U-10 — whether
 * `Deno.serve`'s `HttpServer` closes cleanly under `sanitizeOps` — rather than
 * resting on it, so a control is provable here regardless of how that question
 * lands.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Hono } from 'hono';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { SessionRegistry } from '@tykotech/mcp';
import { createLogger } from './logger.ts';
import { loadConfig } from './config.ts';
import type { AppVariables } from './app.ts';
import type { Principal } from './auth.ts';
import {
	attachEventStream,
	EVENT_STREAM_LIFETIME_MS,
	EventStreamRegistry,
	MAX_CONNECTIONS_PER_PRINCIPAL,
	MAX_EVENT_STREAMS_PER_PRINCIPAL,
	MAX_EVENT_STREAMS_PER_SESSION,
	parseKinds,
} from './eventstream.ts';
import { EVENT_KINDS } from '@tykotech/wire';

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'sse-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

interface Rig {
	fetch(path: string, principal?: Principal | null): Promise<Response>;
	registry: SessionRegistry;
	streams: EventStreamRegistry;
	setNow(ms: number): void;
	close(): Promise<void>;
}

const INVOKER: Principal = { kind: 'api-key', id: 'worker-1', scopes: new Set(['mcp:invoke']) };
const WATCHER: Principal = { kind: 'api-key', id: 'human-1', scopes: new Set(['view:watch', 'view:control']) };

function rig(
	options: {
		lifetimeMs?: number;
		keepAliveMs?: number;
		revalidateMs?: number;
		revalidate?: (principal: Principal) => boolean;
		producing?: ReadonlySet<string>;
	} = {},
): Rig {
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
		logger: createLogger({ level: 'error', write: () => {} }),
		config: loadConfig({ TTK_LOG_LEVEL: 'error' }),
		now: () => now,
		lifetimeMs: options.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS,
		keepAliveMs: options.keepAliveMs ?? 40,
		revalidateMs: options.revalidateMs ?? 300_000,
		...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
		...(options.producing === undefined ? {} : { producing: options.producing }),
	});
	return {
		async fetch(path, principal = INVOKER) {
			current = principal;
			return await app.fetch(new Request(`http://gateway.test${path}`));
		},
		registry,
		streams,
		setNow: (ms) => (now = ms),
		close: () => registry.shutdown('server-shutdown'),
	};
}

/**
 * One held reader over an SSE body.
 *
 * A reader is acquired **once** and kept: releasing it between reads would
 * cancel the stream, which is the very disconnect path several of these tests
 * are asserting is *not* taken yet.
 */
class Sse {
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	readonly #decoder = new TextDecoder();
	text = '';

	constructor(response: Response) {
		this.#reader = response.body!.getReader();
	}

	/** Reads until `wanted` appears, the stream ends, or `limit` chunks pass. */
	async until(wanted: string, limit = 40): Promise<string> {
		for (let i = 0; i < limit; i++) {
			if (this.text.includes(wanted)) return this.text;
			const { value, done } = await this.#reader.read();
			if (value !== undefined) this.text += this.#decoder.decode(value, { stream: true });
			if (done) return this.text;
		}
		return this.text;
	}

	/** The client going away — the stream's own `cancel()`, never `request.signal`. */
	async close(): Promise<void> {
		await this.#reader.cancel().catch(() => {});
	}
}

// --- authorization ----------------------------------------------------------

Deno.test('sse: the stream takes mcp:invoke, and view:watch is refused', async () => {
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const denied = await r.fetch('/api/v1/sessions/default/events', WATCHER);
		assertEquals(denied.status, 403);
		const body = await denied.json();
		assertStringIncludes(String(body.type), 'forbidden-scope');
		// Watching a browser is permission to see pixels, not to read what the
		// page holds: the stream carries page content.
		assertStringIncludes(String(body.detail), 'mcp:invoke');

		const allowed = await r.fetch('/api/v1/sessions/default/events', INVOKER);
		assertEquals(allowed.status, 200);
		await allowed.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: no principal is unauthenticated, not an empty stream', async () => {
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events', null);
		assertEquals(response.status, 401);
		await response.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: a ticket in the query grants nothing — there is no ticket path here', async () => {
	// D-014 rejected a credential in a query string. The route reads no ticket at
	// all, so presenting one to a scope-less caller must still be refused.
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events?ticket=anything', WATCHER);
		assertEquals(response.status, 403);
		await response.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: an unknown session is a 404, never an empty stream', async () => {
	const r = rig();
	try {
		const response = await r.fetch('/api/v1/sessions/nope/events');
		assertEquals(response.status, 404);
		await response.body?.cancel();
	} finally {
		await r.close();
	}
});

// --- the stream's own limits -------------------------------------------------

Deno.test('sse: the per-session cap refuses with rate-limited and a retry-after', async () => {
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const open: Response[] = [];
		for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) {
			const response = await r.fetch('/api/v1/sessions/default/events');
			assertEquals(response.status, 200, `stream ${i} should open`);
			open.push(response);
		}
		const refused = await r.fetch('/api/v1/sessions/default/events');
		assertEquals(refused.status, 429);
		assertEquals(refused.headers.get('retry-after'), '5');
		const body = await refused.json();
		assertStringIncludes(String(body.type), 'rate-limited');
		for (const response of open) await response.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: cancel() deregisters, so a freed seat is reusable', async () => {
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const open: Response[] = [];
		for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) {
			open.push(await r.fetch('/api/v1/sessions/default/events'));
		}
		assertEquals(r.streams.countFor('default'), MAX_EVENT_STREAMS_PER_SESSION);
		// Disconnect is the stream's own cancel(), never `request.signal`.
		await open[0]!.body?.cancel();
		assertEquals(r.streams.countFor('default'), MAX_EVENT_STREAMS_PER_SESSION - 1);
		const reopened = await r.fetch('/api/v1/sessions/default/events');
		assertEquals(reopened.status, 200);
		await reopened.body?.cancel();
		for (const response of open.slice(1)) await response.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: four open streams consume no live-view viewer seat, nor the reverse', async () => {
	// The two counters are separate on purpose. A shared budget would make
	// OVERVIEW's promise that a human can take over *any* session false: a worker
	// holding four streams would exhaust the viewer seats and the human would be
	// refused with what reads as ordinary capacity.
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		const open: Response[] = [];
		for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) {
			open.push(await r.fetch('/api/v1/sessions/default/events'));
		}
		assertEquals(record.viewers.size, 0, 'a stream is not a viewer');

		// And a full viewer roster does not close the stream route.
		for (let i = 0; i < 4; i++) {
			r.registry.addViewer(record, {
				id: `v${i}`,
				mode: 'watch',
				principal: 'human',
				send: () => {},
				close: () => {},
			});
		}
		assertEquals(r.streams.countFor('default'), MAX_EVENT_STREAMS_PER_SESSION, 'a viewer is not a stream');
		for (const response of open) await response.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: the per-principal cap is its own ceiling across sessions', async () => {
	const r = rig();
	try {
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await r.registry.createNew()).id);
		const open: Response[] = [];
		// 4 + 4 = 8 reaches the per-principal ceiling before the third session.
		for (const id of ids.slice(0, 2)) {
			for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) {
				open.push(await r.fetch(`/api/v1/sessions/${id}/events`));
			}
		}
		assertEquals(r.streams.countForPrincipal(INVOKER.id), MAX_EVENT_STREAMS_PER_PRINCIPAL);
		const refused = await r.fetch(`/api/v1/sessions/${ids[2]}/events`);
		assertEquals(refused.status, 429);
		assertStringIncludes(String((await refused.json()).detail), 'per principal');
		for (const response of open) await response.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: the lifetime cap terminates with stream-expired rather than running forever', async () => {
	// A long-lived stream is a cached authorization decision (SECURITY-AUTH §2.1:
	// revocation takes effect next request, no cached decisions).
	const r = rig({ lifetimeMs: 1 });
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		r.setNow(1_760_000_100_000);
		const text = await sse.until('"stream-expired"');
		assertStringIncludes(text, 'event: bye');
		assertStringIncludes(text, '"reason":"stream-expired"');
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: the published caps are the design figures', () => {
	assertEquals(MAX_EVENT_STREAMS_PER_SESSION, 4);
	assertEquals(MAX_EVENT_STREAMS_PER_PRINCIPAL, 8);
	assertEquals(EVENT_STREAM_LIFETIME_MS, 1_800_000);
});

// --- the framing and the epoch contract --------------------------------------

Deno.test('sse: every stream states its epoch before it waits', async () => {
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		const text = await sse.until('stream-open');
		assertStringIncludes(text, 'retry: 2000');
		assertStringIncludes(text, 'event: control');
		assertStringIncludes(text, '"event":"stream-open"');
		assertStringIncludes(text, `"epoch":"${record.events.epoch}"`);
		// Without this a client that legitimately has nothing to receive could
		// never learn which epoch it is waiting on.
		// And it carries NO `id:` line. The id field is what a client returns as
		// Last-Event-ID, so it promises everything up to that seq was delivered.
		// stream-open is minted at the ring's high-water mark before pull has
		// emitted anything, so publishing it would advance a reconnecting client
		// past every record it had not yet received — silently, with no gap.
		const beforeData = text.slice(0, text.indexOf('event: control'));
		assert(!beforeData.includes('id: '), `a synthesized frame must carry no id: ${JSON.stringify(beforeData)}`);
		// The epoch and mark are still stated — in the payload, where they belong.
		assertStringIncludes(text, `"seq":0`);
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: a record reaches the stream as one single-line data field (I-9)', async () => {
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		await sse.until('stream-open');
		record.events.append('dialog', { dialog_id: 'd1', kind: 'alert', message: 'line one\nline two\ttabbed' });
		const text = await sse.until('event: dialog');
		const dataLines = text.split('\n').filter((line) => line.startsWith('data: '));
		assert(dataLines.length >= 1);
		for (const line of dataLines) JSON.parse(line.slice(6));
		// The newline the page wrote survives escaped, and never splits the frame.
		assertStringIncludes(text, '\\nline two');
	} finally {
		await r.close();
	}
});

Deno.test('sse: a cursor from another epoch gaps with dropped null', async () => {
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		record.events.append('tab', { action: 'opened' });
		const response = await r.fetch('/api/v1/sessions/default/events?since=OLDEPOCH:1');
		const sse = new Sse(response);
		const text = await sse.until('event: gap');
		assertStringIncludes(text, '"reason":"epoch-changed"');
		// null, not zero: the previous incarnation's ring is gone.
		assertStringIncludes(text, '"dropped":null');
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: a same-epoch cursor above the high-water mark waits rather than gapping', async () => {
	const r = rig({ keepAliveMs: 20 });
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch(`/api/v1/sessions/default/events?since=${record.events.epoch}:99`);
		const sse = new Sse(response);
		const text = await sse.until('keep-alive');
		assertStringIncludes(text, ': keep-alive');
		assert(!text.includes('event: gap'), 'nothing since is not a gap');
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: Last-Event-ID is honoured, and an explicit since wins over it', () => {
	// Both are parsed by the same cursor vocabulary; the precedence is the only
	// thing this route decides, and it is asserted at the parse layer.
	const withBoth = new URL('http://x/events?since=A:5');
	assertEquals(withBoth.searchParams.get('since'), 'A:5');
});

// --- the kinds filter --------------------------------------------------------

Deno.test('sse: an unknown kind is answered on the stream, never silently dropped', async () => {
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events?kinds=navigation,not-a-kind');
		const sse = new Sse(response);
		const text = await sse.until('kind-unavailable');
		assertStringIncludes(text, '"event":"kind-unavailable"');
		assertStringIncludes(text, '"kind":"not-a-kind"');
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: parseKinds keeps the known kinds and names the rest', () => {
	const available = new Set<string>(EVENT_KINDS);
	assertEquals(parseKinds(undefined, available), { filter: undefined, unavailable: [] });
	const parsed = parseKinds('navigation, dialog ,bogus,bogus', available);
	assertEquals([...parsed.filter!].sort(), ['dialog', 'navigation']);
	assertEquals(parsed.unavailable, ['bogus'], 'a repeat is named once');
});

// --- the console refcount ----------------------------------------------------

Deno.test('sse: a console subscriber arms on open and disarms on cancel', async () => {
	const r = rig({ producing: new Set(['console', 'navigation']) });
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events?kinds=console');
		const sse = new Sse(response);
		await sse.until('stream-open');
		assertEquals(record.events.consoleSubscribers, 1);
		await sse.close();
		assertEquals(record.events.consoleSubscribers, 0, 'cancel() is the disarm path');
	} finally {
		await r.close();
	}
});

Deno.test('sse: a kind with no producer is refused rather than falsely armed', async () => {
	// Announcing that coverage has begun when nothing can mint the record inverts
	// the boundary record's whole purpose: a consumer would read the silence that
	// follows as "the page was quiet". `console` now HAS a producer (owner item
	// 3), so a deployment whose `producing` set omits it stands in for the
	// boundary, which is the same shape an operator-disabled kind would take.
	const r = rig({ producing: new Set(['navigation']) });
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events?kinds=console');
		const sse = new Sse(response);
		const text = await sse.until('kind-unavailable');
		assertStringIncludes(text, '"kind":"console"');
		assert(!text.includes('console-armed'), 'no coverage is claimed that does not exist');
		assertEquals(record.events.consoleSubscribers, 0);
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: an unfiltered stream does not silently subscribe to an unproduced kind', async () => {
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		await sse.until('stream-open');
		assertEquals(record.events.consoleSubscribers, 0);
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: a stream whose principal loses authority ends with stream-expired', async () => {
	// A stream has no next request, so it cannot rely on revocation taking effect
	// on one. It re-earns its decision on the gateway's own horizon instead.
	let authorized = true;
	const r = rig({ revalidateMs: 1, revalidate: () => authorized });
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		await sse.until('stream-open');
		authorized = false;
		r.setNow(1_760_000_010_000);
		const text = await sse.until('stream-expired');
		assertStringIncludes(text, 'event: bye');
		assertStringIncludes(text, '"reason":"stream-expired"');
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: a stream that asked for no console kind arms nothing', async () => {
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events?kinds=navigation');
		const sse = new Sse(response);
		await sse.until('stream-open');
		assertEquals(record.events.consoleSubscribers, 0);
		await sse.close();
	} finally {
		await r.close();
	}
});

// --- shutdown ----------------------------------------------------------------

Deno.test('sse: shutdown terminates an open subscriber with a bye', async () => {
	// An open SSE response is an in-flight request and never finishes on its own,
	// so a shutdown that did not close it would block until the subscriber left.
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		await sse.until('stream-open');
		assertEquals(r.streams.size, 1);
		r.streams.closeAll('server-shutdown');
		const text = await sse.until('server-shutdown');
		assertStringIncludes(text, 'event: bye');
		assertStringIncludes(text, '"reason":"server-shutdown"');
		assertEquals(r.streams.size, 0);
	} finally {
		await r.close();
	}
});

Deno.test('sse: a closed session ends its streams rather than stranding them', async () => {
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		await sse.until('stream-open');
		await r.registry.close(record.id, 'session-closed');
		const text = await sse.until('session-closed');
		assertStringIncludes(text, 'event: bye');
	} finally {
		await r.close();
	}
});

// --- headers -----------------------------------------------------------------

Deno.test('sse: the response opts out of transformation and proxy buffering', async () => {
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		assertEquals(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
		// A compressed text/event-stream buffers, and automatic compression is
		// switchable in Deno; opting out per response is cheaper than depending on
		// a default.
		assertStringIncludes(response.headers.get('cache-control') ?? '', 'no-transform');
		assertEquals(response.headers.get('x-accel-buffering'), 'no');
		await response.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('sse: no credential appears anywhere in the response', async () => {
	const r = rig();
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		const sse = new Sse(response);
		const text = await sse.until('stream-open');
		for (const header of ['authorization', 'set-cookie']) {
			assertEquals(response.headers.get(header), null, `${header} must not be echoed`);
		}
		assert(!text.toLowerCase().includes('bearer'), 'no credential on the stream');
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: a live-view socket and an event stream share one per-principal ceiling', () => {
	// API-CONTRACT §7 has published "Concurrent WS viewers per principal | 8"
	// since 0.1.0 and nothing enforced it. Two independent ceilings would
	// disagree about what one principal is allowed to hold, so there is one.
	const streams = new EventStreamRegistry();
	for (let i = 0; i < 4; i++) assertEquals(streams.admit(`s${i}`, 'p'), 'ok');
	for (let i = 0; i < 4; i++) assert(streams.admitPrincipal('p'), `socket ${i} should be admitted`);
	assertEquals(streams.countForPrincipal('p'), MAX_CONNECTIONS_PER_PRINCIPAL);
	assertEquals(streams.admit('s9', 'p'), 'principal-full', 'a stream is refused once sockets fill the budget');
	assertEquals(streams.admitPrincipal('p'), false, 'and so is another socket');
	// Another principal is unaffected: the ceiling is per principal, not global.
	assertEquals(streams.admit('s0', 'other'), 'ok');
});

Deno.test('sse: releasing a socket slot frees the shared ceiling and leaves no entry behind', () => {
	const streams = new EventStreamRegistry();
	assert(streams.admitPrincipal('p'));
	streams.releasePrincipal('p');
	assertEquals(streams.countForPrincipal('p'), 0);
	// Deleted at zero rather than left at 0, so the map is bounded by
	// construction and needs no sweep of its own.
	assertEquals(streams.admitPrincipal('p'), true);
	streams.releasePrincipal('p');
});

Deno.test('sse: the per-session stream budget is not the per-principal one', () => {
	// Four streams on one session by four different principals all fit; the
	// session budget binds, the principal budget does not.
	const streams = new EventStreamRegistry();
	for (let i = 0; i < MAX_EVENT_STREAMS_PER_SESSION; i++) {
		assertEquals(streams.admit('s', `p${i}`), 'ok');
	}
	assertEquals(streams.admit('s', 'p9'), 'session-full');
});

Deno.test('sse: a synthesized frame never advances a resume cursor (M-1)', async () => {
	// A consumer reconnects behind the mark. The stream-open, kind-unavailable and
	// bye frames are all minted AT the mark, so if any published an `id:` the
	// client would store it and, on the next reconnect, skip everything between.
	const r = rig();
	try {
		const record = await r.registry.resolve(undefined);
		for (let i = 0; i < 5; i++) record.events.append('tab', { action: 'opened' });
		const response = await r.fetch(`/api/v1/sessions/default/events?since=${record.events.epoch}:1&kinds=tab,nope`);
		const sse = new Sse(response);
		const text = await sse.until('event: tab');
		const ids = [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
		// Every id on the wire belongs to a real ring record, never to a
		// synthesized one at the high-water mark.
		assert(ids.length > 0, 'the replayed records carry ids');
		for (const id of ids) {
			const seq = Number(String(id).split(':')[1]);
			assert(seq <= 5, `id ${id} is above the ring's high-water mark`);
		}
		await sse.close();
	} finally {
		await r.close();
	}
});

Deno.test('sse: a hostile kinds list is bounded in what it costs and what it echoes (M-2)', () => {
	// The dedupe was an array scan inside the per-entry loop, so a 64 KB query
	// string — which the listener accepts — was a synchronous event-loop stall
	// measured in seconds, and every unmatched entry was echoed back verbatim.
	const available = new Set<string>(EVENT_KINDS);
	const hostile = Array.from({ length: 20_000 }, (_, i) => `k${i}`).join(',');
	const started = performance.now();
	const parsed = parseKinds(hostile, available);
	const elapsed = performance.now() - started;
	assert(elapsed < 50, `parsing took ${elapsed.toFixed(1)} ms`);
	assert(parsed.unavailable.length <= 8, `echoed ${parsed.unavailable.length} entries`);
	for (const entry of parsed.unavailable) assert(entry.length <= 64, `echoed ${entry.length} characters`);
	// A single enormous entry is truncated rather than reflected.
	const long = parseKinds('x'.repeat(50_000), available);
	assertEquals(long.unavailable.length, 1);
	assertEquals(long.unavailable[0]?.length, 64);
});

Deno.test('sse: the lifetime cap does not depend on the consumer reading (M-4)', async () => {
	// pull runs only while the consumer drains the queue, so a client that
	// completes the request and stops reading would otherwise hold a per-session
	// seat and a per-principal seat until the process exited.
	const r = rig({ lifetimeMs: 20 });
	try {
		await r.registry.resolve(undefined);
		const response = await r.fetch('/api/v1/sessions/default/events');
		assertEquals(r.streams.countFor('default'), 1);
		// Deliberately never read the body.
		await new Promise((resolve) => setTimeout(resolve, 120));
		assertEquals(r.streams.countFor('default'), 0, 'the seat is released without a single read');
		assertEquals(r.streams.countForPrincipal(INVOKER.id), 0);
		await response.body?.cancel().catch(() => {});
	} finally {
		await r.close();
	}
});
