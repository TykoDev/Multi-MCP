/**
 * The stateful 2025-era MCP transport (SPECS/ROADMAP.md R8, D-004 reopen).
 *
 * The 2026-07-28 revision is stateless per request, and that mount stays: browser statefulness lives in the session
 * registry, addressed by `session_id`. 2025-era clients — pi, most hosts — open one connection, expect an
 * `Mcp-Session-Id` back, and hold a standalone SSE stream for server-initiated messages. That stream is the only way
 * such a client hears `notifications/tools/list_changed`, so without a session it keeps the tool list it fetched when
 * it connected — across a deploy that changed a tool, and across a scope change that added or removed some. This mount
 * is therefore on by default outside a cluster (`TTK_MCP_STATEFUL`).
 *
 * ## Change push
 *
 * - **A deploy (a restart).** A session's non-secret record — its id, its principal and the client's own `initialize`
 *   parameters, never a token, credential or scope — is kept in `<TTK_DATA_DIR>/mcp/sessions.json`. After a restart
 *   the client's next request with that id (its stream reconnecting, typically) restores the session for the same
 *   principal: a fresh server built from that request's own credential, the client's `initialize` replayed into it so
 *   the transport and server hold the session as the client opened it — and `tools/list_changed` and
 *   `resources/list_changed` pushed on the stream as soon as it opens, so the client re-lists the deployed catalog.
 * - **A scope change.** Registration is decided by scope, so a session whose credential's scopes moved is rebuilt
 *   under the same id with the new set and told to re-list: at once when the gateway hears of the change
 *   ({@linkcode StatefulMount.refreshCredentials}, from the verifier), and in any case on the next request whose
 *   credential carries a different set than the session was built with. A credential that is gone closes its
 *   sessions. A delegated credential is only ever narrowed by the push; its next request decides any widening.
 * - **A service coming or going** re-reads tool availability in place (D-082, {@linkcode StatefulMount.refreshTools}).
 *
 * Every request must come from the principal that opened the session; another principal presenting the id is told the
 * session does not exist.
 *
 * ## What "stateful" costs, stated plainly
 *
 * A transport session pins a client to *this process*. That is fine for one node and wrong for several, so it is
 * incompatible with the cluster mode (R10): `loadConfig` resolves an unset `TTK_MCP_STATEFUL` off in a cluster and
 * refuses it named `true` with `TTK_CLUSTER_KV` (C8 / D-102). Sessions are also memory a client can create and
 * forget, so they are capped and reaped; one whose standalone stream is open is not idle.
 */
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
import { DurableJsonFile } from '@tykotech/agents';
import {
	refreshToolAvailability,
	type ResourceWatch,
	serverSessionAccess,
	type SessionRegistry,
	watchResourceChanges,
} from '@tykotech/mcp';
import type { Logger } from './logger.ts';

/** Header the 2025 revision carries the transport session in. */
export const SESSION_HEADER = 'mcp-session-id';

export interface StatefulMountOptions {
	readonly buildServer: McpServerFactory;
	readonly logger: Logger;
	/**
	 * D-080: the registry whose changes each session's standalone stream carries (`resources/list_changed`, and
	 * `resources/updated` for subscribed URIs). Without one the mount serves requests and pushes nothing.
	 */
	readonly registry?: Pick<SessionRegistry, 'watch'>;
	/** Hard cap on concurrent transport sessions. */
	readonly maxSessions?: number;
	/** Idle milliseconds before a transport session is closed. */
	readonly ttlMs?: number;
	/** Injected clock, so expiry is testable without waiting. */
	readonly now?: () => number;
	/** Where session records are kept across restarts (`<TTK_DATA_DIR>/mcp/sessions.json`); absent, in memory only. */
	readonly persistPath?: string;
	/**
	 * The scopes the credential behind `authInfo` holds now: a list, `null` once it is gone, or `undefined` when it
	 * cannot be re-read without the token (OAuth) — the next request decides then.
	 */
	readonly currentScopes?: (authInfo: AuthInfo) => readonly string[] | null | undefined;
}

/** The client's own `initialize` parameters, replayed to restore or rebuild its session. */
interface InitParams {
	readonly protocolVersion: string;
	readonly capabilities: Record<string, unknown>;
	readonly clientInfo: Record<string, unknown>;
}

/** What survives a restart: identity and the handshake. No token, credential or scope is ever written. */
interface SessionRecord {
	readonly id: string;
	readonly principal: string;
	readonly init: InitParams;
	lastUsedAt: number;
}

interface TransportSession {
	readonly id: string;
	readonly transport: WebStandardStreamableHTTPServerTransport;
	readonly server: McpServer;
	readonly watch: ResourceWatch | null;
	readonly principal: string;
	/** The sorted scopes the session's tools were registered for. */
	readonly scopes: string;
	/** Memory only: the credential the server was built with, so a pushed scope change can rebuild it. */
	readonly authInfo: AuthInfo | undefined;
	readonly init: InitParams;
	lastUsedAt: number;
	/** Push `list_changed` when the standalone stream next opens: the catalog moved under this session. */
	announce: boolean;
	/** Open standalone streams; a session with one is not idle. */
	streams: number;
}

const DEFAULTS = { maxSessions: 64, ttlMs: 30 * 60 * 1000 } as const;
/** How often a session's persisted `lastUsedAt` is refreshed: every request would rewrite the file for nothing. */
const PERSIST_TOUCH_MS = 60_000;

function principalOf(authInfo: AuthInfo | undefined): string {
	return authInfo?.clientId ?? 'local';
}

function scopeKey(scopes: readonly string[] | undefined): string {
	return [...new Set(scopes ?? [])].sort().join(' ');
}

/** The `initialize` parameters a request carries, or `null` when it is not an initialize the mount can replay. */
function initParamsOf(parsedBody: unknown): InitParams | null {
	const message = (Array.isArray(parsedBody) ? parsedBody[0] : parsedBody) as
		| { method?: unknown; params?: Record<string, unknown> }
		| undefined;
	const params = message?.params;
	if (message?.method !== 'initialize' || params === undefined || typeof params.protocolVersion !== 'string') {
		return null;
	}
	const object = (value: unknown): Record<string, unknown> =>
		value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return {
		protocolVersion: params.protocolVersion,
		capabilities: object(params.capabilities),
		clientInfo: object(params.clientInfo),
	};
}

/** A stored record re-read: well-formed or skipped, never trusted beyond its shape. */
function storedRecord(value: unknown): SessionRecord | null {
	if (value === null || typeof value !== 'object') return null;
	const record = value as Record<string, unknown>;
	const init = record.init as Record<string, unknown> | undefined;
	if (
		typeof record.id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(record.id) || typeof record.principal !== 'string' ||
		record.principal === '' || typeof record.lastUsedAt !== 'number' || init === undefined ||
		typeof init.protocolVersion !== 'string' || typeof init.capabilities !== 'object' ||
		typeof init.clientInfo !== 'object' || init.capabilities === null || init.clientInfo === null
	) return null;
	if (JSON.stringify(init).length > 16 * 1024) return null;
	return {
		id: record.id,
		principal: record.principal,
		init: init as unknown as InitParams,
		lastUsedAt: record.lastUsedAt,
	};
}

/**
 * Routes requests to per-session transports, creating one on `initialize` and restoring one a restart lost.
 */
export class StatefulMount {
	readonly #options:
		& Required<Omit<StatefulMountOptions, 'buildServer' | 'logger' | 'registry' | 'persistPath' | 'currentScopes'>>
		& StatefulMountOptions;
	readonly #sessions = new Map<string, TransportSession>();
	/** Every session this mount may restore: the open ones and those a restart left behind. */
	readonly #records = new Map<string, SessionRecord>();
	readonly #file: DurableJsonFile | undefined;
	/** Restores and rebuilds in flight, so two requests for one id never build two sessions. */
	readonly #opening = new Map<string, Promise<TransportSession | null>>();
	#closed = false;

	constructor(options: StatefulMountOptions) {
		// The spread comes first: a caller passing `{ maxSessions: undefined }`
		// explicitly must not clobber the default with `undefined`.
		this.#options = {
			...options,
			maxSessions: options.maxSessions ?? DEFAULTS.maxSessions,
			ttlMs: options.ttlMs ?? DEFAULTS.ttlMs,
			now: options.now ?? (() => Date.now()),
		};
		this.#file = options.persistPath === undefined
			? undefined
			: new DurableJsonFile(options.persistPath, { logger: options.logger });
		this.#restore();
	}

	get size(): number {
		return this.#sessions.size;
	}

	/** Session ids currently held, for tests and diagnostics. */
	ids(): string[] {
		return [...this.#sessions.keys()];
	}

	/**
	 * Serves one request.
	 *
	 * A request naming a session goes to that session's transport — restored first when a restart lost it, rebuilt
	 * first when its credential's scopes moved. A request naming none is an initialization: a fresh transport is
	 * built, and the `Mcp-Session-Id` it mints comes back in the response headers.
	 */
	async fetch(request: Request, options: { authInfo?: AuthInfo; parsedBody?: unknown } = {}): Promise<Response> {
		this.#reap();
		const id = request.headers.get(SESSION_HEADER);

		if (id !== null && id !== '') {
			const session = await this.#sessionFor(id, request, options.authInfo);
			if (session === null) {
				// The spec's answer for an unknown session, and the one a client knows how to recover from: re-initialize.
				// Another principal presenting a live id is told the same, so the id is no oracle.
				return jsonRpcError(404, -32_001, 'Session not found');
			}
			this.#touch(session);
			if (request.method === 'DELETE') {
				// Handled by the transport first so it can answer correctly, then
				// forgotten here — `onsessionclosed` fires from inside.
				const response = await session.transport.handleRequest(request, options);
				this.#forget(id, session.transport);
				return response;
			}
			const response = await session.transport.handleRequest(request, options);
			if (request.method !== 'GET' || response.status !== 200 || response.body === null) return response;
			if (session.announce) {
				// The stream is mapped before `handleRequest` returns, so the notifications are queued on it now.
				session.announce = false;
				await this.#announce(session);
			}
			return this.#tracked(session, response);
		}

		if (request.method !== 'POST') {
			// A GET with no session is a standalone-stream request for a session
			// that does not exist; the 2025 spec has no way to create one that way.
			return jsonRpcError(400, -32_000, 'Mcp-Session-Id is required');
		}

		if (this.#sessions.size >= this.#options.maxSessions) {
			this.#reap(true);
			if (this.#sessions.size >= this.#options.maxSessions) {
				this.#options.logger.warn(`stateful MCP session cap (${this.#options.maxSessions}) reached`);
				return jsonRpcError(429, -32_000, 'too many MCP sessions');
			}
		}

		const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessionclosed: (sessionId): void => this.#forget(sessionId, transport),
		});
		const { server, watch } = await this.#build(transport, options.authInfo);

		// The handshake is kept to restore the session after a restart; the gateway passes the parsed body, a direct
		// caller may not.
		const init = initParamsOf(options.parsedBody ?? await request.clone().json().catch(() => undefined));
		const response = await transport.handleRequest(request, options);
		const sessionId = transport.sessionId;
		if (sessionId === undefined) {
			// Not an initialization after all: nothing to remember, and the
			// transport is dropped rather than leaked.
			watch?.close();
			await server.close().catch(() => {});
			return response;
		}
		this.#adopt({
			id: sessionId,
			transport,
			server,
			watch,
			principal: principalOf(options.authInfo),
			scopes: scopeKey(options.authInfo?.scopes),
			authInfo: options.authInfo,
			// A session the transport minted is kept; one whose handshake could not be read restores as a bare client.
			init: init ?? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unknown', version: '0' } },
			lastUsedAt: this.#options.now(),
			announce: false,
			streams: 0,
		});
		this.#options.logger.info(`stateful MCP session ${sessionId} opened`);
		return response;
	}

	/** D-082: every open session re-reads which of its tools are available; each change is announced to it. */
	refreshTools(): void {
		for (const session of this.#sessions.values()) refreshToolAvailability(session.server);
	}

	/**
	 * A credential changed (a key file reload, a key removed, an account's scopes edited, a sign-in ended): every
	 * session re-reads what its credential holds now. One whose credential is gone is closed; one whose scopes moved
	 * is rebuilt under the same id and told to re-list. Resolves once every rebuild has landed.
	 */
	async refreshCredentials(): Promise<void> {
		const current = this.#options.currentScopes;
		if (current === undefined) return;
		await Promise.all([...this.#sessions.values()].map(async (session) => {
			if (session.authInfo === undefined) return;
			let held: readonly string[] | null | undefined;
			try {
				held = current(session.authInfo);
			} catch {
				held = null;
			}
			if (held === undefined) return;
			if (held === null) {
				this.#options.logger.info(`stateful MCP session ${session.id} closed: its credential is gone`);
				this.#forget(session.id, session.transport);
				return;
			}
			// A delegated credential holds at most what it was issued; only its own next request may widen it.
			const scopes = session.authInfo.extra?.delegatedMcp === true
				? held.filter((scope) => session.authInfo!.scopes.includes(scope))
				: held;
			if (scopeKey(scopes) === session.scopes) return;
			await this.#rebuild(session, { ...session.authInfo, scopes: [...scopes] });
		}));
	}

	/** Closes every session; their records stay, so a restart can restore them. */
	async close(): Promise<void> {
		this.#closed = true;
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.all(sessions.map(async (session) => {
			session.watch?.close();
			await session.server.close().catch(() => {});
			await session.transport.close().catch(() => {});
		}));
		await this.#file?.close(this.#document());
	}

	/** The session a request names: the open one, restored, or rebuilt; `null` when there is none for its principal. */
	async #sessionFor(id: string, request: Request, authInfo: AuthInfo | undefined): Promise<TransportSession | null> {
		const pending = this.#opening.get(id);
		if (pending !== undefined) await pending;
		const principal = principalOf(authInfo);
		const open = this.#sessions.get(id);
		if (open !== undefined) {
			if (open.principal !== principal) return null;
			// The request's credential is the authority: a session built for other scopes is rebuilt for these.
			if (open.scopes !== scopeKey(authInfo?.scopes) && request.method !== 'DELETE') {
				return await this.#rebuild(open, authInfo);
			}
			return open;
		}
		const record = this.#records.get(id);
		if (record === undefined || record.principal !== principal || request.method === 'DELETE') {
			if (record !== undefined && record.principal === principal) this.#drop(id);
			return null;
		}
		if (this.#sessions.size >= this.#options.maxSessions) this.#reap(true);
		const restored = this.#open(id, record.init, authInfo).then((session) => {
			if (session !== null) {
				session.announce = true;
				this.#options.logger.info(`stateful MCP session ${id} restored; the client is told to re-list its tools`);
			}
			return session;
		});
		return await this.#guard(id, restored);
	}

	/** Rebuilds `old` under its id for `authInfo`, announcing the change on the stream it has or the one it opens. */
	async #rebuild(old: TransportSession, authInfo: AuthInfo | undefined): Promise<TransportSession | null> {
		const rebuilt = this.#open(old.id, old.init, authInfo).then(async (session) => {
			if (session === null) return null;
			// Told on the old stream when the client holds one (its re-list reaches the new session, already in place),
			// else on the next stream it opens. Closing the old transport ends that stream; the client reopens it here.
			if (old.streams > 0) await this.#announce(old);
			else session.announce = true;
			old.watch?.close();
			void old.server.close().catch(() => {});
			this.#options.logger.info(`stateful MCP session ${old.id} rebuilt for changed scopes`);
			return session;
		});
		return await this.#guard(old.id, rebuilt);
	}

	/** Serializes builds per id: the second request for an id waits for the first and uses its session. */
	async #guard(id: string, work: Promise<TransportSession | null>): Promise<TransportSession | null> {
		this.#opening.set(id, work);
		try {
			return await work;
		} catch (cause) {
			this.#options.logger.warn(`stateful MCP session ${id} could not be restored: ${String(cause)}`);
			return null;
		} finally {
			if (this.#opening.get(id) === work) this.#opening.delete(id);
		}
	}

	/**
	 * A session under a known id, built from `authInfo` and holding the client's handshake: its `initialize` and
	 * `notifications/initialized` replayed into a fresh transport, which mints exactly `id`. Public SDK surface only.
	 */
	async #open(id: string, init: InitParams, authInfo: AuthInfo | undefined): Promise<TransportSession | null> {
		if (this.#closed) return null;
		const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => id,
			onsessionclosed: (sessionId): void => this.#forget(sessionId, transport),
		});
		const { server, watch } = await this.#build(transport, authInfo);
		const auth = authInfo === undefined ? {} : { authInfo };
		const initialize = { jsonrpc: '2.0', id: `restore-${id}`, method: 'initialize', params: init };
		const answered = await transport.handleRequest(
			new Request('http://127.0.0.1/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
				body: JSON.stringify(initialize),
			}),
			{ ...auth, parsedBody: initialize },
		);
		await answered.text().catch(() => '');
		const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
		const acknowledged = await transport.handleRequest(
			new Request('http://127.0.0.1/mcp', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					[SESSION_HEADER]: id,
					'mcp-protocol-version': init.protocolVersion,
				},
				body: JSON.stringify(initialized),
			}),
			{ ...auth, parsedBody: initialized },
		);
		await acknowledged.body?.cancel().catch(() => {});
		if (!answered.ok || transport.sessionId !== id) {
			watch?.close();
			await server.close().catch(() => {});
			return null;
		}
		const session: TransportSession = {
			id,
			transport,
			server,
			watch,
			principal: principalOf(authInfo),
			scopes: scopeKey(authInfo?.scopes),
			authInfo,
			init,
			lastUsedAt: this.#options.now(),
			announce: false,
			streams: 0,
		};
		this.#adopt(session);
		return session;
	}

	/** The server for a transport: the same factory the stateless mount uses, so both eras serve the same catalog. */
	async #build(
		transport: WebStandardStreamableHTTPServerTransport,
		authInfo: AuthInfo | undefined,
	): Promise<{ server: McpServer; watch: ResourceWatch | null }> {
		const built = await this.#options.buildServer({ era: 'legacy', ...(authInfo ? { authInfo } : {}) });
		const server = built as McpServer;
		// R8 (D-128): the connection hears only of sessions its caller may reach, judged with the very access its
		// tools and resources were built with.
		const watch = this.#options.registry === undefined
			? null
			: watchResourceChanges(server, this.#options.registry, 'legacy', serverSessionAccess(server));
		await server.connect(transport);
		return { server, watch };
	}

	/** Holds a session and its record (written within 250 ms). */
	#adopt(session: TransportSession): void {
		this.#sessions.set(session.id, session);
		this.#records.set(session.id, {
			id: session.id,
			principal: session.principal,
			init: session.init,
			lastUsedAt: session.lastUsedAt,
		});
		this.#changed();
	}

	/** Tells the client its tool and resource lists moved; a send that fails is the stream's own end. */
	async #announce(session: TransportSession): Promise<void> {
		await session.server.server.sendToolListChanged().catch(() => {});
		await session.server.server.sendResourceListChanged().catch(() => {});
	}

	/** The standalone stream, counted while it is open: a session holding one is in use, however quiet. */
	#tracked(session: TransportSession, response: Response): Response {
		const reader = response.body!.getReader();
		session.streams++;
		let open = true;
		const release = (): void => {
			if (!open) return;
			open = false;
			session.streams--;
			this.#touch(session);
		};
		const body = new ReadableStream<Uint8Array>({
			async pull(controller): Promise<void> {
				try {
					const next = await reader.read();
					if (next.done) {
						release();
						controller.close();
					} else controller.enqueue(next.value);
				} catch (cause) {
					release();
					controller.error(cause);
				}
			},
			cancel(reason): Promise<void> {
				release();
				return reader.cancel(reason);
			},
		});
		return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	}

	#touch(session: TransportSession): void {
		session.lastUsedAt = this.#options.now();
		const record = this.#records.get(session.id);
		if (record !== undefined && session.lastUsedAt - record.lastUsedAt >= PERSIST_TOUCH_MS) {
			record.lastUsedAt = session.lastUsedAt;
			this.#changed();
		}
	}

	/** Forgets the session `transport` serves; a rebuilt session under the same id is left alone. */
	#forget(sessionId: string, transport?: WebStandardStreamableHTTPServerTransport): void {
		const session = this.#sessions.get(sessionId);
		if (session === undefined || (transport !== undefined && session.transport !== transport)) return;
		this.#sessions.delete(sessionId);
		this.#drop(sessionId);
		session.watch?.close();
		void session.server.close().catch(() => {});
		this.#options.logger.info(`stateful MCP session ${sessionId} closed`);
	}

	#drop(sessionId: string): void {
		if (this.#records.delete(sessionId)) this.#changed();
	}

	/** Drops sessions idle beyond the TTL (an open stream is not idle). `force` also drops the oldest one. */
	#reap(force = false): void {
		const cutoff = this.#options.now() - this.#options.ttlMs;
		for (const session of [...this.#sessions.values()]) {
			if (session.streams === 0 && session.lastUsedAt < cutoff) this.#forget(session.id);
		}
		for (const record of [...this.#records.values()]) {
			if (!this.#sessions.has(record.id) && record.lastUsedAt < cutoff) this.#drop(record.id);
		}
		if (!force || this.#sessions.size < this.#options.maxSessions) return;
		// At the cap with nothing idle: evict the least recently used, because
		// refusing every new client forever is worse than dropping the stalest.
		const oldest = [...this.#sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
		if (oldest !== undefined) this.#forget(oldest.id);
	}

	#changed(): void {
		if (!this.#closed) this.#file?.schedule(() => this.#document());
	}

	#document(): { version: 1; sessions: SessionRecord[] } {
		return { version: 1, sessions: [...this.#records.values()] };
	}

	/** Loads the records a previous process left: well-formed, within the TTL and the cap. */
	#restore(): void {
		const raw = this.#file?.read();
		if (raw === undefined || raw === null || typeof raw !== 'object') return;
		const sessions = (raw as { version?: unknown; sessions?: unknown }).sessions;
		if ((raw as { version?: unknown }).version !== 1 || !Array.isArray(sessions)) return;
		const cutoff = this.#options.now() - this.#options.ttlMs;
		const kept = sessions.map(storedRecord).filter((record): record is SessionRecord =>
			record !== null && record.lastUsedAt >= cutoff
		).sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, this.#options.maxSessions * 4);
		for (const record of kept) this.#records.set(record.id, record);
		if (kept.length !== sessions.length) this.#changed();
	}
}

function jsonRpcError(status: number, code: number, message: string): Response {
	return new Response(
		JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
		{ status, headers: { 'content-type': 'application/json' } },
	);
}

/**
 * Whether a request belongs on the stateful mount (R8).
 *
 * Three cases, and no guessing:
 *
 * 1. it carries an `Mcp-Session-Id` — it is already in a stateful session;
 * 2. it is a `GET` — a standalone SSE stream, which exists only in the 2025
 *    world (the 2026 revision has `subscriptions/listen` instead);
 * 3. it is an `initialize` declaring a **2025** `protocolVersion`.
 *
 * The third is the one that matters. A 2025 client cannot ask for a session —
 * the spec has the *server* decide — so the only honest signal is the protocol
 * revision it announced. Routing on anything looser would push modern clients
 * onto a legacy transport that cannot serve them.
 */
export function wantsStatefulSession(request: Request, parsedBody?: unknown): boolean {
	if (request.headers.has(SESSION_HEADER)) return true;
	if (request.method === 'GET') return true;
	if (request.method !== 'POST') return false;

	const message = parsedBody as
		| { method?: unknown; params?: { protocolVersion?: unknown } }
		| Array<{ method?: unknown; params?: { protocolVersion?: unknown } }>
		| undefined;
	const first = Array.isArray(message) ? message[0] : message;
	if (first?.method !== 'initialize') return false;
	const version = first.params?.protocolVersion;
	return typeof version === 'string' && version.startsWith('2025');
}
