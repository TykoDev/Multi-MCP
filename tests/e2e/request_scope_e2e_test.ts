/**
 * The request scope on real Chromium (D-138, D-139; ERRATUM(E-114), ERRATUM(E-115), ERRATUM(E-116)) — AC14, AC15,
 * AC16 and the build measurements MB1 and MB3.
 *
 * One page carries every request class the design probe measured (§2.9 C1): stylesheet, font, background image,
 * script, image, audio, an off-list iframe, `<a ping>`, `fetch`, XHR, EventSource, a WebSocket, a beacon, a dedicated
 * worker (its fetch and `importScripts`), a shared worker, a service worker (its `importScripts`, install fetch and
 * fetch-handler fetch), `<link rel=preload|modulepreload|prefetch|prerender|dns-prefetch|preconnect>` and a
 * speculation-rules prefetch — all aimed **off the allowlist**, next to on-list equivalents on a second site.
 *
 * The off-list host is a raw TCP recorder: it counts **connections**, so an HTTP request, a WebSocket upgrade and a
 * bare preconnect all register, and "zero" is read from it rather than inferred. It is reached by names Chromium
 * resolves to loopback by itself (`localhost`, `*.localhost` — no resolver rule maps them, so only the resolver layer
 * can refuse them) and, in its own leg, by an IP literal. The tier's net grant is loopback by name
 * (`127.0.0.1,localhost`) and this file does not widen it; the second on-list site is a name the browser alone maps to
 * `127.0.0.1` (`--host-resolver-rules`, folded into the layer by the registry).
 *
 * - **AC15** (`documents`, the default): the off-list subresources still arrive — unchanged, and proof the recorder
 *   is reachable — while `<link rel=prefetch>` to three hosts and `<link rel=prerender>` do not (G4), preload and
 *   modulepreload do (F13), speculation sends nothing, and the off-list iframe document is the one E0 record.
 * - **AC14** (`all`): the recorder sees **no connection at all** — from the page, from a `window.open` pop-up of an
 *   on-list page and from an out-of-process iframe (an on-list site) whose requests aim off-list — while the on-list
 *   equivalents load, WebSocket included. `browser_network_log` names the refusals `net::ERR_BLOCKED_BY_CLIENT.Inspector`
 *   (MB1), the off-list iframe document is still one record, and refused subresources add none. MB3: every attached target
 *   type but `worker` took `Fetch.enable` before its resume (no arming warning, the service and shared workers' first
 *   requests refused, the service worker still activates).
 * - **AC14, IP literal**: the same with `localhost` on the list and `127.0.0.1` off it.
 * - **AC16** (`all` under a recording proxy): no HTTP request for the off-list host reaches the proxy; the WebSocket
 *   `CONNECT` does — the measured residual (design C9), asserted so a change in either direction is seen.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertGreater } from '@std/assert';
import type { EventRecord } from '@tykotech/wire';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('request scope e2e');

/** The second on-list site, resolved to loopback by the browser alone. */
const SITE_B = 'ttk-site-b.test';
/** A query a refused request carries, which must reach no log, ring or recorder. */
const CODE = 'Zq8-SCOPE-CODE-7kP';

// --- servers -------------------------------------------------------------------------------------------------------

/** A raw TCP listener that counts every connection and keeps each one's first request line. */
interface Recorder {
	readonly port: number;
	readonly connections: () => number;
	readonly lines: string[];
	close(): Promise<void>;
}

function recorder(): Recorder {
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const lines: string[] = [];
	const open = new Set<Deno.Conn>();
	const handling = new Set<Promise<void>>();
	let connections = 0;
	const accepting = (async () => {
		for await (const conn of listener) {
			connections += 1;
			open.add(conn);
			const handled = (async () => {
				try {
					const buffer = new Uint8Array(4096);
					const timer = setTimeout(() => {
						try {
							conn.close();
						} catch { /* already closed */ }
					}, 3_000);
					const read = await conn.read(buffer).catch(() => null);
					clearTimeout(timer);
					const head = read === null ? '' : new TextDecoder().decode(buffer.subarray(0, read));
					lines.push(head.split('\r\n')[0] ?? '(no bytes)');
					await conn.write(
						new TextEncoder().encode(
							'HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\ncache-control: no-store\r\nconnection: close\r\n\r\n',
						),
					).catch(() => {});
				} finally {
					open.delete(conn);
					try {
						conn.close();
					} catch { /* already closed */ }
				}
			})();
			handling.add(handled);
			void handled.finally(() => handling.delete(handled));
		}
	})().catch(() => {});
	return {
		port: (listener.addr as Deno.NetAddr).port,
		connections: () => connections,
		lines,
		async close() {
			listener.close();
			for (const conn of open) {
				try {
					conn.close();
				} catch { /* already closed */ }
			}
			await accepting;
			await Promise.allSettled([...handling]);
		},
	};
}

const html = (body: string, head = ''): Response =>
	new Response(
		`<!doctype html><html><head><meta charset="utf-8"><title>scope</title>${head}</head><body>${body}</body></html>`,
		{
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
		},
	);
const js = (body: string): Response =>
	new Response(body, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } });

/** The off-list origins a page aims at, and the on-list second site. */
interface Aim {
	/** Off-list HTTP origins (each gets the full set of subresources). */
	readonly off: readonly string[];
	/** Off-list WebSocket URLs. */
	readonly ws: readonly string[];
	/** The on-list second site's origin (`http://ttk-site-b.test:PB`). */
	readonly siteB: string;
}

/** Every request class of design §2.9 C1, aimed at `aim.off`; on-list equivalents on `aim.siteB`. */
function allPage(aim: Aim): Response {
	const [first = ''] = aim.off;
	const q = `?code=${CODE}`;
	const head = [
		...aim.off.map((origin) => `<link rel="stylesheet" href="${origin}/style.css${q}">`),
		...aim.off.map((origin, index) => `<link rel="prefetch" href="${origin}/lp-${index}${q}">`),
		`<link rel="prerender" href="${first}/link-prerender${q}">`,
		`<link rel="preload" as="script" href="${first}/preload.js${q}">`,
		`<link rel="preload" as="fetch" crossorigin href="${first}/preload-fetch${q}">`,
		`<link rel="modulepreload" href="${first}/modulepreload.js${q}">`,
		`<link rel="dns-prefetch" href="//ttk-dns.localhost">`,
		`<link rel="preconnect" href="${first}">`,
		`<script type="speculationrules">${
			JSON.stringify({ prefetch: [{ source: 'list', urls: [`${first}/spec-prefetch${q}`] }] })
		}</script>`,
		`<style>@font-face{font-family:x;src:url(${first}/font.woff2${q})} body{font-family:x;background:url(${first}/bg.png${q})}</style>`,
		`<script src="${first}/script.js${q}"></script>`,
	].join('\n');
	const body = [
		...aim.off.map((origin) => `<img src="${origin}/img.png${q}">`),
		`<img src="${aim.siteB}/siteb.png">`,
		`<audio src="${first}/audio.mp3${q}" preload="auto"></audio>`,
		`<iframe src="${first}/frame.html${q}"></iframe>`,
		`<iframe src="/pingframe.html?to=${encodeURIComponent(first)}"></iframe>`,
		'<script>',
		...aim.off.map((origin) =>
			`fetch('${origin}/fetch${q}').catch(()=>{});` +
			`(()=>{const x=new XMLHttpRequest();x.open('GET','${origin}/xhr${q}');x.send();})();` +
			`try{new EventSource('${origin}/sse${q}')}catch(e){}` +
			`navigator.sendBeacon('${origin}/beacon${q}','x');`
		),
		...aim.ws.map((url) => `try{new WebSocket('${url}')}catch(e){}`),
		`try{new WebSocket('${aim.siteB.replace('http:', 'ws:')}/ws-onlist')}catch(e){}`,
		`new Worker('/worker.js?to=${encodeURIComponent(first)}');`,
		`try{new SharedWorker('/shared.js?to=${encodeURIComponent(first)}')}catch(e){}`,
		`if(navigator.serviceWorker){navigator.serviceWorker.register('/sw.js?to=${encodeURIComponent(first)}')` +
		`.then(()=>navigator.serviceWorker.ready).then(()=>fetch('/sw-ready')).then(()=>new Promise(r=>setTimeout(r,500)))` +
		`.then(()=>fetch('/via-sw')).catch(()=>{})}`,
		'</script>',
	].join('\n');
	return html(body, head);
}

/** The requests a page script makes to `to`: an image, a fetch and a WebSocket. */
function leavingScript(to: string, ws: string): string {
	return `<img src="${to}/leave.png?code=${CODE}"><script>fetch('${to}/leave-fetch?code=${CODE}').catch(()=>{});` +
		`try{new WebSocket('${ws}')}catch(e){}</script>`;
}

interface Site {
	readonly a: string;
	readonly b: string;
	readonly aHits: string[];
	readonly bHits: string[];
	close(): Promise<void>;
}

/**
 * Two on-list servers on loopback: `a` (reached as `aHost`) serves the probe pages and the workers; `b` (reached as
 * `ttk-site-b.test`) serves the second site's image, its WebSocket and the OOPIF document.
 */
function site(aHost: string, aim: (a: string, b: string) => Aim): Site {
	const aHits: string[] = [];
	const bHits: string[] = [];
	let aOrigin = '';
	let bOrigin = '';
	const a = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		const url = new URL(request.url);
		aHits.push(url.pathname);
		const to = url.searchParams.get('to') ?? '';
		const target = aim(aOrigin, bOrigin);
		switch (url.pathname) {
			case '/all.html':
				return allPage(target);
			case '/pingframe.html':
				return html(
					`<a id="a" href="/landing.html" ping="${to}/ping?code=${CODE}">go</a>` +
						`<script>setTimeout(()=>document.getElementById('a').click(),300)</script>`,
				);
			case '/worker.js':
				return js(
					`fetch('${to}/worker-fetch?code=${CODE}').catch(()=>{});` +
						`try{importScripts('${to}/worker-import.js?code=${CODE}')}catch(e){}`,
				);
			case '/shared.js':
				return js(`fetch('${to}/shared-fetch?code=${CODE}').catch(()=>{}); onconnect=()=>{};`);
			case '/sw.js':
				return js(
					`try{importScripts('${to}/sw-import.js?code=${CODE}')}catch(e){}\n` +
						`self.addEventListener('install',e=>{self.skipWaiting();` +
						`e.waitUntil(fetch('${to}/sw-install-fetch?code=${CODE}').catch(()=>{}))});\n` +
						`self.addEventListener('activate',e=>e.waitUntil(clients.claim()));\n` +
						`self.addEventListener('fetch',e=>{if(e.request.url.endsWith('/via-sw'))e.respondWith(` +
						`fetch('${to}/sw-handler-fetch?code=${CODE}').then(()=>new Response('ok')).catch(()=>new Response('x')))});`,
				);
			case '/popup.html':
				return html(
					`<button id="go" type="button" onclick='window.open("/popup-child.html","_blank","noopener")'>open</button>`,
				);
			case '/popup-child.html':
				return html(`<h1 id="child">child</h1>${leavingScript(target.off[0] ?? '', target.ws[0] ?? '')}`);
			case '/oopif.html':
				return html(`<iframe id="child" src="${bOrigin}/oopif-inner.html"></iframe>`);
			case '/leave.html':
				return html(`<h1 id="leave">leave</h1>${leavingScript(target.off[0] ?? '', target.ws[0] ?? '')}`);
			default:
				return html(`<h1 id="home">${url.pathname}</h1>`);
		}
	});
	const b = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		const url = new URL(request.url);
		const upgrade = (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
		bHits.push(`${url.pathname}${upgrade ? '[ws]' : ''}`);
		if (upgrade) {
			const { socket, response } = Deno.upgradeWebSocket(request);
			socket.onopen = () => socket.close();
			return response;
		}
		if (url.pathname === '/oopif-inner.html') {
			const target = aim(aOrigin, bOrigin);
			return html(`<h1 id="inner">inner</h1>${leavingScript(target.off[0] ?? '', target.ws[0] ?? '')}`);
		}
		return new Response('b', { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
	});
	aOrigin = `http://${aHost}:${(a.addr as Deno.NetAddr).port}`;
	bOrigin = `http://${SITE_B}:${(b.addr as Deno.NetAddr).port}`;
	return {
		a: aOrigin,
		b: bOrigin,
		aHits,
		bHits,
		async close() {
			await a.shutdown();
			await b.shutdown();
		},
	};
}

// --- helpers -------------------------------------------------------------------------------------------------------

interface Element {
	index: number;
	attrs?: Record<string, string>;
}

async function structured<T>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<T> {
	const result = await h.call(name, args);
	assert(result.isError !== true, `${name} failed: ${JSON.stringify(result.content)}`);
	return result.structuredContent as T;
}

async function clickById(h: Harness, id: string): Promise<void> {
	const state = await structured<{ interactive_elements: Element[] }>(h, 'browser_get_state', {
		fields: ['core', 'attrs'],
	});
	const element = state.interactive_elements.find((entry) => entry.attrs?.id === id);
	assert(element !== undefined, `#${id} not in ${JSON.stringify(state.interactive_elements)}`);
	await h.call('browser_click', { index: element.index });
}

async function until<T>(
	what: string,
	probe: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 12_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every blocked navigation record on the default session's ring. */
function blocked(h: Harness): EventRecord[] {
	const record = h.gateway.registry.peek('default') as
		| { events: { epoch: string; read(cursor: unknown): EventRecord[] } }
		| undefined;
	if (record === undefined) return [];
	return record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 })
		.filter((event) => event.kind === 'navigation' && event.payload.blocked === true);
}

/** The default session's vendored `SessionManager` — for MB3's per-type refusal counts and attached types. */
function manager(h: Harness): {
	requestRefusals: ReadonlyMap<string, number>;
	targets: ReadonlyMap<string, { type: string }>;
	requestScope: string;
} {
	const record = h.gateway.registry.peek('default') as unknown as {
		session: {
			sessionManager: {
				requestRefusals: ReadonlyMap<string, number>;
				targets: ReadonlyMap<string, { type: string }>;
				requestScope: string;
			};
		};
	};
	return record.session.sessionManager;
}

/** Collects the vendored logger's `warn` lines (it writes them through `console.warn`) while `run` executes. */
async function capturingWarnings<T>(run: (warnings: string[]) => Promise<T>): Promise<T> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(' '));
	};
	try {
		return await run(warnings);
	} finally {
		console.warn = original;
	}
}

// --- AC15: documents ------------------------------------------------------------------------------------------------

Deno.test({
	name: 'e2e request scope (AC15): documents — subresources unchanged, hints refused, the iframe document is E0',
	ignore,
	async fn() {
		const rec = recorder();
		const off = [
			`http://localhost:${rec.port}`,
			`http://ttk-off.localhost:${rec.port}`,
			`http://ttk-off2.localhost:${rec.port}`,
		];
		const s = site('127.0.0.1', (_a, b) => ({ off, ws: [`ws://localhost:${rec.port}/ws`], siteB: b }));
		try {
			await using h = await harness({
				env: {
					TTK_ALLOWED_DOMAINS: `127.0.0.1,${SITE_B}`,
					TTK_BROWSER_ARGS: `--host-resolver-rules=MAP ${SITE_B} 127.0.0.1`,
				},
			});
			await h.callText('browser_navigate', { url: `${s.a}/all.html` });
			await until('the service worker to activate', () => s.aHits.includes('/sw-ready') ? true : undefined);
			await pause(3_000);
			const paths = rec.lines.map((line) => line.split(' ')[1]?.split('?')[0] ?? line);
			const records = blocked(h);
			console.log(
				`[AC15] off-list recorder: ${rec.connections()} connections; paths ${
					JSON.stringify([...new Set(paths)].sort())
				}; ` +
					`blocked records ${JSON.stringify(records.map((event) => event.payload))}; scope ${manager(h).requestScope}`,
			);
			assertEquals(manager(h).requestScope, 'documents');
			// Unchanged: subresources still leave — which also proves the recorder is reachable by these names.
			for (const path of ['/img.png', '/script.js', '/style.css', '/fetch', '/xhr', '/worker-fetch']) {
				assert(paths.includes(path), `documents: ${path} must still reach the off-list host`);
			}
			// F13: preload and modulepreload are subresources, received in documents (documented).
			assert(paths.includes('/preload.js') && paths.includes('/modulepreload.js'), JSON.stringify(paths));
			// G4: no hint reaches any of the three hosts, and the prerender's NoState prefetch does not either.
			for (const path of ['/lp-0', '/lp-1', '/lp-2', '/link-prerender']) {
				assert(!paths.includes(path), `documents: the hint ${path} must not be sent`);
			}
			// ERRATUM(E-110): speculation is off under an allowlist, so the rule sends nothing.
			assert(!paths.includes('/spec-prefetch'), 'speculation sent a request');
			// The iframe's off-list document is refused before it is sent — the one record.
			assert(!paths.includes('/frame.html'), 'the off-list iframe document was sent');
			assertEquals(records.length, 1, JSON.stringify(records.map((event) => event.payload)));
			assertEquals(records[0]?.payload.containment, 'request-blocked');
			assertEquals(records[0]?.payload.path, '/frame.html');
			assert(!JSON.stringify(records).includes(CODE), 'a query reached the ring');
		} finally {
			await s.close();
			await rec.close();
		}
	},
});

// --- AC14 / MB1 / MB3: all ------------------------------------------------------------------------------------------

Deno.test({
	name: 'e2e request scope (AC14, MB1, MB3): all — no off-list connection from a page, a pop-up or an OOPIF',
	ignore,
	async fn(t) {
		const rec = recorder();
		const off = [`http://localhost:${rec.port}`, `http://ttk-off.localhost:${rec.port}`];
		const ws = [`ws://localhost:${rec.port}/ws`, `ws://ttk-off.localhost:${rec.port}/ws`];
		const s = site('127.0.0.1', (_a, b) => ({ off, ws, siteB: b }));
		try {
			await capturingWarnings(async (warnings) => {
				await using h = await harness({
					env: {
						TTK_ALLOWED_DOMAINS: `127.0.0.1,${SITE_B}`,
						TTK_ALLOWED_DOMAINS_SCOPE: 'all',
						TTK_BROWSER_ARGS: `--host-resolver-rules=MAP ${SITE_B} 127.0.0.1`,
					},
				});

				await t.step('the C1 page: every request class aimed off-list sends nothing; on-list loads', async () => {
					await h.callText('browser_navigate', { url: `${s.a}/all.html` });
					await until('the service worker to activate', () => s.aHits.includes('/sw-ready') ? true : undefined);
					await pause(3_000);
					const records = blocked(h);
					const refusals = Object.fromEntries(manager(h).requestRefusals);
					const types = [...new Set([...manager(h).targets.values()].map((target) => target.type))].sort();
					console.log(
						`[AC14] off-list recorder: ${rec.connections()} connections ${JSON.stringify(rec.lines)}; ` +
							`site B saw ${JSON.stringify([...new Set(s.bHits)].sort())}; blocked records ` +
							`${JSON.stringify(records.map((event) => event.payload))}`,
					);
					console.log(
						`[MB3] attached target types ${JSON.stringify(types)}; refusals by type ${JSON.stringify(refusals)}; ` +
							`arming warnings ${JSON.stringify(warnings.filter((line) => line.includes('could not be armed')))}`,
					);
					assertEquals(manager(h).requestScope, 'all');
					assertEquals(rec.connections(), 0, 'no request, WebSocket or preconnect may reach the off-list host');
					// On-list equivalents load, the WebSocket included (the layer excludes the allowlist).
					assert(s.bHits.includes('/siteb.png'), JSON.stringify(s.bHits));
					assert(s.bHits.includes('/ws-onlist[ws]'), `on-list WebSocket: ${JSON.stringify(s.bHits)}`);
					// One record per refused document — the off-list iframe — and none for the refused subresources.
					assertEquals(records.length, 1, JSON.stringify(records.map((event) => event.payload)));
					assertEquals(records[0]?.payload.path, '/frame.html');
					assert(!JSON.stringify(records).includes(CODE), 'a query reached the ring');
					// MB3: armed before resume on the worker types, without a stall (the service worker activated above).
					assertGreater(refusals.service_worker ?? 0, 0, 'the service worker’s own requests were judged');
					assertGreater(refusals.shared_worker ?? 0, 0, 'the shared worker’s own requests were judged');
					assertEquals(warnings.filter((line) => line.includes('could not be armed')), []);
				});

				await t.step('MB1: browser_network_log names each refusal net::ERR_BLOCKED_BY_CLIENT', async () => {
					const log = await structured<{
						entries: Array<{
							origin: string;
							path: string;
							resource_type: string;
							error_text: string | null;
							blocked_reason: string | null;
						}>;
					}>(h, 'browser_network_log', { failed_only: true, limit: 500 });
					const refused = log.entries.filter((entry) => off.includes(entry.origin));
					console.log(
						`[MB1] failed entries for off-list origins: ${
							JSON.stringify(
								refused.map((entry) => [entry.resource_type, entry.path, entry.error_text, entry.blocked_reason]),
							)
						}`,
					);
					// Measured on Chrome 154: a `Fetch.failRequest(BlockedByClient)` reaches `Network.loadingFailed` as
					// `net::ERR_BLOCKED_BY_CLIENT.Inspector` with `blockedReason: 'inspector'`; a refused document as M12's
					// `net::ERR_ABORTED`.
					const subresources = refused.filter((entry) => entry.resource_type !== 'Document');
					assertGreater(subresources.length, 10, JSON.stringify(refused));
					for (const entry of subresources) {
						assertEquals(entry.error_text, 'net::ERR_BLOCKED_BY_CLIENT.Inspector', JSON.stringify(entry));
						assertEquals(entry.blocked_reason, 'inspector', JSON.stringify(entry));
					}
					assertEquals(
						refused.filter((entry) => entry.resource_type === 'Document').map((entry) => entry.error_text),
						['net::ERR_ABORTED'],
					);
					assert(!JSON.stringify(log).includes(CODE), 'the request log is redacted at mint');
				});

				await t.step('F11: a window.open pop-up of an on-list page sends nothing off-list', async () => {
					await h.callText('browser_navigate', { url: `${s.a}/popup.html` });
					const before = s.aHits.length;
					await clickById(h, 'go');
					await until(
						'the pop-up to load',
						() => s.aHits.slice(before).includes('/popup-child.html') ? true : undefined,
					);
					await pause(2_500);
					console.log(`[AC14] pop-up: off-list recorder ${rec.connections()} connections`);
					assertEquals(rec.connections(), 0);
				});

				await t.step('F11: an OOPIF (an on-list site) whose img/fetch/WS aim off-list sends nothing', async () => {
					const before = s.bHits.length;
					await h.callText('browser_navigate', { url: `${s.a}/oopif.html` });
					await until(
						'the OOPIF to load',
						() => s.bHits.slice(before).includes('/oopif-inner.html') ? true : undefined,
					);
					await pause(2_500);
					console.log(`[AC14] OOPIF: off-list recorder ${rec.connections()} connections`);
					assertEquals(rec.connections(), 0);
				});
			});
		} finally {
			await s.close();
			await rec.close();
		}
	},
});

Deno.test({
	name: 'e2e request scope (AC14): all — an off-list IP literal is refused by Fetch and the layer alike',
	ignore,
	async fn() {
		const rec = recorder();
		const off = [`http://127.0.0.1:${rec.port}`];
		const s = site('localhost', (_a, b) => ({ off, ws: [`ws://127.0.0.1:${rec.port}/ws`], siteB: b }));
		try {
			await using h = await harness({
				env: {
					TTK_ALLOWED_DOMAINS: `localhost,${SITE_B}`,
					TTK_ALLOWED_DOMAINS_SCOPE: 'all',
					TTK_BROWSER_ARGS: `--host-resolver-rules=MAP ${SITE_B} 127.0.0.1`,
				},
			});
			await h.callText('browser_navigate', { url: `${s.a}/leave.html` });
			await pause(3_000);
			console.log(`[AC14] IP literal: off-list recorder ${rec.connections()} connections ${JSON.stringify(rec.lines)}`);
			assert(s.aHits.includes('/leave.html'), 'the on-list page loaded by name');
			assertEquals(rec.connections(), 0);
		} finally {
			await s.close();
			await rec.close();
		}
	},
});

// --- AC16: all under a proxy ----------------------------------------------------------------------------------------

Deno.test({
	name: 'e2e request scope (AC16): all under a proxy — no HTTP request reaches it; the WebSocket CONNECT does',
	ignore,
	async fn() {
		const rec = recorder();
		const proxy = recorder();
		// Not loopback, so it goes through the proxy (Chromium bypasses the proxy for loopback names on its own).
		const offHost = `ttk-off.test:${rec.port}`;
		const s = site('127.0.0.1', (_a, b) => ({ off: [`http://${offHost}`], ws: [`ws://${offHost}/ws`], siteB: b }));
		try {
			await using h = await harness({
				env: {
					TTK_ALLOWED_DOMAINS: '127.0.0.1',
					TTK_ALLOWED_DOMAINS_SCOPE: 'all',
					TTK_BROWSER_ARGS: `--proxy-server=http://127.0.0.1:${proxy.port}`,
				},
			});
			await h.callText('browser_navigate', { url: `${s.a}/leave.html` });
			await pause(3_000);
			const forOff = proxy.lines.filter((line) => line.includes('ttk-off.test'));
			console.log(
				`[AC16] proxy saw ${JSON.stringify(proxy.lines)}; off-list direct ${rec.connections()} connections`,
			);
			assert(s.aHits.includes('/leave.html'));
			assertEquals(forOff.filter((line) => !line.startsWith('CONNECT ')), [], 'no HTTP request for the off-list host');
			assert(
				forOff.some((line) => line.startsWith(`CONNECT ${offHost} `)),
				`the measured residual (C9): the WebSocket CONNECT reaches the proxy — ${JSON.stringify(proxy.lines)}`,
			);
			assert(!proxy.lines.some((line) => line.includes(CODE)), 'a refused request’s query reached the proxy');
			assertEquals(rec.connections(), 0, 'nothing reached the off-list host directly');
		} finally {
			await s.close();
			await proxy.close();
			await rec.close();
		}
	},
});
