/**
 * Tier-1 `url-matcher` suite (OBSERVABILITY-TESTING-CICD.md §4.2) — the security-critical one.
 *
 * One known-answer table per rule M1–M9 of SECURITY-AUTH.md §4.1, plus the adversarial classes the
 * suite is speced to carry: userinfo tricks, obfuscated IPv4 (decimal/hex/octal/short), Unicode
 * NFKC digit spoofing, unsafe-pattern rejection, new-tab never-match. Known-answer tables only — no
 * property-based fuzz, because CI determinism is the point (§4.2).
 *
 * Release gate: COMPLETIONS-CRITERIA.md Q5 requires **100 % branch coverage** of `url_matcher.ts`.
 */

// test-policy-allow-file: the KAT tables carry remote-looking URLs as *data* — they are strings fed
// to a parser, never endpoints. The suite runs with no --allow-net at all, so a stray fetch would
// die as NotCapable rather than reach the network (SECURITY-AUTH.md §3.6).

import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import {
	canonicalHost,
	type CompiledDomainPolicy,
	compileDomainPolicy,
	defaultPatternWarnSink,
	type DomainPolicy,
	ipLiteralOf,
	isIpLiteralHost,
	isNewTabUrl,
	isUrlAllowed,
	NEW_TAB_URLS,
	normalizeHostForIpCheck,
	parsePattern,
	type PatternRejectionReason,
	type PatternWarning,
	resolveAllowedDomains,
	SET_MODE_THRESHOLD,
	urlMatch,
	type UrlMatchContext,
	validatePatterns,
} from './url_matcher.ts';

type MatchCase = {
	readonly name: string;
	readonly url: string;
	readonly pattern: string;
	/** Omitted rows call the two-argument form, pinning the `navigation` default of M4. */
	readonly context?: UrlMatchContext;
	readonly expected: boolean;
};

function run(row: MatchCase): boolean {
	return row.context === undefined ? urlMatch(row.url, row.pattern) : urlMatch(row.url, row.pattern, row.context);
}

function matchTable(rule: string, rows: readonly MatchCase[]): void {
	Deno.test.each(rows)(`${rule}: $name`, (row) => {
		assertEquals(run(row), row.expected, `${row.url} vs ${row.pattern}`);
	});
}

// ---------------------------------------------------------------------------
// M1 — unparseable or empty url ⇒ no match (fail closed)
// ---------------------------------------------------------------------------

matchTable('M1', [
	{ name: 'empty url', url: '', pattern: 'example.com', expected: false },
	{ name: 'whitespace url', url: '   ', pattern: 'example.com', expected: false },
	{ name: 'not a url at all', url: 'not a url', pattern: 'example.com', expected: false },
	{ name: 'scheme-relative reference', url: '//example.com/x', pattern: 'example.com', expected: false },
	{ name: 'bare host, no scheme', url: 'example.com', pattern: 'example.com', expected: false },
	{ name: 'scheme with no authority', url: 'https://', pattern: 'example.com', expected: false },
	{ name: 'parseable but host-less (file:)', url: 'file:///tmp/x', pattern: 'example.com', expected: false },
	{ name: 'parseable but host-less (about:config)', url: 'about:config', pattern: '*.example.com', expected: false },
]);

// ---------------------------------------------------------------------------
// M2 — new-tab URLs never match any pattern
// ---------------------------------------------------------------------------

matchTable('M2', [
	{ name: 'about:blank vs a matching chrome pattern', url: 'about:blank', pattern: 'about://blank', expected: false },
	{ name: 'chrome://new-tab-page', url: 'chrome://new-tab-page', pattern: 'chrome://new-tab-page', expected: false },
	{ name: 'chrome://new-tab-page/', url: 'chrome://new-tab-page/', pattern: 'chrome://new-tab-page', expected: false },
	{ name: 'chrome://newtab', url: 'chrome://newtab', pattern: 'chrome://newtab', expected: false },
	{ name: 'chrome://newtab/', url: 'chrome://newtab/', pattern: 'chrome://newtab', expected: false },
	{ name: 'case and padding are folded', url: '  ABOUT:BLANK  ', pattern: 'about://blank', expected: false },
	{
		name: 'secret scope never unlocks on a new tab',
		url: 'about:blank',
		pattern: 'https://*.bank.test',
		context: 'secret',
		expected: false,
	},
	{ name: 'a real chrome page still matches', url: 'chrome://settings/', pattern: 'chrome://settings', expected: true },
]);

Deno.test('M2: the new-tab list is exactly the five speced URLs', () => {
	assertEquals(NEW_TAB_URLS, [
		'about:blank',
		'chrome://new-tab-page',
		'chrome://new-tab-page/',
		'chrome://newtab',
		'chrome://newtab/',
	]);
	for (const url of NEW_TAB_URLS) assert(isNewTabUrl(url));
	assertFalse(isNewTabUrl('about:blank?x'));
	assertFalse(isNewTabUrl('https://example.com/'));
});

// ---------------------------------------------------------------------------
// M3 — unsafe patterns are rejected and match nothing (no "warn but allow")
// ---------------------------------------------------------------------------

type RejectionCase = { readonly name: string; readonly pattern: string; readonly reason: PatternRejectionReason };

const REJECTED: readonly RejectionCase[] = [
	{ name: 'lone wildcard', pattern: '*', reason: 'lone-wildcard' },
	{ name: 'lone wildcard behind a scheme', pattern: 'https://*', reason: 'lone-wildcard' },
	{ name: 'multiple wildcards', pattern: '*.*.com', reason: 'multiple-wildcards' },
	{ name: 'multiple wildcards behind a scheme', pattern: 'https://*.*.example.com', reason: 'multiple-wildcards' },
	{ name: 'embedded wildcard', pattern: 'ex*mple.com', reason: 'embedded-wildcard' },
	{ name: 'suffix wildcard inside a label', pattern: 'example*.com', reason: 'embedded-wildcard' },
	{ name: 'TLD wildcard', pattern: 'example.*', reason: 'tld-wildcard' },
	{ name: 'TLD wildcard behind a scheme', pattern: 'https://example.*', reason: 'tld-wildcard' },
	{ name: 'wildcard in scheme position', pattern: '*://example.com', reason: 'scheme-wildcard' },
	{ name: 'partial wildcard in scheme position', pattern: 'htt*://example.com', reason: 'scheme-wildcard' },
	{ name: 'empty pattern', pattern: '', reason: 'empty' },
	{ name: 'whitespace pattern', pattern: '   ', reason: 'empty' },
	{ name: 'wildcard with no base', pattern: '*.', reason: 'empty' },
	{ name: 'scheme with no host', pattern: 'https://', reason: 'empty' },
	{ name: 'malformed scheme', pattern: '1https://example.com', reason: 'unparseable' },
	{ name: 'path component', pattern: 'https://example.com/admin', reason: 'path-or-credentials' },
	{ name: 'userinfo in the pattern', pattern: 'user@example.com', reason: 'path-or-credentials' },
	{ name: 'query in the pattern', pattern: 'https://example.com?a=1', reason: 'path-or-credentials' },
	{ name: 'fragment in the pattern', pattern: 'https://example.com#f', reason: 'path-or-credentials' },
	{ name: 'backslash in the pattern', pattern: 'example.com\\evil.test', reason: 'path-or-credentials' },
	{ name: 'space in the pattern', pattern: 'exam ple.com', reason: 'path-or-credentials' },
	{ name: 'tab in the pattern', pattern: 'example.com\tevil', reason: 'path-or-credentials' },
	{ name: 'non-numeric port', pattern: 'example.com:http', reason: 'unparseable' },
	{ name: 'port zero', pattern: 'example.com:0', reason: 'unparseable' },
	{ name: 'port above 65535', pattern: 'example.com:70000', reason: 'unparseable' },
	{ name: 'unterminated IPv6 bracket', pattern: '[::1', reason: 'unparseable' },
	{ name: 'junk after an IPv6 bracket', pattern: '[::1]x', reason: 'unparseable' },
	{ name: 'zero port on an IPv6 literal', pattern: '[::1]:0', reason: 'unparseable' },
	{ name: 'unparseable bracketed host', pattern: '[bad]', reason: 'unparseable' },
	{ name: 'host that canonicalises to nothing', pattern: '.', reason: 'unparseable' },
];

Deno.test.each(REJECTED)('M3: $name is refused ($reason)', (row) => {
	const parsed = parsePattern(row.pattern);
	assertFalse(parsed.ok, `expected ${row.pattern} to be refused`);
	if (parsed.ok) return;
	assertEquals(parsed.reason, row.reason);
	// Refused means "matches nothing", not "matches everything".
	assertFalse(urlMatch('https://example.com/', row.pattern));
	assertFalse(urlMatch('https://a.b.example.com/', row.pattern));
});

Deno.test('M3: the one safe wildcard shape survives, in both scheme forms', () => {
	const bare = parsePattern('*.example.com');
	assert(bare.ok);
	assertEquals(bare.pattern, {
		source: '*.example.com',
		scheme: null,
		host: 'example.com',
		wildcard: true,
		port: null,
	});
	const qualified = parsePattern('https://*.example.com/');
	assert(qualified.ok);
	assertEquals(qualified.pattern.scheme, 'https');
	assertEquals(qualified.pattern.wildcard, true);
	assertEquals(qualified.pattern.host, 'example.com');
});

Deno.test('M3: a public-suffix wildcard is honoured as written (spec-faithful, not a gap)', () => {
	// M3's refusal list covers multiple/embedded/TLD-position/lone wildcards — not `*.com`, which
	// over-matches exactly as widely as its author asked. Pinned so a future narrowing is deliberate.
	assert(parsePattern('*.com').ok);
	assert(urlMatch('https://anything.com/', '*.com'));
});

// ---------------------------------------------------------------------------
// M4 — scheme handling, and the navigation/secret split
// ---------------------------------------------------------------------------

matchTable('M4', [
	{
		name: 'scheme-less matches http in navigation',
		url: 'http://example.com/',
		pattern: 'example.com',
		expected: true,
	},
	{
		name: 'scheme-less matches https in navigation',
		url: 'https://example.com/',
		pattern: 'example.com',
		expected: true,
	},
	{
		name: 'scheme-less refuses http for secrets',
		url: 'http://example.com/',
		pattern: 'example.com',
		context: 'secret',
		expected: false,
	},
	{
		name: 'scheme-less allows https for secrets',
		url: 'https://example.com/',
		pattern: 'example.com',
		context: 'secret',
		expected: true,
	},
	{
		name: 'explicit http:// unlocks secrets over plaintext',
		url: 'http://example.com/',
		pattern: 'http://example.com',
		context: 'secret',
		expected: true,
	},
	{ name: 'scheme-less does not match ftp', url: 'ftp://example.com/', pattern: 'example.com', expected: false },
	{
		name: 'scheme-less does not match chrome-extension',
		url: 'chrome-extension://abcdef/x.html',
		pattern: 'abcdef',
		expected: false,
	},
	{
		name: 'http:// pattern rejects an https url',
		url: 'https://example.com/',
		pattern: 'http://example.com',
		expected: false,
	},
	{
		name: 'chrome-extension:// matches its own scheme',
		url: 'chrome-extension://abcdef/popup.html',
		pattern: 'chrome-extension://abcdef',
		expected: true,
	},
	{
		name: 'chrome-extension:// does not match another extension',
		url: 'chrome-extension://other/popup.html',
		pattern: 'chrome-extension://abcdef',
		expected: false,
	},
]);

// ---------------------------------------------------------------------------
// M5 — `*.example.com` matches the apex and any depth of subdomain
// ---------------------------------------------------------------------------

matchTable('M5', [
	{ name: 'apex itself', url: 'https://example.com/', pattern: '*.example.com', expected: true },
	{ name: 'one label deep', url: 'https://a.example.com/', pattern: '*.example.com', expected: true },
	{ name: 'three labels deep', url: 'https://a.b.c.example.com/', pattern: '*.example.com', expected: true },
	{ name: 'suffix-confusable sibling', url: 'https://evil-example.com/', pattern: '*.example.com', expected: false },
	{
		name: 'the base as a prefix of another domain',
		url: 'https://example.com.evil.test/',
		pattern: '*.example.com',
		expected: false,
	},
	{ name: 'label boundary is required', url: 'https://notexample.com/', pattern: '*.example.com', expected: false },
]);

// ---------------------------------------------------------------------------
// M6 — bare domains: case-insensitive, port-agnostic unless pinned, www.± root
// ---------------------------------------------------------------------------

matchTable('M6', [
	{ name: 'case folds on both sides', url: 'https://EXAMPLE.com/', pattern: 'Example.COM', expected: true },
	{ name: 'port ignored when unpinned', url: 'https://example.com:8443/', pattern: 'example.com', expected: true },
	{
		name: 'single-dot root also matches www.',
		url: 'https://www.example.com/',
		pattern: 'example.com',
		expected: true,
	},
	{
		name: 'www. widening stops at the single-dot root',
		url: 'https://www.mail.google.com/',
		pattern: 'mail.google.com',
		expected: false,
	},
	{ name: 'no reverse www. widening', url: 'https://example.com/', pattern: 'www.example.com', expected: false },
	{
		name: 'sibling subdomain is not a bare match',
		url: 'https://api.example.com/',
		pattern: 'example.com',
		expected: false,
	},
	{ name: 'pinned port matches', url: 'http://localhost:8080/', pattern: 'localhost:8080', expected: true },
	{ name: 'pinned port mismatches', url: 'http://localhost:9000/', pattern: 'localhost:8080', expected: false },
	{ name: 'pinned default https port', url: 'https://example.com/', pattern: 'example.com:443', expected: true },
	{ name: 'pinned default http port', url: 'http://example.com/', pattern: 'example.com:80', expected: true },
	{
		name: 'pinned port on a scheme with no default',
		url: 'chrome-extension://abcdef/',
		pattern: 'chrome-extension://abcdef:80',
		expected: false,
	},
	{
		name: 'FQDN root dot is folded (prohibited-list bypass)',
		url: 'https://example.com./',
		pattern: 'example.com',
		expected: true,
	},
	{
		name: 'FQDN root dot folded under a wildcard too',
		url: 'https://a.example.com./',
		pattern: '*.example.com',
		expected: true,
	},
]);

// ---------------------------------------------------------------------------
// M7 — scheme-qualified patterns are origin matches (any path)
// ---------------------------------------------------------------------------

matchTable('M7', [
	{
		name: 'exact origin, deep path',
		url: 'https://mail.google.com/u/0/#inbox?q=1',
		pattern: 'https://mail.google.com',
		expected: true,
	},
	{
		name: 'exact origin, trailing slash in the pattern',
		url: 'https://mail.google.com/',
		pattern: 'https://mail.google.com/',
		expected: true,
	},
	{
		name: 'scheme must match exactly',
		url: 'http://mail.google.com/',
		pattern: 'https://mail.google.com',
		expected: false,
	},
	{
		name: 'qualified glob, matching scheme',
		url: 'https://a.example.com/x',
		pattern: 'https://*.example.com',
		expected: true,
	},
	{
		name: 'qualified glob, wrong scheme',
		url: 'http://a.example.com/x',
		pattern: 'https://*.example.com',
		expected: false,
	},
	{
		name: 'qualified glob still reaches the apex',
		url: 'https://example.com/x',
		pattern: 'https://*.example.com',
		expected: true,
	},
]);

// ---------------------------------------------------------------------------
// M8 — IP-literal hosts match only that literal; wildcards never match them
// ---------------------------------------------------------------------------

matchTable('M8', [
	{ name: 'exact IPv4 literal', url: 'http://192.168.1.1/', pattern: '192.168.1.1', expected: true },
	{ name: 'different IPv4 literal', url: 'http://192.168.1.2/', pattern: '192.168.1.1', expected: false },
	{ name: 'wildcard over an IPv4 suffix', url: 'http://192.168.1.1/', pattern: '*.168.1.1', expected: false },
	{ name: 'domain wildcard against an IP host', url: 'http://192.168.1.1/', pattern: '*.example.com', expected: false },
	{ name: 'exact IPv6 literal', url: 'http://[::1]/', pattern: '[::1]', expected: true },
	{
		name: 'IPv6 canonicalisation on both sides',
		url: 'http://[0:0:0:0:0:0:0:1]/',
		pattern: '[0000::1]',
		expected: true,
	},
	{ name: 'IPv6 wildcard never matches', url: 'http://[::1]/', pattern: '*.1', expected: false },
	{ name: 'unbracketed IPv6 pattern pins no port', url: 'http://[::1]/', pattern: '::1', expected: true },
	{
		name: 'unbracketed IPv6 pattern, full form',
		url: 'http://[2001:db8::1]/',
		pattern: '2001:0db8:0:0:0:0:0:1',
		expected: true,
	},
	{
		name: 'hex pattern and dotted url denote one address',
		url: 'http://192.168.1.1/',
		pattern: '0xC0A80101',
		expected: true,
	},
	{ name: 'IP pattern does not match a name', url: 'http://example.com/', pattern: '192.168.1.1', expected: false },
	{ name: 'pinned port on an IPv6 literal', url: 'http://[::1]:9222/', pattern: '[::1]:9222', expected: true },
]);

// ---------------------------------------------------------------------------
// M9 — userinfo tricks resolve against the parsed hostname, never a prefix
// ---------------------------------------------------------------------------

matchTable('M9', [
	{
		name: 'allowed host in userinfo does not match',
		url: 'https://allowed.example@evil.test/',
		pattern: 'allowed.example',
		expected: false,
	},
	{
		name: 'the authority after @ is what matches',
		url: 'https://allowed.example@evil.test/',
		pattern: 'evil.test',
		expected: true,
	},
	{
		name: 'wildcard is not fooled by userinfo',
		url: 'https://a.example.com@evil.test/',
		pattern: '*.example.com',
		expected: false,
	},
	{ name: 'user:password form', url: 'https://user:pass@example.com:8443/x', pattern: 'example.com', expected: true },
	{
		name: 'host-looking password',
		url: 'https://user:example.com@evil.test/',
		pattern: 'example.com',
		expected: false,
	},
	{
		name: 'double-@ authority resolves to the last host',
		url: 'https://a@b@evil.test/',
		pattern: 'evil.test',
		expected: true,
	},
	// WHATWG treats `\` as `/` in a special URL, so the authority ends before the `@`: the host is
	// `example.com` and the browser will dial it. Matching that is correct, not a bypass — the
	// bypass would be trusting the *text* after the `@`.
	{
		name: 'backslash truncates the authority',
		url: 'https://example.com\\@evil.test/',
		pattern: 'example.com',
		expected: true,
	},
	{
		name: 'backslash truncation does not reach evil.test',
		url: 'https://example.com\\@evil.test/',
		pattern: 'evil.test',
		expected: false,
	},
]);

// ---------------------------------------------------------------------------
// Adversarial: obfuscated IPv4 encodings (§4.2 step 4)
// ---------------------------------------------------------------------------

type IpCase = { readonly name: string; readonly host: string; readonly literal: string | null };

Deno.test.each<IpCase>([
	{ name: 'dotted quad', host: '192.168.1.1', literal: '192.168.1.1' },
	{ name: 'decimal', host: '3232235777', literal: '192.168.1.1' },
	{ name: 'hex', host: '0xC0A80101', literal: '192.168.1.1' },
	{ name: 'octal', host: '0300.0250.0.1', literal: '192.168.0.1' },
	{ name: 'short dotted (3 parts)', host: '192.168.1', literal: '192.168.0.1' },
	{ name: 'short dotted (2 parts)', host: '192.11010305', literal: '192.168.1.1' },
	{ name: 'the spec-named bypass 0xd83ad60e', host: '0xd83ad60e', literal: '216.58.214.14' },
	{ name: 'IPv6 loopback', host: '[::1]', literal: '[::1]' },
	{ name: 'IPv6 unbracketed', host: '::1', literal: '[::1]' },
	{ name: 'IPv4-mapped IPv6', host: '[::ffff:192.168.1.1]', literal: '[::ffff:c0a8:101]' },
	{ name: 'overflowing decimal is not an address', host: '4294967296', literal: null },
	{ name: 'out-of-range octet', host: '999.1.1.1', literal: null },
	{ name: 'plain name', host: 'example.com', literal: null },
	{ name: 'name with a numeric prefix', host: '127.0.0.1.example.com', literal: null },
	{ name: 'empty host', host: '', literal: null },
	{ name: 'bracketed junk', host: '[not-an-ip]', literal: null },
	{ name: 'colon junk', host: 'a:b:c', literal: null },
])('obfuscated-ip: $name', (row) => {
	assertEquals(ipLiteralOf(row.host), row.literal);
	assertEquals(isIpLiteralHost(row.host), row.literal !== null);
});

Deno.test('obfuscated-ip: every encoding is blocked end-to-end by blockIpAddresses', () => {
	const policy: DomainPolicy = { blockIpAddresses: true };
	for (
		const url of [
			'http://192.168.1.1/',
			'http://3232235777/',
			'http://0xC0A80101/',
			'http://0300.0250.0.1/',
			'http://192.168.1/',
			'http://0xd83ad60e/',
			'http://[::1]/',
		]
	) {
		assertFalse(isUrlAllowed(url, policy), url);
	}
	assert(isUrlAllowed('https://example.com/', policy));
	// Without the flag the same URLs are ordinary hosts.
	assert(isUrlAllowed('http://0xd83ad60e/', {}));
});

// ---------------------------------------------------------------------------
// Adversarial: Unicode / NFKC digit + separator spoofing
// ---------------------------------------------------------------------------

Deno.test.each([
	{ name: 'fullwidth digits', host: '１２７.0.0.1', normalized: '127.0.0.1', ip: true },
	{ name: 'ideographic full stops', host: '127。0。0。1', normalized: '127.0.0.1', ip: true },
	{ name: 'halfwidth ideographic full stops', host: '127｡0｡0｡1', normalized: '127.0.0.1', ip: true },
	{ name: 'fullwidth full stops', host: '127．0．0．1', normalized: '127.0.0.1', ip: true },
	{ name: 'fullwidth digits in a decimal literal', host: '３２３２２３５７７７', normalized: '3232235777', ip: true },
	{ name: 'percent-encoded dotted quad', host: '%31%32%37%2E0%2E0%2E1', normalized: '127.0.0.1', ip: true },
	{ name: 'trailing FQDN dot after folding', host: '127。0。0。1。', normalized: '127.0.0.1', ip: true },
	{ name: 'malformed percent-escape is left alone', host: '%zz.example.com', normalized: '%zz.example.com', ip: false },
	{ name: 'unfolded name stays a name', host: 'Example.COM', normalized: 'example.com', ip: false },
])('nfkc-spoofing: $name', (row) => {
	assertEquals(normalizeHostForIpCheck(row.host), row.normalized);
	assertEquals(isIpLiteralHost(row.host), row.ip);
});

Deno.test('nfkc-spoofing: an opaque-scheme host survives percent-encoding into the IP block', () => {
	// Non-special schemes keep their host opaque — the URL parser does not percent-decode it, so the
	// §4.2 step-4 normalisation is what closes this hole.
	assertFalse(isUrlAllowed('foo://%31%32%37.0.0.1/', { blockIpAddresses: true }));
	assert(isUrlAllowed('foo://%31%32%37.0.0.1/', { blockIpAddresses: false }));
});

Deno.test('nfkc-spoofing: folding is NOT applied to host comparison (it would widen a policy)', () => {
	// `ｅxample.com` NFKC-folds to `example.com`. Folding here would let a spoofed opaque host walk
	// into an allowlist, so `urlMatch` deliberately relies on the URL parser's own IDNA mapping.
	assertFalse(urlMatch('foo://ｅxample.com/', 'foo://example.com'));
	// For http(s) the parser's IDNA mapping does the folding itself, which is the mapping Chrome
	// will resolve with — so this one legitimately matches.
	assert(urlMatch('https://ｅxample.com/', 'example.com'));
});

// ---------------------------------------------------------------------------
// canonicalHost
// ---------------------------------------------------------------------------

Deno.test('canonicalHost: lowercases and drops exactly one root dot', () => {
	assertEquals(canonicalHost('Example.COM'), 'example.com');
	assertEquals(canonicalHost('example.com.'), 'example.com');
	assertEquals(canonicalHost(''), '');
});

// ---------------------------------------------------------------------------
// isUrlAllowed — §4.2 evaluation order
// ---------------------------------------------------------------------------

Deno.test('policy: step 1 — new-tab URLs are always allowed', () => {
	const policy: DomainPolicy = { allowedDomains: ['example.com'], blockIpAddresses: true };
	for (const url of NEW_TAB_URLS) assert(isUrlAllowed(url, policy), url);
});

Deno.test('policy: step 2 — data: and blob: are allowed, other schemes are not exempt', () => {
	const policy: DomainPolicy = { allowedDomains: ['example.com'] };
	assert(isUrlAllowed('data:text/html,<p>hi', policy));
	assert(isUrlAllowed('blob:https://evil.test/uuid', policy));
	assertFalse(isUrlAllowed('chrome://settings/', policy));
});

Deno.test('policy: step 3 — unparseable and host-less URLs are denied (fail closed)', () => {
	assertFalse(isUrlAllowed('', {}));
	assertFalse(isUrlAllowed('not a url', {}));
	assertFalse(isUrlAllowed('file:///etc/passwd', {}));
	assertFalse(isUrlAllowed('about:config', {}));
});

Deno.test('policy: step 4 — blockIpAddresses beats an allowlist that names the literal', () => {
	const policy: DomainPolicy = { allowedDomains: ['192.168.1.1'], blockIpAddresses: true };
	assertFalse(isUrlAllowed('http://192.168.1.1/', policy));
	assertFalse(isUrlAllowed('http://0xC0A80101/', policy));
	// The same allowlist without the flag lets the literal through.
	assert(isUrlAllowed('http://192.168.1.1/', { allowedDomains: ['192.168.1.1'] }));
});

Deno.test('policy: step 5 — a non-empty allowlist takes precedence over the prohibited list', () => {
	const policy: DomainPolicy = { allowedDomains: ['*.example.com'], prohibitedDomains: ['*.example.com'] };
	assert(isUrlAllowed('https://a.example.com/', policy));
	assertFalse(isUrlAllowed('https://evil.test/', policy));
});

Deno.test('policy: step 5 — an allowlist of nothing but refused patterns denies everything', () => {
	// Fail closed: "the operator asked for a restriction and mis-spelled it" must not degrade into
	// "no restriction".
	const policy = compileDomainPolicy({ allowedDomains: ['*', 'example.*'] }, { onWarn: null });
	assertFalse(isUrlAllowed('https://example.com/', policy));
	assertFalse(isUrlAllowed('https://anything.test/', policy));
	assert(isUrlAllowed('about:blank', policy));
});

Deno.test('policy: step 6 — prohibited list denies matches and allows everything else', () => {
	const policy: DomainPolicy = { prohibitedDomains: ['*.evil.test', 'ads.example.com'] };
	assertFalse(isUrlAllowed('https://a.evil.test/', policy));
	assertFalse(isUrlAllowed('https://evil.test/', policy));
	assertFalse(isUrlAllowed('https://ads.example.com/', policy));
	assert(isUrlAllowed('https://example.com/', policy));
	// The FQDN-root-dot fold is what stops the classic deny-list bypass.
	assertFalse(isUrlAllowed('https://evil.test./', policy));
});

Deno.test('policy: step 7 — an unconfigured policy allows everything with a host', () => {
	assert(isUrlAllowed('https://example.com/', {}));
	assert(isUrlAllowed('http://192.168.1.1/', {}));
	assert(isUrlAllowed('https://example.com/', { allowedDomains: [], prohibitedDomains: null }));
});

// ---------------------------------------------------------------------------
// Compilation, set mode, and the M3 warning path
// ---------------------------------------------------------------------------

function bulkPolicy(extra: readonly string[]): CompiledDomainPolicy {
	const domains = [...extra];
	for (let index = 0; index < SET_MODE_THRESHOLD; index += 1) domains.push(`host${index}.example.com`);
	return compileDomainPolicy({ allowedDomains: domains }, { onWarn: null });
}

Deno.test('policy: at the set-mode threshold exact hosts move to a Set and globs stay linear', () => {
	const policy = bulkPolicy(['*.glob.test', 'https://scheme.test', 'ported.test:8443', 'root.test']);
	assert(policy.allowed.exactHosts.size >= SET_MODE_THRESHOLD);
	assert(policy.allowed.exactHosts.has('root.test'));
	assertEquals(policy.allowed.rest.length, 3);
	// Set path: exact, plus the www.± variant of a single-dot root.
	assert(isUrlAllowed('https://host7.example.com/', policy));
	assert(isUrlAllowed('https://www.root.test/', policy));
	assertFalse(isUrlAllowed('https://www.host7.example.com/', policy));
	assertFalse(isUrlAllowed('https://unknown.test/', policy));
	// Linear path still evaluated in set mode.
	assert(isUrlAllowed('https://deep.glob.test/', policy));
	assert(isUrlAllowed('https://scheme.test/x', policy));
	assert(isUrlAllowed('https://ported.test:8443/', policy));
	assertFalse(isUrlAllowed('https://ported.test:9/', policy));
	// A non-http(s) scheme never reaches the scheme-less Set.
	assertFalse(isUrlAllowed('chrome-extension://root.test/x', policy));
});

Deno.test('policy: below the threshold the same answers come out of the linear path', () => {
	const small: DomainPolicy = { allowedDomains: ['root.test', '*.glob.test'] };
	assert(isUrlAllowed('https://root.test/', small));
	assert(isUrlAllowed('https://www.root.test/', small));
	assert(isUrlAllowed('https://deep.glob.test/', small));
	assertFalse(isUrlAllowed('https://unknown.test/', small));
	const compiled = compileDomainPolicy(small, { onWarn: null });
	assertEquals(compiled.allowed.exactHosts.size, 0);
	assertEquals(compiled.allowed.rest.length, 2);
});

Deno.test('policy: compilation reports every refused pattern once, through an injected sink', () => {
	const seen: PatternWarning[] = [];
	const policy = compileDomainPolicy(
		{ allowedDomains: ['example.com', '*'], prohibitedDomains: ['ex*mple.com'] },
		{ onWarn: (warning) => seen.push(warning) },
	);
	assertEquals(seen, [
		{ source: 'allowedDomains', pattern: '*', reason: 'lone-wildcard' },
		{ source: 'prohibitedDomains', pattern: 'ex*mple.com', reason: 'embedded-wildcard' },
	]);
	assertEquals(policy.warnings, seen);
	assertEquals(policy.blockIpAddresses, false);
});

Deno.test('policy: the default sink writes one console warning naming the rule', () => {
	const original = console.warn;
	const lines: string[] = [];
	console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	try {
		compileDomainPolicy({ allowedDomains: ['example.*'] });
		defaultPatternWarnSink({ source: 'sensitiveData', pattern: '*', reason: 'lone-wildcard' });
	} finally {
		console.warn = original;
	}
	assertEquals(lines.length, 2);
	assertStringIncludes(lines[0] ?? '', 'tld-wildcard');
	assertStringIncludes(lines[0] ?? '', '§4.1 M3');
	assertStringIncludes(lines[1] ?? '', 'sensitiveData');
});

Deno.test('policy: a compiled policy is accepted directly and is not recompiled', () => {
	const compiled = compileDomainPolicy({ allowedDomains: ['example.com'] }, { onWarn: null });
	assert(isUrlAllowed('https://example.com/', compiled));
	assertFalse(isUrlAllowed('https://evil.test/', compiled));
});

Deno.test('validatePatterns: reports unsafe scopes for sensitiveData intake', () => {
	const seen: PatternWarning[] = [];
	const warnings = validatePatterns(['https://*.bank.test', 'bank.*'], 'sensitiveData', {
		onWarn: (warning) => seen.push(warning),
	});
	assertEquals(warnings, [{ source: 'sensitiveData', pattern: 'bank.*', reason: 'tld-wildcard' }]);
	assertEquals(seen, warnings);
	// Silent form for callers that report elsewhere.
	assertEquals(validatePatterns(['bank.*'], 'sensitiveData', { onWarn: null }).length, 1);
	assertEquals(validatePatterns(['https://bank.test'], 'sensitiveData', { onWarn: null }).length, 0);
});

// ---------------------------------------------------------------------------
// The §4.2 empty-allowlist precedence trap
// ---------------------------------------------------------------------------

Deno.test.each([
	{
		name: 'empty caller list keeps the configured allowlist',
		configured: ['example.com'],
		incoming: [],
		expected: ['example.com'],
	},
	{ name: 'null caller list keeps it too', configured: ['example.com'], incoming: null, expected: ['example.com'] },
	{
		name: 'undefined caller list keeps it too',
		configured: ['example.com'],
		incoming: undefined,
		expected: ['example.com'],
	},
	{ name: 'non-empty caller list narrows', configured: ['example.com'], incoming: ['a.test'], expected: ['a.test'] },
	{
		name: 'non-empty caller list with nothing configured',
		configured: null,
		incoming: ['a.test'],
		expected: ['a.test'],
	},
	{ name: 'nothing anywhere stays null', configured: undefined, incoming: undefined, expected: null },
])('precedence-trap: $name', (row) => {
	assertEquals(resolveAllowedDomains(row.configured, row.incoming), row.expected);
});
