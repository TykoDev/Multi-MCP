/**
 * D-154 (owner-requested): the gateway's SQLite database, `<TTK_DATA_DIR>/ttk.db`.
 *
 * One file holds what the control plane edits and what must never rest in plaintext: model providers, the vault's
 * sealed secrets (`vault.ts`), the seed markers, and the agents' vector memory (`memory.ts`). It is opened with the
 * runtime's own `node:sqlite` — no FFI, no npm package, no native extension (`allowExtension` stays off, so
 * `--deny-ffi` holds) — and needs only the read and write grants the data directory already has.
 *
 * - The file is created `0600` before SQLite opens it; SQLite gives its `-wal` and `-shm` files the database's mode.
 * - WAL with a busy timeout, so `serve` and a local `stdio` process can share one file.
 * - `secure_delete`, so a replaced or deleted sealed secret does not linger in a free page.
 * - Node-local: nothing here is replicated to other cluster nodes (owner: a future feature).
 *
 * The schema is versioned by `PRAGMA user_version`; each migration runs once, inside a transaction.
 */
// deno-lint-ignore no-external-import -- node: builtin (the runtime's own SQLite), not a dependency; D-154
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { join } from '@std/path';

/** The database's file name inside `TTK_DATA_DIR`. */
export const DATABASE_FILE = 'ttk.db';

/** How long a writer waits for another process's lock before failing, in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;

/** Migrations, in order; `user_version` is the number applied. Never edit one that has shipped — append. */
const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	) STRICT;
	CREATE TABLE secrets (
		name TEXT PRIMARY KEY,
		nonce BLOB NOT NULL,
		sealed BLOB NOT NULL,
		key_id TEXT NOT NULL,
		updated_at TEXT NOT NULL
	) STRICT;
	CREATE TABLE model_providers (
		id TEXT PRIMARY KEY,
		position INTEGER NOT NULL,
		origin TEXT NOT NULL CHECK (origin IN ('seed', 'admin')),
		entry TEXT NOT NULL,
		key_host TEXT,
		updated_at TEXT NOT NULL
	) STRICT;
	CREATE TABLE memory_collections (
		owner TEXT NOT NULL,
		name TEXT NOT NULL,
		embedder TEXT NOT NULL,
		dims INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (owner, name)
	) STRICT;
	CREATE TABLE memory_items (
		owner TEXT NOT NULL,
		collection TEXT NOT NULL,
		id TEXT NOT NULL,
		text TEXT NOT NULL,
		metadata TEXT NOT NULL,
		embedding BLOB NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (owner, collection, id),
		FOREIGN KEY (owner, collection) REFERENCES memory_collections (owner, name) ON DELETE CASCADE
	) STRICT;
	`,
];

/** A row as `node:sqlite` returns it. */
export type Row = Record<string, SQLInputValue>;

/** The gateway's database: a thin, synchronous wrapper that owns the connection and the schema. */
export class Database {
	readonly #db: DatabaseSync;
	/** The file, or `null` for an in-memory database (tests). */
	readonly path: string | null;
	#closed = false;

	private constructor(db: DatabaseSync, path: string | null) {
		this.#db = db;
		this.path = path;
	}

	/**
	 * Opens (creating when absent) `<dataDir>/ttk.db` and brings its schema up to date. Throws a
	 * {@linkcode DatabaseError} naming the path when the file cannot be opened or is not this server's database.
	 */
	static open(dataDir: string): Database {
		const path = join(dataDir, DATABASE_FILE);
		try {
			Deno.mkdirSync(dataDir, { recursive: true });
			// Created owner-only before SQLite sees it; an existing file is narrowed to the same mode (POSIX only).
			Deno.openSync(path, { create: true, append: true, mode: 0o600 }).close();
			if (Deno.build.os !== 'windows') Deno.chmodSync(path, 0o600);
		} catch (cause) {
			throw new DatabaseError(path, cause instanceof Error ? cause.message : String(cause));
		}
		return Database.#connect(path, path);
	}

	/**
	 * Row counts from an existing `<dataDir>/ttk.db`, opened read-only — never created, never migrated (the doctor).
	 * `null` when there is no file; zero counts for a table an older schema lacks.
	 */
	static inspect(dataDir: string): { path: string; providers: number; secrets: number; memoryItems: number } | null {
		const path = join(dataDir, DATABASE_FILE);
		try {
			Deno.statSync(path);
		} catch {
			return null;
		}
		const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
		try {
			const count = (table: string): number => {
				try {
					return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as Row).n);
				} catch {
					return 0;
				}
			};
			// The vault's check row is not a secret anyone stored.
			return {
				path,
				providers: count('model_providers'),
				secrets: Math.max(0, count('secrets') - 1),
				memoryItems: count('memory_items'),
			};
		} finally {
			db.close();
		}
	}

	/** An in-memory database with the full schema, for tests and embedders without a data directory. */
	static memory(): Database {
		return Database.#connect(':memory:', null);
	}

	static #connect(location: string, path: string | null): Database {
		let db: DatabaseSync;
		try {
			db = new DatabaseSync(location, { enableForeignKeyConstraints: true, allowExtension: false });
		} catch (cause) {
			throw new DatabaseError(path ?? location, cause instanceof Error ? cause.message : String(cause));
		}
		const database = new Database(db, path);
		try {
			db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			if (path !== null) db.exec('PRAGMA journal_mode = WAL');
			db.exec('PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF');
			database.#migrate();
		} catch (cause) {
			db.close();
			throw new DatabaseError(path ?? location, cause instanceof Error ? cause.message : String(cause));
		}
		return database;
	}

	#migrate(): void {
		const version = Number((this.#db.prepare('PRAGMA user_version').get() as Row).user_version);
		if (version > MIGRATIONS.length) {
			throw new Error(`schema version ${version} is newer than this server knows (${MIGRATIONS.length})`);
		}
		for (let index = version; index < MIGRATIONS.length; index++) {
			this.transaction(() => {
				this.#db.exec(MIGRATIONS[index]!);
				this.#db.exec(`PRAGMA user_version = ${index + 1}`);
			});
		}
	}

	/** Runs `fn` in one `BEGIN IMMEDIATE` transaction: committed when it returns, rolled back when it throws. */
	transaction<T>(fn: () => T): T {
		this.#db.exec('BEGIN IMMEDIATE');
		try {
			const result = fn();
			this.#db.exec('COMMIT');
			return result;
		} catch (error) {
			this.#db.exec('ROLLBACK');
			throw error;
		}
	}

	/** Every row `sql` selects. */
	all(sql: string, ...params: SQLInputValue[]): Row[] {
		return this.#db.prepare(sql).all(...params) as Row[];
	}

	/** The first row `sql` selects, or `undefined`. */
	get(sql: string, ...params: SQLInputValue[]): Row | undefined {
		return this.#db.prepare(sql).get(...params) as Row | undefined;
	}

	/** Runs a statement; returns the number of rows it changed. */
	run(sql: string, ...params: SQLInputValue[]): number {
		return Number(this.#db.prepare(sql).run(...params).changes);
	}

	/**
	 * Registers a deterministic scalar SQL function (the memory store's similarity).
	 *
	 * - **It must never throw.** On Deno 2.9.7 a throwing user function makes `StatementSync.all()` never return
	 *   (`get()` is unaffected); answer SQL `NULL` and let the caller refuse instead.
	 * - **Its arity is `fn.length`.** Declare named parameters — a rest-parameter function registers with arity 0 and
	 *   every call fails with "wrong number of arguments".
	 */
	defineFunction(name: string, fn: (...args: SQLInputValue[]) => SQLInputValue): void {
		this.#db.function(name, { deterministic: true }, fn);
	}

	/** A `settings` value, or `null`. */
	setting(key: string): string | null {
		const row = this.get('SELECT value FROM settings WHERE key = ?', key);
		return row === undefined ? null : String(row.value);
	}

	/** Writes (or, with `null`, removes) a `settings` value. */
	setSetting(key: string, value: string | null): void {
		if (value === null) this.run('DELETE FROM settings WHERE key = ?', key);
		else {this.run(
				'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?',
				key,
				value,
				value,
			);}
	}

	/** Closes the connection; idempotent. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}
}

/** The database file could not be opened or migrated. Names the path, never a value. */
export class DatabaseError extends Error {
	constructor(path: string, detail: string) {
		super(`database (${path}): ${detail}`);
		this.name = 'DatabaseError';
	}
}

/** The current time as the database stores it. */
export function now(): string {
	return new Date().toISOString();
}
