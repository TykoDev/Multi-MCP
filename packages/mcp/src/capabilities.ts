/**
 * `capabilities.tykotech` — what this deployment can do, told to the client at connect time.
 *
 * `needed-browser-functions.md` §8 asks for an `initialize` result carrying
 * `capabilities.tykotech {version, live_view, events, fields}` "so ADM can adapt without probing".
 * The whole point is that a client should never have to call a tool to discover whether the tool
 * exists, so the payload is built **once, by one function, from the per-request principal**
 * (report_design.md §10.1) and read at three places that cannot disagree:
 *
 * 1. the `initialize` result's `capabilities.tykotech` — §8's stated ask;
 * 2. the `ttk://capabilities` resource, for a client that would rather read than reconnect;
 * 3. `browser_health`'s `capabilities` field, beside the liveness counts.
 *
 * **U-8 settled which of those was reachable.** The design made location 1 contingent: whether the
 * SDK admits a vendor key on `ServerCapabilities` was Unproven from source alone, because
 * `ServerCapabilitiesSchema` is declared `z.core.$strip` — a schema that *drops* unknown keys — and
 * the contingency, had it been closed, was to ship locations 2 and 3 alone. It is not closed. The
 * probe (build/evidence/b3_1_u8_capabilities_probe.log) measured that the outbound path never parses:
 * `Server._oninitialize` returns `capabilities: this.getCapabilities()` verbatim, `mergeCapabilities`
 * preserves an unknown key, and `tykotech` survives an `initialize` on both legacy negotiations and a
 * `server/discover` on 2026-07-28. So the primary location ships and the other two ship with it.
 *
 * **Everything here is scope-filtered (SEC-16, AC-SEC-19).** `initialize` happens on a mount that
 * requires a credential, but "authenticated" is not "entitled": an unfiltered block would hand every
 * principal the exact feature configuration of the deployment, which is a targeting aid. `version` is
 * the one field present unconditionally, and it is safe because it is the same string `/healthz`
 * already returns without any credential at all.
 */
import { EVENT_KINDS, type EventKind, WS_EVENT_KINDS } from '@tykotech/wire';
import { CATALOG, type ToolAvailability, type ToolDefinition } from './catalog.ts';
import { FIELD_NAMES, FIELD_OPTIONS, FIELD_PRESETS } from './element_record.ts';
import { MAX_EVENT_BYTES, MAX_RING_BYTES, RING_CAPACITY } from './events.ts';
import type { SessionOwnership } from './registry.ts';
import type { Scope } from './scopes.ts';

/**
 * Why a tool the caller cannot see is missing from `tools/list`.
 *
 * **A closed enumeration, and it is one vocabulary serving two surfaces** (SEC-17): the same three
 * strings are the `reason` here and the tool error codes `human-has-control`, `feature-unavailable`
 * and `scope-required` on a `tools/call`. A client that learns it once reads both.
 *
 * `scope-required` **never names the scope**. The tool name is enough for a client to stop planning
 * around it; naming the grant tells an unauthorised caller exactly what to request or phish, which is
 * an enumeration aid rather than an affordance. `feature-unavailable` names nothing beyond itself —
 * the missing deployment feature is in the error's structured payload when the tool is actually
 * called, where the caller has already demonstrated intent.
 *
 * `human-has-control` is **unreachable here** and kept deliberately. After G-2 removed the takeover
 * lock from the availability predicates (a lock is per session; this list is per connection), the
 * only predicates left are static configuration, so no tool is ever withheld for a lock. It stays in
 * the enum because dropping it would split one vocabulary in two.
 */
export const TOOL_WITHHELD_REASONS = ['human-has-control', 'feature-unavailable', 'scope-required'] as const;
export type ToolWithheldReason = (typeof TOOL_WITHHELD_REASONS)[number];

/** One tool this principal cannot see, and the closed reason why. */
export interface ToolWithheld {
	readonly name: string;
	readonly reason: ToolWithheldReason;
}

/**
 * The live-view ceilings, injected rather than imported.
 *
 * `packages/gateway` owns the ticket store and its TTL clamps and depends on `packages/mcp`, so
 * importing them here would invert the layering — and restating the numbers would create a second
 * declaration that can disagree with the one the clamp actually reads. A mount with no live view
 * (stdio) supplies nothing and the block is absent, which is the honest answer rather than a set of
 * ceilings for a surface that is not there.
 */
export interface LiveViewCapabilities {
	/** `GET`/`PUT /api/v1/live/origins` is served, so a client can narrow its own origins. */
	readonly origins_managed: boolean;
	/** The clamped ceiling on a minted ticket's `ttl_seconds`, per mode. */
	readonly ticket_ttl_max_s: { readonly view: number; readonly control: number };
	/** `meta.frame_scale` and per-frame `scale` are emitted (B2.3). */
	readonly frame_scale: boolean;
	/** `live.hover` is answered (B2.1). */
	readonly hover: boolean;
	/** `live.highlight` is answered (B2.2). */
	readonly highlight: boolean;
	/** `live.keyframe` is answered (B2.3). */
	readonly keyframe: boolean;
}

/** The event ring and the transports that read it. */
export interface EventCapabilities {
	/** Stream transports available to this principal on this mount. Empty on stdio, which has neither. */
	readonly transports: readonly ('sse' | 'websocket')[];
	/** The kinds **this principal can actually receive** — not the kinds that exist. */
	readonly kinds: readonly EventKind[];
	readonly ring_entries: number;
	readonly ring_bytes: number;
	readonly max_event_bytes: number;
	/** Loss is always announced by a `gap` record; a `kinds` filter can never suppress one. */
	readonly gap_record: true;
}

/** The element-record cost lever (design §3.2), so a client need not guess what `fields` accepts. */
export interface FieldCapabilities {
	readonly presets: readonly string[];
	readonly default: string;
	readonly available: readonly string[];
}

/** D-108: which backend runs the coding sandbox's commands, as the sandbox's own `/healthz` says. */
export type SandboxBackendName = 'bwrap' | 'docker';

/** The `capabilities.tykotech` block, as one principal sees it. */
export interface TykotechCapabilities {
	/** `deps.version` — the same string `/healthz` returns, so it discloses nothing new (SEC-16). */
	readonly version: string;
	readonly live_view?: LiveViewCapabilities;
	readonly events?: EventCapabilities;
	readonly fields?: FieldCapabilities;
	readonly state_token?: { readonly version: 'v1'; readonly indices_stable: true };
	readonly tools_withheld?: readonly ToolWithheld[];
	/** D-108: the coding sandbox's backend, for a principal holding `sandbox:execute`. */
	readonly sandbox?: { readonly backend: SandboxBackendName };
	/** D-094: whether this deployment's Chromium runs with its sandbox (`TTK_CHROMIUM_NO_SANDBOX`). */
	readonly browser?: { readonly sandboxed: boolean };
	/**
	 * R8 (D-128): whether sessions are shared among `mcp:invoke` holders or bound to their creator
	 * (`TTK_SESSION_OWNERSHIP`), so a client knows whether `default` is its own session or everyone's.
	 */
	readonly sessions?: { readonly ownership: SessionOwnership };
	/**
	 * D-143: how many model providers are configured and whether the built-in agent can run (one is reachable), for a
	 * principal holding `model:invoke` — the `sandbox` precedent: told to the caller who could use it, absent otherwise.
	 */
	readonly model?: { readonly providers: number; readonly builtin_agent: boolean };
}

/** What the builder needs to answer for one principal. */
export interface CapabilityInputs {
	readonly version: string;
	/** The principal's scopes, exactly as `registerCatalog` filtered registration on. */
	readonly scopes: ReadonlySet<Scope>;
	/** The deployment facts the availability predicates read, from `availabilityOf`. */
	readonly availability: ToolAvailability;
	/** Absent on a mount with no live view. */
	readonly liveView?: LiveViewCapabilities;
	/** Absent on a mount with no HTTP event stream (stdio). */
	readonly eventTransports?: readonly ('sse' | 'websocket')[];
	/**
	 * D-081: every tool this principal could hold on this mount — the browser catalog plus the extension and
	 * library tools composed beside it — so `tools_withheld` covers what `registerCatalog` registers from.
	 * `CATALOG` alone when absent.
	 */
	readonly tools?: readonly ToolDefinition[];
	/**
	 * D-108: the coding sandbox's backend, when a sandbox is configured, has answered, and this caller may hold its
	 * tools; absent otherwise.
	 */
	readonly sandbox?: { readonly backend: SandboxBackendName };
	/** D-094: `SessionRegistry.chromiumSandboxed`. Absent where no registry answers it. */
	readonly chromiumSandboxed?: boolean;
	/** D-128: `SessionRegistry.ownership`. Absent where no registry answers it. */
	readonly sessionOwnership?: SessionOwnership;
	/**
	 * D-143: the configured provider count and how many the grant proof reached (`McpDeps.modelProviders`). Absent
	 * (no providers file, stdio without one) reads as none configured: a `model:invoke` holder is still told the block.
	 */
	readonly model?: { readonly providers: number; readonly reachable: number };
}

/** True when the principal holds either live-view scope. */
function watchesLiveView(scopes: ReadonlySet<Scope>): boolean {
	return scopes.has('view:watch') || scopes.has('view:control');
}

/**
 * The tools this principal cannot see, and why.
 *
 * Computed from the same `CATALOG` and the same predicates `registerCatalog` registers from, so the
 * list and the registration cannot drift: a tool withheld here is a tool absent there, by
 * construction rather than by two people remembering the same rule.
 */
export function toolsWithheld(
	scopes: ReadonlySet<Scope>,
	availability: ToolAvailability,
	tools: readonly ToolDefinition[] = CATALOG,
): ToolWithheld[] {
	const withheld: ToolWithheld[] = [];
	for (const tool of tools) {
		// Scope first, and it wins: a tool the principal has no grant for is not
		// part of their world at all, so saying "this deployment has no encoder"
		// about it would disclose a deployment fact to a caller who cannot reach
		// the tool either way.
		if (tool.scope !== undefined && !scopes.has(tool.scope)) {
			withheld.push({ name: tool.name, reason: 'scope-required' });
			continue;
		}
		if (tool.available !== undefined && !tool.available(availability)) {
			withheld.push({ name: tool.name, reason: 'feature-unavailable' });
		}
	}
	return withheld;
}

/**
 * Builds the `capabilities.tykotech` block for one principal.
 *
 * Every optional member is present only when the principal could use what it describes, so the block
 * is a map of this caller's world rather than of the server's.
 */
export function buildCapabilities(input: CapabilityInputs): TykotechCapabilities {
	const invokes = input.scopes.has('mcp:invoke');
	const capabilities: {
		version: string;
		live_view?: LiveViewCapabilities;
		events?: EventCapabilities;
		fields?: FieldCapabilities;
		state_token?: { version: 'v1'; indices_stable: true };
		tools_withheld?: readonly ToolWithheld[];
		sandbox?: { backend: SandboxBackendName };
		browser?: { sandboxed: boolean };
		sessions?: { ownership: SessionOwnership };
		model?: { providers: number; builtin_agent: boolean };
	} = { version: input.version };

	if (input.liveView !== undefined && watchesLiveView(input.scopes)) capabilities.live_view = input.liveView;

	if (invokes) {
		// A live-view ticket carries neither `mcp:invoke` nor the content kinds, so the socket's
		// kind list is the subtraction `WS_EVENT_KINDS` already performs. A principal reachable by
		// SSE sees every kind; one reachable only over the socket sees the structural ones. A
		// capabilities block that advertised a kind the caller cannot receive would be both a lie
		// and a map.
		const transports = input.eventTransports ?? [];
		capabilities.events = {
			transports,
			kinds: transports.includes('sse') || transports.length === 0 ? EVENT_KINDS : WS_EVENT_KINDS,
			ring_entries: RING_CAPACITY,
			ring_bytes: MAX_RING_BYTES,
			max_event_bytes: MAX_EVENT_BYTES,
			gap_record: true,
		};
		capabilities.fields = {
			presets: Object.keys(FIELD_PRESETS),
			default: 'core',
			available: [...FIELD_OPTIONS],
		};
		capabilities.state_token = { version: 'v1', indices_stable: true };
		capabilities.tools_withheld = toolsWithheld(input.scopes, input.availability, input.tools ?? CATALOG);
		// D-094: a caller that drives the browser is told whether it is sandboxed — the same posture fact the
		// admin diagnostics carry, scoped to the principals whose pages it describes.
		if (input.chromiumSandboxed !== undefined) capabilities.browser = { sandboxed: input.chromiumSandboxed };
		// D-128: told to the callers whose sessions it governs, beside the browser posture.
		if (input.sessionOwnership !== undefined) capabilities.sessions = { ownership: input.sessionOwnership };
	}

	// D-108 / G1: an opt-in backend that weakens isolation is visible — to the caller who can run commands in it.
	if (input.sandbox !== undefined && input.scopes.has('sandbox:execute')) {
		capabilities.sandbox = { backend: input.sandbox.backend };
	}

	// D-143: the provider facts go to the caller who may spend a provider key, and to nobody else (SEC-16). With no
	// providers dependency the honest answer for that caller is "none configured", not silence.
	if (input.scopes.has('model:invoke')) {
		capabilities.model = {
			providers: input.model?.providers ?? 0,
			builtin_agent: (input.model?.reachable ?? 0) > 0,
		};
	}

	return capabilities;
}

/**
 * The field names a preset expands to, published so a test can assert the block describes the
 * builder rather than a second copy of it.
 */
export const CAPABILITY_FIELD_NAMES: readonly string[] = FIELD_NAMES;
