/**
 * The locator model (DD-4, `report_design.md` §5).
 *
 * A locator candidate is one of seven kinds, ranked in the intake's order, each carrying the number of
 * matches **in the element's own document** and the frame that count was made in. The counts here are
 * answered from the serializer's own index of the merged tree — a walk over data already in memory,
 * never a CDP round trip — because computing seven `DOM.performSearch` calls for 1200 elements is not
 * a tool call, it is an outage. The count is therefore "as of the capture the state token names";
 * `browser_verify_locator` is the tool that asks the browser what it matches today.
 *
 * Kinds that need the element's own text or accessible name read it through the same gates the rest
 * of the element record uses, so a password field never yields a `text` or `label` candidate built
 * from its value (DD-7): `text` reads children text, never `value`, and `label` reads the associated
 * `<label>` or `aria-label`, never the field.
 */
import { type EnhancedDomTreeNode, getAllChildrenText, normalizeWhitespace, walkTree } from '@tykotech/browser';
import { ToolError } from './errors.ts';

/** The seven kinds, in rank order. The array order **is** the ranking. */
export const LOCATOR_KINDS = ['testid', 'id', 'name', 'aria', 'label', 'css', 'text'] as const;
export type LocatorKind = (typeof LOCATOR_KINDS)[number];

/** One candidate, as the wire carries it. */
export interface LocatorCandidate {
	kind: LocatorKind;
	/** The selector, in the kind's own syntax. */
	value: string;
	/** `matches === 1`. */
	unique: boolean;
	/** Count in the element's own document, as of the capture. */
	matches: number;
	/** The document `matches` was counted in. */
	frame_id: string;
}

/** The four test-id spellings, resolved in this order and always emitted as `data-testid`. */
export const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa'] as const;

/** `text=` values are capped here; a paragraph is not a locator. */
export const MAX_TEXT_LOCATOR_CHARS = 80;

/** A structural `css` path is at most this many segments from its id-bearing anchor. */
export const MAX_CSS_SEGMENTS = 6;

const ELEMENT_NODE = 1;

/** A CSS identifier that needs no escaping; anything else is spelled `[id="…"]`. */
const CSS_IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Per-document counts of every locator value this model can produce.
 *
 * Built once per observation from the merged tree, so answering `matches` for 1200 elements is 1200
 * map lookups rather than 1200 walks. Keyed by `frameId`, because DD-4 measures uniqueness in the
 * element's own document and a value that is unique inside an iframe is not unique in the page.
 */
export interface DocumentIndex {
	readonly byFrame: ReadonlyMap<string, FrameCounts>;
}

interface FrameCounts {
	readonly testid: Map<string, number>;
	readonly id: Map<string, number>;
	/** Keyed `tag name`. */
	readonly name: Map<string, number>;
	/** Keyed `role name`. */
	readonly aria: Map<string, number>;
	readonly label: Map<string, number>;
	readonly text: Map<string, number>;
	/** `for` → the label's normalised text, for the `label` kind. */
	readonly labelFor: Map<string, string>;
	/** Every element of the frame, for `css` path evaluation. */
	readonly elements: EnhancedDomTreeNode[];
}

function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function countsFor(index: Map<string, FrameCounts>, frameId: string): FrameCounts {
	let counts = index.get(frameId);
	if (counts === undefined) {
		counts = {
			testid: new Map(),
			id: new Map(),
			name: new Map(),
			aria: new Map(),
			label: new Map(),
			text: new Map(),
			labelFor: new Map(),
			elements: [],
		};
		index.set(frameId, counts);
	}
	return counts;
}

/** The test-id value an element carries, whichever spelling the page used. */
export function testIdOf(node: EnhancedDomTreeNode): string | undefined {
	for (const attribute of TEST_ID_ATTRIBUTES) {
		const value = node.attributes[attribute];
		if (value !== undefined && value !== '') return value;
	}
	return undefined;
}

/** The element's own visible text, normalised and capped — never its `value`. */
export function ownTextOf(node: EnhancedDomTreeNode): string {
	const text = normalizeWhitespace(getAllChildrenText(node, 2));
	return text.length > MAX_TEXT_LOCATOR_CHARS ? text.slice(0, MAX_TEXT_LOCATOR_CHARS) : text;
}

/**
 * What a `label=` candidate names: the associated `<label for=…>`'s text, a wrapping `<label>`'s
 * text, or `aria-label`. Never the field's own value.
 */
function labelTextOf(node: EnhancedDomTreeNode, counts: FrameCounts): string | undefined {
	const aria = normalizeWhitespace(node.attributes['aria-label'] ?? '');
	if (aria !== '') return aria;
	const id = node.attributes['id'];
	if (id !== undefined) {
		const forLabel = counts.labelFor.get(id);
		if (forLabel !== undefined && forLabel !== '') return forLabel;
	}
	let parent = node.parentNode;
	while (parent !== null && parent.nodeType === ELEMENT_NODE) {
		if (parent.nodeName === 'LABEL') {
			const text = ownTextOf(parent);
			return text === '' ? undefined : text;
		}
		parent = parent.parentNode;
	}
	return undefined;
}

/** Builds the per-document index over the whole merged tree, frames included. */
export function buildDocumentIndex(root: EnhancedDomTreeNode | null): DocumentIndex {
	const byFrame = new Map<string, FrameCounts>();
	if (root === null) return { byFrame };
	const nodes = walkTree(root).filter((node) => node.nodeType === ELEMENT_NODE);
	// Labels first, so `labelFor` is complete before any control asks for it.
	for (const node of nodes) {
		if (node.nodeName !== 'LABEL') continue;
		const target = node.attributes['for'];
		if (target === undefined) continue;
		countsFor(byFrame, node.frameId).labelFor.set(target, ownTextOf(node));
	}
	for (const node of nodes) {
		const counts = countsFor(byFrame, node.frameId);
		counts.elements.push(node);
		const testId = testIdOf(node);
		if (testId !== undefined) bump(counts.testid, testId);
		const id = node.attributes['id'];
		if (id !== undefined && id !== '') bump(counts.id, id);
		const name = node.attributes['name'];
		if (name !== undefined && name !== '') bump(counts.name, `${node.nodeName} ${name}`);
		const role = node.axNode?.role ?? null;
		const axName = node.axNode?.name ?? null;
		if (role !== null && role !== '' && axName !== null && axName !== '') bump(counts.aria, `${role} ${axName}`);
		const label = labelTextOf(node, counts);
		if (label !== undefined) bump(counts.label, label);
		// A `text=` locator names the innermost element carrying the text, the way every text
		// selector engine resolves it: a `<div>` whose only content is one `<button>` has the same
		// children text as the button, and counting it would make every wrapped control non-unique.
		const text = ownTextOf(node);
		if (text !== '' && !hasElementChildWithText(node, text)) bump(counts.text, text);
	}
	return { byFrame };
}

function hasElementChildWithText(node: EnhancedDomTreeNode, text: string): boolean {
	return node.childrenNodes.some((child) => child.nodeType === ELEMENT_NODE && ownTextOf(child) === text);
}

function idSelector(id: string): string {
	return CSS_IDENT.test(id) ? `#${id}` : `[id="${escapeAttribute(id)}"]`;
}

function escapeAttribute(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** 1-based position among same-tag element siblings, or `null` when the tag is unambiguous. */
function nthOfType(node: EnhancedDomTreeNode): number | null {
	const parent = node.parentNode;
	if (parent === null) return null;
	const siblings = parent.childrenNodes.filter((child) =>
		child.nodeType === ELEMENT_NODE && child.nodeName === node.nodeName
	);
	if (siblings.length <= 1) return null;
	return siblings.indexOf(node) + 1;
}

/**
 * A structural path from the nearest id-bearing ancestor, at most {@linkcode MAX_CSS_SEGMENTS}
 * segments, `:nth-of-type` only where a tag alone is ambiguous. `undefined` when the element has no
 * anchor within reach, because a path from the document root is fragile enough to be worthless.
 */
export function cssPathOf(node: EnhancedDomTreeNode): string | undefined {
	const segments: string[] = [];
	let current: EnhancedDomTreeNode | null = node;
	while (current !== null && current.nodeType === ELEMENT_NODE) {
		const id = current.attributes['id'];
		if (id !== undefined && id !== '' && current !== node) {
			segments.unshift(idSelector(id));
			return segments.join(' > ');
		}
		if (segments.length >= MAX_CSS_SEGMENTS) return undefined;
		const nth = nthOfType(current);
		segments.unshift(
			nth === null ? current.nodeName.toLowerCase() : `${current.nodeName.toLowerCase()}:nth-of-type(${nth})`,
		);
		current = current.parentNode;
	}
	return undefined;
}

/**
 * Evaluates a path {@linkcode cssPathOf} produced against the in-memory frame: every id-bearing
 * anchor, then the segments as a strict child descent. It matches exactly what the path means, so
 * disagreement with the browser can only come from a page that changed since the capture.
 */
function countCssPath(path: string, counts: FrameCounts): number {
	const [anchor, ...rest] = path.split(' > ');
	if (anchor === undefined) return 0;
	const anchorId = anchor.startsWith('#')
		? anchor.slice(1)
		: /^\[id="(.*)"\]$/.exec(anchor)?.[1]?.replaceAll('\\"', '"');
	if (anchorId === undefined) return 0;
	let frontier = counts.elements.filter((element) => element.attributes['id'] === anchorId);
	for (const segment of rest) {
		const match = /^([a-z0-9-]+)(?::nth-of-type\((\d+)\))?$/.exec(segment);
		if (match === null) return 0;
		const tag = (match[1] ?? '').toUpperCase();
		const nth = match[2] === undefined ? null : Number(match[2]);
		const next: EnhancedDomTreeNode[] = [];
		for (const parent of frontier) {
			const sameTag = parent.childrenNodes.filter((child) => child.nodeType === ELEMENT_NODE && child.nodeName === tag);
			if (nth === null) next.push(...sameTag);
			else {
				const picked = sameTag[nth - 1];
				if (picked !== undefined) next.push(picked);
			}
		}
		frontier = next;
		if (frontier.length === 0) return 0;
	}
	return frontier.length;
}

/**
 * Every candidate the element supports, in DD-4 kind order, at most one per kind.
 *
 * A kind that cannot be computed is absent, not present with a sentinel; `[]` is legal and means a
 * bare `<div>` with a click listener.
 */
export function locatorCandidates(node: EnhancedDomTreeNode, index: DocumentIndex): LocatorCandidate[] {
	const counts = index.byFrame.get(node.frameId);
	if (counts === undefined) return [];
	const frame = node.frameId;
	const out: LocatorCandidate[] = [];
	const push = (kind: LocatorKind, value: string, matches: number): void => {
		out.push({ kind, value, unique: matches === 1, matches, frame_id: frame });
	};

	const testId = testIdOf(node);
	if (testId !== undefined) {
		push('testid', `[data-testid="${escapeAttribute(testId)}"]`, counts.testid.get(testId) ?? 0);
	}

	const id = node.attributes['id'];
	if (id !== undefined && id !== '') push('id', idSelector(id), counts.id.get(id) ?? 0);

	const name = node.attributes['name'];
	if (name !== undefined && name !== '') {
		push(
			'name',
			`${node.nodeName.toLowerCase()}[name="${escapeAttribute(name)}"]`,
			counts.name.get(`${node.nodeName} ${name}`) ?? 0,
		);
	}

	const role = node.axNode?.role ?? null;
	const axName = node.axNode?.name ?? null;
	if (role !== null && role !== '' && axName !== null && axName !== '') {
		push('aria', `role=${role}[name="${escapeAttribute(axName)}"]`, counts.aria.get(`${role} ${axName}`) ?? 0);
	}

	const label = labelTextOf(node, counts);
	if (label !== undefined) push('label', `label=${label}`, counts.label.get(label) ?? 0);

	const css = cssPathOf(node);
	if (css !== undefined) push('css', css, countCssPath(css, counts));

	const text = ownTextOf(node);
	if (text !== '' && !hasElementChildWithText(node, text)) push('text', `text=${text}`, counts.text.get(text) ?? 0);

	return out;
}

/** A locator as a caller states it, parsed into what its kind needs. */
export type ParsedLocator =
	| { kind: 'testid' | 'id' | 'name' | 'css'; selector: string }
	| { kind: 'text'; text: string }
	| { kind: 'aria'; role: string; name: string }
	| { kind: 'label'; label: string };

/**
 * The selector a bare `id`, `testid` or `name` value means. `browser_locator_candidates` emits these kinds as full
 * selectors (`#username`, `[data-testid="x"]`, `input[name="q"]`) and those pass unchanged; a caller that writes the
 * bare attribute value (`{kind: 'id', value: 'username'}`) means the same element, but the bare text went to
 * `DOM.performSearch`, which also matches plain text, and counted every element mentioning the word instead.
 */
function selectorOfBare(kind: 'testid' | 'id' | 'name', value: string): string {
	const bare = value.trim();
	switch (kind) {
		case 'id':
			return bare.startsWith('#') || bare.startsWith('[') ? value : idSelector(bare);
		case 'testid':
			return bare.startsWith('[') ? value : `[data-testid="${escapeAttribute(bare)}"]`;
		case 'name':
			return bare.includes('[') ? value : `[name="${escapeAttribute(bare)}"]`;
	}
}

/**
 * Parses `{kind, value}` into its kind's own syntax, refusing a malformed value as a caller error:
 * an `aria` string that is not `role=…[name="…"]`, a `label=`/`text=` value without its prefix, an
 * empty selector. A CSS selector is not validated here — the browser is the matcher, and a selector
 * it cannot parse simply matches nothing.
 */
export function parseLocator(kind: LocatorKind, value: string): ParsedLocator {
	const malformed = (detail: string) => new ToolError('invalid-arguments', `locator ${kind}: ${detail}`);
	switch (kind) {
		case 'testid':
		case 'id':
		case 'name':
		case 'css': {
			if (value.trim() === '') throw malformed('the selector is empty');
			return { kind, selector: kind === 'css' ? value : selectorOfBare(kind, value) };
		}
		case 'text': {
			if (!value.startsWith('text=') || value.length === 'text='.length) throw malformed('expected text=…');
			return { kind, text: value.slice('text='.length) };
		}
		case 'label': {
			if (!value.startsWith('label=') || value.length === 'label='.length) throw malformed('expected label=…');
			return { kind, label: value.slice('label='.length) };
		}
		case 'aria': {
			const match = /^role=([^\[]+)\[name="(.*)"\]$/.exec(value);
			if (match === null || match[1] === undefined || match[2] === undefined) {
				throw malformed('expected role=…[name="…"]');
			}
			return { kind, role: match[1], name: match[2] };
		}
	}
}

/** The string `DOM.performSearch` takes for a selector or text kind. */
export function searchQueryOf(locator: ParsedLocator): string {
	switch (locator.kind) {
		case 'text':
			return locator.text;
		case 'aria':
		case 'label':
			throw new ToolError('invalid-arguments', `locator ${locator.kind} has no browser search; counted in memory`);
		default:
			return locator.selector;
	}
}

/** The in-memory count for the two kinds no CDP search can match, in one document of the index. */
export function countLocator(locator: ParsedLocator, frameId: string, index: DocumentIndex): number {
	const counts = index.byFrame.get(frameId);
	if (counts === undefined) return 0;
	switch (locator.kind) {
		case 'aria':
			return counts.aria.get(`${locator.role} ${locator.name}`) ?? 0;
		case 'label':
			return counts.label.get(locator.label) ?? 0;
		default:
			return 0;
	}
}

/**
 * The one locator the `core` preset carries: the first unique candidate, else the first candidate,
 * with `unique` saying which case the client got. `null` when there is no candidate at all.
 */
export function bestLocator(candidates: readonly LocatorCandidate[]): LocatorCandidate | null {
	return candidates.find((candidate) => candidate.unique) ?? candidates[0] ?? null;
}
