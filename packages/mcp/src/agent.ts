/**
 * The two tools that need a model: content extraction (R1) and the autonomous
 * task loop (R2).
 *
 * Both borrow the *client's* model through MCP sampling rather than calling a
 * provider. That is the whole point: no provider key lives in this container,
 * no second model has to be chosen and paid for, and the user's own client
 * stays in the loop and can refuse. The roadmap's R2 entry contemplated
 * pulling `@bua/llm` and provider credentials in; sampling makes that
 * unnecessary, so it is not done.
 *
 * ## How a tool asks a question mid-call
 *
 * On the 2026-07-28 revision a server cannot push a request at a client
 * mid-tool-call: the handler returns `input_required` and the client re-invokes
 * the tool with the answer in `inputResponses`. The SDK's legacy shim drives
 * the same shape over the 2025 era, so one implementation serves both. Handlers
 * here are therefore written as *resumable steps*, not as loops that await.
 *
 * ## Where the loop's memory lives
 *
 * On the session record, not in `requestState`. `requestState` round-trips
 * through the client and has to be treated as untrusted on the way back, so
 * putting a growing transcript in it would mean re-validating a large
 * attacker-controllable blob every round. The session already is the stateful
 * anchor for everything else here; a short opaque token in `requestState`
 * names the run, and the run itself never leaves the server.
 *
 * F3 (D-126): that token used to be minted and never read, so a late answer for
 * a run that had since been replaced drove the replacement. It is now sealed by
 * the factory's HMAC codec as `{k: 'run', run, s}` and compared with the run the
 * session holds before any answer is applied.
 */
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { CreateMessageRequestParams, CreateMessageResult, Tool } from '@modelcontextprotocol/server';
import { ToolError } from './errors.ts';
import { observe, promptBlock } from './observe.ts';
import type { AgentRun, SessionRecord } from './registry.ts';
import { json, type ToolContext, type ToolResult } from './types.ts';

/** Cap on the page text handed to a model, in characters. */
const PROMPT_PAGE_LIMIT = 24_000;
/** Sampling budget per step. */
const EXTRACT_MAX_TOKENS = 2_000;
const STEP_MAX_TOKENS = 1_000;
/** Hard ceiling on `max_steps`, whatever a caller asks for. */
export const MAX_TASK_STEPS = 25;

// --- R1: extraction ---------------------------------------------------------

const EXTRACT_KEY = 'extract';

const EXTRACT_SYSTEM = 'You extract information from a web page. You are given the page as text plus its list of ' +
	'interactive elements. Answer only from what the page says. If the page does not contain the ' +
	'answer, say so plainly rather than guessing. Be concise and concrete: quote values, names and ' +
	'numbers exactly as they appear.';

/**
 * Answers a question about the current page using the client's model.
 *
 * Two rounds: the first returns `input_required` carrying the page and the
 * question; the second reads the model's answer and returns it. Read-only — it
 * never touches the page, so it works while a human holds the takeover lock.
 */
export async function browserExtractContent(
	args: { query: string; session_id?: string; include_page?: boolean },
	ctx: ToolContext,
): Promise<ToolResult> {
	ctx.signal?.throwIfAborted();
	// R8 (D-128): the caller's own session in `owner` mode, as every other tool resolves it.
	const record = await ctx.registry.resolve(args.session_id, ctx.access);

	const answered = samplingText(ctx, EXTRACT_KEY);
	if (answered !== null) {
		ctx.registry.touch(record.id);
		return json({
			session_id: record.id,
			query: args.query,
			result: answered.text,
			model: answered.model,
		});
	}

	assertSamplingAvailable(ctx, 'browser_extract_content');
	const observation = await observe(record, { maxPageChars: PROMPT_PAGE_LIMIT, signal: ctx.signal });
	ctx.registry.touch(record.id);
	// A10: a question the caller has stopped waiting for is not put to its model.
	ctx.signal?.throwIfAborted();

	const prompt = `${promptBlock(observation)}\n\n---\nQuestion: ${args.query}`;
	return inputRequired({
		inputRequests: {
			[EXTRACT_KEY]: inputRequired.createMessage({
				systemPrompt: EXTRACT_SYSTEM,
				maxTokens: EXTRACT_MAX_TOKENS,
				messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
			}),
		},
	}) as ToolResult;
}

// --- R2: the task loop ------------------------------------------------------

const STEP_KEY = 'step';

const TASK_SYSTEM = `You are driving a real web browser to complete a task. Each turn you are shown \
the current page and you reply with exactly one action, as a single JSON object and nothing else.

Actions:
  {"thought":"why","action":"navigate","url":"https://…"}
  {"thought":"why","action":"click","index":N}
  {"thought":"why","action":"type","index":N,"text":"…","clear":true}
  {"thought":"why","action":"press_key","key":"Enter"}
  {"thought":"why","action":"scroll","direction":"down","pages":1}
  {"thought":"why","action":"go_back"}
  {"thought":"why","action":"switch_tab","tab_id":"AB12"}
  {"thought":"why","action":"done","answer":"what you found or did"}

Rules:
- Indices come from the element list shown to you and change after every action; never reuse an old one.
- Prefer "done" as soon as the task is achieved. Do not keep exploring.
- If the task cannot be completed, use "done" and say why in the answer.
- Reply with the JSON object only. No prose, no code fences.`;

interface AgentAction {
	thought?: string;
	action: string;
	url?: string;
	index?: number;
	text?: string;
	clear?: boolean;
	key?: string;
	direction?: 'up' | 'down';
	pages?: number;
	tab_id?: string;
	answer?: string;
}

/** The optional `thought` every action tool takes, so a model that reasons aloud has somewhere to put it. */
const THOUGHT = { thought: { type: 'string', description: 'Why this action, in one sentence.' } } as const;

/**
 * R6 (D-126): the eight actions of {@linkcode TASK_SYSTEM} as sampling tools, for a client that declared
 * `sampling.tools`. One tool per `AgentAction` member, with the same field names, so a `tool_use` answer becomes
 * `{...input, action: name}` and runs through exactly the code path a JSON reply does — `perform` validates every
 * field again, and a tool name outside these eight is a failed step, not a crash.
 */
export const AGENT_TOOLS: readonly Tool[] = [
	{
		name: 'navigate',
		description: 'Load a URL in the current tab.',
		inputSchema: { type: 'object', properties: { ...THOUGHT, url: { type: 'string' } }, required: ['url'] },
	},
	{
		name: 'click',
		description: 'Click the element with this index from the element list.',
		inputSchema: { type: 'object', properties: { ...THOUGHT, index: { type: 'integer' } }, required: ['index'] },
	},
	{
		name: 'type',
		description: 'Type text into the element with this index, or into the focused element when index is omitted.',
		inputSchema: {
			type: 'object',
			properties: {
				...THOUGHT,
				index: { type: 'integer' },
				text: { type: 'string' },
				clear: { type: 'boolean', description: 'Clear the field first.' },
			},
			required: ['text'],
		},
	},
	{
		name: 'press_key',
		description: 'Press a key or a chord, for example Enter or Control+A.',
		inputSchema: { type: 'object', properties: { ...THOUGHT, key: { type: 'string' } }, required: ['key'] },
	},
	{
		name: 'scroll',
		description: 'Scroll the page by viewport heights.',
		inputSchema: {
			type: 'object',
			properties: { ...THOUGHT, direction: { type: 'string', enum: ['up', 'down'] }, pages: { type: 'number' } },
			required: ['direction'],
		},
	},
	{
		name: 'go_back',
		description: 'Go back one entry in the tab history.',
		inputSchema: { type: 'object', properties: { ...THOUGHT } },
	},
	{
		name: 'switch_tab',
		description: 'Focus the tab with this id.',
		inputSchema: { type: 'object', properties: { ...THOUGHT, tab_id: { type: 'string' } }, required: ['tab_id'] },
	},
	{
		name: 'done',
		description: 'Finish the task, with what you found or did — or why it cannot be completed.',
		inputSchema: { type: 'object', properties: { ...THOUGHT, answer: { type: 'string' } }, required: ['answer'] },
	},
];

/**
 * The task prompt for a client that answers through {@linkcode AGENT_TOOLS}: the rules of {@linkcode TASK_SYSTEM}
 * without the JSON grammar, which the tool definitions now carry.
 */
const TASK_SYSTEM_TOOLS = `You are driving a real web browser to complete a task. Each turn you are shown \
the current page and you call exactly one of the tools you are given.

Rules:
- Indices come from the element list shown to you and change after every action; never reuse an old one.
- Prefer "done" as soon as the task is achieved. Do not keep exploring.
- If the task cannot be completed, call "done" and say why in the answer.`;

/**
 * Runs a task autonomously, one model-chosen action per round trip.
 *
 * The number of rounds is bounded twice: by `max_steps` here, and by the
 * *client's* `inputRequired.maxRounds` (10 by default in the SDK client). When
 * the step budget runs out the run is left on the session and the result says
 * so, so a caller can continue it with `resume: true` rather than starting
 * over — which matters, because "start over" on a browser task means redoing
 * side effects.
 */
export async function browserRunTask(
	args: { task?: string; max_steps?: number; resume?: boolean; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	// A10: a cancelled round does nothing at all — no step is counted and the run stays parked for `resume`.
	ctx.signal?.throwIfAborted();
	// R8 (D-128): the caller's own session in `owner` mode, as every other tool resolves it.
	const record = await ctx.registry.resolve(args.session_id, ctx.access);
	ctx.registry.assertUnlocked(record);

	// --- continuing an in-flight round -------------------------------------
	const answered = samplingText(ctx, STEP_KEY, true);
	if (answered !== null) {
		const run = requireRun(record, RUN_ENDED);
		// F3 (D-126): the answer must belong to the run the session holds now. A late answer for a run that was
		// replaced — or one echoed against another session — is refused before it can take a single action.
		assertAnswerBound(ctx, record, run);
		return await advance(record, run, answered, ctx);
	}

	// --- resuming a run whose budget ran out --------------------------------
	if (args.resume === true) {
		const run = requireRun(record, 'there is no paused run on this session to resume');
		run.budget = clampSteps(args.max_steps);
		run.steps = 0;
		reportSteps(ctx, run, 'resuming: observing the page');
		return await ask(record, run, ctx);
	}

	// --- starting a new run --------------------------------------------------
	if (args.task === undefined || args.task.trim() === '') {
		throw new ToolError('invalid-arguments', 'task is required unless resume is true');
	}
	assertSamplingAvailable(ctx, 'browser_run_task');

	const run: AgentRun = {
		id: crypto.randomUUID(),
		task: args.task,
		budget: clampSteps(args.max_steps),
		steps: 0,
		history: [],
		startedAt: Date.now(),
	};
	record.run = run;
	reportSteps(ctx, run, 'starting: observing the page');
	return await ask(record, run, ctx);
}

/**
 * A9: progress in steps against the step budget (AC16). The heartbeat — still the only producer — sends it on its
 * next tick, never below what it already sent, so a round that lasts past a second says where the run is.
 */
function reportSteps(ctx: ToolContext, run: AgentRun, message: string): void {
	ctx.progress?.({ progress: run.steps, total: run.budget, message: `step ${run.steps}/${run.budget}: ${message}` });
}

/** Emits the next `input_required` asking the model for one action. */
async function ask(record: SessionRecord, run: AgentRun, ctx: ToolContext): Promise<ToolResult> {
	const observation = await observe(record, { maxPageChars: PROMPT_PAGE_LIMIT, signal: ctx.signal });
	ctx.registry.touch(record.id);
	// A10: around sampling — a caller that cancelled is not asked for its model's next action.
	ctx.signal?.throwIfAborted();
	reportSteps(ctx, run, 'waiting for the model to choose the next action');

	// R6 (D-126): a client that declared `sampling.tools` is handed the actions as tools and must call one; every
	// other client gets the text protocol exactly as before.
	const tools = ctx.client?.samplingTools === true;
	const history = run.history.length === 0 ? '(nothing yet)' : run.history.map((h, i) => `${i + 1}. ${h}`).join('\n');
	const prompt = [
		`Task: ${run.task}`,
		'',
		`Steps so far (${run.steps}/${run.budget}):`,
		history,
		'',
		'--- current page ---',
		promptBlock(observation),
		'',
		tools ? 'Call exactly one tool.' : 'Reply with one action as a JSON object.',
	].join('\n');

	const request: CreateMessageRequestParams = {
		systemPrompt: tools ? TASK_SYSTEM_TOOLS : TASK_SYSTEM,
		maxTokens: STEP_MAX_TOKENS,
		messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
		...(tools ? { tools: [...AGENT_TOOLS], toolChoice: { mode: 'required' as const } } : {}),
	};
	// F3 (D-126): the round names its run and session under the factory's HMAC; without a codec (a handler driven
	// directly, never a served request) there is no state to bind and none is sent.
	const requestState = ctx.stateCodec === undefined || ctx.mcp === undefined
		? undefined
		: await ctx.stateCodec.mint({ k: RUN_STATE_KIND, run: run.id, s: record.id }, ctx.mcp);
	return inputRequired({
		inputRequests: { [STEP_KEY]: inputRequired.createMessage(request) },
		...(requestState === undefined ? {} : { requestState }),
	}) as ToolResult;
}

/** Executes the model's chosen action, then either finishes or asks again. */
async function advance(
	record: SessionRecord,
	run: AgentRun,
	answered: SamplingAnswer,
	ctx: ToolContext,
): Promise<ToolResult> {
	run.steps += 1;

	let action: AgentAction;
	try {
		// R6: a `tool_use` answer already is an action; a text answer is read the way it always was.
		action = answered.action ?? parseAction(answered.text);
	} catch (cause) {
		// A malformed reply is a step like any other: it is recorded and the model
		// is asked again with that fact in front of it, rather than the whole run
		// being thrown away because one completion came back wrapped in prose.
		run.history.push(`step ${run.steps}: unparseable reply — ${cause instanceof Error ? cause.message : cause}`);
		if (run.steps >= run.budget) return finish(record, run, 'budget-exhausted', answered.model, ctx);
		return await ask(record, run, ctx);
	}

	if (action.action === 'done') {
		run.answer = action.answer ?? '';
		return finish(record, run, 'done', answered.model, ctx);
	}

	// A10: between steps. The answer arrived after the caller cancelled; the action it names is not taken. The
	// step it would have been is handed back, so `resume` continues from the same place.
	if (ctx.signal?.aborted === true) {
		run.steps -= 1;
		ctx.signal.throwIfAborted();
	}
	ctx.progress?.({
		progress: run.steps - 1,
		total: run.budget,
		message: `step ${run.steps}/${run.budget}: ${describe(action)}`,
	});
	let outcome: string;
	try {
		outcome = await perform(record, action, ctx);
	} catch (cause) {
		// A failed action is information the model can use, not a crash: the tool
		// error text is exactly what a model driving the browser by hand would
		// have seen, so it is put in the history verbatim.
		outcome = `failed — ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	run.history.push(`step ${run.steps}: ${describe(action)} -> ${outcome}`);
	reportSteps(ctx, run, `${describe(action)} done`);

	if (run.steps >= run.budget) return finish(record, run, 'budget-exhausted', answered.model, ctx);
	// A10: the step that ran is kept in the history; nothing further is observed or asked for.
	ctx.signal?.throwIfAborted();
	return await ask(record, run, ctx);
}

/** Builds the terminal result and clears (or parks) the run. */
function finish(
	record: SessionRecord,
	run: AgentRun,
	status: 'done' | 'budget-exhausted',
	model: string,
	ctx: ToolContext,
): ToolResult {
	ctx.registry.touch(record.id);
	const payload: Record<string, unknown> = {
		session_id: record.id,
		status,
		task: run.task,
		steps: run.steps,
		history: run.history,
		model,
		elapsed_ms: Date.now() - run.startedAt,
	};
	if (status === 'done') {
		payload.answer = run.answer ?? '';
		record.run = undefined;
	} else {
		// Parked, not discarded: `resume: true` continues from here.
		payload.answer = run.answer ?? null;
		payload.resumable = true;
		payload.hint = 'call browser_run_task again with resume: true to continue this run';
	}
	return json(payload);
}

/** Runs one action against the browser, reusing the ordinary tool handlers. */
async function perform(record: SessionRecord, action: AgentAction, ctx: ToolContext): Promise<string> {
	// Deliberately routed through the same handlers a client would call: the
	// navigation policy, the secret substitution and the takeover lock apply to
	// the agent exactly as they apply to anyone else.
	const tools = await import('./tools.ts');
	const session = { session_id: record.id };

	switch (action.action) {
		case 'navigate': {
			if (typeof action.url !== 'string') throw new ToolError('invalid-arguments', 'navigate needs a url');
			const result = await tools.browserNavigate({ ...session, url: action.url }, ctx);
			return firstText(result);
		}
		case 'click': {
			if (typeof action.index !== 'number') throw new ToolError('invalid-arguments', 'click needs an index');
			return firstText(await tools.browserClick({ ...session, index: action.index }, ctx));
		}
		case 'type': {
			if (typeof action.text !== 'string') throw new ToolError('invalid-arguments', 'type needs text');
			return firstText(
				await tools.browserType({
					...session,
					text: action.text,
					...(typeof action.index === 'number' ? { index: action.index } : {}),
					...(typeof action.clear === 'boolean' ? { clear: action.clear } : {}),
				}, ctx),
			);
		}
		case 'press_key': {
			if (typeof action.key !== 'string') throw new ToolError('invalid-arguments', 'press_key needs a key');
			return firstText(await tools.browserPressKey({ ...session, key: action.key }, ctx));
		}
		case 'scroll': {
			const direction = action.direction === 'up' ? 'up' : 'down';
			return firstText(
				await tools.browserScroll({
					...session,
					direction,
					...(typeof action.pages === 'number' ? { pages: action.pages } : {}),
				}, ctx),
			);
		}
		case 'go_back':
			return firstText(await tools.browserGoBack(session, ctx));
		case 'switch_tab': {
			if (typeof action.tab_id !== 'string') throw new ToolError('invalid-arguments', 'switch_tab needs a tab_id');
			return firstText(await tools.browserSwitchTab({ ...session, tab_id: action.tab_id }, ctx));
		}
		default:
			throw new ToolError('invalid-arguments', `unknown action ${JSON.stringify(action.action)}`);
	}
}

/** A one-line record of what was attempted, for the history the model reads back. */
function describe(action: AgentAction): string {
	const detail = action.action === 'navigate'
		? action.url
		: action.action === 'click'
		? `index ${action.index}`
		: action.action === 'type'
		? `index ${action.index ?? 'focused'} = ${JSON.stringify(truncate(action.text ?? '', 60))}`
		: action.action === 'press_key'
		? action.key
		: action.action === 'scroll'
		? `${action.direction ?? 'down'} ${action.pages ?? ''}`
		: action.action === 'switch_tab'
		? action.tab_id
		: '';
	return `${action.action}${detail === undefined || detail === '' ? '' : ` ${detail}`}`;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** The first text block of a tool result, which is what the loop records. */
function firstText(result: ToolResult): string {
	const blocks = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
	const text = blocks.find((block) => block.type === 'text')?.text ?? 'ok';
	return truncate(text.replace(/\s+/g, ' ').trim(), 300);
}

/**
 * Reads one action out of a completion.
 *
 * Models wrap JSON in prose and in code fences no matter how firmly the system
 * prompt says not to, and a run that dies because of a stray ``` would be a bad
 * tool. So every balanced `{…}` in the reply is tried in order, and the first
 * one that is a JSON object carrying an `action` wins.
 *
 * ERRATUM(E-28). This used to take the *first* balanced run and nothing else.
 * Measured against a smaller model, a common reply shape is two objects —
 *
 * ```
 * {"thought":"The button 'Press me' is at index 16. I will click it."}
 * {"action":"click","index":16}
 * ```
 *
 * — where the first has no `action` at all. The old parser read that object,
 * rejected it, and threw away a step whose action was sitting on the next line.
 * The same widening covers a model that emits one unparseable object before a
 * good one, which the other model here does whenever a `"quoted phrase"` lands
 * inside its `thought`.
 */
export function parseAction(completion: string): AgentAction {
	let seen = 0;
	// The first reason a candidate was rejected, which is the useful one to
	// report: later candidates are usually prose that merely looks like JSON.
	let firstProblem: string | undefined;

	for (const source of jsonObjects(completion)) {
		seen += 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(source);
		} catch (cause) {
			firstProblem ??= `not valid JSON: ${cause instanceof Error ? cause.message : cause}`;
			continue;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			firstProblem ??= 'the reply was not a JSON object';
			continue;
		}
		const action = parsed as AgentAction;
		if (typeof action.action !== 'string' || action.action === '') {
			firstProblem ??= 'the reply has no "action"';
			continue;
		}
		return action;
	}

	if (seen === 0) throw new ToolError('invalid-arguments', 'no JSON object in the reply');
	throw new ToolError('invalid-arguments', firstProblem ?? 'the reply has no "action"');
}

/**
 * Every balanced brace-delimited run in the text, in order.
 *
 * Braces inside strings do not count. A run that never closes — a truncated
 * reply, or one whose unescaped quote left the scanner inside a string — does
 * not end the search: it resumes at the next `{` after that one started, so a
 * complete object later in the reply is still found.
 */
function* jsonObjects(text: string): Generator<string> {
	let from = text.indexOf('{');
	while (from >= 0) {
		const end = balancedEnd(text, from);
		if (end === null) {
			from = text.indexOf('{', from + 1);
			continue;
		}
		yield text.slice(from, end);
		from = text.indexOf('{', end);
	}
}

/** The index just past the `}` closing the run that starts at `start`, or `null`. */
function balancedEnd(text: string, start: number): number | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return null;
}

// --- shared -----------------------------------------------------------------

/** A sampling answer: its text, the model that wrote it, and the action it chose when it answered with a tool. */
interface SamplingAnswer {
	readonly text: string;
	readonly model: string;
	/** R6: the first `tool_use` block, as `{...input, action: name}`; absent for a text answer. */
	readonly action?: AgentAction;
}

/**
 * The sampling answer on a retried call, or `null` on the first one.
 *
 * A single text block reads exactly as it always did. R6 (D-126) adds the content-array form a client with
 * `sampling.tools` answers in: the first `tool_use` block becomes the action — its `name` wins over any `action` key
 * a model put in the input — and an array with no tool call is read as its text blocks joined, for `parseAction`.
 * Anything with no text and no tool call is refused as before. Extraction offers no tools (`actions: false`), so a
 * tool call there is not an answer.
 */
function samplingText(ctx: ToolContext, key: string, actions = false): SamplingAnswer | null {
	const responses = ctx.mcp?.mcpReq.inputResponses;
	if (responses === undefined) return null;
	const view = inputResponse(responses, key);
	if (view.kind !== 'sampling') return null;
	const result = view.result as CreateMessageResult;
	const model = result.model ?? 'unknown';
	const content = result.content as unknown;
	const blocks = (Array.isArray(content) ? content : [content]) as Array<
		{ type?: unknown; text?: unknown; name?: unknown; input?: unknown } | null | undefined
	>;
	const used = actions
		? blocks.find((block) => block?.type === 'tool_use' && typeof block.name === 'string')
		: undefined;
	if (used !== undefined && used !== null) {
		const input = used.input !== null && typeof used.input === 'object' && !Array.isArray(used.input)
			? used.input as Record<string, unknown>
			: {};
		return { text: '', model, action: { ...input, action: used.name as string } as AgentAction };
	}
	const texts = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string');
	if (texts.length === 0 || (!Array.isArray(content) && texts.length !== 1)) {
		throw new ToolError('invalid-arguments', 'the client answered with a non-text completion');
	}
	return { text: texts.map((block) => block!.text as string).join('\n'), model };
}

/** The `requestState` kind a task round is sealed under (F3, D-126). */
const RUN_STATE_KIND = 'run';
/** What a caller is told when an answer arrives for a run the session no longer holds. */
const RUN_ENDED = 'the run this answer belongs to has ended';

/**
 * F3 (D-126): refuses an answer whose verified `requestState` does not name the run and the session it is being
 * applied to.
 *
 * The SDK has already verified the HMAC, the expiry and the principal binding before this handler ran (a forgery
 * never gets here); what is left is the comparison the old code never made. Only a served request carries a codec,
 * so a handler driven directly — a test, the dispatcher with no codec — has nothing to compare and is not refused;
 * a served one whose state is absent, raw, of another kind or for another run is.
 */
function assertAnswerBound(ctx: ToolContext, record: SessionRecord, run: AgentRun): void {
	if (ctx.stateCodec === undefined) return;
	const state = ctx.mcp?.mcpReq.requestState<unknown>?.();
	const bound = state !== null && typeof state === 'object' &&
		(state as Record<string, unknown>).k === RUN_STATE_KIND &&
		(state as Record<string, unknown>).run === run.id &&
		(state as Record<string, unknown>).s === record.id;
	if (!bound) throw new ToolError('invalid-arguments', RUN_ENDED);
}

/**
 * Refuses early when the client cannot sample.
 *
 * Without this the handler would return `input_required` to a client with no
 * model attached, which surfaces as an opaque protocol error several layers
 * away. Saying so in the tool result names the missing capability instead.
 */
function assertSamplingAvailable(ctx: ToolContext, tool: string): void {
	if (ctx.mcp === undefined) {
		throw new ToolError(
			'browser-unavailable',
			`${tool} needs the MCP request context; it cannot be called outside a tool invocation`,
		);
	}
	if (ctx.clientSupportsSampling === false) {
		throw new ToolError(
			'invalid-arguments',
			`${tool} needs a client that supports sampling (the model comes from your client, not this server); ` +
				'use browser_get_state and decide yourself instead',
		);
	}
}

function requireRun(record: SessionRecord, detail: string): AgentRun {
	const run = record.run;
	if (run === undefined) throw new ToolError('invalid-arguments', detail);
	return run;
}

function clampSteps(requested: number | undefined): number {
	const value = requested ?? 8;
	return Math.max(1, Math.min(MAX_TASK_STEPS, Math.floor(value)));
}
