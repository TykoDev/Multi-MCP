/**
 * The cluster's routing decisions (R10/R12).
 *
 * Against a real Deno KV store on a temporary file, because the interesting
 * parts are exactly the ones an in-memory stand-in would get wrong: the atomic
 * claim two nodes race on, and the stale-owner cleanup. The store is the thing
 * under test as much as the policy is.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { extensionTools, OUTPUT } from '@tykotech/mcp';
import { Cluster, FORWARDED_HEADER } from './cluster.ts';
import { fanOut, forward, Router } from './routing.ts';
import { createLogger } from './logger.ts';

const quiet = createLogger({ level: 'error', write: () => {} });

/** A temporary KV file shared by a set of nodes. */
async function store(): Promise<{ path: string; [Symbol.asyncDispose](): Promise<void> }> {
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'kv-' });
	return {
		path: `${dir}/cluster.kv`,
		async [Symbol.asyncDispose]() {
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

function node(kvPath: string, id: string, role: 'all' | 'edge' | 'browser', port = 0) {
	return Cluster.open({
		kvPath,
		nodeId: id,
		nodeUrl: port === 0 ? '' : `http://127.0.0.1:${port}`,
		role,
		version: '0-test',
		logger: quiet,
	});
}

/** A `tools/call` body, as the router receives it. */
function toolCall(name: string, args: Record<string, unknown> = {}): unknown {
	return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
}

Deno.test('routing: anything that is not a tool call is answered here', async () => {
	await using kv = await store();
	const cluster = await node(kv.path, 'a', 'all', 8001);
	const router = new Router({ cluster });
	try {
		for (
			const body of [
				{ method: 'initialize' },
				{ method: 'tools/list' },
				{ method: 'resources/list' },
				{ method: 'server/discover' },
				undefined,
				'nonsense',
			]
		) {
			assertEquals((await router.route(body, false)).kind, 'local', JSON.stringify(body));
		}
	} finally {
		await cluster.close();
	}
});

Deno.test('routing: a forwarded request is never forwarded again', async () => {
	await using kv = await store();
	const owner = await node(kv.path, 'owner', 'browser', 8002);
	const other = await node(kv.path, 'other', 'browser', 8003);
	try {
		await owner.adopt('s1');
		const router = new Router({ cluster: other });
		// Unforwarded, it would hop to the owner...
		assertEquals((await router.route(toolCall('browser_get_state', { session_id: 's1' }), false)).kind, 'forward');
		// ...but a request that has already hopped is served or fails here, or two
		// nodes disagreeing about ownership would bounce it forever.
		assertEquals((await router.route(toolCall('browser_get_state', { session_id: 's1' }), true)).kind, 'local');
	} finally {
		await owner.close();
		await other.close();
	}
});

Deno.test('routing: a session goes to the node that owns it', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8004);
	const b = await node(kv.path, 'b', 'browser', 8005);
	try {
		await a.adopt('mine');
		const fromA = await new Router({ cluster: a }).route(toolCall('browser_click', { session_id: 'mine' }), false);
		assertEquals(fromA.kind, 'local');

		const fromB = await new Router({ cluster: b }).route(toolCall('browser_click', { session_id: 'mine' }), false);
		assertEquals(fromB.kind, 'forward');
		assert(fromB.kind === 'forward' && fromB.node.id === 'a');
	} finally {
		await a.close();
		await b.close();
	}
});

Deno.test('routing: an unknown explicit session stays local, to be refused properly', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8006);
	try {
		// Not a routing failure but a *tool* failure, so it is answered by the
		// handler in the error convention a caller already understands.
		const route = await new Router({ cluster: a }).route(
			toolCall('browser_get_state', { session_id: 'never-existed' }),
			false,
		);
		assertEquals(route.kind, 'local');
	} finally {
		await a.close();
	}
});

Deno.test('routing: two nodes racing for the default session produce one owner', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8007);
	const b = await node(kv.path, 'b', 'browser', 8008);
	try {
		// Both decide at once, as two nodes behind a load balancer would.
		const [routeA, routeB] = await Promise.all([
			new Router({ cluster: a }).route(toolCall('browser_navigate', { url: 'https://x.test/' }), false),
			new Router({ cluster: b }).route(toolCall('browser_navigate', { url: 'https://x.test/' }), false),
		]);
		const locals = [routeA, routeB].filter((route) => route.kind === 'local');
		const forwards = [routeA, routeB].filter((route) => route.kind === 'forward');
		// Exactly one launches a browser; the other sends its request there.
		assertEquals(locals.length, 1, `${routeA.kind}/${routeB.kind}`);
		assertEquals(forwards.length, 1);

		// And they agree on who won.
		const owner = await a.ownerOf('default');
		assert(owner !== null);
		assertEquals((await b.ownerOf('default'))?.id, owner.id);
	} finally {
		await a.close();
		await b.close();
	}
});

Deno.test('routing: an edge node places work rather than hosting it', async () => {
	await using kv = await store();
	const edge = await node(kv.path, 'edge', 'edge');
	const browser = await node(kv.path, 'browser', 'browser', 8009);
	try {
		const router = new Router({ cluster: edge });
		const first = await router.route(toolCall('browser_navigate', { url: 'https://x.test/' }), false);
		assertEquals(first.kind, 'forward');
		assert(first.kind === 'forward' && first.node.id === 'browser');
		// It does not claim on the way past: the node that creates the session is
		// the node that records owning it, so a failed forward leaves no lie.
		assertEquals(await edge.ownerOf('default'), null);

		const created = await router.route(
			toolCall('browser_navigate', { url: 'https://x.test/', new_session: true }),
			false,
		);
		assertEquals(created.kind, 'forward');
	} finally {
		await edge.close();
		await browser.close();
	}
});

Deno.test('routing: an edge node with nowhere to place work says so', async () => {
	await using kv = await store();
	const edge = await node(kv.path, 'edge', 'edge');
	try {
		const route = await new Router({ cluster: edge }).route(
			toolCall('browser_navigate', { url: 'https://x.test/' }),
			false,
		);
		assertEquals(route.kind, 'refuse');
		assert(route.kind === 'refuse');
		assertStringIncludes(route.detail, 'no node in the cluster can host');
	} finally {
		await edge.close();
	}
});

Deno.test('routing: a stale claim is cleared rather than routed into a void', async () => {
	await using kv = await store();
	const gone = await node(kv.path, 'gone', 'browser', 8010);
	await gone.adopt('orphan');
	// The node vanishes without deregistering — a crash, not a shutdown. Its
	// registration is TTL'd but the *claim* is not, so the lookup has to notice.
	const raw = await Deno.openKv(kv.path);
	await raw.delete(['ttk', 'nodes', 'gone']);
	raw.close();

	const survivor = await node(kv.path, 'survivor', 'browser', 8011);
	try {
		assertEquals(await survivor.ownerOf('orphan'), null);
		// And the dead claim is gone, so the next caller can take the id.
		assertEquals((await survivor.sessions()).some((s) => s.sessionId === 'orphan'), false);
	} finally {
		await survivor.close();
		await gone.close();
	}
});

Deno.test('routing: close_all is node-local and list_sessions fans out', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8012);
	const b = await node(kv.path, 'b', 'browser', 8013);
	try {
		const router = new Router({ cluster: a });
		// Closing everything means everything *here*: fanning it out would let one
		// caller close browsers on a node they never addressed.
		assertEquals((await router.route(toolCall('browser_close_all'), false)).kind, 'local');

		const listed = await router.route(toolCall('browser_list_sessions'), false);
		assertEquals(listed.kind, 'fan-out');
		assert(listed.kind === 'fan-out');
		assertEquals(listed.nodes.map((n) => n.id).sort(), ['a', 'b']);
	} finally {
		await a.close();
		await b.close();
	}
});

Deno.test('routing: a fan-out reports the nodes it could not reach', async () => {
	const self = { id: 'a', url: 'http://127.0.0.1:8014', role: 'browser' as const, version: '0' };
	// A peer at a port nothing is listening on: the failure has to be visible in
	// the answer, not swallowed into a shorter list.
	const dead = { id: 'dead', url: 'http://127.0.0.1:1', role: 'browser' as const, version: '0' };

	const localAnswer = () =>
		Promise.resolve(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 7,
					result: {
						resultType: 'complete',
						content: [{ type: 'text', text: JSON.stringify({ sessions: [{ session_id: 'local-1' }] }) }],
						structuredContent: { sessions: [{ session_id: 'local-1' }] },
					},
				}),
				{ headers: { 'content-type': 'application/json' } },
			),
		);

	const request = new Request('http://127.0.0.1/mcp', { method: 'POST', body: '{}' });
	const merged = await fanOut(
		[self, dead],
		request,
		JSON.stringify(toolCall('browser_list_sessions')),
		self,
		localAnswer,
	);
	const body = await merged.json() as {
		id: number;
		result: { resultType?: string; structuredContent: { sessions: unknown[]; unreachable_nodes?: string[] } };
	};

	// The real envelope was reshaped, so era-dependent fields survive.
	assertEquals(body.id, 7);
	assertEquals(body.result.resultType, 'complete');
	assertEquals(body.result.structuredContent.sessions.length, 1);
	assertEquals(body.result.structuredContent.unreachable_nodes, ['dead']);
});

Deno.test('routing: forwarding carries the caller credential and marks the hop', async () => {
	const seen: { auth: string | null; forwarded: string | null; body: string } = {
		auth: null,
		forwarded: null,
		body: '',
	};
	const peer = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
		seen.auth = request.headers.get('authorization');
		seen.forwarded = request.headers.get(FORWARDED_HEADER);
		seen.body = await request.text();
		return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } }), {
			headers: { 'content-type': 'application/json' },
		});
	});
	const port = (peer.addr as Deno.NetAddr).port;

	try {
		const { forward } = await import('./routing.ts');
		const request = new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers: { authorization: 'Bearer ttk_caller', 'content-type': 'application/json' },
			body: '{}',
		});
		const body = JSON.stringify(toolCall('browser_get_state', { session_id: 's1' }));
		const response = await forward(
			{ id: 'peer', url: `http://127.0.0.1:${port}`, role: 'browser', version: '0' },
			request,
			body,
			'me',
		);

		assertEquals(response.status, 200);
		assertEquals(response.headers.get('x-ttk-served-by'), 'peer');
		// The owning node authorizes with the caller's own credential; no node is
		// ever able to act as a principal it was not given.
		assertEquals(seen.auth, 'Bearer ttk_caller');
		assertEquals(seen.forwarded, 'me');
		assertEquals(seen.body, body);
		await response.body?.cancel();
	} finally {
		await peer.shutdown();
	}
});

Deno.test('routing: an unreachable owner is a clear error, not a hang', async () => {
	const { forward } = await import('./routing.ts');
	const request = new Request('http://127.0.0.1/mcp', { method: 'POST', body: '{}' });
	const response = await forward(
		{ id: 'dead', url: 'http://127.0.0.1:1', role: 'browser', version: '0' },
		request,
		'{}',
		'me',
	);
	assertEquals(response.status, 502);
	assertStringIncludes(await response.text(), 'unreachable');
});

// ---------------------------------------------------------------------------
// session files (E-33)
// ---------------------------------------------------------------------------

Deno.test('routing: the file tools never claim or place an unowned default session', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8020);
	try {
		const router = new Router({ cluster: a });
		for (const name of ['browser_list_files', 'browser_get_file']) {
			const route = await router.route(toolCall(name, { file_id: 'G1' }), false);
			assertEquals(route.kind, 'local', name);
		}
		assertEquals(await a.ownerOf('default'), null, 'peeking must not have claimed the session');
		// An ordinary tool still claims it.
		assertEquals((await router.route(toolCall('browser_get_state'), false)).kind, 'local');
		assertEquals((await a.ownerOf('default'))?.id, 'a');
	} finally {
		await a.close();
	}
});

Deno.test('routing: a file resource read goes to the owner; other resource reads stay local', async () => {
	await using kv = await store();
	const owner = await node(kv.path, 'owner', 'browser', 8021);
	const other = await node(kv.path, 'other', 'edge', 8022);
	try {
		await owner.adopt('s1');
		const router = new Router({ cluster: other });
		const read = (uri: string) => ({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } });

		const file = await router.route(read('ttk://session/s1/files/G1'), false);
		assertEquals(file.kind, 'forward');
		assert(file.kind === 'forward' && file.node.id === 'owner');
		assertStringIncludes(file.kind === 'forward' ? file.reason : '', 'file resource');

		assertEquals((await router.route(read('ttk://session/s1/state'), false)).kind, 'local');
		assertEquals((await router.route(read('ttk://session/nobody/files/G1'), false)).kind, 'local');
		assertEquals((await router.route(read('ttk://session/s1/files/G1'), true)).kind, 'local', 'one hop only');
		assertEquals((await new Router({ cluster: owner }).route(read('ttk://session/s1/files/G1'), false)).kind, 'local');
	} finally {
		await owner.close();
		await other.close();
	}
});

Deno.test('routing: forward can target a path other than /mcp, preserving the query', async () => {
	const seen: string[] = [];
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		seen.push(
			`${new URL(request.url).pathname}${new URL(request.url).search}|${request.headers.get(FORWARDED_HEADER)}`,
		);
		return new Response('bytes', { headers: { 'content-disposition': 'attachment' } });
	});
	try {
		const node: import('./cluster.ts').NodeInfo = {
			id: 'n',
			url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
			role: 'browser',
			version: '0',
		};
		const request = new Request('http://edge.local/api/v1/sessions/s1/files/G1?x=1', {
			headers: { authorization: 'Bearer k' },
		});
		const response = await forward(node, request, '', 'edge', '/api/v1/sessions/s1/files/G1?x=1');
		assertEquals(await response.text(), 'bytes');
		assertEquals(response.headers.get('x-ttk-served-by'), 'n');
		assertEquals(response.headers.get('content-disposition'), 'attachment', 'headers stream back untouched');
		assertEquals(seen, ['/api/v1/sessions/s1/files/G1?x=1|edge']);
	} finally {
		await server.shutdown();
	}
});

/**
 * The fan-out annotates each summary with the node it came from, and adds
 * `unreachable_nodes` when one did not answer. Those are wire fields, so
 * `browser_list_sessions`' declared `outputSchema` has to know about them.
 *
 * It has to be asserted here rather than trusted: a `z.object` emits
 * `additionalProperties: false`, so an SDK client validating the advertised
 * schema rejects the *whole* result over one undeclared key — which is how the
 * omission was found, on the browser tier, after every unit test had passed.
 */
Deno.test('routing: a fan-out payload validates against browser_list_sessions\u2019 output schema', () => {
	const summary = {
		session_id: 'default',
		created_at: '2026-01-01T00:00:00.000Z',
		last_used_at: '2026-01-01T00:00:01.000Z',
		tab_count: 1,
		viewer_count: 0,
		human_has_control: false,
	};
	const payload = {
		sessions: [
			{ ...summary, node_id: 'a', node_url: 'http://a.test' },
			{ ...summary, session_id: 'other', node_id: 'b', node_url: 'http://b.test' },
		],
		unreachable_nodes: ['c'],
	};
	const parsed = OUTPUT.browser_list_sessions.parse(payload);
	// Equality, not parseability: a stripped key is what a client would reject.
	assertEquals(parsed, payload);
});

/**
 * SR2-B7 — cluster disconnect propagation, verified rather than asserted.
 *
 * The owner's claim is that cancelling a forwarded response body aborts the
 * upstream fetch. `forward()` passes no `signal` to `fetch`, so the only way
 * that can be true is if the runtime propagates the consumer's `cancel()`
 * through the piped body to the upstream connection. That is a runtime fact
 * about Deno's `fetch`, not about this code, and a runtime fact is measured:
 * an upstream `Deno.serve` streams an SSE-shaped body whose `cancel()` sets an
 * observable flag; the body is forwarded, the *forwarded* body is cancelled,
 * and the upstream flag must flip inside a bounded wait.
 *
 * Cancellation is the stream's own `cancel()`, never `request.signal` (REJ-005).
 */
Deno.test('routing: cancelling a forwarded streaming body reaches the upstream stream (SR2-B7)', async () => {
	let upstreamCancelled = false;
	let ticks = 0;
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, () => {
		const encoder = new TextEncoder();
		let timer: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('event: control\ndata: {"event":"stream-open"}\n\n'));
				timer = setInterval(() => {
					ticks += 1;
					try {
						controller.enqueue(encoder.encode(`: keep-alive ${ticks}\n\n`));
					} catch {
						clearInterval(timer);
					}
				}, 20);
			},
			cancel() {
				upstreamCancelled = true;
				clearInterval(timer);
			},
		});
		return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
	});
	try {
		const node: import('./cluster.ts').NodeInfo = {
			id: 'n',
			url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
			role: 'browser',
			version: '0',
		};
		const request = new Request('http://edge.local/api/v1/sessions/s1/events', {
			headers: { authorization: 'Bearer k', accept: 'text/event-stream' },
		});
		const response = await forward(node, request, '', 'edge', '/api/v1/sessions/s1/events');
		assertEquals(response.status, 200);
		assert(response.body !== null);
		const reader = response.body.getReader();
		const first = await reader.read();
		assert(!first.done, 'the upstream body did not start streaming');
		// The consumer goes away: the stream's cancel(), not a request signal.
		await reader.cancel();
		const deadline = Date.now() + 3_000;
		while (!upstreamCancelled && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert(upstreamCancelled, `the upstream stream was never cancelled (${ticks} keep-alives after cancel)`);
	} finally {
		await server.shutdown();
	}
});

// ---------------------------------------------------------------------------
// R1 (D-121, AC15): background tool tasks in a cluster
// ---------------------------------------------------------------------------

const TASK_ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

Deno.test('routing (R1): a task id goes to the node that recorded it; an unrecorded one is looked for', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8030);
	const b = await node(kv.path, 'b', 'edge', 8031);
	try {
		await a.recordTask(TASK_ID);
		assertEquals((await b.taskNode(TASK_ID))?.id, 'a');
		const fromB = new Router({ cluster: b });
		for (const name of ['agent_get_task', 'agent_cancel_task']) {
			const route = await fromB.route(toolCall(name, { task_id: TASK_ID }), false);
			assert(route.kind === 'forward' && route.node.id === 'a', `${name}: ${JSON.stringify(route)}`);
			assertEquals((await new Router({ cluster: a }).route(toolCall(name, { task_id: TASK_ID }), false)).kind, 'local');
			// R3-5: nobody recorded it — yet, or ever. The record is written after the task is created, so a get that
			// races it would miss: this node answers if it can, and otherwise asks every other node (`firstFound`).
			const unrecorded = await fromB.route(toolCall(name, { task_id: crypto.randomUUID() }), false);
			assert(unrecorded.kind === 'find', `${name}: ${JSON.stringify(unrecorded)}`);
			assertEquals(unrecorded.nodes.map((n) => n.id).sort(), ['a', 'b']);
			assertEquals((await fromB.route(toolCall(name, {}), false)).kind, 'local');
			assertEquals((await fromB.route(toolCall(name, { task_id: TASK_ID }), true)).kind, 'local', 'one hop only');
		}
	} finally {
		await a.close();
		await b.close();
	}
});

Deno.test('routing (R1): a task whose node is away is looked for, and routes to it again when it rejoins', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8032);
	const b = await node(kv.path, 'b', 'browser', 8033);
	try {
		await a.recordTask(TASK_ID);
		await a.close(); // deregisters; a persisted task comes back with its node (B1), so the record is kept
		assertEquals(await b.taskNode(TASK_ID), null);
		const away = await new Router({ cluster: b }).route(toolCall('agent_get_task', { task_id: TASK_ID }), false);
		assert(away.kind === 'find', JSON.stringify(away));
		assertEquals(away.nodes.map((n) => n.id), ['b'], 'only the registered nodes are asked');
		const back = await node(kv.path, 'a', 'browser', 8032);
		try {
			assertEquals((await b.taskNode(TASK_ID))?.id, 'a', 'the record outlived the restart');
		} finally {
			await back.close();
		}
	} finally {
		await b.close();
	}
});

Deno.test('routing (R1): agent_run_tool goes where the session of the tool it runs lives', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8034);
	const b = await node(kv.path, 'b', 'browser', 8035);
	try {
		await a.adopt('mine');
		const fromB = new Router({ cluster: b });
		const run = (tool: unknown, args?: unknown) =>
			fromB.route(toolCall('agent_run_tool', { tool, ...(args === undefined ? {} : { arguments: args }) }), false);
		const click = await run('browser_click', { session_id: 'mine', index: 3 });
		assert(click.kind === 'forward' && click.node.id === 'a', JSON.stringify(click));
		// No browser session: served here, as every non-session extension tool is.
		for (const tool of ['sandbox_exec', 'file_read', 'agent_list_tasks', 'browser_teleport', 42]) {
			assertEquals((await run(tool, { session_id: 'mine' })).kind, 'local', String(tool));
		}
		// The cluster-wide and node-wide tools are not routed through a task: the handler refuses or answers locally.
		assertEquals((await run('browser_list_sessions')).kind, 'local');
		assertEquals((await run('browser_close_all')).kind, 'local');
		// A new session is placed as the call itself would be — here, on this node, which can host.
		assertEquals((await run('browser_navigate', { url: 'https://x.test/', new_session: true })).kind, 'local');
		// Malformed arguments route like an omitted session (this node claims `default`), never a crash.
		assertEquals((await run('browser_get_state', 'not-an-object')).kind, 'local');
		assertEquals((await b.ownerOf('default'))?.id, 'b');
	} finally {
		await a.close();
		await b.close();
	}
});

Deno.test('routing (R1): agent_list_tasks fans out as a task list, browser_list_sessions as a session list', async () => {
	await using kv = await store();
	const a = await node(kv.path, 'a', 'browser', 8036);
	const b = await node(kv.path, 'b', 'edge', 8037);
	try {
		const router = new Router({ cluster: b });
		const tasks = await router.route(toolCall('agent_list_tasks', { state: 'active' }), false);
		assert(tasks.kind === 'fan-out' && tasks.list === 'tasks', JSON.stringify(tasks));
		assertEquals(tasks.nodes.map((n) => n.id).sort(), ['a', 'b']);
		const sessions = await router.route(toolCall('browser_list_sessions'), false);
		assert(sessions.kind === 'fan-out' && sessions.list === 'sessions');
	} finally {
		await a.close();
		await b.close();
	}
});

/** One node's `agent_list_tasks` answer, as the MCP handler shapes it. */
function taskAnswer(id: number, tasks: Array<Record<string, unknown>>, truncated: boolean): string {
	const payload = { result: { tasks, truncated } };
	return JSON.stringify({
		jsonrpc: '2.0',
		id,
		result: {
			resultType: 'complete',
			content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
			structuredContent: payload,
		},
	});
}

const task = (id: string) => ({
	id,
	contextId: `ctx-${id}`,
	status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-04T00:00:00.000Z' },
	artifacts: [],
	history: [],
});

Deno.test('routing (R1): the task fan-out merges and tags every node, ORs truncated, and names the unreachable', async () => {
	const jsonHeaders = { 'content-type': 'application/json' };
	const peer = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		() => new Response(taskAnswer(9, [task('remote-1')], true), { headers: jsonHeaders }),
	);
	// A node that answers with a tool error has not told us its tasks: it is reported, not counted as empty.
	const refusing = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		() =>
			new Response(
				JSON.stringify({ jsonrpc: '2.0', id: 9, result: { isError: true, content: [{ type: 'text', text: 'x' }] } }),
				{ headers: jsonHeaders },
			),
	);
	const at = (server: Deno.HttpServer) => `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
	const self = { id: 'a', url: 'http://127.0.0.1:8038', role: 'browser' as const, version: '0' };
	const nodes = [
		self,
		{ id: 'b', url: at(peer), role: 'browser' as const, version: '0' },
		{ id: 'c', url: at(refusing), role: 'browser' as const, version: '0' },
		{ id: 'dead', url: 'http://127.0.0.1:1', role: 'browser' as const, version: '0' },
	];
	try {
		const merged = await fanOut(
			nodes,
			new Request('http://127.0.0.1/mcp', { method: 'POST', body: '{}' }),
			JSON.stringify(toolCall('agent_list_tasks')),
			self,
			() => Promise.resolve(new Response(taskAnswer(7, [task('local-1')], false), { headers: jsonHeaders })),
			'tasks',
		);
		const body = await merged.json() as {
			id: number;
			result: { resultType?: string; structuredContent: Record<string, unknown>; content: Array<{ text: string }> };
		};
		assertEquals(body.id, 7, 'the local envelope is the one reshaped');
		assertEquals(body.result.resultType, 'complete');
		const expected = {
			result: {
				tasks: [{ ...task('local-1'), node_id: 'a' }, { ...task('remote-1'), node_id: 'b' }],
				truncated: true,
				unreachable_nodes: ['c', 'dead'],
			},
		};
		assertEquals(body.result.structuredContent, expected);
		assertEquals(JSON.parse(body.result.content[0]!.text), expected, 'the text block says the same');
		// The merged payload is what agent_list_tasks declares: a client validating the schema accepts it whole.
		const schema = extensionTools({ agent_list_tasks: () => Promise.resolve({}) })[0]!.outputSchema;
		assertEquals(schema.parse(body.result.structuredContent), expected);
	} finally {
		await peer.shutdown();
		await refusing.shutdown();
	}
});

Deno.test('routing (R1): an answer that cannot be merged passes through intact, body and all', async () => {
	const self = { id: 'a', url: 'http://127.0.0.1:8039', role: 'browser' as const, version: '0' };
	const dead = { id: 'dead', url: 'http://127.0.0.1:1', role: 'browser' as const, version: '0' };
	const refusal = JSON.stringify({
		jsonrpc: '2.0',
		id: 3,
		result: { isError: true, content: [{ type: 'text', text: 'Error: scope-required: no' }] },
	});
	const rpcError = JSON.stringify({ jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'bad' } });
	for (const [list, answer] of [['tasks', refusal], ['tasks', rpcError], ['sessions', rpcError]] as const) {
		const passed = await fanOut(
			[self, dead],
			new Request('http://127.0.0.1/mcp', { method: 'POST', body: '{}' }),
			'{}',
			self,
			() => Promise.resolve(new Response(answer, { status: 200, headers: { 'content-type': 'application/json' } })),
			list,
		);
		assertEquals(passed.status, 200);
		assertEquals(await passed.text(), answer, `${list}: the local answer, unread and unmerged`);
	}
});
