/**
 * Configuration: environment → validated {@linkcode Config}.
 *
 * Parsing is fail-fast and names the offending variable — a server that boots
 * with a silently-defaulted security setting is worse than one that refuses to
 * boot. See SPECS/BACKEND.md §4.
 */
import * as z from 'zod';
import { parseMemorySize } from './browser_memory.ts';
import { parseSecrets, type SecretEntry, type SessionOwnership } from '@tykotech/mcp';
import { NODE_ROLES, type NodeRole } from './cluster.ts';
import { type ExpansionConfig, expansionConfig } from './expansion_config.ts';
import { type AdminUserRecord, readAdminUser } from './admin_auth.ts';
import { DEFAULT_ADMIN_USER_FILE } from './secrets.ts';
import { configuredSecretRefs, type SecretProviderName } from './secret_providers.ts';
import { configuredAccounts } from './users.ts';
import { LINK_TTL_DEFAULT_S, LINK_TTL_MAX_S, LINK_TTL_MIN_S } from './signed_links.ts';
import type { ModelProvidersConfig } from './model_providers.ts';
import { decodeDbKey } from './vault.ts';

/** Where the shared session index lives, and how peers reach this node. */
export interface ClusterSettings {
	readonly kvPath: string;
	readonly nodeId: string;
	readonly nodeUrl: string;
}

// SEC-01: the vocabulary and its partition have exactly one owner, in the
// lower layer, and are re-exported here so existing importers keep working.
// The former "every declared scope" alias is deliberately deleted rather than
// kept: a live name meaning "everything" is how the default-grant defect comes
// back, and with the name gone a stale import fails `deno check` instead.
export { DEFAULT_SCOPES, EXPLICIT_SCOPES, type Scope, SCOPES } from '@tykotech/mcp';
import { DEFAULT_SCOPES, type Scope, SCOPES, unknownScopes } from '@tykotech/mcp';

const ScopeSchema = z.enum(SCOPES);

/** The cap on `ApiKeyRecord.label` (SEC-15): the secret-name cap, and a length a lock banner can show. */
export const MAX_KEY_LABEL_LENGTH = 64;

/**
 * True when a label may reach every viewer of every session (SEC-15): at most 64 characters, printable
 * only — no control characters, and none of `<`, `>`, `&` — so no renderer downstream has to escape it.
 * Validated here, at parse time, because sanitising at render means every future renderer has to
 * remember to; a bad label refuses startup naming the key id.
 */
export function isSafeKeyLabel(label: string): boolean {
	if (label.length > MAX_KEY_LABEL_LENGTH) return false;
	// A code-point walk rather than a regular expression: the characters being refused are the
	// control ones, and a regex that must *contain* them is a source file with control characters
	// in it (this function had three). Refused: C0 — which includes the newline and the tab — plus
	// DEL, and the three markup characters that would otherwise oblige every downstream renderer to
	// escape this string.
	for (const character of label) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
		if (character === '<' || character === '>' || character === '&') return false;
	}
	return true;
}

/** GW-4: the longest API-key id. It becomes part of an owner (`api-key:<id>`), which the agent runtime bounds. */
export const MAX_KEY_ID_LENGTH = 128;

/**
 * GW-4: true when an API-key id can name only its own owner.
 *
 * An id becomes the owner `api-key:<id>` of every task, surface and workspace the key creates. The administrator
 * login is the principal `api-key` / `admin:<username>`, so a key whose id began `admin:` shared that owner — and
 * the stream re-check trusted the prefix for ever. `admin:` is therefore reserved (case-insensitively, so no
 * spelling of it reads as the administrator to a person). Control characters are refused because the owner
 * travels in the private bridge's `x-ttk-principal` header and through log lines; the length is bounded for the
 * same reason. Checked at parse, so startup and every key-file reload refuse the record alike.
 */
export function isSafeKeyId(id: string): boolean {
	if (id.length > MAX_KEY_ID_LENGTH || /^admin:/i.test(id)) return false;
	for (const character of id) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/** One API key, stored as a hash. The raw key never exists server-side. */
export const ApiKeyRecordSchema = z.object({
	id: z.string().min(1).refine(
		isSafeKeyId,
		`key id must be at most ${MAX_KEY_ID_LENGTH} printable characters and must not begin with "admin:", ` +
			'which is reserved for the administrator login',
	),
	sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
	scopes: z.array(ScopeSchema).optional(),
	label: z.string().optional(),
});
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;

export interface OAuthConfig {
	readonly issuer: URL;
	readonly audience: string;
	/** `TTK_OAUTH_JWKS_URL`; `null` means discover it from the provider's metadata (D-083). */
	readonly jwksUrl: URL | null;
}

export interface Config {
	readonly expansion: ExpansionConfig;
	readonly host: string;
	readonly port: number;
	readonly publicUrl: URL;
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly apiKeys: readonly ApiKeyRecord[];
	readonly adminUser: AdminUserRecord | null;
	/**
	 * The path `TTK_API_KEYS_FILE` named, or `null` when the records came from
	 * `TTK_API_KEYS` or from nowhere.
	 *
	 * Carried on the configuration because SR2-M3's reload watches that exact
	 * path, and the resolved contents alone cannot say where they came from. The
	 * **path** is not a secret — it appears in `docker inspect` already — whereas
	 * the contents never enter this field.
	 */
	readonly apiKeysFile: string | null;
	readonly oauth: OAuthConfig | null;
	readonly allowedDomains: readonly string[];
	/**
	 * `TTK_ALLOWED_DOMAINS_SCOPE` (containment-otel-links design §2.1, D-138): what the allowlist judges in the browser.
	 * `documents` (the default) judges document requests and, from D-139, prefetch/prerender hints; `all` judges every
	 * request a page makes. `all` with an empty allowlist is refused at parse — it would judge nothing while claiming
	 * to judge everything. S0: parsed, carried to the registry and the diagnostics; the registry acts on it in WS-B.
	 */
	readonly allowedDomainsScope: 'documents' | 'all';
	/**
	 * `TTK_OTEL_ENDPOINTS` (design §2.1, D-137): the OpenTelemetry collector origins the process edge allowlists, as a
	 * plain comma list for the **diagnostics only**. The one validator is the process edge (`packages/cli/otel_gate.ts`,
	 * §2.3), which refuses a malformed list before `loadConfig` ever runs, so the gateway never re-parses it.
	 */
	readonly otelEndpoints: readonly string[];
	/**
	 * Scopes granted to a principal that carries no credential: the stdio mount
	 * and the loopback-development mount. One name for both, because they are
	 * the same situation and two names would invite a deployment that set one
	 * and not the other. Validated as a subset of `SCOPES`.
	 */
	readonly anonScopes: readonly Scope[];
	/** Server-held credentials a model may reference by name (R14). */
	readonly secrets: readonly SecretEntry[];
	/**
	 * D-154: where {@linkcode secrets} came from. `TTK_SECRETS` and `TTK_SECRETS_FILE` seed the database's vault once;
	 * `TTK_SECRETS_REF` (an external secret manager) stays the source and is never seeded. `null` when none is set.
	 */
	readonly secretsSource: 'TTK_SECRETS' | 'TTK_SECRETS_FILE' | 'TTK_SECRETS_REF' | null;
	/**
	 * D-154: the database vault's key, decoded from `TTK_DB_KEY_FILE` (32 bytes), or `null`. Never rendered. Without it
	 * the database still holds providers and memory, but no secret can be stored.
	 */
	readonly dbKey: Uint8Array | null;
	/** Root for persistent profiles and storage state (R3); `null` disables both. */
	readonly dataDir: string | null;
	/** The ffmpeg executable used for session recording (R7); `null` disables it. */
	readonly ffmpeg: string | null;
	readonly browser: {
		readonly path: string | null;
		readonly args: readonly string[];
		readonly headless: boolean;
		/**
		 * D-094: `false` only when `TTK_CHROMIUM_NO_SANDBOX=true` — the one way to run Chromium without its
		 * sandbox. `TTK_BROWSER_ARGS` can no longer reach the same result (see {@linkcode browserArgRefusal}).
		 */
		readonly chromiumSandbox: boolean;
	};
	/**
	 * How long a sign-in session (`ttks_`) lives, `TTK_LOGIN_TTL_S` (D-073). Distinct from `limits.sessionTtlMs`,
	 * which reaps idle *browser* sessions.
	 */
	readonly loginTtlMs: number;
	readonly limits: {
		readonly maxSessions: number;
		readonly sessionTtlMs: number;
		/**
		 * The container's memory limit in bytes, `TTK_MEMORY_LIMIT` (Compose fills it from the value it gives
		 * `mem_limit`); `null` when unset. Display only — the Sessions screen's meters measure against it; Deno cannot
		 * read cgroup without `--allow-all`, so the server is told rather than asking.
		 */
		readonly memoryLimitBytes: number | null;
		readonly maxViewersPerSession: number;
		readonly castQuality: number;
		readonly rateRpm: number;
		/**
		 * A5 (D-100): the most an `/api/v1/*` or `/a2a` request body may carry, `TTK_MAX_BODY_KB`. Enforced at the
		 * gateway's front, before anything parses the body; routes with a documented cap of their own keep it.
		 */
		readonly maxBodyBytes: number;
	};
	/**
	 * Serve the 2025-era stateful transport alongside the default (R8).
	 *
	 * Off by default: a transport session pins a client to one process, which is
	 * exactly what the stateless design exists to avoid.
	 */
	readonly mcpStateful: boolean;
	/**
	 * Multi-node configuration (R10) and this node's role (R12).
	 *
	 * `cluster` is `null` for the single-node default, which is also the only
	 * shape that needs no runtime flag.
	 */
	readonly cluster: ClusterSettings | null;
	readonly role: NodeRole;
	readonly logFormat: 'json' | 'pretty';
	readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
	/** C11 (D-101): `TTK_METRICS` mounts `GET /metrics` (Prometheus text) for `metrics:read` or `admin`. */
	readonly metrics: boolean;
	/**
	 * R5 (D-125): `TTK_CONFIRM_DESTRUCTIVE`, on by default — the destructive set asks a client that declared form
	 * elicitation to have its human confirm. Read by the gateway and by stdio.
	 */
	readonly confirmDestructive: boolean;
	/**
	 * R2 (D-124, D-150): `TTK_HUMAN_HANDOFF`, on by default — offers `browser_request_human`, which hands out the
	 * `TTK_PUBLIC_URL` live-view link of a session. Read by the gateway only: stdio has no public URL to hand out.
	 */
	readonly humanHandoff: boolean;
	/**
	 * R15 (D-123): the external providers `TTK_API_KEYS_REF` / `TTK_SECRETS_REF` name, for the admin diagnostics only.
	 * The values themselves arrive through `options.secrets`, resolved before this runs.
	 */
	readonly secretProviders: readonly SecretProviderName[];
	/**
	 * R8 (D-128, D-150): `TTK_SESSION_OWNERSHIP` — `owner` (the default on a single node: a session belongs to the
	 * principal that created it; `admin` reaches all) or `shared` (every `mcp:invoke` holder reaches every session;
	 * the default in a cluster, whose routing is owner-blind).
	 */
	readonly sessionOwnership: SessionOwnership;
	/**
	 * R9 (D-134, D-150): MCP Apps — `TTK_MCP_APPS`, `TTK_MCP_APPS_ORIGINS`, `TTK_MCP_APPS_DOMAIN`. Unset, `control`
	 * wherever it can run (not clustered); `null` (`TTK_MCP_APPS=off`, or unset in a cluster) serves no `ui://`
	 * document and offers neither live-view tool.
	 */
	readonly mcpApps: McpAppsConfig | null;
	/**
	 * R10 (design §2.1, §2.7, D-119, D-150): `TTK_SIGNED_LINKS`, with its default life and key; `null` while it is
	 * off. Unset, it is on whenever a signing key can be had. The key is set only when `TTK_SIGNED_LINK_KEY_FILE`
	 * named one — otherwise startup reads or creates the key under `TTK_DATA_DIR` — and, like `secrets`, it is never
	 * rendered anywhere.
	 */
	readonly signedLinks: SignedLinksSettings | null;
	/**
	 * D-150: one line for each default-on switch (`TTK_SESSION_OWNERSHIP`, `TTK_SIGNED_LINKS`, `TTK_MCP_APPS`) the
	 * operator left unset and this deployment cannot run, naming the variable and why it resolved off. `startGateway`
	 * logs each once at `info`; nothing here is a secret or a value the operator did not write.
	 */
	readonly featureNotes: readonly string[];
	/**
	 * D-143 (model-providers-ui): the operator's model providers, resolved from `TTK_MODEL_PROVIDERS_FILE` by the CLI
	 * and handed in through `options.modelProviders` the way file-backed secrets are — never read from `env` here.
	 * `null` when the variable is unset (the feature is absent). S0 seam: always `null`; W1 wires the parser.
	 */
	readonly modelProviders: ModelProvidersConfig | null;
}

/** `TTK_SIGNED_LINKS=true`, parsed (R10, design §2.1). */
export interface SignedLinksSettings {
	/**
	 * `TTK_SIGNED_LINK_TTL_S`: a link's life when the caller names none, {@linkcode LINK_TTL_MIN_S}–
	 * {@linkcode LINK_TTL_MAX_S} s, default {@linkcode LINK_TTL_DEFAULT_S} (10–3600, default 3600; G5, D-140).
	 */
	readonly ttlS: number;
	/** The contents of `TTK_SIGNED_LINK_KEY_FILE`, or `null` for the generated data-directory key. */
	readonly key: string | null;
	/**
	 * D-150: true when `TTK_SIGNED_LINKS` was unset and this is its default. A defaulted switch whose key cannot be
	 * read or created at startup resolves off with a warning; an explicit `true` keeps refusing startup.
	 */
	readonly defaulted: boolean;
}

/** The MCP Apps deployment as `loadConfig` validated it (R9, design §2.1). */
export interface McpAppsConfig {
	/** The ceiling: `watch` mints watch tickets only; `control` also lets an embed take control on a click. */
	readonly mode: 'watch' | 'control';
	/**
	 * Full host origins an embed ticket may be bound to; every hostname is already in `TTK_ALLOWED_ORIGINS`. Empty
	 * (D-150) means any {@linkcode isAppsOrigin} origin whose hostname the caller's effective allowed origins admit.
	 */
	readonly origins: readonly string[];
	/** `_meta.ui.domain`, passed through to the host verbatim; `null` when unset. */
	readonly domain: string | null;
	/**
	 * D-150: true when `TTK_MCP_APPS` was unset and `control` is its default. A defaulted switch whose embed documents
	 * are missing from the build resolves off with a warning; an explicit mode keeps refusing startup.
	 */
	readonly defaulted: boolean;
}

/** Raised for any invalid configuration; the message names the variable. */
export class ConfigError extends Error {
	constructor(variable: string, detail: string) {
		super(`${variable}: ${detail}`);
		this.name = 'ConfigError';
	}
}

/** The environment as a plain map, so tests need not mutate the process. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Reads the live process environment (requires `--allow-env`). */
export function processEnv(names: readonly string[]): Env {
	const env: Record<string, string | undefined> = {};
	for (const name of names) env[name] = Deno.env.get(name);
	return env;
}

/** Every variable the gateway reads. */
export const ENV_NAMES = [
	'TTK_SANDBOX_URL',
	'TTK_SANDBOX_TOKEN_FILE',
	'TTK_AGENT_BRIDGE_URL',
	'TTK_AGENT_BRIDGE_TOKEN_FILE',
	'TTK_AGENT_DEFAULT',
	'TTK_AGENT_AUTH_METHOD',
	'TTK_AGENT_PEERS_FILE',
	// C4 / B1 / A11 (D-105, D-104, D-106): agent task bounds and the A2A push host allowlist.
	'TTK_AGENT_TASK_TIMEOUT_S',
	'TTK_AGENT_TASK_RETENTION_S',
	'TTK_A2A_PUSH_ALLOWED_HOSTS',
	'TTK_HOST',
	'TTK_PORT',
	'TTK_PUBLIC_URL',
	'TTK_ALLOWED_HOSTS',
	'TTK_AGENT_MCP_URL',
	'TTK_A2UI_ACTIONS',
	'TTK_ALLOWED_ORIGINS',
	'TTK_API_KEYS',
	'TTK_API_KEYS_FILE',
	'TTK_ADMIN_USER',
	'TTK_ADMIN_USER_FILE',
	'TTK_OAUTH_ISSUER',
	'TTK_OAUTH_AUDIENCE',
	'TTK_OAUTH_JWKS_URL',
	'TTK_ALLOWED_DOMAINS',
	'TTK_ANON_SCOPES',
	'TTK_SECRETS',
	'TTK_SECRETS_FILE',
	'TTK_DATA_DIR',
	'TTK_FFMPEG',
	'TTK_BROWSER_PATH',
	'TTK_BROWSER_ARGS',
	'TTK_CHROMIUM_NO_SANDBOX',
	'TTK_HEADLESS',
	'TTK_MAX_SESSIONS',
	'TTK_MEMORY_LIMIT',
	'TTK_SESSION_TTL_S',
	'TTK_LOGIN_TTL_S',
	'TTK_MAX_VIEWERS',
	'TTK_CAST_QUALITY',
	'TTK_RATE_RPM',
	'TTK_MAX_BODY_KB',
	'TTK_MCP_STATEFUL',
	'TTK_ROLE',
	'TTK_CLUSTER_KV',
	'TTK_NODE_ID',
	'TTK_NODE_URL',
	'TTK_METRICS',
	'TTK_LOG_FORMAT',
	'TTK_LOG_LEVEL',
	// S0 (design §2.1): the seventeen names mcp-recommendations adds, declared before any workstream parses one so
	// every `processEnv` caller already hands them to `loadConfig`. Unread in S0; each block's workstream parses it.
	'TTK_HUMAN_HANDOFF', // W4
	'TTK_SESSION_OWNERSHIP', // W5
	'TTK_CONFIRM_DESTRUCTIVE', // W4
	'TTK_SIGNED_LINKS', // W2
	'TTK_SIGNED_LINK_TTL_S', // W2
	'TTK_SIGNED_LINK_KEY_FILE', // W2
	'TTK_DB_KEY_FILE', // D-154
	'TTK_MCP_APPS', // W7
	'TTK_MCP_APPS_ORIGINS', // W7
	'TTK_MCP_APPS_DOMAIN', // W7
	'TTK_API_KEYS_REF', // W3
	'TTK_SECRETS_REF', // W3
	'TTK_VAULT_ADDR', // W3
	'TTK_OP_CONNECT_URL', // W3
	'TTK_VAULT_TOKEN_FILE', // W3
	'TTK_OP_CONNECT_TOKEN_FILE', // W3
	'TTK_VAULT_NAMESPACE', // W3
	'TTK_SECRET_PROVIDER_CA_FILE', // W3
	// containment-otel-links S0 (design §2.0 item 1, §2.1): the two names that run adds.
	'TTK_OTEL_ENDPOINTS', // WS-A: validated at the process edge; listed here for the diagnostics
	'TTK_ALLOWED_DOMAINS_SCOPE', // WS-B: `documents` | `all`
	// model-providers-ui S0 (D-143): the providers file. Threaded like `TTK_SECRETS_FILE` — the CLI reads it and
	// passes the result in `LoadConfigOptions.modelProviders` (W1); `loadConfig` never reads it from `env`.
	'TTK_MODEL_PROVIDERS_FILE',
] as const;

// --- helpers ---------------------------------------------------------------

function list(env: Env, name: string): string[] {
	const raw = env[name];
	if (raw === undefined || raw.trim() === '') return [];
	return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * The scopes a credential-less principal receives (SEC-01).
 *
 * An unknown name refuses startup naming the variable, the offending value and
 * the whole vocabulary: a scope list that silently dropped its typos would grant
 * less than the operator wrote and say nothing about it, which is how a
 * deployment ends up believing it has a boundary it does not have. Unset means
 * `DEFAULT_SCOPES`; an explicitly empty value means exactly that — no scopes —
 * because an operator who writes `TTK_ANON_SCOPES=` is asking for a principal
 * that can do nothing, and reading that as "unset" would grant the maximum.
 */
function anonScopes(env: Env): readonly Scope[] {
	const raw = env.TTK_ANON_SCOPES;
	if (raw === undefined) return DEFAULT_SCOPES;
	const named = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
	if (named.length === 0) return [];
	const unknown = unknownScopes(named);
	if (unknown.length > 0) {
		throw new ConfigError(
			'TTK_ANON_SCOPES',
			`unknown scope${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}; valid scopes are ${SCOPES.join(', ')}`,
		);
	}
	return named as Scope[];
}

/**
 * `TTK_ALLOWED_DOMAINS_SCOPE` (design §2.1, D-138): `documents` (default) or `all`, trimmed and case-insensitive.
 *
 * `all` with an empty `TTK_ALLOWED_DOMAINS` is refused rather than read as "unrestricted": an empty allowlist judges
 * nothing (D-020), and an operator who asked for every request to be judged must not get a deployment that judges none
 * while the diagnostics say `all`.
 */
function allowedDomainsScopeOf(env: Env, allowedDomains: readonly string[]): 'documents' | 'all' {
	const raw = env.TTK_ALLOWED_DOMAINS_SCOPE?.trim().toLowerCase() || 'documents';
	if (raw !== 'documents' && raw !== 'all') {
		throw new ConfigError('TTK_ALLOWED_DOMAINS_SCOPE', `expected documents|all, got ${JSON.stringify(raw)}`);
	}
	if (raw === 'all' && allowedDomains.length === 0) {
		throw new ConfigError('TTK_ALLOWED_DOMAINS_SCOPE', 'all needs a non-empty TTK_ALLOWED_DOMAINS');
	}
	return raw;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new ConfigError(name, `expected an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
	}
	return value;
}

/** `TTK_MEMORY_LIMIT`: a size as Compose writes one (`1536m`, `1.5g`, bytes), or `null` when unset. */
function memoryLimit(env: Env): number | null {
	const raw = env.TTK_MEMORY_LIMIT?.trim();
	if (raw === undefined || raw === '') return null;
	const bytes = parseMemorySize(raw);
	if (bytes === null || bytes < 64 * 1024 * 1024) {
		throw new ConfigError(
			'TTK_MEMORY_LIMIT',
			`expected a size of at least 64m (e.g. 1536m, 1.5g), got ${JSON.stringify(raw)}`,
		);
	}
	return bytes;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
	const raw = env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const normalized = raw.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	throw new ConfigError(name, `expected a boolean, got ${JSON.stringify(raw)}`);
}

// --- TTK_BROWSER_ARGS: the refusal list (D-094, C5/F7/N5) ---------------------

/**
 * Chromium switches that weaken or remove the sandbox the product's job depends on (REJ-003).
 *
 * Running Chromium unsandboxed is now **one** deliberate, loud setting — `TTK_CHROMIUM_NO_SANDBOX` — and
 * these are the back doors to the same state that a comma-separated argument list used to leave open. Any
 * switch name containing `sandbox` is refused too, so `--no-zygote-sandbox`, `--no-sandbox-and-elevated`
 * and the next spelling Chromium adds are caught without this list having to know them first.
 */
const SANDBOX_WEAKENING_SWITCHES: ReadonlySet<string> = new Set([
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--no-zygote',
	'--single-process',
	'--disable-seccomp-filter-sandbox',
	'--disable-namespace-sandbox',
	'--disable-gpu-sandbox',
	// R1-4: runs the GPU process as a thread of the unsandboxed browser process — the GPU analogue of
	// `--single-process`, with the effect of `--disable-gpu-sandbox`, and the copy-paste cure for headless GPU trouble
	// in a container that this list exists to catch. Its name says nothing about a sandbox, so it is listed by name.
	'--in-process-gpu',
]);

/**
 * Switches the browser launcher owns. The DevTools endpoint is the browser's whole control surface: it is
 * opened by the launcher on loopback with an ephemeral port and must never be re-addressed, re-exposed or
 * opened to another origin from configuration. `--user-data-dir` is the launcher's too — profiles live under
 * `TTK_DATA_DIR`. Every `--remote-debugging-*` spelling is refused, not only the three named.
 */
const LAUNCHER_OWNED_SWITCHES: ReadonlySet<string> = new Set([
	'--remote-debugging-port',
	'--remote-debugging-pipe',
	'--remote-debugging-address',
	'--remote-allow-origins',
	'--user-data-dir',
]);

/**
 * Switches that make Chromium execute another program: a wrapper around every renderer, utility or GPU
 * process, or a different helper binary. Every `*-cmd-prefix` and `*-launcher` switch is refused as well.
 */
const COMMAND_SWITCHES: ReadonlySet<string> = new Set([
	'--renderer-cmd-prefix',
	'--utility-cmd-prefix',
	'--gpu-launcher',
	'--browser-subprocess-path',
]);

/** A switch name as Chromium reads one: `--`, then a name with no `=`, whitespace or other punctuation. */
const SWITCH_NAME = /^--[a-z0-9][a-z0-9._-]*$/;

/**
 * Why one `TTK_BROWSER_ARGS` entry is refused, or `null` when it may reach the launcher.
 *
 * Case-insensitive — Chromium lowercases switch names on Windows, so `--No-Sandbox` there is `--no-sandbox` —
 * and the value after `=` never rescues a switch. An entry that is not a `--name[=value]` switch is refused
 * outright: Chromium also accepts `-name` and, on Windows, `/name`, and a bare `--` ends switch parsing, so
 * "starts with `--` and names something" is the only shape a denylist can reason about. The text names the
 * switch, never its value, which may be a path or a host the operator would rather not see echoed.
 */
export function browserArgRefusal(entry: string): string | null {
	if (!entry.startsWith('--')) {
		return `${JSON.stringify(entry.slice(0, 64))} is not a Chromium switch; every entry must be --name or ` +
			'--name=value (the list is split on commas, so a value cannot contain one)';
	}
	const equals = entry.indexOf('=');
	const name = (equals < 0 ? entry : entry.slice(0, equals)).toLowerCase();
	if (!SWITCH_NAME.test(name)) {
		return `${JSON.stringify(name.slice(0, 64))} is not a Chromium switch name; every entry must be --name or ` +
			'--name=value';
	}
	if (SANDBOX_WEAKENING_SWITCHES.has(name) || name.includes('sandbox')) {
		return `${name} weakens the Chromium sandbox and is refused here; set TTK_CHROMIUM_NO_SANDBOX=true to run ` +
			'Chromium without its sandbox deliberately';
	}
	if (name === '--disable-features' && equals >= 0) {
		const disabled = entry.slice(equals + 1).split(/[,\s]+/).find((feature) => /sandbox/i.test(feature));
		if (disabled !== undefined) {
			return `--disable-features names ${disabled.slice(0, 64)}, which weakens the Chromium sandbox and is ` +
				'refused here; set TTK_CHROMIUM_NO_SANDBOX=true to run Chromium without its sandbox deliberately';
		}
	}
	if (LAUNCHER_OWNED_SWITCHES.has(name) || name.startsWith('--remote-debugging-')) {
		return `${name} is owned by the browser launcher and is refused: the DevTools endpoint stays on loopback ` +
			'with an ephemeral port, and profiles live under TTK_DATA_DIR';
	}
	if (COMMAND_SWITCHES.has(name) || name.endsWith('-cmd-prefix') || name.endsWith('-launcher')) {
		return `${name} would make Chromium execute another program and is refused`;
	}
	return null;
}

/** `TTK_BROWSER_ARGS`, refused at parse time when any entry is on the list (D-094). */
function browserArgs(env: Env): string[] {
	const args = list(env, 'TTK_BROWSER_ARGS');
	for (const entry of args) {
		const refusal = browserArgRefusal(entry);
		if (refusal !== null) throw new ConfigError('TTK_BROWSER_ARGS', refusal);
	}
	return args;
}

/**
 * Browser origins permitted to call the API.
 *
 * ERRATUM(E-23). The default used to be the empty list, documented as
 * "deny all", on the reasoning that a browser origin is the cross-site threat
 * this check exists to stop. It denied one origin too many: **this server's
 * own**. The live-view SPA is served by this process, from this origin, and a
 * same-origin `POST` still carries an `Origin` header — so
 * `/api/v1/live/ticket` was rejected with 403 for every browser, and the live
 * view, the whole point of the product, could not be opened at all without the
 * operator discovering `TTK_ALLOWED_ORIGINS` and setting it. The README's own
 * five-minute path ("open <http://127.0.0.1:8787/> and paste the key") did not
 * work.
 *
 * The default is now the origins this server answers on and nothing else. That
 * is not a weakening: a page on any *other* origin still sends that origin and
 * is still refused, DNS rebinding is still caught (the Origin stays the
 * attacker's name while `allowedHosts` catches the Host), and every API call
 * still needs a bearer token a cross-origin page cannot read. An explicit
 * `TTK_ALLOWED_ORIGINS` replaces the default outright, so a deployment that
 * wants to permit a separately-hosted front end still can.
 */
function allowedOrigins(env: Env, host: string, publicUrl: URL): string[] {
	const configured = list(env, 'TTK_ALLOWED_ORIGINS');
	if (configured.length > 0) {
		// **A startup refusal, not a warning (B1.10).** The adapter compares
		// `new URL(origin).hostname` against these entries *verbatim*
		// (`validateOriginHeader`, `@modelcontextprotocol/server` 2.0.0), so an
		// entry carrying a scheme or a port — `https://app.example:3000`, which is
		// exactly what an operator copies out of a browser's address bar — matches
		// nothing at all, silently, and the live view is refused on every call with
		// a 403 the operator has no way to trace back to this list.
		//
		// The set that breaks is exactly the set whose origin policy already does
		// not do what its operator wrote; no deployment whose list works today
		// stops working. RR-3 is that cost, and the mitigation is that the refusal
		// prints the corrected list rather than only naming the fault.
		const unmatchable = configured.filter((entry) => entry !== bareHostname(entry));
		if (unmatchable.length > 0) {
			const corrected = configured.map(bareHostname).filter((name) => name !== '');
			throw new ConfigError(
				'TTK_ALLOWED_ORIGINS',
				`${unmatchable.map((entry) => JSON.stringify(entry)).join(', ')} ` +
					`${unmatchable.length === 1 ? 'carries' : 'carry'} a scheme or a port, and this list is compared ` +
					`against a bare hostname — so ${unmatchable.length === 1 ? 'it matches' : 'they match'} nothing. ` +
					`Write it as ${JSON.stringify(corrected.join(','))}.`,
			);
		}
		return configured;
	}
	const own = new Set<string>([publicUrl.hostname]);
	// A loopback bind answers to all three spellings, and a browser will use
	// whichever one the operator typed.
	if (isLoopbackHost(host)) {
		own.add('localhost');
		own.add('127.0.0.1');
		own.add('[::1]');
	}
	return [...own].filter((entry) => entry !== '');
}

/** `TTK_MCP_APPS_DOMAIN`'s bound: the longest DNS name, which is the form every host's example takes. */
const MAX_APPS_DOMAIN_LENGTH = 253;

/** C0, DEL and C1: characters no header-ish value passed to a host may carry. */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** Why `entry` cannot be an MCP Apps embed origin, or `null` when it can: the rule {@linkcode isAppsOrigin} names. */
function appsOriginFault(entry: string): 'not-an-origin' | 'scheme' | null {
	const parsed = URL.parse(entry);
	if (parsed === null || parsed.origin === 'null' || parsed.origin !== entry) return 'not-an-origin';
	const loopback = isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ''));
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return 'scheme';
	return null;
}

/**
 * Whether `entry` is an origin an MCP Apps embed ticket may be bound to: a full `scheme://host[:port]` origin exactly
 * as a browser's `Origin` header spells it — no path, no trailing slash, no userinfo — `https:` always, `http:` only
 * for a loopback host (a test harness or a desktop host on this machine).
 *
 * One rule for both places an embed origin is judged: a `TTK_MCP_APPS_ORIGINS` entry at startup, and — with that list
 * empty (D-150) — the `origin` argument of `browser_live_ticket`, so the two can never disagree about what a host's
 * sandbox may present.
 */
export function isAppsOrigin(entry: string): boolean {
	return appsOriginFault(entry) === null;
}

/**
 * One `TTK_MCP_APPS_ORIGINS` entry, by {@linkcode isAppsOrigin}. A ticket is bound by string equality with the
 * upgrade's `Origin`, so an entry a browser would never send can never be matched, and is refused rather than kept as
 * dead configuration.
 */
function appsOrigin(entry: string): string {
	const fault = appsOriginFault(entry);
	if (fault === 'not-an-origin') {
		throw new ConfigError(
			'TTK_MCP_APPS_ORIGINS',
			`${JSON.stringify(entry.slice(0, 256))} is not an origin; write each entry as scheme://host[:port] with no ` +
				'path or trailing slash, exactly as the host’s sandbox frame sends it in its Origin header',
		);
	}
	if (fault === 'scheme') {
		throw new ConfigError(
			'TTK_MCP_APPS_ORIGINS',
			`${entry} must be https:// (http:// is accepted only for a loopback host)`,
		);
	}
	return entry;
}

/**
 * MCP Apps (R9, design §2.1, D-134), refused at startup rather than at the first embed.
 *
 * `TTK_ALLOWED_ORIGINS` stays the admission list (G9): the upgrade's front and adapter compare the host's sandbox
 * hostname against it before a ticket is looked at, so an origin listed here whose hostname is not admitted there
 * could never open a socket. `TTK_MCP_APPS_ORIGINS` exists only because a ticket binding needs the full origin, and
 * it can only narrow; empty (D-150), the mint binds the ticket to the caller's own `origin` argument instead, under
 * the same hostname admission. The cluster refusal is the design's (§1 item 4): tickets are node-local and the
 * embed's upgrade reaches whichever node `TTK_PUBLIC_URL` names. The format checks apply even while the feature is
 * off, so a value that could never work is found when it is written, not when the switch is turned on.
 *
 * D-150: unset is `control` — the modes are ceilings, and a control ticket still needs `view:control` — except in a
 * cluster, where it resolves off and says so in `notes` rather than refusing a deployment that never asked for it.
 */
function mcpAppsConfig(
	env: Env,
	allowedOrigins: readonly string[],
	clustered: boolean,
	notes: string[],
): McpAppsConfig | null {
	const named = env.TTK_MCP_APPS?.trim().toLowerCase() ?? '';
	const defaulted = named === '';
	const raw = defaulted ? (clustered ? 'off' : 'control') : named;
	if (raw !== 'off' && raw !== 'watch' && raw !== 'control') {
		throw new ConfigError('TTK_MCP_APPS', `expected off|watch|control, got ${JSON.stringify(env.TTK_MCP_APPS)}`);
	}
	if (defaulted && clustered) {
		notes.push(
			'TTK_MCP_APPS is unset and stays off: an embed ticket lives on the node that minted it, so MCP Apps cannot ' +
				'run in a cluster (TTK_CLUSTER_KV)',
		);
	}
	const origins = [...new Set(list(env, 'TTK_MCP_APPS_ORIGINS').map(appsOrigin))];
	const domainRaw = env.TTK_MCP_APPS_DOMAIN?.trim() ?? '';
	if (domainRaw.length > MAX_APPS_DOMAIN_LENGTH) {
		throw new ConfigError('TTK_MCP_APPS_DOMAIN', `at most ${MAX_APPS_DOMAIN_LENGTH} characters`);
	}
	if (hasControlCharacter(domainRaw)) {
		throw new ConfigError('TTK_MCP_APPS_DOMAIN', 'must not contain control characters');
	}
	if (raw === 'off') return null;
	if (clustered) {
		throw new ConfigError(
			'TTK_MCP_APPS',
			'MCP Apps cannot run in a cluster: an embed ticket lives on the node that minted it, and the socket reaches ' +
				'whichever node TTK_PUBLIC_URL names; unset TTK_MCP_APPS or TTK_CLUSTER_KV',
		);
	}
	// D-150: no origins is no longer a refusal. The mint then admits the caller's `origin` argument when it is an
	// `isAppsOrigin` origin whose hostname the effective allowed origins admit — the admission the socket upgrade
	// applies anyway — and binds the ticket to exactly that origin, so the list stays a narrowing, never a widening.
	const admitted = new Set(allowedOrigins.map(bareHostname).filter((name) => name !== ''));
	const unadmitted = origins.filter((origin) => !admitted.has(new URL(origin).hostname));
	if (unadmitted.length > 0) {
		throw new ConfigError(
			'TTK_MCP_APPS_ORIGINS',
			`${unadmitted.join(', ')} ${unadmitted.length === 1 ? 'is' : 'are'} not admitted by TTK_ALLOWED_ORIGINS, so ` +
				`${unadmitted.length === 1 ? 'its' : 'their'} socket would be refused before any ticket; add ` +
				`${unadmitted.map((origin) => new URL(origin).hostname).join(',')} to TTK_ALLOWED_ORIGINS deliberately`,
		);
	}
	return { mode: raw, origins, domain: domainRaw === '' ? null : domainRaw, defaulted };
}

/**
 * One path in a form two paths can be compared in.
 *
 * Separators only — no realpath, no filesystem access at all, because
 * `loadConfig` runs before any permission beyond `--allow-env` is needed and
 * must not acquire one. A symlinked data root is therefore not caught here; the
 * check is against the operator's own spelling, which is what the operator can
 * act on.
 */
function normalizedPath(value: string): string {
	const slashes = value.trim().replaceAll('\\', '/');
	const collapsed = slashes.replace(/\/+/g, '/');
	return collapsed.endsWith('/') && collapsed.length > 1 ? collapsed.slice(0, -1) : collapsed;
}

/** Hostnames that count as loopback for the bind policy. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Bind addresses meaning "every local interface" — what the container image sets. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']);

export function isWildcardHost(host: string): boolean {
	return WILDCARD_HOSTS.has(host.toLowerCase());
}

/**
 * Whether an allowlist holds any name a client on another machine could
 * actually present. A wildcard counts for no more than a loopback spelling
 * does: `0.0.0.0` is a bind address, and no client ever sends it.
 */
function reachesBeyondLoopback(names: readonly string[]): boolean {
	return names.some((entry) => {
		const bare = entry.replace(/^\[|\]$/g, '');
		return !isLoopbackHost(bare) && !isWildcardHost(bare);
	});
}

/**
 * Host header values the server answers to — the DNS-rebinding guard.
 *
 * ERRATUM(E-32). This list used to be a hardcoded loopback set that ignored
 * both `TTK_HOST` and `TTK_PUBLIC_URL`. The container image binds `0.0.0.0`,
 * so the server listened on every interface and then refused every request
 * that arrived under any address but `127.0.0.1` — `403 Invalid Host`. A
 * client on another machine connected, got a 403 on `initialize`, and showed
 * no tools. The socket was never the problem and neither was the Deno
 * permission: `--allow-net=0.0.0.0:8787` binds correctly and accepts inbound
 * connections from any peer.
 *
 * `allowedOrigins` below already derived itself from the bind and the public
 * URL (that was E-23). The same fix was not applied one field up.
 *
 * `TTK_PUBLIC_URL` is the only thing that can be right for a published
 * container: the client's `Host` carries the address of the *host machine*,
 * which is NAT'd and which the container cannot discover by enumerating its
 * own interfaces. So the operator declares it, and a bind that answers beyond
 * loopback without a declaration warns at startup (`checkBindPolicy`) rather
 * than failing one 403 at a time.
 */
function allowedHostNames(env: Env, host: string, publicUrl: URL): string[] {
	const names = new Set<string>();
	const add = (entry: string) => {
		const name = bareHostname(entry);
		// A wildcard is a bind address, never a name a client sends — and with
		// `TTK_PUBLIC_URL` unset the public URL is derived from the bind, so
		// dropping it here is what leaves `checkBindPolicy` a case to warn on.
		if (name !== '' && !isWildcardHost(name)) names.add(name);
	};

	const configured = list(env, 'TTK_ALLOWED_HOSTS');
	if (configured.length > 0) {
		configured.forEach(add);
		return [...names];
	}

	add(publicUrl.hostname);
	// D-068: the operator's private ACP callback is a host grant, never an origin grant.
	if (env.TTK_AGENT_MCP_URL) {
		try {
			add(new URL(env.TTK_AGENT_MCP_URL).hostname);
		} catch { /* Expansion config rejects invalid URLs. */ }
	}
	// A wildcard bind answers on loopback too, so the loopback spellings stay;
	// a specific address answers under its own name and nothing else.
	if (isLoopbackHost(host) || isWildcardHost(host)) {
		add('127.0.0.1');
		add('localhost');
		add('[::1]');
	} else {
		add(host);
	}
	return [...names];
}

/**
 * An allowlist entry reduced to the bare hostname the SDK will compare against.
 *
 * `validateHostHeader` parses the `Host` header with the URL API and matches
 * `hostname` — so the comparison is port-agnostic and an entry that carries a
 * port matches nothing at all. The default this replaced listed
 * `127.0.0.1:8787` and `localhost:8787` alongside the bare names; those two
 * entries had never matched a request. An operator setting
 * `TTK_ALLOWED_HOSTS` naturally writes `host:port` too, and got a silent 403
 * for it, so their input is normalised here rather than taken literally.
 * A scheme and any path are tolerated for the same reason.
 *
 * Exported because the origin overlay (B1.10) computes its intersection against
 * what the process-wide ceiling *means* rather than against how it is spelled,
 * and a second copy of this reduction would be a second answer to one question.
 */
export function bareHostname(entry: string): string {
	const cleaned = entry.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
	if (cleaned === '') return '';
	try {
		return new URL(`http://${cleaned}`).hostname;
	} catch {
		return '';
	}
}

/**
 * Review R1-1 (D-123, S-10): all a refusal of a secret-bearing value that is not JSON may say — a fixed phrase, and
 * the position of the fault when the parser reports one.
 *
 * V8's own message quotes the input: the whole of it when it is short (`Unexpected token 'h', "hunter2-…" is not
 * valid JSON`), its first characters otherwise, and the offending character either way. An operator who stores a
 * bare key where the record list belongs — in a file, inline, or behind a `*_REF` — had it printed to stderr and the
 * container log by the refusal meant to protect it. The position is a number the operator can find the fault by.
 */
function jsonFault(cause: unknown): string {
	const at = cause instanceof SyntaxError ? /\bat position (\d+)\b/.exec(cause.message)?.[1] : undefined;
	return at === undefined ? 'not valid JSON' : `not valid JSON at position ${at}`;
}

/**
 * Parses a key file or `TTK_API_KEYS` value into records.
 *
 * Exported since SR2-M3 so the reload path parses a changed key file through
 * **this** function rather than a second one: SEC-15's label validation, the
 * duplicate-id refusal and the schema that admits only `id`, `sha256`, `scopes`
 * and `label` must apply to a reloaded file exactly as they do at startup. A
 * second parser would be a second answer to one question, and the reload one
 * would be the one nobody read.
 */
export function parseApiKeys(raw: string, source: string): ApiKeyRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new ConfigError(source, jsonFault(cause));
	}
	const result = z.array(ApiKeyRecordSchema).safeParse(parsed);
	if (!result.success) {
		throw new ConfigError(source, `invalid key records: ${result.error.issues[0]?.message ?? 'unknown'}`);
	}
	const ids = new Set<string>();
	for (const record of result.data) {
		if (ids.has(record.id)) throw new ConfigError(source, `duplicate key id ${record.id}`);
		ids.add(record.id);
		// SEC-15: the label reaches every viewer of every session as `holder_name`, watch-only
		// viewers included. Refused at startup rather than sanitised at render.
		if (record.label !== undefined && !isSafeKeyLabel(record.label)) {
			throw new ConfigError(
				source,
				`key ${record.id}: label must be at most ${MAX_KEY_LABEL_LENGTH} printable characters with none of <, >, & ` +
					'or a control character; it is shown to every viewer of every session, so it must not carry a credential ' +
					'or an address',
			);
		}
	}
	return result.data;
}

// --- the parser -------------------------------------------------------------

export interface LoadConfigOptions {
	/** Resolved secret-file contents, keyed by variable name (see secrets.ts). */
	readonly secrets?: Readonly<Record<string, string>>;
	/** D-143: the providers file, already read and resolved (`loadModelProviders`); absent or `null` means none. */
	readonly modelProviders?: ModelProvidersConfig | null;
}

export function loadConfig(env: Env, options: LoadConfigOptions = {}): Config {
	const host = env.TTK_HOST?.trim() || '127.0.0.1';
	// 0 is meaningful: bind an ephemeral port and report it on listen.
	const port = int(env, 'TTK_PORT', 8787, 0, 65535);

	let publicUrl: URL;
	const rawPublic = env.TTK_PUBLIC_URL?.trim();
	if (rawPublic === undefined || rawPublic === '') {
		publicUrl = new URL(`http://${isLoopbackHost(host) ? '127.0.0.1' : host}:${port}`);
	} else {
		try {
			publicUrl = new URL(rawPublic);
		} catch {
			throw new ConfigError('TTK_PUBLIC_URL', `not a valid URL: ${rawPublic}`);
		}
	}

	// API keys: the secret file wins over the inline variable, and supplying
	// both is a configuration mistake worth refusing rather than resolving.
	const inlineKeys = env.TTK_API_KEYS?.trim();
	const fileKeys = options.secrets?.TTK_API_KEYS;
	if (inlineKeys !== undefined && inlineKeys !== '' && fileKeys !== undefined) {
		throw new ConfigError('TTK_API_KEYS', 'set either TTK_API_KEYS or TTK_API_KEYS_FILE, not both');
	}
	const apiKeys = fileKeys !== undefined
		// R15 (D-123): a provider reference fills the same key; a malformed value then names the reference.
		? parseApiKeys(fileKeys, env.TTK_API_KEYS_REF?.trim() ? 'TTK_API_KEYS_REF' : 'TTK_API_KEYS_FILE')
		: inlineKeys !== undefined && inlineKeys !== ''
		? parseApiKeys(inlineKeys, 'TTK_API_KEYS')
		: [];

	// C6 / D-099: the administrator seed is validated like the keys are — both forms set is refused, and a record that
	// is not valid JSON of the right shape refuses startup naming where it came from, instead of starting a server
	// nobody can sign in to. The file form covers the implicit default file `resolveSecrets` reads.
	const inlineAdmin = env.TTK_ADMIN_USER?.trim();
	const fileAdmin = options.secrets?.TTK_ADMIN_USER;
	if (inlineAdmin !== undefined && inlineAdmin !== '' && fileAdmin !== undefined) {
		throw new ConfigError('TTK_ADMIN_USER', 'set either TTK_ADMIN_USER or TTK_ADMIN_USER_FILE, not both');
	}
	let adminUser: AdminUserRecord | null = null;
	const adminUserRaw = fileAdmin ?? (inlineAdmin === '' ? undefined : inlineAdmin);
	if (adminUserRaw !== undefined) {
		const source = fileAdmin === undefined
			? 'TTK_ADMIN_USER'
			: env.TTK_ADMIN_USER_FILE?.trim()
			? 'TTK_ADMIN_USER_FILE'
			: `TTK_ADMIN_USER_FILE (default ${DEFAULT_ADMIN_USER_FILE})`;
		try {
			adminUser = readAdminUser(adminUserRaw);
		} catch (cause) {
			throw new ConfigError(source, cause instanceof Error ? cause.message : String(cause));
		}
	}

	// OAuth is entirely opt-in: an issuer switches the mode on.
	let oauth: OAuthConfig | null = null;
	const issuerRaw = env.TTK_OAUTH_ISSUER?.trim();
	if (issuerRaw !== undefined && issuerRaw !== '') {
		let issuer: URL;
		try {
			issuer = new URL(issuerRaw);
		} catch {
			throw new ConfigError('TTK_OAUTH_ISSUER', `not a valid URL: ${issuerRaw}`);
		}
		// D-083: unset, the JWKS location is read from the provider's own metadata at first use (oauth_discovery.ts).
		const jwksRaw = env.TTK_OAUTH_JWKS_URL?.trim();
		let jwksUrl: URL | null;
		try {
			jwksUrl = jwksRaw === undefined || jwksRaw === '' ? null : new URL(jwksRaw);
		} catch {
			throw new ConfigError('TTK_OAUTH_JWKS_URL', `not a valid URL: ${jwksRaw}`);
		}
		oauth = {
			issuer,
			audience: env.TTK_OAUTH_AUDIENCE?.trim() || publicUrl.href,
			jwksUrl,
		};
	}

	// Secrets: the file wins over the inline variable, and supplying both is a
	// configuration mistake worth refusing rather than resolving (as for keys).
	const inlineSecrets = env.TTK_SECRETS?.trim();
	const fileSecrets = options.secrets?.TTK_SECRETS;
	if (inlineSecrets !== undefined && inlineSecrets !== '' && fileSecrets !== undefined) {
		throw new ConfigError('TTK_SECRETS', 'set either TTK_SECRETS or TTK_SECRETS_FILE, not both');
	}
	const rawSecrets = fileSecrets ?? (inlineSecrets === '' ? undefined : inlineSecrets);
	let secrets: SecretEntry[] = [];
	let secretsSource: Config['secretsSource'] = null;
	if (rawSecrets !== undefined) {
		const source = fileSecrets === undefined
			? 'TTK_SECRETS'
			: env.TTK_SECRETS_REF?.trim()
			? 'TTK_SECRETS_REF'
			: 'TTK_SECRETS_FILE';
		try {
			secrets = parseSecrets(rawSecrets);
		} catch (cause) {
			// The message names the variable and the shape problem, never a value.
			throw new ConfigError(source, cause instanceof Error ? cause.message : String(cause));
		}
		secretsSource = source;
	}

	// D-154: the vault key. Decoded here so a malformed file refuses startup by name before anything is opened.
	const dbKeyText = options.secrets?.TTK_DB_KEY;
	const dbKey = dbKeyText === undefined ? null : decodeDbKey(dbKeyText);
	if (dbKeyText !== undefined && dbKey === null) {
		throw new ConfigError(
			'TTK_DB_KEY_FILE',
			'the key is not 32 bytes as base64url, base64 or hex (setup or doctor --new-db-key writes one)',
		);
	}

	// Clustering is switched on by naming a store; the role is meaningful only
	// then, so a role set without one is a configuration mistake worth refusing
	// rather than a setting that silently does nothing.
	const roleRaw = env.TTK_ROLE?.trim().toLowerCase() || 'all';
	if (!(NODE_ROLES as readonly string[]).includes(roleRaw)) {
		throw new ConfigError('TTK_ROLE', `expected ${NODE_ROLES.join('|')}, got ${JSON.stringify(roleRaw)}`);
	}
	const role = roleRaw as NodeRole;
	const kvPath = env.TTK_CLUSTER_KV?.trim() || '';
	if (kvPath === '' && role !== 'all') {
		throw new ConfigError('TTK_ROLE', `a role of ${role} needs TTK_CLUSTER_KV; a single node is always "all"`);
	}
	const cluster: ClusterSettings | null = kvPath === '' ? null : {
		kvPath,
		nodeId: env.TTK_NODE_ID?.trim() || `node-${crypto.randomUUID().slice(0, 8)}`,
		nodeUrl: env.TTK_NODE_URL?.trim() || '',
	};
	// C8 (D-102): a stateful transport session lives in one process's memory, while the cluster routes each request
	// to whichever node holds the *browser* session — so a 2025-era client's next request can land on a node that has
	// never heard of its `Mcp-Session-Id`. Refused at startup, where the operator can still pick one, rather than
	// left to fail per request at runtime.
	// Default on outside a cluster: a 2025-era client (pi, most hosts) hears `tools/list_changed` only on a session's
	// standalone stream, so without one it never learns that a deploy or a scope change moved its tools. Unset in a
	// cluster it resolves off; named `true` there it is refused, as before.
	const mcpStatefulSet = env.TTK_MCP_STATEFUL !== undefined && env.TTK_MCP_STATEFUL.trim() !== '';
	const mcpStateful = bool(env, 'TTK_MCP_STATEFUL', cluster === null);
	if (mcpStateful && mcpStatefulSet && cluster !== null) {
		throw new ConfigError(
			'TTK_MCP_STATEFUL',
			'the stateful transport pins a client to one process and cannot run in a cluster; ' +
				'unset TTK_MCP_STATEFUL or TTK_CLUSTER_KV',
		);
	}

	// D-150: one line per default-on switch that resolved off here, logged by `startGateway`.
	const featureNotes: string[] = [];

	// R8 (D-128): case-insensitive, like `TTK_ROLE`. `owner` is refused in a cluster: ownership lives on the node that
	// holds the session, and the cluster's default routing and its fan-out of `browser_list_sessions` are owner-blind,
	// so a forwarded or fanned-out request would be judged against a record the routing never consulted.
	// D-150: unset is `owner` on a single node — an admin still reaches every session (D-128), so the control plane
	// loses nothing — and `shared` in a cluster, where only an explicit `owner` is refused.
	const ownershipNamed = env.TTK_SESSION_OWNERSHIP?.trim().toLowerCase() ?? '';
	const ownershipRaw = ownershipNamed || (cluster === null ? 'owner' : 'shared');
	if (ownershipNamed === '' && cluster !== null) {
		featureNotes.push(
			'TTK_SESSION_OWNERSHIP is unset and resolves to shared: per-principal session ownership cannot run in a ' +
				'cluster (TTK_CLUSTER_KV), whose routing and fan-out are owner-blind',
		);
	}
	if (ownershipRaw !== 'shared' && ownershipRaw !== 'owner') {
		throw new ConfigError('TTK_SESSION_OWNERSHIP', `expected shared|owner, got ${JSON.stringify(ownershipRaw)}`);
	}
	const sessionOwnership: SessionOwnership = ownershipRaw;
	if (sessionOwnership === 'owner' && cluster !== null) {
		throw new ConfigError(
			'TTK_SESSION_OWNERSHIP',
			'per-principal session ownership cannot run in a cluster; unset TTK_SESSION_OWNERSHIP or TTK_CLUSTER_KV',
		);
	}

	const ttlSeconds = int(env, 'TTK_SESSION_TTL_S', 1800, 10, 86_400);
	// Seven days by default: a sign-in that survives a reload and a redeploy, bounded by a week (D-073).
	const loginTtlSeconds = int(env, 'TTK_LOGIN_TTL_S', 604_800, 60, 31_536_000);

	// **The writable data root must not contain anything `--allow-run` names.**
	// `TTK_DATA_DIR` is runtime-writable and now holds an operator-authored policy
	// file (B1.10); the Chromium and ffmpeg paths are things this process
	// *executes*. A data root that is an ancestor of either turns a write
	// primitive into an execute primitive, which is a different class of bug from
	// anything the overlay itself can cause. Refused at startup rather than
	// checked per write, because it is a property of the configuration.
	const dataDir = env.TTK_DATA_DIR?.trim() || null;
	if (dataDir !== null) {
		const root = normalizedPath(dataDir);
		for (
			const [variable, executable] of [
				['TTK_BROWSER_PATH', env.TTK_BROWSER_PATH?.trim() || ''],
				['TTK_FFMPEG', env.TTK_FFMPEG?.trim() || ''],
			] as const
		) {
			if (executable === '') continue;
			const target = normalizedPath(executable);
			if (target === root || target.startsWith(`${root}/`)) {
				throw new ConfigError(
					'TTK_DATA_DIR',
					`${JSON.stringify(dataDir)} contains ${variable}=${JSON.stringify(executable)}; ` +
						'the writable data root must never hold an executable this server is granted --allow-run for',
				);
			}
		}
	}

	const origins = allowedOrigins(env, host, publicUrl);

	// R10 (design §2.1, G10): signed links need a key that outlives one process — the operator's file, or one this
	// server generates under the data directory. With neither, a link could only be signed by an in-memory key that a
	// restart silently invalidates, so startup refuses instead. A cluster forwards a link to the node holding the
	// session, which verifies it again, so every node must hold the same key: only a key file can promise that.
	// G5 (design §2.7, D-140): 10–3600 s, default 3600 — the constants the signer clamps to, so the two cannot drift.
	const linkTtlSeconds = int(env, 'TTK_SIGNED_LINK_TTL_S', LINK_TTL_DEFAULT_S, LINK_TTL_MIN_S, LINK_TTL_MAX_S);
	const linkKey = options.secrets?.TTK_SIGNED_LINK_KEY ?? null;
	if (linkKey !== null && linkKey.length < 32) {
		throw new ConfigError('TTK_SIGNED_LINK_KEY_FILE', 'the key is shorter than 32 characters');
	}
	// D-150: unset is on exactly where a key can be had — the operator's file, or a generated one under a data
	// directory no other node needs to share — and off, said in a note, everywhere else. An explicit `true` keeps the
	// two refusals below, because there the operator asked for links this deployment cannot sign.
	const linksDefaulted = (env.TTK_SIGNED_LINKS?.trim() ?? '') === '';
	// D-154: a generated key is sealed in the database's vault, so it needs the vault's key as well as a data directory.
	const linkKeyAvailable = linkKey !== null || (dataDir !== null && cluster === null && dbKey !== null);
	const signedLinksOn = linksDefaulted ? linkKeyAvailable : bool(env, 'TTK_SIGNED_LINKS', false);
	if (linksDefaulted && !linkKeyAvailable) {
		featureNotes.push(
			// In a cluster a data directory would not help: a generated key is one node's, and every node verifies.
			cluster !== null
				? 'TTK_SIGNED_LINKS is unset and stays off: in a cluster every node verifies every link, so they need ' +
					'TTK_SIGNED_LINK_KEY_FILE naming one key all nodes share'
				: 'TTK_SIGNED_LINKS is unset and stays off: no signing key can be kept; set TTK_SIGNED_LINK_KEY_FILE, or ' +
					'TTK_DATA_DIR with TTK_DB_KEY_FILE for a generated one',
		);
	}
	if (signedLinksOn && linkKey === null && cluster !== null) {
		throw new ConfigError(
			'TTK_SIGNED_LINKS',
			'in a cluster every node verifies every link; set TTK_SIGNED_LINK_KEY_FILE to one key all nodes share',
		);
	}
	if (signedLinksOn && linkKey === null && (dataDir === null || dbKey === null)) {
		throw new ConfigError(
			'TTK_SIGNED_LINKS',
			'signed links need a signing key; set TTK_SIGNED_LINK_KEY_FILE, or TTK_DATA_DIR with TTK_DB_KEY_FILE for a ' +
				'generated one',
		);
	}

	const allowedDomains = list(env, 'TTK_ALLOWED_DOMAINS');
	const allowedDomainsScope = allowedDomainsScopeOf(env, allowedDomains);
	// Parsed here rather than inline below so its note joins `featureNotes` before the record is built.
	const appsConfig = mcpAppsConfig(env, origins, cluster !== null, featureNotes);

	return {
		host,
		expansion: expansionConfig(env, options.secrets ?? {}, (variable, detail) => {
			throw new ConfigError(variable, detail);
		}),
		port,
		publicUrl,
		allowedHosts: allowedHostNames(env, host, publicUrl),
		allowedOrigins: origins,
		apiKeys,
		apiKeysFile: fileKeys === undefined ? null : (env.TTK_API_KEYS_FILE?.trim() || null),
		adminUser,
		oauth,
		allowedDomains,
		allowedDomainsScope,
		// Diagnostics only: the process edge has already refused a malformed list (design §2.3).
		otelEndpoints: list(env, 'TTK_OTEL_ENDPOINTS'),
		anonScopes: anonScopes(env),
		secrets,
		secretsSource,
		dbKey,
		dataDir,
		loginTtlMs: loginTtlSeconds * 1000,
		// Recording is opt-in by naming the binary. Defaulting to a bare `ffmpeg`
		// would have the server advertise a tool whose success depends on a PATH
		// lookup it has not made — and `--allow-run` has to name the path anyway.
		ffmpeg: env.TTK_FFMPEG?.trim() || null,
		browser: {
			path: env.TTK_BROWSER_PATH?.trim() || null,
			args: browserArgs(env),
			headless: bool(env, 'TTK_HEADLESS', true),
			// D-094: the sandbox is on unless the operator turns it off by name; never set in any image.
			chromiumSandbox: !bool(env, 'TTK_CHROMIUM_NO_SANDBOX', false),
		},
		limits: {
			maxSessions: int(env, 'TTK_MAX_SESSIONS', 8, 1, 128),
			sessionTtlMs: ttlSeconds * 1000,
			memoryLimitBytes: memoryLimit(env),
			maxViewersPerSession: int(env, 'TTK_MAX_VIEWERS', 4, 1, 64),
			castQuality: int(env, 'TTK_CAST_QUALITY', 60, 1, 100),
			rateRpm: int(env, 'TTK_RATE_RPM', 120, 1, 100_000),
			maxBodyBytes: int(env, 'TTK_MAX_BODY_KB', 256, 1, 65_536) * 1024,
		},
		mcpStateful,
		cluster,
		role,
		logFormat: env.TTK_LOG_FORMAT?.trim() === 'pretty' ? 'pretty' : 'json',
		logLevel: (() => {
			const raw = env.TTK_LOG_LEVEL?.trim().toLowerCase() ?? 'info';
			if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
			throw new ConfigError('TTK_LOG_LEVEL', `expected debug|info|warn|error, got ${JSON.stringify(raw)}`);
		})(),
		metrics: bool(env, 'TTK_METRICS', false),
		// mcp-recommendations W4 (design §2.1): confirmations narrow reach and are on. D-150: the handoff is on too, by
		// the owner's decision; its URL is the configured public URL's live-view route, behind the SPA's own sign-in.
		confirmDestructive: bool(env, 'TTK_CONFIRM_DESTRUCTIVE', true),
		humanHandoff: bool(env, 'TTK_HUMAN_HANDOFF', true),
		// R15 (D-123): which providers the references name; `resolveSecrets` has already read (or refused) them.
		secretProviders: [...new Set(configuredSecretRefs(env).map((ref) => ref.provider))],
		sessionOwnership,
		// R9 (W7, D-134): MCP Apps. D-150: `control` unless named or clustered.
		mcpApps: appsConfig,
		signedLinks: signedLinksOn ? { ttlS: linkTtlSeconds, key: linkKey, defaulted: linksDefaulted } : null,
		// D-143: threaded, never parsed from `env` (the key inside must not be read through the environment).
		modelProviders: options.modelProviders ?? null,
		featureNotes,
	};
}

/**
 * Refuses to expose an unauthenticated server beyond loopback.
 *
 * Loopback with no credentials is a supported development mode (it mints an
 * anonymous principal holding TTK_ANON_SCOPES, DEFAULT_SCOPES by default), so
 * it warns loudly rather than failing.
 * See SPECS/DECISION-REGISTER.md REJ-007.
 *
 * It also catches E-32: a bind that reaches beyond loopback but has not been
 * told the name it is reached under. That combination listens everywhere and
 * answers only `127.0.0.1`, which from the client looks like a server that
 * connects and has no tools.
 */
export function checkBindPolicy(config: Config, warn: (message: string) => void): void {
	if (!isLoopbackHost(config.host)) {
		if (!reachesBeyondLoopback(config.allowedHosts)) {
			warn(
				`bound ${config.host} but the Host allowlist is loopback-only, so every request arriving ` +
					`under any other address is refused with 403 "Invalid Host" — a client reaching this ` +
					`server from another machine will connect and then list no tools. Set TTK_PUBLIC_URL to ` +
					`the URL clients actually use (e.g. http://192.168.1.10:${config.port}), or name the ` +
					`hosts explicitly in TTK_ALLOWED_HOSTS.`,
			);
		} else if (!reachesBeyondLoopback(config.allowedOrigins)) {
			// Half-configured: the API answers, the live view does not.
			warn(
				`bound ${config.host} and the Host allowlist reaches beyond loopback, but the Origin ` +
					`allowlist does not — a browser opening the live view at that address will load the ` +
					`page and then be refused on every API call. Set TTK_PUBLIC_URL, which drives both, ` +
					`or name the origin in TTK_ALLOWED_ORIGINS.`,
			);
		}
	}

	// C9 / D-099: user accounts are credentials too — the verifier already counts them, so a deployment whose only
	// credential is an account (the seed, or a non-empty readable users.json) was refused here while being perfectly
	// able to authenticate every request.
	const credentialed = config.apiKeys.length > 0 || config.oauth !== null ||
		configuredAccounts(config.dataDir, config.adminUser) > 0;
	if (credentialed) return;
	if (!isLoopbackHost(config.host)) {
		throw new ConfigError(
			'TTK_HOST',
			`refusing to bind ${config.host} with no credentials configured; ` +
				'set TTK_API_KEYS(_FILE), TTK_OAUTH_ISSUER or TTK_ADMIN_USER(_FILE), or bind 127.0.0.1',
		);
	}
	// The effective list, not "all scopes" — which stopped being true when
	// SEC-01 split the vocabulary, and a warning that misstates the grant is
	// worse than none because an operator acts on it.
	warn(
		'no credentials configured: loopback development mode is active and every request is granted ' +
			`the scopes ${config.anonScopes.join(', ') || '(none)'}. ` +
			'Set TTK_ANON_SCOPES to change them. Do not use this configuration outside a trusted machine.',
	);
}
