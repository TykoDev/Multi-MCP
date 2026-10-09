/**
 * D-108 (design §2.13, G9): the Docker workspace backend. Opt-in (`TTK_SANDBOX_BACKEND=docker`, the
 * docker-compose.sandbox-docker.yml overlay); the bubblewrap backend (sandbox.ts) stays the default and the reference
 * for what every operation means: the same paths, LIMITS, results and errors.
 *
 * One long-lived container per workspace (docker_spec.ts has its body), created with the workspace, started on
 * demand, stopped after LIMITS.containerIdleMs with nothing running, removed with the workspace. Each command, live
 * session and housekeeping script (du, the diff, a caged file operation) is an exec into it, started through the
 * wrapper that gives the work a session of its own:
 *
 * - a time limit, a cancelled request or the disk watchdog kills that session's process group by a second exec
 *   (an exec cannot be killed through the API);
 * - N3: after every command, and when a session ends, a cleanup exec kills every process in the container but
 *   Docker's init, `sleep infinity` and the work of execs still running — what a cage's pid namespace took with it;
 * - starts and cleanups are serialized per container, so a cleanup never meets a half-started exec.
 *
 * Mounts are named-volume subpaths the daemon resolves. The service holds the same two volumes: the code volume at
 * its work folder (/work), the socket volume at its socket folder. A registries-mode exec gets the registry proxy's
 * socket in its workspace's socket folder, seen in the container as /run/harbour/proxy.sock, for as long as it runs
 * (N3): the container has no network interface, and socat inside it turns the socket into 127.0.0.1:3128, as in a
 * cage. One registries-mode exec per workspace at a time: the forwarder's port is the container's.
 *
 * ERRATUM(E-87): where the design asks for bwrap's semantics, these differ, all inside one workspace and one owner:
 * a command and an open session share the container's processes, loopback and `/tmp` (the create body's 256 MiB
 * tmpfs, not on the volume and so not in the disk budget, and not emptied between commands); one registries-mode
 * exec runs per workspace at a time (409 `run_busy`); a session's background process that made a session of its own
 * is killed when a command ends; no `ulimit -p` (without a user namespace it would count every uid-1993 process on
 * the host; `PidsLimit` bounds the container instead); the diff stages in the workspace's home, on the volume, where
 * bwrap's /tmp is; and disk use is measured by the service itself, not by du in a cage (below).
 *
 * SB-1 (review R2-2): a measurement inside the container ran in the same pid namespace as the workspace's own
 * processes, which could make a directory unreadable between the measurer's repair and du (du then skipped it, and its
 * exit status was ignored). So the service measures its own view of the volume (/work/<id> and the home), with the
 * container paused (`POST /containers/{id}/pause`, E-91) so nothing of the workspace runs meanwhile, giving locked
 * directories their owner's read and search back first, and following no link (disk.ts `treeUsage`). A measurement
 * that fails is taken as over budget: the command may only clean up (SB-7), a watched one is stopped.
 *
 * Deployments (review R2-5): containers are named `ttk-sandbox-<deployment>-<id>` and labelled with the deployment,
 * {@linkcode deploymentId} of the code volume, and reconciliation touches this deployment's containers only. Two
 * deployments must not share a code volume: they would share every workspace, owner record and container.
 */
import { BASE_ENV, CAGE_HOME, type CageResult, PROXY_SOCKET, proxyEnv, WORKSPACE } from './cage.ts';
import { CAGED_FILE_BYTES, type CagedFileOp, cagedResult, cagedScript, EXIT } from './caged_files.ts';
import { type DiffResult, diffScript, fitDiff, parseDiff } from './diff.ts';
import { DiskWatches, treeUsage, type TreeUsageOptions } from './disk.ts';
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
import { Gate, GateError, Runs } from './gate.ts';
import { LIMITS } from './limits.ts';
import { OutputCapture } from './output.ts';
import { type OpenEgress, type ProxyDeps, type ProxyHandle, RegistryProxy } from './proxy.ts';
import { type ExecRequest, RequestError, RUN_ID } from './request.ts';
import {
	ApiError,
	checkCwd,
	type DiskQuota,
	type ExecResult,
	gitDirectory,
	isDirectory,
	mb,
	type SandboxLimits,
} from './sandbox.ts';
import { type SessionRead, SessionState } from './sessions.ts';

/** A registry proxy as the backend uses it; `RegistryProxy` in production (proxy.ts, shared with the clone step). */
export type { ProxyHandle };

export interface DockerSandboxConfig {
	/** The code volume, as this service holds it (/work). */
	workDir: string;
	/** The socket volume, as this service holds it. */
	sockDir: string;
	policy: DockerPolicy;
	limits?: Partial<SandboxLimits>;
	/** How long the start-up volume check may take in all; LIMITS.choreTimeoutMs unless a test names less. */
	checkTimeoutMs?: number;
}

export interface DockerSandboxDeps {
	engine: Engine;
	log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void;
	proxy: ProxyDeps;
	/** Bytes free on the filesystem holding `path`. */
	freeBytes(path: string): Promise<number>;
	/** Opens the registry proxy on a unix socket; RegistryProxy.open unless a test names another. */
	openProxy?(path: string, runId: string): ProxyHandle;
	/** Measures folders as the service sees them (R2-2); disk.ts `treeUsage` unless a test names another. */
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
	/** Execs in flight, of any kind. */
	active = 0;
	/** A registries-mode exec holds the proxy socket. */
	proxy = false;
	/** The wrapper pid and work session of every exec running now: what a cleanup spares. */
	readonly live = new Map<number, { pid: number; sid: number }>();
	/** Create, start, stop and remove. */
	readonly lifecycle = new Mutex();
	/** Exec starts, kills and cleanups (N3). */
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
	/** Added to BASE_ENV. */
	env?: Record<string, string>;
	workdir?: string;
	/** Written to the work's standard input, which is then closed. */
	stdin?: Uint8Array | null;
	/** A live session's input. */
	input?: SessionInput;
	proxy?: boolean;
	noGrowth?: boolean;
}

interface RunOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	onOutput(chunk: Uint8Array): boolean | void;
	watchdog?: { everyMs: number; check(): Promise<string | null> };
}

export class DockerSandbox {
	/** D-108: which backend this is, as `/healthz` reports it. */
	readonly kind = 'docker' as const;
	readonly gate = new Gate();
	readonly chores = new Gate(LIMITS.choreRunning, LIMITS.choreWaiting, LIMITS.choreTimeoutMs);
	readonly runs = new Runs();
	/** Live sessions, counted apart from commands (D-076). */
	readonly sessionGate = new Gate(LIMITS.sessionsRunning, 0, 0);
	readonly limits: SandboxLimits;
	readonly #watches: DiskWatches;
	readonly #boxes = new Map<string, Box>();
	/** Workspace → owner hash, for the container's labels: from the owner records, and from `assign` on create. */
	readonly #owners = new Map<string, string>();
	readonly #sessions = new Map<string, SessionState>();
	readonly #sessionsByRun = new Map<string, SessionState>();
	readonly #sessionStops = new Map<string, (why: string) => void>();
	readonly #sessionInputs = new Map<string, SessionInput>();
	#probe: { at: number; error: string | null } | null = null;
	#probing: Promise<string | null> | null = null;
	#idle: ReturnType<typeof setInterval> | undefined;
	#sweeping = false;
	/** R2-5: this deployment's id, from the code volume's name; set by `start`. */
	#deployment: string | null = null;
	/** R2-6: the image id the configured tag pointed at when the service started (its check container's). */
	#imageId: string | null = null;
	#execs = 0;

	constructor(readonly config: DockerSandboxConfig, readonly deps: DockerSandboxDeps) {
		this.limits = {
			diskBudgetBytes: LIMITS.diskBudgetBytes,
			diskPollMs: LIMITS.diskPollMs,
			diskNoiseBytes: LIMITS.diskNoiseBytes,
			diskTriggerBytes: LIMITS.diskTriggerBytes,
			...config.limits,
		};
		this.#watches = new DiskWatches({
			free: () => this.deps.freeBytes(this.config.workDir),
			minFreeBytes: LIMITS.minFreeBytes,
			noiseBytes: this.limits.diskNoiseBytes,
			triggerBytes: this.limits.diskTriggerBytes,
		});
	}

	/**
	 * Start-up: the daemon answers at API 1.45 or later, both named volumes exist, and a container of the workspace
	 * image sees the configured code volume as the one this service holds at its work folder (R2-5); then idle
	 * containers are stopped every minute. Throws, naming what is missing, so a misconfigured service never reports
	 * healthy (main.ts exits, and Docker's restart policy tries again).
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
	 * Startup reconciliation, with every workspace's owner from its record: a container of this deployment (the
	 * sandbox label, this deployment's code volume, and its deployment label — R2-5) whose workspace has no record, or
	 * another owner, is removed; so is one from before deployments were labelled, which no name of this service would
	 * find again; a running (or paused) one is stopped, since no session survives a restart. Containers of another
	 * deployment on the same daemon are left as they are.
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

	/** Records a new workspace's owner before its first command (create). */
	assign(runId: string, owner: string): void {
		this.#owners.set(runId, owner);
	}

	// --- commands --------------------------------------------------------------------------------------------

	exec(req: ExecRequest, signal?: AbortSignal, quota?: DiskQuota): Promise<ExecResult> {
		return this.runs.hold(req.runId, signal, async (held) => {
			const checkout = this.#checkout(req.runId);
			if (!(await isDirectory(checkout))) {
				throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
			}
			await checkCwd(checkout, req.cwd);
			const release = await this.gate.enter(held);
			try {
				const box = await this.#ready(req.runId);
				if (req.network !== 'none' && box.proxy) throw proxyBusy();
				await this.#checkFreeSpace();
				const { limit, ceiling } = quota ?? this.#defaultQuota();
				const before = await this.#measureBefore(box, limit, held);
				// SB-7, as bwrap: over the budget a command may only clean up; past the ceiling nothing runs, and the
				// container is stopped so nothing left in it keeps writing.
				const cleanupOnly = before > limit;
				if (cleanupOnly && before > ceiling) {
					await this.#stop(box).catch(() => {});
					throw new ApiError(
						507,
						'over_budget',
						`This run's files take ${mb(before)} MB, too far over its ${
							mb(Math.max(0, limit))
						} MB budget to run anything. Remove the workspace.`,
					);
				}
				const capture = new OutputCapture();
				const watch = await this.#watches.start({
					before,
					limit: cleanupOnly ? before : limit,
					measure: (stop) => this.#measure(box, this.#runDirs(box.runId), stop),
				});
				let proxy: ProxyHandle | null = null;
				let result: CageResult;
				try {
					// R12: a clone's step (`git`) brings its own egress: the git-host proxy or the forwarder.
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
						noGrowth: cleanupOnly,
					}, {
						timeoutMs: req.timeoutMs,
						signal: held,
						onOutput: (chunk) => capture.push(chunk),
						watchdog: { everyMs: this.limits.diskPollMs, check: () => watch.check() },
					});
				} finally {
					await watch.end();
					await this.#closeProxy(box, proxy);
					await this.#cleanup(box);
				}
				if (!result.started) {
					this.deps.log('error', 'cage.failed', { runId: req.runId, diagnostics: result.diagnostics });
					throw new ApiError(
						503,
						'cage_failed',
						`The sandbox could not start a command: ${result.diagnostics || 'no reason given'}`,
					);
				}
				// SB-10: not cancelled with the request; when it cannot be measured, the worst is assumed.
				const after = await this.#measure(box, this.#runDirs(box.runId)).catch(() => Math.max(before, limit));
				await this.#settle(box);
				const out = capture.result();
				const reply: ExecResult = {
					exitCode: result.exitCode,
					timedOut: result.killed === 'timeout',
					killed: result.killed,
					durationMs: result.durationMs,
					...out,
					diskBytes: after,
					diskBudgetBytes: Math.max(0, limit),
					overBudget: after > limit,
					cleanupOnly,
					reachedHosts: [...(proxy?.reached ?? [])],
					refusedHosts: [...(proxy?.refused ?? [])],
				};
				this.deps.log('info', 'exec.done', {
					runId: req.runId,
					backend: 'docker',
					network: req.network,
					exitCode: reply.exitCode,
					killed: reply.killed,
					diskStop: watch.verdict,
					durationMs: reply.durationMs,
					outputBytes: reply.outputBytes,
					diskBytes: reply.diskBytes,
					cleanupOnly,
					refusedHosts: reply.refusedHosts,
				});
				return reply;
			} finally {
				release();
			}
		});
	}

	// --- live sessions (D-076) -------------------------------------------------------------------------------

	sessionOf(runId: string): SessionState | null {
		return this.#sessionsByRun.get(runId) ?? null;
	}

	#session(owner: string, sessionId: string): SessionState {
		const session = this.#sessions.get(sessionId);
		if (session === undefined || session.owner !== owner) throw new ApiError(404, 'no_session', 'No such session.');
		return session;
	}

	/** A shell exec reading its standard input, ended as bwrap's session cage is (close, idle, lifetime, disk...). */
	async openSession(
		owner: string,
		req: { runId: string; network: 'none' | 'registries' },
		quota?: DiskQuota,
	): Promise<{ session_id: string; created_at: string }> {
		this.#pruneEnded();
		if (this.#sessionsByRun.has(req.runId)) {
			throw new ApiError(409, 'session_open', 'This workspace already has an open session.');
		}
		if (!(await isDirectory(this.#checkout(req.runId)))) {
			throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
		}
		const release = await this.sessionGate.enter();
		const session = new SessionState(req.runId, owner);
		this.#sessions.set(session.id, session);
		this.#sessionsByRun.set(req.runId, session);
		try {
			const box = await this.#ready(req.runId);
			if (req.network === 'registries' && box.proxy) throw proxyBusy();
			await this.#checkFreeSpace();
			const { limit, ceiling } = quota ?? this.#defaultQuota();
			const before = await this.#measureBefore(box, limit);
			if (before > ceiling) {
				throw new ApiError(507, 'over_budget', 'This run is too far over its disk budget to open a session.');
			}
			const watch = await this.#watches.start({
				before,
				limit: before > limit ? before : limit,
				measure: (stop) => this.#measure(box, this.#runDirs(box.runId), stop),
			});
			let proxy: ProxyHandle | null = null;
			try {
				if (req.network === 'registries') proxy = await this.#openProxy(box);
			} catch (error) {
				await watch.end();
				throw error;
			}
			const controller = new AbortController();
			let stopReason = '';
			this.#sessionStops.set(session.id, (why) => {
				stopReason = why;
				controller.abort();
			});
			const input = new SessionInput();
			this.#sessionInputs.set(session.id, input);
			const idle = setInterval(() => {
				if (session.idleMs > LIMITS.sessionIdleMs) this.#sessionStops.get(session.id)?.('idle');
				else if (session.ageMs > LIMITS.sessionLifetimeMs) this.#sessionStops.get(session.id)?.('lifetime');
			}, 5_000);
			void this.#run(box, {
				body: SESSION_BODY,
				env: proxy ? proxyEnv() : {},
				input,
				proxy: proxy !== null,
				noGrowth: before > limit,
			}, {
				timeoutMs: LIMITS.sessionLifetimeMs + 60_000,
				signal: controller.signal,
				onOutput: (chunk) => session.push(chunk),
				watchdog: { everyMs: this.limits.diskPollMs, check: () => watch.check() },
			}).then(
				(result) => {
					if (!result.started) {
						session.push(encoder.encode(`the sandbox could not start a shell: ${result.diagnostics}\n`));
						session.end(null, 'cage_failed');
					} else session.end(result.exitCode, result.killed === 'cancelled' ? stopReason || 'closed' : result.killed);
				},
				() => session.end(null, 'internal'),
			).finally(async () => {
				clearInterval(idle);
				this.#sessionStops.delete(session.id);
				this.#sessionsByRun.delete(req.runId);
				this.#sessionInputs.delete(session.id);
				input.close();
				release();
				await watch.end();
				await this.#closeProxy(box, proxy);
				await this.#cleanup(box);
				this.deps.log('info', 'session.ended', { runId: req.runId, sessionId: session.id });
				session.lastActivity = Date.now();
			});
			this.deps.log('info', 'session.opened', { runId: req.runId, sessionId: session.id, network: req.network });
			return { session_id: session.id, created_at: new Date(session.createdAt).toISOString() };
		} catch (cause) {
			this.#sessions.delete(session.id);
			this.#sessionsByRun.delete(req.runId);
			release();
			throw cause;
		}
	}

	sessionInput(owner: string, sessionId: string, data: string): Promise<{ accepted: true }> {
		const session = this.#session(owner, sessionId);
		if (session.ended) throw new ApiError(409, 'session_ended', 'The session has ended.');
		const bytes = encoder.encode(data);
		if (bytes.length > LIMITS.sessionInputBytes) throw new RequestError('data', 'is over 16 KiB');
		if (!session.countInput(bytes.length, LIMITS.sessionInputBytes * 256)) {
			this.#sessionStops.get(sessionId)?.('input_limit');
			throw new ApiError(409, 'session_ended', 'The session took too much input and was closed.');
		}
		const input = this.#sessionInputs.get(sessionId);
		if (input === undefined || !input.push(bytes)) throw new ApiError(409, 'session_ended', 'The session has ended.');
		return Promise.resolve({ accepted: true });
	}

	async sessionRead(owner: string, sessionId: string, after: number, waitMs: number): Promise<SessionRead> {
		this.#pruneEnded();
		const session = this.#session(owner, sessionId);
		session.lastActivity = Date.now();
		return await session.read(after, waitMs);
	}

	sessionClose(owner: string, sessionId: string): { closed: true } {
		const session = this.#session(owner, sessionId);
		this.#sessionStops.get(sessionId)?.('closed');
		this.#sessionInputs.get(sessionId)?.close();
		this.#sessionInputs.delete(sessionId);
		if (session.ended) this.#sessions.delete(sessionId);
		return { closed: true };
	}

	#pruneEnded(): void {
		const now = Date.now();
		for (const [id, session] of this.#sessions) {
			if (session.ended && now - session.lastActivity > 60_000) this.#sessions.delete(id);
		}
	}

	#closeSessionsOf(runId: string): void {
		const session = this.#sessionsByRun.get(runId);
		if (session === undefined) return;
		this.#sessionStops.get(session.id)?.('removed');
		this.#sessionInputs.get(session.id)?.close();
		this.#sessionInputs.delete(session.id);
	}

	// --- diff, files, disk, removal, health ------------------------------------------------------------------

	diff(runId: string, signal?: AbortSignal): Promise<DiffResult> {
		return this.runs.hold(runId, signal, async (held) => {
			const checkout = this.#checkout(runId);
			if (!(await isDirectory(checkout))) {
				throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
			}
			if (!(await gitDirectory(checkout))) {
				throw new ApiError(409, 'no_repository', "This run's checkout has no .git directory.");
			}
			const release = await this.gate.enter(held);
			try {
				const box = await this.#ready(runId);
				await this.#checkFreeSpace();
				let attempt = await this.#diffOnce(box, held);
				if (attempt.failed && /permission denied/i.test(attempt.said)) {
					await this.#run(box, { body: REPAIR_BODY }, {
						timeoutMs: LIMITS.choreTimeoutMs,
						signal: held,
						onOutput: () => {},
					});
					held.throwIfAborted();
					attempt = await this.#diffOnce(box, held);
				}
				if (attempt.failed) throw new ApiError(500, 'diff_failed', `git could not diff the checkout: ${attempt.said}`);
				return fitDiff(attempt.result!, LIMITS.responseBytes);
			} finally {
				release();
			}
		});
	}

	async #diffOnce(box: Box, signal: AbortSignal) {
		const limit = LIMITS.patchBytes * 2;
		const chunks: Uint8Array[] = [];
		let size = 0;
		// SB-1: the staged blobs may take one budget's worth on top of the run's files, and go after the diff.
		const watch = await this.#watches.start({
			before: 0,
			limit: this.limits.diskBudgetBytes,
			// The scratch as the service holds it: the container's DOCKER_DIFF_SCRATCH, under the home.
			measure: (stop) =>
				this.#measure(box, [this.#home(box.runId) + DOCKER_DIFF_SCRATCH.slice(CAGE_HOME.length)], stop),
		});
		let result: CageResult;
		try {
			result = await this.#run(box, {
				body: `trap 'rm -rf ${DOCKER_DIFF_SCRATCH}' EXIT\n${diffScript(DOCKER_DIFF_SCRATCH)}`,
			}, {
				timeoutMs: LIMITS.diffTimeoutMs,
				signal,
				onOutput: (chunk) => {
					if (size >= limit) return false;
					chunks.push(chunk);
					size += chunk.length;
					return size < limit;
				},
				watchdog: { everyMs: this.limits.diskPollMs, check: () => watch.check() },
			});
		} finally {
			await watch.end();
		}
		const bytes = join(chunks, size);
		if (!result.started) {
			throw new ApiError(
				503,
				'cage_failed',
				`The sandbox could not start a cage: ${result.diagnostics || 'no reason given'}`,
			);
		}
		if (result.killed === 'disk') {
			throw watch.verdict === 'floor'
				? new ApiError(507, 'disk_full', 'The server ran low on disk during the diff.')
				: new ApiError(507, 'over_budget', "The diff needed more scratch space than the run's budget allows.");
		}
		if (result.killed === 'timeout' || result.killed === 'cancelled') {
			throw new ApiError(504, 'diff_timeout', 'The diff took too long and was stopped.');
		}
		const cut = result.killed === 'output';
		if (!cut && result.exitCode !== 0) {
			const said = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 2000)));
			return { failed: true, said: said.trim() || `exit ${result.exitCode}`, result: null };
		}
		return { failed: false, said: '', result: parseDiff(bytes, !cut) };
	}

	/** D-077: a file operation for a workspace with a live session, run inside its container (caged_files.ts). */
	fileOp(runId: string, op: CagedFileOp, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.runs.hold(runId, signal, async (held) => {
			if (!(await isDirectory(this.#checkout(runId)))) {
				throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
			}
			const release = await this.chores.enter(held);
			try {
				const box = await this.#ready(runId);
				const chunks: Uint8Array[] = [];
				let size = 0;
				const limit = CAGED_FILE_BYTES + 64 * 1024;
				const result = await this.#run(box, {
					body: cagedScript(op.kind),
					env: { TTK_PATH: op.path },
					stdin: op.kind === 'write' ? encoder.encode(op.content) : null,
				}, {
					timeoutMs: LIMITS.choreTimeoutMs,
					signal: held,
					onOutput: (chunk) => {
						if (size >= limit) return false;
						chunks.push(chunk);
						size += chunk.length;
						return size < limit;
					},
				});
				if (!result.started) {
					throw new ApiError(
						503,
						'cage_failed',
						`The sandbox could not start a cage: ${result.diagnostics || 'no reason given'}`,
					);
				}
				if (result.killed === 'cancelled') held.throwIfAborted();
				if (result.killed === 'timeout') throw new ApiError(504, 'file_timeout', 'The file operation took too long.');
				return cagedResult(op, result.killed === 'output' ? EXIT.tooLarge : result.exitCode, join(chunks, size));
			} finally {
				release();
			}
		});
	}

	/**
	 * Bytes the workspace's files take (checkout and home), measured by the service with the container paused if it
	 * runs (R2-2); for callers without a slot. Needs no container: one that is stopped has nothing running in it.
	 */
	async diskUsage(runId: string, signal?: AbortSignal): Promise<number> {
		const release = await this.chores.enter(signal);
		try {
			return await this.#measure(this.#box(runId), this.#runDirs(runId), signal);
		} finally {
			release();
		}
	}

	/**
	 * Removes the workspace's container (a session in it ends with it) and its state, and gives the owner write
	 * access back throughout its checkout, so the workspace service's own removal of it cannot fail on a folder a
	 * command made read-only. Nothing runs in the workspace any more by then, so the walk follows no link.
	 */
	remove(runId: string): Promise<{ removed: boolean }> {
		return this.runs.removing(runId, async () => {
			this.#closeSessionsOf(runId);
			const box = this.#boxes.get(runId) ?? new Box(runId);
			await box.lifecycle.run(async () => {
				try {
					const id = box.id ??
						(await this.deps.engine.inspectContainer(containerName(this.#scope, runId)))?.id ?? null;
					if (id) await this.deps.engine.removeContainer(id);
				} catch (error) {
					throw this.#engineFailure(error, runId, 'remove');
				}
				box.id = null;
				box.running = false;
			});
			this.#boxes.delete(runId);
			await restoreAccess(this.#checkout(runId));
			const removed = await removeTree(`${this.config.workDir}/.sandbox/${runId}`);
			await removeTree(`${this.config.sockDir}/${runId}`);
			this.#owners.delete(runId);
			this.deps.log('info', 'run.removed', { runId, removed, backend: 'docker' });
			return { removed };
		});
	}

	/** The daemon answers and both volumes exist; cached for half a minute, one probe at a time (SB-3). */
	async health(): Promise<{ ok: boolean; error: string | null }> {
		if (this.#probe && Date.now() - this.#probe.at < 30_000) {
			return { ok: this.#probe.error === null, error: this.#probe.error };
		}
		this.#probing ??= this.#runProbe().finally(() => this.#probing = null);
		const error = await this.#probing;
		return { ok: error === null, error };
	}

	async #runProbe(): Promise<string | null> {
		let error: string | null = null;
		try {
			await this.deps.engine.ping();
			for (const name of [this.config.policy.volume, this.config.policy.sockVolume]) {
				if (!(await this.deps.engine.volumeExists(name))) error ??= `the Docker volume ${name} is gone`;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		this.#probe = { at: Date.now(), error };
		return error;
	}

	// --- containers -------------------------------------------------------------------------------------------

	#checkout(runId: string): string {
		return `${this.config.workDir}/${runId}`;
	}

	/** The workspace's home, as the service holds it (the container's /home/sandbox). */
	#home(runId: string): string {
		return `${this.config.workDir}/.sandbox/${runId}/home`;
	}

	/** What the disk budget counts (SB-1): the checkout, its .git included, and the home. */
	#runDirs(runId: string): string[] {
		return [this.#checkout(runId), this.#home(runId)];
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
	 * Makes sure the container exists with the mounts the checkout needs now, and (with `start`) runs. A container
	 * found by name after a restart is kept only when it is what this service would create — the same body, by its
	 * hash label, from the same image, not left paused (R2-6); otherwise it is replaced, which loses nothing, since a
	 * workspace's files are on the volume. Every folder a subpath names must exist first, and be a real directory.
	 */
	async #ensure(box: Box, start: boolean): Promise<void> {
		const runId = box.runId;
		const checkout = this.#checkout(runId);
		if (!(await isDirectory(checkout))) {
			throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
		}
		const git = (await gitDirectory(checkout)) !== null;
		const owner = this.#owners.get(runId);
		if (owner === undefined) throw new ApiError(503, 'cage_failed', 'The workspace has no owner on record.');
		for (const dir of [`${this.config.workDir}/.sandbox/${runId}/home`, `${this.config.sockDir}/${runId}`]) {
			await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
		}
		for (
			const dir of [
				`${this.config.workDir}/.sandbox`,
				`${this.config.workDir}/.sandbox/${runId}`,
				`${this.config.workDir}/.sandbox/${runId}/home`,
				`${this.config.sockDir}/${runId}`,
			]
		) {
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

	/**
	 * After provisioning: once the checkout has its `.git`, the container is replaced by one that mounts it
	 * read-only (and is started on demand), exactly as a cage mounts it from then on.
	 */
	async #settle(box: Box): Promise<void> {
		if (box.git || (await gitDirectory(this.#checkout(box.runId))) === null) return;
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

	/**
	 * Stops containers that ran nothing for LIMITS.containerIdleMs (as of `now`); the next operation starts them
	 * again. Run every minute from `start`.
	 */
	async stopIdle(now = Date.now()): Promise<void> {
		if (this.#sweeping) return;
		this.#sweeping = true;
		try {
			for (const box of [...this.#boxes.values()]) {
				if (!box.running || box.active > 0 || this.#sessionsByRun.has(box.runId)) continue;
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
	 * Start-up (R2-3, R2-5): the configured code volume is the one this service holds at its work folder, or the
	 * service does not start. Compose names volumes per project unless the overlay names them (N4), and a mismatch
	 * would otherwise show up as workspaces without their files.
	 *
	 * The proof is a nonce the service writes and a container of the workspace image reads back — a container of its
	 * own, for a fresh id no workspace has, whose folders the service has just created (each `mkdir` fails if the name
	 * exists). So the write never goes through a path any workspace can reach: the file is created with `createNew`
	 * (O_CREAT|O_EXCL, which follows no link and opens no FIFO) in a folder only this service knows. Bounded as a
	 * whole by `checkTimeoutMs`; it fails, never hangs, and nothing a workspace does can stall it. The check container
	 * and its folders are removed whatever happens (one a crash leaves has no owner record, so reconciliation removes
	 * it). The check also learns the image id the configured tag points at (R2-6).
	 */
	async #checkVolume(deployment: string): Promise<void> {
		const runId = crypto.randomUUID();
		const box = new Box(runId);
		const engine = this.deps.engine;
		const folders = [`${this.config.workDir}/${runId}`, `${this.config.workDir}/.sandbox/${runId}`];
		const sockFolder = `${this.config.sockDir}/${runId}`;
		const deadline = AbortSignal.timeout(this.config.checkTimeoutMs ?? LIMITS.choreTimeoutMs);
		let seen = '';
		let result: CageResult | null = null;
		try {
			await Deno.mkdir(`${this.config.workDir}/.sandbox`, { recursive: true, mode: 0o700 });
			for (const dir of [...folders, `${folders[1]}/home`, sockFolder]) await Deno.mkdir(dir, { mode: 0o700 });
			const nonce = crypto.randomUUID();
			const file = await Deno.open(`${this.#home(runId)}/${VOLUME_CHECK_FILE}`, {
				write: true,
				createNew: true,
				mode: 0o600,
			});
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
			for (const dir of [...folders, sockFolder]) await removeTree(dir).catch(() => {});
		}
	}

	// --- execs ------------------------------------------------------------------------------------------------

	/**
	 * Runs one piece of work in the container through the wrapper, and answers as `runCage` does: whether it
	 * started, its exit status (null when the sandbox stopped it), why it was stopped, and what the wrapper said.
	 */
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

	/**
	 * A kill or cleanup exec, run straight (no wrapper) under the start lock, so it neither races an exec's start
	 * nor meets another cleanup. `args` is read inside the lock: a cleanup's keep list is the execs live then.
	 */
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
	 * N3: after a command or a session, nothing it started survives it. The cleanup spares the execs still running
	 * (their wrappers and their sessions); when it cannot run, the container is stopped instead, which spares nothing.
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
			await this.#stop(box).catch(() => {});
		}
	}

	/**
	 * SB-1 (R2-2): bytes `paths` take, as this service sees them on the volume, with nothing of the workspace running:
	 * a running container is paused for the walk and unpaused after it. Held under the start lock, so no exec, kill or
	 * cleanup is started into the frozen container meanwhile (they wait their turn). Throws when it cannot measure.
	 */
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

	/**
	 * R2-2: a measurement that fails is taken as "over budget": just past `limit`, so the command may only clean up
	 * (SB-7) and its watch allows it no growth. Logged; a cancelled request still ends the call.
	 */
	async #measureBefore(box: Box, limit: number, signal?: AbortSignal): Promise<number> {
		try {
			return await this.#measure(box, this.#runDirs(box.runId), signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			this.deps.log('warn', 'docker.measure_failed', { runId: box.runId, error: describe(error) });
			return Math.max(limit, 0) + 1;
		}
	}

	/**
	 * Pauses the container when it runs, and says which one it paused. One that is not running has nothing of the
	 * workspace in it (every exec starts under the lock the caller holds), so it is measured as it is.
	 */
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

	/**
	 * The registry proxy on the workspace's socket folder, seen in the container as PROXY_SOCKET (N3) — or, for a clone's
	 * step (R12), the egress the workspace service built for it, on the same socket.
	 */
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

	#defaultQuota(): DiskQuota {
		return { limit: this.limits.diskBudgetBytes, ceiling: 2 * this.limits.diskBudgetBytes };
	}

	async #checkFreeSpace(): Promise<void> {
		const free = await this.deps.freeBytes(this.config.workDir);
		if (free < LIMITS.minFreeBytes) {
			throw new ApiError(
				507,
				'disk_full',
				`The server has ${mb(free)} MB of disk left; the sandbox needs ${
					mb(LIMITS.minFreeBytes)
				} MB free to run anything.`,
			);
		}
	}

	/**
	 * What a client may hear of an Engine failure: a refused body is `invalid_request` and an Engine error is
	 * `cage_failed`; the daemon's own words are only logged.
	 */
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

function describe(error: unknown): string {
	if (error instanceof GateError || error instanceof ApiError) return error.code;
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Why the start-up check could not run, for the service's own log and exit (never a client). */
function describeStartup(error: unknown): string {
	if (error instanceof DOMException && error.name === 'TimeoutError') return 'it did not finish in time';
	return error instanceof Error ? error.message : String(error);
}

function join(chunks: Uint8Array[], size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}

/**
 * Whether a container found by name is the one this service would create for `target`: every label — the body's
 * hash among them, so any field of the body that changed since (R2-6) — the image by tag and, once start-up has
 * resolved the tag, by id, not left paused, and the named invariants and mounts compared once more on their own.
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

/** Removes a folder, restoring access first when a command locked part of it; false when there was none. */
async function removeTree(path: string): Promise<boolean> {
	try {
		await Deno.remove(path, { recursive: true });
		return true;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return false;
		if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
	}
	await restoreAccess(path);
	await Deno.remove(path, { recursive: true });
	return true;
}

// Re-exported for the tests that read the container's own paths.
export { CAGE_HOME };
