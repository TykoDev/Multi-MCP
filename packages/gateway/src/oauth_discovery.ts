/**
 * D-083: the identity provider's own authorization-server metadata (RFC 8414), fetched rather than invented.
 *
 * `/.well-known/oauth-authorization-server` used to answer with endpoints this server made up from the issuer —
 * `<issuer>/authorize` and `<issuer>/token` — which is right for almost no real provider (Keycloak, Entra, Okta and
 * Auth0 all use other paths), so a client that discovered from this server's base URL was sent to endpoints that
 * do not exist. The JWKS location was guessed the same way. Both now come from the provider's document:
 *
 * - RFC 8414 §3.1 first: `/.well-known/oauth-authorization-server` inserted between the host and the issuer's path;
 *   then OpenID Connect Discovery's `<issuer>/.well-known/openid-configuration`, which most providers publish.
 * - The document's `issuer` must equal the configured issuer exactly (RFC 8414 §3.3): a document naming another
 *   issuer is refused, so a misconfigured or hostile endpoint cannot redirect clients to someone else's server.
 * - Bounded: 5 s per attempt, 64 KiB, no redirects, `https:` (or `http:` to a loopback provider in development).
 * - Cached for an hour; a failed refresh keeps the last good document, and a provider never reached is reported as
 *   unavailable rather than papered over with a guess.
 */

export const METADATA_MAX_BYTES = 64 * 1024;
export const METADATA_TTL_MS = 60 * 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 5_000;
/** After a failure, how long before the provider is asked again. */
const RETRY_AFTER_FAILURE_MS = 30_000;

export type AuthorizationServerMetadata = Record<string, unknown> & { issuer: string };

/** The places RFC 8414 and OpenID Connect Discovery put the document for `issuer`, in the order they are tried. */
export function metadataUrls(issuer: URL): URL[] {
	const path = issuer.pathname.replace(/\/$/, '');
	return [
		new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
		new URL(`${path}/.well-known/openid-configuration`, issuer.origin),
	];
}

function allowedScheme(url: URL): boolean {
	if (url.protocol === 'https:') return true;
	return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** The issuer as configured and as a document states it compare equal with or without a trailing slash. */
function sameIssuer(stated: string, configured: URL): boolean {
	const trim = (value: string) => value.replace(/\/$/, '');
	return trim(stated) === trim(configured.href);
}

async function readBounded(response: Response): Promise<string | null> {
	if (response.body === null) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > METADATA_MAX_BYTES) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return new TextDecoder().decode(bytes);
}

export class IssuerMetadata {
	readonly #issuer: URL;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#document: AuthorizationServerMetadata | null = null;
	#fetchedAt = 0;
	#failedAt = -Infinity;
	#pending: Promise<AuthorizationServerMetadata | null> | null = null;
	#lastError = '';

	constructor(issuer: URL, options: { fetch?: typeof fetch; now?: () => number } = {}) {
		this.#issuer = issuer;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	/** Why the last attempt failed, for the log; empty after a success. */
	get lastError(): string {
		return this.#lastError;
	}

	/** The provider's document: cached, refreshed when stale, the last good copy when a refresh fails; else null. */
	get(): Promise<AuthorizationServerMetadata | null> {
		const now = this.#now();
		if (this.#document !== null && now - this.#fetchedAt < METADATA_TTL_MS) return Promise.resolve(this.#document);
		if (now - this.#failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(this.#document);
		this.#pending ??= this.#load().finally(() => this.#pending = null);
		return this.#pending;
	}

	/** The JWKS location the document names, or null when there is no document or it names none usable. */
	async jwksUri(): Promise<URL | null> {
		const document = await this.get();
		const raw = document?.jwks_uri;
		if (typeof raw !== 'string') return null;
		try {
			const url = new URL(raw);
			return allowedScheme(url) ? url : null;
		} catch {
			return null;
		}
	}

	async #load(): Promise<AuthorizationServerMetadata | null> {
		const problems: string[] = [];
		for (const url of metadataUrls(this.#issuer)) {
			if (!allowedScheme(url)) {
				problems.push(`${url.href}: only https (or http to loopback) is fetched`);
				continue;
			}
			try {
				const response = await this.#fetch(url, {
					redirect: 'error',
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
				});
				if (!response.ok) {
					await response.body?.cancel();
					problems.push(`${url.href}: HTTP ${response.status}`);
					continue;
				}
				const text = await readBounded(response);
				if (text === null) {
					problems.push(`${url.href}: larger than ${METADATA_MAX_BYTES} bytes`);
					continue;
				}
				const parsed: unknown = JSON.parse(text);
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					problems.push(`${url.href}: not a JSON object`);
					continue;
				}
				const stated = (parsed as Record<string, unknown>).issuer;
				if (typeof stated !== 'string' || !sameIssuer(stated, this.#issuer)) {
					problems.push(`${url.href}: names issuer ${JSON.stringify(stated)}, not ${this.#issuer.href}`);
					continue;
				}
				this.#document = parsed as AuthorizationServerMetadata;
				this.#fetchedAt = this.#now();
				this.#lastError = '';
				return this.#document;
			} catch (cause) {
				problems.push(`${url.href}: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		}
		this.#failedAt = this.#now();
		this.#lastError = problems.join('; ');
		return this.#document;
	}
}
