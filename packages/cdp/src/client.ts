/**
 * `CdpClient` — id-correlated CDP request/response over a native `WebSocket`, plus the typed
 * `send.Domain.method(...)` surface and a multi-listener event registry.
 *
 * Contract: SPECS/ARCHITECTURE.md §7.1/§7.2/§8, SPECS/DECISION-REGISTER.md D-CDP1/D-CDP2/D-CFG1,
 * SPECS/COMPLETIONS-CRITERIA.md §3.1, SPECS/OBSERVABILITY-TESTING-CICD.md §1.4.
 *
 * Layering (ARCHITECTURE §3): this is leaf infrastructure. It imports no other `@bua/*` package and
 * knows nothing about session pooling, focus policy, or the event bus. Session/target state lives in
 * `@tykotech/browser`'s SessionManager (§7.3); reconnect *policy* lives there too (§7.4) — this file only
 * exposes the close signal that policy needs.
 */

import {
	CDP_DOMAIN_METHODS,
	CDP_DOMAINS,
	type CdpEventName,
	type CdpEventParams,
	type CdpSend,
	type CdpSendOptions,
	type SessionId,
} from './domains.ts';
import { CdpConnectionClosedError, CdpError, CdpProtocolError, CdpRequestTimeoutError, toCdpError } from './errors.ts';
import {
	type CdpCloseInfo,
	CdpTransport,
	type CdpWireFrame,
	DEFAULT_CONNECT_TIMEOUT_MS,
	MAX_INBOUND_FRAME_BYTES,
} from './transport.ts';

/** Per-request timeout default: 60 s (SPECS/ARCHITECTURE.md §8 timeout hierarchy). */
export const DEFAULT_CDP_REQUEST_TIMEOUT_MS = 60_000;

/** Primary env override for the per-request timeout, in **seconds** (D-CFG1). */
export const CDP_TIMEOUT_ENV = 'BUA_CDP_TIMEOUT_S';

/** Compat alias for {@linkcode CDP_TIMEOUT_ENV} (D-CFG1 `BROWSER_USE_*` aliases). */
export const CDP_TIMEOUT_ENV_COMPAT = 'BROWSER_USE_CDP_TIMEOUT_S';

/** Env switch for the wire log. Off by default (OBS §1.4). */
export const CDP_WIRE_LOG_ENV = 'BUA_CDP_WIRE_LOG';

/** Wire-log bodies are truncated at 4 KB with a `truncatedBytes` field (OBS §1.4). */
export const WIRE_LOG_BODY_LIMIT = 4096;

/** How long `close()` waits for the socket's close handshake before synthesizing the terminal state. */
export const CLOSE_GRACE_MS = 2_000;

export type { CdpCloseInfo } from './transport.ts';
// mod.ts re-exports `CdpSend` from this module (it is the client's own surface type, defined in
// domains.ts). Keep this line — `deno check packages/cdp/mod.ts` depends on it.
export type { CdpSend, CdpSendOptions } from './domains.ts';

/** `isCdpConnected ⇔ state === 'open'` (ARCHITECTURE §3). */
export type CdpConnectionState = 'open' | 'closed';

/** One CDP frame as recorded by the wire log. */
export interface CdpWireLogRecord {
	direction: 'send' | 'recv';
	/** Correlation id for commands and their responses; absent for events. */
	id?: number;
	method?: string;
	sessionId?: string;
	/** Round-trip time, present on the response record. */
	latencyMs?: number;
	/** JSON body, truncated to {@linkcode WIRE_LOG_BODY_LIMIT}. */
	body?: string;
	/** Characters dropped by truncation; absent when nothing was dropped. */
	truncatedBytes?: number;
	error?: { code: number; message: string };
}

/** Sink for {@linkcode CdpWireLogRecord}s. MUST write to stderr or a file, never a client stream. */
export type CdpWireLogSink = (record: CdpWireLogRecord) => void;

/** Options for {@linkcode CdpClient.connect}. */
export interface CdpClientOptions {
	/** Extra HTTP headers for the WebSocket upgrade (authenticated remote CDP hosts). */
	headers?: Record<string, string>;
	/**
	 * Default per-request timeout. Precedence: per-call `opts.requestTimeoutMs` → this → env
	 * (`BUA_CDP_TIMEOUT_S`, compat `BROWSER_USE_CDP_TIMEOUT_S`, seconds) → 60 s.
	 */
	requestTimeoutMs?: number;
	/** Cap on the WebSocket handshake. Defaults to 15 s (ARCHITECTURE §7.4). */
	connectTimeoutMs?: number;
	/** Inbound frame budget. Defaults to 200 MB. */
	maxFrameBytes?: number;
	/**
	 * Wire log (OBS §1.4). `undefined` consults `BUA_CDP_WIRE_LOG`; `true` uses the stderr sink; a
	 * function receives the records. The redaction filter (OBS §1.5) lives in `@tykotech/browser`, which
	 * this package may not import — install it by passing a wrapping sink.
	 */
	wireLog?: boolean | CdpWireLogSink;
	/** Aborting cancels an in-flight connect and closes an established connection. */
	signal?: AbortSignal;
	/** Called when an event listener throws. Defaults to a one-line `console.error`. */
	onListenerError?: (error: Error, method: string) => void;
	/**
	 * Called for inbound frames that could not be delivered: oversized (`CdpFrameTooLargeError`,
	 * when the correlation id could not be recovered) or undecodable. Defaults to a no-op.
	 */
	onFrameError?: (error: CdpError) => void;
}

/** Listener signature for {@linkcode CdpClient.on}. */
export type CdpEventListener<E extends CdpEventName> = (
	params: CdpEventParams[E],
	sessionId?: SessionId,
) => void;

interface PendingRequest {
	readonly method: string;
	readonly sessionId: string | undefined;
	readonly startedAt: number;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

/**
 * Read an env var without exploding when `--allow-env` does not cover it.
 *
 * D-CFG1 mandates getters rather than import-time snapshots, and `@tykotech/cdp` is a library: a caller
 * running under a tighter permission set must get the documented default, not a `NotCapable` crash.
 */
function readEnv(name: string): string | undefined {
	try {
		return Deno.env.get(name) ?? undefined;
	} catch (error) {
		if (error instanceof Deno.errors.NotCapable) return undefined;
		throw error;
	}
}

/**
 * Resolve the per-request timeout at call time.
 *
 * Precedence: explicit value → `BUA_CDP_TIMEOUT_S` → `BROWSER_USE_CDP_TIMEOUT_S` → 60 s. Env values
 * are **seconds**; a non-numeric or non-positive value is ignored rather than fatal, because a bad
 * env var must not be able to wedge the browser layer.
 */
export function resolveRequestTimeoutMs(explicitMs?: number): number {
	if (explicitMs !== undefined) {
		if (!Number.isFinite(explicitMs) || explicitMs <= 0) {
			throw new CdpError(`requestTimeoutMs must be a positive finite number, got ${explicitMs}`);
		}
		return explicitMs;
	}
	const fromEnv = readEnvSeconds(CDP_TIMEOUT_ENV) ?? readEnvSeconds(CDP_TIMEOUT_ENV_COMPAT);
	return fromEnv ?? DEFAULT_CDP_REQUEST_TIMEOUT_MS;
}

function readEnvSeconds(name: string): number | undefined {
	const raw = readEnv(name);
	if (raw === undefined || raw.trim() === '') return undefined;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.round(seconds * 1000);
}

/** Whether the wire log is enabled by env. Off unless explicitly `true`/`1` (OBS §1.4). */
export function isWireLogEnabledByEnv(): boolean {
	const raw = readEnv(CDP_WIRE_LOG_ENV)?.trim().toLowerCase();
	return raw === 'true' || raw === '1';
}

/** The default wire-log sink: one JSON line per frame on **stderr** (OBS §1.4). */
export function stderrWireLogSink(record: CdpWireLogRecord): void {
	console.error(`bua.cdp.wire ${JSON.stringify(record)}`);
}

function truncateBody(value: unknown): { body?: string; truncatedBytes?: number } {
	if (value === undefined) return {};
	let json: string;
	try {
		json = JSON.stringify(value) ?? 'undefined';
	} catch {
		return { body: '<unserializable>' };
	}
	if (json.length <= WIRE_LOG_BODY_LIMIT) return { body: json };
	return { body: json.slice(0, WIRE_LOG_BODY_LIMIT), truncatedBytes: json.length - WIRE_LOG_BODY_LIMIT };
}

/**
 * A connected CDP endpoint.
 *
 * Flat session mode throughout: browser-level calls omit `sessionId`, per-target calls pass it on
 * the same socket (ARCHITECTURE §7.1). Events carry `method` plus an optional `sessionId`, which is
 * handed through to listeners so a single global handler can route by target — the design
 * SessionManager is required to keep (D-CDP2).
 */
export class CdpClient {
	readonly #transport: CdpTransport;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #listeners = new Map<string, Set<(params: never, sessionId?: SessionId) => void>>();
	readonly #closeListeners = new Set<(info: CdpCloseInfo) => void>();
	readonly #lifetime = new AbortController();
	readonly #closedDeferred = Promise.withResolvers<CdpCloseInfo>();
	readonly #defaultTimeoutMs: number | undefined;
	readonly #wireLog: CdpWireLogSink | null;
	readonly #onListenerError: (error: Error, method: string) => void;
	readonly #frameErrorHandler: (error: CdpError) => void;
	#nextId = 0;
	#state: CdpConnectionState = 'open';
	#closeInfo: CdpCloseInfo | null = null;
	#intentionalClose = false;

	/** The typed command surface: `client.send.Page.navigate({url}, sessionId?)`. */
	readonly send: CdpSend;

	private constructor(transport: CdpTransport, opts: CdpClientOptions | undefined) {
		this.#transport = transport;
		this.#defaultTimeoutMs = opts?.requestTimeoutMs;
		this.#wireLog = resolveWireLogSink(opts?.wireLog);
		this.#onListenerError = opts?.onListenerError ?? defaultListenerErrorHandler;
		this.#frameErrorHandler = opts?.onFrameError ?? (() => {});
		this.send = this.#buildSendSurface();
	}

	/**
	 * Open a CDP connection.
	 *
	 * `cdpUrl` MUST be a `ws://`/`wss://` URL — resolve an http(s) DevTools endpoint with
	 * `fetchWebSocketDebuggerUrl()` first (ARCHITECTURE §7.4). On handshake timeout the socket is
	 * torn down before rejecting so a retry starts clean.
	 */
	static async connect(cdpUrl: string, opts?: CdpClientOptions): Promise<CdpClient> {
		// The transport starts delivering the instant the socket opens, which is one microtask before
		// the client exists. Queue anything that lands in that window instead of dropping it.
		const ref: { client?: CdpClient } = {};
		const queued: ((c: CdpClient) => void)[] = [];
		const dispatch = (fn: (c: CdpClient) => void): void => {
			const target = ref.client;
			if (target === undefined) queued.push(fn);
			else fn(target);
		};

		const transport = await CdpTransport.open(cdpUrl, {
			onFrame: (frame) => dispatch((c) => c.#onFrame(frame)),
			onFrameError: (error, idHint) => dispatch((c) => c.#handleFrameError(error, idHint)),
			onClose: (info) => dispatch((c) => c.#finalizeClose(info)),
		}, {
			...(opts?.headers === undefined ? {} : { headers: opts.headers }),
			maxFrameBytes: opts?.maxFrameBytes ?? MAX_INBOUND_FRAME_BYTES,
			connectTimeoutMs: opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
			...(opts?.signal === undefined ? {} : { signal: opts.signal }),
		});

		const client = new CdpClient(transport, opts);
		ref.client = client;
		for (const fn of queued) fn(client);
		return client;
	}

	/** The `ws(s)://` URL this client is attached to. */
	get url(): string {
		return this.#transport.url;
	}

	get state(): CdpConnectionState {
		return this.#state;
	}

	/**
	 * Resolves — never rejects — when the connection ends, with the reason.
	 *
	 * This plus {@linkcode CdpClient.onClose} is the drop-detection seam `@tykotech/browser` reconnect policy
	 * (ARCHITECTURE §7.4) consumes: reconnect iff `info.intentional === false`.
	 */
	get closed(): Promise<CdpCloseInfo> {
		return this.#closedDeferred.promise;
	}

	/** In-flight request count. Zero after `close()`; used by tests to prove nothing leaks. */
	get pendingRequestCount(): number {
		return this.#pending.size;
	}

	/**
	 * Subscribe to a CDP event. Returns an unsubscribe function.
	 *
	 * Multi-listener by design (`Map<method, Set<fn>>`) — the explicit D-CDP2 improvement over
	 * cdp-use's single slot, where a second registration silently clobbered the first. A listener
	 * that throws is reported via `onListenerError` and does not affect the read loop or its peers.
	 */
	on<E extends CdpEventName>(event: E, listener: CdpEventListener<E>): () => void {
		let set = this.#listeners.get(event);
		if (set === undefined) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		const erased = listener as (params: never, sessionId?: SessionId) => void;
		set.add(erased);
		return () => {
			const current = this.#listeners.get(event);
			if (current === undefined) return;
			current.delete(erased);
			if (current.size === 0) this.#listeners.delete(event);
		};
	}

	/** Number of listeners registered for an event. */
	listenerCount(event: string): number {
		return this.#listeners.get(event)?.size ?? 0;
	}

	/** Subscribe to connection close. Fires once; returns an unsubscribe function. */
	onClose(listener: (info: CdpCloseInfo) => void): () => void {
		if (this.#closeInfo !== null) {
			const info = this.#closeInfo;
			queueMicrotask(() => listener(info));
			return () => {};
		}
		this.#closeListeners.add(listener);
		return () => {
			this.#closeListeners.delete(listener);
		};
	}

	/**
	 * Escape hatch for methods outside the typed D-CDP2 surface (vendor `BrowserUse` commands, a
	 * domain not yet added). The caller owns the result type; prefer `send.*` wherever it exists.
	 */
	sendRaw<TResult = unknown>(
		method: string,
		params?: Record<string, unknown>,
		sessionId?: SessionId,
		opts?: CdpSendOptions,
	): Promise<TResult> {
		return this.#request(method, params, sessionId, opts) as Promise<TResult>;
	}

	/**
	 * Close the connection.
	 *
	 * Settles every pending request, clears every timer, closes the socket and leaves zero leaked
	 * ops. Idempotent; the resulting {@linkcode CdpCloseInfo} is marked `intentional`, which is what
	 * suppresses M1's auto-reconnect (ARCHITECTURE §7.4).
	 */
	async close(): Promise<void> {
		this.#intentionalClose = true;
		if (this.#closeInfo !== null) return;
		this.#state = 'closed';
		this.#transport.close(1000, 'client closed');
		await this.#waitForTransportClose();
		if (this.#closeInfo === null) {
			// The socket never reported a close handshake; synthesize the terminal state so no caller
			// is left waiting on a promise the runtime will never settle.
			this.#finalizeClose({ code: 1000, reason: 'client closed', wasClean: false, intentional: true });
		}
	}

	#buildSendSurface(): CdpSend {
		const surface: Record<string, Record<string, unknown>> = {};
		for (const domain of CDP_DOMAINS) {
			const methods: Record<string, unknown> = {};
			for (const method of CDP_DOMAIN_METHODS[domain] as readonly string[]) {
				const fullName = `${domain}.${method}`;
				methods[method] = (
					params?: Record<string, unknown>,
					sessionId?: SessionId,
					opts?: CdpSendOptions,
				) => this.#request(fullName, params, sessionId, opts);
			}
			surface[domain] = methods;
		}
		return surface as unknown as CdpSend;
	}

	#request(
		method: string,
		params: Record<string, unknown> | undefined,
		sessionId: SessionId | undefined,
		opts: CdpSendOptions | undefined,
	): Promise<unknown> {
		if (this.#state === 'closed') {
			return Promise.reject(
				new CdpConnectionClosedError({
					intentional: this.#intentionalClose,
					method,
					...(this.#closeInfo === null ? {} : { code: this.#closeInfo.code, reason: this.#closeInfo.reason }),
				}),
			);
		}

		const id = ++this.#nextId;
		const timeoutMs = resolveRequestTimeoutMs(opts?.requestTimeoutMs ?? this.#defaultTimeoutMs);
		const frame: Record<string, unknown> = { id, method };
		if (params !== undefined) frame.params = params;
		if (sessionId !== undefined) frame.sessionId = sessionId;
		const text = JSON.stringify(frame);

		return new Promise<unknown>((resolve, reject) => {
			// A cancellable timeout composed with the socket lifetime and the caller's signal, per
			// ARCHITECTURE §8. `AbortSignal.timeout` is not used directly because it cannot be
			// cancelled, and an uncancelled 60 s timer is exactly what the op sanitizer flags.
			const timeoutController = new AbortController();
			const timer = setTimeout(() => {
				timeoutController.abort(
					new CdpRequestTimeoutError({
						method,
						timeoutMs,
						requestId: id,
						...(sessionId === undefined ? {} : { sessionId }),
					}),
				);
			}, timeoutMs);

			const signals: AbortSignal[] = [timeoutController.signal, this.#lifetime.signal];
			if (opts?.signal !== undefined) signals.push(opts.signal);
			const composite = AbortSignal.any(signals);

			let settled = false;
			const finish = (run: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				composite.removeEventListener('abort', onAbort);
				this.#pending.delete(id);
				run();
			};
			const onAbort = () => {
				finish(() => reject(toCdpError(composite.reason, `${method} aborted`)));
			};

			if (composite.aborted) {
				onAbort();
				return;
			}
			composite.addEventListener('abort', onAbort, { once: true });

			this.#pending.set(id, {
				method,
				sessionId,
				startedAt: performance.now(),
				resolve: (value) => finish(() => resolve(value)),
				reject: (error) => finish(() => reject(error)),
			});

			this.#logWire({
				direction: 'send',
				id,
				method,
				...(sessionId === undefined ? {} : { sessionId }),
				...truncateBody(params),
			});

			try {
				this.#transport.send(text);
			} catch (error) {
				finish(() => reject(toCdpError(error, `failed to send ${method}`)));
			}
		});
	}

	#onFrame(frame: CdpWireFrame): void {
		if (typeof frame.id === 'number') {
			this.#onResponse(frame, frame.id);
			return;
		}
		if (typeof frame.method === 'string') {
			this.#logWire({
				direction: 'recv',
				method: frame.method,
				...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
				...truncateBody(frame.params),
			});
			this.#emit(frame.method, frame.params, frame.sessionId);
			return;
		}
		this.#frameErrorHandler(new CdpError('inbound CDP frame had neither an id nor a method'));
	}

	#onResponse(frame: CdpWireFrame, id: number): void {
		const pending = this.#pending.get(id);
		const latencyMs = pending === undefined ? undefined : Math.round(performance.now() - pending.startedAt);
		this.#logWire({
			direction: 'recv',
			id,
			...(pending?.method === undefined ? {} : { method: pending.method }),
			...(pending?.sessionId === undefined ? {} : { sessionId: pending.sessionId }),
			...(latencyMs === undefined ? {} : { latencyMs }),
			...(frame.error === undefined
				? truncateBody(frame.result)
				: { error: { code: frame.error.code ?? 0, message: frame.error.message ?? '' } }),
		});
		// An id with no pending entry is a response that arrived after its request timed out or was
		// cancelled. Dropping it is correct; it is recorded on the wire log above.
		if (pending === undefined) return;

		if (frame.error !== undefined) {
			pending.reject(
				new CdpProtocolError({
					code: frame.error.code ?? 0,
					message: frame.error.message ?? 'unknown CDP error',
					method: pending.method,
					requestId: id,
					...(pending.sessionId === undefined ? {} : { sessionId: pending.sessionId }),
					...(frame.error.data === undefined ? {} : { data: String(frame.error.data) }),
				}),
			);
			return;
		}
		pending.resolve(frame.result ?? {});
	}

	/**
	 * An inbound frame was dropped.
	 *
	 * ERRATUM(M0-cdp-transport-4): ARCHITECTURE §7.1 states the 200 MB budget but not the failure
	 * mode. Resolution implemented below; see errata-M0.md.
	 *
	 * When the correlation id survived in the frame prefix, the matching request is failed
	 * immediately — better than making the caller wait out the full 60 s for a response we already
	 * know we threw away. Otherwise (an oversized *event*, or an undecodable frame) the error goes to
	 * `onFrameError`. Either way the socket stays open: one bad frame is not proof the browser died,
	 * and tearing down here would fight the reconnect policy in ARCHITECTURE §7.4.
	 */
	#handleFrameError(error: CdpError, idHint: number | null): void {
		if (idHint !== null) {
			const pending = this.#pending.get(idHint);
			if (pending !== undefined) {
				pending.reject(error);
				return;
			}
		}
		this.#frameErrorHandler(error);
	}

	#emit(method: string, params: unknown, sessionId: string | undefined): void {
		const set = this.#listeners.get(method);
		if (set === undefined || set.size === 0) return;
		// Snapshot: a listener may unsubscribe itself (or a peer) during dispatch.
		for (const listener of [...set]) {
			try {
				(listener as (params: unknown, sessionId?: SessionId) => void)(params, sessionId);
			} catch (error) {
				this.#onListenerError(toCdpError(error, `CDP event listener for ${method} threw`), method);
			}
		}
	}

	#logWire(record: CdpWireLogRecord): void {
		if (this.#wireLog === null) return;
		try {
			this.#wireLog(record);
		} catch {
			// A broken log sink must never break the transport.
		}
	}

	#waitForTransportClose(): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => resolve(), CLOSE_GRACE_MS);
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			this.#transport.closed.then(done, done);
		});
	}

	#finalizeClose(info: CdpCloseInfo): void {
		if (this.#closeInfo !== null) return;
		const resolved: CdpCloseInfo = { ...info, intentional: info.intentional || this.#intentionalClose };
		this.#closeInfo = resolved;
		this.#state = 'closed';

		// Every pending request settles, so a dead browser can never leave a caller hanging.
		const abandoned = [...this.#pending.values()];
		this.#pending.clear();
		for (const pending of abandoned) {
			pending.reject(
				new CdpConnectionClosedError({
					code: resolved.code,
					reason: resolved.reason,
					intentional: resolved.intentional,
					method: pending.method,
				}),
			);
		}
		this.#lifetime.abort(
			new CdpConnectionClosedError({
				code: resolved.code,
				reason: resolved.reason,
				intentional: resolved.intentional,
			}),
		);

		this.#closedDeferred.resolve(resolved);
		for (const listener of [...this.#closeListeners]) {
			try {
				listener(resolved);
			} catch (error) {
				this.#onListenerError(toCdpError(error, 'CDP close listener threw'), '<close>');
			}
		}
		this.#closeListeners.clear();
		this.#listeners.clear();
	}
}

function resolveWireLogSink(setting: boolean | CdpWireLogSink | undefined): CdpWireLogSink | null {
	if (typeof setting === 'function') return setting;
	if (setting === true) return stderrWireLogSink;
	if (setting === false) return null;
	return isWireLogEnabledByEnv() ? stderrWireLogSink : null;
}

function defaultListenerErrorHandler(error: Error, method: string): void {
	console.error(`bua.cdp listener for ${method} threw: ${error.message}`);
}

/** Re-exported so the frame budget is readable from the client module too. */
export { MAX_INBOUND_FRAME_BYTES };
