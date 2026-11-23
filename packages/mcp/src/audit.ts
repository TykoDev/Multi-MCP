/**
 * The per-session audit ledger: one module, three producers, one reader. An entry carries a secret's name and an
 * origin, never a full URL, the secret's value or any hash of it (a confirmation oracle), nor an expression's body.
 */
import { monotonicUlid } from '@std/ulid';

/** Entries one session's ledger holds before the oldest is evicted. */
export const AUDIT_RING_CAPACITY = 200;

/** The privileged operations that write a record. Closed: a fourth one is a deliberate edit. */
export const AUDIT_KINDS = ['secret-fill', 'evaluate', 'read-frame-html'] as const;
type AuditKind = (typeof AUDIT_KINDS)[number];

/** Which filter answered a read, so a reader knows what it is looking at. */
export const AUDIT_SCOPES = ['own', 'all'] as const;
type AuditScope = (typeof AUDIT_SCOPES)[number];

/** One recorded use of a privileged operation. No field here can carry a value; see the module doc. */
export interface AuditEntry {
	/**
	 * A monotonic ULID: lexicographically sortable, which is what makes `since` a string comparison rather than a
	 * scan over timestamps that collide inside one millisecond.
	 */
	readonly audit_id: string;
	/** ISO 8601 UTC. */
	readonly at: string;
	readonly session_id: string;
	/** The acting principal id, as the transport authenticated it. */
	readonly principal: string;
	readonly kind: AuditKind;
	readonly frame_id: string;
	/** Scheme, host and port of the frame — never a full URL. */
	readonly origin: string;
	/** `secret-fill` only: the secret's NAME. */
	readonly secret?: string;
	/** `secret-fill` only: the element index the fill landed on. */
	readonly index?: number;
	/** `evaluate` only: the expression's length in bytes. Never the body. */
	readonly expression_bytes?: number;
	/** `evaluate` only: 16 hex characters of SHA-256 over the expression. Never the body. */
	readonly expression_digest?: string;
	/** `evaluate` and `read-frame-html`: bytes of the payload carried back to the caller, after the cap. */
	readonly result_bytes?: number;
	/** Whether the operation succeeded. For `evaluate`, false means the expression threw. */
	readonly ok?: boolean;
}

/** What a producer supplies; the ledger mints `audit_id` and `at` so neither can be forged upward. */
type AuditAppend = Omit<AuditEntry, 'audit_id' | 'at'>;

/** What one read answers. */
export interface AuditRead {
	readonly entries: readonly AuditEntry[];
	/** Evicted by the ring since the session began, so an overflow is visible rather than inferred. */
	readonly dropped: number;
	readonly scope: AuditScope;
}

interface AuditReadOptions {
	/** The reading principal. Entries are filtered to it unless `all` is true. */
	readonly principal: string;
	/** True only for a principal holding `admin`. Decided by the handler, never here. */
	readonly all?: boolean;
	/** Return entries strictly after this `audit_id`. ULIDs sort, so this is a comparison. */
	readonly since?: string;
	readonly limit?: number;
}

interface AuditLedgerOptions {
	readonly capacity?: number;
	/** Injected clock, so a test can pin `at` and the ULID time half. */
	readonly now?: () => number;
}

/** Default page for a read, matching the tool schema's own ceiling. */
const AUDIT_READ_LIMIT_DEFAULT = 50;
/** Largest page a read may ask for. */
const AUDIT_READ_LIMIT_MAX = 200;

/** One session's ledger. */
export class AuditLedger {
	readonly #capacity: number;
	readonly #now: () => number;
	readonly #entries: AuditEntry[] = [];
	#dropped = 0;

	constructor(options: AuditLedgerOptions = {}) {
		this.#capacity = options.capacity ?? AUDIT_RING_CAPACITY;
		this.#now = options.now ?? Date.now;
	}

	/** Entries currently held. Never the total written — `dropped` carries that. */
	get size(): number {
		return this.#entries.length;
	}

	/** Evicted since the session began. */
	get dropped(): number {
		return this.#dropped;
	}

	/** Records one use and returns the minted entry. */
	append(input: AuditAppend): AuditEntry {
		const at = this.#now();
		// The minted fields come **last**, so a producer that supplied its own `audit_id` or `at` — through a spread,
		// a widened type, or a later refactor — is overwritten rather than trusted.
		const entry: AuditEntry = { ...input, audit_id: monotonicUlid(at), at: new Date(at).toISOString() };
		this.#entries.push(entry);
		while (this.#entries.length > this.#capacity) {
			this.#entries.shift();
			this.#dropped += 1;
		}
		return entry;
	}

	/** Reads the ledger under the caller's own filter. */
	read(options: AuditReadOptions): AuditRead {
		const all = options.all === true;
		const limit = Math.min(Math.max(options.limit ?? AUDIT_READ_LIMIT_DEFAULT, 1), AUDIT_READ_LIMIT_MAX);
		const visible = this.#entries.filter((entry) => {
			if (!all && entry.principal !== options.principal) return false;
			if (options.since !== undefined && entry.audit_id <= options.since) return false;
			return true;
		});
		return {
			entries: visible.slice(-limit),
			dropped: this.#dropped,
			scope: all ? 'all' : 'own',
		};
	}
}

/** 16 hex characters of SHA-256 over an expression. */
export async function expressionDigest(expression: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expression));
	return [...new Uint8Array(digest).subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
