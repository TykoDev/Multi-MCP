/** One disk budget for the file share and the recordings together, `TTK_DISK_BUDGET_MB` (2 GiB by default). */
import { LibraryError } from '@tykotech/mcp';

/** How long one walk's answer is used. Short: a recording is checked against it every few seconds. */
export const DISK_BUDGET_CACHE_MS = 5_000;

/** Entries one walk may visit across both trees before the budget refuses new bytes; generous, as past it nothing more fits. */
const DISK_BUDGET_WALK_CAP = 100_000;

/** Directory depth past which a walk does not descend. */
const MAX_DEPTH = 32;

/**
 * Walks `root` without following a link, summing file bytes and counting files and directories (`counted`), and stops
 * at `cap` entries (`capped`) or {@linkcode MAX_DEPTH}. A missing or unreadable directory counts as empty.
 */
async function walkTree(root: string, cap: number): Promise<{ bytes: number; counted: number; capped: boolean }> {
	let bytes = 0;
	let counted = 0;
	let seen = 0;
	const pending: Array<{ readonly path: string; readonly depth: number }> = [{ path: root, depth: 0 }];
	while (pending.length > 0) {
		const { path, depth } = pending.pop()!;
		try {
			for await (const entry of Deno.readDir(path)) {
				if (seen >= cap) return { bytes, counted, capped: true };
				seen += 1;
				// `readDir` reports a link as a link: neither followed nor counted.
				if (entry.isSymlink) continue;
				const child = `${path}/${entry.name}`;
				if (entry.isDirectory) {
					counted += 1;
					if (depth + 1 < MAX_DEPTH) pending.push({ path: child, depth: depth + 1 });
				} else if (entry.isFile) {
					const info = await Deno.lstat(child).catch(() => null);
					if (info === null || !info.isFile) continue;
					counted += 1;
					bytes += info.size;
				}
			}
		} catch {
			// Gone between listing and reading, or not readable: nothing to count there.
		}
	}
	return { bytes, counted, capped: false };
}

/** What builds a {@linkcode DiskBudget}. */
export interface DiskBudgetOptions {
	/** The budget, in bytes. */
	readonly limitBytes: number;
	/** The trees that count against it: the share root and the recordings directory. */
	readonly roots: readonly string[];
	/** Entry cap per walk, across all roots; {@linkcode DISK_BUDGET_WALK_CAP} by default. */
	readonly walkCap?: number;
	/** Test seam: the cache clock. */
	readonly now?: () => number;
}

/** What one walk found. */
interface Measured {
	readonly at: number;
	readonly bytes: number;
	readonly capped: boolean;
}

/** The share and recordings' shared disk budget; see the module comment. */
export class DiskBudget {
	readonly limitBytes: number;
	readonly #roots: readonly string[];
	readonly #walkCap: number;
	readonly #now: () => number;
	#measured: Measured | null = null;
	#walking: Promise<Measured> | null = null;
	/** Bytes admitted since the walk in force began, so a burst between two walks is counted. */
	#pending = 0;

	constructor(options: DiskBudgetOptions) {
		this.limitBytes = options.limitBytes;
		this.#roots = options.roots;
		this.#walkCap = options.walkCap ?? DISK_BUDGET_WALK_CAP;
		this.#now = options.now ?? Date.now;
	}

	/** Bytes in use now (the last walk plus what was admitted since), and whether that walk hit its entry cap. */
	async usage(): Promise<{ readonly bytes: number; readonly capped: boolean }> {
		const measured = await this.#current();
		return { bytes: measured.bytes + this.#pending, capped: measured.capped };
	}

	/**
	 * Throws a `too-large` {@linkcode LibraryError} when `bytes` more would pass the budget; with `reserve`, counts
	 * them as written.
	 */
	async admit(bytes: number, reserve: boolean): Promise<void> {
		const measured = await this.#current();
		if (measured.capped) {
			throw new LibraryError(
				'too-large',
				'the file share and recordings hold too many entries to measure against their disk budget',
			);
		}
		if (measured.bytes + this.#pending + bytes > this.limitBytes) {
			throw new LibraryError(
				'too-large',
				`the file share and recordings are at their disk budget of ${mebibytes(this.limitBytes)} MiB`,
			);
		}
		if (reserve) this.#pending += bytes;
	}

	/** Whether the budget is spent (or cannot be measured): a recording must not start, or go on, past this. */
	async exhausted(): Promise<boolean> {
		const { bytes, capped } = await this.usage();
		return capped || bytes >= this.limitBytes;
	}

	/** The cached walk, or a new one shared by every caller waiting on it. A failed walk is not kept. */
	#current(): Promise<Measured> {
		const measured = this.#measured;
		if (measured !== null && this.#now() - measured.at < DISK_BUDGET_CACHE_MS) return Promise.resolve(measured);
		if (this.#walking === null) {
			// What was admitted before this walk began is on disk (or being written) by the time it reads, so it is
			// dropped from `#pending` when the walk lands; what is admitted during the walk stays on top of it.
			const before = this.#pending;
			const at = this.#now();
			this.#walking = this.#walk(at).then((result) => {
				this.#pending = Math.max(0, this.#pending - before);
				this.#measured = result;
				return result;
			}).finally(() => {
				this.#walking = null;
			});
		}
		return this.#walking;
	}

	async #walk(at: number): Promise<Measured> {
		let bytes = 0;
		// One cap across the roots: what the first tree spends, the second cannot.
		let left = this.#walkCap;
		for (const root of this.#roots) {
			const usage = await walkTree(root, left);
			bytes += usage.bytes;
			if (usage.capped) return { at, bytes, capped: true };
			left -= usage.counted;
		}
		return { at, bytes, capped: false };
	}
}

function mebibytes(bytes: number): number {
	return Math.round(bytes / (1024 * 1024));
}
