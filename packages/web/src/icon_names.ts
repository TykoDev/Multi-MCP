/**
 * The SPA's icon vocabulary — data only, no DOM, so `scripts/build_icons.ts`
 * can import it under the server's type configuration. `icons.ts` re-exports it
 * with the `icon()` renderer.
 *
 * The vocabulary: Lucide glyphs (lucide-static 1.49, ISC) served as
 * one same-origin SVG sprite, `/assets/icons.svg`, that `scripts/build_icons.ts`
 * generates at build time from the names below.
 *
 * `icon()` renders `<svg><use href="/assets/icons.svg#name">` with
 * `createElementNS`, so no markup string reaches the DOM and the bundle carries
 * names, not geometry. Web Awesome's own icon libraries are pointed at the same
 * sprite in sprite-sheet mode (`kit.ts`): its fetch-and-parse path is never used
 * and nothing is fetched from a CDN. Stroke and size come from `.icon` in the
 * stylesheet, so a glyph's colour always follows the text it sits beside.
 */

/** App icon name → Lucide glyph name. `@` marks a glyph drawn in `CUSTOM_ICONS`. */
export const ICONS = {
	// Brand and sections
	logo: '@logo',
	sessions: 'layers',
	live: 'monitor-play',
	tools: 'zap',
	resources: 'database',
	library: 'library-big',
	workspace: 'square-terminal',
	agents: 'bot',
	users: 'users-round',
	system: 'activity',
	// Actions
	refresh: 'refresh-cw',
	power: 'power',
	reload: 'rotate-cw',
	plus: 'plus',
	minus: 'minus',
	play: 'play',
	pause: 'pause',
	stop: 'square',
	x: 'x',
	trash: 'trash',
	back: 'arrow-left',
	forward: 'arrow-right',
	up: 'arrow-up',
	down: 'arrow-down',
	'arrow-up-right': 'arrow-up-right',
	external: 'external-link',
	camera: 'camera',
	search: 'search',
	logout: 'log-out',
	login: 'log-in',
	copy: 'copy',
	download: 'download',
	upload: 'upload',
	'cloud-upload': 'cloud-upload',
	save: 'save',
	send: 'send',
	edit: 'square-pen',
	pen: 'pencil',
	undo: 'rotate-ccw',
	history: 'rotate-ccw',
	// The Tasks view's run history: a request arriving, and a log cut at its bound.
	inbox: 'inbox',
	scissors: 'scissors',
	filter: 'funnel',
	'list-filter': 'list-filter',
	command: 'command',
	menu: 'menu',
	more: 'ellipsis',
	'more-vertical': 'ellipsis-vertical',
	maximize: 'maximize',
	minimize: 'minimize',
	expand: 'expand',
	shrink: 'shrink',
	pin: 'pin',
	move: 'folder-input',
	grip: 'grip-vertical',
	settings: 'settings',
	// The configuration composer (run model-providers-ui).
	sliders: 'sliders-horizontal',
	// Run tool, the task composer's second kind.
	wrench: 'wrench',
	enter: 'corner-down-left',
	repeat: 'repeat-2',
	hash: 'hash',
	type: 'type',
	// Navigation and chevrons
	chevron: 'chevron-right',
	'chevron-left': 'chevron-left',
	'chevron-down': 'chevron-down',
	'chevron-up': 'chevron-up',
	'chevrons-up-down': 'chevrons-up-down',
	home: 'house',
	nav: 'compass',
	// People and access
	user: 'user-round',
	'user-plus': 'user-round-plus',
	'user-x': 'user-round-x',
	shield: 'shield',
	'shield-check': 'shield-check',
	'shield-alert': 'shield-alert',
	'shield-ban': 'shield-ban',
	'user-cog': 'user-round-cog',
	lock: 'lock',
	'lock-open': 'lock-open',
	key: 'key-round',
	'globe-lock': 'globe-lock',
	// Live view and input
	pointer: 'mouse-pointer-2',
	control: 'mouse-pointer-click',
	release: 'pointer-off',
	mouse: 'mouse',
	keyboard: 'keyboard',
	eye: 'eye',
	'eye-off': 'eye-off',
	viewport: 'scan',
	inspect: 'scan-search',
	tabs: 'app-window',
	panel: 'panel-right',
	columns: 'columns-2',
	phone: 'smartphone',
	tablet: 'tablet',
	laptop: 'laptop',
	desktop: 'monitor',
	record: 'circle-dot',
	cast: 'cast',
	radio: 'radio',
	bug: 'bug',
	network: 'network',
	cookie: 'cookie',
	// Status
	check: 'check',
	'circle-check': 'circle-check',
	'circle-x': 'circle-x',
	'circle-dashed': 'circle-dashed',
	'circle-pause': 'circle-pause',
	'circle-stop': 'circle-stop',
	loader: 'loader-circle',
	alert: 'triangle-alert',
	info: 'info',
	help: 'circle-question-mark',
	question: 'message-circle-question-mark',
	hourglass: 'hourglass',
	ban: 'ban',
	pulse: 'heart-pulse',
	dot: 'dot',
	signal: 'signal',
	clock: 'clock',
	timer: 'timer',
	calendar: 'calendar',
	toggle: 'toggle-right',
	'toggle-off': 'toggle-left',
	// System
	// The `metrics:read` scope's glyph (D-098): the counters' pulse.
	activity: 'activity',
	cpu: 'cpu',
	memory: 'memory-stick',
	disk: 'hard-drive',
	gauge: 'gauge',
	server: 'server',
	globe: 'globe',
	link: 'link',
	plug: 'plug',
	unplug: 'unplug',
	'wifi-off': 'wifi-off',
	package: 'package',
	container: 'container',
	box: 'box',
	rocket: 'rocket',
	orbit: 'orbit',
	moon: 'moon',
	sun: 'sun',
	// D-152: the Shade and Dawn themes.
	'cloud-moon': 'cloud-moon',
	sunrise: 'sunrise',
	// Files and content
	file: 'file',
	'file-text': 'file-text',
	'file-code': 'file-code',
	'file-json': 'file-braces',
	'file-image': 'file-image',
	'file-audio': 'file-music',
	'file-video': 'file-video-camera',
	'file-archive': 'file-archive',
	'file-spreadsheet': 'file-spreadsheet',
	'file-plus': 'file-plus',
	'file-search': 'file-search',
	'file-pen': 'file-pen',
	folder: 'folder',
	'folder-open': 'folder-open',
	'folder-plus': 'folder-plus',
	image: 'image',
	code: 'code',
	braces: 'braces',
	terminal: 'terminal',
	diff: 'git-compare',
	revision: 'git-commit-horizontal',
	list: 'list',
	'list-checks': 'list-checks',
	grid: 'layout-grid',
	rows: 'rows-3',
	// Arrays of objects in jsonFacts, and the surface builder's gallery.
	table: 'table',
	template: 'layout-template',
	book: 'book-open',
	tag: 'tag',
	// AI and agents
	sparkles: 'sparkles',
	wand: 'wand-sparkles',
	message: 'message-square-text',
	prompt: 'scroll-text',
	skills: 'blocks',
	surface: 'layout-dashboard',
	flask: 'flask-conical',
	// A model provider (the providers fact row) and a delegation to a peer agent.
	model: 'bot-message-square',
	delegate: 'arrow-right-left',
	// D-152: the agent surfaces in the Resources tree and System's Agents tab — A2A (a tower that answers peers),
	// peers (a route between points), the ACP bridge (a cable to a local agent), a provider's settings, a tool leaf.
	a2a: 'radio-tower',
	peers: 'waypoints',
	acp: 'cable',
	provider: 'server-cog',
	fn: 'square-function',
	webhook: 'webhook',
	'id-card': 'id-card',
	'shield-user': 'shield-user',
	'user-pen': 'user-round-pen',
	'funnel-x': 'funnel-x',
	'collapse-all': 'chevrons-down-up',
	'search-x': 'search-x',
	'plug-zap': 'plug-zap',
	'send-up': 'arrow-up',
	brain: 'brain-circuit',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;

/** One SVG child as Lucide's `icon-nodes.json` describes it: a tag and its attributes. */
export type IconNode = readonly [string, Readonly<Record<string, string>>];

/** Glyphs that are not Lucide's: the brand mark, two nested hexagons. */
export const CUSTOM_ICONS: Readonly<Record<string, readonly IconNode[]>> = {
	logo: [
		['path', { d: 'M12 2l8.7 5v10L12 22l-8.7-5V7z' }],
		['path', { d: 'M12 7.5l3.9 2.25v4.5L12 16.5l-3.9-2.25v-4.5z' }],
		['circle', { cx: '12', cy: '12', r: '1' }],
	],
};

/**
 * Web Awesome's internal icon names (its "system" library, Font Awesome names) → Lucide.
 *
 * Every name a Web Awesome component can request is listed, so a component never
 * shows a broken glyph. They are served under `wa-<name>` so they cannot collide
 * with the app's own names.
 */
export const SYSTEM_ICONS = {
	'angles-left': 'chevrons-left',
	'angles-right': 'chevrons-right',
	'arrow-down': 'arrow-down',
	'arrow-up': 'arrow-up',
	backward: 'rewind',
	'backward-step': 'skip-back',
	bars: 'menu',
	calendar: 'calendar',
	check: 'check',
	'chevron-down': 'chevron-down',
	'chevron-left': 'chevron-left',
	'chevron-right': 'chevron-right',
	circle: 'circle',
	'circle-question': 'circle-question-mark',
	'circle-xmark': 'circle-x',
	clock: 'clock',
	'closed-captioning': 'captions',
	'closed-captioning-slash': 'captions-off',
	compress: 'shrink',
	copy: 'copy',
	ellipsis: 'ellipsis',
	'ellipsis-vertical': 'ellipsis-vertical',
	expand: 'expand',
	eye: 'eye',
	'eye-slash': 'eye-off',
	eyedropper: 'pipette',
	file: 'file',
	'file-audio': 'file-music',
	'file-code': 'file-code',
	'file-excel': 'file-spreadsheet',
	'file-image': 'file-image',
	'file-pdf': 'file-text',
	'file-powerpoint': 'file-text',
	'file-video': 'file-video-camera',
	'file-word': 'file-text',
	'file-zipper': 'file-archive',
	filter: 'funnel',
	forward: 'fast-forward',
	'forward-step': 'skip-forward',
	gauge: 'gauge',
	gear: 'settings',
	'grip-vertical': 'grip-vertical',
	indeterminate: 'minus',
	'magnifying-glass': 'search',
	minus: 'minus',
	pause: 'pause',
	'picture-in-picture': 'picture-in-picture',
	play: 'play',
	'play-circle': 'circle-play',
	plus: 'plus',
	star: 'star',
	'table-columns': 'columns-2',
	thumbtack: 'pin',
	'up-down': 'chevrons-up-down',
	upload: 'upload',
	user: 'user-round',
	volume: 'volume-2',
	'volume-low': 'volume-1',
	'volume-xmark': 'volume-x',
	xmark: 'x',
} as const satisfies Record<string, string>;

/**
 * Glyphs for scopes, keyed by a scope's namespace and, where one namespace has
 * several scopes, its verb (`view:watch` → `view` → `watch`). The vocabulary
 * itself is declared once, in `packages/mcp/src/scopes.ts`, and reaches the SPA
 * from the server; this map only says how a namespace looks, so it is not a
 * second copy of the list (`scopes_test.ts` keeps it that way).
 */
export const SCOPE_GLYPHS: Readonly<Record<string, IconName | Readonly<Record<string, IconName>>>> = {
	mcp: 'plug',
	view: { watch: 'eye', control: 'control' },
	task: 'list-checks',
	admin: 'shield',
	evaluate: 'braces',
	sandbox: 'terminal',
	agent: 'agents',
	a2ui: 'surface',
	files: { read: 'file-search', write: 'file-pen' },
	metrics: 'activity',
	// S0 (design §2.2): `network:read`, W1's request URLs, headers and bodies.
	network: 'network',
	// D-143 (model-providers-ui): `model:invoke`, text tasks on a configured model provider.
	model: 'model',
};

/** The glyph for a scope; an unknown scope still gets a key. */
export function scopeIcon(scope: string): IconName {
	const [namespace = '', verb = ''] = scope.split(':');
	const entry = SCOPE_GLYPHS[namespace];
	if (entry === undefined) return 'key';
	return typeof entry === 'string' ? entry : entry[verb] ?? 'key';
}

/** Where the generated sprite is served (the gateway serves `dist/` under `/assets/`). */
export const SPRITE_URL = '/assets/icons.svg';
