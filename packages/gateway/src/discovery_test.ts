/**
 * The gateway's wiring of R14 (D-122) and R15 (D-123): the identity it hands the MCP factory, built from
 * `TTK_PUBLIC_URL` and never from the request's Host, and the `secretProvider` key of the admin diagnostics.
 */
import { assertEquals } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const HEADERS = { host: '127.0.0.1:8787' };

async function gatewayWith(env: Record<string, string>, secrets: Record<string, string> = {}) {
	const admin = await generateApiKey('admin', ['admin', 'mcp:invoke']);
	const keys = JSON.stringify([admin.record]);
	const config = loadConfig(
		{ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', ...env, ...(secrets.TTK_API_KEYS ? {} : { TTK_API_KEYS: keys }) },
		{ secrets: secrets.TTK_API_KEYS ? { ...secrets, TTK_API_KEYS: keys } : secrets },
	);
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'discovery-test',
		logger: createLogger({ level: 'error', write: (): void => {} }),
	});
	const diagnostics = async (): Promise<Record<string, unknown>> => {
		const response = await gateway.app.request(`${ORIGIN}/api/v1/system/diagnostics`, {
			headers: { ...HEADERS, authorization: `Bearer ${admin.key}` },
		});
		return (await response.json()).config as Record<string, unknown>;
	};
	const initialize = async (host: string): Promise<Record<string, unknown>> => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: {
				host,
				authorization: `Bearer ${admin.key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
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
		return JSON.parse(line === undefined ? text : line.slice('data: '.length)).result as Record<string, unknown>;
	};
	return {
		diagnostics,
		initialize,
		async [Symbol.asyncDispose]() {
			await gateway.close();
			await registry.shutdown();
		},
	};
}

Deno.test('R14 (D-122): the gateway reports its public URL as the website and serves the icon it names', async () => {
	await using g = await gatewayWith({
		TTK_PUBLIC_URL: 'https://mcp.example.test/base/',
		TTK_ALLOWED_HOSTS: '127.0.0.1,mcp.example.test',
	});
	const result = await g.initialize('127.0.0.1:8787');
	const info = result.serverInfo as Record<string, unknown>;
	assertEquals(info.title, 'Multi-MCP');
	assertEquals(info.websiteUrl, 'https://mcp.example.test', 'the origin of TTK_PUBLIC_URL, not the Host header');
	assertEquals(info.icons, [{
		src: 'https://mcp.example.test/assets/brand/icon-192.png',
		mimeType: 'image/png',
		sizes: ['192x192'],
	}]);
	assertEquals(typeof result.instructions, 'string');
	// A different Host header changes nothing a client is told to follow.
	const other = await g.initialize('mcp.example.test');
	assertEquals((other.serverInfo as Record<string, unknown>).websiteUrl, 'https://mcp.example.test');
});

Deno.test('B3: a public URL on a wildcard bind address advertises no website and no icon', async () => {
	// The container binds 0.0.0.0 and, with TTK_PUBLIC_URL unset, derives its public URL from the bind: a client told
	// to follow http://0.0.0.0:8787 is told nothing it can reach. Omitted, as on stdio, rather than wrong.
	const wildcards: Record<string, string>[] = [
		{ TTK_HOST: '0.0.0.0' },
		{ TTK_PUBLIC_URL: 'http://0.0.0.0:8787' },
		{ TTK_PUBLIC_URL: 'http://[::]:8787' },
		{ TTK_PUBLIC_URL: 'http://[0:0:0:0:0:0:0:0]:8787' },
	];
	for (const env of wildcards) {
		await using g = await gatewayWith(env);
		const info = (await g.initialize('127.0.0.1:8787')).serverInfo as Record<string, unknown>;
		assertEquals(info.title, 'Multi-MCP', JSON.stringify(env));
		assertEquals(info.websiteUrl, undefined, JSON.stringify(env));
		assertEquals(info.icons, undefined, JSON.stringify(env));
	}
});

Deno.test('R15 (D-123): the admin diagnostics name the secret provider, and null without one', async () => {
	{
		await using g = await gatewayWith({});
		assertEquals((await g.diagnostics()).secretProvider, null);
	}
	{
		// What `resolveSecrets` hands `loadConfig` after reading TTK_API_KEYS_REF from Vault.
		await using g = await gatewayWith({ TTK_API_KEYS_REF: 'vault:kv/ttk/keys#json' }, { TTK_API_KEYS: 'from-vault' });
		assertEquals((await g.diagnostics()).secretProvider, 'vault');
	}
	{
		await using g = await gatewayWith(
			{ TTK_API_KEYS_REF: 'vault:kv/ttk/keys#json', TTK_SECRETS_REF: 'op:vault/item#secrets' },
			{ TTK_API_KEYS: 'from-vault', TTK_SECRETS: '{}' },
		);
		assertEquals((await g.diagnostics()).secretProvider, 'vault, 1password');
	}
});
