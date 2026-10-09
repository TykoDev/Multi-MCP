/**
 * Tool handlers — the barrel.
 *
 * B1.2 split the handlers by the machinery each drives (`report_architecture.md` §8.3):
 * `tools/navigation.ts`, `tools/perception.ts`, `tools/interaction.ts`, `tools/session.ts`,
 * `tools/files.ts`, with `tools/shared.ts` holding the plumbing they share. This file re-exports
 * every handler so the catalog's `handler:` references keep one import and the handler-to-catalog
 * bijection test (`catalog_test.ts`) keeps working against one module.
 *
 * Handlers throw {@linkcode ToolError} for anything the calling model should see; the dispatch seam
 * turns those into result-level errors. They never throw protocol errors.
 */
export * from './tools/navigation.ts';
export * from './tools/interaction.ts';
export * from './tools/perception.ts';
export * from './tools/session.ts';
export * from './tools/files.ts';
export * from './tools/handoff.ts';
export * from './tools/inspection.ts';
export * from './tools/apps.ts';
export * from './tools/media.ts';
