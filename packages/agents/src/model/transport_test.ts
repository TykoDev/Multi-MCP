/** Where a provider call goes, and what a failed one says. */
import { assertEquals } from '@std/assert';
import { ModelProviderError, providerEndpoint } from './transport.ts';

Deno.test('anthropic adds /v1 unless the base URL already ends in it; openai adds it to a bare origin only', () => {
	const cases: Array<['openai' | 'anthropic', string, string]> = [
		['anthropic', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages'],
		['anthropic', 'https://api.minimax.io/anthropic/', 'https://api.minimax.io/anthropic/v1/messages'],
		['anthropic', 'https://gw.example/v1/acct/anthropic', 'https://gw.example/v1/acct/anthropic/v1/messages'],
		['openai', 'https://llm.example/', 'https://llm.example/v1/chat/completions'],
		['openai', 'http://127.0.0.1:8000', 'http://127.0.0.1:8000/v1/chat/completions'],
		['openai', 'https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
		[
			'openai',
			'https://generativelanguage.googleapis.com/v1beta/openai',
			'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
		],
	];
	for (const [kind, base, url] of cases) {
		assertEquals(providerEndpoint(kind, base, kind === 'openai' ? 'chat/completions' : 'messages'), url, base);
	}
});

Deno.test('a failed call names its status, and what to check for 404 and 401/403', () => {
	assertEquals(
		new ModelProviderError('4xx', false, 404).message,
		"Model provider answered 404: check the provider's base URL",
	);
	assertEquals(
		new ModelProviderError('4xx', false, 403).message,
		"Model provider answered 403: check the provider's key",
	);
	assertEquals(new ModelProviderError('5xx', true, 503).message, 'Model provider answered 503');
	assertEquals(new ModelProviderError('4xx', false).message, 'Model provider answered 4xx');
	assertEquals(new ModelProviderError('timeout', false).message, 'Model provider did not answer in time');
});
