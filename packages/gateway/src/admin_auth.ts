/**
 * Admin authentication: PBKDF2-SHA256 password hashing, verification,
 * and admin record management.
 */
import * as z from 'zod';
import { decodeHex, encodeHex } from '@std/encoding/hex';
import { timingSafeEqual } from '@std/crypto/timing-safe-equal';
// From the owner of the vocabulary, not through `config.ts`, which imports this module.
import { ADMIN_SCOPES, type Scope, SCOPES } from '@tykotech/mcp';

const ScopeSchema = z.enum(SCOPES);

/**
 * GW-4: the username becomes the principal id `admin:<username>`, which is part of an owner, a label every
 * viewer sees, and the private bridge's `x-ttk-principal` header — so it carries no control character.
 */
function printable(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export const AdminUserRecordSchema = z.object({
	username: z.string().min(1).max(64).refine(printable, 'username must not contain control characters'),
	salt: z.string().regex(/^[0-9a-f]{32,}$/, 'salt must be at least 16 bytes in hex'),
	hash: z.string().regex(/^[0-9a-f]{64}$/, 'hash must be 64 lowercase hex characters'),
	iterations: z.number().int().min(10_000).default(100_000),
	scopes: z.array(ScopeSchema).optional(),
});
export type AdminUserRecord = z.infer<typeof AdminUserRecordSchema>;

/** Derives a PBKDF2-SHA256 hash using native Web Crypto. */
export async function hashPassword(
	password: string,
	saltHex?: string,
	iterations = 100_000,
): Promise<{ salt: string; hash: string; iterations: number }> {
	const saltBytes = saltHex ? decodeHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
	const salt = saltHex ?? encodeHex(saltBytes);
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits'],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: saltBytes,
			iterations,
			hash: 'SHA-256',
		},
		keyMaterial,
		256,
	);
	const hash = encodeHex(new Uint8Array(bits));
	return { salt, hash, iterations };
}

/** Constant-time verification of a password against an admin user record. */
export async function verifyPassword(
	password: string,
	record: { salt: string; hash: string; iterations?: number },
): Promise<boolean> {
	try {
		const computed = await hashPassword(password, record.salt, record.iterations ?? 100_000);
		const a = new TextEncoder().encode(computed.hash);
		const b = new TextEncoder().encode(record.hash);
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

/** Generates a cryptographically strong random password. */
export function generateRandomPassword(length = 20): string {
	const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_+=';
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let result = '';
	for (let i = 0; i < length; i++) {
		result += chars[bytes[i]! % chars.length];
	}
	return result;
}

/**
 * Generates a new admin user record and returns the plain password.
 *
 * GW-2 / D-065: the record materialises its scopes rather than leaving them to a fallback. It used to write the
 * whole vocabulary, so every generated administrator held `sandbox:execute`, `agent:invoke`, `a2ui:publish`,
 * `evaluate` and `task` — the EXPLICIT_SCOPES that are "never granted by a default, on any path".
 *
 * C7 / D-098: `admin` left the default grant, so an administrator record names it: `ADMIN_SCOPES` (the default
 * grant plus `admin`) unless the caller names scopes. A record written here never relies on a default for `admin`.
 */
export async function generateAdminUser(
	username = 'admin',
	password?: string,
	scopes?: readonly Scope[],
): Promise<{ record: AdminUserRecord; password: string }> {
	const plain = password ?? generateRandomPassword(20);
	const { salt, hash, iterations } = await hashPassword(plain);
	const record: AdminUserRecord = {
		username,
		salt,
		hash,
		iterations,
		scopes: scopes ? [...scopes] : [...ADMIN_SCOPES],
	};
	return { record, password: plain };
}

/** Parses raw JSON into an AdminUserRecord or returns null. */
export function parseAdminUser(raw: string): AdminUserRecord | null {
	try {
		return readAdminUser(raw);
	} catch {
		return null;
	}
}

/**
 * C6 / D-099: parses the `TTK_ADMIN_USER` record or throws, naming the fault and never the value.
 *
 * `parseAdminUser` answered `null` for anything it could not read, and the gateway took `null` to mean "no seed":
 * a record with a typo started a server that nobody could sign in to and said nothing about why. The caller wraps
 * the message in a `ConfigError` naming the variable, so a malformed record refuses startup instead.
 */
export function readAdminUser(raw: string): AdminUserRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// The parser's own message can quote the input, which is a password hash; only the kind of fault is named.
		throw new Error('not valid JSON');
	}
	const result = AdminUserRecordSchema.safeParse(parsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`;
		throw new Error(`not a valid admin user record${where}: ${issue?.message ?? 'unknown shape'}`);
	}
	return result.data;
}
