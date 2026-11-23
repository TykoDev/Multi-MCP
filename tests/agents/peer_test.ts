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
						protocolVersion: cardMode === 'v0.3' ? '0.3' : '1.0',
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
		for (cardMode of ['foreign', 'v0.3', 'redirect', 'large']) {
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

/** A peer that answers every SendMessage at once and records what it was sent. */
function recordingPeer(): { url: string; sent: Record<string, unknown>[]; close(): Promise<void> } {
	const sent: Record<string, unknown>[] = [];
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		async (request): Promise<Response> => {
			if (new URL(request.url).pathname === '/.well-known/agent-card.json') {
				return Response.json({
					supportedInterfaces: [{
						url: `http://127.0.0.1:${server.addr.port}/a2a`,
						protocolBinding: 'JSONRPC',
						protocolVersion: '1.0',
					}],
				});
			}
			const value = await request.json();
			if (value.method === 'SendMessage') sent.push(value.params.message);
			return Response.json({
				jsonrpc: '2.0',
				id: value.id,
				result: { task: { id: 'remote-1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [] } },
			});
		},
	);
	return { url: `http://127.0.0.1:${server.addr.port}`, sent, close: () => server.shutdown() };
}

async function settled(runtime: AgentRuntime, owner: string, id: string): Promise<Record<string, unknown>> {
	for (let i = 0; i < 200; i++) {
		const task = runtime.get(owner, id);
		if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.status.state)) return task;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('the task never finished');
}

const toolPart = (tool: string, args: Record<string, unknown> = {}) => ({
	messageId: crypto.randomUUID(),
	role: 'ROLE_USER' as const,
	parts: [{ data: { tool, arguments: args } }],
});

Deno.test('delegation: a data part is refused unless the caller could run it here and it touches no shared peer state', async (): Promise<void> => {
	const peer = recordingPeer();
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		peers: [{ id: 'peer', url: peer.url, token: 'fixture-key' }],
		// This deployment's catalog: every tool below exists, and needs only mcp:invoke.
		delegableTool: (_tool, scopes) => scopes.has('mcp:invoke'),
	});
	const full = new Set(['agent:invoke', 'mcp:invoke']);
	try {
		// (a) agent:invoke alone never runs a tool on the peer.
		assertThrows(
			() =>
				runtime.delegate('alice', new Set(['agent:invoke']), 'peer', toolPart('browser_head', { url: 'https://a' })),
			AgentError,
			'mcp:invoke',
		);
		// (b) every owner is one principal on the peer: what reads or changes its shared state is refused.
		for (
			const tool of [
				'agent_list_tasks',
				'agent_get_task',
				'agent_cancel_task',
				'browser_list_sessions',
				'browser_get_state',
				'browser_navigate',
				'sandbox_list',
				'memory_search',
				'agent_delegate',
				'agent_run_tool',
			]
		) {
			assertThrows(() => runtime.delegate('alice', full, 'peer', toolPart(tool)), AgentError, 'cannot be delegated');
		}
		assertThrows(
			() => runtime.delegate('alice', full, 'peer', toolPart('browser_health', { session_id: 'default-01' })),
			AgentError,
			'session_id',
		);
		assertEquals(runtime.list('alice'), []);
		// A delegable tool the caller may run here goes to the peer as it was given.
		const task = runtime.delegate('alice', full, 'peer', toolPart('browser_head', { url: 'https://jsr.io/' }));
		assertEquals(
			((await settled(runtime, 'alice', task.id)).status as { state: string }).state,
			'TASK_STATE_COMPLETED',
		);
		assertEquals(peer.sent.map((message) => message.parts), [[{
			data: { tool: 'browser_head', arguments: { url: 'https://jsr.io/' } },
		}]]);
		// Text still reaches the peer's agent (the documented residual: it acts as the one peer principal).
		const text = runtime.delegate('alice', new Set(['agent:invoke']), 'peer', {
			messageId: crypto.randomUUID(),
			role: 'ROLE_USER',
			parts: [{ text: 'hello' }],
		});
		assertEquals(
			((await settled(runtime, 'alice', text.id)).status as { state: string }).state,
			'TASK_STATE_COMPLETED',
		);
		assertEquals(peer.sent.length, 2);
	} finally {
		await runtime.close();
		await peer.close();
	}
});

Deno.test('delegation: a tool unknown here, or no catalog at all, is refused; scopes are judged again when it runs', async (): Promise<void> => {
	const peer = recordingPeer();
	let narrowed = false;
	const full = new Set(['agent:invoke', 'mcp:invoke']);
	const catalog = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		peers: [{ id: 'peer', url: peer.url }],
		delegableTool: (tool, scopes) => tool === 'browser_head' && scopes.has('mcp:invoke'),
		// The credential loses mcp:invoke after the delegation is accepted.
		authorize: (_owner, scopes) => narrowed ? new Set([...scopes].filter((scope) => scope !== 'mcp:invoke')) : scopes,
	});
	const bare = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		peers: [{ id: 'peer', url: peer.url }],
	});
	try {
		assertThrows(() => catalog.delegate('alice', full, 'peer', toolPart('browser_health')), AgentError, 'cannot call');
		// Fail closed: without a way to judge the tool locally, no data part is delegated.
		assertThrows(() => bare.delegate('alice', full, 'peer', toolPart('browser_head')), AgentError, 'cannot call');
		const task = catalog.delegate('alice', full, 'peer', toolPart('browser_head', { url: 'https://jsr.io/' }));
		narrowed = true;
		const done = await settled(catalog, 'alice', task.id);
		assertEquals((done.status as { state: string }).state, 'TASK_STATE_FAILED');
		assertEquals(peer.sent, []);
	} finally {
		await catalog.close();
		await bare.close();
		await peer.close();
	}
});
