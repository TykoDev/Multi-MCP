/**
 * C10 / C13 (D-102, D-103): what the image definitions promise, held in the unit tier.
 *
 * - Every base image is pinned by digest. A tag can be re-pointed under a build; a digest cannot.
 * - Every image that runs Deno runs the same one, and CI tests on that version too — the agent runner had drifted to
 *   2.9.7 while everything else stayed on 2.9.5, which is how a "works in CI" binary differs from the shipped one.
 * - The bundled gateway `CMD` carries `--unstable-kv`, so `TTK_CLUSTER_KV` works in what ships, and keeps `--deny-ffi`
 *   ahead of every grant. Since D-151 no compose file restates that argv, so it is the one gateway matrix compose runs.
 *
 * The Dockerfiles are found by listing, so a new one (W5's workspace image, say) is held to the same rules unasked.
 */
import { assert, assertEquals } from '@std/assert';
import { PROVIDER_KEY_VARIABLE } from '../../scripts/check_tasks.ts';
import { permissions } from '../../scripts/compile.ts';
import { GENERATED_TOKEN_DIR, GENERATED_TOKEN_FILE, SECRET_TOKEN_FILE } from '../../packages/sandbox/src/token.ts';

const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Every Dockerfile that builds a shipped image: the two at the root and everything under `docker/`. */
async function dockerfiles(): Promise<string[]> {
	const found = ['Dockerfile', 'Dockerfile.slim'];
	for await (const entry of Deno.readDir('docker')) {
		if (entry.isFile && entry.name.startsWith('Dockerfile')) found.push(`docker/${entry.name}`);
	}
	return found.sort();
}

/** The base references of a Dockerfile's `FROM` lines, with `ARG` defaults substituted; stage aliases skipped. */
function baseImages(text: string): string[] {
	const args = new Map<string, string>();
	const stages = new Set<string>();
	const bases: string[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/.exec(line);
		if (arg !== null) {
			args.set(arg[1]!, arg[2]!);
			continue;
		}
		const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
		if (from === null) continue;
		const ref = from[1]!.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => args.get(name) ?? '');
		if (!stages.has(ref)) bases.push(ref);
		if (from[2] !== undefined) stages.add(from[2]);
	}
	return bases;
}

Deno.test('C13: every base image is pinned by digest, with its tag kept beside it', async () => {
	for (const path of await dockerfiles()) {
		const bases = baseImages(await Deno.readTextFile(path));
		assert(bases.length > 0, `${path} names a base image`);
		for (const ref of bases) {
			assert(DIGEST.test(ref), `${path}: ${ref} is not pinned by digest`);
			assert(/:[^@/]+@/.test(ref), `${path}: ${ref} lost its human-readable tag`);
		}
	}
});

Deno.test('C13: one Deno for every image and for CI', async () => {
	const deno = new Set<string>();
	for (const path of await dockerfiles()) {
		for (const ref of baseImages(await Deno.readTextFile(path))) if (ref.startsWith('denoland/deno:')) deno.add(ref);
	}
	assertEquals(deno.size, 1, `the Deno images disagree: ${[...deno].join(' | ')}`);
	const [ref] = [...deno];
	const version = /^denoland\/deno:(?:debian-)?(\d+\.\d+\.\d+)@/.exec(ref!)?.[1];
	assert(version !== undefined, `cannot read a version from ${ref}`);
	const ci = await Deno.readTextFile('.github/workflows/ci.yml');
	const pinned = [...ci.matchAll(/deno-version:\s*'([^']+)'/g)].map((match) => match[1]);
	assert(pinned.length > 0, 'CI pins a Deno version');
	assertEquals([...new Set(pinned)], [version], 'CI tests on the Deno the images ship');
});

/** The argv of the last exec-form `CMD [...]` in a Dockerfile, continuations joined. */
function cmdOf(text: string): string[] {
	const start = text.lastIndexOf('CMD [');
	const end = text.indexOf(']', start);
	return JSON.parse(text.slice(start + 4, end + 1).replace(/\\\r?\n/g, ' ')) as string[];
}

/**
 * Every compose file that ships: the base and each overlay beside it, found by listing. `docker-compose.override.yml`
 * is the operator's own by Compose convention (read automatically, never shipped), so a checkout that has one is not
 * judged by it.
 */
async function composeFiles(): Promise<string[]> {
	const found: string[] = [];
	for await (const entry of Deno.readDir('.')) {
		if (entry.name === 'docker-compose.override.yml') continue;
		if (entry.isFile && /^docker-compose(\.[a-z-]+)?\.yml$/.test(entry.name)) found.push(entry.name);
	}
	return found.sort();
}

/** A compose file with its comment lines removed: what Compose reads. */
function activeText(text: string): string {
	return text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
}

/**
 * The active lines of one service of a compose file (`  <name>:` under `services:`), up to the next line that is not
 * indented under it; `null` when the file does not define the service. Comment lines are skipped, not ends.
 */
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

/** `--deny-ffi` comes before every grant (a deny outranks any later allow), and the KV flag is present. */
function assertMatrix(where: string, argv: readonly string[]): void {
	assert(argv.includes('--unstable-kv'), `${where}: --unstable-kv is missing, so TTK_CLUSTER_KV cannot work`);
	const deny = argv.indexOf('--deny-ffi');
	assert(deny >= 0, `${where}: --deny-ffi is missing`);
	const firstAllow = argv.findIndex((arg) => arg.startsWith('--allow-'));
	assert(firstAllow > deny, `${where}: --deny-ffi must precede every --allow-*`);
	assert(!argv.includes('--allow-run'), `${where}: a bare --allow-run`);
}

Deno.test('AC17 (D-122): both gateway images carry the MCP Registry label naming server.json', async () => {
	const { name } = JSON.parse(await Deno.readTextFile('server.json')) as { name: string };
	for (const path of ['Dockerfile', 'Dockerfile.slim']) {
		const text = await Deno.readTextFile(path);
		// In the runtime stage: a label set in the build stage never reaches the shipped image.
		const runtime = text.slice(text.lastIndexOf('\nFROM '));
		const labels = [...runtime.matchAll(/^LABEL\s+io\.modelcontextprotocol\.server\.name="([^"]*)"\s*$/gm)];
		assertEquals(labels.map((label) => label[1]), [name], `${path}: one registry label, in the runtime stage`);
	}
});

/**
 * C10 / D-151: the bundled `CMD` carries `--unstable-kv` behind `--deny-ffi`, and no compose file restates the gateway's
 * argv. The overlays used to, only to add their private service's host to a scoped net grant; with the unscoped grant
 * of D-151 that copy could only drift from the image's (a missing OTEL name, a lost `--unstable-kv`), so every
 * combination of compose files now runs exactly the `CMD` pinned here.
 */
Deno.test('C10 / D-151: the bundled CMD carries --unstable-kv behind --deny-ffi; no compose file restates it', async () => {
	assertMatrix('Dockerfile CMD', cmdOf(await Deno.readTextFile('Dockerfile')));
	const files = await composeFiles();
	assertEquals(files, [
		'docker-compose.agents.yml',
		'docker-compose.providers.yml',
		'docker-compose.sandbox-docker.yml',
		'docker-compose.sandbox.yml',
		'docker-compose.yml',
	]);
	for (const file of files) {
		const gateway = serviceBlock(await Deno.readTextFile(file), 'tykotech-mcp');
		if (gateway === null) continue;
		assert(!/^\s+command:/m.test(gateway), `${file}: the gateway's command is the image's CMD, never restated`);
		assert(!/^\s+entrypoint:/m.test(gateway), `${file}: nor its entrypoint`);
	}
});

/** The sandbox service's `command:` in the Docker overlay: the block list, one argument per line, as written. */
function sandboxOverlayCommandOf(text: string): string[] {
	const block = /\n {4}command: \[\n([\s\S]*?)\n {4}\]/.exec(text);
	assert(block !== null, 'docker-compose.sandbox-docker.yml has no sandbox command list');
	return block[1]!.split('\n').map((line) => line.trim().replace(/,$/, '').replace(/^'(.*)'$/, '$1')).filter(Boolean);
}

/** The comma list one `--allow-<name>=…` flag grants, or null when the flag is absent; `[]` for the bare flag. */
function grant(argv: readonly string[], name: string): string[] | null {
	const flag = `--allow-${name}`;
	const found = argv.filter((arg) => arg === flag || arg.startsWith(`${flag}=`));
	if (found.length === 0) return null;
	assertEquals(found.length, 1, `${flag} appears once`);
	return found[0] === flag ? [] : found[0]!.slice(flag.length + 1).split(',');
}

/**
 * D-131 (R12, design §2.1, §3.1 W6, AC33): the sandbox service's two matrices — the image's bubblewrap `CMD` and the
 * Docker overlay's `command:` — pinned whole. The git names and the remotes secret are the D-131 additions over
 * D-066/D-109: `--allow-run` stays bubblewrap alone (git runs only inside cages) and absent from the Docker overlay,
 * the net grant stays the bare one (D-066), and the remotes file is granted on its own so its read grant can be
 * revoked after the one read without costing the service a folder. D-151 adds read and write on the generated token's
 * folder (the token is renamed into place, and Deno's rename reads the file it moves), both revoked after the read.
 */
Deno.test('D-131 / D-151: the sandbox CMD and the Docker overlay grant the git names, the secrets, the token folder', async () => {
	const remotes = '/run/secrets/ttk_git_remotes';
	assertEquals(SECRET_TOKEN_FILE, '/run/secrets/ttk_sandbox_token');
	const git = ['TTK_SANDBOX_GIT_HOSTS', 'TTK_SANDBOX_GIT_REMOTES_FILE'];
	const docker = [
		'TTK_SANDBOX_BACKEND',
		'TTK_SANDBOX_DOCKER_SOCKET',
		'TTK_SANDBOX_WORKSPACE_IMAGE',
		'TTK_SANDBOX_DOCKER_VOLUME',
		'TTK_SANDBOX_DOCKER_SOCK_VOLUME',
	];
	const image = cmdOf(await Deno.readTextFile('docker/Dockerfile.sandbox'));
	const overlay = sandboxOverlayCommandOf(await Deno.readTextFile('docker-compose.sandbox-docker.yml'));
	for (const [where, argv] of [['Dockerfile.sandbox CMD', image], ['Docker overlay command', overlay]] as const) {
		assertEquals(argv.slice(0, 3), ['deno', 'run', '--deny-ffi'], `${where}: --deny-ffi first`);
		assertEquals(argv.at(-1), 'packages/sandbox/service.ts', where);
		assertEquals(grant(argv, 'net'), [], `${where}: the bare net grant of D-066, nothing wider or narrower`);
		assertEquals(grant(argv, 'sys'), ['statfs'], where);
		assert(!argv.includes('--allow-all') && !argv.includes('-A'), where);
	}
	assertEquals(grant(image, 'run'), ['/usr/bin/bwrap'], 'the image runs bubblewrap and nothing else');
	assertEquals(grant(image, 'env'), ['TTK_SANDBOX_TOKEN_FILE', ...git]);
	assertEquals(grant(image, 'read'), ['/work', '/tmp/ttk-sandbox', SECRET_TOKEN_FILE, remotes, GENERATED_TOKEN_DIR]);
	assertEquals(grant(image, 'write'), ['/work', '/tmp/ttk-sandbox', GENERATED_TOKEN_DIR]);
	assertEquals(grant(overlay, 'run'), null, 'the Docker backend runs nothing');
	assertEquals(grant(overlay, 'env'), ['TTK_SANDBOX_TOKEN_FILE', ...docker, ...git]);
	assertEquals(grant(overlay, 'read'), [
		'/work',
		'/tmp/ttk-sandbox',
		SECRET_TOKEN_FILE,
		remotes,
		GENERATED_TOKEN_DIR,
		'/run/ttk-sandbox-sock',
		'/var/run/docker.sock',
	]);
	assertEquals(grant(overlay, 'write'), [
		'/work',
		'/tmp/ttk-sandbox',
		GENERATED_TOKEN_DIR,
		'/run/ttk-sandbox-sock',
		'/var/run/docker.sock',
	]);
	// R3-7: and the whole argv, in order. The grant checks above read named flags only, so an added `--allow-import`,
	// an unknown flag or an `--allow-ffi` behind the deny passed them; any change to either list now fails here.
	assertEquals(image, [
		'deno',
		'run',
		'--deny-ffi',
		'--unstable-no-legacy-abort',
		'--allow-run=/usr/bin/bwrap',
		`--allow-read=/work,/tmp/ttk-sandbox,/run/secrets/ttk_sandbox_token,${remotes},/run/ttk-sandbox-token`,
		'--allow-write=/work,/tmp/ttk-sandbox,/run/ttk-sandbox-token',
		'--allow-net',
		`--allow-env=TTK_SANDBOX_TOKEN_FILE,${git.join(',')}`,
		'--allow-sys=statfs',
		'packages/sandbox/service.ts',
	], 'Dockerfile.sandbox CMD, whole');
	assertEquals(overlay, [
		'deno',
		'run',
		'--deny-ffi',
		'--unstable-no-legacy-abort',
		`--allow-read=/work,/tmp/ttk-sandbox,/run/secrets/ttk_sandbox_token,${remotes},/run/ttk-sandbox-token,` +
		'/run/ttk-sandbox-sock,/var/run/docker.sock',
		'--allow-write=/work,/tmp/ttk-sandbox,/run/ttk-sandbox-token,/run/ttk-sandbox-sock,/var/run/docker.sock',
		'--allow-net',
		`--allow-env=TTK_SANDBOX_TOKEN_FILE,${docker.join(',')},${git.join(',')}`,
		'--allow-sys=statfs',
		'packages/sandbox/service.ts',
	], 'Docker overlay command, whole');
	// D-151: public clones are on in the default stack, from exactly the four public forges. Credentialed remotes are
	// mounted from the `[]` placeholder `deno task setup` writes (no remote until the operator fills it in), on the
	// sandbox service alone: the credentials never reach the gateway, the peer or a cage.
	const compose = await Deno.readTextFile('docker-compose.yml');
	const active = activeText(compose);
	const hosts = [...active.matchAll(/^\s+TTK_SANDBOX_GIT_HOSTS: (.*)$/gm)].map((match) => match[1]);
	assertEquals(hosts, ['github.com,gitlab.com,bitbucket.org,codeberg.org'], 'the public forges, exact names, once');
	const sandbox = serviceBlock(compose, 'sandbox') ?? '';
	assert(sandbox.includes('TTK_SANDBOX_GIT_HOSTS:'), 'set on the sandbox service only');
	assert(sandbox.includes(`      TTK_SANDBOX_GIT_REMOTES_FILE: ${remotes}`), 'the remotes file, at the granted path');
	assert(sandbox.includes('    secrets:\n      - ttk_git_remotes'), 'mounted as the compose secret');
	assert(active.includes('  ttk_git_remotes:\n    file: ./secrets/ttk_git_remotes\n'), 'from secrets/');
	for (const name of ['tykotech-mcp', 'a2a-peer']) {
		assert(!/TTK_SANDBOX_GIT_REMOTES_FILE|ttk_git_remotes/.test(serviceBlock(compose, name) ?? ''), name);
	}
});

/**
 * D-137 (design §2.3, AC6): the bundled `CMD` grants the six `OTEL_*` names the egress gate reads — exactly those six,
 * by name, never a wildcard over `OTEL_` and never a `*_HEADERS` name — and the bundled `HEALTHCHECK` starts
 * `/usr/bin/env -u OTEL_DENO`, so a container that exports never exports from its probe (F14). No compose file
 * restates the argv since D-151 (the C10 test above), so the `CMD` is every compose combination's matrix. The slim
 * image's matrix is baked by `scripts/compile.ts` and stays the bare `--allow-env` (D-053).
 */
Deno.test('D-137 (AC6): the bundled CMD grants exactly the six OTEL_* names', async () => {
	const { OTEL_GATE_ENV_NAMES } = await import('@tykotech/cli');
	const env = grant(cmdOf(await Deno.readTextFile('Dockerfile')), 'env');
	assert(env !== null && env.length > 0, 'a scoped --allow-env');
	const otel = env.filter((name) => /^O/i.test(name));
	assertEquals(otel, [...OTEL_GATE_ENV_NAMES], "the six names, in the gate's order, and no other O* entry");
	assert(!env.some((name) => /HEADERS/i.test(name)), 'never a headers name');
	assert(!env.some((name) => name.endsWith('*') && 'OTEL_'.startsWith(name.slice(0, -1))), 'no OTEL wildcard');
	assertEquals(env.slice(0, 6), ['TTK_*', 'DENO_DIR', 'DENO_NO_PROMPT', 'HOME', 'TMPDIR', 'PATH']);
});

/**
 * D-143 / D-145 / D-151: the bundled `CMD` pinned whole. D-151 (owner-approved) made its net grant unscoped, the slim
 * binary's grant: the server's outbound network is on by default in both shapes, a provider host needs no election in
 * the matrix, and the providers file is the only allowlist for model hosts. The rest of the argv is unchanged. No
 * `--allow-env` entry names a provider-key variable (the T6 spelling: `*_API_KEY`, `OPENAI*`, `ANTHROPIC*`): a key
 * lives in `TTK_MODEL_PROVIDERS_FILE`, which `TTK_*` already covers. The providers opt-in is its own overlay,
 * `docker-compose.providers.yml`, and nothing of it is active in the default file.
 */
Deno.test('D-143 / D-145 / D-151: the bundled CMD grants unscoped net and no provider-key name', async () => {
	const SIX = [
		'OTEL_DENO',
		'OTEL_DENO_VSOCK',
		'OTEL_EXPORTER_OTLP_ENDPOINT',
		'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
		'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
		'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
	];
	const ENV = `--allow-env=TTK_*,DENO_DIR,DENO_NO_PROMPT,HOME,TMPDIR,PATH,${SIX.join(',')}`;
	// The T6 spelling, so the images and the tasks are judged alike (`TTK_API_KEYS_FILE` is the gateway's own store).
	const KEY_VARIABLE = PROVIDER_KEY_VARIABLE;
	const image = cmdOf(await Deno.readTextFile('Dockerfile'));
	assertEquals(image, [
		'deno',
		'run',
		'--cached-only',
		'--deny-ffi',
		'--allow-net',
		'--allow-run=/usr/bin/chromium,/usr/bin/ffmpeg',
		'--allow-read=/app,/data,/tmp,/home/deno,/run/secrets',
		'--allow-write=/data,/tmp,/home/deno',
		ENV,
		'--unstable-kv',
		'packages/cli/mod.ts',
		'serve',
	], 'Dockerfile CMD, whole: unscoped net (D-151), no provider-key name, no new flag');
	assertEquals(grant(image, 'net'), [], "D-151: the unscoped net grant, the slim binary's");
	const env = grant(image, 'env') ?? [];
	assertEquals(env, ENV.slice('--allow-env='.length).split(','), 'the env list, exact');
	assertEquals(env.filter((name) => KEY_VARIABLE.test(name)), [], 'no provider-key variable granted');
	assertEquals(env.filter((name) => /^O/i.test(name)), SIX, 'still exactly the six O* names');
	// The compiled matrix is the same bare net grant, so the two shapes share one egress posture (D-053, D-151).
	assertEquals(permissions('/usr/bin/chromium')[1], '--allow-net', 'slim bakes a bare --allow-net (D-053, D-151)');
	assert(permissions('/usr/bin/chromium').includes('--allow-env'), 'slim bakes a bare --allow-env (D-053)');
	// The opt-in is its own overlay, which sets the variable and mounts the file and nothing else; nothing of it is
	// active in the default file (a providers file needs a real provider, so there is no placeholder to mount).
	const overlay = activeText(await Deno.readTextFile('docker-compose.providers.yml'));
	const gateway = serviceBlock(overlay, 'tykotech-mcp') ?? '';
	assert(gateway.includes('      TTK_MODEL_PROVIDERS_FILE: /run/secrets/ttk_model_providers'), 'the overlay sets it');
	assert(gateway.includes('    secrets:\n      - ttk_model_providers'), 'and mounts the file as a compose secret');
	assert(overlay.includes('  ttk_model_providers:\n    file: ./secrets/ttk_model_providers.json'), 'from secrets/');
	assert(!/command:|image:|build:|entrypoint:/.test(overlay), "and nothing else: the matrix stays the image's");
	assertEquals(
		[...overlay.matchAll(/\b[A-Z][A-Z0-9_]+\b/g)].map((match) => match[0]).filter((name) => KEY_VARIABLE.test(name)),
		[],
		'no provider-key variable in the overlay',
	);
	const compose = await Deno.readTextFile('docker-compose.yml');
	const active = compose.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
	assert(!/TTK_MODEL_PROVIDERS|ttk_model_providers/.test(active), 'nothing of D-143 is active in the default file');
	assert(!/command:/.test(active), 'the default compose file ships no command: override — the CMD above is the matrix');
	const activeNames = [...active.matchAll(/\b[A-Z][A-Z0-9_]+\b/g)].map((match) => match[0]);
	assertEquals(activeNames.filter((name) => KEY_VARIABLE.test(name)), [], 'no provider-key variable active in compose');
	assert(activeNames.includes('TTK_API_KEYS_FILE'), 'non-vacuity: the gateway’s own key store is named, and passes');
});

/**
 * D-151 (owner-approved): a plain `docker compose up` runs the coding sandbox, with every hardening the old overlay
 * carried, and needs no third secret file — the sandbox service generates its bearer into the `ttk-sandbox-token`
 * volume on its first start. What is held here: the gateway reaches the sandbox only over the internal network and
 * waits for it to be healthy; the volume is mounted by exactly those two services in every compose file, read-only in
 * the gateway and under `/run/secrets` (which its `--allow-read` already covers, so its matrix needs nothing new); the
 * paths are the ones `packages/sandbox/src/token.ts` creates and revokes; the image makes the folder 1993-owned 0700,
 * so a fresh volume takes that owner and mode; and `docker-compose.sandbox.yml` points both services at an
 * operator-made file instead.
 */
Deno.test('D-151: docker-compose.yml runs the hardened sandbox with a generated token only two services mount', async () => {
	const compose = await Deno.readTextFile('docker-compose.yml');
	const gateway = serviceBlock(compose, 'tykotech-mcp');
	const sandbox = serviceBlock(compose, 'sandbox');
	assert(gateway !== null && sandbox !== null, 'both services are in the base file');
	const gatewayTokenDir = '/run/secrets/ttk-sandbox-token';
	for (
		const line of [
			'      TTK_SANDBOX_URL: http://sandbox:8080',
			`      TTK_SANDBOX_TOKEN_FILE: ${gatewayTokenDir}/token`,
			`      - ttk-sandbox-token:${gatewayTokenDir}:ro`,
			'    networks:\n      - default\n      - sandbox-private',
			'    depends_on:\n      sandbox:\n        condition: service_healthy',
		]
	) {
		assert(gateway.includes(line), `the gateway service carries ${JSON.stringify(line)}`);
	}
	const image = cmdOf(await Deno.readTextFile('Dockerfile'));
	assert(grant(image, 'read')!.includes('/run/secrets'), 'the gateway reads the token under its existing grant');
	for (
		const line of [
			'    read_only: true',
			'    cap_drop:\n      - ALL',
			'      - no-new-privileges:true',
			'      - seccomp:./docker/seccomp-sandbox.json',
			'      - systempaths=unconfined',
			'      - ttk-code:/work',
			`      - ttk-sandbox-token:${GENERATED_TOKEN_DIR}\n`,
			'      - /tmp/ttk-sandbox:uid=1993,gid=1993,mode=0700,size=64m',
			`      TTK_SANDBOX_TOKEN_FILE: ${GENERATED_TOKEN_FILE}`,
			'    networks:\n      - sandbox-private\n      - sandbox-egress',
			'    mem_limit: 1g',
			'    cpus: 2',
			'    pids_limit: 512',
			'    restart: unless-stopped',
			"    logging:\n      driver: json-file\n      options:\n        max-size: 10m\n        max-file: '3'",
		]
	) {
		assert(sandbox.includes(line), `the sandbox service carries ${JSON.stringify(line)}`);
	}
	assert(!/^\s+(ports|expose|command|privileged|cap_add|network_mode):/m.test(sandbox), 'nothing that widens it');
	assert(!sandbox.includes('/var/run/docker.sock'), 'the Engine socket stays in the Docker overlay');
	const active = activeText(compose);
	assert(active.includes('\n  sandbox-private:\n    internal: true\n'), 'the gateway-to-sandbox network is internal');
	assert(/\nvolumes:\n(?: {2}.*\n)*? {2}ttk-sandbox-token: \{\}\n/.test(`${active}\n`), 'the token volume is declared');
	// Exactly two mounts of the token volume in every compose file, and the gateway's is read-only.
	for (const file of await composeFiles()) {
		const text = await Deno.readTextFile(file);
		for (const match of activeText(text).matchAll(/^\s+- ttk-sandbox-token:(\S+)$/gm)) {
			assert(file === 'docker-compose.yml', `${file} mounts the token volume (${match[1]})`);
		}
		for (const service of ['agent-runner', 'a2a-peer']) {
			assert(!(serviceBlock(text, service) ?? '').includes('ttk-sandbox-token'), `${file}: ${service} never mounts it`);
		}
	}
	const mounts = [...active.matchAll(/^\s+- ttk-sandbox-token:(\S+)$/gm)].map((match) => match[1]);
	assertEquals(mounts, [`${gatewayTokenDir}:ro`, GENERATED_TOKEN_DIR]);
	// The image makes the folder the volume copies its owner and mode from.
	const dockerfile = await Deno.readTextFile('docker/Dockerfile.sandbox');
	assert(dockerfile.includes(`chmod 0700 ${GENERATED_TOKEN_DIR}`), 'the token folder is 0700');
	assert(new RegExp(`chown -R 1993:1993 [^\\n]*${GENERATED_TOKEN_DIR}`).test(dockerfile), 'and owned by 1993');
	// The operator-file overlay points both services at the compose secret the image's CMD grants on its own.
	const overlay = await Deno.readTextFile('docker-compose.sandbox.yml');
	for (const name of ['tykotech-mcp', 'sandbox']) {
		const block = serviceBlock(overlay, name) ?? '';
		assert(block.includes(`      TTK_SANDBOX_TOKEN_FILE: ${SECRET_TOKEN_FILE}`), `${name}: the operator's file`);
		assert(block.includes('    secrets:\n      - ttk_sandbox_token'), `${name}: mounted as the compose secret`);
	}
	assert(overlay.includes('  ttk_sandbox_token:\n    file: ./secrets/ttk_sandbox_token'), 'from secrets/');
	assert(!/command:|image:|build:/.test(activeText(overlay)), "and nothing else: the matrices stay the images'");
});

/**
 * The default stack's A2A peer (docs/design/stack-tooling-and-secrets.md): a second gateway from the same image that
 * publishes nothing, authenticates with a key file holding only the hash of the token the gateway presents, is told
 * the URL the gateway dials (the A2A client refuses a card that names another origin), and keeps the gateway's
 * Chromium sandbox settings. The gateway names it in its peers file and never waits on it.
 */
Deno.test('stack: the A2A peer publishes nothing, holds only its own key file, and keeps the Chromium sandbox', async () => {
	const compose = await Deno.readTextFile('docker-compose.yml');
	const peer = serviceBlock(compose, 'a2a-peer');
	const gateway = serviceBlock(compose, 'tykotech-mcp');
	assert(peer !== null && gateway !== null, 'both services are in the base file');
	for (
		const line of [
			'    image: tykotech-mcp:0.2.0',
			"    user: '1993:1993'",
			'      - ttk-peer-data:/data',
			"    shm_size: '1gb'",
			'      - seccomp:./docker/seccomp-chromium.json',
			'      TTK_PUBLIC_URL: http://a2a-peer:8787',
			'      TTK_API_KEYS_FILE: /run/secrets/ttk_peer_api_keys',
			'    secrets:\n      - ttk_peer_api_keys\n',
		]
	) {
		assert(peer.includes(line), `the peer carries ${JSON.stringify(line)}`);
	}
	assert(
		!/^\s+(ports|expose|command|entrypoint|privileged|cap_add|network_mode|depends_on):/m.test(peer),
		'nothing that widens it, and the image CMD is its matrix',
	);
	assert(!/^\s+build:/m.test(peer), "the gateway service's build is the peer's image: one build, not two");
	assert(!peer.includes('no-new-privileges'), 'no-new-privileges would block the Chromium sandbox helper');
	assert(
		!/TTK_CHROMIUM_NO_SANDBOX|TTK_DB_KEY_FILE|TTK_ADMIN_USER_FILE|ttk_db_key|ttk_admin_user|ttk_api_keys|ttk-sandbox/
			.test(peer),
		"none of the gateway's secrets or the sandbox's token",
	);
	for (
		const line of [
			'      TTK_AGENT_PEERS_FILE: /run/secrets/ttk_agent_peers',
			'      - ttk_agent_peers',
			'      - ttk_peer_token',
		]
	) {
		assert(gateway.includes(line), `the gateway carries ${JSON.stringify(line)}`);
	}
	assert(!gateway.includes('a2a-peer'), 'the gateway does not wait on the peer');
	assert(!(serviceBlock(compose, 'sandbox') ?? '').includes('ttk_peer'), 'the sandbox never sees the peer token');
});

Deno.test('D-137 (AC6, F14): the bundled HEALTHCHECK strips OTEL_DENO before it runs deno', async () => {
	const text = await Deno.readTextFile('Dockerfile');
	const at = text.indexOf('\nHEALTHCHECK ');
	assert(at >= 0, 'the bundled image declares a HEALTHCHECK');
	const start = text.indexOf('CMD [', at);
	const end = text.indexOf(']', start);
	const argv = JSON.parse(text.slice(start + 4, end + 1)) as string[];
	assertEquals(argv, [
		'/usr/bin/env',
		'-u',
		'OTEL_DENO',
		'deno',
		'run',
		'--cached-only',
		'--allow-net=127.0.0.1',
		'--allow-env=TTK_PORT',
		'scripts/healthcheck.ts',
	]);
	// The base is Debian (`/usr/bin/env` from coreutils, MB7) and the runtime stage is that same image.
	assert(/^ARG DENO_IMAGE=denoland\/deno:2\.9\.7@sha256:/m.test(text), 'the runtime base is the Debian deno image');
});
