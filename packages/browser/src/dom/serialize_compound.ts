/**
 * Compound-component detection — the `compound_components=(…)` groups of DATA-MODEL §6.5.
 *
 * ERRATUM(M1-dom-serialize-14, CLOSED): §6.5 shows the *rendering* of `compound_components` and §6.1
 * types `compoundChildren`, but no section says which elements are compound or where the groups' names
 * come from. That gap is now closed by the recorded reference corpus, which is the only place the rule
 * is written down. Read off the goldens:
 *
 * | element | groups |
 * |---|---|
 * | `<select>` | `(name=Dropdown Toggle,role=button)` `(name=Options,role=listbox,count=N,options=a\|b\|c)` |
 * | `<details>` | `(name=Toggle Disclosure,role=button)` `(name=Content Area,role=region)` |
 * | `<input type=file>` | `(name=Browse Files,role=button)` `(name=Files Selected,role=textbox,current=None)` |
 * | `<input type=range>` | `(name=Value,role=slider,min=…,max=…)` |
 * | `<input type=number>` | `(name=Increment,role=button)` `(name=Decrement,role=button)` `(name=Value,role=textbox,min=…,max=…)` |
 *
 * The names are **not** taken from the AX tree: `f-file`'s user-agent shadow button carries no
 * accessible name at all, yet the reference prints `Browse Files`. They are a fixed vocabulary
 * describing the UA widget's parts, so they are a table here too. Every other element that has a
 * user-agent shadow root — every date/time input, every text input — has **no** `compound_components`
 * in any golden, which is what bounds the table to these five kinds.
 *
 * Two consequences beyond the attribute string, both corroborated by the goldens: a compound element is
 * always `isNew` (R6.2 says so; all eleven compound elements in the corpus are starred `*` and no other
 * element is), and the group list is exempt from the §6.5 dedupe and 100-char cap.
 *
 * `min`/`max` are rendered as Python float literals (`0` → `0.0`) because the reference is CPython and
 * interpolates `float(...)`; `1.5` stays `1.5`.
 */

import type { EnhancedDomTreeNode } from './types.ts';

/** One `(k=v,…)` group. Insertion order is emission order. */
export type CompoundGroup = Record<string, string>;

/** `str(float(value))` — Python's float repr, which always shows a decimal point. */
export function pythonFloat(value: string): string | null {
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return null;
	return Number.isInteger(parsed) ? parsed.toFixed(1) : String(parsed);
}

/** AX property lookup; `null`-valued and empty properties carry no information. */
function axProperty(node: EnhancedDomTreeNode, name: string): string | null {
	for (const property of node.axNode?.properties ?? []) {
		if (property.name !== name) continue;
		if (property.value === null) return null;
		const value = typeof property.value === 'boolean' ? String(property.value) : property.value;
		return value === '' ? null : value;
	}
	return null;
}

/** The AX-resolved bound, falling back to the markup attribute; Chrome fills HTML defaults in. */
function bound(node: EnhancedDomTreeNode, axName: string, attribute: string): string | null {
	const raw = axProperty(node, axName) ?? node.attributes[attribute] ?? null;
	return raw === null ? null : pythonFloat(raw);
}

/** `<option>` labels, in document order, flattened through `<optgroup>`. */
function optionLabels(node: EnhancedDomTreeNode): string[] {
	const labels: string[] = [];
	const visit = (current: EnhancedDomTreeNode): void => {
		for (const child of current.childrenNodes) {
			if (child.nodeType !== 1) continue;
			if (child.nodeName === 'OPTION') {
				labels.push(textOf(child));
				continue;
			}
			if (child.nodeName === 'OPTGROUP') visit(child);
		}
	};
	visit(node);
	return labels;
}

/** An option's label: its own text, whitespace-collapsed. Never its `value`. */
function textOf(node: EnhancedDomTreeNode): string {
	const parts: string[] = [];
	const visit = (current: EnhancedDomTreeNode): void => {
		if (current.nodeType === 3) {
			parts.push(current.nodeValue);
			return;
		}
		for (const child of current.childrenNodes) visit(child);
	};
	visit(node);
	return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** `min`/`max` appended to a group, when the element declares them. */
function withBounds(group: CompoundGroup, node: EnhancedDomTreeNode): CompoundGroup {
	const min = bound(node, 'valuemin', 'min');
	const max = bound(node, 'valuemax', 'max');
	if (min !== null) group['min'] = min;
	if (max !== null) group['max'] = max;
	return group;
}

/**
 * The compound groups this element's user-agent widget is made of, or `[]` when it is not compound.
 *
 * `node.compoundChildren` wins when populated: §6.1 declares it "synthesized by serializer", so a
 * caller that has already synthesized a richer description keeps it.
 */
export function compoundComponents(node: EnhancedDomTreeNode, tag: string): readonly CompoundGroup[] {
	if (node.compoundChildren.length > 0) return node.compoundChildren;
	if (tag === 'select') {
		const options = optionLabels(node);
		return [
			{ name: 'Dropdown Toggle', role: 'button' },
			{ name: 'Options', role: 'listbox', count: String(options.length), options: options.join('|') },
		];
	}
	if (tag === 'details') {
		return [
			{ name: 'Toggle Disclosure', role: 'button' },
			{ name: 'Content Area', role: 'region' },
		];
	}
	if (tag !== 'input') return [];
	const type = (node.attributes['type'] ?? '').trim().toLowerCase();
	if (type === 'file') {
		return [
			{ name: 'Browse Files', role: 'button' },
			// The reference prints Python's `None` for "no file chosen"; no golden shows a chosen file, so
			// the populated spelling is unknown and deliberately not guessed at.
			{ name: 'Files Selected', role: 'textbox', current: 'None' },
		];
	}
	if (type === 'range') return [withBounds({ name: 'Value', role: 'slider' }, node)];
	if (type === 'number') {
		return [
			{ name: 'Increment', role: 'button' },
			{ name: 'Decrement', role: 'button' },
			withBounds({ name: 'Value', role: 'textbox' }, node),
		];
	}
	return [];
}

/** `(k=v,…),(k=v,…)`, or `null` when the element is not compound. */
export function compoundComponentsValue(node: EnhancedDomTreeNode, tag: string): string | null {
	const groups = compoundComponents(node, tag)
		.map((group) => Object.entries(group).map(([key, value]) => `${key}=${value}`).join(','))
		.filter((group) => group !== '');
	if (groups.length === 0) return null;
	return `(${groups.join('),(')})`;
}
