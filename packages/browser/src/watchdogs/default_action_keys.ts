/**
 * @module
 * Keyboard synthesis tables — the Windows virtual-key codes, `code` values and modifier bitfield that
 * `Input.dispatchKeyEvent` needs to look like a real keyboard.
 *
 * Contract owner: SPECS/ARCHITECTURE.md §6.10 ("typing (per-char keyDown/char/keyUp **with VK codes**,
 * framework-event triggering, clear strategies, special-input direct value assignment)",
 * "sendKeys combos"); parity risk **R5** in SPECS/ROADMAP.md §"Input-synthesis fidelity" and the
 * COMPLETIONS-CRITERIA.md §4 row "Input synthesis (per-char keys, VK codes, React value-tracker
 * defeat, occlusion)".
 *
 * ## Why the VK code is load-bearing
 *
 * A `keydown` without `windowsVirtualKeyCode` arrives at the page with `event.keyCode === 0`. Every
 * hand-rolled autocomplete, every "press Enter to submit" handler, every `keyCode === 13` branch in a
 * decade of jQuery still shipping on real sites reads that field. Sites do not break in tests when it
 * is wrong — they break in production, silently, by ignoring the keystroke. Same for `code`
 * (`'KeyA'`, `'Digit1'`): framework key handlers switch on it because it is layout-independent.
 *
 * This module is pure: tables and parsing, no CDP, no I/O. The dispatch side lives in
 * `default_action_input.ts`.
 */

import { BrowserError } from '../errors.ts';

/** CDP `Input.dispatchKeyEvent` modifier bitfield: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. */
export const MODIFIER_BITS = {
	alt: 1,
	ctrl: 2,
	meta: 4,
	shift: 8,
} as const;

export type ModifierName = keyof typeof MODIFIER_BITS;

/** Accepted spellings for each modifier, so `cmd+a`, `Meta+A` and `Command+a` all parse. */
export const MODIFIER_ALIASES: Readonly<Record<string, ModifierName>> = {
	alt: 'alt',
	option: 'alt',
	ctrl: 'ctrl',
	control: 'ctrl',
	meta: 'meta',
	cmd: 'meta',
	command: 'meta',
	super: 'meta',
	win: 'meta',
	shift: 'shift',
};

/** One synthesized key: everything `Input.dispatchKeyEvent` wants for one physical key press. */
export interface KeySpec {
	/** DOM `KeyboardEvent.key` (`'a'`, `'A'`, `'Enter'`, `'ArrowDown'`). */
	readonly key: string;
	/** DOM `KeyboardEvent.code` (`'KeyA'`, `'Digit1'`, `'Enter'`); `''` for keys off the US layout. */
	readonly code: string;
	/** `KeyboardEvent.keyCode`/`which`. `0` when the character has no US-layout key. */
	readonly windowsVirtualKeyCode: number;
	/** Text this key inserts, or `null` for a non-printing key. */
	readonly text: string | null;
	/** `true` when producing the character requires Shift (`'A'`, `'!'`). */
	readonly shift: boolean;
	/** CDP key location: 0 standard, 1 left modifier, 2 right modifier, 3 numpad. */
	readonly location: number;
}

function spec(init: Partial<KeySpec> & Pick<KeySpec, 'key' | 'code' | 'windowsVirtualKeyCode'>): KeySpec {
	return {
		key: init.key,
		code: init.code,
		windowsVirtualKeyCode: init.windowsVirtualKeyCode,
		text: init.text ?? null,
		shift: init.shift ?? false,
		location: init.location ?? 0,
	};
}

/**
 * Named keys `sendKeys` accepts, keyed by their lower-cased name.
 *
 * `Enter` and `Tab` carry text (`'\r'`, `'\t'`): Chrome turns a `keyDown` with text into the
 * `keypress` + `input` pair that a form's submit handler and a textarea's newline both depend on.
 */
export const NAMED_KEYS: Readonly<Record<string, KeySpec>> = {
	enter: spec({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }),
	return: spec({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }),
	numpadenter: spec({ key: 'Enter', code: 'NumpadEnter', windowsVirtualKeyCode: 13, text: '\r', location: 3 }),
	tab: spec({ key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' }),
	backspace: spec({ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }),
	delete: spec({ key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }),
	del: spec({ key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }),
	escape: spec({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }),
	esc: spec({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }),
	space: spec({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }),
	arrowup: spec({ key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }),
	arrowdown: spec({ key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }),
	arrowleft: spec({ key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }),
	arrowright: spec({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }),
	up: spec({ key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }),
	down: spec({ key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }),
	left: spec({ key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }),
	right: spec({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }),
	home: spec({ key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }),
	end: spec({ key: 'End', code: 'End', windowsVirtualKeyCode: 35 }),
	pageup: spec({ key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }),
	pagedown: spec({ key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }),
	insert: spec({ key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 }),
	shift: spec({ key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 }),
	control: spec({ key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, location: 1 }),
	alt: spec({ key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, location: 1 }),
	meta: spec({ key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 }),
	capslock: spec({ key: 'CapsLock', code: 'CapsLock', windowsVirtualKeyCode: 20 }),
	f1: spec({ key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 }),
	f2: spec({ key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 }),
	f3: spec({ key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 }),
	f4: spec({ key: 'F4', code: 'F4', windowsVirtualKeyCode: 115 }),
	f5: spec({ key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 }),
	f6: spec({ key: 'F6', code: 'F6', windowsVirtualKeyCode: 117 }),
	f7: spec({ key: 'F7', code: 'F7', windowsVirtualKeyCode: 118 }),
	f8: spec({ key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 }),
	f9: spec({ key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 }),
	f10: spec({ key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 }),
	f11: spec({ key: 'F11', code: 'F11', windowsVirtualKeyCode: 122 }),
	f12: spec({ key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 }),
};

/** US-layout punctuation reachable without Shift: char → `[code, virtual key]`. */
const UNSHIFTED_PUNCTUATION: Readonly<Record<string, readonly [string, number]>> = {
	' ': ['Space', 32],
	'`': ['Backquote', 192],
	'-': ['Minus', 189],
	'=': ['Equal', 187],
	'[': ['BracketLeft', 219],
	']': ['BracketRight', 221],
	'\\': ['Backslash', 220],
	';': ['Semicolon', 186],
	"'": ['Quote', 222],
	',': ['Comma', 188],
	'.': ['Period', 190],
	'/': ['Slash', 191],
};

/** US-layout punctuation reached with Shift: char → `[code, virtual key]` of the *unshifted* key. */
const SHIFTED_PUNCTUATION: Readonly<Record<string, readonly [string, number]>> = {
	'~': ['Backquote', 192],
	'!': ['Digit1', 49],
	'@': ['Digit2', 50],
	'#': ['Digit3', 51],
	$: ['Digit4', 52],
	'%': ['Digit5', 53],
	'^': ['Digit6', 54],
	'&': ['Digit7', 55],
	'*': ['Digit8', 56],
	'(': ['Digit9', 57],
	')': ['Digit0', 48],
	_: ['Minus', 189],
	'+': ['Equal', 187],
	'{': ['BracketLeft', 219],
	'}': ['BracketRight', 221],
	'|': ['Backslash', 220],
	':': ['Semicolon', 186],
	'"': ['Quote', 222],
	'<': ['Comma', 188],
	'>': ['Period', 190],
	'?': ['Slash', 191],
};

/**
 * The key that produces `character`.
 *
 * Off-layout characters (accents, CJK, emoji) get `code: ''` and `windowsVirtualKeyCode: 0`, which is
 * what a real IME-composed character reports too — the `char` event still carries the text, so they
 * are typed correctly, they just do not pretend to come from a US key.
 */
export function keySpecForCharacter(character: string): KeySpec {
	if (character === '\n') return NAMED_KEYS.enter as KeySpec;
	if (character === '\r') return NAMED_KEYS.enter as KeySpec;
	if (character === '\t') return NAMED_KEYS.tab as KeySpec;

	if (character >= 'a' && character <= 'z') {
		const upper = character.toUpperCase();
		return spec({ key: character, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: character });
	}
	if (character >= 'A' && character <= 'Z') {
		return spec({
			key: character,
			code: `Key${character}`,
			windowsVirtualKeyCode: character.charCodeAt(0),
			text: character,
			shift: true,
		});
	}
	if (character >= '0' && character <= '9') {
		return spec({
			key: character,
			code: `Digit${character}`,
			windowsVirtualKeyCode: character.charCodeAt(0),
			text: character,
		});
	}

	const unshifted = UNSHIFTED_PUNCTUATION[character];
	if (unshifted !== undefined) {
		return spec({ key: character, code: unshifted[0], windowsVirtualKeyCode: unshifted[1], text: character });
	}
	const shifted = SHIFTED_PUNCTUATION[character];
	if (shifted !== undefined) {
		return spec({
			key: character,
			code: shifted[0],
			windowsVirtualKeyCode: shifted[1],
			text: character,
			shift: true,
		});
	}
	return spec({ key: character, code: '', windowsVirtualKeyCode: 0, text: character });
}

/** A named key (case-insensitive), or `null` when the name is not one. */
export function keySpecForName(name: string): KeySpec | null {
	return NAMED_KEYS[name.toLowerCase().replaceAll(/[\s_-]/g, '')] ?? null;
}

/** One parsed `sendKeys` token: the modifier bitfield plus the key it decorates. */
export interface KeyCombo {
	readonly modifiers: number;
	readonly key: KeySpec;
	/** The token as written, for logs and error messages. */
	readonly source: string;
}

/**
 * Parses one combo — `'Enter'`, `'ctrl+a'`, `'Ctrl+Shift+T'`, `'cmd++'`.
 *
 * The final `+` of `'ctrl++'` is the key, not a separator; a trailing empty token is folded back into
 * a literal plus so the obvious spelling works.
 */
export function parseKeyCombo(combo: string): KeyCombo {
	const trimmed = combo.trim();
	if (trimmed === '') throw new BrowserError('sendKeys received an empty key combo');

	const tokens = trimmed.split('+');
	// `'ctrl++'` splits to ['ctrl', '', ''] — the last two are one literal '+'.
	if (tokens.length > 1 && tokens[tokens.length - 1] === '') {
		tokens.splice(tokens.length - 2, 2, '+');
	}
	const keyToken = tokens[tokens.length - 1] ?? '';
	if (keyToken === '') throw new BrowserError(`sendKeys could not find a key in '${combo}'`);

	let modifiers = 0;
	for (const token of tokens.slice(0, -1)) {
		const modifier = MODIFIER_ALIASES[token.trim().toLowerCase()];
		if (modifier === undefined) throw new BrowserError(`sendKeys does not know the modifier '${token}' in '${combo}'`);
		modifiers |= MODIFIER_BITS[modifier];
	}

	const named = keySpecForName(keyToken);
	// ERRATUM(E-51). An explicit `shift` modifier used to leave the key spec unshifted, so
	// `shift+k` reached the page as `KeyboardEvent.key === 'k'` while a human holding Shift and
	// pressing K produces `'K'` — a divergence between the tool path and the Live View path on
	// exactly the field §10 says must be reproducible, and one that any handler switching on `e.key`
	// would act on. Letters only: the shifted form of a punctuation key is layout-dependent, and it is
	// already reachable by writing the character itself (`?` rather than `shift+/`), which is how
	// SHIFTED_PUNCTUATION is keyed. `Shift+T` was always correct and is unchanged.
	const shifted = (modifiers & MODIFIER_BITS.shift) !== 0 && /^[a-z]$/.test(keyToken)
		? keyToken.toUpperCase()
		: keyToken;
	const key = named ?? ([...shifted].length === 1 ? keySpecForCharacter(shifted) : null);
	if (key === null) throw new BrowserError(`sendKeys does not know the key '${keyToken}' in '${combo}'`);
	if (key.shift) modifiers |= MODIFIER_BITS.shift;
	return { modifiers, key, source: trimmed };
}

/**
 * Splits a `SendKeysEvent.keys` string into combos.
 *
 * Whitespace and commas separate combos, so `'ctrl+a Delete'` and `'ctrl+a,Delete'` both send two.
 * A single combo — the common case — is unaffected.
 */
export function parseKeys(keys: string): KeyCombo[] {
	const tokens = keys.split(/[\s,]+/).filter((token) => token !== '');
	if (tokens.length === 0) throw new BrowserError('sendKeys received no keys');
	return tokens.map(parseKeyCombo);
}

/**
 * `true` when the modifier set suppresses text insertion.
 *
 * Shift is the exception: `Shift+a` types `A`. Any other modifier turns the key into a shortcut, and
 * dispatching text with it would insert a stray character *and* fire the shortcut.
 */
export function suppressesText(modifiers: number): boolean {
	return (modifiers & ~MODIFIER_BITS.shift) !== 0;
}

/** The select-all modifier for a platform: Meta on macOS, Ctrl everywhere else. */
export function selectAllModifier(os: typeof Deno.build.os = Deno.build.os): number {
	return os === 'darwin' ? MODIFIER_BITS.meta : MODIFIER_BITS.ctrl;
}
