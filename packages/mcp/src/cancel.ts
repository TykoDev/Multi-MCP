/**
 * A10 (D-114): the one way a tool stops *waiting* on work it cannot interrupt — a DOM build or capture in the
 * vendored browser, a store read, a private service's reply.
 */

/**
 * Settles with `work`, or rejects with `signal`'s reason the moment it aborts, whichever comes first. The work is
 * not stopped here — where it can listen it is handed the same signal — but the caller is released at once. A
 * rejection of abandoned work is still handled, so nothing surfaces later as an unhandled rejection.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason);
		if (signal.aborted) {
			work.catch(() => {});
			return abort();
		}
		signal.addEventListener('abort', abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}
