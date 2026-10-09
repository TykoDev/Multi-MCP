/**
 * Typed error taxonomy for `@tykotech/cdp`.
 *
 * Contract: AGENTS.md §3 ("Never throw strings"), SPECS/ARCHITECTURE.md §7.1,
 * SPECS/COMPLETIONS-CRITERIA.md §3.1 (`CdpRequestTimeoutError`, never a hang).
 *
 * Every error thrown by this package descends from {@linkcode CdpError}, so a consumer can bracket
 * the whole transport with a single `instanceof` check and still discriminate on the subclass.
 */

/** Base class for every error raised by `@tykotech/cdp`. */
export class CdpError extends Error {
	override readonly name: string = 'CdpError';

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/** Init bag for {@linkcode CdpProtocolError}. */
export interface CdpProtocolErrorInit {
	/** CDP error code, e.g. `-32000` (server error) or `-32601` (method not found). */
	code: number;
	/** CDP-supplied message, verbatim. */
	message: string;
	/** The method whose response carried the error. */
	method: string;
	/** Optional CDP `error.data` blob, stringified by the caller when present. */
	data?: string;
	/** Flat-session id the request was addressed to, when any. */
	sessionId?: string;
	/** Client-assigned request id that correlated this error. */
	requestId?: number;
}

/**
 * The browser answered a request with a CDP `error` payload.
 *
 * This is the browser saying "no" — it is *not* a transport fault, so `@tykotech/browser`'s reconnect
 * policy (SPECS/ARCHITECTURE.md §7.4) MUST NOT treat it as a socket drop.
 */
export class CdpProtocolError extends CdpError {
	override readonly name: string = 'CdpProtocolError';
	readonly code: number;
	readonly method: string;
	readonly data: string | undefined;
	readonly sessionId: string | undefined;
	readonly requestId: number | undefined;

	constructor(init: CdpProtocolErrorInit) {
		super(
			`${init.method} failed: CDP error ${init.code}: ${init.message}` +
				(init.data === undefined ? '' : ` (${init.data})`),
		);
		this.code = init.code;
		this.method = init.method;
		this.data = init.data;
		this.sessionId = init.sessionId;
		this.requestId = init.requestId;
	}
}

/** Init bag for {@linkcode CdpRequestTimeoutError}. */
export interface CdpRequestTimeoutErrorInit {
	method: string;
	timeoutMs: number;
	sessionId?: string;
	requestId?: number;
}

/**
 * A request outlived its per-request budget (default 60 s — SPECS/ARCHITECTURE.md §8).
 *
 * The socket is deliberately left open: a single unanswered command does not prove the browser is
 * dead, and tearing the connection down here would fight `@tykotech/browser`'s reconnect policy.
 */
export class CdpRequestTimeoutError extends CdpError {
	override readonly name: string = 'CdpRequestTimeoutError';
	readonly method: string;
	readonly timeoutMs: number;
	readonly sessionId: string | undefined;
	readonly requestId: number | undefined;

	constructor(init: CdpRequestTimeoutErrorInit) {
		super(`${init.method} timed out after ${init.timeoutMs}ms`);
		this.method = init.method;
		this.timeoutMs = init.timeoutMs;
		this.sessionId = init.sessionId;
		this.requestId = init.requestId;
	}
}

/** Init bag for {@linkcode CdpFrameTooLargeError}. */
export interface CdpFrameTooLargeErrorInit {
	/** Measured size of the offending inbound frame. See `measureFrameBytes` in `transport.ts`. */
	byteLength: number;
	/** The budget that was exceeded (default 200 MB). */
	limitBytes: number;
	/** Request id recovered from the frame prefix, when the frame was a response. */
	requestId?: number;
}

/**
 * An inbound frame exceeded the 200 MB budget and was dropped before `JSON.parse` ran.
 *
 * Screenshots and `DOMSnapshot.captureSnapshot` payloads are the realistic offenders
 * (SPECS/ARCHITECTURE.md §7.1).
 */
export class CdpFrameTooLargeError extends CdpError {
	override readonly name: string = 'CdpFrameTooLargeError';
	readonly byteLength: number;
	readonly limitBytes: number;
	readonly requestId: number | undefined;

	constructor(init: CdpFrameTooLargeErrorInit) {
		super(`inbound CDP frame of ${init.byteLength} bytes exceeds the ${init.limitBytes} byte budget`);
		this.byteLength = init.byteLength;
		this.limitBytes = init.limitBytes;
		this.requestId = init.requestId;
	}
}

/** Init bag for {@linkcode CdpConnectionClosedError}. */
export interface CdpConnectionClosedErrorInit {
	/** WebSocket close code, when the socket reached a close handshake. */
	code?: number;
	/** WebSocket close reason. */
	reason?: string;
	/** `true` when `CdpClient.close()` caused it; `false` for a drop. */
	intentional: boolean;
	/** The in-flight method that was abandoned, when this settles a pending request. */
	method?: string;
	requestId?: number;
	cause?: unknown;
}

/**
 * The socket closed (or was already closed) while a request was outstanding.
 *
 * `intentional` is the discriminator M1's reconnect policy needs: SPECS/ARCHITECTURE.md §7.4 only
 * auto-reconnects when the stop was *not* intentional.
 */
export class CdpConnectionClosedError extends CdpError {
	override readonly name: string = 'CdpConnectionClosedError';
	readonly code: number | undefined;
	readonly reason: string | undefined;
	readonly intentional: boolean;
	readonly method: string | undefined;
	readonly requestId: number | undefined;

	constructor(init: CdpConnectionClosedErrorInit) {
		super(
			`CDP connection closed${init.intentional ? '' : ' unexpectedly'}` +
				(init.method === undefined ? '' : ` while awaiting ${init.method}`) +
				(init.code === undefined ? '' : ` (code ${init.code}${init.reason ? `: ${init.reason}` : ''})`),
			{ cause: init.cause },
		);
		this.code = init.code;
		this.reason = init.reason;
		this.intentional = init.intentional;
		this.method = init.method;
		this.requestId = init.requestId;
	}
}

/**
 * Coerce an unknown thrown/abort value into an `Error`, so nothing ever escapes as a bare string
 * (AGENTS.md §3).
 */
export function toCdpError(value: unknown, fallbackMessage: string): Error {
	if (value instanceof Error) return value;
	if (typeof value === 'string') return new CdpError(`${fallbackMessage}: ${value}`);
	return new CdpError(fallbackMessage, { cause: value });
}
