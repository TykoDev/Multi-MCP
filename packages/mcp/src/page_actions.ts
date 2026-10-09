/**
 * The B2.5 page actions that need CDP directly rather than a vendored command event: absolute
 * scrolling, scroll-into-view, native `<select>` option choice, and drag.
 *
 * **Why these live here and not in `@tykotech/browser`.** B2.1 and B2.2 set the precedent
 * (`hit_test.ts`, `highlight.ts`): a capability the MCP layer needs, that the vendored action
 * watchdog has no existing command for, is written here against the typed CDP surface rather than
 * paid for with a new event class and an erratum in a vendored package. Every one of these is a
 * small, self-contained CDP sequence with no cascade to reuse — `DOM.scrollIntoViewIfNeeded` is one
 * call, an absolute scroll is one evaluate, a `<select>` choice is one `callFunctionOn` — so
 * vendoring them would add surface to a package this delivery is trying to leave alone.
 *
 * The one genuine exception is `browser_drag`, which **does** have a cascade to reuse and does reuse
 * it: it resolves both of its endpoints through `HoverEvent` (E-49), so a drag starts and ends
 * exactly where a click on the same index would have landed, and only the press/move/release
 * sequence in between is dispatched from here.
 *
 * Nothing here writes to the event ring, and nothing here reads page content: a `<select>`'s option
 * text is the value the caller asked for by name and is echoed back, and no other text leaves the
 * page through this module.
 */
import type { BrowserSession } from '@tykotech/browser';
import type { CdpClient, SessionId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import type { SessionRecord } from './registry.ts';

/** Intermediate `mouseMoved` steps a drag dispatches between press and release. */
export const DRAG_STEPS_DEFAULT = 10;
export const DRAG_STEPS_MAX = 50;

/** A point in top-document viewport CSS px — the one coordinate system (§10). */
export interface Point {
	readonly x: number;
	readonly y: number;
}

/** `{x, y, w, h}` in the frame's own viewport CSS px. */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** Exactly one of the three is supplied; the tool's schema enforces that before the handler runs. */
export interface OptionSelector {
	readonly value?: string;
	readonly label?: string;
	readonly index_in_list?: number;
}

/** The option that ended up selected, in all three of the ways a caller may name one. */
export interface SelectedOption {
	readonly value: string;
	readonly label: string;
	readonly index_in_list: number;
}

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

/** Maps a CDP failure to the tool error a model can act on, preserving an already-typed one. */
function cdpFailure(cause: unknown): ToolError {
	if (cause instanceof ToolError) return cause;
	const message = cause instanceof Error ? cause.message : String(cause);
	if (/timeout|timed out/i.test(message)) return new ToolError('timeout', message);
	return new ToolError('browser-unavailable', message);
}

/**
 * Scrolls the top document to an absolute position.
 *
 * `window.scrollTo` rather than a wheel gesture, and the difference is the contract:
 * `browser_scroll` is a *relative* gesture and stays one, while a recording that must replay at the
 * position it was recorded at needs a destination, not a direction. A wheel cannot express "put the
 * document at y = 1840" without a loop that guesses at the page's own scroll handling.
 *
 * The expression carries no caller text. Both coordinates are numbers the schema has already
 * validated, and they are serialised as numeric literals — there is no string to escape and no
 * `evaluate` capability exposed by this path.
 */
export async function scrollPageTo(record: SessionRecord, x: number, y: number): Promise<void> {
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new ToolError('invalid-arguments', 'scroll coordinates must be finite numbers');
	}
	const { client, manager, focus } = connected(record.session);
	const page = await manager.getOrCreateCdpSession(focus, true);
	try {
		await client.send.Runtime.evaluate({
			expression: `window.scrollTo(${JSON.stringify(Math.round(x))}, ${JSON.stringify(Math.round(y))})`,
			returnByValue: true,
		}, page.sessionId);
	} catch (cause) {
		throw cdpFailure(cause);
	}
}

/**
 * Brings one element into view and reports the box it occupies afterwards.
 *
 * `bounds` is read **live** from the element's own frame, never composed from the cached table. For
 * a node in an out-of-process frame that rect is in the child's viewport space and cannot be put
 * into the top document's without the composed-bounds arithmetic B1 removed from the contract, so it
 * is reported as `null` rather than as a number in the wrong space. The scroll did happen either
 * way, which is what the caller asked for.
 */
export async function scrollElementIntoView(
	record: SessionRecord,
	node: { backendNodeId: number; sessionId: string | null },
): Promise<{ bounds: Rect | null }> {
	const { client, manager, focus } = connected(record.session);
	const page = await manager.getOrCreateCdpSession(focus, true);
	const sessionId = (node.sessionId ?? page.sessionId) as SessionId;
	try {
		await client.send.DOM.scrollIntoViewIfNeeded({ backendNodeId: node.backendNodeId }, sessionId);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		// Chromium refuses a node with no layout box by name. That is a fact about the element, not a
		// fault in the call, and `element-not-interactable` is the code a caller can branch on.
		if (/does not have a layout object|no layout|not.*box/i.test(message)) {
			throw new ToolError('element-not-interactable', `the element has no layout box, so it cannot be scrolled to`);
		}
		throw cdpFailure(cause);
	}
	const bounds = sessionId === page.sessionId ? await liveRect(client, sessionId, node.backendNodeId) : null;
	return { bounds };
}

/** `getBoundingClientRect()` on one node, or `null` when it has no usable box. */
async function liveRect(client: CdpClient, sessionId: SessionId, backendNodeId: number): Promise<Rect | null> {
	try {
		const resolved = await client.send.DOM.resolveNode({ backendNodeId }, sessionId);
		const objectId = resolved.object.objectId;
		if (objectId === undefined) return null;
		const out = await client.send.Runtime.callFunctionOn({
			objectId,
			functionDeclaration:
				`function () { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }`,
			returnByValue: true,
		}, sessionId);
		const value = out.result.value as Rect | undefined;
		return value === undefined ? null : value;
	} catch {
		return null;
	}
}

/**
 * The page-side option chooser, evaluated on the `<select>` itself.
 *
 * Returns a discriminated result rather than throwing into CDP, so a miss comes back as data and the
 * handler decides the code. It sets `selectedIndex` and then fires `input` and `change` — a
 * framework that binds to `onChange` sees exactly what a human's choice produces, which is the whole
 * point of the tool existing next to a click on an option.
 */
const SELECT_FUNCTION = `function (wantValue, wantLabel, wantIndex) {
	if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: 'not-a-select', tag: this.tagName.toLowerCase() };
	if (this.disabled) return { ok: false, reason: 'disabled', tag: this.tagName.toLowerCase() };
	const options = Array.from(this.options);
	let chosen = -1;
	if (wantIndex !== null) chosen = wantIndex;
	else if (wantValue !== null) chosen = options.findIndex((o) => o.value === wantValue);
	else if (wantLabel !== null) {
		const want = String(wantLabel).trim();
		chosen = options.findIndex((o) => (o.label || o.textContent || '').trim() === want);
	}
	if (chosen < 0 || chosen >= options.length) {
		return { ok: false, reason: 'no-such-option', count: options.length };
	}
	const option = options[chosen];
	if (option.disabled) return { ok: false, reason: 'option-disabled', count: options.length };
	this.selectedIndex = chosen;
	this.dispatchEvent(new Event('input', { bubbles: true }));
	this.dispatchEvent(new Event('change', { bubbles: true }));
	return {
		ok: true,
		value: option.value,
		label: (option.label || option.textContent || '').trim(),
		index_in_list: chosen,
	};
}`;

/**
 * Sets a native `<select>` by value, by label, or by position in its own option list.
 *
 * Refuses a non-`<select>` and a disabled control with `element-not-interactable`: the index
 * resolved, so `unknown-index` would be false, and `invalid-arguments` would blame the caller for a
 * fact about the page.
 */
export async function selectOption(
	record: SessionRecord,
	node: { backendNodeId: number; sessionId: string | null },
	selector: OptionSelector,
	index: number,
): Promise<SelectedOption> {
	const { client, manager, focus } = connected(record.session);
	const page = await manager.getOrCreateCdpSession(focus, true);
	const sessionId = (node.sessionId ?? page.sessionId) as SessionId;
	let out;
	try {
		const resolved = await client.send.DOM.resolveNode({ backendNodeId: node.backendNodeId }, sessionId);
		const objectId = resolved.object.objectId;
		if (objectId === undefined) {
			throw new ToolError('element-not-interactable', `element ${index} could not be resolved in its document`);
		}
		out = await client.send.Runtime.callFunctionOn({
			objectId,
			functionDeclaration: SELECT_FUNCTION,
			arguments: [
				{ value: selector.value ?? null },
				{ value: selector.label ?? null },
				{ value: selector.index_in_list ?? null },
			],
			returnByValue: true,
		}, sessionId);
	} catch (cause) {
		throw cdpFailure(cause);
	}
	const value = out.result.value as
		| { ok: true; value: string; label: string; index_in_list: number }
		| { ok: false; reason: string; tag?: string; count?: number }
		| undefined;
	if (value === undefined) {
		throw new ToolError('browser-unavailable', `element ${index} did not answer the option query`);
	}
	if (!value.ok) {
		if (value.reason === 'not-a-select') {
			throw new ToolError(
				'element-not-interactable',
				`element ${index} is a <${value.tag}>, not a <select>`,
				{ index, tag: value.tag ?? null },
			);
		}
		if (value.reason === 'disabled' || value.reason === 'option-disabled') {
			throw new ToolError(
				'element-not-interactable',
				`element ${index}: the ${value.reason === 'disabled' ? 'select' : 'option'} is disabled`,
				{ index, tag: 'select' },
			);
		}
		// A miss is not a disclosure: the caller is told how many options exist, never what they say.
		throw new ToolError(
			'element-not-interactable',
			`element ${index} has no option matching the request (${value.count ?? 0} options)`,
			{ index, tag: 'select' },
		);
	}
	return { value: value.value, label: value.label, index_in_list: value.index_in_list };
}

/**
 * Presses at `from`, moves across in `steps` increments with the button held, and releases at `to`.
 *
 * The intermediate moves are what make a drag work at all: HTML5 drag-and-drop and every
 * JavaScript slider read `mousemove` while the button is down, and a press followed immediately by a
 * release at another point is two clicks in different places rather than a drag. `buttons: 1` is
 * carried on every move, because that is the field a `mousemove` handler tests to decide whether a
 * drag is in progress.
 *
 * The release is attempted even if a move fails: an un-released button leaves the page in a dragging
 * state that every later action inherits.
 */
export async function dragBetween(
	record: SessionRecord,
	from: Point,
	to: Point,
	steps: number,
): Promise<{ steps: number }> {
	const { client, manager, focus } = connected(record.session);
	const page = await manager.getOrCreateCdpSession(focus, true);
	const count = Math.min(DRAG_STEPS_MAX, Math.max(1, Math.round(steps)));
	const send = (params: Record<string, unknown>) =>
		client.send.Input.dispatchMouseEvent(params as never, page.sessionId);
	try {
		await send({ type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 });
		await send({ type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
		try {
			for (let step = 1; step <= count; step += 1) {
				const ratio = step / count;
				await send({
					type: 'mouseMoved',
					x: Math.round(from.x + (to.x - from.x) * ratio),
					y: Math.round(from.y + (to.y - from.y) * ratio),
					button: 'left',
					buttons: 1,
				});
			}
		} finally {
			await send({ type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
		}
	} catch (cause) {
		throw cdpFailure(cause);
	}
	return { steps: count };
}
