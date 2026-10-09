/**
 * A form generated from a JSON Schema: the Tools console's argument form, and the same renderer behind the task
 * composer's Run-tool fields and the configuration composer's settings (run model-providers-ui; moved here from
 * `tools_view.ts` unchanged).
 *
 * Anything the generator does not model falls back to a JSON editor rather than being dropped, so no argument is
 * ever unreachable. Every control is a kit field (or, for `session_id`, a native input with the live `<datalist>`),
 * named for assistive technology through its own `label` and `hint`; the visible head is the glyph, the name in
 * mono, the required mark and the description as a tooltip. `read()` returns what to send, omitting what is unset,
 * and throws a message naming the field on invalid input.
 */
import { el } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import type { JsonSchema } from './mcp.ts';
import { iconButton } from './ui.ts';

interface Field {
	readonly node: HTMLElement;
	/** Spans the whole form row (text areas, nested objects). */
	readonly wide?: boolean;
	/** A `<label for>` can name it; groups and fieldsets are named with `aria-labelledby` instead. */
	readonly labelable: boolean;
	/** The value to send, `undefined` to omit the argument. Throws on invalid input. */
	read(): unknown;
}

/** Unwraps `anyOf: [T, {type: 'null'}]`, which is how an optional-nullable field arrives. */
function simplify(schema: JsonSchema): JsonSchema {
	const variants = schema.anyOf ?? schema.oneOf;
	if (variants === undefined) return schema;
	const real = variants.filter((variant) => variant.type !== 'null');
	return real.length === 1 && real[0] !== undefined ? { description: schema.description, ...real[0] } : schema;
}

function typeOf(schema: JsonSchema): string | undefined {
	return Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
}

const LONG_TEXT = /script|expression|code|prompt|content|query|instruction|message|body|patch/;

/** The glyph a field's label leads with: what kind of value it takes, at a glance. */
function fieldGlyph(name: string, raw: JsonSchema): IconName {
	const schema = simplify(raw);
	const type = typeOf(schema);
	if (name === 'session_id') return 'sessions';
	if (schema.const !== undefined || type === 'boolean') return 'toggle';
	if (schema.enum !== undefined) return 'list-checks';
	if (type === 'integer' || type === 'number') return 'hash';
	if (type === 'array') return 'list';
	if (type === 'object') return 'braces';
	if (schema.format === 'uri' || /(^|_)(url|uri|href)$/.test(name)) return 'link';
	if (type === 'string') return LONG_TEXT.test(name) ? 'code' : 'type';
	return 'braces';
}

/**
 * Names a kit control for assistive technology. The kit renders its own label and hint inside the control; the
 * stylesheet hides both visually (the field's head is the visible label) but they stay its accessible name and
 * description.
 */
export function named<T extends HTMLElement>(control: T, name: string, required: boolean, description?: string): T {
	control.setAttribute('label', required ? `${name} (required)` : name);
	if (description !== undefined && description !== '') control.setAttribute('hint', description);
	control.classList.add('tc-kit');
	return control;
}

/** The value of a kit or native control, `null` when the kit has none. */
export function valueOf(control: { value: string | null }): string {
	return control.value ?? '';
}

function jsonField(id: string, name: string, schema: JsonSchema, required: boolean, description?: string): Field {
	const area = named(
		el('wa-textarea', {
			id,
			rows: 3,
			resize: 'vertical',
			class: 'tc-code',
			placeholder: schema.type === 'array' ? '[ … ]' : '{ … }',
		}),
		name,
		required,
		description,
	);
	return {
		node: area,
		wide: true,
		labelable: true,
		read() {
			const text = valueOf(area).trim();
			if (text === '') return undefined;
			try {
				return JSON.parse(text);
			} catch {
				throw new Error(`${id.replace(/^arg-/, '')}: not valid JSON`);
			}
		},
	};
}

/** true / false / omitted, as three glyphs: a boolean argument has three states, and a switch only shows two. */
function booleanField(id: string, schema: JsonSchema, required: boolean, description?: string): Field {
	let state: boolean | undefined = typeof schema.default === 'boolean' ? schema.default : undefined;
	const options: ReadonlyArray<readonly [boolean | undefined, IconName, string]> = [
		[undefined, 'circle-dashed', required ? 'Not set' : 'Default (omit)'],
		[true, 'check', 'true'],
		[false, 'x', 'false'],
	];
	const group = el('div', {
		id,
		class: 'segmented tc-tri',
		role: 'group',
		'aria-labelledby': `${id}-label`,
		'aria-describedby': description ? `${id}-info` : undefined,
	});
	const buttons = options.map(([value, glyph, label]) => {
		const node = iconButton(glyph, label, () => {
			state = value;
			paint();
		}, { small: true, tip: 'top' });
		node.classList.add(value === undefined ? 'unset' : value ? 'yes' : 'no');
		return node;
	});
	function paint(): void {
		buttons.forEach((node, index) => node.setAttribute('aria-pressed', String(options[index]?.[0] === state)));
	}
	paint();
	group.append(...buttons);
	return { node: group, labelable: false, read: () => state };
}

function fieldFor(id: string, name: string, raw: JsonSchema, required: boolean, description?: string): Field {
	const schema = simplify(raw);
	const type = typeOf(schema);

	if (schema.const !== undefined) {
		const box = el('wa-switch', { id, class: 'tc-switch' }, [
			el('span', { class: 'mono', text: `send ${JSON.stringify(schema.const)}` }),
		]);
		return { node: box, labelable: true, read: () => box.checked ? schema.const : undefined };
	}
	if (schema.enum === undefined && type === 'boolean') return booleanField(id, schema, required, description);
	if (schema.enum !== undefined || type === 'boolean') {
		const values = schema.enum ?? [true, false];
		// Optional (and boolean) fields can be left unset, which omits the argument; a required list starts on its first value.
		const optional = !required || type === 'boolean';
		let initial: string | undefined = optional ? undefined : '0';
		if (schema.default !== undefined) {
			const index = values.findIndex((value) => value === schema.default);
			if (index >= 0) initial = String(index);
		}
		const select = named(
			el('wa-select', {
				id,
				placeholder: required ? 'choose…' : 'default',
				'with-clear': optional,
				value: initial,
			}, values.map((value, index) => el('wa-option', { value: String(index), text: String(value) }))),
			name,
			required,
			description,
		);
		return {
			node: select,
			labelable: true,
			read() {
				const value = select.value;
				return typeof value === 'string' && value !== '' ? values[Number(value)] : undefined;
			},
		};
	}
	if (type === 'integer' || type === 'number') {
		const input = named(
			el('wa-input', {
				id,
				type: 'number',
				step: type === 'integer' ? 1 : 'any',
				min: schema.minimum,
				max: schema.maximum,
				placeholder: schema.default === undefined ? '' : `default ${schema.default}`,
			}),
			name,
			required,
			description,
		);
		return {
			node: input,
			labelable: true,
			read() {
				const text = valueOf(input).trim();
				if (text === '') return undefined;
				const value = Number(text);
				if (!Number.isFinite(value)) throw new Error(`${name}: not a number`);
				return value;
			},
		};
	}
	if (type === 'string') {
		const long = (schema.maxLength ?? 0) > 1000 || LONG_TEXT.test(name);
		let input: HTMLElement & { value: string | null };
		if (long) {
			input = named(el('wa-textarea', { id, rows: 3, resize: 'vertical' }), name, required, description);
		} else if (name === 'session_id') {
			// A native input, because only a native input offers the live session ids from a <datalist>.
			input = el('input', {
				id,
				type: 'text',
				class: 'tc-native',
				list: 'session-ids',
				placeholder: 'default',
				'aria-describedby': description ? `${id}-info` : undefined,
			});
		} else {
			input = named(
				el('wa-input', { id, type: 'text', placeholder: schema.format === 'uri' ? 'https://' : '' }),
				name,
				required,
				description,
			);
		}
		if (schema.maxLength !== undefined) input.setAttribute('maxlength', String(schema.maxLength));
		return {
			node: input,
			wide: long,
			labelable: true,
			read: () => (valueOf(input) === '' ? undefined : valueOf(input)),
		};
	}
	if (type === 'array' && schema.items !== undefined) {
		const itemType = typeOf(simplify(schema.items));
		if (itemType === 'string' || itemType === 'number' || itemType === 'integer') {
			const area = named(
				el('wa-textarea', { id, rows: 2, resize: 'vertical', placeholder: 'one value per line' }),
				name,
				required,
				description,
			);
			return {
				node: area,
				wide: true,
				labelable: true,
				read() {
					const lines = valueOf(area).split('\n').map((line) => line.trim()).filter((line) => line !== '');
					if (lines.length === 0) return undefined;
					return itemType === 'string' ? lines : lines.map(Number);
				},
			};
		}
	}
	if (type === 'object' && schema.properties !== undefined) {
		const nested = schemaForm(schema, `${id}-`);
		return {
			node: el('fieldset', { id, class: 'tc-nested', 'aria-labelledby': `${id}-label` }, [nested.node]),
			wide: true,
			labelable: false,
			read() {
				const value = nested.read();
				return Object.keys(value).length === 0 ? undefined : value;
			},
		};
	}
	return jsonField(id, name, schema, required, description);
}

/** A field's visible head: a type glyph and the argument name, a required mark, and the description as a tooltip. */
function fieldHead(
	id: string,
	name: string,
	schema: JsonSchema,
	required: boolean,
	field: Field,
	description?: string,
): HTMLElement {
	return el('div', { class: 'tc-field-head' }, [
		el('label', { id: `${id}-label`, class: 'tc-label', for: field.labelable ? id : undefined }, [
			icon(fieldGlyph(name, schema)),
			el('span', { class: 'mono', text: name }),
			...(required
				? [el('span', { class: 'tc-req', role: 'img', 'aria-label': 'required', 'data-tip': 'Required' })]
				: []),
		]),
		...(!description ? [] : [el('span', {
			id: `${id}-info`,
			class: 'tc-info',
			role: 'img',
			'aria-label': description,
			'data-tip': description,
			'data-tip-placement': 'top',
		}, [icon('info')])]),
	]);
}

/**
 * The form for an object schema: one field per property, in schema order, ids prefixed with `prefix`.
 * `read()` builds the argument object, omitting unset optional fields and throwing when a required one is empty.
 */
export function schemaForm(
	schema: JsonSchema,
	prefix: string,
): { node: HTMLElement; read(): Record<string, unknown> } {
	const required = new Set(schema.required ?? []);
	const fields: Array<[string, Field]> = [];
	const node = el('div', { class: 'tc-grid' });
	for (const [name, property] of Object.entries(schema.properties ?? {})) {
		const id = `${prefix}${name}`;
		const description = simplify(property).description ?? property.description;
		const field = fieldFor(id, name, property, required.has(name), description);
		node.append(
			el('div', { class: `tc-field${field.wide ? ' wide' : ''}` }, [
				fieldHead(id, name, property, required.has(name), field, description),
				field.node,
			]),
		);
		fields.push([name, field]);
	}
	return {
		node,
		read() {
			const value: Record<string, unknown> = {};
			for (const [name, field] of fields) {
				const read = field.read();
				if (read !== undefined) value[name] = read;
				else if (required.has(name)) throw new Error(`${name} is required`);
			}
			return value;
		},
	};
}
