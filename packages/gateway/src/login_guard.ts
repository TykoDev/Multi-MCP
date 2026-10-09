/**
 * D-078: failed sign-ins slow their author down.
 *
 * `/api/v1/auth/login` is public, so the per-principal rate limiter never sees it: there is no principal until
 * the guess is right. Two counters stand in for it, each with exponential backoff once its free failures are
 * spent:
 *
 * - per source address, up to `source.maxMs` (15 min): one host guessing many accounts or many API keys;
 * - per username, up to `user.maxMs` (60 s): many hosts guessing one account. Its ceiling is deliberately low,
 *   because anyone can spend an account's failures: a long block would hand every stranger a way to keep the
 *   administrator out (no hard lockout — D-078).
 *
 * A success clears that username's counter only. The source counter decays with its window, so signing in to
 * one's own account cannot buy a fresh guessing budget for someone else's.
 *
 * Behind a reverse proxy every request has the proxy's address; the username counter still applies, and the
 * deployment guide says to rate-limit the login route at the proxy.
 */

export interface BackoffPolicy {
	/** Failures allowed before the first delay. */
	readonly free: number;
	/** The first delay; each further failure doubles it. */
	readonly baseMs: number;
	readonly maxMs: number;
	/** A counter idle this long is forgotten. */
	readonly windowMs: number;
}

export const LOGIN_GUARD_DEFAULTS = {
	source: { free: 5, baseMs: 1_000, maxMs: 15 * 60_000, windowMs: 15 * 60_000 },
	user: { free: 10, baseMs: 1_000, maxMs: 60_000, windowMs: 15 * 60_000 },
	/** Counters kept at most; the oldest go first, so a flood of addresses cannot grow memory without bound. */
	maxEntries: 10_000,
} as const;

interface Counter {
	failures: number;
	blockedUntil: number;
	last: number;
}

export type GuardDecision = { allowed: true } | { allowed: false; retryAfterS: number };

export class LoginGuard {
	readonly #counters = new Map<string, Counter>();
	readonly #now: () => number;
	readonly #source: BackoffPolicy;
	readonly #user: BackoffPolicy;
	readonly #maxEntries: number;

	constructor(
		options: {
			now?: () => number;
			source?: BackoffPolicy;
			user?: BackoffPolicy;
			maxEntries?: number;
		} = {},
	) {
		this.#now = options.now ?? Date.now;
		this.#source = options.source ?? LOGIN_GUARD_DEFAULTS.source;
		this.#user = options.user ?? LOGIN_GUARD_DEFAULTS.user;
		this.#maxEntries = options.maxEntries ?? LOGIN_GUARD_DEFAULTS.maxEntries;
	}

	/** Whether an attempt from `source` (for `username`, when one is given) may be checked at all. */
	check(source: string, username: string | null): GuardDecision {
		const now = this.#now();
		let wait = 0;
		for (const key of keysOf(source, username)) {
			const counter = this.#live(key, now);
			if (counter !== null && counter.blockedUntil > now) wait = Math.max(wait, counter.blockedUntil - now);
		}
		return wait > 0 ? { allowed: false, retryAfterS: Math.ceil(wait / 1000) } : { allowed: true };
	}

	/** Records a failed attempt; returns the delay the next attempt now faces, in seconds (0 for none). */
	fail(source: string, username: string | null): number {
		const now = this.#now();
		let wait = 0;
		for (const key of keysOf(source, username)) {
			const policy = key.startsWith('u:') ? this.#user : this.#source;
			const counter = this.#live(key, now) ?? { failures: 0, blockedUntil: 0, last: now };
			counter.failures += 1;
			counter.last = now;
			const over = counter.failures - policy.free;
			if (over > 0) {
				const delay = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(over - 1, 30));
				counter.blockedUntil = now + delay;
				wait = Math.max(wait, delay);
			}
			this.#counters.delete(key);
			this.#counters.set(key, counter);
		}
		while (this.#counters.size > this.#maxEntries) {
			this.#counters.delete(this.#counters.keys().next().value!);
		}
		return Math.ceil(wait / 1000);
	}

	/** A correct sign-in for `username`: its counter is cleared; the source's is not (see the module note). */
	succeed(username: string | null): void {
		if (username !== null) this.#counters.delete(userKey(username));
	}

	/** Forgets counters idle past their window; returns how many remain. */
	sweep(): number {
		const now = this.#now();
		for (const key of [...this.#counters.keys()]) this.#live(key, now);
		return this.#counters.size;
	}

	#live(key: string, now: number): Counter | null {
		const counter = this.#counters.get(key);
		if (counter === undefined) return null;
		const policy = key.startsWith('u:') ? this.#user : this.#source;
		if (now - counter.last > policy.windowMs && counter.blockedUntil <= now) {
			this.#counters.delete(key);
			return null;
		}
		return counter;
	}
}

const userKey = (username: string) => `u:${username.toLowerCase()}`;

function keysOf(source: string, username: string | null): string[] {
	return username === null || username === '' ? [`s:${source}`] : [`s:${source}`, userKey(username)];
}
