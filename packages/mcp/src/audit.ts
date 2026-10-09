/**
 * The per-session audit ledger: one module, three producers, one reader (design §6.5).
 *
 * `needed-browser-functions.md` §6 asks for "an `audit` entry the server keeps per use
 * (`{secret, element, at}`) that ADM can read", `report_architecture.md` §7.6 routes
 * `browser_evaluate` into the same ledger, and D-058 routes `browser_get_html`'s cross-origin frame
 * read into it as well. Several producers writing one record is exactly the shape that grows a
 * second, subtly different contract if the rules are left to whichever slice lands last, so they are
 * settled here, in the module that owns the fact.
 *
 * ## What an entry may carry
 *
 * The secret's **name**; the element index and its frame id; the **origin** typed into or evaluated
 * in — scheme, host and port, never a full URL, because a URL is exactly where a one-time code or a
 * session token appears (`SPECS/SECURITY-AUTH.md` §8.3); the acting principal; the session; the
 * timestamp; the outcome. For an evaluated expression, additionally its **length in bytes** and a
 * 16-hex-character digest.
 *
 * ## What an entry may never carry, and why each
 *
 * - **The secret's value, or any prefix, suffix, length or hash of it.** A hash is not a redaction:
 *   for a credential drawn from any realistic distribution it is a confirmation oracle (SEC-08).
 *   This is why the interface has no field a value could be put in — the shape refuses it rather
 *   than a reviewer having to notice.
 * - **Any evaluated expression body, not even a bounded prefix.** An expression is
 *   attacker-influenced text and a prefix is precisely where a credential-exfiltrating one would put
 *   its payload (`report_architecture.md` §7.6). `expression_bytes` plus `expression_digest` answers
 *   "was arbitrary code run, how much of it, and was it the same code as last time" while disclosing
 *   nothing the caller did not already send. The digest is of the **expression**; a caller who
 *   inlines a credential into one has put it somewhere this ledger cannot un-put it, which is a
 *   caller mistake the tool description names.
 * - **The full URL, the element's surrounding text or `outerHTML`, or any adjacent field's value.**
 * - **No document bytes, no prefix of a document, no digest of a document.** A `read-frame-html`
 *   entry records that a cross-origin document was read, from which frame and which origin, and how
 *   much came back — never any of it. A digest would be a confirmation oracle for a page an attacker
 *   can guess, which is SEC-08's argument applied to a second kind of content, and a prefix is
 *   precisely where the interesting markup is. `result_bytes` is permitted with its own argument:
 *   the principal that wrote the row has already *received* the document, so its size discloses
 *   nothing to that principal, and another principal sees the row only under `admin`.
 *
 * ## Read scope, lifetime
 *
 * `browser_audit` returns the calling principal's **own** entries under `mcp:invoke` and **all**
 * entries only under `admin` (SEC-08). `mcp:invoke` is shared by design, so an unfiltered read under
 * it would hand every session-sharing principal a map of every other principal's credential use.
 *
 * In memory, per session, a {@linkcode AUDIT_RING_CAPACITY}-entry oldest-evicting ring, dropped with
 * the session, **never written under `TTK_DATA_DIR`** — a persistent record of which credential was
 * spent against which origin is a target. There is no file API in this module, which is the point.
 */
import { monotonicUlid } from '@std/ulid';

/**
 * Entries one session's ledger holds before the oldest is evicted.
 *
 * 200 rather than the 50 SEC-08 proposed, recorded as IR-6 with its argument: SEC-08 reached 50 by
 * following `LIFECYCLE_RING_CAPACITY`, and the architecture already overruled that precedent for the
 * event ring at §4.3 ("a different ring, a different reader, a different window"). It applies more
 * strongly here — the event ring is read inside a reconnect window, an audit ledger is read after
 * the fact, and losing the record that a server-held credential was spent is a worse loss than
 * losing a console line. `dropped` is on the wire so an overflow is visible rather than inferred.
 */
export const AUDIT_RING_CAPACITY = 200;

/**
 * The privileged operations that write a record. Closed: a fourth one is a deliberate edit.
 *
 * `read-frame-html` joined at 0.2.0 (D-058): `browser_get_html` can read a **cross-origin** frame's
 * document, which is a capability `browser_evaluate` used to hold alone, so the read is bound to the
 * same `evaluate` grant and recorded in the same ledger. Only that path writes — a same-origin frame
 * and the top document write nothing, because nothing privileged happened.
 */
export const AUDIT_KINDS = ['secret-fill', 'evaluate', 'read-frame-html'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** Which filter answered a read, so a reader knows what it is looking at. */
export const AUDIT_SCOPES = ['own', 'all'] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

/** One recorded use of a privileged operation. No field here can carry a value; see the module doc. */
export interface AuditEntry {
	/**
	 * A monotonic ULID: lexicographically sortable, which is what makes `since` a string comparison
	 * rather than a scan over timestamps that collide inside one millisecond. Minted from `@std/ulid`,
	 * which the registry already depends on — a hand-rolled sortable id would be a second answer to a
	 * question this workspace has already answered.
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
	/**
	 * Whether the operation succeeded. For `evaluate`, false means the expression threw.
	 *
	 * For `read-frame-html` a row exists only for a read that returned a document, so it is always
	 * true; a refusal writes no row. That asymmetry with `evaluate` is deliberate: there, "arbitrary
	 * code ran here" is the fact worth recording and an expression that throws has still run, while
	 * here a refusal means no document was read at all.
	 */
	readonly ok?: boolean;
}

/** What a producer supplies; the ledger mints `audit_id` and `at` so neither can be forged upward. */
export type AuditAppend = Omit<AuditEntry, 'audit_id' | 'at'>;

/** What one read answers. */
export interface AuditRead {
	readonly entries: readonly AuditEntry[];
	/** Evicted by the ring since the session began, so an overflow is visible rather than inferred. */
	readonly dropped: number;
	readonly scope: AuditScope;
}

export interface AuditReadOptions {
	/** The reading principal. Entries are filtered to it unless `all` is true. */
	readonly principal: string;
	/** True only for a principal holding `admin` (SEC-08). Decided by the handler, never here. */
	readonly all?: boolean;
	/** Return entries strictly after this `audit_id`. ULIDs sort, so this is a comparison. */
	readonly since?: string;
	readonly limit?: number;
}

export interface AuditLedgerOptions {
	readonly capacity?: number;
	/** Injected clock, so a test can pin `at` and the ULID time half. */
	readonly now?: () => number;
}

/** Default page for a read, matching the tool schema's own ceiling. */
export const AUDIT_READ_LIMIT_DEFAULT = 50;
/** Largest page a read may ask for. */
export const AUDIT_READ_LIMIT_MAX = 200;

/**
 * One session's ledger.
 *
 * Deliberately not a general log: it records privileged operations, and a module that also accepted
 * ordinary events would end up with entries nobody had applied these rules to.
 */
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

	/**
	 * Records one use and returns the minted entry.
	 *
	 * The producer never chooses `audit_id` or `at`: an identifier a caller could supply would let
	 * two calls claim the same record, and a timestamp a caller could supply is not evidence of
	 * anything.
	 */
	append(input: AuditAppend): AuditEntry {
		const at = this.#now();
		// The minted fields come **last**, so a producer that supplied its own `audit_id` or `at` —
		// through a spread, a widened type, or a later refactor — is overwritten rather than trusted.
		// Written this way because a test caught the other order: `{minted, ...input}` let the caller
		// win, and an identifier a caller can choose lets two calls claim one record.
		const entry: AuditEntry = { ...input, audit_id: monotonicUlid(at), at: new Date(at).toISOString() };
		this.#entries.push(entry);
		while (this.#entries.length > this.#capacity) {
			this.#entries.shift();
			this.#dropped += 1;
		}
		return entry;
	}

	/**
	 * Reads the ledger under the caller's own filter.
	 *
	 * The filter is applied **here**, over the whole ring, before the page is cut — filtering after
	 * paging would let a principal infer how many entries another principal wrote by watching short
	 * pages.
	 */
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

/**
 * 16 hex characters of SHA-256 over an expression.
 *
 * Enough to correlate repeated calls — "is this the same code as last time" — and short enough that
 * it is not a recovery path for the body. It is computed over the **expression**, which the caller
 * already sent; it is never computed over a secret value, where a digest would be a confirmation
 * oracle rather than a redaction (SEC-08).
 */
export async function expressionDigest(expression: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expression));
	return [...new Uint8Array(digest).subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
