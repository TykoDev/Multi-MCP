/** Single-use tickets for the live-view WebSocket upgrade. */
import type { Scope, SessionAccess } from '@tykotech/mcp';

const TICKET_PREFIX = 'lvt_';
/** The default life, and the threshold above which a ticket must be origin-bound. */
export const TICKET_TTL_MS = 30_000;
/** The floor: a ticket that cannot survive a round trip is not a ticket. */
const TICKET_TTL_MIN_MS = 1_000;
/** Ceilings by mode: view 300 s, control 60 s. */
export const TICKET_TTL_MAX_VIEW_MS = 300_000;
export const TICKET_TTL_MAX_CONTROL_MS = 60_000;

export type ViewMode = 'watch' | 'control';

export interface TicketRecord {
	readonly ticket: string;
	readonly principal: string;
	readonly sessionId: string;
	readonly mode: ViewMode;
	readonly expiresAt: number;
	/** The life actually granted, after clamping. */
	readonly ttlMs: number;
	/** The credential's label, carried to the lock message as `holderName` (validated when the key records were parsed). */
	readonly holderName: string | null;
	/** The origin the socket must present at upgrade, or `null` when unbound. */
	readonly originBound: string | null;
	/**
	 * The session access the ticket was minted under: copied from {@linkcode MintOptions.access} when given and absent
	 * otherwise; the upgrade resolves the session with it.
	 */
	readonly access?: SessionAccess;
	/** The scopes the minting credential held at mint. */
	readonly scopes?: ReadonlySet<Scope>;
	/**
	 * The opaque fingerprint of the exact credential that minted the ticket. In-process only: never rendered, logged or
	 * returned (the mint's response is built field by field and names none of it).
	 */
	readonly credential?: string;
}

export type TicketFailure = 'unknown' | 'expired' | 'consumed' | 'session-mismatch' | 'origin-mismatch';

export type TicketRedemption =
	| { ok: true; record: TicketRecord }
	| { ok: false; reason: TicketFailure };

export interface TicketStoreOptions {
	readonly ttlMs?: number;
	readonly now?: () => number;
}

export interface MintOptions {
	/** Requested life; clamped by {@linkcode clampTicketTtl}. Absent means the default. */
	readonly ttlMs?: number | undefined;
	readonly holderName?: string | null | undefined;
	/** Binds redemption to one origin; required above the default TTL, and the caller enforces that. */
	readonly origin?: string | null | undefined;
	/** The caller's session access, carried onto the record for the upgrade to resolve the session with. */
	readonly access?: SessionAccess | undefined;
	/** The minting credential's scopes, carried onto the record for the socket's re-check. */
	readonly scopes?: ReadonlySet<Scope> | undefined;
	/** The minting credential's fingerprint, carried onto the record for the socket's re-check. */
	readonly credential?: string | undefined;
}

/**
 * The granted TTL for a request: the default when absent, else clamped into `[1 s, ceiling]` where the ceiling depends
 * on the mode. Exported so the route and its tests share one arithmetic.
 */
export function clampTicketTtl(requestedMs: number | undefined, mode: ViewMode): number {
	if (requestedMs === undefined || !Number.isFinite(requestedMs)) return TICKET_TTL_MS;
	const ceiling = mode === 'control' ? TICKET_TTL_MAX_CONTROL_MS : TICKET_TTL_MAX_VIEW_MS;
	return Math.min(ceiling, Math.max(TICKET_TTL_MIN_MS, Math.round(requestedMs)));
}

export class TicketStore {
	readonly #live = new Map<string, TicketRecord>();
	/** Remembered briefly so a replay reports "consumed" rather than "unknown". */
	readonly #consumed = new Map<string, number>();
	readonly #ttlMs: number;
	readonly #now: () => number;

	constructor(options: TicketStoreOptions = {}) {
		this.#ttlMs = options.ttlMs ?? TICKET_TTL_MS;
		this.#now = options.now ?? (() => Date.now());
	}

	get size(): number {
		return this.#live.size;
	}

	mint(principal: string, sessionId: string, mode: ViewMode, options: MintOptions = {}): TicketRecord {
		this.#sweep();
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		const body = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		// The store's own default (a test may shorten it) applies when nothing was requested; a request is clamped by
		// the mode's ceiling.
		const ttlMs = options.ttlMs === undefined ? this.#ttlMs : clampTicketTtl(options.ttlMs, mode);
		const record: TicketRecord = {
			ticket: `${TICKET_PREFIX}${body}`,
			principal,
			sessionId,
			mode,
			expiresAt: this.#now() + ttlMs,
			ttlMs,
			holderName: options.holderName ?? null,
			originBound: options.origin ?? null,
			// Only when given, so a record minted without one keeps exactly its previous shape.
			...(options.access === undefined ? {} : { access: options.access }),
			...(options.scopes === undefined ? {} : { scopes: options.scopes }),
			...(options.credential === undefined ? {} : { credential: options.credential }),
		};
		this.#live.set(record.ticket, record);
		return record;
	}

	/** Consumes a ticket. A ticket is valid exactly once. */
	redeem(ticket: string, sessionId: string, origin: string | null = null): TicketRedemption {
		// The lookup precedes the sweep: sweeping first would delete this very ticket when it had just expired and
		// report it as unknown, hiding the difference between "your ticket went stale, mint another" and "that ticket
		// never existed".
		const record = this.#live.get(ticket);
		this.#sweep();
		if (record === undefined) {
			return { ok: false, reason: this.#consumed.has(ticket) ? 'consumed' : 'unknown' };
		}
		this.#live.delete(ticket);
		this.#consumed.set(ticket, this.#now() + this.#ttlMs);
		if (record.expiresAt <= this.#now()) return { ok: false, reason: 'expired' };
		// The path is authoritative: a ticket for one session must not open another.
		if (record.sessionId !== sessionId) return { ok: false, reason: 'session-mismatch' };
		if (record.originBound !== null && origin !== record.originBound) return { ok: false, reason: 'origin-mismatch' };
		return { ok: true, record };
	}

	/** Lazy expiry: no background timer to cancel at shutdown. */
	#sweep(): void {
		const now = this.#now();
		for (const [ticket, record] of this.#live) {
			if (record.expiresAt <= now) this.#live.delete(ticket);
		}
		for (const [ticket, forgetAt] of this.#consumed) {
			if (forgetAt <= now) this.#consumed.delete(ticket);
		}
	}
}
