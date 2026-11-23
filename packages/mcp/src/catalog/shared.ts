/**
 * What every catalog part shares: the definition type, the availability facts, the argument fragments declared once,
 * and the `def` helper that erases a part's generic schema type.
 */
import * as z from 'zod';
import { FIELD_OPTIONS } from '../element_record.ts';
import type { ToolContext, ToolResult } from '../types.ts';
import type { Scope } from '../scopes.ts';

/** What a tool's availability may depend on. */
export interface ToolAvailability {
	/** True when the server has a data directory (persistent state tools need one). */
	readonly persistence: boolean;
	/** True when the deployment can encode video (recording). */
	readonly recording: boolean;
	/**
	 * True when the process holds an outbound
	 * `--allow-net` grant beyond loopback, **proven** by `Deno.permissions.query` at startup rather than declared by
	 * an environment variable, which could claim a grant the process lacks.
	 */
	readonly egress: boolean;
	/** Why `browser_head` must refuse in this deployment beyond the grant, or `null`. */
	readonly headRouting?: string | null;
	/** The live health of the configured private services, re-probed while the server runs. */
	readonly services?: { readonly sandbox?: boolean };
	/** Deployment switches, on by default where the deployment can run them. */
	readonly signedLinks?: boolean;
	readonly mcpApps?: boolean;
	readonly handoff?: boolean;
	readonly sandboxClone?: boolean;
}

/**
 * The behaviour hints a tool declares beyond its mutation class, stated per tool rather than derived from its name.
 */
export interface ToolHints {
	readonly destructive?: true;
	readonly idempotent?: true;
	readonly openWorld?: true;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: S;
	/** The explicit hints behind this tool's MCP annotations; see {@linkcode ToolHints}. */
	readonly hints?: ToolHints;
	/** The success shape. */
	readonly outputSchema: z.ZodObject<z.ZodRawShape>;
	/**
	 * Read-only tools stay available while a human holds the takeover lock;
	 * mutating tools are refused with `human-has-control`.
	 */
	readonly mutates: boolean;
	/** Scope required in addition to `mcp:invoke`. */
	readonly scope?: Scope;
	/** Whether this *deployment* can offer the tool at all — persistence, an encoder. */
	readonly available?: (state: ToolAvailability) => boolean;
	/** The message a `feature-unavailable` refusal carries when `available` says no, in place of the generic one. */
	readonly unavailableDetail?: (state: ToolAvailability) => string | undefined;
	/**
	 * Rewrites a call's raw arguments before the schema sees them, for spellings a published wire format allows and
	 * the schema does not (`a2ui_publish`: a message without `version`, the A2UI basic catalog's own id).
	 */
	readonly normalizeArguments?: (args: unknown) => unknown;
	readonly handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

/** The identity of the element table an `index` was read from. */
export const stateTokenArg = z.string().optional().describe(
	'state_token from the browser_get_state result the index was read from. When supplied, the ' +
		'server refuses the call rather than resolving the index against a page it has since left.',
);

/** `frame_id`: one frame of the session's CURRENT tab, as `browser_get_frames` spells it. */
export const frameIdArg = z.string().max(128).optional().describe(
	'Frame id from browser_get_frames, scoped to this session and its current tab. Omit for the top ' +
		'document. Ephemeral: rediscover it per run rather than storing it.',
);

/** Every browser tool takes an optional session id; omitted means `default`. */
export const sessionId = z.string().optional().describe(
	'Target browser session. Omit to use the default session, which is created on first use.',
);

/** The element-record cost lever. */
export const fieldsArg = z.array(z.enum(FIELD_OPTIONS)).optional().describe(
	'Which element fields to emit, in structuredContent. Presets minimal (index, tag, label, role, href), ' +
		'core (default: minimal plus bounds, visible, enabled, focused, frame_id) and full (core plus ' +
		'locator, document_bounds, frame, input, attrs, text, locators) mix freely with individual field ' +
		'names; the result is their union. locator is opt-in rather than part of core: ask for it ' +
		'as fields: ["core","locator"]. The text block always carries the minimal record.',
);

/** `element_limit`: no default, implied at 500 when a heavy field is requested. */
export const elementLimitArg = z.number().int().min(1).max(5000).optional().describe(
	'Cap on interactive_elements, keeping the elements the page paints last. No default; implied at 500 when ' +
		'full, document_bounds, frame, input, attrs, text or locators is requested. elements_truncated and ' +
		'elements_total report what happened.',
);

/** `include_hidden`: admit off-screen but rendered elements. */
export const includeHiddenArg = z.boolean().optional().describe(
	'Also emit elements that are rendered but outside the viewport band, each with visible:false. Default false. ' +
		'Elements that are not rendered at all (display:none, visibility:hidden) are never emitted.',
);

/** `frames`: which documents the element array covers. */
export const framesArg = z.union([z.literal('all'), z.literal('top'), z.array(z.string())]).optional().describe(
	'all (default): every frame. top: the top document only. An array: the top document plus the named frame ' +
		'ids; unknown ids are reported in frames_unknown, not refused.',
);

/** Erases the per-entry schema generic so a part is a homogeneous list. */
export function def<S extends z.ZodType>(d: ToolDefinition<S>): ToolDefinition<z.ZodType> {
	return d as unknown as ToolDefinition<z.ZodType>;
}
