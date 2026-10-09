/**
 * The surface builder (run model-providers-ui, F4): a drawer that publishes an A2UI surface from a template —
 * Template · Edit · Preview, plus Advanced for the raw JSON — instead of a bare textarea.
 *
 * Lazy with `a2ui.ts` (the preview is the real renderer) and the wire schemas: nothing here is in the first paint.
 * Every message the builder publishes passes `A2uiMessageSchema`, `validateA2uiJson` (which holds `A2UI_MAX_BYTES`)
 * and `validateA2uiTree` first, so the server is never the first to see a malformed surface. The pure parts —
 * building, parsing, the theme — are exported for the unit tests; the drawer makes exactly one kind of request,
 * `publish`, and asks the action-name route once to say which buttons are bound. Where the one "New surface"
 * action lives is the screen's decision (`newSurfaceHome` in `task_composer.ts`, which is not lazy).
 */
import {
	A2UI_CATALOG_ID,
	type A2uiMessage,
	A2uiMessageSchema,
	type A2uiTheme,
	A2uiThemeSchema,
	validateA2uiJson,
	validateA2uiTree,
} from '@tykotech/wire';
import { clear, el, on } from './dom.ts';
import { icon } from './icons.ts';
import { releaseA2uiSurface, renderA2uiSurface } from './a2ui.ts';
import {
	type ButtonSpec,
	matchTemplate,
	SURFACE_TEMPLATES,
	type SurfaceTemplate,
	type TemplateField,
	templateMessages,
	type TemplateValue,
	type TemplateValues,
} from './surface_templates.ts';
import { button, confirmAt, copyText, empty, iconButton, messageOf, tag, tip, toast } from './ui.ts';

// --- pure ---------------------------------------------------------------------------------------------------------

/** `createSurface.surfaceId` as the wire accepts it. */
export const SURFACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** One message, checked the way the gateway will check it: schema, JSON confinement and size, then adjacency. */
function checked(message: unknown): A2uiMessage {
	const parsed = A2uiMessageSchema.safeParse(message);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue === undefined ? '' : issue.path.map(String).join('.');
		throw new Error(`Not a valid A2UI message${where === '' ? '' : ` (${where})`}: ${issue?.message ?? 'unknown'}`);
	}
	validateA2uiJson(parsed.data);
	if ('updateComponents' in parsed.data) validateA2uiTree(parsed.data.updateComponents.components);
	return parsed.data;
}

/** The messages that publish a filled template, each validated; throws with the first problem, naming it. */
export function buildSurfaceMessages(
	template: SurfaceTemplate,
	surfaceId: string,
	values: TemplateValues,
	theme?: A2uiTheme,
): A2uiMessage[] {
	if (!SURFACE_ID.test(surfaceId)) throw new Error('Surface id: letters, digits, _ and -, up to 128');
	return templateMessages(template, surfaceId, values, theme).map(checked);
}

/** The Advanced tab's text: one message, or an array of messages published in order; each validated. */
export function parseSurfaceMessages(text: string): A2uiMessage[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error('Not JSON');
	}
	const list = Array.isArray(raw) ? raw : [raw];
	if (list.length === 0) throw new Error('No message to publish');
	if (list.length > 16) throw new Error('At most 16 messages at once');
	return list.map(checked);
}

/** What the Theme group holds, as typed. */
export interface ThemeFields {
	readonly primaryColor: string;
	readonly font: string;
	readonly radius: string;
	readonly density: string;
}

/** The `createSurface.theme` for the fields, `undefined` when every one is empty; throws naming a bad value. */
export function themeOf(fields: ThemeFields): A2uiTheme | undefined {
	const theme: Record<string, unknown> = {};
	if (fields.primaryColor.trim() !== '') theme.primaryColor = fields.primaryColor.trim();
	if (fields.font !== '') theme.font = fields.font;
	if (fields.radius.trim() !== '') theme.radius = Number(fields.radius);
	if (fields.density !== '') theme.density = fields.density;
	if (Object.keys(theme).length === 0) return undefined;
	const parsed = A2uiThemeSchema.safeParse(theme);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new Error(`Theme ${issue?.path.map(String).join('.') ?? ''}: ${issue?.message ?? 'invalid'}`);
	}
	return parsed.data;
}

/** The fields back from a theme, for Import. */
export function themeFields(theme: A2uiTheme | undefined): ThemeFields {
	return {
		primaryColor: theme?.primaryColor ?? '',
		font: theme?.font ?? '',
		radius: theme?.radius === undefined ? '' : String(theme.radius),
		density: theme?.density ?? '',
	};
}

// --- the drawer ---------------------------------------------------------------------------------------------------

export interface SurfaceBuilderDeps {
	/** `POST /api/v1/a2ui/surfaces` with one message. */
	readonly publish: (message: unknown) => Promise<unknown>;
	/** `GET /api/v1/a2ui/actions`: the action names a button can be bound to. */
	readonly actionNames: () => Promise<string[]>;
	/** The share reader the preview hands the renderer for `ttk://share/` media (D-111). */
	readonly fetchShare?: (path: string, signal: AbortSignal) => Promise<Response>;
	/** After every message of a publish was accepted. */
	readonly onPublished: () => void;
}

type Tab = 'template' | 'edit' | 'preview' | 'advanced';
const TABS: ReadonlyArray<readonly [Tab, string]> = [
	['template', 'Template'],
	['edit', 'Edit'],
	['preview', 'Preview'],
	['advanced', 'Advanced'],
];

/** The raw JSON textarea's id: kept from the previous publish form, which the e2e drives by it. */
const RAW_ID = 'a2ui-publish';

/** A kit text control: `wa-input` or `wa-textarea` as a `tc-kit` field with its label and hint for the kit. */
function control(tag: 'wa-input' | 'wa-textarea', id: string, label: string, hint: string, value: string): HTMLElement {
	const node = el(tag, { id, label, hint, class: 'tc-kit ag-builder-control', value });
	if (tag === 'wa-textarea') {
		node.setAttribute('rows', '4');
		node.setAttribute('resize', 'vertical');
	}
	return node;
}

/** A field's visible head: its label (for the control) and its hint as a tooltip. */
function head(id: string, label: string, hint: string, required: boolean): HTMLElement {
	return el('div', { class: 'tc-field-head' }, [
		el('label', { class: 'tc-label', for: id }, [el('span', { text: label })]),
		...(required
			? [el('span', { class: 'tc-req', role: 'img', 'aria-label': 'required', 'data-tip': 'Required' })]
			: []),
		tip(el('span', { class: 'tc-info', tabindex: 0, role: 'img', 'aria-label': hint }, [icon('info')]), hint, 'top'),
	]);
}

/** Opens the builder; one at a time. Returns the drawer node and a way to close it. */
export function openSurfaceBuilder(deps: SurfaceBuilderDeps): { node: HTMLElement; close(): void } {
	let template: SurfaceTemplate | null = null;
	let names: string[] = [];
	let dirty = false;
	let leaving = false;
	let active: Tab = 'template';
	let serial = 0;

	const status = el('p', { class: 'ag-builder-status', role: 'status', 'aria-live': 'polite' });
	const say = (text: string): void => {
		status.textContent = text;
	};

	// --- Template: a gallery of radio tiles, one per template ------------------------------------------------------
	const gallery = el('div', { class: 'ag-templates', role: 'radiogroup', 'aria-label': 'Surface template' });
	const radios: HTMLInputElement[] = [];
	for (const entry of SURFACE_TEMPLATES) {
		const id = `ag-template-${entry.id}`;
		const radio = el('input', { type: 'radio', name: 'ag-template', id, value: entry.id, class: 'ag-template-pick' });
		radios.push(radio);
		const card = el('label', { class: 'ag-template', for: id, 'data-template': entry.id }, [
			radio,
			el('span', { class: 'ag-template-glyph', 'aria-hidden': 'true' }, [icon(entry.glyph)]),
			el('span', { class: 'ag-template-name', text: entry.name }),
			el('span', { class: 'ag-template-blurb', text: entry.blurb }),
		]);
		on(radio, 'change', () => {
			if (radio.checked) choose(entry, undefined, undefined, undefined);
		});
		gallery.append(card);
	}

	// --- Edit: the surface id, the template's fields, the theme ----------------------------------------------------
	const surfaceId = el('wa-input', {
		id: 'ag-surface-id',
		label: 'Surface id',
		hint: 'Letters, digits, _ and -, up to 128',
		class: 'tc-kit ag-builder-control mono',
		maxlength: 128,
	});
	const fieldsNode = el('div', { class: 'tc-grid ag-fields' });
	const readers = new Map<string, () => TemplateValue>();
	const writers = new Map<string, (value: TemplateValue) => void>();
	const themeControls = {
		primaryColor: el('wa-input', {
			id: 'ag-theme-color',
			label: 'Primary colour',
			hint: '#rrggbb; empty keeps the shell colour',
			class: 'tc-kit ag-builder-control mono',
			placeholder: '#2a9d8f',
			maxlength: 7,
		}),
		font: el('wa-select', {
			id: 'ag-theme-font',
			label: 'Font',
			class: 'tc-kit ag-builder-control',
			'with-clear': true,
		}, [
			el('wa-option', { value: 'sans', text: 'sans' }),
			el('wa-option', { value: 'serif', text: 'serif' }),
			el('wa-option', { value: 'mono', text: 'mono' }),
		]),
		radius: el('wa-input', {
			id: 'ag-theme-radius',
			label: 'Radius',
			hint: '0 to 24 pixels',
			type: 'number',
			min: 0,
			max: 24,
			class: 'tc-kit ag-builder-control',
		}),
		density: el('wa-select', {
			id: 'ag-theme-density',
			label: 'Density',
			class: 'tc-kit ag-builder-control',
			'with-clear': true,
		}, [
			el('wa-option', { value: 'compact', text: 'compact' }),
			el('wa-option', { value: 'comfortable', text: 'comfortable' }),
		]),
	};
	const themeNode = el('wa-details', { class: 'ag-theme', appearance: 'plain', 'icon-placement': 'start' }, [
		el('span', { slot: 'summary', class: 'ag-more-summary' }, [icon('settings'), el('span', { text: 'Theme' })]),
		el('div', { class: 'tc-grid' }, [
			el('div', { class: 'tc-field' }, [
				head('ag-theme-color', 'Primary colour', '#rrggbb; empty keeps the shell colour', false),
				themeControls.primaryColor,
			]),
			el('div', { class: 'tc-field' }, [
				head('ag-theme-font', 'Font', 'sans, serif or mono', false),
				themeControls.font,
			]),
			el('div', { class: 'tc-field' }, [
				head('ag-theme-radius', 'Radius', '0 to 24 pixels', false),
				themeControls.radius,
			]),
			el('div', { class: 'tc-field' }, [
				head('ag-theme-density', 'Density', 'compact or comfortable', false),
				themeControls.density,
			]),
		]),
	]);
	const editEmpty = empty('template', 'Pick a template first', 'The Template tab lists five.');
	const editNode = el('div', { class: 'ag-editor' }, [editEmpty]);

	const value = (node: { value: unknown }): string => typeof node.value === 'string' ? node.value : '';
	function readTheme(): A2uiTheme | undefined {
		return themeOf({
			primaryColor: value(themeControls.primaryColor),
			font: value(themeControls.font),
			radius: value(themeControls.radius),
			density: value(themeControls.density),
		});
	}
	function readValues(): TemplateValues {
		const values: Record<string, TemplateValue> = {};
		for (const [key, read] of readers) values[key] = read();
		return values;
	}
	function current(): A2uiMessage[] {
		if (template === null) throw new Error('Pick a template first');
		return buildSurfaceMessages(template, value(surfaceId).trim(), readValues(), readTheme());
	}

	/** One button row of a `buttons` field: label, action (with the bound names offered), remove. */
	function buttonRow(list: HTMLElement, spec: ButtonSpec, update: () => void): void {
		const serialOf = ++serial;
		const label = el('wa-input', {
			label: 'Button label',
			class: 'tc-kit ag-builder-control',
			placeholder: 'Label',
			value: spec.label,
			maxlength: 256,
		});
		const action = el('wa-input', {
			label: 'Action name',
			class: 'tc-kit ag-builder-control mono',
			placeholder: 'action name',
			value: spec.action,
			list: `ag-actions-${serialOf}`,
			maxlength: 128,
		});
		const datalist = el(
			'datalist',
			{ id: `ag-actions-${serialOf}` },
			names.map((name) => el('option', { value: name })),
		);
		const bound = el('span', { class: 'ag-bound' });
		const paint = (): void => {
			const name = value(action).trim();
			bound.replaceChildren(
				name === '' ? '' : names.includes(name) ? tag('bound', 'check', 'live') : tip(
					tag('not bound', 'circle-dashed'),
					'No server action has this name; the button will stay disabled',
					'top',
				),
			);
		};
		on(action, 'input', paint);
		paint();
		const remove = iconButton('x', 'Remove button', () => {
			row.remove();
			update();
		}, { small: true });
		const row = el('div', { class: 'ag-button-row' }, [label, action, datalist, bound, remove]);
		list.append(row);
	}

	function fieldNode(field: TemplateField, initial: TemplateValue): HTMLElement {
		const id = `ag-field-${field.key}`;
		const wide = field.kind !== 'text';
		let node: HTMLElement;
		if (field.kind === 'buttons') {
			const list = el('div', { class: 'ag-button-rows', id, role: 'group', 'aria-label': field.label });
			const rows = (): HTMLElement[] => Array.from(list.children) as HTMLElement[];
			const update = (): void => {
				dirty = true;
			};
			const specs = Array.isArray(initial) ? initial as readonly ButtonSpec[] : [];
			for (const spec of specs) if (typeof spec === 'object') buttonRow(list, spec, update);
			const add = button({ label: 'Add button', icon: 'plus', variant: 'ghost', small: true });
			on(add, 'click', () => {
				buttonRow(list, { label: '', action: '' }, update);
				dirty = true;
			});
			readers.set(field.key, () =>
				rows().map((row) => {
					const inputs = Array.from(row.children).filter((child) => child.tagName === 'WA-INPUT') as Array<
						HTMLElement & { value: string }
					>;
					return { label: (inputs[0]?.value ?? '').trim(), action: (inputs[1]?.value ?? '').trim() };
				}));
			writers.set(field.key, (next) => {
				clear(list);
				for (const spec of Array.isArray(next) ? next as readonly ButtonSpec[] : []) buttonRow(list, spec, update);
			});
			node = el('div', { class: 'ag-buttons-field' }, [list, add]);
		} else {
			const tag = field.kind === 'text' || field.kind === 'media' ? 'wa-input' : 'wa-textarea';
			const text = typeof initial === 'string' ? initial : (initial as readonly string[]).join('\n');
			const input = control(tag, id, field.label, field.hint, text) as HTMLElement & { value: string };
			if (field.kind === 'media') input.classList.add('mono');
			readers.set(field.key, () => field.kind === 'list' ? input.value.split('\n') : input.value);
			writers.set(field.key, (next) => {
				input.value = typeof next === 'string' ? next : (next as readonly string[]).join('\n');
			});
			node = input;
		}
		return el('div', { class: `tc-field${wide ? ' wide' : ''}` }, [
			head(id, field.label, field.hint, field.required === true),
			node,
		]);
	}

	/** Shows a template in the editor with `values` (its defaults when none) and moves to Edit. */
	function choose(
		entry: SurfaceTemplate,
		values: TemplateValues | undefined,
		id: string | undefined,
		theme: A2uiTheme | undefined,
	): void {
		template = entry;
		const radio = radios.find((node) => node.value === entry.id);
		if (radio !== undefined) radio.checked = true;
		readers.clear();
		writers.clear();
		clear(fieldsNode);
		const filled = values ?? entry.defaults;
		for (const field of entry.fields) fieldsNode.append(fieldNode(field, filled[field.key] ?? ''));
		surfaceId.value = id ?? `${entry.id}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
		const fields = themeFields(theme);
		themeControls.primaryColor.value = fields.primaryColor;
		themeControls.font.value = fields.font;
		themeControls.radius.value = fields.radius;
		themeControls.density.value = fields.density;
		editNode.replaceChildren(
			el('div', { class: 'ag-editor-head' }, [
				el('span', { class: 'ag-editor-glyph', 'aria-hidden': 'true' }, [icon(entry.glyph)]),
				el('span', { class: 'ag-editor-name', text: entry.name }),
				el('span', { class: 'ag-editor-blurb', text: entry.blurb }),
			]),
			el('div', { class: 'tc-field wide' }, [
				head('ag-surface-id', 'Surface id', 'Letters, digits, _ and -, up to 128', true),
				surfaceId,
			]),
			fieldsNode,
			themeNode,
		);
		publish.disabled = false;
		relabelPublish();
		say(`${entry.name}: fill in the fields, then Publish.`);
		show('edit');
	}

	// --- Preview: the real renderer over the current build ---------------------------------------------------------
	const previewNode = el('div', { class: 'ag-preview' });
	let previewed: HTMLElement | null = null;
	function renderPreview(): void {
		if (previewed !== null) releaseA2uiSurface(previewed);
		previewed = null;
		clear(previewNode);
		if (template === null) {
			previewNode.append(empty('template', 'Nothing to preview yet', 'Pick a template first.'));
			return;
		}
		try {
			const messages = current();
			const components = messages.flatMap((message) =>
				'updateComponents' in message ? message.updateComponents.components : []
			);
			const model = messages.find((message) => 'updateDataModel' in message);
			const created = messages.find((message) => 'createSurface' in message);
			const rendered = renderA2uiSurface(
				{
					surfaceId: value(surfaceId).trim() || 'preview',
					catalogId: A2UI_CATALOG_ID,
					revision: 1,
					components,
					dataModel: model !== undefined && 'updateDataModel' in model ? model.updateDataModel.value : {},
					...(created !== undefined && 'createSurface' in created && created.createSurface.theme !== undefined
						? { theme: created.createSurface.theme }
						: {}),
				},
				() => Promise.resolve(),
				{ fetchShare: deps.fetchShare },
			);
			previewed = rendered;
			previewNode.append(
				tip(
					el('p', { class: 'ag-preview-note', text: 'Buttons come alive once published and bound.' }),
					'A preview sends nothing; a published button is enabled when the server has an action of its name',
					'top',
				),
				rendered,
			);
		} catch (cause) {
			previewNode.append(
				el('wa-callout', { variant: 'danger', appearance: 'filled-outlined', size: 's', text: messageOf(cause) }),
			);
		}
	}

	// --- Advanced: the raw JSON, Import and Export ------------------------------------------------------------------
	const raw = el('textarea', {
		id: RAW_ID,
		rows: 12,
		maxlength: 262144,
		class: 'mono ag-raw',
		spellcheck: 'false',
		placeholder: '{ "version": "v0.9", "createSurface": { … } }  — one message, or an array of messages',
		'aria-label': 'Surface messages as JSON (requires a2ui:publish)',
	});
	on(raw, 'input', () => {
		dirty = true;
	});
	const importButton = button({ label: 'Import', icon: 'upload', variant: 'ghost', small: true });
	tip(importButton, 'Read the JSON into the editor when it matches a template', 'top');
	on(importButton, 'click', () => {
		try {
			const messages = parseSurfaceMessages(raw.value);
			const match = matchTemplate(messages);
			if (match === null) {
				say('Valid, but not one of the templates: publish it from here.');
				return;
			}
			choose(match.template, match.values, match.surfaceId, match.theme);
			say(`Imported as ${match.template.name}.`);
		} catch (cause) {
			say(messageOf(cause));
			toast(messageOf(cause), 'error');
		}
	});
	const exportButton = button({ label: 'Export', icon: 'download', variant: 'ghost', small: true });
	tip(exportButton, 'Write the editor’s messages here and copy them', 'top');
	on(exportButton, 'click', () => {
		try {
			const text = JSON.stringify(current(), null, 2);
			raw.value = text;
			void copyText(text).then(() => say('Exported and copied.')).catch(() => say('Exported.'));
		} catch (cause) {
			say(messageOf(cause));
			toast(messageOf(cause), 'error');
		}
	});
	const advancedNode = el('div', { class: 'ag-advanced' }, [
		el('label', { class: 'sr-only', for: RAW_ID, text: 'Surface messages as JSON' }),
		raw,
		el('div', { class: 'ag-advanced-bar' }, [
			tip(
				el('span', { class: 'ag-hint' }, [icon('braces'), el('span', { text: 'A2UI v0.9' })]),
				'One message or an array; each must pass the A2UI v0.9 schema and the size limit',
				'top',
			),
			el('span', { class: 'grow' }),
			importButton,
			exportButton,
		]),
	]);

	// --- the drawer: tabs, footer, publish ------------------------------------------------------------------------
	const group = el('wa-tab-group', { class: 'ag-builder-tabs', active: 'template' }, [
		...TABS.map(([name, label]) => el('wa-tab', { panel: name, class: 'ag-builder-tab', text: label })),
		el('wa-tab-panel', { name: 'template', class: 'ag-builder-panel' }, [
			el('p', {
				class: 'ag-builder-lead',
				text: 'Pick what the surface is; each template is built from the v0.9 catalog.',
			}),
			gallery,
		]),
		el('wa-tab-panel', { name: 'edit', class: 'ag-builder-panel' }, [editNode]),
		el('wa-tab-panel', { name: 'preview', class: 'ag-builder-panel' }, [previewNode]),
		el('wa-tab-panel', { name: 'advanced', class: 'ag-builder-panel' }, [advancedNode]),
	]) as HTMLElement & { active: string };
	/** The tab's side effects: the preview is drawn when reached; the footer's primary names what it publishes. */
	function activate(tab: Tab): void {
		active = tab;
		if (tab === 'preview') renderPreview();
		relabelPublish();
	}
	function show(tab: Tab): void {
		group.active = tab;
		activate(tab);
	}
	group.addEventListener('wa-tab-show', (event) => {
		if (event.target !== group) return;
		const name = (event as Event & { detail?: { name?: string } }).detail?.name;
		if (name === 'template' || name === 'edit' || name === 'preview' || name === 'advanced') activate(name);
	});
	on(editNode, 'input', () => {
		dirty = true;
	});

	const cancel = button({ label: 'Cancel', variant: 'ghost', small: true });
	const publish = button({ label: 'Publish', icon: 'upload', variant: 'primary', small: true });
	publish.disabled = true;
	function relabelPublish(): void {
		const span = publish.querySelector(':scope > span.label');
		if (span !== null) span.textContent = active === 'advanced' ? 'Publish JSON' : 'Publish';
		if (active === 'advanced') publish.disabled = false;
		else publish.disabled = template === null;
	}
	const heading = el('span', { class: 'ag-builder-title', slot: 'label' }, [
		el('span', { class: 'ag-builder-title-glyph', 'aria-hidden': 'true' }, [icon('template')]),
		el('span', { class: 'ag-builder-title-name', text: 'New surface' }),
	]);
	const footer = el('div', { class: 'ag-builder-foot', slot: 'footer' }, [
		status,
		el('span', { class: 'grow' }),
		cancel,
		publish,
	]);
	const node = el('wa-drawer', { class: 'ag-builder', label: 'New surface', placement: 'end' }, [
		heading,
		el('div', { class: 'ag-builder-body' }, [group]),
		footer,
	]) as HTMLElement & { open: boolean };

	async function doPublish(): Promise<void> {
		let messages: A2uiMessage[];
		try {
			messages = active === 'advanced' ? parseSurfaceMessages(raw.value) : current();
		} catch (cause) {
			say(messageOf(cause));
			toast(messageOf(cause), 'error');
			return;
		}
		publish.disabled = true;
		cancel.disabled = true;
		try {
			for (const [index, message] of messages.entries()) {
				say(`Publishing ${index + 1} of ${messages.length}…`);
				await deps.publish(message);
			}
			dirty = false;
			leaving = true;
			toast(
				messages.length === 1 ? 'Surface message published' : `Surface published (${messages.length} messages)`,
				'ok',
			);
			deps.onPublished();
			node.open = false;
		} catch (cause) {
			say(messageOf(cause));
			toast(messageOf(cause), 'error');
		} finally {
			cancel.disabled = false;
			relabelPublish();
		}
	}
	on(publish, 'click', () => void doPublish());
	on(cancel, 'click', () => {
		node.open = false;
	});
	// An unsaved edit asks before the drawer goes: `wa-hide` is cancellable, whatever asked for the close.
	node.addEventListener('wa-hide', (event) => {
		if (event.target !== node || leaving || !dirty) return;
		event.preventDefault();
		void confirmAt(cancel, 'Discard this surface?', 'trash').then((yes) => {
			if (!yes) return;
			leaving = true;
			node.open = false;
		});
	});
	/**
	 * BUG-2: the drawer's end, whoever brought it — the kit's `wa-after-hide` after a close, or the screen's `stop()`
	 * while it is still open (or not yet opened: the opening frame is pending). Releases the preview's object URLs
	 * and takes the node out of `document.body`; idempotent, so both paths may run.
	 */
	let disposed = false;
	function dispose(): void {
		if (disposed) return;
		disposed = true;
		if (previewed !== null) releaseA2uiSurface(previewed);
		previewed = null;
		node.remove();
	}
	node.addEventListener('wa-after-hide', (event) => {
		if (event.target !== node) return;
		dispose();
	});
	document.body.append(node);
	requestAnimationFrame(() => {
		if (!disposed) node.open = true;
	});
	void deps.actionNames().then((list) => {
		names = [...list].sort();
		for (const datalist of node.querySelectorAll('datalist')) {
			datalist.replaceChildren(...names.map((name) => el('option', { value: name })));
		}
		for (const action of node.querySelectorAll('.ag-button-row wa-input:nth-of-type(2)')) {
			action.dispatchEvent(new Event('input'));
		}
	}).catch(() => {
		names = [];
	});
	return {
		node,
		/** Closes without asking (the screen is leaving) and releases the drawer at once. */
		close() {
			leaving = true;
			node.open = false;
			dispose();
		},
	};
}
