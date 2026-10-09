/**
 * The accessibility snapshot's pure half (R11, design §2.8, D-120): raw `Accessibility.AXNode`s in, a bounded,
 * value-free tree and its outline out.
 *
 * **Values never leave, and "the value" is more than the `value` field.** Measured on the recorded captures
 * (`packages/browser/fixtures/dom/{live_value_vs_attribute,react_controlled_inputs,form_attributes}`): Chromium
 * exposes what was typed into a text field three times — as the node's `value`, as a `StaticText` child of the
 * field's inner editor (`textbox › generic › StaticText "live-typed-value"`), and, where the page names the field
 * after its content, inside its `name`. A spin button's number and a date field's segments arrive the same way. So
 * four rules, all applied here and nowhere else:
 *
 * 1. `value` is never read into the output, for any node.
 * 2. A **value-bearing control** — an editable role, a node the AX tree marks `editable`, or a password field
 *    (`isPasswordField`, E-29, decided by the caller from the DOM) — has its `name` and `description` replaced by
 *    `''` when either contains the control's current value (compared here, in-process; the value itself is never
 *    returned), and loses its `valuenow`/`valuetext` properties.
 * 3. Inside a value-bearing control only its **structural** descendants survive (a `<select>`'s popup and options,
 *    a menu): the inner editor, its text runs and every other descendant are dropped with their subtrees, because
 *    they are the control's rendering of its value.
 * 4. Every string that does leave passes the caller's `redact` (`SecretStore.redact`), so a configured secret
 *    typed anywhere on the page reaches no field of the result.
 * 5. Review R2-4: **another node's name is not a way around rule 2.** Chromium computes a control's accessible name
 *    from a field's value through `aria-labelledby` or a wrapping label (measured: `button "typed-Q-VALUE"`,
 *    `checkbox "Send to typed-EM-VALUE"`), and a password field's masked value — `•` per character — through the same
 *    relations, which hands out the password's length. So a first pass collects every value-bearing node's current
 *    value (whitespace-collapsed, never returned), and **any** node's `name` or `description` that contains one is
 *    replaced by `''`; while the page has a password field, so is any that carries a run of masking bullets. A value
 *    of one or two characters blanks only a name that *is* it: containment at that length would blank most of the
 *    tree for a single typed letter and hide nothing (the `SecretStore.redact` floor, for the same reason).
 *
 * Everything here is bounded by the input it is given; the caller bounds the input by `max_nodes`.
 */
import { decodeAxTree, type EnhancedAxNode } from '@tykotech/browser';
import type { CdpResult } from '@tykotech/cdp';

/** One `Accessibility.AXNode` as `getFullAXTree` / `getPartialAXTree` deliver it. */
export type RawAxNode = CdpResult['Accessibility.getFullAXTree']['nodes'][number];

/** `max_nodes` when the caller names none, and its ceiling (design §2.3). */
export const AX_MAX_NODES_DEFAULT = 1000;
export const AX_MAX_NODES_MAX = 5000;

/**
 * Roles whose node carries what a person typed or chose (design §2.8), plus Chromium's own roles for the date and
 * time inputs, whose segments are their value.
 */
export const VALUE_ROLES: ReadonlySet<string> = new Set([
	'textbox',
	'searchbox',
	'combobox',
	'spinbutton',
	'slider',
	'Date',
	'DateTime',
	'InputTime',
]);

/** The descendants a value-bearing control keeps: its choices, never its text (rule 3). */
const STRUCTURAL_IN_CONTROL: ReadonlySet<string> = new Set([
	'MenuListPopup',
	'MenuListOption',
	'listbox',
	'option',
	'group',
	'menu',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'tree',
	'treeitem',
]);

/** Review R2-4: a value shorter than this blanks only a name equal to it; at or above it, any name containing it. */
export const AX_VALUE_CONTAIN_MIN = 3;

/** Review R2-4: a run of the characters Chromium masks a password with (two or more), or a name made only of them. */
const MASK_RUN = /[\u2022\u25CF]{2,}/;
const MASK_ONLY = /^[\u2022\u25CF]+$/;

/** Whitespace collapsed the way an accessible name is computed, so a typed value compares with a name derived from it. */
function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Properties that restate a control's value (rule 2). */
const VALUE_PROPERTIES: ReadonlySet<string> = new Set(['valuenow', 'valuetext']);

/** Containers with nothing to say when unnamed; `interesting_only` hoists their children. */
const QUIET_CONTAINERS: ReadonlySet<string> = new Set(['generic', 'none', 'presentation']);

/** Always redundant with the `StaticText` that owns it, and the bulk of a large tree. */
const TEXT_RUN_ROLES: ReadonlySet<string> = new Set(['InlineTextBox', 'LineBreak']);

/** The properties the outline prints; the full set stays in `properties`. */
const OUTLINE_PROPERTIES: readonly string[] = [
	'checked',
	'selected',
	'expanded',
	'pressed',
	'disabled',
	'invalid',
	'required',
	'focused',
	'level',
	'valuemin',
	'valuemax',
	'valuenow',
];

/** One node of the emitted tree (`AxOut`, design §2.3). */
export interface AxOut {
	role: string;
	name: string;
	description?: string;
	properties: Record<string, string | boolean | null>;
	/** The `browser_get_state` index of the element, when the held table has it. */
	index?: number;
	children: AxOut[];
}

/** What {@linkcode buildAxTree} needs besides the nodes. */
export interface AxTreeOptions {
	/** Skip ignored nodes, unnamed containers and text runs, hoisting their children (default true). */
	readonly interestingOnly: boolean;
	readonly maxNodes: number;
	/** `backendNodeId` → `browser_get_state` index, from the table the session holds. */
	readonly indexByBackendId?: ReadonlyMap<number, number>;
	/** Backend ids of password fields (E-29), decided from the DOM by the caller. */
	readonly passwordBackendIds?: ReadonlySet<number>;
	/** `SecretStore.redact`, or the identity. */
	readonly redact?: (text: string) => string;
}

/** The snapshot: the tree (truncated to `maxNodes` in document order), its size, and the outline. */
export interface AxTree {
	readonly tree: AxOut;
	readonly nodesTotal: number;
	readonly truncated: boolean;
	readonly outline: string;
}

/** A raw `AXValue` as a comparable string, or `''` when it carries none. Never returned. */
function valueText(node: RawAxNode): string {
	const raw = node.value?.value;
	if (typeof raw === 'string') return raw;
	if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
	return '';
}

function hasEditableProperty(node: EnhancedAxNode): boolean {
	const editable = node.properties?.find((property) => property.name === 'editable')?.value;
	return editable !== undefined && editable !== null && editable !== false && editable !== '';
}

/**
 * Builds the bounded, value-free tree from raw AX nodes.
 *
 * The root is the first node whose parent is not in the set (`RootWebArea` for a full tree, the element itself for
 * a partial one). A child id the set does not hold is skipped, and a node is visited once whatever its id list
 * claims, so a malformed or partial tree cannot loop or throw.
 */
export function buildAxTree(nodes: readonly RawAxNode[], options: AxTreeOptions): AxTree {
	const redact = options.redact ?? ((text: string) => text);
	const decoded = decodeAxTree(nodes);
	const raw = new Map(nodes.map((node) => [node.nodeId, node]));
	const root = nodes.find((node) => node.parentId === undefined || !raw.has(node.parentId)) ?? nodes[0];
	const empty: AxOut = { role: 'none', name: '', properties: {}, children: [] };
	if (root === undefined) return { tree: empty, nodesTotal: 0, truncated: false, outline: '' };

	const isPassword = (node: RawAxNode): boolean =>
		node.backendDOMNodeId !== undefined && options.passwordBackendIds?.has(node.backendDOMNodeId) === true;
	const isBearing = (node: RawAxNode, ax: EnhancedAxNode): boolean =>
		VALUE_ROLES.has(ax.role ?? 'none') || isPassword(node) || hasEditableProperty(ax);

	// Rule 5's first pass (review R2-4): every value-bearing node's current value, longest first, and whether the page
	// has a password field. Kept in this scope only; nothing derived from it is returned but a blanked string.
	const typed = new Set<string>();
	let passwordPresent = false;
	for (const node of nodes) {
		const ax = decoded.byAxNodeId.get(node.nodeId);
		if (ax === undefined || !isBearing(node, ax)) continue;
		if (isPassword(node)) passwordPresent = true;
		// A `<select>` (a combobox nobody can type into) holds one of its own options: page-authored text, which its
		// option list would otherwise lose. An editable combobox (`<input list>`) holds what was typed, and counts.
		if (ax.role === 'combobox' && !hasEditableProperty(ax)) continue;
		const current = collapse(valueText(node));
		if (current !== '') typed.add(current);
	}
	const values = [...typed].sort((a, b) => b.length - a.length);
	/** Whether a name or description would hand out a typed value (rule 5). Compared in-process, never returned. */
	const carriesValue = (text: string): boolean => {
		const collapsed = collapse(text);
		if (collapsed === '') return false;
		for (const value of values) {
			if (value.length >= AX_VALUE_CONTAIN_MIN ? collapsed.includes(value) : collapsed === value) return true;
		}
		return passwordPresent && (MASK_RUN.test(collapsed) || MASK_ONLY.test(collapsed));
	};

	const visited = new Set<string>();

	/** The kept forms of one node, its children already built: one node, or its hoisted children. */
	const build = (id: string, insideControl: boolean, parentName: string): AxOut[] => {
		if (visited.has(id)) return [];
		visited.add(id);
		const node = raw.get(id);
		const ax = decoded.byAxNodeId.get(id);
		if (node === undefined || ax === undefined) return [];
		const role = ax.role ?? 'none';
		const backendId = node.backendDOMNodeId;
		const bearing = isBearing(node, ax);

		// Rule 3: inside a control only its structural descendants survive, and a dropped one takes its subtree.
		if (insideControl && !STRUCTURAL_IN_CONTROL.has(role)) return [];

		let name = ax.name ?? '';
		let description = ax.description ?? '';
		const properties: Record<string, string | boolean | null> = {};
		for (const property of ax.properties ?? []) {
			if (bearing && VALUE_PROPERTIES.has(property.name)) continue;
			properties[property.name] = typeof property.value === 'string' ? redact(property.value) : property.value;
		}
		if (bearing) {
			// Rule 2, compared here and dropped here: the value never reaches a variable that is returned.
			const current = valueText(node);
			if (current !== '' && name.includes(current)) name = '';
			if (current !== '' && description.includes(current)) description = '';
		}
		// Rule 5: any node, against every value-bearing node's value (and masking bullets beside a password field).
		if (carriesValue(name)) name = '';
		if (carriesValue(description)) description = '';
		name = redact(name);
		description = redact(description);

		const childIds = ax.childIds ?? [];
		const childContext = insideControl || bearing;
		const quiet = options.interestingOnly && (
			ax.ignored ||
			TEXT_RUN_ROLES.has(role) ||
			(QUIET_CONTAINERS.has(role) && name === '' && description === '') ||
			// A text run that repeats its labelled parent (`button "Save" › StaticText "Save"`) says nothing new.
			(role === 'StaticText' && name !== '' && name === parentName)
		);
		const nextParentName = quiet ? parentName : name;
		const children = childIds.flatMap((childId) => build(childId, childContext, nextParentName));
		if (quiet) return TEXT_RUN_ROLES.has(role) ? [] : children;

		const out: AxOut = { role: redact(role), name, properties, children };
		if (description !== '') out.description = description;
		const index = backendId === undefined ? undefined : options.indexByBackendId?.get(backendId);
		if (index !== undefined) out.index = index;
		return [out];
	};

	const built = build(root.nodeId, false, '');
	// A quiet root hoists its children; they are wrapped so the result keeps one root.
	const full: AxOut = built.length === 1 ? built[0]! : { ...empty, children: built };
	const nodesTotal = count(full);
	const maxNodes = Math.max(1, options.maxNodes);
	const truncated = nodesTotal > maxNodes;
	const tree = truncated ? truncate(full, maxNodes) : full;
	return { tree, nodesTotal, truncated, outline: outlineOf(tree) };
}

/** Nodes in a tree, root included. */
export function count(node: AxOut): number {
	let total = 0;
	const stack: AxOut[] = [node];
	while (stack.length > 0) {
		const next = stack.pop()!;
		total += 1;
		for (const child of next.children) stack.push(child);
	}
	return total;
}

/** The first `limit` nodes in document (pre-)order, as a tree. */
function truncate(node: AxOut, limit: number): AxOut {
	let remaining = limit;
	const copy = (source: AxOut): AxOut | null => {
		if (remaining <= 0) return null;
		remaining -= 1;
		const children: AxOut[] = [];
		for (const child of source.children) {
			const kept = copy(child);
			if (kept === null) break;
			children.push(kept);
		}
		return { ...source, children };
	};
	return copy(node)!;
}

/** One indented line per node: `- role "name" [index] state…`. */
export function outlineOf(tree: AxOut): string {
	const lines: string[] = [];
	const walk = (node: AxOut, depth: number): void => {
		const parts = [`${'  '.repeat(depth)}- ${node.role}`];
		if (node.name !== '') parts.push(JSON.stringify(node.name));
		if (node.index !== undefined) parts.push(`[${node.index}]`);
		for (const key of OUTLINE_PROPERTIES) {
			const value = node.properties[key];
			if (value === undefined || value === null || value === false || value === 'false') continue;
			parts.push(value === true || value === 'true' ? key : `${key}=${value}`);
		}
		lines.push(parts.join(' '));
		for (const child of node.children) walk(child, depth + 1);
	};
	walk(tree, 0);
	return lines.join('\n');
}
