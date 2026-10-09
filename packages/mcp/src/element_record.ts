/**
 * The element record (`report_design.md` §3): every field `browser_get_state` and the locator tools
 * can emit for one interactive element, the `fields` presets that select them, and the two cost
 * levers (`element_limit`, `frames`) that bound the array.
 *
 * Units, stated because getting them wrong is the failure this delivery exists to remove: `bounds`
 * is CSS pixels of the top document with the origin at the **layout viewport**'s top-left, which is
 * `absolutePosition - pageInfo.scroll`; `document_bounds` is page-absolute, exactly
 * `absolutePosition`. Device pixel ratio was divided out exactly once upstream.
 *
 * `bounds` is where the server believes the element is. For an element inside a cross-origin frame
 * it is also where the server clicks. For an element in the top document the server uses live quads
 * and may click elsewhere if the element is transformed. Use `bounds` to draw, to rank and for
 * `near`; use `index` to act (architecture §5.4).
 *
 * Every value-bearing field goes through the one password predicate (`isPasswordField`, owned by
 * `@tykotech/browser`): `input.value` becomes the literal `•••`, `attrs` never carries `value`, and
 * `text` is empty (DD-7, invariant I-14).
 */
import {
	type DomRect,
	type EnhancedDomTreeNode,
	type FrameRecord,
	getMeaningfulTextForLlm,
	isDisabledControl,
	isPasswordField,
	normalizeWhitespace,
} from '@tykotech/browser';
import { bestLocator, type DocumentIndex, type LocatorCandidate, locatorCandidates, testIdOf } from './locators.ts';

/** The optional fields, by wire name. The five frozen fields are not listed: they are always emitted. */
export const FIELD_NAMES = [
	'bounds',
	'document_bounds',
	'visible',
	'enabled',
	'focused',
	'frame_id',
	'frame',
	'input',
	'attrs',
	'text',
	'locator',
	'locators',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/**
 * The three presets. `minimal` is the five frozen fields alone.
 *
 * `core` is the default and its cost is the number that makes the contract cheap: the plan's gate
 * is at or below roughly 310 B/element on the heaviest recorded capture. The design (§3.2) put
 * `locator` in it on a model that used placeholder locator strings and measured 307; the real
 * candidate — a selector plus a 32-hex-character `frame_id` — costs 118 B/element on
 * `truncation_large`, and with it the default measured **368.4 B/element** (`element_record_test.ts`,
 * A-4). The plan's rule for an overshoot is to cut a field rather than raise the number, so `locator`
 * is opt-in (`fields: ['core', 'locator']`) and `core` measures 250.4 B/element on that capture.
 * Recorded as D-035.
 */
export const FIELD_PRESETS = {
	minimal: [] as readonly FieldName[],
	core: ['bounds', 'visible', 'enabled', 'focused', 'frame_id'] as readonly FieldName[],
	full: [
		'bounds',
		'visible',
		'enabled',
		'focused',
		'frame_id',
		'locator',
		'document_bounds',
		'frame',
		'input',
		'attrs',
		'text',
		'locators',
	] as readonly FieldName[],
} as const;
export type FieldPreset = keyof typeof FIELD_PRESETS;

/** Every legal member of a `fields` array: a preset name or a field name. */
export const FIELD_OPTIONS = ['minimal', 'core', 'full', ...FIELD_NAMES] as const;
export type FieldOption = (typeof FIELD_OPTIONS)[number];

/**
 * The fields that imply an `element_limit` of {@linkcode IMPLIED_ELEMENT_LIMIT} when none is given,
 * because they are where the array crosses a megabyte on the heaviest recorded page (design §3.2).
 */
export const HEAVY_FIELDS: ReadonlySet<FieldName> = new Set([
	'document_bounds',
	'frame',
	'input',
	'attrs',
	'text',
	'locators',
]);
export const IMPLIED_ELEMENT_LIMIT = 500;

/** The `attrs` whitelist, closed at ten keys. `value` is deliberately not one of them. */
export const ATTRS_WHITELIST = [
	'id',
	'name',
	'type',
	'placeholder',
	'title',
	'alt',
	'role',
	'for',
	'aria-label',
] as const;

/** What `input.value` carries when the password predicate fires and the field is not empty. */
export const MASKED_INPUT_VALUE = '•••';

/** `text` is capped here. */
export const MAX_TEXT_CHARS = 200;

/**
 * Resolves a `fields` request to the set of optional fields to emit: the union of everything named.
 * Omitted means `['core']`.
 */
export function resolveFields(requested: readonly FieldOption[] | undefined): ReadonlySet<FieldName> {
	const out = new Set<FieldName>();
	for (const option of requested ?? ['core']) {
		if (option in FIELD_PRESETS) { for (const field of FIELD_PRESETS[option as FieldPreset]) out.add(field); }
		else out.add(option as FieldName);
	}
	return out;
}

/** `element_limit` as the contract resolves it: the caller's, else 500 when a heavy field is on. */
export function effectiveElementLimit(fields: ReadonlySet<FieldName>, requested: number | undefined): number | null {
	if (requested !== undefined) return requested;
	for (const field of fields) if (HEAVY_FIELDS.has(field)) return IMPLIED_ELEMENT_LIMIT;
	return null;
}

/** `{x, y, w, h}` — the wire spelling of a rectangle. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The live state of a form control. */
export interface InputState {
	type: string;
	name: string;
	value: string | null;
	placeholder: string;
	checked: boolean | null;
}

/** One interactive element, as a model addresses it. The first five fields are the frozen 0.1.0 record. */
export interface ObservedElement {
	index: number;
	tag: string;
	/** What the control is called — the accessible name, or its own text. */
	label?: string;
	/** ARIA role, when it says something the tag name does not. */
	role?: string;
	href?: string;
	/** Top-document viewport CSS px; `null` when the element has no box. */
	bounds?: Rect | null;
	/** Page-absolute CSS px; `null` when the element has no box. */
	document_bounds?: Rect | null;
	visible?: boolean;
	enabled?: boolean;
	focused?: boolean;
	frame_id?: string;
	frame?: { id: string; url: string };
	input?: InputState;
	attrs?: Record<string, string>;
	text?: string;
	locator?: LocatorCandidate | null;
	locators?: LocatorCandidate[];
}

/** What the builder needs beyond the node: the scroll to subtract, the indexes, the frame URLs. */
export interface ElementRecordContext {
	readonly fields: ReadonlySet<FieldName>;
	readonly scroll: { x: number; y: number };
	/** `null` when no locator field is requested, so the index is never built for nothing. */
	readonly locators: DocumentIndex | null;
	readonly frameUrls: ReadonlyMap<string, string>;
	/** The five-field label, produced by the caller so one function owns it (E-24, E-34). */
	readonly labelOf: (node: EnhancedDomTreeNode) => string;
}

function rectOf(rect: DomRect, scroll: { x: number; y: number }): Rect {
	return { x: rect.x - scroll.x, y: rect.y - scroll.y, w: rect.width, h: rect.height };
}

/** True when the accessibility tree reports the node as the focused one. */
export function isFocused(node: EnhancedDomTreeNode): boolean {
	for (const property of node.axNode?.properties ?? []) {
		if (property.name === 'focused') return property.value === true || property.value === 'true';
	}
	return false;
}

const FORM_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const CHECKABLE_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio']);

/**
 * The `input` field: the live columns E-39 decoded, with the attribute as the fallback when a
 * capture carried no column, and the password predicate applied before anything is read.
 */
export function inputStateOf(node: EnhancedDomTreeNode): InputState | undefined {
	if (!FORM_TAGS.has(node.nodeName)) return undefined;
	const attributes = node.attributes;
	const type = node.nodeName === 'INPUT'
		? (attributes['type'] ?? 'text').trim().toLowerCase() || 'text'
		: node.nodeName.toLowerCase();
	const name = attributes['name'] ?? '';
	const placeholder = attributes['placeholder'] ?? '';
	const snapshot = node.snapshotNode;

	let value: string | null;
	if (node.nodeName === 'SELECT') {
		value = null;
	} else if (isPasswordField(node)) {
		// DD-7: a consumer may learn that a value is present, never what it is or how long it is.
		const present = (snapshot?.inputValue ?? attributes['value'] ?? '') !== '';
		value = present ? MASKED_INPUT_VALUE : '';
	} else if (node.nodeName === 'TEXTAREA') {
		value = snapshot?.textValue ?? snapshot?.inputValue ?? null;
	} else {
		value = snapshot?.inputValue ?? attributes['value'] ?? null;
	}

	let checked: boolean | null = null;
	if (node.nodeName === 'INPUT' && CHECKABLE_TYPES.has(type)) {
		checked = snapshot?.inputChecked ?? attributes['checked'] !== undefined;
	}
	return { type, name, value, placeholder, checked };
}

/** The `attrs` field: the ten-key whitelist, absent keys omitted, the test id always under `data-testid`. */
export function attrsOf(node: EnhancedDomTreeNode): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const key of ATTRS_WHITELIST) {
		const value = node.attributes[key];
		if (value !== undefined) out[key] = value;
	}
	const testId = testIdOf(node);
	if (testId !== undefined) out['data-testid'] = testId;
	return Object.keys(out).length === 0 ? undefined : out;
}

/** The `text` field: the gated meaningful text, capped; empty for a password field. */
export function textOf(node: EnhancedDomTreeNode): string {
	if (isPasswordField(node)) return '';
	const text = normalizeWhitespace(getMeaningfulTextForLlm(node));
	return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/** Builds one record. The five frozen fields are produced exactly as 0.1.0 produced them. */
export function buildElementRecord(
	index: number,
	node: EnhancedDomTreeNode,
	ctx: ElementRecordContext,
): ObservedElement {
	const entry: ObservedElement = { index, tag: node.nodeName?.toLowerCase() ?? '' };
	const label = ctx.labelOf(node);
	if (label !== '') entry.label = label;
	const role = node.axNode?.role;
	if (role !== null && role !== undefined && role !== '' && role !== entry.tag) entry.role = role;
	if (node.attributes.href !== undefined) entry.href = node.attributes.href;

	const fields = ctx.fields;
	if (fields.size === 0) return entry;
	const position = node.absolutePosition;
	if (fields.has('bounds')) entry.bounds = position === null ? null : rectOf(position, ctx.scroll);
	if (fields.has('document_bounds')) {
		entry.document_bounds = position === null ? null : rectOf(position, { x: 0, y: 0 });
	}
	if (fields.has('visible')) entry.visible = node.isVisible !== false;
	if (fields.has('enabled')) entry.enabled = !isDisabledControl(node);
	if (fields.has('focused')) entry.focused = isFocused(node);
	if (fields.has('frame_id')) entry.frame_id = node.frameId;
	if (fields.has('frame')) entry.frame = { id: node.frameId, url: ctx.frameUrls.get(node.frameId) ?? '' };
	if (fields.has('input')) {
		const input = inputStateOf(node);
		if (input !== undefined) entry.input = input;
	}
	if (fields.has('attrs')) {
		const attrs = attrsOf(node);
		if (attrs !== undefined) entry.attrs = attrs;
	}
	if (fields.has('text')) {
		const text = textOf(node);
		if (text !== '') entry.text = text;
	}
	if (ctx.locators !== null && (fields.has('locator') || fields.has('locators'))) {
		const candidates = locatorCandidates(node, ctx.locators);
		if (fields.has('locator')) entry.locator = bestLocator(candidates);
		if (fields.has('locators')) entry.locators = candidates;
	}
	return entry;
}

/** The frame list as the wire carries it, from the merge's records. */
export interface FrameSummary {
	id: string;
	name: string;
	url: string;
	parent: string | null;
	/** The host `<iframe>`'s box, top-document viewport CSS px; `null` for the top document. */
	bounds: Rect | null;
	bounds_composed: boolean;
	is_oopif: boolean;
	captured: boolean;
}

export function frameSummaryOf(frame: FrameRecord, scroll: { x: number; y: number }): FrameSummary {
	return {
		id: frame.frameId,
		name: frame.name,
		url: frame.url,
		parent: frame.parentFrameId,
		bounds: frame.hostBounds === null ? null : rectOf(frame.hostBounds, scroll),
		bounds_composed: frame.composed,
		is_oopif: frame.isOopif,
		captured: frame.captured,
	};
}

/** The elements the page paints last, kept when `element_limit` binds; returned in index order. */
export function keepLastPainted(
	entries: ReadonlyArray<{ index: number; node: EnhancedDomTreeNode }>,
	limit: number,
): Array<{ index: number; node: EnhancedDomTreeNode }> {
	if (entries.length <= limit) return [...entries];
	return [...entries]
		.sort((a, b) => {
			const pa = a.node.snapshotNode?.paintOrder ?? -1;
			const pb = b.node.snapshotNode?.paintOrder ?? -1;
			return pb - pa || a.index - b.index;
		})
		.slice(0, limit)
		.sort((a, b) => a.index - b.index);
}
