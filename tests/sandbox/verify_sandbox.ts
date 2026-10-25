/** Builds and probes disposable Linux sandbox containers under the production security posture. */
import { assert, assertEquals } from '@std/assert';
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

async function command(args: string[]): Promise<string> {
	const output = await new Deno.Command(docker!, { args, stdout: 'piped', stderr: 'piped' }).output();
	const stdout = new TextDecoder().decode(output.stdout);
	const stderr = new TextDecoder().decode(output.stderr);
	if (!output.success) throw new Error(`Docker ${args[0]} failed (${output.code}): ${stdout}\n${stderr}`);
	if (stderr) console.log(stderr);
	return stdout;
}

// `--image <tag>` builds and probes under another tag (a verify run must not retag the deployed image).
const imageAt = Deno.args.indexOf('--image');
const image = imageAt >= 0 ? Deno.args[imageAt + 1] ?? '' : 'tykotech-sandbox:0.2.0';
if (!/^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image)) {
	throw new Error('--image must name a tag, like tykotech-sandbox:verify');
}
const name = `ttk-sandbox-test-${crypto.randomUUID().slice(0, 8)}`;
const volume = `${name}-work`;
await Deno.mkdir('tests/.scratch', { recursive: true });
const scratch = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'sandbox-secrets-' });
const secretPath = resolve(`${scratch}/token`);
const token = crypto.randomUUID() + crypto.randomUUID();
await Deno.writeTextFile(secretPath, token);
// R12 (D-131): the image's CMD grants the git names and the remotes secret; the service reads the file once.
const gitToken = `ghp_${crypto.randomUUID().replaceAll('-', '')}`;
const remotesPath = resolve(`${scratch}/ttk_git_remotes`);
await Deno.writeTextFile(
	remotesPath,
	JSON.stringify([{ id: 'fixture', url: 'https://git.example.test/acme/app.git', token: gitToken }]),
);
const profile = resolve('docker/seccomp-sandbox.json');
const secure = [
	'--read-only',
	'--cap-drop=ALL',
	'--security-opt=no-new-privileges:true',
	`--security-opt=seccomp=${profile}`,
	'--security-opt=systempaths=unconfined',
	// docker/apparmor-sandbox, loaded on an AppArmor host; ignored without AppArmor.
	'--security-opt=apparmor=tykotech-sandbox',
	'--memory=1g',
	'--cpus=2',
	'--pids-limit=512',
];
try {
	console.log(await command(['build', '-f', 'docker/Dockerfile.sandbox', '-t', image, '.']));
	console.log(
		await command([
			'run',
			'--rm',
			...secure,
			'--network=none',
			'--tmpfs',
			'/work:uid=1993,gid=1993,mode=0700,size=512m',
			'--tmpfs',
			'/tmp/ttk-sandbox:uid=1993,gid=1993,mode=0700,size=64m',
			'-e',
			'TTK_SANDBOX_TEST_DIR=/work',
			'--entrypoint',
			'deno',
			image,
			'test',
			'--deny-ffi',
			'--allow-run=/usr/bin/bwrap,/usr/bin/deno',
			'--allow-read=/work,/tmp/ttk-sandbox',
			'--allow-write=/work,/tmp/ttk-sandbox',
			// D-066: dynamic Unix proxy sockets need net grants; Docker disables non-loopback connectivity.
			'--allow-net',
			'--allow-env=TTK_SANDBOX_TEST_DIR,SANDBOX_TOKEN',
			'--allow-sys=statfs',
			'tests/sandbox/cages_test.ts',
			'tests/sandbox/runner_test.ts',
		]),
	);
	await command(['volume', 'create', volume]);
	await command([
		'run',
		'-d',
		'--name',
		name,
		...secure,
		'--mount',
		`type=volume,source=${volume},target=/work`,
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
		'-p',
		'127.0.0.1::8080',
		image,
	]);
	const published = (await command(['port', name, '8080/tcp'])).trim();
	let client = new SandboxClient({ url: `http://${published}`, token });
	for (let attempt = 0; attempt < 40 && !(await client.ready()); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	assert(await client.ready(), 'Sandbox did not become ready');
	// R12: the image's own CMD lets the service read both git names and the remotes secret; /healthz says it clones,
	// the listing names the hosts and remote ids only, a URL off the list is refused before any network, and no log
	// line holds the remote's credential.
	assertEquals(client.clone, true);
	assertEquals((await client.call('alice', 'list', {})).clone, { hosts: ['git.example.test'], remotes: ['fixture'] });
	let offList = 0;
	try {
		await client.call('alice', 'clone', { url: 'https://github.com/acme/app.git' });
	} catch (error) {
		offList = error instanceof Error && 'status' in error ? Number(error.status) : 0;
	}
	assertEquals(offList, 400, 'a clone URL off TTK_SANDBOX_GIT_HOSTS is refused as an invalid request');
	assertEquals((await client.call('alice', 'list', {})).workspaces, []);
	const serviceLogs = await command(['logs', name]);
	assert(
		serviceLogs.includes('sandbox.clone') && !serviceLogs.includes(gitToken),
		'the credential stays out of the log',
	);
	const { workspace_id } = await client.call('alice', 'create', {
		name: 'Lifecycle test',
		files: { 'seed.txt': 'initial\n' },
	});
	assertEquals((await client.call('alice', 'read', { workspace_id, path: 'seed.txt' })).content, 'initial\n');
	await client.call('alice', 'write', { workspace_id, path: 'src/main.py', content: 'print(42)\n' });
	assertEquals((await client.call('alice', 'exec', { workspace_id, command: 'python3 src/main.py' })).output, '42\n');
	const diff = await client.call('alice', 'diff', { workspace_id });
	assert(typeof diff.patch === 'string' && diff.patch.includes('print(42)'));
	assertEquals((await client.call('bob', 'list', {})).workspaces, []);
	await command(['restart', name]);
	// Docker may reassign an ephemeral published port when the container restarts.
	client = new SandboxClient({ url: `http://${(await command(['port', name, '8080/tcp'])).trim()}`, token });
	for (let attempt = 0; attempt < 40 && !(await client.ready()); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	assert(await client.ready());
	assertEquals((await client.call('alice', 'read', { workspace_id, path: 'seed.txt' })).content, 'initial\n');
	for (const operation of ['read', 'write', 'exec', 'diff', 'remove', 'list'] as const) {
		let refused = false;
		try {
			await client.call('bob', operation, { workspace_id, path: 'seed.txt', content: '', command: 'true' });
		} catch (error) {
			refused = error instanceof Error && 'status' in error && error.status === 404;
		}
		assert(refused, `Wrong owner ${operation} must be refused after restart`);
	}
	const abort = new AbortController();
	const running = client.call('alice', 'exec', { workspace_id, command: 'sleep 60', timeout_ms: 60_000 }, abort.signal)
		.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 500));
	abort.abort();
	await running;
	await new Promise((resolve) => setTimeout(resolve, 500));
	assertEquals(
		(await client.call('alice', 'exec', { workspace_id, command: 'echo cancellation-released' })).output,
		'cancellation-released\n',
	);
	await client.call('alice', 'exec', {
		workspace_id,
		command: 'ln -s /run/secrets/ttk_sandbox_token leak; ln -s /work escape',
	});
	for (const path of ['leak', 'escape/file']) {
		let refused = false;
		try {
			await client.call('alice', 'read', { workspace_id, path });
		} catch {
			refused = true;
		}
		assert(refused, 'Symlink escape must be refused');
	}
	await client.call('alice', 'remove', { workspace_id });
	assertEquals((await client.call('alice', 'list', {})).workspaces, []);
	console.log(
		'PASS sandbox private HTTP, ownership across restart, wrong-owner denial, seeded files, exec, diff, HTTP cancellation, symlink refusal, removal; R12 clone grants (git names, remotes secret read once, no credential logged, off-list URL refused)',
	);
} catch (error) {
	console.error(await command(['logs', '--tail', '30', name]).catch(() => 'Test container logs unavailable'));
	throw error;
} finally {
	await command(['rm', '-f', name]).catch(() => {});
	await command(['volume', 'rm', volume]).catch(() => {});
	await Deno.remove(scratch, { recursive: true });
}
