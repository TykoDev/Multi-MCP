/**
 * Signed links to session files (R10, design §2.7, D-119; v2 by containment-otel-links design §2.7, D-140): a URL that
 * downloads one file with no bearer credential, for as long as it says and no longer — and not a moment after the
 * session it was minted in closes, or the credential it was minted under stops being the same credential.
 *
 * A token is `v2.<body>.<mac>`: `body` is the base64url JSON of the claims `{s, i, f, o, k?, e, exp, n}` — session,
 * the session's incarnation, file, the realm-qualified owner the link was minted for, the account API key it was
 * minted under when it was one (D-148, below), the owner's **credential epoch**,
 * the expiry in Unix seconds, and eight random bytes so two links minted in one second differ — and `mac` is the
 * base64url HMAC-SHA256 of `"ttk-link-v2\0" ‖ body` under the deployment's link-signing key. The body is **signed,
 * not encrypted**: it carries identifiers and one keyed value, never a credential and never an *unkeyed* fingerprint
 * of one (D-119), so reading it gains a holder nothing the URL did not already grant.
 *
 * The epoch `e` is `b64url(HMAC-SHA256(key, "ttk-link-epoch\0" ‖ o ‖ "\0" ‖ digest)[0..16])`, where `digest` is what
 * `VerifierChain.ownerCredentialDigest` answers for the owner — an API-key record's stored hash, an account's
 * `salt.hash.iterations`, or a constant for OAuth and the anonymous principal. It is keyed, so it is no fingerprint a
 * holder can test a guess against; and it moves whenever the credential does — a key rotated under the same id, a
 * changed password — so a link minted under the old credential stops verifying at the route. Every node shares the
 * key (`TTK_SIGNED_LINK_KEY_FILE` is required in a cluster) and reads the same records, so all compute the same epoch.
 *
 * D-148: a link minted under an **account API key** carries one more claim, `k` — the key's public id, the one the
 * Users screen lists, which is not a credential — and its digest is the account's together with that key's stored
 * hash, so revoking the key ends the link at its next follow while the account's other keys and its password
 * sign-ins keep theirs. A token without `k` (a password sign-in's, any other owner's, and every link minted before
 * D-148) is bound to the owner exactly as before.
 *
 * What makes the link safe to hand out is checked at the route, in this order: the MAC (constant time, through
 * `crypto.subtle.verify`), the expiry (in the future and never more than {@linkcode LINK_TTL_MAX_S} plus
 * {@linkcode LINK_CLOCK_SKEW_S} away, so a key that signed a long-lived token by mistake still cannot honour it), then
 * — outside this module — that the owner still holds `mcp:invoke`, that its epoch still matches
 * ({@linkcode LinkSigner.epochMatches}, constant time), and that the session's incarnation is the one the link names.
 * The key never leaves this module's closure; the signer has no method that returns it. `v1` tokens no longer verify
 * (they lived at most 300 s, so an upgrade ends at most five minutes of links).
 */
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { timingSafeEqual } from '@std/crypto/timing-safe-equal';
import { type SignedLinkMinter, ToolError } from '@tykotech/mcp';

/** The route a link points at. One exact path, added to the public set deliberately (D-052 precedent). */
export const LINK_PATH = '/api/v1/links/file';

/** The query parameter carrying the token. */
export const LINK_TOKEN_PARAM = 't';

/**
 * A link's life when the caller names none and the operator set no `TTK_SIGNED_LINK_TTL_S`. G5 (containment-otel-links
 * design §2.7, D-140): an hour, equal to the ceiling — widened from 60 s, and offset by G6's revocation (session
 * incarnation, credential epoch, OAuth expiry cap).
 */
export const LINK_TTL_DEFAULT_S = 3600;

/** The shortest and the longest life a link may have (design §2.1, G10; the ceiling raised from 300 s by G5). */
export const LINK_TTL_MIN_S = 10;
export const LINK_TTL_MAX_S = 3600;

/**
 * Review R1-4: how far ahead of the verifying node's clock the minting node's may run. A link is verified by the
 * node it reaches and again by the node holding the session, so a full-life link minted on a node one second ahead
 * was a bare 401 on the other — as it was after a backward clock step. Verify accepts an expiry up to
 * {@linkcode LINK_TTL_MAX_S} plus this; minting never issues more than {@linkcode LINK_TTL_MAX_S}.
 */
export const LINK_CLOCK_SKEW_S = 30;

/** The domain separator the MAC covers, so a link token can never verify as any other HMAC this key signs. */
const MAC_CONTEXT = 'ttk-link-v2\0';

/** The epoch's own domain separator: an epoch is never a valid MAC of anything, nor a MAC an epoch. */
const EPOCH_CONTEXT = 'ttk-link-epoch\0';

/** A token longer than this is not one this server minted (identifiers are bounded at the tool). */
const MAX_TOKEN_CHARS = 2048;

const TOKEN_SHAPE = /^v2\.([A-Za-z0-9_-]{1,1800})\.([A-Za-z0-9_-]{43})$/;

/** An epoch: 16 bytes, base64url without padding. */
const EPOCH_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/**
 * D-148: an account key's public id — the account store's own rule for one (`KEY_ID_PATTERN`, `users.ts`; minted as
 * `k_` and ten base32 characters), restated here so the codec stays free of the store.
 */
const KEY_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** What a verified token names. */
export interface LinkClaims {
	/** Session id. */
	readonly s: string;
	/** The session's incarnation (`SessionRecord.incarnation`) when the link was minted. */
	readonly i: string;
	/** File id. */
	readonly f: string;
	/** The realm-qualified owner the link was minted for (`expansionOwner`). */
	readonly o: string;
	/**
	 * D-148: the public id of the account API key the link was minted under, when it was one; absent for every other
	 * credential and on every link minted before D-148. The route reads the owner's credential through it.
	 */
	readonly k?: string;
	/** The owner's credential epoch: keyed, 22 base64url characters. */
	readonly e: string;
	/** Expiry, Unix seconds. */
	readonly exp: number;
	/** Eight random bytes, base64url. */
	readonly n: string;
}

/** What the signer is asked to mint. Only the minter wrapper ({@linkcode createLinkMinter}) builds one. */
export interface LinkRequest {
	readonly sessionId: string;
	readonly fileId: string;
	readonly owner: string;
	/** The session record's incarnation; the route 404s a record whose incarnation differs. */
	readonly incarnation: string;
	/**
	 * `VerifierChain.ownerCredentialDigest(owner[, key])`. Used only to derive the keyed epoch, never stored, logged or
	 * returned.
	 */
	readonly digest: string;
	/** D-148: the account API key's public id, when the link is bound to one; becomes the `k` claim. */
	readonly key?: string;
	readonly ttlSeconds?: number;
	/**
	 * Unix seconds: the minting credential's own expiry (F1). The link's expiry is `min(now + ttl, notAfter)`, and
	 * fewer than {@linkcode LINK_TTL_MIN_S} seconds left refuses the mint ({@linkcode LinkMintError}).
	 */
	readonly notAfter?: number;
}

/** A minted link. `expiresAt` is ISO 8601 UTC; both it and `ttlSeconds` are the values after the cap. */
export interface MintedLink {
	readonly url: string;
	readonly expiresAt: string;
	readonly ttlSeconds: number;
}

export interface LinkSignerOptions {
	/** The link-signing key: the key file's contents, or the generated data-directory key. At least 32 bytes. */
	readonly key: Uint8Array;
	/** The deployment's default life, `TTK_SIGNED_LINK_TTL_S`. */
	readonly ttlS: number;
	/** `TTK_PUBLIC_URL`: links are built from configuration, never from a request's `Host`. */
	readonly publicUrl: URL;
	/** Milliseconds since the epoch; injected so expiry is testable without waiting. */
	readonly now?: () => number;
}

/**
 * Why a mint was refused: the credential's own expiry leaves less than {@linkcode LINK_TTL_MIN_S}
 * (`credential-expiring`), or the token would be one {@linkcode LinkSigner.verify} refuses (`too-long`: an identifier
 * past its bound, or a body past the token shape's 1800 characters — BUG-2).
 */
export class LinkMintError extends Error {
	readonly reason: 'credential-expiring' | 'too-long';
	constructor(reason: 'credential-expiring' | 'too-long', message: string) {
		super(message);
		this.name = 'LinkMintError';
		this.reason = reason;
	}
}

export interface LinkSigner {
	/** Mints a link; the cap at `notAfter` is applied here, so no caller of the signer can bypass it. */
	mint(input: LinkRequest): Promise<MintedLink>;
	/** The claims of a token this key minted that has not expired, or `null` — never a reason. */
	verify(token: string): Promise<LinkClaims | null>;
	/** Whether `claims.e` is the epoch of `claims.o` under `digest` — constant time; the digest is never kept. */
	epochMatches(claims: LinkClaims, digest: string): Promise<boolean>;
}

const encoder = new TextEncoder();

/** A requested life clamped to [{@linkcode LINK_TTL_MIN_S}, {@linkcode LINK_TTL_MAX_S}], whole seconds. */
export function clampLinkTtl(requested: number | undefined, fallback: number): number {
	const value = requested === undefined || !Number.isFinite(requested) ? fallback : Math.floor(requested);
	return Math.min(LINK_TTL_MAX_S, Math.max(LINK_TTL_MIN_S, value));
}

function isClaims(value: unknown): value is LinkClaims {
	if (value === null || typeof value !== 'object') return false;
	const claims = value as Record<string, unknown>;
	const text = (field: unknown, max: number): boolean =>
		typeof field === 'string' && field !== '' && field.length <= max;
	return text(claims.s, 256) && text(claims.i, 32) && text(claims.f, 128) && text(claims.o, 512) &&
		(claims.k === undefined || (typeof claims.k === 'string' && KEY_ID_SHAPE.test(claims.k))) &&
		typeof claims.e === 'string' && EPOCH_SHAPE.test(claims.e) && text(claims.n, 32) &&
		typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp);
}

/** Builds the signer for one key. The key is imported once and never exported again. */
export function createLinkSigner(options: LinkSignerOptions): LinkSigner {
	if (options.key.byteLength < 32) throw new Error('a link-signing key needs at least 32 bytes');
	const now = options.now ?? (() => Date.now());
	const imported = crypto.subtle.importKey(
		'raw',
		new Uint8Array(options.key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
	const signed = (body: string): Uint8Array<ArrayBuffer> => encoder.encode(`${MAC_CONTEXT}${body}`);
	const epochOf = async (owner: string, digest: string): Promise<string> => {
		const mac = await crypto.subtle.sign('HMAC', await imported, encoder.encode(`${EPOCH_CONTEXT}${owner}\0${digest}`));
		return encodeBase64Url(new Uint8Array(mac).slice(0, 16));
	};

	return {
		async mint(input: LinkRequest): Promise<MintedLink> {
			// The wrapper refuses these before the signer is reached; a direct caller that skips it is a bug, not a request.
			if (input.incarnation === '' || input.digest === '') throw new Error('a link needs an incarnation and a digest');
			const seconds = Math.floor(now() / 1000);
			let ttlSeconds = clampLinkTtl(input.ttlSeconds, options.ttlS);
			if (input.notAfter !== undefined) {
				// F1: never past the minting credential's own expiry. NaN is not "no expiry": it refuses like an expired one.
				const remaining = Number.isFinite(input.notAfter) ? Math.floor(input.notAfter) - seconds : -1;
				if (remaining < LINK_TTL_MIN_S) {
					throw new LinkMintError(
						'credential-expiring',
						`the minting credential expires within ${LINK_TTL_MIN_S} s`,
					);
				}
				ttlSeconds = Math.min(ttlSeconds, remaining);
			}
			const exp = seconds + ttlSeconds;
			const claims: LinkClaims = {
				s: input.sessionId,
				i: input.incarnation,
				f: input.fileId,
				o: input.owner,
				...(input.key === undefined ? {} : { k: input.key }),
				e: await epochOf(input.owner, input.digest),
				exp,
				n: encodeBase64Url(crypto.getRandomValues(new Uint8Array(8))),
			};
			// BUG-2: never mint what verify() refuses. An owner past 512 characters (a long OAuth subject) or a body past
			// the token shape's bound used to mint a link that answered 401 on every follow.
			if (!isClaims(claims)) throw new LinkMintError('too-long', 'an identifier is too long for a signed link');
			const body = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
			const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await imported, signed(body)));
			const token = `v2.${body}.${encodeBase64Url(mac)}`;
			if (token.length > MAX_TOKEN_CHARS || !TOKEN_SHAPE.test(token)) {
				throw new LinkMintError('too-long', 'the identifiers are too long for a signed link');
			}
			const url = new URL(LINK_PATH, options.publicUrl);
			url.searchParams.set(LINK_TOKEN_PARAM, token);
			return { url: url.href, expiresAt: new Date(exp * 1000).toISOString(), ttlSeconds };
		},

		async verify(token: string): Promise<LinkClaims | null> {
			if (token.length > MAX_TOKEN_CHARS) return null;
			const match = TOKEN_SHAPE.exec(token);
			if (match === null) return null;
			const [, body = '', macText = ''] = match;
			let mac: Uint8Array;
			try {
				mac = decodeBase64Url(macText);
			} catch {
				return null;
			}
			// One spelling per token: the 43rd character of a 32-byte MAC carries two unused bits, so four strings
			// decode to the same MAC. Only the one this signer emits is accepted — measured on the browser tier,
			// where flipping that character's low bit still verified before this check.
			if (encodeBase64Url(mac) !== macText) return null;
			// Constant time, by the platform: `verify` compares the whole MAC whatever byte differs first.
			const valid = await crypto.subtle.verify('HMAC', await imported, new Uint8Array(mac), signed(body));
			if (!valid) return null;
			let claims: unknown;
			try {
				claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(body)));
			} catch {
				return null;
			}
			if (!isClaims(claims)) return null;
			const seconds = Math.floor(now() / 1000);
			// The ceiling allows the minting node's clock to run up to LINK_CLOCK_SKEW_S ahead (R1-4); the floor allows
			// nothing — an expired link is expired on the clock that judges it.
			if (claims.exp <= seconds || claims.exp > seconds + LINK_TTL_MAX_S + LINK_CLOCK_SKEW_S) return null;
			// The fields named, never the parsed object: `isClaims` vets these and nothing else rides along.
			return {
				s: claims.s,
				i: claims.i,
				f: claims.f,
				o: claims.o,
				...(claims.k === undefined ? {} : { k: claims.k }),
				e: claims.e,
				exp: claims.exp,
				n: claims.n,
			};
		},

		async epochMatches(claims: LinkClaims, digest: string): Promise<boolean> {
			const expected = encoder.encode(await epochOf(claims.o, digest));
			// Constant time over equal lengths; `isClaims` already held `e` to 22 characters.
			return timingSafeEqual(expected, encoder.encode(claims.e));
		},
	};
}

/**
 * D-148: what a link is bound to — the digest its epoch is keyed over and, for an account API key, the key's public id
 * (`k`). `VerifierChain.linkBinding` builds it; it never leaves the minter.
 */
export interface LinkBinding {
	readonly digest: string;
	readonly key?: string;
}

/** What {@linkcode createLinkMinter} needs: the signer, and the one place an owner's credential binding is read. */
export interface LinkMinterOptions {
	readonly signer: LinkSigner;
	/**
	 * `VerifierChain.linkBinding`: the credential `owner` called under (`credential`, the call's GW-1 fingerprint, when
	 * the MCP mount bound one) as it stands now, or `null` once it is not in force.
	 */
	readonly bindingOf: (owner: string, credential: string | undefined) => LinkBinding | null;
}

/** The one text for every refusal that is about the credential no longer being in force. */
const NOT_IN_FORCE = 'the credential this call ran under is no longer in force';

/**
 * The `McpDeps.signedLink` the gateway wires (design §2.7): the tool's request, completed with the binding of the
 * credential the call ran under (D-140; the account API key's id too, D-148) and refused — as `scope-required`, a
 * result-level error — whenever the link could not be bound to a credential in force:
 *
 * - no incarnation (a record from before S0, or a caller that forgot it);
 * - **N3** (r2 gate): an `oauth:` owner with no `notAfter`. The OAuth cap (F1) is what bounds an OAuth link, so a call
 *   path that builds a tool context without `credentialNotAfter` (a direct tool executor, say) fails closed rather than
 *   minting a link that would outlive the token;
 * - an owner whose binding is `null` (key removed, account disabled, OAuth or anonymous no longer configured, the
 *   account API key or the sign-in the call ran under gone — D-148);
 * - a credential that expires within {@linkcode LINK_TTL_MIN_S} (the signer's own cap refusal).
 *
 * BUG-2: identifiers the token cannot carry (an owner past 512 characters, a body past 1800) are refused as
 * `invalid-arguments` instead.
 */
export function createLinkMinter(options: LinkMinterOptions): SignedLinkMinter {
	return async (input) => {
		if (input.incarnation === undefined || input.incarnation === '') {
			throw new ToolError('scope-required', NOT_IN_FORCE);
		}
		if (input.owner.startsWith('oauth:') && input.notAfter === undefined) {
			throw new ToolError(
				'scope-required',
				'the access token this call ran under has no known expiry, so a link cannot be bounded by it; ' +
					'call browser_file_link over the MCP endpoint with the token itself',
			);
		}
		const binding = options.bindingOf(input.owner, input.credential);
		if (binding === null) throw new ToolError('scope-required', NOT_IN_FORCE);
		try {
			return await options.signer.mint({
				sessionId: input.sessionId,
				fileId: input.fileId,
				owner: input.owner,
				incarnation: input.incarnation,
				digest: binding.digest,
				...(binding.key === undefined ? {} : { key: binding.key }),
				...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
				...(input.notAfter === undefined ? {} : { notAfter: input.notAfter }),
			});
		} catch (cause) {
			if (cause instanceof LinkMintError && cause.reason === 'too-long') {
				// BUG-2: the call's own identifiers cannot be carried; not a credential problem, so not scope-required.
				throw new ToolError(
					'invalid-arguments',
					"this principal's identifier (or the session or file id) is too long for a signed link",
				);
			}
			if (cause instanceof LinkMintError) {
				throw new ToolError(
					'scope-required',
					`the access token this call ran under expires within ${LINK_TTL_MIN_S} s; refresh it and mint again`,
				);
			}
			throw cause;
		}
	};
}
