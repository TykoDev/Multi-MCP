/**
 * The bubblewrap backend (the default), and `SandboxBase`, what it shares with the Docker backend (docker.ts). On the
 * work volume: `/work/<run id>/` is the checkout, and `/work/.sandbox/<run id>/{home,tmp}` the cage's HOME (package
 * caches) and /tmp (emptied before every command). Everything a cage writes is on the volume, not a tmpfs, and counts
 * toward the run's disk budget: measured by du in a cage before and after each command and watched while it runs.
 */
import { statfs } from '#sandbox-fs';
import {
	CAGE_HOME,
	cageArgs,
	type CageResult,
	type CageRun,
	type CageSpec,
	type Mount,
	PROXY_SOCKET,
	proxyEnv,
	runCage,
	SESSION_INPUT,
	STDIN_FILE,
	type System,
	WORKSPACE,
} from './cage.ts';
import { CAGED_OUTPUT_BYTES, type CagedFileOp, cagedResult, cagedScript } from './caged_files.ts';
import type { SandboxBackend } from './client.ts';
import { type DiffResult, diffScript, fitDiff, parseDiff } from './diff.ts';
import { type DiskWatch, DiskWatches } from './disk.ts';
import { Gate, GateError, ownerSessionsBusy, Runs } from './gate.ts';
import { LIMITS } from './limits.ts';
import { collect, type Output, OutputCapture } from './output.ts';
import { type ProxyDeps, type ProxyHandle, RegistryProxy } from './proxy.ts';
import { type ExecRequest, RequestError } from './request.ts';
import { type SessionRead, SessionState } from './sessions.ts';

/** An answer other than 200, with the words for it. */
export class ApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = 'ApiError';
	}
}

/** The disk limits a Sandbox works to; LIMITS unless a test names smaller ones. */
export type SandboxLimits = { [K in 'diskBudgetBytes' | 'diskPollMs' | 'diskNoiseBytes' | 'diskTriggerBytes']: number };

export interface SandboxConfig {
	/** The work volume: /work in the container. */
	workDir: string;
	/** Where the proxy sockets go: the container's own /tmp, not the shared volume. */
	runtimeDir: string;
	/** The bubblewrap program. */
	bwrap: string;
	system: System;
	/** The in-cage seccomp program, or null on a host it is not written for. */
	filter: Uint8Array | null;
	limits?: Partial<SandboxLimits>;
}

export interface SandboxDeps {
	log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void;
	proxy: ProxyDeps;
	/** Bytes free on the filesystem holding `path`. */
	freeBytes(path: string): Promise<number>;
}

/** What one run may keep: over `limit` a command may only remove files; past `ceiling` nothing runs. */
export interface DiskQuota {
	limit: number;
	ceiling: number;
}

export interface ExecResult {
	/** Null when the sandbox stopped it. 137 without `killed` is the OOM killer: nothing else sends SIGKILL. */
	exitCode: number | null;
	timedOut: boolean;
	/** Why the sandbox stopped the command: "timeout", "disk", "cancelled", or null. */
	killed: string | null;
	durationMs: number;
	output: string;
	truncated: boolean;
	omittedBytes: number;
	outputBytes: number;
	/** The run's files after the command: checkout, home and /tmp. */
	diskBytes: number;
	/** The most the run may keep: its budget, or less when its owner's other workspaces use the rest. */
	diskBudgetBytes: number;
	overBudget: boolean;
	/** The run was over budget, so the command could remove, move and truncate files but write none. */
	cleanupOnly: boolean;
	/** With `network: "registries"`: hosts the proxy connected to, and hosts it refused. */
	reachedHosts: string[];
	refusedHosts: string[];
}

/** How long work may run, what stops it, and where its output goes. */
export type RunOptions = Pick<CageRun, 'timeoutMs' | 'signal' | 'watchdog' | 'onOutput'>;

/** A run's folders on the work volume: the checkout, and its state (the home, and bwrap's /tmp). */
type RunPaths = Record<'checkout' | 'state' | 'home' | 'tmp', string>;

type SessionRequest = { runId: string; network: 'none' | 'registries' };

/** A live session's standard input; `push` answers false once the session takes no more. */
export interface SessionSink {
	push(bytes: Uint8Array): boolean | Promise<boolean>;
	close(): void;
}

/** A backend's session shell, ready to run under the shared session bookkeeping. */
export interface SessionShell {
	input: SessionSink;
	watch: DiskWatch;
	/** What could not start, in the words the session prints. */
	noun: 'cage' | 'shell';
	run(options: RunOptions): Promise<CageResult>;
	/** Closes the session's egress, when it has one. */
	closeProxy(): Promise<void>;
	/** The teardown's last step, before the session's marker goes. */
	cleanup?(): Promise<void>;
}

/** How a backend runs the diff script, for the shared diff. */
export interface DiffWork {
	run(options: RunOptions): Promise<CageResult>;
	/** Bytes the diff's scratch space takes. */
	scratch(signal: AbortSignal): Promise<number>;
	/** Gives the owner read access back throughout the checkout. */
	repair(signal: AbortSignal): Promise<void>;
	/** Empties the scratch space before and after each attempt. */
	reset?(signal?: AbortSignal): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const freeBytes = async (path: string): Promise<number> => {
	const s = await statfs(path);
	return Number(s.bavail) * Number(s.bsize);
};

/** What both backends share: the slots, the disk limits, live sessions, the diff and the cached health probe. */
export abstract class SandboxBase<
	C extends { workDir: string; limits?: Partial<SandboxLimits> },
	D extends SandboxDeps,
> {
	/** Which backend this is, as `/healthz` reports it. */
	abstract readonly kind: SandboxBackend;
	readonly gate = new Gate();
	/** Housekeeping work for requests that hold no command slot. */
	readonly chores = new Gate(LIMITS.choreRunning, LIMITS.choreWaiting, LIMITS.choreTimeoutMs);
	readonly runs = new Runs();
	/** Live sessions, counted apart from commands so a terminal never takes a command slot. */
	readonly sessionGate = new Gate(LIMITS.sessionsRunning, 0, 0);
	readonly limits: SandboxLimits;
	protected readonly watches: DiskWatches;
	readonly #sessions = new Map<string, SessionState>();
	readonly #byRun = new Map<string, SessionState>();
	readonly #stops = new Map<string, (why: string) => void>();
	readonly #inputs = new Map<string, SessionSink>();
	#probe: { at: number; error: string | null } | null = null;
	#probing: Promise<string | null> | null = null;

	constructor(readonly config: C, readonly deps: D) {
		this.limits = {
			diskBudgetBytes: LIMITS.diskBudgetBytes,
			diskPollMs: LIMITS.diskPollMs,
			diskNoiseBytes: LIMITS.diskNoiseBytes,
			diskTriggerBytes: LIMITS.diskTriggerBytes,
			...config.limits,
		};
		this.watches = new DiskWatches({
			free: () => this.deps.freeBytes(this.config.workDir),
			minFreeBytes: LIMITS.minFreeBytes,
			noiseBytes: this.limits.diskNoiseBytes,
			triggerBytes: this.limits.diskTriggerBytes,
		});
	}

	/** Null when the backend can run work, else why not. */
	protected abstract probe(): Promise<string | null>;
	/** Prepares a session's shell over the run's checkout, held to `quota`. */
	protected abstract startShell(req: SessionRequest, quota: DiskQuota | undefined): Promise<SessionShell>;
	protected abstract diffWork(runId: string): DiffWork | Promise<DiffWork>;
	/** Removes the run's state (and container), leaving a checkout the service can remove; false when there was none. */
	protected abstract removeRun(runId: string): Promise<boolean>;

	paths(runId: string): RunPaths {
		const state = `${this.config.workDir}/.sandbox/${runId}`;
		return { checkout: `${this.config.workDir}/${runId}`, state, home: `${state}/home`, tmp: `${state}/tmp` };
	}

	/** The run's folders; 404 when it has no checkout. */
	protected async locate(runId: string): Promise<RunPaths> {
		const paths = this.paths(runId);
		if (!(await isDirectory(paths.checkout))) {
			throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
		}
		return paths;
	}

	protected async checkFreeSpace(): Promise<void> {
		assertFreeSpace(await this.deps.freeBytes(this.config.workDir));
	}

	/**
	 * Checks free space and the run's size before work starts, and watches it while it runs: over its limit the work
	 * may only clean up and is stopped if the run grows; past its ceiling `refuse` answers instead.
	 */
	protected async watchRun(
		quota: DiskQuota | undefined,
		measureBefore: (limit: number) => Promise<number>,
		measure: (signal: AbortSignal) => Promise<number>,
		refuse: (before: number, limit: number) => ApiError | Promise<ApiError>,
	): Promise<{ before: number; limit: number; cleanupOnly: boolean; watch: DiskWatch }> {
		await this.checkFreeSpace();
		const { limit, ceiling } = quota ??
			{ limit: this.limits.diskBudgetBytes, ceiling: 2 * this.limits.diskBudgetBytes };
		const before = await measureBefore(limit);
		if (before > ceiling) throw await refuse(before, limit);
		const cleanupOnly = before > limit;
		const watch = await this.watches.start({ before, limit: cleanupOnly ? before : limit, measure });
		return { before, limit, cleanupOnly, watch };
	}

	/** The refusal for a command whose cage (or exec) never started. */
	protected notStarted(runId: string, result: CageResult, what: string): ApiError {
		this.deps.log('error', 'cage.failed', { runId, diagnostics: result.diagnostics });
		return cageFailed(result.diagnostics, what);
	}

	/** A command's reply, logged as `exec.done`. */
	protected reply(
		req: ExecRequest,
		result: CageResult,
		out: Output,
		after: number,
		disk: { limit: number; cleanupOnly: boolean; watch: DiskWatch },
		proxy: ProxyHandle | null,
	): ExecResult {
		const reply: ExecResult = {
			exitCode: result.exitCode,
			timedOut: result.killed === 'timeout',
			killed: result.killed,
			durationMs: result.durationMs,
			...out,
			diskBytes: after,
			diskBudgetBytes: Math.max(0, disk.limit),
			overBudget: after > disk.limit,
			cleanupOnly: disk.cleanupOnly,
			reachedHosts: [...(proxy?.reached ?? [])],
			refusedHosts: [...(proxy?.refused ?? [])],
		};
		this.deps.log('info', 'exec.done', {
			runId: req.runId,
			backend: this.kind,
			network: req.network,
			exitCode: reply.exitCode,
			killed: reply.killed,
			diskStop: disk.watch.verdict,
			durationMs: reply.durationMs,
			outputBytes: reply.outputBytes,
			diskBytes: reply.diskBytes,
			cleanupOnly: reply.cleanupOnly,
			refusedHosts: reply.refusedHosts,
		});
		return reply;
	}

	// --- live sessions ---------------------------------------------------------------------------

	/** The open session of `runId`, or null. */
	sessionOf(runId: string): SessionState | null {
		return this.#byRun.get(runId) ?? null;
	}

	/**
	 * Opens a shell session over the checkout, without the run lock. It ends on close, removal, the idle and lifetime
	 * limits, the disk watchdog, or the shell's exit.
	 */
	async openSession(
		owner: string,
		req: SessionRequest,
		quota?: DiskQuota,
	): Promise<{ session_id: string; created_at: string }> {
		this.#pruneEnded();
		if (this.#byRun.has(req.runId)) {
			throw new ApiError(409, 'session_open', 'This workspace already has an open session.');
		}
		await this.locate(req.runId);
		const release = await this.sessionGate.enter();
		// One owner's share of the session slots, checked with a slot held and nothing awaited before the marker is
		// set, so two opens of one owner cannot both pass it.
		if ([...this.#byRun.values()].filter((open) => open.owner === owner).length >= LIMITS.ownerSessions) {
			release();
			throw ownerSessionsBusy();
		}
		const session = new SessionState(req.runId, owner);
		this.#sessions.set(session.id, session);
		this.#byRun.set(req.runId, session);
		let shell: SessionShell;
		try {
			shell = await this.startShell(req, quota);
		} catch (cause) {
			this.#sessions.delete(session.id);
			this.#byRun.delete(req.runId);
			release();
			throw cause;
		}
		const controller = new AbortController();
		let stopReason = '';
		const stop = (why: string): void => {
			stopReason = why;
			controller.abort();
		};
		this.#stops.set(session.id, stop);
		this.#inputs.set(session.id, shell.input);
		const idle = setInterval(() => {
			if (session.idleMs > LIMITS.sessionIdleMs) stop('idle');
			else if (session.ageMs > LIMITS.sessionLifetimeMs) stop('lifetime');
		}, 5_000);
		const failed = (step: string) => (error: unknown) =>
			this.deps.log('warn', 'session.teardown_failed', { runId: req.runId, step, error: describe(error) });
		// The shell runs for the session's life; its end is reported through the session state.
		void shell.run({
			timeoutMs: LIMITS.sessionLifetimeMs + 60_000,
			signal: controller.signal,
			onOutput: (chunk) => session.push(chunk),
			watchdog: { everyMs: this.limits.diskPollMs, check: () => shell.watch.check() },
		}).then(
			(result) => {
				if (!result.started) {
					session.push(encoder.encode(`the sandbox could not start a ${shell.noun}: ${result.diagnostics}\n`));
					session.end(null, 'cage_failed');
				} else session.end(result.exitCode, result.killed === 'cancelled' ? stopReason || 'closed' : result.killed);
			},
			() => session.end(null, 'internal'),
		).finally(async () => {
			clearInterval(idle);
			this.#stops.delete(session.id);
			this.#inputs.delete(session.id);
			shell.input.close();
			// The marker goes last: while it is set, file operations run caged, where nothing the shell left behind
			// (a setsid process in a container) can swap a directory for a link.
			try {
				await shell.watch.end().catch(failed('watch'));
				await shell.closeProxy().catch(failed('proxy'));
				await shell.cleanup?.();
			} finally {
				this.#byRun.delete(req.runId);
				release();
			}
			this.deps.log('info', 'session.ended', { runId: req.runId, sessionId: session.id });
			// The record stays readable so a reader can collect the end; `#pruneEnded` forgets it a minute later.
			session.lastActivity = Date.now();
		});
		this.deps.log('info', 'session.opened', { runId: req.runId, sessionId: session.id, network: req.network });
		return { session_id: session.id, created_at: new Date(session.createdAt).toISOString() };
	}

	/** Feeds the session's input; a line without a trailing newline is not seen by the shell yet. */
	async sessionInput(owner: string, sessionId: string, data: string): Promise<{ accepted: true }> {
		const session = this.#session(owner, sessionId);
		if (session.ended) throw new ApiError(409, 'session_ended', 'The session has ended.');
		const bytes = encoder.encode(data);
		if (bytes.length > LIMITS.sessionInputBytes) throw new RequestError('data', 'is over 16 KiB');
		if (!session.countInput(bytes.length, LIMITS.sessionInputBytes * 256)) {
			this.#stops.get(sessionId)?.('input_limit');
			throw new ApiError(409, 'session_ended', 'The session took too much input and was closed.');
		}
		const input = this.#inputs.get(sessionId);
		if (input === undefined || !(await input.push(bytes))) {
			throw new ApiError(409, 'session_ended', 'The session has ended.');
		}
		return { accepted: true };
	}

	async sessionRead(owner: string, sessionId: string, after: number, waitMs: number): Promise<SessionRead> {
		this.#pruneEnded();
		const session = this.#session(owner, sessionId);
		session.lastActivity = Date.now();
		return await session.read(after, waitMs);
	}

	sessionClose(owner: string, sessionId: string): { closed: true } {
		const session = this.#session(owner, sessionId);
		this.#stop(sessionId, 'closed');
		if (session.ended) this.#sessions.delete(sessionId);
		return { closed: true };
	}

	#session(owner: string, sessionId: string): SessionState {
		const session = this.#sessions.get(sessionId);
		if (session === undefined || session.owner !== owner) throw new ApiError(404, 'no_session', 'No such session.');
		return session;
	}

	#stop(sessionId: string, why: string): void {
		this.#stops.get(sessionId)?.(why);
		this.#inputs.get(sessionId)?.close();
		this.#inputs.delete(sessionId);
	}

	/** Forgets ended sessions a reader has had a minute to collect; no timer, so nothing is left pending. */
	#pruneEnded(): void {
		const now = Date.now();
		for (const [id, session] of this.#sessions) {
			if (session.ended && now - session.lastActivity > 60_000) this.#sessions.delete(id);
		}
	}

	// --- diff, removal, health ---------------------------------------------------------------------

	diff(runId: string, signal?: AbortSignal): Promise<DiffResult> {
		return this.runs.hold(runId, signal, async (held) => {
			const { checkout } = await this.locate(runId);
			if (!(await gitDirectory(checkout))) {
				throw new ApiError(409, 'no_repository', "This run's checkout has no .git directory.");
			}
			const release = await this.gate.enter(held);
			try {
				const work = await this.diffWork(runId);
				await this.checkFreeSpace();
				let attempt = await this.#diffOnce(work, held);
				// A command can leave files only it could read (chmod 000); git then cannot stage them.
				// Giving the owner read access back changes nothing git records, so fix and try again.
				if (typeof attempt === 'string' && /permission denied/i.test(attempt)) {
					await work.repair(held);
					attempt = await this.#diffOnce(work, held);
				}
				if (typeof attempt === 'string') {
					throw new ApiError(500, 'diff_failed', `git could not diff the checkout: ${attempt}`);
				}
				// Cut to what one reply may carry as JSON, so the client never has to refuse it.
				return fitDiff(attempt, LIMITS.responseBytes);
			} finally {
				release();
			}
		});
	}

	/** One run of the diff script: the parsed diff, or what git said when it failed. */
	async #diffOnce(work: DiffWork, signal: AbortSignal): Promise<DiffResult | string> {
		await work.reset?.(signal);
		const out = collect(LIMITS.patchBytes * 2);
		// Git writes the blobs it stages into the scratch space. They may take one budget's worth on top of the run's
		// files (they are compressed copies of them), and are gone after the diff.
		const watch = await this.watches.start({
			before: 0,
			limit: this.limits.diskBudgetBytes,
			measure: (stop) => work.scratch(stop),
		});
		let result: CageResult;
		try {
			result = await work.run({
				timeoutMs: LIMITS.diffTimeoutMs,
				signal,
				onOutput: out.push,
				watchdog: { everyMs: this.limits.diskPollMs, check: () => watch.check() },
			});
		} finally {
			await watch.end();
		}
		await work.reset?.().catch(() => {});
		const bytes = out.bytes();
		if (!result.started) throw cageFailed(result.diagnostics);
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
			return decoder.decode(bytes.subarray(Math.max(0, bytes.length - 2000))).trim() || `exit ${result.exitCode}`;
		}
		return parseDiff(bytes, !cut);
	}

	/** Ends the run's live session, then removes what the backend keeps for it. */
	remove(runId: string): Promise<{ removed: boolean }> {
		return this.runs.removing(runId, async () => {
			const open = this.#byRun.get(runId);
			if (open !== undefined) this.#stop(open.id, 'removed');
			const removed = await this.removeRun(runId);
			this.deps.log('info', 'run.removed', { runId, removed, backend: this.kind });
			return { removed };
		});
	}

	/** Whether the backend can run work: cached for half a minute, one shared probe at a time. */
	async health(): Promise<{ ok: boolean; error: string | null }> {
		if (this.#probe && Date.now() - this.#probe.at < 30_000) {
			return { ok: this.#probe.error === null, error: this.#probe.error };
		}
		this.#probing ??= this.#runProbe().finally(() => this.#probing = null);
		const error = await this.#probing;
		return { ok: error === null, error };
	}

	async #runProbe(): Promise<string | null> {
		const error = await this.probe().catch((err: unknown) => err instanceof Error ? err.message : String(err));
		this.#probe = { at: Date.now(), error };
		return error;
	}
}

/** Who holds the slot a housekeeping cage runs under. */
interface ChoreOptions {
	signal?: AbortSignal;
	/** No command slot is held: the cage waits for a housekeeping slot instead. */
	gated?: boolean;
}

export class Sandbox extends SandboxBase<SandboxConfig, SandboxDeps> {
	override readonly kind = 'bwrap' as const;

	exec(req: ExecRequest, signal?: AbortSignal, quota?: DiskQuota): Promise<ExecResult> {
		return this.runs.hold(req.runId, signal, async (held) => {
			const paths = await this.locate(req.runId);
			await checkCwd(paths.checkout, req.cwd);
			const git = await gitDirectory(paths.checkout);
			const release = await this.gate.enter(held);
			try {
				await Deno.mkdir(paths.home, { recursive: true });
				await this.#resetTmp(paths.tmp, { signal: held });
				if (req.stdin !== null) {
					await Deno.writeTextFile(`${paths.tmp}/${STDIN_FILE.slice('/tmp/'.length)}`, req.stdin);
				}
				const now = new Date();
				await Deno.utime(paths.state, now, now);
				const measure = (signal?: AbortSignal) => this.#measure([paths.checkout, paths.state], { signal });
				const disk = await this.watchRun(quota, () => measure(held), measure, overBudget);
				const mounts = this.#mounts(paths.tmp, paths, git);
				const capture = new OutputCapture();
				let proxy: ProxyHandle | null = null;
				let socket = '';
				let result: CageResult;
				try {
					if (req.network !== 'none') {
						socket = `${this.config.runtimeDir}/${crypto.randomUUID()}.sock`;
						proxy = openEgress(req, socket, this.deps.proxy);
						mounts.push({ source: socket, target: PROXY_SOCKET, writable: false });
					}
					result = await this.#run({
						mounts,
						chdir: req.cwd ? `${WORKSPACE}/${req.cwd}` : WORKSPACE,
						env: { ...(proxy ? proxyEnv() : {}), ...req.env },
						command: req.command,
						proxy: proxy !== null,
						stdin: req.stdin !== null,
						noGrowth: disk.cleanupOnly,
					}, {
						timeoutMs: req.timeoutMs,
						signal: held,
						onOutput: (chunk) => capture.push(chunk),
						watchdog: { everyMs: this.limits.diskPollMs, check: () => disk.watch.check() },
					});
				} finally {
					await disk.watch.end();
					await proxy?.close();
					if (socket) await Deno.remove(socket).catch(() => {});
				}
				if (!result.started) throw this.notStarted(req.runId, result, 'a cage');
				// Not cancelled with the request. A cancelled command's growth is still measured, so
				// the owner's total is never understated; when it cannot be, the worst is assumed.
				const after = await measure().catch(() => Math.max(disk.before, disk.limit));
				return this.reply(req, result, capture.result(), after, disk, proxy);
			} finally {
				release();
			}
		});
	}

	/** The session's cage, reading its input from a file the service appends to. */
	protected override async startShell(req: SessionRequest, quota: DiskQuota | undefined): Promise<SessionShell> {
		const paths = this.paths(req.runId);
		const git = await gitDirectory(paths.checkout);
		const tmp = `${paths.state}/session-tmp`;
		await Deno.mkdir(paths.home, { recursive: true });
		await this.#resetTmp(tmp);
		const file = await Deno.open(`${tmp}/${SESSION_INPUT.slice('/tmp/'.length)}`, {
			write: true,
			create: true,
			append: true,
		});
		const input = fileSink(file);
		try {
			const measure = (signal?: AbortSignal) => this.#measure([paths.checkout, paths.state], { signal });
			const { cleanupOnly, watch } = await this.watchRun(quota, () => measure(), measure, sessionOverBudget);
			const mounts = this.#mounts(tmp, paths, git);
			let proxy: RegistryProxy | null = null;
			let socket = '';
			if (req.network === 'registries') {
				socket = `${this.config.runtimeDir}/${crypto.randomUUID()}.sock`;
				try {
					proxy = RegistryProxy.open(socket, this.deps.proxy, req.runId);
				} catch (error) {
					await watch.end();
					throw error;
				}
				mounts.push({ source: socket, target: PROXY_SOCKET, writable: false });
			}
			const env = proxy ? proxyEnv() : {};
			return {
				input,
				watch,
				noun: 'cage',
				run: (options) =>
					this.#run({
						mounts,
						chdir: WORKSPACE,
						env,
						command: '',
						proxy: proxy !== null,
						stdin: false,
						interactive: true,
						noGrowth: cleanupOnly,
					}, options),
				closeProxy: async () => {
					await proxy?.close();
					if (socket) await Deno.remove(socket).catch(() => {});
				},
			};
		} catch (error) {
			input.close();
			throw error;
		}
	}

	protected override diffWork(runId: string): DiffWork {
		const paths = this.paths(runId);
		return {
			run: (options) =>
				this.#run({
					mounts: [
						{ source: paths.checkout, target: WORKSPACE, writable: false },
						{ source: paths.tmp, target: '/tmp', writable: true },
					],
					chdir: WORKSPACE,
					env: { HOME: '/tmp' },
					command: diffScript(),
					proxy: false,
					stdin: false,
				}, options),
			scratch: (signal) => this.#measure([paths.tmp], { signal }),
			repair: (signal) => this.#fixPermissions(paths.checkout, { signal }),
			reset: (signal) => this.#resetTmp(paths.tmp, { signal }),
		};
	}

	/** Restores write access in the checkout so its removal cannot fail, and removes the run's state. */
	protected override async removeRun(runId: string): Promise<boolean> {
		const paths = this.paths(runId);
		if (await isDirectory(paths.checkout)) await this.#fixPermissions(paths.checkout, { gated: true });
		return await this.#removeTree(paths.state, { gated: true });
	}

	/** Whether a cage can be made at all. */
	protected override async probe(): Promise<string | null> {
		const result = await this.#run(
			{ mounts: [], chdir: '/', env: {}, command: 'true', proxy: false, stdin: false },
			{ timeoutMs: LIMITS.choreTimeoutMs, onOutput: () => {} },
		);
		if (result.started && result.exitCode === 0) return null;
		return result.diagnostics || `the test cage exited with ${result.exitCode}`;
	}

	/** Bytes the run's files take, for callers without a command slot (it waits for a housekeeping slot). */
	diskUsage(runId: string, signal?: AbortSignal): Promise<number> {
		const paths = this.paths(runId);
		return this.#measure([paths.checkout, paths.state], { signal, gated: true });
	}

	/**
	 * A file operation in a cage that sees only the checkout (with `.git` read-only), for a run whose live session
	 * can change the tree while the service would be checking it.
	 */
	fileOp(runId: string, op: CagedFileOp, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.runs.hold(runId, signal, async (held) => {
			const paths = await this.locate(runId);
			const git = await gitDirectory(paths.checkout);
			await this.#resetTmp(paths.tmp, { signal: held, gated: true });
			if (op.kind === 'write') {
				await Deno.writeTextFile(`${paths.tmp}/${STDIN_FILE.slice('/tmp/'.length)}`, op.content);
			}
			const mounts: Mount[] = [
				{ source: paths.tmp, target: '/tmp', writable: true },
				{ source: paths.checkout, target: WORKSPACE, writable: op.kind === 'write' },
			];
			if (git) mounts.push({ source: git, target: `${WORKSPACE}/.git`, writable: false });
			const out = collect(CAGED_OUTPUT_BYTES);
			const result = await this.#chore(
				{
					mounts,
					chdir: WORKSPACE,
					env: { TTK_PATH: op.path },
					command: cagedScript(op.kind),
					proxy: false,
					stdin: op.kind === 'write',
				},
				{ timeoutMs: LIMITS.choreTimeoutMs, signal: held, onOutput: out.push },
				true,
			);
			await this.#resetTmp(paths.tmp).catch(() => {});
			return cagedResult(op, result, out.bytes(), held);
		});
	}

	/** A command's or a session's mounts: its /tmp, the home, the checkout, and `.git` read-only. */
	#mounts(tmp: string, paths: RunPaths, git: string | null): Mount[] {
		const mounts: Mount[] = [
			{ source: tmp, target: '/tmp', writable: true },
			{ source: paths.home, target: CAGE_HOME, writable: true },
			{ source: paths.checkout, target: WORKSPACE, writable: true },
		];
		if (git) mounts.push({ source: git, target: `${WORKSPACE}/.git`, writable: false });
		return mounts;
	}

	/**
	 * Bytes the folders take, by du in a cage with CAP_DAC_READ_SEARCH (a locked directory still counts), mounted
	 * read-only; du's complaints are discarded so no file name can pose as its total.
	 */
	async #measure(dirs: string[], options: ChoreOptions): Promise<number> {
		const mounts: Mount[] = [];
		for (const [i, dir] of dirs.entries()) {
			if (await isDirectory(dir)) mounts.push({ source: dir, target: `/m/${i}`, writable: false });
		}
		if (mounts.length === 0) return 0;
		let tail = '';
		const stream = new TextDecoder();
		const result = await this.#chore({
			mounts,
			chdir: '/',
			env: {},
			command: `du -s -k -c ${mounts.map((m) => m.target).join(' ')} 2>/dev/null`,
			proxy: false,
			stdin: false,
			caps: ['CAP_DAC_READ_SEARCH'],
		}, {
			timeoutMs: LIMITS.choreTimeoutMs,
			signal: options.signal,
			onOutput: (chunk) => {
				tail = (tail + stream.decode(chunk, { stream: true })).slice(-4096);
			},
		}, options.gated ?? false);
		options.signal?.throwIfAborted();
		// The total is du's last line.
		const total = [...tail.matchAll(/^(\d+)\s+total$/gm)].at(-1);
		if (!result.started || result.killed !== null || !total) {
			throw new ApiError(
				503,
				'cage_failed',
				`Could not measure the run's disk use: ${result.diagnostics || result.killed || `exit ${result.exitCode}`}`,
			);
		}
		return Number(total[1]) * 1024;
	}

	/** A housekeeping cage, waiting for a housekeeping slot when no command slot is held. */
	async #chore(spec: Omit<CageSpec, 'filter' | 'processes'>, run: RunOptions, gated: boolean): Promise<CageResult> {
		const release = gated ? await this.chores.enter(run.signal) : null;
		try {
			return await this.#run(spec, run);
		} finally {
			release?.();
		}
	}

	#run(spec: Omit<CageSpec, 'filter' | 'processes'>, run: RunOptions): Promise<CageResult> {
		const filter = this.config.filter;
		return runCage({
			bwrap: this.config.bwrap,
			args: cageArgs({ ...spec, filter: filter !== null, processes: LIMITS.cageProcesses }, this.config.system),
			input: filter,
			...run,
		});
	}

	async #resetTmp(tmp: string, options: ChoreOptions = {}): Promise<void> {
		await this.#removeTree(tmp, options);
		await Deno.mkdir(tmp, { recursive: true });
	}

	#removeTree(path: string, options: ChoreOptions): Promise<boolean> {
		return removeTree(path, () => this.#fixPermissions(path, options));
	}

	/** Gives the owner read, write and search permission back throughout a folder, in a cage. */
	async #fixPermissions(path: string, options: ChoreOptions): Promise<void> {
		await this.#chore(
			{
				mounts: [{ source: path, target: '/m/target', writable: true }],
				chdir: '/',
				env: {},
				command: 'chmod -R u+rwX /m/target',
				proxy: false,
				stdin: false,
			},
			{ timeoutMs: LIMITS.choreTimeoutMs, signal: options.signal, onOutput: () => {} },
			options.gated ?? false,
		);
		// A cancelled request ends here rather than failing later on what was left locked.
		options.signal?.throwIfAborted();
	}
}

/** The session's input file as its sink, closed with the session. */
function fileSink(file: Deno.FsFile): SessionSink {
	let open = true;
	return {
		push: async (bytes) => {
			if (!open) return false;
			for (let written = 0; written < bytes.length;) written += await file.write(bytes.subarray(written));
			return true;
		},
		close: () => {
			if (open) file.close();
			open = false;
		},
	};
}

export const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/** The refusal for a run whose files are past its ceiling. */
export function overBudget(before: number, limit: number): ApiError {
	return new ApiError(
		507,
		'over_budget',
		`This run's files take ${mb(before)} MB, too far over its ${
			mb(Math.max(0, limit))
		} MB budget to run anything. Remove the workspace.`,
	);
}

/** The refusal of a session for a run whose files are past its ceiling. */
export const sessionOverBudget = (): ApiError =>
	new ApiError(507, 'over_budget', 'This run is too far over its disk budget to open a session.');

/** Nothing runs while the volume has less than LIMITS.minFreeBytes free. */
export function assertFreeSpace(free: number): void {
	if (free >= LIMITS.minFreeBytes) return;
	throw new ApiError(
		507,
		'disk_full',
		`The server has ${mb(free)} MB of disk left; the sandbox needs ${mb(LIMITS.minFreeBytes)} MB free to run anything.`,
	);
}

/**
 * Removes a folder a command wrote; one it made unreadable is removed after `restore` gives the owner access back.
 * False when there was none.
 */
export async function removeTree(path: string, restore: (path: string) => Promise<void>): Promise<boolean> {
	try {
		await Deno.remove(path, { recursive: true });
		return true;
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) return false;
		if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
	}
	await restore(path);
	await Deno.remove(path, { recursive: true });
	return true;
}

/** The refusal for work whose cage (or container exec) never started. */
export function cageFailed(diagnostics: string, what = 'a cage'): ApiError {
	return new ApiError(503, 'cage_failed', `The sandbox could not start ${what}: ${diagnostics || 'no reason given'}`);
}

/** An error as the log may show it: an API or gate refusal by its code. */
export function describe(error: unknown): string {
	if (error instanceof GateError || error instanceof ApiError) return error.code;
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The registry proxy for `registries`, or the clone step's own egress for `git` (never from a request). */
export function openEgress(req: ExecRequest, path: string, deps: ProxyDeps): ProxyHandle {
	if (req.network === 'git') {
		if (req.egress === undefined) throw new ApiError(500, 'internal', 'A clone step has no egress.');
		return req.egress(path, deps, req.runId);
	}
	return RegistryProxy.open(path, deps, req.runId);
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		const info = await Deno.lstat(path);
		return info.isDirectory && !info.isSymlink;
	} catch {
		return false;
	}
}

/** The checkout's .git, when it is a real directory; a link or a file there is refused. */
export async function gitDirectory(root: string): Promise<string | null> {
	const path = `${root}/.git`;
	try {
		const info = await Deno.lstat(path);
		if (info.isDirectory && !info.isSymlink) return path;
		throw new ApiError(409, 'bad_checkout', "The checkout's .git is not a directory.");
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) return null;
		throw err;
	}
}

/** The working directory must exist with no symbolic link in it: a clear refusal beats a confusing one. */
export async function checkCwd(root: string, cwd: string): Promise<void> {
	if (cwd === '') return;
	let path = root;
	for (const [i, segment] of cwd.split('/').entries()) {
		path = `${path}/${segment}`;
		const shown = cwd.split('/').slice(0, i + 1).join('/');
		let info: Deno.FileInfo;
		try {
			info = await Deno.lstat(path);
		} catch {
			throw new RequestError('cwd', `${shown} does not exist in the workspace`);
		}
		if (info.isSymlink) throw new RequestError('cwd', `${shown} is a symbolic link`);
		if (!info.isDirectory) throw new RequestError('cwd', `${shown} is not a directory`);
	}
}
