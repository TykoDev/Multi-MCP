import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { A2aPeerClient, AgentError, AgentRuntime } from '../../packages/agents/mod.ts';

Deno.test('outbound A2A is named-only, validates cards and never follows redirected or foreign endpoints', async (): Promise<void> => {
	let cardMode = 'correct';
	let sawVersion = '';
	let calls = 0;
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		async (request): Promise<Response> => {
			if (new URL(request.url).pathname === '/.well-known/agent-card.json') {
				if (cardMode === 'redirect') return Response.redirect('http://169.254.169.254/latest/meta-data/', 302);
				if (cardMode === 'large') return new Response(' '.repeat(256 * 1024 + 1));
				return Response.json({
					supportedInterfaces: [{
						url: cardMode === 'foreign' ? 'http://169.254.169.254/rpc' : `http://127.0.0.1:${server.addr.port}/a2a`,
						protocolBinding: 'JSONRPC',
						protocolVersion: cardMode === 'old' ? '0.3' : '1.0',
					}],
				});
			}
			calls++;
			sawVersion = request.headers.get('a2a-version') ?? '';
			const value = await request.json();
			return Response.json({
				jsonrpc: '2.0',
				id: value.id,
				result: value.method === 'SendMessage'
					? { task: { id: 'remote-1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [] } }
					: {},
			});
		},
	);
	const url = `http://127.0.0.1:${server.addr.port}`;
	const peer = new A2aPeerClient({ id: 'configured', url, token: 'fixture-key' });
	const message = { messageId: 'client-1', role: 'ROLE_USER' as const, parts: [{ text: 'hello' }] };
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		peers: [{ id: 'configured', url, token: 'fixture-key' }],
	});
	try {
		assertThrows(
			() => runtime.delegate('alice', new Set(['agent:invoke']), 'http://169.254.169.254/', message),
			AgentError,
			'not found',
		);
		assertEquals(runtime.peers(), [{ id: 'configured' }]);
		assertEquals((await peer.send(message, AbortSignal.timeout(2000))).task, {
			id: 'remote-1',
			status: { state: 'TASK_STATE_COMPLETED' },
			artifacts: [],
		});
		assertEquals(sawVersion, '1.0');
		assertEquals(calls, 1);
		for (cardMode of ['foreign', 'old', 'redirect', 'large']) {
			await assertRejects(() => peer.send(message, AbortSignal.timeout(2000)));
		}
		assertEquals(calls, 1);
		assertThrows(() => new A2aPeerClient({ id: 'bad', url: 'http://user:pass@localhost/' }), AgentError);
	} finally {
		await runtime.close();
		await server.shutdown();
	}
});

Deno.test('remote tasks are polled and cancellation is propagated to the configured peer', async (): Promise<void> => {
	let canceled = false;
	let signalCancel: () => void = (): void => {};
	const acknowledged = new Promise<void>((resolve) => signalCancel = resolve);
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		async (request): Promise<Response> => {
			if (new URL(request.url).pathname.includes('well-known')) {
				return Response.json({
					supportedInterfaces: [{
						url: `http://127.0.0.1:${server.addr.port}/a2a`,
						protocolBinding: 'JSONRPC',
						protocolVersion: '1.0',
					}],
				});
			}
			const value = await request.json();
			if (value.method === 'CancelTask') {
				canceled = true;
				signalCancel();
			}
			return Response.json({
				jsonrpc: '2.0',
				id: value.id,
				result: value.method === 'SendMessage'
					? { task: { id: 'remote-2', status: { state: 'TASK_STATE_WORKING' } } }
					: { id: 'remote-2', status: { state: canceled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING' } },
			});
		},
	);
	const peer = new A2aPeerClient({ id: 'fixed', url: `http://127.0.0.1:${server.addr.port}` });
	const controller = new AbortController();
	try {
		const pending = peer.send(
			{ messageId: 'client-2', role: 'ROLE_USER', parts: [{ text: 'work' }] },
			controller.signal,
		);
		const rejected = assertRejects(() => pending);
		await new Promise((resolve) => setTimeout(resolve, 40));
		controller.abort();
		await rejected;
		await acknowledged;
		assertEquals(canceled, true);
	} finally {
		await server.shutdown();
	}
});
