/**
 * MCP Apps on the MCP surface — off by default, and when on, `_meta.ui` on `tools/list` and
 * on `resources/list` / `resources/read` on **both** protocol eras through the real HTTP entry,
 * plus the two handlers driven through the dispatcher, whose output check parses with the catalog's own schemas.
 */
import { readRpc } from '../fixtures/capture_session.ts';
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { APPS_OUTPUT } from './catalog/session.ts';
import { extensionTools } from './extension_tools.ts';
import { SessionRegistry } from './registry.ts';
import { type Scope, SCOPES } from './scopes.ts';
import { createBuildServer, createToolExecutor, type McpDeps } from './server.ts';
import type { EmbedTicketInput, McpAppsDeps } from './types.ts';
import {
	A2UI_SURFACE_UI_URI,
	LIVE_VIEW_UI_URI,
	resourceUiMeta,
	TERMINAL_UI_URI,
	TOOL_UI,
	toolUiMeta,
	UI_RESOURCE_MIME,
} from './ui_resources.ts';

const MODERN = '2026-07-28';
const ERA_2025 = '2025-06-18';
const ERAS = [ERA_2025, MODERN] as const;

const LIVE_HTML = '<!doctype html><title>live</title><p>live embed</p>';
const A2UI_HTML = '<!doctype html><title>a2ui</title><p>a2ui embed</p>';
const TERMINAL_HTML = '<!doctype html><title>terminal</title><p>terminal embed</p>';
const TICKET = 'lvt_secret-looking-ticket-value';

function apps(overrides: Partial<McpAppsDeps> = {}, seen: EmbedTicketInput[] = []): McpAppsDeps {
	return {
		mode: 'watch',
		liveViewHtml: LIVE_HTML,
		a2uiHtml: A2UI_HTML,
		terminalHtml: TERMINAL_HTML,
		connectDomains: ['wss://gw.example.test'],
		domain: 'abc123.host.example',
		origins: ['https://abc123.host.example'],
		mintTicket: (input) => {
			seen.push(input);
			return Promise.resolve({
				ticket: TICKET,
				ws_url: `wss://gw.example.test/live/${input.sessionId ?? 'default'}/ws`,
				session_id: input.sessionId ?? 'default',
				mode: input.mode,
				expires_in: 30,
				origin_bound: input.origin,
				control_plane_url: `https://gw.example.test/#/view/${input.sessionId ?? 'default'}`,
			});
		},
		...overrides,
	};
}

function registry(): SessionRegistry {
	return new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.reject(new Error('no browser in the unit tier')),
	});
}

function auth(scopes: readonly Scope[]): AuthInfo {
	return { token: 't', clientId: 'key-1', scopes: [...scopes], extra: { owner: 'api-key:key-1' } };
}

/** One request on the named era; the 2026 era carries the `_meta` envelope and the SEP-2243 headers. */
async function rpc(
	handler: { fetch: (r: Request, o?: { authInfo?: AuthInfo }) => Promise<Response> },
	era: string,
	method: string,
	params: Record<string, unknown>,
	authInfo: AuthInfo,
	name?: string,
): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	const body = { ...params };
	if (era === MODERN) {
		body._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: {} };
		headers['mcp-protocol-version'] = MODERN;
		headers['mcp-method'] = method;
		if (name !== undefined) headers['mcp-name'] = name;
	}
	const response = await handler.fetch(
		new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: body }),
		}),
		{ authInfo },
	);
	const reply = await readRpc(response);
	assertEquals(reply.error, undefined, `${method} on ${era}: ${JSON.stringify(reply.error)}`);
	return reply.result as Record<string, unknown>;
}

interface ListedTool {
	name: string;
	_meta?: Record<string, unknown>;
}
interface ListedResource {
	uri: string;
	mimeType?: string;
	_meta?: Record<string, unknown>;
}

/** A deployment with the A2UI, shell-session and stream ticket tools composed, so their `_meta` links show too. */
function depsWith(sessions: SessionRegistry, mcpApps?: McpAppsDeps): McpDeps {
	const none = (): Promise<Record<string, unknown>> => Promise.resolve({});
	return {
		registry: sessions,
		version: '0.0.0-test',
		extraTools: extensionTools({
			a2ui_publish: none,
			a2ui_surface_ticket: none,
			sandbox_session_open: none,
			sandbox_session_ticket: none,
		}),
		...(mcpApps === undefined ? {} : { mcpApps }),
	};
}

const EVERY_SCOPE = auth([...SCOPES]);

for (const era of ERAS) {
	Deno.test(`MCP Apps off — no ui:// resource, no _meta.ui, live tools absent (${era})`, async () => {
		const sessions = registry();
		const handler = createMcpHandler(createBuildServer(depsWith(sessions)), { legacy: 'stateless' });
		try {
			const { tools } = await rpc(handler, era, 'tools/list', {}, EVERY_SCOPE) as { tools: ListedTool[] };
			const names = tools.map((tool) => tool.name);
			assert(!names.includes('browser_live_view') && !names.includes('browser_live_ticket'), names.join(','));
			assert(names.includes('a2ui_publish'), 'the A2UI tool is composed in this fixture');
			for (const tool of tools) assertEquals(tool._meta?.ui, undefined, `${tool.name} carries _meta.ui while off`);
			for (const tool of tools) assertEquals(tool._meta?.['ui/resourceUri'], undefined, tool.name);
			const { resources } = await rpc(handler, era, 'resources/list', {}, EVERY_SCOPE) as {
				resources: ListedResource[];
			};
			assertEquals(resources.filter((resource) => resource.uri.startsWith('ui://')), []);

			const result = await rpc(
				handler,
				era,
				'tools/call',
				{ name: 'browser_live_view', arguments: {} },
				EVERY_SCOPE,
				'browser_live_view',
			) as {
				isError?: boolean;
				content: Array<{ text: string }>;
				structuredContent: { error: Record<string, unknown> };
			};
			assertEquals(result.isError, true);
			assertStringIncludes(result.content[0]!.text, 'Error: feature-unavailable:');
			assertStringIncludes(result.content[0]!.text, 'TTK_MCP_APPS');
			assertEquals(result.structuredContent.error.feature, undefined);
		} finally {
			await handler.close();
			await sessions.shutdown();
		}
	});

	Deno.test(`tools/list and resources/read carry _meta.ui when MCP Apps is on (${era})`, async () => {
		const sessions = registry();
		const deployment = apps();
		const handler = createMcpHandler(createBuildServer(depsWith(sessions, deployment)), { legacy: 'stateless' });
		try {
			const { tools } = await rpc(handler, era, 'tools/list', {}, EVERY_SCOPE) as { tools: ListedTool[] };
			const byName = new Map(tools.map((tool) => [tool.name, tool]));
			for (const [name, ui] of TOOL_UI) {
				const tool = byName.get(name);
				assert(tool !== undefined, `${name} is listed`);
				assertEquals(tool._meta, toolUiMeta(name), `${name}'s _meta on ${era}`);
				assertEquals(tool._meta?.ui, { resourceUri: ui.resourceUri, visibility: [...ui.visibility] });
				assertEquals(tool._meta?.['ui/resourceUri'], ui.resourceUri, 'the flat draft key rides along');
			}
			for (const ticket of ['browser_live_ticket', 'a2ui_surface_ticket', 'sandbox_session_ticket']) {
				assertEquals((byName.get(ticket)?._meta?.ui as { visibility: string[] }).visibility, ['app'], ticket);
			}
			for (const tool of tools) if (!TOOL_UI.has(tool.name)) assertEquals(tool._meta, undefined, tool.name);

			const { resources } = await rpc(handler, era, 'resources/list', {}, EVERY_SCOPE) as {
				resources: ListedResource[];
			};
			const ui = resources.filter((resource) => resource.uri.startsWith('ui://'));
			assertEquals(ui.map((resource) => resource.uri).sort(), [A2UI_SURFACE_UI_URI, LIVE_VIEW_UI_URI, TERMINAL_UI_URI]);
			const expectedMeta = resourceUiMeta(deployment);
			for (const resource of ui) {
				assertEquals(resource.mimeType, UI_RESOURCE_MIME);
				assertEquals(resource._meta, expectedMeta, `${resource.uri} list entry on ${era}`);
			}
			assertEquals(expectedMeta, {
				ui: {
					csp: {
						connectDomains: ['wss://gw.example.test'],
						resourceDomains: [],
						frameDomains: [],
						baseUriDomains: [],
					},
					prefersBorder: true,
					domain: 'abc123.host.example',
				},
			});

			for (
				const [uri, html] of [
					[LIVE_VIEW_UI_URI, LIVE_HTML],
					[A2UI_SURFACE_UI_URI, A2UI_HTML],
					[TERMINAL_UI_URI, TERMINAL_HTML],
				] as const
			) {
				const { contents } = await rpc(handler, era, 'resources/read', { uri }, EVERY_SCOPE, uri) as {
					contents: Array<{ uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }>;
				};
				assertEquals(contents.length, 1);
				assertEquals(contents[0]!.uri, uri);
				assertEquals(contents[0]!.mimeType, UI_RESOURCE_MIME);
				assertEquals(contents[0]!.text, html);
				assertEquals(contents[0]!._meta, expectedMeta, `${uri} read content on ${era}`);
			}
		} finally {
			await handler.close();
			await sessions.shutdown();
		}
	});
}

Deno.test('the ui:// documents are offered only to mcp:invoke, like the session resources', async () => {
	const sessions = registry();
	const handler = createMcpHandler(createBuildServer(depsWith(sessions, apps())), { legacy: 'stateless' });
	try {
		const { resources } = await rpc(handler, ERA_2025, 'resources/list', {}, auth(['view:watch'])) as {
			resources: ListedResource[];
		};
		assertEquals(resources.filter((resource) => resource.uri.startsWith('ui://')), []);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});

Deno.test('a domain left unset is absent from _meta.ui, not an empty string', () => {
	const { domain: _domain, ...rest } = apps();
	assertEquals((resourceUiMeta(rest).ui as Record<string, unknown>).domain, undefined);
	assertEquals('domain' in (resourceUiMeta(rest).ui as Record<string, unknown>), false);
});

/** A registry stand-in holding one session the live view can describe, without a browser. */
function oneSession(lock: unknown = null) {
	const record = {
		id: 'work',
		viewers: new Map([['v1', {}], ['v2', {}]]),
		lock,
		session: {
			tabs: [
				{ tabId: 'aaaa', targetId: 'target-other', url: 'https://other.example/x', title: 'Other' },
				{ tabId: 'bbbb', targetId: 'target-focus', url: 'https://shop.example/cart?token=abc#f', title: 'Cart' },
			],
			agentFocusTargetId: 'target-focus',
			sessionManager: null,
		},
	};
	const touched: string[] = [];
	const registry = {
		peekFor: (id: string | undefined) => (id ?? 'default') === 'work' ? record : undefined,
		touch: (id: string) => touched.push(id),
	} as unknown as SessionRegistry;
	return { registry, touched };
}

Deno.test('browser_live_view reports origin, title, viewers and control — no path, no query, no ticket', async () => {
	const { registry, touched } = oneSession();
	const watchOnly = createToolExecutor({ registry, version: 't', mcpApps: apps() }, 'api-key:key-1', new Set(SCOPES));
	const result = await watchOnly('browser_live_view', { session_id: 'work' }) as {
		isError?: boolean;
		content: Array<{ text: string }>;
		structuredContent: Record<string, unknown>;
	};
	assertEquals(result.isError, undefined, JSON.stringify(result));
	assertEquals(result.structuredContent, {
		session_id: 'work',
		origin: 'https://shop.example',
		title: 'Cart',
		viewers: 2,
		human_has_control: false,
		control_available: false,
	});
	assertEquals(APPS_OUTPUT.browser_live_view.parse(result.structuredContent), result.structuredContent);
	assert(!result.content[0]!.text.includes('cart') && !result.content[0]!.text.includes('token'));
	assertEquals(touched, ['work']);

	const control = apps({ mode: 'control' });
	const withScope = createToolExecutor({ registry, version: 't', mcpApps: control }, 'o', new Set(SCOPES));
	assertEquals(
		((await withScope('browser_live_view', { session_id: 'work' })) as {
			structuredContent: { control_available: boolean };
		})
			.structuredContent.control_available,
		true,
	);
	const watcher = createToolExecutor(
		{ registry, version: 't', mcpApps: control },
		'o',
		new Set<Scope>(['mcp:invoke', 'view:watch']),
	);
	assertEquals(
		((await watcher('browser_live_view', { session_id: 'work' })) as {
			structuredContent: { control_available: boolean };
		})
			.structuredContent.control_available,
		false,
	);

	const missing = await watchOnly('browser_live_view', {}) as { isError?: boolean; content: Array<{ text: string }> };
	assertEquals(missing.isError, true);
	assertStringIncludes(missing.content[0]!.text, 'Error: unknown-session:');
});

Deno.test('browser_live_ticket mints through the deployment with the caller, and the text never carries the ticket', async () => {
	const sessions = registry();
	const seen: EmbedTicketInput[] = [];
	const handler = createMcpHandler(createBuildServer(depsWith(sessions, apps({}, seen))), { legacy: 'stateless' });
	type Called = { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
	const call = async (args: Record<string, unknown>): Promise<Called> =>
		await rpc(
			handler,
			ERA_2025,
			'tools/call',
			{ name: 'browser_live_ticket', arguments: args },
			auth(['mcp:invoke', 'view:watch']),
			'browser_live_ticket',
		) as unknown as Called;
	try {
		const result = await call({ session_id: 'work', origin: 'https://abc123.host.example' });
		assertEquals(result.isError, undefined, JSON.stringify(result));
		assertEquals(result.structuredContent, {
			ticket: TICKET,
			ws_url: 'wss://gw.example.test/live/work/ws',
			session_id: 'work',
			mode: 'watch',
			expires_in: 30,
			origin_bound: 'https://abc123.host.example',
			control_plane_url: 'https://gw.example.test/#/view/work',
		});
		assertEquals(APPS_OUTPUT.browser_live_ticket.parse(result.structuredContent), result.structuredContent);
		for (const block of result.content) {
			assert(!block.text.includes(TICKET), 'a model-readable block carries the ticket');
		}
		assertEquals(seen.length, 1);
		const input = seen[0]!;
		assertEquals([input.principal, input.sessionId, input.mode, input.origin], [
			'key-1',
			'work',
			'watch',
			'https://abc123.host.example',
		]);
		assertEquals(input.access, { owner: 'api-key:key-1', admin: false });
		assertEquals([...input.scopes].sort(), ['mcp:invoke', 'view:watch']);
		assertEquals(input.holderName, null, 'the gateway resolves the label');

		const noOrigin = await call({ session_id: 'work' });
		assertStringIncludes(noOrigin.content[0]!.text, 'Error: invalid-arguments:');
		assertEquals(seen.length, 1);

		const executor = createToolExecutor(
			{ registry: sessions, version: 't', mcpApps: apps({}, seen) },
			'api-key:key-1',
			new Set<Scope>(['mcp:invoke', 'view:watch']),
		);
		const refused = await executor('browser_live_ticket', {
			session_id: 'work',
			origin: 'https://abc123.host.example',
		}) as Called;
		assertEquals(refused.isError, true);
		assertStringIncludes(refused.content[0]!.text, 'Error: invalid-arguments: call browser_live_ticket directly');
		assertEquals(seen.length, 1);
	} finally {
		await handler.close();
		await sessions.shutdown();
	}
});
