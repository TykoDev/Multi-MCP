/**
 * R5 (D-125, AC20): confirmations for the destructive set.
 *
 * The gate on its own first — which answer does what — and then through the real HTTP entry on both eras, against a
 * real library on disk, because the claim is about what a *client* sees: a form-capable client is asked and the file
 * survives every answer but an explicit yes; every other client gets exactly the bytes it got before the gate existed.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import {
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { AuthInfo, ClientCapabilities, ServerContext } from '@modelcontextprotocol/server';
import { CONFIRM_KEY, CONFIRM_MESSAGES, CONFIRM_TOOL_NAMES, confirmGate } from './confirm.ts';
import { LibraryStore } from './library.ts';
import { SessionRegistry } from './registry.ts';
import { createBuildServer, type McpDeps } from './server.ts';
import type { ClientFacts } from './types.ts';

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
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

Deno.test('R5: one message per confirmed tool, and the set is the S0 set', () => {
	assertEquals([...CONFIRM_MESSAGES.keys()].sort(), [...CONFIRM_TOOL_NAMES].sort());
	assertEquals(CONFIRM_KEY, 'ttk_confirm');
});

Deno.test('R5: a message strips control characters and quotes at most 120 characters of an argument', () => {
	const message = CONFIRM_MESSAGES.get('file_delete')!;
	assertEquals(message({ path: 'a\nb\u001b[31mc\u0085d.txt' }), 'Delete ab[31mcd.txt from the file share?');
	const long = message({ path: 'x'.repeat(500) });
	assertStringIncludes(long, `${'x'.repeat(120)}…`);
	assert(!long.includes('x'.repeat(121)), 'more than 120 characters of the argument were shown');
	assertStringIncludes(message({ path: 'd', recursive: true }), 'and everything under it');
});

Deno.test('R5: the gate passes everything that is not a form-capable call of a confirmed tool', async () => {
	assertEquals(await confirmGate('browser_close_tab', {}, request(), FORM), 'proceed', 'not in the set');
	assertEquals(await confirmGate('file_delete', { path: 'a' }, undefined, FORM), 'proceed', 'no MCP request');
	assertEquals(await confirmGate('file_delete', { path: 'a' }, request(), NONE), 'proceed', 'no form elicitation');
	assertEquals(await confirmGate('file_delete', { path: 'a' }, request(), undefined), 'proceed', 'no capabilities');
});

Deno.test('R5: a first call is asked, with the boolean form the design fixes', async () => {
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

Deno.test('R5: only an accepted `confirm: true` proceeds; every other answer is user-declined', async () => {
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

async function readRpc(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		for (const line of text.split('\n')) if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
		throw new Error(`no data frame in SSE body: ${text}`);
	}
	return JSON.parse(text);
}

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

Deno.test('AC20: a form-capable client deleting a file is asked first, and only a yes deletes it', async () => {
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

Deno.test('AC20: a client without form elicitation gets byte-identical results with the gate on and off', async () => {
	for (
		const shape of [
			{ era: MODERN, caps: {} },
			{ era: MODERN, caps: { elicitation: { url: {} } } },
			{ era: MODERN, caps: { sampling: {} } },
			// The 2025 stateless path declares no capabilities at all.
			{ era: LEGACY },
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

Deno.test('AC20: TTK_CONFIRM_DESTRUCTIVE=false never asks, even a form-capable client', async () => {
	await using s = await share(false);
	const result = (await call(s.handler, DELETE)).result as Record<string, unknown>;
	assertEquals(result.resultType, 'complete', 'a disabled gate asked anyway');
	assert(!(await s.exists()));
});

Deno.test('AC20: browser_close_tab is not in the set and never asks', async () => {
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
