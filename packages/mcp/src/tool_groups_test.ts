/**
 * Tool groups: a grouped connection lists one `use_<group>` entry tool per group instead of the group's tools, and an
 * entry tool opens its group (run 20261028-tool-groups, AC-1 to AC-6).
 *
 * Every case builds its server with the real factory and pins it to one in-memory connection, as stdio does, and reads
 * the list through the real SDK `tools/list`: what is under test is what a client sees, including the pinned-SDK fact
 * that `tools/list` reads the `RegisteredTool.enabled` an entry tool assigns.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import type { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CATALOG, type ToolDefinition } from './catalog.ts';
import { EXTENSION_OUTPUT, extensionTools } from './extension_tools.ts';
import { MAX_INSTRUCTIONS_BYTES, serverInstructions } from './identity.ts';
import { LibraryStore } from './library.ts';
import { libraryTools } from './library_tools.ts';
import { SessionRegistry } from './registry.ts';
import { DEFAULT_SCOPES, type Scope, SCOPES } from './scopes.ts';
import { capabilitiesFor, createBuildServer, type McpDeps, refreshToolAvailability } from './server.ts';
import { TOOL_GROUPS, type ToolGroup, toolGroupOf } from './tool_groups.ts';
import type { RecordingController } from './types.ts';

/** How many tools each group holds when every tool is composed, and the tools no group holds. */
const MEMBERS: Readonly<Record<ToolGroup, number>> = {
	browser: 57,
	library: 17,
	sandbox: 12,
	agent: 7,
	memory: 4,
	a2ui: 2,
};
const ALWAYS_LISTED = ['a2ui_surface_ticket', 'browser_live_ticket', 'sandbox_session_ticket'];
const ENTRY_TOOLS = TOOL_GROUPS.map((group) => `use_${group}`);

interface Options {
	readonly toolGroups?: boolean;
	readonly scopes?: readonly Scope[];
	readonly services?: () => { sandbox?: boolean; agents?: boolean };
}

interface Harness {
	readonly client: Client;
	readonly server: McpServer;
	readonly deps: McpDeps;
	/** Every tool the deps compose, offered or not. */
	readonly composed: readonly ToolDefinition[];
	/** `tools/list_changed` notifications the client has received. */
	readonly announced: () => number;
	names(): Promise<string[]>;
	call(name: string, args?: Record<string, unknown>): Promise<Awaited<ReturnType<Client['callTool']>>>;
	[Symbol.asyncDispose](): Promise<void>;
}

/** Every tool composed and offered, as in `annotations_test.ts`: an owner, every action bound, every switch on. */
async function connect(options: Options = {}): Promise<Harness> {
	const dir = join('tests/.scratch', `tool-groups-${crypto.randomUUID().slice(0, 8)}`);
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
	const extraTools = extensionTools(
		Object.fromEntries(Object.keys(EXTENSION_OUTPUT).map((name) => [name, () => Promise.resolve({})])),
	);
	const deps: McpDeps = {
		registry,
		version: 'test',
		anonScopes: options.scopes ?? [...SCOPES],
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
		extraTools,
		...(options.services === undefined ? {} : { services: options.services }),
		...(options.toolGroups === undefined ? {} : { toolGroups: options.toolGroups }),
	};
	// The 2025 era, as a stdio connection that opened with `initialize` gets it: an in-memory server cannot answer the
	// 2026 `server/discover`, which the transport entry (`serveStdio`) handles in front of the server.
	const server = await createBuildServer(deps)({ era: 'legacy' }) as McpServer;
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'tool-groups', version: '0' });
	let announced = 0;
	client.setNotificationHandler('notifications/tools/list_changed', () => {
		announced++;
	});
	await server.connect(serverSide);
	await client.connect(clientSide);
	return {
		client,
		server,
		deps,
		composed: [...CATALOG, ...extraTools, ...libraryTools(library)],
		announced: () => announced,
		names: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
		call: (name, args = {}) => client.callTool({ name, arguments: args }),
		async [Symbol.asyncDispose]() {
			await client.close();
			await server.close();
			await registry.shutdown();
			await Deno.remove(dir, { recursive: true });
		},
	};
}

/** Lets a notification sent before a result reach the client's handler. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The `{group, tools}` an entry tool returned. */
function opened(result: { structuredContent?: unknown }): {
	group: string;
	tools: { name: string; title: string; description: string }[];
} {
	return result.structuredContent as { group: string; tools: { name: string; title: string; description: string }[] };
}

Deno.test('tool groups: every shipped tool is pinned to the group its name prefix gives', async () => {
	await using h = await connect();
	const counts = Object.fromEntries(TOOL_GROUPS.map((group) => [group, 0])) as Record<ToolGroup, number>;
	const always: string[] = [];
	for (const tool of h.composed) {
		const group = toolGroupOf(tool.name);
		if (group === undefined) always.push(tool.name);
		else counts[group]++;
	}
	assertEquals(h.composed.length, 102, 'the whole catalog is composed');
	assertEquals(counts, MEMBERS);
	// A tool whose prefix no group claims lands here, so a new one fails this line until somebody places it.
	assertEquals(always.sort(), ALWAYS_LISTED);
	assertEquals(toolGroupOf('browser_save_to_share'), 'browser', 'a library-module tool goes by its name');
});

Deno.test('tool groups: a grouped connection lists the entry and app-only tools only', async () => {
	await using h = await connect({ toolGroups: true });
	assertEquals(await h.names(), [...ALWAYS_LISTED, ...ENTRY_TOOLS].sort());
	const { tools } = await h.client.listTools();
	for (const tool of tools.filter((listed) => listed.name.startsWith('use_'))) {
		// Read-only and closed world: opening a group changes what this connection lists, nothing else.
		assertEquals(tool.annotations, { readOnlyHint: true, openWorldHint: false }, tool.name);
		assertEquals(tool.inputSchema.required ?? [], [], `${tool.name} takes no arguments`);
		assert(typeof tool.description === 'string' && tool.description.includes(`${tool.name.slice(4)}`), tool.name);
	}
});

Deno.test('tool groups: opening a group lists its tools and announces once', async () => {
	await using h = await connect({ toolGroups: true });
	const byName = new Map(h.composed.map((tool) => [tool.name, tool]));
	const browser = h.composed.filter((tool) => toolGroupOf(tool.name) === 'browser').map((tool) => tool.name).sort();

	const first = await h.call('use_browser');
	assert(first.isError !== true, JSON.stringify(first.content));
	const index = opened(first);
	assertEquals(index.group, 'browser');
	assertEquals(index.tools.map((tool) => tool.name).sort(), browser);
	for (const tool of index.tools) {
		assertEquals(tool.title, byName.get(tool.name)!.title, tool.name);
		assertEquals(tool.description, byName.get(tool.name)!.description, tool.name);
	}
	const text = (first.content as { type: string; text: string }[])[0]!.text;
	assertStringIncludes(text, `The ${browser.length} browser tools below are now in this connection's tool list`);
	assertStringIncludes(text, `- browser_navigate (${byName.get('browser_navigate')!.title}): `);
	await settle();
	assertEquals(h.announced(), 1, 'one tools/list_changed for the whole group, not one per tool');

	// The client's re-list carries the real tools, with their own schemas and annotations.
	const { tools } = await h.client.listTools();
	const listed = new Map(tools.map((tool) => [tool.name, tool]));
	for (const name of browser) assert(listed.has(name), `${name} is listed once its group is open`);
	assertEquals(listed.get('browser_close_all')!.annotations?.destructiveHint, true);
	assertEquals(listed.get('browser_get_state')!.annotations?.readOnlyHint, true);
	assert(!listed.has('file_read'), 'only the opened group is listed');

	// Opening it again changes nothing and announces nothing.
	const second = await h.call('use_browser');
	assertEquals(opened(second).tools.length, browser.length);
	assertStringIncludes((second.content as { text: string }[])[0]!.text, 'were already');
	await settle();
	assertEquals(h.announced(), 1);

	// Another group announces once more and adds only itself.
	await h.call('use_memory');
	await settle();
	assertEquals(h.announced(), 2);
	assertEquals(
		(await h.names()).filter((name) => name.startsWith('memory_')),
		['memory_delete', 'memory_list', 'memory_save', 'memory_search'],
	);
});

Deno.test("tool groups: a closed group's tool still answers by name", async () => {
	await using h = await connect({ toolGroups: true });
	const result = await h.call('browser_list_sessions');
	assert(result.isError !== true, JSON.stringify(result.content));
	assertEquals((result.structuredContent as { sessions: unknown[] }).sessions, []);
	await settle();
	assert(!(await h.names()).includes('browser_list_sessions'), 'a call by name does not open the group');
	assertEquals(h.announced(), 0);
});

Deno.test('tool groups: a server built without the flag lists flat', async () => {
	await using h = await connect();
	const names = await h.names();
	assertEquals(names, h.composed.map((tool) => tool.name).sort(), 'every composed tool, as before');
	assert(!names.some((name) => name.startsWith('use_')), 'no entry tool');
	// Not in this server's catalog at all, so the dispatcher answers as for any unknown name: a protocol error.
	await assertRejects(() => h.call('use_browser'), Error, 'Tool use_browser not found');
});

Deno.test("tool groups: an entry tool follows its caller's scopes", async () => {
	await using h = await connect({ toolGroups: true, scopes: DEFAULT_SCOPES });
	const held = new Set<Scope>(DEFAULT_SCOPES);
	const names = await h.names();
	// The default grant holds browser and library tools, and no sandbox, agent or A2UI grant.
	assert(names.includes('use_browser') && names.includes('use_library'), names.join(','));
	for (const absent of ['use_sandbox', 'use_agent', 'use_a2ui']) assert(!names.includes(absent), absent);
	const expected = TOOL_GROUPS.filter((group) =>
		h.composed.some((tool) => toolGroupOf(tool.name) === group && (tool.scope === undefined || held.has(tool.scope)))
	).map((group) => `use_${group}`);
	assertEquals(names.filter((name) => name.startsWith('use_')), expected.sort());

	// The index names only tools registered for this caller: nothing behind files:write.
	const library = opened(await h.call('use_library')).tools.map((tool) => tool.name);
	assert(library.includes('file_read') && !library.includes('file_write'), library.join(','));
	const byName = new Map(h.composed.map((tool) => [tool.name, tool]));
	for (const name of library) {
		const scope = byName.get(name)!.scope;
		assert(scope === undefined || held.has(scope), `${name} needs ${scope}`);
	}
});

Deno.test("tool groups: an entry tool follows its group's availability", async () => {
	const services = { sandbox: false };
	await using h = await connect({ toolGroups: true, services: () => ({ ...services }) });
	// Every sandbox tool is down, so its entry tool is not listed, and a call says why rather than "unknown".
	assert(!(await h.names()).includes('use_sandbox'));
	const refused = await h.call('use_sandbox');
	assert(refused.isError === true);
	assertStringIncludes((refused.content as { text: string }[])[0]!.text, 'feature-unavailable');

	// The service returns: the entry tool comes back, its members stay behind it until the group is opened.
	services.sandbox = true;
	refreshToolAvailability(h.server);
	let names = await h.names();
	assert(names.includes('use_sandbox'));
	assert(!names.some((name) => name.startsWith('sandbox_') && name !== 'sandbox_session_ticket'), names.join(','));
	const sandbox = opened(await h.call('use_sandbox')).tools.map((tool) => tool.name);
	assertEquals(sandbox.length, MEMBERS.sandbox);
	names = await h.names();
	for (const name of sandbox) assert(names.includes(name), name);

	// It goes again: an opened group's members leave with it, and come back with it while the group stays open.
	services.sandbox = false;
	refreshToolAvailability(h.server);
	names = await h.names();
	assert(!names.includes('use_sandbox') && !names.includes('sandbox_exec'), names.join(','));
	services.sandbox = true;
	refreshToolAvailability(h.server);
	assert((await h.names()).includes('sandbox_exec'), 'an opened group stays open');
});

Deno.test('tool groups: tool_groups and the instructions appear only on a grouped connection', async () => {
	await using grouped = await connect({ toolGroups: true });
	const block = capabilitiesFor(grouped.deps, undefined);
	assertEquals(block.tool_groups, [...TOOL_GROUPS]);
	const instructions = serverInstructions(block);
	assertStringIncludes(instructions, `call ${ENTRY_TOOLS.join(', ')} to add that group's tools`);
	// The longest instructions this server can give, every optional sentence present, still fit the bound.
	const longest = serverInstructions({
		...block,
		live_view: {
			origins_managed: true,
			ticket_ttl_max_s: { view: 60, control: 60 },
			frame_scale: true,
			hover: true,
			highlight: true,
			keyframe: true,
		},
		sandbox: { backend: 'bwrap' },
	});
	assert(new TextEncoder().encode(longest).byteLength <= MAX_INSTRUCTIONS_BYTES);
	assertStringIncludes(grouped.client.getInstructions() ?? '', 'use_browser');

	await using flat = await connect();
	assertEquals(capabilitiesFor(flat.deps, undefined).tool_groups, undefined);
	assert(!(flat.client.getInstructions() ?? '').includes('use_'), 'a flat connection is told nothing about groups');

	// A caller that cannot invoke tools is told about no group either.
	await using viewer = await connect({ toolGroups: true, scopes: ['view:watch'] });
	assertEquals(capabilitiesFor(viewer.deps, undefined).tool_groups, undefined);
});
