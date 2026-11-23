/** Output schemas for the tool catalog. */
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
	// Derived, never restated: a hand-written copy of `FileStatus` is free to
	// drift, and one wrong value makes every listing fail its own schema.
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
	/** `null` means "not computed", never "empty file". */
	sha256: z.string().nullable(),
});

/** One audit entry, exactly as `AuditLedger.append` mints it. */
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

/** One live session, as `SessionRegistry.list` builds it. */
const SessionSummary = z.object({
	session_id: z.string(),
	label: z.string().optional(),
	created_at: z.string(),
	last_used_at: z.string(),
	tab_count: z.number().int(),
	viewer_count: z.number().int(),
	human_has_control: z.boolean(),
	profile: z.string().optional(),
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

/** One locator candidate. */
export const LocatorCandidate = z.object({
	kind: z.enum(LOCATOR_KINDS),
	value: z.string(),
	unique: z.boolean(),
	matches: z.number().int(),
	frame_id: z.string(),
});

/** The live state of a form control. */
const InputState = z.object({
	type: z.string(),
	name: z.string(),
	value: z.string().nullable(),
	placeholder: z.string(),
	checked: z.boolean().nullable(),
});

/** One interactive element, as `observe` emits it. */
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

/** One frame of the page, as `browser_get_frames` reports it. */
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

/** The identity of the element table a result was computed against. */
const stateToken = z.string().nullable();

/** The success shape of every pointer click. */
const POINTER_CLICK = {
	session_id: sessionId,
	index: z.number().int().optional(),
	x: z.number().optional(),
	y: z.number().optional(),
	state_token: stateToken,
	download: FileInfo.optional(),
} as const;

/** The viewport a session is emulating. `device_scale` is device pixel ratio, never page scale. */
const Viewport = z.object({
	width: z.number().int(),
	height: z.number().int(),
	device_scale: z.number(),
});

/** One session as `sessionDetail` builds it. */
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
	// A timeout is `met: false`, not an error: a wait that expires is a truthful answer, and `isError` would abort
	// the model's turn over a fact.
	browser_wait_for: z.object({
		session_id: sessionId,
		met: z.boolean(),
		after_ms: z.number().int(),
		event: EventRecordSchema.nullable(),
		state_token: z.string().nullable(),
	}),
	browser_click: z.object(POINTER_CLICK),
	// No typed text and no prefix of it: the frozen text block already echoes what a non-secret type wrote, and a
	// second copy would be one more place a transcript keeps it. `sensitive` is the existing flag, surfaced.
	browser_type: z.object({
		session_id: sessionId,
		index: z.number().int().optional(),
		/**
		 * Absent when `sensitive` is true: the length of a server-held credential is not disclosed, and the frozen
		 * text block withholds it on that branch for the same reason.
		 */
		typed_length: z.number().int().optional(),
		sensitive: z.boolean(),
		state_token: stateToken,
	}),
	// `browser_double_click` and `browser_right_click` are `browser_click`'s cascade with one argument changed, so
	// they are its success shape too.
	browser_double_click: z.object(POINTER_CLICK),
	browser_right_click: z.object(POINTER_CLICK),
	// Where the pointer landed, not merely that it moved: a hover clamped to the viewport edge and a hover on the
	// element are indistinguishable to a caller reading "ok".
	browser_hover: z.object({
		session_id: sessionId,
		index: z.number().int().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		hover_x: z.number(),
		hover_y: z.number(),
		clamped: z.boolean(),
		/** **Optional, and absent means the check did not run**. */
		occluded: z.boolean().optional(),
		/** The tag of the element the pointer actually landed on. */
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
	// `cleared` is on the wire because it is the field that distinguishes this tool from
	// `browser_type`, and a caller that asked for `clear: false` deserves to see that it got it.
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
	// `bounds` is read live from the element's own frame.
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
	// `prompt_text` is deliberately absent from the result: it is caller-supplied, so echoing it buys no capability
	// and costs a second copy of possibly-sensitive text in the transcript.
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
	// Every field here is a NAME or a structure: the secret's name, the element index, the frame, the origin the pin
	// was evaluated against.
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
	// `scope` says which filter answered, so a reader knows whether it is looking at everything
	// or at its own entries; `dropped` makes a ring overflow visible rather than something a caller
	// has to infer from a gap in the timestamps.
	browser_audit: z.object({
		session_id: sessionId,
		entries: z.array(AuditEntry),
		dropped: z.number().int(),
		scope: z.enum(AUDIT_SCOPES),
	}),
	// `ok: false` is a page exception — a fact about the page the caller asked about, not a tool failure — so
	// `error_text` and `value` are the two halves of one answer and exactly one is present.
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
		 * Everything from here down is the structured half only. Absent from the text block, whose layout is frozen.
		 */
		state_token: stateToken,
		/** The *names* of secrets usable on this page. Never a value. */
		available_secrets: z.array(z.string()).optional(),
		/** The one focused element, or none; agrees with the array. */
		focused_index: z.number().int().nullable(),
		/** Always present: a consumer never infers truncation from a missing key. */
		elements_total: z.number().int(),
		elements_truncated: z.boolean(),
		frames: z.array(FrameSummary),
		frames_unknown: z.array(z.string()),
		capture_truncated: z.boolean(),
	}),
	// `score` is a ranking aid, not a probability.
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
	// `element: null` is a success. `resolution` says how the index was reached — a closed enum, so a client can tell
	// "the point is on static text inside a control" from "nothing interactive is there".
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
	// Metadata only. The document itself stays in the text block — copying 200 000 characters
	// into structuredContent would double the largest payload in the catalog.
	browser_get_html: z.object({
		session_id: sessionId,
		/** Which document these bytes came from. */
		frame_id: z.string(),
		/** That frame's own URL, read live at the moment of the read (see `page_eval.ts`). */
		url: z.string(),
		/** The element table the `frame_id` can be joined against, or `null` when this session holds none. */
		state_token: stateToken,
		/** The document's TRUE length in characters, truncated or not. */
		length: z.number().int(),
		/** `returned_length < length` — the text block is not the whole document. */
		truncated: z.boolean(),
		/** Characters actually carried in the text block, before the truncation notice is appended. */
		returned_length: z.number().int(),
		media_type: z.literal('text/html'),
		/** Present only on the cross-origin path, which is the only path that writes an audit entry of its own. */
		audit_id: z.string().optional(),
	}),
	// Metadata only again: the base64 stays in the image block.
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
		/** The origins a `load` restored, by name. */
		restored_origins: z.array(z.string()).optional(),
	}),
	// One shape, built by `sessionDetail`, so `browser_get_session` and the `details` half of
	// `browser_list_sessions` cannot describe a session differently.
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
		// `stream` is the same authenticated URL as `link`, with the endpoint's `Range`
		// support stated rather than left for a caller to try.
		delivery: z.enum(['inline', 'link', 'stream']),
		resource_uri: z.string(),
		file: FileInfo,
		http_url: z.string().nullable().optional(),
		http_auth: z.string().optional(),
		note: z.string().optional(),
		range_supported: z.boolean().optional(),
	}),
	// Every number is read from the constant that enforces it, so the tool and the enforcement path cannot disagree.
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
		 * Origin plus path of the **final** response, after every redirect this server followed and gated. No query,
		 * no fragment: a source URL's query can carry a token, so full source URLs never go on the wire.
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
	// `applied` and `unsupported` are the contract: the six options have six different degrees of plumbing behind
	// them, and a tool that answered "ok" for all six would be lying about at least one on some deployment.
	browser_set_session_options: z.object({
		session_id: sessionId,
		applied: z.record(z.string(), z.unknown()),
		unsupported: z.array(z.string()),
		state_token: z.null(),
	}),
	browser_list_sessions: z.object({
		sessions: z.array(SessionSummary),
		/** The same fields `browser_get_session` carries, one per live session. */
		details: z.array(z.object(SESSION_DETAIL)).optional(),
	}),
	browser_close_session: z.object({ session_id: sessionId, closed: z.literal(true) }),
	browser_close_all: z.object({ closed: z.number().int() }),
	/**
	 * `capabilities` is `z.record(...)` rather than a restatement of `TykotechCapabilities` on purpose: the block is
	 * built and scope-filtered by one function in `capabilities.ts`, and a second Zod description of the same object
	 * here would be a second contract free to drift from the one that is actually serialized.
	 */
	browser_health: z.object({
		status: z.enum(['ok', 'degraded']),
		version: z.string().nullable(),
		sessions: z.object({
			total: z.number().int(),
			/** Sessions whose browser answered a `Browser.getVersion` probe within 2 s. */
			browser_ok: z.number().int(),
			/** Sessions with a CDP client whose browser did not answer the probe in time. */
			browser_unresponsive: z.number().int(),
			human_has_control: z.number().int(),
			viewers: z.number().int(),
			tabs: z.number().int(),
		}),
		capabilities: z.record(z.string(), z.unknown()).optional(),
	}),
} as const satisfies Record<string, z.ZodObject<z.ZodRawShape>>;
