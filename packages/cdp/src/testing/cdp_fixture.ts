/**
 * A real, local, CDP-shaped WebSocket server for testing `CdpClient` without a browser.
 *
 * This is a **fixture, not a mock** (D-TEST1, SPECS/OBSERVABILITY-TESTING-CICD.md §4.1.2): a real
 * `Deno.serve` listener on `127.0.0.1:0` speaking real CDP JSON over a real WebSocket. The scripted
 * LLM is the only sanctioned mock in this codebase; the CDP transport is never mocked.
 *
 * It is bound to `127.0.0.1` explicitly — `Deno.serve`'s default hostname is `0.0.0.0`, which the
 * test permission matrix (`--allow-net=127.0.0.1,localhost`, SPECS/SECURITY-AUTH.md §3.6) denies.
 *
 * Every instance MUST be closed; `await using` is the shortest way to keep the resource sanitizer
 * green.
 */

/** One request the fixture received from the client under test. */
export interface CdpFixtureRequest {
	id: number;
	method: string;
	params: Record<string, unknown> | undefined;
	sessionId: string | undefined;
	/** The exact text frame, for assertions about wire shape. */
	raw: string;
}

/** Script for one CDP method. Not calling `reply`/`replyError` leaves the request unanswered. */
export type CdpFixtureHandler = (request: CdpFixtureRequest, server: CdpFixtureServer) => void;

export interface CdpFixtureOptions {
	/** Reply `{}` to any request without a registered handler. Default `true`. */
	autoReply?: boolean;
	/** Path component of the URL, mimicking Chrome's `/devtools/browser/<uuid>`. */
	path?: string;
}

/** A local CDP endpoint. Start with {@linkcode CdpFixtureServer.start}. */
export class CdpFixtureServer implements AsyncDisposable {
	readonly #server: Deno.HttpServer<Deno.NetAddr>;
	readonly #abort: AbortController;
	readonly #handlers = new Map<string, CdpFixtureHandler>();
	readonly #requests: CdpFixtureRequest[] = [];
	readonly #requestWaiters = new Map<string, ((request: CdpFixtureRequest) => void)[]>();
	readonly #connected = Promise.withResolvers<void>();
	readonly #autoReply: boolean;
	readonly url: string;
	#socket: WebSocket | null = null;
	#closed = false;

	private constructor(server: Deno.HttpServer<Deno.NetAddr>, abort: AbortController, opts: CdpFixtureOptions) {
		this.#server = server;
		this.#abort = abort;
		this.#autoReply = opts.autoReply ?? true;
		const path = opts.path ?? '/devtools/browser/fixture';
		this.url = `ws://127.0.0.1:${server.addr.port}${path}`;
	}

	/** Bind an ephemeral port on 127.0.0.1 and start serving. */
	static start(opts: CdpFixtureOptions = {}): CdpFixtureServer {
		const abort = new AbortController();
		const ref: { fixture?: CdpFixtureServer } = {};
		const server = Deno.serve({
			hostname: '127.0.0.1',
			port: 0,
			signal: abort.signal,
			onListen: () => {},
			onError: () => new Response('fixture error', { status: 500 }),
		}, (request) => {
			if (request.headers.get('upgrade') !== 'websocket') {
				return new Response('expected a websocket upgrade', { status: 400 });
			}
			const { socket, response } = Deno.upgradeWebSocket(request);
			ref.fixture?.attach(socket);
			return response;
		});
		const fixture = new CdpFixtureServer(server, abort, opts);
		ref.fixture = fixture;
		return fixture;
	}

	/** Every request seen so far, in arrival order. */
	get requests(): readonly CdpFixtureRequest[] {
		return this.#requests;
	}

	/** Resolves once a client has completed the WebSocket handshake. */
	get connected(): Promise<void> {
		return this.#connected.promise;
	}

	/** Script a response for one CDP method. Replaces any previous script for that method. */
	on(method: string, handler: CdpFixtureHandler): this {
		this.#handlers.set(method, handler);
		return this;
	}

	/** Resolve when a request for `method` arrives (or immediately if one already did). */
	waitForRequest(method: string): Promise<CdpFixtureRequest> {
		const seen = this.#requests.find((request) => request.method === method);
		if (seen !== undefined) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<CdpFixtureRequest>();
		const waiters = this.#requestWaiters.get(method) ?? [];
		waiters.push(resolve);
		this.#requestWaiters.set(method, waiters);
		return promise;
	}

	/** Send a success response. */
	reply(id: number, result: unknown = {}, sessionId?: string): void {
		this.sendRaw(JSON.stringify({ id, result, ...(sessionId === undefined ? {} : { sessionId }) }));
	}

	/** Send a CDP `error` response. */
	replyError(id: number, error: { code: number; message: string; data?: unknown }, sessionId?: string): void {
		this.sendRaw(JSON.stringify({ id, error, ...(sessionId === undefined ? {} : { sessionId }) }));
	}

	/** Push an event frame. */
	emit(method: string, params: unknown = {}, sessionId?: string): void {
		this.sendRaw(JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
	}

	/** Write an arbitrary text frame — used for oversized and malformed-frame cases. */
	sendRaw(text: string): void {
		this.#openSocket().send(text);
	}

	/** Write a binary frame. Chrome speaks text, but proxies in front of it sometimes do not. */
	sendBinary(bytes: Uint8Array): void {
		this.#openSocket().send(bytes);
	}

	#openSocket(): WebSocket {
		if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) {
			throw new Error('cdp fixture: no open socket to write to');
		}
		return this.#socket;
	}

	/** Kill the connection without a clean client-side close — simulates a browser dying. */
	drop(code = 1006, reason = 'fixture dropped the connection'): void {
		// 1006 may not be sent on the wire; fall back to a normal close frame the client will see.
		this.#socket?.close(code === 1006 ? 1001 : code, reason);
	}

	/** Shut down the listener and any live socket. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#socket !== null && this.#socket.readyState === WebSocket.OPEN) {
			this.#socket.close(1001, 'fixture shutting down');
		}
		this.#socket = null;
		this.#abort.abort();
		await this.#server.finished;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	/** @internal wired from the `Deno.serve` handler. */
	private attach(socket: WebSocket): void {
		this.#socket = socket;
		socket.onopen = () => this.#connected.resolve();
		socket.onmessage = (event: MessageEvent) => {
			if (typeof event.data !== 'string') return;
			this.#onRequest(event.data);
		};
		socket.onclose = () => {
			this.#socket = null;
		};
		socket.onerror = () => {};
	}

	#onRequest(raw: string): void {
		let parsed: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof parsed.id !== 'number' || typeof parsed.method !== 'string') return;
		const request: CdpFixtureRequest = {
			id: parsed.id,
			method: parsed.method,
			params: parsed.params,
			sessionId: parsed.sessionId,
			raw,
		};
		this.#requests.push(request);
		for (const resolve of this.#requestWaiters.get(request.method) ?? []) resolve(request);
		this.#requestWaiters.delete(request.method);

		const handler = this.#handlers.get(request.method);
		if (handler !== undefined) {
			handler(request, this);
			return;
		}
		if (this.#autoReply) this.reply(request.id);
	}
}
