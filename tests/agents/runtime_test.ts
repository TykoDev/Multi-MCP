import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import {
	AgentError,
	agentMessage,
	AgentRuntime,
	type AgentRuntimeOptions,
	type AgentTask,
	DurableJsonFile,
	INTERRUPTED_BY_RESTART,
	SANDBOX_SLOT_WAIT_MS,
	TASK_SLOTS,
	TASK_SLOTS_PER_OWNER,
	terminal,
	TOOL_BOUND_MARGIN_MS,
	TOOL_CALL_BOUND_MS,
	toolTaskBoundMs,
} from '../../packages/agents/mod.ts';
import type { ModelProviderClient, ModelTurn } from '../../packages/agents/mod.ts';

const scopes = new Set(['agent:invoke', 'mcp:invoke', 'sandbox:execute']);
function message(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		messageId: crypto.randomUUID(),
		role: 'ROLE_USER',
		parts: [{ data: { tool: 'sandbox_list', arguments: {} } }],
		...extra,
	};
}
async function finished(runtime: AgentRuntime, owner: string, id: string): Promise<AgentTask> {
	const reader = runtime.subscribe(owner, id).getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
		}
	} finally {
		reader.releaseLock();
	}
	return runtime.get(owner, id);
}

Deno.test('agent runtime enforces principal ownership, scopes, snapshots and terminal invariants', async (): Promise<void> => {
	const calls: unknown[] = [];
	const runtime = new AgentRuntime({
		invoke: (tool, args, owner, rights, signal): Promise<Record<string, unknown>> => {
			calls.push([tool, args, owner, [...rights], signal instanceof AbortSignal]);
			return Promise.resolve({ workspaces: [] });
		},
	});
	try {
		assertThrows(() => runtime.submit('alice', new Set(), message()), AgentError, 'scope');
		const created = runtime.submit('alice', scopes, message());
		assertEquals(created.status.state, 'TASK_STATE_SUBMITTED');
		created.artifacts.push({ forged: true });
		assertThrows(() => runtime.get('bob', created.id), AgentError, 'Task not found');
		assertThrows(() => runtime.cancel('bob', created.id), AgentError, 'Task not found');
		assertThrows(() => runtime.subscribe('bob', created.id), AgentError, 'Task not found');
		assertThrows(() => runtime.permission('bob', created.id), AgentError, 'Task not found');
		const done = await finished(runtime, 'alice', created.id);
		assertEquals(done.status.state, 'TASK_STATE_COMPLETED');
		assertEquals(done.artifacts.length, 1);
		assertEquals(calls, [['sandbox_list', {}, 'alice', [...scopes], true]]);
		assertEquals(runtime.list('bob'), []);
		assertEquals(runtime.get('alice', created.id, 0).history, []);
		assertThrows(() => runtime.get('alice', created.id, -1), AgentError);
		assertThrows(() => runtime.cancel('alice', created.id), AgentError, 'cannot be canceled');
		assertThrows(() => runtime.submit('alice', scopes, message({ taskId: created.id })), AgentError, 'Terminal');
		assertThrows(
			() => runtime.submit('bob', scopes, message({ contextId: done.contextId })),
			AgentError,
			'Context not found',
		);
		const next = runtime.submit('alice', scopes, message({ contextId: done.contextId }));
		assertEquals(next.contextId, done.contextId);
		await finished(runtime, 'alice', next.id);
	} finally {
		await runtime.close();
	}
});

Deno.test('task cancellation reaches executor and cannot be overwritten by a late result', async (): Promise<void> => {
	let signal: AbortSignal | undefined;
	let release: (value: Record<string, unknown>) => void = (): void => {};
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, _owner, _scopes, abort): Promise<Record<string, unknown>> => {
			signal = abort;
			return new Promise((resolve) => release = resolve);
		},
	});
	try {
		const task = runtime.submit('alice', scopes, message());
		await Promise.resolve();
		const consumer = runtime.subscribe('alice', task.id).getReader();
		await consumer.read();
		await consumer.cancel();
		consumer.releaseLock();
		assertEquals(signal?.aborted, false);
		assertEquals(runtime.cancel('alice', task.id).status.state, 'TASK_STATE_CANCELED');
		assertEquals(signal?.aborted, true);
		release({ late: true });
		await Promise.resolve();
		await Promise.resolve();
		assertEquals(runtime.get('alice', task.id).artifacts, []);
		assertEquals(runtime.get('alice', task.id).status.state, 'TASK_STATE_CANCELED');
	} finally {
		await runtime.close();
	}
});

Deno.test('bounded task queue executes at most four and retains at most 32 per owner', async (): Promise<void> => {
	const releases: (() => void)[] = [];
	let active = 0;
	let high = 0;
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => {
			active++;
			high = Math.max(high, active);
			return new Promise((resolve) =>
				releases.push(() => {
					active--;
					resolve({ ok: true });
				})
			);
		},
	});
	try {
		const tasks = Array.from(
			{ length: 32 },
			() => ({ owner: 'alice', task: runtime.submit('alice', scopes, message()) }),
		);
		assertThrows(() => runtime.submit('alice', scopes, message()), AgentError, 'capacity');
		for (let i = 0; i < 4; i++) tasks.push({ owner: 'bob', task: runtime.submit('bob', scopes, message()) });
		await settle();
		assertEquals(TASK_SLOTS, 4);
		assertEquals(active, TASK_SLOTS);
		assertEquals(high, TASK_SLOTS);
		for (const { owner, task } of tasks) {
			if (!terminal(runtime.get(owner, task.id).status.state)) runtime.cancel(owner, task.id);
		}
		for (const release of releases) release();
		await Promise.all(tasks.map(({ owner, task }) => finished(runtime, owner, task.id)));
	} finally {
		await runtime.close();
	}
});

Deno.test('R2-7: one owner runs at most two tasks at once, so another owner’s work is never starved', async () => {
	const releases = new Map<string, Array<() => void>>();
	const running = new Map<string, number>();
	const high = new Map<string, number>();
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, owner, _rights, signal): Promise<Record<string, unknown>> => {
			running.set(owner, (running.get(owner) ?? 0) + 1);
			high.set(owner, Math.max(high.get(owner) ?? 0, running.get(owner)!));
			return new Promise((resolve) => {
				const own = releases.get(owner) ?? [];
				own.push(() => {
					running.set(owner, running.get(owner)! - 1);
					resolve({ ok: true });
				});
				releases.set(owner, own);
				// Shutdown ends a held task too, so a failed assertion never leaves close() waiting.
				signal?.addEventListener('abort', () => resolve({}), { once: true });
			});
		},
	});
	try {
		assertEquals(TASK_SLOTS_PER_OWNER, 2);
		// Alice queues eight long tasks first; Bob's one arrives after all of them.
		const alice = Array.from({ length: 8 }, () => runtime.submit('alice', scopes, message()));
		const bob = runtime.submit('bob', scopes, message());
		await settle();
		assertEquals(running.get('alice'), TASK_SLOTS_PER_OWNER, 'alice holds her share, not every slot');
		assertEquals(running.get('bob'), 1, 'bob starts at once, ahead of alice’s queued work');
		assertEquals(runtime.get('bob', bob.id).status.state, 'TASK_STATE_WORKING');
		assertEquals(
			alice.filter((task) => runtime.get('alice', task.id).status.state === 'TASK_STATE_SUBMITTED').length,
			6,
		);
		// As alice's tasks finish, her queued ones take her slots, never more than her share at once.
		while ((releases.get('alice') ?? []).length > 0) {
			releases.get('alice')!.shift()!();
			await settle();
		}
		releases.get('bob')!.shift()!();
		await Promise.all(alice.map((task) => finished(runtime, 'alice', task.id)));
		assertEquals((await finished(runtime, 'bob', bob.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals(high.get('alice'), TASK_SLOTS_PER_OWNER);
	} finally {
		await runtime.close();
	}
});

Deno.test('tools fail explicitly; no configured backend means no fabricated text response', async (): Promise<void> => {
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ isError: true }),
	});
	try {
		// D-143: reworded to name both text backends; the `configured ACP` match the test always made still holds.
		const refused = assertThrows(
			() => runtime.submit('alice', scopes, message({ parts: [{ text: 'Make an app' }] })),
			AgentError,
			'configured ACP',
		);
		assertEquals(refused.message, 'Text execution requires a configured ACP agent or a model provider');
		const task = runtime.submit('alice', new Set(['agent:invoke']), message());
		assertEquals((await finished(runtime, 'alice', task.id)).status.state, 'TASK_STATE_FAILED');
		const failure = runtime.submit('alice', scopes, message());
		assertEquals((await finished(runtime, 'alice', failure.id)).status.state, 'TASK_STATE_FAILED');
		const large = new AgentRuntime({
			invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ output: 'x'.repeat(1024 * 1024) }),
		});
		try {
			const big = large.submit('alice', scopes, message());
			assertEquals((await finished(large, 'alice', big.id)).status.state, 'TASK_STATE_FAILED');
			assertEquals(large.get('alice', big.id).artifacts.length, 0);
		} finally {
			await large.close();
		}
	} finally {
		await runtime.close();
	}
	assertThrows(() => runtime.submit('alice', scopes, message()), AgentError, 'closed');
});

/** Lets queued microtasks and the pump settle without sleeping on a wall clock. */
async function settle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
/** The owners `fillSlots` submits as: two, since one owner holds at most TASK_SLOTS_PER_OWNER slots (R2-7). */
const FILLERS = ['filler', 'filler-2'];
/** Four tasks that hold every execution slot until released, so the next submission queues. */
function fillSlots(runtime: AgentRuntime, credential = 'filler-key'): { owner: string; task: AgentTask }[] {
	return Array.from({ length: TASK_SLOTS }, (_, i) => {
		const owner = FILLERS[i % FILLERS.length]!;
		return { owner, task: runtime.submit(owner, scopes, message(), credential) };
	});
}
function statusText(task: AgentTask): string {
	return String(task.status.message?.parts.map((part) => part.text ?? '').join(''));
}

Deno.test('GW-1 PROBE-1: a queued task re-authorizes at start and never runs on scopes its credential lost', async (): Promise<void> => {
	const granted = new Map<string, ReadonlySet<string> | null>([
		['filler-key', scopes],
		['alice-key', scopes],
		['carol-key', scopes],
	]);
	const releases: (() => void)[] = [];
	const calls: [string, string[]][] = [];
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, owner, rights): Promise<Record<string, unknown>> => {
			calls.push([owner, [...rights]]);
			if (!FILLERS.includes(owner)) return Promise.resolve({ ok: true });
			return new Promise((resolve) => releases.push(() => resolve({ ok: true })));
		},
		authorize: (_owner, _scopes, credential) => granted.get(credential ?? '') ?? null,
	});
	try {
		const fillers = fillSlots(runtime);
		const revoked = runtime.submit('alice', scopes, message(), 'alice-key');
		const narrowed = runtime.submit('carol', scopes, message(), 'carol-key');
		await settle();
		assertEquals(calls.length, 4, 'four slots run; the rest wait');
		assertEquals(runtime.get('alice', revoked.id).status.state, 'TASK_STATE_SUBMITTED');
		// The operator removes alice's key and narrows carol's while both tasks wait for a slot.
		granted.set('alice-key', null);
		granted.set('carol-key', new Set(['agent:invoke', 'mcp:invoke']));
		for (const release of releases) release();
		await Promise.all(fillers.map(({ owner, task }) => finished(runtime, owner, task.id)));
		const refused = await finished(runtime, 'alice', revoked.id);
		assertEquals(refused.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(statusText(refused), 'no longer authorized');
		assertEquals(refused.artifacts, []);
		assertEquals(calls.some(([owner]) => owner === 'alice'), false, 'a revoked credential never reaches invoke');
		assertEquals((await finished(runtime, 'carol', narrowed.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals(calls.find(([owner]) => owner === 'carol')?.[1], ['agent:invoke', 'mcp:invoke']);
	} finally {
		await runtime.close();
	}
});

Deno.test('GW-1: every structured tool call re-reads the credential, so a revocation mid-task stops the next call', async (): Promise<void> => {
	let live = true;
	const calls: string[] = [];
	let release: () => void = (): void => {};
	const runtime = new AgentRuntime({
		invoke: (tool): Promise<Record<string, unknown>> => {
			calls.push(tool);
			return calls.length === 1 ? new Promise((resolve) => release = () => resolve({ ok: true })) : Promise.resolve({});
		},
		authorize: (_owner, submitted) => live ? submitted : null,
	});
	try {
		const task = runtime.submit('alice', scopes, {
			...message(),
			parts: [{ data: { tool: 'sandbox_list', arguments: {} } }, { data: { tool: 'sandbox_exec', arguments: {} } }],
		}, 'alice-key');
		await settle();
		assertEquals(calls, ['sandbox_list']);
		live = false;
		release();
		const done = await finished(runtime, 'alice', task.id);
		assertEquals(done.status.state, 'TASK_STATE_FAILED');
		assertEquals(calls, ['sandbox_list'], 'the second call never ran on the revoked credential');
	} finally {
		await runtime.close();
	}
});

Deno.test('GW-1: reauthorize() fails a revoked credential’s running and queued tasks at once', async (): Promise<void> => {
	const live = new Set(['filler-key', 'alice-key']);
	const signals: AbortSignal[] = [];
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, _owner, _rights, signal): Promise<Record<string, unknown>> => {
			if (signal) signals.push(signal);
			return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true }));
		},
		authorize: (_owner, submitted, credential) => live.has(credential ?? '') ? submitted : null,
	});
	try {
		const running = runtime.submit('alice', scopes, message(), 'alice-key');
		fillSlots(runtime);
		const queued = runtime.submit('alice', scopes, message(), 'alice-key');
		await settle();
		live.delete('alice-key');
		runtime.reauthorize();
		for (const id of [running.id, queued.id]) {
			const task = runtime.get('alice', id);
			assertEquals(task.status.state, 'TASK_STATE_FAILED');
			assertStringIncludes(statusText(task), 'no longer authorized');
		}
		assertEquals(signals[0]?.aborted, true, 'the running task’s executor is aborted');
		for (const owner of FILLERS) {
			assertEquals(runtime.list(owner).some((task) => terminal(task.status.state)), false, 'other credentials run on');
		}
	} finally {
		await runtime.close();
	}
});

Deno.test('GW-1: a task waiting past its queue deadline fails without running', async (): Promise<void> => {
	const releases: (() => void)[] = [];
	const owners: string[] = [];
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, owner): Promise<Record<string, unknown>> => {
			owners.push(owner);
			return FILLERS.includes(owner) ? new Promise((resolve) => releases.push(() => resolve({}))) : Promise.resolve({});
		},
		queueDeadlineMs: 20,
	});
	try {
		const fillers = fillSlots(runtime);
		const late = runtime.submit('alice', scopes, message());
		await new Promise((resolve) => setTimeout(resolve, 60));
		for (const release of releases) release();
		await Promise.all(fillers.map(({ owner, task }) => finished(runtime, owner, task.id)));
		const expired = await finished(runtime, 'alice', late.id);
		assertEquals(expired.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(statusText(expired), 'queue deadline');
		assertEquals(owners.includes('alice'), false);
	} finally {
		await runtime.close();
	}
});

Deno.test('AG-1: finished tasks never hold capacity; the oldest finished are evicted, the caller’s first', async (): Promise<void> => {
	const runtime = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ ok: true }) });
	try {
		const own: AgentTask[] = [];
		for (let i = 0; i < 32; i++) {
			own.push(runtime.submit('alice', scopes, message()));
			await finished(runtime, 'alice', own.at(-1)!.id);
		}
		// Thirty-two completed tasks used to refuse the thirty-third for the full hour of retention.
		const next = runtime.submit('alice', scopes, message());
		await finished(runtime, 'alice', next.id);
		assertThrows(() => runtime.get('alice', own[0]!.id), AgentError, 'Task not found');
		assertEquals(runtime.list('alice').length, 32);
		// Fill the global 256 with seven more principals' completed work, then a ninth principal arrives.
		for (let p = 1; p < 8; p++) {
			for (let i = 0; i < 32; i++) await finished(runtime, `p${p}`, runtime.submit(`p${p}`, scopes, message()).id);
		}
		const oldestOther = runtime.list('p1').at(-1)!;
		const newcomer = runtime.submit('p9', scopes, message());
		await finished(runtime, 'p9', newcomer.id);
		assertEquals(runtime.list('p9').length, 1);
		assertEquals(runtime.list('alice').length, 31, 'the global cap evicts the oldest finished task first');
		assertEquals(runtime.get('p1', oldestOther.id).id, oldestOther.id);
	} finally {
		await runtime.close();
	}
});

Deno.test('AG-1: unfinished tasks still fill the global cap and refuse new work', async (): Promise<void> => {
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, _owner, _rights, signal): Promise<Record<string, unknown>> =>
			new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true })),
	});
	try {
		for (let p = 0; p < 8; p++) for (let i = 0; i < 32; i++) runtime.submit(`p${p}`, scopes, message());
		assertThrows(() => runtime.submit('p9', scopes, message()), AgentError, 'capacity');
	} finally {
		await runtime.close();
	}
});

Deno.test('AG-10: the runtime keeps no per-task replay buffer it never reads', async (): Promise<void> => {
	// A late subscriber already receives the full task snapshot first, so a replay of buffered events would only
	// duplicate it; the buffer was 256 events / 2 MiB per task of retained memory with no reader.
	const source = await Deno.readTextFile(new URL('../../packages/agents/src/runtime.ts', import.meta.url));
	assertEquals(/eventBytes|events:\s*Record<string, unknown>\[\]/.test(source), false);
});

/** A minimal in-process stand-in for the private runner's HTTP protocol, as `AgentBridgeClient` speaks it. */
function fakeBridge(hooks: {
	permission?: (id: string) => Promise<void>;
	/** Answers an RPC before the defaults do; `undefined` falls through. */
	rpc?: (method: string, params: Record<string, unknown>) => Response | undefined;
} = {}): {
	options: { url: string; token: string; agent: string };
	push(event: Record<string, unknown>): void;
	finish(): void;
	close(): Promise<void>;
} {
	let events: ReadableStreamDefaultController<Uint8Array> | undefined;
	// A `finish()` that arrives before the prompt does is remembered, not lost: under
	// parallel load a test can reach `finish()` before the runtime's prompt request
	// reaches this fake, and a lost release used to hold the prompt until its 120 s
	// timeout failed the task.
	let prompt: (() => void) | null = null;
	let released = 0;
	const release = (): void => {
		if (prompt === null) released++;
		else {
			const held = prompt;
			prompt = null;
			held();
		}
	};
	const pending: Record<string, unknown>[] = [];
	const push = (event: Record<string, unknown>): void => {
		if (events) events.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
		else pending.push(event);
	};
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen(): void {} }, async (request) => {
		const path = new URL(request.url).pathname;
		if (path === '/v1/events') {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller): void {
						events = controller;
						for (const event of pending.splice(0)) push(event);
					},
					cancel(): void {
						events = undefined;
					},
				}),
			);
		}
		const body = await request.json() as Record<string, unknown>;
		if (path === '/v1/open') return Response.json({ connectionId: 'connection-1', cwd: 'workspace-1' });
		if (path === '/v1/permission') {
			await hooks.permission?.(String(body.id));
			return Response.json({});
		}
		if (path === '/v1/close') {
			try {
				events?.close();
			} catch { /* Already closed by the client. */ }
			events = undefined;
			return Response.json({});
		}
		const custom = hooks.rpc?.(String(body.method), (body.params ?? {}) as Record<string, unknown>);
		if (custom !== undefined) return custom;
		if (body.method === 'session/new') return Response.json({ sessionId: 'session-1' });
		if (body.method === 'session/prompt') {
			if (released > 0) released--;
			else await new Promise<void>((resolve) => prompt = resolve);
			push({ method: 'bridge/prompt_complete' });
			return Response.json({ stopReason: 'end_turn' });
		}
		return Response.json({});
	});
	return {
		options: { url: `http://127.0.0.1:${server.addr.port}`, token: 'fake-bridge-token-long-enough', agent: 'fake' },
		push,
		finish: release,
		// A held prompt is an in-flight request, and shutdown waits for every one: release it so a failed
		// assertion ends the test instead of hanging it.
		close: () => {
			release();
			return server.shutdown();
		},
	};
}

function permissionRequest(id: string): Record<string, unknown> {
	return {
		jsonrpc: '2.0',
		id,
		method: 'session/request_permission',
		params: { options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] },
	};
}

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

Deno.test('AG-7: a decision cannot overwrite the INPUT_REQUIRED of a permission raised while it was in flight', async (): Promise<void> => {
	let taskId = '';
	const bridge = fakeBridge({
		permission: async (id): Promise<void> => {
			if (id !== 'first') return;
			// The runner asks again before it acknowledges the first decision.
			bridge.push(permissionRequest('second'));
			await until(() => runtime.permission('alice', taskId)?.id === 'second', 'the second request');
		},
	});
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
	});
	try {
		taskId = runtime.submit('alice', scopes, { ...message(), parts: [{ text: 'needs two permissions' }] }).id;
		bridge.push(permissionRequest('first'));
		await until(() => runtime.permission('alice', taskId)?.id === 'first', 'the first request');
		await runtime.decidePermission('alice', taskId, 'first', 'once');
		assertEquals(runtime.get('alice', taskId).status.state, 'TASK_STATE_INPUT_REQUIRED');
		assertEquals(runtime.permission('alice', taskId)?.id, 'second');
		await runtime.decidePermission('alice', taskId, 'second', 'no');
		assertEquals(runtime.get('alice', taskId).status.state, 'TASK_STATE_WORKING');
		bridge.finish();
		assertEquals((await finished(runtime, 'alice', taskId)).status.state, 'TASK_STATE_COMPLETED');
	} finally {
		await runtime.close();
		await bridge.close();
	}
});

Deno.test('GW-1 PROBE-2: an ACP task asks for its delegation with its own credential and current scopes', async (): Promise<void> => {
	const bridge = fakeBridge();
	const asked: [string, string[], string | undefined][] = [];
	let live = true;
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
		authorize: (_owner, _scopes, credential) =>
			live && credential === 'alice-key' ? new Set(['agent:invoke', 'mcp:invoke']) : null,
		sessionMcp: (owner, rights, credential) => {
			asked.push([owner, [...rights], credential]);
			return { servers: [], close(): void {} };
		},
	});
	try {
		const task = runtime.submit('alice', scopes, { ...message(), parts: [{ text: 'hello' }] }, 'alice-key');
		await until(() => asked.length === 1, 'the delegation request');
		assertEquals(asked[0], ['alice', ['agent:invoke', 'mcp:invoke'], 'alice-key']);
		bridge.finish();
		assertEquals((await finished(runtime, 'alice', task.id)).status.state, 'TASK_STATE_COMPLETED');
		// After rotation the pre-rotation credential no longer authorizes, so a queued prompt never asks at all.
		live = false;
		const stale = runtime.submit('alice', scopes, { ...message(), parts: [{ text: 'again' }] }, 'alice-key');
		const refused = await finished(runtime, 'alice', stale.id);
		assertEquals(refused.status.state, 'TASK_STATE_FAILED');
		assertEquals(asked.length, 1);
	} finally {
		await runtime.close();
		await bridge.close();
	}
});

Deno.test('AG-8: a delegation token split across agent message chunks never reaches events or artifacts', async (): Promise<void> => {
	const token = `ttkd_${crypto.randomUUID()}${crypto.randomUUID()}`;
	const bridge = fakeBridge();
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
		sessionMcp: () => ({
			servers: [{
				type: 'http',
				name: 'tykotech',
				url: 'http://gateway/mcp',
				headers: [
					{ name: 'Authorization', value: `Bearer ${token}` },
				],
			}],
			close(): void {},
		}),
	});
	const chunk = (text: string): Record<string, unknown> => ({
		jsonrpc: '2.0',
		method: 'session/update',
		params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
	});
	try {
		const task = runtime.submit('alice', scopes, { ...message(), parts: [{ text: 'leak it' }] });
		const reader = runtime.subscribe('alice', task.id).getReader();
		// Each line alone is innocent, so the runner's per-line redaction cannot see the token.
		for (const part of ['my credential is ', token.slice(0, 20), token.slice(20, 50), token.slice(50), ' — done']) {
			bridge.push(chunk(part));
		}
		await settle();
		bridge.finish();
		const seen: string[] = [];
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			seen.push(JSON.stringify(next.value));
		}
		const done = runtime.get('alice', task.id);
		assertEquals(done.status.state, 'TASK_STATE_COMPLETED');
		const parts = (done.artifacts[0]?.parts ?? []) as { text?: string }[];
		const text = parts.map((part) => part.text ?? '').join('');
		assertEquals(text, 'my credential is [REDACTED] — done');
		// Each fragment lies wholly inside one chunk, so a per-chunk emission would carry it.
		for (const fragment of [token.slice(1, 19), token.slice(21, 49), token.slice(51)]) {
			for (const value of [...seen, JSON.stringify(done)]) {
				assertEquals(value.includes(fragment), false, 'no fragment of the token is emitted');
			}
		}
	} finally {
		await runtime.close();
		await bridge.close();
	}
});

Deno.test('A2A message validation rejects old envelopes, external file URLs and oversize prompts', (): void => {
	assertThrows(() => agentMessage(null), AgentError);
	assertThrows(() => agentMessage(message({ role: 'user' })), AgentError);
	assertThrows(() => agentMessage(message({ parts: [] })), AgentError);
	assertThrows(() => agentMessage(message({ parts: [{ kind: 'text', text: 'old' }] })), AgentError);
	assertThrows(() => agentMessage(message({ parts: [{ url: 'http://169.254.169.254/' }] })), AgentError);
	assertThrows(() => agentMessage(message({ parts: [{ text: 'a', data: {} }] })), AgentError);
	assertThrows(() => agentMessage(message({ parts: [{ text: 'é'.repeat(40_000) }] })), AgentError);
	assertThrows(() => agentMessage(message({ parts: [{ text: 10 }] })), AgentError);
	assert(agentMessage(message()).parts.length === 1);
});

Deno.test('E-5: a follow-up message answers a pending permission, and the exchange is kept in history', async () => {
	const decided: string[] = [];
	const bridge = fakeBridge({
		permission: (id): Promise<void> => {
			decided.push(id);
			return Promise.resolve();
		},
	});
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
	});
	try {
		const task = runtime.submit('alice', scopes, { ...message(), parts: [{ text: 'do it' }] });
		bridge.push(permissionRequest('p1'));
		await until(() => runtime.permission('alice', task.id)?.id === 'p1', 'the permission request');
		// A wrong option and a plain text reply are refused; the offered option is accepted.
		assertThrows(() =>
			runtime.submit('alice', scopes, { ...message(), taskId: task.id, parts: [{ data: { optionId: 'always' } }] })
		);
		assertThrows(() => runtime.submit('alice', scopes, { ...message(), taskId: task.id, parts: [{ text: 'yes' }] }));
		// Another owner cannot answer it.
		assertThrows(() =>
			runtime.submit('bob', scopes, { ...message(), taskId: task.id, parts: [{ data: { optionId: 'once' } }] })
		);
		const answered = runtime.submit('alice', scopes, {
			...message(),
			taskId: task.id,
			parts: [{ data: { optionId: 'once' } }],
		});
		assertEquals(answered.id, task.id);
		await until(() => decided.includes('p1'), 'the decision reaching the runner');
		bridge.push({
			method: 'session/update',
			params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } },
		});
		bridge.finish();
		const done = await finished(runtime, 'alice', task.id);
		assertEquals(done.status.state, 'TASK_STATE_COMPLETED');
		assertEquals(done.history.map((entry) => entry.role), ['ROLE_USER', 'ROLE_USER', 'ROLE_AGENT']);
		assertEquals((done.history[2]!.parts[0] as { text: string }).text, 'done');
		// A finished task takes no more messages.
		assertThrows(() =>
			runtime.submit('alice', scopes, { ...message(), taskId: task.id, parts: [{ data: { optionId: 'once' } }] })
		);
	} finally {
		await runtime.close();
		await bridge.close();
	}
});

Deno.test('E-5: tool calls and plans reach task subscribers, redacted', async () => {
	const token = `ttkd_${crypto.randomUUID()}${crypto.randomUUID()}`;
	const bridge = fakeBridge();
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
		sessionMcp: () => ({
			servers: [{
				type: 'http',
				name: 't',
				url: 'http://x/mcp',
				headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
			}],
			close(): void {},
		}),
	});
	try {
		const task = runtime.submit('alice', scopes, { ...message(), parts: [{ text: 'plan it' }] });
		const reader = runtime.subscribe('alice', task.id).getReader();
		bridge.push({
			method: 'session/update',
			params: { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: `call with ${token}` } },
		});
		bridge.push({ method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: [] } } });
		const seen: unknown[] = [];
		const deadline = Date.now() + 5_000;
		while (seen.length < 2 && Date.now() < deadline) {
			const { value } = await reader.read();
			const data =
				(value as { statusUpdate?: { status?: { message?: { parts?: Array<{ data?: { acp?: unknown } }> } } } })
					?.statusUpdate?.status?.message?.parts?.[0]?.data?.acp;
			if (data !== undefined) seen.push(data);
		}
		await reader.cancel();
		assertEquals(seen.length, 2);
		assertEquals(JSON.stringify(seen).includes(token), false, 'the delegation token was redacted');
		assertEquals((seen[0] as { title: string }).title, 'call with [REDACTED]');
		bridge.finish();
		await finished(runtime, 'alice', task.id);
	} finally {
		await runtime.close();
		await bridge.close();
	}
});

Deno.test('E-2: an advertised, configured auth method is used; without one the task ends auth-required', async () => {
	const calls: string[] = [];
	let authenticated = false;
	const bridge = fakeBridge({
		rpc: (method, params) => {
			calls.push(method === 'authenticate' ? `authenticate:${String(params.methodId)}` : method);
			if (method === 'initialize') {
				return Response.json({ protocolVersion: 1, authMethods: [{ id: 'api-key', name: 'API key' }] });
			}
			if (method === 'authenticate') {
				authenticated = true;
				return Response.json({});
			}
			if (method === 'session/new' && !authenticated) {
				return Response.json({ error: { code: -32000, message: 'Agent requires authentication' } }, { status: 400 });
			}
			return undefined;
		},
	});
	const configured = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: { ...bridge.options, authMethod: 'api-key' },
	});
	try {
		const task = configured.submit('alice', scopes, { ...message(), parts: [{ text: 'hi' }] });
		bridge.finish();
		assertEquals((await finished(configured, 'alice', task.id)).status.state, 'TASK_STATE_COMPLETED');
		assert(calls.includes('authenticate:api-key'));
	} finally {
		await configured.close();
	}
	authenticated = false;
	const unconfigured = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
	});
	try {
		const task = unconfigured.submit('alice', scopes, { ...message(), parts: [{ text: 'hi' }] });
		await until(() => unconfigured.get('alice', task.id).status.state === 'TASK_STATE_AUTH_REQUIRED', 'auth-required');
		const status = unconfigured.get('alice', task.id).status as { message?: { parts: Array<{ text: string }> } };
		assert(status.message?.parts[0]?.text.includes('API key'));
		assert(status.message?.parts[0]?.text.includes('TTK_AGENT_AUTH_METHOD'));
		// Still cancellable.
		assertEquals(unconfigured.cancel('alice', task.id).status.state, 'TASK_STATE_CANCELED');
	} finally {
		await unconfigured.close();
		await bridge.close();
	}
});

// --- B1 / G5: durable tasks (AC4) ------------------------------------------------------------------------------

/** A fresh scratch directory for one test's `tasks.json`; the test tiers grant writes under tests/.scratch only. */
async function scratch(): Promise<{ dir: string; path: string }> {
	const dir = `tests/.scratch/agent-tasks-${crypto.randomUUID()}`;
	await Deno.mkdir(dir, { recursive: true });
	return { dir, path: `${dir}/agents/tasks.json` };
}

Deno.test('B1 / AC4: finished work, history, artifacts and idempotency keys survive a restart; running work comes back failed', async () => {
	const { dir, path } = await scratch();
	const first = new AgentRuntime({
		// The held tool runs until shutdown aborts it, as a real long command would.
		invoke: (tool, _args, _owner, _scopes, signal): Promise<Record<string, unknown>> =>
			tool === 'sandbox_exec'
				? new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ late: true }), { once: true }))
				: Promise.resolve({ workspaces: [] }),
		persistPath: path,
	});
	const done = message();
	const held = message({ parts: [{ data: { tool: 'sandbox_exec', arguments: { command: 'sleep 1' } } }] });
	let second: AgentRuntime | undefined;
	try {
		const completed = first.submit('alice', scopes, done, 'alice-credential-fingerprint');
		assertEquals((await finished(first, 'alice', completed.id)).status.state, 'TASK_STATE_COMPLETED');
		// Debounced, never more than 250 ms behind: the completed task is on disk without a flush.
		await until(() => {
			try {
				return Deno.readTextFileSync(path).includes('TASK_STATE_COMPLETED');
			} catch {
				return false;
			}
		}, 'the debounced write');
		const running = first.submit('alice', scopes, held, 'alice-credential-fingerprint');
		await until(() => first.get('alice', running.id).status.state === 'TASK_STATE_WORKING', 'a running task');
		await first.close();

		let invoked = 0;
		second = new AgentRuntime({
			invoke: (): Promise<Record<string, unknown>> => {
				invoked++;
				return Promise.resolve({});
			},
			persistPath: path,
		});
		const restored = second.get('alice', completed.id);
		assertEquals(restored.status.state, 'TASK_STATE_COMPLETED');
		assertEquals(restored.artifacts.length, 1);
		assertEquals(restored.history.length, 1);
		const interrupted = second.get('alice', running.id);
		assertEquals(interrupted.status.state, 'TASK_STATE_FAILED');
		assertEquals(statusText(interrupted), INTERRUPTED_BY_RESTART);
		assertThrows(() => second!.get('bob', completed.id), AgentError, 'Task not found');
		// E-3 survives the restart: the client's retry finds its task and nothing runs again.
		assertEquals(second.submit('alice', scopes, done).id, completed.id);
		assertEquals(second.submit('alice', scopes, held).id, running.id);
		await settle();
		assertEquals(invoked, 0, 'a restored task is never re-executed');
		// The restart's own transition is written back.
		await second.flush();
		const document = JSON.parse(await Deno.readTextFile(path));
		assertEquals(document.version, 1);
		assertEquals(document.tasks.length, 2);
		assertEquals(document.idempotency.length, 2);
		const failed = document.tasks.find((entry: { task: AgentTask }) => entry.task.id === running.id);
		assertEquals(failed.task.status.state, 'TASK_STATE_FAILED');
		const text = JSON.stringify(document);
		assertEquals(text.includes('alice-credential-fingerprint'), false, 'credential fingerprints are not persisted');
		assertEquals(text.includes('agent:invoke'), false, 'scopes are not persisted');
		if (Deno.build.os !== 'windows') assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
	} finally {
		await first.close();
		await second?.close();
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('B1: a restart drops finished tasks past retention and skips malformed entries; no data dir means no file', async () => {
	const { dir, path } = await scratch();
	const now = Date.now();
	const stored = (id: string, finishedAt: number | undefined, state: string): Record<string, unknown> => ({
		owner: 'alice',
		created: now - 10_000,
		...(finishedAt === undefined ? {} : { finished: finishedAt }),
		task: {
			id,
			contextId: `${id}-context`,
			status: { state, timestamp: new Date(now).toISOString() },
			artifacts: [],
			history: [],
		},
	});
	await Deno.mkdir(`${dir}/agents`, { recursive: true });
	await Deno.writeTextFile(
		path,
		JSON.stringify({
			version: 1,
			tasks: [
				stored('fresh', now - 1_000, 'TASK_STATE_COMPLETED'),
				stored('stale', now - 120_000, 'TASK_STATE_COMPLETED'),
				stored('queued', undefined, 'TASK_STATE_SUBMITTED'),
				stored('waiting', undefined, 'TASK_STATE_INPUT_REQUIRED'),
				{ owner: 'alice', task: { id: 'broken' } },
			],
			idempotency: [['alice\u0000m-1', 'fresh'], ['mallory\u0000m-2', 'fresh']],
		}),
	);
	const warnings: string[] = [];
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		persistPath: path,
		retentionMs: 60_000,
		logger: { warn: (line): void => void warnings.push(line) },
	});
	try {
		assertEquals(runtime.list('alice').map((task) => task.id).sort(), ['fresh', 'queued', 'waiting']);
		for (const id of ['queued', 'waiting']) {
			assertEquals(runtime.get('alice', id).status.state, 'TASK_STATE_FAILED');
			assertEquals(statusText(runtime.get('alice', id)), INTERRUPTED_BY_RESTART);
		}
		assertEquals(runtime.permission('alice', 'waiting'), undefined, 'a pending permission does not survive');
		assert(warnings.some((line) => line.includes('malformed')), warnings.join('\n'));
		// An idempotency key naming another owner's task is not restored.
		const mallory = runtime.submit('mallory', scopes, message({ messageId: 'm-2' }));
		assert(mallory.id !== 'fresh');
		await finished(runtime, 'mallory', mallory.id);
	} finally {
		await runtime.close();
		await Deno.remove(dir, { recursive: true });
	}
	const memory = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}) });
	await finished(memory, 'alice', memory.submit('alice', scopes, message()).id);
	await memory.close();
});

Deno.test('R2-8: a durable document is synced before its rename, its folder after, and never left half-written', async () => {
	const { dir } = await scratch();
	const path = `${dir}/agents/surfaces.json`;
	const proto = Deno.FsFile.prototype;
	const { syncData, sync } = proto;
	const calls: string[] = [];
	const exists = (): boolean => {
		try {
			Deno.statSync(path);
			return true;
		} catch {
			return false;
		}
	};
	proto.syncData = function (this: Deno.FsFile): Promise<void> {
		calls.push(exists() ? 'syncData after a rename' : 'syncData before the rename');
		return syncData.call(this);
	};
	proto.sync = function (this: Deno.FsFile): Promise<void> {
		calls.push(exists() ? 'sync after the rename' : 'sync before the rename');
		return sync.call(this);
	};
	try {
		const file = new DurableJsonFile(path, { debounceMs: 0 });
		file.schedule(() => ({ version: 1, n: 1 }));
		await file.flush();
		assertEquals(JSON.parse(await Deno.readTextFile(path)), { version: 1, n: 1 });
		// The data reached the disk before the name pointed at it: a power loss cannot leave an empty document.
		assertEquals(calls[0], 'syncData before the rename');
		// And the folder after the rename, where the platform opens a folder (Windows does not).
		if (Deno.build.os !== 'windows') assert(calls.includes('sync after the rename'), calls.join(', '));
		file.schedule(() => ({ version: 1, n: 2 }));
		await file.close();
		assertEquals(JSON.parse(await Deno.readTextFile(path)), { version: 1, n: 2 });
		const left: string[] = [];
		for await (const entry of Deno.readDir(`${dir}/agents`)) left.push(entry.name);
		assertEquals(left, ['surfaces.json'], 'no temporary file is left beside it');
		if (Deno.build.os !== 'windows') assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
	} finally {
		proto.syncData = syncData;
		proto.sync = sync;
		await Deno.remove(dir, { recursive: true });
	}
});

// --- C4 / G10: per-kind execution bounds -----------------------------------------------------------------------

Deno.test('C4 / G10: a tool task is bounded by its tool, clamped to what the tool accepts', () => {
	const margin = TOOL_BOUND_MARGIN_MS;
	assertEquals(toolTaskBoundMs('sandbox_exec', {}), 300_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('sandbox_exec', { timeout_ms: 900_000 }), 900_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('sandbox_exec', { timeout_ms: 1e12 }), 900_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('sandbox_exec', { timeout_ms: 'forever' }), 300_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('browser_wait_for', {}), 10_000 + margin);
	assertEquals(toolTaskBoundMs('browser_wait_for', { timeout_ms: 60_000 }), 60_000 + margin);
	assertEquals(toolTaskBoundMs('browser_click', { timeout_ms: 900_000 }), TOOL_CALL_BOUND_MS);
});

Deno.test('C4: a 15-minute sandbox_exec submitted as a task is not cut at 120 s, and is cut at its own bound', async () => {
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, _owner, _scopes, signal): Promise<Record<string, unknown>> =>
			new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true })),
	});
	const time = new FakeTime();
	try {
		const task = runtime.submit(
			'alice',
			scopes,
			message({ parts: [{ data: { tool: 'sandbox_exec', arguments: { timeout_ms: 900_000 } } }] }),
		);
		await time.runMicrotasks();
		assertEquals(runtime.get('alice', task.id).status.state, 'TASK_STATE_WORKING');
		await time.tickAsync(121_000);
		assertEquals(runtime.get('alice', task.id).status.state, 'TASK_STATE_WORKING', 'the old flat 120 s cap is gone');
		await time.tickAsync(toolTaskBoundMs('sandbox_exec', { timeout_ms: 900_000 }) - 121_000);
		const cut = runtime.get('alice', task.id);
		assertEquals(cut.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(statusText(cut), 'timed out');
	} finally {
		time.restore();
		await runtime.close();
	}
});

Deno.test('C4: a text task is bounded by the operator’s TTK_AGENT_TASK_TIMEOUT_S', async () => {
	const bridge = fakeBridge();
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
		taskTimeoutMs: 100,
	});
	try {
		const task = runtime.submit('alice', scopes, { messageId: 'slow', role: 'ROLE_USER', parts: [{ text: 'hi' }] });
		const ended = await finished(runtime, 'alice', task.id);
		assertEquals(ended.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(statusText(ended), 'timed out');
	} finally {
		await runtime.close();
		await bridge.close();
	}
});

// --- D-143 (model-providers-ui S0 + W2): task metadata on every path, and the §3.10 admission table ----------------

/**
 * A recording provider client (gate K1): `calls` counts how often the loop dialled it, so every §3.10 row can
 * assert which fake ran — this one, the recording bridge, or neither. Each turn ends at once with a fixed text.
 */
function fakeProvider(
	id: string,
	models: string[] = ['m-default', 'm-other'],
): ModelProviderClient & { calls: { model: string; prompt: string }[] } {
	const calls: { model: string; prompt: string }[] = [];
	return {
		id,
		kind: 'openai',
		models,
		defaultModel: models[0]!,
		calls,
		complete: (input): Promise<ModelTurn> => {
			const user = input.messages.find((message) => message.role === 'user');
			calls.push({ model: input.model, prompt: user?.role === 'user' ? user.text : '' });
			return Promise.resolve({
				text: `${id} answered`,
				toolCalls: [],
				stop: 'end',
				usage: { input: 1, output: 1 },
			});
		},
	};
}

/** A recording ACP bridge (gate K1): `prompts` counts `session/prompt`; each prompt completes at once. */
function recordingBridge(): ReturnType<typeof fakeBridge> & { prompts: number } {
	// Counted on the returned object itself: a copied number would never see the increments.
	const recording = Object.assign(
		fakeBridge({
			rpc: (method): Response | undefined => {
				if (method !== 'session/prompt') return undefined;
				recording.prompts++;
				recording.push({ method: 'bridge/prompt_complete' });
				return Response.json({ stopReason: 'end_turn' });
			},
		}),
		{ prompts: 0 },
	);
	return recording;
}

/** `AgentRuntimeOptions.model` over the given providers, with `reachable` answered per id. */
function modelOption(
	providers: ModelProviderClient[],
	reachable: (id: string) => boolean,
	fallback: string | null,
): NonNullable<AgentRuntimeOptions['model']> {
	return { providers: new Map(providers.map((p) => [p.id, p])), default: fallback, reachable, tools: () => [] };
}

const text = (): Record<string, unknown> => ({ ...message(), parts: [{ text: 'hello' }] });
const NO_TEXT_BACKEND = 'Text execution requires a configured ACP agent or a model provider';
const withModel = new Set([...scopes, 'model:invoke']);

Deno.test('D-143 addendum A: every submission path writes metadata.kind from the first snapshot on', async (): Promise<void> => {
	// A bridge and a peer that nothing dials: close() cancels the text and delegation tasks before they would run.
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ workspaces: [] }),
		bridge: { url: 'http://127.0.0.1:9', token: 'never-used', agent: 'none' },
		peers: [{ id: 'peer', url: 'http://127.0.0.1:9' }],
	});
	try {
		const tool = runtime.submit('alice', scopes, message());
		assertEquals(tool.metadata, { kind: 'tool' });
		const acp = runtime.submit('alice', scopes, text());
		assertEquals(acp.metadata, { kind: 'text', backend: 'acp' });
		const delegated = runtime.delegate('alice', scopes, 'peer', text());
		assertEquals(delegated.metadata, { kind: 'delegation' });
		// The snapshot every reader gets carries it, and a wrong-owner read is still not found.
		assertEquals(runtime.get('alice', acp.id).metadata, { kind: 'text', backend: 'acp' });
		assertEquals(runtime.list('alice').map((task) => task.metadata?.kind).sort(), ['delegation', 'text', 'tool']);
		assertThrows(() => runtime.get('bob', acp.id), AgentError, 'Task not found');
	} finally {
		await runtime.close();
	}
});

Deno.test('D-143 addendum A / B1: metadata round-trips through tasks.json', async (): Promise<void> => {
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch' });
	const path = `${dir}/tasks.json`;
	const first = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		persistPath: path,
	});
	let id = '';
	try {
		id = first.submit('alice', scopes, message()).id;
		await finished(first, 'alice', id);
	} finally {
		await first.close();
	}
	const second = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		persistPath: path,
	});
	try {
		assertEquals(second.get('alice', id).metadata, { kind: 'tool' });
	} finally {
		await second.close();
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-143 §3.10, the S0 state: no bridge and no providers — one text, with or without the scope or a selection', async (): Promise<void> => {
	const runtime = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}) });
	try {
		assertEquals(runtime.supportsText, false);
		// Rows 5 and 6: the reworded `-32004`, which still names the configured ACP agent.
		for (const held of [scopes, withModel]) {
			const error = assertThrows(() => runtime.submit('alice', held, text()), AgentError, NO_TEXT_BACKEND);
			assertEquals(error.code, -32004);
			assertStringIncludes(error.message, 'configured ACP');
		}
		// Row 2: a selection without the scope names the scope the caller already claimed to need.
		const scopeless = assertThrows(
			() => runtime.submit('alice', scopes, text(), undefined, { model: { provider: 'openai' } }),
			AgentError,
			'model:invoke scope required',
		);
		assertEquals(scopeless.code, -32600);
		// A selection with the scope, and no `model` option at all: the same `-32004` — nothing to be unknown.
		const noProviders = assertThrows(
			() => runtime.submit('alice', withModel, text(), undefined, { model: { provider: 'openai' } }),
			AgentError,
			NO_TEXT_BACKEND,
		);
		assertEquals(noProviders.code, -32004);
		assertEquals(runtime.list('alice'), [], 'a refused text task creates nothing');
	} finally {
		await runtime.close();
	}
});

Deno.test('D-143 §3.10 (gate K1): the admission rows over configured providers, each naming which fake ran', async (): Promise<void> => {
	const up = fakeProvider('up');
	const down = fakeProvider('down');
	const reachable = (id: string): boolean => id === 'up';
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: modelOption([up, down], reachable, 'up'),
	});
	try {
		assertEquals(runtime.reachableProviders, 1);
		assertEquals(runtime.supportsText, true, 'a reachable provider is a text backend');
		assertEquals(runtime.hasBridge, false);
		const selected = (model: Record<string, string>, held = withModel): AgentTask =>
			runtime.submit('alice', held, text(), undefined, { model });
		// Row 1: unknown provider / unknown model → -32602; unreachable → -32004 with the grant text.
		assertEquals(assertThrows(() => selected({ provider: 'nope' }), AgentError, 'Unknown model provider').code, -32602);
		assertEquals(
			assertThrows(() => selected({ provider: 'up', model: 'm-unknown' }), AgentError, 'Unknown model for provider')
				.code,
			-32602,
		);
		assertEquals(
			assertThrows(
				() => selected({ provider: 'down' }),
				AgentError,
				'Model provider is not reachable: no outbound net grant',
			).code,
			-32004,
		);
		// Row 2: the scope first, before the provider is even looked up.
		assertEquals(assertThrows(() => selected({ provider: 'nope' }, scopes), AgentError, 'model:invoke').code, -32600);
		// Row 1, admitted: the resolved ids are on the task from the first snapshot (default model applied).
		const chosen = selected({ provider: 'up' });
		assertEquals(chosen.metadata, { kind: 'text', backend: 'model', provider: 'up', model: 'm-default' });
		const named = selected({ provider: 'up', model: 'm-other' });
		assertEquals(named.metadata?.model, 'm-other');
		// Row 4: no selection, no bridge, a reachable default, the scope → the default provider and its default model.
		const fallback = runtime.submit('alice', withModel, text());
		assertEquals(fallback.metadata, { kind: 'text', backend: 'model', provider: 'up', model: 'm-default' });
		// Row 5: the same request without the scope is told nothing about providers.
		assertEquals(assertThrows(() => runtime.submit('alice', scopes, text()), AgentError, NO_TEXT_BACKEND).code, -32004);
		// W2: every admitted task ran on the provider the table named — `up`, with the model it resolved — and only
		// there; the refused rows above dialled nothing.
		for (const task of [chosen, named, fallback]) {
			const done = await finished(runtime, 'alice', task.id);
			assertEquals(done.status.state, 'TASK_STATE_COMPLETED');
			assertEquals(done.artifacts.length, 1);
			assertEquals(done.artifacts[0]!.parts, [{ text: 'up answered' }]);
			assertEquals(done.metadata?.steps, 1);
			assertEquals(done.metadata?.usage, { input: 1, output: 1 });
		}
		assertEquals(up.calls.map((call) => call.model), ['m-default', 'm-other', 'm-default']);
		assertEquals(down.calls, [], 'the unreachable provider was never dialled');
		assertEquals(up.calls.every((call) => call.prompt === 'hello'), true, 'the user text is the prompt');
	} finally {
		await runtime.close();
	}
});

Deno.test('D-143 §3.10 rows 3, 4 and 6 (gate K1): a bridge beats a default; an unreachable default is -32004; several without a default have no fallback — each row names which fake ran', async (): Promise<void> => {
	const bridge = recordingBridge();
	const up = fakeProvider('up');
	const bridged = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		bridge: bridge.options,
		model: modelOption([up], () => true, 'up'),
	});
	try {
		assertEquals(bridged.hasBridge, true);
		// Row 3: no selection → ACP, whatever the default says: the bridge is prompted, the provider is not dialled.
		const acp = bridged.submit('alice', withModel, text());
		assertEquals(acp.metadata, { kind: 'text', backend: 'acp' });
		assertEquals((await finished(bridged, 'alice', acp.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals([bridge.prompts, up.calls.length], [1, 0]);
		// Row 3 without the scope: still ACP — the bridge needs no `model:invoke`.
		const scopeless = bridged.submit('alice', scopes, text());
		assertEquals(scopeless.metadata?.backend, 'acp');
		assertEquals((await finished(bridged, 'alice', scopeless.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals([bridge.prompts, up.calls.length], [2, 0]);
		// A selection still wins over the bridge (row 1): the provider is dialled, the bridge is not.
		const picked = bridged.submit('alice', withModel, text(), undefined, { model: { provider: 'up' } });
		assertEquals(picked.metadata?.backend, 'model');
		assertEquals((await finished(bridged, 'alice', picked.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals([bridge.prompts, up.calls.length], [2, 1]);
		// Row 2 beside a bridge: a selection without the scope is refused, and neither fake hears of it.
		assertEquals(
			assertThrows(() => bridged.submit('alice', scopes, text(), undefined, { model: { provider: 'up' } }), AgentError)
				.code,
			-32600,
		);
		assertEquals([bridge.prompts, up.calls.length], [2, 1]);
	} finally {
		await bridged.close();
		await bridge.close();
	}
	// Row 4, unreachable default (gate F19): refused before any task exists; the provider is never dialled.
	const down = fakeProvider('down');
	const unreachableDefault = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: modelOption([down], () => false, 'down'),
	});
	try {
		assertEquals(unreachableDefault.supportsText, false, 'no reachable provider and no bridge');
		assertEquals(
			assertThrows(() => unreachableDefault.submit('alice', withModel, text()), AgentError, 'not reachable').code,
			-32004,
		);
		assertEquals(down.calls, []);
		assertEquals(unreachableDefault.list('alice'), []);
	} finally {
		await unreachableDefault.close();
	}
	// The `default` rule (gate F19), three cases over the runtime's side of it.
	// (a) One provider named as the default (the parser auto-defaults a sole provider): row 4 runs it.
	const only = fakeProvider('only');
	const sole = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: modelOption([only], () => true, 'only'),
	});
	try {
		const task = sole.submit('alice', withModel, text());
		assertEquals(task.metadata, { kind: 'text', backend: 'model', provider: 'only', model: 'm-default' });
		assertEquals((await finished(sole, 'alice', task.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals(only.calls.length, 1);
	} finally {
		await sole.close();
	}
	// (b) Several providers and no default: row 6 — a bridge-less text task without a selection has nowhere to go,
	// and a selection still runs the named one and no other.
	const a = fakeProvider('a');
	const b = fakeProvider('b');
	const noDefault = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: modelOption([a, b], () => true, null),
	});
	try {
		assertEquals(
			assertThrows(() => noDefault.submit('alice', withModel, text()), AgentError, NO_TEXT_BACKEND).code,
			-32004,
		);
		// QR-6: row 6 without the scope — the same text, nothing about providers to a scopeless caller.
		assertEquals(
			assertThrows(() => noDefault.submit('alice', scopes, text()), AgentError, NO_TEXT_BACKEND).code,
			-32004,
		);
		assertEquals([a.calls.length, b.calls.length], [0, 0]);
		const picked = noDefault.submit('alice', withModel, text(), undefined, { model: { provider: 'b' } });
		assertEquals(picked.metadata?.provider, 'b');
		assertEquals((await finished(noDefault, 'alice', picked.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals([a.calls.length, b.calls.length], [0, 1]);
	} finally {
		await noDefault.close();
	}
	// (c) Several providers with a named default: row 4 runs the named one, never the other.
	const c = fakeProvider('c');
	const d = fakeProvider('d');
	const named = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: modelOption([c, d], () => true, 'd'),
	});
	try {
		const task = named.submit('alice', withModel, text());
		assertEquals(task.metadata?.provider, 'd');
		assertEquals((await finished(named, 'alice', task.id)).status.state, 'TASK_STATE_COMPLETED');
		assertEquals([c.calls.length, d.calls.length], [0, 1]);
		// Row 5 with a default present: without the scope, nothing about providers and nothing dialled.
		assertEquals(assertThrows(() => named.submit('alice', scopes, text()), AgentError, NO_TEXT_BACKEND).code, -32004);
		assertEquals([c.calls.length, d.calls.length], [0, 1]);
	} finally {
		await named.close();
	}
});

Deno.test('D-143 §3.10 (CR-1 / BUG-6): a model without a provider is -32602 "model requires provider", with and without a bridge, with and without the scope — no task, nothing dialled', async (): Promise<void> => {
	const only = fakeProvider('only');
	const bridgeOptions = { url: 'http://127.0.0.1:9', token: 'never-used', agent: 'none' };
	for (const bridge of [undefined, bridgeOptions]) {
		const runtime = new AgentRuntime({
			invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
			model: modelOption([only], () => true, 'only'),
			...(bridge === undefined ? {} : { bridge }),
		});
		try {
			assertEquals(runtime.hasBridge, bridge !== undefined);
			for (const held of [scopes, withModel]) {
				const error = assertThrows(
					() => runtime.submit('alice', held, text(), undefined, { model: { model: 'm-other' } }),
					AgentError,
					'model requires provider',
				);
				assertEquals(error.code, -32602, `bridge: ${bridge !== undefined}, scope: ${held.has('model:invoke')}`);
			}
			assertEquals(only.calls.length, 0, 'the default provider was never dialled');
		} finally {
			await runtime.close();
		}
	}
});

Deno.test('run log: a tool task records the call with its arguments, the result, its duration and the states', async () => {
	const big = 'x'.repeat(10_000);
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ content: [{ type: 'text', text: big }] }),
	});
	try {
		const task = runtime.submit(
			'alice',
			scopes,
			message({
				parts: [{ data: { tool: 'sandbox_list', arguments: { workspace_id: 'w' } } }],
			}),
		);
		await finished(runtime, 'alice', task.id);
		const run = runtime.runLog('alice', task.id);
		assertEquals(run.entries.map((entry) => entry.kind), [
			'received',
			'state',
			'tool_call',
			'tool_result',
			'artifact',
			'state',
		]);
		assertEquals(run.entries[0]!.kind === 'received' && run.entries[0]!.via, undefined);
		const call = run.entries.find((entry) => entry.kind === 'tool_call')!;
		assertEquals([call.name, call.arguments], ['sandbox_list', { workspace_id: 'w' }]);
		const result = run.entries.find((entry) => entry.kind === 'tool_result')!;
		assertEquals(result.isError, false);
		assert(typeof result.duration_ms === 'number');
		assert(
			String(result.text).length < 4200 && String(result.text).endsWith('[10000 chars]'),
			'a long result is clipped',
		);
		assertThrows(() => runtime.runLog('mallory', task.id), AgentError);
	} finally {
		await runtime.close();
	}
});
