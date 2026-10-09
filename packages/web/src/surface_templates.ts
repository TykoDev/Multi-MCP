/**
 * The surface builder's gallery (run model-providers-ui, F4): five templates an operator fills in rather than
 * writing A2UI JSON by hand, each built from the v0.9 basic catalog in `packages/wire/src/a2ui.ts` and nothing else.
 *
 * Pure: a template turns a record of values into components (and, for the Form, an initial data model), and reads
 * the same values back from components it emitted, so Import can open a published or exported surface in the editor.
 * Component ids are fixed per template — that is what `extract` matches on — and every text is a plain string the
 * renderer shows as text (D-089: no markup, no markdown; the "Note" template is paragraphs, nothing more).
 */
import { A2UI_CATALOG_ID, type A2uiComponent, type A2uiMessage, type A2uiTheme } from '@tykotech/wire';
import type { IconName } from './icon_names.ts';

/** A button of the Status card: its label and the action name a click sends. */
export interface ButtonSpec {
	readonly label: string;
	readonly action: string;
}

/** What the editor holds for one template: strings, one-per-line lists, or button rows. */
export type TemplateValue = string | readonly string[] | readonly ButtonSpec[];
export type TemplateValues = Readonly<Record<string, TemplateValue>>;

/** One editor field of a template. */
export interface TemplateField {
	readonly key: string;
	readonly label: string;
	/** `text`: one line · `textarea`: paragraphs · `list`: one entry per line · `buttons`: label + action rows · `media`: a media URL. */
	readonly kind: 'text' | 'textarea' | 'list' | 'buttons' | 'media';
	/** One sentence, the field's tooltip and description. */
	readonly hint: string;
	readonly required?: boolean;
}

export interface SurfaceTemplate {
	readonly id: 'status' | 'form' | 'table' | 'image' | 'note';
	readonly name: string;
	readonly glyph: IconName;
	/** One sentence on the gallery card: what it is and what the catalog gives it. */
	readonly blurb: string;
	readonly fields: readonly TemplateField[];
	readonly defaults: TemplateValues;
	/** The components (and the Form's initial model) for `values`. Throws on a value it cannot place. */
	build(values: TemplateValues): { readonly components: A2uiComponent[]; readonly dataModel?: unknown };
	/** The values back from components this template emitted, or `null` when they are not its shape. */
	extract(components: readonly A2uiComponent[], dataModel: unknown): TemplateValues | null;
}

/** A 1×1 transparent PNG: the Image template's default, so the gallery's defaults always validate. */
export const PLACEHOLDER_PNG = 'data:image/png;base64,' +
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A data-model key from a label: lower-case words joined by `-`, or `<fallback>` when nothing is left. */
export function slug(label: string, fallback: string): string {
	const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return key === '' ? fallback : key;
}

function str(values: TemplateValues, key: string): string {
	const value = values[key];
	return typeof value === 'string' ? value : '';
}
function list(values: TemplateValues, key: string): string[] {
	const value = values[key];
	if (typeof value === 'string') return value.split('\n').map((line) => line.trim()).filter((line) => line !== '');
	if (!Array.isArray(value)) return [];
	return (value as readonly unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}
function buttons(values: TemplateValues, key: string): ButtonSpec[] {
	const value = values[key];
	if (!Array.isArray(value)) return [];
	return (value as readonly unknown[]).filter((entry): entry is ButtonSpec =>
		typeof entry === 'object' && entry !== null && typeof (entry as ButtonSpec).label === 'string' &&
		typeof (entry as ButtonSpec).action === 'string'
	).filter((entry) => entry.label !== '' && entry.action !== '');
}

type Of<K extends A2uiComponent['component']> = Extract<A2uiComponent, { component: K }>;

/** The component of one id and kind, or `null`. */
function find<K extends A2uiComponent['component']>(
	components: readonly A2uiComponent[],
	id: string,
	kind: K,
): Of<K> | null {
	const component = components.find((entry) => entry.id === id);
	return component !== undefined && component.component === kind ? component as Of<K> : null;
}
/** The static text of a Text or Button, `null` when it is a model binding. */
function textOf(value: string | { path: string } | undefined): string | null {
	return typeof value === 'string' ? value : null;
}
function textComponent(id: string, text: string, variant?: Of<'Text'>['variant']): Of<'Text'> {
	return variant === undefined ? { id, component: 'Text', text } : { id, component: 'Text', text, variant };
}

/** Numbered child ids (`prefix-0`, `prefix-1`, …) in order, stopping at the first gap; `null` if any is not `kind`. */
function numbered<K extends A2uiComponent['component']>(
	components: readonly A2uiComponent[],
	children: readonly string[],
	prefix: string,
	kind: K,
): Of<K>[] | null {
	const out: Of<K>[] = [];
	for (const [index, id] of children.entries()) {
		if (id !== `${prefix}-${index}`) return null;
		const component = find(components, id, kind);
		if (component === null) return null;
		out.push(component);
	}
	return out;
}

const STATUS: SurfaceTemplate = {
	id: 'status',
	name: 'Status card',
	glyph: 'surface',
	blurb: 'A card with a heading, a line of text and a row of buttons.',
	fields: [
		{ key: 'title', label: 'Title', kind: 'text', hint: 'The heading, drawn as an h2.', required: true },
		{ key: 'body', label: 'Text', kind: 'textarea', hint: 'The body text under the heading.' },
		{ key: 'buttons', label: 'Buttons', kind: 'buttons', hint: 'Each button sends its action name when clicked.' },
	],
	defaults: {
		title: 'Build finished',
		body: 'All 42 checks passed on main.',
		buttons: [{ label: 'Open docs', action: 'openDocs' }],
	},
	build(values) {
		const title = str(values, 'title').trim();
		if (title === '') throw new Error('Title is required');
		const rows = buttons(values, 'buttons');
		const children = [
			'title',
			...(str(values, 'body').trim() === '' ? [] : ['body']),
			...(rows.length ? ['actions'] : []),
		];
		const components: A2uiComponent[] = [
			{ id: 'root', component: 'Card', child: 'layout' },
			{ id: 'layout', component: 'Column', children },
			textComponent('title', title, 'h2'),
		];
		if (children.includes('body')) components.push(textComponent('body', str(values, 'body').trim()));
		if (rows.length) {
			components.push({ id: 'actions', component: 'Row', children: rows.map((_row, index) => `btn-${index}`) });
			rows.forEach((row, index) =>
				components.push({
					id: `btn-${index}`,
					component: 'Button',
					text: row.label,
					action: { event: { name: row.action, context: {} } },
				})
			);
		}
		return { components };
	},
	extract(components) {
		const root = find(components, 'root', 'Card');
		const layout = root?.child === 'layout' ? find(components, 'layout', 'Column') : null;
		const title = layout === null ? null : textOf(find(components, 'title', 'Text')?.text);
		if (layout === null || title === null || layout.children[0] !== 'title') return null;
		const body = layout.children.includes('body') ? textOf(find(components, 'body', 'Text')?.text) : '';
		const actions = layout.children.includes('actions') ? find(components, 'actions', 'Row') : null;
		const rows = actions === null ? [] : numbered(components, actions.children, 'btn', 'Button');
		if (body === null || rows === null) return null;
		const specs: ButtonSpec[] = [];
		for (const row of rows) {
			const label = textOf(row.text);
			if (label === null) return null;
			specs.push({ label, action: row.action.event.name });
		}
		return { title, body, buttons: specs };
	},
};

const FORM: SurfaceTemplate = {
	id: 'form',
	name: 'Form',
	glyph: 'file-pen',
	blurb: 'Text fields, a checkbox and a choice, bound to a data model, with one submit button.',
	fields: [
		{ key: 'title', label: 'Title', kind: 'text', hint: 'The heading, drawn as an h2.', required: true },
		{ key: 'inputs', label: 'Text fields', kind: 'list', hint: 'One label per line; each becomes a TextField.' },
		{ key: 'checkbox', label: 'Checkbox', kind: 'text', hint: 'A CheckBox label; leave empty for none.' },
		{ key: 'choiceLabel', label: 'Choice', kind: 'text', hint: 'A ChoicePicker label; leave empty for none.' },
		{ key: 'choices', label: 'Choice options', kind: 'list', hint: 'One option per line.' },
		{
			key: 'submitLabel',
			label: 'Submit button',
			kind: 'text',
			hint: 'The button that sends the values.',
			required: true,
		},
		{
			key: 'submitAction',
			label: 'Submit action',
			kind: 'text',
			hint: 'The action name the submit sends.',
			required: true,
		},
	],
	defaults: {
		title: 'Deployment request',
		inputs: ['Service', 'Version'],
		checkbox: 'Notify the channel',
		choiceLabel: 'Environment',
		choices: ['Staging', 'Production'],
		submitLabel: 'Request',
		submitAction: 'requestDeployment',
	},
	build(values) {
		const title = str(values, 'title').trim();
		if (title === '') throw new Error('Title is required');
		const submitLabel = str(values, 'submitLabel').trim();
		const submitAction = str(values, 'submitAction').trim();
		if (submitLabel === '' || submitAction === '') throw new Error('Submit button and action are required');
		const inputs = list(values, 'inputs');
		const checkbox = str(values, 'checkbox').trim();
		const choiceLabel = str(values, 'choiceLabel').trim();
		const choices = list(values, 'choices');
		const model: Record<string, unknown> = {};
		const context: Record<string, unknown> = {};
		const components: A2uiComponent[] = [textComponent('title', title, 'h2')];
		const children = ['title'];
		inputs.forEach((label, index) => {
			const key = slug(label, `field-${index}`);
			model[key] = '';
			context[key] = { path: `/${key}` };
			children.push(`field-${index}`);
			components.push({ id: `field-${index}`, component: 'TextField', label, value: { path: `/${key}` } });
		});
		if (checkbox !== '') {
			const key = slug(checkbox, 'confirmed');
			model[key] = false;
			context[key] = { path: `/${key}` };
			children.push('check');
			components.push({ id: 'check', component: 'CheckBox', label: checkbox, value: { path: `/${key}` } });
		}
		if (choiceLabel !== '' && choices.length) {
			const key = slug(choiceLabel, 'choice');
			model[key] = [];
			context[key] = { path: `/${key}` };
			children.push('choice');
			const seen = new Set<string>();
			components.push({
				id: 'choice',
				component: 'ChoicePicker',
				label: choiceLabel,
				options: choices.map((label, index) => {
					let value = slug(label, `option-${index}`);
					while (seen.has(value)) value = `${value}-${index}`;
					seen.add(value);
					return { label, value };
				}),
				value: { path: `/${key}` },
			});
		}
		children.push('submit');
		components.push({
			id: 'submit',
			component: 'Button',
			text: submitLabel,
			action: { event: { name: submitAction, context } },
		});
		components.unshift({ id: 'root', component: 'Column', children });
		return { components, dataModel: model };
	},
	extract(components) {
		const root = find(components, 'root', 'Column');
		const title = root === null ? null : textOf(find(components, 'title', 'Text')?.text);
		const submit = find(components, 'submit', 'Button');
		if (root === null || title === null || submit === null || root.children[0] !== 'title') return null;
		if (root.children.at(-1) !== 'submit') return null;
		const inputs: string[] = [];
		let checkbox = '';
		let choiceLabel = '';
		let choices: string[] = [];
		for (const id of root.children.slice(1, -1)) {
			if (/^field-\d+$/.test(id)) {
				const label = textOf(find(components, id, 'TextField')?.label);
				if (label === null) return null;
				inputs.push(label);
			} else if (id === 'check') {
				const label = textOf(find(components, 'check', 'CheckBox')?.label);
				if (label === null) return null;
				checkbox = label;
			} else if (id === 'choice') {
				const picker = find(components, 'choice', 'ChoicePicker');
				const label = textOf(picker?.label);
				if (picker === null || label === null) return null;
				const labels = picker.options.map((option) => textOf(option.label));
				if (labels.some((entry) => entry === null)) return null;
				choiceLabel = label;
				choices = labels as string[];
			} else return null;
		}
		const submitLabel = textOf(submit.text);
		if (submitLabel === null) return null;
		return { title, inputs, checkbox, choiceLabel, choices, submitLabel, submitAction: submit.action.event.name };
	},
};

/** The Table template's row separator: cells of one line, divided by `|`. */
const CELL = '|';

const TABLE: SurfaceTemplate = {
	id: 'table',
	name: 'Table',
	glyph: 'table',
	blurb: 'A heading row and rows of cells — the catalog has no table, so each row is a Row of Text.',
	fields: [
		{ key: 'title', label: 'Title', kind: 'text', hint: 'The heading above the table; leave empty for none.' },
		{ key: 'columns', label: 'Columns', kind: 'list', hint: 'One column heading per line.', required: true },
		{ key: 'rows', label: 'Rows', kind: 'textarea', hint: 'One row per line, cells separated by |.' },
	],
	defaults: {
		title: 'Open tasks',
		columns: ['Task', 'State', 'Owner'],
		rows: 'Rebuild the index | working | ada\nRotate the keys | done | grace',
	},
	build(values) {
		const columns = list(values, 'columns');
		if (columns.length === 0) throw new Error('At least one column is required');
		const title = str(values, 'title').trim();
		const rows = str(values, 'rows').split('\n').map((line) => line.trim()).filter((line) => line !== '')
			.map((line) => line.split(CELL).map((cell) => cell.trim()));
		const children = [...(title === '' ? [] : ['title']), 'head', ...rows.map((_row, index) => `row-${index}`)];
		const components: A2uiComponent[] = [{ id: 'root', component: 'Column', children }];
		if (title !== '') components.push(textComponent('title', title, 'h2'));
		components.push({ id: 'head', component: 'Row', children: columns.map((_column, index) => `head-${index}`) });
		columns.forEach((column, index) => components.push(textComponent(`head-${index}`, column, 'h5')));
		rows.forEach((cells, row) => {
			components.push({
				id: `row-${row}`,
				component: 'Row',
				children: cells.map((_cell, col) => `cell-${row}-${col}`),
			});
			cells.forEach((cell, col) => components.push(textComponent(`cell-${row}-${col}`, cell)));
		});
		return { components };
	},
	extract(components) {
		const root = find(components, 'root', 'Column');
		const head = find(components, 'head', 'Row');
		if (root === null || head === null || !root.children.includes('head')) return null;
		let title = '';
		const rest = [...root.children];
		if (rest[0] === 'title') {
			const text = textOf(find(components, 'title', 'Text')?.text);
			if (text === null) return null;
			title = text;
			rest.shift();
		}
		if (rest.shift() !== 'head') return null;
		const columns = numbered(components, head.children, 'head', 'Text')?.map((cell) => textOf(cell.text));
		if (columns === undefined || columns.some((cell) => cell === null)) return null;
		const lines: string[] = [];
		for (const [index, id] of rest.entries()) {
			if (id !== `row-${index}`) return null;
			const row = find(components, id, 'Row');
			const cells = row === null ? null : numbered(components, row.children, `cell-${index}`, 'Text');
			if (cells === null) return null;
			const texts = cells.map((cell) => textOf(cell.text));
			if (texts.some((cell) => cell === null)) return null;
			lines.push(texts.join(` ${CELL} `));
		}
		return { title, columns: columns as string[], rows: lines.join('\n') };
	},
};

const IMAGE: SurfaceTemplate = {
	id: 'image',
	name: 'Image + caption',
	glyph: 'image',
	blurb: 'One image from the file share or inline data, with a caption under it.',
	fields: [
		{
			key: 'url',
			label: 'Image',
			kind: 'media',
			hint: 'ttk://share/<path> for a file of the share, or a base64 data: URL (png, jpeg, gif, webp).',
			required: true,
		},
		{ key: 'description', label: 'Description', kind: 'text', hint: 'The alternative text for assistive technology.' },
		{ key: 'caption', label: 'Caption', kind: 'text', hint: 'The caption under the image; leave empty for none.' },
	],
	defaults: { url: PLACEHOLDER_PNG, description: 'A screenshot', caption: 'Captured by the agent' },
	build(values) {
		const url = str(values, 'url').trim();
		if (url === '') throw new Error('Image is required');
		const description = str(values, 'description').trim();
		const caption = str(values, 'caption').trim();
		const components: A2uiComponent[] = [
			{ id: 'root', component: 'Column', children: ['image', ...(caption === '' ? [] : ['caption'])] },
			{
				id: 'image',
				component: 'Image',
				url,
				...(description === '' ? {} : { description }),
				variant: 'mediumFeature',
			},
		];
		if (caption !== '') components.push(textComponent('caption', caption, 'caption'));
		return { components };
	},
	extract(components) {
		const root = find(components, 'root', 'Column');
		const image = find(components, 'image', 'Image');
		if (root === null || image === null || root.children[0] !== 'image' || root.children.length > 2) return null;
		const caption = root.children[1] === 'caption' ? textOf(find(components, 'caption', 'Text')?.text) : '';
		const description = image.description === undefined ? '' : textOf(image.description);
		if (caption === null || description === null) return null;
		if (root.children.length === 2 && root.children[1] !== 'caption') return null;
		return { url: image.url, description, caption };
	},
};

const NOTE: SurfaceTemplate = {
	id: 'note',
	name: 'Note',
	glyph: 'file-text',
	blurb: 'A heading and paragraphs of plain text — no markdown, the kit shows text as text.',
	fields: [
		{ key: 'title', label: 'Title', kind: 'text', hint: 'The heading, drawn as an h2; leave empty for none.' },
		{
			key: 'body',
			label: 'Paragraphs',
			kind: 'textarea',
			hint: 'Plain text; a blank line starts a new paragraph.',
			required: true,
		},
	],
	defaults: {
		title: 'Release notes',
		body: 'The index rebuilds nightly now.\n\nKeys rotate every 30 days; the next rotation is on Monday.',
	},
	build(values) {
		const paragraphs = str(values, 'body').split(/\n[ \t]*\n/).map((part) => part.trim()).filter((part) => part !== '');
		if (paragraphs.length === 0) throw new Error('Paragraphs are required');
		const title = str(values, 'title').trim();
		const children = [...(title === '' ? [] : ['title']), ...paragraphs.map((_part, index) => `p-${index}`)];
		const components: A2uiComponent[] = [{ id: 'root', component: 'Column', children }];
		if (title !== '') components.push(textComponent('title', title, 'h2'));
		paragraphs.forEach((part, index) => components.push(textComponent(`p-${index}`, part)));
		return { components };
	},
	extract(components) {
		const root = find(components, 'root', 'Column');
		if (root === null) return null;
		const rest = [...root.children];
		let title = '';
		if (rest[0] === 'title') {
			const text = textOf(find(components, 'title', 'Text')?.text);
			if (text === null) return null;
			title = text;
			rest.shift();
		}
		const paragraphs = numbered(components, rest, 'p', 'Text');
		if (paragraphs === null || paragraphs.length === 0) return null;
		const texts = paragraphs.map((part) => textOf(part.text));
		if (texts.some((part) => part === null)) return null;
		return { title, body: texts.join('\n\n') };
	},
};

/** The gallery, in the order it is shown. */
export const SURFACE_TEMPLATES: readonly SurfaceTemplate[] = [STATUS, FORM, TABLE, IMAGE, NOTE];

/** The messages that publish one filled template: create (with its theme), components, and the Form's model. */
export function templateMessages(
	template: SurfaceTemplate,
	surfaceId: string,
	values: TemplateValues,
	theme?: A2uiTheme,
): A2uiMessage[] {
	const built = template.build(values);
	return [
		{
			version: 'v0.9',
			createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID, ...(theme === undefined ? {} : { theme }) },
		},
		{ version: 'v0.9', updateComponents: { surfaceId, components: built.components } },
		...(built.dataModel === undefined
			? []
			: [{ version: 'v0.9' as const, updateDataModel: { surfaceId, value: built.dataModel } }]),
	];
}

/** What Import recovered from a set of messages: the template, its values, the surface id and theme. */
export interface TemplateMatch {
	readonly template: SurfaceTemplate;
	readonly surfaceId: string;
	readonly values: TemplateValues;
	readonly theme?: A2uiTheme;
}

/**
 * Reads validated messages back into the editor: the first template whose `extract` accepts the components wins.
 * `null` when no `updateComponents` is among them or no template recognises its shape (the Advanced tab then keeps
 * the raw JSON, which can still be published as it is).
 */
export function matchTemplate(messages: readonly A2uiMessage[]): TemplateMatch | null {
	let surfaceId: string | undefined;
	let theme: A2uiTheme | undefined;
	let components: readonly A2uiComponent[] | undefined;
	let dataModel: unknown;
	for (const message of messages) {
		if ('createSurface' in message) {
			surfaceId ??= message.createSurface.surfaceId;
			theme = message.createSurface.theme;
		} else if ('updateComponents' in message) {
			surfaceId ??= message.updateComponents.surfaceId;
			components = message.updateComponents.components;
		} else if ('updateDataModel' in message) {
			surfaceId ??= message.updateDataModel.surfaceId;
			if (message.updateDataModel.path === undefined) dataModel = message.updateDataModel.value;
		}
	}
	if (components === undefined || surfaceId === undefined) return null;
	for (const template of SURFACE_TEMPLATES) {
		const values = template.extract(components, dataModel);
		if (values !== null) {
			return theme === undefined ? { template, surfaceId, values } : { template, surfaceId, values, theme };
		}
	}
	return null;
}
