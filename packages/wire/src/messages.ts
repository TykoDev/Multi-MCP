/**
 * The live-view wire contract: the gateway validates inbound messages with these schemas and the SPA bundle imports
 * the very same file, so the two cannot drift.
 */
import * as z from 'zod';

// --- the session event stream ----------------------------------------------

/** The twelve subscribable event kinds, shared by the SSE route, the live-view socket and `browser_wait_for`. */
export const EVENT_KINDS = [
	'navigation',
	'dom.settled',
	'network.idle',
	'focus',
	'input',
	'download.started',
	'download.done',
	'download.failed',
	'dialog',
	'console',
	'tab',
	'control',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Every kind string on the wire: the twelve plus the stream records `gap` and `bye`, which are not subscribable — a
 * `kinds` filter must never suppress a stream's own loss record.
 */
export const EVENT_RECORD_KINDS = [...EVENT_KINDS, 'gap', 'bye'] as const;
export type EventRecordKind = (typeof EVENT_RECORD_KINDS)[number];

/** The content-bearing kinds SSE carries and the socket does not. */
export const SSE_ONLY_EVENT_KINDS = ['focus', 'input', 'console'] as const satisfies readonly EventKind[];

/**
 * The kinds the live-view WebSocket may carry. Derived by subtraction so a new kind fails closed: a live-view ticket
 * (`view:watch`/`view:control`) carries no `mcp:invoke`, so page content must never ride the socket. A subscribe
 * naming another kind is answered with `control {event:'kind-unavailable'}`.
 */
export const WS_EVENT_KINDS: readonly EventKind[] = EVENT_KINDS.filter(
	(kind) => !(SSE_ONLY_EVENT_KINDS as readonly string[]).includes(kind),
);

/**
 * One event record, the single envelope on both transports and in `browser_wait_for`. `seq` counts the unfiltered
 * stream, so a filtered subscriber sees gaps in `seq` that are not loss; only a `gap` record signals loss. `tab_id`
 * is `null`, never omitted, for a session-scoped record.
 */
export const EventRecordSchema = z.object({
	kind: z.enum(EVENT_RECORD_KINDS),
	seq: z.number().int(),
	at: z.string(),
	tab_id: z.string().nullable(),
	payload: z.record(z.string(), z.unknown()),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

// --- server → client --------------------------------------------------------

// Every URL the socket emits is origin plus path, never query or fragment: the ticket carries no `mcp:invoke`, and
// an OAuth fragment or a magic-link query is exactly what a navigation URL holds.

const TabInfoSchema = z.object({ tabId: z.string(), url: z.string(), title: z.string(), focused: z.boolean() });
export type TabInfo = z.infer<typeof TabInfoSchema>;

/** One frame of the focused tab, read live from `Page.getFrameTree`; `parent_id` is `null` for the top document. */
const StateFrameSchema = z.object({
	frame_id: z.string(),
	parent_id: z.string().nullable(),
	url: z.string(),
	/** The frame element's `name` attribute, or an empty string. */
	name: z.string(),
});
export type StateFrame = z.infer<typeof StateFrameSchema>;

const LockInfoSchema = z.object({
	holder: z.string(),
	principal: z.string(),
	takenAt: z.number(),
	/** The holder's credential label, validated at config parse (≤ 64 printable characters, no `<>&` or newline). */
	holderName: z.string().nullable().optional(),
});
export type LockInfo = z.infer<typeof LockInfoSchema>;

/** The `core` element record the `hover` reply carries, built by the same builder as `browser_get_state`. */
const HoverElementSchema = z.object({
	index: z.number().int(),
	tag: z.string(),
	label: z.string().optional(),
	role: z.string().optional(),
	href: z.string().optional(),
	bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
	visible: z.boolean().optional(),
	enabled: z.boolean().optional(),
	focused: z.boolean().optional(),
	frame_id: z.string().optional(),
});

/**
 * `input-rejected`: a well-formed input the server could not carry out. `not-ready`: `live.keyframe` before the
 * tab's first frame is cached (wait for the next frame). `browser-crashed`: sent just before the socket closes.
 */
export const WS_ERROR_CODES = [
	'not-holder',
	'lock-held',
	'bad-message',
	'navigation-blocked',
	'input-rejected',
	'not-ready',
	'browser-crashed',
	'internal',
] as const;

/** Why an input was rejected; closed so a client can act on it. */
const WS_ERROR_REASONS = [
	'schema',
	'session-not-connected',
	'no-focused-tab',
	'unsupported-key',
	'out-of-range',
] as const;
export type WsErrorReason = (typeof WS_ERROR_REASONS)[number];

// Every optional field stays optional: the SPA drops messages it cannot parse, so a non-additive change would make a
// viewer silently stop updating.
export const ServerMsgSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('meta'),
		sessionId: z.string(),
		/** This connection's own viewer id, so a client can tell its own lock from someone else's. */
		viewerId: z.string(),
		mode: z.enum(['watch', 'control']),
		viewport: z.object({ w: z.number(), h: z.number() }),
		tabs: z.array(TabInfoSchema),
		lock: LockInfoSchema.nullable(),
		version: z.string(),
		/** Frame pixels per top-document viewport CSS px, computed server-side. */
		frame_scale: z.number().optional(),
	}),
	z.object({ type: z.literal('tabs'), tabs: z.array(TabInfoSchema) }),
	z.object({ type: z.literal('lock'), lock: LockInfoSchema.nullable() }),
	z.object({
		type: z.literal('state'),
		url: z.string(),
		title: z.string(),
		/** Top document first. Absent means "not known" (the read failed), never "no frames". */
		frames: z.array(StateFrameSchema).optional(),
	}),
	/** One ring record; a subscription's first record is always `control {event:'stream-open', epoch, seq}`. */
	z.object({ type: z.literal('event'), event: EventRecordSchema }),
	z.object({
		type: z.literal('error'),
		code: z.enum(WS_ERROR_CODES),
		message: z.string(),
		reason: z.enum(WS_ERROR_REASONS).optional(),
	}),
	/** The 15-second keep-alive; the client answers `pong`. */
	z.object({ type: z.literal('ping') }),
	/** The answer to `live.hover`, `id` echoed; `element` is `null` when nothing interactive is there. */
	z.object({
		type: z.literal('hover'),
		id: z.string(),
		element: HoverElementSchema.nullable(),
		frame_id: z.string().nullable(),
	}),
	/** The effective screencast quality after clamping; sent to the requester and to subscribed viewers. */
	z.object({
		type: z.literal('quality'),
		scale: z.number(),
		jpeg_quality: z.number().int(),
		max_fps: z.number().int(),
	}),
	/** The frames' viewport and scale, sent on the first frame and whenever it changes, to subscribed viewers. */
	z.object({
		type: z.literal('viewport'),
		w: z.number().int(),
		h: z.number().int(),
		frame_scale: z.number(),
	}),
	z.object({
		type: z.literal('bye'),
		reason: z.enum(['session-closed', 'server-shutdown', 'idle-timeout']),
	}),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;

// --- client → server --------------------------------------------------------

export const ClientMsgSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('control.take') }),
	z.object({ type: z.literal('control.release') }),
	z.object({
		type: z.literal('input.mouse'),
		kind: z.enum(['move', 'down', 'up', 'click']),
		x: z.number(),
		y: z.number(),
		button: z.enum(['left', 'middle', 'right']).optional(),
		clickCount: z.number().int().min(1).max(3).optional(),
	}),
	/**
	 * One key, resolved through the same key tables as the agent's typing path. `modifiers` is a bitmask or an array
	 * of names; an empty array means none.
	 */
	z.object({
		type: z.literal('input.key'),
		kind: z.enum(['down', 'up', 'press']),
		key: z.string(),
		code: z.string().optional(),
		text: z.string().optional(),
		modifiers: z.union([
			z.number().int().min(0).max(15),
			z.array(z.enum(['alt', 'ctrl', 'meta', 'shift', 'option', 'cmd', 'command', 'super', 'win'])).max(9),
		]).optional(),
		windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
		location: z.number().int().min(0).max(3).optional(),
		autoRepeat: z.boolean().optional(),
	}),
	z.object({
		type: z.literal('input.wheel'),
		x: z.number(),
		y: z.number(),
		deltaX: z.number(),
		deltaY: z.number(),
	}),
	/** One IME composition step: `update` shows the reading, `commit` inserts `text`, `cancel` abandons it. */
	z.object({
		type: z.literal('input.composition'),
		kind: z.enum(['update', 'commit', 'cancel']),
		text: z.string().max(2048).default(''),
		selectionStart: z.number().int().min(0).optional(),
		selectionEnd: z.number().int().min(0).optional(),
	}),
	/**
	 * Subscribes to the session's event ring, `WS_EVENT_KINDS` only. `since` is the opaque `<epoch>:<seq>` cursor; a
	 * bare integer is treated as an epoch mismatch and answered with a `gap`. A second subscribe replaces the first.
	 */
	z.object({
		type: z.literal('events.subscribe'),
		kinds: z.array(z.string().max(64)).max(32).optional(),
		since: z.union([z.string().max(128), z.number().int()]).optional(),
	}),
	z.object({ type: z.literal('events.unsubscribe') }),
	/** What is under a point, in top-document viewport CSS px; no lock or control mode needed. */
	z.object({ type: z.literal('live.hover'), id: z.string().min(1).max(64), x: z.number(), y: z.number() }),
	/**
	 * A DevTools-overlay outline around one element or a rectangle, hidden after `ttl_ms` (default 2000). Control mode
	 * required (every viewer sees it), not the lock.
	 */
	z.object({
		type: z.literal('live.highlight'),
		index: z.number().int().nonnegative().optional(),
		bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
		ttl_ms: z.number().int().min(100).max(30_000).optional(),
	}).refine((v) => (v.index === undefined) !== (v.bounds === undefined), {
		message: 'provide exactly one of index or bounds',
	}),
	/** The cached last frame, now; never a capture (a capture costs over a second). */
	z.object({ type: z.literal('live.keyframe') }),
	/** Adjusts the shared screencast, clamped server-side and answered with `quality`. Control mode required. */
	z.object({
		type: z.literal('live.quality'),
		scale: z.number().min(0.1).max(1).optional(),
		jpeg_quality: z.number().int().min(1).max(100).optional(),
		max_fps: z.number().int().min(1).max(30).optional(),
	}),
	/** The answer to `ping`: a browser `WebSocket` cannot answer a JSON keep-alive by itself. */
	z.object({ type: z.literal('pong') }),
	z.object({ type: z.literal('navigate'), url: z.string() }),
	z.object({ type: z.literal('tab.switch'), tabId: z.string() }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// --- binary frame envelope --------------------------------------------------

const FrameMetaSchema = z.object({
	type: z.literal('frame'),
	seq: z.number(),
	ts: z.number(),
	/** The viewport the frame is of, in CSS px. */
	w: z.number(),
	h: z.number(),
	targetId: z.string(),
	/** `frame_scale` for this frame. */
	scale: z.number().optional(),
});
export type FrameMeta = z.infer<typeof FrameMetaSchema>;

/** Packs one screencast frame: a big-endian `u32` metadata length, the UTF-8 JSON metadata, then the JPEG bytes. */
export function encodeFrame(meta: FrameMeta, jpeg: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode(JSON.stringify(meta));
	const out = new Uint8Array(4 + header.length + jpeg.length);
	new DataView(out.buffer).setUint32(0, header.length, false);
	out.set(header, 4);
	out.set(jpeg, 4 + header.length);
	return out;
}

/** Unpacks a frame produced by {@linkcode encodeFrame}. */
export function decodeFrame(buffer: ArrayBuffer): { meta: FrameMeta; jpeg: Uint8Array } {
	const bytes = new Uint8Array(buffer);
	if (bytes.length < 4) throw new Error('frame shorter than its length prefix');
	const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
	if (headerLength > bytes.length - 4) throw new Error('frame metadata length exceeds the payload');
	const meta = FrameMetaSchema.parse(
		JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))),
	);
	return { meta, jpeg: bytes.subarray(4 + headerLength) };
}

// --- the closed stream vocabularies -------------------------------------------

/**
 * The `control.event` vocabulary. `stream-open` is the mandatory first record of every stream (its epoch and
 * high-water mark). While a `dialog` subscriber is present, dialogs are held open (up to 20 s) for
 * `browser_handle_dialog`; the `dialog-manual-*` pair announces that change of meaning.
 */
const CONTROL_EVENTS = [
	'stream-open',
	'taken',
	'released',
	'browser-recovered',
	'browser-crashed',
	'console-armed',
	'console-disarmed',
	'dialog-manual-armed',
	'dialog-manual-disarmed',
	'kind-unavailable',
	'rate-capped',
] as const;
export type ControlEvent = (typeof CONTROL_EVENTS)[number];

/** Why a stream ended. `stream-expired` is the 1800 s lifetime cap. */
const EVENT_BYE_REASONS = ['session-closed', 'server-shutdown', 'stream-expired'] as const;
export type EventByeReason = (typeof EVENT_BYE_REASONS)[number];
