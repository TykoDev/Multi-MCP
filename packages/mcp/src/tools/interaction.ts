/**
 * Interaction handlers: the tools that put input into the page — clicks, typing, keys, scrolling.
 *
 * Every one is mutating and refused while a human holds the session. Handlers throw
 * {@linkcode ToolError} for anything the calling model should see; the dispatch seam turns those
 * into result-level errors.
 */
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import {
	ClickCoordinateEvent,
	ClickElementEvent,
	HoverEvent,
	keySpecForCharacter,
	type KeyTarget,
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
import { focusedFrame } from '../focus_frame.ts';
import { classifySensitiveText } from '../masking.ts';
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
// The ONE cross-origin predicate (D-056). `browser_get_html`'s gate and this file's credential
// confinement must not answer "same origin?" differently — SEC-FH-23 is what happened when they did.
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

/**
 * `browser_double_click` — the same cascade, with E-48's click count.
 *
 * B2.4. The whole tool is one argument's difference from `browser_click`, which is the point: a
 * double click that took its own dispatch path would be a second click implementation, free to
 * disagree with the first about occlusion, geometry, download detection and the guard rails.
 */
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

/**
 * `browser_hover` — move the pointer without pressing (B2.4, AC-P1-12).
 *
 * The result reports where the pointer landed rather than merely that it moved, because a hover that
 * silently clamped to the viewport edge and a hover that landed on the element are indistinguishable
 * to a caller reading "ok". `occluded` is a fact about the page, not a failure: the pointer really is
 * over whatever is on top, and the menu that did not open is the caller's answer.
 */
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
		// Security review B2-SR4-13: omitted rather than `false` when no occlusion probe ran, which is
		// every coordinate hover. `false` there would have been a claim about a check nobody made.
		...(typeof outcome?.occluded === 'boolean' ? { occluded: outcome.occluded } : {}),
		// B2-SR4-4: page-authored and therefore capped at the schema's own bound.
		hit_tag: typeof outcome?.hitTag === 'string' ? outcome.hitTag.slice(0, MAX_HIT_TAG_CHARS) : null,
		state_token: heldToken(record),
	}, `Hovered ${where} in session ${record.id}.`);
}

/**
 * The cap on `hit_tag`, which is the one field in this slice the *page* writes (B2-SR4-4).
 *
 * A custom element's tag name is whatever the page called it, and a result field a caller reads as
 * server metadata must not be an unbounded channel out of the page. 64 characters is longer than any
 * real tag and shorter than a payload.
 */
const MAX_HIT_TAG_CHARS = 64;

/** A number from an untyped handler result, or the fallback. */
function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The click's text result, plus the download it started when the action layer reports one (E-33).
 *
 * The text block is unchanged, so existing callers keep parsing what they parsed; the download is an
 * *additional* text block and the structured content. Only safe metadata is appended — never the
 * bytes and never a path — and the listing tool stays authoritative for downloads that start after
 * the click's own detection window has closed.
 */
function clickResult(
	message: string,
	record: SessionRecord,
	outcome: Record<string, unknown> | null,
	where: Record<string, unknown>,
): ToolResult {
	// The token names the table this action's `index` was RESOLVED AGAINST — the state as it was
	// before the action ran, because that is the only table the index ever meant anything in. It is
	// deliberately NOT a claim about the page afterwards: a click that navigates leaves this handler
	// with the pre-click token, and a client that read it as "indices are still stable" would walk
	// straight back into the defect E-36 exists to close. `browser_get_state` is the only tool whose
	// token describes the page as it is now.
	const base = { ...where, state_token: heldToken(record) };
	const download = outcome?.download as { guid?: unknown } | undefined;
	const guid = typeof download?.guid === 'string' ? download.guid : null;
	if (guid === null) return say(base, message);
	const tracked = record.files.lookup(guid);
	const info = tracked === undefined ? null : fileInfoOf(tracked);
	if (info === null) return say(base, message);
	// The second text block keeps the exact payload 0.1.0 emitted, byte for
	// byte; the structured half is the one that grew (D-3, I-4).
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

	// R14. Two independent protections, in order.
	//
	// First, `<secret>name</secret>` placeholders are resolved server-side, so a
	// configured credential can be typed by a model that has never seen it. The
	// current page's URL decides which secrets are permitted — a model that has
	// been steered onto an attacker's page cannot spend a secret pinned
	// elsewhere.
	//
	// The origin is read *live* rather than from the cached state. A stale URL
	// here is not a cosmetic bug: it is the difference between "this secret is
	// pinned to your bank" and "this secret was typed into whatever the page
	// navigated itself to while you were deciding". The read is paid for only
	// when a placeholder is actually present.
	//
	// D-096 (A2): and it is the URL of the frame the keystrokes land in — the element's frame when an index
	// names one, the focused element's frame when none does — never the top document's, which was the
	// frameset hole SEC-07 closed for `browser_fill_secret` and left open here.
	const wantsSecret = ctx.secrets !== undefined && !ctx.secrets.empty && args.text.includes('<secret>');
	// SEC-24's guard, on the second of the two secret-bearing paths (B2.8). Under a visual viewport
	// scale other than 1 the layout- and visual-viewport scroll sources diverge, so a click point is
	// computed from mixed spaces and the value can land on an element other than the one named. It
	// fires **only when a placeholder is actually present**: an ordinary `browser_type` paying a CDP
	// round trip for a check with no security content would be a cost and not a control.
	if (wantsSecret) await assertUnitViewportScale(record);
	const pin = wantsSecret ? await secretPin(record, args.index, args.state_token) : { frameId: '', url: '' };
	const url = pin.url;
	const resolved = wantsSecret
		? (ctx.secrets as SecretStore).substitute(args.text, url)
		: { text: args.text, used: [] as readonly string[], substituted: false };

	// Second, whatever is left is classified: an operator typing a password by
	// hand into a tool call gets it masked out of the result and the logs rather
	// than echoed back. It cannot un-mask a placeholder substitution, which is
	// already known to be sensitive.
	const classified = classifySensitiveText(resolved.text);
	const sensitive = resolved.substituted || classified.sensitive;
	const echo = resolved.substituted
		? resolved.used.map((name) => `<secret>${name}</secret>`).join(', ')
		: classified.display;

	if (args.index !== undefined) {
		await dispatch(
			record.session,
			new TypeTextEvent({
				node: nodeAt(record.session, args.index, args.state_token),
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

	// ERRATUM(E-18). The schema has always advertised an index-less form ("or
	// into the currently focused element") that could not work: `TypeTextEvent`
	// takes a *required* node, and the base class sanitizes it through a
	// WeakSet, so omitting it threw `Invalid value used in weak set` and the
	// tool reported `browser-unavailable` for a perfectly valid call. Typing at
	// the focus is a session-level gesture, not an element-targeted one, so it
	// goes to the same vendored key synthesis the element path ends up using.
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

/**
 * Records a `browser_type` placeholder substitution in the session's audit ledger (B2.8).
 *
 * **A deliberate widening of design §6.5's "two producers", and the argument is one sentence:**
 * SEC-08 exists so that there is a record a server-held credential was spent, and `browser_type`
 * spends them too — a ledger that recorded only `browser_fill_secret` would be a record with a hole
 * in exactly the shape of the older, less restricted surface. The entry is the same `secret-fill`
 * kind, so a reader sees one vocabulary rather than two.
 *
 * The origin and frame are the ones the pin was evaluated against: since D-096 (A2) that is the frame the
 * keystrokes land in, as `browser_fill_secret` records it — no longer the top document's, which this entry
 * used to name with an empty `frame_id`. An audit that claimed a frame origin the check never used would
 * be describing a control that did not run, and the two now describe the same one.
 */
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

/**
 * The frame a `<secret>` placeholder is pinned to, and that frame's live URL (A2, D-096).
 *
 * With an `index`, the element's own frame, through **the resolver `browser_fill_secret` uses**:
 * `frameContext` from the element's `frameId`, then `liveFrameIdentity`, which reads the URL from the
 * browser's frame tree now and refuses a frame that is no longer attached. `nodeAt` runs first so a stale
 * token or an unknown index is refused here exactly as the dispatch below would refuse it. Without an
 * index, the frame that holds keyboard focus (`focus_frame.ts`), which is where `typeAtFocus` sends the
 * keystrokes. Either way the top document's URL is the pin only when the field is in the top document.
 *
 * Deliberately **not** `browser_fill_secret`'s other refusals (a pinned secret, a password/text input, a
 * same-origin frame): `browser_type` is the less restricted surface by design, and what changes here is
 * only which origin its domain pin is checked against.
 */
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

/**
 * `typed_length`, and only when it discloses nothing (E-38, security review).
 *
 * The frozen text block has always withheld the length on the sensitive branch — `typedMessage`
 * writes "Typed <secret>name</secret> into …" rather than a character count — precisely so a caller
 * that never learns a server-held credential does not learn its size either. The structured half
 * added by D-A2 re-added it unconditionally, alongside `sensitive: true` to say which value it was:
 * one `browser_type` per configured secret name would have enumerated the exact character length of
 * every credential the deployment holds. It is omitted rather than zeroed, because a zero would be a
 * length claim of its own and the schema's `.optional()` is the honest shape for "not disclosed".
 */
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

/**
 * `browser_press_key` — a key or chord, optionally aimed at a named element (B2.4, AC-P1-15).
 *
 * Two additions over 0.1.0, both additive. `modifiers` is a **name array** rather than a second
 * spelling of the chord string: `{key: 'a', modifiers: ['ctrl']}` and `{key: 'ctrl+a'}` are the same
 * press, and the array is the form the Live View socket already accepts (E-42), so a client that
 * drives both does not need two encodings. `index` focuses the element with `DOM.focus` first
 * (E-50) — never with a click, which would fire the element's own handlers as a side effect of
 * pressing a key.
 *
 * The names are folded into the chord string rather than into a bitfield of our own, because
 * `parseKeyCombo` is the single parser both paths use and a second modifier fold is exactly the
 * duplicate-table defect E-42 closed.
 */
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

/**
 * What the result says was pressed — security review B2-SR4-5.
 *
 * A single chord is echoed, because the echo carries a capability: it is how a caller learns which
 * chord the modifier fold actually produced. But `keys` is a **sequence** grammar — whitespace and
 * commas separate combos — so `'s e c r e t'` is six keystrokes, and echoing that verbatim would put
 * the whole string in the transcript twice with none of the protection `browser_type` applies to the
 * same characters. A multi-combo sequence is therefore summarised by its length instead of quoted,
 * which is exactly what `browser_type` does for text it will not echo.
 */
function pressedEcho(keys: string): string {
	const combos = keys.split(/[\s,]+/).filter((token) => token !== '');
	if (combos.length <= 1) return keys;
	return `a sequence of ${combos.length} keys`;
}

/**
 * Canonicalises modifier names against the vendored alias table, and reports the bitfield.
 *
 * An unknown name is refused rather than dropped: a caller that wrote `'controll'` and got an
 * unmodified keystroke would see a plausible-looking success and a page that did not react.
 */
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

/**
 * `browser_fill` — replace a field's contents (B2.5, AC-P1-14).
 *
 * `browser_type` appends, which is the whole reason this tool exists beside it: a replay into a
 * field a browser has remembered a value for must end holding only the new text. So `clear` defaults
 * to **true** here and to false there, and neither default moves.
 *
 * Everything else is `browser_type`'s behaviour deliberately unchanged, including the `<secret>`
 * substitution and the R14/E-38 disclosure rules: the two tools must not be able to disagree about
 * what a transcript keeps, so this delegates rather than reimplements.
 */
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

/**
 * `browser_scroll_to {x, y}` — put the document at an absolute position (B2.5, AC-P1-17).
 *
 * Absolute, where `browser_scroll` is relative. Neither replaces the other: a recording replays at
 * the position it was recorded at, which a direction cannot express, and a model reading a page
 * still wants "one screen further down".
 *
 * `state_token` is `null` by contract rather than the held token: a page scroll can reveal elements
 * that were never indexed, so the table the caller holds is not a description of the page any more
 * and saying otherwise would be worse than saying nothing.
 */
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

/**
 * `browser_scroll_into_view {index}` — bring one element into the viewport (B2.5, AC-P1-17).
 *
 * The scroll is the browser's own `DOM.scrollIntoViewIfNeeded`, so a nested scroll container, a
 * sticky header and a frame are all handled by Chromium rather than by arithmetic here. The result
 * carries the element's live box afterwards, so a caller can see it actually arrived.
 */
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

/**
 * `browser_select_option` — set a native `<select>` by value, label or position (B2.5, AC-P1-13).
 *
 * Exactly one selector, enforced by the schema. `index_in_list` is the option's position in its own
 * `<select>`, which is a different number from the element `index` and is named so it cannot be
 * confused with it.
 */
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

/**
 * `browser_upload_file {index, file_id}` — put one session file on a file input (B2.5, AC-P1-20).
 *
 * `file_id` only. The `bytes` arm is a non-goal (AD-15): it would be a new inbound-file trust
 * boundary nobody asked for, and its absence is why SEC-09's oversized-payload clause is not
 * applicable rather than unticked.
 *
 * The path comes from a **fresh** `SessionFiles.resolve`, called immediately before the dispatch and
 * never cached. That is what makes SEC-09's containment hold at upload time as well as at capture
 * time: `resolve` re-reads the real path and re-checks containment, so a symlink planted inside the
 * download directory after the download completed is refused here. A `file_id` from another session
 * is refused by construction — `SessionFiles` holds one session's directory and one session's
 * ledger, and there is no path from this handler to another session's.
 */
export async function browserUploadFile(
	args: { index: number; file_id: string; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const node = nodeAt(record.session, args.index, args.state_token);
	// Staged under the file's display name, because the page reads the basename of the path we hand
	// `DOM.setFileInputFiles` as `File.name` and the download's on-disk name is its guid. Measured on
	// the browser tier: without this the fixture's own change handler reported a GUID.
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

/**
 * `browser_handle_dialog {dialog_id, accept, prompt_text?}` — answer a held JavaScript dialog
 * (B2.5, AC-P1-19).
 *
 * **A dialog is only answerable while something is subscribed to the `dialog` event kind.** The
 * watchdog has always answered every dialog immediately by a fixed policy — accept everything but a
 * `prompt`, dismiss that — because an unanswered dialog blocks the whole CDP channel for its target.
 * E-53 makes that policy *deferrable*: while a `dialog` subscriber exists the browser holds the
 * dialog open under an id for up to 20 s, and this tool is how a caller supplies the answer the
 * policy could not — dismissing a `confirm`, or typing into a `prompt`, neither of which was
 * reachable before. With no subscriber there is nothing held and this tool answers
 * `element-not-found`, which is the honest reply: the dialog it names is already closed.
 *
 * `prompt_text` is **never echoed**. It is caller-supplied, so echoing it is not a disclosure — it is
 * a second copy of possibly-sensitive text in a transcript, bought for no capability at all.
 */
export async function browserHandleDialog(
	args: { dialog_id: string; accept: boolean; prompt_text?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	// B3.2: exempt from the `dialog-open` refusal every other mutating tool now
	// takes, because this tool is that refusal's remedy — without the exemption it
	// would refuse itself and a held dialog would be unanswerable.
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

/**
 * `browser_drag {from, to, steps?}` — press, drag across, release (B2.5, AC-P1-21).
 *
 * Both endpoints are resolved through the click cascade's own geometry, by way of E-49's
 * `HoverEvent`, so a drag starts and ends exactly where a click on the same index would have landed
 * and no geometry is recomputed here. `to` is resolved **first** on purpose: resolving an element
 * endpoint moves the pointer to it, so resolving `from` last leaves the pointer where the press is
 * about to happen, which is the order a human's hand produces.
 */
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
	// The geometry AFTER the scroll, read live. This used to read `cachedBrowserState.pageInfo`, which
	// no action refreshes, so `scroll.y` and `pixels_above/below` were the pre-scroll values (found by
	// the E-38 security review, deferred to the slice that owns geometry). A DOM-less state request is
	// the cheap read: it skips the DOM build and, by E-36, never touches the cached index table — so
	// the `state_token` this result carries still names the table the caller is holding.
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

// --- B2.7: arbitrary in-page JavaScript, behind the explicit grant ------------

/**
 * `browser_evaluate {expression}` — run JavaScript in a frame's own main world (B2.7, D-A4).
 *
 * **The sandbox is the scope grant, not the expression subset.** This tool holds
 * `scope: 'evaluate'`, the sole member of `EXPLICIT_SCOPES`, and `registerCatalog` skips
 * registration entirely for a scope the principal does not hold — so an ungranted client never sees
 * it in `tools/list`. That gate is the whole containment boundary, and this comment says so rather
 * than implying a second one that does not exist:
 *
 * - the expression runs in the **main world**, so it sees page globals — which is the stated use
 *   case, and why an isolated world was declined (AD-5, `report_architecture.md` §7.6);
 * - it reaches the DOM, non-`HttpOnly` cookies and the network with the browser's own credentials;
 * - **`TTK_ALLOWED_DOMAINS` does not constrain it.** An in-page `fetch()` is not a navigation and
 *   passes none of D-020's three enforcement points. `SPECS/SECURITY-AUTH.md` §1 and §8 state that
 *   exception in the same change as this handler (SEC-02), and the browser tier observed it.
 *
 * There is deliberately no expression parser: a "read-only subset" was rejected as new attack
 * surface that would read as a sandbox while being an incomplete one.
 *
 * The two caps are availability controls and are recorded as such (SEC-23). The 1 s deadline stops
 * one call holding the CDP channel every other tool and the screencast share; the result-size cap
 * bounds what comes back **through the tool result**, and bounds nothing about what left through the
 * page's own network.
 *
 * A page exception is `ok: false`, not a tool error: the caller asked what the page would do, and
 * the page throwing is the answer.
 */
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

	// One audit entry per call, written whether the expression succeeded or threw — "arbitrary code
	// ran here" is the fact worth recording, and an expression that throws has still run. The body is
	// never recorded, not even a prefix: an expression is attacker-influenced text and a prefix is
	// where an exfiltrating one would put its payload (§6.5).
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

/**
 * The frame's live URL for the audit's `origin`, degrading to the empty string.
 *
 * A frame that detached between the evaluation and the ledger write must not cost the record: the
 * point of the ledger is that arbitrary code ran, and `origin: ''` says honestly that the server
 * could not name where. `browser_fill_secret` reads the URL for a *decision* and therefore refuses
 * instead — the two uses differ, and this is the one that must not fail closed.
 */
async function frameOriginFor(record: SessionRecord, frame: FrameContext): Promise<string> {
	try {
		return await liveFrameUrl(record, frame);
	} catch {
		return '';
	}
}

// --- B2.8: filling a server-held credential ----------------------------------

/**
 * `browser_fill_secret {index, secret, state_token}` — type a configured credential the model has
 * never seen (B2.8, SEC-07, SEC-24, AD-13).
 *
 * `browser_type` has accepted `<secret>name</secret>` since R14 and still does. This is the same
 * capability with the refusals SEC-07 says the older surface lacks, and it is **deliberately stricter
 * than the tool it sits beside**: once `type=text` is permitted the "is this a password field" check
 * carries no weight, so the domain pin is the only control left and an unpinned secret is refused
 * here even though `browser_type` allows one.
 *
 * Six refusals, and the order they run in is part of the contract:
 *
 * 1. **A stale or absent element table** — `element-not-found`, from `nodeAt` with the **required**
 *    `state_token`. Hard: no re-resolution, no best-effort match. `backendNodeId` is reused, so a
 *    stale index can resolve to a *different element in a new document* where the live-URL check
 *    passes because the page genuinely is the page (AD-13).
 * 2. **Not an `input` or `textarea`** — `element-not-interactable`.
 * 3. **Not a `password` or `text` input** — `element-not-interactable`.
 * 4. **An unpinned secret** (`domains: []`) — `navigation-blocked`. The narrowing above.
 * 5. **A scaled visual viewport** — `browser-unavailable`, `reason: 'viewport-scaled'` (SEC-24).
 * 6. **A frame whose own URL is cross-origin to the top document, or outside the secret's domains** —
 *    `navigation-blocked`. Read **live and per frame**, immediately before the dispatch and after the
 *    element is resolved, with no await in between beyond the dispatch itself. `SPECS/SECURITY-AUTH.md`
 *    §7.1 says "the page"; a frameset makes that ambiguous, and a page can put a same-origin `iframe`
 *    around a password field while the top URL still looks right. Both halves fail **closed** on an
 *    origin that cannot be named (SEC-FH-23): the confinement through {@linkcode isCrossOrigin}, and
 *    the pin through `urlMatch(…, 'secret')` inside `SecretStore`, which has no host to match on
 *    `about:blank`, `data:`, `blob:` or `javascript:` and refuses plaintext `http:` unless the
 *    operator pinned an explicit `http://` pattern.
 *
 * **Never a value and never a length** (DD-7, E-38). The result carries the secret's *name*, the
 * element index, the frame and the origin — nothing derived from the value, not its length, not a
 * prefix, not a hash. E-38 is the reason that sentence is here: a structured field once re-added the
 * character count the frozen text block had deliberately withheld, and one call per configured name
 * would have enumerated the exact length of every credential the deployment holds.
 */
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

	// R5 (D-125): a form-capable client may have its human choose the secret when the named one cannot be used
	// here. `offer` is true only on the first round of such a client; a retry carrying the human's choice spends
	// that name instead, through every check below — so the choice is re-validated against the live origin and
	// never trusted because it was offered. Every other client takes exactly the path it always took.
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

	// (5) SEC-24, before the URL read so that the last await before the dispatch is the URL read.
	await assertUnitViewportScale(record);

	// (6) The live, per-frame origin. Both URLs come from the browser now, not from a capture: the
	// whole failure mode is a page that moved between the read and the type.
	const frame = await frameContext(record, node.frameId ?? undefined);
	const identity = await liveFrameIdentity(record, frame);
	const frameOrigin = originOf(identity.frameUrl);
	// `isCrossOrigin`, not `originOf`-equality (SEC-FH-23). `originOf` answers the string `"null"` for
	// EVERY opaque origin, so an `about:blank` top and a `data:` child — which cannot script each
	// other — compared same-origin and the credential went in. "I cannot name this origin" and "it is
	// the same origin" are different statements; only the second may let a credential through.
	if (isCrossOrigin(identity.frameUrl, identity.topUrl)) {
		throw new ToolError(
			'navigation-blocked',
			`element ${args.index} is in a document at ${frameOrigin}, which is not the top document's origin ` +
				`(${originOf(identity.topUrl)}); a secret is never typed into a cross-origin frame, and an origin ` +
				'that cannot be named counts as a different one',
			{ index: args.index },
		);
	}
	// R5 (D-125): the named secret is not permitted on this frame's live origin. A first-round, form-capable
	// client is offered the names that are — the same `namesFor` predicate `substitute` decides with — and
	// every other caller gets the refusal `substitute` raises below, unchanged.
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

// --- R5: the secret choice (D-125) --------------------------------------------------------------------------------

/** The `inputRequests` key the secret choice rides under, and the one its answer comes back under. */
export const SECRET_CHOICE_KEY = 'ttk_secret';

/**
 * The name a retried `browser_fill_secret` carries from its human, or `undefined` on a first round.
 *
 * Declined or cancelled is `user-declined` and nothing is typed. An accepted form that names nothing usable as a
 * name — absent, empty, or longer than any configured name can be — is the client's error. The name itself is not
 * checked here: it goes through every refusal of the normal path, which is the re-validation.
 */
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
 * element's frame is read here so the offer is made for the origin the credential would go to. A frame that is
 * cross-origin to the top document is never offered anything — the normal path refuses it whatever the name.
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
 * The `input_required` offering the secrets this tool would fill at `url` — permitted there by the pin predicate
 * and pinned at all, since an unpinned secret is refused here whatever the page — or `null` when there are none to
 * offer and the caller's refusal stands. Names only: the message and the enum carry configured names and an origin,
 * never a value, a length or anything derived from one.
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
