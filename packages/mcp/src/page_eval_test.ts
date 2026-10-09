/**
 * The frame context, the live per-frame URL, the zoom guard and the bounded evaluation (B2.7, B2.8),
 * plus the E-75 repair: which **document** an expression aimed at a frame actually reaches.
 *
 * The out-of-process frame is real: its id and its `isOopif` flag come from the recorded
 * `iframe_crossorigin` capture (D-TEST1), so they are what Chromium produced rather than what a fake
 * asserted. The same-process child frame is **scripted** — see {@linkcode addSameProcessFrame} for
 * why that is the opposite of a shortcut. Only the CDP round trips are faked, and each one records
 * the method, the session id and the parameters it was sent with, because the whole content of these
 * tests is *what was sent where*: a same-process frame is addressed through its host's session but is
 * **not** that session's document, and getting that wrong is how an expression pinned to a frame runs
 * in another one.
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

/** The object group `page_eval.ts` allocates every frame handle in (SEC-FH-9). */
const FRAME_OBJECT_GROUP = 'ttk-frame';

interface Script {
	/** What `Runtime.evaluate` answers, per CDP session id. A function may throw or delay. */
	readonly evaluate?: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;
	/**
	 * What `Runtime.callFunctionOn` answers for the **caller's** function, per CDP session id. The
	 * `defaultView` hop the receiver performs is answered by the wire itself, since it is this
	 * module's own code rather than anything a test is describing.
	 */
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
					// The receiver's own document -> window hop. Answered here because it is production
					// code's step, not a behaviour under description.
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
					// "No inline document means out-of-process" — the discriminator `extract_merge.ts` uses.
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

/**
 * Puts a same-process child frame into the session's frame vocabulary and returns its id.
 *
 * **Written here rather than searched for, deliberately.** The capture corpus has a top document and
 * one out-of-process frame and nothing else, and the test this replaces asked the capture for a
 * same-process child and `return`ed when it found none — so the branch it named never executed once,
 * and E-75 shipped underneath a green suite. A frame list the test states outright cannot go vacuous
 * when the corpus changes, and every assertion below fails loudly if the branch stops being reached.
 */
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

/**
 * A `FrameContext` for the cases that do not resolve one through {@linkcode frameContext}.
 *
 * Built through a helper so `isSessionDocument === isTop || isOopif` is stated once: the two derived
 * booleans are the whole of E-75's repair, and a hand-written literal that set them independently
 * could assert the repair while describing a frame that cannot exist.
 *
 * `named` defaults to **true** because every ref here spells an id out: these describe a caller who
 * asserted a `frame_id`, which is the case that must be verified against the live tree. The unnamed
 * context is only ever produced by `frameContext(record, undefined)`, and the cases that need it call
 * that rather than fabricating one.
 */
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
		// The caller asserted no id, so there is nothing for Gate B to verify. This is the ONE context
		// that may take the `liveFrameIdentity` short-circuit.
		assertEquals(frame.named, false);
		// The page session's default execution context already IS this document, so no receiver is
		// needed and the 0.2.0 call shape stands unchanged.
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
		// Its own target's tree is rooted at it, so its own session's default context is its document.
		assertEquals(frame.isSessionDocument, true);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a same-process frame is on its HOST session but is NOT that session’s document (E-75)', async () => {
	const f = await fixture();
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		assertEquals(frame.isOopif, false);
		assertEquals(frame.sessionId, TOP_SESSION);
		assertEquals(frame.isTop, false);
		// The whole of E-75 in one boolean: the host page's session speaks for this frame, and its
		// default execution context is the HOST's document, not this one.
		assertEquals(frame.isSessionDocument, false);
		// Gate C is lazy and this proves it: resolving a frame costs zero CDP round trips, which is
		// what keeps `browser_fill_secret` — which resolves a frame only to feed its SEC-07 domain pin
		// and never evaluates in it — free of three calls for a node it never uses.
		assertEquals(f.wired.calls.length, 0);
	} finally {
		await f.registry.shutdown();
	}
});

/**
 * **S3-R, row 3d at the module boundary.** A caller may name the top frame's id, and it resolves to
 * the top document.
 *
 * `browser_evaluate` has accepted `frame_id` since B2.7 and naming the root has always worked there,
 * because `Runtime.evaluate` against the page session's default context *is* the top document. A
 * narrow `isTop` — "the caller omitted `frame_id`" — sent that shipped call to Gate C, where
 * `DOM.getFrameOwner` fails on a frame that has no owner element. The two booleans below are what
 * keeps that path on its 0.2.0 shape while still letting Gate B verify the id the caller asserted.
 */
Deno.test('S3-R: a NAMED top frame id is the top document, and is named AND top (3d)', async () => {
	const f = await fixture();
	try {
		const frame = await frameContext(f.record, f.top.frameId);
		assertEquals(frame.frameId, f.top.frameId);
		assertEquals(frame.sessionId, TOP_SESSION);
		assertEquals(frame.isOopif, false);
		assertEquals(frame.isTop, true, 'a frame_id equal to frames[0] names the top document');
		// The half that keeps the credential path intact: this id was ASSERTED, so Gate B still checks
		// it against the live tree. `isTop` and `named` answer different questions (SEC-FH-15).
		assertEquals(frame.named, true);
		// And therefore no receiver: `Runtime.evaluate` on the page session, exactly as 0.2.0 sent it.
		assertEquals(frame.isSessionDocument, true);
		// Gate A is still pure: the widening reads the session's own frame list, not the browser.
		assertEquals(f.wired.calls.length, 0);
	} finally {
		await f.registry.shutdown();
	}
});

/**
 * **SEC-FH-16's invariant, named and asserted over the recorded corpus (REV-3).**
 *
 * `frameContext` decides one fact — "is this the top document" — from the cached frame list rather
 * than from a live read, and that fact suppresses both origin gates on `browser_get_html`. The
 * security pass graded the consequence Minor by attributing the safety to the receiver being the
 * session's default context; review measured that the real reason is narrower: the merged list's
 * root is seeded with `isOopif: false` by construction (`extract_merge.ts:200`), so `frames[0]` can
 * never name an out-of-process frame, and only a mutated cache could make it one.
 *
 * An unnamed invariant is one a later capture-pipeline change is free to break silently. So the
 * corpus is walked and the root is checked — through {@linkcode summaryOf}, the same projection that
 * fills `cachedBrowserState`, which makes the subject the list `frameContext` actually reads rather
 * than the merge output one step upstream. The day a pipeline change seeds a root out-of-process,
 * this row fails rather than a gate quietly stopping firing.
 *
 * **Why it lives here and not with the merge (REV-9).** It first landed in
 * `packages/browser/src/dom/extract_test.ts`, which is inside a **vendored** package: §7 forbids an
 * edit there without an `E-nn`, and this delivery deliberately contorted the S4 fixture layout to
 * avoid owing one — so asserting this from the vendored side would have applied one rule two ways.
 * The corpus is reachable from this package (`element_record_test.ts` and `locators_test.ts` already
 * walk all 36 captures), and the consumer of the invariant is `frameContext`, whose boundary
 * assertion is the test directly below. Nothing about the coverage changed in the move.
 */
Deno.test('page_eval: the cached ROOT is never out-of-process over the corpus (SEC-FH-16, REV-3)', async () => {
	// Non-vacuous by construction: COMPLETIONS-CRITERIA §3.2's floor, so a corpus that stopped
	// loading fails here rather than passing an empty loop.
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

/**
 * **SEC-FH-16's invariant, asserted at the boundary that consumes it (REV-3).**
 *
 * `isTop` is decided from cached state and suppresses both origin gates, so a root that is wrongly
 * `isTop` is a cross-origin read with no scope check and no ledger row. The security pass credited
 * the receiver for that safety; the real reason is that the cached tree's root is never an
 * out-of-process frame (`extract_merge.ts:200`, asserted over the corpus by the test directly
 * above). Only a mutated cache produces the shape below — which is exactly how review reached it —
 * and the predicate now refuses to hand it the top-document pass, so a broken invariant upstream
 * costs a scope check rather than a silent read.
 */
Deno.test('page_eval: a cached ROOT marked out-of-process does NOT get the top-document pass (SEC-FH-16, REV-3)', async () => {
	const f = await fixture();
	try {
		const state = f.record.session.cachedBrowserState;
		assert(state !== null && state !== undefined);
		// The mutation review had to perform to reach the shape at all: the pipeline cannot produce it.
		Object.assign(state, {
			frames: state.frames.map((frame, index) => index === 0 ? { ...frame, isOopif: true } : frame),
		});
		const frame = await frameContext(f.record, f.top.frameId);
		assertEquals(frame.isTop, false, 'an out-of-process root must not suppress the origin gates');
		// And it is still the frame the caller named, resolved as an out-of-process frame would be —
		// the refusal this buys is Gate B's, on the origin, not a new failure mode of its own.
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
		// Nothing was sent: the refusal happens before a session is opened, so a mistyped id cannot
		// evaluate an expression or type a credential into the top document by accident.
		assertEquals(f.wired.calls.length, 0);
	} finally {
		await f.registry.shutdown();
	}
});

// --- the live per-frame URL (SEC-07) ------------------------------------------

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

Deno.test('page_eval: a nested frame answers with ITS OWN url, not the top document’s (SEC-07)', async () => {
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
		// The frameset case a naive implementation gets wrong: the top URL is inside the secret's
		// domains and the frame's own is not.
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
	// The tab navigated since the last observation, so the capture's top frame id is not the live
	// one. A provenance field that answered with the remembered id would name a document that is no
	// longer on screen.
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
 * **S3-R, row 3d.** A named root is searched for in the live tree like any other named id, and
 * finding it at the root is what makes it same-origin.
 *
 * `findFrame` tests the tree's own root before descending, so this costs no CDP call the unnamed path
 * did not already spend: the tree is read once and answers both the search and `topUrl`.
 */
Deno.test('S3-R: a NAMED root is verified against the live tree and answers with the top document (3d)', async () => {
	// Filled in once the capture has told us its own top frame id: the caller must be able to name the
	// id `browser_get_frames` gave them, so the scripted tree has to agree with the capture.
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
		// Same URL as the top document, which is what makes the handler's origin comparison answer
		// "same origin": no scope required, no ledger row (architecture §5.2, honoured literally).
		assertEquals(identity.frameUrl, 'https://example.com/');
		assertEquals(identity.topUrl, 'https://example.com/');
		assertEquals(identity.frameUrl, identity.topUrl);
		// Zero extra CDP calls: the search runs over the tree Gate B already read.
		assertEquals(methods(f.wired), ['Page.getFrameTree']);
	} finally {
		await f.registry.shutdown();
	}
});

/**
 * **S3-R, row 3e / C-17.** A named root the live tree no longer holds is a refusal, not an answer
 * about whichever document is focused now.
 *
 * The id was carried across a tab switch, or Chromium replaced the main frame. Answering would be
 * "you asked for document X and were given document Y, with no error", which is the case the plain
 * one-line widening of `isTop` would have opened.
 */
Deno.test('S3-R: a NAMED root the live tree no longer holds is REFUSED (3e, C-17)', async () => {
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
 * **S3-R, the confinement itself (SEC-FH-15).** The short-circuit is keyed on `named`, never on
 * `isTop`, and this case is the difference between the two.
 *
 * Both refs below describe the top document of a session whose live tree has moved on. The unnamed
 * one asserted no id, so the live root is the correct answer and there is nothing to verify. The
 * named one asserted an id that is gone, and must be refused — because the id
 * `browser_fill_secret` derives from a top-document node is exactly this shape, and a short-circuit
 * keyed on `isTop` would delete that handler's "no longer attached" refusal.
 */
Deno.test('S3-R: the liveFrameIdentity short-circuit is keyed on `named`, NOT on `isTop` (SEC-FH-15)', async () => {
	const script = {
		frameTree: {
			[TOP_SESSION]: { frame: { id: 'F-TOP-LIVE', url: 'https://live.example/now' } },
		},
	};

	const unnamed = await fixture(script);
	try {
		// No id was asserted, so "the focused document" is whatever the tree root is now.
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
		// The same document, the same `isTop`, one bit different — and the answer is a refusal.
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

// --- the zoom guard (SEC-24) --------------------------------------------------

Deno.test('page_eval: scale 1 passes the guard', async () => {
	const f = await fixture({ scale: 1 });
	try {
		assertEquals(await assertUnitViewportScale(f.record), 1);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: a scaled visual viewport REFUSES a secret-bearing action (SEC-24)', async () => {
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

Deno.test('page_eval: a renderer that never answers is a `timeout`, not a hang (B2-SR5-8)', async () => {
	const f = await fixture({
		// The renderer's own `timeout` cannot fire for a renderer that never processed the message, so
		// this never settles. Only the server-side deadline can end it.
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
	// The shape real Chromium produces, measured on the browser tier: a 30 s busy loop under a 1 s
	// `Runtime.evaluate` timeout came back in 1029 ms as `CDP error -32603: Internal error`. There is
	// no word in that message a text match could find, and answering `browser-unavailable` would
	// blame a browser that is fine for a cap that worked.
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
	// The other half, so the deadline rule cannot swallow every fault: a session that is simply gone
	// fails immediately and must not be reported as the caller's expression running too long.
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

// --- E-75: the document an expression actually reaches -------------------------

/**
 * The regression that had to fail against `9fb8ddf`, and did.
 *
 * `frameContext` resolved a same-process child frame to the host page's session and
 * `evaluateInFrame` then issued `Runtime.evaluate` with no receiver — which runs in that session's
 * *default* execution context, the **top** document. The caller's `frame_id` was accepted, echoed
 * back and ignored. The assertion is therefore on the call sequence rather than on a return value: a
 * wrong-document evaluation succeeds, so only *what was sent* can tell the two apart.
 */
Deno.test('page_eval: an expression aimed at a same-process child frame reaches the CHILD document (E-75)', async () => {
	const f = await fixture({
		callFunctionOn: {
			[TOP_SESSION]: () => Promise.resolve({ result: { type: 'string', value: 'the child title' } }),
		},
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const frame = await frameContext(f.record, local);
		const outcome = await evaluateInFrame(f.record, { expression: 'document.title', frame, timeoutMs: 1000 });

		// Asserted before the value, deliberately: an evaluation in the wrong document *succeeds*, so
		// the returned value is the weakest possible witness and the call sequence is the strongest.
		const sent = methods(f.wired);
		// **The E-75 assertion.** `Runtime.evaluate` carries no receiver in this module, so *any*
		// `Runtime.evaluate` on this path is an evaluation in the host document.
		assertEquals(
			sent.filter((method) => method === 'Runtime.evaluate'),
			[],
			`a same-process child frame must never be read through a receiver-less Runtime.evaluate; sent ${sent.join(', ')}`,
		);
		// Gate C, then the handle, then the call against it.
		for (const method of ['DOM.getFrameOwner', 'DOM.describeNode', 'DOM.resolveNode', 'Runtime.callFunctionOn']) {
			assert(sent.includes(method), `the child-frame path must send ${method}; it sent ${sent.join(', ')}`);
		}
		assertEquals(outcome.ok, true);
		assertEquals(outcome.value, 'the child title');
		assertEquals(outcome.frameId, LOCAL_FRAME);

		// The owner element is found by the frame's own id, and the document node it pierces to is the
		// node the handle is taken from — not the host document's.
		const owner = f.wired.calls.find((call) => call.method === 'DOM.getFrameOwner');
		assertEquals(owner?.params.frameId, LOCAL_FRAME);
		const described = f.wired.calls.find((call) => call.method === 'DOM.describeNode');
		assertEquals(described?.params.backendNodeId, OWNER_NODE);
		assertEquals(described?.params.pierce, true);
		const resolved = f.wired.calls.find((call) => call.method === 'DOM.resolveNode');
		assertEquals(resolved?.params.backendNodeId, DOCUMENT_NODE);
		assertEquals(resolved?.params.objectGroup, FRAME_OBJECT_GROUP);

		// The caller's expression runs on the child's WINDOW, so `this` means what it means in the
		// top document — and it is wrapped as an expression, per the announced U-2 delta.
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

		// I-FH-7 on the success path too.
		const released = f.wired.calls.find((call) => call.method === 'Runtime.releaseObjectGroup');
		assertEquals(released?.params.objectGroup, FRAME_OBJECT_GROUP);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the child-frame handle is released even when the evaluation THROWS (I-FH-7)', async () => {
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
		// A handle left in the group is a Chromium-side allocation nobody frees (SEC-FH-9), and the
		// path that leaks it is the failure path, which is exactly the one nobody exercises by hand.
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
		// Byte for byte the 0.2.0 path: one call, the renderer's own deadline on it, nothing else.
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
	// The capture said same-process; Gate C pierces the owner and finds no inline document, which is
	// the browser saying the frame moved into its own renderer. The correction rides back on the
	// receiver's session id rather than mutating a FrameContext somebody else is holding.
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
	// The single most important failure rule in the module: `null` means "the session's default
	// document", so answering it for a handle we failed to get is E-75 through a different door.
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
		// And the group is still freed, because `DOM.resolveNode` may have allocated into it.
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

// --- the fixed HTML extraction (D-057), and the one targeting mechanism (I-FH-3) ---------------

/** Small enough that a handful of characters can prove the cap travelled into the page. */
const HTML_CAP = 32;

/** The origin these rows' scripted documents answer with when the case is not about the origin. */
const HTML_ORIGIN = 'https://example.com';

/**
 * What a page-side extraction answers: the TRUE length, an at-most-`limit` string, and the origin
 * the answering document reported — the third member the cross-origin gate re-checks (SEC-FH-17).
 */
function htmlPair(document: string, origin = HTML_ORIGIN, limit = HTML_CAP) {
	const html = document.length > limit ? document.slice(0, limit) : document;
	return { result: { type: 'object', value: { length: document.length, html, origin } } };
}

Deno.test('page_eval: the top document’s HTML read is ONE Runtime.evaluate carrying the cap (D-057)', async () => {
	const f = await fixture({
		evaluate: { [TOP_SESSION]: () => Promise.resolve(htmlPair('<html>top</html>')) },
	});
	try {
		const frame = await frameContext(f.record, undefined);
		const out = await frameDocumentHtml(f.record, frame, HTML_CAP);
		assertEquals(out, { length: 16, html: '<html>top</html>', origin: HTML_ORIGIN });
		// I-FH-6's half that lives in this module: no receiver, no DOM traffic, one call.
		assertEquals(methods(f.wired), ['Runtime.evaluate']);
		const sent = String(f.wired.calls[0]?.params.expression);
		// The cap is IN the expression, which is what stops a 40 MB document crossing the channel;
		// the true length comes back beside the capped string because it is a number.
		assert(sent.includes(`slice(0, ${HTML_CAP})`), sent);
		assert(sent.includes('documentElement.outerHTML'), sent);
		// SEC-FH-17: the authorization input rides back with the bytes. `location.origin` and not a
		// second `Page.getFrameTree`, because `Location`'s properties are `[LegacyUnforgeable]` — a
		// page cannot shadow or redefine it — and because a value read on the same round trip as the
		// document has no window after it to navigate in.
		assert(sent.includes('origin: location.origin'), sent);
		assertEquals(f.wired.calls[0]?.params.returnByValue, true);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('page_eval: the page caps the document and the TRUE length still comes back (F-3, D-057)', async () => {
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
 * **REV-1, at the tier that can see the wire.** The browser tier proves the outcome against a page
 * that really redefines `defaultView` (`tests/e2e/frame_html_e2e_test.ts`); this row proves the
 * *shape* that makes the outcome impossible — the extraction is addressed to the handle
 * `DOM.resolveNode` produced, and the `defaultView` hop is never sent on this path at all. A unit
 * assertion could not have found the defect, because the fake wire answered the hop itself; it can
 * hold the repair in place, because a regression re-introduces a call this row forbids by name.
 */
Deno.test('page_eval: a same-process child frame’s HTML comes from the CHILD’s own DOCUMENT handle (REV-1)', async () => {
	const f = await fixture({
		callFunctionOn: { [TOP_SESSION]: () => Promise.resolve(htmlPair('<html>child</html>')) },
	});
	const local = addSameProcessFrame(f.record, f.top.frameId);
	try {
		const out = await frameDocumentHtml(f.record, await frameContext(f.record, local), HTML_CAP);
		assertEquals(out.html, '<html>child</html>');
		// The same rule E-75 exists for: a receiver-less Runtime.evaluate on this path reads the HOST
		// document, so any of them here would be the wrong document returned as a success.
		assertEquals(methods(f.wired).filter((method) => method === 'Runtime.evaluate'), []);
		// REV-1: `Document.prototype.defaultView` is an ordinary configurable accessor in real
		// Chromium, so a hop through it reads the bytes AND the authorization origin out of an object
		// the page chose. The HTML read must not take that hop — not "must not trust its result".
		assertEquals(
			f.wired.calls.filter((call) => String(call.params.functionDeclaration ?? '').includes('defaultView')),
			[],
			'the HTML read hopped through the page-controlled defaultView accessor',
		);
		const ran = f.wired.calls.filter((call) => call.method === 'Runtime.callFunctionOn');
		assertEquals(ran.length, 1);
		// The handle `DOM.resolveNode` returned for the pierced `contentDocument`, and no other.
		assertEquals(ran[0]?.params.objectId, DOCUMENT_HANDLE);
		// The limit is an ARGUMENT, not spliced text: on the path a caller can name, nothing is
		// interpolated into the function body at all (the non-goal, enforced by shape).
		assertEquals(ran[0]?.params.arguments, [{ value: HTML_CAP }]);
		assert(String(ran[0]?.params.functionDeclaration).includes('this.documentElement.outerHTML'));
		// SEC-FH-17, and `this.` is the load-bearing half: the origin must be the RECEIVER's own — the
		// document that produced the bytes — and `location` is an own non-configurable property of that
		// Document, which is what REV-1 moved the read onto.
		assert(String(ran[0]?.params.functionDeclaration).includes('origin: this.location.origin'));
		const released = f.wired.calls.find((call) => call.method === 'Runtime.releaseObjectGroup');
		assertEquals(released?.params.objectGroup, FRAME_OBJECT_GROUP);
	} finally {
		await f.registry.shutdown();
	}
});

/**
 * The other half of REV-1's repair, which is a *non*-change: `browser_evaluate` keeps the hop.
 *
 * Its `this` semantics need the window — an expression written as `document.title` against a
 * Document would be reading a property of the wrong kind of object — and its ledger origin is not
 * page-sourced: it comes from `liveFrameUrl`, i.e. the frame tree, which is browser-side. Asserting
 * the two receivers differ, in one place, is what stops a later "simplification" from unifying them
 * in either direction.
 */
Deno.test('page_eval: the evaluation keeps the window hop and the HTML read does not (REV-1)', async () => {
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
		// And the cost moves the only direction REV-1 allows: the HTML path is one round trip CHEAPER.
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
			// SEC-FH-17: an answer that carries the bytes but NOT the origin is a missing
			// authorization fact, so it fails closed with the rest rather than being read as
			// "same-origin, no origin reported". A `{length, html}` pair is what this handler
			// returned before the re-check existed, and it must not be accepted now.
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
			// `{length: 0, html: ''}` would be a lie that reads as a page with an empty document.
			assert(error.message.includes(LOCAL_FRAME), error.message);
		} finally {
			await f.registry.shutdown();
		}
	}
});

Deno.test('page_eval: the HTML read releases its handle even when the extraction THROWS (I-FH-7)', async () => {
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

/**
 * **I-FH-3, in full.** Owed since S1, when `receiverFor` had one consumer and a comparison had
 * nothing to compare against.
 *
 * The two tools must reach a frame the *same way*, not merely both work: a second targeting
 * mechanism is how one of them acquires a bug — or a relaxation — the other does not. So this drives
 * both over one scripted frame and asserts the CDP prefix is identical **call for call, parameter
 * for parameter**, up to the point where they legitimately diverge: the handle each asks the one
 * mechanism for, and the function each runs on it. A divergence anywhere earlier means the frame was
 * found twice, two ways.
 *
 * **The divergence point moved in this revision and the reason is recorded here (REV-1).** Both used
 * to hop from the resolved document to its `window`. `Document.prototype.defaultView` is an ordinary
 * configurable accessor, so on that hop a page chose the object the server read — which for
 * `browser_get_html` meant the object its *authorization origin* came out of. The evaluation keeps
 * the hop (its `this` needs the window; its ledger origin comes from the frame tree, not the page);
 * the read stops at the document. Sharing a mechanism was never the same claim as sharing every
 * round trip, and the shared part is the part that finds the frame.
 */
Deno.test('page_eval: browser_get_html and browser_evaluate reach a frame through ONE mechanism (I-FH-3)', async () => {
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

		// Gate C and the handle: four calls that must agree entirely, in order, parameter for
		// parameter. This is the *finding* of the frame, and it is the whole of I-FH-3's content.
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
		// **Where they diverge, and why it moved (REV-1).** Until this revision both hopped from the
		// resolved document to its `window` and diverged only at the function body. That hop goes
		// through `Document.prototype.defaultView`, which a page can redefine, so the HTML read — whose
		// authorization origin comes back *in* its answer — now stops at the document handle. One
		// mechanism still finds the frame; the two tools then ask it for different handles, which is a
		// declared parameter (`receiverFor(..., want)`) rather than a second way of finding anything.
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
		// The receiver each function runs on, asserted rather than described: the window for the
		// evaluation, the document for the read.
		assertEquals(evaluated.wired.calls[prefix.length + 1]?.params.objectId, WINDOW_HANDLE);
		assertEquals(read.wired.calls[prefix.length]?.params.objectId, DOCUMENT_HANDLE);
	} finally {
		await evaluated.registry.shutdown();
		await read.registry.shutdown();
	}
});

/**
 * The cost `browser_fill_secret` pays to resolve a frame, asserted as a number.
 *
 * It resolves a frame only so `liveFrameIdentity` can make the SEC-07 domain-pin decision and never
 * evaluates in it, so Gate C must stay lazy: one tree read, and not one call more. This is the
 * assertion that fails if a later change makes the gate eager on the most safety-critical handler in
 * the catalog (`report_design.md` §11).
 */
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
