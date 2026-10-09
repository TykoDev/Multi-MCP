/**
 * The Live View inspector: the session's MCP tools beside the screencast.
 *
 * Everything here is a `tools/call` through the same `/mcp` mount an agent
 * uses, so it obeys the same rules an agent does — most visibly the takeover
 * lock. While a human holds the session every *mutating* tool is refused by
 * the server, so those buttons are disabled with the reason on hover rather
 * than offered and then failed. Reads keep working; watching is what reading is.
 *
 * Only tools this credential is actually served appear: the list comes from
 * `tools/list`, which already omits what scope or deployment withholds.
 *
 * Presentation: a panel of collapsible `wa-details` sections, each headed by a
 * glyph; the actions are icon tiles whose names are their tooltips.
 */
import type WaDetails from '@awesome.me/webawesome/dist/components/details/details.js';
import type { ClientMsg, EventRecord, TabInfo } from '@tykotech/wire';
import { api, downloadFile } from './api.ts';
import { clear, el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { invoke, mcp } from './mcp.ts';
import {
	busy,
	button,
	confirmButton,
	copyButton,
	dot,
	empty,
	formatBytes,
	iconButton,
	imageOf,
	jsonView,
	messageOf,
	openModal,
	relabel,
	tip,
	toast,
} from './ui.ts';

export interface Inspector {
	readonly node: HTMLElement;
	/** A screenshot button for the viewer's toolbar; hidden until `browser_screenshot` is known to be served. */
	readonly capture: HTMLButtonElement;
	/** The resolved session id, once the ticket names it. */
	setSession(id: string): void;
	/** Lock state: `driving` is this viewer holding it, `locked` anyone at all. */
	setLock(locked: boolean, driving: boolean): void;
	/**
	 * Whether the session is known to exist for this credential: true once the view reached `meta`, false before and
	 * after the view ended for good (RV-2). Until then every control that calls the session is disabled.
	 */
	setReady(ready: boolean): void;
	/**
	 * FXD-N3: the view's socket reached `meta` — first or after a reconnect. A subscription belongs to one socket, so
	 * while the operator's toggle says "Streaming" the new socket is asked again; otherwise nothing is sent.
	 */
	socketReady(): void;
	setTabs(tabs: TabInfo[]): void;
	event(record: EventRecord): void;
}

interface Action {
	readonly tool: string;
	readonly label: string;
	readonly icon: IconName;
	readonly mutates: boolean;
	readonly run: (session: string, node: HTMLButtonElement) => Promise<void>;
}

const VIEWPORTS: ReadonlyArray<readonly [string, IconName, number, number, number]> = [
	['Desktop', 'desktop', 1280, 800, 1],
	['Laptop', 'laptop', 1440, 900, 1],
	['Tablet', 'tablet', 820, 1180, 2],
	['Mobile', 'phone', 390, 844, 3],
];

const MAX_EVENTS = 120;

/** Why a session control is disabled before the view has connected (RV-2). */
const WAITING = 'Waiting for the live view to connect to this session';

/** The glyph for an event kind's family (`download.done` → `download`). */
const EVENT_GLYPHS: Readonly<Record<string, IconName>> = {
	navigation: 'nav',
	dom: 'code',
	network: 'network',
	focus: 'pointer',
	input: 'keyboard',
	download: 'download',
	dialog: 'message',
	console: 'terminal',
	tab: 'tabs',
	control: 'control',
	gap: 'alert',
	bye: 'unplug',
};

/** The operator's event-stream choice, which outlives any one socket (FXD-N3). */
export interface EventStream {
	/** Whether the operator asked for the stream (the toggle's state). */
	readonly subscribed: boolean;
	/** Flips the choice and tells the current socket; returns the new state. */
	toggle(): boolean;
	/** A socket reached `meta`: re-sends the subscription when the operator asked for one, and nothing otherwise. */
	socketReady(): void;
}

/**
 * The Inspector's event-stream state, apart from its DOM so it is tested without one (`screens_test.ts`). The server
 * keeps a subscription per socket, so a reconnect starts unsubscribed: before FXD-N3 the toggle kept saying
 * "Streaming" over a new socket that was never asked, and no event arrived.
 */
export function eventStream(send: (message: ClientMsg) => void): EventStream {
	let subscribed = false;
	return {
		get subscribed() {
			return subscribed;
		},
		toggle() {
			subscribed = !subscribed;
			send(subscribed ? { type: 'events.subscribe' } : { type: 'events.unsubscribe' });
			return subscribed;
		},
		socketReady() {
			if (subscribed) send({ type: 'events.subscribe' });
		},
	};
}

/** A quiet one-line placeholder for a list with nothing in it yet. */
function none(glyph: IconName, text: string): HTMLElement {
	return el('div', { class: 'insp-none' }, [icon(glyph), el('span', { text })]);
}

/**
 * Keeps Enter and Space on a control in a section header for that control.
 *
 * `wa-details` toggles on those keys anywhere in its summary and prevents their
 * default, which would swallow the button's own activation.
 */
function headerControl<T extends HTMLElement>(node: T): T {
	on(node, 'keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
	});
	return node;
}

/** A field with a visually hidden label. */
function field(label: string, input: HTMLInputElement, extraClass = ''): HTMLElement {
	return el('label', { class: `insp-field ${extraClass}`.trim() }, [
		el('span', { class: 'sr-only', text: label }),
		input,
	]);
}

/** A collapsible inspector section (`wa-details`): a glyph, a title, and optional header controls. */
function section(title: string, glyph: IconName, body: Node[], open = true, extras: Node[] = []): WaDetails {
	return el('wa-details', { class: 'insp-section', appearance: 'plain', open }, [
		el('div', { slot: 'summary', class: 'insp-summary' }, [
			el('span', { class: 'insp-glyph', 'aria-hidden': 'true' }, [icon(glyph)]),
			el('span', { class: 'insp-title', text: title }),
			...extras.map((extra) => extra instanceof HTMLElement ? headerControl(extra) : extra),
		]),
		el('div', { class: 'insp-body' }, body),
	]);
}

/**
 * A section whose body is built the first time it is opened.
 *
 * Used for the sections that hold text inputs. Until the operator opens one,
 * the toolbar's address field is the only input on the viewer — which is what
 * a perceiving agent (and the SPA e2e suite) relies on when it looks for "the"
 * input to type a URL into. The page serializer does not list elements in DOM
 * order, so placing these after the toolbar in the document is not enough;
 * they must not exist yet. A closed details element does not hide its content
 * from that serializer either.
 */
function lazySection(title: string, glyph: IconName, build: () => Node[], extras: Node[] = []): WaDetails {
	const details = section(title, glyph, [], false, extras);
	let built = false;
	details.addEventListener('wa-show', (event) => {
		if (event.target !== details || built) return;
		built = true;
		details.querySelector('.insp-body')?.append(...build());
	});
	return details;
}

export function createInspector(send: (message: ClientMsg) => void, onClose?: () => void): Inspector {
	let session = 'default';
	let locked = false;
	let driving = false;
	let available = new Set<string>();
	let tabs: TabInfo[] = [];
	const stream = eventStream(send);
	/** Controls that change the session, which the server refuses while a human holds it. */
	const mutating = new Set<HTMLButtonElement>();
	/** The same, for controls rebuilt on every render; replaced wholesale rather than cleared. */
	let rendered = new Set<HTMLButtonElement>();
	/**
	 * Controls that call the session without changing it (reads, the event stream, the toolbar screenshot). Like the
	 * two sets above they wait for `ready` (RV-2): before the view reaches `meta` nothing says the session exists for
	 * this credential — in owner mode another principal's session answers like one that never existed — and a
	 * control that can only fail is not offered (D-092).
	 */
	const reads = new Set<HTMLButtonElement>();
	let ready = false;

	const output = el('div', { class: 'insp-output' }, [none('code', 'Results appear here')]);
	const outputSection = section('Output', 'code', [output], false);

	function show(title: string, value: unknown): void {
		clear(output);
		output.append(
			el('div', { class: 'insp-output-head' }, [
				el('span', { class: 'mono', text: title }),
				copyButton(() => JSON.stringify(value, null, 2)),
			]),
			jsonView(value),
		);
		outputSection.open = true;
		output.classList.remove('flash');
		void output.offsetWidth;
		output.classList.add('flash');
	}

	async function screenshot(fullPage: boolean): Promise<void> {
		const result = await mcp.call('browser_screenshot', { session_id: session, full_page: fullPage });
		const block = result.content?.find((part) => part.type === 'image');
		if (result.isError === true || block?.data === undefined) {
			throw new Error(result.content?.find((part) => part.type === 'text')?.text ?? 'No image returned');
		}
		const data = block.data;
		const mime = block.mimeType ?? 'image/png';
		const save = button({ label: 'Save PNG', icon: 'download', small: true });
		on(save, 'click', () => {
			const link = el('a', { href: `data:${mime};base64,${data}`, download: `${session}-${Date.now()}.png` });
			document.body.append(link);
			link.click();
			link.remove();
		});
		openModal(fullPage ? 'Full-page screenshot' : 'Screenshot', [
			imageOf(data, mime, `Screenshot of session ${session}`),
			el('div', { class: 'row end' }, [save]),
		], true);
	}

	// --- the toolbar's screenshot ---------------------------------------------
	const capture = iconButton('camera', 'Screenshot');
	capture.hidden = true;
	reads.add(capture);
	on(capture, 'click', () => {
		void busy(capture, () => screenshot(false)).catch((cause) => toast(messageOf(cause), 'error'));
	});

	let recording = false;
	const ACTIONS: Action[] = [
		{ tool: 'browser_screenshot', label: 'Screenshot', icon: 'camera', mutates: false, run: () => screenshot(false) },
		{ tool: 'browser_screenshot', label: 'Full page', icon: 'image', mutates: false, run: () => screenshot(true) },
		{
			tool: 'browser_get_state',
			label: 'Page state',
			icon: 'list',
			mutates: false,
			run: async (id) => show('browser_get_state', await invoke('browser_get_state', { session_id: id })),
		},
		{
			tool: 'browser_get_session',
			label: 'Session info',
			icon: 'info',
			mutates: false,
			run: async (id) => show('browser_get_session', await invoke('browser_get_session', { session_id: id })),
		},
		{
			tool: 'browser_get_frames',
			label: 'Frames',
			icon: 'tabs',
			mutates: false,
			run: async (id) => show('browser_get_frames', await invoke('browser_get_frames', { session_id: id })),
		},
		{
			tool: 'browser_audit',
			label: 'Audit log',
			icon: 'shield',
			mutates: false,
			run: async (id) => show('browser_audit', await invoke('browser_audit', { session_id: id })),
		},
		{
			tool: 'browser_go_back',
			label: 'Go back',
			icon: 'back',
			mutates: true,
			run: async (id) => {
				await invoke('browser_go_back', { session_id: id });
				toast('Went back one page', 'ok');
			},
		},
		{
			tool: 'browser_record',
			label: 'Record',
			icon: 'record',
			mutates: false,
			run: async (id, node) => {
				const result = await invoke<{ recording: boolean; url?: string }>('browser_record', {
					session_id: id,
					action: recording ? 'stop' : 'start',
				});
				recording = result.recording;
				node.classList.toggle('recording', recording);
				relabel(node, recording ? 'Stop recording' : 'Record');
				if (!recording && result.url !== undefined) {
					const url = result.url;
					toast('Recording saved — downloading', 'ok');
					await downloadFile(new URL(url, location.href).pathname, `${id}.webm`);
				} else toast(recording ? 'Recording started' : 'Recording stopped', 'ok');
			},
		},
	];

	const grid = el('div', { class: 'insp-actions' });
	function renderActions(): void {
		clear(grid);
		const usable = ACTIONS.filter((action) => available.has(action.tool));
		if (usable.length === 0) {
			grid.append(empty('tools', 'No browser tools', 'This credential is not served any session tools.'));
			return;
		}
		for (const action of usable) {
			const tile = iconButton(action.icon, action.label);
			tile.classList.add('insp-act');
			if (action.mutates) rendered.add(tile);
			else reads.add(tile);
			on(tile, 'click', () => {
				void busy(tile, () => action.run(session, tile)).catch((cause) => toast(messageOf(cause), 'error'));
			});
			grid.append(tile);
		}
		if (available.has('browser_close_session')) {
			const closeSession = confirmButton({ label: 'Close session', icon: 'power', iconOnly: true }, async () => {
				await invoke('browser_close_session', { session_id: session });
			});
			closeSession.classList.add('insp-act');
			rendered.add(closeSession);
			grid.append(closeSession);
		}
		syncLock();
	}

	// --- viewport -------------------------------------------------------------
	const width = el('input', { type: 'number', min: 200, max: 4096, value: 1280, 'aria-label': 'Viewport width' });
	const height = el('input', { type: 'number', min: 200, max: 4096, value: 800, 'aria-label': 'Viewport height' });
	const scale = el('input', {
		type: 'number',
		min: 1,
		max: 4,
		step: 0.25,
		value: 1,
		'aria-label': 'Device pixel ratio',
	});
	async function applyViewport(w: number, h: number, dpr: number, node: HTMLButtonElement): Promise<void> {
		await busy(node, async () => {
			await invoke('browser_set_viewport', { session_id: session, width: w, height: h, device_scale: dpr });
			toast(`Viewport set to ${w}×${h} @${dpr}x`, 'ok');
		}).catch((cause) => toast(messageOf(cause), 'error'));
	}
	const presets = el(
		'div',
		{ class: 'segmented insp-presets', role: 'group', 'aria-label': 'Viewport presets' },
		VIEWPORTS.map(([name, glyph, w, h, dpr]) => {
			const chip = iconButton(glyph, `${name} · ${w}×${h} @${dpr}x`, undefined, { small: true, tip: 'top' });
			mutating.add(chip);
			on(chip, 'click', () => {
				width.value = String(w);
				height.value = String(h);
				scale.value = String(dpr);
				void applyViewport(w, h, dpr, chip);
			});
			return chip;
		}),
	);
	const applyCustom = iconButton('check', 'Apply viewport', undefined, { small: true, variant: 'success' });
	mutating.add(applyCustom);
	on(
		applyCustom,
		'click',
		() => void applyViewport(Number(width.value), Number(height.value), Number(scale.value), applyCustom),
	);
	const viewportSection = lazySection('Viewport', 'viewport', () => [
		presets,
		el('div', { class: 'insp-row' }, [
			field('Width', width, 'num'),
			el('span', { class: 'insp-sep', 'aria-hidden': 'true', text: '×' }),
			field('Height', height, 'num'),
			el('span', { class: 'insp-sep', 'aria-hidden': 'true', text: '@' }),
			field('Device pixel ratio', scale, 'num small'),
			applyCustom,
		]),
	]);

	// --- tabs -----------------------------------------------------------------
	const tabList = el('div', { class: 'insp-list' });
	const tabCount = el('span', { class: 'insp-count', 'aria-label': '0 tabs', text: '0' });
	function renderTabList(): void {
		clear(tabList);
		rendered = new Set([...rendered].filter((control) => control.isConnected));
		tabCount.textContent = String(tabs.length);
		tabCount.setAttribute('aria-label', `${tabs.length} tabs`);
		if (tabs.length === 0) {
			tabList.append(none('tabs', 'No tabs reported yet'));
			return;
		}
		for (const tab of tabs) {
			const focus = iconButton('eye', 'Focus tab', undefined, { small: true });
			// Switching while driving goes over the socket; otherwise it is a tool call the lock refuses.
			focus.disabled = !ready || tab.focused || (locked && !driving);
			on(focus, 'click', () => {
				if (driving) {
					send({ type: 'tab.switch', tabId: tab.tabId });
					return;
				}
				void busy(focus, () => invoke('browser_switch_tab', { session_id: session, tab_id: tab.tabId })).catch((
					cause,
				) => toast(messageOf(cause), 'error'));
			});
			const close = iconButton('x', 'Close tab', undefined, { small: true });
			rendered.add(close);
			on(close, 'click', () => {
				void busy(close, () => invoke('browser_close_tab', { session_id: session, tab_id: tab.tabId })).catch((
					cause,
				) => toast(messageOf(cause), 'error'));
			});
			tabList.append(
				el('div', { class: `insp-item is-tab${tab.focused ? ' focused' : ''}` }, [
					el('span', { class: 'insp-pip', 'aria-hidden': 'true' }),
					el('div', { class: 'insp-meta' }, [
						el('div', { class: 'insp-name', text: tab.title || 'Untitled' }),
						el('div', { class: 'insp-sub mono', text: tab.url }),
					]),
					focus,
					close,
				]),
			);
		}
		syncLock();
	}

	// --- storage state --------------------------------------------------------
	const stateName = el('input', {
		type: 'text',
		placeholder: 'state name',
		maxlength: 64,
		'aria-label': 'Storage state name',
	});
	const saveState = iconButton('save', 'Save storage state', undefined, { small: true });
	const loadState = iconButton('upload', 'Load storage state', undefined, { small: true });
	mutating.add(saveState);
	mutating.add(loadState);
	for (const [node, action] of [[saveState, 'save'], [loadState, 'load']] as const) {
		on(node, 'click', () => {
			const name = stateName.value.trim();
			if (name === '') {
				toast('Name the storage state first', 'info');
				stateName.focus();
				return;
			}
			void busy(node, async () => {
				const result = await invoke<{ cookies: number; origins: number }>('browser_storage_state', {
					session_id: session,
					action,
					name,
				});
				toast(`${action === 'save' ? 'Saved' : 'Loaded'} ${result.cookies} cookies, ${result.origins} origins`, 'ok');
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
	}
	const storageHint = tip(
		el('span', { class: 'insp-hint', role: 'img' }, [icon('info')]),
		'Cookies and origin storage stay on the server; only counts come back.',
		'left',
	);
	const storageSection = lazySection('Storage state', 'cookie', () => [
		el('div', { class: 'insp-row' }, [field('Storage state name', stateName, 'grow'), saveState, loadState]),
	], [storageHint]);

	// --- downloads ------------------------------------------------------------
	const fileList = el('div', { class: 'insp-list' });
	const refreshFiles = iconButton('refresh', 'Refresh downloads', undefined, { small: true });
	interface FileRow {
		file_id: string;
		name: string;
		status: string;
		available: boolean;
		size: number;
		mime_type: string;
	}
	async function loadFiles(): Promise<void> {
		const { files } = await invoke<{ files: FileRow[] }>('browser_list_files', { session_id: session });
		clear(fileList);
		if (files.length === 0) {
			fileList.append(none('download', 'Nothing downloaded yet'));
			return;
		}
		for (const file of files) {
			const get = iconButton('download', `Download ${file.name}`, undefined, { small: true });
			get.disabled = !file.available;
			on(get, 'click', () => {
				void busy(get, () => downloadFile(api.sessionFilePath(session, file.file_id), file.name)).catch((cause) =>
					toast(messageOf(cause), 'error')
				);
			});
			fileList.append(
				el('div', { class: 'insp-item is-file' }, [
					el('span', { class: 'insp-file-glyph', 'aria-hidden': 'true' }, [icon('file')]),
					el('div', { class: 'insp-meta' }, [
						el('div', { class: 'insp-name', text: file.name }),
						el('div', { class: 'insp-sub', text: `${formatBytes(file.size)} · ${file.mime_type}` }),
					]),
					dot(file.available ? 'ok' : file.status === 'failed' ? 'danger' : 'warn', file.status),
					get,
				]),
			);
		}
	}
	on(
		refreshFiles,
		'click',
		() => void busy(refreshFiles, loadFiles).catch((cause) => toast(messageOf(cause), 'error')),
	);
	reads.add(refreshFiles);
	const filesSection = section('Downloads', 'download', [fileList], false, [refreshFiles]);
	filesSection.addEventListener('wa-show', (event) => {
		if (event.target !== filesSection || !ready) return;
		void loadFiles().catch((cause) => toast(messageOf(cause), 'error'));
	});

	// --- events ---------------------------------------------------------------
	const eventLog = el('ol', { class: 'insp-events', 'aria-live': 'off' });
	const eventCount = el('span', { class: 'insp-count', 'aria-label': '0 events', text: '0' });
	const countEvents = (): void => {
		const count = eventLog.childElementCount;
		eventCount.textContent = String(count);
		eventCount.setAttribute('aria-label', `${count} events`);
	};
	const streamToggle = iconButton('play', 'Stream events', undefined, { small: true });
	streamToggle.setAttribute('aria-pressed', 'false');
	// The stream rides the view's socket, which is not open before `meta`.
	reads.add(streamToggle);
	const clearEvents = iconButton('trash', 'Clear events', undefined, { small: true });
	on(streamToggle, 'click', () => {
		const subscribed = stream.toggle();
		streamToggle.classList.toggle('live', subscribed);
		streamToggle.setAttribute('aria-pressed', String(subscribed));
		relabel(streamToggle, subscribed ? 'Streaming' : 'Stream events', subscribed ? 'pause' : 'play');
	});
	on(clearEvents, 'click', () => {
		clear(eventLog);
		countEvents();
	});
	const eventsSection = section('Events', 'radio', [eventLog], false, [eventCount, streamToggle, clearEvents]);

	const sections = [
		section('Actions', 'tools', [grid]),
		viewportSection,
		section('Tabs', 'tabs', [tabList], true, [tabCount]),
		storageSection,
		filesSection,
		eventsSection,
		outputSection,
	];
	const head = el('div', { class: 'insp-head' }, [
		el('span', { class: 'insp-head-glyph', 'aria-hidden': 'true' }, [icon('inspect')]),
		el('h2', { text: 'Inspector' }),
		...(onClose === undefined ? [] : [iconButton('x', 'Close inspector', onClose, { small: true, tip: 'left' })]),
	]);
	const node = el('aside', { class: 'lv-inspector', 'aria-label': 'Session inspector' }, [
		head,
		el('div', { class: 'insp-scroll' }, sections),
	]);

	function syncLock(): void {
		for (const control of [...mutating, ...rendered]) {
			control.disabled = !ready || locked;
			if (!ready) control.title = WAITING;
			else if (locked) {
				control.title = driving
					? 'Release control to let tools act — the server refuses tool mutations while a human drives'
					: 'Someone is driving this session; tools that change it are refused until they release';
			} else control.removeAttribute('title');
		}
		for (const control of reads) {
			control.disabled = !ready;
			if (ready) control.removeAttribute('title');
			else control.title = WAITING;
		}
	}

	function gate(): void {
		viewportSection.hidden = !available.has('browser_set_viewport');
		storageSection.hidden = !available.has('browser_storage_state');
		filesSection.hidden = !available.has('browser_list_files');
		capture.hidden = !available.has('browser_screenshot');
	}

	mcp.tools().then((tools) => {
		available = new Set(tools.map((tool) => tool.name));
		gate();
		renderActions();
	}).catch((cause) => {
		available = new Set();
		gate();
		clear(grid);
		grid.append(empty('lock', 'Tools unavailable', messageOf(cause)));
	});
	renderTabList();

	return {
		node,
		capture,
		setSession(id) {
			session = id;
		},
		setLock(isLocked, isDriving) {
			locked = isLocked;
			driving = isDriving;
			renderTabList();
			syncLock();
		},
		setReady(next) {
			ready = next;
			renderTabList();
			syncLock();
		},
		socketReady() {
			stream.socketReady();
		},
		setTabs(next) {
			tabs = next;
			renderTabList();
		},
		event(record) {
			const time = new Date(record.at).toLocaleTimeString();
			const summary = JSON.stringify(record.payload);
			const family = record.kind.split('.')[0] ?? record.kind;
			eventLog.prepend(
				el('li', { class: `insp-event k-${family}` }, [
					el('span', { class: 'insp-ev-glyph', 'aria-hidden': 'true' }, [icon(EVENT_GLYPHS[family] ?? 'dot')]),
					el('span', { class: 'insp-ev-kind mono', text: record.kind }),
					el('span', { class: 'insp-ev-time mono', text: time }),
					el('span', {
						class: 'insp-ev-text mono',
						text: summary.length > 160 ? `${summary.slice(0, 160)}…` : summary,
					}),
				]),
			);
			while (eventLog.childElementCount > MAX_EVENTS) eventLog.lastElementChild?.remove();
			countEvents();
		},
	};
}
