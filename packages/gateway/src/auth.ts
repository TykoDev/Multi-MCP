/**
 * Authentication: one gate, a chain of verifiers.
 *
 * The gate has the shape the SDK's `requireBearerAuth` expects
 * (`OAuthTokenVerifier`), so the SDK's challenge rendering, scope checking and
 * metadata linkage are reused rather than reimplemented.
 *
 * See SPECS/SECURITY-AUTH.md §2.
 */
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { IssuerMetadata } from './oauth_discovery.ts';
import { encodeHex } from '@std/encoding/hex';
import { timingSafeEqual } from '@std/crypto/timing-safe-equal';
import { type ApiKeyRecord, type Config, DEFAULT_SCOPES, type OAuthConfig, type Scope, SCOPES } from './config.ts';
import { LOGIN_TOKEN_PREFIX, LoginStore, type StoredLogin } from './logins.ts';
import { type AccountKeyHit, UserStore } from './users.ts';

/** How long an API-key principal's `AuthInfo` claims to be valid. */
const API_KEY_HORIZON_S = 300;

/** The prefix every TykoTech API key carries. */
export const API_KEY_PREFIX = 'ttk_';

/** The authenticated caller. */
export interface Principal {
	readonly kind: 'api-key' | 'oauth' | 'anonymous-loopback';
	readonly id: string;
	readonly scopes: ReadonlySet<Scope>;
	/**
	 * `ApiKeyRecord.label`, when the credential carries one (B2.3, `holder_name`). Validated at config
	 * parse (SEC-15), so it is safe to show every viewer of every session. `null` for the other kinds.
	 */
	readonly label?: string | null;
	/**
	 * GW-1: an opaque fingerprint of the exact credential this principal was verified from — `api-key:<record
	 * sha256>`, `user-key:<sha256>` (an account's own key, D-146), `oauth:<exp ms>` or `session:<id>` — so work that
	 * outlives the request (a queued task, an ACP delegation, a long-lived stream) is re-bound to that credential rather
	 * than to whichever credential later authenticates as the same owner. In-process only: never rendered, logged or
	 * returned. Absent for the anonymous loopback principal, which has no credential to fingerprint.
	 */
	readonly credential?: string;
}

/** The owner of the credential-less loopback principal; there is exactly one. */
const ANONYMOUS_OWNER = 'anonymous-loopback:local';

/** New resources use the verified authentication realm as part of their owner (D-068). */
export function expansionOwner(principal: Principal): string {
	return principal.kind === 'anonymous-loopback' ? ANONYMOUS_OWNER : `${principal.kind}:${principal.id}`;
}

/** The principal id an administrator login carries; GW-4 refuses API-key ids that could spell one. */
function adminIdOf(admin: { readonly username: string }): string {
	return `admin:${admin.username}`;
}

/** The `holder_name` an administrator login shows every viewer (B2.3): one spelling, for every mint (review B4). */
function adminLabelOf(username: string): string {
	return `Administrator (${username})`;
}

/**
 * D-146: the credential kind of an account's own API key — `user-key:<sha256>`. Distinct from `api-key:` (a key in
 * `TTK_API_KEYS`), because the two are answered by different stores and a config reload must not judge an account's
 * key, nor an account change a config key.
 */
const USER_KEY = 'user-key:';

/** D-146: the length of an account key's display prefix — `ttk_` and four characters, what `keyPrefix` logs. */
const ACCOUNT_KEY_PREFIX_LENGTH = 8;

/** D-146: the id alphabet of an account key: lowercase base32, path-safe and unambiguous to read aloud. */
const KEY_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * D-146: mints a key for an account. Returns the raw key — shown to the person once, in the response that minted it,
 * and never logged or stored — and what the account store keeps: an id (`k_` and ten base32 characters, 50 bits, unique
 * enough within one account's 25 keys and checked anyway), the display prefix and the SHA-256.
 */
export async function generateAccountKey(): Promise<{ secret: string; id: string; prefix: string; sha256: string }> {
	const { key, record } = await generateApiKey('account-key');
	// 256 is a multiple of 32, so masking a random byte to five bits picks each character uniformly.
	const id = `k_${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => KEY_ID_ALPHABET[b & 31]).join('')}`;
	return { secret: key, id, prefix: key.slice(0, ACCOUNT_KEY_PREFIX_LENGTH), sha256: record.sha256 };
}

/** D-068: the only scopes a same-owner ACP delegation can carry. */
const DELEGABLE_SCOPES = ['mcp:invoke', 'sandbox:execute', 'evaluate', 'a2ui:publish'] as const;

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
 * Verifies API keys against SHA-256 hashes.
 *
 * Every record is compared even after a match: short-circuiting would make the
 * response time depend on a key's position in the store, which leaks how far
 * down the list a guess landed.
 *
 * ## The record set is replaceable, and that is what makes revocation reachable
 *
 * SR2-M3: this field used to be `readonly`, built once at startup, with nothing
 * in the tree able to change it. `hasId` therefore answered "still present" for
 * every principal that had ever authenticated, so the 300 s re-check on a live
 * SSE stream (`EVENT_STREAM_REVALIDATE_MS`) was a **no-op for API keys** and
 * revoking one meant a restart — which terminates every stream anyway, making
 * the promise in `SPECS/SECURITY-AUTH.md` §2.1 true only trivially.
 * {@linkcode ApiKeyStore.replace} is the one mutation, driven by
 * {@linkcode ../keyreload.ts | ApiKeyFileWatcher} from the key file the operator
 * already configured. The raw key still never exists server-side: a record
 * carries the SHA-256 and nothing else that could reconstruct one.
 */
export class ApiKeyStore {
	#records: readonly ApiKeyRecord[];

	constructor(records: readonly ApiKeyRecord[]) {
		this.#records = records;
	}

	get size(): number {
		return this.#records.length;
	}

	/**
	 * The records in force right now.
	 *
	 * One source of truth for anything derived from a credential — the
	 * `holder_name` a live-view ticket publishes, above all. Reading
	 * `config.apiKeys` instead would be a second copy that stopped agreeing with
	 * this one the first time a file reloaded.
	 */
	get records(): readonly ApiKeyRecord[] {
		return this.#records;
	}

	/**
	 * Replaces every record.
	 *
	 * **Refuses an empty set, and that refusal is a control rather than a
	 * convenience.** `VerifierChain.credentialed` is false when no credential is
	 * configured, and on a loopback bind that turns every credential-less request
	 * into an anonymous principal holding `TTK_ANON_SCOPES`. So a reload that
	 * emptied the store would *grant* access in the name of revoking it. Removing
	 * the last credential is a restart, and the caller warns rather than pretending
	 * it happened.
	 *
	 * @returns `true` when the records were replaced.
	 */
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
		// SEC-01: a record that names no scopes gets DEFAULT_SCOPES, not the
		// whole vocabulary. An EXPLICIT_SCOPES member is only ever held by a
		// record that named it.
		return {
			kind: 'api-key',
			id: matched.id,
			scopes: new Set(matched.scopes ?? DEFAULT_SCOPES),
			label: matched.label ?? null,
			// GW-1: the record's hash pins this exact key. Rotation keeps the id and changes the hash, so work
			// submitted under the old key is told apart from the replacement's.
			credential: `api-key:${matched.sha256}`,
		};
	}
}

/** Verifies OAuth 2.1 access tokens issued by an external authorization server. */
export class OAuthVerifier {
	readonly #config: OAuthConfig;
	/** D-083: the provider's own metadata, which also answers `/.well-known/oauth-authorization-server`. */
	readonly metadata: IssuerMetadata;
	#jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
	#resolving: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;
	readonly #logger: { warn(message: string, fields?: Record<string, unknown>): void } | undefined;

	constructor(
		config: OAuthConfig,
		options: { metadata?: IssuerMetadata; logger?: { warn(message: string, fields?: Record<string, unknown>): void } } =
			{},
	) {
		this.#config = config;
		this.metadata = options.metadata ?? new IssuerMetadata(config.issuer);
		this.#logger = options.logger;
		if (config.jwksUrl !== null) this.#jwks = createRemoteJWKSet(config.jwksUrl);
	}

	/**
	 * The key set, found once: `TTK_OAUTH_JWKS_URL` when set, else the provider metadata's `jwks_uri` (D-083). A
	 * provider that publishes no metadata falls back to the old guess, `<issuer>/.well-known/jwks.json`, with a
	 * warning, so a deployment that relied on it keeps working; a later call tries discovery again.
	 */
	#keys(): Promise<ReturnType<typeof createRemoteJWKSet>> {
		if (this.#jwks !== null) return Promise.resolve(this.#jwks);
		this.#resolving ??= (async () => {
			const discovered = await this.metadata.jwksUri();
			if (discovered !== null) {
				this.#jwks = createRemoteJWKSet(discovered);
				return this.#jwks;
			}
			const guess = new URL('.well-known/jwks.json', `${this.#config.issuer.href.replace(/\/?$/, '/')}`);
			this.#logger?.warn(
				'the identity provider published no usable metadata; trying the conventional JWKS location. ' +
					'Set TTK_OAUTH_JWKS_URL to name it explicitly.',
				{ jwks: guess.href, reason: this.metadata.lastError },
			);
			return createRemoteJWKSet(guess);
		})().finally(() => this.#resolving = null);
		return this.#resolving;
	}

	async verify(token: string): Promise<Principal | null> {
		let payload: Record<string, unknown>;
		try {
			const result = await jwtVerify(token, await this.#keys(), {
				issuer: this.#config.issuer.href,
				audience: this.#config.audience,
				algorithms: ['RS256', 'ES256'],
				clockTolerance: 30,
			});
			payload = result.payload as Record<string, unknown>;
		} catch {
			// A malformed or wrongly-signed token is simply not ours to accept;
			// the chain decides whether that is fatal.
			return null;
		}
		const subject = typeof payload.sub === 'string' ? payload.sub : null;
		if (subject === null) return null;

		const raw = typeof payload.scope === 'string'
			? payload.scope.split(/\s+/)
			: Array.isArray(payload.scp)
			? payload.scp.filter((entry): entry is string => typeof entry === 'string')
			: [];
		const scopes = new Set<Scope>();
		for (const entry of raw) {
			// SCOPES, deliberately, not DEFAULT_SCOPES: this filters what a token
			// *claimed* against the vocabulary. Narrowing it to the defaults would
			// silently strip an explicit grant an operator put in the token, which
			// fails closed but makes the explicit-grant mechanism inoperable on
			// this mount with no error anywhere.
			if ((SCOPES as readonly string[]).includes(entry)) scopes.add(entry as Scope);
			else if (entry === 'ttk:admin') scopes.add('admin');
		}
		// GW-1: an OAuth token cannot be re-verified without the token, which is not retained, so later work is
		// bound to its expiry. A token with no `exp` is held to this gateway's own decision horizon. BUG-3: floored to
		// whole milliseconds, because RFC 7519 allows a fractional NumericDate and the `oauth:<ms>` readers (the GW-1
		// consumers and `credentialNotAfterOf`'s strict `^oauth:(\d+)$`) take an integer.
		const expires = typeof payload.exp === 'number'
			? Math.floor(payload.exp * 1000)
			: Date.now() + API_KEY_HORIZON_S * 1000;
		return { kind: 'oauth', id: subject, scopes, credential: `oauth:${expires}` };
	}

	/** `exp` from the token, so `AuthInfo.expiresAt` reflects the real horizon. */
	static expiryOf(payload: Record<string, unknown>): number | undefined {
		return typeof payload.exp === 'number' ? payload.exp : undefined;
	}
}

export interface VerifierChainOptions {
	readonly config: Config;
	/** Set when the bind policy permits anonymous loopback use. */
	readonly allowAnonymous: boolean;
	readonly logger?: { warn(msg: string): void };
	/** The account store (D-074); defaults to an in-memory store seeded from `config.adminUser`. */
	readonly users?: UserStore;
	/** The sign-in session store (D-073); defaults to in-memory. */
	readonly logins?: LoginStore;
	/** How long a minted session lives; defaults to `config.loginTtlMs`. */
	readonly loginTtlMs?: number;
}

/**
 * The composite verifier handed to the SDK's bearer-auth gate.
 *
 * It must throw the SDK's {@linkcode OAuthError}: a plain `Error` escapes the
 * SDK's challenge mapping and turns an invalid token into a 500.
 */
export class VerifierChain implements OAuthTokenVerifier {
	/** GW-1: each delegation names the credential its task was submitted under, and stands only while it does. */
	#delegations = new Map<string, { owner: string; credential: string; scopes: readonly Scope[]; expires: number }>();
	/** Identity snapshot per owner (kind, id, label), refreshed by that owner's requests; confers no authority alone. */
	#authorities = new Map<string, { principal: Principal; expires: number }>();
	#listeners = new Set<() => void>();
	readonly #apiKeys: ApiKeyStore;
	readonly #oauth: OAuthVerifier | null;
	readonly #users: UserStore;
	readonly #logins: LoginStore;
	readonly #loginTtlMs: number;
	readonly #allowAnonymous: boolean;
	readonly #anonScopes: readonly Scope[];
	readonly #logger: VerifierChainOptions['logger'];

	constructor(options: VerifierChainOptions) {
		this.#apiKeys = new ApiKeyStore(options.config.apiKeys);
		this.#oauth = options.config.oauth === null
			? null
			: new OAuthVerifier(options.config.oauth, options.logger === undefined ? {} : { logger: options.logger });
		this.#users = options.users ??
			new UserStore({ dataDir: null, seed: options.config.adminUser ?? null, logger: options.logger });
		this.#logins = options.logins ?? new LoginStore({ dataDir: null, logger: options.logger });
		this.#loginTtlMs = options.loginTtlMs ?? options.config.loginTtlMs;
		this.#allowAnonymous = options.allowAnonymous;
		this.#anonScopes = options.config.anonScopes;
		this.#logger = options.logger;
	}

	/** True when at least one real credential is configured. */
	get credentialed(): boolean {
		return this.#apiKeys.size > 0 || this.#oauth !== null || this.#users.size > 0;
	}

	/** D-083: the identity provider's metadata, in OAuth mode; null otherwise. */
	get oauthMetadata(): IssuerMetadata | null {
		return this.#oauth?.metadata ?? null;
	}

	/** The account store behind password logins (D-074). */
	get users(): UserStore {
		return this.#users;
	}

	/** The sign-in session store (D-073). */
	get logins(): LoginStore {
		return this.#logins;
	}

	get loginTtlMs(): number {
		return this.#loginTtlMs;
	}

	async verifyAdmin(username: string, password: string): Promise<Principal | null> {
		const user = await this.#users.verify(username, password);
		if (user === null) return null;
		// GW-2 / D-065: an administrator is a principal like any other. A record that names no scopes gets
		// DEFAULT_SCOPES — `admin` included — and an EXPLICIT_SCOPES member only when the record names it. The
		// whole vocabulary here handed every administrator sandbox, agent, publication, evaluate and task grants.
		return {
			kind: 'api-key',
			id: adminIdOf(user),
			scopes: new Set(user.scopes),
			label: adminLabelOf(user.username),
			credential: `user:${user.username}`,
		};
	}

	/**
	 * Mints a sign-in session for `principal` (D-073).
	 *
	 * The session's **backing** is the credential it was minted from — `user:<username>` for a password login,
	 * `api-key:<record sha256>` for an API key — and every later resolve re-derives authority from that backing,
	 * so a deleted account or a rotated key ends the session on its next request. The raw token is returned once
	 * and only its hash is kept.
	 */
	async mintSession(principal: Principal, ttlMs = this.#loginTtlMs): Promise<{ token: string; expires: number }> {
		const backing = principal.credential ?? `user:${principal.id.replace(/^admin:/, '')}`;
		return await this.#logins.mint(principal, backing, ttlMs);
	}

	/** GW-1 / GW-4: the session, not the id, is the credential — logging out ends what it started. */
	async closeSession(token: string): Promise<boolean> {
		const closed = this.#logins.close(await sha256Hex(token));
		if (closed) this.#notify();
		return closed;
	}

	/**
	 * Ends every sign-in backed by `backing` except the one whose token hash is `keep` (a password change keeps
	 * the session that made it). Returns how many closed; tasks and streams under them fail closed at once.
	 */
	closeLoginsOf(backing: string, keep?: string): number {
		const closed = this.#logins.closeWhere((entry) => entry.backing === backing && entry.hash !== keep);
		if (closed > 0) this.#notify();
		return closed;
	}

	/**
	 * D-146: ends, now, everything that stood on `backing` — the sign-ins it backs (`POST /api/v1/auth/login` with the
	 * key mints one backed by `user-key:<sha256>`) and the ACP delegations bound to it — and tells the listeners, so the
	 * tasks and streams under it fail at once (GW-1/GW-3) rather than at their next re-check. The route calls it after the
	 * key left the store, when resolution already refuses the key; this is what makes the refusal immediate for work
	 * already running. Returns how many sign-ins closed.
	 */
	revokeCredential(backing: string): number {
		return this.#revoke((credential) => credential === backing);
	}

	/**
	 * D-146: {@linkcode revokeCredential} for every account key no longer in force — after an account is disabled or
	 * deleted its keys stop resolving, and this ends what they backed without the caller having to know their hashes.
	 */
	revokeLapsedAccountKeys(): number {
		return this.#revoke((credential) => credential.startsWith(USER_KEY) && this.#backingScopes(credential) === null);
	}

	/** The one revocation sweep: sign-ins whose backing, and delegations whose credential, `lapsed` names. */
	#revoke(lapsed: (credential: string) => boolean): number {
		const closed = this.#logins.closeWhere((entry) => lapsed(entry.backing));
		// D-068 / GW-1, as `replaceApiKeys`: a delegation bound to the credential — or to a sign-in just closed — goes now,
		// so nothing can revive it.
		for (const [key, delegation] of this.#delegations) {
			if (lapsed(delegation.credential) || this.#current(delegation.owner, delegation.credential) === null) {
				this.#delegations.delete(key);
			}
		}
		this.#notify();
		return closed;
	}

	/** The scopes the credential behind a sign-in holds right now, or `null` once it is gone (GW-1/GW-4). */
	#backingScopes(backing: string): ReadonlySet<Scope> | null {
		if (backing.startsWith('user:')) return this.#users.scopesOf(backing.slice('user:'.length));
		// D-146: a sign-in opened by exchanging an account key holds what the key may use now — its scopes narrowed to
		// its account's — and ends with the key, a disabled account or a deleted one.
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
	 * GW-1 / GW-3: runs `listener` whenever a credential stops being what it was — the key file reloaded or a
	 * session ended — so the gateway can fail that credential's tasks and close its streams now rather than at
	 * their next re-check. Returns the unsubscribe.
	 */
	onCredentialsChanged(listener: () => void): () => void {
		this.#listeners.add(listener);
		return (): void => {
			this.#listeners.delete(listener);
		};
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

	/**
	 * GW-1 / GW-3 / GW-4: the scopes the exact credential behind `owner` holds right now, or `null` once it is gone.
	 *
	 * The single answer to "is this still authorized" for anything that outlives a request. An API key matches by
	 * its record hash, so a rotated key's replacement does not vouch for work done under the old one; an account's
	 * own key (D-146) by its hash in the account store, and only for its account's owner; a session
	 * matches only while it is open and the administrator record behind it still exists — never by an `admin:`
	 * id prefix; an OAuth credential answers until its token's expiry with the whole vocabulary as its ceiling,
	 * because its claimed scopes were already applied when the work was created. No credential means nothing to
	 * re-check, which fails closed for everything but the one anonymous loopback principal.
	 */
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
			// D-146: the key must still be held by an enabled account, and the work must be that account's own — the
			// same owner its password sign-in has, because the key acts as the account.
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
		if (kind === 'oauth') return owner.startsWith('oauth:') && Date.now() < Number(value) ? new Set(SCOPES) : null;
		return null;
	}

	/**
	 * GW-1: the scopes a queued or running agent task may use now — what it was submitted with, narrowed to what
	 * its own credential still holds — or `null` once that credential is revoked, rotated, expired or logged out.
	 * Injected into the agent runtime, which never imports gateway code.
	 */
	authorizeTask(
		owner: string,
		scopes: ReadonlySet<string>,
		credential: string | undefined,
	): ReadonlySet<string> | null {
		const current = this.#current(owner, credential);
		return current === null ? null : new Set([...scopes].filter((scope) => current.has(scope as Scope)));
	}

	/**
	 * GW-3: the scopes `principal` holds right now, for a long-lived stream that must re-earn its authorization.
	 *
	 * `null` when the credential is gone, and for every **OAuth** principal: not because its token is known to be
	 * bad but because it cannot be re-verified without the token, which is deliberately not retained. The stream's
	 * contract is to end so the client reconnects and presents the token again — the next request §2.1 means.
	 */
	currentScopes(principal: Principal): ReadonlySet<Scope> | null {
		if (principal.kind === 'oauth') return null;
		const current = this.#current(expansionOwner(principal), principal.credential);
		return current === null ? null : new Set([...principal.scopes].filter((scope) => current.has(scope)));
	}

	/**
	 * R10 (design §2.7, D-119): the scopes the principal behind a realm-qualified `owner` holds **now**, or `null` once
	 * it is gone — the re-check a signed link makes before it serves a byte, with no credential in hand.
	 *
	 * - `api-key:<id>` — the API-key record with that id, from the live (reloadable) set; a removed key ends every
	 *   link it minted. An `api-key:admin:<username>` owner is an administrator account (GW-4 refuses key ids that
	 *   could spell one) and is answered from the account store, so a disabled or deleted account ends its links.
	 * - `oauth:<subject>` — `{mcp:invoke}` only, and only while OAuth is configured: a bearer token is not retained,
	 *   so its scopes cannot be re-read; the link's own expiry, capped at the minting token's (D-140, F1), bounds what
	 *   that grants.
	 * - the anonymous loopback owner — the anonymous scopes, only while anonymous access is still allowed.
	 *
	 * By id. That a key rotated under the same id, or a changed password, ends a link is the credential epoch's job
	 * ({@linkcode ownerCredentialDigest}, D-140), checked by the route right after this.
	 *
	 * D-148: with `key` — the public id of the account API key a link was minted under (its `k` claim) — the answer is
	 * that key's, as the bearer gate would answer it now: its scopes narrowed to its account's, or `null` once the key is
	 * gone or its account is disabled or deleted. Only an account owner (`api-key:admin:<username>`) holds keys.
	 */
	ownerScopes(owner: string, key?: string): ReadonlySet<Scope> | null {
		if (key !== undefined) return this.#ownerKey(owner, key)?.scopes ?? null;
		if (owner === ANONYMOUS_OWNER) return this.#allowAnonymous && !this.credentialed ? new Set(this.#anonScopes) : null;
		if (owner.startsWith('oauth:')) {
			return this.#oauth !== null && owner.length > 'oauth:'.length ? new Set<Scope>(['mcp:invoke']) : null;
		}
		if (owner.startsWith('api-key:')) {
			const id = owner.slice('api-key:'.length);
			if (id.startsWith('admin:')) return this.#users.scopesOf(id.slice('admin:'.length));
			const record = this.#apiKeys.records.find((entry) => entry.id === id);
			return record === undefined ? null : new Set(record.scopes ?? DEFAULT_SCOPES);
		}
		return null;
	}

	/**
	 * D-140 (containment-otel-links design §2.7): what the credential behind a realm-qualified `owner` **is** right now,
	 * as the input to a signed link's keyed credential epoch — or `null` once it is gone. A link minted under one value
	 * stops verifying when the value changes, which is how a key rotated under the same id and a changed password end
	 * the links minted before.
	 *
	 * | Owner | Digest | `null` when |
	 * | --- | --- | --- |
	 * | `api-key:<id>` | the live record's stored `sha256` | the record is gone |
	 * | `api-key:admin:<user>` | {@linkcode UserStore.credentialDigest} (`salt.hash.iterations`) | gone or disabled |
	 * | `api-key:admin:<user>` with `key` (D-148) | the account's digest, `\0user-key:`, the key's `sha256` | either gone |
	 * | `oauth:<subject>` | the constant `oauth` (no rotation notion; the link is capped at the token's expiry) | OAuth is not configured |
	 * | the anonymous loopback owner | the constant `anonymous` | anonymous access is not allowed |
	 *
	 * The answer is the record's own stored hash material, never a credential; still, it is used only inside the
	 * signer and the link route, and is never logged, rendered or returned — the signer folds it into an HMAC under the
	 * link key, so the token carries no unkeyed fingerprint (D-119).
	 *
	 * D-148: with `key` (a link's `k` claim, the public id of the account API key it was minted under), the digest is the
	 * account's password material **and** that key's stored SHA-256, `salt.hash.iterations ‖ "\0user-key:" ‖ sha256`, or
	 * `null` once either is gone — so such a link ends with its key (revoked, or dropped by any write that removes it), and
	 * still with the account's password change, disablement or deletion. The NUL keeps it from ever equalling an
	 * account-level digest, which has none.
	 */
	ownerCredentialDigest(owner: string, key?: string): string | null {
		if (key !== undefined) {
			const hit = this.#ownerKey(owner, key);
			const account = hit === null ? null : this.#users.credentialDigest(hit.username);
			return hit === null || account === null ? null : `${account}\0${USER_KEY}${hit.key.sha256}`;
		}
		if (owner === ANONYMOUS_OWNER) return this.#allowAnonymous && !this.credentialed ? 'anonymous' : null;
		if (owner.startsWith('oauth:')) return this.#oauth !== null && owner.length > 'oauth:'.length ? 'oauth' : null;
		if (owner.startsWith('api-key:')) {
			const id = owner.slice('api-key:'.length);
			// The same lookups `ownerScopes` makes, so the two can never answer about different records.
			if (id.startsWith('admin:')) return this.#users.credentialDigest(id.slice('admin:'.length));
			return this.#apiKeys.records.find((entry) => entry.id === id)?.sha256 ?? null;
		}
		return null;
	}

	/**
	 * D-148: what a signed link `owner` mints under `credential` (the call's GW-1 fingerprint) is bound to — the input to
	 * its keyed epoch and, for an account API key, that key's public id (the token's `k` claim) — or `null` when the
	 * credential is not in force, which the minter refuses as `scope-required`.
	 *
	 * An account key — `user-key:<sha256>` presented as a bearer, or a sign-in opened with one (backing `user-key:`) —
	 * binds the link to **that key**: {@linkcode ownerCredentialDigest} with its id, so revoking it ends the link and the
	 * account's other keys and its password sign-ins do not. The key must still be held by an enabled account and the
	 * owner must be that account's, as GW-1 judges it (`#current`). A sign-in that has closed since the request was
	 * authenticated is not in force either: refused rather than read as the account. Every other credential binds as
	 * D-140 binds it, by owner, and so does an absent one (a context built with no `authInfo` — `browser_file_link` is
	 * not taskable, so no such path reaches a minter today).
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

	/** D-148: the account key `key` held by the account behind an `api-key:admin:<username>` owner, or `null`. */
	#ownerKey(owner: string, key: string): AccountKeyHit | null {
		const prefix = 'api-key:admin:';
		return owner.startsWith(prefix) ? this.#users.findKeyById(owner.slice(prefix.length), key) : null;
	}

	/** The API-key records in force right now — the reloadable set, not the startup copy. */
	get apiKeyRecords(): readonly ApiKeyRecord[] {
		return this.#apiKeys.records;
	}

	/**
	 * Swaps the API-key record set (SR2-M3).
	 *
	 * The one write path, and it is deliberately narrow: an empty set is refused
	 * by the store, so no reload can leave this process with no credentials and
	 * quietly fall back to the anonymous principal. Returns whether the swap took.
	 */
	replaceApiKeys(records: readonly ApiKeyRecord[]): boolean {
		if (!this.#apiKeys.replace(records)) return false;
		// D-068 / GW-1: a delegation whose API-key credential is no longer in force — removed or rotated — is
		// dropped now, so restoring the old record later cannot revive it. Narrowing keeps it; its scopes narrow at
		// every use instead.
		for (const [key, delegation] of this.#delegations) {
			if (
				delegation.credential.startsWith('api-key:') && this.#current(delegation.owner, delegation.credential) === null
			) {
				this.#delegations.delete(key);
			}
		}
		// D-073: a sign-in minted from a key that is no longer in force ends with it.
		this.#logins.closeWhere((entry) =>
			entry.backing.startsWith('api-key:') && this.#backingScopes(entry.backing) === null
		);
		// GW-1 / GW-3: that key's queued and running tasks fail and its streams close now, not at the next re-check.
		this.#notify();
		return true;
	}

	/**
	 * D-068: short-lived, same-owner MCP authority; never an external agent's static API key.
	 *
	 * GW-1: bound to `credential`, the fingerprint of the credential the task was submitted under. Looking the
	 * authority up by owner alone meant that after a rotation the replacement key's next request refreshed the
	 * owner's authority, and a task submitted under the old key was handed a fresh delegation backed by the new
	 * one. Now the task's own credential must still be in force, and the delegation is re-checked against it on
	 * every use.
	 */
	async delegateMcp(
		owner: string,
		requested: ReadonlySet<string>,
		credential: string | undefined,
	): Promise<{ token: string; close(): void } | null> {
		const now = Date.now();
		for (const [key, value] of this.#delegations) if (value.expires <= now) this.#delegations.delete(key);
		for (const [key, value] of this.#authorities) if (value.expires <= now) this.#authorities.delete(key);
		const authority = this.#authorities.get(owner);
		if (!authority || credential === undefined || this.#delegations.size >= 256) return null;
		const current = this.#current(owner, credential);
		if (current === null) return null;
		const scopes = DELEGABLE_SCOPES.filter((scope) =>
			requested.has(scope) && current.has(scope) && authority.principal.scopes.has(scope)
		);
		if (!scopes.includes('mcp:invoke')) return null;
		const token = `ttkd_${crypto.randomUUID()}${crypto.randomUUID()}`;
		const key = await sha256Hex(token);
		if (this.#delegations.size >= 256) return null;
		this.#delegations.set(key, { owner, credential, scopes, expires: Math.min(authority.expires, now + 120_000) });
		return {
			token,
			close: (): void => {
				this.#delegations.delete(key);
			},
		};
	}

	/** True only for verified delegation tokens; gateway restricts their route to /mcp. */
	isDelegation(token: string): boolean {
		return token.startsWith('ttkd_');
	}

	/** Clears ephemeral authority when the gateway shuts down. */
	closeDelegations(): void {
		this.#delegations.clear();
		this.#authorities.clear();
	}

	/**
	 * Re-checks a principal's authority **without its credential**.
	 *
	 * A long-lived stream has no next request, so it cannot rely on §2.1's "takes
	 * effect next request"; it has to re-earn its decision on a timer. This is
	 * that check, and it deliberately takes the principal rather than the token:
	 * retaining a bearer token for the life of a 30-minute stream would trade one
	 * problem for a worse one.
	 *
	 * An **OAuth** principal answers `false`, not because its token is known to be
	 * bad but because it cannot be re-verified from here — its expiry lives in the
	 * token. The caller's contract is to end the stream so the client reconnects
	 * and presents the token again, which is exactly the next request §2.1 means.
	 *
	 * An **API-key** principal is answered from the live record set. Since SR2-M3
	 * that set is reloadable from the key file, so this can now answer `false` —
	 * before the fix it could only ever answer "still present", which made the
	 * re-check a no-op for exactly the credential kind most deployments use. Since
	 * GW-1 it is answered by the record's **hash**, not its id, so a rotated key's
	 * streams end too.
	 *
	 * An **administrator** principal (GW-4) is answered from the admin record and its
	 * open session. It used to answer `true` forever for any id beginning `admin:`,
	 * and API-key ids were unconstrained, so a key named `admin:x` was never revoked.
	 */
	stillAuthorized(principal: Principal): boolean {
		return this.currentScopes(principal) !== null;
	}

	async resolve(token: string): Promise<Principal | null> {
		if (token.startsWith(LOGIN_TOKEN_PREFIX)) {
			// D-084: read through to the cluster's KV, so a sign-in minted on another node a moment ago resolves here.
			const entry = await this.#logins.lookup(await sha256Hex(token));
			if (entry === null) return null;
			const scopes = this.#backingScopes(entry.backing);
			if (scopes === null) {
				// The account or key behind this sign-in is gone: the session ends here, not at an explicit close.
				this.#logins.close(entry.hash);
				return null;
			}
			return this.#sessionPrincipal(entry, scopes);
		}
		if (this.isDelegation(token)) {
			const delegation = this.#delegations.get(await sha256Hex(token));
			if (!delegation || delegation.expires <= Date.now()) return null;
			const authority = this.#authorities.get(delegation.owner);
			if (!authority || authority.expires <= Date.now()) return null;
			// GW-1: re-checked against the credential the delegation was issued for, with that credential's
			// current scopes — never the scopes of whichever credential authenticated as this owner last.
			const current = this.#current(delegation.owner, delegation.credential);
			if (current === null) return null;
			return {
				...authority.principal,
				credential: delegation.credential,
				scopes: new Set(
					delegation.scopes.filter((scope) => current.has(scope) && authority.principal.scopes.has(scope)),
				),
			};
		}
		if (token.startsWith(API_KEY_PREFIX)) {
			const principal = (await this.#apiKeys.verify(token)) ?? (await this.#accountKey(token));
			if (principal !== null) return principal;
		} else if (this.#oauth !== null) {
			const principal = await this.#oauth.verify(token);
			if (principal !== null) return principal;
		} else {
			// A non-prefixed token with no OAuth mode may still be an API key
			// whose prefix the operator stripped; try the store rather than
			// rejecting on shape alone.
			const principal = (await this.#apiKeys.verify(token)) ?? (await this.#accountKey(token));
			if (principal !== null) return principal;
		}
		return null;
	}

	/**
	 * D-146: the principal an account's own API key stands for, or `null` when no enabled account holds it. Consulted
	 * after `TTK_API_KEYS` misses, so a configured key is never shadowed.
	 *
	 * The id is the **account's** — `admin:<username>`, exactly what its password sign-in carries — on purpose: the key
	 * acts as the account, so it owns the same sessions, tasks and workspaces (`api-key:admin:<username>`).
	 * GW-4 refuses configured key ids that spell `admin:` because one would impersonate an account; this is not a
	 * configured key, it is the account. What tells the key apart is its credential, `user-key:<sha256>`, which every
	 * GW-1 re-check judges by the key itself, and its scopes, which are the key's narrowed to the account's current ones.
	 * A signed link minted under it is bound to the key too ({@linkcode linkBinding}, D-148), not only to the account.
	 */
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
		if (!this.isDelegation(token)) {
			const now = Date.now();
			for (const [owner, value] of this.#authorities) if (value.expires <= now) this.#authorities.delete(owner);
			// The bounded cache retains verified identity/scopes, never its source credential.
			if (this.#authorities.size < 512 || this.#authorities.has(expansionOwner(principal))) {
				let expires = now + 120_000;
				if (principal.kind === 'oauth') {
					try {
						const payload = decodeJwt(token);
						if (typeof payload.exp === 'number') expires = Math.min(expires, payload.exp * 1000);
					} catch {
						expires = now;
					}
				}
				this.#authorities.set(expansionOwner(principal), { principal, expires });
			}
		}
		const delegation = this.isDelegation(token) ? this.#delegations.get(await sha256Hex(token)) : undefined;
		return {
			...toAuthInfo(principal, token),
			...(delegation === undefined ? {} : { expiresAt: Math.floor(delegation.expires / 1000) }),
			extra: {
				principalKind: principal.kind,
				// GW-5: the realm-qualified owner, minted here by `expansionOwner` — the function every REST and A2A
				// route uses — so the MCP mount reads it instead of deriving a second spelling of its own.
				owner: expansionOwner(principal),
				// GW-1: carried to the routes so tasks and streams can be re-bound to this exact credential.
				...(principal.credential === undefined ? {} : { credential: principal.credential }),
				...(this.isDelegation(token) ? { delegatedMcp: true } : {}),
			},
		};
	}

	/**
	 * The principal used when no credential is configured and the bind is
	 * loopback.
	 *
	 * SEC-01: `TTK_ANON_SCOPES`, defaulting to `DEFAULT_SCOPES`. There is no
	 * credential here to carry a grant, and having none is not consent to
	 * every scope this build will ever declare.
	 */
	anonymousPrincipal(remoteAddr: string): Principal | null {
		if (!this.#allowAnonymous || this.credentialed) return null;
		return { kind: 'anonymous-loopback', id: `anonymous:${remoteAddr}`, scopes: new Set(this.#anonScopes) };
	}
}

/**
 * Builds the SDK's `AuthInfo`.
 *
 * `expiresAt` is always set: the SDK rejects an `AuthInfo` without one, so an
 * omitted expiry would turn every valid credential into a 401.
 */
export function toAuthInfo(principal: Principal, token: string): AuthInfo {
	return {
		token,
		clientId: principal.id,
		scopes: [...principal.scopes],
		expiresAt: Math.floor(Date.now() / 1000) + API_KEY_HORIZON_S,
	};
}

/**
 * Recovers a principal from an `AuthInfo` produced by this module.
 *
 * The label does **not** survive this round trip: `AuthInfo` is the SDK's shape and carries only the
 * client id and the scopes, so a principal recovered here has none. That is why
 * {@linkcode holderNameOf} reads the label from the configured records — the one place it is
 * declared — rather than from whichever principal object happens to be at hand.
 */
export function principalFromAuthInfo(authInfo: AuthInfo): Principal {
	const credential = authInfo.extra?.credential;
	return {
		...(typeof credential === 'string' ? { credential } : {}),
		kind: authInfo.extra?.principalKind === 'oauth'
			? 'oauth'
			: authInfo.extra?.principalKind === 'api-key'
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

/**
 * The `holder_name` for a principal (B2.3): its credential's label, or `null`.
 *
 * One reader, one source. The records are where a label is declared and where SEC-15 validated it at
 * parse; a principal that came back through the SDK's `AuthInfo` has lost the field, so reading it
 * from the principal alone would report `null` for a labelled credential on exactly the path the
 * live view uses. The principal's own `label` is preferred when present (the direct-verify path),
 * and the records answer otherwise.
 */
export function holderNameOf(principal: Principal, records: readonly ApiKeyRecord[]): string | null {
	if (principal.label !== undefined && principal.label !== null) return principal.label;
	if (principal.kind !== 'api-key') return null;
	// Review B4: an administrator login is an `api-key` principal `admin:<username>` whose label is declared by no key
	// record, and lost — like every label — on the trip through `AuthInfo`. GW-4 keeps the prefix off every key id, so
	// the id alone says which it is, and the label is derived the one way `verifyAdmin` derives it.
	if (principal.id.startsWith('admin:')) return adminLabelOf(principal.id.slice('admin:'.length));
	return records.find((record) => record.id === principal.id)?.label ?? null;
}
