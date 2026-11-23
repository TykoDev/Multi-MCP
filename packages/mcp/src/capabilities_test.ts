/** `capabilities.tykotech` — the vendor key on the wire, the scope filter, and `tools_withheld`. */
import { readRpc } from '../fixtures/capture_session.ts';
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert';
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	McpServer,
	PROTOCOL_VERSION_META_KEY,
	SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { EVENT_KINDS, WS_EVENT_KINDS } from '@tykotech/wire';
import { buildCapabilities, TOOL_WITHHELD_REASONS, toolsWithheld, type TykotechCapabilities } from './capabilities.ts';
import { CATALOG } from './catalog.ts';
import { type Scope, SCOPES } from './scopes.ts';
import { SessionRegistry } from './registry.ts';
import { capabilitiesFor, createBuildServer, type McpDeps } from './server.ts';
import { CAPABILITIES_URI } from './resources.ts';
import {
	MAX_INSTRUCTIONS_BYTES,
	SERVER_DESCRIPTION,
	SERVER_TITLE,
	serverImplementation,
	serverInstructions,
} from './identity.ts';

const MODERN = '2026-07-28';
const ERA_2025 = '2025-06-18';
const VERSION = '0.0.0-test';

const LIVE_VIEW = {
	origins_managed: true,
	ticket_ttl_max_s: { view: 300, control: 60 },
	frame_scale: true,
	hover: true,
	highlight: true,
	keyframe: true,
} as const;

/** A registry that can never launch a browser: no test here needs one. */
function registry(): SessionRegistry {
	return new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.reject(new Error('no browser in the unit tier')),
	});
}

function deps(sessions: SessionRegistry): McpDeps {
	return {
		registry: sessions,
		version: VERSION,
		liveView: LIVE_VIEW,
		eventTransports: ['sse', 'websocket'],
	};
}

function auth(clientId: string, scopes: readonly Scope[]): AuthInfo {
	return { token: 't', clientId, scopes: [...scopes], extra: {} };
}

/**
 * The handshake that carries the server's capabilities, on the named era, through the real HTTP entry: `initialize` on
 * 2025, `server/discover` on 2026-07-28 (where `initialize` is the 2025 handshake the SDK refuses under a 2026
 * `MCP-Protocol-Version` header).
 */
async function initialize(
	handler: { fetch: (r: Request, o?: { authInfo?: AuthInfo }) => Promise<Response> },
	era: string,
	authInfo?: AuthInfo,
): Promise<{ capabilities: Record<string, unknown> }> {
	const method = era === MODERN ? 'server/discover' : 'initialize';
	const params: Record<string, unknown> = era === MODERN
		? { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: {} } }
		: { protocolVersion: era, capabilities: {}, clientInfo: { name: 'capabilities-test', version: '0' } };
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (era === MODERN) {
		headers['mcp-protocol-version'] = MODERN;
		headers['mcp-method'] = method;
	}
	const response = await handler.fetch(
		new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		}),
		authInfo === undefined ? {} : { authInfo },
	);
	const body = await readRpc(response);
	assertEquals(body.error, undefined, `${method} answered a JSON-RPC error: ${JSON.stringify(body.error)}`);
	return body.result as { capabilities: Record<string, unknown> };
}

// --------------------------------------------------------------------------- The vendor key on the wire
// ---------------------------------------------------------------------------

for (const era of [ERA_2025, MODERN]) {
	Deno.test(`capabilities.tykotech survives the handshake result (${era})`, async () => {
		const sessions = registry();
		const handler = createMcpHandler(createBuildServer(deps(sessions)), { legacy: 'stateless' });
		try {
			const result = await initialize(handler, era, auth('narrow', ['mcp:invoke']));
			assert(
				Object.hasOwn(result.capabilities, 'tykotech'),
				`the SDK stripped the vendor key; capabilities were ${JSON.stringify(result.capabilities)}. ` +
					`ServerCapabilitiesSchema is $strip — if the outbound path has started parsing, ` +
					`the block reaches clients only through ttk://capabilities and browser_health.`,
			);
			const block = result.capabilities.tykotech as TykotechCapabilities;
			assertEquals(block.version, VERSION);
			assertEquals(block.live_view, undefined, 'a principal with no view scope must not see the live-view block');
			assert(block.events !== undefined, 'an mcp:invoke principal sees the event block');
			assertEquals(block.events.gap_record, true);
		} finally {
			await handler.close();
			await sessions.shutdown();
		}
	});
}

Deno.test('the SDK preserves an unknown capability key through registerCapabilities', () => {
	const server = new McpServer({ name: 'vendor-key-probe', version: VERSION });
	// deno-lint-ignore no-explicit-any -- the point of the probe is the key the type forbids.
	server.server.registerCapabilities({ tykotech: { version: VERSION } } as any);
	const held = server.server.getCapabilities() as Record<string, unknown>;
	assert(Object.hasOwn(held, 'tykotech'), 'mergeCapabilities dropped the vendor key');
});

// --------------------------------------------------------------------------- The scope filter
// ---------------------------------------------------------------------------

Deno.test('two principals receive different capability payloads', async () => {
	const sessions = registry();
	const handler = createMcpHandler(createBuildServer(deps(sessions)), { legacy: 'stateless' });
	try {
		const invoker = await initialize(handler, ERA_2025, auth('invoker', ['mcp:invoke']));
		const viewer = await initialize(handler, ERA_2025, auth('viewer', ['view:watch']));
		const a = invoker.capabilities.tykotech as TykotechCapabilities;
		const b = viewer.capabilities.tykotech as TykotechCapabilities;

		assertNotEquals(JSON.stringify(a), JSON.stringify(b), 'the block is not scope-filtered');
		assert(a.events !== undefined && a.fields !== undefined && a.tools_withheld !== undefined);
		assertEquals(a.live_view, undefined);
		assertEquals(b.live_view, LIVE_VIEW);
		assertEquals(b.events, undefined);
		assertEquals(b.fields, undefined);
		assertEquals(b.tools_withheld, undefined);
		assertEquals(a.version, VERSION);
		assertEquals(b.version, VERSION);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('events.kinds never advertises a kind the principal cannot receive', () => {
	const sse = buildCapabilities({
		version: VERSION,
		scopes: new Set<Scope>(['mcp:invoke']),
		availability: { persistence: false, recording: false, egress: false },
		eventTransports: ['sse', 'websocket'],
	});
	assertEquals(sse.events?.kinds, EVENT_KINDS);

	const socketOnly = buildCapabilities({
		version: VERSION,
		scopes: new Set<Scope>(['mcp:invoke']),
		availability: { persistence: false, recording: false, egress: false },
		eventTransports: ['websocket'],
	});
	assertEquals(socketOnly.events?.kinds, WS_EVENT_KINDS);
	for (const kind of ['focus', 'input', 'console']) {
		assert(!(socketOnly.events?.kinds ?? []).includes(kind as never), `${kind} must not be advertised on the socket`);
	}
});

// --------------------------------------------------------------------------- tools_withheld is closed, and names no
// scope ---------------------------------------------------------------------------

Deno.test('tools_withheld reasons are a closed enumeration', () => {
	for (const held of [[], ['mcp:invoke'], ['mcp:invoke', 'task'], [...SCOPES]] as Scope[][]) {
		for (
			const availability of [
				{ persistence: false, recording: false, egress: false },
				{ persistence: true, recording: true, egress: true },
			]
		) {
			for (const row of toolsWithheld(new Set(held), availability)) {
				assert(
					(TOOL_WITHHELD_REASONS as readonly string[]).includes(row.reason),
					`${row.name} carried the un-enumerable reason ${row.reason}`,
				);
			}
		}
	}
});

Deno.test('a scope-required row never names the scope', () => {
	const withheld = toolsWithheld(new Set<Scope>(['mcp:invoke']), {
		persistence: false,
		recording: false,
		egress: false,
	});
	const scoped = withheld.filter((row) => row.reason === 'scope-required');
	assert(scoped.length > 0, 'a principal holding only mcp:invoke must be withheld the scoped tools');
	const names = new Set(scoped.map((row) => row.name));
	assert(names.has('browser_run_task'), 'browser_run_task carries the task scope and must be withheld');
	assert(names.has('browser_close_all'), 'browser_close_all carries the admin scope and must be withheld');
	assert(names.has('browser_evaluate'), 'browser_evaluate carries the evaluate scope and must be withheld');

	const whole = JSON.stringify(withheld);
	for (const scope of SCOPES) {
		assert(!whole.includes(`"${scope}"`), `the withheld list named the scope ${scope}: ${whole}`);
	}

	for (const row of withheld) {
		assertEquals(Object.keys(row).sort(), ['name', 'reason'], `${row.name} carried an unexpected key`);
	}
});

Deno.test('tools_withheld and registration cannot drift: every withheld tool is one the catalog has', () => {
	const availability = { persistence: false, recording: false, egress: false };
	const withheld = toolsWithheld(new Set<Scope>(['mcp:invoke']), availability);
	const catalog = new Set(CATALOG.map((tool) => tool.name));
	for (const row of withheld) assert(catalog.has(row.name), `${row.name} is not in the catalog`);

	for (const tool of CATALOG) {
		const skipped = tool.scope !== undefined && !new Set<Scope>(['mcp:invoke']).has(tool.scope);
		const disabled = tool.available !== undefined && !tool.available(availability);
		const listed = withheld.some((row) => row.name === tool.name);
		assertEquals(
			listed,
			skipped || disabled,
			`${tool.name}: withheld=${listed}, skipped=${skipped}, disabled=${disabled}`,
		);
	}
});

Deno.test('a full-scope principal on a full deployment is withheld nothing', () => {
	assertEquals(
		toolsWithheld(new Set(SCOPES), {
			persistence: true,
			recording: true,
			egress: true,
			handoff: true,
			mcpApps: true,
			signedLinks: true,
		}),
		[],
	);
});

// --------------------------------------------------------------------------- One builder, three read points
// ---------------------------------------------------------------------------

Deno.test('the initialize block and the ttk://capabilities resource are the same object', async () => {
	const sessions = registry();
	const d = deps(sessions);
	const handler = createMcpHandler(createBuildServer(d), { legacy: 'stateless' });
	try {
		const authInfo = auth('invoker', ['mcp:invoke']);
		const wire = (await initialize(handler, ERA_2025, authInfo)).capabilities.tykotech;
		assertEquals(wire, JSON.parse(JSON.stringify(capabilitiesFor(d, authInfo))));
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('the capabilities resource is readable by a credential that cannot read a page', async () => {
	const sessions = registry();
	const d = deps(sessions);
	const handler = createMcpHandler(createBuildServer(d), { legacy: 'stateless' });
	try {
		const authInfo = auth('viewer', ['view:watch']);
		const response = await handler.fetch(
			new Request('http://127.0.0.1/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'resources/read',
					params: { uri: CAPABILITIES_URI },
				}),
			}),
			{ authInfo },
		);
		const body = await readRpc(response);
		assertEquals(body.error, undefined, `resources/read answered an error: ${JSON.stringify(body.error)}`);
		const contents = (body.result as { contents: Array<{ text: string; mimeType: string }> }).contents;
		assertEquals(contents[0]?.mimeType, 'application/json');
		const block = JSON.parse(contents[0]?.text ?? '{}') as TykotechCapabilities;
		assertEquals(block.live_view, LIVE_VIEW);
		assertEquals(block.events, undefined);
		assertEquals(block.fields, undefined);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('registering the capabilities resource does not open the session resources to a viewer', async () => {
	const sessions = registry();
	const handler = createMcpHandler(createBuildServer(deps(sessions)), { legacy: 'stateless' });
	try {
		const authInfo = auth('viewer', ['view:watch']);
		const post = async (method: string, params: Record<string, unknown>) => {
			const response = await handler.fetch(
				new Request('http://127.0.0.1/mcp', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
				}),
				{ authInfo },
			);
			return await readRpc(response);
		};

		const listed = await post('resources/list', {});
		const uris = ((listed.result as { resources?: Array<{ uri: string }> })?.resources ?? []).map((r) => r.uri);
		assertEquals(uris, [CAPABILITIES_URI], 'a viewer must see the capabilities resource and nothing else');

		const templates = await post('resources/templates/list', {});
		const templateUris = ((templates.result as { resourceTemplates?: Array<{ uriTemplate: string }> })
			?.resourceTemplates ?? []).map((t) => t.uriTemplate);
		assertEquals(templateUris, [], 'a viewer must see no session template');

		const read = await post('resources/read', { uri: 'ttk://session/default/state' });
		assert(read.error !== undefined, `a viewer read the page state: ${JSON.stringify(read.result)}`);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('a mount with no live view advertises no live-view block', () => {
	const block = buildCapabilities({
		version: VERSION,
		scopes: new Set(SCOPES),
		availability: { persistence: false, recording: false, egress: false },
	});
	assertEquals(block.live_view, undefined);
	assertEquals(block.events?.transports, []);
});

// --------------------------------------------------------------------------- The `model` block, for the caller who
// may spend a provider key ---------------------------------------------------------------------------

Deno.test('the model block is emitted only for a model:invoke holder, and with no dependency it says none', () => {
	const availability = { persistence: false, recording: false, egress: false };
	for (const held of [['mcp:invoke'], ['admin'], ['view:watch']] as Scope[][]) {
		assertEquals(
			buildCapabilities({
				version: VERSION,
				scopes: new Set(held),
				availability,
				model: { providers: 2, reachable: 1 },
			})
				.model,
			undefined,
			held.join(','),
		);
	}
	assertEquals(
		buildCapabilities({ version: VERSION, scopes: new Set<Scope>(['model:invoke']), availability }).model,
		{ providers: 0, builtin_agent: false },
	);
	assertEquals(
		buildCapabilities({
			version: VERSION,
			scopes: new Set<Scope>(['model:invoke']),
			availability,
			model: { providers: 2, reachable: 0 },
		}).model,
		{ providers: 2, builtin_agent: false },
	);
	assertEquals(
		buildCapabilities({
			version: VERSION,
			scopes: new Set<Scope>(['mcp:invoke', 'model:invoke']),
			availability,
			model: { providers: 2, reachable: 1 },
		}).model,
		{ providers: 2, builtin_agent: true },
	);
});

Deno.test('capabilitiesFor reads McpDeps.modelProviders for the scope holder and nobody else', async () => {
	const sessions = registry();
	try {
		const base = deps(sessions);
		const holder = auth('holder', ['mcp:invoke', 'model:invoke']);
		const other = auth('other', ['mcp:invoke']);
		assertEquals(capabilitiesFor(base, holder).model, { providers: 0, builtin_agent: false });
		assertEquals(capabilitiesFor(base, other).model, undefined);
		let reachable = 0;
		const wired: McpDeps = { ...base, modelProviders: () => ({ providers: 1, reachable }) };
		assertEquals(capabilitiesFor(wired, holder).model, { providers: 1, builtin_agent: false });
		reachable = 1;
		assertEquals(capabilitiesFor(wired, holder).model, { providers: 1, builtin_agent: true });
		assertEquals(capabilitiesFor(wired, other).model, undefined);
		assertEquals(capabilitiesFor(wired, undefined).model, undefined);
	} finally {
		await sessions.shutdown();
	}
});

// --- `capabilities.tykotech.sandbox = { backend }` — the coding sandbox's backend, told to the caller who can run commands in it, and to nobody else. ---

const availability = { persistence: false, recording: false, egress: false };

Deno.test('capabilities: the sandbox block is for a principal holding sandbox:execute', () => {
	const sandbox = { backend: 'docker' } as const;
	const block = (scopes: Scope[]) =>
		buildCapabilities({ version: 'v', scopes: new Set(scopes), availability, sandbox });
	assertEquals(block(['mcp:invoke', 'sandbox:execute']).sandbox, { backend: 'docker' });
	assertEquals(block(['sandbox:execute']).sandbox, { backend: 'docker' });
	assertEquals(block(['mcp:invoke', 'view:watch']).sandbox, undefined);
	assertEquals(
		buildCapabilities({ version: 'v', scopes: new Set<Scope>(['sandbox:execute']), availability }).sandbox,
		undefined,
		'no sandbox configured, or none has answered',
	);
});

Deno.test('capabilities: the sandbox backend is read live, for an owned caller only, once the sandbox has said', () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	let backend: 'bwrap' | 'docker' | null = null;
	const deps: McpDeps = { registry, version: 'v', sandboxBackend: () => backend };
	const owned: AuthInfo = { token: 't', clientId: 'k', scopes: ['sandbox:execute'], extra: { owner: 'api-key:k' } };
	const unowned: AuthInfo = { token: 't', clientId: 'k', scopes: ['sandbox:execute'], extra: {} };
	assertEquals(capabilitiesFor(deps, owned).sandbox, undefined);
	backend = 'bwrap';
	assertEquals(capabilitiesFor(deps, owned).sandbox, { backend: 'bwrap' });
	backend = 'docker';
	assertEquals(capabilitiesFor(deps, owned).sandbox, { backend: 'docker' });
	assertEquals(capabilitiesFor(deps, unowned).sandbox, undefined);
	assertEquals(capabilitiesFor({ registry, version: 'v' }, owned).sandbox, undefined);
});

// --- The server's identity and instructions, on both eras, through the real HTTP entry. ---

const IDENTITY = { websiteUrl: 'https://ttk.example', iconUrl: 'https://ttk.example/assets/brand/icon-192.png' };
/** Configuration values that must never reach the instructions. */
const CONFIG_SENTINELS = ['allowed-sentinel.example', 'https://ttk.example', '0.0.0-identity'];

function identityDeps(registry: SessionRegistry, identity?: McpDeps['identity']): McpDeps {
	return {
		registry,
		version: '0.0.0-identity',
		allowedDomains: ['allowed-sentinel.example'],
		liveView: LIVE_VIEW,
		eventTransports: ['sse', 'websocket'],
		...(identity === undefined ? {} : { identity }),
	};
}

function identityAuth(scopes: readonly Scope[]): AuthInfo {
	return { token: 't', clientId: 'identity-test', scopes: [...scopes], extra: { owner: 'api-key:identity-test' } };
}

async function rpc(
	handler: { fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response> },
	era: string,
	method: 'initialize' | 'server/discover',
	authInfo: AuthInfo,
): Promise<Record<string, unknown>> {
	const params: Record<string, unknown> = method === 'initialize'
		? { protocolVersion: era, capabilities: {}, clientInfo: { name: 'identity-test', version: '0' } }
		: {};
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (era === MODERN) {
		params._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: {} };
		headers['mcp-protocol-version'] = MODERN;
		headers['mcp-method'] = method;
	}
	const response = await handler.fetch(
		new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		}),
		{ authInfo },
	);
	const text = await response.text();
	const body = (response.headers.get('content-type') ?? '').includes('text/event-stream')
		? JSON.parse(text.split('\n').find((line) => line.startsWith('data:'))!.slice(5).trim())
		: JSON.parse(text);
	assertEquals(body.error, undefined, `${method} answered an error: ${JSON.stringify(body.error)}`);
	return body.result as Record<string, unknown>;
}

function assertInstructionsSafe(instructions: unknown): string {
	assert(typeof instructions === 'string', 'instructions are present');
	assert(new TextEncoder().encode(instructions).byteLength <= MAX_INSTRUCTIONS_BYTES, 'at most 2 KiB');
	for (const value of CONFIG_SENTINELS) assert(!instructions.includes(value), `a configuration value leaked: ${value}`);
	return instructions;
}

Deno.test('serverImplementation carries title, description, website and a PNG icon only when given', () => {
	assertEquals(serverImplementation('1.2.3', IDENTITY), {
		name: 'tykotech-mcp',
		title: SERVER_TITLE,
		version: '1.2.3',
		description: SERVER_DESCRIPTION,
		websiteUrl: IDENTITY.websiteUrl,
		icons: [{ src: IDENTITY.iconUrl, mimeType: 'image/png', sizes: ['192x192'] }],
	});
	assertEquals(serverImplementation('1.2.3'), {
		name: 'tykotech-mcp',
		title: SERVER_TITLE,
		version: '1.2.3',
		description: SERVER_DESCRIPTION,
	});
});

Deno.test('the instructions follow the filtered capability block, sentence by sentence', () => {
	const availability = { persistence: false, recording: false, egress: false, headRouting: null };
	const block = (scopes: readonly Scope[], liveView = true) =>
		buildCapabilities({
			version: '0.0.0-identity',
			scopes: new Set(scopes),
			availability,
			...(liveView ? { liveView: LIVE_VIEW } : {}),
			eventTransports: ['sse'],
		});
	const invoker = assertInstructionsSafe(serverInstructions(block(['mcp:invoke'])));
	assertStringIncludes(invoker, 'browser_get_state');
	assert(!invoker.includes('live view'), 'no live-view sentence without a view scope');

	const watcher = assertInstructionsSafe(serverInstructions(block(['view:watch'])));
	assertStringIncludes(watcher, 'live view');
	assert(!watcher.includes('browser_get_state'), 'a viewer that cannot invoke is not taught the tools');

	const stdio = assertInstructionsSafe(serverInstructions(block(['mcp:invoke', 'view:control'], false)));
	assert(!stdio.includes('live view'), 'a mount with no live view says nothing about it');

	const everything = assertInstructionsSafe(serverInstructions({
		...block([...SCOPES]),
		sandbox: { backend: 'bwrap' },
	}));
	assertStringIncludes(everything, 'sandbox_*');
});

for (const era of [ERA_2025, MODERN]) {
	Deno.test(`the identity and the instructions reach the client (${era})`, async () => {
		const registry = new SessionRegistry({ reapIntervalMs: 0 });
		const handler = createMcpHandler(createBuildServer(identityDeps(registry, IDENTITY)), { legacy: 'stateless' });
		try {
			let serverInfo: Record<string, unknown> | undefined;
			let instructions: unknown;
			if (era === ERA_2025) {
				const result = await rpc(handler, era, 'initialize', identityAuth(['mcp:invoke']));
				serverInfo = result.serverInfo as Record<string, unknown>;
				instructions = result.instructions;
			} else {
				const result = await rpc(handler, era, 'server/discover', identityAuth(['mcp:invoke']));
				instructions = result.instructions;
				serverInfo = (result._meta as Record<string, unknown> | undefined)?.[SERVER_INFO_META_KEY] as
					| Record<string, unknown>
					| undefined;
			}
			assert(serverInfo !== undefined, 'serverInfo is on the wire');
			assertEquals(serverInfo.title, SERVER_TITLE);
			assertEquals(serverInfo.description, SERVER_DESCRIPTION);
			assertEquals(serverInfo.websiteUrl, IDENTITY.websiteUrl);
			assertEquals(serverInfo.icons, [{ src: IDENTITY.iconUrl, mimeType: 'image/png', sizes: ['192x192'] }]);
			const text = assertInstructionsSafe(instructions);
			assertStringIncludes(text, 'browser_get_state');
			assert(!text.includes('live view'), 'this caller holds no view scope');
		} finally {
			await handler.close();
			await registry.shutdown();
		}
	});
}

Deno.test('a viewer credential is told about the live view and not about the tools', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const handler = createMcpHandler(createBuildServer(identityDeps(registry)), { legacy: 'stateless' });
	try {
		const result = await rpc(handler, ERA_2025, 'initialize', identityAuth(['view:watch']));
		const text = assertInstructionsSafe(result.instructions);
		assertStringIncludes(text, 'live view');
		assert(!text.includes('browser_get_state'));
		const serverInfo = result.serverInfo as Record<string, unknown>;
		assertEquals(serverInfo.websiteUrl, undefined, 'no identity given (stdio): no website');
		assertEquals(serverInfo.icons, undefined, 'no identity given (stdio): no icon');
	} finally {
		await handler.close();
		await registry.shutdown();
	}
});
