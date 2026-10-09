/**
 * The live browser view: ticket minting, the WebSocket, the screencast pump,
 * and human input injection.
 *
 * This is the piece the donor project reserved but never built (its
 * `/sessions/:id/live` returned 501); the frame producer is vendored, the
 * transport and the input path are ours.
 *
 * See SPECS/ARCHITECTURE.md §3.3 and SPECS/API-CONTRACT.md §5.
 */
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
import { expansionOwner, holderNameOf, type Principal } from './auth.ts';
import type { Logger } from './logger.ts';
import { problemResponse } from './problem.ts';
import { type EventStreamRegistry, PRODUCING_EVENT_KINDS } from './eventstream.ts';
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
/**
 * How far outside the last-known viewport a pointer may still land (B1.11).
 *
 * A margin rather than a hard edge: the cached page info lags a resize, and
 * refusing a legitimate click during that window would be worse than accepting
 * one a few pixels out.
 */
const OUT_OF_RANGE_MARGIN_PX = 64;

/** Ping cadence. */
const PING_INTERVAL_MS = 15_000;

/**
 * How long a socket may stay silent before it is closed as unresponsive — in two tiers (B6.1, F1).
 *
 * The keep-alive is an application-level JSON `ping`, not a WebSocket control frame: a standard
 * `WebSocket` has no `ping()` to send and no `pong` event to receive, so **the peer's browser does
 * not answer it automatically**. Until 0.2.0 the bookkeeping below was refreshed only by an inbound
 * message, which in practice meant only by a client that was *driving*. A viewer that merely watched
 * — the live view's whole purpose, and ADM's stated workflow — sent nothing for 45 seconds and was
 * closed every time.
 *
 * So a client now answers with `{type:'pong'}`, and the deadline depends on whether this one ever
 * has:
 *
 * - **`PONG_GRACE_MS`** until the first pong arrives. A socket that has never ponged may be a 0.1.0
 *   consumer, a non-browser client, or a page that simply watches; none of them can be told apart
 *   from a dead one, so all of them are given a long, forgiving window.
 * - **`PONG_TIMEOUT_MS`** after it. A client that has ponged once has *proven* it answers on the
 *   15-second cadence, so silence for three intervals means the socket is genuinely gone and the
 *   per-principal connection slot it holds should be freed rather than parked for five minutes.
 *
 * The tier matters because those slots are capped (`SPECS/API-CONTRACT.md` §7): holding a half-open
 * socket 6.6× longer would make a client's own reconnect loop far likelier to exhaust its budget.
 */
export const PONG_GRACE_MS = 300_000;
export const PONG_TIMEOUT_MS = 45_000;

/**
 * How long this socket may stay silent before it is reaped, given what it has
 * shown it can do. Exported so the tier is asserted against the shipped values
 * rather than against a copy of the rule in a test.
 */
export function pongDeadlineMs(pongCapable: boolean): number {
	return pongCapable ? PONG_TIMEOUT_MS : PONG_GRACE_MS;
}

/**
 * The screencast's bound at `scale: 1` (B2.3, D-A6). `frame_scale` is computed against these two
 * numbers and the frame's own `deviceWidth/deviceHeight`, never inferred from the JPEG.
 */
export const CAST_MAX_WIDTH = 1280;
export const CAST_MAX_HEIGHT = 720;
/** Chromium's compositor rate the `max_fps` ceiling is expressed against (`everyNthFrame`). */
const CAST_COMPOSITOR_FPS = 60;

/** The effective screencast settings, after clamping (B2.3 `live.quality`). */
export interface CastQuality {
	readonly scale: number;
	readonly jpegQuality: number;
	readonly maxFps: number;
}

/**
 * The factor a frame of a `w × h` CSS-px viewport is scaled by under a `maxW × maxH` bound: the
 * smaller of the two ratios, and never above 1 because Chromium does not upscale. Exported so the
 * gateway, the tests and the acceptance row share one arithmetic (AC-P0-38).
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

/**
 * Folds a client's `modifiers` into the CDP bitmask.
 *
 * An array is accepted as well as the bitmask (B1.11), folded through the very
 * table the agent's own typing path uses. An empty array is legal and means no
 * modifiers.
 */
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

/**
 * Resolves one live-view key into the spec CDP actually needs.
 *
 * **This is the B1.11 repair.** The Live-View path forwarded `{key, code?}` and
 * set no `windowsVirtualKeyCode`, so every keystroke a human sent arrived at the
 * page with `event.keyCode === 0`: a page that switches on `keyCode` — which is
 * most pages with a keyboard shortcut, and every `Enter`-to-submit handler that
 * predates `key` — saw nothing it recognised. The tables that fix it already
 * existed and were already used by the agent's own typing path; the socket
 * simply never reached them, so a human and a tool pressing the same key sent
 * the page two different events.
 *
 * `null` means the name resolves to no key, which is answered rather than
 * dispatched: a key the server cannot describe would otherwise be dispatched
 * with `keyCode` 0 and *look* delivered.
 */
export function resolveKeySpec(key: string, override?: number): KeySpec | null {
	const named = keySpecForName(key);
	const spec = named ?? ([...key].length === 1 ? keySpecForCharacter(key) : null);
	if (spec === null) {
		// A client that knows the code may still name a key this server's tables do
		// not: it says so explicitly rather than being guessed at.
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

/**
 * The frame streams, one per session.
 *
 * Separate from route registration because two things need it at two different
 * times: the recorder is built early (the MCP handler takes it as a dependency)
 * while the live-view routes must be registered *after* the auth middleware, or
 * they would answer before a principal exists.
 */
export interface CastRegistry {
	/** The shared cast for a session, created on first use. */
	castFor(record: SessionRecord): SessionCast;
	/**
	 * Attaches a raw frame consumer to a session's screencast (R7).
	 *
	 * The recorder uses this rather than opening a second screencast: Chrome
	 * produces one frame stream per target, and a second subscriber acking the
	 * same frame would race CDP's one-un-acked-frame flow control. It also means
	 * a recording follows tab switches for free, because the cast does.
	 */
	subscribe(sessionId: string, onFrame: (jpegBase64: string) => void): Promise<() => void>;
}

export function createCastRegistry(deps: CastRegistryDeps): CastRegistry {
	const { config, registry, logger } = deps;
	// One screencast per *session*, not per viewer: Chrome produces a single
	// frame stream per target, and a second subscriber acking the same frame is
	// a race over CDP's one-un-acked-frame flow control. Viewers fan out from it.
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
			// The cast starts its screencast lazily on first attach; give it a
			// moment so `start` does not report success before any frame can flow.
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
	/**
	 * This build's version, as it reaches a viewer's `meta` message.
	 *
	 * **It was a hard-coded `'0.1.0'` here** and therefore not the package version
	 * at all: `PKG_VERSION` reaches the wire twice — the `McpServer` identity and
	 * this field — and one of the two never moved. A client reading `meta.version`
	 * to decide what the socket supports would have been told 0.1.0 forever.
	 * `SPECS/COMPLETIONS-CRITERIA.md` records that nothing enforces version
	 * agreement; this makes the second of the two values real, and `units_test.ts`
	 * asserts the nine `deno.json` files and `VERSION` all agree (AC-GATE-12).
	 */
	readonly version?: string;
	/**
	 * The per-token origin overlay (B1.10).
	 *
	 * The ticket response echoes the **effective** list and the overlay's own
	 * health, for the same reason SEC-18 requires it to echo the granted TTL: a
	 * client must not have to assume its request was granted, and a degraded
	 * overlay must be visible to the caller rather than indistinguishable from an
	 * empty one.
	 */
	readonly origins?: OriginOverlay;
	/**
	 * The API-key records in force **right now**, for the `holder_name` a ticket
	 * publishes.
	 *
	 * A function rather than an array since SR2-M3: the record set is reloadable
	 * from the key file, so a snapshot taken at attach time would keep naming a
	 * holder whose credential had since been revoked or relabelled. Defaults to
	 * the startup configuration, which is what a caller that has no verifier —
	 * every test that builds this route directly — should see.
	 */
	readonly keyRecords?: () => readonly ApiKeyRecord[];
}

/**
 * Who a live ticket is minted for (F21): the principal id the per-principal ceilings count, its scopes, and the
 * `holder_name` its lock message shows, resolved by the caller, which holds the full principal and the key records.
 * S0 seam: the REST route fills it from its `Principal`; W7's embed mint fills it from `EmbedTicketInput`.
 */
export interface LiveTicketHolder {
	readonly id: string;
	readonly scopes: ReadonlySet<Scope>;
	readonly holderName: string | null;
}

/** What {@linkcode mintLiveTicket} reads (design §2.0 item 13). */
export interface MintLiveTicketDeps {
	readonly registry: SessionRegistry;
	readonly tickets: TicketStore;
	/** The key records in force. Kept in the contract's shape; unread since F21 moved the holder name to the caller. */
	readonly keyRecords: () => readonly ApiKeyRecord[];
}

/** One live-ticket request, already parsed off its transport (design §2.0 item 13). */
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
	/** The caller's session access (R8): the session is looked up with it and the ticket carries it. */
	readonly access?: SessionAccess;
}

/** A minted ticket and its granted mode, or the problem slug and detail the caller answers with. */
export type MintLiveTicketResult =
	| { ok: true; record: TicketRecord; mode: ViewMode }
	| { ok: false; slug: 'forbidden-scope' | 'invalid-request' | 'unknown-session'; detail: string };

/**
 * The live-ticket mint, off its HTTP route (design §2.0 item 13). S0 extraction, behaviour identical to
 * `POST /api/v1/live/ticket`: the route keeps body parsing and the response, and W7's MCP Apps embed mints through
 * the same checks (mode ceiling from the scopes, TTL clamp by mode, origin binding above the default TTL, an
 * existing session). The session is looked up through `access` (R8, D-128) — in `owner` mode another owner's session
 * is `unknown-session` — and the ticket carries it, so the upgrade resolves the session as the minter would have.
 */
export function mintLiveTicket(deps: MintLiveTicketDeps, input: MintLiveTicketInput): MintLiveTicketResult {
	const { principal } = input;
	// The mode is the principal's ceiling, narrowed on request (B2.3, SEC-18): `mode: "view"`
	// (or `"watch"`) mints a ticket that can never take control, even for a principal that could.
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

	// A TTL is a request, clamped by the mode's ceiling (view 300 s, control 60 s) and always echoed
	// as granted. Above the 30 s default the ticket must be origin-bound.
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

	// A ticket for a session that does not exist would fail at upgrade, by
	// which point the client has no useful error channel.
	if (input.sessionId !== 'default' && deps.registry.peekFor(input.sessionId, input.access) === undefined) {
		return { ok: false, slug: 'unknown-session', detail: `no session ${input.sessionId}` };
	}

	const record = deps.tickets.mint(principal.id, input.sessionId, mode, {
		ttlMs,
		holderName: principal.holderName,
		origin: originBound,
		access: input.access,
	});
	return { ok: true, record, mode };
}

export function attachLiveView(deps: LiveViewDeps): void {
	const { app, config, registry, tickets, logger, casts, connections, origins } = deps;
	const keyRecords = deps.keyRecords ?? (() => config.apiKeys);
	const version = deps.version ?? '0.0.0-unknown';
	const castFor = (record: SessionRecord) => casts.castFor(record);

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

		// `mode: "view"` (or `"watch"`) narrows the ticket below the principal's ceiling (B2.3, SEC-18); anything
		// else that is not `"control"` is refused here, before the scope checks, as it always was.
		const requestedMode = body.mode === 'view' || body.mode === 'watch' || body.mode === 'control'
			? body.mode
			: undefined;
		if (body.mode !== undefined && requestedMode === undefined) {
			return problemResponse('invalid-request', requestId, 'mode must be "view" or "control"');
		}

		// `ttl_seconds` reaches the mint as milliseconds; a value that is not a finite number reaches it as `NaN`, which
		// the mint refuses after the scope checks, the order this route has always answered in.
		const ttlMs = body.ttl_seconds === undefined
			? undefined
			: typeof body.ttl_seconds === 'number' && Number.isFinite(body.ttl_seconds)
			? body.ttl_seconds * 1000
			: Number.NaN;
		// The origin a longer-lived ticket is bound to: the request's own `Origin` header, else an explicit `origin`
		// in the body. The mint validates it.
		const requestOrigin = c.req.header('origin') ?? null;
		const bodyOrigin = typeof body.origin === 'string' ? body.origin : null;
		// Review R1-3: a body `origin` binds the ticket exactly as an `Origin` header does, but the front's per-token
		// narrowing (B1.10) reads only the header — so a credential whose overlay excludes an origin could still bind a
		// ticket to it by naming it here instead. Narrowed the same way, with the front's own refusal. Only ever
		// narrower: a credential with no overlay entry is unchanged, and the header (judged at the front) still wins.
		if (requestOrigin === null && bodyOrigin !== null) {
			const declared = origins?.forToken(principal.id) ?? [];
			if (declared.length > 0 && !originAllowed(bodyOrigin, effectiveOrigins(config.allowedOrigins, declared))) {
				return problemResponse('origin-forbidden', requestId, 'this credential narrows the allowed origins');
			}
		}

		const minted = mintLiveTicket({ registry, tickets, keyRecords }, {
			principal: { id: principal.id, scopes: principal.scopes, holderName: holderNameOf(principal, keyRecords()) },
			sessionId,
			mode: requestedMode,
			ttlMs,
			origin: requestOrigin ?? bodyOrigin,
			// R8 (D-128): the caller's access, which the mint looks the session up with and stamps on the ticket.
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
			// Echoed as granted (SEC-18): a client must not assume its request was honoured.
			ttl_seconds: Math.round(record.ttlMs / 1000),
			origin_bound: record.originBound,
			holder_name: record.holderName,
			// The effective list, not the requested one, and the overlay's own
			// health beside it: a caller must not have to assume either.
			allowed_origins: effectiveOrigins(config.allowedOrigins, declared),
			overlay_status: origins?.status ?? 'absent',
		}, 201);
	});

	// --- the socket --------------------------------------------------------
	app.get('/live/:sessionId/ws', async (c: Context) => {
		const requestId = c.get('requestId');
		const sessionId = c.req.param('sessionId') ?? '';
		const ticket = new URL(c.req.url).searchParams.get('ticket') ?? '';

		// F2: a request that is not an upgrade is answered before the ticket is looked at, so it cannot burn one.
		if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('expected a WebSocket upgrade', { status: 426 });
		}

		// The upgrade's own `Origin` header is what a bound ticket is checked against (B2.3, SEC-18).
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
			// R8 (D-128): resolved with the minter's access, as the ticket recorded it — in `owner` mode `default` is the
			// minter's own default and another owner's session is unknown; a ticket minted with no access finds nothing.
			record = await registry.resolve(sessionId === 'default' ? undefined : sessionId, redemption.record.access);
		} catch {
			return problemResponse('unknown-session', requestId, `no session ${sessionId}`);
		}

		if (record.viewers.size >= config.limits.maxViewersPerSession) {
			return problemResponse('rate-limited', requestId, 'too many viewers on this session');
		}
		// The per-principal ceiling API-CONTRACT §7 has published since 0.1.0,
		// enforced for the first time and shared with the event streams — two
		// independent ceilings would disagree about what one principal may hold.
		// Reserved **synchronously**, here rather than in the socket's `onopen`,
		// because a check whose increment lands a task later admits every
		// concurrent upgrade that raced it.
		if (connections !== undefined && !connections.admitPrincipal(redemption.record.principal)) {
			return problemResponse('rate-limited', requestId, 'too many live connections for this principal', {
				'retry-after': '5',
			});
		}

		// A reservation taken above must not outlive a failed upgrade: an upgrade
		// that throws would otherwise hold one of the principal's eight slots for
		// the life of the process, and eight such requests would lock the
		// principal out of both transports with nothing attached.
		let upgraded: { socket: WebSocket; response: Response };
		try {
			upgraded = Deno.upgradeWebSocket(c.req.raw);
		} catch (cause) {
			connections?.releasePrincipal(redemption.record.principal);
			throw cause;
		}
		const { socket, response } = upgraded;
		const viewer = new Viewer({
			socket,
			version,
			mode: redemption.record.mode,
			principal: redemption.record.principal,
			holderName: redemption.record.holderName,
			record,
			registry,
			config,
			logger,
			cast: castFor(record),
			...(connections === undefined
				? {}
				: { onRelease: () => connections.releasePrincipal(redemption.record.principal) }),
		});
		viewer.start();
		return response;
	});
}

interface ViewerOptions {
	readonly socket: WebSocket;
	/** This build's version, for the `meta` message. See `LiveViewDeps.version`. */
	readonly version: string;
	readonly mode: ViewMode;
	readonly principal: string;
	/** The credential's label, for the `lock` message (B2.3). */
	readonly holderName: string | null;
	readonly record: SessionRecord;
	readonly registry: SessionRegistry;
	readonly config: Config;
	readonly logger: Logger;
	readonly cast: SessionCast;
	/** Releases this connection's per-principal slot. Runs once, on the single close path. */
	readonly onRelease?: () => void;
}

/** One attached live-view connection. */
class Viewer implements LiveViewerHandle {
	readonly id = ulid();
	readonly mode: ViewMode;
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
	/** This socket's event subscription, or `null` while it has none (B1.8). */
	#events: SocketEventPump | null = null;
	#lastPongAt = Date.now();
	/**
	 * Whether this socket has ever answered a `ping` (B6.1, F1).
	 *
	 * Latches true on the first `pong` and never returns to false: the point is
	 * to remember that this peer *is able* to answer, so that later silence can be
	 * read as death rather than as watching. See PONG_GRACE_MS.
	 */
	#pongCapable = false;
	#seq = 0;
	/** Frames skipped because this viewer's socket was behind. */
	dropped = 0;

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
	}

	start(): void {
		this.#socket.binaryType = 'arraybuffer';
		this.#socket.onopen = () => this.#onOpen();
		this.#socket.onmessage = (event) => this.#onMessage(event);
		// Disconnect is detected here, never via `request.signal`: on Deno that
		// signal fires when a response is delivered, not when the peer goes away.
		this.#socket.onclose = () => this.#onClose();
		this.#socket.onerror = () => this.#onClose();
	}

	send(message: unknown): void {
		if (this.#socket.readyState !== WebSocket.OPEN) return;
		this.#socket.send(JSON.stringify(message));
	}

	close(reason: string): void {
		this.#emit({ type: 'bye', reason: reason as ServerMsg extends { reason: infer R } ? R : never });
		try {
			this.#socket.close(1000, reason);
		} catch { /* already closing */ }
	}

	#emit(message: ServerMsg): void {
		this.send(message);
	}

	#onOpen(): void {
		this.#registry.addViewer(this.#record, this);
		// The viewport the frames are of: the cast's last frame when it has one, else the cached page
		// info, else the screencast bound itself. `frame_scale` is computed against the same numbers
		// every frame is (B2.3, D-A6), never read off a JPEG.
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
			// `quality` and `viewport` are messages a 0.1.0 client never saw. They are unsolicited, so
			// they flow only to a socket that opted in with `events.subscribe`; the reply to this
			// socket's own `live.quality` goes through the handler directly.
			onEvent: (message) => {
				if ((message.type === 'quality' || message.type === 'viewport') && this.#events === null) return;
				this.#emit(message);
			},
		};
		this.#detach = this.#cast.attach(this.#subscriber);

		this.#ping = setInterval(() => this.#heartbeat(), PING_INTERVAL_MS);
		Deno.unrefTimer(this.#ping);
	}

	#heartbeat(): void {
		// Two tiers, chosen by whether this socket has ever proven it can answer.
		// See PONG_GRACE_MS: a silent socket is not evidence of a dead one.
		const deadline = pongDeadlineMs(this.#pongCapable);
		if (Date.now() - this.#lastPongAt > deadline) {
			this.#logger.warn('live viewer unresponsive; closing', {
				pong_capable: this.#pongCapable,
				deadline_ms: deadline,
			});
			this.close('idle-timeout');
			return;
		}
		// G-6: it goes through `#emit` now, so it is typed as the union member it
		// has always been in practice rather than an untyped frame beside it.
		this.#emit({ type: 'ping' });
	}

	#onFrame(jpegBase64: string, size: { w: number; h: number; targetId: string; scale: number }): void {
		if (this.#socket.readyState !== WebSocket.OPEN) return;
		// Drop rather than queue: a slow viewer must never become backpressure on
		// the CDP reader (the frame is still acked upstream).
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
		if (typeof event.data !== 'string') return;

		let message: ClientMsg;
		try {
			message = ClientMsgSchema.parse(JSON.parse(event.data));
		} catch {
			// `bad-message` is kept — an existing client's handling of it does not
			// change — and gains the half of "malformed" it was missing.
			this.#emit({ type: 'error', code: 'bad-message', message: 'unrecognised message', reason: 'schema' });
			return;
		}

		// The keep-alive answer (B6.1, F1). It has already refreshed `#lastPongAt`
		// above, as any inbound frame does; what it adds is the *evidence* that
		// this peer answers pings, which tightens its deadline from the grace
		// window to the three-interval one. Deliberately silent: a reply to a
		// keep-alive would be a keep-alive loop.
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

		// **`events.subscribe` needs no lock and no control mode.** Reading what
		// happened to a session is what watching *is*; the lock guards mutation.
		// What it does need is the content boundary, and that is enforced in
		// `socketevents.ts` by filtering through `WS_EVENT_KINDS` rather than here,
		// so a second transport cannot forget it.
		if (message.type === 'events.subscribe') {
			// A second subscribe replaces the first rather than opening a second
			// pump: two cursors interleaved into one ordered stream would destroy
			// the ordering that is the contract.
			this.#events?.stop();
			this.#events = SocketEventPump.open({
				ring: this.#record.events,
				send: (outbound) => this.#emit(outbound),
				// Backpressure gaps rather than queues: while the socket is behind,
				// the pump stops reading and the ring turns over under a stationary
				// cursor, so the next successful read leads with a `gap`.
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

		// **`live.hover` needs no lock either** (B2.1). It reads what is under a
		// point through the browser's own hit test — the same read
		// `browser_element_at` performs — and answers this socket alone. The
		// record is the `core` preset, built by the tool's own builder so the
		// password predicate has already run; nothing is written to the ring.
		if (message.type === 'live.hover') {
			await this.#hover(message.id, message.x, message.y);
			return;
		}

		// **`live.keyframe` needs nothing** (B2.3): it asks for the frame the server already holds,
		// answered to this socket alone. A cache lookup, not a capture, except in the cold window
		// right after a retarget.
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

		// **`live.quality` needs control mode, not the lock** (B2.3): the stream is shared by every
		// viewer of the session, so a watch-only ticket may not change what everyone receives. The
		// effective values are the reply, and other opted-in viewers learn of the change too.
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

		// **`live.highlight` needs control mode, not the lock** (B2.2). The outline
		// is drawn on the screen every viewer of the session watches, so a
		// watch-only ticket may not paint it; but it is not page input, so holding
		// the lock is not required. Best-effort and silent by contract: an overlay
		// failure draws nothing and answers nothing.
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
			// A disconnected session or a mid-navigation read answers "nothing here"
			// rather than an error: a hover is a best-effort read at pointer rate,
			// and a client that got an error per pixel would learn nothing from it.
			this.#logger.debug(`live hover failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			this.#emit({ type: 'hover', id, element: null, frame_id: null });
		}
	}

	/** R3 (F22): the browser refused a navigation's document request before sending it (E0). Origin only. */
	#emitNavigationBlocked(origin: string): void {
		this.#emit({
			type: 'error',
			code: 'navigation-blocked',
			message: `${origin} is not in the server's allowed-domain list`,
		});
	}

	/** Answers a well-formed input this server could not carry out (B1.11). */
	#reject(reason: WsErrorReason, message: string): void {
		this.#logger.warn(`live input rejected (${reason}): ${message}`);
		this.#emit({ type: 'error', code: 'input-rejected', message, reason });
	}

	async #dispatchInput(message: ClientMsg): Promise<void> {
		const session = this.#record.session;
		const client = session.cdpClient;
		const manager = session.sessionManager;
		const focus = session.agentFocusTargetId;
		// **G-7, the one genuinely silent drop.** These three branches used to
		// return with no error, no answer and no log: a viewer that had taken
		// control typed into a void and had no way to learn it. Each now says
		// which of the three it was.
		if (client === null || manager === null) {
			this.#reject('session-not-connected', 'this session has no browser connection right now');
			return;
		}
		if (focus === null) {
			this.#reject('no-focused-tab', 'this session has no focused tab to send input to');
			return;
		}
		// Coordinates are caller-supplied numbers, and the only bound on them today
		// is the schema's "is a number". A pointer event dispatched far outside the
		// viewport lands nowhere and reports nothing, which reads to a human as the
		// browser having ignored them. Checked only when a viewport is known, and
		// with a margin, because the cache lags a resize.
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
				// Every field the page's own `KeyboardEvent` is built from, including
				// the `windowsVirtualKeyCode` this path never sent. The client's own
				// values win where it supplied them.
				const base = {
					key: message.key,
					code: message.code ?? spec.code,
					windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
					nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
					location: message.location ?? spec.location,
					...(message.autoRepeat === undefined ? {} : { autoRepeat: message.autoRepeat }),
					...(modifiers === 0 ? {} : { modifiers }),
				};
				// A chord suppresses insertion: Ctrl+A selects, it does not type an
				// 'a'. The agent's own path makes the same choice from the same
				// predicate, which is what keeps the two reproducible from each other.
				const text = suppressesText(modifiers) ? undefined : message.text ?? spec.text ?? undefined;
				// `rawKeyDown` rather than `keyDown` when no text is inserted: Chrome
				// derives `keypress` from a `keyDown` carrying text, and a `keyDown`
				// with none still produces one for some keys.
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
				// R13. `imeSetComposition` drives the in-progress state the page
				// renders; the commit is an `insertText`, which is what ends the
				// composition and fires `compositionend`. A cancel is an empty
				// composition, per the CDP contract.
				if (message.kind === 'commit') {
					// `insertText` while a composition is active is what *commits*
					// it: Chrome ends the composition and fires `compositionend`
					// carrying the inserted text, which is the event a page's own
					// IME handling listens for. Clearing the composition first
					// would end it with empty data and then insert separately —
					// the page would see a cancel followed by an unexplained
					// insertion, which is not what happened.
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
				// The same policy the MCP tool enforces, from the same function: a
				// human taking control is not a way around the deployment's egress
				// rules, and two copies of that rule would eventually disagree.
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
				// Through the session's own event rather than a raw `Page.navigate`:
				// that is what runs the browser layer's pre-navigation veto, waits
				// for the load, and dispatches `NavigationCompleteEvent` — which is
				// how the *other* viewers watching this session learn the page
				// changed. A raw CDP call navigates silently and leaves every other
				// viewer's address bar showing the previous page.
				//
				// R3 (F22): a redirect hop the browser refused before sending it (E0) fails the navigation with
				// `net::ERR_ABORTED`, whose message carries the requested URL into `live input failed: …`. It is
				// answered instead with the existing `navigation-blocked` code naming the origin only, and nothing is
				// logged here — the registry already logged the block, by origin, throttled.
				const targetId = session.agentFocusTargetId;
				const since = this.#registry.now();
				// Review R2-2: only this navigation's own chain — the one that began at `url` — before the tab committed.
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
				// ERRATUM(E-15). This used to call `Target.activateTarget` with the
				// four-character tab id a viewer is shown, which CDP does not
				// resolve — and even had it worked, raw activation leaves
				// `agentFocusTargetId` pointing at the old tab, so the screencast
				// would have kept streaming the page the human just navigated away
				// from. Going through the session's own event moves focus, which
				// the cast follows.
				await session.eventBus.dispatch(new SwitchTabEvent({ targetId: message.tabId as TargetId }))
					.eventResult({ raiseIfAny: true });
				return;
			}
		}
	}

	#onClose(): void {
		if (this.#ping !== null) {
			clearInterval(this.#ping);
			this.#ping = null;
		}
		// The one deregistration path for the subscription too: disconnect is
		// detected here and never through `request.signal` (REJ-005).
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
}

/**
 * The only URL form the live-view socket carries: origin plus path.
 *
 * SR1-A5. Until this change the socket broadcast `event.url` verbatim — the
 * full navigation URL, query and fragment included — to every connection minted
 * on `view:watch`, while the same process's `navigation` event records were
 * already carrying origin plus path because `SPECS/SECURITY-AUTH.md` §8.3
 * forbids source URLs on the wire "(which may carry tokens)". An OAuth implicit
 * fragment or a magic-link query reached a watcher that holds no `mcp:invoke`.
 *
 * One rule now holds for **every** URL the socket emits — `state.url` and each
 * `TabInfo.url` alike — because a rule that covered one field and not the other
 * would leak the same secret through the tab list instead. It is deliberately
 * the same derivation `navigationTarget()` performs for the event records, so
 * there is one definition of what a URL is reduced to and not two.
 *
 * A URL that does not parse reduces to the empty string rather than passing
 * through: the raw string is the one thing that must not reach the socket.
 */
export function viewUrl(url: string): string {
	const target = navigationTarget(url);
	return `${target.origin}${target.path}`;
}

/**
 * A title with the navigation URL's query and fragment removed — when the title
 * *is* that URL.
 *
 * **Found by SR1-A5's own pinning test, after `state.url` and `TabInfo.url` were
 * already redacted.** Chromium supplies a page with no `<title>` — and a page
 * whose title has not loaded yet — with a fallback title that is its URL,
 * **query and fragment included**. So the very redaction this change exists to
 * make cost nothing was still handing the whole URL to a `view:watch` holder
 * through the field beside it. A rule that covered two of three URL-bearing
 * fields is not a rule.
 *
 * It is deliberately narrow: the query is cut **only** when the title parses as
 * the URL the browser is actually on. A page that titles itself with somebody
 * else's URL is publishing its own content, which is what a title has always
 * been and is not this server disclosing a navigation it performed. What is
 * removed here is exactly the part the server knows and the watcher was never
 * granted.
 */
export function viewTitle(title: string, url: string): string {
	const cut = title.search(/[?#]/);
	if (cut === -1) return title;
	// Chromium's fallback carries **no scheme**, so one is assumed for the parse
	// and both sides are compared without it: `app.example/x` and
	// `https://app.example/x` are the same page, and a scheme-sensitive
	// comparison would have quietly matched nothing on every https page — which
	// is to say, on every page where this matters.
	const bare = (value: string) => value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(title) ? title : `http://${title}`;
	const reduced = viewUrl(candidate);
	return reduced !== '' && bare(reduced) === bare(viewUrl(url)) ? title.slice(0, cut) : title;
}

/**
 * The tab list as viewers see it, with focus resolved on the full target id (E-14).
 *
 * Exported so the SR1-A5 redaction can be asserted on the value a socket would
 * actually receive rather than on the helper it happens to call.
 */
/**
 * Flattens a `Page.FrameTree` into the address-row list, top document first (B3.3).
 *
 * Exported so the SR1-A5 redaction can be asserted on the value a socket would actually receive,
 * exactly as it is for {@linkcode tabsOf}. `parent_id` comes from the tree's own shape rather than
 * from `Frame.parentId`, which CDP omits on the root and does not always populate on children.
 */
export function framesOfTree(
	node: { frame: { id: string; url: string; name?: string }; childFrames?: unknown },
	parentId: string | null = null,
): StateFrame[] {
	const out: StateFrame[] = [{
		frame_id: node.frame.id,
		parent_id: parentId,
		// SR1-A5: origin plus path, never the query or the fragment. A frame URL
		// carries a token exactly as readily as a top-level one.
		url: viewUrl(node.frame.url),
		name: node.frame.name ?? '',
	}];
	const children = Array.isArray(node.childFrames) ? node.childFrames : [];
	for (const child of children) {
		out.push(...framesOfTree(child as { frame: { id: string; url: string; name?: string } }, node.frame.id));
	}
	return out;
}

export function tabsOf(session: BrowserSession): TabInfo[] {
	const focus = session.agentFocusTargetId;
	return session.tabs.map((tab) => ({
		tabId: String(tab.tabId),
		// SR1-A5: origin plus path, never the query or fragment. See `viewUrl`.
		url: viewUrl(tab.url),
		// And the same for a title that *is* the URL, which is what Chromium gives
		// a page with no `<title>`. See `viewTitle`.
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

/**
 * The session's frame stream, shared by every viewer watching it.
 *
 * JPEG rather than PNG (an order of magnitude smaller per frame), and every
 * frame is acked: Chrome delivers at most one un-acked frame, so a missed ack
 * silently ends the stream rather than merely slowing it.
 *
 * It also follows the session. A screencast is bound to one CDP target, so when
 * focus moves — because the model called `browser_switch_tab`, because the page
 * opened a popup, or because the human switched tabs in the view — the stream
 * has to be torn down and restarted on the new target, or every viewer keeps
 * watching a tab nobody is on.
 */
class SessionCast {
	readonly #options: SessionCastOptions;
	readonly #subscribers = new Set<CastSubscriber>();
	readonly #unsubscribes: Array<() => void> = [];
	#frameOff: (() => void) | null = null;
	#tabsTimer: ReturnType<typeof setTimeout> | null = null;
	/** The most recent frame, replayed to anything that attaches later and to `live.keyframe`. */
	#lastFrame: { data: string; size: { w: number; h: number; targetId: string; scale: number } } | null = null;
	/** The viewport of the last frame, so a change can be announced (B2.3 `viewport`). */
	#lastSize: { w: number; h: number } | null = null;
	/** The effective screencast settings (B2.3 `live.quality`); `scale` bounds the frame, not the page. */
	#quality: CastQuality;
	#target: TargetId | null = null;
	/** Serializes retargeting so two focus changes cannot interleave. */
	#pending: Promise<void> = Promise.resolve();
	/**
	 * Serialises `state` broadcasts (B3.3), separately from the screencast queue.
	 *
	 * Each carries a frame list read from the browser, so each is asynchronous; without a chain, two
	 * navigations in quick succession could publish their address rows in the order their reads
	 * happened to finish rather than the order the page moved.
	 */
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

	/** `frame_scale` for a viewport under the current bound (D-A6). */
	frameScaleFor(w: number, h: number): number {
		const { maxWidth, maxHeight } = this.bound;
		return frameScaleFor(w, h, maxWidth, maxHeight);
	}

	/**
	 * Answers one subscriber with the current frame (B2.3 `live.keyframe`).
	 *
	 * **From the cache, and only from the cache — A-3's contingency, taken on the measurement.** The
	 * plan's rule was: if the cold-cache `Page.captureScreenshot` fallback measures worse than a
	 * screencast round trip on a heavy page, keyframe answers from the cache alone and reports a
	 * not-ready code for the post-retarget window rather than paying an unbounded cost. Measured on
	 * this rig against the tall fixture at 1920x993 (`build/evidence/b2_3_liveview_probe.log`): the
	 * cached answer averages **1 ms** and the capture averages **1341 ms** (417, 1608, 1698, 1330,
	 * 1653) — three orders of magnitude, on a path a viewer can drive at will and which would block the
	 * CDP session every other viewer's frames share. So the capture is not built.
	 *
	 * The cache is cold only in the window right after a retarget, and it fills as soon as the page
	 * paints; `false` here is answered with `error{code:'not-ready'}` rather than a wait, so a client
	 * knows to expect the next ordinary frame instead of assuming its request was lost.
	 */
	keyframe(subscriber: CastSubscriber): boolean {
		if (this.#lastFrame === null) return false;
		subscriber.onFrame(this.#lastFrame.data, this.#lastFrame.size);
		return true;
	}

	/**
	 * Applies a `live.quality` request (B2.3): clamps it, restarts the screencast under the new bound
	 * when something changed, and tells every subscriber the effective values. Returns them.
	 */
	async setQuality(
		requested: { scale?: number | undefined; jpeg_quality?: number | undefined; max_fps?: number | undefined },
	): Promise<CastQuality> {
		const next = clampQuality(this.#quality, requested);
		const changed = next.scale !== this.#quality.scale || next.jpegQuality !== this.#quality.jpegQuality ||
			next.maxFps !== this.#quality.maxFps;
		this.#quality = next;
		if (changed) {
			// The cached frame was encoded under the previous bound, so it is no longer an answer to
			// `live.keyframe`: a viewer would receive a frame whose `scale` contradicts the one just
			// granted. It is dropped rather than re-labelled, and the next paint refills it.
			this.#lastFrame = null;
		}
		if (changed && this.#target !== null) {
			// A restart, serialised behind any retarget in flight: `stop` clears the target so the next
			// `retarget` starts the screencast again under the new bound.
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
			// A second subscriber gets the current screen at once. Chrome emits a
			// screencast frame only when the page *paints*, and `startScreencast`
			// is not re-issued for an existing stream — so without this, anything
			// attaching to a settled page sees nothing at all until something
			// happens to change it. For a viewer that is a blank canvas; for a
			// recorder it is a video file with no frames in it.
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

	/**
	 * Subscribes to the session's own events.
	 *
	 * A live view that only ever showed what was true at connect time would be a
	 * screenshot with extra steps: tabs open and close, the model navigates, and
	 * a watching human has to see that happen.
	 */
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
					// SR1-A5: origin plus path, never the query or the fragment — on the
					// title as well, which Chromium fills with the URL when a page has
					// none. See `viewUrl` and `viewTitle`. B3.3 adds the frame list, which
					// is why this goes through `#broadcastState` rather than `broadcast`.
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
					// SR1-A5: origin plus path on both fields. See `viewUrl` and `viewTitle`.
					// B3.3: and the frame list, read live once the navigation has completed.
					this.#broadcastState(
						viewUrl(event.url),
						viewTitle(tabTitle(session, event.targetId), event.url),
					);
					broadcast({ type: 'tabs', tabs: tabsOf(session) });
				}),
			),
		);
	}

	/**
	 * Follows Chrome's own view of the targets.
	 *
	 * The session's events cover what the *session* did. They do not cover what
	 * a page did to itself: a popup opened by `window.open` fires
	 * `TabCreatedEvent` while its URL is still empty and then navigates on its
	 * own, and an in-page `location =` changes a tab's URL and title with no
	 * session event at all. Both are exactly what a watching human needs to see,
	 * so the raw CDP signal is the one to follow — coalesced, because Chrome
	 * emits several of these per navigation.
	 */
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
				// Resync first: the map's titles lag the browser (E-17), and a tab
				// listing whose titles are wrong is the one a human squints at.
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

	/**
	 * Broadcasts one `state` message with the focused tab's frame list (B3.3).
	 *
	 * **On its own chain, not `#enqueue`'s.** The screencast queue holds retargets — a `stopScreencast`
	 * and a `startScreencast` against a target that may be mid-navigation — and putting the address
	 * row behind that would delay the URL a human is reading by however long the stream takes to
	 * repoint. This chain guarantees the one thing that actually matters: that two navigations in
	 * quick succession cannot publish their `state` messages out of order, which an unchained
	 * fire-and-forget read would allow.
	 *
	 * The frame read never fails the message. `frames` is omitted when the tree cannot be read, which
	 * the schema documents as "not known" rather than "no frames" — a URL and title with no frame list
	 * is strictly better than no address row at all.
	 */
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

	/**
	 * The focused tab's frame list, or `null` when it cannot be read right now.
	 *
	 * Live `Page.getFrameTree` reads — no DOM capture. `browser_get_frames` pays for a capture
	 * because it reports composed bounds; an address row does not need them, and a capture on every
	 * navigation would be a cost the live view has never paid.
	 *
	 * **One read is not enough, and that was measured rather than assumed.** A frame in its own
	 * renderer process is *entirely absent* from the page session's tree: against a real OOPIF the
	 * page tree returned the top document alone, with no child and no placeholder
	 * (build/evidence/b3_3_oopif_frame_tree_probe.log). The frame's own target answers a tree rooted
	 * at it, and — this is the part that makes the splice possible — CDP populates `parentId` there,
	 * pointing at the host frame. So the list is the page tree plus every `iframe` target whose root
	 * parents into a frame already known.
	 *
	 * Growing the set by rounds rather than in one pass does two jobs at once: it keeps iframe
	 * targets belonging to *other tabs* out (their parents never join the set), and it admits an
	 * OOPIF nested inside another OOPIF, whose parent only becomes known once the outer one is read.
	 */
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
			// The target may have gone between the navigation and this read. Not an
			// error a viewer needs to see: the next navigation reads it again.
			return null;
		}

		// Read each out-of-process frame's own tree once, then attach the ones
		// whose parent is in the set, repeating while the set grows.
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
				// A frame that detached between the target listing and this read is
				// simply not in the list. One missing frame must not cost the others.
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
			// The viewport changed (or this is the first frame): announce it with the recomputed
			// scale, so a client that opted in never has to infer a resize from the JPEG.
			if (this.#lastSize === null || this.#lastSize.w !== w || this.#lastSize.h !== h) {
				this.#lastSize = { w, h };
				this.#broadcast({ type: 'viewport', w, h, frame_scale: size.scale });
			}
			for (const subscriber of this.#subscribers) {
				try {
					subscriber.onFrame(frame.data, size);
				} catch { /* one bad viewer must not stop the stream */ }
			}
			// Ack unconditionally, including for frames a viewer dropped: flow
			// control belongs to CDP, not to any one viewer's bandwidth.
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
