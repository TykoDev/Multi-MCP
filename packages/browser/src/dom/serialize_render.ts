/**
 * The §6.4 grammar renderer — `SimplifiedNode` tree → the literal text the LLM reads.
 *
 * Tab-indented; depth increases only under a rendered line. Every form of the §6.4 block is produced
 * here and nowhere else, so a drift in this file is a drift in agent behaviour:
 *
 * ```
 * [Start of page]
 * text node content
 * *[1423]<button type=submit />
 * [1301]<a title=Home />
 * |scroll element[1520]|<div role=listbox /> (0.2 pages above, 1.4 pages below)
 * |scroll element|<div /> (1.1 pages above, 0.0 pages below)
 * |scroll element[1600]<iframe title=inner /> (scroll)
 * |SHADOW(open)|*[977]<custom-button />
 * 	Open Shadow
 * 		[978]<button />
 * 	Shadow End
 * [544]<svg /> <!-- SVG content collapsed -->
 * 	... (3 more elements below - scroll to reveal):
 * 		<button> "Submit form" ~2.3 pages down
 * [End of page]
 * ```
 *
 * ERRATUM(M1-dom-serialize-2): §6.4 shows `*[idx]` and `|scroll element[idx]|` but never their
 * combination. Implemented as the single rule "`*` immediately precedes the `[idx]` token", which
 * inside a scroll marker reads `|scroll element*[1520]|`.
 *
 * ERRATUM(M1-dom-serialize-3): OBSERVABILITY-TESTING-CICD §4.2 describes the suite's output as
 * `[index]<tag>text`. §6.4 is the normative grammar and renders self-closing tag lines with text as
 * separate child lines; §6.4 wins.
 *
 * ERRATUM(M1-dom-serialize-4, WITHDRAWN by M1-parity-10): §6.4's iframe inner-scroll summary
 * (`scroll: 0.0↑ 2.1↓ 35%`) is emitted by no golden — the reference writes the literal `(scroll)` — so
 * the summary and the shallow frame-geometry search that fed it are gone rather than left unreachable.
 */

import type { EnhancedDomTreeNode, SimplifiedNode } from './types.ts';
import { collapseWhitespace, type SerializerDerived } from './serialize_derived.ts';
import { buildAttributeString } from './serialize_attrs.ts';

/** ELEMENT_NODE / TEXT_NODE / DOCUMENT_FRAGMENT_NODE. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_FRAGMENT_NODE = 11;

/** Tags that carry a frame boundary. */
const FRAME_TAGS: ReadonlySet<string> = new Set(['iframe', 'frame']);

/** §6.4 — at most this many hidden-element hints are listed under an iframe. */
export const MAX_HIDDEN_ELEMENT_HINTS = 10;

/** Trailer the reference appends to an SVG root whose content it collapsed. */
const SVG_COLLAPSED_COMMENT = '<!-- SVG content collapsed -->';

/** Options for {@linkcode renderSimplifiedTree}. */
export interface RenderOptions {
	readonly derived: SerializerDerived;
	readonly includeAttributes?: readonly string[] | undefined;
	/** Emits `[Start of page]` when `0`; omitted entirely when undefined. */
	readonly pixelsAbove?: number | undefined;
	/** Emits `[End of page]` when `0`; omitted entirely when undefined. */
	readonly pixelsBelow?: number | undefined;
	/** Default {@linkcode MAX_HIDDEN_ELEMENT_HINTS}. */
	readonly maxHiddenElementHints?: number | undefined;
}

/**
 * `(0.2 pages above, 1.4 pages below)`, `(horizontal 35%)`, or both — `(0.0 pages above, 2.9 pages
 * below horizontal 0%)`. `''` when the node has nothing to say.
 *
 * ERRATUM(M1-parity-8): §6.4 reads "`X.X pages above, Y.Y pages below` **and/or** `horizontal NN%`" and
 * this used to emit the pages clause unconditionally, so a horizontal-only container announced
 * `(0.0 pages above, 0.0 pages below, horizontal 0%)` — three numbers, two of them noise. The pages
 * clause is emitted only when the box actually scrolls vertically, and the two clauses are joined by a
 * **space**, not a comma: `#bothstrip` reads `... pages below horizontal 0%` in the recorded golden.
 */
function scrollSuffix(node: EnhancedDomTreeNode, derived: SerializerDerived): string {
	if (!derived.shouldShowScrollInfo(node)) return '';
	const info = derived.scrollInfo(node);
	if (info === null) return '';
	const parts: string[] = [];
	if (info.pagesAbove > 0 || info.pagesBelow > 0) {
		parts.push(`${info.pagesAbove.toFixed(1)} pages above, ${info.pagesBelow.toFixed(1)} pages below`);
	}
	if (info.horizontalPercent !== null) parts.push(`horizontal ${Math.round(info.horizontalPercent)}%`);
	if (parts.length === 0) return '';
	return ` (${parts.join(' ')})`;
}

/**
 * The shadow-root type advertised on a host's `|SHADOW(...)|` marker.
 *
 * ERRATUM(M1-parity-9): §6.4 names only `Open`/`Closed` wrappers, so a user-agent-only host used to
 * carry no marker at all. The reference marks them `|SHADOW(open)|` — every `<input>`, `<select>`,
 * `<option>` and `<details>` in the corpus, 19 times on `form_attributes` alone. An author root still
 * wins when both exist, because that is the one whose content is walked.
 */
function hostShadowType(node: EnhancedDomTreeNode): string | null {
	const roots = node.shadowRoots ?? [];
	for (const shadowRoot of roots) {
		if (shadowRoot.shadowRootType === 'user-agent') continue;
		return shadowRoot.shadowRootType ?? 'open';
	}
	return roots.length > 0 ? 'open' : null;
}

/** One element's tag line, without indentation. */
function elementLine(simplified: SimplifiedNode, options: RenderOptions): string {
	const node = simplified.originalNode;
	const derived = options.derived;
	const tag = derived.tagName(node);
	const attributes = buildAttributeString(node, {
		derived,
		includeAttributes: options.includeAttributes,
	});
	const tagText = `<${tag}${attributes === '' ? '' : ` ${attributes}`} />`;

	const indexToken = simplified.selectorIndex === null
		? ''
		: `${simplified.isNew ? '*' : ''}[${simplified.selectorIndex}]`;

	const shadowType = simplified.isShadowHost ? hostShadowType(node) : null;
	const shadowMarker = shadowType === null ? '' : `|SHADOW(${shadowType})|`;

	const scrollable = derived.isActuallyScrollable(node);
	const isFrame = FRAME_TAGS.has(tag);

	// ERRATUM(M1-parity-10): §6.4 gives frames `|IFRAME|<iframe src=... />` plus a
	// `(scroll: 0.0↑ 2.1↓ 35%)` summary. The reference contradicts it on four counts and all four are
	// reproduced (DECISION-REGISTER §9.6 (E-23) items 1 and 2): the frame is *indexed*, the marker is
	// `|scroll element[n]` with **no closing `|`**, the summary is the literal `(scroll)` with no
	// numbers, and `src` is not emitted. The unclosed marker is the recorded reference defect.
	if (isFrame) return `${shadowMarker}|scroll element${indexToken}${tagText} (scroll)`;
	if (scrollable) {
		return `${shadowMarker}|scroll element${indexToken}|${tagText}${scrollSuffix(node, derived)}`;
	}
	// A non-interactive SVG root still emits a line, and the reference appends a comment naming what it
	// dropped. The subtree is collapsed by `simplifyDomTree`, so nothing below it can render.
	if (tag === 'svg' && hasElementChild(node)) return `${shadowMarker}${indexToken}${tagText} ${SVG_COLLAPSED_COMMENT}`;
	return `${shadowMarker}${indexToken}${tagText}`;
}

/** True when the element has at least one element child — i.e. the collapse actually dropped content. */
function hasElementChild(node: EnhancedDomTreeNode): boolean {
	return node.childrenNodes.some((child) => child.nodeType === ELEMENT_NODE);
}

/** §6.4 — the `... (N more elements below - scroll to reveal):` block. */
function hiddenElementLines(node: EnhancedDomTreeNode, depth: number, limit: number): string[] {
	if (!node.hasHiddenContent || node.hiddenElementsInfo.length === 0) return [];
	const indent = '\t'.repeat(depth);
	const entries = [...node.hiddenElementsInfo].sort((a, b) => a.pagesAway - b.pagesAway).slice(0, limit);
	const lines = [`${indent}... (${node.hiddenElementsInfo.length} more elements below - scroll to reveal):`];
	for (const entry of entries) {
		const text = collapseWhitespace(entry.text);
		lines.push(`${indent}\t<${entry.tagName.toLowerCase()}> "${text}" ~${entry.pagesAway.toFixed(1)} pages down`);
	}
	return lines;
}

/** Recursively renders one simplified node and its subtree. */
function renderNode(simplified: SimplifiedNode, depth: number, options: RenderOptions, lines: string[]): void {
	const node = simplified.originalNode;
	if (!simplified.shouldDisplay) {
		for (const child of simplified.children) renderNode(child, depth, options, lines);
		return;
	}
	const indent = '\t'.repeat(depth);

	if (node.nodeType === TEXT_NODE) {
		// ERRATUM(M1-parity-11): §6.4 fixes neither the collapsing nor the line unit for a text node.
		// The reference emits **one line per source line** — a `<p>` holding three newline-separated
		// words renders as three lines, not one collapsed sentence — with each line's internal
		// whitespace still collapsed and blank lines dropped.
		for (const line of node.nodeValue.split('\n')) {
			const text = collapseWhitespace(line);
			if (text !== '') lines.push(`${indent}${text}`);
		}
		return;
	}

	if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
		lines.push(`${indent}${node.shadowRootType === 'closed' ? 'Closed' : 'Open'} Shadow`);
		for (const child of simplified.children) renderNode(child, depth + 1, options, lines);
		lines.push(`${indent}Shadow End`);
		return;
	}

	lines.push(`${indent}${elementLine(simplified, options)}`);
	for (const child of simplified.children) renderNode(child, depth + 1, options, lines);
	lines.push(...hiddenElementLines(node, depth + 1, options.maxHiddenElementHints ?? MAX_HIDDEN_ELEMENT_HINTS));
}

/** Renders the §6.4 text for a simplified tree, prompt-layer page markers included. */
export function renderSimplifiedTree(root: SimplifiedNode | null, options: RenderOptions): string {
	const lines: string[] = [];
	if (options.pixelsAbove === 0) lines.push('[Start of page]');
	if (root !== null) renderNode(root, 0, options, lines);
	if (options.pixelsBelow === 0) lines.push('[End of page]');
	return lines.join('\n');
}
