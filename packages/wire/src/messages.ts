/**
 * The live-view wire contract.
 *
 * This module is the single source of truth for both sides: the gateway
 * validates inbound messages with these schemas, and the SPA bundle imports
 * the very same file. A second copy would be a second contract.
 *
 * See SPECS/DATA-MODEL.md §6.
 */
import * as z from 'zod';

// --- the session event stream ----------------------------------------------

/**
 * The twelve subscribable event kinds (report_design.md §7.2).
 *
 * Declared here rather than in `packages/mcp` because three consumers share
 * one envelope — the SSE route, the live-view socket and `browser_wait_for` —
 * and a second declaration would be a second contract. `packages/wire` is not
 * a vendored package, so none of this carries an erratum.
 */
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
 * The two stream records.
 *
 * They are kind strings but **not** subscribable kinds: a `kinds` filter never
 * removes them, because a stream that could suppress its own loss record would
 * be worse than one carrying no loss record at all.
 */
export const EVENT_STREAM_KINDS = ['gap', 'bye'] as const;
export type EventStreamKind = (typeof EVENT_STREAM_KINDS)[number];

/** Every kind string that can appear on the wire — the twelve plus the two. */
export const EVENT_RECORD_KINDS = [
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
	'gap',
	'bye',
] as const;
export type EventRecordKind = (typeof EVENT_RECORD_KINDS)[number];

/**
 * The content-bearing kinds SSE carries and the socket does not.
 *
 * `WS_EVENT_KINDS` is **derived from this by subtraction**, deliberately rather
 * than written out. A hand-maintained socket list is correct only for as long as
 * every future editor retypes it correctly, and its failure direction is the bad
 * one: a new content kind added to `EVENT_KINDS` and mirrored into a literal
 * socket list would be served to a `view:watch` holder with nothing to catch it.
 * Subtraction makes the socket fail **closed** — a new kind is carried only once
 * someone decides it is not content.
 *
 * **This list has its consumer.** `packages/gateway/src/socketevents.ts` filters
 * every socket subscription through `WS_EVENT_KINDS` and answers a request for a
 * kind outside it with a `control {event:'kind-unavailable'}` record. It was
 * declared one revision before that transport existed so the rule would be in
 * force the moment the transport was, and it was labelled as awaiting a consumer
 * for exactly as long as that was true (SR2-m6).
 */
export const SSE_ONLY_EVENT_KINDS = ['focus', 'input', 'console'] as const satisfies readonly EventKind[];

/**
 * The kinds the live-view WebSocket may carry.
 *
 * `focus`, `input` and `console` are page **content**, and a live-view ticket is
 * minted on `view:watch` or `view:control` (SPECS/API-CONTRACT.md §4) which
 * carries no `mcp:invoke`. Serving them there would hand content to an
 * authority that does not have it. A subscribe naming one is answered with a
 * `control {event:'kind-unavailable'}` record rather than an error, because
 * killing a long-lived socket over one unavailable kind is worse than saying so.
 */
export const WS_EVENT_KINDS: readonly EventKind[] = EVENT_KINDS.filter(
	(kind) => !(SSE_ONLY_EVENT_KINDS as readonly string[]).includes(kind),
);

/**
 * One event record — the single envelope on both transports and in
 * `browser_wait_for`'s result (report_design.md §7.1).
 *
 * `seq` is allocated over the **unfiltered** stream, so a subscriber that
 * filtered `kinds` sees non-contiguous `seq` and that is **not** a gap. The
 * only signal of loss is a `gap` record. `tab_id` is `null` — never omitted —
 * for a session-scoped record, so a consumer never has to tell "absent" from
 * "not applicable".
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

export const TabInfoSchema = z.object({
	tabId: z.string(),
	/**
	 * Origin plus path — never the query or the fragment (SR1-A5).
	 *
	 * The field's *shape* is unchanged and always was `string`; what narrowed is
	 * its content. See the `state` message below for why, and
	 * `SPECS/SECURITY-AUTH.md` §8.3 for the rule.
	 */
	url: z.string(),
	title: z.string(),
	focused: z.boolean(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

/**
 * One frame of the focused tab, as the live view's address row needs it (B3.3, §1.4 / §3).
 *
 * **Deliberately not `FrameSummary`.** The tool-side record (`browser_get_frames`) carries composed
 * bounds and a `captured` marker, and both come from a DOM capture — which is the wrong cost to pay
 * on a message the server emits on every navigation. What a viewer needs is "which document am I
 * looking at, and what is inside it", so this is the identity and the parent link and nothing else,
 * read live from `Page.getFrameTree`.
 *
 * `url` is origin plus path, never the query or the fragment, by the same SR1-A5 rule that governs
 * `state.url` and `TabInfo.url`: a live-view ticket carries no `mcp:invoke`, and a frame URL is as
 * capable of holding a magic-link token as a top-level one.
 */
export const StateFrameSchema = z.object({
	frame_id: z.string(),
	/** `null` for the top document. The tree is reconstructable from these two fields alone. */
	parent_id: z.string().nullable(),
	url: z.string(),
	/** The frame element's `name` attribute, or an empty string. Structural, and how a frameset is read. */
	name: z.string(),
});
export type StateFrame = z.infer<typeof StateFrameSchema>;

export const LockInfoSchema = z.object({
	holder: z.string(),
	principal: z.string(),
	takenAt: z.number(),
	/**
	 * The holder's credential label (`ApiKeyRecord.label`), so a viewer can name who has the browser
	 * (B2.3, needed-browser-functions §3). `null` when the credential carries no label; optional so a
	 * pre-0.2.0 consumer parsing this schema is unaffected. Validated at config parse time (SEC-15):
	 * at most 64 printable characters, no `<`, `>`, `&` or newline, so no renderer has to escape it.
	 */
	holderName: z.string().nullable().optional(),
});
export type LockInfo = z.infer<typeof LockInfoSchema>;

/**
 * The element record as the live view's `hover` reply carries it (B2.1): the `core` preset of the
 * record `browser_get_state` emits, declared here because `packages/wire` cannot import the MCP
 * layer. The gateway builds it with the same builder as the tool, so the two cannot disagree, and
 * the password predicate has already run by the time a record reaches this schema. Descriptive
 * geometry only: `bounds` is where the server believes the element is (architecture §5.4).
 */
export const HoverElementSchema = z.object({
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
export type HoverElement = z.infer<typeof HoverElementSchema>;

export const WS_ERROR_CODES = [
	'not-holder',
	'lock-held',
	'bad-message',
	'navigation-blocked',
	/**
	 * A well-formed, correctly-locked input message the server could not carry
	 * out (B1.11, G-7).
	 *
	 * Additive to a closed five-value list. Safe for the bundled SPA, which takes
	 * `onError(code: string, message: string)` — a plain string, so widening this
	 * enum cannot break it.
	 */
	'input-rejected',
	/**
	 * A read the server cannot answer **yet**, and will be able to answer shortly (B2.3). Today its
	 * one producer is `live.keyframe` before the first frame of a tab has been cached: the server
	 * answers from its frame cache alone, because A-3 measured `Page.captureScreenshot` at roughly
	 * 1341 ms against a 1 ms cached answer and a viewer can drive that path at will. Distinct from
	 * `internal` (a fault) and from `input-rejected` (a well-formed input that cannot be carried out):
	 * the client's correct response is to wait for the next ordinary frame, not to retry or to report.
	 */
	'not-ready',
	/**
	 * F4 (ARCHITECTURE §5): the browser behind this session crashed or could not be reconnected, and the session is
	 * being torn down. Sent to every viewer just before the socket closes, so a client can say why the view ended.
	 */
	'browser-crashed',
	'internal',
] as const;
export type WsErrorCode = (typeof WS_ERROR_CODES)[number];

/**
 * Why an input was rejected. Closed, because a reason a client cannot enumerate
 * is prose with a field name.
 *
 * `session-not-connected` and `no-focused-tab` are **G-7**: until 0.2.0 those two
 * branches returned from the input dispatcher with no error, no answer and no
 * log, so a viewer that had taken control typed into a void and had no way to
 * learn it. `schema` accompanies the existing `bad-message` rather than
 * replacing it, so a client that sent a malformed field learns which half of
 * "malformed" it was without any existing code changing meaning.
 */
export const WS_ERROR_REASONS = [
	'schema',
	'session-not-connected',
	'no-focused-tab',
	'unsupported-key',
	'out-of-range',
] as const;
export type WsErrorReason = (typeof WS_ERROR_REASONS)[number];

export const ServerMsgSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('meta'),
		sessionId: z.string(),
		/**
		 * This connection's own viewer id. Without it a client cannot tell its
		 * own lock from someone else's, since `lock.holder` is just an id.
		 */
		viewerId: z.string(),
		mode: z.enum(['watch', 'control']),
		viewport: z.object({ w: z.number(), h: z.number() }),
		tabs: z.array(TabInfoSchema),
		lock: LockInfoSchema.nullable(),
		version: z.string(),
		/**
		 * The factor a screencast frame is scaled by relative to the viewport (B2.3, D-A6): a frame
		 * pixel divided by it is a top-document viewport CSS px. Computed server-side from the
		 * screencast's bound against the viewport, never inferred from the JPEG. Also on every frame's
		 * metadata as `scale`, and re-announced by `viewport` when it changes.
		 */
		frame_scale: z.number().optional(),
	}),
	z.object({ type: z.literal('tabs'), tabs: z.array(TabInfoSchema) }),
	z.object({ type: z.literal('lock'), lock: LockInfoSchema.nullable() }),
	/**
	 * The focused tab's address, as origin plus path.
	 *
	 * **`url` carries no query string and no fragment (SR1-A5).** The live-view
	 * socket is minted on `view:watch` or `view:control`, neither of which
	 * carries `mcp:invoke`, and `SPECS/SECURITY-AUTH.md` §8.3 forbids source URLs
	 * on the wire "(which may carry tokens)" — an OAuth implicit fragment or a
	 * magic-link query is exactly what a navigation URL holds. The same rule
	 * already governs the `navigation` event records, and it now governs every
	 * URL the socket emits rather than only some of them.
	 *
	 * This is a **deliberate behaviour change in a minor release**, not an
	 * additive one: the message type and the `url: string` field are unchanged in
	 * shape, and the field's content is narrowed. D-A9's additive-only premise is
	 * amended in `SPECS/DECISION-REGISTER.md` rather than quietly stretched.
	 */
	z.object({
		type: z.literal('state'),
		url: z.string(),
		title: z.string(),
		/**
		 * Every frame of the focused tab, top document first (B3.3, §1.4).
		 *
		 * **Optional, and its absence means "not known", never "no frames".** The list is a live
		 * `Page.getFrameTree` read, so a session with no CDP client, a target that went away between
		 * the navigation and the read, or a read that failed all omit it rather than publishing an
		 * empty array a client would reasonably take to mean the page has no subframes. A page that
		 * genuinely has none sends a one-element array: the top document is a frame.
		 *
		 * Additive, so a 0.1.0 consumer parsing this union is unaffected.
		 */
		frames: z.array(StateFrameSchema).optional(),
	}),
	/**
	 * One record from the session's event ring (B1.8).
	 *
	 * The envelope is the same `EventRecord` the SSE transport carries, so a
	 * consumer written against one transport reads the other. The mandatory first
	 * record of a subscription is a `control {event:'stream-open', epoch, seq}`:
	 * every stream states its epoch before it waits, or a client with nothing to
	 * receive could never learn which epoch it is waiting on.
	 */
	z.object({ type: z.literal('event'), event: EventRecordSchema }),
	z.object({
		type: z.literal('error'),
		code: z.enum(WS_ERROR_CODES),
		message: z.string(),
		/** Optional, so no existing consumer changes; closed, so a client can act on it. */
		reason: z.enum(WS_ERROR_REASONS).optional(),
	}),
	/**
	 * The 15-second keep-alive, formalised rather than removed (G-6, DD-8).
	 *
	 * The server has always sent this frame; it was simply absent from the union,
	 * so a strict client that validated every message rejected the stream. The
	 * bundled SPA works around it with a hard-coded exception *before* its own
	 * parse, so adding the member changes nothing there and unbreaks every other
	 * strict consumer.
	 */
	z.object({ type: z.literal('ping') }),
	/**
	 * The answer to `live.hover` (B2.1). `id` echoes the client's, because the socket has no
	 * request/response framing and two hovers in flight are otherwise indistinguishable. `element`
	 * is `null` when nothing interactive is under the point — a success, not an error. Answered by
	 * the browser's own hit test, the same one `browser_element_at` uses; never written to the ring.
	 */
	z.object({
		type: z.literal('hover'),
		id: z.string(),
		element: HoverElementSchema.nullable(),
		frame_id: z.string().nullable(),
	}),
	/**
	 * The **effective** screencast quality after server-side clamping (B2.3): a client must not
	 * assume its `live.quality` request was granted. Sent to the requester, and to every other
	 * viewer that has opted in with `events.subscribe` (the stream is shared, so the change is theirs
	 * too); a socket that never subscribed and never asked receives no message it did not know in 0.1.0.
	 */
	z.object({
		type: z.literal('quality'),
		scale: z.number(),
		jpeg_quality: z.number().int(),
		max_fps: z.number().int(),
	}),
	/**
	 * The viewport the frames are of, and the scale they are at (B2.3). Sent when the first frame
	 * arrives and whenever the frame size changes — after a `browser_set_viewport`, a page resize, a
	 * tab switch — to sockets that opted in with `events.subscribe`. Every frame carries `scale` in
	 * its own metadata regardless, so a client that never subscribed still has the factor per frame.
	 */
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
	 * One key, as a human's browser reports it (B1.11).
	 *
	 * **The three new fields are a behaviour repair inside a frozen message
	 * type, not a new message.** Until 0.2.0 this path forwarded `{key, code?,
	 * modifiers?}` and set no `windowsVirtualKeyCode`, so every keystroke a human
	 * sent through the live view reached the page with `event.keyCode === 0` —
	 * which is precisely the failure the key tables in
	 * `packages/browser/src/watchdogs/default_action_keys.ts` were written to
	 * prevent, and which the agent's own typing path had never had. The server
	 * now resolves the key through those same tables, so what a human does
	 * through the socket is reproducible by the tools with the same events. A
	 * client may still override any of the three.
	 *
	 * `modifiers` accepts an array as well as the bitmask, additively, so a client
	 * already sending `['ctrl','shift']` stops being wrong. An empty array is
	 * legal and means no modifiers — the requirement claimed that case was
	 * silently dropped, and it never was: an array failed validation and was
	 * answered with `bad-message`. What it lacked was a reason.
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
	/**
	 * One step of an IME composition (R13).
	 *
	 * `update` shows the in-progress reading in the page (Chrome fires
	 * `compositionstart`/`compositionupdate`); `commit` inserts the chosen text
	 * and ends the composition; `cancel` abandons it. Without this, taking
	 * control of the browser is unusable in every language that composes —
	 * synthesized `keydown`s carry the Latin keystrokes, not the characters.
	 */
	z.object({
		type: z.literal('input.composition'),
		kind: z.enum(['update', 'commit', 'cancel']),
		/** The in-progress reading, or the text to commit. Empty for `cancel`. */
		text: z.string().max(2048).default(''),
		/** Caret/selection within `text`, for the page's own composition UI. */
		selectionStart: z.number().int().min(0).optional(),
		selectionEnd: z.number().int().min(0).optional(),
	}),
	/**
	 * Subscribes this socket to the session's event ring (B1.8).
	 *
	 * The socket is the transport a **page** can use: a browser `EventSource`
	 * cannot set an `Authorization` header, so the SSE route is closed to it. In
	 * exchange the socket carries strictly less — `WS_EVENT_KINDS`, which excludes
	 * every content-bearing kind, because a live-view ticket carries no
	 * `mcp:invoke`.
	 *
	 * `since` is the opaque `<epoch>:<seq>` cursor a client stores and returns
	 * without parsing — the same token the SSE route publishes as its `id:` field.
	 * A bare integer with no epoch is deliberately treated as an epoch mismatch
	 * and answered with a `gap`, so a naive client gets the truth rather than a
	 * silent wait against a ring that no longer holds what it asked for. Omitted
	 * means from now, not from the beginning.
	 *
	 * A second `events.subscribe` replaces the first: two cursors interleaved into
	 * one ordered stream would destroy the ordering that is the contract.
	 */
	z.object({
		type: z.literal('events.subscribe'),
		kinds: z.array(z.string().max(64)).max(32).optional(),
		since: z.union([z.string().max(128), z.number().int()]).optional(),
	}),
	/** Ends the subscription. The socket stays open. */
	z.object({ type: z.literal('events.unsubscribe') }),
	/**
	 * What is under a point of the frame, in top-document viewport CSS px — the same space as
	 * `bounds` and as the frame once `meta.frame_scale` is divided out (B2.1, §3). Needs no lock and
	 * no control mode: it reads, and the reply is the `core` element record ADM draws its own
	 * tooltip from (D-A7). `id` is echoed on the `hover` reply.
	 */
	z.object({ type: z.literal('live.hover'), id: z.string().min(1).max(64), x: z.number(), y: z.number() }),
	/**
	 * A server-drawn outline around one element of the held table, or around a rectangle in
	 * top-document viewport CSS px (B2.2). Drawn by the DevTools overlay, so it never enters the DOM:
	 * `state_token` does not move and `browser_get_state` does not see it. Hidden after `ttl_ms`
	 * (default 2000, clamped to 100..30 000); a second highlight replaces the first. Best-effort, no
	 * reply: a highlight that could not be drawn is simply not drawn. Control mode is required — a
	 * highlight is visible to every viewer of the session — but not the lock.
	 */
	z.object({
		type: z.literal('live.highlight'),
		index: z.number().int().nonnegative().optional(),
		bounds: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
		ttl_ms: z.number().int().min(100).max(30_000).optional(),
	}).refine((v) => (v.index === undefined) !== (v.bounds === undefined), {
		message: 'provide exactly one of index or bounds',
	}),
	/**
	 * Asks for the current frame now (B2.3). Answered from the server's cached last frame — a cache
	 * lookup, not a capture — as an ordinary binary frame. **There is deliberately no capture
	 * fallback** (A-3, measured): before the first frame of a tab is cached the answer is
	 * `error{code:'not-ready'}` and the next paint arrives as an ordinary frame. Any viewer, no lock.
	 */
	z.object({ type: z.literal('live.keyframe') }),
	/**
	 * Adjusts the shared screencast (B2.3): `scale` of the 1280×720 bound, JPEG quality, and a frame
	 * rate ceiling. Clamped server-side and answered with the effective values in `quality`. Control
	 * mode is required — the stream is shared by every viewer of the session — but not the lock.
	 */
	z.object({
		type: z.literal('live.quality'),
		scale: z.number().min(0.1).max(1).optional(),
		jpeg_quality: z.number().int().min(1).max(100).optional(),
		max_fps: z.number().int().min(1).max(30).optional(),
	}),
	/**
	 * The answer to the server's `ping` (B6.1, F1).
	 *
	 * The keep-alive is an application-level JSON frame, not a WebSocket control
	 * frame, so **the browser does not answer it for us** — `Deno.upgradeWebSocket`
	 * hands back a standard `WebSocket`, which has no `ping()`, so the server
	 * cannot send a real control ping and cannot receive a real pong. Until this
	 * member existed the liveness bookkeeping was refreshed only by a client that
	 * happened to be *driving*, and a viewer that merely watched was closed as
	 * "unresponsive" on a fixed timer with no way to prevent it.
	 *
	 * Carries nothing: its arrival is the whole payload. A socket that sends one
	 * has proven it can, which is what lets the server hold a *silent* socket to a
	 * long grace window while reaping a proven-capable one that has gone quiet.
	 */
	z.object({ type: z.literal('pong') }),
	z.object({ type: z.literal('navigate'), url: z.string() }),
	z.object({ type: z.literal('tab.switch'), tabId: z.string() }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// --- binary frame envelope --------------------------------------------------

export const FrameMetaSchema = z.object({
	type: z.literal('frame'),
	seq: z.number(),
	ts: z.number(),
	/** The viewport the frame is of, in CSS px (`ScreencastFrameMetadata.deviceWidth/Height`). */
	w: z.number(),
	h: z.number(),
	targetId: z.string(),
	/**
	 * `frame_scale` for this frame (B2.3, D-A6): the JPEG is `w × scale` by `h × scale` pixels, and a
	 * frame pixel divided by `scale` is a top-document viewport CSS px. Optional so a frame from an
	 * older encoder still decodes.
	 */
	scale: z.number().optional(),
});
export type FrameMeta = z.infer<typeof FrameMetaSchema>;

/**
 * Packs one screencast frame: a big-endian `u32` metadata length, the UTF-8
 * JSON metadata, then the raw JPEG bytes.
 */
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

// --- the session event stream, continued -----------------------------------

/** The closed `control.event` vocabulary (report_design.md §7.2). */
export const CONTROL_EVENTS = [
	/**
	 * The mandatory first record on every stream, naming the epoch and the
	 * high-water mark. Without it a client that legitimately has nothing to
	 * receive could never learn which epoch it is waiting on — the original
	 * defect in miniature. Synthesized per stream, never retained in the ring.
	 */
	'stream-open',
	'taken',
	'released',
	'browser-recovered',
	/** F4: the browser crashed or could not be reconnected; the session is closed right after this record. */
	'browser-crashed',
	'console-armed',
	'console-disarmed',
	/**
	 * B2.5 / E-53. While a `dialog` subscriber is present the browser **holds** each JavaScript
	 * dialog open — bounded at 20 s — so `browser_handle_dialog` can answer it; with none, the
	 * automatic policy answers immediately as it always has. The transition is announced because it
	 * changes what a dialog *means* on the stream: armed, a `dialog` record is an open question, and
	 * disarmed it is a report of something already answered.
	 */
	'dialog-manual-armed',
	'dialog-manual-disarmed',
	'kind-unavailable',
	'rate-capped',
] as const;
export type ControlEvent = (typeof CONTROL_EVENTS)[number];

/** Why a stream ended. `stream-expired` is the 1800 s lifetime cap. */
export const EVENT_BYE_REASONS = [
	'session-closed',
	'server-shutdown',
	'stream-expired',
] as const;
export type EventByeReason = (typeof EVENT_BYE_REASONS)[number];

/** Why a `gap` record exists. `epoch-changed` carries `dropped: null` — the count is unknowable. */
export const EVENT_GAP_REASONS = ['ring-overrun', 'epoch-changed'] as const;
export type EventGapReason = (typeof EVENT_GAP_REASONS)[number];
