/**
 * The Resources screen (D-152): one tree holding everything this credential can reach on the server — the resources
 * and the tools that act on them — beside a viewer that names what is selected and shows it. It absorbed the Library
 * (D-075) and, since D-152, the Tools console: a tool is a leaf of the group it belongs to, so nothing is listed twice.
 *
 * Eight first-level groups, in order, each a word with the count of what has been added to it — sessions, files,
 * skills, prompts, workspaces, agent tasks, surfaces — from `GET /api/v1/overview` (D-155); the Server group holds
 * nothing anyone adds, so it shows no count:
 *
 *   Server    `ttk://capabilities` pinned first, any other resource of the server's own, the resource Templates, and
 *             every tool of no other group
 *   Browser   the browser sessions (one branch per session: state, screenshot, page, files) and the browser tools by
 *             family (Navigation, Interaction, Perception, Session, Files)
 *   Files     the share, listed lazily per folder (`resources_files.ts`), and the `file_*` tools
 *   Skills    `skill_list` and the `skill_*` tools          Prompts   stored and served prompts, the `prompt_*` tools
 *   Sandbox   the coding workspaces and `sandbox_*`          Agents    A2A, model providers, ACP, peers, `agent_*`
 *   Surfaces  the A2UI surfaces and actions, `a2ui_*`        (`resources_agents.ts`)
 *
 * Every group's tools sit in a "Tools" branch, first and folded. Above the tree, a search matches every loaded item by
 * name, URI, tool name and description, and two rows of toggles narrow it: Resources · Tools by kind, and one glyph per
 * group — each toggled on and off on its own, all kept for the page's lifetime (not stored: D-089's storage rule).
 *
 * Reads are live — the server builds a fresh observation per read — so a screenshot here is what the browser shows now.
 * JSON reads as facts by default (`jsonFacts`), raw on the Facts · Raw switch.
 *
 * What is selected is a *key* (`uri:`, `group:`, `folder:`, `file:`, `skill:`, `prompt:`, `template:`, `session:`,
 * `tools:`, `tool:`, `agent:`, `provider:`, `surface:`, `surfaces:`, `workspace:`). The key marks the tree and writes
 * the route (`routeFor`); `routeOf` reads it back. Nothing here refreshes on a timer and no control refreshes a
 * listing: listings re-read on open and after every write, and the viewer's "Read again" is for live resources only
 * (D-092).
 *
 * The group modules import the tree and viewer vocabulary from here, and this screen imports the groups: a cycle of
 * functions and types only — nothing runs at import time — which ES modules resolve.
 */
import type WaTreeItem from '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import { api, type Overview } from './api.ts';
import { clear, el, mount, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { jsonFacts } from './json_facts.ts';
import { onLeave } from './lifecycle.ts';
import { mcp, type McpResource, type McpResourceTemplate, type McpTool, type ResourceContents } from './mcp.ts';
import { clearCommands, type Command, registerCommands } from './palette.ts';
import { agentsGroup, sandboxGroup, surfacesGroup } from './resources_agents.ts';
import { canWrite, dropDrawer, onDrawerClose } from './resources_drawer.ts';
import { domainItems } from './overview_tiles.ts';
import { filesGroup } from './resources_files.ts';
import { promptsGroup } from './resources_prompts.ts';
import { type ResourceGroup, routeOf } from './resources_route.ts';
import { skillsGroup } from './resources_skills.ts';
import { domainOf, gist, humanName, missingTool, toolConsole, type ToolDomain, toolMark } from './resources_tools.ts';
import { named, valueOf } from './schema_form.ts';
import { FAMILY_ORDER, familyOf } from './tool_families.ts';
import { appOnly } from './tool_visibility.ts';
import {
	busy,
	button,
	copyButton,
	empty,
	formatBytes,
	iconButton,
	imageOf,
	jsonView,
	messageOf,
	openModal,
	segmented,
	skeleton,
	tag,
	textView,
	tip,
	toast,
} from './ui.ts';
import { type Navigate, renderShell } from './shell.ts';

const CAPABILITIES_URI = 'ttk://capabilities';

/** A node of the tree that counts and registers palette entries: a first-level group, or a named branch in one. */
export type TreeGroup = ResourceGroup;

/** What the screen gives each group: the write gate, the viewer, the tree marks and counts, the palette. */
export interface GroupContext {
	readonly writable: boolean;
	/** Puts `nodes` in the viewer for the thing `key` names; the tree marks it and the route follows. */
	show(key: string, nodes: Node[]): void;
	/** The viewer's loading state for `key`; the tree marks it at once and the route follows. */
	loading(key: string): void;
	/** Marks the tree and writes the route for `key` without touching the viewer (a drawer closed). */
	settle(key: string): void;
	/** The count beside the group's name; null hides it. */
	count(group: TreeGroup, text: string | null): void;
	/** Replaces the palette entries one group contributes. */
	commands(group: TreeGroup, list: Command[]): void;
	/** Still mounted: a listing that resolves after the screen was left must not paint or register. */
	alive(): boolean;
	/** Moves to another screen (a "Manage" or "Open in" link). */
	navigate(route: string): void;
}

/** A group of the tree that lists itself: its branch, its listing, and how it opens in the viewer. */
export interface Group {
	readonly node: WaTreeItem;
	/** Reads the listing; `again` re-reads it after a write. */
	load(again?: boolean): Promise<void>;
	/** Shows the group in the viewer, or the item `rest` names (a folder path, a skill or prompt name). */
	open(rest?: string): Promise<void>;
	/** Releases what the group drew in the viewer (a rendered surface) when the screen moves on. */
	leave?(): void;
}

/** The eight first-level groups, in order: id, name, glyph, what the group holds (its tooltip and overview line). */
export const DOMAINS: ReadonlyArray<
	{ readonly id: ToolDomain; readonly label: string; readonly glyph: IconName; readonly hint: string }
> = [
	{ id: 'server', label: 'Server', glyph: 'server', hint: 'The server itself: capabilities, templates, its own tools' },
	{ id: 'browser', label: 'Browser', glyph: 'globe', hint: 'Browser sessions and the browser tools' },
	{ id: 'files', label: 'Files', glyph: 'folder', hint: 'The file share · ttk://share' },
	{ id: 'skills', label: 'Skills', glyph: 'skills', hint: 'Skills · ttk://skill' },
	{ id: 'prompts', label: 'Prompts', glyph: 'prompt', hint: 'Stored and served prompts' },
	{ id: 'sandbox', label: 'Sandbox', glyph: 'terminal', hint: 'Coding workspaces' },
	{ id: 'agents', label: 'Agents', glyph: 'agents', hint: 'A2A, model providers, the ACP bridge and peers' },
	{ id: 'surfaces', label: 'Surfaces', glyph: 'surface', hint: 'A2UI surfaces and their actions' },
];

const DOMAIN_IDS = new Set<string>(DOMAINS.map((domain) => domain.id));

function domainLabel(domain: ToolDomain): string {
	return DOMAINS.find((entry) => entry.id === domain)?.label ?? domain;
}

// --- keys and routes (pure) ------------------------------------------------------------------

const encodeSegments = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** The `#/resources/…` remainder a selection key writes; `''` is the bare screen. `routeOf` reads it back. */
export function routeFor(key: string): string {
	const colon = key.indexOf(':');
	const kind = key.slice(0, colon);
	const rest = key.slice(colon + 1);
	switch (kind) {
		case 'uri':
			return encodeURIComponent(rest);
		case 'group':
			return rest === 'overview' ? '' : rest;
		case 'folder':
		case 'file':
			return rest === '' ? 'files' : `files/${encodeSegments(rest)}`;
		case 'skill':
			return `skills/${encodeURIComponent(rest)}`;
		case 'prompt':
			return `prompts/${encodeURIComponent(rest)}`;
		case 'template':
			return 'templates';
		case 'session':
			return `sessions/${encodeURIComponent(rest)}`;
		case 'tools':
			return rest === '' ? 'tools' : `tools/@${rest}`;
		case 'family':
			return 'tools/@browser';
		case 'tool':
			return `tools/${encodeURIComponent(rest)}`;
		case 'agent':
			return `agents/${rest}`;
		case 'provider':
			return `agents/provider/${encodeURIComponent(rest)}`;
		case 'surface':
			return `surfaces/${encodeURIComponent(rest)}`;
		case 'surfaces':
			return 'surfaces/@actions';
		case 'workspace':
			return `sandbox/${encodeURIComponent(rest)}`;
		default:
			return '';
	}
}

/** The tree item a key selects: a file selects its folder, because files are tiles in the viewer, not tree items. */
export function treeKeyOf(key: string): string {
	if (!key.startsWith('file:')) return key;
	const path = key.slice('file:'.length);
	const slash = path.lastIndexOf('/');
	return slash === -1 ? 'group:files' : `folder:${path.slice(0, slash)}`;
}

/** The value of JSON text when it is an object or an array — what the Facts view lays out; `undefined` otherwise. */
export function jsonValueOf(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a tree item's words match a search: every whitespace-separated term of `query` appears in `words`
 * (case-insensitive). An empty query matches everything.
 */
export function matchesQuery(words: string, query: string): boolean {
	const haystack = words.toLowerCase();
	return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

// --- tree and viewer vocabulary (shared with the groups) -------------------------------------

/** A branch of the tree: a glyph, a name and a count (hidden until known); the hint is its tooltip. */
export function treeBranch(key: string, label: string, glyph: IconName, hint: string, mono = false): WaTreeItem {
	const head = el('span', { class: 'rx-branch-head' }, [
		el('span', { class: 'rx-glyph' }, [icon(glyph)]),
		el('span', { class: `rx-name${mono ? ' mono' : ''}`, text: label }),
		el('span', { class: 'rx-branch-count', hidden: true }),
	]);
	tip(head, hint, 'right');
	return el('wa-tree-item', { class: 'rx-branch', 'data-key': key, 'data-search': `${label} ${hint}` }, [head]);
}

/** Shows `text` as a branch's count; null hides it. */
export function setBranchCount(branch: HTMLElement, text: string | null): void {
	const node = branch.querySelector(':scope > .rx-branch-head > .rx-branch-count');
	if (!(node instanceof HTMLElement)) return;
	node.textContent = text ?? '';
	node.hidden = text === null;
}

/** A leaf of the tree; `locked` names why it is read-only and draws the lock mark beside it. */
export function treeLeaf(
	key: string,
	label: string,
	glyph: IconName,
	hint: string,
	options: { mono?: boolean; locked?: string; mark?: HTMLElement | null; search?: string } = {},
): WaTreeItem {
	const node = el('wa-tree-item', {
		class: 'rx-leaf',
		'data-key': key,
		'data-search': `${label} ${hint} ${options.search ?? ''}`,
	}, [
		el('span', { class: 'rx-glyph' }, [icon(glyph)]),
		el('span', { class: `rx-name${options.mono === true ? ' mono' : ''}`, text: label }),
		...(options.mark === undefined || options.mark === null ? [] : [options.mark]),
		...(options.locked === undefined ? [] : [
			el('span', { class: 'rx-lock', role: 'img', 'aria-label': options.locked, 'data-tip': options.locked }, [
				icon('lock'),
			]),
		]),
	]);
	return tip(node, hint, 'right');
}

export interface ViewerHead {
	readonly glyph: IconName;
	/** What the glyph means: the tile's accessible name and tooltip (a content type, "Folder", "Skills"). */
	readonly kind: string;
	readonly title: string;
	/** The title is data (a URI, a path): mono. Default true. */
	readonly mono?: boolean;
	readonly tags?: Node[];
	readonly actions?: Node[];
}

/** The viewer's header: it always names the thing — a glyph tile, the title, its tags, and the actions on it. */
export function viewerHead(head: ViewerHead): HTMLElement {
	return el('header', { class: 'rx-head' }, [
		el('div', { class: 'rx-tile', role: 'img', 'aria-label': head.kind, 'data-tip': head.kind }, [icon(head.glyph)]),
		el('div', { class: 'rx-head-text' }, [
			el('h2', { class: `rx-uri${head.mono === false ? '' : ' mono'}`, text: head.title }),
			el('div', { class: 'rx-meta' }, head.tags ?? []),
		]),
		el('div', { class: 'rx-head-actions' }, head.actions ?? []),
	]);
}

// --- resources --------------------------------------------------------------------------

/** A glyph for what a resource holds, from its MIME type and, failing that, its URI. */
function glyphFor(resource: { uri: string; mimeType?: string }): IconName {
	const mime = resource.mimeType ?? '';
	const uri = resource.uri;
	if (mime.startsWith('image/') || uri.endsWith('/screenshot')) return 'file-image';
	if (mime.startsWith('audio/')) return 'file-audio';
	if (mime.startsWith('video/')) return 'file-video';
	if (/zip|tar|gzip|compressed|archive/.test(mime)) return 'file-archive';
	if (mime.includes('json') || uri.endsWith('/state') || uri === CAPABILITIES_URI) return 'file-json';
	if (/javascript|typescript|python|x-sh|xml|css/.test(mime)) return 'file-code';
	if (mime.startsWith('text/') || uri.endsWith('/page')) return 'file-text';
	return 'file';
}

/** The session a `ttk://session/{id}/…` URI belongs to, or `null`. */
function sessionOf(uri: string): string | null {
	const match = /^ttk:\/\/session\/([^/]+)\//.exec(uri);
	return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

/** The authority of a `ttk://` URI (`share`, `skill`…), else its scheme; the roots two groups list themselves. */
function rootOf(uri: string): string {
	const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?/i.exec(uri);
	if (match === null) return 'other';
	const scheme = (match[1] ?? '').toLowerCase();
	return scheme === 'ttk' ? match[2] ?? 'other' : `${scheme}:`;
}

/** The short name of a resource: its title or name, else the last segment of its URI. */
function leafName(resource: McpResource): string {
	const last = resource.uri.replace(/\/+$/, '').split('/').pop() ?? resource.uri;
	let decoded = last;
	try {
		decoded = decodeURIComponent(last);
	} catch {
		// Not percent-encoded text: shown as it is.
	}
	return resource.title ?? resource.name ?? decoded;
}

/** The size of base64 content once decoded. */
function decodedBytes(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** A JSON value as facts, or raw on the switch: `role=tablist`, Facts selected by default. */
function jsonSwitch(value: unknown): HTMLElement {
	const body = el('div', { class: 'rx-json-body' });
	const paint = (mode: string): void => {
		clear(body);
		body.append(mode === 'raw' ? jsonView(value) : jsonFacts(value));
	};
	const toggle = segmented([{ id: 'facts', label: 'Facts' }, { id: 'raw', label: 'Raw' }], 'facts', paint);
	toggle.node.setAttribute('aria-label', 'JSON view');
	paint('facts');
	return el('div', { class: 'rx-json' }, [el('div', { class: 'rx-json-tools' }, [toggle.node]), body]);
}

/** Renders the contents of one `resources/read` with a viewer for its type: facts or raw JSON, text, image, download. */
function renderContents(contents: ResourceContents[]): Node[] {
	return contents.map((item) => {
		if (item.text !== undefined) {
			const value = jsonValueOf(item.text);
			return value === undefined ? textView(item.text) : jsonSwitch(value);
		}
		if (item.blob !== undefined && item.mimeType?.startsWith('image/')) {
			const blob = item.blob;
			const mimeType = item.mimeType;
			const frame = el('button', { type: 'button', class: 'rx-image', 'aria-label': 'Enlarge image' }, [
				imageOf(blob, mimeType, item.uri),
			]);
			on(frame, 'click', () => openModal(item.uri, [imageOf(blob, mimeType, item.uri)], true));
			return frame;
		}
		if (item.blob !== undefined) {
			const blob = item.blob;
			const mimeType = item.mimeType ?? 'binary';
			const save = button({ label: 'Download', icon: 'download', small: true, variant: 'primary' });
			tip(save, `Download (${mimeType})`, 'top');
			on(save, 'click', () => {
				const link = el('a', {
					href: `data:${item.mimeType ?? 'application/octet-stream'};base64,${blob}`,
					download: item.uri.split('/').pop() ?? 'resource',
				});
				document.body.append(link);
				link.click();
				link.remove();
			});
			return el('div', { class: 'rx-binary' }, [
				el('span', { class: 'rx-binary-glyph' }, [icon(glyphFor({ uri: item.uri, mimeType: item.mimeType }))]),
				el('div', { class: 'rx-binary-text' }, [
					el('code', { class: 'mono', text: mimeType }),
					el('span', { class: 'muted', text: formatBytes(decodedBytes(blob)) }),
				]),
				save,
			]);
		}
		return el('div', { class: 'rx-none' }, [icon('circle-dashed'), el('span', { text: 'Empty resource' })]);
	});
}

/**
 * Reads `uri` live and hands `paint` what to show: a skeleton first, then the header (URI, type, read time) and the
 * typed body, or a failure callout. "Read again" reads it once more through the same `paint`.
 */
async function readResource(uri: string, paint: (nodes: Node[]) => void): Promise<void> {
	paint([skeleton(4)]);
	const reread = iconButton('refresh', 'Read again');
	on(reread, 'click', () => void busy(reread, () => readResource(uri, paint)));
	const started = performance.now();
	try {
		const contents = await mcp.read(uri);
		const ms = Math.round(performance.now() - started);
		const mimeType = contents[0]?.mimeType;
		paint([
			viewerHead({
				glyph: glyphFor({ uri, mimeType }),
				kind: mimeType ?? 'unknown type',
				title: uri,
				tags: [
					tip(tag(mimeType ?? 'unknown', 'tag'), 'Content type'),
					tip(tag(`${ms} ms`, 'timer'), 'Read time'),
					...(contents.length > 1 ? [tip(tag(String(contents.length), 'rows'), 'Parts')] : []),
				],
				actions: [copyButton(() => uri, 'Copy URI'), reread],
			}),
			el('div', { class: 'rx-body' }, renderContents(contents)),
		]);
	} catch (cause) {
		const glyph = icon('alert');
		glyph.setAttribute('slot', 'icon');
		paint([
			el('wa-callout', { class: 'rx-failure', variant: 'danger' }, [glyph, el('span', { text: messageOf(cause) })]),
		]);
	}
}

// --- filters (kept for the page's lifetime; never stored) --------------------------------------

/** Which first-level groups are shown; each is toggled on its own. */
const shownGroups = new Set<ToolDomain>(DOMAINS.map((domain) => domain.id));
/** Which kinds of entry are shown: the resources (data) and the tools. */
const shownKinds = { data: true, tools: true };

// --- the screen -------------------------------------------------------------------------

export function resourcesView(navigate: Navigate, initial?: string): void {
	const writable = canWrite();
	let alive = true;
	let currentKey: string | null = null;
	/** D-155: the overview route's counts — what has been added to each group; `null` until read, or when it fails. */
	let stored: Overview | null = null;
	const commandSets = new Map<TreeGroup, Command[]>();
	const groupNodes = new Map<ToolDomain, WaTreeItem>();
	const subNodes = new Map<TreeGroup, WaTreeItem>();
	// `single`: a click on a name selects it, branch or leaf, and only the chevron folds a branch; this handler opens
	// what the name names and unfolds it, so a folder or a group never collapses under the click that chose it.
	const tree = el('wa-tree', { class: 'rx-tree', id: 'rx-tree', selection: 'single', 'aria-label': 'Resources' });
	const viewer = el('section', { class: 'rx-preview rx-viewer', 'aria-label': 'Viewer' });

	// Below 768 px the tree folds behind this bar, which names the group in view; the viewer takes the screen.
	const browseLabel = el('span', { class: 'label', text: 'Browse' });
	const browse = el('button', {
		type: 'button',
		class: 'ttk-btn wa-neutral wa-filled wa-outlined rx-browse',
		'aria-expanded': 'false',
		'aria-controls': 'rx-pane-body',
	}, [icon('list'), browseLabel, icon('chevron-down', 'rx-browse-caret')]);

	// --- search and filters ---
	const searchGlyph = icon('search');
	searchGlyph.setAttribute('slot', 'start');
	const searchCount = el('span', { class: 'rx-search-count', slot: 'end' });
	const search = named(
		el('wa-input', {
			type: 'search',
			class: 'rx-search',
			placeholder: 'Search resources and tools',
			'with-clear': true,
			size: 's',
		}, [searchGlyph, searchCount]),
		'Search resources and tools',
		false,
	);
	/** One pressable toggle: a glyph, optionally a word, a count badge; `aria-pressed` is its state. */
	function toggleChip(glyph: IconName, label: string, worded: boolean, pressed: () => boolean, flip: () => void): {
		node: HTMLButtonElement;
		paint(count: number): void;
	} {
		const count = el('span', { class: 'rx-chip-count', 'aria-hidden': 'true' });
		const node = el('button', {
			type: 'button',
			class: worded ? 'rx-toggle worded' : 'rx-toggle',
			'aria-label': label,
			'data-tip': worded ? undefined : label,
			'data-tip-placement': 'bottom',
		}, [icon(glyph), ...(worded ? [el('span', { class: 'rx-toggle-label', text: label })] : []), count]);
		on(node, 'click', () => {
			flip();
			applyFilters();
		});
		return {
			node,
			paint(n: number) {
				node.setAttribute('aria-pressed', String(pressed()));
				count.textContent = n > 999 ? '999+' : String(n);
				node.classList.toggle('empty', n === 0);
				// D-155: a toggle counts the tree entries it hides (resources, placeholders and tools alike), not stored items.
				const words = `${label} · ${n} ${n === 1 ? 'entry' : 'entries'} · ${pressed() ? 'shown' : 'hidden'}`;
				node.setAttribute('aria-label', words);
				if (!worded) node.setAttribute('data-tip', words);
			},
		};
	}
	const kindToggles = {
		data: toggleChip('resources', 'Resources', true, () => shownKinds.data, () => {
			shownKinds.data = !shownKinds.data;
		}),
		tools: toggleChip('tools', 'Tools', true, () => shownKinds.tools, () => {
			shownKinds.tools = !shownKinds.tools;
		}),
	};
	const groupToggles = new Map(
		DOMAINS.map((domain) => [
			domain.id,
			toggleChip(domain.glyph, domain.label, false, () => shownGroups.has(domain.id), () => {
				if (shownGroups.has(domain.id)) shownGroups.delete(domain.id);
				else shownGroups.add(domain.id);
			}),
		]),
	);
	const resetFilters = iconButton('funnel-x', 'Show everything', () => {
		for (const domain of DOMAINS) shownGroups.add(domain.id);
		shownKinds.data = true;
		shownKinds.tools = true;
		search.value = '';
		applyFilters();
	}, { small: true });
	const filters = el('div', { class: 'rx-filters', role: 'group', 'aria-label': 'Filters' }, [
		el('div', { class: 'rx-kinds' }, [
			kindToggles.data.node,
			kindToggles.tools.node,
			el('span', { class: 'grow' }),
			resetFilters,
		]),
		el(
			'div',
			{ class: 'rx-group-toggles', role: 'group', 'aria-label': 'Groups' },
			[...groupToggles.values()].map((entry) => entry.node),
		),
	]);

	const paneBody = el('div', { class: 'rx-pane-body', id: 'rx-pane-body' }, [search, filters, tree]);
	const pane = el('aside', { class: 'rx-pane', 'aria-label': 'Resources tree' }, [browse, paneBody]);
	const foldTree = (open: boolean): void => {
		pane.classList.toggle('open', open);
		browse.setAttribute('aria-expanded', String(open));
	};
	on(browse, 'click', () => foldTree(!pane.classList.contains('open')));

	/** The tree items directly under `item`. */
	const childrenOf = (item: Element): WaTreeItem[] =>
		Array.from(item.querySelectorAll<WaTreeItem>(':scope > wa-tree-item'));

	/** Hides or shows one item; a hidden item is also disabled, so arrow keys never land on it. */
	function setShown(item: WaTreeItem, shown: boolean): void {
		item.hidden = !shown;
		item.disabled = !shown;
	}

	/**
	 * Applies the query to `item` and its subtree; returns whether it stays visible. A branch whose own words match
	 * shows its whole subtree; a branch with a matching descendant unfolds to show it.
	 */
	function filterItem(item: WaTreeItem, query: string, counts: { shown: number; total: number }): boolean {
		const kids = childrenOf(item);
		const selfMatch = query === '' || matchesQuery(item.getAttribute('data-search') ?? '', query);
		if (kids.length === 0) {
			counts.total += 1;
			if (selfMatch) counts.shown += 1;
			setShown(item, selfMatch);
			return selfMatch;
		}
		let any = false;
		for (const kid of kids) if (filterItem(kid, selfMatch && query !== '' ? '' : query, counts)) any = true;
		const visible = query === '' || selfMatch || any;
		if (query !== '' && any && !item.expanded) item.expanded = true;
		setShown(item, visible);
		return visible;
	}

	/** Counts the leaves under `item` without changing anything. */
	function leavesUnder(item: Element, tools: boolean | null): number {
		let n = 0;
		for (const kid of childrenOf(item)) {
			const isTools = kid.classList.contains('rx-tools');
			if (tools !== null && isTools !== tools) continue;
			n += childrenOf(kid).length === 0 ? 1 : leavesUnder(kid, null);
		}
		return n;
	}

	/** Applies the search and every toggle to the tree, and repaints the toggles' counts and states. */
	function applyFilters(): void {
		const query = valueOf(search).trim();
		const counts = { shown: 0, total: 0 };
		let dataTotal = 0;
		let toolTotal = 0;
		for (const [domain, node] of groupNodes) {
			const groupOn = shownGroups.has(domain);
			const data = leavesUnder(node, false);
			const tools = leavesUnder(node, true);
			dataTotal += data;
			toolTotal += tools;
			groupToggles.get(domain)?.paint(data + tools);
			// D-155: the group's count is what has been added to it, as the Resources overview's card says — not its tree
			// leaves, which include the server's own resources, templates and placeholder rows.
			const count = node.querySelector(':scope > .rx-branch-head > .rx-group-count');
			const items = domainItems(domain, stored);
			// Written only when it changes: the observer that calls this watches the tree, text included.
			if (count !== null && count.textContent !== (items?.count ?? '')) {
				count.textContent = items?.count ?? '';
				if (items === null) count.removeAttribute('data-tip');
				else count.setAttribute('data-tip', items.text);
			}
			let any = false;
			const selfMatch = query === '' || matchesQuery(node.getAttribute('data-search') ?? '', query);
			for (const kid of childrenOf(node)) {
				const kindOn = kid.classList.contains('rx-tools') ? shownKinds.tools : shownKinds.data;
				if (!groupOn || !kindOn) {
					setShown(kid, false);
					continue;
				}
				if (filterItem(kid, selfMatch && query !== '' ? '' : query, counts)) any = true;
			}
			// A group still listing itself shows while nothing filters it, so its spinner says it is coming.
			const listing = childrenOf(node).length === 0 && query === '';
			const visible = groupOn && (any || listing || (query !== '' && selfMatch && shownKinds.data));
			if (query !== '' && any && !node.expanded) node.expanded = true;
			setShown(node, visible);
		}
		kindToggles.data.paint(dataTotal);
		kindToggles.tools.paint(toolTotal);
		const filtered = query !== '' || shownGroups.size < DOMAINS.length || !shownKinds.data || !shownKinds.tools;
		resetFilters.hidden = !filtered;
		searchCount.textContent = filtered ? `${counts.shown}/${dataTotal + toolTotal}` : String(dataTotal + toolTotal);
		searchCount.setAttribute(
			'data-tip',
			filtered ? `${counts.shown} of ${dataTotal + toolTotal} entries shown` : `${dataTotal + toolTotal} entries`,
		);
		tree.classList.toggle('filtered', filtered);
	}

	// Any listing that adds or removes items re-applies the filters once per frame.
	let filterFrame = 0;
	const scheduleFilters = (): void => {
		if (filterFrame !== 0) return;
		filterFrame = requestAnimationFrame(() => {
			filterFrame = 0;
			if (alive) applyFilters();
		});
	};
	// D-155: what was added to each group, from the overview route; re-read a moment after the tree's items change (a
	// listing re-read after a write), so the counts follow. Only tree items count as a change: the counts' own text
	// changes would otherwise re-trigger the read.
	const loadStored = async (): Promise<void> => {
		try {
			const next = await api.overview();
			if (!alive) return;
			stored = next;
			scheduleFilters();
		} catch {
			// An older server or a transient failure: the counts stay as they were, or hidden.
		}
	};
	let storedTimer = 0;
	const observer = new MutationObserver((records) => {
		scheduleFilters();
		const itemsChanged = records.some((record) =>
			[...record.addedNodes, ...record.removedNodes].some((node) =>
				node instanceof Element && node.tagName === 'WA-TREE-ITEM'
			)
		);
		if (!itemsChanged) return;
		clearTimeout(storedTimer);
		storedTimer = setTimeout(() => void loadStored(), 1500);
	});
	observer.observe(tree, { childList: true, subtree: true });
	let searchTimer = 0;
	on(search, 'input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(applyFilters, 120);
	});
	search.addEventListener('wa-clear', () => applyFilters());
	on(search, 'keydown', (event) => {
		if (event.key === 'Escape' && valueOf(search) !== '') {
			search.value = '';
			applyFilters();
		} else if (event.key === 'Enter') {
			// Enter opens the first visible leaf: search, then go.
			const first = Array.from(tree.querySelectorAll<WaTreeItem>('wa-tree-item')).find((item) =>
				!item.hidden && childrenOf(item).length === 0 && item.closest('wa-tree-item[hidden]') === null
			);
			const key = first?.getAttribute('data-key');
			if (key !== undefined && key !== null) openKey(key);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			tree.querySelector<WaTreeItem>('wa-tree-item:not([hidden])')?.focus();
		}
	});

	/** Marks the tree item for `key` selected, opens the branches above it, and names its group in the browse bar. */
	function mark(key: string): void {
		const target = treeKeyOf(key);
		let hit: WaTreeItem | null = null;
		for (const item of Array.from(tree.querySelectorAll('wa-tree-item'))) {
			const same = item.getAttribute('data-key') === target;
			item.selected = same;
			if (same) hit = item;
		}
		for (
			let parent = hit?.parentElement?.closest('wa-tree-item');
			parent;
			parent = parent.parentElement?.closest('wa-tree-item')
		) {
			parent.expanded = true;
		}
		const group = hit?.closest('.rx-tree > wa-tree-item');
		const name = group?.querySelector(':scope > .rx-branch-head > .rx-name')?.textContent ?? '';
		browseLabel.textContent = name === '' ? 'Browse' : name;
		if (hit !== null && hit.hidden) {
			// A selection the filters hid (a deep link, the palette) is shown: its group and kind come back on.
			const domain = group?.getAttribute('data-key')?.slice('group:'.length) ?? '';
			if (DOMAIN_IDS.has(domain)) shownGroups.add(domain as ToolDomain);
			if (hit.closest('.rx-tools') !== null) shownKinds.tools = true;
			else shownKinds.data = true;
			search.value = '';
			applyFilters();
		}
	}

	function setRoute(key: string): void {
		const rest = routeFor(key);
		globalThis.history.replaceState(null, '', rest === '' ? '#/resources' : `#/resources/${rest}`);
	}

	/** The group whose viewer content is on screen and may hold something to release. */
	let leaving: (() => void) | null = null;
	const ctx: GroupContext = {
		writable,
		show(key, nodes) {
			if (!alive) return;
			currentKey = key;
			mark(key);
			setRoute(key);
			viewer.replaceChildren(...nodes);
			viewer.scrollTop = 0;
		},
		loading(key) {
			if (!alive) return;
			currentKey = key;
			mark(key);
			setRoute(key);
			viewer.replaceChildren(skeleton(4));
		},
		settle(key) {
			if (!alive) return;
			currentKey = key;
			mark(key);
			setRoute(key);
		},
		count(group, text) {
			const node = (DOMAIN_IDS.has(group) ? groupNodes.get(group as ToolDomain) : undefined) ?? subNodes.get(group);
			if (node !== undefined) setBranchCount(node, text);
		},
		commands(group, list) {
			if (!alive) return;
			commandSets.set(group, list);
			registerCommands('resources', [...commandSets.values()].flat());
		},
		alive: () => alive,
		navigate,
	};

	// --- the eight groups, in order ---
	const server = treeBranch('group:server', 'Server', 'server', DOMAINS[0]!.hint);
	const browser = treeBranch('group:browser', 'Browser', 'globe', DOMAINS[1]!.hint);
	const sessions = treeBranch('group:sessions', 'Sessions', 'sessions', 'Browser sessions: state, screenshot, page');
	const templates = treeBranch(
		'group:templates',
		'Templates',
		'template',
		'Resource templates: fill in the variables, then read',
	);
	browser.append(sessions);
	const files = filesGroup(ctx);
	const skills = skillsGroup(ctx);
	const prompts = promptsGroup(ctx);
	const sandbox = sandboxGroup(ctx);
	const agents = agentsGroup(ctx);
	const surfaces = surfacesGroup(ctx);
	const nodes: ReadonlyArray<readonly [ToolDomain, WaTreeItem]> = [
		['server', server],
		['browser', browser],
		['files', files.node],
		['skills', skills.node],
		['prompts', prompts.node],
		['sandbox', sandbox.node],
		['agents', agents.node],
		['surfaces', surfaces.node],
	];
	for (const [domain, node] of nodes) {
		node.classList.add('rx-group');
		node.setAttribute('data-domain', domain);
		// The group's one count — its resources and its tools — is the screen's (`applyFilters`); a group module's own
		// count (a folder's entries) stays on the branch for the modules, hidden by the stylesheet. No `loading` here:
		// the kit unfolds an item whenever its spinner stops, and the groups start folded.
		node.querySelector(':scope > .rx-branch-head')?.append(el('span', { class: 'rx-group-count' }));
		groupNodes.set(domain, node);
		tree.append(node);
	}
	subNodes.set('sessions', sessions);
	subNodes.set('templates', templates);

	// --- tools: one folded "Tools" branch first in each group --------------------------------
	let tools: McpTool[] = [];
	let toolsError: string | null = null;
	const toolsReady = (async () => {
		try {
			// R9 (D-134): a tool marked for an MCP Apps embed only is not this console's to offer. Re-read, so a
			// credential that just gained a scope sees its tools.
			tools = [...await mcp.tools(true)].filter((tool) => !appOnly(tool)).sort((a, b) => {
				const fa = FAMILY_ORDER.indexOf(familyOf(a.name)[0]);
				const fb = FAMILY_ORDER.indexOf(familyOf(b.name)[0]);
				return fa === fb ? a.name.localeCompare(b.name) : fa - fb;
			});
		} catch (cause) {
			toolsError = messageOf(cause);
			return;
		}
		if (!alive) return;
		for (const [domain, node] of groupNodes) {
			const mine = tools.filter((tool) => domainOf(tool.name) === domain);
			if (mine.length === 0) continue;
			const branch = treeBranch(
				`tools:${domain}`,
				'Tools',
				'tools',
				`${mine.length} ${domainLabel(domain)} tool${mine.length === 1 ? '' : 's'}`,
			);
			branch.classList.add('rx-tools');
			setBranchCount(branch, String(mine.length));
			const leaf = (tool: McpTool): WaTreeItem => {
				const item = treeLeaf(
					`tool:${tool.name}`,
					humanName(tool),
					familyOf(tool.name)[1],
					tool.description === undefined ? tool.name : `${tool.name} · ${gist(tool.description)}`,
					{ mark: toolMark(tool), search: `${tool.name} ${tool.description ?? ''}` },
				);
				item.classList.add('rx-tool');
				return item;
			};
			if (domain === 'browser') {
				// The browser's tools keep their families as branches: they order the browser workflow.
				const families = new Map<string, McpTool[]>();
				for (const tool of mine) {
					const [family] = familyOf(tool.name);
					families.set(family, [...(families.get(family) ?? []), tool]);
				}
				for (const [family, members] of families) {
					const sub = treeBranch(`family:${family}`, family, familyOf(members[0]!.name)[1], `${family} tools`);
					setBranchCount(sub, String(members.length));
					sub.append(...members.map(leaf));
					branch.append(sub);
				}
			} else branch.append(...mine.map(leaf));
			node.prepend(branch);
		}
		ctx.commands(
			'tools',
			tools.map((tool) => ({
				id: `tool:${tool.name}`,
				label: humanName(tool),
				icon: familyOf(tool.name)[1],
				hint: tool.name,
				keywords: `tool ${domainLabel(domainOf(tool.name))} ${familyOf(tool.name)[0]}`,
				group: 'Tools',
				run: () => showTool(tool.name),
			})),
		);
	})();

	/** A tool as a card in an overview: glyph, title, name, gist and its mark; a click opens its console. */
	function toolCard(tool: McpTool): HTMLElement {
		const card = el('button', { type: 'button', class: 'rx-card rx-tool-card' }, [
			el('span', { class: 'rx-card-glyph', 'aria-hidden': 'true' }, [icon(familyOf(tool.name)[1])]),
			el('div', { class: 'rx-card-text' }, [
				el('span', { class: 'rx-card-title' }, [
					el('span', { text: humanName(tool) }),
					...(toolMark(tool) === null ? [] : [toolMark(tool)!]),
				]),
				el('code', { class: 'rx-card-id mono', text: tool.name }),
				el('span', { class: 'rx-card-hint', text: tool.description === undefined ? '' : gist(tool.description) }),
			]),
		]);
		on(card, 'click', () => showTool(tool.name));
		return card;
	}

	/** Tools grouped under headings (browser families, or groups), as card grids. */
	function toolSections(list: McpTool[], by: 'family' | 'domain'): HTMLElement[] {
		const sections = new Map<string, McpTool[]>();
		for (const tool of list) {
			const key = by === 'family' ? familyOf(tool.name)[0] : domainLabel(domainOf(tool.name));
			sections.set(key, [...(sections.get(key) ?? []), tool]);
		}
		return [...sections].map(([heading, members]) =>
			el('section', { class: 'rx-section' }, [
				el('div', { class: 'rx-section-head' }, [
					el('h3', { class: 'rx-section-title', text: heading }),
					el('span', { class: 'rx-section-count', text: String(members.length) }),
				]),
				el('div', { class: 'rx-cards' }, members.map(toolCard)),
			])
		);
	}

	async function showTools(domain?: ToolDomain): Promise<void> {
		const key = domain === undefined ? 'group:tools' : `tools:${domain}`;
		ctx.loading(key);
		await toolsReady;
		if (!alive) return;
		const list = domain === undefined ? tools : tools.filter((tool) => domainOf(tool.name) === domain);
		ctx.show(key, [
			viewerHead({
				glyph: 'tools',
				kind: 'Tools',
				title: domain === undefined ? 'All tools' : `${domainLabel(domain)} tools`,
				mono: false,
				tags: [tip(tag(String(list.length)), 'Tools served to this credential')],
			}),
			el(
				'div',
				{ class: 'rx-body' },
				toolsError !== null
					? [empty('lock', 'Tools unavailable', `${toolsError} — calling tools needs the mcp:invoke scope.`)]
					: list.length === 0
					? [empty('tools', 'No tools here')]
					: toolSections(list, domain === undefined ? 'domain' : domain === 'browser' ? 'family' : 'domain'),
			),
		]);
	}

	async function showTool(name: string): Promise<void> {
		const key = `tool:${name}`;
		if (tools.length === 0 && toolsError === null) ctx.loading(key);
		await toolsReady;
		if (!alive) return;
		const tool = tools.find((candidate) => candidate.name === name);
		ctx.show(key, [
			tool === undefined
				? (toolsError === null ? missingTool(name) : empty('lock', 'Tools unavailable', toolsError))
				: toolConsole(tool, navigate, domainLabel(domainOf(tool.name))),
		]);
	}

	// --- Server and Browser › Sessions: resources/list ---
	let own: McpResource[] = [];
	let bySession = new Map<string, McpResource[]>();
	let resourceError: string | null = null;
	const sessionHints = el('datalist', { id: 'resource-sessions' });
	// Suggestions for every `session_id` field of a tool form (`schema_form.ts`).
	const sessionIds = el('datalist', { id: 'session-ids' });
	const kindHints = el(
		'datalist',
		{ id: 'resource-kinds' },
		['state', 'screenshot', 'page'].map((kind) => el('option', { value: kind })),
	);

	function openResource(uri: string): void {
		const key = `uri:${uri}`;
		ctx.loading(key);
		void readResource(uri, (nodes) => {
			if (alive && currentKey === key) viewer.replaceChildren(...nodes);
		});
	}

	function resourceLeaf(resource: McpResource): WaTreeItem {
		const node = treeLeaf(
			`uri:${resource.uri}`,
			leafName(resource),
			glyphFor(resource),
			resource.description === undefined ? resource.uri : `${resource.uri} · ${resource.description}`,
		);
		node.setAttribute('data-uri', resource.uri);
		return node;
	}

	function resourceCommand(resource: McpResource, group: string): Command {
		return {
			id: `resource:${resource.uri}`,
			label: leafName(resource),
			icon: glyphFor(resource),
			hint: resource.uri,
			group,
			run: () => openResource(resource.uri),
		};
	}

	/** The resources of a list as rows that open them. */
	function resourceRows(list: McpResource[]): HTMLElement {
		return el(
			'div',
			{ class: 'rx-rows', role: 'list' },
			list.map((resource) => {
				const row = el('button', { type: 'button', class: 'rx-row', role: 'listitem' }, [
					el('span', { class: 'rx-glyph' }, [icon(glyphFor(resource))]),
					el('span', { class: 'rx-row-name', text: leafName(resource) }),
					el('code', { class: 'rx-row-uri mono', text: resource.uri }),
				]);
				if (resource.description !== undefined) tip(row, resource.description, 'top');
				on(row, 'click', () => openResource(resource.uri));
				return row;
			}),
		);
	}

	/** A titled section of an overview, with a count and an optional "all" link. */
	function overviewSection(title: string, count: number, body: Node[], more?: () => void): HTMLElement {
		return el('section', { class: 'rx-section' }, [
			el('div', { class: 'rx-section-head' }, [
				el('h3', { class: 'rx-section-title', text: title }),
				el('span', { class: 'rx-section-count', text: String(count) }),
				el('span', { class: 'grow' }),
				...(more === undefined
					? []
					: [button({ label: 'Open', icon: 'arrow-up-right', variant: 'ghost', small: true, onClick: more })]),
			]),
			...body,
		]);
	}

	async function showServer(): Promise<void> {
		await toolsReady;
		if (!alive) return;
		const mine = tools.filter((tool) => domainOf(tool.name) === 'server');
		ctx.show('group:server', [
			viewerHead({
				glyph: 'server',
				kind: 'The server',
				title: 'Server',
				mono: false,
				tags: [
					tip(tag(String(own.length)), 'Resources'),
					tip(tag(`${templateList.length} templates`, 'template'), 'Resource templates'),
					...(mine.length === 0 ? [] : [tip(tag(`${mine.length} tools`, 'tools'), 'Tools')]),
				],
			}),
			el('div', { class: 'rx-body' }, [
				overviewSection('Resources', own.length, [
					resourceError === null ? resourceRows(own) : empty('lock', 'Resources unavailable', resourceError),
				]),
				overviewSection('Templates', templateList.length, [
					templateList.length === 0
						? el('p', { class: 'rx-lede', text: templateError ?? 'This server publishes no resource templates.' })
						: el(
							'div',
							{ class: 'rx-chips' },
							templateList.map((template, index) => {
								const chip = el('button', {
									type: 'button',
									class: 'rx-chip mono',
									text: template.uriTemplate,
								});
								on(chip, 'click', () => showTemplates(index));
								return chip;
							}),
						),
				], () => showTemplates()),
				...(mine.length === 0 ? [] : toolSections(mine, 'domain')),
			]),
		]);
	}

	async function showBrowser(): Promise<void> {
		await toolsReady;
		if (!alive) return;
		const mine = tools.filter((tool) => domainOf(tool.name) === 'browser');
		ctx.show('group:browser', [
			viewerHead({
				glyph: 'globe',
				kind: 'The browser',
				title: 'Browser',
				mono: false,
				tags: [
					tip(tag(`${bySession.size} sessions`, 'sessions'), 'Browser sessions'),
					tip(tag(`${mine.length} tools`, 'tools'), 'Browser tools'),
				],
				actions: [button({ label: 'Sessions', icon: 'live', small: true, onClick: () => navigate('#/sessions') })],
			}),
			el('div', { class: 'rx-body' }, [
				overviewSection('Sessions', bySession.size, [sessionCards()], () => showSessions()),
				...toolSections(mine, 'family'),
			]),
		]);
	}

	/** The sessions as cards: a click lists the session's resources. */
	function sessionCards(): HTMLElement {
		if (resourceError !== null) return empty('lock', 'Resources unavailable', resourceError);
		if (bySession.size === 0) {
			return el('p', {
				class: 'rx-lede',
				text: 'No sessions yet. Their state, screenshot and page appear as they open.',
			});
		}
		return el(
			'div',
			{ class: 'rx-cards' },
			[...bySession].map(([session, list]) => {
				const card = el('button', { type: 'button', class: 'rx-card' }, [
					el('span', { class: 'rx-card-glyph live', 'aria-hidden': 'true' }, [icon('live')]),
					el('div', { class: 'rx-card-text' }, [
						el('span', { class: 'rx-card-title mono', text: session }),
						el('span', { class: 'rx-card-hint', text: `${list.length} resources` }),
					]),
				]);
				on(card, 'click', () => showSessions(session));
				return card;
			}),
		);
	}

	function showSessions(only?: string): void {
		const entries = only === undefined ? [...bySession] : [...bySession].filter(([session]) => session === only);
		const count = entries.reduce((sum, [, list]) => sum + list.length, 0);
		ctx.show(only === undefined ? 'group:sessions' : `session:${only}`, [
			viewerHead({
				glyph: only === undefined ? 'sessions' : 'live',
				kind: only === undefined ? 'Browser sessions' : 'Browser session',
				title: only ?? 'Sessions',
				mono: only !== undefined,
				tags: [
					...(only === undefined ? [tip(tag(String(bySession.size)), 'Sessions')] : []),
					tip(tag(`${count} resources`, 'resources'), 'Resources'),
				],
				actions: only === undefined ? [] : [button({
					label: 'Watch',
					icon: 'live',
					small: true,
					onClick: () => navigate(`#/view/${encodeURIComponent(only)}`),
				})],
			}),
			el('div', { class: 'rx-body' }, [
				resourceError !== null
					? empty('lock', 'Resources unavailable', resourceError)
					: entries.length === 0
					? empty('sessions', 'No sessions yet', 'Their state, screenshot and page appear here as sessions open.')
					: el(
						'div',
						{ class: 'rx-sessions' },
						entries.map(([session, list]) =>
							el('section', { class: 'rx-session', 'aria-label': `Session ${session}` }, [
								...(only === undefined ? [el('h3', { class: 'rx-session-name mono', text: session })] : []),
								resourceRows(list),
							])
						),
					),
			]),
		]);
	}

	async function loadResources(): Promise<void> {
		try {
			const all = await mcp.resources();
			if (!alive) return;
			const pinned = all.find((resource) => resource.uri === CAPABILITIES_URI) ??
				{ uri: CAPABILITIES_URI, title: 'Capabilities', mimeType: 'application/json' };
			own = [pinned];
			bySession = new Map();
			for (const resource of all) {
				if (resource.uri === CAPABILITIES_URI) continue;
				const session = sessionOf(resource.uri);
				if (session !== null) {
					bySession.set(session, [...(bySession.get(session) ?? []), resource]);
					continue;
				}
				// The share and the skills are the Files and Skills groups, listed from their own routes.
				const root = rootOf(resource.uri);
				if (root !== 'share' && root !== 'skill') own.push(resource);
			}
			server.append(...own.map(resourceLeaf), templates);
			let sessionCount = 0;
			for (const [session, list] of bySession) {
				sessionHints.append(el('option', { value: session }));
				sessionIds.append(el('option', { value: session }));
				const branch = treeBranch(`session:${session}`, session, 'live', `Session ${session}`, true);
				branch.append(...list.map(resourceLeaf));
				setBranchCount(branch, String(list.length));
				sessions.append(branch);
				sessionCount += list.length;
			}
			setBranchCount(server, String(own.length));
			setBranchCount(sessions, String(bySession.size));
			setBranchCount(browser, String(sessionCount));
			ctx.commands('server', own.map((resource) => resourceCommand(resource, 'Resources')));
			ctx.commands(
				'sessions',
				[...bySession.values()].flat().map((resource) => resourceCommand(resource, 'Resources')),
			);
		} catch (cause) {
			resourceError = messageOf(cause);
			server.append(templates);
			setBranchCount(server, null);
			setBranchCount(sessions, null);
		} finally {
			if (currentKey !== null) mark(currentKey);
		}
	}

	// --- Server › Templates: resources/templates/list ---
	let templateList: McpResourceTemplate[] = [];
	let templateError: string | null = null;

	function templateForm(template: McpResourceTemplate, index: number): HTMLElement {
		const names = [...template.uriTemplate.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
		const label = (name: string): string => `${template.name ?? 'template'} ${name}`;
		const inputs = names.map((name, n) =>
			el('input', {
				id: `rx-tpl-${index}-${n}`,
				type: 'text',
				class: 'rx-var',
				placeholder: name,
				'aria-label': label(name),
				list: name === 'sessionId' ? 'resource-sessions' : name === 'kind' ? 'resource-kinds' : undefined,
			})
		);
		const read = iconButton('play', 'Read', undefined, { small: true, type: 'submit', variant: 'primary' });
		const title = el('span', { class: 'rx-tpl-title', text: template.title ?? template.name ?? 'Template' });
		if (template.description !== undefined) tip(title, template.description, 'right');
		const result = el('div', { class: 'rx-tpl-result' });
		const form = el('form', { class: 'rx-tpl' }, [
			el('div', { class: 'rx-tpl-head' }, [el('span', { class: 'rx-glyph' }, [icon('link')]), title]),
			el('code', { class: 'rx-tpl-uri mono', text: template.uriTemplate }),
			el('div', { class: 'rx-tpl-vars' }, [
				...inputs.flatMap((input, n) => [
					el('label', { class: 'sr-only', for: input.id, text: label(names[n] ?? '') }),
					input,
				]),
				read,
			]),
		]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			let uri = template.uriTemplate;
			names.forEach((name, n) => {
				uri = uri.replace(`{${name}}`, encodeURIComponent(inputs[n]?.value.trim() ?? ''));
			});
			if (names.some((_, n) => (inputs[n]?.value.trim() ?? '') === '')) {
				toast('Fill every template variable', 'info');
				return;
			}
			// The read result lands under the form, in the same viewer the resource would have.
			void busy(read, () => readResource(uri, (nodes) => result.replaceChildren(...nodes)));
		});
		return el('div', { class: 'rx-tpl-slot' }, [form, result]);
	}

	function showTemplates(index?: number): void {
		const chosen = index === undefined ? templateList : [templateList[index]].filter((t) => t !== undefined);
		const one = index === undefined ? undefined : templateList[index];
		ctx.show(index === undefined ? 'group:templates' : `template:${index}`, [
			viewerHead({
				glyph: 'template',
				kind: 'Resource templates',
				title: one === undefined ? 'Templates' : one.title ?? one.name ?? one.uriTemplate,
				mono: one !== undefined && one.title === undefined && one.name === undefined,
				tags: [tip(tag(String(templateList.length)), 'Templates')],
			}),
			el(
				'div',
				{ class: 'rx-body rx-templates' },
				chosen.length === 0
					? [empty('template', 'No templates', templateError ?? 'This server publishes no resource templates.')]
					: chosen.map((template, n) => templateForm(template, index ?? n)),
			),
		]);
	}

	async function loadTemplates(): Promise<void> {
		try {
			templateList = await mcp.templates();
			if (!alive) return;
			templates.append(...templateList.map((template, index) =>
				treeLeaf(
					`template:${index}`,
					template.title ?? template.name ?? template.uriTemplate,
					'link',
					template.description === undefined
						? template.uriTemplate
						: `${template.uriTemplate} · ${template.description}`,
				)
			));
			setBranchCount(templates, String(templateList.length));
			ctx.commands(
				'templates',
				templateList.map((template, index) => ({
					id: `template:${template.uriTemplate}`,
					label: template.title ?? template.name ?? template.uriTemplate,
					icon: 'link',
					hint: template.uriTemplate,
					group: 'Templates',
					run: () => showTemplates(index),
				})),
			);
		} catch (cause) {
			templateError = messageOf(cause);
			setBranchCount(templates, null);
		} finally {
			if (currentKey !== null) mark(currentKey);
		}
	}

	// --- the overview: what the screen shows with nothing selected ---
	/** Every group's first listing, so the overview counts what was listed rather than what had arrived. */
	const listings: Promise<unknown>[] = [];
	async function showOverview(): Promise<void> {
		// The tool counts are the screen's: wait for every listing (each settles, failed or not) before drawing them. The
		// item counts are the overview route's, read fresh each time the overview opens (D-155).
		await Promise.allSettled([toolsReady, ...listings, loadStored()]);
		if (!alive) return;
		ctx.show('group:overview', [
			viewerHead({
				glyph: 'resources',
				kind: 'Everything this credential can reach',
				title: 'Resources',
				mono: false,
				tags: [tip(tag(`${tools.length} tools`, 'tools'), 'Tools served to this credential')],
			}),
			el(
				'div',
				{ class: 'rx-body' },
				[el(
					'div',
					{ class: 'rx-domains' },
					DOMAINS.map((domain) => {
						// D-155: what was added to the group, with its own noun; the Server group has none to count.
						const items = domainItems(domain.id, stored);
						const toolCount = tools.filter((tool) => domainOf(tool.name) === domain.id).length;
						const card = el('button', { type: 'button', class: 'rx-domain', 'data-domain': domain.id }, [
							el('span', { class: 'rx-domain-glyph', 'aria-hidden': 'true' }, [icon(domain.glyph)]),
							el('span', { class: 'rx-domain-name', text: domain.label }),
							el('span', { class: 'rx-domain-hint', text: domain.hint }),
							el('span', { class: 'rx-domain-counts' }, [
								...(items === null ? [] : [el('span', { text: items.text })]),
								el('span', { text: `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` }),
							]),
						]);
						on(card, 'click', () => openKey(`group:${domain.id}`));
						return card;
					}),
				)],
			),
		]);
	}

	// --- selection ---
	function leaveViewer(): void {
		leaving?.();
		leaving = null;
	}

	function openKey(key: string): void {
		const colon = key.indexOf(':');
		const kind = key.slice(0, colon);
		const rest = key.slice(colon + 1);
		leaveViewer();
		switch (kind) {
			case 'uri':
				openResource(rest);
				break;
			case 'group':
				if (rest === 'server') void showServer();
				else if (rest === 'browser') void showBrowser();
				else if (rest === 'sessions') showSessions();
				else if (rest === 'templates') showTemplates();
				else if (rest === 'files') void files.open();
				else if (rest === 'skills') void skills.open();
				else if (rest === 'prompts') void prompts.open();
				else if (rest === 'sandbox') void sandbox.open();
				else if (rest === 'agents') void agents.open();
				else if (rest === 'surfaces') {
					leaving = surfaces.leave ?? null;
					void surfaces.open();
				} else if (rest === 'tools') void showTools();
				else void showOverview();
				break;
			case 'session':
				showSessions(rest);
				break;
			case 'folder':
				void files.open(rest);
				break;
			case 'skill':
				void skills.open(rest);
				break;
			case 'prompt':
				void prompts.open(rest);
				break;
			case 'template':
				showTemplates(Number(rest));
				break;
			case 'tools':
				void showTools(DOMAIN_IDS.has(rest) ? rest as ToolDomain : undefined);
				break;
			case 'family':
				void showTools('browser');
				break;
			case 'tool':
				void showTool(rest);
				break;
			case 'agent':
				void agents.open(rest);
				break;
			case 'provider':
				void agents.open(`provider/${rest}`);
				break;
			case 'surface':
				leaving = surfaces.leave ?? null;
				void surfaces.open(rest);
				break;
			case 'surfaces':
				void surfaces.open('@actions');
				break;
			case 'workspace':
				void sandbox.open(rest);
				break;
		}
	}

	/** Opens what a clicked (or Enter/Space-activated) tree item names; the chevron only expands. */
	function pick(event: Event): void {
		if (event.composedPath().some((node) => node instanceof Element && node.classList.contains('expand-button'))) {
			return;
		}
		const item = event.target instanceof Element ? event.target.closest('wa-tree-item') : null;
		const key = item?.getAttribute('data-key');
		if (item === null || item === undefined || key === undefined || key === null) return;
		openKey(key);
		if (!item.isLeaf) item.expanded = true;
		if (pane.classList.contains('open')) foldTree(false);
	}
	on(tree, 'click', pick);
	on(tree, 'keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') pick(event);
	});

	// A drawer that closes by itself leaves its group in view: the route says so.
	const stopDrawerWatch = onDrawerClose((key) => {
		if (currentKey !== key) return;
		ctx.settle(key.startsWith('skill:') ? 'group:skills' : 'group:prompts');
	});

	onLeave(() => {
		alive = false;
		observer.disconnect();
		cancelAnimationFrame(filterFrame);
		clearTimeout(searchTimer);
		leaveViewer();
		clearCommands('resources');
		stopDrawerWatch();
		dropDrawer();
	});

	const actions: Node[] = writable ? [] : [
		tip(
			tag('Read-only', 'lock', 'warn'),
			'This credential holds files:read only: files, skills and prompts are read-only here.',
		),
	];
	mount(renderShell(navigate, {
		active: 'resources',
		title: 'Resources',
		subtitle: 'Every resource and tool this credential can reach: sessions, files, skills, prompts, agents, surfaces',
		actions,
		// A tree beside a viewer is a workbench: the viewer takes all the width it is given (D-093).
		wide: true,
	}, [sessionHints, sessionIds, kindHints, el('div', { class: 'rx-layout' }, [pane, viewer])]));
	applyFilters();

	// Suggestions for every `session_id` field; a credential without the admin route simply gets none beyond the
	// sessions `resources/list` names.
	api.listSessions().then(({ sessions: list }) => {
		const known = new Set(Array.from(sessionIds.querySelectorAll('option')).map((option) => option.value));
		for (const session of list) {
			if (!known.has(session.session_id)) sessionIds.append(el('option', { value: session.session_id }));
		}
	}).catch(() => {});

	// --- the listings, then the deep link (which may wait on one of them) ---
	const loadResourcesOnce = loadResources();
	const loadTemplatesOnce = loadTemplates();
	listings.push(
		loadResourcesOnce,
		loadTemplatesOnce,
		files.load(),
		skills.load(),
		prompts.load(),
		sandbox.load(),
		agents.load(),
		surfaces.load(),
	);
	const route = routeOf(initial);
	if (route.kind === 'uri') openResource(route.uri);
	else if (route.kind === 'none') void showOverview();
	else {
		const rest = route.rest;
		switch (route.group) {
			case 'files':
				void files.open(rest);
				break;
			case 'skills':
				void skills.open(rest);
				break;
			case 'prompts':
				void prompts.open(rest);
				break;
			case 'agents':
				void agents.open(rest);
				break;
			case 'surfaces':
				leaving = surfaces.leave ?? null;
				void surfaces.open(rest);
				break;
			case 'sandbox':
				void sandbox.open(rest);
				break;
			case 'tools':
				if (rest === undefined) void showTools();
				else if (rest.startsWith('@')) {
					void showTools(DOMAIN_IDS.has(rest.slice(1)) ? rest.slice(1) as ToolDomain : undefined);
				} else void showTool(rest);
				break;
			case 'server':
				void loadResourcesOnce.then(() => showServer());
				break;
			case 'browser':
				void loadResourcesOnce.then(() => showBrowser());
				break;
			case 'sessions':
				void loadResourcesOnce.then(() => showSessions(rest));
				break;
			case 'templates':
				void loadTemplatesOnce.then(() => showTemplates());
				break;
		}
	}
}
