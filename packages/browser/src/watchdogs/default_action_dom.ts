/**
 * @module
 * Shared CDP primitives for the interaction watchdogs: resolve a node to a JS object, run a function
 * with `this` bound to it, evaluate an expression in a page session, and read the element facts every
 * cascade branches on.
 *
 * Contract owners: SPECS/ARCHITECTURE.md §6.10 (DefaultActionWatchdog — the click/type/scroll/dropdown
 * cascades all start here), §7.2 (the typed `client.send.Domain.method(params, sessionId)` surface),
 * SPECS/DATA-MODEL.md §6.1 (`backendNodeId` is *the* action handle) and §6.3 R6.3 ("stale-id CDP
 * errors mean 'rebuild state', not crash").
 *
 * Everything here is deliberately session-scoped: a `backendNodeId` is only meaningful in the session
 * it was captured from, so every helper takes the session id explicitly rather than reaching for a
 * "current" one. The SessionManager stays the sole owner of *which* session that is
 * (ARCHITECTURE.md §7.3).
 */

import type { CdpClient, SessionId } from '@tykotech/cdp';
import { BrowserError } from '../errors.ts';
import type { EnhancedDomTreeNode } from '../dom/types.ts';

/**
 * Failure of a synthesized interaction. Never a bare string (AGENTS.md §3).
 *
 * Expected, agent-recoverable failures are returned as `{validationError}` data by the watchdog
 * (ARCHITECTURE.md §6.10); this class is for the rest — a node that vanished, a page function that
 * threw, a CDP call that failed.
 */
export class ActionError extends BrowserError {
	override readonly name: string = 'ActionError';
}

/** Everything needed to address one node over CDP. */
export interface NodeHandle {
	readonly client: CdpClient;
	/** The session the `backendNodeId` belongs to (DATA-MODEL.md §6.1). */
	readonly sessionId: SessionId;
	readonly backendNodeId: number;
}

/** Sessions that have already had `DOM.enable` issued, keyed by client so a reconnect starts clean. */
const DOM_ENABLED = new WeakMap<CdpClient, Set<SessionId>>();

/**
 * Issues `DOM.enable` once per (client, session).
 *
 * `DOM.resolveNode`/`getContentQuads`/`getBoxModel` all require the domain; the SessionManager's
 * per-session setup enables Page/Network but deliberately not DOM (ARCHITECTURE.md §7.3), so the
 * consumer that needs it turns it on. Failures are swallowed: an already-enabled domain answers with
 * an error on some Chrome versions and the subsequent call is the real test.
 */
export async function ensureDomEnabled(client: CdpClient, sessionId: SessionId): Promise<void> {
	let enabled = DOM_ENABLED.get(client);
	if (enabled === undefined) {
		enabled = new Set<SessionId>();
		DOM_ENABLED.set(client, enabled);
	}
	if (enabled.has(sessionId)) return;
	enabled.add(sessionId);
	try {
		await client.send.DOM.enable(undefined, sessionId);
	} catch {
		// Already enabled, or the session died; the caller's next call reports the real problem.
	}
}

/** Resolves a `backendNodeId` to a `Runtime.RemoteObject` id, or `null` when the node is gone. */
export async function resolveNodeObject(handle: NodeHandle): Promise<string | null> {
	await ensureDomEnabled(handle.client, handle.sessionId);
	try {
		const resolved = await handle.client.send.DOM.resolveNode(
			{ backendNodeId: handle.backendNodeId },
			handle.sessionId,
		);
		return resolved.object.objectId ?? null;
	} catch (error) {
		// R6.3: "no node with given id" means the state is stale, not that the browser is broken.
		if (isStaleNodeError(error)) return null;
		throw error;
	}
}

/** `true` for the CDP errors that mean "your `backendNodeId` no longer exists" (DATA-MODEL §6.3 R6.3). */
export function isStaleNodeError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /no node (with )?given id|could not find node|node with given id/i.test(message);
}

/**
 * Runs `functionDeclaration` with `this` bound to the node and returns its JSON value.
 *
 * `userGesture: true` matters: a page function that opens a window, enters fullscreen, or reads the
 * clipboard is gated on a user activation, and a synthesized interaction must look like one.
 */
export async function callOnNode<T>(handle: NodeHandle, functionDeclaration: string, args: unknown[] = []): Promise<T> {
	const objectId = await resolveNodeObject(handle);
	if (objectId === null) throw new ActionError(`node ${handle.backendNodeId} is no longer in the DOM`);
	try {
		const outcome = await handle.client.send.Runtime.callFunctionOn({
			functionDeclaration,
			objectId,
			arguments: args.map((value) => ({ value })),
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		}, handle.sessionId);
		if (outcome.exceptionDetails !== undefined) {
			throw new ActionError(`page function threw: ${outcome.exceptionDetails.text}`);
		}
		return outcome.result.value as T;
	} finally {
		await releaseObject(handle.client, handle.sessionId, objectId);
	}
}

/** Best-effort `Runtime.releaseObject`; a leaked handle is a leak, not a failure of the action. */
export async function releaseObject(client: CdpClient, sessionId: SessionId, objectId: string): Promise<void> {
	try {
		await client.send.Runtime.releaseObject({ objectId }, sessionId);
	} catch {
		// The context is gone (navigation) — the object went with it.
	}
}

/** Evaluates an expression in a session's main world and returns its JSON value. */
export async function evaluateJson<T>(client: CdpClient, sessionId: SessionId, expression: string): Promise<T> {
	const outcome = await client.send.Runtime.evaluate({
		expression,
		returnByValue: true,
		awaitPromise: true,
		userGesture: true,
	}, sessionId);
	if (outcome.exceptionDetails !== undefined) {
		throw new ActionError(`page expression threw: ${outcome.exceptionDetails.text}`);
	}
	return outcome.result.value as T;
}

// ---------------------------------------------------------------------------
// element facts the cascades branch on
// ---------------------------------------------------------------------------

/** Lower-case tag name of an IR node (DATA-MODEL §6.1 derived member `tagName`). */
export function tagNameOf(node: EnhancedDomTreeNode): string {
	return node.nodeName.toLowerCase();
}

/** Case-insensitive attribute read; CDP reports attribute names lower-cased for HTML. */
export function attributeOf(node: EnhancedDomTreeNode, name: string): string | null {
	const direct = node.attributes[name];
	if (direct !== undefined) return direct;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(node.attributes)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return null;
}

/** `<input type=...>`, lower-cased; `'text'` when the attribute is absent, `null` for non-inputs. */
export function inputTypeOf(node: EnhancedDomTreeNode): string | null {
	if (tagNameOf(node) !== 'input') return null;
	return (attributeOf(node, 'type') ?? 'text').toLowerCase();
}

/** `<select>` — clicking one is a `{validationError}`, not a click (ARCHITECTURE.md §6.10). */
export function isNativeSelect(node: EnhancedDomTreeNode): boolean {
	return tagNameOf(node) === 'select';
}

/** `<input type=file>` — clicking one opens an OS dialog no agent can answer (§6.10 guard rail). */
export function isFileInput(node: EnhancedDomTreeNode): boolean {
	return inputTypeOf(node) === 'file';
}

/** `contenteditable` in its truthy spellings (`''`, `'true'`, `'plaintext-only'`). */
export function isContentEditable(node: EnhancedDomTreeNode): boolean {
	const value = attributeOf(node, 'contenteditable');
	if (value === null) return false;
	const normalized = value.toLowerCase();
	return normalized === '' || normalized === 'true' || normalized === 'plaintext-only';
}

/**
 * Input types whose value cannot be produced by per-character key events — the browser owns their
 * editing UI, so the typing path assigns the value directly (ARCHITECTURE.md §6.10 "special-input
 * direct value assignment").
 */
export const DIRECT_VALUE_INPUT_TYPES: readonly string[] = [
	'date',
	'datetime-local',
	'month',
	'week',
	'time',
	'color',
	'range',
];

/** `true` when {@linkcode DIRECT_VALUE_INPUT_TYPES} covers this node's input type. */
export function needsDirectValueAssignment(node: EnhancedDomTreeNode): boolean {
	const type = inputTypeOf(node);
	return type !== null && DIRECT_VALUE_INPUT_TYPES.includes(type);
}

/** Elements the typing path accepts at all. */
export function isTypable(node: EnhancedDomTreeNode): boolean {
	const tag = tagNameOf(node);
	if (tag === 'textarea') return true;
	if (tag === 'input') return !isFileInput(node);
	return isContentEditable(node);
}

/** A short human label used in logs and `validationError` messages. */
export function describeNode(node: EnhancedDomTreeNode): string {
	const tag = tagNameOf(node);
	const id = attributeOf(node, 'id');
	const type = inputTypeOf(node);
	const parts = [tag];
	if (type !== null) parts.push(`type=${type}`);
	if (id !== null && id !== '') parts.push(`#${id}`);
	return `<${parts.join(' ')}> [${node.backendNodeId}]`;
}
