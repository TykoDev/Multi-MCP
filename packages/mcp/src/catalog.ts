/**
 * The tool catalog: one definition per tool, carrying its Zod schema, its mutation class, its required scope, and its
 * handler.
 */
import type * as z from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { ToolDefinition } from './catalog/shared.ts';
import { NAVIGATION_TOOLS } from './catalog/navigation.ts';
import { INTERACTION_TOOLS } from './catalog/interaction.ts';
import { PERCEPTION_TOOLS } from './catalog/perception.ts';
import { APPS_TOOLS, HANDOFF_TOOLS, SESSION_TOOLS } from './catalog/session.ts';
import { FILE_TOOLS } from './catalog/files.ts';
import { INSPECTION_TOOLS } from './catalog/inspection.ts';
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
	// The MCP Apps live view and its embed ticket, both off unless TTK_MCP_APPS is set.
	...APPS_TOOLS,
	// PDF, signed links, the accessibility tree and performance.
	...MEDIA_TOOLS,
] as const;

/**
 * The MCP annotations advertised for a tool: read-only from its mutation class, everything else from the hints the
 * tool declares.
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
