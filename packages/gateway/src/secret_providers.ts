/**
 * R15 (D-123): external secret providers — HashiCorp Vault KV v2 and 1Password Connect.
 *
 * `TTK_API_KEYS_REF` and `TTK_SECRETS_REF` name a secret a provider holds, in place of a `*_FILE` or an inline value.
 * `resolveSecrets` (secrets.ts) reads each one **once, at startup**, into the same logical key the `*_FILE` form fills,
 * so `loadConfig` never learns where a value came from and nothing downstream changes. Three rules shape this module:
 *
 * - **Fail closed.** A provider that cannot be reached, answers anything but 200, times out, redirects, sends more
 *   than 1 MiB or a body without the named key refuses the start. There is no cache and no fallback: a gateway that
 *   started without its API keys would be unreachable, and one without its browser secrets would type nothing.
 * - **Nothing secret in an error.** A failure names the variable, the provider and a status class or `timed out` —
 *   never the value, the token, or the reference's path, which itself describes how the operator laid secrets out.
 *   An underlying `fetch` error is never quoted: Deno's text for it carries the request URL, and so that path.
 * - **Nothing in `Deno.env`.** The provider token arrives by file (`TTK_VAULT_TOKEN_FILE`, `TTK_OP_CONNECT_TOKEN_FILE`)
 *   and is threaded by argument, because Chromium inherits this process's environment.
 *
 * This module imports nothing from the rest of the gateway: `config.ts` reads {@linkcode configuredSecretRefs} for the
 * diagnostics, and `secrets.ts` owns the orchestration (environment, files, `SecretError`).
 */

/** A parsed reference: which provider holds the secret, and where. */
export type SecretRef =
	| { readonly provider: 'vault'; readonly mount: string; readonly path: string; readonly key: string }
	| { readonly provider: '1password'; readonly vault: string; readonly item: string; readonly field: string };

/** The providers this build can read from. */
export type SecretProviderName = SecretRef['provider'];

/** One provider, read through `fetch` only (no SDK: no new dependency). */
export interface SecretProvider {
	readonly name: SecretProviderName;
	/** The secret's value, or a {@linkcode SecretProviderError} whose detail carries no secret and no path. */
	read(ref: SecretRef, signal: AbortSignal): Promise<string>;
}

/** `fetch` as the providers call it; injected by tests so no unit test ever opens a socket. */
export type SecretFetch = (input: URL, init: RequestInit & { client?: Deno.HttpClient }) => Promise<Response>;

/** The two reference variables, keyed by the logical secret each fills (the key a `*_FILE` would fill). */
export const SECRET_REF_VARS: Readonly<Record<string, string>> = {
	TTK_API_KEYS: 'TTK_API_KEYS_REF',
	TTK_SECRETS: 'TTK_SECRETS_REF',
};

/** How long one provider read may take, connection to last byte. */
export const PROVIDER_TIMEOUT_MS = 10_000;
/** The largest provider answer read; a Vault secret or a 1Password item is a few KiB. */
export const PROVIDER_BODY_LIMIT_BYTES = 1_048_576;

/**
 * A provider failure. `variable` and `source` name configuration only; `detail` is a fixed phrase or a status class.
 * `secrets.ts` turns it into its `SecretError` with the same three parts.
 */
export class SecretProviderError extends Error {
	constructor(readonly variable: string, readonly source: string, readonly detail: string) {
		super(`${variable} (${source}): ${detail}`);
		this.name = 'SecretProviderError';
	}
}

const REF_SHAPE = 'expected vault:<mount>/<path>#<key> or op:<vault-id>/<item-id>#<field>';
/** A Vault mount or path segment. Restricted so it never needs percent-encoding and can never climb (`.`, `..`). */
const VAULT_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,127}$/;
/** A 1Password Connect vault or item id (26 base-32 characters in practice; held a little wider). */
const OP_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A key, field or namespace: 1 to `max` characters, none of them a C0 control character or DEL. */
function printable(value: string, max: number): boolean {
	if (value.length === 0 || value.length > max) return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/**
 * Parses a `*_REF` value. The error never repeats the value: a reference is configuration, but its path describes the
 * operator's secret layout, and an error message ends up in container logs.
 */
export function parseSecretRef(variable: string, raw: string): SecretRef {
	const refuse = (): never => {
		throw new SecretProviderError(variable, 'reference', `not a secret reference; ${REF_SHAPE}`);
	};
	const value = raw.trim();
	const hash = value.indexOf('#');
	if (hash < 0) return refuse();
	const name = value.slice(hash + 1);
	if (!printable(name, 256)) return refuse();
	if (value.startsWith('vault:')) {
		const segments = value.slice('vault:'.length, hash).split('/');
		if (segments.length < 2 || segments.length > 32) return refuse();
		if (!segments.every((segment) => VAULT_SEGMENT.test(segment) && segment !== '..')) return refuse();
		return { provider: 'vault', mount: segments[0]!, path: segments.slice(1).join('/'), key: name };
	}
	if (value.startsWith('op:')) {
		const segments = value.slice('op:'.length, hash).split('/');
		if (segments.length !== 2 || !segments.every((segment) => OP_ID.test(segment))) return refuse();
		return { provider: '1password', vault: segments[0]!, item: segments[1]!, field: name };
	}
	return refuse();
}

/** The provider a reference names, from its prefix alone — for diagnostics, which must never fail on a typo. */
function providerOf(raw: string | undefined): SecretProviderName | null {
	const value = raw?.trim() ?? '';
	if (value.startsWith('vault:')) return 'vault';
	if (value.startsWith('op:')) return '1password';
	return null;
}

/**
 * The references configured in `env`, as variable and provider name only. Read by `config.ts` for the admin
 * diagnostics and by `doctor`; the full parse (and every refusal) happens in `resolveSecrets`.
 */
export function configuredSecretRefs(
	env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<{ readonly variable: string; readonly provider: SecretProviderName }> {
	const found: { variable: string; provider: SecretProviderName }[] = [];
	for (const variable of Object.values(SECRET_REF_VARS)) {
		const provider = providerOf(env[variable]);
		if (provider !== null) found.push({ variable, provider });
	}
	return found;
}

/**
 * What `doctor` prints for the references: one line each, naming the variable and the provider, never the reference.
 * `doctor` holds no net grant and resolves with `contactProviders: false`, so it says exactly that.
 */
export function describeSecretRefs(env: Readonly<Record<string, string | undefined>>): string[] {
	return configuredSecretRefs(env).map(({ variable, provider }) =>
		`secret provider ${provider} for ${variable}: configured, not contacted`
	);
}

/** Whether a URL hostname is a loopback name, where plain `http://` is allowed (a local agent or a dev Vault). */
function loopbackHostname(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * A provider address (`TTK_VAULT_ADDR`, `TTK_OP_CONNECT_URL`): `https://`, or `http://` on loopback only, with no
 * credentials, query or fragment. A trailing slash is dropped so the API path joins cleanly.
 */
export function parseProviderAddress(variable: string, raw: string): URL {
	const url = URL.parse(raw.trim());
	const refuse = (detail: string): never => {
		throw new SecretProviderError(variable, 'address', detail);
	};
	if (url === null) return refuse('not a URL');
	if (url.username !== '' || url.password !== '') {
		return refuse('must not carry credentials; the token comes from a file');
	}
	if (url.search !== '' || url.hash !== '') return refuse('must not carry a query or a fragment');
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHostname(url.hostname))) {
		return refuse('must be an https:// URL (http:// only on loopback)');
	}
	if (url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
	return url;
}

/** `TTK_VAULT_NAMESPACE`: a header value, so bounded and free of control characters. */
export function parseVaultNamespace(raw: string): string {
	const value = raw.trim();
	if (!printable(value, 128)) {
		throw new SecretProviderError('TTK_VAULT_NAMESPACE', 'namespace', 'at most 128 printable characters');
	}
	return value;
}

/** A failure inside one provider read; `secrets.ts` names the variable it was reading for. */
export class ProviderReadError extends Error {
	constructor(readonly detail: string) {
		super(detail);
		this.name = 'ProviderReadError';
	}
}

interface ProviderOptions {
	/** The parsed address ({@linkcode parseProviderAddress}). */
	readonly url: URL;
	/** The provider token, read from its file. Sent in one header and never anywhere else. */
	readonly token: string;
	readonly fetch?: SecretFetch;
	/** `Deno.createHttpClient({ caCerts })` for a private CA (`TTK_SECRET_PROVIDER_CA_FILE`). */
	readonly client?: Deno.HttpClient;
	/** Tests only: the read bound, {@linkcode PROVIDER_TIMEOUT_MS} otherwise. Never from configuration. */
	readonly timeoutMs?: number;
}

/** `url` + path segments that {@linkcode parseSecretRef} already restricted to characters needing no encoding. */
function apiUrl(base: URL, segments: readonly string[]): URL {
	const url = new URL(base.href);
	// An origin's pathname is `/` however it was written, so the prefix is joined without its trailing slashes.
	url.pathname = `${base.pathname.replace(/\/+$/, '')}/${segments.join('/')}`;
	return url;
}

/** Reads a body up to the limit, or refuses; a provider that streams forever is cut off by the read's own timer. */
async function boundedJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get('content-length') ?? NaN);
	if (Number.isFinite(declared) && declared > PROVIDER_BODY_LIMIT_BYTES) {
		await response.body?.cancel().catch(() => {});
		throw new ProviderReadError('answered more than 1 MiB');
	}
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (reader !== undefined) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > PROVIDER_BODY_LIMIT_BYTES) throw new ProviderReadError('answered more than 1 MiB');
			chunks.push(value);
		}
	} finally {
		await reader?.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new ProviderReadError('answered a body that is not JSON');
	}
}

/**
 * One GET against a provider: no redirects (a redirect could carry the token's request to another host), a
 * {@linkcode PROVIDER_TIMEOUT_MS} bound on the whole exchange, and failures reduced to a fixed phrase or a status
 * class. The timer is a plain `setTimeout` cleared in `finally`, so a test's op sanitizer sees nothing left behind.
 */
async function getJson(
	options: ProviderOptions,
	url: URL,
	headers: HeadersInit,
	signal: AbortSignal,
): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
	const timedOut = `timed out after ${timeoutMs / 1000} s`;
	const timer = new AbortController();
	const handle = setTimeout(() => timer.abort(), timeoutMs);
	const combined = AbortSignal.any([signal, timer.signal]);
	try {
		let response: Response;
		try {
			response = await (options.fetch ?? fetch)(url, {
				method: 'GET',
				headers,
				redirect: 'error',
				signal: combined,
				...(options.client === undefined ? {} : { client: options.client }),
			});
		} catch (cause) {
			if (timer.signal.aborted) throw new ProviderReadError(timedOut);
			if (signal.aborted) throw new ProviderReadError('cancelled');
			if (cause instanceof Deno.errors.NotCapable || cause instanceof Deno.errors.PermissionDenied) {
				throw new ProviderReadError('this process holds no --allow-net grant for the provider address');
			}
			// Never the cause's text: Deno names the request URL in it, and the URL carries the reference's path.
			throw new ProviderReadError('unreachable, redirected, or its TLS certificate was not trusted');
		}
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			throw new ProviderReadError(`answered ${Math.floor(response.status / 100)}xx`);
		}
		try {
			return await boundedJson(response);
		} catch (cause) {
			if (cause instanceof ProviderReadError) throw cause;
			if (timer.signal.aborted) throw new ProviderReadError(timedOut);
			throw new ProviderReadError('the answer could not be read');
		}
	} finally {
		clearTimeout(handle);
	}
}

/** A JSON object, or `null`. */
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * HashiCorp Vault, KV secrets engine version 2: `GET {addr}/v1/{mount}/data/{path}` with `X-Vault-Token` (and
 * `X-Vault-Namespace` on Enterprise); the value is `data.data[key]`. A string is taken as written; an object or array
 * (a JSON document stored structured) is serialized, so `TTK_SECRETS` may live in Vault either way.
 */
export class VaultKv2Provider implements SecretProvider {
	readonly name = 'vault' as const;
	readonly #options: ProviderOptions & { readonly namespace?: string };

	constructor(options: ProviderOptions & { readonly namespace?: string }) {
		this.#options = options;
	}

	async read(ref: SecretRef, signal: AbortSignal): Promise<string> {
		if (ref.provider !== 'vault') throw new ProviderReadError('the reference names another provider');
		const url = apiUrl(this.#options.url, ['v1', ref.mount, 'data', ...ref.path.split('/')]);
		const headers: Record<string, string> = { accept: 'application/json', 'x-vault-token': this.#options.token };
		if (this.#options.namespace !== undefined) headers['x-vault-namespace'] = this.#options.namespace;
		const body = record(await getJson(this.#options, url, headers, signal));
		const data = record(record(body?.data)?.data);
		if (data === null) throw new ProviderReadError('the secret has no current version');
		if (!Object.hasOwn(data, ref.key)) throw new ProviderReadError('the secret has no such key');
		const value = data[ref.key];
		if (typeof value === 'string') return value;
		if (value !== null && typeof value === 'object') return JSON.stringify(value);
		throw new ProviderReadError('the key does not hold text or a JSON document');
	}
}

/**
 * 1Password Connect: `GET {url}/v1/vaults/{vault}/items/{item}` with a bearer token; the value is the field whose `id`
 * equals the reference's field, or else the one field whose `label` does. Two fields sharing that label is refused
 * rather than guessed between.
 */
export class OnePasswordConnectProvider implements SecretProvider {
	readonly name = '1password' as const;
	readonly #options: ProviderOptions;

	constructor(options: ProviderOptions) {
		this.#options = options;
	}

	async read(ref: SecretRef, signal: AbortSignal): Promise<string> {
		if (ref.provider !== '1password') throw new ProviderReadError('the reference names another provider');
		const url = apiUrl(this.#options.url, ['v1', 'vaults', ref.vault, 'items', ref.item]);
		const body = record(
			await getJson(
				this.#options,
				url,
				{ accept: 'application/json', authorization: `Bearer ${this.#options.token}` },
				signal,
			),
		);
		const fields = Array.isArray(body?.fields) ? body.fields.map(record).filter((field) => field !== null) : [];
		const byId = fields.find((field) => field.id === ref.field);
		const byLabel = fields.filter((field) => field.label === ref.field);
		if (byId === undefined && byLabel.length > 1) throw new ProviderReadError('more than one field carries that label');
		const field = byId ?? byLabel[0];
		if (field === undefined) throw new ProviderReadError('the item has no such field');
		if (typeof field.value !== 'string' || field.value === '') throw new ProviderReadError('the field holds no text');
		return field.value;
	}
}
