/** Handler-reported progress through the one heartbeat, and cancellation that stops each listed tool family early. */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { delay } from '@std/async/delay';
import {
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	McpServer,
	PROTOCOL_VERSION_META_KEY,
	type ServerContext,
} from '@modelcontextprotocol/server';
import { blankSession, captureHarness } from '../fixtures/capture_session.ts';
import { ToolError } from './errors.ts';
import { CATALOG, type ToolDefinition } from './catalog.ts';
import { type DispatchContext, dispatchToolCall, installToolDispatch, startHeartbeat } from './dispatch.ts';
import { extensionTools } from './extension_tools.ts';
import type { LibraryStore } from './library.ts';
import { libraryTools } from './library_tools.ts';
import { DEFAULT_SESSION_ID, type LaunchedSession, SessionRegistry } from './registry.ts';
import { type Scope, SCOPES } from './scopes.ts';
import * as tools from './tools.ts';
import type { ToolContext, ToolResult } from './types.ts';
import * as z from 'zod';

interface Sent {
	method: string;
	params: { progressToken: unknown; progress: number; total?: number; message: string };
}

/** The part of the SDK's per-request context these paths read. */
function request(
	signal: AbortSignal,
	sent: Sent[],
	options: { token?: string; responses?: Record<string, unknown> } = {},
): ServerContext {
	return {
		mcpReq: {
			id: 1,
			method: 'tools/call',
			_meta: { progressToken: options.token ?? 'p' },
			signal,
			...(options.responses === undefined ? {} : { inputResponses: options.responses }),
			notify: (notification: Sent) => {
				sent.push(notification);
				return Promise.resolve();
			},
		},
	} as unknown as ServerContext;
}

function dispatchFor(ctx: ToolContext, tools: readonly ToolDefinition[], intervalMs: number): DispatchContext {
	const scopes = new Set(SCOPES);
	return {
		catalog: new Map(tools.map((tool) => [tool.name, tool])),
		permitted: new Set(tools.map((tool) => tool.name)),
		scopes,
		availability: { persistence: true, recording: false, egress: true, headRouting: null },
		ctx: { ...ctx, scopes },
		progressIntervalMs: intervalMs,
	};
}

/** Asserts a call settles within `ms`, which is how "stopped early" is told from "ran to its own bound". */
async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not stop within ${ms} ms of the cancellation`)), ms);
	});
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
	}
}

function isError(result: ToolResult): boolean {
	return (result as { isError?: boolean }).isError === true;
}

// --- the heartbeat ------------------------------------------------------------------------------------------------

Deno.test('progress: the heartbeat carries reported progress and total, never repeats a value and never falls', async () => {
	const sent: Sent[] = [];
	const heartbeat = startHeartbeat(request(new AbortController().signal, sent), 'x', 10)!;
	try {
		heartbeat.report({ progress: 0, total: 4, message: 'step 0/4' });
		assertEquals(sent.length, 0, 'a report is not a notification: the heartbeat is the only producer');
		await delay(45);
		assertEquals(sent.map((n) => [n.params.progress, n.params.total, n.params.message]), [[0, 4, 'step 0/4']]);
		heartbeat.report({ progress: 2, message: 'step 2/4' });
		await delay(25);
		heartbeat.report({ progress: 1, message: 'went backwards' });
		await delay(25);
		assertEquals(sent.map((n) => [n.params.progress, n.params.total, n.params.message]), [
			[0, 4, 'step 0/4'],
			[2, 4, 'step 2/4'],
		]);
	} finally {
		heartbeat.stop();
	}
	const timed: Sent[] = [];
	const bounded = startHeartbeat(request(new AbortController().signal, timed), 'y', 10)!;
	bounded.report({ total: 0.03, message: 'waiting' });
	await delay(200);
	bounded.stop();
	const values = timed.map((n) => n.params.progress);
	assert(values.length >= 2, `expected a rising series, got ${values}`);
	for (let i = 1; i < values.length; i += 1) assert(values[i]! > values[i - 1]!, `not rising: ${values}`);
	assertEquals(values.at(-1), 0.03);
	assert(timed.every((n) => n.params.total === 0.03 && n.params.message === 'waiting'));
});

Deno.test('progress: browser_run_task reports steps against max_steps, monotonic, through the heartbeat alone', async () => {
	const h = await captureHarness('baseline_button');
	const session = h.record.session as unknown as { getBrowserStateSummary: (o: unknown) => Promise<unknown> };
	const read = session.getBrowserStateSummary.bind(session);
	session.getBrowserStateSummary = async (options) => {
		await delay(40);
		return await read(options);
	};
	const runTask = CATALOG.find((tool) => tool.name === 'browser_run_task')!;
	const dispatch = dispatchFor(h.ctx, [runTask], 3);
	const answer = (text: string) => ({ step: { role: 'assistant', model: 'stub', content: { type: 'text', text } } });
	const rounds: Sent[][] = [];
	const round = async (args: Record<string, unknown>, responses?: Record<string, unknown>): Promise<ToolResult> => {
		const sent: Sent[] = [];
		rounds.push(sent);
		const signal = new AbortController().signal;
		return await dispatchToolCall(dispatch, 'browser_run_task', args, request(signal, sent, { responses }), true);
	};
	try {
		const first = await round({ task: 'find the button', max_steps: 3 });
		assertEquals((first as { resultType?: string }).resultType, 'input_required');
		await round({ task: 'find the button', max_steps: 3 }, answer('{"action":"switch_tab","tab_id":"ZZZZ"}'));
		const done = await round({ task: 'find the button', max_steps: 3 }, answer('{"action":"done","answer":"ok"}'));
		assertEquals((done as { structuredContent: { status: string; steps: number } }).structuredContent.status, 'done');

		const all = rounds.flat();
		assert(all.length >= 2, `the heartbeat reported nothing: ${JSON.stringify(rounds)}`);
		assert(all.every((n) => n.method === 'notifications/progress' && n.params.total === 3), 'total is max_steps');
		assert(all.every((n) => n.params.message.startsWith('step ')), 'the handler names the step');
		for (const sent of rounds) {
			for (let i = 1; i < sent.length; i += 1) assert(sent[i]!.params.progress > sent[i - 1]!.params.progress);
		}
		assertEquals(rounds[0]!.at(-1)?.params.progress, 0);
		assertEquals(rounds[1]!.at(-1)?.params.progress, 1);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('progress: sandbox_exec, browser_wait_for and browser_download report elapsed time against their bounds', async () => {
	const exec = extensionTools({ sandbox_exec: () => delay(60).then(() => ({})) });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	const sent: Sent[] = [];
	await dispatchToolCall(
		dispatchFor(ctx, exec, 10),
		'sandbox_exec',
		{ workspace_id: '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f', command: 'make', timeout_ms: 2000 },
		request(new AbortController().signal, sent),
	);
	assert(sent.length > 0);
	assert(sent.every((n) => n.params.total === 2 && n.params.message === 'sandbox_exec running in the cage'));
	await registry.shutdown();

	const h = await captureHarness('baseline_button');
	try {
		const waitFor = CATALOG.find((tool) => tool.name === 'browser_wait_for')!;
		const waited: Sent[] = [];
		const result = await dispatchToolCall(
			dispatchFor(h.ctx, [waitFor], 20),
			'browser_wait_for',
			{ until: { navigation: true }, timeout_ms: 200 },
			request(new AbortController().signal, waited),
		);
		assertEquals((result as { structuredContent: { met: boolean } }).structuredContent.met, false);
		assert(waited.length >= 2, `expected ticks, got ${JSON.stringify(waited)}`);
		assert(waited.every((n) => n.params.total === 0.2 && n.params.message === 'waiting for navigation'));
		assert(waited.every((n) => n.params.progress <= 0.2));
	} finally {
		await h.registry.shutdown();
	}
});

// --- cancellation, one family at a time -------------------------------------------------------------------------

/** A capture session whose page read never finishes, as a stuck renderer's would not. */
async function stuckHarness() {
	const h = await captureHarness('baseline_button');
	const session = h.record.session as unknown as { getBrowserStateSummary: () => Promise<unknown> };
	session.getBrowserStateSummary = () => new Promise(() => {});
	return h;
}

Deno.test('cancellation: browser_get_state and browser_find stop waiting for the DOM build when cancelled', async () => {
	for (
		const [name, call] of [
			['browser_get_state', (ctx: ToolContext) => tools.browserGetState({}, ctx)],
			['browser_find', (ctx: ToolContext) => tools.browserFind({ query: { role: 'button' } }, ctx)],
		] as const
	) {
		const h = await stuckHarness();
		const cancel = new AbortController();
		try {
			const pending = call({ ...h.ctx, signal: cancel.signal });
			setTimeout(() => cancel.abort(), 20);
			await within(1_000, assertRejects(() => pending), name);
		} finally {
			await h.registry.shutdown();
		}
	}
});

Deno.test('cancellation: a full-page browser_screenshot stops waiting for the capture when cancelled', async () => {
	const h = await captureHarness('baseline_button');
	const bus = h.record.session.eventBus as unknown as { dispatch: unknown };
	bus.dispatch = () => ({ eventResult: () => new Promise(() => {}) });
	const cancel = new AbortController();
	try {
		const pending = tools.browserScreenshot({ full_page: true }, { ...h.ctx, signal: cancel.signal });
		setTimeout(() => cancel.abort(), 20);
		await within(1_000, assertRejects(() => pending), 'browser_screenshot');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('cancellation: browser_run_task takes no action after a cancellation, between steps and around sampling', async () => {
	const h = await captureHarness('baseline_button');
	const runTask = CATALOG.find((tool) => tool.name === 'browser_run_task')!;
	const dispatch = dispatchFor(h.ctx, [runTask], 1_000);
	const answer = (text: string) => ({ step: { role: 'assistant', model: 'stub', content: { type: 'text', text } } });
	try {
		const started = await dispatchToolCall(
			dispatch,
			'browser_run_task',
			{ task: 'press it', max_steps: 4 },
			request(new AbortController().signal, []),
			true,
		);
		assertEquals((started as { resultType?: string }).resultType, 'input_required');
		const run = h.record.run!;
		const before = { steps: run.steps, history: [...run.history] };
		const cancelled = new AbortController();
		cancelled.abort();
		const refused = await dispatchToolCall(
			dispatch,
			'browser_run_task',
			{ task: 'press it' },
			request(cancelled.signal, [], { responses: answer('{"action":"navigate","url":"https://example.com/"}') }),
			true,
		);
		assert(isError(refused));
		assertEquals({ steps: run.steps, history: run.history }, before, 'no step was taken or counted');
		assertEquals(h.record.run, run, 'the run stays parked for resume');

		const session = h.record.session as unknown as { getBrowserStateSummary: (o: unknown) => Promise<unknown> };
		const read = session.getBrowserStateSummary.bind(session);
		const slowRead = new AbortController();
		session.getBrowserStateSummary = async (options) => {
			await delay(200, { signal: slowRead.signal }).catch(() => {});
			return await read(options);
		};
		const mid = new AbortController();
		const pending = dispatchToolCall(
			dispatch,
			'browser_run_task',
			{ resume: true, max_steps: 2 },
			request(mid.signal, []),
			true,
		);
		setTimeout(() => mid.abort(), 20);
		const result = await within(150, pending, 'browser_run_task');
		assert(isError(result), 'a cancelled round returns no input_required');
		slowRead.abort();
		await delay(10);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('cancellation: browser_download stops waiting for the announcement when cancelled', async () => {
	const session = blankSession();
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () =>
			Promise.resolve({
				session,
				downloads: {
					downloads: [],
					isRemoteBrowser: false,
					lookup: () => undefined,
				} as unknown as LaunchedSession['downloads'],
				downloadsDir: null,
				popups: null,
			}),
	});
	await registry.resolve(DEFAULT_SESSION_ID);
	const download = CATALOG.find((tool) => tool.name === 'browser_download')!;
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	const cancel = new AbortController();
	const sent: Sent[] = [];
	try {
		const pending = dispatchToolCall(
			dispatchFor(ctx, [download], 20),
			'browser_download',
			{ url: 'https://files.test/x.bin' },
			request(cancel.signal, sent),
		);
		setTimeout(() => cancel.abort(), 120);
		assert(isError(await within(1_000, pending, 'browser_download')), 'well inside the 5 s detection window');
		assert(sent.length > 0 && sent.every((n) => n.params.total === 5), JSON.stringify(sent));
	} finally {
		await registry.shutdown();
	}
});

Deno.test('cancellation: browser_head ends its request when cancelled (the fetch carries the call signal)', async () => {
	const slow = new AbortController();
	const listener = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		async () => {
			await delay(400, { signal: slow.signal }).catch(() => {});
			return new Response(null, { status: 204 });
		},
	);
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const cancel = new AbortController();
	try {
		const url = `http://127.0.0.1:${listener.addr.port}/slow`;
		const allowedDomains = ['127.0.0.1', `127.0.0.1:${listener.addr.port}`];
		const ctx: ToolContext = { registry, allowedDomains, principal: 'test', signal: cancel.signal };
		const started = performance.now();
		const pending = tools.browserHead({ url }, ctx);
		setTimeout(() => cancel.abort(), 30);
		const error = await assertRejects(() => pending, ToolError);
		assertEquals(error.code, 'timeout');
		assert(performance.now() - started < 300, 'the request ended with the call, not with the server');
	} finally {
		await registry.shutdown();
		slow.abort();
		await listener.shutdown();
	}
});

Deno.test('cancellation: library reads stop at a cancellation; writes are refused before they start, never abandoned', async () => {
	let writes = 0;
	const store = {
		readBytes: () => new Promise(() => {}),
		writeBytes: async () => {
			writes += 1;
			await delay(60);
			return { name: 'a.txt', path: 'a.txt', kind: 'file', size: 1, modified_at: null };
		},
	} as unknown as LibraryStore;
	const byName = new Map(libraryTools(store).map((tool) => [tool.name, tool]));
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const base: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	try {
		const cancel = new AbortController();
		const reading = byName.get('file_read')!.handler({ path: 'a.txt' } as never, { ...base, signal: cancel.signal });
		setTimeout(() => cancel.abort(), 20);
		await within(1_000, assertRejects(() => reading), 'file_read');

		const late = new AbortController();
		const writing = byName.get('file_write')!.handler(
			{ path: 'a.txt', content: 'x' } as never,
			{ ...base, signal: late.signal },
		);
		setTimeout(() => late.abort(), 10);
		assertEquals(isError(await writing), false);
		await assertRejects(() =>
			byName.get('file_write')!.handler({ path: 'b.txt', content: 'x' } as never, {
				...base,
				signal: AbortSignal.abort(),
			})
		);
		assertEquals(writes, 1);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('cancellation: agent_* and sandbox_* calls stop waiting on their service when cancelled', async () => {
	const seen: AbortSignal[] = [];
	const extension = extensionTools({
		agent_get_task: () => new Promise(() => {}),
		agent_delegate: () => new Promise(() => {}),
		sandbox_session_read: (_args, ctx) => {
			if (ctx.signal !== undefined) seen.push(ctx.signal);
			return new Promise(() => {});
		},
	});
	const byName = new Map(extension.map((tool) => [tool.name, tool]));
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const base: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	try {
		for (
			const [name, args] of [
				['agent_get_task', { task_id: '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f' }],
				['agent_delegate', { peer: 'reviewer', message: 'look' }],
				['sandbox_session_read', { session_id: '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f', wait_ms: 10_000 }],
			] as const
		) {
			const cancel = new AbortController();
			const pending = byName.get(name)!.handler(args as never, { ...base, signal: cancel.signal });
			setTimeout(() => cancel.abort(), 20);
			await within(1_000, assertRejects(() => pending), name);
		}
		assertEquals(seen.length, 1);
		assertEquals(seen[0]!.aborted, true);
	} finally {
		await registry.shutdown();
	}
});

// --- A caller's cancellation reaches the running tool, and a caller that asked for progress hears from a call that runs long. Driven through `dispatchToolCall` with the request context the SDK hands a handler. ---

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
function cancelRequest(
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

Deno.test('notifications/cancelled aborts the running tool through the request signal', async () => {
	const seen: { signal?: AbortSignal } = {};
	const cancel = new AbortController();
	const started = performance.now();
	const pending = dispatchToolCall(
		context(waiter(seen)),
		'test_wait',
		{ ms: 30_000 },
		cancelRequest(cancel.signal, undefined, []),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert(seen.signal !== undefined, 'the tool was given a signal');
	cancel.abort();
	const result = await pending as { structuredContent: { ended: string } };
	assertEquals(result.structuredContent.ended, 'cancelled');
	assert(performance.now() - started < 5_000, 'the tool stopped at once, not after its 30 s');
});

Deno.test('a bridge signal and the request signal both end the call', async () => {
	const bridge = new AbortController();
	const pending = dispatchToolCall(
		context(waiter({}), bridge.signal),
		'test_wait',
		{ ms: 30_000 },
		cancelRequest(new AbortController().signal, undefined, []),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	bridge.abort();
	assertEquals((await pending as { structuredContent: { ended: string } }).structuredContent.ended, 'cancelled');
});

Deno.test('progress is sent only to a caller that asked, rising, and stops with the call', async () => {
	const sent: Array<{ method: string; params: { progressToken: unknown; progress: number; message: string } }> = [];
	const asked = cancelRequest(new AbortController().signal, { progressToken: 'p-1' }, sent as unknown[]);
	const heartbeat = startHeartbeat(asked, 'test_wait', 30)!;
	await new Promise((resolve) => setTimeout(resolve, 250));
	heartbeat.stop();
	const count = sent.length;
	await new Promise((resolve) => setTimeout(resolve, 70));
	assertEquals(sent.length, count, 'nothing after stop');
	assert(count >= 2, `expected at least two updates, got ${count}`);
	assert(sent.every((n) => n.method === 'notifications/progress' && n.params.progressToken === 'p-1'));
	for (let i = 1; i < sent.length; i += 1) assert(sent[i]!.params.progress > sent[i - 1]!.params.progress);
	assertEquals(sent[0]!.params.message, 'test_wait running');

	assertEquals(startHeartbeat(cancelRequest(new AbortController().signal, undefined, []), 'x', 30), null);
	const quick: unknown[] = [];
	await dispatchToolCall(
		context(waiter({})),
		'test_wait',
		{ ms: 10 },
		cancelRequest(new AbortController().signal, {
			progressToken: 7,
		}, quick),
	);
	assertEquals(quick, []);
});

Deno.test('a long call through the dispatcher reports progress to a caller with a token', async () => {
	const sent: unknown[] = [];
	await dispatchToolCall(
		context(waiter({})),
		'test_wait',
		{ ms: 1_300 },
		cancelRequest(new AbortController().signal, {
			progressToken: 'long',
		}, sent),
	);
	assertEquals(sent.length, 1);
	assertEquals((sent[0] as { params: { progress: number } }).params.progress, 1);
});

for (const era of ['2025-06-18', '2026-07-28']) {
	Deno.test(`cancellation (${era}): a client that drops the HTTP request cancels the tool behind the seam`, async () => {
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
			headers['mcp-protocol-version'] = era;
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
