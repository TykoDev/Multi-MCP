/**
 * @module
 * Text entry: focus, the clear strategies, per-character `keyDown`/`char`/`keyUp`, the framework-event
 * triggering that defeats React's value tracker, and direct value assignment for the inputs the
 * browser owns the editing UI of.
 *
 * Contract owner: SPECS/ARCHITECTURE.md §6.10 — "typing (per-char keyDown/char/keyUp with
 * framework-event triggering, clear strategies, special-input direct value assignment)". This is the
 * core of parity risk **R5** (SPECS/ROADMAP.md): a controlled React input that never sees `keypress`,
 * or whose `_valueTracker` still holds the new value when `input` fires, silently reverts to its old
 * value on the next render. No test catches that; every real site does.
 *
 * ## The three-event contract, and why it is three
 *
 * Per character the sequence is `keyDown` (no `text`) → `char` (carrying `text`) → `keyUp`. Chrome
 * turns that into `keydown` → `keypress` + `textInput` → `input` → `keyup`, which is exactly what a
 * physical keyboard produces. Folding the text onto the `keyDown` instead (the shorter spelling) also
 * inserts the character, but a page that calls `preventDefault()` in `keypress` — every input mask,
 * every numeric-only field — can no longer stop it, and a page listening for `keypress` never hears
 * one.
 */

import type { CdpClient, SessionId } from '@tykotech/cdp';
import type { EnhancedDomTreeNode } from '../dom/types.ts';
import {
	type KeyCombo,
	type KeySpec,
	keySpecForCharacter,
	keySpecForName,
	MODIFIER_BITS,
	selectAllModifier,
	suppressesText,
} from './default_action_keys.ts';
import { callOnNode, ensureDomEnabled, needsDirectValueAssignment, type NodeHandle } from './default_action_dom.ts';

/** Which clear strategy emptied the field (ARCHITECTURE.md §6.10 "clear strategies"). */
export type ClearStrategy = 'selectAllDelete' | 'backspace' | 'directValue' | 'alreadyEmpty' | 'failed';

/** How the text was entered. */
export type TypeStrategy = 'perCharacter' | 'directValue';

/** Cap on the per-character `Backspace` fallback, so a pathological field cannot stall a step. */
export const MAX_BACKSPACE_CLEAR_KEYS = 500;

// ---------------------------------------------------------------------------
// raw key dispatch
// ---------------------------------------------------------------------------

/** Where key events go: always a session, never a node — the focused element receives them. */
export interface KeyTarget {
	readonly client: CdpClient;
	readonly sessionId: SessionId;
}

/**
 * One printable character as three events.
 *
 * The `keyDown` deliberately carries no `text` (see the module note); the `char` event carries it.
 * `unmodifiedText` is what the key would produce without modifiers, which is how Chrome derives
 * `KeyboardEvent.charCode` for legacy handlers.
 */
export async function typeCharacter(target: KeyTarget, character: string, modifiers = 0): Promise<void> {
	const key = keySpecForCharacter(character);
	const effective = modifiers | (key.shift ? MODIFIER_BITS.shift : 0);
	await target.client.send.Input.dispatchKeyEvent({
		type: 'keyDown',
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.windowsVirtualKeyCode,
		nativeVirtualKeyCode: key.windowsVirtualKeyCode,
		modifiers: effective,
	}, target.sessionId);
	await target.client.send.Input.dispatchKeyEvent({
		type: 'char',
		key: key.key,
		text: character,
		unmodifiedText: character.toLowerCase(),
		modifiers: effective,
	}, target.sessionId);
	await target.client.send.Input.dispatchKeyEvent({
		type: 'keyUp',
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.windowsVirtualKeyCode,
		nativeVirtualKeyCode: key.windowsVirtualKeyCode,
		modifiers: effective,
	}, target.sessionId);
}

/**
 * One named key or combo as `keyDown` + `keyUp`.
 *
 * A non-Shift modifier suppresses `text`, so `ctrl+a` selects instead of typing an `a` — the single
 * most common way a synthesized shortcut corrupts a field.
 */
export async function pressKey(target: KeyTarget, key: KeySpec, modifiers = 0): Promise<void> {
	const withText = !suppressesText(modifiers) && key.text !== null;
	const base = {
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.windowsVirtualKeyCode,
		nativeVirtualKeyCode: key.windowsVirtualKeyCode,
		modifiers,
		location: key.location,
	};
	await target.client.send.Input.dispatchKeyEvent({
		type: withText ? 'keyDown' : 'rawKeyDown',
		...base,
		...(withText && key.text !== null ? { text: key.text, unmodifiedText: key.text } : {}),
	}, target.sessionId);
	await target.client.send.Input.dispatchKeyEvent({ type: 'keyUp', ...base }, target.sessionId);
}

/** Sends one parsed `sendKeys` combo. */
export async function pressCombo(target: KeyTarget, combo: KeyCombo): Promise<void> {
	await pressKey(target, combo.key, combo.modifiers);
}

// ---------------------------------------------------------------------------
// focus
// ---------------------------------------------------------------------------

/** `document.activeElement === this`, checked from inside the element's own document. */
const IS_FOCUSED_FUNCTION = `function () {
	const doc = this.ownerDocument;
	let active = doc.activeElement;
	for (let depth = 0; depth < 16 && active !== null && active.shadowRoot !== null; depth++) {
		const inner = active.shadowRoot.activeElement;
		if (inner === null) break;
		active = inner;
	}
	return active === this;
}`;

/** `HTMLElement.focus()` in the page — the fallback when `DOM.focus` refuses. */
const JS_FOCUS_FUNCTION = `function () {
	if (typeof this.focus === 'function') this.focus({ preventScroll: true });
	return this.ownerDocument.activeElement === this;
}`;

/** Focus a node: `DOM.focus` first, then `element.focus()`. Reports whether it took. */
export async function focusNode(handle: NodeHandle): Promise<boolean> {
	await ensureDomEnabled(handle.client, handle.sessionId);
	try {
		await handle.client.send.DOM.focus({ backendNodeId: handle.backendNodeId }, handle.sessionId);
	} catch {
		// `DOM.focus` throws for non-focusable elements; contenteditable hosts in particular.
	}
	if (await isFocused(handle)) return true;
	try {
		await callOnNode<boolean>(handle, JS_FOCUS_FUNCTION);
	} catch {
		return false;
	}
	return await isFocused(handle);
}

async function isFocused(handle: NodeHandle): Promise<boolean> {
	try {
		return await callOnNode<boolean>(handle, IS_FOCUSED_FUNCTION) === true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// value read/write + the framework-event triggering
// ---------------------------------------------------------------------------

/** Current value of an input/textarea/select, or the text of a contenteditable host. */
const READ_VALUE_FUNCTION = `function () {
	if (typeof this.value === 'string') return this.value;
	return this.isContentEditable ? this.textContent : null;
}`;

/**
 * Direct value assignment **plus** the React value-tracker defeat.
 *
 * Three things have to happen in this exact order or a controlled component reverts:
 *
 * 1. assign through the **prototype's** native setter, not `element.value = …`. React replaces the
 *    instance property with its own accessor; going through the prototype writes the real value
 *    without notifying React's tracker;
 * 2. rewind `element._valueTracker` to the value the field held *before* the write. React compares
 *    the tracker against the live value inside its `onChange` plumbing and swallows the event when
 *    they agree — leaving the tracker holding the new value is precisely how a synthesized change
 *    gets dropped;
 * 3. dispatch `input` **and** `change`, bubbling and composed, so listeners on ancestors and outside
 *    a shadow boundary see them.
 *
 * A field whose old value equals the new one gets the tracker rewound to `''` instead, so even a
 * no-op write produces a change React believes.
 */
const ASSIGN_VALUE_FUNCTION = `function (value) {
	const element = this;
	const text = String(value);
	if (element.isContentEditable && typeof element.value !== 'string') {
		element.textContent = text;
		element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
		element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		return element.textContent;
	}
	const previous = typeof element.value === 'string' ? element.value : '';
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
	if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(element, text);
	else element.value = text;
	const tracker = element._valueTracker;
	if (tracker !== undefined && tracker !== null && typeof tracker.setValue === 'function') {
		tracker.setValue(previous === text ? '' : previous);
	}
	element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
	element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
	return typeof element.value === 'string' ? element.value : element.textContent;
}`;

/** Reads the element's live value (`''` when it has none). */
export async function readValue(handle: NodeHandle): Promise<string> {
	const value = await callOnNode<string | null>(handle, READ_VALUE_FUNCTION);
	return value ?? '';
}

/** Assigns a value directly and fires the framework events. Returns the value that stuck. */
export async function assignValue(handle: NodeHandle, value: string): Promise<string> {
	const result = await callOnNode<string | null>(handle, ASSIGN_VALUE_FUNCTION, [value]);
	return result ?? '';
}

// ---------------------------------------------------------------------------
// clearing
// ---------------------------------------------------------------------------

/** Options for {@linkcode clearField}. */
export interface ClearOptions {
	readonly handle: NodeHandle;
	/** Where key events go — the page session, not the node's, when they differ. */
	readonly keys: KeyTarget;
	/** Overrides the platform select-all modifier; tests pin both arms. */
	readonly os?: typeof Deno.build.os;
}

/**
 * Empties a field, escalating only as far as it has to.
 *
 * 1. **select-all + Delete** through real key events. Framework-faithful: the page sees the same
 *    events a user produces, so masks, validators and `onChange` all run;
 * 2. **Backspace per remaining character** — for editors that ignore `Delete` on a full selection
 *    (contenteditable rich-text surfaces mostly);
 * 3. **direct assignment to `''`** with the tracker defeat — always works, but the page never sees
 *    the keystrokes, which is why it is last.
 */
export async function clearField(options: ClearOptions): Promise<ClearStrategy> {
	const { handle, keys } = options;
	if ((await readValue(handle)) === '') return 'alreadyEmpty';

	const selectAll = keySpecForCharacter('a');
	const del = keySpecForName('Delete');
	if (del !== null) {
		await pressKey(keys, selectAll, selectAllModifier(options.os ?? Deno.build.os));
		await pressKey(keys, del);
		if ((await readValue(handle)) === '') return 'selectAllDelete';
	}

	const backspace = keySpecForName('Backspace');
	const remaining = await readValue(handle);
	if (backspace !== null && remaining !== '' && remaining.length <= MAX_BACKSPACE_CLEAR_KEYS) {
		const end = keySpecForName('End');
		if (end !== null) await pressKey(keys, end);
		for (let index = 0; index < remaining.length; index++) await pressKey(keys, backspace);
		if ((await readValue(handle)) === '') return 'backspace';
	}

	await assignValue(handle, '');
	return (await readValue(handle)) === '' ? 'directValue' : 'failed';
}

// ---------------------------------------------------------------------------
// typing
// ---------------------------------------------------------------------------

/** Options for {@linkcode typeIntoNode}. */
export interface TypeOptions {
	readonly handle: NodeHandle;
	readonly keys: KeyTarget;
	readonly node: EnhancedDomTreeNode;
	readonly text: string;
	readonly clear: boolean;
	readonly os?: typeof Deno.build.os;
}

/** What the typing path did, so the watchdog can report it and the tests can pin it. */
export interface TypeOutcome {
	readonly strategy: TypeStrategy;
	readonly clearStrategy: ClearStrategy | null;
	readonly focused: boolean;
	/** The element's value after typing. */
	readonly actualValue: string;
	/** `true` when the field ended up holding exactly what was asked for. */
	readonly matched: boolean;
}

/**
 * Focus → clear → enter text → read back.
 *
 * `<input type=date|color|range|…>` takes the direct-assignment path: the browser owns their editing
 * UI, so per-character keys either do nothing or produce a partial value ("2024-" for a date field),
 * which is worse than not typing at all. Everything else — including every React-controlled text
 * input — goes through the three-event per-character contract, and is followed by an `input`/`change`
 * pair so frameworks that only listen for those still commit the value.
 */
export async function typeIntoNode(options: TypeOptions): Promise<TypeOutcome> {
	const { handle, keys, node, text } = options;
	const focused = await focusNode(handle);

	let clearStrategy: ClearStrategy | null = null;
	if (options.clear) {
		const clearOptions: ClearOptions = options.os === undefined ? { handle, keys } : { handle, keys, os: options.os };
		clearStrategy = await clearField(clearOptions);
	}

	if (needsDirectValueAssignment(node)) {
		const actual = await assignValue(handle, text);
		return { strategy: 'directValue', clearStrategy, focused, actualValue: actual, matched: actual === text };
	}

	for (const character of text) await typeCharacter(keys, character);

	// Only `change`. Chrome already fired one `input` per character — a second would double every
	// debounce and analytics counter on the page — but it withholds `change` until the field is
	// blurred, and a framework bound to `change` alone would otherwise never see the value.
	await fireFrameworkEvents(handle);

	const actual = await readValue(handle);
	return { strategy: 'perCharacter', clearStrategy, focused, actualValue: actual, matched: actual === text };
}

/** `change`, bubbling and composed, without touching the value. */
const FIRE_EVENTS_FUNCTION = `function () {
	this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
	return true;
}`;

/**
 * Fires the commit event on a node whose value key events already changed.
 *
 * ERRATUM(M1-watchdogs-action-13): §6.10 says "framework-event triggering" without naming the events.
 * After the per-character path it is `change` **only**: the browser produced a genuine `input` per
 * character, and re-firing it would make every page that counts input events (debounces, analytics,
 * validation-on-Nth-keystroke) see the field typed twice. `change` is the one event Chrome withholds
 * — it waits for blur — so it is the one that has to be synthesized. The direct-assignment path in
 * {@linkcode assignValue} still fires both, because there nothing else fired either.
 */
export async function fireFrameworkEvents(handle: NodeHandle): Promise<void> {
	try {
		await callOnNode<boolean>(handle, FIRE_EVENTS_FUNCTION);
	} catch {
		// The element went away mid-type (a re-render replaced it); the value read-back reports it.
	}
}
