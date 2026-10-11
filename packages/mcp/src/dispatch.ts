/**
 * The `tools/call` seam (D-A2).
 *
 * After {@linkcode registerCatalog} has registered every tool the principal may
 * see — which is what `tools/list` reads — this module installs a *replacement*
 * `tools/call` handler that dispatches from this repository's own `CATALOG`
 * instead of the SDK's registry.
 *
 * Why a replacement rather than a wrapper: three failure classes are otherwise
 * unreachable as *results*. An argument violation throws inside the SDK's own
 * handler and is converted by `createToolError` with a fixed
 * `Input validation error:` prefix and no `structuredContent`; a tool the
 * principal lacks the scope for and a tool the deployment cannot offer both
 * surface as `Tool <name> not found`, textually indistinguishable from a tool
 * this server has never had. A client that reads "not found" as "this build
 * lacks the feature" then degrades itself permanently.
 *
 * The seam is safe because `Protocol.setRequestHandler` ends in a plain
 * `Map.set` and `assertCanSetRequestHandler` is called only from the SDK's own
 * auto-install paths (`@modelcontextprotocol/server` 2.0.0). That is a fact
 * about a pinned dependency, so `dispatch_test.ts` asserts it: an SDK upgrade
 * that made the second registration throw fails at `deno install` time rather
 * than in production.
 */
import { isInputRequiredResult, McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { CallToolResult, ClientCapabilities, ServerContext } from '@modelcontextprotocol/server';
import type { ToolAvailability, ToolDefinition } from './catalog.ts';
import { type ArgumentIssue, describeIssues, repairArguments } from './arguments.ts';
import { CONFIRM_TOOL_NAMES, confirmGate } from './confirm.ts';
import type { Scope } from './scopes.ts';
import { ToolError } from './errors.ts';
import type { ClientFacts, ProgressReport, ToolContext, ToolResult } from './types.ts';

/** How one dispatched call ended, in the D-101 vocabulary `/metrics` and the OTel trace share. */
export type ToolCallOutcome = 'ok' | 'error' | 'input_required';

/**
 * Opens a trace for one tool call and ends it with the call's outcome (R7, design §2.15, D-127). The gateway wires it
 * to OpenTelemetry when the runtime exports (`OTEL_DENO=true`); {@linkcode installToolDispatch} and
 * `createToolExecutor` call it. It sees the tool name only — no arguments, URLs, principals or session ids (the
 * D-101 label rule) — and a name outside the catalog reaches it as {@linkcode UNKNOWN_TOOL}, so a caller cannot mint
 * a series.
 */
export type ToolTracer = (tool: string) => { end(outcome: ToolCallOutcome): void };

/** The traced name of a call whose name is not in the catalog (D-127). */
export const UNKNOWN_TOOL = '(unknown)';

/** A result's outcome: `input_required` by the SDK's own predicate, `error` when flagged, else `ok`. */
export function toolCallOutcome(result: ToolResult): ToolCallOutcome {
	if (isInputRequiredResult(result)) return 'input_required';
	return (result as CallToolResult).isError === true ? 'error' : 'ok';
}

/**
 * Runs one dispatch under the context's tracer, if it has one. A dispatch that throws — an unknown tool is a
 * protocol error — ends its trace as `error` and rethrows; a tracer that throws never fails the call.
 */
export async function tracedDispatch(
	dispatch: Pick<DispatchContext, 'catalog' | 'traceTool'>,
	name: string,
	call: () => Promise<ToolResult>,
): Promise<ToolResult> {
	let trace: { end(outcome: ToolCallOutcome): void } | undefined;
	try {
		trace = dispatch.traceTool?.(dispatch.catalog.has(name) ? name : UNKNOWN_TOOL);
	} catch {
		trace = undefined;
	}
	const end = (outcome: ToolCallOutcome): void => {
		try {
			trace?.end(outcome);
		} catch { /* telemetry never fails a tool call */ }
	};
	let result: ToolResult;
	try {
		result = await call();
	} catch (cause) {
		end('error');
		throw cause;
	}
	end(toolCallOutcome(result));
	return result;
}

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
	/** C11 (D-101): told each call's name and result once it ends; `McpDeps.onToolCall`. */
	readonly onToolCall?: (tool: string, result: ToolResult) => void;
	/**
	 * R5 (design §2.13, D-125): whether the {@linkcode CONFIRM_TOOL_NAMES} ask a form-capable client to confirm
	 * (`TTK_CONFIRM_DESTRUCTIVE`). Absent means off, so a dispatcher built without it — a test, the task executor —
	 * never asks.
	 */
	readonly confirmations?: boolean;
	/** R7 (design §2.15, D-127): the per-call trace, when the gateway exports OpenTelemetry. */
	readonly traceTool?: ToolTracer;
}

/**
 * The four client facts the tools branch on, from the client's declared capabilities (design §2.0 item 6; S0 seam,
 * read by W4). `undefined` when the client declared none — the 2025 stateless path — so a handler cannot mistake
 * "unknown" for "declared nothing".
 *
 * Form elicitation follows the SDK's own reading: a bare `elicitation: {}` is form, and so is any declaration naming
 * `form`; one naming only `url` is not.
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

/** A failure rendered as a result: the frozen text prefix plus the D-A2 payload. */
export function errorResult(error: ToolError): CallToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: error.wireText }],
		structuredContent: error.structuredPayload as unknown as Record<string, unknown>,
	};
}

/**
 * Which deployment fact a disabled tool is waiting on.
 *
 * Derived by probing the predicate rather than declared beside it, so a tool
 * cannot claim one feature in its message while gating on another. Returns
 * `undefined` when no single feature unblocks the tool, which after G-2 removed
 * `allSessionsLocked` from the predicates cannot happen for any catalog entry —
 * the assertion lives in `catalog_test.ts` rather than here, because a
 * dispatcher is the wrong place to fail a build.
 */
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
 * schema, then — only on a failure — the stringified-value repair (`arguments.ts`), whose output passes the same
 * schema or is not used. Exported for the task executor, which validates the same way.
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

/**
 * Runs one handler and converts every throw into a result.
 *
 * The single place a non-`ToolError` throw becomes `browser-unavailable`, and
 * the single consumer of {@linkcode ToolError.wireText}. Exported so the SDK's
 * own registered executor — unreachable while the seam holds, but present so
 * `tools/list` works — cannot become a second error producer.
 */
export async function runToolHandler(
	tool: ToolDefinition,
	args: unknown,
	ctx: ToolContext,
	logger?: { warn(msg: string): void },
): Promise<ToolResult> {
	try {
		return await tool.handler(args as never, ctx);
	} catch (cause) {
		// Every failure a caller can act on is a *result*, not a protocol error:
		// a JSON-RPC error aborts the model's turn, while an error result is
		// feedback it can respond to.
		if (cause instanceof ToolError) return errorResult(cause);
		const detail = cause instanceof Error ? cause.message : String(cause);
		// A10: a call its caller cancelled stopped early on purpose; that is not a tool failure worth a warning, and
		// the result is read by nobody (the SDK drops the response to a cancelled request).
		if (ctx.signal?.aborted === true) {
			return errorResult(new ToolError('browser-unavailable', `${tool.name} was cancelled by the caller`));
		}
		logger?.warn(`tool ${tool.name} failed: ${detail}`);
		return errorResult(new ToolError('browser-unavailable', detail));
	}
}

/**
 * The replacement dispatcher, as a plain function so tests can drive it without
 * a transport.
 *
 * @param name the tool name from `params.name`
 * @param args the raw, unvalidated `params.arguments`
 * @throws ProtocolError when the name is not in the catalog at all — that is a
 * genuine protocol violation and the SDK's own behaviour, so it stays one.
 */
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

	// **N-6: the baseline scope is checked here, and it was checked nowhere.**
	// `registerCatalog` filters on `tool.scope`, and only two catalog entries
	// declare one (`task`, `admin`) — so every other tool was permitted to a
	// principal holding *no* scopes at all. On the HTTP mount that was masked by
	// the gateway's own route gate; **on stdio it was masked by nothing**, so a
	// deployment setting `TTK_ANON_SCOPES=` — documented as "a principal that can
	// do nothing" — still handed out the whole browser-control surface. It is
	// enforced before `permitted`, because "you hold no authority here" is a
	// different fact from "this tool needs a scope you lack", and the first is
	// the one that must not depend on a catalog entry remembering to declare it.
	// It is also what makes a future `evaluate` tool fail *closed* if that one
	// line is ever forgotten.
	if (!dispatch.scopes.has('mcp:invoke')) {
		return errorResult(new ToolError('scope-required', `this credential cannot use ${name}`));
	}

	if (!dispatch.permitted.has(name)) {
		// The message never names the scope (SEC-17): the code tells an honest
		// caller what happened, and naming the grant would tell a dishonest one
		// exactly what to request or phish.
		return errorResult(new ToolError('scope-required', `this credential cannot use ${name}`));
	}

	if (tool.available !== undefined && !tool.available(dispatch.availability)) {
		const feature = missingFeature(tool, dispatch.availability);
		// A tool that can explain its own refusal does (SR3-M2): the generic
		// message names a feature, which is useless when the cause is a
		// configuration the operator has to change rather than a capability the
		// deployment lacks.
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

	// G-3: the SDK validates arguments *inside* its own handler and throws, so
	// this is the only place an argument violation can be given a code.
	const parsed = parseArguments(tool, args);
	if (!parsed.success) return errorResult(new ToolError('invalid-arguments', parsed.message));

	// R5 (D-125): a destructive call from a form-capable client waits for its human — after the arguments are known to
	// be valid, so the message describes a call that could run, and before the heartbeat, so a call parked on a person
	// reports no progress. `confirmations` is `TTK_CONFIRM_DESTRUCTIVE`; anything but a client that declared form
	// elicitation passes straight through, which keeps every other client's results byte for byte what they were.
	if (dispatch.confirmations === true && CONFIRM_TOOL_NAMES.has(name) && mcp !== undefined && client?.elicitForm) {
		const gate = await confirmGate(name, parsed.data as Record<string, unknown>, mcp, client);
		if (gate !== 'proceed') return gate;
	}

	// D-079: the caller's `notifications/cancelled` reaches the tool. The SDK aborts the request's own signal; a
	// bridge (A2A, stdio task) may have set one on the context too, and either ends the call.
	const signal = combineSignals(dispatch.ctx.signal, mcp?.mcpReq.signal);
	// D-079: a caller that sent a progressToken hears from a call that runs past a second, once a second.
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
				// S0 seam (design §2.0 item 6): what the client declared, for W4's confirmation and handoff paths.
				...(client === undefined ? {} : { client }),
				// A9: the handler reports into the heartbeat; it is never handed a way to notify on its own.
				...(heartbeat === null ? {} : { progress: heartbeat.report }),
			},
			dispatch.logger,
		);
	} finally {
		heartbeat?.stop();
	}
	return validateOutput(tool, result, dispatch.logger);
}

/** One signal that aborts when either does; `undefined` when there is none. */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return AbortSignal.any([a, b]);
}

/** How often a running call reports progress; the first report comes after one interval. */
export const PROGRESS_INTERVAL_MS = 1_000;

/** A running call's progress heartbeat: the one producer of its `notifications/progress`. */
export interface Heartbeat {
	/** A9: what the handler says about its progress; the next tick carries it. Never sends anything itself. */
	report(report: ProgressReport): void;
	stop(): void;
}

/**
 * D-079 / A9: `notifications/progress` for a call whose caller sent a `progressToken`. One producer for every tool,
 * ticking once per interval. Nothing is sent for a call that finishes within the first interval, nor to a caller
 * that sent no token; a notification that cannot be delivered is dropped, never fails the tool.
 *
 * Without a report the value is the seconds the call has run and no total is claimed. A handler that knows more
 * reports it (`ctx.progress`), and the tick then carries the handler's `total` and `message` with the value
 * `max(last sent, reported)` — the reported progress, or the elapsed seconds when the report names only a total
 * (a call bounded by a timeout), capped at that total. The spec requires every notification's value to exceed the
 * last one, so a tick whose value has not risen sends nothing rather than repeat itself: a handler that is stuck
 * on step 3 of 8 says so once, not once a second.
 */
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

/**
 * Applies the tool's declared `outputSchema` to a success.
 *
 * The SDK's own `validateToolOutput` runs inside the handler this seam replaces,
 * so without this the schema would be advertised in `tools/list` and enforced
 * nowhere. Parsing in Zod's default strip mode is what the wire wants — an
 * undeclared key does not ship — and `schemas_test.ts` asserts *equality* rather
 * than parseability so a handler that grew a field before its schema did fails a
 * test instead of losing the field in silence.
 *
 * A schema violation is a server bug, and it is still answered as a *result*:
 * a JSON-RPC error would abort the calling model's turn over a fault it did not
 * cause and cannot fix.
 */
function validateOutput(
	tool: ToolDefinition,
	result: ToolResult,
	logger?: { warn(msg: string): void },
): ToolResult {
	// The SDK's own predicate, not a key test: an input-required result is
	// identified by `resultType`, and a hand-rolled check that guessed the key
	// name silently classified every sampling round as a malformed success.
	if (isInputRequiredResult(result)) return result;
	const call = result as CallToolResult;
	// The output schema describes success only: the SDK exempts `isError` from
	// output validation, and the D-A2 failure envelope is its own shape.
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

/**
 * Installs the replacement handler on a server whose catalog is already
 * registered.
 *
 * Must run *after* `registerCatalog`: the SDK auto-installs its own `tools/call`
 * on the first `registerTool` and asserts none exists yet, so installing first
 * would make that assertion throw.
 */
export function installToolDispatch(server: McpServer, dispatch: DispatchContext): void {
	server.server.setRequestHandler('tools/call', async (request, mcp) => {
		// R7 (D-127): one `ttk.tool` span per call, opened in the request's own context so it nests under its span.
		const result = await tracedDispatch(dispatch, request.params.name, () =>
			dispatchToolCall(
				dispatch,
				request.params.name,
				request.params.arguments,
				mcp,
				server.server.getClientCapabilities()?.sampling !== undefined,
				clientFactsOf(server.server.getClientCapabilities()),
			));
		dispatch.onToolCall?.(request.params.name, result);
		if (isInputRequiredResult(result)) return result;
		// Every `outputSchema` in this catalog is object-rooted (I-5), so the
		// projection is the identity on the 2026 era and the `{result: …}` wrap
		// cannot fire on the 2025 one. Routing through the SDK anyway keeps the
		// era logic in the codec, which is where it belongs.
		return server.server.projectCallToolResult(result as CallToolResult, undefined);
	});
}
