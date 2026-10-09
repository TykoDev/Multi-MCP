import { assertEquals, assertRejects } from '@std/assert';
import {
	AcpCommand,
	AgentBridgeClient,
	AgentBridgeServer,
	AgentError,
	AgentRuntime,
	runAcpProxy,
} from '../../packages/agents/mod.ts';
import { fromFileUrl } from '@std/path';

const token = 'test-private-service-token-long-enough';
function command(): AcpCommand {
	return {
		id: 'fixture',
		executable: Deno.execPath(),
		args: ['run', '--no-config', fromFileUrl(new URL('./acp_fixture.ts', import.meta.url))],
		cwd: Deno.cwd(),
	};
}

Deno.test('private runner authenticates and owns connections; text task executes real ACP backend', async (): Promise<void> => {
	const bridge = new AgentBridgeServer([command()], token);
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		(request): Promise<Response> => bridge.fetch(request),
	);
	const url = `http://127.0.0.1:${server.addr.port}`;
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: { url, token, agent: 'fixture' },
	});
	const client = new AgentBridgeClient({ url, token, agent: 'fixture' }, 'alice');
	try {
		assertEquals((await fetch(`${url}/healthz`).then((r) => r.json())).ready, true);
		const denied = await fetch(`${url}/v1/open`, { method: 'POST', body: '{}' });
		assertEquals(denied.status, 401);
		await denied.body?.cancel();
		await client.open();
		await client.request('initialize', { protocolVersion: 1 });
		await assertRejects(() => client.request('session/new', { cwd: '/etc', mcpServers: [] }), AgentError);
		await assertRejects(
			() => client.permission('not-pending', { outcome: { outcome: 'selected', optionId: 'once' } }),
			AgentError,
		);
		const wrong = await fetch(`${url}/v1/rpc`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'x-ttk-principal': 'bob', 'x-ttk-connection': 'foreign' },
			body: '{}',
		});
		assertEquals(wrong.status, 404);
		await wrong.body?.cancel();
		const task = runtime.submit('alice', new Set(['agent:invoke']), {
			messageId: 'prompt-1',
			role: 'ROLE_USER',
			parts: [{ text: 'hello' }],
		});
		const events = runtime.subscribe('alice', task.id).getReader();
		try {
			while (true) {
				const next = await events.read();
				if (next.done) break;
			}
		} finally {
			events.releaseLock();
		}
		const result = runtime.get('alice', task.id);
		assertEquals(result.status.state, 'TASK_STATE_COMPLETED');
		assertEquals(result.artifacts[0]?.parts, [{ text: 'fixture processed: hello' }]);
	} finally {
		await runtime.close();
		await client.close();
		await bridge.close();
		await server.shutdown();
	}
});

Deno.test('ACP task permission lifecycle is owner-scoped, once-only and rejects replay', async (): Promise<void> => {
	const bridge = new AgentBridgeServer([command()], token);
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		(request): Promise<Response> => bridge.fetch(request),
	);
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: { url: `http://127.0.0.1:${server.addr.port}`, token, agent: 'fixture' },
	});
	try {
		const task = runtime.submit('alice', new Set(['agent:invoke']), {
			messageId: 'prompt-2',
			role: 'ROLE_USER',
			parts: [{ text: 'permission' }],
		});
		const reader = runtime.subscribe('alice', task.id).getReader();
		try {
			while (runtime.get('alice', task.id).status.state !== 'TASK_STATE_INPUT_REQUIRED') await reader.read();
			const pending = runtime.permission('alice', task.id)!;
			const permissionId = String(pending.id);
			await assertRejects(
				() => runtime.decidePermission('bob', task.id, permissionId, 'once'),
				AgentError,
				'not found',
			);
			await assertRejects(
				() => runtime.decidePermission('alice', task.id, permissionId, 'always'),
				AgentError,
				'not allowed',
			);
			await runtime.decidePermission('alice', task.id, permissionId, 'once');
			await assertRejects(
				() => runtime.decidePermission('alice', task.id, permissionId, 'once'),
				AgentError,
				'not pending',
			);
			while (true) {
				const next = await reader.read();
				if (next.done) break;
			}
			assertEquals(runtime.get('alice', task.id).status.state, 'TASK_STATE_COMPLETED');
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
	} finally {
		await runtime.close();
		await bridge.close();
		await server.shutdown();
	}
});

Deno.test('text task delegation keeps the originating principal/scopes and revokes its session capability', async (): Promise<void> => {
	const allowed = { type: 'http', name: 'gateway', url: 'http://gateway:8787/mcp' };
	const scoped = {
		...allowed,
		headers: [{ name: 'Authorization', value: 'Bearer delegated-owner-token-with-enough-entropy' }],
	};
	const bridge = new AgentBridgeServer([{ ...command(), mcpServers: [allowed] }], token);
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		(request): Promise<Response> => bridge.fetch(request),
	);
	let delegatedOwner = '';
	let delegatedScopes: string[] = [];
	let revoked = false;
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: { url: `http://127.0.0.1:${server.addr.port}`, token, agent: 'fixture' },
		sessionMcp: (owner, scopes) => {
			delegatedOwner = owner;
			delegatedScopes = [...scopes];
			return {
				servers: [scoped],
				close(): void {
					revoked = true;
				},
			};
		},
	});
	try {
		const scopes = new Set(['agent:invoke', 'mcp:invoke', 'sandbox:execute']);
		const task = runtime.submit('alice', scopes, {
			messageId: 'delegated-prompt',
			role: 'ROLE_USER',
			parts: [{ text: 'echo_credentials' }],
		});
		const reader = runtime.subscribe('alice', task.id).getReader();
		try {
			while (true) if ((await reader.read()).done) break;
		} finally {
			reader.releaseLock();
		}
		assertEquals(delegatedOwner, 'alice');
		assertEquals(delegatedScopes, [...scopes]);
		assertEquals(revoked, true);
		assertEquals(runtime.get('alice', task.id).status.state, 'TASK_STATE_COMPLETED');
		assertEquals(
			JSON.stringify(runtime.get('alice', task.id)).includes('delegated-owner-token-with-enough-entropy'),
			false,
		);
	} finally {
		await runtime.close();
		await bridge.close();
		await server.shutdown();
	}
});

Deno.test('standard ACP stdio proxy forwards real session updates and shuts down at editor EOF', async (): Promise<void> => {
	const bridge = new AgentBridgeServer([command()], token);
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		(request): Promise<Response> => bridge.fetch(request),
	);
	const input = new TransformStream<Uint8Array, Uint8Array>();
	const inputWriter = input.writable.getWriter();
	const replies: Record<string, unknown>[] = [];
	let wake: () => void = (): void => {};
	const output = new WritableStream<Uint8Array>({
		write(bytes): void {
			replies.push(JSON.parse(new TextDecoder().decode(bytes)));
			wake();
		},
	});
	const proxy = runAcpProxy(
		{ url: `http://127.0.0.1:${server.addr.port}`, token, agent: 'fixture' },
		input.readable,
		output,
	);
	const send = (id: number, method: string, params: Record<string, unknown>): Promise<void> =>
		inputWriter.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`));
	const response = async (id: number): Promise<Record<string, unknown>> => {
		while (!replies.some((value) => value.id === id)) await new Promise<void>((resolve) => wake = resolve);
		return replies.find((value) => value.id === id)!;
	};
	try {
		await send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
		assertEquals((await response(1)).error, undefined);
		await send(2, 'session/new', { cwd: Deno.cwd(), mcpServers: [] });
		const sessionId = String(((await response(2)).result as Record<string, unknown>).sessionId);
		await send(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'editor prompt' }] });
		assertEquals((await response(3)).result, { stopReason: 'end_turn' });
		assertEquals(replies.some((value) => value.method === 'session/update'), true);
		await inputWriter.close();
		await proxy;
	} finally {
		inputWriter.releaseLock();
		await bridge.close();
		await server.shutdown();
	}
});

Deno.test('A12 / AC19: the editor proxy forwards the agent’s capabilities and relays session/load only when advertised', async () => {
	for (const advertised of [true, false]) {
		const agent = advertised ? command() : { ...command(), args: [...command().args, '--no-load-session'] };
		const bridge = new AgentBridgeServer([agent], token);
		const server = Deno.serve(
			{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
			(request): Promise<Response> => bridge.fetch(request),
		);
		const input = new TransformStream<Uint8Array, Uint8Array>();
		const inputWriter = input.writable.getWriter();
		const replies: Record<string, unknown>[] = [];
		let wake: () => void = (): void => {};
		let partial = '';
		const output = new WritableStream<Uint8Array>({
			write(bytes): void {
				partial += new TextDecoder().decode(bytes);
				let index: number;
				while ((index = partial.indexOf('\n')) >= 0) {
					replies.push(JSON.parse(partial.slice(0, index)));
					partial = partial.slice(index + 1);
				}
				wake();
			},
		});
		const proxy = runAcpProxy(
			{ url: `http://127.0.0.1:${server.addr.port}`, token, agent: 'fixture' },
			input.readable,
			output,
		);
		const send = (id: number, method: string, params: Record<string, unknown>): Promise<void> =>
			inputWriter.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`));
		const response = async (id: number): Promise<Record<string, unknown>> => {
			while (!replies.some((value) => value.id === id)) await new Promise<void>((resolve) => wake = resolve);
			return replies.find((value) => value.id === id)!;
		};
		try {
			await send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
			const capabilities = ((await response(1)).result as Record<string, unknown>).agentCapabilities;
			assertEquals(capabilities, {
				loadSession: advertised,
				promptCapabilities: { image: advertised, audio: false, embeddedContext: advertised },
				// No static editor MCP credentials, whatever the agent supports (it advertises http: true).
				mcpCapabilities: { http: false, sse: false },
			});
			// The editor's cwd is a path on the editor's machine; the proxy substitutes the runner's.
			await send(2, 'session/load', { sessionId: 'earlier-session', cwd: '/editor/project', mcpServers: [] });
			const loaded = await response(2);
			if (advertised) {
				assertEquals(loaded.error, undefined, JSON.stringify(loaded));
				const replay = replies.find((value) => value.method === 'session/update');
				const update = (replay?.params as { update: { content: { text: string } } } | undefined)?.update;
				assertEquals(update?.content.text, 'replayed earlier-session');
				await send(3, 'session/prompt', { sessionId: 'earlier-session', prompt: [{ type: 'text', text: 'go on' }] });
				assertEquals((await response(3)).result, { stopReason: 'end_turn' });
			} else assertEquals((loaded.error as { code: number }).code, -32601);
			await send(4, 'session/load', {
				sessionId: 'earlier-session',
				cwd: '/editor/project',
				mcpServers: [{ type: 'http', name: 'x', url: 'http://x/mcp', headers: [] }],
			});
			assertEquals(((await response(4)).error as { code: number }).code, advertised ? -32602 : -32601);
			await inputWriter.close();
			await proxy;
		} finally {
			inputWriter.releaseLock();
			await bridge.close();
			await server.shutdown();
		}
	}
});
