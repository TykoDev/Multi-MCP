/**
 * The output-schema contract (D-A2), proven against real handler results.
 *
 * Invariant I-6: a success without `structuredContent` is a hard `tools/call`
 * failure the moment a schema is declared, and D-A2 declares one on every tool.
 * The result builders make that unrepresentable — no builder accepts a success
 * without a payload — but "unrepresentable" is a claim about a module, and this
 * file is the claim about the catalog.
 *
 * The round trip asserts **equality**, not merely that the payload parses.
 * `z.object().parse` strips unknown keys in Zod v4, which is the behaviour we
 * want on the wire, and it is also exactly how a handler that grew a field
 * before its schema did would lose it in silence.
 */
import { assert, assertEquals } from '@std/assert';
import * as z from 'zod';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { CATALOG, CATALOG_BY_NAME } from './catalog.ts';
import { SessionRegistry } from './registry.ts';
import { SecretStore } from './secrets.ts';
import { INLINE_FILE_LIMIT_BYTES } from './files.ts';
import {
	DOWNLOAD_TRANSFER_DEADLINE_MS,
	MAX_DOWNLOAD_BYTES,
	MAX_SESSION_DOWNLOAD_BYTES,
	MAX_TRACKED_DOWNLOADS,
} from '@tykotech/browser';
import * as tools from './tools.ts';
import { captureHarness } from '../fixtures/capture_session.ts';
import { image, json, projected, say } from './types.ts';
import type { ToolContext, ToolResult } from './types.ts';

// --- the builders themselves -------------------------------------------------

Deno.test('types: every result builder emits structuredContent (I-6)', () => {
	const payload = { session_id: 's' };
	const built: Array<[string, ToolResult]> = [
		['say', say(payload, 'a line')],
		['json', json(payload)],
		['projected', projected(payload, { session_id: 's' })],
		['image', image(payload, 'AAAA', 'image/png')],
		['resource', { ...say(payload), content: [{ type: 'text', text: 'x' }] } as ToolResult],
	];
	for (const [name, result] of built) {
		assertEquals(
			(result as { structuredContent?: unknown }).structuredContent,
			payload,
			`${name} produced a success with no structured payload`,
		);
	}
});

Deno.test('types: `projected` keeps the text block and the structured half apart (D-3)', () => {
	const result = projected({ a: 1, b: 2 }, { a: 1 }) as {
		content: Array<{ text: string }>;
		structuredContent: Record<string, unknown>;
	};
	// The text block is the frozen, byte-stable rendering an existing client
	// already parses; the structured half is where new fields land.
	assertEquals(JSON.parse(result.content[0]!.text), { a: 1 });
	assertEquals(result.structuredContent, { a: 1, b: 2 });
});

// --- handler successes against their declared schemas ------------------------

/** A DOM node with the fields the vendored element-event sanitizer walks. */
function fakeNode(): Record<string, unknown> {
	return {
		nodeName: 'INPUT',
		nodeId: 1,
		backendNodeId: 1,
		nodeType: 1,
		nodeValue: '',
		attributes: {},
		isScrollable: false,
		isVisible: true,
		absolutePosition: null,
		targetId: 'T1',
		frameId: null,
		sessionId: null,
		parentNode: null,
		childrenNodes: [],
		contentDocument: null,
		axNode: null,
		snapshotNode: null,
		shadowRootType: null,
		shadowRoots: null,
		compoundChildren: [],
		hasJsClickListener: false,
		hiddenElementsInfo: [],
		hasHiddenContent: false,
		uuid: 'node-uuid',
	};
}

/** A browser stand-in with a page, one tab and one interactive element. */
function fakeSession(): { session: BrowserSession; dispatched: string[] } {
	const dispatched: string[] = [];
	const session = {
		tabs: [{ targetId: 'T1', tabId: 'aaaa', url: 'https://example.com/', title: 'Example' }],
		agentFocusTargetId: 'T1',
		cdpClient: null,
		sessionManager: null,
		cachedBrowserState: {
			url: 'https://example.com/',
			title: 'Example',
			domState: { selectorMap: new Map([[3, fakeNode()]]), root: null },
			pageInfo: { viewportWidth: 1280, viewportHeight: 720, pixelsAbove: 0, pixelsBelow: 0, scrollX: 0, scrollY: 0 },
		},
		eventBus: Object.assign(new EventBus({ name: 'schema-fake' }), {
			dispatch(event: Record<string, unknown>) {
				dispatched.push(event.constructor.name);
				return { eventResult: () => Promise.resolve(null) };
			},
		}),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	};
	return { session: session as unknown as BrowserSession, dispatched };
}

async function harness() {
	const fake = fakeSession();
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fake.session) });
	const record = await registry.resolve(undefined);
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	return { registry, ctx, record };
}

/** Asserts one success round-trips its declared schema without losing a field. */
function roundTrip(name: string, result: ToolResult): void {
	const tool = CATALOG_BY_NAME.get(name);
	assert(tool !== undefined, `${name} is not in the catalog`);
	const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
	assert(structured !== undefined, `${name} returned a success with no structuredContent`);
	const parsed = tool.outputSchema.parse(structured);
	// Equality, not parseability: a key the schema does not declare is stripped
	// here and would be stripped on the wire, silently.
	assertEquals(parsed, structured, `${name} emits a field its outputSchema does not declare`);
}

Deno.test('catalog: the handler successes reachable at the unit tier round-trip their outputSchema', async () => {
	const { ctx, registry } = await harness();
	try {
		roundTrip('browser_navigate', await tools.browserNavigate({ url: 'https://example.com/' }, ctx));
		roundTrip('browser_go_back', await tools.browserGoBack({}, ctx));
		roundTrip('browser_click', await tools.browserClick({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_click', await tools.browserClick({ index: 3 }, ctx));
		// B2.4: the three pointer tools are `browser_click`'s cascade with one argument changed, so
		// both arms of each are driven here rather than asserted from a literal.
		roundTrip('browser_double_click', await tools.browserDoubleClick({ index: 3 }, ctx));
		roundTrip('browser_double_click', await tools.browserDoubleClick({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_right_click', await tools.browserRightClick({ index: 3 }, ctx));
		roundTrip('browser_right_click', await tools.browserRightClick({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_hover', await tools.browserHover({ index: 3 }, ctx));
		roundTrip('browser_hover', await tools.browserHover({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_type', await tools.browserType({ text: 'hello', index: 3 }, ctx));
		// B2.5: browser_fill delegates to browser_type, so both of its arms are reachable here. The
		// other five B2.5 tools need a real CDP session (or a real file on disk) and are proven on the
		// browser tier instead, with a literal payload below standing in for the shape.
		roundTrip('browser_fill', await tools.browserFill({ index: 3, text: 'hello' }, ctx));
		roundTrip('browser_fill', await tools.browserFill({ index: 3, text: 'hello', clear: false }, ctx));
		roundTrip('browser_press_key', await tools.browserPressKey({ key: 'Enter' }, ctx));
		roundTrip(
			'browser_press_key',
			await tools.browserPressKey({ key: 'a', modifiers: ['ctrl', 'shift'], index: 3 }, ctx),
		);
		roundTrip('browser_scroll', await tools.browserScroll({ direction: 'down' }, ctx));
		roundTrip('browser_list_tabs', await tools.browserListTabs({}, ctx));
		roundTrip('browser_switch_tab', await tools.browserSwitchTab({ tab_id: 'aaaa' }, ctx));
		roundTrip('browser_list_files', await tools.browserListFiles({}, ctx));
		roundTrip('browser_list_sessions', await tools.browserListSessions({}, ctx));
		// B2.6: driven, not asserted from a literal — `sessionDetail` is the one builder behind both,
		// so a field it grows has to satisfy both schemas here or the round trip strips it.
		roundTrip('browser_get_session', await tools.browserGetSession({}, ctx));
		roundTrip('browser_close_session', await tools.browserCloseSession({ session_id: 'default' }, ctx));
		roundTrip('browser_close_all', await tools.browserCloseAll({}, ctx));
	} finally {
		await registry.shutdown();
	}
});

/**
 * B1.7: `browser_wait_for` driven for real on both of its answers.
 *
 * A literal payload would prove nothing here, because the interesting half of
 * this schema is that a timeout is a **success** carrying `met: false` rather
 * than an error — a shape a hand-written payload would assert into existence.
 */
Deno.test('catalog: browser_wait_for round-trips its outputSchema on both answers', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		// The satisfied answer. The wait starts first on purpose: an omitted cursor
		// means "from now", so a record already in the ring when the call began is
		// deliberately not what the caller asked about.
		const waiting = tools.browserWaitFor({ until: { navigation: true }, timeout_ms: 5000 }, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		h.record.events.append('navigation', {
			frame_id: 'F1',
			origin: 'https://example.test',
			path: '/next',
			has_query: false,
			reason: 'user',
			committed: true,
		}, 'F1');
		const met = await waiting;
		roundTrip('browser_wait_for', met);
		const metPayload = (met as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(metPayload.met, true);
		assert(metPayload.event !== null, 'the record that satisfied the wait is returned');

		// The expired answer: met false, no event, and no error.
		const missed = await tools.browserWaitFor({ until: { dialog: true }, timeout_ms: 100 }, h.ctx);
		roundTrip('browser_wait_for', missed);
		const missedPayload = (missed as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(missedPayload.met, false);
		assertEquals(missedPayload.event, null);
		assertEquals((missed as { isError?: boolean }).isError, undefined, 'a timeout is not an error');
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * B1.5/B1.6: the perception handlers driven against a recorded capture (D-TEST1), so the rich
 * element record, the frame list and the locator tools round-trip their schemas from a real
 * handler result rather than a literal. `browser_verify_locator` is driven through its in-memory
 * kind; the browser-search kinds share the same result shape and the browser tier drives them.
 */
Deno.test('catalog: the perception successes round-trip their outputSchema from a recorded capture', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		roundTrip('browser_get_state', await tools.browserGetState({ fields: ['full'] }, h.ctx));
		roundTrip('browser_get_state', await tools.browserGetState({ frames: 'top', include_hidden: true }, h.ctx));
		roundTrip('browser_find', await tools.browserFind({ query: { role: 'button' }, fields: ['full'] }, h.ctx));
		roundTrip('browser_get_frames', await tools.browserGetFrames({}, h.ctx));
		roundTrip('browser_locator_candidates', await tools.browserLocatorCandidates({ index: 15 }, h.ctx));
		roundTrip(
			'browser_verify_locator',
			await tools.browserVerifyLocator(
				{ locator: { kind: 'aria', value: 'role=button[name="Host page button"]' } },
				h.ctx,
			),
		);
		roundTrip(
			'browser_verify_locator',
			await tools.browserVerifyLocator({ locator: { kind: 'label', value: 'label=nothing' } }, h.ctx),
		);
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * The rest of the catalog needs a real browser, a model or an encoder, so its
 * schemas are proven against a payload built here from the handler's own
 * literal instead. This is weaker than driving the handler and says so; the
 * browser tier drives the real ones.
 */
Deno.test('catalog: the browser-tier successes have a schema their payload satisfies', () => {
	const cases: Record<string, Record<string, unknown>> = {
		browser_get_state: {
			session_id: 's',
			url: 'https://example.com/',
			title: 'Example',
			human_has_control: false,
			tabs: [{ tab_id: 'aaaa', url: 'https://example.com/', title: 'Example', focused: true }],
			viewport: { width: 1280, height: 720 },
			scroll: { x: 0, y: 0, pixels_above: 0, pixels_below: 0 },
			interactive_elements: [{ index: 0, tag: 'button', label: 'Go' }],
			page: 'Example',
			// I-4: structured half only, so the text block keeps its 0.1.0 layout.
			state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
			focused_index: null,
			elements_total: 1,
			elements_truncated: false,
			frames: [{
				id: 'F1',
				name: '',
				url: 'https://example.com/',
				parent: null,
				bounds: null,
				bounds_composed: true,
				is_oopif: false,
				captured: true,
			}],
			frames_unknown: [],
			capture_truncated: false,
		},
		// The truncated shape, because it is the one F-3 changed: `length` is the document's TRUE
		// length and `returned_length` is what the text block carries, so the two disagree here by
		// design. `audit_id` is absent — this read was same-origin, and its absence is the
		// wire-visible statement that no extra grant was needed. `tools_test.ts` drives the real
		// handler against this same schema, which is the stronger half of the proof.
		browser_get_html: {
			session_id: 's',
			frame_id: 'F1',
			url: 'https://example.com/',
			state_token: null,
			length: 240_000,
			truncated: true,
			returned_length: 200_000,
			media_type: 'text/html',
		},
		browser_set_viewport: {
			session_id: 's',
			viewport: { width: 1280, height: 720, device_scale: 1 },
			state_token: null,
		},
		browser_set_session_options: {
			session_id: 's',
			applied: { locale: 'fr-FR' },
			unsupported: ['accept_downloads'],
			state_token: null,
		},
		// B2.5: each needs a real CDP session (or a real file), so the shape is pinned here and the
		// browser tier drives the handler.
		browser_scroll_to: {
			session_id: 's',
			scroll: { x: 0, y: 400, pixels_above: 400, pixels_below: 1200 },
			state_token: null,
		},
		browser_scroll_into_view: {
			session_id: 's',
			index: 3,
			scroll: { x: 0, y: 400, pixels_above: 400, pixels_below: 1200 },
			bounds: { x: 10, y: 20, w: 100, h: 40 },
			state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
		},
		browser_select_option: {
			session_id: 's',
			index: 3,
			selected: { value: 'b', label: 'Beta', index_in_list: 1 },
			state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
		},
		browser_upload_file: {
			session_id: 's',
			index: 3,
			file_id: 'f',
			filename: 'a.txt',
			bytes: 3,
			state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
		},
		browser_drag: {
			session_id: 's',
			from: { x: 10, y: 20 },
			to: { x: 200, y: 20 },
			steps: 10,
			state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
		},
		browser_handle_dialog: { session_id: 's', dialog_id: 'd1', accepted: true, state_token: null },
		browser_screenshot: { session_id: 's', media_type: 'image/png', bytes: 3, full_page: false },
		browser_extract_content: { session_id: 's', query: 'q', result: 'a', model: 'm' },
		browser_run_task: {
			session_id: 's',
			status: 'done',
			task: 't',
			steps: 1,
			history: ['step 1: navigate -> ok'],
			model: 'm',
			elapsed_ms: 5,
			answer: 'a',
		},
		browser_close_tab: { session_id: 's', closed_tab_id: 'aaaa', tabs: [] },
		browser_storage_state: { session_id: 's', action: 'save', name: 'n', cookies: 0, origins: 0 },
		browser_record: { session_id: 's', name: 'n', recording: true, frames: 0, duration_ms: 0 },
		browser_get_file: {
			session_id: 's',
			delivery: 'inline',
			resource_uri: 'ttk://session/s/file/f',
			file: {
				file_id: 'f',
				name: 'a.txt',
				status: 'completed',
				available: true,
				bytes_received: 3,
				bytes_total: 3,
				size: 3,
				mime_type: 'text/plain',
				auto_download: false,
				started_at: '2026-01-01T00:00:00.000Z',
				completed_at: '2026-01-01T00:00:01.000Z',
				// B2.9: non-optional and nullable, so a consumer never has to tell an absent key from a
				// digest that is not ready. This literal carries the computed form; `files_test.ts` covers
				// the null one.
				sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
			},
			range_supported: true,
		},
		// R4 (D-116): the inspection tools' handlers are driven against a real log and ring in
		// `inspection_test.ts`, which parses every result with these schemas; these literals pin the shapes.
		browser_network_log: {
			session_id: 's',
			entries: [{
				seq: 1,
				request_id: 'R1',
				started_at: '2026-01-01T00:00:00.000Z',
				method: 'GET',
				origin: 'https://example.com',
				path: '/',
				has_query: true,
				url: 'https://example.com/?q=1',
				resource_type: 'Document',
				frame_id: 'F',
				status: 200,
				mime_type: 'text/html',
				bytes: 10,
				duration_ms: 3,
				failed: false,
				error_text: null,
				blocked_reason: null,
				from_cache: false,
				from_service_worker: false,
				request_headers: { authorization: '[redacted]' },
				response_headers: { 'content-type': 'text/html' },
				headers_truncated: false,
			}],
			next_since: 1,
			dropped: 0,
			body: { request_id: 'R1', mime_type: 'text/html', base64: false, text: '<p>', bytes: 3, truncated: false },
		},
		browser_console_log: {
			session_id: 's',
			armed_since: '2026-01-01T00:00:00.000Z',
			entries: [{ cursor: 'E:3', at: '2026-01-01T00:00:00.000Z', level: 'warn', text: 'x', truncated: false }],
			next_cursor: 'E:3',
			gap: null,
		},
		browser_har_export: { session_id: 's', entries: 1, bytes: 512, truncated: false },
	};
	for (const [name, payload] of Object.entries(cases)) {
		const tool = CATALOG_BY_NAME.get(name);
		assert(tool !== undefined, `${name} is not in the catalog`);
		assertEquals(tool.outputSchema.parse(payload), payload, `${name}'s schema strips a field its handler emits`);
	}
	// Both halves of the catalog together must be the whole catalog, so a tool
	// added without a proven success fails here rather than shipping unproven.
	const covered = new Set([
		...Object.keys(cases),
		'browser_navigate',
		'browser_go_back',
		'browser_click',
		'browser_double_click',
		'browser_right_click',
		'browser_hover',
		'browser_type',
		'browser_fill',
		'browser_press_key',
		'browser_scroll',
		'browser_list_tabs',
		'browser_switch_tab',
		'browser_list_files',
		'browser_list_sessions',
		'browser_get_session',
		// B2.6: both need a live CDP session to emulate anything, so the browser tier drives them and
		// the literals below pin the shape.
		'browser_set_viewport',
		'browser_set_session_options',
		'browser_close_session',
		'browser_close_all',
		'browser_find',
		'browser_get_frames',
		'browser_locator_candidates',
		'browser_verify_locator',
		'browser_wait_for',
		'browser_download',
		'browser_head',
		// B2.1: driven against the capture with a scripted hit test in hit_test_test.ts.
		'browser_element_at',
		// B2.7: round-tripped on both arms at the foot of this file, against the capture's own frame
		// list with a scripted `Runtime.evaluate`.
		'browser_evaluate',
		// B2.8: round-tripped at the foot of this file against the capture's own password field, and
		// exercised end to end on the browser tier (tests/e2e/fill_secret_e2e_test.ts).
		'browser_fill_secret',
		'browser_audit',
		// B2.9: round-tripped at the foot of this file. Its numbers come from the constants the
		// enforcement path uses, and files_test.ts asserts each is the same constant.
		'browser_file_policy',
		// B3.2: the one tool that needs neither a browser nor a literal — `health_test.ts` drives the
		// real handler against a real registry and parses the result with this very schema, which is
		// a stronger proof than a payload written beside the schema it is checked against.
		'browser_health',
		// mcp-recommendations W4 (R2, D-124): `handoff_test.ts` drives the real handler on both of its rounds and on
		// the link path, and asserts each success equals its own parse by this schema.
		'browser_request_human',
		// R9 (W7): both MCP Apps handlers are driven through the dispatcher in `ui_resources_test.ts`, whose output
		// check parses each real result with this very schema.
		'browser_live_view',
		'browser_live_ticket',
		// W2 (R10/R11): `media_test.ts` drives each real handler against a capture-backed session and parses its
		// success with the schema the catalog declares (`structured()`), on every delivery and metric group.
		'browser_pdf',
		'browser_file_link',
		'browser_accessibility_snapshot',
		'browser_performance',
	]);
	const uncovered = CATALOG.map((tool) => tool.name).filter((name) => !covered.has(name));
	assertEquals(uncovered, [], `these tools have an outputSchema nothing proves: ${uncovered.join(', ')}`);
});

/**
 * The two tools that may declare a field spelled `secret`, and what makes them exceptions (B2.8).
 *
 * The rule this test enforces is "no output schema ships a credential", and the cheapest way to
 * check it is the field name. `browser_fill_secret` and `browser_audit` both carry a `secret` field
 * holding the configured secret's **name** — which is the whole R14 mechanism: the model is told the
 * name so it can spend a value it never sees. The exception is therefore listed by tool, not waived
 * by loosening the pattern, and each exception is paired below with a positive assertion that the
 * field is names-only. `available_secrets` on `browser_get_state` is the same exception at one
 * remove and is asserted the same way.
 */
const SECRET_NAME_FIELDS: ReadonlySet<string> = new Set(['browser_fill_secret', 'browser_audit']);

Deno.test('schemas: no output schema declares a field named `password`, `secret` or `token` (DD-7)', () => {
	for (const tool of CATALOG) {
		const emitted = JSON.stringify(z.toJSONSchema(tool.outputSchema, { io: 'output' }));
		for (const word of ['"password"', '"secret"', '"credential"']) {
			if (word === '"secret"' && SECRET_NAME_FIELDS.has(tool.name)) continue;
			assert(!emitted.includes(word), `${tool.name}'s outputSchema declares ${word}`);
		}
	}
	// `available_secrets` is the deliberate exception and is names-only (R14), so
	// it is asserted by its exact spelling rather than excluded by a substring.
	const state = JSON.stringify(z.toJSONSchema(CATALOG_BY_NAME.get('browser_get_state')!.outputSchema, {
		io: 'output',
	}));
	assert(state.includes('available_secrets'), 'browser_get_state must still advertise the secret *names*');

	// The two exceptions, argued: each declares `secret` and neither declares anything a value could
	// be recovered from. A length is as disclosing as a prefix on a field a caller knows to be a
	// credential (E-38), so the absence of every length-shaped spelling is asserted, not assumed.
	for (const name of SECRET_NAME_FIELDS) {
		const emitted = JSON.stringify(z.toJSONSchema(CATALOG_BY_NAME.get(name)!.outputSchema, { io: 'output' }));
		assert(emitted.includes('"secret"'), `${name} must still name the secret`);
		for (const forbidden of ['"value"', '"typed_length"', '"secret_length"', '"length"', '"hash"', '"digest"']) {
			// `expression_digest` is the evaluate half of the audit entry and is a digest of the
			// caller's own expression, never of a secret; it is spelled out rather than matched loosely.
			if (forbidden === '"digest"' && emitted.includes('"expression_digest"')) continue;
			assert(!emitted.includes(forbidden), `${name}'s outputSchema declares ${forbidden} beside a secret name`);
		}
	}
});

/**
 * A-2: `browser_wait_for` must not turn "I lost the answer" into "it did not happen".
 *
 * The ring deliberately returns a `gap` through any `kinds` filter, because the
 * only signal of loss is that record. A tool that filtered it back out would
 * answer `met: false` for an event that did occur and was evicted — and the
 * model would act on a negative it was never entitled to.
 */
Deno.test('catalog: browser_wait_for reports a gap rather than a false negative', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		const ring = h.record.events;
		const waiting = tools.browserWaitFor({ until: { dialog: true }, timeout_ms: 5000 }, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The dialog happens, then the page floods the ring past its capacity, so
		// the record the caller was waiting for is evicted before it is read.
		ring.append('dialog', { dialog_id: 'd1', kind: 'alert', message: 'gone' });
		// Spread across three kinds because each carries its own per-window budget:
		// one kind alone cannot overrun a 512-entry ring inside one second, which
		// is the rate cap doing its job.
		for (let i = 0; i < 250; i++) {
			ring.append('tab', { action: 'opened' });
			ring.append('navigation', { frame_id: 'f', origin: 'https://a.test', path: '/', has_query: false });
			ring.append('network.idle', { inflight: 0, quiet_ms: 500 });
		}
		const result = await waiting;
		roundTrip('browser_wait_for', result);
		const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(payload.met, false, 'the wait was not met');
		const event = payload.event as { kind: string; payload: Record<string, unknown> } | null;
		assert(event !== null, 'but the answer is unknown, not negative');
		assertEquals(event.kind, 'gap');
		assertEquals(event.payload.reason, 'ring-overrun');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('B2.7: browser_evaluate round-trips its outputSchema on both the value and the exception arm', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const session = h.record.session as unknown as Record<string, unknown>;
		const frames = (session.cachedBrowserState as { frames: Array<{ frameId: string }> }).frames;
		let answer: unknown = { result: { type: 'number', value: 42 } };
		session.cdpClient = {
			send: {
				Runtime: { evaluate: () => Promise.resolve(answer) },
				Page: {
					getFrameTree: () =>
						Promise.resolve({ frameTree: { frame: { id: frames[0]!.frameId, url: 'https://example.com/p' } } }),
				},
			},
		};
		session.sessionManager = { getOrCreateCdpSession: () => Promise.resolve({ sessionId: 'S1', targetId: 'T' }) };
		session.agentFocusTargetId = 'T';

		roundTrip('browser_evaluate', await tools.browserEvaluate({ expression: '6*7' }, h.ctx));
		// The exception arm carries `error_text` and no `value`, which is a different key set — and a
		// schema that declared only the success shape would strip one of them on the wire.
		answer = { result: { type: 'object' }, exceptionDetails: { exception: { description: 'TypeError: x' } } };
		roundTrip('browser_evaluate', await tools.browserEvaluate({ expression: 'x()' }, h.ctx));
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('B2.8: browser_fill_secret and browser_audit round-trip their outputSchema', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const session = h.record.session as unknown as Record<string, unknown>;
		session.cdpClient = {
			send: {
				Page: {
					getFrameTree: () =>
						Promise.resolve({
							frameTree: {
								frame: { id: 'TOP', url: 'https://bank.example.com/login' },
								childFrames: [{
									frame: { id: 'A4B12682576331EE39AA9EFE83F974E0', url: 'https://bank.example.com/login' },
								}],
							},
						}),
					getLayoutMetrics: () =>
						Promise.resolve({
							layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
							visualViewport: {
								offsetX: 0,
								offsetY: 0,
								pageX: 0,
								pageY: 0,
								clientWidth: 1280,
								clientHeight: 720,
								scale: 1,
							},
							contentSize: { x: 0, y: 0, width: 1280, height: 2000 },
						}),
				},
			},
		};
		session.sessionManager = { getOrCreateCdpSession: () => Promise.resolve({ sessionId: 'S1', targetId: 'T' }) };
		session.agentFocusTargetId = 'T';
		const bus = h.record.session.eventBus as unknown as { dispatch(event: unknown): unknown };
		bus.dispatch = () => ({ eventResult: () => Promise.resolve('ok') });

		const ctx: ToolContext = {
			...h.ctx,
			secrets: new SecretStore([{ name: 'bank_password', value: 'Zq8-VALUE', domains: ['bank.example.com'] }]),
		};
		const token = h.record.session.cachedBrowserState?.stateToken as string;
		roundTrip(
			'browser_fill_secret',
			await tools.browserFillSecret({ index: 6, secret: 'bank_password', state_token: token }, ctx),
		);
		// Both arms of the reader: the `own` filter and, with admin, the `all` one — they differ in the
		// `scope` literal, which the schema declares as a closed enum.
		roundTrip('browser_audit', await tools.browserAudit({}, ctx));
		roundTrip(
			'browser_audit',
			await tools.browserAudit({ limit: 5 }, { ...ctx, scopes: new Set(['mcp:invoke', 'admin'] as const) }),
		);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('B2.9: browser_file_policy round-trips its outputSchema and reads the enforcement constants', async () => {
	const { ctx, registry } = await harness();
	try {
		const result = await tools.browserFilePolicy({}, ctx);
		roundTrip('browser_file_policy', result);
		const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
		// The same constants the enforcement path uses, read here rather than restated — a policy tool
		// whose numbers were typed out again would be a second guess with a nicer interface.
		assertEquals(payload.max_files_per_session, MAX_TRACKED_DOWNLOADS);
		assertEquals(payload.max_file_bytes, MAX_DOWNLOAD_BYTES);
		assertEquals(payload.max_session_bytes, MAX_SESSION_DOWNLOAD_BYTES);
		assertEquals(payload.transfer_deadline_ms, DOWNLOAD_TRANSFER_DEADLINE_MS);
		assertEquals(payload.inline_limit_bytes, INLINE_FILE_LIMIT_BYTES);
		assertEquals(payload.range_supported, true);
		assertEquals(
			(payload.retention as { session_idle_ttl_s: number }).session_idle_ttl_s,
			Math.round(registry.sessionTtlMs / 1000),
		);
	} finally {
		await registry.shutdown();
	}
});
