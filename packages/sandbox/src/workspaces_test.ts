import { assert, assertEquals, assertRejects } from '@std/assert';
import { type CagedFileOp } from './caged_files.ts';
import { cloneEnv, cloneScript } from './clone.ts';
import { type GitRemote, parseGitRemotes } from './git_forwarder.ts';
import { type OpenEgress } from './proxy.ts';
import { type ExecRequest, RequestError } from './request.ts';
import { type SessionState } from './sessions.ts';
import { ApiError, type DiskQuota, type ExecResult } from './sandbox.ts';
import { type CloneSettings, WorkspaceService } from './workspaces.ts';
import { LIMITS } from './limits.ts';

const result: ExecResult = {
	exitCode: 0,
	timedOut: false,
	killed: null,
	durationMs: 1,
	output: '',
	truncated: false,
	omittedBytes: 0,
	outputBytes: 0,
	diskBytes: 0,
	diskBudgetBytes: LIMITS.diskBudgetBytes,
	overBudget: false,
	cleanupOnly: false,
	reachedHosts: [],
	refusedHosts: [],
};

async function fixture(): Promise<
	{
		service: WorkspaceService;
		root: string;
		backend: WorkspaceService['backend'] & { open: Set<string>; caged: { runId: string; op: CagedFileOp }[] };
		cleanup(): Promise<void>;
	}
> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const root = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'sandbox-' });
	const open = new Set<string>();
	const caged: { runId: string; op: CagedFileOp }[] = [];
	const backend: WorkspaceService['backend'] & { open: Set<string>; caged: typeof caged } = {
		kind: 'bwrap',
		open,
		caged,
		sessionOf: (runId: string) => (open.has(runId) ? ({ id: 's' } as unknown as SessionState) : null),
		fileOp: (runId: string, op: CagedFileOp) => {
			caged.push({ runId, op });
			return Promise.resolve(op.kind === 'write' ? { written: true, bytes: 1 } : { caged: op.kind });
		},
		exec: (_req: ExecRequest): Promise<ExecResult> => Promise.resolve(result),
		diff: (): Promise<{ patch: string; files: []; truncated: boolean }> =>
			Promise.resolve({ patch: '', files: [], truncated: false }),
		remove: (): Promise<{ removed: boolean }> => Promise.resolve({ removed: true }),
		health: (): Promise<{ ok: boolean; error: null }> => Promise.resolve({ ok: true, error: null }),
		diskUsage: (): Promise<number> => Promise.resolve(0),
		openSession: (_owner: string, req: { runId: string }) => {
			open.add(req.runId);
			return Promise.resolve({ session_id: crypto.randomUUID(), created_at: new Date().toISOString() });
		},
		sessionInput: () => Promise.resolve({ accepted: true as const }),
		sessionRead: () => Promise.resolve({ output: '', seq: 0, gap: false, ended: false, exit_code: null, killed: null }),
		sessionClose: () => ({ closed: true as const }),
	};
	const service = new WorkspaceService(root, backend);
	await service.initialize();
	return {
		service,
		root,
		backend,
		cleanup: async (): Promise<void> => {
			await Deno.remove(root, { recursive: true });
		},
	};
}

Deno.test('workspace: ownership persists and all operations refuse another principal', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { limits, ...created } = await f.service.call('alice', 'create', {});
		assertEquals((limits as Record<string, number>).file_bytes, 256 * 1024);
		const id = created.workspace_id;
		const service = new WorkspaceService(f.root, f.backend);
		await service.initialize();
		assertEquals((await service.call('alice', 'list', {})).workspaces, [created]);
		assertEquals((await service.call('bob', 'list', {})).workspaces, []);
		for (const operation of ['read', 'write', 'exec', 'diff', 'remove', 'list'] as const) {
			await assertRejects(() => service.call('bob', operation, { workspace_id: id }), ApiError, 'Workspace not found');
		}
		assertEquals(await service.call('alice', 'remove', { workspace_id: id }), { removed: true });
		await assertRejects(() => service.call('alice', 'read', { workspace_id: id, path: 'a' }), ApiError);
	} finally {
		await f.cleanup();
	}
});

Deno.test('workspace: bounded file operations and paths stay in owned workspace', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		assertEquals(await f.service.call('alice', 'write', { workspace_id, path: 'src/a.txt', content: 'hello' }), {
			written: true,
			bytes: 5,
			path: 'src/a.txt',
		});
		assertEquals(await f.service.call('alice', 'read', { workspace_id, path: 'src/a.txt' }), {
			content: 'hello',
			bytes: 5,
		});
		assertEquals(await f.service.call('alice', 'list', { workspace_id, path: 'src' }), {
			entries: [{ name: 'a.txt', type: 'file' }],
			truncated: false,
		});
		for (const path of ['../escape', '/etc/passwd', 'C:/outside', 'src/../../escape', '.git/config', 'src\\escape']) {
			await assertRejects(() => f.service.call('alice', 'write', { workspace_id, path, content: 'x' }));
		}
		await assertRejects(() =>
			f.service.call('alice', 'write', { workspace_id, path: 'big', content: 'a'.repeat(256 * 1024 + 1) })
		);
		await assertRejects(() => f.service.call('alice', 'write', { workspace_id, path: 'src', content: 'x' }));
		await assertRejects(() => f.service.call('alice', 'read', { workspace_id, path: '' }));
		await assertRejects(() => f.service.call('alice', 'exec', { workspace_id, command: 'true', principal: 'bob' }));
		f.backend.diskUsage = (): Promise<number> => Promise.resolve(LIMITS.diskBudgetBytes);
		await assertRejects(
			() => f.service.call('alice', 'write', { workspace_id, path: 'new', content: 'x' }),
			ApiError,
			'disk budget',
		);
	} finally {
		await f.cleanup();
	}
});

Deno.test('workspace: remove cancels execution and concurrent file access is refused', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.backend.exec = (_req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> =>
			new Promise((resolve) => {
				started();
				signal?.addEventListener('abort', () => resolve({ ...result, killed: 'cancelled', exitCode: null }), {
					once: true,
				});
			});
		const executing = f.service.call('alice', 'exec', { workspace_id, command: 'sleep 60' });
		await ready;
		await assertRejects(
			() => f.service.call('alice', 'write', { workspace_id, path: 'x', content: '' }),
			ApiError,
			'busy',
		);
		assertEquals(await f.service.call('alice', 'remove', { workspace_id }), { removed: true });
		assertEquals((await executing).killed, 'cancelled');
	} finally {
		await f.cleanup();
	}
});

Deno.test('workspace: provisioning fails closed and removes incomplete state', async (): Promise<void> => {
	const f = await fixture();
	try {
		f.backend.exec = (): Promise<ExecResult> => Promise.resolve({ ...result, exitCode: 1 });
		await assertRejects(() => f.service.call('alice', 'create', {}), ApiError, 'provisioning failed');
		assertEquals(await f.service.call('alice', 'list', {}), { workspaces: [] });
		await assertRejects(() => f.service.call('', 'create', {}));
		await assertRejects(() => f.service.call('alice', 'create', { clone: 'https://evil' }));
	} finally {
		await f.cleanup();
	}
});

Deno.test('workspace: seeded files and display name are bounded and survive reinitialization', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { limits, ...created } = await f.service.call('alice', 'create', {
			name: 'Example',
			files: { 'src/a.txt': 'hello' },
		});
		assertEquals((limits as Record<string, number>).file_bytes, 256 * 1024);
		assertEquals(
			(await f.service.call('alice', 'read', { workspace_id: created.workspace_id, path: 'src/a.txt' })).content,
			'hello',
		);
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, [created]);
		for (
			const args of [
				{ name: 'x'.repeat(129) },
				{ files: { '../escape': 'bad' } },
				{ files: { '.git/config': 'bad' } },
				{ files: { 'a': 'x'.repeat(256 * 1024), 'b': 'x' } },
				{ files: [] },
				{ files: { a: 3 } },
			]
		) {
			await assertRejects(() => f.service.call('alice', 'create', args));
		}
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, [created]);
	} finally {
		await f.cleanup();
	}
});

const GiB = 1024 * 1024 * 1024;
const record = async (root: string, id: unknown) =>
	JSON.parse(await Deno.readTextFile(`${root}/.owners/${id}.json`)) as Record<string, unknown>;
const listed = async (service: WorkspaceService, principal: string) =>
	(await service.call(principal, 'list', {})).workspaces as Record<string, unknown>[];
const temporaries = async (dir: string) =>
	(await Array.fromAsync(Deno.readDir(dir))).filter((entry) => entry.name.startsWith('.tmp-'));

Deno.test("SB-1 workspace: an owner's workspaces share one disk quota, kept in their records", async (): Promise<void> => {
	const f = await fixture();
	try {
		const ids = [];
		for (let i = 0; i < 3; i++) ids.push((await f.service.call('alice', 'create', {})).workspace_id);
		const quotas: (DiskQuota | undefined)[] = [];
		let size = 0;
		f.backend.exec = (_req: ExecRequest, _signal?: AbortSignal, quota?: DiskQuota): Promise<ExecResult> => {
			quotas.push(quota);
			return Promise.resolve({ ...result, diskBytes: size });
		};
		size = 2.5 * GiB;
		await f.service.call('alice', 'exec', { workspace_id: ids[0], command: 'true' });
		await f.service.call('alice', 'exec', { workspace_id: ids[1], command: 'true' });
		assertEquals((await record(f.root, ids[0])).disk_bytes, 2.5 * GiB);
		// 6 GiB in all, 5 of them used by the other two: 1 GiB is left, and a cleanup may reach 2.5.
		size = 0;
		await f.service.call('alice', 'exec', { workspace_id: ids[2], command: 'true' });
		assertEquals(quotas.at(-1), { limit: 1 * GiB, ceiling: 2.5 * GiB });
		// Another owner is not charged with alice's use.
		const bob = (await f.service.call('bob', 'create', {})).workspace_id;
		await f.service.call('bob', 'exec', { workspace_id: bob, command: 'true' });
		assertEquals(quotas.at(-1), { limit: LIMITS.diskBudgetBytes, ceiling: 2 * LIMITS.diskBudgetBytes });
		// Past the quota alice can create nothing more; bob still can.
		size = 1.5 * GiB;
		await f.service.call('alice', 'exec', { workspace_id: ids[2], command: 'true' });
		await assertRejects(() => f.service.call('alice', 'create', {}), ApiError, 'disk quota');
		await f.service.call('bob', 'create', {});
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-1 workspace: while a command runs its record holds the worst case, then what was measured', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		let finish!: (value: ExecResult) => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => started = resolve);
		f.backend.exec = (): Promise<ExecResult> =>
			new Promise((resolve) => {
				finish = resolve;
				started();
			});
		const executing = f.service.call('alice', 'exec', { workspace_id, command: 'true' });
		await running;
		assertEquals((await record(f.root, workspace_id)).disk_bytes, LIMITS.diskBudgetBytes);
		finish({ ...result, diskBytes: 4096 });
		await executing;
		assertEquals((await record(f.root, workspace_id)).disk_bytes, 4096);
		// A record from before disk use was kept is measured once at start-up.
		const legacy = await record(f.root, workspace_id);
		delete legacy.disk_bytes;
		await Deno.writeTextFile(`${f.root}/.owners/${workspace_id}.json`, JSON.stringify(legacy));
		f.backend.diskUsage = (): Promise<number> => Promise.resolve(8192);
		await new WorkspaceService(f.root, f.backend).initialize();
		assertEquals((await record(f.root, workspace_id)).disk_bytes, 8192);
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-3 workspace: seed files are checked against the budget once, not measured one by one', async (): Promise<void> => {
	const f = await fixture();
	try {
		let measured = 0;
		f.backend.diskUsage = (): Promise<number> => {
			measured++;
			return Promise.resolve(0);
		};
		const { workspace_id } = await f.service.call('alice', 'create', { files: { a: '1', 'b/c': '2', 'b/d': '3' } });
		assertEquals(measured, 0);
		assertEquals((await f.service.call('alice', 'read', { workspace_id, path: 'b/d' })).content, '3');
		f.backend.exec = (): Promise<ExecResult> => Promise.resolve({ ...result, diskBytes: LIMITS.diskBudgetBytes - 2 });
		await assertRejects(() => f.service.call('alice', 'create', { files: { a: 'xyz' } }), ApiError, 'budget');
		assertEquals((await listed(f.service, 'alice')).length, 1);
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-4 workspace: a damaged record is skipped, never fatal, and records are replaced whole', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { limits, ...created } = await f.service.call('alice', 'create', { name: 'kept' });
		assertEquals((limits as Record<string, number>).file_bytes, 256 * 1024);
		await Deno.writeTextFile(`${f.root}/.owners/${crypto.randomUUID()}.json`, '{"owner": ');
		await Deno.writeTextFile(`${f.root}/.owners/${crypto.randomUUID()}.json`, '[]');
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, [created]);
		const second = await f.service.call('alice', 'create', {});
		assertEquals((await listed(f.service, 'alice')).length, 2);
		await f.service.call('alice', 'write', { workspace_id: second.workspace_id, path: 'a', content: 'x' });
		assertEquals(await temporaries(`${f.root}/.owners`), []);
		assertEquals(await temporaries(`${f.root}/${second.workspace_id}`), []);
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-4 workspace: removal finishes what a crash between its two deletions left', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		await Deno.remove(`${f.root}/${workspace_id}`, { recursive: true });
		await assertRejects(() => f.service.call('alice', 'read', { workspace_id, path: 'a' }));
		assertEquals(await f.service.call('alice', 'remove', { workspace_id }), { removed: true });
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, []);
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-4 workspace: the sweep removes only old leftovers without an owner record', async (): Promise<void> => {
	const f = await fixture();
	try {
		const owned = (await f.service.call('alice', 'create', {})).workspace_id as string;
		const old = new Date(Date.now() - 2 * LIMITS.orphanAgeMs);
		const orphan = crypto.randomUUID();
		const stateOnly = crypto.randomUUID();
		const recent = crypto.randomUUID();
		await Deno.mkdir(`${f.root}/${orphan}/src`, { recursive: true });
		await Deno.mkdir(`${f.root}/.sandbox/${stateOnly}/home`, { recursive: true });
		await Deno.mkdir(`${f.root}/${recent}`);
		await Deno.writeTextFile(`${f.root}/.owners/.tmp-${crypto.randomUUID()}`, '{');
		for (const path of [`${f.root}/${orphan}`, `${f.root}/.sandbox/${stateOnly}`, `${f.root}/${owned}`]) {
			await Deno.utime(path, old, old);
		}
		for (const entry of await temporaries(`${f.root}/.owners`)) {
			await Deno.utime(`${f.root}/.owners/${entry.name}`, old, old);
		}
		const removed: string[] = [];
		f.backend.remove = async (id: string): Promise<{ removed: boolean }> => {
			removed.push(id);
			await Deno.remove(`${f.root}/.sandbox/${id}`, { recursive: true }).catch(() => {});
			return { removed: true };
		};
		assertEquals(await f.service.sweep(), 3);
		assertEquals(removed.sort(), [orphan, stateOnly].sort());
		await assertRejects(() => Deno.lstat(`${f.root}/${orphan}`));
		await assertRejects(() => Deno.lstat(`${f.root}/.sandbox/${stateOnly}`));
		await Deno.lstat(`${f.root}/${recent}`);
		await Deno.lstat(`${f.root}/${owned}`);
		assertEquals(await temporaries(`${f.root}/.owners`), []);
		assertEquals((await listed(f.service, 'alice')).length, 1);
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-5 workspace: a write replaces the file through a rename and keeps nothing half-written', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		await f.service.call('alice', 'write', { workspace_id, path: 'a.txt', content: 'first' });
		const first = await Deno.lstat(`${f.root}/${workspace_id}/a.txt`);
		await f.service.call('alice', 'write', { workspace_id, path: 'a.txt', content: 'second' });
		const second = await Deno.lstat(`${f.root}/${workspace_id}/a.txt`);
		// A new file each time: a link swapped in at the path would be replaced, never written through.
		if (first.ino !== null && second.ino !== null) assert(first.ino !== second.ino);
		assertEquals((await f.service.call('alice', 'read', { workspace_id, path: 'a.txt' })).content, 'second');
		assertEquals(await temporaries(`${f.root}/${workspace_id}`), []);
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-7 workspace: over its budget a file may still be shrunk, but nothing may grow', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		await f.service.call('alice', 'write', { workspace_id, path: 'big.log', content: 'x'.repeat(1000) });
		f.backend.diskUsage = (): Promise<number> => Promise.resolve(LIMITS.diskBudgetBytes + 10);
		assertEquals(await f.service.call('alice', 'write', { workspace_id, path: 'big.log', content: '' }), {
			written: true,
			bytes: 0,
			path: 'big.log',
		});
		await assertRejects(
			() => f.service.call('alice', 'write', { workspace_id, path: 'new', content: 'x' }),
			ApiError,
			'disk budget',
		);
	} finally {
		await f.cleanup();
	}
});

Deno.test('SB-8 workspace: a busy workspace is still listed, marked busy', async (): Promise<void> => {
	const f = await fixture();
	try {
		const { limits, ...created } = await f.service.call('alice', 'create', {});
		assertEquals((limits as Record<string, number>).file_bytes, 256 * 1024);
		let finish!: () => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => started = resolve);
		f.backend.exec = (): Promise<ExecResult> =>
			new Promise((resolve) => {
				finish = () => resolve(result);
				started();
			});
		const executing = f.service.call('alice', 'exec', { workspace_id: created.workspace_id, command: 'true' });
		await running;
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, [{ ...created, busy: true }]);
		finish();
		await executing;
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, [created]);
	} finally {
		await f.cleanup();
	}
});

Deno.test('workspace: with a live session, file operations run caged and never touch the tree (D-077)', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		await f.service.call('alice', 'write', { workspace_id, path: 'before.txt', content: 'fast path' });
		assertEquals(f.backend.caged.length, 0);
		await f.service.call('alice', 'session_open', { workspace_id });
		assertEquals(await f.service.call('alice', 'read', { workspace_id, path: 'a/b.txt' }), { caged: 'read' });
		assertEquals(await f.service.call('alice', 'list', { workspace_id, path: 'a' }), { caged: 'list' });
		assertEquals(await f.service.call('alice', 'write', { workspace_id, path: 'a/new.txt', content: 'x' }), {
			written: true,
			bytes: 1,
			path: 'a/new.txt',
		});
		assertEquals(f.backend.caged.map((c) => c.op), [
			{ kind: 'read', path: 'a/b.txt' },
			{ kind: 'list', path: 'a' },
			{ kind: 'write', path: 'a/new.txt', content: 'x' },
		]);
		// The service itself created nothing for the caged write.
		assertEquals(await Deno.lstat(`${f.root}/${workspace_id}/a`).then(() => true, () => false), false);
		// Path rules still apply before any cage runs.
		for (const path of ['../x', '/etc/passwd', '.git/config', 'c:/x']) {
			await assertRejects(() => f.service.call('alice', 'read', { workspace_id, path }));
		}
		assertEquals(f.backend.caged.length, 3);
	} finally {
		await f.cleanup();
	}
});

// --- R12: a workspace from a git remote (design §2.19) ---------------------------------------------------------

const COMMIT = '80445e2e21d609fd261502c216b1847b40923c7d';
const TOKEN = 'ghp_workspace_test_token_0123456789';
/** A stand-in for what serves the clone step's socket; the fake backend never opens it. */
const EGRESS: OpenEgress = () => ({ reached: new Set(), refused: new Set(), close: () => Promise.resolve() });

/** A clone step that lands: `.git` appears in the checkout and the script prints its outcome. */
async function landed(root: string, req: ExecRequest): Promise<ExecResult> {
	await Deno.mkdir(`${root}/${req.runId}/.git`, { recursive: true });
	return { ...result, output: `ttk-clone-commit ${COMMIT}\nttk-clone-ref main\n`, diskBytes: 4096 };
}

/** The fixture's backend under a service that clones from `settings`, recording every request it runs. */
async function cloning(settings: Partial<CloneSettings> = {}) {
	const f = await fixture();
	const requests: ExecRequest[] = [];
	const removed: string[] = [];
	f.backend.exec = async (req: ExecRequest): Promise<ExecResult> => {
		requests.push(req);
		return await landed(f.root, req);
	};
	f.backend.remove = (runId: string): Promise<{ removed: boolean }> => {
		removed.push(runId);
		return Promise.resolve({ removed: true });
	};
	const { remotes } = parseGitRemotes(JSON.stringify([
		{ id: 'app', url: 'https://github.com/acme/private.git', token: TOKEN },
	]));
	const hosts: string[] = [];
	const forwarded: GitRemote[] = [];
	const service = new WorkspaceService(f.root, f.backend, {
		hosts: new Set(['github.com']),
		remotes,
		publicEgress: (allowed) => {
			hosts.push(...allowed);
			return EGRESS;
		},
		forwardEgress: (remote) => {
			forwarded.push(remote);
			return EGRESS;
		},
		...settings,
	});
	await service.initialize();
	/** What is in the work folder besides the owner records. */
	const left = async (): Promise<string[]> => {
		const found: string[] = [];
		for await (const entry of Deno.readDir(f.root)) if (entry.name !== '.owners') found.push(entry.name);
		for await (const entry of Deno.readDir(`${f.root}/.owners`)) found.push(`.owners/${entry.name}`);
		return found.sort();
	};
	return { ...f, service, requests, removed, hosts, forwarded, left };
}

Deno.test('R12 workspace: a public clone runs once in the provisioning step with the git hosts, then is a workspace', async () => {
	const f = await cloning();
	try {
		const { limits, ...cloned } = await f.service.call('alice', 'clone', {
			url: 'https://GitHub.com/acme/app.git',
			ref: 'main',
			depth: 2,
			name: 'app',
		});
		const id = cloned.workspace_id as string;
		assertEquals({ ...cloned, created_at: '' }, {
			workspace_id: id,
			created_at: '',
			name: 'app',
			commit: COMMIT,
			ref: 'main',
		});
		assertEquals((limits as Record<string, number>).disk_used_bytes, 4096);
		// One step: the fixed public script, the checked values in its environment, the git-host egress.
		assertEquals(f.requests.length, 1);
		const [request] = f.requests;
		assertEquals(request!.runId, id);
		assertEquals(request!.command, cloneScript('public'));
		assertEquals([request!.network, request!.cwd, request!.stdin, request!.timeoutMs], [
			'git',
			'',
			null,
			LIMITS.defaultTimeoutMs,
		]);
		assertEquals(request!.env, cloneEnv({ url: 'https://github.com/acme/app.git', ref: 'main', depth: 2 }));
		assert(request!.egress === EGRESS);
		assertEquals(f.hosts, ['github.com']);
		assertEquals(f.forwarded, []);
		// The record says what was measured, and that provisioning finished.
		const record = JSON.parse(await Deno.readTextFile(`${f.root}/.owners/${id}.json`));
		assertEquals([record.disk_bytes, record.provisioning, record.name], [4096, undefined, 'app']);
		// It lists like any workspace, and the listing says what a clone may name.
		assertEquals(await f.service.call('alice', 'list', {}), {
			workspaces: [{ workspace_id: id, created_at: cloned.created_at, name: 'app' }],
			clone: { hosts: ['github.com'], remotes: ['app'] },
		});
		assertEquals(await f.service.health(), { ok: true, backend: 'bwrap', clone: true });
		// An ordinary command on it now takes the ordinary path.
		await f.service.call('alice', 'exec', { workspace_id: id, command: 'ls' });
		assertEquals(f.requests.at(-1)!.network, 'none');
		assertEquals(f.requests.at(-1)!.egress, undefined);
	} finally {
		await f.cleanup();
	}
});

Deno.test('R12 workspace: a credentialed clone goes through the forwarder for that remote; no credential reaches the step', async () => {
	const f = await cloning();
	try {
		const cloned = await f.service.call('alice', 'clone', { remote: 'app' });
		const id = cloned.workspace_id as string;
		assertEquals([cloned.commit, cloned.ref], [COMMIT, 'main']);
		const [request] = f.requests;
		assertEquals(request!.command, cloneScript('forwarded'));
		// The step learns the remote's public URL (for `origin`), never its credential.
		assertEquals(request!.env.TTK_GIT_URL, 'https://github.com/acme/private.git');
		assertEquals(f.forwarded.map((remote) => remote.id), ['app']);
		assert(!JSON.stringify(request).includes(TOKEN));
		assert(!JSON.stringify(cloned).includes(TOKEN));
		assert(!(await Deno.readTextFile(`${f.root}/.owners/${id}.json`)).includes(TOKEN));
		assert(!JSON.stringify(await f.service.call('alice', 'list', {})).includes(TOKEN));
	} finally {
		await f.cleanup();
	}
});

Deno.test('R12 workspace: every refusal comes before the disk or the network', async () => {
	const f = await cloning();
	try {
		const refused: [Record<string, unknown>, string][] = [
			[{}, 'exactly one of url and remote'],
			[{ url: 'https://github.com/a.git', remote: 'app' }, 'exactly one of url and remote'],
			[{ url: 'https://gitlab.com/a.git' }, 'git host list'],
			[{ url: 'http://github.com/a.git' }, 'https://host/path'],
			[{ url: 'https://x:y@github.com/a.git' }, 'https://host/path'],
			[{ remote: 'nope' }, 'is not a remote'],
			[{ remote: 'app', ref: '--upload-pack=x' }, 'ref'],
			[{ remote: 'app', ref: 'a..b' }, 'ref'],
			[{ remote: 'app', depth: 0 }, 'depth'],
			[{ remote: 'app', timeout_ms: 999 }, 'timeout_ms'],
			[{ remote: 'app', name: 'x'.repeat(129) }, 'name'],
			[{ remote: 'app', files: { 'a.txt': 'seed' } }, 'unknown field'],
		];
		for (const [args, why] of refused) {
			const error = await assertRejects(() => f.service.call('alice', 'clone', args), RequestError);
			assert(error.message.includes(why), `${JSON.stringify(args)}: ${error.message}`);
		}
		assertEquals(f.requests, []);
		assertEquals(await f.left(), []);
		// A service with remotes only offers no public clone; one with neither offers no clone at all.
		const remotesOnly = new WorkspaceService(f.root, f.backend, {
			hosts: new Set(),
			remotes: parseGitRemotes('[{"id":"app","url":"https://github.com/a.git"}]').remotes,
		});
		await assertRejects(
			() => remotesOnly.call('alice', 'clone', { url: 'https://github.com/a.git' }),
			RequestError,
			'public clones are not enabled',
		);
		const none = new WorkspaceService(f.root, f.backend);
		assertEquals(none.clones, false);
		assertEquals((await none.health()).clone, false);
		assertEquals(await none.call('alice', 'list', {}), { workspaces: [] });
		await assertRejects(() => none.call('alice', 'clone', { remote: 'app' }), RequestError);
		assertEquals(f.requests, []);
	} finally {
		await f.cleanup();
	}
});

Deno.test('R12 workspace: a failed, timed-out, oversized or cancelled clone leaves nothing behind', async () => {
	const f = await cloning();
	try {
		const outcomes: [Partial<ExecResult>, string][] = [
			[{ exitCode: 128, output: 'fatal: repository not found\n' }, 'clone_failed'],
			[{ exitCode: 0, output: 'no outcome lines\n' }, 'clone_failed'],
			[{ exitCode: null, killed: 'timeout', timedOut: true }, 'clone_timeout'],
			[{ exitCode: null, killed: 'disk' }, 'over_budget'],
			[{ exitCode: 0, overBudget: true, output: `ttk-clone-commit ${COMMIT}\nttk-clone-ref main\n` }, 'over_budget'],
		];
		for (const [outcome, code] of outcomes) {
			f.backend.exec = async (req: ExecRequest): Promise<ExecResult> => {
				await Deno.mkdir(`${f.root}/${req.runId}/.git`, { recursive: true });
				return { ...result, ...outcome };
			};
			const error = await assertRejects(() => f.service.call('alice', 'clone', { remote: 'app' }), ApiError);
			assertEquals(error.code, code);
			assertEquals(await f.left(), [], code);
		}
		assertEquals(f.removed.length, outcomes.length);
		// The caller going away cancels the step, and the workspace goes with it.
		const controller = new AbortController();
		f.backend.exec = (_req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> =>
			new Promise((resolve) => {
				controller.abort();
				signal?.addEventListener('abort', () => resolve({ ...result, exitCode: null, killed: 'cancelled' }), {
					once: true,
				});
				if (signal?.aborted) resolve({ ...result, exitCode: null, killed: 'cancelled' });
			});
		await assertRejects(() => f.service.call('alice', 'clone', { remote: 'app' }, controller.signal));
		assertEquals(await f.left(), []);
		assertEquals(await f.service.call('alice', 'list', {}), {
			workspaces: [],
			clone: { hosts: ['github.com'], remotes: ['app'] },
		});
	} finally {
		await f.cleanup();
	}
});

Deno.test('R12 workspace: while it clones, the workspace is listed busy at its full budget, creates go on, remove cancels it', async () => {
	const f = await cloning();
	try {
		let started!: (id: string) => void;
		const running = new Promise<string>((resolve) => {
			started = resolve;
		});
		f.backend.exec = (req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> => {
			if (req.network !== 'git') return Promise.resolve(result);
			started(req.runId);
			return new Promise((resolve) => {
				signal?.addEventListener('abort', () => resolve({ ...result, exitCode: null, killed: 'cancelled' }), {
					once: true,
				});
			});
		};
		// Settled as soon as it ends, so its rejection is never left unhandled while the test goes on.
		const cloning = f.service.call('alice', 'clone', { url: 'https://github.com/acme/big.git' }).then(
			() => null,
			(error: unknown) => error,
		);
		const id = await running;
		const record = JSON.parse(await Deno.readTextFile(`${f.root}/.owners/${id}.json`));
		assertEquals([record.provisioning, record.disk_bytes], [true, LIMITS.diskBudgetBytes]);
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, [
			{ workspace_id: id, created_at: record.created_at, busy: true },
		]);
		// The service-wide provisioning slot was released: another workspace can be created meanwhile.
		const other = await f.service.call('alice', 'create', {});
		await assertRejects(() => f.service.call('alice', 'exec', { workspace_id: id, command: 'ls' }), ApiError, 'busy');
		assertEquals(await f.service.call('alice', 'remove', { workspace_id: id }), { removed: true });
		assert((await cloning) instanceof DOMException, 'the clone was cancelled');
		assertEquals(await f.left(), [other.workspace_id, `.owners/${other.workspace_id}.json`].sort());
	} finally {
		await f.cleanup();
	}
});

/** The owner hash the service keeps for `principal` (SHA-256, hex), as `ownerHash` in workspaces.ts computes it. */
async function ownerOf(principal: string): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(principal));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The file at `path` without following a link, or null when there is none. */
async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
	return await Deno.lstat(path).catch((error) => {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	});
}

/** Every operation a caller can name on one workspace but `remove`, with arguments that would otherwise succeed. */
const WORKSPACE_OPERATIONS = [
	['session_open', {}],
	['exec', { command: 'ls' }],
	['read', { path: 'README.md' }],
	['write', { path: 'planted.txt', content: 'x' }],
	['list', { path: '' }],
	['diff', {}],
] as const;

Deno.test('R3-1 workspace: a record still provisioning answers run_busy to everything but remove', async () => {
	const f = await cloning();
	try {
		// The state the clone race exposed: the record is listed, marked provisioning, and no lock is held on it.
		const id = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
		await Deno.mkdir(`${f.root}/${id}`);
		await Deno.writeTextFile(`${f.root}/${id}/README.md`, 'hello\n');
		await Deno.writeTextFile(
			`${f.root}/.owners/${id}.json`,
			JSON.stringify({ owner: await ownerOf('alice'), created_at: new Date().toISOString(), provisioning: true }),
		);
		for (const [operation, args] of WORKSPACE_OPERATIONS) {
			const error = await assertRejects(
				() => f.service.call('alice', operation, { workspace_id: id, ...args }),
				ApiError,
			);
			assertEquals([error.status, error.code], [409, 'run_busy'], operation);
		}
		// Nothing reached the backend: no session, no cage, no file written.
		assertEquals([...f.backend.open], []);
		assertEquals(f.requests, []);
		assertEquals(f.backend.caged, []);
		assertEquals(await lstatOrNull(`${f.root}/${id}/planted.txt`), null);
		// Another principal still learns nothing about it.
		await assertRejects(
			() => f.service.call('bob', 'exec', { workspace_id: id, command: 'ls' }),
			ApiError,
			'not found',
		);
		// Removing it is the one thing that works.
		assertEquals(await f.service.call('alice', 'remove', { workspace_id: id }), { removed: true });
		assertEquals(await f.left(), []);
	} finally {
		await f.cleanup();
	}
});

Deno.test('R3-1 workspace: no session or command gets in while the clone writes its record, and .git is read-only after', async () => {
	const f = await cloning();
	/** For every cage the backend was asked for: what it was, and whether `.git` existed when it was asked. */
	const cages: { kind: string; git: boolean }[] = [];
	const gitThere = async (runId: string) => (await lstatOrNull(`${f.root}/${runId}/.git`)) !== null;
	f.backend.exec = async (req: ExecRequest): Promise<ExecResult> => {
		if (req.network === 'git') return await landed(f.root, req);
		cages.push({ kind: 'exec', git: await gitThere(req.runId) });
		return result;
	};
	const openSession = f.backend.openSession;
	f.backend.openSession = async (owner, req, quota) => {
		cages.push({ kind: 'session', git: await gitThere(req.runId) });
		return await openSession.call(f.backend, owner, req, quota);
	};
	// The window the reviewer widened (r3_clone_race.ts): the record is renamed into place, and the service syncs its
	// folder before it goes on. Held open here until the test has tried everything.
	const owners = `${f.root}/.owners`;
	const open = Deno.open;
	let entered!: () => void;
	const inWindow = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let armed = true;
	(Deno as { open: typeof Deno.open }).open = (async (path: string | URL, options?: Deno.OpenOptions) => {
		if (armed && String(path) === owners) {
			armed = false;
			entered();
			await released;
		}
		return await open(path, options);
	}) as typeof Deno.open;
	const settled = f.service.call('alice', 'clone', { url: 'https://github.com/acme/app.git' }).then(
		(value) => ({ value, error: null }),
		(error: unknown) => ({ value: null, error }),
	);
	try {
		const reached = await Promise.race([inWindow.then(() => true), settled.then(() => false)]);
		assert(reached, 'the clone never synced its record folder; the test proved nothing');
		const [listed] = (await f.service.call('alice', 'list', {})).workspaces as { workspace_id: string }[];
		const id = listed!.workspace_id;
		const record = JSON.parse(await Deno.readTextFile(`${owners}/${id}.json`));
		assertEquals(record.provisioning, true, 'the record is listed and addressable in the window');
		for (const [operation, args] of WORKSPACE_OPERATIONS) {
			const error = await assertRejects(
				() => f.service.call('alice', operation, { workspace_id: id, ...args }),
				ApiError,
			);
			assertEquals([error.status, error.code], [409, 'run_busy'], operation);
		}
		assertEquals(cages, [], 'no cage opened before the clone step');
		release();
		const { value, error } = await settled;
		assertEquals(error, null);
		assertEquals(value!.workspace_id, id);
		// Every cage after the clone: `.git` is there when it is asked for, so bwrap and Docker both mount it read-only.
		await f.service.call('alice', 'session_open', { workspace_id: id });
		await f.service.call('alice', 'exec', { workspace_id: id, command: 'ls' });
		assertEquals(cages, [{ kind: 'session', git: true }, { kind: 'exec', git: true }]);
	} finally {
		release();
		(Deno as { open: typeof Deno.open }).open = open;
		await settled;
		await f.cleanup();
	}
});

Deno.test('R12 workspace: a clone a restart interrupted is discarded at start-up', async () => {
	const f = await cloning();
	try {
		const id = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
		await Deno.mkdir(`${f.root}/${id}/.git`, { recursive: true });
		await Deno.writeTextFile(
			`${f.root}/.owners/${id}.json`,
			JSON.stringify({ owner: 'x'.repeat(64), created_at: new Date().toISOString(), provisioning: true }),
		);
		const restarted = new WorkspaceService(f.root, f.backend, { hosts: new Set(['github.com']), remotes: [] });
		await restarted.initialize();
		assertEquals(await f.left(), []);
		assertEquals(f.removed, [id]);
	} finally {
		await f.cleanup();
	}
});
