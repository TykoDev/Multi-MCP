/**
 * HAR 1.2 from a session's {@linkcode NetworkLog} (R4, design §2.6, D-116) — `browser_har_export`'s builder.
 *
 * MCP-owned rather than the vendored `HarRecordingWatchdog`, which stays unattached: that one maps headers
 * verbatim, keeps cookies and post data in `full` mode, holds entries and bodies unbounded in memory and names
 * itself `bua`. Building from the log instead inherits the log's redaction at mint and its bounds, and adds no
 * vendored edit.
 *
 * What a HAR here never carries: a body (request or response), a cookie (`cookies: []` always — Chrome reports
 * cookies only in the untyped `*ExtraInfo` events, and the `Cookie`/`Set-Cookie` headers are redacted at mint), a
 * server's credential header. Without full-URL permission `request.url` and `response.redirectURL` are origin +
 * path and `queryString` is empty, and every URL inside a header value is cut the same way (F3).
 */
import { cutUrl, type NetworkEntry, projectHeaders } from './network_log.ts';

/** The largest HAR document `browser_har_export` returns (design §2.6). */
export const HAR_MAX_BYTES = 1_048_576;

/** HAR 1.2 `log.creator.name`. */
export const HAR_CREATOR_NAME = 'tykotech-mcp';

/** One HAR `{name, value}` pair. */
export interface HarNameValue {
	name: string;
	value: string;
}

/** The HAR 1.2 entry this builder emits; every required member of the spec is present. */
export interface HarEntry {
	startedDateTime: string;
	time: number;
	request: {
		method: string;
		url: string;
		httpVersion: string;
		cookies: HarNameValue[];
		headers: HarNameValue[];
		queryString: HarNameValue[];
		headersSize: number;
		bodySize: number;
	};
	response: {
		status: number;
		statusText: string;
		httpVersion: string;
		cookies: HarNameValue[];
		headers: HarNameValue[];
		content: { size: number; mimeType: string };
		redirectURL: string;
		headersSize: number;
		bodySize: number;
		/** Chrome's `errorText` for a request that never got a response (custom field, HAR §"custom fields"). */
		_error?: string;
	};
	cache: Record<string, never>;
	timings: { blocked: number; dns: number; connect: number; send: number; wait: number; receive: number; ssl: number };
	_resourceType: string;
}

/** A HAR 1.2 document. */
export interface HarDocument {
	log: {
		version: '1.2';
		creator: { name: string; version: string };
		entries: HarEntry[];
	};
}

/** What the builder needs beyond the entries. */
export interface HarOptions {
	/** The server version, for `log.creator.version`. */
	readonly version: string;
	/** `include_full_urls` **and** `network:read`: full `request.url`, `redirectURL` and `queryString`. */
	readonly fullUrls: boolean;
	/**
	 * `network:read` alone: URLs inside header values are left whole (design §2.6, "headers as projected above").
	 * Absent means {@linkcode HarOptions.fullUrls}.
	 */
	readonly headerUrls?: boolean;
	/** The server's secret redaction, applied to every string that leaves (`SecretStore.redact`). */
	readonly redact?: (text: string) => string;
}

/** Builds the document. Pure: the caller chooses the entries (newest `max_entries`) and enforces the size cap. */
export function buildHar(entries: readonly NetworkEntry[], options: HarOptions): HarDocument {
	const redact = options.redact ?? ((text: string) => text);
	return {
		log: {
			version: '1.2',
			creator: { name: HAR_CREATOR_NAME, version: options.version },
			entries: entries.map((entry) =>
				harEntry(entry, options.fullUrls, options.headerUrls ?? options.fullUrls, redact)
			),
		},
	};
}

function harEntry(
	entry: NetworkEntry,
	fullUrls: boolean,
	headerUrls: boolean,
	redact: (text: string) => string,
): HarEntry {
	const url = fullUrls ? entry.url_full : `${entry.origin}${entry.path}`;
	const requestHeaders = projectHeaders(entry.request_headers, headerUrls, redact);
	const responseHeaders = projectHeaders(entry.response_headers, headerUrls, redact);
	const location = Object.entries(entry.response_headers).find(([name]) => name.toLowerCase() === 'location')?.[1];
	const time = entry.duration_ms ?? 0;
	const har: HarEntry = {
		startedDateTime: entry.started_at,
		time,
		request: {
			method: redact(entry.method),
			url: redact(url),
			httpVersion: '',
			cookies: [],
			headers: pairs(requestHeaders),
			queryString: fullUrls ? queryOf(entry.url_full, redact) : [],
			headersSize: -1,
			bodySize: -1,
		},
		response: {
			status: entry.status ?? 0,
			statusText: '',
			httpVersion: '',
			cookies: [],
			headers: pairs(responseHeaders),
			content: { size: entry.bytes, mimeType: redact(entry.mime_type ?? 'x-unknown') },
			redirectURL: location === undefined ? '' : redact(fullUrls ? location : cutUrl(location.trim())),
			headersSize: -1,
			bodySize: -1,
		},
		cache: {},
		// Only the total is observed; the phases HAR makes optional are `-1` (not available), the three it requires
		// carry the whole duration as `wait`.
		timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: time, receive: 0, ssl: -1 },
		_resourceType: entry.resource_type,
	};
	if (entry.failed) har.response._error = redact(entry.error_text ?? '');
	return har;
}

function pairs(headers: Readonly<Record<string, string>>): HarNameValue[] {
	return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function queryOf(url: string, redact: (text: string) => string): HarNameValue[] {
	const parsed = URL.parse(url);
	if (parsed === null) return [];
	return [...parsed.searchParams].map(([name, value]) => ({ name: redact(name), value: redact(value) }));
}
