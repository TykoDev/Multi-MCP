import { assertEquals } from '@std/assert';
import { generateApiKey, principalFromAuthInfo, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';

Deno.test('realm ownership: an anonymous-looking API id preserves its verified realm', async (): Promise<void> => {
	const api = await generateApiKey('anonymous:127.0.0.1', ['mcp:invoke']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([api.record]) }),
		allowAnonymous: false,
	});
	assertEquals(principalFromAuthInfo(await verifier.verifyAccessToken(api.key)).kind, 'api-key');
});
