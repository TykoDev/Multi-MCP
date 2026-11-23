/**
 * The SSE event transport: `GET /api/v1/sessions/{id}/events`. Scope is `mcp:invoke`, deliberately not `view:watch`.
 * Backpressure: frames drop, events gap. Disconnect is `cancel()`, never `request.signal`.
 */
import type { Context, Hono } from 'hono';
import type { SessionRegistry } from '@tykotech/mcp';
import { formatCursor, parseCursor, type ParsedCursor } from '@tykotech/mcp';
import { type EventByeReason, type EventKind, type EventRecord } from '@tykotech/wire';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { problemResponse } from './problem.ts';
import type { AppVariables } from './app.ts';
import { expansionOwner, type Principal } from './auth.ts';

/** The scope a stream is opened under and must keep (see the module note: `mcp:invoke`, not `view:watch`). */
const STREAM_SCOPE = 'mcp:invoke';

/** Event streams one session may carry. */
export const MAX_EVENT_STREAMS_PER_SESSION = 4;

/**
 * Long-lived connections one principal may hold across every session — event streams and live-view sockets
 * **together**.
 */
export const MAX_CONNECTIONS_PER_PRINCIPAL = 8;

/** How long a stream may live before it is terminated with `stream-expired`. */
export const EVENT_STREAM_LIFETIME_MS = 1_800_000;

/**
 * How often an open stream re-checks that its principal still holds authority, and the hard lifetime for a principal
 * whose authority cannot be re-checked.
 */
export const EVENT_STREAM_REVALIDATE_MS = 300_000;

/** The event kinds this build has a producer for. */
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
const EVENT_STREAM_KEEPALIVE_MS = 15_000;

/** The reconnect hint emitted once at stream open. A hint, not a promise. */
const EVENT_STREAM_RETRY_MS = 2000;

const ENCODER = new TextEncoder();

/** Why a stream could not be opened. */
export type StreamAdmission = 'ok' | 'session-full' | 'principal-full';

/** One open stream, as the registry holds it for shutdown. */
interface OpenStream {
	/** Terminates with a `bye` record and closes. Idempotent. */
	close(reason: EventByeReason): void;
	/** Re-checks the stream's authorization now, closing it with `stream-expired` when it is gone. */
	check?(): void;
}

/** The per-process set of open streams and the two connection counters. */
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
	 * Charges both counters, or says which one refused. The check and the increment happen in **one synchronous call**,
	 * before any stream or socket is constructed.
	 */
	admit(sessionId: string, principal: string): StreamAdmission {
		if (this.countFor(sessionId) >= MAX_EVENT_STREAMS_PER_SESSION) return 'session-full';
		if (this.countForPrincipal(principal) >= MAX_CONNECTIONS_PER_PRINCIPAL) return 'principal-full';
		this.#perSession.set(sessionId, this.countFor(sessionId) + 1);
		this.#perPrincipal.set(principal, this.countForPrincipal(principal) + 1);
		return 'ok';
	}

	/** Reserves one per-principal slot for a live-view socket. */
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
	 * Releases one admitted stream. Idempotent per stream, because every exit path calls it and more than one can run
	 * for the same stream.
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

	/** Re-checks every open stream now. */
	revalidateAll(): void {
		for (const stream of [...this.#open]) {
			try {
				stream.check?.();
			} catch {
				// A stream whose controller is already gone is already closed.
			}
		}
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

/** Serializes one record as an SSE frame. */
function frameOf(epoch: string, record: EventRecord, withId = true): Uint8Array {
	// `data:` is always exactly one line: the record is serialized with JSON.stringify, which cannot emit a raw
	// newline, so a multi-line data block can never occur and two events can never merge.
	const id = withId ? `id: ${formatCursor(epoch, record.seq)}\n` : '';
	return ENCODER.encode(`${id}event: ${record.kind}\ndata: ${JSON.stringify(record)}\n\n`);
}

/** Parses `?kinds=` into a filter, and names the entries this transport cannot honour. */
/** Entries a `?kinds=` list may name before the rest are ignored. */
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
	// A Set rather than an array scan: the dedupe sits inside the per-entry loop, where a scan would make the whole
	// parse quadratic in a value the caller chooses.
	const unavailable = new Set<string>();
	for (const entry of raw.split(',', MAX_KIND_ENTRIES)) {
		const kind = entry.trim();
		if (kind === '') continue;
		if (!available.has(kind)) {
			// Never a silent drop: a consumer that asked for a kind it will not get learns so on the stream rather than
			// inferring it from silence — but what comes back is bounded, because what went out was not.
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
	/** Injected clock, so the lifetime cap is testable without waiting 1800 s. */
	readonly now?: () => number;
	/** Overridable lifetime, for the same reason. */
	readonly lifetimeMs?: number;
	readonly keepAliveMs?: number;
	readonly revalidateMs?: number;
	/**
	 * The scopes `principal`'s credential holds **now**, or `null` once it is gone (`VerifierChain.currentScopes`). A
	 * stream whose credential no longer holds `mcp:invoke` ends with `stream-expired`; absent, nothing is re-checked.
	 */
	readonly scopesNow?: (principal: Principal) => ReadonlySet<string> | null;
	/** The kinds this deployment actually has a producer for. */
	readonly producing?: ReadonlySet<string>;
}

/** Registers the SSE route. Must run **after** the auth middleware, or no principal exists. */
export function attachEventStream(deps: EventStreamDeps): void {
	const { app, registry, streams } = deps;
	const now = deps.now ?? (() => Date.now());
	const lifetimeMs = deps.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS;
	const keepAliveMs = deps.keepAliveMs ?? EVENT_STREAM_KEEPALIVE_MS;
	const revalidateMs = deps.revalidateMs ?? EVENT_STREAM_REVALIDATE_MS;
	const { scopesNow } = deps;
	/** Whether `principal` may still hold its stream: its credential still holds the scope it was opened under. */
	const stillMay = (principal: Principal): boolean =>
		scopesNow === undefined || scopesNow(principal)?.has(STREAM_SCOPE) === true;
	const available = deps.producing ?? PRODUCING_EVENT_KINDS;

	app.get('/api/v1/sessions/:sessionId/events', (c: Context) => {
		const requestId = c.get('requestId');
		const principal = c.get('principal') as Principal | undefined;
		if (principal === undefined) return problemResponse('unauthenticated', requestId);
		// The stream carries page content, so it takes the same authority `browser_get_state` needs. Watching a browser
		// is permission to see pixels, not to read what the page holds.
		if (!principal.scopes.has(STREAM_SCOPE)) {
			return problemResponse('forbidden-scope', requestId, 'the mcp:invoke scope is required');
		}
		const sessionId = c.req.param('sessionId') ?? '';

		// `peek`: an HTTP read never creates a browser. `peekFor`: in `owner` mode another owner's session is not
		// found, and `default` is the caller's own.
		const record = registry.peekFor(sessionId, {
			owner: expansionOwner(principal),
			admin: principal.scopes.has('admin'),
		});
		if (record === undefined) return problemResponse('unknown-session', requestId, `no session ${sessionId}`);

		const admission = streams.admit(record.id, principal.id);
		if (admission !== 'ok') {
			const detail = admission === 'session-full'
				? `at most ${MAX_EVENT_STREAMS_PER_SESSION} event streams per session`
				: `at most ${MAX_CONNECTIONS_PER_PRINCIPAL} event streams per principal`;
			// The existing slug rather than a second name for one condition class.
			return problemResponse('rate-limited', requestId, detail, { 'retry-after': '5' });
		}

		const ring = record.events;
		// `since` wins over `Last-Event-ID`, which costs three lines and makes a standard client work.
		const sinceParam = c.req.query('since') ?? c.req.header('last-event-id');
		let cursor: ParsedCursor = parseCursor(sinceParam);
		const { filter, unavailable } = parseKinds(c.req.query('kinds'), available);
		// Only a stream that can actually receive console records arms the domain. An unfiltered request does not
		// silently subscribe to a kind nothing produces.
		const wantsConsole = available.has('console') && filter !== undefined && filter.has('console');
		// `dom.settled` is refcount-armed like `console`, and for the same reason: minting it costs a state read, so it
		// is armed only when a filter names it explicitly.
		const wantsDomSettled = available.has('dom.settled') && filter !== undefined && filter.has('dom.settled');
		// Naming `dialog` explicitly arms the manual hold: a held dialog blocks the whole CDP channel for its target,
		// so it is held only for a subscriber that has actually asked about dialogs and can therefore answer one.
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
			check() {
				if (!finished && !stillMay(principal)) handle.close('stream-expired');
			},
		};

		/**
		 * The one deregistration path. Idempotent, and every exit calls it: `cancel()`, the lifetime cap, a closed
		 * session, shutdown, and a throw inside `pull`.
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

		// **The lifetime cap cannot live inside `pull`.** `pull` runs only while the consumer drains the queue, so a
		// client that completes the request and then simply stops reading — or stalls its TCP window — would hold a
		// per-session seat and a per-principal seat until the process exited: no expiry, no revalidation, no notice
		// even that the session had closed.
		const lifetimeTimer = setTimeout(() => handle.close('stream-expired'), lifetimeMs);
		Deno.unrefTimer(lifetimeTimer as unknown as number);
		const authTimer = setInterval(() => handle.check?.(), revalidateMs);
		Deno.unrefTimer(authTimer as unknown as number);

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controllerRef = controller;
				controller.enqueue(ENCODER.encode(`retry: ${EVENT_STREAM_RETRY_MS}\n\n`));
				// Every stream states its epoch before it waits. Without this a client that legitimately has nothing to
				// receive could never learn which epoch it is waiting on.
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
						// The mark is taken before the read, so a record appended during the read is re-seen rather
						// than skipped.
						const mark = ring.highWaterMark;
						const records = ring.read(cursor, filter);
						// The mark is taken before the read so a record appended *during* it is re-seen rather than
						// skipped — deliberate at-least-once for that race.
						let delivered = mark;
						for (const entry of records) delivered = Math.max(delivered, entry.seq);
						cursor = { kind: 'cursor', epoch: ring.epoch, seq: delivered };
						if (records.length > 0) {
							for (const entry of records) controller.enqueue(frameOf(ring.epoch, entry));
							return;
						}
						if (ring.closed) return handle.close('session-closed');
						if (now() >= expiresAt) return handle.close('stream-expired');
						// A long-lived stream is a cached authorization decision, so it re-earns it on the gateway's
						// own horizon rather than standing for the whole lifetime on the check made at open.
						if (now() >= nextCheckAt) {
							nextCheckAt = now() + revalidateMs;
							if (!stillMay(principal)) return handle.close('stream-expired');
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
					// A throw here would otherwise strand both counters and the console refcount for the life of the
					// process.
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
				// `no-transform` is required rather than nice: automatic compression is switchable in Deno and a
				// compressed `text/event-stream` buffers.
				'cache-control': 'no-cache, no-transform',
				'connection': 'keep-alive',
				// Non-standard, and there because a reverse proxy in front of the container will otherwise buffer the
				// stream. It costs 24 bytes once.
				'x-accel-buffering': 'no',
				'x-request-id': requestId,
			},
		});
	});
}
