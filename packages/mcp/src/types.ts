/** Shared types for the MCP layer. */
import type {
	CallToolResult,
	ContentBlock as SdkContentBlock,
	InputRequiredResult,
	ServerContext,
} from '@modelcontextprotocol/server';
import type { TykotechCapabilities } from './capabilities.ts';
import type { SessionAccess, SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';
import type { SecretStore } from './secrets.ts';

/**
 * The wire shapes come from the SDK rather than being restated here: a
 * hand-rolled copy would be a second definition of the same contract, free to
 * drift from the one that is actually serialized.
 */
export type ContentBlock = SdkContentBlock;
/**
 * A handler's return value.
 *
 * `InputRequiredResult` is in the union because the sampling-backed tools (R1,
 * R2) answer a first call with "ask your model this, then call me again"; the
 * SDK drives the follow-up on both protocol eras.
 */
export type ToolResult = CallToolResult | InputRequiredResult;

/** One recording, as the tool and the API report it. */
export interface RecordingInfo {
	session_id: string;
	name: string;
	recording: boolean;
	frames: number;
	duration_ms: number;
	bytes?: number;
	/** Where to download it once stopped. */
	url?: string;
}

/**
 * The recording port (R7).
 *
 * Implemented by the gateway, which is where the frame stream and the encoder
 * live; declared here so a tool can drive it without the MCP layer knowing
 * anything about ffmpeg or WebSockets.
 */
export interface RecordingController {
	/**
	 * `owner` is the R8 seam (design §2.16): the realm-qualified owner of the caller that started the recording.
	 * Accepted and ignored in S0; W5's recorder remembers it so the recordings route can refuse a non-owner.
	 */
	start(sessionId: string, name: string, owner?: string): Promise<RecordingInfo>;
	stop(sessionId: string): Promise<RecordingInfo>;
	status(sessionId: string): RecordingInfo | null;
	list(): RecordingInfo[];
}

/** A9: what a handler reports about its own progress, through `ToolContext.progress`. */
export interface ProgressReport {
	/**
	 * How far the call has got, in the handler's own unit (steps taken). Omitted: the heartbeat's own count of
	 * elapsed seconds, which is right for a call bounded by a timeout.
	 */
	readonly progress?: number;
	/** The value progress reaches when the call is done: the step budget, or the timeout in seconds. */
	readonly total?: number;
	/** One line for a human, in place of `<tool> running`. */
	readonly message?: string;
}

/**
 * What the connected client declared it can do, reduced to the four facts the tools branch on (design §2.0 item 5).
 * Built once per call by `clientFactsOf` from the client's capabilities. S0 seam: carried on the context and read by
 * nobody until W4 (confirmations, handoff, sampling with tools).
 */
export interface ClientFacts {
	/** The client declared `sampling`. */
	readonly sampling: boolean;
	/** The client declared `sampling.tools`: a sampling request may carry tool definitions. */
	readonly samplingTools: boolean;
	/** The client accepts form-mode elicitation (a bare `elicitation: {}` counts, as the SDK counts it). */
	readonly elicitForm: boolean;
	/** The client declared `elicitation.url`. */
	readonly elicitUrl: boolean;
}

/**
 * Mints a short-lived signed link to one session file (R10, design §2.7). S0 seam: declared here so the tool layer
 * can call it without knowing the HMAC; W2 builds it in the gateway and wires it as `McpDeps.signedLink` only when
 * `TTK_SIGNED_LINKS=true`. The URL carries identifiers and a MAC, never a credential.
 */
export type SignedLinkMinter = (input: {
	readonly sessionId: string;
	readonly fileId: string;
	/** The realm-qualified owner the link is minted for; the route re-checks that owner is still in force. */
	readonly owner: string;
	/** Requested life in seconds; the minter clamps it. Absent means the deployment's default. */
	readonly ttlSeconds?: number;
	/**
	 * The session record's `SessionRecord.incarnation` (containment-otel-links design §2.0 item 4, §2.7,
	 * D-140), bound into the token so a link dies with the session it was minted in. S0 seam: WS-C passes and checks it.
	 */
	readonly incarnation?: string;
	/**
	 * Unix seconds: the minting credential's own expiry — {@linkcode ToolContext.credentialNotAfter} (design §2.7, F1).
	 * A link never outlives it. Absent for a credential with no expiry of its own (an API key, an account). S0 seam:
	 * WS-C applies the cap.
	 */
	readonly notAfter?: number;
	/**
	 * D-148: the GW-1 fingerprint of the credential the call ran under (`AuthInfo.extra.credential`), so the gateway
	 * can bind a link minted under an account API key to that key rather than to its account. Bound by
	 * `registerCatalog`, never by a tool — a value a tool passes is replaced — and absent wherever a context is built
	 * without `authInfo`. In-process only: never rendered, logged or returned.
	 */
	readonly credential?: string;
}) => Promise<{
	readonly url: string;
	/** When the link stops working, as an ISO 8601 UTC timestamp. */
	readonly expiresAt: string;
	/** The life actually granted, after clamping. */
	readonly ttlSeconds: number;
}>;

/**
 * What an MCP Apps embed ticket is minted for (R9, design §2.20; F21 adds `holderName`). S0 seam: W7 fills it from
 * the tool context and hands it to `McpAppsDeps.mintTicket`, which the gateway builds on `mintLiveTicket`.
 */
export interface EmbedTicketInput {
	/** The principal id the ticket is issued to (the live view's per-principal ceilings count it). */
	readonly principal: string;
	readonly access: SessionAccess;
	readonly scopes: ReadonlySet<Scope>;
	/** Absent means the caller's default session. */
	readonly sessionId?: string;
	readonly mode: 'watch' | 'control';
	/** The MCP Apps host origin the socket must present at upgrade; the ticket is bound to it. */
	readonly origin: string;
	/** The credential's label as the lock message shows it, or `null` (F21: resolved by the caller). */
	readonly holderName: string | null;
}

/** An MCP Apps embed ticket, in the wire shape `browser_live_ticket` returns (R9, design §2.20). S0 seam for W7. */
export interface EmbedTicket {
	readonly ticket: string;
	readonly ws_url: string;
	readonly session_id: string;
	readonly mode: 'watch' | 'control';
	/** Seconds until the ticket expires. */
	readonly expires_in: number;
	/** The origin the ticket is bound to; an embed ticket is always origin-bound. */
	readonly origin_bound: string;
	readonly control_plane_url: string;
}

/**
 * The MCP Apps deployment (R9, `TTK_MCP_APPS`, design §2.20). S0 seam: declared so the catalog and the server can
 * gate on its presence; W7 builds it in the gateway and wires it as `McpDeps.mcpApps`. Absent means the feature is off.
 */
export interface McpAppsDeps {
	/** The ceiling `TTK_MCP_APPS` sets: `control` also allows control tickets. */
	readonly mode: 'watch' | 'control';
	/** The self-contained `ui://tykotech/live-view` document, CSP placeholder already substituted. */
	readonly liveViewHtml: string;
	/** The self-contained `ui://tykotech/a2ui-surface` document. */
	readonly a2uiHtml: string;
	/** `_meta.ui.csp.connectDomains`: the socket origin the embed may reach. */
	readonly connectDomains: readonly string[];
	/** `_meta.ui.domain` (`TTK_MCP_APPS_DOMAIN`), when the operator set one. */
	readonly domain?: string;
	/**
	 * `TTK_MCP_APPS_ORIGINS`: the host origins a ticket may be bound to. Empty (D-150) means no fixed list: the
	 * gateway's mint admits an https origin (http on loopback) whose hostname its allowed origins admit.
	 */
	readonly origins: readonly string[];
	mintTicket(input: EmbedTicketInput): Promise<EmbedTicket>;
}

/** Everything a tool handler is allowed to reach. */
export interface ToolContext {
	/** New resource owner includes the trusted authentication realm (D-068). */
	readonly extensionPrincipal?: string;
	/**
	 * Cancellation of this call: the MCP request's own signal (a client's `notifications/cancelled`, D-079), a
	 * task or stdio bridge's, or both. A long-running handler passes it on to whatever it waits for.
	 */
	readonly signal?: AbortSignal;
	/**
	 * A9: tells the call's progress heartbeat how far the handler has got. Present only when the caller asked for
	 * progress (sent a `progressToken`); a handler calls it as `ctx.progress?.(…)` and never sends a notification
	 * itself — the heartbeat stays the one producer and keeps the reported values rising.
	 */
	readonly progress?: (report: ProgressReport) => void;
	readonly registry: SessionRegistry;
	/** Suffix-match navigation allowlist; empty means unrestricted. */
	readonly allowedDomains: readonly string[];
	readonly principal: string;
	/**
	 * The scopes the calling principal holds (B2.8).
	 *
	 * Registration already filters the catalog on `tool.scope`, so a handler normally never needs
	 * this. `browser_audit` does, and for a reason worth stating: it is useful to an `mcp:invoke`
	 * principal and to an `admin` one and only its **rows** differ, so gating registration would take
	 * the tool away from the caller it was asked for rather than narrowing what it returns (SEC-08).
	 *
	 * **Absent means not privileged.** Every existing constructor — the agent loop's re-entry, every
	 * test harness — omits it and therefore fails closed to own-entries-only, which is the direction a
	 * missing authorization fact must fail in.
	 */
	readonly scopes?: ReadonlySet<Scope>;
	/** Server-held secrets a model may reference by name (R14). */
	readonly secrets?: SecretStore;
	/**
	 * The SDK's per-call context. Present for every real invocation; absent only
	 * where a handler is driven directly (tests, the agent loop's own re-entry).
	 */
	readonly mcp?: ServerContext;
	/** False when the connected client declared no sampling capability. */
	readonly clientSupportsSampling?: boolean;
	/** Session recording, when the deployment can encode video (R7). */
	readonly recorder?: RecordingController;
	/**
	 * Builds the authenticated HTTP URL for one session file (E-33), or is absent
	 * when no HTTP server exists (stdio). Trusted configuration only — never a
	 * request's Host header — and the URL carries identifiers, never credentials.
	 */
	readonly fileUrl?: (sessionId: string, fileId: string) => string;
	/**
	 * This deployment's version and what it offers this principal (B3.2, §8).
	 *
	 * `browser_health` is the only reader. It carries the *already scope-filtered* block rather than
	 * the inputs to build one, so a handler cannot accidentally widen it, and it is the same object
	 * the `initialize` result and `ttk://capabilities` carry — one builder, three read points.
	 * Absent where a handler is driven directly (tests, the agent loop's re-entry), and
	 * `browser_health` then reports what it can rather than inventing a version.
	 */
	readonly capabilities?: TykotechCapabilities;
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/**
	 * The caller's session access (R8, design §2.16): `{owner: extensionPrincipal ?? principal, admin}`. S0 seam:
	 * passed to every registry lookup and ignored in `shared` mode; W5 filters on it in `owner` mode. Absent where a
	 * handler is driven directly.
	 */
	readonly access?: SessionAccess;
	/** What the connected client declared (design §2.0 item 5). S0 seam, read by W4. Absent off the MCP path. */
	readonly client?: ClientFacts;
	/**
	 * Builds the human handoff URL for one session (R2, design §2.12). S0 seam: present only when W4 wires
	 * `TTK_HUMAN_HANDOFF`; the URL carries no ticket and no credential.
	 */
	readonly viewUrl?: (sessionId: string) => string;
	/** Signed links to session files (R10, design §2.7). S0 seam: present only when W2 wires `TTK_SIGNED_LINKS`. */
	readonly signedLink?: SignedLinkMinter;
	/**
	 * Unix seconds: when the credential this call runs under stops being in force, where it says so itself
	 * (containment-otel-links design §2.0 items 4–5, §2.7, F1). Set by `registerCatalog` from the GW-1 credential
	 * `oauth:<ms>` an OAuth token carries in `authInfo.extra.credential` — the token's `exp`, or the gateway horizon for
	 * a token without one. Absent for every other credential and wherever a context is built without `authInfo`.
	 * S0 seam: `browser_file_link` passes it to the minter as `notAfter` (WS-C).
	 */
	readonly credentialNotAfter?: number;
	/**
	 * Mints a bound `requestState` for an `input_required` round (R6/F3, design §2.14). S0 seam: W4 builds the codec
	 * per server factory and puts its `mint` here.
	 */
	readonly stateCodec?: { mint(payload: Record<string, unknown>, mcp: ServerContext): Promise<string> };
	/** The MCP Apps deployment (R9, design §2.20). S0 seam: present only when W7 wires `TTK_MCP_APPS`. */
	readonly mcpApps?: McpAppsDeps;
}

/**
 * The result builders.
 *
 * Every one takes the structured payload **first**, and there is deliberately
 * no builder that accepts none: `validateToolOutput` in the SDK makes a success
 * without `structuredContent` a hard `tools/call` failure the moment a tool
 * declares an `outputSchema`, and D-A2 declares one on every tool. A
 * `text(...)` builder existed here until B1.2 and was the reason eleven success
 * paths across nine handlers would have broken at once; deleting it makes that
 * mistake unrepresentable rather than merely caught (invariant I-6).
 */

/** Prose for the model, plus the structured payload the schema describes. */
export function say(payload: Record<string, unknown>, ...lines: string[]): ToolResult {
	return {
		content: lines.map((text) => ({ type: 'text' as const, text })),
		structuredContent: payload,
	};
}

/** Builds a result carrying an image after an optional text preamble. */
export function image(
	payload: Record<string, unknown>,
	data: string,
	mimeType: string,
	preamble?: string,
): ToolResult {
	const content: ContentBlock[] = [];
	if (preamble !== undefined) content.push({ type: 'text', text: preamble });
	content.push({ type: 'image', data, mimeType });
	return { content, structuredContent: payload };
}

/**
 * Builds a JSON text result plus structured content.
 *
 * `extra` is the D-3 / invariant I-4 seam: fields added after 0.1.0 go into
 * `structuredContent` **only**, so the text block a 0.1.0 client parses stays
 * byte for byte what it was. Growth is paid once, in the structured half,
 * rather than doubled across both.
 */
export function json(payload: Record<string, unknown>, extra?: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: extra === undefined ? payload : { ...payload, ...extra },
	};
}

/**
 * A JSON text block that is a deliberate *projection* of a larger structured
 * payload (D-3).
 *
 * The two differ on purpose: `textPayload` is the frozen, byte-stable rendering
 * an existing client already parses, and `payload` is the richer structure new
 * fields land in. Emitting the whole of a grown payload twice would nearly
 * double the largest result in the catalog for no consumer.
 */
export function projected(
	payload: Record<string, unknown>,
	textPayload: Record<string, unknown>,
): ToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(textPayload, null, 2) }],
		structuredContent: payload,
	};
}

/** An embedded or linked resource block, with a mandatory structured payload. */
export function resource(
	payload: Record<string, unknown>,
	block: ContentBlock,
	preamble?: string,
): ToolResult {
	const content: ContentBlock[] = [];
	if (preamble !== undefined) content.push({ type: 'text', text: preamble });
	content.push(block);
	return { content, structuredContent: payload };
}
