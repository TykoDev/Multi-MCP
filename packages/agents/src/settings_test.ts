/** The per-agent settings: strict parsing, and how the runtime applies the A2A, model, memory and A2UI switches. */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { AgentError } from './util.ts';
import { AgentRuntime, type AgentTask } from './runtime.ts';
import type { ModelProviderClient, ModelTool } from './model/transport.ts';
import {
	type AgentSettings,
	DEFAULT_AGENT_SETTINGS,
	parseAgentSettings,
	settingAllows,
	withoutRetiredSettings,
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

function runtimeWith(settings: AgentSettings, clients: ModelProviderClient[]): AgentRuntime {
	return new AgentRuntime({
		invoke: () => Promise.resolve({ content: [] }),
		model: {
			providers: new Map(clients.map((client) => [client.id, client])),
			default: clients[0]?.id ?? null,
			reachable: () => true,
			tools: () => TOOLS,
		},
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

Deno.test('a settings document is parsed onto its base, strictly, naming the field and never the value', () => {
	const next = parseAgentSettings({ builtin: { memory: false, model: { provider: 'p', model: 'm' } } });
	assertEquals(next.builtin, {
		model: { provider: 'p', model: 'm' },
		a2a: true,
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
			[{ acp: {} }, 'field acp'],
			[{ builtin: { acp: true } }, 'field builtin.acp'],
			[[], 'field agents'],
		] as const
	) {
		const error = assertThrows(() => parseAgentSettings(body), AgentError);
		assert(error.message.endsWith(field), error.message);
		assert(!error.message.includes('red') && !error.message.includes('yes'));
	}
});

Deno.test('a stored document that names the ACP agent parses without its fields, keeping the rest', () => {
	const stored = {
		builtin: { model: { provider: 'p', model: 'm' }, a2a: false, acp: false, a2ui: true, memory: true },
		sloplord: { model: null, a2a: true, acp: false, a2ui: true, memory: false },
		acp: { model: null, a2a: true, acp: true, a2ui: false, memory: false },
	};
	assertThrows(() => parseAgentSettings(stored), AgentError, 'field builtin.acp');
	const parsed = parseAgentSettings(withoutRetiredSettings(stored));
	assertEquals(parsed.builtin, { model: { provider: 'p', model: 'm' }, a2a: false, a2ui: true, memory: true });
	assertEquals(parsed.sloplord, { model: null, a2a: true, a2ui: true, memory: false });
	assertEquals(Object.keys(parsed).sort(), ['builtin', 'sloplord']);
	// Not an object: handed through for the parser to refuse.
	assertEquals(withoutRetiredSettings([]), []);
});

Deno.test('the memory and A2UI switches decide which tools an agent may be offered', () => {
	const off = { ...DEFAULT_AGENT_SETTINGS.builtin, memory: false, a2ui: false };
	assertEquals(TOOLS.map((tool) => tool.name).filter((name) => settingAllows(off, name)), [
		'sandbox_exec',
		'browser_navigate',
	]);
	assertEquals(TOOLS.filter((tool) => settingAllows(DEFAULT_AGENT_SETTINGS.builtin, tool.name)).length, TOOLS.length);
});

Deno.test('the A2A switches refuse an agent switched off A2A before any task exists, and only over A2A', async () => {
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

Deno.test('an agent’s own default model is used when a request names none, and a stale one falls back', async () => {
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

Deno.test('memory off narrows the built-in agent’s tools; A2UI on adds a2ui_* to SlopLord’s allowlist', async () => {
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
