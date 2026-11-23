/**
 * The page actions that need CDP directly rather than a vendored command event: absolute scrolling, scroll-into-view,
 * native `<select>` option choice, and drag.
 */
import type { BrowserSession } from '@tykotech/browser';
import type { CdpClient, SessionId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import type { SessionRecord } from './registry.ts';

/** Intermediate `mouseMoved` steps a drag dispatches between press and release. */
export const DRAG_STEPS_DEFAULT = 10;
const DRAG_STEPS_MAX = 50;

/** A point in top-document viewport CSS px — the one coordinate system. */
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
interface OptionSelector {
	readonly value?: string;
	readonly label?: string;
	readonly index_in_list?: number;
}

/** The option that ended up selected, in all three of the ways a caller may name one. */
interface SelectedOption {
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

/** Scrolls the top document to an absolute position. */
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

/** Brings one element into view and reports the box it occupies afterwards. */
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

/** The page-side option chooser, evaluated on the `<select>` itself. */
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

/** Sets a native `<select>` by value, by label, or by position in its own option list. */
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

/** Presses at `from`, moves across in `steps` increments with the button held, and releases at `to`. */
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
