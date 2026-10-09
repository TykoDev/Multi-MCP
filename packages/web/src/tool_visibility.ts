/**
 * Who a listed tool is for, as the MCP Apps extension marks it (R9, D-134) — pure, so `web_test.ts` asserts it
 * without loading the Tools screen and its kit.
 */

/** The part of a `tools/list` entry this reads. */
export interface ListedToolMeta {
	readonly _meta?: { readonly ui?: { readonly visibility?: unknown } };
}

/**
 * True for a tool marked for the embedded app only (`_meta.ui.visibility` without `model`), such as
 * `browser_live_ticket`. The Tools console is a host like any other, and a host keeps such a tool from every
 * caller but the embed it belongs to; offering it there would hand a person a socket credential to copy. A tool
 * with no `_meta.ui`, or one visible to both, is for everyone.
 */
export function appOnly(tool: object): boolean {
	const visibility = (tool as ListedToolMeta)._meta?.ui?.visibility;
	return Array.isArray(visibility) && !visibility.includes('model');
}
