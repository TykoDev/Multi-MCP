/**
 * R14 (D-122, AC16): the server's identity and instructions, on both eras, through the real HTTP entry.
 *
 * The 2025 `initialize` result carries `serverInfo` and `instructions`; the 2026-07-28 `server/discover` result
 * carries `instructions`, and the SDK stamps `serverInfo` into its `_meta`. The instructions are checked against the
 * three promises the design makes: at most 2 KiB, no configuration value, and no live-view sentence for a caller
 * without a view scope.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
	SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { buildCapabilities } from './capabilities.ts';
import {
	MAX_INSTRUCTIONS_BYTES,
	SERVER_DESCRIPTION,
	SERVER_TITLE,
	serverImplementation,
	serverInstructions,
} from './identity.ts';
import { SessionRegistry } from './registry.ts';
import { type Scope, SCOPES } from './scopes.ts';
import { createBuildServer, type McpDeps } from './server.ts';

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
const IDENTITY = { websiteUrl: 'https://ttk.example', iconUrl: 'https://ttk.example/assets/brand/icon-192.png' };
/** Configuration values that must never reach the instructions. */
const CONFIG_SENTINELS = ['allowed-sentinel.example', 'https://ttk.example', '0.0.0-identity'];

const LIVE_VIEW = {
	origins_managed: true,
	ticket_ttl_max_s: { view: 300, control: 60 },
	frame_scale: true,
	hover: true,
	highlight: true,
	keyframe: true,
} as const;

function deps(registry: SessionRegistry, identity?: McpDeps['identity']): McpDeps {
	return {
		registry,
		version: '0.0.0-identity',
		allowedDomains: ['allowed-sentinel.example'],
		liveView: LIVE_VIEW,
		eventTransports: ['sse', 'websocket'],
		...(identity === undefined ? {} : { identity }),
	};
}

function auth(scopes: readonly Scope[]): AuthInfo {
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

Deno.test('AC16: serverImplementation carries title, description, website and a PNG icon only when given', () => {
	assertEquals(serverImplementation('1.2.3', IDENTITY), {
		name: 'tykotech-mcp',
		title: SERVER_TITLE,
		version: '1.2.3',
		description: SERVER_DESCRIPTION,
		websiteUrl: IDENTITY.websiteUrl,
		icons: [{ src: IDENTITY.iconUrl, mimeType: 'image/png', sizes: ['192x192'] }],
	});
	// stdio passes no identity: no website, no icon.
	assertEquals(serverImplementation('1.2.3'), {
		name: 'tykotech-mcp',
		title: SERVER_TITLE,
		version: '1.2.3',
		description: SERVER_DESCRIPTION,
	});
});

Deno.test('AC16: the instructions follow the filtered capability block, sentence by sentence', () => {
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

for (const era of [LEGACY, MODERN]) {
	Deno.test(`AC16 (${era}): the identity and the instructions reach the client`, async () => {
		const registry = new SessionRegistry({ reapIntervalMs: 0 });
		const handler = createMcpHandler(createBuildServer(deps(registry, IDENTITY)), { legacy: 'stateless' });
		try {
			let serverInfo: Record<string, unknown> | undefined;
			let instructions: unknown;
			if (era === LEGACY) {
				const result = await rpc(handler, era, 'initialize', auth(['mcp:invoke']));
				serverInfo = result.serverInfo as Record<string, unknown>;
				instructions = result.instructions;
			} else {
				const result = await rpc(handler, era, 'server/discover', auth(['mcp:invoke']));
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

Deno.test('AC16: a viewer credential is told about the live view and not about the tools', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const handler = createMcpHandler(createBuildServer(deps(registry)), { legacy: 'stateless' });
	try {
		const result = await rpc(handler, LEGACY, 'initialize', auth(['view:watch']));
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
