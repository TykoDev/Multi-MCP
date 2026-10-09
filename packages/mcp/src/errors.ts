/**
 * Tool-level error codes.
 *
 * Every tool failure reaches the client as a *result* (`isError: true`) whose
 * first text block starts `Error: <code>: <detail>` — never as a JSON-RPC
 * error. Clients (and the models driving them) pattern-match on the code, so
 * these strings are wire-stable.
 *
 * See SPECS/CONNECTORS-MCP-A2A-A2UI.md §1.5.
 */
import type { DownloadFailureReason } from './events.ts';

export const TOOL_ERROR_CODES = [
	'unknown-session',
	'session-limit',
	'human-has-control',
	'navigation-blocked',
	'timeout',
	'unknown-tab',
	'unknown-index',
	'browser-crashed',
	'browser-unavailable',
	'invalid-arguments',
	// Session files (E-33): an id the session never tracked, and a tracked file
	// that cannot be handed out right now — pending, failed, canceled, over the
	// inline limit, stored on a remote browser, or gone from disk.
	'unknown-file',
	'file-unavailable',
	// The 0.2.0 tool surface (D-A2). `scope-required` and `feature-unavailable`
	// both read as `Tool ... not found` before the tools/call seam existed, which
	// is textually indistinguishable from a tool this server does not have — so a
	// client that treated "not found" as "this build lacks the feature" degraded
	// itself permanently.
	'scope-required',
	'feature-unavailable',
	// B1.4 / G-1. `unknown-index` keeps its exact present meaning — "the table I
	// hold has no such index". `element-not-found` is the different failure it
	// used to be confused with: "the table you are addressing is not the table I
	// hold". Merging them would make an existing code ambiguous, and a client
	// cannot choose between re-reading state and retrying the same index without
	// the distinction.
	'element-not-found',
	// B2.5. The index resolved and the element is the one the caller meant — it
	// simply cannot take the action asked of it: a `browser_select_option` on
	// something that is not a `<select>`, a fill into a non-input, a disabled
	// control, an element with no layout box to scroll to. `unknown-index` would
	// be false (the index resolved) and `invalid-arguments` would blame the
	// caller for a fact about the page, so neither existing code can carry it.
	'element-not-interactable',
	// B3.2 / §8. A JavaScript dialog is holding the page, so a mutating tool
	// cannot act on it. `browser-unavailable` would be true and useless: the
	// browser is fine, one target is blocked, and the caller's remedy is
	// `browser_handle_dialog` with the id this error carries. Without a distinct
	// code the caller would wait out the 20 s hold and then see a timeout that
	// named nothing it could act on. Only ever raised while manual dialog
	// handling is armed — with no `dialog` subscriber the watchdog answers every
	// dialog by policy and nothing is ever held (E-53), so a deployment that does
	// not subscribe never sees this code.
	'dialog-open',
	// B3.2 / §8. The ledger refused a download at the moment the browser
	// announced it — no downloads directory, an unsanitizable filename, or the
	// session's tracked-download cap. `unknown-file` and `file-unavailable` are
	// both about a file the ledger already knows; this is about one that never
	// entered it. **A download that starts and then fails is NOT this code**: it
	// is a success result whose `file.status` is `failed`, which is a fact about
	// the transfer rather than a refusal of the request. Nor is an off-allowlist
	// download, which keeps `navigation-blocked` — the code it has emitted since
	// B1.12, and renaming it would break a client that already matches on it.
	'download-failed',
	// B1.12. `browser_head` asks a *remote* server a question, and its failures
	// are the remote server's rather than this browser's: DNS did not resolve, the
	// connection was refused, TLS did not verify, the request returned no
	// response. `browser-unavailable` would be a lie (the browser is fine) and
	// `timeout` names only one of them. The message carries Chromium's own
	// `netErrorName`, which is a closed vocabulary the caller can look up.
	'browser-error',
	// R2 / R5 (design §2.4, seam S0; raised by W4). A human the client asked — through an elicitation this server
	// requested — declined or cancelled a confirmation, a handoff or a secret choice. Never raised for a client
	// that did not declare the elicitation mode involved, so an existing client never sees it.
	'user-declined',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/**
 * The structured half of a failure result (D-A2).
 *
 * Every key is closed: a `reason` a client cannot enumerate is prose with a
 * field name. The SDK never validates this — `validateToolOutput` returns early
 * for `isError` results — so it is asserted by this repository's own tests
 * instead (see `dispatch_test.ts`).
 */
export interface ToolErrorPayload {
	readonly error: {
		readonly code: ToolErrorCode;
		readonly message: string;
		/**
		 * `feature-unavailable`: the deployment fact the operator chose.
		 * `egress` (SR-HEAD-REDIRECT): the process holds no outbound net grant for
		 * the host asked about, or none beyond loopback at all.
		 */
		readonly feature?: 'persistence' | 'recording' | 'egress';
		/** `element-not-found` / `unknown-index` / `element-not-interactable`: the index the caller sent. */
		readonly index?: number;
		/**
		 * `element-not-interactable`: the tag the index actually resolved to, so a caller can tell
		 * "you addressed a `<div>`" from "the `<select>` is disabled" without a second round trip.
		 * A tag name is structural, never content: it discloses nothing `browser_get_state` does not
		 * already give the same principal (invariant I-8).
		 */
		readonly tag?: string | null;
		/**
		 * `element-not-found`: the token of the table the server actually holds,
		 * so the caller can tell a moved page from a lost one without a second
		 * round trip. `null` when there is no table at all.
		 */
		readonly state_token?: string | null;
		/**
		 * A CLOSED enum, never free prose. Which members are possible is decided by `code`:
		 * `element-not-found` carries {@linkcode ElementNotFoundReason}, `browser-unavailable`
		 * carries `viewport-scaled` and nothing else (B2.8, SEC-24), and `download-failed` carries
		 * {@linkcode DownloadFailureReason} (B3.2).
		 */
		readonly reason?: ToolErrorReason;
		/** `dialog-open`: the id to answer and the kind of dialog. Never its message. */
		readonly dialog_id?: string;
		readonly dialog_kind?: string;
		/** `download-failed`: the ledger id of the download that never became a readable file. */
		readonly file_id?: string;
	};
}

/**
 * Why an index could not be resolved against the table the caller named.
 *
 * `stale-token` — the server holds a table, but not the one the caller
 * addressed; re-read the state and the index may well be valid again.
 * `no-state` — the server holds no table at all (a fresh session, a failed
 * state read, or a fail-safe serialization); nothing can be resolved until a
 * `browser_get_state` succeeds.
 */
export const ELEMENT_NOT_FOUND_REASONS = ['stale-token', 'no-state'] as const;
export type ElementNotFoundReason = (typeof ELEMENT_NOT_FOUND_REASONS)[number];

/**
 * Why a secret-bearing action was refused rather than dispatched (B2.8, SEC-24).
 *
 * One member, and it is on `browser-unavailable` rather than on a code of its own: the browser is
 * genuinely in a state this server will not act in, which is what that code says, and a caller that
 * matches on the code alone still behaves correctly. `viewport-scaled` — the visual viewport is at a
 * scale other than 1, so the layout- and visual-viewport scroll sources diverge and a click computed
 * from the mix can land on an element other than the one named. Also emitted when the scale could
 * not be read at all, because "I could not check" is not "it is safe".
 */
export const SECRET_REFUSAL_REASONS = ['viewport-scaled'] as const;
export type SecretRefusalReason = (typeof SECRET_REFUSAL_REASONS)[number];

/**
 * Every closed `reason` a failure envelope may carry. The `code` decides which are possible.
 *
 * `download-failed` (B3.2) carries {@linkcode DownloadFailureReason} — **the same six-value
 * vocabulary the `download.failed` event kind carries**, classified by the same
 * `downloadFailureReason` function. Deliberately not a second enum: a tool error and an event
 * describing the same download must not disagree about why it failed, and a client that learns the
 * vocabulary from one transport reads the other. A `reason` a client cannot enumerate is prose with
 * a field name, and two enumerations for one condition are worse than that.
 */
export type ToolErrorReason = ElementNotFoundReason | SecretRefusalReason | DownloadFailureReason;

/** Per-code structured extras. Nothing here is free prose. */
export interface ToolErrorExtras {
	readonly feature?: 'persistence' | 'recording' | 'egress';
	readonly index?: number;
	/** `element-not-interactable`: the tag the index resolved to. Structural, never content. */
	readonly tag?: string | null;
	readonly state_token?: string | null;
	readonly reason?: ToolErrorReason;
	/**
	 * `dialog-open`: the id to pass to `browser_handle_dialog`, and the kind of dialog it is
	 * (`alert`, `confirm`, `prompt`, `beforeunload`). **Never the dialog's message** — that is
	 * page-controlled text, and the `dialog` event kind already carries it under the caps
	 * `events.ts` applies. The caller needs to know what to answer, not what it says.
	 */
	readonly dialog_id?: string;
	readonly dialog_kind?: string;
	/** `download-failed`: the ledger id of the download that never became a readable file. */
	readonly file_id?: string;
}

/**
 * A failure that is meaningful to the calling model: it is rendered as a
 * result-level tool error, not a protocol error.
 */
export class ToolError extends Error {
	readonly code: ToolErrorCode;
	readonly extras: ToolErrorExtras;

	constructor(code: ToolErrorCode, detail: string, extras: ToolErrorExtras = {}) {
		super(`${code}: ${detail}`);
		this.name = 'ToolError';
		this.code = code;
		this.extras = extras;
	}

	/**
	 * The exact text carried in the tool result's first content block.
	 *
	 * The only producer of the `Error: <code>: ` prefix in the tree. A second
	 * hand-formatted copy lived at `server.ts:130-135` until B1.1 removed it
	 * (report_design.md F-4): a change to the prefix in one place would silently
	 * not have applied to the other.
	 */
	get wireText(): string {
		return `Error: ${this.message}`;
	}

	/** The `structuredContent` half of the D-A2 failure envelope. */
	get structuredPayload(): ToolErrorPayload {
		// `message` is the detail alone, not `wireText`: the code is already its
		// own field, and repeating it inside the message invites a client to parse
		// the message rather than read the field.
		return {
			error: {
				code: this.code,
				message: this.message.slice(this.code.length + 2),
				...this.extras,
			},
		};
	}
}

/** Narrowing helper for handler catch blocks. */
export function isToolError(value: unknown): value is ToolError {
	return value instanceof ToolError;
}

/**
 * A hostname as the browser compares it: lower-cased, IDN in its punycode
 * form, and without the trailing dot that `example.com.` carries.
 *
 * `new URL()` already lower-cases and punycodes the *URL* side. The allowlist
 * side is operator-typed text and gets the same treatment, so `Bücher.Example`
 * in `TTK_ALLOWED_DOMAINS` matches the host Chromium actually connects to. The
 * trailing dot is a fully-qualified spelling of the same DNS name, and a
 * predicate that treated `example.com.` as a different host would be one
 * character away from a bypass. `null` when the entry is not a hostname at all.
 */
export function canonicalHost(raw: string): string | null {
	const trimmed = raw.trim().replace(/^\./, '').replace(/\.+$/, '');
	if (trimmed === '') return null;
	const parsed = URL.parse(`http://${trimmed}/`);
	if (parsed === null || parsed.hostname === '') return null;
	return parsed.hostname.replace(/\.+$/, '').toLowerCase();
}

/**
 * The host-or-subdomain rule on canonical hosts. An empty allowlist permits every host.
 *
 * Exported so the download ledger can apply the **same** rule to the URL a
 * download actually came from — a `download.started` URL is a final URL, after
 * every redirect — without a second spelling of the predicate.
 */
export function isHostAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
	if (allowedDomains.length === 0) return true;
	// ERRATUM(E-92): the FQDN root is ONE dot. A host still ending in a dot once that is gone (`example.com..`)
	// has an empty last label — no DNS name — and the browser's own matcher, which strips exactly one, refuses
	// it; `canonicalHost` strips every trailing dot, so without this the tools allowed what the browser vetoed.
	if (/\.\.$/.test(hostname.trim())) return false;
	const host = canonicalHost(hostname);
	if (host === null) return false;
	return allowedDomains.some((entry) => {
		const candidate = canonicalHost(entry);
		// Host-or-subdomain, never a bare suffix match: `evil-example.com` must
		// not pass an `example.com` allowlist.
		return candidate !== null && (host === candidate || host.endsWith(`.${candidate}`));
	});
}

/** `origin` of a URL, or the raw host when it does not parse — never the path or the query. */
export function originOf(url: string): string {
	const parsed = URL.parse(url);
	return parsed === null ? url : parsed.origin;
}

/**
 * Decides whether a URL may be navigated to.
 *
 * The single implementation of the navigation policy: both the MCP tool and
 * the live view's human-driven navigation call it, so a human taking control
 * cannot reach somewhere the deployment forbids a model from reaching. An
 * empty allowlist means unrestricted; a configured one matches host-or-suffix,
 * and a caller can never widen it (SPECS/DECISION-REGISTER.md D-020).
 *
 * The predicate gates the URL it is given. Where the browser may land
 * somewhere else — a redirect followed by `browser_head`, or the final URL of
 * a download — the caller gates that URL too, through {@linkcode isHostAllowed}
 * on the same rule; the bypasses were around the predicate, not in it.
 *
 * @throws ToolError when the URL is malformed or the host is not permitted.
 */
export function assertNavigable(rawUrl: string, allowedDomains: readonly string[]): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new ToolError('invalid-arguments', `not a valid URL: ${rawUrl}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new ToolError('navigation-blocked', `unsupported scheme: ${url.protocol}`);
	}
	if (!isHostAllowed(url.hostname, allowedDomains)) {
		throw new ToolError('navigation-blocked', `${url.hostname} is not in the server's allowed-domain list`);
	}
	return url;
}
