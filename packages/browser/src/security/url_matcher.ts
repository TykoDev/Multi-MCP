/**
 * @module
 * URL matcher + navigation domain policy — the security-critical primitive of `@tykotech/browser`.
 *
 * Owns the matching rules (fail closed, new-tab URLs, unsafe-pattern refusal, scheme scoping,
 * wildcards, bare domains, origin patterns, IP literals, parse-not-string-match), `isUrlAllowed`
 * with its evaluation order and the empty-allowlist precedence trap, and serves the three
 * enforcement points E1/E2/E3.
 * Every arm below is reachable from `url_matcher_test.ts`, which holds it to **100 % branch
 * coverage**; no defensive-unreachable arms are written.
 *
 * Two properties this module MUST keep, both load-bearing elsewhere:
 *
 * 1. **Pure and side-effect-free.** A throwing bus handler does
 *    not abort its siblings, so `SecurityWatchdog` throwing cannot by itself stop a navigation:
 *    BOTH the watchdog (E1/E2) and `BrowserSession.onNavigateToUrlEvent` call `isUrlAllowed`. The
 *    matcher, not handler-registration order, is the enforcement point — so it does no logging, no
 *    caching and no I/O on the decision path. Warnings are emitted once, at policy *compile* time.
 * 2. **Parse, never string-match.** Every host decision goes through the WHATWG `URL` parser,
 *    which is also what Chrome uses — so "what the matcher thinks the host is" and "what the browser will
 *    resolve" cannot drift (`http://allowed.example@evil.test/` ⇒ host `evil.test`;
 *    `http://0xd83ad60e/` ⇒ host `216.58.214.14`). Regexes appear only on *patterns* (trusted
 *    config) and on strings the URL parser has already canonicalised.
 *
 * Normalisation asymmetry (deliberate, security-relevant): NFKC folding is applied **only** in the
 * IP-literal detection of `isUrlAllowed` step 4, where extra folding can only ever block *more* traffic. It is
 * NOT applied to host comparison, where folding a spoofed host (`ｅxample.com` → `example.com`)
 * would *widen* an allowlist. Host comparison relies on the URL parser's own IDNA/UTS-46 mapping,
 * which is the mapping the browser will actually resolve with.
 */

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/**
 * Which scheme set a scheme-less pattern covers.
 * - `navigation` — navigation policy and action-model domain filtering: `http:` and `https:`.
 * - `secret` — `sensitiveData` scoping: `https:` only. Secrets over plaintext HTTP require an
 *   explicit `http://` pattern.
 */
export type UrlMatchContext = 'navigation' | 'secret';

/**
 * Why a pattern was refused at configuration time: an unsafe wildcard shape, or a "domain" that
 * carries a path, query, fragment, userinfo or whitespace.
 */
export type PatternRejectionReason =
	| 'empty'
	| 'lone-wildcard'
	| 'multiple-wildcards'
	| 'embedded-wildcard'
	| 'tld-wildcard'
	| 'scheme-wildcard'
	| 'path-or-credentials'
	| 'unparseable';

/** A pattern that survived refusal, reduced to the three things matching depends on. */
export type ParsedPattern = {
	/** The trimmed pattern text, for diagnostics. */
	readonly source: string;
	/** Lowercase scheme without the colon, or `null` for a scheme-less pattern. */
	readonly scheme: string | null;
	/** Canonical lowercase host; for a wildcard pattern, the base after `*.`. */
	readonly host: string;
	/** `true` for the one safe wildcard shape, a leading `*.`. */
	readonly wildcard: boolean;
	/** Pinned port as decimal text, or `null` when the pattern ignores the port. */
	readonly port: string | null;
};

export type PatternParseResult =
	| { readonly ok: true; readonly pattern: ParsedPattern }
	| { readonly ok: false; readonly reason: PatternRejectionReason };

/** A refused pattern, reported once at compile time as a warning. */
export type PatternWarning = {
	/** Which list the pattern came from, e.g. `allowedDomains`. */
	readonly source: string;
	readonly pattern: string;
	readonly reason: PatternRejectionReason;
};

export type WarnSink = (warning: PatternWarning) => void;

/** Options for {@linkcode compileDomainPolicy} / {@linkcode validatePatterns}. */
export type CompileOptions = {
	/** Omit for the default `console.warn` sink; pass `null` for a fully silent compile. */
	readonly onWarn?: WarnSink | null;
};

/** The three `BrowserProfile` inputs of the domain policy. */
export type DomainPolicy = {
	readonly allowedDomains?: readonly string[] | null;
	readonly prohibitedDomains?: readonly string[] | null;
	readonly blockIpAddresses?: boolean;
};

/** One compiled list: exact hostnames in a `Set` once the list is large, globs stay linear. */
export type CompiledList = {
	/** Populated only in set mode; scheme-less, port-less, non-wildcard patterns land here. */
	readonly exactHosts: ReadonlySet<string>;
	/** Everything else, matched linearly. */
	readonly rest: readonly ParsedPattern[];
	/** `true` iff the *configured* list was empty — refused patterns do NOT make a list empty. */
	readonly empty: boolean;
};

export type CompiledDomainPolicy = {
	readonly compiled: true;
	readonly blockIpAddresses: boolean;
	readonly allowed: CompiledList;
	readonly prohibited: CompiledList;
	readonly warnings: readonly PatternWarning[];
};

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/**
 * The new-tab URLs. Exactly these five, compared case-insensitively after trimming. The list is deliberately
 * literal: `isUrlAllowed` step 1 *allows* new-tab URLs, so broadening this set would widen
 * navigation permission, while `urlMatch` returning `false` for them is what keeps a fresh tab from
 * satisfying a secrets scope or a domain-gated action filter.
 */
export const NEW_TAB_URLS: readonly string[] = [
	'about:blank',
	'chrome://new-tab-page',
	'chrome://new-tab-page/',
	'chrome://newtab',
	'chrome://newtab/',
];

const NEW_TAB_SET: ReadonlySet<string> = new Set(NEW_TAB_URLS);

/**
 * At or above this many entries a list compiles its exact hostnames to a `Set`, for lookup speed.
 *
 * Glob patterns stay in the linear path and are always evaluated: a policy whose *meaning* changes
 * when an unrelated 100th entry is added is not a policy.
 */
export const SET_MODE_THRESHOLD = 100;

/** Schemes allowed to a scheme-less pattern, per context. */
const NAVIGATION_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
const SECRET_SCHEMES: ReadonlySet<string> = new Set(['https:']);

/** WHATWG special schemes whose default port `URL` elides, so a pinned port still compares. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
	'http:': '80',
	'https:': '443',
	'ws:': '80',
	'wss:': '443',
	'ftp:': '21',
};

/** Applied to *patterns* only — trusted configuration text, never to a URL. */
const SCHEME_SHAPE = /^[a-z][a-z0-9+.-]*$/;
const PORT_SHAPE = /^[0-9]{1,5}$/;

/**
 * Characters that make a "domain pattern" something else: a path, a query, a fragment, userinfo, or
 * whitespace. Such a pattern is refused rather than silently reduced to its host, because the
 * operator meant something narrower than "the whole host".
 */
const NON_HOST_CHARS: readonly string[] = ['/', '\\', '?', '#', '@', ' ', '\t'];

/** Ideographic full stops UTS-46 maps to `.` but NFKC does not, so they are folded explicitly. */
const IDEOGRAPHIC_DOTS: readonly string[] = ['。', '｡'];

/** Applied to a hostname the URL parser has already canonicalised, never to raw input. */
const CANONICAL_IPV4 = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;

// ---------------------------------------------------------------------------
// host canonicalisation
// ---------------------------------------------------------------------------

/**
 * Lowercases and drops the FQDN root dot.
 *
 * `new URL('http://evil.com./').hostname` is `evil.com.`, which would compare unequal to the
 * pattern `evil.com` — a silent `prohibitedDomains` bypass — so the root dot is stripped.
 */
export function canonicalHost(hostname: string): string {
	const lower = hostname.toLowerCase();
	return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * `www.example.com` ⇒ `example.com`, but only for a single-dot root pattern.
 *
 * Only the stripping direction is implemented. The *adding* direction, under which the pattern
 * `www.example.com` would match the host `example.com`, widens beyond the bare-domain rule and
 * would make set mode disagree with the linear path; with stripping only, both paths are
 * equivalent.
 */
function wwwStripped(host: string): string | null {
	if (!host.startsWith('www.')) return null;
	const root = host.slice(4);
	return isSingleDotRoot(root) ? root : null;
}

/** A "single-dot root pattern": exactly two labels, e.g. `example.com`. */
function isSingleDotRoot(host: string): boolean {
	return host.split('.').length === 2;
}

// ---------------------------------------------------------------------------
// IP-literal detection (`isUrlAllowed` step 4)
// ---------------------------------------------------------------------------

function percentDecode(text: string): string {
	if (!text.includes('%')) return text;
	try {
		return decodeURIComponent(text);
	} catch {
		// Malformed percent-escape: keep the raw text. It cannot become an IP literal either way.
		return text;
	}
}

/**
 * Percent-decode → NFKC → ideographic-dot fold → lowercase → drop the FQDN root dot.
 *
 * Unicode digits and ideographic dots must fold before the IP check. NFKC alone folds fullwidth
 * digits (`１` ⇒ `1`) and `U+FF0E` (`．` ⇒ `.`) but leaves `U+3002` (`。`) and `U+FF61` (`｡`)
 * untouched, which UTS-46 (and so the browser) maps to `.` — hence the explicit fold.
 */
export function normalizeHostForIpCheck(host: string): string {
	let text = percentDecode(host.trim()).normalize('NFKC');
	for (const dot of IDEOGRAPHIC_DOTS) text = text.replaceAll(dot, '.');
	const lower = text.toLowerCase();
	return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * The canonical IP literal a host denotes, or `null` when it denotes a name.
 *
 * Decimal (`3232235777`), hex (`0xC0A80101`), octal (`0300.0250.0.1`) and short dotted (`192.168.1`)
 * IPv4 forms plus every IPv6 spelling are decided by the WHATWG host parser itself — deliberately,
 * because "is this an IP" must mean "will the browser dial an IP", and no re-implementation of
 * `inet_aton` can promise that.
 */
export function ipLiteralOf(host: string): string | null {
	const normalized = normalizeHostForIpCheck(host);
	if (normalized === '') return null;
	const bracketed = normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
	const parsed = URL.parse(`https://${bracketed}`);
	if (parsed === null) return null;
	if (parsed.hostname.startsWith('[')) return parsed.hostname;
	return CANONICAL_IPV4.test(parsed.hostname) ? parsed.hostname : null;
}

/** Whether a host denotes an IP literal (`isUrlAllowed` step 4, and the IP-literal matching rule). */
export function isIpLiteralHost(host: string): boolean {
	return ipLiteralOf(host) !== null;
}

// ---------------------------------------------------------------------------
// pattern parsing and refusal
// ---------------------------------------------------------------------------

function reject(reason: PatternRejectionReason): PatternParseResult {
	return { ok: false, reason };
}

function countChar(text: string, needle: string): number {
	let count = 0;
	for (const char of text) {
		if (char === needle) count += 1;
	}
	return count;
}

type HostPort = { readonly host: string; readonly port: string | null };

function validPort(host: string, port: string): HostPort | null {
	if (!PORT_SHAPE.test(port)) return null;
	const value = Number(port);
	if (value < 1 || value > 65535) return null;
	return { host, port: String(value) };
}

/** Splits an authority into host and optional pinned port, keeping IPv6 literals intact. */
function splitPort(authority: string): HostPort | null {
	if (authority.startsWith('[')) {
		const end = authority.indexOf(']');
		if (end < 0) return null;
		const tail = authority.slice(end + 1);
		if (tail === '') return { host: authority, port: null };
		if (!tail.startsWith(':')) return null;
		return validPort(authority.slice(0, end + 1), tail.slice(1));
	}
	const colons = countChar(authority, ':');
	if (colons === 0) return { host: authority, port: null };
	// Two or more colons and no brackets: an unbracketed IPv6 literal, which pins no port.
	if (colons > 1) return { host: `[${authority}]`, port: null };
	const index = authority.indexOf(':');
	return validPort(authority.slice(0, index), authority.slice(index + 1));
}

/**
 * Canonicalises a pattern host through the URL parser, using the pattern's own scheme so the
 * pattern and the URL are canonicalised by identical rules (special schemes get IDNA + IPv4
 * folding; opaque schemes do not).
 */
function canonicalizePatternHost(host: string, scheme: string | null): string | null {
	const wrapper = scheme === null ? 'https' : scheme;
	const parsed = URL.parse(`${wrapper}://${host}`);
	if (parsed === null) return null;
	const canonical = canonicalHost(parsed.hostname);
	return canonical === '' ? null : canonical;
}

/**
 * The **only** safe wildcard shape is a leading `*.` on the host; everything else is refused at
 * configuration time and matches nothing. There is no "warn but allow".
 *
 * Note (deliberate, not a gap): `*.com` is honoured, because the refusal list covers multiple,
 * embedded, TLD-position and lone wildcards but not a wildcard over a public suffix. It over-matches
 * exactly as widely as its author asked it to.
 */
export function parsePattern(pattern: string): PatternParseResult {
	const raw = pattern.trim();
	if (raw === '') return reject('empty');

	const schemeEnd = raw.indexOf('://');
	const scheme = schemeEnd < 0 ? null : raw.slice(0, schemeEnd).toLowerCase();
	const authority = schemeEnd < 0 ? raw : raw.slice(schemeEnd + 3);
	if (scheme !== null) {
		if (scheme.includes('*')) return reject('scheme-wildcard');
		if (!SCHEME_SHAPE.test(scheme)) return reject('unparseable');
	}

	if (authority === '*') return reject('lone-wildcard');
	const wildcards = countChar(authority, '*');
	if (wildcards > 1) return reject('multiple-wildcards');
	if (authority.endsWith('.*')) return reject('tld-wildcard');
	const wildcard = wildcards === 1;
	if (wildcard && !authority.startsWith('*.')) return reject('embedded-wildcard');

	const afterWildcard = wildcard ? authority.slice(2) : authority;
	const hostText = afterWildcard.endsWith('/') ? afterWildcard.slice(0, -1) : afterWildcard;
	if (hostText === '') return reject('empty');
	for (const char of NON_HOST_CHARS) {
		if (hostText.includes(char)) return reject('path-or-credentials');
	}

	const split = splitPort(hostText);
	if (split === null) return reject('unparseable');
	const host = canonicalizePatternHost(split.host, scheme);
	if (host === null) return reject('unparseable');
	return { ok: true, pattern: { source: raw, scheme, host, wildcard, port: split.port } };
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

/** A freshly opened tab satisfies no pattern, in any context. */
export function isNewTabUrl(url: string): boolean {
	return NEW_TAB_SET.has(url.trim().toLowerCase());
}

/** A scheme-less pattern is context-scoped; a scheme-qualified one matches exactly. */
function schemeMatches(protocol: string, scheme: string | null, context: UrlMatchContext): boolean {
	if (scheme !== null) return protocol === `${scheme}:`;
	return context === 'secret' ? SECRET_SCHEMES.has(protocol) : NAVIGATION_SCHEMES.has(protocol);
}

/** A pinned port compares against the URL's effective port, default ports included. */
function effectivePort(url: URL): string {
	if (url.port !== '') return url.port;
	return DEFAULT_PORTS[url.protocol] ?? '';
}

/** Wildcard: any depth of subdomain, plus the bare base — but never an IP-literal host. */
function hostMatchesWildcard(host: string, base: string): boolean {
	if (isIpLiteralHost(host)) return false;
	return host === base || host.endsWith(`.${base}`);
}

/** Bare domain: exact host, plus the `www.` variant of a single-dot root pattern. */
function hostMatchesExact(host: string, patternHost: string): boolean {
	if (host === patternHost) return true;
	return isSingleDotRoot(patternHost) && host === `www.${patternHost}`;
}

function matchesParsed(url: URL, host: string, pattern: ParsedPattern, context: UrlMatchContext): boolean {
	if (!schemeMatches(url.protocol, pattern.scheme, context)) return false;
	if (pattern.port !== null && effectivePort(url) !== pattern.port) return false;
	return pattern.wildcard ? hostMatchesWildcard(host, pattern.host) : hostMatchesExact(host, pattern.host);
}

/**
 * The shared URL-matching primitive — navigation policy, action-model domain filtering and secret
 * scoping all call this and nothing else.
 *
 * Fails closed on an empty, unparseable or host-less URL, on a new-tab URL and on an unsafe
 * pattern.
 */
export function urlMatch(url: string, pattern: string, context: UrlMatchContext = 'navigation'): boolean {
	if (isNewTabUrl(url)) return false;
	const parsed = URL.parse(url);
	if (parsed === null) return false;
	const result = parsePattern(pattern);
	if (!result.ok) return false;
	const host = canonicalHost(parsed.hostname);
	if (host === '') return false;
	return matchesParsed(parsed, host, result.pattern, context);
}

// ---------------------------------------------------------------------------
// policy compilation
// ---------------------------------------------------------------------------

/** The default refused-pattern warning sink. Configuration-time only — never on the decision path. */
export const defaultPatternWarnSink: WarnSink = (warning) => {
	console.warn(
		`[bua:url-matcher] ignoring unsafe pattern ${JSON.stringify(warning.pattern)} ` +
			`in ${warning.source}: ${warning.reason}`,
	);
};

function warnSinkOf(options: CompileOptions): WarnSink | null {
	return options.onWarn === undefined ? defaultPatternWarnSink : options.onWarn;
}

function compileList(
	patterns: readonly string[] | null | undefined,
	source: string,
	warn: WarnSink,
): CompiledList {
	const list = patterns ?? [];
	const exactHosts = new Set<string>();
	const rest: ParsedPattern[] = [];
	const setMode = list.length >= SET_MODE_THRESHOLD;
	for (const raw of list) {
		const result = parsePattern(raw);
		if (!result.ok) {
			warn({ source, pattern: raw, reason: result.reason });
			continue;
		}
		const parsed = result.pattern;
		const exact = parsed.scheme === null && !parsed.wildcard && parsed.port === null;
		if (setMode && exact) exactHosts.add(parsed.host);
		else rest.push(parsed);
	}
	// Emptiness is a property of the *configured* list: an allowlist of nothing but refused patterns
	// must deny everything, not silently degrade to "no restriction".
	return { exactHosts, rest, empty: list.length === 0 };
}

/**
 * Compiles a policy once, reporting every refused pattern. Call this at configuration time and
 * cache the result on the session: `isUrlAllowed` accepts the compiled form and is then allocation-
 * free, which matters because it runs twice per navigation (watchdog and session).
 */
export function compileDomainPolicy(policy: DomainPolicy, options: CompileOptions = {}): CompiledDomainPolicy {
	const sink = warnSinkOf(options);
	const warnings: PatternWarning[] = [];
	const record: WarnSink = (warning) => {
		warnings.push(warning);
		if (sink !== null) sink(warning);
	};
	return {
		compiled: true,
		blockIpAddresses: policy.blockIpAddresses === true,
		allowed: compileList(policy.allowedDomains, 'allowedDomains', record),
		prohibited: compileList(policy.prohibitedDomains, 'prohibitedDomains', record),
		warnings,
	};
}

/**
 * Validates a pattern list without building a policy — the `sensitiveData` intake path and the
 * action registry's `domains` field use this so an unsafe scope is reported where it is configured.
 */
export function validatePatterns(
	patterns: readonly string[],
	source: string,
	options: CompileOptions = {},
): readonly PatternWarning[] {
	const sink = warnSinkOf(options);
	const warnings: PatternWarning[] = [];
	for (const pattern of patterns) {
		const result = parsePattern(pattern);
		if (result.ok) continue;
		const warning: PatternWarning = { source, pattern, reason: result.reason };
		warnings.push(warning);
		if (sink !== null) sink(warning);
	}
	return warnings;
}

function isCompiled(policy: DomainPolicy | CompiledDomainPolicy): policy is CompiledDomainPolicy {
	return (policy as Partial<CompiledDomainPolicy>).compiled === true;
}

function listMatches(list: CompiledList, url: URL, host: string, context: UrlMatchContext): boolean {
	// Set-mode entries are scheme-less by construction, so they inherit the context's scheme set.
	if (schemeMatches(url.protocol, null, context)) {
		if (list.exactHosts.has(host)) return true;
		const root = wwwStripped(host);
		if (root !== null && list.exactHosts.has(root)) return true;
	}
	for (const pattern of list.rest) {
		if (matchesParsed(url, host, pattern, context)) return true;
	}
	return false;
}

/**
 * The navigation domain policy, evaluated in this order:
 *
 * 1. `about:blank` / chrome new-tab ⇒ allow (the agent must always be able to park on a blank tab;
 *    `urlMatch` separately guarantees these unlock no secrets).
 * 2. `data:` / `blob:` ⇒ allow (in-page artifacts, no network origin).
 * 3. No hostname ⇒ deny. Unparseable URLs land here too (fail closed).
 * 4. `blockIpAddresses` ⇒ deny IP-literal hosts including obfuscated encodings.
 * 5. `allowedDomains` non-empty ⇒ allow iff some pattern matches (`prohibitedDomains` ignored).
 * 6. Else `prohibitedDomains` non-empty ⇒ deny iff some pattern matches.
 * 7. Else allow.
 *
 * Pure and side-effect-free: it is called from `SecurityWatchdog` *and* from
 * `BrowserSession.onNavigateToUrlEvent` for the same navigation.
 */
export function isUrlAllowed(url: string, policy: DomainPolicy | CompiledDomainPolicy): boolean {
	const compiled = isCompiled(policy) ? policy : compileDomainPolicy(policy, { onWarn: null });
	if (isNewTabUrl(url)) return true;
	const parsed = URL.parse(url);
	if (parsed === null) return false;
	if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
	const host = canonicalHost(parsed.hostname);
	if (host === '') return false;
	if (compiled.blockIpAddresses && isIpLiteralHost(host)) return false;
	if (!compiled.allowed.empty) return listMatches(compiled.allowed, parsed, host, 'navigation');
	if (!compiled.prohibited.empty) return !listMatches(compiled.prohibited, parsed, host, 'navigation');
	return true;
}

/**
 * The empty-allowlist precedence trap, as a function so no caller has to remember it: an **empty**
 * `allowedDomains` from a caller (MCP tool args, server task body) means "no restriction downstream"
 * and MUST NOT override a configured non-empty allowlist. Only a non-empty caller list may
 * narrow/replace it.
 */
export function resolveAllowedDomains(
	configured: readonly string[] | null | undefined,
	incoming: readonly string[] | null | undefined,
): readonly string[] | null {
	if (incoming !== null && incoming !== undefined && incoming.length > 0) return incoming;
	return configured ?? null;
}
