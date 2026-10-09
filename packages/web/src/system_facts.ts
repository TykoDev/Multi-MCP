/**
 * The System screen's reading of the diagnostics document — pure, so it is unit-tested without a DOM.
 *
 * Every key read here is newer than some gateway an operator may point this screen at, and the mcp-recommendations
 * keys (design §3.1, §5) are written by different workstreams, so each is read defensively: an absent key is
 * *unknown*, never "off", and a value is accepted as a boolean, a short word, `null`, or an object carrying
 * `enabled` / `mode` / `provider`.
 */
import type { IconName } from './icon_names.ts';

/** A diagnostics key from `config`, else from the document's top level (where an older gateway may put it). */
export function diagnosticsKey(config: unknown, diag: unknown, key: string): unknown {
	const fromConfig = (config as Record<string, unknown> | null | undefined)?.[key];
	return fromConfig !== undefined ? fromConfig : (diag as Record<string, unknown> | null | undefined)?.[key];
}

/** Words that mean "this opt-in feature is off", whichever workstream's key spells it. */
const OFF_WORDS = new Set(['off', 'none', 'disabled', 'false', 'no', '']);

/** A short, safe word to show in a tile, or `undefined` for anything that is not one. */
export function shortWord(value: unknown): string | undefined {
	return typeof value === 'string' && /^[a-z0-9:._-]{0,24}$/i.test(value) ? value : undefined;
}

/** What a capability tile shows: on or off with its words (and an optional short detail), or unknown. */
export type FeatureState = { on: boolean; yes: string; no: string; detail?: string } | { unknown: string };

/** The words an unreported fact is shown with. */
export const NOT_REPORTED = 'Not reported by this gateway';

/**
 * The tile state of an opt-in feature from its diagnostics value. A word other than an off-word is shown as the
 * tile's detail — `watch`, `vault` — beside the on flag; anything unreadable is unknown rather than guessed.
 */
export function featureState(raw: unknown, yes: string, no: string): FeatureState {
	if (raw === undefined) return { unknown: NOT_REPORTED };
	if (raw === null) return { on: false, yes, no };
	if (typeof raw === 'boolean') return { on: raw, yes, no };
	const word = shortWord(raw);
	if (word !== undefined) {
		return OFF_WORDS.has(word.toLowerCase()) ? { on: false, yes, no } : { on: true, yes, no, detail: word };
	}
	if (typeof raw === 'object') {
		const record = raw as Record<string, unknown>;
		const detail = shortWord(record.mode) ?? shortWord(record.provider);
		const live = detail !== undefined && !OFF_WORDS.has(detail.toLowerCase());
		const enabled = typeof record.enabled === 'boolean' ? record.enabled : live;
		return { on: enabled, yes, no, ...(enabled && live ? { detail: detail! } : {}) };
	}
	return { unknown: NOT_REPORTED };
}

/** `TTK_SESSION_OWNERSHIP` as the diagnostics report it (D-128): `owner` is on, `shared` off, anything else unknown. */
export function ownershipState(raw: unknown): FeatureState {
	const word = shortWord(raw);
	if (word !== 'shared' && word !== 'owner') return { unknown: NOT_REPORTED };
	return { on: word === 'owner', yes: 'Per principal', no: 'Shared' };
}

/** One capability tile the mcp-recommendations run added (design §5). */
export interface RecommendationTile {
	/** The diagnostics key it reads. */
	readonly key: string;
	readonly glyph: IconName;
	readonly name: string;
	readonly yes: string;
	readonly no: string;
}

/**
 * The eight tiles of design §5, in its order, each a glyph already in the sprite. Session ownership is read by
 * {@linkcode ownershipState}; the rest are opt-in features, read by {@linkcode featureState}.
 *
 * ERRATUM(E-113), review RV-3: four glyphs differ from design §5's table, because the System screen already draws those
 * — `link` (the Network panel's bind and origins), `shield-check` (the Capabilities heading, the effective origins),
 * `key` (the API keys tile) and `radio` (the event transports) — and D-092 allows no glyph twice on one screen. Each
 * replacement is one the screen draws nowhere else (`system_facts_test.ts` reads the screen's sources to keep it so).
 */
export const RECOMMENDATION_TILES: readonly RecommendationTile[] = [
	{ key: 'sessionOwnership', glyph: 'user-cog', name: 'Session ownership', yes: 'Per principal', no: 'Shared' },
	{ key: 'mcpApps', glyph: 'surface', name: 'MCP Apps', yes: 'Embeds served', no: 'Off' },
	// A link that works outside the control plane, without a sign-in.
	{ key: 'signedLinks', glyph: 'external', name: 'Signed links', yes: 'Enabled', no: 'Off' },
	// The tool asks the person before it acts.
	{ key: 'confirmations', glyph: 'question', name: 'Confirmations', yes: 'Destructive tools ask', no: 'Off' },
	{ key: 'humanHandoff', glyph: 'control', name: 'Human handoff', yes: 'Enabled', no: 'Off' },
	// Values that are used and never shown.
	{ key: 'secretProvider', glyph: 'eye-off', name: 'Secret provider', yes: 'Configured', no: 'None' },
	{ key: 'telemetry', glyph: 'gauge', name: 'OpenTelemetry', yes: 'Exporting', no: 'Off' },
	{ key: 'sandboxClone', glyph: 'revision', name: 'Git clone', yes: 'Available', no: 'Off' },
];

/** A tile's state from the diagnostics document. */
export function recommendationState(tile: RecommendationTile, config: unknown, diag: unknown): FeatureState {
	const raw = diagnosticsKey(config, diag, tile.key);
	return tile.key === 'sessionOwnership' ? ownershipState(raw) : featureState(raw, tile.yes, tile.no);
}

/**
 * FXD-N1 (D-092 amended): every glyph the System screen's content area draws, by what it names — the one place a
 * glyph is chosen for this screen, so `system_facts_test.ts` can hold the rule that no glyph appears twice there.
 * The dock is not part of the content area (it names the sections), and the context bar's own tools (search, the
 * theme switch) are listed in {@linkcode SYSTEM_BAR_GLYPHS} so nothing here repeats them either.
 *
 * D-149: the screen is three page tabs, and the table stays one table across them — a glyph means one thing
 * wherever the operator meets it on this screen, whichever tab is lit. The tabs' own glyphs are its first rows.
 *
 * Lists draw no glyph per entry (origins, transports, withheld tools), group labels draw none, configuration rows
 * draw none, and a text button draws none. The capability tiles' on/off marks are drawn by the stylesheet, not the
 * sprite, because a glyph in each tile's corner would be the screen's most repeated one.
 */
export const SYSTEM_GLYPHS = {
	// The page tabs (D-149), in the context bar.
	tabOverview: 'home',
	tabMcp: 'plug',
	tabConfig: 'settings',
	// Overview: the metrics strip.
	gateway: 'pulse',
	uptime: 'clock',
	heap: 'memory',
	sessions: 'sessions',
	viewers: 'eye',
	tools: 'tools',
	notice: 'alert',
	// Overview: Capabilities — the panel, then each tile before the RECOMMENDATION_TILES.
	capabilities: 'shield-check',
	adminUser: 'user',
	oauth: 'globe-lock',
	chromium: 'shield',
	codingSandbox: 'workspace',
	egress: 'upload',
	persistence: 'save',
	recording: 'record',
	apiKeys: 'key',
	cluster: 'network',
	// Overview: Network.
	network: 'server',
	version: 'package',
	bind: 'link',
	publicUrl: 'globe',
	// Where the browser may go (`TTK_ALLOWED_DOMAINS`), so `globe` stays with the public URL.
	browserReach: 'filter',
	// An allowlist of origins, so `link` stays with Bind.
	allowedOrigins: 'list-checks',
	// Where the runtime sends its telemetry (D-137).
	collectors: 'send',
	// Overview: the process's memory as meter bars, which draw no glyph each.
	process: 'cpu',
	// MCP: tool access (served and withheld), the event stream, the protocol details, the live-view origins.
	toolAccess: 'wrench',
	withheld: 'ban',
	openTools: 'arrow-up-right',
	events: 'radio',
	protocol: 'code',
	// Who may watch, so `globe` stays with the public URL.
	origins: 'cast',
	readOnly: 'lock',
	addOrigin: 'plus',
	// Configuration: the filter over the catalogue's rows (the context bar owns `search`).
	filter: 'list-filter',
	// The context bar's two actions: the raw JSON modal (one home for both documents) and the configuration composer.
	raw: 'braces',
	composer: 'sliders',
	// Agents (D-152, D-153, `system_agents.ts`): the tab, the model providers (their two sources are drawn with dots,
	// not glyphs), A2A, the agent runtime, and the way to the same things in the Resources tree.
	tabAgents: 'agents',
	providersPanel: 'model',
	a2a: 'a2a',
	agentRuntime: 'acp',
	agentResources: 'resources',
	// D-154: the agents' vector memory (its embedder and what is stored), in the same tab.
	memoryPanel: 'brain',
	// D-158: the agents and their settings (each row's Edit is the providers' repeatable `edit`), and the provider
	// editor's model fetch.
	agentsPanel: 'sparkles',
	reloadModels: 'reload',
} as const satisfies Record<string, IconName>;

/** The context bar's own glyphs, painted above every screen's content (`shell.ts`): search and the theme picker's. */
export const SYSTEM_BAR_GLYPHS: readonly IconName[] = ['search', 'moon', 'cloud-moon', 'sun', 'sunrise'];

/**
 * The glyphs a row action repeats, once per row it acts on: `copy` on each copyable value, `x` on each origin of the
 * token's overlay (Remove), and (D-152) a model provider card's Edit, Make default and Remove. Nothing else on the
 * screen may appear twice.
 */
export const REPEATABLE_GLYPHS: readonly IconName[] = ['copy', 'x', 'edit', 'check', 'trash'];

/** Words for a diagnostics fact the gateway did not report (an older gateway). */
export const FACT_NOT_REPORTED = 'not reported';

/**
 * The capabilities document's keys that already have a home on the screen — the Overview's tiles, the MCP tab's tool
 * access and its Events panel (which shows the whole `events` block: transports, kinds and the ring's numbers) — so
 * the Protocol panel's facts (`jsonFacts`, C8) leave them out; what remains (`live_view` ceilings, `fields`,
 * `state_token`, `model`) is shown, and a key with no label here lands in a trailing "Other" group, never dropped.
 */
export const CAPABILITY_FACTS_OMIT: readonly string[] = [
	'version',
	'sandbox',
	'browser',
	'sessions',
	'tools_withheld',
	'events',
];

/** Words for the capability groups the facts renderer titles. */
export const CAPABILITY_FACTS_LABELS: Readonly<Record<string, string>> = {
	live_view: 'Live view',
	events: 'Events',
	fields: 'Fields',
	state_token: 'State token',
	model: 'Model providers',
	scopes: 'Scopes',
};

/**
 * `TTK_ALLOWED_DOMAINS_SCOPE` (D-138) as the Allowed-domains fact's tag: what the allowlist judges — top-level
 * documents only, or every request. Absent or unreadable reads "not reported", never a guess.
 */
export function domainsScopeTag(raw: unknown): string {
	if (raw === 'documents') return 'documents only';
	if (raw === 'all') return 'all requests';
	return FACT_NOT_REPORTED;
}

/** What the "Telemetry collectors" fact shows (D-137), or `null` when the screen omits it. */
export type CollectorsFact = { readonly entries: readonly string[] } | { readonly none: string };

/**
 * The "Telemetry collectors" fact from `otelEndpoints` (`TTK_OTEL_ENDPOINTS`): shown while the runtime exports
 * (`telemetry` true) or once collectors are listed, and omitted otherwise — the telemetry tile stays the one home of
 * on/off. Each entry is shown as its origin only: the list is origins by contract, and anything else a gateway might
 * send (a path, a query, userinfo) never reaches the screen. An absent key reads "not reported" unless the gateway
 * says it is not exporting, in which case there is nothing to report.
 */
export function collectorsFact(config: unknown, diag: unknown): CollectorsFact | null {
	const raw = diagnosticsKey(config, diag, 'otelEndpoints');
	const telemetry = diagnosticsKey(config, diag, 'telemetry');
	const exporting = telemetry === true;
	if (raw === undefined) return telemetry === false ? null : { none: FACT_NOT_REPORTED };
	const entries = Array.isArray(raw) ? raw.flatMap((value) => originOnly(value) ?? []) : [];
	if (entries.length === 0) return exporting ? { none: 'None listed' } : null;
	return { entries };
}

/** A URL's origin, or `undefined` for anything that is not an http(s) URL. */
function originOnly(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const url = URL.parse(value);
	return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin : undefined;
}

// --- D-149: the redesigned screen's readings ---------------------------------------------------------------------

/**
 * The screen's four views, each its own route: `#/system`, `#/system/mcp`, `#/system/agents` (D-152: model providers
 * and the agent protocols) and `#/system/config`.
 */
export type SystemTab = 'overview' | 'mcp' | 'agents' | 'config';

/** The tab a `#/system/<tab>` route names; anything else, and the bare route, is the Overview. */
export function systemTabOf(tab: string | undefined): SystemTab {
	return tab === 'mcp' || tab === 'agents' || tab === 'config' ? tab : 'overview';
}

/** The four groups the Overview sorts the capability tiles into, in their order. */
export const CAPABILITY_GROUPS = {
	access: 'Access and identity',
	browser: 'Browser',
	integrations: 'Integrations',
	platform: 'Platform',
} as const;
export type CapabilityGroup = keyof typeof CAPABILITY_GROUPS;

/**
 * What a capability tile says beyond its state (D-149): its group, one line on what it does, and — shown only while
 * it is off — the setting that turns it on. The words name settings and never a value from this deployment, so the
 * table is the same for every gateway and a tile cannot leak a fact the diagnostics did not report.
 */
export interface CapabilityInfo {
	readonly group: CapabilityGroup;
	readonly about: string;
	/** Absent where nothing switches it (a count, a role). */
	readonly enable?: string;
}

/** Every tile by its visible name: the nine the view draws first, then the {@linkcode RECOMMENDATION_TILES}. */
export const CAPABILITY_INFO: Readonly<Record<string, CapabilityInfo>> = {
	'Admin user': {
		group: 'access',
		about: 'An enabled account that can administer this server.',
		enable: 'TTK_ADMIN_USER_FILE',
	},
	'OAuth 2.1': {
		group: 'access',
		about: 'Bearer tokens issued by your identity provider.',
		enable: 'TTK_OAUTH_ISSUER',
	},
	'API keys': { group: 'access', about: 'Keys that can sign in: configured, and held by accounts.' },
	'Session ownership': {
		group: 'access',
		about: 'A browser session belongs to whoever created it; admins reach all.',
		enable: 'TTK_SESSION_OWNERSHIP=owner',
	},
	'Secret provider': {
		group: 'access',
		about: 'Keys and secrets read from Vault or 1Password Connect.',
		enable: 'TTK_SECRETS_REF',
	},
	'Sandboxed Chromium': {
		group: 'browser',
		about: "The browser runs inside Chromium's own sandbox.",
		enable: 'unset TTK_CHROMIUM_NO_SANDBOX',
	},
	'Outbound egress': {
		group: 'browser',
		about: 'The server itself may dial out: browser_head, model providers.',
		enable: '--allow-net beyond loopback',
	},
	'Screencast recording': {
		group: 'browser',
		about: 'Sessions can be recorded to video.',
		enable: 'TTK_FFMPEG',
	},
	'Human handoff': {
		group: 'browser',
		about: 'A model can hand the browser to a person to finish a step.',
		enable: 'TTK_HUMAN_HANDOFF=true',
	},
	'Confirmations': {
		group: 'browser',
		about: 'Destructive tools ask the person before they act.',
		enable: 'TTK_CONFIRM_DESTRUCTIVE=true',
	},
	'Signed links': {
		group: 'browser',
		about: 'Expiring links to session files that open without a sign-in.',
		enable: 'TTK_SIGNED_LINKS=true',
	},
	'Coding sandbox': {
		group: 'integrations',
		about: 'Isolated workspaces for the sandbox tools and coding agents.',
		enable: 'TTK_SANDBOX_URL',
	},
	'Git clone': {
		group: 'integrations',
		about: 'Workspaces cloned from allowed git hosts.',
		enable: 'TTK_SANDBOX_GIT_HOSTS',
	},
	'MCP Apps': {
		group: 'integrations',
		about: 'The live view and surfaces embedded in MCP hosts.',
		enable: 'TTK_MCP_APPS',
	},
	'OpenTelemetry': {
		group: 'integrations',
		about: 'Traces and metrics exported to your collector.',
		enable: 'OTEL_DENO=true',
	},
	'Persistence': {
		group: 'platform',
		about: 'Accounts, profiles and files survive a restart.',
		enable: 'TTK_DATA_DIR',
	},
	'Cluster mode': { group: 'platform', about: "This node's role; all is a single node doing everything." },
};

/** A tile's group; a tile the table does not know (a newer gateway's) lands in Platform rather than nowhere. */
export function capabilityGroupOf(name: string): CapabilityGroup {
	return CAPABILITY_INFO[name]?.group ?? 'platform';
}

/** Words for each reason a tool is withheld (`ttk://capabilities`), as a heading and one line under it. */
export const WITHHELD_WORDS: Readonly<Record<string, { readonly title: string; readonly hint: string }>> = {
	'scope-required': {
		title: 'Not granted to this credential',
		hint: 'An administrator grants scopes on the Users screen.',
	},
	'feature-unavailable': {
		title: 'Switched off on this deployment',
		hint: 'The Overview says which capability each one needs.',
	},
	'human-has-control': { title: 'A person has control', hint: 'Served again once control is released.' },
};

/** The withheld tools by reason, in {@linkcode WITHHELD_WORDS} order, then any reason a newer gateway adds. */
export function withheldGroups(
	withheld: ReadonlyArray<{ readonly name: string; readonly reason: string }>,
): Array<{ readonly reason: string; readonly names: readonly string[] }> {
	const byReason = new Map<string, string[]>();
	for (const { name, reason } of withheld) byReason.set(reason, [...byReason.get(reason) ?? [], name]);
	const order = [...Object.keys(WITHHELD_WORDS), ...[...byReason.keys()].filter((key) => !(key in WITHHELD_WORDS))];
	return order.flatMap((reason) => {
		const names = byReason.get(reason);
		return names === undefined ? [] : [{ reason, names: [...names].sort() }];
	});
}

/**
 * Where the browser may go, as the Network panel shows it (D-149): an empty `TTK_ALLOWED_DOMAINS` is every site, and
 * says so in words, with no scope tag — `TTK_ALLOWED_DOMAINS_SCOPE` only qualifies an allowlist (D-138), and "documents
 * only" beside "any" read as a restriction that does not exist. With an allowlist, its entries and the scope tag.
 */
export function browserReach(
	allowedDomains: readonly string[],
	scope: unknown,
): { readonly entries: readonly string[]; readonly none: string; readonly scopeTag: string | null } {
	if (allowedDomains.length === 0) return { entries: [], none: 'Any site', scopeTag: null };
	return { entries: allowedDomains, none: 'Any site', scopeTag: domainsScopeTag(scope) };
}

/**
 * Whether a configuration row matches the Configuration tab's filter: every word of the query appears in the row's
 * name or its value, case-insensitively. An empty query matches every row.
 */
export function configRowMatches(query: string, name: string, value: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
	const haystack = `${name} ${value}`.toLowerCase();
	return words.every((word) => haystack.includes(word));
}
