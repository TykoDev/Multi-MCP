/**
 * The live-view wire contract, round-tripped.
 *
 * `packages/wire` had no tests at all until B3.3, which is a gap worth naming: this module is the
 * *single* source of truth for both sides — the gateway validates inbound messages with these
 * schemas and the SPA bundle imports the very same file — so a change here is a change to two
 * programs at once. The tests that existed lived beside the consumers and asserted what those
 * consumers happened to send.
 *
 * What is asserted here is the property the whole union depends on: **additivity**. Every field this
 * delivery added is optional, and a message shaped exactly as 0.1.0 shaped it must still parse. The
 * SPA `safeParse`s every frame and drops the ones that fail, so a non-additive change would not throw
 * anywhere — it would make a viewer silently stop updating.
 */
import { assert, assertEquals } from '@std/assert';
import {
	ClientMsgSchema,
	EVENT_KINDS,
	EVENT_RECORD_KINDS,
	ServerMsgSchema,
	SSE_ONLY_EVENT_KINDS,
	StateFrameSchema,
	WS_ERROR_CODES,
	WS_EVENT_KINDS,
} from './messages.ts';

/** Parses and asserts the value survives unchanged — a strip is a silently dropped field. */
function roundTrip(message: unknown): Record<string, unknown> {
	const result = ServerMsgSchema.safeParse(message);
	assert(result.success, `the union rejected ${JSON.stringify(message)}: ${JSON.stringify(result.error?.issues)}`);
	assertEquals(result.data, message, 'the schema changed a message it accepted');
	return result.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// B3.3: state.frames
// ---------------------------------------------------------------------------

Deno.test('state: a 0.1.0-shaped message still parses, which is what additive means', () => {
	// No `frames` key at all. If this ever fails, every 0.1.0 consumer stops
	// updating — and does so silently, because the SPA drops frames it cannot parse.
	roundTrip({ type: 'state', url: 'https://example.com/a', title: 'A' });
});

Deno.test('state: frames round-trip with the parent link intact', () => {
	const message = {
		type: 'state',
		url: 'https://example.com/a',
		title: 'A',
		frames: [
			{ frame_id: 'F0', parent_id: null, url: 'https://example.com/a', name: '' },
			{ frame_id: 'F1', parent_id: 'F0', url: 'https://other.test/embed', name: 'side' },
			{ frame_id: 'F2', parent_id: 'F1', url: 'https://other.test/deep', name: '' },
		],
	};
	const parsed = roundTrip(message);
	// The tree is reconstructable from the two fields alone, which is the whole
	// reason `parent_id` is here rather than a nesting.
	const frames = parsed.frames as Array<{ frame_id: string; parent_id: string | null }>;
	assertEquals(frames.filter((f) => f.parent_id === null).map((f) => f.frame_id), ['F0']);
	assertEquals(frames.find((f) => f.frame_id === 'F2')?.parent_id, 'F1');
});

Deno.test('state: an empty frame array is legal and means something different from an absent one', () => {
	// Absent is "not known" — the read failed or there is no CDP client. An empty
	// array would be "this page has no frames", which is never true (the top
	// document is a frame), so the server never sends one. Both parse; the
	// distinction is a documented contract, and this test pins that both shapes
	// are representable so a later editor cannot collapse them with a `.min(1)`.
	roundTrip({ type: 'state', url: 'https://example.com/', title: 'A', frames: [] });
	const absent = roundTrip({ type: 'state', url: 'https://example.com/', title: 'A' });
	assert(!Object.hasOwn(absent, 'frames'), 'an absent frame list must stay absent, not become []');
});

Deno.test('state frame: every field is required, so a half-built frame is a parse failure', () => {
	assert(StateFrameSchema.safeParse({ frame_id: 'F', parent_id: null, url: 'u', name: '' }).success);
	for (const missing of ['frame_id', 'parent_id', 'url', 'name']) {
		const partial: Record<string, unknown> = { frame_id: 'F', parent_id: null, url: 'u', name: '' };
		delete partial[missing];
		assert(!StateFrameSchema.safeParse(partial).success, `${missing} must be required`);
	}
});

// ---------------------------------------------------------------------------
// §3: tabs carry url and title; the viewport notification
// ---------------------------------------------------------------------------

Deno.test('tabs: every tab carries url and title (§3, AC-P2-07)', () => {
	const message = {
		type: 'tabs',
		tabs: [
			{ tabId: 'A', url: 'https://example.com/one', title: 'One', focused: true },
			{ tabId: 'B', url: 'https://example.com/two', title: 'Two', focused: false },
		],
	};
	const parsed = roundTrip(message);
	const tabs = parsed.tabs as Array<{ url: string; title: string }>;
	assertEquals(tabs.map((tab) => tab.url), ['https://example.com/one', 'https://example.com/two']);
	assertEquals(tabs.map((tab) => tab.title), ['One', 'Two']);

	// And they are required, not optional: a tab list whose entries might omit a
	// URL would be one a client could never render an address row from.
	assert(!ServerMsgSchema.safeParse({ type: 'tabs', tabs: [{ tabId: 'A', focused: true }] }).success);
});

Deno.test('viewport: the resize notification round-trips with its recomputed scale (§3, AC-P2-08)', () => {
	roundTrip({ type: 'viewport', w: 1280, h: 662, frame_scale: 0.6667 });
	// `w`/`h` are frame pixels and integral; a fractional one is a bug in the
	// producer, so the schema refuses it rather than passing it to a renderer.
	assert(!ServerMsgSchema.safeParse({ type: 'viewport', w: 1280.5, h: 662, frame_scale: 1 }).success);
});

Deno.test('meta: frame_scale is optional, so a 0.1.0 meta still parses', () => {
	const base = {
		type: 'meta',
		sessionId: 's',
		viewerId: 'v',
		mode: 'watch',
		viewport: { w: 1280, h: 720 },
		tabs: [],
		lock: null,
		version: '0.1.0',
	};
	roundTrip(base);
	roundTrip({ ...base, frame_scale: 0.5 });
});

// ---------------------------------------------------------------------------
// The closed vocabularies this module owns
// ---------------------------------------------------------------------------

Deno.test('the socket kind list is the subtraction, never a second hand-written list', () => {
	// The failure direction is the bad one: a content kind added to EVENT_KINDS and
	// mirrored into a literal socket list would be served to a `view:watch` holder
	// with nothing to catch it. Asserting the arithmetic keeps the socket failing closed.
	assertEquals(
		[...WS_EVENT_KINDS].sort(),
		EVENT_KINDS.filter((kind) => !(SSE_ONLY_EVENT_KINDS as readonly string[]).includes(kind)).sort(),
	);
	for (const kind of SSE_ONLY_EVENT_KINDS) {
		assert(!WS_EVENT_KINDS.includes(kind), `${kind} is page content and must never ride the socket`);
	}
});

Deno.test('the two stream records are kind strings but not subscribable kinds', () => {
	// A `kinds` filter must never be able to remove a `gap`: a stream that could
	// suppress its own loss record is worse than one carrying none.
	for (const record of ['gap', 'bye']) {
		assert(EVENT_RECORD_KINDS.includes(record as never), `${record} must be a wire kind`);
		assert(!(EVENT_KINDS as readonly string[]).includes(record), `${record} must not be subscribable`);
	}
});

Deno.test('an error message accepts every declared code and refuses an undeclared one', () => {
	for (const code of WS_ERROR_CODES) roundTrip({ type: 'error', code, message: 'x' });
	assert(!ServerMsgSchema.safeParse({ type: 'error', code: 'made-up', message: 'x' }).success);
});

Deno.test('input.key: an empty modifiers array is legal and means no modifiers (G-7)', () => {
	// The requirement claimed this case was silently dropped. It never was — an
	// array failed validation and the next line answered `bad-message`. What it
	// lacked was a reason, and B1.11 gave it one. This pins that the array form
	// now parses, so the claim cannot become true again.
	const parsed = ClientMsgSchema.safeParse({ type: 'input.key', kind: 'press', key: 'a', modifiers: [] });
	assert(parsed.success, `an empty modifier array must parse: ${JSON.stringify(parsed.error?.issues)}`);
	assert(ClientMsgSchema.safeParse({ type: 'input.key', kind: 'press', key: 'a', modifiers: 0 }).success);
	assert(ClientMsgSchema.safeParse({ type: 'input.key', kind: 'down', key: 'a', modifiers: ['ctrl'] }).success);
});
