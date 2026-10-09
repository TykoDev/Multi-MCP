/**
 * The editor drawers of the Resources screen: a skill (its SKILL.md and supporting files) and a stored prompt (title,
 * description, arguments, template, a render preview), each in a `wa-drawer` from the end edge, one at a time. A
 * prompt the server merely serves (`prompts/list`, such as `skill:<name>`) opens read-only, with what the server says
 * about it. Moved from the Library screen (D-075), which the Resources tree absorbed.
 *
 * Everything goes through the MCP tools the credential is served (`skill_*`, `prompt_*`). A credential without
 * `files:write` sees the write controls disabled, and the server refuses them anyway. Deletes confirm on the tree
 * leaf's row action or the card, never inside the drawer: the drawer is modal, and a popover outside it would be
 * inert.
 *
 * The small form helpers and the file-kind glyphs at the top are shared with the groups (`resources_files.ts`,
 * `resources_skills.ts`, `resources_prompts.ts`): the skill chips and the share tiles draw the same glyph for a kind.
 */
import type WaDrawer from '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';
import { getUser } from './api.ts';
import { clear, el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { invoke } from './mcp.ts';
import { busy, button, copyButton, empty, iconButton, messageOf, openModal, skeleton, toast } from './ui.ts';

export interface SkillSummary {
	name: string;
	description: string;
	files: string[];
	updated_at: string | null;
}
export interface Skill extends SkillSummary {
	instructions: string;
}
export interface PromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}
/** A prompt stored in the library: editable. */
export interface Prompt {
	name: string;
	title?: string;
	description?: string;
	arguments: PromptArgument[];
	template: string;
	updated_at: string;
}
/** A prompt as `prompts/list` serves it: what the server says, read-only here. */
export interface ServedPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: PromptArgument[];
}

/** What an editor needs from the group that opened it: the write gate, and whom to tell after a write. */
export interface EditorContext {
	readonly writable: boolean;
	/** The listing behind the drawer re-reads itself (a save or a create changed it). */
	changed(): Promise<void> | void;
}

// --- shared helpers ------------------------------------------------------------------

/** Calls an extension tool and unwraps its `{ result }` envelope. */
export async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const { result } = await invoke<{ result: T }>(name, args);
	return result;
}

export function canWrite(): boolean {
	return getUser()?.scopes.includes('files:write') === true;
}

export const READ_ONLY_REASON = 'Read-only: this credential lacks files:write';

export function textarea(id: string, value: string, rows = 14): HTMLTextAreaElement {
	const area = el('textarea', { id, class: 'mono editor lib-editor', rows, spellcheck: 'false' });
	area.value = value;
	return area;
}

/** A form field: a glyph and the input, with the label kept for assistive technology and shown as the tooltip. */
export function field(id: string, label: string, input: HTMLElement, glyph: IconName): HTMLElement {
	return el('div', { class: 'lib-field', 'data-tip': label }, [
		el('label', { for: id, class: 'sr-only', text: label }),
		el('span', { class: 'lib-field-glyph', 'aria-hidden': 'true' }, [icon(glyph)]),
		input,
	]);
}

export function formActions(...nodes: Node[]): HTMLElement {
	return el('div', { class: 'lib-form-actions' }, nodes);
}

/** A glyph that means something: its meaning is the accessible name and the tooltip. */
export function glyphTip(glyph: IconName, meaning: string, extra = ''): HTMLElement {
	return el('span', {
		class: `lib-glyph-tip ${extra}`.trim(),
		role: 'img',
		'aria-label': meaning,
		'data-tip': meaning,
	}, [icon(glyph)]);
}

/** A number beside a glyph (files in a skill, arguments of a prompt); the words are the tooltip. */
export function fact(glyph: IconName, value: string, meaning: string): HTMLElement {
	return el('span', { class: 'lib-fact', role: 'img', 'aria-label': meaning, 'data-tip': meaning }, [
		icon(glyph),
		el('span', { text: value }),
	]);
}

export function readOnlyMark(): HTMLElement {
	return glyphTip('lock', READ_ONLY_REASON, 'lib-ro');
}

/** Disables a control and puts the reason where a pointer can still find it: a disabled button takes no events. */
export function gate<T extends HTMLButtonElement>(control: T, reason: string): HTMLElement {
	control.disabled = true;
	return el('span', { class: 'rx-gate', 'data-tip': reason }, [control]);
}

// --- file kinds ---------------------------------------------------------------------

export type FileKind =
	| 'folder'
	| 'code'
	| 'json'
	| 'sheet'
	| 'image'
	| 'audio'
	| 'video'
	| 'archive'
	| 'text'
	| 'other';

export const KIND_GLYPHS: Readonly<Record<FileKind, IconName>> = {
	folder: 'folder',
	code: 'file-code',
	json: 'file-json',
	sheet: 'file-spreadsheet',
	image: 'file-image',
	audio: 'file-audio',
	video: 'file-video',
	archive: 'file-archive',
	text: 'file-text',
	other: 'file',
};

const EXTENSIONS: ReadonlyMap<string, FileKind> = new Map(
	([
		[
			'code',
			'ts tsx js jsx mjs cjs py rb go rs java kt kts c h cc cpp hpp cs php swift sh bash zsh fish ps1 sql html htm css ' +
			'scss sass less vue svelte lua r pl dart scala ex exs erl hs ml clj toml yaml yml ini cfg conf xml gradle mk',
		],
		['json', 'json jsonl ndjson json5 geojson ipynb'],
		['sheet', 'csv tsv xlsx xls ods'],
		['image', 'png jpg jpeg gif svg webp bmp ico avif tif tiff heic'],
		['audio', 'mp3 wav ogg oga flac m4a aac opus'],
		['video', 'mp4 webm mov mkv avi m4v ogv'],
		['archive', 'zip tar gz tgz bz2 xz 7z rar zst jar'],
		['text', 'md markdown txt log rst adoc org tex pdf rtf env lock'],
	] as Array<[FileKind, string]>).flatMap(([kind, list]) => list.split(' ').map((ext) => [ext, kind] as const)),
);

/** The kind of a file from its extension; no extension, or an unknown one, is `other`. */
export function kindOfName(name: string): FileKind {
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? 'other' : EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) ?? 'other';
}

// --- the drawer ---------------------------------------------------------------------

interface Drawer {
	readonly node: WaDrawer;
	readonly body: HTMLElement;
	readonly footer: HTMLElement;
	/** What the drawer shows (`skill:<name>`, `prompt:<name>`), so a delete can close it. */
	readonly key: string;
	title(text: string, glyph: IconName): void;
	close(): void;
}

let drawer: Drawer | null = null;
const closeListeners = new Set<(key: string) => void>();

/** Removes the open drawer at once (a newer one replaces it, or the screen is left). */
export function dropDrawer(): void {
	drawer?.node.remove();
	drawer = null;
}

/** Closes the drawer if it shows `key` (the thing it edits was just deleted). */
export function closeDrawerFor(key: string): void {
	if (drawer?.key === key) drawer.close();
}

/** Tells `listener` the key of every drawer that closes by itself (Escape, its button), until `until` is called. */
export function onDrawerClose(listener: (key: string) => void): () => void {
	closeListeners.add(listener);
	return () => closeListeners.delete(listener);
}

/** An editor drawer from the end edge; one at a time. Escape or its close button dismisses it. */
function openDrawer(title: string, glyph: IconName, key: string): Drawer {
	dropDrawer();
	const heading = el('span', { class: 'lib-drawer-title', slot: 'label' });
	const body = el('div', { class: 'lib-drawer-body' });
	const footer = el('div', { class: 'lib-drawer-foot', slot: 'footer' });
	const node = el('wa-drawer', { class: 'lib-drawer', label: title, placement: 'end' }, [heading, body, footer]);
	const handle: Drawer = {
		node,
		body,
		footer,
		key,
		title(text, mark) {
			node.label = text;
			heading.replaceChildren(
				el('span', { class: 'lib-drawer-glyph', 'aria-hidden': 'true' }, [icon(mark)]),
				el('span', { class: 'lib-drawer-name', text }),
			);
		},
		close() {
			node.open = false;
		},
	};
	handle.title(title, glyph);
	node.addEventListener('wa-after-hide', (event) => {
		// Kit overlays inside the drawer emit the same event; only the drawer's own ends it.
		if (event.target !== node) return;
		node.remove();
		if (drawer === handle) {
			drawer = null;
			for (const listener of closeListeners) listener(key);
		}
	});
	document.body.append(node);
	requestAnimationFrame(() => (node.open = true));
	drawer = handle;
	return handle;
}

// --- skills ---------------------------------------------------------------------------

/** Opens the editor drawer for the skill `name`, reading it first. */
export async function openSkill(name: string, editor: EditorContext): Promise<void> {
	const panel = openDrawer(name, 'skills', `skill:${name}`);
	panel.body.append(skeleton(4));
	try {
		const skill = await tool<Skill>('skill_get', { name });
		renderSkill(panel, skill, editor);
	} catch (cause) {
		panel.body.replaceChildren(empty('alert', 'Could not load skill', messageOf(cause)));
	}
}

function renderSkill(panel: Drawer, skill: Skill, editor: EditorContext, current = 'SKILL.md', text?: string): void {
	const { writable } = editor;
	panel.title(skill.name, 'skills');
	const area = textarea('skill-editor', text ?? skill.instructions, 22);
	area.readOnly = !writable;
	area.setAttribute('aria-label', current);

	const chips = el('div', { class: 'lib-chips', role: 'group', 'aria-label': 'Files of the skill' });
	for (const path of skill.files) {
		const chip = button({
			label: path,
			icon: path === 'SKILL.md' ? 'book' : KIND_GLYPHS[kindOfName(path)],
			small: true,
			variant: 'ghost',
		});
		chip.classList.add('lib-chip');
		chip.setAttribute('aria-pressed', String(path === current));
		on(chip, 'click', () =>
			void busy(chip, async () => {
				const file = path === 'SKILL.md'
					? { text: skill.instructions }
					: await tool<{ text: string }>('skill_read_file', { name: skill.name, path });
				renderSkill(panel, skill, editor, path, file.text);
			}).catch((cause) => toast(messageOf(cause), 'error')));
		chips.append(chip);
	}

	// Adding a file is an inline form: a dialog over the modal drawer would stack two modals.
	const fileInput = el('input', {
		type: 'text',
		id: 'skill-file',
		placeholder: 'reference.md',
		class: 'mono',
		autocomplete: 'off',
	});
	const addSubmit = iconButton('check', 'Add', undefined, { small: true, variant: 'primary', type: 'submit' });
	const addForm = el('form', { class: 'lib-inline', hidden: true }, [
		field('skill-file', 'File path inside the skill', fileInput, 'file-plus'),
		addSubmit,
	]);
	on(addForm, 'submit', (event) => {
		event.preventDefault();
		const path = fileInput.value.trim();
		void busy(addSubmit, async () => {
			const updated = await tool<Skill>('skill_put', { name: skill.name, files: { [path]: '' } });
			renderSkill(panel, updated, editor, path, '');
		}).catch((cause) => toast(messageOf(cause), 'error'));
	});
	const addFile = iconButton('file-plus', 'Add file', () => {
		addForm.hidden = !addForm.hidden;
		if (!addForm.hidden) fileInput.focus();
	}, { small: true });
	addFile.disabled = !writable;

	const save = button({ label: `Save ${current}`, icon: 'save', variant: 'primary', iconOnly: true, tip: 'top' });
	save.disabled = !writable;
	on(save, 'click', () =>
		void busy(save, async () => {
			const updated = await tool<Skill>('skill_put', { name: skill.name, files: { [current]: area.value } });
			toast(`${current} saved`, 'ok');
			renderSkill(panel, updated, editor, current, area.value);
			await editor.changed();
		}).catch((cause) => toast(messageOf(cause), 'error')));

	const promptName = `skill:${skill.name}`;
	panel.body.replaceChildren(
		...(skill.description === '' ? [] : [el('p', { class: 'lib-desc', text: skill.description })]),
		el('div', { class: 'lib-ident' }, [
			glyphTip('message', 'Served as an MCP prompt'),
			el('code', { class: 'mono grow', text: promptName }),
			copyButton(() => promptName, 'Copy prompt name'),
		]),
		el('div', { class: 'lib-row' }, [chips, addFile]),
		addForm,
		area,
	);
	panel.footer.replaceChildren(
		copyButton(() => area.value, 'Copy contents'),
		...(writable ? [] : [readOnlyMark()]),
		el('span', { class: 'grow' }),
		save,
	);
}

/** The "new skill" dialog: a name and a description scaffold a SKILL.md, and the editor opens on it. */
export function createSkill(editor: EditorContext): void {
	const name = el('input', {
		type: 'text',
		id: 'skill-name',
		placeholder: 'code-review',
		pattern: '[a-z0-9][a-z0-9._-]{0,63}',
		class: 'mono',
		autocomplete: 'off',
		autofocus: true,
	});
	const description = el('input', { type: 'text', id: 'skill-desc', placeholder: 'What the skill is for' });
	const submit = button({ label: 'Create skill', icon: 'plus', variant: 'primary', type: 'submit' });
	const form = el('form', { class: 'lib-form' }, [
		field('skill-name', 'Name (lowercase, digits, . _ -)', name, 'skills'),
		field('skill-desc', 'Description', description, 'info'),
		formActions(submit),
	]);
	const dialog = openModal('New skill', [form]);
	on(form, 'submit', (event) => {
		event.preventDefault();
		void busy(submit, async () => {
			const skillName = name.value.trim();
			const skill = await tool<Skill>('skill_put', {
				name: skillName,
				files: {
					'SKILL.md':
						`---\nname: ${skillName}\ndescription: ${description.value.trim()}\n---\n\n# ${skillName}\n\nInstructions go here.\n`,
				},
			});
			dialog.close();
			await editor.changed();
			renderSkill(openDrawer(skillName, 'skills', `skill:${skillName}`), skill, editor);
		}).catch((cause) => toast(messageOf(cause), 'error'));
	});
	name.focus();
}

// --- prompts --------------------------------------------------------------------------

interface ArgumentRow {
	readonly node: HTMLElement;
	readonly name: HTMLInputElement;
	readonly hint: HTMLInputElement;
	readonly required: WaSwitch;
}

/** Opens the editor drawer for a stored prompt. */
export function openPrompt(prompt: Prompt, editor: EditorContext): void {
	renderPrompt(openDrawer(prompt.title ?? prompt.name, 'prompt', `prompt:${prompt.name}`), prompt, editor);
}

/** Opens a read-only drawer for a prompt the server serves but the library does not store (`skill:<name>`). */
export function openServedPrompt(prompt: ServedPrompt): void {
	const panel = openDrawer(prompt.title ?? prompt.name, 'prompt', `prompt:${prompt.name}`);
	const args = prompt.arguments ?? [];
	panel.body.replaceChildren(
		el('div', { class: 'lib-ident' }, [
			glyphTip('message', 'Served as an MCP prompt'),
			el('code', { class: 'mono grow', text: prompt.name }),
			copyButton(() => prompt.name, 'Copy prompt name'),
		]),
		...(prompt.description === undefined || prompt.description === ''
			? []
			: [el('p', { class: 'lib-desc', text: prompt.description })]),
		el('section', { class: 'lib-section', 'aria-label': 'Arguments' }, [
			el('div', { class: 'lib-section-head' }, [
				glyphTip('braces', 'Arguments'),
				el('wa-badge', {
					class: 'lib-count',
					variant: 'neutral',
					appearance: 'filled',
					pill: true,
					text: String(args.length),
				}),
			]),
			args.length === 0 ? el('p', { class: 'lib-desc', text: 'Takes no arguments.' }) : el(
				'div',
				{ class: 'lib-args' },
				args.map((argument) =>
					el('div', { class: 'lib-arg lib-arg-read' }, [
						el('span', { class: 'lib-arg-glyph', 'aria-hidden': 'true' }, [icon('braces')]),
						el('code', { class: 'mono', text: argument.name }),
						el('span', { class: 'lib-desc', text: argument.description ?? '' }),
						...(argument.required === true ? [el('span', { class: 'lib-required-word', text: 'required' })] : []),
					])
				),
			),
		]),
		el('p', {
			class: 'lib-desc',
			text: 'The server serves this prompt; it is not stored in the library, so there is nothing to edit here.',
		}),
	);
	panel.footer.replaceChildren(glyphTip('lock', 'Served by the server: read-only', 'lib-ro'));
}

function renderPrompt(panel: Drawer, prompt: Prompt, editor: EditorContext): void {
	const { writable } = editor;
	panel.title(prompt.title ?? prompt.name, 'prompt');
	const title = el('input', { type: 'text', id: 'prompt-title', value: prompt.title ?? '', placeholder: 'Title' });
	const description = el('input', {
		type: 'text',
		id: 'prompt-desc',
		value: prompt.description ?? '',
		placeholder: 'Description',
	});

	// --- arguments ---
	const rows: ArgumentRow[] = [];
	const args = el('div', { class: 'lib-args' });
	const argCount = el('wa-badge', { class: 'lib-count', variant: 'neutral', appearance: 'filled', pill: true });
	const paintCount = (): void => {
		argCount.textContent = String(rows.length);
	};
	const addArg = (argument: PromptArgument = { name: '' }): void => {
		const name = el('input', {
			type: 'text',
			placeholder: 'name',
			value: argument.name,
			class: 'mono',
			'aria-label': 'Argument name',
			autocomplete: 'off',
		});
		const hint = el('input', {
			type: 'text',
			placeholder: 'description',
			value: argument.description ?? '',
			'aria-label': 'Argument description',
		});
		const required = el('wa-switch', { size: 'small', class: 'lib-required', 'data-tip': 'Required' }, [
			el('span', { class: 'sr-only', text: 'Required' }),
		]);
		required.checked = argument.required === true;
		const row: ArgumentRow = { node: el('div', { class: 'lib-arg' }), name, hint, required };
		const remove = iconButton('x', 'Remove argument', () => {
			row.node.remove();
			rows.splice(rows.indexOf(row), 1);
			paintCount();
		}, { small: true });
		name.readOnly = !writable;
		hint.readOnly = !writable;
		required.disabled = !writable;
		remove.disabled = !writable;
		row.node.append(
			el('span', { class: 'lib-arg-glyph', 'aria-hidden': 'true' }, [icon('braces')]),
			name,
			hint,
			required,
			remove,
		);
		rows.push(row);
		args.append(row.node);
		paintCount();
	};
	prompt.arguments.forEach((argument) => addArg(argument));
	paintCount();
	const addArgBtn = iconButton('plus', 'Add argument', () => addArg(), { small: true });
	const readArgs = (): PromptArgument[] =>
		rows.map((row) => ({
			name: row.name.value.trim(),
			...(row.hint.value.trim() === '' ? {} : { description: row.hint.value.trim() }),
			...(row.required.checked ? { required: true } : {}),
		})).filter((argument) => argument.name !== '');

	const template = textarea('prompt-template', prompt.template, 12);

	// --- save ---
	const save = button({ label: 'Save prompt', icon: 'save', variant: 'primary', iconOnly: true, tip: 'top' });
	on(save, 'click', () =>
		void busy(save, async () => {
			await tool('prompt_put', {
				name: prompt.name,
				...(title.value.trim() === '' ? {} : { title: title.value.trim() }),
				...(description.value.trim() === '' ? {} : { description: description.value.trim() }),
				arguments: readArgs(),
				template: template.value,
			});
			toast(`${prompt.name} saved`, 'ok');
			await editor.changed();
		}).catch((cause) => toast(messageOf(cause), 'error')));

	// --- preview: an inline form (a dialog over the modal drawer would stack two modals) ---
	const preview = el('pre', { class: 'code lib-preview', hidden: true, 'aria-live': 'polite' });
	const previewSlot = el('div', { class: 'lib-preview-slot' });
	const renderBtn = iconButton('play', 'Preview', () => {
		if (previewSlot.firstChild !== null) {
			clear(previewSlot);
			return;
		}
		const values: Record<string, string> = {};
		const inputs = readArgs().map((argument) => {
			const input = el('input', {
				type: 'text',
				id: `arg-${argument.name}`,
				placeholder: argument.description ?? '',
				autocomplete: 'off',
			});
			return { argument, input };
		});
		const submit = button({ label: 'Render', icon: 'play', variant: 'primary', type: 'submit', small: true });
		const form = el('form', { class: 'lib-preview-form' }, [
			...inputs.map(({ argument, input }) =>
				el('div', { class: 'lib-preview-field' }, [
					el('label', {
						for: `arg-${argument.name}`,
						class: 'mono',
						text: `${argument.name}${argument.required ? ' (required)' : ''}`,
					}),
					input,
				])
			),
			formActions(submit),
		]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				for (const { argument, input } of inputs) if (input.value !== '') values[argument.name] = input.value;
				const { text } = await tool<{ text: string }>('prompt_render', { name: prompt.name, arguments: values });
				clear(previewSlot);
				preview.textContent = text;
				preview.hidden = false;
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		previewSlot.replaceChildren(form);
		(inputs[0]?.input ?? submit).focus();
	}, { tip: 'top' });

	for (const control of [title, description]) control.readOnly = !writable;
	template.readOnly = !writable;
	for (const control of [save, addArgBtn]) control.disabled = !writable;

	const updated = el('wa-relative-time', { date: prompt.updated_at, format: 'narrow' });
	panel.body.replaceChildren(
		el('div', { class: 'lib-ident' }, [
			glyphTip('message', 'Served as an MCP prompt'),
			el('code', { class: 'mono grow', text: prompt.name }),
			copyButton(() => prompt.name, 'Copy prompt name'),
			el('span', { class: 'lib-when', 'data-tip': `Updated ${new Date(prompt.updated_at).toLocaleString()}` }, [
				icon('clock'),
				updated,
			]),
		]),
		el('div', { class: 'lib-grid2' }, [
			field('prompt-title', 'Title', title, 'tag'),
			field('prompt-desc', 'Description', description, 'info'),
		]),
		el('section', { class: 'lib-section', 'aria-label': 'Arguments' }, [
			el('div', { class: 'lib-section-head' }, [
				glyphTip('braces', 'Arguments'),
				argCount,
				el('span', { class: 'grow' }),
				addArgBtn,
			]),
			args,
		]),
		el('div', { class: 'lib-field lib-field-area', 'data-tip': 'Template ({{argument}} placeholders)' }, [
			el('label', { for: 'prompt-template', class: 'sr-only', text: 'Template ({{argument}} placeholders)' }),
			el('span', { class: 'lib-field-glyph', 'aria-hidden': 'true' }, [icon('code')]),
			template,
		]),
		previewSlot,
		preview,
	);
	panel.footer.replaceChildren(
		copyButton(() => template.value, 'Copy template'),
		renderBtn,
		...(writable ? [] : [readOnlyMark()]),
		el('span', { class: 'grow' }),
		save,
	);
}

/** The "new prompt" dialog: a name scaffolds a one-argument template, and the editor opens on it. */
export function createPrompt(editor: EditorContext): void {
	const name = el('input', {
		type: 'text',
		id: 'prompt-name',
		placeholder: 'summarise',
		pattern: '[a-z0-9][a-z0-9._-]{0,63}',
		class: 'mono',
		autocomplete: 'off',
		autofocus: true,
	});
	const submit = button({ label: 'Create prompt', icon: 'plus', variant: 'primary', type: 'submit' });
	const form = el('form', { class: 'lib-form' }, [
		field('prompt-name', 'Name (lowercase, digits, . _ -)', name, 'prompt'),
		formActions(submit),
	]);
	const dialog = openModal('New prompt', [form]);
	on(form, 'submit', (event) => {
		event.preventDefault();
		void busy(submit, async () => {
			const prompt = await tool<Prompt>('prompt_put', {
				name: name.value.trim(),
				arguments: [{ name: 'input', required: true }],
				template: 'Summarise the following:\n\n{{input}}\n',
			});
			dialog.close();
			await editor.changed();
			openPrompt(prompt, editor);
		}).catch((cause) => toast(messageOf(cause), 'error'));
	});
	name.focus();
}
