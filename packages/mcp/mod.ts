/**
 * `@tykotech/mcp` — the MCP layer.
 *
 * Owns the tool catalog, the browser session registry, and the server factory.
 * It never stands up a listener: transports are the gateway's and the CLI's
 * concern, so the same factory serves Streamable HTTP and stdio unchanged.
 */
export {
	availabilityOf,
	capabilitiesFor,
	createBuildServer,
	createStateCodec,
	createToolExecutor,
	type McpDeps,
	refreshToolAvailability,
	registerCatalog,
	REQUEST_STATE_TTL_SECONDS,
	// W5 (D-128): the caller's access a built server carries, for a connection's notification watcher.
	serverSessionAccess,
} from './src/server.ts';
// mcp-recommendations S0: the client facts the dispatcher derives, and the per-call trace hook's type.
export { clientFactsOf, type ToolTracer } from './src/dispatch.ts';
// W4 (D-124 – D-126): the confirmation gate and its messages, the agent's sampling tools and the requestState codec.
export { CONFIRM_KEY, CONFIRM_MESSAGES, CONFIRM_TOOL_NAMES, confirmGate, type ConfirmMessage } from './src/confirm.ts';
// R14 (D-122): the public identity and the per-caller instructions.
export {
	MAX_INSTRUCTIONS_BYTES,
	SERVER_DESCRIPTION,
	SERVER_NAME,
	SERVER_TITLE,
	type ServerIdentity,
	serverImplementation,
	serverInstructions,
} from './src/identity.ts';
// W5 (D-127): the outcome vocabulary of a traced call.
export { type ToolCallOutcome, toolCallOutcome, UNKNOWN_TOOL } from './src/dispatch.ts';
// W5 (D-129): resource-template completions.
export {
	completeByPrefix,
	type Completer,
	type LibraryCompleters,
	libraryCompleters,
	MAX_COMPLETIONS,
	type SessionCompleters,
	sessionCompleters,
} from './src/completions.ts';
// R9 (W7, D-134): the MCP Apps embeds and the tool metadata that links to them.
export {
	A2UI_SURFACE_UI_URI,
	LIVE_VIEW_UI_URI,
	registerUiResources,
	resourceUiMeta,
	TOOL_UI,
	type ToolUi,
	toolUiMeta,
	UI_RESOURCE_MIME,
	type UiVisibility,
} from './src/ui_resources.ts';
export { APPS_OUTPUT } from './src/catalog/apps.ts';
export {
	buildCapabilities,
	type CapabilityInputs,
	type EventCapabilities,
	type FieldCapabilities,
	type LiveViewCapabilities,
	TOOL_WITHHELD_REASONS,
	toolsWithheld,
	type ToolWithheld,
	type ToolWithheldReason,
	type TykotechCapabilities,
} from './src/capabilities.ts';
export {
	// R10 (D-119): server-made session files beside the downloads, and their caps.
	ARTIFACT_ID_PREFIX,
	type ArtifactInput,
	attachmentDisposition,
	type ByteRange,
	type DownloadLedger,
	downloadsRootOf,
	FILE_LEASE_GRACE_MS,
	FILE_STATUSES,
	type FileInfo,
	fileInfoOf,
	type FilePolicy,
	filePolicyOf,
	type FileStatus,
	fileStatusOf,
	INLINE_FILE_LIMIT_BYTES,
	MAX_SESSION_ARTIFACT_BYTES,
	MAX_SESSION_ARTIFACTS,
	mimeTypeFor,
	type OpenedFile,
	parseByteRange,
	// B2.9: the gateway's file route serves `Range` from the same lease the tool does, so the header
	// parser is published rather than re-implemented behind the route.
	type ParsedRange,
	type ResolvedFile,
	SessionFiles,
	type SessionFilesOptions,
} from './src/files.ts';
export {
	CAPABILITIES_URI,
	fileResourceUri,
	parseFileResourceUri,
	registerResources,
	RESOURCE_KINDS,
	RESOURCE_SCHEME,
	type ResourceKind,
	resourceUri,
	resourceUris,
} from './src/resources.ts';
export { annotationsFor, CATALOG, CATALOG_BY_NAME, type ToolAvailability, type ToolDefinition } from './src/catalog.ts';
export { type ExtensionAction, type ExtensionActions, extensionTools } from './src/extension_tools.ts';
export {
	type Entry as LibraryEntry,
	LIBRARY_LIMITS,
	LibraryError,
	LibraryStore,
	type Prompt as LibraryPrompt,
	safeRelative,
	type Skill as LibrarySkill,
} from './src/library.ts';
export { libraryTools, registerLibrary } from './src/library_tools.ts';
export { MAX_RESOURCE_SUBSCRIPTIONS, type ResourceWatch, watchResourceChanges } from './src/resource_notifications.ts';
export {
	ADMIN_SCOPES,
	areScopes,
	DEFAULT_SCOPES,
	EXPLICIT_SCOPES,
	LEGACY_DEFAULT_SCOPES,
	type Scope,
	SCOPE_GRANTS,
	SCOPES,
	unknownScopes,
} from './src/scopes.ts';
export { OUTPUT } from './src/schemas.ts';
export { AGENT_TOOLS, browserExtractContent, browserRunTask, MAX_TASK_STEPS, parseAction } from './src/agent.ts';
export { HIT_TEST_MAX_DESCENT, type HitProbe, type HitResolution, type HitTest, hitTest } from './src/hit_test.ts';
export { type ElementAtPoint, elementAtPoint } from './src/tools/perception.ts';
export {
	clampTtl,
	hideHighlight,
	highlight,
	HIGHLIGHT_TTL_DEFAULT_MS,
	HIGHLIGHT_TTL_MAX_MS,
	HIGHLIGHT_TTL_MIN_MS,
	type HighlightOutcome,
	type HighlightTarget,
} from './src/highlight.ts';
export {
	freshTabs,
	type Observation,
	observationPayload,
	observationStructured,
	observe,
	type ObservedElement,
	promptBlock,
	tabsOf,
} from './src/observe.ts';
export {
	ATTRS_WHITELIST,
	FIELD_NAMES,
	FIELD_OPTIONS,
	FIELD_PRESETS,
	type FieldName,
	type FieldOption,
	type FrameSummary,
	IMPLIED_ELEMENT_LIMIT,
	type InputState,
	MASKED_INPUT_VALUE,
	type Rect,
	resolveFields,
} from './src/element_record.ts';
export {
	bestLocator,
	buildDocumentIndex,
	LOCATOR_KINDS,
	type LocatorCandidate,
	locatorCandidates,
	type LocatorKind,
	parseLocator,
} from './src/locators.ts';
export { FIND_DEFAULT_LIMIT, type FindMatch, type FindQuery, rankElements } from './src/find.ts';
export {
	type AgentRun,
	blockedSince,
	// D-138: the request scope's proxy caveat, for the doctor to print the registry's own sentence.
	browserArgsUseProxy,
	// W5 (D-127): the blank environment overrides every spawned child receives.
	CHILD_ENV_BLANKED,
	childEnvOverrides,
	CONSOLE_CLAIM_IDLE_MS,
	DEFAULT_SESSION_ID,
	type DocumentBlock,
	type LaunchedSession,
	type LiveViewerHandle,
	PROXY_WEBSOCKET_CAVEAT,
	safeProfileName,
	type SessionAccess,
	type SessionOwnership,
	type SessionRecord,
	SessionRegistry,
	type SessionRegistryOptions,
	type SessionSummary,
	type TakeoverLock,
} from './src/registry.ts';
// R4 (D-116): the request log on `SessionRecord.network`, so a consumer naming a record can name its log.
export { type NetworkEntry, NetworkLog } from './src/network_log.ts';
export { assertNavigable, isToolError, TOOL_ERROR_CODES, ToolError, type ToolErrorCode } from './src/errors.ts';
// The audit ledger (B2.7, B2.8). Published because `SessionRecord.audit` is on the exported record
// type, so a consumer that names a record needs the ledger's type — and because the contract it
// enforces (no value, no expression body, never persisted) is one a reader should be able to find
// from the package surface rather than from a private module.
export {
	AUDIT_KINDS,
	AUDIT_READ_LIMIT_DEFAULT,
	AUDIT_READ_LIMIT_MAX,
	AUDIT_RING_CAPACITY,
	AUDIT_SCOPES,
	type AuditAppend,
	type AuditEntry,
	type AuditKind,
	AuditLedger,
	type AuditLedgerOptions,
	type AuditRead,
	type AuditReadOptions,
	type AuditScope,
	expressionDigest,
} from './src/audit.ts';
export {
	browserProxyFlag,
	CHROMIUM_PROXY_FLAGS,
	dispositionFilename,
	failureReason,
	gateHop,
	HEAD_FAILURE_REASONS,
	HEAD_HOP_TIMEOUT_MS,
	HEAD_MAX_HOPS,
	HEAD_MAX_IN_FLIGHT,
	HEAD_TOTAL_TIMEOUT_MS,
	type HeadFailureReason,
	type HeadOptions,
	type HeadResult,
	headRoutingRefusal,
	headWalk,
	// D-143 (gate F21–F23): the address classifiers, published so the gateway's providers-file parser folds IPv4-mapped
	// IPv6 and non-canonical IPv4 spellings exactly as the head walk does, instead of keeping a second table.
	isForbiddenIpv4,
	isForbiddenIpv6,
	isForbiddenLiteralHost,
	parseIpv4,
	parseIpv6,
	privateLiteralEntries,
	probeEgressGrant,
} from './src/head.ts';
// The event ring (B1.7). The gateway's two transports and `browser_wait_for` are
// three views of one ring, so the cursor vocabulary is published rather than
// restated: a second parser would be a second contract.
export {
	CONTENT_RATE_PER_SECOND,
	type DownloadFailureReason,
	downloadFailureReason,
	downloadPayload,
	EVICTION_LEDGER_CAPACITY,
	focusPayload,
	formatCursor,
	MAX_EVENT_BYTES,
	MAX_RING_BYTES,
	navigationTarget,
	NETWORK_IDLE_QUIET_MS,
	NetworkIdleCounter,
	parseCursor,
	type ParsedCursor,
	RATE_WINDOW_MS,
	RING_CAPACITY,
	SessionEventRing,
	type SessionEventRingOptions,
	STRUCTURAL_RATE_PER_SECOND,
} from './src/events.ts';
export {
	classifySensitiveText,
	CREDENTIAL_MIN_LENGTH,
	type MaskedText,
	SENSITIVE_MIN_LENGTH,
	type SensitiveKind,
} from './src/masking.ts';
export { parseSecrets, type SecretEntry, SecretStore, type Substitution } from './src/secrets.ts';
export type {
	ClientFacts,
	ContentBlock,
	EmbedTicket,
	EmbedTicketInput,
	McpAppsDeps,
	RecordingController,
	RecordingInfo,
	SignedLinkMinter,
	ToolContext,
	ToolResult,
} from './src/types.ts';
