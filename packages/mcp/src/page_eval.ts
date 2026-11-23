/**
 * The frame's own JavaScript context: which CDP session owns a frame, what that frame's URL is *right now*, whether
 * the visual viewport is scaled, and the bounded evaluation itself.
 */
import type { BrowserSession } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import type { SessionRecord } from './registry.ts';

/** The evaluation deadline, in milliseconds, and its ceiling — the same number. */
export const EVALUATE_TIMEOUT_MS_DEFAULT = 1000;
export const EVALUATE_TIMEOUT_MS_MAX = 1000;

/** Extra milliseconds the server waits beyond the renderer's own deadline before giving up. */
const EVALUATE_GRACE_MS = 250;

/** Bytes of serialized result carried back to the caller. Beyond this the answer says it was cut. */
export const EVALUATE_RESULT_LIMIT_BYTES = 64 * 1024;

/** Characters of the page's own exception message carried back. */
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

/** The object group every frame-scoped `RemoteObject` this module allocates belongs to. */
const FRAME_OBJECT_GROUP = 'ttk-frame';

/** A frame resolved to the CDP session that can speak for it **and** to the document it names. */
export interface FrameContext {
	/** The frame id, as the capture and `browser_get_frames` spell it. */
	readonly frameId: string;
	/** The CDP session to send `Runtime.*` and `Page.*` to for this frame. */
	readonly sessionId: SessionId;
	/** True when the frame is its own process and therefore its own target. */
	readonly isOopif: boolean;
	/** Did the caller supply a `frame_id` at all? */
	readonly named: boolean;
	/** Is this the top document of the focused tab? */
	readonly isTop: boolean;
	/**
	 * True when `sessionId`'s DEFAULT execution context already **is** this frame's document: the focused tab's top
	 * document, and every out-of-process frame (its own target, rooted at itself).
	 */
	readonly isSessionDocument: boolean;
}

/** Resolves a frame id to the CDP session that owns it — **Gate A, and only Gate A**. */
export async function frameContext(record: SessionRecord, frameId?: string): Promise<FrameContext> {
	const session = record.session;
	const { manager, focus } = connected(session);
	const frames = session.cachedBrowserState?.frames ?? [];
	// Two facts, not one. `named` is about the CALLER — did an id arrive — and `isTop` is about the DOCUMENT.
	const named = frameId !== undefined;
	// **An invariant, named and asserted.** `isTop` is the one fact on this path taken from cached state while
	// everything beside it is read live, and it suppresses *both* origin gates: a frame that is wrongly `isTop` is
	// read with no scope check and no ledger row.
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
	// A same-process child: the host page's session speaks for this frame, but its default execution
	// context is the host's OWN document, not this one — UNLESS the id names the top document itself,
	// where the two are the same document and a receiver-less call is correct.
	return { frameId, sessionId: page.sessionId, isOopif: false, named, isTop, isSessionDocument: isTop };
}

/** The frame's URL **as the browser holds it now**, not as a capture remembered it. */
export async function liveFrameUrl(record: SessionRecord, frame: FrameContext): Promise<string> {
	const tree = await frameTreeOf(record, frame.sessionId);
	const found = findFrame(tree, frame.frameId);
	if (found === null) {
		throw new ToolError('invalid-arguments', `frame ${frame.frameId} is no longer attached to this session`);
	}
	return found;
}

/** The frame's live URL **and** the top document's, from as few reads as the frame tree allows. */
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
	// A named id — the root's included — is searched for in the tree already read.
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

/** The frame is named and attached, and the renderer still could not be reached for it. */
function unreachable(frameId: string, cause: unknown): ToolError {
	return new ToolError(
		'browser-unavailable',
		`frame ${frameId} could not be reached in this session: ${cause instanceof Error ? cause.message : String(cause)}`,
	);
}

/** **Gate C.** The one handle every frame-scoped operation runs against. */
async function receiverFor(
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
		// Idempotent, as in the live-view highlight: a node cannot be addressed until the DOM
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
		// The caller that reads an authorization fact out of the receiver stops here.
		if (want === 'document') return { objectId: documentObjectId, sessionId: host, release };
		// One hop from the document to the frame's `window`, so the receiver's `this` is the same
		// `this` `Runtime.evaluate` would have given against the top document.
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

/** The session-default-document read: one `Runtime.evaluate`, with the cap applied **in the page**. */
const HTML_EXPRESSION = (limit: number) =>
	`(() => { const h = document.documentElement.outerHTML;` +
	` return { length: h.length, html: h.length > ${limit} ? h.slice(0, ${limit}) : h, origin: location.origin }; })()`;

/** The child-document read: the same extraction, as a function on the frame's own **Document**. */
const HTML_FUNCTION = `function (limit) { const h = this.documentElement.outerHTML;` +
	` return { length: h.length, html: h.length > limit ? h.slice(0, limit) : h, origin: this.location.origin }; }`;

/** `browser_get_html`'s read: a fixed extraction of one document, capped in the page. */
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
		// Released whether the read answered or threw, exactly as the evaluation path does.
		await receiver.release();
	}
	const value = answered.result.value;
	if (answered.exceptionDetails !== undefined || typeof value !== 'object' || value === null) {
		throw new ToolError('browser-unavailable', `frame ${frame.frameId} returned no document`);
	}
	const { length, html, origin } = value as { length?: unknown; html?: unknown; origin?: unknown };
	// **This is the trust boundary, and everything above it is the page's arithmetic.** `html` is whatever the page's
	// `outerHTML` getter let `slice` return, and `length` is whatever its `length` getter said —
	// `typeof html === 'string'` is the only statement about the bytes the server can make on its own authority, and
	// a non-string is the structured refusal below, thrown before any caller can be handed a byte.
	if (
		typeof length !== 'number' || typeof html !== 'string' || typeof origin !== 'string' ||
		!Number.isSafeInteger(length) || length < 0
	) {
		throw new ToolError('browser-unavailable', `frame ${frame.frameId} returned no document`);
	}
	// ---- below this line the server measures; the page's numbers are never the answer ----
	const received = html.length;
	return {
		// **The re-clamp.** The in-page slice is a bandwidth optimisation that keeps an honest 40 MB document off the
		// CDP channel, not a control: whatever actually arrived is cut here, by this process, out of the string this
		// process is holding.
		html: received > limitChars ? html.slice(0, limitChars) : html,
		// `length` is the document's TRUE character count where the page reports one truthfully **floored by what
		// actually arrived**.
		length: Math.max(length, received),
		origin,
	};
}

/**
 * Refuses a secret-bearing action while the visual viewport is scaled — **the one required control against a
 * mis-landed credential**.
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
interface EvaluationResult {
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

/** Evaluates one expression in a frame's own main world, bounded in time and in result size. */
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
						// The trailing newline closes the "expression ending in a line comment" case.
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
		// **Classified by what we asked for, not by what the browser called it** — measured on the browser tier,
		// where a 30 s busy loop under a 1 s `timeout` came back in 1029 ms as `CDP error -32603: Internal error`.
		if (Date.now() - started >= timeout || /timeout|timed out|terminated/i.test(message)) {
			throw new ToolError('timeout', `the expression did not finish within ${timeout} ms`);
		}
		throw new ToolError('browser-unavailable', message);
	} finally {
		// Released whether the evaluation answered, threw, or blew its deadline. An object left
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

/** Bounds the result the caller is handed. */
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
