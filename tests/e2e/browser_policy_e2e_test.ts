/**
 * W1 on real Chromium: the deployment allowlist inside the browser (C1, D-095), the secret pin on the frame
 * the keystrokes land in (A2, D-096), download acceptance switched at runtime (A3, E-77), a probing health
 * check (A4), and — only when asked for — a real launch without the sandbox (B3, D-094).
 *
 * Two loopback origins that Chromium treats as different *sites*: `127.0.0.1` (allowed, and the host of
 * every page) and `localhost` (off the allowlist, and the second origin of the frame tests). Nothing here
 * leaves the machine.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`. The unsandboxed launch additionally needs
 * `BUA_TEST_UNSANDBOXED=1`; it is skipped, loudly, without it.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { EventRecord } from '@tykotech/wire';
import { readEnv } from '../support/browser_tier.ts';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('browser policy e2e');

const SITE_SECRET = 'Zq8-W1-SITE-SECRET-3vP';
const ALT_SECRET = 'Zq8-W1-ALT-SECRET-3vP';
const OAUTH_CODE = 'Zq8-W1-OAUTH-CODE-3vP';

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
				return html(`<script>location.replace(${JSON.stringify(to)});</script>`);
			case '/popup':
				// `noopener`: measured on this tier, a `window.open` that keeps its opener never loads at all
				// (the other origin receives no request, the target stays at url ''), with or without an
				// allowlist — there is nothing for containment to act on. The opener-less form loads, which is
				// the pop-up a page can actually use to reach another origin.
				return html(
					`<button id="open" type="button">open</button>` +
						`<script>document.getElementById('open').addEventListener('click',()=>window.open(${
							JSON.stringify(to)
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

type Caller = {
	call(
		name: string,
		args?: Record<string, unknown>,
	): Promise<{ isError?: boolean; structuredContent?: unknown; content?: unknown }>;
};

async function structured<T>(h: Caller, name: string, args: Record<string, unknown> = {}): Promise<T> {
	const result = await h.call(name, args);
	assert(result.isError !== true, `${name} failed: ${JSON.stringify(result.content)}`);
	return result.structuredContent as T;
}

function byId(state: State, id: string): Element {
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(state.interactive_elements)}`);
	return found;
}

/** Every navigation record the default session's ring holds. */
function navigations(h: { gateway: { registry: { peek(id: string): unknown } } }): EventRecord[] {
	const record = h.gateway.registry.peek('default') as {
		events: { epoch: string; read(cursor: unknown): EventRecord[] };
	} | undefined;
	assert(record !== undefined);
	return record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 })
		.filter((event) => event.kind === 'navigation');
}

/** Polls until `probe` answers, or fails naming what it waited for. */
async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

Deno.test({
	name: 'e2e browser policy (C1): TTK_ALLOWED_DOMAINS contains redirects, load-time script navigations and pop-ups',
	ignore,
	async fn(t) {
		const s = servers();
		try {
			await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1' } });

			// R3 (D-115, E-94) moved this pin: the redirect hop is refused before its request is sent (E0), so the tool
			// that issued the navigation answers navigation-blocked naming the origin, and the tab keeps the document it
			// had (M12: `Aborted`) rather than being parked on about:blank after the off-list host was reached.
			await t.step('a server redirect off the allowlist is refused before it is sent, recorded redacted', async () => {
				const target = `${s.other}/landing?code=${OAUTH_CODE}`;
				const answer = await h.callError('browser_navigate', {
					url: `${s.allowed}/redirect?to=${encodeURIComponent(target)}`,
				});
				console.log(`[C1] navigate through an off-allowlist redirect answered: ${answer}`);
				assertEquals(answer, `Error: navigation-blocked: ${s.other} is not in the server's allowed-domain list`);
				const state = await structured<State>(h, 'browser_get_state', {});
				assertEquals(state.url, 'about:blank', 'the tab keeps the document it had (M12)');

				const blocked = navigations(h).filter((event) => event.payload.blocked === true);
				console.log(`[C1] ring: ${JSON.stringify(blocked)}`);
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
				const state = await until('the tab to leave the off-allowlist page', async () => {
					const current = await structured<State>(h, 'browser_get_state', {});
					return (current.url ?? '').startsWith(s.other) ? undefined : current;
				});
				console.log(`[C1] after a load-time script navigation: url=${state.url}`);
				const blocked = navigations(h).filter((event) => event.payload.blocked === true);
				assertEquals(
					blocked.length,
					before + 1,
					`no blocked record for the script navigation: ${JSON.stringify(blocked)}`,
				);
			});

			// R3 moved this pin too (M5 holds on Chrome 154): the pop-up's first document request is refused before it
			// is sent, the never-committed pop-up is closed, and the record is E0's — one record, not E0 plus E3.
			await t.step('a window.open to a host off the allowlist never reaches it, and is closed', async () => {
				await h.callText('browser_navigate', {
					url: `${s.allowed}/popup?to=${encodeURIComponent(`${s.other}/landing`)}`,
				});
				const before = navigations(h).filter((event) => event.payload.blocked === true).length;
				const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
				await h.callText('browser_click', { index: byId(state, 'open').index });
				const record = await until(
					'a blocked pop-up record',
					() => Promise.resolve(navigations(h).filter((event) => event.payload.blocked === true)[before]),
				);
				console.log(`[C1] pop-up record: ${JSON.stringify(record)}`);
				assertEquals(record.payload.blocked, true);
				assertEquals(record.payload.containment, 'request-blocked');
				assertEquals(record.payload.committed, false);
				assertEquals(record.payload.origin, s.other);
				// Prevention, not containment: the off-allowlist origin received no request at all.
				console.log(`[C1] the off-allowlist origin saw: ${JSON.stringify(s.otherHits)}`);
				assertEquals(s.otherHits, []);
				const tabs = await until('the pop-up to be gone', async () => {
					const listed = (await structured<{ tabs: Tab[] }>(h, 'browser_list_tabs', {})).tabs;
					return listed.length === 1 ? listed : undefined;
				});
				assertStringIncludes(tabs[0]?.url ?? '', '/popup');
			});

			await t.step('a pop-up on the allowlist survives', async () => {
				await h.callText('browser_navigate', { url: `${s.allowed}/popup?to=${encodeURIComponent(`${s.allowed}/`)}` });
				const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
				await h.callText('browser_click', { index: byId(state, 'open').index });
				const tabs = await until('the allowed pop-up', async () => {
					const listed = (await structured<{ tabs: Tab[] }>(h, 'browser_list_tabs', {})).tabs;
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
	name: 'e2e browser policy (C1): with no allowlist the same redirect and pop-up are left alone',
	ignore,
	async fn() {
		const s = servers();
		try {
			await using h = await harness();
			await h.callText('browser_navigate', {
				url: `${s.allowed}/redirect?to=${encodeURIComponent(`${s.other}/landing`)}`,
			});
			const state = await structured<State>(h, 'browser_get_state', {});
			assertStringIncludes(state.url ?? '', s.other, 'an empty allowlist is unrestricted (D-020)');

			await h.callText('browser_navigate', {
				url: `${s.allowed}/popup?to=${encodeURIComponent(`${s.other}/landing`)}`,
			});
			const popup = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			await h.callText('browser_click', { index: byId(popup, 'open').index });
			await until('the pop-up to open and stay', async () => {
				const listed = (await structured<{ tabs: Tab[] }>(h, 'browser_list_tabs', {})).tabs;
				return listed.some((tab) => tab.url.startsWith(s.other)) ? listed : undefined;
			});
			assertEquals(navigations(h).filter((event) => event.payload.blocked === true), []);
		} finally {
			await s.close();
		}
	},
});

Deno.test({
	name: 'e2e browser policy (A2): a <secret> placeholder is pinned to the frame the keystrokes land in',
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
			const state = await until('the out-of-process frame to be captured', async () => {
				const current = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
				return current.interactive_elements.some((element) => element.attrs?.id === 'alt-password')
					? current
					: undefined;
			});
			const oopif = state.frames.find((frame) => frame.is_oopif);
			assert(oopif !== undefined, `no OOPIF: ${JSON.stringify(state.frames)}`);
			const alt = byId(state, 'alt-password');
			assertEquals(alt.frame_id, oopif.id);
			const top = byId(state, 'top-password');

			await t.step('the top document’s secret is refused in the other origin’s frame — the old hole', async () => {
				const refused = await h.callError('browser_type', {
					index: alt.index,
					text: '<secret>site_password</secret>',
					state_token: state.state_token,
				});
				console.log(`[A2] site secret into the localhost frame: ${refused}`);
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
				const after = await structured<State>(h, 'browser_get_state', {});
				assertStringIncludes(after.page, `altlen:${ALT_SECRET.length}`);
				const audit = await structured<{ entries: Array<Record<string, unknown>> }>(h, 'browser_audit', {});
				const spend = audit.entries.find((entry) => entry.kind === 'secret-fill');
				console.log(`[A2] audit: ${JSON.stringify(spend)}`);
				assertEquals(spend?.origin, s.other);
				assertEquals(spend?.frame_id, oopif.id);
				assert(!JSON.stringify(audit).includes(ALT_SECRET));
			});

			await t.step('without an index the focused field’s frame is the pin', async () => {
				const fresh = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
				await h.callText('browser_click', { index: byId(fresh, 'alt-password').index });
				const refused = await h.callError('browser_type', { text: '<secret>site_password</secret>' });
				console.log(`[A2] focused frame, top secret: ${refused}`);
				assertStringIncludes(refused, 'Error: navigation-blocked: ');

				await h.callText('browser_click', { index: byId(fresh, 'top-password').index });
				await h.callText('browser_type', { text: '<secret>site_password</secret>' });
				const after = await structured<State>(h, 'browser_get_state', {});
				assertStringIncludes(after.page, `toplen:${SITE_SECRET.length}`);
			});

			await t.step('a field in the top document still takes the top document’s secret by index', async () => {
				const fresh = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
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
	name: 'e2e browser policy (A3, A4): downloads are switched at runtime, and health probes the real browser',
	ignore,
	async fn(t) {
		const s = servers();
		try {
			await using h = await harness();
			await h.callText('browser_navigate', { url: `${s.allowed}/downloads` });
			const page = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			const link = byId(page, 'file');
			type Listing = { files: Array<{ status: string; name: string }> };

			await t.step('A3: accept_downloads=false denies the next download', async () => {
				const off = await structured<{ applied: Record<string, unknown>; unsupported: string[] }>(
					h,
					'browser_set_session_options',
					{ accept_downloads: false },
				);
				assertEquals(off.applied.accept_downloads, false);
				assertEquals(off.unsupported, []);
				await h.callText('browser_click', { index: link.index });
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const listing = await structured<Listing>(h, 'browser_list_files', {});
				console.log(`[A3] while denying: ${JSON.stringify(listing.files)}`);
				assertEquals(listing.files.filter((file) => file.status === 'completed'), []);
			});

			await t.step('A3: accept_downloads=true lets the next one complete', async () => {
				const on = await structured<{ applied: Record<string, unknown> }>(h, 'browser_set_session_options', {
					accept_downloads: true,
				});
				assertEquals(on.applied.accept_downloads, true);
				await h.callText('browser_click', { index: link.index });
				const done = await until('the download to complete', async () => {
					const listing = await structured<Listing>(h, 'browser_list_files', {});
					return listing.files.find((file) => file.status === 'completed');
				});
				// The denied attempt keeps its ledger entry as `canceled`, so this one's display name is the
				// disambiguated `w1 (1).txt` (E-33) — the point is that it completed at all.
				assertStringIncludes(done.name, 'w1');
			});

			await t.step('A4: browser_health answers from a real Browser.getVersion', async () => {
				const health = await structured<{ status: string; sessions: Record<string, number> }>(h, 'browser_health');
				console.log(`[A4] ${JSON.stringify(health.sessions)}`);
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
	console.error('browser tier: skipping the B3 unsandboxed launch — set BUA_TEST_UNSANDBOXED=1 to run it');
}

Deno.test({
	name: 'e2e browser policy (B3): TTK_CHROMIUM_NO_SANDBOX launches a working Chromium with --no-sandbox',
	ignore: ignore || !UNSANDBOXED,
	async fn() {
		const s = servers();
		try {
			await using h = await harness({ env: { TTK_CHROMIUM_NO_SANDBOX: 'true' } });
			await h.callText('browser_navigate', { url: `${s.allowed}/` });
			const health = await structured<{ capabilities: { browser?: { sandboxed: boolean } } }>(h, 'browser_health');
			assertEquals(health.capabilities.browser, { sandboxed: false });

			// The browser's own record of how it was started, read through CDP from outside the tool surface.
			const record = h.gateway.registry.peek('default') as {
				session: {
					cdpClient: {
						send: {
							Page: { navigate(p: unknown, s: string): Promise<unknown> };
							Runtime: { evaluate(p: unknown, s: string): Promise<{ result: { value?: unknown } }> };
						};
					};
					sessionManager: { getOrCreateCdpSession(t: unknown, f: boolean): Promise<{ sessionId: string }> };
					agentFocusTargetId: string | null;
				};
			};
			const cdp = await record.session.sessionManager.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
			await record.session.cdpClient.send.Page.navigate({ url: 'chrome://version' }, cdp.sessionId);
			const commandLine = await until('chrome://version to render', async () => {
				const out = await record.session.cdpClient.send.Runtime.evaluate({
					expression: "document.getElementById('command_line')?.textContent ?? ''",
					returnByValue: true,
				}, cdp.sessionId);
				const text = String(out.result.value ?? '');
				return text === '' ? undefined : text;
			});
			console.log(`[B3] command line carries --no-sandbox: ${commandLine.includes('--no-sandbox')}`);
			assertStringIncludes(commandLine, '--no-sandbox');
		} finally {
			await s.close();
		}
	},
});
