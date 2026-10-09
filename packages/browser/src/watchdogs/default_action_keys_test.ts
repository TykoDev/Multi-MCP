/**
 * Keyboard-table contract (ARCHITECTURE.md §6.10 "per-char keyDown/char/keyUp **with VK codes**",
 * COMPLETIONS-CRITERIA.md §4 row "Input synthesis (per-char keys, VK codes, …)", parity risk R5).
 *
 * These are the values a page reads off `KeyboardEvent.keyCode` / `.code` / `.key`. A wrong one does
 * not throw anywhere — it just makes a site ignore the keystroke — so the table is pinned here rather
 * than trusted.
 */

import { assertEquals, assertThrows } from '@std/assert';
import { BrowserError } from '../errors.ts';
import {
	keySpecForCharacter,
	keySpecForName,
	MODIFIER_BITS,
	parseKeyCombo,
	parseKeys,
	selectAllModifier,
	suppressesText,
} from './default_action_keys.ts';

Deno.test("keys: the modifier bitfield is CDP's (Alt 1, Ctrl 2, Meta 4, Shift 8)", () => {
	assertEquals(MODIFIER_BITS, { alt: 1, ctrl: 2, meta: 4, shift: 8 });
});

Deno.test('keys: printable characters carry the US-layout virtual key code and `code`', () => {
	const cases: [string, string, string, number, boolean][] = [
		// character, key, code, windowsVirtualKeyCode, shift
		['a', 'a', 'KeyA', 65, false],
		['z', 'z', 'KeyZ', 90, false],
		['A', 'A', 'KeyA', 65, true],
		['0', '0', 'Digit0', 48, false],
		['7', '7', 'Digit7', 55, false],
		[' ', ' ', 'Space', 32, false],
		['-', '-', 'Minus', 189, false],
		['.', '.', 'Period', 190, false],
		['/', '/', 'Slash', 191, false],
		[';', ';', 'Semicolon', 186, false],
		['!', '!', 'Digit1', 49, true],
		['@', '@', 'Digit2', 50, true],
		['?', '?', 'Slash', 191, true],
		['_', '_', 'Minus', 189, true],
		[':', ':', 'Semicolon', 186, true],
	];
	for (const [character, key, code, vk, shift] of cases) {
		const spec = keySpecForCharacter(character);
		assertEquals([spec.key, spec.code, spec.windowsVirtualKeyCode, spec.shift], [key, code, vk, shift], character);
		assertEquals(spec.text, character, `${character} must insert itself`);
	}
});

Deno.test('keys: off-layout characters still type, they just claim no US key', () => {
	const accented = keySpecForCharacter('é');
	assertEquals([accented.code, accented.windowsVirtualKeyCode], ['', 0]);
	assertEquals(accented.text, 'é', 'the char event still carries the text');

	const cjk = keySpecForCharacter('中');
	assertEquals([cjk.code, cjk.windowsVirtualKeyCode, cjk.text], ['', 0, '中']);
});

Deno.test('keys: newline and tab resolve to their named keys, not to punctuation', () => {
	assertEquals(keySpecForCharacter('\n').code, 'Enter');
	assertEquals(keySpecForCharacter('\r').windowsVirtualKeyCode, 13);
	assertEquals(keySpecForCharacter('\t').windowsVirtualKeyCode, 9);
});

Deno.test('keys: the named-key table carries the keyCodes legacy handlers switch on', () => {
	const expected: [string, number][] = [
		['Enter', 13],
		['Tab', 9],
		['Backspace', 8],
		['Delete', 46],
		['Escape', 27],
		['ArrowUp', 38],
		['ArrowDown', 40],
		['ArrowLeft', 37],
		['ArrowRight', 39],
		['Home', 36],
		['End', 35],
		['PageUp', 33],
		['PageDown', 34],
		['Insert', 45],
		['Space', 32],
		['F1', 112],
		['F12', 123],
		['Shift', 16],
		['Control', 17],
		['Alt', 18],
		['Meta', 91],
	];
	for (const [name, vk] of expected) {
		assertEquals(keySpecForName(name)?.windowsVirtualKeyCode, vk, name);
	}
	assertEquals(keySpecForName('ENTER')?.key, 'Enter', 'names are case-insensitive');
	assertEquals(keySpecForName('page_down')?.key, 'PageDown', 'separators are ignored');
	assertEquals(keySpecForName('nope'), null);
});

Deno.test('keys: Enter and Tab carry text so keypress and the newline still happen', () => {
	assertEquals(keySpecForName('Enter')?.text, '\r');
	assertEquals(keySpecForName('Tab')?.text, '\t');
	assertEquals(keySpecForName('Escape')?.text, null, 'a non-printing key must not insert anything');
});

Deno.test('keys: combos parse into a modifier bitfield plus one key', () => {
	assertEquals(parseKeyCombo('Enter').modifiers, 0);
	assertEquals(parseKeyCombo('Enter').key.windowsVirtualKeyCode, 13);

	const selectAll = parseKeyCombo('ctrl+a');
	assertEquals(selectAll.modifiers, MODIFIER_BITS.ctrl);
	assertEquals(selectAll.key.code, 'KeyA');

	const newTab = parseKeyCombo('Ctrl+Shift+T');
	assertEquals(newTab.modifiers, MODIFIER_BITS.ctrl | MODIFIER_BITS.shift);
	assertEquals(newTab.key.code, 'KeyT');

	assertEquals(parseKeyCombo('cmd+a').modifiers, MODIFIER_BITS.meta);
	assertEquals(parseKeyCombo('command+a').modifiers, MODIFIER_BITS.meta);
	assertEquals(parseKeyCombo('option+f').modifiers, MODIFIER_BITS.alt);
});

Deno.test('keys: a shifted character contributes its own shift bit', () => {
	assertEquals(parseKeyCombo('A').modifiers, MODIFIER_BITS.shift);
	assertEquals(parseKeyCombo('ctrl+?').modifiers, MODIFIER_BITS.ctrl | MODIFIER_BITS.shift);
});

Deno.test('E-51: an explicit shift modifier shifts the LETTER, so the page sees the key a human produces', () => {
	// The defect: `shift+k` used to reach the page as key 'k' with shiftKey true, while a human
	// holding Shift and pressing K produces key 'K'. Observed on real Chromium in
	// `tests/e2e/interaction_e2e_test.ts` before the fix.
	const chord = parseKeyCombo('ctrl+shift+k');
	assertEquals(chord.key.key, 'K');
	assertEquals(chord.key.code, 'KeyK');
	assertEquals(chord.modifiers, MODIFIER_BITS.ctrl | MODIFIER_BITS.shift);
	// The uppercase spelling was always correct and is byte-for-byte unchanged.
	assertEquals(parseKeyCombo('Ctrl+Shift+K').key.key, 'K');
	// A named key is not a letter and is untouched.
	assertEquals(parseKeyCombo('shift+Tab').key.key, 'Tab');
	// Punctuation is spelled directly, because its shifted form is layout-dependent; the unshifted
	// character is what the caller asked for and is left alone.
	assertEquals(parseKeyCombo('shift+/').key.key, '/');
	// No modifier, no change: plain lowercase stays lowercase.
	assertEquals(parseKeyCombo('k').key.key, 'k');
	assertEquals(parseKeyCombo('ctrl+k').key.key, 'k');
});

Deno.test('keys: a literal plus is a key, not a separator', () => {
	const combo = parseKeyCombo('ctrl++');
	assertEquals(combo.modifiers, MODIFIER_BITS.ctrl | MODIFIER_BITS.shift);
	assertEquals(combo.key.code, 'Equal');
});

Deno.test('keys: an unknown modifier or key is a typed error, never a silent no-op', () => {
	assertThrows(() => parseKeyCombo('hyper+a'), BrowserError, "modifier 'hyper'");
	assertThrows(() => parseKeyCombo('ctrl+Frobnicate'), BrowserError, "key 'Frobnicate'");
	assertThrows(() => parseKeyCombo(''), BrowserError, 'empty key combo');
	assertThrows(() => parseKeys('   '), BrowserError, 'no keys');
});

Deno.test('keys: whitespace and commas separate a sequence of combos', () => {
	assertEquals(parseKeys('ctrl+a Delete').map((combo) => combo.source), ['ctrl+a', 'Delete']);
	assertEquals(parseKeys('ctrl+a,Delete').length, 2);
	assertEquals(parseKeys('Enter').length, 1);
});

Deno.test('keys: only Shift leaves text on a key event — every other modifier makes it a shortcut', () => {
	assertEquals(suppressesText(0), false);
	assertEquals(suppressesText(MODIFIER_BITS.shift), false);
	assertEquals(suppressesText(MODIFIER_BITS.ctrl), true);
	assertEquals(suppressesText(MODIFIER_BITS.meta), true);
	assertEquals(suppressesText(MODIFIER_BITS.alt), true);
	assertEquals(suppressesText(MODIFIER_BITS.ctrl | MODIFIER_BITS.shift), true);
});

Deno.test('keys: select-all is Meta on macOS and Ctrl everywhere else', () => {
	assertEquals(selectAllModifier('darwin'), MODIFIER_BITS.meta);
	assertEquals(selectAllModifier('linux'), MODIFIER_BITS.ctrl);
	assertEquals(selectAllModifier('windows'), MODIFIER_BITS.ctrl);
});
