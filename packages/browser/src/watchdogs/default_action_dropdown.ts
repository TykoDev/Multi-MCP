/**
 * @module
 * Dropdown inspection and selection — native `<select>` **and** the ARIA/framework path.
 *
 * Contract owner: SPECS/ARCHITECTURE.md §6.10 ("dropdown inspect/select (native select + ARIA/
 * framework paths)"), SPECS/DATA-MODEL.md §5.1.1 (`GetDropdownOptionsEvent` → `Record<string,string>`
 * keyed `shortTermMemory`/`longTermMemory`; `SelectDropdownOptionEvent` → the same shape) and §7.4
 * #19/#20 ("failure returns available options as structured memory, not throw").
 *
 * ## Two mechanisms, because there are two kinds of dropdown
 *
 * A native `<select>` renders its popup as **browser chrome**, not DOM. No synthesized mouse event
 * can open it and no synthesized click can land on an `<option>`, because the option list is not in
 * the page's coordinate space at all — this is why clicking a `<select>` is a `{validationError}`
 * guard rail rather than a click. Selecting therefore means assigning `value`/`selectedIndex` and
 * firing the framework event pair, with the same React value-tracker defeat the typing path uses.
 *
 * An ARIA dropdown (`role="combobox"` + `role="listbox"`, and every framework's flavour of it) is
 * ordinary DOM: its options *are* clickable, and the framework's own handlers are the only thing that
 * commits a selection. So that path expands the control, resolves the option element to a
 * `backendNodeId`, and hands it back for the real click cascade to press.
 */

import type { CdpClient, SessionId } from '@tykotech/cdp';
import { callOnNode, ensureDomEnabled, type NodeHandle, resolveNodeObject } from './default_action_dom.ts';

/** One option, in either flavour of dropdown. */
export interface DropdownOption {
	readonly index: number;
	readonly text: string;
	readonly value: string;
	readonly selected: boolean;
	readonly disabled: boolean;
}

/** Which mechanism a node's dropdown-ness resolves to. */
export type DropdownKind = 'native' | 'aria' | 'none';

export interface DropdownInfo {
	readonly kind: DropdownKind;
	readonly multiple: boolean;
	/** `aria-expanded` when the control has one; `null` for native selects and plain listboxes. */
	readonly expanded: boolean | null;
	readonly options: readonly DropdownOption[];
}

/**
 * Option discovery, shared verbatim by inspect and select so the two can never disagree about what
 * "the options" are.
 *
 * Order of attempts: the control itself when it *is* a listbox/menu → `aria-controls`/`aria-owns` →
 * a `<datalist>` named by `list` → the control's parent → the document, but only for a control that
 * announces a popup (`aria-haspopup`, `role=combobox`). That last step is what finds a listbox a
 * framework portalled to `<body>`; gating it on the popup announcement is what stops it from
 * scraping an unrelated menu elsewhere on the page.
 */
const DISCOVER_SOURCE = `function (element) {
	const doc = element.ownerDocument;
	const selector = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]';
	const query = function (root) {
		if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return [];
		return Array.prototype.slice.call(root.querySelectorAll(selector));
	};
	const role = (element.getAttribute('role') || '').toLowerCase();
	let container = null;
	if (role === 'listbox' || role === 'menu' || role === 'tree') container = element;
	const owns = element.getAttribute('aria-controls') || element.getAttribute('aria-owns');
	if (owns) { const owned = doc.getElementById(owns); if (owned !== null) container = owned; }
	const list = element.getAttribute('list');
	if (list) { const datalist = doc.getElementById(list); if (datalist !== null) container = datalist; }
	if (container !== null && container.tagName.toLowerCase() === 'datalist') {
		return Array.prototype.slice.call(container.options);
	}
	let found = query(container);
	if (found.length === 0) found = query(element);
	if (found.length === 0) found = query(element.parentElement);
	const announcesPopup = role === 'combobox' || element.hasAttribute('aria-haspopup');
	if (found.length === 0 && announcesPopup) found = query(doc);
	return found;
}`;

/** Projects a discovered option element to {@linkcode DropdownOption}. */
const PROJECT_SOURCE = `function (option, index) {
	const label = option.getAttribute === undefined ? null : option.getAttribute('aria-label');
	const text = (label || option.textContent || '').trim();
	const attributeValue = option.getAttribute === undefined ? null : option.getAttribute('data-value');
	return {
		index: index,
		text: text,
		value: attributeValue || (typeof option.value === 'string' ? option.value : text),
		selected: option.getAttribute !== undefined && option.getAttribute('aria-selected') === 'true' || option.selected === true,
		disabled: option.getAttribute !== undefined && option.getAttribute('aria-disabled') === 'true' || option.disabled === true
	};
}`;

const INSPECT_FUNCTION = `function () {
	const element = this;
	const discover = ${DISCOVER_SOURCE};
	const project = ${PROJECT_SOURCE};
	if (element.tagName.toLowerCase() === 'select') {
		return {
			kind: 'native',
			multiple: element.multiple === true,
			expanded: null,
			options: Array.prototype.slice.call(element.options).map(project)
		};
	}
	const options = discover(element).map(project);
	const expanded = element.getAttribute('aria-expanded');
	return {
		kind: options.length > 0 ? 'aria' : 'none',
		multiple: element.getAttribute('aria-multiselectable') === 'true',
		expanded: expanded === null ? null : expanded === 'true',
		options: options
	};
}`;

/** Reads a node's dropdown shape. Returns `kind: 'none'` for anything that is not one. */
export async function inspectDropdown(handle: NodeHandle): Promise<DropdownInfo> {
	await ensureDomEnabled(handle.client, handle.sessionId);
	const info = await callOnNode<Partial<DropdownInfo> | null>(handle, INSPECT_FUNCTION);
	// Normalized rather than trusted: this value crossed a page boundary.
	return {
		kind: info?.kind ?? 'none',
		multiple: info?.multiple ?? false,
		expanded: info?.expanded ?? null,
		options: info?.options ?? [],
	};
}

/** Outcome of a native `<select>` assignment. */
export interface NativeSelectResult {
	readonly selected: boolean;
	readonly value: string | null;
	readonly text: string | null;
	readonly disabled: boolean;
}

/**
 * Matching, in three passes: exact option text → exact `value` → case-insensitive text.
 *
 * §7.4 #20 says the parameter is "exact option text/value", so the exact passes come first and the
 * case-insensitive one only rescues an LLM that lower-cased a label it read off the page.
 */
const SELECT_NATIVE_FUNCTION = `function (wanted) {
	const element = this;
	const target = String(wanted);
	const options = Array.prototype.slice.call(element.options);
	const label = function (option) { return (option.textContent || '').trim(); };
	let match = options.filter(function (option) { return label(option) === target; })[0];
	if (match === undefined) match = options.filter(function (option) { return option.value === target; })[0];
	if (match === undefined) {
		match = options.filter(function (option) { return label(option).toLowerCase() === target.toLowerCase(); })[0];
	}
	if (match === undefined) return { selected: false, value: null, text: null, disabled: false };
	if (match.disabled === true) return { selected: false, value: match.value, text: label(match), disabled: true };

	const previous = element.value;
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
	if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(element, match.value);
	else element.value = match.value;
	if (element.value !== match.value) element.selectedIndex = options.indexOf(match);
	const tracker = element._valueTracker;
	if (tracker !== undefined && tracker !== null && typeof tracker.setValue === 'function') {
		tracker.setValue(previous === match.value ? '' : previous);
	}
	element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
	element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
	return { selected: element.value === match.value, value: match.value, text: label(match), disabled: false };
}`;

/** Selects an option on a native `<select>` and fires the framework event pair. */
export async function selectNativeOption(handle: NodeHandle, text: string): Promise<NativeSelectResult> {
	const result = await callOnNode<NativeSelectResult | null>(handle, SELECT_NATIVE_FUNCTION, [text]);
	return result ?? { selected: false, value: null, text: null, disabled: false };
}

/** Finds the option element matching `text` and hands back its `backendNodeId` for a real click. */
const FIND_ARIA_OPTION_FUNCTION = `function (wanted) {
	const discover = ${DISCOVER_SOURCE};
	const target = String(wanted);
	const options = discover(this);
	const label = function (option) {
		return ((option.getAttribute && option.getAttribute('aria-label')) || option.textContent || '').trim();
	};
	let match = options.filter(function (option) { return label(option) === target; })[0];
	if (match === undefined) {
		match = options.filter(function (option) {
			return (option.getAttribute && option.getAttribute('data-value')) === target;
		})[0];
	}
	if (match === undefined) {
		match = options.filter(function (option) { return label(option).toLowerCase() === target.toLowerCase(); })[0];
	}
	return match === undefined ? null : match;
}`;

/**
 * Resolves the ARIA option matching `text` to a `backendNodeId`, so the caller can press it with the
 * real click cascade rather than a JS `.click()` the framework may not honour.
 *
 * Returns `null` when no option matches — the caller then answers with the available options as
 * structured memory (§7.4 #20), never a throw.
 */
export async function findAriaOptionNode(handle: NodeHandle, text: string): Promise<number | null> {
	const controlObjectId = await resolveNodeObject(handle);
	if (controlObjectId === null) return null;
	const { client, sessionId } = handle;
	let optionObjectId: string | null = null;
	try {
		const outcome = await client.send.Runtime.callFunctionOn({
			functionDeclaration: FIND_ARIA_OPTION_FUNCTION,
			objectId: controlObjectId,
			arguments: [{ value: text }],
			returnByValue: false,
			awaitPromise: true,
			userGesture: true,
		}, sessionId);
		if (outcome.exceptionDetails !== undefined) return null;
		optionObjectId = outcome.result.objectId ?? null;
		if (optionObjectId === null) return null;
		const requested = await client.send.DOM.requestNode({ objectId: optionObjectId }, sessionId);
		const described = await client.send.DOM.describeNode({ nodeId: requested.nodeId }, sessionId);
		return described.node.backendNodeId;
	} catch {
		return null;
	} finally {
		await releaseQuietly(client, sessionId, controlObjectId);
		if (optionObjectId !== null) await releaseQuietly(client, sessionId, optionObjectId);
	}
}

async function releaseQuietly(client: CdpClient, sessionId: SessionId, objectId: string): Promise<void> {
	try {
		await client.send.Runtime.releaseObject({ objectId }, sessionId);
	} catch {
		// The execution context is gone; so is the handle.
	}
}

/** `true` when a control announces a collapsed popup that must be expanded before its options exist. */
export function needsExpansion(info: DropdownInfo): boolean {
	return info.expanded === false;
}

/** Renders options the way the agent's `<read_state>` block shows them (§7.4 #19). */
export function formatOptions(options: readonly DropdownOption[]): string {
	if (options.length === 0) return 'no options found';
	return options
		.map((option) => {
			const marks = [option.selected ? 'selected' : null, option.disabled ? 'disabled' : null].filter(
				(mark) => mark !== null,
			);
			const suffix = marks.length === 0 ? '' : ` (${marks.join(', ')})`;
			return `${option.index}: ${option.text}${suffix}`;
		})
		.join('\n');
}
