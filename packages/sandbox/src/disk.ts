/**
 * SB-1: a cage's disk use, watched while it runs. Docker volumes have no quotas, so a run's budget
 * is enforced by watching; measuring before and after a command alone let one command write until
 * the volume was nearly full.
 *
 * Every check reads the volume's free space (one statfs), and:
 *
 * - below the free-space floor the cage is stopped, whoever is filling the disk;
 * - once the volume has lost more than the cage's allowance since its files were last measured,
 *   they are measured again (du, which the sandbox runs with the right to read directories a
 *   command locked), and the cage is stopped past its limit. The measurement runs beside the
 *   checks, so the floor is still read every time while it does;
 * - a cage that has run alone owns every byte the volume lost meanwhile, less a share for other
 *   writers (the gateway's database may live on the same disk). Past its allowance by more than
 *   that it is stopped at once, without waiting for du, and also when du explains too little of
 *   the loss: the rest is in files it deleted but holds open, which no measurement by name sees.
 *
 * Two cages at once share the volume, and neither can be charged with the other's writes, so each
 * is then held to what du says, with the floor behind it (SB-2 records that one principal may hold
 * both slots). What a command writes between two checks, and during a measurement, is what it can
 * overshoot by; the run cannot grow at all once over its budget (see Sandbox.exec).
 *
 * `treeUsage` at the end is the Docker backend's measurer (review R2-2): the service's own walk of
 * its view of the volume, run while the workspace's container is paused, so no process of the
 * workspace can change the tree under it.
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
	/**
	 * Gives a directory without owner read and search those back (`chmod u+rx`) before reading it, as the bwrap
	 * measurer's CAP_DAC_READ_SEARCH reads one anyway. Sound only while nothing else can change the tree: the Docker
	 * backend measures with the workspace's container paused.
	 */
	repair?: boolean;
}

/** Entries read at once. */
const WALK_BATCH = 64;
/** Distinct hard-linked files a walk keeps apart; past it the measurement fails rather than grow without bound. */
const LINKED_FILES = 1_000_000;

/**
 * SB-1 (review R2-2): the bytes the trees at `roots` take on disk, as `du -s -c` counts them — every entry's allocated
 * blocks, a hard-linked file once, a link never followed (counted as the link itself). Depth-first, holding only the
 * directories still to read, so memory follows the tree's directories rather than its files.
 *
 * Fails closed: a root or entry that does not exist (any more) counts nothing, and anything else that cannot be read —
 * a directory that stays unreadable, an I/O error, the deadline, the signal — fails the whole measurement, which every
 * caller then treats as over budget. A total is never what was left after skipping what could not be read, which is
 * what `du` gave when its exit status was ignored.
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
