import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	a2aFetch,
	agentCard,
	AgentRuntime,
	type AgentRuntimeOptions,
	extendedAgentCard,
	INTERRUPTED_BY_RESTART,
	type ModelProviderClient,
	type ModelTurn,
	type PushOptions,
} from '../../packages/agents/mod.ts';

const scopes = new Set(['agent:invoke', 'mcp:invoke']);
/** A new A2A message each call: a repeated messageId is a retry of the same message (E-3). */
const fresh = () => ({
	messageId: crypto.randomUUID(),
	role: 'ROLE_USER',
	parts: [{ data: { tool: 'browser_list_sessions', arguments: {} } }],
});
function rpc(
	runtime: AgentRuntime,
	method: string,
	params: unknown = {},
	owner = 'alice',
	version = '1.0',
): Promise<Response> {
	return a2aFetch(
		new Request('http://localhost/a2a', {
			method: 'POST',
			headers: { 'a2a-version': version },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		}),
		owner,
		scopes,
		runtime,
	);
}

Deno.test('A2A 1.0 contract: PascalCase methods, blocking SendMessage and scoped discovery', async (): Promise<void> => {
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ sessions: [] }),
	});
	try {
		const card = agentCard('https://example.com', runtime);
		assertEquals(card.supportedInterfaces, [{
			url: 'https://example.com/a2a',
			protocolBinding: 'JSONRPC',
			protocolVersion: '1.0',
		}]);
		assertEquals(card.defaultInputModes, ['application/json']);
		const response = await (await rpc(runtime, 'SendMessage', { message: fresh() })).json();
		assertEquals(response.result.task.status.state, 'TASK_STATE_COMPLETED');
		const id = response.result.task.id;
		assertEquals((await (await rpc(runtime, 'GetTask', { id, historyLength: 0 })).json()).result.history, []);
		assertEquals((await (await rpc(runtime, 'GetTask', { id }, 'bob')).json()).error.code, -32001);
		assertEquals((await (await rpc(runtime, 'CancelTask', { id })).json()).error.code, -32002);
		assertEquals((await (await rpc(runtime, 'SubscribeToTask', { id })).json()).error.code, -32004);
		assertEquals((await (await rpc(runtime, 'message/send', { message: fresh() })).json()).error.code, -32601);
		assertEquals(
			(await (await rpc(runtime, 'SendMessage', { message: fresh() }, 'alice', '')).json()).error.code,
			-32009,
		);
		assertEquals((await (await rpc(runtime, 'CreateTaskPushNotificationConfig', {})).json()).error.code, -32003);
		assertEquals((await (await rpc(runtime, 'GetExtendedAgentCard')).json()).error.code, -32004);
		assertEquals(
			(await (await rpc(runtime, 'SendMessage', {
				message: fresh(),
				configuration: { taskPushNotificationConfig: {} },
			})).json())
				.error.code,
			-32003,
		);
		const listed = (await (await rpc(runtime, 'ListTasks', { historyLength: 0 })).json()).result;
		assertEquals(listed.totalSize, 1);
		assertEquals(listed.nextPageToken, '');
		assertEquals(listed.pageSize, 50);
		assertEquals(listed.tasks[0].artifacts, undefined);
		assertEquals(listed.tasks[0].history, undefined);
		assertEquals((await (await rpc(runtime, 'ListTasks', {}, 'bob')).json()).result.tasks, []);
		for (
			const params of [{ pageSize: 101 }, { status: 'working' }, { pageToken: 'foreign' }, { historyLength: -1 }, {
				includeArtifacts: 'true',
			}, { statusTimestampAfter: 'wrong' }]
		) {
			assertEquals((await (await rpc(runtime, 'ListTasks', params)).json()).error.code, -32602);
		}
	} finally {
		await runtime.close();
	}
});

Deno.test('A2A SSE starts with task, emits artifacts/status and ends; cancellation unsubscribes only', async (): Promise<void> => {
	const runtime = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ ok: true }) });
	try {
		const response = await rpc(runtime, 'SendStreamingMessage', { message: fresh() });
		assertEquals(response.headers.get('content-type'), 'text/event-stream');
		const data = (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
		assert(data[0].result.task);
		assert(data.some((line) => line.result.artifactUpdate));
		assertEquals(data.at(-1).result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
		assert(data.every((line) => line.jsonrpc === '2.0' && line.id === 1));
		const first =
			await (await rpc(runtime, 'SendMessage', { message: fresh(), configuration: { returnImmediately: true } }))
				.json();
		const second =
			await (await rpc(runtime, 'SendMessage', { message: fresh(), configuration: { returnImmediately: true } }))
				.json();
		const page = (await (await rpc(runtime, 'ListTasks', { pageSize: 1, includeArtifacts: true })).json()).result;
		assertEquals(page.tasks.length, 1);
		assert(page.nextPageToken);
		const next =
			(await (await rpc(runtime, 'ListTasks', { pageSize: 1, pageToken: page.nextPageToken })).json()).result;
		assertEquals(next.tasks.length, 1);
		assert(next.tasks[0].id !== page.tasks[0].id);
		assert(first.result.task.id !== second.result.task.id);
	} finally {
		await runtime.close();
	}
});

Deno.test('AG-14: ListTasks pages on immutable creation order, so a status change between pages skips nothing', async (): Promise<void> => {
	let release: () => void = (): void => {};
	let calls = 0;
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> =>
			++calls === 1 ? new Promise((resolve) => release = () => resolve({ ok: true })) : Promise.resolve({ ok: true }),
	});
	const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
	try {
		const send = async (): Promise<string> =>
			(await (await rpc(runtime, 'SendMessage', { message: fresh(), configuration: { returnImmediately: true } }))
				.json())
				.result.task.id;
		const slow = await send();
		await pause();
		const middle = await send();
		await pause();
		const newest = await send();
		await pause();
		const seen: string[] = [];
		const first = (await (await rpc(runtime, 'ListTasks', { pageSize: 1, historyLength: 0 })).json()).result;
		seen.push(...first.tasks.map((task: { id: string }) => task.id));
		// The slow task finishes between pages: its status timestamp now sorts first, which moved it behind an
		// id-anchored cursor and skipped it.
		release();
		while (
			(await (await rpc(runtime, 'GetTask', { id: slow })).json()).result.status.state !== 'TASK_STATE_COMPLETED'
		) {
			await pause();
		}
		let token = first.nextPageToken;
		while (token) {
			const page = (await (await rpc(runtime, 'ListTasks', { pageSize: 1, pageToken: token })).json()).result;
			seen.push(...page.tasks.map((task: { id: string }) => task.id));
			token = page.nextPageToken;
		}
		assertEquals(seen, [newest, middle, slow]);
	} finally {
		await runtime.close();
	}
});

Deno.test('A2A rejects malformed, oversize, missing identity and unsupported content before invocation', async (): Promise<void> => {
	let called = false;
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => {
			called = true;
			return Promise.resolve({});
		},
	});
	try {
		const request = (body: string): Request =>
			new Request('http://localhost/a2a', { method: 'POST', headers: { 'a2a-version': '1.0' }, body });
		assertEquals((await (await a2aFetch(request('{'), 'alice', scopes, runtime)).json()).error.code, -32700);
		assertEquals((await (await a2aFetch(request('{}'), 'alice', scopes, runtime)).json()).error.code, -32600);
		assertEquals((await a2aFetch(request('{}'), 'alice', new Set(), runtime)).status, 403);
		assertEquals(
			(await (await a2aFetch(request(' '.repeat(512 * 1024 + 1)), 'alice', scopes, runtime)).json()).error.code,
			-32602,
		);
		assertEquals(
			(await (await rpc(runtime, 'SendMessage', { message: { ...fresh(), parts: [{ url: 'file:///etc/passwd' }] } }))
				.json()).error.code,
			-32005,
		);
		assertEquals(called, false);
	} finally {
		await runtime.close();
	}
});

Deno.test('E-3: a retried SendMessage (same messageId, same principal) returns the first task and runs once', async () => {
	let runs = 0;
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => {
			runs++;
			return Promise.resolve({ content: [] });
		},
	});
	try {
		const once = fresh();
		const first = await (await rpc(runtime, 'SendMessage', { message: once })).json();
		const again = await (await rpc(runtime, 'SendMessage', { message: once })).json();
		assertEquals(again.result.task.id, first.result.task.id);
		// The same id from another principal is that principal's own message.
		const other = await (await rpc(runtime, 'SendMessage', { message: once }, 'bob')).json();
		assert(other.result.task.id !== first.result.task.id);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assertEquals(runs, 2);
	} finally {
		await runtime.close();
	}
});

// --- A11: push notifications (AC18) ----------------------------------------------------------------------------

/**
 * A loopback webhook that records what it receives and answers each delivery with the next status from `statuses`
 * (200 once they run out).
 */
function webhook(statuses: number[] = []): {
	url: string;
	host: string;
	received: { token: string | null; type: string | null; body: Record<string, unknown> }[];
	close(): Promise<void>;
} {
	const received: { token: string | null; type: string | null; body: Record<string, unknown> }[] = [];
	let calls = 0;
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen(): void {} }, async (request) => {
		received.push({
			token: request.headers.get('x-a2a-notification-token'),
			type: request.headers.get('content-type'),
			body: await request.json(),
		});
		return new Response(null, { status: statuses[calls++] ?? 200 });
	});
	return {
		url: `http://127.0.0.1:${server.addr.port}/hook`,
		host: `127.0.0.1:${server.addr.port}`,
		received,
		close: () => server.shutdown(),
	};
}

/**
 * The address policy under test. The real classifier is `@tykotech/mcp`'s (asserted in the gateway's tests); a
 * stand-in here keeps this file inside the agents tier's narrow grants.
 */
const forbidden = (address: string): boolean =>
	/^(10|127)\./.test(address) || address.startsWith('169.254.') || address === '::1' || address.startsWith('fd');

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function pushRuntime(policy: Partial<PushOptions>, extra: Partial<AgentRuntimeOptions> = {}): AgentRuntime {
	return new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ sessions: [] }),
		push: { allowedHosts: [], forbiddenAddress: forbidden, allowLoopbackHttp: true, backoffMs: 5, ...policy },
		...extra,
	});
}

const stateOf = (delivery: { body: Record<string, unknown> }): string =>
	String(((delivery.body.statusUpdate as Record<string, unknown>).status as Record<string, unknown>).state);

Deno.test('A11 / AC18: push config CRUD, delivery to a webhook with the token echoed, never read back', async () => {
	const hook = webhook();
	const fetched: string[] = [];
	const warnings: string[] = [];
	const runtime = pushRuntime({
		allowedHosts: [hook.host, '10.0.0.5', 'internal.example'],
		// `internal.example` is on the operator's list but resolves to a private address at delivery time.
		resolve: (host): Promise<readonly string[]> => Promise.resolve(host === 'internal.example' ? ['10.1.2.3'] : []),
		fetch: (input, init): Promise<Response> => {
			fetched.push(new URL(String(input instanceof Request ? input.url : input)).host);
			return fetch(input, init);
		},
		logger: { warn: (line): void => void warnings.push(line) },
	});
	try {
		assertEquals(
			(agentCard('https://example.com', runtime).capabilities as Record<string, unknown>).pushNotifications,
			true,
		);
		const sent = await (await rpc(runtime, 'SendMessage', {
			message: fresh(),
			configuration: { taskPushNotificationConfig: { id: 'hook-1', url: hook.url, token: 'echo-token-123' } },
		})).json();
		const taskId = sent.result.task.id;
		assertEquals(sent.result.task.status.state, 'TASK_STATE_COMPLETED');
		await until(() => hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_COMPLETED'), 'delivery');
		assertEquals(hook.received.map(stateOf), ['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED']);
		for (const delivery of hook.received) {
			assertEquals(delivery.token, 'echo-token-123');
			assertEquals(delivery.type, 'application/json');
			assertEquals((delivery.body.statusUpdate as Record<string, unknown>).taskId, taskId);
		}

		const listed = (await (await rpc(runtime, 'ListTaskPushNotificationConfig', { taskId })).json()).result;
		assertEquals(listed.configs.length, 1);
		assertEquals(listed.configs[0].pushNotificationConfig, { id: 'hook-1', url: hook.url });
		assertEquals(JSON.stringify(listed).includes('echo-token-123'), false, 'a token never round-trips');
		const got = (await (await rpc(runtime, 'GetTaskPushNotificationConfig', { taskId, id: 'hook-1' })).json()).result;
		assertEquals(got.pushNotificationConfig.url, hook.url);
		assertEquals(
			(await (await rpc(runtime, 'GetTaskPushNotificationConfig', { taskId, id: 'hook-1' }, 'bob')).json())
				.error.code,
			-32001,
		);

		// At most four per task; the same id replaces rather than adds.
		for (const id of ['hook-2', 'hook-3', 'hook-4', 'hook-2']) {
			const created = await (await rpc(runtime, 'CreateTaskPushNotificationConfig', {
				taskId,
				configId: id,
				config: { url: hook.url },
			})).json();
			assertEquals(created.result.id, id);
		}
		const fifth = await (await rpc(runtime, 'CreateTaskPushNotificationConfig', {
			taskId,
			pushNotificationConfig: { id: 'hook-5', url: hook.url },
		})).json();
		assertEquals(fifth.error.code, -32602);
		assertEquals(
			(await (await rpc(runtime, 'DeleteTaskPushNotificationConfig', { taskId, id: 'hook-2' })).json())
				.result,
			{},
		);
		assertEquals(
			(await (await rpc(runtime, 'GetTaskPushNotificationConfig', { taskId, id: 'hook-2' })).json())
				.error.code,
			-32001,
		);

		// The URL policy: https, allowlisted host, no credentials, no private literal.
		for (
			const url of [
				'https://10.0.0.5/hook',
				'http://internal.example/hook',
				'https://elsewhere.example/hook',
				'https://user:pass@internal.example/hook',
				'https://internal.example:8443/hook',
				'not a url',
			]
		) {
			const refused = await (await rpc(runtime, 'CreateTaskPushNotificationConfig', {
				taskId,
				configId: 'refused',
				config: { url },
			})).json();
			assertEquals(refused.error?.code, -32602, url);
		}
		assertEquals(
			(await (await rpc(runtime, 'CreateTaskPushNotificationConfig', {
				taskId,
				config: { url: hook.url, authentication: { schemes: ['Bearer'], credentials: 'x' } },
			})).json()).error.code,
			-32602,
		);

		// Every delivery re-resolves the host: a name that now points at a private address is never dialled.
		const resolved = await (await rpc(runtime, 'SendMessage', {
			message: fresh(),
			configuration: { taskPushNotificationConfig: { url: 'https://internal.example/hook' } },
		})).json();
		assertEquals(resolved.result.task.status.state, 'TASK_STATE_COMPLETED');
		await until(() => warnings.some((line) => line.includes('refused')), 'the delivery refusal');
		assertEquals(fetched.includes('internal.example'), false);
		assert(warnings.every((line) => !line.includes('/hook') && !line.includes('echo-token')), warnings.join('\n'));
	} finally {
		await runtime.close();
		await hook.close();
	}
});

Deno.test('A11: a 5xx is retried at most three times; a 4xx is not retried', async () => {
	const flaky = webhook([503, 503, 200]);
	const gone = webhook([404]);
	const failing = webhook([500, 500, 500, 500, 500]);
	const runtime = pushRuntime({ allowedHosts: [flaky.host, gone.host, failing.host] });
	try {
		for (const hook of [flaky, gone, failing]) {
			// Attached at creation, so each webhook hears exactly WORKING, then COMPLETED, in that order.
			await (await rpc(runtime, 'SendMessage', {
				message: fresh(),
				configuration: { taskPushNotificationConfig: { url: hook.url } },
			})).body?.cancel();
		}
		const completed = (hook: ReturnType<typeof webhook>): boolean =>
			hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_COMPLETED');
		await until(() => completed(flaky) && completed(gone) && completed(failing), 'every COMPLETED delivery');
		const working = (hook: ReturnType<typeof webhook>): number =>
			hook.received.filter((delivery) => stateOf(delivery) === 'TASK_STATE_WORKING').length;
		assertEquals(working(flaky), 3, '503, 503, then delivered');
		assertEquals(working(gone), 1, 'a 404 is final');
		assertEquals(working(failing), 4, 'one attempt and three retries, then given up');
	} finally {
		await runtime.close();
		await Promise.all([flaky.close(), gone.close(), failing.close()]);
	}
});

Deno.test('A11 / AC18: without an operator push policy every push method answers -32003 and the card says so', async () => {
	const runtime = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}) });
	try {
		assertEquals(
			(agentCard('https://example.com', runtime).capabilities as Record<string, unknown>).pushNotifications,
			false,
		);
		const task = (await (await rpc(runtime, 'SendMessage', { message: fresh() })).json()).result.task;
		for (
			const method of [
				'CreateTaskPushNotificationConfig',
				'GetTaskPushNotificationConfig',
				'ListTaskPushNotificationConfig',
				'DeleteTaskPushNotificationConfig',
			]
		) {
			const body = await (await rpc(runtime, method, { taskId: task.id, id: 'x', config: { url: 'https://a.b/' } }))
				.json();
			assertEquals(body.error.code, -32003, method);
		}
	} finally {
		await runtime.close();
	}
});

/**
 * D-154: a stand-in for the gateway's `syncSealer` (whose AES-GCM is proven in `database_test.ts`): reversible, bound to
 * its context, and never containing the plain text.
 */
const SEALER = {
	seal: (plain: string, context: string): string => `sealed.${btoa(`${context}\n${plain}`)}`,
	open: (sealed: string, context: string): string | null => {
		const [head, body] = sealed.split('.');
		if (head !== 'sealed' || body === undefined) return null;
		const [bound, plain] = atob(body).split('\n');
		return bound === context && plain !== undefined ? plain : null;
	},
};

Deno.test('A11 / B1 / D-154: push configs persist with their task, the token sealed, and a restart reports the interruption', async () => {
	const hook = webhook();
	const dir = `tests/.scratch/agent-push-${crypto.randomUUID()}`;
	const path = `${dir}/agents/tasks.json`;
	const first = pushRuntime({ allowedHosts: [hook.host] }, {
		persistPath: path,
		sealer: SEALER,
		invoke: (_tool, _args, _owner, _scopes, signal): Promise<Record<string, unknown>> =>
			new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true })),
	});
	let second: AgentRuntime | undefined;
	try {
		const task = (await (await rpc(first, 'SendMessage', {
			message: fresh(),
			configuration: { returnImmediately: true, taskPushNotificationConfig: { url: hook.url, token: 'kept-token' } },
		})).json()).result.task;
		await until(() => hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_WORKING'), 'WORKING');
		await first.close();
		const written = await Deno.readTextFile(path);
		assertEquals(written.includes('kept-token'), false, 'no token rests in plain text');
		assertStringIncludes(written, '"sealed_token"');
		second = pushRuntime({ allowedHosts: [hook.host] }, { persistPath: path, sealer: SEALER });
		const listed = (await (await rpc(second, 'ListTaskPushNotificationConfig', { taskId: task.id })).json()).result;
		assertEquals(listed.configs.length, 1);
		await until(
			() => hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_FAILED'),
			'the restart report',
		);
		const report = hook.received.find((delivery) => stateOf(delivery) === 'TASK_STATE_FAILED')!;
		assertEquals(report.token, 'kept-token', 'the opened token is the one the caller set');
		assertStringIncludes(JSON.stringify(report.body), INTERRUPTED_BY_RESTART);
		assertEquals(hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_CANCELED'), false);
	} finally {
		await first.close();
		await second?.close();
		await hook.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('D-154: without a sealer a push token is never written, and its config does not survive a restart', async () => {
	const hook = webhook();
	const dir = `tests/.scratch/agent-push-${crypto.randomUUID()}`;
	const path = `${dir}/agents/tasks.json`;
	const first = pushRuntime({ allowedHosts: [hook.host] }, {
		persistPath: path,
		invoke: (_tool, _args, _owner, _scopes, signal): Promise<Record<string, unknown>> =>
			new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true })),
	});
	let second: AgentRuntime | undefined;
	const warnings: string[] = [];
	try {
		const task = (await (await rpc(first, 'SendMessage', {
			message: fresh(),
			configuration: { returnImmediately: true, taskPushNotificationConfig: { url: hook.url, token: 'memory-only' } },
		})).json()).result.task;
		await until(() => hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_WORKING'), 'WORKING');
		assertEquals(hook.received[0]?.token, 'memory-only', 'delivered while the process holds it');
		await first.close();
		const written = await Deno.readTextFile(path);
		assertEquals(written.includes('memory-only'), false);
		assertStringIncludes(written, '"token_withheld":true');
		const seen = hook.received.length;
		// A different key opens nothing either: the config is dropped, by count, never by token.
		second = pushRuntime({ allowedHosts: [hook.host] }, {
			persistPath: path,
			sealer: SEALER,
			logger: { warn: (line) => void warnings.push(line) },
		});
		const listed = (await (await rpc(second, 'ListTaskPushNotificationConfig', { taskId: task.id })).json()).result;
		assertEquals(listed.configs, []);
		assert(warnings.some((line) => line.includes('1 push notification configs lost their token')), warnings.join('\n'));
		await new Promise((resolve) => setTimeout(resolve, 100));
		assertEquals(hook.received.length, seen, 'no unauthenticated restart report');
	} finally {
		await first.close();
		await second?.close();
		await hook.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('R2-4: a restart drops a stored webhook whose host left the allowlist, before its restart report', async () => {
	const hook = webhook();
	const dir = `tests/.scratch/agent-push-${crypto.randomUUID()}`;
	const path = `${dir}/agents/tasks.json`;
	const first = pushRuntime({ allowedHosts: [hook.host] }, {
		persistPath: path,
		// D-154: sealed, so the token survives the restart and the allowlist is what drops it.
		sealer: SEALER,
		invoke: (_tool, _args, _owner, _scopes, signal): Promise<Record<string, unknown>> =>
			new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true })),
	});
	let second: AgentRuntime | undefined;
	const warnings: string[] = [];
	try {
		const task = (await (await rpc(first, 'SendMessage', {
			message: fresh(),
			configuration: {
				returnImmediately: true,
				taskPushNotificationConfig: { url: `${hook.url}?capability=secret-path`, token: 'dropped-token' },
			},
		})).json()).result.task;
		await until(() => hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_WORKING'), 'WORKING');
		await first.close();
		const seen = hook.received.length;
		// The operator took the webhook's host off the list; push is still offered for another host.
		second = pushRuntime({ allowedHosts: ['hooks.example.com'] }, {
			persistPath: path,
			sealer: SEALER,
			logger: { warn: (line) => void warnings.push(line) },
		});
		assertEquals(second.get('alice', task.id).status.state, 'TASK_STATE_FAILED');
		const listed = (await (await rpc(second, 'ListTaskPushNotificationConfig', { taskId: task.id })).json()).result;
		assertEquals(listed.configs, []);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assertEquals(hook.received.length, seen, 'the removed host hears nothing, not even the restart report');
		// Logged by origin only: never the path, its query or the token.
		const line = warnings.find((warning) => warning.includes('no longer allowed'));
		assert(line?.includes(new URL(hook.url).origin), warnings.join('\n'));
		assertEquals(warnings.some((warning) => /secret-path|dropped-token|\/hook/.test(warning)), false);
		// And the token leaves the file with its configuration.
		await second.flush();
		assertEquals((await Deno.readTextFile(path)).includes('dropped-token'), false);
	} finally {
		await first.close();
		await second?.close();
		await hook.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('R2-4: every delivery is held to the allowlist as it is then, not as it was when the webhook was set', async () => {
	const hook = webhook();
	const allowedHosts = [hook.host];
	const warnings: string[] = [];
	let release!: () => void;
	const held = new Promise<void>((resolve) => release = resolve);
	const runtime = pushRuntime({ allowedHosts, logger: { warn: (line) => void warnings.push(line) } }, {
		invoke: async (): Promise<Record<string, unknown>> => {
			await held;
			return { sessions: [] };
		},
	});
	try {
		const task = (await (await rpc(runtime, 'SendMessage', {
			message: fresh(),
			configuration: { returnImmediately: true, taskPushNotificationConfig: { url: hook.url, token: 't' } },
		})).json()).result.task;
		await until(() => hook.received.some((delivery) => stateOf(delivery) === 'TASK_STATE_WORKING'), 'WORKING');
		// The list narrows under a configuration that already exists.
		allowedHosts.length = 0;
		allowedHosts.push('hooks.example.com');
		const seen = hook.received.length;
		release();
		await until(() => warnings.some((warning) => warning.includes('no longer allowed')), 'the refusal');
		assertEquals(hook.received.length, seen, 'the completion is not delivered to the removed host');
		assertEquals(
			(await (await rpc(runtime, 'GetTask', { id: task.id })).json()).result.status.state,
			'TASK_STATE_COMPLETED',
		);
		assertEquals(warnings.some((warning) => warning.includes('/hook')), false);
	} finally {
		await runtime.close();
		await hook.close();
	}
});

Deno.test('A11: GetExtendedAgentCard returns the caller’s card with one skill per invocable tool', async () => {
	const runtime = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}) });
	try {
		const options = { extendedCard: true, httpJson: true };
		const card = agentCard('https://example.com/base/', runtime, options);
		assertEquals(card.supportedInterfaces, [
			{ url: 'https://example.com/base/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
			{ url: 'https://example.com/base/a2a/v1', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
		]);
		assertEquals((card.capabilities as Record<string, unknown>).extendedAgentCard, true);
		const response = await a2aFetch(
			new Request('http://localhost/a2a', {
				method: 'POST',
				headers: { 'a2a-version': '1.0' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'GetExtendedAgentCard' }),
			}),
			'alice',
			scopes,
			runtime,
			undefined,
			{
				extendedCard: () =>
					extendedAgentCard('https://example.com/base/', runtime, [
						{ name: 'browser_click', title: 'Click', description: 'Click an element.' },
					], options),
			},
		);
		const extended = (await response.json()).result;
		const ids = (extended.skills as { id: string }[]).map((skill) => skill.id);
		assertEquals(ids, ['tool-invocation', 'browser_click']);
	} finally {
		await runtime.close();
	}
});

// --- D-143 (model-providers-ui S0): request metadata, and the card's text skills (§3.11, gate F20) -------------------

/** A runtime that records what `a2aInvoke` hands `submit`, then refuses like the S0 runtime does (no backend). */
class RecordingRuntime extends AgentRuntime {
	readonly submitted: unknown[] = [];
	override submit(
		owner: string,
		held: ReadonlySet<string>,
		value: unknown,
		credential?: string,
		options: { push?: unknown; model?: { provider?: string; model?: string } } = {},
	): ReturnType<AgentRuntime['submit']> {
		this.submitted.push(options);
		return super.submit(owner, held, value, credential, options);
	}
}

const textMessage = () => ({ messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hello' }] });

Deno.test('D-143 (C5): SendMessage reads provider and model from the request-level metadata and hands them to submit', async () => {
	const runtime = new RecordingRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}) });
	try {
		// `params.metadata` beside `message` and `configuration` (A2A 1.0 `SendMessageRequest.metadata`).
		const sent = await (await rpc(runtime, 'SendMessage', {
			message: textMessage(),
			metadata: { provider: 'openai-main', model: 'gpt-4.1' },
		})).json();
		// D-158: every A2A submit names its entrance, so the administrator's A2A switches apply.
		assertEquals(runtime.submitted, [{ model: { provider: 'openai-main', model: 'gpt-4.1' }, via: 'a2a' }]);
		// Without the scope the runtime answers row 2 of §3.10, through the binding's error envelope.
		assertEquals(sent.error, { code: -32600, message: 'model:invoke scope required' });
		// The streaming operation reads the same field; push and model options travel together.
		runtime.submitted.length = 0;
		await (await rpc(runtime, 'SendStreamingMessage', { message: textMessage(), metadata: { provider: 'p' } })).json();
		assertEquals(runtime.submitted, [{ model: { provider: 'p' }, via: 'a2a' }]);
		// No metadata, or metadata naming neither key: nothing is passed, and the message's own metadata is not read.
		runtime.submitted.length = 0;
		await (await rpc(runtime, 'SendMessage', { message: { ...textMessage(), metadata: { provider: 'x' } } })).json();
		await (await rpc(runtime, 'SendMessage', { message: textMessage(), metadata: { other: 1 } })).json();
		assertEquals(runtime.submitted, [{ via: 'a2a' }, { via: 'a2a' }]);
		// Each value is a string of at most 64 characters; anything else is `-32602` before submit.
		for (
			const metadata of [
				{ provider: 'p'.repeat(65) },
				{ provider: 7 },
				{ model: '' },
				{ model: ['gpt'] },
				{ provider: null },
			]
		) {
			runtime.submitted.length = 0;
			const refused = await (await rpc(runtime, 'SendMessage', { message: textMessage(), metadata })).json();
			assertEquals(refused.error.code, -32602, JSON.stringify(metadata));
			assertEquals(runtime.submitted, [], JSON.stringify(metadata));
		}
		// Sixty-four is the bound, inclusive.
		await (await rpc(runtime, 'SendMessage', { message: textMessage(), metadata: { provider: 'p'.repeat(64) } }))
			.json();
		assertEquals(runtime.submitted.length, 1);
	} finally {
		await runtime.close();
	}
});

/** A provider the card may count; never dialled. */
function provider(id: string): ModelProviderClient {
	return {
		id,
		kind: 'anthropic',
		models: ['m'],
		defaultModel: 'm',
		complete: (): Promise<ModelTurn> => Promise.reject(new Error('never dialled')),
	};
}

Deno.test('D-143 §3.11 / gate F20: the card lists external-agent and builtin-model on their own conditions, and text/plain on either', async () => {
	const bridge = { url: 'http://127.0.0.1:9', token: 'never-used', agent: 'none' };
	const model = (reachable: boolean): NonNullable<AgentRuntimeOptions['model']> => ({
		providers: new Map([['p', provider('p')]]),
		default: 'p',
		reachable: () => reachable,
		tools: () => [],
	});
	const cases: Array<[string, Omit<AgentRuntimeOptions, 'invoke'>, string[], string[]]> = [
		['neither', {}, ['tool-invocation'], ['application/json']],
		['bridge only', { bridge }, ['tool-invocation', 'external-agent'], ['application/json', 'text/plain']],
		['provider only', { model: model(true) }, ['tool-invocation', 'builtin-model'], ['application/json', 'text/plain']],
		['both', { bridge, model: model(true) }, ['tool-invocation', 'external-agent', 'builtin-model'], [
			'application/json',
			'text/plain',
		]],
		// A configured but unreachable provider is no backend: listed nowhere, and text/plain is not offered for it.
		['unreachable provider', { model: model(false) }, ['tool-invocation'], ['application/json']],
	];
	for (const [label, options, skills, inputModes] of cases) {
		const runtime = new AgentRuntime({
			...options,
			invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		});
		try {
			const card = agentCard('https://example.com', runtime);
			assertEquals((card.skills as { id: string }[]).map((skill) => skill.id), skills, label);
			assertEquals(card.defaultInputModes, inputModes, label);
			const builtin = (card.skills as { id: string; inputModes: string[]; tags: string[] }[]).find((s) =>
				s.id === 'builtin-model'
			);
			if (builtin !== undefined) {
				assertEquals(builtin.inputModes, ['text/plain']);
				assertEquals(builtin.tags, ['model']);
			}
		} finally {
			await runtime.close();
		}
	}
});

Deno.test('D-143 (CR-1 / BUG-6): metadata.model without metadata.provider is -32602 "model requires provider" through the binding', async () => {
	const runtime = new RecordingRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}) });
	try {
		const sent = await (await rpc(runtime, 'SendMessage', { message: textMessage(), metadata: { model: 'gpt-4.1' } }))
			.json();
		assertEquals(sent.error, { code: -32602, message: 'model requires provider' });
		const streamed = await (await rpc(runtime, 'SendStreamingMessage', {
			message: textMessage(),
			metadata: { model: 'gpt-4.1' },
		})).json();
		assertEquals(streamed.error, { code: -32602, message: 'model requires provider' });
	} finally {
		await runtime.close();
	}
});
