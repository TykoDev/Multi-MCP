/**
 * R1-5, ERRATUM(E-89): only a request target in canonical form reaches authentication and routing.
 *
 * Three readers of one request disagreed about its path. Deno hands the request target through to `request.url`
 * as the client sent it, dot segments and all; `new URL(url).pathname` — what the auth middleware judged public-ness
 * on — resolves `..`, `.` and their `%2e` spellings away; and Hono routes the raw path, percent-decoded. So
 * `GET /a2a/v1/../../live/x/ws` looked like the public `/live/x/ws` to the credential check and was routed into the
 * authenticated `/a2a/v1/*` wildcard, which refused it only because its own handler happens to check the owner
 * again. A future wildcard without that second check would have been unauthenticated.
 *
 * The front therefore refuses, with `400 invalid-request` and before anything else looks at the request, every
 * target in which the three readers could disagree: a dot segment (raw or percent-encoded), an encoded slash or
 * backslash, a raw backslash (the URL parser reads it as a slash), and an empty segment (`//`). No client this
 * server serves sends any of them; the SPA, the MCP SDKs and the A2A binding all build canonical paths. The auth
 * middleware additionally judges public-ness on the router's own path, so the two can never drift apart again.
 */

/**
 * The path of `url` exactly as the client sent it: from the end of the authority to the first `?` or `#`, with no
 * dot-segment resolution and no percent-decoding (both of which `new URL()` would apply). `/` when there is none.
 */
export function rawPathOf(url: string): string {
	const scheme = url.indexOf('://');
	const authority = scheme < 0 ? 0 : scheme + 3;
	let start = authority;
	while (start < url.length && url[start] !== '/' && url[start] !== '?' && url[start] !== '#') start += 1;
	if (start >= url.length || url[start] !== '/') return '/';
	let end = start;
	while (end < url.length && url[end] !== '?' && url[end] !== '#') end += 1;
	return url.slice(start, end);
}

/** Why `path` (a raw path, {@linkcode rawPathOf}) is not canonical, or `null` when it is. */
export function pathRefusal(path: string): string | null {
	if (!path.startsWith('/')) return 'the request target is not a path';
	if (path.includes('\\')) return 'the request path contains a backslash';
	if (/%(2f|5c)/i.test(path)) return 'the request path contains an encoded slash or backslash';
	if (path.includes('//')) return 'the request path contains an empty segment';
	for (const segment of path.split('/')) {
		const decoded = segment.replace(/%2e/gi, '.');
		if (decoded === '.' || decoded === '..') return 'the request path contains a dot segment';
	}
	return null;
}
