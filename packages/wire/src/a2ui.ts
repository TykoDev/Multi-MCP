/**
 * Browser-safe A2UI v0.9: the basic catalog, the TykoTech `Html` extension, surface themes, and the confinement
 * rules every one of them passes before it is stored or rendered (D-067, D-111).
 *
 * D-111 widened the D-067 subset (Column, Row, Text, Card, Divider, Button, TextField, CheckBox) to the whole v0.9
 * basic catalog. What did not widen is the trust model: nothing here names a network location the browser would
 * fetch on its own. Media is inline (`data:` with a fixed MIME allowlist) or a path in this server's own file share
 * (`ttk://share/<path>`), which the SPA reads through its authenticated API; `Html` is never markup in the control
 * plane's DOM, only a document served by its own route under a `sandbox` CSP into an `<iframe sandbox>`.
 */
import * as z from 'zod';

export const A2UI_CATALOG_ID = 'https://tykotech.eu/a2ui/catalog/v0.9';
export const A2UI_MAX_BYTES = 256 * 1024;
/** Largest inline (`data:`) media URL, in characters — a base64 URL is ASCII, so characters are bytes. */
export const A2UI_MEDIA_MAX_BYTES = 256 * 1024;
/** Largest `Html` document, in UTF-8 bytes. */
export const A2UI_HTML_MAX_BYTES = 128 * 1024;
/** The one non-inline media location: a path in the server's file share, read by the SPA with its own credential. */
export const A2UI_SHARE_PREFIX = 'ttk://share/';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/**
 * The MIME subtypes a `data:` URL may declare, per media kind. Fixed rather than a pattern: an `image/svg+xml` data
 * URL is a document that can carry script, and `text/html` is not media at all.
 */
export const A2UI_MEDIA_TYPES = {
	image: ['png', 'jpeg', 'gif', 'webp'],
	video: ['mp4', 'webm', 'ogg'],
	audio: ['mpeg', 'mp4', 'ogg', 'wav', 'webm'],
} as const;
export type A2uiMediaKind = keyof typeof A2UI_MEDIA_TYPES;
/** Where a media component's bytes come from, once its URL has passed {@linkcode parseA2uiMediaUrl}. */
export type A2uiMediaSource = { readonly kind: 'data'; readonly mime: string } | {
	readonly kind: 'share';
	readonly path: string;
};

/**
 * Checks a media URL against the D-111 rule and says where its bytes come from: a base64 `data:` URL of an allowed
 * type within {@linkcode A2UI_MEDIA_MAX_BYTES}, or `ttk://share/<path>` whose decoded segments are plain names (no
 * `.`/`..`, no separators or control characters). Throws for anything else, including every `http(s):` URL.
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

/** A media URL property: validated by {@linkcode parseA2uiMediaUrl}, never bound to the data model. */
function mediaUrl(kind: A2uiMediaKind) {
	return z.string().min(1).max(A2UI_MEDIA_MAX_BYTES).refine((value) => {
		try {
			parseA2uiMediaUrl(value, kind);
			return true;
		} catch {
			return false;
		}
	}, `${kind} URL must be a base64 data: URL of an allowed type or a ttk://share/ path`);
}

/**
 * `createSurface.theme` (D-111): four presentation choices, mapped by the SPA onto the kit's tokens on the surface
 * root and nowhere else. Every value is closed or numeric so none can carry CSS of its own.
 */
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

const pointer = z.string().refine((value) => {
	try {
		pointerSegments(value);
		return true;
	} catch {
		return false;
	}
}, 'Invalid data pointer');
const binding = z.strictObject({ path: pointer });
const dynamicNumber = z.union([z.number(), binding]);
const dynamicBoolean = z.union([z.boolean(), binding]);
/**
 * The v0.9 basic catalog's client-side string functions, the two a display needs: `formatString` interpolates
 * `${/pointer}` expressions (nested ones resolve innermost first, so `${/table/${/key}}` is a lookup), and
 * `formatNumber` formats a number. They compute on the page from the surface's own data model, so a bound input
 * (a Slider, a TextField) visibly drives other components without a round trip. Evaluated by
 * {@linkcode resolveA2uiValue}; nothing else in the catalog's function list is offered.
 */
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
/** A finite number inside a range no slider needs to leave; keeps `min < max` arithmetic exact. */
const bounded = z.number().min(-1e9).max(1e9);
/** An ISO 8601 date, time or date-time as `<input type=date|time|datetime-local>` reads one. */
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
	// --- D-111: the rest of the v0.9 basic catalog ---------------------------------------------------------------
	z.strictObject({
		...base,
		component: z.literal('Image'),
		url: mediaUrl('image'),
		description: dynamicText.optional(),
		fit: z.enum(['contain', 'cover', 'fill', 'none', 'scaleDown']).optional(),
		variant: z.enum(['icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header']).optional(),
	}),
	// The name is a glyph of the SPA's own sprite; the renderer draws a neutral glyph for one it does not have.
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

/**
 * The component ids a component places in the tree, in render order. The one definition of adjacency, shared by
 * the gateway's validation and the SPA's renderer so the bounds checked are the bounds rendered.
 */
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
			/**
			 * TykoTech extension: the coding workspace (`sandbox_create`'s `workspace_id`) the surface belongs to. The
			 * control plane shows a surface under its workspace; a surface without one waits there to be attached.
			 */
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
export type A2uiMessage = z.infer<typeof A2uiMessageSchema>;

/**
 * The A2UI project's own ids for the v0.9 basic catalog. The local catalog is that catalog plus `Html`, so a client
 * written against the specification — which names the basic catalog (`catalogs/basic/catalog.json` in the current
 * specification tree, `basic_catalog.json` before it) — means the local one; it is stored as
 * {@linkcode A2UI_CATALOG_ID} either way.
 */
const BASIC_CATALOG_ID =
	/^https:\/\/a2ui\.org\/specification\/v0_9\/(?:(?:basic|standard)_catalog(?:_definition)?\.json|catalogs\/basic\/catalog\.json)$/;

const A2UI_OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps the spellings of an A2UI v0.9 message that the specification's clients send onto the one
 * {@linkcode A2uiMessageSchema} admits, and changes nothing else: a message naming exactly one operation gains
 * `version: "v0.9"` when it has none (and `"0.9"` reads as `"v0.9"`), and a `createSurface` with no `catalogId` or
 * with the basic catalog's own id names {@linkcode A2UI_CATALOG_ID}. The schema still decides validity; anything
 * else, including a different version or catalog, is returned unchanged and refused there. Never throws.
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
	/** D-111: the `createSurface.theme` the surface was created with, when it had one. */
	theme?: A2uiTheme;
	/** The coding workspace the surface belongs to (`createSurface.workspaceId`, or attached later); absent: none. */
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

/** How deep `${…}` expressions may nest in one `formatString`, and how long its result may grow. */
const INTERPOLATION_DEPTH = 8;
const INTERPOLATION_LIMIT = 65536;

/** A data-model value as interpolated text: strings as they are, other JSON as JSON, nothing as empty. */
function interpolated(value: unknown): string {
	if (value === undefined || value === null) return '';
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * `formatString`'s interpolation. `${expression}` is replaced by the value at the pointer it names (a relative path
 * reads from the root: this catalog has no collection scopes), nested expressions first; `\${` is a literal `${`.
 * An expression that is not a pointer, or does not resolve, interpolates nothing. A substituted value is never
 * scanned again, so text a person typed into the model cannot inject expressions.
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

/**
 * A dynamic value as the renderer shows it: a `{ path }` binding reads the model, a `formatString` or
 * `formatNumber` call computes its string (`locale` for the number format; the page's own by default), and a literal
 * is itself.
 */
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
	let parent = result as Record<string, unknown>;
	for (const key of parts.slice(0, -1)) {
		if (Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > 4096)) {
			throw new Error('Invalid array pointer');
		}
		if (!Object.hasOwn(parent, key) || typeof parent[key] !== 'object' || parent[key] === null) parent[key] = {};
		parent = parent[key] as Record<string, unknown>;
	}
	const key = parts.at(-1)!;
	if (Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > 4096)) {
		throw new Error('Invalid array pointer');
	}
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
