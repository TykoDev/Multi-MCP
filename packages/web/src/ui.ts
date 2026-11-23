/**
 * Shared UI primitives: buttons, confirmations, toasts, empty states, dialogs, form fields and a JSON viewer.
 *
 * Buttons are native `<button>` elements styled by the kit's native layer (`wa-brand`, `wa-plain`, …), so they keep
 * the whole `HTMLButtonElement` contract. Everything is built with `el`, so server strings reach the DOM as text only.
 * Tooltips are the browser's own `title`.
 */
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { onLeave } from './lifecycle.ts';

export interface ButtonOptions {
	readonly label: string;
	readonly icon?: IconName;
	readonly variant?: 'primary' | 'danger' | 'ghost';
	/** Show only the icon; the label becomes the accessible name and the tooltip. */
	readonly iconOnly?: boolean;
	readonly small?: boolean;
	readonly type?: 'button' | 'submit';
	readonly onClick?: (event: MouseEvent) => void;
}

const VARIANT_CLASSES: Record<string, string> = {
	primary: 'wa-brand',
	danger: 'wa-danger wa-filled wa-outlined',
	ghost: 'wa-neutral wa-plain',
	'': 'wa-neutral wa-filled wa-outlined',
};

export function button(options: ButtonOptions): HTMLButtonElement {
	const classes = ['ttk-btn', VARIANT_CLASSES[options.variant ?? ''], options.variant ?? ''];
	if (options.iconOnly) classes.push('icon-only');
	if (options.small) classes.push('sm wa-size-s');
	const node = el('button', {
		class: classes.filter(Boolean).join(' '),
		type: options.type ?? 'button',
		'aria-label': options.iconOnly ? options.label : undefined,
		title: options.iconOnly ? options.label : undefined,
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
		node.title = label;
	}
	if (iconName !== undefined) node.querySelector(':scope > svg.icon')?.replaceWith(icon(iconName));
}

/** Runs `work` with the button disabled and a spinner in its icon's place; the button is restored whatever happens. */
export async function busy<T>(node: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
	const glyph = node.querySelector(':scope > svg.icon');
	const spinner = el('wa-spinner', { class: 'btn-spinner', 'aria-hidden': 'true' });
	if (glyph !== null) glyph.replaceWith(spinner);
	else node.prepend(spinner);
	node.disabled = true;
	try {
		return await work();
	} finally {
		if (glyph !== null) spinner.replaceWith(glyph);
		else spinner.remove();
		node.disabled = false;
	}
}

/** Gives any element a tooltip (and, when it has none, an accessible name). */
export function tip<T extends HTMLElement>(node: T, text: string): T {
	node.title = text;
	if (!node.hasAttribute('aria-label') && node.textContent === '') node.setAttribute('aria-label', text);
	return node;
}

let anchorSerial = 0;

/**
 * Asks for confirmation in a popover anchored to `anchor`. Resolves true only on the explicit Confirm; Escape, a
 * click outside or Cancel resolve false.
 */
function confirmAt(anchor: HTMLElement, question: string): Promise<boolean> {
	if (anchor.id === '') anchor.id = `ttk-anchor-${++anchorSerial}`;
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: boolean): void => {
			if (settled) return;
			settled = true;
			resolve(value);
			if (host.open) host.open = false;
			else host.remove();
		};
		const yes = button({
			label: 'Confirm',
			icon: 'check',
			variant: 'danger',
			small: true,
			onClick: () => settle(true),
		});
		const no = button({ label: 'Cancel', variant: 'ghost', small: true, onClick: () => settle(false) });
		const host = el('wa-popover', { class: 'ttk-confirm', placement: 'bottom', for: anchor.id }, [
			el('div', { class: 'confirm-body', role: 'alertdialog', 'aria-label': question }, [
				el('span', { class: 'confirm-text', text: question }),
				el('div', { class: 'confirm-actions' }, [no, yes]),
			]),
		]);
		host.addEventListener('wa-after-hide', () => {
			settle(false);
			host.remove();
		});
		// A confirmation left open would float over the next screen, still armed.
		onLeave(() => settle(false));
		// A modal dialog makes everything outside it inert, so the popover lives inside the dialog its anchor is in.
		(anchor.closest('wa-dialog') ?? document.body).append(host);
		requestAnimationFrame(() => {
			host.open = true;
			requestAnimationFrame(() => yes.focus());
		});
	});
}

/** A destructive button that asks first, in a popover beside it. */
export function confirmButton(options: ButtonOptions, run: () => Promise<unknown>): HTMLButtonElement {
	const node = button({ variant: 'ghost', ...options });
	node.classList.add('destructive');
	on(node, 'click', () => {
		void confirmAt(node, `${options.label}?`).then((ok) => {
			if (ok) void busy(node, run).catch((cause) => toast(messageOf(cause), 'error'));
		});
	});
	return node;
}

let toastHost: HTMLElement | null = null;

/** A transient notice in the corner, announced politely to assistive technology. Text only. */
export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
	if (toastHost === null || !toastHost.isConnected) {
		toastHost = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
		document.body.append(toastHost);
	}
	const node = el('div', { class: `ttk-toast ${kind}` }, [
		icon(kind === 'ok' ? 'circle-check' : kind === 'error' ? 'alert' : 'info'),
		el('span', { class: 'toast-text', text: message }),
	]);
	toastHost.append(node);
	const leave = (): void => node.remove();
	on(node, 'click', leave);
	setTimeout(leave, kind === 'error' ? 7000 : 3500);
}

/** The message of anything thrown, for a toast or a notice. */
export function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** A placeholder for a list with nothing in it: a glyph, a title, an optional hint and one action. */
export function empty(glyph: IconName, title: string, hint = '', action?: HTMLElement): HTMLElement {
	return el('div', { class: 'empty' }, [
		el('span', { class: 'empty-glyph', 'aria-hidden': 'true' }, [icon(glyph)]),
		el('div', { class: 'empty-title', text: title }),
		...(hint === '' ? [] : [el('p', { class: 'empty-hint', text: hint })]),
		...(action === undefined ? [] : [action]),
	]);
}

/** A small label. */
export function badge(text: string, tone = ''): HTMLElement {
	return el('span', { class: `badge ${tone}`, text });
}

/** A status dot whose meaning is its tooltip and accessible name. */
export function dot(tone: string, meaning: string): HTMLElement {
	return el('span', { class: `dot ${tone}`, role: 'img', 'aria-label': meaning, title: meaning });
}

/** A notice line: why a screen shows less than it could. */
export function notice(text: string, tone = 'warn'): HTMLElement {
	return el('p', { class: `notice ${tone}`, role: 'status', text });
}

/** The Multi-MCP logo (`static/brand/`, CSP `img-src 'self'`); decorative wherever it sits. */
export function brandLogo(className: string): HTMLElement {
	return el('img', { class: className, src: '/assets/brand/multi-mcp-logo.png', alt: '', draggable: 'false' });
}

/** A labelled form field. */
export function field(id: string, label: string, control: HTMLElement, hint?: string): HTMLElement {
	return el('div', { class: 'field' }, [
		el('label', { for: id, text: label }),
		control,
		...(hint === undefined ? [] : [el('span', { class: 'field-hint', text: hint })]),
	]);
}

/** A text input with an id, a value and attributes. */
export function input(id: string, value = '', attrs: Record<string, string | number | boolean> = {}): HTMLInputElement {
	const node = el('input', { id, type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs });
	node.value = value;
	return node;
}

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

/** Copies text; a LAN deployment over plain http has no async clipboard, so a selection copy stands in. */
async function copyText(text: string): Promise<void> {
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

/** A copy button for a value. */
export function copyButton(value: () => string, label = 'Copy'): HTMLButtonElement {
	return iconButton('copy', label, () => {
		copyText(value()).then(() => toast('Copied', 'ok')).catch((cause) => toast(messageOf(cause), 'error'));
	}, { small: true });
}

/** An open dialog: `close()` dismisses it (it is removed once hidden). */
export interface ModalHandle {
	readonly node: WaDialog;
	close(): void;
}

/** A modal dialog; closed by its button, Escape, or a click on the backdrop. */
export function openModal(title: string, body: Node[], wide = false): ModalHandle {
	const dialog = el('wa-dialog', { class: wide ? 'modal wide' : 'modal', label: title, 'light-dismiss': true }, [
		el('div', { class: 'modal-body' }, body),
	]);
	dialog.addEventListener('wa-after-hide', (event) => {
		// Nested kit overlays emit the same event; only the dialog's own ends it.
		if (event.target === dialog) dialog.remove();
	});
	document.body.append(dialog);
	requestAnimationFrame(() => (dialog.open = true));
	// A dialog belongs to the screen that opened it.
	onLeave(() => dialog.remove());
	return {
		node: dialog,
		close: () => {
			dialog.open = false;
		},
	};
}

/**
 * Runs `tick` every `ms` while `alive` is in the document and the tab is visible: a re-render of the same route
 * replaces the screen without a hash change, and the old loop stops itself.
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
