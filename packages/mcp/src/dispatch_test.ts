/** The `tools/call` seam, both protocol eras, and the SDK-upgrade detector. */
import { readRpc } from '../fixtures/capture_session.ts';
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	type ClientCapabilities,
	createMcpHandler,
	McpServer,
	PROTOCOL_VERSION_META_KEY,
	type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import { CATALOG_BY_NAME } from './catalog.ts';
import {
	type ArgumentIssue,
	clientFactsOf,
	CONFIRM_KEY,
	CONFIRM_MESSAGES,
	CONFIRM_TOOL_NAMES,
	confirmGate,
	describeIssues,
	dispatchToolCall,
	parseArguments,
	repairArguments,
} from './dispatch.ts';
import type { Scope } from './scopes.ts';
import { SessionRegistry } from './registry.ts';
import { SecretStore } from './secrets.ts';
import { createBuildServer, type McpDeps } from './server.ts';
import type { ClientFacts, ToolContext } from './types.ts';
import { A2uiMessageSchema } from '@tykotech/wire';
import { join } from '@std/path';
import { LibraryStore } from './library.ts';
import { assertNavigable, canonicalHost, isHostAllowed, originOf, ToolError } from './errors.ts';

const MODERN = '2026-07-28';
const ERA_2025 = '2025-06-18';

// --------------------------------------------------------------------------- the seam itself
// ---------------------------------------------------------------------------

Deno.test('the SDK admits a replacement tools/call handler after registerTool', async () => {
	const server = new McpServer({ name: 'seam-probe', version: '0.0.0' });
	server.registerTool(
		'probe',
		{ description: 'the SDK-owned handler', inputSchema: z.object({}) },
		() => ({ content: [{ type: 'text' as const, text: 'sdk' }] }),
	);

	server.server.setRequestHandler('tools/call', () => ({
		content: [{ type: 'text' as const, text: 'ours' }],
	}));

	const handler = createMcpHandler(() => server, { legacy: 'stateless' });
	try {
		const result = await callTool(handler, ERA_2025, 'probe', {});
		assertEquals((result.content as Array<{ text: string }>)[0]?.text, 'ours');
	} finally {
		await handler.close();
	}
});

// --------------------------------------------------------------------------- The error envelope, on both eras
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

/** The `params` of one `tools/call`, on the named era. */
function callParams(era: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
	const params: Record<string, unknown> = { name, arguments: args };
	if (era === MODERN) {
		params._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: {} };
	}
	return params;
}

/** SEP-2243 requires the protocol version, the method and the tool name in headers on the modern era. */
function modernHeaders(era: string, name: string): HeadersInit {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (era === MODERN) {
		headers['mcp-protocol-version'] = MODERN;
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

for (const era of [ERA_2025, MODERN]) {
	Deno.test(`dispatch (${era}): a tool the principal lacks the scope for answers scope-required`, async () => {
		await using f = fixture();
		const result = await callTool(f.handler, era, 'browser_run_task', { task: 'x' }, NARROW);

		assertEquals(result.isError, true);
		assertStringIncludes(result.content?.[0]?.text ?? '', 'Error: scope-required: ');
		assertEquals(result.structuredContent?.error?.code, 'scope-required');
		const whole = JSON.stringify(result);
		for (const scope of ['task', 'admin', 'view:watch', 'view:control', 'mcp:invoke']) {
			assert(!whole.includes(`"${scope}"`), `the refusal named the scope ${scope}: ${whole}`);
		}
		assert(!(result.content?.[0]?.text ?? '').includes('scope'.concat('s')), 'the detail must not list scopes');
	});

	Deno.test(`dispatch (${era}): an argument violation answers invalid-arguments with a code`, async () => {
		await using f = fixture();
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
		assert(body.error !== undefined, `expected a JSON-RPC error, got ${JSON.stringify(body)}`);
	});
}

Deno.test('dispatch: a tool the deployment cannot offer answers feature-unavailable, naming the feature', async () => {
	await using f = fixture();
	const result = await callTool(f.handler, ERA_2025, 'browser_storage_state', { action: 'save' });

	assertEquals(result.isError, true);
	assertStringIncludes(result.content?.[0]?.text ?? '', 'Error: feature-unavailable: ');
	assertEquals(result.structuredContent?.error?.code, 'feature-unavailable');
	assertEquals(result.structuredContent?.error?.feature, 'persistence');
});

Deno.test('dispatch: scope-required and feature-unavailable are distinguishable by code', async () => {
	await using f = fixture();
	const refused = await callTool(f.handler, ERA_2025, 'browser_run_task', { task: 'x' }, NARROW);
	const absent = await callTool(f.handler, ERA_2025, 'browser_storage_state', { action: 'save' });
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

Deno.test('dispatch: a stored secret the page echoes back never leaves in a result, success or error', async () => {
	const sessions = registry();
	const secrets = new SecretStore([{ name: 'pw', value: 'hunter2-long', domains: [] }]);
	const ctx = { registry: sessions, allowedDomains: [], principal: 'p', secrets } as ToolContext;
	const echo = (fail: boolean) => ({
		...CATALOG_BY_NAME.get('browser_list_sessions')!,
		outputSchema: z.object({ url: z.string(), value: z.string() }),
		handler: () =>
			fail ? Promise.reject(new TypeError('field said hunter2-long')) : Promise.resolve({
				content: [{ type: 'text' as const, text: 'value=hunter2-long' }],
				structuredContent: { url: 'https://x/?q=hunter2-long', value: 'hunter2-long' },
			}),
	});
	try {
		for (const fail of [false, true]) {
			const result = await dispatchToolCall(
				{
					catalog: new Map([['browser_list_sessions', echo(fail)]]),
					permitted: new Set(['browser_list_sessions']),
					scopes: new Set<Scope>(['mcp:invoke']),
					availability: { persistence: false, recording: false, egress: false },
					ctx,
					logger: { warn: () => {}, info: () => {} },
				},
				'browser_list_sessions',
				{},
			);
			const wire = JSON.stringify(result);
			assert(!wire.includes('hunter2-long'), `the value leaked (fail=${fail}): ${wire}`);
			assertStringIncludes(wire, '[secret]');
		}
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('errors: exactly one module produces the `Error: <code>: ` wire prefix', async () => {
	const producers: string[] = [];
	for await (const entry of Deno.readDir(new URL('.', import.meta.url))) {
		if (!entry.isFile || !entry.name.endsWith('.ts') || entry.name.endsWith('_test.ts')) continue;
		const source = await Deno.readTextFile(new URL(entry.name, import.meta.url));
		if (/(['"`])Error: \$\{|['"`]Error: [a-z-]+: /.test(source)) producers.push(entry.name);
	}
	assertEquals(producers, ['errors.ts'], `the Error: prefix is built outside errors.ts in ${producers.join(', ')}`);
});

/** The four client facts, read the way the SDK reads the capabilities. */
Deno.test('clientFactsOf reduces declared capabilities to the four facts', () => {
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

Deno.test('dispatchToolCall hands the client facts to the handler, and nothing when there are none', async () => {
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

// --- argument repair ---

/** The validator shape `repairArguments` takes, from a Zod schema. */
function parserOf(schema: z.ZodType) {
	return (value: unknown) => {
		const result = schema.safeParse(value);
		return result.success
			? { success: true as const, data: result.data }
			: { success: false as const, issues: result.error.issues as readonly ArgumentIssue[] };
	};
}

function issuesOf(schema: z.ZodType, value: unknown): readonly ArgumentIssue[] {
	const result = schema.safeParse(value);
	if (result.success) throw new Error('expected a failure');
	return result.error.issues as readonly ArgumentIssue[];
}

const CREATE = {
	version: 'v0.9',
	createSurface: { surfaceId: 's1', catalogId: 'https://tykotech.eu/a2ui/catalog/v0.9' },
};
const PUBLISH = z.object({ message: A2uiMessageSchema }).strict();

Deno.test('arguments: a number sent as text is read as the number it spells', () => {
	const schema = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict();
	const args = { limit: '5' };
	const repaired = repairArguments(args, issuesOf(schema, args), parserOf(schema));
	assertEquals(repaired, { ok: true, data: { limit: 5 } });
});

Deno.test('arguments: an object sent as JSON text is read as the object (a2ui_publish)', () => {
	const args = { message: JSON.stringify(CREATE) };
	const repaired = repairArguments(args, issuesOf(PUBLISH, args), parserOf(PUBLISH));
	assertEquals(repaired, { ok: true, data: { message: CREATE } });
});

Deno.test('arguments: a repaired value still has to pass the schema, and its own issue is reported', () => {
	const wrong = { ...CREATE, createSurface: { ...CREATE.createSurface, surfaceId: 'has spaces' } };
	const args = { message: JSON.stringify(wrong) };
	const repaired = repairArguments(args, issuesOf(PUBLISH, args), parserOf(PUBLISH));
	assertEquals(repaired.ok, false);
	if (!repaired.ok) {
		assertStringIncludes(describeIssues(repaired.issues), 'message.createSurface.surfaceId');
	}
});

Deno.test('arguments: a string refused for its content is never re-read as JSON', () => {
	const schema = z.object({ name: z.string().regex(/^[a-z]+$/) }).strict();
	const args = { name: '123' };
	const repaired = repairArguments(args, issuesOf(schema, args), parserOf(schema));
	assertEquals(repaired.ok, false);
	if (!repaired.ok) assertStringIncludes(describeIssues(repaired.issues), 'name: ');
});

Deno.test('arguments: text that is not JSON structure stays a refusal', () => {
	const schema = z.object({ limit: z.number() }).strict();
	for (const value of ['five', '"5"', 'null', '']) {
		const args = { limit: value };
		assertEquals(repairArguments(args, issuesOf(schema, args), parserOf(schema)).ok, false, value);
	}
});

Deno.test('arguments: a union failure names the field of the closest branch, not "Invalid input"', () => {
	const args = {
		message: {
			version: 'v0.9',
			createSurface: { surfaceId: 's1', catalogId: 'https://example.test/other-catalog' },
		},
	};
	const text = describeIssues(issuesOf(PUBLISH, args));
	assertStringIncludes(text, 'message.createSurface.catalogId');
	assertEquals(text.includes('Invalid input;'), false);
});

Deno.test('arguments: a value of the wrong type for every branch reads as one plain line', () => {
	const text = describeIssues(issuesOf(PUBLISH, { message: 42 }));
	assertStringIncludes(text, 'message: ');
	assertEquals(text.split(';').length, 1, text);
});

Deno.test('parseArguments: a tool normalization runs before the schema and again after a repair', () => {
	const tool = {
		inputSchema: z.object({ value: z.object({ version: z.literal('v1'), n: z.number() }).strict() }).strict(),
		normalizeArguments: (args: unknown) => {
			const value = (args as { value?: unknown }).value;
			return typeof value === 'object' && value !== null && !('version' in value)
				? { value: { version: 'v1', ...value } }
				: args;
		},
	};
	assertEquals(parseArguments(tool, { value: { n: 1 } }), { success: true, data: { value: { version: 'v1', n: 1 } } });
	assertEquals(parseArguments(tool, { value: '{"n":2}' }), {
		success: true,
		data: { value: { version: 'v1', n: 2 } },
	});
	const refused = parseArguments(tool, { value: '{"n":"x"}' });
	assertEquals(refused.success, false);
});

// --- Confirmations for the destructive set. ---

const FORM: ClientFacts = { sampling: false, samplingTools: false, elicitForm: true, elicitUrl: false };
const NONE: ClientFacts = { sampling: false, samplingTools: false, elicitForm: false, elicitUrl: false };
const WRITER: AuthInfo = {
	token: 't',
	clientId: 'writer',
	scopes: ['mcp:invoke', 'files:read', 'files:write'],
	extra: {},
};

/** The part of the SDK's per-call context the gate reads. */
function request(responses?: Record<string, unknown>): ServerContext {
	return {
		mcpReq: { method: 'tools/call', ...(responses === undefined ? {} : { inputResponses: responses }) },
	} as never;
}

function errorCode(result: unknown): string | undefined {
	return (result as { structuredContent?: { error?: { code?: string } } }).structuredContent?.error?.code;
}

// --- the gate --------------------------------------------------------------------------------------------------

Deno.test('confirm: one message per confirmed tool, and no tool without one', () => {
	assertEquals([...CONFIRM_MESSAGES.keys()].sort(), [...CONFIRM_TOOL_NAMES].sort());
	assertEquals(CONFIRM_KEY, 'ttk_confirm');
});

Deno.test('confirm: a message strips control characters and quotes at most 120 characters of an argument', () => {
	const message = CONFIRM_MESSAGES.get('file_delete')!;
	assertEquals(message({ path: 'a\nb\u001b[31mc\u0085d.txt' }), 'Delete ab[31mcd.txt from the file share?');
	const long = message({ path: 'x'.repeat(500) });
	assertStringIncludes(long, `${'x'.repeat(120)}…`);
	assert(!long.includes('x'.repeat(121)), 'more than 120 characters of the argument were shown');
	assertStringIncludes(message({ path: 'd', recursive: true }), 'and everything under it');
});

Deno.test('confirm: the gate passes everything that is not a form-capable call of a confirmed tool', async () => {
	assertEquals(await confirmGate('browser_close_tab', {}, request(), FORM), 'proceed', 'not in the set');
	assertEquals(await confirmGate('file_delete', { path: 'a' }, undefined, FORM), 'proceed', 'no MCP request');
	assertEquals(await confirmGate('file_delete', { path: 'a' }, request(), NONE), 'proceed', 'no form elicitation');
	assertEquals(await confirmGate('file_delete', { path: 'a' }, request(), undefined), 'proceed', 'no capabilities');
});

Deno.test('confirm: a first call is asked, with a single boolean confirm field', async () => {
	const asked = await confirmGate('file_delete', { path: 'notes/a.txt' }, request(), FORM);
	assert(asked !== 'proceed');
	assertEquals((asked as { resultType?: string }).resultType, 'input_required');
	assertEquals((asked as { requestState?: string }).requestState, undefined, 'a confirmation carries no state');
	const entry = (asked as { inputRequests: Record<string, { method: string; params: Record<string, unknown> }> })
		.inputRequests[CONFIRM_KEY]!;
	assertEquals(entry.method, 'elicitation/create');
	assertEquals(entry.params.message, 'Delete notes/a.txt from the file share?');
	assertEquals(entry.params.requestedSchema, {
		type: 'object',
		properties: { confirm: { type: 'boolean', title: 'Confirm' } },
		required: ['confirm'],
	});
});

Deno.test('confirm: only an accepted `confirm: true` proceeds; every other answer is user-declined', async () => {
	const answer = (value: unknown) => request({ [CONFIRM_KEY]: value });
	assertEquals(
		await confirmGate('file_delete', { path: 'a' }, answer({ action: 'accept', content: { confirm: true } }), FORM),
		'proceed',
	);
	for (
		const [value, words] of [
			[{ action: 'decline' }, 'was declined'],
			[{ action: 'cancel' }, 'was cancelled'],
			[{ action: 'accept', content: { confirm: false } }, 'was not given'],
			[{ action: 'accept', content: { confirm: 'true' } }, 'was not given'],
			[{ action: 'accept' }, 'was not given'],
		] as const
	) {
		const result = await confirmGate('file_delete', { path: 'a' }, answer(value), FORM);
		assertEquals(errorCode(result), 'user-declined', JSON.stringify(value));
		const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
		assertStringIncludes(text, 'Error: user-declined: ');
		assertStringIncludes(text, words);
	}
});

// --- through the HTTP entry --------------------------------------------------------------------------------------

interface Call {
	era: string;
	name: string;
	args: Record<string, unknown>;
	caps?: ClientCapabilities;
	responses?: Record<string, unknown>;
}

async function call(handler: ReturnType<typeof createMcpHandler>, c: Call): Promise<Record<string, unknown>> {
	const params: Record<string, unknown> = { name: c.name, arguments: c.args };
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (c.era === MODERN) {
		params._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: c.caps ?? {} };
		if (c.responses !== undefined) params.inputResponses = c.responses;
		headers['mcp-protocol-version'] = MODERN;
		headers['mcp-method'] = 'tools/call';
		headers['mcp-name'] = c.name;
	}
	const response = await handler.fetch(
		new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params }),
		}),
		{ authInfo: WRITER },
	);
	return await readRpc(response);
}

/** A server over a real library holding `a.txt`, with confirmations as given. */
async function share(confirmations: boolean | undefined) {
	const dir = join('tests/.scratch', `confirm-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const library = new LibraryStore({ dataDir: dir });
	await library.initialize();
	await library.writeBytes('a.txt', new TextEncoder().encode('keep me'));
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.reject(new Error('no browser in the unit tier')),
	});
	const deps: McpDeps = {
		registry,
		version: '0.0.0-test',
		library,
		...(confirmations === undefined ? {} : { confirmations }),
	};
	const handler = createMcpHandler(createBuildServer(deps), { legacy: 'stateless' });
	return {
		handler,
		exists: async () => {
			try {
				await library.stat('a.txt');
				return true;
			} catch {
				return false;
			}
		},
		async [Symbol.asyncDispose]() {
			await handler.close();
			await registry.shutdown();
			await Deno.remove(dir, { recursive: true });
		},
	};
}

const DELETE = { era: MODERN, name: 'file_delete', args: { path: 'a.txt' }, caps: { elicitation: {} } } as const;

Deno.test('confirm: a form-capable client deleting a file is asked first, and only a yes deletes it', async () => {
	await using s = await share(true);
	const asked = (await call(s.handler, DELETE)).result as Record<string, unknown>;
	assertEquals(asked.resultType, 'input_required');
	const form = (asked.inputRequests as Record<string, { params: { message: string } }>)[CONFIRM_KEY]!;
	assertEquals(form.params.message, 'Delete a.txt from the file share?');
	assert(await s.exists(), 'asking deleted the file');

	for (
		const answer of [
			{ action: 'decline' },
			{ action: 'cancel' },
			{ action: 'accept', content: { confirm: false } },
		]
	) {
		const refused = (await call(s.handler, { ...DELETE, responses: { [CONFIRM_KEY]: answer } })).result;
		assertEquals((refused as { isError?: boolean }).isError, true, JSON.stringify(answer));
		assertEquals(errorCode(refused), 'user-declined', JSON.stringify(answer));
		assert(await s.exists(), `the file did not survive ${JSON.stringify(answer)}`);
	}

	const done = (await call(s.handler, {
		...DELETE,
		responses: { [CONFIRM_KEY]: { action: 'accept', content: { confirm: true } } },
	})).result as { isError?: boolean; structuredContent: { result: { removed: boolean } } };
	assertEquals(done.isError, undefined, JSON.stringify(done));
	assertEquals(done.structuredContent.result.removed, true);
	assert(!(await s.exists()), 'an accepted confirmation did not delete the file');
});

Deno.test('confirm: a client without form elicitation gets byte-identical results with the gate on and off', async () => {
	for (
		const shape of [
			{ era: MODERN, caps: {} },
			{ era: MODERN, caps: { elicitation: { url: {} } } },
			{ era: MODERN, caps: { sampling: {} } },
			{ era: ERA_2025 },
		] as const
	) {
		await using on = await share(true);
		await using off = await share(undefined);
		const c: Call = {
			era: shape.era,
			name: 'file_delete',
			args: { path: 'a.txt' },
			...('caps' in shape ? { caps: shape.caps } : {}),
		};
		const withGate = JSON.stringify(await call(on.handler, c));
		const withoutGate = JSON.stringify(await call(off.handler, c));
		assertEquals(withGate, withoutGate, `${JSON.stringify(shape)}: the gate changed what this client sees`);
		assert(!(await on.exists()), `${JSON.stringify(shape)}: the call did not run`);
	}
});

Deno.test('confirm: TTK_CONFIRM_DESTRUCTIVE=false never asks, even a form-capable client', async () => {
	await using s = await share(false);
	const result = (await call(s.handler, DELETE)).result as Record<string, unknown>;
	assertEquals(result.resultType, 'complete', 'a disabled gate asked anyway');
	assert(!(await s.exists()));
});

Deno.test('confirm: browser_close_tab is not in the set and never asks', async () => {
	await using s = await share(true);
	const result = (await call(s.handler, {
		era: MODERN,
		name: 'browser_close_tab',
		args: { tab_id: 'AB12' },
		caps: { elicitation: {} },
	})).result as Record<string, unknown>;
	assertEquals(result.resultType, 'complete', 'browser_close_tab asked for a confirmation');
	assertEquals(result.isError, true, 'the unit tier has no browser, so the call itself fails');
});

// --- The navigation policy is a security control shared by the MCP tool and the live view's human-driven navigation, so it is tested once, directly. ---

Deno.test('policy: an empty allowlist permits any http(s) URL', () => {
	assertEquals(assertNavigable('https://anything.test/x', []).hostname, 'anything.test');
	assertEquals(assertNavigable('http://plain.test/', []).protocol, 'http:');
});

Deno.test('policy: non-http(s) schemes are always refused', () => {
	for (const url of ['data:text/html,x', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://h/']) {
		const error = assertThrows(() => assertNavigable(url, []), ToolError);
		assertEquals((error as ToolError).code, 'navigation-blocked', url);
	}
});

Deno.test('policy: a malformed URL is an argument error', () => {
	const error = assertThrows(() => assertNavigable('not a url', []), ToolError);
	assertEquals((error as ToolError).code, 'invalid-arguments');
});

Deno.test('policy: an allowlist matches the host and its subdomains only', () => {
	const allow = ['example.com'];
	for (const ok of ['https://example.com/', 'https://a.example.com/', 'https://a.b.example.com/']) {
		assertEquals(assertNavigable(ok, allow).protocol, 'https:');
	}
	for (const bad of ['https://notexample.com/', 'https://evil-example.com/', 'https://example.com.evil.net/']) {
		const error = assertThrows(() => assertNavigable(bad, allow), ToolError);
		assertEquals((error as ToolError).code, 'navigation-blocked', bad);
	}
});

Deno.test('policy: a leading dot in an allowlist entry is tolerated', () => {
	assertEquals(assertNavigable('https://a.example.com/', ['.example.com']).hostname, 'a.example.com');
});

Deno.test('policy: matching is case-insensitive on both sides', () => {
	assertEquals(assertNavigable('https://API.Example.COM/', ['example.com']).protocol, 'https:');
	assertEquals(assertNavigable('https://api.example.com/', ['EXAMPLE.COM']).protocol, 'https:');
});

/**
 * Normalisation, asserted against what the browser does rather than what a string comparison does: a trailing dot,
 * upper case and an IDN spelling are all the same host to Chromium, so they must all be the same host here — on both
 * sides of the comparison, because the allowlist is operator-typed text.
 */
Deno.test('policy: trailing-dot, upper-case and IDN spellings match as the browser matches them', () => {
	const allow = ['Example.COM.', 'bücher.example'];
	for (const ok of ['https://example.com./', 'https://EXAMPLE.com/', 'https://a.example.com./x']) {
		assertEquals(assertNavigable(ok, allow).protocol, 'https:', ok);
	}
	assertEquals(assertNavigable('https://bücher.example/', allow).hostname, 'xn--bcher-kva.example');
	assertEquals(assertNavigable('https://xn--bcher-kva.example/', allow).hostname, 'xn--bcher-kva.example');
	const error = assertThrows(() => assertNavigable('https://example.com.evil.net./', allow), ToolError);
	assertEquals((error as ToolError).code, 'navigation-blocked');
});

Deno.test('policy: canonicalHost and isHostAllowed are the one rule the ledger reuses', () => {
	assertEquals(canonicalHost(' .Example.COM.. '), 'example.com');
	assertEquals(canonicalHost('bücher.example'), 'xn--bcher-kva.example');
	assertEquals(canonicalHost(''), null);
	assertEquals(canonicalHost('not a host'), null);
	assertEquals(isHostAllowed('anything.test', []), true);
	assertEquals(isHostAllowed('a.example.com.', ['example.com']), true);
	assertEquals(isHostAllowed('evil-example.com', ['example.com']), false);
	assertEquals(isHostAllowed('example.com', ['not a host']), false, 'an unparseable entry permits nothing');
	assertEquals(originOf('https://h.example:8443/p?q=SECRET#f'), 'https://h.example:8443');
});
