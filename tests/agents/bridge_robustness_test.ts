import { assert, assertEquals, assertRejects } from '@std/assert';
import {
	AcpCommand,
	AgentBridgeClient,
	AgentBridgeServer,
	AgentError,
	runAcpProxy,
} from '../../packages/agents/mod.ts';
import { fromFileUrl } from '@std/path';

const token = 'test-private-service-token-long-enough';
function command(): AcpCommand {
	return {
		id: 'fixture',
		executable: Deno.execPath(),
		args: ['run', '--no-config', fromFileUrl(new URL('./acp_robustness_fixture.ts', import.meta.url))],
		cwd: Deno.cwd(),
	};
}

/** A gate holds matching runner requests until opened, to make races deterministic. */
class Gate {
	#open = true;
	#waiters: (() => void)[] = [];
	held = 0;
	close(): void {
		this.#open = false;
	}
	open(): void {
		this.#open = true;
		for (const waiter of this.#waiters.splice(0)) waiter();
	}
	async pass(): Promise<void> {
		if (this.#open) return;
		this.held++;
		await new Promise<void>((resolve) => this.#waiters.push(resolve));
	}
}

interface Runner {
	bridge: AgentBridgeServer;
	url: string;
	close(): Promise<void>;
}
function runner(
	handle: (request: Request, bridge: AgentBridgeServer) => Promise<Response> = (request, bridge) =>
		bridge.fetch(request),
	timings: ConstructorParameters<typeof AgentBridgeServer>[2] = {},
): Runner {
	const bridge = new AgentBridgeServer([command()], token, timings);
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen(): void {} },
		(request): Promise<Response> => handle(request, bridge),
	);
	return {
		bridge,
		url: `http://127.0.0.1:${server.addr.port}`,
		async close(): Promise<void> {
			await bridge.close();
			await server.shutdown();
		},
	};
}
async function until(condition: () => boolean, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** An in-process editor: ndjson in, every proxy output line collected. */
function editor(url: string, promptTimeoutMs?: number) {
	const input = new TransformStream<Uint8Array, Uint8Array>();
	const writer = input.writable.getWriter();
	const messages: Record<string, unknown>[] = [];
	let partial = '';
	const output = new WritableStream<Uint8Array>({
		write(bytes): void {
			partial += new TextDecoder().decode(bytes);
			let index: number;
			while ((index = partial.indexOf('\n')) >= 0) {
				const line = partial.slice(0, index);
				partial = partial.slice(index + 1);
				if (line.trim()) messages.push(JSON.parse(line));
			}
		},
	});
	const proxy = runAcpProxy({ url, token, agent: 'fixture' }, input.readable, output, promptTimeoutMs);
	const outcome = proxy.then(() => 'resolved', () => 'rejected');
	const write = (value: Record<string, unknown>): Promise<void> =>
		writer.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`));
	const find = async (match: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
		await until(() => messages.some(match));
		return messages.find(match)!;
	};
	return {
		messages,
		outcome,
		write,
		find,
		response: (id: number): Promise<Record<string, unknown>> => find((value) => value.id === id),
		async request(id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
			await write({ id, method, params });
			return await find((value) => value.id === id);
		},
		async end(): Promise<string> {
			await writer.close().catch(() => {});
			writer.releaseLock();
			return await outcome;
		},
	};
}
type Editor = ReturnType<typeof editor>;
async function editorSession(proxy: Editor, id: number, cwd = Deno.cwd()): Promise<string> {
	const created = await proxy.request(id, 'session/new', { cwd, mcpServers: [] });
	assertEquals(created.error, undefined);
	return String((created.result as Record<string, unknown>).sessionId);
}
function updateText(proxy: Editor, sessionId: string): string | undefined {
	const update = proxy.messages.find((value) =>
		value.method === 'session/update' && (value.params as Record<string, unknown>).sessionId === sessionId
	);
	return (update?.params as { update: { content: { text: string } } } | undefined)?.update.content.text;
}

Deno.test('AG-2: refused, malformed or failed editor permission replies become denials and the proxy keeps serving', async (): Promise<void> => {
	let refuse = false;
	const service = runner(async (request, bridge) => {
		const response = await bridge.fetch(request);
		if (!refuse || new URL(request.url).pathname !== '/v1/permission') return response;
		// The decision lands, but the runner reports a refusal, as for a reply racing the 60 s expiry.
		await response.body?.cancel();
		return Response.json({ error: { code: -32602, message: 'Permission request is no longer pending' } }, {
			status: 400,
		});
	});
	const proxy = editor(service.url);
	try {
		assertEquals(
			(await proxy.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })).error,
			undefined,
		);
		const replies: [string, Record<string, unknown>, string][] = [
			['persistent grant', { result: { outcome: { outcome: 'selected', optionId: 'always' } } }, 'cancelled'],
			['malformed result', { result: {} }, 'cancelled'],
			['unknown option', { result: { outcome: { outcome: 'selected', optionId: 'missing' } } }, 'cancelled'],
			['editor error', { error: { code: -32603, message: 'Editor failed' } }, 'cancelled'],
			['refused forward', { result: { outcome: { outcome: 'selected', optionId: 'once' } } }, 'selected'],
		];
		let id = 10;
		for (const [label, reply, expected] of replies) {
			refuse = label === 'refused forward';
			const sessionId = await editorSession(proxy, ++id);
			const promptId = ++id;
			await proxy.write({
				id: promptId,
				method: 'session/prompt',
				params: { sessionId, prompt: [{ type: 'text', text: 'permission' }] },
			});
			const asked = await proxy.find((value) =>
				value.method === 'session/request_permission' &&
				(value.params as Record<string, unknown>).sessionId === sessionId
			);
			await proxy.write({ id: asked.id, ...reply });
			assertEquals((await proxy.response(promptId)).result, { stopReason: 'end_turn' }, label);
			await until(() => updateText(proxy, sessionId) !== undefined);
			assertEquals(JSON.parse(updateText(proxy, sessionId)!).outcome.outcome, expected, label);
		}
		assertEquals(await proxy.end(), 'resolved');
	} finally {
		await proxy.end();
		await service.close();
	}
});

Deno.test('AG-2: a request beyond 64 in flight is refused alone and the proxy keeps serving', async (): Promise<void> => {
	const gate = new Gate();
	const service = runner(async (request, bridge) => {
		if (new URL(request.url).pathname === '/v1/rpc') await gate.pass();
		return await bridge.fetch(request);
	});
	const proxy = editor(service.url);
	try {
		await proxy.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
		const sessionId = await editorSession(proxy, 2);
		gate.close();
		for (let id = 100; id < 164; id++) {
			await proxy.write({ id, method: 'session/prompt', params: { sessionId: 'missing', prompt: [] } });
		}
		await proxy.write({ id: 164, method: 'session/prompt', params: { sessionId: 'missing', prompt: [] } });
		const refused = await proxy.response(164);
		assertEquals((refused.error as Record<string, unknown>).message, 'ACP request limit reached');
		assertEquals(
			proxy.messages.some((value) => typeof value.id === 'number' && value.id >= 100 && value.id < 164),
			false,
		);
		gate.open();
		await until(() => proxy.messages.filter((value) => typeof value.id === 'number' && value.id >= 100).length === 65);
		const prompt = await proxy.request(200, 'session/prompt', {
			sessionId,
			prompt: [{ type: 'text', text: 'still here' }],
		});
		assertEquals(prompt.result, { stopReason: 'end_turn' });
		assertEquals(await proxy.end(), 'resolved');
	} finally {
		gate.open();
		await proxy.end();
		await service.close();
	}
});

Deno.test('AG-5: the proxy opens sessions in the runner workspace whatever cwd the editor names', async (): Promise<void> => {
	const service = runner();
	const proxy = editor(service.url);
	try {
		await proxy.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
		const elsewhere = Deno.build.os === 'windows' ? 'D:\\editor\\project' : '/home/editor/project';
		const sessionId = await editorSession(proxy, 2, elsewhere);
		const prompt = await proxy.request(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
		assertEquals(prompt.result, { stopReason: 'end_turn' });
		assertEquals(await proxy.end(), 'resolved');
	} finally {
		await proxy.end();
		await service.close();
	}
});

Deno.test('AG-4: the editor prompt deadline is its own, fails only that prompt and keeps the session', async (): Promise<void> => {
	const service = runner();
	const proxy = editor(service.url, 200);
	try {
		await proxy.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
		const sessionId = await editorSession(proxy, 2);
		const held = await proxy.request(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hold' }] });
		assertEquals((held.error as Record<string, unknown>).code, -32603);
		const next = await proxy.request(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'after' }] });
		assertEquals(next.result, { stopReason: 'end_turn' });
		assertEquals(await proxy.end(), 'resolved');
	} finally {
		await proxy.end();
		await service.close();
	}
	// The runner bounds what a caller may ask it to wait for.
	const direct = runner();
	const client = new AgentBridgeClient({ url: direct.url, token, agent: 'fixture' }, 'alice');
	try {
		await client.open();
		for (const timeoutMs of [0, 1.5, 3_600_001]) {
			await assertRejects(() => client.request('initialize', { protocolVersion: 1 }, undefined, timeoutMs), AgentError);
		}
		await client.request('initialize', { protocolVersion: 1 }, undefined, 5_000);
	} finally {
		await client.close();
		await direct.close();
	}
});

Deno.test('AG-4: the idle reaper spares attached consumers and in-flight turns, and still reaps the abandoned', async (): Promise<void> => {
	const service = runner(undefined, { idleMs: 150, reapIntervalMs: 25, heartbeatMs: 50 });
	const options = { url: service.url, token, agent: 'fixture' };
	const streaming = new AgentBridgeClient(options, 'streaming');
	const turning = new AgentBridgeClient(options, 'turning');
	const idle = new AgentBridgeClient(options, 'idle');
	const stop = new AbortController();
	// A raw caller, so its consumer can vanish without the client's orderly close.
	const raw = (path: string, connection?: string, init: RequestInit = {}): Promise<Response> =>
		fetch(`${service.url}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				'x-ttk-principal': 'vanished',
				...(connection ? { 'x-ttk-connection': connection } : {}),
			},
		});
	try {
		for (const client of [streaming, turning, idle]) await client.open();
		const opened = await raw('/v1/open', undefined, { method: 'POST', body: JSON.stringify({ agent: 'fixture' }) });
		const vanished = String((await opened.json()).connectionId);
		const consumed = (async (): Promise<void> => {
			for await (const _ of streaming.events(stop.signal)) { /* An attached, quiet consumer. */ }
		})().catch(() => {});
		await turning.request('initialize', { protocolVersion: 1 });
		const sessionId = String((await turning.request('session/new', { cwd: turning.cwd, mcpServers: [] })).sessionId);
		const turn = turning.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hold' }] });
		turn.catch(() => {});
		// A consumer that disappears without closing is noticed at the next keepalive write.
		const gone = new AbortController();
		const response = await raw('/v1/events', vanished, { signal: gone.signal });
		assertEquals(response.status, 200);
		gone.abort();
		await response.body?.cancel().catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 800));
		await streaming.request('initialize', { protocolVersion: 1 });
		await turning.request('session/cancel', { sessionId });
		assertEquals(await turn, { stopReason: 'cancelled' });
		await assertRejects(() => idle.request('initialize', { protocolVersion: 1 }), AgentError);
		const after = await raw('/v1/rpc', vanished, { method: 'POST', body: JSON.stringify({ method: 'initialize' }) });
		assertEquals(after.status, 404);
		await after.body?.cancel();
		stop.abort();
		await consumed;
	} finally {
		stop.abort();
		for (const client of [streaming, turning, idle]) await client.close().catch(() => {});
		await service.close();
	}
});

Deno.test('AG-6: close() racing open() waits for the runner and releases the connection it creates', async (): Promise<void> => {
	const gate = new Gate();
	const service = runner(async (request, bridge) => {
		if (new URL(request.url).pathname === '/v1/open') await gate.pass();
		return await bridge.fetch(request);
	});
	const options = { url: service.url, token, agent: 'fixture' };
	const racing = new AgentBridgeClient(options, 'alice');
	const later: AgentBridgeClient[] = [];
	try {
		gate.close();
		const opening = racing.open();
		const opened = opening.then(() => 'opened', (error) => error instanceof AgentError ? error.message : 'failed');
		await until(() => gate.held === 1);
		const closing = racing.close();
		gate.open();
		await closing;
		assertEquals(await opened, 'Bridge connection closed');
		await assertRejects(() => racing.request('initialize', { protocolVersion: 1 }), AgentError, 'unavailable');
		// All four of the owner's slots are free again, so nothing outlived the race.
		for (let index = 0; index < 4; index++) {
			const client = new AgentBridgeClient(options, 'alice');
			later.push(client);
			await client.open();
		}
	} finally {
		gate.open();
		for (const client of later) await client.close().catch(() => {});
		await service.close();
	}
});

Deno.test('AG-13: an open whose body finishes after runner shutdown began creates no connection', async (): Promise<void> => {
	let reading: () => void = (): void => {};
	const started = new Promise<void>((resolve) => reading = resolve);
	const service = runner((request, bridge) => {
		if (new URL(request.url).pathname !== '/v1/open') return bridge.fetch(request);
		// Signal once the runner has authenticated and begun reading the body.
		const body = request.body!.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller): void {
					reading();
					controller.enqueue(chunk);
				},
			}),
		);
		return bridge.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body }));
	});
	let send: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller): void {
			send = controller;
		},
	});
	try {
		const pending = fetch(`${service.url}/v1/open`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'x-ttk-principal': 'alice', 'content-type': 'application/json' },
			body,
		});
		send!.enqueue(new TextEncoder().encode('{"agent":'));
		await started;
		const shutdown = service.bridge.close();
		send!.enqueue(new TextEncoder().encode('"fixture"}'));
		send!.close();
		const response = await pending;
		const result = await response.json();
		await shutdown;
		assertEquals(response.status, 400);
		assertEquals(result.error.message, 'Runner is shutting down');
		assert(result.connectionId === undefined);
	} finally {
		await service.close();
	}
});
