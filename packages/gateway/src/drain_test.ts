/**
 * F5 (BACKEND §7 stage 1): draining refuses new sessions, tickets and live-view sockets; health keeps answering.
 */
import { assertEquals, assertRejects } from '@std/assert';
import { SessionRegistry, ToolError } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

Deno.test('drain: new work is refused with 503 and Retry-After, health still answers', async () => {
	const key = await generateApiKey('k', ['mcp:invoke', 'view:control']);
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_API_KEYS: JSON.stringify([key.record]) });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error' }),
	});
	const headers = { host: '127.0.0.1:8787', authorization: `Bearer ${key.key}`, 'content-type': 'application/json' };
	try {
		gateway.drain();
		for (const path of ['/api/v1/live/ticket', '/api/v1/sessions']) {
			const response = await gateway.app.request(`http://127.0.0.1:8787${path}`, {
				method: 'POST',
				headers,
				body: '{}',
			});
			assertEquals(response.status, 503, path);
			assertEquals(response.headers.get('retry-after'), '5');
			assertEquals((await response.json()).type, 'https://tykotech.eu/problems/service-unavailable');
		}
		const socket = await gateway.app.request('http://127.0.0.1:8787/live/default/ws?ticket=x', {
			headers: { host: '127.0.0.1:8787', upgrade: 'websocket' },
		});
		assertEquals(socket.status, 503);
		await socket.body?.cancel();
		const health = await gateway.app.request('http://127.0.0.1:8787/healthz', { headers: { host: '127.0.0.1:8787' } });
		assertEquals(health.status, 200);
		await health.body?.cancel();
		// The registry refuses to launch anything new, whichever surface asks.
		await assertRejects(() => registry.createNew(), ToolError, 'shutting down');
		await assertRejects(() => registry.resolve(), ToolError, 'shutting down');
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});
