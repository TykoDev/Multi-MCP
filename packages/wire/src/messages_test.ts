/**
 * The live-view wire contract. The SPA drops every message it cannot parse, so the property that matters is
 * additivity: an optional field stays optional, and a message without it still parses unchanged.
 */
import { assert, assertEquals } from '@std/assert';
import {
	ClientMsgSchema,
	EVENT_KINDS,
	EVENT_RECORD_KINDS,
	ServerMsgSchema,
	SSE_ONLY_EVENT_KINDS,
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

Deno.test('state: frames are optional, round-trip with their parent links, and every frame field is required', () => {
	const absent = roundTrip({ type: 'state', url: 'https://example.com/a', title: 'A' });
	assert(!Object.hasOwn(absent, 'frames'), 'an absent frame list must stay absent, not become []');
	roundTrip({ type: 'state', url: 'https://example.com/', title: 'A', frames: [] });
	roundTrip({
		type: 'state',
		url: 'https://example.com/a',
		title: 'A',
		frames: [
			{ frame_id: 'F0', parent_id: null, url: 'https://example.com/a', name: '' },
			{ frame_id: 'F1', parent_id: 'F0', url: 'https://other.test/embed', name: 'side' },
		],
	});
	for (const missing of ['frame_id', 'parent_id', 'url', 'name']) {
		const frame: Record<string, unknown> = { frame_id: 'F', parent_id: null, url: 'u', name: '' };
		delete frame[missing];
		const message = { type: 'state', url: 'u', title: 't', frames: [frame] };
		assert(!ServerMsgSchema.safeParse(message).success, `${missing} must be required`);
	}
});

Deno.test('tabs carry url and title; viewport and meta round-trip with their scale', () => {
	roundTrip({
		type: 'tabs',
		tabs: [
			{ tabId: 'A', url: 'https://example.com/one', title: 'One', focused: true },
			{ tabId: 'B', url: 'https://example.com/two', title: 'Two', focused: false },
		],
	});
	assert(!ServerMsgSchema.safeParse({ type: 'tabs', tabs: [{ tabId: 'A', focused: true }] }).success);
	roundTrip({ type: 'viewport', w: 1280, h: 662, frame_scale: 0.6667 });
	assert(!ServerMsgSchema.safeParse({ type: 'viewport', w: 1280.5, h: 662, frame_scale: 1 }).success);
	const meta = {
		type: 'meta',
		sessionId: 's',
		viewerId: 'v',
		mode: 'watch',
		viewport: { w: 1280, h: 720 },
		tabs: [],
		lock: null,
		version: '0.1.0',
	};
	roundTrip(meta);
	roundTrip({ ...meta, frame_scale: 0.5 });
});

Deno.test('the socket never carries page content, and gap/bye are wire kinds but not subscribable', () => {
	assertEquals(
		[...WS_EVENT_KINDS].sort(),
		EVENT_KINDS.filter((kind) => !(SSE_ONLY_EVENT_KINDS as readonly string[]).includes(kind)).sort(),
	);
	for (const kind of SSE_ONLY_EVENT_KINDS) assert(!WS_EVENT_KINDS.includes(kind), kind);
	for (const record of ['gap', 'bye']) {
		assert((EVENT_RECORD_KINDS as readonly string[]).includes(record), `${record} must be a wire kind`);
		assert(!(EVENT_KINDS as readonly string[]).includes(record), `${record} must not be subscribable`);
	}
});

Deno.test('an error message accepts every declared code and refuses an undeclared one', () => {
	for (const code of WS_ERROR_CODES) roundTrip({ type: 'error', code, message: 'x' });
	assert(!ServerMsgSchema.safeParse({ type: 'error', code: 'made-up', message: 'x' }).success);
});

Deno.test('input.key: modifiers parse as a bitmask or an array, and an empty array means none', () => {
	assert(ClientMsgSchema.safeParse({ type: 'input.key', kind: 'press', key: 'a', modifiers: [] }).success);
	assert(ClientMsgSchema.safeParse({ type: 'input.key', kind: 'press', key: 'a', modifiers: 0 }).success);
	assert(ClientMsgSchema.safeParse({ type: 'input.key', kind: 'down', key: 'a', modifiers: ['ctrl'] }).success);
});
