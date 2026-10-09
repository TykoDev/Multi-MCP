/** Navigation tools: moving the focused tab between documents. */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import { OUTPUT } from '../schemas.ts';
import { def, sessionId, type ToolDefinition } from './shared.ts';

export const NAVIGATION_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	// --- navigation --------------------------------------------------------
	def({
		name: 'browser_navigate',
		title: 'Navigate',
		description: "Navigate the session's focused tab to a URL.",
		inputSchema: z.object({
			url: z.string().url().describe('Absolute URL to open.'),
			session_id: sessionId,
			new_session: z.boolean().optional().describe(
				'Create a fresh browser session for this navigation and return its id.',
			),
			profile: z.string().min(1).max(64).optional().describe(
				'With new_session, bind the session to a persistent named profile so cookies and ' +
					'logins survive a restart. One live session per profile.',
			),
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_navigate,
		handler: handlers.browserNavigate,
	}),
	def({
		name: 'browser_go_back',
		title: 'Go back',
		description: "Go back one entry in the focused tab's history.",
		inputSchema: z.object({ session_id: sessionId }),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_go_back,
		handler: handlers.browserGoBack,
	}),
	def({
		name: 'browser_wait_for',
		title: 'Wait for',
		description: 'Block until one condition holds on the session, then report whether it did. ' +
			'A timeout is a normal answer (met: false), not an error. Exactly one condition may be ' +
			'named. navigation, dialog and download are reads of the session event ring and cost ' +
			'nothing; selector and text cost one page search per tick; state_token_changes costs a ' +
			'full page read per second and is the last resort. The returned event carries the ring ' +
			'record that satisfied the wait, whose seq is allocated over the unfiltered stream — a ' +
			'non-contiguous seq is a filtered stream, not a lost event.',
		inputSchema: z.object({
			until: z.object({
				navigation: z.literal(true).optional().describe('Any frame committed a navigation.'),
				selector: z.string().max(500).optional().describe('A CSS selector the page matches.'),
				text: z.string().max(200).optional().describe('Text the page contains.'),
				network_idle: z.number().int().min(0).max(10_000).optional().describe(
					'Milliseconds with nothing in flight. The window restarts on every new request.',
				),
				download: z.literal(true).optional().describe('A download started, finished or failed.'),
				dialog: z.literal(true).optional().describe('The page opened a JavaScript dialog.'),
				state_token_changes: z.string().optional().describe(
					'A state_token that is no longer current, meaning the element table moved.',
				),
			}).refine(
				(until) => Object.values(until).filter((value) => value !== undefined).length === 1,
				{ message: 'until must name exactly one condition' },
			),
			timeout_ms: z.number().int().min(100).max(60_000).optional().describe('Default 10000.'),
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_wait_for,
		handler: handlers.browserWaitFor,
	}),
];
