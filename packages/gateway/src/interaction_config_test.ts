/**
 * mcp-recommendations W4 at the gateway: `TTK_CONFIRM_DESTRUCTIVE` (R5, D-125) and `TTK_HUMAN_HANDOFF` (R2, D-124)
 * from the environment to the wire.
 *
 * The parse first; then the composed app, through its real `/mcp` route, with a faked browser: the handoff tool is
 * present by default (D-150) and absent once switched off, and hands out the control plane's live-view route under the
 * *configured* public URL — never the request's Host — with no ticket in it; the admin diagnostics name both switches.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { ConfigError, ENV_NAMES, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const PUBLIC = 'https://mcp.example.test';

Deno.test('W4 config: confirmations and (D-150) the handoff default on, both strict booleans', () => {
	assert((ENV_NAMES as readonly string[]).includes('TTK_CONFIRM_DESTRUCTIVE'));
	assert((ENV_NAMES as readonly string[]).includes('TTK_HUMAN_HANDOFF'));
	const base = { TTK_HOST: '127.0.0.1' };
	const defaults = loadConfig(base);
	assertEquals(defaults.confirmDestructive, true);
	assertEquals(defaults.humanHandoff, true);
	// An empty value is unset, as for every boolean here.
	assertEquals(loadConfig({ ...base, TTK_HUMAN_HANDOFF: '' }).humanHandoff, true);
	const flipped = loadConfig({ ...base, TTK_CONFIRM_DESTRUCTIVE: 'false', TTK_HUMAN_HANDOFF: 'false' });
	assertEquals(flipped.confirmDestructive, false);
	assertEquals(flipped.humanHandoff, false);
	for (const name of ['TTK_CONFIRM_DESTRUCTIVE', 'TTK_HUMAN_HANDOFF']) {
		const error = assertThrows(() => loadConfig({ ...base, [name]: 'maybe' }), ConfigError);
		assertStringIncludes(error.message, name);
	}
});

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'w4-fake-session' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

async function gateway(env: Record<string, string>) {
	const user = await generateApiKey('user-key', ['mcp:invoke', 'view:watch', 'view:control']);
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_PUBLIC_URL: PUBLIC,
		TTK_API_KEYS: JSON.stringify([user.record, admin.record]),
		TTK_LOG_LEVEL: 'error',
		...env,
	});
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	await registry.resolve(undefined);
	const app = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
	});
	// The Host a client sends is the public name; the URL a tool returns must come from the configuration even so.
	const headers = (key: string) => ({
		host: 'mcp.example.test',
		authorization: `Bearer ${key}`,
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	});
	const mcp = async (method: string, params: Record<string, unknown>, modern = false) => {
		const response = await app.app.request(`${PUBLIC}/mcp`, {
			method: 'POST',
			headers: {
				...headers(user.key),
				...(modern
					? { 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) }
					: {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		return JSON.parse(line === undefined ? text : line.slice('data: '.length)) as { result?: Record<string, unknown> };
	};
	const diagnostics = async () =>
		(await (await app.app.request(`${PUBLIC}/api/v1/system/diagnostics`, {
			headers: { host: 'mcp.example.test', authorization: `Bearer ${admin.key}` },
		})).json())
			.config as Record<string, unknown>;
	return {
		mcp,
		diagnostics,
		async [Symbol.asyncDispose]() {
			await app.close();
			await registry.shutdown();
		},
	};
}

const listed = async (g: Awaited<ReturnType<typeof gateway>>) =>
	((await g.mcp('tools/list', {})).result?.tools as Array<{ name: string }>).map((tool) => tool.name);

Deno.test('W4 gateway (D-150): by default the handoff is offered, switched off it is absent, and the diagnostics say so', async () => {
	{
		await using g = await gateway({});
		const names = await listed(g);
		assert(names.includes('browser_list_sessions'), 'the listing is the real catalog');
		assert(names.includes('browser_request_human'), 'D-150: on by default');
		const config = await g.diagnostics();
		assertEquals(config.confirmations, true);
		assertEquals(config.humanHandoff, true);
	}
	await using off = await gateway({ TTK_HUMAN_HANDOFF: 'false' });
	assert(!(await listed(off)).includes('browser_request_human'), 'an explicit false is authoritative');
	assertEquals((await off.diagnostics()).humanHandoff, false);
});

Deno.test('W4 gateway: TTK_HUMAN_HANDOFF hands out <TTK_PUBLIC_URL>/#/view/<id>, with no ticket and no query', async () => {
	await using g = await gateway({ TTK_HUMAN_HANDOFF: 'true', TTK_CONFIRM_DESTRUCTIVE: 'false' });
	assert((await listed(g)).includes('browser_request_human'));
	const config = await g.diagnostics();
	assertEquals(config.confirmations, false);
	assertEquals(config.humanHandoff, true);

	// A 2025 client (no capabilities on the stateless mount) is handed the link.
	const linked = (await g.mcp('tools/call', { name: 'browser_request_human', arguments: { reason: 'sign in' } }))
		.result as { structuredContent: Record<string, unknown> };
	assertEquals(linked.structuredContent.live_view_url, `${PUBLIC}/#/view/default`);
	assertEquals(linked.structuredContent.outcome, 'link-returned');

	// A 2026 client that opens URLs is asked to open the same one.
	const asked = (await g.mcp('tools/call', {
		name: 'browser_request_human',
		arguments: { reason: 'sign in' },
		_meta: {
			[PROTOCOL_VERSION_META_KEY]: '2026-07-28',
			[CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
		},
	}, true)).result as { resultType: string; inputRequests: Record<string, { params: { url: string } }> };
	assertEquals(asked.resultType, 'input_required');
	const url = new URL(asked.inputRequests.ttk_handoff!.params.url);
	assertEquals(url.href, `${PUBLIC}/#/view/default`);
	assertEquals(url.search, '');
	assert(!url.href.includes('ticket'), 'a ticket rode the handoff URL');
});
