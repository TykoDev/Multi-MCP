/**
 * The System screen's reading of the diagnostics document — pure, so it is unit-tested without a DOM. Every key is
 * read defensively: an absent key is *unknown*, never "off", and a value may be a boolean, a short word, `null`, or
 * an object carrying `enabled` / `mode` / `provider`.
 */

/** A diagnostics key from `config`, else from the document's top level (where an older gateway may put it). */
export function diagnosticsKey(config: unknown, diag: unknown, key: string): unknown {
	const fromConfig = (config as Record<string, unknown> | null | undefined)?.[key];
	return fromConfig !== undefined ? fromConfig : (diag as Record<string, unknown> | null | undefined)?.[key];
}

/** Words that mean "this opt-in feature is off", whichever feature's key spells it. */
const OFF_WORDS = new Set(['off', 'none', 'disabled', 'false', 'no', '']);

/** A short, safe word to show, or `undefined` for anything that is not one. */
export function shortWord(value: unknown): string | undefined {
	return typeof value === 'string' && /^[a-z0-9:._-]{0,24}$/i.test(value) ? value : undefined;
}

/** A capability's state: on or off with its words (and an optional short detail), or unknown. */
export type FeatureState = { on: boolean; yes: string; no: string; detail?: string } | { unknown: string };

export const NOT_REPORTED = 'Not reported by this gateway';

/** The state of an opt-in feature: a word other than an off-word is its detail (`watch`, `vault`). */
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

/** `TTK_SESSION_OWNERSHIP` as reported: `owner` is on, `shared` off, anything else unknown. */
export function ownershipState(raw: unknown): FeatureState {
	const word = shortWord(raw);
	if (word !== 'shared' && word !== 'owner') return { unknown: NOT_REPORTED };
	return { on: word === 'owner', yes: 'Per principal', no: 'Shared' };
}

/** What each capability does, and — shown while it is off — the setting that turns it on. */
export const CAPABILITY_INFO: Readonly<Record<string, { readonly about: string; readonly enable?: string }>> = {
	'Admin user': { about: 'An enabled account that can administer this server.', enable: 'TTK_ADMIN_USER_FILE' },
	'API keys': { about: 'Keys that can sign in: configured, and held by accounts.' },
	'Session ownership': {
		about: 'A browser session belongs to whoever created it; admins reach all.',
		enable: 'TTK_SESSION_OWNERSHIP=owner',
	},
	'Secret provider': { about: 'Keys and secrets read from Vault or 1Password Connect.', enable: 'TTK_SECRETS_REF' },
	'Sandboxed Chromium': {
		about: "The browser runs inside Chromium's own sandbox.",
		enable: 'unset TTK_CHROMIUM_NO_SANDBOX',
	},
	'Outbound egress': {
		about: 'The server itself may dial out: browser_head, model providers.',
		enable: '--allow-net beyond loopback',
	},
	'Screencast recording': { about: 'Sessions can be recorded to video.', enable: 'TTK_FFMPEG' },
	'Human handoff': {
		about: 'A model can hand the browser to a person to finish a step.',
		enable: 'TTK_HUMAN_HANDOFF=true',
	},
	'Confirmations': {
		about: 'Destructive tools ask the person before they act.',
		enable: 'TTK_CONFIRM_DESTRUCTIVE=true',
	},
	'Signed links': {
		about: 'Expiring links to session files that open without a sign-in.',
		enable: 'TTK_SIGNED_LINKS=true',
	},
	'Coding sandbox': {
		about: 'Isolated workspaces for the sandbox tools and coding agents.',
		enable: 'TTK_SANDBOX_URL',
	},
	'Git clone': { about: 'Workspaces cloned from allowed git hosts.', enable: 'TTK_SANDBOX_GIT_HOSTS' },
	'MCP Apps': { about: 'The live view and surfaces embedded in MCP hosts.', enable: 'TTK_MCP_APPS' },
	'Persistence': { about: 'Accounts, profiles and files survive a restart.', enable: 'TTK_DATA_DIR' },
};

/** The opt-in capabilities read straight from their diagnostics key: name, key, and the words for on and off. */
export const OPT_IN: ReadonlyArray<readonly [name: string, key: string, yes: string, no: string]> = [
	['Session ownership', 'sessionOwnership', 'Per principal', 'Shared'],
	['MCP Apps', 'mcpApps', 'Embeds served', 'Off'],
	['Signed links', 'signedLinks', 'Enabled', 'Off'],
	['Confirmations', 'confirmations', 'Destructive tools ask', 'Off'],
	['Human handoff', 'humanHandoff', 'Enabled', 'Off'],
	['Secret provider', 'secretProvider', 'Configured', 'None'],
	['Git clone', 'sandboxClone', 'Available', 'Off'],
];

/** One opt-in capability's state from the diagnostics document. */
export function optInState(key: string, yes: string, no: string, config: unknown, diag: unknown): FeatureState {
	const raw = diagnosticsKey(config, diag, key);
	return key === 'sessionOwnership' ? ownershipState(raw) : featureState(raw, yes, no);
}

/** Whether a configuration row matches the filter: every word of the query in its name or value, any case. */
export function configRowMatches(query: string, name: string, value: string): boolean {
	const haystack = `${name} ${value}`.toLowerCase();
	return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}
