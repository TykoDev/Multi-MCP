/** Session tools: tabs, session lifecycle, persistent storage state (R3) and recording (R7). */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import { OUTPUT } from '../schemas.ts';
import { def, sessionId, type ToolDefinition } from './shared.ts';

export const SESSION_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	// --- session introspection and options (B2.6) ----------------------------
	def({
		name: 'browser_get_session',
		title: 'Session details',
		description: 'Everything the server knows about one session: profile, timestamps, the viewport it is ' +
			'emulating, its tabs, who holds the takeover lock, the idle timeout it is subject to, the origin ' +
			'allow-list effective for you, and how many viewers and files it has. Read-only, so it answers ' +
			'while a human holds the session — which is when you most want to know who that is.',
		inputSchema: z.object({ session_id: sessionId }),
		mutates: false,
		outputSchema: OUTPUT.browser_get_session,
		handler: handlers.browserGetSession,
	}),
	def({
		name: 'browser_set_viewport',
		title: 'Set the viewport',
		description: 'Emulate a viewport for every tab of the session, so a recording replays at the size it ' +
			'was recorded at. device_scale is the device pixel ratio (window.devicePixelRatio), not page ' +
			'zoom; there is deliberately no way to set page zoom.',
		inputSchema: z.object({
			width: z.number().int().min(200).max(4096),
			height: z.number().int().min(200).max(4096),
			device_scale: z.number().min(1).max(4).optional().describe('Device pixel ratio. Default 1.'),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { idempotent: true },
		outputSchema: OUTPUT.browser_set_viewport,
		handler: handlers.browserSetViewport,
	}),
	def({
		name: 'browser_set_session_options',
		title: 'Set session options',
		description: 'Reconfigure a live session: viewport, locale, timezone, user agent, idle timeout. The ' +
			'result reports what actually took effect in applied, and what this deployment could not apply ' +
			'in unsupported — a field named there was not set, whatever you asked for.',
		inputSchema: z.object({
			viewport: z.object({
				width: z.number().int().min(200).max(4096),
				height: z.number().int().min(200).max(4096),
			}).optional(),
			locale: z.string().max(35).optional().describe('BCP 47, for example "fr-FR".'),
			timezone: z.string().max(64).optional().describe('IANA name, for example "Europe/Amsterdam".'),
			user_agent: z.string().max(512).optional(),
			accept_downloads: z.boolean().optional().describe(
				'Allow (true) or deny (false) downloads from now on; reported in unsupported if the browser refused.',
			),
			idle_timeout_s: z.number().int().min(60).max(86_400).optional(),
			session_id: sessionId,
		}).refine(
			(v) =>
				[v.viewport, v.locale, v.timezone, v.user_agent, v.accept_downloads, v.idle_timeout_s]
					.some((option) => option !== undefined),
			{ message: 'name at least one option to set' },
		),
		mutates: true,
		outputSchema: OUTPUT.browser_set_session_options,
		handler: handlers.browserSetSessionOptions,
	}),

	// --- tabs ---------------------------------------------------------------
	def({
		name: 'browser_list_tabs',
		title: 'List tabs',
		description: 'List the open tabs in the session.',
		inputSchema: z.object({ session_id: sessionId }),
		mutates: false,
		outputSchema: OUTPUT.browser_list_tabs,
		handler: handlers.browserListTabs,
	}),
	def({
		name: 'browser_switch_tab',
		title: 'Switch tab',
		description: 'Focus a tab by its id (from browser_list_tabs).',
		inputSchema: z.object({
			tab_id: z.string(),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { idempotent: true },
		outputSchema: OUTPUT.browser_switch_tab,
		handler: handlers.browserSwitchTab,
	}),
	def({
		name: 'browser_close_tab',
		title: 'Close tab',
		description: 'Close a tab by its id.',
		inputSchema: z.object({
			tab_id: z.string(),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { destructive: true, idempotent: true },
		outputSchema: OUTPUT.browser_close_tab,
		handler: handlers.browserCloseTab,
	}),

	// --- persistent state (R3) ----------------------------------------------
	def({
		name: 'browser_storage_state',
		title: 'Save or load storage state',
		description: 'Save the session’s cookies and origin storage under a name, or load a previously saved ' +
			'one into it. The document stays on the server and is never returned: it contains live ' +
			'session cookies. Needs TTK_DATA_DIR.',
		inputSchema: z.object({
			action: z.enum(['save', 'load']),
			name: z.string().min(1).max(64).describe('The name to save under, or to load from.'),
			session_id: sessionId,
		}),
		mutates: true,
		available: (state) => state.persistence,
		outputSchema: OUTPUT.browser_storage_state,
		handler: handlers.browserStorageState,
	}),

	// --- recording (R7) -------------------------------------------------------
	def({
		name: 'browser_record',
		title: 'Record the session',
		description: 'Start, stop, or check a video recording of the session. The finished file is downloaded ' +
			'over HTTP from the url in the stop result, not returned here. Needs TTK_DATA_DIR and ffmpeg.',
		inputSchema: z.object({
			action: z.enum(['start', 'stop', 'status']),
			name: z.string().min(1).max(64).optional().describe('Name to save under. Defaults to a timestamp.'),
			session_id: sessionId,
		}),
		mutates: false,
		available: (state) => state.recording,
		outputSchema: OUTPUT.browser_record,
		handler: handlers.browserRecord,
	}),

	// --- sessions -----------------------------------------------------------
	def({
		name: 'browser_list_sessions',
		title: 'List sessions',
		description: 'List active browser sessions, including whether a human currently holds control of each.',
		inputSchema: z.object({}),
		mutates: false,
		outputSchema: OUTPUT.browser_list_sessions,
		handler: handlers.browserListSessions,
	}),
	def({
		name: 'browser_close_session',
		title: 'Close session',
		description: 'Close one browser session and its browser.',
		inputSchema: z.object({ session_id: z.string() }),
		mutates: true,
		hints: { destructive: true, idempotent: true },
		outputSchema: OUTPUT.browser_close_session,
		handler: handlers.browserCloseSession,
	}),
	def({
		name: 'browser_close_all',
		title: 'Close all sessions',
		description: 'Close every browser session. Requires the admin scope.',
		inputSchema: z.object({}),
		mutates: true,
		hints: { destructive: true },
		scope: 'admin',
		outputSchema: OUTPUT.browser_close_all,
		handler: handlers.browserCloseAll,
	}),
	// --- B3.2: the operational read surface -----------------------------------
	//
	// No catalog `scope` beyond the `mcp:invoke` every tool needs, and no `available` predicate: a
	// health check that a deployment could disable is one an operator cannot rely on. What differs
	// per principal is the `capabilities` block it carries, which is filtered by its own builder.
	def({
		name: 'browser_health',
		title: 'Server health',
		description: 'Report whether this server is serving and what this credential may do with it. Returns the ' +
			'session counts (total, how many have a live browser, how many a human is holding, viewers, tabs), ' +
			'the server version, and the same capabilities block the initialize result carries — so a client can ' +
			'poll for a deployment change without reconnecting. Never creates a session.',
		inputSchema: z.object({}),
		mutates: false,
		outputSchema: OUTPUT.browser_health,
		handler: handlers.browserHealth,
	}),
	// --- B2.8: the audit ledger's only reader ---------------------------------
	//
	// No catalog `scope`, deliberately: the tool is useful to an `mcp:invoke` principal and to an
	// `admin` one, and only its rows differ (SEC-08). The filter is in the handler, which is where a
	// narrowing belongs when the alternative is taking the affordance away entirely.
	def({
		name: 'browser_audit',
		title: 'Read the session audit ledger',
		description: 'List the privileged operations recorded for this session: every use of a server-held secret ' +
			'and every browser_evaluate call. With the admin scope you see all entries; otherwise you see your ' +
			'own, and scope in the result says which you got. Entries carry the secret’s NAME, the element, the ' +
			'frame and the origin — never a value, never a length or hash of one, and for an evaluated ' +
			'expression only its byte count and a 16-character digest, never any part of its body. The ledger is ' +
			'in memory, holds the most recent 200 entries per session (dropped counts what the ring evicted), ' +
			'dies with the session and is never written to disk.',
		inputSchema: z.object({
			since: z.string().max(64).optional().describe('Return entries after this audit_id. Ids sort chronologically.'),
			limit: z.number().int().min(1).max(200).optional().describe('Most recent entries to return. Default 50.'),
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_audit,
		handler: handlers.browserAudit,
	}),
];
