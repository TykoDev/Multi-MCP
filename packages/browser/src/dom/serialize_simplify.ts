/**
 * Simplification pass — `EnhancedDomTreeNode` tree → `SimplifiedNode` tree (DATA-MODEL §6.3) with
 * index assignment per R6.1–R6.4.
 *
 * Only interactive, scrollable, or IFRAME/FRAME elements produce a tag line (§6.4); everything else is
 * a structural pass-through whose children are hoisted to the parent's depth. Display candidates that
 * are suppressed — occluded by paint order, or inside a collapsed SVG — stay in the tree with
 * `shouldDisplay = false` so the flags §6.3 declares (`ignoredByPaintOrder`, `excludedByParent`) are
 * observable and so no suppressed node can ever reach the selector map.
 */

import type { EnhancedDomTreeNode, SimplifiedNode } from './types.ts';
import { isNodeVisible, type SerializerDerived } from './serialize_derived.ts';
import { compoundComponents } from './serialize_compound.ts';
import { passesCssGate } from './extract_merge.ts';

/**
 * ERRATUM(E-41). `isVisible` conflates two facts — "not rendered at all" (`display:none`,
 * `visibility:hidden`, no layout box) and "rendered but outside the ±1000 px viewport band" — into
 * one boolean, so `browser_get_state {include_hidden: true}` had no way to admit the second class
 * without admitting the first. This predicate separates them from the data the node already carries:
 * an element that failed *only* the viewport test still passes the CSS gate and still has a box.
 * An element that fails the CSS gate is never emitted under any setting, because it is not clickable
 * and a `visible: false` that conflated the two would be a lie.
 */
export function isOffscreenOnly(node: EnhancedDomTreeNode): boolean {
	return node.isVisible === false && node.absolutePosition !== null && passesCssGate(node.snapshotNode);
}

/** ERRATUM(E-41): the hidden test the walk applies, with the offscreen class optionally admitted. */
function isHiddenForWalk(node: EnhancedDomTreeNode, includeOffscreen: boolean): boolean {
	if (node.isVisible !== false) return false;
	return includeOffscreen ? !isOffscreenOnly(node) : true;
}

/** ELEMENT_NODE. */
const ELEMENT_NODE = 1;
/** TEXT_NODE. */
const TEXT_NODE = 3;

/** Tags that always produce a tag line and carry a frame boundary. */
const FRAME_TAGS: ReadonlySet<string> = new Set(['iframe', 'frame']);

/**
 * Tags interactive by nature.
 *
 * `a` is here rather than behind an `href` test: the reference indexes `#l-nohref`, an anchor with no
 * `href` whose AX role is `generic` and which no other rule reaches (it is not clickable, its cursor is
 * `auto` and it has no tabindex). `iframe`/`frame` are here because the reference indexes frames — a
 * real interactivity difference, not a marker difference. `option` is here only via the AX role set,
 * because a dropdown's options are `isVisible === false` and a listbox's are not, and that distinction
 * is what the reference draws.
 */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
	'a',
	'button',
	'details',
	'frame',
	'iframe',
	'input',
	'select',
	'summary',
	'textarea',
]);

/**
 * AX roles that imply an actionable control, lowercased at the lookup site.
 *
 * ERRATUM(M1-parity-6): `row`, `cell`, `gridcell`, `option`, `iframe` (Chrome spells it `Iframe`) and
 * `dialog` were added against the recorded corpus — 41 of the 67 measured disagreements were elements
 * the reference indexes and this set did not admit. Deliberately still absent, each with a corpus
 * element that is *not* indexed: `image` (`#interactive-svg`), `columnheader`/`rowheader` (the `<th>`s),
 * `rowgroup`, `caption`, `grid`, `table`, `list`, `listitem`, `group` (`<fieldset>`, `<optgroup>`),
 * `region`, `status`, `radiogroup`, `tablist`, `tabpanel`, `menu`, `generic`, `none`.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
	'button',
	'cell',
	'checkbox',
	'combobox',
	'dialog',
	'gridcell',
	'iframe',
	'link',
	'listbox',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'radio',
	'row',
	'searchbox',
	'slider',
	'spinbutton',
	'switch',
	'tab',
	'textbox',
	'treeitem',
]);

/** Elements a `<label>` can label; a label that wraps one is a click target for it. */
const LABELABLE_TAGS: ReadonlySet<string> = new Set([
	'BUTTON',
	'INPUT',
	'METER',
	'OUTPUT',
	'PROGRESS',
	'SELECT',
	'TEXTAREA',
]);

/** Ancestors whose click affordance bleeds onto every descendant box. */
const CLICK_SOURCE_TAGS: ReadonlySet<string> = new Set(['A', 'BUTTON']);

/** `contenteditable` values that mean "editable". */
const EDITABLE_VALUES: ReadonlySet<string> = new Set(['', 'true', 'plaintext-only']);

/** Background colours that paint nothing. */
const TRANSPARENT_BACKGROUNDS: ReadonlySet<string> = new Set(['', 'transparent', 'none']);

/** `rgba(…, 0)` — zero alpha. Deliberately not `rgb(0, 0, 0)`, which is opaque black. */
const ZERO_ALPHA = /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i;

/** Upper bound on occlusion candidates considered, for a deterministic O(n·k) filter. */
const MAX_OCCLUDERS = 200;

/** Nodes visited between wall-clock budget checks (R6.4). */
const BUDGET_CHECK_INTERVAL = 256;

/** True when the element, or the AX tree, reports the control as disabled. */
export function isDisabledControl(node: EnhancedDomTreeNode): boolean {
	for (const property of node.axNode?.properties ?? []) {
		if (property.name !== 'disabled') continue;
		if (property.value === true || property.value === 'true') return true;
	}
	if (node.attributes['disabled'] !== undefined) return true;
	return (node.attributes['aria-disabled'] ?? '').trim().toLowerCase() === 'true';
}

/** A `<label>` that wraps its control is a click target for it; a `for=`-only label is a pointer. */
function wrapsLabelableControl(node: EnhancedDomTreeNode): boolean {
	for (const child of node.childrenNodes) {
		if (child.nodeType !== ELEMENT_NODE) continue;
		if (LABELABLE_TAGS.has(child.nodeName)) return true;
		if (wrapsLabelableControl(child)) return true;
	}
	return false;
}

/**
 * True when this node's weak click signals are its enclosing anchor's or button's, not its own.
 *
 * Chrome marks every box inside an `<a>` as `isClickable` and CSS gives them all `cursor: pointer`, so
 * a link with markup inside it would otherwise index one element per span. The walk stops at the first
 * non-element parent, which is exactly the shadow boundary: `custom-button`'s shadow `<span>` inherits
 * `cursor: pointer` from its host and the reference *does* index it.
 */
function inheritsClickAffordance(node: EnhancedDomTreeNode): boolean {
	let current: EnhancedDomTreeNode | null = node.parentNode;
	while (current !== null && current.nodeType === ELEMENT_NODE) {
		if (CLICK_SOURCE_TAGS.has(current.nodeName)) return true;
		current = current.parentNode;
	}
	return false;
}

/**
 * Interactivity predicate.
 *
 * ERRATUM(M1-dom-serialize-9, SETTLED by measurement): no spec section defines interactivity detection
 * — DATA-MODEL §6.3/§6.4 consume `isInteractive` without deriving it. The ordered list below is the
 * corpus-calibrated form (DECISION-REGISTER §9.6 (E-23) item 4); it measured 95.3 % agreement before
 * calibration, with every disagreement traced to a named rule. Still exposed through
 * `SimplifyOptions.isInteractive` so a future corpus can retune it without touching the renderer.
 *
 * Ordered rules, first decision wins:
 * 1. non-element → false
 * 2. `isVisible === false` → false (invisible elements are not actionable)
 * 3. `pointer-events: none` → false
 * 4. disabled (AX property, `disabled` attribute, or `aria-disabled`) → false
 * 5. `<label>` → true iff it *wraps* a labelable control; a label never reaches rules 6-12
 * 6. tag in {@linkcode INTERACTIVE_TAGS} → true
 * 7. editable `contenteditable` → true
 * 8. `tabindex` present and not `-1` → true
 * 9. AX role in {@linkcode INTERACTIVE_ROLES} → true
 * 10. Chrome-detected click handler (`snapshotNode.isClickable`), not inherited → true
 * 11. `hasJsClickListener` census hit → true
 * 12. `cursor: pointer`, not inherited → true
 * 13. otherwise false
 *
 * Rule 4 is corpus-only: nothing in `SPECS/` makes `disabled` an interactivity input, and the reference
 * indexes none of `#r-overnight`, `#ar-cash`, `#sel-disabled`, `#lb-opt-4`, `#v-disabled`.
 */
export function isInteractiveElement(
	node: EnhancedDomTreeNode,
	derived: SerializerDerived,
	options: { includeOffscreen?: boolean } = {},
): boolean {
	if (node.nodeType !== ELEMENT_NODE) return false;
	// ERRATUM(E-41): rule 2 admits the offscreen-only class when asked; the CSS gate still applies.
	if (isHiddenForWalk(node, options.includeOffscreen === true)) return false;
	if (node.snapshotNode?.computedStyles?.['pointer-events'] === 'none') return false;
	if (isDisabledControl(node)) return false;

	const tag = derived.tagName(node);
	if (tag === 'label') return wrapsLabelableControl(node);
	if (INTERACTIVE_TAGS.has(tag)) return true;

	const editable = node.attributes['contenteditable'];
	if (editable !== undefined && EDITABLE_VALUES.has(editable.toLowerCase())) return true;

	const tabindex = node.attributes['tabindex'];
	if (tabindex !== undefined && tabindex.trim() !== '-1') return true;

	const role = node.axNode?.role ?? null;
	if (role !== null && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;

	const inherited = inheritsClickAffordance(node);
	if (node.snapshotNode?.isClickable === true && !inherited) return true;
	if (node.hasJsClickListener) return true;

	const cursor = node.snapshotNode?.cursorStyle ?? node.snapshotNode?.computedStyles?.cursor ?? null;
	return cursor === 'pointer' && !inherited;
}

/** Options for {@linkcode simplifyDomTree}. */
export interface SimplifyOptions {
	readonly derived: SerializerDerived;
	/**
	 * R6.2 — the previous step's `(sessionId, backendNodeId)` keys. `undefined` (no previous state at
	 * all) marks nothing new; an explicitly empty set marks everything new.
	 */
	readonly previousKeys?: ReadonlySet<string> | undefined;
	/** `BrowserProfile.paintOrderFiltering`, default `true`. */
	readonly paintOrderFiltering?: boolean;
	/** Interactivity override; defaults to {@linkcode isInteractiveElement}. */
	readonly isInteractive?: (node: EnhancedDomTreeNode, derived: SerializerDerived) => boolean;
	/**
	 * ERRATUM(E-41). Index elements that pass the CSS gate but fail the viewport test, and render
	 * their line, so `include_hidden` can emit them with `visible: false`. Default `false`, which is
	 * the behaviour every recorded golden was measured against.
	 */
	readonly includeOffscreen?: boolean;
	/** R6.4 — whole-request wall-clock budget in ms. */
	readonly budgetMs?: number;
	/** Clock injection point for the budget; defaults to {@linkcode Date.now}. */
	readonly now?: () => number;
}

/** Output of {@linkcode simplifyDomTree}. */
export interface SimplifyResult {
	readonly root: SimplifiedNode | null;
	/** R6.1 — LLM index → node. */
	readonly selectorMap: Map<number, EnhancedDomTreeNode>;
	/** R6.3 — cached reverse map, keyed by {@linkcode selectorKey}. */
	readonly reverseMap: Map<string, number>;
	/** R6.2 — the key set the *next* step compares against. */
	readonly keys: Set<string>;
	/** R6.4 — true when the budget elapsed mid-walk; the caller must fail safe. */
	readonly timedOut: boolean;
}

/** R6.2/R6.3 map key: `backendNodeId` is only unique within its own session. */
export function selectorKey(sessionId: string, backendNodeId: number): string {
	return `${sessionId}:${backendNodeId}`;
}

/** Page-absolute rectangle with a paint order, used by the occlusion filter. */
interface Occluder {
	readonly node: EnhancedDomTreeNode;
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly paintOrder: number;
}

/** True when `ancestor` is on `node`'s parent chain. */
function isAncestorOf(ancestor: EnhancedDomTreeNode, node: EnhancedDomTreeNode): boolean {
	let current: EnhancedDomTreeNode | null = node.parentNode;
	while (current !== null) {
		if (current === ancestor) return true;
		current = current.parentNode;
	}
	return false;
}

/** Walks the whole IR once: every node, in document order, shadow roots and frames included. */
function* walkAll(root: EnhancedDomTreeNode): Generator<EnhancedDomTreeNode> {
	yield root;
	for (const shadowRoot of root.shadowRoots ?? []) yield* walkAll(shadowRoot);
	for (const child of root.childrenNodes) yield* walkAll(child);
	if (root.contentDocument !== null) yield* walkAll(root.contentDocument);
}

/**
 * Pre-pass: the reserved backend-id pool (R6.1) and the occluder set.
 *
 * Occluders are elements that actually paint something over an area: a resolved paint order, a
 * non-empty page-absolute box, a non-transparent background, and — ERRATUM(E-76) — a pointer that does
 * not pass through them (`pointer-events` other than `none`). The set is sorted by area (largest
 * first, ties broken by `backendNodeId`) and capped at {@linkcode MAX_OCCLUDERS} — a deterministic
 * bound that keeps the filter O(n·k) on pages built entirely out of coloured boxes.
 */
function collectPrepass(
	root: EnhancedDomTreeNode,
	paintOrderFiltering: boolean,
): { maxBackendId: number; occluders: Occluder[] } {
	let maxBackendId = 0;
	const occluders: Occluder[] = [];
	for (const node of walkAll(root)) {
		if (node.backendNodeId > maxBackendId) maxBackendId = node.backendNodeId;
		if (!paintOrderFiltering || node.nodeType !== ELEMENT_NODE) continue;
		const paintOrder = node.snapshotNode?.paintOrder ?? null;
		const rect = node.absolutePosition;
		if (paintOrder === null || rect === null || rect.width <= 0 || rect.height <= 0) continue;
		if (node.isVisible === false) continue;
		// ERRATUM(E-76): an element with computed `pointer-events: none` is not an occluder. The pointer
		// passes through it — Chromium's hit test answers the element underneath (measured, U-2:
		// `pe-none-covered-button`), and so does the click cascade's own occlusion check — so a control under
		// such a cover is actionable, and filtering it out left `browser_element_at` answering "nothing" for a
		// point a click would land on. The donor (and its recorded golden for `occlusion_paint_order`) treats
		// the cover as an occluder; this is a deliberate divergence from that golden. `pointer-events` is
		// inherited, so a cover's descendants drop out with it unless they turn it back on — and one that does
		// receives the pointer, so it still occludes.
		if (node.snapshotNode?.computedStyles?.['pointer-events'] === 'none') continue;
		const background = node.snapshotNode?.computedStyles?.['background-color'] ?? '';
		if (TRANSPARENT_BACKGROUNDS.has(background) || ZERO_ALPHA.test(background)) continue;
		occluders.push({
			node,
			left: rect.x,
			top: rect.y,
			right: rect.x + rect.width,
			bottom: rect.y + rect.height,
			paintOrder,
		});
	}
	occluders.sort((a, b) => {
		const areaA = (a.right - a.left) * (a.bottom - a.top);
		const areaB = (b.right - b.left) * (b.bottom - b.top);
		if (areaA !== areaB) return areaB - areaA;
		return a.node.backendNodeId - b.node.backendNodeId;
	});
	return { maxBackendId, occluders: occluders.slice(0, MAX_OCCLUDERS) };
}

/** Mutable walk state. */
interface WalkContext {
	readonly derived: SerializerDerived;
	readonly interactive: (node: EnhancedDomTreeNode, derived: SerializerDerived) => boolean;
	readonly occluders: readonly Occluder[];
	readonly previousKeys: ReadonlySet<string> | undefined;
	readonly selectorMap: Map<number, EnhancedDomTreeNode>;
	readonly reverseMap: Map<string, number>;
	readonly keys: Set<string>;
	readonly usedIndices: Set<number>;
	readonly deadline: number | null;
	readonly now: () => number;
	/** ERRATUM(E-41). */
	readonly includeOffscreen: boolean;
	nextSynthetic: number;
	visited: number;
	timedOut: boolean;
}

/** R6.4 — checks the wall-clock budget every {@linkcode BUDGET_CHECK_INTERVAL} nodes. */
function overBudget(context: WalkContext): boolean {
	if (context.timedOut) return true;
	context.visited += 1;
	if (context.deadline === null) return false;
	if (context.visited % BUDGET_CHECK_INTERVAL !== 0) return false;
	if (context.now() < context.deadline) return false;
	context.timedOut = true;
	return true;
}

/** True when a later-painting, non-related element fully covers this node's box. */
function isOccluded(node: EnhancedDomTreeNode, context: WalkContext): boolean {
	const rect = node.absolutePosition;
	const paintOrder = node.snapshotNode?.paintOrder ?? null;
	if (rect === null || paintOrder === null) return false;
	const left = rect.x;
	const top = rect.y;
	const right = rect.x + rect.width;
	const bottom = rect.y + rect.height;
	for (const occluder of context.occluders) {
		if (occluder.node === node || occluder.paintOrder <= paintOrder) continue;
		if (occluder.left > left || occluder.top > top || occluder.right < right || occluder.bottom < bottom) continue;
		// A container painting behind its own content, or content painting inside its own container,
		// is layout — not occlusion.
		if (isAncestorOf(occluder.node, node) || isAncestorOf(node, occluder.node)) continue;
		return true;
	}
	return false;
}

/**
 * R6.1 — the node's `backendNodeId`, or the next free synthetic index above the reserved pool when
 * that id is already taken (OOPIF sessions number their nodes independently).
 *
 * ERRATUM(M1-dom-serialize-12): R6.1 reads "the next integer above `max(reservedBackendIds) + 1` that
 * does not collide", which is ambiguous about whether `max + 1` is the first candidate or the last
 * excluded one. Implemented as "smallest free integer ≥ max(reserved) + 1" — the reading under which
 * the "does not collide" clause still does work (it guards synthetics against each other).
 */
function assignIndex(node: EnhancedDomTreeNode, context: WalkContext): number {
	let index = node.backendNodeId;
	if (context.usedIndices.has(index)) {
		while (context.usedIndices.has(context.nextSynthetic)) context.nextSynthetic += 1;
		index = context.nextSynthetic;
		context.nextSynthetic += 1;
	}
	context.usedIndices.add(index);
	context.selectorMap.set(index, node);
	const key = selectorKey(node.sessionId, node.backendNodeId);
	context.reverseMap.set(key, index);
	context.keys.add(key);
	return index;
}

/** Empty simplified node with every §6.3 flag at its default. */
function blankNode(node: EnhancedDomTreeNode, children: SimplifiedNode[]): SimplifiedNode {
	return {
		originalNode: node,
		children,
		shouldDisplay: false,
		isInteractive: false,
		selectorIndex: null,
		isNew: false,
		ignoredByPaintOrder: false,
		excludedByParent: false,
		isShadowHost: false,
		isCompoundComponent: false,
	};
}

/**
 * A collapsed `<svg>`'s subtree: nothing renders, and only anchors still consume a selector index.
 *
 * E-23 item 1 records this as an apparent reference defect reproduced deliberately. `svg_children`'s
 * `#svg-link` occupies index 47 in the reference's selector map while having **no token in the visible
 * text**, so the model can never emit an action referencing it; the only observable effect is that the
 * index is consumed, and *not* consuming it would shift every later index on the page. The sibling
 * `<g id=svg-clickable role=button tabindex=0>` is interactive by two separate rules and the reference
 * indexes it nowhere, which is what bounds this to anchors. One data point, so two other readings
 * survive and are recorded rather than silently chosen: "the first interactive descendant" and "the
 * descendants Chrome marks `isClickable`" both fit the same single observation.
 */
function reserveCollapsedIndices(node: EnhancedDomTreeNode, context: WalkContext): void {
	for (const child of node.childrenNodes) {
		if (overBudget(context)) return;
		if (child.nodeType !== ELEMENT_NODE) continue;
		const isAnchor = context.derived.tagName(child) === 'a' && child.attributes['href'] !== undefined;
		if (isAnchor && context.interactive(child, context.derived)) assignIndex(child, context);
		reserveCollapsedIndices(child, context);
	}
}

/** Simplifies one node, returning the survivors to splice into the parent's child list. */
function simplifyNode(node: EnhancedDomTreeNode, context: WalkContext, excluded: boolean): SimplifiedNode[] {
	if (overBudget(context)) return [];

	if (node.nodeType === TEXT_NODE) {
		if (excluded) return [];
		if (!isNodeVisible(node)) return [];
		if (node.nodeValue.replace(/\s+/g, ' ').trim().length <= 1) return [];
		return [{ ...blankNode(node, []), shouldDisplay: true }];
	}

	if (node.nodeType !== ELEMENT_NODE) return simplifyChildren(node, context, excluded);

	const tag = context.derived.tagName(node);
	// A hidden element hides everything beneath it: `isVisible` is the CSS gate plus the viewport test,
	// and neither applies to a parent without applying to its subtree. ERRATUM(E-41): with
	// `includeOffscreen` the viewport half is waived and only the CSS gate hides.
	const hidden = isHiddenForWalk(node, context.includeOffscreen);
	const occluded = !excluded && !hidden && isOccluded(node, context);
	const suppressed = excluded || occluded || hidden;
	const isSvg = tag === 'svg';

	const interactive = context.interactive(node, context.derived);
	const scrollable = context.derived.isActuallyScrollable(node);
	const isFrame = FRAME_TAGS.has(tag);
	// ERRATUM(M1-parity-7): §6.4's `[544]<svg />` example shows an *interactive* SVG root, and this pass
	// used to drop a non-interactive one entirely — the reference emits a line for every SVG root
	// (`<svg id=plain-svg /> <!-- SVG content collapsed -->`).
	const candidate = interactive || scrollable || isFrame || isSvg;

	// Index assignment is DOCUMENT order, so it must happen before the subtree is walked. A `<tr>` is
	// indexed before its `<td>`s, a `<label>` before the `<input>` it wraps, an `<iframe>` before its
	// content — all four shapes appear in the recorded corpus and all four order the parent first.
	// ERRATUM(M1-parity-13): this pass used to assign after `simplifyChildren`, i.e. post-order, which
	// was unobservable only while no container tag was interactive.
	const selectorIndex = candidate && !suppressed && interactive ? assignIndex(node, context) : null;

	// SVG survives as a root; everything below it collapses into that one line (§6.4).
	const children = isSvg ? [] : simplifyChildren(node, context, suppressed);
	if (isSvg && !suppressed) reserveCollapsedIndices(node, context);
	if (!candidate) return children;

	// Every shadow root makes its host a shadow host, `user-agent` included: the reference marks
	// `<input>`, `<select>`, `<option>` and `<details>` hosts `|SHADOW(open)|` (19x on one page).
	// Their *content* is still not walked — see `simplifyChildren`.
	const isShadowHost = (node.shadowRoots ?? []).length > 0;
	const isCompoundComponent = compoundComponents(node, tag).length > 0;

	if (suppressed) {
		return [{
			...blankNode(node, children),
			isInteractive: interactive,
			ignoredByPaintOrder: occluded,
			excludedByParent: excluded || hidden,
			isShadowHost,
			isCompoundComponent,
		}];
	}

	const key = selectorKey(node.sessionId, node.backendNodeId);
	// ERRATUM(M1-dom-serialize-13): R6.2 does not say what step 1 does, where no previous state exists.
	// `previousKeys === undefined` marks nothing new (starring all ~200 elements of the first page is
	// noise, not signal); an explicitly empty set marks everything new.
	const isNew = selectorIndex === null
		? false
		: isCompoundComponent || (context.previousKeys !== undefined && !context.previousKeys.has(key));

	return [{
		originalNode: node,
		children,
		shouldDisplay: true,
		isInteractive: interactive,
		selectorIndex,
		isNew,
		ignoredByPaintOrder: false,
		excludedByParent: false,
		isShadowHost,
		isCompoundComponent,
	}];
}

/**
 * Children in render order: shadow roots first (shadow content replaces light content unless slotted,
 * and the LLM reads what it sees), then light children, then the frame's inner document.
 *
 * ERRATUM(M1-dom-serialize-10): `user-agent` shadow roots are skipped — §6.4 names only
 * `Open Shadow` / `Closed Shadow` wrappers, and UA roots hold browser-internal widget structure that
 * no action can address.
 */
function simplifyChildren(node: EnhancedDomTreeNode, context: WalkContext, excluded: boolean): SimplifiedNode[] {
	const result: SimplifiedNode[] = [];
	for (const shadowRoot of node.shadowRoots ?? []) {
		if (shadowRoot.shadowRootType === 'user-agent') continue;
		const inner = simplifyChildren(shadowRoot, context, excluded);
		if (inner.length === 0) continue;
		result.push({ ...blankNode(shadowRoot, inner), shouldDisplay: true });
	}
	for (const child of node.childrenNodes) result.push(...simplifyNode(child, context, excluded));
	if (node.contentDocument !== null) result.push(...simplifyChildren(node.contentDocument, context, excluded));
	return result;
}

/** Runs the §6.3 simplification pass over a merged DOM tree. */
export function simplifyDomTree(root: EnhancedDomTreeNode | null, options: SimplifyOptions): SimplifyResult {
	const selectorMap = new Map<number, EnhancedDomTreeNode>();
	const reverseMap = new Map<string, number>();
	const keys = new Set<string>();
	if (root === null) return { root: null, selectorMap, reverseMap, keys, timedOut: false };

	const paintOrderFiltering = options.paintOrderFiltering ?? true;
	const { maxBackendId, occluders } = collectPrepass(root, paintOrderFiltering);
	const now = options.now ?? Date.now;
	const includeOffscreen = options.includeOffscreen === true;
	const context: WalkContext = {
		derived: options.derived,
		interactive: options.isInteractive ??
			((candidate, derived) => isInteractiveElement(candidate, derived, { includeOffscreen })),
		includeOffscreen,
		occluders,
		previousKeys: options.previousKeys,
		selectorMap,
		reverseMap,
		keys,
		usedIndices: new Set<number>(),
		deadline: options.budgetMs === undefined ? null : now() + options.budgetMs,
		now,
		nextSynthetic: maxBackendId + 1,
		visited: 0,
		timedOut: false,
	};

	const children = root.nodeType === ELEMENT_NODE
		? simplifyNode(root, context, false)
		: simplifyChildren(root, context, false);
	return {
		root: blankNode(root, children),
		selectorMap,
		reverseMap,
		keys,
		timedOut: context.timedOut,
	};
}
