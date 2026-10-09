/**
 * The frame's own JavaScript context: which CDP session owns a frame, what that frame's URL is
 * *right now*, whether the visual viewport is scaled, and the bounded evaluation itself (B2.7, B2.8).
 *
 * One module for the four because they are one question asked from two tools. `browser_evaluate`
 * needs the session and the bounded evaluation; `browser_fill_secret` needs the session, the live
 * per-frame URL and the scale guard. Splitting them would put the "read the URL live, per frame"
 * rule — which is the whole content of `SPECS/SECURITY-AUTH.md` §7.1 — in two places, free to be
 * true in one of them.
 *
 * **Nothing here is a sandbox and nothing here pretends to be.** An expression evaluated through
 * {@linkcode evaluateInFrame} runs in the frame's own main world, with the page's DOM, the page's
 * non-`HttpOnly` cookies and the page's network. The caps below are availability and context-cost
 * controls, recorded as such in the security seed (SEC-23); the containment control is the
 * `evaluate` scope grant and nothing else (D-A4).
 */
import type { BrowserSession } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import type { SessionRecord } from './registry.ts';

/**
 * The evaluation deadline, in milliseconds, and its ceiling — the same number.
 *
 * A caller may ask for less; it may not ask for more, because the cap exists to stop one call
 * holding the session's CDP channel, which every other tool and the screencast share.
 */
export const EVALUATE_TIMEOUT_MS_DEFAULT = 1000;
export const EVALUATE_TIMEOUT_MS_MAX = 1000;

/**
 * Extra milliseconds the server waits beyond the renderer's own deadline before giving up.
 *
 * `Runtime.evaluate` carries a typed `timeout` that terminates execution *inside* the renderer. That
 * cannot answer for a renderer which has stopped processing CDP messages at all, so the server keeps
 * its own deadline just above it and classifies the refusal as `timeout` either way (B2-SR5-8).
 */
const EVALUATE_GRACE_MS = 250;

/** Bytes of serialized result carried back to the caller. Beyond this the answer says it was cut. */
export const EVALUATE_RESULT_LIMIT_BYTES = 64 * 1024;

/**
 * Characters of the page's own exception message carried back.
 *
 * Truncated **at the builder**, not merely bounded in the output schema: a `.max()` on a schema is a
 * validation that fails the whole call, where what a caller wants is the first 512 characters of why
 * their expression threw. Same class as B2-SR4-4's `hit_tag`, closed the same way.
 */
export const EVALUATE_ERROR_TEXT_CHARS = 512;

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

/**
 * The object group every frame-scoped `RemoteObject` this module allocates belongs to.
 *
 * One name, so one `Runtime.releaseObjectGroup` frees the whole receiver — the discipline
 * `performSearch` applies to its `searchId` (`tools/perception.ts:391-394`). A handle left behind is
 * a Chromium-side allocation nobody frees (SEC-FH-9).
 */
const FRAME_OBJECT_GROUP = 'ttk-frame';

/** A frame resolved to the CDP session that can speak for it **and** to the document it names. */
export interface FrameContext {
	/** The frame id, as the capture and `browser_get_frames` spell it. */
	readonly frameId: string;
	/** The CDP session to send `Runtime.*` and `Page.*` to for this frame. */
	readonly sessionId: SessionId;
	/** True when the frame is its own process and therefore its own target. */
	readonly isOopif: boolean;
	/**
	 * Did the caller supply a `frame_id` at all?
	 *
	 * Separate from {@linkcode isTop} because the two answer different questions, and conflating them
	 * is what the first cut of this interface got wrong. `named === false` means "whatever document is
	 * focused now", which has no id to verify; `named === true` means the caller **asserted** an id,
	 * and an asserted id is always checked against the live tree — including when it happens to be the
	 * root's. {@linkcode liveFrameIdentity} is the only thing that may act on it.
	 */
	readonly named: boolean;
	/**
	 * Is this the top document of the focused tab?
	 *
	 * True when the caller omitted `frame_id`, **or** named the id the session's own frame list holds
	 * first. `frames[0]` is the top document by construction: `extract_merge.ts:195-205` seeds the
	 * array with the root session's frame before descending, `browser_get_frames` documents the list
	 * as root-first, and this module's own default branch and `browser_verify_locator`
	 * (`tools/perception.ts:283`) already both read it that way.
	 *
	 * The second half exists because `browser_evaluate` has accepted `frame_id` since B2.7 and naming
	 * the top frame's id has always worked there — `Runtime.evaluate` landed in the page session's
	 * default context, which *is* the top document. Narrowing this to the omitted case alone would
	 * send that shipped call to Gate C, where `DOM.getFrameOwner` fails on a frame that has no owner
	 * element: an unannounced breaking change to a working path.
	 */
	readonly isTop: boolean;
	/**
	 * True when `sessionId`'s DEFAULT execution context already **is** this frame's document: the
	 * focused tab's top document, and every out-of-process frame (its own target, rooted at itself).
	 *
	 * ERRATUM(E-75): this field exists because `Runtime.evaluate` with no receiver lands in the
	 * session's default context. When this is false — a same-process child frame — that context is
	 * the TOP document, and an evaluation sent there reaches the wrong document while appearing to
	 * succeed. {@linkcode receiverFor} is the only thing that may act on it.
	 */
	readonly isSessionDocument: boolean;
}

/**
 * Resolves a frame id to the CDP session that owns it — **Gate A of D-054, and only Gate A**.
 *
 * The same rule `performSearch` follows, and deliberately not a second one: an out-of-process frame
 * is its own target and Chrome uses the frame id as the target id; a same-process frame is addressed
 * through its host's session, whose tree already includes it. Omitting `frameId` means the session's
 * focused document.
 *
 * An unknown `frameId` is `invalid-arguments` naming it, rather than a silent fall back to the top
 * document: falling back would evaluate the caller's expression, or type the caller's credential,
 * somewhere other than where they asked. The membership check is the **first** statement, so an id
 * this session never held costs zero CDP round trips and an id minted by another session is *absent*
 * rather than probed.
 *
 * The attachment check (Gate B) lives in {@linkcode liveFrameIdentity} and the document node
 * (Gate C) in {@linkcode receiverFor}, both lazily: `browser_fill_secret` resolves a frame only to
 * feed the SEC-07 domain pin and never evaluates in it, so an eager Gate C would add three CDP calls
 * to the most safety-critical handler in the catalog for a node it never uses (`report_design.md`
 * §11).
 *
 * **This is also the only place `isTop` is decided.** It is the one gate *both* frame-scoped tools
 * pass before extraction, which is why the top-document predicate lives here and not in
 * `browser_get_html`'s handler.
 */
export async function frameContext(record: SessionRecord, frameId?: string): Promise<FrameContext> {
	const session = record.session;
	const { manager, focus } = connected(session);
	const frames = session.cachedBrowserState?.frames ?? [];
	// Two facts, not one. `named` is about the CALLER — did an id arrive — and `isTop` is about the
	// DOCUMENT. An omitted id is the focused document; a supplied id that equals `frames[0]` names the
	// same document and must resolve to it, because `browser_evaluate` has accepted exactly that since
	// B2.7. An empty frame list makes the second half `undefined === <string>`, which is false.
	const named = frameId !== undefined;
	// **SEC-FH-16's unstated invariant, named and asserted (REV-3).** `isTop` is the one fact on this
	// path taken from cached state while everything beside it is read live, and it suppresses *both*
	// origin gates: a frame that is wrongly `isTop` is read with no scope check and no ledger row.
	// What makes the cached value safe is not that the cache is fresh — it is that the cached tree's
	// ROOT is never an out-of-process frame. `extract_merge.ts` seeds `frames[0]` with
	// `isOopif: false` by construction and all 36 recorded captures agree, which was load-bearing and
	// unwritten. Written here, and asserted rather than trusted: a root the capture pipeline ever
	// marks out-of-process does not receive the top-document pass, so a broken invariant costs a
	// scope check instead of a silent cross-origin read.
	const root = frames[0];
	const isTop = frameId === undefined || (frameId === root?.frameId && root?.isOopif !== true);
	if (frameId === undefined) {
		const page = await manager.getOrCreateCdpSession(focus, true);
		return {
			frameId: root?.frameId ?? String(focus),
			sessionId: page.sessionId,
			isOopif: false,
			named,
			isTop,
			isSessionDocument: true,
		};
	}
	const frame = frames.find((entry) => entry.frameId === frameId);
	if (frame === undefined) {
		throw new ToolError(
			'invalid-arguments',
			`no frame with id ${frameId} in the state this session holds; call browser_get_frames`,
		);
	}
	if (frame.isOopif) {
		const child = await manager.getOrCreateCdpSession(frameId as TargetId, false);
		return { frameId, sessionId: child.sessionId, isOopif: true, named, isTop, isSessionDocument: true };
	}
	const page = await manager.getOrCreateCdpSession(focus, true);
	// The one case E-75 was wrong about: the host page's session speaks for this frame, but its
	// default execution context is the host's OWN document, not this one — UNLESS the id names the top
	// document itself, where the two are the same document and the 0.2.0 call shape is correct.
	return { frameId, sessionId: page.sessionId, isOopif: false, named, isTop, isSessionDocument: isTop };
}

/**
 * The frame's URL **as the browser holds it now**, not as a capture remembered it.
 *
 * `SPECS/SECURITY-AUTH.md` §7.1 rule 1 states the reason in its own words: the difference between
 * "pinned to your bank" and "typed into whatever the page navigated itself to while you were
 * deciding". SEC-07 adds the half a frameset makes ambiguous — it must be the URL of the frame the
 * element lives in, not the top document's, because a page can put a same-origin `iframe` around a
 * password field and the top URL would still look right.
 *
 * `Page.getFrameTree` is the live read: for an out-of-process frame its own target's tree is rooted
 * at that frame, and for a same-process frame the host's tree contains it by id.
 */
export async function liveFrameUrl(record: SessionRecord, frame: FrameContext): Promise<string> {
	const tree = await frameTreeOf(record, frame.sessionId);
	const found = findFrame(tree, frame.frameId);
	if (found === null) {
		throw new ToolError('invalid-arguments', `frame ${frame.frameId} is no longer attached to this session`);
	}
	return found;
}

/**
 * The frame's live URL **and** the top document's, from as few reads as the frame tree allows
 * (B2.8).
 *
 * `browser_fill_secret` needs both: the frame's own URL for the domain pin (SEC-07), and the top
 * document's to decide whether the frame is cross-origin at all. They must be read together and
 * *now* — reading one from a capture and one from the browser would compare a page against a memory
 * of itself.
 *
 * A same-process frame is in the page's own tree, so one `Page.getFrameTree` answers both; an
 * out-of-process frame needs a second read against its own target, whose tree is rooted at it. Two
 * calls at most, and the top URL always comes from the page session, never from the child.
 *
 * It also answers with the frame's **live** id. For a named frame that is the id the caller gave —
 * the tree read is what proved it is still attached. For the focused document it is the tree root's
 * id rather than the one a capture remembered, so a tab that navigated since the last observation is
 * named correctly and a session that has never been observed can still name its own top document.
 *
 * **The short-circuit below is confined to an UNNAMED frame, and the confinement is load-bearing.**
 * It is keyed on {@linkcode FrameContext.named}, never on `isTop`. Keying it on `isTop` would make
 * every named root — including the one `browser_fill_secret` derives from a top-document node's own
 * `frameId` — skip the live-tree search, which would delete that handler's "no longer attached"
 * refusal as a side effect of widening a predicate for an unrelated parameter (SEC-FH-15). A caller
 * who asserted an id gets it verified; a caller who asserted nothing had no id to verify.
 */
export async function liveFrameIdentity(
	record: SessionRecord,
	frame: FrameContext,
): Promise<{ frameId: string; frameUrl: string; topUrl: string }> {
	const { manager, focus } = connected(record.session);
	const page = await manager.getOrCreateCdpSession(focus, true);
	const tree = await frameTreeOf(record, page.sessionId);
	const topUrl = tree.frame.url;
	// No id was supplied, so there is nothing to check: the root of the tree we just read IS the
	// document the caller asked for, and it cannot be "no longer attached".
	if (!frame.named) return { frameId: tree.frame.id, frameUrl: topUrl, topUrl };
	if (frame.isOopif) return { frameId: frame.frameId, frameUrl: await liveFrameUrl(record, frame), topUrl };
	// A named id — the root's included — is searched for in the tree already read. `findFrame` tests
	// the root first, so a named root that is still the root costs no extra round trip and comes back
	// with `frameUrl === topUrl`: same-origin, no scope, no ledger row. A named root the tree no
	// longer holds falls through to the refusal, rather than silently answering about whichever
	// document is focused now.
	const found = findFrame(tree, frame.frameId);
	if (found === null) {
		throw new ToolError('invalid-arguments', `frame ${frame.frameId} is no longer attached to this session`);
	}
	return { frameId: frame.frameId, frameUrl: found, topUrl };
}

/** One `Page.getFrameTree`, with a browser failure classified rather than leaked. */
async function frameTreeOf(
	record: SessionRecord,
	sessionId: SessionId,
): Promise<{ frame: { id: string; url: string }; childFrames?: unknown }> {
	const { client } = connected(record.session);
	try {
		const { frameTree } = await client.send.Page.getFrameTree({}, sessionId);
		return frameTree as { frame: { id: string; url: string }; childFrames?: unknown };
	} catch (cause) {
		throw new ToolError(
			'browser-unavailable',
			`the frame's current URL could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
}

/** Depth-first search of a `Page.FrameTree` for one frame's live URL. */
function findFrame(
	node: { frame: { id: string; url: string }; childFrames?: unknown },
	frameId: string,
): string | null {
	if (node.frame.id === frameId) return node.frame.url;
	const children = Array.isArray(node.childFrames) ? node.childFrames : [];
	for (const child of children) {
		const found = findFrame(child as { frame: { id: string; url: string }; childFrames?: unknown }, frameId);
		if (found !== null) return found;
	}
	return null;
}

/** T-4: the frame is named and attached, and the renderer still could not be reached for it. */
function unreachable(frameId: string, cause: unknown): ToolError {
	return new ToolError(
		'browser-unavailable',
		`frame ${frameId} could not be reached in this session: ${cause instanceof Error ? cause.message : String(cause)}`,
	);
}

/**
 * **Gate C of D-054.** The one handle every frame-scoped operation runs against.
 *
 * `objectId: null` means "this frame IS the session's default document" and the caller sends
 * `Runtime.evaluate` exactly as 0.2.0 does — byte for byte, including the renderer-side `timeout`.
 * Otherwise the handle is the frame's own `window`, in the frame's own main world, and the caller
 * sends `Runtime.callFunctionOn`.
 *
 * Process-ness is **measured here, now**, not remembered from a capture: `DOM.getFrameOwner` finds
 * the owner element and `DOM.describeNode({pierce: true})` either carries the child's inline
 * `contentDocument` — same process — or does not, which means the frame has moved into its own
 * renderer since the last observation. That discriminator is not invented here; the capture pipeline
 * already decides exactly this way (`extract_merge.ts:325-356`). The correction travels back on
 * `sessionId` rather than mutating a {@linkcode FrameContext} another caller is holding.
 *
 * A `DOM.resolveNode` that answers with no `objectId` is a refusal, **never** a `null` receiver:
 * `null` means "use the session's default context", and conflating "I could not get a handle" with
 * that is E-75 reintroduced through a different door. This is the single most important failure rule
 * in this module.
 *
 * **`want` chooses WHICH handle of that frame, and the choice is an authorization one (REV-1).** The
 * window is one hop past the document, through `Document.prototype.defaultView` — an **ordinary,
 * configurable accessor** in real Chromium (`configurable=true enumerable=true hasGet=true`,
 * measured), so a page that redefines it hands this server an object *it* chose. `browser_evaluate`
 * takes the hop anyway and must: a caller's expression needs the `this` `Runtime.evaluate` would have
 * given, and its ledger origin comes from {@linkcode liveFrameUrl} — the frame tree, which is
 * browser-side and beyond page script — so the swap buys a page nothing there but a differently
 * broken evaluation of its own document. `browser_get_html` asks for `'document'` and stops at the
 * handle `DOM.resolveNode` already produced, because its authorization input travels *in* the
 * extraction: `document.location` is an own **non-configurable** property of the instance (measured:
 * redefining it throws `TypeError: Cannot redefine property: location`, and patching
 * `Document.prototype` leaves it untouched because the own property wins), so an origin read off the
 * document cannot be chosen by the page. `'document'` therefore costs **one round trip fewer**, not
 * one more.
 *
 * `release()` is mandatory and belongs in a `finally` (I-FH-7, SEC-FH-9).
 */
export async function receiverFor(
	record: SessionRecord,
	frame: FrameContext,
	want: 'window' | 'document' = 'window',
): Promise<{
	objectId: string | null;
	sessionId: SessionId;
	release(): Promise<void>;
}> {
	const nothingToRelease = () => Promise.resolve();
	if (frame.isSessionDocument) return { objectId: null, sessionId: frame.sessionId, release: nothingToRelease };

	const { client, manager } = connected(record.session);
	const host = frame.sessionId;
	let documentNode: number | undefined;
	try {
		// Idempotent, and the `highlight.ts:77-78` pattern: a node cannot be addressed until the DOM
		// agent is running for the session, and enabling it twice costs nothing.
		await client.send.DOM.enable({}, host);
		const owner = await client.send.DOM.getFrameOwner({ frameId: frame.frameId }, host);
		const described = await client.send.DOM.describeNode(
			{ backendNodeId: owner.backendNodeId, depth: 1, pierce: true },
			host,
		);
		documentNode = described.node.contentDocument?.backendNodeId;
	} catch (cause) {
		throw unreachable(frame.frameId, cause);
	}
	if (documentNode === undefined) {
		// No inline document means out-of-process *now*. The frame is its own target, whose default
		// context already is its document, so the receiver is null again — but against its session.
		const child = await manager.getOrCreateCdpSession(frame.frameId as TargetId, false);
		return { objectId: null, sessionId: child.sessionId, release: nothingToRelease };
	}

	const release = async (): Promise<void> => {
		// A release that fails is not the caller's problem: the read has already answered, and a
		// renderer that went away freed the group by going away.
		try {
			await client.send.Runtime.releaseObjectGroup({ objectGroup: FRAME_OBJECT_GROUP }, host);
		} catch { /* the group went with the renderer */ }
	};
	try {
		const resolved = await client.send.DOM.resolveNode(
			{ backendNodeId: documentNode, objectGroup: FRAME_OBJECT_GROUP },
			host,
		);
		const documentObjectId = resolved.object.objectId;
		if (documentObjectId === undefined) {
			throw unreachable(frame.frameId, new Error('DOM.resolveNode returned no object handle'));
		}
		// REV-1: the caller that reads an authorization fact out of the receiver stops here. The
		// handle came from `DOM.resolveNode` on the backend node the browser pierced to, so no page
		// script stands between this server and the document it names.
		if (want === 'document') return { objectId: documentObjectId, sessionId: host, release };
		// One hop from the document to the frame's `window`, so the receiver's `this` is the same
		// `this` `Runtime.evaluate` would have given against the top document. Without it an
		// expression written as `document.title` would be reading a property of a Document.
		const windowed = await client.send.Runtime.callFunctionOn({
			functionDeclaration: 'function () { return this.defaultView; }',
			objectId: documentObjectId,
			objectGroup: FRAME_OBJECT_GROUP,
			silent: true,
		}, host);
		const objectId = windowed.result.objectId;
		if (objectId === undefined) {
			const why = windowed.exceptionDetails?.exception?.description ?? windowed.exceptionDetails?.text ??
				'the frame document has no window';
			throw unreachable(frame.frameId, new Error(why));
		}
		return { objectId, sessionId: host, release };
	} catch (cause) {
		await release();
		if (cause instanceof ToolError) throw cause;
		throw unreachable(frame.frameId, cause);
	}
}

/**
 * The session-default-document read: one `Runtime.evaluate`, as 0.2.0 sent, with the cap moved
 * **into the page** (D-057).
 *
 * The limit is interpolated, and the only thing interpolated, because it is the **server's own**
 * `HTML_LIMIT`: `browser_get_html` takes no caller JavaScript, and that non-goal is enforced by the
 * shape of these two constants rather than by review.
 */
const HTML_EXPRESSION = (limit: number) =>
	`(() => { const h = document.documentElement.outerHTML;` +
	` return { length: h.length, html: h.length > ${limit} ? h.slice(0, ${limit}) : h, origin: location.origin }; })()`;

/**
 * The child-document read: the same extraction, as a function on the frame's own **Document**.
 *
 * `limit` arrives as a `CallArgument` rather than spliced into the text, so this constant is fixed
 * at module load and there is no interpolation on the path a caller can reach at all.
 *
 * **The receiver is the Document and not its `window`, and that is the whole of REV-1's repair.**
 * `this.location` on a Document is an own, non-configurable, `[LegacyUnforgeable]` property of *that
 * instance*: it cannot be redefined, shadowed, or reached around by patching `Document.prototype`.
 * The `window` this used to run on was one page-controlled accessor away (`defaultView`), so the
 * origin Gate B′ decides from was read out of an object the page could choose — measured, on a
 * cross-origin same-process child, as a page suppressing its own ledger row and as a ledger row
 * naming an origin the browser never reported. `documentElement.outerHTML` stays exactly as
 * page-controlled as it always was, which is the honest half of the closure argument: a page forges
 * its own content, and now genuinely cannot forge the origin that content is attributed to.
 */
const HTML_FUNCTION = `function (limit) { const h = this.documentElement.outerHTML;` +
	` return { length: h.length, html: h.length > limit ? h.slice(0, limit) : h, origin: this.location.origin }; }`;

/**
 * `browser_get_html`'s read: a fixed extraction of one document, capped in the page (D-057).
 *
 * The second consumer of {@linkcode receiverFor}, and deliberately not a second mechanism (I-FH-3):
 * the frame is *found* by one mechanism — `DOM.enable`, `DOM.getFrameOwner`, `DOM.describeNode`,
 * `DOM.resolveNode`, call for call and parameter for parameter — and the two tools then diverge at
 * the handle each asks that mechanism for, which is stated as `want` and asserted as a shape rather
 * than promised. After that divergence,
 * this and {@linkcode evaluateInFrame} differ only in the function body they send and in how they
 * bound the answer. They do **not** share a cap — the HTML read caps in *characters* at the caller's
 * `limitChars`, the evaluation caps in *bytes* at {@linkcode EVALUATE_RESULT_LIMIT_BYTES}, and
 * sharing one would silently bound a 200 000-character document at 64 KiB.
 *
 * `length` is the document's **true** character count and `html` is at most `limitChars` of it, so a
 * 40 MB document never crosses the CDP channel while the honest size still does (F-3). A frame that
 * answers with anything other than that triple is `browser-unavailable` **naming the frame** — never
 * an empty success, and never the top document. An empty string comes back only when the frame
 * genuinely serialized to one.
 *
 * **Both halves of that sentence are re-established HERE, on the server, and not believed
 * (SEC-FH-24).** The in-page cap is code the page can replace: `documentElement.outerHTML` is an
 * ordinary configurable accessor, so a getter returning an object with its own `length` and `slice`
 * satisfies the extraction and chooses the payload — measured at 20 000 034 characters delivered
 * under a reported `length` of 200 001. So `html` is cut to `limitChars` by this function, out of the
 * string this function is holding, and `length` is the page's number **floored by what arrived**:
 * unchanged on every honest read, and never smaller than the payload it describes on a dishonest
 * one. The in-page slice is kept because it is still worth its bandwidth on the honest path; it is
 * simply no longer the thing that bounds anything.
 *
 * **`origin` is the third member for an authorization reason, not a provenance one (SEC-FH-17).**
 * The caller's gate needs the origin of the document that *answered*, not of the document the frame
 * tree named some round trips earlier; a frame that commits a new document in that window would
 * otherwise hand back another origin's bytes under a verdict computed from the old URL. So the
 * origin travels **with** the bytes, out of the same receiver and the same round trip, and there is
 * no window between the two to navigate in. `location.origin` is `[LegacyUnforgeable]` — a page
 * cannot shadow or redefine it — which is exactly why it, and not `document.domain` or a re-read of
 * the frame tree, is the value taken. A frame that answers without it is refused rather than read:
 * a missing authorization fact fails closed.
 *
 * **The PATH to that value is part of the claim (REV-1).** "Unforgeable" is a property of
 * `location.origin` *on the object it belongs to*, and it said nothing about how this server reached
 * that object. The same-process child path used to reach it through `Document.prototype.defaultView`,
 * an ordinary configurable accessor, so the value was genuinely unforgeable and the **receiver** was
 * not: a page that redefined `defaultView` chose the object both the bytes and the origin were read
 * out of, and a cross-origin document was measured reaching the model with its ledger row suppressed.
 * So this asks {@linkcode receiverFor} for the `'document'` — the handle `DOM.resolveNode` already
 * produced, one round trip **earlier** than the window — and reads `this.location.origin` off an own
 * non-configurable property of that instance. The out-of-process and session-document paths were
 * never exposed: their receiver is `null`, so `HTML_EXPRESSION` reads the realm's own global.
 */
export async function frameDocumentHtml(
	record: SessionRecord,
	frame: FrameContext,
	limitChars: number,
): Promise<{ length: number; html: string; origin: string }> {
	const { client } = connected(record.session);
	const receiver = await receiverFor(record, frame, 'document');
	let answered: { result: { type: string; value?: unknown }; exceptionDetails?: unknown };
	try {
		answered = receiver.objectId === null
			? await client.send.Runtime.evaluate(
				{ expression: HTML_EXPRESSION(limitChars), returnByValue: true },
				receiver.sessionId,
			)
			: await client.send.Runtime.callFunctionOn(
				{
					functionDeclaration: HTML_FUNCTION,
					objectId: receiver.objectId,
					objectGroup: FRAME_OBJECT_GROUP,
					arguments: [{ value: limitChars }],
					returnByValue: true,
					silent: true,
				},
				receiver.sessionId,
			);
	} catch (cause) {
		throw unreachable(frame.frameId, cause);
	} finally {
		// I-FH-7: released whether the read answered or threw, exactly as the evaluation path does.
		await receiver.release();
	}
	const value = answered.result.value;
	if (answered.exceptionDetails !== undefined || typeof value !== 'object' || value === null) {
		throw new ToolError('browser-unavailable', `frame ${frame.frameId} returned no document`);
	}
	const { length, html, origin } = value as { length?: unknown; html?: unknown; origin?: unknown };
	// **SEC-FH-24: this is the trust boundary, and everything above it is the page's arithmetic.**
	// `html` is whatever the page's `outerHTML` getter let `slice` return, and `length` is whatever
	// its `length` getter said — `typeof html === 'string'` is the only statement about the bytes the
	// server can make on its own authority, and a non-string is the structured refusal below, thrown
	// before any caller can be handed a byte. `length` is checked for the *shape* of a character
	// count rather than merely for `typeof number`, because `NaN`, `Infinity` and `-1` are all
	// numbers and none of them is one: an unmeasurable count has no honest value to put on the wire
	// (`length` is declared `z.number().int()`), so it fails closed like every other missing fact.
	if (
		typeof length !== 'number' || typeof html !== 'string' || typeof origin !== 'string' ||
		!Number.isSafeInteger(length) || length < 0
	) {
		throw new ToolError('browser-unavailable', `frame ${frame.frameId} returned no document`);
	}
	// ---- below this line the server measures; the page's numbers are never the answer ----
	const received = html.length;
	return {
		// **The re-clamp.** The in-page slice stays exactly what D-057 made it — the bandwidth
		// optimisation that keeps an honest 40 MB document off the CDP channel — and stops being
		// mistaken for the control it never was: whatever actually arrived is cut here, by this
		// process, out of the string this process is holding. A page that ignores `limitChars`
		// therefore spends its own bandwidth and changes nothing the caller receives.
		html: received > limitChars ? html.slice(0, limitChars) : html,
		// `length` is the document's TRUE character count where the page reports one truthfully
		// (F-3), **floored by what actually arrived**. An honest renderer always reports
		// `length >= html.length`, because its `html` is a slice of the document it just measured —
		// so on every honest read this is the page's own number, unchanged. A page that under-reports
		// to make an over-limit payload look bounded gets its claim replaced by the server's
		// measurement, and `length` then means "at least this many characters actually arrived". The
		// one thing it can never be is smaller than the payload it describes, which is the whole of
		// what made `truncated` a false statement.
		length: Math.max(length, received),
		origin,
	};
}

/**
 * Refuses a secret-bearing action while the visual viewport is scaled — **SEC-24's one required
 * control**.
 *
 * The DOM merge takes scroll from `cssLayoutViewport` (`extract_capture.ts:244,254-256`) while the
 * action path takes it from `cssVisualViewport` (`default_action_geometry.ts:67-82`). Under a page
 * scale other than 1 the two diverge and a click point is computed from mixed coordinate spaces. A
 * mis-landed *ordinary* click is a correctness defect this delivery deliberately defers; a
 * mis-landed **credential** is not something to leave to a deferral, so the two must not meet.
 *
 * The guard is a read the code already performs — `Page.getLayoutMetrics` is typed and already
 * called — and it applies to both secret-bearing paths: this tool and `browser_type` when it
 * substitutes a `<secret>` placeholder.
 *
 * A metrics read that fails is **not** treated as scale 1. It is a refusal, because "I could not
 * check" and "it is safe" are different statements and only one of them is true.
 */
export async function assertUnitViewportScale(record: SessionRecord): Promise<number> {
	const { client, manager, focus } = connected(record.session);
	let scale: number;
	try {
		const page = await manager.getOrCreateCdpSession(focus, true);
		const metrics = await client.send.Page.getLayoutMetrics({}, page.sessionId);
		scale = metrics.cssVisualViewport?.scale ?? metrics.visualViewport.scale;
	} catch (cause) {
		throw new ToolError(
			'browser-unavailable',
			`the visual viewport scale could not be read, so a secret-bearing action is refused: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			{ reason: 'viewport-scaled' },
		);
	}
	if (scale !== 1) {
		throw new ToolError(
			'browser-unavailable',
			`the visual viewport is scaled (${scale}); a secret-bearing action is refused because the layout and ` +
				'visual viewport scroll sources diverge under zoom and the value could land on another element',
			{ reason: 'viewport-scaled' },
		);
	}
	return scale;
}

/** What one bounded evaluation answered. */
export interface EvaluationResult {
	readonly frameId: string;
	/** False when the expression threw. A page exception is a fact about the page, not a tool failure. */
	readonly ok: boolean;
	/** The `RemoteObject` type, so a caller can tell `undefined` from a missing value. */
	readonly type: string;
	/** The JSON-serializable result, absent when the expression threw or returned nothing serializable. */
	readonly value?: unknown;
	/** True when {@linkcode EVALUATE_RESULT_LIMIT_BYTES} bound the answer. */
	readonly truncated: boolean;
	/** The page's own exception message, truncated. Absent on success. */
	readonly errorText?: string;
	/** Bytes of the serialized result after the cap — what the audit ledger records. */
	readonly resultBytes: number;
}

/**
 * Evaluates one expression in a frame's own main world, bounded in time and in result size.
 *
 * Main world rather than an isolated one (AD-5, `report_architecture.md` §7.6): an isolated world
 * cannot see page globals, and reading a value the element tree does not expose is the entire stated
 * use case. The tamper-resistance an isolated world buys would guard a result that is untrusted page
 * data either way, so it is not a security control here — and describing it as one would be the same
 * category error the expression-subset idea was rejected for.
 *
 * `silent: true` so an exception does not pause a debugger a deployment may have attached;
 * `awaitPromise: true` so an `async` expression answers with its value rather than with a pending
 * promise; `returnByValue: true` so the result arrives as data rather than as a handle this server
 * would then have to release.
 *
 * **ERRATUM(E-75): which document.** The evaluation goes to the receiver {@linkcode receiverFor}
 * produced, never to a bare session. For the focused document and for an out-of-process frame that
 * receiver is `null` and this is the 0.2.0 call unchanged; for a same-process child frame it is a
 * handle on the child's own `window`, and until this repair the receiver-less `Runtime.evaluate`
 * landed in the **host** document while reporting the child's `frame_id`. Two consequences of
 * `Runtime.callFunctionOn` apply on that one path and are announced in the tool description rather
 * than discovered: the caller's text is compiled as an **expression** and not as a multi-statement
 * program, and the call carries **no renderer-side `timeout`** — the 1 s cap is the server's own
 * deadline alone (RR-1, accepted).
 */
export async function evaluateInFrame(
	record: SessionRecord,
	options: { expression: string; frame: FrameContext; timeoutMs: number },
): Promise<EvaluationResult> {
	const { client } = connected(record.session);
	const timeout = Math.min(Math.max(options.timeoutMs, 1), EVALUATE_TIMEOUT_MS_MAX);
	const receiver = await receiverFor(record, options.frame);
	const started = Date.now();
	let answered: {
		result: { type: string; value?: unknown };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	};
	try {
		answered = await withDeadline(
			receiver.objectId === null
				? client.send.Runtime.evaluate(
					{
						expression: options.expression,
						returnByValue: true,
						awaitPromise: true,
						silent: true,
						timeout,
					},
					receiver.sessionId,
				)
				: client.send.Runtime.callFunctionOn(
					{
						// The trailing newline closes the "expression ending in a line comment" case. It is a
						// correctness guard and not a parser, and certainly not a security control: the
						// containment is the `evaluate` scope and nothing else (D-A4, SEC-FH-3).
						functionDeclaration: `async function () { return (${options.expression}\n); }`,
						objectId: receiver.objectId,
						objectGroup: FRAME_OBJECT_GROUP,
						returnByValue: true,
						awaitPromise: true,
						silent: true,
					},
					receiver.sessionId,
				),
			timeout + EVALUATE_GRACE_MS,
		);
	} catch (cause) {
		if (cause instanceof ToolError) throw cause;
		const message = cause instanceof Error ? cause.message : String(cause);
		// **Classified by what we asked for, not by what the browser called it** — measured on the
		// browser tier, where a 30 s busy loop under a 1 s `timeout` came back in 1029 ms as
		// `CDP error -32603: Internal error`. Chromium terminates the execution correctly and then
		// reports the termination through the generic internal-error channel, with no word a message
		// match could find; the first version of this code matched on the text and answered
		// `browser-unavailable`, which is a lie about a browser that is fine and about a cap that
		// worked. So an evaluation that failed at or after its own deadline is a `timeout`, and only
		// a failure that arrived *sooner* than the deadline can be anything else.
		if (Date.now() - started >= timeout || /timeout|timed out|terminated/i.test(message)) {
			throw new ToolError('timeout', `the expression did not finish within ${timeout} ms`);
		}
		throw new ToolError('browser-unavailable', message);
	} finally {
		// I-FH-7: released whether the evaluation answered, threw, or blew its deadline. An object left
		// in the group is a Chromium-side allocation nobody frees.
		await receiver.release();
	}

	const details = answered.exceptionDetails;
	if (details !== undefined) {
		const text = details.exception?.description ?? details.text ?? 'the expression threw';
		return {
			frameId: options.frame.frameId,
			ok: false,
			type: answered.result.type,
			truncated: false,
			errorText: text.slice(0, EVALUATE_ERROR_TEXT_CHARS),
			resultBytes: 0,
		};
	}

	const capped = capValue(answered.result.value);
	return {
		frameId: options.frame.frameId,
		ok: true,
		type: answered.result.type,
		truncated: capped.truncated,
		resultBytes: capped.bytes,
		...(capped.present ? { value: capped.value } : {}),
	};
}

/**
 * Bounds the result the caller is handed.
 *
 * An availability and context-cost control, never a confidentiality one (SEC-23): it bounds what
 * comes back *through the tool result* and bounds nothing about what left through the page's own
 * network. Over the cap the value is replaced by its serialized prefix as a string, with
 * `truncated: true` on the wire, so the cut is visible rather than silent — the same choice
 * `browser_get_state`'s `page` truncation makes.
 */
function capValue(value: unknown): { present: boolean; value?: unknown; truncated: boolean; bytes: number } {
	if (value === undefined) return { present: false, truncated: false, bytes: 0 };
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? 'null';
	} catch {
		// A value the renderer serialized but this process cannot (a cycle reconstructed as one) is
		// reported as absent rather than as an error: the expression ran, and saying so is the answer.
		return { present: false, truncated: true, bytes: 0 };
	}
	const bytes = new TextEncoder().encode(serialized).length;
	if (bytes <= EVALUATE_RESULT_LIMIT_BYTES) return { present: true, value, truncated: false, bytes };
	const cut = serialized.slice(0, EVALUATE_RESULT_LIMIT_BYTES);
	return { present: true, value: cut, truncated: true, bytes: new TextEncoder().encode(cut).length };
}

/** Rejects with a `timeout` tool error when `work` has not settled in `ms`. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new ToolError('timeout', `the browser did not answer within ${ms} ms`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
