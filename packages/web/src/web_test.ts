/// <reference lib="deno.ns" />
/**
 * Web-package tests: the wire contract, the security rules every module is held to, the reconnect policy, the
 * bundle budgets and the MCP Apps embeds. Rendering itself is covered by the browser-tier e2e run. The package's
 * `lib` is browser-only; this file opts back into the runtime types it needs to read its own sources.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ClientMsgSchema, decodeFrame, encodeFrame } from '@tykotech/wire';
import { retryAfterMsOf } from './api.ts';
import { leaveScreen, onLeave, onSignOut, signOut } from './lifecycle.ts';
import nodes from 'lucide-static/icon-nodes.json' with { type: 'json' };
import { CUSTOM_ICONS, ICONS, SYSTEM_ICONS } from './icon_names.ts';
import { nextRetryDelayMs, RECOVERY_WINDOW_MS } from './viewer_view.ts';
import { EmbedBridge, safeStyleValue, toolErrorOf } from './embed_bridge.ts';
import { EMBED_ICONS } from './embed_icons.ts';
import { contrastRatio } from './a2ui.ts';
import { canChangeOwnPassword, passwordChangedText } from './password_dialog.ts';
import { config as zodConfig } from 'zod';

Deno.test('web: the bundle and the gateway agree on the frame envelope', () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9]);
	const meta = { type: 'frame' as const, seq: 42, ts: 1, w: 800, h: 600, targetId: 'T' };
	const round = decodeFrame(encodeFrame(meta, jpeg).buffer as ArrayBuffer);
	assertEquals(round.meta, meta);
	assertEquals([...round.jpeg], [...jpeg]);
});

Deno.test('web: every message the canvas and the viewer emit is valid on the wire', () => {
	const emitted: unknown[] = [
		{ type: 'input.mouse', kind: 'down', x: 10, y: 20, button: 'left' },
		{ type: 'input.mouse', kind: 'move', x: 1, y: 2 },
		{ type: 'input.wheel', x: 5, y: 6, deltaX: 0, deltaY: 120 },
		{ type: 'input.key', kind: 'down', key: 'a', code: 'KeyA', modifiers: 0, text: 'a' },
		{ type: 'input.key', kind: 'down', key: 'a', modifiers: 15 },
		{ type: 'control.take' },
		{ type: 'control.release' },
		{ type: 'navigate', url: 'https://example.com/' },
		{ type: 'tab.switch', tabId: 'T1' },
		// The keep-alive answer ws.ts sends on every server `ping`.
		{ type: 'pong' },
	];
	for (const message of emitted) {
		assert(ClientMsgSchema.safeParse(message).success, `the server would reject ${JSON.stringify(message)}`);
	}
	// The modifier bitmask holds the four real modifiers (Alt 1, Ctrl 2, Meta 4, Shift 8) and no more.
	assert(!ClientMsgSchema.safeParse({ type: 'input.key', kind: 'down', key: 'a', modifiers: 16 }).success);
});

/** The bundle's sources with comments stripped: several modules name forbidden APIs in comments to say they are not used. */
async function bundleSources(): Promise<Array<{ name: string; code: string }>> {
	const files: Array<{ name: string; code: string }> = [];
	for await (const entry of Deno.readDir(new URL('.', import.meta.url))) {
		if (!entry.isFile || !entry.name.endsWith('.ts') || entry.name.endsWith('_test.ts')) continue;
		const raw = await Deno.readTextFile(new URL(entry.name, import.meta.url));
		files.push({ name: entry.name, code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1') });
	}
	return files;
}

Deno.test('web: no module turns a string into markup or sets a style attribute the CSP refuses', async () => {
	const sources = await bundleSources();
	assertEquals(
		sources.filter(({ code }) => /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/.test(code)).map(({ name }) => name),
		[],
		'server strings and page content reach the DOM as text only',
	);
	// `style-src 'self'` blocks style attributes; CSSOM writes (`node.style.x = …`) are not gated and stay legal.
	assertEquals(
		sources
			.filter(({ code }) => /\bstyle:\s*['"`]/.test(code) || /setAttribute\(\s*['"`]style['"`]/.test(code))
			.map(({ name }) => name),
		[],
	);
});

Deno.test('web: only theme.ts touches storage, and it keeps only the theme', async () => {
	// The sign-in is an HttpOnly cookie the page cannot read, so no module stores a credential of any kind.
	const sources = await bundleSources();
	assertEquals(
		sources
			.filter(({ name, code }) => name !== 'theme.ts' && /localStorage|sessionStorage|document\.cookie/.test(code))
			.map(({ name }) => name),
		[],
	);
	const theme = sources.find(({ name }) => name === 'theme.ts')?.code ?? '';
	assert(!/sessionStorage|document\.cookie/.test(theme));
	assertEquals([...theme.matchAll(/setItem\(([^)]*)\)/g)].map((match) => match[1]), ['THEME_STORAGE_KEY, theme']);
	const { THEME_STORAGE_KEY } = await import('./theme.ts');
	assertEquals(THEME_STORAGE_KEY, 'ttk.theme');
	assertStringIncludes(theme, "value === 'dark' || value === 'light' ? value : null");
});

Deno.test('web: requests ride the cookie same-origin and carry the CSRF value on every change', async () => {
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

Deno.test('web: a me answer without a CSRF value is not a cookie sign-in', async () => {
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request) => {
		calls.push(String(input));
		// The credential-less loopback principal answers `me` too, without a CSRF value.
		return Promise.resolve(new Response(JSON.stringify({ user: { id: 'x', scopes: [] } }), { status: 200 }));
	}) as typeof fetch;
	try {
		const { restoreSession } = await import('./api.ts');
		assertEquals(await restoreSession(), false);
		assertEquals(calls, ['/api/v1/auth/me'], 'one question, and nothing else sent');
	} finally {
		globalThis.fetch = realFetch;
	}
});

Deno.test('web: Retry-After is read as delta-seconds, and bounded', () => {
	const of = (value: string | null) => retryAfterMsOf(new Headers(value === null ? {} : { 'retry-after': value }));
	assertEquals(of(null), null, 'absent means no server opinion');
	assertEquals(of(' 5 '), 5_000, 'surrounding whitespace is legal');
	assertEquals(of('0'), 0, 'zero is a real answer, not a missing one');
	// The HTTP-date form is legal and deliberately not honoured: it would trust this browser's clock.
	assertEquals(of('Wed, 21 Oct 2026 07:28:00 GMT'), null);
	assertEquals(of('-1'), null);
	assertEquals(of('99999'), 600_000, 'capped: the recovery window is ten minutes');
});

Deno.test('web: the reconnect schedule backs off, respects a cool-off, and fits the ten-minute window', () => {
	const hour = 3_600_000;
	assertEquals(RECOVERY_WINDOW_MS, 600_000);
	assertEquals(nextRetryDelayMs(1, hour, 0), 750);
	assertEquals(nextRetryDelayMs(5, hour, 0), 12_000);
	assertEquals(nextRetryDelayMs(40, hour, 0), 15_000, 'the backoff is capped');
	// A 429 cool-off outranks the backoff while it lasts, and is ignored once past.
	assertEquals(nextRetryDelayMs(1, hour, 30_000), 30_000);
	assertEquals(nextRetryDelayMs(1, hour, -5_000), 750);
	// Nothing is scheduled past the end of the window: the final attempt must run.
	assertEquals(nextRetryDelayMs(6, 2_000, 0), 2_000);
	assertEquals(nextRetryDelayMs(1, 400, 30_000), 400);
});

Deno.test('web: a re-render tears down the screen it replaces, exactly once; sign-out forgets every time', () => {
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

	const history = ['call by the previous credential'];
	onSignOut(() => history.splice(0));
	signOut();
	assertEquals(history, []);
	history.push('call by the next credential');
	signOut();
	assertEquals(history, [], 'the hook stays registered for every later sign-out');
});

Deno.test('web: every icon name maps to a real Lucide glyph or a drawn one, the embeds’ included', () => {
	// `scripts/build_icons.ts` fails the build on an unknown name; this fails the unit tier first, with the name.
	const lucide = nodes as unknown as Record<string, unknown>;
	const real = (source: string): boolean => source.startsWith('@') ? source.slice(1) in CUSTOM_ICONS : source in lucide;
	const missing = [...Object.entries(ICONS), ...Object.entries(SYSTEM_ICONS)].filter(([, source]) => !real(source));
	assertEquals(missing, []);
	for (const name of EMBED_ICONS) assert(name in ICONS, `${name} is not an app icon`);
});

Deno.test('web: the kit never fetches icons or code by URL, and binds no style attribute', async () => {
	// Sprite-sheet mode keeps wa-icon off its fetch-and-parse path; the library entry would bring the autoloader.
	const kit = await Deno.readTextFile(new URL('./kit.ts', import.meta.url));
	assertEquals(kit.match(/registerIconLibrary\('(default|system)', \{[^;]*spriteSheet: true,\s*\}\);/g)?.length, 2);
	const sources = await bundleSources();
	assertEquals(
		sources.filter(({ code }) =>
			/webawesome\/dist\/webawesome(\.loader)?\.js|webawesome\/dist\/utilities\/autoloader/.test(code)
		).map(({ name }) => name),
		[],
	);
	// Components that bind `styleMap` write a `style` attribute the page CSP refuses.
	const kitModules = sources.filter(({ name }) => /^kit(_[a-z]+)?\.ts$/.test(name)).map(({ code }) => code).join('\n');
	for (const component of ['progress-ring', 'slider', 'rating', 'color-picker', 'qr-code', 'carousel', 'comparison']) {
		assert(!kitModules.includes(`/components/${component}/`), `${component} binds styleMap`);
	}
	// Components that turn fetched or authored text into markup are not used at all.
	assertEquals(sources.filter(({ code }) => /wa-include|wa-markdown|wa-icon[^)]*\bsrc\b/.test(code)).length, 0);
});

/** `html` without its comments, stripped until nothing changes (`<!-<!-- x -->- y -->` joins into another). */
function withoutComments(html: string): string {
	let text = html;
	let before: string;
	do {
		before = text;
		text = text.replace(/<!--[\s\S]*?-->/g, '');
	} while (text !== before);
	return text;
}

Deno.test('web: the page CSP admits only this origin, with media-src for A2UI players', async () => {
	const html = await Deno.readTextFile(new URL('../static/index.html', import.meta.url));
	assertStringIncludes(
		html,
		"content=\"default-src 'self'; img-src 'self' blob: data:; media-src 'self' data: blob:; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'\"",
	);
	assert(!/https?:\/\//.test(withoutComments(html)), 'the shell page names no other origin');
	const css = await Deno.readTextFile(new URL('./styles/app.css', import.meta.url));
	assert(!/@import\s+['"]?https?:/.test(css), 'no stylesheet is pulled from another origin');
});

Deno.test('web: Change password is offered to an account sign-in, by password or by its own key, and nothing else', () => {
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
});

Deno.test('web: no module calls crypto.randomUUID, which plain http on a LAN address lacks', async () => {
	// `crypto.randomUUID` exists only in a secure context, and the app is also served over plain http.
	for (const { name, code } of await bundleSources()) assert(!code.includes('crypto.randomUUID('), name);
});

Deno.test('web: the SPA entry and the embeds turn off Zod’s eval probe before anything builds a schema', async () => {
	for (const entry of ['app.ts', 'embed_live.ts', 'embed_a2ui.ts', 'embed_terminal.ts']) {
		const code = await Deno.readTextFile(new URL(entry, import.meta.url));
		// Module evaluation follows import order: the first import is evaluated before every schema.
		assertEquals(/^import\s[^;]*?'([^']+)';/m.exec(code)?.[1], './jitless.ts', `${entry}: the first import`);
	}
	await import('./jitless.ts');
	assertEquals(zodConfig().jitless, true, 'Zod adopts the flag jitless.ts set');
	const code = await Deno.readTextFile(new URL('./jitless.ts', import.meta.url));
	assert(!/^import\b/m.test(code), 'jitless.ts imports nothing, so the validator stays out of the entry');
});

// --- the built bundle (when `deno task build:web` has run in this checkout) --------------------------------------

const DIST = new URL('../dist/', import.meta.url);
let distBuilt = false;
try {
	distBuilt = Deno.statSync(new URL('app.js', DIST)).isFile;
} catch {
	// Not built: the browser tier asserts the budgets instead.
}

/** Every chunk `name` imports statically, transitively. */
function staticClosure(name: string, seen = new Set<string>()): Set<string> {
	if (seen.has(name)) return seen;
	seen.add(name);
	const code = Deno.readTextFileSync(new URL(name, DIST));
	for (const [, next = ''] of code.matchAll(/(?:from|import)\s*"\.\/([A-Za-z0-9_-]+\.js)"/g)) staticClosure(next, seen);
	return seen;
}

async function gzipSize(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
	return (await new Response(stream).arrayBuffer()).byteLength;
}

Deno.test({
	name: 'web: every chunk fits 150 KB; a first paint stays within its compressed budget and loads no Zod',
	ignore: !distBuilt,
	async fn() {
		const budget = 150 * 1024;
		for (const entry of Deno.readDirSync(DIST)) {
			if (!entry.isFile || !entry.name.endsWith('.js')) continue;
			const bytes = Deno.statSync(new URL(entry.name, DIST)).size;
			assert(bytes < budget, `${entry.name} is ${Math.round(bytes / 1024)} KB, over the 150 KB budget`);
		}
		const entry = Deno.readTextFileSync(new URL('app.js', DIST));
		const files = staticClosure('app.js');
		for (const [, kit = ''] of entry.matchAll(/import\("\.\/(kit[a-z_]*-[A-Z0-9]+\.js)"\)/g)) staticClosure(kit, files);
		assert([...files].some((name) => name.startsWith('kit-')), 'the kit is part of the first paint');
		assert(
			![...files].some((name) => /(workspaces|resources|agent|users|system)_view|a2ui|ws-/.test(name)),
			`lazy screens stay lazy: ${[...files]}`,
		);
		assertEquals(
			[...staticClosure('app.js')].filter((name) =>
				/\bZodObject\b|_zod\b/.test(
					Deno.readTextFileSync(new URL(name, DIST)),
				)
			),
			[],
			'the validator loads with a Live View, not with the first paint',
		);
		let js = 0;
		for (const name of files) js += await gzipSize(Deno.readFileSync(new URL(name, DIST)));
		assert(js < 160 * 1024, `first-paint JavaScript is ${Math.round(js / 1024)} KB gzip, over 160 KB`);
		const css = await gzipSize(Deno.readFileSync(new URL('app.css', DIST)));
		assert(css < 50 * 1024, `the stylesheet is ${Math.round(css / 1024)} KB gzip, over 50 KB`);
		const { SCREEN_SHEETS } = await import('./styles.ts');
		for (const sheet of new Set(Object.values(SCREEN_SHEETS).flat())) {
			assert(Deno.statSync(new URL(`screens/${sheet}.css`, DIST)).size > 500, `screens/${sheet}.css is built`);
		}
	},
});

// --- MCP Apps embeds ---------------------------------------------------------------------------------------------

const EMBEDS = ['embed_live.html', 'embed_a2ui.html', 'embed_terminal.html'] as const;

async function sha256Source(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

Deno.test({
	name: 'web: each embed is one self-contained document within 200 KB, its inline code pinned by hash',
	ignore: !distBuilt,
	async fn() {
		await Deno.stat(new URL('embed-src/', DIST)).then(
			() => assert(false, 'dist/embed-src/ must be gone after the build'),
			() => {},
		);
		for (const name of EMBEDS) {
			const html = await Deno.readTextFile(new URL(name, DIST));
			const bytes = new TextEncoder().encode(html).length;
			assert(bytes <= 200 * 1024, `${name} is ${Math.round(bytes / 1024)} KB, over the 200 KB budget`);
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

Deno.test('web: build:web bundles the embeds in the task, chained with &&, and grants no --allow-run', async () => {
	const tasks = JSON.parse(await Deno.readTextFile(new URL('../../../deno.json', import.meta.url))).tasks as Record<
		string,
		string | { command?: string }
	>;
	const entry = tasks['build:web'];
	const build = (typeof entry === 'string' ? entry : entry?.command) ?? '';
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

Deno.test('web: a host style value is adopted only when it can only paint', () => {
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

Deno.test('web: the bridge accepts messages from its host window only, and answers a teardown', async () => {
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

Deno.test('web: the embeds never talk to the model, never fetch, never write storage, and open streams on a click', async () => {
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
	assert(!main.slice(main.lastIndexOf('app.append(shell);')).includes('open('), 'nothing at load opens a socket');
	for (const name of ['embed_terminal.ts', 'embed_a2ui.ts']) {
		const code = sources.get(name) ?? '';
		assertEquals([...code.matchAll(/stream\.start\(\)/g)].length, 1, `${name}: one place starts the stream`);
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

Deno.test("web: the embed's primary label reads at 4.5:1 on its fill in every theme, and hover only darkens", async () => {
	const css = await Deno.readTextFile(new URL('./styles/embed.css', import.meta.url));
	const primary = cssBlock(css, '.e-btn.primary');
	const fill = /background:\s*var\((--[a-z0-9-]+)\)/.exec(primary)?.[1];
	const ink = /(?:^|\s)color:\s*var\((--[a-z0-9-]+)\)/.exec(primary)?.[1];
	assert(fill !== undefined && ink !== undefined, `.e-btn.primary paints a token on a token: ${primary}`);
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
	const hover = cssBlock(css, '.e-btn.primary:hover:not(:disabled)');
	assert(
		new RegExp(`background:\\s*color-mix\\(in oklab, var\\(${fill}\\) \\d+%, black\\)`).test(hover),
		`hover darkens the fill: ${hover}`,
	);
});
