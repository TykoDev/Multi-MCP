/** Session-file tools (E-33). */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import { OUTPUT } from '../schemas.ts';
import { def, sessionId, stateTokenArg, type ToolDefinition } from './shared.ts';

export const FILE_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	// --- session files (E-33) ---------------------------------------------------
	// Both are read-only *peeks*: they never create a browser, and they stay
	// usable while a human holds the session, because reading what the browser
	// already downloaded is observation, not interference.
	def({
		name: 'browser_list_files',
		title: 'List downloaded files',
		description: 'List the files this session has downloaded, including downloads still in progress and ' +
			'ones that failed. Each entry carries a file_id for browser_get_file and available:true once the ' +
			'bytes can be fetched. Downloads are started by clicking or navigating in the browser; a click that ' +
			'starts one reports it in its result. Poll this for exports that take time to arrive.',
		inputSchema: z.object({ session_id: sessionId }),
		mutates: false,
		outputSchema: OUTPUT.browser_list_files,
		handler: handlers.browserListFiles,
	}),
	def({
		name: 'browser_get_file',
		title: 'Get a downloaded file',
		description: 'Fetch a file listed by browser_list_files. delivery "inline" (the default) returns the bytes ' +
			'as an embedded resource for files up to 1 MiB; delivery "link" returns a resource link plus, when ' +
			'the server runs over HTTP, an authenticated download URL (same bearer credential and mcp:invoke ' +
			'scope as /mcp) that streams any size. An oversized inline request is an error, never a truncation. ' +
			'delivery "stream" is the same URL with the endpoint’s Range support stated: ask for bytes=start-end ' +
			'to resume a transfer or read a window of a file too large to want whole. A range outside the file is ' +
			'refused with 416, never silently clamped. Every listing entry carries sha256 once the digest is ' +
			'computed.',
		inputSchema: z.object({
			file_id: z.string().min(1).max(128).describe('The file_id from browser_list_files.'),
			session_id: sessionId,
			delivery: z.enum(['inline', 'link', 'stream']).optional().describe(
				'inline (default, ≤ 1 MiB), link, or stream.',
			),
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_get_file,
		handler: handlers.browserGetFile,
	}),
	// --- B1.12 ---------------------------------------------------------------
	def({
		name: 'browser_download',
		title: 'Download a file',
		description: 'Start a download by clicking an element (index) or navigating to a URL, and return the ' +
			'file_id it will be readable under with browser_get_file. Exactly one of index or url. ' +
			'started:false is a success, not an error: a click that navigated instead, or a download the ' +
			'browser has not announced yet, is a truthful answer about the page — poll browser_list_files, ' +
			'which stays authoritative. The deployment domain allowlist applies exactly as it does to ' +
			'browser_navigate.',
		inputSchema: z.object({
			index: z.number().int().min(0).optional().describe('The element to click, from browser_get_state.'),
			url: z.string().max(2048).optional().describe('The URL to navigate to instead.'),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_download,
		handler: handlers.browserDownload,
	}),
	def({
		name: 'browser_head',
		title: 'Ask about a URL without downloading it',
		description: 'Ask a server about a URL — status, content type, length, filename, final URL — with a ' +
			'cookie-less HEAD request issued by this server, never by the browser: a link behind a login answers ' +
			'the way an anonymous client sees it. No body is transferred. Redirects are followed by this server ' +
			'one hop at a time, every hop checked against the deployment domain allowlist and refused if it points ' +
			'at a loopback, private or link-local address; final_url reports where the chain ended (origin and ' +
			'path only). Offered only where the operator has granted outbound network access to this server; a ' +
			'host outside that grant answers feature-unavailable. It is also withheld, and refuses if called ' +
			'anyway, where the browser is given its own proxy (a proxy flag in TTK_BROWSER_ARGS): this request ' +
			'is the server’s and follows the process proxy environment, so it would otherwise answer about a ' +
			'different network path from the one the browser uses.',
		inputSchema: z.object({
			url: z.string().min(1).max(2048).describe('The URL to ask about.'),
		}),
		mutates: false,
		hints: { openWorld: true },
		// Two static deployment facts, and the tool needs both: a proven outbound
		// grant (SR-HEAD-REDIRECT) and a browser this server's own request can
		// follow (SR3-M2). The second carries its own sentence rather than a
		// boolean, so a caller that reaches the tool anyway is told which flag and
		// what to do instead of "needs egress on this deployment".
		available: (state) => state.egress && (state.headRouting ?? null) === null,
		unavailableDetail: (state) => state.headRouting ?? undefined,
		outputSchema: OUTPUT.browser_head,
		handler: handlers.browserHead,
	}),
	// --- B2.9 -----------------------------------------------------------------
	def({
		name: 'browser_file_policy',
		title: 'Read the file retention and transfer policy',
		description: 'Report the limits this deployment actually enforces on downloaded files, so a caller can ' +
			'schedule its own cleanup instead of guessing: how many files a session may hold, the per-file and ' +
			'per-session byte caps, the transfer deadline, the inline-delivery limit, and whether the download ' +
			'endpoint honours Range. Retention is the session’s lifetime rather than a number of hours — files ' +
			'go when the session closes or is reaped, after a grace period for reads still open — so the answer ' +
			'is a mode plus the idle timeout in force.',
		inputSchema: z.object({}),
		mutates: false,
		outputSchema: OUTPUT.browser_file_policy,
		handler: handlers.browserFilePolicy,
	}),
];
