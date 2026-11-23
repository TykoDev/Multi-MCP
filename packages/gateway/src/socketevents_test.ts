/** `events.subscribe`, the socket half of the two event transports. */
import { assert, assertEquals } from '@std/assert';
import { SessionEventRing } from '@tykotech/mcp';
import type { ServerMsg } from '@tykotech/wire';
import { EVENT_KINDS, SSE_ONLY_EVENT_KINDS, WS_EVENT_KINDS } from '@tykotech/wire';
import { PRODUCING_EVENT_KINDS } from './eventstream.ts';
import { resolveSocketKinds, SocketEventPump } from './socketevents.ts';

/** Every kind, so a test proves the *transport* excludes content rather than the producer set. */
const ALL_PRODUCING: ReadonlySet<string> = new Set(EVENT_KINDS);

/** Lets the pump's microtasks and its zero-length ring waits run. */
async function settle(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

type PumpOptions = Partial<Omit<Parameters<typeof SocketEventPump.open>[0], 'ring' | 'send'>>;

/** Opens a pump over `events`, runs `body`, then stops it and closes the ring. */
async function withPump(
	options: PumpOptions,
	body: (p: {
		events: SessionEventRing;
		pump: SocketEventPump;
		sent: ServerMsg[];
		records(): Array<{ kind: string; seq: number; payload: Record<string, unknown> }>;
	}) => void | Promise<void>,
	events = new SessionEventRing({}),
): Promise<void> {
	const sent: ServerMsg[] = [];
	const pump = SocketEventPump.open({
		ring: events,
		send: (message) => sent.push(message),
		ready: () => true,
		producing: PRODUCING_EVENT_KINDS,
		idleMs: 5,
		...options,
	});
	try {
		await body({
			events,
			pump,
			sent,
			records: () => sent.flatMap((message) => (message.type === 'event' ? [message.event] : [])),
		});
	} finally {
		pump.stop();
		events.close();
		await settle();
	}
}

const nav = (path: string) => ({ origin: 'https://a.test', path, has_query: false });

Deno.test('ws events: a subscription states its epoch first, carries no content kind, and answers one it cannot carry', async () => {
	await withPump({ producing: ALL_PRODUCING }, async ({ events, records }) => {
		const first = records()[0];
		assertEquals(
			[first?.kind, first?.payload.event, first?.payload.epoch, first?.payload.seq],
			['control', 'stream-open', events.epoch, events.highWaterMark],
		);
		await settle();
		for (const kind of SSE_ONLY_EVENT_KINDS) events.append(kind, { text: 'page content' });
		events.append('navigation', nav('/'));
		await settle();
		const kinds = records().map((record) => record.kind);
		for (const excluded of SSE_ONLY_EVENT_KINDS) assert(!kinds.includes(excluded), `${excluded} reached a socket`);
		assert(kinds.includes('navigation'));
	});
	await withPump({ producing: ALL_PRODUCING, kinds: ['console', 'navigation'] }, ({ records }) => {
		const unavailable = records().filter((record) => record.payload.event === 'kind-unavailable');
		assertEquals(unavailable.map((record) => record.payload.kind), ['console']);
	});
	// The carried set is derived; a kind with no producer is unavailable, since waiting for it is waiting forever.
	assertEquals([...resolveSocketKinds(undefined, ALL_PRODUCING).filter].sort(), [...WS_EVENT_KINDS].sort());
	const unknown = resolveSocketKinds(['no-such-kind'], PRODUCING_EVENT_KINDS);
	assertEquals([unknown.unavailable, unknown.filter.size], [['no-such-kind'], 0]);
	const settled = resolveSocketKinds(['dom.settled'], PRODUCING_EVENT_KINDS);
	assertEquals([settled.unavailable, settled.filter.has('dom.settled')], [[], true]);
	const hostile = resolveSocketKinds(
		[...Array.from({ length: 200 }, (_, i) => `k-${i}`), 'x'.repeat(500)],
		PRODUCING_EVENT_KINDS,
	);
	assert(hostile.unavailable.length <= 8 && hostile.unavailable.every((entry) => entry.length <= 64), 'a bounded echo');
});

Deno.test('ws events: records flow in order through a kinds filter, with seq allocated over the unfiltered stream', async () => {
	await withPump({ kinds: ['navigation'] }, async ({ events, records }) => {
		await settle();
		events.append('navigation', nav('/one'));
		events.append('tab', { action: 'opened', tab_id: 'T2', opener_tab_id: null }, 'T2');
		events.append('navigation', nav('/two'));
		await settle();
		const carried = records().filter((record) => record.kind !== 'control');
		assertEquals(carried.map((record) => record.payload.path), ['/one', '/two']);
		assertEquals(carried[1]!.seq - carried[0]!.seq, 2, 'a filtered hole is not a gap');
	});
});

Deno.test('ws events: a foreign epoch or a bare integer cursor gaps; a same-epoch cursor above the mark waits', async () => {
	for (const since of ['a-ring-that-no-longer-exists:3', 1] as const) {
		const events = new SessionEventRing({});
		events.append('navigation', nav('/'));
		await withPump({ since }, async ({ records }) => {
			await settle();
			const gap = records().find((record) => record.kind === 'gap');
			assertEquals(gap?.payload.reason, 'epoch-changed', String(since));
			if (typeof since === 'string') assertEquals(gap?.payload.dropped, null);
		}, events);
	}
	const events = new SessionEventRing({});
	await withPump({ since: `${events.epoch}:9999` }, async ({ records }) => {
		await settle();
		assertEquals(records().filter((record) => record.kind === 'gap').length, 0);
	}, events);
});

Deno.test('ws events: a socket that is behind gaps rather than queueing', async () => {
	// While the socket is behind the pump stops reading, so the ring turns over under a stationary cursor.
	let ready = true;
	await withPump({ ready: () => ready }, async ({ events, records }) => {
		await settle();
		ready = false;
		for (let i = 0; i < 12; i++) events.append('navigation', nav(`/${i}`));
		await settle();
		assertEquals(records().filter((record) => record.kind === 'navigation').length, 0, 'nothing is queued');
		ready = true;
		await settle(8);
		const gap = records().find((record) => record.kind === 'gap');
		assertEquals(gap?.payload.reason, 'ring-overrun');
		assert((gap?.payload.dropped as number) > 0, 'the gap carries the arithmetic');
		assert(records().some((record) => record.kind === 'navigation'), 'delivery resumes after the gap');
	}, new SessionEventRing({ capacity: 4 }));
});

Deno.test('ws events: stop() sends nothing more, and a closed session ends the subscription with a bye', async () => {
	await withPump({}, async ({ events, pump, sent }) => {
		await settle();
		pump.stop();
		await settle();
		const before = sent.length;
		events.append('navigation', nav('/after'));
		await settle(8);
		assertEquals(sent.length, before);
		assert(pump.stopped);
	});
	await withPump({}, async ({ events, pump, records }) => {
		await settle();
		events.close();
		await settle(8);
		assertEquals(records().find((record) => record.kind === 'bye')?.payload.reason, 'session-closed');
		assert(pump.stopped);
	});
});
