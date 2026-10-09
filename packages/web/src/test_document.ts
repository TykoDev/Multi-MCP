/**
 * Test support only — never imported by the application: a minimal document for asserting what the primitives in
 * `ui.ts`, `json_facts.ts` and `schema_form.ts` build, without a browser. Enough of the DOM for `el()`, `icon()`,
 * attributes, text, classes, listeners and focus; it has no `innerHTML` and no parser, so a path through it that
 * needed one would throw rather than pass (the same construction as the fake in `a2ui_test.ts`, which stays private
 * to that file because importing a test module re-registers its tests).
 *
 * Not modelled: the kit's property getters. A `wa-select`'s `value` here is a plain property, while the real one
 * filters against an option cache rebuilt a microtask after `replaceChildren` and reads `''` until then (F-01); a
 * test that needs that reading blanks the property by hand (`task_composer_test.ts`). Nor `querySelector`: a
 * primitive that calls it (`busy()`) gets a per-instance stub from the test that drives it.
 */

export class FakeText {
	readonly parentNode: FakeElement | null = null;
	constructor(public data: string) {}
	get textContent(): string {
		return this.data;
	}
}

export interface FakeEventInit {
	readonly key?: string;
	readonly relatedTarget?: unknown;
}

export interface FakeEvent {
	readonly type: string;
	readonly target: FakeElement;
	readonly key: string;
	defaultPrevented: boolean;
	preventDefault(): void;
}

class FakeClassList {
	constructor(private readonly owner: FakeElement) {}
	private names(): string[] {
		return this.owner.className.split(' ').filter((name) => name !== '');
	}
	private write(names: string[]): void {
		this.owner.className = names.join(' ');
	}
	add(...names: string[]): void {
		this.write([...new Set([...this.names(), ...names])]);
	}
	remove(...names: string[]): void {
		this.write(this.names().filter((name) => !names.includes(name)));
	}
	contains(name: string): boolean {
		return this.names().includes(name);
	}
	toggle(name: string, force?: boolean): boolean {
		const on = force ?? !this.contains(name);
		if (on) this.add(name);
		else this.remove(name);
		return on;
	}
	replace(from: string, to: string): boolean {
		if (!this.contains(from)) return false;
		this.write(this.names().map((name) => name === from ? to : name));
		return true;
	}
}

export class FakeElement {
	readonly attributes = new Map<string, string>();
	childNodes: Array<FakeElement | FakeText> = [];
	parentNode: FakeElement | null = null;
	readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
	readonly classList = new FakeClassList(this);
	/** CSSOM writes land here (`meterBar` sets `--fill`). */
	readonly style = {
		properties: new Map<string, string>(),
		setProperty: (name: string, value: string): void => {
			this.style.properties.set(name, value);
		},
		getPropertyValue: (name: string): string => this.style.properties.get(name) ?? '',
	};
	disabled = false;
	open = false;
	checked = false;
	value: string | undefined = undefined;
	constructor(readonly tagName: string, readonly document: FakeDocument) {}

	get className(): string {
		return this.attributes.get('class') ?? '';
	}
	set className(value: string) {
		this.attributes.set('class', value);
	}
	get id(): string {
		return this.attributes.get('id') ?? '';
	}
	set id(value: string) {
		this.attributes.set('id', value);
	}
	get textContent(): string {
		return this.childNodes.map((child) => child.textContent).join('');
	}
	set textContent(value: string) {
		this.childNodes = value === '' ? [] : [new FakeText(value)];
	}
	get firstChild(): FakeElement | FakeText | null {
		return this.childNodes[0] ?? null;
	}
	get children(): FakeElement[] {
		return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
	}
	get isConnected(): boolean {
		return this === this.document.body || (this.parentNode?.isConnected ?? false);
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	private adopt(node: FakeElement | FakeText | string): FakeElement | FakeText {
		const child = typeof node === 'string' ? new FakeText(node) : node;
		if (child instanceof FakeElement) {
			child.remove();
			child.parentNode = this;
		}
		return child;
	}
	// Adopt first, then read `childNodes`: adopting a node this element already holds (a move, as the DOM allows)
	// replaces the array, and a push onto the array read before it would land on the discarded one.
	append(...nodes: Array<FakeElement | FakeText | string>): void {
		for (const node of nodes) {
			const child = this.adopt(node);
			this.childNodes.push(child);
		}
	}
	prepend(...nodes: Array<FakeElement | FakeText | string>): void {
		const adopted = nodes.map((node) => this.adopt(node));
		this.childNodes.unshift(...adopted);
	}
	replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void {
		for (const child of this.childNodes) if (child instanceof FakeElement) child.parentNode = null;
		this.childNodes = [];
		this.append(...nodes);
	}
	remove(): void {
		if (this.parentNode === null) return;
		this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this);
		this.parentNode = null;
	}
	replaceWith(node: FakeElement | FakeText): void {
		const parent = this.parentNode;
		if (parent === null) return;
		const index = parent.childNodes.indexOf(this);
		parent.childNodes[index] = parent.adopt(node);
		this.parentNode = null;
	}
	/** Tag-name selectors only (`'wa-dialog, wa-drawer'`), which is all the primitives ask for. */
	closest(selector: string): FakeElement | null {
		const tags = selector.split(',').map((part) => part.trim());
		if (tags.includes(this.tagName)) return this;
		return this.parentNode?.closest(selector) ?? null;
	}
	focus(): void {
		this.document.activeElement = this;
	}
	addEventListener(type: string, listener: (event: FakeEvent) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
	}
	/** Dispatches to this element's own listeners (no bubbling), returning the event. */
	fire(type: string, init: FakeEventInit = {}): FakeEvent {
		const event: FakeEvent = {
			type,
			target: this,
			key: init.key ?? '',
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
		};
		for (const listener of this.listeners.get(type) ?? []) listener(event);
		return event;
	}
}

export class FakeDocument {
	readonly body: FakeElement;
	activeElement: FakeElement | null = null;
	constructor() {
		this.body = new FakeElement('body', this);
	}
	createElement(tag: string): FakeElement {
		return new FakeElement(tag, this);
	}
	createElementNS(_namespace: string, tag: string): FakeElement {
		return new FakeElement(tag, this);
	}
	createTextNode(data: string): FakeText {
		return new FakeText(data);
	}
}

/** Runs `fn` with a fresh fake installed as `document` (and a synchronous `requestAnimationFrame`), restoring after. */
export function withDocument<T>(fn: (document: FakeDocument) => T): T {
	const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const priorFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
	const fake = new FakeDocument();
	Object.defineProperty(globalThis, 'document', { value: fake, configurable: true });
	Object.defineProperty(globalThis, 'requestAnimationFrame', {
		value: (callback: () => void): number => {
			callback();
			return 0;
		},
		configurable: true,
	});
	try {
		return fn(fake);
	} finally {
		if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
		else Object.defineProperty(globalThis, 'document', priorDocument);
		if (priorFrame === undefined) delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
		else Object.defineProperty(globalThis, 'requestAnimationFrame', priorFrame);
	}
}

/** Every element under `root`, root first, in document order. */
export function all(root: FakeElement): FakeElement[] {
	const out: FakeElement[] = [root];
	for (const child of root.children) out.push(...all(child));
	return out;
}

export function byTag(root: FakeElement, tag: string): FakeElement[] {
	return all(root).filter((node) => node.tagName === tag);
}

export function byClass(root: FakeElement, name: string): FakeElement[] {
	return all(root).filter((node) => node.classList.contains(name));
}

export function byRole(root: FakeElement, role: string): FakeElement[] {
	return all(root).filter((node) => node.getAttribute('role') === role);
}

/** The element a primitive returned, as the fake it is. */
export function fake(node: unknown): FakeElement {
	if (!(node instanceof FakeElement)) throw new Error('not a fake element');
	return node;
}
