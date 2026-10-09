/**
 * `events.subscribe`: the second of B1.8's two event transports.
 *
 * The first is the SSE route in `eventstream.ts`. They exist as two rather than
 * one for a reason that is authoritative rather than stylistic: a browser
 * `EventSource` is GET-only, cannot set an `Authorization` header and cannot
 * send a request body, so a **page** cannot consume the SSE route at all. It
 * consumes events over the live-view socket it already holds, and the socket is
 * the only place a credential-free ticket can carry a subscription.
 *
 * ## The socket carries strictly less than SSE, and fails closed
 *
 * A live-view ticket is minted on `view:watch` or `view:control`
 * (`SPECS/API-CONTRACT.md` §4) and carries **no** `mcp:invoke`. `focus`, `input`
 * and `console` are page *content* — the same authority `browser_get_state`
 * needs — so they are never carried here. The set is
 * `WS_EVENT_KINDS`, which `packages/wire` **derives by subtraction** from the
 * content list rather than writing out: a new content kind is withheld from the
 * socket until someone decides it is not content. Until B1.8's socket half
 * existed nothing consumed that derivation, which is why it was recorded as a
 * rule awaiting its transport (SR2-m6). This module is that transport.
 *
 * A subscribe naming a kind the socket cannot carry is answered with a
 * `control {event:'kind-unavailable', kind}` record and the rest of the
 * subscription proceeds. Killing a long-lived socket over one unavailable kind
 * is worse than saying so, and dropping the kind in silence is worse still: the
 * consumer would read the silence that follows as "nothing happened".
 *
 * ## Backpressure: frames drop, events gap
 *
 * A screencast frame is dropped for a slow viewer, because a stale frame is
 * worthless. An event is not: it is the only record that something happened. So
 * when the socket is behind, this pump **stops reading** rather than queueing.
 * The subscriber's cursor stays where it is, the ring turns over underneath it,
 * and the next read that succeeds begins with a `gap` record carrying the exact
 * arithmetic. Loss is reported, never silent, and nothing queues without bound.
 *
 * ## Disconnect is the socket's own close path, never `request.signal`
 *
 * REJ-005 and `SPECS/AGENTS.md` §2: on Deno that signal fires when a *response*
 * is delivered, not when the peer goes away. {@linkcode SocketEventPump.stop}
 * is called from the viewer's single close handler, and is idempotent.
 */
import type { SessionEventRing } from '@tykotech/mcp';
import { formatCursor, parseCursor, type ParsedCursor } from '@tykotech/mcp';
import type { EventKind, EventRecord, ServerMsg } from '@tykotech/wire';
import { WS_EVENT_KINDS } from '@tykotech/wire';
import { MAX_KIND_ECHO_CHARS, MAX_KIND_ENTRIES, MAX_UNAVAILABLE_REPORTED } from './eventstream.ts';

/** The kinds the live-view socket may carry, as a set. Derived, never written out. */
const SOCKET_KINDS: ReadonlySet<string> = new Set(WS_EVENT_KINDS);

/**
 * How long the pump waits on the ring before looping.
 *
 * The socket has its own 15 s keep-alive ping, so this interval exists only to
 * re-check `closed` and the socket's readiness; it does not put anything on the
 * wire.
 */
export const SOCKET_EVENT_IDLE_MS = 15_000;

export interface SocketEventPumpOptions {
	readonly ring: SessionEventRing;
	/** Delivers one message to the socket. */
	readonly send: (message: ServerMsg) => void;
	/**
	 * False while the socket is too far behind to take another record.
	 *
	 * The pump then stops *reading*, which is what turns backpressure into a
	 * `gap` rather than into an unbounded queue.
	 */
	readonly ready: () => boolean;
	/** The kinds this deployment actually has a producer for. */
	readonly producing: ReadonlySet<string>;
	/** Requested kinds; omitted means every kind this transport carries. */
	readonly kinds?: readonly string[];
	/** An opaque `<epoch>:<seq>` cursor. Omitted means from now. */
	readonly since?: string | number;
	readonly idleMs?: number;
	readonly logger?: { warn(message: string): void };
}

/**
 * Resolves a socket subscription's `kinds` request against what this transport
 * carries and what this deployment produces.
 *
 * Both refusals are reported, and they are reported as the same thing: from the
 * consumer's side "this socket will never carry `console`" and "nothing here
 * mints a `dom.settled`" have the same consequence, which is that waiting for
 * one is waiting forever.
 */
export function resolveSocketKinds(
	requested: readonly string[] | undefined,
	producing: ReadonlySet<string>,
): { filter: ReadonlySet<EventKind>; unavailable: string[] } {
	const carried = new Set<EventKind>();
	for (const kind of SOCKET_KINDS) {
		if (producing.has(kind)) carried.add(kind as EventKind);
	}
	if (requested === undefined) return { filter: carried, unavailable: [] };
	const filter = new Set<EventKind>();
	const unavailable = new Set<string>();
	// The same bounds the SSE parser uses, for the same reason: what comes back
	// must be bounded because what went out was chosen by the caller.
	for (const entry of requested.slice(0, MAX_KIND_ENTRIES)) {
		const kind = entry.trim();
		if (kind === '') continue;
		if (!carried.has(kind as EventKind)) {
			if (unavailable.size < MAX_UNAVAILABLE_REPORTED) unavailable.add(kind.slice(0, MAX_KIND_ECHO_CHARS));
			continue;
		}
		filter.add(kind as EventKind);
	}
	return { filter, unavailable: [...unavailable] };
}

/**
 * One socket's event subscription.
 *
 * At most one per socket: a second `events.subscribe` replaces the first rather
 * than opening a second pump, because two pumps on one socket would interleave
 * two cursors into one ordered stream and the ordering is the contract.
 */
export class SocketEventPump {
	readonly #ring: SessionEventRing;
	readonly #send: (message: ServerMsg) => void;
	readonly #ready: () => boolean;
	readonly #filter: ReadonlySet<EventKind>;
	readonly #idleMs: number;
	readonly #logger: { warn(message: string): void } | undefined;
	#cursor: ParsedCursor;
	#stopped = false;
	#armedDomSettled = false;
	/** B2.5 / E-53: this subscription holds the manual dialog claim. */
	#armedDialog = false;

	private constructor(options: SocketEventPumpOptions, filter: ReadonlySet<EventKind>, cursor: ParsedCursor) {
		this.#ring = options.ring;
		this.#send = options.send;
		this.#ready = options.ready;
		this.#filter = filter;
		this.#idleMs = options.idleMs ?? SOCKET_EVENT_IDLE_MS;
		this.#logger = options.logger;
		this.#cursor = cursor;
	}

	/**
	 * Opens a subscription, states its epoch, and starts pumping.
	 *
	 * **The epoch is stated before the pump waits.** The first record is always a
	 * `control {event:'stream-open', epoch, seq}` — the plan's `events.subscribed`
	 * reply, carried as a record rather than as a sixth server message type so
	 * that one fact has one representation on this socket. Without it a client
	 * that legitimately has nothing to receive could never learn which epoch it
	 * is waiting on, which is the original defect in miniature.
	 */
	static open(options: SocketEventPumpOptions): SocketEventPump {
		const { filter, unavailable } = resolveSocketKinds(options.kinds, options.producing);
		const since = options.since === undefined ? undefined : String(options.since);
		const pump = new SocketEventPump(options, filter, parseCursor(since));
		// `dom.settled` costs a read per settle, so the socket arms it on the ring
		// exactly when a subscription names it — mirroring the SSE transport, so a
		// settle is minted while either transport wants it and neither pays for the
		// other. Disarmed in `stop()`, which every exit path calls.
		if (filter.has('dom.settled' as EventKind)) {
			options.ring.armDomSettled();
			pump.#armedDomSettled = true;
		}
		// B2.5 / E-53, mirroring the SSE transport so a dialog is held while *either* transport wants
		// it and neither pays for the other. Disarmed in `stop()`, which every exit path calls.
		if (filter.has('dialog' as EventKind)) {
			options.ring.armDialog();
			pump.#armedDialog = true;
		}
		pump.#emit({
			kind: 'control',
			seq: options.ring.highWaterMark,
			at: new Date().toISOString(),
			tab_id: null,
			payload: { event: 'stream-open', epoch: options.ring.epoch, seq: options.ring.highWaterMark },
		});
		for (const kind of unavailable) {
			pump.#emit({
				kind: 'control',
				seq: options.ring.highWaterMark,
				at: new Date().toISOString(),
				tab_id: null,
				payload: { event: 'kind-unavailable', kind },
			});
		}
		void pump.#run();
		return pump;
	}

	/** The cursor this subscription would resume from. Exposed for tests. */
	get cursor(): string {
		return this.#cursor.kind === 'cursor' ? formatCursor(this.#cursor.epoch, this.#cursor.seq) : '';
	}

	/** True once {@linkcode SocketEventPump.stop} has run. */
	get stopped(): boolean {
		return this.#stopped;
	}

	/** Ends the subscription. Idempotent, and every exit path calls it. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#armedDomSettled) {
			this.#armedDomSettled = false;
			this.#ring.disarmDomSettled();
		}
		if (this.#armedDialog) {
			this.#armedDialog = false;
			this.#ring.disarmDialog();
		}
	}

	#emit(record: EventRecord): void {
		this.#send({ type: 'event', event: record });
	}

	async #run(): Promise<void> {
		try {
			while (!this.#stopped && !this.#ring.closed) {
				// A socket that is behind stops the *read*, so the ring turns over
				// under a stationary cursor and the next successful read leads with a
				// `gap`. Reading and queueing would trade a reported loss for an
				// unbounded buffer.
				if (!this.#ready()) {
					await this.#ring.next(this.#idleMs);
					continue;
				}
				// The mark is taken before the read so a record appended during it is
				// re-seen rather than skipped, and the cursor advances to whichever of
				// the mark and the highest delivered `seq` is greater — `read` mints
				// `rate-capped` records as it rolls the window and those land above
				// the mark, so advancing to the mark alone would redeliver them.
				const mark = this.#ring.highWaterMark;
				const records = this.#ring.read(this.#cursor, this.#filter);
				let delivered = mark;
				for (const entry of records) delivered = Math.max(delivered, entry.seq);
				this.#cursor = { kind: 'cursor', epoch: this.#ring.epoch, seq: delivered };
				if (records.length > 0) {
					for (const entry of records) {
						if (this.#stopped) return;
						this.#emit(entry);
					}
					continue;
				}
				await this.#ring.next(this.#idleMs);
			}
			if (!this.#stopped && this.#ring.closed) {
				this.#emit({
					kind: 'bye',
					seq: this.#ring.highWaterMark,
					at: new Date().toISOString(),
					tab_id: null,
					payload: { reason: 'session-closed' },
				});
			}
		} catch (cause) {
			// A throw here must not leave the subscription looking live: the viewer's
			// close path is the only other thing that stops it, and it may never run.
			this.#logger?.warn(`socket event pump failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			this.stop();
		}
	}
}
