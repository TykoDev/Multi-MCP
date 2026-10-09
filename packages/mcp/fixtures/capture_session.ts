/**
 * A `SessionRecord` whose browser state comes from a recorded capture (D-TEST1).
 *
 * The unit tier proves the element record over the 36 captures under `packages/browser/fixtures/dom/`
 * with no browser in sight: the capture is merged and serialized by the same code the browser path
 * runs, and the resulting `BrowserStateSummary` is what a fake session answers every state request
 * with. Nothing about the record is mocked — only the CDP transport is absent.
 */
import type { BrowserSession, BrowserStateSummary, DomCapture, PageInfo } from '@tykotech/browser';
import { extractFromCapture, serializeDomState } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { fromFileUrl } from '@std/path';
import { type SessionRecord, SessionRegistry } from '../src/registry.ts';
import { HTML_LIMIT } from '../src/tools/perception.ts';
import type { ToolContext } from '../src/types.ts';

const FIXTURE_DIR = fromFileUrl(new URL('../../browser/fixtures/dom', import.meta.url));

/** Reads one recorded capture by page name. */
export async function loadCapture(name: string): Promise<DomCapture> {
	return JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/${name}.capture.json`)) as DomCapture;
}

/** `PageInfo` from the root session's recorded layout metrics, exactly as `toPageInfo` derives it. */
export function pageInfoOf(capture: DomCapture): PageInfo {
	const metrics = capture.sessions[0]?.layoutMetrics;
	if (metrics === undefined) throw new Error('capture carried no sessions');
	const pageWidth = Math.max(metrics.contentWidth, metrics.viewportWidth);
	const pageHeight = Math.max(metrics.contentHeight, metrics.viewportHeight);
	return {
		viewportWidth: metrics.viewportWidth,
		viewportHeight: metrics.viewportHeight,
		pageWidth,
		pageHeight,
		scrollX: metrics.scrollX,
		scrollY: metrics.scrollY,
		pixelsAbove: Math.max(0, Math.round(metrics.scrollY)),
		pixelsBelow: Math.max(0, Math.round(pageHeight - metrics.scrollY - metrics.viewportHeight)),
		pixelsLeft: Math.max(0, Math.round(metrics.scrollX)),
		pixelsRight: Math.max(0, Math.round(pageWidth - metrics.scrollX - metrics.viewportWidth)),
	};
}

/** Merges and serializes a capture into the summary the DOM watchdog would have assembled. */
export function summaryOf(capture: DomCapture, options: { includeOffscreen?: boolean } = {}): BrowserStateSummary {
	const extraction = extractFromCapture(capture);
	const url = capture.sessions[0]?.url ?? '';
	const serialized = serializeDomState(extraction.root, {
		topUrl: url,
		frames: extraction.frames,
		includeOffscreen: options.includeOffscreen === true,
	});
	return {
		url,
		title: '',
		tabs: [],
		screenshot: null,
		domState: serialized.state,
		pageInfo: pageInfoOf(capture),
		isPdfViewer: false,
		pendingNetworkRequests: [],
		browserErrors: [],
		recentEvents: null,
		closedPopupMessages: [],
		paginationButtonsDetected: false,
		stateError: serialized.stateError,
		stateToken: serialized.stateToken,
		frames: [...extraction.frameTree],
		captureTruncated: extraction.captureTruncated,
	};
}

/** A session answering every state request from the capture; `includeOffscreen` is honoured. */
export function captureSession(capture: DomCapture): BrowserSession {
	const session = {
		tabs: [],
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		cachedBrowserState: summaryOf(capture),
		getBrowserStateSummary(options: { includeDom?: boolean; includeOffscreen?: boolean } = {}) {
			const summary = summaryOf(capture, { includeOffscreen: options.includeOffscreen === true });
			if (options.includeDom !== false) session.cachedBrowserState = summary;
			return Promise.resolve(summary);
		},
		eventBus: new EventBus({ name: 'capture-session' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	};
	return session as unknown as BrowserSession;
}

/** A registry holding one capture-backed session, plus the tool context that reaches it. */
export async function captureHarness(name: string): Promise<{
	capture: DomCapture;
	registry: SessionRegistry;
	record: SessionRecord;
	ctx: ToolContext;
}> {
	const capture = await loadCapture(name);
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(captureSession(capture)) });
	const record = await registry.resolve(undefined);
	return { capture, registry, record, ctx: { registry, allowedDomains: [], principal: 'test' } };
}

// --- the frame-scoped CDP wire (D-054): shared by the handler and the refusal tables ------------

/**
 * A unique string in the TOP document and nowhere else.
 *
 * Every refusal row on the `frame_id` path asserts its absence, which is how I-FH-1 is *asserted*
 * rather than asserted about: the handler's shape is `resolve -> authorize -> extract`, and if a
 * later edit moved the extraction above a gate this sentinel is the thing that would come back.
 */
export const TOP_DOC_SENTINEL = 'TOP-DOCUMENT-SENTINEL-4KQ7';
export const TOP_DOCUMENT = `<html><body><p>${TOP_DOC_SENTINEL}</p></body></html>`;
export const CHILD_DOCUMENT = '<html><body><table><caption>BIL51</caption></table></body></html>';

/** The CDP session id the fake hands back for the focused tab, and for a frame's own target. */
export const PAGE_SESSION = 'S-page';
export const OOPIF_SESSION = 'S-oopif';

/**
 * What `documentElement.outerHTML` hands the in-page extraction — **not necessarily a string**.
 *
 * `outerHTML` is an ordinary configurable accessor on `Element.prototype`, so a page's getter may
 * return any object at all, and the in-page code D-057 ships touches exactly two of its members:
 * `.length` and `.slice(0, limit)`. A `string` satisfies that shape, which is why the honest case
 * needs no second spelling; an object carrying its own `length` and `slice` satisfies it too, and
 * that object is SEC-FH-24's whole exploit. A test that could only hand this fake a `string` could
 * only ever describe a cooperative renderer.
 */
export type PageOuterHtml = string | { readonly length: number; slice(start: number, end: number): string };

export interface FrameCdpScript {
	/** The page session's `Page.getFrameTree` answer, built from the capture's own frame ids. */
	readonly tree?: (topFrameId: string, childFrameId: string) => unknown;
	/** What the session-default-document read answers with. */
	readonly topHtml?: PageOuterHtml;
	/** What a receiver-addressed read answers with. */
	readonly childHtml?: PageOuterHtml;
	/** Gate C's verdict for a frame the capture called same-process, or a failure to reach it. */
	readonly owner?: 'same-process' | 'out-of-process' | 'throw';
	/** Makes the extraction answer with something that is not a `{length, html}` pair (T-5). */
	readonly noDocument?: boolean;
	/** Makes `Page.getFrameTree` fail, which is how a renderer that went away arrives. */
	readonly treeThrows?: boolean;
}

/** One node of a scripted `Page.FrameTree`, as the fake browser holds it. */
interface FrameNode {
	readonly frame: { readonly id: string; readonly url: string };
	readonly childFrames?: readonly FrameNode[];
}

export interface FrameCdpHarness {
	readonly capture: DomCapture;
	readonly registry: SessionRegistry;
	readonly record: SessionRecord;
	readonly ctx: ToolContext;
	/** Every CDP round trip, in order, with the session it was sent to and its parameters. */
	readonly calls: Array<{ method: string; sessionId: string; params: Record<string, unknown> }>;
	readonly topFrameId: string;
	readonly childFrameId: string;
	methods(): string[];
	/** How many times the element table was rebuilt — `observe()`'s one entry point (I-FH-6). */
	observations(): number;
	/**
	 * **Commits a new document in a frame of the fake browser — a navigation, not a flag.**
	 *
	 * The frame tree, the bytes an extraction answers with and the origin that extraction reports all
	 * read from this one map, so they cannot be made to disagree: after this call `Page.getFrameTree`
	 * reports the new URL *and* the read returns the new document *and* it reports the new origin,
	 * which is what a renderer that committed a navigation does. A test that could set the origin
	 * without moving the document would be describing the fix rather than exercising it (SEC-FH-17).
	 */
	navigate(frameId: string, url: string, html: string): void;
	/**
	 * Runs `run` the instant after the wire has answered `method`, before the handler's next round
	 * trip is sent.
	 *
	 * The only way a test can open a window *between* two CDP calls of a single handler invocation,
	 * which is the whole subject of a time-of-check/time-of-use finding: the check reads one state
	 * and the use reads another because the world moved in between. `nth` counts that method's
	 * answers, so a path that reads the frame tree twice can be disturbed after the second read
	 * rather than the first.
	 */
	afterCall(method: string, run: (nth: number) => void): void;
}

/**
 * A capture-backed session wired to a scripted frame tree and a scripted extraction.
 *
 * The frame vocabulary is the capture's own, so Gate A's membership answer and the same-process /
 * OOPIF routing are what Chromium produced; only the CDP round trips are faked, and each one records
 * its method, its session and its parameters, because the content of these tests is *what was sent
 * where*. A refusal that never sent an extraction cannot have returned a document byte, and that is
 * a stronger statement than searching the result for one.
 */
export async function frameCdpHarness(name: string, script: FrameCdpScript = {}): Promise<FrameCdpHarness> {
	const h = await captureHarness(name);
	const calls: Array<{ method: string; sessionId: string; params: Record<string, unknown> }> = [];
	let observations = 0;
	const session = h.record.session as unknown as Record<string, unknown>;
	const frames = (session.cachedBrowserState as { frames: Array<{ frameId: string }> }).frames;
	const topFrameId = frames[0]?.frameId ?? 'F-NO-TOP';
	const childFrameId = frames[1]?.frameId ?? 'F-NO-CHILD';
	// The fake browser's live state: every document a test committed with `navigate`, by frame id.
	// The tree, the bytes and the reported origin are all derived from it, so the three cannot be
	// made to disagree — which is what makes a navigation in this wire a navigation rather than a
	// flag.
	const committed = new Map<string, { url: string; html: string }>();
	const hooks: Array<{ method: string; run: (nth: number) => void }> = [];
	/** Records one round trip, then runs whatever the test scheduled for the moment after it. */
	const trip = (method: string, sessionId: string, params: Record<string, unknown>): void => {
		calls.push({ method, sessionId, params });
		const nth = calls.filter((call) => call.method === method).length;
		for (const hook of hooks) if (hook.method === method) hook.run(nth);
	};
	const build = script.tree ??
		((top: string, child: string) => ({
			frame: { id: top, url: 'https://example.com/page' },
			childFrames: [{ frame: { id: child, url: 'https://example.com/page/child' } }],
		}));
	/** The tree as the browser holds it **now**: the script's shape with every navigation applied. */
	const liveTree = (): FrameNode => {
		const apply = (node: FrameNode): FrameNode => ({
			frame: { id: node.frame.id, url: committed.get(node.frame.id)?.url ?? node.frame.url },
			...(node.childFrames === undefined ? {} : { childFrames: node.childFrames.map(apply) }),
		});
		return apply(build(topFrameId, childFrameId) as FrameNode);
	};
	/** A frame's URL right now, or `''` for one the live tree does not hold. */
	const urlNow = (frameId: string): string => {
		const find = (node: FrameNode): string | null => {
			if (node.frame.id === frameId) return node.frame.url;
			for (const child of node.childFrames ?? []) {
				const found = find(child);
				if (found !== null) return found;
			}
			return null;
		};
		return find(liveTree()) ?? '';
	};
	// What the page-side extraction returns: the document's TRUE length beside an at-most-`HTML_LIMIT`
	// slice of it (D-057), and the origin `location.origin` would report for it. The cap is reproduced
	// here because it really is applied in the renderer — a fake that returned the whole string would
	// be describing the behaviour this change replaced. The origin is derived from the frame's URL at
	// the moment the read is answered, never from the URL the tree reported earlier: a renderer has
	// only one document to answer from, and that coupling is the point (SEC-FH-17).
	//
	// **The arithmetic below is the page's, verbatim, and it is deliberately not defended** (SEC-FH-24):
	// `document` is whatever `outerHTML` handed the extraction — a `string` for an honest renderer, or
	// a {@linkcode PageOuterHtml} object whose own `length` and `slice` choose both numbers. The fake
	// runs the same two member reads the shipped `HTML_EXPRESSION` / `HTML_FUNCTION` run, so the triple
	// a hostile page puts on the wire is *derived here* rather than hand-written by a test.
	const pair = (document: PageOuterHtml, origin: string) => ({
		result: {
			type: 'object',
			value: {
				length: document.length,
				html: document.length > HTML_LIMIT ? document.slice(0, HTML_LIMIT) : document,
				origin,
			},
		},
	});
	/** The extraction's answer for one frame, from the document that frame holds right now. */
	const answer = (frameId: string, scripted: PageOuterHtml) => {
		if (script.noDocument === true) return Promise.resolve({ result: { type: 'undefined' } });
		const url = urlNow(frameId);
		return Promise.resolve(pair(committed.get(frameId)?.html ?? scripted, URL.parse(url)?.origin ?? ''));
	};
	session.cdpClient = {
		send: {
			Runtime: {
				evaluate: (params: Record<string, unknown>, sessionId: string) => {
					// A receiver-less evaluate lands in the session's DEFAULT context: the top document on
					// the page session, and an out-of-process frame's own document on its own target's.
					const answered = sessionId === OOPIF_SESSION
						? answer(childFrameId, script.childHtml ?? CHILD_DOCUMENT)
						: answer(topFrameId, script.topHtml ?? TOP_DOCUMENT);
					trip('Runtime.evaluate', sessionId, params);
					return answered;
				},
				callFunctionOn: (params: Record<string, unknown>, sessionId: string) => {
					// The receiver's own document -> window hop, answered here because it is production
					// code's step rather than a behaviour a case is describing.
					if (String(params.functionDeclaration).includes('defaultView')) {
						trip('Runtime.callFunctionOn', sessionId, params);
						return Promise.resolve({ result: { type: 'object', objectId: 'OBJ-window' } });
					}
					const answered = answer(childFrameId, script.childHtml ?? CHILD_DOCUMENT);
					trip('Runtime.callFunctionOn', sessionId, params);
					return answered;
				},
				releaseObjectGroup: (params: Record<string, unknown>, sessionId: string) => {
					trip('Runtime.releaseObjectGroup', sessionId, params);
					return Promise.resolve({});
				},
			},
			DOM: {
				enable: (params: Record<string, unknown>, sessionId: string) => {
					trip('DOM.enable', sessionId, params);
					return Promise.resolve({});
				},
				getFrameOwner: (params: Record<string, unknown>, sessionId: string) => {
					trip('DOM.getFrameOwner', sessionId, params);
					if (script.owner === 'throw') return Promise.reject(new Error('no owner element for that frame'));
					return Promise.resolve({ backendNodeId: 41 });
				},
				describeNode: (params: Record<string, unknown>, sessionId: string) => {
					trip('DOM.describeNode', sessionId, params);
					const node: Record<string, unknown> = { backendNodeId: 41, nodeName: 'IFRAME', nodeType: 1 };
					// "No inline document means out-of-process" — the discriminator `extract_merge.ts` uses.
					if (script.owner !== 'out-of-process') {
						node.contentDocument = { backendNodeId: 77, nodeName: '#document', nodeType: 9 };
					}
					return Promise.resolve({ node });
				},
				resolveNode: (params: Record<string, unknown>, sessionId: string) => {
					trip('DOM.resolveNode', sessionId, params);
					return Promise.resolve({ object: { type: 'object', objectId: 'OBJ-document' } });
				},
			},
			Page: {
				getFrameTree: (_params: Record<string, unknown>, sessionId: string) => {
					if (script.treeThrows === true) {
						trip('Page.getFrameTree', sessionId, {});
						return Promise.reject(new Error('the target is gone'));
					}
					// Built BEFORE the hook runs, so a navigation scheduled for "just after the tree read"
					// lands on the world and not on the answer already in flight.
					const answered = { frameTree: liveTree() };
					trip('Page.getFrameTree', sessionId, {});
					return Promise.resolve(answered);
				},
			},
		},
	};
	session.sessionManager = {
		getOrCreateCdpSession: (target: string | null, focus: boolean) =>
			Promise.resolve({ sessionId: focus ? PAGE_SESSION : OOPIF_SESSION, targetId: target ?? 'T' }),
	};
	session.agentFocusTargetId = 'T';
	const summary = session.getBrowserStateSummary as (options?: unknown) => unknown;
	session.getBrowserStateSummary = (options?: unknown) => {
		observations++;
		return summary.call(session, options);
	};
	return {
		...h,
		calls,
		topFrameId,
		childFrameId,
		methods: () => calls.map((call) => call.method),
		observations: () => observations,
		navigate: (frameId: string, url: string, html: string) => {
			committed.set(frameId, { url, html });
		},
		afterCall: (method: string, run: (nth: number) => void) => {
			hooks.push({ method, run });
		},
	};
}
