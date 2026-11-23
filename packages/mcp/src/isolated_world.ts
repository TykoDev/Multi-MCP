/** Per-frame isolated JavaScript worlds, for the reads page script must not be able to answer. */
import type { BrowserSession } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import type { SessionRecord } from './registry.ts';
import { ToolError } from './errors.ts';
import type { FrameContext } from './page_eval.ts';

/** The world's name, visible in DevTools; one name for every frame. */
const ISOLATED_WORLD_NAME = 'ttk-isolated';

/** Cached contexts per record before the cache is dropped and rebuilt — a bound, not a tuning knob. */
const MAX_CACHED_WORLDS = 64;

/** The connected CDP client a record's session holds. */
type Client = NonNullable<BrowserSession['cdpClient']>;

/** The message a {@linkcode BRAND_GUARD} throws, so a mismatch is told apart from any other failed read. */
const WORLD_MISMATCH = 'ttk-isolated-world-mismatch';

/** The unguessable pair a cached world carries on its global (see the module comment). */
interface WorldBrand {
	/** A property name on the world's global; random per world. */
	readonly key: string;
	/** Its value; random per world. */
	readonly nonce: string;
}

/** A cached world: the id to evaluate in, and the brand that proves the id still names it. */
interface BrandedWorld {
	readonly contextId: number;
	readonly brand: WorldBrand;
}

/**
 * A statement for the top of a function evaluated with `Runtime.callFunctionOn`, whose first two parameters are
 * named `brandKey` and `brandNonce` and receive {@linkcode brandArguments}: it throws {@linkcode WORLD_MISMATCH}
 * unless the function runs in the world the brand was made for.
 */
export const BRAND_GUARD = `if (globalThis[brandKey] !== brandNonce) throw new Error(${
	JSON.stringify(WORLD_MISMATCH)
});`;

/** The `Runtime.callFunctionOn` arguments that feed {@linkcode BRAND_GUARD}. */
export function brandArguments(brand: WorldBrand): Array<{ value: string }> {
	return [{ value: brand.key }, { value: brand.nonce }];
}

/** True when an evaluation's exception is {@linkcode BRAND_GUARD}'s, not the read's own. */
export function isWorldMismatch(
	exception: { text?: string; exception?: { description?: string } } | undefined,
): boolean {
	if (exception === undefined) return false;
	return `${exception.text ?? ''} ${exception.exception?.description ?? ''}`.includes(WORLD_MISMATCH);
}

/** Thrown by a read whose world turned out not to be the one it was branded for; the cache retries once. */
export class StaleWorldError extends Error {
	constructor() {
		super('the isolated world this read was sent to is no longer the one it was created as');
		this.name = 'StaleWorldError';
	}
}

/** 128 bits from the platform CSPRNG, as hex. */
function randomHex(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
}

async function createWorld(client: Client, sessionId: SessionId, frameId: string): Promise<number> {
	const world = await client.send.Page.createIsolatedWorld({ frameId, worldName: ISOLATED_WORLD_NAME }, sessionId);
	return world.executionContextId;
}

/**
 * Runs `read` once against a world created for this read alone, in `frameId` — the secret pin's path, where no
 * id outlives the read that uses it. A failure is the caller's to classify; nothing is retried.
 */
export async function inFreshIsolatedWorld<T>(
	client: Client,
	sessionId: SessionId,
	frameId: string,
	read: (contextId: number) => Promise<T>,
): Promise<T> {
	return await read(await createWorld(client, sessionId, frameId));
}

const worlds = new WeakMap<SessionRecord, Map<string, BrandedWorld>>();

/** Creates a world and defines its brand, non-writable and non-enumerable, on the world's own global. */
async function brandedWorld(client: Client, sessionId: SessionId, frameId: string): Promise<BrandedWorld> {
	const contextId = await createWorld(client, sessionId, frameId);
	const brand: WorldBrand = { key: `__ttk_${randomHex()}`, nonce: randomHex() };
	const branded = await client.send.Runtime.evaluate({
		expression: `Object.defineProperty(globalThis, ${JSON.stringify(brand.key)}, { value: ${
			JSON.stringify(brand.nonce)
		} }), true`,
		contextId,
		silent: true,
		returnByValue: true,
	}, sessionId);
	if (branded.exceptionDetails !== undefined || branded.result.value !== true) {
		throw new Error('the isolated world could not be branded');
	}
	return { contextId, brand };
}

/** Runs `read` against the cached, branded isolated world of `frameId`, created on first use. */
export async function inIsolatedWorld<T>(
	record: SessionRecord,
	client: Client,
	sessionId: SessionId,
	frameId: string,
	read: (world: BrandedWorld) => Promise<T>,
): Promise<T> {
	let cache = worlds.get(record);
	if (cache === undefined) {
		cache = new Map();
		worlds.set(record, cache);
	}
	const key = `${sessionId}\n${frameId}`;
	const cached = cache.get(key);
	if (cached !== undefined) {
		try {
			return await read(cached);
		} catch {
			// The document this world lived in is gone, or the id now names another world (a cross-process
			// navigation): a fresh world answers either. A failure that is not about the world fails again below.
			cache.delete(key);
		}
	}
	const world = await brandedWorld(client, sessionId, frameId);
	if (cache.size >= MAX_CACHED_WORLDS) cache.clear();
	cache.set(key, world);
	return await read(world);
}

// --- The frame that holds keyboard focus, read live from the browser. --------------------------------------------

/** Frame boundaries the walk descends at most; a deeper nesting is refused rather than cut short. */
const FOCUS_MAX_DESCENT = 8;

/** Object group for the handles the walk allocates, released per document. */
const FOCUS_OBJECT_GROUP = 'ttk-focus';

/** Elements that own a nested browsing context when they have one. */
const FRAME_OWNER_NAMES: ReadonlySet<string> = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FENCEDFRAME', 'PORTAL']);

/** Evaluated in the isolated world: the document's active element, followed into open shadow roots. */
const ACTIVE_ELEMENT_EXPRESSION = '(() => { let el = document.activeElement; ' +
	'while (el !== null && el.shadowRoot !== null && el.shadowRoot.activeElement !== null) ' +
	'el = el.shadowRoot.activeElement; return el; })()';

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

/** The frame owner focus went into from this document, or `null` when focus stops here. */
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
				// whose content is not a frame this server can see).
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
