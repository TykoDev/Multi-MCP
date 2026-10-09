/**
 * B1 / G8 (D-104): one versioned JSON document on disk, rewritten whole.
 *
 * The same pattern as the gateway's `users.json` and `logins.json`: the document is written to a sibling temporary
 * file, synced, and renamed over the old one (then the directory synced, where supported), so a reader — or a crash,
 * or a power loss — sees either the previous document or the next one, never half of either. Writes are serialized
 * through one promise chain, so two snapshots never race to the rename.
 *
 * **Debounced, never more than {@linkcode DURABLE_DEBOUNCE_MS} behind.** A burst of changes (a task's status, its
 * artifact and its history land within microseconds of each other) costs one write: the first change in a burst arms
 * a timer and the write takes the snapshot current when it fires. The timer is not re-armed by later changes, so a
 * steady stream of changes still lands on disk at least every 250 ms rather than being postponed indefinitely.
 *
 * **Mode 0600 where the platform has modes.** The temporary file is created with it and the rename keeps it; the
 * directory is created 0700. Windows ignores both, which is what "where supported" means.
 *
 * **A write that fails is reported and the in-memory state stands** — the failure direction of a task store is
 * "forgotten after the next restart", which is what this server did before B1, whereas failing the task because a
 * disk write failed is not acceptable. A corrupt or unreadable document loads as absent, also reported.
 *
 * Dependency-free on purpose: the private ACP runner image ships this package and nothing else.
 */

/** The longest a change waits before it is written (design §2.4). */
export const DURABLE_DEBOUNCE_MS = 250;

/** Where a durable document reports what it could not do; nothing secret is ever passed. */
export interface DurableLogger {
	warn(message: string): void;
}

/** One JSON document at a fixed path. */
export class DurableJsonFile {
	readonly path: string;
	readonly #debounceMs: number;
	readonly #logger: DurableLogger | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#snapshot: (() => unknown) | undefined;
	#queue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(path: string, options: { debounceMs?: number; logger?: DurableLogger } = {}) {
		if (path === '') throw new Error('A durable document needs a path');
		this.path = path;
		this.#debounceMs = Math.min(options.debounceMs ?? DURABLE_DEBOUNCE_MS, DURABLE_DEBOUNCE_MS);
		this.#logger = options.logger;
	}

	/**
	 * The document written last, or `undefined` when there is none. Synchronous because it runs once, in a
	 * constructor, before anything can be served from the state it restores.
	 */
	read(): unknown {
		let raw: string;
		try {
			raw = Deno.readTextFileSync(this.path);
		} catch (cause) {
			if (!(cause instanceof Deno.errors.NotFound)) {
				this.#logger?.warn(`${this.path} could not be read (${reason(cause)}); starting empty`);
			}
			return undefined;
		}
		try {
			return JSON.parse(raw);
		} catch {
			this.#logger?.warn(`${this.path} is not valid JSON; starting empty`);
			return undefined;
		}
	}

	/** Records that the state changed; `snapshot` is called when the write happens, not now. */
	schedule(snapshot: () => unknown): void {
		if (this.#closed) return;
		this.#snapshot = snapshot;
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#enqueue();
		}, this.#debounceMs);
		Deno.unrefTimer(this.#timer as unknown as number);
	}

	/** Writes a pending change now and resolves once every queued write has landed. */
	flush(): Promise<void> {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#enqueue();
		}
		return this.#queue;
	}

	/**
	 * Stops accepting changes and, when a change is still unwritten, writes `final` — the state at shutdown, taken by
	 * the owner before it tears its own state down — or else the pending snapshot. Nothing changed, nothing written:
	 * a deployment that never used the store gets no file. Idempotent.
	 */
	async close(final?: unknown): Promise<void> {
		if (this.#closed) return await this.#queue;
		this.#closed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		if (final !== undefined && this.#snapshot !== undefined) this.#snapshot = () => final;
		this.#enqueue();
		await this.#queue;
	}

	#enqueue(): void {
		const snapshot = this.#snapshot;
		this.#snapshot = undefined;
		if (snapshot === undefined) return;
		this.#queue = this.#queue.then(() => this.#write(snapshot())).catch((cause) => {
			this.#logger?.warn(
				`${this.path} could not be written (${reason(cause)}); the state stays in memory until the next write`,
			);
		});
	}

	/**
	 * Review R2-8: the temporary file is synced before it is renamed over the document, and the directory after, where
	 * the platform opens one (not Windows; the rename is still atomic there). Without the first, a power loss on a
	 * filesystem with delayed allocation could leave the renamed document empty — which loads as absent, every task
	 * and surface lost; without the second, the rename itself could be lost. The workspace records in
	 * `@tykotech/sandbox` (`workspaces.ts`) are written the same way.
	 */
	async #write(value: unknown): Promise<void> {
		// Serialized before the first await: the snapshot is the state at this instant, not after the mkdir.
		const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
		const directory = parentOf(this.path);
		await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
		try {
			// A new file (O_EXCL): never one a link or an earlier crash left at the name.
			const file = await Deno.open(temporary, { write: true, createNew: true, mode: 0o600 });
			try {
				let written = 0;
				while (written < bytes.length) written += await file.write(bytes.subarray(written));
				await file.syncData();
			} finally {
				file.close();
			}
			await Deno.rename(temporary, this.path);
		} catch (cause) {
			await Deno.remove(temporary).catch(() => {});
			throw cause;
		}
		await syncDirectory(directory);
	}
}

/** Makes a rename in `path` durable where the platform can open a directory; elsewhere a no-op. */
async function syncDirectory(path: string): Promise<void> {
	let directory: Deno.FsFile;
	try {
		directory = await Deno.open(path, { read: true });
	} catch {
		return;
	}
	try {
		await directory.sync();
	} catch {
		// Opened, but not syncable here: the rename stands, as on Windows.
	} finally {
		directory.close();
	}
}

/** A filesystem error names the path and the failure, never file contents. */
function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The directory holding `path`, for either separator; the package stays free of `@std/path` (see the header). */
function parentOf(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (index < 0) return '.';
	return index === 0 ? path.slice(0, 1) : path.slice(0, index);
}
