/**
 * D-108: the coding sandbox's backend, as the sandbox's `/healthz` says it, in the admin diagnostics
 * (`config.sandboxBackend`) and in `capabilities.tykotech.sandbox` through the gateway's own MCP mount.
 */
import { assertEquals } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import { SandboxClient } from '@tykotech/sandbox';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const HEADERS = { host: '127.0.0.1:8787' };

async function gatewayWith(health: Record<string, unknown> | null) {
	const admin = await generateApiKey('admin', ['admin']);
	const coder = await generateApiKey('coder', ['mcp:invoke', 'sandbox:execute']);
	const watcher = await generateApiKey('watcher', ['mcp:invoke']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([admin.record, coder.record, watcher.record]),
	});
	const sandbox = health === null ? undefined : new SandboxClient({
		url: 'http://sandbox:8080',
		token: 'test-only-sandbox-service-token-0123456789',
		fetch: (() =>
			Promise.resolve(new Response(JSON.stringify(health), { status: health.ok ? 200 : 503 }))) as typeof fetch,
	});
	await sandbox?.ready();
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
		...(sandbox === undefined ? {} : { sandbox }),
	});
	const diagnostics = async () => {
		const response = await gateway.app.request(`${ORIGIN}/api/v1/system/diagnostics`, {
			headers: { ...HEADERS, authorization: `Bearer ${admin.key}` },
		});
		return (await response.json()).config as Record<string, unknown>;
	};
	const capabilities = async (key: string) => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: {
				...HEADERS,
				authorization: `Bearer ${key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'mcp-protocol-version': '2025-06-18',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
			}),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		const rpc = JSON.parse(line === undefined ? text : line.slice('data: '.length));
		return rpc.result.capabilities.tykotech as Record<string, unknown>;
	};
	return { gateway, diagnostics, capabilities, coder: coder.key, watcher: watcher.key };
}

Deno.test('D-108 gateway: diagnostics and capabilities name the sandbox backend its /healthz reported', async () => {
	const g = await gatewayWith({ ok: true, backend: 'docker' });
	try {
		assertEquals((await g.diagnostics()).sandboxBackend, 'docker');
		assertEquals((await g.capabilities(g.coder)).sandbox, { backend: 'docker' });
		// SEC-16: a caller who cannot run commands is not told how they would run.
		assertEquals((await g.capabilities(g.watcher)).sandbox, undefined);
	} finally {
		await g.gateway.close();
	}
});

Deno.test('D-108 gateway: no sandbox, or one that never said, reports no backend', async () => {
	for (const health of [null, { ok: true }]) {
		const g = await gatewayWith(health);
		try {
			assertEquals((await g.diagnostics()).sandboxBackend, null);
			assertEquals((await g.capabilities(g.coder)).sandbox, undefined);
		} finally {
			await g.gateway.close();
		}
	}
});
