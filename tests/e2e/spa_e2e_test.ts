/**
 * The control-plane SPA, driven by a real browser.
 *
 * One Chromium session loads the shipped bundle from the shipped static server and clicks through it, while a
 * second session is the browser being viewed. The decisive assertion is made from outside both — the SPA drives
 * session B, and session B is then inspected through MCP to confirm it really moved.
 *
 * It is also the honest test of `static.ts` and of the origin policy: a browser fetching this page sends an `Origin`
 * header that a real deployment has to accept, which no `fetch` from Deno would reveal.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('spa e2e');

interface PageState {
	session_id: string;
	url: string;
	title: string;
	interactive_elements: Array<{ index: number; tag: string; label?: string }>;
	page: string;
}

/** The driver session's view of the SPA. */
async function ui(h: Harness, driver: string): Promise<PageState> {
	return await h.callJson<PageState>('browser_get_state', { session_id: driver });
}

/** Polls the driver's rendered HTML until `fragment` appears. */
async function waitForUi(h: Harness, driver: string, fragment: string, what: string): Promise<string> {
	const deadline = Date.now() + 25_000;
	let last = '';
	while (Date.now() < deadline) {
		last = await h.callText('browser_get_html', { session_id: driver });
		if (last.includes(fragment)) return last;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`the SPA never showed ${what} (${JSON.stringify(fragment)}).\n${last.slice(0, 1500)}`);
}

/** A fresh data root under the scratch directory for the file share, removed afterwards. */
async function dataDir(): Promise<{ path: string; [Symbol.asyncDispose](): Promise<void> }> {
	const path = join('tests', '.scratch', `data-spa-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(path, { recursive: true });
	return {
		path,
		async [Symbol.asyncDispose]() {
			await Deno.remove(path, { recursive: true }).catch(() => {});
		},
	};
}

/** The index of the first element matching a predicate in the driver's page. */
function pick(state: PageState, predicate: (e: PageState['interactive_elements'][number]) => boolean): number {
	const found = state.interactive_elements.find(predicate);
	assert(found !== undefined, `no matching control among ${JSON.stringify(state.interactive_elements)}`);
	return found.index;
}

Deno.test({
	name: 'e2e SPA: the shipped bundle connects, watches, and drives a real session',
	ignore,
	async fn(t) {
		// `evaluate` is on the harness key only so this suite can look inside the driver's page; the SPA never needs it.
		await using data = await dataDir();
		await using h = await harness({
			env: { TTK_MAX_SESSIONS: '4', TTK_DATA_DIR: data.path },
			scopes: ['mcp:invoke', 'view:watch', 'view:control', 'task', 'admin', 'evaluate', 'files:read', 'files:write'],
		});
		/** Runs `expression` in the driver's page (the SPA) and returns its value. */
		const inPage = async (expression: string): Promise<unknown> => {
			const result = await h.call('browser_evaluate', { session_id: driver, expression });
			const payload = result.structuredContent as { ok?: boolean; value?: unknown } | undefined;
			assert(payload?.ok === true, `evaluation failed: ${JSON.stringify(result)}`);
			return payload.value;
		};
		/** Polls `expression` in the driver's page until it is true. */
		const untilInPage = async (expression: string, what: string): Promise<void> => {
			const deadline = Date.now() + 25_000;
			while (Date.now() < deadline) {
				if ((await inPage(expression)) === true) return;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			throw new Error(`the SPA never showed ${what} (${expression})`);
		};
		const fromPage = async <T>(expression: string): Promise<T> =>
			JSON.parse(String(await inPage(`JSON.stringify(${expression})`))) as T;

		// The session the SPA looks at is `default`, which the Live View tab opens.
		const viewed = await h.callJson<{ session_id: string }>('browser_navigate', { url: h.site.page('index') });
		// The session that *runs* the SPA is a separate browser, so the viewer and the viewed are different.
		const driver = (await h.callJson<{ session_id: string }>('browser_navigate', {
			url: `${h.url}/`,
			new_session: true,
		})).session_id;

		await t.step('the static server really serves the bundle', async () => {
			const page = await h.fetch('/');
			assertEquals(page.status, 200);
			assertStringIncludes(page.headers.get('content-type') ?? '', 'text/html');
			assertStringIncludes(await page.text(), 'app.js');
			const bundle = await h.fetch('/assets/app.js');
			assertEquals(bundle.status, 200, 'run `deno task build:web` before the SPA suite');
			const body = await bundle.text();
			assert(body.length > 1000 && body.length < 150 * 1024, `the bundle is ${body.length} bytes`);
		});

		await t.step('the page loads and asks for a credential', async () => {
			const state = await ui(h, driver);
			assertStringIncludes(state.title, 'Multi-MCP');
			pick(state, (element) => element.tag === 'input');
		});

		await t.step('pasting the key lists the live sessions', async () => {
			const state = await ui(h, driver);
			await h.callText('browser_type', {
				session_id: driver,
				index: pick(state, (element) => element.tag === 'input'),
				text: h.key,
				clear: true,
			});
			const withKey = await ui(h, driver);
			await h.callText('browser_click', {
				session_id: driver,
				index: pick(withKey, (element) => element.tag === 'button'),
			});
			// Fetched over HTTP from inside the browser: the origin policy lets the SPA talk to its own server.
			await waitForUi(h, driver, viewed.session_id, 'the viewed session in its list');
		});

		await t.step('the sign-in is an HttpOnly cookie: nothing in storage, and a forged change is refused', async () => {
			// No credential of any kind in the page's storage — only the theme may be there.
			const keys = await fromPage<string[]>('Object.keys(localStorage)');
			assertEquals(keys.filter((key) => key !== 'ttk.theme'), [], keys.join(', '));
			const visible = String(await inPage('document.cookie'));
			assert(
				!visible.includes('ttk_session') && !visible.includes('ttks_'),
				`the session cookie is readable: ${visible}`,
			);
			// A change without the CSRF value — what a forged request riding the cookie would be — is refused, while a
			// read rides the cookie and hands the page its CSRF value back.
			assertEquals(
				await inPage(
					"fetch('/api/v1/live/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })" +
						".then(async (r) => r.status + ' ' + (await r.json()).type)",
				),
				'403 https://tykotech.eu/problems/csrf-failed',
			);
			assertEquals(await inPage("fetch('/api/v1/auth/me').then((r) => r.json()).then((b) => typeof b.csrf)"), 'string');
		});

		await t.step('a reload stays signed in; the rail has five sections and Sessions three tabs', async () => {
			await h.callText('browser_navigate', { session_id: driver, url: `${h.url}/?reload=1#/sessions` });
			await waitForUi(h, driver, viewed.session_id, 'the session list after a reload');
			await untilInPage("document.querySelectorAll('.dock .dock-item').length === 5", 'the rail');
			assertEquals(
				await fromPage<string[]>(
					"Array.from(document.querySelectorAll('.dock .dock-item')).map((b) => b.getAttribute('aria-label'))",
				),
				['Sessions', 'Resources', 'Agents', 'Users', 'System'],
			);
			const tabs = await fromPage<Array<[string, string | null]>>(
				"Array.from(document.querySelectorAll('.page-tabs .page-tab')).map((a) => [a.textContent.trim(), a.getAttribute('href')])",
			);
			assertEquals(tabs.map(([label]) => label), ['Sessions', 'Live View', 'Workspaces']);
			assert(tabs[1]?.[1]?.startsWith('#/view/'), `the Live View tab opens a session: ${tabs[1]?.[1]}`);
		});

		await t.step('the share lists a written file in its folder, and the file opens in the editor', async () => {
			await h.callText('file_write', { path: 'notes/hello.md', content: '# hello' });
			await inPage("location.hash = '#/resources/notes'; true");
			await untilInPage(`!!document.querySelector('.rs-row[data-path="notes/hello.md"]')`, 'the hello.md row');
			assertEquals(
				await inPage(`document.querySelector('.rs-crumbs [aria-current="location"]')?.textContent`),
				'notes',
			);
			await inPage(`document.querySelector('.rs-row[data-path="notes/hello.md"] .rs-name').click(); true`);
			await untilInPage("document.querySelector('#share-editor')?.value === '# hello'", 'the file editor');
			// Saved from the editor, the share holds the new text.
			await inPage(
				"document.querySelector('#share-editor').value = '# edited'; Array.from(document.querySelectorAll('wa-dialog button')).find((b) => b.textContent.trim() === 'Save').click(); true",
			);
			const deadline = Date.now() + 15_000;
			let content = '';
			while (Date.now() < deadline && content !== '# edited') {
				content = await (await h.fetch('/api/v1/share/file?path=notes%2Fhello.md')).text();
				if (content !== '# edited') await new Promise((resolve) => setTimeout(resolve, 250));
			}
			assertEquals(content, '# edited');
			await h.callText('browser_navigate', { session_id: driver, url: `${h.url}/?back=1#/sessions` });
			await waitForUi(h, driver, viewed.session_id, 'the session list again');
		});

		await t.step('opening the session shows the live view', async () => {
			const listed = await ui(h, driver);
			await h.callText('browser_click', {
				session_id: driver,
				index: pick(listed, (element) => element.tag === 'a' && /^live view$/i.test(element.label ?? '')),
			});
			const html = await waitForUi(h, driver, '<canvas', 'the screencast canvas');
			assertStringIncludes(html, viewed.session_id);
			await waitForUi(h, driver, 'dot live', 'a connected status dot');
		});

		await t.step('taking control through the UI grants the lock', async () => {
			const view = await ui(h, driver);
			await h.callText('browser_click', {
				session_id: driver,
				index: pick(view, (element) => element.tag === 'button' && /take control/i.test(element.label ?? '')),
			});
			await waitForUi(h, driver, 'DRIVING', 'the driving indicator');
			// Confirmed from outside the SPA: the server really holds the lock.
			const state = await h.callJson<{ human_has_control: boolean }>('browser_get_state', {
				session_id: viewed.session_id,
			});
			assertEquals(state.human_has_control, true);
		});

		await t.step('navigating from the UI moves the viewed browser', async () => {
			const view = await ui(h, driver);
			await h.callText('browser_type', {
				session_id: driver,
				index: pick(view, (element) => element.tag === 'input'),
				text: h.site.page('article'),
				clear: true,
			});
			await h.callText('browser_press_key', { session_id: driver, key: 'Enter' });
			// The assertion this suite exists for: a human clicked in the web UI, and a different browser went somewhere.
			const deadline = Date.now() + 25_000;
			let title = '';
			while (Date.now() < deadline) {
				title = (await h.callJson<{ title: string }>('browser_get_state', { session_id: viewed.session_id })).title;
				if (title === 'Quarterly Report') break;
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			assertEquals(title, 'Quarterly Report', 'the SPA did not navigate the viewed session');
		});

		await t.step('releasing control hands the browser back', async () => {
			const view = await ui(h, driver);
			await h.callText('browser_click', {
				session_id: driver,
				index: pick(view, (element) => element.tag === 'button' && /release/i.test(element.label ?? '')),
			});
			const deadline = Date.now() + 20_000;
			let held = true;
			while (Date.now() < deadline && held) {
				held = (await h.callJson<{ human_has_control: boolean }>('browser_get_state', {
					session_id: viewed.session_id,
				})).human_has_control;
				if (held) await new Promise((resolve) => setTimeout(resolve, 300));
			}
			assertEquals(held, false, 'the lock outlived the release click');
		});

		await t.step('closing the viewed session tells the SPA, and it does not retry', async () => {
			await h.callText('browser_close_session', { session_id: viewed.session_id });
			// `session-closed` is a deliberate end: the auto-reconnect stands down and offers the button instead.
			await waitForUi(h, driver, 'session-closed', 'the disconnect notice');
			const html = await h.callText('browser_get_html', { session_id: driver });
			assert(!html.includes('Reconnecting in'), 'a deliberate close must not start the retry loop');
			// Every overlay covers the stage, so a second one would swallow the clicks meant for the first's buttons.
			assertEquals((html.match(/class="overlay"/g) ?? []).length, 1, 'the stage must hold exactly one overlay');
			const afterClose = await ui(h, driver);
			const reconnects = afterClose.interactive_elements.filter(
				(element) => element.tag === 'button' && /reconnect/i.test(element.label ?? ''),
			);
			assertEquals(reconnects.length, 1, `one Reconnect button, not ${reconnects.length}`);
			assert(
				afterClose.interactive_elements.some((element) =>
					element.tag === 'button' && /sessions/i.test(element.label ?? '')
				),
				'a deliberate close must offer a way back to the session list',
			);
			// The layout comes from a class in app.css, not a `style` attribute the page's own CSP refuses.
			assertStringIncludes(html, 'class="app-shell"');
		});
	},
});

Deno.test({
	name: 'e2e SPA: a browser origin is accepted by default',
	ignore,
	async fn() {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });
		// Exactly what a browser sends for a same-origin POST. A 403 here would make the live view unreachable.
		const allowed = await h.fetch('/api/v1/live/ticket', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: h.url },
			body: JSON.stringify({}),
		});
		assertEquals(allowed.status, 201, await allowed.text());
		// And an origin that is not this server is still refused.
		const denied = await h.fetch('/api/v1/live/ticket', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
			body: JSON.stringify({}),
		});
		assertEquals(denied.status, 403);
		await denied.body?.cancel();
	},
});
