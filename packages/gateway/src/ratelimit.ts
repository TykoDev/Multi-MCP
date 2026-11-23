/** Per-principal token-bucket rate limiting. */

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
	/** Whole requests still available to this principal after this one was charged. */
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
