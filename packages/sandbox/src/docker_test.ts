/**
 * AC6: the Docker backend's workspace lifecycle against a fake Engine API (testing_engine.ts), through the same
 * WorkspaceService the bwrap backend serves: create, exec, diff, live session, caged files, delete; the N3 cleanup
 * after every command; time limits; the registry proxy; startup checks and reconciliation; idle stop. Review R2: the
 * measurement with the container paused (R2-2), the start-up volume check in a folder of its own (R2-3), deployment
 * scoping (R2-5) and replacing a container whose body or image changed (R2-6).
 */
import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { proxyEnv } from './cage.ts';
import { treeUsage } from './disk.ts';
import { DockerSandbox, type ProxyHandle } from './docker.ts';
import { CLEANUP_SCRIPT, containerBody, createFor, deploymentId, KILL_SCRIPT, WRAPPER } from './docker_spec.ts';
import { Engine } from './engine.ts';
import { LIMITS } from './limits.ts';
import { cloneScript } from './clone.ts';
import { type OpenEgress } from './proxy.ts';
import { ApiError } from './sandbox.ts';
import { FakeEngine, type Player } from './testing_engine.ts';
import { WorkspaceService } from './workspaces.ts';

const POLICY = { image: 'tykotech-sandbox-workspace:0.2.0', volume: 'ttk-code', sockVolume: 'ttk-sandbox-sock' };
const DEPLOYMENT = await deploymentId(POLICY.volume);
const posix = Deno.build.os !== 'windows';
const RUN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

async function hash(principal: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(principal));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the fake's workspace commands do: `echo` prints, `serve &` leaves a process behind, `sleep` hangs. */
const player: Player = (exec) => {
	if (exec.env.TTK_PATH !== undefined) {
		if (exec.inner.includes('head -c')) return { output: 'caged text' };
		if (exec.inner.includes('cat >"$N"')) return { output: String(new TextEncoder().encode(exec.stdin).length) };
		return { output: 'f\tx.txt\0', exitCode: 0 };
	}
	const command = exec.args[0] ?? '';
	if (command.startsWith('echo ')) return { output: `${command.slice(5)}\n` };
	if (command === 'serve &') return { output: 'started\n', stray: true };
	if (command.startsWith('sleep')) return { hang: true };
	if (command === 'cat') return { output: exec.stdin };
	return { exitCode: 0 };
};

type Log = { level: string; event: string; fields: Record<string, unknown> };

/** One measurement as the backend asked for it, and whether the workspace's container was frozen meanwhile. */
interface Measured {
	paths: readonly string[];
	/** null: the container was not running, so there was nothing to freeze. */
	paused: boolean | null;
}

interface Parts {
	root: string;
	workDir: string;
	sockDir: string;
	fake: FakeEngine;
	logs: Log[];
	proxies: Array<ProxyHandle & { path: string; closed: boolean }>;
	measures: Measured[];
	control: { failMeasure: boolean };
	/** A backend on the fake and the folders, not started. */
	backend(options?: { checkTimeoutMs?: number }): DockerSandbox;
}

/** The fake daemon, the service's folders, and a way to make backends on them. */
async function parts(prepare?: (fake: FakeEngine, workDir: string) => Promise<void>): Promise<Parts> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const root = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'docker-' });
	const workDir = `${root}/work`;
	const sockDir = `${root}/sock`;
	await Deno.mkdir(`${workDir}/.owners`, { recursive: true });
	await Deno.mkdir(sockDir, { recursive: true });
	const fake = new FakeEngine({ workDir, player });
	await prepare?.(fake, workDir);
	const logs: Log[] = [];
	const proxies: Parts['proxies'] = [];
	const measures: Measured[] = [];
	const control = { failMeasure: false };
	const backend = (options: { checkTimeoutMs?: number } = {}): DockerSandbox =>
		new DockerSandbox({ workDir, sockDir, policy: POLICY, checkTimeoutMs: options.checkTimeoutMs ?? 10_000 }, {
			engine: new Engine(fake.dial),
			log: (level, event, fields) => logs.push({ level, event, fields }),
			proxy: { resolve: () => Promise.resolve([]), connect: () => Promise.reject(new Error('none')), log: () => {} },
			freeBytes: () => Promise.resolve(LIMITS.minFreeBytes * 100),
			openProxy: (path) => {
				const proxy = {
					path,
					closed: false,
					reached: new Set(['registry.npmjs.org']),
					refused: new Set<string>(),
					close: () => {
						proxy.closed = true;
						return Promise.resolve();
					},
				};
				proxies.push(proxy);
				return proxy;
			},
			// The real measurer, watched: which folders, and whether the workspace's container was frozen meanwhile.
			measure: async (paths, options) => {
				const container = fake.containerOf(RUN_ID.exec(paths[0] ?? '')?.[0] ?? '');
				measures.push({ paths, paused: container?.running ? container.paused : null });
				if (control.failMeasure) throw new Error('an unreadable tree');
				return await treeUsage(paths, options);
			},
		});
	return { root, workDir, sockDir, fake, logs, proxies, measures, control, backend };
}

interface Fixture extends Parts {
	docker: DockerSandbox;
	service: WorkspaceService;
	/** A restart: a new backend and service on the same daemon and folders, started and reconciled. */
	restart(): Promise<{ docker: DockerSandbox; service: WorkspaceService }>;
	cleanup(): Promise<void>;
}

async function fixture(prepare?: (fake: FakeEngine, workDir: string) => Promise<void>): Promise<Fixture> {
	const p = await parts(prepare);
	const started: DockerSandbox[] = [];
	const restart = async () => {
		const docker = p.backend();
		started.push(docker);
		await docker.start();
		const service = new WorkspaceService(p.workDir, docker);
		await service.initialize();
		return { docker, service };
	};
	const { docker, service } = await restart();
	return {
		...p,
		docker,
		service,
		restart,
		cleanup: async () => {
			for (const backend of started) backend.close();
			await p.fake.settle();
			await Deno.remove(p.root, { recursive: true });
		},
	};
}

/** The names in a folder, sorted. */
async function names(path: string): Promise<string[]> {
	const found: string[] = [];
	for await (const entry of Deno.readDir(path)) found.push(entry.name);
	return found.sort();
}

/** An owner record and the folders of a workspace an earlier run of the service created. */
async function plantWorkspace(workDir: string, id: string, principal = 'alice'): Promise<void> {
	await Deno.mkdir(`${workDir}/${id}/.git`, { recursive: true });
	await Deno.mkdir(`${workDir}/.sandbox/${id}/home`, { recursive: true });
	await Deno.writeTextFile(
		`${workDir}/.owners/${id}.json`,
		JSON.stringify({ owner: await hash(principal), created_at: new Date().toISOString(), disk_bytes: 0 }),
	);
}

/** Waits until `ready` holds, a few seconds at most. */
async function until(ready: () => boolean): Promise<void> {
	for (let i = 0; i < 300 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert(ready(), 'timed out waiting');
}

Deno.test('AC6 docker backend: create provisions in a container, then gives it the read-only .git; exact bodies', async () => {
	const f = await fixture();
	try {
		const created = await f.service.call('alice', 'create', { files: { 'a.txt': 'one\n' } });
		const id = created.workspace_id as string;
		const owner = await hash('alice');
		const creates = f.fake.calls.filter((c) => c.path.includes('/containers/create'));
		const mine = creates.filter((c) => c.path.endsWith(`-${id}`));
		assertEquals(mine.map((c) => c.path), [
			`/v1.45/containers/create?name=ttk-sandbox-${DEPLOYMENT}-${id}`,
			`/v1.45/containers/create?name=ttk-sandbox-${DEPLOYMENT}-${id}`,
		]);
		const target = { policy: POLICY, runId: id, owner, deployment: DEPLOYMENT };
		// `git init` runs in a container without the .git mount (it is not there yet), as in a cage...
		assertEquals(mine[0]!.body, containerBody(await createFor({ ...target, git: false })));
		// ...and the workspace's container from then on has it, read-only. Created, not yet started.
		assertEquals(mine[1]!.body, containerBody(await createFor({ ...target, git: true })));
		const containers = [...f.fake.containers.values()];
		assertEquals(containers.length, 1);
		assertEquals([containers[0]!.name, containers[0]!.running], [`ttk-sandbox-${DEPLOYMENT}-${id}`, false]);
		assertEquals(await Deno.readTextFile(`${f.workDir}/${id}/a.txt`), 'one\n');
		// The socket folder and home exist for the subpath mounts.
		assert((await Deno.stat(`${f.sockDir}/${id}`)).isDirectory);
		assert((await Deno.stat(`${f.workDir}/.sandbox/${id}/home`)).isDirectory);
		// R2-3: the volume was checked at start-up, in a container of its own; it and its folders are gone again.
		const check = creates[0]!;
		assert(!check.path.endsWith(id), check.path);
		assertEquals((check.body as { Labels: Record<string, string> }).Labels['eu.tykotech.owner'], '0'.repeat(64));
		assertEquals(await names(f.workDir), ['.owners', '.sandbox', id].sort());
		assertEquals(await names(`${f.workDir}/.sandbox`), [id]);
		assertEquals(await names(`${f.workDir}/.sandbox/${id}/home`), []);
		assertEquals(await names(f.sockDir), [id]);
		assertEquals(await f.service.health(), { ok: true, backend: 'docker', clone: false });
	} finally {
		await f.cleanup();
	}
});

Deno.test('AC6 docker backend: a command is one exec, its body fixed; N3: a cleanup exec follows every command', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		const result = await f.service.call('alice', 'exec', {
			workspace_id,
			command: 'echo hello',
			env: { FOO: 'bar' },
			stdin: 'input text',
		});
		assertEquals([result.output, result.exitCode, result.killed, result.timedOut], ['hello\n', 0, null, false]);
		assertEquals(
			result.diskBytes,
			await treeUsage([`${f.workDir}/${workspace_id}`, `${f.workDir}/.sandbox/${workspace_id}/home`], {
				timeoutMs: 10_000,
			}),
		);
		const bodies = f.fake.execBodies;
		const at = bodies.findIndex((b) => b.Cmd[5] === 'echo hello');
		const body = bodies[at]!;
		assertEquals(body.Cmd.slice(0, 4), ['/bin/sh', '-c', WRAPPER, 'harbour-sandbox']);
		assert(body.Cmd[4]!.endsWith('exec /bin/sh -c "$1"'));
		assertEquals(
			[body.User, body.Privileged, body.Tty, body.WorkingDir, body.AttachStdin, body.AttachStdout, body.AttachStderr],
			['1993:1993', false, false, '/workspace', true, true, true],
		);
		assert(body.Env.includes('FOO=bar') && body.Env.includes('HOME=/home/sandbox'));
		assert(!body.Env.some((e) => e.startsWith('HTTPS_PROXY=')), 'no proxy without registries');
		// N3: the exec right after the command is the cleanup, sparing nothing of the command.
		const cleanup = bodies[at + 1]!;
		assertEquals(cleanup.Cmd.slice(0, 4), ['/bin/sh', '-c', CLEANUP_SCRIPT, 'harbour-sandbox']);
		assertEquals(cleanup.WorkingDir, '/');
		const command = [...f.fake.execs.values()].find((e) => e.body.Cmd[5] === 'echo hello')!;
		const last = f.fake.cleanups.at(-1)!;
		assert(!last.keepSids.split(' ').includes(String(command.sid)), last.keepSids);
		assert(!last.keepPids.split(' ').includes(String(command.pid)), last.keepPids);
		// The command's working folder follows cwd.
		await Deno.mkdir(`${(f.workDir)}/${workspace_id}/src`);
		await f.service.call('alice', 'exec', { workspace_id, command: 'echo in src', cwd: 'src' });
		assertEquals(f.fake.execBodies.find((b) => b.Cmd[5] === 'echo in src')!.WorkingDir, '/workspace/src');
		assertEquals(f.fake.execBodies.find((b) => b.Cmd[5] === 'echo in src')!.AttachStdin, false);
	} finally {
		await f.cleanup();
	}
});

Deno.test('N3 docker backend: what a command leaves running is killed when it ends', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		const container = [...f.fake.containers.values()][0]!;
		const result = await f.service.call('alice', 'exec', { workspace_id, command: 'serve &' });
		assertEquals(result.output, 'started\n');
		assertEquals(container.strays, []);
		assertEquals(f.fake.cleanups.at(-1)!.killed, 1);
		assert(f.logs.some((l) => l.event === 'docker.cleanup' && l.fields.killed === 1));
	} finally {
		await f.cleanup();
	}
});

Deno.test('AC6 docker backend: a time limit kills the process group by a second exec, then cleans up', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		const result = await f.service.call('alice', 'exec', { workspace_id, command: 'sleep 100', timeout_ms: 1_000 });
		assertEquals([result.timedOut, result.killed, result.exitCode], [true, 'timeout', null]);
		const command = [...f.fake.execs.values()].find((e) => e.body.Cmd[5] === 'sleep 100')!;
		assertEquals(f.fake.kills, [{ runId: workspace_id, pgid: command.sid }]);
		const kill = f.fake.execBodies.find((b) => b.Cmd[2] === KILL_SCRIPT)!;
		assertEquals(kill.Cmd.slice(3), ['harbour-sandbox', String(command.sid)]);
		const trail = f.fake.execBodies.map((b) =>
			b.Cmd[2] === WRAPPER ? b.Cmd[5] ?? 'chore' : b.Cmd[2] === KILL_SCRIPT ? 'kill' : 'cleanup'
		);
		const killAt = trail.indexOf('kill');
		assertEquals(trail.slice(killAt - 1, killAt + 2), ['sleep 100', 'kill', 'cleanup']);
	} finally {
		await f.cleanup();
	}
});

Deno.test('AC6 docker backend: diff and caged file operations run in the container', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		const diff = await f.service.call('alice', 'diff', { workspace_id });
		assertEquals(diff.files, [{ path: 'a.txt', change: 'modified' }]);
		assertStringIncludes(diff.patch as string, '+two');
		const script = f.fake.execBodies.find((b) => b.Cmd[4]?.includes('GIT_INDEX_FILE'))!.Cmd[4]!;
		assertStringIncludes(script, 'GIT_INDEX_FILE=/home/sandbox/.harbour-diff/index');
		const { session_id } = await f.service.call('alice', 'session_open', { workspace_id });
		// D-077: with a session open, reads and writes run in the container, never on the service's own path.
		assertEquals(await f.service.call('alice', 'read', { workspace_id, path: 'x.txt' }), {
			content: 'caged text',
			bytes: 10,
		});
		assertEquals((await f.service.call('alice', 'write', { workspace_id, path: 'x.txt', content: 'hello' })).bytes, 5);
		const write = f.fake.execBodies.find((b) => b.Env.includes('TTK_PATH=x.txt') && b.AttachStdin)!;
		assertEquals(write.WorkingDir, '/workspace');
		await assertRejects(() => Deno.stat(`${f.workDir}/${workspace_id}/x.txt`));
		const cleanups = f.fake.cleanups.length;
		await f.service.call('alice', 'session_close', { session_id });
		// The teardown logs its end last, after the N3 cleanup.
		await until(() => f.fake.cleanups.length > cleanups && f.logs.some((l) => l.event === 'session.ended'));
	} finally {
		await f.cleanup();
	}
});

Deno.test('AC6 docker backend: a live session is a shell exec fed its input; closing it kills it and cleans up', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		const { session_id } = await f.service.call('alice', 'session_open', { workspace_id });
		// The shell starts once the session is answered, as bwrap's session cage does.
		const shell = () => [...f.fake.execs.values()].find((e) => e.body.Cmd[4]?.endsWith('exec /bin/sh -s') && e.running);
		await until(() => shell() !== undefined);
		const session = shell()!;
		assertEquals(session.body.AttachStdin, true);
		await f.service.call('alice', 'session_input', { session_id, data: 'ls\n' });
		let read = await f.service.call('alice', 'session_read', { session_id, wait_ms: 5_000 });
		assertEquals(read.output, '> ls\n');
		await assertRejects(() => f.service.call('bob', 'session_read', { session_id }), ApiError, 'No such session');
		// A command beside the open shell: its cleanup spares the shell's session.
		await f.service.call('alice', 'exec', { workspace_id, command: 'echo beside' });
		assert(f.fake.cleanups.at(-1)!.keepSids.split(' ').includes(String(session.sid)));
		assert(f.fake.cleanups.at(-1)!.keepPids.split(' ').includes(String(session.pid)));
		const cleanups = f.fake.cleanups.length;
		await f.service.call('alice', 'session_close', { session_id });
		for (let i = 0; i < 50 && !read.ended; i++) {
			read = await f.service.call('alice', 'session_read', { session_id, after: read.seq, wait_ms: 200 });
		}
		assertEquals([read.ended, read.killed], [true, 'closed']);
		assertEquals(f.fake.kills.at(-1)!.pgid, session.sid);
		// The teardown logs its end last, after the N3 cleanup.
		await until(() => f.fake.cleanups.length > cleanups && f.logs.some((l) => l.event === 'session.ended'));
	} finally {
		await f.cleanup();
	}
});

Deno.test('N3 docker backend: the proxy socket exists only while a registries-mode command runs', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		const result = await f.service.call('alice', 'exec', { workspace_id, command: 'echo npm', network: 'registries' });
		assertEquals(result.reachedHosts, ['registry.npmjs.org']);
		assertEquals(f.proxies.map((p) => [p.path, p.closed]), [[`${f.sockDir}/${workspace_id}/proxy.sock`, true]]);
		const body = f.fake.execBodies.find((b) => b.Cmd[5] === 'echo npm')!;
		for (const [name, value] of Object.entries(proxyEnv())) assert(body.Env.includes(`${name}=${value}`), name);
		assertStringIncludes(body.Cmd[4]!, 'UNIX-CONNECT:/run/harbour/proxy.sock');
		// One registries-mode exec per workspace: an open registries session holds the proxy.
		const { session_id } = await f.service.call('alice', 'session_open', { workspace_id, network: 'registries' });
		const busy = await assertRejects(
			() => f.service.call('alice', 'exec', { workspace_id, command: 'echo again', network: 'registries' }),
			ApiError,
		);
		assertEquals([busy.status, busy.code], [409, 'run_busy']);
		const cleanups = f.fake.cleanups.length;
		await f.service.call('alice', 'session_close', { session_id });
		await until(() =>
			f.fake.cleanups.length > cleanups && f.proxies.every((p) => p.closed) &&
			f.logs.some((l) => l.event === 'session.ended')
		);
	} finally {
		await f.cleanup();
	}
});

Deno.test('AC6 docker backend: delete removes the container and the workspace state', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		await f.service.call('alice', 'exec', { workspace_id, command: 'echo x' });
		const container = [...f.fake.containers.values()][0]!;
		assertEquals(await f.service.call('alice', 'remove', { workspace_id }), { removed: true });
		assertEquals(f.fake.containers.size, 0);
		assert(
			f.fake.calls.some((c) => c.method === 'DELETE' && c.path === `/v1.45/containers/${container.id}?force=true`),
		);
		for (
			const path of [
				`${f.workDir}/${workspace_id}`,
				`${f.workDir}/.sandbox/${workspace_id}`,
				`${f.sockDir}/${workspace_id}`,
			]
		) {
			await assertRejects(() => Deno.stat(path), Deno.errors.NotFound, path);
		}
		assertEquals((await f.service.call('alice', 'list', {})).workspaces, []);
	} finally {
		await f.cleanup();
	}
});

Deno.test('AC6 / R2-5 docker backend: reconciliation removes orphans, stops running ones, touches no other deployment', async () => {
	const owned = '11111111-2222-4333-8444-555555555555';
	const idle = '22222222-3333-4444-8555-666666666666';
	const stolen = '33333333-4444-4555-8666-777777777777';
	const orphan = '44444444-5555-4666-8777-888888888888';
	const frozen = '55555555-6666-4777-8888-999999999999';
	const elsewhere = 'b'.repeat(16);
	const planted: Record<string, string> = {};
	const f = await fixture(async (fake, workDir) => {
		const alice = await hash('alice');
		for (const id of [owned, idle, stolen, frozen]) await plantWorkspace(workDir, id);
		const label = (id: string, owner = alice, deployment: string | null = DEPLOYMENT) => ({
			'eu.tykotech.sandbox': '1',
			'eu.tykotech.workspace': id,
			'eu.tykotech.owner': owner,
			...(deployment === null ? {} : { 'eu.tykotech.deployment': deployment }),
		});
		const name = (id: string, deployment = DEPLOYMENT) => `ttk-sandbox-${deployment}-${id}`;
		planted.owned = fake.plant(name(owned), label(owned), true).id;
		planted.idle = fake.plant(name(idle), label(idle), false).id;
		planted.stolen = fake.plant(name(stolen), label(stolen, 'f'.repeat(64)), true).id;
		planted.orphan = fake.plant(name(orphan), label(orphan), true).id;
		planted.unlabelled = fake.plant('ttk-sandbox-odd', { 'eu.tykotech.sandbox': '1' }, false).id;
		const paused = fake.plant(name(frozen), label(frozen), true);
		paused.paused = true;
		planted.frozen = paused.id;
		// From before deployments were labelled: no name of this service finds it again.
		planted.legacy = fake.plant(`ttk-sandbox-${idle}`, label(idle, alice, null), true).id;
		// Another deployment's, though on this volume, and another sandbox's on its own volume: both left alone.
		planted.foreign = fake.plant(name(owned, elsewhere), label(owned, alice, elsewhere), true).id;
		planted.other = fake.plant(`other-${orphan}`, label(orphan), true, 'someone-elses-code').id;
	});
	try {
		const containers = f.fake.containers;
		assertEquals(containers.get(planted.owned!)?.running, false);
		assertEquals(containers.get(planted.idle!)?.running, false);
		assertEquals([containers.get(planted.frozen!)?.running, containers.get(planted.frozen!)?.paused], [false, false]);
		for (const gone of ['stolen', 'orphan', 'unlabelled', 'legacy']) {
			assertEquals(containers.has(planted[gone]!), false, gone);
		}
		assertEquals(containers.get(planted.foreign!)?.running, true);
		assertEquals(containers.get(planted.other!)?.running, true);
		assert(f.logs.some((l) => l.event === 'docker.reconciled' && l.fields.removed === 4 && l.fields.stopped === 2));
	} finally {
		await f.cleanup();
	}
});

Deno.test('D-108 docker backend: start refuses a daemon below API 1.45 and a missing volume', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const old = new FakeEngine({ workDir: 'tests/.scratch' });
	old.pingStatus = 400;
	const deps = {
		log: () => {},
		proxy: { resolve: () => Promise.resolve([]), connect: () => Promise.reject(new Error('none')), log: () => {} },
		freeBytes: () => Promise.resolve(LIMITS.minFreeBytes * 100),
	};
	const config = { workDir: 'tests/.scratch/x', sockDir: 'tests/.scratch/y', policy: POLICY };
	await assertRejects(
		() => new DockerSandbox(config, { ...deps, engine: new Engine(old.dial) }).start(),
		Error,
		'version 1.45',
	);
	const noVolume = new FakeEngine({ workDir: 'tests/.scratch', volumes: ['ttk-code'] });
	await assertRejects(
		() => new DockerSandbox(config, { ...deps, engine: new Engine(noVolume.dial) }).start(),
		Error,
		'ttk-sandbox-sock does not exist',
	);
	await old.settle();
	await noVolume.settle();
});

Deno.test('R2-5 docker backend: start refuses a code volume its containers do not see as the service does', async () => {
	const p = await parts();
	try {
		p.fake.volumeMismatch = true;
		const docker = p.backend();
		await assertRejects(() => docker.start(), Error, 'does not see the work volume');
		docker.close();
		assert(p.logs.some((l) => l.event === 'docker.volume_mismatch'));
		// The check's container and folders are gone, and no workspace was ever created.
		assertEquals(p.fake.containers.size, 0);
		assertEquals(await names(p.workDir), ['.owners', '.sandbox']);
		assertEquals(await names(`${p.workDir}/.sandbox`), []);
		assertEquals(await names(p.sockDir), []);
	} finally {
		await p.fake.settle();
		await Deno.remove(p.root, { recursive: true });
	}
});

Deno.test('R2-3 docker backend: a volume check that never answers fails start-up in bounded time', async () => {
	const p = await parts();
	try {
		p.fake.volumeCheckHangs = true;
		const docker = p.backend({ checkTimeoutMs: 300 });
		const began = performance.now();
		await assertRejects(() => docker.start(), Error, 'did not finish');
		docker.close();
		assert(performance.now() - began < 10_000, 'bounded, never hung');
		// The hung exec was killed by its process group, and nothing of the check is left.
		assertEquals(p.fake.kills.length, 1);
		assertEquals(p.fake.containers.size, 0);
		assertEquals(await names(`${p.workDir}/.sandbox`), []);
	} finally {
		await p.fake.settle();
		await Deno.remove(p.root, { recursive: true });
	}
});

Deno.test('R2-3 docker backend: the volume check never writes in a workspace’s home, whatever was left there', async () => {
	const existing = '66666666-7777-4888-8999-aaaaaaaaaaaa';
	const linked = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
	const f = await fixture(async (_fake, workDir) => {
		await plantWorkspace(workDir, existing);
		// A file a command left at the very name the check used to write, in the workspace's own home.
		await Deno.writeTextFile(`${workDir}/.sandbox/${existing}/home/.harbour-volume-check`, 'mine');
		if (posix) {
			// And a link there to a file of the service's: a write through it would land outside the workspace.
			await plantWorkspace(workDir, linked);
			await Deno.writeTextFile(`${workDir}/canary.txt`, 'canary');
			await Deno.symlink(`${workDir}/canary.txt`, `${workDir}/.sandbox/${linked}/home/.harbour-volume-check`);
		}
	});
	try {
		for (const id of posix ? [linked, existing] : [existing]) {
			assertEquals((await f.service.call('alice', 'exec', { workspace_id: id, command: 'echo ok' })).output, 'ok\n');
		}
		assertEquals(await Deno.readTextFile(`${f.workDir}/.sandbox/${existing}/home/.harbour-volume-check`), 'mine');
		if (posix) assertEquals(await Deno.readTextFile(`${f.workDir}/canary.txt`), 'canary');
		assertEquals(await names(`${f.workDir}/.sandbox`), (posix ? [existing, linked] : [existing]).sort());
	} finally {
		await f.cleanup();
	}
});

Deno.test('R2-2 docker backend: disk use is measured by the service with the container paused, never by an exec in it', async () => {
	const f = await fixture();
	try {
		const workspace_id = (await f.service.call('alice', 'create', {})).workspace_id as string;
		await f.service.call('alice', 'write', { workspace_id, path: 'data/blob.bin', content: 'x'.repeat(100_000) });
		const before = f.measures.length;
		const result = await f.service.call('alice', 'exec', { workspace_id, command: 'echo measured' });
		const container = f.fake.containerOf(workspace_id)!;
		assert((result.diskBytes as number) >= 100_000, String(result.diskBytes));
		// Before and after the command, of the checkout and the home as the service holds them, each with the
		// workspace's container frozen; and thawed again after each.
		const measured = f.measures.slice(before);
		assertEquals(measured.map((m) => m.paths), [
			[`${f.workDir}/${workspace_id}`, `${f.workDir}/.sandbox/${workspace_id}/home`],
			[`${f.workDir}/${workspace_id}`, `${f.workDir}/.sandbox/${workspace_id}/home`],
		]);
		assertEquals(measured.map((m) => m.paused), [true, true]);
		assertEquals(container.paused, false);
		const freezes = f.fake.trail.filter((call) => call.endsWith('/pause') || call.endsWith('/unpause'));
		assertEquals(freezes.slice(-4), [
			`POST /containers/${container.id}/pause`,
			`POST /containers/${container.id}/unpause`,
			`POST /containers/${container.id}/pause`,
			`POST /containers/${container.id}/unpause`,
		]);
		// Nothing measures inside the container any more: no du, no find.
		for (const body of f.fake.execBodies) {
			assert(!/\bdu -s|\bfind \/workspace/.test(body.Cmd.join('\n')), body.Cmd.join(' '));
		}
		// A stopped container has nothing running in it: measured as it is, not paused.
		await f.docker.stopIdle(Date.now() + LIMITS.containerIdleMs + 1);
		assertEquals(container.running, false);
		await f.service.call('alice', 'write', { workspace_id, path: 'data/more.txt', content: 'more' });
		assertEquals(f.measures.at(-1)!.paused, null);
	} finally {
		await f.cleanup();
	}
});

Deno.test('R2-2 docker backend: a measurement that fails counts as over budget, so the command may only clean up', async () => {
	const f = await fixture();
	try {
		const workspace_id = (await f.service.call('alice', 'create', {})).workspace_id as string;
		f.control.failMeasure = true;
		const result = await f.service.call('alice', 'exec', { workspace_id, command: 'echo cleanup' });
		assertEquals([result.output, result.cleanupOnly, result.overBudget], ['cleanup\n', true, true]);
		// The command could write no file data (SB-7), and the failure was logged.
		const body = f.fake.execBodies.find((b) => b.Cmd[5] === 'echo cleanup')!;
		assertStringIncludes(body.Cmd[4]!, 'ulimit -f 0');
		assert(f.logs.some((l) => l.event === 'docker.measure_failed' && l.fields.runId === workspace_id));
		// Nor can a file be written from outside while it cannot be measured.
		await assertRejects(() => f.service.call('alice', 'write', { workspace_id, path: 'x.txt', content: 'x' }));
		f.control.failMeasure = false;
		assertEquals((await f.service.call('alice', 'exec', { workspace_id, command: 'echo fine' })).cleanupOnly, false);
	} finally {
		await f.cleanup();
	}
});

Deno.test('R2-2 docker backend: a container that cannot be unpaused is stopped, never left frozen', async () => {
	const f = await fixture();
	try {
		const workspace_id = (await f.service.call('alice', 'create', {})).workspace_id as string;
		f.fake.unpauseStatus = 500;
		assertEquals((await f.service.call('alice', 'exec', { workspace_id, command: 'echo on' })).output, 'on\n');
		const container = f.fake.containerOf(workspace_id)!;
		assertEquals([container.running, container.paused], [false, false]);
		assert(f.logs.some((l) => l.event === 'docker.unpause_failed'));
		// The next command starts it again.
		f.fake.unpauseStatus = 204;
		assertEquals((await f.service.call('alice', 'exec', { workspace_id, command: 'echo again' })).output, 'again\n');
		assertEquals([container.running, container.paused], [true, false]);
	} finally {
		await f.cleanup();
	}
});

Deno.test('R2-6 docker backend: a container whose body or image changed since is replaced; an identical one is kept', async () => {
	const f = await fixture();
	try {
		const workspace_id = (await f.service.call('alice', 'create', {})).workspace_id as string;
		const first = f.fake.containerOf(workspace_id)!;
		const expected = containerBody(
			await createFor({
				policy: POLICY,
				runId: workspace_id,
				owner: await hash('alice'),
				git: true,
				deployment: DEPLOYMENT,
			}),
		);
		assertEquals(first.body, expected as unknown as Record<string, unknown>);
		// A restart finds it by name and keeps it: the same body, from the same image.
		let next = await f.restart();
		await next.service.call('alice', 'exec', { workspace_id, command: 'echo kept' });
		assertEquals(f.fake.containerOf(workspace_id)!.id, first.id);
		// What an earlier release created: a field the old match never compared (CapDrop), under that body's hash.
		first.body = {
			...first.body,
			Labels: { ...(first.body.Labels as Record<string, string>), 'eu.tykotech.body': 'e'.repeat(64) },
			HostConfig: { ...(first.body.HostConfig as Record<string, unknown>), CapDrop: [] },
		};
		next = await f.restart();
		await next.service.call('alice', 'exec', { workspace_id, command: 'echo replaced' });
		const second = f.fake.containerOf(workspace_id)!;
		assertNotEquals(second.id, first.id);
		assertEquals(second.body, expected as unknown as Record<string, unknown>);
		assert(f.logs.some((l) => l.event === 'docker.replaced' && l.fields.runId === workspace_id));
		// The tag re-pointed at a rebuilt image: the next start learns the new id, and the old container goes.
		f.fake.images.set(POLICY.image, 'sha256:rebuilt');
		next = await f.restart();
		await next.service.call('alice', 'exec', { workspace_id, command: 'echo rebuilt' });
		const third = f.fake.containerOf(workspace_id)!;
		assertNotEquals(third.id, second.id);
		assertEquals(third.imageId, 'sha256:rebuilt');
		assertEquals(f.fake.containers.size, 1);
	} finally {
		await f.cleanup();
	}
});

Deno.test('D-108 docker backend: idle containers stop, and start again on demand; one stopped behind its back too', async () => {
	const f = await fixture();
	try {
		const { workspace_id } = await f.service.call('alice', 'create', {});
		await f.service.call('alice', 'exec', { workspace_id, command: 'echo one' });
		const container = [...f.fake.containers.values()][0]!;
		assertEquals(container.running, true);
		await f.docker.stopIdle(Date.now() + 1_000);
		assertEquals(container.running, true, 'not idle long enough');
		await f.docker.stopIdle(Date.now() + LIMITS.containerIdleMs + 1);
		assertEquals(container.running, false);
		assert(f.logs.some((l) => l.event === 'docker.idle_stopped'));
		assertEquals((await f.service.call('alice', 'exec', { workspace_id, command: 'echo two' })).output, 'two\n');
		assertEquals(container.running, true);
		// Stopped from outside: the next exec is refused by Docker, and the backend starts it and goes on.
		container.running = false;
		assertEquals((await f.service.call('alice', 'exec', { workspace_id, command: 'echo three' })).output, 'three\n');
	} finally {
		await f.cleanup();
	}
});

/** R12: a clone step's egress as the backend opens it, recorded; the fake container never connects to it. */
function recordingEgress(opened: Array<{ path: string; runId: string; closed: boolean }>): OpenEgress {
	return (path, _deps, runId) => {
		const handle = {
			path,
			runId,
			closed: false,
			reached: new Set(['github.com']),
			refused: new Set<string>(),
			close: () => {
				handle.closed = true;
				return Promise.resolve();
			},
		};
		opened.push(handle);
		return handle;
	};
}

Deno.test('R12 docker backend: a clone runs once in the provisioning container, then .git is mounted read-only', async () => {
	const f = await fixture();
	try {
		const commit = 'c'.repeat(40);
		f.fake.player = async (exec) => {
			if (exec.env.TTK_GIT_URL === undefined) return await player(exec);
			await Deno.mkdir(`${f.workDir}/${exec.runId}/.git/objects`, { recursive: true });
			return { output: `ttk-clone-commit ${commit}\nttk-clone-ref main\n` };
		};
		const opened: Array<{ path: string; runId: string; closed: boolean }> = [];
		const service = new WorkspaceService(f.workDir, f.docker, {
			hosts: new Set(['github.com']),
			remotes: [],
			publicEgress: () => recordingEgress(opened),
		});
		const cloned = await service.call('alice', 'clone', { url: 'https://github.com/acme/app.git', ref: 'main' });
		const id = cloned.workspace_id as string;
		assertEquals([cloned.commit, cloned.ref], [commit, 'main']);
		// The step ran in a container without the .git mount (there was none yet); the one after mounts it read-only.
		const target = { policy: POLICY, runId: id, owner: await hash('alice'), deployment: DEPLOYMENT };
		const mine = f.fake.calls.filter((c) => c.path.includes('/containers/create') && c.path.endsWith(`-${id}`));
		assertEquals(mine.map((c) => c.body), [
			containerBody(await createFor({ ...target, git: false })),
			containerBody(await createFor({ ...target, git: true })),
		]);
		// One exec: the fixed script as $1 (never inside the script), the forwarder started, the proxy and git variables.
		const steps = f.fake.execBodies.filter((b) => b.Env.some((e) => e.startsWith('TTK_GIT_URL=')));
		assertEquals(steps.length, 1);
		const [step] = steps;
		assertEquals(step!.Cmd[5], cloneScript('public'));
		assert(step!.Cmd[4]!.endsWith('exec /bin/sh -c "$1"'));
		assertStringIncludes(step!.Cmd[4]!, 'UNIX-CONNECT:/run/harbour/proxy.sock');
		for (const [name, value] of Object.entries(proxyEnv())) assert(step!.Env.includes(`${name}=${value}`), name);
		for (
			const entry of ['TTK_GIT_URL=https://github.com/acme/app.git', 'TTK_GIT_REF=main', 'GIT_CONFIG_GLOBAL=/dev/null']
		) {
			assert(step!.Env.includes(entry), entry);
		}
		assertEquals(step!.WorkingDir, '/workspace');
		// The egress existed on the workspace's socket only for the step.
		assertEquals(opened.map((o) => [o.path, o.runId, o.closed]), [[`${f.sockDir}/${id}/proxy.sock`, id, true]]);
		// A command afterwards is an ordinary one: no egress, and the .git mount stays.
		await service.call('alice', 'exec', { workspace_id: id, command: 'echo after' });
		assertEquals(opened.length, 1);
		assertEquals(
			f.fake.calls.filter((c) => c.path.includes('/containers/create') && c.path.endsWith(`-${id}`)).length,
			2,
		);
	} finally {
		await f.cleanup();
	}
});

Deno.test('R12 docker backend: a failed clone removes its container and every folder it had', async () => {
	const f = await fixture();
	try {
		f.fake.player = (exec) =>
			exec.env.TTK_GIT_URL !== undefined ? { output: 'fatal: not found\n', exitCode: 128 } : player(exec);
		const opened: Array<{ path: string; runId: string; closed: boolean }> = [];
		const service = new WorkspaceService(f.workDir, f.docker, {
			hosts: new Set(['github.com']),
			remotes: [],
			publicEgress: () => recordingEgress(opened),
		});
		const error = await assertRejects(
			() => service.call('alice', 'clone', { url: 'https://github.com/acme/missing.git' }),
			ApiError,
		);
		assertEquals([error.status, error.code], [502, 'clone_failed']);
		const id = opened[0]!.runId;
		assertEquals(opened[0]!.closed, true);
		assertEquals(f.fake.containers.size, 0);
		for (
			const path of [
				`${f.workDir}/${id}`,
				`${f.workDir}/.sandbox/${id}`,
				`${f.sockDir}/${id}`,
				`${f.workDir}/.owners/${id}.json`,
			]
		) {
			await assertRejects(() => Deno.stat(path), Deno.errors.NotFound, path);
		}
		assertEquals((await service.call('alice', 'list', {})).workspaces, []);
	} finally {
		await f.cleanup();
	}
});
