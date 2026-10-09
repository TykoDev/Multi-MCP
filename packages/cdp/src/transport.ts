/**
 * Raw CDP WebSocket transport.
 *
 * Contract: SPECS/ARCHITECTURE.md §7.1, SPECS/DECISION-REGISTER.md D-CDP1 / REJ-4.
 * Native `WebSocket` only — no puppeteer, no playwright, no `ws`. This file owns socket lifecycle,
 * frame decoding, and the inbound frame budget. It knows nothing about ids, domains, or sessions;
 * that is `client.ts`.
 */

import { CdpError, CdpFrameTooLargeError, toCdpError } from './errors.ts';

/** Inbound frame budget: 200 MB (SPECS/ARCHITECTURE.md §7.1, COMPLETIONS-CRITERIA.md §3.1). */
export const MAX_INBOUND_FRAME_BYTES = 200 * 1024 * 1024;

/** WebSocket-open budget, a sub-budget of the 15 s `connect()` cap in ARCHITECTURE §7.4. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** How many leading characters of an oversized frame are scanned for its correlation id. */
const ID_HINT_PREFIX_CHARS = 512;

/** A decoded CDP wire frame: either a command response (`id`) or an event (`method`). */
export interface CdpWireFrame {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
	sessionId?: string;
}

/** Why and how the socket ended. Consumed by `@tykotech/browser`'s reconnect policy (ARCHITECTURE §7.4). */
export interface CdpCloseInfo {
	code: number;
	reason: string;
	wasClean: boolean;
	/** `true` iff the local side asked for the close via {@linkcode CdpTransport.close}. */
	intentional: boolean;
}

/** Callbacks the owning client installs. All are invoked synchronously from the socket handlers. */
export interface CdpTransportHandlers {
	/** A well-formed frame arrived. */
	onFrame(frame: CdpWireFrame): void;
	/**
	 * A frame could not be delivered: oversized (`CdpFrameTooLargeError`) or undecodable
	 * (`CdpError`). `idHint` carries the correlation id when it could be recovered cheaply.
	 */
	onFrameError(error: CdpError, idHint: number | null): void;
	/** Fired exactly once, whatever the cause. */
	onClose(info: CdpCloseInfo): void;
}

/** Options for {@linkcode CdpTransport.open}. */
export interface CdpTransportOptions {
	/**
	 * Extra HTTP headers for the WebSocket upgrade. Deno's `WebSocket` supports this as a
	 * non-standard second-argument field; browsers do not. Used for authenticated remote CDP hosts.
	 */
	headers?: Record<string, string>;
	/** Inbound frame budget. Defaults to {@linkcode MAX_INBOUND_FRAME_BYTES}. */
	maxFrameBytes?: number;
	/** Cap on the WebSocket open handshake. Defaults to {@linkcode DEFAULT_CONNECT_TIMEOUT_MS}. */
	connectTimeoutMs?: number;
	/** Aborting this cancels an in-flight open and closes an established socket. */
	signal?: AbortSignal;
}

/**
 * Measure an inbound frame against the byte budget.
 *
 * ERRATUM(M0-cdp-transport-3): the specs say "200MB" without saying what is measured; see
 * errata-M0.md for the reasoning behind the choice below.
 *
 * Binary frames are measured exactly. Text frames are measured in UTF-16 code units, which is a
 * *lower* bound on their UTF-8 byte length — exact counting would need a full `TextEncoder` pass,
 * i.e. a second allocation the size of the frame we are trying not to allocate. CDP frames are
 * JSON with base64 bodies, so in practice the two counts coincide. See README "Frame budget".
 */
export function measureFrameBytes(data: string | ArrayBufferLike | ArrayBufferView): number {
	if (typeof data === 'string') return data.length;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	return data.byteLength;
}

/**
 * Recover the `id` of a frame from its prefix without parsing the whole thing.
 *
 * Used only on the oversized-frame path, so a dropped *response* still settles its request
 * deterministically instead of waiting out the 60 s timeout.
 */
export function extractFrameId(framePrefix: string): number | null {
	const match = /"id"\s*:\s*(\d+)/.exec(framePrefix.slice(0, ID_HINT_PREFIX_CHARS));
	if (match?.[1] === undefined) return null;
	const id = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(id) ? id : null;
}

/** A live CDP WebSocket. Constructed via {@linkcode CdpTransport.open}. */
export class CdpTransport {
	readonly #socket: WebSocket;
	readonly #handlers: CdpTransportHandlers;
	readonly #maxFrameBytes: number;
	readonly #url: string;
	readonly #closed: Promise<CdpCloseInfo>;
	readonly #decoder = new TextDecoder();
	#resolveClosed!: (info: CdpCloseInfo) => void;
	#state: 'open' | 'closed' = 'open';
	#intentional = false;
	#socketError: Error | null = null;

	private constructor(socket: WebSocket, handlers: CdpTransportHandlers, maxFrameBytes: number) {
		this.#socket = socket;
		this.#handlers = handlers;
		this.#maxFrameBytes = maxFrameBytes;
		this.#url = socket.url;
		this.#closed = new Promise<CdpCloseInfo>((resolve) => {
			this.#resolveClosed = resolve;
		});
		socket.binaryType = 'arraybuffer';
		socket.onmessage = (event: MessageEvent) => this.#onMessage(event.data);
		socket.onerror = () => {
			this.#socketError = new CdpError('CDP WebSocket error');
		};
		socket.onclose = (event: CloseEvent) => this.#onClose(event.code, event.reason, event.wasClean);
	}

	/** Open a CDP WebSocket, resolving once the handshake completes. */
	static open(url: string, handlers: CdpTransportHandlers, opts?: CdpTransportOptions): Promise<CdpTransport> {
		const connectTimeoutMs = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const maxFrameBytes = opts?.maxFrameBytes ?? MAX_INBOUND_FRAME_BYTES;

		return new Promise<CdpTransport>((resolve, reject) => {
			// Inside the executor so a bad URL *rejects* rather than throwing synchronously — the
			// caller signature promises a Promise, and a mixed contract is a trap.
			const parsed = parseCdpWebSocketUrl(url);
			const socket = opts?.headers === undefined
				? new WebSocket(parsed)
				: new WebSocket(parsed, { headers: opts.headers });

			let settled = false;
			const timer = setTimeout(() => {
				fail(new CdpError(`CDP WebSocket handshake to ${parsed} timed out after ${connectTimeoutMs}ms`));
			}, connectTimeoutMs);

			const cleanup = () => {
				clearTimeout(timer);
				opts?.signal?.removeEventListener('abort', onAbort);
				socket.onopen = null;
				socket.onerror = null;
				socket.onclose = null;
			};

			// Teardown-on-timeout keeps a retry starting from a clean slate (ARCHITECTURE §7.4).
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				try {
					socket.close();
				} catch {
					// Socket was never established; nothing to tear down.
				}
				reject(error);
			};

			const onAbort = () => fail(toCdpError(opts?.signal?.reason, 'CDP connect aborted'));

			if (opts?.signal?.aborted) {
				onAbort();
				return;
			}
			opts?.signal?.addEventListener('abort', onAbort, { once: true });

			socket.onopen = () => {
				if (settled) return;
				settled = true;
				cleanup();
				const transport = new CdpTransport(socket, handlers, maxFrameBytes);
				if (opts?.signal !== undefined) {
					opts.signal.addEventListener('abort', () => transport.close(1000, 'aborted'), { once: true });
				}
				resolve(transport);
			};
			socket.onerror = () => fail(new CdpError(`failed to open CDP WebSocket to ${parsed}`));
			socket.onclose = (event: CloseEvent) =>
				fail(new CdpError(`CDP WebSocket closed during handshake (code ${event.code}: ${event.reason})`));
		});
	}

	get url(): string {
		return this.#url;
	}

	get state(): 'open' | 'closed' {
		return this.#state;
	}

	/** Resolves — never rejects — when the socket ends. */
	get closed(): Promise<CdpCloseInfo> {
		return this.#closed;
	}

	/** Write one already-serialized JSON frame. Throws {@linkcode CdpError} if the socket is gone. */
	send(text: string): void {
		if (this.#state === 'closed' || this.#socket.readyState !== WebSocket.OPEN) {
			throw new CdpError('cannot send on a closed CDP WebSocket');
		}
		this.#socket.send(text);
	}

	/** Request a clean close. Idempotent; marks the resulting {@linkcode CdpCloseInfo} intentional. */
	close(code = 1000, reason = 'client closed'): void {
		this.#intentional = true;
		if (this.#state === 'closed') return;
		const readyState = this.#socket.readyState;
		if (readyState === WebSocket.CLOSED) {
			this.#onClose(code, reason, true);
			return;
		}
		if (readyState === WebSocket.CLOSING) return;
		try {
			this.#socket.close(code, reason);
		} catch (error) {
			// A socket that refuses close() is already unusable; synthesize the terminal state.
			this.#socketError = toCdpError(error, 'CDP WebSocket close failed');
			this.#onClose(code, reason, false);
		}
	}

	#onMessage(data: unknown): void {
		let text: string;
		if (typeof data === 'string') {
			if (!this.#withinBudget(data)) return;
			text = data;
		} else if (data instanceof ArrayBuffer) {
			if (!this.#withinBudget(data)) return;
			text = this.#decoder.decode(data);
		} else {
			this.#handlers.onFrameError(new CdpError('unsupported CDP frame type on the wire'), null);
			return;
		}

		let frame: CdpWireFrame;
		try {
			frame = JSON.parse(text) as CdpWireFrame;
		} catch (error) {
			this.#handlers.onFrameError(
				new CdpError('failed to parse inbound CDP frame as JSON', { cause: error }),
				extractFrameId(text),
			);
			return;
		}
		if (frame === null || typeof frame !== 'object') {
			this.#handlers.onFrameError(new CdpError('inbound CDP frame was not a JSON object'), null);
			return;
		}
		this.#handlers.onFrame(frame);
	}

	/** Returns `false` (and reports) when the frame blew the budget. */
	#withinBudget(data: string | ArrayBuffer): boolean {
		const byteLength = measureFrameBytes(data);
		if (byteLength <= this.#maxFrameBytes) return true;
		const prefix = typeof data === 'string'
			? data.slice(0, ID_HINT_PREFIX_CHARS)
			: this.#decoder.decode(data.slice(0, ID_HINT_PREFIX_CHARS));
		const idHint = extractFrameId(prefix);
		this.#handlers.onFrameError(
			new CdpFrameTooLargeError({
				byteLength,
				limitBytes: this.#maxFrameBytes,
				...(idHint === null ? {} : { requestId: idHint }),
			}),
			idHint,
		);
		return false;
	}

	#onClose(code: number, reason: string, wasClean: boolean): void {
		if (this.#state === 'closed') return;
		this.#state = 'closed';
		this.#socket.onmessage = null;
		this.#socket.onerror = null;
		this.#socket.onclose = null;
		const info: CdpCloseInfo = {
			code,
			reason: reason || (this.#socketError?.message ?? ''),
			wasClean,
			intentional: this.#intentional,
		};
		this.#resolveClosed(info);
		this.#handlers.onClose(info);
	}
}

/**
 * Validate a CDP WebSocket URL.
 *
 * An http(s) URL is a caller mistake with an exact remedy: `fetchWebSocketDebuggerUrl()` performs
 * the `/json/version` handshake (ARCHITECTURE §7.4) and hands back the `ws://` URL this wants.
 */
export function parseCdpWebSocketUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		throw new CdpError(`invalid CDP URL: ${url}`, { cause: error });
	}
	if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return parsed.href;
	if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
		throw new CdpError(
			`CdpClient.connect() needs a ws:// or wss:// URL, got ${url}. ` +
				'Resolve it first with fetchWebSocketDebuggerUrl().',
		);
	}
	throw new CdpError(`unsupported CDP URL scheme ${parsed.protocol} in ${url}`);
}
