/**
 * The socket half the terminal and surface embeds share (`embed_terminal.ts`, `embed_a2ui.ts`): the same transport
 * the live-view embed uses for the browser, so a shell or a surface reaches the person exactly as a page does.
 *
 * Each open mints a single-use, origin-bound 30-second ticket through an app-only tool (the host proxies the call over
 * its own MCP connection) and opens the `ws_url` it names. A dropped connection reconnects with the control plane's
 * backoff — 750 ms doubling to 15 s inside a ten-minute window — minting a fresh ticket each time; a socket the server
 * refuses before its first message is not retried (a refused origin stays refused), and neither is a farewell the
 * server meant as final. Nothing opens until {@linkcode EmbedStream.start} is called, which the embeds do on a click.
 */
import { type EmbedBridge, toolErrorOf } from './embed_bridge.ts';

const RECONNECT_BASE_MS = 750;
const RECONNECT_MAX_MS = 15_000;
const RECOVERY_WINDOW_MS = 600_000;

/** One parsed server message; `type` says which. */
export type StreamMessage = Readonly<Record<string, unknown>> & { readonly type: string };

/** What the embed hears from its stream. */
export interface EmbedStreamHandlers {
	/** Every server message but `ping`. */
	onMessage(message: StreamMessage): void;
	/** `connecting`, `live` (first message arrived), `reconnecting` (with the reason), or `idle` after a stop. */
	onPhase(phase: 'connecting' | 'live' | 'reconnecting' | 'idle', detail?: string): void;
	/** The stream ended and will not reconnect: refused, final, or out of recovery time. */
	onEnded(code: string, text: string, retryable: boolean): void;
}

export interface EmbedStreamOptions {
	readonly bridge: Pick<EmbedBridge, 'callTool'>;
	/** The app-only tool that mints the ticket, and its arguments other than `origin`. */
	readonly ticketTool: string;
	readonly ticketArgs: () => Record<string, unknown>;
	/** Extra query parameters for a (re)connect, e.g. the terminal's `after` offset. */
	readonly query?: () => Record<string, string>;
	/** `bye` reasons after which reconnecting would argue with the server. */
	readonly finalReasons: ReadonlySet<string>;
	readonly handlers: EmbedStreamHandlers;
}

/** A ticket refused by the server, kept apart from a host failure so the two read differently. */
class TicketRefused extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

/** One embed's stream: start on a click, stop on Stop, teardown or hiding. */
export class EmbedStream {
	readonly #options: EmbedStreamOptions;
	#socket: WebSocket | null = null;
	#wanted = false;
	#attempt = 0;
	#deadline: number | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	/** Bumped by every open and stop, so a mint or socket that outlived its press is ignored. */
	#generation = 0;

	constructor(options: EmbedStreamOptions) {
		this.#options = options;
	}

	/** Whether the user wants the stream (between start and stop). */
	get active(): boolean {
		return this.#wanted;
	}

	/** Sends one JSON message on the open socket; false when there is none. */
	send(message: Record<string, unknown>): boolean {
		const socket = this.#socket;
		if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(message));
		return true;
	}

	start(): void {
		this.#wanted = true;
		this.#attempt = 0;
		this.#deadline = null;
		void this.#open();
	}

	stop(): void {
		this.#wanted = false;
		this.#generation += 1;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#close();
		this.#options.handlers.onPhase('idle');
	}

	#close(): void {
		const socket = this.#socket;
		this.#socket = null;
		try {
			socket?.close();
		} catch { /* already closed */ }
	}

	#end(code: string, text: string, retryable: boolean): void {
		this.#wanted = false;
		this.#close();
		this.#options.handlers.onEnded(code, text, retryable);
	}

	async #open(): Promise<void> {
		const mine = ++this.#generation;
		this.#close();
		const { bridge, ticketTool, ticketArgs, handlers } = this.#options;
		handlers.onPhase(this.#attempt === 0 ? 'connecting' : 'reconnecting');
		let ticket: string;
		let wsUrl: string;
		try {
			const result = await bridge.callTool(ticketTool, { ...ticketArgs(), origin: location.origin });
			const refused = toolErrorOf(result);
			if (refused !== null) throw new TicketRefused(refused.code, refused.message);
			const data = result.structuredContent?.result as Record<string, unknown> | undefined;
			if (typeof data?.ticket !== 'string' || typeof data.ws_url !== 'string') {
				throw new TicketRefused('invalid-result', 'the server answered without a usable ticket');
			}
			ticket = data.ticket;
			wsUrl = data.ws_url;
		} catch (cause) {
			if (mine !== this.#generation) return;
			const code = cause instanceof TicketRefused ? cause.code : 'host-error';
			const text = cause instanceof Error ? cause.message : 'the host did not relay the call';
			// An origin the server does not admit is refused however often it is asked.
			this.#end(code, text, !(code === 'invalid-arguments' && /origin/i.test(text)));
			return;
		}
		if (mine !== this.#generation) return;
		const url = new URL(wsUrl);
		url.searchParams.set('ticket', ticket);
		for (const [key, value] of Object.entries(this.#options.query?.() ?? {})) url.searchParams.set(key, value);
		let reached = false;
		let farewell: string | null = null;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url.href);
		} catch {
			this.#end('connection-refused', 'the stream socket could not be opened', false);
			return;
		}
		this.#socket = socket;
		socket.addEventListener('message', (event: MessageEvent) => {
			if (socket !== this.#socket || typeof event.data !== 'string') return;
			let message: StreamMessage;
			try {
				message = JSON.parse(event.data) as StreamMessage;
			} catch {
				return;
			}
			if (typeof message?.type !== 'string') return;
			if (!reached) {
				reached = true;
				this.#attempt = 0;
				this.#deadline = null;
				handlers.onPhase('live');
			}
			if (message.type === 'ping') return;
			if (message.type === 'bye') farewell = typeof message.reason === 'string' ? message.reason : 'closed';
			handlers.onMessage(message);
		});
		socket.addEventListener('close', () => {
			if (socket !== this.#socket) return;
			this.#socket = null;
			if (!this.#wanted) return;
			if (!reached) {
				this.#end(
					'connection-refused',
					'the stream socket was refused before it opened; the host’s origin may not be admitted ' +
						'(TTK_ALLOWED_ORIGINS), or this credential holds too many live connections',
					false,
				);
				return;
			}
			if (farewell !== null && this.#options.finalReasons.has(farewell)) {
				this.#end(farewell, `the server ended this stream: ${farewell}`, true);
				return;
			}
			this.#reconnect(farewell ?? 'connection lost');
		});
	}

	#reconnect(reason: string): void {
		if (this.#deadline === null) this.#deadline = Date.now() + RECOVERY_WINDOW_MS;
		const remaining = this.#deadline - Date.now();
		if (remaining <= 0) {
			this.#end('unavailable', `no connection could be re-established in ten minutes; last reason: ${reason}`, true);
			return;
		}
		this.#attempt += 1;
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.#attempt - 1), RECONNECT_MAX_MS, remaining);
		this.#options.handlers.onPhase('reconnecting', `${reason}; retrying in ${Math.max(1, Math.round(delay / 1000))} s`);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			if (this.#wanted) void this.#open();
		}, delay);
	}
}
