/**
 * Single-use tickets for the live-view WebSocket upgrade.
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the SPA
 * exchanges its bearer credential for a short-lived ticket and connects with
 * `?ticket=…`. A ticket that leaks from a proxy log or a referrer is dead
 * within 30 seconds and cannot be replayed.
 *
 * B2.3 (SEC-18) adds three request options, each a narrowing of what the
 * ticket already carries: a requested `ttl_seconds`, clamped to a ceiling that
 * depends on the mode and always echoed as granted; `mode: "view"`, a ticket
 * that can never take control even when the principal could; and origin
 * binding, required whenever the TTL exceeds the 30 s default — a longer-lived
 * ticket must be narrower in some other dimension, and the origin it was
 * minted for is the natural one. A control ticket's ceiling is lower than a
 * view ticket's because it is permission to drive a logged-in browser.
 *
 * See SPECS/DECISION-REGISTER.md D-014 and SPECS/API-CONTRACT.md §4.
 */
import type { SessionAccess } from '@tykotech/mcp';

export const TICKET_PREFIX = 'lvt_';
/** The default life, and the threshold above which a ticket must be origin-bound. */
export const TICKET_TTL_MS = 30_000;
/** The floor: a ticket that cannot survive a round trip is not a ticket. */
export const TICKET_TTL_MIN_MS = 1_000;
/** Ceilings by mode (SEC-18): view 300 s, control 60 s. */
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
	/** The credential's label, carried to the lock message as `holderName` (SEC-15 validated it at parse). */
	readonly holderName: string | null;
	/** The origin the socket must present at upgrade, or `null` when unbound. */
	readonly originBound: string | null;
	/**
	 * The session access the ticket was minted under (R8, design §2.16). S0 seam: copied from
	 * {@linkcode MintOptions.access} when given and absent otherwise; W5's upgrade resolves the session with it.
	 */
	readonly access?: SessionAccess;
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
	/** The caller's session access, carried onto the record (R8, design §2.16). S0 seam for W5 and W7. */
	readonly access?: SessionAccess | undefined;
}

/**
 * The granted TTL for a request: the default when absent, else clamped into `[1 s, ceiling]` where
 * the ceiling depends on the mode. Exported so the route and its tests share one arithmetic.
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
		// The store's own default (a test may shorten it) applies when nothing was requested; a
		// request is clamped by the mode's ceiling.
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
		};
		this.#live.set(record.ticket, record);
		return record;
	}

	/**
	 * Consumes a ticket. A ticket is valid exactly once.
	 *
	 * `origin` is the upgrade request's `Origin` header, or `null` when it sent none. A bound ticket
	 * presented from another origin — or from none — is refused: the binding is the narrowing that
	 * paid for the longer life, and a missing header is not a match.
	 */
	redeem(ticket: string, sessionId: string, origin: string | null = null): TicketRedemption {
		// The lookup precedes the sweep: sweeping first would delete this very
		// ticket when it had just expired and report it as unknown, hiding the
		// difference between "your ticket went stale, mint another" and "that
		// ticket never existed".
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
