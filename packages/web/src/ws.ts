/**
 * The live-view WebSocket client.
 *
 * Validates every inbound control message against the shared wire schema, so a
 * malformed or hostile frame is rejected at the boundary rather than partway
 * through a render.
 */
import { type ClientMsg, decodeFrame, type FrameMeta, type ServerMsg, ServerMsgSchema } from '@tykotech/wire';

export interface LiveViewEvents {
	onMeta(message: Extract<ServerMsg, { type: 'meta' }>): void;
	onTabs(tabs: Extract<ServerMsg, { type: 'tabs' }>['tabs']): void;
	onLock(lock: Extract<ServerMsg, { type: 'lock' }>['lock']): void;
	onState(url: string, title: string): void;
	onError(code: string, message: string): void;
	onFrame(meta: FrameMeta, jpeg: Uint8Array): void;
	onClosed(reason: string): void;
	/** Session event records, delivered only after the socket sends `events.subscribe`. */
	onEvent?(event: Extract<ServerMsg, { type: 'event' }>['event']): void;
}

export class LiveViewSocket {
	readonly #socket: WebSocket;
	readonly #events: LiveViewEvents;
	#lastSeq = 0;
	#gaps = 0;
	#frames = 0;

	constructor(url: string, events: LiveViewEvents) {
		this.#events = events;
		this.#socket = new WebSocket(url);
		this.#socket.binaryType = 'arraybuffer';
		this.#socket.onmessage = (event) => this.#onMessage(event);
		this.#socket.onclose = (event) => this.#events.onClosed(event.reason || 'connection closed');
		this.#socket.onerror = () => this.#events.onError('internal', 'the connection failed');
	}

	/** Frames received and the number of gaps in their sequence. */
	get stats(): { frames: number; gaps: number } {
		return { frames: this.#frames, gaps: this.#gaps };
	}

	get open(): boolean {
		return this.#socket.readyState === WebSocket.OPEN;
	}

	send(message: ClientMsg): void {
		if (!this.open) return;
		this.#socket.send(JSON.stringify(message));
	}

	close(): void {
		try {
			this.#socket.close(1000, 'client closed');
		} catch {
			// Already closing.
		}
	}

	#onMessage(event: MessageEvent): void {
		if (typeof event.data !== 'string') {
			try {
				const { meta, jpeg } = decodeFrame(event.data as ArrayBuffer);
				this.#frames += 1;
				// Gaps are informational: frames are dropped deliberately when a
				// viewer falls behind, so a gap is backpressure, not corruption.
				if (this.#lastSeq !== 0 && meta.seq > this.#lastSeq + 1) this.#gaps += meta.seq - this.#lastSeq - 1;
				this.#lastSeq = meta.seq;
				this.#events.onFrame(meta, jpeg);
			} catch {
				this.#events.onError('internal', 'a malformed frame was discarded');
			}
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return;
		}
		// The server's keep-alive must be answered, not merely tolerated (F1).
		//
		// It is an application-level JSON frame rather than a WebSocket control
		// frame, so the browser does not reply for us. Dropping it — which this
		// line used to do — left a viewer that only *watches* sending nothing at
		// all, and the server closed it as unresponsive on a fixed timer. The
		// answer is what keeps a watching view open indefinitely.
		if ((parsed as { type?: string }).type === 'ping') {
			this.send({ type: 'pong' });
			return;
		}

		const result = ServerMsgSchema.safeParse(parsed);
		if (!result.success) return;
		const message = result.data;

		switch (message.type) {
			case 'meta':
				this.#events.onMeta(message);
				return;
			case 'tabs':
				this.#events.onTabs(message.tabs);
				return;
			case 'lock':
				this.#events.onLock(message.lock);
				return;
			case 'state':
				this.#events.onState(message.url, message.title);
				return;
			case 'error':
				this.#events.onError(message.code, message.message);
				return;
			case 'event':
				this.#events.onEvent?.(message.event);
				return;
			case 'bye':
				this.#events.onClosed(message.reason);
				return;
		}
	}
}
