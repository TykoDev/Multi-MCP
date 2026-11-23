/**
 * A cage's disk use, watched while it runs (volumes have no quotas). Every check reads free space (one statfs):
 * below the floor the cage stops, whoever fills the disk; once the volume lost more than the cage's allowance since
 * the last measurement, its files are measured again (beside the checks) and it stops past its limit. A cage running
 * alone owns every byte lost, less a share for other writers: past its allowance by more it stops at once, and also
 * when du explains too little of the loss (deleted files held open). Two cages at once are each held to du.
 *
 * `treeUsage` is the Docker backend's measurer: the service's own walk, with the container paused.
 */

export interface DiskWatchDeps {
	/** Bytes free on the work volume. */
	free(): Promise<number>;
	minFreeBytes: number;
	/** What other writers may account for while a cage runs alone. */
	noiseBytes: number;
	/** How far past its allowance the volume may fall before the files are measured again. */
	triggerBytes: number;
}

export interface WatchSpec {
	/** What the watched files took when the cage started. */
	before: number;
	/** The most they may take; the cage is stopped past this. */
	limit: number;
	/** Measures the watched files now; aborted when the cage ends first. */
	measure(signal: AbortSignal): Promise<number>;
}

/** Why a cage was stopped: the volume's floor, or its own limit. */
export type DiskVerdict = 'floor' | 'budget';

/** The watches of the cages running now, so each knows whether it has the volume to itself. */
export class DiskWatches {
	readonly #active = new Set<DiskWatch>();

	constructor(readonly deps: DiskWatchDeps) {}

	get active(): number {
		return this.#active.size;
	}

	async start(spec: WatchSpec): Promise<DiskWatch> {
		const free = await this.deps.free();
		const watch = new DiskWatch(this.deps, spec, free, () => this.#active.delete(watch));
		if (this.#active.size > 0) {
			watch.shared = true;
			for (const other of this.#active) other.shared = true;
		}
		this.#active.add(watch);
		return watch;
	}
}

export class DiskWatch {
	/** Another cage ran at some point while this one did: the volume's loss is no longer all its own. */
	shared = false;
	#verdict: DiskVerdict | null = null;
	/** Free space and the files' size at the last measurement. */
	#base: { free: number; used: number };
	#measuring: Promise<void> | null = null;
	readonly #abort = new AbortController();

	constructor(
		readonly deps: DiskWatchDeps,
		readonly spec: WatchSpec,
		/** Free space when the cage started. */
		readonly startFree: number,
		readonly onEnd: () => void,
	) {
		this.#base = { free: startFree, used: spec.before };
	}

	get verdict(): DiskVerdict | null {
		return this.#verdict;
	}

	/** One check: "disk" when the cage must stop. Cheap; a measurement it starts runs on its own. */
	async check(): Promise<string | null> {
		if (this.#verdict === null) {
			const found = await this.#check();
			// A measurement may have reached its verdict while this check waited for statfs.
			this.#verdict ??= found;
		}
		return this.#verdict === null ? null : 'disk';
	}

	async #check(): Promise<DiskVerdict | null> {
		const free = await this.deps.free();
		if (free < this.deps.minFreeBytes) return 'floor';
		const allowance = this.spec.limit - this.spec.before;
		if (!this.shared && this.startFree - free > allowance + this.deps.noiseBytes) return 'budget';
		const since = this.#base.free - free;
		const room = Math.max(0, this.spec.limit - this.#base.used) + this.deps.triggerBytes;
		if (since > room && this.#measuring === null) {
			this.#measuring = this.#measure(free).finally(() => this.#measuring = null);
		}
		return null;
	}

	async #measure(free: number): Promise<void> {
		let used: number;
		try {
			used = await this.spec.measure(this.#abort.signal);
		} catch {
			// Failing to measure a cage that has outgrown its allowance stops it: closed, not open.
			if (!this.#abort.signal.aborted) this.#verdict ??= 'budget';
			return;
		}
		const unexplained = this.startFree - free - (used - this.spec.before);
		if (used > this.spec.limit || (!this.shared && unexplained > this.deps.noiseBytes)) {
			this.#verdict ??= 'budget';
			return;
		}
		this.#base = { free, used };
	}

	/** Called once the cage is gone: stops a measurement still under way. */
	async end(): Promise<void> {
		this.#abort.abort();
		await this.#measuring;
		this.onEnd();
	}
}

export interface TreeUsageOptions {
	/** The walk fails once this many milliseconds have passed, and so fails closed. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** `chmod u+rx` a locked directory before reading it; sound only while nothing can change the tree (paused). */
	repair?: boolean;
}

/** Entries read at once. */
const WALK_BATCH = 64;
/** Distinct hard-linked files a walk keeps apart; past it the measurement fails rather than grow without bound. */
const LINKED_FILES = 1_000_000;

/**
 * The bytes the trees at `roots` take, as `du -s -c` counts them: allocated blocks, hard links once, links never
 * followed. Fails closed: a missing entry counts nothing, anything else unreadable (or the deadline, or the signal)
 * fails the whole measurement, which callers treat as over budget — never a total that skipped what it could not read.
 */
export async function treeUsage(roots: readonly string[], options: TreeUsageOptions): Promise<number> {
	const deadline = Date.now() + options.timeoutMs;
	const linked = new Set<string>();
	let total = 0;
	const check = (): void => {
		options.signal?.throwIfAborted();
		if (Date.now() > deadline) throw new Error('the measurement ran out of time');
	};
	/** Counts one entry; its info when it is a directory to read, else null. */
	const count = async (path: string): Promise<Deno.FileInfo | null> => {
		let info: Deno.FileInfo;
		try {
			info = await Deno.lstat(path);
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return null;
			throw error;
		}
		if (!info.isDirectory && info.nlink !== null && info.nlink > 1 && info.ino !== null) {
			const key = `${info.dev}:${info.ino}`;
			if (linked.has(key)) return null;
			if (linked.size >= LINKED_FILES) throw new Error('the tree holds too many hard-linked files to measure');
			linked.add(key);
		}
		// st_blocks is in 512-byte units on every Unix; Windows (the unit tests) reports none, so the size stands in.
		total += info.blocks !== null ? info.blocks * 512 : info.size;
		return info.isDirectory && !info.isSymlink ? info : null;
	};
	const pending: Array<[string, Deno.FileInfo]> = [];
	for (const root of roots) {
		const info = await count(root);
		if (info !== null) pending.push([root, info]);
	}
	while (pending.length > 0) {
		check();
		const [dir, info] = pending.pop()!;
		if (options.repair && info.mode !== null && (info.mode & 0o500) !== 0o500) {
			await Deno.chmod(dir, (info.mode & 0o7777) | 0o500);
		}
		let batch: string[] = [];
		const flush = async (): Promise<void> => {
			const found = await Promise.all(batch.map(count));
			found.forEach((child, i) => child !== null && pending.push([batch[i]!, child]));
			batch = [];
			check();
		};
		try {
			for await (const entry of Deno.readDir(dir)) {
				batch.push(`${dir}/${entry.name}`);
				if (batch.length >= WALK_BATCH) await flush();
			}
		} catch (error) {
			// Gone since it was counted: nothing more to count in it.
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
		await flush();
	}
	return total;
}
