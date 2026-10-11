/**
 * AC14 (A7, D-112): what `tools/list` advertises as each tool's annotations is exactly the design's §2.9 table, for
 * every tool this build can compose — the 57 browser tools, the 25 extension tools and the 18 library tools.
 *
 * The table below is written out by hand on purpose. Deriving it from the definitions would test the derivation
 * against itself; a hand-written row is the claim a reviewer can check against §2.9, and a tool added later fails
 * here until somebody decides its row.
 */
import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { extensionTools } from './extension_tools.ts';
import { LibraryStore } from './library.ts';
import { SessionRegistry } from './registry.ts';
import { SCOPES } from './scopes.ts';
import { registerCatalog } from './server.ts';
import type { RecordingController } from './types.ts';

/**
 * `R` read-only, closed world · `RO` read-only, open world · `M:<flags>` mutating, with `D` destructive,
 * `I` idempotent and `O` open world; a missing flag is an explicit `false`.
 */
const TABLE: Readonly<Record<string, string>> = {
	// navigation
	browser_navigate: 'M:O',
	browser_go_back: 'M:O',
	browser_wait_for: 'R',
	// interaction: every one drives the page, so every one can reach the web
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
	// perception: read-only, closed world
	browser_get_state: 'R',
	browser_find: 'R',
	browser_element_at: 'R',
	browser_get_frames: 'R',
	browser_locator_candidates: 'R',
	browser_verify_locator: 'R',
	browser_get_html: 'R',
	browser_screenshot: 'R',
	browser_extract_content: 'R',
	// session management: closed world
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
	// handoff (W4, D-124): read-only, closed world — it hands out a URL to this server's own control plane
	browser_request_human: 'R',
	// MCP Apps (R9): viewing and minting an embed ticket drive nothing
	browser_live_view: 'R',
	browser_live_ticket: 'R',
	// files
	browser_list_files: 'R',
	browser_get_file: 'R',
	browser_download: 'M:O',
	browser_head: 'RO',
	browser_file_policy: 'R',
	// inspection (R4): reads of what the browser already did
	browser_network_log: 'R',
	browser_console_log: 'R',
	browser_har_export: 'R',
	// media (W2, R10/R11): every one a read, and none reaches the web on its own
	browser_pdf: 'R',
	browser_file_link: 'R',
	browser_accessibility_snapshot: 'R',
	browser_performance: 'R',
	// sandbox
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
	// agents
	agent_peers: 'R',
	agent_delegate: 'M:O',
	agent_prompt: 'M:O',
	agent_get_task: 'R',
	agent_cancel_task: 'M:',
	// R1 (D-121): a tool run as a task can reach the web as its tool can; listing reads only.
	agent_run_tool: 'M:O',
	agent_list_tasks: 'R',
	// A2UI
	a2ui_publish: 'M:',
	a2ui_delete: 'M:DI',
	// memory (D-154): closed world, as the MCP spec's own memory example; a drop or delete is destructive
	memory_save: 'M:',
	memory_search: 'R',
	memory_delete: 'M:DI',
	memory_list: 'R',
	// library
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
	// W2 (R10): a copy into the share, destructive because overwrite replaces a file
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

Deno.test('AC14: tools/list annotations equal the §2.9 table for every tool, all 100 of them', async () => {
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
	// Everything composed and offered: every scope, an owner (the credential-less mount's), every action bound,
	// a data directory, an encoder and a proven egress grant — so no tool is withheld from the list.
	registerCatalog(server, {
		registry,
		version: 'test',
		anonScopes: [...SCOPES],
		persistence: true,
		recorder,
		egress: true,
		// W4 (D-124): the human handoff switch on, so `browser_request_human` is offered too.
		viewUrl: (id: string) => `http://127.0.0.1/#/view/${id}`,
		// R9: MCP Apps on, so the live view and its ticket are offered too.
		mcpApps: {
			mode: 'control',
			liveViewHtml: '',
			a2uiHtml: '',
			terminalHtml: '',
			connectDomains: [],
			origins: [],
			mintTicket: () => Promise.reject(new Error('unused')),
		},
		// W2: a minter, so browser_file_link (gated on TTK_SIGNED_LINKS) is offered too.
		signedLink: () => Promise.reject(new Error('unused')),
		library,
		// R12: the sandbox says it clones, so `sandbox_clone` is offered too.
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
