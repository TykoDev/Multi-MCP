/**
 * CDP capture — everything the three-tree merge needs, pulled off the wire into a plain-JSON record.
 *
 * Contract: SPECS/ARCHITECTURE.md §6.7 (DOMWatchdog budget: ≤2 s pending-network probe with a 0.3 s
 * stability pause, 20 s combined build budget), §7.3 (SessionManager owns targets/sessions — this
 * module *consumes* sessions), SPECS/DATA-MODEL.md §6.1–§6.2.
 *
 * The output type {@linkcode DomCapture} is deliberately JSON-shaped: it is what the fixture corpus
 * under `packages/core/fixtures/dom/` stores, which makes the whole merge testable without a browser
 * (a recorded CDP payload is data, not a mock — D-TEST1).
 */

import type { CdpClient, CdpResult, SessionId } from '@tykotech/cdp';
import type { CapturedAxNode } from './extract_ax.ts';
import { type CapturedSnapshot, SNAPSHOT_COMPUTED_STYLES } from './extract_snapshot.ts';

/** `DOM.getDocument` root node, recursive. */
export type CapturedDomNode = CdpResult['DOM.getDocument']['root'];

// ---------------------------------------------------------------------------
// budget constants (ARCHITECTURE §6.7, §8) — asserted verbatim by extract_test.ts
// ---------------------------------------------------------------------------

/** DOM build + screenshot share this ceiling (ARCHITECTURE §6.7). */
export const DOM_BUILD_BUDGET_MS = 20_000;

/** Pending-network probe cap (ARCHITECTURE §6.7). */
export const NETWORK_PROBE_MAX_MS = 2_000;

/** Quiet period the probe requires before declaring the network stable (ARCHITECTURE §6.7). */
export const NETWORK_STABILITY_MS = 300;

/** `Runtime.getEventListeners` census caps (DATA-MODEL §6.1). */
export const LISTENER_CENSUS_MAX_ELEMENTS = 10_000;
export const LISTENER_CENSUS_MAX_LISTENERS = 100;

/** Event types that make an element behave like a click target. */
export const CLICK_LISTENER_TYPES: readonly string[] = [
	'click',
	'mousedown',
	'mouseup',
	'pointerdown',
	'pointerup',
	'touchstart',
	'touchend',
];

// ---------------------------------------------------------------------------
// capture record (the fixture shape)
// ---------------------------------------------------------------------------

/** Viewport + content geometry in CSS px, from one `Page.getLayoutMetrics`. */
export interface CapturedLayoutMetrics {
	readonly scrollX: number;
	readonly scrollY: number;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
	readonly contentWidth: number;
	readonly contentHeight: number;
}

/**
 * One frame's slice of the `getEventListeners` census.
 *
 * `hits` are indices into that document's `querySelectorAll('*')` order, which the merge reproduces
 * by walking the document's element nodes in preorder (skipping shadow roots and frame content, both
 * of which `querySelectorAll` also skips). `total` lets the merge detect a mismatch — a page that
 * mutated between the DOM read and the census — and drop the frame's data instead of mis-attributing
 * listeners to the wrong elements.
 */
export interface ListenerCensusFrame {
	/** `''` for the session's top document; otherwise dot-joined child-frame indices, e.g. `'0.2'`. */
	readonly frame: string;
	readonly total: number;
	readonly scanned: number;
	readonly hits: readonly number[];
}

/** The whole census for one session. */
export interface ListenerCensus {
	readonly frames: readonly ListenerCensusFrame[];
	/** True when the element budget ran out before every frame was scanned. */
	readonly truncated: boolean;
}

/** Everything captured from one CDP session (one target). */
export interface CapturedSession {
	readonly targetId: string;
	readonly sessionId: string;
	/** Root frame of this target. For an OOPIF, Chrome uses `frameId === targetId`. */
	readonly frameId: string;
	readonly url: string;
	readonly devicePixelRatio: number;
	readonly layoutMetrics: CapturedLayoutMetrics;
	readonly document: CapturedDomNode;
	readonly snapshot: CapturedSnapshot;
	readonly axNodes: readonly CapturedAxNode[];
	readonly listeners: ListenerCensus | null;
}

/** A full capture: the root page session plus every OOPIF session reachable from it. */
export interface DomCapture {
	readonly rootSessionId: string;
	readonly sessions: readonly CapturedSession[];
	readonly warnings: readonly string[];
	/**
	 * ERRATUM(E-40). True when the walk stopped at `maxSessions` and deeper OOPIFs were skipped.
	 * Optional because recorded fixtures predate it; absent reads as `false`.
	 */
	readonly truncated?: boolean;
}

/** A target/session pair as SessionManager hands them out (ARCHITECTURE §7.3). */
export interface DomTargetSession {
	readonly targetId: string;
	readonly sessionId: string;
	/** Root frame of the target; defaults to `targetId`, which is what Chrome uses for OOPIFs. */
	readonly frameId?: string;
}

/**
 * SessionManager seam: given the `frameId` of an out-of-process iframe, return the session serving
 * it, or `null` when there is none (frame not attached, or attachment is not this caller's business).
 *
 * Extraction never attaches targets itself in production — that is SessionManager's job (§7.3).
 * {@linkcode createAttachingChildSessionResolver} exists for callers that have no SessionManager yet
 * (the integration tier, the fixture recorder).
 */
export type ChildSessionResolver = (frameId: string) => Promise<DomTargetSession | null>;

/** Options for {@linkcode captureDom}. */
export interface CaptureDomOptions {
	readonly client: CdpClient;
	readonly root: DomTargetSession;
	readonly resolveChildSession?: ChildSessionResolver;
	/** Off makes every `hasJsClickListener` false; on costs one `Runtime.evaluate` per session. */
	readonly includeListenerCensus?: boolean;
	readonly signal?: AbortSignal;
	/** Guards runaway OOPIF chains. */
	readonly maxSessions?: number;
}

/** Default ceiling on how many sessions one capture will walk. */
export const MAX_CAPTURE_SESSIONS = 32;

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/**
 * Capture the root session and every OOPIF session reachable from it.
 *
 * Per session the four reads (`DOM.getDocument`, `DOMSnapshot.captureSnapshot`,
 * `Accessibility.getFullAXTree`, `Page.getLayoutMetrics` + the DPR probe) are issued concurrently:
 * they are independent, and serializing them would spend four round trips of the 20 s budget for no
 * reason (ARCHITECTURE §8 — parallelism is I/O concurrency).
 */
export async function captureDom(options: CaptureDomOptions): Promise<DomCapture> {
	const { client, root } = options;
	const maxSessions = options.maxSessions ?? MAX_CAPTURE_SESSIONS;
	const warnings: string[] = [];
	const sessions: CapturedSession[] = [];
	const seen = new Set<string>();
	const queue: DomTargetSession[] = [root];
	let truncated = false;

	while (queue.length > 0) {
		const next = queue.shift();
		if (next === undefined) break;
		if (seen.has(next.sessionId)) continue;
		if (sessions.length >= maxSessions) {
			warnings.push(`capture stopped at maxSessions=${maxSessions}; deeper OOPIFs were skipped`);
			// ERRATUM(E-40): a structural flag beside the warning, because the warning is never merged
			// into `browserErrors` and the wire needs a boolean it can publish as `capture_truncated`.
			truncated = true;
			break;
		}
		seen.add(next.sessionId);
		const captured = await captureSession(client, next, options, warnings);
		sessions.push(captured);

		if (options.resolveChildSession === undefined) continue;
		for (const frameId of findOopifFrameIds(captured.document)) {
			const child = await options.resolveChildSession(frameId);
			if (child === null) {
				warnings.push(`no session for out-of-process frame ${frameId}`);
				continue;
			}
			queue.push(child);
		}
	}

	return { rootSessionId: root.sessionId, sessions, warnings, truncated };
}

async function captureSession(
	client: CdpClient,
	target: DomTargetSession,
	options: CaptureDomOptions,
	warnings: string[],
): Promise<CapturedSession> {
	const sessionId = target.sessionId as SessionId;
	const opts = options.signal === undefined ? undefined : { signal: options.signal };

	// `DOM.getDocument` is what makes nodeIds valid for this session; enabling first keeps the tree
	// and any later action-layer nodeId lookups consistent.
	await client.send.DOM.enable(undefined, sessionId, opts);

	const [document, snapshot, ax, metrics, dpr] = await Promise.all([
		client.send.DOM.getDocument({ depth: -1, pierce: true }, sessionId, opts),
		client.send.DOMSnapshot.captureSnapshot(
			{
				computedStyles: [...SNAPSHOT_COMPUTED_STYLES],
				includePaintOrder: true,
				includeDOMRects: true,
			},
			sessionId,
			opts,
		),
		client.send.Accessibility.getFullAXTree(undefined, sessionId, opts),
		client.send.Page.getLayoutMetrics(undefined, sessionId, opts),
		client.send.Runtime.evaluate(
			{
				expression: 'window.devicePixelRatio',
				returnByValue: true,
			},
			sessionId,
			opts,
		),
	]);

	// ERRATUM(M1-parity-17): `Accessibility.getFullAXTree` with no `frameId` returns **only** this
	// session's main frame, so every same-origin iframe `DOM.getDocument(pierce: true)` inlined arrived
	// with no accessible name, role or property at all — measurable as `role=null name=null` on every
	// row of `iframe_inner_scroll` and a missing `expanded=false` on `iframe_nested`'s nested `<select>`.
	// One extra call per pierced frame closes it; the ids share this session's `backendNodeId` space, so
	// the node lists concatenate.
	const axNodes = [...ax.nodes];
	for (const frameId of findSameOriginFrameIds(document.root)) {
		try {
			const frameAx = await client.send.Accessibility.getFullAXTree({ frameId }, sessionId, opts);
			axNodes.push(...frameAx.nodes);
		} catch (error) {
			warnings.push(`no accessibility tree for same-origin frame ${frameId}: ${describeError(error)}`);
		}
	}

	let listeners: ListenerCensus | null = null;
	if (options.includeListenerCensus !== false) {
		listeners = await runListenerCensus(client, sessionId, opts, warnings);
	}

	const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
	const content = metrics.cssContentSize ?? metrics.contentSize;
	const rawDpr = dpr.result.value;

	return {
		targetId: target.targetId,
		sessionId: target.sessionId,
		frameId: target.frameId ?? target.targetId,
		url: findDocumentUrl(document.root),
		devicePixelRatio: typeof rawDpr === 'number' && rawDpr > 0 ? rawDpr : 1,
		layoutMetrics: {
			scrollX: viewport.pageX,
			scrollY: viewport.pageY,
			viewportWidth: viewport.clientWidth,
			viewportHeight: viewport.clientHeight,
			contentWidth: content.width,
			contentHeight: content.height,
		},
		document: document.root,
		snapshot,
		axNodes,
		listeners,
	};
}

function findDocumentUrl(node: CapturedDomNode): string {
	return node.documentURL ?? node.baseURL ?? '';
}

/**
 * `frameId`s of iframes whose content is **not** in this session.
 *
 * `DOM.getDocument({pierce: true})` inlines same-process frames as `contentDocument`. An iframe that
 * carries a `frameId` but no `contentDocument` is therefore out-of-process and needs its own session
 * — and its `backendNodeId`s live in that session's numbering, which is why the merge must never
 * treat them as interchangeable.
 */
export function findOopifFrameIds(root: CapturedDomNode): string[] {
	const out: string[] = [];
	const visit = (node: CapturedDomNode): void => {
		if (node.frameId !== undefined && node.contentDocument === undefined && isFrameElement(node.nodeName)) {
			out.push(node.frameId);
		}
		for (const child of node.children ?? []) visit(child);
		for (const shadow of node.shadowRoots ?? []) visit(shadow);
		if (node.contentDocument !== undefined) visit(node.contentDocument);
	};
	visit(root);
	return out;
}

/**
 * Frame ids of the **same-origin** frames pierced into this session's document.
 *
 * The complement of {@linkcode findOopifFrameIds}: these frames have an inline `contentDocument`, so
 * `DOM.getDocument(pierce: true)` already returned their elements — but `Accessibility.getFullAXTree`
 * did not, and each needs its own call keyed by `frameId`.
 */
export function findSameOriginFrameIds(root: CapturedDomNode): string[] {
	const out: string[] = [];
	const visit = (node: CapturedDomNode): void => {
		if (node.frameId !== undefined && node.contentDocument !== undefined && isFrameElement(node.nodeName)) {
			out.push(node.frameId);
		}
		for (const child of node.children ?? []) visit(child);
		for (const shadow of node.shadowRoots ?? []) visit(shadow);
		if (node.contentDocument !== undefined) visit(node.contentDocument);
	};
	visit(root);
	return out;
}

/** `IFRAME` / `FRAME`, as CDP spells them (uppercase). */
export function isFrameElement(nodeName: string): boolean {
	return nodeName === 'IFRAME' || nodeName === 'FRAME';
}

// ---------------------------------------------------------------------------
// event-listener census
// ---------------------------------------------------------------------------

/**
 * The census expression.
 *
 * ERRATUM(M1-dom-extract-10): DATA-MODEL §6.1 calls this a "Runtime `getEventListeners` census", but
 * no such CDP command exists. `getEventListeners` is the DevTools **command-line API**, reachable only
 * under `includeCommandLineAPI: true` (CDP's real command is `DOMDebugger.getEventListeners`, and
 * `DOMDebugger` is not one of the 14 domains D-CDP2 admits). It reports listeners registered on the
 * node itself, so delegated handlers on an ancestor are — correctly — not attributed to the child, and
 * inline `onclick` is probed separately because the helper does not report it either.
 *
 * Both caps of DATA-MODEL §6.1 are enforced inside the page: the element budget is shared across
 * frames, and at most {@linkcode LISTENER_CENSUS_MAX_LISTENERS} listener records are examined per
 * element. Returning indices rather than object handles keeps the whole census to one round trip.
 */
export function listenerCensusExpression(
	maxElements: number = LISTENER_CENSUS_MAX_ELEMENTS,
	maxListeners: number = LISTENER_CENSUS_MAX_LISTENERS,
	types: readonly string[] = CLICK_LISTENER_TYPES,
): string {
	return `(() => {
	const TYPES = ${JSON.stringify(types)};
	const MAX_ELEMENTS = ${maxElements};
	const MAX_LISTENERS = ${maxListeners};
	let budget = MAX_ELEMENTS;
	let truncated = false;
	const frames = [];
	const visit = (doc, path) => {
		let els;
		try { els = doc.querySelectorAll('*'); } catch (_) { return; }
		const limit = Math.min(els.length, budget);
		if (limit < els.length) truncated = true;
		const hits = [];
		for (let i = 0; i < limit; i++) {
			const el = els[i];
			let hit = false;
			try {
				const map = typeof getEventListeners === 'function' ? (getEventListeners(el) || {}) : {};
				let examined = 0;
				for (const type of TYPES) {
					const list = map[type];
					if (!list || list.length === 0) continue;
					examined += list.length;
					hit = true;
					if (examined >= MAX_LISTENERS) break;
				}
			} catch (_) { /* a node the command-line API refuses is simply not a hit */ }
			if (!hit) {
				try { hit = typeof el.onclick === 'function'; } catch (_) { hit = false; }
			}
			if (hit) hits.push(i);
		}
		budget -= limit;
		frames.push({ frame: path, total: els.length, scanned: limit, hits: hits });
		let inner;
		try { inner = doc.querySelectorAll('iframe,frame'); } catch (_) { return; }
		for (let k = 0; k < inner.length; k++) {
			let childDoc = null;
			try { childDoc = inner[k].contentDocument; } catch (_) { childDoc = null; }
			if (childDoc) visit(childDoc, path === '' ? String(k) : path + '.' + k);
		}
	};
	visit(document, '');
	return JSON.stringify({ frames: frames, truncated: truncated });
})()`;
}

async function runListenerCensus(
	client: CdpClient,
	sessionId: SessionId,
	opts: { signal: AbortSignal } | undefined,
	warnings: string[],
): Promise<ListenerCensus | null> {
	try {
		const result = await client.send.Runtime.evaluate(
			{
				expression: listenerCensusExpression(),
				includeCommandLineAPI: true,
				returnByValue: true,
				silent: true,
			},
			sessionId,
			opts,
		);
		if (result.exceptionDetails !== undefined) {
			warnings.push(`listener census threw in session ${sessionId}`);
			return null;
		}
		const raw = result.result.value;
		if (typeof raw !== 'string') return null;
		return parseListenerCensus(raw);
	} catch (error) {
		warnings.push(`listener census failed in session ${sessionId}: ${describeError(error)}`);
		return null;
	}
}

/** Parse and shape-check the census payload. Malformed input yields `null`, never a throw. */
export function parseListenerCensus(json: string): ListenerCensus | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const record = parsed as { frames?: unknown; truncated?: unknown };
	if (!Array.isArray(record.frames)) return null;
	const frames: ListenerCensusFrame[] = [];
	for (const entry of record.frames) {
		if (typeof entry !== 'object' || entry === null) continue;
		const frame = entry as { frame?: unknown; total?: unknown; scanned?: unknown; hits?: unknown };
		if (typeof frame.frame !== 'string' || typeof frame.total !== 'number') continue;
		if (!Array.isArray(frame.hits)) continue;
		frames.push({
			frame: frame.frame,
			total: frame.total,
			scanned: typeof frame.scanned === 'number' ? frame.scanned : frame.total,
			hits: frame.hits.filter((h): h is number => typeof h === 'number'),
		});
	}
	return { frames, truncated: record.truncated === true };
}

// ---------------------------------------------------------------------------
// pending-network probe (ARCHITECTURE §6.7)
// ---------------------------------------------------------------------------

/** Outcome of {@linkcode waitForNetworkStability}. */
export interface NetworkStabilityResult {
	/** True when a full {@linkcode NETWORK_STABILITY_MS} quiet window elapsed inside the cap. */
	readonly stable: boolean;
	readonly waitedMs: number;
	/** Requests still in flight when the probe gave up. */
	readonly pending: number;
}

/** Options for {@linkcode waitForNetworkStability}. */
export interface NetworkStabilityOptions {
	readonly client: CdpClient;
	/** Restrict to one session; omit to count every session's traffic. */
	readonly sessionId?: string;
	readonly maxMs?: number;
	readonly stableMs?: number;
	readonly signal?: AbortSignal;
	/** Injected for tests; defaults to `performance.now`. */
	readonly now?: () => number;
}

/**
 * Wait for the page to stop fetching, capped at {@linkcode NETWORK_PROBE_MAX_MS}.
 *
 * The quiet window restarts on every new request, so "stable" means
 * {@linkcode NETWORK_STABILITY_MS} with nothing in flight — not merely "nothing in flight right now",
 * which a page that fires a request every 200 ms would satisfy constantly. The probe is advisory: it
 * never fails the build, it just stops waiting.
 */
export function waitForNetworkStability(options: NetworkStabilityOptions): Promise<NetworkStabilityResult> {
	const maxMs = options.maxMs ?? NETWORK_PROBE_MAX_MS;
	const stableMs = options.stableMs ?? NETWORK_STABILITY_MS;
	const now = options.now ?? (() => performance.now());
	const startedAt = now();
	const inFlight = new Set<string>();

	return new Promise<NetworkStabilityResult>((resolve) => {
		let settled = false;
		let quietTimer: ReturnType<typeof setTimeout> | undefined;

		const matches = (sessionId?: string): boolean => options.sessionId === undefined || sessionId === options.sessionId;

		const finish = (stable: boolean): void => {
			if (settled) return;
			settled = true;
			if (quietTimer !== undefined) clearTimeout(quietTimer);
			clearTimeout(capTimer);
			options.signal?.removeEventListener('abort', onAbort);
			for (const off of unsubscribes) off();
			resolve({ stable, waitedMs: Math.max(0, now() - startedAt), pending: inFlight.size });
		};

		const armQuietTimer = (): void => {
			if (quietTimer !== undefined) clearTimeout(quietTimer);
			quietTimer = setTimeout(() => finish(true), stableMs);
		};
		const disarmQuietTimer = (): void => {
			if (quietTimer === undefined) return;
			clearTimeout(quietTimer);
			quietTimer = undefined;
		};

		const onStart = (params: { requestId: string }, sessionId?: string): void => {
			if (!matches(sessionId)) return;
			inFlight.add(params.requestId);
			disarmQuietTimer();
		};
		const onEnd = (params: { requestId: string }, sessionId?: string): void => {
			if (!matches(sessionId)) return;
			inFlight.delete(params.requestId);
			if (inFlight.size === 0) armQuietTimer();
		};

		const unsubscribes = [
			options.client.on('Network.requestWillBeSent', onStart),
			options.client.on('Network.loadingFinished', onEnd),
			options.client.on('Network.loadingFailed', onEnd),
		];

		const capTimer = setTimeout(() => finish(false), maxMs);
		const onAbort = (): void => finish(false);
		options.signal?.addEventListener('abort', onAbort, { once: true });
		if (options.signal?.aborted === true) {
			onAbort();
			return;
		}
		armQuietTimer();
	});
}

// ---------------------------------------------------------------------------
// child-session fallback (integration tier / fixture recorder)
// ---------------------------------------------------------------------------

/** A resolver that attaches OOPIF targets itself, plus the teardown that detaches them again. */
export interface AttachingChildSessionResolver {
	readonly resolve: ChildSessionResolver;
	/** Detaches every session this resolver attached. Safe to call twice. */
	detachAll(): Promise<void>;
}

/**
 * Attach OOPIF targets directly, for callers with no SessionManager.
 *
 * Production code MUST pass SessionManager's resolver instead (ARCHITECTURE §7.3: `getOrCreateCdpSession`
 * is the only sanctioned accessor). This exists so the integration tier and the fixture recorder can
 * drive a bare `CdpClient` without reimplementing session pooling.
 */
export function createAttachingChildSessionResolver(client: CdpClient): AttachingChildSessionResolver {
	const attached = new Map<string, string>();
	return {
		resolve: async (frameId: string) => {
			const existing = attached.get(frameId);
			if (existing !== undefined) return { targetId: frameId, sessionId: existing, frameId };
			try {
				// For an out-of-process iframe Chrome uses the frame's id as the target's id.
				const { sessionId } = await client.send.Target.attachToTarget({ targetId: frameId, flatten: true });
				attached.set(frameId, sessionId);
				return { targetId: frameId, sessionId, frameId };
			} catch {
				return null;
			}
		},
		detachAll: async () => {
			const entries = [...attached.values()];
			attached.clear();
			for (const sessionId of entries) {
				try {
					await client.send.Target.detachFromTarget({ sessionId });
				} catch {
					// The target may already be gone; detaching a dead session is not an error worth raising.
				}
			}
		},
	};
}

/** Message of an unknown thrown value, without ever assuming it is an `Error`. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}
