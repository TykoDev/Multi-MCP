import { probeProcPaths } from './cage.ts';
import { DockerSandbox } from './docker.ts';
import { Engine, unixDial } from './engine.ts';
import { userNamespaceFilter } from './filter.ts';
import { GIT_REMOTES_FILE, type GitRemote, loadGitRemotes } from './git_forwarder.ts';
import { createSandboxHandler } from './http.ts';
import { guardSecret, log } from './log.ts';
import { LIMITS } from './limits.ts';
import { defaultProxyDeps } from './proxy.ts';
import { freeBytes, Sandbox } from './sandbox.ts';
import { sandboxSettings } from './settings.ts';
import { GENERATED_TOKEN_FILE, provisionServiceToken, readServiceToken, releaseTokenGrants } from './token.ts';
import { WorkspaceService } from './workspaces.ts';

/** The code volume, as the service holds it. */
const WORK_DIR = '/work';
/** The bwrap backend's proxy sockets: the container's own tmpfs, not the shared volume. */
const RUNTIME_DIR = '/tmp/ttk-sandbox';
/**
 * D-108: where the Docker backend's service holds the socket volume (docker-compose.sandbox-docker.yml mounts it
 * here and grants it); each workspace container sees its own subfolder of it at /run/harbour, read-only (E-90).
 */
export const SOCK_DIR = '/run/ttk-sandbox-sock';

/** Starts the Linux-only private sandbox using file-backed credentials. */
export async function startSandbox(): Promise<void> {
	if (Deno.build.os !== 'linux') throw new Error('The coding sandbox service requires Linux.');
	// Names outside the --allow-env grant read as unset, so the default image starts the bwrap backend (D-108).
	const settings = sandboxSettings();
	const docker = settings.backend === 'docker' ? settings.docker : null;
	// SB-5: read once; the grant to read the file is revoked before anything else runs. The folders (and, for the
	// Docker backend, the Engine socket) the service still needs must stay readable after it.
	const keep = docker ? [WORK_DIR, RUNTIME_DIR, SOCK_DIR, docker.socket] : [WORK_DIR, RUNTIME_DIR];
	// D-151: docker-compose.yml points this service at GENERATED_TOKEN_FILE, on a volume only it and the gateway mount,
	// so a fresh `up` needs no operator-made token. It is created on the first start and never replaced; any other path
	// is the operator's file and is never created. The log names the path only — the value is not even guarded yet.
	if (settings.tokenFile === GENERATED_TOKEN_FILE && await provisionServiceToken(GENERATED_TOKEN_FILE)) {
		log('info', 'sandbox.token_generated', { path: GENERATED_TOKEN_FILE });
	}
	const token = await readServiceToken(settings.tokenFile, keep);
	guardSecret(token);
	// D-151: both token locations, and the write grant on the generated one, are given up before anything else runs.
	await releaseTokenGrants(keep);
	// R12 (D-132): the credentialed remotes, read once in the same way; their credentials are guarded as they are read.
	// Unset, the grant to the remotes file is given up all the same: nothing in this process reads it again.
	let remotes: GitRemote[] = [];
	if (settings.git.remotesFile !== null) remotes = await loadGitRemotes(settings.git.remotesFile, keep);
	else await Deno.permissions.revoke({ name: 'read', path: GIT_REMOTES_FILE });
	await Deno.mkdir(RUNTIME_DIR, { recursive: true, mode: 0o700 });
	const proxy = defaultProxyDeps((event, fields) => log('warn', event, fields));
	let backend: Sandbox | DockerSandbox;
	if (docker) {
		// G1: opt-in and loud. The socket is root on the host; the warning says so on every start.
		log('warn', 'sandbox.docker_backend', {
			message: 'TTK_SANDBOX_BACKEND=docker: this service holds the Docker Engine socket, which is root-equivalent ' +
				'on the host. Workspaces run as containers it creates from a fixed, validated body. Prefer rootless Docker.',
			socket: docker.socket,
			image: docker.image,
			volume: docker.volume,
			sockVolume: docker.sockVolume,
		});
		const dockerBackend = new DockerSandbox({
			workDir: WORK_DIR,
			sockDir: SOCK_DIR,
			policy: { image: docker.image, volume: docker.volume, sockVolume: docker.sockVolume },
		}, { engine: new Engine(unixDial(docker.socket)), log, proxy, freeBytes });
		await dockerBackend.start();
		backend = dockerBackend;
	} else {
		const filter = userNamespaceFilter(Deno.build.arch);
		if (!filter) throw new Error('No cage seccomp filter for this architecture.');
		const bwrap = '/usr/bin/bwrap';
		// D-064: commands receive only their own workspace mounts, never token files or service state.
		backend = new Sandbox({
			workDir: WORK_DIR,
			runtimeDir: RUNTIME_DIR,
			bwrap,
			system: { etc: '/app/packages/sandbox/cage/etc', proc: await probeProcPaths(bwrap) },
			filter,
		}, { log, proxy, freeBytes });
	}
	const service = new WorkspaceService(WORK_DIR, backend, { hosts: settings.git.hosts, remotes });
	if (service.clones) {
		// Names only: the hosts a public clone may reach, and the remotes' ids — never a remote's URL or credential.
		log('info', 'sandbox.clone', { hosts: [...settings.git.hosts], remotes: remotes.map((remote) => remote.id) });
	}
	await service.initialize();
	if (!(await service.health()).ok) throw new Error(`Sandbox readiness failed (${backend.kind} backend).`);
	// SB-4: what a crash left behind is removed at start-up and then every LIMITS.sweepEveryMs.
	const sweep = (): void => {
		service.sweep().then(
			(removed) => removed > 0 && log('info', 'sweep.removed', { removed }),
			(err) => log('warn', 'sweep.failed', { err }),
		);
	};
	sweep();
	const sweeper = setInterval(sweep, LIMITS.sweepEveryMs);
	const handler = await createSandboxHandler(service, token);
	const server = Deno.serve({
		hostname: '0.0.0.0',
		port: 8080,
		onListen: () => log('info', 'sandbox.listening', { port: 8080, backend: backend.kind }),
	}, handler);
	const stop = (): void => {
		clearInterval(sweeper);
		backend.runs.cancelAll();
		if (backend instanceof DockerSandbox) backend.close();
		void server.shutdown();
	};
	Deno.addSignalListener('SIGTERM', stop);
	Deno.addSignalListener('SIGINT', stop);
	try {
		await server.finished;
	} finally {
		Deno.removeSignalListener('SIGTERM', stop);
		Deno.removeSignalListener('SIGINT', stop);
	}
}
