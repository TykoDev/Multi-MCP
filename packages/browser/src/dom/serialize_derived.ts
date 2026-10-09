/**
 * The derived-member contract the serializer consumes (DATA-MODEL §6.1 "Derived members", declared as
 * `DomNodeDerived` in types.ts) — **re-exported from its single implementation in `derived.ts`**, plus
 * the two visibility/whitespace helpers that belong to the serializer alone.
 *
 * ERRATUM(M1-dom-serialize-1) — HISTORY: `src/dom/derived.ts` is the extraction half's file and did
 * not exist when this module was written, so this file carried its own implementation of all seven
 * members and the serializer took them as an injected dependency, defaulting to the copy here.
 * `derived.ts` then landed with a second implementation of the same seven, typed as the same
 * `Omit<DomNodeDerived, …>`, and nobody deleted either.
 *
 * ERRATUM(E-33): the two copies **drifted**, and the differential test that was supposed to catch it
 * could not. `serialize_test.ts`'s "the extraction half's derived members render byte-identical
 * goldens" injects `domNodeDerived` and re-renders all nine goldens — but the renderer only ever
 * calls four of the seven members (`tagName`, `isActuallyScrollable`, `shouldShowScrollInfo`,
 * `scrollInfo`), so `xpath`, `getAllChildrenText` and `getMeaningfulTextForLlm` were outside its
 * reach no matter what fixture it ran. Measured, the copies disagreed on:
 *
 * - `isActuallyScrollable` — opposite answers when `isScrollable` is `null`; see ERRATUM(E-33) in
 *   `derived.ts` for the adjudication.
 * - `getMeaningfulTextForLlm` — **the copy here had no §6.5 password gate at all**, so
 *   `defaultDerived.getMeaningfulTextForLlm(<input type=password value=hunter2>)` returned
 *   `'hunter2'` while `derived.ts` returned `''`. Same defect class as E-29 and a wider hole: E-29
 *   was a narrow predicate, this was no predicate. `defaultDerived` is exported through
 *   `packages/core/mod.ts`, so it was reachable API surface.
 * - `getAllChildrenText` — `maxDepth: -1` meant "unlimited" in `derived.ts` and "return nothing"
 *   here, and this copy descended into `<script>`/`<style>` (emitting source text) while skipping
 *   shadow roots (dropping rendered text).
 *
 * A second copy that merely happens to agree today will drift again, so there is now exactly one
 * implementation and this file re-exports it. The renderer is unchanged: it still takes the ops as
 * {@linkcode SerializeOptions.derived} and still falls back to {@linkcode defaultDerived}, which is
 * now built from the same functions the injected `domNodeDerived` object carries.
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
 * Every member is now the *same function object* as the corresponding member of `derived.ts`'s
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
