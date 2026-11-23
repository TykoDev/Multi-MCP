/**
 * The service's configuration, read once at start-up. A name outside the `--allow-env` grant reads as unset
 * (`grantedEnv`), so the default image starts the bwrap backend; the Docker overlay grants the Docker names.
 */
import type { SandboxBackend } from './client.ts';
import { parseGitHosts } from './clone.ts';
import type { DockerPolicy } from './docker_spec.ts';
import { GIT_REMOTES_FILE } from './git_forwarder.ts';

export type EnvReader = (name: string) => string | undefined;

/** Reads an environment variable, or undefined when it is unset or outside this process's `--allow-env` grant. */
export function grantedEnv(
	name: string,
	get: (name: string) => string | undefined = (key) => Deno.env.get(key),
): string | undefined {
	try {
		return get(name);
	} catch {
		return undefined;
	}
}

export interface DockerSettings extends DockerPolicy {
	/** The Engine API's unix socket (`TTK_SANDBOX_DOCKER_SOCKET`). */
	socket: string;
}

/** Where clones may come from: public `hosts`, and the credentialed remotes file. Both empty: clone is off. */
export interface GitSettings {
	/** `TTK_SANDBOX_GIT_HOSTS`, lower-cased. */
	hosts: ReadonlySet<string>;
	/** `TTK_SANDBOX_GIT_REMOTES_FILE`, which can only be {@linkcode GIT_REMOTES_FILE}; null when unset. */
	remotesFile: string | null;
}

export type SandboxSettings =
	| { backend: 'bwrap'; tokenFile: string; git: GitSettings }
	| { backend: 'docker'; tokenFile: string; docker: DockerSettings; git: GitSettings };

export const DOCKER_DEFAULTS = {
	socket: '/var/run/docker.sock',
	image: 'tykotech-sandbox-workspace:0.2.0',
	volume: 'ttk-code',
	sockVolume: 'ttk-sandbox-sock',
} as const;

/** `name:tag`, `name@sha256:…` or both; a bare name would mean `latest`. */
const IMAGE =
	/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?<tag>:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?<digest>@sha256:[0-9a-f]{64})?$/;
/** Docker's own rule for volume names. */
const VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/;

function value(read: EnvReader, name: string): string | undefined {
	const raw = read(name)?.trim();
	return raw === undefined || raw === '' ? undefined : raw;
}

/** The git names; the remotes file must be the granted compose secret, or the grant would widen. */
export function gitSettings(read: EnvReader = (name) => grantedEnv(name)): GitSettings {
	const hosts = parseGitHosts(value(read, 'TTK_SANDBOX_GIT_HOSTS'));
	const remotesFile = value(read, 'TTK_SANDBOX_GIT_REMOTES_FILE') ?? null;
	if (remotesFile !== null && remotesFile !== GIT_REMOTES_FILE) {
		throw new Error(
			`TTK_SANDBOX_GIT_REMOTES_FILE must be ${GIT_REMOTES_FILE} (a compose secret named ttk_git_remotes).`,
		);
	}
	return { hosts, remotesFile };
}

/** Parses the service's settings; throws, naming the variable, on anything it cannot use. */
export function sandboxSettings(read: EnvReader = (name) => grantedEnv(name)): SandboxSettings {
	const tokenFile = value(read, 'TTK_SANDBOX_TOKEN_FILE');
	if (!tokenFile) throw new Error('TTK_SANDBOX_TOKEN_FILE is required.');
	const git = gitSettings(read);
	const backend = (value(read, 'TTK_SANDBOX_BACKEND') ?? 'bwrap').toLowerCase() as SandboxBackend;
	if (backend === 'bwrap') return { backend, tokenFile, git };
	if (backend !== 'docker') throw new Error('TTK_SANDBOX_BACKEND must be bwrap or docker.');
	const socket = value(read, 'TTK_SANDBOX_DOCKER_SOCKET') ?? DOCKER_DEFAULTS.socket;
	if (!socket.startsWith('/') || socket.includes('\0') || socket.length > 255) {
		throw new Error('TTK_SANDBOX_DOCKER_SOCKET must be an absolute path.');
	}
	const image = value(read, 'TTK_SANDBOX_WORKSPACE_IMAGE') ?? DOCKER_DEFAULTS.image;
	const named = IMAGE.exec(image);
	if (!named || (!named.groups?.tag && !named.groups?.digest)) {
		throw new Error('TTK_SANDBOX_WORKSPACE_IMAGE must name an image by a tag or a digest.');
	}
	const volume = value(read, 'TTK_SANDBOX_DOCKER_VOLUME') ?? DOCKER_DEFAULTS.volume;
	const sockVolume = value(read, 'TTK_SANDBOX_DOCKER_SOCK_VOLUME') ?? DOCKER_DEFAULTS.sockVolume;
	for (const [name, given] of [['TTK_SANDBOX_DOCKER_VOLUME', volume], ['TTK_SANDBOX_DOCKER_SOCK_VOLUME', sockVolume]]) {
		if (!VOLUME.test(given!)) throw new Error(`${name} must be a Docker volume name.`);
	}
	if (volume === sockVolume) {
		throw new Error('TTK_SANDBOX_DOCKER_VOLUME and TTK_SANDBOX_DOCKER_SOCK_VOLUME must name different volumes.');
	}
	return { backend, tokenFile, docker: { socket, image, volume, sockVolume }, git };
}
