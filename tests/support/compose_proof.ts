/**
 * ERRATUM(E-112), review R3-4 / K-6: what the two Compose proofs (`tests/sandbox/verify_compose.ts`,
 * `tests/agents/verify_compose.ts`) share, so that each brings up images built from this tree, by tag, and nothing of
 * the operator's.
 *
 * Both proofs used to layer a fixture over the shipped compose files and inherit two things from them: the images the
 * files name (`tykotech-mcp:0.2.0`, `tykotech-sandbox:0.2.0` — the deployed build, not the tree under test) and the
 * `ttk_admin_user` secret (`./secrets/ttk_admin_user.json` — the operator's real administrator record, mounted into a
 * throwaway stack; in a checkout without one Docker Desktop mounts a directory there and the gateway refuses to start).
 * Here: a required `--tag` that may not be a deployed one, a synthetic admin record in the scratch folder, and a check
 * of the resolved configuration — every image the stack runs is the tag's, every secret file is in the scratch folder —
 * before anything is started.
 */
import { DELIMITER, isAbsolute, join, relative, resolve } from '@std/path';

/** A Docker tag, short enough that `<tag>-fixture` is one too (Docker allows 128 characters). */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** Thrown for a proof that must not run as asked; the message says what to do instead. */
export class ProofRefused extends Error {
	override name = 'ProofRefused';
}

/**
 * Every tag a deployment builds: deno.json's `version` and every `tykotech-*:<tag>` the shipped compose files name.
 * A proof run under one of them would test, or rebuild over, the operator's deployed images.
 */
export async function deployedTags(root = '.'): Promise<Set<string>> {
	const tags = new Set<string>();
	const { version } = JSON.parse(await Deno.readTextFile(join(root, 'deno.json'))) as { version?: unknown };
	if (typeof version === 'string') tags.add(version);
	for (const file of ['docker-compose.yml', 'docker-compose.sandbox.yml', 'docker-compose.agents.yml']) {
		// `image: tykotech-mcp:0.2.0`, and `image: '${TTK_AGENT_RUNNER_IMAGE:-tykotech-agent-runner:0.2.0}'`.
		const images = /image:\s*['"]?(?:\$\{[A-Z_]+:-)?tykotech-[a-z-]+:([A-Za-z0-9_.-]+)/g;
		for (const match of (await Deno.readTextFile(join(root, file))).matchAll(images)) tags.add(match[1]!);
	}
	return tags;
}

/** The tag of `--tag <t>` or `--tag=<t>` in `args`: required, well formed, and not a deployed one. */
export function proofTag(args: readonly string[], deployed: ReadonlySet<string>): string {
	const usage = 'build the images from this tree under a tag of your own and name it, e.g. ' +
		'`docker build -t tykotech-mcp:verify .`, `docker build -f docker/Dockerfile.sandbox -t tykotech-sandbox:verify .`, ' +
		'then `--tag verify`';
	const values: string[] = [];
	for (const [index, arg] of args.entries()) {
		if (arg === '--tag') values.push(args[index + 1] ?? '');
		else if (arg.startsWith('--tag=')) values.push(arg.slice('--tag='.length));
	}
	if (values.length === 0) throw new ProofRefused(`--tag is required: ${usage}`);
	if (values.length > 1) throw new ProofRefused('--tag given more than once');
	const tag = values[0]!;
	if (!TAG.test(tag)) throw new ProofRefused(`--tag must be a Docker tag of at most 100 characters: ${usage}`);
	if (deployed.has(tag)) {
		throw new ProofRefused(`--tag ${tag} is a deployed tag; the proof never runs the operator's images: ${usage}`);
	}
	return tag;
}

/**
 * Writes a synthetic administrator record to `path`: PBKDF2-SHA-256 (100 000 iterations, the gateway's own) of a random
 * password that is never kept, printed or returned. The gateway starts with it; nobody can sign in with it.
 */
export async function writeSyntheticAdmin(path: string): Promise<void> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const material = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(crypto.randomUUID() + crypto.randomUUID()),
		{ name: 'PBKDF2' },
		false,
		['deriveBits'],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
		material,
		256,
	);
	const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	await Deno.writeTextFile(
		path,
		JSON.stringify({
			username: 'compose-admin',
			salt: hex(salt),
			hash: hex(new Uint8Array(bits)),
			iterations: 100_000,
		}),
	);
}

/**
 * The default stack's files beyond the keys, administrator and database key each proof makes for itself, written into
 * `scratch` the way `deno task setup` writes them: the browser-secrets and git-remotes placeholders, the A2A peer list,
 * and the peer's token with the hashed record the peer authenticates it by. Returns the fixture's `secrets:` entries
 * for them (indented for a top-level `secrets:` block) and their names, for `assertIsolated`'s `required`.
 */
export async function writeStackFiles(
	scratch: string,
): Promise<{ readonly secrets: string; readonly names: string[] }> {
	const token = `ttk_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
	const sha256 = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
	const files: Record<string, [string, string]> = {
		ttk_secrets: ['browser-secrets.json', '{}\n'],
		ttk_git_remotes: ['git-remotes.json', '[]\n'],
		ttk_agent_peers: [
			'agent-peers.json',
			`${JSON.stringify([{ id: 'peer', url: 'http://a2a-peer:8787', token_file: '/run/secrets/ttk_peer_token' }])}\n`,
		],
		ttk_peer_token: ['peer-token', `${token}\n`],
		ttk_peer_api_keys: [
			'peer-keys.json',
			`${JSON.stringify([{ id: 'gateway', sha256, scopes: ['mcp:invoke', 'agent:invoke'] }])}\n`,
		],
	};
	const lines: string[] = [];
	for (const [name, [path, text]] of Object.entries(files)) {
		await Deno.writeTextFile(join(scratch, path), text);
		lines.push(`  ${name}:`, `    file: ${JSON.stringify(join(scratch, path).replaceAll('\\', '/'))}`);
	}
	return { secrets: `${lines.join('\n')}\n`, names: Object.keys(files) };
}

/** Whether `path` lies inside `folder` (both resolved; case-insensitive on Windows, as its file system is). */
export function isInside(folder: string, path: string): boolean {
	const fold = (value: string) => (Deno.build.os === 'windows' ? resolve(value).toLowerCase() : resolve(value));
	const rest = relative(fold(folder), fold(path));
	return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest);
}

/** The parts of `docker compose config --format json` the isolation check reads. */
export interface ComposeConfig {
	readonly services: Readonly<Record<string, { readonly image?: string }>>;
	readonly secrets?: Readonly<Record<string, { readonly file?: string }>>;
}

/**
 * The resolved stack is the proof's own: every service runs exactly the image `images` names for it (a service it
 * does not name fails, so a service added to the compose files later is pinned too), every secret is a file inside
 * `scratch`, and each of `required` is among them — `ttk_admin_user` above all, which the shipped file takes from the
 * checkout's `secrets/`.
 */
export function assertIsolated(
	config: ComposeConfig,
	expected: { scratch: string; images: Readonly<Record<string, string>>; required: readonly string[] },
): void {
	for (const [service, { image }] of Object.entries(config.services)) {
		const want = expected.images[service];
		if (want === undefined) throw new ProofRefused(`service ${service} runs ${image}, which the proof does not pin`);
		if (image !== want) throw new ProofRefused(`service ${service} runs ${image}, not ${want}`);
	}
	const secrets = config.secrets ?? {};
	for (const name of expected.required) {
		if (secrets[name] === undefined) throw new ProofRefused(`secret ${name} is not declared`);
	}
	for (const [name, { file }] of Object.entries(secrets)) {
		if (typeof file !== 'string' || !isInside(expected.scratch, file)) {
			throw new ProofRefused(`secret ${name} resolves to ${file ?? 'no file'}, outside the proof's scratch folder`);
		}
	}
}

/** The Docker CLI this process may run: the first on PATH that the run grant names. */
export async function dockerExecutable(): Promise<string> {
	for (const path of (Deno.env.get('PATH') ?? '').split(DELIMITER)) {
		if (!path) continue;
		const candidate = resolve(join(path.replace(/^"|"$/g, ''), Deno.build.os === 'windows' ? 'docker.exe' : 'docker'));
		if ((await Deno.permissions.query({ name: 'run', command: candidate })).state === 'granted') return candidate;
	}
	throw new ProofRefused('no Docker CLI on PATH is granted; run the proof through its deno task');
}

/** Runs the Docker CLI with `args`; its stdout, or an error carrying both streams. */
export async function docker(executable: string, args: readonly string[]): Promise<string> {
	const output = await new Deno.Command(executable, { args: [...args], stdout: 'piped', stderr: 'piped' }).output();
	const stdout = new TextDecoder().decode(output.stdout);
	if (!output.success) {
		throw new Error(
			`docker ${args.slice(0, 2).join(' ')} failed (${output.code}): ${stdout}\n${
				new TextDecoder().decode(output.stderr)
			}`,
		);
	}
	return stdout;
}

/** Refuses to go on unless every image in `images` is already built locally: nothing is pulled or rebuilt. */
export async function assertBuilt(executable: string, images: readonly string[]): Promise<void> {
	for (const image of images) {
		const found = await new Deno.Command(executable, {
			args: ['image', 'inspect', image],
			stdout: 'null',
			stderr: 'null',
		})
			.output();
		if (!found.success) throw new ProofRefused(`image ${image} is not built; build it from this tree first`);
	}
}
