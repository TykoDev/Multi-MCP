/**
 * R6 (D-126, AC22) and F3 (D-126, AC23): `browser_run_task` with sampling tools, and a task round bound to its run.
 *
 * Driven through the real HTTP entry on the 2026 era against a capture-backed session, so the step request is what
 * the SDK actually emits and the `requestState` is what the factory's codec actually sealed: the claims are about
 * the wire a client sees, not about a helper.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { AuthInfo, ClientCapabilities } from '@modelcontextprotocol/server';
import { captureHarness } from '../fixtures/capture_session.ts';
import { AGENT_TOOLS } from './agent.ts';
import { createBuildServer } from './server.ts';

const MODERN = '2026-07-28';
const TASKER: AuthInfo = { token: 't', clientId: 'tasker', scopes: ['mcp:invoke', 'task'], extra: {} };

async function readRpc(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		for (const line of text.split('\n')) if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
		throw new Error(`no data frame in SSE body: ${text}`);
	}
	return JSON.parse(text);
}

interface Step {
	method: string;
	params: { systemPrompt?: string; tools?: Array<{ name: string }>; toolChoice?: unknown; messages: unknown[] };
}

interface Result {
	resultType?: string;
	isError?: boolean;
	requestState?: string;
	inputRequests?: { step?: Step };
	structuredContent?: {
		status?: string;
		answer?: string | null;
		steps?: number;
		history?: string[];
		error?: { code?: string; message?: string };
	};
}

async function served() {
	const h = await captureHarness('baseline_button');
	const handler = createMcpHandler(createBuildServer({ registry: h.registry, version: '0.0.0-test' }), {
		legacy: 'stateless',
	});
	const run = async (
		args: Record<string, unknown>,
		caps: ClientCapabilities,
		answer?: unknown,
		state?: string,
	): Promise<Result> => {
		const params: Record<string, unknown> = {
			name: 'browser_run_task',
			arguments: args,
			_meta: { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: caps },
			...(answer === undefined ? {} : { inputResponses: { step: answer } }),
			...(state === undefined ? {} : { requestState: state }),
		};
		const body = await readRpc(
			await handler.fetch(
				new Request('http://127.0.0.1/mcp', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
						'mcp-method': 'tools/call',
						'mcp-name': 'browser_run_task',
					},
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
				}),
				{ authInfo: TASKER },
			),
		);
		assertEquals(body.error, undefined, `expected a result, got ${JSON.stringify(body.error)}`);
		return body.result as Result;
	};
	return {
		...h,
		run,
		async [Symbol.asyncDispose]() {
			await handler.close();
			await h.registry.shutdown();
		},
	};
}

const text = (value: string) => ({ role: 'assistant', model: 'stub', content: { type: 'text', text: value } });
const toolUse = (name: string, input: Record<string, unknown>) => ({
	role: 'assistant',
	model: 'stub',
	stopReason: 'toolUse',
	content: [{ type: 'text', text: 'calling a tool' }, { type: 'tool_use', id: 'call-1', name, input }],
});

// --- R6 ------------------------------------------------------------------------------------------------------------

Deno.test('AC22: a client with sampling.tools is handed the eight actions as tools and must call one', async () => {
	await using s = await served();
	const caps = { sampling: { tools: {} } };
	const asked = await s.run({ task: 'press the button', max_steps: 3 }, caps);
	assertEquals(asked.resultType, 'input_required');
	const step = asked.inputRequests?.step;
	assertEquals(step?.method, 'sampling/createMessage');
	assertEquals((step?.params.tools ?? []).map((tool) => tool.name), [
		'navigate',
		'click',
		'type',
		'press_key',
		'scroll',
		'go_back',
		'switch_tab',
		'done',
	]);
	assertEquals(step?.params.tools, JSON.parse(JSON.stringify(AGENT_TOOLS)));
	assertEquals(step?.params.toolChoice, { mode: 'required' });
	assert(!(step?.params.systemPrompt ?? '').includes('JSON object'), 'the tool prompt still teaches the JSON grammar');

	// A tool call is an action, run through the same path a JSON reply is: a bad tab is a recorded, failed step.
	const failed = await s.run(
		{ task: 'press the button', max_steps: 3 },
		caps,
		toolUse('switch_tab', { tab_id: 'ZZZZ' }),
		asked.requestState,
	);
	assertEquals(failed.resultType, 'input_required');
	assertStringIncludes(s.record.run?.history[0] ?? '', 'switch_tab ZZZZ -> failed');

	const done = await s.run(
		{ task: 'press the button', max_steps: 3 },
		caps,
		toolUse('done', { answer: 'pressed', action: 'navigate' }),
		failed.requestState,
	);
	assertEquals(done.structuredContent?.status, 'done');
	assertEquals(done.structuredContent?.answer, 'pressed', 'the tool name decides the action, not an input key');
	assertEquals(done.structuredContent?.steps, 2);
});

Deno.test('AC22: without sampling.tools the text protocol is unchanged', async () => {
	await using s = await served();
	const caps = { sampling: {} };
	const asked = await s.run({ task: 'press the button', max_steps: 2 }, caps);
	const params = asked.inputRequests?.step?.params;
	assertEquals(params?.tools, undefined);
	assertEquals(params?.toolChoice, undefined);
	assertStringIncludes(params?.systemPrompt ?? '', 'Reply with the JSON object only. No prose, no code fences.');
	assertStringIncludes(JSON.stringify(params?.messages), 'Reply with one action as a JSON object.');

	const done = await s.run(
		{ task: 'press the button', max_steps: 2 },
		caps,
		text('{"action":"done","answer":"ok"}'),
		asked.requestState,
	);
	assertEquals(done.structuredContent?.status, 'done');
	assertEquals(done.structuredContent?.answer, 'ok');
});

// --- F3 ------------------------------------------------------------------------------------------------------------

Deno.test('AC23: an answer for a replaced run is refused and never drives the new one', async () => {
	await using s = await served();
	const caps = { sampling: {} };
	const first = await s.run({ task: 'first task' }, caps);
	const second = await s.run({ task: 'second task' }, caps);
	assert(first.requestState !== undefined && second.requestState !== undefined);
	assertEquals(s.record.run?.task, 'second task');

	// The late answer to the first run arrives with that run's own, genuine, unexpired state.
	const late = await s.run({ task: 'first task' }, caps, text('{"action":"done","answer":"late"}'), first.requestState);
	assertEquals(late.isError, true);
	assertEquals(late.structuredContent?.error?.code, 'invalid-arguments');
	assertStringIncludes(late.structuredContent?.error?.message ?? '', 'the run this answer belongs to has ended');
	assertEquals(s.record.run?.task, 'second task', 'the late answer ended the replacement run');
	assertEquals(s.record.run?.steps, 0, 'the late answer took a step in the replacement run');

	// An answer that carries no state at all is not one this server asked for either.
	const unsealed = await s.run({ task: 'second task' }, caps, text('{"action":"done","answer":"x"}'));
	assertEquals(unsealed.structuredContent?.error?.code, 'invalid-arguments');
	assertEquals(s.record.run?.steps, 0);

	// The replacement's own answer is served.
	const done = await s.run({ task: 'second task' }, caps, text('{"action":"done","answer":"ok"}'), second.requestState);
	assertEquals(done.structuredContent?.status, 'done');
	assertEquals(done.structuredContent?.answer, 'ok');
});

Deno.test('AC23: a task round minted under one codec is not honoured by another factory', async () => {
	// Per-factory keys (design §2.14): a state from one process — or from before a restart — fails closed.
	await using a = await served();
	await using b = await served();
	const caps = { sampling: {} };
	const asked = await a.run({ task: 'one' }, caps);
	await b.run({ task: 'one' }, caps);
	const params = {
		name: 'browser_run_task',
		arguments: { task: 'one' },
		_meta: { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: caps },
		inputResponses: { step: text('{"action":"done","answer":"x"}') },
		requestState: asked.requestState,
	};
	const handler = createMcpHandler(createBuildServer({ registry: b.registry, version: '0.0.0-test' }), {
		legacy: 'stateless',
	});
	try {
		const body = await readRpc(
			await handler.fetch(
				new Request('http://127.0.0.1/mcp', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
						'mcp-method': 'tools/call',
						'mcp-name': 'browser_run_task',
					},
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
				}),
				{ authInfo: TASKER },
			),
		);
		assertEquals((body.error as { code?: number } | undefined)?.code, -32602);
		assertEquals(b.record.run?.steps, 0);
	} finally {
		await handler.close();
	}
});
