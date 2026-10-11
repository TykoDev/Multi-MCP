/**
 * X-1 (D-141; amends D-086, D-125, D-121): which tools may run **indirectly** — as a structured task, or behind an
 * operator-configured A2UI button — and the words a refusal uses.
 *
 * A leaf module on purpose: it imports only {@linkcode CONFIRM_TOOL_NAMES}, so `expansion_config.ts` (read by
 * `loadConfig`) can refuse a button naming one of these tools at startup without pulling `expansion.ts`'s graph —
 * the agent runtime, the sandbox client, the A2UI store — into configuration. `expansion.ts` re-exports all three
 * names, so every existing importer (`tool_tasks_test.ts` among them) is unchanged.
 */
import { CONFIRM_TOOL_NAMES } from '@tykotech/mcp';

/**
 * Tools a structured A2A task cannot run: they need the MCP client's model through sampling (`clientSupportsSampling`
 * is false for a task), so listing them in the extended card would advertise a certain failure.
 */
export const SAMPLING_TOOLS: ReadonlySet<string> = new Set(['browser_run_task', 'browser_extract_content']);

/**
 * R1 (D-121): tools `agent_run_tool` refuses to run as a background task, with "call <tool> directly".
 *
 * - The sampling tools need the calling client's model, which a task does not have.
 * - `agent_run_tool` itself: a task that only queues another task buys nothing and spends a slot.
 * - `browser_request_human`, `browser_live_view`, `browser_live_ticket`, and the MCP Apps stream tickets
 *   `sandbox_session_ticket` / `a2ui_surface_ticket`: each hands something to the person or host at the other end of
 *   *this* call (an elicitation, an embed, a ticket bound to the caller's app origin).
 * - The confirmation set (G5): a client able to confirm must not be able to route a destructive tool around its
 *   human by wrapping it in a task, whose executor has no MCP context to ask through.
 * - `browser_file_link` (review R1-5 / R2-5): its signed URL is a bearer credential for its life (D-119: it goes only
 *   to its caller), and a task keeps its result at rest — in `tasks.json`, in `agent_get_task`, in A2A push bodies.
 *
 * Review R1-3: enforced for **every** structured task — MCP, A2A and its HTTP+JSON binding — at the runtime's
 * `invoke`, not only by `agent_run_tool` at submission: an A2A data part reaches the runtime without passing through
 * `agent_run_tool` at all. X-1 (D-141): an A2UI tool action (E-4) is the same kind of indirect call — a click runs
 * the tool through `createToolExecutor`, with no MCP context to confirm through and no caller to hand a link or
 * ticket to — so `TTK_A2UI_ACTIONS` naming a member refuses startup, and the dispatcher refuses one defensively.
 * Exported for the tests, which assert every member is refused on every path.
 */
export const NOT_TASKABLE: ReadonlySet<string> = new Set([
	...SAMPLING_TOOLS,
	'agent_run_tool',
	'browser_request_human',
	'browser_live_view',
	'browser_live_ticket',
	'sandbox_session_ticket',
	'a2ui_surface_ticket',
	'browser_file_link',
	...CONFIRM_TOOL_NAMES,
]);

/**
 * D-143 (model-providers-ui S0): tools the built-in model agent is never offered, beyond {@linkcode NOT_TASKABLE}.
 * Each submits another text task through this same runtime, so a model that called one would fan out into a second
 * model loop (or a delegation) with no bound this loop can see. The list the gateway hands the loop
 * (`taskableTools(scopes, true)` in `expansion.ts`) subtracts both sets; a structured A2A task may still name them.
 */
export const MODEL_EXCLUDED: ReadonlySet<string> = new Set(['agent_prompt', 'agent_delegate']);

/** The refusal of a tool outside the taskable set, in the words `agent_run_tool` has always used. */
export function notTaskable(tool: string): string {
	return `call ${tool} directly; it cannot run as a background task`;
}
