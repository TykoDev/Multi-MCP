/**
 * The `dom.settled` kind's producer (owner item 3, D-8).
 *
 * The page reports DOM mutations through the shared injected listener the
 * `input` kind installs (one injection, two kinds); this module owns the
 * server-side half: a debounce that decides the page is *quiet* after
 * `quiet_ms` with no mutation, and the token that names the state at that
 * moment.
 *
 * ## The contract, and what makes it expensive
 *
 * A `dom.settled` record carries `{token, mutations, quiet_ms}`, where `token`
 * **equals the `state_token` `browser_get_state` would return at that moment**
 * (owner item 3, overriding the design's D-8 which dropped the token as too
 * costly). A `state_token` is minted only by a DOM build, so obtaining it means
 * a real capture — a settle event genuinely costs a `browser_get_state`. That
 * is why minting is gated on the ring's `domSettledSubscribers` refcount: a
 * session nobody is watching still observes mutations (the injection is shared
 * and always on) but does **no** reads. The cost, and the reason for it, are
 * recorded at the site rather than hidden.
 *
 * `mutations` is the count observed across the quiet window's lead-up — every
 * batch since the last settle — and never any node, attribute, value or text,
 * because the injection reports only a count. `quiet_ms` is the window that had
 * to pass in silence, so a consumer can tell a 500 ms-quiet settle from a
 * differently-configured one.
 */
import type { SessionRecord } from './registry.ts';

/** The quiet window a `dom.settled` record is minted after, matching the requirement's default. */
export const DOM_SETTLE_QUIET_MS = 500;

export interface DomSettleProducerOptions {
	readonly record: SessionRecord;
	/** Milliseconds of quiet before a settle. Defaults to {@linkcode DOM_SETTLE_QUIET_MS}. */
	readonly quietMs?: number;
	readonly logger?: { warn(message: string): void };
}

/**
 * Debounces mutation batches into one `dom.settled` per quiet transition.
 *
 * One instance per {@linkcode SessionRecord}, fed by the input producer's
 * `onMutation`. {@linkcode DomSettleProducer.dispose} is the single teardown and
 * is idempotent; the pending timer never holds the process open.
 */
export class DomSettleProducer {
	readonly #record: SessionRecord;
	readonly #quietMs: number;
	readonly #logger: { warn(message: string): void } | undefined;
	#pending = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#minting = false;
	#disposed = false;

	constructor(options: DomSettleProducerOptions) {
		this.#record = options.record;
		this.#quietMs = options.quietMs ?? DOM_SETTLE_QUIET_MS;
		this.#logger = options.logger;
	}

	/** Mutations accumulated toward the next settle. Exposed for tests. */
	get pending(): number {
		return this.#pending;
	}

	/** True while a settle read is in flight. Exposed for tests. */
	get minting(): boolean {
		return this.#minting;
	}

	/**
	 * Records one batch of mutations and restarts the quiet window.
	 *
	 * "Quiet" means `quietMs` with **nothing** mutating, not "nothing mutating
	 * right now", so every batch pushes the deadline out — a page mutating every
	 * 200 ms never settles, which is the truthful answer.
	 */
	onMutation = (count: number): void => {
		if (this.#disposed) return;
		this.#pending += count;
		this.#arm();
	};

	#arm(): void {
		this.#disarm();
		const timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#settle();
		}, this.#quietMs);
		// Never the reason the runtime stays alive: a settle is worth minting when
		// the process is up anyway, not worth holding it open.
		Deno.unrefTimer(timer as unknown as number);
		this.#timer = timer;
	}

	#disarm(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	async #settle(): Promise<void> {
		if (this.#disposed || this.#minting) return;
		const mutations = this.#pending;
		this.#pending = 0;
		// The gate: no subscriber, no read. The mutations were observed for free;
		// the token is what costs, so it is paid only when someone wants the kind.
		if (mutations === 0 || this.#record.events.domSettledSubscribers === 0) return;
		this.#minting = true;
		try {
			// The token must equal what `browser_get_state` would return now, so it
			// comes from an actual read rather than a cached value that predates the
			// settle. `includeDom: true` is the single-writer path that mints the
			// token (E-36).
			const summary = await this.#record.session.getBrowserStateSummary({ includeDom: true });
			if (this.#disposed) return;
			this.#record.events.append('dom.settled', {
				token: summary.stateToken ?? null,
				mutations,
				quiet_ms: this.#quietMs,
			});
		} catch (error) {
			// A read that failed is not a settle worth minting a token for; the next
			// quiet window will try again. Never per-batch, so a failing read cannot
			// become a log amplifier.
			this.#logger?.warn(`dom.settled read failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#minting = false;
		}
	}

	/** Clears the pending timer and stops accepting batches. Idempotent. */
	dispose(): void {
		this.#disposed = true;
		this.#disarm();
	}
}
