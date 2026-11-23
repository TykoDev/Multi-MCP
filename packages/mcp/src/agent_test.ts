/** `parseAction` — reading one browser action out of whatever a model replied. */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { AGENT_TOOLS, parseAction } from './agent.ts';
import { ToolError } from './errors.ts';
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	type ClientCapabilities,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { captureHarness, readRpc } from '../fixtures/capture_session.ts';
import { createBuildServer } from './server.ts';

Deno.test('parseAction: a clean single object', () => {
	const action = parseAction('{"thought":"the only control","action":"click","index":16}');
	assertEquals(action.action, 'click');
	assertEquals(action.index, 16);
	assertEquals(action.thought, 'the only control');
});

Deno.test('parseAction: prose and code fences around the object are ignored', () => {
	const action = parseAction(
		'Sure! Here is the action:\n```json\n{"action":"done","answer":"hello"}\n```\nHope that helps.',
	);
	assertEquals(action.action, 'done');
	assertEquals(action.answer, 'hello');
});

Deno.test('parseAction: a model really does split thought and action across two objects', () => {
	const action = parseAction(
		'{"thought":"The task is to press the button and report the text the page then shows. ' +
			"The button has the text 'Press me' at index 16. I will click it.\"}\n" +
			'{"action":"click","index":16}',
	);
	assertEquals(action.action, 'click');
	assertEquals(action.index, 16);
});

Deno.test('parseAction: an unparseable object before a good one does not end the turn', () => {
	const action = parseAction(
		'{"thought":"I need to click the "Press me" button."}\n{"action":"click","index":16}',
	);
	assertEquals(action.action, 'click');
});

Deno.test('parseAction: a truncated object does not hide a later complete one', () => {
	const action = parseAction('{"thought":"cut off mid-str\n{"action":"done","answer":"ok"}');
	assertEquals(action.action, 'done');
});

Deno.test('parseAction: nested objects inside the action survive', () => {
	const action = parseAction('{"action":"type","index":2,"text":"{\\"not\\":\\"an action\\"}"}');
	assertEquals(action.action, 'type');
	assertEquals(action.text, '{"not":"an action"}');
});

Deno.test('parseAction: the first object with an action wins, not the last', () => {
	const action = parseAction('{"action":"click","index":1}\n{"action":"done","answer":"no"}');
	assertEquals(action.action, 'click');
});

Deno.test('parseAction: pure prose is refused, and says so', () => {
	const error = assertThrows(
		() => parseAction('Sure! I would be happy to help with that.'),
		ToolError,
	);
	assertStringIncludes(error.message, 'no JSON object');
});

Deno.test('parseAction: objects with no action report that, not a parse error', () => {
	const error = assertThrows(() => parseAction('{"thought":"thinking"}\n{"still":"thinking"}'), ToolError);
	assertStringIncludes(error.message, 'no "action"');
});

Deno.test('parseAction: an action wrapped in a JSON array is still read', () => {
	assertEquals(parseAction('[{"action":"click","index":3}]').index, 3);
});

Deno.test('parseAction: an empty action string is refused', () => {
	const error = assertThrows(() => parseAction('{"action":""}'), ToolError);
	assertStringIncludes(error.message, 'no "action"');
});

// --- `browser_run_task` with sampling tools, and a task round bound to its run. ---

const MODERN = '2026-07-28';
const TASKER: AuthInfo = { token: 't', clientId: 'tasker', scopes: ['mcp:invoke', 'task'], extra: {} };

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
						'mcp-protocol-version': MODERN,
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

// --- sampling tools ------------------------------------------------------------------------------------------------

Deno.test('sampling tools: a client with sampling.tools is handed the eight actions as tools and must call one', async () => {
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

Deno.test('sampling tools: without sampling.tools the text protocol is unchanged', async () => {
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

// --- run binding ---------------------------------------------------------------------------------------------------

Deno.test('run binding: an answer for a replaced run is refused and never drives the new one', async () => {
	await using s = await served();
	const caps = { sampling: {} };
	const first = await s.run({ task: 'first task' }, caps);
	const second = await s.run({ task: 'second task' }, caps);
	assert(first.requestState !== undefined && second.requestState !== undefined);
	assertEquals(s.record.run?.task, 'second task');

	const late = await s.run({ task: 'first task' }, caps, text('{"action":"done","answer":"late"}'), first.requestState);
	assertEquals(late.isError, true);
	assertEquals(late.structuredContent?.error?.code, 'invalid-arguments');
	assertStringIncludes(late.structuredContent?.error?.message ?? '', 'the run this answer belongs to has ended');
	assertEquals(s.record.run?.task, 'second task', 'the late answer ended the replacement run');
	assertEquals(s.record.run?.steps, 0, 'the late answer took a step in the replacement run');

	const unsealed = await s.run({ task: 'second task' }, caps, text('{"action":"done","answer":"x"}'));
	assertEquals(unsealed.structuredContent?.error?.code, 'invalid-arguments');
	assertEquals(s.record.run?.steps, 0);

	const done = await s.run({ task: 'second task' }, caps, text('{"action":"done","answer":"ok"}'), second.requestState);
	assertEquals(done.structuredContent?.status, 'done');
	assertEquals(done.structuredContent?.answer, 'ok');
});

Deno.test('run binding: a task round minted under one codec is not honoured by another factory', async () => {
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
						'mcp-protocol-version': MODERN,
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
