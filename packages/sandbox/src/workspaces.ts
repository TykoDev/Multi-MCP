import { type SandboxBackend, type SandboxOperation } from './client.ts';
import {
	cloneEnv,
	cloneOutcome,
	cloneScript,
	type GitOrigin,
	parseCloneTimeout,
	parseCloneUrl,
	parseDepth,
	parseGitRef,
} from './clone.ts';
import { GitForwarder, type GitRemote } from './git_forwarder.ts';
import { type OpenEgress, RegistryProxy } from './proxy.ts';
import { type ExecRequest, parseCwd, parseExec, parseRunId, RequestError, RUN_ID } from './request.ts';
import { OwnerGates } from './gate.ts';
import { ApiError, type DiskQuota, type ExecResult, type Sandbox } from './sandbox.ts';
import { LIMITS } from './limits.ts';

/** What runs a workspace's commands: the bubblewrap `Sandbox` (the default) or the Docker backend. */
export type Backend =
	& Pick<
		Sandbox,
		| 'exec'
		| 'diff'
		| 'remove'
		| 'health'
		| 'diskUsage'
		| 'openSession'
		| 'sessionInput'
		| 'sessionRead'
		| 'sessionClose'
		| 'sessionOf'
		| 'fileOp'
	>
	& {
		/** Which backend this is, as `/healthz` reports it. */
		readonly kind: SandboxBackend;
		/** At start-up, every workspace and its owner hash, so the backend can reconcile what it left running. */
		reconcile?(owners: ReadonlyMap<string, string>): Promise<void>;
		/** A new workspace's owner hash, before its first command. */
		assign?(runId: string, owner: string): void;
		/** True while a Docker container may run something, so file operations must stay inside it (`fileOp`). */
		cagesFiles?(runId: string): boolean;
	};
/** Where this service may clone from; both empty (the default) turns `clone` off. */
export interface CloneSettings {
	/** `TTK_SANDBOX_GIT_HOSTS`: public clones of any repository on these exact names, through the git-host proxy. */
	readonly hosts: ReadonlySet<string>;
	/** The operator's credentialed remotes, by id, reached through the forwarder (git_forwarder.ts). */
	readonly remotes: readonly GitRemote[];
	/** Tests only: what serves a public clone's proxy socket; the registry proxy with the git hosts unless named. */
	readonly publicEgress?: (hosts: ReadonlySet<string>) => OpenEgress;
	/** Tests only: what serves a credentialed clone's socket; the forwarder for the remote unless named. */
	readonly forwardEgress?: (remote: GitRemote) => OpenEgress;
}

const NO_CLONE: CloneSettings = { hosts: new Set(), remotes: [] };

const FILE_BYTES = 256 * 1024;
const MAX_WORKSPACES = 1024;
/** An owner record's file name; temporary files (`.tmp-*`) never match it. */
const RECORD = /^[0-9a-f-]{36}\.json$/;
const encoder = new TextEncoder();

function fields(args: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new RequestError(key, 'unknown field');
}

async function ownerHash(principal: string): Promise<string> {
	if (!principal || principal.length > 1024 || principal.includes('\0')) {
		throw new RequestError('principal', 'invalid owner');
	}
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(principal));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The file at `path` without following a link, or null when there is none. */
async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
	try {
		return await Deno.lstat(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	}
}

/** Creates `path`, which must not exist (so no link is followed), with `bytes`, synced to disk. */
async function writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void> {
	const file = await Deno.open(path, { write: true, createNew: true, mode });
	try {
		let written = 0;
		while (written < bytes.length) written += await file.write(bytes.subarray(written));
		await file.sync();
	} finally {
		file.close();
	}
}

/** Writes `bytes` to a new file beside `path`, then renames it over `path`: all or nothing. */
async function replace(path: string, bytes: Uint8Array, mode: number): Promise<void> {
	const temp = `${path.slice(0, path.lastIndexOf('/'))}/.tmp-${crypto.randomUUID()}`;
	await writeNew(temp, bytes, mode);
	try {
		await Deno.rename(temp, path);
	} catch (error) {
		await Deno.remove(temp).catch(() => {});
		throw error;
	}
}

/** What an owner record says its workspace keeps on disk; the worst case when it does not say. */
function recordedUsage(metadata: Record<string, unknown>): number {
	const bytes = metadata.disk_bytes;
	return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : LIMITS.diskBudgetBytes;
}

/** The limits a new workspace works within, reported by `create`. */
function effectiveLimits(quota: DiskQuota, usage: number): Record<string, number> {
	return {
		disk_budget_bytes: Math.max(0, quota.limit),
		disk_used_bytes: usage,
		file_bytes: FILE_BYTES,
		exec_timeout_default_ms: LIMITS.defaultTimeoutMs,
		exec_timeout_max_ms: LIMITS.maxTimeoutMs,
		exec_output_bytes: LIMITS.outputBytes,
		session_idle_ms: LIMITS.sessionIdleMs,
		session_lifetime_ms: LIMITS.sessionLifetimeMs,
		session_input_bytes: LIMITS.sessionInputBytes,
	};
}

/** Workspace lifecycle and file operations; ownership metadata is never mounted into a cage. */
export class WorkspaceService {
	readonly #busy = new Set<string>();
	readonly #controllers = new Map<string, AbortController>();
	readonly #finishes = new Map<string, Promise<void>>();
	/** The workspace being created, if any: one at a time, and the sweep leaves it alone. */
	#creating: string | null = null;
	readonly #clone: CloneSettings;
	readonly #remotes: ReadonlyMap<string, GitRemote>;
	/** Each owner's share of the command slots, taken before the backend's own gate. */
	readonly #commandShares = new OwnerGates();

	constructor(readonly root: string, readonly backend: Backend, clone: CloneSettings = NO_CLONE) {
		this.#clone = clone;
		this.#remotes = new Map(clone.remotes.map((remote) => [remote.id, remote]));
	}

	/** Whether this service clones at all — it was given git hosts, remotes, or both. */
	get clones(): boolean {
		return this.#clone.hosts.size > 0 || this.#remotes.size > 0;
	}

	/** Runs `work`, which takes one of the backend's command slots, within `owner`'s share of them. */
	async #shared<T>(owner: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
		const release = await this.#commandShares.enter(owner, signal);
		try {
			return await work();
		} finally {
			release();
		}
	}

	/** Initializes the private ownership directory without following a symlink. */
	async initialize(): Promise<void> {
		await Deno.mkdir(this.root, { recursive: true, mode: 0o700 });
		await this.#directory(this.root);
		await Deno.mkdir(`${this.root}/.owners`, { recursive: true, mode: 0o700 });
		await this.#directory(`${this.root}/.owners`);
		let entries = await this.#entries();
		// The backend learns every workspace's owner, and settles what an earlier run of it left behind.
		await this.backend.reconcile?.(
			new Map(entries.flatMap(({ id, metadata }) => (metadata === null ? [] : [[id, metadata.owner as string]]))),
		);
		// A clone the service stopped in the middle of (a crash, a restart) never finished provisioning; its
		// half-written .git would stay read-only for good, so the workspace goes, as a failed clone's does.
		for (const { id, metadata } of entries) {
			if (metadata?.provisioning === true) await this.#discard(id);
		}
		entries = await this.#entries();
		// A record that holds no disk use yet is measured once, so owner totals
		// start out right; one that cannot be measured counts as a full budget until it is.
		for (const { id, metadata } of entries) {
			if (metadata === null || typeof metadata.disk_bytes === 'number') continue;
			await this.backend.diskUsage(id).then((bytes) => this.#record(id, bytes), () => {});
		}
	}

	/** Readiness without diagnostics, the backend, and whether it clones. */
	async health(): Promise<{ ok: boolean; backend: SandboxBackend; clone: boolean }> {
		return { ok: (await this.backend.health()).ok, backend: this.backend.kind, clone: this.clones };
	}

	/** Calls a validated operation bound to the authenticated gateway principal. */
	async call(
		principal: string,
		operation: SandboxOperation,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const owner = await ownerHash(principal);
		if (operation === 'create') return await this.#create(owner, args, signal);
		if (operation === 'clone') return await this.#cloneWorkspace(owner, args, signal);
		if (operation === 'list' && args.workspace_id === undefined) {
			fields(args, []);
			const workspaces: Record<string, unknown>[] = [];
			for (const { id, metadata } of await this.#entries()) {
				if (metadata?.owner !== owner) continue;
				workspaces.push({
					workspace_id: id,
					created_at: metadata.created_at,
					...(typeof metadata.name === 'string' ? { name: metadata.name } : {}),
					// A workspace in use is listed too; the flag says a call on it now would be refused.
					...(this.#busy.has(id) ? { busy: true } : {}),
				});
			}
			// What a clone may name — the git hosts and the remotes' ids, never a remote's URL or credential.
			if (!this.clones) return { workspaces };
			return { workspaces, clone: { hosts: [...this.#clone.hosts], remotes: [...this.#remotes.keys()] } };
		}
		// Session operations never take the workspace lock (a long poll must not keep file operations out); the
		// backend binds every call after `session_open` to the same owner hash.
		if (operation === 'session_input' || operation === 'session_read' || operation === 'session_close') {
			if (typeof args.session_id !== 'string' || !RUN_ID.test(args.session_id)) {
				throw new RequestError('session_id', 'a session id is required');
			}
			if (operation === 'session_close') {
				fields(args, ['session_id']);
				return { ...this.backend.sessionClose(owner, args.session_id) };
			}
			if (operation === 'session_input') {
				fields(args, ['session_id', 'data']);
				if (typeof args.data !== 'string') throw new RequestError('data', 'must be a string');
				return { ...await this.backend.sessionInput(owner, args.session_id, args.data) };
			}
			fields(args, ['session_id', 'after', 'wait_ms']);
			const after = args.after === undefined ? 0 : args.after;
			const waitMs = args.wait_ms === undefined ? 0 : args.wait_ms;
			if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) {
				throw new RequestError('after', 'must be a non-negative integer');
			}
			if (typeof waitMs !== 'number' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > LIMITS.sessionReadWaitMs) {
				throw new RequestError('wait_ms', `must be an integer from 0 to ${LIMITS.sessionReadWaitMs}`);
			}
			return { ...await this.backend.sessionRead(owner, args.session_id, after, waitMs) };
		}
		const id = parseRunId(args.workspace_id);
		const metadata = await this.#metadata(id);
		if (metadata.owner !== owner) throw new ApiError(404, 'no_workspace', 'Workspace not found.');
		// A cloning workspace is the clone's alone until its `.git` is in place (else nothing mounts it read-only);
		// only `remove`, which cancels the clone, goes on.
		if (metadata.provisioning === true && operation !== 'remove') {
			throw new ApiError(409, 'run_busy', 'Workspace is busy.');
		}
		if (operation === 'session_open') {
			fields(args, ['workspace_id', 'network']);
			const network = args.network === undefined ? 'none' : args.network;
			if (network !== 'none' && network !== 'registries') {
				throw new RequestError('network', 'must be none or registries');
			}
			await this.#directory(`${this.root}/${id}`);
			// Opened under the workspace lock, so no file operation on the fast path is still checking a path
			// when the shell starts; every one after it sees the session and runs caged.
			if (this.#busy.has(id)) throw new ApiError(409, 'run_busy', 'Workspace is busy.');
			this.#busy.add(id);
			try {
				return { ...await this.backend.openSession(owner, { runId: id, network }, await this.#quota(owner, id)) };
			} finally {
				this.#busy.delete(id);
			}
		}
		// Removal still works when the directory is already gone (a crash between the two deletions).
		if (operation !== 'remove' || await lstatOrNull(`${this.root}/${id}`) !== null) {
			await this.#directory(`${this.root}/${id}`);
		}
		if (operation === 'remove') {
			fields(args, ['workspace_id']);
			this.#controllers.get(id)?.abort();
			await this.#finishes.get(id);
		}
		return await this.#locked(id, signal, (held) => this.#operation(id, owner, operation, args, held));
	}

	/**
	 * Runs `work` holding the workspace's lock (409 `run_busy` otherwise), cancelled by `signal` or a `remove`. With
	 * `adopt`, the lock takes over the busy slot the caller (a clone) already holds.
	 */
	async #locked<T>(
		id: string,
		signal: AbortSignal | undefined,
		work: (held: AbortSignal) => Promise<T>,
		adopt = false,
	): Promise<T> {
		if (!adopt) {
			if (this.#busy.has(id)) throw new ApiError(409, 'run_busy', 'Workspace is busy.');
			this.#busy.add(id);
		}
		const controller = new AbortController();
		this.#controllers.set(id, controller);
		const abort = (): void => controller.abort();
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) controller.abort();
		let finish!: () => void;
		this.#finishes.set(
			id,
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		try {
			controller.signal.throwIfAborted();
			return await work(controller.signal);
		} finally {
			signal?.removeEventListener('abort', abort);
			this.#busy.delete(id);
			this.#controllers.delete(id);
			this.#finishes.delete(id);
			finish();
		}
	}

	/**
	 * Removes what a crash left behind — checkouts or state without an owner record, half-written records — once
	 * untouched for LIMITS.orphanAgeMs. A workspace with a record is never touched.
	 */
	async sweep(now = Date.now()): Promise<number> {
		const stale = (info: Deno.FileInfo) => (info.mtime?.getTime() ?? now) <= now - LIMITS.orphanAgeMs;
		const owned = new Set<string>();
		let count = 0;
		for await (const entry of Deno.readDir(`${this.root}/.owners`)) {
			if (RECORD.test(entry.name)) {
				owned.add(entry.name.slice(0, -5));
			} else if (entry.isFile && entry.name.startsWith('.tmp-')) {
				const path = `${this.root}/.owners/${entry.name}`;
				if (stale(await Deno.lstat(path))) {
					await Deno.remove(path);
					count++;
				}
			}
		}
		const orphans = new Set<string>();
		for (const dir of [this.root, `${this.root}/.sandbox`]) {
			try {
				for await (const entry of Deno.readDir(dir)) {
					if (entry.isDirectory && RUN_ID.test(entry.name) && !owned.has(entry.name)) orphans.add(entry.name);
				}
			} catch (error) {
				if (!(error instanceof Deno.errors.NotFound)) throw error;
			}
		}
		for (const id of orphans) {
			if (this.#busy.has(id) || this.#creating === id) continue;
			const ages = await Promise.all(
				[`${this.root}/${id}`, `${this.root}/.sandbox/${id}`].map((path) => Deno.lstat(path).then(stale, () => true)),
			);
			if (!ages.every(Boolean)) continue;
			this.#busy.add(id);
			try {
				await this.backend.remove(id);
				await Deno.remove(`${this.root}/${id}`, { recursive: true }).catch((error) => {
					if (!(error instanceof Deno.errors.NotFound)) throw error;
				});
				count++;
			} catch {
				// Tried again by the next sweep.
			} finally {
				this.#busy.delete(id);
			}
		}
		return count;
	}

	async #metadata(id: string): Promise<Record<string, unknown>> {
		const path = `${this.root}/.owners/${id}.json`;
		try {
			const info = await Deno.lstat(path);
			if (!info.isFile || info.isSymlink || info.size > 4096) throw new Error('Invalid metadata');
			const metadata = JSON.parse(await Deno.readTextFile(path));
			if (!metadata || typeof metadata !== 'object' || typeof metadata.owner !== 'string') {
				throw new Error('Invalid metadata');
			}
			return metadata;
		} catch {
			throw new ApiError(404, 'no_workspace', 'Workspace not found.');
		}
	}

	/** Every owner record, with null for one that cannot be read: skipped, never fatal. */
	async #entries(): Promise<{ id: string; metadata: Record<string, unknown> | null }[]> {
		const entries: { id: string; metadata: Record<string, unknown> | null }[] = [];
		for await (const entry of Deno.readDir(`${this.root}/.owners`)) {
			if (!entry.isFile || !RECORD.test(entry.name)) continue;
			const id = entry.name.slice(0, -5);
			entries.push({ id, metadata: await this.#metadata(id).catch(() => null) });
		}
		return entries;
	}

	/** A record is written whole or not at all: new file, synced, renamed, directory synced. */
	async #writeMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
		await replace(`${this.root}/.owners/${id}.json`, encoder.encode(JSON.stringify(metadata)), 0o600);
		try {
			const directory = await Deno.open(`${this.root}/.owners`, { read: true });
			try {
				await directory.sync();
			} finally {
				directory.close();
			}
		} catch {
			// Not every platform opens a directory (Windows); the rename itself is still atomic.
		}
	}

	/** Keeps the workspace's disk use in its record, for its owner's total. */
	async #record(id: string, bytes: number): Promise<void> {
		const metadata = await this.#metadata(id);
		await this.#writeMetadata(id, { ...metadata, disk_bytes: Math.max(0, Math.round(bytes)) });
	}

	/**
	 * What a workspace may keep: its budget, or what its owner's others leave of LIMITS.ownerDiskBytes. Over it,
	 * commands may only remove files; a budget past it, nothing runs.
	 */
	async #quota(owner: string, id: string | null): Promise<DiskQuota> {
		let others = 0;
		for (const entry of await this.#entries()) {
			if (entry.id !== id && entry.metadata?.owner === owner) others += recordedUsage(entry.metadata);
		}
		const budget = LIMITS.diskBudgetBytes;
		return {
			limit: Math.min(budget, LIMITS.ownerDiskBytes - others),
			ceiling: Math.min(2 * budget, LIMITS.ownerDiskBytes + budget - others),
		};
	}

	async #directory(path: string): Promise<void> {
		const info = await Deno.lstat(path);
		if (!info.isDirectory || info.isSymlink) throw new ApiError(409, 'bad_checkout', 'Unsafe workspace directory.');
	}

	async #create(owner: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		fields(args, ['name', 'files']);
		if (
			args.name !== undefined && (typeof args.name !== 'string' || args.name.length > 128 || args.name.includes('\0'))
		) {
			throw new RequestError('name', 'must be a display name of at most 128 characters');
		}
		if (args.files !== undefined && (!args.files || typeof args.files !== 'object' || Array.isArray(args.files))) {
			throw new RequestError('files', 'must be a record of paths and text');
		}
		const seed = Object.entries((args.files ?? {}) as Record<string, unknown>);
		let seedBytes = 0;
		if (seed.length > 64) throw new RequestError('files', 'at most 64 initial files are allowed');
		for (const [path, content] of seed) {
			if (!parseCwd(path) || typeof content !== 'string') {
				throw new RequestError('files', 'each file must name a path and text');
			}
			seedBytes += encoder.encode(content).length;
			if (seedBytes > FILE_BYTES) throw new RequestError('files', 'initial files may total at most 256 KiB');
		}
		if (this.#creating !== null) throw new ApiError(429, 'busy', 'Workspace provisioning is busy.');
		const id = crypto.randomUUID();
		this.#creating = id;
		try {
			const entries = await this.#entries();
			const owned = entries.filter((entry) => entry.metadata?.owner === owner).length;
			if (entries.length >= MAX_WORKSPACES || owned >= 128) throw new ApiError(429, 'busy', 'Workspace limit reached.');
			const quota = await this.#quota(owner, null);
			if (quota.limit <= 0) {
				throw new ApiError(507, 'over_budget', "This owner's workspaces already use all of their disk quota.");
			}
			await Deno.mkdir(`${this.root}/${id}`, { mode: 0o700 });
			this.backend.assign?.(id, owner);
			// Not within the owner's share: under `#creating`, waiting behind the owner's long command would hold up
			// every other owner's create, and this short `git init` is already one at a time.
			const initialized = await this.backend.exec(
				parseExec({
					runId: id,
					command:
						'git init -q -b main . && git -c user.name=Sandbox -c user.email=sandbox@localhost commit --allow-empty -qm Initial',
				}),
				signal,
				quota,
			);
			if (initialized.exitCode !== 0) throw new ApiError(503, 'cage_failed', 'Workspace provisioning failed.');
			// The seed is at most 256 KiB in all, so one check against the budget does, rather than
			// a measuring cage per file.
			const usage = initialized.diskBytes + seedBytes;
			if (usage > quota.limit) throw new ApiError(507, 'over_budget', 'Workspace disk budget exceeded.');
			for (const [path, content] of seed) {
				signal?.throwIfAborted();
				await this.#writeFile(await this.#path(id, path, true), content as string);
			}
			const created_at = new Date().toISOString();
			const display = args.name === undefined ? {} : { name: args.name };
			await this.#writeMetadata(id, { owner, created_at, ...display, disk_bytes: usage });
			// What this workspace may use, as the service will enforce it, so a caller plans within it.
			return { workspace_id: id, created_at, ...display, limits: effectiveLimits(quota, usage) };
		} catch (error) {
			await this.backend.remove(id).catch(() => {});
			await Deno.remove(`${this.root}/${id}`, { recursive: true }).catch(() => {});
			throw error;
		} finally {
			this.#creating = null;
		}
	}

	/** Removes a workspace whole — its backend state, its checkout and its owner record — as a failed clone does. */
	async #discard(id: string): Promise<void> {
		await this.backend.remove(id).catch(() => {});
		await Deno.remove(`${this.root}/${id}`, { recursive: true }).catch(() => {});
		await Deno.remove(`${this.root}/.owners/${id}.json`).catch(() => {});
	}

	/**
	 * A workspace from a git remote: exactly one of `url` (host on `TTK_SANDBOX_GIT_HOSTS`) and `remote` (an operator
	 * remote's id), with ref, depth and time limit all checked before disk or network is touched. The record is written
	 * as provisioning at the full budget, then the clone runs under the workspace's lock in the provisioning cage
	 * (`.git` writable once, read-only after). Any failure, cancel or `remove` removes the workspace.
	 */
	async #cloneWorkspace(
		owner: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		fields(args, ['url', 'remote', 'ref', 'depth', 'name', 'timeout_ms']);
		if ((args.url === undefined) === (args.remote === undefined)) {
			throw new RequestError('url', 'give exactly one of url and remote');
		}
		if (
			args.name !== undefined && (typeof args.name !== 'string' || args.name.length > 128 || args.name.includes('\0'))
		) {
			throw new RequestError('name', 'must be a display name of at most 128 characters');
		}
		let origin: GitOrigin;
		let egress: OpenEgress;
		let transport: 'public' | 'forwarded';
		if (args.url !== undefined) {
			if (this.#clone.hosts.size === 0) throw new RequestError('url', 'public clones are not enabled on this sandbox');
			origin = parseCloneUrl(args.url, this.#clone.hosts);
			egress = (this.#clone.publicEgress ?? publicEgress)(this.#clone.hosts);
			transport = 'public';
		} else {
			const remote = typeof args.remote === 'string' ? this.#remotes.get(args.remote) : undefined;
			if (remote === undefined) throw new RequestError('remote', 'is not a remote this sandbox is configured with');
			origin = remote.origin;
			egress = (this.#clone.forwardEgress ?? forwardEgress)(remote);
			transport = 'forwarded';
		}
		const ref = parseGitRef(args.ref);
		const depth = parseDepth(args.depth);
		const timeoutMs = parseCloneTimeout(args.timeout_ms);
		if (this.#creating !== null) throw new ApiError(429, 'busy', 'Workspace provisioning is busy.');
		const id = crypto.randomUUID();
		const created_at = new Date().toISOString();
		const display = args.name === undefined ? {} : { name: args.name };
		this.#creating = id;
		// Busy from before the record exists until the clone ends; the lock adopts this slot, so nothing gets in.
		this.#busy.add(id);
		try {
			const entries = await this.#entries();
			const owned = entries.filter((entry) => entry.metadata?.owner === owner).length;
			if (entries.length >= MAX_WORKSPACES || owned >= 128) throw new ApiError(429, 'busy', 'Workspace limit reached.');
			const quota = await this.#quota(owner, null);
			if (quota.limit <= 0) {
				throw new ApiError(507, 'over_budget', "This owner's workspaces already use all of their disk quota.");
			}
			await Deno.mkdir(`${this.root}/${id}`, { mode: 0o700 });
			this.backend.assign?.(id, owner);
			// Counted at its whole budget until the clone is measured; `provisioning` until it has finished.
			await this.#writeMetadata(id, { owner, created_at, ...display, disk_bytes: quota.limit, provisioning: true });
		} catch (error) {
			await this.#discard(id);
			this.#busy.delete(id);
			throw error;
		} finally {
			this.#creating = null;
		}
		// A failure inside the lock discards the workspace before the lock is let go, so a `remove` that cancelled the
		// clone (and waits for the lock) finds it already gone rather than racing the discard.
		let discarded = false;
		try {
			const { outcome, usage, quota } = await this.#locked(id, signal, async (held) => {
				try {
					const quota = await this.#quota(owner, id);
					const request: ExecRequest = {
						runId: id,
						command: cloneScript(transport),
						cwd: '',
						timeoutMs,
						network: 'git',
						env: cloneEnv({ url: origin.url, ref, depth }),
						stdin: null,
						egress,
					};
					const result = await this.#shared(owner, held, () => this.backend.exec(request, held, quota));
					held.throwIfAborted();
					if (result.killed === 'disk' || result.overBudget) {
						throw new ApiError(507, 'over_budget', 'The clone does not fit the workspace disk budget.');
					}
					if (result.killed === 'timeout') throw new ApiError(504, 'clone_timeout', 'The clone took too long.');
					const outcome = result.exitCode === 0 && result.killed === null ? cloneOutcome(result.output) : null;
					if (outcome === null) throw new ApiError(502, 'clone_failed', 'The clone did not complete.');
					await this.#writeMetadata(id, { owner, created_at, ...display, disk_bytes: result.diskBytes });
					return { outcome, usage: result.diskBytes, quota };
				} catch (error) {
					discarded = true;
					await this.#discard(id);
					throw error;
				}
			}, /* adopt the busy slot taken before the record was written */ true);
			return {
				workspace_id: id,
				created_at,
				...display,
				commit: outcome.commit,
				ref: outcome.ref,
				limits: effectiveLimits(quota, usage),
			};
		} catch (error) {
			// Cancelled before the step could start: nothing else holds the workspace, so it goes here.
			if (!discarded) await this.#discard(id);
			throw error;
		}
	}

	async #path(id: string, value: unknown, createParents = false): Promise<string> {
		const relative = parseCwd(value);
		let path = `${this.root}/${id}`;
		const parts = relative.split('/').filter(Boolean);
		for (const [index, part] of parts.entries()) {
			// Windows drive names and alternate streams are rejected on every platform.
			if (part.includes(':')) throw new RequestError('path', 'invalid path segment');
			path += `/${part}`;
			let info: Deno.FileInfo;
			try {
				info = await Deno.lstat(path);
			} catch (error) {
				if (!(error instanceof Deno.errors.NotFound)) throw error;
				if (index === parts.length - 1) return path;
				if (!createParents) throw new ApiError(404, 'not_found', 'Path not found.');
				await Deno.mkdir(path, { mode: 0o700 });
				continue;
			}
			if (info.isSymlink || (index < parts.length - 1 && !info.isDirectory)) {
				throw new RequestError('path', 'symbolic links and non-directory parents are forbidden');
			}
		}
		return path;
	}

	/** Written to a new file in the validated parent and renamed, so a write never goes through a planted link. */
	async #writeFile(path: string, content: string): Promise<number> {
		const existing = await lstatOrNull(path);
		if (existing !== null && (!existing.isFile || existing.isSymlink)) {
			throw new RequestError('path', 'must name a regular file');
		}
		const bytes = encoder.encode(content);
		await replace(path, bytes, typeof existing?.mode === 'number' ? existing.mode & 0o777 : 0o600);
		return bytes.length;
	}

	/**
	 * A command with its owner's quota. While it runs the record counts the workspace at its limit, so two commands
	 * cannot spend the same room and a crash leaves the worst case; afterwards, what was measured.
	 */
	async #exec(id: string, owner: string, request: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
		const quota = await this.#quota(owner, id);
		let usage = recordedUsage(await this.#metadata(id));
		await this.#record(id, Math.max(usage, quota.limit));
		try {
			const result = await this.#shared(owner, signal, () => this.backend.exec(request, signal, quota));
			usage = result.diskBytes;
			return result;
		} finally {
			await this.#record(id, usage).catch(() => {});
		}
	}

	/** A file operation done in a cage; a write counts its whole size (the old size is not looked up outside). */
	async #caged(
		id: string,
		owner: string,
		operation: SandboxOperation,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const path = parseCwd(args.path);
		if (path.split('/').some((part) => part.includes(':'))) throw new RequestError('path', 'invalid path segment');
		if (operation === 'list') return await this.backend.fileOp(id, { kind: 'list', path }, signal);
		if (operation === 'read') return await this.backend.fileOp(id, { kind: 'read', path }, signal);
		const content = args.content as string;
		const size = encoder.encode(content).length;
		const usage = await this.backend.diskUsage(id, signal);
		if (size > 0 && usage + size > (await this.#quota(owner, id)).limit) {
			throw new ApiError(507, 'over_budget', 'Workspace disk budget exceeded.');
		}
		const reply = await this.backend.fileOp(id, { kind: 'write', path, content }, signal);
		await this.#record(id, usage + size);
		return { ...reply, path };
	}

	async #operation(
		id: string,
		owner: string,
		operation: SandboxOperation,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (operation === 'exec') {
			fields(args, ['workspace_id', 'command', 'cwd', 'timeout_ms', 'network', 'env', 'stdin']);
			const request = parseExec({
				runId: id,
				command: args.command,
				cwd: args.cwd,
				timeoutMs: args.timeout_ms,
				network: args.network,
				env: args.env,
				stdin: args.stdin,
			});
			return { ...await this.#exec(id, owner, request, signal) };
		}
		if (operation === 'diff') {
			fields(args, ['workspace_id']);
			return { ...await this.#shared(owner, signal, () => this.backend.diff(id, signal)) };
		}
		if (operation === 'remove') {
			await this.backend.remove(id);
			await Deno.remove(`${this.root}/${id}`, { recursive: true }).catch((error) => {
				if (!(error instanceof Deno.errors.NotFound)) throw error;
			});
			// A clone this removal cancelled has already discarded its workspace, record included.
			await Deno.remove(`${this.root}/.owners/${id}.json`).catch((error) => {
				if (!(error instanceof Deno.errors.NotFound)) throw error;
			});
			return { removed: true };
		}
		fields(args, operation === 'write' ? ['workspace_id', 'path', 'content'] : ['workspace_id', 'path']);
		if (
			operation === 'write' &&
			(typeof args.content !== 'string' || encoder.encode(args.content).length > FILE_BYTES)
		) {
			throw new RequestError('content', 'must be a string of at most 256 KiB');
		}
		if ((operation === 'read' || operation === 'write') && (typeof args.path !== 'string' || !parseCwd(args.path))) {
			throw new RequestError('path', 'a file path is required');
		}
		// A live session (or a process left in a Docker container) can change the tree at any moment, so the
		// operation runs where a link cannot leave the checkout.
		if (this.backend.sessionOf(id) !== null || this.backend.cagesFiles?.(id) === true) {
			return await this.#caged(id, owner, operation, args, signal);
		}
		const path = await this.#path(id, args.path, operation === 'write');
		if (operation === 'write') {
			const content = args.content as string;
			const existing = await lstatOrNull(path);
			if (existing !== null && !existing.isFile) throw new RequestError('path', 'must name a regular file');
			// A write that does not grow the file is allowed over the budget: it is how one shrinks.
			const grows = encoder.encode(content).length - (existing?.size ?? 0);
			const usage = await this.backend.diskUsage(id, signal);
			if (grows > 0 && usage + grows > (await this.#quota(owner, id)).limit) {
				throw new ApiError(507, 'over_budget', 'Workspace disk budget exceeded.');
			}
			// Nothing of the workspace runs here: no session, and no container left running; every start
			// of either happens under this workspace's lock, which this operation holds.
			const bytes = await this.#writeFile(path, content);
			await this.#record(id, usage + grows);
			return { written: true, bytes, path: parseCwd(args.path) };
		}
		if (operation === 'read') {
			const info = await Deno.lstat(path);
			if (!info.isFile || info.size > FILE_BYTES) {
				throw new ApiError(413, 'too_large', 'Only regular files up to 256 KiB may be read.');
			}
			const file = await Deno.open(path, { read: true });
			try {
				// What was opened is what was checked; a path swapped for a link meanwhile is refused.
				const opened = await file.stat();
				if (!opened.isFile || opened.dev !== info.dev || opened.ino !== info.ino) {
					throw new RequestError('path', 'changed while it was being read');
				}
				const bytes = new Uint8Array(FILE_BYTES + 1);
				let size = 0;
				while (size < bytes.length) {
					const n = await file.read(bytes.subarray(size));
					if (n === null) break;
					size += n;
				}
				if (size > FILE_BYTES) throw new ApiError(413, 'too_large', 'File is too large.');
				return { content: new TextDecoder().decode(bytes.subarray(0, size)), bytes: size };
			} finally {
				file.close();
			}
		}
		const entries: Record<string, unknown>[] = [];
		for await (const entry of Deno.readDir(path)) {
			if (entry.name.toLowerCase() === '.git') continue;
			if (entries.length >= 1000) return { entries, truncated: true };
			entries.push({ name: entry.name, type: entry.isSymlink ? 'symlink' : entry.isDirectory ? 'directory' : 'file' });
		}
		return { entries, truncated: false };
	}
}

/** A public clone's socket is the registry proxy, admitting the git hosts and nothing else, for its one step. */
function publicEgress(hosts: ReadonlySet<string>): OpenEgress {
	return (path, deps, runId) => RegistryProxy.open(path, deps, runId, hosts);
}

/** A credentialed clone's socket is the forwarder for that one remote, which adds its credential itself. */
function forwardEgress(remote: GitRemote): OpenEgress {
	return (path, deps, runId) => GitForwarder.open(path, deps, runId, remote);
}
