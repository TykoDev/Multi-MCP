/**
 * D-108: the Docker workspace backend end to end, on a real Docker Engine, with throwaway names only.
 *
 * It builds the sandbox and workspace images under `--tag` (default `verify`), creates two volumes of its own, runs
 * the sandbox service with the opt-in overlay's exact command (read from docker-compose.sandbox-docker.yml) and the
 * Docker socket, and drives it through SandboxClient on a random loopback port: create, file operations, commands
 * (identity, capabilities, network, read-only .git and socket folder), N3's cleanup of what a command leaves running,
 * a time limit, the diff, a live session beside a command, disk use measured with the container paused even while the
 * session races to hide it (review R2-2), registries mode through the read-only socket mount (R2-1), removal, and
 * reconciliation across a restart. The start-up volume check leaves no container behind (R2-3); containers carry
 * the deployment and body-hash labels (R2-5, R2-6). R12 (D-131): the overlay's command grants the two git names and the
 * remotes secret — the service reads the file once, says `clone: true`, never logs the credential, and refuses a URL
 * off its host list before any network (a clone itself needs a remote, which this verifier never contacts).
 * Everything it made — the service, every workspace container on its volume, the volumes — is removed at the end,
 * whatever happened. No default volume, project or port is touched.
 *
 *   deno run --deny-ffi --allow-run=<docker> --allow-read=. --allow-write=tests/.scratch \
 *     --allow-net=127.0.0.1 --allow-env=PATH tests/sandbox/verify_docker_backend.ts --tag verify-w5 [--no-build]
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { DELIMITER, join, resolve } from '@std/path';
import { SandboxClient } from '@tykotech/sandbox';

let docker: string | undefined;
for (const path of (Deno.env.get('PATH') ?? '').split(DELIMITER)) {
	const candidate = resolve(join(path.replace(/^"|"$/g, ''), Deno.build.os === 'windows' ? 'docker.exe' : 'docker'));
	try {
		if ((await Deno.permissions.query({ name: 'run', command: candidate })).state === 'granted') {
			docker = candidate;
			break;
		}
	} catch { /* absent PATH entry */ }
}
if (!docker) throw new Error('Docker CLI not found.');

async function command(args: string[], allowFailure = false): Promise<string> {
	const output = await new Deno.Command(docker!, { args, stdout: 'piped', stderr: 'piped' }).output();
	const stdout = new TextDecoder().decode(output.stdout);
	if (!output.success && !allowFailure) {
		throw new Error(`Docker ${args[0]} failed (${output.code}): ${stdout}\n${new TextDecoder().decode(output.stderr)}`);
	}
	return stdout;
}

const tagAt = Deno.args.indexOf('--tag');
const tag = tagAt >= 0 ? Deno.args[tagAt + 1] ?? '' : 'verify';
if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('--tag must be an image tag');
const serviceImage = `tykotech-sandbox:${tag}`;
const workspaceImage = `tykotech-sandbox-workspace:${tag}`;
const suffix = crypto.randomUUID().slice(0, 8);
const name = `ttk-docker-test-${suffix}`;
const codeVolume = `${name}-code`;
const sockVolume = `${name}-sock`;

/** The overlay's sandbox `command:`, as written, so this run proves the grants that ship. */
async function overlayCommand(): Promise<string[]> {
	const text = await Deno.readTextFile('docker-compose.sandbox-docker.yml');
	const block = /\n {4}command: \[\n([\s\S]*?)\n {4}\]/.exec(text);
	if (!block) throw new Error('docker-compose.sandbox-docker.yml has no sandbox command list');
	return block[1]!.split('\n').map((line) => line.trim().replace(/,$/, '').replace(/^'(.*)'$/, '$1')).filter(Boolean);
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await probe().catch(() => undefined);
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

await Deno.mkdir('tests/.scratch', { recursive: true });
const scratch = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'sandbox-docker-' });
const secretPath = resolve(`${scratch}/token`);
const token = crypto.randomUUID() + crypto.randomUUID();
await Deno.writeTextFile(secretPath, token);
const gitToken = `ghp_${crypto.randomUUID().replaceAll('-', '')}`;
const remotesPath = resolve(`${scratch}/ttk_git_remotes`);
await Deno.writeTextFile(
	remotesPath,
	JSON.stringify([{ id: 'fixture', url: 'https://git.example.test/acme/app.git', token: gitToken }]),
);
const ran: string[] = [];

async function connect(): Promise<SandboxClient> {
	const published = (await command(['port', name, '8080/tcp'])).trim().split('\n')[0]!;
	const client = new SandboxClient({ url: `http://${published}`, token });
	await until('the sandbox to be ready', async () => (await client.ready()) ? true : undefined, 60_000);
	return client;
}

const workspaceContainers = async (): Promise<string[]> =>
	(await command([
		'ps',
		'-aq',
		'--filter',
		'label=eu.tykotech.sandbox=1',
		'--filter',
		`volume=${codeVolume}`,
	])).split('\n').filter(Boolean);

try {
	if (!Deno.args.includes('--no-build')) {
		console.log(await command(['build', '-f', 'docker/Dockerfile.sandbox', '-t', serviceImage, '.']));
		console.log(await command(['build', '-f', 'docker/Dockerfile.sandbox-workspace', '-t', workspaceImage, '.']));
	}
	await command(['volume', 'create', codeVolume]);
	await command(['volume', 'create', sockVolume]);
	const overlay = await overlayCommand();
	assertEquals(overlay.slice(0, 3), ['deno', 'run', '--deny-ffi']);
	assert(!overlay.some((arg) => arg.startsWith('--allow-run')), 'the Docker backend needs no run grant');
	await command([
		'run',
		'-d',
		'--name',
		name,
		'--read-only',
		'--cap-drop=ALL',
		'--security-opt=no-new-privileges:true',
		'--memory=1g',
		'--cpus=2',
		'--pids-limit=512',
		'--group-add',
		'0',
		'-v',
		'/var/run/docker.sock:/var/run/docker.sock',
		'--mount',
		`type=volume,source=${codeVolume},target=/work`,
		'--mount',
		`type=volume,source=${sockVolume},target=/run/ttk-sandbox-sock`,
		'--tmpfs',
		'/tmp/ttk-sandbox:uid=1993,gid=1993,mode=0700,size=64m',
		'--mount',
		`type=bind,source=${secretPath},target=/run/secrets/ttk_sandbox_token,readonly`,
		'--mount',
		`type=bind,source=${remotesPath},target=/run/secrets/ttk_git_remotes,readonly`,
		'-e',
		'TTK_SANDBOX_GIT_HOSTS=git.example.test',
		'-e',
		'TTK_SANDBOX_GIT_REMOTES_FILE=/run/secrets/ttk_git_remotes',
		'-e',
		'TTK_SANDBOX_BACKEND=docker',
		'-e',
		'TTK_SANDBOX_DOCKER_SOCKET=/var/run/docker.sock',
		'-e',
		`TTK_SANDBOX_WORKSPACE_IMAGE=${workspaceImage}`,
		'-e',
		`TTK_SANDBOX_DOCKER_VOLUME=${codeVolume}`,
		'-e',
		`TTK_SANDBOX_DOCKER_SOCK_VOLUME=${sockVolume}`,
		'-p',
		'127.0.0.1::8080',
		serviceImage,
		...overlay,
	]);
	let client = await connect();
	assertEquals(client.backend, 'docker');
	const logs = await command(['logs', name]);
	assertStringIncludes(logs, 'sandbox.docker_backend');
	// R2-3 / R2-5: the volume was proven at start-up by a container of its own, which is gone again.
	assertEquals(await workspaceContainers(), []);
	ran.push(
		'service up with the overlay grants; /healthz says docker; startup warning logged; volume check left nothing',
	);

	assertEquals(client.clone, true);
	assertEquals((await client.call('alice', 'list', {})).clone, { hosts: ['git.example.test'], remotes: ['fixture'] });
	let offList = 0;
	try {
		await client.call('alice', 'clone', { url: 'https://github.com/acme/app.git' });
	} catch (error) {
		offList = error instanceof Error && 'status' in error ? Number(error.status) : 0;
	}
	assertEquals(offList, 400);
	assertEquals(await workspaceContainers(), [], 'a refused clone created no container');
	assert(!(await command(['logs', name])).includes(gitToken), 'the credential stays out of the log');
	ran.push('R12: the overlay grants the git names and the remotes secret; clone offered; off-list URL refused');

	const { workspace_id } = await client.call('alice', 'create', {
		name: 'docker e2e',
		files: { 'seed.txt': 'initial\n' },
	});
	const id = String(workspace_id);
	const [container] = await workspaceContainers();
	assert(container, 'a workspace container exists after create');
	const inspect = JSON.parse(await command(['inspect', container]))[0];
	assertEquals(inspect.Config.User, '1993:1993');
	assertEquals(inspect.Config.Labels['eu.tykotech.workspace'], id);
	assertEquals(inspect.HostConfig.NetworkMode, 'none');
	assertEquals(inspect.HostConfig.ReadonlyRootfs, true);
	assertEquals(inspect.HostConfig.Privileged, false);
	assertEquals(inspect.HostConfig.CapDrop, ['ALL']);
	assertEquals(inspect.HostConfig.Binds ?? null, null);
	assertEquals(
		inspect.HostConfig.Mounts.map((m: { Target: string; ReadOnly?: boolean; VolumeOptions?: { Subpath?: string } }) =>
			`${m.Target}=${m.VolumeOptions?.Subpath}${m.ReadOnly ? ':ro' : ''}`
		),
		[
			`/workspace=${id}`,
			`/workspace/.git=${id}/.git:ro`,
			`/home/sandbox=.sandbox/${id}/home`,
			`/run/harbour=${id}:ro`,
		],
	);
	const deployment = inspect.Config.Labels['eu.tykotech.deployment'];
	assert(/^[0-9a-f]{16}$/.test(deployment), deployment);
	assertEquals(inspect.Name, `/ttk-sandbox-${deployment}-${id}`);
	assert(/^[0-9a-f]{64}$/.test(inspect.Config.Labels['eu.tykotech.body']));
	ran.push('create: one container per workspace, hardened body as created by the daemon, .git and socket folder ro');

	assertEquals((await client.call('alice', 'read', { workspace_id, path: 'seed.txt' })).content, 'initial\n');
	await client.call('alice', 'write', { workspace_id, path: 'src/main.py', content: 'print(42)\n' });
	assertEquals((await client.call('alice', 'exec', { workspace_id, command: 'python3 src/main.py' })).output, '42\n');
	const posture = await client.call('alice', 'exec', {
		workspace_id,
		command:
			'id -u; grep CapEff /proc/self/status; ls -A /run/harbour; cat /proc/net/dev | tail -n +3 | cut -d: -f1; ' +
			'touch .git/x 2>&1 || echo git-read-only; touch /etc/x 2>&1 || echo root-read-only; ' +
			'touch /run/harbour/x 2>&1 || echo harbour-read-only; echo "HOME=$HOME DENO_DIR=${DENO_DIR:-unset}"',
	});
	const said = String(posture.output);
	assertStringIncludes(said, '1993\n');
	assertStringIncludes(said, 'CapEff:\t0000000000000000');
	assertStringIncludes(said, 'git-read-only');
	assertStringIncludes(said, 'root-read-only');
	assertStringIncludes(said, 'harbour-read-only');
	assertStringIncludes(said, 'HOME=/home/sandbox DENO_DIR=unset');
	assert(!said.includes('eth0') && !said.includes('proxy.sock'), said);
	ran.push('exec: uid 1993, no capabilities, only loopback, read-only .git and root, cage environment');

	// N3: a background process, and one that made a session of its own, are gone once their command returns.
	await client.call('alice', 'exec', {
		workspace_id,
		command: 'sleep 301 >/dev/null 2>&1 & setsid sleep 302 >/dev/null 2>&1 & echo started',
	});
	const left = await client.call('alice', 'exec', {
		workspace_id,
		command: 'for p in /proc/[0-9]*; do tr "\\0" " " <$p/cmdline 2>/dev/null; echo; done',
	});
	assert(!String(left.output).includes('sleep 30'), String(left.output));
	ran.push('N3: background and setsid processes are killed after their command');

	const started = performance.now();
	const timed = await client.call('alice', 'exec', { workspace_id, command: 'sleep 60', timeout_ms: 2_000 });
	assertEquals([timed.timedOut, timed.killed, timed.exitCode], [true, 'timeout', null]);
	assert(performance.now() - started < 20_000);
	assertEquals((await client.call('alice', 'exec', { workspace_id, command: 'echo after' })).output, 'after\n');
	ran.push('a time limit kills the process group; the workspace runs again');

	const diff = await client.call('alice', 'diff', { workspace_id });
	assertStringIncludes(String(diff.patch), 'print(42)');
	assert((diff.files as Array<{ path: string }>).some((f) => f.path === 'seed.txt'));
	ran.push('diff');

	const { session_id } = await client.call('alice', 'session_open', { workspace_id });
	const readUntil = async (text: string, after: number) =>
		await until(`session output ${text}`, async () => {
			let seen = '';
			let seq = after;
			for (let i = 0; i < 20; i++) {
				const read = await client.call('alice', 'session_read', { session_id, after: seq, wait_ms: 1_000 });
				seen += String(read.output);
				seq = Number(read.seq);
				if (seen.includes(text)) return seq;
			}
			return undefined;
		});
	await client.call('alice', 'session_input', { session_id, data: 'echo hi from the shell\n' });
	let seq = await readUntil('hi from the shell', 0);
	// A command beside the open shell: its cleanup spares the shell.
	assertEquals((await client.call('alice', 'exec', { workspace_id, command: 'echo beside' })).output, 'beside\n');
	await client.call('alice', 'session_input', { session_id, data: 'echo still here\n' });
	seq = await readUntil('still here', seq);
	// R2-2: 3 MiB in a folder the session keeps locking and unlocking, as fast as it can, while a command beside it
	// is measured. Measured in the container, the lock could hide the folder from du; the service measures its own
	// view with the container paused, so the folder is counted every time, and the session runs on afterwards.
	await client.call('alice', 'exec', {
		workspace_id,
		command: 'mkdir -p hidden && head -c 3145728 /dev/urandom > hidden/blob && chmod 000 hidden',
	});
	await client.call('alice', 'session_input', {
		session_id,
		data: '(while :; do chmod 000 hidden; chmod 700 hidden; done) >/dev/null 2>&1 &\necho racing\n',
	});
	seq = await readUntil('racing', seq);
	for (let i = 0; i < 5; i++) {
		const measured = await client.call('alice', 'exec', { workspace_id, command: 'true' });
		assert(Number(measured.diskBytes) >= 3 * 1024 * 1024, `measured ${measured.diskBytes} with the folder hidden`);
	}
	assertEquals(JSON.parse(await command(['inspect', container]))[0].State.Paused, false);
	await client.call('alice', 'session_input', { session_id, data: 'kill $!; echo stopped racing\n' });
	seq = await readUntil('stopped racing', seq);
	await client.call('alice', 'session_close', { session_id });
	await until('the session to end', async () => {
		const read = await client.call('alice', 'session_read', { session_id, after: seq, wait_ms: 1_000 });
		return read.ended ? true : undefined;
	});
	ran.push(
		'live session: input, output, survives a command beside it, closes; disk use counted with the container paused ' +
			'while the session raced to hide 3 MiB (R2-2)',
	);

	const registry = await client.call('alice', 'exec', {
		workspace_id,
		network: 'registries',
		timeout_ms: 60_000,
		command:
			'ls -A /run/harbour; curl -sS -o /dev/null -w "connect=%{http_connect} status=%{http_code}\\n" https://registry.npmjs.org/ || true',
	});
	assertStringIncludes(String(registry.output), 'proxy.sock');
	// R2-1: the proxy answered the CONNECT, so socat reached its socket through the read-only mount.
	const tunnel = /connect=(\d{3})/.exec(String(registry.output))?.[1];
	assert(tunnel !== undefined && tunnel !== '000', String(registry.output));
	const after = await client.call('alice', 'exec', { workspace_id, command: 'ls -A /run/harbour; echo end' });
	assertEquals(after.output, 'end\n');
	ran.push(
		`registries: the proxy socket only during the command, reached through the read-only mount (registry answered: ${
			String(registry.output).split('\n').filter(Boolean).at(-1)
		}, reached ${JSON.stringify(registry.reachedHosts)})`,
	);

	// Reconciliation: a restart stops a running workspace container and keeps the workspace.
	await command(['restart', name]);
	client = await connect();
	const state = JSON.parse(await command(['inspect', container]))[0].State;
	assertEquals(state.Running, false);
	assertEquals((await client.call('alice', 'read', { workspace_id, path: 'seed.txt' })).content, 'initial\n');
	assertEquals((await client.call('alice', 'exec', { workspace_id, command: 'echo again' })).output, 'again\n');
	ran.push('restart: reconciliation stops the container; the workspace runs again');

	await client.call('alice', 'remove', { workspace_id });
	assertEquals(await workspaceContainers(), []);
	assertEquals((await client.call('alice', 'list', {})).workspaces, []);
	ran.push('remove: the container is gone');
	console.log(`PASS Docker backend end to end (${tag}):\n- ${ran.join('\n- ')}`);
} catch (error) {
	console.error(await command(['logs', '--tail', '60', name], true).catch(() => 'service logs unavailable'));
	console.error(`passed before the failure:\n- ${ran.join('\n- ')}`);
	throw error;
} finally {
	await command(['rm', '-f', name], true).catch(() => {});
	for (const id of await workspaceContainers().catch(() => [])) await command(['rm', '-f', id], true).catch(() => {});
	await command(['volume', 'rm', codeVolume], true).catch(() => {});
	await command(['volume', 'rm', sockVolume], true).catch(() => {});
	await Deno.remove(scratch, { recursive: true });
}
