/// <reference lib="deno.ns" />
/**
 * D-152, D-154: the pure parts of System › Agents — the provider list as the PUT takes it (every provider, every kept
 * key `keep`, never a key value), the edits made to it, the host a kept key is bound to, and the editor's readings of
 * models and headers.
 */
import { assertEquals, assertThrows } from '@std/assert';
import type { ManagedAgent, ManagedProvider, ModelProvidersConfig } from './api.ts';
import {
	inputOf,
	keyWords,
	modelWords,
	monogram,
	netHostOf,
	parseHeaders,
	parseModels,
	protocolsOn,
	storeOf,
	withoutProvider,
	withProvider,
} from './system_agents.ts';

const BASE: Omit<ManagedProvider, 'id' | 'label' | 'origin' | 'key' | 'models' | 'default_model'> = {
	kind: 'openai',
	base_url: 'https://openrouter.ai/api/v1',
	headers: {},
	allow_http: false,
	max_tokens_param: 'max_tokens',
	max_steps: 24,
	max_output_tokens: 4096,
	token_budget: 400000,
	host: 'openrouter.ai:443',
	reachable: true,
};

const FILE_PROVIDER: ManagedProvider = {
	...BASE,
	id: 'local',
	label: 'Local Ollama',
	base_url: 'http://127.0.0.1:11434/v1',
	models: ['llama3.2', 'qwen2.5-coder'],
	default_model: 'llama3.2',
	origin: 'seed',
	key: { source: 'none' },
};
const ADDED: ManagedProvider = {
	...BASE,
	id: 'openrouter',
	label: 'OpenRouter',
	models: ['a', 'b'],
	default_model: 'b',
	origin: 'admin',
	key: { source: 'stored' },
};

const CONFIG: ModelProvidersConfig = {
	seed: { file: '/run/secrets/ttk_model_providers', seeded_at: '2026-10-07T00:00:00.000Z' },
	store: { available: true, database: '/data/ttk.db', vault: 'unlocked' },
	default: 'local',
	providers: [FILE_PROVIDER, ADDED],
};

Deno.test('system agents (D-154): the list holds every provider, keys kept, the default in force', () => {
	const store = storeOf(CONFIG);
	assertEquals(store.providers.map((provider) => provider.id), ['local', 'openrouter'], 'seeded ones included');
	assertEquals(store.providers.map((provider) => provider.key), [{ mode: 'keep' }, { mode: 'keep' }]);
	assertEquals(store.default, 'local');
	// Nothing in the body could carry a key value unless one was typed.
	assertEquals(JSON.stringify(store).includes('"value"'), false);
});

Deno.test('system agents (D-154): adding, replacing and removing a provider', () => {
	const store = storeOf(CONFIG);
	const added = withProvider(store, { ...inputOf(ADDED), id: 'openai', key: { mode: 'set', value: 'sk-test' } });
	assertEquals(added.providers.map((provider) => provider.id), ['local', 'openrouter', 'openai']);
	const replaced = withProvider(added, { ...inputOf(ADDED), label: 'OR' });
	assertEquals(replaced.providers.map((provider) => provider.label), ['Local Ollama', 'OR', 'OpenRouter']);
	const chosen = { ...replaced, default: 'openrouter' };
	assertEquals(withoutProvider(chosen, 'openrouter').default, null, 'a removed default is cleared');
	assertEquals(withoutProvider(chosen, 'openrouter').providers.map((provider) => provider.id), ['local', 'openai']);
	assertEquals(withoutProvider(chosen, 'local').default, 'openrouter', 'another default stands');
});

Deno.test('system agents (D-152): the host a kept key is bound to is scheme-defaulted host:port', () => {
	assertEquals(netHostOf('https://openrouter.ai/api/v1'), 'openrouter.ai:443');
	assertEquals(netHostOf('http://127.0.0.1:11434/v1'), '127.0.0.1:11434');
	assertEquals(netHostOf('http://example.test/v1'), 'example.test:80');
	assertEquals(netHostOf('not a url'), '');
});

Deno.test('system agents (D-152): models one per line or comma, headers name: value per line', () => {
	assertEquals(parseModels(' gpt-4.1 \n\ngpt-4.1, o3\n'), ['gpt-4.1', 'o3']);
	assertEquals(parseHeaders('OpenAI-Organization: org-1\n\nx-title:  Tyko '), {
		'openai-organization': 'org-1',
		'x-title': 'Tyko',
	});
	assertThrows(() => parseHeaders('no colon here'), Error, 'line 1');
});

Deno.test('system agents (D-154): a key is told by its source, never its value; a card by its initials', () => {
	assertEquals(keyWords({ source: 'file' }), 'Key in the providers file');
	assertEquals(keyWords({ source: 'inline' }), 'Key in the providers file');
	assertEquals(keyWords({ source: 'stored' }), 'Key encrypted in the database');
	assertEquals(keyWords({ source: 'none' }), 'No key');
	assertEquals(monogram('Local Ollama'), 'LO');
	assertEquals(monogram('openrouter'), 'OP');
	assertEquals(monogram(''), '?');
});

Deno.test('system agents (D-158): an agent row reads its default model and the protocols it is on', () => {
	const setting = { model: null, a2a: true, acp: false, a2ui: true, memory: true };
	const fallback = { default_model: { provider: 'local', model: 'm1' } };
	assertEquals(modelWords(setting, fallback), 'Default · local · m1');
	assertEquals(modelWords(setting, { default_model: null }), 'Providers’ default (none set)');
	assertEquals(modelWords({ ...setting, model: { provider: 'vllm', model: 'qwen' } }, fallback), 'vllm · qwen');
	const agent = (over: Partial<ManagedAgent>): ManagedAgent => ({
		id: 'builtin',
		name: 'Built-in model agent',
		description: '',
		kind: 'builtin',
		available: true,
		applies: { model: true, a2a: true, acp: false, a2ui: true, memory: true },
		settings: setting,
		...over,
	});
	assertEquals(protocolsOn(agent({})), ['A2A', 'A2UI']);
	// A switch that does not apply is never shown as on, whatever it holds.
	assertEquals(protocolsOn(agent({ settings: { ...setting, acp: true } })), ['A2A', 'A2UI']);
	assertEquals(protocolsOn(agent({ kind: 'peer', settings: null })), ['A2A']);
});
