/**
 * Shared UI primitives on the component kit (D-089): buttons, tooltips, confirm
 * popovers, toasts, tiles, cards, empty states, chips, a JSON viewer, and (run
 * model-providers-ui) a segmented switch, fact groups, meter bars, a diff table
 * and a popover menu.
 *
 * Buttons are native `<button>` elements styled by the kit's native layer
 * (`wa-brand`, `wa-plain`, …), so they keep the full `HTMLButtonElement`
 * contract — `disabled`, form submission, an accessible name from
 * `aria-label` — while looking like the kit's own. Overlays are the kit's
 * custom elements: one shared `wa-tooltip` follows whatever `[data-tip]` element
 * the pointer or focus is on, one shared `wa-popover` asks for confirmation,
 * and `openModal` is a `wa-dialog`.
 *
 * Everything is built with `el`, so server strings reach the DOM as text only.
 */
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaPopover from '@awesome.me/webawesome/dist/components/popover/popover.js';
import type WaTooltip from '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { el, on } from './dom.ts';
import { icon, type IconName, scopeIcon } from './icons.ts';
import { onLeave } from './lifecycle.ts';

export type Tone = '' | 'ok' | 'live' | 'warn' | 'locked' | 'danger' | 'error' | 'accent' | 'info' | 'agent';

/** A tone as the kit's variant name. */
export function variantOf(tone: string): 'neutral' | 'brand' | 'success' | 'warning' | 'danger' {
	switch (tone) {
		case 'ok':
		case 'live':
			return 'success';
		case 'warn':
		case 'locked':
			return 'warning';
		case 'danger':
		case 'error':
			return 'danger';
		case 'accent':
		case 'info':
		case 'agent':
			return 'brand';
		default:
			return 'neutral';
	}
}

// --- buttons ------------------------------------------------------------------

export interface ButtonOptions {
	readonly label: string;
	readonly icon?: IconName;
	/** primary: loud brand · danger: soft red · ghost: plain · success: soft green; default: soft neutral. */
	readonly variant?: 'primary' | 'danger' | 'ghost' | 'success';
	/** Show only the icon; the label becomes the accessible name and the tooltip. */
	readonly iconOnly?: boolean;
	readonly small?: boolean;
	/** Where the tooltip of an icon-only button opens (default below). */
	readonly tip?: 'top' | 'bottom' | 'left' | 'right';
	readonly title?: string;
	readonly type?: 'button' | 'submit';
	readonly onClick?: (event: MouseEvent) => void;
}

const VARIANT_CLASSES: Record<string, string> = {
	primary: 'wa-brand',
	danger: 'wa-danger wa-filled wa-outlined',
	ghost: 'wa-neutral wa-plain',
	success: 'wa-success wa-filled wa-outlined',
	'': 'wa-neutral wa-filled wa-outlined',
};

export function button(options: ButtonOptions): HTMLButtonElement {
	const classes = [
		'ttk-btn',
		VARIANT_CLASSES[options.variant ?? ''],
		options.variant ?? '',
		options.iconOnly ? 'icon-only' : '',
		options.small ? 'sm wa-size-s' : '',
	].filter((name) => name !== undefined && name !== '').join(' ');
	const node = el('button', {
		class: classes,
		type: options.type ?? 'button',
		title: options.title,
		'aria-label': options.iconOnly ? options.label : undefined,
		'data-tip': options.iconOnly ? options.label : undefined,
		'data-tip-placement': options.iconOnly ? options.tip : undefined,
	});
	if (options.icon !== undefined) node.append(icon(options.icon));
	if (!options.iconOnly) node.append(el('span', { class: 'label', text: options.label }));
	if (options.onClick !== undefined) on(node, 'click', options.onClick);
	return node;
}

/** An icon-only button: the label is its accessible name and its tooltip. */
export function iconButton(
	glyph: IconName,
	label: string,
	onClick?: (event: MouseEvent) => void,
	options: Partial<ButtonOptions> = {},
): HTMLButtonElement {
	return button({ variant: 'ghost', ...options, label, icon: glyph, iconOnly: true, onClick });
}

/** Replaces a button's label (visible or accessible) and, when named, its icon. */
export function relabel(node: HTMLButtonElement, label: string, iconName?: IconName): void {
	const span = node.querySelector(':scope > span.label');
	if (span !== null) span.textContent = label;
	if (node.classList.contains('icon-only')) {
		node.setAttribute('aria-label', label);
		node.setAttribute('data-tip', label);
		refreshTip(node);
	}
	if (iconName !== undefined) node.querySelector(':scope > svg.icon')?.replaceWith(icon(iconName));
}

/**
 * Runs `work` with the button disabled and its icon swapped for the kit's spinner.
 *
 * Returns the work's own result so callers keep their error handling; the
 * button is restored whatever happens.
 */
export async function busy<T>(node: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
	const glyph = node.querySelector(':scope > svg.icon');
	const spinner = el('wa-spinner', { class: 'btn-spinner', 'aria-hidden': 'true' });
	if (glyph !== null) glyph.replaceWith(spinner);
	else node.prepend(spinner);
	node.disabled = true;
	node.setAttribute('aria-busy', 'true');
	try {
		return await work();
	} finally {
		if (glyph !== null) spinner.replaceWith(glyph);
		else spinner.remove();
		node.disabled = false;
		node.removeAttribute('aria-busy');
	}
}

// --- tooltips -------------------------------------------------------------------

let tipHost: WaTooltip | null = null;
let tipTarget: HTMLElement | null = null;
let tipSerial = 0;

function anchorId(target: HTMLElement): string {
	if (target.id === '') target.id = `ttk-tip-${++tipSerial}`;
	return target.id;
}

function showTip(target: HTMLElement): void {
	const text = target.getAttribute('data-tip') ?? '';
	if (text === '') return;
	if (tipHost === null || !tipHost.isConnected) {
		tipHost = el('wa-tooltip', { class: 'ttk-tip', trigger: 'manual', 'show-delay': 250, 'hide-delay': 0 });
		document.body.append(tipHost);
	}
	tipTarget = target;
	tipHost.textContent = text;
	tipHost.placement = (target.getAttribute('data-tip-placement') as WaTooltip['placement'] | null) ?? 'bottom';
	tipHost.setAttribute('for', anchorId(target));
	tipHost.open = true;
}

function hideTip(): void {
	tipTarget = null;
	if (tipHost !== null) tipHost.open = false;
}

/** Re-reads the tooltip text of `target` if it is the one showing. */
function refreshTip(target: HTMLElement): void {
	if (tipTarget === target && tipHost !== null) tipHost.textContent = target.getAttribute('data-tip') ?? '';
}

/** What `focusin` does with the shared tooltip ({@linkcode focusTipAction}). */
export type FocusTipAction = 'show' | 'hide' | 'keep';

/** The facts `focusin` decides on: all read from the event and the tooltip's state, none from the DOM afterwards. */
export interface FocusTipInput {
	/** The focused element is inside (or is) a `[data-tip]` owner. */
	readonly hasTarget: boolean;
	/** The focus is keyboard-visible (`:focus-visible`). */
	readonly focusVisible: boolean;
	/** The focused element is an INPUT, TEXTAREA or SELECT inside a tooltip owner other than itself. */
	readonly wrappedField: boolean;
	/** A tip is showing now. */
	readonly tipShowing: boolean;
}

/**
 * The `focusin` decision, pure. A tip on a wrapper shows for a keyboard-focused button inside it, never over a field
 * someone is typing in. When focus shows no tip, any tip still showing goes — including the wrapper's own: `focusout`
 * keeps a tip when focus moves inside a tooltip owner (RV-13), so Tabbing from a hovered `lib-field` wrapper into its
 * input used to leave the wrapper's tip over the field (BUG-4 / FE-1 / CR-5). The `show` branch is the only one that
 * re-targets, so RV-13's tile-to-tile Tab is unchanged.
 */
export function focusTipAction(input: FocusTipInput): FocusTipAction {
	if (input.hasTarget && input.focusVisible && !input.wrappedField) return 'show';
	return input.tipShowing ? 'hide' : 'keep';
}

/**
 * Wires the shared tooltip to every `[data-tip]` element, present or future
 * (called once at start-up). `data-tip-placement` picks the side.
 */
export function installTooltips(): void {
	const find = (event: Event): HTMLElement | null =>
		event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') : null;
	document.addEventListener('pointerover', (event) => {
		const target = find(event);
		if (target !== null && target !== tipTarget) showTip(target);
		else if (target === null && tipTarget !== null) hideTip();
	});
	document.addEventListener('focusin', (event) => {
		const focused = event.target instanceof HTMLElement ? event.target : null;
		const target = find(event);
		const action = focusTipAction({
			hasTarget: focused !== null && target !== null,
			focusVisible: focused !== null && focused.matches(':focus-visible'),
			wrappedField: focused !== null && target !== null && target !== focused &&
				/^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName),
			tipShowing: tipTarget !== null,
		});
		if (action === 'show' && target !== null) showTip(target);
		else if (action === 'hide') hideTip();
	});
	// RV-13: focus moving straight onto another tooltip owner (Tab between two tiles or icon buttons) re-targets the tip
	// in `focusin` instead. Hiding first flips the kit tooltip's `open` off and on in one task, which it never acts on,
	// so the next tip stayed hidden while reporting `open`.
	document.addEventListener('focusout', (event) => {
		const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest('[data-tip]') : null;
		if (next === null) hideTip();
	});
	document.addEventListener('pointerdown', hideTip);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') hideTip();
	});
	globalThis.addEventListener('hashchange', hideTip);
}

/** Gives any element a tooltip (and, when it has none, an accessible name). */
export function tip<T extends HTMLElement>(node: T, text: string, placement?: ButtonOptions['tip']): T {
	node.setAttribute('data-tip', text);
	if (placement !== undefined) node.setAttribute('data-tip-placement', placement);
	if (!node.hasAttribute('aria-label') && node.textContent === '') node.setAttribute('aria-label', text);
	return node;
}

// --- confirmation -----------------------------------------------------------------

let confirmHost: WaPopover | null = null;

/**
 * Asks for confirmation in a popover anchored to `anchor`. Resolves true only on
 * the explicit confirm button; Escape, a click outside or cancel resolve false.
 */
export function confirmAt(anchor: HTMLElement, question: string, glyph: IconName = 'trash'): Promise<boolean> {
	confirmHost?.remove();
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: boolean): void => {
			if (settled) return;
			settled = true;
			resolve(value);
			if (host.open) host.open = false;
			else host.remove();
		};
		const yes = button({ label: 'Confirm', icon: 'check', variant: 'primary', small: true });
		yes.classList.replace('wa-brand', 'wa-danger');
		const no = iconButton('x', 'Cancel', () => settle(false), { small: true });
		on(yes, 'click', () => settle(true));
		const host = el('wa-popover', { class: 'ttk-confirm', placement: 'bottom', for: anchorId(anchor) }, [
			el('div', { class: 'confirm-body', role: 'alertdialog', 'aria-label': question }, [
				el('span', { class: 'confirm-glyph' }, [icon(glyph)]),
				el('span', { class: 'confirm-text', text: question }),
				el('div', { class: 'confirm-actions' }, [no, yes]),
			]),
		]);
		host.addEventListener('wa-after-hide', () => {
			settle(false);
			host.remove();
		});
		confirmHost = host;
		// The anchor goes with its screen; a confirmation left open would float over the next one, still armed.
		onLeave(() => settle(false));
		// A modal dialog or drawer makes everything outside it inert, so the popover lives inside the overlay its
		// anchor is in; elsewhere it lives in the body.
		(anchor.closest('wa-dialog, wa-drawer') ?? document.body).append(host);
		requestAnimationFrame(() => {
			host.open = true;
			requestAnimationFrame(() => yes.focus());
		});
	});
}

/**
 * A destructive button that asks first, in a popover beside it.
 *
 * Replaces the timed "click again within three seconds" pattern, which a
 * deliberate but unhurried second click could miss. The button stays quiet and
 * turns red only under the pointer or focus (D-092): the popover is the
 * safeguard, and a row of red squares would shout louder than the content.
 */
export function confirmButton(options: ButtonOptions, run: () => Promise<unknown>): HTMLButtonElement {
	const node = button({ variant: 'ghost', ...options });
	node.classList.add('destructive');
	on(node, 'click', () => {
		void confirmAt(node, `${options.label}?`, options.icon ?? 'trash').then((ok) => {
			if (ok) void busy(node, run).catch((cause) => toast(messageOf(cause), 'error'));
		});
	});
	return node;
}

// --- toasts -----------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

/** A transient notice in the corner, announced politely to assistive technology. Text only. */
export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
	if (toastHost === null || !toastHost.isConnected) {
		toastHost = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
		document.body.append(toastHost);
	}
	const glyph = icon(kind === 'ok' ? 'circle-check' : kind === 'error' ? 'alert' : 'info');
	glyph.setAttribute('slot', 'icon');
	const close = iconButton('x', 'Dismiss', undefined, { small: true });
	const node = el(
		'wa-callout',
		{ class: `ttk-toast ${kind}`, variant: variantOf(kind === 'error' ? 'danger' : kind === 'ok' ? 'ok' : 'info') },
		[glyph, el('span', { class: 'toast-text', text: message }), close],
	);
	toastHost.append(node);
	const leave = (): void => {
		node.classList.add('leaving');
		setTimeout(() => node.remove(), 260);
	};
	on(close, 'click', leave);
	setTimeout(leave, kind === 'error' ? 7000 : 3500);
}

/** The message of anything thrown, for a toast or a notice. */
export function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// --- tiles, cards, empty states ---------------------------------------------------------

/**
 * One metric in a stat strip (`.tiles`, D-092): glyph, value, and a one- or
 * two-word label on one line. `set` animates the value when it actually
 * changes and dims a zero; the optional detail becomes the tooltip rather than
 * another line of text.
 */
export function statTile(iconName: IconName, label: string, tone = '', glyph?: HTMLElement): {
	node: HTMLElement;
	set(value: string, sub?: string): void;
} {
	const value = el('div', { class: 'tile-value', text: '—' });
	const detailText = el('span', { class: 'sr-only' });
	const node = el('div', { class: `tile ${tone}`, 'data-tip': label }, [
		glyph ?? el('div', { class: 'tile-glyph' }, [icon(iconName)]),
		el('div', { class: 'tile-body' }, [value, el('div', { class: 'tile-label', text: label }), detailText]),
	]);
	return {
		node,
		set(next: string, detail = '') {
			if (value.textContent !== next) {
				value.textContent = next;
				value.classList.remove('bump');
				// Restarts the animation: reading layout between the remove and the add makes it a new one.
				void value.offsetWidth;
				value.classList.add('bump');
			}
			node.classList.toggle('zero', /^0(\/0)?$/.test(next));
			node.setAttribute('data-tip', detail === '' ? label : `${label} · ${detail}`);
			detailText.textContent = detail === '' ? '' : ` (${detail})`;
			refreshTip(node);
		},
	};
}

/** A titled card (`wa-card`) with a glyph, a title and optional header actions. */
export function panel(title: string, iconName: IconName, body: Node[], actions: Node[] = []): HTMLElement {
	const header = el('div', { slot: 'header', class: 'panel-head' }, [
		el('span', { class: 'panel-glyph' }, [icon(iconName)]),
		el('h2', { text: title }),
		el('div', { class: 'panel-actions' }, actions),
	]);
	return el('wa-card', { class: 'panel', 'with-header': true }, [header, el('div', { class: 'panel-body' }, body)]);
}

/** An illustration: a glyph inside orbit rings, for empty states and splash screens. */
/** The Multi-MCP logo, served from `static/brand/` (CSP `img-src 'self'`). Decorative: its context names it. */
export const BRAND_LOGO_URL = '/assets/brand/multi-mcp-logo.png';

/** The Multi-MCP logo as an image element with `className`; empty `alt`, because it is decorative wherever it sits. */
export function brandLogo(className: string): HTMLElement {
	return el('img', { class: className, src: BRAND_LOGO_URL, alt: '', draggable: 'false' });
}

/** The illustration's orbit rings around the Multi-MCP logo instead of a glyph on a gradient tile. */
export function brandIllustration(): HTMLElement {
	return el('div', { class: 'illustration brand', 'aria-hidden': 'true' }, [
		el('span', { class: 'ring r1' }),
		el('span', { class: 'ring r2' }),
		brandLogo('orb-logo'),
	]);
}

export function illustration(iconName: IconName, tone = ''): HTMLElement {
	return el('div', { class: `illustration ${tone}`, 'aria-hidden': 'true' }, [
		el('span', { class: 'ring r1' }),
		el('span', { class: 'ring r2' }),
		el('span', { class: 'orb' }, [icon(iconName)]),
	]);
}

/**
 * A placeholder for a list with nothing in it: an illustration, a short title,
 * and optionally one action. A hint, when given, is the title's tooltip.
 */
export function empty(iconName: IconName | 'brand', title: string, hint = '', action?: HTMLElement): HTMLElement {
	const heading = el('div', { class: 'empty-title', text: title });
	if (hint !== '') tip(heading, hint);
	return el('div', { class: 'empty' }, [
		iconName === 'brand' ? brandIllustration() : illustration(iconName),
		heading,
		...(hint === '' ? [] : [el('span', { class: 'sr-only', text: hint })]),
		...(action === undefined ? [] : [el('div', { class: 'empty-action' }, [action])]),
	]);
}

// --- chips --------------------------------------------------------------------------

/** A small coloured label (`wa-badge`). */
export function badge(text: string, tone = ''): HTMLElement {
	return el('wa-badge', { class: `badge ${tone}`, variant: variantOf(tone), appearance: 'filled outlined', text });
}

/** A labelled chip with an optional glyph (`wa-tag`). */
export function tag(text: string, glyph?: IconName, tone = ''): HTMLElement {
	return el('wa-tag', { class: 'chip', variant: variantOf(tone), appearance: 'filled outlined', size: 's' }, [
		...(glyph === undefined ? [] : [icon(glyph)]),
		el('span', { text }),
	]);
}

/** A status dot whose meaning is its tooltip and accessible name. */
export function dot(tone: Tone | string, meaning: string): HTMLElement {
	return el('span', { class: `dot ${tone}`, role: 'img', 'aria-label': meaning, 'data-tip': meaning });
}

/** One key/value row with an icon, for the diagnostics panels. */
export function kv(iconName: IconName, key: string, value: string | Node): HTMLElement {
	return el('div', { class: 'kv' }, [
		icon(iconName),
		el('span', { class: 'kv-key', text: key }),
		typeof value === 'string' ? el('span', { class: 'kv-val', text: value }) : value,
	]);
}

/** An on/off indicator: a glyph and a colour, with the words as name and tooltip. */
export function flag(on: boolean, yes = 'On', no = 'Off'): HTMLElement {
	const text = on ? yes : no;
	return el('span', { class: `flag ${on ? 'on' : 'off'}`, role: 'img', 'aria-label': text, 'data-tip': text }, [
		icon(on ? 'circle-check' : 'circle-dashed'),
	]);
}

/** Initials on a colour derived from the name (`wa-avatar`). */
export function avatar(name: string, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const initials = name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') ||
		'?';
	return el('wa-avatar', { class: `ttk-avatar ${size} hue-${hash % 6}`, initials, label: name });
}

/**
 * Scopes as a cluster of glyphs: each one's tooltip and accessible name is the
 * scope. With `all`, scopes not held are shown dimmed so the set reads at a
 * glance; held scopes listed in `explicit` (granted only when named, D-065) are
 * marked in the warning colour.
 */
export function scopeChips(
	held: readonly string[],
	all: readonly string[] = held,
	explicit: readonly string[] = [],
): HTMLElement {
	const set = new Set(held);
	const marked = new Set(explicit);
	return el(
		'div',
		{ class: 'scope-chips', role: 'list', 'aria-label': `${held.length} scopes` },
		all.map((scope) => {
			const has = set.has(scope);
			const special = has && marked.has(scope);
			const words = has ? (special ? `${scope} — explicit grant` : scope) : `${scope} — not held`;
			return el('span', {
				class: `scope ${has ? 'held' : 'not-held'}${special ? ' explicit' : ''}`,
				role: 'listitem',
				'aria-label': words,
				'data-tip': words,
			}, [icon(scopeIcon(scope))]);
		}),
	);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 16;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * A progress ring around a glyph: an SVG track and arc whose fill is set with
 * `set(fraction)`. Drawn here rather than with the kit's progress ring, whose
 * first render writes a `style` attribute that the page CSP refuses (D-089);
 * the arc length is a CSSOM write, which the CSP allows.
 */
export function meterRing(glyph: IconName, label: string): { node: HTMLElement; set(fraction: number): void } {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 40 40');
	svg.setAttribute('class', 'meter-ring-svg');
	svg.setAttribute('aria-hidden', 'true');
	const circle = (cls: string): SVGCircleElement => {
		const node = document.createElementNS(SVG_NS, 'circle');
		node.setAttribute('class', cls);
		node.setAttribute('cx', '20');
		node.setAttribute('cy', '20');
		node.setAttribute('r', String(RING_RADIUS));
		return node;
	};
	const arc = circle('meter-ring-arc');
	arc.style.strokeDasharray = String(RING_LENGTH);
	arc.style.strokeDashoffset = String(RING_LENGTH);
	svg.append(circle('meter-ring-track'), arc);
	const node = el('div', {
		class: 'meter-ring',
		role: 'meter',
		'aria-label': label,
		'aria-valuemin': 0,
		'aria-valuemax': 100,
	}, [
		svg,
		icon(glyph),
	]);
	return {
		node,
		set(fraction: number) {
			const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
			arc.style.strokeDashoffset = String(RING_LENGTH * (1 - clamped));
			node.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
		},
	};
}

/** A loading placeholder (`wa-skeleton` rows). */
export function skeleton(rows = 3): HTMLElement {
	return el(
		'div',
		{ class: 'skeleton-group', 'aria-busy': 'true' },
		Array.from({ length: rows }, () => el('wa-skeleton', { class: 'skeleton', effect: 'sheen' })),
	);
}

// --- code ---------------------------------------------------------------------------------

const JSON_TOKEN = /("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty-printed, syntax-coloured JSON, built from text nodes and spans. */
export function jsonView(value: unknown): HTMLElement {
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined';
	const pre = el('pre', { class: 'code json' });
	let last = 0;
	for (const match of text.matchAll(JSON_TOKEN)) {
		const index = match.index ?? 0;
		if (index > last) pre.append(text.slice(last, index));
		const token = match[0];
		const kind = token.startsWith('"') ? (token.trimEnd().endsWith(':') ? 'k' : 's') : /\d/.test(token) ? 'n' : 'b';
		pre.append(el('span', { class: `j-${kind}`, text: token }));
		last = index + token.length;
	}
	if (last < text.length) pre.append(text.slice(last));
	return pre;
}

/** Text, pretty-printed as JSON when it parses as JSON. */
export function textView(text: string): HTMLElement {
	try {
		return jsonView(JSON.parse(text));
	} catch {
		return el('pre', { class: 'code', text });
	}
}

/**
 * Copies text, falling back to a selection copy where the async clipboard is unavailable.
 *
 * A LAN deployment served over plain HTTP is not a secure context, so
 * `navigator.clipboard` does not exist there at all.
 */
export async function copyText(text: string): Promise<void> {
	if (globalThis.isSecureContext && navigator.clipboard !== undefined) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const area = el('textarea', { class: 'offscreen', readonly: true });
	area.value = text;
	document.body.append(area);
	area.select();
	const copied = document.execCommand('copy');
	area.remove();
	if (!copied) throw new Error('Copy is not available in this browser');
}

/** A copy button for a value that is shown elsewhere. */
export function copyButton(value: () => string, label = 'Copy'): HTMLButtonElement {
	return iconButton('copy', label, () => {
		copyText(value()).then(() => toast('Copied', 'ok')).catch((cause) => toast(messageOf(cause), 'error'));
	}, { small: true });
}

// --- dialogs ---------------------------------------------------------------------------------

/** An open dialog: `close()` dismisses it (it is removed from the document once hidden). */
export interface ModalHandle {
	readonly node: WaDialog;
	close(): void;
}

/** A modal dialog (`wa-dialog`); closed by its button, Escape, or a click on the backdrop. */
export function openModal(title: string, body: Node[], wide = false): ModalHandle {
	const dialog = el('wa-dialog', { class: wide ? 'modal wide' : 'modal', label: title, 'light-dismiss': true }, [
		el('div', { class: 'modal-body' }, body),
	]);
	dialog.addEventListener('wa-after-hide', (event) => {
		// Nested kit overlays (a select's listbox, a tooltip) emit the same event; only the dialog's own ends it.
		if (event.target === dialog) dialog.remove();
	});
	document.body.append(dialog);
	requestAnimationFrame(() => (dialog.open = true));
	return {
		node: dialog,
		close: () => {
			dialog.open = false;
		},
	};
}

// --- time and size ------------------------------------------------------------------------------

/**
 * Runs `tick` every `ms` while `alive` is in the document and the tab is visible.
 *
 * Bound to a node rather than to `hashchange` because a re-render of the same
 * route replaces the screen without changing the hash; the old loop notices its
 * screen is gone and stops itself.
 */
export function poll(alive: Node, ms: number, tick: () => void): void {
	const timer = setInterval(() => {
		if (!alive.isConnected) clearInterval(timer);
		else if (!document.hidden) tick();
	}, ms);
}

/** "just now", "4m ago", "2h ago", or a date. */
export function relativeTime(iso: string | number): string {
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return '—';
	if (ms < 45_000) return 'just now';
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
	return new Date(iso).toLocaleDateString();
}

/** 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** An `<img>` for base64 image data. `img-src` allows `data:` in the page CSP. */
export function imageOf(base64: string, mimeType = 'image/png', alt = ''): HTMLImageElement {
	return el('img', { class: 'shot', src: `data:${mimeType};base64,${base64}`, alt });
}

// --- segmented switch, fact groups, meter bars, diffs, menus (run model-providers-ui) ---------------------

let factSerial = 0;

/** One choice of a {@linkcode segmented} switch. */
export interface SegmentedOption {
	readonly id: string;
	readonly label: string;
	readonly icon?: IconName;
}

/**
 * A segmented switch between a few named states — a `role=tablist` of `role=tab` buttons with `aria-selected`
 * on the active one. Worded by default (the Agents kind switch, the Resources Facts · Raw toggle); `worded=false`
 * keeps the icon-only form, where each label is the button's accessible name and tooltip.
 *
 * Left/Right (and Home/End) move the selection and the focus together; only the active tab is in the Tab order.
 * `set` paints a selection without reporting it, for a caller that changed state by another route.
 */
export function segmented(
	options: ReadonlyArray<SegmentedOption>,
	active: string,
	onChange: (id: string) => void,
	worded = true,
): { node: HTMLElement; set(id: string): void } {
	let current = active;
	const tabs = options.map((option) => {
		const node = button({
			label: option.label,
			icon: option.icon,
			variant: 'ghost',
			small: true,
			iconOnly: !worded,
			tip: 'top',
		});
		node.setAttribute('role', 'tab');
		node.setAttribute('data-id', option.id);
		return node;
	});
	const paint = (): void => {
		tabs.forEach((tab, index) => {
			const selected = options[index]?.id === current;
			tab.setAttribute('aria-selected', String(selected));
			tab.setAttribute('tabindex', selected ? '0' : '-1');
		});
	};
	const choose = (id: string, focus: boolean): void => {
		if (id === current) return;
		current = id;
		paint();
		if (focus) tabs[options.findIndex((option) => option.id === id)]?.focus();
		onChange(id);
	};
	tabs.forEach((tab, index) => on(tab, 'click', () => choose(options[index]?.id ?? current, false)));
	const node = el('div', { class: worded ? 'segmented worded' : 'segmented', role: 'tablist' }, tabs);
	on(node, 'keydown', (event) => {
		const index = options.findIndex((option) => option.id === current);
		const last = options.length - 1;
		let next = -1;
		if (event.key === 'ArrowRight') next = index >= last ? 0 : index + 1;
		else if (event.key === 'ArrowLeft') next = index <= 0 ? last : index - 1;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = last;
		if (next < 0) return;
		event.preventDefault();
		choose(options[next]?.id ?? current, true);
	});
	paint();
	return {
		node,
		set(id: string) {
			current = id;
			paint();
		},
	};
}

/** One row of a {@linkcode factGroup}: a key, its value, an optional explanation and optional tags beside it. */
export interface FactRow {
	readonly key: string;
	readonly value: string | Node;
	/** One sentence: the key's tooltip, also present for assistive technology. */
	readonly explain?: string;
	readonly tags?: Node[];
}

/**
 * A titled group of facts (`role=group`, named by its heading): key · value in mono · tags. An explanation is the
 * key's tooltip and a visually hidden sentence, never a paragraph (DESIGN-SYSTEM §1); the key is a tab stop when it
 * has one, so the tooltip is reachable from the keyboard.
 */
export function factGroup(title: string, rows: ReadonlyArray<FactRow>): HTMLElement {
	const id = `ttk-facts-${++factSerial}`;
	const body = rows.map((row) => {
		const key = el('span', { class: 'fact-key', text: row.key });
		const children: Node[] = [key];
		if (row.explain !== undefined && row.explain !== '') {
			tip(key, row.explain, 'top');
			key.setAttribute('tabindex', '0');
			children.push(el('span', { class: 'sr-only', text: row.explain }));
		}
		children.push(
			typeof row.value === 'string'
				? el('span', { class: 'fact-val mono', text: row.value })
				: el('span', { class: 'fact-val' }, [row.value]),
		);
		if (row.tags !== undefined && row.tags.length > 0) children.push(el('span', { class: 'fact-tags' }, row.tags));
		return el('div', { class: 'fact', role: 'listitem' }, children);
	});
	return el('section', { class: 'fact-group', role: 'group', 'aria-labelledby': id }, [
		el('h3', { id, class: 'fact-title', text: title }),
		el('div', { class: 'facts', role: 'list' }, body),
	]);
}

/**
 * A horizontal meter (`role=meter`): a label, a track whose fill the stylesheet draws from `--fill`, and the words
 * ("128 MB of 512 MB") as its value text. No glyph, so a column of them repeats nothing (D-092 amended).
 */
export function meterBar(label: string, fraction: number, words: string): HTMLElement {
	const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
	const fill = el('span', { class: 'meter-fill' });
	// A CSSOM write, which the page CSP allows; a style attribute would not be (D-089).
	fill.style.setProperty('--fill', String(clamped));
	return el('div', {
		class: `meter-bar${clamped >= 0.9 ? ' high' : ''}`,
		role: 'meter',
		'aria-label': label,
		'aria-valuemin': 0,
		'aria-valuemax': 100,
		'aria-valuenow': Math.round(clamped * 100),
		'aria-valuetext': words,
	}, [
		el('span', { class: 'meter-label', text: label }),
		el('span', { class: 'meter-track', 'aria-hidden': 'true' }, [fill]),
		el('span', { class: 'meter-words', text: words }),
	]);
}

/** One row of a {@linkcode diffView}: a key, what runs now (absent when not set or not reported), what is proposed. */
export interface DiffRow {
	readonly key: string;
	readonly before?: string;
	readonly after: string;
	readonly tags?: Node[];
}

/**
 * A table of changes — key, before, after, tags — under a polite live summary ("3 changes") that announces as the
 * rows are regenerated. Columns are `<th scope="col">`; an absent `before` reads "—" and "not set".
 */
export function diffView(rows: ReadonlyArray<DiffRow>): HTMLElement {
	const count = rows.length;
	const summary = el('p', {
		class: 'diff-summary',
		role: 'status',
		'aria-live': 'polite',
		text: count === 0 ? 'No changes' : count === 1 ? '1 change' : `${count} changes`,
	});
	if (count === 0) return el('div', { class: 'diff empty' }, [summary]);
	const tagged = rows.some((row) => row.tags !== undefined && row.tags.length > 0);
	const heads = ['Key', 'Before', 'After', ...(tagged ? ['Tags'] : [])];
	const head = el('thead', {}, [el('tr', {}, heads.map((text) => el('th', { scope: 'col', text })))]);
	const body = el(
		'tbody',
		{},
		rows.map((row) =>
			el('tr', { class: 'diff-row' }, [
				el('td', { class: 'diff-key mono', text: row.key }),
				row.before === undefined
					? el('td', { class: 'diff-before none' }, [
						el('span', { 'aria-hidden': 'true', text: '—' }),
						el('span', { class: 'sr-only', text: 'not set' }),
					])
					: el('td', { class: 'diff-before mono', text: row.before }),
				el('td', { class: 'diff-after mono', text: row.after }),
				...(tagged ? [el('td', { class: 'diff-tags' }, row.tags ?? [])] : []),
			])
		),
	);
	return el('div', { class: 'diff' }, [summary, el('table', { class: 'diff-table' }, [head, body])]);
}

/** One entry of a {@linkcode menuButton}. A disabled entry says why in its tooltip. */
export interface MenuItem {
	readonly label: string;
	readonly icon: IconName;
	readonly run: () => void;
	readonly disabled?: boolean;
	readonly reason?: string;
}

/**
 * A primary button that opens a `wa-popover` menu of worded buttons (the Resources "Add" menu). One primary for
 * several actions keeps a bar to a single loud control (D-092); the entries are ghost buttons, `role=menuitem`,
 * reached with Up/Down and closed by Escape, a click outside, or a choice.
 *
 * The popover is created when the menu opens and removed when it closes, inside the dialog or drawer its button
 * is in (a modal overlay makes the rest of the page inert), otherwise in the body.
 */
export function menuButton(label: string, glyph: IconName, items: ReadonlyArray<MenuItem>): HTMLButtonElement {
	const trigger = button({ label, icon: glyph, variant: 'primary' });
	trigger.classList.add('menu-trigger');
	trigger.append(icon('chevron-down', 'menu-caret'));
	trigger.setAttribute('aria-haspopup', 'menu');
	trigger.setAttribute('aria-expanded', 'false');
	let host: WaPopover | null = null;
	const close = (): void => {
		if (host === null) return;
		if (host.open) host.open = false;
		else host.remove();
	};
	on(trigger, 'click', () => {
		if (host !== null) {
			close();
			return;
		}
		const buttons: HTMLButtonElement[] = [];
		const entries = items.map((item) => {
			const node = button({ label: item.label, icon: item.icon, variant: 'ghost' });
			node.setAttribute('role', 'menuitem');
			node.disabled = item.disabled === true;
			on(node, 'click', () => {
				close();
				item.run();
			});
			buttons.push(node);
			// A disabled button receives no pointer events, so the tooltip with the reason sits on a wrapper.
			return item.disabled === true && item.reason !== undefined
				? tip(el('span', { class: 'menu-item-gate' }, [node]), item.reason, 'left')
				: node;
		});
		const menu = el('div', { class: 'menu-list', role: 'menu', 'aria-label': label }, entries);
		on(menu, 'keydown', (event) => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			event.preventDefault();
			const enabled = buttons.filter((node) => !node.disabled);
			const index = enabled.findIndex((node) => node === document.activeElement);
			const step = event.key === 'ArrowDown' ? 1 : -1;
			enabled[(index + step + enabled.length) % enabled.length]?.focus();
		});
		const popover = el('wa-popover', { class: 'menu-pop', placement: 'bottom-end', for: anchorId(trigger) }, [menu]);
		popover.addEventListener('wa-after-hide', (event) => {
			if (event.target !== popover) return;
			popover.remove();
			host = null;
			trigger.setAttribute('aria-expanded', 'false');
		});
		host = popover;
		(trigger.closest('wa-dialog, wa-drawer') ?? document.body).append(popover);
		trigger.setAttribute('aria-expanded', 'true');
		requestAnimationFrame(() => {
			popover.open = true;
			requestAnimationFrame(() => buttons.find((node) => !node.disabled)?.focus());
		});
	});
	return trigger;
}
