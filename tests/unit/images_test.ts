/**
 * What the image and compose definitions promise: digest-pinned bases, one Deno, the exact least-privilege matrices
 * (`--deny-ffi` first, no provider-key or `OTEL_*` name), and the hardened sandbox service. Dockerfiles and compose
 * files are found by listing, so a new one is held to the same rules.
 */
import { assert, assertEquals } from '@std/assert';
import { PROVIDER_KEY_VARIABLE } from '../../scripts/check_tasks.ts';
import { SECRET_TOKEN_FILE } from '../../packages/sandbox/src/token.ts';

const read = (path: string): Promise<string> => Deno.readTextFile(path);

async function dockerfiles(): Promise<string[]> {
	const found = ['Dockerfile'];
	for await (const entry of Deno.readDir('docker')) {
		if (entry.isFile && entry.name.startsWith('Dockerfile')) found.push(`docker/${entry.name}`);
	}
	return found;
}

/** Shipped compose files; `docker-compose.override.yml` is the operator's own by Compose convention. */
async function composeFiles(): Promise<string[]> {
	const found: string[] = [];
	for await (const entry of Deno.readDir('.')) {
		if (entry.isFile && /^docker-compose(\.[a-z-]+)?\.yml$/.test(entry.name) && !entry.name.includes('override')) {
			found.push(entry.name);
		}
	}
	return found;
}

/** The base references of `FROM` lines, `ARG` defaults substituted, stage aliases skipped. */
function baseImages(text: string): string[] {
	const args = new Map<string, string>();
	const stages = new Set<string>();
	const bases: string[] = [];
	for (const line of text.split('\n').map((raw) => raw.trim())) {
		const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/.exec(line);
		if (arg !== null) args.set(arg[1]!, arg[2]!);
		const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
		if (from === null) continue;
		const ref = from[1]!.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => args.get(name) ?? '');
		if (!stages.has(ref)) bases.push(ref);
		if (from[2] !== undefined) stages.add(from[2]);
	}
	return bases;
}

/** The argv of the exec-form `CMD [...]` at or after `from` (default: the last one). */
function cmdOf(text: string, from = text.lastIndexOf('CMD [')): string[] {
	const start = text.indexOf('CMD [', from);
	return JSON.parse(text.slice(start + 4, text.indexOf(']', start) + 1).replace(/\\\r?\n/g, ' ')) as string[];
}

const activeText = (text: string): string => text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
const runtimeStage = (text: string): string => text.slice(text.lastIndexOf('\nFROM '));

/** The active lines of one compose service (`  <name>:`), or `null` when the file does not define it. */
function serviceBlock(text: string, name: string): string | null {
	const lines = text.split('\n');
	const start = lines.indexOf(`  ${name}:`);
	if (start < 0) return null;
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === '' || line.trim().startsWith('#')) continue;
		if (!line.startsWith('    ')) break;
		body.push(line);
	}
	return body.join('\n');
}

const keyNames = (text: string): string[] =>
	[...text.matchAll(/\b[A-Z][A-Z0-9_]+\b/g)].map((match) => match[0]).filter((name) =>
		PROVIDER_KEY_VARIABLE.test(name)
	);

Deno.test('images: every base is pinned by digest beside its tag, and every image and CI run one Deno', async () => {
	const deno = new Set<string>();
	for (const path of await dockerfiles()) {
		const bases = baseImages(await read(path));
		assert(bases.length > 0, `${path} names a base image`);
		for (const ref of bases) {
			assert(/:[^@/]+@sha256:[0-9a-f]{64}$/.test(ref), `${path}: ${ref} is not pinned by digest beside a tag`);
			if (ref.startsWith('denoland/deno:')) deno.add(ref);
		}
	}
	assertEquals(deno.size, 1, `the Deno images disagree: ${[...deno].join(' | ')}`);
	const version = /^denoland\/deno:(?:debian-)?(\d+\.\d+\.\d+)@/.exec([...deno][0]!)?.[1];
	const pinned = [...(await read('.github/workflows/ci.yml')).matchAll(/deno-version:\s*'([^']+)'/g)].map((m) => m[1]);
	assert(version !== undefined && pinned.length > 0, 'both versions are readable');
	assertEquals([...new Set(pinned)], [version], 'CI tests on the Deno the images ship');
});

Deno.test('images: the gateway CMD and HEALTHCHECK, whole; no compose file restates or widens them', async () => {
	const dockerfile = await read('Dockerfile');
	const env = 'TTK_*,DENO_DIR,DENO_NO_PROMPT,HOME,TMPDIR,PATH';
	assertEquals(cmdOf(dockerfile), [
		'deno',
		'run',
		'--cached-only',
		'--deny-ffi',
		'--allow-net',
		'--allow-run=/usr/bin/chromium,/usr/bin/ffmpeg',
		'--allow-read=/app,/data,/tmp,/home/deno,/run/secrets',
		'--allow-write=/data,/tmp,/home/deno',
		`--allow-env=${env}`,
		'packages/cli/mod.ts',
		'serve',
	]);
	assertEquals(keyNames(env.replaceAll(',', ' ')), [], 'no provider-key variable');
	assert(!/OTEL/.test(env) && !/OTEL/.test(await read('docker/ttk')), 'no OTEL_* name: the server exports none');
	assertEquals(cmdOf(dockerfile, dockerfile.indexOf('\nHEALTHCHECK ')), [
		'deno',
		'run',
		'--cached-only',
		'--deny-ffi',
		'--allow-net=127.0.0.1',
		'--allow-env=TTK_PORT',
		'scripts/healthcheck.ts',
	]);
	// The MCP Registry label, in the runtime stage (a build-stage label never reaches the image).
	const { name } = JSON.parse(await read('server.json')) as { name: string };
	const labels = [
		...runtimeStage(dockerfile).matchAll(/^LABEL\s+io\.modelcontextprotocol\.server\.name="([^"]*)"\s*$/gm),
	];
	assertEquals(labels.map((label) => label[1]), [name]);
	for (const file of await composeFiles()) {
		const text = activeText(await read(file));
		const gateway = serviceBlock(await read(file), 'tykotech-mcp') ?? '';
		assert(!/^\s+(command|entrypoint):/m.test(gateway), `${file}: the gateway runs the image's CMD`);
		assert(!/TTK_MODEL_PROVIDERS|ttk_model_providers/.test(text), `${file}: no providers file is mounted`);
		assertEquals(keyNames(text), [], `${file}: no provider-key variable`);
	}
});

Deno.test('images: the gateway image keeps the Chromium sandbox helper as its only setuid file', async () => {
	const helper = '/usr/lib/chromium/chrome-sandbox';
	const strip = `RUN find / -xdev -type f -perm /6000 ! -path ${helper} -exec chmod a-s {} + \\\n` +
		`\t&& test -u ${helper} \\\n` +
		`\t&& test -z "$(find / -xdev -type f -perm /6000 ! -path ${helper} -print -quit)"\n`;
	const runtime = runtimeStage(await read('Dockerfile'));
	const at = runtime.indexOf(strip);
	assert(at > runtime.indexOf('chromium-sandbox \\'), 'stripped after the packages are installed');
	assertEquals(runtime.split('apt-get install').length, 2, 'and no package is installed after it');
	assert((serviceBlock(await read('docker-compose.yml'), 'tykotech-mcp') ?? '').includes('    pids_limit: 4096'));
});

Deno.test('images: the sandbox CMD and the Docker overlay command, whole, and the git remotes on the sandbox only', async () => {
	const remotes = '/run/secrets/ttk_git_remotes';
	const git = 'TTK_SANDBOX_GIT_HOSTS,TTK_SANDBOX_GIT_REMOTES_FILE';
	const docker =
		'TTK_SANDBOX_BACKEND,TTK_SANDBOX_DOCKER_SOCKET,TTK_SANDBOX_WORKSPACE_IMAGE,TTK_SANDBOX_DOCKER_VOLUME,' +
		'TTK_SANDBOX_DOCKER_SOCK_VOLUME';
	assertEquals(cmdOf(await read('docker/Dockerfile.sandbox')), [
		'deno',
		'run',
		'--deny-ffi',
		'--unstable-no-legacy-abort',
		'--allow-run=/usr/bin/bwrap',
		`--allow-read=/work,/tmp/ttk-sandbox,${SECRET_TOKEN_FILE},${remotes}`,
		'--allow-write=/work,/tmp/ttk-sandbox',
		'--allow-net',
		`--allow-env=TTK_SANDBOX_TOKEN_FILE,${git}`,
		'--allow-sys=statfs',
		'packages/sandbox/service.ts',
	]);
	const overlay = /\n {4}command: \[\n([\s\S]*?)\n {4}\]/.exec(await read('docker-compose.sandbox-docker.yml'))?.[1];
	assertEquals(
		overlay?.split('\n').map((line) => line.trim().replace(/,$/, '').replace(/^'(.*)'$/, '$1')).filter(Boolean),
		[
			'deno',
			'run',
			'--deny-ffi',
			'--unstable-no-legacy-abort',
			`--allow-read=/work,/tmp/ttk-sandbox,${SECRET_TOKEN_FILE},${remotes},/run/ttk-sandbox-sock,/var/run/docker.sock`,
			'--allow-write=/work,/tmp/ttk-sandbox,/run/ttk-sandbox-sock,/var/run/docker.sock',
			'--allow-net',
			`--allow-env=TTK_SANDBOX_TOKEN_FILE,${docker},${git}`,
			'--allow-sys=statfs',
			'packages/sandbox/service.ts',
		],
	);
	// Public clones from exactly the four public forges; credentialed remotes reach the sandbox service alone.
	const compose = await read('docker-compose.yml');
	const active = activeText(compose);
	const hosts = [...active.matchAll(/^\s+TTK_SANDBOX_GIT_HOSTS: (.*)$/gm)].map((match) => match[1]);
	assertEquals(hosts, ['github.com,gitlab.com,bitbucket.org,codeberg.org']);
	const sandbox = serviceBlock(compose, 'sandbox') ?? '';
	assert(sandbox.includes('TTK_SANDBOX_GIT_HOSTS:') && sandbox.includes(`TTK_SANDBOX_GIT_REMOTES_FILE: ${remotes}`));
	assert(sandbox.includes('    secrets:\n      - ttk_sandbox_token\n      - ttk_git_remotes\n'), 'as compose secrets');
	assert(active.includes('  ttk_git_remotes:\n    file: ./secrets/ttk_git_remotes\n'), 'from secrets/');
	assert(!/TTK_SANDBOX_GIT_REMOTES_FILE|ttk_git_remotes/.test(serviceBlock(compose, 'tykotech-mcp') ?? ''));
});

Deno.test('stack: the gateway and the hardened sandbox, the token mounted by exactly those two', async () => {
	const compose = await read('docker-compose.yml');
	const active = activeText(compose);
	const services = active.slice(active.indexOf('\nservices:\n'), active.indexOf('\nsecrets:\n'));
	assertEquals([...services.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((match) => match[1]), ['tykotech-mcp', 'sandbox']);
	assert(!/a2a-peer|agent-runner|ttk_peer|ttk_agent_peers|ttk-peer-data|TTK_AGENT_PEERS_FILE|TTK_PEER_/.test(active));
	const ports = [...active.matchAll(/^\s+ports:\n\s+- '([^']+)'$/gm)].map((match) => match[1]);
	assertEquals(ports, ['${TTK_BIND:-127.0.0.1}:8787:8787'], 'only the gateway publishes, on the bind .env names');
	const gateway = serviceBlock(compose, 'tykotech-mcp') ?? '';
	const sandbox = serviceBlock(compose, 'sandbox') ?? '';
	for (
		const line of [
			'      TTK_SANDBOX_URL: http://sandbox:8080',
			`      TTK_SANDBOX_TOKEN_FILE: ${SECRET_TOKEN_FILE}\n`,
			'      - ttk_sandbox_token\n',
			'    networks:\n      - default\n      - sandbox-private',
		]
	) {
		assert(gateway.includes(line), `the gateway service carries ${JSON.stringify(line)}`);
	}
	assert(!/^\s+depends_on:/m.test(gateway), 'the gateway starts without the sandbox');
	for (
		const line of [
			'    read_only: true',
			'    cap_drop:\n      - ALL',
			'      - no-new-privileges:true',
			'      - seccomp:./docker/seccomp-sandbox.json',
			'      - systempaths=unconfined',
			'      - apparmor=tykotech-sandbox',
			'    volumes:\n      - ttk-code:/work\n',
			'      - /tmp/ttk-sandbox:uid=1993,gid=1993,mode=0700,size=64m',
			`      TTK_SANDBOX_TOKEN_FILE: ${SECRET_TOKEN_FILE}\n`,
			'    networks:\n      - sandbox-private\n      - sandbox-egress',
			'    mem_limit: 1g',
			'    cpus: 2',
			'    pids_limit: 512',
		]
	) {
		assert(sandbox.includes(line), `the sandbox service carries ${JSON.stringify(line)}`);
	}
	assert(!/^\s+(ports|expose|command|privileged|cap_add|network_mode):/m.test(sandbox), 'nothing that widens it');
	assert(!sandbox.includes('/var/run/docker.sock'), 'the Engine socket stays in the Docker overlay');
	assert(active.includes('\n  sandbox-private:\n    internal: true\n'), 'the gateway-to-sandbox network is internal');
	assert(active.includes('\n  ttk_sandbox_token:\n    file: ./secrets/ttk_sandbox_token\n'), 'the secret, from setup');
	for (const file of await composeFiles()) {
		const takers = [...activeText(await read(file)).matchAll(/^\s+- ttk_sandbox_token$/gm)].length;
		assertEquals(takers, file === 'docker-compose.yml' ? 2 : 0, `${file}: services taking the token secret`);
	}
});

Deno.test('sandbox: the AppArmor profile is docker-default with the cage mounts allowed, used by the sandbox only', async () => {
	// bubblewrap cannot build a cage under `deny mount`; the 3.0 ABI pin lets an AppArmor 4 kernel give cages a userns.
	const profile = await read('docker/apparmor-sandbox');
	assert(profile.includes('\nprofile tykotech-sandbox flags=(attach_disconnected,mediate_deleted) {\n'));
	assert(/^abi <abi\/3\.0>,$/m.test(profile), 'the policy ABI is pinned to AppArmor 3.0');
	assert(/^ {2}mount,$/m.test(profile) && /^ {2}pivot_root,$/m.test(profile), 'bubblewrap may mount');
	assert(!/^\s*deny mount/m.test(profile), "docker-default's deny mount is lifted");
	for (
		const rule of [
			'deny @{PROC}/sysrq-trigger rwklx,',
			'deny @{PROC}/kcore rwklx,',
			'deny @{PROC}/sys/[^k]** w,',
			'deny /sys/firmware/** rwklx,',
			'deny /sys/kernel/security/** rwklx,',
			'signal (send,receive) peer=tykotech-sandbox,',
			'ptrace (trace,read,tracedby,readby) peer=tykotech-sandbox,',
		]
	) {
		assert(profile.includes(`  ${rule}`), `docker-default's ${rule} is kept`);
	}
	assert(!/unconfined\)|change_profile|^\s*userns/m.test(profile), 'and the profile stays confined');
	assert(!(serviceBlock(await read('docker-compose.yml'), 'tykotech-mcp') ?? '').includes('apparmor='));
	const overlay = serviceBlock(await read('docker-compose.sandbox-docker.yml'), 'sandbox') ?? '';
	assert(overlay.includes('    security_opt: !override\n') && !overlay.includes('apparmor='), 'the Docker backend');
});
