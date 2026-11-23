/** Authentication: one gate, a chain of verifiers. */
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { encodeHex } from '@std/encoding/hex';
import { timingSafeEqual } from '@std/crypto/timing-safe-equal';
import { type ApiKeyRecord, type Config, DEFAULT_SCOPES, type Scope } from './config.ts';
import { LOGIN_TOKEN_PREFIX, LoginStore, type StoredLogin } from './logins.ts';
import { type AccountKeyHit, UserStore } from './users.ts';

/** How long an API-key principal's `AuthInfo` claims to be valid. */
const API_KEY_HORIZON_S = 300;

/** The prefix every TykoTech API key carries. */
const API_KEY_PREFIX = 'ttk_';

/** The authenticated caller. */
export interface Principal {
	readonly kind: 'api-key' | 'anonymous-loopback';
	readonly id: string;
	readonly scopes: ReadonlySet<Scope>;
	/**
	 * `ApiKeyRecord.label`, when the credential carries one (`holder_name`). Validated at config parse, so it is safe
	 * to show every viewer of every session. `null` for the other kinds.
	 */
	readonly label?: string | null;
	/**
	 * An opaque fingerprint of the exact credential this principal was verified from — `api-key:<record sha256>`,
	 * `user-key:<sha256>` (an account's own key) or `session:<id>` — so work that outlives the request (a queued task,
	 * a long-lived stream) is re-bound to that credential rather than to whichever credential later authenticates as
	 * the same owner.
	 */
	readonly credential?: string;
}

/** The owner of the credential-less loopback principal; there is exactly one. */
export const ANONYMOUS_OWNER = 'anonymous-loopback:local';

/** New resources use the verified authentication realm as part of their owner. */
export function expansionOwner(principal: Principal): string {
	return principal.kind === 'anonymous-loopback' ? ANONYMOUS_OWNER : `${principal.kind}:${principal.id}`;
}

/** The principal id an administrator login carries; config parsing refuses API-key ids that could spell one. */
function adminIdOf(admin: { readonly username: string }): string {
	return `admin:${admin.username}`;
}

/** The `holder_name` an administrator login shows every viewer: one spelling, for every mint. */
function adminLabelOf(username: string): string {
	return `Administrator (${username})`;
}

/** The credential kind of an account's own API key — `user-key:<sha256>`. */
const USER_KEY = 'user-key:';

/** The length of an account key's display prefix — `ttk_` and four characters, what `keyPrefix` logs. */
const ACCOUNT_KEY_PREFIX_LENGTH = 8;

/** The id alphabet of an account key: lowercase base32, path-safe and unambiguous to read aloud. */
const KEY_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Mints a key for an account. */
export async function generateAccountKey(): Promise<{ secret: string; id: string; prefix: string; sha256: string }> {
	const { key, record } = await generateApiKey('account-key');
	// 256 is a multiple of 32, so masking a random byte to five bits picks each character uniformly.
	const id = `k_${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => KEY_ID_ALPHABET[b & 31]).join('')}`;
	return { secret: key, id, prefix: key.slice(0, ACCOUNT_KEY_PREFIX_LENGTH), sha256: record.sha256 };
}

/** Renders a credential for logs. Never log more than this. */
export function keyPrefix(token: string): string {
	return token.length <= 8 ? '<short>' : `${token.slice(0, 8)}…`;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return encodeHex(new Uint8Array(digest));
}

/** Generates a new API key. Returns the raw key (shown once) and its record. */
export async function generateApiKey(id: string, scopes?: readonly Scope[]): Promise<{
	key: string;
	record: ApiKeyRecord;
}> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const body = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const key = `${API_KEY_PREFIX}${body}`;
	const record: ApiKeyRecord = {
		id,
		sha256: await sha256Hex(key),
		...(scopes === undefined ? {} : { scopes: [...scopes] }),
	};
	return { key, record };
}

/**
 * Verifies API keys against SHA-256 hashes. The record set is replaceable, and that is what makes revocation reachable.
 */
export class ApiKeyStore {
	#records: readonly ApiKeyRecord[];

	constructor(records: readonly ApiKeyRecord[]) {
		this.#records = records;
	}

	get size(): number {
		return this.#records.length;
	}

	/** The records in force right now. */
	get records(): readonly ApiKeyRecord[] {
		return this.#records;
	}

	/** Replaces every record. */
	replace(records: readonly ApiKeyRecord[]): boolean {
		if (records.length === 0) return false;
		this.#records = records;
		return true;
	}

	/** True when a record with this id is still configured. */
	hasId(id: string): boolean {
		return this.#records.some((record) => record.id === id);
	}

	async verify(token: string): Promise<Principal | null> {
		if (this.#records.length === 0) return null;
		const presented = new TextEncoder().encode(await sha256Hex(token));
		let matched: ApiKeyRecord | null = null;
		for (const record of this.#records) {
			const candidate = new TextEncoder().encode(record.sha256);
			// Constant-time, and deliberately not short-circuited.
			if (timingSafeEqual(presented, candidate)) matched = record;
		}
		if (matched === null) return null;
		// A record that names no scopes gets DEFAULT_SCOPES, not the whole vocabulary. An EXPLICIT_SCOPES member is
		// only ever held by a record that named it.
		return {
			kind: 'api-key',
			id: matched.id,
			scopes: new Set(matched.scopes ?? DEFAULT_SCOPES),
			label: matched.label ?? null,
			// The record's hash pins this exact key. Rotation keeps the id and changes the hash, so work submitted
			// under the old key is told apart from the replacement's.
			credential: `api-key:${matched.sha256}`,
		};
	}
}

export interface VerifierChainOptions {
	readonly config: Config;
	/** Set when the bind policy permits anonymous loopback use. */
	readonly allowAnonymous: boolean;
	readonly logger?: { warn(msg: string): void };
	/** The account store; defaults to an in-memory store seeded from `config.adminUser`. */
	readonly users?: UserStore;
	/** The sign-in session store; defaults to in-memory. */
	readonly logins?: LoginStore;
}

/** The composite verifier handed to the SDK's bearer-auth gate. */
export class VerifierChain implements OAuthTokenVerifier {
	#listeners = new Set<() => void>();
	readonly #apiKeys: ApiKeyStore;
	readonly #users: UserStore;
	readonly #logins: LoginStore;
	readonly #loginTtlMs: number;
	readonly #allowAnonymous: boolean;
	readonly #anonScopes: readonly Scope[];
	readonly #logger: VerifierChainOptions['logger'];

	constructor(options: VerifierChainOptions) {
		this.#apiKeys = new ApiKeyStore(options.config.apiKeys);
		this.#users = options.users ??
			new UserStore({ dataDir: null, seed: options.config.adminUser ?? null, logger: options.logger });
		this.#logins = options.logins ?? new LoginStore({ dataDir: null, logger: options.logger });
		this.#loginTtlMs = options.config.loginTtlMs;
		this.#allowAnonymous = options.allowAnonymous;
		this.#anonScopes = options.config.anonScopes;
		this.#logger = options.logger;
	}

	/** True when at least one real credential is configured. */
	get credentialed(): boolean {
		return this.#apiKeys.size > 0 || this.#users.size > 0;
	}

	/** The account store behind password logins. */
	get users(): UserStore {
		return this.#users;
	}

	/** The sign-in session store. */
	get logins(): LoginStore {
		return this.#logins;
	}

	get loginTtlMs(): number {
		return this.#loginTtlMs;
	}

	async verifyAdmin(username: string, password: string): Promise<Principal | null> {
		const user = await this.#users.verify(username, password);
		if (user === null) return null;
		// An administrator is a principal like any other: it holds the scopes its account record carries, and an
		// EXPLICIT_SCOPES member only when the record names it.
		return {
			kind: 'api-key',
			id: adminIdOf(user),
			scopes: new Set(user.scopes),
			label: adminLabelOf(user.username),
			credential: `user:${user.username}`,
		};
	}

	/** Mints a sign-in session for `principal`. */
	async mintSession(principal: Principal): Promise<{ token: string; expires: number }> {
		const backing = principal.credential ?? `user:${principal.id.replace(/^admin:/, '')}`;
		return await this.#logins.mint(principal, backing, this.#loginTtlMs);
	}

	/** The session, not the id, is the credential — logging out ends what it started. */
	async closeSession(token: string): Promise<boolean> {
		const closed = this.#logins.close(await sha256Hex(token));
		if (closed) this.#notify();
		return closed;
	}

	/**
	 * Ends every sign-in backed by `backing` except the one whose token hash is `keep` (a password change keeps the
	 * session that made it). Returns how many closed; tasks and streams under them fail closed at once.
	 */
	closeLoginsOf(backing: string, keep?: string): number {
		const closed = this.#logins.closeWhere((entry) => entry.backing === backing && entry.hash !== keep);
		if (closed > 0) this.#notify();
		return closed;
	}

	/**
	 * Ends, at once, everything that stood on `backing` — the sign-ins it backs (`POST /api/v1/auth/login` with the key
	 * mints one backed by `user-key:<sha256>`) — and tells the listeners, so the tasks and streams under it fail at
	 * once rather than at their next re-check.
	 */
	revokeCredential(backing: string): number {
		return this.#revoke((credential) => credential === backing);
	}

	/**
	 * {@linkcode revokeCredential} for every account key not in force — after an account is disabled or deleted its
	 * keys stop resolving, and this ends what they backed without the caller having to know their hashes.
	 */
	revokeLapsedAccountKeys(): number {
		return this.#revoke((credential) => credential.startsWith(USER_KEY) && this.#backingScopes(credential) === null);
	}

	/** The one revocation sweep: the sign-ins whose backing `lapsed` names. */
	#revoke(lapsed: (credential: string) => boolean): number {
		const closed = this.#logins.closeWhere((entry) => lapsed(entry.backing));
		this.#notify();
		return closed;
	}

	/** The scopes the credential behind a sign-in holds right now, or `null` once it is gone. */
	#backingScopes(backing: string): ReadonlySet<Scope> | null {
		if (backing.startsWith('user:')) return this.#users.scopesOf(backing.slice('user:'.length));
		// A sign-in opened by exchanging an account key holds what the key may use now — its scopes narrowed to its
		// account's — and ends with the key, a disabled account or a deleted one.
		if (backing.startsWith(USER_KEY)) return this.#users.findKey(backing.slice(USER_KEY.length))?.scopes ?? null;
		if (backing.startsWith('api-key:')) {
			const sha = backing.slice('api-key:'.length);
			const record = this.#apiKeys.records.find((entry) => entry.sha256 === sha);
			return record === undefined ? null : new Set(record.scopes ?? DEFAULT_SCOPES);
		}
		return null;
	}

	/** The principal a stored sign-in stands for, with the backing's **current** scopes. */
	#sessionPrincipal(entry: StoredLogin, scopes: ReadonlySet<Scope>): Principal {
		return {
			kind: entry.principal.kind,
			id: entry.principal.id,
			scopes,
			label: entry.principal.label,
			credential: `session:${entry.hash}`,
		};
	}

	/**
	 * Runs `listener` whenever a credential stops being what it was — the key file reloaded or a session ended — so the
	 * gateway can fail that credential's tasks and close its streams now rather than at their next re-check.
	 */
	onCredentialsChanged(listener: () => void): () => void {
		this.#listeners.add(listener);
		return (): void => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * An account's scopes were edited: nothing ends, but every listener re-reads what its credentials hold — the MCP
	 * sessions above all, which register tools by scope and must tell their clients to re-list.
	 */
	scopesChanged(): void {
		this.#notify();
	}

	#notify(): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// One consumer's fault must not stop the others from revoking.
			}
		}
	}

	/** The scopes the exact credential behind `owner` holds right now, or `null` once it is gone. */
	#current(owner: string, credential: string | undefined): ReadonlySet<Scope> | null {
		if (owner === ANONYMOUS_OWNER) return this.#allowAnonymous && !this.credentialed ? new Set(this.#anonScopes) : null;
		if (credential === undefined) return null;
		const separator = credential.indexOf(':');
		const kind = credential.slice(0, separator);
		const value = credential.slice(separator + 1);
		if (kind === 'api-key') {
			const record = this.#apiKeys.records.find((entry) => entry.sha256 === value);
			return record !== undefined && owner === `api-key:${record.id}` ? new Set(record.scopes ?? DEFAULT_SCOPES) : null;
		}
		if (kind === 'user-key') {
			// The key must still be held by an enabled account, and the work must be that account's own — the same
			// owner its password sign-in has, because the key acts as the account.
			const hit = this.#users.findKey(value);
			return hit !== null && owner === `api-key:${adminIdOf(hit)}` ? new Set(hit.scopes) : null;
		}
		if (kind === 'session') {
			const entry = this.#logins.get(value);
			if (entry === null) return null;
			const scopes = this.#backingScopes(entry.backing);
			if (scopes === null || owner !== expansionOwner(this.#sessionPrincipal(entry, scopes))) return null;
			return scopes;
		}
		return null;
	}

	/**
	 * The scopes a queued or running agent task may use now — what it was submitted with, narrowed to what its own
	 * credential still holds — or `null` once that credential is revoked, rotated, expired or logged out.
	 */
	authorizeTask(
		owner: string,
		scopes: ReadonlySet<string>,
		credential: string | undefined,
	): ReadonlySet<string> | null {
		const current = this.#current(owner, credential);
		return current === null ? null : new Set([...scopes].filter((scope) => current.has(scope as Scope)));
	}

	/** The scopes `principal` holds right now, for a long-lived stream that must re-earn its authorization. */
	currentScopes(principal: Principal): ReadonlySet<Scope> | null {
		const current = this.#current(expansionOwner(principal), principal.credential);
		return current === null ? null : new Set([...principal.scopes].filter((scope) => current.has(scope)));
	}

	/**
	 * The scopes the principal behind a realm-qualified `owner` holds **now**, or `null` once it is gone — the re-check
	 * a signed link makes before it serves a byte, with no credential in hand.
	 */
	ownerScopes(owner: string, key?: string): ReadonlySet<Scope> | null {
		if (key !== undefined) return this.#ownerKey(owner, key)?.scopes ?? null;
		if (owner === ANONYMOUS_OWNER) return this.#allowAnonymous && !this.credentialed ? new Set(this.#anonScopes) : null;
		if (owner.startsWith('api-key:')) {
			const id = owner.slice('api-key:'.length);
			if (id.startsWith('admin:')) return this.#users.scopesOf(id.slice('admin:'.length));
			const record = this.#apiKeys.records.find((entry) => entry.id === id);
			return record === undefined ? null : new Set(record.scopes ?? DEFAULT_SCOPES);
		}
		return null;
	}

	/**
	 * What the credential behind a realm-qualified `owner` **is** right now, as the input to a signed link's keyed
	 * credential epoch — or `null` once it is gone.
	 */
	ownerCredentialDigest(owner: string, key?: string): string | null {
		if (key !== undefined) {
			const hit = this.#ownerKey(owner, key);
			const account = hit === null ? null : this.#users.credentialDigest(hit.username);
			return hit === null || account === null ? null : `${account}\0${USER_KEY}${hit.key.sha256}`;
		}
		if (owner === ANONYMOUS_OWNER) return this.#allowAnonymous && !this.credentialed ? 'anonymous' : null;
		if (owner.startsWith('api-key:')) {
			const id = owner.slice('api-key:'.length);
			// The same lookups `ownerScopes` makes, so the two can never answer about different records.
			if (id.startsWith('admin:')) return this.#users.credentialDigest(id.slice('admin:'.length));
			return this.#apiKeys.records.find((entry) => entry.id === id)?.sha256 ?? null;
		}
		return null;
	}

	/**
	 * What a signed link `owner` mints under `credential` (the call's credential fingerprint) is bound to — the input
	 * to its keyed epoch and, for an account API key, that key's public id (the token's `k` claim) — or `null` when the
	 * credential is not in force, which the minter refuses as `scope-required`.
	 */
	linkBinding(
		owner: string,
		credential: string | undefined,
	): { readonly digest: string; readonly key?: string } | null {
		let sha: string | undefined;
		if (credential?.startsWith(USER_KEY)) sha = credential.slice(USER_KEY.length);
		else if (credential?.startsWith('session:')) {
			const entry = this.#logins.get(credential.slice('session:'.length));
			if (entry === null) return null;
			if (entry.backing.startsWith(USER_KEY)) sha = entry.backing.slice(USER_KEY.length);
		}
		if (sha === undefined) {
			const digest = this.ownerCredentialDigest(owner);
			return digest === null ? null : { digest };
		}
		const hit = this.#users.findKey(sha);
		if (hit === null || owner !== `api-key:${adminIdOf(hit)}`) return null;
		const digest = this.ownerCredentialDigest(owner, hit.key.id);
		return digest === null ? null : { digest, key: hit.key.id };
	}

	/** The account key `key` held by the account behind an `api-key:admin:<username>` owner, or `null`. */
	#ownerKey(owner: string, key: string): AccountKeyHit | null {
		const prefix = 'api-key:admin:';
		return owner.startsWith(prefix) ? this.#users.findKeyById(owner.slice(prefix.length), key) : null;
	}

	/** The API-key records in force right now — the reloadable set, not the startup copy. */
	get apiKeyRecords(): readonly ApiKeyRecord[] {
		return this.#apiKeys.records;
	}

	/** Swaps the API-key record set. */
	replaceApiKeys(records: readonly ApiKeyRecord[]): boolean {
		if (!this.#apiKeys.replace(records)) return false;
		// A sign-in minted from a key that is not in force ends with it.
		this.#logins.closeWhere((entry) =>
			entry.backing.startsWith('api-key:') && this.#backingScopes(entry.backing) === null
		);
		// That key's queued and running tasks fail and its streams close at once, not at the next re-check.
		this.#notify();
		return true;
	}

	async resolve(token: string): Promise<Principal | null> {
		if (token.startsWith(LOGIN_TOKEN_PREFIX)) {
			const entry = this.#logins.get(await sha256Hex(token));
			if (entry === null) return null;
			const scopes = this.#backingScopes(entry.backing);
			if (scopes === null) {
				// The account or key behind this sign-in is gone: the session ends here, not at an explicit close.
				this.#logins.close(entry.hash);
				return null;
			}
			return this.#sessionPrincipal(entry, scopes);
		}
		// A non-prefixed token may still be an API key whose prefix the operator stripped; the store is tried rather
		// than the token rejected on shape alone.
		return (await this.#apiKeys.verify(token)) ?? (await this.#accountKey(token));
	}

	/** The principal an account's own API key stands for, or `null` when no enabled account holds it. */
	async #accountKey(token: string): Promise<Principal | null> {
		const sha = await sha256Hex(token);
		const hit = this.#users.findKey(sha);
		if (hit === null) return null;
		return {
			kind: 'api-key',
			id: adminIdOf(hit),
			scopes: hit.scopes,
			label: adminLabelOf(hit.username),
			credential: `${USER_KEY}${sha}`,
		};
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const principal = await this.resolve(token);
		if (principal === null) {
			this.#logger?.warn(`rejected credential ${keyPrefix(token)}`);
			throw new OAuthError(OAuthErrorCode.InvalidToken, 'the presented credential is not valid');
		}
		return {
			...toAuthInfo(principal, token),
			extra: {
				principalKind: principal.kind,
				// The realm-qualified owner, minted here by `expansionOwner` — the function every REST and A2A route
				// uses — so the MCP mount reads it instead of deriving a second spelling of its own.
				owner: expansionOwner(principal),
				// Carried to the routes so tasks and streams can be re-bound to this exact credential.
				...(principal.credential === undefined ? {} : { credential: principal.credential }),
			},
		};
	}

	/** The principal used when no credential is configured and the bind is loopback. */
	anonymousPrincipal(remoteAddr: string): Principal | null {
		if (!this.#allowAnonymous || this.credentialed) return null;
		return { kind: 'anonymous-loopback', id: `anonymous:${remoteAddr}`, scopes: new Set(this.#anonScopes) };
	}
}

/** Builds the SDK's `AuthInfo`. */
function toAuthInfo(principal: Principal, token: string): AuthInfo {
	return {
		token,
		clientId: principal.id,
		scopes: [...principal.scopes],
		expiresAt: Math.floor(Date.now() / 1000) + API_KEY_HORIZON_S,
	};
}

/**
 * Recovers a principal from an `AuthInfo` produced by this module. The label does **not** survive this round trip:
 * `AuthInfo` is the SDK's shape and carries only the client id and the scopes, so a principal recovered here has none.
 */
export function principalFromAuthInfo(authInfo: AuthInfo): Principal {
	const credential = authInfo.extra?.credential;
	return {
		...(typeof credential === 'string' ? { credential } : {}),
		kind: authInfo.extra?.principalKind === 'api-key'
			? 'api-key'
			: authInfo.extra?.principalKind === 'anonymous-loopback'
			? 'anonymous-loopback'
			: authInfo.clientId.startsWith('anonymous:')
			? 'anonymous-loopback'
			: 'api-key',
		id: authInfo.clientId,
		scopes: new Set(authInfo.scopes as Scope[]),
	};
}

/** The `holder_name` for a principal: its credential's label, or `null`. */
export function holderNameOf(principal: Principal, records: readonly ApiKeyRecord[]): string | null {
	if (principal.label !== undefined && principal.label !== null) return principal.label;
	if (principal.kind !== 'api-key') return null;
	// An administrator login is an `api-key` principal `admin:<username>` whose label is declared by no key record, and
	// lost — like every label — on the trip through `AuthInfo`.
	if (principal.id.startsWith('admin:')) return adminLabelOf(principal.id.slice('admin:'.length));
	return records.find((record) => record.id === principal.id)?.label ?? null;
}
