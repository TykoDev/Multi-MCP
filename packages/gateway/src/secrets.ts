/**
 * Secret resolution from `*_FILE` variables, and (R15, D-123) from the `*_REF` provider references
 * `secret_providers.ts` reads.
 *
 * Values are returned to the caller and threaded by argument; they are never
 * written back into `Deno.env`. Chromium inherits this process's environment,
 * so a secret placed there would be readable from the browser's
 * `/proc/self/environ` — the one place a hostile page might reach.
 *
 * See SPECS/SECURITY-AUTH.md §7.
 */

import { join } from '@std/path';
import { encodeBase64Url } from '@std/encoding/base64url';
import { PeerFileSchema, serviceUrl } from './expansion_config.ts';
import type { Vault } from './vault.ts';
import {
	OnePasswordConnectProvider,
	parseProviderAddress,
	parseSecretRef,
	parseVaultNamespace,
	ProviderReadError,
	SECRET_REF_VARS,
	type SecretFetch,
	type SecretProvider,
	SecretProviderError,
	type SecretProviderName,
	type SecretRef,
	VaultKv2Provider,
} from './secret_providers.ts';

/**
 * Variables that may be supplied indirectly, mapped to their `_FILE` form.
 *
 * Not listed, because they have no inline form and resolve to something other than one string: `TTK_AGENT_PEERS_FILE`
 * (below) and `TTK_MODEL_PROVIDERS_FILE` (D-143, `model_providers.ts`). The latter is read by `loadModelProviders`
 * through the same reader as these — {@linkcode secretReader} — so a test that fakes the disk fakes it once.
 */
export const SECRET_FILE_VARS: Readonly<Record<string, string>> = {
	TTK_API_KEYS: 'TTK_API_KEYS_FILE',
	// R14: the browser-typed credentials. Same file-over-environment rule as the
	// API keys — a value in a file never appears in `docker inspect`, in a process
	// listing, or in the environment Chromium inherits.
	TTK_SECRETS: 'TTK_SECRETS_FILE',
	TTK_SANDBOX_TOKEN: 'TTK_SANDBOX_TOKEN_FILE',
	TTK_AGENT_BRIDGE_TOKEN: 'TTK_AGENT_BRIDGE_TOKEN_FILE',
	TTK_ADMIN_USER: 'TTK_ADMIN_USER_FILE',
};

/**
 * Where the administrator record is read from when neither `TTK_ADMIN_USER` nor `TTK_ADMIN_USER_FILE` is set:
 * the file `doctor --new-admin` writes, relative to the working directory.
 */
export const DEFAULT_ADMIN_USER_FILE = 'secrets/ttk_admin_user.json';

export class SecretError extends Error {
	constructor(variable: string, path: string, detail: string) {
		super(`${variable} (${path}): ${detail}`);
		this.name = 'SecretError';
	}
}

/**
 * Normalises one secret file's contents.
 *
 * Exactly one trailing newline is stripped. Anything else — a second line,
 * surrounding whitespace, a BOM — is refused rather than repaired: silently
 * trimming a secret hides the difference between a well-formed file and a
 * corrupted one until it fails as an authentication error much later.
 */
export function normalizeSecret(raw: string, variable: string, path: string): string {
	if (raw.startsWith('﻿')) throw new SecretError(variable, path, 'file begins with a byte-order mark');
	const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
	if (value.includes('\n')) {
		// JSON secrets are legitimately multi-line; only refuse trailing junk.
		const trimmed = value.replace(/\s+$/, '');
		if (trimmed !== value) throw new SecretError(variable, path, 'trailing whitespace after the final line');
		return value;
	}
	if (value.trim() !== value) throw new SecretError(variable, path, 'leading or trailing whitespace');
	if (value === '') throw new SecretError(variable, path, 'file is empty');
	return value;
}

export interface ResolveSecretsOptions {
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Injected so tests need no filesystem. */
	readonly readFile?: (path: string) => Promise<string>;
	/** R15 (D-123): the provider transport; injected so tests need no network. Defaults to `fetch`. */
	readonly fetch?: SecretFetch;
	/**
	 * R15 (D-123): whether `*_REF` secrets are read from their provider. Default `true`. `doctor` passes `false`: it
	 * checks every reference and provider setting but contacts nothing and reads no token, and says so.
	 */
	readonly contactProviders?: boolean;
}

/**
 * The reader every secret file goes through: the injected one, else the runtime's. Exported so the CLI hands the one
 * reader to both {@linkcode resolveSecrets} and `loadModelProviders` (D-143), and a test fakes one disk for both.
 */
export function secretReader(readFile?: ResolveSecretsOptions['readFile']): (path: string) => Promise<string> {
	return readFile ?? ((path: string) => Deno.readTextFile(path));
}

/**
 * Reads every configured `*_FILE` secret.
 *
 * @returns a map keyed by the *logical* variable name (e.g. `TTK_API_KEYS`).
 */
export async function resolveSecrets(options: ResolveSecretsOptions): Promise<Record<string, string>> {
	const read = secretReader(options.readFile);
	// Review R1-7: every reference and provider setting is judged before any file is read. A configuration mistake
	// needs no file to report, and judging it after the reads made its refusal depend on the working directory — a
	// default administrator file that happened to be unreadable was reported in its place.
	const refs = planSecretRefs(options.env);
	const resolved: Record<string, string> = {};
	for (const [variable, fileVar] of Object.entries(SECRET_FILE_VARS)) {
		const path = options.env[fileVar]?.trim();
		if (path === undefined || path === '') continue;
		let raw: string;
		try {
			raw = await read(path);
		} catch (cause) {
			throw new SecretError(fileVar, path, cause instanceof Error ? cause.message : String(cause));
		}
		resolved[variable] = normalizeSecret(raw, fileVar, path);
	}
	// R10 (design §2.1, D-119): the link-signing key is file-only — there is no inline `TTK_SIGNED_LINK_KEY` for an
	// environment (and so Chromium's) to carry. Its length is `loadConfig`'s to refuse, naming the variable.
	const linkKeyPath = options.env.TTK_SIGNED_LINK_KEY_FILE?.trim();
	if (linkKeyPath !== undefined && linkKeyPath !== '') {
		let raw: string;
		try {
			raw = await read(linkKeyPath);
		} catch (cause) {
			throw new SecretError(
				'TTK_SIGNED_LINK_KEY_FILE',
				linkKeyPath,
				cause instanceof Error ? cause.message : String(cause),
			);
		}
		resolved.TTK_SIGNED_LINK_KEY = normalizeSecret(raw, 'TTK_SIGNED_LINK_KEY_FILE', linkKeyPath);
	}
	// D-154: the database key is file-only too — an inline form would put the key that opens every stored secret in
	// the environment Chromium inherits. Its encoding is `loadConfig`'s to refuse, naming the variable.
	const dbKeyPath = options.env.TTK_DB_KEY_FILE?.trim();
	if (dbKeyPath !== undefined && dbKeyPath !== '') {
		let raw: string;
		try {
			raw = await read(dbKeyPath);
		} catch (cause) {
			throw new SecretError('TTK_DB_KEY_FILE', dbKeyPath, cause instanceof Error ? cause.message : String(cause));
		}
		resolved.TTK_DB_KEY = normalizeSecret(raw, 'TTK_DB_KEY_FILE', dbKeyPath);
	}
	// C6 / D-099: the implicit default record file. Consulted only when neither form of the variable is set — an
	// operator who wrote `TTK_ADMIN_USER` inline must not have it collide with a file they never named — and silent
	// only when the file is genuinely absent. A file that exists and cannot be read or normalised refuses startup:
	// swallowing that used to start a server with no account and no word about why. A read the runtime's own
	// permission grant does not cover is "absent" (the grant, not the operator, decided it is out of reach).
	if (resolved.TTK_ADMIN_USER === undefined && !options.env.TTK_ADMIN_USER?.trim()) {
		let raw: string | null = null;
		try {
			raw = await read(DEFAULT_ADMIN_USER_FILE);
		} catch (cause) {
			if (!(cause instanceof Deno.errors.NotFound) && !(cause instanceof Deno.errors.NotCapable)) {
				throw new SecretError(
					'TTK_ADMIN_USER_FILE',
					DEFAULT_ADMIN_USER_FILE,
					cause instanceof Error ? cause.message : String(cause),
				);
			}
		}
		if (raw !== null) resolved.TTK_ADMIN_USER = normalizeSecret(raw, 'TTK_ADMIN_USER_FILE', DEFAULT_ADMIN_USER_FILE);
	}
	const peerPath = options.env.TTK_AGENT_PEERS_FILE?.trim();
	if (peerPath) {
		try {
			const raw = await read(peerPath);
			if (new TextEncoder().encode(raw).byteLength > 128 * 1024) throw new Error('peer file too large');
			const rows = PeerFileSchema.parse(JSON.parse(raw));
			if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('duplicate peer identifier');
			const peers = [];
			for (const row of rows) {
				const token = row.token_file === undefined
					? undefined
					: normalizeSecret(await read(row.token_file), 'peer token', row.token_file);
				if (token !== undefined && /\s/.test(token)) throw new Error('peer token contains whitespace');
				peers.push({ id: row.id, url: serviceUrl(row.url), ...(token === undefined ? {} : { token }) });
			}
			resolved.TTK_AGENT_PEERS = JSON.stringify(peers);
		} catch {
			throw new SecretError('TTK_AGENT_PEERS_FILE', peerPath, 'invalid peer file, endpoint, or token reference');
		}
	}
	// R15 (D-123): provider references fill the same logical keys, after every file, so `loadConfig` is untouched.
	if (refs !== null && options.contactProviders !== false) await readSecretRefs(refs, options, read, resolved);
	return resolved;
}

/** R15 (D-123): each provider's address and token-file variables. */
const PROVIDER_VARS: Readonly<Record<SecretProviderName, { readonly address: string; readonly tokenFile: string }>> = {
	vault: { address: 'TTK_VAULT_ADDR', tokenFile: 'TTK_VAULT_TOKEN_FILE' },
	'1password': { address: 'TTK_OP_CONNECT_URL', tokenFile: 'TTK_OP_CONNECT_TOKEN_FILE' },
};

/** R15 (D-123): what the configured references ask for, judged before anything is read ({@linkcode planSecretRefs}). */
interface SecretRefPlan {
	readonly wanted: readonly { readonly logical: string; readonly variable: string; readonly ref: SecretRef }[];
	readonly settings: ReadonlyMap<SecretProviderName, { readonly url: URL; readonly tokenPath: string }>;
	readonly namespace: string | undefined;
	readonly caPath: string | undefined;
}

/** A provider-layer refusal in the form `resolveSecrets` throws: a {@linkcode SecretError}, the same three parts. */
function asSecretError(cause: unknown): unknown {
	return cause instanceof SecretProviderError ? new SecretError(cause.variable, cause.source, cause.detail) : cause;
}

/**
 * R15 (D-123): checks `TTK_API_KEYS_REF` / `TTK_SECRETS_REF` and every provider setting they need, reading nothing;
 * `null` when no reference is set.
 *
 * Every refusal is a {@linkcode SecretError} naming the variable and the provider (or the setting at fault) and a
 * fixed phrase — never the value, the token or the reference's path. Order: every reference and provider setting is
 * checked before anything is read — any file, a provider's token included (review R1-7) — so a typo in the second
 * reference is reported without the first one's provider having been contacted, and without a file that happens to be
 * unreadable answering in its place. With `contactProviders: false` this check is all that runs.
 */
function planSecretRefs(env: ResolveSecretsOptions['env']): SecretRefPlan | null {
	const wanted: { logical: string; variable: string; ref: SecretRef }[] = [];
	try {
		for (const [logical, variable] of Object.entries(SECRET_REF_VARS)) {
			const raw = env[variable]?.trim();
			if (raw === undefined || raw === '') continue;
			// One source per secret, as `loadConfig` already insists for the inline and file forms.
			const fileVar = SECRET_FILE_VARS[logical]!;
			if (env[logical]?.trim() || env[fileVar]?.trim()) {
				throw new SecretProviderError(variable, 'reference', `set one of ${logical}, ${fileVar} or ${variable}`);
			}
			wanted.push({ logical, variable, ref: parseSecretRef(variable, raw) });
		}
		if (wanted.length === 0) return null;
		const needed = new Set(wanted.map((entry) => entry.ref.provider));
		const settings = new Map<SecretProviderName, { url: URL; tokenPath: string }>();
		for (const provider of needed) {
			const vars = PROVIDER_VARS[provider];
			const address = env[vars.address]?.trim();
			if (!address) throw new SecretProviderError(vars.address, provider, `a ${provider} reference needs it set`);
			const tokenPath = env[vars.tokenFile]?.trim();
			if (!tokenPath) throw new SecretProviderError(vars.tokenFile, provider, `a ${provider} reference needs it set`);
			settings.set(provider, { url: parseProviderAddress(vars.address, address), tokenPath });
		}
		const namespaceRaw = env.TTK_VAULT_NAMESPACE?.trim();
		const namespace = namespaceRaw ? parseVaultNamespace(namespaceRaw) : undefined;
		const caPath = env.TTK_SECRET_PROVIDER_CA_FILE?.trim() || undefined;
		return { wanted, settings, namespace, caPath };
	} catch (cause) {
		throw asSecretError(cause);
	}
}

/** R15 (D-123): reads each planned reference from its provider into `resolved`, after every file, or refuses. */
async function readSecretRefs(
	plan: SecretRefPlan,
	options: ResolveSecretsOptions,
	read: (path: string) => Promise<string>,
	resolved: Record<string, string>,
): Promise<void> {
	const { wanted, settings, namespace, caPath } = plan;
	try {
		let client: Deno.HttpClient | undefined;
		try {
			if (caPath !== undefined) client = await caClient(read, caPath);
			const providers = new Map<SecretProviderName, SecretProvider>();
			for (const [provider, { url, tokenPath }] of settings) {
				const tokenFile = PROVIDER_VARS[provider].tokenFile;
				let raw: string;
				try {
					raw = await read(tokenPath);
				} catch {
					// The read error's text names the path, which is configuration; it never holds the token. Still, a
					// fixed phrase is enough to act on.
					throw new SecretError(tokenFile, tokenPath, 'the token file cannot be read');
				}
				const token = normalizeSecret(raw, tokenFile, tokenPath);
				if (/\s/.test(token)) throw new SecretError(tokenFile, tokenPath, 'the token contains whitespace');
				const common = {
					url,
					token,
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(client === undefined ? {} : { client }),
				};
				providers.set(
					provider,
					provider === 'vault'
						? new VaultKv2Provider({ ...common, ...(namespace === undefined ? {} : { namespace }) })
						: new OnePasswordConnectProvider(common),
				);
			}
			const signal = new AbortController().signal;
			for (const { logical, variable, ref } of wanted) {
				let value: string;
				try {
					value = await providers.get(ref.provider)!.read(ref, signal);
				} catch (cause) {
					const detail = cause instanceof ProviderReadError ? cause.detail : 'the read failed';
					throw new SecretError(variable, ref.provider, detail);
				}
				// The same shape rules as a secret file; the "path" a failure names is the provider, never the reference.
				resolved[logical] = normalizeSecret(value, variable, ref.provider);
			}
		} finally {
			client?.close();
		}
	} catch (cause) {
		throw asSecretError(cause);
	}
}

/**
 * `TTK_SECRET_PROVIDER_CA_FILE`: a PEM bundle trusted for the provider connections only. A file holding no
 * certificate block is refused here, because `Deno.createHttpClient` silently accepts one and would then trust nothing
 * beyond the system roots — a misconfiguration that would surface only as a TLS failure much later.
 */
async function caClient(read: (path: string) => Promise<string>, path: string): Promise<Deno.HttpClient> {
	let pem: string;
	try {
		pem = await read(path);
	} catch {
		throw new SecretError('TTK_SECRET_PROVIDER_CA_FILE', path, 'the CA file cannot be read');
	}
	if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
		throw new SecretError('TTK_SECRET_PROVIDER_CA_FILE', path, 'no PEM certificate in the file');
	}
	try {
		return Deno.createHttpClient({ caCerts: [pem] });
	} catch {
		throw new SecretError('TTK_SECRET_PROVIDER_CA_FILE', path, 'the PEM certificate cannot be parsed');
	}
}

/**
 * Where releases before D-154 generated the link-signing key under `TTK_DATA_DIR`, in plaintext. Read once to move
 * the key into the vault, then removed; never created again.
 */
export const LINK_KEY_FILE_NAME = 'link-signing.key';

/** D-154: the vault row that holds the generated link-signing key. */
export const LINK_KEY_SECRET_NAME = 'link-signing-key';

/** The shortest link-signing key accepted, in characters after `normalizeSecret` (design §2.1). */
export const LINK_KEY_MIN_CHARS = 32;

/**
 * The link-signing key as bytes: the key file's contents when `TTK_SIGNED_LINK_KEY_FILE` named one, else the key
 * sealed in the database's vault, generated on first start (R10, design §2.7, D-119, D-154).
 *
 * The generated key is 32 random bytes, base64url, sealed by the vault and never logged or returned. A plaintext
 * `link-signing.key` left by an earlier release is moved into the vault and deleted, so links signed before the
 * upgrade keep verifying. `loadConfig` has already refused (or switched links off for) a deployment with neither a
 * key file nor a vault that can hold one.
 */
export async function loadLinkSigningKey(settings: {
	readonly key: string | null;
	readonly dataDir: string | null;
	/** The data directory's vault; required without a key file. */
	readonly vault: Pick<Vault, 'unlocked' | 'get' | 'put'> | null;
}): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	if (settings.key !== null) return encoder.encode(settings.key);
	const vault = settings.vault;
	if (vault === null || !vault.unlocked) {
		throw new SecretError(
			'TTK_SIGNED_LINKS',
			'(none)',
			'neither TTK_SIGNED_LINK_KEY_FILE nor TTK_DATA_DIR with TTK_DB_KEY_FILE is set',
		);
	}
	const stored = await vault.get(LINK_KEY_SECRET_NAME, '');
	if (stored !== null) return encoder.encode(stored);
	let value = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const legacy = settings.dataDir === null ? null : join(settings.dataDir, LINK_KEY_FILE_NAME);
	if (legacy !== null) {
		try {
			const moved = normalizeSecret(await Deno.readTextFile(legacy), 'TTK_SIGNED_LINKS', legacy);
			if (moved.length >= LINK_KEY_MIN_CHARS) value = moved;
		} catch (cause) {
			if (!(cause instanceof Deno.errors.NotFound) && !(cause instanceof SecretError)) {
				throw new SecretError('TTK_SIGNED_LINKS', legacy, cause instanceof Error ? cause.message : String(cause));
			}
		}
	}
	await vault.put(LINK_KEY_SECRET_NAME, value, '');
	// Sealed first, then the plaintext copy goes: a crash between the two leaves both, never neither.
	if (legacy !== null) await Deno.remove(legacy).catch(() => {});
	return encoder.encode(value);
}
