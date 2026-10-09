/**
 * @module
 * Where the opt-in real-model test leg gets its model.
 *
 * The R1/R2 suites run twice: once against deterministic responders that read
 * the prompt (which prove the observation pipeline), and once against a real
 * model (which proves the prompts are ones a model can actually act on). Only
 * the second leg needs credentials, and it is skipped when there are none.
 *
 * Two shapes are supported, because the two that matter here are different:
 *
 *  - **an OpenAI-compatible endpoint** — a local vLLM/llama.cpp/Ollama server,
 *    or any hosted API that speaks `/v1/chat/completions`;
 *  - **the Anthropic Messages API**, kept because it needs no local server.
 *
 * ## Why a file and not only environment variables
 *
 * A local endpoint is three coupled values — base URL, key, model id — and one
 * of them is a credential. Spreading those across a shell profile makes it easy
 * to run the leg against a model you did not mean to, and easy to paste a key
 * into a task string that ends up in a shell history. A small file names all
 * three in one place, is found without any setup, and is git-ignored.
 *
 * The file is the plain `key: value` form:
 *
 * ```
 * BaseURL: http://127.0.0.1:8000/v1
 * api_key: local
 * model: your-model-id
 * ```
 *
 * **More than one model may be listed**, as `model_1`, `model_2`, … or as a
 * comma-separated `models:`. The real-model suites then run once per model.
 * That is worth the wall-clock: models differ in exactly the ways this server's
 * prompts have to survive — one of the two here reasons before it answers and
 * the other does not, and a reply shape only the smaller one produces is what
 * found E-28.
 *
 * ## Why this lives in `scripts/`
 *
 * `deno.json` has to resolve the same endpoint *before* the tests run, to build
 * the `--allow-net` and `--allow-read` grants for it (`tier_paths.ts`). One
 * resolver serves both, so the host the tier is permitted to reach and the host
 * it actually calls cannot drift apart.
 */
import { fromFileUrl } from '@std/path/from-file-url';
import { resolve } from '@std/path/resolve';

/** The resolved endpoint for the real-model leg. */
export interface ModelEndpoint {
	/** Which wire protocol to speak. */
	readonly kind: 'openai' | 'anthropic';
	/** Base URL including the version segment, no trailing slash. */
	readonly baseUrl: string;
	readonly apiKey: string;
	/** Every model to exercise, in the order the configuration listed them. Never empty. */
	readonly models: readonly string[];
	/** `host:port` for `--allow-net`. */
	readonly netAuthority: string;
	/** Where these settings came from — named in the announce line, never the key. */
	readonly source: string;
	/** The config file backing this, when one was read. */
	readonly configPath?: string;
}

/** The config file's name, looked for in the repo root and then its parent. */
export const CONFIG_FILENAME = 'openai_compatible_api';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

function readEnv(name: string): string | undefined {
	try {
		const value = Deno.env.get(name);
		return value === undefined || value.trim() === '' ? undefined : value.trim();
	} catch {
		return undefined;
	}
}

/**
 * Parses the `key: value` config.
 *
 * Keys are matched loosely — `BaseURL`, `base_url` and `BASE-URL` are one key —
 * because the file is written by hand and a silent miss would present as "no
 * real model configured", which is indistinguishable from not having one.
 */
export function parseConfig(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
		const split = line.indexOf(':');
		if (split < 0) continue;
		const key = line.slice(0, split).toLowerCase().replace(/[^a-z0-9]/g, '');
		const value = line.slice(split + 1).trim().replace(/^["']|["']$/g, '');
		if (key !== '' && value !== '') out[key] = value;
	}
	return out;
}

function pick(config: Record<string, string>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = config[key];
		if (value !== undefined && value !== '') return value;
	}
	return undefined;
}

/** Splits a comma- or whitespace-separated list, dropping empties. */
function list(value: string | undefined): string[] {
	return (value ?? '').split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * Every model the configuration names, in the order it named them.
 *
 * Accepts `model`, a comma-separated `models`, and any number of numbered keys
 * (`model_1`, `model2`, `model-3`), which is how the same file grows from one
 * model to several without a format change. Numbered keys sort numerically, so
 * `model_10` follows `model_9` rather than `model_1`.
 */
function modelsFrom(config: Record<string, string>): string[] {
	const numbered = Object.keys(config)
		.map((key) => ({ key, index: /^model(\d+)$/.exec(key) }))
		.filter((entry): entry is { key: string; index: RegExpExecArray } => entry.index !== null)
		.sort((a, b) => Number(a.index[1]) - Number(b.index[1]))
		.map((entry) => config[entry.key] ?? '');

	const ordered = [
		...list(pick(config, 'model', 'modelname', 'modelid')),
		...list(pick(config, 'models')),
		...numbered.flatMap((value) => list(value)),
	];
	return [...new Set(ordered)];
}

/** The repo root, derived from this module rather than from the cwd. */
function repoRoot(): string {
	return fromFileUrl(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');
}

/**
 * The config file on this host, or `null`.
 *
 * An explicit `TTK_MODEL_CONFIG` wins; otherwise the repo root and then its
 * parent, so a checkout sitting beside the file finds it with no setup.
 */
export function findConfigFile(): string | null {
	const configured = readEnv('TTK_MODEL_CONFIG');
	if (configured !== undefined) {
		if (exists(configured)) return resolve(configured);
		// Said out loud rather than swallowed. A typo here would otherwise present
		// as "no real model is configured", which is indistinguishable from not
		// having one — and the leg would skip while looking like it had decided to.
		console.error(`TTK_MODEL_CONFIG points at ${configured}, which is not a readable file`);
		return null;
	}

	const root = repoRoot();
	// Resolved to a native, separator-consistent absolute path: this value is
	// interpolated into `--allow-read`, and a Windows path with a stray `/../`
	// in the middle is a grant nobody can check by reading it.
	for (const candidate of [resolve(root, CONFIG_FILENAME), resolve(root, '..', CONFIG_FILENAME)]) {
		if (exists(candidate)) return candidate;
	}
	return null;
}

function exists(path: string): boolean {
	try {
		return Deno.statSync(path).isFile;
	} catch {
		// Includes the not-granted case: an unreadable path is, for this purpose,
		// the same as an absent one.
		return false;
	}
}

/** `host:port` as `--allow-net` spells it, or `null` when the URL will not parse. */
function authorityOf(baseUrl: string): string | null {
	try {
		return new URL(baseUrl).host;
	} catch {
		return null;
	}
}

/**
 * The endpoint this host is configured for, or `null`.
 *
 * Order: explicit environment, then the config file, then an Anthropic key.
 * Environment first so CI — which has no file — can point the leg anywhere
 * without one, and so a deliberate override is never shadowed by a file left
 * lying in the parent directory.
 */
export function resolveModelEndpoint(): ModelEndpoint | null {
	const envBase = readEnv('TTK_MODEL_BASE_URL');
	if (envBase !== undefined) {
		const authority = authorityOf(envBase);
		const models = list(readEnv('TTK_MODEL_NAME'));
		if (authority !== null) {
			return {
				kind: 'openai',
				baseUrl: envBase.replace(/\/+$/, ''),
				apiKey: readEnv('TTK_MODEL_API_KEY') ?? '',
				models: models.length > 0 ? models : ['default'],
				netAuthority: authority,
				source: 'TTK_MODEL_BASE_URL',
			};
		}
	}

	const path = findConfigFile();
	if (path !== null) {
		const config = parseConfig(readFile(path) ?? '');
		const base = pick(config, 'baseurl', 'url', 'endpoint', 'apibase');
		// An explicit `TTK_MODEL_NAME` narrows a multi-model file to one model
		// without editing it — useful for reproducing a failure on just the model
		// that failed.
		const models = list(readEnv('TTK_MODEL_NAME'));
		const configured = models.length > 0 ? models : modelsFrom(config);
		const authority = base === undefined ? null : authorityOf(base);
		if (base !== undefined && configured.length > 0 && authority !== null) {
			return {
				kind: 'openai',
				baseUrl: base.replace(/\/+$/, ''),
				apiKey: readEnv('TTK_MODEL_API_KEY') ?? pick(config, 'apikey', 'key', 'token') ?? '',
				models: configured,
				netAuthority: authority,
				source: path,
				configPath: path,
			};
		}
	}

	const anthropic = readEnv('ANTHROPIC_API_KEY');
	if (anthropic !== undefined) {
		const models = list(readEnv('TTK_MODEL_NAME'));
		return {
			kind: 'anthropic',
			baseUrl: ANTHROPIC_BASE,
			apiKey: anthropic,
			models: models.length > 0 ? models : [ANTHROPIC_MODEL],
			netAuthority: 'api.anthropic.com',
			source: 'ANTHROPIC_API_KEY',
		};
	}

	return null;
}

function readFile(path: string): string | null {
	try {
		return Deno.readTextFileSync(path);
	} catch {
		return null;
	}
}

/** One line naming what the leg will run against — the models and host, never the key. */
export function describeEndpoint(endpoint: ModelEndpoint): string {
	return `${endpoint.models.join(', ')} at ${endpoint.netAuthority} (${endpoint.kind}, from ${endpoint.source})`;
}
