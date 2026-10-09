/**
 * JSON as facts (run model-providers-ui): the Resources viewer's Facts tab and the System MCP panel's capabilities
 * render a JSON value as something a person reads at a glance instead of a pretty-printed blob.
 *
 * - An object's scalar members are rows of a {@linkcode factGroup}; an array of scalars is a row of glyph-less chips.
 * - A nested object is its own group inside a `wa-details`, open through `depth` levels (default 2), closed below.
 * - An array of objects is a `<table class="facts-table">` whose columns are the union of the objects' keys.
 * - At the root, members that belong to no nested group gather in a trailing "Other" group — so a key the caller
 *   did not foresee is shown, never dropped; a root with no nested groups is one group titled "Facts".
 * - `omit` names dotted paths from the root (`events.transports`) that already have a home elsewhere on the screen.
 * - `labels` renames a path (or a bare key) for its group title and row key.
 *
 * Everything is built with `el` and text nodes: a value that looks like markup stays the text it is.
 */
import { el } from './dom.ts';
import { factGroup, type FactRow, tag } from './ui.ts';

export interface JsonFactsOptions {
	/** Dotted key paths from the root to leave out. */
	readonly omit?: string[];
	/** Nested groups are open through this depth (the root's members are depth 1). Default 2. */
	readonly depth?: number;
	/** Words for a path or a bare key, in place of the key itself. */
	readonly labels?: Record<string, string>;
}

type Rec = Record<string, unknown>;

let serial = 0;

function isRecord(value: unknown): value is Rec {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A scalar (or anything that is not a row of its own) as text. */
function textOf(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return '—';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
	return JSON.stringify(value) ?? '—';
}

/** The chips for an array of scalars; an empty array reads as a dash. */
function chips(items: readonly unknown[]): Node | string {
	if (items.length === 0) return '—';
	return el('span', { class: 'fact-chips' }, items.map((item) => tag(textOf(item))));
}

/** A titled table for an array of objects: one column per key seen, in first-seen order. */
function table(title: string, items: readonly Rec[]): HTMLElement {
	const id = `ttk-jf-${++serial}`;
	const columns: string[] = [];
	for (const item of items) for (const key of Object.keys(item)) if (!columns.includes(key)) columns.push(key);
	const head = el('thead', {}, [el('tr', {}, columns.map((key) => el('th', { scope: 'col', text: key })))]);
	const body = el(
		'tbody',
		{},
		items.map((item) => el('tr', {}, columns.map((key) => el('td', { class: 'mono', text: textOf(item[key]) })))),
	);
	return el('section', { class: 'fact-group table', role: 'group', 'aria-labelledby': id }, [
		el('h3', { id, class: 'fact-title', text: title }),
		el('div', { class: 'facts-scroll' }, [el('table', { class: 'facts-table' }, [head, body])]),
	]);
}

interface Walk {
	readonly omit: ReadonlySet<string>;
	readonly open: number;
	readonly labels: Readonly<Record<string, string>>;
}

function labelOf(walk: Walk, path: string, key: string): string {
	return walk.labels[path] ?? walk.labels[key] ?? key;
}

/** Splits an object's members into the rows of its own group and the groups nested under it. */
function members(value: Rec, path: string, depth: number, walk: Walk): { rows: FactRow[]; groups: HTMLElement[] } {
	const rows: FactRow[] = [];
	const groups: HTMLElement[] = [];
	for (const [key, member] of Object.entries(value)) {
		const memberPath = path === '' ? key : `${path}.${key}`;
		if (walk.omit.has(memberPath)) continue;
		const label = labelOf(walk, memberPath, key);
		if (isRecord(member)) groups.push(nested(label, member, memberPath, depth + 1, walk));
		else if (Array.isArray(member) && member.length > 0 && member.every(isRecord)) {
			groups.push(table(label, member as Rec[]));
		} else if (Array.isArray(member)) rows.push({ key: label, value: chips(member) });
		else rows.push({ key: label, value: textOf(member) });
	}
	return { rows, groups };
}

/** A nested object: a collapsible group, open through the configured depth, its own rows first and its children after. */
function nested(title: string, value: Rec, path: string, depth: number, walk: Walk): HTMLElement {
	const { rows, groups } = members(value, path, depth, walk);
	const body = rows.length === 0 && groups.length === 0
		? [factGroup(title, [{ key: 'members', value: 'none' }])]
		: [...(rows.length === 0 ? [] : [factGroup(title, rows)]), ...groups];
	return el('wa-details', {
		class: 'facts-details',
		appearance: 'plain',
		summary: title,
		open: depth <= walk.open,
	}, body);
}

/** A JSON value as fact groups, chips and tables; see the module notes for the shape. */
export function jsonFacts(value: unknown, opts: JsonFactsOptions = {}): HTMLElement {
	const walk: Walk = {
		omit: new Set(opts.omit ?? []),
		open: opts.depth ?? 2,
		labels: opts.labels ?? {},
	};
	const root = isRecord(value) ? value : { value };
	const { rows, groups } = members(root, '', 0, walk);
	const children: HTMLElement[] = [...groups];
	if (rows.length > 0 || groups.length === 0) {
		const title = walk.labels[''] ?? (groups.length === 0 ? 'Facts' : 'Other');
		children.push(factGroup(title, rows.length === 0 ? [{ key: 'members', value: 'none' }] : rows));
	}
	return el('div', { class: 'json-facts' }, children);
}
