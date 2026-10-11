/// <reference lib="deno.ns" />
/**
 * Web-package tests.
 *
 * The DOM-dependent modules are exercised through their pure seams; the
 * rendering itself is covered by the browser-tier e2e run.
 *
 * The package's `lib` is browser-only so a stray `Deno.*` in the bundle fails
 * to compile; this file opts back into the runtime types it needs to read its
 * own sources.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ClientMsgSchema, decodeFrame, encodeFrame } from '@tykotech/wire';
import { retryAfterMsOf } from './api.ts';
import { leaveScreen, onLeave, onSignOut, signOut } from './lifecycle.ts';
import nodes from 'lucide-static/icon-nodes.json' with { type: 'json' };
import { CUSTOM_ICONS, ICONS, SCOPE_GLYPHS, scopeIcon, SYSTEM_ICONS } from './icon_names.ts';
import { fuzzyScore } from './palette.ts';
import { SECTIONS } from './shell.ts';
import { variantOf } from './ui.ts';
import { nextRetryDelayMs, RECOVERY_WINDOW_MS } from './views.ts';
import { EmbedBridge, safeStyleValue, toolErrorOf } from './embed_bridge.ts';
import { EMBED_ICONS } from './embed_icons.ts';
import { appOnly } from './tool_visibility.ts';
import { contrastRatio } from './a2ui.ts';
import { canChangeOwnPassword, passwordChangedText } from './password_dialog.ts';
import { config as zodConfig } from 'zod';

Deno.test('web: the bundle and the gateway agree on the frame envelope', () => {
	// Both sides import @tykotech/wire, so this asserts the shared codec rather
	// than a copy of it.
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9]);
	const meta = { type: 'frame' as const, seq: 42, ts: 1, w: 800, h: 600, targetId: 'T' };
	const round = decodeFrame(encodeFrame(meta, jpeg).buffer as ArrayBuffer);
	assertEquals(round.meta, meta);
	assertEquals([...round.jpeg], [...jpeg]);
});

Deno.test('web: every message the canvas emits is valid on the wire', () => {
	// The exact shapes canvas.ts constructs, asserted against the schema the
	// server validates with.
	const emitted: unknown[] = [
		{ type: 'input.mouse', kind: 'down', x: 10, y: 20, button: 'left' },
		{ type: 'input.mouse', kind: 'up', x: 10, y: 20, button: 'right' },
		{ type: 'input.mouse', kind: 'move', x: 1, y: 2 },
		{ type: 'input.wheel', x: 5, y: 6, deltaX: 0, deltaY: 120 },
		{ type: 'input.key', kind: 'down', key: 'a', code: 'KeyA', modifiers: 0, text: 'a' },
		{ type: 'input.key', kind: 'down', key: 'Enter', code: 'Enter', modifiers: 8 },
		{ type: 'input.key', kind: 'up', key: 'a', code: 'KeyA', modifiers: 0 },
		{ type: 'control.take' },
		{ type: 'control.release' },
		{ type: 'navigate', url: 'https://example.com/' },
		{ type: 'tab.switch', tabId: 'T1' },
		// The keep-alive answer (F1). ws.ts sends this on every server `ping`; if
		// the server rejected it the socket would be answered with `bad-message`
		// instead of having its liveness refreshed.
		{ type: 'pong' },
	];
	for (const message of emitted) {
		const result = ClientMsgSchema.safeParse(message);
		assert(result.success, `the server would reject ${JSON.stringify(message)}`);
	}
});

Deno.test('web: modifier bitmask matches the CDP encoding', () => {
	// Mirrors modifiersOf() in canvas.ts: Alt=1, Ctrl=2, Meta=4, Shift=8.
	const mask = (alt: boolean, ctrl: boolean, meta: boolean, shift: boolean) =>
		(alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
	assertEquals(mask(false, false, false, false), 0);
	assertEquals(mask(false, false, false, true), 8);
	assertEquals(mask(false, true, false, true), 10);
	assertEquals(mask(true, true, true, true), 15);
	// The schema caps the field at the four real modifiers.
	assert(ClientMsgSchema.safeParse({ type: 'input.key', kind: 'down', key: 'a', modifiers: 15 }).success);
	assert(!ClientMsgSchema.safeParse({ type: 'input.key', kind: 'down', key: 'a', modifiers: 16 }).success);
});

Deno.test('web: canvas-to-frame coordinate scaling', () => {
	// Mirrors toFrame() in canvas.ts: a canvas displayed at half size must map a
	// click to twice its CSS offset, or every click lands in the wrong place.
	const toFrame = (clientX: number, rectLeft: number, rectWidth: number, frameW: number) =>
		Math.round((clientX - rectLeft) * (frameW / (rectWidth || 1)));

	assertEquals(toFrame(100, 0, 640, 1280), 200, 'a half-scale canvas doubles the coordinate');
	assertEquals(toFrame(100, 0, 1280, 1280), 100, 'a 1:1 canvas passes the coordinate through');
	assertEquals(toFrame(150, 50, 640, 1280), 200, 'the canvas offset is subtracted first');
	assertEquals(toFrame(0, 0, 0, 1280), 0, 'a zero-width rect must not divide by zero');
});

/**
 * Reads a bundle source with comments stripped.
 *
 * The rules below are about what the code *does*, and several modules name the
 * forbidden APIs in comments precisely to say they are not used — scanning raw
 * text would flag that documentation as a violation.
 */
async function bundleSources(): Promise<Array<{ name: string; code: string }>> {
	const files: Array<{ name: string; code: string }> = [];
	for await (const entry of Deno.readDir(new URL('.', import.meta.url))) {
		if (!entry.isFile || !entry.name.endsWith('.ts') || entry.name.endsWith('_test.ts')) continue;
		const raw = await Deno.readTextFile(new URL(entry.name, import.meta.url));
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		files.push({ name: entry.name, code });
	}
	return files;
}

Deno.test('web: no module uses innerHTML', async () => {
	// Server strings and page content reach the DOM as text; an innerHTML here
	// would turn any of them into markup.
	const offenders = (await bundleSources())
		.filter(({ code }) => /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/.test(code))
		.map(({ name }) => name);
	assertEquals(offenders, []);
});

Deno.test('web: only theme.ts writes storage, and it keeps only ttk.theme and ttk.dock (B4, D-097)', async () => {
	// B4: the sign-in lives in an HttpOnly cookie the page cannot read, so no
	// module stores a credential of any kind — the `ttk.login` key D-073 kept is
	// gone. `api.ts` may only *retire* it (read once, remove, revoke), never write
	// storage. What remains is the display preferences (D-089, D-093, D-152, D-158),
	// which may hold only a theme literal (`dark` / `shade` / `light` / `dawn`),
	// `open` / `closed`, and the Agents chat's start as decimal digits; an offender
	// anywhere else is a regression.
	const sources = await bundleSources();
	const offenders = sources
		.filter(({ name, code }) =>
			name !== 'theme.ts' && name !== 'api.ts' && /localStorage|sessionStorage|document\.cookie/.test(code)
		)
		.map(({ name }) => name);
	assertEquals(offenders, [], 'storage access belongs to theme.ts, and to api.ts retiring the old sign-in key');
	const api = sources.find(({ name }) => name === 'api.ts')?.code ?? '';
	assert(!/setItem|sessionStorage|document\.cookie/.test(api), 'api.ts never writes storage');
	assertEquals(
		[...api.matchAll(/(getItem|removeItem)\(([^)]*)\)/g)].map((match) => `${match[1]}(${match[2]})`),
		['getItem(LEGACY_LOGIN_KEY)', 'removeItem(LEGACY_LOGIN_KEY)'],
		'api.ts touches exactly one key, to retire it',
	);
	const theme = sources.find(({ name }) => name === 'theme.ts')?.code ?? '';
	assert(!/sessionStorage|document\.cookie/.test(theme), 'the theme keeps no session state and no cookie');
	assertEquals(
		[...theme.matchAll(/setItem\(([^)]*)\)/g)].map((match) => match[1]),
		[
			'THEME_STORAGE_KEY, theme',
			'DOCK_STORAGE_KEY, state',
			'AGENTS_SIDE_STORAGE_KEY, state',
		],
		'display preferences write three keys, each only a literal union',
	);
	const { AGENTS_SIDE_STORAGE_KEY, DOCK_STORAGE_KEY, THEME_STORAGE_KEY, THEMES } = await import('./theme.ts');
	assertEquals(
		[THEME_STORAGE_KEY, DOCK_STORAGE_KEY, AGENTS_SIDE_STORAGE_KEY],
		['ttk.theme', 'ttk.dock', 'ttk.agents.side'],
		'the only three keys the SPA writes',
	);
	assertEquals(THEMES.map((entry) => entry.id), ['dark', 'shade', 'light', 'dawn'], 'D-152: four theme literals');
	assertStringIncludes(theme, "return value === 'dark' || value === 'shade' || value === 'light' || value === 'dawn';");
});

Deno.test('web: requests ride the cookie same-origin and carry the CSRF value on every change (B4)', async () => {
	const calls: Array<{ path: string; init: RequestInit }> = [];
	const realFetch = globalThis.fetch;
	const reply = (status: number, body: unknown): Response =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
		const path = String(input);
		calls.push({ path, init });
		if (path === '/api/v1/auth/login') {
			return Promise.resolve(reply(200, { expires: 1, user: { id: 'admin:a', scopes: [] }, csrf: 'csrf-one' }));
		}
		return Promise.resolve(reply(200, {}));
	}) as typeof fetch;
	try {
		const { api, clearSession, hasSession, isSignedIn, send, setSession } = await import('./api.ts');
		const login = await api.login({ username: 'a', password: 'b' });
		const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
		assertEquals(sent.session, 'cookie', 'the SPA always asks for a cookie sign-in');
		assertEquals('token' in (login as unknown as Record<string, unknown>), false);
		setSession({ csrf: login.csrf ?? '', user: login.user });
		assertEquals([isSignedIn(), hasSession()], [true, true]);

		await send('/api/v1/sessions');
		await send('/api/v1/sessions', { method: 'POST', body: '{}' });
		await send('/api/v1/share?path=x', { method: 'DELETE' });
		const [get, post, del] = calls.slice(1).map(({ init }) => new Headers(init.headers));
		for (const call of calls) assertEquals(call.init.credentials, 'same-origin');
		assertEquals(get?.get('x-ttk-csrf'), null, 'a safe method carries no CSRF value');
		assertEquals(post?.get('x-ttk-csrf'), 'csrf-one');
		assertEquals(del?.get('x-ttk-csrf'), 'csrf-one');
		for (const headers of [get, post, del]) assertEquals(headers?.get('authorization'), null, 'no bearer header');
		clearSession();
		assertEquals(isSignedIn(), false);
	} finally {
		globalThis.fetch = realFetch;
	}
});

Deno.test('web: a ttk.login token left by the previous release is revoked and removed at load (B4)', async () => {
	const store = new Map<string, string>([['ttk.login', `ttks_${'ab'.repeat(32)}`], ['ttk.theme', 'dark']]);
	const fake = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: () => {
			throw new Error('nothing may be written');
		},
		removeItem: (key: string) => void store.delete(key),
	};
	const calls: Array<{ path: string; init: RequestInit }> = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
		calls.push({ path: String(input), init });
		// `me` without a CSRF value: not a cookie sign-in (as for a browser that has none yet).
		return Promise.resolve(new Response(JSON.stringify({ user: { id: 'x', scopes: [] } }), { status: 200 }));
	}) as typeof fetch;
	Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
	try {
		const { LEGACY_LOGIN_KEY, restoreSession } = await import('./api.ts');
		assertEquals(LEGACY_LOGIN_KEY, 'ttk.login');
		assertEquals(await restoreSession(), false, 'a reply without a CSRF value is not a cookie sign-in');
		assertEquals([...store.keys()], ['ttk.theme'], 'the old key is gone; the display preference stays');
		const logout = calls.find((call) => call.path === '/api/v1/auth/logout');
		assert(logout !== undefined, 'the old token is ended on the server too');
		assertEquals(new Headers(logout.init.headers).get('authorization'), `Bearer ttks_${'ab'.repeat(32)}`);
		assertEquals(logout.init.credentials, 'omit');

		// A planted value that is not a session token is removed and never sent anywhere.
		store.set('ttk.login', 'ttk_rawkey');
		calls.length = 0;
		await restoreSession();
		assertEquals(store.has('ttk.login'), false);
		assertEquals(calls.map((call) => call.path), ['/api/v1/auth/me']);
	} finally {
		globalThis.fetch = realFetch;
		Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
	}
});

Deno.test('web: no module sets a style attribute (F4)', async () => {
	// The page's own CSP declares `style-src 'self'`, which blocks style
	// *attributes* as well as <style> blocks. A `style` attribute therefore
	// reaches the DOM, is refused by the browser, and logs an error on every
	// load while silently not applying — which is how the viewer shipped without
	// its flex column and with ~105px of dead space under the canvas.
	//
	// `node.style.cssText` and `node.style.prop = …` are CSSOM writes, which CSP
	// does not gate; canvas.ts uses that form deliberately and must stay legal.
	const offenders = (await bundleSources())
		.filter(({ code }) => /\bstyle:\s*['"`]/.test(code) || /setAttribute\(\s*['"`]style['"`]/.test(code))
		.map(({ name }) => name);
	assertEquals(offenders, [], "style must come from app.css, which `style-src 'self'` allows");
});

Deno.test('web: the shell class is defined in the stylesheet', async () => {
	// The other half of F4: moving the declaration out of the attribute is only
	// a fix if the class it moved to actually exists in a file the CSP allows.
	const css = await Deno.readTextFile(new URL('./styles/shell.css', import.meta.url));
	assertStringIncludes(css, '.app-shell');
	const shell = await Deno.readTextFile(new URL('./shell.ts', import.meta.url));
	assertStringIncludes(shell, "class: 'app-shell'");
	// One stylesheet: the bundled entry. A stale hand-written copy in static/ would shadow nothing but confuse.
	await Deno.stat(new URL('../static/app.css', import.meta.url)).then(
		() => assert(false, 'static/app.css must not exist; the stylesheet is src/styles/app.css, bundled'),
		() => {},
	);
});

Deno.test('web: Retry-After is read as delta-seconds, and bounded (F3)', () => {
	const of = (value: string | null) => retryAfterMsOf(new Headers(value === null ? {} : { 'retry-after': value }));
	assertEquals(of(null), null, 'absent means no server opinion');
	assertEquals(of('30'), 30_000);
	assertEquals(of(' 5 '), 5_000, 'surrounding whitespace is legal');
	assertEquals(of('0'), 0, 'zero is a real answer, not a missing one');
	// The HTTP-date form is legal HTTP and deliberately not honoured: acting on
	// it would mean trusting this browser's clock to agree with the server's.
	assertEquals(of('Wed, 21 Oct 2026 07:28:00 GMT'), null);
	assertEquals(of('-1'), null, 'a negative delay is not a delay');
	assertEquals(of('99999'), 600_000, 'capped: the recovery window is ten minutes');
});

Deno.test('web: the reconnect schedule backs off, respects a cool-off, and fits the window (B6.2)', () => {
	// Drives the shipped function, not a copy of its arithmetic.
	const hour = 3_600_000;

	// Exponential from 750ms, capped at 15s.
	assertEquals(nextRetryDelayMs(1, hour, 0), 750);
	assertEquals(nextRetryDelayMs(2, hour, 0), 1_500);
	assertEquals(nextRetryDelayMs(5, hour, 0), 12_000);
	assertEquals(nextRetryDelayMs(6, hour, 0), 15_000, 'the backoff is capped');
	assertEquals(nextRetryDelayMs(40, hour, 0), 15_000, 'and stays capped');

	// A 429 cool-off outranks the backoff while it lasts, and is ignored once past.
	assertEquals(nextRetryDelayMs(1, hour, 30_000), 30_000);
	assertEquals(nextRetryDelayMs(1, hour, -5_000), 750, 'an expired cool-off does not shorten the backoff');

	// Nothing may schedule the next attempt past the end of the recovery window:
	// a delay longer than what remains would mean the final attempt never runs.
	assertEquals(nextRetryDelayMs(6, 2_000, 0), 2_000);
	assertEquals(nextRetryDelayMs(1, 400, 30_000), 400);
});

Deno.test('web: the recovery window is ten minutes, and the terminal message says so', async () => {
	assertEquals(RECOVERY_WINDOW_MS, 600_000);
	const views = await Deno.readTextFile(new URL('./viewer_view.ts', import.meta.url));
	// The exact operator-facing string, asserted by name: it is what a support
	// conversation quotes and what the container verification greps for.
	assertStringIncludes(views, "'Session and recovery window expired'");
	assertStringIncludes(views, "label: 'Start a new session'");
});

Deno.test('web: the disconnect overlay replaces rather than stacks (F2)', async () => {
	const views = await Deno.readTextFile(new URL('./viewer_view.ts', import.meta.url));
	// Every overlay is `position:absolute; inset:0`, so two of them stack
	// perfectly and the upper one eats the click meant for the button below.
	// The invariant is that the only `.overlay` append is preceded by the sweep
	// that removes any existing one.
	const appends = views.match(/stage\.append\(overlay\)/g) ?? [];
	assertEquals(appends.length, 1, 'exactly one place may put an overlay on the stage');
	const showOverlay = views.slice(views.indexOf('function showOverlay'));
	const body = showOverlay.slice(0, showOverlay.indexOf('stage.append(overlay)'));
	assertStringIncludes(body, 'hideOverlay()');
});

/** The built bundle directory, when `deno task build:web` has run in this checkout. */
const DIST = new URL('../dist/', import.meta.url);
let distBuilt = false;
try {
	distBuilt = Deno.statSync(new URL('app.js', DIST)).isFile;
} catch {
	// Not built: the budget is asserted by the browser tier instead.
}

Deno.test({
	name: 'web: the entry bundle and every lazy chunk fit the 150 KB budget (D-069)',
	ignore: !distBuilt,
	fn() {
		// D-069. The budget governs what a first paint downloads — `app.js` — and,
		// separately, each chunk loaded on demand. Without the per-chunk half the
		// split would be a way to move weight out of sight rather than to defer it.
		const budget = 150 * 1024;
		const sizes = [...Deno.readDirSync(DIST)]
			.filter((entry) => entry.isFile && entry.name.endsWith('.js'))
			.map((entry) => ({ name: entry.name, bytes: Deno.statSync(new URL(entry.name, DIST)).size }));
		assert(sizes.some(({ name }) => name === 'app.js'), 'the entry bundle is named app.js');
		for (const { name, bytes } of sizes) {
			assert(bytes < budget, `${name} is ${Math.round(bytes / 1024)} KB, over the 150 KB budget`);
		}
		// The entry must not quietly re-absorb the lazy validator: it is what keeps
		// the connect screen light.
		const entry = sizes.find(({ name }) => name === 'app.js')?.bytes ?? 0;
		assert(entry < 100 * 1024, `app.js is ${Math.round(entry / 1024)} KB; the zod chunk has leaked back into it`);
	},
});

Deno.test('web: a re-render tears down the screen it replaces, exactly once (G-1)', () => {
	// The router re-renders a route without a hash change when its rail item is
	// clicked. The replaced screen's poller or socket must stop then too, and a
	// later render must not run that teardown a second time.
	let stopped = 0;
	onLeave(() => stopped++);
	onLeave(() => {
		throw new Error('one failed teardown');
	});
	let alsoStopped = false;
	onLeave(() => alsoStopped = true);
	leaveScreen();
	assertEquals(stopped, 1);
	assert(alsoStopped, 'a throwing teardown does not stop the others');
	leaveScreen();
	assertEquals(stopped, 1, 'teardown runs once, for the screen it belongs to');
});

Deno.test('web: sign-out forgets credential-bound state every time (G-5)', () => {
	const history = ['call by the previous credential'];
	onSignOut(() => history.splice(0));
	signOut();
	assertEquals(history, []);
	history.push('call by the next credential');
	signOut();
	assertEquals(history, [], 'the hook stays registered for every later sign-out');
});

Deno.test('web: every screen with background work tears it down through the router (G-1 wiring, G3-2)', async () => {
	// The lifecycle primitive is tested above; this pins the wiring. A screen that
	// went back to `hashchange` would leak again on a same-route re-render.
	const read = (name: string) => Deno.readTextFile(new URL(name, import.meta.url));
	const [app, views, agents] = await Promise.all([read('./app.ts'), read('./viewer_view.ts'), read('./agent_view.ts')]);
	const render = app.slice(app.indexOf('function render('));
	assert(
		render.indexOf('leaveScreen()') !== -1 && render.indexOf('leaveScreen()') < render.indexOf('location.hash'),
		'the router tears down before it reads the route',
	);
	assertStringIncludes(agents, 'onLeave(stop)');
	assertStringIncludes(views, 'onLeave(() => {');
	const sources: Array<[string, string]> = [['viewer_view.ts', views], ['agent_view.ts', agents]];
	for (const [name, code] of sources) {
		assert(!/addEventListener\(\s*'hashchange'/.test(code), `${name} must not tear down on hashchange`);
	}
	// G3-1: the viewer re-checks after each await before it opens a socket.
	const connect = views.slice(views.indexOf('async function connect('));
	assert(
		connect.indexOf('if (destroyed) return;') < connect.indexOf('new LiveViewSocket('),
		'a view left during connect must not open a socket afterwards',
	);
});

// --- component kit, icons and theme (D-089, D-090) ---------------------------------------

Deno.test('web: every icon name maps to a real Lucide glyph or a drawn one (D-089)', () => {
	// `scripts/build_icons.ts` fails the build on an unknown name; this fails the unit tier first, with the name.
	const lucide = nodes as unknown as Record<string, unknown>;
	const missing = [...Object.entries(ICONS), ...Object.entries(SYSTEM_ICONS)]
		.filter(([, source]) => source.startsWith('@') ? !(source.slice(1) in CUSTOM_ICONS) : !(source in lucide))
		.map(([name, source]) => `${name} → ${source}`);
	assertEquals(missing, []);
	for (const [namespace, entry] of Object.entries(SCOPE_GLYPHS)) {
		for (const name of typeof entry === 'string' ? [entry] : Object.values(entry)) {
			assert(name in ICONS, `${namespace} → ${name}`);
		}
	}
	assertEquals(scopeIcon('view:control'), 'control');
	assertEquals(scopeIcon('files:read'), 'file-search');
	assertEquals(scopeIcon('task'), 'list-checks');
	assertEquals(scopeIcon('metrics:read'), 'activity', 'D-098: the metrics grant has its own glyph');
	assertEquals(scopeIcon('network:read'), 'network', 'S0: the network grant has its own glyph');
	assertEquals(scopeIcon('some:future-scope'), 'key', 'an unknown scope still gets a glyph');
	assertEquals(scopeIcon('view:future-verb'), 'key');
});

Deno.test('web: the kit never fetches icons or code by URL (S-1)', async () => {
	// Sprite-sheet mode is what keeps wa-icon off its fetch-and-parse path; the library entry would bring the
	// autoloader, which imports component code by URL.
	const kit = await Deno.readTextFile(new URL('./kit.ts', import.meta.url));
	assertEquals(kit.match(/registerIconLibrary\('(default|system)', \{[^;]*spriteSheet: true,\s*\}\);/g)?.length, 2);
	const sources = await bundleSources();
	const entry = sources.filter(({ code }) =>
		/webawesome\/dist\/webawesome(\.loader)?\.js|webawesome\/dist\/utilities\/autoloader/.test(code)
	);
	assertEquals(entry.map(({ name }) => name), [], 'import components one by one, never the library entry');
	// Components that bind `styleMap` write a `style` attribute on their first render, which `style-src 'self'`
	// refuses with a console error (found with the progress ring); they are not part of the kit.
	const kitModules = sources.filter(({ name }) => /^kit(_[a-z]+)?\.ts$/.test(name)).map(({ code }) => code).join('\n');
	for (const component of ['progress-ring', 'slider', 'rating', 'color-picker', 'qr-code', 'carousel', 'comparison']) {
		assert(!kitModules.includes(`/components/${component}/`), `${component} binds styleMap; draw it instead`);
	}
	// Components whose purpose is to turn fetched or authored text into markup are not used at all.
	const markup = sources.filter(({ code }) => /wa-include|wa-markdown|wa-icon[^)]*\bsrc\b/.test(code));
	assertEquals(markup.map(({ name }) => name), []);
});

Deno.test('web: the page CSP is unchanged by the kit (S-2); D-111 adds only media-src for A2UI players', async () => {
	const html = await Deno.readTextFile(new URL('../static/index.html', import.meta.url));
	assertStringIncludes(
		html,
		"content=\"default-src 'self'; img-src 'self' blob: data:; media-src 'self' data: blob:; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'\"",
	);
	assert(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'the shell page names no other origin');
	const css = await Deno.readTextFile(new URL('./styles/app.css', import.meta.url));
	assert(!/@import\s+['"]?https?:/.test(css), 'no stylesheet is pulled from another origin');
});

Deno.test('web: the palette matches in order, prefers word starts, and rejects non-matches', () => {
	assertEquals(fuzzyScore('', 'Sessions'), 0);
	assertEquals(fuzzyScore('xyz', 'Sessions'), -1);
	assert(fuzzyScore('ses', 'Sessions') > fuzzyScore('ses', 'Close sessions'), 'a prefix beats a later match');
	assert(fuzzyScore('bn', 'browser_navigate') > 0, 'initials across a separator match');
	assertEquals(fuzzyScore('nb', 'browser_navigate'), -1, 'order matters');
});

Deno.test('web: tones map onto the kit variants', () => {
	assertEquals(variantOf('ok'), 'success');
	assertEquals(variantOf('live'), 'success');
	assertEquals(variantOf('warn'), 'warning');
	assertEquals(variantOf('locked'), 'warning');
	assertEquals(variantOf('danger'), 'danger');
	assertEquals(variantOf('accent'), 'brand');
	assertEquals(variantOf(''), 'neutral');
	assertEquals(variantOf('anything-else'), 'neutral');
});

/** Every file a first paint downloads: the entry, the four kit modules, and what they import statically. */
function firstPaintFiles(): string[] {
	const read = (name: string) => Deno.readTextFileSync(new URL(name, DIST));
	const statics = (code: string) => [...code.matchAll(/from\s*"\.\/([^"]+\.js)"|import\s*"\.\/([^"]+\.js)"/g)];
	const seen = new Set<string>();
	const visit = (name: string): void => {
		if (seen.has(name)) return;
		seen.add(name);
		for (const match of statics(read(name))) visit(match[1] ?? match[2] ?? '');
	};
	visit('app.js');
	for (const match of read('app.js').matchAll(/import\("\.\/(kit[a-z_]*-[A-Z0-9]+\.js)"\)/g)) visit(match[1] ?? '');
	return [...seen].filter(Boolean);
}

async function gzipSize(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
	return (await new Response(stream).arrayBuffer()).byteLength;
}

Deno.test({
	name: 'web: a first paint stays within its compressed budget (D-090)',
	ignore: !distBuilt,
	async fn() {
		const files = firstPaintFiles();
		assert(files.some((name) => name.startsWith('kit-')), `the kit is part of the first paint: ${files}`);
		// Every screen chunk and every module only a screen imports (the Resources groups, the schema form, the
		// configuration composer, the surface builder, JSON facts, the task composer) stays out of the first paint.
		assert(
			!files.some((name) =>
				/(resources_(files|skills|prompts|drawer)|schema_form|config_composer|surface_builder|json_facts|task_composer|(workspaces|tools|resources|agent|users|system)_view)|a2ui|ws-/
					.test(name)
			),
			'lazy screens stay lazy',
		);
		let js = 0;
		for (const name of files) js += await gzipSize(Deno.readFileSync(new URL(name, DIST)));
		const css = await gzipSize(Deno.readFileSync(new URL('app.css', DIST)));
		assert(js < 160 * 1024, `first-paint JavaScript is ${Math.round(js / 1024)} KB gzip, over 160 KB`);
		// D-159: 50 KB, up from D-090's 40 KB; the lazy screens' rules no longer count — they load with their screens.
		assert(css < 50 * 1024, `the stylesheet is ${Math.round(css / 1024)} KB gzip, over 50 KB`);
		// D-159: every sheet a screen names is built, and none of them is part of the first paint.
		const { SCREEN_SHEETS } = await import('./styles.ts');
		for (const sheet of new Set(Object.values(SCREEN_SHEETS).flat())) {
			const built = Deno.readFileSync(new URL(`screens/${sheet}.css`, DIST));
			assert(
				built.byteLength > 1000 && built.byteLength < 150 * 1024,
				`screens/${sheet}.css is ${built.byteLength} bytes`,
			);
		}
		const firstPaintCss = new TextDecoder().decode(Deno.readFileSync(new URL('app.css', DIST)));
		for (const lazyOnly of ['.rx-layout', '.ag-turn', '.sys-grid', '.acct-grid', '.tk-timeline']) {
			assert(!firstPaintCss.includes(lazyOnly), `${lazyOnly} is a lazy screen's rule, in the first paint`);
		}
		assert(
			firstPaintCss.includes('.acct-form') && firstPaintCss.includes('.lib-field'),
			'first-paint dialogs keep their rules',
		);
	},
});

Deno.test('web: the dock has five items; the Library and the Tools console are groups of Resources (D-147, D-152)', async () => {
	// The Library (files, skills, prompts) and, since D-152, the Tools console are absorbed by Resources: a dock item
	// for either would be a second home for the same place. `#/library` and `#/tools` still answer, as redirects in
	// `app.ts`. D-147: the Live View and the Workspaces are tabs of Sessions, not dock items of their own.
	assertEquals(SECTIONS.map(([section]) => String(section)), ['sessions', 'resources', 'agents', 'users', 'system']);
	assert(
		SECTIONS.every(([section]) => !['view', 'workspaces', 'library', 'tools'].includes(String(section))),
		'no dock item for a view another section holds',
	);
	const palette = await Deno.readTextFile(new URL('./palette.ts', import.meta.url));
	assert(!palette.includes('#/library'), 'the palette offers no Library command');
	assert(!palette.includes("'#/tools'"), 'the palette offers Tools as the Resources filter, not a screen');
	const app = await Deno.readTextFile(new URL('./app.ts', import.meta.url));
	assert(!app.includes('library_view') && !app.includes('tools_view'), 'app.ts loads neither old screen');
	assertStringIncludes(app, "location.replace('#/resources/' + (tab || 'files'))");
	assertStringIncludes(app, "location.replace('#/resources/tools' + (name === '' ? '' : `/${name}`))");
});

Deno.test('web: in key mode the password field folds away, never the field being typed in (D-091)', async () => {
	// A positional selector (`:nth-of-type`) once picked the identity field, because the brand block is also a div.
	const css = await Deno.readTextFile(new URL('./styles/screens/connect.css', import.meta.url));
	const view = await Deno.readTextFile(new URL('./connect_view.ts', import.meta.url));
	assertStringIncludes(css, '.key-mode .login-field.secret {');
	assert(!/\.key-mode[^{]*:(nth|first|last)-of-type/.test(css), 'key mode targets fields by role, not by position');
	assertStringIncludes(view, "'identity')");
	assertStringIncludes(view, "'secret')");
});

Deno.test('web: every control has one home — the dock only navigates, no refresh where a screen polls (D-092)', async () => {
	const sources = new Map((await bundleSources()).map(({ name, code }) => [name, code]));
	const shell = sources.get('shell.ts') ?? '';
	// The brand is a mark, not a second "sessions" button; sign-out lives in the account popover only.
	assert(!/el\('button', \{ class: 'dock-logo'/.test(shell), 'the dock has no logo button');
	assertEquals(shell.match(/doSignOut\(navigate\)/g)?.length, 1, 'sign out is offered once');
	assert(!shell.includes('ctx-glyph'), 'the context bar does not repeat the dock glyph');
	// D-152: the theme is one picker in the bar (four themes); the palette offers each theme by name.
	assertEquals(shell.match(/themePicker\(\)/g)?.length, 2, 'the theme picker is declared and placed once');
	// Screens that keep themselves current carry no refresh button.
	for (
		const name of [
			'sessions_view.ts',
			'agent_view.ts',
			'system_view.ts',
			'users_view.ts',
			'workspaces_view.ts',
			'resources_view.ts',
			'resources_files.ts',
			'resources_skills.ts',
			'resources_prompts.ts',
			'resources_drawer.ts',
		]
	) {
		const code = sources.get(name) ?? '';
		assert(
			!/'refresh', '(Refresh|Reload)/.test(code) && !/label: 'Refresh'/.test(code),
			`${name} has a refresh button`,
		);
	}
	assert(
		!(sources.get('sessions_view.ts') ?? '').includes('Open default session'),
		'the Live View tab opens it (D-147)',
	);
});

Deno.test('web: destructive buttons are quiet until reached for (D-092)', async () => {
	const ui = (await bundleSources()).find(({ name }) => name === 'ui.ts')?.code ?? '';
	assertStringIncludes(ui, "button({ variant: 'ghost', ...options })");
	const css = await Deno.readTextFile(new URL('./styles/components.css', import.meta.url));
	assertStringIncludes(css, 'button.ttk-btn.destructive:hover:not(:disabled)');
});

Deno.test('web: metrics are one compact strip sized to its content, not a row of cards (D-092)', async () => {
	const css = await Deno.readTextFile(new URL('./styles/components.css', import.meta.url));
	const strip = css.slice(css.indexOf('\n.tiles {'), css.indexOf('\n.tiles[hidden]'));
	assertStringIncludes(strip, 'align-self: flex-start;');
	assert(!/grid-template-columns: repeat\(auto-fit/.test(strip), 'the strip does not stretch across the page');
	const value = css.slice(css.indexOf('\n.tile-value {'), css.indexOf('\n.tile-value.bump'));
	const size = Number(/font-size: (\d+)px/.exec(value)?.[1]);
	assert(size <= 18, `a metric value is ${size}px; the strip keeps them compact`);
});

Deno.test('web: the logo opens and closes the dock; the page title is the highlighted item, not a bar heading (D-093)', async () => {
	const sources = new Map((await bundleSources()).map(({ name, code }) => [name, code]));
	const shell = sources.get('shell.ts') ?? '';
	assert(/class: 'dock-brand',\s+type: 'button',/.test(shell), 'the logo is a button');
	assertStringIncludes(shell, "'aria-controls': 'ttk-dock-items'");
	assertStringIncludes(shell, "brand.setAttribute('aria-expanded', String(open));");
	// The heading stays for assistive technology only.
	assertStringIncludes(shell, "el('h1', { class: 'sr-only', text: options.title })");
	const css = await Deno.readTextFile(new URL('./styles/shell.css', import.meta.url));
	assertStringIncludes(css, '.app-shell.dock-open {');
	assert(!/\.ctx-title h1[^{]*\{[^}]*display:\s*none/.test(css), 'the heading is never removed from the tree');
});

Deno.test('web: Resources is a workbench — a roomy pane, toggles each on its own, request beside result (D-093, D-152)', async () => {
	const css = await Deno.readTextFile(new URL('./styles/screens/tools.css', import.meta.url));
	assertStringIncludes(css, 'grid-template-columns: clamp(296px, 23vw, 360px) minmax(0, 1fr);');
	// The tool console's two columns follow the viewer's own width, not the window's.
	assertStringIncludes(css, 'container: rx-viewer / inline-size;');
	assertStringIncludes(css, '@container rx-viewer (min-width: 860px)');
	assertStringIncludes(css, 'grid-template-columns: repeat(auto-fit, minmax(30px, 1fr));');
	const sources = new Map((await bundleSources()).map(({ name, code }) => [name, code]));
	assert(!sources.has('tools_view.ts'), 'the Tools screen is gone; its console is resources_tools.ts');
	const tools = sources.get('resources_tools.ts') ?? '';
	assertStringIncludes(tools, "el('section', { class: 'tc-response', 'aria-label': 'Result' }");
	const view = sources.get('resources_view.ts') ?? '';
	// Every toggle is pressed or not on its own: a set of groups and two kinds, never one chosen filter.
	assertStringIncludes(view, 'const shownGroups = new Set<ToolDomain>');
	assertStringIncludes(view, 'const shownKinds = { data: true, tools: true };');
	assertStringIncludes(view, "node.setAttribute('aria-pressed', String(pressed()));");
	// Filters live for the page, never in storage (D-089's storage rule holds).
	assert(!/localStorage|sessionStorage/.test(view), 'the filters are not stored');
});

// --- MCP Apps embeds (R9, D-134 – D-136) -------------------------------------------------------------------------

/** The embed documents `scripts/build_embed.ts` writes. */
const EMBEDS = ['embed_live.html', 'embed_a2ui.html', 'embed_terminal.html'] as const;

async function sha256Source(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

Deno.test({
	name: 'web (AC40, M11): each embed is one self-contained document within 200 KB, its inline code pinned by hash',
	ignore: !distBuilt,
	async fn() {
		await Deno.stat(new URL('embed-src/', DIST)).then(
			() => assert(false, 'dist/embed-src/ must be gone after the build'),
			() => {},
		);
		for (const name of EMBEDS) {
			const html = await Deno.readTextFile(new URL(name, DIST));
			const bytes = new TextEncoder().encode(html).length;
			assert(bytes <= 200 * 1024, `${name} is ${Math.round(bytes / 1024)} KB, over the 200 KB budget (M11)`);
			// Exactly one inline script and one inline style, and nothing either could load.
			assertEquals(html.match(/<script\b/gi)?.length, 1, `${name}: one script`);
			assertEquals(html.match(/<style\b/gi)?.length, 1, `${name}: one style`);
			const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
			const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
			assert(script !== undefined && style !== undefined, `${name}: the inline script and style are where expected`);
			const markup = html.replace(script, '').replace(style, '');
			assertEquals(markup.match(/\s(src|href|srcset|action|poster|data)\s*=/gi), null, `${name}: an attribute fetches`);
			assert(!/@import|url\(/i.test(style), `${name}: the stylesheet fetches`);
			// The meta CSP pins exactly this script and this style, and leaves connect-src for the gateway.
			const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
			assertEquals(
				csp,
				[
					"default-src 'none'",
					`script-src ${await sha256Source(script)}`,
					`style-src ${await sha256Source(style)}`,
					'img-src blob: data:',
					'connect-src __TTK_CONNECT_SRC__',
					"base-uri 'none'",
					"form-action 'none'",
				].join('; '),
				`${name}: the CSP`,
			);
			assert(
				html.indexOf('Content-Security-Policy') < html.indexOf('<style>'),
				`${name}: the policy precedes the code`,
			);
		}
	},
});

Deno.test('web (AC40, F17): build:web bundles the embeds in the task, chained with &&, and grants no --allow-run', async () => {
	const tasks = JSON.parse(await Deno.readTextFile(new URL('../../../deno.json', import.meta.url))).tasks as Record<
		string,
		string
	>;
	const build = tasks['build:web'] ?? '';
	assert(!build.includes('--allow-run'), 'build:web must not grant --allow-run');
	assert(!/;|\|\|/.test(build), 'build:web chains its steps with && only');
	for (
		const step of [
			'src/embed_live.ts',
			'src/embed_a2ui.ts',
			'src/embed_terminal.ts',
			'src/styles/embed.css',
			'scripts/build_embed.ts',
		]
	) {
		assertStringIncludes(build, step);
	}
	// The embed step holds what the icon step holds, and no more.
	assertStringIncludes(
		build,
		'deno run --allow-read=packages/web --allow-write=packages/web/dist scripts/build_embed.ts',
	);
});

Deno.test('web: every embed glyph is an app icon mapped to a real Lucide glyph (D-135)', () => {
	const lucide = nodes as unknown as Record<string, unknown>;
	for (const name of EMBED_ICONS) {
		const source = (ICONS as Record<string, string>)[name];
		assert(source !== undefined, `${name} is not an app icon`);
		assert(source.startsWith('@') ? source.slice(1) in CUSTOM_ICONS : source in lucide, `${name} → ${source}`);
	}
});

Deno.test('web (R9): the Tools console hides app-only tools and nothing else', () => {
	assertEquals(appOnly({ name: 'browser_live_ticket', _meta: { ui: { visibility: ['app'] } } }), true);
	assertEquals(appOnly({ name: 'browser_live_view', _meta: { ui: { visibility: ['model', 'app'] } } }), false);
	assertEquals(appOnly({ name: 'browser_click' }), false);
	assertEquals(appOnly({ name: 'odd', _meta: { ui: { visibility: 'app' } } }), false, 'a malformed mark hides nothing');
	assertEquals(appOnly({ name: 'odd', _meta: { ui: {} } }), false);
});

Deno.test('web (R9): a host style value is adopted only when it can only paint', () => {
	for (const value of ['#101219', 'rgb(1 2 3 / 50%)', 'oklch(60% 0.1 250)', "'Inter', system-ui, sans-serif", '8px']) {
		assert(safeStyleValue(value), value);
	}
	for (
		const value of [
			'url(https://tracker.example/p.png)',
			'URL (x)',
			'image-set("a.png" 1x)',
			'red; background: url(x)',
			'}body{color:red',
			'<b>',
			'\\75rl(x)',
			'@import',
			'',
			'x'.repeat(201),
			42,
		]
	) {
		assert(!safeStyleValue(value), String(value));
	}
});

Deno.test('web (R9): the bridge accepts messages from its host window only, and answers a teardown', async () => {
	const posted: unknown[] = [];
	const host = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window;
	const listeners: Array<(event: MessageEvent) => void> = [];
	const realAdd = globalThis.addEventListener;
	globalThis.addEventListener = ((type: string, listener: (event: MessageEvent) => void) => {
		if (type === 'message') listeners.push(listener);
	}) as typeof globalThis.addEventListener;
	try {
		let tornDown = 0;
		const results: unknown[] = [];
		const bridge = new EmbedBridge({
			onToolResult: (result) => results.push(result),
			onTeardown: () => {
				tornDown += 1;
			},
		}, host);
		const connected = bridge.connect({ name: 'test', version: '1' });
		const deliver = (data: unknown, source: unknown = host) =>
			listeners.forEach((listener) => listener({ data, source } as MessageEvent));
		const init = posted[0] as { id: number; method: string; params: { protocolVersion: string } };
		assertEquals([init.method, init.params.protocolVersion], ['ui/initialize', '2026-01-26']);
		// A forged answer from another window is ignored; the host's is taken.
		deliver({ jsonrpc: '2.0', id: init.id, result: { hostContext: { theme: 'dark' } } }, {});
		deliver({ jsonrpc: '2.0', id: init.id, result: { hostContext: { theme: 'light' } } });
		assertEquals(await connected, { theme: 'light' });
		assertEquals((posted[1] as { method: string }).method, 'ui/notifications/initialized');
		deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { a: 1 } } }, {});
		deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { a: 2 } } });
		assertEquals(results, [{ structuredContent: { a: 2 } }]);
		deliver({ jsonrpc: '2.0', id: 'td', method: 'ui/resource-teardown', params: {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assertEquals(tornDown, 1);
		assertEquals(posted.at(-1), { jsonrpc: '2.0', id: 'td', result: {} });
		deliver({ jsonrpc: '2.0', id: 9, method: 'ui/message', params: {} });
		assertEquals((posted.at(-1) as { error: { code: number } }).error.code, -32601);
		// A refused tool result reads as `<code>: <message>`, structured or textual.
		assertEquals(
			toolErrorOf({ isError: true, structuredContent: { error: { code: 'scope-required', message: 'no' } } }),
			{ code: 'scope-required', message: 'no' },
		);
		assertEquals(toolErrorOf({ isError: true, content: [{ type: 'text', text: 'Error: unknown-session: gone' }] }), {
			code: 'unknown-session',
			message: 'gone',
		});
		assertEquals(toolErrorOf({ structuredContent: {} }), null);
	} finally {
		globalThis.addEventListener = realAdd;
	}
});

Deno.test('web (R9): the embeds never talk to the model, never fetch, and never write storage', async () => {
	const sources = new Map((await bundleSources()).map(({ name, code }) => [name, code]));
	for (const name of ['embed_bridge.ts', 'embed_live.ts', 'embed_a2ui.ts', 'embed_terminal.ts', 'embed_stream.ts']) {
		const code = sources.get(name) ?? '';
		assert(code !== '', `${name} is a top-level source, so the bundle rules above scan it`);
		assert(!/ui\/update-model-context|'ui\/message'/.test(code), `${name} sends to the model`);
		assert(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie/.test(code), `${name} reaches out`);
	}
	// The socket opens on a press, never at load: nothing after the shell is mounted calls `open(`.
	const live = sources.get('embed_live.ts') ?? '';
	const main = live.slice(live.indexOf('function main('));
	const tail = main.slice(main.lastIndexOf('app.append(shell);'));
	assert(!tail.includes('open('), 'nothing at load opens a socket');
	// The terminal and surface streams open on their own press too: only a click handler starts one.
	for (const name of ['embed_terminal.ts', 'embed_a2ui.ts']) {
		const code = sources.get(name) ?? '';
		const starts = [...code.matchAll(/stream\.start\(\)/g)].length;
		assertEquals(starts, 1, `${name}: one place starts the stream`);
		const handler = code.slice(code.lastIndexOf('on(', code.indexOf('stream.start()')), code.indexOf('stream.start()'));
		assertStringIncludes(handler, "'click'", `${name}: the stream starts from a click`);
		assert(!code.includes('new WebSocket'), `${name}: sockets are opened by embed_stream.ts alone`);
	}
});

/** One `{ … }` block of a stylesheet by its exact selector, or '' when it has none. */
function cssBlock(css: string, selector: string): string {
	const at = css.indexOf(`${selector} {`);
	return at < 0 ? '' : css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

Deno.test("web (RV-1): the embed's primary label reads at 4.5:1 on its fill in every theme, and hover only darkens", async () => {
	const css = await Deno.readTextFile(new URL('./styles/embed.css', import.meta.url));
	const primary = cssBlock(css, '.e-btn.primary');
	const fill = /background:\s*var\((--[a-z0-9-]+)\)/.exec(primary)?.[1];
	const ink = /(?:^|\s)color:\s*var\((--[a-z0-9-]+)\)/.exec(primary)?.[1];
	assert(fill !== undefined && ink !== undefined, `.e-btn.primary paints a token on a token: ${primary}`);
	// The dark tones are `:root`'s; each light block restates what it changes and inherits the rest.
	const dark = cssBlock(css, ':root');
	const themes: Record<string, string> = {
		dark,
		'light (host)': cssBlock(css, ":root[data-theme='light']"),
		'light (system)': cssBlock(css, ':root:not([data-theme])'),
	};
	const hex = (block: string, token: string): string | undefined =>
		new RegExp(`${token}:\\s*(#[0-9a-f]{6})\\b`, 'i').exec(block)?.[1];
	for (const [theme, block] of Object.entries(themes)) {
		assert(block !== '', `the ${theme} block exists`);
		const background = hex(block, fill) ?? hex(dark, fill);
		const label = hex(block, ink) ?? hex(dark, ink);
		assert(background !== undefined && label !== undefined, `${theme}: ${fill} and ${ink} resolve to colours`);
		const ratio = contrastRatio(background, label);
		assert(ratio >= 4.5, `${theme}: the Watch label is ${ratio.toFixed(2)}:1 on ${background} (needs 4.5:1)`);
	}
	// A white label only gains contrast as its fill darkens; hover must never lighten it below the floor.
	const hover = cssBlock(css, '.e-btn.primary:hover:not(:disabled)');
	assert(
		new RegExp(`background:\\s*color-mix\\(in oklab, var\\(${fill}\\) \\d+%, black\\)`).test(hover),
		`hover darkens the fill: ${hover}`,
	);
});

Deno.test('web (K-5, RV-9): the SPA entry and both embeds turn off Zod’s eval probe before anything builds a schema', async () => {
	for (const entry of ['app.ts', 'embed_live.ts', 'embed_a2ui.ts', 'embed_terminal.ts']) {
		const code = await Deno.readTextFile(new URL(entry, import.meta.url));
		// Module evaluation follows import order: the first import is the one evaluated before every schema.
		const first = /^import\s[^;]*?'([^']+)';/m.exec(code)?.[1];
		assertEquals(first, './jitless.ts', `${entry}: the first import`);
	}
	// The module sets Zod's own global configuration: the installed Zod reads it back as `jitless`, so its eval probe
	// is skipped (and nothing is reported under the page CSP) whichever of the two is evaluated first.
	await import('./jitless.ts');
	assertEquals(zodConfig().jitless, true, 'Zod adopts the flag jitless.ts set');
	// Without importing Zod: the validator stays out of the entry (D-069), loaded only with a Live View.
	const code = await Deno.readTextFile(new URL('./jitless.ts', import.meta.url));
	assert(!/^import\b/m.test(code), 'jitless.ts imports nothing');
});

Deno.test({
	name: 'web (K-5): the built entry loads no Zod at first paint; the validator stays in the lazy chunks (D-069)',
	ignore: !distBuilt,
	fn() {
		const read = (name: string): string => Deno.readTextFileSync(new URL(name, DIST));
		// Every chunk the entry imports statically, transitively — what a first paint downloads before any screen asks.
		const seen = new Set<string>();
		const visit = (name: string): void => {
			if (seen.has(name)) return;
			seen.add(name);
			for (const [, next = ''] of read(name).matchAll(/(?:from|import)\s*"\.\/([A-Za-z0-9_-]+\.js)"/g)) visit(next);
		};
		visit('app.js');
		const zod = [...seen].filter((name) => /\bZodObject\b|_zod\b/.test(read(name)));
		assertEquals(zod, [], `first-paint chunks carrying Zod: ${[...seen].join(', ')}`);
	},
});

Deno.test('web (D-148): Change password is offered to an account sign-in, by password or by its own key, and nothing else', async () => {
	const account = { id: 'admin:alice', username: 'alice', kind: 'api-key', scopes: ['mcp:invoke'] };
	assertEquals(canChangeOwnPassword({ ...account, backing: 'user' }, true), true, 'a password sign-in');
	assertEquals(canChangeOwnPassword({ ...account, backing: 'user-key' }, true), true, "an account key's sign-in");
	const configured = { id: 'ci', kind: 'api-key', scopes: ['mcp:invoke'], backing: 'api-key' };
	assertEquals(canChangeOwnPassword(configured, true), false, "a configured key's sign-in has no account");
	assertEquals(canChangeOwnPassword({ ...account, backing: 'user' }, false), false, 'no sign-in on this page');
	assertEquals(canChangeOwnPassword(null, true), false);
	// The backing not known yet (an older gateway's `auth/me`): an account's id still names an account.
	assertEquals(canChangeOwnPassword(account, true), true);
	assertEquals(canChangeOwnPassword({ id: 'ci', kind: 'api-key', scopes: [] }, true), false);
	// A key's sign-in ends no sign-in of its own, so the confirmation says what did end.
	assertStringIncludes(passwordChangedText({ ...account, backing: 'user-key' }), "the account's password sign-ins");
	assertStringIncludes(passwordChangedText({ ...account, backing: 'user' }), 'your other sign-ins');
	// The shell asks the helper, and still names a key's sign-in as one.
	const shell = await Deno.readTextFile(new URL('./shell.ts', import.meta.url));
	assertStringIncludes(shell, '...(canChangeOwnPassword(user) ? [passwordButton] : [])');
	assertStringIncludes(shell, "'Signed in with an account API key'");
});
