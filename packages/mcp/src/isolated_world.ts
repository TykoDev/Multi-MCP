/**
 * Per-frame isolated JavaScript worlds, for the reads page script must not be able to answer (A1, A2).
 *
 * Two questions this server asks a page are authorization-relevant and are answered by DOM getters: which
 * element a pseudo-element belongs to (`CSSPseudoElement.prototype.element`, the hit test) and which element
 * has focus (`Document.prototype.activeElement`, the secret pin). In the page's **main** world both are
 * ordinary configurable accessors, so a page can make them lie. Measured on real Chromium (W1 probe,
 * 2026-10-04): with `CSSPseudoElement.prototype.element` redefined in the main world, the main-world read named
 * the element the page chose for three different pseudo-elements, while the same read from a
 * `Page.createIsolatedWorld` context named the true element every time. An isolated world shares the DOM and
 * nothing else — its prototypes are its own — so it is where these reads happen.
 *
 * **A context id names a context only inside one renderer process.** CDP numbers execution contexts per
 * process and documents that `contextId` "may be reused across processes". A page target's CDP session and its
 * main-frame id both survive a cross-site navigation, so an id remembered for (session, frame) can name, after
 * one, whichever context of the NEW process holds that number — measured on Chromium 154 through this server
 * (`tests/e2e/secret_focus_e2e_test.ts`, review R3-2): a cached world's id resolved, without any error, to a
 * lying page's main world, the focus walk followed the lie into another site's frame, and a secret pinned to
 * that site was typed into the lying page. ERRATUM(E-93): D-096's "one world per (session, frame), cached,
 * recreated once if stale" assumed a stale id fails; it does not. Two consequences, one per caller:
 *
 * - **The secret pin never reuses a world** ({@linkcode inFreshIsolatedWorld}): one `Page.createIsolatedWorld`
 *   per read, so the id is at most one round trip old when it is used.
 * - **The hit test keeps a cache, but every cached world is branded** ({@linkcode inIsolatedWorld}): at
 *   creation a random property name holding a random value is defined on the new world's global, and every read
 *   verifies the brand in the SAME evaluation as the read itself (`brandGuard`). A main world never saw the
 *   pair, so it cannot answer for it; a mismatch drops the entry and the read is retried once against a fresh,
 *   freshly branded world. Keying the cache on the frame's loader id instead would add a frame-tree round trip
 *   to every read and still leave the window between that read and the evaluation.
 *
 * What remains is the round trip between `Page.createIsolatedWorld` answering and the first use of its id (for
 * a branded world, the branding call): a cross-process navigation landing exactly inside it. That is the same
 * window every element-targeted action has between resolving and dispatching.
 */
import type { BrowserSession } from '@tykotech/browser';
import type { SessionId } from '@tykotech/cdp';
import type { SessionRecord } from './registry.ts';

/** The world's name, visible in DevTools; one name for every frame. */
export const ISOLATED_WORLD_NAME = 'ttk-isolated';

/** Cached contexts per record before the cache is dropped and rebuilt — a bound, not a tuning knob. */
const MAX_CACHED_WORLDS = 64;

/** The connected CDP client a record's session holds. */
type Client = NonNullable<BrowserSession['cdpClient']>;

/** The message a {@linkcode brandGuard} throws, so a mismatch is told apart from any other failed read. */
export const WORLD_MISMATCH = 'ttk-isolated-world-mismatch';

/** The unguessable pair a cached world carries on its global (see the module comment). */
export interface WorldBrand {
	/** A property name on the world's global; random per world. */
	readonly key: string;
	/** Its value; random per world. */
	readonly nonce: string;
}

/** A cached world: the id to evaluate in, and the brand that proves the id still names it. */
export interface BrandedWorld {
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

/**
 * Runs `read` against the cached, branded isolated world of `frameId`, created on first use.
 *
 * `read` must verify the brand inside its own evaluation ({@linkcode BRAND_GUARD} with
 * {@linkcode brandArguments}) and throw {@linkcode StaleWorldError} on a mismatch, and it must be safe to run
 * twice: any failure against a cached world — gone, or not the world it was — drops the entry and re-runs
 * `read` once against a fresh one. A failure against a fresh world is the caller's to classify.
 */
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
