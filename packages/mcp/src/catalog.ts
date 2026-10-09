/**
 * The tool catalog: one definition per tool, carrying its Zod schema, its
 * mutation class, its required scope, and its handler.
 *
 * One definition yields the `tools/list` JSON Schema, the runtime validator,
 * and the TypeScript argument type — so a schema and its handler cannot drift
 * (SPECS/CONNECTORS-MCP-A2A-A2UI.md §3.6).
 *
 * B1.2 split the entries by the machinery each tool drives, mirroring the
 * handler modules under `tools/`: `catalog/navigation.ts`,
 * `catalog/interaction.ts`, `catalog/perception.ts`, `catalog/session.ts`,
 * `catalog/files.ts`. This file composes them into the one `CATALOG` the
 * server registers and the tests enumerate.
 */
import type * as z from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { ToolDefinition } from './catalog/shared.ts';
import { NAVIGATION_TOOLS } from './catalog/navigation.ts';
import { INTERACTION_TOOLS } from './catalog/interaction.ts';
import { PERCEPTION_TOOLS } from './catalog/perception.ts';
import { SESSION_TOOLS } from './catalog/session.ts';
import { FILE_TOOLS } from './catalog/files.ts';
import { HANDOFF_TOOLS } from './catalog/handoff.ts';
import { INSPECTION_TOOLS } from './catalog/inspection.ts';
import { APPS_TOOLS } from './catalog/apps.ts';
import { MEDIA_TOOLS } from './catalog/media.ts';

export type { Scope } from './scopes.ts';
export type { ToolAvailability, ToolDefinition, ToolHints } from './catalog/shared.ts';

export const CATALOG: readonly ToolDefinition<z.ZodType>[] = [
	...NAVIGATION_TOOLS,
	...INTERACTION_TOOLS,
	...PERCEPTION_TOOLS,
	...SESSION_TOOLS,
	...FILE_TOOLS,
	...HANDOFF_TOOLS,
	...INSPECTION_TOOLS,
	// R9 (W7): the MCP Apps live view and its embed ticket, both off unless TTK_MCP_APPS is set.
	...APPS_TOOLS,
	// R10/R11 (design §2.3): PDF, signed links, the accessibility tree and performance.
	...MEDIA_TOOLS,
] as const;

/**
 * The MCP annotations advertised for a tool (A7, D-112): read-only from its mutation class, everything else from
 * the hints the tool declares. Every hint is stated explicitly, `false` included, because the MCP defaults for an
 * absent `destructiveHint` and `openWorldHint` are `true` — a client reading an omitted hint would assume the
 * worst about every tool here. `readOnlyHint` stays absent on a mutating tool (its default, `false`, is right),
 * and `destructiveHint`/`idempotentHint` are omitted on a read-only one, where the spec gives them no meaning.
 */
export function annotationsFor(tool: ToolDefinition<z.ZodType>): ToolAnnotations {
	const openWorldHint = tool.hints?.openWorld === true;
	if (!tool.mutates) return { readOnlyHint: true, openWorldHint };
	return {
		destructiveHint: tool.hints?.destructive === true,
		idempotentHint: tool.hints?.idempotent === true,
		openWorldHint,
	};
}

/** Tool lookup by name. */
export const CATALOG_BY_NAME: ReadonlyMap<string, ToolDefinition<z.ZodType>> = new Map(
	CATALOG.map((tool) => [tool.name, tool]),
);
