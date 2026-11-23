/**
 * Browser-safe A2UI v0.9: the basic catalog, the TykoTech `Html` extension, surface themes and their confinement
 * rules. Nothing here names a network location the browser would fetch on its own: media is inline `data:` of a fixed
 * MIME allowlist or a `ttk://share/<path>` the SPA reads through its authenticated API, and `Html` is only ever a
 * document served by its own route under a `sandbox` CSP into an `<iframe sandbox>`.
 */
import * as z from 'zod';

export const A2UI_CATALOG_ID = 'https://tykotech.eu/a2ui/catalog/v0.9';
export const A2UI_MAX_BYTES = 256 * 1024;
/** Largest inline (`data:`) media URL; base64 is ASCII, so characters are bytes. */
export const A2UI_MEDIA_MAX_BYTES = 256 * 1024;
/** Largest `Html` document, in UTF-8 bytes. */
const A2UI_HTML_MAX_BYTES = 128 * 1024;
const A2UI_SHARE_PREFIX = 'ttk://share/';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Fixed MIME subtypes per media kind: an `image/svg+xml` data URL is a document that can carry script. */
const A2UI_MEDIA_TYPES = {
	image: ['png', 'jpeg', 'gif', 'webp'],
	video: ['mp4', 'webm', 'ogg'],
	audio: ['mpeg', 'mp4', 'ogg', 'wav', 'webm'],
} as const;
export type A2uiMediaKind = keyof typeof A2UI_MEDIA_TYPES;
/** Where a media component's bytes come from. */
export type A2uiMediaSource = { readonly kind: 'data'; readonly mime: string } | {
	readonly kind: 'share';
	readonly path: string;
};

/**
 * A base64 `data:` URL of an allowed type within {@linkcode A2UI_MEDIA_MAX_BYTES}, or `ttk://share/<path>` whose
 * decoded segments are plain names (no `.`/`..`, separators or control characters). Throws for anything else.
 */
export function parseA2uiMediaUrl(url: string, kind: A2uiMediaKind): A2uiMediaSource {
	if (url.startsWith(A2UI_SHARE_PREFIX)) {
		const raw = url.slice(A2UI_SHARE_PREFIX.length);
		if (raw === '' || raw.length > 4096) throw new Error('Invalid share path');
		const segments = raw.split('/').map((segment) => {
			let decoded: string;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				throw new Error('Invalid share path');
			}
			// deno-lint-ignore no-control-regex
			if (decoded === '' || decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) {
				throw new Error('Invalid share path');
			}
			return decoded;
		});
		return { kind: 'share', path: segments.join('/') };
	}
	if (url.length > A2UI_MEDIA_MAX_BYTES) throw new Error('A2UI media exceeds its size limit');
	const match = /^data:([a-z]+)\/([a-z0-9.+-]+);base64,/.exec(url);
	if (match === null || match[1] !== kind || !(A2UI_MEDIA_TYPES[kind] as readonly string[]).includes(match[2]!)) {
		throw new Error(`A2UI ${kind} must be a data: URL of an allowed type or a ttk://share/ path`);
	}
	const payload = url.slice(match[0].length);
	if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
		throw new Error('A2UI media is not valid base64');
	}
	return { kind: 'data', mime: `${match[1]}/${match[2]}` };
}

/** A media URL property: never bound to the data model. */
function mediaUrl(kind: A2uiMediaKind) {
	return z.string().min(1).max(A2UI_MEDIA_MAX_BYTES).refine(
		passes((value) => parseA2uiMediaUrl(value, kind)),
		`${kind} URL must be a base64 data: URL of an allowed type or a ttk://share/ path`,
	);
}

/** A refinement that holds when `check` does not throw. */
function passes(check: (value: string) => unknown): (value: string) => boolean {
	return (value) => {
		try {
			check(value);
			return true;
		} catch {
			return false;
		}
	};
}

/** `createSurface.theme`: every value is closed or numeric so none can carry CSS of its own. */
export const A2uiThemeSchema = z.strictObject({
	primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
	font: z.enum(['sans', 'serif', 'mono']).optional(),
	radius: z.number().min(0).max(24).optional(),
	density: z.enum(['compact', 'comfortable']).optional(),
});
export type A2uiTheme = z.infer<typeof A2uiThemeSchema>;

/** Validates absolute JSON Pointers; the v0.9 root alias is `/`. */
export function pointerSegments(path: string): string[] {
	if (path === '' || path === '/') return [];
	if (!path.startsWith('/') || path.length > 2048 || /~(?![01])/.test(path)) throw new Error('Invalid data pointer');
	const parts = path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
	if (parts.length > 32 || parts.some((part) => forbidden.has(part) || part.length === 0)) {
		throw new Error('Unsafe data pointer');
	}
	return parts;
}

/** Rejects dangerous keys, non-JSON values, cycles and oversized/deep payloads before schema evaluation. */
export function validateA2uiJson(value: unknown): void {
	const ancestors = new Set<object>();
	function walk(node: unknown, depth: number): void {
		if (depth > 32) throw new Error('A2UI data depth exceeded');
		if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
		if (typeof node === 'number' && Number.isFinite(node)) return;
		if (typeof node !== 'object' || ancestors.has(node)) throw new Error('A2UI requires acyclic JSON');
		if (
			!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null
		) {
			throw new Error('A2UI requires plain JSON objects');
		}
		ancestors.add(node);
		for (const [key, child] of Object.entries(node)) {
			if (forbidden.has(key)) throw new Error('Unsafe A2UI key');
			walk(child, depth + 1);
		}
		ancestors.delete(node);
	}
	walk(value, 0);
	if (new TextEncoder().encode(JSON.stringify(value)).length > A2UI_MAX_BYTES) throw new Error('A2UI size exceeded');
}

const pointer = z.string().refine(passes(pointerSegments), 'Invalid data pointer');
const binding = z.strictObject({ path: pointer });
const dynamicNumber = z.union([z.number(), binding]);
const dynamicBoolean = z.union([z.boolean(), binding]);
/** The only two catalog functions offered, evaluated on the page by {@linkcode resolveA2uiValue}. */
const formatStringCall = z.strictObject({
	call: z.literal('formatString'),
	args: z.strictObject({ value: z.union([z.string().max(65536), binding]) }),
	returnType: z.literal('string').optional(),
});
const formatNumberCall = z.strictObject({
	call: z.literal('formatNumber'),
	args: z.strictObject({
		value: dynamicNumber,
		decimals: dynamicNumber.optional(),
		grouping: dynamicBoolean.optional(),
	}),
	returnType: z.literal('string').optional(),
});
const dynamicText = z.union([z.string().max(65536), binding, formatStringCall, formatNumberCall]);
const event = z.strictObject({ name: id, context: z.record(z.string(), z.unknown()).optional() });
const base = { id };
const children = z.array(id).max(256);
/** Keeps `min < max` arithmetic exact. */
const bounded = z.number().min(-1e9).max(1e9);
/** An ISO 8601 date, time or date-time. */
const isoMoment = z.string().max(32).regex(/^[0-9T:.+-]{1,32}$/);
export const A2uiComponentSchema = z.discriminatedUnion('component', [
	z.strictObject({ ...base, component: z.literal('Column'), children }),
	z.strictObject({ ...base, component: z.literal('Row'), children }),
	z.strictObject({
		...base,
		component: z.literal('Text'),
		text: dynamicText,
		variant: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'caption', 'body']).optional(),
	}),
	z.strictObject({ ...base, component: z.literal('Card'), child: id }),
	z.strictObject({ ...base, component: z.literal('Divider') }),
	z.strictObject({ ...base, component: z.literal('Button'), text: dynamicText, action: z.strictObject({ event }) }),
	z.strictObject({ ...base, component: z.literal('TextField'), label: dynamicText, value: binding }),
	z.strictObject({ ...base, component: z.literal('CheckBox'), label: dynamicText, value: binding }),
	z.strictObject({
		...base,
		component: z.literal('Image'),
		url: mediaUrl('image'),
		description: dynamicText.optional(),
		fit: z.enum(['contain', 'cover', 'fill', 'none', 'scaleDown']).optional(),
		variant: z.enum(['icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header']).optional(),
	}),
	z.strictObject({ ...base, component: z.literal('Icon'), name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }),
	z.strictObject({
		...base,
		component: z.literal('List'),
		children,
		direction: z.enum(['vertical', 'horizontal']).optional(),
	}),
	z.strictObject({
		...base,
		component: z.literal('Tabs'),
		tabs: z.array(z.strictObject({ title: dynamicText, child: id })).min(1).max(32),
	}),
	z.strictObject({ ...base, component: z.literal('Modal'), trigger: id, content: id }),
	z.strictObject({
		...base,
		component: z.literal('Slider'),
		label: dynamicText.optional(),
		min: bounded.optional(),
		max: bounded,
		step: z.number().positive().max(1e9).optional(),
		value: binding,
	}).refine((slider) => (slider.min ?? 0) < slider.max, 'Slider min must be below max'),
	z.strictObject({
		...base,
		component: z.literal('DateTimeInput'),
		label: dynamicText.optional(),
		value: binding,
		enableDate: z.boolean().optional(),
		enableTime: z.boolean().optional(),
		min: isoMoment.optional(),
		max: isoMoment.optional(),
	}),
	z.strictObject({
		...base,
		component: z.literal('ChoicePicker'),
		label: dynamicText.optional(),
		variant: z.enum(['mutuallyExclusive', 'multipleSelection']).optional(),
		options: z.array(z.strictObject({ label: dynamicText, value: z.string().min(1).max(256) })).min(1).max(64)
			.refine((options) => new Set(options.map((option) => option.value)).size === options.length, {
				message: 'ChoicePicker option values must be unique',
			}),
		value: binding,
	}),
	z.strictObject({ ...base, component: z.literal('Video'), url: mediaUrl('video') }),
	z.strictObject({
		...base,
		component: z.literal('AudioPlayer'),
		url: mediaUrl('audio'),
		description: dynamicText.optional(),
	}),
	// TykoTech extension: an HTML document, rendered only through its own sandboxed route (never as markup here).
	z.strictObject({
		...base,
		component: z.literal('Html'),
		html: z.string().min(1).max(A2UI_HTML_MAX_BYTES).refine(
			(value) => new TextEncoder().encode(value).length <= A2UI_HTML_MAX_BYTES,
			'Html exceeds 128 KiB',
		),
		height: z.number().int().min(40).max(2000).optional(),
		title: z.string().max(256).optional(),
	}),
]);
export type A2uiComponent = z.infer<typeof A2uiComponentSchema>;

/** The component ids a component places in the tree, in render order: the one definition of adjacency. */
export function a2uiChildren(component: A2uiComponent): readonly string[] {
	switch (component.component) {
		case 'Column':
		case 'Row':
		case 'List':
			return component.children;
		case 'Card':
			return [component.child];
		case 'Tabs':
			return component.tabs.map((tab) => tab.child);
		case 'Modal':
			return [component.trigger, component.content];
		default:
			return [];
	}
}
export const A2uiMessageSchema = z.union([
	z.strictObject({
		version: z.literal('v0.9'),
		createSurface: z.strictObject({
			surfaceId: id,
			catalogId: z.literal(A2UI_CATALOG_ID),
			theme: A2uiThemeSchema.optional(),
			/** TykoTech extension: the coding workspace the surface belongs to. */
			workspaceId: z.uuid().optional(),
		}),
	}),
	z.strictObject({
		version: z.literal('v0.9'),
		updateComponents: z.strictObject({ surfaceId: id, components: z.array(A2uiComponentSchema).max(256) }),
	}),
	z.strictObject({
		version: z.literal('v0.9'),
		updateDataModel: z.strictObject({ surfaceId: id, path: pointer.optional(), value: z.unknown().optional() }),
	}),
	z.strictObject({ version: z.literal('v0.9'), deleteSurface: z.strictObject({ surfaceId: id }) }),
]);

/** The specification's ids for the v0.9 basic catalog; the local catalog is it plus `Html`. */
const BASIC_CATALOG_ID =
	/^https:\/\/a2ui\.org\/specification\/v0_9\/(?:(?:basic|standard)_catalog(?:_definition)?\.json|catalogs\/basic\/catalog\.json)$/;

const A2UI_OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps the specification clients' spellings onto the one {@linkcode A2uiMessageSchema} admits: a single-operation
 * message gains `version: "v0.9"` (or `"0.9"` becomes it), and a `createSurface` without a `catalogId` or naming the
 * basic catalog names {@linkcode A2UI_CATALOG_ID}. Anything else is returned unchanged for the schema to refuse.
 */
export function normalizeA2uiMessage(input: unknown): unknown {
	if (!plainObject(input)) return input;
	const operations = A2UI_OPERATIONS.filter((operation) => Object.hasOwn(input, operation));
	if (operations.length !== 1) return input;
	let message: Record<string, unknown> = input;
	if (!Object.hasOwn(message, 'version') || message.version === '0.9') message = { ...message, version: 'v0.9' };
	const create = message.createSurface;
	if (operations[0] === 'createSurface' && plainObject(create)) {
		const catalogId = create.catalogId;
		if (catalogId === undefined || (typeof catalogId === 'string' && BASIC_CATALOG_ID.test(catalogId))) {
			message = { ...message, createSurface: { ...create, catalogId: A2UI_CATALOG_ID } };
		}
	}
	return message;
}
export const A2uiActionSchema = z.strictObject({
	version: z.literal('v0.9'),
	action: z.strictObject({
		name: id,
		surfaceId: id,
		sourceComponentId: id,
		timestamp: z.iso.datetime(),
		context: z.record(z.string(), z.unknown()),
	}),
	metadata: z.strictObject({ revision: z.number().int().positive() }),
});
export type A2uiAction = z.infer<typeof A2uiActionSchema>;
export interface A2uiSurface {
	surfaceId: string;
	catalogId: typeof A2UI_CATALOG_ID;
	revision: number;
	components: A2uiComponent[];
	dataModel: unknown;
	theme?: A2uiTheme;
	workspaceId?: string;
	/** Trusted server registration keys; unregistered buttons remain disabled. */
	availableActions?: string[];
}

/** Reads own properties only; a missing model reference is a progressive placeholder. */
export function readA2uiPointer(model: unknown, path: string): unknown {
	let value = model;
	for (const key of pointerSegments(path)) {
		if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

/** How deep `${…}` may nest in one `formatString`, and how long its result may grow. */
const INTERPOLATION_DEPTH = 8;
const INTERPOLATION_LIMIT = 65536;

/** Strings as they are, other JSON as JSON, nothing as empty. */
function interpolated(value: unknown): string {
	if (value === undefined || value === null) return '';
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * `formatString`: `${pointer}` (a relative path reads from the root) is replaced by its value, nested expressions
 * first; `\${` is a literal `${`. A substituted value is never scanned again, so typed text cannot inject expressions.
 */
export function interpolateA2uiString(template: string, model: unknown): string {
	let at = 0;
	function run(depth: number, closing: boolean): string {
		let out = '';
		while (at < template.length) {
			const char = template[at]!;
			if (char === '\\' && template.startsWith('${', at + 1)) {
				out += '${';
				at += 3;
			} else if (char === '$' && template[at + 1] === '{' && depth < INTERPOLATION_DEPTH) {
				at += 2;
				const expression = run(depth + 1, true).trim();
				let value: unknown;
				try {
					value = readA2uiPointer(model, expression.startsWith('/') ? expression : `/${expression}`);
				} catch {
					value = undefined;
				}
				out += interpolated(value);
			} else if (char === '}' && closing) {
				at++;
				return out;
			} else {
				out += char;
				at++;
			}
			if (out.length > INTERPOLATION_LIMIT) return out.slice(0, INTERPOLATION_LIMIT);
		}
		return out;
	}
	return run(0, false);
}

/** A dynamic value as rendered: a `{ path }` binding reads the model, a call computes, a literal is itself. */
export function resolveA2uiValue(value: unknown, model: unknown, locale?: string): unknown {
	if (typeof value !== 'object' || value === null) return value;
	const record = value as Record<string, unknown>;
	if (typeof record.path === 'string' && Object.keys(record).length === 1) {
		try {
			return readA2uiPointer(model, record.path);
		} catch {
			return undefined;
		}
	}
	const args = typeof record.args === 'object' && record.args !== null ? record.args as Record<string, unknown> : {};
	if (record.call === 'formatString') {
		const template = resolveA2uiValue(args.value, model, locale);
		return typeof template === 'string' ? interpolateA2uiString(template, model) : interpolated(template);
	}
	if (record.call === 'formatNumber') {
		const number = Number(resolveA2uiValue(args.value, model, locale));
		if (!Number.isFinite(number)) return '';
		const decimals = resolveA2uiValue(args.decimals, model, locale);
		const grouping = resolveA2uiValue(args.grouping, model, locale);
		const digits = typeof decimals === 'number' && Number.isFinite(decimals)
			? Math.min(20, Math.max(0, Math.trunc(decimals)))
			: undefined;
		return new Intl.NumberFormat(locale, {
			useGrouping: grouping !== false,
			...(digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
		}).format(number);
	}
	return value;
}

/** Applies a model update to a fresh copy, leaving rejected updates atomic. */
export function updateA2uiModel(model: unknown, path: string, value?: unknown): unknown {
	const parts = pointerSegments(path);
	if (parts.length === 0) return value === undefined ? {} : structuredClone(value);
	const result = typeof model === 'object' && model !== null ? structuredClone(model) : {};
	const index = (parent: unknown, key: string): void => {
		if (Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > 4096)) {
			throw new Error('Invalid array pointer');
		}
	};
	let parent = result as Record<string, unknown>;
	for (const key of parts.slice(0, -1)) {
		index(parent, key);
		if (!Object.hasOwn(parent, key) || typeof parent[key] !== 'object' || parent[key] === null) parent[key] = {};
		parent = parent[key] as Record<string, unknown>;
	}
	const key = parts.at(-1)!;
	index(parent, key);
	if (value === undefined) {
		if (Array.isArray(parent)) parent[Number(key)] = null;
		else delete parent[key];
	} else parent[key] = structuredClone(value);
	validateA2uiJson(result);
	return result;
}

/** Checks all disconnected branches too; sharing a subtree may not amplify rendering without a bound. */
export function validateA2uiTree(components: readonly A2uiComponent[]): void {
	if (components.length > 256) throw new Error('A2UI component limit exceeded');
	const map = new Map(components.map((component) => [component.id, component]));
	if (map.size !== components.length) throw new Error('Duplicate A2UI component');
	let visits = 0;
	function walk(id: string, chain: Set<string>): void {
		if (chain.has(id) || chain.size >= 32) throw new Error('A2UI cycle or depth exceeded');
		if (++visits > 65536) throw new Error('A2UI tree expansion exceeded');
		const component = map.get(id);
		if (!component) return;
		const next = new Set(chain).add(id);
		for (const child of a2uiChildren(component)) walk(child, next);
	}
	for (const component of components) walk(component.id, new Set());
	visits = 0;
	function count(id: string): void {
		if (++visits > 256) throw new Error('A2UI rendered node limit exceeded');
		const component = map.get(id);
		for (const child of component ? a2uiChildren(component) : []) count(child);
	}
	count('root');
}
