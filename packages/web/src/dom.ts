/**
 * Tiny DOM helpers.
 *
 * Everything is built with `createElement` and `textContent`; `innerHTML` is
 * never used anywhere in this bundle, so page content and server strings can
 * never become markup.
 */

export type { KitElement } from './kit_types.ts';

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Attrs = {},
	children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === false) continue;
		if (key === 'class') node.className = String(value);
		else if (key === 'text') node.textContent = String(value);
		else if (key.startsWith('data-') || key === 'role' || key.startsWith('aria-')) {
			node.setAttribute(key, String(value));
		} else if (value === true) node.setAttribute(key, '');
		else node.setAttribute(key, String(value));
	}
	for (const child of children) {
		node.append(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
}

export function clear(node: Element): void {
	while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(node: Node): void {
	const app = document.getElementById('app');
	if (app === null) throw new Error('#app is missing from the document');
	clear(app);
	app.append(node);
}

export function on<K extends keyof HTMLElementEventMap>(
	node: HTMLElement | Window | Document,
	type: K,
	handler: (event: HTMLElementEventMap[K]) => void,
	options?: AddEventListenerOptions,
): () => void {
	const listener = handler as EventListener;
	node.addEventListener(type, listener, options);
	return () => node.removeEventListener(type, listener, options);
}
