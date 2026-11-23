/**
 * Browser outputs: a printed PDF, a signed link to a session file, the accessibility tree and the page's performance
 * numbers.
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

// --- browser_pdf ---------------------------------------------------------------------------------------------------

/**
 * The deadline on one print, in milliseconds: the value of the vendored `PRINT_TO_PDF_TIMEOUT_MS`
 * (`default_action.ts`), restated because the constant is not on `@tykotech/browser`'s public surface and exporting
 * it would be a vendored edit for a number.
 */
export const PDF_TIMEOUT_MS = 30_000;

/** The largest PDF this tool will carry at all, in bytes; past it the answer is a refusal, never a truncation. */
export const PDF_MAX_BYTES = 64 * 1024 * 1024;

/** Paper sizes in inches, as `Page.printToPDF` takes them. */
const PDF_PAPER = {
	A4: { width: 8.27, height: 11.69 },
	Letter: { width: 8.5, height: 11 },
} as const;

/** One `IO.read` of a streamed print, in bytes. */
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
 * A streamed print read in {@linkcode PDF_READ_CHUNK_BYTES} chunks, **stopping** as soon as it passes
 * {@linkcode PDF_MAX_BYTES}, the handle closed on every path.
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

/** `browser_pdf` — the focused tab printed to PDF. */
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
					// Streamed, so the cap bounds what this process reads rather than what it checks afterwards.
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

// --- browser_file_link ---------------------------------------------------------------------------------------------

/** `browser_file_link` — a URL that downloads one session file with no credential, for at most an hour. */
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
	});
	return json({
		session_id: record.id,
		file_id: args.file_id,
		url: link.url,
		expires_at: link.expiresAt,
		ttl_seconds: link.ttlSeconds,
	});
}

// --- browser_accessibility_snapshot --------------------------------------------------------------------------------

/**
 * The `browser_get_state` indices and the password fields of the held element table, keyed by `backendNodeId`, for
 * the nodes of one CDP session — a backend id names a node only within its own renderer.
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

/** `browser_accessibility_snapshot` — the page's accessibility tree, bounded, with no field value in it. */
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

// --- browser_performance -------------------------------------------------------------------------------------------

/** Where the vitals are read. */
const VITALS_WORLD: 'isolated' | 'main' = 'isolated';

/** How long the buffered observers are given to deliver, in milliseconds (kept well under one second). */
const VITALS_DRAIN_MS = 200;

/** The vitals read, one fixed expression with no caller text in it. */
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

/** The seven vitals, each a number or `null`. */
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

/** The page's answer, held to the shape: a finite number (milliseconds to two decimals, CLS to four) or `null`. */
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

/** The runtime metrics `Performance.getMetrics` reports, under this tool's names. */
interface RuntimeMetrics {
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

/** The CDP page sessions on which this server has turned the `Performance` domain on, per session record. */
const performanceSessions = new WeakMap<SessionRecord, Set<string>>();

/** `browser_performance` — Core Web Vitals and runtime counters for the focused tab. */
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
