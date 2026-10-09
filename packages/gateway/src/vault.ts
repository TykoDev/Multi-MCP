/**
 * D-154 (owner-requested): secrets at rest, sealed in the database.
 *
 * Every secret the server keeps — a model provider key, a browser-typed credential, the generated link-signing key —
 * is stored only as AES-256-GCM ciphertext in the `secrets` table. Nothing secret is written to disk in plaintext.
 *
 * - **The key** is 32 random bytes from `TTK_DB_KEY_FILE` (`doctor --new-db-key` writes one), read once like every
 *   `*_FILE` secret and held only in a non-extractable `CryptoKey`. It must live outside the data volume: a backup of
 *   `/data` then holds ciphertext only.
 * - **Each value** gets a fresh 96-bit random nonce. The additional data binds the ciphertext to its row name and to a
 *   caller-chosen context (a provider key's host), so a row copied to another name, or a key moved to another host,
 *   fails authentication instead of decrypting.
 * - **A check row** sealed under the key at first use makes a wrong key refuse startup by name, before any secret is
 *   read. A database that holds sealed secrets refuses to open without a key at all.
 *
 * Errors name the variable and a fixed phrase, never a value.
 */
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { decodeBase64 } from '@std/encoding/base64';
import { decodeHex, encodeHex } from '@std/encoding/hex';
// deno-lint-ignore no-external-import -- node: builtin (the runtime's own crypto), not a dependency; D-154
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { type Database, now } from './database.ts';

/** The variable that names the key file. */
export const DB_KEY_ENV = 'TTK_DB_KEY_FILE';

/** The key's length in bytes (AES-256). */
export const DB_KEY_BYTES = 32;

/** The check row's name; reserved, never a caller's. */
const CHECK_NAME = 'vault/check';
const CHECK_TEXT = 'ttk-vault-check-v1';
const NONCE_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Decodes a key file's text: 43 base64url characters, 44 padded base64, or 64 hex. `null` when it is none of them. */
export function decodeDbKey(text: string): Uint8Array | null {
	const attempts: Array<() => Uint8Array> = [];
	if (/^[0-9a-fA-F]{64}$/.test(text)) attempts.push(() => decodeHex(text));
	if (/^[A-Za-z0-9_-]{43}$/.test(text)) attempts.push(() => decodeBase64Url(text));
	if (/^[A-Za-z0-9+/]{43}=$/.test(text)) attempts.push(() => decodeBase64(text));
	for (const attempt of attempts) {
		try {
			const bytes = attempt();
			if (bytes.byteLength === DB_KEY_BYTES) return bytes;
		} catch {
			// Not this encoding; try the next.
		}
	}
	return null;
}

/** A new key, as `doctor --new-db-key` writes it: 32 random bytes, base64url. */
export function generateDbKey(): string {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(DB_KEY_BYTES)));
}

/** A value sealed in memory, ready for a synchronous write inside a transaction. */
export interface Sealed {
	readonly name: string;
	readonly nonce: Uint8Array;
	readonly sealed: Uint8Array;
}

/** The vault could not be opened. Names the variable and the reason, never a value. */
export class VaultError extends Error {
	constructor(detail: string) {
		super(`${DB_KEY_ENV}: ${detail}`);
		this.name = 'VaultError';
	}
}

/** The sealed secrets in one database. Locked (no key) it can list and delete, never read or write a value. */
export class Vault {
	readonly #db: Database;
	readonly #key: CryptoKey | null;
	/** A non-secret label for the key (the first 8 bytes of SHA-256 over it), stored with each row. */
	readonly #keyId: string;

	private constructor(db: Database, key: CryptoKey | null, keyId: string) {
		this.#db = db;
		this.#key = key;
		this.#keyId = keyId;
	}

	/**
	 * Opens the vault over `db` with `key` (the decoded `TTK_DB_KEY_FILE`), or locked with `null`.
	 *
	 * Refuses a wrong key (the check row does not open), and a missing key when the database already holds sealed
	 * secrets — either would otherwise surface later as secrets that silently vanished.
	 */
	static async open(db: Database, key: Uint8Array | null): Promise<Vault> {
		const check = db.get('SELECT nonce, sealed FROM secrets WHERE name = ?', CHECK_NAME);
		if (key === null) {
			// The check row alone is not a secret: a database that never stored one may run locked again.
			const count = Number(db.get('SELECT count(*) AS n FROM secrets WHERE name != ?', CHECK_NAME)?.n ?? 0);
			if (count > 0) throw new VaultError('the database holds encrypted secrets and no key is set');
			return new Vault(db, null, '');
		}
		if (key.byteLength !== DB_KEY_BYTES) throw new VaultError(`the key is not ${DB_KEY_BYTES} bytes`);
		const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, [
			'encrypt',
			'decrypt',
		]);
		const keyId = encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).slice(0, 16);
		const vault = new Vault(db, cryptoKey, keyId);
		if (check === undefined) {
			const count = Number(db.get('SELECT count(*) AS n FROM secrets')?.n ?? 0);
			if (count > 0) throw new VaultError('the database holds secrets without a key check');
			vault.write(await vault.seal(CHECK_NAME, CHECK_TEXT, ''));
		} else {
			const opened = await vault.#decrypt(CHECK_NAME, '', check.nonce as Uint8Array, check.sealed as Uint8Array);
			if (opened !== CHECK_TEXT) throw new VaultError('the key does not open this database');
		}
		return vault;
	}

	/** Whether a key is loaded. */
	get unlocked(): boolean {
		return this.#key !== null;
	}

	/** Seals `value` under `name` and `context`. Async (Web Crypto); write the result with {@linkcode write}. */
	async seal(name: string, value: string, context: string): Promise<Sealed> {
		const key = this.#require();
		const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
		const sealed = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: nonce, additionalData: additionalData(name, context) },
				key,
				encoder.encode(value),
			),
		);
		return { name, nonce, sealed };
	}

	/** Stores a sealed value, replacing any under the same name. Synchronous, so it can join a transaction. */
	write(sealed: Sealed): void {
		this.#require();
		this.#db.run(
			'INSERT INTO secrets (name, nonce, sealed, key_id, updated_at) VALUES (?, ?, ?, ?, ?) ' +
				'ON CONFLICT (name) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed, ' +
				'key_id = excluded.key_id, updated_at = excluded.updated_at',
			sealed.name,
			sealed.nonce,
			sealed.sealed,
			this.#keyId,
			now(),
		);
	}

	/** Seals and stores in one step, outside any transaction. */
	async put(name: string, value: string, context: string): Promise<void> {
		this.write(await this.seal(name, value, context));
	}

	/**
	 * The value under `name`, opened with `context`; `null` when absent. Throws {@linkcode VaultError} when the row
	 * does not open — a tampered row, or one sealed for another context.
	 */
	async get(name: string, context: string): Promise<string | null> {
		this.#require();
		const row = this.#db.get('SELECT nonce, sealed FROM secrets WHERE name = ?', name);
		if (row === undefined) return null;
		const value = await this.#decrypt(name, context, row.nonce as Uint8Array, row.sealed as Uint8Array);
		if (value === null) throw new VaultError(`the secret ${name} does not open`);
		return value;
	}

	/** Whether a value is stored under `name` (works locked). */
	has(name: string): boolean {
		return this.#db.get('SELECT 1 AS x FROM secrets WHERE name = ?', name) !== undefined;
	}

	/** The stored names under `prefix`, sorted (works locked). Never the check row. */
	names(prefix: string): string[] {
		return this.#db.all('SELECT name FROM secrets WHERE name >= ? AND name < ? ORDER BY name', prefix, `${prefix}￿`)
			.map((row) => String(row.name))
			.filter((name) => name !== CHECK_NAME);
	}

	/** Removes `name`; synchronous, so it can join a transaction. Returns whether a row was removed. */
	delete(name: string): boolean {
		if (name === CHECK_NAME) return false;
		return this.#db.run('DELETE FROM secrets WHERE name = ?', name) > 0;
	}

	#require(): CryptoKey {
		if (this.#key === null) throw new VaultError('no key is set, so secrets cannot be stored or read');
		return this.#key;
	}

	async #decrypt(name: string, context: string, nonce: Uint8Array, sealed: Uint8Array): Promise<string | null> {
		try {
			const plain = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: additionalData(name, context) },
				this.#require(),
				new Uint8Array(sealed),
			);
			return decoder.decode(plain);
		} catch {
			return null;
		}
	}
}

/** `ttk-vault/v1 \0 name \0 context`: what a ciphertext is bound to besides the key. */
function additionalData(name: string, context: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(`ttk-vault/v1\0${name}\0${context}`);
}

/**
 * D-154: a synchronous sealer for a secret that must be written inside a synchronous document write — an A2A push
 * webhook's token in `agents/tasks.json`. AES-256-GCM under a subkey HKDF-derived from the vault key for `purpose`
 * (never the vault key itself), a fresh 96-bit nonce per value, `context` authenticated. Output:
 * `v1.<nonce b64url>.<ciphertext+tag b64url>`. `open` answers `null` for anything that does not open.
 */
export function syncSealer(
	key: Uint8Array,
	purpose: string,
): { seal(plain: string, context: string): string; open(sealed: string, context: string): string | null } {
	if (key.byteLength !== DB_KEY_BYTES) throw new VaultError(`the key is not ${DB_KEY_BYTES} bytes`);
	const subkey = new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), `ttk-sealer/v1/${purpose}`, DB_KEY_BYTES));
	const aad = (context: string): Uint8Array => encoder.encode(`ttk-sealer/v1\0${purpose}\0${context}`);
	return {
		seal(plain: string, context: string): string {
			const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
			const cipher = createCipheriv('aes-256-gcm', subkey, nonce);
			cipher.setAAD(aad(context));
			const body = new Uint8Array([...cipher.update(encoder.encode(plain)), ...cipher.final(), ...cipher.getAuthTag()]);
			return `v1.${encodeBase64Url(nonce)}.${encodeBase64Url(body)}`;
		},
		open(sealed: string, context: string): string | null {
			try {
				const [version, nonceText, bodyText] = sealed.split('.');
				if (version !== 'v1' || nonceText === undefined || bodyText === undefined) return null;
				const nonce = decodeBase64Url(nonceText);
				const body = decodeBase64Url(bodyText);
				if (nonce.byteLength !== NONCE_BYTES || body.byteLength < 16) return null;
				const decipher = createDecipheriv('aes-256-gcm', subkey, nonce);
				decipher.setAAD(aad(context));
				decipher.setAuthTag(body.subarray(body.byteLength - 16));
				const plain = new Uint8Array([...decipher.update(body.subarray(0, body.byteLength - 16)), ...decipher.final()]);
				return decoder.decode(plain);
			} catch {
				return null;
			}
		},
	};
}
