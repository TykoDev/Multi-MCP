/**
 * The request scope (`TTK_ALLOWED_DOMAINS_SCOPE`) on real Chromium. One page issues every request class a page can
 * (stylesheet, font, image, script, audio, iframe, `<a ping>`, fetch, XHR, EventSource, WebSocket, beacon, dedicated,
 * shared and service workers, preload/prefetch/prerender/preconnect hints, speculation rules) off the allowlist, next
 * to on-list equivalents on a second site. The off-list host is a raw TCP recorder counting connections, reached by
 * names Chromium resolves to loopback itself, so "zero" is measured.
 *
 * - `documents`: off-list subresources still arrive; hints and speculation do not; the off-list iframe document is
 *   vetoed before it is sent (one record).
 * - `all`: no connection at all, from the page, a pop-up or an OOPIF; on-list loads; refusals are logged as
 *   `net::ERR_BLOCKED_BY_CLIENT.Inspector`; worker targets are armed before resume. Also for an IP literal.
 * - `all` under a proxy: no HTTP request for the off-list host reaches it; the WebSocket `CONNECT` does (the
 *   measured residual).
 */
import { assert, assertEquals, assertGreater } from '@std/assert';
import type { EventRecord } from '@tykotech/wire';
import { type Harness, harness, poll, skipUnlessBrowser } from '../support/harness.ts';

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

/** Every request class, aimed at `aim.off`; on-list equivalents on `aim.siteB`. */
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

/** Two on-list servers: `a` (as `aHost`) serves the pages and workers; `b` (as `ttk-site-b.test`) the second site. */
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

async function clickById(h: Harness, id: string): Promise<void> {
	const state = await h.callStructured<{ interactive_elements: Element[] }>('browser_get_state', {
		fields: ['core', 'attrs'],
	});
	const element = state.interactive_elements.find((entry) => entry.attrs?.id === id);
	assert(element !== undefined, `#${id} not in ${JSON.stringify(state.interactive_elements)}`);
	await h.call('browser_click', { index: element.index });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every blocked navigation record on the default session's ring. */
function blocked(h: Harness): EventRecord[] {
	const events = h.gateway.registry.peek('default')?.events;
	return (events?.read({ kind: 'cursor', epoch: events.epoch, seq: 0 }) ?? [])
		.filter((event) => event.kind === 'navigation' && event.payload.blocked === true);
}

type Manager = { requestRefusals: ReadonlyMap<string, number>; requestScope: string };

/** The default session's vendored `SessionManager`: the scope and the per-target-type refusal counts. */
function manager(h: Harness): Manager {
	return (h.gateway.registry.peek('default') as unknown as { session: { sessionManager: Manager } }).session
		.sessionManager;
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

// --- documents ------------------------------------------------------------------------------------------------------

Deno.test({
	name: 'e2e request scope (documents): subresources unchanged, hints refused, the iframe document is vetoed',
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
			await poll('the service worker to activate', () => s.aHits.includes('/sw-ready') ? true : undefined);
			await pause(3_000);
			const paths = rec.lines.map((line) => line.split(' ')[1]?.split('?')[0] ?? line);
			const records = blocked(h);
			assertEquals(manager(h).requestScope, 'documents');
			// Subresources still leave, which also proves the recorder is reachable by these names.
			for (const path of ['/img.png', '/script.js', '/style.css', '/fetch', '/xhr', '/worker-fetch']) {
				assert(paths.includes(path), `documents: ${path} must still reach the off-list host`);
			}
			assert(paths.includes('/preload.js') && paths.includes('/modulepreload.js'), JSON.stringify(paths));
			// No hint, no prerender prefetch, no speculation (off under an allowlist), no iframe document.
			for (const path of ['/lp-0', '/lp-1', '/lp-2', '/link-prerender', '/spec-prefetch', '/frame.html']) {
				assert(!paths.includes(path), `documents: ${path} must not be sent`);
			}
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

// --- all ------------------------------------------------------------------------------------------------------------

Deno.test({
	name: 'e2e request scope (all): no off-list connection from a page, a pop-up or an OOPIF',
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

				await t.step(
					'the all-classes page: every request class aimed off-list sends nothing; on-list loads',
					async () => {
						await h.callText('browser_navigate', { url: `${s.a}/all.html` });
						await poll('the service worker to activate', () => s.aHits.includes('/sw-ready') ? true : undefined);
						await pause(3_000);
						const records = blocked(h);
						const refusals = Object.fromEntries(manager(h).requestRefusals);
						assertEquals(manager(h).requestScope, 'all');
						assertEquals(rec.connections(), 0, 'no request, WebSocket or preconnect may reach the off-list host');
						// On-list equivalents load, the WebSocket included (the layer excludes the allowlist).
						assert(s.bHits.includes('/siteb.png'), JSON.stringify(s.bHits));
						assert(s.bHits.includes('/ws-onlist[ws]'), `on-list WebSocket: ${JSON.stringify(s.bHits)}`);
						// One record per refused document — the off-list iframe — and none for the refused subresources.
						assertEquals(records.length, 1, JSON.stringify(records.map((event) => event.payload)));
						assertEquals(records[0]?.payload.path, '/frame.html');
						assert(!JSON.stringify(records).includes(CODE), 'a query reached the ring');
						// Armed before resume on the worker types, without a stall (the service worker activated above).
						assertGreater(refusals.service_worker ?? 0, 0, 'the service worker’s own requests were judged');
						assertGreater(refusals.shared_worker ?? 0, 0, 'the shared worker’s own requests were judged');
						assertEquals(warnings.filter((line) => line.includes('could not be armed')), []);
					},
				);

				await t.step('browser_network_log names each refusal net::ERR_BLOCKED_BY_CLIENT', async () => {
					const log = await h.callStructured<{
						entries: Array<{
							origin: string;
							path: string;
							resource_type: string;
							error_text: string | null;
							blocked_reason: string | null;
						}>;
					}>('browser_network_log', { failed_only: true, limit: 500 });
					const refused = log.entries.filter((entry) => off.includes(entry.origin));
					// How Chrome reports `Fetch.failRequest(BlockedByClient)`; a refused document is `net::ERR_ABORTED`.
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

				await t.step('a window.open pop-up of an on-list page sends nothing off-list', async () => {
					await h.callText('browser_navigate', { url: `${s.a}/popup.html` });
					const before = s.aHits.length;
					await clickById(h, 'go');
					await poll(
						'the pop-up to load',
						() => s.aHits.slice(before).includes('/popup-child.html') ? true : undefined,
					);
					await pause(2_500);
					assertEquals(rec.connections(), 0);
				});

				await t.step('an OOPIF (an on-list site) whose img/fetch/WS aim off-list sends nothing', async () => {
					const before = s.bHits.length;
					await h.callText('browser_navigate', { url: `${s.a}/oopif.html` });
					await poll(
						'the OOPIF to load',
						() => s.bHits.slice(before).includes('/oopif-inner.html') ? true : undefined,
					);
					await pause(2_500);
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
	name: 'e2e request scope (all, IP literal): an off-list IP literal is refused by Fetch and the layer alike',
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
			assert(s.aHits.includes('/leave.html'), 'the on-list page loaded by name');
			assertEquals(rec.connections(), 0);
		} finally {
			await s.close();
			await rec.close();
		}
	},
});

// --- all under a proxy ----------------------------------------------------------------------------------------------

Deno.test({
	name: 'e2e request scope (all, proxy): no HTTP request reaches it; the WebSocket CONNECT does',
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
			assert(s.aHits.includes('/leave.html'));
			assertEquals(forOff.filter((line) => !line.startsWith('CONNECT ')), [], 'no HTTP request for the off-list host');
			assert(
				forOff.some((line) => line.startsWith(`CONNECT ${offHost} `)),
				`the measured residual: the WebSocket CONNECT reaches the proxy — ${JSON.stringify(proxy.lines)}`,
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
