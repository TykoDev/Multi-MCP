/**
 * D-082: private services watched while the server runs; their tools follow their health.
 */
import { assert, assertEquals } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import type { SandboxClient } from '@tykotech/sandbox';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { bridgeProbe, ServiceHealth } from './service_health.ts';

const ORIGIN = 'http://127.0.0.1:8787';

Deno.test('service health: transitions are logged and announced once each; probes never overlap', async () => {
	let up = false;
	let running = 0;
	let overlapped = false;
	const lines: string[] = [];
	const health = new ServiceHealth({
		sandbox: async () => {
			running += 1;
			if (running > 1) overlapped = true;
			await new Promise((resolve) => setTimeout(resolve, 5));
			running -= 1;
			return up;
		},
	}, { logger: createLogger({ level: 'info', write: (line) => lines.push(line) }) });
	const seen: unknown[] = [];
	health.onChange((states) => seen.push(states));
	assertEquals(health.states(), {});
	await health.probe();
	assertEquals(health.states(), { sandbox: false });
	await health.probe();
	assertEquals(seen, [{ sandbox: false }], 'no change, no announcement');
	up = true;
	await Promise.all([health.probe(), health.probe()]);
	assertEquals(overlapped, false);
	assertEquals(seen, [{ sandbox: false }, { sandbox: true }]);
	assert(lines.some((line) => line.includes('not reachable')) && lines.some((line) => line.includes('is reachable')));
	// A probe that throws counts as down.
	const failing = new ServiceHealth({ agents: () => Promise.reject(new Error('boom')) });
	await failing.probe();
	assertEquals(failing.states(), { agents: false });
	assertEquals(new ServiceHealth({}).watching, false);
});

Deno.test('service health: the bridge probe reads /healthz and treats anything else as down', async () => {
	const ok = bridgeProbe('http://runner:8080', () => Promise.resolve(new Response('{}')));
	const down = bridgeProbe('http://runner:8080', () => Promise.resolve(new Response('{}', { status: 503 })));
	const gone = bridgeProbe('http://runner:8080', () => Promise.reject(new TypeError('refused')));
	assertEquals([await ok(), await down(), await gone()], [true, false, false]);
});

Deno.test('service health: sandbox tools leave and return with the service, and calls say why (D-082)', async () => {
	const coder = await generateApiKey('coder', ['mcp:invoke', 'sandbox:execute']);
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_API_KEYS: JSON.stringify([coder.record]) });
	let up = false;
	const client = {
		ready: () => Promise.resolve(up),
		call: () => Promise.resolve({ workspaces: [] }),
	} as unknown as SandboxClient;
	const health = new ServiceHealth({ sandbox: () => client.ready() });
	await health.start();
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
		sandbox: client,
		health,
	});
	const rpc = async (method: string, params: unknown) => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${coder.key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		return JSON.parse(line === undefined ? text : line.slice('data: '.length));
	};
	const listed = async () =>
		(await rpc('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name).filter((name: string) =>
			name.startsWith('sandbox_')
		);
	try {
		// Down at start-up: no sandbox tool is listed, and a call is refused with the reason.
		assertEquals(await listed(), []);
		const refused = await rpc('tools/call', { name: 'sandbox_list', arguments: {} });
		assertEquals(refused.result.isError, true);
		assertEquals(refused.result.structuredContent.error.code, 'feature-unavailable');
		assert(String(refused.result.content[0].text).includes('not reachable right now'));

		// It comes up: the next probe brings the tools back without a restart.
		up = true;
		await health.probe();
		assert((await listed()).includes('sandbox_exec'));
		const ok = await rpc('tools/call', { name: 'sandbox_list', arguments: {} });
		assertEquals(ok.result.isError, undefined);

		// It goes down again: withheld again.
		up = false;
		await health.probe();
		assertEquals(await listed(), []);
	} finally {
		health.stop();
		await gateway.close();
	}
});
