/** The output-schema contract, proven against real handler results. */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import * as z from 'zod';
import {
	type BrowserSession,
	DOWNLOAD_TRANSFER_DEADLINE_MS,
	MAX_DOWNLOAD_BYTES,
	MAX_SESSION_DOWNLOAD_BYTES,
	MAX_TRACKED_DOWNLOADS,
} from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { CATALOG, CATALOG_BY_NAME } from './catalog.ts';
import { SessionRegistry } from './registry.ts';
import { SecretStore } from './secrets.ts';
import { INLINE_FILE_LIMIT_BYTES } from './files.ts';
import * as tools from './tools.ts';
import { captureHarness, captureSession, loadCapture } from '../fixtures/capture_session.ts';
import { image, json, projected, say, type ToolContext, type ToolResult } from './types.ts';
import { join } from '@std/path';
import { EXTENSION_OUTPUT, extensionTools } from './extension_tools.ts';
import { LibraryStore } from './library.ts';
import { LIBRARY_OUTPUT, libraryTools } from './library_tools.ts';
import { SCOPES } from './scopes.ts';
import { createToolExecutor } from './server.ts';

// --- the builders themselves -------------------------------------------------

Deno.test('types: every result builder emits structuredContent', () => {
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

Deno.test('types: `projected` keeps the text block and the structured half apart', () => {
	const result = projected({ a: 1, b: 2 }, { a: 1 }) as {
		content: Array<{ text: string }>;
		structuredContent: Record<string, unknown>;
	};
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
	assertEquals(parsed, structured, `${name} emits a field its outputSchema does not declare`);
}

Deno.test('catalog: the handler successes reachable at the unit tier round-trip their outputSchema', async () => {
	const { ctx, registry } = await harness();
	try {
		roundTrip('browser_navigate', await tools.browserNavigate({ url: 'https://example.com/' }, ctx));
		roundTrip('browser_go_back', await tools.browserGoBack({}, ctx));
		roundTrip('browser_click', await tools.browserClick({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_click', await tools.browserClick({ index: 3 }, ctx));
		roundTrip('browser_double_click', await tools.browserDoubleClick({ index: 3 }, ctx));
		roundTrip('browser_double_click', await tools.browserDoubleClick({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_right_click', await tools.browserRightClick({ index: 3 }, ctx));
		roundTrip('browser_right_click', await tools.browserRightClick({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_hover', await tools.browserHover({ index: 3 }, ctx));
		roundTrip('browser_hover', await tools.browserHover({ coordinate_x: 1, coordinate_y: 2 }, ctx));
		roundTrip('browser_type', await tools.browserType({ text: 'hello', index: 3 }, ctx));
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
		roundTrip('browser_get_session', await tools.browserGetSession({}, ctx));
		roundTrip('browser_close_session', await tools.browserCloseSession({ session_id: 'default' }, ctx));
		roundTrip('browser_close_all', await tools.browserCloseAll({}, ctx));
	} finally {
		await registry.shutdown();
	}
});

/** `browser_wait_for` driven for real on both of its answers. */
Deno.test('catalog: browser_wait_for round-trips its outputSchema on both answers', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
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
 * The perception handlers driven against a recorded capture, so the rich element record, the frame list and the
 * locator tools round-trip their schemas from a real handler result rather than a literal.
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
 * The rest of the catalog needs a real browser, a model or an encoder, so its schemas are proven against a payload
 * built here from the handler's own literal instead.
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
				sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
			},
			range_supported: true,
		},
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
		'browser_element_at',
		'browser_evaluate',
		'browser_fill_secret',
		'browser_audit',
		'browser_file_policy',
		'browser_health',
		'browser_request_human',
		'browser_live_view',
		'browser_live_ticket',
		'browser_pdf',
		'browser_file_link',
		'browser_accessibility_snapshot',
		'browser_performance',
	]);
	const uncovered = CATALOG.map((tool) => tool.name).filter((name) => !covered.has(name));
	assertEquals(uncovered, [], `these tools have an outputSchema nothing proves: ${uncovered.join(', ')}`);
});

/** The two tools that may declare a field spelled `secret`, and what makes them exceptions. */
const SECRET_NAME_FIELDS: ReadonlySet<string> = new Set(['browser_fill_secret', 'browser_audit']);

Deno.test('schemas: no output schema declares a field named `password`, `secret` or `token`', () => {
	for (const tool of CATALOG) {
		const emitted = JSON.stringify(z.toJSONSchema(tool.outputSchema, { io: 'output' }));
		for (const word of ['"password"', '"secret"', '"credential"']) {
			if (word === '"secret"' && SECRET_NAME_FIELDS.has(tool.name)) continue;
			assert(!emitted.includes(word), `${tool.name}'s outputSchema declares ${word}`);
		}
	}
	const state = JSON.stringify(z.toJSONSchema(CATALOG_BY_NAME.get('browser_get_state')!.outputSchema, {
		io: 'output',
	}));
	assert(state.includes('available_secrets'), 'browser_get_state must still advertise the secret *names*');

	for (const name of SECRET_NAME_FIELDS) {
		const emitted = JSON.stringify(z.toJSONSchema(CATALOG_BY_NAME.get(name)!.outputSchema, { io: 'output' }));
		assert(emitted.includes('"secret"'), `${name} must still name the secret`);
		for (const forbidden of ['"value"', '"typed_length"', '"secret_length"', '"length"', '"hash"', '"digest"']) {
			if (forbidden === '"digest"' && emitted.includes('"expression_digest"')) continue;
			assert(!emitted.includes(forbidden), `${name}'s outputSchema declares ${forbidden} beside a secret name`);
		}
	}
});

/** `browser_wait_for` must not turn "I lost the answer" into "it did not happen". */
Deno.test('catalog: browser_wait_for reports a gap rather than a false negative', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		const ring = h.record.events;
		const waiting = tools.browserWaitFor({ until: { dialog: true }, timeout_ms: 5000 }, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		ring.append('dialog', { dialog_id: 'd1', kind: 'alert', message: 'gone' });
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

Deno.test('schemas: browser_evaluate round-trips its outputSchema on both the value and the exception arm', async () => {
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
		answer = { result: { type: 'object' }, exceptionDetails: { exception: { description: 'TypeError: x' } } };
		roundTrip('browser_evaluate', await tools.browserEvaluate({ expression: 'x()' }, h.ctx));
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('schemas: browser_fill_secret and browser_audit round-trip their outputSchema', async () => {
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
		roundTrip('browser_audit', await tools.browserAudit({}, ctx));
		roundTrip(
			'browser_audit',
			await tools.browserAudit({ limit: 5 }, { ...ctx, scopes: new Set(['mcp:invoke', 'admin'] as const) }),
		);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('schemas: browser_file_policy round-trips its outputSchema and reads the enforcement constants', async () => {
	const { ctx, registry } = await harness();
	try {
		const result = await tools.browserFilePolicy({}, ctx);
		roundTrip('browser_file_policy', result);
		const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
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

// --- Every extension and library tool declares a typed `outputSchema` inside the kept `{ result }` envelope, and the dispatcher validates the real results against it. ---

/** The success's validated structured result, after asserting it equals the handler's own JSON. */
function unchanged(name: string, result: ToolResult): Record<string, unknown> {
	const call = result as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: unknown };
	assertEquals(call.isError, undefined, `${name} failed: ${call.content[0]?.text}`);
	const raw = JSON.parse(call.content[0]?.text ?? 'null') as Record<string, unknown>;
	assertEquals(call.structuredContent, raw, `${name}: the schema dropped or changed a field`);
	return (raw as { result: Record<string, unknown> }).result;
}

Deno.test('every extension and library tool types what is inside its { result } envelope', () => {
	const tools = [
		...extensionTools(
			Object.fromEntries(Object.keys(EXTENSION_OUTPUT).map((name) => [name, () => Promise.resolve({})])),
		),
		...libraryTools(new LibraryStore({ dataDir: 'tests/.scratch/never-created' })),
	];
	assertEquals(tools.length, 44);
	for (const tool of tools) {
		const schema = z.toJSONSchema(tool.outputSchema) as {
			properties?: {
				result?: { type?: string; properties?: object; anyOf?: unknown[]; additionalProperties?: unknown };
			};
			required?: string[];
		};
		assertEquals(schema.required, ['result'], `${tool.name} keeps the envelope`);
		const result = schema.properties?.result;
		assert(result !== undefined, `${tool.name} has a result`);
		assert(
			result.properties !== undefined || result.anyOf !== undefined,
			`${tool.name} result is untyped: ${JSON.stringify(result)}`,
		);
	}
});

Deno.test('real library results validate and pass the dispatcher unchanged', async () => {
	const dir = join('tests/.scratch', `outputs-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const store = new LibraryStore({ dataDir: dir });
	await store.initialize();
	const downloads = join(dir, 'downloads');
	await Deno.mkdir(downloads);
	const session = captureSession(await loadCapture('baseline_button'));
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session, downloads: null, downloadsDir: downloads }),
	});
	const call = createToolExecutor({ registry, version: 'test', library: store }, 'owner', new Set(SCOPES));
	const seen = new Set<string>();
	const run = async (name: string, args: Record<string, unknown>) => {
		seen.add(name);
		return unchanged(name, await call(name, args));
	};
	try {
		assertEquals((await run('file_write', { path: 'docs/a.md', content: '# a' })).path, 'docs/a.md');
		assertEquals((await run('file_mkdir', { path: 'docs/empty' })).kind, 'directory');
		assertEquals(((await run('file_list', { path: 'docs' })).entries as unknown[]).length, 2);
		assertEquals((await run('file_stat', { path: 'docs/a.md' })).size, 3);
		assertEquals((await run('file_read', { path: 'docs/a.md' })).content, '# a');
		assertEquals((await run('file_move', { from: 'docs/a.md', to: 'docs/b.md' })).name, 'b.md');
		const skill = { 'SKILL.md': '---\nname: plan\ndescription: Plan work\n---\nPlan it.', 'notes.txt': 'n' };
		assertEquals((await run('skill_put', { name: 'plan', files: skill })).files, ['SKILL.md', 'notes.txt']);
		assertEquals(((await run('skill_list', {})).skills as unknown[]).length, 1);
		assertStringIncludes(String((await run('skill_get', { name: 'plan' })).instructions), 'Plan it.');
		assertEquals((await run('skill_read_file', { name: 'plan', path: 'notes.txt' })).text, 'n');
		const prompt = {
			name: 'ask',
			title: 'Ask',
			description: 'Ask a question',
			arguments: [{ name: 'q', description: 'the question', required: true }, { name: 'tone' }],
			template: 'Q: {{q}} ({{tone}})',
		};
		assertEquals((await run('prompt_put', prompt)).title, 'Ask');
		assertEquals(((await run('prompt_list', {})).prompts as unknown[]).length, 1);
		assertEquals(((await run('prompt_get', { name: 'ask' })).arguments as unknown[]).length, 2);
		assertEquals(
			(await run('prompt_render', { name: 'ask', arguments: { q: 'why', tone: 'calm' } })).text,
			'Q: why (calm)',
		);
		const record = await registry.resolve(undefined);
		const art = await record.files.addArtifact({
			name: 'page.pdf',
			mimeType: 'application/pdf',
			bytes: new TextEncoder().encode('%PDF'),
		});
		const saved = await run('browser_save_to_share', { file_id: art.file_id, path: 'docs/page.pdf' });
		assertEquals([saved.path, saved.size, saved.sha256], ['docs/page.pdf', 4, art.sha256]);
		assertEquals((await run('file_delete', { path: 'docs', recursive: true })).removed, true);
		assertEquals((await run('skill_delete', { name: 'plan' })).removed, true);
		assertEquals((await run('prompt_delete', { name: 'ask' })).removed, true);
		assertEquals([...seen].sort(), Object.keys(LIBRARY_OUTPUT).sort(), 'every library tool was driven');
	} finally {
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true });
	}
});

/** The sandbox service's replies, field for field from `packages/sandbox/src` (workspaces.ts, sandbox.ts). */
const LIMITS = {
	disk_budget_bytes: 1_073_741_824,
	disk_used_bytes: 4096,
	file_bytes: 262_144,
	exec_timeout_default_ms: 300_000,
	exec_timeout_max_ms: 900_000,
	exec_output_bytes: 1_048_576,
	session_idle_ms: 1_800_000,
	session_lifetime_ms: 14_400_000,
	session_input_bytes: 16_384,
};
const WORKSPACE = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const SESSION = '1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';
const TASK = {
	id: WORKSPACE,
	contextId: SESSION,
	status: { state: 'TASK_STATE_WORKING', timestamp: new Date(0).toISOString() },
	artifacts: [{ artifactId: 'a', parts: [{ text: 'partial' }] }],
	history: [{ messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hello' }] }],
};
const SERVICE_REPLIES: Record<string, { args: Record<string, unknown>; reply: Record<string, unknown> }> = {
	sandbox_create: {
		args: { name: 'demo' },
		reply: { workspace_id: WORKSPACE, created_at: new Date(0).toISOString(), name: 'demo', limits: LIMITS },
	},
	sandbox_clone: {
		args: { remote: 'app', ref: 'main' },
		reply: {
			workspace_id: WORKSPACE,
			created_at: new Date(0).toISOString(),
			commit: '80445e2e21d609fd261502c216b1847b40923c7d',
			ref: 'main',
			limits: LIMITS,
		},
	},
	sandbox_list: {
		args: {},
		reply: {
			workspaces: [{ workspace_id: WORKSPACE, created_at: new Date(0).toISOString(), busy: true }],
			clone: { hosts: ['github.com'], remotes: ['app'] },
		},
	},
	sandbox_read: { args: { workspace_id: WORKSPACE, path: 'a.txt' }, reply: { content: 'hi', bytes: 2 } },
	sandbox_write: {
		args: { workspace_id: WORKSPACE, path: 'a.txt', content: 'hi' },
		reply: { written: true, bytes: 2, path: 'a.txt' },
	},
	sandbox_exec: {
		args: { workspace_id: WORKSPACE, command: 'echo hi' },
		reply: {
			exitCode: 0,
			timedOut: false,
			killed: null,
			durationMs: 12,
			output: 'hi\n',
			truncated: false,
			omittedBytes: 0,
			outputBytes: 3,
			diskBytes: 4096,
			diskBudgetBytes: 1_073_741_824,
			overBudget: false,
			cleanupOnly: false,
			reachedHosts: [],
			refusedHosts: [],
		},
	},
	sandbox_diff: {
		args: { workspace_id: WORKSPACE },
		reply: { patch: '+hi\n', files: [{ path: 'a.txt', change: 'added' }], truncated: false },
	},
	sandbox_delete: { args: { workspace_id: WORKSPACE }, reply: { removed: true } },
	sandbox_session_open: {
		args: { workspace_id: WORKSPACE },
		reply: { session_id: SESSION, created_at: new Date(0).toISOString() },
	},
	sandbox_session_input: { args: { session_id: SESSION, data: 'ls\n' }, reply: { accepted: true } },
	sandbox_session_read: {
		args: { session_id: SESSION },
		reply: { output: 'a.txt\n', seq: 6, gap: false, ended: false, exit_code: null, killed: null },
	},
	sandbox_session_close: { args: { session_id: SESSION }, reply: { closed: true } },
	agent_peers: { args: {}, reply: { peers: [{ id: 'reviewer' }] } },
	agent_delegate: { args: { peer: 'reviewer', message: 'look' }, reply: { task: TASK } },
	agent_get_task: { args: { task_id: WORKSPACE }, reply: { task: TASK } },
	agent_cancel_task: { args: { task_id: WORKSPACE }, reply: { task: TASK } },
	agent_run_tool: { args: { tool: 'sandbox_exec', arguments: { command: 'true' } }, reply: { task: TASK } },
	agent_list_tasks: {
		args: { state: 'active', limit: 5 },
		reply: { tasks: [{ ...TASK, history: [] }], truncated: false },
	},
	a2ui_delete: { args: { surface_id: 's' }, reply: { removed: true, surfaceId: 's' } },
	memory_save: {
		args: { collection: 'notes', items: [{ text: 'the cat sat', metadata: { kind: 'pet' } }] },
		reply: { collection: 'notes', embedder: 'builtin:lexical-512', created: true, ids: ['01J0000000000000000000000A'] },
	},
	memory_search: {
		args: { collection: 'notes', query: 'cat', limit: 3, filter: { kind: 'pet', ok: true, n: 1, z: null } },
		reply: {
			collection: 'notes',
			embedder: 'builtin:lexical-512',
			results: [{ id: 'a', text: 'the cat sat', metadata: { kind: 'pet' }, score: 0.81 }],
		},
	},
	memory_delete: {
		args: { collection: 'notes', all: true },
		reply: { collection: 'notes', deleted: 1, dropped: true },
	},
	memory_list: {
		args: {},
		reply: {
			default_embedder: 'builtin:lexical-512',
			collections: [{
				name: 'notes',
				embedder: 'builtin:lexical-512',
				dims: 512,
				items: 1,
				created_at: new Date(0).toISOString(),
				available: true,
			}],
		},
	},
};

Deno.test('service replies of the documented shape validate, and an added field passes through', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const actions = Object.fromEntries(
		Object.entries(SERVICE_REPLIES).map(([name, { reply }]) => [
			name,
			() => Promise.resolve({ ...reply, added_later: 1 }),
		]),
	);
	const call = createToolExecutor(
		{ registry, version: 'test', extraTools: extensionTools(actions), sandboxClone: () => true },
		'owner',
		new Set(SCOPES),
	);
	try {
		for (const [name, { args, reply }] of Object.entries(SERVICE_REPLIES)) {
			assertEquals(unchanged(name, await call(name, args)), { ...reply, added_later: 1 }, name);
		}
	} finally {
		await registry.shutdown();
	}
});

Deno.test('a reply that drifts from its declared shape is refused as a server fault, not passed on', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const warnings: string[] = [];
	const call = createToolExecutor(
		{
			registry,
			version: 'test',
			logger: { warn: (message) => warnings.push(message), info: () => {} },
			extraTools: extensionTools({
				sandbox_exec: () => Promise.resolve({ timedOut: false, killed: null, durationMs: 1, stdout: 'x' }),
				a2ui_publish: () => Promise.resolve({ surface: { surfaceId: 's' } }),
			}),
		},
		'owner',
		new Set(SCOPES),
	);
	try {
		for (
			const [name, args] of [
				['sandbox_exec', { workspace_id: WORKSPACE, command: 'true' }],
				['a2ui_publish', { message: { version: 'v0.9', deleteSurface: { surfaceId: 's' } } }],
			] as const
		) {
			const result = await call(name, args) as { isError?: boolean; structuredContent: { error: { code: string } } };
			assertEquals(result.isError, true, name);
			assertEquals(result.structuredContent.error.code, 'browser-unavailable');
		}
		assert(warnings.some((warning) => warning.includes('sandbox_exec returned a result its schema rejects')));
	} finally {
		await registry.shutdown();
	}
});
