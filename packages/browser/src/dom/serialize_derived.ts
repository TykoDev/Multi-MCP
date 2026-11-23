/**
 * The derived-member contract the serializer consumes (declared as `DomNodeDerived` in types.ts) —
 * **re-exported from its single implementation in `derived.ts`**, plus the two visibility/whitespace
 * helpers that belong to the serializer alone.
 *
 * There is exactly one implementation because a second copy drifts, and the differential golden test
 * cannot catch it: the renderer only calls four of the seven members (`tagName`,
 * `isActuallyScrollable`, `shouldShowScrollInfo`, `scrollInfo`), so `xpath`, `getAllChildrenText` and
 * `getMeaningfulTextForLlm` are outside any golden's reach — and `getMeaningfulTextForLlm` carries the
 * password gate. The renderer takes the ops as {@linkcode SerializeOptions.derived} and falls back to
 * {@linkcode defaultDerived}, which is built from the same functions the injected `domNodeDerived`
 * object carries.
 */

import type { DomNodeDerived, EnhancedDomTreeNode } from './types.ts';
import {
	getAllChildrenText,
	getMeaningfulTextForLlm,
	isActuallyScrollable,
	normalizeWhitespace,
	overflowAllowsScrolling,
	scrollInfo,
	shouldShowScrollInfo,
	tagName,
	xpath,
} from './derived.ts';

export {
	getAllChildrenText,
	getMeaningfulTextForLlm,
	isActuallyScrollable,
	overflowAllowsScrolling,
	scrollInfo,
	shouldShowScrollInfo,
	tagName,
	xpath,
};

/** The subset of `DomNodeDerived` the serializer needs; the hashes live in `hashes.ts`. */
export type SerializerDerived = Omit<DomNodeDerived, 'elementHash' | 'stableHash' | 'parentBranchHash'>;

/**
 * Collapses every whitespace run to a single space and trims. Line-based output cannot carry `\n`.
 *
 * The serializer's spelling of `derived.ts`'s `normalizeWhitespace`; both names are load-bearing in
 * their own layer's prose, so this is an alias rather than a third copy of the regex.
 */
export const collapseWhitespace: (text: string) => string = normalizeWhitespace;

/**
 * Visibility with inheritance: `isVisible` is `boolean | null` and extraction is not obliged to compute
 * it for text nodes, so an unknown value falls back to the nearest ancestor that does know. Unknown all
 * the way up reads as visible — the alternative silently empties the page when extraction skips the
 * field.
 */
export function isNodeVisible(node: EnhancedDomTreeNode): boolean {
	let current: EnhancedDomTreeNode | null = node;
	while (current !== null) {
		if (current.isVisible !== null) return current.isVisible;
		current = current.parentNode;
	}
	return true;
}

/**
 * The default derived ops, used whenever `SerializeOptions.derived` is omitted.
 *
 * Every member is the *same function object* as the corresponding member of `derived.ts`'s
 * `domNodeDerived`, so injecting one in place of the other is a no-op by identity rather than by
 * agreement — which is what `serialize_derived_test.ts`'s identity test asserts. Equality of
 * behaviour is a property that has to be re-measured after every edit; identity is not.
 */
export const defaultDerived: SerializerDerived = {
	tagName,
	xpath,
	isActuallyScrollable,
	shouldShowScrollInfo,
	scrollInfo,
	getAllChildrenText,
	getMeaningfulTextForLlm,
};
