/**
 * @module
 * The model for the opt-in real-model test leg: environment first (`TTK_MODEL_BASE_URL`, `TTK_MODEL_API_KEY`,
 * `TTK_MODEL_NAME`), then a git-ignored `openai_compatible_api` file (`TTK_MODEL_CONFIG`, else the repo root or its
 * parent), then `ANTHROPIC_API_KEY`. The file is `key: value` lines (`BaseURL`, `api_key`, `model`, or several
 * models as `models:` / `model_1`, `model_2`, …). `tier_paths.ts` builds the tier's grants from the same answer, so
 * the host the tier may reach and the host it calls cannot drift apart.
 */
import { fromFileUrl } from '@std/path/from-file-url';
import { resolve } from '@std/path/resolve';

/** The resolved endpoint for the real-model leg. */
export interface ModelEndpoint {
	readonly kind: 'openai' | 'anthropic';
	/** Base URL including the version segment, no trailing slash. */
	readonly baseUrl: string;
	readonly apiKey: string;
	/** Every model to exercise, in configured order. Never empty. */
	readonly models: readonly string[];
	/** `host:port` for `--allow-net`. */
	readonly netAuthority: string;
	/** Where these settings came from (never the key). */
	readonly source: string;
	readonly configPath?: string;
}

/** The config file's name, looked for in the repo root and then its parent. */
const CONFIG_FILENAME = 'openai_compatible_api';

function readEnv(name: string): string | undefined {
	try {
		return Deno.env.get(name)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parses the `key: value` config. Keys match loosely (`BaseURL`, `base_url`, `BASE-URL` are one key): the file is
 * written by hand, and a silent miss would look like "no model configured".
 */
export function parseConfig(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const split = line.indexOf(':');
		if (line.startsWith('#') || line.startsWith('//') || split < 0) continue;
		const key = line.slice(0, split).toLowerCase().replace(/[^a-z0-9]/g, '');
		const value = line.slice(split + 1).trim().replace(/^["']|["']$/g, '');
		if (key !== '' && value !== '') out[key] = value;
	}
	return out;
}

const pick = (config: Record<string, string>, ...keys: string[]): string | undefined =>
	keys.map((key) => config[key]).find((value) => value !== undefined && value !== '');

const list = (value: string | undefined): string[] => (value ?? '').split(/[,\s]+/).filter((entry) => entry !== '');

/** `model`, `models` and numbered `model_N` keys (sorted numerically), deduplicated in order. */
function modelsFrom(config: Record<string, string>): string[] {
	const numbered = Object.keys(config)
		.map((key) => [key, /^model(\d+)$/.exec(key)?.[1]] as const)
		.filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
		.sort((a, b) => Number(a[1]) - Number(b[1]))
		.flatMap(([key]) => list(config[key]));
	return [
		...new Set([...list(pick(config, 'model', 'modelname', 'modelid')), ...list(pick(config, 'models')), ...numbered]),
	];
}

function isFile(path: string): boolean {
	try {
		return Deno.statSync(path).isFile;
	} catch {
		return false; // unreadable is, for this purpose, absent
	}
}

/** The config file on this host (an absolute native path, since it lands in `--allow-read`), or `null`. */
export function findConfigFile(): string | null {
	const configured = readEnv('TTK_MODEL_CONFIG');
	if (configured !== undefined) {
		if (isFile(configured)) return resolve(configured);
		// Said out loud: a typo would otherwise look like "no model configured" and the leg would skip silently.
		console.error(`TTK_MODEL_CONFIG points at ${configured}, which is not a readable file`);
		return null;
	}
	const root = fromFileUrl(new URL('../', import.meta.url));
	return [resolve(root, CONFIG_FILENAME), resolve(root, '..', CONFIG_FILENAME)].find(isFile) ?? null;
}

function authorityOf(baseUrl: string | undefined): string | null {
	try {
		return baseUrl === undefined ? null : new URL(baseUrl).host;
	} catch {
		return null;
	}
}

/** The endpoint this host is configured for, or `null`. `TTK_MODEL_NAME` narrows a multi-model file. */
export function resolveModelEndpoint(): ModelEndpoint | null {
	const named = list(readEnv('TTK_MODEL_NAME'));
	const envBase = readEnv('TTK_MODEL_BASE_URL');
	const envAuthority = authorityOf(envBase);
	if (envBase !== undefined && envAuthority !== null) {
		return {
			kind: 'openai',
			baseUrl: envBase.replace(/\/+$/, ''),
			apiKey: readEnv('TTK_MODEL_API_KEY') ?? '',
			models: named.length > 0 ? named : ['default'],
			netAuthority: envAuthority,
			source: 'TTK_MODEL_BASE_URL',
		};
	}

	const path = findConfigFile();
	if (path !== null) {
		let text = '';
		try {
			text = Deno.readTextFileSync(path);
		} catch { /* treated as empty */ }
		const config = parseConfig(text);
		const base = pick(config, 'baseurl', 'url', 'endpoint', 'apibase');
		const models = named.length > 0 ? named : modelsFrom(config);
		const authority = authorityOf(base);
		if (base !== undefined && models.length > 0 && authority !== null) {
			return {
				kind: 'openai',
				baseUrl: base.replace(/\/+$/, ''),
				apiKey: readEnv('TTK_MODEL_API_KEY') ?? pick(config, 'apikey', 'key', 'token') ?? '',
				models,
				netAuthority: authority,
				source: path,
				configPath: path,
			};
		}
	}

	const anthropic = readEnv('ANTHROPIC_API_KEY');
	if (anthropic === undefined) return null;
	return {
		kind: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		apiKey: anthropic,
		models: named.length > 0 ? named : ['claude-sonnet-5'],
		netAuthority: 'api.anthropic.com',
		source: 'ANTHROPIC_API_KEY',
	};
}

/** One line naming what the leg will run against — the models and host, never the key. */
export function describeEndpoint(endpoint: ModelEndpoint): string {
	return `${endpoint.models.join(', ')} at ${endpoint.netAuthority} (${endpoint.kind}, from ${endpoint.source})`;
}
