/**
 * The A2A surface the gateway mounts (D-104 – D-107): guarded event streams (A6, AC13), the card, the extended card
 * and the HTTP+JSON binding (A11, AC18), the push gate (N1), and durable agent state wired to the data directory (B1).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Hono } from 'hono';
import { AgentRuntime } from '@tykotech/agents';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { SessionRegistry } from '@tykotech/mcp';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { A2A_STREAM_ENDED, A2uiStore, StreamGuard } from './a2ui.ts';
import { type AppVariables, createGatewayApp } from './app.ts';
import { generateApiKey, type Principal, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import {
	AGENT_STATE_DIR,
	attachExpansionRoutes,
	createExpansionServices,
	type ExpansionServices,
	pushGrantProven,
} from './expansion.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const quiet = (): ReturnType<typeof createLogger> => createLogger({ level: 'error', write: (): void => {} });

/** Reads a stream until it ends or `ms` passes. */
async function drain(body: ReadableStream<Uint8Array>, ms = 2_000): Promise<{ text: string; ended: boolean }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + ms;
	let text = '';
	try {
		while (Date.now() < deadline) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const next = await Promise.race([
				reader.read(),
				new Promise<'timeout'>((resolve) => timer = setTimeout(() => resolve('timeout'), deadline - Date.now())),
			]);
			clearTimeout(timer);
			if (next === 'timeout') break;
			if (next.done) return { text, ended: true };
			text += decoder.decode(next.value, { stream: true });
		}
		return { text, ended: false };
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** The SSE `data:` payloads of a stream's text, parsed. */
function events(text: string): Record<string, unknown>[] {
	return text.split('\n\n').filter((frame) => frame.startsWith('data: ')).map((frame) => JSON.parse(frame.slice(6)));
}

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'a2a-binding-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

/** A registry whose first browser launch waits for the test, so a tool-calling task stays running. */
function blockedRegistry(): { registry: SessionRegistry; release(): void } {
	let release: () => void = (): void => {};
	const launched = new Promise<BrowserSession>((resolve) => release = () => resolve(fakeSession()));
	return { registry: new SessionRegistry({ reapIntervalMs: 0, launch: () => launched }), release: () => release() };
}

const message = (tool = 'browser_list_sessions'): Record<string, unknown> => ({
	messageId: crypto.randomUUID(),
	role: 'ROLE_USER',
	parts: [{ data: { tool, arguments: {} } }],
});

// --- A6: guarded A2A streams (AC13) ----------------------------------------------------------------------------

function principalApp(principal: Principal): Hono<{ Variables: AppVariables }> {
	const app = new Hono<{ Variables: AppVariables }>();
	app.use('*', async (ctx, next) => {
		ctx.set('requestId', 'a6');
		ctx.set('principal', principal);
		await next();
	});
	return app;
}

const viewer: Principal = { kind: 'api-key', id: 'viewer', scopes: new Set(['agent:invoke', 'mcp:invoke']) };

function harness(streams: StreamGuard): { app: Hono<{ Variables: AppVariables }>; services: ExpansionServices } & {
	authorized: { value: boolean };
} {
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, _owner, _scopes, signal): Promise<Record<string, unknown>> =>
			new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true })),
	});
	const services: ExpansionServices = {
		runtime,
		surfaces: new A2uiStore(),
		tools: [],
		streams,
		publish: () => ({}),
		// D-143 (S0): the members a hand-built services object needs beyond what these streams exercise.
		taskableTools: () => [],
		actionNames: ['cancelTask', 'permissionDecision'],
		acp: false,
		modelProviders: { default: null, providers: [] },
		close: async (): Promise<void> => {
			streams.closeAll();
			await services.surfaces.close();
			await runtime.close();
		},
	};
	const authorized = { value: true };
	const app = principalApp(viewer);
	attachExpansionRoutes(app, services, 'http://127.0.0.1:8787', () => authorized.value);
	return { app, services, authorized };
}

function rpcBody(id: number, method: string, params: Record<string, unknown>): RequestInit {
	return {
		method: 'POST',
		headers: { 'a2a-version': '1.0', 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
	};
}

Deno.test('A6 / AC13: an A2A stream whose caller stops being authorized ends with a terminal JSON-RPC error', async () => {
	const { app, services, authorized } = harness(new StreamGuard({ revalidateMs: 10 }));
	try {
		const response = await app.request('/a2a', rpcBody(9, 'SendStreamingMessage', { message: message() }));
		assertEquals(response.headers.get('content-type'), 'text/event-stream');
		const reader = response.body!.getReader();
		assertStringIncludes(new TextDecoder().decode((await reader.read()).value), '"task"');
		reader.releaseLock();
		authorized.value = false;
		const { text, ended } = await drain(response.body!);
		assert(ended, 'the stream does not outlive its authorization');
		const last = events(text).at(-1)!;
		assertEquals(last.jsonrpc, '2.0');
		assertEquals(last.id, 9);
		assertEquals((last.error as Record<string, unknown>).code, A2A_STREAM_ENDED);
		assertEquals(((last.error as Record<string, unknown>).data as Record<string, unknown>).reason, 'unauthorized');
		assertEquals(services.streams.size, 0);
		const task = (await (await app.request('/api/v1/agent/tasks')).json()).tasks[0];
		assertEquals(task.status.state, 'TASK_STATE_WORKING', 'ending the stream does not cancel the task');
	} finally {
		await services.close();
	}
});

Deno.test('A6 / AC13: an A2A stream ends at its lifetime with a terminal error, on both bindings', async () => {
	const { app, services } = harness(new StreamGuard({ lifetimeMs: 50 }));
	try {
		const task = services.runtime.submit('api-key:viewer', viewer.scopes, message());
		const rpc = await app.request('/a2a', rpcBody(3, 'SubscribeToTask', { id: task.id }));
		const viaRpc = events((await drain(rpc.body!)).text).at(-1)!;
		assertEquals((viaRpc.error as Record<string, unknown>).code, A2A_STREAM_ENDED);
		assertEquals(((viaRpc.error as Record<string, unknown>).data as Record<string, unknown>).reason, 'stream-expired');
		const rest = await app.request(`/a2a/v1/tasks/${task.id}:subscribe`, { headers: { 'a2a-version': '1.0' } });
		assertEquals(rest.status, 200);
		const viaRest = events((await drain(rest.body!)).text);
		assert(viaRest[0]?.task, 'the HTTP+JSON stream carries bare StreamResponse objects');
		const last = viaRest.at(-1)!;
		assertEquals(last.jsonrpc, undefined);
		assertEquals((last.error as Record<string, unknown>).code, A2A_STREAM_ENDED);
	} finally {
		await services.close();
	}
});

Deno.test('A6 / AC13: rotating the key behind an open A2A stream ends it with the terminal error at once', async () => {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const rotated = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([alice.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const { registry, release } = blockedRegistry();
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	try {
		const response = await gateway.app.request(`${ORIGIN}/a2a`, {
			method: 'POST',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${alice.key}`,
				'content-type': 'application/json',
				'a2a-version': '1.0',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'stream-1',
				method: 'SendStreamingMessage',
				params: { message: message('browser_list_tabs') },
			}),
		});
		assertEquals(response.status, 200);
		const reader = response.body!.getReader();
		await reader.read();
		reader.releaseLock();
		assert(verifier.replaceApiKeys([rotated.record]));
		const { text, ended } = await drain(response.body!);
		assert(ended);
		const last = events(text).at(-1)!;
		assertEquals(last.id, 'stream-1');
		assertEquals((last.error as Record<string, unknown>).code, A2A_STREAM_ENDED);
	} finally {
		release();
		await gateway.close();
		await registry.shutdown();
	}
});

// --- A11: card, extended card, HTTP+JSON binding (AC18) --------------------------------------------------------

async function gatewayWith(keys: { record: unknown }[]): Promise<ReturnType<typeof createGatewayApp>> {
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify(keys.map((key) => key.record)) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	// No reaper: these tests never launch a browser, and the registry is not otherwise shut down.
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	return await Promise.resolve(createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() }));
}

function call(
	gateway: ReturnType<typeof createGatewayApp>,
	path: string,
	key: string | undefined,
	init: { method?: string; body?: unknown; version?: string | null } = {},
): Promise<Response> {
	return Promise.resolve(gateway.app.request(`${ORIGIN}${path}`, {
		method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
		headers: {
			host: '127.0.0.1:8787',
			...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
			...(init.version === null ? {} : { 'a2a-version': init.version ?? '1.0' }),
			...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	}));
}

Deno.test('A11 / AC18: the card lists both bindings, the extended card, and push only when offered', async () => {
	const gateway = await gatewayWith([]);
	try {
		const card = await (await call(gateway, '/.well-known/agent-card.json', undefined, { version: null })).json();
		assertEquals(card.supportedInterfaces, [
			{ url: 'http://127.0.0.1:8787/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
			{ url: 'http://127.0.0.1:8787/a2a/v1', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
		]);
		assertEquals(card.capabilities.extendedAgentCard, true);
		assertEquals(card.capabilities.pushNotifications, false, 'no TTK_A2A_PUSH_ALLOWED_HOSTS, no push');
	} finally {
		await gateway.close();
	}
});

Deno.test('A11 / AC18: GetExtendedAgentCard lists only the tools this caller may invoke as a task', async () => {
	const plain = await generateApiKey('plain', ['mcp:invoke', 'agent:invoke']);
	const evaluator = await generateApiKey('evaluator', ['mcp:invoke', 'agent:invoke', 'evaluate']);
	const agentOnly = await generateApiKey('agent-only', ['agent:invoke']);
	const viewerKey = await generateApiKey('viewer', ['mcp:invoke']);
	const gateway = await gatewayWith([plain, evaluator, agentOnly, viewerKey]);
	const skills = async (key: string, rest = false): Promise<string[]> => {
		const response = rest
			? await call(gateway, '/a2a/v1/extendedAgentCard', key)
			: await call(gateway, '/a2a', key, { body: { jsonrpc: '2.0', id: 1, method: 'GetExtendedAgentCard' } });
		const body = await response.json();
		const card = rest ? body : body.result;
		return (card.skills as { id: string }[]).map((skill) => skill.id);
	};
	try {
		const ids = await skills(plain.key);
		assert(ids.includes('browser_click'), ids.join(','));
		assert(ids.includes('agent_get_task'));
		for (const absent of ['browser_evaluate', 'browser_run_task', 'browser_extract_content', 'sandbox_exec']) {
			assertEquals(ids.includes(absent), false, `${absent} is not invocable by this caller as a task`);
		}
		assert((await skills(evaluator.key)).includes('browser_evaluate'));
		assertEquals(await skills(agentOnly.key), ['tool-invocation'], 'no mcp:invoke, no tool');
		assertEquals(await skills(plain.key, true), ids, 'both bindings serve the same card');
		const denied = await call(gateway, '/a2a/v1/extendedAgentCard', viewerKey.key);
		assertEquals(denied.status, 403);
		await denied.body?.cancel();
		const anonymous = await call(gateway, '/a2a/v1/extendedAgentCard', undefined);
		assertEquals(anonymous.status, 401);
		await anonymous.body?.cancel();
	} finally {
		await gateway.close();
	}
});

Deno.test('A11 / AC18: the HTTP+JSON binding round-trips send, get, list, cancel and stream on the same handlers', async () => {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const bob = await generateApiKey('bob', ['mcp:invoke', 'agent:invoke']);
	const gateway = await gatewayWith([alice, bob]);
	try {
		const sent = await call(gateway, '/a2a/v1/message:send', alice.key, { body: { message: message() } });
		assertEquals(sent.status, 200);
		assertEquals(sent.headers.get('a2a-version'), '1.0');
		const task = (await sent.json()).task;
		assertEquals(task.status.state, 'TASK_STATE_COMPLETED');
		assertEquals(
			(await (await call(gateway, `/a2a/v1/tasks/${task.id}?historyLength=0`, alice.key)).json()).history,
			[],
		);
		const listed = await (await call(gateway, '/a2a/v1/tasks?pageSize=1&includeArtifacts=true', alice.key)).json();
		assertEquals(listed.tasks.map((item: { id: string }) => item.id), [task.id]);
		assert(listed.tasks[0].artifacts);
		// The JSON-RPC binding sees the same task: one runtime, one handler.
		const viaRpc = await (await call(gateway, '/a2a', alice.key, {
			body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: task.id } },
		})).json();
		assertEquals(viaRpc.result.id, task.id);

		const problem = async (response: Response, status: number, type: string): Promise<void> => {
			assertEquals(response.status, status);
			assertEquals((await response.json()).type, `https://tykotech.eu/problems/${type}`);
		};
		await problem(await call(gateway, `/a2a/v1/tasks/${task.id}:cancel`, alice.key, { body: {} }), 409, 'conflict');
		await problem(await call(gateway, `/a2a/v1/tasks/${task.id}`, bob.key), 404, 'not-found');
		await problem(await call(gateway, '/a2a/v1/tasks?pageSize=1000', alice.key), 400, 'invalid-request');
		await problem(await call(gateway, '/a2a/v1/tasks', alice.key, { version: null }), 400, 'invalid-request');
		await problem(await call(gateway, '/a2a/v1/nowhere', alice.key), 404, 'not-found');
		await problem(
			await call(gateway, `/a2a/v1/tasks/${task.id}/pushNotificationConfigs`, alice.key, {
				body: { url: 'https://hooks.example.com/x' },
			}),
			400,
			'invalid-request',
		);

		const stream = await call(gateway, '/a2a/v1/message:stream', alice.key, { body: { message: message() } });
		assertEquals(stream.headers.get('content-type'), 'text/event-stream');
		const frames = events((await drain(stream.body!)).text);
		assert(frames[0]?.task);
		const final = frames.at(-1)!.statusUpdate as { status: { state: string } };
		assertEquals(final.status.state, 'TASK_STATE_COMPLETED');
	} finally {
		await gateway.close();
	}
});

Deno.test('A11: a running task is cancelled over the HTTP+JSON binding', async () => {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([alice.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const { registry, release } = blockedRegistry();
	const gateway = createGatewayApp({ config, verifier, registry, version: 'test', logger: quiet() });
	try {
		const sent = await call(gateway, '/a2a/v1/message:send', alice.key, {
			body: { message: message('browser_list_tabs'), configuration: { returnImmediately: true } },
		});
		const task = (await sent.json()).task;
		const cancelled = await call(gateway, `/a2a/v1/tasks/${task.id}:cancel`, alice.key, { body: {} });
		assertEquals(cancelled.status, 200);
		assertEquals((await cancelled.json()).status.state, 'TASK_STATE_CANCELED');
	} finally {
		release();
		await gateway.close();
		await registry.shutdown();
	}
});

// --- A11 / N1: the push gate ----------------------------------------------------------------------------------

/** A permissions API that grants exactly `granted` (and everything when it holds the bare `net`). */
function permissions(granted: string[]): Pick<Deno.Permissions, 'querySync'> {
	return {
		querySync: (descriptor: Deno.PermissionDescriptor): Deno.PermissionStatus => {
			const net = descriptor as Deno.NetPermissionDescriptor;
			const key = net.host === undefined ? 'net' : net.host;
			return { state: granted.includes(key) ? 'granted' : 'prompt' } as Deno.PermissionStatus;
		},
	};
}

Deno.test('A11 / N1: push is offered only for a non-empty host list with a proven grant for every host', () => {
	assertEquals(pushGrantProven([], permissions(['net'])), false, 'an empty list offers nothing, even with full net');
	assertEquals(pushGrantProven(['hooks.example.com'], permissions(['net'])), true);
	assertEquals(pushGrantProven(['hooks.example.com'], permissions(['hooks.example.com:443'])), true);
	assertEquals(pushGrantProven(['hooks.example.com:8443'], permissions(['hooks.example.com:443'])), false);
	assertEquals(
		pushGrantProven(['a.example.com', 'b.example.com'], permissions(['a.example.com:443'])),
		false,
		'every listed host must be granted',
	);
	assertEquals(pushGrantProven(['[2001:db8::1]'], permissions(['[2001:db8::1]:443'])), true);
	// The test tier's own grant (loopback only) proves nothing for a public host.
	assertEquals(pushGrantProven(['hooks.example.com']), false);
});

Deno.test('A11 / N1: the gateway wires the gate into the card and the address classifier into every delivery', async () => {
	const registry = new SessionRegistry();
	const lines: string[] = [];
	const logger = {
		info: (line: string): void => void lines.push(`info ${line}`),
		warn: (line: string): void => void lines.push(`warn ${line}`),
	};
	const config = loadConfig({ TTK_A2A_PUSH_ALLOWED_HOSTS: 'hooks.example.com' }).expansion;
	const withheld = createExpansionServices(config, { registry, version: 'test' }, undefined, undefined, undefined, {
		logger,
		permissions: permissions([]),
	});
	const fetched: string[] = [];
	const offered = createExpansionServices(config, { registry, version: 'test' }, undefined, undefined, undefined, {
		logger,
		permissions: permissions(['hooks.example.com:443']),
		// B-6: a scoped grant needs the resolver proven; this probe answers that it is.
		resolverProbe: () => Promise.resolve(true),
		push: {
			// The operator's host now resolves to loopback: the gateway's classifier must refuse the delivery.
			resolve: () => Promise.resolve(['127.0.0.1']),
			fetch: (input) => {
				fetched.push(String(input));
				return Promise.resolve(new Response(null, { status: 200 }));
			},
		},
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 0)); // let the one-time resolver probe settle (B-6)
		assertEquals(withheld.runtime.supportsPush, false);
		assert(lines.some((line) => line.startsWith('warn') && line.includes('no outbound net grant')), lines.join('\n'));
		assertEquals(offered.runtime.supportsPush, true);
		assert(lines.some((line) => line.startsWith('info') && line.includes('hooks.example.com')));
		const task = offered.runtime.submit(
			'api-key:alice',
			new Set(['agent:invoke', 'mcp:invoke']),
			message(),
			undefined,
			{ push: { url: 'https://hooks.example.com/notify' } },
		);
		const reader = offered.runtime.subscribe('api-key:alice', task.id).getReader();
		while (!(await reader.read()).done) { /* until the task ends */ }
		reader.releaseLock();
		const deadline = Date.now() + 2_000;
		while (!lines.some((line) => line.includes('refused')) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert(lines.some((line) => line.includes('refused')), lines.join('\n'));
		assertEquals(fetched, [], 'a webhook resolving to loopback is never dialled');
	} finally {
		await withheld.close();
		await offered.close();
		await registry.shutdown();
	}
});

Deno.test('B-6: under a scoped grant, push stays unoffered until the DNS resolver is proven permitted', async () => {
	const registry = new SessionRegistry();
	const lines: string[] = [];
	const logger = {
		info: (line: string): void => void lines.push(`info ${line}`),
		warn: (line: string): void => void lines.push(`warn ${line}`),
	};
	const config = loadConfig({ TTK_A2A_PUSH_ALLOWED_HOSTS: 'hooks.example.com' }).expansion;
	let settle: (ok: boolean) => void = () => {};
	const probed: string[] = [];
	const scoped = createExpansionServices(config, { registry, version: 'test' }, undefined, undefined, undefined, {
		logger,
		permissions: permissions(['hooks.example.com:443']),
		resolverProbe: (host) => {
			probed.push(host);
			return new Promise((resolve) => settle = resolve);
		},
	});
	const unscoped = createExpansionServices(config, { registry, version: 'test' }, undefined, undefined, undefined, {
		logger,
		permissions: permissions(['net']),
		resolverProbe: () => Promise.reject(new Error('an unscoped grant covers the resolver: never probed')),
	});
	try {
		assertEquals(probed, ['hooks.example.com']);
		assertEquals(scoped.runtime.supportsPush, false, 'not offered while the probe is pending');
		assertEquals(unscoped.runtime.supportsPush, true, 'an unscoped grant needs no probe');
		settle(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assertEquals(scoped.runtime.supportsPush, false, 'a refused resolver keeps push off');
		assert(lines.some((line) => line.startsWith('warn') && line.includes('DNS resolver')), lines.join(' | '));
		const task = scoped.runtime.submit('api-key:alice', new Set(['agent:invoke', 'mcp:invoke']), message());
		let code: number | undefined;
		try {
			scoped.runtime.setPushConfig('api-key:alice', task.id, { url: 'https://hooks.example.com/notify' });
		} catch (error) {
			code = (error as { code?: number }).code;
		}
		assertEquals(code, -32003, 'the push methods answer as unsupported, like the card');
	} finally {
		await scoped.close();
		await unscoped.close();
		await registry.shutdown();
	}
});

// --- B1: durable agent state wired to the data directory ------------------------------------------------------

Deno.test('B1 / AC4: tasks and surfaces persist under <TTK_DATA_DIR>/agents and come back with the next instance', async () => {
	const dataDir = `tests/.scratch/agents-${crypto.randomUUID()}`;
	const registry = new SessionRegistry();
	const config = loadConfig({}).expansion;
	const build = (): ExpansionServices =>
		createExpansionServices(config, { registry, version: 'test' }, undefined, undefined, undefined, { dataDir });
	const first = build();
	let second: ExpansionServices | undefined;
	try {
		const task = first.runtime.submit('api-key:alice', new Set(['agent:invoke', 'mcp:invoke']), message());
		const reader = first.runtime.subscribe('api-key:alice', task.id).getReader();
		while (!(await reader.read()).done) { /* until the task ends */ }
		reader.releaseLock();
		first.publish('api-key:alice', {
			version: 'v0.9',
			createSurface: { surfaceId: 'kept', catalogId: A2UI_CATALOG_ID },
		});
		await first.close();
		for (const name of ['tasks.json', 'surfaces.json']) {
			const stat = await Deno.stat(`${dataDir}/${AGENT_STATE_DIR}/${name}`);
			assert(stat.isFile, name);
		}
		second = build();
		assertEquals(second.runtime.get('api-key:alice', task.id).status.state, 'TASK_STATE_COMPLETED');
		assertEquals(
			(second.surfaces.list('api-key:alice').surfaces as { surfaceId: string }[]).map((surface) => surface.surfaceId),
			['kept'],
		);
	} finally {
		await first.close();
		await second?.close();
		await registry.shutdown();
		await Deno.remove(dataDir, { recursive: true }).catch(() => {});
	}
});
