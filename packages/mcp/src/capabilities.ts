/** `capabilities.tykotech` — what this deployment can do, told to the client at connect time. */
import { EVENT_KINDS, type EventKind, WS_EVENT_KINDS } from '@tykotech/wire';
import { CATALOG, type ToolAvailability, type ToolDefinition } from './catalog.ts';
import { FIELD_OPTIONS, FIELD_PRESETS } from './element_record.ts';
import { MAX_EVENT_BYTES, MAX_RING_BYTES, RING_CAPACITY } from './events.ts';
import type { SessionOwnership } from './registry.ts';
import type { Scope } from './scopes.ts';
import { TOOL_GROUPS, type ToolGroup, toolGroupOf } from './tool_groups.ts';

/**
 * Why a tool the caller cannot see is missing from `tools/list`. The takeover lock is never one: it is session state,
 * answered per call with the `human-has-control` tool error (wait, then retry), so a tool never disappears under it.
 */
export const TOOL_WITHHELD_REASONS = ['feature-unavailable', 'scope-required'] as const;
type ToolWithheldReason = (typeof TOOL_WITHHELD_REASONS)[number];

/** One tool this principal cannot see, and the closed reason why. */
interface ToolWithheld {
	readonly name: string;
	readonly reason: ToolWithheldReason;
}

/** The live-view ceilings, injected rather than imported. */
export interface LiveViewCapabilities {
	/** `GET`/`PUT /api/v1/live/origins` is served, so a client can narrow its own origins. */
	readonly origins_managed: boolean;
	/** The clamped ceiling on a minted ticket's `ttl_seconds`, per mode. */
	readonly ticket_ttl_max_s: { readonly view: number; readonly control: number };
	/** `meta.frame_scale` and per-frame `scale` are emitted. */
	readonly frame_scale: boolean;
	/** `live.hover` is answered. */
	readonly hover: boolean;
	/** `live.highlight` is answered. */
	readonly highlight: boolean;
	/** `live.keyframe` is answered. */
	readonly keyframe: boolean;
}

/** The event ring and the transports that read it. */
interface EventCapabilities {
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

/** The element-record cost lever, so a client need not guess what `fields` accepts. */
interface FieldCapabilities {
	readonly presets: readonly string[];
	readonly default: string;
	readonly available: readonly string[];
}

/** Which backend runs the coding sandbox's commands, as the sandbox's own `/healthz` says. */
type SandboxBackendName = 'bwrap' | 'docker';

/** The `capabilities.tykotech` block, as one principal sees it. */
export interface TykotechCapabilities {
	/** `deps.version` — the same string `/healthz` returns, so it discloses nothing new. */
	readonly version: string;
	readonly live_view?: LiveViewCapabilities;
	readonly events?: EventCapabilities;
	readonly fields?: FieldCapabilities;
	readonly state_token?: { readonly version: 'v1'; readonly indices_stable: true };
	readonly tools_withheld?: readonly ToolWithheld[];
	/** The coding sandbox's backend, for a principal holding `sandbox:execute`. */
	readonly sandbox?: { readonly backend: SandboxBackendName };
	/** Whether this deployment's Chromium runs with its sandbox (`TTK_CHROMIUM_NO_SANDBOX`). */
	readonly browser?: { readonly sandboxed: boolean };
	/**
	 * Whether sessions are shared among `mcp:invoke` holders or bound to their creator
	 * (`TTK_SESSION_OWNERSHIP`), so a client knows whether `default` is its own session or everyone's.
	 */
	readonly sessions?: { readonly ownership: SessionOwnership };
	/**
	 * How many model providers are configured and whether the built-in agent can run (one is reachable), for a
	 * principal holding `model:invoke` — like `sandbox`, told to the caller who could use it and absent otherwise.
	 */
	readonly model?: { readonly providers: number; readonly builtin_agent: boolean };
	/**
	 * Tool groups: on a connection that lists its tools grouped, the groups whose `use_<group>` entry tool it listed
	 * when it connected, in `TOOL_GROUPS` order.
	 */
	readonly tool_groups?: readonly ToolGroup[];
}

/** What the builder needs to answer for one principal. */
interface CapabilityInputs {
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
	 * Every tool this principal could hold on this mount — the browser catalog plus the extension and library tools
	 * composed beside it — so `tools_withheld` covers what `registerCatalog` registers from.
	 */
	readonly tools?: readonly ToolDefinition[];
	/**
	 * The coding sandbox's backend, when a sandbox is configured, has answered, and this caller may hold its
	 * tools; absent otherwise.
	 */
	readonly sandbox?: { readonly backend: SandboxBackendName };
	/** `SessionRegistry.chromiumSandboxed`. Absent where no registry answers it. */
	readonly chromiumSandboxed?: boolean;
	/** `SessionRegistry.ownership`. Absent where no registry answers it. */
	readonly sessionOwnership?: SessionOwnership;
	/** The configured provider count and how many the grant proof reached (`McpDeps.modelProviders`). */
	readonly model?: { readonly providers: number; readonly reachable: number };
	/** Tool groups: true on a connection that lists its tools grouped (`McpDeps.toolGroups`). */
	readonly toolGroups?: boolean;
}

/** True when the principal holds either live-view scope. */
function watchesLiveView(scopes: ReadonlySet<Scope>): boolean {
	return scopes.has('view:watch') || scopes.has('view:control');
}

/** The tools this principal cannot see, and why. */
export function toolsWithheld(
	scopes: ReadonlySet<Scope>,
	availability: ToolAvailability,
	tools: readonly ToolDefinition[] = CATALOG,
): ToolWithheld[] {
	const withheld: ToolWithheld[] = [];
	for (const tool of tools) {
		// Scope first, and it wins: a tool the principal has no grant for is not part of their world at all, so
		// saying "this deployment has no encoder" about it would disclose a deployment fact to a caller who cannot
		// reach the tool either way.
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
 * The groups whose entry tool a grouped connection lists for this principal: those holding at least one tool the
 * principal's scopes admit and the deployment offers — the tests `registerCatalog` applies to the same composed
 * tools, so at connect time the block names exactly the entry tools listed.
 */
function groupsListed(
	scopes: ReadonlySet<Scope>,
	availability: ToolAvailability,
	tools: readonly ToolDefinition[],
): ToolGroup[] {
	const held = new Set<ToolGroup>();
	for (const tool of tools) {
		if (tool.scope !== undefined && !scopes.has(tool.scope)) continue;
		if (tool.available !== undefined && !tool.available(availability)) continue;
		const group = toolGroupOf(tool.name);
		if (group !== undefined) held.add(group);
	}
	return TOOL_GROUPS.filter((group) => held.has(group));
}

/** Builds the `capabilities.tykotech` block for one principal. */
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
		tool_groups?: readonly ToolGroup[];
	} = { version: input.version };

	if (input.liveView !== undefined && watchesLiveView(input.scopes)) capabilities.live_view = input.liveView;

	if (invokes) {
		// A live-view ticket carries neither `mcp:invoke` nor the content kinds, so the socket's kind list is the
		// subtraction `WS_EVENT_KINDS` already performs.
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
		// A caller that drives the browser is told whether it is sandboxed — the same posture fact the
		// admin diagnostics carry, scoped to the principals whose pages it describes.
		if (input.chromiumSandboxed !== undefined) capabilities.browser = { sandboxed: input.chromiumSandboxed };
		// Told to the callers whose sessions it governs, beside the browser posture.
		if (input.sessionOwnership !== undefined) capabilities.sessions = { ownership: input.sessionOwnership };
		if (input.toolGroups === true) {
			const listed = groupsListed(input.scopes, input.availability, input.tools ?? CATALOG);
			if (listed.length > 0) capabilities.tool_groups = listed;
		}
	}

	// An opt-in backend that weakens isolation is visible — to the caller who can run commands in it.
	if (input.sandbox !== undefined && input.scopes.has('sandbox:execute')) {
		capabilities.sandbox = { backend: input.sandbox.backend };
	}

	// The provider facts go to the caller who may spend a provider key, and to nobody else. With no
	// providers dependency the honest answer for that caller is "none configured", not silence.
	if (input.scopes.has('model:invoke')) {
		capabilities.model = {
			providers: input.model?.providers ?? 0,
			builtin_agent: (input.model?.reachable ?? 0) > 0,
		};
	}

	return capabilities;
}
