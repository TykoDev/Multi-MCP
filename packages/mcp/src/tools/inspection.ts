/**
 * Inspection handlers (R4, design §2.6, D-116): `browser_network_log`, `browser_console_log`, `browser_har_export`.
 *
 * Reads only. None of them launches a browser — there is nothing to inspect in a session that does not exist —
 * and none takes the takeover lock, because reading what the browser already did is observation, not
 * interference.
 *
 * ## What leaves, and under which grant
 *
 * The log redacts credentials by header name at mint; what is decided here is the projection. Without
 * `network:read` a caller sees origin + path + `has_query` for every request and, inside header values, every URL
 * cut the same way (F3). `include_full_urls` and `body_for` need the scope and answer `scope-required` — whose
 * message never names a scope (CONNECTORS §1.5) — without it. Every string that leaves passes the server's own
 * secret redaction (`SecretStore.redact`): a configured secret the model typed into a page, as written, never comes
 * back through a URL, a header, a console line or a body. Encoded variants (URL-encoded, base64) are a stated
 * residual.
 */
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import type { EventKind } from '@tykotech/wire';
import { ToolError } from '../errors.ts';
import { formatCursor, parseCursor } from '../events.ts';
import { buildHar, HAR_MAX_BYTES } from '../har.ts';
import { type NetworkEntry, projectHeaders, utf8Length } from '../network_log.ts';
import { CONSOLE_LEVELS, type ConsoleLevel } from '../page_console.ts';
import type { SessionRecord } from '../registry.ts';
import { json, resource, type ToolContext, type ToolResult } from '../types.ts';
import { peekSession } from './shared.ts';

/** The most response body `browser_network_log {body_for}` returns (design §2.6). */
export const NETWORK_BODY_LIMIT_BYTES = 256 * 1024;

/** Default page size of the two log readers. */
const DEFAULT_LIMIT = 100;

/** The scope that unlocks full URLs, header URL values and bodies (design §2.2). */
const NETWORK_SCOPE = 'network:read';

/** What a caller without the scope is told. Deliberately names no scope (CONNECTORS §1.5). */
const NETWORK_REFUSAL = 'this credential cannot read full request URLs or response bodies';

/** The server's secret redaction, or the identity when the deployment configured no secrets. */
function redactorOf(ctx: ToolContext): (text: string) => string {
	const secrets = ctx.secrets;
	return secrets === undefined ? (text) => text : (text) => secrets.redact(text);
}

/** Whether the caller holds `network:read`. Absent scopes mean not privileged (the `ToolContext.scopes` rule). */
function holdsNetworkScope(ctx: ToolContext): boolean {
	return ctx.scopes?.has(NETWORK_SCOPE) === true;
}

/** One log entry as this caller may see it. */
export function projectEntry(
	entry: NetworkEntry,
	options: { readonly fullUrls: boolean; readonly headers: boolean; readonly headerUrls: boolean },
	redact: (text: string) => string,
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		seq: entry.seq,
		request_id: entry.request_id,
		started_at: entry.started_at,
		method: redact(entry.method),
		origin: redact(entry.origin),
		path: redact(entry.path),
		has_query: entry.has_query,
		...(options.fullUrls ? { url: redact(entry.url_full) } : {}),
		resource_type: entry.resource_type,
		frame_id: entry.frame_id,
		status: entry.status,
		mime_type: entry.mime_type === null ? null : redact(entry.mime_type),
		bytes: entry.bytes,
		duration_ms: entry.duration_ms,
		failed: entry.failed,
		error_text: entry.error_text === null ? null : redact(entry.error_text),
		blocked_reason: entry.blocked_reason,
		from_cache: entry.from_cache,
		from_service_worker: entry.from_service_worker,
	};
	if (options.headers) {
		out.request_headers = projectHeaders(entry.request_headers, options.headerUrls, redact);
		out.response_headers = projectHeaders(entry.response_headers, options.headerUrls, redact);
		out.headers_truncated = entry.headers_truncated;
	}
	return out;
}

/** `browser_network_log` (R4). */
export async function browserNetworkLog(
	args: {
		session_id?: string;
		since?: number;
		limit?: number;
		resource_types?: string[];
		failed_only?: boolean;
		include_headers?: boolean;
		include_full_urls?: boolean;
		body_for?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	const privileged = holdsNetworkScope(ctx);
	if ((args.include_full_urls === true || args.body_for !== undefined) && !privileged) {
		throw new ToolError('scope-required', NETWORK_REFUSAL);
	}
	const record = peekSession(ctx, args.session_id);
	const redact = redactorOf(ctx);
	const page = record.network.read({
		...(args.since === undefined ? {} : { since: args.since }),
		limit: args.limit ?? DEFAULT_LIMIT,
		...(args.resource_types === undefined ? {} : { resourceTypes: args.resource_types }),
		...(args.failed_only === undefined ? {} : { failedOnly: args.failed_only }),
	});
	const options = {
		fullUrls: args.include_full_urls === true,
		headers: args.include_headers === true,
		headerUrls: privileged,
	};
	const payload: Record<string, unknown> = {
		session_id: record.id,
		entries: page.entries.map((entry) => projectEntry(entry, options, redact)),
		next_since: page.nextSince,
		dropped: page.dropped,
	};
	if (args.body_for !== undefined) payload.body = await responseBody(record, args.body_for, redact);
	return json(payload);
}

/** `Network.getResponseBody` for one logged request, bounded at {@linkcode NETWORK_BODY_LIMIT_BYTES}. */
async function responseBody(
	record: SessionRecord,
	requestId: string,
	redact: (text: string) => string,
): Promise<Record<string, unknown>> {
	const entry = record.network.get(requestId);
	if (entry === undefined) {
		throw new ToolError('invalid-arguments', `no request ${requestId} in this session's network log`);
	}
	const client = record.session.cdpClient;
	if (client === null || client === undefined) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	let answer: { body: string; base64Encoded: boolean };
	try {
		answer = await client.send.Network.getResponseBody({ requestId }, record.network.sessionOf(requestId));
	} catch {
		// Evicted from the browser's own buffer, a redirect, a failed or still-running request: nothing to hand out.
		throw new ToolError('file-unavailable', `the browser no longer holds a response body for request ${requestId}`);
	}
	if (answer.base64Encoded) {
		const bytes = decodeBase64(answer.body);
		const truncated = bytes.length > NETWORK_BODY_LIMIT_BYTES;
		return {
			request_id: requestId,
			mime_type: entry.mime_type,
			base64: true,
			text: encodeBase64(truncated ? bytes.subarray(0, NETWORK_BODY_LIMIT_BYTES) : bytes),
			bytes: bytes.length,
			truncated,
		};
	}
	// Review R2-7: redacted whole, then cut — a configured secret straddling the cap is replaced, not halved. `bytes`
	// is still the body's own size.
	const bytes = utf8Length(answer.body);
	const encoded = new TextEncoder().encode(redact(answer.body));
	const truncated = encoded.length > NETWORK_BODY_LIMIT_BYTES;
	const text = new TextDecoder().decode(truncated ? encoded.subarray(0, NETWORK_BODY_LIMIT_BYTES) : encoded);
	return {
		request_id: requestId,
		mime_type: entry.mime_type,
		base64: false,
		text,
		bytes,
		truncated,
	};
}

/** `browser_console_log` (R4). */
// deno-lint-ignore require-await -- a handler is always awaited; a synchronous throw would escape the result mapping.
export async function browserConsoleLog(
	args: { session_id?: string; since?: string; limit?: number; levels?: ConsoleLevel[] },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = peekSession(ctx, args.session_id);
	const claim = ctx.registry.claimConsole(record);
	const redact = redactorOf(ctx);
	const ring = record.events;
	const limit = args.limit ?? DEFAULT_LIMIT;
	const levels = args.levels === undefined ? null : new Set<string>(args.levels);
	// The mark is taken before the read, so a record appended later is the next page's, never skipped.
	const mark = ring.highWaterMark;
	const page = ring.read(parseCursor(args.since ?? claim.cursor), new Set<EventKind>(['console']));
	let gap: { reason: string; dropped: number | null } | null = null;
	const entries: Array<{ cursor: string; at: string; level: ConsoleLevel; text: string; truncated: boolean }> = [];
	let cut = false;
	for (const event of page) {
		if (event.kind === 'gap') {
			gap = {
				reason: String(event.payload.reason ?? 'ring-overrun'),
				dropped: typeof event.payload.dropped === 'number' ? event.payload.dropped : null,
			};
			continue;
		}
		if (event.kind !== 'console') continue;
		const level = String(event.payload.level) as ConsoleLevel;
		if (!(CONSOLE_LEVELS as readonly string[]).includes(level)) continue;
		if (levels !== null && !levels.has(level)) continue;
		if (entries.length >= limit) {
			cut = true;
			break;
		}
		entries.push({
			cursor: formatCursor(ring.epoch, event.seq),
			at: event.at,
			level,
			text: redact(String(event.payload.text ?? '')),
			truncated: event.payload.truncated === true,
		});
	}
	return json({
		session_id: record.id,
		armed_since: new Date(claim.armedAt).toISOString(),
		entries,
		next_cursor: cut
			? entries[entries.length - 1]?.cursor ?? formatCursor(ring.epoch, mark)
			: formatCursor(ring.epoch, mark),
		gap,
	});
}

/** `browser_har_export` (R4). */
// deno-lint-ignore require-await -- a handler is always awaited; a synchronous throw would escape the result mapping.
export async function browserHarExport(
	args: { session_id?: string; max_entries?: number; include_full_urls?: boolean },
	ctx: ToolContext,
): Promise<ToolResult> {
	const privileged = holdsNetworkScope(ctx);
	if (args.include_full_urls === true && !privileged) throw new ToolError('scope-required', NETWORK_REFUSAL);
	const record = peekSession(ctx, args.session_id);
	const all = record.network.snapshot();
	const max = args.max_entries ?? 500;
	const chosen = all.slice(Math.max(0, all.length - max));
	const document = buildHar(chosen, {
		version: ctx.capabilities?.version ?? 'unknown',
		fullUrls: args.include_full_urls === true,
		headerUrls: privileged,
		redact: redactorOf(ctx),
	});
	const text = JSON.stringify(document);
	const bytes = utf8Length(text);
	if (bytes > HAR_MAX_BYTES) {
		throw new ToolError(
			'file-unavailable',
			`the HAR document is ${bytes} bytes, over the ${HAR_MAX_BYTES}-byte limit; call again with a smaller max_entries`,
		);
	}
	const payload = {
		session_id: record.id,
		entries: chosen.length,
		bytes,
		truncated: all.length > chosen.length || record.network.dropped > 0,
	};
	return resource(
		payload,
		{
			type: 'resource',
			resource: {
				uri: `ttk://session/${encodeURIComponent(record.id)}/network.har`,
				mimeType: 'application/json',
				text,
			},
		},
		JSON.stringify(payload, null, 2),
	);
}
