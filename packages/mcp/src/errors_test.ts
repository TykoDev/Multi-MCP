/**
 * The navigation policy is a security control shared by the MCP tool and the
 * live view's human-driven navigation, so it is tested once, directly.
 */
import { assertEquals, assertThrows } from '@std/assert';
import { assertNavigable, canonicalHost, isHostAllowed, originOf, ToolError } from './errors.ts';

Deno.test('policy: an empty allowlist permits any http(s) URL', () => {
	assertEquals(assertNavigable('https://anything.test/x', []).hostname, 'anything.test');
	assertEquals(assertNavigable('http://plain.test/', []).protocol, 'http:');
});

Deno.test('policy: non-http(s) schemes are always refused', () => {
	for (const url of ['data:text/html,x', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://h/']) {
		const error = assertThrows(() => assertNavigable(url, []), ToolError);
		assertEquals((error as ToolError).code, 'navigation-blocked', url);
	}
});

Deno.test('policy: a malformed URL is an argument error', () => {
	const error = assertThrows(() => assertNavigable('not a url', []), ToolError);
	assertEquals((error as ToolError).code, 'invalid-arguments');
});

Deno.test('policy: an allowlist matches the host and its subdomains only', () => {
	const allow = ['example.com'];
	for (const ok of ['https://example.com/', 'https://a.example.com/', 'https://a.b.example.com/']) {
		assertEquals(assertNavigable(ok, allow).protocol, 'https:');
	}
	// The trap a naive endsWith() falls into: these all end with "example.com"
	// as a *string* but are different sites.
	for (const bad of ['https://notexample.com/', 'https://evil-example.com/', 'https://example.com.evil.net/']) {
		const error = assertThrows(() => assertNavigable(bad, allow), ToolError);
		assertEquals((error as ToolError).code, 'navigation-blocked', bad);
	}
});

Deno.test('policy: a leading dot in an allowlist entry is tolerated', () => {
	assertEquals(assertNavigable('https://a.example.com/', ['.example.com']).hostname, 'a.example.com');
});

Deno.test('policy: matching is case-insensitive on both sides', () => {
	assertEquals(assertNavigable('https://API.Example.COM/', ['example.com']).protocol, 'https:');
	assertEquals(assertNavigable('https://api.example.com/', ['EXAMPLE.COM']).protocol, 'https:');
});

/**
 * Normalisation, asserted against what the browser does rather than what a
 * string comparison does: a trailing dot, upper case and an IDN spelling are
 * all the same host to Chromium, so they must all be the same host here — on
 * both sides of the comparison, because the allowlist is operator-typed text.
 */
Deno.test('policy: trailing-dot, upper-case and IDN spellings match as the browser matches them', () => {
	const allow = ['Example.COM.', 'bücher.example'];
	for (const ok of ['https://example.com./', 'https://EXAMPLE.com/', 'https://a.example.com./x']) {
		assertEquals(assertNavigable(ok, allow).protocol, 'https:', ok);
	}
	// `new URL` hands back punycode; the entry was typed as Unicode.
	assertEquals(assertNavigable('https://bücher.example/', allow).hostname, 'xn--bcher-kva.example');
	assertEquals(assertNavigable('https://xn--bcher-kva.example/', allow).hostname, 'xn--bcher-kva.example');
	// And the trailing dot cannot be used the other way either.
	const error = assertThrows(() => assertNavigable('https://example.com.evil.net./', allow), ToolError);
	assertEquals((error as ToolError).code, 'navigation-blocked');
});

Deno.test('policy: canonicalHost and isHostAllowed are the one rule the ledger reuses', () => {
	assertEquals(canonicalHost(' .Example.COM.. '), 'example.com');
	assertEquals(canonicalHost('bücher.example'), 'xn--bcher-kva.example');
	assertEquals(canonicalHost(''), null);
	assertEquals(canonicalHost('not a host'), null);
	assertEquals(isHostAllowed('anything.test', []), true);
	assertEquals(isHostAllowed('a.example.com.', ['example.com']), true);
	assertEquals(isHostAllowed('evil-example.com', ['example.com']), false);
	assertEquals(isHostAllowed('example.com', ['not a host']), false, 'an unparseable entry permits nothing');
	assertEquals(originOf('https://h.example:8443/p?q=SECRET#f'), 'https://h.example:8443');
});
