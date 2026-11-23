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

Deno.test('one owner runs at most two tasks at once, so another owner’s work is never starved', async () => {
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
		// The refusal names the one text backend a deployment can add.
		const refused = assertThrows(
			() => runtime.submit('alice', scopes, message({ parts: [{ text: 'Make an app' }] })),
			AgentError,
			'model provider',
		);
		assertEquals(refused.message, 'Text execution requires a model provider');
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
/** The owners `fillSlots` submits as: two, since one owner holds at most TASK_SLOTS_PER_OWNER slots. */
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

Deno.test('a queued task re-authorizes at start and never runs on scopes its credential lost', async (): Promise<void> => {
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

Deno.test('every structured tool call re-reads the credential, so a revocation mid-task stops the next call', async (): Promise<void> => {
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

Deno.test('reauthorize() fails a revoked credential’s running and queued tasks at once', async (): Promise<void> => {
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

Deno.test('a task waiting past its queue deadline fails without running', async (): Promise<void> => {
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

Deno.test('finished tasks never hold capacity; the oldest finished are evicted, the caller’s first', async (): Promise<void> => {
	const runtime = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ ok: true }) });
	try {
		const own: AgentTask[] = [];
		for (let i = 0; i < 32; i++) {
			own.push(runtime.submit('alice', scopes, message()));
			await finished(runtime, 'alice', own.at(-1)!.id);
		}
		// Thirty-two completed tasks do not refuse the thirty-third: the oldest finished one is evicted instead.
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

Deno.test('unfinished tasks still fill the global cap and refuse new work', async (): Promise<void> => {
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

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

Deno.test('A2A message validation rejects non-1.0 envelopes, external file URLs and oversize prompts', (): void => {
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

Deno.test('a follow-up message is refused: no task waits for input, and another owner’s task is not found', async () => {
	let release = (): void => {};
	const held = new Promise<void>((resolve) => release = resolve);
	const runtime = new AgentRuntime({
		invoke: async (): Promise<Record<string, unknown>> => {
			await held;
			return {};
		},
	});
	try {
		const task = runtime.submit('alice', scopes, message());
		await until(() => runtime.get('alice', task.id).status.state === 'TASK_STATE_WORKING', 'a running task');
		const followUp = (owner: string, extra: Record<string, unknown> = {}): AgentError =>
			assertThrows(
				() =>
					runtime.submit(owner, scopes, {
						messageId: crypto.randomUUID(),
						role: 'ROLE_USER',
						taskId: task.id,
						parts: [{ data: { optionId: 'once' } }],
						...extra,
					}),
				AgentError,
			);
		assertEquals([followUp('alice').code, followUp('alice').message], [-32004, 'This task is not waiting for input']);
		assertEquals(followUp('alice', { contextId: 'another' }).code, -32602);
		assertEquals(followUp('bob').message, 'Task not found');
		release();
		await finished(runtime, 'alice', task.id);
		assertEquals(followUp('alice').message, 'Terminal task cannot accept messages');
		assertEquals(runtime.get('alice', task.id).history.length, 1, 'no refused message joins the history');
	} finally {
		release();
		await runtime.close();
	}
});

// --- durable tasks ---------------------------------------------------------------------------------------------

/** A fresh scratch directory for one test's `tasks.json`; the test tiers grant writes under tests/.scratch only. */
async function scratch(): Promise<{ dir: string; path: string }> {
	const dir = `tests/.scratch/agent-tasks-${crypto.randomUUID()}`;
	await Deno.mkdir(dir, { recursive: true });
	return { dir, path: `${dir}/agents/tasks.json` };
}

Deno.test('finished work, history, artifacts and idempotency keys survive a restart; running work comes back failed', async () => {
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
		// Idempotency survives the restart: the client's retry finds its task and nothing runs again.
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

Deno.test('a restart drops finished tasks past retention and skips malformed entries; no data dir means no file', async () => {
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
			metadata: { kind: 'text' },
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
				// A task without `metadata.kind` is malformed, not restored with a guessed kind.
				{
					...stored('kindless', now - 1_000, 'TASK_STATE_COMPLETED'),
					task: {
						id: 'kindless',
						contextId: 'c',
						status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date(now).toISOString() },
						artifacts: [],
						history: [],
					},
				},
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

Deno.test('a durable document is synced before its rename, its folder after, and never left half-written', async () => {
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

// --- per-kind execution bounds ---------------------------------------------------------------------------------

Deno.test('a tool task is bounded by its tool, clamped to what the tool accepts', () => {
	const margin = TOOL_BOUND_MARGIN_MS;
	assertEquals(toolTaskBoundMs('sandbox_exec', {}), 300_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('sandbox_exec', { timeout_ms: 900_000 }), 900_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('sandbox_exec', { timeout_ms: 1e12 }), 900_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('sandbox_exec', { timeout_ms: 'forever' }), 300_000 + SANDBOX_SLOT_WAIT_MS + margin);
	assertEquals(toolTaskBoundMs('browser_wait_for', {}), 10_000 + margin);
	assertEquals(toolTaskBoundMs('browser_wait_for', { timeout_ms: 60_000 }), 60_000 + margin);
	assertEquals(toolTaskBoundMs('browser_click', { timeout_ms: 900_000 }), TOOL_CALL_BOUND_MS);
});

Deno.test('a 15-minute sandbox_exec submitted as a task is not cut at 120 s, and is cut at its own bound', async () => {
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
		assertEquals(
			runtime.get('alice', task.id).status.state,
			'TASK_STATE_WORKING',
			'a 15-minute task is not cut at 120 s',
		);
		await time.tickAsync(toolTaskBoundMs('sandbox_exec', { timeout_ms: 900_000 }) - 121_000);
		const cut = runtime.get('alice', task.id);
		assertEquals(cut.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(statusText(cut), 'timed out');
	} finally {
		time.restore();
		await runtime.close();
	}
});

Deno.test('a text task is bounded by the operator’s TTK_AGENT_TASK_TIMEOUT_S', async () => {
	// A provider that answers only when its call is aborted, so only the bound ends the task.
	const slow: ModelProviderClient = {
		id: 'slow',
		kind: 'openai',
		models: ['m'],
		defaultModel: 'm',
		complete: (_input, signal): Promise<ModelTurn> =>
			new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
	};
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: { providers: new Map([['slow', slow]]), default: 'slow', reachable: () => true, tools: () => [] },
		taskTimeoutMs: 100,
	});
	try {
		const task = runtime.submit('alice', new Set([...scopes, 'model:invoke']), {
			messageId: 'slow',
			role: 'ROLE_USER',
			parts: [{ text: 'hi' }],
		});
		const ended = await finished(runtime, 'alice', task.id);
		assertEquals(ended.status.state, 'TASK_STATE_FAILED');
		assertStringIncludes(statusText(ended), 'timed out');
	} finally {
		await runtime.close();
	}
});

// --- task metadata on every path, and text-task admission over model providers -----------------------------------

/**
 * A recording provider client: `calls` counts how often the loop dialled it, so every admission case can
 * assert which fake ran — this one, or none. Each turn ends at once with a fixed text.
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

/** `AgentRuntimeOptions.model` over the given providers, with `reachable` answered per id. */
function modelOption(
	providers: ModelProviderClient[],
	reachable: (id: string) => boolean,
	fallback: string | null,
): NonNullable<AgentRuntimeOptions['model']> {
	return { providers: new Map(providers.map((p) => [p.id, p])), default: fallback, reachable, tools: () => [] };
}

const text = (): Record<string, unknown> => ({ ...message(), parts: [{ text: 'hello' }] });
const NO_TEXT_BACKEND = 'Text execution requires a model provider';
const withModel = new Set([...scopes, 'model:invoke']);

Deno.test('every submission path writes metadata.kind from the first snapshot on', async (): Promise<void> => {
	// A provider that never answers and a peer that nothing dials: close() cancels the text and delegation tasks.
	const silent: ModelProviderClient = {
		id: 'p',
		kind: 'openai',
		models: ['m'],
		defaultModel: 'm',
		complete: (_input, signal): Promise<ModelTurn> =>
			new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
	};
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({ workspaces: [] }),
		model: modelOption([silent], () => true, 'p'),
		peers: [{ id: 'peer', url: 'http://127.0.0.1:9' }],
	});
	try {
		const tool = runtime.submit('alice', scopes, message());
		assertEquals(tool.metadata, { kind: 'tool' });
		const prompt = runtime.submit('alice', withModel, text());
		assertEquals(prompt.metadata, { kind: 'text', backend: 'model', provider: 'p', model: 'm' });
		const delegated = runtime.delegate('alice', scopes, 'peer', text());
		assertEquals(delegated.metadata, { kind: 'delegation' });
		// The snapshot every reader gets carries it, and a wrong-owner read is still not found.
		assertEquals(runtime.get('alice', prompt.id).metadata?.backend, 'model');
		assertEquals(runtime.list('alice').map((task) => task.metadata?.kind).sort(), ['delegation', 'text', 'tool']);
		assertThrows(() => runtime.get('bob', prompt.id), AgentError, 'Task not found');
	} finally {
		await runtime.close();
	}
});

Deno.test('metadata round-trips through tasks.json', async (): Promise<void> => {
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

Deno.test('admission with no providers — one text, with or without the scope or a selection', async (): Promise<void> => {
	const runtime = new AgentRuntime({ invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}) });
	try {
		assertEquals(runtime.supportsText, false);
		// Rows 5 and 6: the one `-32004`, naming the backend the deployment could add.
		for (const held of [scopes, withModel]) {
			const error = assertThrows(() => runtime.submit('alice', held, text()), AgentError, NO_TEXT_BACKEND);
			assertEquals(error.code, -32004);
			assertEquals(error.message, NO_TEXT_BACKEND);
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

Deno.test('admission over configured providers: each admitted or refused case names which fake ran', async (): Promise<void> => {
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
		// The scope is checked first, before the provider is even looked up.
		assertEquals(assertThrows(() => selected({ provider: 'nope' }, scopes), AgentError, 'model:invoke').code, -32600);
		// An explicit selection is admitted: the resolved ids are on the task from the first snapshot (default model applied).
		const chosen = selected({ provider: 'up' });
		assertEquals(chosen.metadata, { kind: 'text', backend: 'model', provider: 'up', model: 'm-default' });
		const named = selected({ provider: 'up', model: 'm-other' });
		assertEquals(named.metadata?.model, 'm-other');
		// No selection, a reachable default, the scope → the default provider and its default model.
		const fallback = runtime.submit('alice', withModel, text());
		assertEquals(fallback.metadata, { kind: 'text', backend: 'model', provider: 'up', model: 'm-default' });
		// The same request without the scope is told nothing about providers.
		assertEquals(assertThrows(() => runtime.submit('alice', scopes, text()), AgentError, NO_TEXT_BACKEND).code, -32004);
		// Every admitted task ran on the provider its admission named — `up`, with the model it resolved — and only
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

Deno.test('admission: an unreachable default is -32004; several without a default have no fallback — each case names which fake ran', async (): Promise<void> => {
	// An unreachable default is refused before any task exists; the provider is never dialled.
	const down = fakeProvider('down');
	const unreachableDefault = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: modelOption([down], () => false, 'down'),
	});
	try {
		assertEquals(unreachableDefault.supportsText, false, 'no reachable provider');
		assertEquals(
			assertThrows(() => unreachableDefault.submit('alice', withModel, text()), AgentError, 'not reachable').code,
			-32004,
		);
		assertEquals(down.calls, []);
		assertEquals(unreachableDefault.list('alice'), []);
	} finally {
		await unreachableDefault.close();
	}
	// The `default` rule, three cases over the runtime's side of it.
	// (a) One provider named as the default (the parser auto-defaults a sole provider): a request without a selection runs it.
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
	// (b) Several providers and no default: row 6 — a text task without a selection has nowhere to go,
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
		// Several providers without a default and without the scope — the same text, nothing about providers to a scopeless caller.
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

Deno.test('a model without a provider is -32602 "model requires provider", with and without the scope — no task, nothing dialled', async (): Promise<void> => {
	const only = fakeProvider('only');
	const runtime = new AgentRuntime({
		invoke: (): Promise<Record<string, unknown>> => Promise.resolve({}),
		model: modelOption([only], () => true, 'only'),
	});
	try {
		for (const held of [scopes, withModel]) {
			const error = assertThrows(
				() => runtime.submit('alice', held, text(), undefined, { model: { model: 'm-other' } }),
				AgentError,
				'model requires provider',
			);
			assertEquals(error.code, -32602, `scope: ${held.has('model:invoke')}`);
		}
		assertEquals(only.calls.length, 0, 'the default provider was never dialled');
		assertEquals(runtime.list('alice'), []);
	} finally {
		await runtime.close();
	}
});
