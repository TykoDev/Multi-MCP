/**
 * The user store: every password-authenticated account, persisted as one file. **Schema version 2.** `DEFAULT_SCOPES`
 * excludes `admin`, while a version-1 record that names no scopes is an account whose grant includes `admin`.
 */
import * as z from 'zod';
import { dirname, join } from '@std/path';
import { DEFAULT_SCOPES, type Scope, SCOPELESS_ACCOUNT_SCOPES, SCOPES } from '@tykotech/mcp';
import { type AdminUserRecord, AdminUserRecordSchema, hashPassword, verifyPassword } from './admin_auth.ts';

/** What an unknown or disabled name is checked against; no password matches its hash. */
const DECOY = {
	salt: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
	hash: '0'.repeat(64),
	iterations: 100_000,
};

const USERS_FILE = 'users.json';

/** Password bounds for a supplied (not generated) password. */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 256;

export type UserStoreStatus = 'memory' | 'seeded' | 'ok' | 'empty' | 'unreadable';

/**
 * The most keys one account holds. It bounds the record — 25 keys are a few kilobytes — and the Users screen's list;
 * past it a key must be revoked first.
 */
export const MAX_KEYS_PER_ACCOUNT = 25;

/** The longest key label — the same bound as a configured key's label, so one rule covers both. */
const MAX_ACCOUNT_KEY_LABEL_LENGTH = 64;

/** A key id names the key in a route path (`/keys/{id}`), so it is a path-safe token. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** One key an account holds. */
const StoredKeySchema = z.object({
	id: z.string().regex(KEY_ID_PATTERN),
	label: z.string().optional(),
	prefix: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	scopes: z.array(z.enum(SCOPES)),
	created_at: z.string(),
});
export type StoredKey = z.infer<typeof StoredKeySchema>;

const StoredUserSchema = AdminUserRecordSchema.extend({
	created_at: z.string(),
	updated_at: z.string(),
	disabled: z.boolean().optional(),
	/** Optional and additive; a record without it holds no key. */
	keys: z.array(StoredKeySchema).optional(),
});
export type StoredUser = z.infer<typeof StoredUserSchema>;

/** The schema version a store is written at: every account names its scopes. */
export const USERS_SCHEMA_VERSION = 2;

const UsersFileSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), users: z.array(StoredUserSchema) });

/** The one-time upgrade to schema version 2. */
function upgradeUsers<T extends { scopes?: Scope[] | undefined }>(users: readonly T[]): {
	users: T[];
	migrated: number;
} {
	let migrated = 0;
	const upgraded = users.map((user) => {
		if (user.scopes !== undefined) return user;
		migrated += 1;
		return { ...user, scopes: [...SCOPELESS_ACCOUNT_SCOPES] };
	});
	return { users: upgraded, migrated };
}

/** The line the upgrade logs; one wording for the file and the seed. */
function migratedMessage(count: number): string {
	return `user store migrated: ${count} account${count === 1 ? '' : 's'} given explicit scopes`;
}

/**
 * How many accounts a deployment has before any store is opened — the seed record, or the records of a readable
 * `users.json` (either schema version).
 */
export function configuredAccounts(dataDir: string | null, seed: AdminUserRecord | null): number {
	if (dataDir !== null) {
		try {
			const parsed = UsersFileSchema.safeParse(JSON.parse(Deno.readTextFileSync(join(dataDir, USERS_FILE))));
			// The file is the authority once it exists: the seed is not consulted then.
			return parsed.success ? parsed.data.users.length : 0;
		} catch (cause) {
			if (!(cause instanceof Deno.errors.NotFound)) return 0;
		}
	}
	return seed === null ? 0 : 1;
}

/** What a route may show of an account key — never its hash, and never the key (which no store ever holds). */
export interface PublicKey {
	readonly id: string;
	readonly label: string | null;
	readonly prefix: string;
	readonly scopes: readonly Scope[];
	readonly created_at: string;
}

/** What a list route may show: never the salt, hash or iteration count, and never a key's hash. */
export interface PublicUser {
	readonly username: string;
	readonly scopes: readonly Scope[];
	readonly disabled: boolean;
	readonly created_at: string;
	readonly updated_at: string;
	readonly keys: readonly PublicKey[];
}

/**
 * A key to store. The caller mints the key and hands over only what is kept — its hash and display prefix — so the raw
 * key never reaches the store. `scopes` omitted means the account's scopes at the moment of the write.
 */
export interface NewAccountKey {
	readonly id: string;
	readonly label?: unknown;
	readonly prefix: string;
	readonly sha256: string;
	readonly scopes?: unknown;
}

/** An account key the verifier found, with the scopes it may use now — its own, narrowed to its account's. */
export interface AccountKeyHit {
	readonly username: string;
	readonly key: StoredKey;
	readonly scopes: ReadonlySet<Scope>;
}

export type UserStoreErrorCode =
	| 'invalid-username'
	| 'invalid-password'
	| 'invalid-scopes'
	| 'invalid-label'
	| 'invalid-key'
	| 'too-many-keys'
	| 'duplicate'
	| 'not-found'
	| 'last-admin'
	| 'persistence-required';

export class UserStoreError extends Error {
	readonly code: UserStoreErrorCode;
	constructor(code: UserStoreErrorCode, message: string) {
		super(message);
		this.name = 'UserStoreError';
		this.code = code;
	}
}

export interface UserStoreOptions {
	/** `TTK_DATA_DIR`, or `null` on a deployment that can only serve the seed. */
	readonly dataDir: string | null;
	/** The `TTK_ADMIN_USER` record, written as the first user when the store does not exist yet. */
	readonly seed: AdminUserRecord | null;
	/** `info` carries the one-time upgrade line; a logger without it still gets every warning. */
	readonly logger?: { warn(message: string): void; info?(message: string): void };
}

function publicKeyView(key: StoredKey): PublicKey {
	return {
		id: key.id,
		label: key.label ?? null,
		prefix: key.prefix,
		scopes: [...key.scopes],
		created_at: key.created_at,
	};
}

/**
 * The key on `user` that `match` picks, with the scopes it may use now — its stored scopes narrowed to its account's
 * current ones — or `null` when there is no such account, it is disabled, or it holds no such key.
 */
function keyHit(user: StoredUser | undefined, match: (key: StoredKey) => boolean): AccountKeyHit | null {
	if (user === undefined || user.disabled === true) return null;
	const key = (user.keys ?? []).find(match);
	if (key === undefined) return null;
	const held = new Set(user.scopes ?? DEFAULT_SCOPES);
	return { username: user.username, key, scopes: new Set(key.scopes.filter((scope) => held.has(scope))) };
}

function publicView(user: StoredUser): PublicUser {
	return {
		username: user.username,
		scopes: [...(user.scopes ?? DEFAULT_SCOPES)],
		disabled: user.disabled === true,
		created_at: user.created_at,
		updated_at: user.updated_at,
		keys: (user.keys ?? []).map(publicKeyView),
	};
}

/** A key label, trimmed; `undefined` (or an empty string) means none. */
function checkKeyLabel(label: unknown): string | undefined {
	if (label === undefined || label === null) return undefined;
	if (typeof label !== 'string') throw new UserStoreError('invalid-label', 'a key label must be a string');
	const trimmed = label.trim();
	if (trimmed === '') return undefined;
	let safe = trimmed.length <= MAX_ACCOUNT_KEY_LABEL_LENGTH;
	for (const character of trimmed) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || character === '<' || character === '>' || character === '&') safe = false;
	}
	if (!safe) {
		throw new UserStoreError(
			'invalid-label',
			`a key label is 1 to ${MAX_ACCOUNT_KEY_LABEL_LENGTH} printable characters with none of <, >, &`,
		);
	}
	return trimmed;
}

/** The shape checks a new key passes before any write — the rules that need the account come later. */
function checkNewKey(input: NewAccountKey): { label: string | undefined; scopes: Scope[] | undefined } {
	if (
		!KEY_ID_PATTERN.test(input.id) || !/^[A-Za-z0-9_-]{1,16}$/.test(input.prefix) ||
		!/^[0-9a-f]{64}$/.test(input.sha256)
	) {
		throw new UserStoreError('invalid-key', 'a key needs a path-safe id, a display prefix and a SHA-256 in hex');
	}
	return { label: checkKeyLabel(input.label), scopes: checkScopes(input.scopes) };
}

/**
 * The key record `input` makes on `account`, judged against `users` as the write will commit it: every scope must be
 * one the account holds (a key never widens its account), the account holds at most {@linkcode MAX_KEYS_PER_ACCOUNT},
 * and neither the id (within the account) nor the hash (anywhere) is taken.
 */
function buildKey(
	account: StoredUser,
	input: NewAccountKey,
	checked: { label: string | undefined; scopes: Scope[] | undefined },
	users: ReadonlyMap<string, StoredUser>,
): StoredKey {
	const held = account.scopes ?? DEFAULT_SCOPES;
	const scopes = checked.scopes ?? [...held];
	const beyond = scopes.filter((scope) => !held.includes(scope));
	if (beyond.length > 0) {
		throw new UserStoreError(
			'invalid-scopes',
			`a key cannot hold a scope its account does not: ${beyond.join(', ')}`,
		);
	}
	const keys = account.keys ?? [];
	if (keys.length >= MAX_KEYS_PER_ACCOUNT) {
		throw new UserStoreError(
			'too-many-keys',
			`an account holds at most ${MAX_KEYS_PER_ACCOUNT} keys; revoke one first`,
		);
	}
	if (keys.some((key) => key.id === input.id)) {
		throw new UserStoreError('duplicate', `the account already holds a key ${JSON.stringify(input.id)}`);
	}
	for (const user of users.values()) {
		if ((user.keys ?? []).some((key) => key.sha256 === input.sha256)) {
			throw new UserStoreError('duplicate', 'that key is already held');
		}
	}
	return {
		id: input.id,
		...(checked.label === undefined ? {} : { label: checked.label }),
		prefix: input.prefix,
		sha256: input.sha256,
		scopes,
		created_at: new Date().toISOString(),
	};
}

/** Validates a scope list against the vocabulary; `undefined` keeps the default grant. */
function checkScopes(scopes: unknown): Scope[] | undefined {
	if (scopes === undefined) return undefined;
	if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) {
		throw new UserStoreError('invalid-scopes', 'scopes must be an array of scope names');
	}
	const unknown = scopes.filter((scope) => !(SCOPES as readonly string[]).includes(scope));
	if (unknown.length > 0) {
		throw new UserStoreError(
			'invalid-scopes',
			`unknown scope${unknown.length === 1 ? '' : 's'} ${unknown.map((s) => JSON.stringify(s)).join(', ')}; ` +
				`the vocabulary is ${SCOPES.join(', ')}`,
		);
	}
	return [...new Set(scopes as Scope[])];
}

function checkPassword(password: unknown): string {
	if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
		throw new UserStoreError(
			'invalid-password',
			`a password is ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
		);
	}
	return password;
}

function checkUsername(username: unknown): string {
	const parsed = AdminUserRecordSchema.shape.username.safeParse(username);
	if (!parsed.success) {
		throw new UserStoreError('invalid-username', 'a username is 1 to 64 printable characters');
	}
	return parsed.data;
}

export class UserStore {
	readonly #path: string | null;
	readonly #logger: UserStoreOptions['logger'];
	#users = new Map<string, StoredUser>();
	#status: UserStoreStatus = 'memory';
	#queue: Promise<void> = Promise.resolve();
	/** Key hash → account name, for the verifier's per-request lookup. */
	#keyIndex: { source: Map<string, StoredUser>; owners: Map<string, string> } | null = null;

	constructor(options: UserStoreOptions) {
		this.#path = options.dataDir === null ? null : join(options.dataDir, USERS_FILE);
		this.#logger = options.logger;
		this.#load(options.seed);
	}

	get writable(): boolean {
		return this.#path !== null && this.#status !== 'unreadable';
	}

	get status(): UserStoreStatus {
		return this.#status;
	}

	get size(): number {
		return this.#users.size;
	}

	list(): PublicUser[] {
		return [...this.#users.values()].map(publicView);
	}

	get(username: string): PublicUser | null {
		const user = this.#users.get(username);
		return user === undefined ? null : publicView(user);
	}

	/** Whether `username` is an account, enabled or not. */
	has(username: string): boolean {
		return this.#users.has(username);
	}

	/** The scopes `username` holds right now, or `null` when the account is gone or disabled. */
	scopesOf(username: string): ReadonlySet<Scope> | null {
		const user = this.#users.get(username);
		if (user === undefined || user.disabled === true) return null;
		return new Set(user.scopes ?? DEFAULT_SCOPES);
	}

	/**
	 * The account's stored password material as one string, `salt.hash.iterations`, or `null` when the account is gone
	 * or disabled.
	 */
	credentialDigest(username: string): string | null {
		const user = this.#users.get(username);
		if (user === undefined || user.disabled === true) return null;
		return `${user.salt}.${user.hash}.${user.iterations}`;
	}

	/**
	 * The account key whose SHA-256 is `sha256`, with the scopes it may use **now** — its stored scopes narrowed to its
	 * account's current ones, so narrowing an account narrows its keys without rewriting them — or `null` when no key
	 * has that hash or its account is disabled.
	 */
	findKey(sha256: string): AccountKeyHit | null {
		if (this.#keyIndex?.source !== this.#users) {
			const owners = new Map<string, string>();
			for (const user of this.#users.values()) for (const key of user.keys ?? []) owners.set(key.sha256, user.username);
			this.#keyIndex = { source: this.#users, owners };
		}
		const username = this.#keyIndex.owners.get(sha256);
		const user = username === undefined ? undefined : this.#users.get(username);
		return keyHit(user, (entry) => entry.sha256 === sha256);
	}

	/**
	 * The key `id` on `username`'s account, as {@linkcode findKey} answers it — the scopes it may use now — or `null`
	 * when the account is gone or disabled or holds no such key.
	 */
	findKeyById(username: string, id: string): AccountKeyHit | null {
		return keyHit(this.#users.get(username), (entry) => entry.id === id);
	}

	/**
	 * Stores a key on `username`'s account. Only the key's hash and display prefix arrive here — the caller minted it
	 * and returns it to the person once.
	 */
	async addKey(username: string, input: NewAccountKey): Promise<PublicKey> {
		this.#requireWritable();
		const checked = checkNewKey(input);
		let added: StoredKey | null = null;
		await this.#mutate((users) => {
			const current = users.get(username);
			if (current === undefined) throw new UserStoreError('not-found', `no user ${JSON.stringify(username)}`);
			const key = buildKey(current, input, checked, users);
			users.set(username, {
				...current,
				keys: [...(current.keys ?? []), key],
				updated_at: new Date().toISOString(),
			});
			added = key;
		});
		return publicKeyView(added!);
	}

	/** Removes key `id` from `username`'s account. */
	async removeKey(username: string, id: string): Promise<{ sha256: string }> {
		this.#requireWritable();
		let removed: StoredKey | null = null;
		await this.#mutate((users) => {
			const current = users.get(username);
			if (current === undefined) throw new UserStoreError('not-found', `no user ${JSON.stringify(username)}`);
			const keys = current.keys ?? [];
			const key = keys.find((entry) => entry.id === id);
			if (key === undefined) {
				throw new UserStoreError('not-found', `user ${JSON.stringify(username)} holds no key ${JSON.stringify(id)}`);
			}
			const { keys: _keys, ...rest } = current;
			const remaining = keys.filter((entry) => entry !== key);
			// An account without keys is written with no `keys` field at all, so the record stays the keyless shape.
			users.set(username, {
				...rest,
				...(remaining.length === 0 ? {} : { keys: remaining }),
				updated_at: new Date().toISOString(),
			});
			removed = key;
		});
		return { sha256: (removed as StoredKey | null)!.sha256 };
	}

	/** Enabled accounts holding `admin`: the set that must never reach zero through this store. */
	enabledAdminCount(): number {
		let count = 0;
		for (const user of this.#users.values()) {
			if (user.disabled !== true && (user.scopes ?? DEFAULT_SCOPES).includes('admin')) count += 1;
		}
		return count;
	}

	/**
	 * The startup warning for a store that has accounts but no enabled administrator — nobody can manage accounts from
	 * the control plane, and the remedy is offline.
	 */
	adminWarning(): string | null {
		if (this.#users.size === 0 || this.enabledAdminCount() > 0) return null;
		return `no enabled account holds the admin scope, so accounts cannot be managed from the control plane; ` +
			'grant it offline with `doctor --grant <user> --scopes <list>` (include admin)';
	}

	/**
	 * Constant-time password check; a disabled account fails exactly like an unknown one, and takes as long — an
	 * unknown or disabled name is checked against a decoy record with the default work factor, so the time a failure
	 * takes does not tell a stranger which usernames exist.
	 */
	async verify(username: string, password: string): Promise<PublicUser | null> {
		const user = this.#users.get(username);
		if (user === undefined || user.disabled === true) {
			await verifyPassword(password, DECOY);
			return null;
		}
		return (await verifyPassword(password, user)) ? publicView(user) : null;
	}

	/** Creates an account. */
	async create(
		input: { username: unknown; password: unknown; scopes?: unknown; key?: NewAccountKey },
	): Promise<PublicUser> {
		this.#requireWritable();
		const username = checkUsername(input.username);
		const password = checkPassword(input.password);
		const scopes = checkScopes(input.scopes);
		const keyInput = input.key;
		const checkedKey = keyInput === undefined ? undefined : checkNewKey(keyInput);
		if (this.#users.has(username)) throw new UserStoreError('duplicate', `user ${JSON.stringify(username)} exists`);
		const { salt, hash, iterations } = await hashPassword(password);
		const now = new Date().toISOString();
		const account: StoredUser = {
			username,
			salt,
			hash,
			iterations,
			scopes: scopes ?? [...DEFAULT_SCOPES],
			created_at: now,
			updated_at: now,
		};
		let user = account;
		await this.#mutate((users) => {
			if (users.has(username)) throw new UserStoreError('duplicate', `user ${JSON.stringify(username)} exists`);
			user = keyInput === undefined || checkedKey === undefined
				? account
				: { ...account, keys: [buildKey(account, keyInput, checkedKey, users)] };
			users.set(username, user);
		});
		return publicView(user);
	}

	async update(username: string, patch: { scopes?: unknown; disabled?: unknown }): Promise<PublicUser> {
		this.#requireWritable();
		const scopes = checkScopes(patch.scopes);
		if (patch.disabled !== undefined && typeof patch.disabled !== 'boolean') {
			throw new UserStoreError('invalid-scopes', 'disabled must be a boolean');
		}
		let updated: StoredUser | null = null;
		await this.#mutate((users) => {
			const current = users.get(username);
			if (current === undefined) throw new UserStoreError('not-found', `no user ${JSON.stringify(username)}`);
			updated = {
				...current,
				...(scopes === undefined ? {} : { scopes }),
				...(patch.disabled === undefined ? {} : { disabled: patch.disabled as boolean }),
				updated_at: new Date().toISOString(),
			};
			users.set(username, updated);
			this.#guardLastAdmin(users);
		});
		return publicView(updated!);
	}

	async setPassword(username: string, password: unknown): Promise<void> {
		this.#requireWritable();
		const checked = checkPassword(password);
		if (!this.#users.has(username)) throw new UserStoreError('not-found', `no user ${JSON.stringify(username)}`);
		const { salt, hash, iterations } = await hashPassword(checked);
		await this.#mutate((users) => {
			const current = users.get(username);
			if (current === undefined) throw new UserStoreError('not-found', `no user ${JSON.stringify(username)}`);
			users.set(username, { ...current, salt, hash, iterations, updated_at: new Date().toISOString() });
		});
	}

	async remove(username: string): Promise<void> {
		this.#requireWritable();
		await this.#mutate((users) => {
			if (!users.delete(username)) throw new UserStoreError('not-found', `no user ${JSON.stringify(username)}`);
			this.#guardLastAdmin(users);
		});
	}

	#guardLastAdmin(users: Map<string, StoredUser>): void {
		let admins = 0;
		for (const user of users.values()) {
			if (user.disabled !== true && (user.scopes ?? DEFAULT_SCOPES).includes('admin')) admins += 1;
		}
		if (admins === 0 && this.enabledAdminCount() > 0) {
			throw new UserStoreError('last-admin', 'at least one enabled account must hold the admin scope');
		}
	}

	#requireWritable(): void {
		if (this.#path === null) {
			throw new UserStoreError('persistence-required', 'managing users needs TTK_DATA_DIR');
		}
		if (this.#status === 'unreadable') {
			throw new UserStoreError('persistence-required', `${this.#path} is unreadable; repair or remove it first`);
		}
	}

	/** Applies `change` to a copy of the map **when its turn comes**, persists it, then publishes it. */
	#mutate(change: (users: Map<string, StoredUser>) => void): Promise<void> {
		const run = this.#queue.then(async () => {
			const next = new Map(this.#users);
			change(next);
			await this.#persist(next);
			this.#users = next;
			this.#status = 'ok';
		});
		this.#queue = run.catch(() => {});
		return run;
	}

	#serialize(users: Map<string, StoredUser>): string {
		return serializeUsers([...users.values()]);
	}

	async #persist(users: Map<string, StoredUser>): Promise<void> {
		const path = this.#path;
		if (path === null) return;
		await Deno.mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		await Deno.writeTextFile(temporary, this.#serialize(users));
		try {
			await Deno.rename(temporary, path);
		} catch (cause) {
			await Deno.remove(temporary).catch(() => {});
			throw cause;
		}
	}

	#load(seed: AdminUserRecord | null): void {
		const path = this.#path;
		const seeded = new Map<string, StoredUser>();
		if (seed !== null) {
			const now = new Date().toISOString();
			// A seed that names no scopes is a scope-less version-1 record: it seeds the store with
			// `SCOPELESS_ACCOUNT_SCOPES` written out, exactly as a version-1 file is upgraded.
			const [upgraded] = upgradeUsers([{ ...seed, created_at: now, updated_at: now }]).users;
			seeded.set(seed.username, upgraded!);
		}
		const seedUpgraded = (): void => {
			if (seed !== null && seed.scopes === undefined) {
				this.#logger?.info?.(`${migratedMessage(1)} (the TTK_ADMIN_USER seed)`);
			}
		};
		if (path === null) {
			this.#users = seeded;
			this.#status = 'memory';
			seedUpgraded();
			return;
		}
		let raw: string;
		try {
			raw = Deno.readTextFileSync(path);
		} catch (cause) {
			if (cause instanceof Deno.errors.NotFound) {
				// First start: the secret becomes the first record, and the file becomes the authority.
				this.#users = seeded;
				seedUpgraded();
				try {
					Deno.mkdirSync(dirname(path), { recursive: true });
					const temporary = `${path}.${crypto.randomUUID()}.tmp`;
					Deno.writeTextFileSync(temporary, this.#serialize(seeded));
					Deno.renameSync(temporary, path);
					this.#status = seeded.size > 0 ? 'seeded' : 'empty';
				} catch (writeCause) {
					this.#status = 'unreadable';
					this.#logger?.warn(
						`the user store at ${path} could not be created (${
							writeCause instanceof Error ? writeCause.message : String(writeCause)
						}); accounts cannot be managed until it can`,
					);
				}
				return;
			}
			this.#status = 'unreadable';
			this.#logger?.warn(
				`the user store at ${path} could not be read (${
					cause instanceof Error ? cause.message : String(cause)
				}); no password login is accepted until it can`,
			);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		const result = UsersFileSchema.safeParse(parsed);
		if (!result.success) {
			this.#status = 'unreadable';
			this.#logger?.warn(`the user store at ${path} is not a valid users file; no password login is accepted`);
			return;
		}
		let users = result.data.users;
		if (result.data.version === 1) {
			// The one-time upgrade. The upgraded accounts are served whether or not the write lands — an administrator
			// keeps `admin` either way — and a failed write is retried by the next start, which finds version 1 again.
			const upgraded = upgradeUsers(users);
			users = upgraded.users;
			try {
				const temporary = `${path}.${crypto.randomUUID()}.tmp`;
				Deno.writeTextFileSync(temporary, serializeUsers(users));
				Deno.renameSync(temporary, path);
				this.#logger?.info?.(migratedMessage(upgraded.migrated));
			} catch (cause) {
				this.#logger?.warn(
					`the user store at ${path} could not be upgraded to explicit scopes (${
						cause instanceof Error ? cause.message : String(cause)
					}); the upgrade is applied in memory and retried at the next start`,
				);
			}
		}
		// A new map, never an edit of the current one: the key index is keyed on the map's identity.
		this.#users = new Map(users.map((user) => [user.username, user]));
		this.#status = this.#users.size === 0 ? 'empty' : 'ok';
	}
}

function serializeUsers(users: readonly StoredUser[]): string {
	const file: z.infer<typeof UsersFileSchema> = { version: USERS_SCHEMA_VERSION, users: [...users] };
	return `${JSON.stringify(file, null, '\t')}\n`;
}

/**
 * The startup warning for a deployment that has API keys and no administrator anywhere — no key and no enabled account
 * holds `admin`.
 */
export function apiKeyAdminWarning(
	keys: ReadonlyArray<{ readonly scopes?: readonly string[] | undefined }>,
	enabledAdminAccounts: number,
): string | null {
	if (keys.length === 0 || enabledAdminAccounts > 0) return null;
	if (keys.some((key) => (key.scopes ?? DEFAULT_SCOPES).includes('admin'))) return null;
	const scopeless = keys.filter((key) => key.scopes === undefined).length;
	const cause = scopeless === 0
		? ''
		: `; ${scopeless === 1 ? 'one key names' : `${scopeless} keys name`} no scopes and so holds the defaults, ` +
			'which do not include admin';
	return 'no API key and no enabled account holds the admin scope, so the control plane offers no Sessions, Users ' +
		`or System screens; add "admin" to a key's "scopes" in TTK_API_KEYS or TTK_API_KEYS_FILE, or mint one with ` +
		'`doctor --new-key <id> --scopes mcp:invoke,admin`' + cause;
}

/**
 * `doctor --grant` — sets one account's scopes with the server stopped, the remedy when no enabled account holds
 * `admin` and so nobody can reach the Users screen.
 */
export async function grantScopesInFile(
	dataDir: string,
	username: string,
	scopes: unknown,
): Promise<{ user: PublicUser; migrated: number; path: string }> {
	const path = join(dataDir, USERS_FILE);
	let raw: string;
	try {
		raw = await Deno.readTextFile(path);
	} catch (cause) {
		if (cause instanceof Deno.errors.NotFound) {
			throw new UserStoreError('not-found', `${path} does not exist; start the gateway once to create it`);
		}
		throw cause;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	const result = UsersFileSchema.safeParse(parsed);
	if (!result.success) throw new UserStoreError('persistence-required', `${path} is not a valid users file`);
	const upgraded = result.data.version === 1
		? upgradeUsers(result.data.users)
		: { users: result.data.users, migrated: 0 };
	const users = new Map(upgraded.users.map((user) => [user.username, user]));
	const user = applyGrant(users, username, scopes);
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	await Deno.writeTextFile(temporary, serializeUsers([...users.values()]));
	try {
		await Deno.rename(temporary, path);
	} catch (cause) {
		await Deno.remove(temporary).catch(() => {});
		throw cause;
	}
	return { user: publicView(user), migrated: upgraded.migrated, path };
}

/** Sets `username`'s scopes in `users` (in place) under the store's rules; returns the changed record. */
function applyGrant(users: Map<string, StoredUser>, username: string, scopes: unknown): StoredUser {
	const checked = checkScopes(scopes);
	if (checked === undefined) throw new UserStoreError('invalid-scopes', 'name the scopes to grant with --scopes');
	const current = users.get(username);
	if (current === undefined) throw new UserStoreError('not-found', `no user ${JSON.stringify(username)}`);
	const enabledAdmins = (map: Map<string, StoredUser>): number =>
		[...map.values()].filter((user) => user.disabled !== true && (user.scopes ?? DEFAULT_SCOPES).includes('admin'))
			.length;
	const before = enabledAdmins(users);
	const updated: StoredUser = { ...current, scopes: checked, updated_at: new Date().toISOString() };
	users.set(username, updated);
	if (before > 0 && enabledAdmins(users) === 0) {
		users.set(username, current);
		throw new UserStoreError('last-admin', 'at least one enabled account must hold the admin scope');
	}
	return updated;
}
