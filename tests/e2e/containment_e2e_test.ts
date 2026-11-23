/**
 * Containment on real Chromium: with `TTK_ALLOWED_DOMAINS` set, every way a loaded page can leave the allowlist is
 * refused before its request is sent (the pre-request document veto). `127.0.0.1` and `ttk-site-b.test` (mapped to
 * loopback by the browser alone, so the tier's net grant is not widened) are on the list and are different sites;
 * `localhost` is off it, and its listener records every request, so "zero" is measured. Each leg: the off-list host
 * saw nothing, exactly one `request-blocked` record, and the tab is still on the allowlist; speculative legs also
 * leave zero off-list document commits (`Page.frameNavigated`). The `all` scope lives in `request_scope_e2e_test.ts`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { EventRecord } from '@tykotech/wire';
import { type Harness, harness, poll, skipUnlessBrowser } from '../support/harness.ts';
import { jsLiteral } from '../support/js_literal.ts';

const ignore = skipUnlessBrowser('containment e2e');

const CODE = 'Zq8-OFFLIST-CODE-3vP';
/** The second on-list site, resolved to loopback by the browser alone. */
const SITE_B = 'ttk-site-b.test';

const html = (body: string, head = ''): Response =>
	new Response(
		`<!doctype html><html><head><meta charset="utf-8"><title>e0</title>${head}</head><body>${body}</body></html>`,
		{
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
		},
	);

interface Servers {
	readonly a: string;
	readonly b: string;
	readonly off: string;
	readonly offHits: string[];
	close(): Promise<void>;
}

function servers(): Servers {
	const offHits: string[] = [];
	const off = Deno.serve({ hostname: 'localhost', port: 0, onListen: () => {} }, (request) => {
		const url = new URL(request.url);
		// A speculative request says so (`Sec-Purpose: prefetch…`), which is what tells it from a navigation.
		const purpose = request.headers.get('sec-purpose') ?? request.headers.get('purpose');
		offHits.push(`${request.method} ${url.pathname}${purpose === null ? '' : ` purpose=${purpose}`}`);
		return html(`<h1>off-list ${url.pathname}</h1>`);
	});
	const page = (request: Request): Response => {
		const url = new URL(request.url);
		const to = url.searchParams.get('to') ?? '/';
		// Written into <script> elements and single-quoted handler attributes below, so escaped for both.
		const target = jsLiteral(to);
		switch (url.pathname) {
			case '/click':
				return html(`<a id="go" href="${to}">go</a>`);
			case '/location':
				return html(`<button id="go" type="button" onclick='location.href=${target}'>go</button>`);
			case '/meta':
				return html('<h1 id="meta">refreshing</h1>', `<meta http-equiv="refresh" content="0;url=${to}">`);
			case '/form':
				return html(
					`<form id="f" method="post" action="${to}"><input name="q" value="1"><button id="go">send</button></form>`,
				);
			case '/redirect':
				return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
			case '/popup': {
				const features = url.searchParams.get('mode') === 'opener' ? '' : 'noopener';
				return html(
					`<button id="go" type="button" onclick='window.open(${target},"_blank",${
						jsLiteral(features)
					})'>open</button>`,
				);
			}
			case '/frame-off':
				return html(`<iframe id="child" src="${to}"></iframe>`);
			case '/frame-hop':
				return html(`<iframe id="child" src="/inner?to=${encodeURIComponent(to)}"></iframe>`);
			case '/inner':
				return html(`<p id="inner">inner</p><script>setTimeout(()=>{location.href=${target};},300);</script>`);
			// Speculation rules, and the `<link rel>` hints, each with the link or script that would use them.
			case '/spec-prefetch':
				return html(`<a id="go" href="${to}">go</a>`, speculation('prefetch', to));
			case '/spec-prefetch-script':
				return html(
					`<button id="go" type="button" onclick='location.href=${target}'>go</button>`,
					speculation('prefetch', to),
				);
			case '/spec-prerender':
				return html(`<a id="go" href="${to}">go</a>`, speculation('prerender', to));
			case '/link-prefetch':
				return html(`<a id="go" href="${to}">go</a>`, `<link rel="prefetch" href="${to}">`);
			case '/link-prerender':
				return html(`<a id="go" href="${to}">go</a>`, `<link rel="prerender" href="${to}">`);
			// An on-list page whose own script leaves at once.
			case '/auto':
				return html(`<p id="auto">auto</p><script>location.href=${target};</script>`);
			default:
				return html(`<h1 id="home">${url.host} ${url.pathname}</h1>`);
		}
	};
	const a = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, page);
	const b = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, page);
	return {
		a: `http://127.0.0.1:${(a.addr as Deno.NetAddr).port}`,
		b: `http://${SITE_B}:${(b.addr as Deno.NetAddr).port}`,
		off: `http://localhost:${(off.addr as Deno.NetAddr).port}`,
		offHits,
		async close() {
			await a.shutdown();
			await b.shutdown();
			await off.shutdown();
		},
	};
}

/** A `<script type="speculationrules">` asking the browser to `kind` one URL ahead of use. */
function speculation(kind: 'prefetch' | 'prerender', url: string): string {
	return `<script type="speculationrules">${JSON.stringify({ [kind]: [{ source: 'list', urls: [url] }] })}</script>`;
}

interface Element {
	index: number;
	attrs?: Record<string, string>;
}
interface State {
	url?: string;
	interactive_elements: Element[];
}

/** Every blocked navigation record on the default session's ring. */
function blocked(h: Harness): EventRecord[] {
	const events = h.gateway.registry.peek('default')?.events;
	return (events?.read({ kind: 'cursor', epoch: events.epoch, seq: 0 }) ?? [])
		.filter((event) => event.kind === 'navigation' && event.payload.blocked === true);
}

/**
 * Every main-frame document the default session's tabs **commit**, as Chrome reports it (`Page.frameNavigated`
 * without a parent) — so "zero off-list document commits" is read from the browser, not inferred from where the tab
 * ended up (the commit check would park an off-list one on about:blank and hide it).
 */
function commitRecorder(h: Harness): string[] {
	const record = h.gateway.registry.peek('default') as unknown as {
		session: {
			cdpClient: {
				on(method: string, listener: (params: { frame: { url: string; parentId?: string } }) => void): void;
			};
		};
	};
	const commits: string[] = [];
	record.session.cdpClient.on('Page.frameNavigated', (params) => {
		if (params.frame.parentId === undefined) commits.push(params.frame.url);
	});
	return commits;
}

async function clickById(h: Harness, id: string): Promise<void> {
	const state = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
	const element = state.interactive_elements.find((entry) => entry.attrs?.id === id);
	assert(element !== undefined, `#${id} not in ${JSON.stringify(state.interactive_elements)}`);
	// Interaction tools keep their normal result under the document veto; the block is on the ring.
	await h.call('browser_click', { index: element.index });
}

/**
 * One containment leg: run `act`, then require exactly one new `request-blocked` record and nothing else blocked, zero
 * requests at the off-list listener, and the tab still on the allowlist.
 */
async function expectRefused(
	h: Harness,
	s: Servers,
	label: string,
	act: () => Promise<void>,
	expectTab: (url: string) => boolean = (url) => url.startsWith(s.a),
): Promise<EventRecord> {
	const before = blocked(h).length;
	s.offHits.length = 0;
	await act();
	const record = await poll(`the ${label} block`, () => blocked(h)[before]);
	// A second record would arrive within this window if another enforcement layer also fired for the same block.
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	const added = blocked(h).slice(before);
	assertEquals(added.length, 1, `${label}: one block, one record`);
	assertEquals(record.payload.containment, 'request-blocked', label);
	assertEquals(record.payload.committed, false, label);
	assertEquals(record.payload.origin, s.off, label);
	assertEquals(s.offHits, [], `${label}: the off-list host must receive no request at all`);
	assert(!JSON.stringify(added).includes(CODE), `${label}: a query reached the ring`);
	const state = await h.callStructured<State>('browser_get_state', {});
	assert(expectTab(state.url ?? ''), `${label}: the tab left the allowlist: ${state.url}`);
	return record;
}

Deno.test({
	name: 'e2e containment: every off-list document request is refused before it is sent',
	ignore,
	async fn(t) {
		const s = servers();
		try {
			await using h = await harness({
				env: {
					TTK_ALLOWED_DOMAINS: `127.0.0.1,${SITE_B}`,
					TTK_BROWSER_ARGS: `--host-resolver-rules=MAP ${SITE_B} 127.0.0.1`,
				},
			});
			const offUrl = (path: string) => `${s.off}${path}?code=${CODE}`;
			await h.callText('browser_navigate', { url: `${s.a}/home` });
			const commits = commitRecorder(h);

			await t.step(
				'browser_navigate through a 302 hop answers navigation-blocked, origin only',
				async () => {
					let answer = '';
					const record = await expectRefused(h, s, '302 hop', async () => {
						answer = await h.callError('browser_navigate', {
							url: `${s.a}/redirect?to=${encodeURIComponent(offUrl('/landing'))}`,
						});
					}, (url) => url === `${s.a}/home`);
					assertEquals(answer, `Error: navigation-blocked: ${s.off} is not in the server's allowed-domain list`);
					assertEquals(record.payload.path, '/landing');
				},
			);

			await t.step('a clicked link, a script setting location, a form POST', async () => {
				for (const page of ['click', 'location', 'form']) {
					await h.callText('browser_navigate', { url: `${s.a}/${page}?to=${encodeURIComponent(offUrl(`/${page}`))}` });
					await expectRefused(h, s, page, () => clickById(h, 'go'));
				}
			});

			await t.step('a meta refresh', async () => {
				// It fires after the tool's own navigation committed: the page's block, never the tool's failure.
				await expectRefused(h, s, 'meta refresh', async () => {
					await h.callText('browser_navigate', { url: `${s.a}/meta?to=${encodeURIComponent(offUrl('/meta'))}` });
				});
			});

			await t.step('a tool whose navigation landed is not failed by the landed page’s own script', async () => {
				let answer = '';
				await expectRefused(h, s, 'landed page leaves at once', async () => {
					answer = await h.callText('browser_navigate', {
						url: `${s.a}/auto?to=${encodeURIComponent(offUrl('/auto'))}`,
					});
				}, (url) => url.startsWith(`${s.a}/auto`));
				assertStringIncludes(answer, `${s.a}/auto`);
			});

			// Speculation rules are off under an allowlist; a `<link rel>` hint is refused before it is sent and, being
			// nobody's navigation, adds no ring record. The navigation that would use either is refused like any other.
			const speculative = async (label: string, page: string, path: string): Promise<void> => {
				const initial = blocked(h).length;
				s.offHits.length = 0;
				await h.callText('browser_navigate', { url: `${s.a}${page}?to=${encodeURIComponent(offUrl(path))}` });
				// Long enough for a speculation candidate to be fetched (measured: well under a second when it is).
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				const hints = [...s.offHits];
				assertEquals(blocked(h).length, initial, `${label}: a refused hint is a log line, not a ring record`);
				commits.length = 0;
				const before = blocked(h).length;
				s.offHits.length = 0;
				await clickById(h, 'go');
				const record = await poll(`the ${label} block`, () => blocked(h)[before]);
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				const added = blocked(h).slice(before);
				assertEquals(commits.filter((url) => url.startsWith(s.off)), [], `${label}: an off-list document committed`);
				assertEquals(added.length, 1, `${label}: one block, one record`);
				assertEquals(record.payload.origin, s.off, label);
				assertEquals(record.payload.containment, 'request-blocked', label);
				assertEquals(s.offHits, [], `${label}: the navigation itself must not reach the off-list host`);
				assertEquals(hints, [], `${label}: the speculative request must not be sent`);
				assert(!JSON.stringify(added).includes(CODE), `${label}: a query reached the ring`);
				const state = await h.callStructured<State>('browser_get_state', {});
				assert(state.url?.startsWith(`${s.a}${page}`), `${label}: the tab left the page: ${state.url}`);
			};

			await t.step('speculation-rules prefetch/prerender and <link rel> hints, then the navigation', async () => {
				await speculative('prefetch -> click', '/spec-prefetch', '/pf-click');
				await speculative('prefetch -> script', '/spec-prefetch-script', '/pf-script');
				await speculative('prerender -> click', '/spec-prerender', '/pr-click');
				await speculative('link prefetch -> click', '/link-prefetch', '/lp-click');
				await speculative('link prerender -> click', '/link-prerender', '/lr-click');
			});

			await t.step('an iframe whose src is off-list from the start', async () => {
				const record = await expectRefused(h, s, 'iframe src', async () => {
					await h.call('browser_navigate', { url: `${s.a}/frame-off?to=${encodeURIComponent(offUrl('/frame'))}` });
				});
				assert(record.payload.frame_id !== record.tab_id, 'the record names the child frame, not the tab');
			});

			await t.step('a same-process iframe navigating itself off-list', async () => {
				await expectRefused(h, s, 'same-process iframe', async () => {
					await h.call('browser_navigate', { url: `${s.a}/frame-hop?to=${encodeURIComponent(offUrl('/hop'))}` });
				});
			});

			await t.step('an out-of-process iframe (an on-list site) navigating itself off-list', async () => {
				await expectRefused(h, s, 'OOPIF', async () => {
					await h.call('browser_navigate', {
						url: `${s.a}/frame-off?to=${encodeURIComponent(`${s.b}/inner?to=${encodeURIComponent(offUrl('/oopif'))}`)}`,
					});
				});
			});

			for (const mode of ['noopener', 'opener'] as const) {
				await t.step(`a window.open (${mode}) pop-up never reaches the off-list host and is closed`, async () => {
					await h.callText('browser_navigate', {
						url: `${s.a}/popup?mode=${mode}&to=${encodeURIComponent(offUrl(`/popup-${mode}`))}`,
					});
					await expectRefused(h, s, `pop-up (${mode})`, () => clickById(h, 'go'));
					const tabs = await poll('the pop-up to be closed', async () => {
						const listed = (await h.callStructured<{ tabs: Array<{ url: string }> }>('browser_list_tabs')).tabs;
						return listed.length === 1 ? listed : undefined;
					});
					assertStringIncludes(tabs[0]?.url ?? '', '/popup');
				});
			}

			await t.step('on-list documents are not held: a cross-site click and a pop-up both load (no hang)', async () => {
				await h.callText('browser_navigate', { url: `${s.a}/click?to=${encodeURIComponent(`${s.b}/landed`)}` });
				await clickById(h, 'go');
				await poll('the on-list click to land', async () => {
					const state = await h.callStructured<State>('browser_get_state', {});
					return state.url === `${s.b}/landed` ? state : undefined;
				});
				await h.callText('browser_navigate', { url: `${s.a}/popup?to=${encodeURIComponent(`${s.a}/popped`)}` });
				await clickById(h, 'go');
				await poll('the on-list pop-up', async () => {
					const listed = (await h.callStructured<{ tabs: Array<{ url: string }> }>('browser_list_tabs')).tabs;
					return listed.some((tab) => tab.url.startsWith(`${s.a}/popped`)) ? listed : undefined;
				});
			});

			await t.step('the live view’s navigate answers navigation-blocked naming the origin only', async () => {
				const tabs =
					(await h.callStructured<{ tabs: Array<{ tab_id: string; url: string }> }>('browser_list_tabs')).tabs;
				for (const tab of tabs.slice(1)) await h.call('browser_close_tab', { tab_id: tab.tab_id });
				await h.callText('browser_navigate', { url: `${s.a}/home` });
				const socket = await h.live();
				const meta = await socket.ready();
				socket.send({ type: 'control.take' });
				await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);
				s.offHits.length = 0;
				socket.send({ type: 'navigate', url: `${s.a}/redirect?to=${encodeURIComponent(offUrl('/live'))}` });
				const error = await socket.waitFor(
					'error',
					(message) => message.code === 'navigation-blocked',
				) as { message: string };
				assertEquals(error.message, `${s.off} is not in the server's allowed-domain list`);
				assertEquals(s.offHits, []);
				socket.send({ type: 'control.release' });
				await socket.close();
			});
		} finally {
			await s.close();
		}
	},
});
