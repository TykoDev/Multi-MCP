/**
 * MCP Apps tools (R9, design §2.3 and §2.20, D-134): the live view an Apps host embeds, and the ticket its embed
 * spends to open the socket.
 *
 * Both are gated on `TTK_MCP_APPS` through `availability.mcpApps`, so while it is off — named off, clustered or
 * without the embed build (D-150 made `control` the gateway default), and always on stdio, which has no live-view
 * socket to reach — they are registered, disabled, absent from `tools/list`, and a call answers `feature-unavailable`
 * naming the switch. Both are read-only: viewing a session drives nothing, and minting a ticket grants no more than
 * `POST /api/v1/live/ticket` already does for the same credential.
 *
 * Output schemas live beside the definitions (design §2.3), not in `schemas.ts`.
 */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import { def, sessionId, type ToolAvailability, type ToolDefinition } from './shared.ts';

/** The refusal both tools give while the operator has not turned MCP Apps on (design §2.4: no `feature` extra). */
function appsOff(name: string): (state: ToolAvailability) => string | undefined {
	return () => `${name} needs MCP Apps, which is off on this deployment; set TTK_MCP_APPS=watch or control`;
}

/** The success shapes, by tool. Exported so the schema tests read the same table. */
export const APPS_OUTPUT = {
	browser_live_view: z.object({
		session_id: z.string(),
		/** The focused tab's origin, or `null` while it shows a page with none (`about:blank`). Never a path. */
		origin: z.string().nullable(),
		title: z.string(),
		viewers: z.number().int().min(0),
		human_has_control: z.boolean(),
		/** True when this deployment and this credential could take control from the embed. */
		control_available: z.boolean(),
	}),
	browser_live_ticket: z.object({
		ticket: z.string(),
		ws_url: z.string(),
		session_id: z.string(),
		mode: z.enum(['watch', 'control']),
		/** Seconds until the ticket expires. */
		expires_in: z.number().int().min(0),
		/** The origin the socket must present at upgrade; an embed ticket is always bound. */
		origin_bound: z.string(),
		control_plane_url: z.string(),
	}),
} as const;

export const APPS_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	def({
		name: 'browser_live_view',
		title: 'Show the live view',
		description: 'Show a browser session live inside an MCP Apps host. Returns the session’s origin, title, ' +
			'viewer count and whether a human holds control; the host renders the embedded live view, which ' +
			'connects only when the user presses Watch. Never creates a session.',
		inputSchema: z.object({ session_id: sessionId }),
		mutates: false,
		scope: 'view:watch',
		available: (state) => state.mcpApps === true,
		unavailableDetail: appsOff('browser_live_view'),
		outputSchema: APPS_OUTPUT.browser_live_view,
		handler: handlers.browserLiveView,
	}),
	def({
		name: 'browser_live_ticket',
		title: 'Mint an embed ticket',
		description: 'For the embedded live view: mints a single-use live-view ticket that lives 30 seconds and ' +
			'redeems only from origin, the embed’s own origin, which must be one this deployment admits for MCP ' +
			'Apps. Hosts keep this tool from the model.',
		inputSchema: z.object({
			session_id: sessionId,
			mode: z.enum(['watch', 'control']).optional().describe(
				'watch (default) views only; control lets the user take the browser, and needs TTK_MCP_APPS=control.',
			),
			origin: z.string().max(256).describe('The embed’s origin, scheme://host[:port], as its socket will send it.'),
		}),
		mutates: false,
		scope: 'view:watch',
		available: (state) => state.mcpApps === true,
		unavailableDetail: appsOff('browser_live_ticket'),
		outputSchema: APPS_OUTPUT.browser_live_ticket,
		handler: handlers.browserLiveTicket,
	}),
];
