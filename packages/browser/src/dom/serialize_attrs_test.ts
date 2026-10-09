/**
 * §6.5 attribute emission, one test per rule of the ordered pipeline in `serialize_attrs.ts`.
 *
 * The two order-sensitive rules get their own pins: B2-after-B1 (password scrubbing must outlive the
 * AX value override) and C6-before-D1 (dedupe before capping, or two values differing past char 100
 * collapse into one).
 */

import { assert, assertEquals } from '@std/assert';
import { buildIr, type FixtureNode } from '../../fixtures/serializer/_ir.ts';
import { buildAttributeString, capValue, DEFAULT_INCLUDE_ATTRIBUTES, isPasswordInputTag } from './serialize_attrs.ts';
import { defaultDerived } from './serialize_derived.ts';

/** Renders one node's attribute string with the default derived ops. */
function attrs(node: FixtureNode, includeAttributes?: readonly string[]): string {
	return buildAttributeString(buildIr(node), { derived: defaultDerived, includeAttributes });
}

Deno.test('dom-attrs: A1 emits whitelisted DOM attributes in source order and drops the rest', () => {
	assertEquals(
		attrs({
			tag: 'INPUT',
			attrs: { 'class': 'form-control', 'name': 'q', 'href': '/x', 'placeholder': 'Search', 'id': 'search' },
		}),
		'name=q placeholder=Search id=search',
	);
});

Deno.test('dom-attrs: A1 drops an empty value rather than rendering it', () => {
	// ERRATUM(M1-parity-3): §6.5 says empty renders `key=''`. The reference emits neither the `value=""`
	// nor the `title=""` that `form_attributes`' `#f-empty-value` carries in its markup.
	assertEquals(attrs({ tag: 'BUTTON', attrs: { 'aria-label': '', 'id': 'b' } }), 'id=b');
});

Deno.test('dom-attrs: A2 synthesises format hints for HTML5 date/time inputs', () => {
	const cases: [string, string][] = [
		['date', 'YYYY-MM-DD'],
		['time', 'HH:MM'],
		['datetime-local', 'YYYY-MM-DDTHH:MM'],
		['month', 'YYYY-MM'],
		['week', 'YYYY-W##'],
		['tel', '123-456-7890'],
	];
	for (const [type, hint] of cases) {
		// The hint fills `placeholder` as well as `format` — the field would show it if it had one.
		assertEquals(attrs({ tag: 'INPUT', attrs: { type } }), `type=${type} format=${hint} placeholder=${hint}`);
	}
	assertEquals(attrs({ tag: 'INPUT', attrs: { type: 'text' } }), 'type=text');
	// An input that already declares a placeholder gets neither half of the hint (`#f-tel`).
	assertEquals(
		attrs({ tag: 'INPUT', attrs: { type: 'tel', placeholder: '123-456-7890' } }),
		'type=tel placeholder=123-456-7890',
	);
});

Deno.test('dom-attrs: A2 datepicker classes map data-date-format, defaulting to mm/dd/yyyy', () => {
	assertEquals(attrs({ tag: 'INPUT', attrs: { class: 'datepicker' } }), 'format=mm/dd/yyyy');
	assertEquals(
		attrs({ tag: 'INPUT', attrs: { 'class': 'x date-picker', 'data-date-format': 'dd.mm.yyyy' } }),
		'format=dd.mm.yyyy',
		'the plugin attribute is mapped into format, not restated beside it',
	);
	// A native type hint wins over the plugin class.
	assertEquals(
		attrs({ tag: 'INPUT', attrs: { 'type': 'date', 'class': 'datepicker', 'data-date-format': 'dd.mm.yyyy' } }),
		'type=date data-date-format=dd.mm.yyyy format=YYYY-MM-DD placeholder=YYYY-MM-DD',
	);
});

Deno.test('dom-attrs: A2 AngularJS popup formats become expected_format', () => {
	assertEquals(
		attrs({ tag: 'INPUT', attrs: { 'uib-datepicker-popup': 'dd-MMMM-yyyy' } }),
		'expected_format=dd-MMMM-yyyy',
	);
	assertEquals(attrs({ tag: 'INPUT', attrs: { 'datepicker-popup': 'yyyy/MM/dd' } }), 'expected_format=yyyy/MM/dd');
});

Deno.test('dom-attrs: A3 AX properties overwrite same-named DOM keys in place, in Chrome order', () => {
	assertEquals(
		attrs({
			tag: 'BUTTON',
			attrs: { checked: 'checked', name: 'agree' },
			ax: { name: 'Agree to terms', props: { checked: true, level: '2' } },
		}),
		'checked=true name=agree level=2',
		'ax_name is emitted by no golden and is no longer emitted at all',
	);
	// The whitelist filters, it does not order: Chrome reports `invalid` before `checked` on a required
	// checkbox and the reference prints them that way (`#c-required`).
	assertEquals(
		attrs({ tag: 'INPUT', ax: { props: { invalid: true, focusable: true, checked: false } } }),
		'invalid=true checked=false',
	);
	// Case-sensitively: Chrome spells it `hasPopup`, the whitelist says `haspopup`, no golden has either.
	assertEquals(attrs({ tag: 'BUTTON', ax: { props: { hasPopup: 'menu', expanded: false } } }), 'expanded=false');
});

Deno.test('dom-attrs: A3 skips AX properties whose value is null', () => {
	assertEquals(attrs({ tag: 'BUTTON', ax: { props: { pressed: null, busy: true } } }), 'busy=true');
});

Deno.test('dom-attrs: B1 AX value replaces the DOM value for input/textarea/select', () => {
	assertEquals(
		attrs({ tag: 'INPUT', attrs: { type: 'text', value: 'stale' }, ax: { props: { valuetext: 'live' } } }),
		'type=text value=live valuetext=live',
	);
	assertEquals(
		attrs({ tag: 'TEXTAREA', attrs: { value: 'stale' }, ax: { props: { value: 'from-ax-value' } } }),
		'value=from-ax-value',
	);
	assertEquals(
		attrs({
			tag: 'TEXTAREA',
			ax: { props: { valuetext: 'preferred', value: 'ignored' } },
		}),
		'value=preferred',
		'valuetext outranks value; here C6 then drops it because the protected `value` carries the same 9-char string',
	);
	// An empty AX value carries nothing and must not blank the markup value (`#f-range`).
	assertEquals(
		attrs({ tag: 'INPUT', attrs: { type: 'range', value: '4' }, ax: { props: { valuetext: '' } } }),
		'type=range value=4 compound_components=(name=Value,role=slider)',
	);
	// A non value-bearing tag keeps both keys as-is.
	assertEquals(attrs({ tag: 'DIV', ax: { props: { valuetext: 'live' } } }), 'valuetext=live');
});

Deno.test('dom-attrs: B2 password fields never emit value or valuetext', () => {
	assertEquals(
		attrs({
			tag: 'INPUT',
			attrs: { type: 'password', name: 'pw', value: 'hunter2' },
			ax: { name: 'Password', props: { valuetext: 'hunter2' } },
		}),
		'type=password name=pw',
	);
});

Deno.test('dom-attrs: B2 survives a field switched to password after load', () => {
	// `el.type = 'password'` reflects to the attribute verbatim, so casing and padding are the shapes an
	// IR capture can plausibly carry.
	for (const type of ['password', 'PASSWORD', ' Password ']) {
		const rendered = attrs({
			tag: 'INPUT',
			attrs: { type, value: 'hunter2' },
			ax: { props: { valuetext: 'hunter2' } },
		});
		assert(!rendered.includes('hunter2'), `value leaked for type='${type}': ${rendered}`);
	}
	// A text-typed field the page itself declares to be a password.
	const revealed = attrs({
		tag: 'INPUT',
		attrs: { type: 'text', autocomplete: 'current-password', value: 'hunter2' },
	});
	assertEquals(revealed, 'type=text autocomplete=current-password');
	assert(isPasswordInputTag(buildIr({ tag: 'INPUT', attrs: { type: 'password' } }), 'input'));
	assert(!isPasswordInputTag(buildIr({ tag: 'DIV', attrs: { type: 'password' } }), 'div'));
});

Deno.test('dom-attrs: B2 runs after B1 — the AX override cannot resurrect a scrubbed value', () => {
	const rendered = attrs({
		tag: 'INPUT',
		attrs: { type: 'password' },
		ax: { props: { valuetext: 'typed-live-secret' } },
	});
	assertEquals(rendered, 'type=password');
});

Deno.test('dom-attrs: C1/C2 drop role and type when they restate the tag', () => {
	assertEquals(attrs({ tag: 'BUTTON', attrs: { type: 'button', role: 'button', id: 'save' } }), 'id=save');
	assertEquals(attrs({ tag: 'BUTTON', attrs: { type: 'submit', role: 'link' } }), 'type=submit role=link');
});

Deno.test('dom-attrs: C3 drops invalid=false and falsy required', () => {
	assertEquals(attrs({ tag: 'INPUT', ax: { props: { invalid: false, required: false } } }), '');
	assertEquals(
		attrs({ tag: 'INPUT', ax: { props: { invalid: 'true', required: true } } }),
		'invalid=true required=true',
	);
});

Deno.test('dom-attrs: C4 drops aria-expanded when the AX expanded property is present', () => {
	assertEquals(
		attrs({ tag: 'BUTTON', attrs: { 'aria-expanded': 'false' }, ax: { props: { expanded: true } } }),
		'expanded=true',
	);
	assertEquals(attrs({ tag: 'BUTTON', attrs: { 'aria-expanded': 'false' } }), 'aria-expanded=false');
});

Deno.test('dom-attrs: label-ish attributes that restate the element text are KEPT', () => {
	// ERRATUM(M1-parity-3): §6.5's "label-ish attrs dropped when equal to element text" cleanup is not
	// what the reference does — `#f-text-equals-label` renders `title=Save changes aria-label=Save
	// changes` directly above its own text `Save changes`. Both keys are dedupe-protected, so the
	// duplicate pair survives C6 as well.
	const node: FixtureNode = {
		tag: 'BUTTON',
		attrs: { 'aria-label': 'Submit order', 'title': 'Submit order', 'placeholder': 'Something else' },
		children: [{ text: 'Submit order' }],
	};
	assertEquals(attrs(node), 'aria-label=Submit order title=Submit order placeholder=Something else');
});

Deno.test('dom-attrs: C6 dedupes values over 5 chars, protecting the named keys', () => {
	assertEquals(
		attrs({
			tag: 'BUTTON',
			attrs: { 'id': 'duplicate-value', 'name': 'duplicate-value', 'title': 'duplicate-value', 'alt': 'x' },
		}),
		'title=duplicate-value alt=x',
		'the protected `title` claims the value; both unprotected carriers lose it',
	);
	assertEquals(
		attrs({ tag: 'BUTTON', attrs: { id: 'duplicate-value', name: 'duplicate-value' } }),
		'id=duplicate-value',
		'with no protected carrier, first occurrence wins among the rest',
	);
	// ERRATUM(M1-parity-14): a protected key claims its value regardless of position, so `name` loses
	// even when it comes first (`#f-dupe`).
	assertEquals(
		attrs({
			tag: 'INPUT',
			attrs: { 'name': 'duplicated-attribute-value', 'title': 'duplicated-attribute-value' },
		}),
		'title=duplicated-attribute-value',
	);
	// Five characters or fewer are never deduped — short values carry too little to be redundant.
	assertEquals(attrs({ tag: 'BUTTON', attrs: { id: 'abcde', name: 'abcde' } }), 'id=abcde name=abcde');
});

Deno.test('dom-attrs: D1 caps every value at 100 characters with an ellipsis', () => {
	const exactly100 = '0123456789'.repeat(10);
	assertEquals(capValue(exactly100), exactly100);
	assertEquals(capValue(`${exactly100}X`), `${exactly100}...`);
	assertEquals(attrs({ tag: 'BUTTON', attrs: { title: `${exactly100}X` } }), `title=${exactly100}...`);
});

Deno.test('dom-attrs: C6 runs before D1 — values differing past char 100 stay distinct', () => {
	const prefix = 'x'.repeat(100);
	const rendered = attrs({ tag: 'BUTTON', attrs: { id: `${prefix}A`, name: `${prefix}B` } });
	assertEquals(rendered, `id=${prefix}... name=${prefix}...`);
});

Deno.test('dom-attrs: E1 appends compound_components last, uncapped and undeduped', () => {
	const long = 'y'.repeat(150);
	const rendered = attrs({
		tag: 'DIV',
		attrs: { name: long },
		compound: [{ name: 'Volume', role: 'slider', options: 'a|b|c' }, { name: 'Mute', role: 'switch' }],
	});
	assertEquals(
		rendered,
		`name=${'y'.repeat(100)}... compound_components=(name=Volume,role=slider,options=a|b|c),(name=Mute,role=switch)`,
	);
});

Deno.test('dom-attrs: includeAttributes narrows every source, including AX and synthetic keys', () => {
	const node: FixtureNode = {
		tag: 'INPUT',
		attrs: { type: 'date', name: 'when', id: 'd' },
		ax: { name: 'When', props: { required: true } },
	};
	assertEquals(attrs(node, ['name']), 'name=when');
	assertEquals(attrs(node, ['format']), 'format=YYYY-MM-DD');
	assertEquals(attrs(node, ['required']), 'required=true');
	assert(!DEFAULT_INCLUDE_ATTRIBUTES.includes('ax_name'), 'no golden emits ax_name');
	assert(!DEFAULT_INCLUDE_ATTRIBUTES.includes('multiple'), 'no golden emits multiple');
	for (const key of ['aria-checked', 'aria-autocomplete', 'aria-placeholder', 'aria-valuenow']) {
		assert(DEFAULT_INCLUDE_ATTRIBUTES.includes(key), `${key} appears in the goldens`);
	}
});

Deno.test('dom-attrs: src is never emitted, frames included', () => {
	// ERRATUM(M1-dom-serialize-11 REVERSED): §6.4's grammar example shows `<iframe src=... />`; none of
	// the reference's four iframe lines carries a `src`, and §6.5's whitelist never had one.
	assertEquals(attrs({ tag: 'IFRAME', attrs: { src: '/inner.html', name: 'inner' } }), 'name=inner');
	assertEquals(attrs({ tag: 'FRAME', attrs: { src: '/inner.html' } }), '');
	assertEquals(attrs({ tag: 'IMG', attrs: { src: '/logo.png', alt: 'Logo' } }), 'alt=Logo');
});

Deno.test('dom-attrs: E1 synthesises compound_components for the five UA widget kinds', () => {
	assertEquals(
		attrs({
			tag: 'SELECT',
			attrs: { id: 's' },
			children: [
				{ tag: 'OPTION', children: [{ text: 'One' }] },
				{ tag: 'OPTGROUP', children: [{ tag: 'OPTION', children: [{ text: 'Two' }] }] },
			],
		}),
		'id=s compound_components=(name=Dropdown Toggle,role=button),' +
			'(name=Options,role=listbox,count=2,options=One|Two)',
	);
	assertEquals(
		attrs({ tag: 'DETAILS' }),
		'compound_components=(name=Toggle Disclosure,role=button),(name=Content Area,role=region)',
	);
	assertEquals(
		attrs({ tag: 'INPUT', attrs: { type: 'range', min: '0', max: '10' } }),
		'type=range min=0 max=10 compound_components=(name=Value,role=slider,min=0.0,max=10.0)',
	);
	// A plain text input has a user-agent shadow root too, and is not compound.
	assertEquals(attrs({ tag: 'INPUT', attrs: { type: 'text' } }), 'type=text');
});
