/**
 * `browser_head` as a cookie-less, server-side HEAD, gated at every hop — the only outbound request this server makes
 * of its own.
 * No credential is copied (`credentials: 'omit'`, no headers); redirects are walked by hand with a cap; every hop
 * passes `assertNavigable`, a literal-address deny no allowlist lifts, and a permission query. Nothing is resolved
 * through DNS to inspect it: rebinding makes that unsound, so private names are the allowlist's job.
 */
import { assertNavigable, canonicalHost, originOf, ToolError } from './errors.ts';
import { navigationTarget } from './events.ts';

/** Redirect hops followed before the walk stops. A chain longer than this is a loop or a lure. */
export const HEAD_MAX_HOPS = 10;

/** Per-hop budget. The tree's wait convention (`WAIT_FOR_DEFAULT_TIMEOUT_MS`) is 10 s; one request gets the same. */
const HEAD_HOP_TIMEOUT_MS = 10_000;

/** Whole-walk budget: three full hops' worth, so a slow chain cannot hold a tool call open indefinitely. */
const HEAD_TOTAL_TIMEOUT_MS = 30_000;

/** Header values are server-chosen text; each is capped here and at most this many are considered. */
const HEADER_VALUE_CAP = 512;
const HEADER_COUNT_CAP = 64;
const FILENAME_CAP = 255;
/** A `Location` longer than a URL argument may be is a lure, not a redirect. */
const LOCATION_CAP = 2048;

/** Walks in flight at once, process-wide. */
const HEAD_MAX_IN_FLIGHT = 4;
let inFlight = 0;

/** Only these statuses, and only with a `Location`, are hops. 300 and 304 are answers. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Why an outbound request failed, as a closed vocabulary. */
const HEAD_FAILURE_REASONS = [
	'dns',
	'refused',
	'reset',
	'tls',
	'protocol',
	'bad-port',
	'proxy',
	'unknown',
] as const;
type HeadFailureReason = (typeof HEAD_FAILURE_REASONS)[number];

/** What `browser_head` returns: metadata only, never a header echo, never a body. */
interface HeadResult {
	readonly status: number;
	readonly content_type: string | null;
	/** `null` when the final response carried no `Content-Length` — never a guess. */
	readonly content_length: number | null;
	/** From `Content-Disposition`, decoded and sanitised, or `null`. */
	readonly filename: string | null;
	/** Origin plus path of the final response. No query, no fragment: either can carry a token. */
	readonly final_url: string;
	/** Redirects followed. `0` when the first response was final. */
	readonly hops: number;
}

/** Injected so the unit tier can drive the walk without the network; production passes nothing. */
interface HeadOptions {
	readonly fetch?: typeof fetch;
	readonly permissions?: { query(desc: Deno.NetPermissionDescriptor): Promise<{ state: Deno.PermissionState }> };
	readonly hopTimeoutMs?: number;
	readonly maxHops?: number;
	/** The calling tool's cancellation; it ends the wait for a slot and the request in flight. */
	readonly signal?: AbortSignal;
}

/**
 * Issues the HEAD walk. Every hop, including the first, is gated in this order: allowlist, literal-address deny,
 * permission query.
 */
export async function headWalk(
	rawUrl: string,
	allowedDomains: readonly string[],
	options: HeadOptions = {},
): Promise<HeadResult> {
	const doFetch = options.fetch ?? fetch;
	const permissions = options.permissions ?? Deno.permissions;
	const maxHops = options.maxHops ?? HEAD_MAX_HOPS;
	const deadline = AbortSignal.timeout(HEAD_TOTAL_TIMEOUT_MS);
	const overall = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
	options.signal?.throwIfAborted();

	let url = gateHop(rawUrl, allowedDomains);
	let hops = 0;
	await acquireSlot(overall);
	try {
		return await walk();
	} finally {
		inFlight -= 1;
	}

	async function walk(): Promise<HeadResult> {
		for (;;) {
			await assertGranted(url, permissions);
			let response: Response;
			try {
				const signal = AbortSignal.any([overall, AbortSignal.timeout(options.hopTimeoutMs ?? HEAD_HOP_TIMEOUT_MS)]);
				// The one outbound request this server makes. `headers: {}` is the whole credential policy: nothing
				// of the caller's, nothing of the browser's, nothing of this process's is forwarded.
				response = await doFetch(url.href, {
					method: 'HEAD',
					redirect: 'manual',
					credentials: 'omit',
					headers: {},
					signal,
				});
			} catch (cause) {
				throw mapFetchFailure(cause, url);
			}
			// A HEAD has no body by protocol and Deno hands back `null`; a runtime
			// that ever attached one would still have it cancelled here, unread.
			await response.body?.cancel().catch(() => {});

			const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
			if (location === null) {
				return finalResult(response, url, hops);
			}
			hops += 1;
			if (hops > maxHops) {
				throw new ToolError('browser-error', `the redirect chain exceeded ${maxHops} hops`);
			}
			// Parsed before it is gated, so a malformed value is never echoed: the text is the upstream's. Whitespace
			// inside is what two joined `Location` headers look like, and that is not a redirect either.
			const trimmed = location.trim();
			const next = trimmed.length > LOCATION_CAP || /\s/.test(trimmed) ? null : URL.parse(trimmed, url);
			if (next === null) {
				throw new ToolError('browser-error', 'the server answered with a redirect whose Location is not a URL');
			}
			// Gated exactly as the first hop was. A hop that fails names only the
			// origin it was refused for — never the Location's path or query.
			url = gateHop(next.href, allowedDomains);
		}
	}
}

/** Waits for one of the in-flight slots; the wait is charged to the overall budget. */
async function acquireSlot(overall: AbortSignal): Promise<void> {
	while (inFlight >= HEAD_MAX_IN_FLIGHT) {
		if (overall.aborted) throw new ToolError('timeout', 'too many head requests are in flight; try again');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	inFlight += 1;
}

/** The policy gate for one hop: allowlist first, then the literal-address deny. */
export function gateHop(rawUrl: string, allowedDomains: readonly string[]): URL {
	let url: URL;
	try {
		url = assertNavigable(rawUrl, allowedDomains);
	} catch (cause) {
		// The predicate names the host; a hop names its origin, and only that.
		if (cause instanceof ToolError && cause.message.includes('allowed-domain list')) {
			throw new ToolError('navigation-blocked', `${originOf(rawUrl)} is not in the server's allowed-domain list`);
		}
		throw cause;
	}
	if (url.username !== '' || url.password !== '') {
		throw new ToolError('invalid-arguments', 'a URL carrying credentials is not accepted');
	}
	if (isForbiddenLiteralHost(url.hostname, allowedDomains)) {
		throw new ToolError(
			'navigation-blocked',
			`${url.origin} is a loopback, private or link-local address; name that exact host in TTK_ALLOWED_DOMAINS to allow it`,
		);
	}
	// A non-default port needs an exact `host:port` entry: the allowlist predicate ignores ports, and a bare-host
	// grant covers every port, so without this rule an allowlisted name would offer every service behind it.
	if (
		url.port !== '' && !allowedDomains.some((entry) => entry.trim().toLowerCase() === `${url.hostname}:${url.port}`)
	) {
		throw new ToolError(
			'navigation-blocked',
			`${url.origin} uses a non-default port; name host:port exactly in TTK_ALLOWED_DOMAINS to allow it`,
		);
	}
	return url;
}

/**
 * Whether a hostname is a literal loopback, private, link-local, CGNAT, unspecified or reserved address, or
 * `localhost`, **and** is not named exactly in the allowlist.
 */
export function isForbiddenLiteralHost(hostname: string, allowedDomains: readonly string[]): boolean {
	const host = canonicalHost(hostname) ?? hostname.toLowerCase();
	if (allowedDomains.some((entry) => canonicalHost(entry) === host)) return false;
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host.startsWith('[') && host.endsWith(']')) {
		const bytes = parseIpv6(host.slice(1, -1));
		return bytes === null ? true : isForbiddenIpv6(bytes);
	}
	const v4 = parseIpv4(host);
	return v4 === null ? false : isForbiddenIpv4(v4);
}

/** Whether this process may open a socket to the hop's exact `host:port`. */
async function assertGranted(url: URL, permissions: NonNullable<HeadOptions['permissions']>): Promise<void> {
	const descriptor = `${url.hostname}:${portOf(url)}`;
	let state: Deno.PermissionState;
	try {
		state = (await permissions.query({ name: 'net', host: descriptor })).state;
	} catch {
		state = 'denied';
	}
	if (state !== 'granted') {
		throw new ToolError(
			'feature-unavailable',
			`the operator has not granted this server outbound net access to ${descriptor}; ` +
				'widen --allow-net in the deployment command to allow it',
			{ feature: 'egress' },
		);
	}
}

/**
 * Whether the deployment can offer `browser_head` at all: an outbound grant beyond loopback, **proven** through the
 * permissions API at startup.
 */
export async function probeEgressGrant(
	allowedDomains: readonly string[],
	permissions: NonNullable<HeadOptions['permissions']> = Deno.permissions,
): Promise<boolean> {
	const granted = async (desc: Deno.NetPermissionDescriptor): Promise<boolean> => {
		try {
			return (await permissions.query(desc)).state === 'granted';
		} catch {
			return false;
		}
	};
	if (await granted({ name: 'net' })) return true;
	for (const entry of allowedDomains) {
		const host = canonicalHost(entry);
		if (host === null) continue;
		// "Beyond loopback" literally: a private or loopback literal on the allowlist proves nothing here, because
		// the shipped matrices already grant `127.0.0.1` for the browser connection and that grant is not an election
		// of outbound net.
		if (isForbiddenLiteralHost(host, [])) continue;
		if (await granted({ name: 'net', host: `${host}:443` })) return true;
		if (await granted({ name: 'net', host: `${host}:80` })) return true;
	}
	return false;
}

/** The Chromium flags that decide where the **browser's** traffic goes. */
export const CHROMIUM_PROXY_FLAGS = [
	'--proxy-server',
	'--proxy-pac-url',
	'--proxy-auto-detect',
	'--no-proxy-server',
	'--proxy-bypass-list',
] as const;

/** The proxy flag `TTK_BROWSER_ARGS` gives Chromium, by **name only** (a value can carry credentials), or `null`. */
export function browserProxyFlag(browserArgs: readonly string[]): string | null {
	for (const arg of browserArgs) {
		const name = arg.split('=', 1)[0]?.trim() ?? '';
		if ((CHROMIUM_PROXY_FLAGS as readonly string[]).includes(name)) return name;
	}
	return null;
}

/**
 * Why `browser_head` must refuse in this deployment, or `null` when it may run.
 * Deno's `fetch` follows the `HTTP(S)_PROXY` environment even when the process may not read it, so once
 * `TTK_BROWSER_ARGS` routes Chromium through a proxy the two egress paths cannot be shown to agree: refuse.
 */
export function headRoutingRefusal(browserArgs: readonly string[]): string | null {
	const flag = browserProxyFlag(browserArgs);
	if (flag === null) return null;
	return `browser_head is refused because this deployment routes the browser and this server separately: ` +
		`TTK_BROWSER_ARGS gives Chromium ${flag}, which this server's own HEAD request cannot follow — it is a ` +
		`server-side fetch and follows the process HTTP_PROXY/HTTPS_PROXY/NO_PROXY environment instead. ` +
		`Answering would describe a different network path from the one the browser uses. Configure the proxy in ` +
		`one place: give this process the proxy environment and remove ${flag} from TTK_BROWSER_ARGS, or bound both ` +
		`paths with a network-level egress control and configure neither here.`;
}

/** The allowlist entries that are private or loopback literals — an operator warning at startup. */
export function privateLiteralEntries(allowedDomains: readonly string[]): string[] {
	return allowedDomains.filter((entry) => {
		const host = canonicalHost(entry);
		return host !== null && isForbiddenLiteralHost(host, []);
	});
}

function finalResult(response: Response, url: URL, hops: number): HeadResult {
	const headers = boundedHeaders(response.headers);
	const target = navigationTarget(url.href);
	return {
		status: response.status,
		content_type: headers.get('content-type') ?? null,
		content_length: parseLength(headers.get('content-length')),
		filename: dispositionFilename(headers.get('content-disposition')),
		final_url: `${target.origin}${target.path}`,
		hops,
	};
}

function mapFetchFailure(cause: unknown, url: URL): ToolError {
	if (cause instanceof Deno.errors.NotCapable) {
		return new ToolError(
			'feature-unavailable',
			`the operator has not granted this server outbound net access to ${url.hostname}:${portOf(url)}`,
			{ feature: 'egress' },
		);
	}
	if (cause instanceof DOMException && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
		return new ToolError('timeout', `${url.origin} did not answer within the head request budget`);
	}
	if (cause instanceof ToolError) return cause;
	// The message names the origin, which the caller (or, after a hop, the allowlist) chose, and a closed reason; the
	// runtime's own text can carry the full URL it dialled, so it is classified and never forwarded.
	return new ToolError('browser-error', `the request to ${url.origin} failed: ${failureReason(cause)}`);
}

/** How many errors of a `cause` chain {@linkcode failureReason} reads, the top one included. */
export const FAILURE_CAUSE_DEPTH = 5;

/** Classifies a runtime failure into {@linkcode HEAD_FAILURE_REASONS}. */
export function failureReason(cause: unknown): HeadFailureReason {
	const parts: string[] = [];
	let current: unknown = cause;
	for (let depth = 0; depth < FAILURE_CAUSE_DEPTH && current instanceof Error; depth++) {
		parts.push(`${current.name}: ${current.message}`);
		current = (current as { cause?: unknown }).cause;
	}
	const text = parts.join(' | ').toLowerCase();
	if (/port \d+ (is|are) blocked/.test(text)) return 'bad-port';
	if (/dns|resolve|name or service not known|nodename nor servname|no such host|getaddrinfo/.test(text)) return 'dns';
	if (/tls|certificate|ssl|handshake/.test(text)) return 'tls';
	if (/proxy/.test(text)) return 'proxy';
	if (/refused|actively refused/.test(text)) return 'refused';
	if (/reset|broken pipe|connection closed|eof|aborted/.test(text)) return 'reset';
	if (/http|header|protocol|parse|invalid|malformed|too large|fetch failed/.test(text)) return 'protocol';
	return 'unknown';
}

function portOf(url: URL): string {
	if (url.port !== '') return url.port;
	return url.protocol === 'https:' ? '443' : '80';
}

/** Only the three headers the result is built from, each capped. Nothing else is read. */
function boundedHeaders(headers: Headers): Map<string, string> {
	const out = new Map<string, string>();
	let count = 0;
	for (const [name, value] of headers) {
		if (count >= HEADER_COUNT_CAP) break;
		count += 1;
		const lower = name.toLowerCase();
		if (lower === 'content-type' || lower === 'content-length' || lower === 'content-disposition') {
			out.set(lower, value.slice(0, HEADER_VALUE_CAP));
		}
	}
	return out;
}

/** `content-length` as a number, or `null` — never `NaN`, never a guess. */
function parseLength(value: string | undefined): number | null {
	if (value === undefined) return null;
	if (!/^\d{1,15}$/.test(value.trim())) return null;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** The filename a `Content-Disposition` names, or `null`. */
export function dispositionFilename(header: string | undefined): string | null {
	if (header === undefined) return null;
	let name: string | null = null;
	const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
	if (extended !== null) {
		const charset = (extended[1] ?? '').trim().toLowerCase();
		const encoded = (extended[2] ?? '').trim();
		if (charset === 'utf-8' || charset === 'iso-8859-1' || charset === '') {
			try {
				name = charset === 'iso-8859-1' ? latin1Decode(encoded) : decodeURIComponent(encoded);
			} catch {
				name = null;
			}
		}
	}
	if (name === null) {
		const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
		if (quoted !== null) {
			name = (quoted[1] ?? '').replace(/\\(.)/g, '$1');
		} else {
			const token = /filename\s*=\s*([^;\s]+)/i.exec(header);
			if (token !== null) name = token[1] ?? null;
		}
	}
	if (name === null) return null;
	const segment = name.normalize('NFC').split(/[\\/]/).pop() ?? '';
	// deno-lint-ignore no-control-regex -- control characters are exactly what is being removed.
	const clean = segment.replace(/[\x00-\x1f\x7f"]/g, '').replace(/^[\s.]+/, '').trim().slice(0, FILENAME_CAP);
	return clean === '' ? null : clean;
}

function latin1Decode(encoded: string): string {
	const bytes = encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
	return bytes;
}

// --- address classification ----------------------------------------------------

export function parseIpv4(host: string): number | null {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (match === null) return null;
	let value = 0;
	for (let i = 1; i <= 4; i += 1) {
		const octet = Number(match[i]);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value;
}

/** `true` for the IPv4 ranges the server must never dial on a caller's word. */
export function isForbiddenIpv4(address: number): boolean {
	const a = Math.floor(address / 16_777_216) & 0xff;
	const b = Math.floor(address / 65_536) & 0xff;
	const c = Math.floor(address / 256) & 0xff;
	if (a === 0) return true; // 0.0.0.0/8 — "this network", unspecified
	if (a === 10) return true; // RFC 1918
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local, cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
	if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
	if (a === 192 && b === 168) return true; // RFC 1918
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
	if (a >= 224) return true; // multicast, reserved, broadcast
	return false;
}

/** Sixteen bytes from the bracket-less text, or `null` when it is not an IPv6 literal. */
export function parseIpv6(text: string): Uint8Array | null {
	const lower = text.toLowerCase();
	if (!/^[0-9a-f:.]+$/.test(lower)) return null;
	const halves = lower.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
	const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : [];
	const groups: number[] = [];
	const expand = (parts: string[], into: number[]): boolean => {
		for (let i = 0; i < parts.length; i += 1) {
			const part = parts[i] ?? '';
			if (part.includes('.')) {
				// Embedded dotted IPv4 is only valid as the last two groups.
				if (i !== parts.length - 1) return false;
				const v4 = parseIpv4(part);
				if (v4 === null) return false;
				into.push(Math.floor(v4 / 65_536), v4 % 65_536);
				continue;
			}
			if (part === '' || part.length > 4) return false;
			into.push(parseInt(part, 16));
		}
		return true;
	};
	const tailGroups: number[] = [];
	if (!expand(head, groups) || !expand(tail, tailGroups)) return null;
	const missing = 8 - groups.length - tailGroups.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const all = [...groups, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tailGroups];
	if (all.length !== 8) return null;
	const bytes = new Uint8Array(16);
	all.forEach((group, i) => {
		bytes[i * 2] = group >> 8;
		bytes[i * 2 + 1] = group & 0xff;
	});
	return bytes;
}

export function isForbiddenIpv6(bytes: Uint8Array): boolean {
	const b = (i: number): number => bytes[i] ?? 0;
	const allZeroUpTo = (n: number): boolean => bytes.subarray(0, n).every((byte) => byte === 0);
	// :: and ::1
	if (allZeroUpTo(15) && (b(15) === 0 || b(15) === 1)) return true;
	// ::a.b.c.d (::/96) — the deprecated IPv4-compatible form (RFC 4291 §2.5.5.1), judged as the IPv4 it embeds:
	// `http://[::127.0.0.1]/` normalises to `[::7f00:1]`, and a stack that still honours the form dials loopback.
	if (allZeroUpTo(12)) return isForbiddenIpv4(embeddedIpv4(bytes));
	// ::ffff:a.b.c.d — mapped IPv4, judged as the IPv4 it embeds
	if (allZeroUpTo(10) && b(10) === 0xff && b(11) === 0xff) return isForbiddenIpv4(embeddedIpv4(bytes));
	// ::ffff:0:a.b.c.d — the deprecated SIIT form, likewise
	if (allZeroUpTo(8) && b(8) === 0xff && b(9) === 0xff && b(10) === 0 && b(11) === 0) {
		return isForbiddenIpv4(embeddedIpv4(bytes));
	}
	// 2002:a.b.c.d::/16 — 6to4 embeds the IPv4 in bytes 2..5
	if (b(0) === 0x20 && b(1) === 0x02) {
		return isForbiddenIpv4((b(2) * 16_777_216) + (b(3) * 65_536) + (b(4) * 256) + b(5));
	}
	// 64:ff9b::/96 — NAT64, likewise
	if (
		b(0) === 0x00 && b(1) === 0x64 && b(2) === 0xff && b(3) === 0x9b &&
		bytes.subarray(4, 12).every((byte) => byte === 0)
	) {
		return isForbiddenIpv4(embeddedIpv4(bytes));
	}
	// 64:ff9b:1::/48 — local-use NAT64 (RFC 8215). Refused whole: it is never a public destination, and where
	// its translator puts the IPv4 depends on a prefix length this code cannot know, so it cannot be judged.
	if (
		b(0) === 0x00 && b(1) === 0x64 && b(2) === 0xff && b(3) === 0x9b && b(4) === 0x00 && b(5) === 0x01
	) return true;
	// fe80::/10 link-local
	if (b(0) === 0xfe && (b(1) & 0xc0) === 0x80) return true;
	// fc00::/7 unique local
	if ((b(0) & 0xfe) === 0xfc) return true;
	// ff00::/8 multicast
	if (b(0) === 0xff) return true;
	return false;
}

function embeddedIpv4(bytes: Uint8Array): number {
	return ((bytes[12] ?? 0) * 16_777_216) + ((bytes[13] ?? 0) * 65_536) + ((bytes[14] ?? 0) * 256) + (bytes[15] ?? 0);
}
