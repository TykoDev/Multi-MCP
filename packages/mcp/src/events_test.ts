/**
 * The event ring's bounds, its gap contract and its refcount (report_design.md §7.3).
 *
 * Each of the three bounds is overflowed by a test rather than asserted from the
 * constant, because a bound whose enforcement is never exercised is a comment.
 */

import { assert, assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import {
	EVENT_KINDS,
	EVENT_RECORD_KINDS,
	EventRecordSchema,
	SSE_ONLY_EVENT_KINDS,
	WS_EVENT_KINDS,
} from '@tykotech/wire';
import {
	CONTENT_RATE_PER_SECOND,
	downloadFailureReason,
	downloadPayload,
	formatCursor,
	loggedPath,
	MAX_EVENT_BYTES,
	MAX_RING_BYTES,
	navigationTarget,
	NetworkIdleCounter,
	parseCursor,
	RING_CAPACITY,
	SessionEventRing,
	stripMatrixParams,
	STRUCTURAL_RATE_PER_SECOND,
} from './events.ts';

/** A clock the test drives, so the rate window is deterministic. */
function clock(start = 1_760_000_000_000): { now: () => number; advance: (ms: number) => void } {
	let value = start;
	return { now: () => value, advance: (ms) => void (value += ms) };
}

Deno.test('kinds: every content kind is rate-capped as one, and the two lists cannot drift', () => {
	// `SSE_ONLY_EVENT_KINDS` answers "may a `view:watch` holder see this"; the
	// ring's `CONTENT_KINDS` answers "how fast may a page mint it". Different
	// questions, but a kind that is page content is by construction a kind a page
	// can spin, so one list must contain the other. `focus` was in exactly the
	// gap: withheld from the socket as content, budgeted at the structural rate.
	for (const kind of SSE_ONLY_EVENT_KINDS) {
		const ring = new SessionEventRing({ capacity: 4096, maxRingBytes: 8 * 1024 * 1024, now: () => 1000 });
		let admitted = 0;
		for (let i = 0; i < STRUCTURAL_RATE_PER_SECOND + 10; i++) {
			if (ring.append(kind, { text: 'x' }) !== null) admitted += 1;
		}
		assertEquals(admitted, CONTENT_RATE_PER_SECOND, `${kind} is not held to the content budget`);
	}
});

Deno.test('kinds: a live-view socket filter admits no content kind, asserted at the ring (B1.8/B1.9)', () => {
	// The transport filters through `WS_EVENT_KINDS`, and `socketevents_test.ts`
	// proves the transport does it. This pins the same guarantee one layer down,
	// at the ring's own `read`, so a future edit to either transport cannot
	// quietly reopen it.
	const ring = new SessionEventRing({ now: () => 1000 });
	for (const kind of SSE_ONLY_EVENT_KINDS) ring.append(kind, { text: 'page content' });
	ring.append('navigation', { origin: 'https://a.test', path: '/', has_query: false });
	const records = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }, new Set(WS_EVENT_KINDS));
	assertEquals(records.map((record) => record.kind), ['navigation']);
});

Deno.test('events: the published bounds are the design figures', () => {
	assertEquals(RING_CAPACITY, 512);
	assertEquals(MAX_EVENT_BYTES, 1024);
	assertEquals(MAX_RING_BYTES, 256 * 1024);
	assertEquals(CONTENT_RATE_PER_SECOND, 50);
});

Deno.test('events: twelve subscribable kinds, fourteen kind strings on the wire', () => {
	assertEquals(EVENT_KINDS.length, 12);
	assertEquals(EVENT_RECORD_KINDS.length, 14);
	// gap and bye are kind strings but not subscribable.
	assertEquals(EVENT_RECORD_KINDS.filter((k) => !EVENT_KINDS.includes(k as never)), ['gap', 'bye']);
});

Deno.test('events: the socket carries no content-bearing kind', () => {
	// A live-view ticket is minted on view:watch/view:control and carries no
	// mcp:invoke, so page content must not reach it.
	for (const kind of ['focus', 'input', 'console']) {
		assert(!WS_EVENT_KINDS.includes(kind as never), `${kind} must not be on the socket`);
	}
	assertEquals(WS_EVENT_KINDS.length, EVENT_KINDS.length - 3);
});

Deno.test('events: seq is per session, from 1, monotonic and never reused (I-10)', () => {
	const ring = new SessionEventRing({ capacity: 4 });
	const seqs: number[] = [];
	for (let i = 0; i < 10; i++) {
		const record = ring.append('tab', { action: 'created', tab_id: `t${i}`, opener_tab_id: null }, `t${i}`);
		assert(record !== null);
		seqs.push(record.seq);
	}
	assertEquals(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assertEquals(ring.highWaterMark, 10);
	// Eviction does not rewind the counter, so a reused seq is impossible.
	assertEquals(ring.size, 4);
	assertEquals(ring.oldestSeq, 7);
});

Deno.test('events: the entry bound evicts oldest-first', () => {
	const ring = new SessionEventRing({ capacity: 8 });
	for (let i = 0; i < 40; i++) ring.append('network.idle', { inflight: 0, quiet_ms: 500 });
	assertEquals(ring.size, 8);
	assertEquals(ring.oldestSeq, 33);
});

Deno.test('events: the byte bound binds before the entry bound', () => {
	// 512 entries are permitted, but 256 KiB is not: the byte total is what the
	// published memory figure rests on, so it must evict first.
	const ring = new SessionEventRing({ maxRingBytes: 4096 });
	for (let i = 0; i < 200; i++) ring.append('dialog', { dialog_id: `d${i}`, kind: 'alert', message: 'x'.repeat(512) });
	assert(ring.size < 200, 'the byte bound must have evicted');
	assert(ring.bytes <= 4096, `retained ${ring.bytes} bytes, cap 4096`);
	assertEquals(ring.highWaterMark, 200);
});

Deno.test('events: an over-long record is truncated at its one field and flagged, never dropped', () => {
	const ring = new SessionEventRing();
	// Astral characters: 512 of them is 2048 UTF-8 bytes, well past the 1 KiB cap.
	const record = ring.append('console', { level: 'log', text: '\u{1F600}'.repeat(4000), truncated: false });
	assert(record !== null, 'the record must survive');
	assertEquals(record.kind, 'console');
	assertEquals(record.payload.truncated, true);
	const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
	assert(bytes <= MAX_EVENT_BYTES, `record is ${bytes} bytes, cap ${MAX_EVENT_BYTES}`);
});

Deno.test('events: every kind fits the byte cap with maximal identifiers', () => {
	const ring = new SessionEventRing();
	const maximal: Record<string, unknown> = {
		frame_id: 'F'.repeat(64),
		tab_id: 'T'.repeat(64),
		origin: 'https://'.padEnd(400, 'o'),
		path: '/'.padEnd(400, 'p'),
		has_query: true,
		reason: 'user',
		committed: true,
		label: 'L'.repeat(400),
		filename: 'N'.repeat(400),
		message: 'M'.repeat(900),
		text: 'X'.repeat(900),
		holder_name: 'H'.repeat(400),
		element_index: 12,
		level: 'error',
		value_masked: true,
	};
	for (const kind of EVENT_RECORD_KINDS) {
		if (kind === 'gap' || kind === 'bye') continue;
		const record = ring.append(kind, { ...maximal }, 'T'.repeat(64));
		assert(record !== null, kind);
		const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
		assert(bytes <= MAX_EVENT_BYTES, `${kind} is ${bytes} bytes, cap ${MAX_EVENT_BYTES}`);
	}
});

Deno.test('events: a data: line can never be split, whatever the payload holds (I-9)', () => {
	const ring = new SessionEventRing();
	// Newlines, carriage returns, tabs and astral characters in every text field.
	const hostile = 'a\nb\r\nc\td\u{1F4A5}  ';
	const records = [
		ring.append('console', { level: 'log', text: hostile }),
		ring.append('dialog', { dialog_id: 'd1', kind: 'prompt', message: hostile }),
		ring.append('navigation', { frame_id: hostile, origin: hostile, path: hostile, has_query: false }),
	];
	for (const record of records) {
		assert(record !== null);
		const line = JSON.stringify(record);
		assertEquals(line.split('\n').length, 1, 'a JSON.stringify result cannot carry a raw newline');
		assertEquals(line.split('\r').length, 1);
	}
});

Deno.test('events: an under-run cursor gets a gap first, with exact arithmetic', () => {
	const ring = new SessionEventRing({ capacity: 4 });
	for (let i = 0; i < 10; i++) ring.append('tab', { action: 'created' });
	// Retained: 7..10. A consumer that last saw 2 lost 3,4,5,6.
	const out = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 2 });
	assertEquals(out[0]?.kind, 'gap');
	// One *below* the oldest retained: every record's seq means "the cursor you
	// have consumed through", so resuming from the gap's own seq delivers the
	// record that follows it rather than skipping it.
	assertEquals(out[0]?.seq, 6);
	// `by_kind` attributes the loss (SR1-A1b): four `tab` records, not merely four
	// records. A consumer needs that to tell a flooding page from its own absence.
	assertEquals(out[0]?.payload, {
		reason: 'ring-overrun',
		dropped_from: 3,
		dropped_to: 6,
		dropped: 4,
		by_kind: { tab: 4 },
	});
	assertEquals(out.slice(1).map((r) => r.seq), [7, 8, 9, 10]);
});

Deno.test('events: resuming from a gap record skips nothing', () => {
	// The SSE `id:` field is the record's seq and a reconnecting client returns
	// it as `Last-Event-ID`. A gap that shared a seq with the record after it
	// made that record unreachable — lost silently, with no second gap to say so,
	// which defeats "the only signal of loss is a gap record" using the gap
	// record itself.
	const ring = new SessionEventRing({ capacity: 4 });
	for (let i = 0; i < 10; i++) ring.append('tab', { action: 'created' });
	const first = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 2 });
	const gap = first[0];
	assert(gap !== undefined && gap.kind === 'gap');
	// The client got the gap, then dropped before reading anything else.
	const resumed = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: gap.seq });
	assertEquals(resumed.map((r) => r.seq), [7, 8, 9, 10], 'no record is skipped on resume');
	assertEquals(resumed.some((r) => r.kind === 'gap'), false, 'and nothing further was lost');
});

Deno.test('events: a cursor still inside the ring gets no gap', () => {
	const ring = new SessionEventRing({ capacity: 8 });
	for (let i = 0; i < 5; i++) ring.append('tab', { action: 'created' });
	const out = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 3 });
	assertEquals(out.map((r) => r.kind), ['tab', 'tab']);
	assertEquals(out.map((r) => r.seq), [4, 5]);
});

Deno.test('events: a cursor above the high-water mark waits rather than gapping', () => {
	const ring = new SessionEventRing();
	ring.append('tab', { action: 'created' });
	assertEquals(ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 99 }), []);
});

Deno.test('events: an omitted since means from now, not from the beginning', () => {
	const ring = new SessionEventRing();
	for (let i = 0; i < 5; i++) ring.append('tab', { action: 'created' });
	assertEquals(ring.read({ kind: 'from-now' }), []);
	assertEquals(parseCursor(undefined), { kind: 'from-now' });
	assertEquals(parseCursor(''), { kind: 'from-now' });
});

Deno.test('events: any non-current epoch gaps with dropped null, older or newer alike', () => {
	const ring = new SessionEventRing();
	for (let i = 0; i < 3; i++) ring.append('tab', { action: 'created' });
	for (const epoch of ['00000000000000000000000000', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
		const out = ring.read({ kind: 'cursor', epoch, seq: 1 });
		assertEquals(out[0]?.kind, 'gap');
		assertEquals(out[0]?.payload.reason, 'epoch-changed');
		// null, not zero: the previous incarnation's ring is gone and the count is unknowable.
		assertEquals(out[0]?.payload.dropped, null);
		assertEquals(out.length, 4, 'the whole retained ring replays after the gap');
	}
});

Deno.test('events: a bare integer since is an epoch mismatch, not a seq', () => {
	assertEquals(parseCursor('137'), { kind: 'epoch-mismatch' });
	const ring = new SessionEventRing();
	ring.append('tab', { action: 'created' });
	assertEquals(ring.read(parseCursor('137'))[0]?.payload.reason, 'epoch-changed');
});

Deno.test('events: a cursor round-trips through its own formatter', () => {
	const ring = new SessionEventRing();
	ring.append('tab', { action: 'created' });
	assertEquals(parseCursor(ring.cursor), { kind: 'cursor', epoch: ring.epoch, seq: 1 });
	assertEquals(parseCursor(formatCursor('E', 4)), { kind: 'cursor', epoch: 'E', seq: 4 });
});

Deno.test('events: a kinds filter leaves seq non-contiguous, and that is not a gap', () => {
	const ring = new SessionEventRing();
	ring.append('tab', { action: 'created' });
	ring.append('console', { level: 'log', text: 'hi' });
	ring.append('tab', { action: 'closed' });
	const out = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }, new Set(['tab']));
	assertEquals(out.map((r) => r.seq), [1, 3], 'seq 2 is filtered, not lost');
	assertEquals(out.some((r) => r.kind === 'gap'), false);
});

Deno.test('events: a kinds filter never removes a gap record', () => {
	const ring = new SessionEventRing({ capacity: 2 });
	for (let i = 0; i < 6; i++) ring.append('console', { level: 'log', text: 'x' });
	const out = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 1 }, new Set(['tab']));
	assertEquals(out.length, 1);
	assertEquals(out[0]?.kind, 'gap');
});

Deno.test('events: the rate cap drops content kinds and reports the exact count', () => {
	const time = clock();
	const ring = new SessionEventRing({ now: time.now });
	let accepted = 0;
	for (let i = 0; i < 80; i++) {
		if (ring.append('console', { level: 'log', text: 'x' }) !== null) accepted += 1;
	}
	assertEquals(accepted, CONTENT_RATE_PER_SECOND);
	// The drop count reaches the wire on the next window, as one control record.
	time.advance(RATE_WINDOW_MS_FOR_TEST);
	ring.append('console', { level: 'log', text: 'y' });
	const capped = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((r) => r.payload.event === 'rate-capped');
	assertEquals(capped.length, 1);
	assertEquals(capped[0]?.payload, { event: 'rate-capped', kind: 'console', dropped: 30 });
});

const RATE_WINDOW_MS_FOR_TEST = 1000;

Deno.test('events: structural kinds get a larger budget, not an exemption', () => {
	// The design reasoned that structural kinds need no cap "because a page
	// cannot spin them". A page can: `alert()` in a loop mints `dialog`,
	// `window.open`/`close` mints `tab`, and reassigning an iframe `src` mints
	// `navigation`. Uncapped that is event *blinding* — 512 synthetic records
	// evict the one real `download.done` a consumer was waiting for, so the page
	// chooses what an mcp:invoke principal is allowed to observe.
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 4096 });
	let accepted = 0;
	for (let i = 0; i < 400; i++) {
		if (ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'x' }) !== null) accepted += 1;
	}
	assertEquals(accepted, STRUCTURAL_RATE_PER_SECOND);
	assert(STRUCTURAL_RATE_PER_SECOND > CONTENT_RATE_PER_SECOND, 'structural traffic keeps the looser budget');
	// The loss is reported exactly, never silent.
	time.advance(1000);
	ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'y' });
	const capped = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((r) => r.payload.event === 'rate-capped');
	assertEquals(capped[0]?.payload, { event: 'rate-capped', kind: 'dialog', dropped: 150 });
});

Deno.test('events: control records are never capped, so a cap is always reported', () => {
	// The `rate-capped` record is itself a control record. Capping control would
	// let a flood suppress the report of the flood.
	const ring = new SessionEventRing({ now: clock().now, capacity: 4096 });
	let accepted = 0;
	for (let i = 0; i < 400; i++) {
		if (ring.appendControl('taken', { principal: 'p' }) !== null) accepted += 1;
	}
	assertEquals(accepted, 400);
});

Deno.test('events: a page cannot pick a download failure reason through its filename', () => {
	// The watchdog interpolates the download's *display name* — which the page
	// chooses — into several of its error strings. Under substring matching a
	// file called `deadline.pdf` reported `interrupted` and `cancel.txt`
	// reported `canceled`: the enum stayed closed, but the page picked from it.
	for (const name of ['deadline.pdf', 'cancel.txt', 'per-file limit.doc']) {
		const error = `the browser reported ${name} as complete but no file exists at the vetted path`;
		assertEquals(downloadFailureReason(error), 'browser-error', name);
	}
});

Deno.test('events: a failed download never reports itself complete', () => {
	// The containment-failure path sets `state: 'completed'` and then emits the
	// `failed` phase, so passing the state through told a consumer to go and
	// fetch bytes that are not there.
	const payload = downloadPayload('download.failed', {
		guid: 'g',
		fileName: 'f.pdf',
		mimeType: null,
		fileSize: 0,
		receivedBytes: 0,
		totalBytes: 0,
		state: 'completed',
		error: 'f.pdf resolved outside the downloads directory and was refused',
	});
	assertEquals(payload.status, 'failed');
	assertEquals(payload.reason, 'browser-error');
});

Deno.test('events: a cursor with a non-decimal seq is a mismatch, not a plausible number', () => {
	// Bare `Number` accepted `0x10` as 16 and ` 12` as 12, turning a malformed
	// cursor into a confident wrong answer instead of the mismatch it is.
	for (const raw of ['E:0x10', 'E: 12', 'E:', 'E:-1', 'E:1e3', 'E:1.5']) {
		assertEquals(parseCursor(raw), { kind: 'epoch-mismatch' }, raw);
	}
	assertEquals(parseCursor('E:12'), { kind: 'cursor', epoch: 'E', seq: 12 });
});

Deno.test('events: a closed ring returns null from appendControl rather than reusing a seq', () => {
	const ring = new SessionEventRing();
	ring.append('tab', { action: 'opened' });
	ring.close();
	assertEquals(ring.appendControl('released'), null);
	assertEquals(ring.highWaterMark, 1, 'and allocates nothing further');
});

Deno.test('events: non-string bloat cannot escape the byte cap', () => {
	// The second pass only inspected top-level strings, so a nested object — the
	// "a refactor widened a payload" case the pass exists for — returned an
	// oversized record.
	const ring = new SessionEventRing();
	const record = ring.append('tab', {
		action: 'opened',
		// Not a shape any producer emits today; that is the point.
		nested: Array.from({ length: 400 }, (_, i) => ({ index: i, note: 'x'.repeat(40) })),
	});
	assert(record !== null);
	const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
	assert(bytes <= MAX_EVENT_BYTES, `record is ${bytes} bytes, cap ${MAX_EVENT_BYTES}`);
	assertEquals(record.payload.truncated, true);
});

Deno.test('events: the console refcount arms once, disarms once, and says so on the wire', () => {
	const armed: boolean[] = [];
	const ring = new SessionEventRing({ setConsoleArmed: (on) => void armed.push(on) });
	ring.armConsole();
	ring.armConsole();
	assertEquals(armed, [true], 'the second subscriber must not re-arm');
	assertEquals(ring.consoleSubscribers, 2);
	ring.disarmConsole();
	assertEquals(armed, [true], 'the first leaver must not disarm');
	ring.disarmConsole();
	assertEquals(armed, [true, false]);
	assertEquals(ring.consoleSubscribers, 0);
	const events = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }).map((r) => r.payload.event);
	assertEquals(events, ['console-armed', 'console-disarmed']);
});

Deno.test('events: disarming below zero is a no-op rather than a negative refcount', () => {
	const ring = new SessionEventRing();
	ring.disarmConsole();
	assertEquals(ring.consoleSubscribers, 0);
	ring.disarmDialog();
	assertEquals(ring.dialogSubscribers, 0);
	assertEquals(ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }), []);
});

Deno.test('B2.5/E-53: the dialog claim is refcounted, announced, and arms on the zero transition only', () => {
	const ring = new SessionEventRing();
	const armed: boolean[] = [];
	ring.setDialogArmed((value) => armed.push(value));
	assertEquals(armed, [], 'installing the callback with no subscriber arms nothing');

	ring.armDialog();
	ring.armDialog();
	assertEquals(armed, [true], 'the second subscriber must not re-arm');
	assertEquals(ring.dialogSubscribers, 2);
	ring.disarmDialog();
	assertEquals(armed, [true], 'the first leaver must not disarm');
	ring.disarmDialog();
	assertEquals(armed, [true, false]);
	assertEquals(ring.dialogSubscribers, 0);
	// The transitions are on the stream, because they change what a `dialog` record *means*: armed,
	// it is an open question; disarmed, it is a report of something already answered.
	const events = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }).map((r) => r.payload.event);
	assertEquals(events, ['dialog-manual-armed', 'dialog-manual-disarmed']);
});

Deno.test('B2.5/E-53: a subscriber that arrived before the callback is not lost', () => {
	const ring = new SessionEventRing();
	ring.armDialog();
	const armed: boolean[] = [];
	ring.setDialogArmed((value) => armed.push(value));
	assertEquals(armed, [true], 'the producer is armed immediately for the subscriber already holding');
});

Deno.test('events: every minted record validates against the wire schema', () => {
	const ring = new SessionEventRing();
	ring.append('navigation', { frame_id: 'f1', origin: 'https://a.test', path: '/x', has_query: true }, 'tab-1');
	ring.appendControl('taken', { principal: 'p', holder_name: 'h' });
	ring.append('console', { level: 'warn', text: 'z'.repeat(4000) });
	for (const record of ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })) {
		EventRecordSchema.parse(record);
		assert(record.tab_id === null || typeof record.tab_id === 'string', 'tab_id is never omitted');
	}
});

Deno.test('events: a closed ring accepts nothing further and releases its waiters', async () => {
	const ring = new SessionEventRing();
	const waiting = ring.next(30_000);
	ring.close();
	await waiting;
	assertEquals(ring.append('tab', { action: 'created' }), null);
	assertEquals(ring.closed, true);
});

Deno.test('events: next() resolves on the next append', async () => {
	const ring = new SessionEventRing();
	const waiting = ring.next(30_000);
	ring.append('tab', { action: 'created' });
	await waiting;
	assertEquals(ring.highWaterMark, 1);
});

Deno.test('events: next() resolves on its own timeout with nothing appended', async () => {
	const ring = new SessionEventRing();
	await ring.next(1);
	assertEquals(ring.highWaterMark, 0);
});

Deno.test('events: aborting a wait clears its timer and waiter without closing the ring', async () => {
	const ring = new SessionEventRing();
	const controller = new AbortController();
	const pending = ring.next(30_000, controller.signal);
	controller.abort();
	await assertRejects(() => pending, DOMException, 'aborted');
	await assertRejects(() => ring.next(30_000, controller.signal), DOMException, 'aborted');
	const next = ring.next(30_000);
	ring.append('tab', { action: 'created' });
	await next;
	assertEquals(ring.closed, false);
	ring.close();
});

Deno.test('events: two rings never share an epoch', () => {
	assertNotEquals(new SessionEventRing().epoch, new SessionEventRing().epoch);
});

// --- the redaction contract -------------------------------------------------

Deno.test('redaction: navigation carries origin, path and has_query — never a URL', () => {
	const target = navigationTarget('https://app.example.test:8443/dash/reports?token=SECRET#frag');
	assertEquals(target, { origin: 'https://app.example.test:8443', path: '/dash/reports', has_query: true });
	// The whole point: the removed half is *gone*, not truncated into another field.
	const serialized = JSON.stringify(target);
	assert(!serialized.includes('SECRET'), 'the query must not survive in any field');
	assert(!serialized.includes('frag'), 'the fragment must not survive in any field');
	assert(!('url' in target), 'a field named url would be the lie this shape exists to avoid');
});

Deno.test('NF-2 (AC25): a navigation path drops matrix parameters and a data: payload, as the request log does', () => {
	const target = navigationTarget('https://a.test/x;jsessionid=1/y;p=2?q');
	assertEquals(target, { origin: 'https://a.test', path: '/x/y', has_query: true });
	assert(!JSON.stringify(target).includes('jsessionid'), 'a session id in a matrix parameter must not survive');
	// The same cutter as the network log's path, from one definition.
	assertEquals(
		navigationTarget('https://a.test/x;jsessionid=1/y;p=2?q').path,
		loggedPath('https://a.test/x;jsessionid=1/y;p=2?q'),
	);
	// A `data:` URL's "path" is its payload; only the media type is kept.
	assertEquals(navigationTarget('data:text/plain;base64,c2VjcmV0').path, 'text/plain');
	assertEquals(navigationTarget('data:,Zq8-plain').path, '');
	// Unchanged for a plain path, an origin-less scheme and an unparseable string.
	assertEquals(navigationTarget('https://a.test/dash/reports').path, '/dash/reports');
	assertEquals(navigationTarget('about:blank').path, 'blank');
	assertEquals(navigationTarget('not a url at all').path, '');
	assertEquals(stripMatrixParams('/a;v=1/b;jsessionid=Zq8/c'), '/a/b/c');
});

Deno.test('redaction: has_query reports the fact without a byte of the content', () => {
	assertEquals(navigationTarget('https://a.test/x').has_query, false);
	assertEquals(navigationTarget('https://a.test/x?').has_query, false);
	assertEquals(navigationTarget('https://a.test/x?q=1').has_query, true);
});

Deno.test('redaction: an origin-less scheme reports its scheme, never the string null', () => {
	assertEquals(navigationTarget('about:blank').origin, 'about:');
	assertEquals(navigationTarget('not a url at all').origin, '');
});

Deno.test('redaction: no download payload carries a url, on any of the three kinds', () => {
	const source = {
		guid: 'g1',
		fileName: 'report.pdf',
		mimeType: 'application/pdf',
		fileSize: 1234,
		receivedBytes: 1234,
		totalBytes: 2000,
		state: 'completed',
		error: null,
	};
	for (const kind of ['download.started', 'download.done', 'download.failed'] as const) {
		const payload = downloadPayload(kind, source);
		assert(!('url' in payload), `${kind} must carry no url (SECURITY-AUTH §8.3)`);
		assert(!('path' in payload), `${kind} must not disclose a server path`);
		assert(!('suggestedFilename' in payload), `${kind} must carry the sanitized name only`);
	}
});

Deno.test('redaction: download.failed reports a closed reason, never the free-text error', () => {
	const base = {
		guid: 'g1',
		fileName: 'f',
		mimeType: null,
		fileSize: 0,
		receivedBytes: 0,
		totalBytes: 0,
		state: 'canceled',
	};
	const cases: Array<[string | null, string]> = [
		['the download exceeds the per-file limit of 104857600 bytes', 'over-file-limit'],
		["the session's downloads exceed the per-session limit of 524288000 bytes", 'over-session-limit'],
		['the session already tracks 100 downloads', 'over-session-limit'],
		['the transfer exceeded the 300000 ms deadline', 'interrupted'],
		['the download was canceled', 'canceled'],
		['net::ERR_ABORTED loading https://host.test/a?token=SECRET', 'browser-error'],
		[null, 'browser-error'],
	];
	for (const [error, expected] of cases) {
		assertEquals(downloadFailureReason(error), expected, String(error));
		const payload = downloadPayload('download.failed', { ...base, error });
		assertEquals(payload.reason, expected);
		assert(!JSON.stringify(payload).includes('SECRET'), 'the free text must never reach the wire');
	}
});

Deno.test('redaction: no event kind may carry an element record (I-8)', () => {
	// The five fields a `focus` descriptor is allowed, and nothing that would make
	// the ring a page-content transcript.
	const ring = new SessionEventRing();
	const record = ring.append('focus', {
		element_index: 4,
		tag: 'input',
		role: 'textbox',
		label: 'Search',
		frame_id: 'F1',
	}, 'T1');
	assert(record !== null);
	assertEquals(Object.keys(record.payload).sort(), ['element_index', 'frame_id', 'label', 'role', 'tag']);
	for (const forbidden of ['element', 'attributes', 'html', 'text', 'value', 'xpath', 'selector']) {
		assert(!(forbidden in record.payload), `focus must not carry ${forbidden}`);
	}
});

Deno.test('redaction: the network idle counter emits one record per quiet transition', async () => {
	const seen: Array<{ inflight: number; quietMs: number }> = [];
	const counter = new NetworkIdleCounter({
		quietMs: 5,
		emit: (inflight, quietMs) => void seen.push({ inflight, quietMs }),
	});
	try {
		counter.started('r1');
		counter.started('r2');
		assertEquals(counter.inflight, 2);
		counter.finished('r1');
		assertEquals(seen.length, 0, 'still in flight');
		counter.finished('r2');
		await new Promise((resolve) => setTimeout(resolve, 30));
		assertEquals(seen, [{ inflight: 0, quietMs: 5 }]);
		// Quiet stays quiet: an edge, not a heartbeat.
		await new Promise((resolve) => setTimeout(resolve, 20));
		assertEquals(seen.length, 1);
	} finally {
		counter.dispose();
	}
});

Deno.test('redaction: a finish for a request never started is ignored', () => {
	let emitted = 0;
	const counter = new NetworkIdleCounter({ quietMs: 5, emit: () => void (emitted += 1) });
	try {
		counter.finished('never-started');
		assertEquals(counter.inflight, 0);
		assertEquals(emitted, 0);
	} finally {
		counter.dispose();
	}
});

Deno.test('redaction: a page-chosen filename cannot steer the failure enum (m-1)', () => {
	// Two of the watchdog's own templates interpolate the display name at
	// position 0, and the page chooses that name. A start anchor alone still let
	// it pick the value out of the closed enum.
	const steering = [
		'the session already tracks 0 downloads.pdf resolved outside the downloads directory and was refused',
		'the download exceeds the per-file limit of 0 bytes.pdf is not a regular file and was refused',
		"the session's downloads exceed the per-session limit of 0 bytes.pdf resolved outside the downloads directory and was refused",
	];
	for (const error of steering) {
		assertEquals(downloadFailureReason(error), 'browser-error', error.slice(0, 48));
	}
	// The real watchdog strings still classify, so nothing regressed the other way.
	assertEquals(downloadFailureReason('the session already tracks 100 downloads'), 'over-session-limit');
	assertEquals(
		downloadFailureReason('the download exceeds the per-file limit of 104857600 bytes'),
		'over-file-limit',
	);
	assertEquals(
		downloadFailureReason("the session's downloads exceed the per-session limit of 524288000 bytes"),
		'over-session-limit',
	);
	assertEquals(downloadFailureReason('the transfer exceeded the 300000 ms deadline'), 'interrupted');
	assertEquals(downloadFailureReason('the download was canceled'), 'canceled');
	assertEquals(downloadFailureReason('canceled by the server'), 'canceled');
});

Deno.test('events: a payload whose bulk is in its keys still fits the byte cap (m-3)', () => {
	// No shrink touches a field *name*, so the second pass exited over cap on a
	// payload built this way. Not reachable today; it is exactly the "a refactor
	// widened a payload" case the pass exists for.
	const ring = new SessionEventRing();
	const payload: Record<string, unknown> = {};
	for (let i = 0; i < 400; i++) payload[`field_name_number_${i}_with_a_long_key`] = i;
	const record = ring.append('tab', payload);
	assert(record !== null, 'the record survives');
	const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
	assert(bytes <= MAX_EVENT_BYTES, `record is ${bytes} bytes, cap ${MAX_EVENT_BYTES}`);
	assertEquals(record.payload.truncated, true);
});

Deno.test('events: a control record names no principal (m-4, I-8)', () => {
	// The ring is replayable to every mcp:invoke holder, and
	// browser_list_sessions publishes only human_has_control: boolean. Under
	// anonymous loopback the principal is `anonymous:<remoteAddr>`, so this would
	// have put a human's network address on an event stream.
	const ring = new SessionEventRing();
	const record = ring.appendControl('taken', { holder_name: 'viewer-ulid' });
	assert(record !== null);
	assert(!('principal' in record.payload), 'a control record carries no principal identity');
	assertEquals(record.payload.holder_name, 'viewer-ulid');
});

// --- SR1-A1b: the sliding window, and loss that says what it was ------------

Deno.test('events: a burst straddling the window boundary is charged once (SR1-A1b)', () => {
	// The measured defect: the window was re-anchored to `now` at each roll, so a
	// page placed 250 `dialog` records at 900 ms and 250 more at 1000 ms and got
	// 500 admitted in 100 ms against a budget that reads as 250 a second.
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 4096 });
	const flood = (count: number): number => {
		let accepted = 0;
		for (let i = 0; i < count; i++) {
			if (ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'x' }) !== null) accepted += 1;
		}
		return accepted;
	};

	time.advance(900);
	assertEquals(flood(400), STRUCTURAL_RATE_PER_SECOND, 'the first window admits exactly its budget');
	// The boundary the page chose. Under the fixed window this admitted a second
	// full budget; under the sliding one the previous window still weighs in full.
	time.advance(100);
	assertEquals(flood(400), 0, 'the straddle admits nothing: 250 in 100 ms is not 250 a second');

	// The charge decays across the new window rather than vanishing at its edge.
	time.advance(500);
	const halfway = flood(400);
	assert(halfway > 0 && halfway < STRUCTURAL_RATE_PER_SECOND, `half a window admits part of a budget, got ${halfway}`);

	// And any 1000 ms interval stays inside the budget. Two windows on, with the
	// carried charge fully decayed, a full budget is available again.
	time.advance(1500);
	assertEquals(flood(400), STRUCTURAL_RATE_PER_SECOND, 'a quiet second restores the whole budget');
});

Deno.test('events: a long silence carries no charge into the window that follows', () => {
	// Only an immediately preceding window overlaps the last 1000 ms. Charging a
	// page for traffic outside the window it is measured over would be a cap that
	// tightens with idleness, which is a different bug wearing this one's clothes.
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 4096 });
	let accepted = 0;
	for (let i = 0; i < 400; i++) {
		if (ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'x' }) !== null) accepted += 1;
	}
	assertEquals(accepted, STRUCTURAL_RATE_PER_SECOND);
	time.advance(10_000);
	assertEquals(ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'y' }) !== null, true);
});

Deno.test('events: the gap attributes the loss per kind, so a flood is distinguishable (SR1-A1b)', () => {
	// The finding: a consumer reading `dropped: 900` cannot tell "the page
	// flooded `dialog`" from "you were away too long", and the two want different
	// responses — re-read state, or stop trusting this page.
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 8 });
	// Two records the consumer cares about, then a flood that evicts them.
	ring.append('download.done', { file_id: 'f1', filename: 'a.pdf', status: 'completed' });
	ring.append('navigation', { origin: 'https://example.test', path: '/', has_query: false });
	for (let i = 0; i < 20; i++) {
		time.advance(20);
		ring.append('dialog', { dialog_id: `d${i}`, kind: 'alert', message: 'x' });
	}

	const out = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 });
	const gap = out[0];
	assert(gap !== undefined && gap.kind === 'gap');
	const byKind = gap.payload.by_kind as Record<string, number>;
	assertEquals(byKind.dialog !== undefined, true, 'the flooding kind is named');
	assertEquals(byKind['download.done'], 1, 'and so is the record the consumer actually wanted');
	assertEquals(byKind.navigation, 1);
	// The breakdown sums to the reported total: an attribution that did not would
	// be worse than none, because a consumer would reconcile against it.
	const total = Object.values(byKind).reduce((sum, count) => sum + count, 0);
	assertEquals(total, gap.payload.dropped);
});

Deno.test('events: a loss beyond the ledger reports by_kind null rather than a guess', () => {
	// `dropped: null` is already the convention for a count that cannot be known.
	// An attribution that cannot be known takes the same answer: a fabricated one
	// is worse than an admitted gap, because a consumer acts on it.
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 4 });
	for (let i = 0; i < 200; i++) {
		time.advance(20);
		ring.append('tab', { action: 'created' });
	}
	const out = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 });
	const gap = out[0];
	assert(gap !== undefined && gap.kind === 'gap');
	assertEquals(gap.payload.by_kind, null);
	// The count itself is still exact — only the breakdown is beyond reach.
	assertNotEquals(gap.payload.dropped, null);
});

Deno.test('events: an epoch change reports by_kind null beside dropped null', () => {
	const ring = new SessionEventRing();
	for (let i = 0; i < 3; i++) ring.append('tab', { action: 'created' });
	const out = ring.read({ kind: 'cursor', epoch: '00000000000000000000000000', seq: 1 });
	assertEquals(out[0]?.payload.dropped, null);
	assertEquals(out[0]?.payload.by_kind, null);
});

Deno.test('events: control, gap and bye stay uncapped, by name (SR1-A1b)', () => {
	// A flood must never be able to suppress the report of itself: the
	// `rate-capped` record is a `control`, and `gap` is the only signal of loss.
	// Asserted by name rather than by count, because a later editor moving one of
	// the three into the capped set is exactly the regression this defends.
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 8192 });
	for (let i = 0; i < 400; i++) ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'x' });
	let controls = 0;
	for (let i = 0; i < 400; i++) {
		if (ring.appendControl('taken', { principal: 'p' }) !== null) controls += 1;
	}
	assertEquals(controls, 400, 'control is never charged, even while a kind is being capped');
	// And the cap on the flooding kind is still reported, on the next window.
	time.advance(1000);
	ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'y' });
	const capped = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((record) => record.payload.event === 'rate-capped');
	assertEquals(capped.length, 1);
	assertEquals(capped[0]?.payload.kind, 'dialog');
});

Deno.test('events: a gap carrying every kind still fits the per-record byte cap', () => {
	// A `gap` is synthesized at read rather than pushed, so it does not pass
	// through `fitToByteCap`. Its size must therefore be bounded by construction:
	// `by_kind` holds at most one entry per kind in the vocabulary, and this is
	// the worst case measured rather than argued.
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 4 });
	const payloads: Record<string, Record<string, unknown>> = {
		navigation: { origin: 'https://example.test', path: '/', has_query: false },
		'dom.settled': { token: 't', mutations: 1, quiet_ms: 500 },
		'network.idle': { inflight: 0, quiet_ms: 500 },
		focus: { element_index: 0, tag: 'input', role: null, label: 'x', frame_id: null },
		input: { element_index: 0, kind: 'input', source: 'agent', value_masked: true },
		'download.started': { file_id: 'f', filename: 'a', status: 'inProgress' },
		'download.done': { file_id: 'f', filename: 'a', status: 'completed' },
		'download.failed': { file_id: 'f', filename: 'a', status: 'failed', reason: 'canceled' },
		dialog: { dialog_id: 'd', kind: 'alert', message: 'x' },
		console: { level: 'log', text: 'x' },
		tab: { action: 'created', tab_id: 't', opener_tab_id: null },
	};
	for (const [kind, payload] of Object.entries(payloads)) {
		time.advance(50);
		ring.append(kind as never, payload);
	}
	ring.appendControl('taken', { principal: 'p' });
	const gap = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })[0];
	assert(gap !== undefined && gap.kind === 'gap');
	const bytes = new TextEncoder().encode(JSON.stringify(gap)).length;
	assert(bytes <= MAX_EVENT_BYTES, `a gap must fit ${MAX_EVENT_BYTES} bytes, measured ${bytes}`);
	// And the breakdown really did carry many kinds rather than collapsing to one.
	assert(Object.keys(gap.payload.by_kind as Record<string, number>).length >= 8);
});
