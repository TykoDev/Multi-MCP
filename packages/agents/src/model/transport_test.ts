/** ERRATUM(E-120): where a provider call goes, and what a failed one says. */
import { assertEquals } from '@std/assert';
import { ModelProviderError, providerEndpoint } from './transport.ts';

Deno.test('E-120: anthropic adds /v1 unless the base URL already ends in it (SDK-style and versioned both work)', () => {
	const cases: Array<[string, string]> = [
		['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages'],
		['https://api.minimax.io/anthropic', 'https://api.minimax.io/anthropic/v1/messages'],
		['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
		['https://gw.example/v1/acct/anthropic', 'https://gw.example/v1/acct/anthropic/v1/messages'],
		['https://api.minimax.io/anthropic/', 'https://api.minimax.io/anthropic/v1/messages'],
	];
	for (const [base, url] of cases) assertEquals(providerEndpoint('anthropic', base, 'messages'), url, base);
});

Deno.test('E-120: openai adds /v1 to a bare origin only; any path is kept as written', () => {
	const cases: Array<[string, string]> = [
		['https://llm.example', 'https://llm.example/v1/chat/completions'],
		['https://llm.example/', 'https://llm.example/v1/chat/completions'],
		['http://127.0.0.1:8000', 'http://127.0.0.1:8000/v1/chat/completions'],
		['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
		['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
		[
			'https://generativelanguage.googleapis.com/v1beta/openai',
			'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
		],
	];
	for (const [base, url] of cases) assertEquals(providerEndpoint('openai', base, 'chat/completions'), url, base);
	assertEquals(providerEndpoint('openai', 'https://llm.example', 'embeddings'), 'https://llm.example/v1/embeddings');
});

Deno.test('E-120: a failed call names its status, and what to check for 404 and 401/403', () => {
	assertEquals(
		new ModelProviderError('4xx', false, 404).message,
		"Model provider answered 404: check the provider's base URL",
	);
	assertEquals(
		new ModelProviderError('4xx', false, 401).message,
		"Model provider answered 401: check the provider's key",
	);
	assertEquals(
		new ModelProviderError('4xx', false, 403).message,
		"Model provider answered 403: check the provider's key",
	);
	assertEquals(new ModelProviderError('4xx', false, 400).message, 'Model provider answered 400');
	assertEquals(new ModelProviderError('5xx', true, 503).message, 'Model provider answered 503');
	assertEquals(new ModelProviderError('4xx', false).message, 'Model provider answered 4xx');
	assertEquals(new ModelProviderError('timeout', false).message, 'Model provider did not answer in time');
});
