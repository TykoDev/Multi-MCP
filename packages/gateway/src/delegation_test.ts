import { assert, assertEquals } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { generateApiKey, principalFromAuthInfo, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createGatewayApp } from './app.ts';
import { createLogger } from './logger.ts';
import { SessionRegistry } from '@tykotech/mcp';

Deno.test('delegation: exact parent identity, narrow scopes, key revocation, expiry and explicit cleanup', async (): Promise<void> => {
	const parent = await generateApiKey('parent', ['mcp:invoke', 'agent:invoke', 'sandbox:execute', 'admin', 'task']);
	const unrelated = await generateApiKey('other', ['mcp:invoke']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([parent.record, unrelated.record]) }),
		allowAnonymous: false,
	});
	// GW-1: a delegation names the credential its task was submitted under, not merely the owner.
	const { credential } = principalFromAuthInfo(await verifier.verifyAccessToken(parent.key));
	assertEquals(await verifier.delegateMcp('oauth:parent', new Set(['mcp:invoke']), credential), null);
	const delegated = await verifier.delegateMcp(
		'api-key:parent',
		new Set(['mcp:invoke', 'agent:invoke', 'sandbox:execute', 'admin', 'task', 'evaluate']),
		credential,
	);
	assert(delegated);
	assertEquals((await verifier.verifyAccessToken(delegated.token)).clientId, 'parent');
	assertEquals((await verifier.verifyAccessToken(delegated.token)).scopes, ['mcp:invoke', 'sandbox:execute']);
	verifier.replaceApiKeys([{ ...parent.record, scopes: ['mcp:invoke'] }, unrelated.record]);
	assertEquals([...(await verifier.resolve(delegated.token))!.scopes], ['mcp:invoke']);
	verifier.replaceApiKeys([unrelated.record]);
	assertEquals(await verifier.resolve(delegated.token), null);
	verifier.replaceApiKeys([parent.record, unrelated.record]);
	delegated.close();
	assertEquals(await verifier.resolve(delegated.token), null);
	using time = new FakeTime();
	const expiring = await verifier.delegateMcp('api-key:parent', new Set(['mcp:invoke']), credential);
	assert(expiring);
	time.tick(120_001);
	assertEquals(await verifier.resolve(expiring.token), null);
	verifier.closeDelegations();
});

Deno.test('delegation: a valid same-owner bearer cannot access other gateway APIs', async (): Promise<void> => {
	const parent = await generateApiKey('parent', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([parent.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const { credential } = principalFromAuthInfo(await verifier.verifyAccessToken(parent.key));
	const delegated = await verifier.delegateMcp('api-key:parent', new Set(['mcp:invoke']), credential);
	assert(delegated);
	const registry = new SessionRegistry();
	const gateway = createGatewayApp({
		config,
		verifier,
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: (): void => {} }),
	});
	try {
		const response = await gateway.app.request('http://127.0.0.1:8787/api/v1/agent/tasks', {
			// With a Host header: without one the front refuses the request (400 host-forbidden, F3) before the
			// delegation rule this test is about is ever reached.
			headers: { host: '127.0.0.1:8787', authorization: `Bearer ${delegated.token}` },
		});
		assertEquals(response.status, 403);
		assertEquals((await response.clone().json()).type, 'https://tykotech.eu/problems/forbidden-scope');
		await response.body?.cancel();
	} finally {
		delegated.close();
		await gateway.close();
		await registry.shutdown();
	}
});

// The runner's readiness is `bridgeProbe`'s, tested in service_health_test.ts (D-082); `readyExpansion` is removed.
Deno.test('delegation: a configured MCP callback host joins the Host ceiling and never the Origin allowlist', (): void => {
	const config = loadConfig({ TTK_AGENT_MCP_URL: 'http://callback:8787/mcp' });
	assert(config.allowedHosts.includes('callback'));
	assert(!config.allowedOrigins.includes('callback'));
	assertEquals(
		loadConfig({ TTK_AGENT_MCP_URL: 'http://callback:8787/mcp', TTK_ALLOWED_HOSTS: 'localhost' }).allowedHosts,
		['localhost'],
	);
});
