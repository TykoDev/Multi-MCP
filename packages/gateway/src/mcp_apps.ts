/**
 * MCP Apps, the gateway half (R9, design §2.20, D-134 – D-136).
 *
 * Two jobs, both behind `TTK_MCP_APPS`:
 *
 * 1. **The embed documents.** `scripts/build_embed.ts` writes `dist/embed_live.html` and `dist/embed_a2ui.html`,
 *    each one self-contained HTML file whose meta CSP pins its one inline script and one inline style by hash and
 *    leaves `connect-src` as the placeholder {@linkcode CONNECT_SRC_PLACEHOLDER}. They are read here once, through
 *    the resolver the static SPA uses, and the placeholder becomes the WebSocket origin of `TTK_PUBLIC_URL` — the
 *    only place an embed may connect to, and the same value `_meta.ui.csp.connectDomains` declares to the host.
 *    A missing document refuses startup: a deployment that turned the feature on must not offer tools whose embed
 *    cannot load.
 * 2. **The embed ticket.** `browser_live_ticket` mints through the same core the REST route uses
 *    (`mintLiveTicket`), so the scope ceiling, the TTL clamp, the origin binding and the session check cannot
 *    drift between the two. What this adds is narrowing only: the mode cannot exceed `TTK_MCP_APPS`, the origin must
 *    be one of `TTK_MCP_APPS_ORIGINS` — or, with that list empty (D-150), any `isAppsOrigin` origin — **and** allowed
 *    for this credential by `TTK_ALLOWED_ORIGINS` and the per-token overlay (F10), and every ticket is origin-bound,
 *    single-use and lives 30 s.
 *
 * No new HTTP route exists for any of this. The embed connects to the existing ticket-gated `/live/:sessionId/ws`,
 * whose front and adapter Origin checks admit the host's sandbox hostname only when `TTK_ALLOWED_ORIGINS` lists it —
 * which `loadConfig` already required of every listed origin here, and which the mint checks of an unlisted one.
 */
import { join } from '@std/path';
import {
	DEFAULT_SESSION_ID,
	type EmbedTicket,
	type EmbedTicketInput,
	type McpAppsDeps,
	type SessionRegistry,
	ToolError,
} from '@tykotech/mcp';
import { holderNameOf } from './auth.ts';
import { type ApiKeyRecord, type Config, ConfigError, isAppsOrigin } from './config.ts';
import { mintLiveTicket, type MintLiveTicketResult } from './liveview.ts';
import type { Logger } from './logger.ts';
import { effectiveOrigins, originAllowed, type OriginOverlay } from './origins.ts';
import { resolveRoot } from './static.ts';
import { TICKET_TTL_MS, type TicketStore } from './tickets.ts';

/** The live-view embed, as `scripts/build_embed.ts` names it in `packages/web/dist`. */
export const EMBED_LIVE_FILE = 'embed_live.html';
/** The read-only A2UI embed. */
export const EMBED_A2UI_FILE = 'embed_a2ui.html';
/** The token the build leaves in each embed's meta CSP for the gateway to replace with its socket origin. */
export const CONNECT_SRC_PLACEHOLDER = '__TTK_CONNECT_SRC__';
/** Every embed ticket's life: the unbound default, though an embed ticket is always bound (design §2.20). */
export const EMBED_TICKET_TTL_MS = TICKET_TTL_MS;

/** The two documents, placeholder already replaced. */
export interface EmbedDocuments {
	readonly liveViewHtml: string;
	readonly a2uiHtml: string;
}

/**
 * The WebSocket origin of `TTK_PUBLIC_URL`: `wss://` behind https, `ws://` otherwise.
 *
 * From the configured public URL, never from a request's `Host` (E-33): this value is written into a CSP and handed
 * to a host as the one domain the embed may reach.
 */
export function socketOrigin(publicUrl: URL): string {
	return `${publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${publicUrl.host}`;
}

/**
 * Reads both embeds from the built `dist` and substitutes the socket origin into their CSP.
 *
 * @throws ConfigError naming `TTK_MCP_APPS` when either document is missing or was not built with the placeholder
 *   — a stale or hand-edited `dist` must not be served as if it carried the policy this build writes.
 */
export function loadEmbedDocuments(publicUrl: URL, root?: string): EmbedDocuments {
	const roots = resolveRoot(root);
	const connect = socketOrigin(publicUrl);
	const read = (file: string): string => {
		let html: string;
		try {
			if (roots === null) throw new Error('no web root');
			html = Deno.readTextFileSync(join(roots.distDir, file));
		} catch {
			throw new ConfigError(
				'TTK_MCP_APPS',
				`the MCP Apps embed ${file} is missing from packages/web/dist; run deno task build:web, or set ` +
					'TTK_MCP_APPS=off',
			);
		}
		if (!html.includes(`connect-src ${CONNECT_SRC_PLACEHOLDER};`)) {
			throw new ConfigError(
				'TTK_MCP_APPS',
				`the MCP Apps embed ${file} carries no connect-src placeholder; rebuild it with deno task build:web`,
			);
		}
		return html.replaceAll(CONNECT_SRC_PLACEHOLDER, connect);
	};
	return { liveViewHtml: read(EMBED_LIVE_FILE), a2uiHtml: read(EMBED_A2UI_FILE) };
}

export interface McpAppsOptions {
	readonly config: Pick<Config, 'publicUrl' | 'allowedOrigins' | 'mcpApps'>;
	readonly registry: SessionRegistry;
	readonly tickets: TicketStore;
	/** The per-token origin overlay (B1.10); the embed ticket can only be narrowed by it (F10). */
	readonly origins: Pick<OriginOverlay, 'forToken'>;
	/** The API-key records in force now, for the label a control lock shows (F21). */
	readonly keyRecords: () => readonly ApiKeyRecord[];
	/** `info` is optional: a test that only watches warnings passes `warn` alone. */
	readonly logger?: Pick<Logger, 'warn'> & Partial<Pick<Logger, 'info'>>;
	/** Already-loaded documents; absent, they are read from the web root. */
	readonly embeds?: EmbedDocuments;
	/** Overrides web-root discovery (tests). */
	readonly root?: string;
}

/** The refusal a failed core mint becomes, in the tool error vocabulary; no message names a scope (SEC-17). */
function refusalOf(
	failed: Extract<MintLiveTicketResult, { ok: false }>,
	mode: 'watch' | 'control',
	sessionId: string,
): ToolError {
	switch (failed.slug) {
		case 'forbidden-scope':
			return new ToolError(
				'scope-required',
				mode === 'control'
					? 'this credential cannot take control of a browser session'
					: 'this credential cannot watch a browser session',
			);
		case 'unknown-session':
			return new ToolError('unknown-session', `no session with id ${sessionId}`);
		case 'invalid-request':
			return new ToolError('invalid-arguments', failed.detail);
	}
}

/**
 * The deployment's MCP Apps, or `undefined` when `TTK_MCP_APPS` is off — the value `McpDeps.mcpApps` takes, so
 * `undefined` keeps every tool's availability, `tools/list` and the resource list exactly as they were.
 *
 * @throws ConfigError when the feature is on and the embed documents cannot be loaded.
 */
export function createMcpApps(options: McpAppsOptions): McpAppsDeps | undefined {
	const { config, registry, tickets, origins, keyRecords } = options;
	const settings = config.mcpApps;
	if (settings === null) return undefined;
	const embeds = options.embeds ?? loadEmbedDocuments(config.publicUrl, options.root);
	if (config.publicUrl.protocol !== 'https:') {
		// Design §2.20 "Reachability": a host page served over https cannot open `ws://` to a non-loopback gateway, and
		// Chrome's Local Network Access may block or prompt for a private address even over wss. D-150: a warning when the
		// operator named the mode; only `info` when it is the default, which every plain-http deployment now starts with
		// and which still serves a host on this machine.
		const message = `TTK_MCP_APPS is ${settings.defaulted ? 'on by default' : 'on'} but TTK_PUBLIC_URL ` +
			`(${config.publicUrl.origin}) is not https: an MCP Apps host serves its embed from an https sandbox, which a ` +
			'browser will not let open ws:// to a non-loopback address; give the gateway an https TTK_PUBLIC_URL the ' +
			'user’s browser can reach';
		if (settings.defaulted) options.logger?.info?.(message);
		else options.logger?.warn(message);
	}
	const socketBase = socketOrigin(config.publicUrl);

	/**
	 * F21: the credential's label, resolved here because only the gateway holds the records it is declared in — by the
	 * reader the REST mint uses (`holderNameOf`), so an administrator login is labelled the same on both (review B4).
	 */
	const holderOf = (input: EmbedTicketInput): string | null => {
		if (input.holderName !== null) return input.holderName;
		// Only an API key (an administrator login among them) carries a label, and its owner is `api-key:<id>` (D-068);
		// any other realm has none, even when its subject happens to spell a key id or an administrator's.
		if (input.access.owner !== `api-key:${input.principal}`) return null;
		return holderNameOf({ kind: 'api-key', id: input.principal, scopes: input.scopes }, keyRecords());
	};

	const mint = (input: EmbedTicketInput): EmbedTicket => {
		if (input.mode === 'control' && settings.mode !== 'control') {
			throw new ToolError(
				'feature-unavailable',
				'taking control from an MCP Apps embed needs TTK_MCP_APPS=control on this deployment',
			);
		}
		// The origin must be one the operator listed for Apps hosts AND one this credential's overlay still allows: the
		// overlay is a narrowing the REST mint already honours at the front door, and a tool call has no Origin header
		// for that door to read, so it is applied to the binding instead (F10).
		//
		// D-150: with no list, any origin of the `TTK_MCP_APPS_ORIGINS` form (https, or http on a loopback host) stands
		// in for "listed", and the effective allowed origins alone decide — `TTK_ALLOWED_ORIGINS` by hostname, or the
		// overlay's exact origins when it has any, which is the admission the socket upgrade applies before a ticket is
		// looked at. The ticket is still bound to exactly this origin, single-use and 30 s, so naming an origin the
		// host's sandbox does not present yields a ticket no socket can redeem. `isAppsOrigin` also keeps an empty
		// string out: `originAllowed` passes a missing Origin header, which a binding must never be.
		const effective = effectiveOrigins(config.allowedOrigins, origins.forToken(input.principal));
		const listed = settings.origins.length === 0 ? isAppsOrigin(input.origin) : settings.origins.includes(input.origin);
		if (!listed || !originAllowed(input.origin, effective)) {
			throw new ToolError(
				'invalid-arguments',
				`origin ${JSON.stringify(input.origin.slice(0, 256))} is not admitted: ` +
					(settings.origins.length === 0
						? 'it must be an https origin (http only on a loopback host) whose hostname TTK_ALLOWED_ORIGINS ' +
							'admits, and allowed for this credential'
						: 'it must be listed in TTK_MCP_APPS_ORIGINS and allowed for this credential'),
			);
		}
		const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
		const minted = mintLiveTicket({ registry, tickets, keyRecords }, {
			principal: { id: input.principal, scopes: input.scopes, holderName: holderOf(input) },
			sessionId,
			mode: input.mode,
			ttlMs: EMBED_TICKET_TTL_MS,
			origin: input.origin,
			access: input.access,
		});
		if (!minted.ok) throw refusalOf(minted, input.mode, sessionId);
		const { record, mode } = minted;
		const path = encodeURIComponent(sessionId);
		return {
			ticket: record.ticket,
			ws_url: new URL(`/live/${path}/ws`, socketBase).href,
			session_id: sessionId,
			mode,
			expires_in: Math.round(record.ttlMs / 1000),
			origin_bound: record.originBound ?? input.origin,
			control_plane_url: new URL(`/#/view/${path}`, config.publicUrl).href,
		};
	};

	return {
		mode: settings.mode,
		liveViewHtml: embeds.liveViewHtml,
		a2uiHtml: embeds.a2uiHtml,
		connectDomains: [socketBase],
		...(settings.domain === null ? {} : { domain: settings.domain }),
		// Empty (D-150): no fixed list; the mint above admits by the effective allowed origins instead.
		origins: settings.origins,
		// Synchronous underneath; a promise because the S0 contract leaves room for a mint that is not.
		mintTicket: (input) => {
			try {
				return Promise.resolve(mint(input));
			} catch (cause) {
				return Promise.reject(cause);
			}
		},
	};
}
