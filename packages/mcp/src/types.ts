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
 * The wire shapes come from the SDK rather than being restated here: a hand-rolled copy would be a second definition
 * of the same contract, free to drift from the one that is actually serialized.
 */
type ContentBlock = SdkContentBlock;
/** A handler's return value. */
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

/** The recording port. */
export interface RecordingController {
	/** `owner` is the realm-qualified owner of the caller that started the recording. */
	start(sessionId: string, name: string, owner?: string): Promise<RecordingInfo>;
	stop(sessionId: string): Promise<RecordingInfo>;
	status(sessionId: string): RecordingInfo | null;
	list(): RecordingInfo[];
}

/** What a handler reports about its own progress, through `ToolContext.progress`. */
export interface ProgressReport {
	/** How far the call has got, in the handler's own unit (steps taken). */
	readonly progress?: number;
	/** The value progress reaches when the call is done: the step budget, or the timeout in seconds. */
	readonly total?: number;
	/** One line for a human, in place of `<tool> running`. */
	readonly message?: string;
}

/**
 * What the connected client declared it can do, reduced to the four facts the tools branch on (confirmations,
 * handoff, sampling with tools).
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
 * Mints a short-lived signed link to one session file. Declared here so the tool layer can call it without knowing
 * the HMAC; the gateway builds it and wires it as `McpDeps.signedLink` only when `TTK_SIGNED_LINKS=true`.
 */
export type SignedLinkMinter = (input: {
	readonly sessionId: string;
	readonly fileId: string;
	/** The realm-qualified owner the link is minted for; the route re-checks that owner is still in force. */
	readonly owner: string;
	/** Requested life in seconds; the minter clamps it. Absent means the deployment's default. */
	readonly ttlSeconds?: number;
	/**
	 * The session record's `SessionRecord.incarnation`, bound into the token so a link dies with the session it was
	 * minted in; the file route checks it.
	 */
	readonly incarnation?: string;
	/**
	 * Unix seconds: a cap the link never outlives; the minter applies it. No tool passes one today — every credential
	 * the gateway accepts (an API key, an account, a sign-in session) has no expiry of its own a link must respect.
	 */
	readonly notAfter?: number;
	/**
	 * The fingerprint of the credential the call ran under (`AuthInfo.extra.credential`), so the gateway can bind a
	 * link minted under an account API key to that key rather than to its account.
	 */
	readonly credential?: string;
}) => Promise<{
	readonly url: string;
	/** When the link stops working, as an ISO 8601 UTC timestamp. */
	readonly expiresAt: string;
	/** The life actually granted, after clamping. */
	readonly ttlSeconds: number;
}>;

/** What an MCP Apps embed ticket is minted for. */
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
	/** The credential's label as the lock message shows it, or `null`; resolved by the caller. */
	readonly holderName: string | null;
	/**
	 * The fingerprint of the credential the call ran under, so the live-view socket the ticket opens can re-check it
	 * and close when it is revoked. Bound by `registerCatalog`, never by a tool — a value a tool passes is replaced.
	 */
	readonly credential?: string;
}

/** An MCP Apps embed ticket, in the wire shape `browser_live_ticket` returns. */
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

/** The MCP Apps deployment (`TTK_MCP_APPS`). */
export interface McpAppsDeps {
	/** The ceiling `TTK_MCP_APPS` sets: `control` also allows control tickets. */
	readonly mode: 'watch' | 'control';
	/** The self-contained `ui://tykotech/live-view` document, CSP placeholder already substituted. */
	readonly liveViewHtml: string;
	/** The self-contained `ui://tykotech/a2ui-surface` document. */
	readonly a2uiHtml: string;
	/** The self-contained `ui://tykotech/terminal` document. */
	readonly terminalHtml: string;
	/** `_meta.ui.csp.connectDomains`: the socket origin the embed may reach. */
	readonly connectDomains: readonly string[];
	/** `_meta.ui.domain` (`TTK_MCP_APPS_DOMAIN`), when the operator set one. */
	readonly domain?: string;
	/** `TTK_MCP_APPS_ORIGINS`: the host origins a ticket may be bound to. */
	readonly origins: readonly string[];
	mintTicket(input: EmbedTicketInput): Promise<EmbedTicket>;
}

/** Everything a tool handler is allowed to reach. */
export interface ToolContext {
	/** The owner of new resources, qualified by the trusted authentication realm. */
	readonly extensionPrincipal?: string;
	/**
	 * The principal id an extension action's caller authenticated as, kept beside the owner that replaces
	 * {@linkcode principal} in an extension action's context: the per-principal connection ceiling and the per-token
	 * origin overlay count the id, not the owner (the MCP Apps stream tickets, `embed_streams.ts`). Set only there.
	 */
	readonly callerPrincipal?: string;
	/**
	 * Cancellation of this call: the MCP request's own signal (a client's `notifications/cancelled`), an agent
	 * task's (`createToolExecutor`), or both. A long-running handler passes it on to whatever it waits for.
	 */
	readonly signal?: AbortSignal;
	/** Tells the call's progress heartbeat how far the handler has got. */
	readonly progress?: (report: ProgressReport) => void;
	readonly registry: SessionRegistry;
	/** Suffix-match navigation allowlist; empty means unrestricted. */
	readonly allowedDomains: readonly string[];
	readonly principal: string;
	/** The scopes the calling principal holds. */
	readonly scopes?: ReadonlySet<Scope>;
	/** Server-held secrets a model may reference by name. */
	readonly secrets?: SecretStore;
	/** The SDK's per-call context. */
	readonly mcp?: ServerContext;
	/** False when the connected client declared no sampling capability. */
	readonly clientSupportsSampling?: boolean;
	/** Session recording, when the deployment can encode video. */
	readonly recorder?: RecordingController;
	/**
	 * Builds the authenticated HTTP URL for one session file, or is absent
	 * when no HTTP server exists (stdio). Trusted configuration only — never a
	 * request's Host header — and the URL carries identifiers, never credentials.
	 */
	readonly fileUrl?: (sessionId: string, fileId: string) => string;
	/** This deployment's version and what it offers this principal. */
	readonly capabilities?: TykotechCapabilities;
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/** The caller's session access: `{owner: extensionPrincipal ?? principal, admin}`. */
	readonly access?: SessionAccess;
	/** What the connected client declared. Absent off the MCP path. */
	readonly client?: ClientFacts;
	/**
	 * Builds the human handoff URL for one session. Present only with `TTK_HUMAN_HANDOFF`; the URL carries no ticket
	 * and no credential.
	 */
	readonly viewUrl?: (sessionId: string) => string;
	/** Signed links to session files. Present only with `TTK_SIGNED_LINKS`. */
	readonly signedLink?: SignedLinkMinter;
	/** Mints a bound `requestState` for an `input_required` round. */
	readonly stateCodec?: { mint(payload: Record<string, unknown>, mcp: ServerContext): Promise<string> };
	/** The MCP Apps deployment. Present only with `TTK_MCP_APPS`. */
	readonly mcpApps?: McpAppsDeps;
}

/** The result builders. */

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

/** Builds a JSON text result plus structured content. */
export function json(payload: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	};
}

/** A JSON text block that is a deliberate *projection* of a larger structured payload. */
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
