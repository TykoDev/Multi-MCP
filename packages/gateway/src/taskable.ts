/**
 * Which tools may run **indirectly** — as a structured task, or behind an operator-configured A2UI button — and the
 * words a refusal uses.
 */
import { CONFIRM_TOOL_NAMES } from '@tykotech/mcp';

/**
 * Tools a structured A2A task cannot run: they need the MCP client's model through sampling (`clientSupportsSampling`
 * is false for a task), so listing them in the extended card would advertise a certain failure.
 */
const SAMPLING_TOOLS: ReadonlySet<string> = new Set(['browser_run_task', 'browser_extract_content']);

/** Tools `agent_run_tool` refuses to run as a background task, with "call <tool> directly". */
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
 * Tools the built-in model agent is never offered, beyond {@linkcode NOT_TASKABLE}. It submits another task through
 * this same runtime, so a model that called it would fan out into a delegation with no bound this loop can see.
 */
export const MODEL_EXCLUDED: ReadonlySet<string> = new Set(['agent_delegate']);

/** The refusal of a tool outside the taskable set, in the words `agent_run_tool` uses. */
export function notTaskable(tool: string): string {
	return `call ${tool} directly; it cannot run as a background task`;
}
