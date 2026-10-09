/**
 * D-143 W2 (backend §2.2): the OpenAI-compatible client against the loopback fake — request and response mapping,
 * the credential and operator headers, `max_tokens_param`, the error classes (never a body), the single retry, the
 * refused redirect, the body cap, the per-call timeout and the key redactor.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
	ARGUMENTS_NOT_OBJECT,
	DEFAULT_MODEL_BOUNDS,
	type ModelClientSettings,
	type ModelMessage,
	ModelProviderError,
	type ModelTool,
	openAiClient,
	PROVIDER_BODY_LIMIT,
	PROVIDER_CALL_TIMEOUT_MS,
	PROVIDER_RETRY_DELAY_MS,
	REDACTED,
	TOOL_CALL_BOUND_MS,
} from '../../packages/agents/mod.ts';
import { type FakeProvider, startFakeProvider } from '../support/fake_provider.ts';

const KEY = 'sk-test-0123456789abcdef0123456789';
const never = (): AbortSignal => new AbortController().signal;

function settings(fake: FakeProvider, extra: Partial<ModelClientSettings> = {}): ModelClientSettings {
	return {
		id: 'oa',
		baseUrl: fake.url,
		models: ['m1', 'm2'],
		defaultModel: 'm1',
		apiKey: KEY,
		headers: { 'X-Operator': 'yes' },
		...extra,
	};
}

const TOOL: ModelTool = {
	name: 'sandbox_list',
	description: 'List workspaces',
	inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const TRANSCRIPT: ModelMessage[] = [
	{ role: 'system', text: 'be brief' },
	{ role: 'user', text: 'list them' },
	{ role: 'assistant', text: 'looking', toolCalls: [{ id: 'c1', name: 'sandbox_list', arguments: { a: 1 } }] },
	{ role: 'tool', results: [{ id: 'c1', text: 'ws-1', isError: false }] },
];

async function failure(
	fake: FakeProvider,
	turns: FakeProvider['script'],
	extra: Partial<ModelClientSettings> = {},
): Promise<ModelProviderError> {
	fake.script = turns;
	const client = openAiClient({ settings: settings(fake, extra), retryDelayMs: 0 });
	return await assertRejects(
		() => client.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never()),
		ModelProviderError,
	);
}

Deno.test('openai: the request carries the transcript, the tools, the key and the operator headers', async () => {
	const fake = startFakeProvider();
	try {
		fake.script = [{
			text: 'thinking',
			calls: [{ id: 'c2', name: 'sandbox_list', arguments: { b: 2 } }],
			usage: { input: 7, output: 3 },
		}];
		const client = openAiClient({ settings: settings(fake) });
		assertEquals([client.id, client.kind, client.models, client.defaultModel], ['oa', 'openai', ['m1', 'm2'], 'm1']);
		assertEquals(client.bounds, DEFAULT_MODEL_BOUNDS);
		const turn = await client.complete(
			{ model: 'm2', messages: TRANSCRIPT, tools: [TOOL], maxOutputTokens: 256 },
			never(),
		);
		assertEquals(turn, {
			text: 'thinking',
			toolCalls: [{ id: 'c2', name: 'sandbox_list', arguments: { b: 2 } }],
			stop: 'tool_use',
			usage: { input: 7, output: 3 },
		});
		assertEquals(fake.requests.length, 1);
		const request = fake.requests[0]!;
		assertEquals(request.path, '/v1/chat/completions');
		assertEquals(request.headers['authorization'], `Bearer ${KEY}`);
		assertEquals(request.headers['x-operator'], 'yes');
		assertEquals(request.headers['content-type'], 'application/json');
		assertEquals(request.body, {
			model: 'm2',
			messages: [
				{ role: 'system', content: 'be brief' },
				{ role: 'user', content: 'list them' },
				{
					role: 'assistant',
					content: 'looking',
					tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sandbox_list', arguments: '{"a":1}' } }],
				},
				{ role: 'tool', tool_call_id: 'c1', content: 'ws-1' },
			],
			tools: [{
				type: 'function',
				function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema },
			}],
			tool_choice: 'auto',
			max_tokens: 256,
			stream: false,
		});
	} finally {
		await fake.close();
	}
});

Deno.test('openai (E-120): a bare-origin base URL is served under /v1, as vLLM and llama.cpp serve it', async () => {
	const fake = startFakeProvider();
	try {
		fake.script = [{ text: 'ok' }];
		const client = openAiClient({ settings: settings(fake, { baseUrl: fake.origin }) });
		await client.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never());
		assertEquals(fake.requests.map((request) => request.path), ['/v1/chat/completions']);
	} finally {
		await fake.close();
	}
});

Deno.test('openai: max_tokens_param selects max_completion_tokens; a keyless provider sends no authorization header; no tools means no tools key', async () => {
	const fake = startFakeProvider();
	try {
		const client = openAiClient({
			settings: settings(fake, { apiKey: null, maxTokensParam: 'max_completion_tokens', headers: {} }),
		});
		const turn = await client.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 99 }, never());
		assertEquals(turn.stop, 'end');
		assertEquals(turn.text, 'done');
		const body = fake.requests[0]!.body;
		assertEquals(body.max_completion_tokens, 99);
		assertEquals('max_tokens' in body, false);
		assertEquals('tools' in body, false);
		assertEquals('tool_choice' in body, false);
		assertEquals('authorization' in fake.requests[0]!.headers, false);
		assertEquals(client.redact?.('nothing to hide'), 'nothing to hide');
	} finally {
		await fake.close();
	}
});

Deno.test('openai: finish_reason maps to the five stops, and calls under `stop` still mean tool_use', async () => {
	const fake = startFakeProvider();
	try {
		const client = openAiClient({ settings: settings(fake) });
		const complete = (): ReturnType<typeof client.complete> =>
			client.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never());
		fake.script = [
			{ text: 'a' },
			{ text: 'b', stop: 'length' },
			{ text: 'c', stop: 'refusal' },
			{ text: 'd', stop: 'other' },
			{ text: 'e', calls: [{ name: 'sandbox_list' }] },
		];
		assertEquals((await complete()).stop, 'end');
		assertEquals((await complete()).stop, 'length');
		assertEquals((await complete()).stop, 'refusal');
		assertEquals((await complete()).stop, 'other');
		assertEquals((await complete()).stop, 'tool_use');
		// A local server that says `stop` with calls attached: the calls are what counts.
		fake.script = [{
			raw: {
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					choices: [{
						message: {
							role: 'assistant',
							content: null,
							tool_calls: [{ id: 'x', type: 'function', function: { name: 't', arguments: '{}' } }],
						},
						finish_reason: 'stop',
					}],
				}),
			},
		}];
		const turn = await complete();
		assertEquals(turn.stop, 'tool_use');
		assertEquals(turn.text, '');
		assertEquals(turn.usage, { input: 0, output: 0 });
	} finally {
		await fake.close();
	}
});

Deno.test('openai: unparsable tool arguments become an argumentsError on the call, never a throw', async () => {
	const fake = startFakeProvider();
	try {
		const client = openAiClient({ settings: settings(fake) });
		fake.script = [{
			calls: [
				{ id: 'bad', name: 'sandbox_list', raw: '{not json' },
				{ id: 'list', name: 'sandbox_list', raw: '[1,2]' },
				{ id: 'ok', name: 'sandbox_list', raw: '' },
			],
		}];
		const turn = await client.complete(
			{ model: 'm1', messages: TRANSCRIPT, tools: [TOOL], maxOutputTokens: 16 },
			never(),
		);
		assertEquals(turn.toolCalls, [
			{ id: 'bad', name: 'sandbox_list', arguments: {}, argumentsError: ARGUMENTS_NOT_OBJECT },
			{ id: 'list', name: 'sandbox_list', arguments: {}, argumentsError: ARGUMENTS_NOT_OBJECT },
			{ id: 'ok', name: 'sandbox_list', arguments: {} },
		]);
	} finally {
		await fake.close();
	}
});

Deno.test('openai: a 4xx is reported by class, is not retried, and never carries the body that quotes the key', async () => {
	const fake = startFakeProvider();
	try {
		const error = await failure(fake, [{ status: 401, body: JSON.stringify({ error: `bad key ${KEY}` }) }]);
		assertEquals([error.kind, error.retryable, error.status], ['4xx', false, 401]);
		assertEquals(error.message.includes(KEY), false);
		assertEquals(JSON.stringify(error).includes(KEY), false);
		assertEquals(String(error.stack).includes(KEY), false);
		assertEquals(error.message, "Model provider answered 401: check the provider's key");
		assertEquals(fake.requests.length, 1, 'a 4xx is not retried');
		assertEquals(error.code, -32603);
	} finally {
		await fake.close();
	}
});

Deno.test('openai: 429 and 5xx are retried exactly once, after the retry delay', async () => {
	const fake = startFakeProvider();
	try {
		const twice = await failure(fake, [{ status: 503 }, { status: 503 }]);
		assertEquals([twice.kind, twice.retryable, twice.status, twice.message], [
			'5xx',
			true,
			503,
			'Model provider answered 503',
		]);
		assertEquals(fake.requests.length, 2, 'one retry, then the failure');
		fake.requests.length = 0;
		fake.script = [{ status: 429 }, { text: 'recovered' }];
		const client = openAiClient({ settings: settings(fake), retryDelayMs: 0 });
		const turn = await client.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never());
		assertEquals(turn.text, 'recovered');
		assertEquals(fake.requests.length, 2);
		fake.requests.length = 0;
		fake.script = [{ status: 500 }, { text: 'again' }];
		assertEquals(
			(await client.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never())).text,
			'again',
		);
		assertEquals(fake.requests.length, 2);
		// The production constants: 2 s before the retry; the per-call bound is the tool-call bound.
		assertEquals(PROVIDER_RETRY_DELAY_MS, 2_000);
		assertEquals(PROVIDER_CALL_TIMEOUT_MS, TOOL_CALL_BOUND_MS);
		// A cancel during the retry wait ends the call with the caller's own reason, not a provider error.
		fake.script = [{ status: 503 }, { text: 'never' }];
		const waiting = openAiClient({ settings: settings(fake), retryDelayMs: 60_000 });
		const controller = new AbortController();
		const call = waiting.complete(
			{ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 },
			controller.signal,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort(new Error('cancelled by test'));
		await assertRejects(() => call, Error, 'cancelled by test');
	} finally {
		await fake.close();
	}
});

Deno.test('openai: a redirect is refused and its target is never dialled', async () => {
	const fake = startFakeProvider();
	try {
		const error = await failure(fake, [{ status: 302, headers: { location: `${fake.origin}/elsewhere` } }]);
		assertEquals(error.kind, 'network');
		assertEquals(fake.requests.length, 1);
		assertEquals(fake.stray, [], 'the redirect target was not fetched');
	} finally {
		await fake.close();
	}
});

Deno.test('openai: a wrong content-type, an oversize body, a non-object answer and a shapeless answer are malformed', async () => {
	const fake = startFakeProvider();
	try {
		const html = await failure(fake, [{ raw: { headers: { 'content-type': 'text/html' }, body: '<html>' } }]);
		assertEquals(html.kind, 'malformed');
		// A well-formed answer padded one byte past the cap: read whole it would succeed, so only the cap refuses it.
		const answer = (pad: number): string =>
			JSON.stringify({
				choices: [{ message: { role: 'assistant', content: 'too big' }, finish_reason: 'stop' }],
				pad: 'p'.repeat(pad),
			});
		const probe = answer(0);
		const big = answer(PROVIDER_BODY_LIMIT + 1 - new TextEncoder().encode(probe).length);
		assertEquals(new TextEncoder().encode(big).length, PROVIDER_BODY_LIMIT + 1);
		const oversize = await failure(fake, [{ raw: { headers: { 'content-type': 'application/json' }, body: big } }]);
		assertEquals(oversize.kind, 'malformed');
		// Streamed with no content-length: only the incremental count can refuse it, one byte over the cap.
		const chunkedOversize = await failure(fake, [{
			raw: { headers: { 'content-type': 'application/json' }, body: big, chunked: true },
		}]);
		assertEquals(chunkedOversize.kind, 'malformed');
		// And a streamed body under the cap is read whole: the cap is the only thing the incremental read refuses.
		const padded = JSON.stringify({
			choices: [{ message: { role: 'assistant', content: 'streamed' }, finish_reason: 'stop' }],
			pad: 'p'.repeat(200 * 1024),
		});
		fake.script = [{ raw: { headers: { 'content-type': 'application/json' }, body: padded, chunked: true } }];
		const streamed = await openAiClient({ settings: settings(fake) }).complete(
			{ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 },
			never(),
		);
		assertEquals(streamed.text, 'streamed');
		const array = await failure(fake, [{ raw: { headers: { 'content-type': 'application/json' }, body: '[1]' } }]);
		assertEquals(array.kind, 'malformed');
		const noChoices = await failure(fake, [{
			raw: { headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
		}]);
		assertEquals(noChoices.kind, 'malformed');
		const notJson = await failure(fake, [{
			raw: { headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{oops' },
		}]);
		assertEquals(notJson.kind, 'malformed');
		assertEquals(notJson.message, 'Model provider answered with an unreadable response');
	} finally {
		await fake.close();
	}
});

Deno.test('openai: a stalled provider is a timeout at the per-call bound; a cancel is the caller’s own reason', async () => {
	const fake = startFakeProvider();
	try {
		fake.script = [{ stall: true }];
		const quick = openAiClient({ settings: settings(fake), callTimeoutMs: 100 });
		const timeout = await assertRejects(
			() => quick.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never()),
			ModelProviderError,
		);
		assertEquals([timeout.kind, timeout.retryable, timeout.message], [
			'timeout',
			false,
			'Model provider did not answer in time',
		]);
		assertEquals(fake.requests.length, 1);
		// The abort reached the fake: the connection was torn down, not left open until the fake answers.
		for (let i = 0; i < 100 && !fake.requests[0]!.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assertEquals(fake.requests[0]!.aborted, true);
		fake.script = [{ stall: true }];
		const controller = new AbortController();
		const client = openAiClient({ settings: settings(fake) });
		const call = client.complete(
			{ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 },
			controller.signal,
		);
		for (let i = 0; i < 100 && fake.requests.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort(new Error('task cancelled'));
		await assertRejects(() => call, Error, 'task cancelled');
	} finally {
		await fake.close();
	}
});

Deno.test('openai: an unreachable provider is a network failure, by class', async () => {
	const fake = startFakeProvider();
	const base = settings(fake);
	await fake.close();
	const client = openAiClient({ settings: base });
	const error = await assertRejects(
		() => client.complete({ model: 'm1', messages: TRANSCRIPT, tools: [], maxOutputTokens: 16 }, never()),
		ModelProviderError,
	);
	assertEquals([error.kind, error.retryable, error.message], ['network', false, 'Model provider could not be reached']);
});

Deno.test('openai: the client redacts its own key (≥16 chars) and leaves a short key alone (§3.12, gate F12)', () => {
	const fake = startFakeProvider();
	try {
		const client = openAiClient({ settings: settings(fake) });
		assert(client.redact !== undefined);
		assertEquals(client.redact(`Bearer ${KEY} and again ${KEY}.`), `Bearer ${REDACTED} and again ${REDACTED}.`);
		assertStringIncludes(client.redact(JSON.stringify({ authorization: `Bearer ${KEY}` })), REDACTED);
		const short = openAiClient({ settings: settings(fake, { apiKey: 'abc123' }) });
		assertEquals(
			short.redact?.('key abc123 here'),
			'key abc123 here',
			'a 6-char key is not redacted; the parser warns',
		);
	} finally {
		void fake.close();
	}
});
