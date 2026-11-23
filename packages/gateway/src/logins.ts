/** Sign-in sessions (`ttks_` tokens), persisted as one file so a redeploy does not sign everyone out. */
import * as z from 'zod';
import { dirname, join } from '@std/path';
import { encodeHex } from '@std/encoding/hex';
import { SCOPES } from '@tykotech/mcp';
import type { Principal } from './auth.ts';

const LOGINS_FILE = 'logins.json';
export const LOGIN_TOKEN_PREFIX = 'ttks_';
/** Open sign-ins one backing credential may hold; the oldest is dropped past it. */
export const MAX_LOGINS_PER_BACKING = 32;

export type LoginStoreStatus = 'memory' | 'ok' | 'absent' | 'unreadable';

const StoredLoginSchema = z.object({
	hash: z.string().regex(/^[0-9a-f]{64}$/),
	principal: z.object({
		kind: z.enum(['api-key', 'anonymous-loopback']),
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

	constructor(options: LoginStoreOptions) {
		this.#path = options.dataDir === null ? null : join(options.dataDir, LOGINS_FILE);
		this.#logger = options.logger;
		this.#load();
	}

	get writable(): boolean {
		return this.#path !== null;
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
		if (closed) this.#schedulePersist();
		return closed;
	}

	/** Closes every entry `predicate` accepts; returns how many. */
	closeWhere(predicate: (entry: StoredLogin) => boolean): number {
		let closed = 0;
		for (const [hash, entry] of this.#logins) {
			if (predicate(entry)) {
				this.#logins.delete(hash);
				closed += 1;
			}
		}
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

	/** Resolves once every write queued so far has landed (tests). */
	flush(): Promise<void> {
		return this.#queue;
	}

	#schedulePersist(): void {
		if (this.#path === null) return;
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
