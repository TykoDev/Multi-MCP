/**
 * D-084 (G): a keyed collection whose authority is the cluster's Deno KV, read from an in-memory replica.
 *
 * Sign-ins and accounts are read on every request, synchronously, so they cannot be KV reads. Each node keeps a
 * replica: every write goes to the KV first (the authority), with a version key bumped in the same atomic commit,
 * and every node watches that version key and reloads the collection when it moves. A write is therefore visible
 * cluster-wide within one watch round-trip; a reader that needs it sooner (a sign-in token minted on another node a
 * moment ago) reads the one entry straight from the KV (`read`).
 *
 * A watch is not enough on its own: on a local KV file shared by several processes it does not fire for another
 * process's commit (measured 2026-10-02), so each replica also polls the version key every `pollMs` (one small read)
 * and reloads when it moved. The watch still makes the same-process and remote-KV cases immediate.
 *
 * Optimistic concurrency: `commit` checks the version key's versionstamp, so two nodes changing the collection at
 * once cannot silently overwrite each other; the loser is told and retries against the fresh state.
 */

import { withLockRetry } from './cluster.ts';

export interface KvReplicaOptions<T> {
	readonly kv: Deno.Kv;
	/** The collection's key prefix, e.g. `['ttk', 'logins']`. */
	readonly prefix: readonly string[];
	/** Validates an entry read back; an entry that fails is skipped, never fatal. */
	readonly parse: (value: unknown) => T | null;
	/** Called with the whole collection after every reload. */
	readonly onReload: (entries: Map<string, T>) => void;
	readonly logger?: { warn(message: string): void };
	/** How often the version key is polled; {@linkcode KV_REPLICA_POLL_MS} by default. */
	readonly pollMs?: number;
}

export const KV_REPLICA_POLL_MS = 2_000;

/**
 * A key outside the collection that a commit checks and sets in the same atomic operation (G15, D-098): the user
 * store's schema marker, so a one-time upgrade and the marker that records it land together or not at all.
 */
export interface KvGuard {
	readonly key: Deno.KvKey;
	/** The marker's versionstamp as read; `null` when it must still be absent. */
	readonly versionstamp: string | null;
	readonly value: unknown;
}

/** One change in a commit: `value` sets the entry, `null` deletes it. */
export interface KvChange<T> {
	readonly key: string;
	readonly value: T | null;
	/** Milliseconds the KV keeps the entry (sign-ins); absent means until deleted. */
	readonly expireIn?: number;
}

const VERSION = '\u0000version';

export class KvReplica<T> {
	readonly #options: KvReplicaOptions<T>;
	#versionstamp: string | null = null;
	#watch: ReadableStreamDefaultReader<Deno.KvEntryMaybe<unknown>[]> | null = null;
	#closed = false;
	#reloading: Promise<void> | null = null;
	#poll: ReturnType<typeof setInterval> | undefined;

	constructor(options: KvReplicaOptions<T>) {
		this.#options = options;
	}

	#key(key: string): Deno.KvKey {
		return [...this.#options.prefix, key];
	}

	/** Loads the collection, then follows the version key until `close`. */
	async start(): Promise<void> {
		await this.reload();
		this.#poll = setInterval(() => {
			void withLockRetry(() => this.#options.kv.get(this.#key(VERSION))).then((version) => {
				if (!this.#closed && version.versionstamp !== this.#versionstamp) return this.reload();
			}).catch(() => {});
		}, this.#options.pollMs ?? KV_REPLICA_POLL_MS);
		Deno.unrefTimer(this.#poll as unknown as number);
		const stream = this.#options.kv.watch([this.#key(VERSION)]);
		this.#watch = stream.getReader();
		void (async () => {
			try {
				for (;;) {
					const { done, value } = await this.#watch!.read();
					if (done || this.#closed) return;
					if (value[0]?.versionstamp !== this.#versionstamp) await this.reload();
				}
			} catch (cause) {
				if (!this.#closed) {
					this.#options.logger?.warn(
						`the cluster replica of ${this.#options.prefix.join('/')} stopped following changes (${
							cause instanceof Error ? cause.message : String(cause)
						})`,
					);
				}
			}
		})();
	}

	/** Re-reads every entry; concurrent calls share one pass. */
	reload(): Promise<void> {
		this.#reloading ??= withLockRetry(async () => {
			const entries = new Map<string, T>();
			const version = await this.#options.kv.get(this.#key(VERSION));
			for await (const entry of this.#options.kv.list({ prefix: [...this.#options.prefix] })) {
				const key = entry.key.at(-1);
				if (typeof key !== 'string' || key === VERSION) continue;
				const parsed = this.#options.parse(entry.value);
				if (parsed !== null) entries.set(key, parsed);
			}
			return { entries, versionstamp: version.versionstamp };
		}).then(({ entries, versionstamp }) => {
			this.#versionstamp = versionstamp;
			this.#options.onReload(entries);
		}).finally(() => this.#reloading = null);
		return this.#reloading;
	}

	/** One entry, straight from the KV: for a reader that cannot wait for the next reload. */
	async read(key: string): Promise<T | null> {
		const entry = await withLockRetry(() => this.#options.kv.get(this.#key(key)));
		return entry.value === null ? null : this.#options.parse(entry.value);
	}

	/** Whether the KV holds no entry yet (a first start, which may migrate local state in). */
	async empty(): Promise<boolean> {
		return await withLockRetry(async () => {
			for await (const entry of this.#options.kv.list({ prefix: [...this.#options.prefix] }, { limit: 2 })) {
				if (entry.key.at(-1) !== VERSION) return false;
			}
			return true;
		});
	}

	/** The version this replica last loaded or wrote; capture it with a snapshot to commit against that snapshot. */
	get versionstamp(): string | null {
		return this.#versionstamp;
	}

	/**
	 * Applies `changes` in one atomic commit with the version bump. With `expected` (a versionstamp captured together
	 * with the snapshot the changes were computed from), the commit only lands when nobody committed since that
	 * snapshot; `false` means it did not land (reload and retry). `undefined` commits unconditionally. Checking the
	 * live stamp instead would let a reload that ran during the computation pass a change computed from the older
	 * snapshot, and the writer would then hold a state missing the other node's commit.
	 */
	commit(changes: readonly KvChange<T>[], expected?: string | null, guard?: KvGuard): Promise<boolean> {
		return withLockRetry(() => this.#commit(changes, expected, guard));
	}

	async #commit(
		changes: readonly KvChange<T>[],
		expected: string | null | undefined,
		guard: KvGuard | undefined,
	): Promise<boolean> {
		const operation = this.#options.kv.atomic();
		if (expected !== undefined) operation.check({ key: this.#key(VERSION), versionstamp: expected });
		if (guard !== undefined) {
			operation.check({ key: guard.key, versionstamp: guard.versionstamp });
			operation.set(guard.key, guard.value);
		}
		for (const change of changes) {
			if (change.value === null) operation.delete(this.#key(change.key));
			else {
				operation.set(
					this.#key(change.key),
					change.value,
					change.expireIn === undefined ? undefined : { expireIn: change.expireIn },
				);
			}
		}
		operation.set(this.#key(VERSION), crypto.randomUUID());
		const result = await operation.commit();
		if (result.ok) this.#versionstamp = result.versionstamp;
		return result.ok;
	}

	close(): void {
		this.#closed = true;
		if (this.#poll !== undefined) clearInterval(this.#poll);
		void this.#watch?.cancel().catch(() => {});
	}
}
