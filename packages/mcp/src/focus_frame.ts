/**
 * The frame that holds keyboard focus, read live from the browser (A2, D-096).
 *
 * `browser_type` without an `index` types at whatever has focus, and a `<secret>` placeholder in that text is
 * pinned to an origin before the keystrokes go out. That origin must be the **focused element's frame**, not
 * the top document's: a page can put a cross-origin frame around the field the keystrokes will land in, and
 * the top URL would still look like the bank (SEC-07's frameset case, closed for `browser_fill_secret` in
 * B2.8 and left open on this path until D-096).
 *
 * The walk asks each document for its `activeElement`, from top to the frame focus is in: a **frame owner**
 * that is its document's active element is the one focus went into. A frame owner is any element the browser
 * describes with a `frameId` or a `contentDocument` — `<iframe>` and `<frame>`, and equally `<object>` and
 * `<embed>` showing a document (review R3-1: measured on Chromium 154, a click inside a cross-origin
 * `<object type=text/html>` or `<embed>` leaves the top `activeElement` on that element and sends keystrokes to
 * the embedded document, which a walk that knew only `IFRAME`/`FRAME` pinned to the top). The tag names are
 * kept only to refuse a frame-owner element the browser gives no frame for: focus on one is focus whose
 * document cannot be named, and is refused rather than pinned to the document around it.
 *
 * Every read is made in a **fresh** isolated world of the frame (`isolated_world.ts`) —
 * `Document.prototype.activeElement` is an ordinary configurable accessor in the page's own world, and a page
 * that could answer this question could choose the origin its credential is checked against; a world is never
 * reused, because a context id remembered across a cross-process navigation can name that page's main world
 * (review R3-2). The frame ids come from `DOM.describeNode`, which is the browser's, not the page's. Open
 * shadow roots are descended (`activeElement` is retargeted to their host); a **closed** one cannot be, so a
 * focused closed-shadow host whose shadow tree holds a frame owner of any kind is refused rather than guessed at.
 *
 * The answer is a statement about focus *now*. A page can still move focus between this read and the
 * keystrokes — the same window every element-targeted action has between resolving and dispatching — and the
 * pin it is checked against is the frame focus was in when the server looked.
 */
import type { BrowserSession } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import { inFreshIsolatedWorld } from './isolated_world.ts';
import type { FrameContext } from './page_eval.ts';
import type { SessionRecord } from './registry.ts';

/** Frame boundaries the walk descends at most; a deeper nesting is refused rather than cut short. */
export const FOCUS_MAX_DESCENT = 8;

/** Object group for the handles the walk allocates, released per document. */
const FOCUS_OBJECT_GROUP = 'ttk-focus';

/**
 * Elements that own a nested browsing context when they have one. Only used to refuse such an element when the
 * browser reports NO frame for it; whether an element is a frame boundary is decided by `frameId` /
 * `contentDocument`, never by this list.
 */
const FRAME_OWNER_NAMES: ReadonlySet<string> = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FENCEDFRAME', 'PORTAL']);

/**
 * Evaluated in the isolated world: the document's active element, followed into open shadow roots.
 * Answers `null` when nothing is focused.
 */
const ACTIVE_ELEMENT_EXPRESSION = '(() => { let el = document.activeElement; ' +
	'while (el !== null && el.shadowRoot !== null && el.shadowRoot.activeElement !== null) ' +
	'el = el.shadowRoot.activeElement; return el; })()';

type Client = NonNullable<BrowserSession['cdpClient']>;

/** `DOM.Node` as `DOM.describeNode` returns it (the cdp barrel does not export the type by name). */
type DomNode = Awaited<ReturnType<Client['send']['DOM']['describeNode']>>['node'];

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

/** True when the browser describes `node` as owning a frame: it reports the frame's id or its document. */
function ownsFrame(node: DomNode): boolean {
	return node.frameId !== undefined || node.contentDocument !== undefined;
}

/** True when a described subtree holds a frame owner anywhere, closed shadow roots included. */
function holdsFrame(node: DomNode): boolean {
	if (ownsFrame(node) || FRAME_OWNER_NAMES.has(node.nodeName)) return true;
	for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
		if (holdsFrame(child)) return true;
	}
	return false;
}

/** The refusal for focus the walk can see is in a frame, but cannot follow into it. */
function unenterable(what: string): ToolError {
	return new ToolError(
		'navigation-blocked',
		`focus is inside ${what}, so the frame a secret would be typed into cannot be determined; pass index to ` +
			'name the field',
	);
}

/**
 * The frame owner focus went into from this document, or `null` when focus stops here.
 *
 * `inProcess` is measured, not remembered: `DOM.describeNode({pierce: true})` carries the child's
 * `contentDocument` only when the child renders in this same process (the discriminator `receiverFor`
 * and the capture pipeline already use).
 */
async function focusedOwner(
	client: Client,
	sessionId: SessionId,
	frameId: string,
): Promise<{ frameId: string; inProcess: boolean } | null> {
	return await inFreshIsolatedWorld(client, sessionId, frameId, async (contextId) => {
		try {
			const active = await client.send.Runtime.evaluate(
				{ expression: ACTIVE_ELEMENT_EXPRESSION, contextId, objectGroup: FOCUS_OBJECT_GROUP, silent: true },
				sessionId,
			);
			const objectId = active.result.objectId;
			if (active.exceptionDetails !== undefined) throw new Error('the active element could not be read');
			if (objectId === undefined) return null;
			const described = await client.send.DOM.describeNode({ objectId, depth: 1, pierce: true }, sessionId);
			const node = described.node;
			if (node.frameId !== undefined) {
				return { frameId: node.frameId, inProcess: node.contentDocument !== undefined };
			}
			if (ownsFrame(node) || FRAME_OWNER_NAMES.has(node.nodeName)) {
				// A frame owner the browser names no frame for (a document without an id, an `<object>` or `<embed>`
				// whose content is not a frame this server can see). Its content cannot be named, and the document
				// around it is not where the keystrokes go.
				throw unenterable(`a <${node.nodeName.toLowerCase()}> whose frame the browser does not name`);
			}
			if ((node.shadowRoots ?? []).some((root) => root.shadowRootType === 'closed')) {
				const deep = await client.send.DOM.describeNode({ objectId, depth: -1, pierce: true }, sessionId);
				if (holdsFrame(deep.node)) {
					throw new ToolError(
						'navigation-blocked',
						'focus is on an element whose closed shadow root holds a frame, so the frame a secret would be ' +
							'typed into cannot be determined; pass index to name the field',
					);
				}
			}
			return null;
		} finally {
			await client.send.Runtime.releaseObjectGroup({ objectGroup: FOCUS_OBJECT_GROUP }, sessionId).catch(() => {});
		}
	});
}

/**
 * The frame that has keyboard focus in the session's focused tab, as a {@linkcode FrameContext} whose
 * `sessionId` is the session that hosts the frame — so `liveFrameUrl` reads its URL from the right tree.
 *
 * @throws ToolError `browser-unavailable` when the session is not connected or the top document cannot be read;
 * `navigation-blocked` when the focused frame cannot be determined (a frame owner whose frame cannot be named,
 * attached to or read, a closed shadow root holding a frame, or nesting beyond {@linkcode FOCUS_MAX_DESCENT}).
 */
export async function focusedFrame(record: SessionRecord): Promise<FrameContext> {
	const { client, manager, focus } = connected(record.session);
	let descended = false;
	try {
		const page = await manager.getOrCreateCdpSession(focus, true);
		let sessionId = page.sessionId;
		const { frameTree } = await client.send.Page.getFrameTree({}, sessionId);
		let frameId = frameTree.frame.id;
		let isOopif = false;
		for (let depth = 0; depth <= FOCUS_MAX_DESCENT; depth++) {
			const owner = await focusedOwner(client, sessionId, frameId);
			if (owner === null) {
				const isTop = depth === 0;
				return { frameId, sessionId, isOopif, named: true, isTop, isSessionDocument: isTop || isOopif };
			}
			descended = true;
			if (!owner.inProcess) {
				// Out of process: the frame is its own target, and Chrome uses the frame id as the target id. A
				// frame that cannot be attached to is one whose document cannot be read — refused, never the outer.
				try {
					sessionId = (await manager.getOrCreateCdpSession(owner.frameId as TargetId, false)).sessionId;
				} catch {
					throw unenterable('an out-of-process frame this server cannot attach to');
				}
				isOopif = true;
			} else {
				isOopif = false;
			}
			frameId = owner.frameId;
		}
	} catch (cause) {
		if (cause instanceof ToolError) throw cause;
		const detail = cause instanceof Error ? cause.message : String(cause);
		// Past the top document every failure is about a frame focus went into: its document could not be read,
		// so the frame cannot be named — refused as such, not reported as a browser fault the caller might retry
		// around by typing anyway.
		if (descended) throw unenterable(`a frame whose document could not be read (${detail})`);
		throw new ToolError('browser-unavailable', `the focused frame could not be read: ${detail}`);
	}
	throw new ToolError(
		'navigation-blocked',
		`focus is nested more than ${FOCUS_MAX_DESCENT} frames deep; pass index to name the field`,
	);
}
