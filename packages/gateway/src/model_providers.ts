/**
 * D-143 (model-providers-ui): the operator's model providers file, `TTK_MODEL_PROVIDERS_FILE`.
 *
 * The file is the only place a model endpoint can be named (design §2.1, §3.2): no request, no tool and no UI
 * supplies one, so every rule here is an operator-side contract rather than a request filter. It is read the way
 * every `*_FILE` secret is read — through the reader `resolveSecrets` uses (`secretReader`), threaded by argument,
 * never `Deno.env` — and the one secret it carries (`api_key`, inline or from `api_key_file`) stays on
 * {@linkcode ModelProviderSettings} and reaches the provider client by argument only. No refusal ever carries a value:
 * each names a fixed phrase, the entry number and the field (`SPECS/SECURITY-AUTH.md` §7, D-123 R1-1).
 *
 * `base_url` is judged by the C2 predicate (design C2 as rewritten in r3, gate F21–F23): the host is classified from
 * parsed bytes with the head walk's own `parseIpv4`/`parseIpv6`, so an IPv4-mapped IPv6 literal and a non-canonical
 * IPv4 spelling fold exactly as `head.ts` folds them, and `isForbiddenIpv4`/`isForbiddenIpv6` serve as the
 * "not public" guard. Loopback, private and link-local are then told apart by a small range table; every forbidden
 * range the table does not name (CGNAT, `0/8`, multicast, benchmarking, `::`) falls to "public", the refused direction.
 */

import * as z from 'zod';
import { isAbsolute } from '@std/path';
import { isForbiddenIpv4, isForbiddenIpv6, parseIpv4, parseIpv6 } from '@tykotech/mcp';
import { serviceUrl } from './expansion_config.ts';
import { normalizeSecret, SecretError, secretReader } from './secrets.ts';

/** The variable, declared once; `scripts/check_tasks.ts` rule T6 carries a copy pinned equal to this. */
export const MODEL_PROVIDERS_ENV = 'TTK_MODEL_PROVIDERS_FILE';

/** The file's size cap, the peer-file precedent (`secrets.ts`). */
export const MODEL_PROVIDERS_FILE_MAX_BYTES = 128 * 1024;

/** The longest key accepted, in characters after `normalizeSecret`. */
export const MODEL_KEY_MAX_CHARS = 512;

/**
 * BUG-9: the key placeholder the SPA's config composer writes into a drafted file (`KEY_PLACEHOLDER` in
 * `packages/web/src/config_composer.ts`) for the operator to replace on disk. Exactly sixteen characters — long enough
 * to be redacted as if real — so a forgotten one would otherwise be admitted silently and sent as a bearer token.
 * Refused here by a fixed phrase; `tests/unit/placeholder_key_test.ts` pins the two literals equal.
 */
export const PLACEHOLDER_KEY = 'REPLACE_WITH_KEY';

/**
 * §3.12 (gate F12): the loop redacts a key from emitted text only from this length, the runtime's delegation-token
 * threshold; a shorter key is admitted with one warning, because redacting a 4-character key would blank ordinary
 * prose.
 */
export const MODEL_KEY_REDACTION_MIN_CHARS = 16;

/** The per-provider bounds and defaults (backend §2.1). */
export const MODEL_PROVIDER_BOUNDS = {
	maxSteps: { default: 24, min: 1, max: 64 },
	maxOutputTokens: { default: 4096, min: 256, max: 32_768 },
	tokenBudget: { default: 400_000, min: 1000, max: 4_000_000 },
} as const;

/**
 * Header names an operator may not set: the ones the client owns (`authorization`, `x-api-key`), the ones a proxy
 * or a browser would treat as a credential, and any name that merely looks like one. A credential belongs in
 * `api_key`, where it is redacted and never rendered; refusing the shape keeps the one secret in the one place.
 */
export const REFUSED_HEADER_NAMES: readonly string[] = ['authorization', 'x-api-key', 'proxy-authorization', 'cookie'];
const REFUSED_HEADER_SUFFIXES: readonly string[] = ['-key', '-token', '-secret'];

/** A provider id. D-154: shared with the database's provider table, whose sealed keys are named by it. */
export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** A model name. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;

/** One provider as the file resolves it (backend §2.1). `apiKey` is the only secret and never leaves this type. */
export interface ModelProviderSettings {
	readonly id: string;
	readonly kind: 'openai' | 'anthropic';
	readonly label: string;
	/** `serviceUrl` rules plus the C2 scheme predicate; trailing slash stripped. */
	readonly baseUrl: string;
	/** `hostname[:port]`, never userinfo — the `--allow-net` spelling the grant proof queries. */
	readonly host: string;
	readonly models: readonly string[];
	readonly defaultModel: string;
	readonly apiKey: string | null;
	/**
	 * Where the key came from — all `doctor` may say about it, since the key itself is never rendered. D-154: `stored`
	 * is a key opened from the database's vault.
	 */
	readonly keySource: 'file' | 'inline' | 'stored' | 'none';
	readonly headers: Readonly<Record<string, string>>;
	/** C2: `http:` admitted to a private literal or a DNS name only with this flag; never with a key off-host. */
	readonly allowHttp: boolean;
	/** §3.12 (gate F16): which output-token parameter the OpenAI wire takes; `max_tokens` by default. */
	readonly maxTokensParam: 'max_tokens' | 'max_completion_tokens';
	readonly maxSteps: number;
	readonly maxOutputTokens: number;
	readonly tokenBudget: number;
}

/** The file, resolved. `default` is a member id, or `null` when several providers name none (§3.10, gate F19). */
export interface ModelProvidersConfig {
	readonly default: string | null;
	readonly providers: readonly ModelProviderSettings[];
	/**
	 * The trimmed path this was read from — the seed source the control plane names (D-154); never written. Absent on
	 * a configuration built in memory or read from the database.
	 */
	readonly file?: string;
}

/**
 * One provider as `GET /api/v1/agent/providers` and the diagnostics show it (§3.3): no key, no base URL path, no
 * header. `host` and `reason` are emitted only to a caller holding `model:invoke` (gate F9); the route strips them.
 */
export interface ProviderView {
	readonly id: string;
	readonly kind: 'openai' | 'anthropic';
	readonly label: string;
	readonly host: string;
	readonly models: readonly string[];
	readonly default_model: string;
	readonly reachable: boolean;
	readonly reason?: 'no-net-grant';
}

export interface LoadModelProvidersOptions {
	/** The reader `resolveSecrets` uses (`secretReader`); injected so tests need no filesystem. */
	readonly readFile?: (path: string) => Promise<string>;
	/**
	 * Receives one line per admitted `allow_http` provider and per key shorter than
	 * {@linkcode MODEL_KEY_REDACTION_MIN_CHARS}, only once the whole file has been admitted. Never a key.
	 */
	readonly warn?: (message: string) => void;
}

// --- the schema (shape only; every cross-field and value rule is judged below so the refusal names the field) ------

const ProviderSchema = z.object({
	id: z.string().regex(ID_PATTERN),
	kind: z.enum(['openai', 'anthropic']),
	label: z.string().min(1).max(64).optional(),
	base_url: z.string().min(1).max(2048),
	models: z.array(z.string().regex(MODEL_PATTERN)).min(1).max(64),
	default_model: z.string().min(1).max(128).optional(),
	// Typed only: the length, whitespace and emptiness rules are judged below, with phrases that never echo it.
	api_key: z.string().optional(),
	api_key_file: z.string().min(1).max(4096).optional(),
	headers: z.record(z.string(), z.string()).optional(),
	allow_http: z.boolean().optional(),
	max_tokens_param: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
	max_steps: z.number().int().min(MODEL_PROVIDER_BOUNDS.maxSteps.min).max(MODEL_PROVIDER_BOUNDS.maxSteps.max)
		.optional(),
	max_output_tokens: z.number().int().min(MODEL_PROVIDER_BOUNDS.maxOutputTokens.min)
		.max(MODEL_PROVIDER_BOUNDS.maxOutputTokens.max).optional(),
	token_budget: z.number().int().min(MODEL_PROVIDER_BOUNDS.tokenBudget.min).max(MODEL_PROVIDER_BOUNDS.tokenBudget.max)
		.optional(),
}).strict();

const FileSchema = z.object({
	version: z.literal(1),
	default: z.string().min(1).max(32).optional(),
	providers: z.array(ProviderSchema).min(1).max(16),
}).strict();

/** A zod issue as a fixed phrase: the code, never the input. D-154: shared with the control plane's body check. */
export function phraseOf(issue: z.core.$ZodIssue): string {
	switch (issue.code) {
		case 'invalid_type':
			return 'wrong type';
		case 'too_small':
			return 'too short or too few';
		case 'too_big':
			return 'too long or too many';
		case 'invalid_format':
			return 'malformed';
		case 'invalid_value':
			return 'not one of the allowed values';
		case 'unrecognized_keys':
			return `unknown field ${issue.keys.join(', ')}`;
		default:
			return 'invalid';
	}
}

/**
 * `entry N, field a.b[2]` from an issue path; the entry is 1-based, counting the `providers` array as written. D-153:
 * shared with the control plane's body check, whose `providers` array is numbered the same way.
 */
export function locate(path: readonly PropertyKey[]): string {
	const [root, index, ...rest] = path;
	if (root === 'providers' && typeof index === 'number') {
		const field = rest.length === 0
			? '(entry)'
			: rest.map((p, i) => typeof p === 'number' ? `[${p}]` : `${i === 0 ? '' : '.'}${String(p)}`).join('');
		return `entry ${index + 1}, field ${field}`;
	}
	return `field ${path.length === 0 ? '(file)' : path.map(String).join('.')}`;
}

// --- host classification (C2, gate F23) ----------------------------------------------------------------------------

/** What the C2 predicate needs to tell apart; `named` is any non-literal DNS name. */
export type HostClass = 'loopback' | 'private' | 'link-local' | 'public' | 'named';

function classifyIpv4(address: number): HostClass {
	// The head walk's guard decides "public" first; the table only tells the forbidden ranges apart.
	if (!isForbiddenIpv4(address)) return 'public';
	const a = Math.floor(address / 16_777_216) & 0xff;
	const b = Math.floor(address / 65_536) & 0xff;
	if (a === 127) return 'loopback';
	if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
	if (a === 169 && b === 254) return 'link-local';
	// CGNAT 100.64/10, 0/8, 192.0.0/24, 198.18/15 benchmarking, ≥224: forbidden by the walk, unnamed by C2 → refused.
	return 'public';
}

function classifyIpv6(bytes: Uint8Array): HostClass {
	if (!isForbiddenIpv6(bytes)) return 'public';
	const b = (i: number): number => bytes[i] ?? 0;
	const allZeroUpTo = (n: number): boolean => bytes.subarray(0, n).every((byte) => byte === 0);
	const embedded = (): number =>
		((bytes[12] ?? 0) * 16_777_216) + ((bytes[13] ?? 0) * 65_536) + ((bytes[14] ?? 0) * 256) + (bytes[15] ?? 0);
	if (allZeroUpTo(15) && b(15) === 1) return 'loopback'; // ::1
	// ::ffff:a.b.c.d and the deprecated ::ffff:0:a.b.c.d — judged as the IPv4 they embed, as `head.ts` does.
	if (allZeroUpTo(10) && b(10) === 0xff && b(11) === 0xff) return classifyIpv4(embedded());
	if (allZeroUpTo(8) && b(8) === 0xff && b(9) === 0xff && b(10) === 0 && b(11) === 0) return classifyIpv4(embedded());
	if (b(0) === 0xfe && (b(1) & 0xc0) === 0x80) return 'link-local'; // fe80::/10
	if ((b(0) & 0xfe) === 0xfc) return 'private'; // fc00::/7
	// `::`, 6to4 and NAT64 embeddings, multicast: forbidden by the walk, unnamed by C2 → refused.
	return 'public';
}

/**
 * Classifies a URL's `hostname` as the WHATWG parser serialised it: an IPv6 literal in brackets, an IPv4 literal in
 * canonical dotted form (`0x7f.1` has already become `127.0.0.1`), or a name. An unparsable literal is "public".
 */
export function classifyHost(hostname: string): HostClass {
	const host = hostname.toLowerCase();
	if (host.startsWith('[') && host.endsWith(']')) {
		const bytes = parseIpv6(host.slice(1, -1));
		return bytes === null ? 'public' : classifyIpv6(bytes);
	}
	const v4 = parseIpv4(host);
	if (v4 !== null) return classifyIpv4(v4);
	return host === 'localhost' ? 'loopback' : 'named';
}

/**
 * The C2 predicate over a parsed `base_url`. Returns the refusal phrase, or `null` when admitted, and which field the
 * refusal names: branches (i)–(iv) are the URL's, branch (v) is the flag's.
 */
export function judgeBaseUrl(
	url: URL,
	allowHttp: boolean,
	hasKey: boolean,
): { readonly field: 'base_url' | 'allow_http'; readonly phrase: string } | null {
	if (url.hostname.includes('*')) return { field: 'base_url', phrase: 'wildcard host' };
	const cls = classifyHost(url.hostname);
	// (i) exception and (iv): a link-local literal is refused on either scheme, whatever the flag.
	if (cls === 'link-local') return { field: 'base_url', phrase: 'link-local address' };
	if (url.protocol === 'http:') {
		// (iv): a public literal (and every unnamed forbidden range) over plaintext, whatever the flag.
		if (cls === 'public') return { field: 'base_url', phrase: 'plaintext HTTP to a public address' };
		// (ii) admits loopback without a flag; (iii) admits private literals and names only with it.
		if (cls !== 'loopback' && !allowHttp) return { field: 'base_url', phrase: 'plaintext HTTP needs allow_http' };
	}
	// (v): the flag and a key together are refused unless the host is loopback.
	if (allowHttp && hasKey && cls !== 'loopback') {
		return { field: 'allow_http', phrase: 'a key never travels in plaintext off the host' };
	}
	return null;
}

// --- the parser ---------------------------------------------------------------------------------------------------

/** The detail `normalizeSecret` put in a {@linkcode SecretError} for `path`, so it can be re-addressed to an entry. */
function detailOf(cause: unknown, path: string): string {
	const prefix = `${MODEL_PROVIDERS_ENV} (${path}): `;
	if (cause instanceof SecretError && cause.message.startsWith(prefix)) return cause.message.slice(prefix.length);
	return 'the key file is malformed';
}

/**
 * Reads and resolves `TTK_MODEL_PROVIDERS_FILE`. Unset → `null` (the feature is absent, as `secrets.ts` treats an
 * unset `*_FILE`). Every refusal is a {@linkcode SecretError} naming the variable, the file and a fixed phrase with the
 * entry and field at fault — never a key, a URL or any other value from the file. Warnings reach `options.warn` only
 * after the whole file is admitted, so a refused file leaves no half-report behind.
 */
export async function loadModelProviders(
	env: Readonly<Record<string, string | undefined>>,
	options: LoadModelProvidersOptions = {},
): Promise<ModelProvidersConfig | null> {
	const path = env[MODEL_PROVIDERS_ENV]?.trim();
	if (path === undefined || path === '') return null;
	// CR-5: the one secret reader (`secrets.ts`), injected or the runtime's — never a second default of its own.
	const read = secretReader(options.readFile);
	const refuse = (detail: string): SecretError => new SecretError(MODEL_PROVIDERS_ENV, path, detail);

	let raw: string;
	try {
		raw = await read(path);
	} catch {
		throw refuse('the file cannot be read');
	}
	if (new TextEncoder().encode(raw).byteLength > MODEL_PROVIDERS_FILE_MAX_BYTES) {
		throw refuse('the file is larger than 128 KiB');
	}
	// BUG-4: this file is operator-authored JSON, and an editor on Windows saves it with CRLF; `normalizeSecret` would
	// read the `\r` it leaves after the final line as trailing whitespace. Folded here, for this file only — a key
	// file is a single-line secret and keeps `secrets.ts`'s rule unchanged.
	let json: unknown;
	try {
		json = JSON.parse(normalizeSecret(raw.replaceAll('\r\n', '\n'), MODEL_PROVIDERS_ENV, path));
	} catch (cause) {
		if (cause instanceof SecretError) throw cause;
		throw refuse('the file is not valid JSON');
	}
	const config = await parseModelProviders(json, refuse, { readFile: read, warn: options.warn });
	return { ...config, file: path };
}

/**
 * D-154: the file's rules applied to a document already in memory — the providers file once read, or the rows of the
 * database's provider table with their keys opened from the vault (inline `api_key`). Every refusal is `refuse`'s
 * error with a fixed phrase naming the entry and field, never a value; warnings reach `options.warn` only once the
 * whole document is admitted.
 */
export async function parseModelProviders<E extends Error>(
	json: unknown,
	refuse: (detail: string) => E,
	options: { readonly readFile: (path: string) => Promise<string>; readonly warn?: (message: string) => void },
): Promise<ModelProvidersConfig> {
	const read = options.readFile;
	const parsed = FileSchema.safeParse(json);
	if (!parsed.success) {
		const issue = parsed.error.issues[0]!;
		throw refuse(`${phraseOf(issue)}, ${locate(issue.path)}`);
	}

	const warnings: string[] = [];
	const providers: ModelProviderSettings[] = [];
	const ids = new Set<string>();
	for (const [index, entry] of parsed.data.providers.entries()) {
		const fail = (field: string, phrase: string): E => refuse(`${phrase}, entry ${index + 1}, field ${field}`);
		if (ids.has(entry.id)) throw fail('id', 'duplicate provider id');
		ids.add(entry.id);

		// The key: at most one source; a file is read through the same reader as every other secret file.
		if (entry.api_key !== undefined && entry.api_key_file !== undefined) {
			throw fail('api_key', 'set one of api_key or api_key_file');
		}
		let apiKey: string | null = null;
		let keySource: ModelProviderSettings['keySource'] = 'none';
		let keyField = 'api_key';
		if (entry.api_key !== undefined) {
			apiKey = entry.api_key;
			keySource = 'inline';
		} else if (entry.api_key_file !== undefined) {
			keyField = 'api_key_file';
			if (!isAbsolute(entry.api_key_file)) throw fail(keyField, 'an absolute path is required');
			let keyRaw: string;
			try {
				keyRaw = await read(entry.api_key_file);
			} catch {
				throw fail(keyField, 'the key file cannot be read');
			}
			try {
				apiKey = normalizeSecret(keyRaw, MODEL_PROVIDERS_ENV, entry.api_key_file);
			} catch (cause) {
				throw fail(keyField, detailOf(cause, entry.api_key_file));
			}
			keySource = 'file';
		}
		if (apiKey !== null) {
			if (apiKey === '') throw fail(keyField, 'the key is empty');
			// BUG-9: the composer's placeholder, never a key; the phrase is fixed and the value is never echoed.
			if (apiKey === PLACEHOLDER_KEY) throw fail(keyField, 'the key is the composer placeholder');
			if (apiKey.length > MODEL_KEY_MAX_CHARS) {
				throw fail(keyField, `the key is longer than ${MODEL_KEY_MAX_CHARS} characters`);
			}
			if (/\s/.test(apiKey)) throw fail(keyField, 'the key contains whitespace');
			if (apiKey.length < MODEL_KEY_REDACTION_MIN_CHARS) {
				warnings.push(`model provider ${entry.id}: short key: not redacted from task output`);
			}
		}
		if (entry.kind === 'anthropic' && apiKey === null) throw fail('api_key', 'an anthropic provider needs a key');

		// Headers: a small, lower-case, credential-free set.
		const headers: Record<string, string> = {};
		const headerEntries = Object.entries(entry.headers ?? {});
		if (headerEntries.length > 8) throw fail('headers', 'more than 8 headers');
		for (const [name, value] of headerEntries) {
			if (!HEADER_NAME_PATTERN.test(name)) throw fail('headers', 'a header name is not lower-case [a-z0-9-]');
			const field = `headers.${name}`;
			if (REFUSED_HEADER_NAMES.includes(name) || REFUSED_HEADER_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
				throw fail(field, 'a credential header is refused; use api_key');
			}
			if (value.length > 256) throw fail(field, 'the value is longer than 256 characters');
			if (/[\r\n]/.test(value)) throw fail(field, 'the value contains a line break');
			headers[name] = value;
		}

		// The URL: the shared service rules, then the C2 predicate.
		let baseUrl: string;
		try {
			baseUrl = serviceUrl(entry.base_url);
		} catch {
			throw fail('base_url', 'an HTTP(S) URL without credentials, query or fragment is required');
		}
		const url = new URL(baseUrl);
		const allowHttp = entry.allow_http === true;
		const refusal = judgeBaseUrl(url, allowHttp, apiKey !== null);
		if (refusal !== null) throw fail(refusal.field, refusal.phrase);

		const defaultModel = entry.default_model ?? entry.models[0]!;
		if (!entry.models.includes(defaultModel)) throw fail('default_model', 'not one of the listed models');

		if (allowHttp) {
			warnings.push(`model provider ${entry.id}: allow_http is set, plaintext HTTP to ${url.host} is permitted`);
		}
		providers.push({
			id: entry.id,
			kind: entry.kind,
			label: entry.label ?? entry.id,
			baseUrl,
			host: url.host,
			models: [...entry.models],
			defaultModel,
			apiKey,
			keySource,
			headers,
			allowHttp,
			maxTokensParam: entry.max_tokens_param ?? 'max_tokens',
			maxSteps: entry.max_steps ?? MODEL_PROVIDER_BOUNDS.maxSteps.default,
			maxOutputTokens: entry.max_output_tokens ?? MODEL_PROVIDER_BOUNDS.maxOutputTokens.default,
			tokenBudget: entry.token_budget ?? MODEL_PROVIDER_BOUNDS.tokenBudget.default,
		});
	}

	// §3.10 (gate F19): a sole provider is the default; several without one leave `null`.
	let fallback: string | null;
	if (parsed.data.default !== undefined) {
		if (!ids.has(parsed.data.default)) throw refuse('default names no listed provider, field default');
		fallback = parsed.data.default;
	} else {
		fallback = providers.length === 1 ? providers[0]!.id : null;
	}

	for (const line of warnings) options.warn?.(line);
	return { default: fallback, providers };
}
