/**
 * The opt-in Docker workspace backend; bwrap (sandbox.ts) is the reference for every operation's paths, LIMITS,
 * results and errors, and `SandboxBase` there holds what the two share. One long-lived container per workspace
 * (docker_spec.ts has its body), started on demand and stopped after LIMITS.containerIdleMs idle. Every piece of work
 * is an exec through the wrapper, which gives it a session of its own: a kill exec ends that process group (the API
 * cannot kill an exec), and a cleanup exec after each command kills what it left behind; starts and cleanups are
 * serialized per container.
 *
 * Differences from bwrap, all within one workspace: commands and a session share processes, loopback and `/tmp`;
 * one registries-mode exec at a time (the forwarder's port is the container's); `PidsLimit` instead of `ulimit -p`.
 * Disk use is measured by the service on its own view of the volume with the container paused, never inside it: a
 * process in the same pid namespace could hide a directory from du. A failed measurement counts as over budget.
 * Containers are named and labelled per deployment ({@linkcode deploymentId} of the code volume).
 */
import { BASE_ENV, CAGE_HOME, type CageResult, PROXY_SOCKET, proxyEnv, WORKSPACE } from './cage.ts';
import { CAGED_OUTPUT_BYTES, type CagedFileOp, cagedResult, cagedScript } from './caged_files.ts';
import { diffScript } from './diff.ts';
import { treeUsage, type TreeUsageOptions } from './disk.ts';
import {
	BodyRefused,
	CHECK_OWNER,
	CLEANUP_SCRIPT,
	COMMAND_BODY,
	containerBody,
	containerName,
	type CreateFor,
	createFor,
	deploymentId,
	DOCKER_DIFF_SCRATCH,
	type DockerPolicy,
	execBody,
	HARBOUR_DIR,
	innerScript,
	KILL_SCRIPT,
	LABEL_DEPLOYMENT,
	LABEL_OWNER,
	LABEL_WORKSPACE,
	READY_LINE,
	REPAIR_BODY,
	sameJson,
	SESSION_BODY,
	VOLUME_CHECK_BODY,
	VOLUME_CHECK_FILE,
	WRAPPER,
} from './docker_spec.ts';
import { type ContainerInfo, type Engine, EngineError, type ExecStream } from './engine.ts';
import { LIMITS } from './limits.ts';
import { collect, OutputCapture } from './output.ts';
import { type OpenEgress, type ProxyHandle, RegistryProxy } from './proxy.ts';
import { type ExecRequest, RUN_ID } from './request.ts';
import {
	ApiError,
	checkCwd,
	describe,
	type DiffWork,
	type DiskQuota,
	type ExecResult,
	gitDirectory,
	isDirectory,
	overBudget,
	removeTree,
	type RunOptions,
	SandboxBase,
	type SandboxDeps,
	type SandboxLimits,
	sessionOverBudget,
	type SessionShell,
} from './sandbox.ts';

export interface DockerSandboxConfig {
	workDir: string;
	sockDir: string;
	policy: DockerPolicy;
	limits?: Partial<SandboxLimits>;
	/** How long the start-up volume check may take in all; LIMITS.choreTimeoutMs unless a test names less. */
	checkTimeoutMs?: number;
}

export interface DockerSandboxDeps extends SandboxDeps {
	engine: Engine;
	/** Opens the registry proxy on a unix socket; RegistryProxy.open unless a test names another. */
	openProxy?(path: string, runId: string): ProxyHandle;
	/** Measures folders as the service sees them; disk.ts `treeUsage` unless a test names another. */
	measure?(paths: readonly string[], options: TreeUsageOptions): Promise<number>;
}

/** How long the wrapper may take to say it started the work. */
const START_MS = 30_000;
/** How long the stream may stay open once its work was killed: Docker closes it ≤ 2 s after the exec ends. */
const DRAIN_GRACE_MS = 5_000;
/** How long a kill or cleanup exec may take. */
const DIRECT_MS = 30_000;
const IDLE_SWEEP_MS = 60_000;
const DIAGNOSTICS_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One at a time, in order. */
class Mutex {
	#tail: Promise<void> = Promise.resolve();

	run<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(work);
		this.#tail = result.then(() => {}, () => {});
		return result;
	}
}

/** One workspace's container, as this process knows it. */
class Box {
	id: string | null = null;
	/** Whether the container was created with the checkout's `.git` mounted. */
	git = false;
	running = false;
	lastActive = Date.now();
	active = 0;
	/** A registries-mode exec holds the proxy socket. */
	proxy = false;
	/** The wrapper pid and work session of every exec running now: what a cleanup spares. */
	readonly live = new Map<number, { pid: number; sid: number }>();
	/** Create, start, stop and remove. */
	readonly lifecycle = new Mutex();
	/** Exec starts, kills and cleanups. */
	readonly starting = new Mutex();

	constructor(readonly runId: string) {}
}

/** A live session's standard input: queued, so a shell that is not reading never holds up the caller. */
class SessionInput {
	#queue: Uint8Array[] = [];
	#stream: ExecStream | null = null;
	#pumping = false;
	#closed = false;

	attach(stream: ExecStream): void {
		this.#stream = stream;
		void this.#drain();
	}

	push(bytes: Uint8Array): boolean {
		if (this.#closed) return false;
		this.#queue.push(bytes);
		void this.#drain();
		return true;
	}

	close(): void {
		this.#closed = true;
		this.#queue = [];
	}

	async #drain(): Promise<void> {
		if (this.#pumping || this.#stream === null) return;
		this.#pumping = true;
		try {
			while (this.#queue.length > 0 && !this.#closed) await this.#stream.write(this.#queue.shift()!);
		} catch {
			this.#closed = true;
		} finally {
			this.#pumping = false;
		}
	}
}

/** What one exec runs, past the wrapper. */
interface Work {
	/** The script after the prelude (docker_spec.ts innerScript). */
	body: string;
	/** `$1…` for the body: a request's command line, never part of a script. */
	args?: string[];
	env?: Record<string, string>;
	workdir?: string;
	/** Written to the work's standard input, which is then closed. */
	stdin?: Uint8Array | null;
	input?: SessionInput;
	proxy?: boolean;
	noGrowth?: boolean;
}

export class DockerSandbox extends SandboxBase<DockerSandboxConfig, DockerSandboxDeps> {
	override readonly kind = 'docker' as const;
	readonly #boxes = new Map<string, Box>();
	/** Workspace → owner hash, for the container's labels: from the owner records, and from `assign` on create. */
	readonly #owners = new Map<string, string>();
	#idle: ReturnType<typeof setInterval> | undefined;
	#sweeping = false;
	/** This deployment's id, from the code volume's name; set by `start`. */
	#deployment: string | null = null;
	/** The image id the configured tag pointed at when the service started (its check container's). */
	#imageId: string | null = null;
	#execs = 0;

	/**
	 * Start-up: API 1.45+, both volumes exist, and the code volume is proven to be the service's own. Throws naming
	 * what is missing, so a misconfigured service never reports healthy.
	 */
	async start(): Promise<void> {
		const engine = this.deps.engine;
		try {
			await engine.ping();
		} catch (error) {
			throw new Error(
				`The Docker Engine API is not reachable at version 1.45 or later: ${
					error instanceof Error ? error.message : 'error'
				}`,
			);
		}
		for (const name of [this.config.policy.volume, this.config.policy.sockVolume]) {
			if (!(await engine.volumeExists(name))) throw new Error(`The Docker volume ${name} does not exist.`);
		}
		this.#deployment = await deploymentId(this.config.policy.volume);
		await this.#checkVolume(this.#deployment);
		this.#idle = setInterval(() => void this.stopIdle(), IDLE_SWEEP_MS);
	}

	/** This deployment's id; every container operation needs it, so nothing runs before `start`. */
	get #scope(): string {
		if (this.#deployment === null) throw new ApiError(503, 'cage_failed', 'The Docker backend has not started.');
		return this.#deployment;
	}

	/** Stops the idle sweep; containers are left as they are (the next start reconciles them). */
	close(): void {
		if (this.#idle !== undefined) clearInterval(this.#idle);
		this.#idle = undefined;
		this.runs.cancelAll();
	}

	/**
	 * Startup reconciliation of this deployment's containers: one without a deployment label, a workspace record or
	 * the recorded owner is removed; a running one is stopped (no session survives a restart). Others are left alone.
	 */
	async reconcile(owners: ReadonlyMap<string, string>): Promise<void> {
		for (const [id, owner] of owners) this.#owners.set(id, owner);
		const deployment = this.#scope;
		let removed = 0;
		let stopped = 0;
		for (const container of await this.deps.engine.listContainers()) {
			if (!container.volumes.includes(this.config.policy.volume)) continue;
			const labelled = container.labels[LABEL_DEPLOYMENT];
			if (labelled !== undefined && labelled !== deployment) continue;
			const runId = container.labels[LABEL_WORKSPACE] ?? '';
			const owner = owners.get(runId);
			try {
				if (
					labelled === undefined || !RUN_ID.test(runId) || owner === undefined ||
					container.labels[LABEL_OWNER] !== owner
				) {
					await this.deps.engine.removeContainer(container.id);
					removed++;
				} else if (container.running) {
					await this.deps.engine.stopContainer(container.id);
					stopped++;
				}
			} catch (error) {
				this.deps.log('warn', 'docker.reconcile_failed', { runId, error: describe(error) });
			}
		}
		this.deps.log('info', 'docker.reconciled', { removed, stopped });
	}

	assign(runId: string, owner: string): void {
		this.#owners.set(runId, owner);
	}

	// --- commands --------------------------------------------------------------------------------------------

	exec(req: ExecRequest, signal?: AbortSignal, quota?: DiskQuota): Promise<ExecResult> {
		return this.runs.hold(req.runId, signal, async (held) => {
			const { checkout } = await this.locate(req.runId);
			await checkCwd(checkout, req.cwd);
			const release = await this.gate.enter(held);
			try {
				const box = await this.#ready(req.runId);
				if (req.network !== 'none' && box.proxy) throw proxyBusy();
				const measure = (signal?: AbortSignal) => this.#measure(box, this.#runDirs(box.runId), signal);
				// As with bwrap; past the ceiling the container is also stopped so nothing left in it keeps writing.
				const disk = await this.watchRun(
					quota,
					(limit) => this.#measureBefore(box, limit, held),
					measure,
					async (before, limit) => {
						await this.#stop(box).catch(() => {});
						return overBudget(before, limit);
					},
				);
				const capture = new OutputCapture();
				let proxy: ProxyHandle | null = null;
				let result: CageResult;
				try {
					// A clone's step (`git`) brings its own egress: the git-host proxy or the forwarder.
					if (req.network === 'git' && req.egress === undefined) {
						throw new ApiError(500, 'internal', 'A clone step has no egress.');
					}
					if (req.network !== 'none') {
						proxy = await this.#openProxy(box, req.network === 'git' ? req.egress : undefined);
					}
					result = await this.#run(box, {
						body: COMMAND_BODY,
						args: [req.command],
						env: { ...(proxy ? proxyEnv() : {}), ...req.env },
						workdir: req.cwd ? `${WORKSPACE}/${req.cwd}` : WORKSPACE,
						stdin: req.stdin === null ? null : encoder.encode(req.stdin),
						proxy: proxy !== null,
						noGrowth: disk.cleanupOnly,
					}, {
						timeoutMs: req.timeoutMs,
						signal: held,
						onOutput: (chunk) => capture.push(chunk),
						watchdog: { everyMs: this.limits.diskPollMs, check: () => disk.watch.check() },
					});
				} finally {
					// The cleanup runs even when an earlier step of the teardown throws, so nothing the command
					// left behind outlives it; that step's error still ends the call.
					try {
						await disk.watch.end();
						await this.#closeProxy(box, proxy);
					} finally {
						await this.#cleanup(box);
					}
				}
				if (!result.started) throw this.notStarted(req.runId, result, 'a command');
				// Not cancelled with the request; when it cannot be measured, the worst is assumed.
				const after = await measure().catch(() => Math.max(disk.before, disk.limit));
				await this.#settle(box);
				return this.reply(req, result, capture.result(), after, disk, proxy);
			} finally {
				release();
			}
		});
	}

	// --- live sessions, diff, files, disk, removal, health ---------------------------------------------------

	/**
	 * Whether a file operation must run inside the container ({@linkcode fileOp}). The service's own check-then-open
	 * is safe only while nothing of the workspace runs to swap a folder for a link, so it is used only when this
	 * process knows the container is not running; a workspace untouched since start-up counts as running.
	 */
	cagesFiles(runId: string): boolean {
		const box = this.#boxes.get(runId);
		if (box === undefined) return true;
		return box.running || box.active > 0;
	}

	/** A shell exec reading its standard input; the cleanup exec ends what it left behind. */
	protected override async startShell(
		req: { runId: string; network: 'none' | 'registries' },
		quota: DiskQuota | undefined,
	): Promise<SessionShell> {
		const box = await this.#ready(req.runId);
		if (req.network === 'registries' && box.proxy) throw proxyBusy();
		const measure = (signal?: AbortSignal) => this.#measure(box, this.#runDirs(box.runId), signal);
		const { cleanupOnly, watch } = await this.watchRun(
			quota,
			(limit) => this.#measureBefore(box, limit),
			measure,
			sessionOverBudget,
		);
		let proxy: ProxyHandle | null = null;
		try {
			if (req.network === 'registries') proxy = await this.#openProxy(box);
		} catch (error) {
			await watch.end();
			throw error;
		}
		const input = new SessionInput();
		const env = proxy ? proxyEnv() : {};
		return {
			input,
			watch,
			noun: 'shell',
			run: (options) =>
				this.#run(box, { body: SESSION_BODY, env, input, proxy: proxy !== null, noGrowth: cleanupOnly }, options),
			closeProxy: () => this.#closeProxy(box, proxy),
			cleanup: () => this.#cleanup(box),
		};
	}

	protected override async diffWork(runId: string): Promise<DiffWork> {
		const box = await this.#ready(runId);
		return {
			run: (options) =>
				this.#run(
					box,
					{ body: `trap 'rm -rf ${DOCKER_DIFF_SCRATCH}' EXIT\n${diffScript(DOCKER_DIFF_SCRATCH)}` },
					options,
				),
			// The scratch as the service holds it: the container's DOCKER_DIFF_SCRATCH, under the home.
			scratch: (signal) =>
				this.#measure(box, [this.paths(runId).home + DOCKER_DIFF_SCRATCH.slice(CAGE_HOME.length)], signal),
			repair: async (signal) => {
				await this.#run(box, { body: REPAIR_BODY }, { timeoutMs: LIMITS.choreTimeoutMs, signal, onOutput: () => {} });
				signal.throwIfAborted();
			},
		};
	}

	/** A file operation for a workspace with a live session, run inside its container (caged_files.ts). */
	fileOp(runId: string, op: CagedFileOp, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.runs.hold(runId, signal, async (held) => {
			await this.locate(runId);
			const release = await this.chores.enter(held);
			try {
				const box = await this.#ready(runId);
				const out = collect(CAGED_OUTPUT_BYTES);
				const result = await this.#run(box, {
					body: cagedScript(op.kind),
					env: { TTK_PATH: op.path },
					stdin: op.kind === 'write' ? encoder.encode(op.content) : null,
				}, { timeoutMs: LIMITS.choreTimeoutMs, signal: held, onOutput: out.push });
				return cagedResult(op, result, out.bytes(), held);
			} finally {
				release();
			}
		});
	}

	/** Bytes the workspace's files take (checkout and home), for callers without a slot. */
	async diskUsage(runId: string, signal?: AbortSignal): Promise<number> {
		const release = await this.chores.enter(signal);
		try {
			return await this.#measure(this.#box(runId), this.#runDirs(runId), signal);
		} finally {
			release();
		}
	}

	/**
	 * Removes the container and the workspace's state, and gives the owner write access back throughout the checkout
	 * so the service's own removal cannot fail on a folder a command made read-only.
	 */
	protected override async removeRun(runId: string): Promise<boolean> {
		const box = this.#boxes.get(runId) ?? new Box(runId);
		await box.lifecycle.run(async () => {
			try {
				const id = box.id ?? (await this.deps.engine.inspectContainer(containerName(this.#scope, runId)))?.id ?? null;
				if (id) await this.deps.engine.removeContainer(id);
			} catch (error) {
				throw this.#engineFailure(error, runId, 'remove');
			}
			box.id = null;
			box.running = false;
		});
		this.#boxes.delete(runId);
		const paths = this.paths(runId);
		await restoreAccess(paths.checkout);
		const removed = await removeTree(paths.state, restoreAccess);
		await removeTree(`${this.config.sockDir}/${runId}`, restoreAccess);
		this.#owners.delete(runId);
		return removed;
	}

	/** The daemon answers and both volumes exist. */
	protected override async probe(): Promise<string | null> {
		await this.deps.engine.ping();
		for (const name of [this.config.policy.volume, this.config.policy.sockVolume]) {
			if (!(await this.deps.engine.volumeExists(name))) return `the Docker volume ${name} is gone`;
		}
		return null;
	}

	// --- containers -------------------------------------------------------------------------------------------

	/** What the disk budget counts: the checkout, its .git included, and the home. */
	#runDirs(runId: string): string[] {
		const paths = this.paths(runId);
		return [paths.checkout, paths.home];
	}

	#box(runId: string): Box {
		let box = this.#boxes.get(runId);
		if (box === undefined) {
			box = new Box(runId);
			this.#boxes.set(runId, box);
		}
		return box;
	}

	/** The workspace's container, created and running (the volume was proven at start-up). */
	async #ready(runId: string): Promise<Box> {
		const box = this.#box(runId);
		await box.lifecycle.run(() => this.#ensure(box, true));
		return box;
	}

	/**
	 * Makes sure the container exists with the mounts the checkout needs now, and (with `start`) runs. One found by
	 * name is kept only when it is exactly what this service would create; otherwise it is replaced (files live on
	 * the volume). Every folder a subpath names must exist first as a real directory.
	 */
	async #ensure(box: Box, start: boolean): Promise<void> {
		const runId = box.runId;
		const paths = await this.locate(runId);
		const git = (await gitDirectory(paths.checkout)) !== null;
		const owner = this.#owners.get(runId);
		if (owner === undefined) throw new ApiError(503, 'cage_failed', 'The workspace has no owner on record.');
		const sock = `${this.config.sockDir}/${runId}`;
		for (const dir of [paths.home, sock]) await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
		for (const dir of [`${this.config.workDir}/.sandbox`, paths.state, paths.home, sock]) {
			if (!(await isDirectory(dir))) throw new ApiError(409, 'bad_checkout', 'Unsafe workspace directory.');
		}
		const deployment = this.#scope;
		const target: CreateFor = await createFor({ policy: this.config.policy, runId, owner, git, deployment });
		const name = containerName(deployment, runId);
		const engine = this.deps.engine;
		try {
			if (box.id !== null && box.git !== git && box.active === 0) {
				await engine.removeContainer(box.id);
				box.id = null;
				box.running = false;
			}
			if (box.id === null) {
				const found = await engine.inspectContainer(name);
				if (found !== null && matches(found, target, this.#imageId)) {
					box.id = found.id;
					box.running = found.running;
					box.git = git;
				} else {
					if (found !== null) {
						await engine.removeContainer(found.id);
						this.deps.log('info', 'docker.replaced', { runId });
					}
					box.id = await engine.createContainer(name, containerBody(target), target);
					box.git = git;
					box.running = false;
					this.deps.log('info', 'docker.created', { runId, git });
				}
			}
			if (start && !box.running) {
				await engine.startContainer(box.id);
				box.running = true;
			}
		} catch (error) {
			throw this.#engineFailure(error, runId, 'container');
		}
		box.lastActive = Date.now();
	}

	/** After provisioning: the container is replaced by one that mounts the checkout's `.git` read-only. */
	async #settle(box: Box): Promise<void> {
		if (box.git || (await gitDirectory(this.paths(box.runId).checkout)) === null) return;
		await box.lifecycle.run(async () => {
			if (box.active > 0 || box.git) return;
			if (box.id !== null) {
				try {
					await this.deps.engine.removeContainer(box.id);
				} catch (error) {
					throw this.#engineFailure(error, box.runId, 'container');
				}
			}
			box.id = null;
			box.running = false;
			await this.#ensure(box, false);
		});
	}

	async #stop(box: Box): Promise<void> {
		await box.lifecycle.run(async () => {
			if (box.id === null || !box.running) return;
			await this.deps.engine.stopContainer(box.id);
			box.running = false;
		});
	}

	/** Stops containers that ran nothing for LIMITS.containerIdleMs; the next operation starts them again. */
	async stopIdle(now = Date.now()): Promise<void> {
		if (this.#sweeping) return;
		this.#sweeping = true;
		try {
			for (const box of [...this.#boxes.values()]) {
				if (!box.running || box.active > 0 || this.sessionOf(box.runId) !== null) continue;
				if (now - box.lastActive < LIMITS.containerIdleMs) continue;
				await box.lifecycle.run(async () => {
					if (box.id === null || !box.running || box.active > 0) return;
					await this.deps.engine.stopContainer(box.id);
					box.running = false;
					this.deps.log('info', 'docker.idle_stopped', { runId: box.runId });
				}).catch((error) =>
					this.deps.log('warn', 'docker.idle_stop_failed', { runId: box.runId, error: describe(error) })
				);
			}
		} finally {
			this.#sweeping = false;
		}
	}

	/**
	 * Proves the configured code volume is the one this service holds at /work, or the service does not start: a
	 * nonce written with `createNew` into folders just created for a fresh id, read back by a check container of the
	 * workspace image. Bounded by `checkTimeoutMs`; everything it made is removed. Also learns the image id.
	 */
	async #checkVolume(deployment: string): Promise<void> {
		const runId = crypto.randomUUID();
		const box = new Box(runId);
		const engine = this.deps.engine;
		const paths = this.paths(runId);
		const folders = [paths.checkout, paths.state];
		const sockFolder = `${this.config.sockDir}/${runId}`;
		const deadline = AbortSignal.timeout(this.config.checkTimeoutMs ?? LIMITS.choreTimeoutMs);
		let seen = '';
		let result: CageResult | null = null;
		try {
			await Deno.mkdir(`${this.config.workDir}/.sandbox`, { recursive: true, mode: 0o700 });
			for (const dir of [...folders, paths.home, sockFolder]) await Deno.mkdir(dir, { mode: 0o700 });
			const nonce = crypto.randomUUID();
			const file = await Deno.open(`${paths.home}/${VOLUME_CHECK_FILE}`, { write: true, createNew: true, mode: 0o600 });
			try {
				await file.write(encoder.encode(nonce));
			} finally {
				file.close();
			}
			const target = await createFor({ policy: this.config.policy, runId, owner: CHECK_OWNER, git: false, deployment });
			box.id = await engine.createContainer(containerName(deployment, runId), containerBody(target), target);
			deadline.throwIfAborted();
			await engine.startContainer(box.id);
			box.running = true;
			this.#imageId = (await engine.inspectContainer(box.id))?.imageId || null;
			deadline.throwIfAborted();
			result = await this.#run(box, { body: VOLUME_CHECK_BODY, workdir: '/' }, {
				timeoutMs: this.config.checkTimeoutMs ?? LIMITS.choreTimeoutMs,
				signal: deadline,
				onOutput: (chunk) => {
					seen = (seen + decoder.decode(chunk)).slice(0, 256);
				},
			});
			if (!result.started || result.killed !== null || seen.trim() !== nonce) {
				this.deps.log('error', 'docker.volume_mismatch', {
					volume: this.config.policy.volume,
					started: result.started,
					killed: result.killed,
				});
				throw new Error(
					result.killed !== null
						? `The Docker volume check did not finish (${result.killed}).`
						: `The workspace container does not see the work volume: TTK_SANDBOX_DOCKER_VOLUME (${this.config.policy.volume}) must name the volume the sandbox service holds at /work.`,
				);
			}
		} catch (error) {
			if (result !== null) throw error;
			// A code volume other than the service's has no folder for the check's id, so Docker cannot mount it.
			throw new Error(
				`The Docker volume check could not run (TTK_SANDBOX_DOCKER_VOLUME must name the volume held at /work, and ` +
					`TTK_SANDBOX_WORKSPACE_IMAGE an image the daemon has): ${describeStartup(error)}`,
			);
		} finally {
			if (box.id !== null) await engine.removeContainer(box.id).catch(() => {});
			for (const dir of [...folders, sockFolder]) await removeTree(dir, restoreAccess).catch(() => {});
		}
	}

	// --- execs ------------------------------------------------------------------------------------------------

	/** Runs one piece of work in the container through the wrapper, answering as `runCage` does. */
	async #run(box: Box, work: Work, run: RunOptions): Promise<CageResult> {
		const began = performance.now();
		const attach = work.input !== undefined || (work.stdin !== undefined && work.stdin !== null);
		const body = execBody({
			cmd: [
				WRAPPER,
				'harbour-sandbox',
				innerScript(work.body, { proxy: work.proxy, stdin: attach, noGrowth: work.noGrowth }),
				...(work.args ?? []),
			],
			env: { ...BASE_ENV, ...work.env },
			workdir: work.workdir ?? WORKSPACE,
			stdin: attach,
		});
		const key = ++this.#execs;
		box.active++;
		box.lastActive = Date.now();
		// Typed by a cast: they are assigned in callbacks, which flow analysis does not follow.
		let killed = null as string | null;
		let stream = null as ExecStream | null;
		let execId = null as string | null;
		let sid = null as number | null;
		let markerSeen = false;
		let ended = false;
		let killing: Promise<void> = Promise.resolve();
		let resolveMarker!: (seen: boolean) => void;
		const marker = new Promise<boolean>((resolve) => resolveMarker = resolve);
		const diagnostics = new OutputCapture(DIAGNOSTICS_BYTES);
		const timers: ReturnType<typeof setTimeout>[] = [];
		let pump: Promise<void> = Promise.resolve();
		const stop = (why: string): void => {
			if (killed !== null || ended) return;
			killed = why;
			killing = (async () => {
				if (!markerSeen) await marker;
				if (sid !== null && !ended) {
					await this.#direct(box, KILL_SCRIPT, () => [String(sid)]).catch((error) =>
						this.deps.log('warn', 'docker.kill_failed', { runId: box.runId, error: describe(error) })
					);
				}
				// Docker ends the stream once the wrapper exits; one held open past that is closed here.
				if (!ended) timers.push(setTimeout(() => stream?.close(), DRAIN_GRACE_MS));
			})();
		};
		const onAbort = (): void => stop('cancelled');
		try {
			await box.starting.run(async () => {
				execId = await this.#createExec(box, body);
				stream = await this.deps.engine.startExec(execId);
				const attached = stream;
				pump = (async () => {
					let pending = '';
					for (;;) {
						const frame = await attached.next();
						if (frame === null) return;
						if (frame.stream === 1) {
							if (run.onOutput(frame.data) === false) stop('output');
							continue;
						}
						if (markerSeen) {
							diagnostics.push(frame.data);
							continue;
						}
						pending += decoder.decode(frame.data, { stream: true });
						const ready = READY_LINE.exec(pending);
						if (ready) {
							sid = Number(ready[2]);
							box.live.set(key, { pid: Number(ready[1]), sid });
							markerSeen = true;
							resolveMarker(true);
							const rest = pending.replace(ready[0], '').trim();
							if (rest) diagnostics.push(encoder.encode(rest));
							pending = '';
						} else if (pending.length > DIAGNOSTICS_BYTES) {
							diagnostics.push(encoder.encode(pending));
							pending = '';
						}
					}
				})().catch((error) => {
					diagnostics.push(encoder.encode(`stream: ${describe(error)}`));
				}).finally(() => {
					ended = true;
					resolveMarker(markerSeen);
				});
				let startTimer: ReturnType<typeof setTimeout> | undefined;
				const seen = await Promise.race([
					marker,
					new Promise<boolean>((resolve) => startTimer = setTimeout(() => resolve(false), START_MS)),
				]);
				clearTimeout(startTimer);
				if (!seen && !ended) attached.close();
			});
			if (stream === null) throw new EngineError(502, 'Docker gave no exec stream');
			const target = stream;
			if (work.input !== undefined) work.input.attach(target);
			else if (attach) {
				const bytes = work.stdin!;
				// Written beside the output: a command that does not read its input must not hold the run up.
				void (async () => {
					try {
						await target.write(bytes);
						await target.closeWrite();
					} catch {
						// The work ended first.
					}
				})();
			}
			timers.push(setTimeout(() => stop('timeout'), run.timeoutMs));
			run.signal?.addEventListener('abort', onAbort, { once: true });
			if (run.signal?.aborted) onAbort();
			let polling = false;
			const poll = run.watchdog
				? setInterval(() => {
					if (polling || ended) return;
					polling = true;
					run.watchdog!.check().then((why) => why && stop(why)).catch(() => {}).finally(() => polling = false);
				}, run.watchdog.everyMs)
				: undefined;
			try {
				await pump;
			} finally {
				if (poll !== undefined) clearInterval(poll);
			}
			await killing;
			const exitCode = execId === null ? null : await this.#exitCode(execId);
			return {
				started: markerSeen,
				exitCode: killed === null ? exitCode : null,
				killed,
				durationMs: Math.round(performance.now() - began),
				diagnostics: diagnostics.result().output.trim(),
			};
		} catch (error) {
			throw this.#engineFailure(error, box.runId, 'exec');
		} finally {
			ended = true;
			resolveMarker(markerSeen);
			await killing;
			for (const timer of timers) clearTimeout(timer);
			run.signal?.removeEventListener('abort', onAbort);
			stream?.close();
			box.live.delete(key);
			box.active--;
			box.lastActive = Date.now();
		}
	}

	/** An exec's id; a container that stopped or went away meanwhile is started (or created) again, once. */
	async #createExec(box: Box, body: unknown): Promise<string> {
		try {
			if (box.id === null) throw new EngineError(404, 'no container');
			return await this.deps.engine.createExec(box.id, body);
		} catch (error) {
			if (!(error instanceof EngineError) || (error.status !== 409 && error.status !== 404)) throw error;
			await box.lifecycle.run(async () => {
				if (error.status === 404) box.id = null;
				box.running = false;
				await this.#ensure(box, true);
			});
			return await this.deps.engine.createExec(box.id!, body);
		}
	}

	/** The exit status Docker recorded once the exec's process ended; null when it never says. */
	async #exitCode(execId: string): Promise<number | null> {
		for (let attempt = 0; attempt < 25; attempt++) {
			const info = await this.deps.engine.inspectExec(execId).catch(() => null);
			if (info === null) return null;
			if (!info.running) return info.exitCode;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return null;
	}

	/** A kill or cleanup exec, run straight under the start lock; `args` is read inside it (the live execs then). */
	async #direct(box: Box, script: string, args: () => string[]): Promise<{ code: number | null; output: string }> {
		return await box.starting.run(async () => {
			if (box.id === null || !box.running) return { code: null, output: '' };
			const body = execBody({
				cmd: [script, 'harbour-sandbox', ...args()],
				env: { ...BASE_ENV },
				workdir: '/',
				stdin: false,
			});
			const id = await this.deps.engine.createExec(box.id, body);
			const stream = await this.deps.engine.startExec(id);
			const timer = setTimeout(() => stream.close(), DIRECT_MS);
			let output = '';
			try {
				for (;;) {
					const frame = await stream.next();
					if (frame === null) break;
					if (frame.stream === 1 && output.length < 4096) output += decoder.decode(frame.data);
				}
			} finally {
				clearTimeout(timer);
				stream.close();
			}
			return { code: await this.#exitCode(id), output };
		});
	}

	/**
	 * After a command or a session, nothing it started survives it: the cleanup spares only the execs still running,
	 * and when it cannot prove nothing else is left the container is stopped instead.
	 */
	async #cleanup(box: Box): Promise<void> {
		if (box.id === null || !box.running) return;
		try {
			const { code, output } = await this.#direct(box, CLEANUP_SCRIPT, () => {
				const live = [...box.live.values()];
				return [live.map((l) => l.pid).join(' '), live.map((l) => l.sid).join(' ')];
			});
			if (code !== 0) throw new Error(`the cleanup exited with ${code}`);
			const killed = Number(output.trim());
			if (killed > 0) this.deps.log('info', 'docker.cleanup', { runId: box.runId, killed });
		} catch (error) {
			this.deps.log('warn', 'docker.cleanup_failed', { runId: box.runId, error: describe(error) });
			await this.#stop(box).catch((stopError) =>
				this.deps.log('error', 'docker.stop_failed', { runId: box.runId, error: describe(stopError) })
			);
		}
	}

	/** Bytes `paths` take, walked with the container paused, under the start lock. Throws when it cannot measure. */
	async #measure(box: Box, paths: readonly string[], signal?: AbortSignal): Promise<number> {
		return await box.starting.run(async () => {
			signal?.throwIfAborted();
			box.active++;
			let frozen: string | null = null;
			try {
				frozen = await this.#freeze(box);
				return await (this.deps.measure ?? treeUsage)(paths, {
					timeoutMs: LIMITS.choreTimeoutMs,
					signal,
					repair: true,
				});
			} finally {
				if (frozen !== null) await this.#thaw(box, frozen);
				box.active--;
				box.lastActive = Date.now();
			}
		});
	}

	/** A measurement that fails is taken as just past `limit`: the command may only clean up. */
	async #measureBefore(box: Box, limit: number, signal?: AbortSignal): Promise<number> {
		try {
			return await this.#measure(box, this.#runDirs(box.runId), signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			this.deps.log('warn', 'docker.measure_failed', { runId: box.runId, error: describe(error) });
			return Math.max(limit, 0) + 1;
		}
	}

	/** Pauses the container when it runs, and says which one it paused. */
	async #freeze(box: Box): Promise<string | null> {
		const id = box.id;
		if (id === null || !box.running) return null;
		try {
			await this.deps.engine.pauseContainer(id);
			return id;
		} catch (error) {
			if (!(error instanceof EngineError) || (error.status !== 404 && error.status !== 409)) throw error;
			// Stopped or removed behind this service's back, or left paused: ask what it is now.
			const info = await this.deps.engine.inspectContainer(id);
			if (info === null || !info.running) {
				if (info === null) box.id = null;
				box.running = false;
				return null;
			}
			if (info.paused) return id;
			throw error;
		}
	}

	/** Unpauses after a measurement; a container that cannot be unpaused is stopped, never left frozen. */
	async #thaw(box: Box, id: string): Promise<void> {
		try {
			await this.deps.engine.unpauseContainer(id);
		} catch (error) {
			this.deps.log('error', 'docker.unpause_failed', { runId: box.runId, error: describe(error) });
			try {
				await this.deps.engine.stopContainer(id);
			} catch (stopError) {
				this.deps.log('error', 'docker.stop_failed', { runId: box.runId, error: describe(stopError) });
			}
			box.running = false;
		}
	}

	/** The registry proxy (or a clone step's own egress) on the socket the container sees as PROXY_SOCKET. */
	async #openProxy(box: Box, egress?: OpenEgress): Promise<ProxyHandle> {
		if (box.proxy) throw proxyBusy();
		box.proxy = true;
		const path = this.#proxyPath(box.runId);
		try {
			await Deno.remove(path).catch(() => {});
			if (egress !== undefined) return egress(path, this.deps.proxy, box.runId);
			return (this.deps.openProxy ?? ((at, runId) => RegistryProxy.open(at, this.deps.proxy, runId)))(path, box.runId);
		} catch (error) {
			box.proxy = false;
			throw error;
		}
	}

	async #closeProxy(box: Box, proxy: ProxyHandle | null): Promise<void> {
		if (proxy === null) return;
		try {
			await proxy.close();
		} finally {
			await Deno.remove(this.#proxyPath(box.runId)).catch(() => {});
			box.proxy = false;
		}
	}

	#proxyPath(runId: string): string {
		return `${this.config.sockDir}/${runId}/${PROXY_SOCKET.slice(HARBOUR_DIR.length + 1)}`;
	}

	/** What a client may hear of an Engine failure; the daemon's own words are only logged. */
	#engineFailure(error: unknown, runId: string, step: string): unknown {
		if (error instanceof BodyRefused) {
			this.deps.log('error', 'docker.body_refused', { runId, step, field: error.field });
			return new ApiError(400, 'invalid_request', 'The sandbox refused to send this request to Docker.');
		}
		if (error instanceof EngineError) {
			this.deps.log('error', 'docker.engine_failed', { runId, step, status: error.status, error: error.message });
			return new ApiError(503, 'cage_failed', 'The sandbox could not run this in its container.');
		}
		return error;
	}
}

const proxyBusy = (): ApiError =>
	new ApiError(409, 'run_busy', "This workspace's registry proxy is in use by its other command or session.");

/** Why the start-up check could not run, for the service's own log and exit (never a client). */
function describeStartup(error: unknown): string {
	if (error instanceof DOMException && error.name === 'TimeoutError') return 'it did not finish in time';
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a container found by name is the one this service would create for `target`: every label (the body's
 * hash among them), the image by tag and id, not paused, and the invariants and mounts compared once more.
 */
function matches(found: ContainerInfo, target: CreateFor, imageId: string | null): boolean {
	const expected = containerBody(target);
	const labels = Object.entries(expected.Labels).every(([key, value]) => found.labels[key] === value);
	const mounts = found.mounts.map((mount) => {
		const m = (mount ?? {}) as Record<string, unknown>;
		const options = (m.VolumeOptions ?? {}) as Record<string, unknown>;
		return {
			Type: m.Type,
			Source: m.Source,
			Target: m.Target,
			ReadOnly: m.ReadOnly === true,
			VolumeOptions: { NoCopy: options.NoCopy === true, Subpath: options.Subpath ?? '' },
		};
	});
	return found.image === expected.Image && (imageId === null || found.imageId === imageId) && !found.paused &&
		labels && !found.privileged && found.networkMode === 'none' && sameJson(mounts, expected.HostConfig.Mounts);
}

/** Gives the owner rwx back on every directory under `path`, never following a link. */
async function restoreAccess(path: string): Promise<void> {
	let info: Deno.FileInfo;
	try {
		info = await Deno.lstat(path);
	} catch {
		return;
	}
	if (!info.isDirectory || info.isSymlink) return;
	if (info.mode !== null && (info.mode & 0o700) !== 0o700) await Deno.chmod(path, (info.mode & 0o7777) | 0o700);
	for await (const entry of Deno.readDir(path)) {
		if (entry.isDirectory && !entry.isSymlink) await restoreAccess(`${path}/${entry.name}`);
	}
}
