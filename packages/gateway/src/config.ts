/** Configuration: environment → validated {@linkcode Config}. */
import * as z from 'zod';
import { basename, dirname, resolve } from '@std/path';
import { parseMemorySize } from './browser_memory.ts';
import { parseSecrets, type SecretEntry, type SessionOwnership } from '@tykotech/mcp';
import { type ExpansionConfig, expansionConfig } from './expansion_config.ts';
import { type AdminUserRecord, readAdminUser } from './admin_auth.ts';
import { DEFAULT_ADMIN_USER_FILE } from './secrets.ts';
import { configuredSecretRefs, type SecretProviderName } from './secret_providers.ts';
import { configuredAccounts } from './users.ts';
import { LINK_TTL_DEFAULT_S, LINK_TTL_MAX_S, LINK_TTL_MIN_S } from './signed_links.ts';
import type { ModelProvidersConfig } from './model_providers.ts';
import { decodeDbKey } from './vault.ts';

// The vocabulary and its partition have exactly one owner, in the lower layer, and are re-exported here for this
// package's importers.
export { DEFAULT_SCOPES, EXPLICIT_SCOPES, type Scope, SCOPES } from '@tykotech/mcp';
import { DEFAULT_SCOPES, type Scope, SCOPES, unknownScopes } from '@tykotech/mcp';

const ScopeSchema = z.enum(SCOPES);

/** The cap on `ApiKeyRecord.label`: the secret-name cap, and a length a lock banner can show. */
export const MAX_KEY_LABEL_LENGTH = 64;

/**
 * True when a label may reach every viewer of every session: at most 64 characters, printable only — no control
 * characters, and none of `<`, `>`, `&` — so no renderer downstream has to escape it.
 */
export function isSafeKeyLabel(label: string): boolean {
	if (label.length > MAX_KEY_LABEL_LENGTH) return false;
	// A code-point walk rather than a regular expression: the characters being refused are the control ones, and a
	// regex that must *contain* them is a source file with control characters in it.
	for (const character of label) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
		if (character === '<' || character === '>' || character === '&') return false;
	}
	return true;
}

/** The longest API-key id. It becomes part of an owner (`api-key:<id>`), which the agent runtime bounds. */
const MAX_KEY_ID_LENGTH = 128;

/** True when an API-key id can name only its own owner. */
function isSafeKeyId(id: string): boolean {
	if (id.length > MAX_KEY_ID_LENGTH || /^admin:/i.test(id)) return false;
	for (const character of id) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/** One API key, stored as a hash. The raw key never exists server-side. */
const ApiKeyRecordSchema = z.object({
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

export interface Config {
	readonly expansion: ExpansionConfig;
	readonly host: string;
	readonly port: number;
	readonly publicUrl: URL;
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly apiKeys: readonly ApiKeyRecord[];
	readonly adminUser: AdminUserRecord | null;
	/** The path `TTK_API_KEYS_FILE` named, or `null` when the records came from `TTK_API_KEYS` or from nowhere. */
	readonly apiKeysFile: string | null;
	readonly allowedDomains: readonly string[];
	/**
	 * `TTK_ALLOWED_DOMAINS_SCOPE`: what the allowlist judges in the browser. `documents` (the default) judges document
	 * requests and prefetch/prerender hints; `all` judges every request a page makes.
	 */
	readonly allowedDomainsScope: 'documents' | 'all';
	/** Scopes granted to a principal that carries no credential: the stdio mount and the loopback-development mount. */
	readonly anonScopes: readonly Scope[];
	/** Server-held credentials a model may reference by name. */
	readonly secrets: readonly SecretEntry[];
	/**
	 * Where {@linkcode secrets} came from. `TTK_SECRETS` and `TTK_SECRETS_FILE` seed the database's vault once;
	 * `TTK_SECRETS_REF` (an external secret manager) stays the source and is never seeded. `null` when none is set.
	 */
	readonly secretsSource: 'TTK_SECRETS' | 'TTK_SECRETS_FILE' | 'TTK_SECRETS_REF' | null;
	/**
	 * The database vault's key, decoded from `TTK_DB_KEY_FILE` (32 bytes), or `null`. Never rendered. Without it the
	 * database still holds providers and memory, but no secret can be stored.
	 */
	readonly dbKey: Uint8Array | null;
	/** `TTK_DATA_DIR`: the root of all state kept across restarts (`ttk.db`, accounts, profiles); `null` keeps none. */
	readonly dataDir: string | null;
	/** The ffmpeg executable used for session recording; `null` disables it. */
	readonly ffmpeg: string | null;
	readonly browser: {
		readonly path: string | null;
		readonly args: readonly string[];
		readonly headless: boolean;
		/**
		 * `false` only when `TTK_CHROMIUM_NO_SANDBOX=true` — the one way to run Chromium without its sandbox.
		 * `TTK_BROWSER_ARGS` cannot reach the same result (see {@linkcode browserArgRefusal}).
		 */
		readonly chromiumSandbox: boolean;
	};
	/**
	 * How long a sign-in session (`ttks_`) lives, `TTK_LOGIN_TTL_S`. Distinct from `limits.sessionTtlMs`, which reaps
	 * idle *browser* sessions.
	 */
	readonly loginTtlMs: number;
	readonly limits: {
		readonly maxSessions: number;
		readonly sessionTtlMs: number;
		/**
		 * The container's memory limit in bytes, `TTK_MEMORY_LIMIT` (Compose fills it from the value it gives
		 * `mem_limit`); `null` when unset.
		 */
		readonly memoryLimitBytes: number | null;
		readonly maxViewersPerSession: number;
		readonly castQuality: number;
		readonly rateRpm: number;
		/**
		 * The most an `/api/v1/*` or `/a2a` request body may carry, `TTK_MAX_BODY_KB`. Enforced at the gateway's front,
		 * before anything parses the body; routes with a documented cap of their own keep it.
		 */
		readonly maxBodyBytes: number;
		/**
		 * The one disk budget the file share and the recordings share, `TTK_DISK_BUDGET_MB` (default 2048 MiB). A share
		 * write past it is refused, a recording is not started at it and is stopped when usage reaches it.
		 */
		readonly diskBudgetBytes: number;
	};
	/** Serve the 2025-era stateful transport alongside the default, `TTK_MCP_STATEFUL`. */
	readonly mcpStateful: boolean;
	/**
	 * Tool groups: on a connection that keeps one server for its whole life — stdio and a stateful 2025 session — list
	 * one `use_<group>` entry tool per group until the model opens it (`TTK_MCP_TOOL_GROUPS`, on by default).
	 */
	readonly mcpToolGroups: boolean;
	readonly logFormat: 'json' | 'pretty';
	readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
	/** `TTK_METRICS` mounts `GET /metrics` (Prometheus text) for `metrics:read` or `admin`. */
	readonly metrics: boolean;
	/**
	 * `TTK_CONFIRM_DESTRUCTIVE`, on by default — the destructive set asks a client that declared form elicitation to
	 * have its human confirm. Read by the gateway and by stdio.
	 */
	readonly confirmDestructive: boolean;
	/**
	 * `TTK_HUMAN_HANDOFF`, on by default — offers `browser_request_human`, which hands out the `TTK_PUBLIC_URL`
	 * live-view link of a session. Read by the gateway only: stdio has no public URL to hand out.
	 */
	readonly humanHandoff: boolean;
	/**
	 * The external providers `TTK_API_KEYS_REF` / `TTK_SECRETS_REF` name, for the admin diagnostics only. The values
	 * themselves arrive through `options.secrets`, resolved before this runs.
	 */
	readonly secretProviders: readonly SecretProviderName[];
	/**
	 * `TTK_SESSION_OWNERSHIP` — `owner` (the default: a session belongs to the principal that created it; `admin`
	 * reaches all) or `shared` (every `mcp:invoke` holder reaches every session).
	 */
	readonly sessionOwnership: SessionOwnership;
	/**
	 * MCP Apps — `TTK_MCP_APPS`, `TTK_MCP_APPS_ORIGINS`, `TTK_MCP_APPS_DOMAIN`. Unset, `control`;
	 * `null` (`TTK_MCP_APPS=off`) serves no `ui://` document and offers neither live-view tool.
	 */
	readonly mcpApps: McpAppsConfig | null;
	/**
	 * `TTK_SIGNED_LINKS`, with its default life and key; `null` while it is off. Unset, it is on whenever a signing key
	 * can be had.
	 */
	readonly signedLinks: SignedLinksSettings | null;
	/**
	 * One line for each default-on switch (`TTK_SIGNED_LINKS`) the operator left unset and this deployment cannot run,
	 * naming the variable and why it resolved off.
	 */
	readonly featureNotes: readonly string[];
	/**
	 * The operator's model providers, resolved from `TTK_MODEL_PROVIDERS_FILE` by the CLI and handed in through
	 * `options.modelProviders` the way file-backed secrets are — never read from `env` here.
	 */
	readonly modelProviders: ModelProvidersConfig | null;
}

/** `TTK_SIGNED_LINKS=true`, parsed. */
export interface SignedLinksSettings {
	/**
	 * `TTK_SIGNED_LINK_TTL_S`: a link's life when the caller names none, {@linkcode LINK_TTL_MIN_S}– {@linkcode
	 * LINK_TTL_MAX_S} s, default {@linkcode LINK_TTL_DEFAULT_S} (10–3600, default 3600).
	 */
	readonly ttlS: number;
	/** The contents of `TTK_SIGNED_LINK_KEY_FILE`, or `null` for the generated data-directory key. */
	readonly key: string | null;
	/**
	 * True when `TTK_SIGNED_LINKS` was unset and this is its default. A defaulted switch whose key cannot be read or
	 * created at startup resolves off with a warning; an explicit `true` keeps refusing startup.
	 */
	readonly defaulted: boolean;
}

/** The MCP Apps deployment as `loadConfig` validated it. */
export interface McpAppsConfig {
	/** The ceiling: `watch` mints watch tickets only; `control` also lets an embed take control on a click. */
	readonly mode: 'watch' | 'control';
	/**
	 * Full host origins an embed ticket may be bound to; every hostname is already in `TTK_ALLOWED_ORIGINS`. Empty
	 * means any {@linkcode isAppsOrigin} origin whose hostname the caller's effective allowed origins admit.
	 */
	readonly origins: readonly string[];
	/** `_meta.ui.domain`, passed through to the host verbatim; `null` when unset. */
	readonly domain: string | null;
	/**
	 * True when `TTK_MCP_APPS` was unset and `control` is its default. A defaulted switch whose embed documents are
	 * missing from the build resolves off with a warning; an explicit mode keeps refusing startup.
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
	'TTK_AGENT_PEERS_FILE',
	// Agent task bounds and the A2A push host allowlist.
	'TTK_AGENT_TASK_TIMEOUT_S',
	'TTK_AGENT_TASK_RETENTION_S',
	'TTK_A2A_PUSH_ALLOWED_HOSTS',
	'TTK_HOST',
	'TTK_PORT',
	'TTK_PUBLIC_URL',
	'TTK_ALLOWED_HOSTS',
	'TTK_A2UI_ACTIONS',
	'TTK_ALLOWED_ORIGINS',
	'TTK_API_KEYS',
	'TTK_API_KEYS_FILE',
	'TTK_ADMIN_USER',
	'TTK_ADMIN_USER_FILE',
	'TTK_ALLOWED_DOMAINS',
	'TTK_ANON_SCOPES',
	'TTK_SECRETS',
	'TTK_SECRETS_FILE',
	'TTK_DATA_DIR',
	'TTK_FFMPEG',
	'TTK_DISK_BUDGET_MB',
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
	'TTK_MCP_TOOL_GROUPS',
	'TTK_METRICS',
	'TTK_LOG_FORMAT',
	'TTK_LOG_LEVEL',
	'TTK_HUMAN_HANDOFF',
	'TTK_SESSION_OWNERSHIP',
	'TTK_CONFIRM_DESTRUCTIVE',
	'TTK_SIGNED_LINKS',
	'TTK_SIGNED_LINK_TTL_S',
	'TTK_SIGNED_LINK_KEY_FILE',
	'TTK_DB_KEY_FILE',
	'TTK_MCP_APPS',
	'TTK_MCP_APPS_ORIGINS',
	'TTK_MCP_APPS_DOMAIN',
	'TTK_API_KEYS_REF',
	'TTK_SECRETS_REF',
	'TTK_VAULT_ADDR',
	'TTK_OP_CONNECT_URL',
	'TTK_VAULT_TOKEN_FILE',
	'TTK_OP_CONNECT_TOKEN_FILE',
	'TTK_VAULT_NAMESPACE',
	'TTK_SECRET_PROVIDER_CA_FILE',
	'TTK_ALLOWED_DOMAINS_SCOPE', // `documents` | `all`
	// The providers file. Threaded like `TTK_SECRETS_FILE` — the CLI reads it and passes the result in
	// `LoadConfigOptions.modelProviders`; `loadConfig` never reads it from `env`.
	'TTK_MODEL_PROVIDERS_FILE',
] as const;

// --- helpers ---------------------------------------------------------------

function list(env: Env, name: string): string[] {
	const raw = env[name];
	if (raw === undefined || raw.trim() === '') return [];
	return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/** The scopes a credential-less principal receives. */
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

/** `TTK_ALLOWED_DOMAINS_SCOPE`: `documents` (default) or `all`, trimmed and case-insensitive. */
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

// --- TTK_BROWSER_ARGS: the refusal list -------------------------------------

/** Chromium switches that weaken or remove the sandbox the product's job depends on. */
const SANDBOX_WEAKENING_SWITCHES: ReadonlySet<string> = new Set([
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--no-zygote',
	'--single-process',
	'--disable-seccomp-filter-sandbox',
	'--disable-namespace-sandbox',
	'--disable-gpu-sandbox',
	// Runs the GPU process as a thread of the unsandboxed browser process — the GPU analogue of `--single-process`,
	// with the effect of `--disable-gpu-sandbox`, and the copy-paste cure for headless GPU trouble in a container that
	// this list exists to catch.
	'--in-process-gpu',
]);

/** Switches the browser launcher owns. */
const LAUNCHER_OWNED_SWITCHES: ReadonlySet<string> = new Set([
	'--remote-debugging-port',
	'--remote-debugging-pipe',
	'--remote-debugging-address',
	'--remote-allow-origins',
	'--user-data-dir',
]);

/**
 * Switches that make Chromium execute another program: a wrapper around every renderer, utility or GPU process, or a
 * different helper binary. Every `*-cmd-prefix` and `*-launcher` switch is refused as well.
 */
const COMMAND_SWITCHES: ReadonlySet<string> = new Set([
	'--renderer-cmd-prefix',
	'--utility-cmd-prefix',
	'--gpu-launcher',
	'--browser-subprocess-path',
]);

/**
 * Switches that take down the isolation between sites, or between a page and the browser, that a hostile page would
 * otherwise have to break: site isolation itself, the same-origin policy, `file://` reach, and unpacked extensions — an
 * extension loaded from disk can be granted `debugger` and `nativeMessaging`, which is the browser's whole control
 * surface and a way out to a host program.
 */
const ISOLATION_WEAKENING_SWITCHES: ReadonlySet<string> = new Set([
	'--disable-site-isolation-trials',
	'--disable-web-security',
	'--allow-file-access-from-files',
	'--allow-file-access',
	'--load-extension',
	'--disable-extensions-except',
]);

/**
 * `--disable-features` values that switch site isolation off — `site-per-process` and `IsolateOrigins` as the switches
 * spell them, `SitePerProcess` as the feature does, and any `*SiteIsolation*` feature, matched without case, dashes or
 * underscores so a respelling is caught.
 */
const ISOLATION_FEATURE = /^(?:siteperprocess|isolateorigins|.*siteisolation.*)$/;

/**
 * `--js-flags` values V8 must never receive from configuration: anything about its sandbox (the V8 heap sandbox is a
 * second wall behind Chromium's), and `--allow-natives-syntax`, which hands page script V8's internal `%` functions — a
 * memory-corruption toolkit.
 */
const REFUSED_JS_FLAG = /sandbox|allow[-_]natives[-_]syntax/i;

/** A switch name as Chromium reads one: `--`, then a name with no `=`, whitespace or other punctuation. */
const SWITCH_NAME = /^--[a-z0-9][a-z0-9._-]*$/;

/** Why one `TTK_BROWSER_ARGS` entry is refused, or `null` when it may reach the launcher. */
function browserArgRefusal(entry: string): string | null {
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
		const isolation = entry.slice(equals + 1).split(/[,\s]+/).find((feature) =>
			ISOLATION_FEATURE.test(feature.toLowerCase().replace(/[-_]/g, ''))
		);
		if (isolation !== undefined) {
			return `--disable-features names ${isolation.slice(0, 64)}, which turns off site isolation and is refused`;
		}
	}
	if (ISOLATION_WEAKENING_SWITCHES.has(name)) {
		return `${name} weakens the isolation between sites or between a page and the browser, and is refused`;
	}
	// The value names no flag in the refusal: it may carry other V8 flags the operator chose.
	if (name === '--js-flags' && equals >= 0 && REFUSED_JS_FLAG.test(entry.slice(equals + 1))) {
		return '--js-flags carries a V8 sandbox or natives-syntax flag, which is refused';
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

/** `TTK_BROWSER_ARGS`, refused at parse time when any entry is on the list. */
function browserArgs(env: Env): string[] {
	const args = list(env, 'TTK_BROWSER_ARGS');
	for (const entry of args) {
		const refusal = browserArgRefusal(entry);
		if (refusal !== null) throw new ConfigError('TTK_BROWSER_ARGS', refusal);
	}
	return args;
}

/** Browser origins permitted to call the API. */
function allowedOrigins(env: Env, host: string, publicUrl: URL): string[] {
	const configured = list(env, 'TTK_ALLOWED_ORIGINS');
	if (configured.length > 0) {
		// **A startup refusal, not a warning.** The adapter compares `new URL(origin).hostname` against these entries
		// *verbatim* (`validateOriginHeader`, `@modelcontextprotocol/server` 2.0.0), so an entry carrying a scheme or a
		// port — `https://app.example:3000`, which is exactly what an operator copies out of a browser's address bar —
		// matches nothing at all, silently, and the live view is refused on every call with a 403 the operator has no
		// way to trace back to this list.
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
	// A loopback bind answers to all three spellings, and a browser will use whichever one the operator typed.
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
 */
export function isAppsOrigin(entry: string): boolean {
	return appsOriginFault(entry) === null;
}

/** One `TTK_MCP_APPS_ORIGINS` entry, by {@linkcode isAppsOrigin}. */
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

/** MCP Apps, refused at startup rather than at the first embed. */
function mcpAppsConfig(env: Env, allowedOrigins: readonly string[]): McpAppsConfig | null {
	const named = env.TTK_MCP_APPS?.trim().toLowerCase() ?? '';
	const defaulted = named === '';
	const raw = defaulted ? 'control' : named;
	if (raw !== 'off' && raw !== 'watch' && raw !== 'control') {
		throw new ConfigError('TTK_MCP_APPS', `expected off|watch|control, got ${JSON.stringify(env.TTK_MCP_APPS)}`);
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
	// No origins is not a refusal.
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

/** One path in a form two paths can be compared in. */
function normalizedPath(value: string): string {
	const slashes = value.trim().replaceAll('\\', '/');
	const collapsed = slashes.replace(/\/+/g, '/');
	return collapsed.endsWith('/') && collapsed.length > 1 ? collapsed.slice(0, -1) : collapsed;
}

/**
 * `path` as the filesystem resolves it, for a containment check: the real path of its deepest existing ancestor
 * (symlinks and `..` resolved) with the missing remainder appended, normalised by {@linkcode normalizedPath} and
 * lower-cased on Windows, whose paths compare without case.
 */
function canonicalPath(path: string): string {
	let absolute = normalizedPath(path);
	try {
		absolute = normalizedPath(resolve(path));
	} catch { /* no working directory to resolve against: compare lexically */ }
	const missing: string[] = [];
	let probe = absolute;
	for (;;) {
		try {
			const real = normalizedPath(Deno.realPathSync(probe));
			absolute = missing.length === 0 ? real : `${real === '/' ? '' : real}/${missing.reverse().join('/')}`;
			break;
		} catch {
			const parent = dirname(probe);
			if (parent === probe) break;
			missing.push(basename(probe));
			probe = parent;
		}
	}
	return Deno.build.os === 'windows' ? absolute.toLowerCase() : absolute;
}

/** Whether `inner` is `outer` or below it, for paths from {@linkcode canonicalPath}. */
function pathWithin(inner: string, outer: string): boolean {
	return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`);
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
 * Whether an allowlist holds any name a client on another machine could actually present. A wildcard counts for no more
 * than a loopback spelling does: `0.0.0.0` is a bind address, and no client ever sends it.
 */
function reachesBeyondLoopback(names: readonly string[]): boolean {
	return names.some((entry) => {
		const bare = entry.replace(/^\[|\]$/g, '');
		return !isLoopbackHost(bare) && !isWildcardHost(bare);
	});
}

/** Host header values the server answers to — the DNS-rebinding guard. */
function allowedHostNames(env: Env, host: string, publicUrl: URL): string[] {
	const names = new Set<string>();
	const add = (entry: string) => {
		const name = bareHostname(entry);
		// A wildcard is a bind address, never a name a client sends — and with `TTK_PUBLIC_URL` unset the public URL is
		// derived from the bind, so dropping it here is what leaves `checkBindPolicy` a case to warn on.
		if (name !== '' && !isWildcardHost(name)) names.add(name);
	};

	const configured = list(env, 'TTK_ALLOWED_HOSTS');
	if (configured.length > 0) {
		configured.forEach(add);
		return [...names];
	}

	add(publicUrl.hostname);
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

/** An allowlist entry reduced to the bare hostname the SDK will compare against. */
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
 * All a refusal of a secret-bearing value that is not JSON may say — a fixed phrase, and the position of the fault when
 * the parser reports one.
 */
function jsonFault(cause: unknown): string {
	const at = cause instanceof SyntaxError ? /\bat position (\d+)\b/.exec(cause.message)?.[1] : undefined;
	return at === undefined ? 'not valid JSON' : `not valid JSON at position ${at}`;
}

/** Parses a key file or `TTK_API_KEYS` value into records. */
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
		// The label reaches every viewer of every session as `holder_name`, watch-only viewers included. Refused at
		// startup rather than sanitised at render.
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
	/** The providers file, already read and resolved (`loadModelProviders`); absent or `null` means none. */
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

	// API keys: the secret file wins over the inline variable, and supplying both is a configuration mistake worth
	// refusing rather than resolving.
	const inlineKeys = env.TTK_API_KEYS?.trim();
	const fileKeys = options.secrets?.TTK_API_KEYS;
	if (inlineKeys !== undefined && inlineKeys !== '' && fileKeys !== undefined) {
		throw new ConfigError('TTK_API_KEYS', 'set either TTK_API_KEYS or TTK_API_KEYS_FILE, not both');
	}
	const apiKeys = fileKeys !== undefined
		// A provider reference fills the same key; a malformed value then names the reference.
		? parseApiKeys(fileKeys, env.TTK_API_KEYS_REF?.trim() ? 'TTK_API_KEYS_REF' : 'TTK_API_KEYS_FILE')
		: inlineKeys !== undefined && inlineKeys !== ''
		? parseApiKeys(inlineKeys, 'TTK_API_KEYS')
		: [];

	// The administrator seed is validated like the keys are — both forms set is refused, and a record that is not valid
	// JSON of the right shape refuses startup naming where it came from, instead of starting a server nobody can sign
	// in to.
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

	// Secrets: the file wins over the inline variable, and supplying both is a configuration mistake worth refusing
	// rather than resolving (as for keys).
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

	// The vault key. Decoded here so a malformed file refuses startup by name before anything is opened.
	const dbKeyText = options.secrets?.TTK_DB_KEY;
	const dbKey = dbKeyText === undefined ? null : decodeDbKey(dbKeyText);
	if (dbKeyText !== undefined && dbKey === null) {
		throw new ConfigError(
			'TTK_DB_KEY_FILE',
			'the key is not 32 bytes as base64url, base64 or hex (setup or doctor --new-db-key writes one)',
		);
	}

	// On by default: a 2025-era client (pi, most hosts) hears `tools/list_changed` only on a session's standalone
	// stream, so without one it never learns that a deploy or a scope change moved its tools.
	const mcpStateful = bool(env, 'TTK_MCP_STATEFUL', true);
	const mcpToolGroups = bool(env, 'TTK_MCP_TOOL_GROUPS', true);

	// One line per default-on switch that resolved off here, logged by `startGateway`.
	const featureNotes: string[] = [];

	// Case-insensitive. Unset is `owner` — an admin still reaches every session, so the control plane loses nothing.
	const ownershipRaw = env.TTK_SESSION_OWNERSHIP?.trim().toLowerCase() || 'owner';
	if (ownershipRaw !== 'shared' && ownershipRaw !== 'owner') {
		throw new ConfigError('TTK_SESSION_OWNERSHIP', `expected shared|owner, got ${JSON.stringify(ownershipRaw)}`);
	}
	const sessionOwnership: SessionOwnership = ownershipRaw;

	const ttlSeconds = int(env, 'TTK_SESSION_TTL_S', 1800, 10, 86_400);
	// Seven days by default: a sign-in that survives a reload and a redeploy, bounded by a week.
	const loginTtlSeconds = int(env, 'TTK_LOGIN_TTL_S', 604_800, 60, 31_536_000);

	// **The writable data root must not contain anything `--allow-run` names.** `TTK_DATA_DIR` is runtime-writable;
	// the Chromium and ffmpeg paths are things this process *executes*.
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
		// The vault key must never sit under the data root.
		const dbKeyPath = env.TTK_DB_KEY_FILE?.trim() || '';
		if (dbKeyPath !== '' && pathWithin(canonicalPath(dbKeyPath), canonicalPath(dataDir))) {
			throw new ConfigError(
				'TTK_DB_KEY_FILE',
				`the key file is inside TTK_DATA_DIR (${JSON.stringify(dataDir)}); keep it off the data volume, or a ` +
					'copy of the volume opens every secret sealed in ttk.db',
			);
		}
	}

	const origins = allowedOrigins(env, host, publicUrl);

	// Signed links need a key that outlives one process — the operator's file, or one this server generates under the
	// data directory.
	const linkTtlSeconds = int(env, 'TTK_SIGNED_LINK_TTL_S', LINK_TTL_DEFAULT_S, LINK_TTL_MIN_S, LINK_TTL_MAX_S);
	const linkKey = options.secrets?.TTK_SIGNED_LINK_KEY ?? null;
	if (linkKey !== null && linkKey.length < 32) {
		throw new ConfigError('TTK_SIGNED_LINK_KEY_FILE', 'the key is shorter than 32 characters');
	}
	// Unset is on exactly where a key can be had — the operator's file, or a generated one under the data directory —
	// and off, said in a note, everywhere else.
	const linksDefaulted = (env.TTK_SIGNED_LINKS?.trim() ?? '') === '';
	// A generated key is sealed in the database's vault, so it needs the vault's key as well as a data directory.
	const linkKeyAvailable = linkKey !== null || (dataDir !== null && dbKey !== null);
	const signedLinksOn = linksDefaulted ? linkKeyAvailable : bool(env, 'TTK_SIGNED_LINKS', false);
	if (linksDefaulted && !linkKeyAvailable) {
		featureNotes.push(
			'TTK_SIGNED_LINKS is unset and stays off: no signing key can be kept; set TTK_SIGNED_LINK_KEY_FILE, or ' +
				'TTK_DATA_DIR with TTK_DB_KEY_FILE for a generated one',
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
	const appsConfig = mcpAppsConfig(env, origins);

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
		allowedDomains,
		allowedDomainsScope,
		anonScopes: anonScopes(env),
		secrets,
		secretsSource,
		dbKey,
		dataDir,
		loginTtlMs: loginTtlSeconds * 1000,
		// Recording is opt-in by naming the binary. Defaulting to a bare `ffmpeg` would have the server advertise a
		// tool whose success depends on a PATH lookup it has not made — and `--allow-run` has to name the path anyway.
		ffmpeg: env.TTK_FFMPEG?.trim() || null,
		browser: {
			path: env.TTK_BROWSER_PATH?.trim() || null,
			args: browserArgs(env),
			headless: bool(env, 'TTK_HEADLESS', true),
			// The sandbox is on unless the operator turns it off by name; never set in any image.
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
			// 64 MiB at least, one upload's worth (the REST cap); 1 TiB at most, well past any one volume.
			diskBudgetBytes: int(env, 'TTK_DISK_BUDGET_MB', 2048, 64, 1_048_576) * 1024 * 1024,
		},
		mcpStateful,
		mcpToolGroups,
		logFormat: env.TTK_LOG_FORMAT?.trim() === 'pretty' ? 'pretty' : 'json',
		logLevel: (() => {
			const raw = env.TTK_LOG_LEVEL?.trim().toLowerCase() ?? 'info';
			if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
			throw new ConfigError('TTK_LOG_LEVEL', `expected debug|info|warn|error, got ${JSON.stringify(raw)}`);
		})(),
		metrics: bool(env, 'TTK_METRICS', false),
		// Confirmations narrow reach and are on. The handoff is on too; its URL is the configured public URL's
		// live-view route, behind the SPA's own sign-in.
		confirmDestructive: bool(env, 'TTK_CONFIRM_DESTRUCTIVE', true),
		humanHandoff: bool(env, 'TTK_HUMAN_HANDOFF', true),
		// Which providers the references name; `resolveSecrets` has already read (or refused) them.
		secretProviders: [...new Set(configuredSecretRefs(env).map((ref) => ref.provider))],
		sessionOwnership,
		// MCP Apps: `control` unless named.
		mcpApps: appsConfig,
		signedLinks: signedLinksOn ? { ttlS: linkTtlSeconds, key: linkKey, defaulted: linksDefaulted } : null,
		// Threaded, never parsed from `env` (the key inside must not be read through the environment).
		modelProviders: options.modelProviders ?? null,
		featureNotes,
	};
}

/** Refuses to expose an unauthenticated server beyond loopback. */
export function checkBindPolicy(config: Config, warn: (message: string) => void): void {
	if (!isLoopbackHost(config.host)) {
		if (!reachesBeyondLoopback(config.allowedHosts)) {
			warn(
				`bound ${config.host} but the Host allowlist is loopback-only, so every request arriving ` +
					`under any other address is refused with 400 host-forbidden — a client reaching this ` +
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

	// User accounts are credentials too — the verifier counts them, so a deployment whose only credential is an account
	// (the seed, or a non-empty readable users.json) can authenticate every request and is not refused.
	const credentialed = config.apiKeys.length > 0 ||
		configuredAccounts(config.dataDir, config.adminUser) > 0;
	if (credentialed) return;
	if (!isLoopbackHost(config.host)) {
		throw new ConfigError(
			'TTK_HOST',
			`refusing to bind ${config.host} with no credentials configured; ` +
				'set TTK_API_KEYS(_FILE) or TTK_ADMIN_USER(_FILE), or bind 127.0.0.1',
		);
	}
	// The effective list, not "all scopes": a warning that misstates the grant is worse than none because an operator
	// acts on it.
	warn(
		'no credentials configured: loopback development mode is active and every request is granted ' +
			`the scopes ${config.anonScopes.join(', ') || '(none)'}. ` +
			'Set TTK_ANON_SCOPES to change them. Do not use this configuration outside a trusted machine.',
	);
}
