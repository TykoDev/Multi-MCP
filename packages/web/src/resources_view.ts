/**
 * Resources: the file share (`/api/v1/share`), one folder at a time (`#/resources/<folder>`). A file opens in an
 * editor up to 1 MiB, or downloads; files upload by the picker or by a drop on the list. Without `files:write` the
 * write controls are disabled; the server refuses the writes regardless.
 */
import { api, ApiError, downloadFile, getUser, send, type ShareEntry } from './api.ts';
import { el, mount, on } from './dom.ts';
import { icon } from './icons.ts';
import { type Navigate, renderShell } from './shell.ts';
import {
	busy,
	button,
	confirmButton,
	empty,
	field,
	formatBytes,
	iconButton,
	input,
	messageOf,
	notice,
	openModal,
	relativeTime,
	toast,
} from './ui.ts';

/** Larger files download instead of opening in the editor. */
const EDITABLE_BYTES = 1024 * 1024;

/** A folder's parent (`a/b` → `a`, `a` → ``). */
export function parentOf(path: string): string {
	return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** `child` inside `folder`. */
export function join(folder: string, child: string): string {
	return folder === '' ? child : `${folder}/${child}`;
}

export function resourcesView(navigate: Navigate, folder: string): void {
	const canWrite = getUser()?.scopes.includes('files:write') === true;
	const route = (path: string): string => `#/resources${path === '' ? '' : `/${path}`}`;
	const list = el('div', { class: 'rs-list', 'aria-busy': 'true' });
	const status = el('div');

	const crumbs = el('nav', { class: 'rs-crumbs', 'aria-label': 'Folder' }, [
		el('a', { href: route(''), text: 'Files' }),
		...folder.split('/').filter(Boolean).flatMap((name, index, all) => [
			el('span', { 'aria-hidden': 'true', text: '/' }),
			el('a', {
				href: route(all.slice(0, index + 1).join('/')),
				'aria-current': index === all.length - 1 ? 'location' : undefined,
				text: name,
			}),
		]),
	]);

	async function upload(files: Iterable<File>): Promise<void> {
		for (const file of files) await api.shareUpload(join(folder, file.name), file);
		toast('Uploaded', 'ok');
		await load();
	}

	const picker = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Files to upload' });
	on(picker, 'change', () => {
		if (picker.files !== null) void upload([...picker.files]).catch((cause) => toast(messageOf(cause), 'error'));
		picker.value = '';
	});
	const uploadBtn = button({
		label: 'Upload',
		icon: 'cloud-upload',
		variant: 'primary',
		onClick: () => picker.click(),
	});

	/** A one-field dialog: a name, then `run` with it. */
	function ask(title: string, label: string, initial: string, run: (value: string) => Promise<void>): void {
		const value = input('rs-name', initial);
		const submit = button({ label: title, variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'form' }, [
			field('rs-name', label, value),
			el('div', { class: 'actions' }, [
				submit,
			]),
		]);
		const dialog = openModal(title, [form]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			const name = value.value.trim();
			if (name === '') return;
			void busy(submit, async () => {
				await run(name);
				dialog.close();
				await load();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		value.focus();
	}
	const newFolder = button({
		label: 'New folder',
		icon: 'folder-plus',
		onClick: () =>
			ask('New folder', 'Folder name', '', async (name) => {
				await api.shareMkdir(join(folder, name));
			}),
	});
	const newFile = button({
		label: 'New file',
		icon: 'file-plus',
		onClick: () =>
			ask('New file', 'File name', '', async (name) => {
				await api.shareUpload(join(folder, name), new Blob([''], { type: 'text/plain' }));
			}),
	});
	for (const control of [uploadBtn, newFolder, newFile]) control.disabled = !canWrite;

	/** Opens a file: text up to 1 MiB in the editor, anything larger as a download. */
	async function openFile(entry: ShareEntry): Promise<void> {
		if (entry.size > EDITABLE_BYTES) {
			await downloadFile(api.shareFilePath(entry.path), entry.name);
			return;
		}
		const text = await (await send(api.shareFilePath(entry.path))).text();
		const editor = el('textarea', { id: 'share-editor', class: 'mono rs-editor', rows: 22, spellcheck: 'false' });
		editor.value = text;
		editor.readOnly = !canWrite;
		const save = button({ label: 'Save', icon: 'save', variant: 'primary' });
		save.disabled = !canWrite;
		on(save, 'click', () =>
			void busy(save, async () => {
				await api.shareUpload(entry.path, new Blob([editor.value], { type: 'text/plain' }));
				toast(`${entry.name} saved`, 'ok');
				await load();
			}).catch((cause) => toast(messageOf(cause), 'error')));
		const download = button({
			label: 'Download',
			icon: 'download',
			onClick: () => void downloadFile(api.shareFilePath(entry.path), entry.name),
		});
		openModal(entry.path, [editor, el('div', { class: 'actions' }, [download, save])], true);
	}

	function row(entry: ShareEntry): HTMLElement {
		const folderRow = entry.kind === 'directory';
		const open = el('button', { type: 'button', class: 'rs-name' }, [
			icon(folderRow ? 'folder' : 'file'),
			el('span', { text: entry.name }),
		]);
		on(open, 'click', () => {
			if (folderRow) navigate(route(entry.path));
			else void openFile(entry).catch((cause) => toast(messageOf(cause), 'error'));
		});
		const rename = iconButton(
			'edit',
			`Rename ${entry.name}`,
			() =>
				ask('Rename', 'New name', entry.name, async (name) => {
					await api.shareMove(entry.path, join(parentOf(entry.path), name));
				}),
			{ small: true },
		);
		const remove = confirmButton(
			{ label: `Delete ${entry.name}`, icon: 'trash', iconOnly: true, small: true },
			async () => {
				await api.shareDelete(entry.path, folderRow);
				toast(`${entry.name} deleted`, 'ok');
				await load();
			},
		);
		rename.disabled = remove.disabled = !canWrite;
		return el('div', { class: 'rs-row', 'data-path': entry.path }, [
			open,
			el('span', { class: 'rs-size', text: folderRow ? '' : formatBytes(entry.size) }),
			el('span', { class: 'rs-when', text: entry.modified_at === null ? '' : relativeTime(entry.modified_at) }),
			el('span', { class: 'rs-actions' }, [
				...(folderRow
					? []
					: [iconButton('download', `Download ${entry.name}`, () =>
						void downloadFile(api.shareFilePath(entry.path), entry.name).catch((cause) =>
							toast(messageOf(cause), 'error')
						), { small: true })]),
				rename,
				remove,
			]),
		]);
	}

	async function load(): Promise<void> {
		try {
			const listing = await api.shareList(folder);
			list.removeAttribute('aria-busy');
			status.replaceChildren(...(listing.truncated ? [notice('The folder holds more entries than are listed.')] : []));
			const sorted = listing.entries.slice().sort((a, b) =>
				a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1
			);
			list.replaceChildren(
				...(sorted.length === 0
					? [empty('folder', 'No files yet', canWrite ? 'Upload files, or drop them here.' : '')]
					: sorted.map(row)),
			);
		} catch (cause) {
			list.replaceChildren();
			status.replaceChildren(notice(
				cause instanceof ApiError && cause.status === 403
					? 'This credential lacks files:read.'
					: `The file share is unavailable: ${messageOf(cause)}`,
			));
		}
	}

	// A drop anywhere on the list uploads into this folder.
	on(list, 'dragover', (event) => {
		if (canWrite) event.preventDefault();
	});
	on(list, 'drop', (event) => {
		event.preventDefault();
		const files = event.dataTransfer?.files;
		if (canWrite && files !== undefined && files.length > 0) {
			void upload([...files]).catch((cause) => toast(messageOf(cause), 'error'));
		}
	});

	mount(renderShell(navigate, {
		active: 'resources',
		title: 'Resources',
		actions: [newFolder, newFile, uploadBtn, picker],
	}, [crumbs, status, list]));
	void load();
}
