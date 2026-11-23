/**
 * `@tykotech/mcp` — the MCP layer: the tool catalog, the browser session registry and the server factory.
 * Transports are the gateway's and the CLI's concern, so one factory serves Streamable HTTP and stdio.
 */
export {
	availabilityOf,
	createBuildServer,
	createToolExecutor,
	type McpDeps,
	refreshToolAvailability,
	registerCatalog,
	serverSessionAccess,
} from './src/server.ts';
export { CONFIRM_TOOL_NAMES } from './src/dispatch.ts';
export type { LiveViewCapabilities } from './src/capabilities.ts';
export { attachmentDisposition, parseByteRange } from './src/files.ts';
export {
	CAPABILITIES_URI,
	resourceUri,
	resourceUris,
	type ResourceWatch,
	watchResourceChanges,
} from './src/resources.ts';
export { CATALOG, type ToolAvailability, type ToolDefinition } from './src/catalog.ts';
export { type ExtensionActions, extensionTools } from './src/extension_tools.ts';
export { LIBRARY_LIMITS, LibraryError, LibraryStore } from './src/library.ts';
export { libraryTools } from './src/library_tools.ts';
export {
	ADMIN_SCOPES,
	DEFAULT_SCOPES,
	EXPLICIT_SCOPES,
	type Scope,
	SCOPE_GRANTS,
	SCOPELESS_ACCOUNT_SCOPES,
	SCOPES,
	STACK_SCOPES,
	unknownScopes,
} from './src/scopes.ts';
export { highlight, hitTest } from './src/hittest.ts';
export { elementAtPoint } from './src/tools/perception.ts';
export { FIELD_PRESETS } from './src/element_record.ts';
export {
	blockedSince,
	CHILD_ENV_BLANKED,
	childEnvOverrides,
	DEFAULT_SESSION_ID,
	type LiveViewerHandle,
	type SessionAccess,
	type SessionOwnership,
	type SessionRecord,
	SessionRegistry,
	type SessionRegistryOptions,
	type SessionSummary,
} from './src/registry.ts';
export { assertNavigable, isToolError, TOOL_ERROR_CODES, ToolError, type ToolErrorCode } from './src/errors.ts';
export {
	headRoutingRefusal,
	// Shared with the gateway's providers-file parser so both fold address spellings the same way.
	isForbiddenIpv4,
	isForbiddenIpv6,
	isForbiddenLiteralHost,
	parseIpv4,
	parseIpv6,
	privateLiteralEntries,
	probeEgressGrant,
} from './src/head.ts';
// The event-ring cursor vocabulary, shared by the gateway's two event transports and `browser_wait_for`.
export { formatCursor, navigationTarget, parseCursor, type ParsedCursor, SessionEventRing } from './src/events.ts';
export { parseSecrets, type SecretEntry, SecretStore } from './src/secrets.ts';
export type {
	EmbedTicket,
	EmbedTicketInput,
	McpAppsDeps,
	RecordingController,
	RecordingInfo,
	SignedLinkMinter,
	ToolContext,
	ToolResult,
} from './src/types.ts';
