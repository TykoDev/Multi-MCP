/**
 * What every catalog part shares: the definition type, the availability facts, the argument
 * fragments declared once, and the `def` helper that erases a part's generic schema type.
 *
 * Internal to `catalog/` — the public names are re-exported by `catalog.ts`.
 */
import * as z from 'zod';
import { FIELD_OPTIONS } from '../element_record.ts';
import type { ToolContext, ToolResult } from '../types.ts';
import type { Scope } from '../scopes.ts';

/**
 * What a tool's availability may depend on (R5).
 *
 * Everything here is *server* state, known when the per-request server is
 * built. Client capabilities deliberately are not: on the 2026 era the SDK
 * backfills them from the request envelope after the factory has run, so a
 * tool that needs the client's model (R1, R2) cannot be filtered out of
 * `tools/list` and checks at call time instead.
 */
export interface ToolAvailability {
	/** True when the server has a data directory (R3 tools need one). */
	readonly persistence: boolean;
	/** True when the deployment can encode video (R7). */
	readonly recording: boolean;
	/**
	 * True when the process holds an outbound `--allow-net` grant beyond
	 * loopback, **proven** by `Deno.permissions.query` at startup rather than
	 * declared by an environment variable (SR-HEAD-REDIRECT, D-042). Both shipped
	 * images grant it since D-151 (the slim binary always did), so it is true in a
	 * container unless an operator scoped the bundled CMD back; the local `deno
	 * task` matrices grant loopback only, so it is false under `dev` and `stdio`.
	 */
	readonly egress: boolean;
	/**
	 * Why `browser_head` must refuse in this deployment beyond the grant, or
	 * `null` (SR3-M2, D-049).
	 *
	 * A **sentence rather than a boolean**, and that is the point: the tool is
	 * withheld when the browser is routed through a proxy this server's own
	 * request cannot follow, and a caller that reaches it anyway has to be told
	 * *which* flag and *what to do*, not merely that a feature is off. The
	 * generic "needs egress on this deployment" refusal was measured saying
	 * exactly nothing useful here, in the runtime smoke, which is why this field
	 * exists. Absent means no refusal.
	 */
	readonly headRouting?: string | null;
	/**
	 * D-082: the live health of the configured private services, re-probed while the server runs. An entry that is
	 * absent was never configured or is not watched, and does not withhold anything; `false` withholds that
	 * service's tools until the next probe says otherwise.
	 */
	readonly services?: { readonly sandbox?: boolean; readonly agents?: boolean };
	/**
	 * Deployment switches (design §2.0 item 7; on by default where the deployment can run them since D-150). Absent
	 * means off, and a tool gated on one declares `unavailableDetail` naming the `TTK_*` switch rather than resolving
	 * to a `missingFeature`. `signedLinks` is `TTK_SIGNED_LINKS` (W2), `mcpApps` is `TTK_MCP_APPS` (W7), `handoff` is
	 * `TTK_HUMAN_HANDOFF` (W4), `sandboxClone` is the sandbox's own `clone` health answer (W6).
	 */
	readonly signedLinks?: boolean;
	readonly mcpApps?: boolean;
	readonly handoff?: boolean;
	readonly sandboxClone?: boolean;
}

/**
 * A7 / D-112: the behaviour hints a tool declares beyond its mutation class, stated per tool rather than derived
 * from its name. Each member is opt-in and means exactly the MCP annotation of the same name:
 *
 * - `destructive` — it removes or ends stored data (a closed tab or session, a deleted file, skill, prompt,
 *   workspace or surface). Ending *activity* (a shell, a task) is not destructive.
 * - `idempotent` — every valid input can be repeated with no further effect.
 * - `openWorld` — it can reach the web: drive the browser, fetch, or run a command or agent that may.
 *
 * Absent members are `false` on the wire, so a new tool is closed-world and non-destructive until it says
 * otherwise — and the table-driven `tools/list` test (`annotations_test.ts`) fails until its entry agrees.
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
	/** A7: the explicit hints behind this tool's MCP annotations; see {@linkcode ToolHints}. */
	readonly hints?: ToolHints;
	/**
	 * The success shape (D-A2). Object-rooted always — the type is
	 * `z.ZodObject`, so a union or array root is a compile error rather than a
	 * wire-shape difference between the two protocol eras (I-5). Error results
	 * are deliberately not described by it: the SDK exempts `isError` from
	 * output validation, so the failure envelope is `ToolErrorPayload` instead.
	 */
	readonly outputSchema: z.ZodObject<z.ZodRawShape>;
	/**
	 * Read-only tools stay available while a human holds the takeover lock;
	 * mutating tools are refused with `human-has-control`.
	 */
	readonly mutates: boolean;
	/** Scope required in addition to `mcp:invoke`. */
	readonly scope?: Scope;
	/**
	 * Whether this *deployment* can offer the tool at all (R5) — persistence,
	 * an encoder. A tool that answers `false` is registered but disabled, so it
	 * is absent from `tools/list` and a call answers `feature-unavailable`
	 * naming the missing feature rather than reading as unknown.
	 *
	 * G-2: the takeover lock is deliberately NOT expressed here. It is per
	 * session and this list is per connection, so hiding `browser_click`
	 * because one of four sessions was held was a lie about the other three —
	 * and in the all-held case it turned a classifiable
	 * `Error: human-has-control:` result into a JSON-RPC protocol error, which
	 * aborts the model's turn instead of telling it to wait.
	 * `SessionRegistry.assertUnlocked` answers in every case.
	 */
	readonly available?: (state: ToolAvailability) => boolean;
	/**
	 * The message a `feature-unavailable` refusal carries when `available` says
	 * no, in place of the generic one.
	 *
	 * A refusal that names only a feature tells an operator nothing they can act
	 * on when the cause is a *configuration* rather than a missing capability.
	 * `undefined` keeps the generic message, which is right for the plain
	 * "no data directory" and "no encoder" cases.
	 */
	readonly unavailableDetail?: (state: ToolAvailability) => string | undefined;
	/**
	 * Rewrites a call's raw arguments before the schema sees them, for spellings a published wire format allows and the
	 * schema does not (`a2ui_publish`: a message without `version`, the A2UI basic catalog's own id). It must only map
	 * an alternative spelling onto the canonical one: the schema still decides what is valid, and the advertised JSON
	 * Schema stays the canonical form. Must not throw; anything it does not recognize is returned unchanged.
	 */
	readonly normalizeArguments?: (args: unknown) => unknown;
	readonly handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * The identity of the element table an `index` was read from (B1.4, G-1).
 *
 * Optional and additive: a caller that omits it gets exactly 0.1.0 behaviour —
 * the index resolves against whatever table the server holds. A caller that
 * sends it is told `element-not-found` with `reason: 'stale-token'` rather than
 * having its index silently resolved against a page the browser has left. The
 * value comes back on every result that touches the table.
 */
export const stateTokenArg = z.string().optional().describe(
	'state_token from the browser_get_state result the index was read from. When supplied, the ' +
		'server refuses the call rather than resolving the index against a page it has since left.',
);

/**
 * `frame_id` (D-054): one frame of the session's CURRENT tab, as `browser_get_frames` spells it.
 *
 * Declared `.max(128)` and **not** `.min(1)` deliberately: `browser_evaluate` already accepts
 * `z.string().max(128).optional()` and narrowing it to a non-empty string would reject an input the
 * shipped tool accepts today. An empty string simply is not a frame this session holds, and the
 * resolver's first gate already answers that with `invalid-arguments` naming the id — which is the
 * right error either way.
 *
 * Ephemeral by contract. The id is rediscovered per replay through `browser_get_frames`; it is not a
 * durable locator and nothing in this server persists it.
 */
export const frameIdArg = z.string().max(128).optional().describe(
	'Frame id from browser_get_frames, scoped to this session and its current tab. Omit for the top ' +
		'document. Ephemeral: rediscover it per run rather than storing it.',
);

/** Every browser tool takes an optional session id; omitted means `default`. */
export const sessionId = z.string().optional().describe(
	'Target browser session. Omit to use the default session, which is created on first use.',
);

/**
 * The element-record cost lever (design §3.2). Accepted by every tool that emits an element record
 * and meaning the same thing in each: the emitted set is the union of everything named, presets and
 * field names mix freely, omitted means `['core']`, and an unrecognised member is refused with
 * `invalid-arguments` naming it rather than silently dropped.
 */
export const fieldsArg = z.array(z.enum(FIELD_OPTIONS)).optional().describe(
	'Which element fields to emit, in structuredContent. Presets minimal (index, tag, label, role, href), ' +
		'core (default: minimal plus bounds, visible, enabled, focused, frame_id) and full (core plus ' +
		'locator, document_bounds, frame, input, attrs, text, locators) mix freely with individual field ' +
		'names; the result is their union. locator is opt-in rather than part of core (D-035): ask for it ' +
		'as fields: ["core","locator"]. The text block always carries the minimal record.',
);

/** `element_limit` (design §3.2): no default, implied at 500 when a heavy field is requested. */
export const elementLimitArg = z.number().int().min(1).max(5000).optional().describe(
	'Cap on interactive_elements, keeping the elements the page paints last. No default; implied at 500 when ' +
		'full, document_bounds, frame, input, attrs, text or locators is requested. elements_truncated and ' +
		'elements_total report what happened.',
);

/** `include_hidden` (E-41): admit off-screen but rendered elements. */
export const includeHiddenArg = z.boolean().optional().describe(
	'Also emit elements that are rendered but outside the viewport band, each with visible:false. Default false. ' +
		'Elements that are not rendered at all (display:none, visibility:hidden) are never emitted.',
);

/** `frames` (design §3.2): which documents the element array covers. */
export const framesArg = z.union([z.literal('all'), z.literal('top'), z.array(z.string())]).optional().describe(
	'all (default): every frame. top: the top document only. An array: the top document plus the named frame ' +
		'ids; unknown ids are reported in frames_unknown, not refused.',
);

/** Erases the per-entry schema generic so a part is a homogeneous list. */
export function def<S extends z.ZodType>(d: ToolDefinition<S>): ToolDefinition<z.ZodType> {
	return d as unknown as ToolDefinition<z.ZodType>;
}
