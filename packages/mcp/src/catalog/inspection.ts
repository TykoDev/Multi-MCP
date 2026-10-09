/**
 * Inspection tools (R4, design §2.6, D-116): the session's request log, its console, and a HAR export of the log.
 *
 * All three are read-only and closed-world — they read what the browser already did and never touch the page — so
 * they stay usable while a human holds the session, and they never launch a browser. Their output schemas live
 * beside them rather than in `schemas.ts` (design §2.3). Full URLs, URLs inside header values and response bodies
 * need `network:read` at call time; the tools themselves need only `mcp:invoke`, because the metadata is the same
 * class of fact `browser_get_state` already gives every holder of the session.
 */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import { CONSOLE_LEVELS } from '../page_console.ts';
import { def, sessionId, type ToolDefinition } from './shared.ts';

/** One request as `browser_network_log` emits it: the log entry, projected for the caller. */
const NetworkEntryOut = z.object({
	seq: z.number().int(),
	request_id: z.string(),
	started_at: z.string(),
	method: z.string(),
	origin: z.string(),
	path: z.string(),
	has_query: z.boolean(),
	/** The full URL, query included: only with `include_full_urls` and `network:read`. */
	url: z.string().optional(),
	resource_type: z.string(),
	frame_id: z.string().nullable(),
	status: z.number().int().nullable(),
	mime_type: z.string().nullable(),
	bytes: z.number(),
	duration_ms: z.number().nullable(),
	failed: z.boolean(),
	error_text: z.string().nullable(),
	blocked_reason: z.string().nullable(),
	from_cache: z.boolean(),
	from_service_worker: z.boolean(),
	/** Only with `include_headers`. Credentials `[redacted]` by name; URLs inside values cut without `network:read`. */
	request_headers: z.record(z.string(), z.string()).optional(),
	response_headers: z.record(z.string(), z.string()).optional(),
	headers_truncated: z.boolean().optional(),
});

/** The design's `NetworkEntryOut` (§2.3) and the two other inspection outputs, beside their definitions. */
export const INSPECTION_OUTPUT = {
	browser_network_log: z.object({
		session_id: z.string(),
		entries: z.array(NetworkEntryOut),
		/** Pass back as `since` to read only what came after this page. */
		next_since: z.number().int(),
		/** Requests after `since` the bounded log evicted before this read: they happened and cannot be returned. */
		dropped: z.number().int(),
		body: z.object({
			request_id: z.string(),
			mime_type: z.string().nullable(),
			/** `text` holds base64 rather than text: the browser reported a binary body. */
			base64: z.boolean(),
			text: z.string(),
			bytes: z.number().int(),
			truncated: z.boolean(),
		}).optional(),
	}),
	browser_console_log: z.object({
		session_id: z.string(),
		/** When this tool's console capture began: output from before it was never captured. */
		armed_since: z.string(),
		entries: z.array(z.object({
			cursor: z.string(),
			at: z.string(),
			level: z.enum(CONSOLE_LEVELS),
			text: z.string(),
			truncated: z.boolean(),
		})),
		/** Pass back as `since` to read only what came after this page. */
		next_cursor: z.string(),
		/** Non-null when records between `since` and this page were lost (the ring overran, or the session restarted). */
		gap: z.object({ reason: z.string(), dropped: z.number().int().nullable() }).nullable(),
	}),
	browser_har_export: z.object({
		session_id: z.string(),
		/** Entries in the embedded HAR document. */
		entries: z.number().int(),
		/** Size of the embedded HAR document, UTF-8. */
		bytes: z.number().int(),
		/** The document does not hold every request the session made: `max_entries` cut it, or the log evicted some. */
		truncated: z.boolean(),
	}),
} as const;

export const INSPECTION_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	def({
		name: 'browser_network_log',
		title: 'Read the network log',
		description: 'List the requests this session’s pages made, oldest first: method, origin and path, resource type, ' +
			'status, MIME type, size, timing, and whether it failed or was blocked — including document requests the ' +
			'deployment allowlist refused before they were sent (error_text net::ERR_ABORTED). Page with since: pass ' +
			'back next_since. include_headers adds request and response headers; credentials (Authorization, Cookie, ' +
			'Set-Cookie, anything named like a token, key, session or CSRF value) always read [redacted]. Full URLs ' +
			'with their query (include_full_urls) and a response body (body_for: a request_id from this log, up to ' +
			'256 KiB) need an explicit grant on the credential; without it, URLs inside header values are cut to origin ' +
			'and path. Request bodies are never kept. The log is bounded (500 requests, 512 KiB); dropped counts ' +
			'requests evicted before you read them.',
		inputSchema: z.object({
			session_id: sessionId,
			since: z.number().int().min(0).optional().describe(
				'next_since from a previous call; omit to start at the oldest.',
			),
			limit: z.number().int().min(1).max(500).optional().describe('Most entries to return (default 100).'),
			resource_types: z.array(z.string().max(32)).max(16).optional().describe(
				'Only these resource types, e.g. ["Document","XHR","Fetch"] (case-insensitive).',
			),
			failed_only: z.boolean().optional().describe('Only requests that failed or were blocked.'),
			include_headers: z.boolean().optional().describe('Add request_headers and response_headers to each entry.'),
			include_full_urls: z.boolean().optional().describe(
				'Add the full url, query included, to each entry. Needs the network grant.',
			),
			body_for: z.string().max(128).optional().describe(
				'A request_id whose response body to return (text or base64, at most 256 KiB). Needs the network grant.',
			),
		}),
		mutates: false,
		outputSchema: INSPECTION_OUTPUT.browser_network_log,
		handler: handlers.browserNetworkLog,
	}),
	def({
		name: 'browser_console_log',
		title: 'Read the console log',
		description: 'Read what the session’s pages wrote to the console (log, info, warn, error, debug) and uncaught ' +
			'exceptions, as text capped at 512 characters each. The first call starts capture and every call keeps it ' +
			'on; it stops after 10 minutes without a call, or when the session closes. armed_since says when capture ' +
			'began — output from before it was never captured, so an empty answer just after it is not proof the page ' +
			'was quiet. Page with since: pass back next_cursor. gap is set when records were lost between reads.',
		inputSchema: z.object({
			session_id: sessionId,
			since: z.string().max(64).optional().describe(
				'next_cursor from a previous call; omit to read from when capture began.',
			),
			limit: z.number().int().min(1).max(500).optional().describe('Most entries to return (default 100).'),
			levels: z.array(z.enum(CONSOLE_LEVELS)).max(CONSOLE_LEVELS.length).optional().describe(
				'Only these levels.',
			),
		}),
		mutates: false,
		outputSchema: INSPECTION_OUTPUT.browser_console_log,
		handler: handlers.browserConsoleLog,
	}),
	def({
		name: 'browser_har_export',
		title: 'Export the network log as HAR',
		description: 'Export this session’s network log as a HAR 1.2 document, embedded as an application/json ' +
			'resource (at most 1 MiB; lower max_entries if it is larger). Headers are included with credentials ' +
			'[redacted]; cookies and bodies never are. Unless include_full_urls is set (it needs the network grant), ' +
			'request URLs, redirect targets and URLs inside headers are origin and path only and queryString is empty. ' +
			'truncated says the document does not hold every request the session made.',
		inputSchema: z.object({
			session_id: sessionId,
			max_entries: z.number().int().min(1).max(500).optional().describe(
				'The newest requests to include (default 500).',
			),
			include_full_urls: z.boolean().optional().describe(
				'Full URLs and query strings. Needs the network grant.',
			),
		}),
		mutates: false,
		outputSchema: INSPECTION_OUTPUT.browser_har_export,
		handler: handlers.browserHarExport,
	}),
];
