/**
 * The control plane's sign-in cookie and the CSRF value derived from it (B4, G2, D-097).
 *
 * The SPA used to keep its `ttks_` token in `localStorage`, where any script running in the page could read it
 * (D-073 recorded that trade). The token now travels in an `HttpOnly` cookie the page cannot read at all, and a
 * cookie is an ambient credential, so every cookie-authenticated request that changes state must also prove it
 * came from the control plane's own page:
 *
 * - `SameSite=Strict`: the browser does not attach the cookie to a request another site starts;
 * - this server's own `Origin` — scheme, host and port ({@linkcode cookieOriginAllowed}, R1-2) — which a browser
 *   always sends on a state-changing request;
 * - `x-ttk-csrf`: `base64url(SHA-256("ttk-csrf-v1\0" ‖ token))`, handed to the page in the sign-in response.
 *
 * **Why the full origin and not the hostname (R1-2, ERRATUM(E-88)).** The process-wide Origin allowlist compares
 * bare hostnames (the SDK's `validateOriginHeader`, port- and scheme-agnostic; E-23, B1.10) and stays that way for
 * bearer clients.
 * A cookie is not port-scoped, and another port of the same host is the same *site*, so `SameSite=Strict` does not
 * separate the two: a page on `http://<host>:3000` could sign this browser in to an account of its choosing (login
 * CSRF) while presenting an Origin the hostname list admits. Cookie-mode sign-in and every cookie-authenticated
 * change are therefore held to the exact origin.
 *
 * **Which jar is trusted (R1-2).** A page on any port of the host can also plant a `ttk_session` with a longer
 * `Path` on an `http:` deployment, which the browser then sends *first*. Reading the first value would let that page
 * pin this browser to the planter's session; reading a malformed value as "absent" would lock the browser out with
 * no way back. More than one sign-in cookie, or one this server could not have set, is refused and cleared on every
 * path it could have been set for ({@linkcode parseSessionCookie}, {@linkcode clearedSessionCookies}).
 *
 * The CSRF value is derived from the raw session token, not stored: every cluster node and every restart computes
 * the same value from the cookie alone (gatekeeper F3), and page script can learn it only from the sign-in or
 * `GET /api/v1/auth/me` response — both same-origin reads a foreign page cannot make. It is never derived from the
 * stored token **hash**, which is what `logins.json` and the cluster KV hold: a copy of those must not yield a
 * value that passes the check.
 *
 * Bearer clients (API keys, OAuth, MCP clients) are untouched: an `Authorization` header always wins and carries no
 * CSRF obligation, because a browser never attaches one on its own.
 */
import { encodeBase64Url } from '@std/encoding/base64url';
import { timingSafeEqual } from '@std/crypto/timing-safe-equal';
import { LOGIN_TOKEN_PREFIX } from './logins.ts';

/** The cookie on an `http:` public URL. */
export const SESSION_COOKIE = 'ttk_session';
/** The cookie on an `https:` public URL: the prefix makes the browser refuse it unless Secure, host-only, `Path=/`. */
export const SECURE_SESSION_COOKIE = '__Host-ttk_session';
/** The request header the SPA echoes the CSRF value in. */
export const CSRF_HEADER = 'x-ttk-csrf';

/** Methods that change state and so need the CSRF proof when the cookie authenticated them. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const CSRF_LABEL = new TextEncoder().encode('ttk-csrf-v1\0');

export interface SessionCookieSpec {
	readonly name: string;
	readonly secure: boolean;
}

/** The cookie name and `Secure` attribute this deployment uses, decided by the scheme of `TTK_PUBLIC_URL`. */
export function sessionCookieSpec(publicUrl: URL): SessionCookieSpec {
	const secure = publicUrl.protocol === 'https:';
	return { name: secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, secure };
}

/** `base64url(SHA-256("ttk-csrf-v1\0" ‖ token))`, unpadded. */
export async function csrfFor(token: string): Promise<string> {
	const raw = new TextEncoder().encode(token);
	const input = new Uint8Array(CSRF_LABEL.length + raw.length);
	input.set(CSRF_LABEL, 0);
	input.set(raw, CSRF_LABEL.length);
	return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

/** Constant-time comparison of a presented CSRF header with the expected value; absent is a mismatch. */
export function csrfMatches(presented: string | null | undefined, expected: string): boolean {
	if (presented === null || presented === undefined) return false;
	const a = new TextEncoder().encode(presented);
	const b = new TextEncoder().encode(expected);
	// The expected value has a fixed length (43 characters), so refusing a different length leaks nothing.
	return a.length === b.length && timingSafeEqual(a, b);
}

/** True for the methods that need the CSRF proof. */
export function isUnsafeMethod(method: string): boolean {
	return UNSAFE_METHODS.has(method.toUpperCase());
}

/** What the request's `Cookie` header says about the sign-in cookie (R1-2). */
export type SessionCookieRead =
	| { readonly kind: 'absent' }
	| { readonly kind: 'token'; readonly token: string }
	/** More than one cookie of the name, or a value this server never sets: refused and cleared, never resolved. */
	| { readonly kind: 'refused'; readonly reason: 'duplicate' | 'malformed' };

/**
 * Every cookie named `name` in the request's `Cookie` header, judged as a whole.
 *
 * **Only a `ttks_` sign-in token is ever read from a cookie.** A raw API key (`ttk_`), an OAuth token or a delegated
 * `ttkd_` token in the cookie is not something this server put there, and treating an ambient value as one of those
 * credentials would hand a key planted in the cookie jar the key's authority. R1-2: such a value is no longer read as
 * "no cookie" either — it is `refused`, so the browser is told to drop it — and neither is a second cookie of the
 * same name, which only a page on another port (or path) of this host can have planted.
 */
export function parseSessionCookie(header: string | null | undefined, name: string): SessionCookieRead {
	if (header === null || header === undefined || header === '') return { kind: 'absent' };
	const values: string[] = [];
	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		values.push(part.slice(separator + 1).trim());
	}
	const [value, ...others] = values;
	if (value === undefined) return { kind: 'absent' };
	if (others.length > 0) return { kind: 'refused', reason: 'duplicate' };
	return value.startsWith(LOGIN_TOKEN_PREFIX) && /^[A-Za-z0-9_]+$/.test(value)
		? { kind: 'token', token: value }
		: { kind: 'refused', reason: 'malformed' };
}

/** The session token in the request's `Cookie` header, or `null` when there is none or it is refused. */
export function readSessionCookie(header: string | null | undefined, name: string): string | null {
	const read = parseSessionCookie(header, name);
	return read.kind === 'token' ? read.token : null;
}

/**
 * R1-2: whether `origin` is one this server's page is served from, compared as a whole serialized origin — scheme,
 * host and port — never by hostname alone.
 *
 * The allowed origins are derived, not configured, because `TTK_ALLOWED_ORIGINS` holds bare hostnames by design
 * (B1.10 refuses an entry with a scheme or a port at startup) and so cannot name a full origin:
 *
 * 1. `TTK_PUBLIC_URL`'s origin — the address the page is published at, behind a proxy included;
 * 2. the request's own origin: `TTK_PUBLIC_URL`'s scheme with the `Host` the browser addressed. The front has already
 *    held `Host` to `TTK_ALLOWED_HOSTS`, and a browser sets it from the URL it is fetching, so a page presents a
 *    matching Origin only by being served from that very address. This admits the loopback spellings (`localhost`
 *    beside `127.0.0.1`) and a LAN name the operator browses by, and nothing on another port of them.
 *
 * The scheme is the public URL's, never guessed from the request: this process does not terminate TLS and cannot
 * know the browser's scheme, and a page on `http://host` is not the `https://host` the cookie was issued for.
 */
export function cookieOriginAllowed(
	origin: string | null | undefined,
	publicUrl: URL,
	host: string | null | undefined,
): boolean {
	if (origin === null || origin === undefined || origin === '') return false;
	if (origin === publicUrl.origin) return true;
	if (host === null || host === undefined || host === '') return false;
	try {
		return origin === new URL(`${publicUrl.protocol}//${host}`).origin;
	} catch {
		return false;
	}
}

/** The `Set-Cookie` value that stores `token` for `maxAgeS` seconds. */
export function sessionCookie(spec: SessionCookieSpec, token: string, maxAgeS: number): string {
	return `${spec.name}=${token}; ${attributes(spec)}; Max-Age=${Math.max(0, Math.floor(maxAgeS))}`;
}

/** The `Set-Cookie` value that removes the cookie (sign-out). */
export function clearedSessionCookie(spec: SessionCookieSpec): string {
	return `${spec.name}=; ${attributes(spec)}; Max-Age=0`;
}

/** How many leading segments of a request path {@linkcode clearedSessionCookies} clears a cookie for. */
const CLEAR_DEPTH = 8;

/** A path segment that may be echoed into a `Path` attribute as it is. */
const PLAIN_SEGMENT = /^[A-Za-z0-9._~:@!$&()*+,=-]+$/;

/**
 * R1-2: the `Set-Cookie` values that remove every sign-in cookie a refused request could have carried.
 *
 * A cookie is removed only by a `Set-Cookie` naming its own `Path`, and the browser never says which path a cookie
 * has. But a cookie it sent on this request has a path that path-matches the request: `/`, or a prefix of the
 * request path with or without a trailing slash. One clearing value per such prefix removes a planted cookie wherever
 * it was set, together with the real one at `/`. A `__Host-` cookie cannot carry any other path (the browser refuses
 * one that tries), so on `https:` the single `Path=/` value is the whole list. Bounded in depth; a segment that is
 * not plain text ends the list rather than being echoed into a header.
 */
export function clearedSessionCookies(spec: SessionCookieSpec, requestPath: string): string[] {
	const paths = ['/'];
	if (!spec.secure) {
		let prefix = '';
		for (const segment of requestPath.split('/').filter((part) => part !== '').slice(0, CLEAR_DEPTH)) {
			if (!PLAIN_SEGMENT.test(segment)) break;
			prefix += `/${segment}`;
			paths.push(prefix, `${prefix}/`);
		}
	}
	// A replacer function, so a `$` in a segment is never read as a replacement pattern.
	return paths.map((path) => clearedSessionCookie(spec).replace('; Path=/', () => `; Path=${path}`));
}

function attributes(spec: SessionCookieSpec): string {
	return `HttpOnly; SameSite=Strict; Path=/${spec.secure ? '; Secure' : ''}`;
}
