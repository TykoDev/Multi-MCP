/**
 * Attribute emission, implemented as one ordered pipeline.
 *
 * Order is the whole contract here: dedupe before capping keeps two long values that differ past
 * char 100 distinguishable, capping before dedupe would collapse them. Cleanups run before caps and
 * `compound_components` is *appended*, so the pipeline runs:
 *
 * | # | stage | rule |
 * |---|---|---|
 * | A1 | collect | DOM attributes in source order, filtered by the include-set; empty values dropped |
 * | A2 | collect | synthetic `format` (+ mirrored `placeholder`) / `expected_format` hints |
 * | A3 | collect | AX properties in **Chrome's** order; same-named keys overwrite in place |
 * | B1 | override | AX value wins over DOM value for input/textarea/select |
 * | B2 | scrub | `value`/`valuetext` deleted for password fields — anti-exfiltration |
 * | C1 | cleanup | `role` dropped when equal to the tag |
 * | C2 | cleanup | `type` dropped when equal to the tag |
 * | C3 | cleanup | `invalid=false` and falsy `required` dropped |
 * | C4 | cleanup | `aria-expanded` dropped when the AX `expanded` property is present |
 * | C6 | cleanup | duplicate values >5 chars deduped, protected keys exempt |
 * | D1 | cap | every value capped at 100 chars with `...` |
 * | E1 | append | `compound_components=(…)`, uncapped and never deduped |
 * | F1 | render | `key=value` joined by single spaces, no quoting |
 *
 * B2 running after B1 is not cosmetic: B1 would otherwise re-populate `value` from the AX tree with the
 * live typed password.
 *
 * Three stages are absent on purpose, because the recorded reference corpus does not have them:
 *
 * - **A4 `ax_name`** — **zero** of the 25 goldens contain the token; emitting it would diverge on
 *   17 pages.
 * - **C5 label-ish-equals-text removal** — the reference keeps them: `f-text-equals-label` renders
 *   `title=Save changes aria-label=Save changes` above the text `Save changes`.
 * - **`key=''` for empty values** — `f-empty-value` carries `value=""` and `title=""` in its markup
 *   and the golden emits neither.
 */

import type { EnhancedDomTreeNode } from './types.ts';
import { collapseWhitespace, type SerializerDerived } from './serialize_derived.ts';
import { isPasswordField as isPasswordNode } from './derived.ts';
import { compoundComponentsValue } from './serialize_compound.ts';

/**
 * Attribute whitelist — DOM-sourced names, matched against the recorded corpus.
 *
 * `aria-checked`, `aria-autocomplete`, `aria-placeholder`, `aria-valuemin`, `aria-valuemax` and
 * `aria-valuenow` are in because all six appear in goldens. `multiple` is out: `f-file` and
 * `sel-multi` both carry it in their markup and neither golden prints it. Deliberately absent too,
 * because the corpus shows the reference dropping them next to attributes it keeps: `aria-selected`, `aria-valuetext`,
 * `aria-required`, `aria-invalid`, `aria-haspopup`, `aria-keyshortcuts`, `aria-controls`,
 * `aria-describedby`, `aria-hidden`, `tabindex`, `open`.
 */
const DOM_INCLUDE_ATTRIBUTES = [
	'title',
	'type',
	'checked',
	'id',
	'name',
	'role',
	'value',
	'placeholder',
	'alt',
	'aria-label',
	'aria-expanded',
	'aria-checked',
	'aria-autocomplete',
	'aria-placeholder',
	'aria-valuemin',
	'aria-valuemax',
	'aria-valuenow',
	'pattern',
	'min',
	'max',
	'minlength',
	'maxlength',
	'step',
	'accept',
	'inputmode',
	'autocomplete',
	'list',
	'contenteditable',
	'pseudo',
] as const;

/**
 * Data-mask hints: the three attributes input-mask plugins actually write. Overridable through `AgentSettings.includeAttributes`,
 * which bounds the blast radius of the guess.
 */
const DATA_MASK_HINT_ATTRIBUTES = ['data-date-format', 'data-mask', 'data-inputmask'] as const;

/** Synthetic hint keys. */
const SYNTHETIC_ATTRIBUTES = ['format', 'expected_format'] as const;

/**
 * Attribute whitelist — AX property names.
 *
 * This is a *filter*, not an order: the reference emits AX properties in the order Chrome reports them
 * (`c-required` renders `invalid=true checked=false`, and `f-aria` renders
 * `autocomplete=list required=true keyshortcuts=Alt+A` — Chrome's order in both cases, not this list's).
 * Names are matched case-sensitively, which is why `haspopup` never fires: Chrome spells the property
 * `hasPopup`, and no golden contains it.
 */
const AX_PROPERTY_ATTRIBUTES = [
	'checked',
	'selected',
	'expanded',
	'pressed',
	'disabled',
	'invalid',
	'valuemin',
	'valuemax',
	'valuenow',
	'keyshortcuts',
	'haspopup',
	'multiselectable',
	'required',
	'valuetext',
	'level',
	'busy',
	'live',
] as const;

/** `AgentSettings.includeAttributes` default. */
export const DEFAULT_INCLUDE_ATTRIBUTES: readonly string[] = [
	...DOM_INCLUDE_ATTRIBUTES,
	...DATA_MASK_HINT_ATTRIBUTES,
	...SYNTHETIC_ATTRIBUTES,
	...AX_PROPERTY_ATTRIBUTES,
];

/** DOM-sourced names, as a set, for the A1 source-order scan. */
const DOM_SOURCED: ReadonlySet<string> = new Set<string>([...DOM_INCLUDE_ATTRIBUTES, ...DATA_MASK_HINT_ATTRIBUTES]);

/** HTML5 date/time input placeholders. */
const HTML5_FORMAT_HINTS: Readonly<Record<string, string>> = {
	'date': 'YYYY-MM-DD',
	'time': 'HH:MM',
	'datetime-local': 'YYYY-MM-DDTHH:MM',
	'month': 'YYYY-MM',
	'week': 'YYYY-W##',
	'tel': '123-456-7890',
};

/** Datepicker-plugin default when the element carries no `data-date-format`. */
export const DEFAULT_DATEPICKER_FORMAT = 'mm/dd/yyyy';

/** AngularJS datepicker popup attributes whose value becomes `expected_format`. */
const ANGULAR_POPUP_ATTRIBUTES = [
	'uib-datepicker-popup',
	'datepicker-popup',
	'data-uib-datepicker-popup',
	'data-datepicker-popup',
] as const;

/** Tags whose live value the AX tree owns: the AX value overrides the DOM value. */
const VALUE_BEARING_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);

/** Never dropped by the duplicate-value dedupe. */
const DEDUPE_PROTECTED_KEYS: ReadonlySet<string> = new Set([
	'format',
	'expected_format',
	'placeholder',
	'value',
	'aria-label',
	'title',
]);

/** Duplicate values are only deduped above this length. */
const DEDUPE_MIN_LENGTH = 5;

/** Per-value character cap. */
export const ATTRIBUTE_VALUE_CAP = 100;

/** Keys whose value must never reach the LLM for a password field. */
const SECRET_VALUE_KEYS = ['value', 'valuetext'] as const;

/** Options for {@linkcode buildAttributeString}. */
export interface AttributeOptions {
	/** `AgentSettings.includeAttributes`; defaults to {@linkcode DEFAULT_INCLUDE_ATTRIBUTES}. */
	readonly includeAttributes?: readonly string[];
	/** Derived ops used for the C5 element-text comparison. */
	readonly derived: SerializerDerived;
}

/**
 * Reads an AX property value as a string.
 *
 * `null`-valued **and empty** properties carry no information and are treated as absent: Chrome reports
 * `valuetext=''` on `<input type=range>`, and the reference emits neither a `valuetext` key nor an
 * empty-string override of the DOM `value` for it.
 */
function axProperty(node: EnhancedDomTreeNode, name: string): string | null {
	const properties = node.axNode?.properties ?? null;
	if (properties === null) return null;
	for (const property of properties) {
		if (property.name !== name) continue;
		if (property.value === null) return null;
		const value = typeof property.value === 'boolean' ? String(property.value) : property.value;
		return value === '' ? null : value;
	}
	return null;
}

/**
 * Password detection, biased towards over-scrubbing — the emission-path spelling of the predicate.
 *
 * `type=password` covers the static case and — because setting `el.type` reflects to the attribute —
 * also a field switched to password after load, provided extraction re-read the attribute. The
 * `autocomplete` arm catches password managers' text-typed reveal fields: a value the page itself
 * labels as a password never belongs in a prompt.
 *
 * The rule itself lives in exactly one place, `derived.ts`: two bodies encoding one security rule
 * diverge the first time only one of them is edited. The `tag` parameter exists because every caller
 * here has already lowercased the node name, and re-deriving it per attribute would be wasted work —
 * but it is only an assertion, not a second definition of what an `<input>` is.
 *
 * It is deliberately not named `isPasswordField`: two exported functions of that name, one taking one
 * argument and one taking two, would both be reachable through the package barrel, and a one-argument
 * call bound to this one would pass `tag === undefined`, so `tag !== 'input'` would always hold and
 * EVERY password label would go unscrubbed.
 */
export function isPasswordInputTag(node: EnhancedDomTreeNode, tag: string): boolean {
	// A `<textarea>` the server typed a secret into is a password field too (see
	// `markSecretFilled` in `derived.ts`); B1 emits its live AX value as `value=`, so B2 must reach it.
	if (tag !== 'input' && tag !== 'textarea') return false;
	return isPasswordNode(node);
}

/**
 * A2 — the synthetic `format` hint, or `null` when the element needs none.
 *
 * The HTML5 branch fires **only** when the input declares no `placeholder`, and when it fires the
 * hint is mirrored into `placeholder` as well as `format`. Both read straight off the corpus:
 * `f-date` has no markup placeholder and renders `format=YYYY-MM-DD placeholder=YYYY-MM-DD`; `f-tel`
 * carries `placeholder="123-456-7890"` in its markup and renders that placeholder and **no** `format`.
 */
function formatHint(
	node: EnhancedDomTreeNode,
	tag: string,
): { value: string; source: 'html5' | 'datepicker' } | null {
	if (tag === 'input' && (node.attributes['placeholder'] ?? '') === '') {
		const type = (node.attributes['type'] ?? '').trim().toLowerCase();
		const hint = HTML5_FORMAT_HINTS[type];
		if (hint !== undefined) return { value: hint, source: 'html5' };
	}
	const classes = (node.attributes['class'] ?? '').split(/\s+/);
	const isDatepicker = classes.some((token) => /date-?picker/i.test(token));
	if (!isDatepicker) return null;
	const declared = (node.attributes['data-date-format'] ?? '').trim();
	return { value: declared === '' ? DEFAULT_DATEPICKER_FORMAT : declared, source: 'datepicker' };
}

/** A2 — the AngularJS popup format, or `null`. */
function expectedFormatHint(node: EnhancedDomTreeNode): string | null {
	for (const name of ANGULAR_POPUP_ATTRIBUTES) {
		const value = (node.attributes[name] ?? '').trim();
		if (value !== '') return value;
	}
	return null;
}

/** D1 — 100-char cap with a trailing ellipsis. */
export function capValue(value: string): string {
	return value.length > ATTRIBUTE_VALUE_CAP ? `${value.slice(0, ATTRIBUTE_VALUE_CAP)}...` : value;
}

/**
 * Runs the whole attribute pipeline and returns the rendered attribute string (empty when nothing
 * survives).
 */
export function buildAttributeString(node: EnhancedDomTreeNode, options: AttributeOptions): string {
	const attributes = buildAttributeMap(node, options);
	const parts: string[] = [];
	for (const [key, value] of attributes) parts.push(`${key}=${value}`);
	return parts.join(' ');
}

/** The pipeline up to F1, exposed as a map so tests can pin individual rules. */
export function buildAttributeMap(node: EnhancedDomTreeNode, options: AttributeOptions): Map<string, string> {
	const include = new Set(options.includeAttributes ?? DEFAULT_INCLUDE_ATTRIBUTES);
	const tag = options.derived.tagName(node);
	const attributes = new Map<string, string>();
	// No special case re-admits `src` for frames: the recorded reference prints no `src` on any of its
	// four iframe lines, so the whitelist alone decides.
	const allowed = (key: string): boolean => include.has(key);

	// A1 — DOM attributes, source order. An empty value is dropped, not rendered `key=''`.
	for (const [name, value] of Object.entries(node.attributes)) {
		if (!DOM_SOURCED.has(name)) continue;
		if (!allowed(name)) continue;
		const collapsed = collapseWhitespace(value);
		if (collapsed === '') continue;
		attributes.set(name, collapsed);
	}

	// A2 — synthetic hints.
	const format = formatHint(node, tag);
	if (format !== null && allowed('format')) {
		attributes.set('format', format.value);
		// An HTML5 type hint is also what the field would show if it had a placeholder, and the reference
		// mirrors it into one. The datepicker branch does not: its `format` is a parsing hint, not a
		// rendered prompt.
		if (format.source === 'html5' && allowed('placeholder')) attributes.set('placeholder', format.value);
		// The plugin attribute has been *mapped into* `format`; restating it verbatim is noise the
		// dedupe cannot remove (`format` is a protected key).
		if (format.source === 'datepicker') attributes.delete('data-date-format');
	}
	const expectedFormat = expectedFormatHint(node);
	if (expectedFormat !== null && allowed('expected_format')) attributes.set('expected_format', expectedFormat);

	// A3 — AX properties overwrite same-named DOM keys in place: the AX tree reflects live state.
	// Chrome's own property order is the emission order, so this iterates the node, not the whitelist.
	for (const property of node.axNode?.properties ?? []) {
		if (!allowed(property.name)) continue;
		const value = axProperty(node, property.name);
		if (value === null) continue;
		attributes.set(property.name, collapseWhitespace(value));
	}

	// B1 — AX value overrides the DOM value for value-bearing controls.
	if (VALUE_BEARING_TAGS.has(tag)) {
		const axValue = axProperty(node, 'valuetext') ?? axProperty(node, 'value');
		// The standalone `valuetext` key stays: the reference keeps both — `f-number` renders
		// `value=7 … valuetext=7` — so the override replaces the *value* and leaves the AX key that
		// sourced it alone.
		if (axValue !== null && allowed('value')) attributes.set('value', collapseWhitespace(axValue));
	}

	// B2 — password scrubbing. MUST follow B1.
	if (isPasswordInputTag(node, tag)) {
		for (const key of SECRET_VALUE_KEYS) attributes.delete(key);
	}

	// C1 / C2 — role and type restating the tag carry nothing.
	if (attributes.get('role')?.toLowerCase() === tag) attributes.delete('role');
	if (attributes.get('type')?.toLowerCase() === tag) attributes.delete('type');

	// C3 — negative validity and falsy required.
	if (attributes.get('invalid') === 'false') attributes.delete('invalid');
	const required = attributes.get('required');
	if (required === 'false' || required === '') attributes.delete('required');

	// C4 — the AX property supersedes the ARIA attribute.
	if (attributes.has('expanded')) attributes.delete('aria-expanded');

	// C6 — duplicate-value dedupe.
	//
	// Not plain "first occurrence wins, protected keys exempt": `f-dupe` carries the same 25-char value on `name`, `title`, `placeholder`, `aria-label` and `value`, `name` comes
	// **first** in source order, and the reference drops `name` and keeps the other four. So a protected
	// key claims its value regardless of position, and only then does first-wins decide among the rest.
	const seen = new Set<string>();
	for (const [key, value] of attributes) {
		if (value.length > DEDUPE_MIN_LENGTH && DEDUPE_PROTECTED_KEYS.has(key)) seen.add(value);
	}
	for (const [key, value] of [...attributes]) {
		if (value.length <= DEDUPE_MIN_LENGTH) continue;
		if (DEDUPE_PROTECTED_KEYS.has(key)) continue;
		if (seen.has(value)) {
			attributes.delete(key);
			continue;
		}
		seen.add(value);
	}

	// D1 — cap. After C6 so values differing past char 100 stay distinct.
	for (const [key, value] of attributes) {
		const capped = capValue(value);
		if (capped !== value) attributes.set(key, capped);
	}

	// E1 — compound components, appended last and exempt from C6/D1.
	const compound = compoundComponentsValue(node, tag);
	if (compound !== null) attributes.set('compound_components', compound);

	return attributes;
}
