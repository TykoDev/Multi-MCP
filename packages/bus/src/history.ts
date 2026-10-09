/**
 * Bounded event history (ARCHITECTURE.md §4.4) — backs the `recentEvents` block of
 * `BrowserStateSummary` (DATA-MODEL.md §5.3, "last 10 bus events as JSON") and debugging dumps.
 *
 * A fixed-capacity ring: push is O(1) and memory is capped regardless of run length.
 */

import type { BaseEvent } from './event.ts';

/** Default ring capacity — comfortably above the 10 events the prompt block consumes. */
export const DEFAULT_HISTORY_LIMIT = 100;

/** Fixed-capacity, oldest-evicting ring of dispatched events. */
export class EventHistory implements Iterable<BaseEvent<unknown>> {
	readonly #slots: (BaseEvent<unknown> | undefined)[];
	#next = 0;
	#count = 0;

	constructor(limit: number = DEFAULT_HISTORY_LIMIT) {
		const capacity = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
		this.#slots = new Array(capacity).fill(undefined);
	}

	/** Maximum retained events. */
	get limit(): number {
		return this.#slots.length;
	}

	/** Currently retained events. */
	get size(): number {
		return this.#count;
	}

	/** Appends an event, evicting the oldest once the ring is full. */
	push(event: BaseEvent<unknown>): void {
		if (this.#slots.length === 0) return;
		this.#slots[this.#next] = event;
		this.#next = (this.#next + 1) % this.#slots.length;
		if (this.#count < this.#slots.length) this.#count += 1;
	}

	/** Snapshot, oldest first. */
	toArray(): BaseEvent<unknown>[] {
		const out: BaseEvent<unknown>[] = [];
		const start = (this.#next - this.#count + this.#slots.length) % (this.#slots.length || 1);
		for (let i = 0; i < this.#count; i += 1) {
			const slot = this.#slots[(start + i) % this.#slots.length];
			if (slot !== undefined) out.push(slot);
		}
		return out;
	}

	/** The `n` most recent events, oldest first. */
	recent(n: number): BaseEvent<unknown>[] {
		if (n <= 0) return [];
		const all = this.toArray();
		return all.slice(Math.max(0, all.length - Math.floor(n)));
	}

	/** Drops all retained events. */
	clear(): void {
		this.#slots.fill(undefined);
		this.#next = 0;
		this.#count = 0;
	}

	[Symbol.iterator](): IterableIterator<BaseEvent<unknown>> {
		return this.toArray()[Symbol.iterator]();
	}
}
