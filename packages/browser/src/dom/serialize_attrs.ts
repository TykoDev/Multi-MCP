/**
 * Attribute emission — DATA-MODEL §6.5, implemented as one ordered pipeline.
 *
 * Order is the whole contract here: dedupe before capping keeps two long values that differ past
 * char 100 distinguishable, capping before dedupe would collapse them. §6.5 lists "Cleanups" before
 * "Caps" and `compound_components` as *appended*, so the pipeline runs:
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
 * Three stages the recorded reference corpus deleted (DECISION-REGISTER §9.6 (E-23) item 2):
 *
 * - **A4 `ax_name`** — §6.5's whitelist ends "…and `ax_name`", and **zero** of the 25 goldens contain
 *   the token. It was the single highest-count text divergence, on 17 pages.
 * - **C5 label-ish-equals-text** — the reference keeps them: `f-text-equals-label` renders
 *   `title=Save changes aria-label=Save changes` above the text `Save changes`.
 * - **`key=''` for empty values** — §6.5 says empty renders `key=''`; `f-empty-value` carries
 *   `value=""` and `title=""` in its markup and the golden emits neither.
 */

import type { EnhancedDomTreeNode } from './types.ts';
import { collapseWhitespace, type SerializerDerived } from './serialize_derived.ts';
import { isPasswordField as isPasswordNode } from './derived.ts';
import { compoundComponentsValue } from './serialize_compound.ts';

/**
 * §6.5 whitelist — DOM-sourced names.
 *
 * ERRATUM(M1-parity-3): amended against the recorded corpus. **Added** `aria-checked`,
 * `aria-autocomplete`, `aria-placeholder`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow` — all six
 * appear in goldens and none is in §6.5's list. **Removed** `multiple`: `f-file` and `sel-multi` both
 * carry it in their markup and neither golden prints it. Deliberately still absent, because the corpus
 * shows the reference dropping them next to attributes it keeps: `aria-selected`, `aria-valuetext`,
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
 * §6.5 "data-mask hints".
 *
 * ERRATUM(M1-dom-serialize-8): the spec names the category, not its members. Implemented as the three
 * attributes input-mask plugins actually write. Overridable through `AgentSettings.includeAttributes`,
 * which bounds the blast radius of the guess.
 */
const DATA_MASK_HINT_ATTRIBUTES = ['data-date-format', 'data-mask', 'data-inputmask'] as const;

/** §6.5 synthetic hint keys. */
const SYNTHETIC_ATTRIBUTES = ['format', 'expected_format'] as const;

/**
 * §6.5 whitelist — AX property names.
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

/** `AgentSettings.includeAttributes` default (DATA-MODEL §2.1 → §6.5). */
export const DEFAULT_INCLUDE_ATTRIBUTES: readonly string[] = [
	...DOM_INCLUDE_ATTRIBUTES,
	...DATA_MASK_HINT_ATTRIBUTES,
	...SYNTHETIC_ATTRIBUTES,
	...AX_PROPERTY_ATTRIBUTES,
];

/** DOM-sourced names, as a set, for the A1 source-order scan. */
const DOM_SOURCED: ReadonlySet<string> = new Set<string>([...DOM_INCLUDE_ATTRIBUTES, ...DATA_MASK_HINT_ATTRIBUTES]);

/** §6.5 — HTML5 date/time input placeholders. */
const HTML5_FORMAT_HINTS: Readonly<Record<string, string>> = {
	'date': 'YYYY-MM-DD',
	'time': 'HH:MM',
	'datetime-local': 'YYYY-MM-DDTHH:MM',
	'month': 'YYYY-MM',
	'week': 'YYYY-W##',
	'tel': '123-456-7890',
};

/** §6.5 — datepicker-plugin default when the element carries no `data-date-format`. */
export const DEFAULT_DATEPICKER_FORMAT = 'mm/dd/yyyy';

/** AngularJS datepicker popup attributes whose value becomes `expected_format`. */
const ANGULAR_POPUP_ATTRIBUTES = [
	'uib-datepicker-popup',
	'datepicker-popup',
	'data-uib-datepicker-popup',
	'data-datepicker-popup',
] as const;

/** Tags whose live value the AX tree owns (§6.5 "AX value overrides DOM value"). */
const VALUE_BEARING_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);

/** §6.5 — never dropped by the duplicate-value dedupe. */
const DEDUPE_PROTECTED_KEYS: ReadonlySet<string> = new Set([
	'format',
	'expected_format',
	'placeholder',
	'value',
	'aria-label',
	'title',
]);

/** §6.5 — duplicate values are only deduped above this length. */
const DEDUPE_MIN_LENGTH = 5;

/** §6.5 — per-value character cap. */
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
 * Password detection, biased towards over-scrubbing — the emission-path spelling of §6.5's predicate.
 *
 * `type=password` covers the static case and — because setting `el.type` reflects to the attribute —
 * also a field switched to password after load, provided extraction re-read the attribute. The
 * `autocomplete` arm catches password managers' text-typed reveal fields: a value the page itself
 * labels as a password never belongs in a prompt.
 *
 * ERRATUM(E-33): the rule itself now lives in exactly one place. This used to be a second
 * implementation of it, and under E-29 the two had drifted — `derived.ts` checked only `type` while
 * this one also checked `autocomplete`, and the **narrow** copy was the one guarding §6.5. E-29 fixed
 * the drift by making both copies say the same thing, which is a repair with a short half-life: two
 * bodies encoding one security rule will diverge again the next time only one of them is edited. The
 * `tag` parameter survives because every caller here has already lowercased the node name, and
 * re-deriving it per attribute would be wasted work — but it is now only an assertion, not a second
 * definition of what an `<input>` is.
 *
 * ERRATUM(E-38, security review): renamed from `isPasswordField`. Two exported functions with the
 * same name, one taking one argument and one taking two, were both reachable through the package
 * barrel; only the explicit re-export at `mod.ts` made `observe.ts`'s one-argument call bind the real
 * predicate. Had it bound this one, `tag` would have been `undefined`, `tag !== 'input'` would always
 * have held, and EVERY password label would have gone unscrubbed. It resolves correctly today and a
 * removal would be a compile error rather than a silent flip — but E-29's whole point was one
 * definition, and a second *name* for it held in place by one line in a barrel file is the same
 * mistake wearing different clothes.
 */
export function isPasswordInputTag(node: EnhancedDomTreeNode, tag: string): boolean {
	if (tag !== 'input') return false;
	return isPasswordNode(node);
}

/**
 * A2 — the synthetic `format` hint, or `null` when the element needs none.
 *
 * ERRATUM(M1-parity-4): the HTML5 branch fires **only** when the input declares no `placeholder`, and
 * when it fires the reference mirrors the hint into `placeholder` as well as `format`. Both read
 * straight off the corpus: `f-date` has no markup placeholder and renders
 * `format=YYYY-MM-DD placeholder=YYYY-MM-DD`; `f-tel` carries `placeholder="123-456-7890"` in its
 * markup and renders that placeholder and **no** `format` at all. §6.5 describes neither half.
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
 * Runs the whole §6.5 pipeline and returns the rendered attribute string (empty when nothing
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
	// ERRATUM(M1-dom-serialize-11, REVERSED by M1-parity-5): §6.4 renders `|IFRAME|<iframe src=... />`
	// but `src` is absent from the §6.5 whitelist, and this file used to re-admit it for frames. The
	// recorded reference prints no `src` on any of its four iframe lines, so the whitelist wins and the
	// grammar example is wrong (DECISION-REGISTER §9.6 (E-23) item 2).
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
		// ERRATUM(M1-parity-16): the standalone `valuetext` key used to be deleted here as a restatement
		// of `value`. The reference keeps both — `f-number` renders `value=7 … valuetext=7` — so the
		// override replaces the *value* and leaves the AX key that sourced it alone.
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
	// ERRATUM(M1-parity-14): §6.5 says only "duplicate values >5 chars deduped (protected keys: …)",
	// which reads as "first occurrence wins, protected keys exempt". It is not: `f-dupe` carries the
	// same 25-char value on `name`, `title`, `placeholder`, `aria-label` and `value`, `name` comes
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
