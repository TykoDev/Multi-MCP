/// <reference lib="deno.ns" />
/**
 * D-111: the A2UI renderer against a minimal document — enough of the DOM for `el()`, `icon()` and the renderer,
 * which is the whole point: the renderer only ever creates elements, sets attributes and text, and listens. A fake
 * that lacks `innerHTML` and every parser proves by construction that no path through it needs one. Real Chromium
 * renders the same surfaces in `tests/e2e/a2ui_e2e_test.ts`.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { A2UI_CATALOG_ID, type A2uiComponent, type A2uiSurface } from '@tykotech/wire';
import {
	a2uiHtmlPath,
	contrastRatio,
	HTML_PLACEHOLDER_TEXT,
	inkOn,
	READ_ONLY_ACTION_TIP,
	releaseA2uiSurface,
	renderA2uiSurface,
	SHARE_BYTES_PER_SURFACE,
	SHARE_CONCURRENCY,
	textOn,
} from './a2ui.ts';
import { inWorkspace, releaseSurfaces, surfacesFor } from './workspace_surfaces.ts';

/** The least favourable light and dark surfaces the renderer derives inks against (`a2ui.ts`). */
const LIGHT_SURFACE = '#e4e5e9';
const DARK_SURFACE = '#2f323f';

class FakeText {
	constructor(public data: string) {}
	get textContent(): string {
		return this.data;
	}
}

class FakeElement {
	readonly attributes = new Map<string, string>();
	children: Array<FakeElement | FakeText> = [];
	readonly listeners = new Map<string, Array<(event: unknown) => void>>();
	readonly properties = new Map<string, string>();
	readonly style = {
		setProperty: (name: string, value: string): void => {
			this.properties.set(name, value);
		},
	};
	[key: string]: unknown;
	constructor(readonly tagName: string) {}
	set className(value: string) {
		this.attributes.set('class', value);
	}
	get className(): string {
		return this.attributes.get('class') ?? '';
	}
	set textContent(value: string) {
		this.children = value === '' ? [] : [new FakeText(value)];
	}
	get textContent(): string {
		return this.children.map((child) => child.textContent).join('');
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	append(...nodes: Array<FakeElement | FakeText | string>): void {
		for (const node of nodes) this.children.push(typeof node === 'string' ? new FakeText(node) : node);
	}
	addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	removeEventListener(): void {}
	fire(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this });
	}
}

const fakeDocument = {
	activeElement: null,
	createElement: (tag: string) => new FakeElement(tag),
	createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
	createTextNode: (data: string) => new FakeText(data),
};

/** Runs `fn` with the fake installed as `document`, restoring whatever was there. */
function withDocument<T>(fn: () => T): T {
	const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
	try {
		return fn();
	} finally {
		if (prior === undefined) delete (globalThis as { document?: unknown }).document;
		else Object.defineProperty(globalThis, 'document', prior);
	}
}

function all(root: FakeElement): FakeElement[] {
	const out: FakeElement[] = [root];
	for (const child of root.children) if (child instanceof FakeElement) out.push(...all(child));
	return out;
}
const byTag = (root: FakeElement, tag: string): FakeElement[] => all(root).filter((node) => node.tagName === tag);
const byClass = (root: FakeElement, name: string): FakeElement[] =>
	all(root).filter((node) => node.className.split(' ').includes(name));

const PNG = `data:image/png;base64,${btoa('png-bytes')}`;
const MP4 = `data:video/mp4;base64,${btoa('mp4-bytes')}`;
const OGG = `data:audio/ogg;base64,${btoa('ogg-bytes')}`;
const HTML = '<h1>Report</h1><script>parent.postMessage("ran","*")</script><img src=x onerror="alert(1)">';

function surface(components: unknown[], extra: Partial<A2uiSurface> = {}): A2uiSurface {
	return {
		surfaceId: 'demo',
		catalogId: A2UI_CATALOG_ID,
		revision: 3,
		components: components as A2uiComponent[],
		dataModel: { volume: 4, when: '2026-10-04', picked: ['b'], one: ['a'], name: 'Ada' },
		...extra,
	};
}

const EVERYTHING = [
	{
		id: 'root',
		component: 'Column',
		children: ['title', 'logo', 'glyph', 'mystery', 'items', 'tabs', 'modal', 'volume', 'volumeText', 'when'],
	},
	{ id: 'title', component: 'Text', text: '<script>alert(1)</script>', variant: 'h1' },
	{ id: 'logo', component: 'Image', url: PNG, description: { path: '/name' }, fit: 'contain', variant: 'avatar' },
	{ id: 'glyph', component: 'Icon', name: 'shield-check' },
	{ id: 'mystery', component: 'Icon', name: 'not-a-sprite-glyph' },
	{ id: 'items', component: 'List', children: ['one', 'two'], direction: 'vertical' },
	{ id: 'one', component: 'Text', text: 'first' },
	{ id: 'two', component: 'Text', text: 'second' },
	{ id: 'tabs', component: 'Tabs', tabs: [{ title: 'Pick', child: 'single' }, { title: 'Many', child: 'multi' }] },
	{
		id: 'single',
		component: 'ChoicePicker',
		label: 'One',
		options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
		value: { path: '/one' },
	},
	{
		id: 'multi',
		component: 'ChoicePicker',
		variant: 'multipleSelection',
		options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
		value: { path: '/picked' },
	},
	{ id: 'modal', component: 'Modal', trigger: 'open', content: 'media' },
	{ id: 'open', component: 'Button', text: 'Open media', action: { event: { name: 'noop', context: {} } } },
	{ id: 'media', component: 'Column', children: ['clip', 'sound', 'frame'] },
	{ id: 'clip', component: 'Video', url: MP4 },
	{ id: 'sound', component: 'AudioPlayer', url: OGG, description: 'Briefing' },
	{ id: 'frame', component: 'Html', html: HTML, height: 300, title: 'Quarterly report' },
	{ id: 'volume', component: 'Slider', label: 'Volume', min: 0, max: 10, step: 1, value: { path: '/volume' } },
	{ id: 'volumeText', component: 'Text', text: { path: '/volume' } },
	{ id: 'when', component: 'DateTimeInput', label: 'When', value: { path: '/when' } },
];

Deno.test('D-111: every new component renders through the kit mapping, with no markup and no foreign URL', () => {
	const root = withDocument(() =>
		renderA2uiSurface(surface(EVERYTHING), () => Promise.resolve()) as unknown as FakeElement
	);
	// Text stays text, whatever it looks like; an agent heading is a heading below the page's own.
	const title = byClass(root, 'a2ui-text')[0]!;
	assertEquals(title.textContent, '<script>alert(1)</script>');
	assertEquals(title.getAttribute('role'), 'heading');
	assertEquals(title.getAttribute('aria-level'), '3');
	assertEquals(byTag(root, 'script'), []);
	// Image: the data URL as is, no referrer, no srcset; the description is the alt text from the model.
	const [img] = byTag(root, 'img');
	assertEquals(img!.getAttribute('src'), PNG);
	assertEquals(img!.getAttribute('referrerpolicy'), 'no-referrer');
	assertEquals(img!.getAttribute('srcset'), null);
	assertEquals(img!.alt, 'Ada');
	assertStringIncludes(img!.className, 'fit-contain');
	// Icon: a sprite glyph; an unknown name draws the neutral glyph, not nothing and not the name as a URL.
	const icons = byClass(root, 'a2ui-icon');
	assertEquals(byTag(icons[0]!, 'use')[0]!.getAttribute('href'), '/assets/icons.svg#shield-check');
	assertEquals(byTag(icons[1]!, 'use')[0]!.getAttribute('href'), '/assets/icons.svg#help');
	assertStringIncludes(icons[1]!.className, 'unknown');
	// List: a role=list of role=listitem.
	const listNode = byClass(root, 'a2ui-list')[0]!;
	assertEquals(listNode.getAttribute('role'), 'list');
	assertEquals(listNode.children.map((child) => (child as FakeElement).getAttribute('role')), ['listitem', 'listitem']);
	// Tabs: the kit's tab group, one tab and one panel per entry, paired by name.
	const group = byTag(root, 'wa-tab-group')[0]!;
	assertEquals(byTag(group, 'wa-tab').map((tab) => tab.getAttribute('panel')), ['tabs-0', 'tabs-1']);
	assertEquals(byTag(group, 'wa-tab-panel').map((panel) => panel.getAttribute('name')), ['tabs-0', 'tabs-1']);
	assertEquals(byTag(group, 'wa-tab').map((tab) => tab.textContent), ['Pick', 'Many']);
	// ChoicePicker: single is a wa-select over indices; multiple is native checkboxes from the model.
	const select = byTag(root, 'wa-select')[0]!;
	assertEquals(byTag(select, 'wa-option').map((option) => option.getAttribute('value')), ['0', '1']);
	assertEquals(select.value, '0');
	const boxes = byClass(byClass(root, 'a2ui-choices')[0]!, 'a2ui-check');
	assertEquals(boxes.map((box) => box.checked), [false, true]);
	// Modal: a Button trigger becomes the opener (no button inside a button) and opens the kit dialog.
	const opener = byClass(root, 'a2ui-modal-trigger')[0]!;
	assertEquals(opener.tagName, 'button');
	assertEquals(byTag(opener, 'button').length, 1, 'the opener holds no button of its own');
	assertEquals(opener.textContent, 'Open media');
	const dialog = byTag(root, 'wa-dialog')[0]!;
	assertEquals(dialog.getAttribute('label'), 'Open media');
	assertEquals(dialog.open, undefined);
	opener.fire('click');
	assertEquals(dialog.open, true);
	// Players: native, with controls, from data: URLs, never autoplaying.
	const [video] = byTag(dialog, 'video');
	assertEquals([video!.getAttribute('src'), video!.getAttribute('controls')], [MP4, '']);
	assertEquals(video!.getAttribute('autoplay'), null);
	const [player] = byTag(dialog, 'audio');
	assertEquals([player!.getAttribute('src'), player!.getAttribute('aria-label')], [OGG, 'Briefing']);
	// Slider: a native range bounded by the component, initialised from the model and writing back to it.
	const range = byClass(root, 'a2ui-range')[0]!;
	assertEquals(
		[range.getAttribute('type'), range.getAttribute('min'), range.getAttribute('max'), range.value],
		['range', '0', '10', '4'],
	);
	range.value = '7';
	withDocument(() => range.fire('input'));
	assertEquals(byClass(root, 'a2ui-text').find((node) => node.textContent === '7') !== undefined, true);
	// DateTimeInput: the kit input; date-only by default.
	const when = byTag(root, 'wa-input')[0]!;
	assertEquals([when.getAttribute('type'), when.value, when.getAttribute('label')], ['date', '2026-10-04', 'When']);
});

Deno.test('D-111 (AC5): Html is a sandboxed frame over its route; the document itself is nowhere in the page', () => {
	const root = withDocument(() =>
		renderA2uiSurface(surface(EVERYTHING), () => Promise.resolve()) as unknown as FakeElement
	);
	const [frame] = byTag(root, 'iframe');
	assert(frame !== undefined);
	// The empty sandbox attribute is every restriction at once, and it is set before src.
	const keys = [...frame.attributes.keys()];
	assertEquals(frame.getAttribute('sandbox'), '');
	assert(keys.indexOf('sandbox') < keys.indexOf('src'), 'sandbox is applied before the frame has a source');
	assertEquals(frame.getAttribute('src'), '/api/v1/a2ui/surfaces/demo/html/frame');
	assertEquals(frame.getAttribute('src'), a2uiHtmlPath('demo', 'frame'));
	assertEquals(frame.getAttribute('referrerpolicy'), 'no-referrer');
	assertEquals(frame.getAttribute('loading'), 'lazy');
	assertEquals(frame.getAttribute('title'), 'Quarterly report');
	assertEquals(frame.getAttribute('height'), '300');
	assertEquals(frame.getAttribute('srcdoc'), null);
	// Not one attribute value or text node in the rendered tree carries the agent's markup.
	for (const node of all(root)) {
		for (const value of node.attributes.values()) assert(!value.includes('postMessage'), `${node.tagName} attr`);
		for (const child of node.children) {
			if (child instanceof FakeText) assert(!child.data.includes('postMessage'), `${node.tagName} text`);
		}
	}
	assertEquals(a2uiHtmlPath('a b', 'c/d'), '/api/v1/a2ui/surfaces/a%20b/html/c%2Fd');
});

Deno.test('D-111: a theme writes only its kit tokens on the surface root, and an unvalidated one is refused', () => {
	const themed = withDocument(() =>
		renderA2uiSurface(
			surface([{ id: 'root', component: 'Text', text: 'hi' }], {
				theme: { primaryColor: '#336699', font: 'serif', radius: 6, density: 'compact' },
			}),
			() => Promise.resolve(),
		) as unknown as FakeElement
	);
	assertEquals(Object.fromEntries(themed.properties), {
		'--a2ui-primary': '#336699',
		'--ttk-brand': '#336699',
		'--accent': '#336699',
		'--wa-color-brand-fill-loud': '#336699',
		'--wa-color-brand-border-loud': '#336699',
		// RV-1: derived at :root from the brand fill, so restated on the surface or checkboxes stay shell blue.
		'--wa-form-control-activated-color': '#336699',
		// RV-3: the label on the primary, by luminance.
		'--wa-color-brand-on-loud': '#ffffff',
		// RV-1: the primary as text, one ink per shell theme (agents.css picks it for the active tab label).
		'--a2ui-primary-ink-light': inkOn('#336699', LIGHT_SURFACE),
		'--a2ui-primary-ink-dark': inkOn('#336699', DARK_SURFACE),
		'--a2ui-font': "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
		'--wa-font-family-body': "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
		'--a2ui-radius': '6px',
		'--wa-border-radius-s': '6px',
		'--wa-border-radius-m': '6px',
		'--wa-border-radius-l': '6px',
		'--wa-form-control-border-radius': '6px',
		// RV-2: the dialog's panel radius is derived at :root too.
		'--wa-panel-border-radius': '6px',
		'--a2ui-gap': '6px',
		'--a2ui-pad': '8px',
	});
	// Below the root nothing is styled by the theme.
	for (const node of all(themed).slice(1)) assertEquals(node.properties.size, 0);
	const plain = withDocument(() =>
		renderA2uiSurface(
			surface([{ id: 'root', component: 'Text', text: 'hi' }]),
			() => Promise.resolve(),
		) as unknown as FakeElement
	);
	assertEquals(plain.properties.size, 0);
	// The renderer re-validates: a snapshot that skipped the schema cannot smuggle a CSS value in.
	assertThrows(() =>
		withDocument(() =>
			renderA2uiSurface(
				surface([{ id: 'root', component: 'Text', text: 'hi' }], {
					theme: { primaryColor: 'red; background: url(https://example.com/x)' } as never,
				}),
				() => Promise.resolve(),
			)
		)
	);
	assertThrows(() =>
		withDocument(() =>
			renderA2uiSurface(
				surface([{ id: 'root', component: 'Image', url: 'https://example.com/x.png' }]),
				() => Promise.resolve(),
			)
		)
	);
});

// --- share media (D-111, R3-4) ---------------------------------------------------------------------------------

/** A loader the test drives: every request is recorded with its signal and answered when the test says so. */
function scriptedShare() {
	const requests: Array<{ path: string; signal: AbortSignal; answer(response: Response): void }> = [];
	const fetchShare = (path: string, signal: AbortSignal): Promise<Response> =>
		new Promise<Response>((resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			requests.push({ path, signal, answer: resolve });
		});
	return { requests, fetchShare };
}

/** Lets every settled promise run its continuations. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const png = (bytes = 3, length: number | null = bytes): Response =>
	new Response(new Uint8Array(bytes), {
		headers: { 'content-type': 'image/png', ...(length === null ? {} : { 'content-length': String(length) }) },
	});

Deno.test('D-111: share media is read through the authenticated loader, shown from blob:, and released', async () => {
	const share = scriptedShare();
	const components = [
		{ id: 'root', component: 'Column', children: ['a', 'b'] },
		{ id: 'a', component: 'Image', url: 'ttk://share/charts/q3%20sales.png' },
		{ id: 'b', component: 'Video', url: 'ttk://share/clips/demo.webm' },
	];
	const root = withDocument(() =>
		renderA2uiSurface(surface(components), () => Promise.resolve(), {
			fetchShare: share.fetchShare,
		}) as unknown as FakeElement
	);
	await flush();
	assertEquals(share.requests.map((request) => request.path), ['charts/q3 sales.png', 'clips/demo.webm']);
	share.requests[0]!.answer(png());
	await flush();
	const [img] = byTag(root, 'img');
	assert(img!.getAttribute('src')?.startsWith('blob:'), 'the image is shown from an object URL');
	// Once released, the read still in flight is aborted, and nothing it would have made reaches the page.
	releaseA2uiSurface(root as unknown as Element);
	assert(share.requests[1]!.signal.aborted, 'R3-4: a released surface stops downloading');
	share.requests[1]!.answer(new Response(new Uint8Array(4)));
	await flush();
	assertEquals(byTag(root, 'video')[0]!.getAttribute('src'), null);
	assertEquals(byTag(root, 'video')[0]!.getAttribute('data-unavailable'), null, 'an abort is not a failure to show');
	// Without a loader, share media is marked unavailable and never given a src.
	const bare = withDocument(() =>
		renderA2uiSurface(surface(components), () => Promise.resolve()) as unknown as FakeElement
	);
	assertEquals(byTag(bare, 'img')[0]!.getAttribute('src'), null);
	assertEquals(byTag(bare, 'img')[0]!.getAttribute('data-unavailable'), 'true');
});

Deno.test('R3-4: one share path is fetched once per render however many components show it', async () => {
	const share = scriptedShare();
	const ids = Array.from({ length: 40 }, (_, i) => `img${i}`);
	const components = [
		{ id: 'root', component: 'Column', children: ids },
		...ids.map((id) => ({ id, component: 'Image', url: 'ttk://share/big/report.png' })),
	];
	const root = withDocument(() =>
		renderA2uiSurface(surface(components), () => Promise.resolve(), {
			fetchShare: share.fetchShare,
		}) as unknown as FakeElement
	);
	await flush();
	assertEquals(share.requests.length, 1, 'forty Images over one file are one download');
	share.requests[0]!.answer(png());
	await flush();
	const sources = new Set(byTag(root, 'img').map((img) => img.getAttribute('src')));
	assertEquals(sources.size, 1, 'and one object URL');
	assert([...sources][0]?.startsWith('blob:'));
	releaseA2uiSurface(root as unknown as Element);
});

Deno.test('R3-4: share reads run at most eight at a time, and the queue never starts once released', async () => {
	const share = scriptedShare();
	const ids = Array.from({ length: 12 }, (_, i) => `img${i}`);
	const components = [
		{ id: 'root', component: 'Column', children: ids },
		...ids.map((id, i) => ({ id, component: 'Image', url: `ttk://share/f${i}.png` })),
	];
	const root = withDocument(() =>
		renderA2uiSurface(surface(components), () => Promise.resolve(), {
			fetchShare: share.fetchShare,
		}) as unknown as FakeElement
	);
	await flush();
	assertEquals(SHARE_CONCURRENCY, 8);
	assertEquals(share.requests.length, 8, 'eight in flight, four queued');
	share.requests[0]!.answer(png());
	await flush();
	assertEquals(share.requests.length, 9, 'a finished read lets the next one start');
	releaseA2uiSurface(root as unknown as Element);
	await flush();
	assertEquals(share.requests.length, 9, 'nothing queued starts after release');
	assert(share.requests.slice(1).every((request) => request.signal.aborted));
});

Deno.test('R3-4: a surface downloads at most 32 MiB of share media; past it the placeholder shows', async () => {
	assertEquals(SHARE_BYTES_PER_SURFACE, 32 * 1024 * 1024);
	// A declared length that cannot fit is refused before a byte of its body is read.
	let pulled = 0;
	let cancelled = false;
	const huge = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				controller.enqueue(new Uint8Array(1024));
			},
			cancel() {
				cancelled = true;
			},
		}),
		{ headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) } },
	);
	const declared = scriptedShare();
	const one = withDocument(() =>
		renderA2uiSurface(
			surface([{ id: 'root', component: 'Image', url: 'ttk://share/huge.png' }]),
			() => Promise.resolve(),
			{ fetchShare: declared.fetchShare },
		) as unknown as FakeElement
	);
	await flush();
	declared.requests[0]!.answer(huge);
	await flush();
	assertEquals(byTag(one, 'img')[0]!.getAttribute('data-unavailable'), 'true');
	assertEquals(byTag(one, 'img')[0]!.getAttribute('src'), null);
	assert(cancelled, 'the body was cancelled');
	assert(pulled <= 1, `the body was not read (${pulled} pulls)`);
	assertStringIncludes(byClass(one, 'a2ui-notice')[0]!.textContent, '32 MiB');

	// A body with no length is counted as it arrives and cancelled the moment it would cross the allowance; the
	// next file then has nothing left either.
	const chunk = new Uint8Array(4 * 1024 * 1024);
	let sent = 0;
	let stopped = false;
	const unbounded = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += chunk.byteLength;
				controller.enqueue(chunk);
			},
			cancel() {
				stopped = true;
			},
		}),
		{ headers: { 'content-type': 'image/png' } },
	);
	const streamed = scriptedShare();
	const two = withDocument(() =>
		renderA2uiSurface(
			surface([
				{ id: 'root', component: 'Column', children: ['a', 'b'] },
				{ id: 'a', component: 'Image', url: 'ttk://share/endless.png' },
				{ id: 'b', component: 'Image', url: 'ttk://share/after.png' },
			]),
			() => Promise.resolve(),
			{ fetchShare: streamed.fetchShare },
		) as unknown as FakeElement
	);
	await flush();
	streamed.requests[0]!.answer(unbounded);
	for (let i = 0; i < 40 && !stopped; i++) await flush();
	assert(stopped, 'the endless body was cancelled');
	assert(sent <= SHARE_BYTES_PER_SURFACE + 2 * chunk.byteLength, `read ${sent} bytes`);
	streamed.requests[1]!.answer(png(16, null));
	await flush();
	const [first, second] = byTag(two, 'img');
	assertEquals(first!.getAttribute('data-unavailable'), 'true');
	assertEquals(second!.getAttribute('data-unavailable'), 'true', 'the allowance is spent for the whole surface');
	releaseA2uiSurface(two as unknown as Element);
	releaseA2uiSurface(one as unknown as Element);
});

Deno.test('R3-4: leaving the Agents screen (or a failed load) releases every surface it rendered', async () => {
	const share = scriptedShare();
	const revoked: string[] = [];
	const revoke = URL.revokeObjectURL;
	URL.revokeObjectURL = (url: string) => void revoked.push(url);
	try {
		const nodes = new Map<string, { surface: Element }>();
		for (const surfaceId of ['one', 'two']) {
			const rendered = withDocument(() =>
				renderA2uiSurface(
					surface([
						{ id: 'root', component: 'Column', children: ['shown', 'loading'] },
						{ id: 'shown', component: 'Image', url: `ttk://share/${surfaceId}/shown.png` },
						{ id: 'loading', component: 'Image', url: `ttk://share/${surfaceId}/loading.png` },
					], { surfaceId }),
					() => Promise.resolve(),
					{ fetchShare: share.fetchShare },
				)
			);
			nodes.set(surfaceId, { surface: rendered as unknown as Element });
		}
		await flush();
		for (const request of share.requests.filter((request) => request.path.endsWith('shown.png'))) {
			request.answer(png());
		}
		await flush();
		releaseSurfaces(nodes, releaseA2uiSurface);
		assertEquals(nodes.size, 0, 'forgotten, so the next load renders afresh');
		assertEquals(revoked.length, 2, 'both object URLs revoked');
		assert(share.requests.every((request) => request.signal.aborted), 'every read aborted');
		// The panel calls it from both places: its teardown, and the failed-load branch before the placeholder.
		const view = await Deno.readTextFile(new URL('./workspace_surfaces.ts', import.meta.url));
		const stop = view.slice(view.indexOf('stop: (): void => {'));
		assert(stop.slice(0, stop.indexOf('},')).includes('releaseSurfaces(surfaceNodes'), 'stop releases the surfaces');
		const failed = view.slice(view.indexOf('} catch (cause) {', view.indexOf('async function load(')));
		assert(
			failed.indexOf('releaseSurfaces(surfaceNodes') !== -1 &&
				failed.indexOf('releaseSurfaces(surfaceNodes') < failed.indexOf('list.replaceChildren()'),
			'a failed load releases before it replaces',
		);
	} finally {
		URL.revokeObjectURL = revoke;
	}
});

// --- theme colours (RV-1, RV-3) -------------------------------------------------------------------------------

Deno.test('RV-3: a Button label is black or white by luminance, and always readable', () => {
	assertEquals(contrastRatio('#000000', '#ffffff'), 21);
	// The rendered-verification colour: white was 3.1:1 on it; black is 6.8:1.
	assertEquals(textOn('#e76f51'), '#000000');
	assert(contrastRatio('#e76f51', '#000000') > 6.5);
	assertEquals(textOn('#336699'), '#ffffff');
	assertEquals(textOn('#ffd166'), '#000000', 'a light primary gets a dark label');
	// Every colour the schema admits gets a label of at least 4.5:1 (the worst case is about 4.58:1).
	let worst = 21;
	for (let r = 0; r < 256; r += 15) {
		for (let g = 0; g < 256; g += 15) {
			for (let b = 0; b < 256; b += 15) {
				const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
				worst = Math.min(worst, contrastRatio(hex, textOn(hex)));
			}
		}
	}
	assert(worst >= 4.5, `worst label contrast ${worst.toFixed(2)}:1`);
});

Deno.test('RV-1: the primary used as text keeps its hue and reaches 4.5:1 on its theme surfaces', () => {
	for (const primary of ['#e76f51', '#ffd166', '#336699', '#06d6a0', '#7b2cbf', '#000000', '#ffffff']) {
		const light = inkOn(primary, LIGHT_SURFACE);
		const dark = inkOn(primary, DARK_SURFACE);
		assert(contrastRatio(light, LIGHT_SURFACE) >= 4.5, `${primary} -> ${light} on light`);
		assert(contrastRatio(dark, DARK_SURFACE) >= 4.5, `${primary} -> ${dark} on dark`);
		// The light reference is darker than every light surface, so the ink holds on the white card too.
		assert(contrastRatio(light, '#ffffff') >= 4.5, `${primary} -> ${light} on the light card`);
	}
	// A colour already readable is used as is.
	assertEquals(inkOn('#336699', LIGHT_SURFACE), '#336699');
	// A light one is darkened toward black, not replaced: its channels keep their order.
	const ink = inkOn('#e76f51', LIGHT_SURFACE);
	const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(ink.slice(offset, offset + 2), 16)) as [
		number,
		number,
		number,
	];
	assert(r > g && g > b, `${ink} keeps the hue`);
});

Deno.test('D-136: the MCP Apps embed mode renders every component read-only, kit-free and fetching nothing', () => {
	const sent: unknown[] = [];
	const components = [
		...EVERYTHING.map((component) =>
			component.id === 'root' ? { ...component, children: [...(component.children ?? []), 'form', 'share'] } : component
		),
		{ id: 'form', component: 'Row', children: ['name', 'agree', 'go'] },
		{ id: 'name', component: 'TextField', label: 'Name', value: { path: '/name' } },
		{ id: 'agree', component: 'CheckBox', label: 'Agree', value: { path: '/agree' } },
		{ id: 'go', component: 'Button', text: 'Submit', action: { event: { name: 'submit', context: {} } } },
		{ id: 'share', component: 'Image', url: 'ttk://share/charts/q3.png' },
	];
	const root = withDocument(() =>
		renderA2uiSurface(
			surface(components, { availableActions: ['go:submit', 'open:noop'] }),
			(action) => {
				sent.push(action);
				return Promise.resolve();
			},
			{ interactive: false, kit: false },
		) as unknown as FakeElement
	);
	const nodes = all(root);
	// Kit-free: no Web Awesome element, no sprite reference, no frame over this origin's route.
	assertEquals(nodes.filter((node) => node.tagName.startsWith('wa-')).map((node) => node.tagName), []);
	assertEquals(byTag(root, 'use'), [], 'Icon draws no glyph without the sprite');
	assertEquals(byClass(root, 'a2ui-icon').map((node) => node.getAttribute('aria-label')), [
		'shield-check',
		'not-a-sprite-glyph',
	]);
	assertEquals(byTag(root, 'iframe'), []);
	const html = byClass(root, 'a2ui-html')[0]!;
	assertEquals([html.getAttribute('role'), html.textContent], ['note', HTML_PLACEHOLDER_TEXT]);
	for (const node of nodes) {
		for (const value of node.attributes.values()) assert(!value.includes('postMessage'), 'the agent document leaked');
	}
	// Tabs and Modal are native disclosures; the first tab is open.
	const tabs = byClass(root, 'a2ui-tab');
	assertEquals(tabs.map((tab) => byTag(tab, 'summary')[0]!.textContent), ['Pick', 'Many']);
	assertEquals(tabs.map((tab) => tab.getAttribute('open')), ['', null]);
	const modal = byClass(root, 'a2ui-modal')[0]!;
	assertEquals([modal.tagName, byTag(modal, 'summary')[0]!.textContent], ['details', 'Open media']);
	// Read-only: every Button is disabled with the reason, whatever the server authorized, and sends nothing.
	const buttons = byClass(root, 'a2ui-button');
	assert(buttons.length >= 1);
	for (const button of buttons) {
		assertEquals([button.disabled, button.title], [true, READ_ONLY_ACTION_TIP]);
		assertEquals(button.listeners.get('click'), undefined);
	}
	// Inputs show the model and cannot change it: text read-only, checkbox, choices and range disabled.
	const text = byClass(root, 'a2ui-input').find((node) => node.getAttribute('type') === 'text')!;
	assertEquals([text.value, text.readOnly, text.listeners.size], ['Ada', true, 0]);
	const agree = byClass(root, 'a2ui-check').find((node) => node.getAttribute('id') === 'a2ui-demo-agree')!;
	assertEquals(agree.disabled, true);
	const select = byTag(root, 'select')[0]!;
	assertEquals([select.value, select.disabled], ['0', true]);
	assertEquals(byTag(select, 'option').map((option) => option.textContent), ['Choose…', 'A', 'B']);
	const boxes = byClass(byClass(root, 'a2ui-choices')[0]!, 'a2ui-check');
	assertEquals(boxes.map((box) => [box.checked, box.disabled]), [[false, true], [true, true]]);
	const range = byClass(root, 'a2ui-range')[0]!;
	assertEquals([range.value, range.disabled, range.listeners.size], ['4', true, 0]);
	range.value = '9';
	withDocument(() => range.fire('input'));
	assert(byClass(root, 'a2ui-text').some((node) => node.textContent === '4'), 'the model did not move');
	const when = byClass(root, 'a2ui-datetime')[0]!;
	assertEquals([when.tagName, when.getAttribute('type'), when.value, when.readOnly], [
		'input',
		'date',
		'2026-10-04',
		true,
	]);
	// Media: an inline image still shows; players and share files are notes that load nothing (RV-6).
	assertEquals(byTag(root, 'img').map((img) => img.getAttribute('src')), [PNG]);
	assertEquals([...byTag(root, 'video'), ...byTag(root, 'audio')], [], 'no player that could never play');
	const notes = byClass(root, 'a2ui-media-placeholder');
	assertEquals(
		notes.map((note) => [note.className, note.getAttribute('role'), note.getAttribute('data-unavailable')]),
		[
			['a2ui-media-placeholder video', 'note', 'true'],
			['a2ui-media-placeholder audio', 'note', 'true'],
			['a2ui-media-placeholder image', 'note', 'true'],
		],
	);
	assertEquals(byClass(root, 'a2ui-caption')[0]!.textContent, 'Briefing', 'the audio description still shows');
	assertEquals(sent, []);
});

Deno.test('RV-6: kit-free, a share Image is the media note, and every caption sits inside its own note', () => {
	const components = [
		{ id: 'root', component: 'Column', children: ['chart', 'logo', 'sound', 'clip'] },
		{ id: 'chart', component: 'Image', url: 'ttk://share/charts/q3.png', description: 'Q3 revenue' },
		{ id: 'logo', component: 'Image', url: PNG, description: 'Logo' },
		{ id: 'sound', component: 'AudioPlayer', url: OGG, description: 'Briefing' },
		{ id: 'clip', component: 'Video', url: MP4 },
	];
	const root = withDocument(() =>
		renderA2uiSurface(surface(components), () => Promise.resolve(), {
			interactive: false,
			kit: false,
		}) as unknown as FakeElement
	);
	// The share file has no credential here, so there is no <img> to leave blank: a note says where it is shown.
	assertEquals(byTag(root, 'img').map((img) => [img.getAttribute('src'), img.alt]), [[PNG, 'Logo']]);
	const [video, audio, image] = ['video', 'audio', 'image'].map((kind) =>
		byClass(root, 'a2ui-media-placeholder').filter((note) => note.className.split(' ').includes(kind))
	);
	assertEquals([video!.length, audio!.length, image!.length], [1, 1, 1]);
	assertEquals([image![0]!.getAttribute('role'), image![0]!.getAttribute('data-unavailable')], ['note', 'true']);
	assertStringIncludes(image![0]!.textContent, 'Image is shown in the control plane');
	// Each caption is inside the note it describes, so it cannot read as the caption of whatever comes next.
	const captions = byClass(root, 'a2ui-caption');
	assertEquals(captions.map((caption) => caption.textContent), ['Q3 revenue', 'Briefing']);
	assertEquals(byClass(image![0]!, 'a2ui-caption').map((caption) => caption.textContent), ['Q3 revenue']);
	assertEquals(byClass(audio![0]!, 'a2ui-caption').map((caption) => caption.textContent), ['Briefing']);
	assertStringIncludes(audio![0]!.textContent, 'Audio is played in the control plane');
	assertEquals(byClass(video![0]!, 'a2ui-caption'), []);
	// The SPA keeps its players and loads the share file through its own credential, as before.
	const share = scriptedShare();
	const spa = withDocument(() =>
		renderA2uiSurface(surface(components), () => Promise.resolve(), {
			fetchShare: share.fetchShare,
		}) as unknown as FakeElement
	);
	assertEquals(byClass(spa, 'a2ui-media-placeholder'), []);
	assertEquals(byTag(spa, 'img').length, 2);
	assertEquals([byTag(spa, 'audio').length, byTag(spa, 'video').length], [1, 1]);
	releaseA2uiSurface(spa as unknown as Element);
});

Deno.test('workspace surfaces: a surface is shown under its workspace, loose ones are offered, the builder creates in it', () => {
	const surface = (surfaceId: string, workspaceId?: string): A2uiSurface => ({
		surfaceId,
		catalogId: A2UI_CATALOG_ID,
		revision: 1,
		components: [],
		dataModel: {},
		...(workspaceId === undefined ? {} : { workspaceId }),
	});
	const here = '2276732b-a79d-436f-9cea-1a80b68a06b2';
	const there = '6d1527ec-24ea-437f-8905-933b447a6f61';
	const split = surfacesFor([surface('a', here), surface('b', there), surface('c'), surface('d', here)], here);
	assertEquals(split.attached.map((entry) => entry.surfaceId), ['a', 'd']);
	assertEquals(split.loose.map((entry) => entry.surfaceId), ['c']);
	assertEquals(
		inWorkspace({ version: 'v0.9', createSurface: { surfaceId: 's', catalogId: A2UI_CATALOG_ID } }, here),
		{ version: 'v0.9', createSurface: { workspaceId: here, surfaceId: 's', catalogId: A2UI_CATALOG_ID } },
	);
	// A message naming its own workspace keeps it; other operations pass through untouched.
	const own = { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: A2UI_CATALOG_ID, workspaceId: there } };
	assertEquals((inWorkspace(own, here) as typeof own).createSurface.workspaceId, there);
	const update = { version: 'v0.9', updateDataModel: { surfaceId: 's', value: {} } };
	assertEquals(inWorkspace(update, here), update);
});

Deno.test('formatString and formatNumber: a Slider and a TextField drive computed text and a lookup on the page', () => {
	const roman = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
	const root = withDocument(() =>
		renderA2uiSurface(
			surface([
				{ id: 'root', component: 'Column', children: ['n', 'shown', 'typed', 'back', 'money'] },
				{ id: 'n', component: 'Slider', label: 'Number', min: 1, max: 7, step: 1, value: { path: '/number' } },
				{
					id: 'shown',
					component: 'Text',
					text: { call: 'formatString', args: { value: '${/number} = ${/roman/${/number}}' } },
				},
				{ id: 'typed', component: 'TextField', label: 'Numeral', value: { path: '/numeral' } },
				{ id: 'back', component: 'Text', text: { call: 'formatString', args: { value: '${/arabic/${/numeral}}' } } },
				{
					id: 'money',
					component: 'Text',
					text: { call: 'formatNumber', args: { value: { path: '/number' }, decimals: 2, grouping: false } },
				},
			], { dataModel: { number: 4, roman, arabic: { IV: 4, VI: 6 }, numeral: 'IV' } }),
			() => Promise.resolve(),
		) as unknown as FakeElement
	);
	const texts = () => byClass(root, 'a2ui-text').map((node) => node.textContent);
	assertEquals(texts()[0], '4 = IV');
	assertEquals(texts()[1], '4');
	assertStringIncludes(texts()[2]!, '4');
	const range = byClass(root, 'a2ui-range')[0]!;
	range.value = '6';
	withDocument(() => range.fire('input'));
	assertEquals(texts()[0], '6 = VI', 'moving the slider recomputes the text bound to it');
	const field = byClass(root, 'a2ui-input')[0]!;
	field.value = 'VI';
	withDocument(() => field.fire('input'));
	assertEquals(texts()[1], '6', 'typing a numeral looks it up');
	field.value = 'nope';
	withDocument(() => field.fire('input'));
	assertEquals(texts()[1], '', 'a numeral the table does not hold reads as nothing');
});
