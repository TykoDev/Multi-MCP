/** Tool-level error codes. */
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
	// Session files: an id the session never tracked, and a tracked file that cannot be handed out right now —
	// pending, failed, canceled, over the inline limit, stored on a remote browser, or gone from disk.
	'unknown-file',
	'file-unavailable',
	// A tool the caller's scopes do not admit, and one a deployment fact turns off.
	'scope-required',
	'feature-unavailable',
	// `unknown-index` means "the table I hold has no such index". `element-not-found` is a different failure: "the
	// table you are addressing is not the table I hold".
	'element-not-found',
	// The index resolved and the element is the one the caller meant — it simply cannot take the action asked of it:
	// a `browser_select_option` on something that is not a `<select>`, a fill into a non-input, a disabled control,
	// an element with no layout box to scroll to.
	'element-not-interactable',
	// A JavaScript dialog is holding the page, so a mutating tool cannot act on it.
	'dialog-open',
	// The ledger refused a download at the moment the browser announced it — no downloads directory, an unsanitizable
	// filename, or the session's tracked-download cap.
	'download-failed',
	// `browser_head` asks a *remote* server a question, and its failures are the remote server's rather than this
	// browser's: DNS did not resolve, the connection was refused, TLS did not verify, the request returned no
	// response.
	'browser-error',
	// A human the client asked — through an elicitation this server requested — declined or cancelled a confirmation,
	// a handoff or a secret choice.
	'user-declined',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** The structured half of a failure result. */
interface ToolErrorPayload {
	readonly error: {
		readonly code: ToolErrorCode;
		readonly message: string;
		/**
		 * `feature-unavailable`: the deployment fact the operator chose. `egress`: the process holds no outbound net
		 * grant for the host asked about, or none beyond loopback at all.
		 */
		readonly feature?: 'persistence' | 'recording' | 'egress';
		/** `element-not-found` / `unknown-index` / `element-not-interactable`: the index the caller sent. */
		readonly index?: number;
		/**
		 * `element-not-interactable`: the tag the index actually resolved to, so a caller can tell "you addressed a
		 * `<div>`" from "the `<select>` is disabled" without a second round trip.
		 */
		readonly tag?: string | null;
		/**
		 * `element-not-found`: the token of the table the server actually holds, so the caller can tell a moved page
		 * from a lost one without a second round trip. `null` when there is no table at all.
		 */
		readonly state_token?: string | null;
		/** A CLOSED enum, never free prose. */
		readonly reason?: ToolErrorReason;
		/** `dialog-open`: the id to answer and the kind of dialog. Never its message. */
		readonly dialog_id?: string;
		readonly dialog_kind?: string;
		/** `download-failed`: the ledger id of the download that never became a readable file. */
		readonly file_id?: string;
	};
}

/** Why an index could not be resolved against the table the caller named. */
const ELEMENT_NOT_FOUND_REASONS = ['stale-token', 'no-state'] as const;
type ElementNotFoundReason = (typeof ELEMENT_NOT_FOUND_REASONS)[number];

/** Why a secret-bearing action was refused rather than dispatched. */
const SECRET_REFUSAL_REASONS = ['viewport-scaled'] as const;
type SecretRefusalReason = (typeof SECRET_REFUSAL_REASONS)[number];

/** Every closed `reason` a failure envelope may carry. The `code` decides which are possible. */
type ToolErrorReason = ElementNotFoundReason | SecretRefusalReason | DownloadFailureReason;

/** Per-code structured extras. Nothing here is free prose. */
interface ToolErrorExtras {
	readonly feature?: 'persistence' | 'recording' | 'egress';
	readonly index?: number;
	/** `element-not-interactable`: the tag the index resolved to. Structural, never content. */
	readonly tag?: string | null;
	readonly state_token?: string | null;
	readonly reason?: ToolErrorReason;
	/**
	 * `dialog-open`: the id to pass to `browser_handle_dialog`, and the kind of dialog it is (`alert`, `confirm`,
	 * `prompt`, `beforeunload`).
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

	/** The exact text carried in the tool result's first content block. */
	get wireText(): string {
		return `Error: ${this.message}`;
	}

	/** The `structuredContent` half of the failure envelope. */
	get structuredPayload(): ToolErrorPayload {
		// `message` is the detail alone, not `wireText`: the code is already its own field, and repeating it inside
		// the message invites a client to parse the message rather than read the field.
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
 * A hostname as the browser compares it: lower-cased, IDN in its punycode form, and without the trailing dot that
 * `example.com.` carries (treating that as another host would be one character from a bypass).
 */
export function canonicalHost(raw: string): string | null {
	const trimmed = raw.trim().replace(/^\./, '').replace(/\.+$/, '');
	if (trimmed === '') return null;
	const parsed = URL.parse(`http://${trimmed}/`);
	if (parsed === null || parsed.hostname === '') return null;
	return parsed.hostname.replace(/\.+$/, '').toLowerCase();
}

/** The host-or-subdomain rule on canonical hosts. An empty allowlist permits every host. */
export function isHostAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
	if (allowedDomains.length === 0) return true;
	// The FQDN root is ONE dot.
	if (/\.\.$/.test(hostname.trim())) return false;
	const host = canonicalHost(hostname);
	if (host === null) return false;
	return allowedDomains.some((entry) => {
		const candidate = canonicalHost(entry);
		// Host-or-subdomain, never a bare suffix match: `evil-example.com` must not pass an `example.com` allowlist.
		return candidate !== null && (host === candidate || host.endsWith(`.${candidate}`));
	});
}

/** `origin` of a URL, or the raw host when it does not parse — never the path or the query. */
export function originOf(url: string): string {
	const parsed = URL.parse(url);
	return parsed === null ? url : parsed.origin;
}

/** Decides whether a URL may be navigated to. */
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

// --- The one way a tool stops *waiting* on work it cannot interrupt — a DOM build or capture in the vendored browser, a store read, a private service's reply.

/** Settles with `work`, or rejects with `signal`'s reason the moment it aborts, whichever comes first. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason);
		if (signal.aborted) {
			work.catch(() => {});
			return abort();
		}
		signal.addEventListener('abort', abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}
