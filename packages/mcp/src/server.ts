/**
 * The MCP server factory.
 *
 * `createBuildServer` returns the `McpServerFactory` the SDK calls once per
 * request (2026-07-28 is stateless per request) or once per stdio connection.
 * Shared browser state reaches handlers through the injected
 * {@linkcode SessionRegistry}, never through the server instance.
 */
import { createRequestStateCodec, McpServer } from '@modelcontextprotocol/server';
import type {
	AuthInfo,
	McpServerFactory,
	RequestStateCodec,
	ServerCapabilities,
	ServerContext,
} from '@modelcontextprotocol/server';
import { MAX_TASK_STEPS } from './agent.ts';
import { buildCapabilities, type LiveViewCapabilities, type TykotechCapabilities } from './capabilities.ts';
import { annotationsFor, CATALOG, type ToolAvailability, type ToolDefinition } from './catalog.ts';
import { DEFAULT_SCOPES, type Scope } from './scopes.ts';
import {
	type DispatchContext,
	dispatchToolCall,
	installToolDispatch,
	runToolHandler,
	type ToolTracer,
	tracedDispatch,
} from './dispatch.ts';
import { serverImplementation, serverInstructions } from './identity.ts';
import { registerResources } from './resources.ts';
import type { LibraryStore } from './library.ts';
import { libraryTools, registerLibrary } from './library_tools.ts';
import type { SessionAccess, SessionRegistry } from './registry.ts';
import type { SecretStore } from './secrets.ts';
import type { McpAppsDeps, RecordingController, SignedLinkMinter, ToolContext, ToolResult } from './types.ts';
import { registerUiResources, toolUiMeta } from './ui_resources.ts';

export interface McpDeps {
	/** D-064: optional service tools, composed by the CLI/gateway without changing browser contracts. */
	readonly extraTools?: readonly ToolDefinition[];
	/**
	 * D-075: the library on the data volume. Its tools join the catalog on `files:read` / `files:write` and its
	 * resources and prompts are registered per principal; absent when there is no data directory.
	 */
	readonly library?: LibraryStore;
	/** D-082: the live health of the configured private services; absent, nothing is withheld for health. */
	readonly services?: () => { readonly sandbox?: boolean; readonly agents?: boolean };
	/**
	 * D-108: the configured coding sandbox's backend, as its last health answer said (null before one); absent when no
	 * sandbox is configured. Feeds `capabilities.tykotech.sandbox`.
	 */
	readonly sandboxBackend?: () => 'bwrap' | 'docker' | null;
	readonly registry: SessionRegistry;
	readonly version: string;
	/** Suffix-match navigation allowlist; empty means unrestricted. */
	readonly allowedDomains?: readonly string[];
	/** Server-held secrets a model may reference by name (R14). */
	readonly secrets?: SecretStore;
	/** True when persistent profiles and storage state are configured (R3/R5). */
	readonly persistence?: boolean;
	/** Session recording, when the deployment can encode video (R7). */
	readonly recorder?: RecordingController;
	/**
	 * True when `probeEgressGrant` proved an outbound net grant beyond loopback
	 * at startup (SR-HEAD-REDIRECT). Absent means false: a mount that did not
	 * probe offers no server-side egress tool.
	 */
	readonly egress?: boolean;
	/**
	 * Why `browser_head` must refuse beyond the grant, or absent (SR3-M2).
	 *
	 * Computed once at startup from `TTK_BROWSER_ARGS` by `headRoutingRefusal`,
	 * because it is static deployment configuration exactly as `egress` is.
	 */
	readonly headRouting?: string | null;
	/** Authenticated HTTP URL builder for session files (E-33); absent on stdio. */
	readonly fileUrl?: (sessionId: string, fileId: string) => string;
	/**
	 * Scopes for a principal with no credential to carry a grant — stdio and
	 * the loopback-dev mount. Defaults to `DEFAULT_SCOPES`; an operator widens
	 * it with `TTK_ANON_SCOPES`, and it can never exceed `SCOPES`.
	 */
	readonly anonScopes?: readonly Scope[];
	/**
	 * The live-view ceilings for `capabilities.tykotech.live_view` (B3.1).
	 *
	 * Injected because `packages/gateway` owns the ticket clamps and depends on this package;
	 * importing them here would invert the layering and restating them would be a second declaration
	 * that can disagree with the clamp. Absent on a mount with no live view, and the block is then
	 * absent too.
	 */
	readonly liveView?: LiveViewCapabilities;
	/** Stream transports this mount serves, for `capabilities.tykotech.events` (B3.1). */
	readonly eventTransports?: readonly ('sse' | 'websocket')[];
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/**
	 * C11 (D-101): told the name and result of every dispatched call — `tools/call` and an agent task's executor
	 * alike — after it ends, so the gateway can count them for `/metrics`. Absent, nothing is observed. It sees no
	 * arguments and must not throw.
	 */
	readonly onToolCall?: (tool: string, result: ToolResult) => void;
	/**
	 * R2 (design §2.12): the human handoff URL builder, set by W4 only with `TTK_HUMAN_HANDOFF=true`. S0 seam: passed
	 * through to the tool context and turns on `availability.handoff`.
	 */
	readonly viewUrl?: (sessionId: string) => string;
	/**
	 * R5 (design §2.13, D-125): `TTK_CONFIRM_DESTRUCTIVE` — the destructive set asks a form-capable client to confirm.
	 * Absent means off; the gateway and stdio set it from the configuration, whose default is on.
	 */
	readonly confirmations?: boolean;
	/**
	 * R6/F3 (design §2.14, D-126): the `requestState` HMAC key, ≥ 32 bytes. Absent, each {@linkcode createBuildServer}
	 * draws 32 random bytes once — enough, because a retry names its `session_id` and reaches the same process.
	 */
	readonly requestStateKey?: Uint8Array;
	/**
	 * R10 (design §2.7): the signed-link minter, set by W2 only with `TTK_SIGNED_LINKS=true`. S0 seam: passed through
	 * to the tool context and turns on `availability.signedLinks`.
	 */
	readonly signedLink?: SignedLinkMinter;
	/** R14 (design §2.10, D-122): the deployment's public identity for `serverInfo`; absent on stdio. */
	readonly identity?: { readonly websiteUrl?: string; readonly iconUrl?: string };
	/**
	 * R9 (design §2.20): the MCP Apps deployment, set by W7 only when `TTK_MCP_APPS` is not `off`. S0 seam: passed
	 * through to the tool context and turns on `availability.mcpApps`.
	 */
	readonly mcpApps?: McpAppsDeps;
	/** R12 (design §2.19): whether the sandbox offers `clone`, read live. S0 seam for W6; feeds `sandboxClone`. */
	readonly sandboxClone?: () => boolean;
	/**
	 * R7 (design §2.15, D-127): the per-call OpenTelemetry trace, set by the gateway and stdio only while the runtime
	 * exports (`OTEL_DENO=true`). Absent, nothing is traced.
	 */
	readonly traceTool?: ToolTracer;
	/**
	 * D-143 (model-providers-ui): how many model providers the operator's file configures and how many the process's
	 * net grant reaches, set by the gateway (W3) from the providers in force (D-154: the database's). Feeds `capabilities.tykotech.model` for a
	 * principal holding `model:invoke`; absent reads as none configured.
	 */
	readonly modelProviders?: () => { readonly providers: number; readonly reachable: number };
}

function scopesOf(deps: McpDeps, authInfo: AuthInfo | undefined): ReadonlySet<Scope> {
	// SEC-01. "Spawner-trusted" means the process may act as the user, not
	// that every scope this build will ever declare is pre-consented — so a
	// credential-less mount gets DEFAULT_SCOPES, never the whole vocabulary.
	// An operator who wants more names it in TTK_ANON_SCOPES.
	if (authInfo === undefined) return new Set(deps.anonScopes ?? DEFAULT_SCOPES);
	return new Set(authInfo.scopes as Scope[]);
}

function principalOf(authInfo: AuthInfo | undefined): string {
	return authInfo?.clientId ?? 'local';
}

/**
 * GW-5: the realm-qualified owner (D-068) of the extension resources this caller creates — tasks, surfaces,
 * workspaces.
 *
 * Not derived here. The gateway's bearer gate mints it once with `expansionOwner`, the function its REST and A2A
 * routes use, and stamps it on `AuthInfo.extra.owner`. This module used to re-derive it from `principalKind`,
 * a second spelling that already disagreed with the first (any kind but `oauth` became `api-key:`). The
 * credential-less mounts — stdio and loopback development — have exactly one principal, whose owner is the
 * constant the gateway composes for it. An `AuthInfo` with no stamped owner gets `undefined`, and
 * {@linkcode registerCatalog} then offers that caller no extension tool rather than guessing a realm.
 */
export function extensionOwnerOf(authInfo: AuthInfo | undefined): string | undefined {
	if (authInfo === undefined) return 'anonymous-loopback:local';
	const owner = authInfo.extra?.owner;
	return typeof owner === 'string' && owner !== '' ? owner : undefined;
}

/**
 * F1 (containment-otel-links design §2.0 item 5, §2.7): Unix seconds at which this call's credential stops being in
 * force, where the credential says so itself — or `undefined`.
 *
 * The gateway's bearer gate stamps the GW-1 credential on `AuthInfo.extra.credential`; for an OAuth token it is
 * `oauth:<ms>` (the token's `exp` in milliseconds, or the gateway horizon for a token without one), and a delegated
 * token carries its delegator's. Any other shape — an API key's or an account's credential, a missing `extra`, the
 * credential-less mounts — has no expiry of its own here and yields `undefined`. Read by `browser_file_link` as the
 * signed link's `notAfter` (WS-C); S0 only computes it.
 *
 * SEC-2 (review, D-140 amended): a delegated MCP bearer (`ttkd_`, `extra.delegatedMcp`, an agent task's, life at most
 * 120 s) carries its delegator's credential, which for an API key or an account has no expiry — so a link minted under
 * the delegation lived the full hour and outlived the task. For such a bearer the gateway's own `expiresAt` caps the
 * result too: the earlier of the two wins, rounded down. Only a delegated bearer is capped this way.
 */
export function credentialNotAfterOf(authInfo: AuthInfo | undefined): number | undefined {
	const credential = authInfo?.extra?.credential;
	const match = typeof credential === 'string' ? /^oauth:(\d+)$/.exec(credential) : null;
	const oauth = match === null ? undefined : Math.floor(Number(match[1]) / 1000);
	const bearer = authInfo?.extra?.delegatedMcp === true && Number.isFinite(authInfo.expiresAt)
		? Math.floor(authInfo.expiresAt as number)
		: undefined;
	if (oauth === undefined) return bearer;
	return bearer === undefined ? oauth : Math.min(oauth, bearer);
}

/**
 * The deployment facts the availability predicates read (R5).
 *
 * Recomputed for every request, which is what makes the tool list *dynamic*
 * under a stateless-per-request protocol: there is no long-lived server whose
 * registrations drift out of date, only a fresh one built from the state that
 * is true right now.
 *
 * G-2: the takeover lock used to be here as `allSessionsLocked` and is not any
 * more. Both facts left are static configuration an operator chose, which is
 * what makes disabling a tool honest; a lock is per session while this list is
 * per connection, and `SessionRegistry.assertUnlocked` already answers it
 * correctly in every case. This revises D-027.
 */
export function availabilityOf(deps: McpDeps): ToolAvailability {
	const services = deps.services?.();
	return {
		persistence: deps.persistence ?? false,
		recording: deps.recorder !== undefined,
		egress: deps.egress ?? false,
		headRouting: deps.headRouting ?? null,
		...(services === undefined ? {} : { services }),
		// S0 (design §2.0 item 8): the opt-in switches, each omitted while off so the shape is unchanged by default.
		...(deps.signedLink === undefined ? {} : { signedLinks: true }),
		...(deps.mcpApps === undefined ? {} : { mcpApps: true }),
		...(deps.viewUrl === undefined ? {} : { handoff: true }),
		...(deps.sandboxClone?.() === true ? { sandboxClone: true } : {}),
	};
}

/**
 * The S0 pass-throughs every tool context carries (design §2.0 item 8): the caller's session access and the opt-in
 * deployment hooks, each present only when wired. `owner` is the realm-qualified owner where the caller has one.
 */
function seamContext(
	deps: McpDeps,
	owner: string,
	scopes: ReadonlySet<Scope>,
	credential?: string,
): Pick<ToolContext, 'access' | 'viewUrl' | 'signedLink' | 'mcpApps'> {
	const access: SessionAccess = { owner, admin: scopes.has('admin') };
	return {
		access,
		...(deps.viewUrl === undefined ? {} : { viewUrl: deps.viewUrl }),
		...(deps.signedLink === undefined ? {} : { signedLink: bindCredential(deps.signedLink, credential) }),
		...(deps.mcpApps === undefined ? {} : { mcpApps: deps.mcpApps }),
	};
}

/**
 * D-148: the minter with the call's own GW-1 credential bound in, so a link minted under an account API key can be
 * bound to that key. The tool never sees the credential, and whatever `credential` a caller of the minter passes is
 * dropped for this one — the credential is the mount's to say, not a tool's.
 */
function bindCredential(minter: SignedLinkMinter, credential: string | undefined): SignedLinkMinter {
	return (input) => {
		const { credential: _ignored, ...request } = input;
		return minter(credential === undefined ? request : { ...request, credential });
	};
}

/** GW-1: the credential fingerprint the bearer gate stamped on `authInfo`, or `undefined`. */
function credentialOf(authInfo: AuthInfo | undefined): string | undefined {
	const credential = authInfo?.extra?.credential;
	return typeof credential === 'string' && credential !== '' ? credential : undefined;
}

/**
 * D-082: re-reads every registered tool's availability on a long-lived server (a stateful session, a stdio
 * connection) and enables or disables it to match; the SDK announces `tools/list_changed` for each change. A
 * server built per request needs none of this: its next build reads the live state.
 */
const refreshers = new WeakMap<McpServer, () => void>();
export function refreshToolAvailability(server: McpServer): void {
	refreshers.get(server)?.();
}

/**
 * Registers every tool the principal is entitled to.
 *
 * A tool the caller cannot use is not registered at all, so it never appears
 * in `tools/list` — an unusable affordance in the list is worse than no
 * affordance, because a model will plan around it.
 *
 * Scope decides *registration*; availability (R5) decides `enabled`. The
 * difference matters to the caller: a tool absent for lack of a scope is
 * genuinely not part of this principal's world, while one disabled because a
 * human has the browser is coming back, and calling it reports it as disabled
 * rather than as unknown.
 */
export function registerCatalog(
	server: McpServer,
	deps: McpDeps,
	authInfo: AuthInfo | undefined,
	// R6/F3 (D-126): the factory's `requestState` codec, whose `mint` a handler seals its round state with. Absent
	// where a server is built without one (a test listing tools); handlers then mint no state at all.
	stateCodec?: ToolContext['stateCodec'],
): DispatchContext {
	const scopes = scopesOf(deps, authInfo);
	const extensionPrincipal = extensionOwnerOf(authInfo);
	const extensionNames = new Set((deps.extraTools ?? []).map((tool) => tool.name));
	const principal = principalOf(authInfo);
	const credentialNotAfter = credentialNotAfterOf(authInfo);
	const ctx: ToolContext = {
		// B3.2: the already-filtered block, so `browser_health` reports this
		// principal's world and cannot widen it by rebuilding it from wider inputs.
		capabilities: capabilitiesFor(deps, authInfo),
		registry: deps.registry,
		allowedDomains: deps.allowedDomains ?? [],
		principal,
		...(extensionPrincipal === undefined ? {} : { extensionPrincipal }),
		// B2.8: the same set registration filters on, so `browser_audit`'s row filter and the catalog
		// gate cannot disagree about what this principal holds. Registration decides which tools exist
		// for a caller; this decides which *rows* one of them returns (SEC-08).
		scopes,
		...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
		...(deps.recorder === undefined ? {} : { recorder: deps.recorder }),
		...(deps.fileUrl === undefined ? {} : { fileUrl: deps.fileUrl }),
		...(deps.logger === undefined ? {} : { logger: deps.logger }),
		// R8 seam (S0): session lookups carry the caller; `shared` mode ignores it.
		...seamContext(deps, extensionPrincipal ?? principal, scopes, credentialOf(authInfo)),
		...(stateCodec === undefined ? {} : { stateCodec }),
		// F1 (design §2.0 item 5): an OAuth credential's own expiry, which a signed link may not outlive (WS-C).
		...(credentialNotAfter === undefined ? {} : { credentialNotAfter }),
	};

	const availability = availabilityOf(deps);
	const permitted = new Set<string>();
	const gated: { tool: ToolDefinition; registered: { enabled: boolean; enable(): void; disable(): void } }[] = [];

	// The library tools are not extension tools in the GW-5 sense: they touch shared storage, not owned
	// resources, so a principal without an owner (the stdio mount) may still hold them on its scopes.
	const catalog = [...CATALOG, ...(deps.extraTools ?? []), ...libraryTools(deps.library ?? null)];
	if (new Set(catalog.map((tool) => tool.name)).size !== catalog.length) {
		throw new Error('duplicate tool in composed catalog');
	}
	for (const tool of catalog) {
		if (tool.scope !== undefined && !scopes.has(tool.scope)) continue;
		// GW-5: an extension tool creates owned resources, so it exists only for a caller with a known owner.
		if (extensionPrincipal === undefined && extensionNames.has(tool.name)) continue;
		permitted.add(tool.name);
		// R9 (D-134): a tool that opens an MCP Apps embed says which one, and only while the deployment serves them;
		// with `TTK_MCP_APPS` off no tool carries `_meta.ui`.
		const uiMeta = deps.mcpApps === undefined ? undefined : toolUiMeta(tool.name);

		const registered = server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				// D-A2: declared here so `tools/list` advertises it. The dispatcher
				// enforces it on the way out rather than relying on the SDK's own
				// `validateToolOutput`, which the seam bypasses.
				outputSchema: tool.outputSchema,
				annotations: annotationsFor(tool),
				...(uiMeta === undefined ? {} : { _meta: uiMeta }),
			},
			// Unreachable while the D-A2 seam holds — `installToolDispatch` replaces
			// `tools/call` wholesale — but registered because `tools/list` reads this
			// registry. It routes through the same `runToolHandler` so the seam
			// failing open could never introduce a second error-text producer with a
			// different envelope (report_design.md F-4).
			async (args: unknown, mcp: ServerContext): Promise<ToolResult> =>
				await runToolHandler(tool, args, {
					// The SDK context is per *call*; `ctx` is per server instance. The
					// sampling-backed tools need the call one to read `inputResponses`
					// and to return `input_required`, so it is merged in here rather
					// than captured once at registration.
					//
					// Capabilities are read here for the same reason: on the 2026 era
					// the SDK backfills them per request from the envelope, so at
					// registration time they are not known yet. A tool that needs the
					// client's model can then say so in a result the model can read,
					// rather than failing as a protocol error several layers away.
					...ctx,
					mcp,
					clientSupportsSampling: server.server.getClientCapabilities()?.sampling !== undefined,
				}, deps.logger),
		);

		if (tool.available !== undefined && !tool.available(availability)) registered.disable();
		if (tool.available !== undefined) gated.push({ tool, registered });
	}
	refreshers.set(server, () => {
		const now = availabilityOf(deps);
		for (const { tool, registered } of gated) {
			const on = tool.available!(now);
			if (on !== registered.enabled) on ? registered.enable() : registered.disable();
		}
	});

	return {
		catalog: new Map(catalog.map((tool) => [tool.name, tool])),
		permitted,
		scopes,
		// D-082: read at call time, so a long-lived connection refuses a tool whose service went down since.
		get availability() {
			return availabilityOf(deps);
		},
		ctx,
		...(deps.logger === undefined ? {} : { logger: deps.logger }),
		...(deps.onToolCall === undefined ? {} : { onToolCall: deps.onToolCall }),
		// R5 (D-125): only the MCP path can ask a human; `createToolExecutor` never sets it.
		...(deps.confirmations === undefined ? {} : { confirmations: deps.confirmations }),
		...(deps.traceTool === undefined ? {} : { traceTool: deps.traceTool }),
	};
}

/**
 * Executes tools for a protocol adapter using the same argument, scope,
 * deployment, output, and takeover gates as MCP. No sampling is implied.
 */
export function createToolExecutor(
	deps: McpDeps,
	principal: string,
	scopes: ReadonlySet<Scope>,
	signal?: AbortSignal,
): (name: string, args: unknown) => Promise<ToolResult> {
	const catalog = [...CATALOG, ...(deps.extraTools ?? []), ...libraryTools(deps.library ?? null)];
	if (new Set(catalog.map((tool) => tool.name)).size !== catalog.length) throw new Error('duplicate tool name');
	const dispatch: DispatchContext = {
		catalog: new Map(catalog.map((tool) => [tool.name, tool])),
		permitted: new Set(catalog.filter((tool) => tool.scope === undefined || scopes.has(tool.scope)).map((t) => t.name)),
		scopes,
		availability: availabilityOf(deps),
		ctx: {
			signal,
			registry: deps.registry,
			allowedDomains: deps.allowedDomains ?? [],
			principal,
			scopes,
			secrets: deps.secrets,
			recorder: deps.recorder,
			fileUrl: deps.fileUrl,
			logger: deps.logger,
			clientSupportsSampling: false,
			// R8 seam (S0): here `principal` is already the realm-qualified owner.
			...seamContext(deps, principal, scopes),
		},
		logger: deps.logger,
		...(deps.traceTool === undefined ? {} : { traceTool: deps.traceTool }),
	};
	const observe = deps.onToolCall;
	// R7 (D-127): an agent task's calls are traced like `tools/call`'s, through the same wrapper.
	const run = (name: string, args: unknown): Promise<ToolResult> =>
		tracedDispatch(dispatch, name, () => dispatchToolCall(dispatch, name, args));
	if (observe === undefined) return run;
	return async (name: string, args: unknown): Promise<ToolResult> => {
		const result = await run(name, args);
		observe(name, result);
		return result;
	};
}

/**
 * The `capabilities.tykotech` block for one principal (B3.1, §8).
 *
 * Exported so the resource and `browser_health` read the block the `initialize` result carries
 * rather than each building their own — three read points, one builder, and a test that asserts the
 * three agree.
 */
export function capabilitiesFor(deps: McpDeps, authInfo: AuthInfo | undefined): TykotechCapabilities {
	// D-081: the same composed catalog `registerCatalog` registers from, minus the extension tools a caller with
	// no owner can never hold (GW-5) — absent for that caller by design, not withheld from it.
	const owned = extensionOwnerOf(authInfo) !== undefined;
	const tools = [
		...CATALOG,
		...(owned ? deps.extraTools ?? [] : []),
		...libraryTools(deps.library ?? null),
	];
	return buildCapabilities({
		version: deps.version,
		scopes: scopesOf(deps, authInfo),
		availability: availabilityOf(deps),
		tools,
		...(deps.liveView === undefined ? {} : { liveView: deps.liveView }),
		...(deps.eventTransports === undefined ? {} : { eventTransports: deps.eventTransports }),
		...sandboxInput(owned ? deps.sandboxBackend?.() ?? null : null),
		// D-094: read from the registry the launcher reads; a stand-in registry without the getter reports nothing.
		...(typeof deps.registry.chromiumSandboxed === 'boolean'
			? { chromiumSandboxed: deps.registry.chromiumSandboxed }
			: {}),
		// D-128: `TTK_SESSION_OWNERSHIP`, from the registry that enforces it; a stand-in without it reports nothing.
		...(typeof deps.registry.ownership === 'string' ? { sessionOwnership: deps.registry.ownership } : {}),
		// D-143: the provider counts, for the `model:invoke` holder's `model` block; absent means none configured.
		...(deps.modelProviders === undefined ? {} : { model: deps.modelProviders() }),
	});
}

/**
 * The session access each built server's caller carries (R8, D-128), so a long-lived connection's notification
 * watcher filters on the very access its tools and resources use rather than re-deriving one from the `AuthInfo`.
 */
const accesses = new WeakMap<McpServer, SessionAccess>();

/** The caller's session access of a server {@linkcode createBuildServer} built; `undefined` for any other server. */
export function serverSessionAccess(server: McpServer): SessionAccess | undefined {
	return accesses.get(server);
}

/** D-108: the sandbox block's input, for a caller who can hold its tools (GW-5) once the sandbox has said. */
function sandboxInput(backend: 'bwrap' | 'docker' | null): { sandbox?: { backend: 'bwrap' | 'docker' } } {
	return backend === null ? {} : { sandbox: { backend } };
}

/** How long a minted `requestState` is honoured: one human-paced round (R6/F3, D-126). */
export const REQUEST_STATE_TTL_SECONDS = 600;

/**
 * The `requestState` codec one server factory seals and verifies every multi-round-trip round with (R6/F3, D-126).
 *
 * `requestState` comes back from the client and is attacker-controlled on re-entry, so it is an HMAC-SHA256 envelope
 * (the SDK's own codec) bound to the method and the authenticated client: state minted for one principal and echoed
 * by another fails `verify`, which the SDK answers with the frozen `-32602` before any handler runs. Signed, not
 * encrypted — a payload carries identifiers only (a run id, a session id), never a secret. The binding is the
 * `clientId` the gateway's bearer gate stamps, or `local` on the credential-less mounts, where there is one principal.
 */
export function createStateCodec(key?: Uint8Array): RequestStateCodec<Record<string, unknown>> {
	return createRequestStateCodec<Record<string, unknown>>({
		key: key ?? crypto.getRandomValues(new Uint8Array(32)),
		ttlSeconds: REQUEST_STATE_TTL_SECONDS,
		bind: (c) => `${c.mcpReq.method}\0${c.http?.authInfo?.clientId ?? 'local'}`,
	});
}

/** Builds the per-request/per-connection server factory. */
export function createBuildServer(deps: McpDeps): McpServerFactory {
	// R6/F3 (D-126): one codec per factory, so every per-request server it builds verifies what its siblings minted.
	const codec = createStateCodec(deps.requestStateKey);
	const stateCodec: ToolContext['stateCodec'] = { mint: (payload, mcp) => codec.mint(payload, mcp) };
	return (ctx) => {
		// `inputRequired.maxRounds` bounds how many times a handler may answer
		// "ask your model and call me again" on the *legacy* era, where the SDK's
		// own shim drives the loop. The default of 8 would cap `browser_run_task`
		// well below its own step budget, so it is raised to match; the modern era
		// is bounded by the client's setting instead, which is the client's call.
		//
		// R14 (D-122): the identity and the instructions. The instructions are built from this caller's already
		// filtered capability block, so it is computed first.
		const capabilities = capabilitiesFor(deps, ctx.authInfo);
		const server = new McpServer(
			serverImplementation(deps.version, deps.identity),
			{
				inputRequired: { maxRounds: MAX_TASK_STEPS + 4 },
				instructions: serverInstructions(capabilities),
				// R6/F3 (D-126): every echoed `requestState` is verified before a handler sees it.
				requestState: { verify: codec.verify },
			},
		);
		// B3.1 / §8: the vendor block on the `initialize` result, scope-filtered.
		//
		// **The cast is the whole of U-8's cost.** `ServerCapabilities` is
		// `z.infer` of a `$strip` object, so the *type* is closed and an extra key
		// is an excess-property error; the *runtime* is open, because the outbound
		// path never parses (`_oninitialize` returns `getCapabilities()` verbatim
		// and `mergeCapabilities` preserves unknown keys). Measured on both eras
		// in build/evidence/b3_1_u8_capabilities_probe.log rather than assumed —
		// and asserted again by `capabilities_test.ts` through the real HTTP entry,
		// so an SDK minor that starts stripping the key fails a test here instead
		// of silently removing a field ADM branches on.
		server.server.registerCapabilities({ tykotech: capabilities } as unknown as ServerCapabilities);
		const dispatch = registerCatalog(server, deps, ctx.authInfo, stateCodec);
		// D-A2: replaces the SDK's `tools/call` so a refused tool, an argument
		// violation and a handler failure all carry a code. Strictly after
		// `registerCatalog` — the SDK auto-installs its own handler on the first
		// `registerTool` and asserts none exists yet.
		installToolDispatch(server, dispatch);
		if (dispatch.ctx.access !== undefined) accesses.set(server, dispatch.ctx.access);
		// R4: the live sessions, addressable and re-readable without a tool call.
		// Scoped on `mcp:invoke`, like the tools: the resources carry the same page
		// content, and reading it is not something a viewer credential buys.
		// The capabilities resource rides the same registration and is deliberately
		// NOT scoped on `mcp:invoke`: it describes the caller's own world and a
		// viewer credential is entitled to know what it may watch (§10.1 location 2).
		// R8 (D-128): narrowed to the caller's sessions in `owner` mode; R13: completers closed over the same access.
		registerResources(server, deps.registry, dispatch.scopes, capabilities, dispatch.ctx.access);
		// D-075: the share's files, the skills and the stored prompts, for a principal holding `files:read`.
		registerLibrary(server, deps.library ?? null, dispatch.scopes);
		// R9 (D-134): the two `ui://` embeds, only when `TTK_MCP_APPS` is on and only for `mcp:invoke`.
		if (deps.mcpApps !== undefined) registerUiResources(server, deps.mcpApps, dispatch.scopes);
		return server;
	};
}
