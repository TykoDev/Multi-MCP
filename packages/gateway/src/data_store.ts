/**
 * D-154: opening the data directory's database for a process — `serve`, `stdio` and the `seed` command share this.
 *
 * Opens `<TTK_DATA_DIR>/ttk.db`, opens its vault with `TTK_DB_KEY_FILE`'s key (or locked without one), seeds what was
 * never seeded (`seed.ts`), and answers which browser secrets are in force. Without a data directory there is no
 * database: the configuration's own values are used as they are, and nothing is stored.
 */
import type { SecretEntry } from '@tykotech/mcp';
import type { Config } from './config.ts';
import { Database } from './database.ts';
import { readRows } from './model_providers_admin.ts';
import { entryOf } from './model_providers_admin.ts';
import { describeSeed, seedDatabase, type SeedResult, type SeedTarget, storedBrowserSecrets } from './seed.ts';
import { Vault } from './vault.ts';

/** The database and its vault, for the life of a process. */
export interface DataStore {
	readonly db: Database;
	readonly vault: Vault;
}

/** What opening found. */
export interface OpenedDataStore {
	/** `null` without a data directory. */
	readonly store: DataStore | null;
	/** The browser secrets in force: the vault's, or the configuration's where nothing is seeded (no database, REF). */
	readonly secrets: readonly SecretEntry[];
	readonly seeded: readonly SeedResult[];
	/** Closes the database; idempotent. */
	close(): void;
}

/** The configuration fields this reads. */
export type DataStoreConfig = Pick<Config, 'dataDir' | 'dbKey' | 'modelProviders' | 'secrets' | 'secretsSource'>;

/**
 * Opens the database (when there is a data directory), seeds it, and resolves the browser secrets in force. Throws a
 * `DatabaseError`, `VaultError` or `SeedError` — each naming a variable or path and a fixed phrase — rather than start
 * with secrets it could not keep encrypted.
 */
export async function openDataStore(
	config: DataStoreConfig,
	options: {
		readonly logger?: { info(message: string): void; warn(message: string): void };
		/** Seed what was never seeded (default `true`); `force` replaces, `only` narrows. */
		readonly seed?: boolean | { readonly force: boolean; readonly only?: readonly SeedTarget[] };
	} = {},
): Promise<OpenedDataStore> {
	if (config.dataDir === null) {
		return { store: null, secrets: config.secrets, seeded: [], close: () => {} };
	}
	const db = Database.open(config.dataDir);
	try {
		const vault = await Vault.open(db, config.dbKey);
		const store: DataStore = { db, vault };
		const seedOption = options.seed ?? true;
		const seeded = seedOption === false ? [] : await seedDatabase(store, {
			providers: config.modelProviders,
			// An external secret manager stays the source: its values are read at every start, never copied in.
			secrets: config.secretsSource === 'TTK_SECRETS_REF' ? null : config.secrets,
		}, seedOption === true ? {} : seedOption);
		for (const result of seeded) {
			if (result.outcome === 'seeded') options.logger?.info(describeSeed(result));
		}
		if (!vault.unlocked) {
			options.logger?.info('TTK_DB_KEY_FILE is not set: the database stores no secrets (doctor --new-db-key)');
		}
		for (const line of drift(store, config)) options.logger?.info(line);
		const secrets = config.secretsSource === 'TTK_SECRETS_REF'
			? config.secrets
			: (await storedBrowserSecrets(vault)) ?? [];
		// A changed secrets file is not applied either; said once, by count, never a name or a value.
		if (config.secretsSource !== null && config.secretsSource !== 'TTK_SECRETS_REF' && vault.unlocked) {
			if (canonicalSecrets(config.secrets) !== canonicalSecrets(secrets)) {
				options.logger?.info(
					`browser secrets: ${config.secretsSource} differs from the database; the database is in force ` +
						'(seed --force --only secrets to replace it)',
				);
			}
		}
		return { store, secrets, seeded, close: () => db.close() };
	} catch (cause) {
		db.close();
		throw cause;
	}
}

/**
 * One line per seed source that no longer matches what the database holds, so an operator who edited a file knows
 * why nothing changed. Ids and names only — never a value.
 */
function drift(store: DataStore, config: DataStoreConfig): string[] {
	const lines: string[] = [];
	const file = config.modelProviders;
	if (file !== null) {
		const rows = readRows(store.db);
		const stored = JSON.stringify(rows.map((row) => row.entry));
		const seeded = JSON.stringify(file.providers.map(entryOf));
		if (stored !== seeded) {
			lines.push(
				'model providers: the providers file differs from the database; the database is in force ' +
					'(seed --force --only providers to replace it)',
			);
		}
	}
	return lines;
}

/** Secrets in a canonical order, for an equality check that never leaves this module. */
function canonicalSecrets(entries: readonly SecretEntry[]): string {
	return JSON.stringify(
		[...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((entry) => [
			entry.name,
			entry.value,
			[...entry.domains],
		]),
	);
}

/**
 * The doctor's line for the database: where it is, whether the vault key is set, and what it holds — counts only,
 * read without creating the file and without the key (no secret is opened). `null` without a data directory.
 */
export function databaseDoctorLine(dataDir: string | null, keySet: boolean): string | null {
	if (dataDir === null) return null;
	const key = keySet ? 'key set' : 'no key: stores no secrets';
	const counts = Database.inspect(dataDir);
	if (counts === null) return `database        ${dataDir}/ttk.db (not created yet; ${key})`;
	return `database        ${counts.path} (${counts.providers} providers, ${counts.secrets} sealed secrets, ${counts.memoryItems} memory items; ${key})`;
}
