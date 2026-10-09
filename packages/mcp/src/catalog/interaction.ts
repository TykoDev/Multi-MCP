/**
 * Interaction tools: the ones that put input into the page, plus the autonomous loop (R2) that
 * drives them.
 */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import * as agent from '../agent.ts';
import { OUTPUT } from '../schemas.ts';
import { def, sessionId, stateTokenArg, type ToolDefinition } from './shared.ts';

/**
 * The argument shape of every pointer tool: an index, **or** a viewport point, never both and never
 * neither (B2.4).
 *
 * Declared once and reused by all four, because the refinement is the contract — a click that
 * silently preferred `index` when both were supplied would resolve half the callers' intent and
 * never say which half.
 */
const POINTER_INPUT = z.object({
	index: z.number().int().nonnegative().optional().describe('Interactive element index.'),
	coordinate_x: z.number().optional(),
	coordinate_y: z.number().optional(),
	state_token: stateTokenArg,
	session_id: sessionId,
}).refine(
	(v) =>
		(v.index !== undefined && v.coordinate_x === undefined && v.coordinate_y === undefined) ||
		(v.index === undefined && v.coordinate_x !== undefined && v.coordinate_y !== undefined),
	{ message: 'provide either index, or both coordinate_x and coordinate_y' },
);

/** One end of a drag: an element index, or a viewport point. Exactly one, never both (B2.5). */
const DRAG_ENDPOINT = z.object({
	index: z.number().int().nonnegative().optional(),
	x: z.number().optional(),
	y: z.number().optional(),
}).refine(
	(v) =>
		(v.index !== undefined && v.x === undefined && v.y === undefined) ||
		(v.index === undefined && v.x !== undefined && v.y !== undefined),
	{ message: 'each endpoint is either an index, or both x and y' },
);

export const INTERACTION_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	// --- interaction -------------------------------------------------------
	def({
		name: 'browser_click',
		title: 'Click',
		description:
			'Click an element by its index from browser_get_state, or at viewport coordinates. Provide exactly one of index, or both coordinate_x and coordinate_y.',
		inputSchema: POINTER_INPUT,
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_click,
		handler: handlers.browserClick,
	}),
	def({
		name: 'browser_double_click',
		title: 'Double click',
		description: 'Double-click an element by its index from browser_get_state, or at viewport coordinates. ' +
			'Provide exactly one of index, or both coordinate_x and coordinate_y. The page sees the same two ' +
			'clicks a human produces: click, then dblclick.',
		inputSchema: POINTER_INPUT,
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_double_click,
		handler: handlers.browserDoubleClick,
	}),
	def({
		name: 'browser_right_click',
		title: 'Right click',
		description: 'Right-click an element by its index from browser_get_state, or at viewport coordinates, ' +
			'opening whatever context menu the page defines. Provide exactly one of index, or both ' +
			'coordinate_x and coordinate_y. The browser’s own context menu is not part of the page and is ' +
			'not visible to any tool.',
		inputSchema: POINTER_INPUT,
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_right_click,
		handler: handlers.browserRightClick,
	}),
	def({
		name: 'browser_hover',
		title: 'Hover',
		description: 'Move the pointer onto an element by its index from browser_get_state, or to viewport ' +
			'coordinates, without pressing anything — for menus and tooltips that open on hover. Provide ' +
			'exactly one of index, or both coordinate_x and coordinate_y. The result reports where the ' +
			'pointer landed, and names the element on top when the target is covered.',
		inputSchema: POINTER_INPUT,
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_hover,
		handler: handlers.browserHover,
	}),
	def({
		name: 'browser_type',
		title: 'Type text',
		description: 'Type text into an element by index, or into the currently focused element. To use a ' +
			'server-held credential you have not been shown, write <secret>name</secret> in the text: ' +
			'the server substitutes it on the way to the browser. browser_get_state lists the names ' +
			'usable on the current page under available_secrets.',
		inputSchema: z.object({
			text: z.string(),
			index: z.number().int().nonnegative().optional(),
			clear: z.boolean().optional().describe('Clear the field before typing.'),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_type,
		handler: handlers.browserType,
	}),
	def({
		name: 'browser_press_key',
		title: 'Press key',
		description: 'Press a key or chord, for example "Enter", "Tab", or "Control+a". Modifiers may be given ' +
			'in the key string or in the modifiers array — the two are the same press. Give an index to aim ' +
			'the chord at one element: it takes keyboard focus first, without being clicked.',
		inputSchema: z.object({
			// Bounded (security review B2-SR4-5): `keys` is a sequence grammar — whitespace and commas
			// separate combos — so one call can dispatch one keystroke per token, and the request-body
			// cap that would otherwise bound it is G-8's known gap. 256 characters is far more than any
			// real chord or short sequence and far less than a payload.
			key: z.string().min(1).max(256).describe('Key name or chord.'),
			modifiers: z.array(z.string()).max(4).optional().describe(
				'Modifier names held down for the key: alt, ctrl, meta (cmd, command, super, win) and shift. ' +
					'An unrecognised name is refused rather than ignored.',
			),
			index: z.number().int().nonnegative().optional().describe(
				'Interactive element index to focus before pressing. Omit to press at whatever holds focus.',
			),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_press_key,
		handler: handlers.browserPressKey,
	}),
	def({
		name: 'browser_fill',
		title: 'Fill a field',
		description: 'Replace the contents of a field, clearing it first. browser_type appends; this replaces, ' +
			'which is what a replay into a field the browser has remembered a value for needs. Set clear:false ' +
			'to append instead. Server-held credentials work exactly as in browser_type: write ' +
			'<secret>name</secret> in the text.',
		inputSchema: z.object({
			index: z.number().int().nonnegative().describe('Interactive element index.'),
			text: z.string(),
			clear: z.boolean().optional().describe('Clear the field first. Default true.'),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_fill,
		handler: handlers.browserFill,
	}),
	def({
		name: 'browser_scroll_to',
		title: 'Scroll to a position',
		description: 'Scroll the document to an absolute position in CSS pixels. browser_scroll moves by a ' +
			'number of viewport heights; this one lands at a named point, which is what replaying a ' +
			'recording at its recorded position needs.',
		inputSchema: z.object({
			x: z.number().min(0).max(1_000_000),
			y: z.number().min(0).max(1_000_000),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { idempotent: true, openWorld: true },
		outputSchema: OUTPUT.browser_scroll_to,
		handler: handlers.browserScrollTo,
	}),
	def({
		name: 'browser_scroll_into_view',
		title: 'Scroll an element into view',
		description: 'Bring one element into the viewport, using the browser’s own scrollIntoViewIfNeeded so ' +
			'nested scroll containers and frames are handled by Chromium. The result carries the element’s ' +
			'box afterwards, and null bounds mean the element lives in a cross-origin frame whose ' +
			'coordinates are not the top document’s.',
		inputSchema: z.object({
			index: z.number().int().nonnegative(),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_scroll_into_view,
		handler: handlers.browserScrollIntoView,
	}),
	def({
		name: 'browser_select_option',
		title: 'Select an option',
		description: 'Choose an option in a native <select>, by value, by visible label, or by its position in ' +
			'the option list. Provide exactly one of value, label or index_in_list. The page’s input and ' +
			'change handlers fire, as they do for a human’s choice.',
		inputSchema: z.object({
			index: z.number().int().nonnegative().describe('Interactive element index of the <select>.'),
			value: z.string().max(1024).optional(),
			label: z.string().max(1024).optional().describe('The option’s visible text.'),
			index_in_list: z.number().int().nonnegative().max(10_000).optional().describe(
				'Position within this <select>’s own options — not an element index.',
			),
			state_token: stateTokenArg,
			session_id: sessionId,
		}).refine(
			(v) => [v.value, v.label, v.index_in_list].filter((selector) => selector !== undefined).length === 1,
			{ message: 'provide exactly one of value, label or index_in_list' },
		),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_select_option,
		handler: handlers.browserSelectOption,
	}),
	def({
		name: 'browser_upload_file',
		title: 'Upload a session file',
		description: 'Put a file this session already downloaded onto a file input, by its file_id from ' +
			'browser_list_files. Only files this session holds can be uploaded — there is deliberately no ' +
			'way to send bytes or a path from the client.',
		inputSchema: z.object({
			index: z.number().int().nonnegative().describe('Interactive element index of the file input.'),
			file_id: z.string().max(256),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_upload_file,
		handler: handlers.browserUploadFile,
	}),
	def({
		name: 'browser_handle_dialog',
		title: 'Answer a dialog',
		description: 'Answer a JavaScript alert, confirm, prompt or beforeunload by the dialog_id from the ' +
			'dialog event. The server answers dialogs automatically unless something is subscribed to the ' +
			'dialog event kind — subscribe first (an event stream, or browser_wait_for on dialog) and the ' +
			'browser holds the next dialog open for up to 20 seconds so you can answer it instead. ' +
			'prompt_text is used only for a prompt you accept, and is never echoed back.',
		inputSchema: z.object({
			dialog_id: z.string().max(64).describe('From the dialog event’s dialog_id.'),
			accept: z.boolean(),
			prompt_text: z.string().max(4096).optional().describe('Text for an accepted prompt.'),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_handle_dialog,
		handler: handlers.browserHandleDialog,
	}),
	def({
		name: 'browser_drag',
		title: 'Drag',
		description: 'Press at one point, move across, and release at another — for sliders, sortable lists and ' +
			'drag-and-drop. Each endpoint is an element index or a viewport coordinate pair.',
		inputSchema: z.object({
			from: DRAG_ENDPOINT,
			to: DRAG_ENDPOINT,
			steps: z.number().int().min(1).max(50).optional().describe(
				'Intermediate mouse moves between press and release. Default 10; more is smoother and slower.',
			),
			state_token: stateTokenArg,
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_drag,
		handler: handlers.browserDrag,
	}),
	def({
		name: 'browser_scroll',
		title: 'Scroll',
		description: 'Scroll the page up or down by a number of viewport heights.',
		inputSchema: z.object({
			direction: z.enum(['up', 'down']),
			pages: z.number().positive().max(10).optional().describe('Viewport heights to scroll. Default 0.75.'),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_scroll,
		handler: handlers.browserScroll,
	}),

	// --- B2.8: filling a server-held credential -------------------------------
	//
	// Deliberately stricter than `browser_type`, which still accepts `<secret>` placeholders and an
	// unpinned secret. Once `type=text` is permitted the "is this a password field" check carries no
	// weight, so the domain pin is the only control left — which is why this surface requires one.
	def({
		name: 'browser_fill_secret',
		title: 'Fill a field with a server-held secret',
		description: 'Type a credential the operator configured on this server into a form field, without the ' +
			'secret ever appearing in your context, the tool call or the transcript. You name the secret; the ' +
			'server holds the value. Stricter than browser_type’s <secret> placeholder in four ways, each a ' +
			'refusal rather than a silent fallback: state_token is required and a stale one is refused outright; ' +
			'the element must be an input or textarea of type password or text; the secret must declare domains ' +
			'(an unpinned secret is refused here even though browser_type allows one); and the secret’s domains ' +
			'are checked against the live URL of the frame the element is in, read immediately before typing, ' +
			'with a cross-origin frame refused. The result names the secret and never its value, its length or ' +
			'any part of it. Every use is recorded in the session audit ledger, readable with browser_audit.',
		inputSchema: z.object({
			index: z.number().int().nonnegative().describe('The field to fill, from browser_get_state.'),
			secret: z.string().min(1).max(64).describe('The configured secret’s NAME, as browser_get_state lists it.'),
			state_token: z.string().min(1).describe(
				'REQUIRED. The state_token from the browser_get_state the index was read from; a mismatch is ' +
					'refused outright rather than re-resolved.',
			),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		outputSchema: OUTPUT.browser_fill_secret,
		handler: handlers.browserFillSecret,
	}),

	// --- B2.7: arbitrary in-page JavaScript, behind the explicit grant --------
	//
	// The description is written to D-A4's own words and the word "sandbox" is not in it. It states
	// what evaluated code can reach, because a caller that believes it is running inside a sandbox
	// will make a decision this server cannot honour — and `SPECS/SECURITY-AUTH.md` §1 and §8 carry
	// the same sentence, amended in the same change (SEC-02).
	def({
		name: 'browser_evaluate',
		title: 'Evaluate JavaScript in the page',
		description: 'Run a JavaScript expression in a frame of this session and return its value. Requires the ' +
			'evaluate scope, which no principal holds unless a deployment named it. There is no restricted ' +
			'subset and no isolated context: the expression runs in the frame’s own main world, with the ' +
			'page’s DOM, its non-HttpOnly cookies and its network, using the browser’s existing logins. The ' +
			'server’s domain allowlist (TTK_ALLOWED_DOMAINS) does NOT constrain where an evaluated fetch may ' +
			'send data unless the deployment sets TTK_ALLOWED_DOMAINS_SCOPE=all — by default it gates ' +
			'navigation, and an in-page request is not a navigation. The expression body ' +
			'is never recorded, so a credential inlined into one is put somewhere the audit ledger cannot ' +
			'un-put it: reference server-held secrets by name through browser_fill_secret instead. Execution ' +
			'is capped at 1 s and the returned value at 64 KiB, with truncated:true when the cap bound it; a ' +
			'page exception is ok:false, not an error. What you send is an expression and not a program: a ' +
			'multi-statement body is a syntax error, and a frame_id naming a frame that shares the top ' +
			'document’s renderer runs it on a handle to that frame’s own window, which is what makes ' +
			'frame_id mean the frame you named. On that one path the 1 s cap is this server’s deadline ' +
			'alone and the renderer carries none of its own, so an expression that never returns is ' +
			'abandoned by the server and keeps running in that frame until it finishes or the frame ' +
			'navigates.',
		inputSchema: z.object({
			expression: z.string().min(1).max(8192).describe('The JavaScript expression to evaluate.'),
			frame_id: z.string().max(128).optional().describe(
				'Frame from browser_get_frames. Omit for the focused document.',
			),
			timeout_ms: z.number().int().min(1).max(1000).optional().describe(
				'Evaluation deadline. Default and ceiling 1000 ms.',
			),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		scope: 'evaluate',
		outputSchema: OUTPUT.browser_evaluate,
		handler: handlers.browserEvaluate,
	}),

	// --- autonomous task loop (R2) -------------------------------------------
	def({
		name: 'browser_run_task',
		title: 'Run a browser task',
		description: 'Complete a task in the browser autonomously, one action per step, deciding each action with ' +
			'YOUR model through MCP sampling. Each step costs one client round trip, so the number of ' +
			'steps is also bounded by the client’s inputRequired.maxRounds (10 by default). If the step ' +
			'budget runs out the run is parked: call again with resume:true to continue it rather than ' +
			'starting over. Requires the task scope.',
		inputSchema: z.object({
			task: z.string().min(1).optional().describe('What to accomplish. Required unless resume is true.'),
			max_steps: z.number().int().positive().max(25).optional().describe('Action budget. Default 8.'),
			resume: z.boolean().optional().describe('Continue the session’s parked run instead of starting one.'),
			session_id: sessionId,
		}),
		mutates: true,
		hints: { openWorld: true },
		scope: 'task',
		outputSchema: OUTPUT.browser_run_task,
		handler: agent.browserRunTask,
	}),
];
