/**
 * Sign-in sessions (`ttks_` tokens), persisted as one file so a redeploy does not sign everyone out (D-073).
 *
 * The file holds the SHA-256 of each token, never the token: a copy of `logins.json` lets nobody sign in. Each
 * entry carries a snapshot of the principal it was minted for and the **backing** credential — `user:<username>`
 * or `api-key:<record sha256>` — which the verifier re-checks on every resolve, so deleting the account or rotating
 * the key ends the session without a close ever being requested.
 *
 * Persistence copies `OriginOverlay` (same-directory rename, serialized writes). A write that fails is logged and
 * the in-memory state stands: the failure direction of a login store is "signed out after the next restart",
 * which is tolerable, whereas refusing the login because a disk write failed is not. A corrupt file loads as empty.
 */
import * as z from 'zod';
import { dirname, join } from '@std/path';
import { encodeHex } from '@std/encoding/hex';
import { SCOPES } from '@tykotech/mcp';
import type { Principal } from './auth.ts';
import { KvReplica } from './kv_replica.ts';

export const LOGINS_FILE = 'logins.json';
export const LOGIN_TOKEN_PREFIX = 'ttks_';
/**
 * Open sign-ins one backing credential may hold; the oldest is dropped past it. The login route is public and
 * every success appends to one file rewritten per write, so an unbounded count is a disk and rewrite cost that a
 * caller with a valid password could impose; thirty-two browsers per account is more than any operator has.
 */
export const MAX_LOGINS_PER_BACKING = 32;

export type LoginStoreStatus = 'memory' | 'ok' | 'absent' | 'unreadable' | 'cluster';

const StoredLoginSchema = z.object({
	hash: z.string().regex(/^[0-9a-f]{64}$/),
	principal: z.object({
		kind: z.enum(['api-key', 'oauth', 'anonymous-loopback']),
		id: z.string().min(1),
		scopes: z.array(z.enum(SCOPES)),
		label: z.string().nullable(),
	}),
	backing: z.string().min(1),
	created: z.number().int(),
	expires: z.number().int(),
});
export type StoredLogin = z.infer<typeof StoredLoginSchema>;

const LoginsFileSchema = z.object({ version: z.literal(1), logins: z.array(StoredLoginSchema) });

export interface LoginStoreOptions {
	readonly dataDir: string | null;
	readonly logger?: { warn(message: string): void };
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return encodeHex(new Uint8Array(digest));
}

export class LoginStore {
	readonly #path: string | null;
	readonly #logger: LoginStoreOptions['logger'];
	#logins = new Map<string, StoredLogin>();
	#status: LoginStoreStatus = 'memory';
	#queue: Promise<void> = Promise.resolve();
	/** D-084: the cluster's KV, when clustering is on; then it, not the file, is the authority. */
	#replica: KvReplica<StoredLogin> | null = null;

	constructor(options: LoginStoreOptions) {
		this.#path = options.dataDir === null ? null : join(options.dataDir, LOGINS_FILE);
		this.#logger = options.logger;
		this.#load();
	}

	get writable(): boolean {
		return this.#path !== null || this.#replica !== null;
	}

	/**
	 * D-084: moves the store onto the cluster's KV, so a sign-in minted on one node resolves on every node and a
	 * closed one is closed everywhere. Sign-ins this node held in its file are carried over when the KV has none yet.
	 */
	async attachCluster(kv: Deno.Kv, options: { pollMs?: number } = {}): Promise<void> {
		const replica = new KvReplica<StoredLogin>({
			kv,
			...options,
			prefix: ['ttk', 'logins'],
			parse: (value) => {
				const parsed = StoredLoginSchema.safeParse(value);
				return parsed.success ? parsed.data : null;
			},
			onReload: (entries) => {
				const now = Date.now();
				this.#logins = new Map([...entries].filter(([, entry]) => entry.expires > now));
			},
			...(this.#logger === undefined ? {} : { logger: this.#logger }),
		});
		if (await replica.empty() && this.#logins.size > 0) {
			const now = Date.now();
			await replica.commit(
				[...this.#logins.values()].filter((entry) => entry.expires > now).map((entry) => ({
					key: entry.hash,
					value: entry,
					expireIn: entry.expires - now,
				})),
			);
		}
		await replica.start();
		this.#replica = replica;
		this.#status = 'cluster';
	}

	/**
	 * The entry behind a token hash, read through to the cluster's KV when this node has not seen it yet (a sign-in
	 * minted on another node a moment ago). Without a cluster it is `get`.
	 */
	async lookup(hash: string): Promise<StoredLogin | null> {
		const local = this.get(hash);
		if (local !== null || this.#replica === null) return local;
		const remote = await this.#replica.read(hash);
		if (remote === null || remote.expires <= Date.now()) return null;
		this.#logins.set(hash, remote);
		return remote;
	}

	/** Stops following the cluster; for shutdown and tests. */
	detachCluster(): void {
		this.#replica?.close();
	}

	get status(): LoginStoreStatus {
		return this.#status;
	}

	/** Open, unexpired sign-ins. */
	get size(): number {
		this.sweep();
		return this.#logins.size;
	}

	/** Mints a token for `principal`, remembers its hash, and returns the token exactly once. */
	async mint(principal: Principal, backing: string, ttlMs: number): Promise<{ token: string; expires: number }> {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		const token = `${LOGIN_TOKEN_PREFIX}${encodeHex(bytes)}`;
		const hash = await sha256Hex(token);
		const now = Date.now();
		const expires = now + ttlMs;
		this.sweep(now);
		const mine = [...this.#logins.values()].filter((entry) => entry.backing === backing)
			.sort((a, b) => a.created - b.created);
		const dropped = mine.slice(0, Math.max(0, mine.length + 1 - MAX_LOGINS_PER_BACKING));
		for (const stale of dropped) this.#logins.delete(stale.hash);
		const entry: StoredLogin = {
			hash,
			principal: {
				kind: principal.kind,
				id: principal.id,
				scopes: [...principal.scopes],
				label: principal.label ?? null,
			},
			backing,
			created: now,
			expires,
		};
		this.#logins.set(hash, entry);
		if (this.#replica !== null) {
			// D-084: the token is handed out only once every node can find it.
			await this.#replica.commit([
				{ key: hash, value: entry, expireIn: ttlMs },
				...dropped.map((stale) => ({ key: stale.hash, value: null })),
			]);
		}
		this.#schedulePersist();
		return { token, expires };
	}

	/** The entry behind a token hash, or `null` when unknown or expired (an expired entry is dropped). */
	get(hash: string): StoredLogin | null {
		const entry = this.#logins.get(hash);
		if (entry === undefined) return null;
		if (entry.expires <= Date.now()) {
			this.#logins.delete(hash);
			this.#schedulePersist();
			return null;
		}
		return entry;
	}

	close(hash: string): boolean {
		const closed = this.#logins.delete(hash);
		// D-084: closed everywhere, even when this node never held it.
		this.#closeInCluster([hash]);
		if (closed) this.#schedulePersist();
		return closed;
	}

	/** Closes every entry `predicate` accepts; returns how many. */
	closeWhere(predicate: (entry: StoredLogin) => boolean): number {
		let closed = 0;
		const hashes: string[] = [];
		for (const [hash, entry] of this.#logins) {
			if (predicate(entry)) {
				this.#logins.delete(hash);
				hashes.push(hash);
				closed += 1;
			}
		}
		this.#closeInCluster(hashes);
		if (closed > 0) this.#schedulePersist();
		return closed;
	}

	countFor(backing: string): number {
		this.sweep();
		let count = 0;
		for (const entry of this.#logins.values()) if (entry.backing === backing) count += 1;
		return count;
	}

	/** Drops expired entries. */
	sweep(now = Date.now()): void {
		let dropped = false;
		for (const [hash, entry] of this.#logins) {
			if (entry.expires <= now) {
				this.#logins.delete(hash);
				dropped = true;
			}
		}
		if (dropped) this.#schedulePersist();
	}

	/** Resolves once every write queued so far has landed; for tests and shutdown. */
	flush(): Promise<void> {
		return this.#queue;
	}

	/** D-084: deletes in the KV, serialized behind other writes; a failure is logged, the local close stands. */
	#closeInCluster(hashes: string[]): void {
		const replica = this.#replica;
		if (replica === null || hashes.length === 0) return;
		this.#queue = this.#queue
			.then(() => replica.commit(hashes.map((key) => ({ key, value: null }))))
			.then(() => {})
			.catch((cause) => {
				this.#logger?.warn(
					`a sign-in could not be closed in the cluster store (${
						cause instanceof Error ? cause.message : String(cause)
					})`,
				);
			});
	}

	#schedulePersist(): void {
		// D-084: in a cluster the KV is the store; the file is not written.
		if (this.#path === null || this.#replica !== null) return;
		const snapshot = [...this.#logins.values()];
		this.#queue = this.#queue
			.then(() => this.#persist(snapshot))
			.catch((cause) => {
				this.#logger?.warn(
					`the login store at ${this.#path} could not be written (${
						cause instanceof Error ? cause.message : String(cause)
					}); sign-ins stay in memory until the next successful write`,
				);
			});
	}

	async #persist(logins: StoredLogin[]): Promise<void> {
		const path = this.#path;
		if (path === null) return;
		const file: z.infer<typeof LoginsFileSchema> = { version: 1, logins };
		await Deno.mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		await Deno.writeTextFile(temporary, `${JSON.stringify(file, null, '\t')}\n`);
		try {
			await Deno.rename(temporary, path);
			this.#status = 'ok';
		} catch (cause) {
			await Deno.remove(temporary).catch(() => {});
			throw cause;
		}
	}

	#load(): void {
		const path = this.#path;
		if (path === null) {
			this.#status = 'memory';
			return;
		}
		let raw: string;
		try {
			raw = Deno.readTextFileSync(path);
		} catch (cause) {
			if (cause instanceof Deno.errors.NotFound) {
				this.#status = 'absent';
				return;
			}
			this.#status = 'unreadable';
			this.#logger?.warn(
				`the login store at ${path} could not be read (${
					cause instanceof Error ? cause.message : String(cause)
				}); every sign-in starts over`,
			);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		const result = LoginsFileSchema.safeParse(parsed);
		if (!result.success) {
			this.#status = 'unreadable';
			this.#logger?.warn(`the login store at ${path} is not a valid logins file; every sign-in starts over`);
			return;
		}
		const now = Date.now();
		for (const entry of result.data.logins) if (entry.expires > now) this.#logins.set(entry.hash, entry);
		this.#status = 'ok';
	}
}
