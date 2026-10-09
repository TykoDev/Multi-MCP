/**
 * The SSE event transport: `GET /api/v1/sessions/{id}/events` (B1.8).
 *
 * One of two views of the per-session event ring that leave this process. The
 * other is the live-view WebSocket, and they exist as two rather than one for a
 * reason that is authoritative rather than stylistic: a browser `EventSource`
 * is GET-only, cannot set an `Authorization` header, and cannot send a request
 * body. So this route is for a **non-browser** consumer using `fetch()` plus
 * `response.body.getReader()`, and a page consumes events over the socket
 * instead. **No ticket path is added here**: a ticket in a query string is a
 * credential in a URL, which D-014 rejected.
 *
 * ## Scope is `mcp:invoke`, deliberately not `view:watch`
 *
 * The stream carries page content, which is the same authority
 * `browser_get_state` needs. `SPECS/API-CONTRACT.md` route 14 settles the
 * identical question for downloaded files in exactly these words — *"watching a
 * browser is not permission to carry off its documents"*. Watching a browser is
 * permission to see pixels.
 *
 * ## Backpressure: frames drop, events gap
 *
 * The response body is a `ReadableStream` whose `pull` drains the ring from the
 * subscriber's cursor and waits on the ring's notification when caught up. A
 * slow consumer simply stops pulling, its cursor falls behind, and when it
 * falls off the ring's tail the next pull emits a `gap`. There is no queue
 * anywhere to grow without bound.
 *
 * ## Disconnect is `cancel()`, never `request.signal`
 *
 * REJ-005, `SPECS/AGENTS.md` §2, and the live view's own restatement at
 * `liveview.ts`: on Deno that signal fires when a *response* is delivered, not
 * when the peer goes away. `cancel()` is what deregisters the subscriber,
 * decrements both counters and decrements the `console` refcount, and the same
 * release runs on every other exit path — an expiry, a closed session, a
 * shutdown, or a throw inside `pull`.
 */
import type { Context, Hono } from 'hono';
import type { SessionRegistry } from '@tykotech/mcp';
import { formatCursor, parseCursor, type ParsedCursor } from '@tykotech/mcp';
import {
	EVENT_KINDS,
	type EventByeReason,
	type EventKind,
	type EventRecord,
	SSE_ONLY_EVENT_KINDS,
} from '@tykotech/wire';
import { type Cluster, FORWARDED_HEADER } from './cluster.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { problemResponse } from './problem.ts';
import { forward } from './routing.ts';
import type { AppVariables } from './app.ts';
import { expansionOwner, type Principal } from './auth.ts';

/**
 * Event streams one session may carry.
 *
 * **This is its own counter and must not be merged with `TTK_MAX_VIEWERS`.**
 * `SPECS/OVERVIEW.md` promises the live view exists "so a human can watch and
 * take over **any** session an MCP client is driving", and a shared budget makes
 * the word *any* false: a worker holding four streams would exhaust the viewer
 * seats and the human would be refused with what reads as ordinary capacity
 * while the real cause is a machine consumer it cannot see. Two separately
 * bounded counters bound total resource exactly as well as one shared counter,
 * so sharing buys nothing and costs the invariant. Consolidating them later
 * would be the same shape as E-19 and E-30 — a tidy simplification that reads
 * correctly and changes what the value means.
 *
 * Four is derived: one worker stream plus a second legitimate consumer, each
 * able to double transiently during a reconnect handover. It is a fixed
 * documented constant, not a new `TTK_*` name, per the house rule that set the
 * E-33 download caps: a `TTK_*` name is frozen the moment it ships.
 */
export const MAX_EVENT_STREAMS_PER_SESSION = 4;

/**
 * Long-lived connections one principal may hold across every session — event
 * streams and live-view sockets **together**.
 *
 * `SPECS/API-CONTRACT.md` §7 has published "Concurrent WS viewers per principal
 * | 8" since 0.1.0 and **no code enforced it**: `liveview.ts` counted viewers
 * per session only, and a repository-wide search for a per-principal counter
 * found nothing. So this is not a new limit, it is the published one becoming
 * true — and it is shared rather than duplicated because two independent
 * ceilings would disagree about what one principal is allowed to hold.
 *
 * Deliberately **not** shared with the per-session counters, which stay apart
 * for the reason `MAX_EVENT_STREAMS_PER_SESSION` gives.
 */
export const MAX_CONNECTIONS_PER_PRINCIPAL = 8;

/** @deprecated Retained for the published name; use {@linkcode MAX_CONNECTIONS_PER_PRINCIPAL}. */
export const MAX_EVENT_STREAMS_PER_PRINCIPAL = MAX_CONNECTIONS_PER_PRINCIPAL;

/**
 * How long a stream may live before it is terminated with `stream-expired`.
 *
 * **This is not resource management.** `SPECS/SECURITY-AUTH.md` §2.1 states that
 * revocation "takes effect next request (no cached decisions)", and a long-lived
 * stream **is** a cached authorization decision — Host and Origin are likewise
 * evaluated once, at open. Bounding it at the session TTL is what keeps that
 * promise true. The client reconnects with its last cursor and the gap contract
 * covers anything missed.
 */
export const EVENT_STREAM_LIFETIME_MS = 1_800_000;

/**
 * How often an open stream re-checks that its principal still holds authority,
 * and the hard lifetime for a principal whose authority cannot be re-checked.
 *
 * `packages/gateway/src/auth.ts` sets `API_KEY_HORIZON_S = 300` — this
 * gateway's own stated horizon for how long one authorization decision may
 * stand. A 1800 s stream that never re-checked would be a 30-minute cached
 * decision, six times that horizon, which is exactly what
 * `SPECS/SECURITY-AUTH.md` §2.1 forbids when it says revocation "takes effect
 * next request (no cached decisions)". A stream has no next request, so it must
 * make one of its own.
 *
 * An OAuth principal cannot be re-checked without its token, and the token is
 * deliberately not retained. Such a stream is therefore **terminated** at this
 * interval rather than re-checked; the client reconnects with its cursor and
 * re-presents its token, which *is* the next request §2.1 asks for, and the gap
 * contract covers anything in between.
 *
 * **What this does for an API key (SR2-M3).** It used to do nothing. The store
 * was built once at startup and never changed, so the re-check could only ever
 * answer "still present" and revoking a key meant a restart — which terminates
 * every stream anyway, making §2.1's promise true only trivially. Since SR2-M3
 * the record set is reloaded from `TTK_API_KEYS_FILE` when that file changes
 * (`keyreload.ts`), so removing a record here **does** end that principal's live
 * streams within this interval, and the deny path is proven end to end by
 * `keyreload_test.ts` "a live stream ends when its principal disappears from a
 * reloaded key file".
 *
 * **What it still does not do.** A deployment configuring keys inline through
 * `TTK_API_KEYS` has no file to watch, and removing the *last* credential is
 * refused rather than applied, because a credential-less loopback bind serves
 * anonymous principals — both are restarts, and both are stated in
 * `SPECS/SECURITY-AUTH.md` §2.1 rather than left to be inferred.
 */
export const EVENT_STREAM_REVALIDATE_MS = 300_000;

/**
 * The event kinds this build has a producer for.
 *
 * `dom.settled` and `console` are declared in the wire contract and have no
 * source yet: `dom.settled` would share `input`'s injection and nothing counts
 * mutations, and a `console` producer needs `Runtime.consoleAPICalled` handled
 * — which must gate on the ring's `consoleSubscribers` refcount rather than on
 * the `Runtime.enable` B1.9's binding now issues, or arming would follow the
 * input channel instead of the subscriber. `input` **does** have a producer as
 * of B1.9: an injected listener in a named isolated world plus a per-session
 * random `Runtime.addBinding` channel, every field of whose record is derived
 * server-side because the producer is the page (`packages/mcp/src/page_input.ts`).
 * `focus` **does** too, and it is the AX
 * focused node resolved during a state read rather than a continuous listener —
 * so a `focus` record marks a change the server *observed*, and the absence of
 * one is not evidence that focus did not move. That limit is stated in
 * `SPECS/SECURITY-AUTH.md` §9.1 rather than left to be inferred. A subscriber
 * asking for a kind with no producer is told
 * `kind-unavailable` rather than accepted in silence — announcing that console
 * coverage has begun when nothing can mint a console record inverts the whole
 * purpose of the boundary record, because a consumer would then read the
 * silence that follows as "the page was quiet".
 *
 * The default lives here rather than at the call site so the transport's tests
 * exercise the same set production serves.
 */
export const PRODUCING_EVENT_KINDS: ReadonlySet<string> = new Set([
	'navigation',
	'focus',
	'input',
	'console',
	'dom.settled',
	'network.idle',
	'download.started',
	'download.done',
	'download.failed',
	'dialog',
	'tab',
	'control',
]);

/** Comment-line interval, matching the live view's own keep-alive. */
export const EVENT_STREAM_KEEPALIVE_MS = 15_000;

/** The reconnect hint emitted once at stream open. A hint, not a promise. */
export const EVENT_STREAM_RETRY_MS = 2000;

const ENCODER = new TextEncoder();

/** Why a stream could not be opened. */
export type StreamAdmission = 'ok' | 'session-full' | 'principal-full';

/** One open stream, as the registry holds it for shutdown. */
interface OpenStream {
	/** Terminates with a `bye` record and closes. Idempotent. */
	close(reason: EventByeReason): void;
}

/**
 * The per-process set of open streams and the two connection counters.
 *
 * An open SSE response **is** an in-flight request and never finishes on its
 * own, so a `shutdown()` that did not close these would block until the last
 * subscriber left — for a worker holding a long poll, never.
 */
export class EventStreamRegistry {
	readonly #perSession = new Map<string, number>();
	readonly #perPrincipal = new Map<string, number>();
	readonly #open = new Set<OpenStream>();

	/** Streams open right now. */
	get size(): number {
		return this.#open.size;
	}

	/** Streams open on one session. */
	countFor(sessionId: string): number {
		return this.#perSession.get(sessionId) ?? 0;
	}

	/** Streams one principal holds across every session. */
	countForPrincipal(principal: string): number {
		return this.#perPrincipal.get(principal) ?? 0;
	}

	/**
	 * Charges both counters, or says which one refused.
	 *
	 * The check and the increment happen in **one synchronous call**, before any
	 * stream or socket is constructed. The live view's own viewer cap was
	 * time-of-check-to-time-of-use — it read `record.viewers.size` at admission
	 * and incremented in the socket's later `onopen`, so N concurrent upgrades
	 * all passed a cap of 4. Reserving here is what makes a cap a cap.
	 */
	admit(sessionId: string, principal: string): StreamAdmission {
		if (this.countFor(sessionId) >= MAX_EVENT_STREAMS_PER_SESSION) return 'session-full';
		if (this.countForPrincipal(principal) >= MAX_CONNECTIONS_PER_PRINCIPAL) return 'principal-full';
		this.#perSession.set(sessionId, this.countFor(sessionId) + 1);
		this.#perPrincipal.set(principal, this.countForPrincipal(principal) + 1);
		return 'ok';
	}

	/**
	 * Reserves one per-principal slot for a live-view socket.
	 *
	 * The socket does not consume a per-session *stream* seat — the two
	 * per-session budgets stay apart — but it does consume the principal's shared
	 * connection budget, which is the ceiling the specification already published.
	 * Returns `false` when the principal is at its ceiling.
	 */
	admitPrincipal(principal: string): boolean {
		if (this.countForPrincipal(principal) >= MAX_CONNECTIONS_PER_PRINCIPAL) return false;
		this.#perPrincipal.set(principal, this.countForPrincipal(principal) + 1);
		return true;
	}

	/** Releases a slot taken by {@linkcode EventStreamRegistry.admitPrincipal}. Idempotent per caller. */
	releasePrincipal(principal: string): void {
		const held = this.countForPrincipal(principal) - 1;
		if (held <= 0) this.#perPrincipal.delete(principal);
		else this.#perPrincipal.set(principal, held);
	}

	/** Records an admitted stream so shutdown can reach it. */
	register(stream: OpenStream): void {
		this.#open.add(stream);
	}

	/**
	 * Releases one admitted stream. Idempotent per stream, because every exit
	 * path calls it and more than one can run for the same stream.
	 *
	 * The per-principal entry is deleted at zero rather than swept, so the map is
	 * bounded by construction and needs no sweep of its own.
	 */
	release(sessionId: string, principal: string, stream: OpenStream): void {
		if (!this.#open.delete(stream)) return;
		const session = this.countFor(sessionId) - 1;
		if (session <= 0) this.#perSession.delete(sessionId);
		else this.#perSession.set(sessionId, session);
		const held = this.countForPrincipal(principal) - 1;
		if (held <= 0) this.#perPrincipal.delete(principal);
		else this.#perPrincipal.set(principal, held);
	}

	/** Terminates every open stream with a `bye`. Called in the shutdown stage that closes sockets. */
	closeAll(reason: EventByeReason): void {
		for (const stream of [...this.#open]) {
			try {
				stream.close(reason);
			} catch {
				// A stream whose controller is already gone is already closed.
			}
		}
		this.#open.clear();
		this.#perSession.clear();
		this.#perPrincipal.clear();
	}
}

/**
 * Serializes one record as an SSE frame.
 *
 * **`withId` is a correctness switch, not a formatting one.** The `id:` field is
 * what a client returns as `Last-Event-ID`, so it is a promise that everything up
 * to that sequence number has been delivered. Records drained from the ring have
 * earned that promise. **Synthesized records have not**: `stream-open`,
 * `kind-unavailable` and `bye` are minted at the ring's current high-water mark
 * and enqueued before `pull` has emitted anything, so publishing their `seq` as
 * an `id:` would advance a reconnecting client past every record it had not yet
 * received — silently, with no gap, which is exactly the defect the gap
 * contract's own `seq` was corrected to avoid. SSE permits omitting `id:`, and a
 * client that receives none keeps the last one it had.
 *
 * `gap` keeps its `id:`: its `seq` is deliberately one below the oldest retained
 * record, so it *is* a correct resume cursor.
 */
function frameOf(epoch: string, record: EventRecord, withId = true): Uint8Array {
	// `data:` is always exactly one line (invariant I-9): the record is
	// serialized with JSON.stringify, which cannot emit a raw newline, so a
	// multi-line data block can never occur and two events can never merge.
	const id = withId ? `id: ${formatCursor(epoch, record.seq)}\n` : '';
	return ENCODER.encode(`${id}event: ${record.kind}\ndata: ${JSON.stringify(record)}\n\n`);
}

/** Parses `?kinds=` into a filter, and names the entries this transport cannot honour. */
/**
 * Entries a `?kinds=` list may name before the rest are ignored.
 *
 * There are fourteen kind strings in existence, so any list longer than this is
 * malformed or hostile. Without a bound, an authenticated GET carrying a
 * 64 KB query string — which the listener accepts — was a synchronous
 * event-loop stall measured in seconds on a single-threaded runtime, and every
 * unmatched entry was additionally echoed back verbatim in a `kind-unavailable`
 * frame, so the reply was as unbounded as the request.
 */
export const MAX_KIND_ENTRIES = 32;

/** Characters of one unmatched entry echoed back. Enough to recognise a typo. */
export const MAX_KIND_ECHO_CHARS = 64;

/** Unmatched entries named on the stream before the rest are summarised away. */
export const MAX_UNAVAILABLE_REPORTED = 8;

export function parseKinds(
	raw: string | undefined,
	available: ReadonlySet<string>,
): { filter: ReadonlySet<EventKind> | undefined; unavailable: string[] } {
	if (raw === undefined || raw.trim() === '') return { filter: undefined, unavailable: [] };
	const filter = new Set<EventKind>();
	// A Set rather than an array scan: the dedupe was inside the per-entry loop,
	// which made the whole parse quadratic in a value the caller chooses.
	const unavailable = new Set<string>();
	for (const entry of raw.split(',', MAX_KIND_ENTRIES)) {
		const kind = entry.trim();
		if (kind === '') continue;
		if (!available.has(kind)) {
			// Never a silent drop: a consumer that asked for a kind it will not get
			// learns so on the stream rather than inferring it from silence — but
			// what comes back is bounded, because what went out was not.
			if (unavailable.size < MAX_UNAVAILABLE_REPORTED) unavailable.add(kind.slice(0, MAX_KIND_ECHO_CHARS));
			continue;
		}
		filter.add(kind as EventKind);
	}
	return { filter, unavailable: [...unavailable] };
}

export interface EventStreamDeps {
	readonly app: Hono<{ Variables: AppVariables }>;
	readonly registry: SessionRegistry;
	readonly streams: EventStreamRegistry;
	readonly logger: Logger;
	readonly config: Config;
	readonly cluster?: Cluster;
	/** Injected clock, so the lifetime cap is testable without waiting 1800 s. */
	readonly now?: () => number;
	/** Overridable lifetime, for the same reason. */
	readonly lifetimeMs?: number;
	readonly keepAliveMs?: number;
	readonly revalidateMs?: number;
	/**
	 * Re-checks that a principal still holds authority, without retaining its
	 * credential. `false` terminates the stream with `stream-expired`.
	 */
	readonly revalidate?: (principal: Principal) => boolean;
	/**
	 * The kinds this deployment actually has a producer for.
	 *
	 * Defaults to every kind. A kind with no producer is answered with
	 * `kind-unavailable` rather than accepted in silence: telling a consumer that
	 * `console` coverage has started when nothing can ever mint a `console`
	 * record is worse than saying nothing, because the whole point of the
	 * coverage boundary is that silence must not be read as quiet.
	 */
	readonly producing?: ReadonlySet<string>;
}

/** Registers the SSE route. Must run **after** the auth middleware, or no principal exists. */
export function attachEventStream(deps: EventStreamDeps): void {
	const { app, registry, streams, logger, cluster } = deps;
	const now = deps.now ?? (() => Date.now());
	const lifetimeMs = deps.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS;
	const keepAliveMs = deps.keepAliveMs ?? EVENT_STREAM_KEEPALIVE_MS;
	const revalidateMs = deps.revalidateMs ?? EVENT_STREAM_REVALIDATE_MS;
	const revalidate = deps.revalidate;
	const available = deps.producing ?? PRODUCING_EVENT_KINDS;

	app.get('/api/v1/sessions/:sessionId/events', async (c: Context) => {
		const requestId = c.get('requestId');
		const principal = c.get('principal') as Principal | undefined;
		if (principal === undefined) return problemResponse('unauthenticated', requestId);
		// The stream carries page content, so it takes the same authority
		// `browser_get_state` needs. Watching a browser is permission to see
		// pixels, not to read what the page holds.
		if (!principal.scopes.has('mcp:invoke')) {
			return problemResponse('forbidden-scope', requestId, 'the mcp:invoke scope is required');
		}
		const sessionId = c.req.param('sessionId') ?? '';

		// In a cluster the ring is on the node holding the session. One hop, to a
		// registered node only. An unreachable owner is `unknown-session` and
		// never an empty stream: a stream that silently carries nothing is worse
		// than an error, because a consumer waits on it forever.
		if (cluster !== undefined && c.req.header(FORWARDED_HEADER) === undefined) {
			const owner = await cluster.ownerOf(sessionId);
			if (owner !== null && owner.id !== cluster.self.id) {
				logger.info(`routing event stream of session ${sessionId} to ${owner.id}`);
				const url = new URL(c.req.url);
				return await forward(
					owner,
					c.req.raw,
					'',
					cluster.self.id,
					`${url.pathname}${url.search}`,
					// An unreachable owner is `unknown-session`, **never an empty
					// stream**: a stream that silently carries nothing is worse than
					// an error, because the consumer waits on it forever instead of
					// retrying. And it must be a problem document rather than the
					// default JSON-RPC envelope, which no REST caller can parse.
					() => problemResponse('unknown-session', requestId, `the node holding session ${sessionId} is unreachable`),
				);
			}
		}

		// `peek`: an HTTP read never creates a browser. `peekFor` (R8, D-128): in `owner` mode another owner's
		// session is not found, and `default` is the caller's own.
		const record = registry.peekFor(sessionId, {
			owner: expansionOwner(principal),
			admin: principal.scopes.has('admin'),
		});
		if (record === undefined) return problemResponse('unknown-session', requestId, `no session ${sessionId}`);

		const admission = streams.admit(record.id, principal.id);
		if (admission !== 'ok') {
			const detail = admission === 'session-full'
				? `at most ${MAX_EVENT_STREAMS_PER_SESSION} event streams per session`
				: `at most ${MAX_EVENT_STREAMS_PER_PRINCIPAL} event streams per principal`;
			// The existing slug rather than a second name for one condition class.
			return problemResponse('rate-limited', requestId, detail, { 'retry-after': '5' });
		}

		const ring = record.events;
		// `since` wins over `Last-Event-ID`, which costs three lines and makes a
		// standard client work.
		const sinceParam = c.req.query('since') ?? c.req.header('last-event-id');
		let cursor: ParsedCursor = parseCursor(sinceParam);
		const { filter, unavailable } = parseKinds(c.req.query('kinds'), available);
		// Only a stream that can actually receive console records arms the domain.
		// An unfiltered request does not silently subscribe to a kind nothing
		// produces.
		const wantsConsole = available.has('console') && filter !== undefined && filter.has('console');
		// `dom.settled` is refcount-armed like `console`, and for the same reason:
		// minting it costs a state read, so it is armed only when a filter names it
		// explicitly. An unfiltered stream does not silently trigger a read per
		// settle. Documented at the ring's `domSettledSubscribers`.
		const wantsDomSettled = available.has('dom.settled') && filter !== undefined && filter.has('dom.settled');
		// B2.5 / E-53. Naming `dialog` explicitly arms the manual hold: a held dialog blocks the whole
		// CDP channel for its target, so it is held only for a subscriber that has actually asked about
		// dialogs and can therefore answer one. An unfiltered stream still *receives* dialog records —
		// it simply does not make the browser wait on it.
		const wantsDialog = available.has('dialog') && filter !== undefined && filter.has('dialog');

		let released = false;
		let finished = false;
		let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
		const expiresAt = now() + lifetimeMs;
		let nextCheckAt = now() + revalidateMs;

		const handle: OpenStream = {
			close(reason: EventByeReason) {
				if (finished) return;
				finished = true;
				const controller = controllerRef;
				controllerRef = null;
				try {
					controller?.enqueue(frameOf(ring.epoch, {
						kind: 'bye',
						seq: ring.highWaterMark,
						at: new Date(now()).toISOString(),
						tab_id: null,
						payload: { reason },
					}, false));
					controller?.close();
				} catch {
					// Already closed by the peer going away.
				}
				release();
			},
		};

		/**
		 * The one deregistration path. Idempotent, and every exit calls it:
		 * `cancel()`, the lifetime cap, a closed session, shutdown, and a throw
		 * inside `pull`. The `console` refcount is decremented here and nowhere
		 * else, so no exit route can leave `Runtime.enable` armed for the
		 * session's life after its subscriber has gone.
		 */
		function release(): void {
			if (released) return;
			released = true;
			clearTimeout(lifetimeTimer);
			clearInterval(authTimer);
			if (wantsConsole) ring.disarmConsole();
			if (wantsDomSettled) ring.disarmDomSettled();
			if (wantsDialog) ring.disarmDialog();
			streams.release(record!.id, principal!.id, handle);
		}

		if (wantsConsole) ring.armConsole();
		if (wantsDomSettled) ring.armDomSettled();
		if (wantsDialog) ring.armDialog();
		streams.register(handle);

		// **The lifetime cap cannot live inside `pull`.** `pull` runs only while the
		// consumer drains the queue, so a client that completes the request and then
		// simply stops reading — or stalls its TCP window — would hold a per-session
		// seat and a per-principal seat until the process exited: no expiry, no
		// revalidation, no notice even that the session had closed. Eight such
		// connections lock a principal out of both transports. An unref'd timer
		// bounds the stream whether or not anyone is listening, and never holds the
		// runtime open on its own.
		const lifetimeTimer = setTimeout(() => handle.close('stream-expired'), lifetimeMs);
		Deno.unrefTimer(lifetimeTimer as unknown as number);
		const authTimer = setInterval(() => {
			if (revalidate !== undefined && !revalidate(principal)) handle.close('stream-expired');
		}, revalidateMs);
		Deno.unrefTimer(authTimer as unknown as number);

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controllerRef = controller;
				controller.enqueue(ENCODER.encode(`retry: ${EVENT_STREAM_RETRY_MS}\n\n`));
				// Every stream states its epoch before it waits. Without this a
				// client that legitimately has nothing to receive could never learn
				// which epoch it is waiting on.
				controller.enqueue(frameOf(ring.epoch, {
					kind: 'control',
					seq: ring.highWaterMark,
					at: new Date(now()).toISOString(),
					tab_id: null,
					payload: { event: 'stream-open', epoch: ring.epoch, seq: ring.highWaterMark },
				}, false));
				for (const kind of unavailable) {
					controller.enqueue(frameOf(ring.epoch, {
						kind: 'control',
						seq: ring.highWaterMark,
						at: new Date(now()).toISOString(),
						tab_id: null,
						payload: { event: 'kind-unavailable', kind },
					}, false));
				}
			},
			async pull(controller) {
				try {
					for (;;) {
						if (finished) return;
						// The mark is taken before the read, so a record appended
						// during the read is re-seen rather than skipped.
						const mark = ring.highWaterMark;
						const records = ring.read(cursor, filter);
						// The mark is taken before the read so a record appended *during*
						// it is re-seen rather than skipped — deliberate at-least-once for
						// that race. But `read` itself mints `rate-capped` records as it
						// rolls the window, and those land in this very batch above the
						// mark, so advancing to the mark alone re-delivered them every
						// time. Advancing to whichever is higher keeps the race safe and
						// makes the guaranteed duplicate impossible.
						let delivered = mark;
						for (const entry of records) delivered = Math.max(delivered, entry.seq);
						cursor = { kind: 'cursor', epoch: ring.epoch, seq: delivered };
						if (records.length > 0) {
							for (const entry of records) controller.enqueue(frameOf(ring.epoch, entry));
							return;
						}
						if (ring.closed) return handle.close('session-closed');
						if (now() >= expiresAt) return handle.close('stream-expired');
						// A long-lived stream is a cached authorization decision, so
						// it re-earns it on the gateway's own horizon rather than
						// standing for the whole lifetime on the check made at open.
						if (now() >= nextCheckAt) {
							nextCheckAt = now() + revalidateMs;
							if (revalidate !== undefined && !revalidate(principal)) {
								return handle.close('stream-expired');
							}
						}
						const before = ring.highWaterMark;
						await ring.next(Math.min(keepAliveMs, Math.max(1, expiresAt - now())));
						if (finished) return;
						if (ring.highWaterMark === before && !ring.closed) {
							controller.enqueue(ENCODER.encode(': keep-alive\n\n'));
							return;
						}
					}
				} catch (cause) {
					// A throw here would otherwise strand both counters and the
					// console refcount for the life of the process.
					release();
					throw cause;
				}
			},
			cancel() {
				finished = true;
				controllerRef = null;
				release();
			},
		});

		return new Response(body, {
			headers: {
				'content-type': 'text/event-stream; charset=utf-8',
				// `no-transform` is required rather than nice: automatic compression
				// is switchable in Deno and a compressed `text/event-stream` buffers.
				'cache-control': 'no-cache, no-transform',
				'connection': 'keep-alive',
				// Non-standard, and there because a reverse proxy in front of the
				// container will otherwise buffer the stream. It costs 24 bytes once.
				'x-accel-buffering': 'no',
				'x-request-id': requestId,
			},
		});
	});
}

/** The kinds the SSE transport carries: all twelve, content included. */
export const SSE_KINDS: readonly string[] = EVENT_KINDS;

/** The three content-bearing kinds the live-view socket must never carry. */
export const CONTENT_KINDS: readonly string[] = SSE_ONLY_EVENT_KINDS;
