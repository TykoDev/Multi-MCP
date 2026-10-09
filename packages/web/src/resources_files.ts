/**
 * The Files group of the Resources tree: the file share (D-075), listed lazily per folder from `GET /api/v1/share`
 * — a folder's branch expands into one listing, never `resources/list` — and shown in the viewer as type-glyph tiles
 * (grid or list) over a drop zone. Selecting a folder shows the folder; selecting a tile opens the file in the
 * viewer: a text editor up to 1 MiB (`file_read` / `file_write`), a download offer above that. Binary transfers
 * (upload, download) use the share's HTTP routes; everything else goes through the `file_*` tools.
 *
 * The toolbar reads left to right as where you are (the path, each crumb a button, the current one marked
 * `aria-current="location"`), how you see it (Grid · List, worded) and what you can add (one **Add ▾** menu:
 * upload, new folder, new file). The drop strip says "Drop files to upload" at rest, not only while dragging. An
 * empty folder offers Upload in its empty state — the one primary — and keeps **Add ▾** in its header, since a
 * menu is not a second primary and New folder / New file must stay reachable (D-092, F-04); the drop strip is
 * folded into the empty state's own "Drop files here", so `cloud-upload` is drawn once (FE-4). Without
 * `files:write` the write controls are disabled with the reason as their tooltip; the server refuses the writes
 * regardless.
 *
 * No refresh control: a folder is re-listed every time it is shown and after every write (D-092).
 */
import type WaTreeItem from '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import { api, ApiError, downloadFile, type ShareEntry } from './api.ts';
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import type { Command } from './palette.ts';
import {
	field,
	type FileKind,
	formActions,
	gate,
	KIND_GLYPHS,
	kindOfName,
	READ_ONLY_REASON,
	readOnlyMark,
	textarea,
	tool,
} from './resources_drawer.ts';
import { type Group, type GroupContext, setBranchCount, treeBranch, viewerHead } from './resources_view.ts';
import {
	busy,
	button,
	confirmButton,
	copyButton,
	empty,
	formatBytes,
	iconButton,
	illustration,
	menuButton,
	messageOf,
	openModal,
	relativeTime,
	segmented,
	tag,
	tip,
	toast,
} from './ui.ts';

/** One folder's listing, as `GET /api/v1/share` answers it. */
type Listing = Awaited<ReturnType<typeof api.shareList>>;

/** Text files up to this size open in the editor; larger ones offer a download. */
const MAX_EDITABLE_BYTES = 1024 * 1024;

/** How the share is laid out; kept for this page load only (no storage). */
let fileView: 'grid' | 'list' = 'grid';

export function kindOf(entry: ShareEntry): FileKind {
	return entry.kind === 'directory' ? 'folder' : kindOfName(entry.name);
}

/** The selection key of a folder: the share root is the group itself. */
export function keyOf(path: string): string {
	return path === '' ? 'group:files' : `folder:${path}`;
}

/** The folder a path is in; the root's parent is the root. */
export function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash);
}

/** The crumbs of a path: the share root first, named "Files", then one per segment with the path up to it. */
export function crumbsOf(path: string): Array<{ readonly name: string; readonly path: string }> {
	const parts = path === '' ? [] : path.split('/');
	return [
		{ name: 'Files', path: '' },
		...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') })),
	];
}

/** Every proper ancestor of a path, the root first: what must be listed before the path's own tree item exists. */
export function ancestorsOf(path: string): string[] {
	if (path === '') return [];
	const parts = path.split('/');
	return ['', ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))];
}

/**
 * Forgets `root` and everything under it in a per-folder cache (BUG-1): a parent re-listed with `again` replaces its
 * sub-folder branches with fresh lazy nodes, and a listing promise kept for a removed branch would answer the fresh
 * branch's lazy load with a result that only ever touched the old one. `''` is the share root and forgets everything.
 */
export function forgetSubtree(cache: Map<string, unknown>, root: string): void {
	for (const key of Array.from(cache.keys())) {
		if (root === '' || key === root || key.startsWith(`${root}/`)) cache.delete(key);
	}
}

export function filesGroup(ctx: GroupContext): Group {
	const { writable } = ctx;
	const node = treeBranch('group:files', 'Files', 'folder', 'The file share · ttk://share');
	/** The tree item of each folder that has one; the root is the group. */
	const folderItems = new Map<string, WaTreeItem>([['', node]]);
	/** The listing behind each folder's tree children, in flight or done. */
	const listed = new Map<string, Promise<Listing>>();

	/**
	 * Lists `path` and puts its sub-folders under its tree item as lazy branches; once per folder unless `again`.
	 * A path with no tree item (a file, or a folder the tree has not reached) is listed without touching the tree.
	 */
	function listInto(path: string, again = false): Promise<Listing> {
		if (!again) {
			const pending = listed.get(path);
			if (pending !== undefined) return pending;
		}
		const work = (async () => {
			const listing = await api.shareList(path);
			const { entries, truncated } = listing;
			const item = folderItems.get(path);
			if (!ctx.alive() || item === undefined) return listing;
			// Folder branches only: the group's Tools branch (D-152) is the tree's, not this listing's.
			for (const child of Array.from(item.querySelectorAll(':scope > wa-tree-item.rx-folder'))) {
				const childPath = (child.getAttribute('data-key') ?? '').slice('folder:'.length);
				// The branch and its whole subtree are gone with it: so are their tree items and listings (BUG-1).
				forgetSubtree(folderItems, childPath);
				forgetSubtree(listed, childPath);
				child.remove();
			}
			for (const entry of entries) {
				if (entry.kind !== 'directory') continue;
				const branch = treeBranch(`folder:${entry.path}`, entry.name, 'folder', entry.path);
				branch.classList.add('rx-folder');
				branch.lazy = true;
				folderItems.set(entry.path, branch);
				item.append(branch);
			}
			item.lazy = false;
			item.loading = false;
			if (path === '') setBranchCount(node, truncated ? '2000+' : String(entries.length));
			return listing;
		})();
		listed.set(path, work);
		// A failed listing is forgotten so the next look retries — but only while it is still the one kept, since a
		// re-listing may have replaced it meanwhile (BUG-7).
		work.catch(() => {
			if (listed.get(path) === work) listed.delete(path);
		});
		return work;
	}

	// A folder branch lists itself when it opens (the kit shows its spinner meanwhile). Always a fresh listing: the
	// kit fires this once per branch element, and a branch re-created by its parent's re-listing must not be answered
	// by a listing that marked the element it replaced (BUG-1).
	node.addEventListener('wa-lazy-load', (event) => {
		const item = event.target instanceof Element ? event.target.closest('wa-tree-item') : null;
		const key = item?.getAttribute('data-key') ?? '';
		if (!key.startsWith('folder:')) return;
		void listInto(key.slice('folder:'.length), true).catch((cause) => {
			if (item !== null) {
				item.lazy = false;
				item.loading = false;
			}
			toast(messageOf(cause), 'error');
		});
	});

	/** Lists every ancestor of `path`, so its own tree item exists to be marked. Failures are the viewer's to show. */
	async function reveal(path: string): Promise<void> {
		for (const ancestor of ancestorsOf(path)) {
			try {
				await listInto(ancestor);
			} catch {
				return;
			}
		}
	}

	function download(entry: ShareEntry): Promise<void> {
		return downloadFile(api.shareFilePath(entry.path), entry.name).catch((cause) => toast(messageOf(cause), 'error'));
	}

	function command(entry: ShareEntry): Command {
		return {
			id: `files:${entry.path}`,
			label: entry.name,
			hint: entry.path,
			icon: KIND_GLYPHS[kindOf(entry)],
			group: 'Files',
			run: () => {
				if (entry.kind === 'directory') void showFolder(entry.path);
				else void openFile(entry);
			},
		};
	}

	// --- the folder in the viewer ---

	/** The path as crumbs: each a button, the current one marked; the root crumb is the group's name. */
	function crumbs(path: string, truncated: boolean): HTMLElement {
		const all = crumbsOf(path);
		const nav = el('nav', { class: 'lib-crumbs', 'aria-label': 'Folder path' });
		all.forEach((crumb, index) => {
			const control = button({ label: crumb.name, small: true, variant: 'ghost' });
			control.classList.add('lib-crumb', 'mono');
			if (index === all.length - 1) control.setAttribute('aria-current', 'location');
			on(control, 'click', () => void showFolder(crumb.path));
			if (index > 0) nav.append(icon('chevron', 'lib-crumb-sep'));
			nav.append(control);
		});
		if (truncated) {
			const cut = el('wa-badge', { class: 'lib-cut', variant: 'warning', appearance: 'filled', pill: true }, ['2000+']);
			nav.append(tip(cut, 'Listing cut at 2000 entries.'));
		}
		return nav;
	}

	/** A one-field dialog that creates something in `cwd`, then re-lists it. */
	function askName(
		cwd: string,
		title: string,
		id: string,
		label: string,
		placeholder: string,
		glyph: IconName,
		create: (path: string) => Promise<unknown>,
	): void {
		const input = el('input', { type: 'text', id, placeholder, autocomplete: 'off', autofocus: true });
		const submit = button({ label: 'Create', icon: 'plus', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'lib-form' }, [field(id, label, input, glyph), formActions(submit)]);
		const dialog = openModal(title, [form]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				await create(cwd === '' ? input.value.trim() : `${cwd}/${input.value.trim()}`);
				dialog.close();
				await showFolder(cwd);
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		input.focus();
	}

	function openRename(entry: ShareEntry, cwd: string): void {
		const input = el('input', {
			type: 'text',
			id: 'rename-to',
			value: entry.path,
			class: 'mono',
			autocomplete: 'off',
			autofocus: true,
		});
		const submit = button({ label: 'Move', icon: 'forward', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'lib-form' }, [
			field('rename-to', 'New path (relative to the share)', input, KIND_GLYPHS[kindOf(entry)]),
			formActions(submit),
		]);
		const dialog = openModal(`Move ${entry.name}`, [form]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				await api.shareMove(entry.path, input.value.trim());
				dialog.close();
				await showFolder(cwd);
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		input.focus();
	}

	function tile(entry: ShareEntry, index: number, cwd: string): HTMLElement {
		const kind = kindOf(entry);
		const size = entry.kind === 'directory' ? '' : formatBytes(entry.size);
		const when = entry.modified_at === null ? '' : relativeTime(entry.modified_at);
		const open = el('button', { type: 'button', class: 'lib-file-open' }, [
			el('span', { class: `lib-file-glyph kind-${kind}`, 'aria-hidden': 'true' }, [icon(KIND_GLYPHS[kind])]),
			el('span', { class: 'lib-file-name', text: entry.name }),
			el('span', { class: 'lib-file-size', text: size }),
			el('span', { class: 'lib-file-time', text: when }),
		]);
		open.setAttribute('data-tip', [entry.name, size, when].filter((part) => part !== '').join(' · '));
		on(open, 'click', () => entry.kind === 'directory' ? void showFolder(entry.path) : void openFile(entry));
		const actions = el('div', { class: 'lib-file-actions' });
		if (entry.kind === 'file') {
			actions.append(iconButton('download', 'Download', () => void download(entry), { small: true }));
		}
		if (writable) {
			actions.append(
				iconButton('move', 'Move or rename', () => openRename(entry, cwd), { small: true }),
				confirmButton({
					label: entry.kind === 'directory' ? `Delete ${entry.name} and its contents` : `Delete ${entry.name}`,
					icon: 'trash',
					small: true,
					iconOnly: true,
				}, async () => {
					await api.shareDelete(entry.path, entry.kind === 'directory');
					toast(`${entry.name} deleted`, 'ok');
					await showFolder(cwd);
				}),
			);
		}
		const tileNode = el('div', { class: `lib-file kind-${kind}` }, [open, actions]);
		tileNode.style.setProperty('--i', String(Math.min(index, 24)));
		return tileNode;
	}

	/** The folder view: the toolbar (path · layout · Add), the tiles over the drop zone, the drop strip. */
	function folderView(cwd: string, entries: ShareEntry[], truncated: boolean): Node[] {
		const tiles = el('div', { class: `lib-files ${fileView}` });
		const layout = segmented(
			[{ id: 'grid', label: 'Grid', icon: 'grid' }, { id: 'list', label: 'List', icon: 'rows' }],
			fileView,
			(mode) => {
				fileView = mode === 'list' ? 'list' : 'grid';
				tiles.classList.toggle('grid', fileView === 'grid');
				tiles.classList.toggle('list', fileView === 'list');
			},
		);
		layout.node.setAttribute('aria-label', 'Layout');
		layout.node.classList.add('rx-files-layout');

		// --- uploads: the menu, the empty state and the drop zone go through the same loop ---
		const upload = el('input', { type: 'file', hidden: true, multiple: true, 'aria-label': 'Files to upload' });
		const mkdir = (path: string) => api.shareMkdir(path);
		const touch = (path: string) => tool('file_write', { path, content: '' });
		const add = menuButton('Add', 'plus', [
			{ label: 'Upload files', icon: 'cloud-upload', run: () => upload.click() },
			{
				label: 'New folder',
				icon: 'folder-plus',
				run: () => askName(cwd, 'New folder', 'new-folder', 'Folder name', 'name', 'folder', mkdir),
			},
			{
				label: 'New file',
				icon: 'file-plus',
				run: () => askName(cwd, 'New file', 'new-file', 'File name', 'notes.md', 'file-text', touch),
			},
		]);
		// Always in the header, empty folder included: it is a menu, not a second primary, and New folder / New file
		// have no other home (D-092, F-04).
		const addSlot = el('div', { class: 'rx-files-add' }, [writable ? add : gate(add, READ_ONLY_REASON), upload]);
		let uploading = false;
		async function uploadFiles(list: File[]): Promise<void> {
			if (list.length === 0 || uploading) return;
			uploading = true;
			await busy(add, async () => {
				for (const file of list) {
					await api.shareUpload(cwd === '' ? file.name : `${cwd}/${file.name}`, file);
				}
				toast(`${list.length} file${list.length === 1 ? '' : 's'} uploaded`, 'ok');
				await showFolder(cwd);
			}).catch((cause) => toast(messageOf(cause), 'error')).finally(() => (uploading = false));
		}
		on(upload, 'change', () => {
			const list = Array.from(upload.files ?? []);
			upload.value = '';
			void uploadFiles(list);
		});

		if (entries.length === 0) {
			if (writable) {
				// Worded, no glyph: the empty state's illustration is the screen's one `cloud-upload` (FE-4).
				const action = button({ label: 'Upload', variant: 'primary' });
				on(action, 'click', () => upload.click());
				tiles.append(empty('cloud-upload', 'No files yet', 'Drop files here, or upload them.', action));
			} else {
				tiles.append(empty('folder-open', 'Empty folder'));
			}
		}
		entries.forEach((entry, index) => tiles.append(tile(entry, index, cwd)));

		const head = el('header', { class: 'rx-head rx-files-head' }, [crumbs(cwd, truncated), layout.node, addSlot]);
		// The strip sits under the tiles; an empty folder's empty state already says "Drop files here" (FE-4).
		const zone = el('div', { class: 'lib-drop' }, [
			tiles,
			...(writable && entries.length > 0
				? [el('div', { class: 'lib-drop-strip' }, [icon('cloud-upload'), el('span', { text: 'Drop files to upload' })])]
				: []),
		]);
		const veil = el('div', { class: 'lib-drop-veil', 'aria-hidden': 'true' }, [
			illustration('cloud-upload'),
			el('span', { text: 'Drop to upload' }),
		]);
		const view = el('div', { class: 'rx-files' }, [head, el('div', { class: 'rx-body rx-files-body' }, [zone]), veil]);

		// The whole viewer is the drop zone while a folder is shown.
		let depth = 0;
		const accepts = (event: DragEvent): boolean => writable && (event.dataTransfer?.types.includes('Files') ?? false);
		on(view, 'dragenter', (event) => {
			if (!accepts(event)) return;
			event.preventDefault();
			depth += 1;
			view.classList.add('dragging');
		});
		on(view, 'dragover', (event) => {
			if (!accepts(event)) return;
			event.preventDefault();
			if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
		});
		on(view, 'dragleave', () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) view.classList.remove('dragging');
		});
		on(view, 'drop', (event) => {
			depth = 0;
			view.classList.remove('dragging');
			if (!accepts(event)) return;
			event.preventDefault();
			void uploadFiles(Array.from(event.dataTransfer?.files ?? []));
		});
		return [view];
	}

	/** The entry a path names when it is a file, read from its folder's listing. */
	async function fileEntry(path: string): Promise<ShareEntry | null> {
		try {
			const { entries } = await listInto(parentOf(path), true);
			return entries.find((entry) => entry.path === path && entry.kind === 'file') ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Shows a folder: the tree is revealed down to it, it is re-listed (the same listing feeds its tree children),
	 * and the viewer paints it. A path that turns out to be a file opens that file instead when `orFile` is set.
	 */
	async function showFolder(path: string, orFile = false): Promise<void> {
		const key = keyOf(path);
		await reveal(path);
		if (!ctx.alive()) return;
		ctx.loading(key);
		let entries: ShareEntry[];
		let truncated: boolean;
		try {
			// One listing feeds the viewer and the folder's tree children alike.
			({ entries, truncated } = await listInto(path, true));
		} catch (cause) {
			if (!ctx.alive()) return;
			if (orFile && path !== '') {
				const entry = await fileEntry(path);
				if (entry !== null) {
					await openFile(entry);
					return;
				}
			}
			ctx.commands('files', []);
			ctx.show(key, [
				el('header', { class: 'rx-head rx-files-head' }, [crumbs(path, false)]),
				el('div', { class: 'rx-body' }, [
					empty(
						'lock',
						'Share unavailable',
						cause instanceof ApiError && cause.status === 403 ? 'This credential lacks files:read.' : messageOf(cause),
					),
				]),
			]);
			return;
		}
		if (!ctx.alive()) return;
		ctx.commands('files', entries.map(command));
		ctx.show(key, folderView(path, entries, truncated));
	}

	// --- a file in the viewer ---

	async function openFile(entry: ShareEntry): Promise<void> {
		const key = `file:${entry.path}`;
		const kind = kindOf(entry);
		const downloadNow = (): HTMLButtonElement => {
			const control = button({ label: 'Download', icon: 'download', variant: 'primary' });
			on(control, 'click', () => void busy(control, () => download(entry)));
			return control;
		};
		const head = viewerHead({
			glyph: KIND_GLYPHS[kind],
			kind: `${kind} file`,
			title: entry.path,
			tags: [
				tip(tag(formatBytes(entry.size)), 'Size'),
				...(entry.modified_at === null ? [] : [
					tip(
						tag(relativeTime(entry.modified_at), 'clock'),
						`Modified ${new Date(entry.modified_at).toLocaleString()}`,
					),
				]),
			],
			actions: [
				copyButton(() => entry.path, 'Copy path'),
				iconButton('download', 'Download', () => void download(entry)),
			],
		});
		await reveal(parentOf(entry.path));
		if (!ctx.alive()) return;
		ctx.loading(key);
		if (entry.size > MAX_EDITABLE_BYTES) {
			ctx.show(key, [
				head,
				el('div', { class: 'rx-body' }, [empty('file', entry.name, 'Over 1 MiB: download it instead.', downloadNow())]),
			]);
			return;
		}
		try {
			const { content } = await tool<{ content: string }>('file_read', { path: entry.path });
			if (!ctx.alive()) return;
			const area = textarea('share-editor', content, 24);
			area.readOnly = !writable;
			area.setAttribute('aria-label', entry.name);
			const save = button({ label: 'Save', icon: 'save', variant: 'primary' });
			on(save, 'click', () =>
				void busy(save, async () => {
					await tool('file_write', { path: entry.path, content: area.value });
					toast(`${entry.name} saved`, 'ok');
				}).catch((cause) => toast(messageOf(cause), 'error')));
			ctx.show(key, [
				head,
				el('div', { class: 'rx-body rx-file' }, [
					area,
					el('div', { class: 'rx-file-foot' }, [
						...(writable ? [] : [readOnlyMark()]),
						el('span', { class: 'grow' }),
						writable ? save : gate(save, READ_ONLY_REASON),
					]),
				]),
			]);
		} catch (cause) {
			if (!ctx.alive()) return;
			ctx.show(key, [
				head,
				el('div', { class: 'rx-body' }, [
					empty('file', entry.name, `${messageOf(cause)} Download it instead.`, downloadNow()),
				]),
			]);
		}
	}

	return {
		node,
		async load(again = false) {
			try {
				await listInto('', again);
			} catch {
				// The root could not be listed (no data directory, no files:read): the count stays hidden and the
				// viewer explains when the group is opened.
				setBranchCount(node, null);
				node.loading = false;
			}
		},
		open: (rest) => showFolder(rest ?? '', true),
	};
}
