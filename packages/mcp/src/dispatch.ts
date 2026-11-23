/** The `tools/call` seam. */
import {
	type CallToolResult,
	type ClientCapabilities,
	type ElicitRequestFormParams,
	inputRequired,
	inputResponse,
	isInputRequiredResult,
	McpServer,
	ProtocolError,
	ProtocolErrorCode,
	type ServerContext,
} from '@modelcontextprotocol/server';
import type { ToolAvailability, ToolDefinition } from './catalog.ts';
import type { Scope } from './scopes.ts';
import { ToolError } from './errors.ts';
import { redactDeep } from './secrets.ts';
import type { ClientFacts, ProgressReport, ToolContext, ToolResult } from './types.ts';

/** What the dispatcher needs to answer one call. Deliberately not `McpDeps`. */
export interface DispatchContext {
	/** Every tool this build has, including ones this principal cannot see. */
	readonly catalog: ReadonlyMap<string, ToolDefinition>;
	/** The tools the principal's scopes admit. A subset of `catalog`'s keys. */
	readonly permitted: ReadonlySet<string>;
	/** The principal's scopes, so a non-tool surface can gate on the same set. */
	readonly scopes: ReadonlySet<Scope>;
	readonly availability: ToolAvailability;
	readonly ctx: ToolContext;
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/** The heartbeat's tick, for tests; {@linkcode PROGRESS_INTERVAL_MS} otherwise. */
	readonly progressIntervalMs?: number;
	/** Told each call's name and result once it ends; `McpDeps.onToolCall`. */
	readonly onToolCall?: (tool: string, result: ToolResult) => void;
	/**
	 * Whether the {@linkcode CONFIRM_TOOL_NAMES} ask a form-capable client to confirm (`TTK_CONFIRM_DESTRUCTIVE`).
	 */
	readonly confirmations?: boolean;
}

/**
 * The four client facts the tools branch on, from the client's declared capabilities, read by the confirmation,
 * handoff and secret-choice paths.
 */
export function clientFactsOf(caps: ClientCapabilities | undefined): ClientFacts | undefined {
	if (caps === undefined) return undefined;
	const elicitation = caps.elicitation;
	return {
		sampling: caps.sampling !== undefined,
		samplingTools: caps.sampling?.tools !== undefined,
		elicitForm: elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined),
		elicitUrl: elicitation?.url !== undefined,
	};
}

/** A failure rendered as a result: the frozen text prefix plus the structured payload. */
export function errorResult(error: ToolError): CallToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: error.wireText }],
		structuredContent: error.structuredPayload as unknown as Record<string, unknown>,
	};
}

/** Which deployment fact a disabled tool is waiting on. */
export function missingFeature(
	tool: ToolDefinition,
	state: ToolAvailability,
): 'persistence' | 'recording' | 'egress' | undefined {
	if (tool.available === undefined) return undefined;
	for (const feature of ['persistence', 'recording', 'egress'] as const) {
		if (!state[feature] && tool.available({ ...state, [feature]: true })) return feature;
	}
	return undefined;
}

/**
 * Validates a call's raw arguments against the tool's schema: the tool's own `normalizeArguments` first, then the
 * schema, then — only on a failure — the stringified-value repair ({@linkcode repairArguments}), whose output passes the same
 * schema or is not used.
 */
export function parseArguments(
	tool: Pick<ToolDefinition, 'inputSchema' | 'normalizeArguments'>,
	args: unknown,
): { success: true; data: unknown } | { success: false; message: string } {
	const raw = tool.normalizeArguments === undefined ? args ?? {} : tool.normalizeArguments(args ?? {});
	const first = tool.inputSchema.safeParse(raw);
	if (first.success) return { success: true, data: first.data };
	const repaired = repairArguments(raw, first.error.issues as readonly ArgumentIssue[], (value) => {
		// A repaired value is normalized again: the tool's normalization may apply to what the string spelled.
		const candidate = tool.normalizeArguments === undefined ? value : tool.normalizeArguments(value);
		const attempt = tool.inputSchema.safeParse(candidate);
		return attempt.success
			? { success: true, data: attempt.data }
			: { success: false, issues: attempt.error.issues as readonly ArgumentIssue[] };
	});
	if (repaired.ok) return { success: true, data: repaired.data };
	return { success: false, message: describeIssues(repaired.issues) };
}

/** Runs one handler and converts every throw into a result. */
export async function runToolHandler(
	tool: ToolDefinition,
	args: unknown,
	ctx: ToolContext,
	logger?: { warn(msg: string): void },
): Promise<ToolResult> {
	try {
		return await tool.handler(args as never, ctx);
	} catch (cause) {
		// Every failure a caller can act on is a *result*, not a protocol error: a JSON-RPC error aborts the model's
		// turn, while an error result is feedback it can respond to.
		if (cause instanceof ToolError) return errorResult(cause);
		const detail = cause instanceof Error ? cause.message : String(cause);
		// A call its caller cancelled stopped early on purpose; that is not a tool failure worth a warning, and
		// the result is read by nobody (the SDK drops the response to a cancelled request).
		if (ctx.signal?.aborted === true) {
			return errorResult(new ToolError('browser-unavailable', `${tool.name} was cancelled by the caller`));
		}
		logger?.warn(`tool ${tool.name} failed: ${detail}`);
		return errorResult(new ToolError('browser-unavailable', detail));
	}
}

/** The replacement dispatcher, as a plain function so tests can drive it without a transport. */
export async function dispatchToolCall(
	dispatch: DispatchContext,
	name: string,
	args: unknown,
	mcp?: ServerContext,
	clientSupportsSampling?: boolean,
	client?: ClientFacts,
): Promise<ToolResult> {
	const tool = dispatch.catalog.get(name);
	if (tool === undefined) {
		throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`);
	}

	// **The baseline scope is checked here, and only here.** `registerCatalog` filters on `tool.scope`, and most
	// browser catalog entries declare none — so without this they would be permitted to a principal holding *no*
	// scopes at all.
	if (!dispatch.scopes.has('mcp:invoke')) {
		return errorResult(new ToolError('scope-required', `this credential cannot use ${name}`));
	}

	if (!dispatch.permitted.has(name)) {
		// The message never names the scope: the code tells an honest caller what happened, and naming the grant
		// would tell a dishonest one exactly what to request or phish.
		return errorResult(new ToolError('scope-required', `this credential cannot use ${name}`));
	}

	if (tool.available !== undefined && !tool.available(dispatch.availability)) {
		const feature = missingFeature(tool, dispatch.availability);
		// A tool that can explain its own refusal does: the generic message names a feature, which is useless when
		// the cause is a configuration the operator has to change rather than a capability the deployment lacks.
		const detail = tool.unavailableDetail?.(dispatch.availability);
		return errorResult(
			new ToolError(
				'feature-unavailable',
				detail ??
					(feature === undefined
						? `${name} is not available on this deployment`
						: `${name} needs ${feature} on this deployment`),
				feature === undefined ? {} : { feature },
			),
		);
	}

	// The SDK validates arguments *inside* its own handler and throws, so
	// this is the only place an argument violation can be given a code.
	const parsed = parseArguments(tool, args);
	if (!parsed.success) return errorResult(new ToolError('invalid-arguments', parsed.message));

	// A destructive call from a form-capable client waits for its human — after the arguments are known to be valid,
	// so the message describes a call that could run, and before the heartbeat, so a call parked on a person reports
	// no progress.
	if (dispatch.confirmations === true && CONFIRM_TOOL_NAMES.has(name) && mcp !== undefined && client?.elicitForm) {
		const gate = confirmGate(name, parsed.data as Record<string, unknown>, mcp, client);
		if (gate !== 'proceed') return gate;
	}

	// The caller's `notifications/cancelled` reaches the tool. The SDK aborts the request's own signal; an agent
	// task's executor (`createToolExecutor`) may have set one on the context too, and either ends the call.
	const signal = combineSignals(dispatch.ctx.signal, mcp?.mcpReq.signal);
	// A caller that sent a progressToken hears from a call that runs past a second, once a second.
	const heartbeat = mcp === undefined ? null : startHeartbeat(mcp, name, dispatch.progressIntervalMs);
	let result: ToolResult;
	try {
		result = await runToolHandler(
			tool,
			parsed.data,
			{
				...dispatch.ctx,
				...(signal === undefined ? {} : { signal }),
				...(mcp === undefined ? {} : { mcp }),
				...(clientSupportsSampling === undefined ? {} : { clientSupportsSampling }),
				// What the client declared, for the confirmation and handoff paths.
				...(client === undefined ? {} : { client }),
				// The handler reports into the heartbeat; it is never handed a way to notify on its own.
				...(heartbeat === null ? {} : { progress: heartbeat.report }),
			},
			dispatch.logger,
		);
	} finally {
		heartbeat?.stop();
	}
	// Secret rule 2 ("nothing reads a secret back out"), at the one exit every tool result takes — successes, errors
	// and sampling rounds alike: a typed value can come back through any page read.
	return redactDeep(validateOutput(tool, result, dispatch.logger), dispatch.ctx.secrets);
}

/** One signal that aborts when either does; `undefined` when there is none. */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return AbortSignal.any([a, b]);
}

/** How often a running call reports progress; the first report comes after one interval. */
const PROGRESS_INTERVAL_MS = 1_000;

/** A running call's progress heartbeat: the one producer of its `notifications/progress`. */
interface Heartbeat {
	/** What the handler says about its progress; the next tick carries it. Never sends anything itself. */
	report(report: ProgressReport): void;
	stop(): void;
}

/** `notifications/progress` for a call whose caller sent a `progressToken`. */
export function startHeartbeat(
	mcp: ServerContext,
	name: string,
	intervalMs: number = PROGRESS_INTERVAL_MS,
): Heartbeat | null {
	const token = (mcp.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken;
	if (token === undefined) return null;
	let ticks = 0;
	let last: number | null = null;
	let reported: ProgressReport | null = null;
	const timer = setInterval(() => {
		ticks += 1;
		const elapsed = (ticks * intervalMs) / 1000;
		const total = reported?.total;
		let candidate = reported?.progress ?? elapsed;
		if (total !== undefined) candidate = Math.min(candidate, total);
		const progress = last === null ? candidate : Math.max(last, candidate);
		if (last !== null && progress <= last) return;
		last = progress;
		void mcp.mcpReq.notify({
			method: 'notifications/progress',
			params: {
				progressToken: token,
				progress,
				...(total === undefined ? {} : { total }),
				message: reported?.message ?? `${name} running`,
			},
		}).catch(() => {});
	}, intervalMs);
	return {
		report: (report: ProgressReport): void => {
			// Later reports refine earlier ones: a step count keeps its total when only the message moves on.
			reported = { ...reported, ...report };
		},
		stop: () => clearInterval(timer),
	};
}

/** Applies the tool's declared `outputSchema` to a success. */
function validateOutput(
	tool: ToolDefinition,
	result: ToolResult,
	logger?: { warn(msg: string): void },
): ToolResult {
	// The SDK's own predicate, not a key test: an input-required result is
	// identified by `resultType`, and a hand-rolled check that guessed the key
	// name would silently classify every sampling round as a malformed success.
	if (isInputRequiredResult(result)) return result;
	const call = result as CallToolResult;
	// The output schema describes success only: the SDK exempts `isError` from
	// output validation, and the failure envelope is its own shape.
	if (call.isError === true) return call;
	if (call.structuredContent === undefined) {
		logger?.warn(`tool ${tool.name} returned a success with no structuredContent`);
		return errorResult(new ToolError('browser-unavailable', `${tool.name} produced no structured result`));
	}
	const checked = tool.outputSchema.safeParse(call.structuredContent);
	if (!checked.success) {
		logger?.warn(
			`tool ${tool.name} returned a result its schema rejects: ${
				describeIssues(checked.error.issues as readonly ArgumentIssue[])
			}`,
		);
		return errorResult(
			new ToolError('browser-unavailable', `${tool.name} produced a result its own schema rejects`),
		);
	}
	return { ...call, structuredContent: checked.data as Record<string, unknown> };
}

/** Installs the replacement handler on a server whose catalog is already registered. */
export function installToolDispatch(server: McpServer, dispatch: DispatchContext): void {
	server.server.setRequestHandler('tools/call', async (request, mcp) => {
		const result = await dispatchToolCall(
			dispatch,
			request.params.name,
			request.params.arguments,
			mcp,
			server.server.getClientCapabilities()?.sampling !== undefined,
			clientFactsOf(server.server.getClientCapabilities()),
		);
		dispatch.onToolCall?.(request.params.name, result);
		if (isInputRequiredResult(result)) return result;
		// Every `outputSchema` in this catalog is object-rooted, so the projection is the identity on the 2026 era
		// and the `{result: …}` wrap cannot fire on the 2025 one.
		return server.server.projectCallToolResult(result as CallToolResult, undefined);
	});
}

// --- Argument repair and argument-error wording for the `tools/call` path. ----------------------------------------

/** One Zod issue, as much of it as this module reads. Zod v4's `invalid_union` carries its branches in `errors`. */
export interface ArgumentIssue {
	readonly path: readonly PropertyKey[];
	readonly message: string;
	readonly code?: string;
	/** `invalid_type`: the type the schema wanted. */
	readonly expected?: string;
	readonly errors?: readonly (readonly ArgumentIssue[])[];
}

/** How many repair rounds one call gets: one per nesting level a client stringified, which is never deep. */
const MAX_REPAIR_ROUNDS = 4;

/** The largest string the repair will try to parse; beyond any argument a tool accepts as structure. */
const MAX_REPAIR_CHARS = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `path` inside `root`, or `undefined` when the path leaves the structure. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
	let node = root;
	for (const key of path) {
		if (Array.isArray(node) && typeof key === 'number') node = node[key];
		else if (isRecord(node) && typeof key === 'string' && Object.hasOwn(node, key)) node = node[key];
		else return undefined;
	}
	return node;
}

/** A copy of `root` with the value at `path` replaced; `path` is known to resolve. */
function withValueAt(root: unknown, path: readonly PropertyKey[], value: unknown): unknown {
	if (path.length === 0) return value;
	const [head, ...rest] = path;
	if (Array.isArray(root) && typeof head === 'number') {
		const copy = [...root];
		copy[head] = withValueAt(root[head], rest, value);
		return copy;
	}
	if (isRecord(root) && typeof head === 'string') {
		return { ...root, [head]: withValueAt(root[head], rest, value) };
	}
	return root;
}

/**
 * The structured value a string spells, or `undefined` when it spells none: JSON whose top level is an object, an
 * array, a finite number or a boolean.
 */
function parsedStructure(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed === '' || trimmed.length > MAX_REPAIR_CHARS) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : undefined;
	if (typeof parsed === 'boolean' || Array.isArray(parsed) || isRecord(parsed)) return parsed;
	return undefined;
}

/** True for an issue that refuses a value for being a string where the schema wanted structure. */
function refusesString(issue: ArgumentIssue): boolean {
	return issue.code === 'invalid_union' || (issue.code === 'invalid_type' && issue.expected !== 'string');
}

/**
 * Every path, from `issues` and any union branches inside them, at which the schema refused a string for its type —
 * never a string refused for its content (too long, a bad pattern), which re-reading as JSON could only make worse.
 */
function stringPaths(args: unknown, issues: readonly ArgumentIssue[], into: Map<string, PropertyKey[]>): void {
	for (const issue of issues) {
		if (refusesString(issue) && typeof valueAt(args, issue.path) === 'string') {
			into.set(JSON.stringify(issue.path.map(String)), [...issue.path]);
		}
		for (const branch of issue.errors ?? []) {
			// A branch's issue paths are relative to the union's own value.
			stringPaths(args, branch.map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] })), into);
		}
	}
}

/**
 * Re-reads each string a schema refused for its type as the JSON structure it spells (a client that stringified an
 * object, array, number or boolean), one nesting level per round, at most {@linkcode MAX_REPAIR_ROUNDS} rounds.
 */
export function repairArguments<T>(
	args: unknown,
	firstIssues: readonly ArgumentIssue[],
	parse: (value: unknown) => { success: true; data: T } | { success: false; issues: readonly ArgumentIssue[] },
): { ok: true; data: T } | { ok: false; issues: readonly ArgumentIssue[] } {
	let current = args;
	let issues = firstIssues;
	for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
		const paths = new Map<string, PropertyKey[]>();
		stringPaths(current, issues, paths);
		let next = current;
		for (const path of paths.values()) {
			const structure = parsedStructure(valueAt(next, path) as string);
			if (structure !== undefined) next = withValueAt(next, path, structure);
		}
		if (next === current) break;
		current = next;
		const attempt = parse(current);
		if (attempt.success) return { ok: true, data: attempt.data };
		issues = attempt.issues;
	}
	return { ok: false, issues };
}

/** How far a union branch got: fewer issues is closer, and among equals the deeper first issue is. */
function branchDistance(branch: readonly ArgumentIssue[]): [number, number] {
	const depth = branch.reduce((deepest, issue) => Math.max(deepest, issue.path.length), 0);
	return [branch.length, -depth];
}

/**
 * The issues to report for one issue: itself, or — for a union no branch of which matched — the issues of the branch
 * the value came closest to, with the union's path in front, recursively.
 */
function flatten(issue: ArgumentIssue): ArgumentIssue[] {
	const branches = issue.errors?.filter((branch) => branch.length > 0) ?? [];
	if (issue.code !== 'invalid_union' || branches.length === 0) return [issue];
	let best = branches[0]!;
	let bestDistance = branchDistance(best);
	for (const branch of branches.slice(1)) {
		const distance = branchDistance(branch);
		if (distance[0] < bestDistance[0] || (distance[0] === bestDistance[0] && distance[1] < bestDistance[1])) {
			best = branch;
			bestDistance = distance;
		}
	}
	return best.flatMap((inner) => flatten({ ...inner, path: [...issue.path, ...inner.path] }));
}

/** Renders validation issues as `<path>: <issue>`, joined, unions resolved to their closest branch; root is `(root)`. */
export function describeIssues(issues: readonly ArgumentIssue[]): string {
	const lines = issues.flatMap(flatten).map((issue) =>
		`${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`
	);
	return [...new Set(lines)].join('; ');
}

// --- Confirmations for destructive tools. ------------------------------------------------------------------------

/**
 * The tools that ask a form-capable client to confirm before they run: each ends stored data a caller cannot
 * get back — every browser session, a coding workspace, a shared file, a skill, a prompt or a published surface.
 */
export const CONFIRM_TOOL_NAMES: ReadonlySet<string> = new Set([
	'browser_close_all',
	'sandbox_delete',
	'file_delete',
	'skill_delete',
	'prompt_delete',
	'a2ui_delete',
	// The agents' memory is persistent data like the library's; deleting it is asked for like theirs.
	'memory_delete',
]);

/** The `inputRequests` key the confirmation rides under, and the one its answer comes back under. */
export const CONFIRM_KEY = 'ttk_confirm';

/** How much of one argument value a confirmation message quotes. */
const SHOWN_LIMIT = 120;

/**
 * One argument value as a message may show it: control characters (C0, DEL, C1) stripped — a path or a name is
 * caller text, and a newline or an escape sequence in it could make the prompt a human reads say something other
 * than what the call does — then cut to {@linkcode SHOWN_LIMIT} characters.
 */
function shown(value: unknown): string {
	// deno-lint-ignore no-control-regex -- the control characters are exactly what this strips.
	const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
	return text.length <= SHOWN_LIMIT ? text : `${text.slice(0, SHOWN_LIMIT)}…`;
}

/** Builds one tool's confirmation question from the call's validated arguments. */
type ConfirmMessage = (args: Readonly<Record<string, unknown>>) => string;

/** What the human is asked, per tool: what the call ends, in the words the tool's own arguments give. */
export const CONFIRM_MESSAGES: ReadonlyMap<string, ConfirmMessage> = new Map<string, ConfirmMessage>([
	[
		'browser_close_all',
		() => 'Close every browser session on this server? Their tabs, logins and unsaved page state end now.',
	],
	[
		'sandbox_delete',
		(args) =>
			`Delete the coding workspace ${shown(args.workspace_id)} and its caches? Running work in it is cancelled.`,
	],
	[
		'file_delete',
		(args) =>
			args.recursive === true
				? `Delete ${shown(args.path)} and everything under it from the file share?`
				: `Delete ${shown(args.path)} from the file share?`,
	],
	['skill_delete', (args) => `Delete the skill ${shown(args.name)} and every file in it?`],
	['prompt_delete', (args) => `Delete the stored prompt ${shown(args.name)}?`],
	['a2ui_delete', (args) => `Delete the UI surface ${shown(args.surface_id)}?`],
	// A whole collection, or the named items of one.
	[
		'memory_delete',
		(args) =>
			args.all === true
				? `Delete the memory collection ${shown(args.collection)} and everything in it?`
				: `Delete ${Array.isArray(args.ids) ? args.ids.length : 0} item(s) from the memory collection ${
					shown(args.collection)
				}?`,
	],
]);

/** The form the human answers: one required boolean. Flat primitives only, as form elicitation allows. */
const CONFIRM_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
	type: 'object',
	properties: { confirm: { type: 'boolean', title: 'Confirm' } },
	required: ['confirm'],
};

/** Decides whether one call of a destructive tool may run. */
export function confirmGate(
	tool: string,
	args: Readonly<Record<string, unknown>>,
	mcp: ServerContext | undefined,
	client: ClientFacts | undefined,
): 'proceed' | ToolResult {
	const message = CONFIRM_MESSAGES.get(tool);
	if (message === undefined || mcp === undefined || client?.elicitForm !== true) return 'proceed';

	const answer = inputResponse(mcp.mcpReq.inputResponses, CONFIRM_KEY);
	if (answer.kind === 'missing') {
		return inputRequired({
			inputRequests: {
				[CONFIRM_KEY]: inputRequired.elicit({ message: message(args), requestedSchema: CONFIRM_SCHEMA }),
			},
		}) as ToolResult;
	}
	if (answer.kind === 'elicit' && answer.action === 'accept' && answer.content?.confirm === true) return 'proceed';

	const what = answer.kind !== 'elicit'
		? 'was not given'
		: answer.action === 'decline'
		? 'was declined'
		: answer.action === 'cancel'
		? 'was cancelled'
		: 'was not given';
	return errorResult(new ToolError('user-declined', `the confirmation for ${tool} ${what}; the tool did not run`));
}
