/**
 * One versioned JSON document on disk, rewritten whole: written to a new sibling file (mode 0600), synced, renamed
 * over the old one, and the directory synced where the platform allows, so a crash leaves the previous document or
 * the next, never half. Writes are serialized and debounced: the first change of a burst arms a timer that is never
 * re-armed, so a steady stream still lands at least every {@linkcode DURABLE_DEBOUNCE_MS}. A failed write is
 * reported and the in-memory state stands; a corrupt document loads as absent.
 */

/** The longest a change waits before it is written. */
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

	/** The document written last, or `undefined`. Synchronous: it runs once, in a constructor. */
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
	 * Stops accepting changes and, when a change is still unwritten, writes `final` (the owner's state at shutdown)
	 * or else the pending snapshot. Nothing changed, nothing written. Idempotent.
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

	/** Synced before the rename (else delayed allocation can leave an empty document) and the directory after. */
	async #write(value: unknown): Promise<void> {
		// Serialized before the first await: the snapshot is the state at this instant.
		const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
		const index = Math.max(this.path.lastIndexOf('/'), this.path.lastIndexOf('\\'));
		const directory = index < 0 ? '.' : index === 0 ? this.path.slice(0, 1) : this.path.slice(0, index);
		await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
		try {
			// createNew (O_EXCL): never a file a link or an earlier crash left at the name.
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
		// Windows cannot open a directory; the rename is still atomic there.
		try {
			using handle = await Deno.open(directory, { read: true });
			await handle.sync();
		} catch { /* not syncable here */ }
	}
}

/** A filesystem error names the path and the failure, never file contents. */
function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
