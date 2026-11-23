/** The live browser view: ticket minting, the WebSocket, the screencast pump, and human input injection. */
import type { Context, Hono } from 'hono';
import {
	assertNavigable,
	blockedSince,
	elementAtPoint,
	FIELD_PRESETS,
	highlight,
	navigationTarget,
} from '@tykotech/mcp';
import type { LiveViewerHandle, Scope, SessionAccess, SessionRecord, SessionRegistry } from '@tykotech/mcp';
import {
	AgentFocusChangedEvent,
	type BrowserSession,
	type KeySpec,
	keySpecForCharacter,
	keySpecForName,
	MODIFIER_ALIASES,
	MODIFIER_BITS,
	NavigateToUrlEvent,
	NavigationCompleteEvent,
	suppressesText,
	SwitchTabEvent,
	TabClosedEvent,
	TabCreatedEvent,
} from '@tykotech/browser';
import type { TargetId } from '@tykotech/cdp';
import { ulid } from '@std/ulid';
import { decodeBase64 } from '@std/encoding/base64';
import type { ApiKeyRecord, Config } from './config.ts';
import { ANONYMOUS_OWNER, expansionOwner, holderNameOf, type Principal } from './auth.ts';
import type { Logger } from './logger.ts';
import { problemResponse } from './problem.ts';
import {
	EVENT_STREAM_LIFETIME_MS,
	EVENT_STREAM_REVALIDATE_MS,
	type EventStreamRegistry,
	PRODUCING_EVENT_KINDS,
} from './eventstream.ts';
import { effectiveOrigins, originAllowed, type OriginOverlay } from './origins.ts';
import { SocketEventPump } from './socketevents.ts';
import { clampTicketTtl, TICKET_TTL_MS, type TicketRecord, type TicketStore, type ViewMode } from './tickets.ts';
import {
	type ClientMsg,
	ClientMsgSchema,
	encodeFrame,
	type ServerMsg,
	type StateFrame,
	type TabInfo,
	type WsErrorReason,
} from '@tykotech/wire';
import type { AppVariables } from './app.ts';

/** Chrome emits several `targetInfoChanged` per navigation; one broadcast is enough. */
const TABS_COALESCE_MS = 150;
/** Above this much unflushed data a viewer is too slow to receive a new frame. */
const BACKPRESSURE_BYTES = 1024 * 1024;
/** How far outside the last-known viewport a pointer may still land. */
const OUT_OF_RANGE_MARGIN_PX = 64;

/** Ping cadence. */
const PING_INTERVAL_MS = 15_000;

/** How long a socket may stay silent before it is closed as unresponsive — in two tiers. */
export const PONG_GRACE_MS = 300_000;
export const PONG_TIMEOUT_MS = 45_000;

/**
 * How long this socket may stay silent before it is reaped, given what it has shown it can do. Exported so the tier is
 * asserted against the shipped values rather than against a copy of the rule in a test.
 */
export function pongDeadlineMs(pongCapable: boolean): number {
	return pongCapable ? PONG_TIMEOUT_MS : PONG_GRACE_MS;
}

/**
 * The screencast's bound at `scale: 1`. `frame_scale` is computed against these two numbers and the frame's own
 * `deviceWidth/deviceHeight`, never inferred from the JPEG.
 */
export const CAST_MAX_WIDTH = 1280;
export const CAST_MAX_HEIGHT = 720;
/** Chromium's compositor rate the `max_fps` ceiling is expressed against (`everyNthFrame`). */
const CAST_COMPOSITOR_FPS = 60;

/** The effective screencast settings, after clamping (`live.quality`). */
export interface CastQuality {
	readonly scale: number;
	readonly jpegQuality: number;
	readonly maxFps: number;
}

/**
 * The factor a frame of a `w × h` CSS-px viewport is scaled by under a `maxW × maxH` bound: the smaller of the two
 * ratios, and never above 1 because Chromium does not upscale.
 */
export function frameScaleFor(w: number, h: number, maxW = CAST_MAX_WIDTH, maxH = CAST_MAX_HEIGHT): number {
	if (!(w > 0) || !(h > 0)) return 1;
	return Math.min(1, maxW / w, maxH / h);
}

/** Clamps a `live.quality` request into the contract's bounds; absent fields keep the current value. */
export function clampQuality(
	current: CastQuality,
	requested: { scale?: number | undefined; jpeg_quality?: number | undefined; max_fps?: number | undefined },
): CastQuality {
	const bound = (value: number | undefined, fallback: number, min: number, max: number, integer: boolean) => {
		if (value === undefined || !Number.isFinite(value)) return fallback;
		const clamped = Math.min(max, Math.max(min, value));
		return integer ? Math.round(clamped) : clamped;
	};
	return {
		scale: bound(requested.scale, current.scale, 0.1, 1, false),
		jpegQuality: bound(requested.jpeg_quality, current.jpegQuality, 1, 100, true),
		maxFps: bound(requested.max_fps, current.maxFps, 1, 30, true),
	};
}

/** Folds a client's `modifiers` into the CDP bitmask. */
export function modifierBits(modifiers: number | readonly string[] | undefined): number {
	if (modifiers === undefined) return 0;
	if (typeof modifiers === 'number') return modifiers;
	let bits = 0;
	for (const name of modifiers) {
		const canonical = MODIFIER_ALIASES[name.trim().toLowerCase()];
		if (canonical !== undefined) bits |= MODIFIER_BITS[canonical];
	}
	return bits;
}

/** Resolves one live-view key into the spec CDP actually needs. */
export function resolveKeySpec(key: string, override?: number): KeySpec | null {
	const named = keySpecForName(key);
	const spec = named ?? ([...key].length === 1 ? keySpecForCharacter(key) : null);
	if (spec === null) {
		// A client that knows the code may still name a key this server's tables do not: it says so explicitly rather
		// than being guessed at.
		return override === undefined
			? null
			: { key, code: '', windowsVirtualKeyCode: override, text: null, shift: false, location: 0 };
	}
	return override === undefined ? spec : { ...spec, windowsVirtualKeyCode: override };
}

export interface CastRegistryDeps {
	readonly config: Config;
	readonly registry: SessionRegistry;
	readonly logger: Logger;
}

/** The frame streams, one per session. */
export interface CastRegistry {
	/** The shared cast for a session, created on first use. */
	castFor(record: SessionRecord): SessionCast;
	/** Attaches a raw frame consumer to a session's screencast. */
	subscribe(sessionId: string, onFrame: (jpegBase64: string) => void): Promise<() => void>;
}

export function createCastRegistry(deps: CastRegistryDeps): CastRegistry {
	const { config, registry, logger } = deps;
	// One screencast per *session*, not per viewer: Chrome produces a single frame stream per target, and a second
	// subscriber acking the same frame is a race over CDP's one-un-acked-frame flow control. Viewers fan out from it.
	const casts = new Map<string, SessionCast>();

	const castFor = (record: SessionRecord): SessionCast => {
		let cast = casts.get(record.id);
		if (cast === undefined) {
			cast = new SessionCast({
				record,
				quality: config.limits.castQuality,
				logger: logger.with({ session: record.id }),
				onEmpty: () => casts.delete(record.id),
			});
			casts.set(record.id, cast);
		}
		return cast;
	};

	return {
		castFor,
		async subscribe(sessionId, onFrame) {
			const record = registry.peek(sessionId);
			if (record === undefined) throw new Error(`no session with id ${sessionId}`);
			// A frames-only subscriber: it wants pixels, not tab lists.
			const detach = castFor(record).attach({ onFrame: (jpeg) => onFrame(jpeg), onEvent: () => {} });
			// The cast starts its screencast lazily on first attach; give it a moment so `start` does not report
			// success before any frame can flow.
			await new Promise((resolve) => setTimeout(resolve, 50));
			return detach;
		},
	};
}

export interface LiveViewDeps {
	readonly app: Hono<{ Variables: AppVariables }>;
	readonly config: Config;
	readonly registry: SessionRegistry;
	readonly tickets: TicketStore;
	readonly logger: Logger;
	readonly casts: CastRegistry;
	/** The shared per-principal connection ceiling, held with the event streams. */
	readonly connections?: EventStreamRegistry;
	/** This build's version, as it reaches a viewer's `meta` message. */
	readonly version?: string;
	/** The per-token origin overlay. */
	readonly origins?: OriginOverlay;
	/** The API-key records in force **right now**, for the `holder_name` a ticket publishes. */
	readonly keyRecords?: () => readonly ApiKeyRecord[];
	/**
	 * The scopes the minting credential still holds, narrowed from `scopes`, or `null` once it is gone —
	 * `VerifierChain.authorizeTask`, the re-check the MCP Apps embed sockets make (`embed_streams.ts`).
	 */
	readonly authorize?: (owner: string, scopes: ReadonlySet<string>, credential: string | undefined) =>
		| ReadonlySet<string>
		| null;
	/** Overrides for tests: the re-check horizon and the cap on a socket that cannot be re-checked. */
	readonly revalidateMs?: number;
	readonly lifetimeMs?: number;
}

/** What {@linkcode attachLiveView} hands back: the hook the gateway's credentials-changed listener calls. */
export interface LiveViewHandle {
	/**
	 * Re-checks every open viewer at once — a key reload, a logout or a narrowed account must not wait for the next
	 * {@linkcode EVENT_STREAM_REVALIDATE_MS} tick.
	 */
	revalidateAll(): void;
}

/**
 * Who a live ticket is minted for: the principal id the per-principal ceilings count, its scopes, and the `holder_name`
 * its lock message shows, resolved by the caller, which holds the full principal and the key records.
 */
export interface LiveTicketHolder {
	readonly id: string;
	readonly scopes: ReadonlySet<Scope>;
	readonly holderName: string | null;
	/**
	 * The fingerprint of the credential minting the ticket (`Principal.credential`), stamped on the ticket so the
	 * socket can re-check it. Absent where the caller has none to give.
	 */
	readonly credential?: string | undefined;
}

/** What {@linkcode mintLiveTicket} reads. */
export interface MintLiveTicketDeps {
	readonly registry: SessionRegistry;
	readonly tickets: TicketStore;
}

/** One live-ticket request, already parsed off its transport. */
export interface MintLiveTicketInput {
	readonly principal: LiveTicketHolder;
	/** `default` for the default session, which need not exist yet. */
	readonly sessionId: string;
	/** A narrowing of the principal's ceiling; absent means the ceiling. */
	readonly mode?: 'view' | 'watch' | 'control';
	/** Requested life in milliseconds, clamped by mode; absent means the default. `NaN` is refused as unreadable. */
	readonly ttlMs?: number;
	/** The origin to bind redemption to, or `null`; it must be an exact `scheme://host[:port]` origin. */
	readonly origin: string | null;
	/** The caller's session access: the session is looked up with it and the ticket carries it. */
	readonly access?: SessionAccess;
}

/** A minted ticket and its granted mode, or the problem slug and detail the caller answers with. */
export type MintLiveTicketResult =
	| { ok: true; record: TicketRecord; mode: ViewMode }
	| { ok: false; slug: 'forbidden-scope' | 'invalid-request' | 'unknown-session'; detail: string };

/**
 * The live-ticket mint, off its HTTP route, behaving exactly as `POST /api/v1/live/ticket`: the route keeps body
 * parsing and the response, and the MCP Apps embed mints through the same checks (mode ceiling from the scopes, TTL
 * clamp by mode, origin binding above the default TTL, an existing session).
 */
export function mintLiveTicket(deps: MintLiveTicketDeps, input: MintLiveTicketInput): MintLiveTicketResult {
	const { principal } = input;
	// The mode is the principal's ceiling, narrowed on request: `mode: "view"` (or `"watch"`) mints a ticket that can
	// never take control, even for a principal that could.
	const wantsView = input.mode === 'view' || input.mode === 'watch';
	const canControl = principal.scopes.has('view:control');
	const canWatch = principal.scopes.has('view:watch') || canControl;
	const mode: ViewMode = canControl && !wantsView ? 'control' : 'watch';
	if (mode === 'watch' && !canWatch) {
		return { ok: false, slug: 'forbidden-scope', detail: 'the view:watch scope is required' };
	}
	if (input.mode === 'control' && !canControl) {
		return { ok: false, slug: 'forbidden-scope', detail: 'the view:control scope is required' };
	}

	// A TTL is a request, clamped by the mode's ceiling (view 300 s, control 60 s) and always echoed as granted. Above
	// the 30 s default the ticket must be origin-bound.
	if (input.ttlMs !== undefined && Number.isNaN(input.ttlMs)) {
		return { ok: false, slug: 'invalid-request', detail: 'ttl_seconds must be a number' };
	}
	const ttlMs = clampTicketTtl(input.ttlMs, mode);
	let originBound: string | null = null;
	if (input.origin !== null) {
		const parsed = URL.parse(input.origin);
		if (parsed === null || parsed.origin !== input.origin || parsed.origin === 'null') {
			return { ok: false, slug: 'invalid-request', detail: 'origin must be a scheme://host[:port] origin' };
		}
		originBound = parsed.origin;
	}
	if (ttlMs > TICKET_TTL_MS && originBound === null) {
		return {
			ok: false,
			slug: 'invalid-request',
			detail: `a ticket living longer than ${TICKET_TTL_MS / 1000} s must be bound to an origin: send the request ` +
				'from a page (the Origin header binds it) or name origin in the body',
		};
	}

	// A ticket for a session that does not exist would fail at upgrade, by which point the client has no useful error
	// channel.
	if (input.sessionId !== 'default' && deps.registry.peekFor(input.sessionId, input.access) === undefined) {
		return { ok: false, slug: 'unknown-session', detail: `no session ${input.sessionId}` };
	}

	const record = deps.tickets.mint(principal.id, input.sessionId, mode, {
		ttlMs,
		holderName: principal.holderName,
		origin: originBound,
		access: input.access,
		// The socket re-earns these against the credential, rather than standing on the mint for its whole life.
		scopes: principal.scopes,
		credential: principal.credential,
	});
	return { ok: true, record, mode };
}

/**
 * What a live ticket's credential may do **now** — the scopes it still holds, `null` once it is gone, or `'unchecked'`
 * when nothing can re-check it: no verifier was wired, or the ticket carries no credential fingerprint (an MCP Apps
 * embed mint from a tool context that carries none, such as stdio) and is not the anonymous loopback principal, which
 * is re-checked by owner alone.
 */
export function liveTicketScopesNow(
	ticket: TicketRecord,
	authorize: LiveViewDeps['authorize'],
): ReadonlySet<string> | null | 'unchecked' {
	const owner = ticket.access?.owner;
	if (authorize === undefined || owner === undefined) return 'unchecked';
	if (ticket.credential === undefined && owner !== ANONYMOUS_OWNER) return 'unchecked';
	try {
		return authorize(owner, ticket.scopes ?? new Set(), ticket.credential);
	} catch {
		// A verifier that cannot answer is not an answer that the credential still stands.
		return null;
	}
}

/**
 * The mode `scopes` allows a viewer minted in `minted` mode: never wider than the ticket, narrowed to `watch` once
 * `view:control` is gone, and `null` once neither view scope remains.
 */
export function liveModeAllowed(minted: ViewMode, scopes: ReadonlySet<string>): ViewMode | null {
	if (minted === 'control' && scopes.has('view:control')) return 'control';
	return scopes.has('view:watch') || scopes.has('view:control') ? 'watch' : null;
}

export function attachLiveView(deps: LiveViewDeps): LiveViewHandle {
	const { app, config, registry, tickets, logger, casts, connections, origins } = deps;
	const keyRecords = deps.keyRecords ?? (() => config.apiKeys);
	const version = deps.version ?? '0.0.0-unknown';
	const castFor = (record: SessionRecord) => casts.castFor(record);
	/** Every open viewer, so a credential change can reach each one without waiting for its own timer. */
	const open = new Set<Viewer>();
	/** Viewer seats taken by an upgrade whose socket has not opened yet. */
	const pendingSeats = new WeakMap<SessionRecord, number>();
	const releaseSeat = (record: SessionRecord): void => {
		const left = (pendingSeats.get(record) ?? 1) - 1;
		if (left <= 0) pendingSeats.delete(record);
		else pendingSeats.set(record, left);
	};

	// --- ticket minting ----------------------------------------------------
	app.post('/api/v1/live/ticket', async (c: Context) => {
		const principal = c.get('principal') as Principal | undefined;
		const requestId = c.get('requestId');
		if (principal === undefined) return problemResponse('unauthenticated', requestId);

		let body: { session_id?: unknown; ttl_seconds?: unknown; mode?: unknown; origin?: unknown } = {};
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			// An empty body means "the default session".
		}
		const sessionId = typeof body.session_id === 'string' && body.session_id !== '' ? body.session_id : 'default';

		// `mode: "view"` (or `"watch"`) narrows the ticket below the principal's ceiling; anything else that is not
		// `"control"` is refused here, before the scope checks.
		const requestedMode = body.mode === 'view' || body.mode === 'watch' || body.mode === 'control'
			? body.mode
			: undefined;
		if (body.mode !== undefined && requestedMode === undefined) {
			return problemResponse('invalid-request', requestId, 'mode must be "view" or "control"');
		}

		// `ttl_seconds` reaches the mint as milliseconds; a value that is not a finite number reaches it as `NaN`,
		// which the mint refuses after the scope checks, so a caller without the scope learns that first.
		const ttlMs = body.ttl_seconds === undefined
			? undefined
			: typeof body.ttl_seconds === 'number' && Number.isFinite(body.ttl_seconds)
			? body.ttl_seconds * 1000
			: Number.NaN;
		// The origin a longer-lived ticket is bound to: the request's own `Origin` header, else an explicit `origin` in
		// the body. The mint validates it.
		const requestOrigin = c.req.header('origin') ?? null;
		const bodyOrigin = typeof body.origin === 'string' ? body.origin : null;
		// A body `origin` binds the ticket exactly as an `Origin` header does, but the front's per-token narrowing
		// reads only the header — so a credential whose overlay excludes an origin could otherwise bind a ticket to it
		// by naming it here instead.
		if (requestOrigin === null && bodyOrigin !== null) {
			const declared = origins?.forToken(principal.id) ?? [];
			if (declared.length > 0 && !originAllowed(bodyOrigin, effectiveOrigins(config.allowedOrigins, declared))) {
				return problemResponse('origin-forbidden', requestId, 'this credential narrows the allowed origins');
			}
		}

		const minted = mintLiveTicket({ registry, tickets }, {
			principal: {
				id: principal.id,
				scopes: principal.scopes,
				holderName: holderNameOf(principal, keyRecords()),
				credential: principal.credential,
			},
			sessionId,
			mode: requestedMode,
			ttlMs,
			origin: requestOrigin ?? bodyOrigin,
			// The caller's access, which the mint looks the session up with and stamps on the ticket.
			access: { owner: expansionOwner(principal), admin: principal.scopes.has('admin') },
		});
		if (!minted.ok) return problemResponse(minted.slug, requestId, minted.detail);
		const { record, mode } = minted;
		const declared = origins?.forToken(principal.id) ?? [];
		return c.json({
			ticket: record.ticket,
			session_id: sessionId,
			expires_in: Math.round((record.expiresAt - Date.now()) / 1000),
			mode,
			// Echoed as granted: a client must not assume its request was honoured.
			ttl_seconds: Math.round(record.ttlMs / 1000),
			origin_bound: record.originBound,
			holder_name: record.holderName,
			// The effective list, not the requested one, and the overlay's own health beside it: a caller must not have
			// to assume either.
			allowed_origins: effectiveOrigins(config.allowedOrigins, declared),
			overlay_status: origins?.status ?? 'absent',
		}, 201);
	});

	// --- the socket --------------------------------------------------------
	app.get('/live/:sessionId/ws', async (c: Context) => {
		const requestId = c.get('requestId');
		const sessionId = c.req.param('sessionId') ?? '';
		const ticket = new URL(c.req.url).searchParams.get('ticket') ?? '';

		// A request that is not an upgrade is answered before the ticket is looked at, so it cannot burn one.
		if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a WebSocket upgrade', { status: 426 });
		}

		// The upgrade's own `Origin` header is what a bound ticket is checked against.
		const redemption = tickets.redeem(ticket, sessionId, c.req.header('origin') ?? null);
		if (!redemption.ok) {
			const slug = redemption.reason === 'consumed'
				? 'ticket-consumed'
				: redemption.reason === 'expired'
				? 'ticket-expired'
				: redemption.reason === 'origin-mismatch'
				? 'origin-forbidden'
				: 'ticket-invalid';
			return problemResponse(slug, requestId, `live-view ticket ${redemption.reason}`);
		}

		let record: SessionRecord;
		try {
			// Resolved with the minter's access, as the ticket recorded it — in `owner` mode `default` is the minter's
			// own default and another owner's session is unknown; a ticket minted with no access finds nothing.
			record = await registry.resolve(sessionId === 'default' ? undefined : sessionId, redemption.record.access);
		} catch {
			return problemResponse('unknown-session', requestId, `no session ${sessionId}`);
		}

		// The minting decision is re-earned at the upgrade, not trusted for the life of the ticket — as the MCP Apps
		// embed sockets do.
		const scopesNow = liveTicketScopesNow(redemption.record, deps.authorize);
		const mode = scopesNow === 'unchecked'
			? redemption.record.mode
			: scopesNow === null
			? null
			: liveModeAllowed(redemption.record.mode, scopesNow);
		if (mode === null) {
			return problemResponse('forbidden-scope', requestId, 'the credential that minted this ticket no longer may');
		}

		// Judged on the open viewers *and* the seats reserved by upgrades not yet open, and reserved below in the same
		// synchronous step.
		if (record.viewers.size + (pendingSeats.get(record) ?? 0) >= config.limits.maxViewersPerSession) {
			return problemResponse('rate-limited', requestId, 'too many viewers on this session');
		}
		// The per-principal connection ceiling, shared with the event streams — two independent ceilings would disagree
		// about what one principal may hold.
		if (connections !== undefined && !connections.admitPrincipal(redemption.record.principal)) {
			return problemResponse('rate-limited', requestId, 'too many live connections for this principal', {
				'retry-after': '5',
			});
		}

		// A reservation taken above must not outlive a failed upgrade: an upgrade that throws would otherwise hold one
		// of the principal's eight slots for the life of the process, and eight such requests would lock the principal
		// out of both transports with nothing attached.
		pendingSeats.set(record, (pendingSeats.get(record) ?? 0) + 1);
		let upgraded: { socket: WebSocket; response: Response };
		try {
			upgraded = Deno.upgradeWebSocket(c.req.raw);
		} catch (cause) {
			connections?.releasePrincipal(redemption.record.principal);
			releaseSeat(record);
			throw cause;
		}
		const { socket, response } = upgraded;
		const minted = redemption.record;
		const viewer = new Viewer({
			socket,
			version,
			mode,
			principal: minted.principal,
			holderName: minted.holderName,
			record,
			registry,
			config,
			logger,
			cast: castFor(record),
			scopesNow: () => liveTicketScopesNow(minted, deps.authorize),
			revalidateMs: deps.revalidateMs ?? EVENT_STREAM_REVALIDATE_MS,
			lifetimeMs: deps.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS,
			onSeat: () => releaseSeat(record),
			onOpen: (self) => open.add(self),
			onRelease: () => {
				open.delete(viewer);
				connections?.releasePrincipal(minted.principal);
			},
		});
		viewer.start();
		return response;
	});

	return {
		revalidateAll(): void {
			for (const viewer of [...open]) viewer.recheck();
		},
	};
}

interface ViewerOptions {
	readonly socket: WebSocket;
	/** This build's version, for the `meta` message. See `LiveViewDeps.version`. */
	readonly version: string;
	readonly mode: ViewMode;
	readonly principal: string;
	/** The credential's label, for the `lock` message. */
	readonly holderName: string | null;
	readonly record: SessionRecord;
	readonly registry: SessionRegistry;
	readonly config: Config;
	readonly logger: Logger;
	readonly cast: SessionCast;
	/** Releases this connection's per-principal slot. Runs once, on the single close path. */
	readonly onRelease?: () => void;
	/** What the minting credential may do now ({@linkcode liveTicketScopesNow}). Absent keeps the minted mode. */
	readonly scopesNow?: () => ReadonlySet<string> | null | 'unchecked';
	/** The re-check interval, and the life of a socket whose credential cannot be re-checked. */
	readonly revalidateMs?: number;
	readonly lifetimeMs?: number;
	/** Returns the seat the upgrade reserved. Runs once: at open, when the seat becomes a viewer, or at close. */
	readonly onSeat?: () => void;
	/** Runs once the socket is open and registered, so credential changes can reach it. */
	readonly onOpen?: (viewer: Viewer) => void;
}

/** The largest text frame a viewer may send, in UTF-16 code units, before it is closed with 1009. */
export const MAX_VIEWER_FRAME_CHARS = 64 * 1024;

/**
 * The WebSocket close for a viewer whose credential may no longer watch: the code and reason the MCP Apps embed sockets
 * close with (`embed_streams.ts`); no `bye` precedes it, because the live view's `bye` reasons are a closed wire enum
 * and none of them means this.
 */
const UNAUTHORIZED_CLOSE = { code: 4001, reason: 'unauthorized' } as const;

/** One attached live-view connection. */
class Viewer implements LiveViewerHandle {
	readonly id = ulid();
	/**
	 * Not readonly: a credential that loses `view:control` while the socket is open narrows it to `watch` (and its lock
	 * is released). It never widens.
	 */
	mode: ViewMode;
	readonly principal: string;
	readonly holderName: string | null;
	readonly #socket: WebSocket;
	readonly #record: SessionRecord;
	readonly #registry: SessionRegistry;
	readonly #config: Config;
	readonly #logger: Logger;
	readonly #cast: SessionCast;
	readonly #version: string;
	#detach: (() => void) | null = null;
	/** This viewer's cast subscription, kept so `live.keyframe` can be answered to this socket alone. */
	#subscriber: CastSubscriber | null = null;
	#release: (() => void) | null = null;
	#ping: ReturnType<typeof setInterval> | null = null;
	/** This socket's event subscription, or `null` while it has none. */
	#events: SocketEventPump | null = null;
	#lastPongAt = Date.now();
	/** Whether this socket has ever answered a `ping`. */
	#pongCapable = false;
	#seq = 0;
	/** Frames skipped because this viewer's socket was behind. */
	dropped = 0;
	readonly #scopesNow: () => ReadonlySet<string> | null | 'unchecked';
	readonly #revalidateMs: number;
	readonly #lifetimeMs: number;
	#seat: (() => void) | null;
	readonly #onOpened: ((viewer: Viewer) => void) | null;
	/** The credential re-check and the lifetime cap; both cleared on the one close path. */
	#recheckTimer: ReturnType<typeof setInterval> | null = null;
	#lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
	/** Set once this viewer has been told to end; a late `onopen` then closes instead of attaching. */
	#ending = false;
	/** One hit test in flight per viewer; `live.hover` arrives at pointer rate and the rest are dropped. */
	#hovering = false;

	constructor(options: ViewerOptions) {
		this.mode = options.mode;
		this.principal = options.principal;
		this.holderName = options.holderName;
		this.#socket = options.socket;
		this.#record = options.record;
		this.#registry = options.registry;
		this.#config = options.config;
		this.#cast = options.cast;
		this.#version = options.version;
		this.#release = options.onRelease ?? null;
		this.#logger = options.logger.with({ viewer: this.id, session: options.record.id });
		this.#scopesNow = options.scopesNow ?? (() => 'unchecked');
		this.#revalidateMs = options.revalidateMs ?? EVENT_STREAM_REVALIDATE_MS;
		this.#lifetimeMs = options.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS;
		this.#seat = options.onSeat ?? null;
		this.#onOpened = options.onOpen ?? null;
	}

	start(): void {
		this.#socket.binaryType = 'arraybuffer';
		this.#socket.onopen = () => this.#onOpen();
		this.#socket.onmessage = (event) => this.#onMessage(event);
		// Disconnect is detected here, never via `request.signal`: on Deno that signal fires when a response is
		// delivered, not when the peer goes away.
		this.#socket.onclose = () => this.#onClose();
		this.#socket.onerror = () => this.#onClose();
		// An open socket is a cached authorization decision, so it re-earns it on the gateway's horizon (and from
		// `revalidateAll` on every credential change).
		this.#recheckTimer = setInterval(() => this.recheck(), this.#revalidateMs);
		Deno.unrefTimer(this.#recheckTimer);
		if (this.#scopesNow() === 'unchecked') {
			this.#lifetimeTimer = setTimeout(() => this.#terminate(1000, 'stream-expired'), this.#lifetimeMs);
			Deno.unrefTimer(this.#lifetimeTimer);
		}
	}

	/**
	 * Re-checks what the minting credential may do now. Gone, or holding neither view scope: the socket closes
	 * ({@linkcode UNAUTHORIZED_CLOSE}).
	 */
	recheck(): void {
		if (this.#ending) return;
		const scopes = this.#scopesNow();
		if (scopes === 'unchecked') return;
		const allowed = scopes === null ? null : liveModeAllowed(this.mode, scopes);
		if (allowed === null) {
			this.#logger.info('live viewer closed: the credential that opened it no longer may watch');
			this.#terminate(UNAUTHORIZED_CLOSE.code, UNAUTHORIZED_CLOSE.reason);
			return;
		}
		if (allowed !== this.mode) {
			this.#logger.info('live viewer narrowed to watch: the credential that opened it no longer may control');
			this.mode = allowed;
			this.#registry.releaseControl(this.#record, this.id);
		}
	}

	/** Closes the socket with `code` and no `bye` (the reasons here are not in the live view's `bye` enum). */
	#terminate(code: number, reason: string): void {
		if (this.#ending) return;
		this.#ending = true;
		// Control goes at once rather than when the close handshake completes: input is refused from this moment.
		this.#registry.releaseControl(this.#record, this.id);
		try {
			this.#socket.close(code, reason);
		} catch { /* already closing, or not yet open: `#onOpen` sees `#ending` */ }
	}

	send(message: unknown): void {
		if (this.#socket.readyState !== WebSocket.OPEN) return;
		this.#socket.send(JSON.stringify(message));
	}

	close(reason: string): void {
		// The registry closes for reasons the wire's `bye` does not name (`browser-crashed`, already sent as an `error`
		// frame): to a viewer those are a closed session, so the message stays inside the contract.
		const bye = reason === 'server-shutdown' || reason === 'idle-timeout' ? reason : 'session-closed';
		this.#emit({ type: 'bye', reason: bye });
		try {
			this.#socket.close(1000, reason);
		} catch { /* already closing */ }
	}

	#emit(message: ServerMsg): void {
		this.send(message);
	}

	#onOpen(): void {
		if (this.#ending) {
			// Ended before it opened (a credential change raced the upgrade): it never becomes a viewer.
			try {
				this.#socket.close(UNAUTHORIZED_CLOSE.code, UNAUTHORIZED_CLOSE.reason);
			} catch { /* already closing */ }
			return;
		}
		this.#registry.addViewer(this.#record, this);
		// The reserved seat becomes this entry in `record.viewers`.
		this.#releaseSeat();
		this.#onOpened?.(this);
		// The viewport the frames are of: the cast's last frame when it has one, else the cached page info, else the
		// screencast bound itself.
		const known = this.#cast.lastSize;
		const viewport = {
			w: known?.w ?? this.#record.session.cachedBrowserState?.pageInfo.viewportWidth ?? CAST_MAX_WIDTH,
			h: known?.h ?? this.#record.session.cachedBrowserState?.pageInfo.viewportHeight ?? CAST_MAX_HEIGHT,
		};
		this.#emit({
			type: 'meta',
			sessionId: this.#record.id,
			viewerId: this.id,
			mode: this.mode,
			viewport,
			tabs: tabsOf(this.#record.session),
			lock: this.#record.lock,
			version: this.#version,
			frame_scale: this.#cast.frameScaleFor(viewport.w, viewport.h),
		});

		this.#subscriber = {
			onFrame: (jpeg, size) => this.#onFrame(jpeg, size),
			// `quality` and `viewport` are unsolicited, and a client that predates them may not handle them, so they
			// flow only to a socket that opted in with `events.subscribe`; the reply to this socket's own
			// `live.quality` goes through the handler directly.
			onEvent: (message) => {
				if ((message.type === 'quality' || message.type === 'viewport') && this.#events === null) return;
				this.#emit(message);
			},
		};
		this.#detach = this.#cast.attach(this.#subscriber);

		this.#ping = setInterval(() => this.#heartbeat(), PING_INTERVAL_MS);
		Deno.unrefTimer(this.#ping);
		// A credential change between the upgrade and the open reached no open-set entry; judge it here.
		this.recheck();
	}

	#heartbeat(): void {
		// Two tiers, chosen by whether this socket has ever proven it can answer. See PONG_GRACE_MS: a silent socket is
		// not evidence of a dead one.
		const deadline = pongDeadlineMs(this.#pongCapable);
		if (Date.now() - this.#lastPongAt > deadline) {
			this.#logger.warn('live viewer unresponsive; closing', {
				pong_capable: this.#pongCapable,
				deadline_ms: deadline,
			});
			this.close('idle-timeout');
			return;
		}
		// Through `#emit`, so it is typed as a member of the server-message union.
		this.#emit({ type: 'ping' });
	}

	#onFrame(jpegBase64: string, size: { w: number; h: number; targetId: string; scale: number }): void {
		if (this.#socket.readyState !== WebSocket.OPEN) return;
		// Drop rather than queue: a slow viewer must never become backpressure on the CDP reader (the frame is still
		// acked upstream).
		if (this.#socket.bufferedAmount > BACKPRESSURE_BYTES) {
			this.dropped += 1;
			return;
		}
		this.#seq += 1;
		const payload = encodeFrame(
			{
				type: 'frame',
				seq: this.#seq,
				ts: Date.now(),
				w: size.w,
				h: size.h,
				targetId: size.targetId,
				scale: size.scale,
			},
			decodeBase64(jpegBase64),
		);
		this.#socket.send(payload);
	}

	async #onMessage(event: MessageEvent): Promise<void> {
		this.#lastPongAt = Date.now();
		if (this.#ending) return;
		// The size is judged before anything parses the frame. Binary frames carry nothing a client sends, so they stay
		// ignored, but not at any size.
		const size = typeof event.data === 'string'
			? event.data.length
			: event.data instanceof ArrayBuffer
			? event.data.byteLength
			: 0;
		if (size > MAX_VIEWER_FRAME_CHARS) {
			this.#logger.warn('live viewer sent an oversized frame; closing', { size });
			this.#terminate(1009, 'frame-too-large');
			return;
		}
		if (typeof event.data !== 'string') return;

		let message: ClientMsg;
		try {
			message = ClientMsgSchema.parse(JSON.parse(event.data));
		} catch {
			// `bad-message` with `reason: 'schema'`: the code a client already handles, and the reason saying which
			// kind of malformed it was.
			this.#emit({ type: 'error', code: 'bad-message', message: 'unrecognised message', reason: 'schema' });
			return;
		}

		// The keep-alive answer.
		if (message.type === 'pong') {
			this.#pongCapable = true;
			return;
		}

		if (message.type === 'control.take') {
			if (this.mode !== 'control') {
				this.#emit({ type: 'error', code: 'not-holder', message: 'this viewer is watch-only' });
				return;
			}
			if (!this.#registry.takeControl(this.#record, this)) {
				this.#emit({ type: 'error', code: 'lock-held', message: 'another viewer holds control' });
			}
			return;
		}

		if (message.type === 'control.release') {
			this.#registry.releaseControl(this.#record, this.id);
			return;
		}

		// **`events.subscribe` needs no lock and no control mode.** Reading what happened to a session is what watching
		// *is*; the lock guards mutation.
		if (message.type === 'events.subscribe') {
			// A second subscribe replaces the first rather than opening a second pump: two cursors interleaved into one
			// ordered stream would destroy the ordering that is the contract.
			this.#events?.stop();
			this.#events = SocketEventPump.open({
				ring: this.#record.events,
				send: (outbound) => this.#emit(outbound),
				// Backpressure gaps rather than queues: while the socket is behind, the pump stops reading and the ring
				// turns over under a stationary cursor, so the next successful read leads with a `gap`.
				ready: () => this.#socket.readyState === WebSocket.OPEN && this.#socket.bufferedAmount <= BACKPRESSURE_BYTES,
				producing: PRODUCING_EVENT_KINDS,
				...(message.kinds === undefined ? {} : { kinds: message.kinds }),
				...(message.since === undefined ? {} : { since: message.since }),
				logger: this.#logger,
			});
			return;
		}

		if (message.type === 'events.unsubscribe') {
			this.#events?.stop();
			this.#events = null;
			return;
		}

		// **`live.hover` needs no lock either.** It reads what is under a point through the browser's own hit test —
		// the same read `browser_element_at` performs — and answers this socket alone.
		if (message.type === 'live.hover') {
			// One hit test in flight per viewer.
			if (this.#hovering) return;
			this.#hovering = true;
			try {
				await this.#hover(message.id, message.x, message.y);
			} finally {
				this.#hovering = false;
			}
			return;
		}

		// **`live.keyframe` needs nothing**: it asks for the frame the server already holds, answered to this socket
		// alone. A cache lookup, not a capture, except in the cold window right after a retarget.
		if (message.type === 'live.keyframe') {
			if (this.#subscriber !== null && !this.#cast.keyframe(this.#subscriber)) {
				this.#emit({
					type: 'error',
					code: 'not-ready',
					message: 'no frame is cached yet; the next paint of this tab will be sent as an ordinary frame',
				});
			}
			return;
		}

		// **`live.quality` needs control mode, not the lock**: the stream is shared by every viewer of the session, so
		// a watch-only ticket may not change what everyone receives.
		if (message.type === 'live.quality') {
			if (this.mode !== 'control') {
				this.#emit({ type: 'error', code: 'not-holder', message: 'this viewer is watch-only' });
				return;
			}
			const effective = await this.#cast.setQuality(message);
			this.#emit({
				type: 'quality',
				scale: effective.scale,
				jpeg_quality: effective.jpegQuality,
				max_fps: effective.maxFps,
			});
			return;
		}

		// **`live.highlight` needs control mode, not the lock.** The outline is drawn on the screen every viewer of the
		// session watches, so a watch-only ticket may not paint it; but it is not page input, so holding the lock is
		// not required.
		if (message.type === 'live.highlight') {
			if (this.mode !== 'control') {
				this.#emit({ type: 'error', code: 'not-holder', message: 'this viewer is watch-only' });
				return;
			}
			try {
				await highlight(this.#record, {
					...(message.index === undefined ? {} : { index: message.index }),
					...(message.bounds === undefined ? {} : { bounds: message.bounds }),
				}, message.ttl_ms);
			} catch (cause) {
				this.#logger.debug(`live highlight failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
			return;
		}

		// Everything below mutates the page, so it requires the lock.
		if (this.#record.lock?.holder !== this.id) {
			this.#emit({ type: 'error', code: 'not-holder', message: 'take control before sending input' });
			return;
		}

		try {
			await this.#dispatchInput(message);
			// What `browser_get_session` reports as `last_input_at`: an agent waiting out `human-has-control` reads it to
			// tell a person at work from one who took control and walked away.
			this.#record.lastInputAt = Date.now();
		} catch (cause) {
			this.#logger.warn(`live input failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			this.#emit({ type: 'error', code: 'internal', message: 'the browser refused that input' });
		}
	}

	/** Answers `live.hover` with the element under the point, or `null`; a failure is a null answer, not a closed socket. */
	async #hover(id: string, x: number, y: number): Promise<void> {
		try {
			const answer = await elementAtPoint(this.#record, x, y, new Set(FIELD_PRESETS.core));
			this.#emit({
				type: 'hover',
				id,
				element: answer.element,
				frame_id: answer.element === null ? null : answer.hit.frameId,
			});
		} catch (cause) {
			// A disconnected session or a mid-navigation read answers "nothing here" rather than an error: a hover is a
			// best-effort read at pointer rate, and a client that got an error per pixel would learn nothing from it.
			this.#logger.debug(`live hover failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			this.#emit({ type: 'hover', id, element: null, frame_id: null });
		}
	}

	/** The browser refused a navigation's document request before sending it. Origin only. */
	#emitNavigationBlocked(origin: string): void {
		this.#emit({
			type: 'error',
			code: 'navigation-blocked',
			message: `${origin} is not in the server's allowed-domain list`,
		});
	}

	/** Answers a well-formed input this server could not carry out. */
	#reject(reason: WsErrorReason, message: string): void {
		this.#logger.warn(`live input rejected (${reason}): ${message}`);
		this.#emit({ type: 'error', code: 'input-rejected', message, reason });
	}

	async #dispatchInput(message: ClientMsg): Promise<void> {
		const session = this.#record.session;
		const client = session.cdpClient;
		const manager = session.sessionManager;
		const focus = session.agentFocusTargetId;
		// Each of these three branches answers with its reason: returning silently would leave a viewer that has taken
		// control typing into a void with no way to learn it.
		if (client === null || manager === null) {
			this.#reject('session-not-connected', 'this session has no browser connection right now');
			return;
		}
		if (focus === null) {
			this.#reject('no-focused-tab', 'this session has no focused tab to send input to');
			return;
		}
		// Coordinates are caller-supplied numbers, and the schema bounds them only as numbers.
		if (message.type === 'input.mouse' || message.type === 'input.wheel') {
			const page = this.#record.session.cachedBrowserState?.pageInfo;
			if (page !== undefined && page !== null) {
				const width = page.viewportWidth + OUT_OF_RANGE_MARGIN_PX;
				const height = page.viewportHeight + OUT_OF_RANGE_MARGIN_PX;
				if (
					!Number.isFinite(message.x) || !Number.isFinite(message.y) ||
					message.x < -OUT_OF_RANGE_MARGIN_PX || message.y < -OUT_OF_RANGE_MARGIN_PX ||
					message.x > width || message.y > height
				) {
					this.#reject(
						'out-of-range',
						`(${message.x}, ${message.y}) is outside the ${page.viewportWidth}x${page.viewportHeight} viewport`,
					);
					return;
				}
			}
		}

		const cdp = await manager.getOrCreateCdpSession(focus, true);

		switch (message.type) {
			case 'input.mouse': {
				const button = message.button ?? 'left';
				const common = { x: message.x, y: message.y, button, clickCount: message.clickCount ?? 1 };
				if (message.kind === 'click') {
					await client.send.Input.dispatchMouseEvent({ ...common, type: 'mousePressed' }, cdp.sessionId);
					await client.send.Input.dispatchMouseEvent({ ...common, type: 'mouseReleased' }, cdp.sessionId);
					return;
				}
				const type = message.kind === 'down' ? 'mousePressed' : message.kind === 'up' ? 'mouseReleased' : 'mouseMoved';
				await client.send.Input.dispatchMouseEvent({ ...common, type }, cdp.sessionId);
				return;
			}
			case 'input.wheel': {
				await client.send.Input.dispatchMouseEvent({
					type: 'mouseWheel',
					x: message.x,
					y: message.y,
					deltaX: message.deltaX,
					deltaY: message.deltaY,
				}, cdp.sessionId);
				return;
			}
			case 'input.key': {
				const modifiers = modifierBits(message.modifiers);
				const spec = resolveKeySpec(message.key, message.windowsVirtualKeyCode);
				if (spec === null) {
					this.#reject('unsupported-key', `no key named ${JSON.stringify(message.key.slice(0, 32))}`);
					return;
				}
				// Every field the page's own `KeyboardEvent` is built from, including the `windowsVirtualKeyCode` this
				// path never sent. The client's own values win where it supplied them.
				const base = {
					key: message.key,
					code: message.code ?? spec.code,
					windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
					nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
					location: message.location ?? spec.location,
					...(message.autoRepeat === undefined ? {} : { autoRepeat: message.autoRepeat }),
					...(modifiers === 0 ? {} : { modifiers }),
				};
				// A chord suppresses insertion: Ctrl+A selects, it does not type an 'a'. The agent's own path makes the
				// same choice from the same predicate, which is what keeps the two reproducible from each other.
				const text = suppressesText(modifiers) ? undefined : message.text ?? spec.text ?? undefined;
				// `rawKeyDown` rather than `keyDown` when no text is inserted: Chrome derives `keypress` from a
				// `keyDown` carrying text, and a `keyDown` with none still produces one for some keys.
				const downType = text === undefined ? 'rawKeyDown' : 'keyDown';
				if (message.kind === 'press') {
					await client.send.Input.dispatchKeyEvent({
						...base,
						type: downType,
						...(text === undefined ? {} : { text, unmodifiedText: text }),
					}, cdp.sessionId);
					await client.send.Input.dispatchKeyEvent({ ...base, type: 'keyUp' }, cdp.sessionId);
					return;
				}
				if (message.kind === 'down') {
					await client.send.Input.dispatchKeyEvent({
						...base,
						type: downType,
						...(text === undefined ? {} : { text, unmodifiedText: text }),
					}, cdp.sessionId);
					return;
				}
				await client.send.Input.dispatchKeyEvent({ ...base, type: 'keyUp' }, cdp.sessionId);
				return;
			}
			case 'input.composition': {
				// `imeSetComposition` drives the in-progress state the page renders; the commit is an `insertText`,
				// which is what ends the composition and fires `compositionend`.
				if (message.kind === 'commit') {
					// `insertText` while a composition is active is what *commits* it: Chrome ends the composition and
					// fires `compositionend` carrying the inserted text, which is the event a page's own IME handling
					// listens for.
					if (message.text !== '') {
						await client.send.Input.insertText({ text: message.text }, cdp.sessionId);
						return;
					}
					await client.send.Input.imeSetComposition(
						{ text: '', selectionStart: 0, selectionEnd: 0 },
						cdp.sessionId,
					);
					return;
				}
				if (message.kind === 'cancel') {
					await client.send.Input.imeSetComposition(
						{ text: '', selectionStart: 0, selectionEnd: 0 },
						cdp.sessionId,
					);
					return;
				}
				await client.send.Input.imeSetComposition({
					text: message.text,
					selectionStart: message.selectionStart ?? message.text.length,
					selectionEnd: message.selectionEnd ?? message.text.length,
				}, cdp.sessionId);
				return;
			}
			case 'navigate': {
				// The same policy the MCP tool enforces, from the same function: a human taking control is not a way
				// around the deployment's egress rules, and two copies of that rule would eventually disagree.
				let url: URL;
				try {
					url = assertNavigable(message.url, this.#config.allowedDomains);
				} catch (cause) {
					this.#emit({
						type: 'error',
						code: 'navigation-blocked',
						message: cause instanceof Error ? cause.message : 'that URL is not allowed',
					});
					return;
				}
				// Through the session's own event rather than a raw `Page.navigate`: that is what runs the browser
				// layer's pre-navigation veto, waits for the load, and dispatches `NavigationCompleteEvent` — which is
				// how the *other* viewers watching this session learn the page changed.
				const targetId = session.agentFocusTargetId;
				const since = this.#registry.now();
				// Only this navigation's own chain — the one that began at `url` — before the tab committed.
				const refused = (): string | null =>
					blockedSince(this.#record, targetId ?? session.agentFocusTargetId, since, url.href);
				try {
					await session.eventBus.dispatch(new NavigateToUrlEvent({ url: url.href }))
						.eventResult({ raiseIfAny: true });
				} catch (cause) {
					const origin = refused();
					if (origin === null) throw cause;
					this.#emitNavigationBlocked(origin);
					return;
				}
				const origin = refused();
				if (origin !== null) this.#emitNavigationBlocked(origin);
				return;
			}
			case 'tab.switch': {
				const known = session.tabs.some((tab) => String(tab.tabId) === message.tabId);
				if (!known) {
					this.#emit({ type: 'error', code: 'bad-message', message: `unknown tab ${message.tabId}` });
					return;
				}
				// Through the session's own event rather than `Target.activateTarget`: CDP does not resolve the
				// four-character tab id a viewer is shown, and raw activation leaves `agentFocusTargetId` pointing at
				// the old tab, so the screencast would keep streaming the page the human just navigated away from.
				await session.eventBus.dispatch(new SwitchTabEvent({ targetId: message.tabId as TargetId }))
					.eventResult({ raiseIfAny: true });
				return;
			}
		}
	}

	#onClose(): void {
		this.#ending = true;
		if (this.#ping !== null) {
			clearInterval(this.#ping);
			this.#ping = null;
		}
		if (this.#recheckTimer !== null) {
			clearInterval(this.#recheckTimer);
			this.#recheckTimer = null;
		}
		if (this.#lifetimeTimer !== null) {
			clearTimeout(this.#lifetimeTimer);
			this.#lifetimeTimer = null;
		}
		// A socket that closed before it opened still holds its reserved seat; this returns it (a no-op after open).
		this.#releaseSeat();
		// The one deregistration path for the subscription too: disconnect is detected here and never through
		// `request.signal`, which on Deno fires when the response is delivered.
		this.#events?.stop();
		this.#events = null;
		this.#detach?.();
		this.#detach = null;
		this.#subscriber = null;
		// One release, on the one close path both `onclose` and `onerror` reach.
		this.#release?.();
		this.#release = null;
		this.#registry.removeViewer(this.#record, this.id);
	}

	/** Returns the upgrade's seat reservation, exactly once. */
	#releaseSeat(): void {
		const seat = this.#seat;
		this.#seat = null;
		seat?.();
	}
}

/** The only URL form the live-view socket carries: origin plus path. */
export function viewUrl(url: string): string {
	const target = navigationTarget(url);
	return `${target.origin}${target.path}`;
}

/** A title with the navigation URL's query and fragment removed — when the title *is* that URL. */
export function viewTitle(title: string, url: string): string {
	const cut = title.search(/[?#]/);
	if (cut === -1) return title;
	// Chromium's fallback carries **no scheme**, so one is assumed for the parse and both sides are compared without
	// it: `app.example/x` and `https://app.example/x` are the same page, and a scheme-sensitive comparison would
	// quietly match nothing on every https page — which is to say, on every page where this matters.
	const bare = (value: string) => value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(title) ? title : `http://${title}`;
	const reduced = viewUrl(candidate);
	return reduced !== '' && bare(reduced) === bare(viewUrl(url)) ? title.slice(0, cut) : title;
}

/** Flattens a `Page.FrameTree` into the address-row list, top document first. */
export function framesOfTree(
	node: { frame: { id: string; url: string; name?: string }; childFrames?: unknown },
	parentId: string | null = null,
): StateFrame[] {
	const out: StateFrame[] = [{
		frame_id: node.frame.id,
		parent_id: parentId,
		// Origin plus path, never the query or the fragment. A frame URL carries a token exactly as readily as a
		// top-level one.
		url: viewUrl(node.frame.url),
		name: node.frame.name ?? '',
	}];
	const children = Array.isArray(node.childFrames) ? node.childFrames : [];
	for (const child of children) {
		out.push(...framesOfTree(child as { frame: { id: string; url: string; name?: string } }, node.frame.id));
	}
	return out;
}

/** The tab list as viewers see it, with focus resolved on the full target id. */
export function tabsOf(session: BrowserSession): TabInfo[] {
	const focus = session.agentFocusTargetId;
	return session.tabs.map((tab) => ({
		tabId: String(tab.tabId),
		// Origin plus path, never the query or fragment. See `viewUrl`.
		url: viewUrl(tab.url),
		// And the same for a title that *is* the URL, which is what Chromium gives a page with no `<title>`. See
		// `viewTitle`.
		title: viewTitle(tab.title, tab.url),
		focused: tab.targetId === focus,
	}));
}

interface CastSubscriber {
	readonly onFrame: (jpegBase64: string, size: { w: number; h: number; targetId: string; scale: number }) => void;
	readonly onEvent: (message: ServerMsg) => void;
}

interface SessionCastOptions {
	readonly record: SessionRecord;
	readonly quality: number;
	readonly logger: Logger;
	/** Called when the last subscriber leaves, so the owner can forget the cast. */
	readonly onEmpty: () => void;
}

/** The session's frame stream, shared by every viewer watching it. */
class SessionCast {
	readonly #options: SessionCastOptions;
	readonly #subscribers = new Set<CastSubscriber>();
	readonly #unsubscribes: Array<() => void> = [];
	#frameOff: (() => void) | null = null;
	#tabsTimer: ReturnType<typeof setTimeout> | null = null;
	/** The most recent frame, replayed to anything that attaches later and to `live.keyframe`. */
	#lastFrame: { data: string; size: { w: number; h: number; targetId: string; scale: number } } | null = null;
	/** The viewport of the last frame, so a change can be announced (`viewport`). */
	#lastSize: { w: number; h: number } | null = null;
	/** The effective screencast settings (`live.quality`); `scale` bounds the frame, not the page. */
	#quality: CastQuality;
	#target: TargetId | null = null;
	/** Serializes retargeting so two focus changes cannot interleave. */
	#pending: Promise<void> = Promise.resolve();
	/** Serialises `state` broadcasts, separately from the screencast queue. */
	#stateChain: Promise<void> = Promise.resolve();
	#stopped = false;

	constructor(options: SessionCastOptions) {
		this.#options = options;
		this.#quality = { scale: 1, jpegQuality: options.quality, maxFps: CAST_COMPOSITOR_FPS };
		this.#watchSession();
	}

	/** The viewport of the last frame, or `null` before the first. */
	get lastSize(): { w: number; h: number } | null {
		return this.#lastSize;
	}

	/** The effective settings after clamping. */
	get quality(): CastQuality {
		return this.#quality;
	}

	/** The screencast bound at the current `scale`. */
	get bound(): { maxWidth: number; maxHeight: number } {
		return {
			maxWidth: Math.max(1, Math.round(CAST_MAX_WIDTH * this.#quality.scale)),
			maxHeight: Math.max(1, Math.round(CAST_MAX_HEIGHT * this.#quality.scale)),
		};
	}

	/** `frame_scale` for a viewport under the current bound. */
	frameScaleFor(w: number, h: number): number {
		const { maxWidth, maxHeight } = this.bound;
		return frameScaleFor(w, h, maxWidth, maxHeight);
	}

	/** Answers one subscriber with the current frame (`live.keyframe`). */
	keyframe(subscriber: CastSubscriber): boolean {
		if (this.#lastFrame === null) return false;
		subscriber.onFrame(this.#lastFrame.data, this.#lastFrame.size);
		return true;
	}

	/**
	 * Applies a `live.quality` request: clamps it, restarts the screencast under the new bound when something changed,
	 * and tells every subscriber the effective values. Returns them.
	 */
	async setQuality(
		requested: { scale?: number | undefined; jpeg_quality?: number | undefined; max_fps?: number | undefined },
	): Promise<CastQuality> {
		const next = clampQuality(this.#quality, requested);
		const changed = next.scale !== this.#quality.scale || next.jpegQuality !== this.#quality.jpegQuality ||
			next.maxFps !== this.#quality.maxFps;
		this.#quality = next;
		if (changed) {
			// The cached frame was encoded under the previous bound, so it is not an answer to `live.keyframe`: a
			// viewer would receive a frame whose `scale` contradicts the one just granted.
			this.#lastFrame = null;
		}
		if (changed && this.#target !== null) {
			// A restart, serialised behind any retarget in flight: `stop` clears the target so the next `retarget`
			// starts the screencast again under the new bound.
			const restart = new Promise<void>((resolve) => {
				this.#enqueue(async () => {
					await this.#stop();
					await this.#retarget();
					resolve();
				});
			});
			await restart;
		}
		this.#broadcast({ type: 'quality', scale: next.scale, jpeg_quality: next.jpegQuality, max_fps: next.maxFps });
		return next;
	}

	/** Subscribes a viewer; the returned function detaches it. */
	attach(subscriber: CastSubscriber): () => void {
		this.#subscribers.add(subscriber);
		if (this.#subscribers.size === 1) {
			this.#watchTargets();
			this.#enqueue(() => this.#retarget());
		} else if (this.#lastFrame !== null) {
			// A second subscriber gets the current screen at once.
			const frame = this.#lastFrame;
			queueMicrotask(() => {
				if (this.#subscribers.has(subscriber)) subscriber.onFrame(frame.data, frame.size);
			});
		}
		return () => {
			this.#subscribers.delete(subscriber);
			if (this.#subscribers.size === 0) {
				this.#stopped = true;
				if (this.#tabsTimer !== null) {
					clearTimeout(this.#tabsTimer);
					this.#tabsTimer = null;
				}
				this.#enqueue(() => this.#stop());
				for (const off of this.#unsubscribes.splice(0)) off();
				this.#options.onEmpty();
			}
		};
	}

	/** Subscribes to the session's own events. */
	#watchSession(): void {
		const bus = this.#options.record.session.eventBus;
		const broadcast = (message: ServerMsg) => this.#broadcast(message);
		const session = this.#options.record.session;

		const guard = <E>(handler: (event: E) => void) => (event: E) => {
			try {
				handler(event);
			} catch (cause) {
				this.#options.logger.warn(`live session watcher failed: ${String(cause)}`);
			}
		};

		this.#unsubscribes.push(
			bus.on(
				AgentFocusChangedEvent,
				guard((event: AgentFocusChangedEvent) => {
					this.#enqueue(() => this.#retarget());
					broadcast({ type: 'tabs', tabs: tabsOf(session) });
					// Origin plus path, never the query or the fragment — on the title as well, which Chromium fills
					// with the URL when a page has none. See `viewUrl` and `viewTitle`.
					this.#broadcastState(
						viewUrl(event.url),
						viewTitle(tabTitle(session, event.targetId), event.url),
					);
				}),
			),
			bus.on(TabCreatedEvent, guard(() => broadcast({ type: 'tabs', tabs: tabsOf(session) }))),
			bus.on(
				TabClosedEvent,
				guard(() => {
					// A closed tab may have been the one being streamed.
					this.#enqueue(() => this.#retarget());
					broadcast({ type: 'tabs', tabs: tabsOf(session) });
				}),
			),
			bus.on(
				NavigationCompleteEvent,
				guard((event: NavigationCompleteEvent) => {
					// Origin plus path on both fields (see `viewUrl` and `viewTitle`), and the frame list, read live
					// once the navigation has completed.
					this.#broadcastState(
						viewUrl(event.url),
						viewTitle(tabTitle(session, event.targetId), event.url),
					);
					broadcast({ type: 'tabs', tabs: tabsOf(session) });
				}),
			),
		);
	}

	/** Follows Chrome's own view of the targets. */
	#watchTargets(): void {
		const session = this.#options.record.session;
		const client = session.cdpClient;
		if (client === null) return;
		const off = client.on('Target.targetInfoChanged', (params) => {
			if (params.targetInfo.type !== 'page') return;
			this.#scheduleTabsBroadcast();
		});
		this.#unsubscribes.push(off);
	}

	#scheduleTabsBroadcast(): void {
		if (this.#tabsTimer !== null) return;
		this.#tabsTimer = setTimeout(() => {
			this.#tabsTimer = null;
			this.#enqueue(async () => {
				const session = this.#options.record.session;
				// Resync first: the map's titles lag the browser, and a tab listing whose titles are wrong is the one a
				// human squints at.
				await session.sessionManager?.resyncTargets().catch(() => {});
				this.#broadcast({ type: 'tabs', tabs: tabsOf(session) });
			});
		}, TABS_COALESCE_MS);
		Deno.unrefTimer(this.#tabsTimer);
	}

	#broadcast(message: ServerMsg): void {
		for (const subscriber of this.#subscribers) {
			try {
				subscriber.onEvent(message);
			} catch { /* a dead socket is removed by its own close path */ }
		}
	}

	#enqueue(work: () => Promise<void>): void {
		this.#pending = this.#pending.then(work).catch((cause: unknown) => {
			this.#options.logger.warn(`screencast step failed: ${String(cause)}`);
		});
	}

	/** Broadcasts one `state` message with the focused tab's frame list. */
	#broadcastState(url: string, title: string): void {
		this.#stateChain = this.#stateChain
			.then(async () => {
				const frames = await this.#readFrames();
				this.#broadcast({ type: 'state', url, title, ...(frames === null ? {} : { frames }) });
			})
			.catch((cause: unknown) => {
				this.#options.logger.warn(`state broadcast failed: ${String(cause)}`);
			});
	}

	/** The focused tab's frame list, or `null` when it cannot be read right now. */
	async #readFrames(): Promise<StateFrame[] | null> {
		const session = this.#options.record.session;
		const client = session.cdpClient;
		const manager = session.sessionManager;
		const focus = session.agentFocusTargetId;
		if (client === null || manager === null || focus === null) return null;

		type Tree = { frame: { id: string; url: string; name?: string; parentId?: string }; childFrames?: unknown };
		let frames: StateFrame[];
		try {
			const cdp = await manager.getOrCreateCdpSession(focus, false);
			const { frameTree } = await client.send.Page.getFrameTree({}, cdp.sessionId);
			frames = framesOfTree(frameTree as Tree);
		} catch {
			// The target may have gone between the navigation and this read. Not an error a viewer needs to see: the
			// next navigation reads it again.
			return null;
		}

		// Read each out-of-process frame's own tree once, then attach the ones whose parent is in the set, repeating
		// while the set grows.
		const pending: Array<{ tree: Tree; parentId: string }> = [];
		for (const [targetId, target] of manager.targets) {
			if (target.type !== 'iframe') continue;
			try {
				const cdp = await manager.getOrCreateCdpSession(targetId, false);
				const { frameTree } = await client.send.Page.getFrameTree({}, cdp.sessionId);
				const tree = frameTree as Tree;
				const parentId = tree.frame.parentId;
				if (parentId !== undefined) pending.push({ tree, parentId });
			} catch {
				// A frame that detached between the target listing and this read is simply not in the list. One missing
				// frame must not cost the others.
			}
		}

		const known = new Set(frames.map((frame) => frame.frame_id));
		for (let grew = true; grew;) {
			grew = false;
			for (let i = pending.length - 1; i >= 0; i--) {
				const entry = pending[i] as { tree: Tree; parentId: string };
				if (!known.has(entry.parentId)) continue;
				pending.splice(i, 1);
				for (const frame of framesOfTree(entry.tree, entry.parentId)) {
					if (known.has(frame.frame_id)) continue;
					known.add(frame.frame_id);
					frames.push(frame);
				}
				grew = true;
			}
		}
		return frames;
	}

	/** Points the stream at whatever target the session is focused on now. */
	async #retarget(): Promise<void> {
		if (this.#stopped || this.#subscribers.size === 0) return;
		const session = this.#options.record.session;
		const client = session.cdpClient;
		const manager = session.sessionManager;
		const focus = session.agentFocusTargetId;
		if (client === null || manager === null || focus === null) return;
		if (focus === this.#target && this.#frameOff !== null) return;

		await this.#stop();
		if (this.#stopped) return;
		// A frame from the previous target is not the current screen.
		this.#lastFrame = null;

		const cdp = await manager.getOrCreateCdpSession(focus, true);
		this.#frameOff = client.on('Page.screencastFrame', (params, sessionId) => {
			const frame = params as {
				data: string;
				sessionId: number;
				metadata?: { deviceWidth?: number; deviceHeight?: number };
			};
			const w = frame.metadata?.deviceWidth ?? 0;
			const h = frame.metadata?.deviceHeight ?? 0;
			const size = { w, h, targetId: focus as string, scale: this.frameScaleFor(w, h) };
			this.#lastFrame = { data: frame.data, size };
			// The viewport changed (or this is the first frame): announce it with the recomputed scale, so a client
			// that opted in never has to infer a resize from the JPEG.
			if (this.#lastSize === null || this.#lastSize.w !== w || this.#lastSize.h !== h) {
				this.#lastSize = { w, h };
				this.#broadcast({ type: 'viewport', w, h, frame_scale: size.scale });
			}
			for (const subscriber of this.#subscribers) {
				try {
					subscriber.onFrame(frame.data, size);
				} catch { /* one bad viewer must not stop the stream */ }
			}
			// Ack unconditionally, including for frames a viewer dropped: flow control belongs to CDP, not to any one
			// viewer's bandwidth.
			client.send.Page.screencastFrameAck({ sessionId: frame.sessionId }, sessionId).catch((error: unknown) => {
				this.#options.logger.warn(`screencast ack failed: ${String(error)}`);
			});
		});

		const { maxWidth, maxHeight } = this.bound;
		await client.send.Page.startScreencast({
			format: 'jpeg',
			quality: this.#quality.jpegQuality,
			maxWidth,
			maxHeight,
			everyNthFrame: Math.max(1, Math.round(CAST_COMPOSITOR_FPS / this.#quality.maxFps)),
		}, cdp.sessionId);
		this.#target = focus;
	}

	async #stop(): Promise<void> {
		this.#frameOff?.();
		this.#frameOff = null;
		const previous = this.#target;
		this.#target = null;
		if (previous === null) return;
		const session = this.#options.record.session;
		const client = session.cdpClient;
		const manager = session.sessionManager;
		if (client === null || manager === null) return;
		try {
			const cdp = await manager.getOrCreateCdpSession(previous, false);
			await client.send.Page.stopScreencast({}, cdp.sessionId);
		} catch {
			// The target may already be gone; nothing to stop.
		}
	}
}

/** The title of a target, or an empty string when it is not (yet) known. */
function tabTitle(session: BrowserSession, targetId: string): string {
	return session.tabs.find((tab) => tab.targetId === targetId)?.title ?? '';
}
