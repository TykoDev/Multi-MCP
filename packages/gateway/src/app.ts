/**
 * The Hono application: middleware order, routes, and the MCP mount.
 *
 * Middleware order is fixed — requestId → host/origin → auth → rate limit →
 * handler (SPECS/BACKEND.md §3). `createMcpHandler` performs no host
 * validation and no token verification of its own, so both must stand in
 * front of it here.
 */
import {
	createMcpHandler,
	getOAuthProtectedResourceMetadataUrl,
	isJsonContentType,
	oauthMetadataResponse,
	requireBearerAuth,
	validateHostHeader,
	validateOriginHeader,
} from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { type Context, Hono } from 'hono';
import {
	attachmentDisposition,
	createBuildServer,
	isToolError,
	type LiveViewCapabilities,
	type McpDeps,
	parseByteRange,
	resourceUris,
	SecretStore,
	type SessionAccess,
	type SessionRecord,
	type SessionRegistry,
} from '@tykotech/mcp';
import type { SandboxClient } from '@tykotech/sandbox';
import { ulid } from '@std/ulid';
import { type Config, ConfigError, isWildcardHost, type Scope, SCOPES } from './config.ts';
import { DEFAULT_SCOPES, EXPLICIT_SCOPES, SCOPE_GRANTS } from '@tykotech/mcp';
import {
	expansionOwner,
	generateAccountKey,
	holderNameOf,
	type Principal,
	principalFromAuthInfo,
	VerifierChain,
} from './auth.ts';
import { generateRandomPassword } from './admin_auth.ts';
import { type NewAccountKey, type PublicUser, UserStoreError } from './users.ts';
import { HttpProblem, problemResponse } from './problem.ts';
import { RateLimiter } from './ratelimit.ts';
import { TICKET_TTL_MAX_CONTROL_MS, TICKET_TTL_MAX_VIEW_MS, TicketStore } from './tickets.ts';
import type { Logger } from './logger.ts';
import { attachLiveView, createCastRegistry } from './liveview.ts';
import { attachEventStream, EventStreamRegistry } from './eventstream.ts';
import { effectiveOrigins, MAX_TOKEN_ORIGINS, normalizeTokenOrigin, originAllowed, OriginOverlay } from './origins.ts';
import { Recorder } from './recorder.ts';
import { createTelemetry, type Telemetry } from './telemetry.ts';
import { StatefulMount, wantsStatefulSession } from './stateful.ts';
import { BrowserMemoryCache, type DumpClient, gatewayMemory } from './browser_memory.ts';
import { type Cluster, FORWARDED_HEADER } from './cluster.ts';
import { fanOut, firstFound, forward, Router } from './routing.ts';
import { attachStatic } from './static.ts';
import { createMcpApps, type EmbedDocuments, embedOriginGate, loadEmbedDocuments, socketOrigin } from './mcp_apps.ts';
import { attachExpansionRoutes, createExpansionServices } from './expansion.ts';
import { MODEL_PROVIDERS_BODY_BYTES, ModelProvidersAdmin } from './model_providers_admin.ts';
import { AGENT_SETTINGS_BODY_BYTES, AgentSettingsStore } from './agent_settings.ts';
import { applyMemoryConfig, type MemoryStore, memorySystemView } from './memory.ts';
import { syncSealer } from './vault.ts';
import { attachShareRoutes } from './share.ts';
import { attachSandboxSessionRoutes } from './sandbox_sessions.ts';
import { attachOverviewRoute, createOverview } from './overview.ts';
import { LoginGuard } from './login_guard.ts';
import type { ServiceHealth } from './service_health.ts';
import type { LibraryStore, ToolResult } from '@tykotech/mcp';
import { capRequestBody, LOGIN_BODY_BYTES, readCappedBody } from './body_cap.ts';
import {
	GatewayMetrics,
	mayReadMetrics,
	METRICS_SCOPE,
	PROMETHEUS_CONTENT_TYPE,
	readMemory,
	toolOutcome,
	UNMATCHED_ROUTE,
} from './metrics.ts';
import { LOGIN_TOKEN_PREFIX } from './logins.ts';
import {
	clearedSessionCookie,
	clearedSessionCookies,
	cookieOriginAllowed,
	CSRF_HEADER,
	csrfFor,
	csrfMatches,
	isUnsafeMethod,
	parseSessionCookie,
	readSessionCookie,
	sessionCookie,
	sessionCookieSpec,
} from './session_cookie.ts';
import { pathRefusal, rawPathOf } from './request_path.ts';
import { createLinkMinter, createLinkSigner, LINK_PATH, LINK_TOKEN_PARAM, type LinkSigner } from './signed_links.ts';

/** Values carried on the Hono context between middleware and handlers. */
export interface AppVariables {
	requestId: string;
	principal: Principal;
	authInfo?: AuthInfo;
	parsedBody?: unknown;
	/**
	 * B4: the CSRF value of the sign-in cookie that authenticated this request; absent for every other credential.
	 * Its presence is how a handler knows the request was cookie-authenticated.
	 */
	csrf?: string;
}

export interface GatewayDeps {
	/** The configured coding sandbox; absent means none is configured. Its health is `health`'s to report. */
	readonly sandbox?: SandboxClient;
	/** D-082: the configured private services, watched while the server runs; their tools follow it. */
	readonly health?: ServiceHealth;
	readonly config: Config;
	readonly registry: SessionRegistry;
	readonly verifier: VerifierChain;
	readonly logger: Logger;
	readonly version: string;
	/** The shared session index, when this node is part of a cluster (R10). */
	readonly cluster?: Cluster;
	/**
	 * Whether the process holds an outbound net grant beyond loopback, as
	 * `probeEgressGrant` proved it at startup (SR-HEAD-REDIRECT). Absent is false.
	 */
	readonly egress?: boolean;
	/**
	 * D-143 (W3): what the model-provider grant proof and the push gate query; `Deno.permissions` unless a test injects
	 * a fake. Never from configuration: the matrix is the process's own.
	 */
	readonly permissions?: Pick<Deno.Permissions, 'querySync'>;
	/** Why `browser_head` must refuse beyond the grant, or absent (SR3-M2, D-049). */
	readonly headRouting?: string | null;
	/** D-075: the library on the data volume, built by the server from `config.dataDir`; absent without one. */
	readonly library?: LibraryStore;
	/**
	 * R7 (D-127): the process's tool-call telemetry. Absent, the app probes the runtime itself (`createTelemetry`);
	 * a test hands in an instance to observe the trace without starting OpenTelemetry.
	 */
	readonly telemetry?: Telemetry;
	/**
	 * F26 (D-128): the recorder to serve `/api/v1/recordings` from. Absent, the app builds one when the deployment can
	 * record (`TTK_DATA_DIR` and `TTK_FFMPEG`); a test injects one whose encoder is not a real `ffmpeg`, so the route's
	 * ownership refusal is proven without `--allow-run`.
	 */
	readonly recorder?: Recorder;
	/** R9: overrides where the MCP Apps embed documents are read from (tests); absent, the SPA's own web root. */
	readonly webRoot?: string;
	/**
	 * R10 (D-119): the link-signing key `startGateway` read or created (`loadLinkSigningKey`). Required whenever
	 * `config.signedLinks` is on and it names no key file; never logged, never returned.
	 */
	readonly signedLinkKey?: Uint8Array;
	/**
	 * D-140: the signed-link clock, milliseconds since the epoch — what a link's expiry and its OAuth cap are judged
	 * against when it is minted and when it is followed. Absent, `Date.now`; a test injects one to cross an expiry
	 * without waiting.
	 */
	readonly linkClock?: () => number;
	/**
	 * NF-3 (containment-otel-links design §2.0 item 6, §2.8): the one `SecretStore` the mount resolves secret references
	 * through, so the registry's `redact` and the tools' `ctx.secrets` can be the same instance. Absent, the app builds
	 * one from `config.secrets`, exactly as before; `startGateway` hands its own in (WS-D).
	 */
	readonly secrets?: SecretStore;
	/**
	 * D-153: the model provider store `startGateway` loaded (`ModelProvidersAdmin.load`) — the operator's providers file
	 * plus what administrators added under `TTK_DATA_DIR`. Absent, the app offers the file's providers only and refuses
	 * every change (a test or an embedder hands one in to manage providers).
	 */
	readonly modelProviderStore?: ModelProvidersAdmin;
	/** D-154: the agents' vector memory in the database `startGateway` opened; absent without a data directory. */
	readonly memory?: MemoryStore;
	/** D-158: the agents' settings in the same database; absent, the defaults apply and every change is refused. */
	readonly agentSettings?: AgentSettingsStore;
}

/** R8 (D-128): a principal's session access — its realm-qualified owner (D-068), and whether it holds `admin`. */
export function sessionAccessOf(principal: Principal): SessionAccess {
	return { owner: expansionOwner(principal), admin: principal.scopes.has('admin') };
}

/**
 * How often idle rate-limit buckets are swept.
 *
 * `RateLimiter.sweep` existed and was never called (G-8). It stopped being
 * unrelated to this specification the moment the specification added a
 * long-lived authenticated GET whose per-principal cap is by definition
 * per-principal state.
 */
const RATE_SWEEP_INTERVAL_MS = 300_000;

/**
 * The live-view half of `capabilities.tykotech` (B3.1, §8).
 *
 * **Every number is read from the constant the clamp itself reads**, never restated: a second
 * spelling of a ceiling is a second ceiling, and the one a client plans against would be the one
 * nothing enforces. The booleans are facts about this build — each names a socket message that
 * shipped in 0.2.0 — so they are literals here and asserted against the wire union by a test rather
 * than derived from a runtime the union does not expose.
 */
const LIVE_VIEW_CAPABILITIES: LiveViewCapabilities = {
	origins_managed: true,
	ticket_ttl_max_s: {
		view: Math.floor(TICKET_TTL_MAX_VIEW_MS / 1000),
		control: Math.floor(TICKET_TTL_MAX_CONTROL_MS / 1000),
	},
	frame_scale: true,
	hover: true,
	highlight: true,
	keyframe: true,
};

export interface GatewayApp {
	readonly app: Hono<{ Variables: AppVariables }>;
	/** F5: stage 1 of shutdown — refuse new sessions, tickets and live-view sockets; everything else still answers. */
	drain(): void;
	/** Releases MCP handler resources during shutdown. */
	close(): Promise<void>;
	readonly tickets: TicketStore;
}

/** Paths served without a credential. */
const PUBLIC_PATHS = new Set([
	'/.well-known/agent-card.json',
	// D-156: SlopLord's own A2A card — metadata only, like the main card; its endpoints stay behind the bearer gate.
	'/a2a/agents/sloplord/.well-known/agent-card.json',
	'/healthz',
	'/.well-known/oauth-protected-resource',
	'/.well-known/oauth-authorization-server',
	// F6. Browsers request this on their own the moment the SPA loads, and the
	// catch-all bearer gate answered it with a 401 plus an OAuth challenge — a
	// console error on every single page load, for a request the page never made.
	// Widening the matrix by one path is safe only because the handler below
	// returns no body and reads no state; see D-052.
	'/favicon.ico',
	'/api/v1/auth/login',
]);

function isPublic(path: string, signedLinks: boolean): boolean {
	if (PUBLIC_PATHS.has(path)) return true;
	// R10 (D-119), the D-052 precedent: one exact path, public only while signed links are on. The token in its query
	// is the credential, and the route verifies it — and re-checks the owner it names — before anything else.
	if (signedLinks && path === LINK_PATH) return true;
	// The live-view socket carries its own authentication: a browser WebSocket
	// cannot send an Authorization header, so it presents a single-use ticket
	// instead. Running the bearer gate here would reject every viewer before
	// the ticket is ever examined.
	if (path.startsWith('/live/')) return true;
	// The SPA and its assets are public; the API behind them is not.
	return path === '/' || path.startsWith('/assets/');
}

export function createGatewayApp(deps: GatewayDeps): GatewayApp {
	const { config, registry, verifier, logger } = deps;
	// R9 (W7, D-134): the MCP Apps embeds are read before anything below allocates a timer or a store, so a missing
	// build refuses startup (`ConfigError`) and leaves nothing running behind it. D-150: only when the operator named
	// the mode; the default `control` on a build without the embeds stays off with one warning instead, because a
	// deployment that never asked for MCP Apps must not fail to start for the want of them.
	const { embeds, appsSettings } = ((): { embeds?: EmbedDocuments; appsSettings: Config['mcpApps'] } => {
		const settings = config.mcpApps;
		if (settings === null) return { appsSettings: null };
		try {
			return { embeds: loadEmbedDocuments(config.publicUrl, deps.webRoot), appsSettings: settings };
		} catch (cause) {
			if (!settings.defaulted || !(cause instanceof ConfigError)) throw cause;
			logger.warn(
				`TTK_MCP_APPS is unset and stays off: ${cause.message.replace(/^TTK_MCP_APPS: /, '')}`,
			);
			return { appsSettings: null };
		}
	})();

	// `allowedOrigins: []` is deliberate, not a missing value: the adapter applies
	// origin validation whenever the option is present, so an empty list denies
	// every browser origin while leaving non-browser callers (no Origin) alone.
	// ERRATUM(E-06): the published 2.0.0 adapter has no `maxRequestBodySize`
	// option (the repo's `main` does); the 4 MiB cap comes from
	// `createMcpHandler`'s own default instead.
	//
	// **I-13: the array the adapter captures is never mutated and never omitted.**
	// The per-token overlay of B1.10 is a *second* check, installed after auth,
	// that can only reject further. Passing a deliberately wider list here so our
	// own check could be "the real one" would weaken a shipped security control;
	// omitting the option entirely would either substitute the adapter's own
	// hardcoded loopback list or disarm origin validation completely on a
	// non-loopback bind. Both are one edit away and neither is visible from the
	// overlay's own code, which is why `units_test.ts` asserts the captured array
	// is identical before and after a per-token write.
	const adapterOrigins = [...config.allowedOrigins];
	const app = createMcpHonoApp({
		allowedHosts: [...config.allowedHosts],
		allowedOrigins: adapterOrigins,
	}) as unknown as Hono<{ Variables: AppVariables }>;

	const tickets = new TicketStore();
	const limiter = new RateLimiter({ rpm: config.limits.rateRpm });
	// G-8's `sweep`, reopened narrowly and only this far. SEC-11 offers two
	// exits and the second is unavailable: the per-principal stream cap is by
	// definition per-principal state. Calling `sweep` changes no authority, no
	// wire surface and no credential. (The `task` repair, which this comment used
	// to cite as the contrasting case that stays deferred, was decided by the
	// owner on 2026-09-10 and is closed — SEC-01b, D-024.) Nothing else in G-8
	// moves; this exception is not a licence.
	// D-078: failed sign-ins, counted per source and per username; swept with the limiter.
	const loginGuard = new LoginGuard();
	const sweeper = setInterval(() => {
		limiter.sweep();
		loginGuard.sweep();
	}, RATE_SWEEP_INTERVAL_MS);
	Deno.unrefTimer(sweeper as unknown as number);
	const eventStreams = new EventStreamRegistry();
	const origins = new OriginOverlay({ dataDir: config.dataDir, logger });
	// R9 (W7, D-134): absent unless TTK_MCP_APPS is on, and then the only way an MCP tool reaches the ticket store.
	const mcpApps = createMcpApps({
		// D-150: the settings in force, which a defaulted switch without its embeds has just turned off.
		config: { publicUrl: config.publicUrl, allowedOrigins: config.allowedOrigins, mcpApps: appsSettings },
		registry,
		tickets,
		origins,
		keyRecords: () => verifier.apiKeyRecords,
		logger,
		...(embeds === undefined ? {} : { embeds }),
	});

	// The frame streams are built here so the recorder can borrow them; the
	// live-view *routes* are registered further down, after the auth middleware,
	// or they would answer before a principal exists.
	const casts = createCastRegistry({ config, registry, logger });
	const recorder = deps.recorder ?? (config.dataDir !== null && config.ffmpeg !== null
		? new Recorder({
			registry,
			subscribe: (sessionId, onFrame) => casts.subscribe(sessionId, onFrame),
			dir: `${config.dataDir}/recordings`,
			ffmpeg: config.ffmpeg,
			logger,
		})
		: null);
	// R7 (D-127): one `ttk.tool` span and count per dispatched call while the runtime exports; a no-op otherwise.
	const telemetry = deps.telemetry ?? createTelemetry(logger);

	// E-33: the HTTP address of a session file, built from the *configured*
	// public URL. A request's Host header is attacker-influenced and is never
	// reflected into a URL a model will follow.
	const fileUrl = (sessionId: string, fileId: string): string =>
		new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`, config.publicUrl)
			.href;

	// C11 (D-101): the counters exist only when `TTK_METRICS` is on, so a deployment without it pays nothing.
	const metrics = config.metrics ? new GatewayMetrics() : null;

	// R10 (design §2.7, D-119): the signer exists only while signed links are on (D-150: by default wherever a key can
	// be had), and the tool follows it.
	const linkSigner: LinkSigner | null = (() => {
		const settings = config.signedLinks;
		if (settings === null) return null;
		const key = deps.signedLinkKey ?? (settings.key === null ? null : new TextEncoder().encode(settings.key));
		if (key === null) {
			// D-150: `startGateway` always hands a key in when links are on — or has already turned a defaulted switch
			// off when it could not read or create one. An app composed without it (a test, an embedder) gets links off
			// when they were only the default, and the startup refusal when the operator asked for them.
			if (settings.defaulted) {
				logger.warn('TTK_SIGNED_LINKS is unset and stays off: no link-signing key was loaded');
				return null;
			}
			throw new ConfigError('TTK_SIGNED_LINKS', 'no link-signing key was loaded; startGateway reads or creates it');
		}
		return createLinkSigner({
			key,
			ttlS: settings.ttlS,
			publicUrl: config.publicUrl,
			...(deps.linkClock === undefined ? {} : { now: deps.linkClock }),
		});
	})();

	const coreDeps: McpDeps = {
		registry,
		version: deps.version,
		allowedDomains: config.allowedDomains,
		anonScopes: config.anonScopes,
		// NF-3 (design §2.0 item 6): the injected store when there is one; otherwise the store this line always built.
		secrets: deps.secrets ?? new SecretStore(config.secrets),
		persistence: config.dataDir !== null,
		// SR-HEAD-REDIRECT: proven through the permissions API at startup, never declared.
		egress: deps.egress ?? false,
		headRouting: deps.headRouting ?? null,
		// D-143 (§3.7): the `capabilities.tykotech.model` counts for a `model:invoke` holder, from the views the expansion
		// builds below (the file plus the grant proof). Read lazily: `expansion` is composed from these deps, and the
		// block is only ever built per request. Counts only — no id, host, key or URL.
		modelProviders: (): { providers: number; reachable: number } => ({
			providers: expansion.modelProviders.providers.length,
			reachable: expansion.modelProviders.providers.filter((provider) => provider.reachable).length,
		}),
		// B3.1 / §8: the live-view half of `capabilities.tykotech`, injected from
		// the module that owns the clamps rather than restated in the MCP layer.
		liveView: LIVE_VIEW_CAPABILITIES,
		// This mount serves both stream transports: SSE on `/api/v1/sessions/{id}/events`
		// and the live-view socket. The builder narrows the kind list per principal.
		eventTransports: ['sse', 'websocket'],
		...(recorder === null ? {} : { recorder }),
		fileUrl,
		logger,
		...(deps.library === undefined ? {} : { library: deps.library }),
		...(deps.health === undefined ? {} : { services: () => deps.health!.states() }),
		// D-108: the sandbox's backend, as its `/healthz` last said, for `capabilities.tykotech.sandbox`.
		...(deps.sandbox === undefined ? {} : { sandboxBackend: () => deps.sandbox!.backend }),
		// R12 (design §2.19): `sandbox_clone` only while the sandbox's `/healthz` says it clones.
		...(deps.sandbox === undefined ? {} : { sandboxClone: () => deps.sandbox!.clone === true }),
		...(metrics === null
			? {}
			: { onToolCall: (tool: string, result: ToolResult) => metrics.observeToolCall(tool, toolOutcome(result)) }),
		// R5 (D-125): `TTK_CONFIRM_DESTRUCTIVE`; only a client that declared form elicitation is ever asked.
		confirmations: config.confirmDestructive,
		// R2 (D-124): `TTK_HUMAN_HANDOFF` offers `browser_request_human`. The URL is the SPA's live-view route under the
		// *configured* public URL (never a Host header) and carries no ticket and no credential: the person signs in.
		...(config.humanHandoff
			? { viewUrl: (sessionId: string) => new URL(`/#/view/${encodeURIComponent(sessionId)}`, config.publicUrl).href }
			: {}),
		// R14 (D-122): `serverInfo.websiteUrl` and the icon (ERRATUM(E-117): the raster Multi-MCP mark), from the configured public URL — never the Host header.
		// Review B3: not from a wildcard bind address. With `TTK_PUBLIC_URL` unset the public URL is derived from the
		// bind, and the container binds 0.0.0.0: a client told to follow http://0.0.0.0:8787 is told nothing it can
		// reach. Omitted then, as on stdio, rather than wrong.
		...(isWildcardHost(config.publicUrl.hostname) ? {} : {
			identity: {
				websiteUrl: config.publicUrl.origin,
				iconUrl: new URL('/assets/brand/icon-192.png', config.publicUrl).href,
			},
		}),
		...(telemetry.active ? { traceTool: telemetry.traceTool } : {}),
		...(mcpApps === undefined ? {} : { mcpApps }),
		// R10 (D-119): `browser_file_link` exists only where a link can be verified. D-140 (design §2.7): the minter
		// binds the link to the owner's credential epoch — `linkBinding`, read here and nowhere else on the mint side —
		// and to the session's incarnation, caps it at an OAuth token's own expiry, and refuses (`scope-required`) when
		// either cannot be bound, an OAuth owner with no known expiry included (N3). D-148: the binding reads the call's
		// own credential, so a link minted under an account API key is bound to that key, not only to its account.
		...(linkSigner === null ? {} : {
			signedLink: createLinkMinter({
				signer: linkSigner,
				bindingOf: (owner, credential) => verifier.linkBinding(owner, credential),
			}),
		}),
	};
	// D-154: the providers in force at startup — the database's, seeded from the providers file — from the store
	// `startGateway` loaded; an app composed without one offers the file's providers and refuses every write.
	const modelProviderStore = deps.modelProviderStore ??
		ModelProvidersAdmin.unloaded({ operator: config.modelProviders, store: null, logger });
	const agentSettings = deps.agentSettings ?? new AgentSettingsStore(null);
	const expansion = createExpansionServices(
		config.expansion,
		coreDeps,
		deps.sandbox,
		async (owner, scopes, credential) => {
			// GW-1: bound to the task's own credential, never to whichever credential authenticated as this owner last.
			const delegation = await verifier.delegateMcp(owner, scopes, credential);
			return delegation === null ? { servers: [], close: (): void => {} } : {
				servers: [{
					type: 'http',
					name: 'tykotech',
					url: config.expansion.mcpUrl ?? new URL('/mcp', config.publicUrl).href,
					headers: [{ name: 'Authorization', value: `Bearer ${delegation.token}` }],
				}],
				close: delegation.close,
			};
		},
		// GW-1: a task is re-authorized at start, before every tool call and delegation, against its credential.
		(owner, scopes, credential) => verifier.authorizeTask(owner, scopes, credential),
		// B1 / A11 (D-104, D-106): tasks and surfaces persist under the data directory; the push gate probes the
		// process's own net grant (it reads no deployment input beyond `TTK_A2A_PUSH_ALLOWED_HOSTS`). D-143 (W3): the
		// providers in force — D-154: the database's — proven against the same permissions API (`modelGrantProven`).
		// The data directory also makes the runtime able to gain providers (D-153, D-154).
		{
			dataDir: config.dataDir,
			logger,
			modelProviders: modelProviderStore.effective(),
			...(deps.memory === undefined ? {} : { memory: deps.memory }),
			// D-158: read at every use, so a change on System › Agents applies to the next task.
			agents: () => agentSettings.current(),
			// MCP Apps streams for the terminal and surface embeds: the live view's origin gate and connection ceiling.
			...(mcpApps === undefined || appsSettings === null ? {} : {
				embeds: {
					socketBase: socketOrigin(config.publicUrl),
					admitOrigin: embedOriginGate({ settings: appsSettings, allowedOrigins: config.allowedOrigins, origins }),
					connections: eventStreams,
				},
			}),
			// D-154: push webhook tokens are sealed in `agents/tasks.json` with a subkey of the vault key, or never written.
			...(config.dbKey === null ? {} : { sealer: syncSealer(config.dbKey, 'a2a-push') }),
			...(deps.permissions === undefined ? {} : { permissions: deps.permissions }),
			// R1 (D-121): in a cluster, a task created here is recorded so its id routes back to this node — review R3-5:
			// every task the runtime creates, over MCP, A2A or REST. Fire-and-forget: a get that races the write, or
			// follows a failed one, is looked for across the cluster (`firstFound`).
			...(deps.cluster === undefined ? {} : {
				onToolTask: (taskId: string): void => {
					void deps.cluster!.recordTask(taskId).catch(() => logger.warn('cluster: a task could not be recorded'));
				},
			}),
		},
	);
	// GW-1 / GW-3: a rotated or removed key, or a closed session, fails that credential's tasks and closes its
	// A2UI and task streams at once, rather than leaving them to the next tool call or the next 300 s re-check.
	// D-153 / D-154: every change the store admits is installed through the expansion's swap and read back from its
	// views.
	modelProviderStore.attach({
		...(expansion.applyModelProviders === undefined ? {} : { apply: expansion.applyModelProviders }),
		views: () => expansion.modelProviders.providers,
	});
	const buildServer = createBuildServer({ ...coreDeps, extraTools: expansion.tools });
	const handler = createMcpHandler(buildServer, { legacy: 'stateless' });

	// R8: the stateful path, for 2025-era clients that need an `Mcp-Session-Id` and a standalone stream — the only
	// way such a client hears that its tools changed. Same factory, so both mounts serve identical tools and policy.
	// Its session records survive a restart, so a client is told to re-list after a deploy.
	/** Each browser session's last memory dump (Sessions › Sessions), refreshed at most every 15 s per session. */
	const browserMemory = new BrowserMemoryCache();
	const stateful = config.mcpStateful
		? new StatefulMount({
			buildServer,
			logger,
			registry,
			...(config.dataDir === null ? {} : { persistPath: `${config.dataDir}/mcp/sessions.json` }),
			currentScopes: (authInfo) => {
				const principal = principalFromAuthInfo(authInfo);
				// An OAuth token is not retained, so its scopes cannot be re-read: the client's next request decides.
				if (principal.kind === 'oauth') return undefined;
				const held = verifier.authorizeTask(expansionOwner(principal), new Set(SCOPES), principal.credential);
				return held === null ? null : [...held];
			},
		})
		: null;

	const unlisten = verifier.onCredentialsChanged(() => {
		expansion.runtime.reauthorize();
		expansion.streams.revalidateAll();
		expansion.embedStreams?.revalidateAll();
		// A credential's scopes decide which tools exist for it: a 2026 client re-lists (its next server is built
		// with the scopes it holds now), and every 2025 session re-reads its own and is rebuilt or closed.
		handler.notify.toolsChanged();
		void stateful?.refreshCredentials().catch((cause) => logger.warn(`MCP sessions not refreshed: ${String(cause)}`));
	});

	// D-082: a service coming or going changes which tools exist. Per-request servers read the live state on their
	// next build, so stateless clients are told to re-list; long-lived sessions re-evaluate their own registrations.
	const unhealth = deps.health?.onChange(() => {
		handler.notify.toolsChanged();
		stateful?.refreshTools();
	}) ?? (() => {});

	// R10/R12: in a cluster the request has to reach the node holding the
	// session before anything touches a browser, so routing is decided from the
	// parsed body at the mount rather than inside a tool handler.
	const cluster = deps.cluster;
	const router = cluster === undefined ? null : new Router({ cluster });

	// A session created here is claimed for this node, and released when it
	// closes — otherwise peers would keep routing to a browser that is gone.
	const unclaim = cluster === undefined ? () => {} : registry.watch((change) => {
		if (change.kind === 'session-added') void cluster.adopt(change.sessionId).catch(() => {});
		if (change.kind === 'session-removed') void cluster.release(change.sessionId).catch(() => {});
	});

	// R4/R5: the change notifications. A stateless-per-request server has no
	// long-lived instance to push from, so they ride the handler's own event bus,
	// which fans out to whatever `subscriptions/listen` streams are open.
	const unwatch = registry.watch((change) => {
		switch (change.kind) {
			case 'lock-changed':
				// G-2: no notification. The tool list no longer moves with the
				// takeover lock — `available` describes only what this *deployment*
				// can offer, and a held session is refused at call time with a
				// classifiable `Error: human-has-control:` result. Announcing a list
				// change that does not happen would train a client to re-list on
				// every takeover for nothing. This revises D-027; RR-7 records the
				// signal a client loses.
				break;
			case 'session-added':
			case 'session-removed':
				handler.notify.resourcesChanged();
				break;
			case 'page-changed':
				for (const uri of resourceUris(change.sessionId)) handler.notify.resourceUpdated(uri);
				break;
			case 'files-changed':
				// A finished download is a new readable resource (E-33).
				handler.notify.resourcesChanged();
				break;
		}
	});

	const gate = requireBearerAuth({
		verifier,
		requiredScopes: [],
		// D-083: the challenge points at protected-resource metadata only where that document is served.
		...(config.oauth === null ? {} : { resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl) }),
	});

	// --- requestId ---------------------------------------------------------
	app.use('*', async (c, next) => {
		const requestId = c.req.header('x-request-id') ?? ulid();
		c.set('requestId', requestId);
		await next();
		c.res.headers.set('x-request-id', requestId);
	});

	// --- auth --------------------------------------------------------------
	// B4 / D-097: the control plane signs in to an HttpOnly cookie. Public paths never read it — the live-view socket
	// (`/live/{id}/ws`) stays ticket-only, so a cookie can never open a socket a page did not mint a ticket for.
	const cookieSpec = sessionCookieSpec(config.publicUrl);
	/**
	 * R1-2, ERRATUM(E-88): the Origin rule for a cookie-authenticated change — this server's own full origin, scheme,
	 * host and port (`cookieOriginAllowed` says how those are derived) — where bearer clients keep the process-wide
	 * hostname list.
	 *
	 * One exception, in a cluster only: a peer's forward (`x-ttk-forwarded-by`) carries the browser's Origin to a node
	 * the browser did not address, whose own origin it therefore cannot be. It is held to the hostname list, as before
	 * R1-2, and to the CSRF value. That relaxes nothing a cross-origin page can use: `x-ttk-forwarded-by` is not a
	 * CORS-safelisted header, so a page can attach it only to a same-origin request or after a preflight, and this
	 * server grants no preflight (it never emits CORS headers).
	 */
	const cookieOriginIsOurs = (origin: string, host: string | undefined, forwarded: boolean): boolean =>
		cookieOriginAllowed(origin, config.publicUrl, host) ||
		(cluster !== undefined && forwarded && validateOriginHeader(origin, adapterOrigins).ok);
	app.use('*', async (c, next) => {
		// R1-5: public-ness is judged on the path the router matches (`c.req.path`), never on a re-parsed copy of the
		// URL that could resolve to a different route. The front has already refused a target with dot segments,
		// encoded slashes or empty segments, so the two can no longer disagree about which route this is.
		const path = c.req.path;
		if (isPublic(path, linkSigner !== null)) return await next();

		const anonymous = verifier.anonymousPrincipal(remoteAddrOf(c));
		if (anonymous !== null) {
			c.set('principal', anonymous);
			return await next();
		}

		// The Authorization header wins whenever it is present; only without one is the cookie read, and only a
		// `ttks_` sign-in token is ever taken from it (`parseSessionCookie`). It is resolved through the very same
		// gate and verifier chain a bearer is, so a cookie can never carry more than its session would as a bearer.
		const jar = c.req.header('authorization') === undefined
			? parseSessionCookie(c.req.header('cookie'), cookieSpec.name)
			: { kind: 'absent' as const };
		if (jar.kind === 'refused') {
			// R1-2: two sign-in cookies (one planted on a longer path by a page on another port of this host, sent
			// first), or one this server never set. Neither is resolved — first-wins would sign this browser in as the
			// planter — and both are cleared on every path they could have been set for, so the browser can recover by
			// signing in again instead of being refused on every request with nothing to clear the jar.
			logger.warn('auth.cookie_refused', { reason: jar.reason, path, source: remoteAddrOf(c) });
			const refused = problemResponse(
				'unauthenticated',
				c.get('requestId'),
				'the sign-in cookie was duplicated or malformed and has been cleared; sign in again',
			);
			for (const cleared of clearedSessionCookies(cookieSpec, path)) refused.headers.append('set-cookie', cleared);
			return refused;
		}
		const cookieToken = jar.kind === 'token' ? jar.token : null;
		const result = await gate(
			cookieToken === null
				? c.req.raw
				: new Request(c.req.url, { headers: { authorization: `Bearer ${cookieToken}` } }),
		);
		if (result instanceof Response) {
			if (cookieToken === null) return result;
			// A cookie the server no longer honours (expired, signed out elsewhere, account gone) is dropped from the
			// browser along with the refusal, so it is not presented again on every request.
			const refused = new Response(result.body, result);
			refused.headers.append('set-cookie', clearedSessionCookie(cookieSpec));
			return refused;
		}
		if (result.extra?.delegatedMcp === true && path !== '/mcp') {
			return problemResponse('forbidden-scope', c.get('requestId'));
		}
		if (cookieToken !== null) {
			// A cookie is ambient: the browser attaches it to whatever request the page — or, without SameSite, another
			// site — makes. A state-changing request therefore proves it came from this control plane's page twice
			// over: this server's own Origin (a browser always sends one on these methods) and the CSRF value only that
			// page was given. `/mcp` JSON-RPC and the live-view ticket mint are POSTs and fall under this too.
			const csrf = await csrfFor(cookieToken);
			if (isUnsafeMethod(c.req.method)) {
				const origin = c.req.header('origin');
				const originOk = origin !== undefined && origin !== '' &&
					cookieOriginIsOurs(origin, c.req.header('host'), c.req.header(FORWARDED_HEADER) !== undefined);
				if (!originOk || !csrfMatches(c.req.header(CSRF_HEADER), csrf)) {
					logger.warn('auth.csrf_failed', {
						method: c.req.method,
						path,
						reason: originOk ? 'csrf' : 'origin',
						source: remoteAddrOf(c),
					});
					return problemResponse(
						'csrf-failed',
						c.get('requestId'),
						originOk
							? `a cookie-authenticated ${c.req.method} needs the ${CSRF_HEADER} header from sign-in`
							: `a cookie-authenticated ${c.req.method} needs an allowed Origin header`,
					);
				}
			}
			c.set('csrf', csrf);
		}
		c.set('authInfo', result);
		c.set('principal', principalFromAuthInfo(result));
		await next();
	});

	// --- the per-token origin narrowing (B1.10) ----------------------------
	// **This can only reject further.** The adapter's own origin middleware has
	// already run and already applied the process-wide ceiling; this runs after
	// auth, which is the earliest point at which a principal exists at all.
	//
	// A request with **no `Origin` header reaches the handler**, deliberately:
	// SEC-06 is right that this makes the list a narrowing control over browser
	// traffic and not an authentication control. Every non-browser caller sends
	// no `Origin` and every one of them already presented a credential.
	app.use('*', async (c, next) => {
		const principal = c.get('principal');
		if (principal === undefined) return await next();
		const declared = origins.forToken(principal.id);
		if (declared.length === 0) return await next();
		const effective = effectiveOrigins(config.allowedOrigins, declared);
		if (originAllowed(c.req.header('origin'), effective)) return await next();
		// The existing slug: G-5 makes it a live emitter for the first time.
		return problemResponse('origin-forbidden', c.get('requestId'), 'this credential narrows the allowed origins');
	});

	// --- rate limit --------------------------------------------------------
	app.use('*', async (c, next) => {
		const principal = c.get('principal');
		if (principal === undefined) return await next();
		const path = c.req.path;
		// A live-view socket is one long connection, not a stream of requests.
		if (path.startsWith('/live/')) return await next();
		// R1-3: signing out is never refused for a budget the page's own polling and streams spent. A 429 here left
		// the session valid and the cookie in the browser after the page said "signed out". The handler does one
		// lookup and only ever takes authority away, so there is nothing to throttle.
		if (path === '/api/v1/auth/logout' && c.req.method === 'POST') return await next();
		const decision = limiter.charge(principal.id);
		if (!decision.allowed) {
			logger.warn(`rate limit exceeded for ${principal.id}`);
			return problemResponse('rate-limited', c.get('requestId'), 'too many requests', {
				'retry-after': String(decision.retryAfter),
				'x-ratelimit-remaining': String(decision.remaining),
			});
		}
		await next();
		// B3.2 / §8: the budget this principal has left, on every rate-limited
		// route. Set *after* the handler, because the header belongs on whatever
		// response the handler produced rather than on a response this middleware
		// would have to construct. `/live/` is excluded above and carries no header
		// — a socket is one long connection, not a stream of requests, so a
		// per-request budget would be meaningless on it — and neither does the
		// sign-out, which is not charged at all (R1-3).
		c.res.headers.set('x-ratelimit-remaining', String(decision.remaining));
	});

	// --- favicon -----------------------------------------------------------
	// Answers the browser's automatic request with "nothing here, stop asking"
	// (F6). Registered here rather than in `static.ts` so it exists even when the
	// SPA bundle does not, and deliberately empty: shipping an icon would put a
	// binary asset in the image to silence a console line.
	app.get('/favicon.ico', (c) => c.body(null, 204));

	// --- health ------------------------------------------------------------
	app.get('/healthz', (c) =>
		c.json({
			status: 'ok',
			version: deps.version,
			sessions: registry.size,
		}));

	// --- metrics (C11, D-101) ------------------------------------------------
	// Not public, unlike `/healthz`: request rates per route, session counts and process memory are reconnaissance.
	// A scraper holds `metrics:read`, which grants nothing else; `admin` reads it too. Off, there is no route at all
	// and the request falls through to the ordinary 404.
	if (metrics !== null) {
		app.get('/metrics', (c: Context) => {
			const principal = c.get('principal') as Principal | undefined;
			if (principal === undefined) return problemResponse('unauthenticated', c.get('requestId'));
			// Read as strings: the vocabulary is `scopes.ts`'s to declare, and `admin` admits either way.
			if (!mayReadMetrics(principal.scopes as ReadonlySet<string>)) {
				return problemResponse('forbidden-scope', c.get('requestId'), `the ${METRICS_SCOPE} scope is required`);
			}
			return new Response(metrics.render({ sessions: registry.list(), memory: readMemory() }), {
				headers: {
					'content-type': PROMETHEUS_CONTENT_TYPE,
					'cache-control': 'no-store',
					'x-content-type-options': 'nosniff',
				},
			});
		});
	}

	// D-075: the file share over HTTP, for what the tools cannot carry (binary and large files).
	attachShareRoutes(app, deps.library ?? null);
	// D-076: live sandbox sessions for the Workspaces screen; the stream re-earns `sandbox:execute` (GW-3).
	attachSandboxSessionRoutes(
		app,
		deps.sandbox,
		expansion.streams,
		(principal) => verifier.currentScopes(principal)?.has('sandbox:execute') === true,
	);

	// GW-3: the A2UI and task streams re-earn their decision like the session event stream does, and also re-read
	// the scope their route requires, so a key narrowed to lose `agent:invoke` stops receiving too.
	attachExpansionRoutes(
		app,
		expansion,
		config.publicUrl.href,
		(principal) => verifier.currentScopes(principal)?.has('agent:invoke') === true,
	);

	// --- OAuth metadata ----------------------------------------------------
	if (config.oauth !== null) {
		const oauth = config.oauth;
		app.get('/.well-known/*', async (c: Context) => {
			// D-083: the provider's own document, never endpoints guessed from the issuer. Only the authorization-server
			// route needs it; the protected-resource document is this server's own.
			const wantsAs = new URL(c.req.url).pathname.startsWith('/.well-known/oauth-authorization-server');
			const discovered = wantsAs ? await verifier.oauthMetadata?.get() ?? null : null;
			if (wantsAs && discovered === null) {
				logger.warn('authorization server metadata is unavailable', { reason: verifier.oauthMetadata?.lastError });
				return problemResponse('internal', c.get('requestId'), "the identity provider's metadata is unavailable", {
					'retry-after': '30',
				});
			}
			const response = oauthMetadataResponse(c.req.raw, {
				oauthMetadata: (discovered ?? { issuer: oauth.issuer.href, response_types_supported: ['code'] }) as never,
				resourceServerUrl: config.publicUrl,
				// From the one list, so a new scope cannot exist in the authorizer's
				// world and be missing from the discovery document.
				scopesSupported: [...SCOPES],
				resourceName: 'Multi-MCP',
			});
			return response ?? problemResponse('not-found', c.get('requestId'));
		});
	}

	// --- MCP ---------------------------------------------------------------
	// The mount does not exist without a credential: loopback dev mode grants
	// every scope, so an unauthenticated non-loopback deployment would hand the
	// whole browser surface to anyone who found the port. Startup already
	// refuses that combination; this is the second line.
	if (verifier.credentialed || config.oauth !== null || isLoopbackOnly(config)) {
		app.all('/mcp', async (c: Context) => {
			const principal = c.get('principal') as Principal | undefined;
			if (principal !== undefined && !principal.scopes.has('mcp:invoke')) {
				return problemResponse('forbidden-scope', c.get('requestId'), 'the mcp:invoke scope is required');
			}
			const options = {
				...(c.get('authInfo') === undefined ? {} : { authInfo: c.get('authInfo') as AuthInfo }),
				parsedBody: c.get('parsedBody'),
			};

			const serveHere = async (): Promise<Response> => {
				// A request that names a transport session, or opens one, belongs to
				// the stateful mount; everything else is stateless per request.
				if (stateful !== null && wantsStatefulSession(c.req.raw, c.get('parsedBody'))) {
					return await stateful.fetch(c.req.raw, options);
				}
				return await handler.fetch(c.req.raw, options);
			};

			if (router !== null && cluster !== undefined) {
				const forwarded = c.req.header(FORWARDED_HEADER) !== undefined;
				const route = await router.route(c.get('parsedBody'), forwarded);
				if (route.kind === 'refuse') {
					return problemResponse('unknown-session', c.get('requestId'), route.detail);
				}
				if (route.kind === 'forward') {
					logger.info(`routing to ${route.node.id}: ${route.reason}`);
					return await forward(route.node, c.req.raw, JSON.stringify(c.get('parsedBody') ?? null), cluster.self.id);
				}
				if (route.kind === 'fan-out') {
					return await fanOut(
						route.nodes,
						c.req.raw,
						JSON.stringify(c.get('parsedBody') ?? null),
						cluster.self,
						serveHere,
						route.list,
					);
				}
				// Review R3-5: a task id nobody recorded is answered here, or by the node that turns out to hold it.
				if (route.kind === 'find') {
					return await firstFound(
						route.nodes,
						c.req.raw,
						JSON.stringify(c.get('parsedBody') ?? null),
						cluster.self,
						serveHere,
					);
				}
			}
			return await serveHere();
		});
	}

	// --- admin: sessions ---------------------------------------------------
	// R8 / F4 (D-128): every admin REST session route looks sessions up through the caller's access, like the tools. The
	// routes require `admin`, which reaches every session in `owner` mode too; what the access changes is that a
	// created session — and `default` — belong to the admin who asked, rather than to nobody.
	app.get('/api/v1/sessions', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const access = sessionAccessOf(c.get('principal') as Principal);
		const sessions = registry.listFor(access);
		// Review RV-7: in `owner` mode an administrator — who reaches every owner's sessions — is told whose each one
		// is, so the Sessions screen can say it. Only on this admin list: shared mode records no owner, and the registry's
		// own summaries, the detail record, every tool result and the event ring still carry none.
		if (registry.ownership !== 'owner' || !access.admin) return c.json({ sessions });
		const owners = new Map(registry.visibleTo(access).map((record) => [record.id, record.owner]));
		return c.json({
			sessions: sessions.map((session) => {
				const owner = owners.get(session.session_id);
				return owner === null || owner === undefined ? session : { ...session, owner };
			}),
		});
	});

	// The memory an operator can act on (Sessions › Sessions): each visible session's browser (Chromium's own memory
	// dump over the session's CDP connection, cached per session), the gateway's heap against its limit, and the
	// container's configured limit. Admin, like the session list it accompanies.
	app.get('/api/v1/system/usage', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const access = sessionAccessOf(c.get('principal') as Principal);
		const now = Date.now();
		const records = registry.visibleTo(access);
		browserMemory.retain(new Set(registry.records.map((record) => record.id)));
		const sessions = await Promise.all(records.map(async (record) => ({
			session_id: record.id,
			idle_seconds: Math.max(0, Math.round((now - record.lastUsedAt) / 1000)),
			idle_timeout_s: Math.round((record.idleTimeoutMs ?? registry.sessionTtlMs) / 1000),
			memory: await browserMemory.get(record.id, record.session.cdpClient as DumpClient | null),
		})));
		const gateway = gatewayMemory();
		const browsers = sessions.reduce((sum, session) => sum + (session.memory?.private_bytes ?? 0), 0);
		return c.json(
			{
				container: {
					limit_bytes: config.limits.memoryLimitBytes,
					// The container holds the gateway and its browsers and nothing else.
					used_bytes: gateway.rss_bytes + browsers,
				},
				gateway,
				browsers_private_bytes: browsers,
				measured: sessions.length === 0 || sessions.some((session) => session.memory !== null),
				limits: { max_sessions: config.limits.maxSessions, session_ttl_s: Math.round(registry.sessionTtlMs / 1000) },
				sessions,
			},
			200,
			{ 'cache-control': 'no-store' },
		);
	});

	app.delete('/api/v1/sessions/:sessionId', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const sessionId = c.req.param('sessionId') ?? '';
		const record = registry.peekFor(sessionId, sessionAccessOf(c.get('principal') as Principal));
		const closed = record !== undefined && await registry.close(record.id, 'session-closed');
		if (!closed) return problemResponse('unknown-session', c.get('requestId'), `no session ${sessionId}`);
		return new Response(null, { status: 204, headers: { 'x-request-id': c.get('requestId') } });
	});

	app.post('/api/v1/sessions', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		let body: { session_id?: string; label?: string; profile?: string } = {};
		try {
			body = await c.req.json();
		} catch {
			// Optional body
		}
		const access = sessionAccessOf(c.get('principal') as Principal);
		const record = body.session_id === 'default'
			? await registry.resolve(undefined, access)
			: await registry.createNew(body.label, body.profile, access);
		return c.json({
			session_id: record.id,
			created_at: new Date(record.createdAt).toISOString(),
			status: 'ready',
		}, 201);
	});

	// --- auth: login / me / logout -----------------------------------------
	// D-078: the one public route that checks a secret. Its body is bounded before it is parsed, and every
	// failure feeds the guard, which answers 429 with Retry-After before any secret is checked again.
	app.post('/api/v1/auth/login', async (c: Context) => {
		const requestId = c.get('requestId') as string;
		const parsed = await cappedJson(c.req.raw, PUBLIC_BODY_BYTES);
		if (parsed === 'too-large') {
			return problemResponse('payload-too-large', requestId, `a sign-in body is at most ${PUBLIC_BODY_BYTES} bytes`);
		}
		if (parsed === null) return problemResponse('invalid-request', requestId, 'invalid JSON payload');
		const body = parsed;

		const username = typeof body.username === 'string' ? body.username.trim() : '';
		const password = typeof body.password === 'string' ? body.password : '';
		const apiKey = typeof body.apiKey === 'string'
			? body.apiKey.trim()
			: (typeof body.token === 'string' ? body.token.trim() : '');

		// B4 / D-097: `"session": "cookie"` asks for the sign-in to land in the HttpOnly cookie rather than in the body.
		// Login CSRF is the threat a cookie sign-in adds — a foreign page signing this browser in to an account of the
		// attacker's choosing — so such a sign-in must come from an allowed page origin (r2, M6). Checked before any
		// secret is, so the refusal confirms nothing about the credential.
		if (body.session !== undefined && body.session !== 'cookie') {
			return problemResponse('invalid-request', requestId, 'session must be "cookie" when it is given');
		}
		const cookieMode = body.session === 'cookie';
		if (cookieMode) {
			// R1-2: this server's own origin — scheme, host and port — not merely an allowed hostname: another port of
			// the same host is the same site to the browser, and could otherwise sign it in to an attacker's account.
			if (!cookieOriginAllowed(c.req.header('origin'), config.publicUrl, c.req.header('host'))) {
				return problemResponse('origin-forbidden', requestId, "a cookie sign-in must come from this server's origin");
			}
			// R1-2: and as `application/json`, which no cross-origin page can send without a CORS preflight this server
			// never grants. `text/plain`, a form encoding or no type at all is what a `no-cors` request can carry.
			if (!isJsonContentType(c.req.header('content-type'))) {
				return problemResponse('invalid-request', requestId, 'a cookie sign-in must be sent as application/json');
			}
		}
		// C14 / D-099: a sign-in token is not a key. Exchanging one minted a session backed by another session, which
		// the verifier cannot resolve, so the token it returned died on first use. Refused by shape, before the guard:
		// it is a misuse, not a failed guess.
		if (!(username && password) && apiKey.startsWith(LOGIN_TOKEN_PREFIX)) {
			return problemResponse('invalid-request', requestId, 'use the session token as a bearer token');
		}

		/**
		 * The success response for a minted sign-in: as a bearer in the body (unchanged), or — cookie mode — in the
		 * cookie, with the CSRF value the page must echo and no token anywhere the page could read it.
		 */
		const signedIn = async (session: { token: string; expires: number }, user: Record<string, unknown>) => {
			if (!cookieMode) return c.json({ token: session.token, expires: session.expires, user });
			c.header('set-cookie', sessionCookie(cookieSpec, session.token, (session.expires - Date.now()) / 1000));
			c.header('cache-control', 'no-store');
			return c.json({ expires: session.expires, user, csrf: await csrfFor(session.token) });
		};

		const source = remoteAddrOf(c);
		const guarded = username && password ? username : null;
		if ((username && password) || apiKey) {
			const decision = loginGuard.check(source, guarded);
			if (!decision.allowed) {
				logger.warn('auth.login_throttled', { source, retryAfterS: decision.retryAfterS });
				return problemResponse('rate-limited', requestId, 'too many failed sign-ins; try again later', {
					'retry-after': String(decision.retryAfterS),
				});
			}
		}
		/** A failure: counted, logged without the secret, and answered with the same 401 whatever went wrong. */
		const refuse = (kind: 'password' | 'api-key', detail: string): Response => {
			const wait = loginGuard.fail(source, guarded);
			logger.warn('auth.login_failed', {
				kind,
				source,
				// Only a name that is an account is logged: a password typed into the name field stays out of the log.
				...(kind === 'password' ? { user: verifier.users.has(username) ? username : '(unknown)' } : {}),
				...(wait > 0 ? { backoffS: wait } : {}),
			});
			return problemResponse('unauthenticated', requestId, detail);
		};

		if (username && password) {
			const principal = await verifier.verifyAdmin(username, password);
			if (!principal) return refuse('password', 'Invalid username or password');
			loginGuard.succeed(username);
			logger.info('auth.login', { kind: 'password', user: username, source, ...(cookieMode ? { cookie: true } : {}) });
			return await signedIn(await verifier.mintSession(principal), {
				id: principal.id,
				username,
				kind: principal.kind,
				scopes: [...principal.scopes],
				label: principal.label ?? null,
			});
		}

		if (apiKey) {
			// GW-11: a delegated ACP bearer is an /mcp-only capability. Resolving it on this public route made the
			// route an oracle that confirmed a token and named its owner and scopes.
			const principal = verifier.isDelegation(apiKey) ? null : await verifier.resolve(apiKey);
			if (!principal) return refuse('api-key', 'Invalid API key or token');
			// An OAuth access token has no server-side session to put in a cookie: the server never mints one for it
			// (the token keeps its own expiry) and a cookie carries only `ttks_` sessions. It stays a bearer.
			if (cookieMode && principal.kind !== 'api-key') {
				return problemResponse(
					'invalid-request',
					requestId,
					'an OAuth access token cannot open a cookie session; send it as a bearer token',
				);
			}
			logger.info('auth.login', {
				kind: principal.kind,
				principal: principal.id,
				source,
				...(cookieMode ? { cookie: true } : {}),
			});
			const user = {
				id: principal.id,
				// D-146: an account's own key signs in as its account, so it names the account as a password sign-in
				// does. GW-4 keeps `admin:` off every configured key id, so the prefix alone says which this is.
				username: principal.id.startsWith('admin:') ? principal.id.slice('admin:'.length) : principal.id,
				kind: principal.kind,
				scopes: [...principal.scopes],
				label: holderNameOf(principal, verifier.apiKeyRecords),
			};
			// D-073: an API key signs in to a session of its own rather than being echoed back as the bearer, so the
			// SPA never has to keep the key. The session is backed by the key's record hash and ends with it. An
			// OAuth token keeps its own expiry and is returned as it came.
			if (principal.kind === 'api-key') return await signedIn(await verifier.mintSession(principal), user);
			return c.json({ token: apiKey, user });
		}

		return problemResponse('invalid-request', requestId, 'Provide either username and password or an apiKey');
	});

	/** D-078: one log line per account change: who did it, to whom, and what changed; never a password. */
	const audit = (c: Context, event: string, user: string, fields: Record<string, unknown> = {}): void => {
		const actor = (c.get('principal') as Principal | undefined)?.id ?? 'unknown';
		logger.info(event, { actor, user, ...fields, requestId: c.get('requestId') });
	};

	/** A list entry: the public record plus its open sign-in count and whether it is the caller's own (D14). */
	const userView = (user: PublicUser, principal: Principal) => ({
		...user,
		sessions: verifier.logins.countFor(`user:${user.username}`),
		self: principal.id === `admin:${user.username}`,
	});

	/** The stored sign-in behind a session principal, or `null` for any other credential. */
	const loginOf = (principal: Principal) => {
		const credential = principal.credential ?? '';
		return credential.startsWith('session:') ? verifier.logins.get(credential.slice('session:'.length)) : null;
	};

	app.get('/api/v1/auth/me', (c: Context) => {
		const principal = c.get('principal') as Principal;
		const login = loginOf(principal);
		// R1-7: the answer carries the CSRF value and the identity; like the sign-in response, it is never cached.
		c.header('cache-control', 'no-store');
		return c.json({
			user: {
				id: principal.id,
				...(principal.id.startsWith('admin:') ? { username: principal.id.slice('admin:'.length) } : {}),
				kind: principal.kind,
				scopes: [...principal.scopes],
				label: holderNameOf(principal, verifier.apiKeyRecords),
			},
			...(login === null ? {} : { session: { expires: login.expires, backing: login.backing.split(':')[0] } }),
			// B4: a reloaded page recovers its CSRF value here, and only a cookie-authenticated request is given one.
			...(c.get('csrf') === undefined ? {} : { csrf: c.get('csrf') }),
		});
	});

	app.post('/api/v1/auth/logout', async (c: Context) => {
		// B4: a cookie sign-in ends like a bearer one, and the browser is told to drop the cookie (`Max-Age=0`).
		const cookieAuthenticated = c.get('csrf') !== undefined;
		const token = cookieAuthenticated
			? readSessionCookie(c.req.header('cookie'), cookieSpec.name) ?? ''
			: (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
		// R1-3: the browser is told to drop the cookie whatever happens next. The cookie is HttpOnly, so only this
		// response can remove it; making that depend on the session store answering left a browser signed in after
		// the page had said otherwise.
		const cleared: Record<string, string> = cookieAuthenticated
			? { 'set-cookie': clearedSessionCookie(cookieSpec) }
			: {};
		if (token.startsWith(LOGIN_TOKEN_PREFIX)) {
			try {
				await verifier.closeSession(token);
			} catch (cause) {
				// Reported, not hidden behind a 204: the session is still valid wherever its token survives until it
				// expires. Never the token, which is the credential itself.
				logger.warn('auth.logout_failed', {
					principal: (c.get('principal') as Principal | undefined)?.id ?? 'unknown',
					error: cause instanceof Error ? cause.message : String(cause),
					source: remoteAddrOf(c),
				});
				return problemResponse(
					'internal',
					c.get('requestId'),
					'the sign-in could not be ended on the server; it stays valid until it expires',
					cleared,
				);
			}
		}
		if (cookieAuthenticated) c.header('set-cookie', clearedSessionCookie(cookieSpec));
		return c.body(null, 204);
	});

	// --- auth: own password (D-074, D-148) ---------------------------------
	// Only a sign-in to an account can change a password, and only its own account's: a password sign-in, or (D-148) a
	// sign-in opened by exchanging one of the account's own API keys — never a raw bearer, which is no sign-in. The
	// current password is re-verified either way, so a borrowed open tab, or a key handed to a tool, cannot lock the
	// owner out. The account's password sign-ins end but the one making the change; a key's sign-in stands on its key,
	// not on the password, so it continues.
	/** The account whose password a sign-in backed by `backing` may change (and the key it stands on), or `null`. */
	const passwordAccountOf = (backing: string, principal: Principal): { username: string; key?: string } | null => {
		if (backing.startsWith('user:')) return { username: backing.slice('user:'.length) };
		if (!backing.startsWith('user-key:')) return null;
		// The key must still be held by an enabled account, and the sign-in must be that account's (it acts as it).
		const hit = verifier.users.findKey(backing.slice('user-key:'.length));
		return hit === null || principal.id !== `admin:${hit.username}`
			? null
			: { username: hit.username, key: hit.key.id };
	};

	app.post('/api/v1/auth/password', async (c: Context) => {
		const principal = c.get('principal') as Principal;
		const login = loginOf(principal);
		const account = login === null ? null : passwordAccountOf(login.backing, principal);
		if (login === null || account === null) {
			return problemResponse(
				'invalid-request',
				c.get('requestId'),
				'only a sign-in to an account can change its password',
			);
		}
		const username = account.username;
		const body = await jsonBody(c);
		if (body === null) return problemResponse('invalid-request', c.get('requestId'), 'invalid JSON payload');
		const current = typeof body.current === 'string' ? body.current : '';
		if ((await verifier.users.verify(username, current)) === null) {
			logger.warn('auth.password_change_refused', { user: username, source: remoteAddrOf(c) });
			return problemResponse('unauthenticated', c.get('requestId'), 'The current password is wrong');
		}
		try {
			await verifier.users.setPassword(username, body.next);
		} catch (cause) {
			return userProblem(c, cause);
		}
		// A password sign-in keeps itself; a key's sign-in is not backed by `user:` and is not touched either way.
		verifier.closeLoginsOf(`user:${username}`, login.hash);
		// D-148: a change made from a key's sign-in names the key (its public id, as `user.key_created` does).
		audit(c, 'user.password_changed', username, account.key === undefined ? {} : { key: account.key });
		return c.body(null, 204);
	});

	// --- admin: accounts (D-074) --------------------------------------------
	app.get('/api/v1/users', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const principal = c.get('principal') as Principal;
		const store = verifier.users;
		return c.json({
			users: store.list().map((user) => userView(user, principal)),
			store: { writable: store.writable, status: store.status },
			login_ttl_s: Math.floor(verifier.loginTtlMs / 1000),
			// The vocabulary travels with the list so the SPA never restates it (one declaration, scopes.ts).
			vocabulary: SCOPES.map((scope) => ({
				scope,
				grants: SCOPE_GRANTS[scope],
				default: DEFAULT_SCOPES.includes(scope),
				explicit: EXPLICIT_SCOPES.includes(scope),
			})),
		});
	});

	app.post('/api/v1/users', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const body = await jsonBody(c);
		if (body === null) return problemResponse('invalid-request', c.get('requestId'), 'invalid JSON payload');
		// D-146: `api_key` — absent or `false` for none, `true` or `{ label?, scopes? }` for the account's first key.
		const request = keyRequestOf(body.api_key === true ? {} : body.api_key === false ? undefined : body.api_key);
		if (request === 'invalid') {
			return problemResponse(
				'invalid-request',
				c.get('requestId'),
				'api_key must be true, false or an object { label?, scopes? }',
			);
		}
		// A password the operator did not choose is generated here and returned exactly once; it is never logged.
		const generated = body.password === undefined || body.password === '' ? generateRandomPassword(20) : undefined;
		const minted = request === undefined ? undefined : await generateAccountKey();
		try {
			// The account and its key are one write: a key the store refuses (a scope beyond the account's, a bad label)
			// creates no account, so the response never has to report half a success.
			const user = await verifier.users.create({
				username: body.username,
				password: generated ?? body.password,
				scopes: body.scopes,
				...(minted === undefined || request === undefined ? {} : { key: accountKeyInput(minted, request) }),
			});
			audit(c, 'user.created', user.username, { scopes: user.scopes });
			const key = minted === undefined ? undefined : user.keys.find((entry) => entry.id === minted.id);
			if (key !== undefined) audit(c, 'user.key_created', user.username, { key: key.id, scopes: key.scopes });
			// A generated password or a key is in this body and nowhere else: no cache may keep it.
			c.header('cache-control', 'no-store');
			return c.json(
				{
					user: userView(user, c.get('principal') as Principal),
					...(generated === undefined ? {} : { password: generated }),
					...(key === undefined || minted === undefined ? {} : { api_key: { key, secret: minted.secret } }),
				},
				201,
			);
		} catch (cause) {
			return userProblem(c, cause);
		}
	});

	app.patch('/api/v1/users/:username', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const principal = c.get('principal') as Principal;
		const username = c.req.param('username') ?? '';
		const body = await jsonBody(c);
		if (body === null) return problemResponse('invalid-request', c.get('requestId'), 'invalid JSON payload');
		if (principal.id === `admin:${username}`) {
			if (body.disabled === true) {
				return problemResponse('conflict', c.get('requestId'), 'you cannot disable your own account');
			}
			if (Array.isArray(body.scopes) && !body.scopes.includes('admin')) {
				return problemResponse('conflict', c.get('requestId'), 'you cannot remove your own admin scope');
			}
		}
		try {
			const user = await verifier.users.update(username, { scopes: body.scopes, disabled: body.disabled });
			// The account's MCP connections are told now that their tools changed, rather than at their next request.
			if (body.scopes !== undefined && !user.disabled) verifier.scopesChanged();
			// A disabled account's open sign-ins end now — those its keys back too (D-146) — and the tasks and streams
			// under its keys fail with them; a scope change reaches them all on their next request or re-check.
			if (user.disabled) {
				verifier.closeLoginsOf(`user:${username}`);
				verifier.revokeLapsedAccountKeys();
			}
			audit(c, 'user.updated', username, {
				...(body.scopes === undefined ? {} : { scopes: user.scopes }),
				...(body.disabled === undefined ? {} : { disabled: user.disabled === true }),
			});
			return c.json({ user: userView(user, principal) });
		} catch (cause) {
			return userProblem(c, cause);
		}
	});

	app.delete('/api/v1/users/:username', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const principal = c.get('principal') as Principal;
		const username = c.req.param('username') ?? '';
		if (principal.id === `admin:${username}`) {
			return problemResponse('conflict', c.get('requestId'), 'you cannot delete your own account');
		}
		try {
			await verifier.users.remove(username);
		} catch (cause) {
			return userProblem(c, cause);
		}
		verifier.closeLoginsOf(`user:${username}`);
		// D-146: its keys went with the record; what they backed ends now, not at its next re-check.
		verifier.revokeLapsedAccountKeys();
		audit(c, 'user.deleted', username);
		return c.body(null, 204);
	});

	app.post('/api/v1/users/:username/password', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const username = c.req.param('username') ?? '';
		const body = (await jsonBody(c)) ?? {};
		const generated = body.password === undefined || body.password === '' ? generateRandomPassword(20) : undefined;
		try {
			await verifier.users.setPassword(username, generated ?? body.password);
		} catch (cause) {
			return userProblem(c, cause);
		}
		// Whoever held the old password holds nothing now, including this administrator's own other tabs.
		verifier.closeLoginsOf(`user:${username}`);
		audit(c, 'user.password_reset', username, { generated: generated !== undefined });
		return c.json(generated === undefined ? {} : { password: generated });
	});

	// --- admin: account keys (D-146) ---------------------------------------
	// An administrator may mint and revoke keys on any account, their own included: unlike disabling or deleting
	// oneself, neither can lock the plane out (a key never widens its account, and revoking one leaves the password).
	app.post('/api/v1/users/:username/keys', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const username = c.req.param('username') ?? '';
		// An empty body asks for the defaults; a body that is not a JSON object is refused rather than read as empty,
		// because the defaults are the account's whole grant and a malformed narrowing must not widen into it.
		const body = await optionalJsonBody(c);
		const request = body === null ? 'invalid' : keyRequestOf(body);
		if (request === 'invalid' || request === undefined) {
			return problemResponse('invalid-request', c.get('requestId'), 'the body must be an object { label?, scopes? }');
		}
		const minted = await generateAccountKey();
		try {
			const key = await verifier.users.addKey(username, accountKeyInput(minted, request));
			audit(c, 'user.key_created', username, { key: key.id, scopes: key.scopes });
			c.header('cache-control', 'no-store');
			return c.json({ key, secret: minted.secret }, 201);
		} catch (cause) {
			return userProblem(c, cause);
		}
	});

	app.delete('/api/v1/users/:username/keys/:id', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const username = c.req.param('username') ?? '';
		const id = c.req.param('id') ?? '';
		let removed: { sha256: string };
		try {
			removed = await verifier.users.removeKey(username, id);
		} catch (cause) {
			return userProblem(c, cause);
		}
		// GW-1 / GW-3: the key stopped resolving with the write above; its sign-ins, delegations, tasks and streams end now.
		const closed = verifier.revokeCredential(`user-key:${removed.sha256}`);
		audit(c, 'user.key_revoked', username, { key: id, closed });
		return c.body(null, 204);
	});

	app.delete('/api/v1/users/:username/sessions', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const username = c.req.param('username') ?? '';
		if (verifier.users.get(username) === null) {
			return problemResponse('not-found', c.get('requestId'), `no user ${JSON.stringify(username)}`);
		}
		const closed = verifier.closeLoginsOf(`user:${username}`);
		audit(c, 'user.sessions_closed', username, { closed });
		return c.json({ closed });
	});

	// --- system: diagnostics -----------------------------------------------
	// Admin only (D-070). The document is the deployment's posture — bind address,
	// public URL, origin and domain allow-lists, how many keys exist, which
	// defences are off — which is reconnaissance for anyone holding a lesser
	// credential, and nothing a watch or tool key needs to do its job.
	app.get('/api/v1/system/diagnostics', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const sessions = registry.list();
		let memory = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 };
		try {
			memory = Deno.memoryUsage();
		} catch {
			// In case memoryUsage permission is restricted
		}
		return c.json({
			status: 'ok',
			version: deps.version,
			uptimeSeconds: Math.floor(performance.now() / 1000),
			memory,
			sessions: {
				total: sessions.length,
				active: sessions.filter((s) => s.tab_count > 0).length,
				viewers: sessions.reduce((sum, s) => sum + s.viewer_count, 0),
			},
			config: {
				host: config.host,
				port: config.port,
				publicUrl: config.publicUrl.href,
				allowedDomains: config.allowedDomains,
				// D-138 (design §2.0 item 6): `TTK_ALLOWED_DOMAINS_SCOPE` — `documents` or `all`.
				allowedDomainsScope: config.allowedDomainsScope,
				// D-137 (design §2.0 item 6): the collector origins `TTK_OTEL_ENDPOINTS` allowlists (origins only, no secret).
				otelEndpoints: config.otelEndpoints,
				allowedOrigins: config.allowedOrigins,
				// The records in force now — a reloaded key file included — not the startup copy in `config`.
				apiKeysCount: verifier.apiKeyRecords.length,
				// D-146: the keys accounts hold, beside the configured ones; a count only, never an id, label or prefix.
				accountKeysCount: verifier.users.list().reduce((sum, user) => sum + user.keys.length, 0),
				// RV-14 (containment-otel-links design §2.8): an account that can administer — enabled and holding
				// `admin` — not merely an account. A store of viewers, or of disabled administrators, has none.
				hasAdminUser: verifier.users.enabledAdminCount() > 0,
				userCount: verifier.users.size,
				userStore: verifier.users.status,
				loginStore: verifier.logins.status,
				loginTtlSeconds: Math.floor(verifier.loginTtlMs / 1000),
				oauthEnabled: config.oauth !== null,
				egressEnabled: deps.egress ?? false,
				persistenceEnabled: config.dataDir !== null,
				recordingEnabled: config.ffmpeg !== null,
				// D-094: Chromium's own sandbox (`TTK_CHROMIUM_NO_SANDBOX`), from the registry the launcher reads.
				// Not `sandboxEnabled`, which is the coding sandbox service.
				chromiumSandboxed: registry.chromiumSandboxed,
				sandboxEnabled: deps.sandbox !== undefined && deps.health?.states().sandbox !== false,
				// D-108: `bwrap` or `docker` from the sandbox's `/healthz`; null with no sandbox or before it answered.
				sandboxBackend: deps.sandbox?.backend ?? null,
				// R5 / R2 (D-125, D-124): `TTK_CONFIRM_DESTRUCTIVE` and `TTK_HUMAN_HANDOFF`.
				confirmations: config.confirmDestructive,
				humanHandoff: config.humanHandoff,
				// R12: whether the sandbox's `/healthz` says it clones (git hosts or remotes configured on it).
				sandboxClone: deps.sandbox?.clone === true,
				clusterMode: config.role,
				// R15 (D-123): which external provider(s) the secret references named (read at startup), or null.
				secretProvider: config.secretProviders.length === 0 ? null : config.secretProviders.join(', '),
				// D-128: `TTK_SESSION_OWNERSHIP`, from the registry that enforces it.
				sessionOwnership: registry.ownership,
				// D-127: whether the runtime is exporting OpenTelemetry (`OTEL_DENO=true` at start).
				telemetry: telemetry.active,
				// R9 (W7): `off`, `watch` or `control` — the mode in force, which D-150's default may have turned off.
				mcpApps: appsSettings?.mode ?? 'off',
				// R10 (D-119): whether `browser_file_link` and the public link route are on. The key is never shown.
				signedLinks: linkSigner !== null,
				// D-143 (§3.7): the configured providers — id, kind, how many models, reachable — and whether any is
				// reachable, from the views the expansion built (`Config.modelProviders` plus the grant proof; W3; D-153: and
				// the store's additions, live). No key, no URL, no header; `[]` and `false` with no provider in force.
				modelProviders: expansion.modelProviders.providers.map((provider) => ({
					id: provider.id,
					kind: provider.kind,
					models: provider.models.length,
					reachable: provider.reachable,
				})),
				builtinAgent: expansion.modelProviders.providers.some((provider) => provider.reachable),
			},
		});
	});

	// --- admin: the per-token origin overlay (B1.10) -------------------------
	// Both lists are returned **labelled with their matching rule**, because two
	// rules apply and an operator reading one list cannot otherwise tell why an
	// entry is not effective. `overlay_status` is returned for the same reason: a
	// degraded overlay must be distinguishable from an empty one.
	app.get('/api/v1/live/origins', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const principal = c.get('principal');
		const declared = principal === undefined ? [] : origins.forToken(principal.id);
		return c.json({
			process_wide: { rule: 'hostname', entries: [...config.allowedOrigins] },
			token: { rule: 'origin', entries: [...declared] },
			effective: effectiveOrigins(config.allowedOrigins, declared),
			overlay_status: origins.status,
			writable: origins.writable,
		});
	});

	app.put('/api/v1/live/origins', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const requestId = c.get('requestId');
		const principal = c.get('principal');
		if (principal === undefined) return problemResponse('unauthenticated', requestId);
		if (!origins.writable) {
			return problemResponse(
				'persistence-required',
				requestId,
				'this deployment has no TTK_DATA_DIR, so an origin overlay cannot be stored (D-A3)',
			);
		}
		let body: { origins?: unknown };
		try {
			body = (await c.req.json()) as { origins?: unknown };
		} catch {
			return problemResponse('invalid-request', requestId, 'the body must be JSON');
		}
		const raw = body.origins;
		if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
			return problemResponse('invalid-request', requestId, 'origins must be an array of strings');
		}
		if (raw.length > MAX_TOKEN_ORIGINS) {
			return problemResponse(
				'invalid-request',
				requestId,
				`at most ${MAX_TOKEN_ORIGINS} origins per token; the write is refused rather than truncated`,
			);
		}
		const accepted: string[] = [];
		for (const entry of raw as string[]) {
			const outcome = normalizeTokenOrigin(entry);
			if ('origin' in outcome) {
				if (!accepted.includes(outcome.origin)) accepted.push(outcome.origin);
				continue;
			}
			const rejection = outcome.rejected;
			// A bare hostname is what an operator writes by habit and what the
			// process-wide variable accepts; under this list's rule it would match
			// nothing at all, so it is refused with the two spellings that work.
			const detail = rejection.kind === 'bare-hostname'
				? `${JSON.stringify(rejection.entry)} is a hostname, not an origin; write ${
					rejection.accepted.map((spelling) => JSON.stringify(spelling)).join(' or ')
				}`
				: rejection.kind === 'too-long'
				? `an entry of ${rejection.bytes} bytes exceeds the 4096-byte limit`
				: `${JSON.stringify(rejection.entry)} is not an origin`;
			return problemResponse('invalid-request', requestId, detail);
		}
		try {
			await origins.set(principal.id, accepted);
		} catch (cause) {
			logger.warn(`origin overlay write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			return problemResponse('internal', requestId, 'the origin overlay could not be written');
		}
		return c.json({
			process_wide: { rule: 'hostname', entries: [...config.allowedOrigins] },
			token: { rule: 'origin', entries: accepted },
			effective: effectiveOrigins(config.allowedOrigins, accepted),
			overlay_status: origins.status,
			writable: true,
		});
	});

	// --- admin: model providers (D-153) -------------------------------------
	// D-154: the providers live in the database (seeded once from the providers file, which is never written); an
	// administrator edits them all, keys are sealed in the vault, and every change is installed in the running process
	// through the expansion's own swap. Node-local in a cluster: each node keeps its own database. CSRF and the cookie
	// are the front's to check.
	app.get('/api/v1/system/model-providers', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		return c.json(modelProviderStore.document());
	});

	app.put('/api/v1/system/model-providers', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const requestId = c.get('requestId');
		const body = await cappedJson(c.req.raw, MODEL_PROVIDERS_BODY_BYTES);
		if (body === 'too-large') {
			return problemResponse('payload-too-large', requestId, `the body is at most ${MODEL_PROVIDERS_BODY_BYTES} bytes`);
		}
		if (body === null) return problemResponse('invalid-request', requestId, 'the body must be a JSON object');
		try {
			const document = await modelProviderStore.replace(body);
			// D-078's audit shape for an admin write: who, what (ids and counts — never a URL, header or key), which request.
			logger.info('model_providers.updated', {
				actor: (c.get('principal') as Principal | undefined)?.id ?? 'unknown',
				count: document.providers.length,
				ids: document.providers.map((provider) => provider.id),
				default: document.default,
				requestId,
			});
			return c.json(document);
		} catch (cause) {
			if (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId, cause.detail);
			logger.warn(`model provider store write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			return problemResponse('internal', requestId, 'the model provider store could not be written');
		}
	});

	// D-158: the models a provider lists, for the editor's picker. Dials only the host of a provider already saved, with
	// the store's own checks (`ModelProvidersAdmin.models`); a typed key is used for the one call and never stored.
	app.post('/api/v1/system/model-providers/models', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const requestId = c.get('requestId');
		const body = await cappedJson(c.req.raw, 16_384);
		if (body === 'too-large') return problemResponse('payload-too-large', requestId, 'the body is at most 16384 bytes');
		if (body === null) return problemResponse('invalid-request', requestId, 'the body must be a JSON object');
		try {
			return c.json(await modelProviderStore.models(body));
		} catch (cause) {
			if (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId, cause.detail);
			logger.warn(`model list probe failed: ${cause instanceof Error ? cause.name : 'unknown'}`);
			return problemResponse('internal', requestId, 'the model list could not be read');
		}
	});

	// D-158: the agents — the built-in agent, SlopLord, the ACP bridge and the peers — with each one's default model,
	// protocol switches and memory switch. The settings are no secret; the audit line names the agents changed.
	app.get('/api/v1/system/agents', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		return c.json(agentSettings.document(expansion.runtime, modelProviderStore.effective(), deps.memory !== undefined));
	});

	app.put('/api/v1/system/agents', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const requestId = c.get('requestId');
		const body = await cappedJson(c.req.raw, AGENT_SETTINGS_BODY_BYTES);
		if (body === 'too-large') {
			return problemResponse('payload-too-large', requestId, `the body is at most ${AGENT_SETTINGS_BODY_BYTES} bytes`);
		}
		if (body === null) return problemResponse('invalid-request', requestId, 'the body must be a JSON object');
		try {
			agentSettings.replace(body, modelProviderStore.effective());
			logger.info('agents.updated', {
				actor: (c.get('principal') as Principal | undefined)?.id ?? 'unknown',
				agents: Object.keys((body as { agents?: object }).agents ?? {}),
				requestId,
			});
			return c.json(
				agentSettings.document(expansion.runtime, modelProviderStore.effective(), deps.memory !== undefined),
			);
		} catch (cause) {
			if (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId, cause.detail);
			throw cause;
		}
	});

	// D-154: the agents' vector memory — which embedder new collections use, what the embedders are, and how much is
	// stored per embedder (counts only: no owner, collection name or text). Without a database there is none: 409.
	app.get('/api/v1/system/memory', (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		if (deps.memory === undefined) {
			return problemResponse('persistence-required', c.get('requestId'), 'TTK_DATA_DIR is not set: no memory store');
		}
		return c.json(memorySystemView(deps.memory));
	});

	app.put('/api/v1/system/memory', async (c: Context) => {
		const denied = requireScope(c, 'admin');
		if (denied !== null) return denied;
		const requestId = c.get('requestId');
		if (deps.memory === undefined) {
			return problemResponse('persistence-required', requestId, 'TTK_DATA_DIR is not set: no memory store');
		}
		const body = await cappedJson(c.req.raw, 4096);
		if (body === 'too-large') return problemResponse('payload-too-large', requestId, 'the body is at most 4096 bytes');
		if (body === null) return problemResponse('invalid-request', requestId, 'the body must be a JSON object');
		try {
			const view = applyMemoryConfig(deps.memory, body);
			logger.info('memory.updated', {
				actor: (c.get('principal') as Principal | undefined)?.id ?? 'unknown',
				embedder: view.embedder,
				requestId,
			});
			return c.json(view);
		} catch (cause) {
			if (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId, cause.detail);
			throw cause;
		}
	});

	// --- overview (D-155) ---------------------------------------------------
	// Counts and byte totals of what the caller can read, one section per store, each gated by the scope that already
	// reads it (overview.ts). Node-local, like the providers and the memory.
	attachOverviewRoute(
		app,
		createOverview({
			registry,
			dataDir: config.dataDir,
			...(deps.library === undefined ? {} : { library: deps.library }),
			recorder,
			...(deps.sandbox === undefined ? {} : {
				sandbox: deps.sandbox,
				sandboxUp: () => deps.health?.states().sandbox,
			}),
			tasks: expansion.runtime,
			surfaces: expansion.surfaces,
			providers: () => expansion.modelProviders,
			...(deps.memory === undefined ? {} : { memory: deps.memory }),
		}),
		(cause) => logger.warn(`overview failed: ${cause instanceof Error ? cause.message : String(cause)}`),
	);

	// --- session files (E-33) ------------------------------------------------
	/**
	 * Serves one session file, `Range` included (design §2.0 item 14). S0 extraction, behaviour identical to the
	 * file route's serving block, so W2's signed-link route serves bytes through the same code; `extraHeaders` (W2:
	 * `referrer-policy`) is added to every response this function builds. The caller has already authorized the read
	 * and found the session.
	 */
	async function serveSessionFile(
		c: Context,
		record: SessionRecord,
		fileId: string,
		extraHeaders?: Record<string, string>,
	): Promise<Response> {
		const requestId = c.get('requestId');
		const extra = extraHeaders ?? {};
		try {
			// B2.9: `Range`, served from the lease rather than by slicing a buffer, so memory stays one
			// read chunk whatever the file's length and whatever the range's. The size is taken from the
			// resolve step's own re-`stat`, not from the ledger's remembered figure, because the range
			// must be validated against the file as it is now.
			const resolved = await record.files.resolve(fileId);
			const requested = parseByteRange(c.req.header('range'), resolved.size);
			if (requested.kind === 'unsatisfiable') {
				// RFC 9110: 416 with `Content-Range: bytes */<size>`, never a clamp. A clamp tells a caller
				// its request succeeded while handing it fewer bytes than it asked for, which is how a
				// resumed download silently produces a truncated file.
				return new Response(null, {
					status: 416,
					headers: {
						'content-range': `bytes */${resolved.size}`,
						'accept-ranges': 'bytes',
						'cache-control': 'no-store',
						'x-request-id': requestId,
						...extra,
					},
				});
			}
			const opened = requested.kind === 'range'
				? await record.files.open(fileId, requested.range)
				: await record.files.open(fileId);
			registry.touch(record.id);
			const served = opened.range;
			const headers: Record<string, string> = {
				'content-type': opened.info.mime_type,
				'content-length': String(served === undefined ? opened.size : served.end - served.start + 1),
				'content-disposition': attachmentDisposition(opened.info.name),
				// Advertised on every response, not only on a partial one: a client deciding whether to
				// resume asks the whole-file response first.
				'accept-ranges': 'bytes',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
				'x-request-id': requestId,
				...extra,
			};
			if (served !== undefined) headers['content-range'] = `bytes ${served.start}-${served.end}/${served.total}`;
			const status = served === undefined ? 200 : 206;
			if (c.req.method === 'HEAD') {
				// Review K-2: Hono answers HEAD with the GET handler and drops the body without cancelling it, so the
				// lease this stream holds stayed open until the session closed. Nobody reads a HEAD body: release it here,
				// for the bearer route and the signed-link route alike.
				await opened.stream.cancel().catch(() => {});
				return new Response(null, { status, headers });
			}
			return new Response(opened.stream, { status, headers });
		} catch (cause) {
			// Unknown, pending, failed and vanished files are all "nothing to
			// download here"; the detail says which without naming a path.
			if (isToolError(cause) && (cause.code === 'unknown-file' || cause.code === 'file-unavailable')) {
				return problemResponse('not-found', requestId, cause.message, extra);
			}
			throw cause;
		}
	}

	// The HTTP delivery of a downloaded file. Same authority as reading it over
	// MCP — `mcp:invoke` — and deliberately not the recordings' `view:watch`: a
	// principal allowed to *watch* a browser is not thereby allowed to carry off
	// every document it downloaded.
	app.get('/api/v1/sessions/:sessionId/files/:fileId', async (c: Context) => {
		const denied = requireScope(c, 'mcp:invoke');
		if (denied !== null) return denied;
		const requestId = c.get('requestId');
		const sessionId = c.req.param('sessionId') ?? '';
		const fileId = c.req.param('fileId') ?? '';

		// In a cluster the bytes are on the node holding the session. One hop,
		// to a registered node only; a forwarded request is served or fails here.
		if (cluster !== undefined && c.req.header(FORWARDED_HEADER) === undefined) {
			const owner = await cluster.ownerOf(sessionId);
			if (owner !== null && owner.id !== cluster.self.id) {
				logger.info(`routing file ${fileId} of session ${sessionId} to ${owner.id}`);
				const url = new URL(c.req.url);
				return await forward(owner, c.req.raw, '', cluster.self.id, `${url.pathname}${url.search}`);
			}
		}

		// `peek`: an HTTP read never creates a browser. `peekFor` (D-128): another owner's session is not found.
		const record = registry.peekFor(sessionId, sessionAccessOf(c.get('principal') as Principal));
		if (record === undefined) return problemResponse('unknown-session', requestId, `no session ${sessionId}`);
		return await serveSessionFile(c, record, fileId);
	});

	// --- signed links (R10, design §2.7, D-119; v2 D-140) ----------------------
	// Public (no bearer) and bodyless, so the front's body cap applies unchanged; HEAD is the same handler with the
	// body dropped (Hono dispatches HEAD as GET), and the lease the stream holds is released at once for it. Every
	// failure that is about the token or its owner is the same bare 401 — which check failed is not the caller's to
	// learn — and nothing here logs the URL or its query: the token is a credential for its life. Every failure that
	// is about the session or the file is a 404: the session closed (or was closed and created again under the same
	// id), or the file is gone.
	if (linkSigner !== null) {
		app.get(LINK_PATH, async (c: Context) => {
			const requestId = c.get('requestId');
			const linkHeaders = { 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
			const refused = (): Response => problemResponse('unauthenticated', requestId, undefined, linkHeaders);
			// (1) The token, locally: the MAC in constant time, the expiry in the future and within the 3600 s ceiling
			// plus the 30 s skew allowance (an OAuth link's expiry is already capped at its token's, F1).
			const claims = await linkSigner.verify(c.req.query(LINK_TOKEN_PARAM) ?? '');
			if (claims === null) return refused();
			// (2) The owner it was minted for still holds `mcp:invoke` (an OAuth owner: that and nothing more). D-148: a
			// link minted under an account API key (`k`) asks for that key's scopes now — gone with the key.
			const scopes = verifier.ownerScopes(claims.o, claims.k);
			if (scopes === null || !scopes.has('mcp:invoke')) return refused();
			// (2b) D-140: the owner's credential is still the one the link was minted under — the keyed epoch, compared in
			// constant time. A key rotated under the same id, a changed password, a disabled account or an unconfigured
			// realm all fail here, and (D-148) a revoked account key for a link that names one. The digest is read, used
			// and dropped; it is never logged.
			const digest = verifier.ownerCredentialDigest(claims.o, claims.k);
			if (digest === null || !(await linkSigner.epochMatches(claims, digest))) return refused();
			// (3) The owner's own budget, under a key no bearer request shares.
			const decision = limiter.charge(`link:${claims.o}`);
			if (!decision.allowed) {
				return problemResponse('rate-limited', requestId, 'too many requests', {
					...linkHeaders,
					'retry-after': String(decision.retryAfter),
				});
			}
			// (4) In a cluster the bytes are on the node holding the session — reached only after (1)–(3), so an
			// unverified token or a stale epoch never costs a hop; the owner node runs this same handler, so it repeats
			// (1)–(2b) on its own records before it serves. An unreachable node answers 503 with no cause: the cause is a peer's
			// address and an error string, and this route is public.
			if (cluster !== undefined && c.req.header(FORWARDED_HEADER) === undefined) {
				const node = await cluster.ownerOf(claims.s);
				if (node !== null && node.id !== cluster.self.id) {
					const url = new URL(c.req.url);
					const forwarded = await forward(
						node,
						c.req.raw,
						'',
						cluster.self.id,
						`${url.pathname}${url.search}`,
						() => problemResponse('service-unavailable', requestId, undefined, linkHeaders),
					);
					// Review R1-6: `forward` names the node that served the answer, which helps an operator on `/mcp` and
					// tells an anonymous holder of a link the cluster's node ids. This route is public: it names none.
					forwarded.headers.delete('x-ttk-served-by');
					return forwarded;
				}
			}
			// (5) The session, as its owner would see it (R8), never launched — and the same incarnation the link was minted
			// in (D-140): a session closed and created again under the same id is another session, and its files are not
			// this link's to serve. The incarnation is an identifier the token already shows, not a secret.
			const record = registry.peekFor(claims.s, { owner: claims.o, admin: scopes.has('admin') });
			if (record === undefined || record.incarnation !== claims.i) {
				return problemResponse('not-found', requestId, undefined, linkHeaders);
			}
			// The headers ride every answer the serving block builds, its 404 and 416 included; a HEAD's lease is
			// released there too (K-2), for this route and the bearer one alike.
			return await serveSessionFile(c, record, claims.f, linkHeaders);
		});
	}

	// --- session event stream (B1.8) ----------------------------------------
	// Registered after the auth middleware, like every route that needs a
	// principal. `mcp:invoke`, deliberately not `view:watch`.
	attachEventStream({
		app,
		registry,
		streams: eventStreams,
		logger,
		config,
		// A stream re-earns its authorization on the gateway's own horizon rather
		// than standing for its whole lifetime on the check made when it opened.
		revalidate: (principal) => verifier.stillAuthorized(principal),
		...(cluster === undefined ? {} : { cluster }),
	});

	// --- MCP Apps streams: the terminal and surface embeds' sockets, ticket-gated like the live view -------------
	expansion.embedStreams?.attach(app);

	// --- live view ---------------------------------------------------------
	attachLiveView({
		app,
		config,
		registry,
		tickets,
		logger,
		casts,
		connections: eventStreams,
		origins,
		version: deps.version,
		// The live record set, not the startup copy: a reloaded key file changes
		// which labels are current, and `holder_name` reaches every viewer (SR2-M3).
		keyRecords: () => verifier.apiKeyRecords,
	});

	// --- recordings (R7) ----------------------------------------------------
	if (recorder !== null) {
		app.get('/api/v1/recordings/:name', async (c: Context) => {
			// Watching a recording is watching the browser, after the fact.
			const denied = requireScope(c, 'view:watch');
			if (denied !== null) return denied;
			// R8 (D-128): in `owner` mode another owner's recording is not found — the answer an absent one gets.
			if (!recorder.mayRead(c.req.param('name') ?? '', sessionAccessOf(c.get('principal') as Principal))) {
				return problemResponse('not-found', c.get('requestId'), 'no such recording');
			}
			const path = recorder.pathFor(c.req.param('name') ?? '');
			if (path === null) return problemResponse('not-found', c.get('requestId'));
			let file: Deno.FsFile;
			try {
				file = await Deno.open(path, { read: true });
			} catch {
				return problemResponse('not-found', c.get('requestId'), 'no such recording');
			}
			return new Response(file.readable, {
				headers: {
					'content-type': 'video/webm',
					'content-disposition': `attachment; filename="${
						encodeURIComponent(c.req.param('name') ?? 'recording')
					}.webm"`,
					'x-request-id': c.get('requestId'),
				},
			});
		});
	}

	// --- static SPA (registered last so it never shadows an API route) ------
	attachStatic({ app, logger });

	// --- fallback ----------------------------------------------------------
	app.notFound((c) => problemResponse('not-found', c.get('requestId') ?? ulid()));
	app.onError((error, c) => {
		const requestId = c.get('requestId') ?? ulid();
		logger.error(`unhandled error on ${c.req.method} ${new URL(c.req.url).pathname}: ${error.message}`);
		return problemResponse('internal', requestId);
	});

	// F3: the Host and Origin allowlists answer in this server's own error shape. The adapter's checks run first
	// inside `app` and answered `403 Invalid Host` as a JSON-RPC body with no request id; this front applies the very
	// same SDK predicates (port-agnostic hostnames, a missing Origin passes) and answers `400 host-forbidden` and
	// `403 origin-forbidden` as problem+json. The adapter's checks stay behind it as a second line.
	const front = new Hono<{ Variables: AppVariables }>();
	let draining = false;
	const answer = async (c: Context<{ Variables: AppVariables }>, path: string): Promise<Response> => {
		const requestId = c.req.header('x-request-id') ?? ulid();
		if (draining) {
			// F5: new work is refused while the server drains; `/healthz` and existing work keep answering.
			const opensWork = (c.req.method === 'POST' && (path === '/api/v1/sessions' || path === '/api/v1/live/ticket')) ||
				path.startsWith('/live/');
			if (opensWork) {
				return problemResponse('service-unavailable', requestId, 'the server is shutting down', {
					'retry-after': '5',
				});
			}
		}
		const host = validateHostHeader(c.req.header('host') ?? null, [...config.allowedHosts]);
		if (!host.ok) return problemResponse('host-forbidden', requestId, host.message);
		const origin = validateOriginHeader(c.req.header('origin') ?? null, adapterOrigins);
		if (!origin.ok) return problemResponse('origin-forbidden', requestId, origin.message);
		// R1-5, ERRATUM(E-89): a target the credential check and the router could read as two different paths never
		// reaches either (request_path.ts). Before the body, so a refused request costs no read.
		const refusal = pathRefusal(rawPathOf(c.req.url));
		if (refusal !== null) return problemResponse('invalid-request', requestId, refusal);
		// A5 (D-100): the body is bounded here, after the cheap header checks and before anything inside `app` —
		// whose first middleware is the adapter's unbounded JSON parse — can read it (body_cap.ts).
		const capped = await capRequestBody(c.req.raw, config.limits.maxBodyBytes);
		if (capped.kind === 'too-large') {
			return problemResponse('payload-too-large', requestId, `the request body is over ${capped.cap} bytes`);
		}
		return await app.fetch(capped.request, c.env);
	};
	// C11: the route label is the pattern the inner app's router matches — never the path, so a client cannot mint a
	// series — and is taken here so a request the front itself refuses is counted like any other answer.
	const routeOf = (method: string, path: string): string => {
		const [matched] = app.router.match(method === 'HEAD' ? 'GET' : method, path);
		for (const [[, route]] of matched) {
			if (route.path !== '*' && route.path !== '/*') return route.path;
		}
		return UNMATCHED_ROUTE;
	};
	front.all('*', async (c) => {
		const path = new URL(c.req.url).pathname;
		const response = await answer(c, path);
		metrics?.observeRequest(c.req.method, routeOf(c.req.method, path), response.status);
		return response;
	});

	return {
		app: front,
		drain: () => {
			draining = true;
			registry.drain();
		},
		tickets,
		close: async () => {
			unwatch();
			unhealth();
			clearInterval(sweeper);
			// An open SSE response IS an in-flight request and never finishes on
			// its own, so the listener's own shutdown would block until the last
			// subscriber left — for a worker holding a long poll, never. Each gets
			// a terminal `bye` first, in the same stage that closes live-view
			// sockets.
			eventStreams.closeAll('server-shutdown');
			unlisten();
			await expansion.close();
			verifier.closeDelegations();
			// Recordings are finalised before the listener goes: a half-written
			// container is not a video, and shutdown is exactly when someone
			// wanted the recording most.
			unclaim();
			await recorder?.stopAll();
			await stateful?.close();
			await handler.close();
		},
	};
}

/** A JSON object body, or `null` when the body is missing, malformed or not an object. */
/** D-078: what a public route reads at most before it parses anything (one declaration, body_cap.ts). */
export const PUBLIC_BODY_BYTES = LOGIN_BODY_BYTES;

/**
 * A JSON object read from a body of at most `max` bytes, counted as the stream arrives, so a declared length cannot
 * lie its way past the cap; `'too-large'` past it, `null` for anything that is not a JSON object.
 */
export async function cappedJson(request: Request, max: number): Promise<Record<string, unknown> | 'too-large' | null> {
	const bytes = await readCappedBody(request, max);
	if (bytes === 'too-large' || bytes === null) return bytes;
	try {
		const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await c.req.json();
		return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/**
 * D-146: a request body's key fields that were not a JSON object are refused as a whole (`'invalid'`); `undefined`
 * means no key was asked for. The fields themselves are the store's to judge.
 */
function keyRequestOf(value: unknown): { label?: unknown; scopes?: unknown } | 'invalid' | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
	const fields = value as Record<string, unknown>;
	return {
		...(fields.label === undefined ? {} : { label: fields.label }),
		...(fields.scopes === undefined ? {} : { scopes: fields.scopes }),
	};
}

/** D-146: what the store keeps of a freshly minted key — never `secret`, which only the response carries. */
function accountKeyInput(
	minted: { id: string; prefix: string; sha256: string },
	request: { label?: unknown; scopes?: unknown },
): NewAccountKey {
	return { id: minted.id, prefix: minted.prefix, sha256: minted.sha256, ...request };
}

/**
 * A JSON object body that may be absent: an empty body is `{}`, anything else must parse as an object or the answer is
 * `null`. Unlike `jsonBody`, which cannot tell an empty body from a malformed one.
 */
async function optionalJsonBody(c: Context): Promise<Record<string, unknown> | null> {
	let text: string;
	try {
		text = await c.req.text();
	} catch {
		return null;
	}
	if (text.trim() === '') return {};
	try {
		const body: unknown = JSON.parse(text);
		return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/**
 * Maps a `UserStoreError` to its problem (D-074); anything else is a genuine failure and propagates. D-146's
 * `invalid-label`, `invalid-key` and `too-many-keys` are `invalid-request`; a key id or hash already held is a
 * `duplicate`, so `conflict`.
 */
function userProblem(c: Context, cause: unknown): Response {
	if (!(cause instanceof UserStoreError)) throw cause;
	const slug = cause.code === 'not-found'
		? 'not-found'
		: cause.code === 'persistence-required'
		? 'persistence-required'
		: cause.code === 'duplicate' || cause.code === 'last-admin'
		? 'conflict'
		: 'invalid-request';
	return problemResponse(slug, c.get('requestId'), cause.message);
}

function requireScope(c: Context, scope: Scope): Response | null {
	const principal = c.get('principal') as Principal | undefined;
	if (principal === undefined) return problemResponse('unauthenticated', c.get('requestId'));
	if (!principal.scopes.has(scope)) {
		return problemResponse('forbidden-scope', c.get('requestId'), `the ${scope} scope is required`);
	}
	return null;
}

function remoteAddrOf(c: Context): string {
	const info = (c.env as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr;
	return info?.hostname ?? '127.0.0.1';
}

function isLoopbackOnly(config: Config): boolean {
	return ['127.0.0.1', '::1', 'localhost'].includes(config.host.toLowerCase());
}
