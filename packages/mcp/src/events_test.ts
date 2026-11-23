/** The event ring's bounds, its gap contract and its refcount. */

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
	navigationTarget,
	NetworkIdleCounter,
	parseCursor,
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
	for (const kind of SSE_ONLY_EVENT_KINDS) {
		const ring = new SessionEventRing({ capacity: 4096, maxRingBytes: 8 * 1024 * 1024, now: () => 1000 });
		let admitted = 0;
		for (let i = 0; i < STRUCTURAL_RATE_PER_SECOND + 10; i++) {
			if (ring.append(kind, { text: 'x' }) !== null) admitted += 1;
		}
		assertEquals(admitted, CONTENT_RATE_PER_SECOND, `${kind} is not held to the content budget`);
	}
});

Deno.test('kinds: a live-view socket filter admits no content kind, asserted at the ring', () => {
	const ring = new SessionEventRing({ now: () => 1000 });
	for (const kind of SSE_ONLY_EVENT_KINDS) ring.append(kind, { text: 'page content' });
	ring.append('navigation', { origin: 'https://a.test', path: '/', has_query: false });
	const records = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }, new Set(WS_EVENT_KINDS));
	assertEquals(records.map((record) => record.kind), ['navigation']);
});

Deno.test('events: the socket carries no content-bearing kind', () => {
	for (const kind of ['focus', 'input', 'console']) {
		assert(!WS_EVENT_KINDS.includes(kind as never), `${kind} must not be on the socket`);
	}
	assertEquals(WS_EVENT_KINDS.length, EVENT_KINDS.length - 3);
});

Deno.test('events: seq is per session, from 1, monotonic and never reused', () => {
	const ring = new SessionEventRing({ capacity: 4 });
	const seqs: number[] = [];
	for (let i = 0; i < 10; i++) {
		const record = ring.append('tab', { action: 'created', tab_id: `t${i}`, opener_tab_id: null }, `t${i}`);
		assert(record !== null);
		seqs.push(record.seq);
	}
	assertEquals(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assertEquals(ring.highWaterMark, 10);
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
	const ring = new SessionEventRing({ maxRingBytes: 4096 });
	for (let i = 0; i < 200; i++) ring.append('dialog', { dialog_id: `d${i}`, kind: 'alert', message: 'x'.repeat(512) });
	assert(ring.size < 200, 'the byte bound must have evicted');
	assert(ring.bytes <= 4096, `retained ${ring.bytes} bytes, cap 4096`);
	assertEquals(ring.highWaterMark, 200);
});

Deno.test('events: an over-long record is truncated at its one field and flagged, never dropped', () => {
	const ring = new SessionEventRing();
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

Deno.test('events: a data: line can never be split, whatever the payload holds', () => {
	const ring = new SessionEventRing();
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
	const out = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 2 });
	assertEquals(out[0]?.kind, 'gap');
	assertEquals(out[0]?.seq, 6);
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
	const ring = new SessionEventRing({ capacity: 4 });
	for (let i = 0; i < 10; i++) ring.append('tab', { action: 'created' });
	const first = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 2 });
	const gap = first[0];
	assert(gap !== undefined && gap.kind === 'gap');
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
	time.advance(RATE_WINDOW_MS_FOR_TEST);
	ring.append('console', { level: 'log', text: 'y' });
	const capped = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((r) => r.payload.event === 'rate-capped');
	assertEquals(capped.length, 1);
	assertEquals(capped[0]?.payload, { event: 'rate-capped', kind: 'console', dropped: 30 });
});

const RATE_WINDOW_MS_FOR_TEST = 1000;

Deno.test('events: structural kinds get a larger budget, not an exemption', () => {
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 4096 });
	let accepted = 0;
	for (let i = 0; i < 400; i++) {
		if (ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'x' }) !== null) accepted += 1;
	}
	assertEquals(accepted, STRUCTURAL_RATE_PER_SECOND);
	assert(STRUCTURAL_RATE_PER_SECOND > CONTENT_RATE_PER_SECOND, 'structural traffic keeps the looser budget');
	time.advance(1000);
	ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'y' });
	const capped = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((r) => r.payload.event === 'rate-capped');
	assertEquals(capped[0]?.payload, { event: 'rate-capped', kind: 'dialog', dropped: 150 });
});

Deno.test('events: control records are never capped, so a cap is always reported', () => {
	const ring = new SessionEventRing({ now: clock().now, capacity: 4096 });
	let accepted = 0;
	for (let i = 0; i < 400; i++) {
		if (ring.appendControl('taken', { principal: 'p' }) !== null) accepted += 1;
	}
	assertEquals(accepted, 400);
});

Deno.test('events: a page cannot pick a download failure reason through its filename', () => {
	for (const name of ['deadline.pdf', 'cancel.txt', 'per-file limit.doc']) {
		const error = `the browser reported ${name} as complete but no file exists at the vetted path`;
		assertEquals(downloadFailureReason(error), 'browser-error', name);
	}
});

Deno.test('events: a failed download never reports itself complete', () => {
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
	const ring = new SessionEventRing();
	const record = ring.append('tab', {
		action: 'opened',
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

Deno.test('the dialog claim is refcounted, announced, and arms on the zero transition only', () => {
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
	const events = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }).map((r) => r.payload.event);
	assertEquals(events, ['dialog-manual-armed', 'dialog-manual-disarmed']);
});

Deno.test('a subscriber that arrived before the callback is not lost', () => {
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
	const serialized = JSON.stringify(target);
	assert(!serialized.includes('SECRET'), 'the query must not survive in any field');
	assert(!serialized.includes('frag'), 'the fragment must not survive in any field');
	assert(!('url' in target), 'a field named url would be the lie this shape exists to avoid');
});

Deno.test('a navigation path drops matrix parameters and a data: payload, as the request log does', () => {
	const target = navigationTarget('https://a.test/x;jsessionid=1/y;p=2?q');
	assertEquals(target, { origin: 'https://a.test', path: '/x/y', has_query: true });
	assert(!JSON.stringify(target).includes('jsessionid'), 'a session id in a matrix parameter must not survive');
	assertEquals(
		navigationTarget('https://a.test/x;jsessionid=1/y;p=2?q').path,
		loggedPath('https://a.test/x;jsessionid=1/y;p=2?q'),
	);
	assertEquals(navigationTarget('data:text/plain;base64,c2VjcmV0').path, 'text/plain');
	assertEquals(navigationTarget('data:,Zq8-plain').path, '');
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
		assert(!('url' in payload), `${kind} must carry no url`);
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

Deno.test('redaction: no event kind may carry an element record', () => {
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

Deno.test('redaction: a page-chosen filename cannot steer the failure enum', () => {
	const steering = [
		'the session already tracks 0 downloads.pdf resolved outside the downloads directory and was refused',
		'the download exceeds the per-file limit of 0 bytes.pdf is not a regular file and was refused',
		"the session's downloads exceed the per-session limit of 0 bytes.pdf resolved outside the downloads directory and was refused",
	];
	for (const error of steering) {
		assertEquals(downloadFailureReason(error), 'browser-error', error.slice(0, 48));
	}
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

Deno.test('events: a payload whose bulk is in its keys still fits the byte cap', () => {
	const ring = new SessionEventRing();
	const payload: Record<string, unknown> = {};
	for (let i = 0; i < 400; i++) payload[`field_name_number_${i}_with_a_long_key`] = i;
	const record = ring.append('tab', payload);
	assert(record !== null, 'the record survives');
	const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
	assert(bytes <= MAX_EVENT_BYTES, `record is ${bytes} bytes, cap ${MAX_EVENT_BYTES}`);
	assertEquals(record.payload.truncated, true);
});

Deno.test('events: a control record names no principal', () => {
	const ring = new SessionEventRing();
	const record = ring.appendControl('taken', { holder_name: 'viewer-ulid' });
	assert(record !== null);
	assert(!('principal' in record.payload), 'a control record carries no principal identity');
	assertEquals(record.payload.holder_name, 'viewer-ulid');
});

// --- the sliding window, and loss that says what it was ---------------------

Deno.test('events: a burst straddling the window boundary is charged once', () => {
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
	time.advance(100);
	assertEquals(flood(400), 0, 'the straddle admits nothing: 250 in 100 ms is not 250 a second');

	time.advance(500);
	const halfway = flood(400);
	assert(halfway > 0 && halfway < STRUCTURAL_RATE_PER_SECOND, `half a window admits part of a budget, got ${halfway}`);

	time.advance(1500);
	assertEquals(flood(400), STRUCTURAL_RATE_PER_SECOND, 'a quiet second restores the whole budget');
});

Deno.test('events: a long silence carries no charge into the window that follows', () => {
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

Deno.test('events: the gap attributes the loss per kind, so a flood is distinguishable', () => {
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 8 });
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
	const total = Object.values(byKind).reduce((sum, count) => sum + count, 0);
	assertEquals(total, gap.payload.dropped);
});

Deno.test('events: a loss beyond the ledger reports by_kind null rather than a guess', () => {
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
	assertNotEquals(gap.payload.dropped, null);
});

Deno.test('events: an epoch change reports by_kind null beside dropped null', () => {
	const ring = new SessionEventRing();
	for (let i = 0; i < 3; i++) ring.append('tab', { action: 'created' });
	const out = ring.read({ kind: 'cursor', epoch: '00000000000000000000000000', seq: 1 });
	assertEquals(out[0]?.payload.dropped, null);
	assertEquals(out[0]?.payload.by_kind, null);
});

Deno.test('events: control, gap and bye stay uncapped, by name', () => {
	const time = clock();
	const ring = new SessionEventRing({ now: time.now, capacity: 8192 });
	for (let i = 0; i < 400; i++) ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'x' });
	let controls = 0;
	for (let i = 0; i < 400; i++) {
		if (ring.appendControl('taken', { principal: 'p' }) !== null) controls += 1;
	}
	assertEquals(controls, 400, 'control is never charged, even while a kind is being capped');
	time.advance(1000);
	ring.append('dialog', { dialog_id: 'd', kind: 'alert', message: 'y' });
	const capped = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((record) => record.payload.event === 'rate-capped');
	assertEquals(capped.length, 1);
	assertEquals(capped[0]?.payload.kind, 'dialog');
});

Deno.test('events: a gap carrying every kind still fits the per-record byte cap', () => {
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
	assert(Object.keys(gap.payload.by_kind as Record<string, number>).length >= 8);
});
