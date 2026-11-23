/**
 * @module
 * The browser-tier harness: a real gateway, a real Chromium, the SDK's MCP client over Streamable HTTP, and a real
 * live-view WebSocket. Launching Chromium costs seconds, so suites open one harness per `Deno.test` and use `t.step`.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
	type ClientMsg,
	createLogger,
	decodeFrame,
	type FrameMeta,
	generateApiKey,
	loadConfig,
	type RunningGateway,
	type Scope,
	type ServerMsg,
	startGateway,
} from '@tykotech/gateway';
import { CHROMIUM_ENV, readEnv, skipBrowserTier } from './browser_tier.ts';
import { type FixtureSite, type FixtureSiteOptions, startFixtureSite } from '../fixtures/site.ts';

/** The Chromium the `test:browser` task pinned, or `null` on a host without one. */
export const CHROMIUM: string | null = readEnv(CHROMIUM_ENV) ?? readEnv('TTK_BROWSER_PATH') ?? null;

/** `ignore:` value for a browser-tier suite; announces the reason once. */
export function skipUnlessBrowser(suite: string): boolean {
	return skipBrowserTier(suite, CHROMIUM);
}

/** A client-side sampling responder: the host LLM's stand-in, or a real one. */
export type SamplingResponder = (request: {
	params: { messages: Array<{ role: string; content: unknown }>; systemPrompt?: string; maxTokens?: number };
}) => Promise<{ model: string; role: 'assistant'; content: { type: 'text'; text: string } }>;

export interface HarnessOptions {
	/** Scopes on the harness credential. Defaults to every scope. */
	readonly scopes?: readonly Scope[];
	/** `ApiKeyRecord.label` on the harness credential (the live view's `holder_name`). */
	readonly label?: string;
	/** Extra/overriding `TTK_*` configuration. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Resolved secret-file contents by variable, as the CLI hands them to `loadConfig`. */
	readonly secrets?: Readonly<Record<string, string>>;
	/** Registers a `sampling/createMessage` handler on the client. */
	readonly sampling?: SamplingResponder;
	readonly site?: FixtureSiteOptions;
	/** Caps automatic input_required fulfilment rounds on the client. */
	readonly maxRounds?: number;
}

export interface Harness extends AsyncDisposable {
	readonly gateway: RunningGateway;
	readonly client: Client;
	/** The run's bearer credential. */
	readonly key: string;
	readonly site: FixtureSite;
	/** Gateway origin, e.g. `http://127.0.0.1:54321`. */
	readonly url: string;
	call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
	/** Calls a tool, asserting success, and returns its concatenated text. */
	callText(name: string, args?: Record<string, unknown>): Promise<string>;
	/** Calls a tool, asserting success, and parses its JSON text payload. */
	callJson<T>(name: string, args?: Record<string, unknown>): Promise<T>;
	/** Calls a tool expecting failure; returns the `Error: <code>: …` text. */
	callError(name: string, args?: Record<string, unknown>): Promise<string>;
	/** Calls a tool, asserting success, and returns its structured content (fields beyond the frozen text block). */
	callStructured<T>(name: string, args?: Record<string, unknown>): Promise<T>;
	/** Evaluates an expression in a session's focused page over CDP: what the page believes, no tool in between. */
	pageValue<T>(expression: string, sessionId?: string): Promise<T>;
	/** Mints a live-view ticket over HTTP. */
	ticket(sessionId?: string, key?: string): Promise<string>;
	/** Opens a live-view socket and waits for its `meta` message. */
	live(sessionId?: string, key?: string): Promise<LiveSocket>;
	/** Authenticated `fetch` against the gateway. */
	fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** All content text blocks of a result, joined. */
export function textOf(result: { content?: unknown }): string {
	const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
	return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

/** The first image block of a result, decoded. */
/** Polls `probe` until it answers something other than `undefined`. */
export async function poll<T>(
	what: string,
	probe: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

/** The CDP surface of a registry record that tests reach (test plumbing; not product API). */
export interface RecordCdp {
	session: {
		cdpClient: {
			send: {
				Runtime: {
					evaluate(params: unknown, sessionId: string): Promise<{ result: { value?: unknown } }>;
				};
			};
			sendRaw(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
		};
		sessionManager: { getOrCreateCdpSession(target: unknown, focus: boolean): Promise<{ sessionId: string }> };
		agentFocusTargetId: string | null;
	};
}

/** The CDP client of a session and the session id of its focused page. */
export async function pageCdp(
	gateway: RunningGateway,
	sessionId = 'default',
): Promise<{ cdp: RecordCdp['session']['cdpClient']; page: string }> {
	const record = gateway.registry.peek(sessionId) as unknown as RecordCdp | undefined;
	if (record === undefined) throw new Error(`no session ${sessionId}`);
	const page = await record.session.sessionManager.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
	return { cdp: record.session.cdpClient, page: page.sessionId };
}

export function imageOf(result: { content?: unknown }): { bytes: Uint8Array; mimeType: string } | null {
	const blocks = (result.content ?? []) as Array<{ type: string; data?: string; mimeType?: string }>;
	const image = blocks.find((b) => b.type === 'image');
	if (image === undefined) return null;
	return { bytes: Uint8Array.from(atob(image.data ?? ''), (c) => c.charCodeAt(0)), mimeType: image.mimeType ?? '' };
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
	// `task` is named: it is not in DEFAULT_SCOPES, and the tier must exercise `browser_run_task`.
	const scopes = options.scopes ?? (['mcp:invoke', 'view:watch', 'view:control', 'task', 'admin'] as const);
	const { key, record: minted } = await generateApiKey('e2e', scopes);
	const record = options.label === undefined ? minted : { ...minted, label: options.label };
	const site = startFixtureSite(options.site ?? {});
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([record]),
		TTK_LOG_LEVEL: 'error',
		TTK_BROWSER_PATH: CHROMIUM ?? '',
		TTK_HEADLESS: 'true',
		// The suites poll hard; rate limiting has its own tests.
		TTK_RATE_RPM: '100000',
		// The suites address the `default` session by name; ownership has its own suite.
		TTK_SESSION_OWNERSHIP: 'shared',
		...options.env,
	}, options.secrets === undefined ? {} : { secrets: options.secrets });
	const gateway = await startGateway({
		config,
		version: '0.1.0-e2e',
		logger: createLogger({ level: 'error', write: () => {} }),
	});
	const opened: Array<{ close(): Promise<void> | void }> = [];

	const client = new Client(
		{ name: 'ttk-e2e', version: '0' },
		{
			versionNegotiation: { mode: 'auto' },
			...(options.sampling === undefined ? {} : { capabilities: { sampling: {} } }),
			...(options.maxRounds === undefined ? {} : { inputRequired: { maxRounds: options.maxRounds } }),
		},
	);
	if (options.sampling !== undefined) {
		const responder = options.sampling;
		// deno-lint-ignore no-explicit-any
		client.setRequestHandler('sampling/createMessage', async (request: any) => await responder(request));
	}
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${key}`);
				return fetch(input, { ...init, headers });
			},
		}),
	);
	opened.push({ close: () => client.close().catch(() => {}) });

	const authFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(init.headers);
		if (!headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
		return fetch(`${gateway.url}${path}`, { ...init, headers });
	};
	const call = (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
	const succeeded = async (name: string, args?: Record<string, unknown>): Promise<string> => {
		const result = await call(name, args);
		if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
		return textOf(result);
	};
	const ticket = async (sessionId = 'default', bearer = key): Promise<string> => {
		const response = await authFetch('/api/v1/live/ticket', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
			body: JSON.stringify({ session_id: sessionId }),
		});
		const body = await response.json();
		if (response.status !== 201) throw new Error(`ticket mint failed (${response.status}): ${JSON.stringify(body)}`);
		return body.ticket as string;
	};

	return {
		gateway,
		client,
		key,
		site,
		url: gateway.url,
		call,
		fetch: authFetch,
		ticket,
		callText: succeeded,
		callJson: async <T>(name: string, args?: Record<string, unknown>) => JSON.parse(await succeeded(name, args)) as T,
		async callStructured<T>(name: string, args?: Record<string, unknown>) {
			const result = await call(name, args);
			if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
			return result.structuredContent as T;
		},
		async pageValue<T>(expression: string, sessionId = 'default') {
			const { cdp, page } = await pageCdp(gateway, sessionId);
			const out = await cdp.send.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }, page);
			return out.result.value as T;
		},
		async callError(name, args) {
			const result = await call(name, args);
			if (result.isError !== true) throw new Error(`${name} unexpectedly succeeded: ${textOf(result)}`);
			return textOf(result);
		},
		async live(sessionId = 'default', bearer = key) {
			const value = await ticket(sessionId, bearer);
			const socket = new LiveSocket(`${gateway.url.replace(/^http/, 'ws')}/live/${sessionId}/ws?ticket=${value}`);
			opened.push(socket);
			await socket.ready();
			return socket;
		},
		async [Symbol.asyncDispose]() {
			for (const item of opened.reverse()) await item.close();
			await gateway.shutdown();
			await gateway.finished;
			await site.close();
		},
	};
}

/** One record on a session's event stream. */
export interface StreamRecord {
	kind: string;
	seq: number;
	payload: Record<string, unknown>;
}

/** An SSE reader over `/api/v1/sessions/default/events` that keeps every byte, so a leak is searched in `raw`. */
export class EventStream implements AsyncDisposable {
	readonly records: StreamRecord[] = [];
	raw = '';
	#reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	#pump: Promise<void> = Promise.resolve();

	/** Opens the stream and waits for its `stream-open` control record. */
	static async open(h: Pick<Harness, 'fetch'>, query: string): Promise<EventStream> {
		const stream = new EventStream();
		const response = await h.fetch(`/api/v1/sessions/default/events${query}`, {
			headers: { accept: 'text/event-stream' },
		});
		if (response.status !== 200 || response.body === null) {
			throw new Error(`the stream did not open: ${response.status}`);
		}
		stream.#reader = response.body.getReader();
		stream.#pump = stream.#read();
		await stream.until((record) => record.payload.event === 'stream-open', 'the stream-open control record');
		return stream;
	}

	async #read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const { value, done } = await this.#reader!.read();
				if (done) return;
				const text = decoder.decode(value, { stream: true });
				this.raw += text;
				buffer += text;
				let boundary = buffer.indexOf('\n\n');
				while (boundary !== -1) {
					for (const line of buffer.slice(0, boundary).split('\n')) {
						if (!line.startsWith('data: ')) continue;
						try {
							this.records.push(JSON.parse(line.slice(6)) as StreamRecord);
						} catch { /* a keep-alive comment is not data */ }
					}
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf('\n\n');
				}
			}
		} catch { /* cancelled */ }
	}

	/** Waits for a record matching `predicate`, or fails with what did arrive. */
	until(predicate: (record: StreamRecord) => boolean, what: string, timeoutMs = 15_000): Promise<StreamRecord> {
		return poll(what, () => this.records.find(predicate), timeoutMs).catch(() => {
			throw new Error(`timed out waiting for ${what}; saw [${this.records.map((r) => r.kind).join(', ')}]`);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.#reader?.cancel().catch(() => {});
		await this.#pump;
	}
}

/** How long a live-view expectation waits before failing the test. */
const LIVE_TIMEOUT_MS = 25_000;

/**
 * A live-view connection with promise-shaped expectations. Messages are buffered from the moment the socket opens,
 * so `waitFor` finds one that arrived before it was called.
 */
export class LiveSocket {
	readonly #socket: WebSocket;
	readonly #messages: ServerMsg[] = [];
	readonly #frames: Array<{ meta: FrameMeta; jpeg: Uint8Array }> = [];
	readonly #waiters: Array<() => void> = [];
	#openError: Error | null = null;
	#opened = false;
	#closed = false;
	closeCode: number | null = null;
	closeReason = '';

	constructor(url: string) {
		this.#socket = new WebSocket(url);
		this.#socket.binaryType = 'arraybuffer';
		this.#socket.onopen = () => {
			this.#opened = true;
			this.#wake();
		};
		this.#socket.onmessage = (event) => {
			if (typeof event.data === 'string') this.#messages.push(JSON.parse(event.data) as ServerMsg);
			else this.#frames.push(decodeFrame(event.data as ArrayBuffer));
			this.#wake();
		};
		this.#socket.onerror = () => {
			this.#openError ??= new Error('live socket error');
			this.#wake();
		};
		this.#socket.onclose = (event) => {
			this.#closed = true;
			this.closeCode = event.code;
			this.closeReason = event.reason;
			this.#wake();
		};
	}

	get messages(): readonly ServerMsg[] {
		return this.#messages;
	}

	get frames(): readonly { meta: FrameMeta; jpeg: Uint8Array }[] {
		return this.#frames;
	}

	#wake(): void {
		for (const wake of this.#waiters.splice(0)) wake();
	}

	/** Resolves once the socket has delivered its `meta` message. */
	ready(): Promise<Extract<ServerMsg, { type: 'meta' }>> {
		return this.waitFor('meta');
	}

	send(message: ClientMsg): void {
		this.#socket.send(JSON.stringify(message));
	}

	/** Sends a raw string, for malformed-input tests. */
	sendRaw(text: string): void {
		this.#socket.send(text);
	}

	/**
	 * Waits for a (possibly already-buffered) message of a type, ignoring messages before index `from`; `nudge` as in
	 * {@linkcode until}, for a message that rides on a frame.
	 */
	waitFor<T extends ServerMsg['type']>(
		type: T,
		predicate: (message: Extract<ServerMsg, { type: T }>) => boolean = () => true,
		from = 0,
		nudge?: () => Promise<void>,
	): Promise<Extract<ServerMsg, { type: T }>> {
		return this.until(
			() =>
				this.#messages.slice(from).find((message): message is Extract<ServerMsg, { type: T }> =>
					message.type === type && predicate(message as Extract<ServerMsg, { type: T }>)
				),
			`a "${type}" message`,
			nudge,
		);
	}

	/** Waits until at least `count` frames have arrived, and returns the latest. */
	waitForFrames(count = 1): Promise<{ meta: FrameMeta; jpeg: Uint8Array }> {
		return this.until(() => (this.#frames.length >= count ? this.#frames.at(-1) : undefined), `${count} frame(s)`);
	}

	/** Waits until the socket is closed by the peer. */
	waitForClose(): Promise<{ code: number; reason: string }> {
		return this.until(
			() => (this.#closed ? { code: this.closeCode ?? 0, reason: this.closeReason } : undefined),
			'the socket to close',
		);
	}

	/**
	 * Waits until a condition over the buffered state holds. `nudge` runs before each re-probe, for a condition that
	 * needs the page to act: a screencast frame arrives only when the page paints.
	 */
	until<T>(probe: () => T | undefined, what: string, nudge?: () => Promise<void>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const deadline = Date.now() + LIVE_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			// A nudge still in flight when the wait settles would outlive the test (a leaked tool call).
			let nudging: Promise<void> = Promise.resolve();
			const attempt = () => {
				// One pending re-probe per wait: an event can wake `attempt` while the previous timer is pending.
				clearTimeout(timer);
				if (settled) return;
				if (this.#openError !== null && !this.#opened) {
					settled = true;
					return reject(this.#openError);
				}
				const found = probe();
				if (found !== undefined) {
					settled = true;
					return void nudging.then(() => resolve(found));
				}
				if (Date.now() > deadline) {
					settled = true;
					return reject(
						new Error(
							`timed out after ${LIVE_TIMEOUT_MS}ms waiting for ${what}; saw ${this.#messages.length} message(s) [${
								this.#messages.map((m) => m.type).join(', ')
							}] and ${this.#frames.length} frame(s)` +
								(this.#closed ? `; socket closed ${this.closeCode} ${this.closeReason}` : ''),
						),
					);
				}
				this.#waiters.push(attempt);
				// Re-probe on a timer too: some conditions (a frame that never comes) raise no event.
				timer = setTimeout(() => {
					if (nudge === undefined) return attempt();
					nudging = nudge().then(attempt, attempt);
				}, 250);
				Deno.unrefTimer(timer);
			};
			attempt();
		});
	}

	async close(): Promise<void> {
		if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
			this.#socket.close();
		}
		if (!this.#closed) await this.until(() => (this.#closed ? true : undefined), 'the socket to close').catch(() => {});
	}
}
