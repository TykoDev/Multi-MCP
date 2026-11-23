/** Only a request target in canonical form reaches authentication and routing. */

/** `%XX` escapes that decode to an unreserved character or a control character. */
const ENCODED_UNRESERVED_OR_CONTROL = /%(?:[46][1-9a-f]|[57][0-9a]|3[0-9]|2[de]|5f|7e|[01][0-9a-f]|7f)/i;

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
	// After the dot-segment pass, so `%2e%2e` keeps the more specific answer it has always had.
	if (ENCODED_UNRESERVED_OR_CONTROL.test(path)) {
		return 'the request path contains a percent-encoded unreserved or control character';
	}
	return null;
}
