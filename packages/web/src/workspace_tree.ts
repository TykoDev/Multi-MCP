/**
 * The file tree of a coding workspace (Workspaces screen): every file and folder the sandbox holds, so a file is
 * opened by clicking it rather than by typing its path.
 *
 * Data comes from `sandbox_list` with a `path` (one directory per call: `{ entries: [{ name, type }], truncated }`,
 * `.git` already left out by the sandbox). The root is listed when the tree is shown; a folder is listed the first
 * time it is expanded, so a large workspace costs one call per folder the person actually opens. `refresh()` lists the
 * root and every expanded folder again, keeping what is expanded and dropping folders that no longer exist.
 *
 * Accessibility: the WAI-ARIA tree pattern — `role="tree"`, a `treeitem` per entry with `aria-level`,
 * `aria-expanded` on folders and `aria-selected` on the open file, `group`s for children, and one roving tab stop.
 * Up and Down move between visible rows, Right expands a folder (or enters it), Left collapses it (or goes to its
 * parent), Home and End jump, Enter and Space open a file or toggle a folder.
 *
 * Text only: names are written with `textContent`, never as markup.
 */
import { el, on } from './dom.ts';
import { icon } from './icons.ts';
import type { IconName } from './icon_names.ts';

/** One directory entry as `sandbox_list` returns it. */
export interface TreeEntry {
	readonly name: string;
	/** `file`, `directory` or `symlink`. */
	readonly type: string;
}

/** One directory listing. */
export interface TreeListing {
	readonly entries: readonly TreeEntry[];
	readonly truncated: boolean;
}

/** Lists one directory of the workspace; `''` is its root. */
export type ListDirectory = (path: string) => Promise<TreeListing>;

/** Folders first, then names in natural order (`file2` before `file10`), case-insensitively. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
	return [...entries].sort((a, b) => {
		const folders = Number(b.type === 'directory') - Number(a.type === 'directory');
		return folders !== 0 ? folders : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
	});
}

/** The workspace-relative path of `name` inside the directory `parent` (`''` for the root). */
export function joinPath(parent: string, name: string): string {
	return parent === '' ? name : `${parent}/${name}`;
}

/** The directory that holds `path`, `''` for an entry at the root. */
export function parentOf(path: string): string {
	const at = path.lastIndexOf('/');
	return at < 0 ? '' : path.slice(0, at);
}

/** The icon an entry is drawn with: folders open and closed, source files, links, other files. */
export function entryIcon(entry: TreeEntry, expanded: boolean): IconName {
	if (entry.type === 'directory') return expanded ? 'folder-open' : 'folder';
	if (entry.type === 'symlink') return 'link';
	return /\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|lua|sql|json|ya?ml|toml|html?|css|scss|vue|svelte)$/i
			.test(entry.name)
		? 'file-code'
		: 'file';
}

type Loaded =
	| { readonly state: 'loading' }
	| { readonly state: 'error'; readonly message: string }
	| { readonly state: 'ready'; readonly entries: readonly TreeEntry[]; readonly truncated: boolean };

/** The tree, as the Workspaces screen drives it. */
export interface FileTree {
	readonly element: HTMLElement;
	/** Lists the root and every expanded folder again; resolves once all of them have answered. */
	refresh(): Promise<void>;
	/** Marks `path` as the open file (or nothing) and expands the folders above it. */
	select(path: string | null): void;
	/** The paths of the expanded folders, for tests and for keeping state across refreshes. */
	expanded(): readonly string[];
}

export interface FileTreeOptions {
	readonly list: ListDirectory;
	/** A file row was chosen. */
	readonly onOpen: (path: string) => void;
	/** How an error is worded; the screen passes its own `messageOf`. */
	readonly messageOf?: (cause: unknown) => string;
}

export function fileTree(options: FileTreeOptions): FileTree {
	const { list, onOpen } = options;
	const describe = options.messageOf ?? ((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
	const root = el('ul', { class: 'ws-tree', role: 'tree', 'aria-label': 'Files' });
	const loaded = new Map<string, Loaded>();
	const open = new Set<string>();
	let selected: string | null = null;
	/** The row holding the tab stop, by path; the first row when it is gone. */
	let focusPath: string | null = null;
	/** Bumped per listing request, so an answer that arrives after a newer one for the same folder is ignored. */
	const generation = new Map<string, number>();
	/** The visible rows in display order, with what each one is: kept here rather than queried back out of the DOM. */
	let visible: Array<{ row: HTMLButtonElement; path: string; folder: boolean; entry: TreeEntry }> = [];

	async function load(path: string): Promise<void> {
		const mine = (generation.get(path) ?? 0) + 1;
		generation.set(path, mine);
		if (!loaded.has(path)) {
			loaded.set(path, { state: 'loading' });
			render();
		}
		let next: Loaded;
		try {
			const listing = await list(path);
			next = { state: 'ready', entries: sortEntries(listing.entries), truncated: listing.truncated };
		} catch (cause) {
			next = { state: 'error', message: describe(cause) };
		}
		if (generation.get(path) !== mine) return;
		loaded.set(path, next);
		render();
	}

	function toggle(path: string): void {
		if (open.has(path)) {
			open.delete(path);
			render();
			return;
		}
		open.add(path);
		if (loaded.get(path)?.state === 'ready') render();
		else void load(path);
	}

	/** A row was chosen: a folder toggles, a file opens, a link does nothing. */
	function activate(path: string, entry: TreeEntry): void {
		focusPath = path;
		if (entry.type === 'directory') toggle(path);
		else if (entry.type !== 'symlink') onOpen(path);
	}

	function status(text: string, level: number, kind = ''): HTMLElement {
		const item = el('li', { class: `ws-tree-note ${kind}`.trim(), role: 'none' });
		item.style.setProperty('--level', String(level));
		item.textContent = text;
		return item;
	}

	/** The rows of one directory, at `level` (1 for the root's entries). */
	function rows(path: string, level: number): HTMLElement[] {
		const listing = loaded.get(path);
		if (listing === undefined || listing.state === 'loading') return [status('Loading…', level, 'muted')];
		if (listing.state === 'error') return [status(listing.message, level, 'error')];
		if (listing.entries.length === 0) return [status(level === 1 ? 'No files yet' : '(empty)', level, 'muted')];
		const out: HTMLElement[] = [];
		for (const entry of listing.entries) {
			const entryPath = joinPath(path, entry.name);
			const folder = entry.type === 'directory';
			const expanded = folder && open.has(entryPath);
			const row = el('button', {
				type: 'button',
				class: 'ws-tree-row',
				tabindex: '-1',
				'data-path': entryPath,
				...(entry.type === 'symlink' ? { disabled: true, 'data-tip': 'Symbolic link: not opened here' } : {}),
			}, [
				el(
					'span',
					{ class: 'ws-tree-twist', 'aria-hidden': 'true' },
					folder ? [icon(expanded ? 'chevron-down' : 'chevron')] : [],
				),
				el('span', { class: 'ws-tree-glyph', 'aria-hidden': 'true' }, [icon(entryIcon(entry, expanded))]),
				el('span', { class: 'ws-tree-name', text: entry.name }),
			]);
			row.style.setProperty('--level', String(level));
			visible.push({ row, path: entryPath, folder, entry });
			on(row, 'click', () => activate(entryPath, entry));
			on(row, 'focus', () => {
				focusPath = entryPath;
			});
			const item = el('li', {
				role: 'treeitem',
				class: `ws-tree-item ${folder ? 'is-folder' : 'is-file'}`,
				'aria-level': String(level),
				'aria-selected': String(!folder && entryPath === selected),
				...(folder ? { 'aria-expanded': String(expanded) } : {}),
			}, [row]);
			if (expanded) item.append(el('ul', { role: 'group', class: 'ws-tree-group' }, rows(entryPath, level + 1)));
			out.push(item);
		}
		if (listing.truncated) out.push(status('More entries are not shown (1000 per folder)', level, 'muted'));
		return out;
	}

	function render(): void {
		const hadFocus = visible.some(({ row }) => row === document.activeElement);
		visible = [];
		root.replaceChildren(...rows('', 1));
		const current = visible.find(({ path }) => path === focusPath) ?? visible[0];
		if (current !== undefined) {
			current.row.setAttribute('tabindex', '0');
			if (hadFocus) current.row.focus();
		}
	}

	function move(to: { row: HTMLButtonElement; path: string } | undefined): void {
		if (to === undefined) return;
		for (const { row } of visible) row.setAttribute('tabindex', '-1');
		to.row.setAttribute('tabindex', '0');
		focusPath = to.path;
		to.row.focus();
	}

	on(root, 'keydown', (event: KeyboardEvent) => {
		const here = visible.findIndex(({ row }) => row === document.activeElement);
		if (here < 0) return;
		const { path, folder, entry } = visible[here]!;
		switch (event.key) {
			case 'ArrowDown':
				move(visible[here + 1]);
				break;
			case 'ArrowUp':
				move(visible[here - 1]);
				break;
			case 'Home':
				move(visible[0]);
				break;
			case 'End':
				move(visible[visible.length - 1]);
				break;
			case 'ArrowRight':
				if (!folder) return;
				if (!open.has(path)) toggle(path);
				else move(visible[here + 1]?.path.startsWith(`${path}/`) ? visible[here + 1] : undefined);
				break;
			case 'ArrowLeft':
				if (folder && open.has(path)) toggle(path);
				else move(visible.find((candidate) => candidate.path === parentOf(path)));
				break;
			case 'Enter':
			case ' ':
				activate(path, entry);
				break;
			default:
				return;
		}
		event.preventDefault();
	});

	return {
		element: root,
		async refresh(): Promise<void> {
			await load('');
			// Each expanded folder again, parents before children; one that vanished is collapsed rather than shown failing.
			for (const path of [...open].sort((a, b) => a.split('/').length - b.split('/').length)) {
				const parent = loaded.get(parentOf(path));
				const name = path.slice(path.lastIndexOf('/') + 1);
				const stillThere = parent?.state === 'ready' &&
					parent.entries.some((entry) => entry.name === name && entry.type === 'directory');
				if (!stillThere) {
					open.delete(path);
					loaded.delete(path);
					continue;
				}
				await load(path);
			}
			render();
		},
		select(path: string | null): void {
			selected = path;
			if (path !== null) {
				focusPath = path;
				// The folders above the open file are expanded, so the highlighted row is visible.
				let parent = parentOf(path);
				const toLoad: string[] = [];
				while (parent !== '') {
					if (!open.has(parent)) {
						open.add(parent);
						if (loaded.get(parent)?.state !== 'ready') toLoad.push(parent);
					}
					parent = parentOf(parent);
				}
				for (const folder of toLoad.reverse()) void load(folder);
			}
			render();
		},
		expanded(): readonly string[] {
			return [...open].sort();
		},
	};
}
