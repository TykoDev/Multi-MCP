/**
 * The stateful 2025-era MCP transport (SPECS/ROADMAP.md R8, D-004 reopen).
 *
 * The default mount is stateless per request, which is what the 2026-07-28
 * revision is: browser statefulness lives in the session registry, addressed by
 * `session_id`, and the transport carries nothing. That is the better design
 * and it stays the default.
 *
 * This exists for the clients that cannot do it — hosts pinned to the 2025
 * revision that open one connection, expect an `Mcp-Session-Id` back, and hold
 * a standalone SSE stream for server-initiated messages. Under the stateless
 * mount those clients work for `tools/call` and silently get nothing on the
 * stream, which is the worst of both.
 *
 * ## What "stateful" costs, stated plainly
 *
 * A transport session pins a client to *this process*. That is fine for one
 * node and wrong for several, so it is incompatible with the cluster mode
 * (R10): `loadConfig` refuses `TTK_MCP_STATEFUL` together with
 * `TTK_CLUSTER_KV` (`ConfigError('TTK_MCP_STATEFUL', …)`, C8 / D-102) rather
 * than letting the two disagree at runtime. Until 0.2.x this comment claimed
 * that refusal while nothing performed it. Sessions are also memory that a
 * client can create and forget, so they are capped and reaped.
 */
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
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
}

interface TransportSession {
	readonly id: string;
	readonly transport: WebStandardStreamableHTTPServerTransport;
	readonly server: McpServer;
	readonly watch: ResourceWatch | null;
	lastUsedAt: number;
}

const DEFAULTS = { maxSessions: 64, ttlMs: 30 * 60 * 1000 } as const;

/**
 * Routes requests to per-session transports, creating one on `initialize`.
 */
export class StatefulMount {
	readonly #options: Required<Omit<StatefulMountOptions, 'buildServer' | 'logger' | 'registry'>> & StatefulMountOptions;
	readonly #sessions = new Map<string, TransportSession>();

	constructor(options: StatefulMountOptions) {
		// The spread comes first: a caller passing `{ maxSessions: undefined }`
		// explicitly must not clobber the default with `undefined`.
		this.#options = {
			...options,
			maxSessions: options.maxSessions ?? DEFAULTS.maxSessions,
			ttlMs: options.ttlMs ?? DEFAULTS.ttlMs,
			now: options.now ?? (() => Date.now()),
		};
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
	 * A request naming a session goes to that session's transport. A request
	 * naming none is an initialization: a fresh transport is built, and the
	 * `Mcp-Session-Id` it mints comes back in the response headers.
	 */
	async fetch(request: Request, options: { authInfo?: AuthInfo; parsedBody?: unknown } = {}): Promise<Response> {
		this.#reap();
		const id = request.headers.get(SESSION_HEADER);

		if (id !== null && id !== '') {
			const existing = this.#sessions.get(id);
			if (existing === undefined) {
				// The spec's answer for an unknown session, and the one a client
				// knows how to recover from: re-initialize.
				return jsonRpcError(404, -32_001, 'Session not found');
			}
			existing.lastUsedAt = this.#options.now();
			if (request.method === 'DELETE') {
				// Handled by the transport first so it can answer correctly, then
				// forgotten here — `onsessionclosed` fires from inside.
				const response = await existing.transport.handleRequest(request, options);
				this.#forget(id);
				return response;
			}
			return await existing.transport.handleRequest(request, options);
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

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessionclosed: (sessionId) => this.#forget(sessionId),
		});

		// The factory is the same one the stateless mount uses, so the two eras
		// serve exactly the same tools, resources and policy.
		const built = await this.#options.buildServer({
			era: 'legacy',
			...(options.authInfo ? { authInfo: options.authInfo } : {}),
		});
		const server = built as McpServer;
		// R8 (D-128): the connection hears only of sessions its caller may reach, judged with the very access its
		// tools and resources were built with.
		const watch = this.#options.registry === undefined
			? null
			: watchResourceChanges(server, this.#options.registry, 'legacy', serverSessionAccess(server));
		await server.connect(transport);

		const response = await transport.handleRequest(request, options);
		const sessionId = transport.sessionId;
		if (sessionId === undefined) {
			// Not an initialization after all: nothing to remember, and the
			// transport is dropped rather than leaked.
			watch?.close();
			await server.close().catch(() => {});
			return response;
		}
		this.#sessions.set(sessionId, {
			id: sessionId,
			transport,
			server,
			watch,
			lastUsedAt: this.#options.now(),
		});
		this.#options.logger.info(`stateful MCP session ${sessionId} opened`);
		return response;
	}

	/** D-082: every open session re-reads which of its tools are available; each change is announced to it. */
	refreshTools(): void {
		for (const session of this.#sessions.values()) refreshToolAvailability(session.server);
	}

	/** Closes every session. */
	async close(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.all(sessions.map(async (session) => {
			session.watch?.close();
			await session.server.close().catch(() => {});
			await session.transport.close().catch(() => {});
		}));
	}

	#forget(sessionId: string): void {
		const session = this.#sessions.get(sessionId);
		if (session === undefined) return;
		this.#sessions.delete(sessionId);
		session.watch?.close();
		void session.server.close().catch(() => {});
		this.#options.logger.info(`stateful MCP session ${sessionId} closed`);
	}

	/** Drops sessions idle beyond the TTL. `force` also drops the oldest one. */
	#reap(force = false): void {
		const cutoff = this.#options.now() - this.#options.ttlMs;
		for (const session of [...this.#sessions.values()]) {
			if (session.lastUsedAt < cutoff) this.#forget(session.id);
		}
		if (!force || this.#sessions.size < this.#options.maxSessions) return;
		// At the cap with nothing idle: evict the least recently used, because
		// refusing every new client forever is worse than dropping the stalest.
		const oldest = [...this.#sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
		if (oldest !== undefined) this.#forget(oldest.id);
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
