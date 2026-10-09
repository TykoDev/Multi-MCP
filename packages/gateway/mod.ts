/**
 * `@tykotech/gateway` — the HTTP process.
 *
 * Hosts the MCP mount, the live browser view, authentication, and the static
 * SPA on one `Deno.serve` listener.
 */
export { type RunningGateway, startGateway, type StartGatewayOptions } from './src/server.ts';
export { createExpansionServices, type ExpansionServices, modelGrantProven, providerNetHost } from './src/expansion.ts';
export { type AppVariables, createGatewayApp, type GatewayApp, type GatewayDeps } from './src/app.ts';
// W5 (D-128): a principal's session access, as every gateway route derives it.
export { sessionAccessOf } from './src/app.ts';
// W5 (D-127): tool-call OpenTelemetry over the runtime's own exporter.
export {
	createTelemetry,
	type Telemetry,
	TELEMETRY_SCOPE,
	TELEMETRY_WARNING,
	type TelemetryApi,
	type TelemetrySpan,
	TOOL_COUNTER,
	TOOL_SPAN,
} from './src/telemetry.ts';
export {
	type ApiKeyRecord,
	ApiKeyRecordSchema,
	checkBindPolicy,
	type ClusterSettings,
	type Config,
	ConfigError,
	DEFAULT_SCOPES,
	type Env,
	ENV_NAMES,
	EXPLICIT_SCOPES,
	isLoopbackHost,
	loadConfig,
	type McpAppsConfig,
	type OAuthConfig,
	parseApiKeys,
	processEnv,
	type Scope,
	SCOPES,
	type SignedLinksSettings,
} from './src/config.ts';
export {
	API_KEY_PREFIX,
	ApiKeyStore,
	generateApiKey,
	keyPrefix,
	OAuthVerifier,
	type Principal,
	principalFromAuthInfo,
	toAuthInfo,
	VerifierChain,
} from './src/auth.ts';
export {
	type AdminUserRecord,
	AdminUserRecordSchema,
	generateAdminUser,
	generateRandomPassword,
	hashPassword,
	parseAdminUser,
	verifyPassword,
} from './src/admin_auth.ts';
export { createLogger, type Logger, type LogLevel } from './src/logger.ts';
// G15 / D-098: the offline grant `doctor --grant` performs, on the file store or the cluster's KV.
export {
	configuredAccounts,
	grantScopesInCluster,
	grantScopesInFile,
	type PublicKey,
	type PublicUser,
	upgradeUsers,
	USERS_SCHEMA_KEY,
	USERS_SCHEMA_VERSION,
	UserStore,
	UserStoreError,
} from './src/users.ts';
export {
	canHostSessions,
	Cluster,
	type ClusterOptions,
	FORWARDED_HEADER,
	NODE_ROLES,
	type NodeInfo,
	type NodeRole,
	withLockRetry,
} from './src/cluster.ts';
export { fanOut, type FanOutList, forward, type Route, Router } from './src/routing.ts';
export {
	type CastRegistry,
	createCastRegistry,
	// mcp-recommendations S0: the live-ticket mint, shared by the REST route and W7's MCP Apps embed.
	type LiveTicketHolder,
	mintLiveTicket,
	type MintLiveTicketDeps,
	type MintLiveTicketInput,
	type MintLiveTicketResult,
} from './src/liveview.ts';
export {
	type EncoderProcess,
	type EncoderSpawn,
	MAX_RECORDING_MS,
	Recorder,
	type RecorderDeps,
	safeRecordingName,
} from './src/recorder.ts';
// R9 (W7, D-134): the MCP Apps embeds and the embed-ticket mint.
export {
	CONNECT_SRC_PLACEHOLDER,
	createMcpApps,
	EMBED_A2UI_FILE,
	EMBED_LIVE_FILE,
	EMBED_TICKET_TTL_MS,
	type EmbedDocuments,
	loadEmbedDocuments,
	type McpAppsOptions,
	socketOrigin,
} from './src/mcp_apps.ts';
export { SESSION_HEADER, StatefulMount, type StatefulMountOptions, wantsStatefulSession } from './src/stateful.ts';
export { HttpProblem, PROBLEM_SLUGS, PROBLEM_TYPE_BASE, problemResponse, type ProblemSlug } from './src/problem.ts';
export { RateLimiter, type RateLimiterOptions } from './src/ratelimit.ts';
export { TICKET_PREFIX, TICKET_TTL_MS, type TicketRecord, TicketStore, type ViewMode } from './src/tickets.ts';
export {
	LINK_KEY_FILE_NAME,
	LINK_KEY_MIN_CHARS,
	LINK_KEY_SECRET_NAME,
	loadLinkSigningKey,
	normalizeSecret,
	resolveSecrets,
	SECRET_FILE_VARS,
	SecretError,
	secretReader,
} from './src/secrets.ts';
export {
	configuredSecretRefs,
	describeSecretRefs,
	OnePasswordConnectProvider,
	parseSecretRef,
	SECRET_REF_VARS,
	type SecretProvider,
	type SecretRef,
	VaultKv2Provider,
} from './src/secret_providers.ts';
// R10 (D-119): signed links to session files.
export {
	clampLinkTtl,
	createLinkSigner,
	LINK_PATH,
	LINK_TOKEN_PARAM,
	LINK_TTL_DEFAULT_S,
	LINK_TTL_MAX_S,
	LINK_TTL_MIN_S,
	type LinkClaims,
	type LinkRequest,
	type LinkSigner,
	type LinkSignerOptions,
	type MintedLink,
} from './src/signed_links.ts';
// D-143 (model-providers-ui): the providers file — its parser, the resolved shape and the public view.
export {
	loadModelProviders,
	type LoadModelProvidersOptions,
	MODEL_KEY_REDACTION_MIN_CHARS,
	MODEL_PROVIDER_BOUNDS,
	MODEL_PROVIDERS_ENV,
	type ModelProvidersConfig,
	type ModelProviderSettings,
	parseModelProviders,
	type ProviderView,
} from './src/model_providers.ts';
// D-154: the database, its vault, seeding, and the model providers it holds.
export {
	MAX_PROVIDERS,
	ModelProvidersAdmin,
	type ModelProvidersAdminOptions,
	type ModelProvidersDocument,
	providerKeyName,
} from './src/model_providers_admin.ts';
export { Database, DATABASE_FILE, DatabaseError } from './src/database.ts';
export { DB_KEY_BYTES, DB_KEY_ENV, decodeDbKey, generateDbKey, Vault, VaultError } from './src/vault.ts';
export {
	BROWSER_SECRETS_NAME,
	describeSeed,
	SEED_TARGETS,
	seedDatabase,
	SeedError,
	type SeedResult,
	type SeedTarget,
} from './src/seed.ts';
export { databaseDoctorLine, type DataStore, openDataStore, type OpenedDataStore } from './src/data_store.ts';
export { BUILTIN_EMBEDDER_ID, MEMORY_LIMITS, MemoryError, MemoryStore } from './src/memory.ts';
export { memoryActions } from './src/memory_tools.ts';
// SR2-M3: the key-file reload that makes revocation reachable without a restart.
export { ApiKeyFileWatcher, type ApiKeyFileWatcherOptions, KEY_RELOAD_DEBOUNCE_MS } from './src/keyreload.ts';
// The wire contract lives in @tykotech/wire so the browser bundle can import it
// without pulling in this package's server dependency graph; re-exported here
// for server-side callers.
export {
	type ClientMsg,
	ClientMsgSchema,
	decodeFrame,
	encodeFrame,
	type FrameMeta,
	FrameMetaSchema,
	type LockInfo,
	type ServerMsg,
	ServerMsgSchema,
	type TabInfo,
	WS_ERROR_CODES,
	type WsErrorCode,
} from '@tykotech/wire';

// B2.3: the live view's scale arithmetic, shared with the browser-tier suite (AC-P0-38).
export { CAST_MAX_HEIGHT, CAST_MAX_WIDTH, type CastQuality, clampQuality, frameScaleFor } from './src/liveview.ts';
// D-082: the private services' live health. (`readyExpansion`, the one-shot start-up probe it replaced, is removed.)
export { bridgeProbe, SERVICE_PROBE_INTERVAL_MS, ServiceHealth } from './src/service_health.ts';
export { clampTicketTtl, TICKET_TTL_MAX_CONTROL_MS, TICKET_TTL_MAX_VIEW_MS } from './src/tickets.ts';
