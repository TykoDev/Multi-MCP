/** The page observation every perception path shares. */
import { ToolError, untilAborted } from './errors.ts';
import {
	type BrowserSession,
	defaultDerived,
	type EnhancedDomTreeNode,
	getAllChildrenText,
	isPasswordField,
	MAX_CLICKABLE_ELEMENTS_LENGTH,
	normalizeWhitespace,
	renderSimplifiedTree,
	type TabInfo,
} from '@tykotech/browser';
import {
	buildElementRecord,
	effectiveElementLimit,
	type FieldName,
	type FrameSummary,
	frameSummaryOf,
	isFocused,
	keepLastPainted,
	type ObservedElement,
} from './element_record.ts';
import { focusPayload } from './events.ts';
import { buildDocumentIndex } from './locators.ts';
import type { SessionRecord } from './registry.ts';

export type { ObservedElement } from './element_record.ts';

/** How much of a control's text is worth carrying into the element list. */
const MAX_LABEL_CHARS = 120;

/** What to call an interactive element. */
export function labelOf(node: EnhancedDomTreeNode): string {
	// Deliberately over-scrubbing: for a password field the `value` candidate is removed entirely rather than masked,
	// so nothing derived from it — not a prefix, not a length — reaches a label.
	const password = isPasswordField(node);
	const candidates = [
		node.axNode?.name,
		node.attributes['aria-label'],
		node.attributes.placeholder,
		password ? undefined : node.attributes.value,
		node.attributes.title,
		node.attributes.alt,
		getAllChildrenText(node, 2),
	];
	for (const candidate of candidates) {
		if (typeof candidate !== 'string') continue;
		const cleaned = normalizeWhitespace(candidate).trim();
		if (cleaned === '') continue;
		return cleaned.length > MAX_LABEL_CHARS ? `${cleaned.slice(0, MAX_LABEL_CHARS)}…` : cleaned;
	}
	return '';
}

/** Everything observation produces about a page. */
export interface Observation {
	sessionId: string;
	url: string;
	title: string;
	humanHasControl: boolean;
	tabs: Array<Record<string, unknown>>;
	viewport: { width: number; height: number };
	scroll: { x: number; y: number; pixelsAbove: number; pixelsBelow: number };
	elements: ObservedElement[];
	/** The serialized page: visible text with the same indices as `elements`. */
	page: string;
	/** Base64 PNG, when a screenshot was requested and produced. */
	screenshot?: string;
	/** The identity of the index table `elements` was read from; `null` when none is held. */
	stateToken: string | null;
	/** How many elements the table held before `element_limit` and `frames` applied. */
	elementsTotal: number;
	elementsTruncated: boolean;
	/** The one focused element's index, or `null`; agrees with the array by construction. */
	focusedIndex: number | null;
	frames: FrameSummary[];
	/** Frame ids the caller named that the page does not have. */
	framesUnknown: string[];
	captureTruncated: boolean;
}

/** The tab list, with focus resolved on the full target id. */
export function tabsOf(
	session: BrowserSession,
	tabs: readonly TabInfo[] = session.tabs,
): Array<Record<string, unknown>> {
	const focus = session.agentFocusTargetId;
	return tabs.map((tab) => ({
		tab_id: String(tab.tabId),
		url: tab.url,
		title: tab.title,
		focused: tab.targetId === focus,
	}));
}

/** Re-reads the target map before a listing. */
export async function freshTabs(session: BrowserSession): Promise<void> {
	await session.sessionManager?.resyncTargets().catch(() => {});
}

interface ObserveOptions {
	readonly includeScreenshot?: boolean;
	/** Cap on the serialized page text. Defaults to the browser layer's own. */
	readonly maxPageChars?: number;
	/** The optional element fields to emit, already resolved. */
	readonly fields?: ReadonlySet<FieldName>;
	/** Bound on the element array; `undefined` defers to the fields' own implied limit. */
	readonly elementLimit?: number;
	/** Admit off-screen but rendered elements, each with `visible: false`. */
	readonly includeHidden?: boolean;
	/** `'all'` (default), `'top'`, or the top document plus the named frame ids. */
	readonly frames?: 'all' | 'top' | readonly string[];
	/** The calling tool's cancellation. */
	readonly signal?: AbortSignal;
}

/** Builds the shared observation from a live session. */
export async function observe(record: SessionRecord, options: ObserveOptions = {}): Promise<Observation> {
	options.signal?.throwIfAborted();
	await freshTabs(record.session);
	const includeScreenshot = options.includeScreenshot ?? false;
	const state = await untilAborted(
		record.session.getBrowserStateSummary({
			includeDom: true,
			includeScreenshot,
			includeOffscreen: options.includeHidden === true,
		}),
		options.signal,
	);
	if (state.stateError !== null && state.stateError !== undefined) {
		throw new ToolError('browser-unavailable', String(state.stateError));
	}
	options.signal?.throwIfAborted();

	const fields = options.fields ?? new Set<FieldName>();
	const scroll = { x: state.pageInfo.scrollX, y: state.pageInfo.scrollY };
	const frameUrls = new Map(state.frames.map((frame) => [frame.frameId, frame.url]));

	// The `frames` lever: the top document is always in; a named frame that the page does not have is
	// reported, not refused, because a frame that was there at the caller's last read and has since
	// gone is the normal case rather than an error.
	const topFrameId = state.frames[0]?.frameId ?? null;
	const wanted = options.frames ?? 'all';
	const framesUnknown: string[] = [];
	let admits: (frameId: string) => boolean = () => true;
	if (wanted === 'top') {
		admits = (frameId) => frameId === topFrameId;
	} else if (wanted !== 'all') {
		const known = new Set(state.frames.map((frame) => frame.frameId));
		for (const id of wanted) if (!known.has(id)) framesUnknown.push(id);
		const named = new Set(wanted);
		admits = (frameId) => frameId === topFrameId || named.has(frameId);
	}

	const table = [...state.domState.selectorMap.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([index, node]) => ({ index, node }))
		.filter((entry) => admits(entry.node.frameId));
	const elementsTotal = table.length;
	const limit = effectiveElementLimit(fields, options.elementLimit);
	const kept = limit === null ? table : keepLastPainted(table, limit);

	// The locator index is one walk over the merged tree; it is built only when a locator field is
	// on, so the five-field record pays nothing for it.
	const wantsLocators = fields.has('locator') || fields.has('locators');
	const locators = wantsLocators ? buildDocumentIndex(state.domState.root?.originalNode ?? null) : null;
	const ctx = { fields, scroll, locators, frameUrls, labelOf };

	const elements: ObservedElement[] = [];
	// At most one element is focused, and `focused_index` is written in the same pass as the array so the two cannot
	// disagree.
	let focusedIndex: number | null = null;
	for (const { index, node } of kept) {
		if (focusedIndex === null && isFocused(node)) focusedIndex = index;
		elements.push(buildElementRecord(index, node, ctx));
	}
	if (fields.has('focused')) {
		for (const element of elements) element.focused = element.index === focusedIndex;
	}

	// The element list alone would leave a model able to click a page but never read it.
	const pageCap = options.maxPageChars ?? MAX_CLICKABLE_ELEMENTS_LENGTH;
	const rendered = renderSimplifiedTree(state.domState.root, {
		derived: defaultDerived,
		pixelsAbove: state.pageInfo.pixelsAbove,
		pixelsBelow: state.pageInfo.pixelsBelow,
	});
	const page = rendered.length > pageCap
		? `${rendered.slice(0, pageCap)}\n[truncated at ${pageCap} characters]`
		: rendered;

	const observation: Observation = {
		sessionId: record.id,
		url: state.url,
		title: state.title,
		humanHasControl: record.lock !== null,
		tabs: tabsOf(record.session, state.tabs),
		viewport: { width: state.pageInfo.viewportWidth, height: state.pageInfo.viewportHeight },
		scroll: {
			x: state.pageInfo.scrollX,
			y: state.pageInfo.scrollY,
			pixelsAbove: state.pageInfo.pixelsAbove,
			pixelsBelow: state.pageInfo.pixelsBelow,
		},
		elements,
		page,
		stateToken: state.stateToken ?? null,
		elementsTotal,
		elementsTruncated: kept.length < elementsTotal,
		focusedIndex,
		frames: state.frames.map((frame) => frameSummaryOf(frame, scroll)),
		framesUnknown,
		captureTruncated: state.captureTruncated,
	};
	if (includeScreenshot && typeof state.screenshot === 'string' && state.screenshot.length > 0) {
		observation.screenshot = state.screenshot;
	}
	// **The unfiltered table, not `kept`.** `focusedIndex` is computed over the caller's `element_limit` and `frames`
	// selection, so a read with `element_limit: 1` almost never contains the focused node — and
	// `browser_wait_for`'s polling loop and `browser_get_frames` both issue exactly that.
	noteFocus(record, state.domState.selectorMap);
	return observation;
}

/** Mints a `focus` record when a state read finds the focus somewhere new. */
function noteFocus(record: SessionRecord, selectorMap: ReadonlyMap<number, EnhancedDomTreeNode>): void {
	let focusedIndex: number | null = null;
	let node: EnhancedDomTreeNode | null = null;
	for (const [index, candidate] of selectorMap) {
		if (!isFocused(candidate)) continue;
		if (focusedIndex !== null && index >= focusedIndex) continue;
		focusedIndex = index;
		node = candidate;
	}
	// The signature is what "the same focus" means: the index alone would mint a record every time an unrelated edit
	// renumbered the table, and the node alone would miss a move between two identical-looking fields.
	const signature = node === null ? 'none' : `${focusedIndex}|${node.frameId ?? ''}|${node.nodeName}`;
	if (record.lastFocus === signature) return;
	const first = record.lastFocus === undefined;
	record.lastFocus = signature;
	// The first read of a session establishes where the focus is; it is not a move, and reporting it as one would
	// make every session begin with an event that did not happen.
	if (first || node === null) return;
	record.events.append(
		'focus',
		focusPayload(focusedIndex, node, node.frameId ?? null, labelOf(node)),
		node.frameId ?? null,
	);
}

/** The five frozen fields of a record, in their frozen key order. */
function minimalOf(element: ObservedElement): ObservedElement {
	const out: ObservedElement = { index: element.index, tag: element.tag };
	if (element.label !== undefined) out.label = element.label;
	if (element.role !== undefined) out.role = element.role;
	if (element.href !== undefined) out.href = element.href;
	return out;
}

/**
 * The wire (snake_case) shape `browser_get_state` returns **in its text block** — the frozen layout, byte for byte.
 */
export function observationPayload(observation: Observation): Record<string, unknown> {
	return {
		session_id: observation.sessionId,
		url: observation.url,
		title: observation.title,
		human_has_control: observation.humanHasControl,
		tabs: observation.tabs,
		viewport: observation.viewport,
		scroll: {
			x: observation.scroll.x,
			y: observation.scroll.y,
			pixels_above: observation.scroll.pixelsAbove,
			pixels_below: observation.scroll.pixelsBelow,
		},
		interactive_elements: observation.elements.map(minimalOf),
		page: observation.page,
	};
}

/** The `structuredContent` half: the frozen payload plus every additional field. */
export function observationStructured(observation: Observation): Record<string, unknown> {
	return {
		...observationPayload(observation),
		interactive_elements: observation.elements,
		state_token: observation.stateToken,
		focused_index: observation.focusedIndex,
		elements_total: observation.elementsTotal,
		elements_truncated: observation.elementsTruncated,
		frames: observation.frames,
		frames_unknown: observation.framesUnknown,
		capture_truncated: observation.captureTruncated,
	};
}

/** The page as a prompt block. */
export function promptBlock(observation: Observation): string {
	const lines = [
		`URL: ${observation.url}`,
		`Title: ${observation.title}`,
		observation.tabs.length > 1 ? `Tabs: ${JSON.stringify(observation.tabs)}` : '',
		`Scroll: ${observation.scroll.pixelsAbove}px above, ${observation.scroll.pixelsBelow}px below the viewport`,
		'',
		'Interactive elements (index: tag [label] -> href):',
		...observation.elements.map((element) =>
			`  ${element.index}: ${element.tag}` +
			(element.label === undefined ? '' : ` [${element.label}]`) +
			(element.href === undefined ? '' : ` -> ${element.href}`)
		),
		'',
		'Page:',
		observation.page,
	];
	return lines.filter((line) => line !== '').join('\n');
}
