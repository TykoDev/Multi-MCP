/**
 * The per-session request log behind `browser_network_log` and `browser_har_export` (R4, design §2.6, D-116).
 *
 * ## Why its own buffer, not the event ring
 *
 * The ring is replayable to every `mcp:invoke` holder of a session and carries no URL with a query, no header and no
 * body (I-8). A request log needs all three, gated by `network:read` at read time, so it lives here: one bounded
 * buffer per {@linkcode SessionRecord}, in memory only, dying with the session.
 *
 * ## Redaction at mint
 *
 * What a header *name* says is a credential never enters the buffer: `Authorization`, `Proxy-Authorization`,
 * `Cookie`, `Set-Cookie`, `Sec-WebSocket-Protocol` (where a browser client carries a token, since it cannot set
 * `Authorization` on a WebSocket), and any name containing `token`, `secret`, `session`, `auth`, `key`, `csrf`,
 * `xsrf`, `cookie`, `pass` (`password`, `passcode`), `pwd`, `credential`, `signature`, `jwt`, `bearer`, `otp`,
 * `dpop`, `assertion` or `principal` is stored as `[redacted]` (review R2-3 widened the list; `cookie` as a
 * substring was already a narrowing beyond the design's list: `Cookie2`, `X-Cookie-…`). A request body (`postData`)
 * is never read. Full URLs are kept — capped — because a `network:read` holder may read them; everyone else gets
 * {@linkcode projectHeaders}' and the tool's origin+path projection, applied at read. The `path` every reader sees
 * carries no `;matrix=params` (a `;jsessionid=` is a session) and, for a `data:` URL, only its media type.
 *
 * Review R2-7: **redaction before every cut.** The server's secret redaction (`SecretStore.redact`, handed down by
 * the registry) runs on the whole URL and the whole path before they are capped, so a configured secret straddling a
 * cap cannot leave its prefix behind; the read path redacts again, as it always did.
 *
 * ## Bounds
 *
 * At most {@linkcode NETWORK_LOG_MAX_ENTRIES} entries and {@linkcode NETWORK_LOG_MAX_BYTES} of serialized entries
 * (UTF-8), oldest evicted first; `dropped` counts evictions so a reader can tell "the page was quiet" from "you
 * missed it". One entry's header block is at most {@linkcode MAX_HEADER_BLOCK_BYTES}. Always on: it is metadata,
 * and with `TTK_MAX_SESSIONS` sessions it costs at most that many times 512 KiB.
 */
import type { CdpClient, CdpEventParams } from '@tykotech/cdp';
// NF-2: the path cutters live in `events.ts` beside `navigationTarget`, so a navigation record and a log entry cut a
// path the same way; `loggedPath` is re-exported here for the importers that always found it in this module.
import { loggedPath, navigationTarget, stripMatrixParams } from './events.ts';

export { loggedPath };

/** Entries a session's log retains (design §2.6). */
export const NETWORK_LOG_MAX_ENTRIES = 500;
/** Serialized bytes a session's log retains (design §2.6). */
export const NETWORK_LOG_MAX_BYTES = 524_288;
/** One entry's request plus response headers, serialized as `name` + `value` (design §2.6). */
export const MAX_HEADER_BLOCK_BYTES = 8 * 1024;
/** The longest `url_full` kept; a `data:` URL can be megabytes and is cut here. */
export const MAX_LOGGED_URL_CHARS = 4096;
/** The longest `path` kept (a `data:` URL's "path" is its whole payload). */
export const MAX_LOGGED_PATH_CHARS = 1024;
/** The longest `error_text` / `blocked_reason` kept. */
const MAX_LOGGED_REASON_CHARS = 256;
/** What a redacted header value reads as. */
export const REDACTED_HEADER = '[redacted]';

const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
	'authorization',
	'proxy-authorization',
	'cookie',
	'set-cookie',
	// Review R2-3: a browser cannot set `Authorization` on a WebSocket, so a token rides in the subprotocol list.
	'sec-websocket-protocol',
]);
const SENSITIVE_HEADER_PARTS: readonly string[] = [
	'token',
	'secret',
	'session',
	'auth',
	'key',
	'csrf',
	'xsrf',
	'cookie',
	// Review R2-3 (17 of 24 credential-shaped names were kept by the list above): over-redacting a header that only
	// looks like a credential costs a value nobody needed; under-redacting one costs the credential.
	'pass',
	'pwd',
	'credential',
	'signature',
	'jwt',
	'bearer',
	'otp',
	'dpop',
	'assertion',
	'principal',
];

/**
 * Headers whose value is a URL, or carries one, that the read projection cuts to origin+path without
 * `network:read` (F3): a relative reference in them loses its query and fragment too.
 */
export const URL_VALUED_HEADERS: ReadonlySet<string> = new Set([
	'referer',
	'location',
	'content-location',
	'link',
	'refresh',
]);

/** Whether a header's *name* marks its value as a credential (redacted at mint). */
export function isSensitiveHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return SENSITIVE_HEADER_NAMES.has(lower) || SENSITIVE_HEADER_PARTS.some((part) => lower.includes(part));
}

/** One request as the log holds it. Wire names, because the tool emits a projection of exactly this. */
export interface NetworkEntry {
	/** Monotonic per log, from 1; `browser_network_log {since}` pages on it. */
	seq: number;
	/** Chrome's request id. A redirect chain shares one; each hop is its own entry. */
	request_id: string;
	started_at: string;
	method: string;
	origin: string;
	path: string;
	has_query: boolean;
	/** The full URL, query included, capped at {@linkcode MAX_LOGGED_URL_CHARS}. Returned only with `network:read`. */
	url_full: string;
	resource_type: string;
	frame_id: string | null;
	status: number | null;
	mime_type: string | null;
	/** Body bytes received (decoded chunks where the browser reported them, else the transfer size). */
	bytes: number;
	duration_ms: number | null;
	failed: boolean;
	error_text: string | null;
	blocked_reason: string | null;
	from_cache: boolean;
	from_service_worker: boolean;
	/** Redacted at mint; bounded with the response headers by {@linkcode MAX_HEADER_BLOCK_BYTES}. */
	request_headers: Record<string, string>;
	response_headers: Record<string, string>;
	/** Some headers did not fit {@linkcode MAX_HEADER_BLOCK_BYTES} and were left out. */
	headers_truncated: boolean;
}

/** {@linkcode NetworkLog.read}'s query. */
export interface NetworkLogQuery {
	/** Entries with `seq` greater than this; `0` (or absent) is "from the oldest retained". */
	readonly since?: number;
	readonly limit: number;
	/** Case-insensitive `resource_type` filter. */
	readonly resourceTypes?: readonly string[];
	readonly failedOnly?: boolean;
}

/** Construction options; every member defaults to the design's value. */
export interface NetworkLogOptions {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
	readonly now?: () => number;
	/**
	 * Review R2-7: the server's secret redaction (`SecretStore.redact`), applied to a URL and a path **before** they are
	 * capped at mint. The identity when the deployment configured no secrets.
	 */
	readonly redact?: (text: string) => string;
}

/** Bookkeeping kept beside an entry, never emitted. */
interface EntryMeta {
	size: number;
	readonly sessionId: string | undefined;
	readonly startTimestamp: number;
	headerBytes: number;
	sawData: boolean;
}

/** The per-session request log. One instance per session; {@linkcode NetworkLog.close} is the single teardown. */
export class NetworkLog {
	readonly #maxEntries: number;
	readonly #maxBytes: number;
	readonly #now: () => number;
	readonly #redact: (text: string) => string;
	#entries: NetworkEntry[] = [];
	readonly #meta = new Map<NetworkEntry, EntryMeta>();
	/** The newest entry per request id (a redirect hop replaces its predecessor here, not in `#entries`). */
	readonly #latest = new Map<string, NetworkEntry>();
	readonly #detach = new Set<() => void>();
	#seq = 0;
	#bytes = 0;
	#evicted = 0;
	#closed = false;

	constructor(options: NetworkLogOptions = {}) {
		this.#maxEntries = options.maxEntries ?? NETWORK_LOG_MAX_ENTRIES;
		this.#maxBytes = options.maxBytes ?? NETWORK_LOG_MAX_BYTES;
		this.#now = options.now ?? Date.now;
		this.#redact = options.redact ?? ((text) => text);
	}

	/** Entries retained now. */
	get size(): number {
		return this.#entries.length;
	}

	/** Serialized UTF-8 bytes retained now — the bound {@linkcode NETWORK_LOG_MAX_BYTES} applies to. */
	get bytes(): number {
		return this.#bytes;
	}

	/** Entries evicted since the log was created. */
	get dropped(): number {
		return this.#evicted;
	}

	/** The highest `seq` minted so far. */
	get highWaterMark(): number {
		return this.#seq;
	}

	/**
	 * Subscribes the log to one CDP client's typed `Network.*` events (every attached page and iframe session has
	 * `Network.enable` from the attach cascade). Returns the unsubscribe; {@linkcode close} also detaches.
	 */
	attach(client: CdpClient): () => void {
		if (this.#closed || typeof client?.on !== 'function') return () => {};
		const offs = [
			client.on('Network.requestWillBeSent', (params, sessionId) => this.#willBeSent(params, sessionId)),
			client.on('Network.responseReceived', (params) => this.#responded(params)),
			client.on('Network.dataReceived', (params) => this.#data(params)),
			client.on('Network.loadingFinished', (params) => this.#finished(params)),
			client.on('Network.loadingFailed', (params) => this.#failed(params)),
			client.on('Network.requestServedFromCache', (params) => this.#fromCache(params.requestId)),
		];
		const off = (): void => {
			this.#detach.delete(off);
			for (const unsubscribe of offs) unsubscribe();
		};
		this.#detach.add(off);
		return off;
	}

	/**
	 * Entries after `since`, oldest first, at most `limit`. `nextSince` is where the next page starts — the last
	 * entry returned when the limit cut the page, else the newest `seq` scanned, so filtered-out entries are not
	 * re-scanned. `dropped` counts the entries after `since` that were evicted before this read: they existed and
	 * cannot be returned.
	 */
	read(query: NetworkLogQuery): { entries: NetworkEntry[]; nextSince: number; dropped: number } {
		const since = query.since ?? 0;
		const types = query.resourceTypes === undefined || query.resourceTypes.length === 0
			? null
			: new Set(query.resourceTypes.map((type) => type.toLowerCase()));
		const entries: NetworkEntry[] = [];
		let nextSince = Math.max(since, this.#seq);
		for (const entry of this.#entries) {
			if (entry.seq <= since) continue;
			if (types !== null && !types.has(entry.resource_type.toLowerCase())) continue;
			if (query.failedOnly === true && !entry.failed) continue;
			if (entries.length >= query.limit) {
				nextSince = entries[entries.length - 1]?.seq ?? since;
				break;
			}
			entries.push(copyEntry(entry));
		}
		// Evicted seqs are exactly 1…#evicted: every minted entry is pushed and eviction takes the oldest.
		return { entries, nextSince, dropped: Math.max(0, this.#evicted - since) };
	}

	/** Every retained entry, oldest first (the HAR builder's input). Copies. */
	snapshot(): NetworkEntry[] {
		return this.#entries.map(copyEntry);
	}

	/** The newest entry for a request id, or `undefined` once evicted or never seen. A copy. */
	get(requestId: string): NetworkEntry | undefined {
		const entry = this.#latest.get(requestId);
		return entry === undefined ? undefined : copyEntry(entry);
	}

	/** The CDP session that reported a request — what `Network.getResponseBody` must be sent on. */
	sessionOf(requestId: string): string | undefined {
		const entry = this.#latest.get(requestId);
		return entry === undefined ? undefined : this.#meta.get(entry)?.sessionId;
	}

	/** Detaches every listener and drops every entry. Idempotent. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const off of [...this.#detach]) off();
		this.#entries = [];
		this.#meta.clear();
		this.#latest.clear();
		this.#bytes = 0;
	}

	// -- the six events ------------------------------------------------------------------------------

	#willBeSent(params: CdpEventParams['Network.requestWillBeSent'], sessionId: string | undefined): void {
		if (this.#closed) return;
		const previous = this.#latest.get(params.requestId);
		if (previous !== undefined && params.redirectResponse !== undefined) {
			// The hop before this one ended in a redirect: it is finished, with that response.
			this.#applyResponse(previous, params.redirectResponse);
			this.#finish(previous, params.timestamp);
		}
		const url = typeof params.request.url === 'string' ? params.request.url : '';
		const target = navigationTarget(url);
		const meta: EntryMeta = {
			size: 0,
			sessionId,
			startTimestamp: params.timestamp,
			headerBytes: 0,
			sawData: false,
		};
		const entry: NetworkEntry = {
			seq: ++this.#seq,
			request_id: params.requestId,
			started_at: isoOf(params.wallTime, this.#now),
			method: String(params.request.method ?? ''),
			origin: target.origin,
			// Review R2-3 / R2-7: no matrix parameters, a `data:` URL's media type only, redacted before the cap.
			path: this.#redact(loggedPath(url)).slice(0, MAX_LOGGED_PATH_CHARS),
			has_query: target.has_query,
			url_full: this.#redact(url).slice(0, MAX_LOGGED_URL_CHARS),
			resource_type: params.type ?? 'Other',
			frame_id: params.frameId ?? null,
			status: null,
			mime_type: null,
			bytes: 0,
			duration_ms: null,
			failed: false,
			error_text: null,
			blocked_reason: null,
			from_cache: false,
			from_service_worker: false,
			request_headers: {},
			response_headers: {},
			headers_truncated: false,
		};
		// `postData` is deliberately never read: a request body is where a typed password goes.
		const bounded = boundHeaders(params.request.headers, MAX_HEADER_BLOCK_BYTES);
		entry.request_headers = bounded.headers;
		entry.headers_truncated = bounded.truncated;
		meta.headerBytes = bounded.used;
		this.#meta.set(entry, meta);
		this.#latest.set(params.requestId, entry);
		this.#entries.push(entry);
		this.#resize(entry);
	}

	#responded(params: CdpEventParams['Network.responseReceived']): void {
		const entry = this.#latest.get(params.requestId);
		if (entry === undefined) return;
		if (typeof params.type === 'string') entry.resource_type = params.type;
		this.#applyResponse(entry, params.response);
		this.#resize(entry);
	}

	#data(params: CdpEventParams['Network.dataReceived']): void {
		const entry = this.#latest.get(params.requestId);
		const meta = entry === undefined ? undefined : this.#meta.get(entry);
		if (entry === undefined || meta === undefined) return;
		meta.sawData = true;
		entry.bytes += Math.max(0, params.dataLength ?? 0);
	}

	#finished(params: CdpEventParams['Network.loadingFinished']): void {
		const entry = this.#latest.get(params.requestId);
		const meta = entry === undefined ? undefined : this.#meta.get(entry);
		if (entry === undefined || meta === undefined) return;
		if (!meta.sawData) entry.bytes = Math.max(0, params.encodedDataLength ?? 0);
		this.#finish(entry, params.timestamp);
		this.#resize(entry);
	}

	#failed(params: CdpEventParams['Network.loadingFailed']): void {
		const entry = this.#latest.get(params.requestId);
		if (entry === undefined) return;
		entry.failed = true;
		entry.error_text = String(params.errorText ?? '').slice(0, MAX_LOGGED_REASON_CHARS);
		entry.blocked_reason = params.blockedReason === undefined
			? null
			: String(params.blockedReason).slice(0, MAX_LOGGED_REASON_CHARS);
		this.#finish(entry, params.timestamp);
		this.#resize(entry);
	}

	#fromCache(requestId: string): void {
		const entry = this.#latest.get(requestId);
		if (entry !== undefined) entry.from_cache = true;
	}

	// -- bookkeeping ---------------------------------------------------------------------------------

	#applyResponse(entry: NetworkEntry, response: CdpEventParams['Network.responseReceived']['response']): void {
		const meta = this.#meta.get(entry);
		entry.status = typeof response.status === 'number' ? response.status : null;
		entry.mime_type = typeof response.mimeType === 'string' ? response.mimeType : null;
		entry.from_cache ||= response.fromDiskCache === true || response.fromPrefetchCache === true;
		entry.from_service_worker = response.fromServiceWorker === true;
		const budget = MAX_HEADER_BLOCK_BYTES - (meta?.headerBytes ?? 0);
		const bounded = boundHeaders(response.headers, budget);
		entry.response_headers = bounded.headers;
		entry.headers_truncated ||= bounded.truncated;
		if (meta !== undefined) meta.headerBytes += bounded.used;
	}

	#finish(entry: NetworkEntry, timestamp: number | undefined): void {
		const meta = this.#meta.get(entry);
		if (meta === undefined || entry.duration_ms !== null) return;
		if (typeof timestamp === 'number' && Number.isFinite(timestamp) && Number.isFinite(meta.startTimestamp)) {
			entry.duration_ms = Math.max(0, Math.round((timestamp - meta.startTimestamp) * 1000));
		}
	}

	/** Re-measures one entry and evicts from the oldest end until both bounds hold. */
	#resize(entry: NetworkEntry): void {
		const meta = this.#meta.get(entry);
		if (meta === undefined) return;
		const size = utf8Length(JSON.stringify(entry));
		this.#bytes += size - meta.size;
		meta.size = size;
		while (this.#entries.length > this.#maxEntries || (this.#bytes > this.#maxBytes && this.#entries.length > 0)) {
			const oldest = this.#entries.shift();
			if (oldest === undefined) break;
			this.#bytes -= this.#meta.get(oldest)?.size ?? 0;
			this.#meta.delete(oldest);
			if (this.#latest.get(oldest.request_id) === oldest) this.#latest.delete(oldest.request_id);
			this.#evicted += 1;
		}
	}
}

/**
 * A header map with credentials redacted by name and the whole block bounded: headers are taken in order until the
 * next would exceed `budget` (`name.length + value.length`, UTF-8), the rest are left out and `truncated` says so.
 */
export function boundHeaders(
	headers: unknown,
	budget: number,
): { headers: Record<string, string>; used: number; truncated: boolean } {
	const out: Record<string, string> = {};
	let used = 0;
	let truncated = false;
	if (headers === null || typeof headers !== 'object') return { headers: out, used, truncated };
	for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
		const value = isSensitiveHeader(name) ? REDACTED_HEADER : String(raw ?? '');
		const cost = utf8Length(name) + utf8Length(value);
		if (used + cost > budget) {
			truncated = true;
			continue;
		}
		out[name] = value;
		used += cost;
	}
	return { headers: out, used, truncated };
}

/**
 * A URL cut to what a caller without `network:read` may see (F3): an absolute URL to origin + path (no matrix
 * parameters — review R2-3), a `data:` URL to its media type; anything else — a relative reference — to the part
 * before its query or fragment.
 */
export function cutUrl(raw: string): string {
	const parsed = URL.parse(raw);
	if (parsed !== null && parsed.protocol === 'data:') return `data:${loggedPath(raw)}`;
	if (parsed !== null && parsed.origin !== 'null') return `${parsed.origin}${stripMatrixParams(parsed.pathname)}`;
	if (parsed !== null) return `${parsed.protocol}${stripMatrixParams(parsed.pathname)}`.slice(0, MAX_LOGGED_PATH_CHARS);
	const at = raw.search(/[?#]/);
	return stripMatrixParams(at === -1 ? raw : raw.slice(0, at));
}

/** An absolute URL inside a header value: a scheme, `//`, and everything up to whitespace, a quote or `>`. */
const ABSOLUTE_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*/g;

/**
 * A `?query` or `#fragment` anywhere in a header value, up to whitespace, a quote or an angle bracket (review R2-3).
 * Not up to `;` or `,`: a query may carry either, and stopping there would leave its tail (`?a=1;token=…`).
 */
const QUERY_OR_FRAGMENT = /[?#][^\s"'<>]*/g;

/**
 * One header value as a caller without `network:read` sees it (F3, design §2.6): every absolute URL anywhere in the
 * value is cut to origin + path, and — review R2-3 — every `?query` / `#fragment` reference in **every** header value
 * is cut, not only in the URL-valued ones: a relative reference with a query rides in `Reporting-Endpoints`, a CSP
 * `report-uri`, a custom `X-Redirect` as readily as in `Location`. The URL-valued headers
 * ({@linkcode URL_VALUED_HEADERS}) are then cut as a whole reference too — `Location: /cb?code=…`,
 * `Link: </x?t=…>; rel=preload`, `Refresh: 0; url=/next?s=…`.
 */
export function cutHeaderValue(name: string, value: string): string {
	if (value === REDACTED_HEADER) return value;
	const lower = name.toLowerCase();
	let out = value.replace(ABSOLUTE_URL, (match) => cutUrl(match)).replace(QUERY_OR_FRAGMENT, '');
	if (!URL_VALUED_HEADERS.has(lower)) return out;
	if (lower === 'link') {
		out = out.replace(/<([^>]*)>/g, (_whole, ref: string) => `<${cutUrl(ref)}>`);
	} else if (lower === 'refresh') {
		out = out.replace(/(url\s*=\s*['"]?)([^'"\s]*)/i, (_whole, prefix: string, ref: string) => prefix + cutUrl(ref));
	} else {
		out = cutUrl(out.trim());
	}
	return out;
}

/**
 * A header map projected for a reader (design §2.6): names as minted (credentials already `[redacted]`), every
 * value through `redact` (the server's own secrets, as written), and — without full-URL permission — every URL
 * inside a value cut by {@linkcode cutHeaderValue}.
 */
export function projectHeaders(
	headers: Readonly<Record<string, string>>,
	fullUrls: boolean,
	redact: (text: string) => string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[redact(name)] = redact(fullUrls ? value : cutHeaderValue(name, value));
	}
	return out;
}

function copyEntry(entry: NetworkEntry): NetworkEntry {
	return { ...entry, request_headers: { ...entry.request_headers }, response_headers: { ...entry.response_headers } };
}

/** CDP `wallTime` (seconds since the epoch) as ISO 8601, or the log clock when it is missing. */
function isoOf(wallTime: number | undefined, now: () => number): string {
	const ms = typeof wallTime === 'number' && Number.isFinite(wallTime) && wallTime > 0 ? wallTime * 1000 : now();
	return new Date(ms).toISOString();
}

/** UTF-8 length of a string without allocating its encoding. */
export function utf8Length(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			bytes += 4;
			index += 1;
		} else bytes += 3;
	}
	return bytes;
}
