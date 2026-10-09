/**
 * `capabilities.tykotech` — U-8's standing assertion, the scope filter, and `tools_withheld`.
 *
 * The first test here is **U-8 as a tripwire**. B3.1's whole design gate was whether the SDK admits
 * a vendor key on the `initialize` result: `ServerCapabilitiesSchema` is declared `z.core.$strip`, so
 * the *type* is closed, and only the outbound path's failure to parse makes the key survive. That is
 * a fact about a pinned dependency, not about this repository, so it is asserted rather than assumed
 * — an SDK minor that starts validating the result fails here instead of silently removing the one
 * field §8 invites a client to branch on.
 *
 * Everything below it is SEC-16 and SEC-17: two principals must not receive the same payload, and
 * the withheld-tool reason must be enumerable without naming a scope.
 */
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { createMcpHandler, McpServer, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { EVENT_KINDS, WS_EVENT_KINDS } from '@tykotech/wire';
import { buildCapabilities, TOOL_WITHHELD_REASONS, toolsWithheld, type TykotechCapabilities } from './capabilities.ts';
import { CATALOG } from './catalog.ts';
import { type Scope, SCOPES } from './scopes.ts';
import { SessionRegistry } from './registry.ts';
import { capabilitiesFor, createBuildServer, type McpDeps } from './server.ts';
import { CAPABILITIES_URI } from './resources.ts';

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
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

async function readRpc(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		for (const l of text.split('\n')) if (l.startsWith('data:')) return JSON.parse(l.slice(5).trim());
		throw new Error(`no data frame in SSE body: ${text}`);
	}
	return JSON.parse(text);
}

/** One `initialize`, on the named era, through the real HTTP entry. */
async function initialize(
	handler: { fetch: (r: Request, o?: { authInfo?: AuthInfo }) => Promise<Response> },
	era: string,
	authInfo?: AuthInfo,
): Promise<{ protocolVersion: string; capabilities: Record<string, unknown> }> {
	const params: Record<string, unknown> = {
		protocolVersion: era,
		capabilities: {},
		clientInfo: { name: 'capabilities-test', version: '0' },
	};
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (era === MODERN) {
		params._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN };
		headers['mcp-method'] = 'initialize';
	}
	const response = await handler.fetch(
		new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params }),
		}),
		authInfo === undefined ? {} : { authInfo },
	);
	const body = await readRpc(response);
	assertEquals(body.error, undefined, `initialize answered a JSON-RPC error: ${JSON.stringify(body.error)}`);
	return body.result as { protocolVersion: string; capabilities: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// U-8: the vendor key on the wire
// ---------------------------------------------------------------------------

for (const era of [LEGACY, MODERN]) {
	Deno.test(`U-8 (${era}): capabilities.tykotech survives the initialize result`, async () => {
		const sessions = registry();
		const handler = createMcpHandler(createBuildServer(deps(sessions)), { legacy: 'stateless' });
		try {
			const result = await initialize(handler, era, auth('narrow', ['mcp:invoke']));
			// By name, never by count: a `Object.keys(...).length` assertion passes
			// a build where the key was replaced by a different one.
			assert(
				Object.hasOwn(result.capabilities, 'tykotech'),
				`the SDK stripped the vendor key; capabilities were ${JSON.stringify(result.capabilities)}. ` +
					`ServerCapabilitiesSchema is $strip — if the outbound path has started parsing, ` +
					`report_design.md §10.1's contingency applies and the block ships as ttk://capabilities ` +
					`and browser_health alone.`,
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

Deno.test('U-8: the SDK still preserves an unknown capability key through registerCapabilities', () => {
	// The narrowest possible statement of the dependency fact, so a failure here
	// names the mechanism rather than the symptom.
	const server = new McpServer({ name: 'u8', version: VERSION });
	// deno-lint-ignore no-explicit-any -- the point of the probe is the key the type forbids.
	server.server.registerCapabilities({ tykotech: { version: VERSION } } as any);
	const held = server.server.getCapabilities() as Record<string, unknown>;
	assert(Object.hasOwn(held, 'tykotech'), 'mergeCapabilities dropped the vendor key');
});

// ---------------------------------------------------------------------------
// SEC-16 / AC-SEC-19: the scope filter
// ---------------------------------------------------------------------------

Deno.test('SEC-16: two principals receive different capability payloads', async () => {
	const sessions = registry();
	const handler = createMcpHandler(createBuildServer(deps(sessions)), { legacy: 'stateless' });
	try {
		const invoker = await initialize(handler, LEGACY, auth('invoker', ['mcp:invoke']));
		const viewer = await initialize(handler, LEGACY, auth('viewer', ['view:watch']));
		const a = invoker.capabilities.tykotech as TykotechCapabilities;
		const b = viewer.capabilities.tykotech as TykotechCapabilities;

		assertNotEquals(JSON.stringify(a), JSON.stringify(b), 'the block is not scope-filtered');
		// The invoker gets the event ring, the field lever and the withheld list; no live view.
		assert(a.events !== undefined && a.fields !== undefined && a.tools_withheld !== undefined);
		assertEquals(a.live_view, undefined);
		// The viewer gets the live view and nothing that describes page content.
		assertEquals(b.live_view, LIVE_VIEW);
		assertEquals(b.events, undefined);
		assertEquals(b.fields, undefined);
		assertEquals(b.tools_withheld, undefined);
		// `version` is the one unconditional field, and both see the same one: it
		// is the string `/healthz` already serves without a credential at all.
		assertEquals(a.version, VERSION);
		assertEquals(b.version, VERSION);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('SEC-16: events.kinds never advertises a kind the principal cannot receive', () => {
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
	// The socket carries strictly less: `focus`, `input` and `console` are page
	// content and never ride it. Advertising them would be both a lie and a map.
	assertEquals(socketOnly.events?.kinds, WS_EVENT_KINDS);
	for (const kind of ['focus', 'input', 'console']) {
		assert(!(socketOnly.events?.kinds ?? []).includes(kind as never), `${kind} must not be advertised on the socket`);
	}
});

// ---------------------------------------------------------------------------
// SEC-17 / AC-SEC-20: tools_withheld is closed, and names no scope
// ---------------------------------------------------------------------------

Deno.test('SEC-17: tools_withheld reasons are a closed enumeration', () => {
	// Every scope combination the vocabulary admits, so a reason outside the enum
	// cannot hide behind an untested principal.
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

Deno.test('SEC-17: a scope-required row never names the scope', () => {
	const withheld = toolsWithheld(new Set<Scope>(['mcp:invoke']), {
		persistence: false,
		recording: false,
		egress: false,
	});
	const scoped = withheld.filter((row) => row.reason === 'scope-required');
	assert(scoped.length > 0, 'a principal holding only mcp:invoke must be withheld the scoped tools');
	// By name, so the assertion says which tools this principal cannot see.
	const names = new Set(scoped.map((row) => row.name));
	assert(names.has('browser_run_task'), 'browser_run_task carries the task scope and must be withheld');
	assert(names.has('browser_close_all'), 'browser_close_all carries the admin scope and must be withheld');
	assert(names.has('browser_evaluate'), 'browser_evaluate carries the evaluate scope and must be withheld');

	// No scope appears as a *value* anywhere in the payload. The quoted form is
	// what distinguishes a value from a substring, and it has to: `browser_run_task`
	// contains `task`, and a bare-substring assertion would either fail on the
	// tool's own published name or have to special-case it — and a special case
	// in this assertion is exactly where a smuggled scope would hide. This is the
	// same form `dispatch_test.ts` uses on the `scope-required` refusal text.
	const whole = JSON.stringify(withheld);
	for (const scope of SCOPES) {
		assert(!whole.includes(`"${scope}"`), `the withheld list named the scope ${scope}: ${whole}`);
	}

	// And the row is structurally closed: two keys, and `reason` is the only one
	// that could ever carry a grant. A third key is how prose gets back in.
	for (const row of withheld) {
		assertEquals(Object.keys(row).sort(), ['name', 'reason'], `${row.name} carried an unexpected key`);
	}
});

Deno.test('tools_withheld and registration cannot drift: every withheld tool is one the catalog has', () => {
	const availability = { persistence: false, recording: false, egress: false };
	const withheld = toolsWithheld(new Set<Scope>(['mcp:invoke']), availability);
	const catalog = new Set(CATALOG.map((tool) => tool.name));
	for (const row of withheld) assert(catalog.has(row.name), `${row.name} is not in the catalog`);

	// And the partition is exact: a tool is withheld exactly when registration
	// would skip it or disable it. Asserting the complement is what makes this a
	// drift test rather than a spot check.
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
		// A full deployment has every opt-in switch on: W4's `TTK_HUMAN_HANDOFF` (D-124) is `handoff`, W7's `TTK_MCP_APPS` (D-134) is `mcpApps`, W2's `TTK_SIGNED_LINKS` (D-119) is `signedLinks`.
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

// ---------------------------------------------------------------------------
// One builder, three read points
// ---------------------------------------------------------------------------

Deno.test('the initialize block and the ttk://capabilities resource are the same object', async () => {
	const sessions = registry();
	const d = deps(sessions);
	const handler = createMcpHandler(createBuildServer(d), { legacy: 'stateless' });
	try {
		const authInfo = auth('invoker', ['mcp:invoke']);
		const wire = (await initialize(handler, LEGACY, authInfo)).capabilities.tykotech;
		// `capabilitiesFor` is the builder both the `initialize` result and the
		// resource read from; comparing the wire to it proves the wire is not a
		// second, hand-maintained copy.
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
		// Same builder, same filter: a viewer sees the live view and no page-content block.
		assertEquals(block.live_view, LIVE_VIEW);
		assertEquals(block.events, undefined);
		assertEquals(block.fields, undefined);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('registering the capabilities resource does not open the session resources to a viewer', async () => {
	// **The deny path for the one gate B3.1 moves.** `registerResources` used to
	// return before registering anything at all for a principal without
	// `mcp:invoke`; the capabilities resource is now registered before that gate.
	// Registering *any* resource makes the SDK serve `resources/list` and
	// `resources/read` to this principal, so the question is no longer rhetorical:
	// the session templates must still be absent, or a viewer credential would
	// have gained the page content the gate exists to withhold.
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

		// And the read itself is refused, not merely unlisted: an unlisted URI a
		// client guessed is the case a listing assertion cannot cover.
		const read = await post('resources/read', { uri: 'ttk://session/default/state' });
		assert(read.error !== undefined, `a viewer read the page state: ${JSON.stringify(read.result)}`);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('a mount with no live view advertises no live-view block', () => {
	// stdio: no ticket store, no socket, so the ceilings would be a description
	// of a surface that is not there.
	const block = buildCapabilities({
		version: VERSION,
		scopes: new Set(SCOPES),
		availability: { persistence: false, recording: false, egress: false },
	});
	assertEquals(block.live_view, undefined);
	assertEquals(block.events?.transports, []);
});

// ---------------------------------------------------------------------------
// D-143 (model-providers-ui S0): the `model` block, for the caller who may spend a provider key
// ---------------------------------------------------------------------------

Deno.test('D-143: the model block is emitted only for a model:invoke holder, and with no dependency it says none', () => {
	const availability = { persistence: false, recording: false, egress: false };
	// Without the scope: absent, whatever the deployment has (SEC-16, the `sandbox` precedent).
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
	// With the scope and no dependency (S0, stdio): the honest "none configured", not silence.
	assertEquals(
		buildCapabilities({ version: VERSION, scopes: new Set<Scope>(['model:invoke']), availability }).model,
		{ providers: 0, builtin_agent: false },
	);
	// With the scope and the counts: `builtin_agent` is "at least one reachable".
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

Deno.test('D-143: capabilitiesFor reads McpDeps.modelProviders for the scope holder and nobody else', async () => {
	const sessions = registry();
	try {
		const base = deps(sessions);
		const holder = auth('holder', ['mcp:invoke', 'model:invoke']);
		const other = auth('other', ['mcp:invoke']);
		// No dependency: the scope holder is told none; the other principal has no block at all.
		assertEquals(capabilitiesFor(base, holder).model, { providers: 0, builtin_agent: false });
		assertEquals(capabilitiesFor(base, other).model, undefined);
		// The dependency is read live, as `sandboxBackend` is.
		let reachable = 0;
		const wired: McpDeps = { ...base, modelProviders: () => ({ providers: 1, reachable }) };
		assertEquals(capabilitiesFor(wired, holder).model, { providers: 1, builtin_agent: false });
		reachable = 1;
		assertEquals(capabilitiesFor(wired, holder).model, { providers: 1, builtin_agent: true });
		assertEquals(capabilitiesFor(wired, other).model, undefined);
		// The anonymous principal holds the default grant, which never includes `model:invoke` (D-144).
		assertEquals(capabilitiesFor(wired, undefined).model, undefined);
	} finally {
		await sessions.shutdown();
	}
});
