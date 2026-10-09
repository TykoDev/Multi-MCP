/**
 * The user store: every password-authenticated account, persisted as one file (D-074).
 *
 * `TTK_ADMIN_USER` used to be the one administrator, read at startup and immutable until the secret was edited
 * and the process restarted. Managing accounts from the control plane needs a record set that a request can
 * change, so the secret became a **seed**: when `<TTK_DATA_DIR>/users.json` does not exist it is written with that
 * one record, and from then on the file is the authority and the secret is not consulted. Deleting the file
 * re-seeds. A deployment with no data dir keeps the seed in memory and refuses every mutation with
 * `persistence-required`, the same degradation the origin overlay chose (D-A3).
 *
 * Persistence copies `OriginOverlay`: a same-directory temporary file plus rename so a reader never sees a
 * half-written store, writes serialized through one promise chain, and a corrupt file degrading to an **empty**
 * store — nobody can log in, rather than somebody unexpected.
 *
 * **Schema version 2 (G15, D-098).** `admin` left `DEFAULT_SCOPES` (C7), and an account that named no scopes held
 * the defaults implicitly, so every administrator created before that change would have lost `admin` at the next
 * start. Version 2 marks a store whose every account names its scopes: loading a version-1 file writes
 * `LEGACY_DEFAULT_SCOPES` (the old default, `admin` included) into each record without `scopes`, persists
 * `version: 2`, and logs how many accounts it touched. It runs once — a version-2 file is loaded as it is — so a
 * later account without scopes gets the new defaults like any other credential. The seed record and the cluster
 * KV are upgraded the same way (the KV under its own marker key, {@linkcode USERS_SCHEMA_KEY}).
 *
 * **Account keys (D-146).** An account may also hold API keys minted from the control plane. A record carries each
 * key's SHA-256 and a display prefix, never the key: the raw `ttk_` key exists only in the one response that minted
 * it. The field is optional and additive, so the schema stays at version 2 — an older build parses a record without
 * it (zod drops the unknown field) and its next write drops the keys, which ends them: fail closed.
 */
import * as z from 'zod';
import { dirname, join } from '@std/path';
import { DEFAULT_SCOPES, LEGACY_DEFAULT_SCOPES, type Scope, SCOPES } from '@tykotech/mcp';
import { type AdminUserRecord, AdminUserRecordSchema, hashPassword, verifyPassword } from './admin_auth.ts';
import { KvReplica } from './kv_replica.ts';
import { withLockRetry } from './cluster.ts';

/** D-078: what an unknown or disabled name is checked against; no password matches its hash. */
const DECOY = {
	salt: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
	hash: '0'.repeat(64),
	iterations: 100_000,
};

export const USERS_FILE = 'users.json';

/** Password bounds for a supplied (not generated) password. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

export type UserStoreStatus = 'memory' | 'seeded' | 'ok' | 'empty' | 'unreadable' | 'cluster';

/**
 * D-146: the most keys one account holds. It bounds the record — in a cluster one account is one KV value, which Deno
 * KV caps at 64 KiB, and 25 keys are a few kilobytes — and the Users screen's list; past it a key must be revoked first.
 */
export const MAX_KEYS_PER_ACCOUNT = 25;

/** D-146: the longest key label — SEC-15's bound on a configured key's label, so one rule covers both. */
export const MAX_ACCOUNT_KEY_LABEL_LENGTH = 64;

/** D-146: a key id names the key in a route path (`/keys/{id}`), so it is a path-safe token. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * D-146: one key an account holds. `sha256` is the hash the verifier looks the presented key up by (the same digest an
 * `ApiKeyRecord` carries); `prefix` is the key's first characters, enough for a person to tell two keys apart and far
 * too few to guess the rest (the key is 256 random bits).
 */
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
	/** D-146: optional and additive; a record without it holds no key. */
	keys: z.array(StoredKeySchema).optional(),
});
export type StoredUser = z.infer<typeof StoredUserSchema>;

/** The schema version a store is written at (G15): every account names its scopes. */
export const USERS_SCHEMA_VERSION = 2;

/**
 * N2 / D-098: the cluster's record that its accounts are at {@linkcode USERS_SCHEMA_VERSION}. Deliberately outside
 * the `['ttk', 'users']` prefix — the replica lists that prefix as accounts, and its version key is a change counter
 * that moves on every write, so neither can say "this upgrade already ran".
 */
export const USERS_SCHEMA_KEY: Deno.KvKey = ['ttk', 'schema', 'users'];

const UsersFileSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), users: z.array(StoredUserSchema) });

/**
 * G15: the one-time upgrade. Every record that names no scopes is given the grant it held implicitly until `admin`
 * left the defaults; records that name scopes are returned as they are. `migrated` counts the records changed.
 */
export function upgradeUsers<T extends { scopes?: Scope[] | undefined }>(users: readonly T[]): {
	users: T[];
	migrated: number;
} {
	let migrated = 0;
	const upgraded = users.map((user) => {
		if (user.scopes !== undefined) return user;
		migrated += 1;
		return { ...user, scopes: [...LEGACY_DEFAULT_SCOPES] };
	});
	return { users: upgraded, migrated };
}

/** The line the upgrade logs; one wording for the file, the seed and the cluster. */
function migratedMessage(count: number): string {
	return `user store migrated: ${count} account${count === 1 ? '' : 's'} given explicit scopes`;
}

/**
 * C9 / D-099: how many accounts a deployment has before any store is opened — the seed record, or the records of a
 * readable `users.json` (either schema version). The bind policy counts these as credentials, as the verifier
 * already does; an unreadable or corrupt file counts as none, because it signs nobody in either.
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

/**
 * D-146: what a route may show of an account key — never its hash, and never the key (which no store ever holds).
 * `scopes` are the key's stored scopes; what it may use at any moment is these narrowed to its account's current
 * scopes ({@linkcode UserStore.findKey}).
 */
export interface PublicKey {
	readonly id: string;
	readonly label: string | null;
	readonly prefix: string;
	readonly scopes: readonly Scope[];
	readonly created_at: string;
}

/** What a list route may show: never the salt, hash or iteration count, and never a key's hash (D-146). */
export interface PublicUser {
	readonly username: string;
	readonly scopes: readonly Scope[];
	readonly disabled: boolean;
	readonly created_at: string;
	readonly updated_at: string;
	readonly keys: readonly PublicKey[];
}

/**
 * D-146: a key to store. The caller mints the key and hands over only what is kept — its hash and display prefix —
 * so the raw key never reaches the store. `scopes` omitted means the account's scopes at the moment of the write.
 */
export interface NewAccountKey {
	readonly id: string;
	readonly label?: unknown;
	readonly prefix: string;
	readonly sha256: string;
	readonly scopes?: unknown;
}

/** D-146: an account key the verifier found, with the scopes it may use now — its own, narrowed to its account's. */
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
	/** `info` carries the one-time upgrade line (G15); a logger without it still gets every warning. */
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
 * D-146 / D-148: the key on `user` that `match` picks, with the scopes it may use now — its stored scopes narrowed to
 * its account's current ones — or `null` when there is no such account, it is disabled, or it holds no such key. The
 * one reading both lookups ({@linkcode UserStore.findKey}, {@linkcode UserStore.findKeyById}) share, so a link route
 * and the bearer gate can never disagree about what a key may do.
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

/**
 * D-146: a key label, trimmed; `undefined` (or an empty string) means none. The rule is SEC-15's for a configured
 * key's label (`isSafeKeyLabel` in `config.ts`, which cannot be imported here: `config.ts` imports this module) —
 * at most 64 characters, no control character and none of `<`, `>`, `&` — so a label is safe to show anywhere.
 */
export function checkKeyLabel(label: unknown): string | undefined {
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

/** D-146: the shape checks a new key passes before any write — the rules that need the account come later. */
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
 * D-146: the key record `input` makes on `account`, judged against `users` as the write will commit it: every scope
 * must be one the account holds (a key never widens its account), the account holds at most
 * {@linkcode MAX_KEYS_PER_ACCOUNT}, and neither the id (within the account) nor the hash (anywhere) is taken.
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
export function checkScopes(scopes: unknown): Scope[] | undefined {
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

export function checkPassword(password: unknown): string {
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
	/** D-084: the cluster's KV, when clustering is on; then it, not the file, is the authority. */
	#replica: KvReplica<StoredUser> | null = null;
	/**
	 * D-146: key hash → account name, for the verifier's per-request lookup. Built from the account map it was built
	 * from (`source`) and rebuilt whenever `#users` is a different map — every write, load and cluster reload replaces
	 * the map rather than editing it — so no assignment site has to remember to refresh it.
	 */
	#keyIndex: { source: Map<string, StoredUser>; owners: Map<string, string> } | null = null;

	constructor(options: UserStoreOptions) {
		this.#path = options.dataDir === null ? null : join(options.dataDir, USERS_FILE);
		this.#logger = options.logger;
		this.#load(options.seed);
	}

	get writable(): boolean {
		return this.#replica !== null || (this.#path !== null && this.#status !== 'unreadable');
	}

	/**
	 * D-084: moves the accounts onto the cluster's KV, so every node signs in against the same accounts and an
	 * account change made on one node holds on all of them at once. The first node to attach carries its accounts
	 * (its file, or the seed) over; the others adopt what the KV holds.
	 */
	async attachCluster(kv: Deno.Kv, options: { pollMs?: number } = {}): Promise<void> {
		const replica = userReplica(kv, options, (entries) => {
			this.#users = entries;
		}, this.#logger);
		if (await replica.empty() && this.#users.size > 0) {
			// This node's accounts were upgraded when they loaded, so they arrive with the marker that says so. A node
			// that lost the race to carry its accounts over adopts what the winner wrote (the marker check fails).
			const marker = await withLockRetry(() => kv.get(USERS_SCHEMA_KEY));
			await replica.commit(
				[...this.#users.values()].map((user) => ({ key: user.username, value: user })),
				undefined,
				{ key: USERS_SCHEMA_KEY, versionstamp: marker.versionstamp, value: USERS_SCHEMA_VERSION },
			);
		}
		await replica.start();
		await this.#upgradeCluster(kv, replica);
		this.#replica = replica;
		this.#status = 'cluster';
	}

	/**
	 * G15 / N2: the cluster's one-time upgrade, guarded by {@linkcode USERS_SCHEMA_KEY}. The scope-less accounts and
	 * the marker are written in one atomic commit that also checks the collection has not moved, so of several nodes
	 * attaching at once exactly one upgrades and the rest see the marker and do nothing.
	 */
	async #upgradeCluster(kv: Deno.Kv, replica: KvReplica<StoredUser>): Promise<void> {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const marker = await withLockRetry(() => kv.get(USERS_SCHEMA_KEY));
			if (marker.value === USERS_SCHEMA_VERSION) return;
			const stamp = replica.versionstamp;
			const base = this.#users;
			const { users, migrated } = upgradeUsers([...base.values()]);
			const changes = users.filter((user) => base.get(user.username) !== user).map((user) => ({
				key: user.username,
				value: user,
			}));
			const guard = { key: USERS_SCHEMA_KEY, versionstamp: marker.versionstamp, value: USERS_SCHEMA_VERSION };
			if (await replica.commit(changes, stamp, guard)) {
				this.#users = new Map(users.map((user) => [user.username, user]));
				this.#logger?.info?.(`${migratedMessage(migrated)} (cluster store)`);
				return;
			}
			await replica.reload();
		}
		this.#logger?.warn(
			'the cluster account store could not be upgraded to explicit scopes (it kept changing); ' +
				'accounts without scopes hold the default grant until the next start retries',
		);
	}

	/** Stops following the cluster; for shutdown and tests. */
	detachCluster(): void {
		this.#replica?.close();
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

	/** The scopes `username` holds right now, or `null` when the account is gone or disabled (GW-1/GW-4). */
	scopesOf(username: string): ReadonlySet<Scope> | null {
		const user = this.#users.get(username);
		if (user === undefined || user.disabled === true) return null;
		return new Set(user.scopes ?? DEFAULT_SCOPES);
	}

	/**
	 * D-140 (containment-otel-links design §2.7): the account's stored password material as one string,
	 * `salt.hash.iterations`, or `null` when the account is gone or disabled. A password change writes a new salt and
	 * hash, so the value moves with the credential; it is the input to a signed link's keyed epoch
	 * (`VerifierChain.ownerCredentialDigest`) and nothing else. Never logged, rendered or returned by any route —
	 * {@linkcode PublicUser} still carries none of it.
	 */
	credentialDigest(username: string): string | null {
		const user = this.#users.get(username);
		if (user === undefined || user.disabled === true) return null;
		return `${user.salt}.${user.hash}.${user.iterations}`;
	}

	/**
	 * D-146: the account key whose SHA-256 is `sha256`, with the scopes it may use **now** — its stored scopes narrowed
	 * to its account's current ones, so narrowing an account narrows its keys without rewriting them — or `null` when no
	 * key has that hash or its account is disabled. A lookup by hash, like the sign-in store's by token hash: the key is
	 * 256 random bits, so a map lookup's timing tells a guesser nothing it could use.
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
	 * D-148: the key `id` on `username`'s account, as {@linkcode findKey} answers it — the scopes it may use now — or
	 * `null` when the account is gone or disabled or holds no such key. A signed link minted under an account key names
	 * the key by this public id (never by its hash), and the link route asks here, on every follow, whether that key is
	 * still the one the link was minted under. The id is no secret: the Users screen lists it.
	 */
	findKeyById(username: string, id: string): AccountKeyHit | null {
		return keyHit(this.#users.get(username), (entry) => entry.id === id);
	}

	/**
	 * D-146: stores a key on `username`'s account. Only the key's hash and display prefix arrive here — the caller
	 * minted it and returns it to the person once. The account's password material is untouched (a signed link's
	 * credential epoch, D-140, does not move); `updated_at` does, because the record changed.
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

	/**
	 * D-146: removes key `id` from `username`'s account. Returns the removed key's hash so the caller can end what it
	 * backed now (`VerifierChain.revokeCredential`); resolution would refuse it from this write on regardless — and so
	 * does the link route, D-148: a signed link minted under the key names it, and {@linkcode findKeyById} no longer
	 * finds it, on this node and on every node whose replica has read the write.
	 */
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
			// An account without keys is written as it was before D-146, with no `keys` field at all.
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
	 * G15: the startup warning for a store that has accounts but no enabled administrator — nobody can manage
	 * accounts from the control plane, and the remedy is offline. `null` when there is nothing to say (no accounts,
	 * or at least one enabled admin). The caller logs it once the store is in its final place (after a cluster attach).
	 */
	adminWarning(): string | null {
		if (this.#users.size === 0 || this.enabledAdminCount() > 0) return null;
		return `no enabled account holds the admin scope, so accounts cannot be managed from the control plane; ` +
			'grant it offline with `doctor --grant <user> --scopes <list>` (include admin)';
	}

	/**
	 * Constant-time password check; a disabled account fails exactly like an unknown one. D-078: and takes as long —
	 * an unknown or disabled name is checked against a decoy record with the default work factor, so the time a
	 * failure takes no longer tells a stranger which usernames exist.
	 */
	async verify(username: string, password: string): Promise<PublicUser | null> {
		const user = this.#users.get(username);
		if (user === undefined || user.disabled === true) {
			await verifyPassword(password, DECOY);
			return null;
		}
		return (await verifyPassword(password, user)) ? publicView(user) : null;
	}

	/**
	 * Creates an account. D-146: `key`, when given, is the account's first API key, stored in the **same** write, so
	 * the account and its key land together or not at all — a refused key (a scope the account will not hold, a bad
	 * label) creates nothing.
	 */
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
			// Built from the bare record on every attempt: a cluster commit that lost the race runs this again.
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
		if (this.#replica !== null) return;
		if (this.#path === null) {
			throw new UserStoreError('persistence-required', 'managing users needs TTK_DATA_DIR');
		}
		if (this.#status === 'unreadable') {
			throw new UserStoreError('persistence-required', `${this.#path} is unreadable; repair or remove it first`);
		}
	}

	/**
	 * Applies `change` to a copy of the map **when its turn comes**, persists it, then publishes it. Serialized for
	 * the reason the origin overlay gives: two writes that each snapshotted the map before awaiting would each
	 * persist a set missing the other's change.
	 */
	#mutate(change: (users: Map<string, StoredUser>) => void): Promise<void> {
		const run = this.#queue.then(async () => {
			const replica = this.#replica;
			if (replica !== null) {
				// D-084: committed only if no other node changed the accounts since this replica last read them;
				// otherwise the change is applied again to the fresh state, where its rules (a duplicate name, the last
				// admin) are judged against what the cluster really holds.
				for (let attempt = 0; attempt < 5; attempt += 1) {
					const base = this.#users;
					const stamp = replica.versionstamp;
					const next = new Map(base);
					change(next);
					const changes = [
						...[...next.values()].filter((user) => base.get(user.username) !== user).map((user) => ({
							key: user.username,
							value: user,
						})),
						...[...base.keys()].filter((name) => !next.has(name)).map((name) => ({ key: name, value: null })),
					];
					if (await replica.commit(changes, stamp)) {
						this.#users = next;
						return;
					}
					await replica.reload();
				}
				throw new UserStoreError('persistence-required', 'the cluster account store is too busy; try again');
			}
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
			// G15: a seed written before `admin` left the defaults names no scopes and meant the old default grant; it
			// seeds the store with that grant written out, exactly as a version-1 file is upgraded.
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
			// G15: once. The upgraded accounts are served whether or not the write lands — an administrator keeps
			// `admin` either way — and a failed write is retried by the next start, which finds version 1 again.
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
		// A new map, never an edit of the current one: the key index (D-146) is keyed on the map's identity.
		this.#users = new Map(users.map((user) => [user.username, user]));
		this.#status = this.#users.size === 0 ? 'empty' : 'ok';
	}
}

function serializeUsers(users: readonly StoredUser[]): string {
	const file: z.infer<typeof UsersFileSchema> = { version: USERS_SCHEMA_VERSION, users: [...users] };
	return `${JSON.stringify(file, null, '\t')}\n`;
}

/** The replica every account reader and writer of a cluster uses: the store itself and the offline grant. */
function userReplica(
	kv: Deno.Kv,
	options: { pollMs?: number },
	onReload: (entries: Map<string, StoredUser>) => void,
	logger: { warn(message: string): void } | undefined,
): KvReplica<StoredUser> {
	return new KvReplica<StoredUser>({
		kv,
		...options,
		prefix: ['ttk', 'users'],
		parse: (value) => {
			const parsed = StoredUserSchema.safeParse(value);
			return parsed.success ? parsed.data : null;
		},
		onReload,
		...(logger === undefined ? {} : { logger }),
	});
}

/**
 * R1-10: the startup warning for a deployment that has API keys and no administrator anywhere — no key and no
 * enabled account holds `admin`. `null` when there is nothing to say: no keys, an admin key, or an enabled admin
 * account (accounts without one have their own warning, {@linkcode UserStore.adminWarning}).
 *
 * C7 took `admin` out of the default grant, and an API key that names no `scopes` holds the defaults. A deployment
 * whose only administrator was such a key lost `admin` on upgrade and nothing said so at runtime: the control plane
 * simply offered no Sessions, Users or System screens. The remedy is in the key records, so the message names it.
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
			'which no longer include admin';
	return 'no API key and no enabled account holds the admin scope, so the control plane offers no Sessions, Users ' +
		`or System screens; add "admin" to a key's "scopes" in TTK_API_KEYS or TTK_API_KEYS_FILE, or mint one with ` +
		'`doctor --new-key <id> --scopes mcp:invoke,admin`' + cause;
}

/**
 * G15: `doctor --grant` — sets one account's scopes with the server stopped, the remedy when no enabled account holds
 * `admin` and so nobody can reach the Users screen. Validated like the route: the name must be an account, every
 * scope a member of the vocabulary, and the change may not leave zero enabled administrators where there was one. A
 * version-1 file is upgraded in the same write, so the other scope-less accounts keep the grant they held.
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

/**
 * N2 / G15: `doctor --grant` against a cluster's KV — the same rules as the file, written through the same replica
 * and optimistic commit the gateway uses, so running nodes reload the change within one poll. The KV's schema marker
 * is honoured: before it is set the scope-less accounts are upgraded in the same commit that sets it.
 */
export async function grantScopesInCluster(
	kv: Deno.Kv,
	username: string,
	scopes: unknown,
): Promise<{ user: PublicUser; migrated: number }> {
	let users = new Map<string, StoredUser>();
	const replica = userReplica(kv, {}, (entries) => {
		users = entries;
	}, undefined);
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await replica.reload();
		const stamp = replica.versionstamp;
		const marker = await withLockRetry(() => kv.get(USERS_SCHEMA_KEY));
		const upgraded = marker.value === USERS_SCHEMA_VERSION
			? { users: [...users.values()], migrated: 0 }
			: upgradeUsers([...users.values()]);
		const next = new Map(upgraded.users.map((user) => [user.username, user]));
		const user = applyGrant(next, username, scopes);
		const changes = [...next.values()].filter((entry) => users.get(entry.username) !== entry).map((entry) => ({
			key: entry.username,
			value: entry,
		}));
		const guard = marker.value === USERS_SCHEMA_VERSION
			? undefined
			: { key: USERS_SCHEMA_KEY, versionstamp: marker.versionstamp, value: USERS_SCHEMA_VERSION };
		if (await replica.commit(changes, stamp, guard)) return { user: publicView(user), migrated: upgraded.migrated };
	}
	throw new UserStoreError('persistence-required', 'the cluster account store is too busy; try again');
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
