/**
 * The bubblewrap backend (the default, D-064): what the endpoints do, on disk and in cages. The layout on the
 * work volume:
 *
 *   /work/<run id>/                  the workspace's checkout: the workspace service (workspaces.ts) creates it,
 *                                    a cage gives it its repository (`git init`), and commands run in it
 *   /work/.sandbox/<run id>/home/    the cage's HOME for that run: package caches live here, so a
 *                                    second install in the same run is quick
 *   /work/.sandbox/<run id>/tmp/     the cage's /tmp, emptied before every command
 *
 * The sandbox removes its own `.sandbox/<run id>` when asked (DELETE). SB-4: what a crash leaves
 * behind, a checkout or state with no owner record, is removed by the workspace service's sweep
 * (WorkspaceService.sweep, started by main.ts); nothing removes the state of a workspace that
 * still exists, however long it has been idle.
 *
 * Everything a cage writes counts toward the run's disk budget, and none of it is in a tmpfs, so a
 * large install costs disk, not the container's memory. SB-1: the budget is measured before and
 * after each command by du in a cage that can read directories a command locked, and watched
 * while a command or a diff runs (disk.ts).
 *
 * The Docker backend (docker.ts, D-108) answers the same operations with the same limits, results and errors.
 */
import { statfs } from '#sandbox-fs';
import {
	CAGE_HOME,
	cageArgs,
	type CageResult,
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
import { CAGED_FILE_BYTES, type CagedFileOp, cagedResult, cagedScript, EXIT } from './caged_files.ts';
import { type DiffResult, diffScript, fitDiff, parseDiff } from './diff.ts';
import { DiskWatches } from './disk.ts';
import { Gate, Runs } from './gate.ts';
import { LIMITS } from './limits.ts';
import { OutputCapture } from './output.ts';
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

/**
 * What one command's run may keep (SB-1): `limit` is its budget, or less when its owner's other
 * workspaces use the rest. Over it, a command may only remove files (SB-7), up to `ceiling`; past
 * that nothing runs.
 */
export interface DiskQuota {
	limit: number;
	ceiling: number;
}

export interface ExecResult {
	/**
	 * The command's exit status; null when the sandbox stopped it. 137 without `killed` is almost
	 * always the out-of-memory killer: nothing else in a cage sends SIGKILL.
	 */
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
	/**
	 * SB-7: the run was over its budget when the command started, so the command could remove,
	 * move and truncate files but write none ("File too large").
	 */
	cleanupOnly: boolean;
	/** With `network: "registries"`: hosts the proxy connected to, and hosts it refused. */
	reachedHosts: string[];
	refusedHosts: string[];
}

export const freeBytes = async (path: string): Promise<number> => {
	const s = await statfs(path);
	return Number(s.bavail) * Number(s.bsize);
};

/** Who holds the slot a housekeeping cage runs under (SB-3). */
interface ChoreOptions {
	signal?: AbortSignal;
	/** No command slot is held: the cage waits for a housekeeping slot instead. */
	gated?: boolean;
}

export class Sandbox {
	/** D-108: which backend this is, as `/healthz` reports it. */
	readonly kind = 'bwrap' as const;
	readonly gate = new Gate();
	/** SB-3: housekeeping cages for requests that hold no command slot. */
	readonly chores = new Gate(LIMITS.choreRunning, LIMITS.choreWaiting, LIMITS.choreTimeoutMs);
	readonly runs = new Runs();
	readonly limits: SandboxLimits;
	readonly #watches: DiskWatches;
	#probe: { at: number; error: string | null } | null = null;
	#probing: Promise<string | null> | null = null;

	constructor(readonly config: SandboxConfig, readonly deps: SandboxDeps) {
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

	paths(runId: string) {
		const state = `${this.config.workDir}/.sandbox/${runId}`;
		return {
			checkout: `${this.config.workDir}/${runId}`,
			state,
			home: `${state}/home`,
			tmp: `${state}/tmp`,
		};
	}

	exec(req: ExecRequest, signal?: AbortSignal, quota?: DiskQuota): Promise<ExecResult> {
		return this.runs.hold(req.runId, signal, async (held) => {
			const paths = this.paths(req.runId);
			const root = paths.checkout;
			if (!(await isDirectory(root))) {
				throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
			}
			await checkCwd(root, req.cwd);
			const git = await gitDirectory(root);

			const release = await this.gate.enter(held);
			try {
				await Deno.mkdir(paths.home, { recursive: true });
				await this.#resetTmp(paths.tmp, { signal: held });
				if (req.stdin !== null) {
					await Deno.writeTextFile(`${paths.tmp}/${STDIN_FILE.slice('/tmp/'.length)}`, req.stdin);
				}
				const now = new Date();
				await Deno.utime(paths.state, now, now);

				await this.#checkFreeSpace();
				const runDirs = [paths.checkout, paths.state];
				const before = await this.#measure(runDirs, { signal: held });
				const { limit, ceiling } = quota ?? this.#defaultQuota();
				// SB-7: a run over its budget may still clean up: its command runs, but can write no
				// file data and is stopped the moment the run grows. Only repeated overshoots reach the
				// ceiling; past it nothing runs, and removing the workspace is the way out.
				const cleanupOnly = before > limit;
				if (cleanupOnly && before > ceiling) {
					throw new ApiError(
						507,
						'over_budget',
						`This run's files take ${mb(before)} MB, too far over its ${
							mb(Math.max(0, limit))
						} MB budget to run anything. Remove the workspace.`,
					);
				}

				const mounts: Mount[] = [
					{ source: paths.tmp, target: '/tmp', writable: true },
					{ source: paths.home, target: CAGE_HOME, writable: true },
					{ source: root, target: WORKSPACE, writable: true },
				];
				if (git) mounts.push({ source: git, target: `${WORKSPACE}/.git`, writable: false });
				const capture = new OutputCapture();
				// SB-1: watched while it runs, not only measured before and after.
				const watch = await this.#watches.start({
					before,
					limit: cleanupOnly ? before : limit,
					measure: (stop) => this.#measure(runDirs, { signal: stop }),
				});
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
						noGrowth: cleanupOnly,
					}, {
						timeoutMs: req.timeoutMs,
						signal: held,
						onOutput: (chunk) => capture.push(chunk),
						watchdog: { everyMs: this.limits.diskPollMs, check: () => watch.check() },
					});
				} finally {
					await watch.end();
					await proxy?.close();
					if (socket) await Deno.remove(socket).catch(() => {});
				}
				if (!result.started) {
					this.deps.log('error', 'cage.failed', {
						runId: req.runId,
						diagnostics: result.diagnostics,
					});
					throw new ApiError(
						503,
						'cage_failed',
						`The sandbox could not start a cage: ${result.diagnostics || 'no reason given'}`,
					);
				}
				// SB-10: not cancelled with the request. A cancelled command's growth is still measured, so
				// the owner's total is never understated; when it cannot be, the worst is assumed.
				const after = await this.#measure(runDirs, {}).catch(() => Math.max(before, limit));
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

	// --- live sessions (D-076) ---------------------------------------------------------------------------

	/** Long-lived cages, counted apart from command cages so a terminal never takes a command slot. */
	readonly sessionGate = new Gate(LIMITS.sessionsRunning, 0, 0);
	readonly #sessions = new Map<string, SessionState>();
	readonly #sessionsByRun = new Map<string, SessionState>();
	readonly #sessionStops = new Map<string, (why: string) => void>();

	/** The open session of `runId`, or null. */
	sessionOf(runId: string): SessionState | null {
		return this.#sessionsByRun.get(runId) ?? null;
	}

	#session(owner: string, sessionId: string): SessionState {
		const session = this.#sessions.get(sessionId);
		if (session === undefined || session.owner !== owner) throw new ApiError(404, 'no_session', 'No such session.');
		return session;
	}

	/**
	 * Opens a shell session in a cage over the run's checkout. The session does not hold the run lock, so files
	 * can still be read and written beside it; it is ended by `sessionClose`, by removal of the run, by the
	 * idle and lifetime limits, by the disk watchdog, or when the shell exits.
	 */
	async openSession(
		owner: string,
		req: { runId: string; network: 'none' | 'registries' },
		quota?: DiskQuota,
	): Promise<{ session_id: string; created_at: string }> {
		this.#pruneEnded();
		if (this.#sessionsByRun.has(req.runId)) {
			throw new ApiError(409, 'session_open', 'This workspace already has an open session.');
		}
		const paths = this.paths(req.runId);
		if (!(await isDirectory(paths.checkout))) {
			throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
		}
		const git = await gitDirectory(paths.checkout);
		const release = await this.sessionGate.enter();
		const session = new SessionState(req.runId, owner);
		this.#sessions.set(session.id, session);
		this.#sessionsByRun.set(req.runId, session);
		const tmp = `${paths.state}/session-tmp`;
		let input: Deno.FsFile | null = null;
		try {
			await Deno.mkdir(paths.home, { recursive: true });
			await this.#resetTmp(tmp);
			input = await Deno.open(`${tmp}/${SESSION_INPUT.slice('/tmp/'.length)}`, {
				write: true,
				create: true,
				append: true,
			});
			await this.#checkFreeSpace();
			const runDirs = [paths.checkout, paths.state];
			const before = await this.#measure(runDirs, {});
			const { limit, ceiling } = quota ?? this.#defaultQuota();
			if (before > ceiling) {
				throw new ApiError(507, 'over_budget', 'This run is too far over its disk budget to open a session.');
			}
			const mounts: Mount[] = [
				{ source: tmp, target: '/tmp', writable: true },
				{ source: paths.home, target: CAGE_HOME, writable: true },
				{ source: paths.checkout, target: WORKSPACE, writable: true },
			];
			if (git) mounts.push({ source: git, target: `${WORKSPACE}/.git`, writable: false });
			const watch = await this.#watches.start({
				before,
				limit: before > limit ? before : limit,
				measure: (stop) => this.#measure(runDirs, { signal: stop }),
			});
			let proxy: RegistryProxy | null = null;
			let socket = '';
			if (req.network === 'registries') {
				socket = `${this.config.runtimeDir}/${crypto.randomUUID()}.sock`;
				proxy = RegistryProxy.open(socket, this.deps.proxy, req.runId);
				mounts.push({ source: socket, target: PROXY_SOCKET, writable: false });
			}
			const controller = new AbortController();
			let stopReason = '';
			this.#sessionStops.set(session.id, (why) => {
				stopReason = why;
				controller.abort();
			});
			const handle = input;
			const idle = setInterval(() => {
				if (session.idleMs > LIMITS.sessionIdleMs) this.#sessionStops.get(session.id)?.('idle');
				else if (session.ageMs > LIMITS.sessionLifetimeMs) this.#sessionStops.get(session.id)?.('lifetime');
			}, 5_000);
			// The cage runs for the session's life; its end is reported through the session state.
			void this.#run({
				mounts,
				chdir: WORKSPACE,
				env: proxy ? proxyEnv() : {},
				command: '',
				proxy: proxy !== null,
				stdin: false,
				interactive: true,
				noGrowth: before > limit,
			}, {
				timeoutMs: LIMITS.sessionLifetimeMs + 60_000,
				signal: controller.signal,
				onOutput: (chunk) => session.push(chunk),
				watchdog: { everyMs: this.limits.diskPollMs, check: () => watch.check() },
			}).then(
				(result) => {
					if (!result.started) {
						session.push(new TextEncoder().encode(`the sandbox could not start a cage: ${result.diagnostics}\n`));
						session.end(null, 'cage_failed');
					} else session.end(result.exitCode, result.killed === 'cancelled' ? stopReason || 'closed' : result.killed);
				},
				() => session.end(null, 'internal'),
			).finally(async () => {
				clearInterval(idle);
				this.#sessionStops.delete(session.id);
				this.#sessionsByRun.delete(req.runId);
				release();
				try {
					handle?.close();
				} catch {
					// Already closed.
				}
				await watch.end();
				await proxy?.close();
				if (socket) await Deno.remove(socket).catch(() => {});
				await this.#measure(runDirs, {}).catch(() => {});
				this.deps.log('info', 'session.ended', { runId: req.runId, sessionId: session.id });
				// The record stays readable so a reader can collect the end; `#pruneEnded` forgets it a minute later.
				session.lastActivity = Date.now();
			});
			this.#sessionInputs.set(session.id, input);
			this.deps.log('info', 'session.opened', { runId: req.runId, sessionId: session.id, network: req.network });
			return { session_id: session.id, created_at: new Date(session.createdAt).toISOString() };
		} catch (cause) {
			this.#sessions.delete(session.id);
			this.#sessionsByRun.delete(req.runId);
			release();
			try {
				input?.close();
			} catch {
				// Never opened.
			}
			throw cause;
		}
	}

	readonly #sessionInputs = new Map<string, Deno.FsFile>();

	/** Appends `data` to the session's input; a line without a trailing newline is not seen by the shell yet. */
	async sessionInput(owner: string, sessionId: string, data: string): Promise<{ accepted: true }> {
		const session = this.#session(owner, sessionId);
		if (session.ended) throw new ApiError(409, 'session_ended', 'The session has ended.');
		const bytes = new TextEncoder().encode(data);
		if (bytes.length > LIMITS.sessionInputBytes) throw new RequestError('data', 'is over 16 KiB');
		if (!session.countInput(bytes.length, LIMITS.sessionInputBytes * 256)) {
			this.#sessionStops.get(sessionId)?.('input_limit');
			throw new ApiError(409, 'session_ended', 'The session took too much input and was closed.');
		}
		const handle = this.#sessionInputs.get(sessionId);
		if (handle === undefined) throw new ApiError(409, 'session_ended', 'The session has ended.');
		let written = 0;
		while (written < bytes.length) written += await handle.write(bytes.subarray(written));
		return { accepted: true };
	}

	async sessionRead(owner: string, sessionId: string, after: number, waitMs: number): Promise<SessionRead> {
		this.#pruneEnded();
		const session = this.#session(owner, sessionId);
		session.lastActivity = Date.now();
		return await session.read(after, waitMs);
	}

	/** Forgets ended sessions a reader has had a minute to collect; no timer, so nothing is left pending. */
	#pruneEnded(): void {
		const now = Date.now();
		for (const [id, session] of this.#sessions) {
			if (session.ended && now - session.lastActivity > 60_000) this.#sessions.delete(id);
		}
	}

	sessionClose(owner: string, sessionId: string): { closed: true } {
		const session = this.#session(owner, sessionId);
		this.#sessionStops.get(sessionId)?.('closed');
		this.#sessionInputs.delete(sessionId);
		if (session.ended) this.#sessions.delete(sessionId);
		return { closed: true };
	}

	#closeSessionsOf(runId: string): void {
		const session = this.#sessionsByRun.get(runId);
		if (session === undefined) return;
		this.#sessionStops.get(session.id)?.('removed');
		this.#sessionInputs.delete(session.id);
	}

	diff(runId: string, signal?: AbortSignal): Promise<DiffResult> {
		return this.runs.hold(runId, signal, async (held) => {
			const paths = this.paths(runId);
			if (!(await isDirectory(paths.checkout))) {
				throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
			}
			if (!(await gitDirectory(paths.checkout))) {
				throw new ApiError(409, 'no_repository', "This run's checkout has no .git directory.");
			}
			const release = await this.gate.enter(held);
			try {
				await this.#checkFreeSpace();
				let attempt = await this.#diffOnce(paths, held);
				// A command can leave files only it could read (chmod 000); git then cannot stage them.
				// Giving the owner read access back changes nothing git records, so fix and try again.
				if (attempt.failed && /permission denied/i.test(attempt.said)) {
					await this.#fixPermissions(paths.checkout, { signal: held });
					attempt = await this.#diffOnce(paths, held);
				}
				if (attempt.failed) {
					throw new ApiError(
						500,
						'diff_failed',
						`git could not diff the checkout: ${attempt.said}`,
					);
				}
				// SB-6: cut to what one reply may carry as JSON, so the client never has to refuse it.
				return fitDiff(attempt.result!, LIMITS.responseBytes);
			} finally {
				release();
			}
		});
	}

	async #diffOnce(paths: ReturnType<Sandbox['paths']>, signal: AbortSignal) {
		await this.#resetTmp(paths.tmp, { signal });
		const limit = LIMITS.patchBytes * 2;
		const chunks: Uint8Array[] = [];
		let size = 0;
		// SB-1: git writes the blobs it stages into the run's /tmp. They may take one budget's worth on
		// top of the run's files (they are compressed copies of them), and are gone after the diff.
		const watch = await this.#watches.start({
			before: 0,
			limit: this.limits.diskBudgetBytes,
			measure: (stop) => this.#measure([paths.tmp], { signal: stop }),
		});
		let result: CageResult;
		try {
			result = await this.#run({
				mounts: [
					{ source: paths.checkout, target: WORKSPACE, writable: false },
					{ source: paths.tmp, target: '/tmp', writable: true },
				],
				chdir: WORKSPACE,
				env: { HOME: '/tmp' },
				command: diffScript(),
				proxy: false,
				stdin: false,
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
		await this.#resetTmp(paths.tmp).catch(() => {});
		const bytes = new Uint8Array(size);
		let at = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, at);
			at += chunk.length;
		}
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
			const said = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 2000)));
			return { failed: true, said: said.trim() || `exit ${result.exitCode}`, result: null };
		}
		return { failed: false, said: '', result: parseDiff(bytes, !cut) };
	}

	/**
	 * Removes the run's state, and gives the owner write access back throughout its checkout, so
	 * that the API's own removal of the checkout cannot fail on a folder a command made read-only.
	 */
	remove(runId: string): Promise<{ removed: boolean }> {
		return this.runs.removing(runId, async () => {
			// D-076: a live session over this run ends before its files go.
			this.#closeSessionsOf(runId);
			const paths = this.paths(runId);
			if (await isDirectory(paths.checkout)) await this.#fixPermissions(paths.checkout, { gated: true });
			const removed = await this.#removeTree(paths.state, { gated: true });
			this.deps.log('info', 'run.removed', { runId, removed });
			return { removed };
		});
	}

	/**
	 * Whether a cage can be made at all: the healthcheck, cached for half a minute. SB-3: requests
	 * that arrive while a probe runs share it, so /healthz can never start more than one cage.
	 */
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
			const result = await this.#run({
				mounts: [],
				chdir: '/',
				env: {},
				command: 'true',
				proxy: false,
				stdin: false,
			}, { timeoutMs: LIMITS.choreTimeoutMs, onOutput: () => {} });
			if (!result.started || result.exitCode !== 0) {
				error = result.diagnostics || `the test cage exited with ${result.exitCode}`;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		this.#probe = { at: Date.now(), error };
		return error;
	}

	/**
	 * Bytes the run's files take on disk: checkout and state, measured by du in a cage. For callers
	 * that hold no command slot (file writes); it waits for a housekeeping slot (SB-3).
	 */
	diskUsage(runId: string, signal?: AbortSignal): Promise<number> {
		const paths = this.paths(runId);
		return this.#measure([paths.checkout, paths.state], { signal, gated: true });
	}

	/**
	 * D-077: a file read, write or listing done in a cage that sees only the run's checkout (caged_files.ts), for
	 * a run whose live session can change the tree while the service would be checking it. The checkout's `.git`
	 * is mounted read-only over it, as for a command, so a write can never reach the repository's bookkeeping.
	 */
	fileOp(runId: string, op: CagedFileOp, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.runs.hold(runId, signal, async (held) => {
			const paths = this.paths(runId);
			if (!(await isDirectory(paths.checkout))) {
				throw new ApiError(404, 'no_workspace', 'This run has no checkout in the sandbox.');
			}
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
			const chunks: Uint8Array[] = [];
			let size = 0;
			const limit = CAGED_FILE_BYTES + 64 * 1024;
			const result = await this.#chore({
				mounts,
				chdir: WORKSPACE,
				env: { TTK_PATH: op.path },
				command: cagedScript(op.kind),
				proxy: false,
				stdin: op.kind === 'write',
			}, {
				timeoutMs: LIMITS.choreTimeoutMs,
				signal: held,
				onOutput: (chunk) => {
					if (size >= limit) return false;
					chunks.push(chunk);
					size += chunk.length;
					return size < limit;
				},
			}, true);
			await this.#resetTmp(paths.tmp).catch(() => {});
			if (!result.started) {
				throw new ApiError(
					503,
					'cage_failed',
					`The sandbox could not start a cage: ${result.diagnostics || 'no reason given'}`,
				);
			}
			if (result.killed === 'cancelled') held.throwIfAborted();
			if (result.killed === 'timeout') throw new ApiError(504, 'file_timeout', 'The file operation took too long.');
			const bytes = new Uint8Array(size);
			let at = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, at);
				at += chunk.length;
			}
			// Cut short for size: only a read can say this much, and it says "too large".
			return cagedResult(op, result.killed === 'output' ? EXIT.tooLarge : result.exitCode, bytes);
		});
	}

	/**
	 * Bytes the given folders take, by du in a cage. SB-1: the cage keeps CAP_DAC_READ_SEARCH in
	 * its own user namespace, so a directory a command made unreadable (chmod 000) is counted like
	 * any other; the folders are mounted read-only, and du's own complaints are discarded so that
	 * no file name can pose as its total.
	 */
	async #measure(dirs: string[], options: ChoreOptions): Promise<number> {
		const mounts: Mount[] = [];
		for (const [i, dir] of dirs.entries()) {
			if (await isDirectory(dir)) mounts.push({ source: dir, target: `/m/${i}`, writable: false });
		}
		if (mounts.length === 0) return 0;
		let tail = '';
		const decoder = new TextDecoder();
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
				tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4096);
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

	#defaultQuota(): DiskQuota {
		return { limit: this.limits.diskBudgetBytes, ceiling: 2 * this.limits.diskBudgetBytes };
	}

	/** A housekeeping cage, waiting for a housekeeping slot when no command slot is held (SB-3). */
	async #chore(
		spec: Omit<CageSpec, 'filter' | 'processes'>,
		run: { timeoutMs: number; signal?: AbortSignal; onOutput(chunk: Uint8Array): boolean | void },
		gated: boolean,
	): Promise<CageResult> {
		const release = gated ? await this.chores.enter(run.signal) : null;
		try {
			return await this.#run(spec, run);
		} finally {
			release?.();
		}
	}

	#run(
		spec: Omit<CageSpec, 'filter' | 'processes'>,
		run: {
			timeoutMs: number;
			signal?: AbortSignal;
			onOutput(chunk: Uint8Array): boolean | void;
			watchdog?: { everyMs: number; check(): Promise<string | null> };
		},
	): Promise<CageResult> {
		const filter = this.config.filter;
		return runCage({
			bwrap: this.config.bwrap,
			args: cageArgs(
				{ ...spec, filter: filter !== null, processes: LIMITS.cageProcesses },
				this.config.system,
			),
			input: filter,
			...run,
		});
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

	async #resetTmp(tmp: string, options: ChoreOptions = {}): Promise<void> {
		await this.#removeTree(tmp, options);
		await Deno.mkdir(tmp, { recursive: true });
	}

	/** Removes a folder a command wrote, even one it made read-only; false when there was none. */
	async #removeTree(path: string, options: ChoreOptions): Promise<boolean> {
		try {
			await Deno.remove(path, { recursive: true });
			return true;
		} catch (err) {
			if (err instanceof Deno.errors.NotFound) return false;
			if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
		}
		await this.#fixPermissions(path, options);
		await Deno.remove(path, { recursive: true });
		return true;
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
		// SB-10: a cancelled request ends here rather than failing later on what was left locked.
		options.signal?.throwIfAborted();
	}
}

export const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/**
 * What serves a command's proxy socket: the registry proxy for `registries`, or for a clone's step (`git`, R12) the
 * egress the workspace service built — the git-host proxy or the credentialed forwarder. A `git` request without one
 * is a bug in the service, never something a request can cause (`parseExec` refuses `git`).
 */
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

/**
 * The working directory must exist, and no part of it may be a symbolic link: inside the cage a
 * link could only point within the cage, but a clear refusal beats a confusing one.
 */
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
