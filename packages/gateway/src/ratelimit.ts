/**
 * Per-principal token-bucket rate limiting.
 *
 * Buckets key by principal, not by address, which is why authentication runs
 * before rate limiting: keying by address would let one noisy client exhaust
 * the budget of everyone behind the same proxy.
 */

export interface RateLimiterOptions {
	/** Sustained requests per minute. */
	readonly rpm: number;
	/** Burst capacity; defaults to a third of the sustained rate. */
	readonly burst?: number;
	readonly now?: () => number;
}

export interface RateDecision {
	readonly allowed: boolean;
	/** Seconds to wait before retrying, when refused. */
	readonly retryAfter: number;
	/**
	 * Whole requests still available to this principal after this one was charged (B3.2, §8).
	 *
	 * **The limiter's own accounting, not a second calculation.** It is read from the bucket this
	 * `charge` just wrote, so `x-ratelimit-remaining` cannot drift from what the next `charge` will
	 * actually allow. Floored, because a client can only make whole requests: reporting `0.8` would
	 * invite a caller to believe it has a request it does not have. On a refusal it is `0` — the
	 * bucket holds less than the cost, which is the same statement.
	 */
	readonly remaining: number;
}

interface Bucket {
	tokens: number;
	updatedAt: number;
}

export class RateLimiter {
	readonly #buckets = new Map<string, Bucket>();
	readonly #ratePerMs: number;
	readonly #capacity: number;
	readonly #now: () => number;

	constructor(options: RateLimiterOptions) {
		this.#ratePerMs = options.rpm / 60_000;
		this.#capacity = options.burst ?? Math.max(1, Math.ceil(options.rpm / 3));
		this.#now = options.now ?? (() => Date.now());
	}

	/** Charges one request against a principal's bucket. */
	charge(principal: string, cost = 1): RateDecision {
		const now = this.#now();
		const bucket = this.#buckets.get(principal) ?? { tokens: this.#capacity, updatedAt: now };
		const refill = (now - bucket.updatedAt) * this.#ratePerMs;
		bucket.tokens = Math.min(this.#capacity, bucket.tokens + refill);
		bucket.updatedAt = now;

		if (bucket.tokens < cost) {
			this.#buckets.set(principal, bucket);
			const deficit = cost - bucket.tokens;
			return {
				allowed: false,
				retryAfter: Math.max(1, Math.ceil(deficit / this.#ratePerMs / 1000)),
				remaining: 0,
			};
		}
		bucket.tokens -= cost;
		this.#buckets.set(principal, bucket);
		return { allowed: true, retryAfter: 0, remaining: Math.floor(bucket.tokens) };
	}

	/** Drops idle buckets so the map cannot grow without bound. */
	sweep(idleMs = 600_000): void {
		const cutoff = this.#now() - idleMs;
		for (const [principal, bucket] of this.#buckets) {
			if (bucket.updatedAt < cutoff) this.#buckets.delete(principal);
		}
	}
}
