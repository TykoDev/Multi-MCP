/**
 * Browser outputs (R10, R11; design §2.7–§2.8; D-118, D-120): a printed PDF, a signed link to a session file, the
 * accessibility tree and the page's performance numbers.
 *
 * All four are reads. None dispatches input to the page, so each stays usable while a human holds the session's
 * takeover lock, and none needs a vendored edit: the PDF is `Page.printToPDF`, the tree is
 * `Accessibility.getFullAXTree`, and the runtime metrics go through `CdpClient.sendRaw` because the vendored CDP
 * surface has no typed `Performance` domain.
 */
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import { type BrowserSession, isPasswordField } from '@tykotech/browser';
import type { SessionId } from '@tykotech/cdp';
import { AX_MAX_NODES_DEFAULT, buildAxTree, type RawAxNode } from '../ax_tree.ts';
import { ToolError } from '../errors.ts';
import { INLINE_FILE_LIMIT_BYTES } from '../files.ts';
import { inFreshIsolatedWorld } from '../isolated_world.ts';
import { frameContext, liveFrameIdentity } from '../page_eval.ts';
import type { SessionRecord } from '../registry.ts';
import { fileResourceUri, RESOURCE_SCHEME } from '../resources.ts';
import { json, type ToolContext, type ToolResult } from '../types.ts';
import { heldToken, nodeAt, peekSession, target, untilAborted } from './shared.ts';

// --- shared -------------------------------------------------------------------

/** The connected session pieces, or a `browser-unavailable` refusal. */
function connected(session: BrowserSession) {
	const client = session.cdpClient;
	const manager = session.sessionManager;
	const focus = session.agentFocusTargetId;
	if (client === null || manager === null || focus === null) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	return { client, manager, focus };
}

/** A CDP failure as the tool error a model can act on, keeping one that is already typed. */
function cdpFailure(cause: unknown, what: string): ToolError {
	if (cause instanceof ToolError) return cause;
	const message = cause instanceof Error ? cause.message : String(cause);
	if (/timeout|timed out/i.test(message)) return new ToolError('timeout', `${what} timed out: ${message}`);
	return new ToolError('browser-unavailable', `${what} failed: ${message}`);
}

/** The origin of a URL, or `''` for one that has none worth naming. */
function originOf(url: string): string {
	const parsed = URL.parse(url);
	return parsed === null || parsed.origin === 'null' ? '' : parsed.origin;
}

// --- browser_pdf (R10, D-118) --------------------------------------------------------------------------------------

/**
 * The deadline on one print, in milliseconds: the value of the vendored `PRINT_TO_PDF_TIMEOUT_MS`
 * (`default_action.ts`), restated because the constant is not on `@tykotech/browser`'s public surface and exporting
 * it would be a vendored edit for a number.
 */
export const PDF_TIMEOUT_MS = 30_000;

/** The largest PDF this tool will carry at all, in bytes; past it the answer is a refusal, never a truncation. */
export const PDF_MAX_BYTES = 64 * 1024 * 1024;

/** Paper sizes in inches, as `Page.printToPDF` takes them. */
export const PDF_PAPER = {
	A4: { width: 8.27, height: 11.69 },
	Letter: { width: 8.5, height: 11 },
} as const;

/**
 * One `IO.read` of a streamed print, in bytes (review R2-7). Small enough that the cap is overshot by at most this
 * much before the read stops, large enough that a 64 MiB print is a few hundred round trips.
 */
export const PDF_READ_CHUNK_BYTES = 256 * 1024;

/** Decoded byte count of a base64 string, without decoding it. */
function base64Bytes(data: string): number {
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	return Math.floor(data.length / 4) * 3 - padding;
}

/** The refusal for a print over {@linkcode PDF_MAX_BYTES} — never a truncation. */
function pdfTooLarge(bytes: number | null): ToolError {
	return new ToolError(
		'file-unavailable',
		`the PDF is ${bytes === null ? 'more than that' : `${bytes} bytes`}, over the ${PDF_MAX_BYTES}-byte limit; ` +
			'print fewer pages with page_ranges',
	);
}

/**
 * Review R2-7: a streamed print read in {@linkcode PDF_READ_CHUNK_BYTES} chunks, **stopping** as soon as it passes
 * {@linkcode PDF_MAX_BYTES}, the handle closed on every path. This process never holds more than the cap plus one
 * chunk, where `ReturnAsBase64` made it hold the whole print (a third larger, as base64) before it could refuse.
 * Chromium still renders the whole PDF in its own process; that cost is outside this bound.
 */
async function readPdfStream(
	client: { sendRaw<T>(method: string, params?: Record<string, unknown>, sessionId?: SessionId): Promise<T> },
	handle: string,
	sessionId: SessionId,
	signal: AbortSignal | undefined,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			signal?.throwIfAborted();
			const chunk = await client.sendRaw<{ data?: string; eof?: boolean; base64Encoded?: boolean }>(
				'IO.read',
				{ handle, size: PDF_READ_CHUNK_BYTES },
				sessionId,
			);
			const data = chunk.data ?? '';
			const bytes = chunk.base64Encoded === true ? decodeBase64(data) : new TextEncoder().encode(data);
			total += bytes.length;
			if (total > PDF_MAX_BYTES) throw pdfTooLarge(null);
			chunks.push(bytes);
			if (chunk.eof === true || bytes.length === 0) break;
		}
	} finally {
		await client.sendRaw('IO.close', { handle }, sessionId).catch(() => {});
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/**
 * `browser_pdf` — the focused tab printed to PDF (design §2.7).
 *
 * Header and footer templates are never sent: they are HTML this server would render with the page's privileges,
 * and nothing a caller needs from a PDF of the page is worth that surface (`displayHeaderFooter: false`). The bytes
 * come back inline up to `INLINE_FILE_LIMIT_BYTES`, or are kept as a session artifact readable through
 * `browser_get_file` (D-119); a PDF over the inline limit asked for inline is a refusal naming the other delivery.
 *
 * M10 (design §2.21), measured 2026-10-04 on Chrome 154.0.8037.93 through the repo's `SessionRegistry`: a
 * `TTK_HEADLESS=false` session printed a valid `%PDF-` exactly as a headless one did, so the design's fallback (a
 * "PDF needs headless" refusal when headful) is not taken and the tool makes no distinction; a browser that refuses
 * to print is reported as `browser-unavailable` with Chromium's own reason. The image's Chromium is exercised by the
 * container tier (`tests/container/verify_container.ts`, signed-links leg).
 */
export async function browserPdf(
	args: {
		session_id?: string;
		landscape?: boolean;
		print_background?: boolean;
		scale?: number;
		page_ranges?: string;
		paper?: 'A4' | 'Letter';
		delivery?: 'inline' | 'file';
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	ctx.signal?.throwIfAborted();
	const record = await target(ctx, args, false);
	const { client, manager, focus } = connected(record.session);
	const paper = PDF_PAPER[args.paper ?? 'A4'];
	const delivery = args.delivery ?? 'inline';
	const ranges = args.page_ranges?.trim() ?? '';
	let pdf: Uint8Array;
	try {
		const page = await manager.getOrCreateCdpSession(focus, true);
		const printed = await untilAborted(
			client.send.Page.printToPDF(
				{
					landscape: args.landscape ?? false,
					printBackground: args.print_background ?? true,
					...(args.scale === undefined ? {} : { scale: args.scale }),
					...(ranges === '' ? {} : { pageRanges: ranges }),
					paperWidth: paper.width,
					paperHeight: paper.height,
					displayHeaderFooter: false,
					// Review R2-7: streamed, so the cap bounds what this process reads rather than what it checks afterwards.
					transferMode: 'ReturnAsStream',
				},
				page.sessionId,
				{ requestTimeoutMs: PDF_TIMEOUT_MS },
			),
			ctx.signal,
		);
		if (typeof printed.stream === 'string' && printed.stream !== '') {
			pdf = await untilAborted(readPdfStream(client, printed.stream, page.sessionId, ctx.signal), ctx.signal);
		} else {
			// A browser that answered inline despite the stream request: measured from the length, as before.
			const data = printed.data ?? '';
			if (base64Bytes(data) > PDF_MAX_BYTES) throw pdfTooLarge(base64Bytes(data));
			pdf = decodeBase64(data);
		}
	} catch (cause) {
		if (ctx.signal?.aborted === true) throw cause;
		if (cause instanceof ToolError) throw cause;
		const message = cause instanceof Error ? cause.message : String(cause);
		// Chromium names a bad range itself ("Page range syntax error", "Page range exceeds page count"); that is
		// the caller's argument, not the browser's fault.
		if (/page range/i.test(message)) throw new ToolError('invalid-arguments', `page_ranges: ${message}`);
		throw cdpFailure(cause, 'printing the page');
	}
	ctx.registry.touch(record.id);
	const bytes = pdf.length;
	if (delivery === 'inline') {
		if (bytes > INLINE_FILE_LIMIT_BYTES) {
			throw new ToolError(
				'file-unavailable',
				`the PDF is ${bytes} bytes, over the ${INLINE_FILE_LIMIT_BYTES}-byte inline limit; call browser_pdf with ` +
					'delivery: "file" and read it with browser_get_file',
			);
		}
		const payload = { session_id: record.id, delivery: 'inline', bytes };
		return {
			content: [
				{ type: 'text', text: JSON.stringify(payload, null, 2) },
				{
					type: 'resource',
					// An identifier for the embedded bytes, not a readable resource: the PDF is not kept.
					resource: {
						uri: `${RESOURCE_SCHEME}://session/${encodeURIComponent(record.id)}/pdf`,
						mimeType: 'application/pdf',
						blob: encodeBase64(pdf),
					},
				},
			],
			structuredContent: payload,
		};
	}
	const file = await record.files.addArtifact({
		name: 'page.pdf',
		mimeType: 'application/pdf',
		bytes: pdf,
	});
	const payload = { session_id: record.id, delivery: 'file', bytes, file };
	const uri = fileResourceUri(record.id, file.file_id);
	return {
		content: [
			{ type: 'text', text: JSON.stringify(payload, null, 2) },
			{ type: 'resource_link', uri, name: file.name, mimeType: file.mime_type, size: file.size },
		],
		structuredContent: payload,
	};
}

// --- browser_file_link (R10, D-119) --------------------------------------------------------------------------------

/**
 * `browser_file_link` — a URL that downloads one session file with no credential, for at most an hour (design §2.7;
 * D-119, D-140).
 *
 * The file is resolved first, so a link is never minted for a file that cannot be served now; the minter (built by
 * the gateway only with `TTK_SIGNED_LINKS=true`) signs the session and its **incarnation**, the file and the **owner**
 * the call ran as, and the route re-checks that owner — and that its credential is still the one it was — before it
 * serves a byte. `notAfter` is the calling credential's own expiry (`ctx.credentialNotAfter`, an OAuth token's `exp`),
 * which the link may not outlive (F1). The URL is the credential for its lifetime — it is handed to the caller who
 * asked for it and to nobody else, and never logged.
 */
export async function browserFileLink(
	args: { file_id: string; session_id?: string; ttl_seconds?: number },
	ctx: ToolContext,
): Promise<ToolResult> {
	// Availability already withholds the tool without a minter; this is the out-of-band call's answer.
	if (ctx.signedLink === undefined) {
		throw new ToolError(
			'feature-unavailable',
			'browser_file_link needs signed links, which this deployment has not enabled (TTK_SIGNED_LINKS)',
		);
	}
	const record = peekSession(ctx, args.session_id);
	await record.files.resolve(args.file_id);
	const owner = ctx.access?.owner ?? ctx.extensionPrincipal ?? ctx.principal;
	const link = await ctx.signedLink({
		sessionId: record.id,
		fileId: args.file_id,
		owner,
		incarnation: record.incarnation,
		...(args.ttl_seconds === undefined ? {} : { ttlSeconds: args.ttl_seconds }),
		...(ctx.credentialNotAfter === undefined ? {} : { notAfter: ctx.credentialNotAfter }),
	});
	return json({
		session_id: record.id,
		file_id: args.file_id,
		url: link.url,
		expires_at: link.expiresAt,
		ttl_seconds: link.ttlSeconds,
	});
}

// --- browser_accessibility_snapshot (R11, D-120) -------------------------------------------------------------------

/**
 * The `browser_get_state` indices and the password fields of the held element table, keyed by `backendNodeId`, for
 * the nodes of one CDP session — a backend id names a node only within its own renderer (E-93's lesson).
 */
function tableFacts(
	record: SessionRecord,
	sessionId: string,
): { indexByBackendId: Map<number, number>; passwordBackendIds: Set<number> } {
	const indexByBackendId = new Map<number, number>();
	const passwordBackendIds = new Set<number>();
	const selectorMap = record.session.cachedBrowserState?.domState.selectorMap;
	for (const [index, node] of selectorMap ?? []) {
		if (node.sessionId !== sessionId) continue;
		indexByBackendId.set(node.backendNodeId, index);
		if (isPasswordField(node)) passwordBackendIds.add(node.backendNodeId);
	}
	return { indexByBackendId, passwordBackendIds };
}

/**
 * `browser_accessibility_snapshot` — the page's accessibility tree, bounded, with no field value in it (§2.8).
 *
 * A fresh `Accessibility.getFullAXTree` for the focused document or a named frame, or `getPartialAXTree` for one
 * element of the held table. The value rules live in `ax_tree.ts`; this handler supplies what they need from the
 * session — which table indices and which password fields belong to the CDP session the tree came from — and the
 * deployment's `redact`.
 */
export async function browserAccessibilitySnapshot(
	args: {
		session_id?: string;
		frame_id?: string;
		index?: number;
		interesting_only?: boolean;
		max_nodes?: number;
		state_token?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	if (args.index !== undefined && args.frame_id !== undefined) {
		throw new ToolError('invalid-arguments', 'give index or frame_id, not both: an index already names its frame');
	}
	const record = await target(ctx, args, false);
	const { client, manager, focus } = connected(record.session);
	let nodes: RawAxNode[];
	let sessionId: string;
	let frameId: string;
	try {
		if (args.index !== undefined) {
			const node = nodeAt(record.session, args.index, args.state_token);
			const page = await manager.getOrCreateCdpSession(focus, true);
			sessionId = node.sessionId === '' ? page.sessionId : node.sessionId;
			({ nodes } = await untilAborted(
				client.send.Accessibility.getPartialAXTree(
					{ backendNodeId: node.backendNodeId, fetchRelatives: false },
					sessionId as SessionId,
				),
				ctx.signal,
			));
			frameId = node.frameId !== '' ? node.frameId : (await liveFrameIdentity(record, await frameContext(record)))
				.frameId;
		} else {
			const frame = await frameContext(record, args.frame_id);
			const identity = await liveFrameIdentity(record, frame);
			sessionId = frame.sessionId;
			frameId = identity.frameId;
			// A same-process child frame is addressed through its host's session by id; the top document and an
			// out-of-process frame are each their session's own root.
			({ nodes } = await untilAborted(
				client.send.Accessibility.getFullAXTree(
					frame.isSessionDocument ? {} : { frameId: frame.frameId },
					frame.sessionId,
				),
				ctx.signal,
			));
		}
	} catch (cause) {
		if (ctx.signal?.aborted === true) throw cause;
		throw cdpFailure(cause, 'reading the accessibility tree');
	}
	ctx.registry.touch(record.id);
	const facts = tableFacts(record, sessionId);
	const secrets = ctx.secrets;
	const built = buildAxTree(nodes, {
		interestingOnly: args.interesting_only ?? true,
		maxNodes: args.max_nodes ?? AX_MAX_NODES_DEFAULT,
		indexByBackendId: facts.indexByBackendId,
		passwordBackendIds: facts.passwordBackendIds,
		...(secrets === undefined ? {} : { redact: (text: string) => secrets.redact(text) }),
	});
	const payload = {
		session_id: record.id,
		frame_id: frameId,
		nodes_total: built.nodesTotal,
		truncated: built.truncated,
		tree: built.tree,
		outline: built.outline,
		state_token: heldToken(record),
	};
	// The tree stays in `structuredContent`; the text block is the outline a model reads, plus the counts.
	const header = `accessibility tree of frame ${frameId}: ${built.nodesTotal} nodes` +
		(built.truncated ? `, first ${args.max_nodes ?? AX_MAX_NODES_DEFAULT} shown` : '');
	return { content: [{ type: 'text', text: `${header}\n${built.outline}` }], structuredContent: payload };
}

// --- browser_performance (R11, D-120, E-97) ------------------------------------------------------------------------

/**
 * Where the vitals are read (M7, design §2.21).
 *
 * Measured 2026-10-04 on Chrome 154.0.8037.93, headless and headful: {@linkcode VITALS_SCRIPT} evaluated in the main
 * world and in a fresh `Page.createIsolatedWorld` context of the same document returned identical numbers —
 * navigation timing, the paint entry, and buffered `largest-contentful-paint` and `layout-shift` entries all resolve
 * in the isolated world — so the read happens where page script cannot redefine `performance`, and the design's
 * main-world fallback (E-97) is not taken. `tests/e2e/media_e2e_test.ts` holds the same comparison as a standing
 * check, so a Chromium that stops delivering buffered entries to isolated worlds fails it rather than reporting nulls.
 */
export const VITALS_WORLD: 'isolated' | 'main' = 'isolated';

/** How long the buffered observers are given to deliver, in milliseconds (design §2.8: at most one second). */
export const VITALS_DRAIN_MS = 200;

/**
 * The vitals read, one fixed expression with no caller text in it.
 *
 * TTFB, DOMContentLoaded and load from the navigation entry, each relative to `activationStart` (a prerendered page
 * starts counting when it is shown); FCP from the paint entry; LCP, CLS and INP from one-shot **buffered** observers
 * drained for {@linkcode VITALS_DRAIN_MS}. CLS is the largest session window (gaps under 1 s, windows under 5 s);
 * INP is the 98th-percentile interaction latency of the buffered `event` entries. Buffered event entries are kept
 * by the browser only above its own duration floor and observers created this late miss what was never buffered, so
 * both under-report against a field measurement from page load — the stated limit of a one-shot read.
 */
export const VITALS_SCRIPT = `(async () => {
	const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	const nav = performance.getEntriesByType('navigation')[0] ?? null;
	const act = nav !== null && typeof nav.activationStart === 'number' ? nav.activationStart : 0;
	const since = (t) => (typeof t === 'number' && t > 0 ? Math.max(0, t - act) : null);
	const paint = performance.getEntriesByName('first-contentful-paint')[0] ?? null;
	const supported = typeof PerformanceObserver === 'function' ? (PerformanceObserver.supportedEntryTypes ?? []) : [];
	const drain = (type, extra) => new Promise((resolve) => {
		if (!supported.includes(type)) { resolve(null); return; }
		let entries = [];
		let observer;
		try {
			observer = new PerformanceObserver((list) => { entries = entries.concat(list.getEntries()); });
			observer.observe(Object.assign({ type, buffered: true }, extra));
		} catch { resolve(null); return; }
		setTimeout(() => {
			try { entries = entries.concat(observer.takeRecords()); observer.disconnect(); } catch {}
			resolve(entries);
		}, ${VITALS_DRAIN_MS});
	});
	const [lcpEntries, shifts, events] = await Promise.all([
		drain('largest-contentful-paint', {}),
		drain('layout-shift', {}),
		drain('event', { durationThreshold: 16 }),
	]);
	let lcp = null;
	if (lcpEntries !== null && lcpEntries.length > 0) lcp = since(lcpEntries[lcpEntries.length - 1].startTime);
	let cls = null;
	if (shifts !== null) {
		cls = 0;
		let windowValue = 0, windowStart = 0, last = 0;
		for (const shift of shifts) {
			if (shift.hadRecentInput) continue;
			if (windowValue > 0 && shift.startTime - last < 1000 && shift.startTime - windowStart < 5000) {
				windowValue += shift.value;
			} else {
				windowValue = shift.value;
				windowStart = shift.startTime;
			}
			last = shift.startTime;
			cls = Math.max(cls, windowValue);
		}
	}
	let inp = null;
	if (events !== null) {
		const byInteraction = new Map();
		for (const event of events) {
			if (!event.interactionId) continue;
			byInteraction.set(event.interactionId, Math.max(byInteraction.get(event.interactionId) ?? 0, event.duration));
		}
		const latencies = [...byInteraction.values()].sort((a, b) => b - a);
		if (latencies.length > 0) inp = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length / 50))];
	}
	return {
		ttfb_ms: nav === null ? null : num(Math.max(0, nav.responseStart - act)),
		dcl_ms: nav === null ? null : since(nav.domContentLoadedEventEnd),
		load_ms: nav === null ? null : since(nav.loadEventEnd),
		fcp_ms: paint === null ? null : since(paint.startTime),
		lcp_ms: num(lcp),
		cls: num(cls),
		inp_ms: num(inp),
	};
})()`;

/** The seven vitals, each a number or `null` (design §2.3). */
export interface Vitals {
	ttfb_ms: number | null;
	dcl_ms: number | null;
	load_ms: number | null;
	fcp_ms: number | null;
	lcp_ms: number | null;
	cls: number | null;
	inp_ms: number | null;
}

const VITAL_KEYS: readonly (keyof Vitals)[] = ['ttfb_ms', 'dcl_ms', 'load_ms', 'fcp_ms', 'lcp_ms', 'cls', 'inp_ms'];

/**
 * The page's answer, held to the shape: a finite number (milliseconds to two decimals, CLS to four) or `null`.
 * Whatever else the evaluation produced — a page that redefined `performance` in the main world, or nothing — is
 * `null` rather than passed on.
 */
export function vitalsOf(value: unknown): Vitals {
	const source = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	const out = {} as Vitals;
	for (const key of VITAL_KEYS) {
		const raw = source[key];
		const places = key === 'cls' ? 10_000 : 100;
		out[key] = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw * places) / places : null;
	}
	return out;
}

/** The runtime metrics `Performance.getMetrics` reports, under this tool's names (design §2.3). */
export interface RuntimeMetrics {
	js_heap_used_bytes: number | null;
	nodes: number | null;
	layout_count: number | null;
	recalc_style_count: number | null;
	script_duration_s: number | null;
	task_duration_s: number | null;
}

const RUNTIME_NAMES: Readonly<Record<keyof RuntimeMetrics, string>> = {
	js_heap_used_bytes: 'JSHeapUsedSize',
	nodes: 'Nodes',
	layout_count: 'LayoutCount',
	recalc_style_count: 'RecalcStyleCount',
	script_duration_s: 'ScriptDuration',
	task_duration_s: 'TaskDuration',
};

/** `Performance.getMetrics`' list, reduced to the six this tool reports. */
export function runtimeOf(metrics: unknown): RuntimeMetrics {
	const list = Array.isArray(metrics) ? metrics as Array<{ name?: unknown; value?: unknown }> : [];
	const out = {} as RuntimeMetrics;
	for (const [key, name] of Object.entries(RUNTIME_NAMES) as Array<[keyof RuntimeMetrics, string]>) {
		const value = list.find((metric) => metric.name === name)?.value;
		out[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
	}
	return out;
}

/**
 * The CDP page sessions on which this server has turned the `Performance` domain on, per session record
 * (ERRATUM(E-97)).
 *
 * Design §2.8 had each call run `Performance.enable` → `getMetrics` → `disable`. Measured on Chrome 154
 * (`tests/e2e/media_e2e_test.ts`): Chromium counts layouts, style recalculations, script and task time **only while
 * the domain is enabled**, so that sequence reported `LayoutCount: 0`, `RecalcStyleCount: 0`, `ScriptDuration: 0` on a
 * page that had just laid out and run script — the counters began at the `enable` one round trip earlier. So the
 * domain is enabled on a page session's first call and left on: the snapshot metrics (heap, nodes) are right from
 * the first call, and the counters count from it. Weakly held, so the set dies with the session.
 */
const performanceSessions = new WeakMap<SessionRecord, Set<string>>();

/**
 * `browser_performance` — Core Web Vitals and runtime counters for the focused tab (design §2.8, D-120, E-97).
 *
 * The vitals are one `Runtime.evaluate` of {@linkcode VITALS_SCRIPT} in a fresh isolated world of the top frame
 * (`inFreshIsolatedWorld`, M7), so a page cannot answer for its own `performance`; `vitals_world` names the world
 * the numbers came from. The runtime metrics are `Performance.getMetrics` through `sendRaw` — the vendored CDP
 * surface has no typed `Performance` domain and adding one would be a vendored edit — with the domain enabled once
 * per page session and left on ({@linkcode performanceSessions}, E-97).
 */
export async function browserPerformance(
	args: { session_id?: string; metrics?: Array<'vitals' | 'runtime'> },
	ctx: ToolContext,
): Promise<ToolResult> {
	const wanted = new Set(args.metrics ?? ['vitals', 'runtime']);
	const record = await target(ctx, args, false);
	const { client } = connected(record.session);
	let origin: string;
	let vitals: Vitals | null = null;
	let runtime: RuntimeMetrics | null = null;
	try {
		const frame = await frameContext(record);
		const identity = await liveFrameIdentity(record, frame);
		origin = originOf(identity.topUrl);
		const sessionId = frame.sessionId;
		if (wanted.has('vitals')) {
			const read = async (contextId?: number): Promise<Vitals> => {
				const evaluated = await client.send.Runtime.evaluate(
					{
						expression: VITALS_SCRIPT,
						...(contextId === undefined ? {} : { contextId }),
						awaitPromise: true,
						returnByValue: true,
						silent: true,
					},
					sessionId,
					{ requestTimeoutMs: 5_000 },
				);
				if (evaluated.exceptionDetails !== undefined) {
					throw new ToolError('browser-unavailable', 'the page could not report its timing');
				}
				return vitalsOf(evaluated.result.value);
			};
			vitals = await untilAborted(
				VITALS_WORLD === 'isolated'
					? inFreshIsolatedWorld(client, sessionId, identity.frameId, (contextId) => read(contextId))
					: read(),
				ctx.signal,
			);
		}
		if (wanted.has('runtime')) {
			runtime = await untilAborted(
				(async () => {
					let enabled = performanceSessions.get(record);
					if (enabled === undefined) {
						enabled = new Set();
						performanceSessions.set(record, enabled);
					}
					try {
						if (!enabled.has(sessionId)) {
							await client.sendRaw('Performance.enable', {}, sessionId);
							enabled.add(sessionId);
						}
						const answer = await client.sendRaw<{ metrics?: unknown }>('Performance.getMetrics', {}, sessionId);
						return runtimeOf(answer.metrics);
					} catch (cause) {
						// A session that could not answer is asked to enable again next time, rather than trusted.
						enabled.delete(sessionId);
						throw cause;
					}
				})(),
				ctx.signal,
			);
		}
	} catch (cause) {
		if (ctx.signal?.aborted === true) throw cause;
		throw cdpFailure(cause, 'reading the page performance');
	}
	ctx.registry.touch(record.id);
	return json({
		session_id: record.id,
		origin,
		vitals,
		vitals_world: vitals === null ? null : VITALS_WORLD,
		runtime,
	});
}
