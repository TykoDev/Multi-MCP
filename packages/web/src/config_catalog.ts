/**
 * The settings catalogue (run model-providers-ui, frontend §2(a)): one entry per variable the server, the sandbox
 * service or Compose reads, as `docs/reference/environment-variables.md` documents them — that page is the source of
 * truth, and `config_catalog_test.ts` reads it to hold this table to it. Pure data and pure readers, no DOM: the
 * System screen's Configuration panel draws its rows from here, and the configuration composer builds its form and
 * its outputs from here.
 *
 * Three things an entry says that the composer and the panel lean on:
 * - `secret` marks a variable whose *inline value* is a secret (`TTK_API_KEYS`, `TTK_SECRETS`, `TTK_ADMIN_USER`): it
 *   has no form field, and no generator ever emits it. A `secret-file` entry holds a *path* to a file; the path is
 *   shown and emitted, the file's content never is (the row carries the text tag "file-backed").
 * - `reach` names the rule under which a value widens what the deployment can reach or who can reach it; the panel
 *   and the diff tag such values "widens reach".
 * - `diagnosticsKey` maps the entry to a fact the diagnostics document reports; a `read` turns that fact into words
 *   for the panel and, when the fact is the variable's own value, into the value the composer seeds from. An entry
 *   whose fact the gateway does not report reads "not reported" — never a guess (`system_facts.ts`).
 */
import type { JsonSchema } from './mcp.ts';
import { diagnosticsKey, FACT_NOT_REPORTED, featureState, shortWord } from './system_facts.ts';

export type SettingKind = 'enum' | 'boolean' | 'integer' | 'list' | 'text' | 'path' | 'secret-file';

/** The sections of the reference page, in its order; `compose` is read by Compose, `sandbox-service` by the sandbox. */
export type SettingSection =
	| 'network'
	| 'auth'
	| 'secret-providers'
	| 'browser'
	| 'storage'
	| 'signed-links'
	| 'live-view'
	| 'mcp-apps'
	| 'limits'
	| 'logging'
	| 'cluster'
	| 'sandbox'
	| 'sandbox-service'
	| 'agents'
	| 'otel'
	| 'compose';

/** A section's heading word(s). */
export const SECTION_WORDS: Readonly<Record<SettingSection, string>> = {
	network: 'Reachability',
	auth: 'Authentication',
	'secret-providers': 'Secret providers',
	browser: 'Browser',
	storage: 'Storage and recording',
	'signed-links': 'Signed links',
	'live-view': 'Live view',
	'mcp-apps': 'MCP Apps',
	limits: 'Limits and transport',
	logging: 'Logging',
	cluster: 'Cluster',
	sandbox: 'Coding sandbox',
	'sandbox-service': 'Sandbox service',
	agents: 'Agents',
	otel: 'OpenTelemetry',
	compose: 'Compose',
};

export const SECTIONS: readonly SettingSection[] = Object.keys(SECTION_WORDS) as SettingSection[];

/**
 * When a value widens reach: `always` once set; `non-loopback` when it names an address off the host; `on` when it
 * is a true boolean; `not-off` when it is a word other than `off`; `docker` when it is that backend.
 */
export type ReachRule = 'always' | 'non-loopback' | 'on' | 'not-off' | 'docker';

/** What a reported fact says about a setting: words for the panel, and the variable's value when the fact is it. */
export interface Reading {
	readonly text: string;
	/** Present only when the fact *is* the variable's value, spelled as the environment would carry it. */
	readonly value?: string;
	/** For a fact that only says whether the variable is in use: true when it is set. */
	readonly set?: boolean;
}

export interface Setting {
	readonly name: string;
	readonly section: SettingSection;
	readonly kind: SettingKind;
	/** The default, in words, as the reference page states it. */
	readonly default: string;
	/** The allowed words of an `enum`. */
	readonly values?: readonly string[];
	/** The allowed range of an `integer`. */
	readonly range?: readonly [number, number];
	/** One sentence. */
	readonly explain: string;
	readonly reach?: ReachRule;
	/** The inline value is a secret: never a form field, never emitted. */
	readonly secret?: true;
	/** The default is computed from other settings, so an unset variable reads "derived", not "default". */
	readonly derived?: true;
	/** The diagnostics key that reports this setting, read defensively. */
	readonly diagnosticsKey?: string;
	/** How the reported fact reads; the default reader takes strings, numbers, booleans and string lists. */
	readonly read?: (raw: unknown) => Reading | undefined;
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/** A boolean environment value, or `undefined` for anything else. */
export function booleanOf(value: string | undefined): boolean | undefined {
	const word = value?.trim().toLowerCase() ?? '';
	return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : undefined;
}

/** True when a host names the machine itself. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
	return bare === 'localhost' || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare);
}

/** The hostname of a URL or a bare `host[:port]`, lower-cased; `''` when there is none. */
function hostOf(value: string): string {
	const trimmed = value.trim();
	if (trimmed === '') return '';
	const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
	return url?.hostname.toLowerCase() ?? '';
}

// --- readers ---------------------------------------------------------------------------------------------------

/** A fact that is the setting's own value. */
function same(raw: unknown): Reading | undefined {
	if (typeof raw === 'string') return { text: raw === '' ? '—' : raw, value: raw };
	if (typeof raw === 'number' || typeof raw === 'boolean') return { text: String(raw), value: String(raw) };
	if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
		const joined = (raw as string[]).join(',');
		return { text: raw.length === 0 ? '—' : joined, value: joined };
	}
	return undefined;
}

/** A fact that says only whether the setting is in use. */
function presence(yes: string, no: string): (raw: unknown) => Reading | undefined {
	return (raw) => typeof raw === 'boolean' ? { text: raw ? yes : no, set: raw } : undefined;
}

/** An opt-in feature's fact (boolean, word or object), as the boolean the variable takes. */
function feature(raw: unknown): Reading | undefined {
	const state = featureState(raw, 'true', 'false');
	if ('unknown' in state) return undefined;
	const value = state.on ? 'true' : 'false';
	return { text: state.detail === undefined ? value : `${value} (${state.detail})`, value };
}

/** A fact that is a short word, such as a mode. */
function word(raw: unknown): Reading | undefined {
	const text = shortWord(raw) ??
		(typeof raw === 'object' && raw !== null ? shortWord((raw as Record<string, unknown>).mode) : undefined);
	return text === undefined ? undefined : { text, value: text };
}

const S = (setting: Setting): Setting => setting;

/**
 * The catalogue, in the reference page's order. `explain` is one sentence; the page carries the rest.
 */
export const SETTINGS: readonly Setting[] = [
	// Network and reachability
	S({
		name: 'TTK_HOST',
		section: 'network',
		kind: 'text',
		default: '127.0.0.1',
		explain: 'Bind address; a non-loopback bind needs API keys, OAuth or a user account.',
		reach: 'non-loopback',
		diagnosticsKey: 'host',
	}),
	S({
		name: 'TTK_PORT',
		section: 'network',
		kind: 'integer',
		default: '8787',
		range: [0, 65535],
		explain: 'Bind port; 0 picks a free port.',
		diagnosticsKey: 'port',
	}),
	S({
		name: 'TTK_PUBLIC_URL',
		section: 'network',
		kind: 'text',
		default: 'http://127.0.0.1:<port> on loopback, else http://<host>:<port>',
		explain: 'The URL clients use; it seeds the Host and Origin allowlists and the OAuth audience.',
		reach: 'non-loopback',
		derived: true,
		diagnosticsKey: 'publicUrl',
	}),
	S({
		name: 'TTK_ALLOWED_HOSTS',
		section: 'network',
		kind: 'list',
		default: 'derived from the public URL and the bind',
		explain: 'Host header allowlist (DNS-rebinding guard); setting it replaces the derived list.',
		reach: 'always',
		derived: true,
	}),
	S({
		name: 'TTK_ALLOWED_ORIGINS',
		section: 'network',
		kind: 'list',
		default: 'derived from the public URL',
		explain: 'Browser Origin allowlist as bare hostnames; setting it replaces the derived list.',
		reach: 'always',
		derived: true,
		diagnosticsKey: 'allowedOrigins',
		read: (raw) => {
			const reading = same(raw);
			return reading === undefined ? undefined : reading.value === '' ? { text: 'derived' } : reading;
		},
	}),
	// Authentication
	S({
		name: 'TTK_API_KEYS',
		section: 'auth',
		kind: 'text',
		default: 'none',
		explain: 'Inline JSON array of hashed key records; prefer the file form.',
		secret: true,
	}),
	S({
		name: 'TTK_API_KEYS_FILE',
		section: 'auth',
		kind: 'secret-file',
		default: 'none',
		explain: 'File holding the hashed key records; watched and reloaded on change.',
		diagnosticsKey: 'apiKeysCount',
		read: (raw) =>
			typeof raw === 'number'
				? { text: raw === 0 ? 'none' : raw === 1 ? '1 key' : `${raw} keys`, set: raw > 0 }
				: undefined,
	}),
	S({
		name: 'TTK_ADMIN_USER',
		section: 'auth',
		kind: 'text',
		default: 'none',
		explain: 'Inline PBKDF2 account record that seeds the user store; prefer the file form.',
		secret: true,
	}),
	S({
		name: 'TTK_ADMIN_USER_FILE',
		section: 'auth',
		kind: 'secret-file',
		default: 'none; secrets/ttk_admin_user.json is tried',
		explain: 'File holding the account record that seeds the user store on first start.',
		diagnosticsKey: 'hasAdminUser',
		read: presence('configured', 'not set'),
	}),
	S({
		name: 'TTK_LOGIN_TTL_S',
		section: 'auth',
		kind: 'integer',
		default: '604800',
		range: [60, 31_536_000],
		explain: 'Lifetime of sign-in sessions, in seconds.',
	}),
	S({
		name: 'TTK_ANON_SCOPES',
		section: 'auth',
		kind: 'list',
		default: 'the default grant',
		explain: 'Scopes for credential-less principals (loopback development, stdio); set but empty means none.',
	}),
	S({
		name: 'TTK_OAUTH_ISSUER',
		section: 'auth',
		kind: 'text',
		default: 'none (OAuth off)',
		explain: 'Issuer URL; enables OAuth 2.1 resource-server mode.',
		diagnosticsKey: 'oauthEnabled',
		read: presence('enabled', 'off'),
	}),
	S({
		name: 'TTK_OAUTH_AUDIENCE',
		section: 'auth',
		kind: 'text',
		default: 'TTK_PUBLIC_URL',
		explain: 'Expected aud claim.',
		derived: true,
	}),
	S({
		name: 'TTK_OAUTH_JWKS_URL',
		section: 'auth',
		kind: 'text',
		default: 'discovered',
		explain: 'JWKS location.',
		derived: true,
	}),
	S({
		name: 'TTK_API_KEYS_REF',
		section: 'auth',
		kind: 'text',
		default: 'none',
		explain: 'Read the key records once at startup from a secret provider (vault: or op: reference).',
		diagnosticsKey: 'secretProvider',
		read: (raw) => {
			const state = featureState(raw, 'configured', 'none');
			if ('unknown' in state) return undefined;
			return { text: state.on ? (state.detail === undefined ? 'configured' : state.detail) : 'none', set: state.on };
		},
	}),
	S({
		name: 'TTK_SECRETS_REF',
		section: 'auth',
		kind: 'text',
		default: 'none',
		explain: 'Read the browser secrets once at startup from a secret provider.',
	}),
	// Secret providers
	S({
		name: 'TTK_VAULT_ADDR',
		section: 'secret-providers',
		kind: 'text',
		default: 'none',
		explain: 'Vault address for vault: references.',
	}),
	S({
		name: 'TTK_VAULT_TOKEN_FILE',
		section: 'secret-providers',
		kind: 'secret-file',
		default: 'none',
		explain: 'File holding the Vault token.',
	}),
	S({
		name: 'TTK_VAULT_NAMESPACE',
		section: 'secret-providers',
		kind: 'text',
		default: 'none',
		explain: 'Vault Enterprise namespace.',
	}),
	S({
		name: 'TTK_OP_CONNECT_URL',
		section: 'secret-providers',
		kind: 'text',
		default: 'none',
		explain: 'The 1Password Connect server address for op: references.',
	}),
	S({
		name: 'TTK_OP_CONNECT_TOKEN_FILE',
		section: 'secret-providers',
		kind: 'secret-file',
		default: 'none',
		explain: 'File holding the Connect token.',
	}),
	S({
		name: 'TTK_SECRET_PROVIDER_CA_FILE',
		section: 'secret-providers',
		kind: 'path',
		default: 'none',
		explain: 'PEM file with the certificate authority that signed the provider certificate.',
	}),
	// Browser
	S({
		name: 'TTK_ALLOWED_DOMAINS',
		section: 'browser',
		kind: 'list',
		default: 'empty (unrestricted)',
		explain: 'Navigation allowlist: a host matches itself and its subdomains.',
		diagnosticsKey: 'allowedDomains',
	}),
	S({
		name: 'TTK_ALLOWED_DOMAINS_SCOPE',
		section: 'browser',
		kind: 'enum',
		default: 'documents',
		values: ['documents', 'all'],
		explain: 'What Chromium judges against the allowlist: document requests only, or every request.',
		diagnosticsKey: 'allowedDomainsScope',
		read: word,
	}),
	S({
		name: 'TTK_SESSION_OWNERSHIP',
		section: 'browser',
		kind: 'enum',
		// D-150: `owner` on a single node, `shared` in a cluster (whose routing is owner-blind).
		default: 'owner (shared in a cluster)',
		values: ['shared', 'owner'],
		explain: 'Whether sessions are shared among mcp:invoke holders or bound to their creator.',
		derived: true,
		diagnosticsKey: 'sessionOwnership',
		read: word,
	}),
	S({
		name: 'TTK_BROWSER_PATH',
		section: 'browser',
		kind: 'path',
		default: 'discovered',
		explain: 'Chromium executable.',
		derived: true,
	}),
	S({
		name: 'TTK_BROWSER_ARGS',
		section: 'browser',
		kind: 'list',
		default: 'none',
		explain: 'Extra Chromium switches; anything that weakens the sandbox is refused.',
	}),
	S({
		name: 'TTK_CHROMIUM_NO_SANDBOX',
		section: 'browser',
		kind: 'boolean',
		default: 'false',
		explain: 'Runs Chromium without its sandbox; the only way to do so, and no shipped image sets it.',
		reach: 'on',
		diagnosticsKey: 'chromiumSandboxed',
		read: (raw) => typeof raw === 'boolean' ? { text: String(!raw), value: String(!raw) } : undefined,
	}),
	S({
		name: 'TTK_HEADLESS',
		section: 'browser',
		kind: 'boolean',
		default: 'true',
		explain: 'Run Chromium headless.',
	}),
	S({
		name: 'TTK_MAX_SESSIONS',
		section: 'browser',
		kind: 'integer',
		default: '8',
		range: [1, 128],
		explain: 'Concurrent browser sessions.',
	}),
	S({
		name: 'TTK_SESSION_TTL_S',
		section: 'browser',
		kind: 'integer',
		default: '1800',
		range: [10, 86_400],
		explain: 'Idle seconds before a session is closed; a session with a viewer is never closed for idleness.',
	}),
	S({
		name: 'TTK_SECRETS',
		section: 'browser',
		kind: 'text',
		default: 'none',
		explain: 'Inline JSON object of browser secrets; prefer the file form.',
		secret: true,
	}),
	S({
		name: 'TTK_SECRETS_FILE',
		section: 'browser',
		kind: 'secret-file',
		default: 'none',
		explain: 'File holding the browser secrets a model references by name; values are never returned.',
	}),
	// Storage and recording
	S({
		name: 'TTK_DATA_DIR',
		section: 'storage',
		kind: 'path',
		default: 'none (ephemeral)',
		explain: 'Persistent data directory: profiles, downloads, recordings, the share, users, agent state, ttk.db.',
		diagnosticsKey: 'persistenceEnabled',
		read: presence('configured', 'none (ephemeral)'),
	}),
	// D-154: the key that seals every secret in the database; file-only, never on the data volume.
	S({
		name: 'TTK_DB_KEY_FILE',
		section: 'storage',
		kind: 'secret-file',
		default: 'none (no secret is stored)',
		explain: 'File holding the 32-byte key that encrypts every secret in ttk.db.',
	}),
	S({
		name: 'TTK_FFMPEG',
		section: 'storage',
		kind: 'path',
		default: 'none (recording off)',
		explain: 'Path to ffmpeg; recording needs this and TTK_DATA_DIR.',
		diagnosticsKey: 'recordingEnabled',
		read: presence('configured', 'none (recording off)'),
	}),
	// Signed links
	S({
		name: 'TTK_SIGNED_LINKS',
		section: 'signed-links',
		kind: 'boolean',
		// D-150: on wherever a signing key can be had, off elsewhere.
		default: 'true with TTK_SIGNED_LINK_KEY_FILE, or TTK_DATA_DIR plus TTK_DB_KEY_FILE on a single node; else false',
		explain: 'Enables browser_file_link and the public links route.',
		reach: 'on',
		derived: true,
		diagnosticsKey: 'signedLinks',
		read: feature,
	}),
	S({
		name: 'TTK_SIGNED_LINK_TTL_S',
		section: 'signed-links',
		kind: 'integer',
		default: '3600',
		range: [10, 3600],
		explain: 'Default link life, in seconds.',
	}),
	S({
		name: 'TTK_SIGNED_LINK_KEY_FILE',
		section: 'signed-links',
		kind: 'secret-file',
		default: 'none (generated and sealed in ttk.db)',
		explain: 'File holding the link-signing key; every node of a cluster needs it.',
	}),
	// Live view
	S({
		name: 'TTK_MAX_VIEWERS',
		section: 'live-view',
		kind: 'integer',
		default: '4',
		range: [1, 64],
		explain: 'Live-view viewers per session.',
	}),
	S({
		name: 'TTK_CAST_QUALITY',
		section: 'live-view',
		kind: 'integer',
		default: '60',
		range: [1, 100],
		explain: 'Screencast JPEG quality.',
	}),
	// MCP Apps
	S({
		name: 'TTK_MCP_APPS',
		section: 'mcp-apps',
		kind: 'enum',
		// D-150: `control` wherever it can run; off in a cluster or on a build without the embeds.
		default: 'control (off in a cluster or without the embed build)',
		values: ['off', 'watch', 'control'],
		explain: 'Serves the ui:// embeds; control lets an embed take control on a click.',
		reach: 'not-off',
		derived: true,
		diagnosticsKey: 'mcpApps',
		read: (raw) => word(raw) ?? (raw === false || raw === null ? { text: 'off', value: 'off' } : undefined),
	}),
	S({
		name: 'TTK_MCP_APPS_ORIGINS',
		section: 'mcp-apps',
		kind: 'list',
		default: 'none',
		// D-150: empty is no longer a refusal; the ticket's own origin is admitted by TTK_ALLOWED_ORIGINS instead.
		explain: 'Host-sandbox origins a ticket may be bound to; empty admits any https one TTK_ALLOWED_ORIGINS admits.',
	}),
	S({
		name: 'TTK_MCP_APPS_DOMAIN',
		section: 'mcp-apps',
		kind: 'text',
		default: 'none',
		explain: 'Passed to the host as _meta.ui.domain.',
	}),
	// Limits and transport
	S({
		name: 'TTK_RATE_RPM',
		section: 'limits',
		kind: 'integer',
		default: '120',
		range: [1, 100_000],
		explain: 'Requests per minute per principal; the burst is a third of this.',
	}),
	S({
		name: 'TTK_MCP_STATEFUL',
		section: 'limits',
		kind: 'boolean',
		default: 'false',
		explain: 'Also serve 2025-era clients on a stateful mount with Mcp-Session-Id.',
	}),
	S({
		name: 'TTK_MAX_BODY_KB',
		section: 'limits',
		kind: 'integer',
		default: '256',
		explain: 'Largest request body on the API routes, in KiB.',
	}),
	S({
		name: 'TTK_METRICS',
		section: 'limits',
		kind: 'boolean',
		default: 'false',
		explain: 'Serves Prometheus metrics at GET /metrics to metrics:read or admin.',
	}),
	S({
		name: 'TTK_CONFIRM_DESTRUCTIVE',
		section: 'limits',
		kind: 'boolean',
		default: 'true',
		explain: 'Ask a client that declared form elicitation to confirm the seven destructive tools.',
		diagnosticsKey: 'confirmations',
		read: feature,
	}),
	S({
		name: 'TTK_HUMAN_HANDOFF',
		section: 'limits',
		kind: 'boolean',
		// D-150: on by default (HTTP only; stdio has no public URL to hand out).
		default: 'true',
		explain: 'Offers browser_request_human, which hands out live-view links.',
		reach: 'on',
		diagnosticsKey: 'humanHandoff',
		read: feature,
	}),
	// Logging
	S({
		name: 'TTK_LOG_LEVEL',
		section: 'logging',
		kind: 'enum',
		default: 'info',
		values: ['debug', 'info', 'warn', 'error'],
		explain: 'Log level.',
	}),
	S({
		name: 'TTK_LOG_FORMAT',
		section: 'logging',
		kind: 'enum',
		default: 'json',
		values: ['json', 'pretty'],
		explain: 'pretty for human-readable lines; anything else is JSON.',
	}),
	// Cluster
	S({
		name: 'TTK_CLUSTER_KV',
		section: 'cluster',
		kind: 'text',
		default: 'none (single node)',
		explain: 'A Deno KV path or URL shared by every node.',
	}),
	S({
		name: 'TTK_ROLE',
		section: 'cluster',
		kind: 'enum',
		default: 'all',
		values: ['all', 'browser', 'edge'],
		explain: 'all hosts browsers and serves clients; browser hosts browsers; edge forwards.',
		diagnosticsKey: 'clusterMode',
		read: word,
	}),
	S({
		name: 'TTK_NODE_ID',
		section: 'cluster',
		kind: 'text',
		default: 'node-<8 hex>',
		explain: 'This node id.',
		derived: true,
	}),
	S({
		name: 'TTK_NODE_URL',
		section: 'cluster',
		kind: 'text',
		default: 'none',
		explain: 'The URL other nodes use to reach this one.',
	}),
	// Coding sandbox
	S({
		name: 'TTK_SANDBOX_URL',
		section: 'sandbox',
		kind: 'text',
		default: 'none (off)',
		explain: 'Origin of the sandbox service.',
		diagnosticsKey: 'sandboxEnabled',
		read: presence('configured and reachable', 'none (off)'),
	}),
	S({
		name: 'TTK_SANDBOX_TOKEN_FILE',
		section: 'sandbox',
		kind: 'secret-file',
		default: 'none',
		explain: 'File holding the shared bearer token the gateway and the sandbox service read.',
	}),
	// Sandbox service
	S({
		name: 'TTK_SANDBOX_BACKEND',
		section: 'sandbox-service',
		kind: 'enum',
		default: 'bwrap',
		values: ['bwrap', 'docker'],
		explain: 'A bubblewrap cage per command, or one hardened container per workspace through the Engine API.',
		reach: 'docker',
		diagnosticsKey: 'sandboxBackend',
		read: word,
	}),
	S({
		name: 'TTK_SANDBOX_DOCKER_SOCKET',
		section: 'sandbox-service',
		kind: 'path',
		default: '/var/run/docker.sock',
		explain: 'The Engine API unix socket.',
	}),
	S({
		name: 'TTK_SANDBOX_WORKSPACE_IMAGE',
		section: 'sandbox-service',
		kind: 'text',
		default: 'tykotech-sandbox-workspace:0.2.0',
		explain: 'The image each workspace container runs.',
	}),
	S({
		name: 'TTK_SANDBOX_DOCKER_VOLUME',
		section: 'sandbox-service',
		kind: 'text',
		default: 'ttk-code',
		explain: 'The Docker volume that holds the workspaces.',
	}),
	S({
		name: 'TTK_SANDBOX_DOCKER_SOCK_VOLUME',
		section: 'sandbox-service',
		kind: 'text',
		default: 'ttk-sandbox-sock',
		explain: 'The Docker volume that carries the registry proxy socket into workspace containers.',
	}),
	S({
		name: 'TTK_SANDBOX_GIT_HOSTS',
		section: 'sandbox-service',
		kind: 'list',
		default: 'none (off)',
		explain: 'Exact host names a public sandbox_clone may reach over https.',
		diagnosticsKey: 'sandboxClone',
		read: (raw) => {
			const state = featureState(raw, 'configured', 'none (off)');
			return 'unknown' in state ? undefined : { text: state.on ? 'configured' : 'none (off)', set: state.on };
		},
	}),
	S({
		name: 'TTK_SANDBOX_GIT_REMOTES_FILE',
		section: 'sandbox-service',
		kind: 'secret-file',
		default: 'none (off)',
		explain: 'Must be /run/secrets/ttk_git_remotes: credentialed remotes a caller names by id.',
	}),
	// Agents
	S({
		name: 'TTK_AGENT_BRIDGE_URL',
		section: 'agents',
		kind: 'text',
		default: 'none (off)',
		explain: 'URL of the private ACP agent runner.',
	}),
	S({
		name: 'TTK_AGENT_BRIDGE_TOKEN_FILE',
		section: 'agents',
		kind: 'secret-file',
		default: 'none',
		explain: 'File holding the bridge bearer token; required with the URL.',
	}),
	S({
		name: 'TTK_AGENT_DEFAULT',
		section: 'agents',
		kind: 'text',
		default: 'default',
		explain: 'The runner agent id to use.',
	}),
	S({
		name: 'TTK_AGENT_AUTH_METHOD',
		section: 'agents',
		kind: 'text',
		default: 'none',
		explain: 'ACP authentication method to select when the agent advertises it.',
	}),
	S({
		name: 'TTK_AGENT_MCP_URL',
		section: 'agents',
		kind: 'text',
		default: '<TTK_PUBLIC_URL>/mcp',
		explain: 'The MCP URL handed to the agent with its delegated token; its path must be /mcp.',
		derived: true,
	}),
	S({
		name: 'TTK_AGENT_PEERS_FILE',
		section: 'agents',
		kind: 'path',
		default: 'none',
		explain: 'JSON array of A2A peers.',
	}),
	S({
		name: 'TTK_A2UI_ACTIONS',
		section: 'agents',
		kind: 'text',
		default: '[]',
		explain: 'Inline JSON array of operator-defined A2UI button actions.',
	}),
	S({
		name: 'TTK_AGENT_TASK_TIMEOUT_S',
		section: 'agents',
		kind: 'integer',
		default: '600',
		range: [10, 86_400],
		explain: 'How long a text or delegation task may run, in seconds.',
	}),
	S({
		name: 'TTK_AGENT_TASK_RETENTION_S',
		section: 'agents',
		kind: 'integer',
		default: '86400',
		range: [60, 2_592_000],
		explain: 'How long finished agent tasks are kept, in seconds.',
	}),
	S({
		name: 'TTK_A2A_PUSH_ALLOWED_HOSTS',
		section: 'agents',
		kind: 'list',
		default: 'empty (push off)',
		explain: 'Hosts A2A push webhooks may target; private, loopback and link-local addresses are refused.',
		reach: 'always',
	}),
	// D-143: the providers file. Not yet on the reference page (D5 adds it); the catalogue test allows the one name.
	S({
		name: 'TTK_MODEL_PROVIDERS_FILE',
		section: 'agents',
		kind: 'secret-file',
		default: 'none (add providers in System › Agents)',
		explain: 'Seed file of model providers, copied into the database once with its keys sealed; never written.',
		reach: 'always',
		diagnosticsKey: 'modelProviders',
		read: (raw) =>
			Array.isArray(raw)
				? {
					text: raw.length === 0 ? 'none' : raw.length === 1 ? '1 provider' : `${raw.length} providers`,
					set: raw.length > 0,
				}
				: undefined,
	}),
	// OpenTelemetry
	S({
		name: 'TTK_OTEL_ENDPOINTS',
		section: 'otel',
		kind: 'list',
		default: 'empty',
		explain: 'Collector origins the runtime may export to; while exporting, an endpoint off the list refuses start.',
		diagnosticsKey: 'otelEndpoints',
	}),
	S({
		name: 'OTEL_DENO',
		section: 'otel',
		kind: 'boolean',
		default: 'off',
		explain: 'Turns OTLP export on; the runtime performs it outside the permission matrix (bundled image only).',
		reach: 'on',
		diagnosticsKey: 'telemetry',
		read: feature,
	}),
	S({
		name: 'OTEL_DENO_VSOCK',
		section: 'otel',
		kind: 'text',
		default: 'unset',
		explain: 'Refused while exporting: vsock export cannot be allowlisted.',
	}),
	S({
		name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
		section: 'otel',
		kind: 'text',
		default: 'unset',
		explain: 'Where to export; a credential-free http(s) URL on a listed origin.',
	}),
	S({
		name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
		section: 'otel',
		kind: 'text',
		default: 'the base endpoint',
		explain: 'Where traces export, when it differs from the base.',
	}),
	S({
		name: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
		section: 'otel',
		kind: 'text',
		default: 'the base endpoint',
		explain: 'Where metrics export, when it differs from the base.',
	}),
	S({
		name: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
		section: 'otel',
		kind: 'text',
		default: 'the base endpoint',
		explain: 'Where logs export, when it differs from the base.',
	}),
	// Docker Compose interpolation (read by compose, not by the server)
	S({
		name: 'TTK_BIND',
		section: 'compose',
		kind: 'text',
		default: '127.0.0.1',
		explain: 'Host address the container port is published on; 0.0.0.0 exposes it on the network.',
		reach: 'non-loopback',
	}),
	S({
		name: 'TTK_AGENT_RUNNER_IMAGE',
		section: 'compose',
		kind: 'text',
		default: 'tykotech-agent-runner:0.2.0',
		explain: 'The derived runner image that contains your ACP agent.',
	}),
	S({
		name: 'TTK_SANDBOX_DOCKER_GID',
		section: 'compose',
		kind: 'integer',
		default: '0',
		explain: 'The group that owns the Docker socket on the host, for the docker sandbox overlay.',
	}),
];

const BY_NAME: ReadonlyMap<string, Setting> = new Map(SETTINGS.map((setting) => [setting.name, setting]));

/** The catalogue entry for a variable name, if there is one. */
export function settingOf(name: string): Setting | undefined {
	return BY_NAME.get(name);
}

/** The entries of one section, in catalogue order. */
export function settingsIn(section: SettingSection): readonly Setting[] {
	return SETTINGS.filter((setting) => setting.section === section);
}

/** Whether `value` for this setting widens what the deployment reaches or who reaches it. */
export function widensReach(setting: Setting, value: string | undefined): boolean {
	if (setting.reach === undefined || value === undefined || value.trim() === '') return false;
	switch (setting.reach) {
		case 'always':
			return true;
		case 'non-loopback': {
			const host = hostOf(value);
			return host !== '' && !isLoopbackHost(host);
		}
		case 'on':
			return booleanOf(value) === true;
		case 'not-off':
			return value.trim().toLowerCase() !== 'off';
		case 'docker':
			return value.trim().toLowerCase() === 'docker';
	}
}

/**
 * The derived default of a setting whose default is computed, from the running facts; `undefined` otherwise.
 *
 * D-150's three deployment-shaped defaults read the cluster from `clusterMode`: a role other than `all` exists only
 * with `TTK_CLUSTER_KV`, so such a node is clustered. An `all` node in a cluster is not told apart by the diagnostics
 * and reads as a single node — its `shared` then tags "set", never a guess the other way. Signed links read the data
 * directory (`persistenceEnabled`); a key file is never reported, so links on without one tag "set".
 */
export function derivedDefault(setting: Setting, config: unknown): string | undefined {
	const role = diagnosticsKey(config, undefined, 'clusterMode');
	const clustered = typeof role === 'string' ? role !== 'all' : undefined;
	switch (setting.name) {
		case 'TTK_PUBLIC_URL': {
			const host = diagnosticsKey(config, undefined, 'host');
			const port = diagnosticsKey(config, undefined, 'port');
			if (typeof host !== 'string' || typeof port !== 'number') return undefined;
			return isLoopbackHost(host) ? `http://127.0.0.1:${port}` : `http://${host}:${port}`;
		}
		case 'TTK_SESSION_OWNERSHIP':
			return clustered === undefined ? undefined : clustered ? 'shared' : 'owner';
		case 'TTK_MCP_APPS':
			return clustered === undefined ? undefined : clustered ? 'off' : 'control';
		case 'TTK_SIGNED_LINKS': {
			const persistence = diagnosticsKey(config, undefined, 'persistenceEnabled');
			if (clustered === undefined || typeof persistence !== 'boolean') return undefined;
			return persistence && !clustered ? 'true' : 'false';
		}
		default:
			return undefined;
	}
}

/** Where a value came from, as the panel tags it: set by the operator, the stated default, or derived. */
export type ValueSource = 'set' | 'default' | 'derived';

/** The source tag of a running value against the catalogue's default. */
export function sourceOf(setting: Setting, value: string | undefined, config?: unknown): ValueSource {
	if (value === undefined || value === '') return setting.derived ? 'derived' : 'default';
	if (setting.derived) {
		const derived = derivedDefault(setting, config);
		return derived !== undefined && derived === value ? 'derived' : 'set';
	}
	return value === setting.default ? 'default' : 'set';
}

/** What the diagnostics say about a setting: a reading, "not reported", or nothing (no fact maps to it). */
export type RunningValue =
	| { readonly kind: 'reading'; readonly reading: Reading }
	| { readonly kind: 'not-reported' }
	| { readonly kind: 'none' };

/** The setting's running value from the diagnostics document, read defensively. */
export function runningValue(setting: Setting, config: unknown, diag?: unknown): RunningValue {
	if (setting.diagnosticsKey === undefined) return { kind: 'none' };
	const raw = diagnosticsKey(config, diag, setting.diagnosticsKey);
	if (raw === undefined) return { kind: 'not-reported' };
	const reading = (setting.read ?? same)(raw);
	if (reading === undefined) return { kind: 'not-reported' };
	// A fact of the wrong shape for its kind (a word where a number belongs) is unreported, never shown as the value.
	if (setting.kind === 'integer' && reading.value !== undefined && !/^-?\d+$/.test(reading.value)) {
		return { kind: 'not-reported' };
	}
	if (setting.kind === 'boolean' && reading.value !== undefined && booleanOf(reading.value) === undefined) {
		return { kind: 'not-reported' };
	}
	return { kind: 'reading', reading };
}

/** The source tag of a reading: by its value when the fact is the value, else by whether it says the variable is set. */
export function readingSource(setting: Setting, reading: Reading, config?: unknown): ValueSource | undefined {
	if (reading.value !== undefined) return sourceOf(setting, reading.value, config);
	if (reading.set === undefined) return undefined;
	return reading.set ? 'set' : setting.derived ? 'derived' : 'default';
}

/** The words a panel row shows for the running value. */
export function runningText(setting: Setting, config: unknown, diag?: unknown): string {
	const running = runningValue(setting, config, diag);
	return running.kind === 'reading' ? running.reading.text : FACT_NOT_REPORTED;
}

/**
 * Every setting whose running value the diagnostics report faithfully, as `name → value`: the composer's seed for
 * "Start from running" and the running side of its diff.
 */
export function runningValues(config: unknown, diag?: unknown): Record<string, string> {
	const values: Record<string, string> = {};
	for (const setting of SETTINGS) {
		const running = runningValue(setting, config, diag);
		if (running.kind === 'reading' && running.reading.value !== undefined) values[setting.name] = running.reading.value;
	}
	return values;
}

/** The settings the Configuration panel lists: those a reported fact maps to, in catalogue order. */
export function reportedSettings(): readonly Setting[] {
	return SETTINGS.filter((setting) => setting.diagnosticsKey !== undefined);
}

/**
 * A JSON Schema for one section's form, as `schemaForm` renders it — `enum` words, booleans, bounded integers, and
 * strings for lists (comma-separated, as the environment carries them), paths and file paths. Inline secrets have
 * no field. `values` seed each property's `default`.
 */
export function settingsSchema(section: SettingSection, values: Readonly<Record<string, string>> = {}): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	for (const setting of settingsIn(section)) {
		if (setting.secret) continue;
		const seed = values[setting.name];
		const explain = setting.kind === 'secret-file'
			? `${setting.explain} File-backed: its content is never shown or sent.`
			: setting.explain;
		const description = `${explain} Default: ${setting.default}.`;
		let property: JsonSchema;
		switch (setting.kind) {
			case 'enum':
				property = { type: 'string', enum: [...setting.values ?? []], description };
				if (seed !== undefined && setting.values?.includes(seed)) property.default = seed;
				break;
			case 'boolean': {
				property = { type: 'boolean', description };
				const bool = booleanOf(seed);
				if (bool !== undefined) property.default = bool;
				break;
			}
			case 'integer': {
				property = { type: 'integer', description };
				if (setting.range !== undefined) [property.minimum, property.maximum] = setting.range;
				const number = Number(seed);
				if (seed !== undefined && seed.trim() !== '' && Number.isInteger(number)) property.default = number;
				break;
			}
			default:
				property = { type: 'string', description };
				if (seed !== undefined && seed !== '') property.default = seed;
		}
		properties[setting.name] = property;
	}
	return { type: 'object', properties };
}

/** A form's read-back as environment strings: booleans and numbers spelled as the environment carries them. */
export function envValuesOf(read: Readonly<Record<string, unknown>>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [name, value] of Object.entries(read)) {
		if (value === undefined || value === null) continue;
		const text = typeof value === 'string'
			? value
			: typeof value === 'boolean' || typeof value === 'number'
			? String(value)
			: Array.isArray(value)
			? value.map(String).join(',')
			: JSON.stringify(value) ?? '';
		if (text.trim() !== '') values[name] = text;
	}
	return values;
}
