/**
 * D-079: a caller's cancellation reaches the running tool, and a caller that asked for progress hears from a
 * call that runs long. Driven through `dispatchToolCall` with the request context the SDK hands a handler.
 */
import { assert, assertEquals } from '@std/assert';
import {
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	McpServer,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { ToolDefinition } from './catalog.ts';
import { type DispatchContext, dispatchToolCall, installToolDispatch, startHeartbeat } from './dispatch.ts';
import { SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';
import type { ToolContext } from './types.ts';

/** A tool that runs until its call is cancelled, or `ms` passes, and says which. */
function waiter(seen: { signal?: AbortSignal }): ToolDefinition {
	return {
		name: 'test_wait',
		title: 'Wait',
		description: 'waits',
		inputSchema: z.object({ ms: z.number() }),
		outputSchema: z.object({ ended: z.string() }),
		mutates: false,
		handler: async (args: unknown, ctx: ToolContext) => {
			seen.signal = ctx.signal;
			const { ms } = args as { ms: number };
			const ended = await new Promise<string>((resolve) => {
				const timer = setTimeout(() => resolve('finished'), ms);
				ctx.signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					resolve('cancelled');
				}, { once: true });
			});
			return { content: [{ type: 'text', text: ended }], structuredContent: { ended } };
		},
	} as unknown as ToolDefinition;
}

function context(tool: ToolDefinition, signal?: AbortSignal): DispatchContext {
	const scopes = new Set<Scope>(['mcp:invoke']);
	return {
		catalog: new Map([[tool.name, tool]]),
		permitted: new Set([tool.name]),
		scopes,
		availability: { persistence: false, recording: false, egress: false, headRouting: null },
		ctx: {
			registry: new SessionRegistry({ reapIntervalMs: 0 }),
			allowedDomains: [],
			principal: 'test',
			scopes,
			...(signal === undefined ? {} : { signal }),
		},
	};
}

/** The part of the SDK's per-request context these paths read. */
function request(
	signal: AbortSignal,
	meta: Record<string, unknown> | undefined,
	sent: unknown[],
): ServerContext {
	return {
		mcpReq: {
			id: 1,
			method: 'tools/call',
			...(meta === undefined ? {} : { _meta: meta }),
			signal,
			notify: (notification: unknown) => {
				sent.push(notification);
				return Promise.resolve();
			},
		},
	} as unknown as ServerContext;
}

Deno.test('D-079: notifications/cancelled aborts the running tool through the request signal', async () => {
	const seen: { signal?: AbortSignal } = {};
	const cancel = new AbortController();
	const started = performance.now();
	const pending = dispatchToolCall(
		context(waiter(seen)),
		'test_wait',
		{ ms: 30_000 },
		request(cancel.signal, undefined, []),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert(seen.signal !== undefined, 'the tool was given a signal');
	cancel.abort();
	const result = await pending as { structuredContent: { ended: string } };
	assertEquals(result.structuredContent.ended, 'cancelled');
	assert(performance.now() - started < 5_000, 'the tool stopped at once, not after its 30 s');
});

Deno.test('D-079: a bridge signal and the request signal both end the call', async () => {
	const bridge = new AbortController();
	const pending = dispatchToolCall(
		context(waiter({}), bridge.signal),
		'test_wait',
		{ ms: 30_000 },
		request(new AbortController().signal, undefined, []),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	bridge.abort();
	assertEquals((await pending as { structuredContent: { ended: string } }).structuredContent.ended, 'cancelled');
});

Deno.test('D-079: progress is sent only to a caller that asked, rising, and stops with the call', async () => {
	const sent: Array<{ method: string; params: { progressToken: unknown; progress: number; message: string } }> = [];
	const asked = request(new AbortController().signal, { progressToken: 'p-1' }, sent as unknown[]);
	const heartbeat = startHeartbeat(asked, 'test_wait', 30)!;
	await new Promise((resolve) => setTimeout(resolve, 110));
	heartbeat.stop();
	const count = sent.length;
	await new Promise((resolve) => setTimeout(resolve, 70));
	assertEquals(sent.length, count, 'nothing after stop');
	assert(count >= 2, `expected at least two updates, got ${count}`);
	assert(sent.every((n) => n.method === 'notifications/progress' && n.params.progressToken === 'p-1'));
	for (let i = 1; i < sent.length; i += 1) assert(sent[i]!.params.progress > sent[i - 1]!.params.progress);
	assertEquals(sent[0]!.params.message, 'test_wait running');

	// No token, no heartbeat; and a quick call through the dispatcher sends nothing even with one.
	assertEquals(startHeartbeat(request(new AbortController().signal, undefined, []), 'x', 30), null);
	const quick: unknown[] = [];
	await dispatchToolCall(
		context(waiter({})),
		'test_wait',
		{ ms: 10 },
		request(new AbortController().signal, {
			progressToken: 7,
		}, quick),
	);
	assertEquals(quick, []);
});

Deno.test('D-079: a long call through the dispatcher reports progress to a caller with a token', async () => {
	const sent: unknown[] = [];
	await dispatchToolCall(
		context(waiter({})),
		'test_wait',
		{ ms: 1_300 },
		request(new AbortController().signal, {
			progressToken: 'long',
		}, sent),
	);
	assertEquals(sent.length, 1);
	assertEquals((sent[0] as { params: { progress: number } }).params.progress, 1);
});

for (const era of ['2025-06-18', '2026-07-28']) {
	Deno.test(`D-079 (${era}): a client that drops the HTTP request cancels the tool behind the seam`, async () => {
		const seen: { signal?: AbortSignal } = {};
		const tool = waiter(seen);
		const server = new McpServer({ name: 'cancel-probe', version: '0.0.0' });
		server.registerTool(tool.name, { description: tool.description, inputSchema: z.object({}) }, () => ({
			content: [],
		}));
		installToolDispatch(server, context(tool));
		const handler = createMcpHandler(() => server, { legacy: 'stateless' });
		const params: Record<string, unknown> = { name: tool.name, arguments: { ms: 30_000 } };
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
		};
		if (era === '2026-07-28') {
			params._meta = { [PROTOCOL_VERSION_META_KEY]: era, [CLIENT_CAPABILITIES_META_KEY]: {} };
			headers['mcp-method'] = 'tools/call';
			headers['mcp-name'] = tool.name;
		}
		const client = new AbortController();
		const pending = handler.fetch(
			new Request('http://127.0.0.1/mcp', {
				method: 'POST',
				signal: client.signal,
				headers,
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
			}),
		).then((response) => response.text()).catch(() => '');
		for (let i = 0; i < 50 && seen.signal === undefined; i += 1) await new Promise((r) => setTimeout(r, 10));
		assert(seen.signal !== undefined, 'the tool started');
		client.abort();
		for (let i = 0; i < 100 && !seen.signal.aborted; i += 1) await new Promise((r) => setTimeout(r, 10));
		assert(seen.signal.aborted, 'the tool saw the cancellation');
		await pending;
		await handler.close();
	});
}
