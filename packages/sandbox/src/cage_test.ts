/**
 * The bubblewrap command line for each kind of cage, read as a list of options. The cages
 * themselves run in integration.test.ts, on Linux.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	BASE_ENV,
	CAGE_HOME,
	cageArgs,
	type CageSpec,
	prelude,
	presentProcPaths,
	PROC_HIDDEN,
	PROXY_SOCKET,
	proxyEnv,
	READY,
	WORKSPACE,
} from './cage.ts';

const SYSTEM = {
	etc: '/app/cage/etc',
	proc: { files: ['/proc/kcore', '/proc/keys'], dirs: ['/proc/acpi'], readOnly: ['/proc/sys'] },
};
const RUN = '/work/0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const STATE = '/work/.sandbox/0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';

const execSpec = (over: Partial<CageSpec> = {}): CageSpec => ({
	mounts: [
		{ source: `${STATE}/tmp`, target: '/tmp', writable: true },
		{ source: `${STATE}/home`, target: CAGE_HOME, writable: true },
		{ source: RUN, target: WORKSPACE, writable: true },
		{ source: `${RUN}/.git`, target: `${WORKSPACE}/.git`, writable: false },
	],
	chdir: `${WORKSPACE}/packages/web`,
	env: {},
	command: 'npm test -- --runInBand',
	proxy: false,
	stdin: false,
	filter: true,
	processes: 200,
	...over,
});

/** The options as [flag, ...values] groups, for reading one kind at a time. */
function options(args: string[]): string[][] {
	const arity: Record<string, number> = {
		'--unshare-all': 0,
		'--die-with-parent': 0,
		'--new-session': 0,
		'--clearenv': 0,
		'--cap-drop': 1,
		'--cap-add': 1,
		'--setenv': 2,
		'--ro-bind': 2,
		'--ro-bind-try': 2,
		'--bind': 2,
		'--symlink': 2,
		'--proc': 1,
		'--dev': 1,
		'--tmpfs': 1,
		'--size': 1,
		'--remount-ro': 1,
		'--chdir': 1,
		'--seccomp': 1,
	};
	const out: string[][] = [];
	let i = 0;
	while (i < args.length && args[i] !== '--') {
		const flag = args[i]!;
		const n = arity[flag];
		if (n === undefined) throw new Error(`unexpected option ${flag}`);
		out.push(args.slice(i, i + 1 + n));
		i += 1 + n;
	}
	out.push(args.slice(i));
	return out;
}

Deno.test('cage: every namespace is new, nothing is kept, and it dies with the service', () => {
	const args = cageArgs(execSpec(), SYSTEM);
	assertEquals(args.slice(0, 6), [
		'--unshare-all',
		'--die-with-parent',
		'--new-session',
		'--cap-drop',
		'ALL',
		'--clearenv',
	]);
	// Options that would share something with the container are never used.
	for (const flag of ['--share-net', '--dev-bind', '--as-pid-1', '--hostname', '--userns']) {
		assert(!args.includes(flag), flag);
	}
});

Deno.test('cage: the mounts of a command in a checkout, in order', () => {
	const groups = options(cageArgs(execSpec(), SYSTEM));
	const mounts = groups.filter((g) =>
		['--ro-bind', '--ro-bind-try', '--bind', '--symlink', '--proc', '--dev', '--tmpfs'].includes(
			g[0]!,
		) || g[0] === '--remount-ro'
	);
	assertEquals(mounts, [
		['--ro-bind', '/usr', '/usr'],
		['--symlink', 'usr/bin', '/bin'],
		['--symlink', 'usr/sbin', '/sbin'],
		['--symlink', 'usr/lib', '/lib'],
		['--symlink', 'usr/lib64', '/lib64'],
		['--ro-bind-try', '/etc/ssl', '/etc/ssl'],
		['--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates'],
		['--ro-bind-try', '/etc/alternatives', '/etc/alternatives'],
		['--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache'],
		['--ro-bind-try', '/etc/ld.so.conf', '/etc/ld.so.conf'],
		['--ro-bind-try', '/etc/ld.so.conf.d', '/etc/ld.so.conf.d'],
		['--ro-bind-try', '/etc/services', '/etc/services'],
		['--ro-bind-try', '/etc/protocols', '/etc/protocols'],
		['--ro-bind-try', '/etc/os-release', '/etc/os-release'],
		['--ro-bind', '/app/cage/etc/passwd', '/etc/passwd'],
		['--ro-bind', '/app/cage/etc/group', '/etc/group'],
		['--ro-bind', '/app/cage/etc/hosts', '/etc/hosts'],
		['--ro-bind', '/app/cage/etc/nsswitch.conf', '/etc/nsswitch.conf'],
		['--proc', '/proc'],
		// What Docker would hide in /proc, hidden again over the cage's own.
		['--ro-bind', '/dev/null', '/proc/kcore'],
		['--ro-bind', '/dev/null', '/proc/keys'],
		['--tmpfs', '/proc/acpi'],
		['--remount-ro', '/proc/acpi'],
		['--ro-bind', '/proc/sys', '/proc/sys'],
		['--dev', '/dev'],
		['--tmpfs', '/dev/shm'],
		['--remount-ro', '/dev'],
		['--bind', `${STATE}/tmp`, '/tmp'],
		['--bind', `${STATE}/home`, CAGE_HOME],
		['--bind', RUN, WORKSPACE],
		// After the workspace, so it lands on top of it: .git stays read-only.
		['--ro-bind', `${RUN}/.git`, `${WORKSPACE}/.git`],
		// Last: nothing else can be created at the root once this is done.
		['--remount-ro', '/'],
	]);
	const text = cageArgs(execSpec(), SYSTEM).join(' ');
	for (const hidden of ['/run/secrets', '/work ', '/app/', '/deno-dir', '/tmp/harbour-sandbox']) {
		assert(!text.replaceAll('/app/cage/etc/', '').includes(hidden), hidden);
	}
});

Deno.test('cage: every /proc path Docker hides is hidden again', () => {
	const all = { ...SYSTEM, proc: presentProcPaths(() => true) };
	const groups = options(cageArgs(execSpec(), all));
	const proc = groups.findIndex((g) => g[0] === '--proc');
	const dev = groups.findIndex((g) => g[0] === '--dev');
	const masks = groups.slice(proc + 1, dev);
	// moby's default masked and read-only paths under /proc: files under /dev/null, directories
	// under an empty read-only tmpfs, the kernel's tunables read-only.
	assertEquals(masks, [
		...PROC_HIDDEN.files.map((path) => ['--ro-bind', '/dev/null', path]),
		...PROC_HIDDEN.dirs.flatMap((path) => [['--tmpfs', path], ['--remount-ro', path]]),
		...PROC_HIDDEN.readOnly.map((path) => ['--ro-bind', path, path]),
	]);
	assertEquals(masks.length, 7 + 3 * 2 + 5);
	for (const path of ['/proc/kcore', '/proc/keys', '/proc/sysrq-trigger', '/proc/sys']) {
		assert(masks.some((g) => g.at(-1) === path), path);
	}
});

Deno.test('cage: only the /proc paths this kernel has are masked', () => {
	const here = new Set(['/proc/kcore', '/proc/acpi', '/proc/sys', '/proc/sysrq-trigger']);
	assertEquals(presentProcPaths((path) => here.has(path)), {
		files: ['/proc/kcore'],
		dirs: ['/proc/acpi'],
		readOnly: ['/proc/sys', '/proc/sysrq-trigger'],
	});
	const none = { ...SYSTEM, proc: presentProcPaths(() => false) };
	const groups = options(cageArgs(execSpec(), none));
	const proc = groups.findIndex((g) => g[0] === '--proc');
	assertEquals(groups[proc + 1], ['--dev', '/dev']);
});

Deno.test('cage: the working directory, the filter and the command come last', () => {
	const args = cageArgs(execSpec(), SYSTEM);
	const groups = options(args);
	assertEquals(groups.find((g) => g[0] === '--chdir'), ['--chdir', '/workspace/packages/web']);
	assertEquals(groups.find((g) => g[0] === '--seccomp'), ['--seccomp', '0']);
	const tail = groups.at(-1)!;
	assertEquals(tail.slice(0, 3), ['--', '/bin/sh', '-c']);
	// The command is an argument of its own, never spliced into the prelude's text.
	assertEquals(tail.slice(4), ['harbour-sandbox', 'npm test -- --runInBand']);
	assert(!tail[3]!.includes('npm test'));
	const noFilter = cageArgs(execSpec({ filter: false }), SYSTEM);
	assert(!noFilter.includes('--seccomp'));
});

Deno.test("cage: the environment is the fixed one, then the request's", () => {
	const env = (spec: CageSpec) =>
		Object.fromEntries(
			options(cageArgs(spec, SYSTEM)).filter((g) => g[0] === '--setenv').map((g) => [g[1], g[2]]),
		);
	assertEquals(env(execSpec()), BASE_ENV);
	const withOwn = env(execSpec({ env: { NODE_ENV: 'test', CI: '' } }));
	assertEquals(withOwn.NODE_ENV, 'test');
	assertEquals(withOwn.CI, '');
	assertEquals(withOwn.HOME, CAGE_HOME);
	assert(!('HTTPS_PROXY' in env(execSpec())));
	assertEquals(env(execSpec({ env: proxyEnv() })).https_proxy, 'http://127.0.0.1:3128');
	// No setting of the service's own reaches a cage.
	for (const name of Object.keys(env(execSpec()))) assert(!name.startsWith('SANDBOX_'), name);
});

Deno.test('cage: the prelude announces the cage, merges stderr, and limits processes', () => {
	const text = prelude({ proxy: false, stdin: false, processes: 200 });
	const lines = text.split('\n');
	assertEquals(lines[0], `echo ${READY} >&2`);
	assertEquals(lines[1], 'exec 2>&1 </dev/null');
	assertStringIncludes(text, 'echo 1000 >/proc/self/oom_score_adj');
	assertStringIncludes(text, 'ulimit -p 200');
	assertEquals(lines.at(-1), 'exec /bin/sh -c "$1"');
	assert(!text.includes('socat'));

	const piped = prelude({ proxy: false, stdin: true, processes: 200 });
	assertStringIncludes(piped, 'exec 2>&1 </tmp/.harbour-stdin');
	assertStringIncludes(piped, 'rm -f /tmp/.harbour-stdin');
});

Deno.test('SB-1 cage: only the measuring cage keeps a capability, added after every other is dropped', () => {
	assert(!cageArgs(execSpec(), SYSTEM).includes('--cap-add'));
	const args = cageArgs(execSpec({ caps: ['CAP_DAC_READ_SEARCH'] }), SYSTEM);
	assertEquals(args.slice(0, 8), [
		'--unshare-all',
		'--die-with-parent',
		'--new-session',
		'--cap-drop',
		'ALL',
		'--cap-add',
		'CAP_DAC_READ_SEARCH',
		'--clearenv',
	]);
	assertEquals(options(args).filter((g) => g[0] === '--cap-add'), [['--cap-add', 'CAP_DAC_READ_SEARCH']]);
});

Deno.test('SB-7 cage: a cleanup-only command can write no file data, and is told so rather than killed', () => {
	assert(!prelude({ proxy: false, stdin: false, processes: 200 }).includes('ulimit -f'));
	const text = prelude({ proxy: true, stdin: false, processes: 200, noGrowth: true });
	const lines = text.split('\n');
	// Last before the command, after the forwarder has started: nothing of the cage's own is limited.
	assertEquals(lines.slice(-4), [`trap '' XFSZ`, 'ulimit -c 0', 'ulimit -f 0', 'exec /bin/sh -c "$1"']);
	assert(text.indexOf('socat') < text.indexOf('ulimit -f 0'));
	assertStringIncludes(cageArgs(execSpec({ noGrowth: true }), SYSTEM).join(' '), 'ulimit -f 0');
});

Deno.test('cage: with the proxy, the forwarder starts before the command and is waited for', () => {
	const text = prelude({ proxy: true, stdin: false, processes: 200 });
	assertStringIncludes(
		text,
		`socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${PROXY_SOCKET}`,
	);
	// 3128 is 0C38 in the kernel's table of listening sockets.
	assertStringIncludes(text, '0100007F:0C38 00000000:0000 0A');
	assert(text.indexOf('socat') < text.indexOf('exec /bin/sh -c "$1"'));
	const args = cageArgs(
		execSpec({
			proxy: true,
			mounts: [
				...execSpec().mounts,
				{ source: '/tmp/harbour-sandbox/x.sock', target: PROXY_SOCKET, writable: false },
			],
		}),
		SYSTEM,
	);
	assertEquals(
		options(args).find((g) => g[2] === PROXY_SOCKET),
		['--ro-bind', '/tmp/harbour-sandbox/x.sock', PROXY_SOCKET],
	);
});

Deno.test('cage: a scratch command gets no .git and its own folder', () => {
	const scratch = `${STATE}/scratch`;
	const args = cageArgs(
		execSpec({
			mounts: [
				{ source: `${STATE}/tmp`, target: '/tmp', writable: true },
				{ source: `${STATE}/home`, target: CAGE_HOME, writable: true },
				{ source: scratch, target: WORKSPACE, writable: true },
			],
			chdir: WORKSPACE,
		}),
		SYSTEM,
	);
	assert(args.join(' ').includes(`--bind ${scratch} ${WORKSPACE}`));
	assert(!args.join(' ').includes('.git'));
});
