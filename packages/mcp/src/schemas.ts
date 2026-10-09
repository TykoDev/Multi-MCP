/**
 * Output schemas for the tool catalog (D-A2).
 *
 * Every one is object-rooted, and that is not a style choice. On the 2025 wire
 * codec a non-object schema root makes `projectCallToolResult` wrap the payload
 * as `{result: <value>}` while the 2026 codec's projection is the identity, so
 * a union or array root would silently change the wire shape between the two
 * eras this server serves; and `appendTextFallbackForNonObject` would inject a
 * text block at position 0, colliding with the frozen `Error: <code>: `
 * first-block convention. `ToolDefinition.outputSchema` is typed
 * `z.ZodObject`, so a non-object root is a compile error, and
 * `catalog_test.ts` asserts the emitted JSON Schema's `type` as well
 * (invariant I-5).
 *
 * The shapes are derived from what each handler actually emits, not from the
 * specification's prose: a schema written from prose describes a payload
 * nobody produces. Where a field is owed to a later slice — `state_token` to
 * B1.4, `frames` and `capture_truncated` to B1.6 — the key is declared now and
 * emitted as `null`, so the success shape does not move when the slice lands.
 */
import * as z from 'zod';
import { EventRecordSchema } from '@tykotech/wire';
import { AUDIT_KINDS, AUDIT_SCOPES } from './audit.ts';
import { FILE_STATUSES } from './files.ts';
import { LOCATOR_KINDS } from './locators.ts';

// --- shared fragments, declared once ----------------------------------------

/** The session a result belongs to. */
const sessionId = z.string();

/** One tab, exactly as `tabsOf` builds it. */
const Tab = z.object({
	tab_id: z.string(),
	url: z.string(),
	title: z.string(),
	focused: z.boolean(),
});

/** One tracked download, exactly as `fileInfoOf` builds it. */
const FileInfo = z.object({
	file_id: z.string(),
	name: z.string(),
	// Derived, never restated: this enum drifted from `FileStatus` the first time
	// it was written by hand, and the wrong value made every listing fail its own
	// schema.
	status: z.enum(FILE_STATUSES),
	available: z.boolean(),
	bytes_received: z.number(),
	bytes_total: z.number(),
	size: z.number(),
	mime_type: z.string(),
	auto_download: z.boolean(),
	started_at: z.string(),
	completed_at: z.string().nullable(),
	error: z.string().optional(),
	/**
	 * B2.9. `null` means "not computed", never "empty file". Non-optional on purpose: a consumer must
	 * never have to distinguish an absent key from a digest that is not ready.
	 */
	sha256: z.string().nullable(),
});

/**
 * One audit entry, exactly as `AuditLedger.append` mints it (B2.8, design §6.5).
 *
 * Derived from the module's own vocabularies rather than restated: `AUDIT_KINDS` and `AUDIT_SCOPES`
 * are the ledger's, and a hand-copied enum here would be a second declaration of the same contract,
 * free to drift — which `FileInfo`'s `status` already did once, before it was derived.
 *
 * What is **not** here is the point of the shape: no value, no prefix, no length or hash of one, no
 * expression body, no full URL. `expression_bytes` and `expression_digest` describe an expression the
 * caller already sent; there is no equivalent pair for a secret, and there must never be one.
 */
const AuditEntry = z.object({
	audit_id: z.string(),
	at: z.string(),
	session_id: z.string(),
	principal: z.string(),
	kind: z.enum(AUDIT_KINDS),
	frame_id: z.string(),
	/** Scheme, host and port — never a full URL, which may carry a token. */
	origin: z.string(),
	/** `secret-fill` only: the secret's NAME. */
	secret: z.string().optional(),
	index: z.number().int().optional(),
	/** `evaluate` only: how long the expression was. Never any part of it. */
	expression_bytes: z.number().int().optional(),
	/** `evaluate` only: 16 hex characters of SHA-256 over the expression. */
	expression_digest: z.string().optional(),
	result_bytes: z.number().int().optional(),
	ok: z.boolean().optional(),
});

/**
 * One live session, as `SessionRegistry.list` builds it — plus the two fields
 * the cluster fan-out adds.
 *
 * `node_id` and `node_url` are annotated by `packages/gateway/src/routing.ts`
 * when a `browser_list_sessions` is answered for the whole cluster, and they are
 * on the wire today. Declaring them optional is not a loosening: a `z.object`
 * emits `additionalProperties: false`, so an SDK *client* validating the
 * advertised schema rejects the whole result if the schema does not know about
 * them — which is exactly how the omission was found, on the browser tier.
 */
const SessionSummary = z.object({
	session_id: z.string(),
	label: z.string().optional(),
	created_at: z.string(),
	last_used_at: z.string(),
	tab_count: z.number().int(),
	viewer_count: z.number().int(),
	human_has_control: z.boolean(),
	profile: z.string().optional(),
	/** Present only on a cluster fan-out; absent on a single node. */
	node_id: z.string().optional(),
	node_url: z.string().optional(),
});

/** The scroll position, in the snake_case spelling the wire uses. */
const Scroll = z.object({
	x: z.number(),
	y: z.number(),
	pixels_above: z.number(),
	pixels_below: z.number(),
});

/** `{x, y, w, h}` in CSS px. */
export const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** One locator candidate (DD-4, design §5.1). */
export const LocatorCandidate = z.object({
	kind: z.enum(LOCATOR_KINDS),
	value: z.string(),
	unique: z.boolean(),
	matches: z.number().int(),
	frame_id: z.string(),
});

/** The live state of a form control (design §3.6). */
const InputState = z.object({
	type: z.string(),
	name: z.string(),
	value: z.string().nullable(),
	placeholder: z.string(),
	checked: z.boolean().nullable(),
});

/**
 * One interactive element, as `observe` emits it (design §3.1).
 *
 * The first five keys are the frozen 0.1.0 record and are always present when
 * they have a value; everything after `href` is selected by `fields` and lands
 * in `structuredContent` only (I-4).
 */
export const ObservedElement = z.object({
	index: z.number().int(),
	tag: z.string(),
	label: z.string().optional(),
	role: z.string().optional(),
	href: z.string().optional(),
	bounds: Rect.nullable().optional(),
	document_bounds: Rect.nullable().optional(),
	visible: z.boolean().optional(),
	enabled: z.boolean().optional(),
	focused: z.boolean().optional(),
	frame_id: z.string().optional(),
	frame: z.object({ id: z.string(), url: z.string() }).optional(),
	input: InputState.optional(),
	attrs: z.record(z.string(), z.string()).optional(),
	text: z.string().optional(),
	locator: LocatorCandidate.nullable().optional(),
	locators: z.array(LocatorCandidate).optional(),
});

/** One frame of the page (design §6.4 `browser_get_frames`, architecture §5.5). */
export const FrameSummary = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	parent: z.string().nullable(),
	bounds: Rect.nullable(),
	bounds_composed: z.boolean(),
	is_oopif: z.boolean(),
	captured: z.boolean(),
});

/**
 * The identity of the element table a result was computed against.
 *
 * Nullable rather than optional: a handler that has not minted one says so,
 * and a client can tell "this build does not carry a token" from "the key was
 * forgotten". B1.4 fills it.
 */
const stateToken = z.string().nullable();

/**
 * The success shape of every pointer click (B2.4).
 *
 * A raw shape rather than a `z.ZodObject`, because `browser_click`, `browser_double_click` and
 * `browser_right_click` are one cascade with one argument changed and must not be able to disagree
 * about what a click returns — while `catalog_test.ts` refuses two tools that share the same schema
 * *object*, on the sound ground that a shared instance in a 400-line literal is nearly always a
 * copy-paste. One shape, three instances, no drift.
 */
const POINTER_CLICK = {
	session_id: sessionId,
	index: z.number().int().optional(),
	x: z.number().optional(),
	y: z.number().optional(),
	state_token: stateToken,
	download: FileInfo.optional(),
} as const;

/** The viewport a session is emulating (B2.6). `device_scale` is device pixel ratio, never page scale. */
const Viewport = z.object({
	width: z.number().int(),
	height: z.number().int(),
	device_scale: z.number(),
});

/**
 * One session as `sessionDetail` builds it (B2.6).
 *
 * A raw shape rather than a `z.ZodObject` for `POINTER_CLICK`'s reason: `browser_get_session` and
 * `browser_list_sessions`' `details` must be the same shape (AC-P1-26) while `catalog_test.ts`
 * refuses two tools sharing one schema instance.
 */
const SESSION_DETAIL = {
	session_id: sessionId,
	profile: z.string().nullable(),
	created_at: z.string(),
	last_used_at: z.string(),
	/** `null` for a session that has been read but never driven — a different fact from "never used". */
	last_input_at: z.string().nullable(),
	viewport: Viewport.nullable(),
	tabs: z.array(Tab),
	holder: z.object({
		principal: z.string(),
		holder_name: z.string().nullable(),
		taken_at: z.string(),
	}).nullable(),
	human_has_control: z.boolean(),
	idle_timeout_s: z.number().int(),
	/** The list effective for THIS principal, not a server-wide default it may not be subject to. */
	origin_allowlist: z.array(z.string()),
	viewers: z.number().int(),
	files: z.number().int(),
	state_token: stateToken,
} as const;

// --- the catalog's output schemas -------------------------------------------

/**
 * Keyed by tool name so `catalog.ts` reads one line per entry and a schema
 * cannot be attached to the wrong tool by a copy-paste in a 400-line literal.
 */
export const OUTPUT = {
	browser_navigate: z.object({
		session_id: sessionId,
		url: z.string(),
		title: z.string(),
		profile: z.string().optional(),
	}),
	browser_go_back: z.object({
		session_id: sessionId,
		url: z.string(),
		title: z.string(),
	}),
	// A timeout is `met: false`, not an error: a wait that expires is a truthful
	// answer, and `isError` would abort the model's turn over a fact. `event` is
	// the ring record that satisfied the wait, or null when nothing did — and
	// also null for `network_idle`, which is answered by the quiescence probe
	// rather than by a retained record.
	browser_wait_for: z.object({
		session_id: sessionId,
		met: z.boolean(),
		after_ms: z.number().int(),
		event: EventRecordSchema.nullable(),
		state_token: z.string().nullable(),
	}),
	browser_click: z.object(POINTER_CLICK),
	// No typed text and no prefix of it: the frozen text block already echoes
	// what a non-secret type wrote, and a second copy would be one more place a
	// transcript keeps it. `sensitive` is the existing flag, surfaced.
	browser_type: z.object({
		session_id: sessionId,
		index: z.number().int().optional(),
		/**
		 * Absent when `sensitive` is true (E-38): the length of a server-held
		 * credential is not disclosed, and the frozen text block has always
		 * withheld it on that branch for the same reason.
		 */
		typed_length: z.number().int().optional(),
		sensitive: z.boolean(),
		state_token: stateToken,
	}),
	// B2.4. `browser_double_click` and `browser_right_click` are `browser_click`'s cascade with one
	// argument changed, so they are its success shape too. Built from `POINTER_CLICK` rather than
	// retyped: `catalog_test.ts` refuses a schema *object* shared between two tools, because that is
	// almost always a copy-paste, and three hand-copied shapes would be the drift it is guarding
	// against by another route. One shape, three instances.
	browser_double_click: z.object(POINTER_CLICK),
	browser_right_click: z.object(POINTER_CLICK),
	// B2.4. Where the pointer landed, not merely that it moved: a hover clamped to the viewport edge
	// and a hover on the element are indistinguishable to a caller reading "ok". `occluded` is a page
	// fact rather than a failure — the pointer is over whatever is on top, and `hit_tag` names it.
	browser_hover: z.object({
		session_id: sessionId,
		index: z.number().int().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		hover_x: z.number(),
		hover_y: z.number(),
		clamped: z.boolean(),
		/**
		 * **Optional, and absent means the check did not run** (security review B2-SR4-13). Only the
		 * element arm runs an occlusion probe; a coordinate hover has no element to be occluded
		 * relative to, and reporting `false` there would be a fact nobody established — the same
		 * honesty rule that makes the JavaScript click path omit its `clickCount`.
		 */
		occluded: z.boolean().optional(),
		/**
		 * The tag of the element the pointer actually landed on. Page-authored — a custom element's
		 * tag name is whatever the page called it — so it is **capped** (B2-SR4-4): the product's
		 * other page-controlled result string is truncated for the same reason, and a field a caller
		 * reads as server metadata must not be an unbounded channel from the page.
		 */
		hit_tag: z.string().max(64).nullable(),
		state_token: stateToken,
	}),
	browser_press_key: z.object({
		session_id: sessionId,
		/** The chord as dispatched, with any `modifiers` array folded in. */
		key: z.string(),
		modifiers: z.number().int(),
		index: z.number().int().optional(),
		state_token: stateToken,
	}),
	browser_scroll: z.object({
		session_id: sessionId,
		direction: z.string(),
		amount_px: z.number(),
		scroll: Scroll,
		state_token: stateToken,
	}),
	// B2.5. `cleared` is on the wire because it is the field that distinguishes this tool from
	// `browser_type`, and a caller that asked for `clear: false` deserves to see that it got it.
	// `typed_length` is absent on the sensitive branch for E-38's reason, exactly as in browser_type.
	browser_fill: z.object({
		session_id: sessionId,
		index: z.number().int(),
		cleared: z.boolean(),
		typed_length: z.number().int().optional(),
		sensitive: z.boolean(),
		state_token: stateToken,
	}),
	// `state_token` is `null` rather than the held token: a page scroll can reveal elements that were
	// never indexed, so the table the caller holds has stopped describing the page.
	browser_scroll_to: z.object({
		session_id: sessionId,
		scroll: Scroll,
		state_token: z.null(),
	}),
	// `bounds` is read live from the element's own frame. For a node in an out-of-process frame the
	// rect is in that frame's viewport space and cannot be composed into the top document's without
	// the arithmetic B1 removed, so it is `null` there rather than a number in the wrong space.
	browser_scroll_into_view: z.object({
		session_id: sessionId,
		index: z.number().int(),
		scroll: Scroll,
		bounds: Rect.nullable(),
		state_token: stateToken,
	}),
	// All three spellings of the chosen option, so a caller that selected by label can record the
	// value a later replay should send.
	browser_select_option: z.object({
		session_id: sessionId,
		index: z.number().int(),
		selected: z.object({ value: z.string(), label: z.string(), index_in_list: z.number().int() }),
		state_token: stateToken,
	}),
	browser_upload_file: z.object({
		session_id: sessionId,
		index: z.number().int(),
		file_id: z.string(),
		filename: z.string(),
		bytes: z.number().int(),
		state_token: stateToken,
	}),
	// `prompt_text` is deliberately absent from the result: it is caller-supplied, so echoing it buys
	// no capability and costs a second copy of possibly-sensitive text in the transcript.
	// `state_token` is null because answering a dialog lets the page run again — whatever table the
	// caller holds describes a page that is about to change.
	browser_handle_dialog: z.object({
		session_id: sessionId,
		dialog_id: z.string(),
		accepted: z.boolean(),
		state_token: z.null(),
	}),
	browser_drag: z.object({
		session_id: sessionId,
		from: z.object({ x: z.number(), y: z.number() }),
		to: z.object({ x: z.number(), y: z.number() }),
		steps: z.number().int(),
		state_token: stateToken,
	}),
	// B2.8. Every field here is a NAME or a structure: the secret's name, the element index, the
	// frame, the origin the pin was evaluated against. There is deliberately no `typed_length`, no
	// `bytes` and no `length` — E-38 is the reason that sentence exists, and this tool names the
	// credential explicitly, so a length here would be an enumeration oracle over every configured
	// secret rather than a hint about one.
	browser_fill_secret: z.object({
		session_id: sessionId,
		index: z.number().int(),
		/** The secret's NAME. Never the value, never anything derived from it. */
		secret: z.string(),
		frame_id: z.string(),
		/** Scheme, host and port of the frame the value was typed into — never a full URL. */
		origin: z.string(),
		state_token: stateToken,
		audit_id: z.string(),
	}),
	// B2.8. `scope` says which filter answered, so a reader knows whether it is looking at everything
	// or at its own entries; `dropped` makes a ring overflow visible rather than something a caller
	// has to infer from a gap in the timestamps.
	browser_audit: z.object({
		session_id: sessionId,
		entries: z.array(AuditEntry),
		dropped: z.number().int(),
		scope: z.enum(AUDIT_SCOPES),
	}),
	// B2.7. `ok: false` is a page exception — a fact about the page the caller asked about, not a
	// tool failure — so `error_text` and `value` are the two halves of one answer and exactly one is
	// present. `truncated` is on the wire because a silently cut result is a result a caller would
	// believe; `audit_id` correlates the call with the ledger without a second read.
	browser_evaluate: z.object({
		session_id: sessionId,
		frame_id: z.string(),
		ok: z.boolean(),
		/** The `RemoteObject` type, so `undefined` is distinguishable from "no value came back". */
		type: z.string(),
		value: z.unknown().optional(),
		truncated: z.boolean(),
		/** The page's own exception message, truncated by the handler rather than rejected here. */
		error_text: z.string().optional(),
		audit_id: z.string(),
	}),
	browser_get_state: z.object({
		session_id: sessionId,
		url: z.string(),
		title: z.string(),
		human_has_control: z.boolean(),
		tabs: z.array(Tab),
		viewport: z.object({ width: z.number(), height: z.number() }),
		scroll: Scroll,
		interactive_elements: z.array(ObservedElement),
		page: z.string(),
		/**
		 * I-4: everything from here down is the structured half only. Absent from
		 * the text block, which is frozen at its 0.1.0 layout.
		 */
		state_token: stateToken,
		/** R14: the *names* of secrets usable on this page. Never a value. */
		available_secrets: z.array(z.string()).optional(),
		/** I-15: the one focused element, or none; agrees with the array. */
		focused_index: z.number().int().nullable(),
		/** Always present: a consumer never infers truncation from a missing key. */
		elements_total: z.number().int(),
		elements_truncated: z.boolean(),
		frames: z.array(FrameSummary),
		frames_unknown: z.array(z.string()),
		capture_truncated: z.boolean(),
	}),
	// B1.6 (design §6.4, §5.3). `score` is a ranking aid, not a probability.
	browser_find: z.object({
		session_id: sessionId,
		state_token: stateToken,
		matches: z.array(ObservedElement.extend({ score: z.number().min(0).max(1) })),
		total: z.number().int(),
		unique: z.boolean(),
		truncated: z.boolean(),
	}),
	browser_get_frames: z.object({
		session_id: sessionId,
		state_token: stateToken,
		capture_truncated: z.boolean(),
		frames: z.array(FrameSummary),
	}),
	// B2.1 (design §6.4, architecture §5.4). `element: null` is a success. `resolution` says how the
	// index was reached — a closed enum, so a client can tell "the point is on static text inside a
	// control" from "nothing interactive is there".
	browser_element_at: z.object({
		session_id: sessionId,
		state_token: stateToken,
		x: z.number(),
		y: z.number(),
		element: ObservedElement.nullable(),
		frame_id: z.string().nullable(),
		resolution: z.enum(['direct', 'ancestor', 'none', 'no-node']),
	}),
	browser_locator_candidates: z.object({
		session_id: sessionId,
		state_token: stateToken,
		index: z.number().int(),
		frame_id: z.string(),
		locators: z.array(LocatorCandidate),
		best: LocatorCandidate.nullable(),
	}),
	browser_verify_locator: z.object({
		session_id: sessionId,
		state_token: stateToken,
		frame_id: z.string(),
		matches: z.number().int(),
		unique: z.boolean(),
		first: ObservedElement.nullable(),
	}),
	// I-3: metadata only. The document itself stays in the text block — copying 200 000 characters
	// into structuredContent would double the largest payload in the catalog.
	browser_get_html: z.object({
		session_id: sessionId,
		/**
		 * Which document these bytes came from. The top document's own frame id when `frame_id` was
		 * omitted, read LIVE from the frame tree rather than remembered from a capture, so a tab that
		 * navigated since the last observation is named correctly.
		 */
		frame_id: z.string(),
		/**
		 * That frame's own URL, read live at the moment of the read (SEC-07 doctrine, `page_eval.ts`).
		 * For the top document it is the page's URL; for a child frame it is the CHILD's, which is the
		 * whole point of the provenance — a frameset makes "the page's URL" ambiguous.
		 */
		url: z.string(),
		/**
		 * The element table the `frame_id` can be joined against, or `null` when this session holds
		 * none. NOT a freshness claim about the HTML: this tool mints no token and performs no
		 * observation, so the value is whatever `browser_get_state` last produced (I-D3).
		 */
		state_token: stateToken,
		/**
		 * The document's TRUE length in characters, truncated or not (F-3).
		 *
		 * **Measured, not believed (SEC-FH-24).** The count is produced in the page — the only place
		 * that can see the whole document — and is then floored on the server by the number of
		 * characters that actually arrived. An honest renderer always reports at least what it sends,
		 * so for every real document this is exactly the true length. A page that under-reports its
		 * own size to make an over-limit payload look bounded gets its claim replaced, and the field
		 * then reads as **"at least this many characters"**: a lower bound the server witnessed. It
		 * is never smaller than `returned_length`.
		 */
		length: z.number().int(),
		/**
		 * `returned_length < length` — the text block is not the whole document. Server-derived from
		 * those two numbers (SEC-FH-24), never from the page's opinion of the cap.
		 */
		truncated: z.boolean(),
		/**
		 * Characters actually carried in the text block, before the truncation notice is appended.
		 * Equals `length` when `truncated` is false, and never exceeds 200 000: it is the length of
		 * the string the server is sending, measured after the server's own clamp (SEC-FH-24).
		 * Present so a caller never has to recompute `min(length, 200000)` to know what it is
		 * holding — which is what the old lossy `length` forced.
		 */
		returned_length: z.number().int(),
		media_type: z.literal('text/html'),
		/**
		 * Present only on the cross-origin path, which is the only path that writes an audit entry
		 * (U-1, D-058). Its absence is the wire-visible statement that this read needed no extra grant.
		 */
		audit_id: z.string().optional(),
	}),
	// I-3 again: the base64 stays in the image block.
	browser_screenshot: z.object({
		session_id: sessionId,
		media_type: z.literal('image/png'),
		bytes: z.number().int(),
		full_page: z.boolean(),
	}),
	browser_extract_content: z.object({
		session_id: sessionId,
		query: z.string(),
		result: z.string(),
		model: z.string(),
	}),
	browser_run_task: z.object({
		session_id: sessionId,
		status: z.enum(['done', 'budget-exhausted']),
		task: z.string(),
		steps: z.number().int(),
		history: z.array(z.string()),
		model: z.string(),
		elapsed_ms: z.number(),
		answer: z.string().nullable(),
		resumable: z.boolean().optional(),
		hint: z.string().optional(),
	}),
	browser_list_tabs: z.object({ session_id: sessionId, tabs: z.array(Tab) }),
	browser_switch_tab: z.object({
		session_id: sessionId,
		focused_tab_id: z.string(),
		tabs: z.array(Tab),
	}),
	browser_close_tab: z.object({
		session_id: sessionId,
		closed_tab_id: z.string(),
		tabs: z.array(Tab),
	}),
	// Counts, never contents: the document holds live session cookies.
	browser_storage_state: z.object({
		session_id: sessionId,
		action: z.enum(['save', 'load']),
		name: z.string(),
		cookies: z.number().int(),
		origins: z.number().int(),
		/**
		 * B2.6 / SEC-19: the origins a `load` restored, by name. Present on `load` only — a save
		 * restored nothing, and an empty array there would read as "restored nothing" rather than
		 * "did not apply". Names only: no cookie name, no cookie value, no storage key, no storage
		 * value. A workflow asserts its login is present without the response becoming an inventory.
		 */
		restored_origins: z.array(z.string()).optional(),
	}),
	// B2.6. One shape, built by `sessionDetail`, so `browser_get_session` and the `details` half of
	// `browser_list_sessions` cannot describe a session differently (AC-P1-26).
	browser_get_session: z.object(SESSION_DETAIL),
	browser_record: z.object({
		session_id: sessionId,
		name: z.string().optional(),
		recording: z.boolean(),
		frames: z.number().int().optional(),
		duration_ms: z.number().optional(),
		bytes: z.number().int().optional(),
		url: z.string().optional(),
	}),
	browser_list_files: z.object({
		session_id: sessionId,
		files: z.array(FileInfo),
		inline_limit_bytes: z.number().int(),
	}),
	browser_get_file: z.object({
		session_id: sessionId,
		// B2.9 adds `stream`: the same authenticated URL as `link`, with the endpoint's `Range`
		// support stated rather than left for a caller to try.
		delivery: z.enum(['inline', 'link', 'stream']),
		resource_uri: z.string(),
		file: FileInfo,
		http_url: z.string().nullable().optional(),
		http_auth: z.string().optional(),
		note: z.string().optional(),
		range_supported: z.boolean().optional(),
	}),
	// B2.9. Every number is read from the constant that enforces it, so the tool and the enforcement
	// path cannot disagree. `retention.mode` rather than the hours the requirement asked for: the real
	// policy is the session's lifetime, and an invented constant would be a second guess.
	browser_file_policy: z.object({
		retention: z.object({
			mode: z.literal('session-lifetime'),
			session_idle_ttl_s: z.number().int(),
			open_read_grace_ms: z.number().int(),
		}),
		max_files_per_session: z.number().int(),
		max_file_bytes: z.number().int(),
		max_session_bytes: z.number().int(),
		inline_limit_bytes: z.number().int(),
		transfer_deadline_ms: z.number().int(),
		range_supported: z.boolean(),
	}),
	browser_download: z.object({
		session_id: sessionId,
		/** False is a **success**: the click navigated instead, or the browser is still deciding. */
		started: z.boolean(),
		file: FileInfo.nullable(),
		detect_ms: z.number().int().optional(),
		note: z.string().optional(),
	}),
	browser_head: z.object({
		status: z.number().int(),
		content_type: z.string().nullable(),
		/** `null` when the final response carried no Content-Length — never a guess. */
		content_length: z.number().int().nullable(),
		/** From Content-Disposition, decoded and sanitised; `null` when absent. */
		filename: z.string().nullable(),
		/**
		 * Origin plus path of the **final** response, after every redirect this
		 * server followed and gated (SR-HEAD-REDIRECT). No query, no fragment:
		 * SECURITY-AUTH §8.3 refuses source URLs on the wire.
		 */
		final_url: z.string(),
		/** Redirect hops followed; 0 when the first answer was final. */
		hops: z.number().int(),
	}),
	browser_set_viewport: z.object({
		session_id: sessionId,
		viewport: Viewport,
		state_token: z.null(),
	}),
	// `applied` and `unsupported` are the contract: the six options have six different degrees of
	// plumbing behind them, and a tool that answered "ok" for all six would be lying about at least
	// one on some deployment.
	browser_set_session_options: z.object({
		session_id: sessionId,
		applied: z.record(z.string(), z.unknown()),
		unsupported: z.array(z.string()),
		state_token: z.null(),
	}),
	browser_list_sessions: z.object({
		sessions: z.array(SessionSummary),
		/** B2.6: the same fields `browser_get_session` carries, one per live session (AC-P1-26). */
		details: z.array(z.object(SESSION_DETAIL)).optional(),
		/** Nodes that did not answer the fan-out. "These are the sessions" and
		 * "these are the sessions I could see" are different statements. */
		unreachable_nodes: z.array(z.string()).optional(),
	}),
	browser_close_session: z.object({ session_id: sessionId, closed: z.literal(true) }),
	browser_close_all: z.object({ closed: z.number().int() }),
	/**
	 * B3.2 / §8. `capabilities` is `z.record(...)` rather than a restatement of `TykotechCapabilities`
	 * on purpose: the block is built and scope-filtered by one function in `capabilities.ts`, and a
	 * second Zod description of the same object here would be a second contract free to drift from
	 * the one that is actually serialized. What this schema pins is the *health* half — the counts a
	 * caller polls — which nothing else declares.
	 */
	browser_health: z.object({
		status: z.enum(['ok', 'degraded']),
		version: z.string().nullable(),
		sessions: z.object({
			total: z.number().int(),
			/** Sessions whose browser answered a `Browser.getVersion` probe within 2 s (A4). */
			browser_ok: z.number().int(),
			/** A4: sessions with a CDP client whose browser did not answer the probe in time. */
			browser_unresponsive: z.number().int(),
			human_has_control: z.number().int(),
			viewers: z.number().int(),
			tabs: z.number().int(),
		}),
		capabilities: z.record(z.string(), z.unknown()).optional(),
	}),
} as const satisfies Record<string, z.ZodObject<z.ZodRawShape>>;
