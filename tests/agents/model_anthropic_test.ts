/**
 * D-143 W2 (backend §2.2): the Anthropic Messages client against the loopback fake — the `system` field, the
 * `tool_use`/`tool_result` blocks, `input_schema`, `max_tokens` whatever `max_tokens_param` says, the `x-api-key`
 * and `anthropic-version` headers, `stop_reason` mapping, non-object `input`, the retry and the malformed classes.
 */
import { assertEquals, assertRejects } from '@std/assert';
import {
	ANTHROPIC_VERSION,
	anthropicClient,
	ARGUMENTS_NOT_OBJECT,
	type ModelClientSettings,
	type ModelMessage,
	ModelProviderError,
	type ModelTool,
	REDACTED,
} from '../../packages/agents/mod.ts';
import { type FakeProvider, startFakeProvider } from '../support/fake_provider.ts';

const KEY = 'sk-ant-0123456789abcdef0123456789';
const never = (): AbortSignal => new AbortController().signal;

function settings(fake: FakeProvider, extra: Partial<ModelClientSettings> = {}): ModelClientSettings {
	return {
		id: 'an',
		baseUrl: fake.url,
		models: ['claude-a'],
		defaultModel: 'claude-a',
		apiKey: KEY,
		headers: { 'x-operator': 'yes' },
		maxSteps: 8,
		maxOutputTokens: 512,
		tokenBudget: 20_000,
		...extra,
	};
}

const TOOL: ModelTool = { name: 'page_read', description: 'Read a page', inputSchema: { type: 'object' } };
const TRANSCRIPT: ModelMessage[] = [
	{ role: 'system', text: 'be brief' },
	{ role: 'user', text: 'read it' },
	{ role: 'assistant', text: 'reading', toolCalls: [{ id: 'toolu_1', name: 'page_read', arguments: { url: 'x' } }] },
	{
		role: 'tool',
		results: [{ id: 'toolu_1', text: 'page text', isError: false }, { id: 'toolu_1b', text: 'nope', isError: true }],
	},
	{ role: 'assistant', text: '', toolCalls: [] },
];

Deno.test('anthropic (E-120): an SDK-style base URL without /v1 (MiniMax, DeepSeek) reaches /v1/messages', async () => {
	const fake = startFakeProvider();
	try {
		fake.script = [{ text: 'ok' }];
		const client = anthropicClient({ settings: settings(fake, { baseUrl: fake.origin }) });
		await client.complete({ model: 'claude-a', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never());
		assertEquals(fake.requests.map((request) => request.path), ['/v1/messages']);
	} finally {
		await fake.close();
	}
});

Deno.test('anthropic: the request carries system, tool blocks, input_schema, max_tokens, the key and the version', async () => {
	const fake = startFakeProvider();
	try {
		fake.script = [{
			text: 'found',
			calls: [{ id: 'toolu_2', name: 'page_read', arguments: { url: 'y' } }],
			usage: { input: 11, output: 4 },
		}];
		const client = anthropicClient({ settings: settings(fake, { maxTokensParam: 'max_completion_tokens' }) });
		assertEquals([client.id, client.kind], ['an', 'anthropic']);
		assertEquals(client.bounds, { maxSteps: 8, maxOutputTokens: 512, tokenBudget: 20_000 });
		const turn = await client.complete(
			{ model: 'claude-a', messages: TRANSCRIPT, tools: [TOOL], maxOutputTokens: 512 },
			never(),
		);
		assertEquals(turn, {
			text: 'found',
			toolCalls: [{ id: 'toolu_2', name: 'page_read', arguments: { url: 'y' } }],
			stop: 'tool_use',
			usage: { input: 11, output: 4 },
		});
		const request = fake.requests[0]!;
		assertEquals(request.path, '/v1/messages');
		assertEquals(request.headers['x-api-key'], KEY);
		assertEquals(request.headers['anthropic-version'], ANTHROPIC_VERSION);
		assertEquals(ANTHROPIC_VERSION, '2023-06-01');
		assertEquals(request.headers['x-operator'], 'yes');
		assertEquals('authorization' in request.headers, false);
		assertEquals(request.body, {
			model: 'claude-a',
			system: 'be brief',
			messages: [
				{ role: 'user', content: 'read it' },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'reading' },
						{ type: 'tool_use', id: 'toolu_1', name: 'page_read', input: { url: 'x' } },
					],
				},
				{
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'page text', is_error: false },
						{ type: 'tool_result', tool_use_id: 'toolu_1b', content: 'nope', is_error: true },
					],
				},
				// The empty assistant turn is not sent: the wire refuses empty content.
			],
			tools: [{ name: 'page_read', description: 'Read a page', input_schema: { type: 'object' } }],
			max_tokens: 512,
		});
		assertEquals('max_completion_tokens' in request.body, false, 'max_tokens_param is an OpenAI setting only');
	} finally {
		await fake.close();
	}
});

Deno.test('anthropic: stop_reason maps to the stops; a non-object input is an argumentsError; no key means no header', async () => {
	const fake = startFakeProvider();
	try {
		const client = anthropicClient({ settings: settings(fake, { apiKey: null, headers: {} }) });
		const complete = (): ReturnType<typeof client.complete> =>
			client.complete({ model: 'claude-a', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never());
		fake.script = [
			{ text: 'a' },
			{ text: 'b', stop: 'length' },
			{ text: 'c', stop: 'refusal' },
			{ text: 'd', stop: 'other' },
			{ calls: [{ name: 'page_read', raw: 'not an object' }, { name: 'page_read', raw: [1] }] },
		];
		assertEquals((await complete()).stop, 'end');
		assertEquals((await complete()).stop, 'length');
		assertEquals((await complete()).stop, 'refusal');
		assertEquals((await complete()).stop, 'other');
		const calls = await complete();
		assertEquals(calls.stop, 'tool_use');
		assertEquals(calls.toolCalls.map((call) => call.argumentsError), [ARGUMENTS_NOT_OBJECT, ARGUMENTS_NOT_OBJECT]);
		assertEquals('x-api-key' in fake.requests[0]!.headers, false);
		assertEquals(fake.requests[0]!.headers['anthropic-version'], ANTHROPIC_VERSION);
		assertEquals('system' in fake.requests[0]!.body, true);
		assertEquals('tools' in fake.requests[0]!.body, false);
	} finally {
		await fake.close();
	}
});

Deno.test('anthropic: 5xx is retried once and reported by class without the body; malformed answers are malformed', async () => {
	const fake = startFakeProvider();
	try {
		const client = anthropicClient({ settings: settings(fake), retryDelayMs: 0 });
		const complete = (): ReturnType<typeof client.complete> =>
			client.complete({ model: 'claude-a', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never());
		fake.script = [{ status: 529, body: `{"error":"overloaded ${KEY}"}` }, { status: 503 }];
		const error = await assertRejects(complete, ModelProviderError);
		assertEquals([error.kind, error.retryable, error.status], ['5xx', true, 503]);
		assertEquals(error.message.includes(KEY), false);
		assertEquals(fake.requests.length, 2);
		fake.script = [{ status: 503 }, { text: 'ok now' }];
		assertEquals((await complete()).text, 'ok now');
		fake.script = [{ status: 400, body: '{"type":"error"}' }];
		const bad = await assertRejects(complete, ModelProviderError);
		assertEquals([bad.kind, bad.retryable], ['4xx', false]);
		fake.script = [{ raw: { headers: { 'content-type': 'application/json' }, body: '{"content":"not an array"}' } }];
		assertEquals((await assertRejects(complete, ModelProviderError)).kind, 'malformed');
		fake.script = [{ raw: { headers: { 'content-type': 'text/plain' }, body: 'nope' } }];
		assertEquals((await assertRejects(complete, ModelProviderError)).kind, 'malformed');
		fake.script = [{ status: 302, headers: { location: `${fake.origin}/elsewhere` } }];
		assertEquals((await assertRejects(complete, ModelProviderError)).kind, 'network');
		assertEquals(fake.stray, []);
		assertEquals(client.redact?.(`x-api-key: ${KEY}`), `x-api-key: ${REDACTED}`);
	} finally {
		await fake.close();
	}
});
