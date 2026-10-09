/**
 * Timer helpers. Every timer created here is cleared on the settling path so the op sanitizer stays
 * quiet (OBSERVABILITY §4.1.3) and so `FakeTime` can drive the clock in tests.
 */

const TIMED_OUT = Symbol('bus.deadline');

/** Outcome of a deadline race. `value` is `undefined` when the deadline won. */
export interface DeadlineOutcome<T> {
	readonly timedOut: boolean;
	readonly value: T | undefined;
}

/**
 * Resolves with the promise's value, or reports `timedOut` after `ms`.
 *
 * A non-finite or non-positive `ms` disables the deadline. Rejections propagate unchanged.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
	if (!Number.isFinite(ms) || ms <= 0) {
		return { timedOut: false, value: await promise };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), ms);
	});
	try {
		const winner = await Promise.race([promise, expiry]);
		return winner === TIMED_OUT ? { timedOut: true, value: undefined } : { timedOut: false, value: winner };
	} finally {
		clearTimeout(timer);
	}
}
