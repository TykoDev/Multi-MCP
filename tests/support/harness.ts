/**
 * @module
 * The browser-tier harness: a real gateway, a real Chromium, a real MCP client.
 *
 * Every end-to-end suite builds on this so that writing one more *real* test is
 * cheap. Nothing here is a stub — the registry launches Chromium, the client is
 * the SDK's own `Client` speaking Streamable HTTP over a loopback listener, and
 * the live-view socket is a real `WebSocket` carrying real screencast frames.
 *
 * Launching Chromium costs seconds, so suites open one harness per top-level
 * `Deno.test` and use `t.step` for the individual assertions. That keeps the
 * browser count low without giving up granular reporting.
 */
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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
	params: {
		messages: Array<{ role: string; content: unknown }>;
		systemPrompt?: string;
		maxTokens?: number;
	};
}) => Promise<{ model: string; role: 'assistant'; content: { type: 'text'; text: string } }>;

export interface HarnessOptions {
	/** Scopes on the harness credential. Defaults to every scope. */
	readonly scopes?: readonly Scope[];
	/** `ApiKeyRecord.label` on the harness credential (B2.3 `holder_name`). */
	readonly label?: string;
	/** Extra/overriding `TTK_*` configuration. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Resolved secret-file contents by variable (`TTK_SANDBOX_TOKEN`), as the CLI hands them to `loadConfig`. */
	readonly secrets?: Readonly<Record<string, string>>;
	/** Registers a `sampling/createMessage` handler on the client. */
	readonly sampling?: SamplingResponder;
	/** Skips connecting the MCP client (for auth-shape tests). */
	readonly noClient?: boolean;
	/** Fixture-site options. */
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
	/** Calls a tool and returns the raw result. */
	call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
	/** Calls a tool, asserting success, and returns its concatenated text. */
	callText(name: string, args?: Record<string, unknown>): Promise<string>;
	/** Calls a tool, asserting success, and parses its JSON text payload. */
	callJson<T>(name: string, args?: Record<string, unknown>): Promise<T>;
	/** Calls a tool expecting failure; returns the `Error: <code>: …` text. */
	callError(name: string, args?: Record<string, unknown>): Promise<string>;
	/** Mints a live-view ticket over HTTP. */
	ticket(sessionId?: string, key?: string): Promise<string>;
	/** Opens a live-view socket and waits for its `meta` message. */
	live(sessionId?: string, key?: string): Promise<LiveSocket>;
	/** Authenticated `fetch` against the gateway. */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** Connects an additional MCP client (e.g. under a second credential). */
	connectClient(key: string, options?: { sampling?: SamplingResponder }): Promise<Client>;
}

/** All content text blocks of a result, joined. */
export function textOf(result: { content?: unknown }): string {
	const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
	return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

/** The first image block of a result, decoded. */
export function imageOf(result: { content?: unknown }): { bytes: Uint8Array; mimeType: string } | null {
	const blocks = (result.content ?? []) as Array<{ type: string; data?: string; mimeType?: string }>;
	const image = blocks.find((b) => b.type === 'image');
	if (image === undefined) return null;
	return {
		bytes: Uint8Array.from(atob(image.data ?? ''), (c) => c.charCodeAt(0)),
		mimeType: image.mimeType ?? '',
	};
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
	// **`task` is named deliberately, and since SEC-01b that matters.** It left
	// `DEFAULT_SCOPES` in 0.2.0, so a harness that relied on the default grant
	// would silently stop offering `browser_run_task` and the agent tier would go
	// green by not testing anything. Naming it here keeps the browser tier
	// exercising the loop while the *product* default withholds it; a test that
	// wants the deny path passes its own narrower list, as the R2 scope test does.
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
		// The suites poll the browser hard while waiting for the page to settle,
		// which the production default (120/min) is not sized for. Rate limiting
		// has its own tests; here it would only produce flakes that say nothing.
		TTK_RATE_RPM: '100000',
		// D-150: `owner` is the product default now, under which `default` becomes each owner's `default-<ulid>`. The
		// browser tier's suites address the `default` session by that name, and ownership has its own suite
		// (`ownership_e2e_test.ts`, which builds its own `owner` deployment), so the harness shares sessions unless a
		// test passes `TTK_SESSION_OWNERSHIP` itself. The other D-150 defaults (handoff, links, MCP Apps) stay as shipped.
		TTK_SESSION_OWNERSHIP: 'shared',
		...options.env,
	}, options.secrets === undefined ? {} : { secrets: options.secrets });
	const gateway = await startGateway({
		config,
		version: '0.1.0-e2e',
		logger: createLogger({ level: 'error', write: () => {} }),
	});

	const opened: Array<{ close(): Promise<void> | void }> = [];

	const connectClient = async (
		bearer: string,
		clientOptions: { sampling?: SamplingResponder } = {},
	): Promise<Client> => {
		const client = new Client(
			{ name: 'ttk-e2e', version: '0' },
			{
				versionNegotiation: { mode: 'auto' },
				...(clientOptions.sampling === undefined ? {} : { capabilities: { sampling: {} } }),
				...(options.maxRounds === undefined ? {} : { inputRequired: { maxRounds: options.maxRounds } }),
			},
		);
		if (clientOptions.sampling !== undefined) {
			const responder = clientOptions.sampling;
			client.setRequestHandler(
				'sampling/createMessage',
				// deno-lint-ignore no-explicit-any
				async (request: any) => await responder(request),
			);
		}
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
				fetch: (input, init) => {
					const headers = new Headers(init?.headers);
					headers.set('Authorization', `Bearer ${bearer}`);
					return fetch(input, { ...init, headers });
				},
			}),
		);
		opened.push({ close: () => client.close().catch(() => {}) });
		return client;
	};

	const client = options.noClient === true
		? (undefined as unknown as Client)
		: await connectClient(key, options.sampling === undefined ? {} : { sampling: options.sampling });

	const authFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(init.headers);
		if (!headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
		return fetch(`${gateway.url}${path}`, { ...init, headers });
	};

	const call = (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

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
		connectClient,
		ticket,

		async callText(name, args) {
			const result = await call(name, args);
			if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
			return textOf(result);
		},

		async callJson<T>(name: string, args?: Record<string, unknown>): Promise<T> {
			const result = await call(name, args);
			if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
			return JSON.parse(textOf(result)) as T;
		},

		async callError(name, args) {
			const result = await call(name, args);
			if (result.isError !== true) throw new Error(`${name} unexpectedly succeeded: ${textOf(result)}`);
			return textOf(result);
		},

		async live(sessionId = 'default', bearer = key) {
			const value = await ticket(sessionId, bearer);
			const socket = new LiveSocket(
				`${gateway.url.replace(/^http/, 'ws')}/live/${sessionId}/ws?ticket=${value}`,
			);
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

/** How long a live-view expectation waits before failing the test. */
const LIVE_TIMEOUT_MS = 25_000;

/**
 * A live-view connection with promise-shaped expectations.
 *
 * Messages are buffered from the moment the socket opens, so `waitFor` finds a
 * message that arrived before it was called. Without that, every assertion
 * would race the server and the suite would be flaky in exactly the way that
 * teaches people to add sleeps.
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
			if (typeof event.data === 'string') {
				this.#messages.push(JSON.parse(event.data) as ServerMsg);
			} else {
				this.#frames.push(decodeFrame(event.data as ArrayBuffer));
			}
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

	/** Every message received so far. */
	get messages(): readonly ServerMsg[] {
		return this.#messages;
	}

	/** Every frame received so far. */
	get frames(): readonly { meta: FrameMeta; jpeg: Uint8Array }[] {
		return this.#frames;
	}

	get isClosed(): boolean {
		return this.#closed;
	}

	get bufferedAmount(): number {
		return this.#socket.bufferedAmount;
	}

	#wake(): void {
		for (const wake of this.#waiters.splice(0)) wake();
	}

	/** Resolves once the socket has delivered its `meta` message. */
	async ready(): Promise<Extract<ServerMsg, { type: 'meta' }>> {
		return await this.waitFor('meta');
	}

	send(message: ClientMsg): void {
		this.#socket.send(JSON.stringify(message));
	}

	/** Sends a raw string, for malformed-input tests. */
	sendRaw(text: string): void {
		this.#socket.send(text);
	}

	/**
	 * Waits for the next (or already-buffered) message of a type.
	 *
	 * `from` lets a caller ignore messages seen before some point, which is how
	 * a test asserts "after I sent X, a *new* lock message arrived".
	 */
	waitFor<T extends ServerMsg['type']>(
		type: T,
		predicate: (message: Extract<ServerMsg, { type: T }>) => boolean = () => true,
		from = 0,
	): Promise<Extract<ServerMsg, { type: T }>> {
		return this.#until(() => {
			for (let i = from; i < this.#messages.length; i++) {
				const message = this.#messages[i] as ServerMsg;
				if (message.type === type) {
					const narrowed = message as Extract<ServerMsg, { type: T }>;
					if (predicate(narrowed)) return narrowed;
				}
			}
			return undefined;
		}, `a "${type}" message`);
	}

	/** Waits until at least `count` frames have arrived, and returns the latest. */
	waitForFrames(count = 1): Promise<{ meta: FrameMeta; jpeg: Uint8Array }> {
		return this.#until(
			() => (this.#frames.length >= count ? this.#frames[this.#frames.length - 1] : undefined),
			`${count} screencast frame(s)`,
		);
	}

	/** Waits until the socket is closed by the peer. */
	waitForClose(): Promise<{ code: number; reason: string }> {
		return this.#until(
			() => (this.#closed ? { code: this.closeCode ?? 0, reason: this.closeReason } : undefined),
			'the socket to close',
		);
	}

	/**
	 * Waits until an arbitrary condition over the buffered state holds.
	 *
	 * `nudge` runs before each re-probe, for a condition that needs the page to do something: a
	 * screencast frame arrives only when the page *paints*, so a test waiting for one after a
	 * server-side change has to keep giving it a reason to.
	 */
	until<T>(probe: () => T | undefined, what: string, nudge?: () => Promise<void>): Promise<T> {
		return this.#until(probe, what, nudge);
	}

	#until<T>(probe: () => T | undefined, what: string, nudge?: () => Promise<void>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const deadline = Date.now() + LIVE_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const attempt = () => {
				// One pending re-probe per wait. A socket event wakes `attempt` while
				// the previous re-probe timer is still pending; overwriting `timer`
				// without clearing it left that timer running past the test, which the
				// sanitizer reported as a leak — intermittently, depending on how many
				// events arrived before the condition held.
				clearTimeout(timer);
				if (settled) return;
				if (this.#openError !== null && !this.#opened) {
					settled = true;
					reject(this.#openError);
					return;
				}
				const found = probe();
				if (found !== undefined) {
					settled = true;
					resolve(found);
					return;
				}
				if (Date.now() > deadline) {
					settled = true;
					reject(
						new Error(
							`timed out after ${LIVE_TIMEOUT_MS}ms waiting for ${what}; ` +
								`saw ${this.#messages.length} message(s) [${
									this.#messages.map((m) => m.type).join(', ')
								}] and ${this.#frames.length} frame(s)` +
								(this.#closed ? `; socket closed ${this.closeCode} ${this.closeReason}` : ''),
						),
					);
					return;
				}
				this.#waiters.push(attempt);
				// Re-probe on a timer too: some conditions (a frame that never
				// comes) produce no event to wake on.
				timer = setTimeout(() => {
					if (nudge === undefined) {
						attempt();
						return;
					}
					nudge().then(attempt, attempt);
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
		if (!this.#closed) {
			await this.#until(() => (this.#closed ? true : undefined), 'the socket to close').catch(() => {});
		}
	}
}
