/**
 * D-154 (owner-requested): seeding the database from the operator's files and environment.
 *
 * A seed source is copied into the database **once**: when its destination was never seeded and is empty. From then
 * on the database is the source in force and the file may be removed. `seed --force` (`-Force`) copies it again,
 * replacing what is there. Nothing is ever written back to a source.
 *
 * | Target      | Source                                          | Destination                                   |
 * | ----------- | ----------------------------------------------- | --------------------------------------------- |
 * | `providers` | `TTK_MODEL_PROVIDERS_FILE` (keys included)      | `model_providers` rows, keys sealed per host  |
 * | `secrets`   | `TTK_SECRETS` / `TTK_SECRETS_FILE`              | one sealed `browser-secrets` vault row        |
 *
 * `TTK_SECRETS_REF` is not seeded: an external secret manager stays the source, read at every start.
 *
 * A source that carries a secret needs an unlocked vault (`TTK_DB_KEY_FILE`); without one, seeding refuses by name
 * rather than store the secret in plaintext or drop it silently.
 */
import { parseSecrets, type SecretEntry } from '@tykotech/mcp';
import { type Database, now } from './database.ts';
import {
	DEFAULT_PROVIDER_SETTING,
	entryOf,
	netHostOf,
	providerKeyName,
	PROVIDERS_SEED_MARKER,
} from './model_providers_admin.ts';
import type { ModelProvidersConfig } from './model_providers.ts';
import type { Sealed, Vault } from './vault.ts';

/** What can be seeded. */
export const SEED_TARGETS = ['providers', 'secrets'] as const;
export type SeedTarget = (typeof SEED_TARGETS)[number];

/** The vault row holding the browser-typed secrets, in the `TTK_SECRETS` JSON shape. */
export const BROWSER_SECRETS_NAME = 'browser-secrets';

/** The `settings` row recording when the browser secrets were last seeded. */
export const SECRETS_SEED_MARKER = 'seed.browser_secrets';

/** The sources as the configuration resolved them. */
export interface SeedSources {
	/** `Config.modelProviders`. */
	readonly providers: ModelProvidersConfig | null;
	/** `Config.secrets`, or `null` when they come from `TTK_SECRETS_REF` (never seeded) or nowhere. */
	readonly secrets: readonly SecretEntry[] | null;
}

/** What seeding did for one target. */
export interface SeedResult {
	readonly target: SeedTarget;
	/** `seeded`, or why not: already seeded, destination not empty, or no source configured. */
	readonly outcome: 'seeded' | 'already-seeded' | 'not-empty' | 'no-source';
	/** Providers or secrets copied. */
	readonly count: number;
}

/** A source could not be seeded. Names the variable and a fixed phrase, never a value. */
export class SeedError extends Error {
	constructor(variable: string, detail: string) {
		super(`${variable}: ${detail}`);
		this.name = 'SeedError';
	}
}

/** Seeds each requested target; with `force`, replaces what is there. */
export async function seedDatabase(
	store: { readonly db: Database; readonly vault: Vault },
	sources: SeedSources,
	options: { readonly force?: boolean; readonly only?: readonly SeedTarget[] } = {},
): Promise<SeedResult[]> {
	const targets = options.only ?? SEED_TARGETS;
	const force = options.force === true;
	const results: SeedResult[] = [];
	if (targets.includes('providers')) results.push(await seedProviders(store, sources.providers, force));
	if (targets.includes('secrets')) results.push(await seedSecrets(store, sources.secrets, force));
	return results;
}

async function seedProviders(
	{ db, vault }: { readonly db: Database; readonly vault: Vault },
	source: ModelProvidersConfig | null,
	force: boolean,
): Promise<SeedResult> {
	const result = (outcome: SeedResult['outcome'], count = 0): SeedResult => ({ target: 'providers', outcome, count });
	if (source === null) return result('no-source');
	if (!force) {
		if (db.setting(PROVIDERS_SEED_MARKER) !== null) return result('already-seeded');
		if (Number(db.get('SELECT count(*) AS n FROM model_providers')?.n ?? 0) > 0) return result('not-empty');
	}
	// Sealed before the transaction (Web Crypto is async); a key with nowhere safe to go refuses the whole seed.
	const sealed: Sealed[] = [];
	const hosts = new Map<string, string>();
	for (const provider of source.providers) {
		if (provider.apiKey === null) continue;
		if (!vault.unlocked) {
			throw new SeedError(
				'TTK_MODEL_PROVIDERS_FILE',
				`provider ${provider.id} has a key, and TTK_DB_KEY_FILE is not set to store it encrypted (doctor --new-db-key)`,
			);
		}
		const host = netHostOf(provider.baseUrl)!;
		hosts.set(provider.id, host);
		sealed.push(await vault.seal(providerKeyName(provider.id), provider.apiKey, host));
	}
	db.transaction(() => {
		db.run('DELETE FROM model_providers');
		for (const name of vault.names('model-provider/')) vault.delete(name);
		const stamp = now();
		for (const [position, provider] of source.providers.entries()) {
			db.run(
				'INSERT INTO model_providers (id, position, origin, entry, key_host, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
				provider.id,
				position,
				'seed',
				JSON.stringify(entryOf(provider)),
				hosts.get(provider.id) ?? null,
				stamp,
			);
		}
		for (const item of sealed) vault.write(item);
		db.setSetting(DEFAULT_PROVIDER_SETTING, source.default);
		db.setSetting(PROVIDERS_SEED_MARKER, stamp);
	});
	return result('seeded', source.providers.length);
}

async function seedSecrets(
	{ db, vault }: { readonly db: Database; readonly vault: Vault },
	source: readonly SecretEntry[] | null,
	force: boolean,
): Promise<SeedResult> {
	const result = (outcome: SeedResult['outcome'], count = 0): SeedResult => ({ target: 'secrets', outcome, count });
	if (source === null || source.length === 0) return result('no-source');
	if (!force) {
		if (db.setting(SECRETS_SEED_MARKER) !== null) return result('already-seeded');
		if (vault.has(BROWSER_SECRETS_NAME)) return result('not-empty');
	}
	if (!vault.unlocked) {
		throw new SeedError(
			'TTK_SECRETS',
			'browser secrets are configured, and TTK_DB_KEY_FILE is not set to store them encrypted (doctor --new-db-key)',
		);
	}
	const document: Record<string, { value: string; domains: readonly string[] }> = {};
	for (const entry of source) document[entry.name] = { value: entry.value, domains: [...entry.domains] };
	const sealed = await vault.seal(BROWSER_SECRETS_NAME, JSON.stringify(document), '');
	db.transaction(() => {
		vault.write(sealed);
		db.setSetting(SECRETS_SEED_MARKER, now());
	});
	return result('seeded', source.length);
}

/**
 * The browser secrets in force: the vault's when the database holds them, else `fallback` (the configuration's, used
 * directly — no database, or `TTK_SECRETS_REF`). A stored document is judged by the same parser as the file.
 */
export async function storedBrowserSecrets(vault: Vault): Promise<SecretEntry[] | null> {
	if (!vault.unlocked || !vault.has(BROWSER_SECRETS_NAME)) return null;
	const raw = await vault.get(BROWSER_SECRETS_NAME, '');
	return raw === null ? null : parseSecrets(raw);
}

/** One line per result, for the CLI and the startup log. Counts and outcomes only, never a value. */
export function describeSeed(result: SeedResult): string {
	const what = result.target === 'providers' ? 'model providers' : 'browser secrets';
	switch (result.outcome) {
		case 'seeded':
			return `${what}: seeded ${result.count} from the configured source`;
		case 'already-seeded':
			return `${what}: already seeded; the database is the source (seed --force to replace)`;
		case 'not-empty':
			return `${what}: not seeded, the database already holds some (seed --force to replace)`;
		case 'no-source':
			return `${what}: no source configured`;
	}
}
