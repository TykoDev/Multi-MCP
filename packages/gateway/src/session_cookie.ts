/** The control plane's sign-in cookie and the CSRF value derived from it. */
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

/** What the request's `Cookie` header says about the sign-in cookie. */
export type SessionCookieRead =
	| { readonly kind: 'absent' }
	| { readonly kind: 'token'; readonly token: string }
	/** More than one cookie of the name, or a value this server never sets: refused and cleared, never resolved. */
	| { readonly kind: 'refused'; readonly reason: 'duplicate' | 'malformed' };

/** Every cookie named `name` in the request's `Cookie` header, judged as a whole. */
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
 * Whether `origin` is one this server's page is served from, compared as a whole serialized origin — scheme, host and
 * port — never by hostname alone.
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

/** The `Set-Cookie` values that remove every sign-in cookie a refused request could have carried. */
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
