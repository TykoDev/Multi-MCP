/**
 * Real cages: runs only on Linux with bubblewrap installed and `--allow-run=/usr/bin/bwrap` granted, and throws
 * everywhere else. `deno task test:sandbox` (tests/sandbox/verify_sandbox.ts) runs it inside the sandbox image, as
 * the service's own user and under the production posture, roughly:
 *
 *   docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
 *     --security-opt=seccomp=docker/seccomp-sandbox.json --security-opt=systempaths=unconfined \
 *     --tmpfs /work:uid=1993,gid=1993,mode=0700,size=512m -e TTK_SANDBOX_TEST_DIR=/work \
 *     --entrypoint deno <sandbox image> test --allow-run=/usr/bin/bwrap,... tests/sandbox/cages_test.ts
 *
 * It imports nothing from outside packages/sandbox but the package's own `#sandbox-assert`, so it runs offline.
 */
import assert from '#sandbox-assert';
import { probeProcPaths } from '../../packages/sandbox/src/cage.ts';
import { cloneEnv, cloneScript } from '../../packages/sandbox/src/clone.ts';
import { userNamespaceFilter } from '../../packages/sandbox/src/filter.ts';
import { parseGitRemotes } from '../../packages/sandbox/src/git_forwarder.ts';
import { type OpenEgress, type ProxyDeps, RegistryProxy } from '../../packages/sandbox/src/proxy.ts';
import { type ExecRequest } from '../../packages/sandbox/src/request.ts';
import {
	ApiError,
	freeBytes,
	Sandbox,
	type SandboxDeps,
	type SandboxLimits,
} from '../../packages/sandbox/src/sandbox.ts';
import { testPki } from '../../packages/sandbox/src/testing_tls.ts';
import { WorkspaceService } from '../../packages/sandbox/src/workspaces.ts';
import { ADVERTISEMENT, FIXTURE_COMMIT, FIXTURE_README, PACK_REPLY, SHALLOW_REPLY } from './git_fixture.ts';

const RUN = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const OTHER = '11111111-2222-4333-8444-555555555555';
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

async function available(): Promise<boolean> {
	if (Deno.build.os !== 'linux') return false;
	const run = await Deno.permissions.query({ name: 'run', command: '/usr/bin/bwrap' });
	if (run.state !== 'granted') return false;
	try {
		return (await new Deno.Command('/usr/bin/bwrap', { args: ['--version'] }).output()).success;
	} catch {
		return false;
	}
}
if (!(await available())) throw new Error('Linux bubblewrap runtime is required for cage tests.');

/** A sandbox on a scratch work folder, with a checkout for RUN made the way the API would. */
async function setup(deps: Partial<SandboxDeps> = {}, limits?: Partial<SandboxLimits>) {
	const workDir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
	const runtimeDir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
	const logged: string[] = [];
	const sandbox = new Sandbox({
		workDir,
		runtimeDir,
		bwrap: '/usr/bin/bwrap',
		system: {
			etc: decodeURIComponent(new URL('../../packages/sandbox/cage/etc', import.meta.url).pathname),
			proc: await probeProcPaths('/usr/bin/bwrap'),
		},
		filter: userNamespaceFilter(Deno.build.arch),
		limits,
	}, {
		log: (_level, event) => logged.push(event),
		proxy: {
			resolve: () => Promise.resolve([]),
			connect: () => Promise.reject(new Error('no network in this test')),
			log: () => {},
		},
		freeBytes: () => Promise.resolve(100 * GiB),
		...deps,
	});
	await Deno.mkdir(`${workDir}/${RUN}/src`, { recursive: true });
	await Deno.writeTextFile(`${workDir}/${RUN}/src/a.txt`, 'one\n');
	await Deno.writeTextFile(`${workDir}/${RUN}/keep.txt`, 'keep\n');
	await Deno.writeTextFile(`${workDir}/${RUN}/.gitignore`, 'ignored/\n');
	// The checkout gets its repository the only way this process can run git: in a cage. .git does
	// not exist yet, so this one command may create it.
	const init = await sandbox.exec(exec({
		command: 'git init -q -b main . && git add -A && ' +
			'git -c user.name=t -c user.email=t@example.com commit -qm init && echo committed',
	}));
	assert.equal(init.output.trim(), 'committed', init.output);
	const cleanup = async () => {
		await sandbox.remove(RUN).catch(() => {});
		await Deno.remove(workDir, { recursive: true }).catch(() => {});
		await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
	};
	return { sandbox, workDir, logged, cleanup };
}

function exec(over: Partial<ExecRequest>): ExecRequest {
	return {
		runId: RUN,
		command: 'true',
		cwd: '',
		timeoutMs: 60_000,
		network: 'none',
		env: {},
		stdin: null,
		...over,
	};
}

function cageTest(name: string, fn: () => Promise<void>) {
	Deno.test({ name: `cages: ${name}`, sanitizeResources: false, fn });
}

cageTest(
	"a command runs in the checkout, as the sandbox's user, in a clean environment",
	async () => {
		const { sandbox, cleanup } = await setup();
		try {
			const r = await sandbox.exec(exec({
				command: 'pwd; whoami; echo "$HOME $CI $LANG"; env | grep -c . ; cat /proc/1/environ | wc -c',
				cwd: 'src',
				env: { NODE_ENV: 'test' },
			}));
			const [pwd, who, vars, _count, initEnv] = r.output.trim().split('\n');
			assert.equal(r.exitCode, 0, r.output);
			assert.equal(pwd, '/workspace/src');
			assert.equal(who, 'sandbox');
			assert.equal(vars, '/home/sandbox 1 C.UTF-8');
			// bubblewrap's init was started with an empty environment, so there is nothing to read there.
			assert.equal(initEnv, '0');
		} finally {
			await cleanup();
		}
	},
);

cageTest('.git is read-only and the rest of the checkout is writable', async () => {
	const { sandbox, workDir, cleanup } = await setup();
	try {
		const before = await Deno.readFile(`${workDir}/${RUN}/.git/index`);
		const r = await sandbox.exec(exec({
			command: 'touch .git/x 2>&1; rm -rf .git 2>&1 | head -1; mv .git g 2>&1; echo hi > written.txt',
		}));
		assert.match(r.output, /Read-only file system/);
		assert.match(r.output, /Device or resource busy|Read-only/);
		assert.equal(await Deno.readTextFile(`${workDir}/${RUN}/written.txt`), 'hi\n');
		assert.deepEqual(await Deno.readFile(`${workDir}/${RUN}/.git/index`), before);
	} finally {
		await cleanup();
	}
});

cageTest('a cage sees nothing of the container: no other run, no secrets, no token', async () => {
	Deno.env.set('SANDBOX_TOKEN', 'a-token-that-must-never-reach-a-cage-0123456789');
	const { sandbox, workDir, cleanup } = await setup();
	try {
		await Deno.mkdir(`${workDir}/${OTHER}`);
		await Deno.writeTextFile(`${workDir}/${OTHER}/secret.txt`, "the other run's file\n");
		const r = await sandbox.exec(exec({
			command: "ls / | tr '\\n' ' '; echo; ls /work /run/secrets 2>&1; " +
				'find / -xdev -name secret.txt 2>/dev/null | head -1; ' +
				'grep -rsl a-token-that-must-never /proc/[0-9]*/environ /proc/[0-9]*/cmdline | head -1; ' +
				"ls /proc | grep -cE '^[0-9]+$'",
		}));
		const lines = r.output.trim().split('\n');
		assert.deepEqual(lines[0]!.trim().split(' ').sort(), [
			'bin',
			'dev',
			'etc',
			'home',
			'lib',
			'lib64',
			'proc',
			'sbin',
			'tmp',
			'usr',
			'workspace',
		]);
		assert.match(r.output, /ls: cannot access '\/work': No such file or directory/);
		assert.match(r.output, /ls: cannot access '\/run\/secrets': No such file or directory/);
		assert.ok(!r.output.includes('secret.txt'), r.output);
		assert.ok(!r.output.includes('environ'), r.output);
		// bubblewrap's init, the shell, and what it started: a pid namespace of its own.
		assert.ok(Number(lines.at(-1)) < 10, r.output);
	} finally {
		Deno.env.delete('SANDBOX_TOKEN');
		await cleanup();
	}
});

cageTest("what Docker hides in /proc is hidden in a cage's own /proc too", async () => {
	const hidden = await probeProcPaths('/usr/bin/bwrap');
	assert.ok(hidden.readOnly.includes('/proc/sys'), JSON.stringify(hidden));
	const { sandbox, cleanup } = await setup();
	try {
		const r = await sandbox.exec(exec({
			command: 'cat /proc/self/mountinfo; ' +
				'if [ -e /proc/kcore ]; then cat /proc/kcore >/dev/null 2>&1 && echo kcore=read || echo kcore=refused; fi',
		}));
		assert.equal(r.exitCode, 0, r.output);
		// Mount point and its options, from each mountinfo line.
		const options = new Map(
			r.output.split('\n').map((line) => line.split(' ')).filter((f) => f.length > 6)
				.map((f) => [f[4]!, f[5]!.split(',')]),
		);
		for (const path of [...hidden.files, ...hidden.dirs, ...hidden.readOnly]) {
			assert.ok(options.get(path)?.includes('ro'), `${path}: ${options.get(path)}`);
		}
		// The kernel's memory image is /dev/null, which a cage cannot even open.
		if (hidden.files.includes('/proc/kcore')) assert.match(r.output, /^kcore=refused$/m);
	} finally {
		await cleanup();
	}
});

cageTest('no network without the proxy, and no new user namespaces', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		const r = await sandbox.exec(exec({
			command: "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '; " +
				'python3 -c \'import socket; socket.create_connection(("1.1.1.1", 443), 3)\' 2>&1 | tail -1; ' +
				'unshare -U true 2>&1; echo unshare=$?; ' +
				"python3 -c 'import os; os.unshare(os.CLONE_NEWUSER)' 2>&1 | tail -1",
		}));
		const lines = r.output.trim().split('\n');
		assert.equal(lines[0], 'lo');
		assert.match(r.output, /Network is unreachable|No route/);
		if (userNamespaceFilter(Deno.build.arch)) {
			assert.match(r.output, /unshare=1/);
			assert.match(r.output, /Operation not permitted/);
		}
	} finally {
		await cleanup();
	}
});

/**
 * The container's processes running `sleep 317x`. Deno will not read /proc without --allow-all,
 * so a bubblewrap that keeps the container's pid namespace reads it instead.
 */
async function sleepers(): Promise<string[]> {
	const out = await new Deno.Command('/usr/bin/bwrap', {
		args: [
			'--unshare-user',
			'--unshare-net',
			'--ro-bind',
			'/',
			'/',
			'--dev',
			'/dev',
			'--',
			'/bin/sh',
			'-c',
			"for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' <\"$f\"; echo; done 2>/dev/null",
		],
		clearEnv: true,
		env: {},
	}).output();
	return new TextDecoder().decode(out.stdout).split('\n').filter((l) => /^sleep 317[12]/.test(l));
}

cageTest('a time limit kills the whole cage, background processes included', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		// Two sleeps nothing else would run, one of them in the background.
		const running = sandbox.exec(exec({ command: 'sleep 3171 & sleep 3172', timeoutMs: 2_000 }));
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.equal((await sleepers()).length, 2);
		const r = await running;
		assert.equal(r.timedOut, true);
		assert.equal(r.killed, 'timeout');
		assert.equal(r.exitCode, null);
		assert.ok(r.durationMs < 10_000, String(r.durationMs));
		assert.deepEqual(await sleepers(), []);
	} finally {
		await cleanup();
	}
});

cageTest('output is capped with its head and tail, in order, stderr included', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		const ordered = await sandbox.exec(exec({ command: 'echo a; echo b >&2; echo c; exit 3' }));
		assert.equal(ordered.output, 'a\nb\nc\n');
		assert.equal(ordered.exitCode, 3);
		const big = await sandbox.exec(exec({
			command: "echo FIRST; head -c 3000000 /dev/zero | tr '\\0' x; echo; echo LAST",
		}));
		assert.equal(big.truncated, true);
		assert.equal(big.outputBytes, 6 + 3_000_000 + 1 + 5);
		assert.ok(big.output.startsWith('FIRST\nxxx'));
		assert.ok(big.output.endsWith('xxx\nLAST\n'));
		assert.ok(big.output.length < 1024 * 1024 + 100);
	} finally {
		await cleanup();
	}
});

cageTest('standard input reaches the command and is gone from /tmp before it runs', async () => {
	const { sandbox, workDir, cleanup } = await setup();
	try {
		const r = await sandbox.exec(exec({
			command: 'python3 - && ls -a /tmp',
			stdin: "open('made.txt', 'w').write('x')\nprint(6 * 7)\n",
		}));
		assert.equal(r.exitCode, 0, r.output);
		assert.match(r.output, /^42\n/);
		assert.ok(!r.output.includes('.harbour-stdin'), r.output);
		assert.equal(await Deno.readTextFile(`${workDir}/${RUN}/made.txt`), 'x');
	} finally {
		await cleanup();
	}
});

cageTest('/tmp is emptied between commands; HOME is kept for the run', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		await sandbox.exec(
			exec({ command: 'echo t > /tmp/t; echo h > ~/h; mkdir -p /tmp/d; chmod 0 /tmp/d' }),
		);
		const r = await sandbox.exec(exec({ command: 'ls -A /tmp; cat ~/h' }));
		assert.equal(r.output, 'h\n');
	} finally {
		await cleanup();
	}
});

cageTest('processes per cage are limited', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		// The shell says so each time it cannot start one more; the cage ends with the shell.
		const r = await sandbox.exec(exec({
			command: 'i=0; while [ $i -lt 400 ]; do sleep 3171 >/dev/null 2>&1 & i=$((i + 1)); done',
			timeoutMs: 20_000,
		}));
		assert.match(r.output, /Cannot fork/);
		assert.equal(r.killed, null);
		assert.deepEqual(await sleepers(), []);
	} finally {
		await cleanup();
	}
});

cageTest('the diff holds everything a command changed, and .git does not move', async () => {
	const { sandbox, workDir, cleanup } = await setup();
	try {
		const index = await Deno.readFile(`${workDir}/${RUN}/.git/index`);
		await sandbox.exec(exec({
			command: 'echo two > src/a.txt; rm keep.txt; echo new > new.txt; mkdir -p ignored node_modules/x; ' +
				"echo i > ignored/i; echo m > node_modules/x/m.js; printf 'bin\\000ary' > b.bin; " +
				'echo secret > locked.txt; chmod 000 locked.txt',
		}));
		const diff = await sandbox.diff(RUN);
		assert.deepEqual(diff.files, [
			{ path: 'b.bin', change: 'added' },
			{ path: 'keep.txt', change: 'deleted' },
			{ path: 'locked.txt', change: 'added' },
			{ path: 'new.txt', change: 'added' },
			{ path: 'src/a.txt', change: 'modified' },
		]);
		assert.match(diff.patch, /^diff --git a\/b\.bin b\/b\.bin/m);
		assert.match(diff.patch, /Binary files \/dev\/null and b\/b\.bin differ/);
		assert.match(diff.patch, /\+new\n/);
		assert.match(diff.patch, /-one\n\+two\n/);
		assert.equal(diff.truncated, false);
		assert.deepEqual(await Deno.readFile(`${workDir}/${RUN}/.git/index`), index);
	} finally {
		await cleanup();
	}
});

cageTest('removing a run clears its state and leaves its checkout removable', async () => {
	const { sandbox, workDir, cleanup } = await setup();
	try {
		await sandbox.exec(
			exec({
				command: 'mkdir -p locked/deep && touch locked/deep/f && chmod 500 locked locked/deep',
			}),
		);
		await sandbox.exec(exec({ command: 'echo s > /tmp/f' }));
		assert.ok(await sandbox.diskUsage(RUN) > 0);
		assert.deepEqual(await sandbox.remove(RUN), { removed: true });
		await assert.rejects(Deno.stat(`${workDir}/.sandbox/${RUN}`));
		// What the API does at the end of a run now works.
		await Deno.remove(`${workDir}/${RUN}`, { recursive: true });
		assert.deepEqual(await sandbox.remove(RUN), { removed: false });
	} finally {
		await cleanup();
	}
});

cageTest('a disk running low stops the command, and one already low refuses it', async () => {
	let free = 100 * GiB;
	const { sandbox, cleanup } = await setup({ freeBytes: () => Promise.resolve(free) });
	try {
		setTimeout(() => free = GiB / 2, 500);
		const stopped = await sandbox.exec(exec({ command: 'sleep 30', timeoutMs: 20_000 }));
		assert.equal(stopped.killed, 'disk');
		assert.equal(stopped.exitCode, null);
		const refused = await sandbox.exec(exec({ command: 'true' })).catch((e) => e);
		assert.ok(refused instanceof ApiError);
		assert.equal(refused.status, 507);
	} finally {
		await cleanup();
	}
});

cageTest('a command without a checkout, or in a folder that is not there, is refused', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		const none = await sandbox.exec(exec({ runId: OTHER })).catch((e) => e);
		assert.equal((none as ApiError).status, 404);
		const cwd = await sandbox.exec(exec({ cwd: 'missing' })).catch((e) => e);
		assert.match(String(cwd), /missing does not exist/);
	} finally {
		await cleanup();
	}
});

cageTest('the registry proxy opens tunnels to registries and refuses the rest', async () => {
	// A stand-in registry: whatever registry.npmjs.org resolves to, the tunnel ends here.
	const upstream = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const answering = (async () => {
		for await (const conn of upstream) {
			await conn.write(new TextEncoder().encode('hello from the registry\n')).catch(() => 0);
			conn.close();
		}
	})().catch(() => {});
	const proxy: ProxyDeps = {
		resolve: (host) => Promise.resolve(host === 'registry.npmjs.org' ? ['104.16.0.35'] : []),
		connect: () => Deno.connect({ hostname: '127.0.0.1', port: (upstream.addr as Deno.NetAddr).port }),
		log: () => {},
	};
	const { sandbox, cleanup } = await setup({ proxy });
	try {
		const r = await sandbox.exec(exec({
			network: 'registries',
			command: 'echo $HTTPS_PROXY; ' +
				"printf 'CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\n\\r\\n' | socat -t 2 - TCP:127.0.0.1:3128; " +
				"printf 'CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n' | socat -t 2 - TCP:127.0.0.1:3128 | head -1; " +
				"printf 'CONNECT 169.254.169.254:443 HTTP/1.1\\r\\n\\r\\n' | socat -t 2 - TCP:127.0.0.1:3128 | head -1",
		}));
		assert.match(r.output, /^http:\/\/127\.0\.0\.1:3128\n/);
		assert.match(r.output, /HTTP\/1\.1 200 Connection established/);
		assert.match(r.output, /hello from the registry/);
		assert.match(r.output, /HTTP\/1\.1 403 Forbidden/);
		assert.deepEqual(r.reachedHosts, ['registry.npmjs.org']);
		assert.deepEqual(r.refusedHosts.sort(), ['169.254.169.254:443', 'example.com:443']);
		// Without asking for it, there is no proxy at all.
		const none = await sandbox.exec(exec({ command: 'echo ${HTTPS_PROXY:-none}; ls /run 2>&1' }));
		assert.match(none.output, /^none\n/);
	} finally {
		upstream.close();
		await answering;
		await cleanup();
	}
});

/**
 * SB-1 at a small scale: the real work volume (statfs of the test's tmpfs), lifted far above the
 * free-space floor so only the budget can stop a command, and a budget of a few MiB.
 */
const realDisk: Partial<SandboxDeps> = { freeBytes: async (path) => 100 * GiB + await freeBytes(path) };
const small = (budget: number): Partial<SandboxLimits> => ({
	diskBudgetBytes: budget,
	diskPollMs: 100,
	diskTriggerBytes: MiB,
	diskNoiseBytes: 8 * MiB,
});
/** Writes 1 MiB at a time, 300 times, into a directory du cannot read without CAP_DAC_READ_SEARCH. */
const lockedWriter = 'mkdir -p h && chmod 300 h && i=0; while [ $i -lt 300 ]; do ' +
	'head -c 1048576 /dev/zero >> h/f || exit 9; i=$((i + 1)); sleep 0.02; done; echo finished';

cageTest('SB-1: a directory a command locked (chmod 000) still counts toward the budget', async () => {
	const { sandbox, cleanup } = await setup(realDisk, small(64 * MiB));
	try {
		const r = await sandbox.exec(exec({
			command: 'mkdir h && head -c 16777216 /dev/zero > h/f && chmod 000 h && ls h 2>&1; echo locked',
		}));
		assert.equal(r.exitCode, 0, r.output);
		assert.match(r.output, /Permission denied/);
		assert.ok(r.diskBytes >= 16 * MiB, String(r.diskBytes));
		assert.ok(await sandbox.diskUsage(RUN) >= 16 * MiB);
	} finally {
		await cleanup();
	}
});

cageTest('SB-1: the chmod-000 attack is stopped while it runs; the run may then only clean up (SB-7)', async () => {
	const { sandbox, workDir, cleanup } = await setup(realDisk, small(32 * MiB));
	try {
		const attack = await sandbox.exec(exec({ command: lockedWriter, timeoutMs: 60_000 }));
		assert.equal(attack.killed, 'disk', attack.output);
		assert.equal(attack.exitCode, null);
		assert.ok(!attack.output.includes('finished'), attack.output);
		// Stopped early, and what it wrote behind the locked directory is counted.
		assert.ok(attack.diskBytes > 32 * MiB && attack.diskBytes < 150 * MiB, String(attack.diskBytes));
		assert.equal(attack.overBudget, true);

		// Over budget: the next command runs, but can write no file data at all.
		const grow = await sandbox.exec(
			exec({ command: 'head -c 4096 /dev/zero > more.bin; echo "rc=$?"; wc -c <more.bin' }),
		);
		assert.equal(grow.cleanupOnly, true);
		assert.match(grow.output, /File too large/);
		assert.match(grow.output, /rc=1\n0\n$/);
		assert.ok(grow.diskBytes <= attack.diskBytes + 64 * 1024, `${grow.diskBytes} > ${attack.diskBytes}`);
		// Removing is what it is for.
		const clean = await sandbox.exec(exec({ command: 'chmod 700 h && rm -rf h more.bin && echo cleaned' }));
		assert.equal(clean.cleanupOnly, true);
		assert.equal(clean.output, 'cleaned\n');
		assert.equal(clean.overBudget, false);
		const back = await sandbox.exec(exec({ command: 'echo ok > ok.txt && cat ok.txt' }));
		assert.equal(back.cleanupOnly, false);
		assert.equal(back.output, 'ok\n');

		// Far past the budget (only overshoots get there), nothing runs; removing the workspace is the way out.
		await Deno.writeFile(`${workDir}/${RUN}/huge.bin`, new Uint8Array(80 * MiB).fill(1));
		const refused = await sandbox.exec(exec({ command: 'rm huge.bin' })).catch((e) => e);
		assert.ok(refused instanceof ApiError, String(refused));
		assert.equal(refused.status, 507);
		assert.equal(refused.code, 'over_budget');
	} finally {
		await cleanup();
	}
});

cageTest('SB-1: with another cage running, the locked directory is measured (du) while the command runs', async () => {
	const { sandbox, workDir, cleanup } = await setup(realDisk, small(32 * MiB));
	try {
		// A second cage on the volume: the attack can no longer be charged with all of the volume's
		// loss, so only du, reading the directory it locked, can stop it.
		await Deno.mkdir(`${workDir}/${OTHER}`);
		const other = sandbox.exec(exec({ runId: OTHER, command: 'sleep 4; echo slept' }));
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const attack = await sandbox.exec(exec({ command: lockedWriter, timeoutMs: 60_000 }));
		assert.equal(attack.killed, 'disk', attack.output);
		assert.ok(attack.diskBytes > 32 * MiB && attack.diskBytes < 150 * MiB, String(attack.diskBytes));
		const quiet = await other;
		assert.equal(quiet.killed, null);
		assert.equal(quiet.output, 'slept\n');
		await sandbox.remove(OTHER);
	} finally {
		await cleanup();
	}
});

cageTest("SB-1: a diff whose scratch objects outgrow the run's budget is stopped", async () => {
	const { sandbox, workDir, cleanup } = await setup(realDisk, small(16 * MiB));
	try {
		// Incompressible, so git's staged blob is as large as the file.
		const noise = new Uint8Array(96 * MiB);
		for (let at = 0; at < noise.length; at += 65_536) crypto.getRandomValues(noise.subarray(at, at + 65_536));
		await Deno.writeFile(`${workDir}/${RUN}/noise.bin`, noise);
		const stopped = await sandbox.diff(RUN).catch((e) => e);
		assert.ok(stopped instanceof ApiError, String(stopped));
		assert.equal(stopped.status, 507);
		assert.equal(stopped.code, 'over_budget');
		await Deno.remove(`${workDir}/${RUN}/noise.bin`);
		await Deno.writeTextFile(`${workDir}/${RUN}/small.txt`, 'small\n');
		assert.deepEqual((await sandbox.diff(RUN)).files, [{ path: 'small.txt', change: 'added' }]);
	} finally {
		await cleanup();
	}
});

// --- D-076: live sessions ---------------------------------------------------------------------------

cageTest('a live session runs a shell that answers line by line, beside file reads, until it is closed', async () => {
	const { sandbox, cleanup, logged } = await setup();
	try {
		const opened = await sandbox.openSession('owner', { runId: RUN, network: 'none' });
		assert.ok(opened.session_id);
		await sandbox.sessionInput('owner', opened.session_id, 'echo hi-$((1+1)); pwd; ls src\n');
		let collected = '';
		let after = 0;
		for (let i = 0; i < 40 && !collected.includes('a.txt'); i += 1) {
			const read = await sandbox.sessionRead('owner', opened.session_id, after, 1_000);
			collected += read.output;
			after = read.seq;
		}
		assert.ok(collected.includes('hi-2'), collected);
		assert.ok(collected.includes('/workspace'), collected);
		assert.ok(collected.includes('a.txt'), collected);
		// The session holds no run lock: a command can still run beside it.
		const beside = await sandbox.exec(exec({ command: 'echo beside' }));
		assert.equal(beside.output.trim(), 'beside');
		// A second session on the same run is refused; another owner cannot see this one.
		await assert.rejects(() => sandbox.openSession('owner', { runId: RUN, network: 'none' }), ApiError);
		await assert.rejects(() => sandbox.sessionRead('intruder', opened.session_id, 0, 0), ApiError);
		// The shell exits on request and the session reports the end.
		await sandbox.sessionInput('owner', opened.session_id, 'exit 7\n');
		let ended = false;
		let exitCode: number | null = null;
		for (let i = 0; i < 40 && !ended; i += 1) {
			const read = await sandbox.sessionRead('owner', opened.session_id, after, 1_000);
			after = read.seq;
			ended = read.ended;
			exitCode = read.exit_code;
		}
		assert.ok(ended, 'the session ended');
		assert.equal(exitCode, 7);
		assert.ok(logged.includes('session.opened'));
		// The end is reported to readers first and logged when the cage's teardown completes.
		for (let i = 0; i < 30 && !logged.includes('session.ended'); i += 1) await new Promise((r) => setTimeout(r, 100));
		assert.ok(logged.includes('session.ended'));
		// A new session can be opened after the end, and closing it stops the cage.
		const again = await sandbox.openSession('owner', { runId: RUN, network: 'none' });
		sandbox.sessionClose('owner', again.session_id);
		let closed = false;
		for (let i = 0; i < 40 && !closed; i += 1) {
			closed = (await sandbox.sessionRead('owner', again.session_id, 0, 1_000)).ended;
		}
		assert.ok(closed, 'close ended the session');
		// Its teardown (a measuring cage) finishes after the end is reported; the test waits for it too, or the
		// cage outlives the test and the op sanitizer reports it.
		const endings = () => logged.filter((event) => event === 'session.ended').length;
		for (let i = 0; i < 50 && endings() < 2; i += 1) await new Promise((r) => setTimeout(r, 100));
		assert.equal(endings(), 2);
	} finally {
		await cleanup();
	}
});

cageTest('removing a run ends its live session', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		const opened = await sandbox.openSession('owner', { runId: RUN, network: 'none' });
		await sandbox.remove(RUN);
		let ended = false;
		for (let i = 0; i < 40 && !ended; i += 1) {
			ended = (await sandbox.sessionRead('owner', opened.session_id, 0, 1_000)).ended;
		}
		assert.ok(ended);
	} finally {
		await cleanup();
	}
});

/** Closes a session and waits until its cage is gone, so no test leaves a process or a timer behind. */
async function closeAndWait(sandbox: Sandbox, sessionId: string, logged: string[]): Promise<void> {
	const before = logged.filter((e) => e === 'session.ended').length;
	sandbox.sessionClose('owner', sessionId);
	for (let i = 0; i < 100 && logged.filter((e) => e === 'session.ended').length === before; i += 1) {
		await new Promise((r) => setTimeout(r, 100));
	}
}

// --- D-077: file operations beside a live session ----------------------------------------------------

cageTest('caged file operations never leave the checkout while a session swaps directories for links', async () => {
	const { sandbox, workDir, cleanup, logged } = await setup();
	try {
		// A sibling workspace with a secret, reachable from the service's view as ../OTHER.
		await Deno.mkdir(`${workDir}/${OTHER}`, { recursive: true });
		await Deno.writeTextFile(`${workDir}/${OTHER}/secret.txt`, 'sibling-secret\n');
		const opened = await sandbox.openSession('owner', { runId: RUN, network: 'none' });
		// The attacker's loop: `sub` is a real directory one moment and a link out of the checkout the next.
		await sandbox.sessionInput(
			'owner',
			opened.session_id,
			`while :; do rm -rf sub; mkdir sub; rm -rf sub; ln -s ../${OTHER} sub; done >/dev/null 2>&1 &\necho looping\n`,
		);
		let after = 0;
		let said = '';
		for (let i = 0; i < 40 && !said.includes('looping'); i += 1) {
			const read = await sandbox.sessionRead('owner', opened.session_id, after, 1_000);
			said += read.output;
			after = read.seq;
		}
		assert.ok(said.includes('looping'), said);
		let wrote = 0;
		let refused = 0;
		let escapes = 0;
		for (let i = 0; i < 40; i += 1) {
			for (
				const op of [
					{ kind: 'write' as const, path: 'sub/planted.txt', content: 'planted' },
					{ kind: 'read' as const, path: 'sub/secret.txt' },
					{ kind: 'list' as const, path: 'sub' },
				]
			) {
				// The control: in the service's own view the link really does point out of the checkout.
				try {
					if ((await Deno.lstat(`${workDir}/${RUN}/sub`)).isSymlink) {
						escapes += (await Deno.realPath(`${workDir}/${RUN}/sub`)) === (await Deno.realPath(`${workDir}/${OTHER}`))
							? 1
							: 0;
					}
				} catch {
					// Between states.
				}
				try {
					const reply = await sandbox.fileOp(RUN, op);
					if (op.kind === 'write') wrote += 1;
					assert.ok(!JSON.stringify(reply).includes('sibling-secret'), `read the sibling: ${JSON.stringify(reply)}`);
					assert.ok(!JSON.stringify(reply).includes('secret.txt'), `listed the sibling: ${JSON.stringify(reply)}`);
				} catch (error) {
					assert.ok(error instanceof Error && error.name !== 'AssertionError', String(error));
					refused += 1;
				}
			}
		}
		const sibling = (await Array.fromAsync(Deno.readDir(`${workDir}/${OTHER}`))).map((e) => e.name);
		assert.deepEqual(sibling, ['secret.txt'], `the sibling workspace was written: ${sibling.join(', ')}`);
		console.log(
			`D-077 race: the service saw sub -> sibling ${escapes} times; ${wrote} caged writes landed in the checkout, ${refused} operations refused, sibling untouched`,
		);
		assert.ok(escapes > 0, 'the race never exposed a link; the test proved nothing');
		assert.ok(wrote + refused > 0);
		await closeAndWait(sandbox, opened.session_id, logged);
	} finally {
		await cleanup();
	}
});

cageTest('a live session cannot replace the read-only .git that later cages mount by path', async () => {
	const { sandbox, cleanup, logged } = await setup();
	try {
		const opened = await sandbox.openSession('owner', { runId: RUN, network: 'none' });
		await sandbox.sessionInput(
			'owner',
			opened.session_id,
			'mv .git g2 2>/dev/null; echo mv=$?; rm -rf .git 2>/dev/null; echo rm=$?; [ -d .git/objects ] && echo still-there\n',
		);
		let after = 0;
		let said = '';
		for (let i = 0; i < 40 && !said.includes('still-there'); i += 1) {
			const read = await sandbox.sessionRead('owner', opened.session_id, after, 1_000);
			said += read.output;
			after = read.seq;
		}
		assert.ok(/mv=[1-9]/.test(said), said);
		assert.ok(said.includes('still-there'), said);
		await closeAndWait(sandbox, opened.session_id, logged);
	} finally {
		await cleanup();
	}
});

cageTest('caged file operations answer like the fast path: write, read, list, refusals', async () => {
	const { sandbox, cleanup } = await setup();
	try {
		assert.deepEqual(await sandbox.fileOp(RUN, { kind: 'write', path: 'n/e/w.txt', content: 'hé\n' }), {
			written: true,
			bytes: 4,
		});
		assert.deepEqual(await sandbox.fileOp(RUN, { kind: 'read', path: 'n/e/w.txt' }), { content: 'hé\n', bytes: 4 });
		const listed = await sandbox.fileOp(RUN, { kind: 'list', path: '' }) as { entries: { name: string }[] };
		assert.ok(listed.entries.some((e) => e.name === 'n') && !listed.entries.some((e) => e.name === '.git'));
		await assert.rejects(() => sandbox.fileOp(RUN, { kind: 'read', path: 'missing.txt' }), ApiError);
		await assert.rejects(() => sandbox.fileOp(RUN, { kind: 'read', path: 'src' }), ApiError);
		await assert.rejects(() => sandbox.fileOp(RUN, { kind: 'write', path: 'keep.txt/x', content: 'x' }));
		await sandbox.exec(exec({ command: 'ln -s src linked' }));
		await assert.rejects(() => sandbox.fileOp(RUN, { kind: 'read', path: 'linked/a.txt' }));
		await assert.rejects(() => sandbox.fileOp(RUN, { kind: 'write', path: 'linked/b.txt', content: 'x' }));
	} finally {
		await cleanup();
	}
});

// --- R12: workspaces from a git remote (design §2.19, AC32, AC34) ----------------------------------------------

const GIT_HOST = 'git.example.test';
const GIT_TOKEN = 'ghp_cage_tier_token_0123456789abcdef';
const GIT_PUBLIC = '93.184.216.34';

/** One request as the stand-in remote received it. */
interface GitSeen {
	method: string;
	target: string;
	authorization: string | null;
}

function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/**
 * A stand-in git remote for GIT_HOST: TLS with a throwaway CA only the forwarder is told to trust, replaying the
 * recorded upload-pack exchange (git_fixture.ts) for `/acme/app.git`; `/acme/moved.git` redirects, anything else is
 * 404. It records what it was asked and with which credential.
 */
async function gitRemote() {
	const pki = await testPki([GIT_HOST]);
	const seen: GitSeen[] = [];
	const listener = Deno.listenTls({ hostname: '127.0.0.1', port: 0, cert: pki.cert, key: pki.key });
	const tasks: Promise<void>[] = [];
	const encoder = new TextEncoder();
	const answer = async (conn: Deno.Conn): Promise<void> => {
		try {
			let bytes: Uint8Array = new Uint8Array(0);
			const buffer = new Uint8Array(65536);
			const more = async (): Promise<boolean> => {
				const n = await conn.read(buffer);
				if (n === null) return false;
				bytes = joined(bytes, buffer.subarray(0, n));
				return true;
			};
			let end = -1;
			while ((end = new TextDecoder('latin1').decode(bytes).indexOf('\r\n\r\n')) < 0) if (!(await more())) return;
			const [first, ...lines] = new TextDecoder('latin1').decode(bytes.subarray(0, end)).split('\r\n');
			const headers = new Map(lines.map((line) => {
				const colon = line.indexOf(':');
				return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] as const;
			}));
			let body: Uint8Array = bytes.subarray(end + 4);
			if (headers.has('content-length')) {
				const size = Number(headers.get('content-length'));
				while (body.length < size && (await more())) body = bytes.subarray(end + 4);
			} else if (/chunked/i.test(headers.get('transfer-encoding') ?? '')) {
				for (;;) {
					const text = new TextDecoder('latin1').decode(body);
					if (/(^|\r\n)0\r\n\r\n$/.test(text)) break;
					if (!(await more())) break;
					body = bytes.subarray(end + 4);
				}
				let plain: Uint8Array = new Uint8Array(0);
				let at = 0;
				for (;;) {
					const lineEnd = new TextDecoder('latin1').decode(body.subarray(at)).indexOf('\r\n');
					const size = parseInt(new TextDecoder('latin1').decode(body.subarray(at, at + lineEnd)), 16);
					at += lineEnd + 2;
					if (!size) break;
					plain = joined(plain, body.subarray(at, at + size));
					at += size + 2;
				}
				body = plain;
			}
			if (/gzip/i.test(headers.get('content-encoding') ?? '')) {
				body = new Uint8Array(
					await new Response(
						new Blob([body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')),
					)
						.arrayBuffer(),
				);
			}
			const [method, target] = first!.split(' ');
			seen.push({ method: method!, target: target!, authorization: headers.get('authorization') ?? null });
			let status = 200;
			let type = 'text/plain';
			let reply: Uint8Array = encoder.encode('not found\n');
			const extra: string[] = [];
			if (method === 'GET' && target === '/acme/app.git/info/refs?service=git-upload-pack') {
				type = 'application/x-git-upload-pack-advertisement';
				reply = ADVERTISEMENT;
			} else if (method === 'POST' && target === '/acme/app.git/git-upload-pack') {
				type = 'application/x-git-upload-pack-result';
				reply = new TextDecoder('latin1').decode(body).includes('0009done') ? PACK_REPLY : SHALLOW_REPLY;
			} else if (target?.startsWith('/acme/moved.git/')) {
				status = 301;
				extra.push(`Location: https://elsewhere.example.test${target}`);
			} else {
				status = 404;
			}
			const head = [
				`HTTP/1.1 ${status} X`,
				`Content-Type: ${type}`,
				'Cache-Control: no-cache',
				`Content-Length: ${reply.length}`,
				...extra,
				'Connection: close',
				'',
				'',
			].join('\r\n');
			await conn.write(joined(encoder.encode(head), reply));
		} catch {
			// The client went away, or refused the certificate.
		} finally {
			try {
				conn.close();
			} catch {
				// closed
			}
		}
	};
	const serving = (async () => {
		for await (const conn of listener) tasks.push(answer(conn));
	})().catch(() => {});
	return {
		pki,
		seen,
		port: (listener.addr as Deno.NetAddr).port,
		close: async () => {
			listener.close();
			await serving;
			await Promise.allSettled(tasks);
		},
	};
}

/** Every file under `dir`, as bytes, following no link. */
async function filesUnder(dir: string): Promise<{ path: string; bytes: Uint8Array }[]> {
	const found: { path: string; bytes: Uint8Array }[] = [];
	for await (const entry of Deno.readDir(dir)) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory) found.push(...await filesUnder(path));
		else if (entry.isFile) found.push({ path, bytes: await Deno.readFile(path) });
	}
	return found;
}

cageTest(
	'R12: a credentialed clone runs git in a cage through the forwarder; the credential never enters the cage',
	async () => {
		const remote = await gitRemote();
		const workDir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
		const runtimeDir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
		const logged: string[] = [];
		const dialled: string[] = [];
		const sandbox = new Sandbox({
			workDir,
			runtimeDir,
			bwrap: '/usr/bin/bwrap',
			system: {
				etc: decodeURIComponent(new URL('../../packages/sandbox/cage/etc', import.meta.url).pathname),
				proc: await probeProcPaths('/usr/bin/bwrap'),
			},
			filter: userNamespaceFilter(Deno.build.arch),
		}, {
			log: (_level, event, fields) => logged.push(JSON.stringify({ event, ...fields })),
			proxy: {
				// The remote's name resolves inward and outward; only the public literal is dialled, and it lands here.
				resolve: () => Promise.resolve(['10.0.0.9', GIT_PUBLIC]),
				connect: (address) => {
					dialled.push(address);
					return Deno.connect({ hostname: '127.0.0.1', port: remote.port });
				},
				startTls: (conn, hostname) => Deno.startTls(conn as Deno.TcpConn, { hostname, caCerts: [remote.pki.caCert] }),
				log: (event, fields) => logged.push(JSON.stringify({ event, ...fields })),
			},
			freeBytes: () => Promise.resolve(100 * GiB),
		});
		const { remotes } = parseGitRemotes(JSON.stringify([
			{ id: 'fixture', url: `https://${GIT_HOST}/acme/app.git`, token: GIT_TOKEN },
			{ id: 'missing', url: `https://${GIT_HOST}/acme/missing.git`, token: GIT_TOKEN },
			{ id: 'moved', url: `https://${GIT_HOST}/acme/moved.git`, token: GIT_TOKEN },
		]));
		const service = new WorkspaceService(workDir, sandbox, { hosts: new Set(), remotes });
		await service.initialize();
		const basic = `Basic ${btoa(`x-access-token:${GIT_TOKEN}`)}`;
		try {
			const cloned = await service.call('alice', 'clone', { remote: 'fixture', name: 'fixture' });
			const id = cloned.workspace_id as string;
			assert.deepEqual([cloned.commit, cloned.ref, cloned.name], [FIXTURE_COMMIT, 'main', 'fixture']);
			assert.equal(await Deno.readTextFile(`${workDir}/${id}/README.md`), FIXTURE_README);
			assert.equal(await Deno.readTextFile(`${workDir}/${id}/src/main.py`), 'print(42)\n');
			// The remote was asked for upload-pack only, every time with the credential the forwarder added.
			assert.ok(remote.seen.length >= 2, JSON.stringify(remote.seen));
			for (const request of remote.seen) {
				assert.ok(request.target.startsWith('/acme/app.git/'), request.target);
				assert.equal(request.authorization, basic);
			}
			assert.ok(dialled.length > 0 && dialled.every((address) => address === GIT_PUBLIC), dialled.join());
			// The workspace's origin is the public URL; nothing of the credential is anywhere in the checkout.
			assert.match(
				await Deno.readTextFile(`${workDir}/${id}/.git/config`),
				/url = https:\/\/git\.example\.test\/acme\/app\.git/,
			);
			const secrets = [GIT_TOKEN, btoa(`x-access-token:${GIT_TOKEN}`)].map((value) => new TextEncoder().encode(value));
			const contains = (bytes: Uint8Array, needle: Uint8Array) =>
				bytes.some((_, at) => needle.every((byte, i) => bytes[at + i] === byte));
			for (const file of await filesUnder(`${workDir}/${id}`)) {
				for (const secret of secrets) assert.ok(!contains(file.bytes, secret), `${file.path} holds the credential`);
			}
			// A later cage: .git read-only, no hook, no credential in its environment or /proc, the commit there.
			const later = await service.call('alice', 'exec', {
				workspace_id: id,
				command: 'touch .git/x 2>/dev/null || echo git-read-only; ls .git/hooks >/dev/null 2>&1 || echo no-hooks; ' +
					'env; for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do tr "\\0" "\\n" < "$f"; done 2>/dev/null; ' +
					'git -c safe.directory="*" rev-parse HEAD; cat .git/shallow',
			});
			const said = String(later.output);
			assert.match(said, /git-read-only/);
			assert.match(said, /no-hooks/);
			assert.ok(said.includes(FIXTURE_COMMIT), said);
			assert.ok(!said.includes(GIT_TOKEN) && !said.includes(btoa(`x-access-token:${GIT_TOKEN}`)), said);
			// R3-1: a live session opened after the clone mounts `.git` read-only as well (the race let one open before
			// `.git` existed, and keep it writable for its lifetime).
			const opened = await service.call('alice', 'session_open', { workspace_id: id });
			const session_id = opened.session_id as string;
			await service.call('alice', 'session_input', {
				session_id,
				data: 'touch .git/x 2>/dev/null || echo git-read-only; echo probe-done\n',
			});
			let shell = '';
			let after = 0;
			for (let i = 0; i < 40 && !shell.includes('probe-done'); i += 1) {
				const read = await service.call('alice', 'session_read', { session_id, after, wait_ms: 1_000 });
				shell += String(read.output);
				after = read.seq as number;
			}
			assert.match(shell, /git-read-only/);
			await service.call('alice', 'session_close', { session_id });
			for (let i = 0; i < 40; i += 1) {
				const read = await service.call('alice', 'session_read', { session_id, after, wait_ms: 250 })
					.catch(() => ({ ended: true, seq: after }));
				if (read.ended === true) break;
				after = read.seq as number;
			}
			// The diff of a shallow clone is against the cloned commit.
			await service.call('alice', 'write', { workspace_id: id, path: 'src/new.py', content: 'print(1)\n' });
			const diff = await service.call('alice', 'diff', { workspace_id: id });
			assert.deepEqual(diff.files, [{ path: 'src/new.py', change: 'added' }]);
			// A remote that is not there, and one that redirects, leave nothing behind.
			for (const name of ['missing', 'moved']) {
				const error = await service.call('alice', 'clone', { remote: name }).then(() => null, (e) => e);
				assert.ok(error instanceof ApiError && error.code === 'clone_failed', String(error));
			}
			assert.ok(remote.seen.some((request) => request.target.startsWith('/acme/moved.git/')));
			assert.deepEqual((await service.call('alice', 'list', {})).workspaces, [
				{ workspace_id: id, created_at: cloned.created_at, name: 'fixture' },
			]);
			// No log line carries the credential, in any of its forms.
			assert.ok(logged.some((line) => line.includes('forwarder.redirect_refused')), logged.join('\n'));
			for (const secret of [GIT_TOKEN, btoa(`x-access-token:${GIT_TOKEN}`)]) {
				assert.ok(!logged.join('\n').includes(secret), 'a log line holds the credential');
			}
			await service.call('alice', 'remove', { workspace_id: id });
		} finally {
			await remote.close();
			await Deno.remove(workDir, { recursive: true }).catch(() => {});
			await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
		}
	},
);

cageTest(
	"R12: a public clone's step reaches the git hosts only, through the proxy; an unlisted host is refused",
	async () => {
		// The stand-in remote: the proxy's tunnel for GIT_HOST ends there. The cage does not trust its throwaway CA, so a
		// clone through the tunnel fails at TLS, which is the point: TLS runs end to end from the cage, never at the proxy.
		const remote = await gitRemote();
		const { sandbox, workDir, cleanup } = await setup({
			proxy: {
				resolve: () => Promise.resolve([GIT_PUBLIC]),
				connect: () => Deno.connect({ hostname: '127.0.0.1', port: remote.port }),
				log: () => {},
			},
		});
		const gitHosts: OpenEgress = (path, deps, runId) => RegistryProxy.open(path, deps, runId, new Set([GIT_HOST]));
		const step = async (url: string, command = cloneScript('public')) => {
			const runId = crypto.randomUUID();
			await Deno.mkdir(`${workDir}/${runId}`);
			return await sandbox.exec({
				runId,
				command,
				cwd: '',
				timeoutMs: 60_000,
				network: 'git',
				env: cloneEnv({ url, ref: null, depth: 1 }),
				stdin: null,
				egress: gitHosts,
			});
		};
		try {
			const unlisted = await step('https://other.example.test/acme/app.git');
			assert.notEqual(unlisted.exitCode, 0, unlisted.output);
			assert.deepEqual(unlisted.refusedHosts, ['other.example.test:443']);
			assert.deepEqual(unlisted.reachedHosts, []);
			const listed = await step(`https://${GIT_HOST}/acme/app.git`);
			assert.notEqual(listed.exitCode, 0, listed.output);
			assert.deepEqual(listed.reachedHosts, [GIT_HOST]);
			assert.match(listed.output, /certificate|SSL|TLS/i);
			assert.equal(remote.seen.length, 0, 'TLS ended in the cage: the stand-in never saw a request');
			// The clone step's proxy admits no registry; a registries-mode command reaches no git host.
			const probe =
				'curl -sS -o /dev/null -w "connect=%{http_connect}\\n" https://registry.npmjs.org/ 2>/dev/null; true';
			const registry = await step(`https://${GIT_HOST}/acme/app.git`, probe);
			assert.match(registry.output, /connect=403/);
			assert.deepEqual(registry.refusedHosts, ['registry.npmjs.org:443']);
			const fromCommand = await sandbox.exec(exec({
				network: 'registries',
				command: `curl -sS -o /dev/null -w "connect=%{http_connect}\\n" https://${GIT_HOST}/ 2>/dev/null; true`,
			}));
			assert.match(fromCommand.output, /connect=403/);
			assert.deepEqual(fromCommand.refusedHosts, [`${GIT_HOST}:443`]);
		} finally {
			await remote.close();
			await cleanup();
		}
	},
);
