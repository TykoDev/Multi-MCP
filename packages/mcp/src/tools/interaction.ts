/** Interaction handlers: the tools that put input into the page — clicks, typing, keys, scrolling. */
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import {
	ClickCoordinateEvent,
	ClickElementEvent,
	HoverEvent,
	keySpecForCharacter,
	type KeyTarget,
	markSecretFilled,
	MODIFIER_ALIASES,
	MODIFIER_BITS,
	NAMED_KEYS,
	pressKey,
	ScrollEvent,
	selectAllModifier,
	SendKeysEvent,
	typeCharacter,
	TypeTextEvent,
	UploadFileEvent,
} from '@tykotech/browser';
import { expressionDigest } from '../audit.ts';
import { originOf, ToolError } from '../errors.ts';
import { fileInfoOf } from '../files.ts';
import { focusedFrame } from '../isolated_world.ts';

import {
	assertUnitViewportScale,
	EVALUATE_TIMEOUT_MS_DEFAULT,
	evaluateInFrame,
	type FrameContext,
	frameContext,
	liveFrameIdentity,
	liveFrameUrl,
} from '../page_eval.ts';
import {
	DRAG_STEPS_DEFAULT,
	dragBetween,
	type Point,
	scrollElementIntoView,
	scrollPageTo,
	selectOption,
} from '../page_actions.ts';
import { assertFillable, describeFillTarget, type SecretStore } from '../secrets.ts';
import type { SessionRecord } from '../registry.ts';
import { say, type ToolContext, type ToolResult } from '../types.ts';
// The ONE cross-origin predicate. `browser_get_html`'s gate and this file's credential
// confinement must not answer "same origin?" differently, or one of them confines a frame the other admits.
import { isCrossOrigin } from './perception.ts';
import { dispatch, heldToken, nodeAt, target } from './shared.ts';

/** Default scroll distance, in viewport heights. */
const DEFAULT_SCROLL_PAGES = 0.75;

/** The argument shape shared by every pointer tool: an index, or a viewport point. */
interface PointerArgs {
	index?: number;
	coordinate_x?: number;
	coordinate_y?: number;
	state_token?: string;
	session_id?: string;
}

export async function browserClick(args: PointerArgs, ctx: ToolContext): Promise<ToolResult> {
	return await clickWith(args, ctx, { button: 'left', clickCount: 1, verb: 'Clicked' });
}

/** `browser_double_click` — the same cascade, with a click count of two. */
export async function browserDoubleClick(args: PointerArgs, ctx: ToolContext): Promise<ToolResult> {
	return await clickWith(args, ctx, { button: 'left', clickCount: 2, verb: 'Double-clicked' });
}

/** `browser_right_click` — the same cascade with the right button, which is what opens a menu. */
export async function browserRightClick(args: PointerArgs, ctx: ToolContext): Promise<ToolResult> {
	return await clickWith(args, ctx, { button: 'right', clickCount: 1, verb: 'Right-clicked' });
}

/** The one click implementation the three pointer tools share. */
async function clickWith(
	args: PointerArgs,
	ctx: ToolContext,
	how: { button: 'left' | 'right'; clickCount: number; verb: string },
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	if (args.index !== undefined) {
		const outcome = await dispatch<Record<string, unknown> | null>(
			record.session,
			new ClickElementEvent({
				node: nodeAt(record.session, args.index, args.state_token),
				button: how.button,
				clickCount: how.clickCount,
			}),
		);
		ctx.registry.touch(record.id);
		return clickResult(`${how.verb} element ${args.index} in session ${record.id}.`, record, outcome, {
			session_id: record.id,
			index: args.index,
		});
	}
	const x = args.coordinate_x as number;
	const y = args.coordinate_y as number;
	const outcome = await dispatch<Record<string, unknown> | null>(
		record.session,
		new ClickCoordinateEvent({ coordinateX: x, coordinateY: y, button: how.button, clickCount: how.clickCount }),
	);
	ctx.registry.touch(record.id);
	return clickResult(`${how.verb} (${x}, ${y}) in session ${record.id}.`, record, outcome, {
		session_id: record.id,
		x,
		y,
	});
}

/** `browser_hover` — move the pointer without pressing. */
export async function browserHover(args: PointerArgs, ctx: ToolContext): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const byIndex = args.index !== undefined;
	const event = byIndex
		? new HoverEvent({ node: nodeAt(record.session, args.index as number, args.state_token) })
		: new HoverEvent({ coordinateX: args.coordinate_x as number, coordinateY: args.coordinate_y as number });
	const outcome = await dispatch<Record<string, unknown> | null>(record.session, event);
	ctx.registry.touch(record.id);
	const where = byIndex ? `element ${args.index}` : `(${args.coordinate_x}, ${args.coordinate_y})`;
	return say({
		session_id: record.id,
		...(byIndex ? { index: args.index } : { x: args.coordinate_x, y: args.coordinate_y }),
		hover_x: numberOr(outcome?.hoverX, 0),
		hover_y: numberOr(outcome?.hoverY, 0),
		clamped: outcome?.clamped === true,
		// Omitted rather than `false` when no occlusion probe ran, which is every coordinate hover.
		// `false` there would be a claim about a check nobody made.
		...(typeof outcome?.occluded === 'boolean' ? { occluded: outcome.occluded } : {}),
		// Page-authored and therefore capped at the schema's own bound.
		hit_tag: typeof outcome?.hitTag === 'string' ? outcome.hitTag.slice(0, MAX_HIT_TAG_CHARS) : null,
		state_token: heldToken(record),
	}, `Hovered ${where} in session ${record.id}.`);
}

/** The cap on `hit_tag`, which is the one field in the hover result the *page* writes. */
const MAX_HIT_TAG_CHARS = 64;

/** A number from an untyped handler result, or the fallback. */
function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The click's text result, plus the download it started when the action layer reports one. */
function clickResult(
	message: string,
	record: SessionRecord,
	outcome: Record<string, unknown> | null,
	where: Record<string, unknown>,
): ToolResult {
	// The token names the table this action's `index` was RESOLVED AGAINST — the state as it was before the action
	// ran, because that is the only table the index ever meant anything in.
	const base = { ...where, state_token: heldToken(record) };
	const download = outcome?.download as { guid?: unknown } | undefined;
	const guid = typeof download?.guid === 'string' ? download.guid : null;
	if (guid === null) return say(base, message);
	const tracked = record.files.lookup(guid);
	const info = tracked === undefined ? null : fileInfoOf(tracked);
	if (info === null) return say(base, message);
	// The second text block is a frozen payload, byte for byte; new fields go to the structured half only.
	return {
		content: [
			{ type: 'text', text: message },
			{ type: 'text', text: JSON.stringify({ session_id: record.id, download: info }, null, 2) },
		],
		structuredContent: { ...base, download: info },
	};
}

export async function browserType(
	args: { text: string; index?: number; clear?: boolean; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);

	// `<secret>name</secret>` placeholders resolve server-side, pinned to the live URL of the frame the keystrokes land
	// in (not a cached or top-document URL), so a steered page cannot spend a secret pinned elsewhere.
	const wantsSecret = ctx.secrets !== undefined && !ctx.secrets.empty && args.text.includes('<secret>');
	// The viewport-scale guard, on the second of the two secret-bearing paths.
	if (wantsSecret) await assertUnitViewportScale(record);
	const pin = wantsSecret ? await secretPin(record, args.index, args.state_token) : { frameId: '', url: '' };
	const url = pin.url;
	const resolved = wantsSecret
		? (ctx.secrets as SecretStore).substitute(args.text, url)
		: { text: args.text, used: [] as readonly string[], substituted: false };

	// Second, whatever is left is classified: an operator typing a password by hand into a tool call gets it masked
	// out of the result and the logs rather than echoed back.
	const classified = classifySensitiveText(resolved.text);
	const sensitive = resolved.substituted || classified.sensitive;
	const echo = resolved.substituted
		? resolved.used.map((name) => `<secret>${name}</secret>`).join(', ')
		: classified.display;

	if (args.index !== undefined) {
		const node = nodeAt(record.session, args.index, args.state_token);
		// A field that received a secret — substituted, or classified sensitive — is masked from now on
		// exactly as a password field is, before the keystrokes go out (see `markSecretFilled`).
		if (sensitive) markSecretFilled(node.sessionId, node.backendNodeId);
		await dispatch(
			record.session,
			new TypeTextEvent({
				node,
				text: resolved.text,
				clear: args.clear ?? false,
				isSensitive: sensitive,
				sensitiveKeyName: resolved.used[0] ?? classified.kind,
			}),
		);
		ctx.registry.touch(record.id);
		auditSubstitution(record, ctx, resolved.used, pin, args.index);
		return say({
			session_id: record.id,
			index: args.index,
			...typedLength(resolved.text, sensitive),
			sensitive,
			state_token: heldToken(record),
		}, typedMessage(echo, sensitive, `element ${args.index}`, record.id));
	}

	// The index-less form ("or into the currently focused element") cannot go through `TypeTextEvent`: it takes a
	// *required* node, and the base class sanitizes it through a WeakSet, so omitting it throws
	// `Invalid value used in weak set`.
	await typeAtFocus(record, resolved.text, args.clear ?? false);
	ctx.registry.touch(record.id);
	auditSubstitution(record, ctx, resolved.used, pin, undefined);
	return say({
		session_id: record.id,
		...typedLength(resolved.text, sensitive),
		sensitive,
		state_token: heldToken(record),
	}, typedMessage(echo, sensitive, 'the focused element', record.id));
}

/** Records a `browser_type` placeholder substitution in the session's audit ledger. */
function auditSubstitution(
	record: SessionRecord,
	ctx: ToolContext,
	used: readonly string[],
	pin: { readonly frameId: string; readonly url: string },
	index: number | undefined,
): void {
	for (const name of used) {
		record.audit.append({
			session_id: record.id,
			principal: ctx.principal,
			kind: 'secret-fill',
			frame_id: pin.frameId,
			origin: originOf(pin.url),
			secret: name,
			...(index === undefined ? {} : { index }),
			ok: true,
		});
	}
}

/** The frame a `<secret>` placeholder is pinned to, and that frame's live URL. */
async function secretPin(
	record: SessionRecord,
	index: number | undefined,
	stateToken: string | undefined,
): Promise<{ frameId: string; url: string }> {
	if (index !== undefined) {
		const node = nodeAt(record.session, index, stateToken);
		const identity = await liveFrameIdentity(record, await frameContext(record, node.frameId ?? undefined));
		return { frameId: identity.frameId, url: identity.frameUrl };
	}
	const focused = await focusedFrame(record);
	return { frameId: focused.frameId, url: await liveFrameUrl(record, focused) };
}

/** `typed_length`, and only when it discloses nothing. */
function typedLength(text: string, sensitive: boolean): { typed_length?: number } {
	return sensitive ? {} : { typed_length: text.length };
}

/** The result line for a type, which never carries a masked value. */
function typedMessage(echo: string, sensitive: boolean, where: string, sessionId: string): string {
	return sensitive
		? `Typed ${echo} into ${where} in session ${sessionId}.`
		: `Typed ${echo.length} characters into ${where} in session ${sessionId}.`;
}

/** The live `pageInfo`, or the cached one when the live read fails; never fails the completed action. */
async function pageInfoAfter(record: SessionRecord): Promise<
	{
		scrollX: number;
		scrollY: number;
		pixelsAbove: number;
		pixelsBelow: number;
	} | undefined
> {
	try {
		const live = await record.session.getBrowserStateSummary({ includeDom: false });
		if (live.stateError === null || live.stateError === undefined) return live.pageInfo;
	} catch {
		// Fall through to the cached geometry below.
	}
	return record.session.cachedBrowserState?.pageInfo;
}

/** Synthesizes real key events at whatever the page currently has focused. */
async function typeAtFocus(record: SessionRecord, value: string, clear: boolean): Promise<void> {
	const session = record.session;
	const client = session.cdpClient;
	const manager = session.sessionManager;
	const focus = session.agentFocusTargetId;
	if (client === null || manager === null || focus === null) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	const cdp = await manager.getOrCreateCdpSession(focus, true);
	const keyTarget: KeyTarget = { client, sessionId: cdp.sessionId };

	try {
		if (clear) {
			// Select-all then Delete: the same two-step the element path uses, and
			// the only one that works without a node handle to assign through.
			await pressKey(keyTarget, keySpecForCharacter('a'), selectAllModifier());
			const del = NAMED_KEYS.delete;
			if (del !== undefined) await pressKey(keyTarget, del);
		}
		for (const character of [...value]) {
			const named = character === '\n' ? NAMED_KEYS.enter : character === '\t' ? NAMED_KEYS.tab : undefined;
			if (named !== undefined) {
				await pressKey(keyTarget, named);
				continue;
			}
			await typeCharacter(keyTarget, character);
		}
	} catch (cause) {
		throw new ToolError('browser-unavailable', cause instanceof Error ? cause.message : String(cause));
	}
}

/** `browser_press_key` — a key or chord, optionally aimed at a named element. */
export async function browserPressKey(
	args: { key: string; modifiers?: readonly string[]; index?: number; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const modifiers = normalizeModifiers(args.modifiers ?? []);
	const keys = modifiers.names.length === 0 ? args.key : `${modifiers.names.join('+')}+${args.key}`;
	const node = args.index === undefined ? null : nodeAt(record.session, args.index, args.state_token);
	await dispatch(record.session, new SendKeysEvent({ keys, node }));
	ctx.registry.touch(record.id);
	const where = args.index === undefined ? '' : ` at element ${args.index}`;
	const echo = pressedEcho(keys);
	return say(
		{
			session_id: record.id,
			key: echo,
			modifiers: modifiers.bits,
			...(args.index === undefined ? {} : { index: args.index }),
			state_token: heldToken(record),
		},
		`Pressed ${echo}${where} in session ${record.id}.`,
	);
}

/** What the result says was pressed. */
function pressedEcho(keys: string): string {
	const combos = keys.split(/[\s,]+/).filter((token) => token !== '');
	if (combos.length <= 1) return keys;
	return `a sequence of ${combos.length} keys`;
}

/** Canonicalises modifier names against the vendored alias table, and reports the bitfield. */
function normalizeModifiers(names: readonly string[]): { names: string[]; bits: number } {
	const canonical: string[] = [];
	let bits = 0;
	for (const raw of names) {
		const name = MODIFIER_ALIASES[raw.trim().toLowerCase()];
		if (name === undefined) {
			throw new ToolError('invalid-arguments', `unknown modifier ${JSON.stringify(raw)}`);
		}
		if (canonical.includes(name)) continue;
		canonical.push(name);
		bits |= MODIFIER_BITS[name];
	}
	return { names: canonical, bits };
}

/** `browser_fill` — replace a field's contents. */
export async function browserFill(
	args: { index: number; text: string; clear?: boolean; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const cleared = args.clear ?? true;
	const typed = await browserType({ ...args, clear: cleared }, ctx);
	const payload = (typed as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
	return {
		content: (typed as { content: ToolResult['content'] }).content,
		structuredContent: { ...payload, index: args.index, cleared },
	} as ToolResult;
}

/** `browser_scroll_to {x, y}` — put the document at an absolute position. */
export async function browserScrollTo(
	args: { x: number; y: number; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	await scrollPageTo(record, args.x, args.y);
	ctx.registry.touch(record.id);
	const after = await pageInfoAfter(record);
	return say({
		session_id: record.id,
		scroll: {
			x: after?.scrollX ?? 0,
			y: after?.scrollY ?? 0,
			pixels_above: after?.pixelsAbove ?? 0,
			pixels_below: after?.pixelsBelow ?? 0,
		},
		state_token: null,
	}, `Scrolled session ${record.id} to (${Math.round(args.x)}, ${Math.round(args.y)}).`);
}

/** `browser_scroll_into_view {index}` — bring one element into the viewport. */
export async function browserScrollIntoView(
	args: { index: number; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const node = nodeAt(record.session, args.index, args.state_token);
	const { bounds } = await scrollElementIntoView(record, node);
	ctx.registry.touch(record.id);
	const after = await pageInfoAfter(record);
	return say({
		session_id: record.id,
		index: args.index,
		scroll: {
			x: after?.scrollX ?? 0,
			y: after?.scrollY ?? 0,
			pixels_above: after?.pixelsAbove ?? 0,
			pixels_below: after?.pixelsBelow ?? 0,
		},
		bounds,
		state_token: heldToken(record),
	}, `Scrolled element ${args.index} into view in session ${record.id}.`);
}

/** `browser_select_option` — set a native `<select>` by value, label or position. */
export async function browserSelectOption(
	args: {
		index: number;
		value?: string;
		label?: string;
		index_in_list?: number;
		state_token?: string;
		session_id?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const node = nodeAt(record.session, args.index, args.state_token);
	const selected = await selectOption(record, node, args, args.index);
	ctx.registry.touch(record.id);
	return say({
		session_id: record.id,
		index: args.index,
		selected,
		state_token: heldToken(record),
	}, `Selected option ${selected.index_in_list} in element ${args.index} of session ${record.id}.`);
}

/** `browser_upload_file {index, file_id}` — put one session file on a file input. */
export async function browserUploadFile(
	args: { index: number; file_id: string; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const node = nodeAt(record.session, args.index, args.state_token);
	// Staged under the file's display name, because the page reads the basename of the path we hand
	// `DOM.setFileInputFiles` as `File.name` and the download's on-disk name is its guid; staged
	// under the guid, the page would see a GUID as the file's name.
	const staged = await record.files.stageForUpload(args.file_id);
	await dispatch(record.session, new UploadFileEvent({ node, filePath: staged.path }));
	ctx.registry.touch(record.id);
	return say({
		session_id: record.id,
		index: args.index,
		file_id: args.file_id,
		filename: staged.info.name,
		bytes: staged.size,
		state_token: heldToken(record),
	}, `Uploaded ${staged.info.name} (${staged.size} bytes) to element ${args.index} in session ${record.id}.`);
}

/** `browser_handle_dialog {dialog_id, accept, prompt_text?}` — answer a held JavaScript dialog. */
export async function browserHandleDialog(
	args: { dialog_id: string; accept: boolean; prompt_text?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	// Exempt from the `dialog-open` refusal every other mutating tool takes, because this tool is that refusal's
	// remedy — without the exemption it would refuse itself and a held dialog would be unanswerable.
	const record = await target(ctx, args, true, 'answer');
	const popups = record.popups;
	if (popups === null) {
		throw new ToolError('feature-unavailable', 'this session has no dialog watchdog', { feature: 'persistence' });
	}
	const answered = popups.answerDialog(args.dialog_id, {
		accept: args.accept,
		...(args.prompt_text === undefined ? {} : { promptText: args.prompt_text }),
	});
	if (!answered) {
		throw new ToolError(
			'element-not-found',
			popups.manualHandling
				? `no dialog is open with id ${args.dialog_id}; it was answered already or its 20s hold expired`
				: `no dialog is being held: subscribe to the dialog event kind before a dialog opens, or the ` +
					`server answers it automatically`,
		);
	}
	ctx.registry.touch(record.id);
	return say({
		session_id: record.id,
		dialog_id: args.dialog_id,
		accepted: args.accept,
		state_token: null,
	}, `${args.accept ? 'Accepted' : 'Dismissed'} dialog ${args.dialog_id} in session ${record.id}.`);
}

/** `browser_drag {from, to, steps?}` — press, drag across, release. */
export async function browserDrag(
	args: {
		from: { index?: number; x?: number; y?: number };
		to: { index?: number; x?: number; y?: number };
		steps?: number;
		state_token?: string;
		session_id?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const to = await dragPoint(record, args.to, args.state_token);
	const from = await dragPoint(record, args.from, args.state_token);
	const outcome = await dragBetween(record, from, to, args.steps ?? DRAG_STEPS_DEFAULT);
	ctx.registry.touch(record.id);
	return say({
		session_id: record.id,
		from,
		to,
		steps: outcome.steps,
		state_token: heldToken(record),
	}, `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}) in session ${record.id}.`);
}

/** One drag endpoint in top-document viewport CSS px, resolved by the same cascade a click uses. */
async function dragPoint(
	record: SessionRecord,
	endpoint: { index?: number; x?: number; y?: number },
	stateToken: string | undefined,
): Promise<Point> {
	if (endpoint.index === undefined) {
		return { x: Math.round(endpoint.x as number), y: Math.round(endpoint.y as number) };
	}
	const outcome = await dispatch<Record<string, unknown> | null>(
		record.session,
		new HoverEvent({ node: nodeAt(record.session, endpoint.index, stateToken) }),
	);
	const x = numberOr(outcome?.hoverX, Number.NaN);
	const y = numberOr(outcome?.hoverY, Number.NaN);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new ToolError(
			'element-not-interactable',
			`element ${endpoint.index} has no geometry to drag from or to`,
			{ index: endpoint.index },
		);
	}
	return { x: Math.round(x), y: Math.round(y) };
}

export async function browserScroll(
	args: { direction: 'up' | 'down'; pages?: number; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const viewportHeight = record.session.cachedBrowserState?.pageInfo.viewportHeight ?? 720;
	const amount = Math.round(viewportHeight * (args.pages ?? DEFAULT_SCROLL_PAGES));
	await dispatch(record.session, new ScrollEvent({ direction: args.direction, amount }));
	ctx.registry.touch(record.id);
	// The geometry AFTER the scroll, read live. `cachedBrowserState.pageInfo` is refreshed by no action, so it would
	// report the pre-scroll `scroll.y` and `pixels_above/below`.
	const after = await pageInfoAfter(record);
	return say({
		session_id: record.id,
		direction: args.direction,
		amount_px: amount,
		scroll: {
			x: after?.scrollX ?? 0,
			y: after?.scrollY ?? 0,
			pixels_above: after?.pixelsAbove ?? 0,
			pixels_below: after?.pixelsBelow ?? 0,
		},
		state_token: heldToken(record),
	}, `Scrolled ${args.direction} by ${amount}px in session ${record.id}.`);
}

// --- arbitrary in-page JavaScript, behind the explicit grant ------------------

/** `browser_evaluate {expression}` — run JavaScript in a frame's own main world. */
export async function browserEvaluate(
	args: { expression: string; frame_id?: string; timeout_ms?: number; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	// Mutating: arbitrary in-page code can click, submit and navigate, so it is refused while a human
	// holds the session for exactly the reason `browser_click` is.
	const record = await target(ctx, args, true);
	const frame = await frameContext(record, args.frame_id);
	const outcome = await evaluateInFrame(record, {
		expression: args.expression,
		frame,
		timeoutMs: args.timeout_ms ?? EVALUATE_TIMEOUT_MS_DEFAULT,
	});
	ctx.registry.touch(record.id);

	// One audit entry per call, written whether the expression succeeded or threw — "arbitrary code ran here" is the
	// fact worth recording, and an expression that throws has still run.
	const entry = record.audit.append({
		session_id: record.id,
		principal: ctx.principal,
		kind: 'evaluate',
		frame_id: outcome.frameId,
		origin: originOf(await frameOriginFor(record, frame)),
		expression_bytes: new TextEncoder().encode(args.expression).length,
		expression_digest: await expressionDigest(args.expression),
		result_bytes: outcome.resultBytes,
		ok: outcome.ok,
	});

	const payload: Record<string, unknown> = {
		session_id: record.id,
		frame_id: outcome.frameId,
		ok: outcome.ok,
		type: outcome.type,
		truncated: outcome.truncated,
		audit_id: entry.audit_id,
	};
	if (outcome.value !== undefined) payload.value = outcome.value;
	if (outcome.errorText !== undefined) payload.error_text = outcome.errorText;
	const message = outcome.ok
		? `Evaluated ${
			payload.type === 'undefined' ? 'an expression' : `a ${outcome.type} expression`
		} in frame ${outcome.frameId} of session ${record.id}${outcome.truncated ? ' (result truncated)' : ''}.`
		: `The expression threw in frame ${outcome.frameId} of session ${record.id}.`;
	return say(payload, message);
}

/** The frame's live URL for the audit's `origin`, degrading to the empty string. */
async function frameOriginFor(record: SessionRecord, frame: FrameContext): Promise<string> {
	try {
		return await liveFrameUrl(record, frame);
	} catch {
		return '';
	}
}

// --- filling a server-held credential -----------------------------------------

/** `browser_fill_secret {index, secret, state_token}` — type a configured credential the model has never seen. */
export async function browserFillSecret(
	args: { index: number; secret: string; state_token: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const store = ctx.secrets;
	if (store === undefined || store.empty) {
		throw new ToolError(
			'feature-unavailable',
			'this deployment has no server-held secrets configured; there is nothing to fill',
		);
	}

	// (1) The hard token check. `nodeAt` is the one index resolver in the product, and `state_token`
	// is required on this tool rather than optional, which is what makes the refusal hard.
	const node = nodeAt(record.session, args.index, args.state_token);

	// (2) and (3): the element must be something a credential belongs in.
	const targetShape = assertFillable(
		node as unknown as { nodeName?: string; attributes?: Record<string, string> },
		args.index,
	);

	// A form-capable client may have its human choose the secret when the named one cannot be used here.
	const chooses = ctx.client?.elicitForm === true && ctx.mcp !== undefined;
	const chosen = chooses ? chosenSecret(ctx) : undefined;
	const offer = chooses && chosen === undefined;
	const secret = chosen ?? args.secret;

	// (4) The pin must exist. An unpinned secret has no origin control at all, and on this tool the
	// pin is the only control there is.
	if (!store.has(secret)) {
		if (offer) {
			const choice = await offerSecretChoice(record, node, store, args, `there is no secret named ${secret}`);
			if (choice !== null) return choice;
		}
		throw new ToolError(
			'invalid-arguments',
			`no secret named ${secret}; browser_get_state lists the names available on this page`,
		);
	}
	if ((store.domainsOf(secret) ?? []).length === 0) {
		throw new ToolError(
			'navigation-blocked',
			`the secret ${secret} declares no domains; browser_fill_secret requires a pinned secret, because ` +
				'once a text input is permitted the domain pin is the only control left',
		);
	}

	// (5) The viewport-scale guard, before the URL read so that the last await before the dispatch is the URL read.
	await assertUnitViewportScale(record);

	// (6) The live, per-frame origin. Both URLs come from the browser now, not from a capture: the
	// whole failure mode is a page that moved between the read and the type.
	const frame = await frameContext(record, node.frameId ?? undefined);
	const identity = await liveFrameIdentity(record, frame);
	const frameOrigin = originOf(identity.frameUrl);
	// `isCrossOrigin`, not `originOf`-equality.
	if (isCrossOrigin(identity.frameUrl, identity.topUrl)) {
		throw new ToolError(
			'navigation-blocked',
			`element ${args.index} is in a document at ${frameOrigin}, which is not the top document's origin ` +
				`(${originOf(identity.topUrl)}); a secret is never typed into a cross-origin frame, and an origin ` +
				'that cannot be named counts as a different one',
			{ index: args.index },
		);
	}
	// The named secret is not permitted on this frame's live origin.
	if (offer && !store.namesFor(identity.frameUrl).includes(secret)) {
		const choice = secretChoiceFor(
			store,
			identity.frameUrl,
			args,
			`the secret ${secret} cannot be used on ${frameOrigin}`,
		);
		if (choice !== null) return choice;
	}
	// The pin itself, through the ONE substitution implementation. A second permit check here would
	// be a second answer to "may this secret be typed at this URL".
	const resolved = store.substitute(`<secret>${secret}</secret>`, identity.frameUrl);

	// From here on the field is a password field to every emission path — `input.value`, labels, the serialized page,
	// the AX snapshot, the state token — whatever the page calls it.
	markSecretFilled(node.sessionId, node.backendNodeId);

	await dispatch(
		record.session,
		new TypeTextEvent({
			node,
			text: resolved.text,
			clear: true,
			isSensitive: true,
			sensitiveKeyName: secret,
		}),
	);
	ctx.registry.touch(record.id);

	const entry = record.audit.append({
		session_id: record.id,
		principal: ctx.principal,
		kind: 'secret-fill',
		frame_id: frame.frameId,
		origin: frameOrigin,
		secret,
		index: args.index,
		ok: true,
	});

	return say(
		{
			session_id: record.id,
			index: args.index,
			// The NAME. Every other field here is structural: an index, a frame id, an origin.
			secret,
			frame_id: frame.frameId,
			origin: frameOrigin,
			state_token: heldToken(record),
			audit_id: entry.audit_id,
		},
		`Filled ${describeFillTarget(node as unknown as { nodeName?: string; attributes?: Record<string, string> })} ` +
			`(element ${args.index}, ${targetShape.type}) with the secret ${secret} at ${frameOrigin} in session ${record.id}.`,
	);
}

// --- the secret choice ----------------------------------------------------------------------------------------------

/** The `inputRequests` key the secret choice rides under, and the one its answer comes back under. */
export const SECRET_CHOICE_KEY = 'ttk_secret';

/** The name a retried `browser_fill_secret` carries from its human, or `undefined` on a first round. */
function chosenSecret(ctx: ToolContext): string | undefined {
	const answer = inputResponse(ctx.mcp?.mcpReq.inputResponses, SECRET_CHOICE_KEY);
	if (answer.kind === 'missing') return undefined;
	if (answer.kind !== 'elicit') {
		throw new ToolError('invalid-arguments', 'the secret choice answer is not an elicitation result');
	}
	if (answer.action !== 'accept') {
		throw new ToolError(
			'user-declined',
			`the person ${answer.action === 'decline' ? 'declined' : 'cancelled'} the secret choice; nothing was typed`,
		);
	}
	const name = answer.content?.secret;
	if (typeof name !== 'string' || name === '' || name.length > 64) {
		throw new ToolError('invalid-arguments', 'the secret choice did not name a secret');
	}
	return name;
}

/**
 * The choice for a name the store does not hold, which the check order reaches before the frame is read: the
 * element's frame is read here so the offer is made for the origin the credential would go to.
 */
async function offerSecretChoice(
	record: SessionRecord,
	node: { frameId?: string | null },
	store: SecretStore,
	args: { index: number },
	problem: string,
): Promise<ToolResult | null> {
	const identity = await liveFrameIdentity(record, await frameContext(record, node.frameId ?? undefined));
	if (isCrossOrigin(identity.frameUrl, identity.topUrl)) return null;
	return secretChoiceFor(store, identity.frameUrl, args, problem);
}

/**
 * The `input_required` offering the secrets this tool would fill at `url` — permitted there by the pin predicate and
 * pinned at all, since an unpinned secret is refused here whatever the page — or `null` when there are none to offer
 * and the caller's refusal stands.
 */
function secretChoiceFor(
	store: SecretStore,
	url: string,
	args: { index: number },
	problem: string,
): ToolResult | null {
	const names = store.namesFor(url).filter((name) => (store.domainsOf(name) ?? []).length > 0);
	if (names.length === 0) return null;
	return inputRequired({
		inputRequests: {
			[SECRET_CHOICE_KEY]: inputRequired.elicit({
				message: `${problem}. Choose the secret to fill element ${args.index} with on ${originOf(url)}.`,
				requestedSchema: {
					type: 'object',
					properties: { secret: { type: 'string', title: 'Secret', enum: names } },
					required: ['secret'],
				},
			}),
		},
	}) as ToolResult;
}

// --- The `browser_type` sensitive-text heuristic. -----------------------------------------------------------------

/** The minimum length — below it nothing is classified. */
const SENSITIVE_MIN_LENGTH = 6;

/** The threshold for the credential-shaped branch. */
const CREDENTIAL_MIN_LENGTH = 16;

/** Email shape. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Alphanumerics plus the three punctuation characters `.`, `-` and `_`. */
const CREDENTIAL_SHAPE = /^[A-Za-z0-9.\-_]+$/;

/** What the classifier decided, and the name the mask and the type event both carry. */
type SensitiveKind = 'email' | 'credential';

interface MaskedText {
	readonly sensitive: boolean;
	/** `null` when not sensitive. Feeds `TypeTextEvent.sensitiveKeyName`. */
	readonly kind: SensitiveKind | null;
	/** What may be shown: the raw text when safe, `<email>` / `<credential>` when not. */
	readonly display: string;
}

/** Classifies one `browser_type` input. Pure; never logs. */
export function classifySensitiveText(text: string): MaskedText {
	if (text.length < SENSITIVE_MIN_LENGTH) return { sensitive: false, kind: null, display: text };
	if (EMAIL_SHAPE.test(text)) return { sensitive: true, kind: 'email', display: '<email>' };
	if (text.length >= CREDENTIAL_MIN_LENGTH && CREDENTIAL_SHAPE.test(text)) {
		return { sensitive: true, kind: 'credential', display: '<credential>' };
	}
	return { sensitive: false, kind: null, display: text };
}
