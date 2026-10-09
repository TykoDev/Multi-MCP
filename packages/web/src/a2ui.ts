/**
 * DOM-only renderer for the A2UI catalog (D-067, D-111): no markup strings and no URL the page would fetch on its
 * own. Every value reaches the page as text, an attribute, or a media URL the shared schema has already confined.
 *
 * Kit mapping (design §2.5): `Image` → `<img>` (no `srcset`, no referrer); `Icon` → the sprite's `icon()`; `List`
 * → a `role=list` of children; `Tabs` → `wa-tab-group`; `Modal` → `wa-dialog` opened by its trigger; `Slider` →
 * native `<input type=range>` in kit tokens (the kit's slider binds `styleMap`, which the page CSP refuses);
 * `DateTimeInput` → `wa-input type=date|time|datetime-local`; `ChoicePicker` → `wa-select`, or native checkboxes
 * for a multiple selection; `Video`/`AudioPlayer` → native players; `Html` → an `<iframe sandbox>` over the
 * gateway's own route, so an agent's document is never markup in this page.
 *
 * Media that is a `ttk://share/` path is read through the SPA's authenticated API and shown from an object URL
 * (`img-src`/`media-src` admit `blob:`); `releaseA2uiSurface` revokes those when the surface is replaced.
 *
 * D-136 (R9): the MCP Apps embed renders the same snapshot with `{ interactive: false, kit: false }`. Read-only:
 * no input writes the model, no action is sent, every control is disabled and every Button says why. Kit-free: the
 * embed is framed in a host's sandbox origin with no Web Awesome loaded and nothing of this origin reachable, so the
 * kit-only components become native elements (`Tabs` and `Modal` → `<details>`, `ChoicePicker` → `<select>`,
 * `DateTimeInput` → `<input type=date|time|datetime-local>`), `Icon` draws no glyph (the sprite URL is unreachable),
 * `Html` and the players are placeholders (no route to frame, and the embed's CSP admits no `media-src`), and share
 * media shows the unavailable placeholder because there is no credential to read it with.
 *
 * Those reads are the operator's browser downloading files an agent named, so they are bounded per rendered
 * surface (review R3-4): each distinct path is fetched once however many components show it, at most
 * {@linkcode SHARE_CONCURRENCY} at a time, and within {@linkcode SHARE_BYTES_PER_SURFACE} in total — a file that
 * would cross it shows the unavailable placeholder instead — and every read is aborted when the surface is
 * released. Without that, ~200 `Image` components over one 64 MiB share file fit in the 256 KiB message cap,
 * and every revision bump downloaded about 12 GiB again.
 */
import {
	A2UI_CATALOG_ID,
	type A2uiAction,
	type A2uiComponent,
	A2uiComponentSchema,
	type A2uiMediaKind,
	type A2uiSurface,
	type A2uiTheme,
	A2uiThemeSchema,
	parseA2uiMediaUrl,
	readA2uiPointer,
	updateA2uiModel,
	validateA2uiJson,
	validateA2uiTree,
} from '@tykotech/wire';
import { el, on } from './dom.ts';
import { icon, type IconName, ICONS } from './icons.ts';

/** What the renderer may reach beyond the snapshot. */
export interface A2uiRenderOptions {
	/**
	 * Reads one file of the share with the SPA's own credential, for `ttk://share/` media, honouring `signal`.
	 * The renderer reads the body itself, so it can stop at its byte budget. Absent: share media is not shown.
	 */
	readonly fetchShare?: (path: string, signal: AbortSignal) => Promise<Response>;
	/**
	 * D-136: `false` renders a snapshot — inputs are disabled or read-only, nothing writes the model and no action is
	 * sent, and each Button carries the reason in its tooltip. Default `true`.
	 */
	readonly interactive?: boolean;
	/**
	 * D-136: `false` uses no Web Awesome element and reaches nothing on this origin (no sprite, no `Html` route, no
	 * players): the MCP Apps embed's mode. Default `true`.
	 */
	readonly kit?: boolean;
}

/** D-136: the tooltip on every Button of a read-only render. */
export const READ_ONLY_ACTION_TIP = 'Read-only here: open the surface in the control plane to act on it';

/** D-136: what a kit-free render shows where an `Html` component's document would be framed. */
export const HTML_PLACEHOLDER_TEXT = 'This agent document is shown in the control plane, not in this embed.';

/** Share files a rendered surface downloads at once (R3-4). */
export const SHARE_CONCURRENCY = 8;

/** Bytes of share media one rendered surface may download in total (R3-4); a file past it is not shown. */
export const SHARE_BYTES_PER_SURFACE = 32 * 1024 * 1024;

/** A share file that would take the surface past {@linkcode SHARE_BYTES_PER_SURFACE}. */
class ShareBudgetError extends Error {}

/** The same-origin route an `Html` component's document is served from, under its `sandbox` CSP (D-111). */
export function a2uiHtmlPath(surfaceId: string, componentId: string): string {
	return `/api/v1/a2ui/surfaces/${encodeURIComponent(surfaceId)}/html/${encodeURIComponent(componentId)}`;
}

const releases = new WeakMap<Element, () => void>();

/** Revokes the object URLs a rendered surface holds; call it when the surface node leaves the page. */
export function releaseA2uiSurface(node: Element): void {
	releases.get(node)?.();
	releases.delete(node);
}

/** One rendered surface's share reads; see {@linkcode shareLoader}. */
interface ShareLoader {
	/** The object URL of `path`'s bytes; one download per distinct path for the life of the surface. */
	load(path: string): Promise<string>;
	/** Aborts every read, drops the queue and revokes every object URL made. Idempotent. */
	release(): void;
	readonly released: boolean;
}

/**
 * R3-4: one fetch per distinct path, at most {@linkcode SHARE_CONCURRENCY} in flight, at most
 * {@linkcode SHARE_BYTES_PER_SURFACE} downloaded in total, everything aborted on release.
 *
 * A declared `Content-Length` is reserved before the body is read, so a file that cannot fit is refused without
 * downloading a byte of it; a body with no length (or longer than it said) is counted as it arrives and cancelled
 * the moment it would cross the allowance. The bytes a cancelled read already took stay counted: the bound is on
 * what the operator's browser downloads, not on what it shows.
 */
function shareLoader(fetchShare: NonNullable<A2uiRenderOptions['fetchShare']>): ShareLoader {
	const controller = new AbortController();
	const urls = new Map<string, Promise<string>>();
	const created: string[] = [];
	const waiting: Array<() => void> = [];
	let running = 0;
	let remaining = SHARE_BYTES_PER_SURFACE;

	async function slot(): Promise<void> {
		while (running >= SHARE_CONCURRENCY) {
			controller.signal.throwIfAborted();
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		controller.signal.throwIfAborted();
		running += 1;
	}
	function free(): void {
		running -= 1;
		waiting.shift()?.();
	}
	async function download(path: string): Promise<string> {
		await slot();
		try {
			const response = await fetchShare(path, controller.signal);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const declared = Number(response.headers.get('content-length') ?? Number.NaN);
			let reserved = Number.isFinite(declared) && declared >= 0 ? declared : 0;
			if (reserved > remaining) {
				await response.body?.cancel().catch(() => {});
				throw new ShareBudgetError(path);
			}
			remaining -= reserved;
			const chunks: BlobPart[] = [];
			const reader = response.body?.getReader();
			try {
				for (;;) {
					const next = await reader?.read();
					if (next === undefined || next.done) break;
					const size = next.value.byteLength;
					const over = Math.max(0, size - reserved);
					reserved = Math.max(0, reserved - size);
					if (over > remaining) {
						remaining = 0;
						await reader?.cancel().catch(() => {});
						throw new ShareBudgetError(path);
					}
					remaining -= over;
					chunks.push(next.value as Uint8Array<ArrayBuffer>);
				}
			} finally {
				// A body shorter than it declared hands the unused reservation back.
				remaining += reserved;
				reserved = 0;
			}
			controller.signal.throwIfAborted();
			const url = URL.createObjectURL(new Blob(chunks, { type: response.headers.get('content-type') ?? '' }));
			created.push(url);
			return url;
		} finally {
			free();
		}
	}
	return {
		load(path) {
			let url = urls.get(path);
			if (url === undefined) {
				url = download(path);
				urls.set(path, url);
			}
			return url;
		},
		release() {
			controller.abort();
			// Queued reads wake, find the surface released, and never start.
			for (const wake of waiting.splice(0)) wake();
			for (const url of created.splice(0)) URL.revokeObjectURL(url);
		},
		get released() {
			return controller.signal.aborted;
		},
	};
}

/** Font stacks a theme may choose; `--font`/`--mono` are the shell's own, inherited as computed values. */
const FONTS: Readonly<Record<NonNullable<A2uiTheme['font']>, string>> = {
	sans: 'var(--font)',
	serif: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
	mono: 'var(--mono)',
};

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
	const channel = (offset: number): number => {
		const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
	return (light + 0.05) / (dark + 0.05);
}

/**
 * RV-3: the label colour for text drawn ON `hex` — black or white, whichever contrasts more. One of the two always
 * reaches at least 4.58:1 (the worst case is a colour of luminance ≈ 0.18), so a Button's label stays readable on
 * any primary colour the schema admits.
 */
export function textOn(hex: string): '#000000' | '#ffffff' {
	return contrastRatio(hex, '#000000') > contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff';
}

/**
 * RV-1: `hex` used AS text on `background` — itself when that already reaches 4.5:1, otherwise mixed toward black
 * (a light background) or white (a dark one) in 5 % steps until it does. The hue stays the agent's; only the
 * lightness gives way.
 */
export function inkOn(hex: string, background: string): string {
	const toward = relativeLuminance(background) > 0.18 ? 0 : 255;
	const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
	for (let step = 0; step <= 20; step++) {
		const mixed = '#' +
			rgb.map((value) => Math.round(value + (toward - value) * step / 20).toString(16).padStart(2, '0'))
				.join('');
		if (contrastRatio(mixed, background) >= 4.5) return mixed;
	}
	return toward === 0 ? '#000000' : '#ffffff';
}

/**
 * The surfaces an A2UI label can sit on, at their least favourable: the darkest light-theme one (the kit's
 * gray-90, below the sunken surface and the card) and the lightest dark-theme one (gray-20, above the card).
 * Ink that reaches 4.5:1 on these reaches it on every surface of its theme.
 */
const LIGHT_SURFACE = '#e4e5e9';
const DARK_SURFACE = '#2f323f';

/**
 * D-111: maps a theme onto custom properties of the surface root and nowhere else. Custom properties inherit
 * downward only, so the shell above the surface cannot be restyled, and every value written is one the closed
 * schema produced (a `#rrggbb`, a number of pixels, or a fixed stack) or derived from it here — never text an
 * agent chose.
 *
 * The kit's derived tokens are restated, not only its base ones (RV-1, RV-2): `--wa-form-control-activated-color`
 * (checkbox fill, the current option) and `--wa-panel-border-radius` (the dialog) are computed from the base
 * tokens at `:root`, and a custom property keeps the value it computed there — so overriding only the base token
 * on the surface left checkboxes and the dialog in the shell's colour and radius. The active tab label reads
 * `--wa-color-brand-on-quiet`, which `agents.css` sets per shell theme from the two inks written here. Focus rings
 * stay the shell's: they are an accessibility cue the shell has already checked for contrast.
 */
function applyTheme(root: HTMLElement, theme: A2uiTheme): void {
	const set = (name: string, value: string): void => root.style.setProperty(name, value);
	if (theme.primaryColor !== undefined) {
		const primary = theme.primaryColor;
		for (
			const token of [
				'--a2ui-primary',
				'--ttk-brand',
				'--accent',
				'--wa-color-brand-fill-loud',
				'--wa-color-brand-border-loud',
				'--wa-form-control-activated-color',
			]
		) set(token, primary);
		// RV-3: what is drawn ON the primary — a Button's label, a checkbox's tick, the current option's text.
		set('--wa-color-brand-on-loud', textOn(primary));
		// RV-1: the primary as text on the surface, one ink per shell theme.
		set('--a2ui-primary-ink-light', inkOn(primary, LIGHT_SURFACE));
		set('--a2ui-primary-ink-dark', inkOn(primary, DARK_SURFACE));
	}
	if (theme.font !== undefined) {
		set('--a2ui-font', FONTS[theme.font]);
		set('--wa-font-family-body', FONTS[theme.font]);
	}
	if (theme.radius !== undefined) {
		const radius = `${theme.radius}px`;
		for (
			const token of [
				'--a2ui-radius',
				'--wa-border-radius-s',
				'--wa-border-radius-m',
				'--wa-border-radius-l',
				'--wa-form-control-border-radius',
				'--wa-panel-border-radius',
			]
		) set(token, radius);
	}
	if (theme.density !== undefined) {
		set('--a2ui-gap', theme.density === 'compact' ? '6px' : '14px');
		set('--a2ui-pad', theme.density === 'compact' ? '8px' : '18px');
	}
}

type Of<K extends A2uiComponent['component']> = Extract<A2uiComponent, { component: K }>;

/** Render one trusted snapshot while revalidating its catalog, theme and adjacency before touching DOM. */
export function renderA2uiSurface(
	surface: A2uiSurface,
	send: (action: A2uiAction) => Promise<unknown>,
	options: A2uiRenderOptions = {},
): HTMLElement {
	validateA2uiJson(surface);
	if (surface.catalogId !== A2UI_CATALOG_ID) throw new Error('Unsupported UI catalog');
	const components = surface.components.map((component) => A2uiComponentSchema.parse(component));
	validateA2uiTree(components);
	const theme = surface.theme === undefined ? undefined : A2uiThemeSchema.parse(surface.theme);
	// D-136: the embed's read-only, kit-free mode; both default on, so the SPA's call sites are unchanged.
	const interactive = options.interactive !== false;
	const kit = options.kit !== false;
	const map = new Map(components.map((component) => [component.id, component]));
	let model = structuredClone(surface.dataModel);
	const reactive: Array<() => void> = [];
	const shares = options.fetchShare === undefined ? null : shareLoader(options.fetchShare);
	const notice = el('p', { class: 'a2ui-notice', role: 'status', 'aria-live': 'polite' });
	function resolve(value: unknown): unknown {
		return typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string'
			? readA2uiPointer(model, value.path)
			: value;
	}
	function text(value: unknown): string {
		const resolved = resolve(value);
		return resolved === undefined || resolved === null
			? ''
			: typeof resolved === 'object'
			? JSON.stringify(resolved)
			: String(resolved);
	}
	/** Writes one bound value and refreshes every bound view; a refused write leaves the model as it was. */
	function write(path: string, value: unknown): void {
		// D-136: a snapshot never changes; its inputs are disabled too, this is the second line.
		if (!interactive) return;
		try {
			model = updateA2uiModel(model, path, value);
			for (const refresh of reactive) refresh();
		} catch (cause) {
			notice.textContent = cause instanceof Error ? cause.message : 'Invalid input';
		}
	}
	/** Runs `refresh` now and on every model change. */
	function bind(refresh: () => void): void {
		refresh();
		reactive.push(refresh);
	}
	function fieldId(component: A2uiComponent): string {
		return `a2ui-${surface.surfaceId}-${component.id}`;
	}
	/** A media element whose source the schema confined: inline data as is, a share path through the API. */
	function media<K extends 'img' | 'video' | 'audio'>(
		tag: K,
		kind: A2uiMediaKind,
		url: string,
		attrs: Record<string, string | boolean | undefined>,
	): HTMLElementTagNameMap[K] {
		const node = el(tag, attrs);
		const source = parseA2uiMediaUrl(url, kind);
		if (source.kind === 'data') {
			node.setAttribute('src', url);
		} else if (shares === null) {
			node.setAttribute('data-unavailable', 'true');
		} else {
			const loader = shares;
			void loader.load(source.path).then((objectUrl) => {
				if (!loader.released) node.setAttribute('src', objectUrl);
			}).catch((cause: unknown) => {
				if (loader.released) return;
				node.setAttribute('data-unavailable', 'true');
				notice.textContent = cause instanceof ShareBudgetError
					? `${source.path} is not shown: this surface's media is limited to ${
						SHARE_BYTES_PER_SURFACE / (1024 * 1024)
					} MiB`
					: `Could not load ${source.path} from the file share`;
			});
		}
		return node;
	}

	function textNode(component: Of<'Text'>): HTMLElement {
		const variant = component.variant ?? 'body';
		const level = /^h([1-5])$/.exec(variant)?.[1];
		// Headings sit under the page's h1 and the Agents section's h2, so an agent's h1 is the surface's top level.
		const node = el('p', {
			class: `a2ui-text ${variant}`,
			...(level === undefined ? {} : { role: 'heading', 'aria-level': String(Math.min(6, Number(level) + 2)) }),
		});
		bind(() => {
			node.textContent = text(component.text);
		});
		return node;
	}
	function iconNode(component: Of<'Icon'>): HTMLElement {
		const known = Object.hasOwn(ICONS, component.name);
		const attrs = { class: known ? 'a2ui-icon' : 'a2ui-icon unknown', role: 'img', 'aria-label': component.name };
		// D-136: no glyph without the kit's sprite, which a sandboxed embed cannot reach; the name stays accessible.
		return kit ? el('span', attrs, [icon(known ? component.name as IconName : 'help')]) : el('span', attrs);
	}
	function list(component: Of<'List'>): HTMLElement {
		return el(
			'div',
			{ class: `a2ui-list ${component.direction ?? 'vertical'}`, role: 'list' },
			component.children.map((child) => el('div', { class: 'a2ui-list-item', role: 'listitem' }, [render(child)])),
		);
	}
	function tabs(component: Of<'Tabs'>): HTMLElement {
		if (!kit) {
			// D-136: every panel as a native disclosure under its title, the first one open.
			return el(
				'div',
				{ class: 'a2ui-tabs native' },
				component.tabs.map((tab, index) => {
					const title = el('summary', { class: 'a2ui-tab-title' });
					bind(() => {
						title.textContent = text(tab.title);
					});
					return el('details', { class: 'a2ui-tab', open: index === 0 }, [title, render(tab.child)]);
				}),
			);
		}
		const group = el('wa-tab-group', { class: 'a2ui-tabs' });
		component.tabs.forEach((tab, index) => {
			const title = el('span');
			bind(() => {
				title.textContent = text(tab.title);
			});
			group.append(el('wa-tab', { panel: `${component.id}-${index}` }, [title]));
		});
		component.tabs.forEach((tab, index) => {
			group.append(el('wa-tab-panel', { name: `${component.id}-${index}` }, [render(tab.child)]));
		});
		return group;
	}
	function modal(component: Of<'Modal'>): HTMLElement {
		const trigger = map.get(component.trigger);
		if (!kit) {
			// D-136: the dialog's content as a native disclosure whose summary is the trigger; opening it changes no model.
			const summary = el('summary', { class: 'a2ui-modal-trigger' });
			if (trigger?.component === 'Button') {
				bind(() => {
					summary.textContent = text(trigger.text);
				});
			} else {
				summary.append(render(component.trigger));
			}
			return el('details', { class: 'a2ui-modal native' }, [summary, render(component.content)]);
		}
		// A Button as the trigger opens the dialog; nesting it in the opener would put a button inside a button.
		const opener = el('button', {
			type: 'button',
			class: trigger?.component === 'Button' ? 'a2ui-modal-trigger a2ui-button wa-brand' : 'a2ui-modal-trigger',
		});
		const dialog = el('wa-dialog', { class: 'a2ui-modal', 'light-dismiss': true }, [render(component.content)]);
		if (trigger?.component === 'Button') {
			bind(() => {
				const words = text(trigger.text);
				opener.textContent = words;
				dialog.setAttribute('label', words);
			});
		} else {
			opener.append(render(component.trigger));
			dialog.setAttribute('label', 'Details');
		}
		on(opener, 'click', () => {
			dialog.open = true;
		});
		return el('div', { class: 'a2ui-modal-host' }, [opener, dialog]);
	}
	function buttonNode(component: Of<'Button'>): HTMLElement {
		const button = el('button', { class: 'a2ui-button wa-brand', text: text(component.text), type: 'button' });
		const key = `${component.id}:${component.action.event.name}`;
		reactive.push(() => {
			button.textContent = text(component.text);
		});
		if (!interactive) {
			// D-136: a snapshot sends nothing; the button stays to show the surface as the agent drew it.
			button.disabled = true;
			button.title = READ_ONLY_ACTION_TIP;
			return button;
		}
		button.disabled = !surface.availableActions?.includes(key);
		if (button.disabled) button.title = 'This action has no active server authorization';
		on(button, 'click', () => {
			const context: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(component.action.event.context ?? {})) {
				context[name] = resolve(value);
			}
			button.disabled = true;
			void send({
				version: 'v0.9',
				action: {
					surfaceId: surface.surfaceId,
					sourceComponentId: component.id,
					name: component.action.event.name,
					timestamp: new Date().toISOString(),
					context,
				},
				metadata: { revision: surface.revision },
			})
				.then(() => {
					notice.textContent = 'Action submitted.';
				})
				.catch((error: unknown) => {
					notice.textContent = error instanceof Error ? error.message : 'Action failed';
				});
		});
		return button;
	}
	function field(component: Of<'TextField' | 'CheckBox'>): HTMLElement {
		const inputId = fieldId(component);
		const input = el('input', {
			id: inputId,
			class: component.component === 'TextField' ? 'a2ui-input' : 'a2ui-check',
			type: component.component === 'TextField' ? 'text' : 'checkbox',
			maxlength: '65536',
		});
		const label = el('label', { class: 'a2ui-label', for: inputId, text: text(component.label) });
		bind(() => {
			label.textContent = text(component.label);
			if (component.component === 'CheckBox') input.checked = resolve(component.value) === true;
			else if (document.activeElement !== input) input.value = text(component.value);
		});
		if (!interactive) {
			// D-136: a text field stays selectable (read-only); a checkbox has no read-only state, so it is disabled.
			if (component.component === 'CheckBox') input.disabled = true;
			else input.readOnly = true;
		} else {
			on(input, 'input', () => {
				write(component.value.path, component.component === 'CheckBox' ? input.checked : input.value);
			});
		}
		return el('div', { class: `a2ui-field ${component.component === 'CheckBox' ? 'check' : 'text'}` }, [label, input]);
	}
	function slider(component: Of<'Slider'>): HTMLElement {
		const inputId = fieldId(component);
		const min = component.min ?? 0;
		const input = el('input', {
			id: inputId,
			class: 'a2ui-range',
			type: 'range',
			min: String(min),
			max: String(component.max),
			step: component.step === undefined ? 'any' : String(component.step),
			...(component.label === undefined ? { 'aria-label': component.id } : {}),
		});
		const readout = el('output', { class: 'a2ui-range-value mono', for: inputId });
		const label = el('label', { class: 'a2ui-label', for: inputId });
		bind(() => {
			if (component.label !== undefined) label.textContent = text(component.label);
			const current = resolve(component.value);
			const value = typeof current === 'number' && Number.isFinite(current)
				? Math.min(component.max, Math.max(min, current))
				: min;
			if (document.activeElement !== input) input.value = String(value);
			readout.textContent = input.value;
		});
		if (interactive) on(input, 'input', () => write(component.value.path, Number(input.value)));
		else input.disabled = true;
		return el('div', { class: 'a2ui-field slider' }, [
			el('div', { class: 'a2ui-range-head' }, [label, readout]),
			input,
		]);
	}
	function dateTime(component: Of<'DateTimeInput'>): HTMLElement {
		const type = component.enableTime === true ? component.enableDate === true ? 'datetime-local' : 'time' : 'date';
		if (!kit) {
			// D-136: the native control of the same type, with a real label.
			const inputId = fieldId(component);
			const native = el('input', {
				id: inputId,
				class: 'a2ui-input a2ui-datetime',
				type,
				min: component.min,
				max: component.max,
			});
			const label = el('label', { class: 'a2ui-label', for: inputId });
			bind(() => {
				if (component.label !== undefined) label.textContent = text(component.label);
				const current = resolve(component.value);
				if (document.activeElement !== native) native.value = typeof current === 'string' ? current : '';
			});
			if (interactive) {
				const commit = (): void => write(component.value.path, native.value);
				on(native, 'input', commit);
				on(native, 'change', commit);
			} else {
				native.readOnly = true;
			}
			return el('div', { class: 'a2ui-field datetime' }, [label, native]);
		}
		const input = el('wa-input', {
			id: fieldId(component),
			class: 'a2ui-datetime',
			type,
			min: component.min,
			max: component.max,
		});
		bind(() => {
			if (component.label !== undefined) input.setAttribute('label', text(component.label));
			const current = resolve(component.value);
			if (document.activeElement !== input) input.value = typeof current === 'string' ? current : '';
		});
		const commit = (): void => write(component.value.path, String(input.value ?? ''));
		on(input, 'input', commit);
		on(input, 'change', commit);
		return el('div', { class: 'a2ui-field datetime' }, [input]);
	}
	function choice(component: Of<'ChoicePicker'>): HTMLElement {
		const selected = (): string[] => {
			const current = resolve(component.value);
			if (typeof current === 'string') return [current];
			return Array.isArray(current) ? current.filter((value): value is string => typeof value === 'string') : [];
		};
		if (component.variant === 'multipleSelection') {
			const legend = el('legend', { class: 'a2ui-label' });
			const boxes = component.options.map((option, index) => {
				const boxId = `${fieldId(component)}-${index}`;
				const box = el('input', { id: boxId, type: 'checkbox', class: 'a2ui-check' });
				const label = el('label', { class: 'a2ui-label', for: boxId });
				if (interactive) {
					on(box, 'change', () => {
						write(component.value.path, boxes.filter((entry) => entry.box.checked).map((entry) => entry.value));
					});
				} else {
					box.disabled = true;
				}
				return { value: option.value, option, box, label };
			});
			bind(() => {
				if (component.label !== undefined) legend.textContent = text(component.label);
				const values = selected();
				for (const entry of boxes) {
					entry.label.textContent = text(entry.option.label);
					entry.box.checked = values.includes(entry.value);
				}
			});
			return el('fieldset', { class: 'a2ui-choices' }, [
				legend,
				...boxes.map((entry) => el('div', { class: 'a2ui-field check' }, [entry.label, entry.box])),
			]);
		}
		if (!kit) {
			// D-136: a native select over the same indices, so no agent value has to survive as an attribute either.
			const selectId = fieldId(component);
			const options = component.options.map((_option, index) => el('option', { value: String(index) }));
			const select = el('select', { id: selectId, class: 'a2ui-input a2ui-select' }, [
				el('option', { value: '', text: 'Choose…' }),
				...options,
			]);
			const label = el('label', { class: 'a2ui-label', for: selectId });
			bind(() => {
				if (component.label !== undefined) label.textContent = text(component.label);
				component.options.forEach((option, index) => {
					options[index]!.textContent = text(option.label);
				});
				const index = component.options.findIndex((option) => selected().includes(option.value));
				if (document.activeElement !== select) select.value = index < 0 ? '' : String(index);
			});
			if (interactive) {
				on(select, 'change', () => {
					const option = component.options[Number(select.value)];
					write(component.value.path, option === undefined ? [] : [option.value]);
				});
			} else {
				select.disabled = true;
			}
			return el('div', { class: 'a2ui-field choice' }, [label, select]);
		}
		// Option values are agent text; the kit's option value is the index, so no value has to survive as a token.
		const labels = component.options.map(() => el('span'));
		const select = el(
			'wa-select',
			{ id: fieldId(component), class: 'a2ui-select', placeholder: 'Choose…' },
			component.options.map((_option, index) => el('wa-option', { value: String(index) }, [labels[index]!])),
		);
		bind(() => {
			if (component.label !== undefined) select.setAttribute('label', text(component.label));
			component.options.forEach((option, index) => {
				labels[index]!.textContent = text(option.label);
			});
			const index = component.options.findIndex((option) => selected().includes(option.value));
			if (document.activeElement !== select) select.value = index < 0 ? '' : String(index);
		});
		on(select, 'change', () => {
			const option = component.options[Number(select.value)];
			write(component.value.path, option === undefined ? [] : [option.value]);
		});
		return el('div', { class: 'a2ui-field choice' }, [select]);
	}
	function image(component: Of<'Image'>): HTMLElement {
		// RV-6: kit-free, a share file has no credential to be read with, so there is no picture to leave blank — the
		// note says where it is shown, with its description inside. Inline data still shows here.
		if (!kit && parseA2uiMediaUrl(component.url, 'image').kind !== 'data') {
			return mediaNote('Image', component.description);
		}
		const node = media('img', 'image', component.url, {
			class: `a2ui-image fit-${component.fit ?? 'fill'} ${component.variant ?? 'mediumFeature'}`,
			alt: '',
			referrerpolicy: 'no-referrer',
			decoding: 'async',
			loading: 'lazy',
		});
		bind(() => {
			node.alt = component.description === undefined ? '' : text(component.description);
		});
		return node;
	}
	/**
	 * D-136: a kit-free render's player is a note, not a player: the embed's CSP admits images only
	 * (`img-src data: blob:`), so a native player would show controls that can never play anything. A share image is
	 * a note too (RV-6). A description sits inside its own note, first, so it can never read as the caption of
	 * whatever follows.
	 */
	function mediaNote(kind: 'Image' | 'Video' | 'Audio', description?: unknown): HTMLElement {
		const words = el('span', {
			class: 'a2ui-media-note',
			text: kind === 'Image' ? 'Image is shown in the control plane' : `${kind} is played in the control plane`,
		});
		const note = el('div', {
			class: `a2ui-media-placeholder ${kind.toLowerCase()}`,
			role: 'note',
			'data-unavailable': 'true',
		});
		if (description === undefined) {
			note.append(words);
			return note;
		}
		const caption = el('span', { class: 'a2ui-caption' });
		bind(() => {
			caption.textContent = text(description);
		});
		note.append(caption, words);
		return note;
	}
	function audio(component: Of<'AudioPlayer'>): HTMLElement {
		if (!kit) return mediaNote('Audio', component.description);
		const player = media('audio', 'audio', component.url, {
			class: 'a2ui-audio',
			controls: true,
			preload: 'metadata',
		});
		const caption = el('figcaption', { class: 'a2ui-caption' });
		bind(() => {
			const words = component.description === undefined ? '' : text(component.description);
			caption.textContent = words;
			player.setAttribute('aria-label', words === '' ? 'Audio' : words);
		});
		return el('figure', { class: 'a2ui-media audio' }, [player, caption]);
	}
	function frame(component: Of<'Html'>): HTMLElement {
		if (!kit) {
			// D-136: the route that serves the document is this origin's, which a sandboxed embed cannot frame.
			return el('div', {
				class: 'a2ui-html placeholder',
				role: 'note',
				'aria-label': component.title ?? 'Agent content',
				text: HTML_PLACEHOLDER_TEXT,
			});
		}
		// `sandbox` is set before `src`, and empty: no scripts, no same-origin, no forms, no pop-ups, no top navigation.
		// The route adds a `sandbox` CSP of its own, so the document stays inert even if it is opened outside a frame.
		return el('iframe', {
			sandbox: '',
			class: 'a2ui-html',
			referrerpolicy: 'no-referrer',
			loading: 'lazy',
			title: component.title ?? 'Agent content',
			height: String(component.height ?? 240),
			src: a2uiHtmlPath(surface.surfaceId, component.id),
		});
	}

	function render(id: string): HTMLElement {
		const component = map.get(id);
		if (!component) return el('span', { class: 'a2ui-pending', text: 'Waiting for component…' });
		switch (component.component) {
			case 'Column':
			case 'Row':
				return el('div', { class: `a2ui-${component.component.toLowerCase()}` }, component.children.map(render));
			case 'Card':
				return el('div', { class: 'a2ui-card' }, [render(component.child)]);
			case 'Divider':
				return el('hr', { class: 'a2ui-divider' });
			case 'Text':
				return textNode(component);
			case 'Button':
				return buttonNode(component);
			case 'TextField':
			case 'CheckBox':
				return field(component);
			case 'Image':
				return image(component);
			case 'Icon':
				return iconNode(component);
			case 'List':
				return list(component);
			case 'Tabs':
				return tabs(component);
			case 'Modal':
				return modal(component);
			case 'Slider':
				return slider(component);
			case 'DateTimeInput':
				return dateTime(component);
			case 'ChoicePicker':
				return choice(component);
			case 'Video':
				if (!kit) return mediaNote('Video');
				return media('video', 'video', component.url, {
					class: 'a2ui-video',
					controls: true,
					preload: 'metadata',
					playsinline: true,
				});
			case 'AudioPlayer':
				return audio(component);
			case 'Html':
				return frame(component);
		}
	}
	const root = el('section', { class: 'a2ui-surface', 'aria-label': `Agent surface ${surface.surfaceId}` }, [
		render('root'),
		notice,
	]);
	if (theme !== undefined) applyTheme(root, theme);
	releases.set(root, () => shares?.release());
	return root;
}
