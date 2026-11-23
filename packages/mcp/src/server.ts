/** The MCP server factory. */
import {
	type AuthInfo,
	createRequestStateCodec,
	McpServer,
	type McpServerFactory,
	type RequestStateCodec,
	type ServerCapabilities,
	type ServerContext,
} from '@modelcontextprotocol/server';
import { MAX_TASK_STEPS } from './agent.ts';
import { buildCapabilities, type LiveViewCapabilities, type TykotechCapabilities } from './capabilities.ts';
import { annotationsFor, CATALOG, type ToolAvailability, type ToolDefinition } from './catalog.ts';
import { DEFAULT_SCOPES, type Scope } from './scopes.ts';
import { type DispatchContext, dispatchToolCall, installToolDispatch, runToolHandler } from './dispatch.ts';
import { serverImplementation, serverInstructions } from './identity.ts';
import { registerResources } from './resources.ts';
import type { LibraryStore } from './library.ts';
import { libraryTools, registerLibrary } from './library_tools.ts';
import type { SessionAccess, SessionRegistry } from './registry.ts';
import type { SecretStore } from './secrets.ts';
import {
	entryTool,
	type GroupMember,
	type GroupState,
	type ListedTool,
	TOOL_GROUPS,
	type ToolGroup,
	toolGroupOf,
} from './tool_groups.ts';
import type { McpAppsDeps, RecordingController, SignedLinkMinter, ToolContext, ToolResult } from './types.ts';
import { registerUiResources, toolUiMeta } from './ui_resources.ts';

export interface McpDeps {
	/** Optional service tools, composed by the CLI/gateway without changing browser contracts. */
	readonly extraTools?: readonly ToolDefinition[];
	/** The library on the data volume. */
	readonly library?: LibraryStore;
	/** The live health of the configured private services; absent, nothing is withheld for health. */
	readonly services?: () => { readonly sandbox?: boolean };
	/**
	 * The configured coding sandbox's backend, as its last health answer said (null before one); absent when no
	 * sandbox is configured. Feeds `capabilities.tykotech.sandbox`.
	 */
	readonly sandboxBackend?: () => 'bwrap' | 'docker' | null;
	readonly registry: SessionRegistry;
	readonly version: string;
	/** Suffix-match navigation allowlist; empty means unrestricted. */
	readonly allowedDomains?: readonly string[];
	/** Server-held secrets a model may reference by name. */
	readonly secrets?: SecretStore;
	/** True when persistent profiles and storage state are configured. */
	readonly persistence?: boolean;
	/** Session recording, when the deployment can encode video. */
	readonly recorder?: RecordingController;
	/**
	 * True when `probeEgressGrant` proved an outbound net grant beyond loopback at startup. Absent means false: a
	 * mount that did not probe offers no server-side egress tool.
	 */
	readonly egress?: boolean;
	/** Why `browser_head` must refuse beyond the grant, or absent. */
	readonly headRouting?: string | null;
	/** Authenticated HTTP URL builder for session files; absent on stdio. */
	readonly fileUrl?: (sessionId: string, fileId: string) => string;
	/**
	 * Scopes for a principal with no credential to carry a grant — stdio and the loopback-dev mount. Defaults to
	 * `DEFAULT_SCOPES`; an operator widens it with `TTK_ANON_SCOPES`, and it can never exceed `SCOPES`.
	 */
	readonly anonScopes?: readonly Scope[];
	/** The live-view ceilings for `capabilities.tykotech.live_view`. */
	readonly liveView?: LiveViewCapabilities;
	/** Stream transports this mount serves, for `capabilities.tykotech.events`. */
	readonly eventTransports?: readonly ('sse' | 'websocket')[];
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/**
	 * Told the name and result of every dispatched call — `tools/call` and an agent task's executor alike — after it
	 * ends, so the gateway can count them for `/metrics`.
	 */
	readonly onToolCall?: (tool: string, result: ToolResult) => void;
	/** The human handoff URL builder, set only with `TTK_HUMAN_HANDOFF=true`. */
	readonly viewUrl?: (sessionId: string) => string;
	/** `TTK_CONFIRM_DESTRUCTIVE` — the destructive set asks a form-capable client to confirm. */
	readonly confirmations?: boolean;
	/**
	 * The `requestState` HMAC key, ≥ 32 bytes. Absent, each {@linkcode createBuildServer}
	 * draws 32 random bytes once — enough, because a retry names its `session_id` and reaches the same process.
	 */
	readonly requestStateKey?: Uint8Array;
	/** The signed-link minter, set only with `TTK_SIGNED_LINKS=true`. */
	readonly signedLink?: SignedLinkMinter;
	/** The deployment's public identity for `serverInfo`; absent on stdio. */
	readonly identity?: { readonly websiteUrl?: string; readonly iconUrl?: string };
	/**
	 * Tool groups (`TTK_MCP_TOOL_GROUPS`): list each group's tools behind one `use_<group>` entry tool until the
	 * model opens the group (`tool_groups.ts`).
	 */
	readonly toolGroups?: boolean;
	/** The MCP Apps deployment, set only when `TTK_MCP_APPS` is not `off`. */
	readonly mcpApps?: McpAppsDeps;
	/** Whether the sandbox offers `clone`, read live; feeds `availability.sandboxClone`. */
	readonly sandboxClone?: () => boolean;
	/**
	 * How many model providers are configured and how many the process's net grant reaches, set by the gateway from
	 * the providers in force (the database's).
	 */
	readonly modelProviders?: () => { readonly providers: number; readonly reachable: number };
}

function scopesOf(deps: McpDeps, authInfo: AuthInfo | undefined): ReadonlySet<Scope> {
	// "Spawner-trusted" means the process may act as the user, not that every scope this build will ever declare is
	// pre-consented — so a credential-less mount gets DEFAULT_SCOPES, never the whole vocabulary.
	if (authInfo === undefined) return new Set(deps.anonScopes ?? DEFAULT_SCOPES);
	return new Set(authInfo.scopes as Scope[]);
}

function principalOf(authInfo: AuthInfo | undefined): string {
	return authInfo?.clientId ?? 'local';
}

/** The realm-qualified owner of the extension resources this caller creates — tasks, surfaces, workspaces. */
function extensionOwnerOf(authInfo: AuthInfo | undefined): string | undefined {
	if (authInfo === undefined) return 'anonymous-loopback:local';
	const owner = authInfo.extra?.owner;
	return typeof owner === 'string' && owner !== '' ? owner : undefined;
}

/** The deployment facts the availability predicates read. */
export function availabilityOf(deps: McpDeps): ToolAvailability {
	const services = deps.services?.();
	return {
		persistence: deps.persistence ?? false,
		recording: deps.recorder !== undefined,
		egress: deps.egress ?? false,
		headRouting: deps.headRouting ?? null,
		...(services === undefined ? {} : { services }),
		// The opt-in switches, each omitted while off so the shape is unchanged by default.
		...(deps.signedLink === undefined ? {} : { signedLinks: true }),
		...(deps.mcpApps === undefined ? {} : { mcpApps: true }),
		...(deps.viewUrl === undefined ? {} : { handoff: true }),
		...(deps.sandboxClone?.() === true ? { sandboxClone: true } : {}),
	};
}

/**
 * The pass-throughs every tool context carries: the caller's session access and the opt-in
 * deployment hooks, each present only when wired. `owner` is the realm-qualified owner where the caller has one.
 */
function passThroughContext(
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
		...(deps.mcpApps === undefined ? {} : { mcpApps: bindTicketCredential(deps.mcpApps, credential) }),
	};
}

/**
 * The MCP Apps deployment with the call's own credential fingerprint bound into its ticket mint, as
 * {@linkcode bindCredential} does for signed links, so the live-view socket can re-check the credential that minted
 * its ticket. Whatever `credential` a tool passes is dropped; the mount's is the one used.
 */
function bindTicketCredential(apps: McpAppsDeps, credential: string | undefined): McpAppsDeps {
	return {
		...apps,
		mintTicket: (input) => {
			const { credential: _ignored, ...request } = input;
			return apps.mintTicket(credential === undefined ? request : { ...request, credential });
		},
	};
}

/**
 * The minter with the call's own credential fingerprint bound in, so a link minted under an account API key can be
 * bound to that key.
 */
function bindCredential(minter: SignedLinkMinter, credential: string | undefined): SignedLinkMinter {
	return (input) => {
		const { credential: _ignored, ...request } = input;
		return minter(credential === undefined ? request : { ...request, credential });
	};
}

/** The credential fingerprint the bearer gate stamped on `authInfo`, or `undefined`. */
function credentialOf(authInfo: AuthInfo | undefined): string | undefined {
	const credential = authInfo?.extra?.credential;
	return typeof credential === 'string' && credential !== '' ? credential : undefined;
}

/**
 * Re-reads every registered tool's availability on a long-lived server (a stateful session, a stdio connection) and
 * enables or disables it to match; the SDK announces `tools/list_changed` for each change.
 */
const refreshers = new WeakMap<McpServer, () => void>();
export function refreshToolAvailability(server: McpServer): void {
	refreshers.get(server)?.();
}

/** Registers every tool the principal is entitled to. */
export function registerCatalog(
	server: McpServer,
	deps: McpDeps,
	authInfo: AuthInfo | undefined,
	// The factory's `requestState` codec, whose `mint` a handler seals its round state with. Absent
	// where a server is built without one (a test listing tools); handlers then mint no state at all.
	stateCodec?: ToolContext['stateCodec'],
): DispatchContext {
	const scopes = scopesOf(deps, authInfo);
	const extensionPrincipal = extensionOwnerOf(authInfo);
	const extensionNames = new Set((deps.extraTools ?? []).map((tool) => tool.name));
	const principal = principalOf(authInfo);
	const ctx: ToolContext = {
		// The already-filtered block, so `browser_health` reports this
		// principal's world and cannot widen it by rebuilding it from wider inputs.
		capabilities: capabilitiesFor(deps, authInfo),
		registry: deps.registry,
		allowedDomains: deps.allowedDomains ?? [],
		principal,
		...(extensionPrincipal === undefined ? {} : { extensionPrincipal }),
		// The same set registration filters on, so `browser_audit`'s row filter and the catalog gate cannot disagree
		// about what this principal holds.
		scopes,
		...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
		...(deps.recorder === undefined ? {} : { recorder: deps.recorder }),
		...(deps.fileUrl === undefined ? {} : { fileUrl: deps.fileUrl }),
		...(deps.logger === undefined ? {} : { logger: deps.logger }),
		// Session lookups carry the caller; `shared` mode ignores it.
		...passThroughContext(deps, extensionPrincipal ?? principal, scopes, credentialOf(authInfo)),
		...(stateCodec === undefined ? {} : { stateCodec }),
	};

	const availability = availabilityOf(deps);
	const permitted = new Set<string>();
	// Every registration whose listing can change after connect: an availability predicate, a group, or both.
	const gated: { tool: ToolDefinition; group?: ToolGroup; registered: ListedTool }[] = [];
	// Tool groups: the groups this connection's model has opened, and each group's members as registered here.
	const groups: GroupState = {
		open: new Set<ToolGroup>(),
		availability: () => availabilityOf(deps),
		// One announcement per opening; a send that fails is the stream's own end, as in `StatefulMount`.
		announce: () => {
			if (server.isConnected()) void server.server.sendToolListChanged().catch(() => {});
		},
	};
	const members = new Map<ToolGroup, GroupMember[]>();

	const register = (tool: ToolDefinition): ListedTool => {
		// A tool that opens an MCP Apps embed says which one, and only while the deployment serves them;
		// with `TTK_MCP_APPS` off no tool carries `_meta.ui`.
		const uiMeta = deps.mcpApps === undefined ? undefined : toolUiMeta(tool.name);
		return server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				// Declared here so `tools/list` advertises it. The dispatcher enforces it on the way out rather than
				// relying on the SDK's own `validateToolOutput`, which the replaced `tools/call` handler bypasses.
				outputSchema: tool.outputSchema,
				annotations: annotationsFor(tool),
				...(uiMeta === undefined ? {} : { _meta: uiMeta }),
			},
			// Unreachable while `installToolDispatch` replaces `tools/call` wholesale, but registered because
			// `tools/list` reads this registry.
			async (args: unknown, mcp: ServerContext): Promise<ToolResult> =>
				await runToolHandler(tool, args, {
					// The SDK context is per *call*; `ctx` is per server instance.
					...ctx,
					mcp,
					clientSupportsSampling: server.server.getClientCapabilities()?.sampling !== undefined,
				}, deps.logger),
		);
	};

	// The library tools are not owner-bound extension tools: they touch shared storage, not owned
	// resources, so a principal without an owner (the stdio mount) may still hold them on its scopes.
	const catalog = [...CATALOG, ...(deps.extraTools ?? []), ...libraryTools(deps.library ?? null)];
	if (new Set(catalog.map((tool) => tool.name)).size !== catalog.length) {
		throw new Error('duplicate tool in composed catalog');
	}
	for (const tool of catalog) {
		if (tool.scope !== undefined && !scopes.has(tool.scope)) continue;
		// An extension tool creates owned resources, so it exists only for a caller with a known owner.
		if (extensionPrincipal === undefined && extensionNames.has(tool.name)) continue;
		permitted.add(tool.name);
		const registered = register(tool);
		const group = deps.toolGroups === true ? toolGroupOf(tool.name) : undefined;
		// A grouped tool waits unlisted for its entry tool. Disabled before the server connects, so nothing is announced.
		if (group !== undefined || (tool.available !== undefined && !tool.available(availability))) registered.disable();
		if (tool.available !== undefined || group !== undefined) gated.push({ tool, group, registered });
		if (group !== undefined) {
			const held = members.get(group) ?? [];
			held.push({ tool, listed: registered });
			members.set(group, held);
		}
	}
	// One entry tool per group this caller holds a tool of. Dispatched like any tool, through the same dispatcher.
	const entries: ToolDefinition[] = [];
	for (const group of TOOL_GROUPS) {
		const held = members.get(group);
		if (held === undefined) continue;
		const entry = entryTool(group, held, groups);
		permitted.add(entry.name);
		const registered = register(entry);
		if (!entry.available!(availability)) registered.disable();
		gated.push({ tool: entry, registered });
		entries.push(entry);
	}
	refreshers.set(server, () => {
		const now = availabilityOf(deps);
		for (const { tool, group, registered } of gated) {
			// A grouped member returns only to an opened group: a service coming back does not undo the grouping.
			const on = (tool.available === undefined || tool.available(now)) &&
				(group === undefined || groups.open.has(group));
			if (on !== registered.enabled) on ? registered.enable() : registered.disable();
		}
	});

	return {
		catalog: new Map([...catalog, ...entries].map((tool) => [tool.name, tool])),
		permitted,
		scopes,
		// Read at call time, so a long-lived connection refuses a tool whose service went down since.
		get availability() {
			return availabilityOf(deps);
		},
		ctx,
		...(deps.logger === undefined ? {} : { logger: deps.logger }),
		...(deps.onToolCall === undefined ? {} : { onToolCall: deps.onToolCall }),
		// Only the MCP path can ask a human; `createToolExecutor` never sets it.
		...(deps.confirmations === undefined ? {} : { confirmations: deps.confirmations }),
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
			// Here `principal` is already the realm-qualified owner.
			...passThroughContext(deps, principal, scopes),
		},
		logger: deps.logger,
	};
	const observe = deps.onToolCall;
	const run = (name: string, args: unknown): Promise<ToolResult> => dispatchToolCall(dispatch, name, args);
	if (observe === undefined) return run;
	return async (name: string, args: unknown): Promise<ToolResult> => {
		const result = await run(name, args);
		observe(name, result);
		return result;
	};
}

/** The `capabilities.tykotech` block for one principal. */
export function capabilitiesFor(deps: McpDeps, authInfo: AuthInfo | undefined): TykotechCapabilities {
	// The same composed catalog `registerCatalog` registers from, minus the extension tools a caller with
	// no owner can never hold — absent for that caller by design, not withheld from it.
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
		// Read from the registry the launcher reads; a stand-in registry without the getter reports nothing.
		...(typeof deps.registry.chromiumSandboxed === 'boolean'
			? { chromiumSandboxed: deps.registry.chromiumSandboxed }
			: {}),
		// `TTK_SESSION_OWNERSHIP`, from the registry that enforces it; a stand-in without it reports nothing.
		...(typeof deps.registry.ownership === 'string' ? { sessionOwnership: deps.registry.ownership } : {}),
		// The provider counts, for the `model:invoke` holder's `model` block; absent means none configured.
		...(deps.modelProviders === undefined ? {} : { model: deps.modelProviders() }),
		// Tool groups: `tool_groups` names the entry tools a grouped connection lists, from the same composed tools.
		...(deps.toolGroups === true ? { toolGroups: true } : {}),
	});
}

/**
 * The session access each built server's caller carries, so a long-lived connection's notification
 * watcher filters on the very access its tools and resources use rather than re-deriving one from the `AuthInfo`.
 */
const accesses = new WeakMap<McpServer, SessionAccess>();

/** The caller's session access of a server {@linkcode createBuildServer} built; `undefined` for any other server. */
export function serverSessionAccess(server: McpServer): SessionAccess | undefined {
	return accesses.get(server);
}

/** The sandbox block's input, for a caller who can hold its tools (one with an owner) once the sandbox has said. */
function sandboxInput(backend: 'bwrap' | 'docker' | null): { sandbox?: { backend: 'bwrap' | 'docker' } } {
	return backend === null ? {} : { sandbox: { backend } };
}

/** How long a minted `requestState` is honoured: one human-paced round. */
const REQUEST_STATE_TTL_SECONDS = 600;

/**
 * The `requestState` codec one server factory seals and verifies every multi-round-trip round with: an HMAC envelope
 * bound to the method and the authenticated client, because the client echoes it back.
 * Signed, not encrypted: it carries identifiers only.
 */
function createStateCodec(key?: Uint8Array): RequestStateCodec<Record<string, unknown>> {
	return createRequestStateCodec<Record<string, unknown>>({
		key: key ?? crypto.getRandomValues(new Uint8Array(32)),
		ttlSeconds: REQUEST_STATE_TTL_SECONDS,
		bind: (c) => `${c.mcpReq.method}\0${c.http?.authInfo?.clientId ?? 'local'}`,
	});
}

/** Builds the per-request/per-connection server factory. */
export function createBuildServer(deps: McpDeps): McpServerFactory {
	// One codec per factory, so every per-request server it builds verifies what its siblings minted.
	const codec = createStateCodec(deps.requestStateKey);
	const stateCodec: ToolContext['stateCodec'] = { mint: (payload, mcp) => codec.mint(payload, mcp) };
	return (ctx) => {
		// `inputRequired.maxRounds` bounds how many times a handler may answer "ask your model and call me again" on
		// the 2025 protocol era, where the SDK's own shim drives the loop.
		const capabilities = capabilitiesFor(deps, ctx.authInfo);
		const server = new McpServer(
			serverImplementation(deps.version, deps.identity),
			{
				inputRequired: { maxRounds: MAX_TASK_STEPS + 4 },
				instructions: serverInstructions(capabilities),
				// Every echoed `requestState` is verified before a handler sees it.
				requestState: { verify: codec.verify },
			},
		);
		// The vendor block on the `initialize` result, scope-filtered.
		server.server.registerCapabilities({ tykotech: capabilities } as unknown as ServerCapabilities);
		const dispatch = registerCatalog(server, deps, ctx.authInfo, stateCodec);
		// Replaces the SDK's `tools/call` so a refused tool, an argument violation and a handler failure all carry a
		// code.
		installToolDispatch(server, dispatch);
		if (dispatch.ctx.access !== undefined) accesses.set(server, dispatch.ctx.access);
		// The live sessions, addressable and re-readable without a tool call. Scoped on `mcp:invoke`, like the tools:
		// the resources carry the same page content, and reading it is not something a viewer credential buys.
		registerResources(server, deps.registry, dispatch.scopes, capabilities, dispatch.ctx.access, deps.secrets);
		// The share's files, the skills and the stored prompts, for a principal holding `files:read`.
		registerLibrary(server, deps.library ?? null, dispatch.scopes);
		// The three `ui://` embeds, only when `TTK_MCP_APPS` is on and only for `mcp:invoke`.
		if (deps.mcpApps !== undefined) registerUiResources(server, deps.mcpApps, dispatch.scopes);
		return server;
	};
}
