/**
 * Human handoff (R2, design §2.12, D-124): `browser_request_human`, the one tool that asks a person to look at a
 * session through the live view.
 *
 * Offered only by the HTTP gateway, the one mount that has a public URL to hand out (G2: a handoff URL widens
 * reach), and there on by default since D-150, which the owner approved; `TTK_HUMAN_HANDOFF=false` turns it off. stdio
 * never offers it: `availability.handoff` follows `McpDeps.viewUrl`, which only the gateway sets, and only with the
 * switch on.
 * Its output schema lives beside it rather than in `schemas.ts` (design §2.3).
 */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import { def, sessionId, type ToolDefinition } from './shared.ts';

/** What `browser_request_human` returns on success (D-A2: object-rooted, every key declared). */
export const HANDOFF_OUTPUT = {
	browser_request_human: z.object({
		session_id: z.string(),
		/** The live view of this session in the control plane: `<public>/#/view/<id>`, no ticket, no credential. */
		live_view_url: z.string(),
		/** `elicitation`: the client showed the URL to its human (URL-mode elicitation); `link`: it is returned here. */
		delivery: z.enum(['elicitation', 'link']),
		outcome: z.enum(['accepted', 'link-returned']),
		/** Whether a human holds the takeover lock as this result is built. */
		human_has_control: z.boolean(),
		/** The element table's token after the handoff: re-read when the human may have changed the page. */
		state_token: z.string().nullable(),
	}),
} as const;

export const HANDOFF_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	def({
		name: 'browser_request_human',
		title: 'Ask a human to take over',
		description: 'Ask a person to look at this browser session — to solve a CAPTCHA, sign in, or decide something ' +
			'you should not. A client that can open URLs for its user is asked to show them the session’s live view and ' +
			'this call returns once they are done (outcome accepted); any other client gets the live view URL back to ' +
			'show the user itself (outcome link-returned). The URL carries no credential: the person signs in to the ' +
			'control plane and can take control there. Read the page again afterwards with the state_token returned. ' +
			'Never creates a session. Off unless the operator enabled TTK_HUMAN_HANDOFF.',
		inputSchema: z.object({
			session_id: sessionId,
			reason: z.string().min(1).max(500).describe('What you need the person to do, shown to them as written.'),
		}),
		mutates: false,
		scope: 'view:control',
		available: (state) => state.handoff === true,
		unavailableDetail: (state) =>
			state.handoff === true
				? undefined
				: 'browser_request_human is off on this deployment; the operator enables it with TTK_HUMAN_HANDOFF=true',
		outputSchema: HANDOFF_OUTPUT.browser_request_human,
		handler: handlers.browserRequestHuman,
	}),
];
