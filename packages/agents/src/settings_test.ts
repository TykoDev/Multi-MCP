/**
 * D-158: the per-agent settings — parsing (strict, partial onto a base), the tool switches, and how the runtime
 * applies them: the ACP switch and the A2A switches route or refuse text tasks before anything exists, an agent's
 * own default model is used when a request names none (and falls back when it went stale), and the memory and A2UI
 * switches narrow — or, for SlopLord's A2UI, extend — the tool list the provider is offered.
 */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { AgentError } from './util.ts';
import { AgentRuntime, type AgentTask } from './runtime.ts';
import type { ModelProviderClient, ModelTool } from './model/types.ts';
import {
	AGENT_APPLIES,
	type AgentSettings,
	DEFAULT_AGENT_SETTINGS,
	parseAgentSettings,
	settingAllows,
} from './settings.ts';

const FULL = new Set(['agent:invoke', 'mcp:invoke', 'model:invoke', 'sandbox:execute', 'a2ui:publish']);
const TOOLS: ModelTool[] = ['memory_save', 'memory_search', 'a2ui_publish', 'sandbox_exec', 'browser_navigate'].map((
	name,
) => ({ name, description: name, inputSchema: { type: 'object' } }));

/** A provider that answers every turn at once and records the tool names it was offered. */
function fakeClient(id: string, models: string[], offered: string[][] = []): ModelProviderClient {
	return {
		id,
		kind: 'openai',
		models,
		defaultModel: models[0]!,
		complete(input) {
			offered.push(input.tools.map((tool) => tool.name));
			return Promise.resolve({ text: 'done', toolCalls: [], stop: 'end', usage: { input: 1, output: 1 } });
		},
	};
}

function runtimeWith(settings: AgentSettings, clients: ModelProviderClient[], bridge = false): AgentRuntime {
	return new AgentRuntime({
		invoke: () => Promise.resolve({ content: [] }),
		model: {
			providers: new Map(clients.map((client) => [client.id, client])),
			default: clients[0]?.id ?? null,
			reachable: () => true,
			tools: () => TOOLS,
		},
		...(bridge ? { bridge: { url: 'http://127.0.0.1:9/', token: 't', agent: 'a' } } : {}),
		codingSandbox: true,
		agents: () => settings,
	});
}

function text(): Record<string, unknown> {
	return { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hello' }] };
}

async function finished(runtime: AgentRuntime, id: string): Promise<AgentTask> {
	const reader = runtime.subscribe('alice', id).getReader();
	try {
		while (!(await reader.read()).done) { /* drain */ }
	} finally {
		reader.releaseLock();
	}
	return runtime.get('alice', id);
}

function refusal(fn: () => unknown): AgentError {
	try {
		fn();
	} catch (error) {
		if (error instanceof AgentError) return error;
		throw error;
	}
	throw new Error('expected a refusal');
}

Deno.test('D-158: the defaults are the behaviour before the settings — every switch where it was', () => {
	assertEquals(DEFAULT_AGENT_SETTINGS.builtin, { model: null, a2a: true, acp: false, a2ui: true, memory: true });
	assertEquals(DEFAULT_AGENT_SETTINGS.sloplord, { model: null, a2a: true, acp: false, a2ui: false, memory: true });
	assertEquals(DEFAULT_AGENT_SETTINGS.acp.acp, true);
	assertEquals(AGENT_APPLIES.acp.model, false);
	assertEquals(AGENT_APPLIES.builtin.acp, false);
});

Deno.test('D-158: a settings document is parsed onto its base, strictly, naming the field and never the value', () => {
	const next = parseAgentSettings({ builtin: { memory: false, model: { provider: 'p', model: 'm' } } });
	assertEquals(next.builtin, {
		model: { provider: 'p', model: 'm' },
		a2a: true,
		acp: false,
		a2ui: true,
		memory: false,
	});
	assertEquals(next.sloplord, DEFAULT_AGENT_SETTINGS.sloplord);
	assertEquals(parseAgentSettings({ builtin: { model: null } }, next).builtin.model, null);
	for (
		const [body, field] of [
			[{ nobody: {} }, 'field nobody'],
			[{ builtin: { colour: 'red' } }, 'field builtin.colour'],
			[{ builtin: { a2a: 'yes' } }, 'field builtin.a2a'],
			[{ acp: { model: { provider: 'p' } } }, 'field acp.model'],
			[[], 'field agents'],
		] as const
	) {
		const error = assertThrows(() => parseAgentSettings(body), AgentError);
		assert(error.message.endsWith(field), error.message);
		assert(!error.message.includes('red') && !error.message.includes('yes'));
	}
});

Deno.test('D-158: the memory and A2UI switches decide which tools an agent may be offered', () => {
	const off = { ...DEFAULT_AGENT_SETTINGS.builtin, memory: false, a2ui: false };
	assertEquals(TOOLS.map((tool) => tool.name).filter((name) => settingAllows(off, name)), [
		'sandbox_exec',
		'browser_navigate',
	]);
	assertEquals(TOOLS.filter((tool) => settingAllows(DEFAULT_AGENT_SETTINGS.builtin, tool.name)).length, TOOLS.length);
});

Deno.test('D-158: the ACP switch — off, a text task naming no provider runs on the built-in agent', async () => {
	const settings = parseAgentSettings({ acp: { acp: false } });
	const runtime = runtimeWith(settings, [fakeClient('p', ['m'])], true);
	try {
		assertEquals(runtime.routesToBridge(), false);
		const task = runtime.submit('alice', FULL, text());
		assertEquals([task.metadata?.backend, task.metadata?.provider], ['model', 'p']);
		assertEquals((await finished(runtime, task.id)).status.state, 'TASK_STATE_COMPLETED');
	} finally {
		await runtime.close();
	}
});

Deno.test('D-158: the ACP agent off A2A — an A2A text task goes to the built-in agent, a REST one still to the bridge', async () => {
	const runtime = runtimeWith(parseAgentSettings({ acp: { a2a: false } }), [fakeClient('p', ['m'])], true);
	try {
		assertEquals([runtime.routesToBridge(), runtime.routesToBridge('a2a')], [true, false]);
		const task = runtime.submit('alice', FULL, text(), undefined, { via: 'a2a' });
		assertEquals(task.metadata?.backend, 'model');
		await finished(runtime, task.id);
	} finally {
		await runtime.close();
	}
});

Deno.test('D-158: the A2A switches refuse an agent switched off A2A before any task exists, and only over A2A', async () => {
	const settings = parseAgentSettings({ builtin: { a2a: false }, sloplord: { a2a: false } });
	const runtime = runtimeWith(settings, [fakeClient('p', ['m'])]);
	try {
		const builtin = refusal(() => runtime.submit('alice', FULL, text(), undefined, { via: 'a2a' }));
		assertEquals([builtin.code, builtin.message], [-32004, 'The built-in agent is not offered over A2A']);
		const profile = refusal(() => runtime.submit('alice', FULL, text(), undefined, { via: 'a2a', agent: 'sloplord' }));
		assertEquals([profile.code, profile.message], [-32004, 'SlopLord is not offered over A2A']);
		assertEquals(runtime.list('alice').length, 0);
		// The chat (REST) is not A2A: both still run there.
		const task = runtime.submit('alice', FULL, text());
		await finished(runtime, task.id);
	} finally {
		await runtime.close();
	}
});

Deno.test('D-158: an agent’s own default model is used when a request names none, and a stale one falls back', async () => {
	const first = fakeClient('first', ['a']);
	const second = fakeClient('second', ['b', 'c']);
	const chosen = parseAgentSettings({ builtin: { model: { provider: 'second', model: 'c' } } });
	const runtime = runtimeWith(chosen, [first, second]);
	const stale = runtimeWith(parseAgentSettings({ builtin: { model: { provider: 'gone', model: 'x' } } }), [first]);
	try {
		const task = runtime.submit('alice', FULL, text());
		assertEquals([task.metadata?.provider, task.metadata?.model], ['second', 'c']);
		// A request that names a provider still gets it.
		const named = runtime.submit('alice', FULL, text(), undefined, { model: { provider: 'first' } });
		assertEquals([named.metadata?.provider, named.metadata?.model], ['first', 'a']);
		const fallback = stale.submit('alice', FULL, text());
		assertEquals([fallback.metadata?.provider, fallback.metadata?.model], ['first', 'a']);
		await Promise.all([finished(runtime, task.id), finished(runtime, named.id), finished(stale, fallback.id)]);
		// Without model:invoke the chosen model is no backdoor.
		const scopeless = refusal(() => runtime.submit('alice', new Set(['agent:invoke']), text()));
		assertEquals(scopeless.code, -32004);
	} finally {
		await runtime.close();
		await stale.close();
	}
});

Deno.test('D-158: memory off narrows the built-in agent’s tools; A2UI on adds a2ui_* to SlopLord’s allowlist', async () => {
	const offered: string[][] = [];
	const settings = parseAgentSettings({ builtin: { memory: false }, sloplord: { a2ui: true, memory: false } });
	const runtime = runtimeWith(settings, [fakeClient('p', ['m'], offered)]);
	try {
		const plain = runtime.submit('alice', FULL, text());
		await finished(runtime, plain.id);
		const coding = runtime.submit('alice', FULL, text(), undefined, { agent: 'sloplord' });
		await finished(runtime, coding.id);
		assertEquals(offered[0], ['a2ui_publish', 'sandbox_exec', 'browser_navigate']);
		assertEquals(offered[1], ['a2ui_publish', 'sandbox_exec']);
	} finally {
		await runtime.close();
	}
	// The default SlopLord: memory in, A2UI out.
	const defaults: string[][] = [];
	const plainRuntime = runtimeWith(DEFAULT_AGENT_SETTINGS, [fakeClient('p', ['m'], defaults)]);
	try {
		const task = plainRuntime.submit('alice', FULL, text(), undefined, { agent: 'sloplord' });
		await finished(plainRuntime, task.id);
		assertEquals(defaults[0], ['memory_save', 'memory_search', 'sandbox_exec']);
	} finally {
		await plainRuntime.close();
	}
});
