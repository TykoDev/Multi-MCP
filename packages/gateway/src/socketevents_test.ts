/**
 * `events.subscribe`, the socket half of B1.8's two transports.
 *
 * The pump is driven directly against a real `SessionEventRing` rather than
 * through a socket, so every control is provable without a bound port — the same
 * reason the SSE tests construct requests against the `fetch` handler. What a
 * socket adds on top of the pump is one `send` and one `ready`, and both are
 * supplied here.
 */
import { assert, assertEquals } from '@std/assert';
import { SessionEventRing } from '@tykotech/mcp';
import type { ServerMsg } from '@tykotech/wire';
import { EVENT_KINDS, SSE_ONLY_EVENT_KINDS, WS_EVENT_KINDS } from '@tykotech/wire';
import { PRODUCING_EVENT_KINDS } from './eventstream.ts';
import { resolveSocketKinds, SocketEventPump } from './socketevents.ts';

/** Every kind, so a test can prove the *transport* excludes content rather than the producer set. */
const ALL_PRODUCING: ReadonlySet<string> = new Set(EVENT_KINDS);

interface Sink {
	readonly sent: ServerMsg[];
	/** Only the records, which is what every assertion here is actually about. */
	records(): Array<{ kind: string; seq: number; payload: Record<string, unknown> }>;
}

function sink(): Sink & { send(message: ServerMsg): void } {
	const sent: ServerMsg[] = [];
	return {
		sent,
		send: (message: ServerMsg) => sent.push(message),
		records() {
			return sent.flatMap((message) => (message.type === 'event' ? [message.event] : []));
		},
	};
}

/** Lets the pump's microtasks and its zero-length ring waits run. */
async function settle(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

function ring(): SessionEventRing {
	return new SessionEventRing({});
}

Deno.test('ws events: every subscription states its epoch before it waits', async () => {
	const events = ring();
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		idleMs: 5,
	});
	const first = out.records()[0];
	assert(first !== undefined, 'a subscription must announce itself');
	assertEquals(first.kind, 'control');
	assertEquals(first.payload.event, 'stream-open');
	assertEquals(first.payload.epoch, events.epoch);
	assertEquals(first.payload.seq, events.highWaterMark);
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: the socket carries no content kind, even unfiltered (SR2-m6)', async () => {
	// The producer set is deliberately *everything* here: what excludes `console`
	// from this transport is the transport, not the absence of a producer.
	const events = ring();
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: ALL_PRODUCING,
		idleMs: 5,
	});
	await settle();
	for (const kind of SSE_ONLY_EVENT_KINDS) events.append(kind, { text: 'page content' });
	events.append('navigation', { origin: 'https://example.test', path: '/', has_query: false });
	await settle();
	const kinds = out.records().map((record) => record.kind);
	for (const excluded of SSE_ONLY_EVENT_KINDS) {
		assertEquals(kinds.includes(excluded), false, `${excluded} reached a live-view socket`);
	}
	assert(kinds.includes('navigation'), 'a structural kind must still be carried');
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: a content kind asked for is answered, never silently dropped', async () => {
	const events = ring();
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: ALL_PRODUCING,
		kinds: ['console', 'navigation'],
		idleMs: 5,
	});
	const unavailable = out.records().filter((record) => record.payload.event === 'kind-unavailable');
	assertEquals(unavailable.length, 1);
	assertEquals(unavailable[0]?.payload.kind, 'console');
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: the carried set is derived, not written out', () => {
	const { filter } = resolveSocketKinds(undefined, ALL_PRODUCING);
	assertEquals([...filter].sort(), [...WS_EVENT_KINDS].sort());
	for (const content of SSE_ONLY_EVENT_KINDS) assertEquals(filter.has(content), false);
	// A kind with no producer is unavailable for the same reason a content kind
	// is: waiting for it is waiting forever. `dom.settled` now HAS a producer
	// (owner item 3), so a genuinely unknown kind stands in for the boundary.
	const asked = resolveSocketKinds(['no-such-kind'], PRODUCING_EVENT_KINDS);
	assertEquals(asked.unavailable, ['no-such-kind']);
	assertEquals(asked.filter.size, 0);
	// And a subscription naming dom.settled is carried, not refused.
	const settled = resolveSocketKinds(['dom.settled'], PRODUCING_EVENT_KINDS);
	assertEquals(settled.unavailable, []);
	assertEquals(settled.filter.has('dom.settled'), true);
});

Deno.test('ws events: a hostile kinds list is bounded in what it echoes', () => {
	const many = Array.from({ length: 200 }, (_, i) => `kind-${i}`);
	const { unavailable } = resolveSocketKinds([...many, 'x'.repeat(500)], PRODUCING_EVENT_KINDS);
	assert(unavailable.length <= 8, `echoed ${unavailable.length} entries`);
	for (const entry of unavailable) assert(entry.length <= 64, `echoed ${entry.length} characters`);
});

Deno.test('ws events: records flow in order, and a kinds filter narrows them', async () => {
	const events = ring();
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		kinds: ['navigation'],
		idleMs: 5,
	});
	await settle();
	events.append('navigation', { origin: 'https://a.test', path: '/one', has_query: false });
	events.append('tab', { action: 'opened', tab_id: 'T2', opener_tab_id: null }, 'T2');
	events.append('navigation', { origin: 'https://a.test', path: '/two', has_query: false });
	await settle();
	const carried = out.records().filter((record) => record.kind !== 'control');
	assertEquals(carried.map((record) => record.payload.path), ['/one', '/two']);
	// `seq` is allocated over the unfiltered stream, so a filtered subscriber sees
	// a hole and that is not a gap.
	assert(carried[1]!.seq - carried[0]!.seq === 2, 'seq is allocated over the unfiltered stream');
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: a cursor from another epoch gaps with dropped null', async () => {
	const events = ring();
	events.append('navigation', { origin: 'https://a.test', path: '/', has_query: false });
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		since: 'a-ring-that-no-longer-exists:3',
		idleMs: 5,
	});
	await settle();
	const gap = out.records().find((record) => record.kind === 'gap');
	assert(gap !== undefined, 'a foreign epoch must gap');
	assertEquals(gap.payload.reason, 'epoch-changed');
	assertEquals(gap.payload.dropped, null);
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: a bare integer since is an epoch mismatch, not a seq', async () => {
	const events = ring();
	events.append('navigation', { origin: 'https://a.test', path: '/', has_query: false });
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		since: 1,
		idleMs: 5,
	});
	await settle();
	const gap = out.records().find((record) => record.kind === 'gap');
	assert(gap !== undefined, 'a naive integer cursor must be told the truth');
	assertEquals(gap.payload.reason, 'epoch-changed');
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: a same-epoch cursor above the high-water mark waits rather than gapping', async () => {
	const events = ring();
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		since: `${events.epoch}:9999`,
		idleMs: 5,
	});
	await settle();
	assertEquals(out.records().filter((record) => record.kind === 'gap').length, 0);
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: a socket that is behind gaps rather than queueing', async () => {
	// Frames drop, events gap. While the socket is behind the pump stops
	// *reading*, so the ring turns over under a stationary cursor and the first
	// read that succeeds leads with a `gap` carrying the arithmetic.
	const events = new SessionEventRing({ capacity: 4 });
	const out = sink();
	let ready = true;
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => ready,
		producing: PRODUCING_EVENT_KINDS,
		idleMs: 5,
	});
	await settle();
	ready = false;
	for (let i = 0; i < 12; i++) {
		events.append('navigation', { origin: 'https://a.test', path: `/${i}`, has_query: false });
	}
	await settle();
	assertEquals(out.records().filter((record) => record.kind === 'navigation').length, 0, 'nothing is queued');
	ready = true;
	await settle(8);
	const records = out.records();
	const gap = records.find((record) => record.kind === 'gap');
	assert(gap !== undefined, 'the loss must be reported');
	assertEquals(gap.payload.reason, 'ring-overrun');
	assert((gap.payload.dropped as number) > 0, 'the gap must carry the arithmetic');
	assert(records.some((record) => record.kind === 'navigation'), 'delivery resumes after the gap');
	pump.stop();
	events.close();
	await settle();
});

Deno.test('ws events: stop() ends the subscription and nothing arrives after it', async () => {
	const events = ring();
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		idleMs: 5,
	});
	await settle();
	pump.stop();
	await settle();
	const before = out.sent.length;
	events.append('navigation', { origin: 'https://a.test', path: '/after', has_query: false });
	await settle(8);
	assertEquals(out.sent.length, before, 'a stopped pump must not send');
	assert(pump.stopped);
	events.close();
	await settle();
});

Deno.test('ws events: a closed session ends the subscription with a bye', async () => {
	const events = ring();
	const out = sink();
	const pump = SocketEventPump.open({
		ring: events,
		send: out.send,
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		idleMs: 5,
	});
	await settle();
	events.close();
	await settle(8);
	const bye = out.records().find((record) => record.kind === 'bye');
	assert(bye !== undefined, 'a closed session must terminate the subscription');
	assertEquals(bye.payload.reason, 'session-closed');
	assert(pump.stopped);
});
