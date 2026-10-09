/**
 * `browser_head` as a cookie-less, server-side HEAD, gated at every hop (SR-HEAD-REDIRECT, D-042).
 *
 * This module is the **only** place this server issues an outbound request of
 * its own. Until the owner decision of 2026-09-09 the tool went through the
 * browser (`Network.loadNetworkResource`, E-43), which followed redirects
 * silently, reported no hop and no final URL, and transferred the whole body
 * for a metadata query (U-4: 32 MiB of 32 MiB). Design §8.2 had rejected a
 * server-side `fetch` on three grounds — credential copying, redirect policy,
 * SSRF — and this module answers each explicitly rather than glossing it:
 *
 * - **No credential is copied.** The request carries no cookie, no
 *   `Authorization`, no forwarded header of any kind: `headers: {}` and
 *   `credentials: 'omit'`. A link behind a login answers as an anonymous
 *   client would see it, and the tool's description says so.
 * - **Redirects are explicit.** `redirect: 'manual'`, and every 3xx is walked
 *   by this code, hop by hop, with a cap, each hop gated before it is issued.
 * - **SSRF is a deny, not a hope.** Every hop passes `assertNavigable` against
 *   `TTK_ALLOWED_DOMAINS`, then a literal-address deny that no allowlist suffix
 *   can lift, then `Deno.permissions.query` for the exact `host:port`. Nothing
 *   is resolved through DNS to inspect it: rebinding makes that check unsound,
 *   so a public name that resolves privately is the operator's allowlist
 *   responsibility, and the documentation states it.
 *
 * **Both shipped images grant outbound net since D-151** (owner-approved; the
 * slim binary always did), so in a container the tool is offered and the
 * checks above are what bound it — with `TTK_ALLOWED_DOMAINS` empty by
 * default, the literal-address deny is the only address check that applies, and a name
 * that resolves to a private address (a compose service, a LAN host) is
 * reached. An operator who wants it bounded sets the allowlist, or scopes
 * `--allow-net` back in a compose `command:` override, which hides the tool
 * again. The local `deno task` matrices grant loopback only, so there the tool
 * stays hidden. The process never calls `Deno.permissions.request` — it runs under
 * `DENO_NO_PROMPT` — and a `NotCapable` from the runtime is a coded result,
 * never a crash.
 *
 * ## Two egress paths, and this one refuses rather than diverge (SR3-M2)
 *
 * This request is the **process's**, so it follows the process proxy
 * environment; the browser's is Chromium's, and follows whatever
 * `TTK_BROWSER_ARGS` tells it. When those are configured separately the tool
 * would answer about a different network path from the one the browser uses,
 * which is a wrong answer wearing a correct one's shape. {@linkcode
 * headRoutingRefusal} refuses in exactly that case, and the reasoning — including
 * the measurement that Deno proxies this fetch even when `--allow-env` does not
 * let the process read the variable — is recorded there.
 */
import { assertNavigable, canonicalHost, originOf, ToolError } from './errors.ts';
import { navigationTarget } from './events.ts';

/** Redirect hops followed before the walk stops. A chain longer than this is a loop or a lure. */
export const HEAD_MAX_HOPS = 10;

/** Per-hop budget. The tree's wait convention (`WAIT_FOR_DEFAULT_TIMEOUT_MS`) is 10 s; one request gets the same. */
export const HEAD_HOP_TIMEOUT_MS = 10_000;

/** Whole-walk budget: three full hops' worth, so a slow chain cannot hold a tool call open indefinitely. */
export const HEAD_TOTAL_TIMEOUT_MS = 30_000;

/** Header values are server-chosen text; each is capped here and at most this many are considered. */
const HEADER_VALUE_CAP = 512;
const HEADER_COUNT_CAP = 64;
const FILENAME_CAP = 255;
/** A `Location` longer than a URL argument may be is a lure, not a redirect. */
const LOCATION_CAP = 2048;

/**
 * Walks in flight at once, process-wide (security pre-engagement m4). Without a
 * bound one principal could hold thirty seconds' worth of sockets to every
 * allowlisted host at once and use this server as an existence scanner. A
 * waiter's time counts against the overall budget, so the failure is still
 * `timeout`.
 */
export const HEAD_MAX_IN_FLIGHT = 4;
let inFlight = 0;

/** Only these statuses, and only with a `Location`, are hops (m3). 300 and 304 are answers. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Why an outbound request failed, as a closed vocabulary (security
 * pre-engagement M3). The runtime's own message can carry the full URL it
 * dialled — after a redirect that is upstream-authored text — so it is
 * classified here and never forwarded.
 */
export const HEAD_FAILURE_REASONS = [
	'dns',
	'refused',
	'reset',
	'tls',
	'protocol',
	'bad-port',
	'proxy',
	'unknown',
] as const;
export type HeadFailureReason = (typeof HEAD_FAILURE_REASONS)[number];

/** What `browser_head` returns: metadata only, never a header echo, never a body. */
export interface HeadResult {
	readonly status: number;
	readonly content_type: string | null;
	/** `null` when the final response carried no `Content-Length` — never a guess. */
	readonly content_length: number | null;
	/** From `Content-Disposition`, decoded and sanitised, or `null`. */
	readonly filename: string | null;
	/** Origin plus path of the final response. No query, no fragment (SECURITY-AUTH §8.3). */
	readonly final_url: string;
	/** Redirects followed. `0` when the first response was final. */
	readonly hops: number;
}

/** Injected so the unit tier can drive the walk without the network; production passes nothing. */
export interface HeadOptions {
	readonly fetch?: typeof fetch;
	readonly permissions?: { query(desc: Deno.NetPermissionDescriptor): Promise<{ state: Deno.PermissionState }> };
	readonly hopTimeoutMs?: number;
	readonly totalTimeoutMs?: number;
	readonly maxHops?: number;
	/** A10: the calling tool's cancellation; it ends the wait for a slot and the request in flight. */
	readonly signal?: AbortSignal;
}

/**
 * Issues the HEAD walk. Every hop, including the first, is gated in this order:
 * allowlist, literal-address deny, permission query. The order matters: a
 * refused host produces no request and no permission lookup, and a permission
 * refusal is only ever reported for a host the policy already allowed.
 */
export async function headWalk(
	rawUrl: string,
	allowedDomains: readonly string[],
	options: HeadOptions = {},
): Promise<HeadResult> {
	const doFetch = options.fetch ?? fetch;
	const permissions = options.permissions ?? Deno.permissions;
	const maxHops = options.maxHops ?? HEAD_MAX_HOPS;
	const deadline = AbortSignal.timeout(options.totalTimeoutMs ?? HEAD_TOTAL_TIMEOUT_MS);
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
				// The one outbound request this server makes. `headers: {}` is the
				// whole credential policy: nothing of the caller's, nothing of the
				// browser's, nothing of this process's is forwarded.
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
			// Parsed before it is gated, so a malformed value is never echoed: the
			// text is the upstream's. Whitespace inside is what two joined `Location`
			// headers look like (m2), and that is not a redirect either.
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

/**
 * The policy gate for one hop: allowlist first, then the literal-address deny.
 *
 * `assertNavigable` already refuses non-http(s) schemes and off-allowlist hosts
 * and names only the host. Userinfo is refused here because WHATWG parsing
 * keeps it (`http://user:pw@host/` parses with `username` set) and a credential
 * inside a URL is exactly what the cookie-less policy exists to exclude.
 */
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
	// A non-default port needs an exact `host:port` entry (m5): the allowlist
	// predicate ignores ports, and a bare-host grant covers every port, so
	// without this rule an allowlisted name would offer every service behind it.
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
 * Whether a hostname is a literal loopback, private, link-local, CGNAT,
 * unspecified or reserved address, or `localhost`, **and** is not named exactly
 * in the allowlist.
 *
 * Exact, never suffix: `localhost` in the list does not admit `a.localhost`,
 * and no `example.com` entry admits any address at all. WHATWG parsing has
 * already folded decimal, hex, octal and short IPv4 spellings to a dotted quad
 * and IPv6 to its compressed lower-case form, so the comparison here is on the
 * canonical text (measured, `build/evidence/b1_12_sr_head_egress_probe.log`).
 * A mapped or NAT64 IPv6 address embeds an IPv4 in its low 32 bits, and that
 * IPv4 is judged by the same table — `[::ffff:7f00:1]` is `127.0.0.1`.
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

/**
 * Whether this process may open a socket to the hop's exact `host:port`.
 *
 * `Deno.permissions.query` answers `granted` for a `host:port` descriptor when
 * the grant names the bare host or that host and port (measured); `prompt` is
 * a refusal under `DENO_NO_PROMPT`. `request` is never called.
 */
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
 * Whether the deployment can offer `browser_head` at all: an outbound grant
 * beyond loopback, **proven** through the permissions API at startup.
 *
 * Unscoped `--allow-net` proves it outright. Otherwise each allowlist entry is
 * queried at `:443` and `:80`, and one granted entry is enough. This cannot
 * list the tool falsely — nothing but a real grant answers `granted` — and an
 * environment boolean was rejected for exactly that reason: an operator could
 * set it without widening the CMD and every call would then fail. The one
 * false negative — a grant on a host the allowlist does not literally name —
 * keeps the tool hidden, which is fail-closed, and the operator's fix is to
 * name the host.
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
		// "Beyond loopback" literally: a private or loopback literal on the
		// allowlist proves nothing here, because the shipped matrices already
		// grant `127.0.0.1` for the browser connection and that grant is not an
		// election of outbound net (security pre-engagement M4).
		if (isForbiddenLiteralHost(host, [])) continue;
		if (await granted({ name: 'net', host: `${host}:443` })) return true;
		if (await granted({ name: 'net', host: `${host}:80` })) return true;
	}
	return false;
}

/**
 * The Chromium flags that decide where the **browser's** traffic goes.
 *
 * `--proxy-bypass-list` is here although it configures no proxy of its own: it
 * is only meaningful where one is configured, so its presence is evidence that
 * an operator made an explicit routing decision for the browser.
 */
export const CHROMIUM_PROXY_FLAGS = [
	'--proxy-server',
	'--proxy-pac-url',
	'--proxy-auto-detect',
	'--no-proxy-server',
	'--proxy-bypass-list',
] as const;

/**
 * The proxy flag `TTK_BROWSER_ARGS` gives Chromium, by **name only**, or `null`.
 *
 * The value is deliberately never returned and never logged. A `--proxy-server`
 * value can carry userinfo (`http://user:pw@proxy:3128`), and DD-7 forbids
 * returning a secret or anything derived from one — so the divergence is named
 * by the flag that causes it, which is what the operator edits anyway.
 */
export function browserProxyFlag(browserArgs: readonly string[]): string | null {
	for (const arg of browserArgs) {
		const name = arg.split('=', 1)[0]?.trim() ?? '';
		if ((CHROMIUM_PROXY_FLAGS as readonly string[]).includes(name)) return name;
	}
	return null;
}

/**
 * Why `browser_head` must refuse in this deployment, or `null` when it may run
 * (SR3-M2, D-049).
 *
 * ## The measurement this rests on
 *
 * `browser_head` is a server-side `fetch`, and Deno's `fetch` honours
 * `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` **whether or not `--allow-env` names
 * them** — measured, `build/evidence/b4_3_sr3_m2_proxy_probe.log`: under an
 * `--allow-env` grant shaped like the shipped container's, which does not name
 * them, the request was still proxied while `Deno.env.get('HTTP_PROXY')` threw
 * `NotCapable`. So on the shipped surface the process is routed by a
 * configuration it is **not permitted to read**. Reading it would mean widening
 * `--allow-env` in every shipped matrix, which this delivery does not do, and
 * which would additionally grant the process a variable that can carry proxy
 * credentials.
 *
 * ## So the check is on the side the server *can* see, and it fails closed
 *
 * The browser's route is configured in `TTK_BROWSER_ARGS`, which this process
 * owns. When that names any proxy flag, the two paths are configured
 * **separately** and the server cannot show they agree — so the tool refuses
 * rather than answering about a network path the browser does not use. No
 * equivalence test is attempted between a Chromium `--proxy-server` list and the
 * `HTTP_PROXY` family: they are different configuration languages, and a clever
 * comparison that was wrong once would be worse than a refusal that is always
 * right about what it claims.
 *
 * The remedy in the message is a configuration where the divergence cannot
 * arise: give the **process** the proxy environment and give Chromium no proxy
 * flag, so both follow one setting, or bound both with a network-level egress
 * control and leave neither configured here.
 *
 * **What this does not catch, stated rather than implied.** A proxy configured
 * outside both — a system or desktop proxy setting Chromium picks up with no
 * flag — is invisible to this process and is a deployment concern the
 * network-level control covers. The check refuses the divergence the server can
 * prove, and says nothing about the one it cannot see.
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

/** The allowlist entries that are private or loopback literals — an operator warning at startup (M4). */
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
	// The message names the origin, which the caller (or, after a hop, the
	// allowlist) chose, and a closed reason; the runtime's own text can carry
	// the full URL it dialled, so it is classified and never forwarded.
	return new ToolError('browser-error', `the request to ${url.origin} failed: ${failureReason(cause)}`);
}

/** K-8 / R3-3: how many errors of a `cause` chain {@linkcode failureReason} reads, the top one included. */
export const FAILURE_CAUSE_DEPTH = 5;

/**
 * Classifies a runtime failure into {@linkcode HEAD_FAILURE_REASONS}.
 *
 * K-8 / review R3-3: Deno 2.9.7's `fetch` rejects with a bare `TypeError: fetch failed` and puts what happened in
 * `cause` (`tcp connect error: Connection refused`, `invalid peer certificate: UnknownIssuer`, a DNS lookup error), so
 * the top message alone classified a refused connection, an untrusted certificate and a failed lookup all as
 * `protocol`. The text read is `name: message` of the error and of up to {@linkcode FAILURE_CAUSE_DEPTH} − 1 causes
 * under it, joined — classified only, never forwarded (it can name the URL that was dialled). The specific reasons are
 * tested before `protocol`, so the generic top message no longer wins.
 */
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

/**
 * The filename a `Content-Disposition` names, or `null`.
 *
 * Decodes the RFC 5987 `filename*=charset''percent-encoded` form this
 * repository's own `attachmentDisposition` emits (UTF-8 and ISO-8859-1 only),
 * falling back to the quoted or token `filename=`. The result is a bare file
 * name: any path is reduced to its last segment, control characters and quotes
 * are dropped, and it is capped — the server chose the text and this tool
 * reports it, it does not trust it.
 */
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
