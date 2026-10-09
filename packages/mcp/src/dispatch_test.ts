/**
 * The `tools/call` seam, both protocol eras, and the SDK-upgrade detector.
 *
 * The first test here is U-9: it asserts that a second
 * `setRequestHandler('tools/call', …)` *replaces* the SDK's dispatch rather
 * than throwing. That is a fact about a pinned dependency, not about this
 * repository, so it is asserted rather than assumed — an SDK minor that made
 * the second registration throw fails here, at `deno install` time, instead of
 * in production. `SPECS/API-CONTRACT.md` §8 already makes an SDK upgrade a
 * governed moment; this is the tripwire that reaches it.
 *
 * Everything below it drives the three failure classes through the real HTTP
 * entry on **both** eras, because the era decides which wire codec validates
 * the result and projects it.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	McpServer,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { CATALOG_BY_NAME } from './catalog.ts';
import { clientFactsOf, dispatchToolCall } from './dispatch.ts';
import type { Scope } from './scopes.ts';
import { SessionRegistry } from './registry.ts';
import { createBuildServer } from './server.ts';
import type { ToolContext } from './types.ts';

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';

// ---------------------------------------------------------------------------
// U-9: the seam itself
// ---------------------------------------------------------------------------

Deno.test('U-9: the SDK admits a replacement tools/call handler after registerTool', async () => {
	const server = new McpServer({ name: 'seam-probe', version: '0.0.0' });
	server.registerTool(
		'probe',
		{ description: 'the SDK-owned handler', inputSchema: z.object({}) },
		() => ({ content: [{ type: 'text' as const, text: 'sdk' }] }),
	);

	// The whole probe: `registerTool` has auto-installed the SDK's own
	// `tools/call`, and this must overwrite it rather than throw. If this line
	// throws, D-A2 is not implementable as designed and B1 stops here.
	server.server.setRequestHandler('tools/call', () => ({
		content: [{ type: 'text' as const, text: 'ours' }],
	}));

	// And it must actually *run*: a registration that silently landed somewhere
	// the dispatcher never reads would pass a no-throw assertion and fail in
	// production, which is the failure this probe exists to exclude.
	const handler = createMcpHandler(() => server, { legacy: 'stateless' });
	try {
		const result = await callTool(handler, LEGACY, 'probe', {});
		assertEquals((result.content as Array<{ text: string }>)[0]?.text, 'ours');
	} finally {
		await handler.close();
	}
});

// ---------------------------------------------------------------------------
// The error envelope, on both eras
// ---------------------------------------------------------------------------

/** A registry that can never launch a browser: no test here needs one. */
function registry(): SessionRegistry {
	return new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.reject(new Error('no browser in the unit tier')),
	});
}

/** `mcp:invoke` alone — no `task`, no `admin`. */
const NARROW: AuthInfo = { token: 't', clientId: 'narrow', scopes: ['mcp:invoke'], extra: {} };

interface RpcResult {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: { error?: { code?: string; message?: string; feature?: string } };
	isError?: boolean;
}

/** Reads a streamable-HTTP response body, which is JSON on one era and SSE on the other. */
async function readRpc(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const type = response.headers.get('content-type') ?? '';
	if (type.includes('text/event-stream')) {
		for (const line of text.split('\n')) {
			if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
		}
		throw new Error(`no data frame in SSE body: ${text}`);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

/**
 * The `params` of one `tools/call`, on the named era.
 *
 * The era is chosen by the body: a request carrying the 2026 `_meta` envelope
 * is classified modern, and one without it is classified legacy and served by
 * the stateless fallback.
 */
function callParams(era: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
	const params: Record<string, unknown> = { name, arguments: args };
	if (era === MODERN) {
		params._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: {} };
	}
	return params;
}

/** SEP-2243 requires the method and the tool name in headers on the modern era. */
function modernHeaders(era: string, name: string): HeadersInit {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (era === MODERN) {
		headers['mcp-method'] = 'tools/call';
		headers['mcp-name'] = name;
	}
	return headers;
}

/** One `tools/call`, on the named era. */
async function callTool(
	handler: { fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response> },
	era: string,
	name: string,
	args: Record<string, unknown>,
	authInfo?: AuthInfo,
): Promise<RpcResult> {
	const request = new Request('http://127.0.0.1/mcp', {
		method: 'POST',
		headers: modernHeaders(era, name),
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: callParams(era, name, args) }),
	});
	const response = await handler.fetch(request, authInfo === undefined ? {} : { authInfo });
	const body = await readRpc(response);
	assertEquals(body.error, undefined, `expected a result, got a JSON-RPC error: ${JSON.stringify(body.error)}`);
	return body.result as RpcResult;
}

/** A handler over the real catalog, with no persistence and no encoder. */
function fixture() {
	const sessions = registry();
	const handler = createMcpHandler(
		createBuildServer({ registry: sessions, version: '0.0.0-test' }),
		{ legacy: 'stateless' },
	);
	return {
		handler,
		async [Symbol.asyncDispose]() {
			await handler.close();
			await sessions.shutdown();
		},
	};
}

for (const era of [LEGACY, MODERN]) {
	Deno.test(`dispatch (${era}): a tool the principal lacks the scope for answers scope-required`, async () => {
		await using f = fixture();
		// `browser_run_task` carries the `task` scope, so this principal never
		// saw it in `tools/list`. Before the seam this answered `Tool ... not
		// found` — indistinguishable from a tool this build does not have.
		const result = await callTool(f.handler, era, 'browser_run_task', { task: 'x' }, NARROW);

		assertEquals(result.isError, true);
		assertStringIncludes(result.content?.[0]?.text ?? '', 'Error: scope-required: ');
		assertEquals(result.structuredContent?.error?.code, 'scope-required');
		// SEC-17: the code says a grant is missing; the message never says which,
		// because naming it tells a caller exactly what to request or phish.
		const whole = JSON.stringify(result);
		for (const scope of ['task', 'admin', 'view:watch', 'view:control', 'mcp:invoke']) {
			assert(!whole.includes(`"${scope}"`), `the refusal named the scope ${scope}: ${whole}`);
		}
		assert(!(result.content?.[0]?.text ?? '').includes('scope'.concat('s')), 'the detail must not list scopes');
	});

	Deno.test(`dispatch (${era}): an argument violation answers invalid-arguments with a code (G-3)`, async () => {
		await using f = fixture();
		// `browser_click` refuses index-and-coordinates together. The SDK's own
		// handler throws this inside itself and converts it with a fixed
		// `Input validation error:` prefix and no structuredContent, so this
		// assertion is only reachable through the seam.
		const result = await callTool(f.handler, era, 'browser_click', { index: 1, coordinate_x: 2, coordinate_y: 3 });

		assertEquals(result.isError, true);
		assertStringIncludes(result.content?.[0]?.text ?? '', 'Error: invalid-arguments: ');
		assertEquals(result.structuredContent?.error?.code, 'invalid-arguments');
	});

	Deno.test(`dispatch (${era}): a handler failure keeps its code and gains the structured half`, async () => {
		await using f = fixture();
		const result = await callTool(f.handler, era, 'browser_navigate', { url: 'ftp://example.test/x' });

		assertEquals(result.isError, true);
		assertStringIncludes(result.content?.[0]?.text ?? '', 'Error: navigation-blocked: ');
		assertEquals(result.structuredContent?.error?.code, 'navigation-blocked');
		// The message is the detail alone: the code is its own field, and
		// repeating it inside the message invites a client to parse the message.
		assert(!(result.structuredContent?.error?.message ?? '').startsWith('navigation-blocked'));
	});

	Deno.test(`dispatch (${era}): an unknown tool is still a protocol error, not a result`, async () => {
		await using f = fixture();
		const request = new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers: modernHeaders(era, 'browser_does_not_exist'),
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: callParams(era, 'browser_does_not_exist', {}),
			}),
		});
		const body = await readRpc(await f.handler.fetch(request));
		// A name nobody ever registered is a caller bug about the protocol, not a
		// condition the model can act on — so it stays a JSON-RPC error, exactly
		// as the SDK answered it before the seam.
		assert(body.error !== undefined, `expected a JSON-RPC error, got ${JSON.stringify(body)}`);
	});
}

Deno.test('dispatch: a tool the deployment cannot offer answers feature-unavailable, naming the feature', async () => {
	await using f = fixture();
	// No `TTK_DATA_DIR` in this fixture, so `browser_storage_state` is
	// registered-and-disabled. Naming `persistence` is safe: it is a static
	// deployment fact an operator chose, not an authorization boundary.
	const result = await callTool(f.handler, LEGACY, 'browser_storage_state', { action: 'save' });

	assertEquals(result.isError, true);
	assertStringIncludes(result.content?.[0]?.text ?? '', 'Error: feature-unavailable: ');
	assertEquals(result.structuredContent?.error?.code, 'feature-unavailable');
	assertEquals(result.structuredContent?.error?.feature, 'persistence');
});

Deno.test('dispatch: scope-required and feature-unavailable are distinguishable by code', async () => {
	await using f = fixture();
	const refused = await callTool(f.handler, LEGACY, 'browser_run_task', { task: 'x' }, NARROW);
	const absent = await callTool(f.handler, LEGACY, 'browser_storage_state', { action: 'save' });
	assertEquals(refused.structuredContent?.error?.code, 'scope-required');
	assertEquals(absent.structuredContent?.error?.code, 'feature-unavailable');
});

Deno.test('dispatch: a handler throwing a non-ToolError becomes browser-unavailable with a code', async () => {
	const logged: string[] = [];
	const sessions = registry();
	const ctx = { registry: sessions, allowedDomains: [], principal: 'p' } as ToolContext;
	const broken = {
		...CATALOG_BY_NAME.get('browser_list_sessions')!,
		handler: () => Promise.reject(new TypeError('the page went away')),
	};
	try {
		const result = await dispatchToolCall(
			{
				catalog: new Map([['browser_list_sessions', broken]]),
				permitted: new Set(['browser_list_sessions']),
				scopes: new Set<Scope>(['mcp:invoke']),
				availability: { persistence: false, recording: false, egress: false },
				ctx,
				logger: { warn: (m) => logged.push(m), info: () => {} },
			},
			'browser_list_sessions',
			{},
		);

		const typed = result as RpcResult;
		assertEquals(typed.isError, true);
		assertStringIncludes(typed.content?.[0]?.text ?? '', 'Error: browser-unavailable: the page went away');
		assertEquals(typed.structuredContent?.error?.code, 'browser-unavailable');
		assertEquals(logged.length, 1, 'an unexpected throw is logged exactly once');
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('errors: exactly one module produces the `Error: <code>: ` wire prefix (F-4)', async () => {
	// `server.ts:130-135` hand-formatted a second copy of this prefix before the
	// seam removed it, so a change to the prefix in `ToolError.wireText` would
	// silently not have applied to it. A source scan is the only check that
	// stays true as handlers move between modules.
	const producers: string[] = [];
	for await (const entry of Deno.readDir(new URL('.', import.meta.url))) {
		if (!entry.isFile || !entry.name.endsWith('.ts') || entry.name.endsWith('_test.ts')) continue;
		const source = await Deno.readTextFile(new URL(entry.name, import.meta.url));
		if (/(['"`])Error: \$\{|['"`]Error: [a-z-]+: /.test(source)) producers.push(entry.name);
	}
	assertEquals(producers, ['errors.ts'], `the Error: prefix is built outside errors.ts in ${producers.join(', ')}`);
});

/**
 * S0 (design §2.0 item 6): the four client facts, read the way the SDK reads the capabilities. A bare
 * `elicitation: {}` is form (the SDK's own default); one naming only `url` is not.
 */
Deno.test('S0: clientFactsOf reduces declared capabilities to the four facts', () => {
	const none = { sampling: false, samplingTools: false, elicitForm: false, elicitUrl: false };
	assertEquals(clientFactsOf(undefined), undefined, 'no capabilities at all (the 2025 stateless path) is unknown');
	assertEquals(clientFactsOf({}), none);
	assertEquals(clientFactsOf({ sampling: {} }), { ...none, sampling: true });
	assertEquals(clientFactsOf({ sampling: { tools: {} } }), { ...none, sampling: true, samplingTools: true });
	assertEquals(clientFactsOf({ elicitation: {} }), { ...none, elicitForm: true }, 'bare elicitation is form');
	assertEquals(clientFactsOf({ elicitation: { form: {} } }), { ...none, elicitForm: true });
	assertEquals(clientFactsOf({ elicitation: { url: {} } }), { ...none, elicitUrl: true }, 'url alone is not form');
	assertEquals(clientFactsOf({ elicitation: { form: {}, url: {} } }), { ...none, elicitForm: true, elicitUrl: true });
});

Deno.test('S0: dispatchToolCall hands the client facts to the handler, and nothing when there are none', async () => {
	const sessions = registry();
	const seen: (ToolContext['client'] | 'absent')[] = [];
	const probe = {
		...CATALOG_BY_NAME.get('browser_list_sessions')!,
		handler: (_args: unknown, ctx: ToolContext) => {
			seen.push('client' in ctx ? ctx.client : 'absent');
			return Promise.resolve({ content: [], structuredContent: { sessions: [] } });
		},
	};
	const dispatch = {
		catalog: new Map([['browser_list_sessions', probe]]),
		permitted: new Set(['browser_list_sessions']),
		scopes: new Set<Scope>(['mcp:invoke']),
		availability: { persistence: false, recording: false, egress: false },
		ctx: { registry: sessions, allowedDomains: [], principal: 'p' } as ToolContext,
	};
	const facts = { sampling: true, samplingTools: false, elicitForm: true, elicitUrl: false };
	try {
		await dispatchToolCall(dispatch, 'browser_list_sessions', {}, undefined, undefined, facts);
		await dispatchToolCall(dispatch, 'browser_list_sessions', {});
		assertEquals(seen, [facts, 'absent']);
	} finally {
		await sessions.shutdown();
	}
});
