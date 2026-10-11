/**
 * MCP Apps streams beyond the browser: the **terminal** of a live sandbox shell session and the **live A2UI surface**,
 * served to their embeds exactly the way the live view is served to its own (R9, design §2.20, D-134/D-135).
 *
 * The browser's live view is a ticket-gated WebSocket an embed opens after minting a single-use, origin-bound,
 * 30-second ticket through an app-only tool. Tools whose output is something a person watches — a shell, a surface an
 * agent keeps updating — get the same transport rather than a second one with different rules:
 *
 * - **Mint.** `sandbox_session_ticket` / `a2ui_surface_ticket` (app-only, `ui_resources.ts`) call
 *   {@linkcode EmbedStreams.mintTerminal} / {@linkcode EmbedStreams.mintSurface}. The origin passes the very gate the
 *   live-view mint uses (`embedOriginGate` in `mcp_apps.ts`); the target must exist and belong to the caller now; the
 *   ticket is bound to the origin, the kind and the target, lives 30 s and redeems once.
 * - **Socket.** `/live/terminal/:id/ws` and `/live/surface/:id/ws`, under the `/live/` prefix so the bearer gate, the
 *   per-request rate limit and drain treat them as they treat the live-view socket: the ticket is the credential,
 *   presented once at upgrade together with the `Origin` it is bound to. The front's Host/Origin checks still run.
 * - **Authority.** A ticket carries the minting credential's owner, scopes and GW-1 fingerprint, and the socket
 *   re-earns them on the gateway's horizon ({@linkcode EVENT_STREAM_REVALIDATE_MS}) and on every credential change
 *   (`revalidateAll`), ending at {@linkcode EVENT_STREAM_LIFETIME_MS} like every other long-lived stream (GW-3); the
 *   embed reconnects with a fresh ticket. Each socket holds one of the principal's long-lived connection slots, the
 *   ceiling it shares with the live view and the event streams.
 *
 * The terminal is interactive (`input` messages are fed to the shell: the minting credential holds
 * `sandbox:execute`, which is exactly the authority `sandbox_session_input` needs). The surface is read-only, as the
 * A2UI embed always was: no action registration reaches it and nothing it sends is read.
 *
 * Messages are JSON text frames. Server → embed: `meta`, `output {seq, data, gap}`, `end {exit_code, killed}`
 * (terminal); `meta`, `surface {surface}`, `removed` (surface); `ping`, `error {code, message}` and
 * `bye {reason}` on both. Embed → server: `input {data}` (terminal only).
 *
 * @module
 */
import type { Context, Hono } from 'hono';
import type { SandboxClient } from '@tykotech/sandbox';
import { SandboxClientError } from '@tykotech/sandbox';
import { ToolError } from '@tykotech/mcp';
import type { A2uiSurface } from '@tykotech/wire';
import type { AppVariables } from './app.ts';
import type { A2uiStore } from './a2ui.ts';
import { EVENT_STREAM_LIFETIME_MS, EVENT_STREAM_REVALIDATE_MS } from './eventstream.ts';
import { HttpProblem, problemResponse } from './problem.ts';
import { TICKET_TTL_MS, TicketStore } from './tickets.ts';

/** The two stream kinds; each has its own socket path and its own scope. */
export type EmbedStreamKind = 'terminal' | 'surface';

/** The socket path of a stream, relative to the public URL. */
export function embedStreamPath(kind: EmbedStreamKind, id: string): string {
	return `/live/${kind}/${encodeURIComponent(id)}/ws`;
}

/** The scope a kind's ticket and socket need, beyond the `mcp:invoke` the minting tool call already proved. */
const KIND_SCOPE: Readonly<Record<EmbedStreamKind, string>> = {
	terminal: 'sandbox:execute',
	surface: 'a2ui:publish',
};

/** Largest input frame the terminal accepts, which is `sandbox_session_input`'s own bound. */
export const TERMINAL_INPUT_MAX_CHARS = 16_384;
/** How long one sandbox long-poll waits: the service's ceiling. */
const TERMINAL_READ_WAIT_MS = 10_000;
/** A keepalive a reverse proxy sees inside its idle timeout; the embed ignores it. */
const PING_INTERVAL_MS = 25_000;
/** Largest frame a client may send; anything above closes the socket (1009). */
const MAX_CLIENT_FRAME_CHARS = TERMINAL_INPUT_MAX_CHARS + 256;

/** Who minted a ticket, carried to its socket and re-checked there. */
export interface EmbedStreamCaller {
	/** The principal id: the per-principal connection ceiling and the origin overlay count it. */
	readonly principal: string;
	/** The resource owner (`expansionOwner`), whose sandbox sessions and surfaces the stream reads. */
	readonly owner: string;
	readonly scopes: ReadonlySet<string>;
	/** GW-1: the credential fingerprint, re-checked by {@linkcode EmbedStreamsOptions.authorize}. */
	readonly credential?: string;
}

/** What an embed stream ticket tool returns. */
export interface EmbedStreamTicket {
	readonly ticket: string;
	readonly ws_url: string;
	/** The session or surface the ticket opens. */
	readonly id: string;
	/** Seconds until the ticket expires. */
	readonly expires_in: number;
	readonly origin_bound: string;
}

export interface EmbedStreamsOptions {
	/** `wss://host[:port]` of `TTK_PUBLIC_URL` (`socketOrigin`), the one origin the embeds may connect to. */
	readonly socketBase: string;
	/** `embedOriginGate`: throws `invalid-arguments` for an origin that may not hold a ticket. */
	readonly admitOrigin: (principal: string, origin: string) => void;
	readonly sandbox?: SandboxClient;
	readonly surfaces?: A2uiStore;
	/** The long-lived connection ceiling shared with the live view and event streams. */
	readonly connections?: { admitPrincipal(principal: string): boolean; releasePrincipal(principal: string): void };
	/** GW-1: the scopes the credential still holds, or `null` once it is gone; absent keeps the minted scopes. */
	readonly authorize?: (owner: string, scopes: ReadonlySet<string>, credential: string | undefined) =>
		| ReadonlySet<string>
		| null;
	readonly logger?: { warn(message: string): void };
	/** Overrides for tests. */
	readonly revalidateMs?: number;
	readonly lifetimeMs?: number;
	readonly pingMs?: number;
}

interface Grant {
	readonly kind: EmbedStreamKind;
	readonly caller: EmbedStreamCaller;
	readonly expiresAt: number;
}

/** One open stream socket, as the revalidation and shutdown paths see it. */
interface OpenStream {
	check(): void;
	end(reason: string): void;
}

/** The terminal and surface streams: their tickets, their sockets and their re-checks. */
export class EmbedStreams {
	readonly #options: EmbedStreamsOptions;
	readonly #tickets = new TicketStore();
	/** What each live ticket was minted for; the store itself knows only principal, target and origin. */
	readonly #grants = new Map<string, Grant>();
	readonly #open = new Set<OpenStream>();
	#closed = false;

	constructor(options: EmbedStreamsOptions) {
		this.#options = options;
	}

	/** Whether a kind can be offered on this deployment. */
	offers(kind: EmbedStreamKind): boolean {
		return kind === 'terminal' ? this.#options.sandbox !== undefined : this.#options.surfaces !== undefined;
	}

	/** Streams open right now. */
	get size(): number {
		return this.#open.size;
	}

	#mint(kind: EmbedStreamKind, caller: EmbedStreamCaller, id: string, origin: string): EmbedStreamTicket {
		if (this.#closed) throw new ToolError('feature-unavailable', 'the server is shutting down');
		if (!caller.scopes.has(KIND_SCOPE[kind])) {
			throw new ToolError('scope-required', `this credential cannot open this ${kind} stream`);
		}
		this.#options.admitOrigin(caller.principal, origin);
		const now = Date.now();
		for (const [ticket, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(ticket);
		const record = this.#tickets.mint(caller.principal, `${kind}:${id}`, 'watch', { origin, ttlMs: TICKET_TTL_MS });
		this.#grants.set(record.ticket, { kind, caller, expiresAt: record.expiresAt });
		return {
			ticket: record.ticket,
			ws_url: new URL(embedStreamPath(kind, id), this.#options.socketBase).href,
			id,
			expires_in: Math.round(record.ttlMs / 1000),
			origin_bound: origin,
		};
	}

	/** Mints a terminal ticket for one of the caller's live shell sessions (`sandbox_session_ticket`). */
	async mintTerminal(caller: EmbedStreamCaller, sessionId: string, origin: string): Promise<EmbedStreamTicket> {
		const sandbox = this.#options.sandbox;
		if (sandbox === undefined) throw new ToolError('feature-unavailable', 'no coding sandbox is configured');
		try {
			// An ownership probe that reads nothing: past every byte, without waiting. Another owner's session and an
			// unknown id both answer `no_session`.
			await sandbox.call(caller.owner, 'session_read', {
				session_id: sessionId,
				after: Number.MAX_SAFE_INTEGER,
				wait_ms: 0,
			});
		} catch (cause) {
			if (cause instanceof SandboxClientError && (cause.code === 'no_session' || cause.code === 'invalid_request')) {
				throw new ToolError('invalid-arguments', `you have no live shell session ${JSON.stringify(sessionId)}`);
			}
			throw new ToolError('feature-unavailable', 'the coding sandbox did not answer; try again shortly');
		}
		return this.#mint('terminal', caller, sessionId, origin);
	}

	/** Mints a surface ticket for one of the caller's A2UI surfaces (`a2ui_surface_ticket`). */
	mintSurface(caller: EmbedStreamCaller, surfaceId: string, origin: string): Promise<EmbedStreamTicket> {
		const surfaces = this.#options.surfaces;
		if (surfaces === undefined) return Promise.reject(new ToolError('feature-unavailable', 'A2UI is not configured'));
		try {
			surfaces.get(caller.owner, surfaceId);
		} catch {
			return Promise.reject(
				new ToolError('invalid-arguments', `you have no A2UI surface ${JSON.stringify(surfaceId)}`),
			);
		}
		try {
			return Promise.resolve(this.#mint('surface', caller, surfaceId, origin));
		} catch (cause) {
			return Promise.reject(cause);
		}
	}

	/** Registers both sockets. Call once, on the gateway app. */
	attach(app: Hono<{ Variables: AppVariables }>): void {
		for (const kind of ['terminal', 'surface'] as const) {
			app.get(`/live/${kind}/:id/ws`, (c: Context) => this.#upgrade(c, kind));
		}
	}

	#upgrade(c: Context, kind: EmbedStreamKind): Response {
		const requestId = c.get('requestId');
		// F2, as the live view: a request that is not an upgrade cannot burn a ticket.
		if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a WebSocket upgrade', { status: 426 });
		}
		if (!this.offers(kind) || this.#closed) return problemResponse('not-found', requestId);
		const id = c.req.param('id') ?? '';
		const url = new URL(c.req.url);
		const ticket = url.searchParams.get('ticket') ?? '';
		const redemption = this.#tickets.redeem(ticket, `${kind}:${id}`, c.req.header('origin') ?? null);
		const grant = this.#grants.get(ticket);
		this.#grants.delete(ticket);
		if (!redemption.ok || grant === undefined || grant.kind !== kind) {
			const reason = redemption.ok ? 'unknown' : redemption.reason;
			const slug = reason === 'consumed'
				? 'ticket-consumed'
				: reason === 'expired'
				? 'ticket-expired'
				: reason === 'origin-mismatch'
				? 'origin-forbidden'
				: 'ticket-invalid';
			return problemResponse(slug, requestId, `${kind} stream ticket ${reason}`);
		}
		const caller = grant.caller;
		// The minting decision is re-earned now, not trusted for the 30 s the ticket lived.
		if (this.#scopesNow(caller)?.has(KIND_SCOPE[kind]) !== true) {
			return problemResponse('forbidden-scope', requestId, 'the credential that minted this ticket no longer may');
		}
		let surface: A2uiSurface | null = null;
		if (kind === 'surface') {
			try {
				surface = this.#options.surfaces!.get(caller.owner, id);
			} catch {
				return problemResponse('not-found', requestId, 'no such surface');
			}
		}
		const connections = this.#options.connections;
		// Reserved synchronously, before the upgrade, as the live view does: a later increment admits every racing upgrade.
		if (connections !== undefined && !connections.admitPrincipal(caller.principal)) {
			return problemResponse('rate-limited', requestId, 'too many live connections for this principal', {
				'retry-after': '5',
			});
		}
		let upgraded: { socket: WebSocket; response: Response };
		try {
			upgraded = Deno.upgradeWebSocket(c.req.raw);
		} catch (cause) {
			connections?.releasePrincipal(caller.principal);
			throw cause;
		}
		const after = Number(url.searchParams.get('after') ?? '0');
		const start = Number.isSafeInteger(after) && after >= 0 ? after : 0;
		if (kind === 'terminal') this.#terminal(upgraded.socket, caller, id, start);
		else this.#surface(upgraded.socket, caller, id, surface!);
		return upgraded.response;
	}

	#scopesNow(caller: EmbedStreamCaller): ReadonlySet<string> | null {
		const authorize = this.#options.authorize;
		if (authorize === undefined) return caller.scopes;
		try {
			return authorize(caller.owner, caller.scopes, caller.credential);
		} catch {
			return null;
		}
	}

	/**
	 * The parts every stream socket shares: the open-set entry, the re-check, the lifetime, the keepalive, and one
	 * release path that runs exactly once however the socket ends.
	 */
	#lifecycle(socket: WebSocket, caller: EmbedStreamCaller, kind: EmbedStreamKind, onEnd: () => void): {
		send(message: Record<string, unknown>): void;
		end(reason: string | null, code?: number): void;
		readonly ended: boolean;
	} {
		let ended = false;
		const send = (message: Record<string, unknown>): void => {
			if (ended || socket.readyState !== WebSocket.OPEN) return;
			try {
				socket.send(JSON.stringify(message));
			} catch { /* the peer is gone; the close event releases */ }
		};
		const release = (): void => {
			if (ended) return;
			ended = true;
			clearInterval(recheck);
			clearInterval(ping);
			clearTimeout(lifetime);
			this.#open.delete(entry);
			this.#options.connections?.releasePrincipal(caller.principal);
			try {
				onEnd();
			} catch { /* releasing the source never fails the socket */ }
		};
		const end = (reason: string | null, code = 1000): void => {
			if (ended) return;
			if (reason !== null) send({ type: 'bye', reason });
			release();
			try {
				socket.close(code, reason ?? undefined);
			} catch { /* already closing */ }
		};
		const entry: OpenStream = {
			check: (): void => {
				if (this.#scopesNow(caller)?.has(KIND_SCOPE[kind]) !== true) end('unauthorized', 4001);
			},
			end: (reason: string): void => end(reason, 1001),
		};
		const recheck = setInterval(entry.check, this.#options.revalidateMs ?? EVENT_STREAM_REVALIDATE_MS);
		const ping = setInterval(() => send({ type: 'ping' }), this.#options.pingMs ?? PING_INTERVAL_MS);
		const lifetime = setTimeout(() => end('stream-expired'), this.#options.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS);
		Deno.unrefTimer(recheck);
		Deno.unrefTimer(ping);
		Deno.unrefTimer(lifetime);
		this.#open.add(entry);
		socket.addEventListener('close', release);
		socket.addEventListener('error', release);
		return {
			send,
			end,
			get ended(): boolean {
				return ended;
			},
		};
	}

	#terminal(socket: WebSocket, caller: EmbedStreamCaller, sessionId: string, start: number): void {
		const sandbox = this.#options.sandbox!;
		let after = start;
		const life = this.#lifecycle(socket, caller, 'terminal', () => {});
		/** Inputs are fed one at a time, in order: two overlapping calls could reach the shell reordered. */
		let feeding: Promise<void> = Promise.resolve();
		const pump = async (): Promise<void> => {
			while (!life.ended) {
				let read: Record<string, unknown>;
				try {
					read = await sandbox.call(caller.owner, 'session_read', {
						session_id: sessionId,
						after,
						wait_ms: TERMINAL_READ_WAIT_MS,
					});
				} catch (cause) {
					const code = cause instanceof SandboxClientError ? cause.code : 'unavailable';
					life.send({ type: 'error', code, message: 'the shell session could not be read' });
					life.end(code === 'no_session' ? 'session-closed' : 'unavailable');
					return;
				}
				if (life.ended) return;
				const output = typeof read.output === 'string' ? read.output : '';
				const seq = typeof read.seq === 'number' && Number.isSafeInteger(read.seq) ? read.seq : after;
				if (output !== '' || read.gap === true) {
					life.send({ type: 'output', seq, data: output, gap: read.gap === true });
				}
				after = seq;
				if (read.ended === true) {
					life.send({ type: 'end', exit_code: read.exit_code ?? null, killed: read.killed ?? null });
					life.end('session-ended');
					return;
				}
			}
		};
		socket.addEventListener('open', () => {
			life.send({ type: 'meta', kind: 'terminal', session_id: sessionId, interactive: true, after });
			void pump();
		});
		socket.addEventListener('message', (event: MessageEvent) => {
			const raw = event.data;
			if (typeof raw !== 'string' || raw.length > MAX_CLIENT_FRAME_CHARS) {
				life.end('frame-too-large', 1009);
				return;
			}
			let message: unknown;
			try {
				message = JSON.parse(raw);
			} catch {
				life.send({ type: 'error', code: 'invalid-message', message: 'frames are JSON text' });
				return;
			}
			const { type, data } = (message ?? {}) as { type?: unknown; data?: unknown };
			if (type !== 'input') return;
			if (typeof data !== 'string' || data.length === 0 || data.length > TERMINAL_INPUT_MAX_CHARS) {
				life.send({
					type: 'error',
					code: 'invalid-message',
					message: `input data must be 1 to ${TERMINAL_INPUT_MAX_CHARS} characters`,
				});
				return;
			}
			feeding = feeding.then(async () => {
				if (life.ended) return;
				try {
					await sandbox.call(caller.owner, 'session_input', { session_id: sessionId, data });
				} catch (cause) {
					const code = cause instanceof SandboxClientError ? cause.code : 'unavailable';
					life.send({ type: 'error', code, message: 'the input did not reach the shell' });
				}
			});
		});
	}

	#surface(socket: WebSocket, caller: EmbedStreamCaller, surfaceId: string, initial: A2uiSurface): void {
		let unwatch: (() => void) | null = null;
		const life = this.#lifecycle(socket, caller, 'surface', () => unwatch?.());
		socket.addEventListener('open', () => {
			life.send({ type: 'meta', kind: 'surface', surface_id: surfaceId, interactive: false });
			try {
				// The snapshot is re-read at open, so a change between the upgrade and now is not lost.
				const current = this.#options.surfaces!.get(caller.owner, surfaceId);
				life.send({ type: 'surface', surface: current });
				unwatch = this.#options.surfaces!.watch(caller.owner, surfaceId, (surface) => {
					if (surface === null) {
						life.send({ type: 'removed', surface_id: surfaceId });
						life.end('surface-removed');
					} else life.send({ type: 'surface', surface });
				});
			} catch (cause) {
				if (cause instanceof HttpProblem && cause.slug === 'rate-limited') {
					life.send({ type: 'error', code: 'rate-limited', message: 'too many surface streams are open' });
					life.end('rate-limited', 1013);
					return;
				}
				life.send({ type: 'surface', surface: initial });
				life.send({ type: 'removed', surface_id: surfaceId });
				life.end('surface-removed');
			}
		});
		// Read-only: anything the embed sends is ignored rather than read.
	}

	/** Re-checks every open stream now: a key reload or a logout must not wait for the next tick. */
	revalidateAll(): void {
		for (const entry of [...this.#open]) entry.check();
	}

	/** Ends every open stream and refuses new tickets; called at shutdown. */
	closeAll(): void {
		this.#closed = true;
		for (const entry of [...this.#open]) entry.end('server-shutdown');
		this.#grants.clear();
	}
}
