/**
 * Grouped tool lists: one `use_<group>` entry tool stands in for a group's tools until the model asks for them.
 *
 * A client lists every tool it may call when it connects, and the list goes into its model's context — the 57 browser
 * catalog entries alone carry about 57 KB of descriptions and input schemas. On a connection whose server lives as
 * long as the connection (stdio, a stateful 2025 session) the list can start with one entry tool per group instead:
 * calling one switches its group's tools on for that connection and announces `tools/list_changed`, so the client
 * re-lists and the model gets the real tools with their own schemas, annotations and per-tool permission prompts. A
 * server built per request (the 2026-07-28 mount) has no connection to remember an opened group on, so it lists flat.
 *
 * Grouping changes what is *listed*, never what is *permitted*: `registerCatalog` still registers by scope and owner,
 * the dispatcher still checks every call, and a grouped tool stays callable by name whether or not its group is open.
 */
import * as z from 'zod';
import type { ToolAvailability, ToolDefinition } from './catalog/shared.ts';
import type { ToolResult } from './types.ts';
import { TOOL_UI } from './ui_resources.ts';

/** The groups, in the order their entry tools are registered and `capabilities.tykotech.tool_groups` names them. */
export const TOOL_GROUPS = ['browser', 'library', 'sandbox', 'agent', 'memory', 'a2ui'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** Which name prefix puts a tool in which group. Tool names are frozen once released, so this table is too. */
const GROUP_PREFIXES: ReadonlyArray<readonly [prefix: string, group: ToolGroup]> = [
	['browser_', 'browser'],
	['file_', 'library'],
	['skill_', 'library'],
	['prompt_', 'library'],
	['sandbox_', 'sandbox'],
	['agent_', 'agent'],
	['memory_', 'memory'],
	['a2ui_', 'a2ui'],
];

/**
 * The group a tool is listed under on a grouped connection, or `undefined` for a tool that is always listed.
 *
 * Two kinds are always listed. An app-only tool (`TOOL_UI` visibility without `model`: the three embed tickets) is
 * hidden from the model by its host anyway, and the MCP Apps embed that calls it may be restored before any group is
 * opened. A name no prefix claims fails safe — listed, rather than hidden behind an entry tool nobody would think to
 * call — and `tool_groups_test.ts` pins every shipped tool to its group, so no shipped tool relies on that fallback.
 */
export function toolGroupOf(name: string): ToolGroup | undefined {
	const ui = TOOL_UI.get(name);
	if (ui !== undefined && !ui.visibility.includes('model')) return undefined;
	return GROUP_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1];
}

/** The entry tool's name for `group`. */
export function entryToolName(group: ToolGroup): string {
	return `use_${group}`;
}

/** What each entry tool says about its group: the model picks a group from this text alone. */
const ENTRY_TEXT: Readonly<Record<ToolGroup, { readonly title: string; readonly description: string }>> = {
	browser: {
		title: 'Browser tools',
		description: 'Add the browser tools to your tool list: sessions and tabs, navigation, clicking and typing, page ' +
			'state and screenshots, downloads and files, network and console logs, PDFs and the live view. Call this ' +
			'before using any browser_* tool.',
	},
	library: {
		title: 'Library tools',
		description: 'Add the library tools to your tool list: the shared file share (file_*), skills (skill_*) and ' +
			'prompt templates (prompt_*). Call this before using any of them.',
	},
	sandbox: {
		title: 'Sandbox tools',
		description: 'Add the coding-sandbox tools to your tool list: private workspaces from files or a git clone, ' +
			'commands in an isolated cage, file reads and writes, diffs and live shell sessions. Call this before using ' +
			'any sandbox_* tool.',
	},
	agent: {
		title: 'Agent tools',
		description: 'Add the agent tools to your tool list: tasks for the configured ACP agent, background tool runs, ' +
			'A2A peers and delegation, and your task list. Call this before using any agent_* tool.',
	},
	memory: {
		title: 'Memory tools',
		description: 'Add the memory tools to your tool list: save, search, list and delete your private vector ' +
			'memories. Call this before using any memory_* tool.',
	},
	a2ui: {
		title: 'A2UI tools',
		description: 'Add the A2UI tools to your tool list: publish and delete your declarative UI surfaces. Call this ' +
			'before using any a2ui_* tool.',
	},
};

/** One tool an entry tool put in the list. */
const LISTED_TOOL = z.object({ name: z.string(), title: z.string(), description: z.string() });

/** The success shape of every entry tool. */
const ENTRY_OUTPUT = z.object({ group: z.enum(TOOL_GROUPS), tools: z.array(LISTED_TOOL) });

/** The SDK's handle on a registered tool's place in `tools/list` (`RegisteredTool`), as far as grouping uses it. */
export interface ListedTool {
	enabled: boolean;
	enable(): void;
	disable(): void;
}

/** A grouped tool as `registerCatalog` registered it. */
export interface GroupMember {
	readonly tool: ToolDefinition;
	readonly listed: ListedTool;
}

/** What one connection knows about its groups; owned by `registerCatalog`, shared with the availability refresher. */
export interface GroupState {
	/** The groups the model has opened on this connection. */
	readonly open: Set<ToolGroup>;
	/** The deployment facts as they are now, so an opened group lists only what is available. */
	readonly availability: () => ToolAvailability;
	/** Sends one `tools/list_changed` to this connection; never throws. */
	readonly announce: () => void;
}

/** True when `tool` is offered under `state`. */
function offered(tool: ToolDefinition, state: ToolAvailability): boolean {
	return tool.available === undefined || tool.available(state);
}

/**
 * The entry tool for `group` on one connection, over the members registered for that connection's caller.
 *
 * Calling it opens the group: every member the deployment offers right now is put in the list, and one
 * `tools/list_changed` is sent when that changed anything. A call to an open group changes nothing and announces
 * nothing. The result names exactly the members now listed, so it can never reveal a tool `tools/list` would not.
 */
export function entryTool(group: ToolGroup, members: readonly GroupMember[], state: GroupState): ToolDefinition {
	return {
		name: entryToolName(group),
		title: ENTRY_TEXT[group].title,
		description: ENTRY_TEXT[group].description,
		inputSchema: z.object({}),
		outputSchema: ENTRY_OUTPUT,
		// It changes what this connection lists, never a page or stored state, so a human holding a session does not
		// block it and its annotations say read-only.
		mutates: false,
		// Offered while at least one member is: a group whose service is down goes with its members.
		available: (availability) => members.some(({ tool }) => offered(tool, availability)),
		handler: (): Promise<ToolResult> => {
			state.open.add(group);
			const now = state.availability();
			let changed = false;
			const tools: z.infer<typeof LISTED_TOOL>[] = [];
			for (const { tool, listed } of members) {
				const on = offered(tool, now);
				// Assigned, not `enable()`d: the SDK announces once per `enable()`, and a 57-tool group would make the
				// client re-list 57 times for one call. `tools/list` reads the field, so one announcement covers all.
				if (listed.enabled !== on) {
					listed.enabled = on;
					changed = true;
				}
				if (on) tools.push({ name: tool.name, title: tool.title, description: tool.description });
			}
			if (changed) state.announce();
			return Promise.resolve(entryResult(group, tools, changed));
		},
	};
}

/** The text a model reads, and the structured index beside it. */
function entryResult(group: ToolGroup, tools: z.infer<typeof LISTED_TOOL>[], changed: boolean): ToolResult {
	const lead = tools.length === 0
		? `No ${group} tool is available on this deployment right now.`
		: `The ${tools.length} ${group} tools below ${changed ? 'are now' : 'were already'} in this connection's ` +
			'tool list; call them by name.';
	const lines = tools.map((tool) => `- ${tool.name} (${tool.title}): ${tool.description}`);
	return {
		content: [{ type: 'text', text: [lead, ...lines].join('\n') }],
		structuredContent: { group, tools },
	};
}
