/**
 * `@tykotech/gateway` — the HTTP process: the MCP mount, the live browser view, authentication and the static SPA on
 * one `Deno.serve` listener. Exports only what the CLI and the test tiers use.
 */
export { type RunningGateway, startGateway } from './src/server.ts';
export { createExpansionServices, providerNetHost } from './src/expansion.ts';
export { DEFAULT_SCOPES, ENV_NAMES, loadConfig, processEnv, type Scope, SCOPES } from './src/config.ts';
export { generateApiKey } from './src/auth.ts';
export { generateAdminUser } from './src/admin_auth.ts';
export { createLogger } from './src/logger.ts';
export { configuredAccounts, grantScopesInFile, UserStore, UserStoreError } from './src/users.ts';
export { frameScaleFor } from './src/liveview.ts';
export { TICKET_TTL_MAX_CONTROL_MS } from './src/tickets.ts';
export { resolveSecrets, secretReader } from './src/secrets.ts';
export { configuredSecretRefs, describeSecretRefs } from './src/secret_providers.ts';
export { loadModelProviders } from './src/model_providers.ts';
export { ModelProvidersAdmin } from './src/model_providers_admin.ts';
export { generateDbKey } from './src/vault.ts';
export { describeSeed, SEED_TARGETS } from './src/seed.ts';
export { databaseDoctorLine, openDataStore } from './src/data_store.ts';
export { MemoryStore } from './src/memory.ts';
export { DiskBudget } from './src/disk_budget.ts';
export { ServiceHealth } from './src/service_health.ts';
// The live-view wire contract lives in @tykotech/wire (the browser bundle imports it); re-exported for server tests.
export { type ClientMsg, decodeFrame, type FrameMeta, type ServerMsg } from '@tykotech/wire';
