/**
 * Live session bookkeeping (D-076): the output ring a reader collects from, the waiters a long-poll parks
 * on, and the idle and lifetime clocks. Nothing here touches a cage; `sandbox.ts` runs the cage and feeds
 * `push`, `end` and the input file.
 */
import { LIMITS } from './limits.ts';

export interface SessionRead {
	/** Bytes of output after `after`, as UTF-8 text (a split code point is carried to the next read). */
	output: string;
	/** The offset to pass as `after` next time. */
	seq: number;
	/** True when `after` was older than what the ring still holds: some output was never delivered. */
	gap: boolean;
	ended: boolean;
	exit_code: number | null;
	killed: string | null;
}

export class SessionState {
	readonly id = crypto.randomUUID();
	readonly createdAt = Date.now();
	lastActivity = Date.now();
	/** Total bytes ever pushed; the ring holds the tail of them. */
	#total = 0;
	#chunks: Array<{ start: number; bytes: Uint8Array }> = [];
	#held = 0;
	#ended: { exitCode: number | null; killed: string | null } | null = null;
	#waiters = new Set<() => void>();
	#inputBytes = 0;

	constructor(readonly runId: string, readonly owner: string) {}

	get ended(): boolean {
		return this.#ended !== null;
	}

	get idleMs(): number {
		return Date.now() - this.lastActivity;
	}

	get ageMs(): number {
		return Date.now() - this.createdAt;
	}

	/** Input accounted so far; the session ends once a caller has fed more than `limit`. */
	countInput(bytes: number, limit: number): boolean {
		this.#inputBytes += bytes;
		this.lastActivity = Date.now();
		return this.#inputBytes <= limit;
	}

	push(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		this.#chunks.push({ start: this.#total, bytes });
		this.#total += bytes.length;
		this.#held += bytes.length;
		while (this.#held > LIMITS.sessionOutputBytes && this.#chunks.length > 1) {
			this.#held -= this.#chunks.shift()!.bytes.length;
		}
		this.lastActivity = Date.now();
		this.#wake();
	}

	end(exitCode: number | null, killed: string | null): void {
		if (this.#ended !== null) return;
		this.#ended = { exitCode, killed };
		this.#wake();
	}

	#wake(): void {
		for (const waiter of [...this.#waiters]) waiter();
		this.#waiters.clear();
	}

	/** Output after `after`, waiting up to `waitMs` for some to arrive when there is none yet. */
	async read(after: number, waitMs: number): Promise<SessionRead> {
		const deadline = Date.now() + Math.min(Math.max(waitMs, 0), LIMITS.sessionReadWaitMs);
		for (;;) {
			const oldest = this.#chunks[0]?.start ?? this.#total;
			const from = Math.max(after, oldest);
			if (from < this.#total || this.#ended !== null) {
				const parts: Uint8Array[] = [];
				for (const chunk of this.#chunks) {
					const end = chunk.start + chunk.bytes.length;
					if (end <= from) continue;
					parts.push(chunk.bytes.subarray(Math.max(0, from - chunk.start)));
				}
				const size = parts.reduce((sum, part) => sum + part.length, 0);
				const joined = new Uint8Array(size);
				let at = 0;
				for (const part of parts) {
					joined.set(part, at);
					at += part.length;
				}
				// A UTF-8 sequence cut by the chunk boundary is left for the next read rather than mangled.
				let keep = joined.length;
				for (let back = 1; back <= 3 && back <= joined.length; back += 1) {
					const byte = joined[joined.length - back]!;
					if ((byte & 0xc0) === 0x80) continue;
					if ((byte & 0xe0) === 0xc0 && back < 2) keep = joined.length - back;
					else if ((byte & 0xf0) === 0xe0 && back < 3) keep = joined.length - back;
					else if ((byte & 0xf8) === 0xf0 && back < 4) keep = joined.length - back;
					break;
				}
				if (this.#ended !== null) keep = joined.length;
				return {
					output: new TextDecoder().decode(joined.subarray(0, keep)),
					seq: from + keep,
					gap: after < oldest,
					ended: this.#ended !== null,
					exit_code: this.#ended?.exitCode ?? null,
					killed: this.#ended?.killed ?? null,
				};
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return { output: '', seq: this.#total, gap: false, ended: false, exit_code: null, killed: null };
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.#waiters.delete(waiter);
					resolve();
				}, remaining);
				const waiter = (): void => {
					clearTimeout(timer);
					resolve();
				};
				this.#waiters.add(waiter);
			});
		}
	}
}
