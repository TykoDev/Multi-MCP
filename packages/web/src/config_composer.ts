/**
 * The configuration composer's generators (run model-providers-ui, frontend §2(a), design §4): pure functions from a
 * map of `TTK_*` values and a list of provider drafts to the four outputs the drawer shows — a `.env` block, a
 * Compose override, a providers file and a diff against what runs. Nothing here touches the DOM, the API or the
 * network: the drawer reads a form, calls these, and the only network effect on the System screen stays the
 * diagnostics poll. `config_composer_test.ts` reads this file and holds it to that.
 *
 * The composer never holds a key (design §4). A provider draft has no key field: the providers file carries the
 * placeholder `REPLACE_WITH_KEY` for the operator to replace on disk, or an `api_key_file` path it names.
 */
import {
	booleanOf,
	envValuesOf,
	isLoopbackHost,
	runningValue,
	settingOf,
	SETTINGS,
	widensReach,
} from './config_catalog.ts';

/** The one key placeholder a generated providers file carries. */
export const KEY_PLACEHOLDER = 'REPLACE_WITH_KEY';

/** Where the Compose secret for the providers file is mounted (backend §3). */
export const PROVIDERS_SECRET_PATH = '/run/secrets/ttk_model_providers';

/** A map of environment values, as the operator would set them. */
export type ConfigValues = Readonly<Record<string, string>>;

/** How a provider draft's key reaches the providers file: a placeholder to replace on disk, a file path, or none. */
export type ProviderKey =
	| { readonly mode: 'placeholder' }
	| { readonly mode: 'file'; readonly path: string }
	| { readonly mode: 'none' };

/** One provider as the drawer edits it. There is no field for a key, by design. */
export interface ProviderDraft {
	readonly id: string;
	readonly kind: 'openai' | 'anthropic';
	readonly baseUrl: string;
	readonly models: readonly string[];
	readonly defaultModel?: string;
	readonly key: ProviderKey;
	/** OpenAI's newer output-token parameter (design §3.12); local servers keep the default. */
	readonly maxTokensParam?: 'max_completion_tokens';
}

/** The key modes the drawer offers, in order; `providerKey` turns a choice into a {@linkcode ProviderKey}. */
export const KEY_MODES: ReadonlyArray<{ readonly id: ProviderKey['mode']; readonly label: string }> = [
	{ id: 'placeholder', label: 'REPLACE_WITH_KEY in the file' },
	{ id: 'file', label: 'A key file (path)' },
	{ id: 'none', label: 'No key (local server)' },
];

/** The path a file-mode key names, or `undefined` for the other modes (so a view never spells the mode). */
export function keyPathOf(key: ProviderKey): string | undefined {
	return key.mode === 'file' ? key.path : undefined;
}

/** A key choice from the drawer's select, with the path field's text; an unknown choice is the placeholder. */
export function providerKey(mode: string, path: string): ProviderKey {
	if (mode === 'file') return { mode: 'file', path };
	if (mode === 'none') return { mode: 'none' };
	return { mode: 'placeholder' };
}

/** A provider preset: the draft a "+ OpenAI" button adds. */
export interface ProviderPreset {
	readonly id: string;
	readonly label: string;
	readonly draft: ProviderDraft;
}

/** The provider presets, in the drawer's order (design §3.12: no Azure; OpenAI sets `max_completion_tokens`). */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		draft: {
			id: 'openai-main',
			kind: 'openai',
			baseUrl: 'https://api.openai.com/v1',
			models: ['gpt-4.1'],
			defaultModel: 'gpt-4.1',
			key: { mode: 'placeholder' },
			maxTokensParam: 'max_completion_tokens',
		},
	},
	{
		id: 'anthropic',
		label: 'Anthropic',
		draft: {
			id: 'anthropic-main',
			kind: 'anthropic',
			baseUrl: 'https://api.anthropic.com/v1',
			models: ['claude-sonnet-5-5'],
			defaultModel: 'claude-sonnet-5-5',
			key: { mode: 'placeholder' },
		},
	},
	{
		id: 'ollama',
		label: 'Ollama',
		draft: {
			id: 'ollama',
			kind: 'openai',
			baseUrl: 'http://127.0.0.1:11434/v1',
			models: ['llama3.1'],
			defaultModel: 'llama3.1',
			key: { mode: 'none' },
		},
	},
	{
		id: 'vllm',
		label: 'vLLM / llama.cpp',
		draft: {
			id: 'local',
			kind: 'openai',
			baseUrl: 'http://127.0.0.1:8000/v1',
			models: ['default'],
			defaultModel: 'default',
			key: { mode: 'none' },
		},
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		draft: {
			id: 'openrouter',
			kind: 'openai',
			baseUrl: 'https://openrouter.ai/api/v1',
			models: ['openai/gpt-4.1'],
			defaultModel: 'openai/gpt-4.1',
			key: { mode: 'placeholder' },
		},
	},
	{
		id: 'custom',
		label: 'Custom',
		draft: { id: 'custom', kind: 'openai', baseUrl: 'https://', models: [], key: { mode: 'placeholder' } },
	},
];

/** A deployment preset: a partial map applied over the running seed, and the providers it starts with. */
export interface ConfigPreset {
	readonly id: string;
	readonly label: string;
	readonly explain: string;
	readonly values: ConfigValues;
	readonly providers?: readonly ProviderDraft[];
}

/** The presets, in the drawer's order (frontend §2(a)); `running` is the seed alone. */
export const PRESETS: readonly ConfigPreset[] = [
	{
		id: 'loopback',
		label: 'Loopback dev',
		explain: 'Bound to this machine only, readable logs.',
		values: { TTK_HOST: '127.0.0.1', TTK_LOG_FORMAT: 'pretty' },
	},
	{
		id: 'lan',
		label: 'LAN with API keys',
		explain: 'Published on the network behind file-backed API keys.',
		values: {
			TTK_HOST: '0.0.0.0',
			TTK_BIND: '0.0.0.0',
			TTK_PUBLIC_URL: 'http://192.0.2.10:8787',
			TTK_API_KEYS_FILE: '/run/secrets/ttk_api_keys',
			TTK_ALLOWED_ORIGINS: '192.0.2.10',
		},
	},
	{
		id: 'cluster-edge',
		label: 'Cluster edge',
		explain: 'An edge node that forwards to browser nodes over a shared KV.',
		// D-150: a running single node reports owner, control and links on, and a cluster refuses each of them once it
		// is named — so the preset names the values a cluster runs instead of carrying the seed's into a refusal.
		values: {
			TTK_ROLE: 'edge',
			TTK_CLUSTER_KV: 'http://kv:4512',
			TTK_NODE_ID: 'edge-1',
			TTK_SESSION_OWNERSHIP: 'shared',
			TTK_MCP_APPS: 'off',
			TTK_SIGNED_LINKS: 'false',
		},
	},
	{
		id: 'agents-sandbox',
		label: 'Agents + sandbox',
		explain: 'The coding sandbox and the ACP agent runner, with persistent data.',
		values: {
			TTK_SANDBOX_URL: 'http://sandbox:8080',
			// D-151: the token the sandbox service generates, as docker-compose.yml mounts it; naming the operator's
			// /run/secrets/ttk_sandbox_token here would point the gateway away from the sandbox's own copy.
			TTK_SANDBOX_TOKEN_FILE: '/run/secrets/ttk-sandbox-token/token',
			TTK_AGENT_BRIDGE_URL: 'http://agent-runner:8789',
			TTK_AGENT_BRIDGE_TOKEN_FILE: '/run/secrets/ttk_agent_bridge_token',
			TTK_DATA_DIR: '/data',
		},
	},
	{
		id: 'model-providers',
		label: 'Model providers',
		explain: 'The built-in model agent on a providers file; grant model:invoke on the Users screen.',
		values: { TTK_MODEL_PROVIDERS_FILE: PROVIDERS_SECRET_PATH },
		providers: [PROVIDER_PRESETS[0]!.draft],
	},
	{
		id: 'running',
		label: 'Start from running',
		explain: 'Only what the diagnostics report.',
		values: {},
	},
];

/** The values a preset proposes over the running seed. */
export function applyPreset(seed: ConfigValues, preset: ConfigPreset): Record<string, string> {
	return { ...seed, ...preset.values };
}

// --- .env ------------------------------------------------------------------------------------------------------

/** A `.env` value: bare when it is plain, single-quoted otherwise. */
function envQuote(value: string): string {
	return /^[A-Za-z0-9_./:@,+=-]*$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The `.env` block: one line per value, in catalogue order; inline secrets are never written. */
export function composeEnv(values: ConfigValues): string {
	const lines: string[] = ['# Generated by the System screen; apply by restarting with these values.'];
	const named = new Set<string>();
	for (const setting of SETTINGS) {
		const value = values[setting.name];
		if (value === undefined) continue;
		named.add(setting.name);
		if (setting.secret) {
			lines.push(`# ${setting.name}: an inline secret is never written here; use ${setting.name}_FILE.`);
			continue;
		}
		lines.push(`${setting.name}=${envQuote(value)}`);
	}
	for (const [name, value] of Object.entries(values)) {
		if (!named.has(name) && /^[A-Z][A-Z0-9_]*$/.test(name)) lines.push(`${name}=${envQuote(value)}`);
	}
	return lines.join('\n') + '\n';
}

// --- compose ---------------------------------------------------------------------------------------------------

/** A YAML single-quoted scalar. */
function yamlQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** The Compose secret a `/run/secrets/<name>` path mounts, or `undefined` for any other path. */
function secretNameOf(path: string): string | undefined {
	const match = /^\/run\/secrets\/([a-z0-9_]+)$/.exec(path.trim());
	return match?.[1];
}

/**
 * The Compose override: the server's `environment:` and the `secrets:` its `/run/secrets/*` paths mount.
 *
 * D-151: it never restates the `command:`. The bundled image's `CMD` grants an unscoped `--allow-net`, which already
 * covers another `TTK_PORT` and every provider host, so a restated argv could only narrow the grant — and, naming the
 * bind, loopback and the provider hosts alone, would cut the gateway off from `sandbox:8080`, which docker-compose.yml
 * runs by default. The provider hosts are named in a comment instead, so the reader sees what the providers file will
 * have the gateway dial.
 */
export function composeCompose(values: ConfigValues, hosts: readonly string[]): string {
	const environment: string[] = [];
	const secrets = new Set<string>(['ttk_api_keys', 'ttk_admin_user']);
	for (const setting of SETTINGS) {
		const value = values[setting.name];
		if (value === undefined || setting.secret) continue;
		if (setting.section === 'compose') continue; // interpolated by Compose from .env, not set on the service
		if (setting.section === 'sandbox-service') continue; // the sandbox service's own settings, not the gateway's
		environment.push(`      ${setting.name}: ${yamlQuote(value)}`);
		if (setting.kind === 'secret-file') {
			const name = secretNameOf(value);
			if (name !== undefined) secrets.add(name);
		}
	}
	const lines: string[] = [
		'# Generated by the System screen; pair with the .env tab for TTK_BIND and TTK_PUBLIC_URL.',
		'services:',
		'  tykotech-mcp:',
		'    environment:',
		...(environment.length === 0 ? ['      {}'] : environment),
		`    secrets: [${[...secrets].join(', ')}]`,
	];
	lines.push(
		"    # command: unchanged — the image's CMD grants outbound net (D-151); restate it only to scope it back.",
	);
	if (hosts.length > 0) lines.push(`    # The providers file has the gateway dial: ${hosts.join(', ')}.`);
	const extra = [...secrets].filter((name) => name !== 'ttk_api_keys' && name !== 'ttk_admin_user');
	if (extra.length > 0) {
		lines.push('secrets:');
		for (const name of extra) lines.push(`  ${name}:`, `    file: ./secrets/${name}.json`);
	}
	return lines.join('\n') + '\n';
}

// --- providers file --------------------------------------------------------------------------------------------

/** `host:port` for a provider's base URL, the port defaulted by scheme; `undefined` when the URL does not parse. */
export function providerHost(baseUrl: string): string | undefined {
	const url = URL.parse(baseUrl.trim());
	if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') return undefined;
	const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
	return `${url.hostname}:${port}`;
}

/**
 * The hosts a scoped net grant must name for these providers, in order and without repeats; `127.0.0.1` is left
 * out because the image's grant already covers it.
 */
export function providerHosts(providers: readonly ProviderDraft[]): string[] {
	const hosts: string[] = [];
	for (const provider of providers) {
		const host = providerHost(provider.baseUrl);
		if (host === undefined || host.startsWith('127.0.0.1:') || hosts.includes(host)) continue;
		hosts.push(host);
	}
	return hosts;
}

/** True when the base URL is plain http to a host that is not loopback, which the file must admit with `allow_http`. */
export function needsAllowHttp(baseUrl: string): boolean {
	const url = URL.parse(baseUrl.trim());
	return url !== null && url.protocol === 'http:' && !isLoopbackHost(url.hostname);
}

/**
 * The providers file (backend §2.1, design §3.2): `version: 1`, the first provider as `default`, and one entry per
 * draft with `api_key: "REPLACE_WITH_KEY"` or an `api_key_file` path — never a key.
 */
export function composeProvidersFile(providers: readonly ProviderDraft[]): string {
	const entries = providers.map((provider) => {
		const entry: Record<string, unknown> = {
			id: provider.id,
			kind: provider.kind,
			base_url: provider.baseUrl.replace(/\/+$/, ''),
			models: [...provider.models],
		};
		if (provider.defaultModel !== undefined && provider.defaultModel !== '') {
			entry.default_model = provider.defaultModel;
		}
		if (provider.key.mode === 'placeholder') entry.api_key = KEY_PLACEHOLDER;
		else if (provider.key.mode === 'file') {
			entry.api_key_file = provider.key.path.trim() === '' ? `/run/secrets/${provider.id}_key` : provider.key.path;
		}
		if (needsAllowHttp(provider.baseUrl)) entry.allow_http = true;
		if (provider.maxTokensParam !== undefined) entry.max_tokens_param = provider.maxTokensParam;
		return entry;
	});
	const file: Record<string, unknown> = { version: 1 };
	if (entries.length > 0) file.default = entries[0]!.id;
	file.providers = entries;
	return JSON.stringify(file, null, 2) + '\n';
}

// --- diff ------------------------------------------------------------------------------------------------------

/** One row of the diff: a key whose proposed value differs from what runs, or one that cannot be compared. */
export interface ConfigDiffRow {
	readonly key: string;
	/** The running value; absent when the diagnostics do not report it. */
	readonly before?: string;
	readonly after: string;
	/** `differs` against a reported value; `cannot compare` when nothing reported maps to the key. */
	readonly compare: 'differs' | 'cannot compare';
	readonly reach: boolean;
}

/**
 * The proposed values against the diagnostics: a row for each key whose value differs from the reported one, and a
 * "cannot compare" row for each key the diagnostics do not report (never a guess that it runs at its default). A
 * key equal to what runs produces no row.
 */
export function diffAgainstRunning(values: ConfigValues, diag: unknown): ConfigDiffRow[] {
	const config = (diag as { config?: unknown } | null | undefined)?.config;
	const rows: ConfigDiffRow[] = [];
	const ordered = [
		...SETTINGS.map((setting) => setting.name).filter((name) => values[name] !== undefined),
		...Object.keys(values).filter((name) => settingOf(name) === undefined),
	];
	for (const key of ordered) {
		const after = values[key]!;
		const setting = settingOf(key);
		const reach = setting === undefined ? false : widensReach(setting, after);
		const running = setting === undefined ? { kind: 'none' as const } : runningValue(setting, config, diag);
		if (running.kind === 'reading' && running.reading.value !== undefined) {
			if (sameValue(running.reading.value, after)) continue;
			rows.push({ key, before: running.reading.value, after, compare: 'differs', reach });
		} else {
			rows.push({ key, after, compare: 'cannot compare', reach });
		}
	}
	return rows;
}

/** Two environment spellings of one value: booleans by meaning, lists without spacing, otherwise verbatim. */
function sameValue(a: string, b: string): boolean {
	if (a === b) return true;
	const boolA = booleanOf(a);
	const boolB = booleanOf(b);
	if (boolA !== undefined && boolB !== undefined) return boolA === boolB;
	const list = (value: string): string =>
		value.split(',').map((item) => item.trim()).filter((item) => item !== '').join(',');
	return list(a) === list(b);
}

// --- all four ----------------------------------------------------------------------------------------------------

export interface ComposerOutputs {
	readonly env: string;
	readonly compose: string;
	readonly providersFile: string;
	readonly diff: ConfigDiffRow[];
}

/** The four outputs for a form read-back and the provider drafts. */
export function composeOutputs(
	read: Readonly<Record<string, unknown>>,
	providers: readonly ProviderDraft[],
	diag: unknown,
): ComposerOutputs {
	const values = envValuesOf(read);
	return {
		env: composeEnv(values),
		compose: composeCompose(values, providerHosts(providers)),
		providersFile: composeProvidersFile(providers),
		diff: diffAgainstRunning(values, diag),
	};
}
