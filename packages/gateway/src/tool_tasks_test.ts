/**
 * R1 (D-121, AC13, AC14): background tool tasks over MCP — `agent_run_tool` and `agent_list_tasks` on the
 * owner-isolated `AgentRuntime` that A2A already uses.
 *
 * Two levels: the composed services driven through the same executor the dispatcher uses (fast, every refusal), and
 * the gateway's own `/mcp` mount with two real API keys (the bearer gate, the stamped owner and GW-1 re-authorization
 * on the path). No browser is launched: the task's tool is `browser_list_sessions`, which reads the registry only.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { AgentTask } from '@tykotech/agents';
import type { BrowserSession } from '@tykotech/browser';
import {
	CONFIRM_TOOL_NAMES,
	createToolExecutor,
	type EmbedTicketInput,
	type McpAppsDeps,
	type McpDeps,
	type Scope,
	SessionRegistry,
	type ToolResult,
} from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createExpansionServices, type ExpansionServices, NOT_TASKABLE } from './expansion.ts';
import { createLogger } from './logger.ts';

const SCOPES: ReadonlySet<Scope> = new Set(['mcp:invoke', 'agent:invoke']);
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

interface Harness {
	registry: SessionRegistry;
	services: ExpansionServices;
	recorded: string[];
	call(owner: string, name: string, args: Record<string, unknown>, scopes?: ReadonlySet<Scope>): Promise<ToolResult>;
	[Symbol.asyncDispose](): Promise<void>;
}

function harness(launch?: () => Promise<BrowserSession>, extra: Partial<McpDeps> = {}): Harness {
	const registry = new SessionRegistry({ reapIntervalMs: 0, ...(launch === undefined ? {} : { launch }) });
	const recorded: string[] = [];
	const core = { registry, version: 'tool-tasks', ...extra };
	const services = createExpansionServices(loadConfig({}).expansion, core, undefined, undefined, undefined, {
		onToolTask: (id) => recorded.push(id),
	});
	return {
		registry,
		services,
		recorded,
		call: (owner, name, args, scopes = SCOPES) =>
			createToolExecutor({ ...core, extraTools: services.tools }, owner, scopes)(name, args),
		async [Symbol.asyncDispose]() {
			await services.close();
			await registry.shutdown();
		},
	};
}

/** The `{ result }` of a successful extension tool call. */
function resultOf(result: ToolResult): Record<string, unknown> {
	const call = result as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: unknown };
	assertEquals(call.isError, undefined, call.content[0]?.text);
	return (call.structuredContent as { result: Record<string, unknown> }).result;
}

/** The `Error: <code>: …` text of a failed call. */
function errorOf(result: ToolResult): string {
	const call = result as { isError?: boolean; content: Array<{ text?: string }> };
	assertEquals(call.isError, true, 'expected a failure');
	return call.content[0]?.text ?? '';
}

async function finished(services: ExpansionServices, owner: string, id: string): Promise<AgentTask> {
	const reader = services.runtime.subscribe(owner, id).getReader();
	while (!(await reader.read()).done) { /* until the task ends */ }
	reader.releaseLock();
	return services.runtime.get(owner, id);
}

Deno.test('AC13: agent_run_tool answers with a task at once; agent_get_task later carries the tool result', async () => {
	await using h = harness();
	const run = resultOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_list_sessions', arguments: {} }));
	const task = run.task as AgentTask;
	assert(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state), task.status.state);
	assertEquals(h.recorded, [task.id], 'the task id is reported for cluster routing');
	await finished(h.services, ALICE, task.id);

	const got = resultOf(await h.call(ALICE, 'agent_get_task', { task_id: task.id })).task as AgentTask;
	assertEquals(got.status.state, 'TASK_STATE_COMPLETED');
	const artifact = got.artifacts[0] as { parts: Array<{ data: { structuredContent?: { sessions?: unknown[] } } }> };
	assertEquals(artifact.parts[0]!.data.structuredContent?.sessions, [], "the tool's own result is the artifact");

	// Another owner: not in its list, and the id answers as nothing it can read.
	assertEquals(resultOf(await h.call(BOB, 'agent_list_tasks', {})).tasks, []);
	assert(errorOf(await h.call(BOB, 'agent_get_task', { task_id: task.id })).startsWith('Error: '));
	let foreign: unknown;
	try {
		h.services.runtime.get(BOB, task.id);
	} catch (error) {
		foreign = error;
	}
	assertEquals((foreign as { code?: number }).code, -32001, 'the runtime answers a foreign id as not found');
});

Deno.test("agent_get_task / agent_cancel_task: an unknown id and a finished task are the caller's to fix", async () => {
	await using h = harness();
	const run = resultOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_list_sessions', arguments: {} }));
	const task = run.task as AgentTask;
	await finished(h.services, ALICE, task.id);
	assertStringIncludes(
		errorOf(await h.call(ALICE, 'agent_cancel_task', { task_id: task.id })),
		'Error: invalid-arguments: Task cannot be canceled',
	);
	assertStringIncludes(
		errorOf(await h.call(ALICE, 'agent_get_task', { task_id: crypto.randomUUID() })),
		'Error: invalid-arguments:',
	);
});

Deno.test('AC13: agent_list_tasks lists only the caller, newest first, without history, filtered and bounded', async () => {
	let open!: () => void;
	const gate = new Promise<void>((resolve) => open = resolve);
	await using h = harness(async () => {
		await gate;
		throw new Error('no browser in the unit tier');
	});
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) {
		const task = resultOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_list_sessions' })).task as AgentTask;
		await finished(h.services, ALICE, task.id);
		ids.push(task.id);
		// Creation order is kept at millisecond grain (ties fall back to the id, AG-14): keep the three apart.
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	await h.call(BOB, 'agent_run_tool', { tool: 'browser_list_sessions' });

	const all = resultOf(await h.call(ALICE, 'agent_list_tasks', {}));
	assertEquals((all.tasks as AgentTask[]).map((task) => task.id), [...ids].reverse(), 'newest created first');
	assertEquals(all.truncated, false);
	for (const task of all.tasks as AgentTask[]) assertEquals(task.history, [], 'history is trimmed to nothing');

	const two = resultOf(await h.call(ALICE, 'agent_list_tasks', { limit: 2 }));
	assertEquals((two.tasks as AgentTask[]).map((task) => task.id), [ids[2], ids[1]]);
	assertEquals(two.truncated, true);

	// A task whose session launch is held open stays active until it is cancelled.
	const held = resultOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_get_state' })).task as AgentTask;
	const active = resultOf(await h.call(ALICE, 'agent_list_tasks', { state: 'active' }));
	assertEquals((active.tasks as AgentTask[]).map((task) => task.id), [held.id]);
	const done = resultOf(await h.call(ALICE, 'agent_list_tasks', { state: 'finished' }));
	assertEquals((done.tasks as AgentTask[]).map((task) => task.id), [...ids].reverse());

	resultOf(await h.call(ALICE, 'agent_cancel_task', { task_id: held.id }));
	open();
	const after = resultOf(await h.call(ALICE, 'agent_list_tasks', { state: 'active' }));
	assertEquals(after.tasks, []);
});

Deno.test('AC14: sampling tools, agent_run_tool, the confirmation set and the human/live tools are refused', async () => {
	await using h = harness();
	const expected = [
		'browser_run_task',
		'browser_extract_content',
		'agent_run_tool',
		'browser_request_human',
		'browser_live_view',
		'browser_live_ticket',
		// The MCP Apps stream tickets belong to the embed at the other end of this call, like the live-view ticket.
		'sandbox_session_ticket',
		'a2ui_surface_ticket',
		// Review R1-5 / R2-5: a signed URL is a bearer credential for its life, and a task keeps its result at rest.
		'browser_file_link',
		...CONFIRM_TOOL_NAMES,
	];
	assertEquals([...NOT_TASKABLE].sort(), [...new Set(expected)].sort());
	for (const tool of NOT_TASKABLE) {
		const text = errorOf(await h.call(ALICE, 'agent_run_tool', { tool, arguments: {} }, new Set(['admin', ...SCOPES])));
		assertEquals(text, `Error: invalid-arguments: call ${tool} directly; it cannot run as a background task`);
	}
	assertEquals(h.services.runtime.list(ALICE), [], 'no refused call created a task');
	assertEquals(h.recorded, []);
});

/** An MCP Apps deployment whose mint records what it was asked and always succeeds. */
function appsStub(asked: EmbedTicketInput[]): McpAppsDeps {
	return {
		mode: 'control',
		liveViewHtml: 'live',
		a2uiHtml: 'a2ui',
		terminalHtml: 'terminal',
		connectDomains: ['wss://gw.example.test'],
		origins: ['https://host.example'],
		mintTicket: (input) => {
			asked.push(input);
			return Promise.resolve({
				ticket: 'TICKET-SENTINEL',
				ws_url: 'wss://gw.example.test/live/default/ws',
				session_id: 'default',
				mode: input.mode,
				expires_in: 30,
				origin_bound: input.origin,
				control_plane_url: 'https://gw.example.test/#/view/default',
			});
		},
	};
}

/** A structured task as A2A `message:send` and the HTTP+JSON binding submit it: one data part, no MCP context. */
function structured(tool: string, args: Record<string, unknown> = {}) {
	return { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ data: { tool, arguments: args } }] };
}

Deno.test('R1-3: a structured task naming a tool outside the taskable set fails at the gateway, before the tool runs', async () => {
	const asked: EmbedTicketInput[] = [];
	await using h = harness(undefined, { mcpApps: appsStub(asked) });
	const scopes = new Set(['mcp:invoke', 'agent:invoke', 'view:watch', 'view:control', 'admin']);
	// `agent_run_tool` refuses these at submission; A2A and REST submit straight to the runtime, so the refusal that
	// covers every structured task is the gateway's own invoke wrapper.
	for (
		const [tool, args] of [
			['browser_live_ticket', { origin: 'https://host.example' }],
			['browser_close_all', {}],
			['browser_file_link', { file_id: 'f1' }],
		] as const
	) {
		const task = h.services.runtime.submit(ALICE, scopes, structured(tool, args));
		const done = await finished(h.services, ALICE, task.id);
		assertEquals(done.status.state, 'TASK_STATE_FAILED', tool);
		assertEquals(done.artifacts, [], `${tool}: nothing it could have returned is kept at rest`);
		const said = JSON.stringify(done.status);
		assertStringIncludes(said, `call ${tool} directly; it cannot run as a background task`);
	}
	assertEquals(asked, [], 'no ticket was minted for a task');
	// The extended card lists exactly what a task can run, so it advertises none of them.
	const offered = h.services.invocableTools!(scopes).map((tool) => tool.name);
	for (const tool of NOT_TASKABLE) assert(!offered.includes(tool), `the card advertises ${tool}`);
	assert(offered.includes('browser_list_sessions'), 'the card still lists taskable tools');
});

Deno.test('R3-5: a task created over A2A or REST is recorded for cluster routing, not only one created over MCP', async () => {
	await using h = harness();
	// A2A `message:send`, its HTTP+JSON binding and the REST task route all create through `runtime.submit`.
	const messageId = crypto.randomUUID();
	const send = () => h.services.runtime.submit(ALICE, SCOPES, { ...structured('browser_list_sessions'), messageId });
	const viaA2a = send();
	assertEquals(h.recorded, [viaA2a.id], 'recorded at creation, whichever entrance created it');
	await finished(h.services, ALICE, viaA2a.id);
	// A retry of the same message answers with the task it started and records nothing new.
	assertEquals(send().id, viaA2a.id);
	assertEquals(h.recorded, [viaA2a.id]);
	const viaMcp = resultOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_list_sessions' })).task as AgentTask;
	assertEquals(h.recorded, [viaA2a.id, viaMcp.id], 'an MCP task is recorded once, not twice');
	await finished(h.services, ALICE, viaMcp.id);
});

Deno.test('R1-3: a tool executor never mints an embed ticket keyed on the owner string', async () => {
	// The executor's context knows only the realm-qualified owner (`api-key:alice`): a ticket minted there was issued to
	// that string, missing the per-token origin overlay (keyed `alice`) and opening a second per-principal bucket.
	const asked: EmbedTicketInput[] = [];
	await using h = harness(undefined, { mcpApps: appsStub(asked) });
	const text = errorOf(
		await h.call(ALICE, 'browser_live_ticket', { origin: 'https://host.example' }, new Set(['view:watch', ...SCOPES])),
	);
	assertStringIncludes(text, 'Error: invalid-arguments:');
	assertEquals(asked, []);
});

Deno.test('R1: an unknown tool, a malformed name and a tool outside the grant are refused before any task', async () => {
	await using h = harness();
	assertEquals(
		errorOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_teleport' })),
		'Error: invalid-arguments: there is no tool named browser_teleport',
	);
	assertStringIncludes(
		errorOf(await h.call(ALICE, 'agent_run_tool', { tool: 'Browser-Navigate' })),
		'Error: invalid-arguments:',
	);
	assertStringIncludes(
		errorOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_list_sessions', extra: true })),
		'Error: invalid-arguments:',
		'the input is strict',
	);
	// The message names the tool the caller gave, never the grant it lacks (CONNECTORS §1.5).
	assertEquals(
		errorOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_evaluate', arguments: { expression: '1' } })),
		'Error: scope-required: this credential cannot call browser_evaluate',
	);
	assertEquals(h.services.runtime.list(ALICE), []);
	// And without agent:invoke the tool itself is not the caller's.
	assertStringIncludes(
		errorOf(await h.call(ALICE, 'agent_run_tool', { tool: 'browser_list_sessions' }, new Set(['mcp:invoke']))),
		'Error: scope-required:',
	);
});

// --- through the gateway's /mcp mount ----------------------------------------------------------------------------

const ORIGIN = 'http://127.0.0.1:8787';

async function mcpTool(
	app: ReturnType<typeof createGatewayApp>['app'],
	token: string,
	name: string,
	args: Record<string, unknown>,
): Promise<{ isError?: boolean; structuredContent?: { result?: Record<string, unknown> } }> {
	const response = await app.request(`${ORIGIN}/mcp`, {
		method: 'POST',
		headers: {
			host: '127.0.0.1:8787',
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
	});
	const text = await response.text();
	assertEquals(response.status, 200, text);
	const line = text.trimStart().startsWith('{')
		? text
		: text.split('\n').find((entry) => entry.startsWith('data:'))!.slice(5);
	return (JSON.parse(line) as { result: Record<string, unknown> }).result;
}

Deno.test('AC13: over /mcp, a task runs under its own key and another key neither lists nor reads it', async () => {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const bob = await generateApiKey('bob', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([alice.record, bob.record]) });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'tool-tasks',
		logger: createLogger({ level: 'error', write: (): void => {} }),
	});
	try {
		const run = await mcpTool(gateway.app, alice.key, 'agent_run_tool', { tool: 'browser_list_sessions' });
		const id = (run.structuredContent?.result?.task as AgentTask).id;
		let state = '';
		for (let attempt = 0; attempt < 100 && state !== 'TASK_STATE_COMPLETED'; attempt++) {
			const got = await mcpTool(gateway.app, alice.key, 'agent_get_task', { task_id: id });
			state = (got.structuredContent?.result?.task as AgentTask).status.state;
			if (state !== 'TASK_STATE_COMPLETED') await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assertEquals(state, 'TASK_STATE_COMPLETED', 'GW-1 re-authorized the task against its own key and it ran');
		const mine = await mcpTool(gateway.app, alice.key, 'agent_list_tasks', {});
		assertEquals((mine.structuredContent?.result?.tasks as AgentTask[]).map((task) => task.id), [id]);
		const theirs = await mcpTool(gateway.app, bob.key, 'agent_list_tasks', {});
		assertEquals(theirs.structuredContent?.result?.tasks, []);
		assertEquals((await mcpTool(gateway.app, bob.key, 'agent_get_task', { task_id: id })).isError, true);
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});
