/** Session-file handlers: the two read-only peeks over what the browser already downloaded. */
import { delay } from '@std/async/delay';
import { encodeBase64 } from '@std/encoding/base64';
import { ClickElementEvent, NavigateToUrlEvent } from '@tykotech/browser';
import { assertNavigable, ToolError } from '../errors.ts';
import { downloadFailureReason } from '../events.ts';
import { headRoutingRefusal, headWalk } from '../head.ts';
import { ARTIFACT_ID_PREFIX, filePolicyOf, INLINE_FILE_LIMIT_BYTES } from '../files.ts';
import { blockedSince } from '../registry.ts';
import { fileResourceUri } from '../resources.ts';
import { json, type ToolContext, type ToolResult } from '../types.ts';
import { dispatch, nodeAt, peekSession, target } from './shared.ts';

export async function browserListFiles(args: { session_id?: string }, ctx: ToolContext): Promise<ToolResult> {
	const record = peekSession(ctx, args.session_id);
	// The digested listing rather than the synchronous one.
	return json({
		session_id: record.id,
		files: await record.files.listDigested(),
		inline_limit_bytes: INLINE_FILE_LIMIT_BYTES,
	});
}

export async function browserGetFile(
	args: { file_id: string; session_id?: string; delivery?: 'inline' | 'link' | 'stream' },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = peekSession(ctx, args.session_id);
	const uri = fileResourceUri(record.id, args.file_id);

	if ((args.delivery ?? 'inline') === 'inline') {
		const { info, bytes } = await record.files.readInline(args.file_id);
		const payload = {
			session_id: record.id,
			delivery: 'inline',
			resource_uri: uri,
			file: { ...info, sha256: await record.files.digest(args.file_id) },
		};
		return {
			content: [
				{ type: 'text', text: JSON.stringify(payload, null, 2) },
				{ type: 'resource', resource: { uri, mimeType: info.mime_type, blob: encodeBase64(bytes) } },
			],
			structuredContent: payload,
		};
	}

	const resolved = await record.files.resolve(args.file_id);
	const httpUrl = ctx.fileUrl?.(record.id, args.file_id) ?? null;
	// `stream` and `link` are the same answer with a different promise attached to it: both hand back the
	// authenticated URL, and `stream` additionally states that the endpoint honours `Range`, so a caller can resume
	// or read a window of a file too large to want whole.
	const delivery = args.delivery === 'stream' ? 'stream' : 'link';
	const payload: Record<string, unknown> = {
		session_id: record.id,
		delivery,
		resource_uri: uri,
		file: { ...resolved.info, sha256: await record.files.digest(args.file_id) },
		range_supported: true,
	};
	if (httpUrl !== null) {
		payload.http_url = httpUrl;
		payload.http_auth = 'Authorization: Bearer <the same credential used for /mcp>; requires scope mcp:invoke';
	} else {
		payload.http_url = null;
		payload.note = 'no HTTP endpoint on this transport; read resource_uri, or use delivery inline for files up to ' +
			`${INLINE_FILE_LIMIT_BYTES} bytes`;
	}
	return {
		content: [
			{ type: 'text', text: JSON.stringify(payload, null, 2) },
			{ type: 'resource_link', uri, name: resolved.info.name, mimeType: resolved.info.mime_type, size: resolved.size },
		],
		structuredContent: payload,
	};
}

// --- starting a download, and asking about one without taking it -------------

/** How long `browser_download` waits for the ledger to name the file it started. */
const DOWNLOAD_DETECT_MS = 5000;

/** Poll interval for that window. Short enough to feel immediate, long enough to cost nothing. */
const DOWNLOAD_POLL_MS = 100;

/** Starts a download and returns the `file_id` it will be readable under. */
export async function browserDownload(
	args: { index?: number; url?: string; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	if ((args.index === undefined) === (args.url === undefined)) {
		throw new ToolError('invalid-arguments', 'exactly one of index or url is required');
	}
	// The egress policy applies here for the same reason it applies to `browser_navigate`: this is a navigation, and
	// a human or a model routing a fetch through a different tool name is not a way around a deployment's allowlist.
	const url = args.url === undefined ? null : assertNavigable(args.url, ctx.allowedDomains);
	const record = await target(ctx, args, true);
	// Artifacts (`art-*`, `browser_pdf {delivery:'file'}`) are not downloads, so a concurrent one is never
	// mistaken for the file this call started.
	const downloadsOnly = () => record.files.list().filter((file) => !isArtifactId(file.file_id));
	const before = new Set(downloadsOnly().map((file) => file.file_id));
	// The `{index}` form's href, resolved before the click: what its chain begins at.
	const node = url === null ? nodeAt(record.session, args.index as number, args.state_token) : null;
	const href = node === null ? null : hrefOf(node, record.session.cachedBrowserState);
	// A download that begins as an off-list document request — a redirect hop, a script navigation after the click —
	// is refused by the browser before any byte, so the ledger never sees it.
	const targetId = record.session.agentFocusTargetId;
	const since = ctx.registry.now();
	const requested = url?.href ?? href;
	const refuseIfBlocked = (): void => {
		const blocked = blockedSince(record, targetId ?? record.session.agentFocusTargetId, since, requested);
		if (blocked !== null) throw downloadBlocked(blocked);
	};

	if (url !== null) {
		try {
			await dispatch(record.session, new NavigateToUrlEvent({ url: url.href }));
		} catch (cause) {
			// `net::ERR_ABORTED` is what Chromium reports for a navigation it turned into a download: the document
			// never commits, the bytes go to the ledger.
			if (!describe(cause).includes('ERR_ABORTED')) {
				refuseIfBlocked();
				throw cause;
			}
		}
		refuseIfBlocked();
	} else if (node !== null) {
		// **The `{index}` form is gated too, before the click.** An element's `href` is resolved absolute against its
		// own frame's URL — a relative `href` in a cross-origin frame resolves against *that* origin, not the top
		// document's — and the result goes through the same predicate as `{url}`.
		if (href !== null) assertNavigable(href, ctx.allowedDomains);
		await dispatch(record.session, new ClickElementEvent({ node }));
	}
	ctx.registry.touch(record.id);

	// The detection window is a wait bounded by a deadline; the heartbeat counts its seconds against it.
	ctx.progress?.({ total: DOWNLOAD_DETECT_MS / 1000, message: 'waiting for the browser to announce the download' });
	const deadline = Date.now() + DOWNLOAD_DETECT_MS;
	for (;;) {
		// The click or navigation has happened; a cancelled caller stops waiting to hear about the file.
		ctx.signal?.throwIfAborted();
		const started = downloadsOnly().find((file) => !before.has(file.file_id));
		if (started !== undefined) {
			// The ledger gate fired on the *final* URL: the browser followed a redirect off the allowlist, or a
			// script started a download the click could not have named.
			const blocked = record.blockedDownloads?.get(started.file_id);
			if (blocked !== undefined) throw downloadBlocked(blocked);
			// `download-failed`: the ledger refused the download at the moment the browser announced it — no
			// downloads directory, a filename it could not sanitize, or the session's tracked cap — so the caller
			// asked for a file and there will never be one.
			if (started.status === 'canceled' || started.status === 'failed') {
				// `reason` is the SAME closed vocabulary the `download.failed` event carries, classified by the same
				// function — a tool error and an event describing one download must not disagree about why it failed.
				const ledgerError = record.files.lookup(started.file_id)?.error ?? null;
				throw new ToolError(
					'download-failed',
					// `name` is empty on a record the ledger rejected at announcement — it never got as far as naming
					// a file — so the id is the fallback.
					`the browser announced ${started.name === '' ? `download ${started.file_id}` : started.name} ` +
						`but the download ledger did not accept it`,
					{ file_id: started.file_id, reason: downloadFailureReason(ledgerError) },
				);
			}
			return json({ session_id: record.id, started: true, file: started });
		}
		// The `{index}` form's click can start a script navigation the browser refuses before any byte;
		// there will never be a ledger entry to wait for, so the refusal is the answer, in the ledger's words.
		refuseIfBlocked();
		if (Date.now() >= deadline) break;
		await delay(DOWNLOAD_POLL_MS, ctx.signal === undefined ? {} : { signal: ctx.signal });
	}
	// **Not an error.** A click that navigated instead of downloading, or a download the browser is still deciding
	// about, is a truthful outcome about the page; `isError` would abort the model's turn over a fact.
	return json({
		session_id: record.id,
		started: false,
		file: null,
		detect_ms: DOWNLOAD_DETECT_MS,
		note: 'no download was announced within the detection window; poll browser_list_files, which stays authoritative',
	});
}

/**
 * An element's `href`, absolute against its frame's URL, or `null` when it has no http(s) target the server can gate
 * before clicking.
 */
export function hrefOf(
	node: { attributes?: Record<string, string> | null; frameId?: string | null },
	state: { url?: string; frames?: ReadonlyArray<{ frameId: string; url: string }> } | null | undefined,
): string | null {
	const raw = node.attributes?.href;
	if (typeof raw !== 'string' || raw.trim() === '') return null;
	const frame = node.frameId === undefined || node.frameId === null
		? undefined
		: state?.frames?.find((entry) => entry.frameId === node.frameId);
	const base = frame?.url ?? state?.url ?? undefined;
	const resolved = base === undefined ? URL.parse(raw) : URL.parse(raw, base);
	if (resolved === null) return null;
	if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
	return resolved.href;
}

/**
 * Asks a server about a URL without carrying its body back — from this process, with no cookie, gated at every hop.
 */
export async function browserHead(args: { url: string }, ctx: ToolContext): Promise<ToolResult> {
	// **The check is here, not only at availability**, because a control that lives solely in `tools/list` is a
	// control an out-of-band call walks straight past — a hidden tool can still be called by name.
	const refusal = headRoutingRefusal(ctx.registry.browserArgs);
	if (refusal !== null) throw new ToolError('feature-unavailable', refusal, { feature: 'egress' });
	// The caller's cancellation is the walk's fetch signal too, so a cancelled HEAD stops its request.
	return json({
		...(await headWalk(args.url, ctx.allowedDomains, ctx.signal === undefined ? {} : { signal: ctx.signal })),
	});
}

/** An artifact id (`art-<uuid>`, `SessionFiles.addArtifact`), which no download ever carries. */
function isArtifactId(fileId: string): boolean {
	return fileId.startsWith(ARTIFACT_ID_PREFIX);
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The one refusal text a blocked download gets, whether the ledger or the browser refused it. */
function downloadBlocked(origin: string): ToolError {
	return new ToolError(
		'navigation-blocked',
		`the download resolved to ${origin}, which is not in the server's allowed-domain list`,
	);
}

// --- the policy a client can read instead of infer ----------------------------

/** `browser_file_policy` — the retention and transfer limits, from the constants that enforce them. */
// deno-lint-ignore require-await -- a handler is always awaited; a synchronous throw would escape the result mapping.
export async function browserFilePolicy(_args: Record<string, never>, ctx: ToolContext): Promise<ToolResult> {
	return json({ ...filePolicyOf(ctx.registry.sessionTtlMs) });
}
