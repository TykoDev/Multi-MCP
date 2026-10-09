/// <reference lib="deno.ns" />
/**
 * BUG-4 / FE-1 / CR-5 (review): what `installTooltips` does on `focusin`, as a pure decision.
 *
 * With the pointer resting on a `[data-tip]` wrapper (a Resources editor `lib-field`), Tabbing into that wrapper's input left
 * the wrapper's tip open over the field being typed in: `focusout` keeps a tip when focus moves inside a tooltip owner
 * (RV-13), and `focusin` hid only when the shown tip belonged to another element. The non-show branch now hides
 * whatever tip is showing.
 *
 * @module
 */
import { assertEquals } from '@std/assert';
import { focusTipAction } from './ui.ts';

Deno.test('BUG-4: Tab into a field inside the hovered wrapper hides the wrapper’s tip', () => {
	// focused INPUT inside the `[data-tip]` wrapper whose tip is already showing (pointer hover).
	assertEquals(
		focusTipAction({ hasTarget: true, focusVisible: true, wrappedField: true, tipShowing: true }),
		'hide',
	);
});

Deno.test('BUG-4: the decisions RV-13 and the other paths rely on are unchanged', () => {
	// RV-13: keyboard focus on a tile or icon button (its own tip) shows it, re-targeting from any previous one.
	assertEquals(
		focusTipAction({ hasTarget: true, focusVisible: true, wrappedField: false, tipShowing: true }),
		'show',
	);
	assertEquals(
		focusTipAction({ hasTarget: true, focusVisible: true, wrappedField: false, tipShowing: false }),
		'show',
	);
	// Focus that is not keyboard-visible never shows a tip; one already showing goes.
	assertEquals(
		focusTipAction({ hasTarget: true, focusVisible: false, wrappedField: false, tipShowing: true }),
		'hide',
	);
	// Focus onto an element with no tooltip owner: hide a showing tip, otherwise nothing to do.
	assertEquals(
		focusTipAction({ hasTarget: false, focusVisible: true, wrappedField: false, tipShowing: true }),
		'hide',
	);
	assertEquals(
		focusTipAction({
			hasTarget: false,
			focusVisible: true,
			wrappedField: false,
			tipShowing: false,
		}),
		'keep',
	);
	// A field in a wrapper with no tip showing: nothing to show, nothing to hide.
	assertEquals(
		focusTipAction({ hasTarget: true, focusVisible: true, wrappedField: true, tipShowing: false }),
		'keep',
	);
});
