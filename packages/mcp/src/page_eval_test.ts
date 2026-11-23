/**
 * The frame context, the live per-frame URL, the zoom guard and the bounded evaluation, plus which **document** an
 * expression aimed at a frame actually reaches.
 */
import { assert, assertEquals, assertGreater, assertRejects, assertStringIncludes } from '@std/assert';
import { DOM_FIXTURE_PAGES } from '../../browser/fixtures/dom/pages.ts';
import { captureHarness, loadCapture, summaryOf } from '../fixtures/capture_session.ts';
import type { SessionRecord } from './registry.ts';
import { ToolError } from './errors.ts';
import {
	assertUnitViewportScale,
	EVALUATE_ERROR_TEXT_CHARS,
	EVALUATE_RESULT_LIMIT_BYTES,
	EVALUATE_TIMEOUT_MS_MAX,
	evaluateInFrame,
	frameContext,
	frameDocumentHtml,
	liveFrameIdentity,
	liveFrameUrl,
} from './page_eval.ts';

const TOP_SESSION = 'S-top';
const CHILD_SESSION = 'S-child';

/** The scripted same-process child frame, and the handles Gate C hands back for it. */
const LOCAL_FRAME = 'F-CHILD-SAME-PROCESS';
const OWNER_NODE = 41;
const DOCUMENT_NODE = 77;
const DOCUMENT_HANDLE = 'OBJ-child-document';
const WINDOW_HANDLE = 'OBJ-child-window';

/** The object group `page_eval.ts` allocates every frame handle in. */
const FRAME_OBJECT_GROUP = 'ttk-frame';

interface Script {
	/** What `Runtime.evaluate` answers, per CDP session id. A function may throw or delay. */
	readonly evaluate?: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;
	/** What `Runtime.callFunctionOn` answers for the **caller's** function, per CDP session id. */
	readonly callFunctionOn?: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;
	/** What `Page.getFrameTree` answers, per CDP session id. */
	readonly frameTree?: Record<string, unknown>;
	/** The visual viewport scale `Page.getLayoutMetrics` reports, or `'throw'`. */
	readonly scale?: number | 'throw';
	/**
	 * What Gate C finds when it pierces the owner element: an inline `contentDocument` (same process,
	 * the default), none at all (the frame moved into its own renderer), or a failure.
	 */
	readonly owner?: 'same-process' | 'out-of-process' | 'throw';
	/** The handle `DOM.resolveNode` returns for the child document; `null` means it returned none. */
	readonly documentHandle?: string | null;
}

interface Wired {
	readonly calls: Array<{ method: string; sessionId: string; params: Record<string, unknown> }>;
}

function wire(record: { session: unknown }, script: Script): Wired {
	const calls: Array<{ method: string; sessionId: string; params: Record<string, unknown> }> = [];
	const client = {
		send: {
			Runtime: {
				evaluate(params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'Runtime.evaluate', sessionId, params });
					const answer = script.evaluate?.[sessionId];
					if (answer === undefined) return Promise.resolve({ result: { type: 'undefined' } });
					return answer(params);
				},
				callFunctionOn(params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'Runtime.callFunctionOn', sessionId, params });
					if (String(params.functionDeclaration).includes('defaultView')) {
						return Promise.resolve({ result: { type: 'object', objectId: WINDOW_HANDLE } });
					}
					const answer = script.callFunctionOn?.[sessionId];
					if (answer === undefined) return Promise.resolve({ result: { type: 'undefined' } });
					return answer(params);
				},
				releaseObjectGroup(params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'Runtime.releaseObjectGroup', sessionId, params });
					return Promise.resolve({});
				},
			},
			DOM: {
				enable(params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'DOM.enable', sessionId, params });
					return Promise.resolve({});
				},
				getFrameOwner(params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'DOM.getFrameOwner', sessionId, params });
					if (script.owner === 'throw') return Promise.reject(new Error('no owner element for that frame'));
					return Promise.resolve({ backendNodeId: OWNER_NODE });
				},
				describeNode(params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'DOM.describeNode', sessionId, params });
					const node: Record<string, unknown> = { backendNodeId: OWNER_NODE, nodeName: 'IFRAME', nodeType: 1 };
					if (script.owner !== 'out-of-process') {
						node.contentDocument = { backendNodeId: DOCUMENT_NODE, nodeName: '#document', nodeType: 9 };
					}
					return Promise.resolve({ node });
				},
				resolveNode(params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'DOM.resolveNode', sessionId, params });
					const handle = script.documentHandle === undefined ? DOCUMENT_HANDLE : script.documentHandle;
					if (handle === null) return Promise.resolve({ object: { type: 'object' } });
					return Promise.resolve({ object: { type: 'object', objectId: handle } });
				},
			},
			Page: {
				getFrameTree(_params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'Page.getFrameTree', sessionId, params: {} });
					const tree = script.frameTree?.[sessionId];
					if (tree === undefined) return Promise.reject(new Error('no frame tree here'));
					return Promise.resolve({ frameTree: tree });
				},
				getLayoutMetrics(_params: Record<string, unknown>, sessionId: string) {
					calls.push({ method: 'Page.getLayoutMetrics', sessionId, params: {} });
					if (script.scale === 'throw') return Promise.reject(new Error('the target is gone'));
					const scale = script.scale ?? 1;
					return Promise.resolve({
						layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
						visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720, scale },
						contentSize: { x: 0, y: 0, width: 1280, height: 2000 },
						cssVisualViewport: {
							offsetX: 0,
							offsetY: 0,
							pageX: 0,
							pageY: 0,
							clientWidth: 1280,
							clientHeight: 720,
							scale,
						},
					});
				},
			},
		},
	};
	const manager = {
		getOrCreateCdpSession(target: string | null, focus: boolean) {
			return Promise.resolve({ sessionId: focus ? TOP_SESSION : CHILD_SESSION, targetId: target ?? 'T-top' });
		},
	};
	Object.assign(record.session as object, { cdpClient: client, sessionManager: manager, agentFocusTargetId: 'T-top' });
	return { calls };
}

async function fixture(script: Script = {}) {
	const h = await captureHarness('iframe_crossorigin');
	const wired = wire(h.record, script);
	const frames = h.record.session.cachedBrowserState?.frames ?? [];
	const top = frames[0];
	const oopif = frames.find((frame) => frame.isOopif);
	assert(top !== undefined && oopif !== undefined, 'the capture must carry a top frame and an OOPIF');
	return { ...h, wired, top, oopif };
}

/** Puts a same-process child frame into the session's frame vocabulary and returns its id. */
function addSameProcessFrame(record: SessionRecord, parentFrameId: string): string {
	const state = record.session.cachedBrowserState;
	assert(state !== null && state !== undefined, 'the capture harness must hold browser state');
	Object.assign(state, {
		frames: [...state.frames, {
			frameId: LOCAL_FRAME,
			parentFrameId,
			url: 'https://example.com/frames/content',
			name: 'content',
			hostBounds: null,
			isOopif: false,
			captured: true,
			composed: true,
		}],
	});
	return LOCAL_FRAME;
}

/** A `FrameContext` for the cases that do not resolve one through {@linkcode frameContext}. */
function frameRef(
	frameId: string,
	sessionId: string,
	options: { isOopif?: boolean; isTop?: boolean; named?: boolean } = {},
) {
	const isOopif = options.isOopif === true;
	const isTop = options.isTop === true;
	return { frameId, sessionId, isOopif, named: options.named ?? true, isTop, isSessionDocument: isTop || isOopif };
}

/** Every method sent, in order, so a case can assert a sequence rather than a presence. */
function methods(wired: Wired): string[] {
	return wired.calls.map((call) => call.method);
}

// --- frame context ------------------------------------------------------------

Deno.test('page_eval: an omitted frame_id is the focused document, on the page session', async () => {
	const f = await fixture();
	try {
		const frame = await frameContext(f.record, undefined);
		assertEquals(frame.sessionId, TOP_SESSION);
		assertEquals(frame.isOopif, false);
		assertEquals(frame.frameId, f.top.frameId);
		assertEquals(frame.isTop, true);
		assertEquals(frame.named, false);
		assertEquals(frame.isSessionDocument, true);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: an out-of-process frame is addressed through its OWN session', async () => {
	const f = await fixture();
	try {
		const frame = await frameContext(f.record, f.oopif.frameId);
		assertEquals(frame.isOopif, true);
		assertEquals(frame.sessionId, CHILD_SESSION);
		assertEquals(frame.isTop, false);
		assertEquals(frame.isSessionDocument, true);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a same-process frame is on its HOST session but is NOT that session’s document', async () => {
	const f = await fixture();
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		assertEquals(frame.isOopif, false);
		assertEquals(frame.sessionId, TOP_SESSION);
		assertEquals(frame.isTop, false);
		assertEquals(frame.isSessionDocument, false);
		assertEquals(f.wired.calls.length, 0);
	} finally {
		await f.registry.shutdown();
	}
});

/** A caller may name the top frame's id, and it resolves to the top document, at the module boundary. */
Deno.test('page_eval: a NAMED top frame id is the top document, and is named AND top', async () => {
	const f = await fixture();
	try {
		const frame = await frameContext(f.record, f.top.frameId);
		assertEquals(frame.frameId, f.top.frameId);
		assertEquals(frame.sessionId, TOP_SESSION);
		assertEquals(frame.isOopif, false);
		assertEquals(frame.isTop, true, 'a frame_id equal to frames[0] names the top document');
		assertEquals(frame.named, true);
		assertEquals(frame.isSessionDocument, true);
		assertEquals(f.wired.calls.length, 0);
	} finally {
		await f.registry.shutdown();
	}
});

/** **The cached-root invariant, named and asserted over the recorded corpus.** */
Deno.test('page_eval: the cached ROOT is never out-of-process over the corpus', async () => {
	assertGreater(DOM_FIXTURE_PAGES.length, 19);
	const problems: string[] = [];
	for (const page of DOM_FIXTURE_PAGES) {
		const root = summaryOf(await loadCapture(page.name)).frames[0];
		if (root === undefined) problems.push(`${page.name}: the capture produced no frame record at all`);
		else if (root.isOopif) problems.push(`${page.name}: frames[0] is an OOPIF, so both origin gates are suppressed`);
		else if (root.parentFrameId !== null) problems.push(`${page.name}: frames[0] is not the tree root`);
	}
	assertEquals(problems, []);
});

/** **The cached-root invariant, asserted at the boundary that consumes it.** */
Deno.test('page_eval: a cached ROOT marked out-of-process does NOT get the top-document pass', async () => {
	const f = await fixture();
	try {
		const state = f.record.session.cachedBrowserState;
		assert(state !== null && state !== undefined);
		Object.assign(state, {
			frames: state.frames.map((frame, index) => index === 0 ? { ...frame, isOopif: true } : frame),
		});
		const frame = await frameContext(f.record, f.top.frameId);
		assertEquals(frame.isTop, false, 'an out-of-process root must not suppress the origin gates');
		assertEquals(frame.frameId, f.top.frameId);
		assertEquals(frame.isOopif, true);
		assertEquals(frame.named, true);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: an unknown frame_id is REFUSED, never silently the top document', async () => {
	const f = await fixture();
	try {
		const error = await assertRejects(() => frameContext(f.record, 'FRAME-THAT-IS-NOT-HERE'), ToolError);
		assertEquals(error.code, 'invalid-arguments');
		assertEquals(f.wired.calls.length, 0);
	} finally {
		await f.registry.shutdown();
	}
});

// --- the live per-frame URL ----------------------------------------------------

Deno.test('page_eval: the frame URL is read LIVE from the browser, not from the cached capture', async () => {
	const cachedTopUrl = (await captureHarness('iframe_crossorigin')).record.session.cachedBrowserState?.url;
	const f = await fixture({
		frameTree: {
			[TOP_SESSION]: {
				frame: { id: 'F-TOP', url: 'https://moved.example.com/after-navigation' },
				childFrames: [{ frame: { id: 'F-CHILD', url: 'https://inner.example.com/login' } }],
			},
		},
	});
	try {
		const url = await liveFrameUrl(f.record, frameRef('F-TOP', TOP_SESSION));
		assertEquals(url, 'https://moved.example.com/after-navigation');
		assert(url !== cachedTopUrl, 'the live read must not be able to answer with the cached URL');
		assert(f.wired.calls.some((call) => call.method === 'Page.getFrameTree'));
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a nested frame answers with ITS OWN url, not the top document’s', async () => {
	const f = await fixture({
		frameTree: {
			[TOP_SESSION]: {
				frame: { id: 'F-TOP', url: 'https://bank.example.com/account' },
				childFrames: [{
					frame: { id: 'F-CHILD', url: 'https://not-the-bank.example/collect' },
					childFrames: [{ frame: { id: 'F-DEEP', url: 'https://deeper.example/x' } }],
				}],
			},
		},
	});
	try {
		assertEquals(
			await liveFrameUrl(f.record, frameRef('F-CHILD', TOP_SESSION)),
			'https://not-the-bank.example/collect',
		);
		assertEquals(
			await liveFrameUrl(f.record, frameRef('F-DEEP', TOP_SESSION)),
			'https://deeper.example/x',
		);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a frame that detached between resolution and the read is REFUSED', async () => {
	const f = await fixture({
		frameTree: { [TOP_SESSION]: { frame: { id: 'F-TOP', url: 'https://example.com/' } } },
	});
	try {
		const error = await assertRejects(
			() => liveFrameUrl(f.record, frameRef('F-GONE', TOP_SESSION)),
			ToolError,
		);
		assertEquals(error.code, 'invalid-arguments');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the focused document is named from the LIVE tree root, not from the capture', async () => {
	const f = await fixture({
		frameTree: {
			[TOP_SESSION]: { frame: { id: 'F-TOP-AFTER-NAVIGATION', url: 'https://moved.example.com/after' } },
		},
	});
	try {
		const frame = await frameContext(f.record, undefined);
		assert(frame.frameId !== 'F-TOP-AFTER-NAVIGATION', 'the cached id must differ, or this proves nothing');
		const identity = await liveFrameIdentity(f.record, frame);
		assertEquals(identity.frameId, 'F-TOP-AFTER-NAVIGATION');
		assertEquals(identity.frameUrl, 'https://moved.example.com/after');
		assertEquals(identity.topUrl, 'https://moved.example.com/after');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a named frame keeps its own id through liveFrameIdentity', async () => {
	const f = await fixture({
		frameTree: {
			[TOP_SESSION]: {
				frame: { id: 'F-TOP', url: 'https://example.com/' },
				childFrames: [{ frame: { id: LOCAL_FRAME, url: 'https://example.com/frames/content' } }],
			},
		},
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const identity = await liveFrameIdentity(f.record, await frameContext(f.record, local));
		assertEquals(identity.frameId, LOCAL_FRAME);
		assertEquals(identity.frameUrl, 'https://example.com/frames/content');
		assertEquals(identity.topUrl, 'https://example.com/');
	} finally {
		await f.registry.shutdown();
	}
});

/**
 * A named root is searched for in the live tree like any other named id, and finding it at the root is what makes it
 * same-origin.
 */
Deno.test('page_eval: a NAMED root is verified against the live tree and answers with the top document', async () => {
	const frameTree: Record<string, unknown> = {};
	const f = await fixture({ frameTree });
	frameTree[TOP_SESSION] = {
		frame: { id: f.top.frameId, url: 'https://example.com/' },
		childFrames: [{ frame: { id: LOCAL_FRAME, url: 'https://example.com/frames/content' } }],
	};
	try {
		const frame = await frameContext(f.record, f.top.frameId);
		const identity = await liveFrameIdentity(f.record, frame);
		assertEquals(identity.frameId, f.top.frameId);
		assertEquals(identity.frameUrl, 'https://example.com/');
		assertEquals(identity.topUrl, 'https://example.com/');
		assertEquals(identity.frameUrl, identity.topUrl);
		assertEquals(methods(f.wired), ['Page.getFrameTree']);
	} finally {
		await f.registry.shutdown();
	}
});

/** A named root the live tree no longer holds is a refusal, not an answer about whichever document is focused now. */
Deno.test('page_eval: a NAMED root the live tree no longer holds is REFUSED', async () => {
	const f = await fixture({
		frameTree: {
			[TOP_SESSION]: { frame: { id: 'F-TOP-AFTER-A-MAIN-FRAME-SWAP', url: 'https://somewhere-else.example/' } },
		},
	});
	try {
		const frame = await frameContext(f.record, f.top.frameId);
		assertEquals(frame.isTop, true, 'the id names the session’s own top frame, or this proves nothing');
		const error = await assertRejects(() => liveFrameIdentity(f.record, frame), ToolError);
		assertEquals(error.code, 'invalid-arguments');
		assertStringIncludes(error.message, 'no longer attached');
		assertStringIncludes(error.message, f.top.frameId);
	} finally {
		await f.registry.shutdown();
	}
});

/**
 * **The confinement itself.** The short-circuit is keyed on `named`, never on `isTop`, and this case is the
 * difference between the two.
 */
Deno.test('page_eval: the liveFrameIdentity short-circuit is keyed on `named`, NOT on `isTop`', async () => {
	const script = {
		frameTree: {
			[TOP_SESSION]: { frame: { id: 'F-TOP-LIVE', url: 'https://live.example/now' } },
		},
	};

	const unnamed = await fixture(script);
	try {
		const identity = await liveFrameIdentity(
			unnamed.record,
			frameRef('F-STALE-TOP', TOP_SESSION, {
				isTop: true,
				named: false,
			}),
		);
		assertEquals(identity.frameId, 'F-TOP-LIVE');
		assertEquals(identity.frameUrl, 'https://live.example/now');
	} finally {
		await unnamed.registry.shutdown();
	}

	const named = await fixture(script);
	try {
		const error = await assertRejects(
			() => liveFrameIdentity(named.record, frameRef('F-STALE-TOP', TOP_SESSION, { isTop: true, named: true })),
			ToolError,
		);
		assertEquals(error.code, 'invalid-arguments');
		assertStringIncludes(error.message, 'no longer attached');
	} finally {
		await named.registry.shutdown();
	}
});

// --- the zoom guard ------------------------------------------------------------

Deno.test('page_eval: scale 1 passes the guard', async () => {
	const f = await fixture({ scale: 1 });
	try {
		assertEquals(await assertUnitViewportScale(f.record), 1);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a scaled visual viewport REFUSES a secret-bearing action', async () => {
	for (const scale of [1.5, 2, 0.5]) {
		const f = await fixture({ scale });
		try {
			const error = await assertRejects(() => assertUnitViewportScale(f.record), ToolError);
			assertEquals(error.code, 'browser-unavailable');
			assertEquals(error.extras.reason, 'viewport-scaled');
		} finally {
			await f.registry.shutdown();
		}
	}
});

Deno.test('page_eval: a scale that cannot be READ is a refusal, not an assumption of 1', async () => {
	const f = await fixture({ scale: 'throw' });
	try {
		const error = await assertRejects(() => assertUnitViewportScale(f.record), ToolError);
		assertEquals(error.code, 'browser-unavailable');
		assertEquals(error.extras.reason, 'viewport-scaled');
	} finally {
		await f.registry.shutdown();
	}
});

// --- the bounded evaluation ----------------------------------------------------

const FRAME = frameRef('F-TOP', TOP_SESSION, { isTop: true });

Deno.test('page_eval: a value comes back with its type, uncapped and untruncated', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'hello' } }) },
	});
	try {
		const outcome = await evaluateInFrame(f.record, { expression: '"hello"', frame: FRAME, timeoutMs: 1000 });
		assertEquals(outcome.ok, true);
		assertEquals(outcome.type, 'string');
		assertEquals(outcome.value, 'hello');
		assertEquals(outcome.truncated, false);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the call is silent, awaits promises, and carries the renderer’s own deadline', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.resolve({ result: { type: 'undefined' } }) },
	});
	try {
		await evaluateInFrame(f.record, { expression: 'void 0', frame: FRAME, timeoutMs: 400 });
		const call = f.wired.calls.find((entry) => entry.method === 'Runtime.evaluate');
		assert(call !== undefined);
		assertEquals(call.params.silent, true);
		assertEquals(call.params.awaitPromise, true);
		assertEquals(call.params.returnByValue, true);
		assertEquals(call.params.timeout, 400);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a caller cannot ask for more than the 1 s ceiling', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.resolve({ result: { type: 'undefined' } }) },
	});
	try {
		await evaluateInFrame(f.record, { expression: 'void 0', frame: FRAME, timeoutMs: 60_000 });
		const call = f.wired.calls.find((entry) => entry.method === 'Runtime.evaluate');
		assertEquals(call?.params.timeout, EVALUATE_TIMEOUT_MS_MAX);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: an over-cap result is truncated and SAYS SO', async () => {
	const big = 'x'.repeat(EVALUATE_RESULT_LIMIT_BYTES * 2);
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.resolve({ result: { type: 'string', value: big } }) },
	});
	try {
		const outcome = await evaluateInFrame(f.record, { expression: 'big', frame: FRAME, timeoutMs: 1000 });
		assertEquals(outcome.truncated, true);
		assert(typeof outcome.value === 'string');
		assert((outcome.value as string).length <= EVALUATE_RESULT_LIMIT_BYTES);
		assert(outcome.resultBytes <= EVALUATE_RESULT_LIMIT_BYTES);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a page exception is ok:false with a truncated message, not a tool error', async () => {
	const long = 'E'.repeat(EVALUATE_ERROR_TEXT_CHARS * 3);
	const f = await fixture({
		evaluate: {
			[TOP_SESSION]: () =>
				Promise.resolve({
					result: { type: 'object' },
					exceptionDetails: { text: 'Uncaught', exception: { description: long } },
				}),
		},
	});
	try {
		const outcome = await evaluateInFrame(f.record, { expression: 'boom()', frame: FRAME, timeoutMs: 1000 });
		assertEquals(outcome.ok, false);
		assertEquals(outcome.value, undefined);
		assertEquals(outcome.errorText?.length, EVALUATE_ERROR_TEXT_CHARS);
		assertEquals(outcome.resultBytes, 0);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a renderer that never answers is a `timeout`, not a hang', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => new Promise(() => {}) },
	});
	try {
		const error = await assertRejects(
			() => evaluateInFrame(f.record, { expression: 'while(true){}', frame: FRAME, timeoutMs: 1 }),
			ToolError,
		);
		assertEquals(error.code, 'timeout');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the renderer’s own termination is reported as `timeout` too', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.reject(new Error('Execution was terminated')) },
	});
	try {
		const error = await assertRejects(
			() => evaluateInFrame(f.record, { expression: 'while(true){}', frame: FRAME, timeoutMs: 50 }),
			ToolError,
		);
		assertEquals(error.code, 'timeout');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a disconnected session refuses every entry point', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		for (
			const call of [
				() => frameContext(h.record, undefined),
				() => assertUnitViewportScale(h.record),
				() => evaluateInFrame(h.record, { expression: '1', frame: FRAME, timeoutMs: 10 }),
				() => liveFrameUrl(h.record, FRAME),
			]
		) {
			const error = await assertRejects(call, ToolError);
			assertEquals(error.code, 'browser-unavailable');
		}
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('page_eval: a generic CDP failure AT the deadline is a `timeout`, not `browser-unavailable`', async () => {
	const f = await fixture({
		evaluate: {
			[TOP_SESSION]: () =>
				new Promise((_resolve, reject) =>
					setTimeout(() => reject(new Error('Runtime.evaluate failed: CDP error -32603: Internal error')), 60)
				),
		},
	});
	try {
		const error = await assertRejects(
			() => evaluateInFrame(f.record, { expression: 'while(true){}', frame: FRAME, timeoutMs: 50 }),
			ToolError,
		);
		assertEquals(error.code, 'timeout');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a genuine browser failure BEFORE the deadline stays `browser-unavailable`', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.reject(new Error('CDP error -32001: Session with given id not found')) },
	});
	try {
		const error = await assertRejects(
			() => evaluateInFrame(f.record, { expression: '1', frame: FRAME, timeoutMs: 1000 }),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
	} finally {
		await f.registry.shutdown();
	}
});

// --- the document an expression actually reaches -------------------------------

/**
 * `frameContext` resolves a same-process child frame to the host page's session, and a `Runtime.evaluate` with no
 * receiver there runs in that session's *default* execution context, the **top** document — accepting the caller's
 * `frame_id`, echoing it back and ignoring it.
 */
Deno.test('page_eval: an expression aimed at a same-process child frame reaches the CHILD document', async () => {
	const f = await fixture({
		callFunctionOn: {
			[TOP_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'the child title' } }),
		},
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		const outcome = await evaluateInFrame(f.record, { expression: 'document.title', frame, timeoutMs: 1000 });

		const sent = methods(f.wired);
		assertEquals(
			sent.filter((method) => method === 'Runtime.evaluate'),
			[],
			`a same-process child frame must never be read through a receiver-less Runtime.evaluate; sent ${sent.join(', ')}`,
		);
		for (const method of ['DOM.getFrameOwner', 'DOM.describeNode', 'DOM.resolveNode', 'Runtime.callFunctionOn']) {
			assert(sent.includes(method), `the child-frame path must send ${method}; it sent ${sent.join(', ')}`);
		}
		assertEquals(outcome.ok, true);
		assertEquals(outcome.value, 'the child title');
		assertEquals(outcome.frameId, LOCAL_FRAME);

		const owner = f.wired.calls.find((call) => call.method === 'DOM.getFrameOwner');
		assertEquals(owner?.params.frameId, LOCAL_FRAME);
		const described = f.wired.calls.find((call) => call.method === 'DOM.describeNode');
		assertEquals(described?.params.backendNodeId, OWNER_NODE);
		assertEquals(described?.params.pierce, true);
		const resolved = f.wired.calls.find((call) => call.method === 'DOM.resolveNode');
		assertEquals(resolved?.params.backendNodeId, DOCUMENT_NODE);
		assertEquals(resolved?.params.objectGroup, FRAME_OBJECT_GROUP);

		const ran = f.wired.calls.filter((call) =>
			call.method === 'Runtime.callFunctionOn' && !String(call.params.functionDeclaration).includes('defaultView')
		);
		assertEquals(ran.length, 1);
		assertEquals(ran[0]?.params.objectId, WINDOW_HANDLE);
		assertEquals(ran[0]?.sessionId, TOP_SESSION);
		assertEquals(ran[0]?.params.silent, true);
		assertEquals(ran[0]?.params.awaitPromise, true);
		assertEquals(ran[0]?.params.returnByValue, true);
		assert(String(ran[0]?.params.functionDeclaration).includes('document.title'));

		const released = f.wired.calls.find((call) => call.method === 'Runtime.releaseObjectGroup');
		assertEquals(released?.params.objectGroup, FRAME_OBJECT_GROUP);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the child-frame handle is released even when the evaluation THROWS', async () => {
	const f = await fixture({
		callFunctionOn: {
			[TOP_SESSION]: () => Promise.reject(new Error('CDP error -32001: Session with given id not found')),
		},
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		const error = await assertRejects(
			() => evaluateInFrame(f.record, { expression: 'boom()', frame, timeoutMs: 1000 }),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
		const released = f.wired.calls.filter((call) => call.method === 'Runtime.releaseObjectGroup');
		assertEquals(released.length, 1);
		assertEquals(released[0]?.params.objectGroup, FRAME_OBJECT_GROUP);
		assertEquals(released[0]?.sessionId, TOP_SESSION);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the top document still sends exactly one Runtime.evaluate, and no DOM traffic', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'top' } }) },
	});
	try {
		const frame = await frameContext(f.record, undefined);
		const outcome = await evaluateInFrame(f.record, { expression: 'document.title', frame, timeoutMs: 400 });
		assertEquals(outcome.value, 'top');
		assertEquals(methods(f.wired), ['Runtime.evaluate']);
		assertEquals(f.wired.calls[0]?.sessionId, TOP_SESSION);
		assertEquals(f.wired.calls[0]?.params.timeout, 400);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: an out-of-process frame still sends exactly one Runtime.evaluate, to its own session', async () => {
	const f = await fixture({
		evaluate: { [CHILD_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'oopif' } }) },
	});
	try {
		const frame = await frameContext(f.record, f.oopif.frameId);
		const outcome = await evaluateInFrame(f.record, { expression: 'document.title', frame, timeoutMs: 400 });
		assertEquals(outcome.value, 'oopif');
		assertEquals(methods(f.wired), ['Runtime.evaluate']);
		assertEquals(f.wired.calls[0]?.sessionId, CHILD_SESSION);
		assertEquals(f.wired.calls[0]?.params.timeout, 400);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a frame that changed process since the capture is corrected, not evaluated in the host', async () => {
	const f = await fixture({
		owner: 'out-of-process',
		evaluate: { [CHILD_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'moved' } }) },
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		const outcome = await evaluateInFrame(f.record, { expression: 'document.title', frame, timeoutMs: 400 });
		assertEquals(outcome.value, 'moved');
		const evaluated = f.wired.calls.filter((call) => call.method === 'Runtime.evaluate');
		assertEquals(evaluated.length, 1);
		assertEquals(evaluated[0]?.sessionId, CHILD_SESSION, 'the evaluation must go to the frame’s own target');
		assertEquals(f.wired.calls.filter((call) => call.method === 'Runtime.callFunctionOn'), []);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a document handle that cannot be resolved is a REFUSAL, not the default context', async () => {
	const f = await fixture({ documentHandle: null });
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		const error = await assertRejects(
			() => evaluateInFrame(f.record, { expression: 'document.title', frame, timeoutMs: 400 }),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
		assert(error.message.includes(LOCAL_FRAME));
		assertEquals(f.wired.calls.filter((call) => call.method === 'Runtime.evaluate'), []);
		assert(f.wired.calls.some((call) => call.method === 'Runtime.releaseObjectGroup'));
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: an owner element that cannot be read is a refusal naming the frame', async () => {
	const f = await fixture({ owner: 'throw' });
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		const error = await assertRejects(
			() => evaluateInFrame(f.record, { expression: 'document.title', frame, timeoutMs: 400 }),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
		assert(error.message.includes(LOCAL_FRAME));
		assertEquals(f.wired.calls.filter((call) => call.method === 'Runtime.evaluate'), []);
	} finally {
		await f.registry.shutdown();
	}
});

// --- the fixed HTML extraction, and the one targeting mechanism ---------------------------------

/** Small enough that a handful of characters can prove the cap travelled into the page. */
const HTML_CAP = 32;

/** The origin these rows' scripted documents answer with when the case is not about the origin. */
const HTML_ORIGIN = 'https://example.com';

/**
 * What a page-side extraction answers: the TRUE length, an at-most-`limit` string, and the origin
 * the answering document reported — the third member the cross-origin gate re-checks.
 */
function htmlPair(document: string, origin = HTML_ORIGIN, limit = HTML_CAP) {
	const html = document.length > limit ? document.slice(0, limit) : document;
	return { result: { type: 'object', value: { length: document.length, html, origin } } };
}

Deno.test('page_eval: the top document’s HTML read is ONE Runtime.evaluate carrying the cap', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.resolve(htmlPair('<html>top</html>')) },
	});
	try {
		const frame = await frameContext(f.record, undefined);
		const out = await frameDocumentHtml(f.record, frame, HTML_CAP);
		assertEquals(out, { length: 16, html: '<html>top</html>', origin: HTML_ORIGIN });
		assertEquals(methods(f.wired), ['Runtime.evaluate']);
		const sent = String(f.wired.calls[0]?.params.expression);
		assert(sent.includes(`slice(0, ${HTML_CAP})`), sent);
		assert(sent.includes('documentElement.outerHTML'), sent);
		assert(sent.includes('origin: location.origin'), sent);
		assertEquals(f.wired.calls[0]?.params.returnByValue, true);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the page caps the document and the TRUE length still comes back', async () => {
	const huge = 'y'.repeat(HTML_CAP * 5);
	const f = await fixture({ evaluate: { [TOP_SESSION]: () => Promise.resolve(htmlPair(huge)) } });
	try {
		const out = await frameDocumentHtml(f.record, await frameContext(f.record, undefined), HTML_CAP);
		assertEquals(out.length, huge.length, 'the true length must survive the cap');
		assertEquals(out.html.length, HTML_CAP);
	} finally {
		await f.registry.shutdown();
	}
});

/**
 * **The document receiver, at the tier that can see the wire.** The browser tier proves the outcome against a page
 * that really redefines `defaultView` (`tests/e2e/frame_html_e2e_test.ts`); this row proves the *shape* that makes
 * the outcome impossible — the extraction is addressed to the handle
 * `DOM.resolveNode` produced, and the `defaultView` hop is never sent on this path at all.
 */
Deno.test('page_eval: a same-process child frame’s HTML comes from the CHILD’s own DOCUMENT handle', async () => {
	const f = await fixture({
		callFunctionOn: { [TOP_SESSION]: () => Promise.resolve(htmlPair('<html>child</html>')) },
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const out = await frameDocumentHtml(f.record, await frameContext(f.record, local), HTML_CAP);
		assertEquals(out.html, '<html>child</html>');
		assertEquals(methods(f.wired).filter((method) => method === 'Runtime.evaluate'), []);
		assertEquals(
			f.wired.calls.filter((call) => String(call.params.functionDeclaration ?? '').includes('defaultView')),
			[],
			'the HTML read hopped through the page-controlled defaultView accessor',
		);
		const ran = f.wired.calls.filter((call) => call.method === 'Runtime.callFunctionOn');
		assertEquals(ran.length, 1);
		assertEquals(ran[0]?.params.objectId, DOCUMENT_HANDLE);
		assertEquals(ran[0]?.params.arguments, [{ value: HTML_CAP }]);
		assert(String(ran[0]?.params.functionDeclaration).includes('this.documentElement.outerHTML'));
		assert(String(ran[0]?.params.functionDeclaration).includes('origin: this.location.origin'));
		const released = f.wired.calls.find((call) => call.method === 'Runtime.releaseObjectGroup');
		assertEquals(released?.params.objectGroup, FRAME_OBJECT_GROUP);
	} finally {
		await f.registry.shutdown();
	}
});

/** The other half of the receiver rule: `browser_evaluate` keeps the hop. */
Deno.test('page_eval: the evaluation keeps the window hop and the HTML read does not', async () => {
	const evaluated = await fixture({
		callFunctionOn: { [TOP_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'x' } }) },
	});
	const read = await fixture({
		callFunctionOn: { [TOP_SESSION]: () => Promise.resolve(htmlPair('<html>child</html>')) },
	});
	try {
		const localA = addSameProcessFrame(evaluated.record, evaluated.top.frameId);
		const localB = addSameProcessFrame(read.record, read.top.frameId);
		await evaluateInFrame(evaluated.record, {
			expression: 'document.title',
			frame: await frameContext(evaluated.record, localA),
			timeoutMs: 400,
		});
		await frameDocumentHtml(read.record, await frameContext(read.record, localB), HTML_CAP);

		const hops = (wired: Wired) =>
			wired.calls.filter((call) => String(call.params.functionDeclaration ?? '').includes('defaultView'));
		assertEquals(hops(evaluated.wired).length, 1, 'browser_evaluate must keep the window hop');
		assertEquals(hops(read.wired).length, 0, 'browser_get_html must not take the window hop');
		assertEquals(methods(evaluated.wired).length - methods(read.wired).length, 1);
	} finally {
		await evaluated.registry.shutdown();
		await read.registry.shutdown();
	}
});

Deno.test('page_eval: a frame that answers with no document is a refusal NAMING it, not an empty success', async () => {
	for (
		const answer of [
			() => Promise.resolve({ result: { type: 'undefined' } }),
			() => Promise.resolve({ result: { type: 'string', value: 'a bare string' } }),
			() =>
				Promise.resolve({
					result: { type: 'object' },
					exceptionDetails: { text: 'Uncaught TypeError' },
				}),
			() => Promise.resolve({ result: { type: 'object', value: { length: 6, html: '<html>' } } }),
			() =>
				Promise.resolve({
					result: { type: 'object', value: { length: 6, html: '<html>', origin: null } },
				}),
		]
	) {
		const f = await fixture({ callFunctionOn: { [TOP_SESSION]: answer } });
		const local = addSameProcessFrame(f.record, f.top.frameId);
		try {
			const frame = await frameContext(f.record, local);
			const error = await assertRejects(() => frameDocumentHtml(f.record, frame, HTML_CAP), ToolError);
			assertEquals(error.code, 'browser-unavailable');
			assert(error.message.includes(LOCAL_FRAME), error.message);
		} finally {
			await f.registry.shutdown();
		}
	}
});

Deno.test('page_eval: the HTML read releases its handle even when the extraction THROWS', async () => {
	const f = await fixture({
		callFunctionOn: {
			[TOP_SESSION]: () => Promise.reject(new Error('CDP error -32001: Session with given id not found')),
		},
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		const error = await assertRejects(() => frameDocumentHtml(f.record, frame, HTML_CAP), ToolError);
		assertEquals(error.code, 'browser-unavailable');
		const released = f.wired.calls.filter((call) => call.method === 'Runtime.releaseObjectGroup');
		assertEquals(released.length, 1);
		assertEquals(released[0]?.params.objectGroup, FRAME_OBJECT_GROUP);
	} finally {
		await f.registry.shutdown();
	}
});

/** **One targeting mechanism, in full.** */
Deno.test('page_eval: browser_get_html and browser_evaluate reach a frame through ONE mechanism', async () => {
	const evaluated = await fixture({
		callFunctionOn: { [TOP_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'x' } }) },
	});
	const read = await fixture({
		callFunctionOn: { [TOP_SESSION]: () => Promise.resolve(htmlPair('<html>child</html>')) },
	});
	try {
		const localA = addSameProcessFrame(evaluated.record, evaluated.top.frameId);
		const localB = addSameProcessFrame(read.record, read.top.frameId);
		await evaluateInFrame(evaluated.record, {
			expression: 'document.title',
			frame: await frameContext(evaluated.record, localA),
			timeoutMs: 400,
		});
		await frameDocumentHtml(read.record, await frameContext(read.record, localB), HTML_CAP);

		const prefix = [
			'DOM.enable',
			'DOM.getFrameOwner',
			'DOM.describeNode',
			'DOM.resolveNode',
		];
		assertEquals(methods(evaluated.wired).slice(0, prefix.length), prefix);
		assertEquals(methods(read.wired).slice(0, prefix.length), prefix);
		assertEquals(
			evaluated.wired.calls.slice(0, prefix.length),
			read.wired.calls.slice(0, prefix.length),
			'the two tools found the frame two different ways',
		);
		const evaluatedTail = methods(evaluated.wired).slice(prefix.length);
		const readTail = methods(read.wired).slice(prefix.length);
		assertEquals(evaluatedTail, ['Runtime.callFunctionOn', 'Runtime.callFunctionOn', 'Runtime.releaseObjectGroup']);
		assertEquals(readTail, ['Runtime.callFunctionOn', 'Runtime.releaseObjectGroup']);
		const hop = evaluated.wired.calls[prefix.length];
		assert(String(hop?.params.functionDeclaration).includes('defaultView'), String(hop?.params.functionDeclaration));
		assertEquals(hop?.params.objectId, DOCUMENT_HANDLE, 'the hop must start from the resolved document');
		const evaluation = String(evaluated.wired.calls[prefix.length + 1]?.params.functionDeclaration);
		const extraction = String(read.wired.calls[prefix.length]?.params.functionDeclaration);
		assert(evaluation.includes('document.title'), evaluation);
		assert(extraction.includes('outerHTML'), extraction);
		assertEquals(evaluated.wired.calls[prefix.length + 1]?.params.objectId, WINDOW_HANDLE);
		assertEquals(read.wired.calls[prefix.length]?.params.objectId, DOCUMENT_HANDLE);
	} finally {
		await evaluated.registry.shutdown();
		await read.registry.shutdown();
	}
});

/** The cost `browser_fill_secret` pays to resolve a frame, asserted as a number. */
Deno.test('page_eval: the secret-fill frame resolution costs ONE Page.getFrameTree and nothing else', async () => {
	const f = await fixture({
		frameTree: {
			[TOP_SESSION]: {
				frame: { id: 'F-TOP', url: 'https://bank.example.com/' },
				childFrames: [{ frame: { id: LOCAL_FRAME, url: 'https://not-the-bank.example/collect' } }],
			},
		},
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const identity = await liveFrameIdentity(f.record, await frameContext(f.record, local));
		assertEquals(identity.frameUrl, 'https://not-the-bank.example/collect');
		assertEquals(methods(f.wired), ['Page.getFrameTree']);
	} finally {
		await f.registry.shutdown();
	}
});
