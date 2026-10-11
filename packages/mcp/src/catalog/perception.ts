/**
 * Perception tools: the read-only ones that describe the page, including the sampling-backed
 * extraction (R1).
 */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import * as agent from '../agent.ts';
import { LOCATOR_KINDS } from '../locators.ts';
import { OUTPUT } from '../schemas.ts';
import {
	def,
	elementLimitArg,
	fieldsArg,
	frameIdArg,
	framesArg,
	includeHiddenArg,
	sessionId,
	stateTokenArg,
	type ToolDefinition,
} from './shared.ts';

export const PERCEPTION_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	// --- observation (read-only) -------------------------------------------
	def({
		name: 'browser_get_state',
		title: 'Get page state',
		description:
			'The primary perception tool: returns the current URL, title, open tabs, and the interactive-element tree with ' +
			'indices for clicking and typing. structuredContent carries the rich element record (geometry in top-document ' +
			'viewport CSS px, focus, live values, frame identity, a locator) selected by fields; the text block keeps the ' +
			'five-field record. bounds is where the server believes an element is and, for an element in a cross-origin ' +
			'frame, where it clicks; for a top-document element the server uses live quads and may click elsewhere if the ' +
			'element is transformed. Use bounds to draw, rank and for near; use index to act. A password field never ' +
			'reports its value. browser_get_html is the exception: it returns the document verbatim.',
		inputSchema: z.object({
			include_screenshot: z.boolean().optional(),
			fields: fieldsArg,
			element_limit: elementLimitArg,
			include_hidden: includeHiddenArg,
			frames: framesArg,
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_get_state,
		handler: handlers.browserGetState,
	}),
	// --- B1.6: find, frames, locators (needed-browser-functions §1.3, §1.4, §7) ---
	def({
		name: 'browser_find',
		title: 'Find elements',
		description: 'Rank the interactive elements of the current page against a query: role, name (the accessible ' +
			'name), text, a CSS selector (evaluated by the browser), an href regular expression, and/or near {x,y} in ' +
			'top-document viewport CSS px. Every named predicate must hold. score is a ranking aid, not a probability. ' +
			'The state_token names the table the returned indices are valid in.',
		inputSchema: z.object({
			query: z.object({
				role: z.string().optional(),
				name: z.string().optional(),
				text: z.string().optional(),
				css: z.string().max(500).optional(),
				href_pattern: z.string().max(200).optional().describe(
					'A regular expression tested against href, server-side, over at most 2000 hrefs under a 2 s budget.',
				),
				near: z.object({ x: z.number(), y: z.number() }).optional(),
				frame_id: z.string().optional(),
			}),
			limit: z.number().int().min(1).max(50).optional().describe('Default 5.'),
			fields: fieldsArg,
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_find,
		handler: handlers.browserFind,
	}),
	// --- B2.1: the hit test in the browser (needed-browser-functions §1.5) ---
	def({
		name: 'browser_element_at',
		title: 'Element at a point',
		description: 'The topmost interactive element under a point, in top-document viewport CSS px — the same ' +
			'space as bounds. The browser performs the hit test (DOM.getNodeForLocation), so transforms, occlusion, ' +
			'stacking contexts and cross-origin frames are resolved by Chromium rather than by arithmetic over bounds; ' +
			'a hit on text inside a control resolves to the control. element:null is a success: nothing interactive is ' +
			'there. The index is joined to the table named by state_token; call browser_get_state first, and again if ' +
			'the page moved.',
		inputSchema: z.object({
			x: z.number(),
			y: z.number(),
			fields: fieldsArg,
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_element_at,
		handler: handlers.browserElementAt,
	}),
	def({
		name: 'browser_get_frames',
		title: 'List frames',
		description: 'The frames of the current page, root first: id (the join key for element frame_id), name, the ' +
			"frame's own URL, parent, the host element's box in top-document viewport CSS px, bounds_composed (false " +
			"when the frame's geometry could not be established), is_oopif and captured. capture_truncated is true when " +
			'deeper frames were skipped.',
		inputSchema: z.object({ session_id: sessionId }),
		mutates: false,
		outputSchema: OUTPUT.browser_get_frames,
		handler: handlers.browserGetFrames,
	}),
	def({
		name: 'browser_locator_candidates',
		title: 'Locator candidates',
		description: 'Every locator candidate for one element of the table you hold, ranked testid, id, name, aria, ' +
			"label, css, text, each with its match count in the element's own document as of that capture. best is the " +
			'first unique candidate, else the first. Use browser_verify_locator to ask the browser what it matches now.',
		inputSchema: z.object({
			index: z.number().int().nonnegative(),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_locator_candidates,
		handler: handlers.browserLocatorCandidates,
	}),
	def({
		name: 'browser_verify_locator',
		title: 'Verify a locator',
		description: 'Ask the browser what a locator matches today. Selector kinds and text go through DOM.performSearch ' +
			"in the frame's own session (Chromium's own matcher, which also matches the query as plain text); aria and " +
			"label are counted over the frame's merged accessibility nodes. id, testid and name take the selector " +
			'browser_locator_candidates emits or the bare attribute value (username means #username). matches:0 with ' +
			'first:null is a success, not an error. frame_id defaults to the top document.',
		inputSchema: z.object({
			locator: z.object({ kind: z.enum(LOCATOR_KINDS), value: z.string().min(1).max(1000) }),
			frame_id: z.string().optional(),
			fields: fieldsArg,
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_verify_locator,
		handler: handlers.browserVerifyLocator,
	}),
	def({
		name: 'browser_get_html',
		title: 'Get HTML',
		description: 'Return the raw outer HTML of a document of this session, truncated at 200000 characters. Omit ' +
			'frame_id for the focused top document. With frame_id (from browser_get_frames) the bytes are ' +
			'that frame’s own document and never the top document: an unknown, detached or unreachable frame ' +
			'is a structured error, not a fall back. frame_id is ephemeral — rediscover it per run. A frame ' +
			'whose own origin differs from the top document requires the evaluate scope and writes an audit ' +
			'entry; a same-origin frame requires nothing beyond the scope you already hold. length is ' +
			'the document’s true length even when truncated is true, and returned_length is what the text ' +
			'block carries — both measured by this server after truncation, so returned_length never ' +
			'exceeds 200000 and length is never smaller than it, whatever the page claims about its own ' +
			'size. url is the frame’s own URL, read live at the moment of the call.',
		inputSchema: z.object({ frame_id: frameIdArg, session_id: sessionId }),
		mutates: false,
		outputSchema: OUTPUT.browser_get_html,
		handler: handlers.browserGetHtml,
	}),
	def({
		name: 'browser_screenshot',
		title: 'Screenshot',
		description: 'Capture a PNG screenshot of the focused tab.',
		inputSchema: z.object({
			full_page: z.boolean().optional(),
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_screenshot,
		handler: handlers.browserScreenshot,
	}),

	// --- model-backed observation (R1) ---------------------------------------
	def({
		name: 'browser_extract_content',
		title: 'Extract content',
		description: 'Answer a question about the current page. The answer is produced by YOUR model through ' +
			'MCP sampling — this server holds no model and no provider key — so the client must support ' +
			'sampling. Read-only: it works while a human holds control of the session.',
		inputSchema: z.object({
			query: z.string().min(1).describe('What to extract, as a question or an instruction.'),
			session_id: sessionId,
		}),
		mutates: false,
		outputSchema: OUTPUT.browser_extract_content,
		handler: agent.browserExtractContent,
	}),
];
