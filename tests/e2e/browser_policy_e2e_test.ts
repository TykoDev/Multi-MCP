/**
 * Browser policy on real Chromium: the allowlist inside the browser (redirects, load-time script navigations,
 * pop-ups), the secret pin on the frame the keystrokes land in, downloads switched at runtime, a probing health
 * check, and (only with `BUA_TEST_UNSANDBOXED=1`) a launch without the sandbox. `127.0.0.1` is allowed and hosts
 * every page; `localhost` is another site, off the allowlist.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { EventRecord } from '@tykotech/wire';
import { readEnv } from '../support/browser_tier.ts';
import { type Harness, harness, pageCdp, poll, skipUnlessBrowser } from '../support/harness.ts';
import { jsLiteral } from '../support/js_literal.ts';

const ignore = skipUnlessBrowser('browser policy e2e');

const SITE_SECRET = 'Zq8-POLICY-SITE-SECRET-3vP';
const ALT_SECRET = 'Zq8-POLICY-ALT-SECRET-3vP';
const OAUTH_CODE = 'Zq8-POLICY-OAUTH-CODE-3vP';

interface Servers {
	/** `http://127.0.0.1:<port>` — the allowed origin. */
	readonly allowed: string;
	/** `http://localhost:<port>` — off the allowlist. */
	readonly other: string;
	/** Paths the off-allowlist origin served, so "the browser went there" is a fact, not an inference. */
	readonly otherHits: string[];
	close(): Promise<void>;
}

const html = (body: string): Response =>
	new Response(`<!doctype html><html><head><meta charset="utf-8"><title>w1</title></head><body>${body}</body></html>`, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	});

function servers(): Servers {
	const otherHits: string[] = [];
	const other = Deno.serve({ hostname: 'localhost', port: 0, onListen: () => {} }, (request) => {
		const url = new URL(request.url);
		otherHits.push(url.pathname);
		if (url.pathname === '/frame') {
			// The OOPIF's own password field. It reports only the LENGTH of what it received.
			return html(
				'<input id="alt-password" type="password" placeholder="alt password">' +
					'<pre id="alt-len">altlen:0</pre>' +
					"<script>const p=document.getElementById('alt-password');" +
					"p.addEventListener('input',()=>{document.getElementById('alt-len').textContent='altlen:'+p.value.length;});" +
					'</script>',
			);
		}
		return html(`<h1 id="landing">landed on the other origin</h1>`);
	});
	const otherOrigin = `http://localhost:${(other.addr as Deno.NetAddr).port}`;
	const allowed = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		const url = new URL(request.url);
		const to = url.searchParams.get('to') ?? '/';
		switch (url.pathname) {
			case '/redirect':
				return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
			case '/jsredirect':
				return html(`<script>location.replace(${jsLiteral(to)});</script>`);
			case '/popup':
				// `noopener`: measured, a `window.open` that keeps its opener never loads another origin at all.
				return html(
					`<button id="open" type="button">open</button>` +
						`<script>document.getElementById('open').addEventListener('click',()=>window.open(${
							jsLiteral(to)
						},'_blank','noopener'));</script>`,
				);
			case '/host':
				return html(
					'<input id="top-password" type="password" placeholder="top password">' +
						'<pre id="top-len">toplen:0</pre>' +
						`<iframe id="child" src="${otherOrigin}/frame" style="width:420px;height:160px"></iframe>` +
						"<script>const t=document.getElementById('top-password');" +
						"t.addEventListener('input',()=>{document.getElementById('top-len').textContent='toplen:'+t.value.length;});" +
						'</script>',
				);
			case '/downloads':
				return html('<a id="file" href="/file.txt">get the file</a>');
			case '/file.txt':
				return new Response('w1 runtime download', {
					headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="w1.txt"' },
				});
			default:
				return html('<h1 id="home">allowed origin</h1>');
		}
	});
	return {
		allowed: `http://127.0.0.1:${(allowed.addr as Deno.NetAddr).port}`,
		other: otherOrigin,
		otherHits,
		async close() {
			await allowed.shutdown();
			await other.shutdown();
		},
	};
}

interface Tab {
	tab_id: string;
	url: string;
}
interface Element {
	index: number;
	tag: string;
	frame_id?: string;
	attrs?: Record<string, string>;
}
interface State {
	url?: string;
	page: string;
	state_token: string | null;
	interactive_elements: Element[];
	frames: Array<{ id: string; is_oopif: boolean; url: string }>;
}

function byId(state: State, id: string): Element {
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(state.interactive_elements)}`);
	return found;
}

/** Every navigation record the default session's ring holds. */
function navigations(h: Harness): EventRecord[] {
	const events = h.gateway.registry.peek('default')!.events;
	return events.read({ kind: 'cursor', epoch: events.epoch, seq: 0 }).filter((event) => event.kind === 'navigation');
}

Deno.test({
	name:
		'e2e browser policy (allowlist): TTK_ALLOWED_DOMAINS contains redirects, load-time script navigations and pop-ups',
	ignore,
	async fn(t) {
		const s = servers();
		try {
			await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1' } });

			// The pre-request document veto refuses the redirect hop before it is sent; the tab keeps its document.
			await t.step('a server redirect off the allowlist is refused before it is sent, recorded redacted', async () => {
				const target = `${s.other}/landing?code=${OAUTH_CODE}`;
				const answer = await h.callError('browser_navigate', {
					url: `${s.allowed}/redirect?to=${encodeURIComponent(target)}`,
				});
				assertEquals(answer, `Error: navigation-blocked: ${s.other} is not in the server's allowed-domain list`);
				const state = await h.callStructured<State>('browser_get_state', {});
				assertEquals(state.url, 'about:blank', 'the tab keeps the document it had');

				const blocked = navigations(h).filter((event) => event.payload.blocked === true);
				assertEquals(blocked.length, 1);
				assertEquals(blocked[0]?.payload.origin, s.other);
				assertEquals(blocked[0]?.payload.containment, 'request-blocked');
				assertEquals(blocked[0]?.payload.committed, false);
				assertEquals(s.otherHits, [], 'the off-allowlist origin received no request at all');
				assert(!JSON.stringify(navigations(h)).includes(OAUTH_CODE), 'the code in the query reached the ring');
			});

			await t.step('a navigation the page script makes while loading is contained the same way', async () => {
				await h.callText('browser_navigate', { url: `${s.allowed}/` });
				const before = navigations(h).filter((event) => event.payload.blocked === true).length;
				await h.call('browser_navigate', {
					url: `${s.allowed}/jsredirect?to=${encodeURIComponent(`${s.other}/landing`)}`,
				});
				await poll('the tab to leave the off-allowlist page', async () => {
					const current = await h.callStructured<State>('browser_get_state', {});
					return (current.url ?? '').startsWith(s.other) ? undefined : current;
				});
				const blocked = navigations(h).filter((event) => event.payload.blocked === true);
				assertEquals(
					blocked.length,
					before + 1,
					`no blocked record for the script navigation: ${JSON.stringify(blocked)}`,
				);
			});

			// The veto is in place before the new target's first request; the never-committed pop-up is closed.
			await t.step('a window.open to a host off the allowlist never reaches it, and is closed', async () => {
				await h.callText('browser_navigate', {
					url: `${s.allowed}/popup?to=${encodeURIComponent(`${s.other}/landing`)}`,
				});
				const before = navigations(h).filter((event) => event.payload.blocked === true).length;
				const state = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
				await h.callText('browser_click', { index: byId(state, 'open').index });
				const record = await poll(
					'a blocked pop-up record',
					() => Promise.resolve(navigations(h).filter((event) => event.payload.blocked === true)[before]),
				);
				assertEquals(record.payload.blocked, true);
				assertEquals(record.payload.containment, 'request-blocked');
				assertEquals(record.payload.committed, false);
				assertEquals(record.payload.origin, s.other);
				// Prevention, not containment: the off-allowlist origin received no request at all.
				assertEquals(s.otherHits, []);
				const tabs = await poll('the pop-up to be gone', async () => {
					const listed = (await h.callStructured<{ tabs: Tab[] }>('browser_list_tabs', {})).tabs;
					return listed.length === 1 ? listed : undefined;
				});
				assertStringIncludes(tabs[0]?.url ?? '', '/popup');
			});

			await t.step('a pop-up on the allowlist survives', async () => {
				await h.callText('browser_navigate', { url: `${s.allowed}/popup?to=${encodeURIComponent(`${s.allowed}/`)}` });
				const state = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
				await h.callText('browser_click', { index: byId(state, 'open').index });
				const tabs = await poll('the allowed pop-up', async () => {
					const listed = (await h.callStructured<{ tabs: Tab[] }>('browser_list_tabs', {})).tabs;
					return listed.length === 2 ? listed : undefined;
				});
				assert(tabs.some((tab) => tab.url.startsWith(s.allowed) && !tab.url.includes('/popup')));
			});
		} finally {
			await s.close();
		}
	},
});

Deno.test({
	name: 'e2e browser policy (secret pin): a <secret> placeholder is pinned to the frame the keystrokes land in',
	ignore,
	async fn(t) {
		const s = servers();
		try {
			const secrets = JSON.stringify({
				site_password: { value: SITE_SECRET, domains: ['http://127.0.0.1'] },
				alt_password: { value: ALT_SECRET, domains: ['http://localhost'] },
			});
			await using h = await harness({ env: { TTK_SECRETS: secrets } });
			await h.callText('browser_navigate', { url: `${s.allowed}/host` });
			const state = await poll('the out-of-process frame to be captured', async () => {
				const current = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
				return current.interactive_elements.some((element) => element.attrs?.id === 'alt-password')
					? current
					: undefined;
			});
			const oopif = state.frames.find((frame) => frame.is_oopif);
			assert(oopif !== undefined, `no OOPIF: ${JSON.stringify(state.frames)}`);
			const alt = byId(state, 'alt-password');
			assertEquals(alt.frame_id, oopif.id);
			const top = byId(state, 'top-password');

			await t.step('the top document’s secret is refused in the other origin’s frame', async () => {
				const refused = await h.callError('browser_type', {
					index: alt.index,
					text: '<secret>site_password</secret>',
					state_token: state.state_token,
				});
				assertStringIncludes(refused, 'Error: navigation-blocked: ');
				assertStringIncludes(refused, s.other);
				assert(!refused.includes(SITE_SECRET));
			});

			await t.step('the frame’s own secret is typed into it, and audited with that frame', async () => {
				await h.callText('browser_type', {
					index: alt.index,
					text: '<secret>alt_password</secret>',
					state_token: state.state_token,
				});
				const after = await h.callStructured<State>('browser_get_state', {});
				assertStringIncludes(after.page, `altlen:${ALT_SECRET.length}`);
				const audit = await h.callStructured<{ entries: Array<Record<string, unknown>> }>('browser_audit', {});
				const spend = audit.entries.find((entry) => entry.kind === 'secret-fill');
				assertEquals(spend?.origin, s.other);
				assertEquals(spend?.frame_id, oopif.id);
				assert(!JSON.stringify(audit).includes(ALT_SECRET));
			});

			await t.step('without an index the focused field’s frame is the pin', async () => {
				const fresh = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
				await h.callText('browser_click', { index: byId(fresh, 'alt-password').index });
				const refused = await h.callError('browser_type', { text: '<secret>site_password</secret>' });
				assertStringIncludes(refused, 'Error: navigation-blocked: ');

				await h.callText('browser_click', { index: byId(fresh, 'top-password').index });
				await h.callText('browser_type', { text: '<secret>site_password</secret>' });
				const after = await h.callStructured<State>('browser_get_state', {});
				assertStringIncludes(after.page, `toplen:${SITE_SECRET.length}`);
			});

			await t.step('a field in the top document still takes the top document’s secret by index', async () => {
				const fresh = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
				const result = await h.call('browser_fill', {
					index: byId(fresh, 'top-password').index,
					text: '<secret>site_password</secret>',
					state_token: fresh.state_token,
				});
				assertEquals(result.isError, undefined, JSON.stringify(result.content));
				assertEquals(top.frame_id, fresh.frames[0]?.id);
			});
		} finally {
			await s.close();
		}
	},
});

Deno.test({
	name: 'e2e browser policy (no allowlist, downloads, health): nothing is contained; downloads switch at runtime',
	ignore,
	async fn(t) {
		const s = servers();
		try {
			await using h = await harness();
			await t.step('with no allowlist the same redirect and pop-up are left alone', async () => {
				await h.callText('browser_navigate', {
					url: `${s.allowed}/redirect?to=${encodeURIComponent(`${s.other}/landing`)}`,
				});
				const state = await h.callStructured<State>('browser_get_state', {});
				assertStringIncludes(state.url ?? '', s.other, 'an empty allowlist is unrestricted');

				await h.callText('browser_navigate', {
					url: `${s.allowed}/popup?to=${encodeURIComponent(`${s.other}/landing`)}`,
				});
				const popup = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
				await h.callText('browser_click', { index: byId(popup, 'open').index });
				await poll('the pop-up to open and stay', async () => {
					const listed = (await h.callStructured<{ tabs: Tab[] }>('browser_list_tabs', {})).tabs;
					return listed.some((tab) => tab.url.startsWith(s.other)) ? listed : undefined;
				});
				assertEquals(navigations(h).filter((event) => event.payload.blocked === true), []);
			});

			await h.callText('browser_navigate', { url: `${s.allowed}/downloads` });
			const page = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
			const link = byId(page, 'file');
			type Listing = { files: Array<{ status: string; name: string }> };

			await t.step('accept_downloads=false denies the next download', async () => {
				const off = await h.callStructured<{ applied: Record<string, unknown>; unsupported: string[] }>(
					'browser_set_session_options',
					{ accept_downloads: false },
				);
				assertEquals(off.applied.accept_downloads, false);
				assertEquals(off.unsupported, []);
				await h.callText('browser_click', { index: link.index });
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const listing = await h.callStructured<Listing>('browser_list_files', {});
				assertEquals(listing.files.filter((file) => file.status === 'completed'), []);
			});

			await t.step('accept_downloads=true lets the next one complete', async () => {
				const on = await h.callStructured<{ applied: Record<string, unknown> }>('browser_set_session_options', {
					accept_downloads: true,
				});
				assertEquals(on.applied.accept_downloads, true);
				await h.callText('browser_click', { index: link.index });
				const done = await poll('the download to complete', async () => {
					const listing = await h.callStructured<Listing>('browser_list_files', {});
					return listing.files.find((file) => file.status === 'completed');
				});
				// The denied attempt keeps its ledger entry, so this one may be `w1 (1).txt`.
				assertStringIncludes(done.name, 'w1');
			});

			await t.step('browser_health answers from a real Browser.getVersion', async () => {
				const health = await h.callStructured<{ status: string; sessions: Record<string, number> }>('browser_health');
				assertEquals(health.status, 'ok');
				assertEquals(health.sessions.browser_ok, 1);
				assertEquals(health.sessions.browser_unresponsive, 0);
			});
		} finally {
			await s.close();
		}
	},
});

const UNSANDBOXED = readEnv('BUA_TEST_UNSANDBOXED') !== undefined;
if (!ignore && !UNSANDBOXED) {
	console.error('browser tier: skipping the unsandboxed launch — set BUA_TEST_UNSANDBOXED=1 to run it');
}

Deno.test({
	name: 'e2e browser policy (unsandboxed): TTK_CHROMIUM_NO_SANDBOX launches a working Chromium with --no-sandbox',
	ignore: ignore || !UNSANDBOXED,
	async fn() {
		const s = servers();
		try {
			await using h = await harness({ env: { TTK_CHROMIUM_NO_SANDBOX: 'true' } });
			await h.callText('browser_navigate', { url: `${s.allowed}/` });
			const health = await h.callStructured<{ capabilities: { browser?: { sandboxed: boolean } } }>('browser_health');
			assertEquals(health.capabilities.browser, { sandboxed: false });

			// The browser's own record of how it was started, read through CDP from outside the tool surface.
			const { cdp, page } = await pageCdp(h.gateway);
			await cdp.sendRaw('Page.navigate', { url: 'chrome://version' }, page);
			const commandLine = await poll('chrome://version to render', async () => {
				const text = await h.pageValue<string>("document.getElementById('command_line')?.textContent ?? ''");
				return text === '' ? undefined : text;
			});
			assertStringIncludes(commandLine, '--no-sandbox');
		} finally {
			await s.close();
		}
	},
});
