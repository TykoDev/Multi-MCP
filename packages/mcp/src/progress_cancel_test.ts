/**
 * A9 (AC16) and A10 (AC17): handler-reported progress through the one heartbeat, and cancellation that stops each
 * listed tool family early. Driven through `dispatchToolCall` with the request context the SDK hands a handler,
 * against the capture fixtures (no Chromium) and, for `browser_head`, a loopback listener.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { delay } from '@std/async/delay';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import type { ServerContext } from '@modelcontextprotocol/server';
import { captureHarness } from '../fixtures/capture_session.ts';
import { ToolError } from './errors.ts';
import { CATALOG, type ToolDefinition } from './catalog.ts';
import { type DispatchContext, dispatchToolCall, startHeartbeat } from './dispatch.ts';
import { extensionTools } from './extension_tools.ts';
import type { LibraryStore } from './library.ts';
import { libraryTools } from './library_tools.ts';
import { DEFAULT_SESSION_ID, type LaunchedSession, SessionRegistry } from './registry.ts';
import { SCOPES } from './scopes.ts';
import * as tools from './tools.ts';
import type { ToolContext, ToolResult } from './types.ts';

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

// --- A9: the heartbeat ------------------------------------------------------------------------------------------

Deno.test('A9: the heartbeat carries reported progress and total, never repeats a value and never falls', async () => {
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
	// A report naming only a total is elapsed time against it, capped there.
	const timed: Sent[] = [];
	const bounded = startHeartbeat(request(new AbortController().signal, timed), 'y', 10)!;
	bounded.report({ total: 0.03, message: 'waiting' });
	await delay(80);
	bounded.stop();
	const values = timed.map((n) => n.params.progress);
	assert(values.length >= 2, `expected a rising series, got ${values}`);
	for (let i = 1; i < values.length; i += 1) assert(values[i]! > values[i - 1]!, `not rising: ${values}`);
	assertEquals(values.at(-1), 0.03);
	assert(timed.every((n) => n.params.total === 0.03 && n.params.message === 'waiting'));
});

Deno.test('AC16: browser_run_task reports steps against max_steps, monotonic, through the heartbeat alone', async () => {
	const h = await captureHarness('baseline_button');
	// Each page read takes a moment, as a real one does, so the heartbeat ticks inside every round.
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
		// A failing action is a step like any other: it is taken, recorded, and counted.
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
		// Round one is step 0 of 3; round two ends having taken step 1.
		assertEquals(rounds[0]!.at(-1)?.params.progress, 0);
		assertEquals(rounds[1]!.at(-1)?.params.progress, 1);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('A9: sandbox_exec, browser_wait_for and browser_download report elapsed time against their bounds', async () => {
	// sandbox_exec: the timeout the call named (or the service default) is the total.
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

	// browser_wait_for: elapsed against timeout_ms, named by its condition, never past the bound.
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

// --- A10: cancellation, one family at a time --------------------------------------------------------------------

/** A capture session whose page read never finishes, as a stuck renderer's would not. */
async function stuckHarness() {
	const h = await captureHarness('baseline_button');
	const session = h.record.session as unknown as { getBrowserStateSummary: () => Promise<unknown> };
	session.getBrowserStateSummary = () => new Promise(() => {});
	return h;
}

Deno.test('AC17: browser_get_state and browser_find stop waiting for the DOM build when cancelled', async () => {
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

Deno.test('AC17: a full-page browser_screenshot stops waiting for the capture when cancelled', async () => {
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

Deno.test('AC17: browser_run_task takes no action after a cancellation, between steps and around sampling', async () => {
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
		// Between steps: the model's answer arrives on a call its caller has already cancelled.
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

		// Around sampling: cancelled while the page is being read for the next question — no question is asked.
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
		// The abandoned read is the fake browser's; let it finish rather than leak its timer.
		slowRead.abort();
		await delay(10);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('AC17: browser_download stops waiting for the announcement when cancelled', async () => {
	const session = {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'download-cancel' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
	// A browser that navigates but never announces a download: the tool would wait out its whole window.
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
		// A9 rode along: the wait reported against its own window.
		assert(sent.length > 0 && sent.every((n) => n.params.total === 5), JSON.stringify(sent));
	} finally {
		await registry.shutdown();
	}
});

Deno.test('AC17: browser_head ends its request when cancelled (the fetch carries the call signal)', async () => {
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
		// A loopback literal on a non-default port is reachable only when named exactly (SR-HEAD-REDIRECT).
		const allowedDomains = ['127.0.0.1', `127.0.0.1:${listener.addr.port}`];
		const ctx: ToolContext = { registry, allowedDomains, principal: 'test', signal: cancel.signal };
		const started = performance.now();
		const pending = tools.browserHead({ url }, ctx);
		setTimeout(() => cancel.abort(), 30);
		// The fetch was aborted (mapped like any aborted HEAD), not refused by policy before it was sent.
		const error = await assertRejects(() => pending, ToolError);
		assertEquals(error.code, 'timeout');
		assert(performance.now() - started < 300, 'the request ended with the call, not with the server');
	} finally {
		await registry.shutdown();
		slow.abort();
		await listener.shutdown();
	}
});

Deno.test('AC17: library reads stop at a cancellation; writes are refused before they start, never abandoned', async () => {
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

		// A write already under way finishes and says so: an early answer would claim nothing happened.
		const late = new AbortController();
		const writing = byName.get('file_write')!.handler(
			{ path: 'a.txt', content: 'x' } as never,
			{ ...base, signal: late.signal },
		);
		setTimeout(() => late.abort(), 10);
		assertEquals(isError(await writing), false);
		// A write whose call was cancelled before it began never starts.
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

Deno.test('AC17: agent_* and sandbox_* calls stop waiting on their service when cancelled', async () => {
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
		// The service is told too: the sandbox action got the call's own signal, now aborted.
		assertEquals(seen.length, 1);
		assertEquals(seen[0]!.aborted, true);
	} finally {
		await registry.shutdown();
	}
});
