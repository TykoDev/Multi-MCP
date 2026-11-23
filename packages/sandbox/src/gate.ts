/**
 * Who may run now: one thing at a time per run (else 409, also while it is removed), and LIMITS.running at once
 * overall, in order, with at most LIMITS.waiting queued for up to LIMITS.maxWaitMs (else 429 busy).
 */
import { LIMITS } from './limits.ts';

export class GateError extends Error {
	constructor(readonly status: 409 | 429 | 499, readonly code: string, message: string) {
		super(message);
		this.name = 'GateError';
	}
}

interface Waiter {
	resolve(): void;
	reject(err: Error): void;
}

export class Gate {
	#running = 0;
	readonly #queue: Waiter[] = [];

	constructor(
		readonly max: number = LIMITS.running,
		readonly maxWaiting: number = LIMITS.waiting,
		readonly maxWaitMs: number = LIMITS.maxWaitMs,
	) {}

	get running(): number {
		return this.#running;
	}

	get waiting(): number {
		return this.#queue.length;
	}

	/** Resolves with a release function once there is room; the release must be called once. */
	async enter(signal?: AbortSignal): Promise<() => void> {
		// An abort listener added to a signal already aborted never fires.
		if (signal?.aborted) throw new GateError(499, 'cancelled', 'The request was cancelled.');
		if (this.#running < this.max && this.#queue.length === 0) {
			this.#running++;
			return this.#release();
		}
		if (this.#queue.length >= this.maxWaiting) {
			throw new GateError(429, 'busy', 'The sandbox is busy; try again shortly.');
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				resolve: () => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', onAbort);
					resolve();
				},
				reject: (err) => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', onAbort);
					const i = this.#queue.indexOf(waiter);
					if (i >= 0) this.#queue.splice(i, 1);
					reject(err);
				},
			};
			const timer = setTimeout(
				() => waiter.reject(new GateError(429, 'busy', 'The sandbox is busy; try again shortly.')),
				this.maxWaitMs,
			);
			// A caller that went away was cancelled, not refused as busy.
			const onAbort = () => waiter.reject(new GateError(499, 'cancelled', 'The request was cancelled.'));
			signal?.addEventListener('abort', onAbort, { once: true });
			this.#queue.push(waiter);
		});
		return this.#release();
	}

	#release(): () => void {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const next = this.#queue.shift();
			// The slot passes straight to the next in line, so the count never dips and lets a newcomer
			// jump the queue.
			if (next) next.resolve();
			else this.#running--;
		};
	}
}

/**
 * One owner's share of a first-come {@linkcode Gate}, taken before it, so one principal cannot fill every slot and
 * the queue: `max` slots with `maxWaiting` behind them, else 429 `busy`. Forgotten once nothing holds or waits on it.
 */
export class OwnerGates {
	readonly #gates = new Map<string, Gate>();

	constructor(
		readonly max: number = LIMITS.ownerRunning,
		readonly maxWaiting: number = LIMITS.ownerWaiting,
		readonly maxWaitMs: number = LIMITS.maxWaitMs,
	) {}

	/** Owners with something held or waiting now (tests). */
	get size(): number {
		return this.#gates.size;
	}

	/** Resolves with a release function once `owner` has room in its share; the release must be called once. */
	async enter(owner: string, signal?: AbortSignal): Promise<() => void> {
		let gate = this.#gates.get(owner);
		if (gate === undefined) {
			gate = new Gate(this.max, this.maxWaiting, this.maxWaitMs);
			this.#gates.set(owner, gate);
		}
		const held = gate;
		let release: () => void;
		try {
			release = await held.enter(signal);
		} catch (error) {
			this.#forget(owner, held);
			throw error;
		}
		let done = false;
		return () => {
			if (done) return;
			done = true;
			release();
			this.#forget(owner, held);
		};
	}

	#forget(owner: string, gate: Gate): void {
		if (gate.running === 0 && gate.waiting === 0 && this.#gates.get(owner) === gate) this.#gates.delete(owner);
	}
}

/** The refusal of an owner past its share of live sessions, in the session gate's own 429 `busy`. */
export function ownerSessionsBusy(): GateError {
	return new GateError(
		429,
		'busy',
		`The sandbox is busy: one owner may keep at most ${LIMITS.ownerSessions} live sessions; close one first.`,
	);
}

interface Active {
	controller: AbortController;
	done: Promise<void>;
}

/** The runs with something under way, so one can be cancelled and a second refused. */
export class Runs {
	readonly #active = new Map<string, Active>();
	readonly #removing = new Set<string>();

	/** Marks a run busy while `work` runs, with a signal that aborts when the caller goes or the run is removed. */
	async hold<T>(
		runId: string,
		outer: AbortSignal | undefined,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (this.#removing.has(runId)) {
			throw new GateError(409, 'run_busy', 'This run is being removed.');
		}
		if (this.#active.has(runId)) {
			throw new GateError(409, 'run_busy', 'This run already has a command under way.');
		}
		// Linked by hand rather than with AbortSignal.any, so that nothing is left listening on the
		// request's signal once the work is done: Deno aborts that signal after every response too.
		const controller = new AbortController();
		const onOuter = () => controller.abort();
		outer?.addEventListener('abort', onOuter, { once: true });
		if (outer?.aborted) controller.abort();
		let finish!: () => void;
		this.#active.set(runId, { controller, done: new Promise<void>((r) => finish = r) });
		try {
			return await work(controller.signal);
		} finally {
			outer?.removeEventListener('abort', onOuter);
			this.#active.delete(runId);
			finish();
		}
	}

	/** Stops what the run has under way and keeps new work out while `work` (a removal) runs. */
	async removing<T>(runId: string, work: () => Promise<T>): Promise<T> {
		if (this.#removing.has(runId)) {
			throw new GateError(409, 'run_busy', 'This run is already being removed.');
		}
		this.#removing.add(runId);
		try {
			const active = this.#active.get(runId);
			if (active) {
				active.controller.abort();
				await active.done;
			}
			return await work();
		} finally {
			this.#removing.delete(runId);
		}
	}

	/** Cancels everything, for shutting down. */
	cancelAll(): void {
		for (const active of this.#active.values()) active.controller.abort();
	}
}
