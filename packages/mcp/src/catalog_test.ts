import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import * as z from 'zod';
import { annotationsFor, CATALOG, CATALOG_BY_NAME } from './catalog.ts';
import { missingFeature } from './dispatch.ts';
import { headRoutingRefusal } from './head.ts';
import { DEFAULT_SCOPES, EXPLICIT_SCOPES, SCOPES } from './scopes.ts';
import * as toolHandlers from './tools.ts';
import * as agentHandlers from './agent.ts';
import { FIELD_PRESETS } from './element_record.ts';
import { join } from '@std/path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { extensionTools } from './extension_tools.ts';
import { LibraryStore } from './library.ts';
import { SessionRegistry } from './registry.ts';
import { registerCatalog } from './server.ts';
import type { RecordingController } from './types.ts';

/** Every module a catalog entry may take its handler from. */
const handlers: Record<string, unknown> = { ...toolHandlers, ...agentHandlers };

Deno.test('catalog: every definition maps to a distinct exported handler', () => {
	const exported = new Set(
		Object.entries(handlers)
			.filter(([name, value]) => typeof value === 'function' && name.startsWith('browser'))
			.map(([name]) => name),
	);
	const used = new Set<string>();
	for (const tool of CATALOG) {
		const match = Object.entries(handlers).find(([, fn]) => fn === tool.handler);
		assert(match !== undefined, `${tool.name} has a handler that is not exported from tools.ts`);
		assert(!used.has(match[0]), `${match[0]} is wired to more than one tool`);
		used.add(match[0]);
	}
	const unusedHandlers = [...exported].filter((name) => !used.has(name));
	assertEquals(unusedHandlers, [], `handlers exported but not in the catalog: ${unusedHandlers.join(', ')}`);
});

Deno.test('catalog: names are unique, snake_case, and browser-prefixed', () => {
	const seen = new Set<string>();
	for (const tool of CATALOG) {
		assert(!seen.has(tool.name), `duplicate tool name ${tool.name}`);
		seen.add(tool.name);
		assert(/^[a-z][a-z0-9_]*$/.test(tool.name), `${tool.name} is not snake_case`);
		assert(tool.name.startsWith('browser_'), `${tool.name} lacks the browser_ prefix`);
	}
	assertEquals(CATALOG.map((tool) => tool.name).sort(), [
		'browser_accessibility_snapshot',
		'browser_audit',
		'browser_click',
		'browser_close_all',
		'browser_close_session',
		'browser_close_tab',
		'browser_console_log',
		'browser_double_click',
		'browser_download',
		'browser_drag',
		'browser_element_at',
		'browser_evaluate',
		'browser_extract_content',
		'browser_file_link',
		'browser_file_policy',
		'browser_fill',
		'browser_fill_secret',
		'browser_find',
		'browser_get_file',
		'browser_get_frames',
		'browser_get_html',
		'browser_get_session',
		'browser_get_state',
		'browser_go_back',
		'browser_handle_dialog',
		'browser_har_export',
		'browser_head',
		'browser_health',
		'browser_hover',
		'browser_list_files',
		'browser_list_sessions',
		'browser_list_tabs',
		'browser_live_ticket',
		'browser_live_view',
		'browser_locator_candidates',
		'browser_navigate',
		'browser_network_log',
		'browser_pdf',
		'browser_performance',
		'browser_press_key',
		'browser_record',
		'browser_request_human',
		'browser_right_click',
		'browser_run_task',
		'browser_screenshot',
		'browser_scroll',
		'browser_scroll_into_view',
		'browser_scroll_to',
		'browser_select_option',
		'browser_set_session_options',
		'browser_set_viewport',
		'browser_storage_state',
		'browser_switch_tab',
		'browser_type',
		'browser_upload_file',
		'browser_verify_locator',
		'browser_wait_for',
	]);
});

Deno.test('catalog: read-only tools are annotated read-only and mutating ones are not; every hint is explicit', () => {
	for (const tool of CATALOG) {
		const annotations = annotationsFor(tool);
		assertEquals(typeof annotations.openWorldHint, 'boolean', `${tool.name} leaves openWorldHint to the default`);
		if (tool.mutates) {
			assertEquals(annotations.readOnlyHint, undefined, `${tool.name} is mutating but hints read-only`);
			assertEquals(typeof annotations.destructiveHint, 'boolean', `${tool.name} leaves destructiveHint implicit`);
			assertEquals(typeof annotations.idempotentHint, 'boolean', `${tool.name} leaves idempotentHint implicit`);
		} else {
			assertEquals(annotations.readOnlyHint, true, `${tool.name} is read-only but does not hint it`);
			assertEquals(annotations.destructiveHint, undefined, `${tool.name} is read-only; destructive is meaningless`);
		}
	}
});

Deno.test('catalog: close tools are flagged destructive', () => {
	for (const name of ['browser_close_tab', 'browser_close_session', 'browser_close_all']) {
		const tool = CATALOG_BY_NAME.get(name);
		assert(tool !== undefined, `${name} missing from the catalog`);
		assertEquals(annotationsFor(tool).destructiveHint, true, `${name} should hint destructive`);
	}
});

Deno.test('catalog: exactly the three privileged tools carry an extra scope, plus the handoff its view scope', () => {
	const scoped = CATALOG.filter((tool) => tool.scope !== undefined).map((tool) => tool.name).sort();
	assertEquals(scoped, [
		'browser_close_all',
		'browser_evaluate',
		'browser_live_ticket',
		'browser_live_view',
		'browser_request_human',
		'browser_run_task',
	]);
	assertEquals(CATALOG_BY_NAME.get('browser_request_human')?.scope, 'view:control');
	assertEquals(CATALOG_BY_NAME.get('browser_live_view')?.scope, 'view:watch');
	assertEquals(CATALOG_BY_NAME.get('browser_live_ticket')?.scope, 'view:watch');
	assertEquals(CATALOG_BY_NAME.get('browser_close_all')?.scope, 'admin');
	assertEquals(CATALOG_BY_NAME.get('browser_run_task')?.scope, 'task');
	assertEquals(CATALOG_BY_NAME.get('browser_evaluate')?.scope, 'evaluate');
	assertEquals(
		CATALOG.filter((tool) => tool.scope !== undefined && (EXPLICIT_SCOPES as readonly string[]).includes(tool.scope))
			.map((tool) => tool.name).sort(),
		['browser_close_all', 'browser_evaluate', 'browser_run_task'],
	);
	assertEquals(
		CATALOG.filter((tool) => tool.scope !== undefined && (DEFAULT_SCOPES as readonly string[]).includes(tool.scope))
			.map((tool) => tool.name).sort(),
		['browser_live_ticket', 'browser_live_view', 'browser_request_human'],
	);
	assertEquals(
		CATALOG_BY_NAME.get('browser_request_human')?.available?.({ persistence: true, recording: true, egress: true }),
		false,
	);
});

Deno.test('catalog: every browser tool accepts an optional session_id', () => {
	for (const tool of CATALOG) {
		const sessionless = [
			'browser_list_sessions',
			'browser_close_all',
			'browser_head',
			'browser_file_policy',
			'browser_health',
		];
		if (sessionless.includes(tool.name)) continue;
		const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ??
			(tool.inputSchema as unknown as { _def?: { schema?: { shape?: Record<string, unknown> } } })._def?.schema?.shape;
		assert(shape !== undefined, `${tool.name} has no inspectable object shape`);
		assert('session_id' in shape, `${tool.name} does not accept session_id`);
	}
});

Deno.test('catalog: every pointer tool requires exactly index or a full coordinate pair', () => {
	for (const name of ['browser_click', 'browser_double_click', 'browser_right_click', 'browser_hover']) {
		const schema = CATALOG_BY_NAME.get(name)!.inputSchema;
		assert(schema.safeParse({ index: 3 }).success, `${name}: index alone should parse`);
		assert(schema.safeParse({ coordinate_x: 1, coordinate_y: 2 }).success, `${name}: a coordinate pair should parse`);
		assert(!schema.safeParse({}).success, `${name}: neither index nor coordinates must fail`);
		assert(!schema.safeParse({ index: 1, coordinate_x: 1, coordinate_y: 2 }).success, `${name}: both must fail`);
		assert(!schema.safeParse({ coordinate_x: 1 }).success, `${name}: a half coordinate pair must fail`);
	}
});

Deno.test('catalog: select_option takes exactly one selector, and drag takes two whole endpoints', () => {
	const select = CATALOG_BY_NAME.get('browser_select_option')!.inputSchema;
	assert(select.safeParse({ index: 3, value: 'b' }).success);
	assert(select.safeParse({ index: 3, label: 'Beta' }).success);
	assert(select.safeParse({ index: 3, index_in_list: 1 }).success);
	assert(!select.safeParse({ index: 3 }).success, 'no selector must fail');
	assert(!select.safeParse({ index: 3, value: 'b', label: 'Beta' }).success, 'two selectors must fail');
	assert(select.safeParse({ index: 3, index_in_list: 0 }).success, 'option 0 is a valid selector');

	const drag = CATALOG_BY_NAME.get('browser_drag')!.inputSchema;
	assert(drag.safeParse({ from: { index: 1 }, to: { x: 2, y: 3 } }).success);
	assert(drag.safeParse({ from: { x: 1, y: 2 }, to: { index: 4 } }).success);
	assert(!drag.safeParse({ from: {}, to: { index: 4 } }).success, 'an empty endpoint must fail');
	assert(!drag.safeParse({ from: { x: 1 }, to: { index: 4 } }).success, 'a half coordinate pair must fail');
	assert(!drag.safeParse({ from: { index: 1, x: 1, y: 2 }, to: { index: 4 } }).success, 'both must fail');
	assert(!drag.safeParse({ from: { index: 1 } }).success, 'a missing endpoint must fail');
});

Deno.test('catalog: schemas reject unknown-typed arguments', () => {
	const navigate = CATALOG_BY_NAME.get('browser_navigate')!.inputSchema;
	assert(!navigate.safeParse({ url: 'not-a-url' }).success);
	assert(navigate.safeParse({ url: 'https://example.com' }).success);

	const scroll = CATALOG_BY_NAME.get('browser_scroll')!.inputSchema;
	assert(!scroll.safeParse({ direction: 'sideways' }).success);
	assert(scroll.safeParse({ direction: 'down' }).success);
	assert(!scroll.safeParse({ direction: 'down', pages: 99 }).success, 'pages is capped at 10');
});

Deno.test('catalog: every schema emits JSON Schema for tools/list', () => {
	for (const tool of CATALOG) {
		const jsonSchema = z.toJSONSchema(tool.inputSchema, { io: 'input' });
		assertEquals(typeof jsonSchema, 'object', `${tool.name} produced no JSON Schema`);
	}
});

// --- availability -----------------------------------------------------------

Deno.test('catalog: the persistence tools are unavailable without a data directory', () => {
	const tool = CATALOG_BY_NAME.get('browser_storage_state');
	assert(tool?.available !== undefined, 'browser_storage_state should declare availability');
	assertEquals(tool.available({ persistence: false, recording: false, egress: false }), false);
	assertEquals(tool.available({ persistence: true, recording: false, egress: false }), true);
});

Deno.test('catalog: recording is offered only where it can be encoded', () => {
	const tool = CATALOG_BY_NAME.get('browser_record');
	assert(tool?.available !== undefined, 'browser_record should declare availability');
	assertEquals(tool.available({ persistence: true, recording: false, egress: false }), false);
	assertEquals(tool.available({ persistence: true, recording: true, egress: false }), true);
	assertEquals(tool.mutates, false);
});

/**
 * The SDK answers a disabled tool with a JSON-RPC error, which aborts the model's turn instead of telling it to wait,
 * so the takeover lock must never disable a tool: `SessionRegistry.assertUnlocked` answers it with a classifiable
 * `Error: human-has-control:` result, in the partial-lock and all-locked cases alike.
 */
Deno.test('catalog: availability is deployment configuration only, never session state', () => {
	const scoped = CATALOG.filter((tool) => tool.available !== undefined).map((tool) => tool.name).sort();
	assertEquals(scoped, [
		'browser_file_link',
		'browser_head',
		'browser_live_ticket',
		'browser_live_view',
		'browser_record',
		'browser_request_human',
		'browser_storage_state',
	]);

	const none = { persistence: false, recording: false, egress: false };
	for (const tool of CATALOG) {
		if (tool.available === undefined) continue;
		assert(
			missingFeature(tool, none) !== undefined || tool.unavailableDetail !== undefined,
			`${tool.name} is disabled by something that is not persistence, recording or egress, and does not say why`,
		);
	}
});

// --- output schemas ---------------------------------------------------------

/**
 * A non-object root makes `projectCallToolResult` wrap the payload as `{result: …}` on the 2025 codec while the 2026
 * codec's projection is the identity, so the wire shape would differ between the two eras this server serves for the
 * same handler — and `appendTextFallbackForNonObject` would inject a text block at position 0, colliding with the
 * `Error: <code>: ` first-block convention.
 */
Deno.test('catalog: every outputSchema has an object root', () => {
	for (const tool of CATALOG) {
		assert(tool.outputSchema instanceof z.ZodObject, `${tool.name}'s outputSchema is not a ZodObject`);
		const emitted = z.toJSONSchema(tool.outputSchema, { io: 'output' }) as { type?: string };
		assertEquals(emitted.type, 'object', `${tool.name}'s emitted output JSON Schema is not object-rooted`);
	}
});

Deno.test('catalog: every tool declares an outputSchema, and it is its own', () => {
	const seen = new Map<z.ZodType, string>();
	for (const tool of CATALOG) {
		assert(tool.outputSchema !== undefined, `${tool.name} declares no outputSchema`);
		const other = seen.get(tool.outputSchema);
		assertEquals(other, undefined, `${tool.name} shares an outputSchema with ${other}`);
		seen.set(tool.outputSchema, tool.name);
	}
});

Deno.test('catalog: browser_head needs the grant AND a routing it can follow', () => {
	const tool = CATALOG_BY_NAME.get('browser_head');
	assert(tool?.available !== undefined && tool.unavailableDetail !== undefined);
	const base = { persistence: true, recording: true, egress: true, headRouting: null };
	assertEquals(tool.available(base), true);
	assertEquals(tool.available({ ...base, egress: false }), false, 'no proven outbound grant, no tool');
	const diverging = { ...base, headRouting: headRoutingRefusal(['--proxy-server=http://p:3128']) };
	assertEquals(tool.available(diverging), false, 'a diverging browser route withholds it');
	const detail = tool.unavailableDetail(diverging);
	assert(detail !== undefined);
	assertStringIncludes(detail, '--proxy-server');
	assertEquals(tool.unavailableDetail(base), undefined, 'a healthy deployment adds no detail');
	assertEquals(tool.unavailableDetail({ ...base, egress: false }), undefined, 'nor does a missing grant');
});

/**
 * The `fields` description is wire text every client reads, and it must agree with the presets the docs and
 * `capabilities.tykotech.fields` describe.
 */
Deno.test('catalog: the fields description states the presets FIELD_PRESETS actually emits', () => {
	const core = [...FIELD_PRESETS.core];
	const fullExtras = FIELD_PRESETS.full.filter((f) => !FIELD_PRESETS.core.includes(f));
	let checked = 0;
	for (const tool of CATALOG) {
		const emitted = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as {
			properties?: Record<string, { description?: string }>;
		};
		const description = emitted.properties?.fields?.description;
		if (description === undefined) continue;
		checked++;
		const coreClaim = /core \(default: minimal plus ([^)]+)\)/.exec(description);
		assert(coreClaim !== null, `${tool.name}: the fields description makes no parseable core claim`);
		assertEquals(
			coreClaim[1]?.split(', '),
			core,
			`${tool.name}: the wire says core emits fields it does not`,
		);
		const fullClaim = /full \(core plus ([^)]+)\)/.exec(description);
		assert(fullClaim !== null, `${tool.name}: the fields description makes no parseable full claim`);
		assertEquals(
			fullClaim[1]?.split(', '),
			fullExtras,
			`${tool.name}: the wire says full adds fields it does not, or omits ones it does`,
		);
	}
	assertEquals(checked, 4, 'the fields argument reached a different number of tools than expected');
});

// --- What `tools/list` advertises as each tool's annotations is exactly the table below: the 57 browser tools, the 24 extension tools given an action here (all but the two MCP Apps stream tickets) and the 18 library tools. ---

/**
 * `R` read-only, closed world · `RO` read-only, open world · `M:<flags>` mutating, with `D` destructive,
 * `I` idempotent and `O` open world; a missing flag is an explicit `false`.
 */
const TABLE: Readonly<Record<string, string>> = {
	browser_navigate: 'M:O',
	browser_go_back: 'M:O',
	browser_wait_for: 'R',
	browser_click: 'M:O',
	browser_double_click: 'M:O',
	browser_right_click: 'M:O',
	browser_hover: 'M:O',
	browser_type: 'M:O',
	browser_press_key: 'M:O',
	browser_fill: 'M:O',
	browser_scroll_to: 'M:IO',
	browser_scroll_into_view: 'M:O',
	browser_select_option: 'M:O',
	browser_upload_file: 'M:O',
	browser_handle_dialog: 'M:O',
	browser_drag: 'M:O',
	browser_scroll: 'M:O',
	browser_fill_secret: 'M:O',
	browser_evaluate: 'M:O',
	browser_run_task: 'M:O',
	browser_get_state: 'R',
	browser_find: 'R',
	browser_element_at: 'R',
	browser_get_frames: 'R',
	browser_locator_candidates: 'R',
	browser_verify_locator: 'R',
	browser_get_html: 'R',
	browser_screenshot: 'R',
	browser_extract_content: 'R',
	browser_get_session: 'R',
	browser_set_viewport: 'M:I',
	browser_set_session_options: 'M:',
	browser_list_tabs: 'R',
	browser_switch_tab: 'M:I',
	browser_close_tab: 'M:DI',
	browser_storage_state: 'M:',
	browser_record: 'R',
	browser_list_sessions: 'R',
	browser_close_session: 'M:DI',
	browser_close_all: 'M:D',
	browser_health: 'R',
	browser_audit: 'R',
	browser_request_human: 'R',
	browser_live_view: 'R',
	browser_live_ticket: 'R',
	browser_list_files: 'R',
	browser_get_file: 'R',
	browser_download: 'M:O',
	browser_head: 'RO',
	browser_file_policy: 'R',
	browser_network_log: 'R',
	browser_console_log: 'R',
	browser_har_export: 'R',
	browser_pdf: 'R',
	browser_file_link: 'R',
	browser_accessibility_snapshot: 'R',
	browser_performance: 'R',
	sandbox_create: 'M:',
	sandbox_clone: 'M:O',
	sandbox_list: 'R',
	sandbox_read: 'R',
	sandbox_write: 'M:I',
	sandbox_exec: 'M:O',
	sandbox_diff: 'R',
	sandbox_delete: 'M:D',
	sandbox_session_open: 'M:O',
	sandbox_session_input: 'M:',
	sandbox_session_read: 'R',
	sandbox_session_close: 'M:',
	agent_peers: 'R',
	agent_delegate: 'M:O',
	agent_get_task: 'R',
	agent_cancel_task: 'M:',
	agent_run_tool: 'M:O',
	agent_list_tasks: 'R',
	a2ui_publish: 'M:',
	a2ui_delete: 'M:DI',
	memory_save: 'M:',
	memory_search: 'R',
	memory_delete: 'M:DI',
	memory_list: 'R',
	file_list: 'R',
	file_stat: 'R',
	file_read: 'R',
	file_write: 'M:I',
	file_mkdir: 'M:I',
	file_delete: 'M:D',
	file_move: 'M:',
	skill_list: 'R',
	skill_get: 'R',
	skill_read_file: 'R',
	skill_put: 'M:I',
	skill_delete: 'M:D',
	prompt_list: 'R',
	prompt_get: 'R',
	prompt_put: 'M:I',
	prompt_delete: 'M:D',
	prompt_render: 'R',
	browser_save_to_share: 'M:D',
};

function expected(code: string): Record<string, boolean> {
	if (code === 'R') return { readOnlyHint: true, openWorldHint: false };
	if (code === 'RO') return { readOnlyHint: true, openWorldHint: true };
	const flags = code.slice('M:'.length);
	return {
		destructiveHint: flags.includes('D'),
		idempotentHint: flags.includes('I'),
		openWorldHint: flags.includes('O'),
	};
}

const EXTENSION_NAMES = Object.keys(TABLE).filter((name) => /^(sandbox|agent|a2ui|memory)_/.test(name));

Deno.test('tools/list annotations equal the hand-written table for every tool, all 99 of them', async () => {
	const dir = join('tests/.scratch', `annotations-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const library = new LibraryStore({ dataDir: dir });
	await library.initialize();
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const recorder = {
		start: () => Promise.reject(new Error('unused')),
		stop: () => Promise.reject(new Error('unused')),
		status: () => null,
		list: () => [],
	} as RecordingController;
	const server = new McpServer({ name: 'annotations', version: 'test' });
	registerCatalog(server, {
		registry,
		version: 'test',
		anonScopes: [...SCOPES],
		persistence: true,
		recorder,
		egress: true,
		viewUrl: (id: string) => `http://127.0.0.1/#/view/${id}`,
		mcpApps: {
			mode: 'control',
			liveViewHtml: '',
			a2uiHtml: '',
			terminalHtml: '',
			connectDomains: [],
			origins: [],
			mintTicket: () => Promise.reject(new Error('unused')),
		},
		signedLink: () => Promise.reject(new Error('unused')),
		library,
		sandboxClone: () => true,
		extraTools: extensionTools(
			Object.fromEntries(EXTENSION_NAMES.map((name) => [name, () => Promise.resolve({})])),
		),
	}, undefined);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'annotations', version: '0' });
	try {
		await server.connect(serverSide);
		await client.connect(clientSide);
		const { tools } = await client.listTools();
		assertEquals(tools.map((tool) => tool.name).sort(), Object.keys(TABLE).sort(), 'the list is the whole table');
		for (const tool of tools) {
			assertEquals(tool.annotations, expected(TABLE[tool.name]!), tool.name);
		}
	} finally {
		await client.close();
		await server.close();
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true });
	}
});
