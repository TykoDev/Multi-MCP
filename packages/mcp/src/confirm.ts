/**
 * Confirmations for destructive tools (R5, design §2.13, G5, D-125).
 *
 * A form-capable client is asked — through the multi-round-trip `input_required` channel the SDK serves on both
 * eras — to have its human confirm a call that ends stored data a caller cannot get back. The dispatcher runs the
 * gate after argument validation and before the handler; a client that never declared form elicitation, and the
 * 2025 stateless path (which declares no capabilities at all), are never asked and behave exactly as before.
 *
 * **This is UX, not authorization.** The answer is client-attested: a client can fabricate an accepting
 * `inputResponses` entry, and the retry carries the same arguments, so nothing here is bound by `requestState`.
 * What it buys is a human in front of a destructive call made by a model through a client that can show one.
 * Authorization stays where it was: the scope the tool declares and the GW-1 re-checks. The A2A/REST/agent-task
 * executor has no MCP context to ask through and runs the set unconfirmed (design §1 item 12); `agent_run_tool`
 * refuses the set so a capable client cannot route a confirmed tool around its human (design §2.9).
 */
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { ElicitRequestFormParams, ServerContext } from '@modelcontextprotocol/server';
import { ToolError } from './errors.ts';
import type { ClientFacts, ToolResult } from './types.ts';

/**
 * The tools that ask a form-capable client to confirm before they run (G5): each ends stored data a caller cannot
 * get back — every browser session, a coding workspace, a shared file, a skill, a prompt or a published surface.
 */
export const CONFIRM_TOOL_NAMES: ReadonlySet<string> = new Set([
	'browser_close_all',
	'sandbox_delete',
	'file_delete',
	'skill_delete',
	'prompt_delete',
	'a2ui_delete',
	// D-154: the agents' memory is persistent data like the library's; deleting it is asked for like theirs.
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
export type ConfirmMessage = (args: Readonly<Record<string, unknown>>) => string;

/**
 * What the human is asked, per tool: what the call ends, in the words the tool's own arguments give. Names and paths
 * only — every one of these arguments is an identifier the caller already chose, never content read back from
 * storage. One entry per member of {@linkcode CONFIRM_TOOL_NAMES}; `confirm_test.ts` asserts the two sets agree.
 */
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
	// D-154: a whole collection, or the named items of one.
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

/**
 * Decides whether one call of a destructive tool may run.
 *
 * - `'proceed'` when the tool is not in the set, when there is no MCP request to ask through, when the client did
 *   not declare form elicitation, or when the retry carries an accepted answer whose `confirm` is `true`;
 * - the `input_required` result asking for the confirmation when the call carries no answer yet;
 * - a `user-declined` result for every other answer — declined, cancelled, `confirm: false`, or an accepted form
 *   that does not say `true` — so the handler never runs on anything but an explicit yes.
 *
 * The caller decides whether confirmations are on at all (`TTK_CONFIRM_DESTRUCTIVE`); this function decides only
 * what one call needs.
 */
export async function confirmGate(
	tool: string,
	args: Readonly<Record<string, unknown>>,
	mcp: ServerContext | undefined,
	client: ClientFacts | undefined,
): Promise<'proceed' | ToolResult> {
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
	// Imported at call time: `dispatch.ts` imports this module, and the one D-A2 envelope builder lives there (the
	// same pattern `agent.ts` uses to reach the handlers without a static cycle).
	const { errorResult } = await import('./dispatch.ts');
	return errorResult(new ToolError('user-declined', `the confirmation for ${tool} ${what}; the tool did not run`));
}
