/** MCP Apps, the gateway half. */
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
/** The A2UI embed. */
export const EMBED_A2UI_FILE = 'embed_a2ui.html';
/** The terminal embed. */
export const EMBED_TERMINAL_FILE = 'embed_terminal.html';
/** The token the build leaves in each embed's meta CSP for the gateway to replace with its socket origin. */
export const CONNECT_SRC_PLACEHOLDER = '__TTK_CONNECT_SRC__';
/** Every embed ticket's life: the unbound default, though an embed ticket is always bound. */
export const EMBED_TICKET_TTL_MS = TICKET_TTL_MS;

/** The embed documents, placeholder already replaced. */
export interface EmbedDocuments {
	readonly liveViewHtml: string;
	readonly a2uiHtml: string;
	readonly terminalHtml: string;
}

/** The WebSocket origin of `TTK_PUBLIC_URL`: `wss://` behind https, `ws://` otherwise. */
export function socketOrigin(publicUrl: URL): string {
	return `${publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${publicUrl.host}`;
}

/** Reads the three embeds from the built `dist` and substitutes the socket origin into their CSP. */
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
	return {
		liveViewHtml: read(EMBED_LIVE_FILE),
		a2uiHtml: read(EMBED_A2UI_FILE),
		terminalHtml: read(EMBED_TERMINAL_FILE),
	};
}

export interface McpAppsOptions {
	readonly config: Pick<Config, 'publicUrl' | 'allowedOrigins' | 'mcpApps'>;
	readonly registry: SessionRegistry;
	readonly tickets: TicketStore;
	/** The per-token origin overlay; the embed ticket can only be narrowed by it. */
	readonly origins: Pick<OriginOverlay, 'forToken'>;
	/** The API-key records in force, for the label a control lock shows. */
	readonly keyRecords: () => readonly ApiKeyRecord[];
	/** `info` is optional: a test that only watches warnings passes `warn` alone. */
	readonly logger?: Pick<Logger, 'warn'> & Partial<Pick<Logger, 'info'>>;
	/** Already-loaded documents; absent, they are read from the web root. */
	readonly embeds?: EmbedDocuments;
}

/** The refusal a failed core mint becomes, in the tool error vocabulary; no message names a scope. */
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

/** What {@linkcode embedOriginGate} reads: the Apps settings in force, the allowed origins and the per-token overlay. */
export interface EmbedOriginGateOptions {
	readonly settings: NonNullable<Config['mcpApps']>;
	readonly allowedOrigins: Config['allowedOrigins'];
	readonly origins: Pick<OriginOverlay, 'forToken'>;
}

/**
 * The origin admission every MCP Apps embed ticket passes — the live view's and the terminal and surface streams'
 * (`embed_streams.ts`) — so the rule cannot drift between them.
 */
export function embedOriginGate(options: EmbedOriginGateOptions): (principal: string, origin: string) => void {
	const { settings, allowedOrigins, origins } = options;
	return (principal: string, origin: string): void => {
		// The origin must be one the operator listed for Apps hosts AND one this credential's overlay still allows: the
		// overlay is a narrowing the REST mint honours at the front door, and a tool call has no Origin header for that
		// door to read, so it is applied to the binding instead.
		const effective = effectiveOrigins(allowedOrigins, origins.forToken(principal));
		const listed = settings.origins.length === 0 ? isAppsOrigin(origin) : settings.origins.includes(origin);
		if (!listed || !originAllowed(origin, effective)) {
			throw new ToolError(
				'invalid-arguments',
				`origin ${JSON.stringify(origin.slice(0, 256))} is not admitted: ` +
					(settings.origins.length === 0
						? 'it must be an https origin (http only on a loopback host) whose hostname TTK_ALLOWED_ORIGINS ' +
							'admits, and allowed for this credential'
						: 'it must be listed in TTK_MCP_APPS_ORIGINS and allowed for this credential'),
			);
		}
	};
}

/**
 * The deployment's MCP Apps, or `undefined` when `TTK_MCP_APPS` is off — the value `McpDeps.mcpApps` takes, so
 * `undefined` leaves every tool's availability, `tools/list` and the resource list without MCP Apps.
 */
export function createMcpApps(options: McpAppsOptions): McpAppsDeps | undefined {
	const { config, registry, tickets, origins, keyRecords } = options;
	const settings = config.mcpApps;
	if (settings === null) return undefined;
	const embeds = options.embeds ?? loadEmbedDocuments(config.publicUrl);
	if (config.publicUrl.protocol !== 'https:') {
		// Reachability: a host page served over https cannot open `ws://` to a non-loopback gateway, and Chrome's Local
		// Network Access may block or prompt for a private address even over wss.
		const message = `TTK_MCP_APPS is ${settings.defaulted ? 'on by default' : 'on'} but TTK_PUBLIC_URL ` +
			`(${config.publicUrl.origin}) is not https: an MCP Apps host serves its embed from an https sandbox, which a ` +
			'browser will not let open ws:// to a non-loopback address; give the gateway an https TTK_PUBLIC_URL the ' +
			'user’s browser can reach';
		if (settings.defaulted) options.logger?.info?.(message);
		else options.logger?.warn(message);
	}
	const socketBase = socketOrigin(config.publicUrl);

	/**
	 * The credential's label, resolved here because only the gateway holds the records it is declared in — by the
	 * reader the REST mint uses (`holderNameOf`), so an administrator login is labelled the same on both.
	 */
	const holderOf = (input: EmbedTicketInput): string | null => {
		if (input.holderName !== null) return input.holderName;
		// Only an API key (an administrator login among them) carries a label, and its owner is `api-key:<id>`;
		// any other realm has none, even when its subject happens to spell a key id or an administrator's.
		if (input.access.owner !== `api-key:${input.principal}`) return null;
		return holderNameOf({ kind: 'api-key', id: input.principal, scopes: input.scopes }, keyRecords());
	};

	const admitOrigin = embedOriginGate({ settings, allowedOrigins: config.allowedOrigins, origins });

	const mint = (input: EmbedTicketInput): EmbedTicket => {
		if (input.mode === 'control' && settings.mode !== 'control') {
			throw new ToolError(
				'feature-unavailable',
				'taking control from an MCP Apps embed needs TTK_MCP_APPS=control on this deployment',
			);
		}
		admitOrigin(input.principal, input.origin);
		const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
		const minted = mintLiveTicket({ registry, tickets }, {
			principal: {
				id: input.principal,
				scopes: input.scopes,
				holderName: holderOf(input),
				// The credential fingerprint `registerCatalog` binds into the mint, so the socket can re-check the
				// credential that minted it.
				credential: input.credential,
			},
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
		terminalHtml: embeds.terminalHtml,
		connectDomains: [socketBase],
		...(settings.domain === null ? {} : { domain: settings.domain }),
		// Empty: no fixed list; the mint above admits by the effective allowed origins instead.
		origins: settings.origins,
		// Synchronous underneath; a promise because the `McpAppsDeps` contract leaves room for a mint that is not.
		mintTicket: (input) => {
			try {
				return Promise.resolve(mint(input));
			} catch (cause) {
				return Promise.reject(cause);
			}
		},
	};
}
