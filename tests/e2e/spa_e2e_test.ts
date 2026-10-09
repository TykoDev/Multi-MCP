/**
 * The live-view SPA, driven by a real browser.
 *
 * The completion criteria recorded the front end as a *manual* checklist. This
 * is that checklist, automated: one Chromium session loads the shipped bundle
 * from the shipped static server and clicks through it, while a second session
 * is the browser being viewed. The decisive assertion is made from outside both
 * — the SPA drives session B, and session B is then inspected through MCP to
 * confirm it really moved.
 *
 * It is also the honest test of `static.ts` and of the origin policy: a browser
 * fetching this page sends an `Origin` header that a real deployment has to
 * accept (E-23), which no `fetch` from Deno would have revealed.
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
		// Three sessions at most: the SPA driver, and the session it views. `evaluate` is on the harness key only so
		// this suite can look inside the driver's page for the B4 cookie checks; the SPA never needs it. The data
		// directory and the `files:*` scopes give the Resources tree a share to list (F2).
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
		/** Reads a JSON-serialisable value out of the driver's page. */
		const fromPage = async <T>(expression: string): Promise<T> =>
			JSON.parse(String(await inPage(`JSON.stringify(${expression})`))) as T;

		// The session the SPA will look at is `default`, so the test can reach it
		// through the Sessions section's Live View tab (which opens the default session, D-147)
		// rather than having to work out which card belongs to which browser.
		const viewed = await h.callJson<{ session_id: string }>('browser_navigate', {
			url: h.site.page('index'),
		});

		// The session that *runs* the SPA is a separate browser, so the viewer and
		// the viewed are unambiguously different.
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
			assert(body.length > 1000, `the bundle is suspiciously small: ${body.length} bytes`);
			// The gate the completion criteria set: under 150 KB minified.
			assert(body.length < 150 * 1024, `the bundle is ${Math.round(body.length / 1024)} KB, over the 150 KB budget`);
		});

		await t.step('the page loads and asks for a credential', async () => {
			const state = await ui(h, driver);
			assertStringIncludes(state.title, 'TykoTech');
			// The connect route is where an unauthenticated reload lands.
			assertStringIncludes(state.page, 'Connect');
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

			// The listing is fetched over HTTP from inside the browser — which is
			// what proves the origin policy lets the SPA talk to its own server.
			await waitForUi(h, driver, viewed.session_id, 'the viewed session in its list');
		});

		await t.step(
			'the sign-in is an HttpOnly cookie: nothing in storage, and a forged change is refused (B4)',
			async () => {
				// AC3: no credential of any kind in the page's storage — only the display preferences may be there.
				const keys = JSON.parse(String(await inPage('JSON.stringify(Object.keys(localStorage))'))) as string[];
				assert(!keys.includes('ttk.login'), `ttk.login survives in localStorage: ${keys.join(', ')}`);
				assertEquals(keys.filter((key) => key !== 'ttk.theme' && key !== 'ttk.dock'), [], keys.join(', '));
				// The cookie is HttpOnly: page script cannot see it at all.
				const visible = String(await inPage('document.cookie'));
				assert(
					!visible.includes('ttk_session') && !visible.includes('ttks_'),
					`the session cookie is readable: ${visible}`,
				);
				// A change the page makes without the CSRF value — what a forged request riding the cookie would be —
				// is refused, while a read rides the cookie and hands the page its CSRF value back.
				assertEquals(
					await inPage(
						"fetch('/api/v1/live/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })" +
							".then(async (r) => r.status + ' ' + (await r.json()).type)",
					),
					'403 https://tykotech.eu/problems/csrf-failed',
				);
				assertEquals(
					await inPage("fetch('/api/v1/auth/me').then((r) => r.json()).then((b) => typeof b.csrf)"),
					'string',
				);
			},
		);

		await t.step('a reload stays signed in: the cookie is checked with the server at load', async () => {
			await h.callText('browser_navigate', { session_id: driver, url: `${h.url}/?reload=1#/sessions` });
			await waitForUi(h, driver, viewed.session_id, 'the session list after a reload');
		});

		await t.step(
			'the dock shows five items, neither the Library nor Tools is one, and Sessions has three tabs (D-147, D-152)',
			async () => {
				// The reload above is confirmed by the session list, which the page before it showed too: wait for the
				// shell of the new document before reading its dock.
				await untilInPage("document.querySelectorAll('.dock .dock-item').length > 0", 'the dock after the reload');
				const labels = await fromPage<string[]>(
					"Array.from(document.querySelectorAll('.dock .dock-item')).map((b) => (b.getAttribute('aria-label') ?? '').replace(/ \\(\\d+\\)$/, ''))",
				);
				assertEquals(labels, ['Sessions', 'Resources', 'Agents', 'Users', 'System']);
				// D-147: the Live View and the Workspaces are tabs of Sessions, each a link to its own route.
				if (!(await inPage("location.hash === '#/sessions'"))) await inPage("location.hash = '#/sessions'; true");
				await untilInPage("document.querySelectorAll('.page-tabs .page-tab').length === 3", 'the Sessions tabs');
				const tabs = await fromPage<Array<[string, string, string | null]>>(
					"Array.from(document.querySelectorAll('.page-tabs .page-tab')).map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')])",
				);
				assertEquals(tabs.map(([label]) => label), ['Sessions', 'Live View', 'Workspaces']);
				assertEquals(tabs[0]?.[2], 'page', 'the Sessions tab is the current one');
				assertEquals(tabs[2]?.[1], '#/workspaces');
				assert(tabs[1]?.[1]?.startsWith('#/view/'), `the Live View tab opens a session: ${tabs[1]?.[1]}`);
			},
		);

		await t.step(
			'#/library/skills lands on #/resources/skills, and Back does not bounce (no history entry)',
			async () => {
				const before = Number(await inPage('history.length'));
				await inPage("location.replace('#/library/skills'); true");
				await untilInPage("location.hash === '#/resources/skills'", 'the Skills group of Resources');
				assertEquals(Number(await inPage('history.length')), before, 'the redirect added a history entry');
			},
		);

		await t.step('the Resources tree shows the eight groups in order, each with its tools first (D-152)', async () => {
			await untilInPage("document.querySelectorAll('.rx-tree > wa-tree-item').length === 8", 'the eight groups');
			const names = await fromPage<string[]>(
				"Array.from(document.querySelectorAll('.rx-tree > wa-tree-item')).map((n) => n.querySelector(':scope > .rx-branch-head > .rx-name')?.textContent ?? '')",
			);
			assertEquals(names, ['Server', 'Browser', 'Files', 'Skills', 'Prompts', 'Sandbox', 'Agents', 'Surfaces']);
			// The browser tools are the Browser group's first branch, by family; no tool is listed outside its group.
			await untilInPage(
				'!!document.querySelector(\'.rx-tree > wa-tree-item[data-key="group:browser"] > wa-tree-item.rx-tools\')',
				'the Browser tools branch',
			);
			const strays = await fromPage<number>(
				"Array.from(document.querySelectorAll('.rx-tree wa-tree-item.rx-tool')).filter((n) => n.closest('.rx-tools') === null).length",
			);
			assertEquals(strays, 0, 'every tool leaf sits in a Tools branch');
			// `#/tools/<name>` still answers, as a redirect to the tool's leaf.
			await inPage("location.hash = '#/tools/browser_navigate'; true");
			await untilInPage("location.hash === '#/resources/tools/browser_navigate'", 'the Tools redirect');
			await untilInPage("!!document.querySelector('.rx-viewer .tc-request')", 'the tool console in the viewer');
		});

		await t.step(
			'Resources carries no refresh or reload control (D-092); Read again on a live resource is allowed',
			async () => {
				// Every named control: aria-labels of icon-only buttons and the visible labels of worded ones.
				const refreshers = await fromPage<string[]>(
					"Array.from(document.querySelectorAll('[aria-label], button .label')).map((n) => n.getAttribute('aria-label') ?? n.textContent ?? '').filter((t) => /^(Refresh|Reload)/.test(t))",
				);
				assertEquals(refreshers, [], 'a refresh control on Resources');
			},
		);

		await t.step('ttk://capabilities reads as facts by default, and raw on the switch', async () => {
			await untilInPage(
				'!!document.querySelector(\'.rx-tree wa-tree-item[data-uri="ttk://capabilities"]\')',
				'the capabilities leaf',
			);
			await inPage('document.querySelector(\'.rx-tree wa-tree-item[data-uri="ttk://capabilities"]\').click(); true');
			await untilInPage("!!document.querySelector('.rx-viewer .json-facts')", 'the capabilities as facts');
			assertEquals(
				await inPage("document.querySelectorAll('.rx-viewer pre.code.json').length"),
				0,
				'raw JSON shown by default',
			);
			assertEquals(
				await inPage(
					"document.querySelector('.rx-viewer .segmented [data-id=\"facts\"]')?.getAttribute('aria-selected')",
				),
				'true',
			);
			assertStringIncludes(
				String(await inPage("document.querySelector('.rx-viewer .rx-uri')?.textContent")),
				'ttk://capabilities',
			);
			await inPage('document.querySelector(\'.rx-viewer .segmented [data-id="raw"]\').click(); true');
			await untilInPage("!!document.querySelector('.rx-viewer pre.code.json')", 'the raw JSON');
			assertEquals(
				await inPage("document.querySelectorAll('.rx-viewer .json-facts').length"),
				0,
				'facts shown beside raw',
			);
		});

		await t.step(
			'the share is the Files group: a written file is a tile under its folder crumb, and opens in the viewer',
			async () => {
				await h.callText('file_write', { path: 'notes/hello.md', content: '# hello' });
				await inPage("location.hash = '#/resources/files/notes'; true");
				await untilInPage(
					"Array.from(document.querySelectorAll('.rx-viewer .lib-file-name')).some((n) => n.textContent === 'hello.md')",
					'the hello.md tile',
				);
				// Where you are: the path as crumbs, the current one marked.
				assertEquals(
					await inPage(
						'document.querySelector(\'.rx-files-head .lib-crumbs [aria-current="location"] .label\')?.textContent',
					),
					'notes',
				);
				assertEquals(
					await inPage(
						"document.querySelector('.rx-tree wa-tree-item[data-key=\"folder:notes\"]')?.hasAttribute('selected')",
					),
					true,
					'the folder is marked in the tree',
				);
				// How you see it: Grid · List, worded. What you can add: one Add menu.
				assertEquals(
					await fromPage<string[]>(
						"Array.from(document.querySelectorAll('.rx-files-head .segmented [role=tab] .label')).map((n) => n.textContent)",
					),
					['Grid', 'List'],
				);
				assertEquals(
					await inPage('document.querySelectorAll(\'.rx-files-head .menu-trigger[aria-haspopup="menu"]\').length'),
					1,
					'one Add menu',
				);
				assertEquals(await inPage("document.querySelector('.rx-files-head .menu-trigger .label')?.textContent"), 'Add');
				// The drop zone says what it is for at rest.
				assertStringIncludes(
					String(await inPage("document.querySelector('.rx-files .lib-drop-strip')?.textContent")),
					'Drop files to upload',
				);
				// A tile opens the file in the viewer, as an editor.
				await inPage(
					"Array.from(document.querySelectorAll('.rx-viewer .lib-file-open')).find((b) => b.querySelector('.lib-file-name')?.textContent === 'hello.md').click(); true",
				);
				await untilInPage("document.querySelector('#share-editor')?.value === '# hello'", 'the file editor');
				assertEquals(await inPage('location.hash'), '#/resources/files/notes/hello.md');
				assertStringIncludes(
					String(await inPage("document.querySelector('.rx-viewer .rx-uri')?.textContent")),
					'notes/hello.md',
				);
			},
		);

		await t.step(
			'an empty writable folder keeps Add in its header, with its three items; Upload is the one primary (F-04, FE-4)',
			async () => {
				const made = await h.fetch('/api/v1/share/mkdir', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ path: 'empty-dir' }),
				});
				assertEquals(made.status, 201, await made.text());
				await inPage("location.hash = '#/resources/files/empty-dir'; true");
				await untilInPage(
					"document.querySelector('.rx-files .empty .empty-title')?.textContent === 'No files yet'",
					'the empty folder',
				);
				// New folder / New file are reachable: the menu is in the header, and it is not a second primary.
				await untilInPage("!!document.querySelector('.rx-files-add .menu-trigger')", 'the Add menu in an empty folder');
				await inPage("document.querySelector('.rx-files-add .menu-trigger').click(); true");
				await untilInPage(
					"document.querySelectorAll('.menu-list [role=menuitem]').length === 3",
					'the three Add items',
				);
				assertEquals(
					await fromPage<string[]>(
						"Array.from(document.querySelectorAll('.menu-list [role=menuitem] .label')).map((n) => n.textContent)",
					),
					['Upload files', 'New folder', 'New file'],
				);
				// Closed the way light-dismiss closes it; the popover removes itself after its hide.
				await inPage("document.querySelector('wa-popover.menu-pop').open = false; true");
				await untilInPage("document.querySelectorAll('.menu-list').length === 0", 'the Add menu closed');
				// One primary — the empty state's Upload, worded and glyph-less — and one cloud-upload on the screen: the
				// drop strip is folded into the empty state's own "Drop files here".
				assertEquals(
					await fromPage<string[]>(
						"Array.from(document.querySelectorAll('.rx-files .ttk-btn.primary:not(.menu-trigger)')).map((n) => n.querySelector('.label')?.textContent + ':' + n.querySelectorAll('svg').length)",
					),
					['Upload:0'],
				);
				assertEquals(await inPage("document.querySelectorAll('.rx-files .lib-drop-strip').length"), 0);
				// The drag veil draws the glyph too, invisible until a drag: everything at rest shows it once.
				assertEquals(
					await inPage(
						"Array.from(document.querySelectorAll('.rx-files use[href$=\"#cloud-upload\"]')).filter((u) => u.closest('.lib-drop-veil') === null).length",
					),
					1,
					'one cloud-upload glyph on the screen at rest',
				);
			},
		);

		await t.step('a sub-folder branch re-created by its parent re-listing still lists on expand (BUG-1)', async () => {
			await h.callText('file_write', { path: 'docs/reports/2026/x.txt', content: 'x' });
			// One navigation only: a hash set from outside re-renders the screen and with it the Files group and its
			// listing cache, which would hide the defect. Everything below happens inside this one mount.
			await inPage("location.hash = '#/resources/files/docs'; true");
			const branch = (path: string) => `document.querySelector('.rx-tree wa-tree-item[data-key="folder:${path}"]')`;
			await untilInPage(
				"document.querySelector('.rx-files-head .lib-crumbs [aria-current=\"location\"] .label')?.textContent === 'docs'",
				'the docs folder',
			);
			// Expanding the lazy reports branch lists it: 2026 appears under it.
			await untilInPage(`!!${branch('docs/reports')}`, 'the reports branch under docs');
			await inPage(`${branch('docs/reports')}.expanded = true; true`);
			await untilInPage(`!!${branch('docs/reports/2026')}`, 'the 2026 branch under reports');
			// A write in docs through the UI re-lists docs, which replaces the reports branch with a fresh lazy one.
			await inPage("document.querySelector('.rx-files-add .menu-trigger').click(); true");
			await untilInPage("document.querySelectorAll('.menu-list [role=menuitem]').length === 3", 'the Add items');
			await inPage(
				"Array.from(document.querySelectorAll('.menu-list [role=menuitem]')).find((n) => n.querySelector('.label')?.textContent === 'New file').click(); true",
			);
			await untilInPage("!!document.querySelector('#new-file')", 'the New file dialog');
			await inPage(
				"const i = document.querySelector('#new-file'); i.value = 'fresh.md'; i.closest('form').requestSubmit(); true",
			);
			await untilInPage(
				"Array.from(document.querySelectorAll('.rx-viewer .lib-file-name')).some((n) => n.textContent === 'fresh.md')",
				'the fresh.md tile',
			);
			assertEquals(await inPage(`!!${branch('docs/reports')} && ${branch('docs/reports')}.lazy === true`), true);
			assertEquals(await inPage(`!!${branch('docs/reports/2026')}`), false, 'the subtree went with the branch');
			// The fresh branch lists on expand: its children appear, and its spinner ends.
			await inPage(`${branch('docs/reports')}.expanded = true; true`);
			await untilInPage(`!!${branch('docs/reports/2026')}`, 'the 2026 branch after the re-listing');
			await untilInPage(`${branch('docs/reports')}.loading === false`, 'the branch out of its loading state');
		});

		await t.step('leaving System takes its composer drawer down with it (BUG-2)', async () => {
			await inPage("location.hash = '#/system'; true");
			await untilInPage("document.querySelectorAll('.sys-cap').length >= 17", 'the System tiles');
			const compose = 'document.querySelector(\'[aria-label="Compose configuration"]\')';
			await untilInPage(`!!${compose} && ${compose}.hidden === false`, 'the composer action');
			await inPage(`${compose}.click(); true`);
			await untilInPage("document.querySelector('wa-drawer.sys-composer')?.open === true", 'the composer drawer');
			await inPage("location.hash = '#/sessions'; true");
			await untilInPage("document.querySelectorAll('wa-drawer.sys-composer').length === 0", 'the drawer gone');
			// Back to where the later steps expect to be.
			await h.callText('browser_navigate', { session_id: driver, url: `${h.url}/?back=1#/sessions` });
			await waitForUi(h, driver, viewed.session_id, 'the session list again');
		});

		await t.step('opening the session shows the live view', async () => {
			const listed = await ui(h, driver);
			await h.callText('browser_click', {
				session_id: driver,
				// D-147: the Live View is a tab of Sessions, a link to `#/view/<session last watched>` (`default` here).
				index: pick(
					listed,
					(element) => element.tag === 'a' && /^live view$/i.test(element.label ?? ''),
				),
			});
			const html = await waitForUi(h, driver, '<canvas', 'the screencast canvas');
			// The viewer route is showing this session and reports a live socket.
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
			const urlField = pick(view, (element) => element.tag === 'input');
			await h.callText('browser_type', {
				session_id: driver,
				index: urlField,
				text: h.site.page('article'),
				clear: true,
			});
			await h.callText('browser_press_key', { session_id: driver, key: 'Enter' });

			// The assertion this whole suite exists for: a human clicked in the web
			// UI, and a different browser, checked independently, went somewhere.
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
			while (Date.now() < deadline) {
				held = (await h.callJson<{ human_has_control: boolean }>('browser_get_state', {
					session_id: viewed.session_id,
				})).human_has_control;
				if (!held) break;
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			assertEquals(held, false, 'the lock outlived the release click');
		});

		await t.step('closing the viewed session tells the SPA, and it does not retry', async () => {
			await h.callText('browser_close_session', { session_id: viewed.session_id });
			// `session-closed` is a deliberate end, so R6's auto-reconnect stands
			// down and offers the button rather than looping against a session that
			// no longer exists.
			await waitForUi(h, driver, 'session-closed', 'the disconnect notice');
			const html = await h.callText('browser_get_html', { session_id: driver });
			assert(!html.includes('Reconnecting in'), 'a deliberate close must not start the retry loop');

			// F2, in a real browser. Every overlay is `position:absolute; inset:0`,
			// so a second one stacks perfectly over the first and swallows every
			// click meant for the button underneath. `showOverlay` appended and
			// never removed until 0.2.0, so a view that dropped eight times ended
			// with a stack of nine overlays and no way to recover from inside the page.
			assertEquals(
				(html.match(/class="overlay"/g) ?? []).length,
				1,
				'the stage must hold exactly one overlay',
			);

			// The decisive form of the same assertion, made through perception
			// rather than markup: a stack of overlays shows up as a stack of
			// Reconnect buttons, each one hiding the last.
			const afterClose = await ui(h, driver);
			const reconnects = afterClose.interactive_elements.filter(
				(element) => element.tag === 'button' && /reconnect/i.test(element.label ?? ''),
			);
			assertEquals(reconnects.length, 1, `one Reconnect button, not ${reconnects.length}`);
			// And the exit that applies when the session really is gone.
			assert(
				afterClose.interactive_elements.some(
					(element) => element.tag === 'button' && /sessions/i.test(element.label ?? ''),
				),
				'a deliberate close must offer a way back to the session list',
			);

			// F4: the shell's layout comes from a class in app.css, not a `style`
			// attribute the page's own `style-src 'self'` refuses to apply.
			assertStringIncludes(html, 'class="app-shell"');
			assert(!/style="display:flex/.test(html), 'the shell must not carry a blocked style attribute');
		});
	},
});

Deno.test({
	name: 'e2e SPA: a browser origin is accepted by default (E-23)',
	ignore,
	async fn() {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });

		// Exactly what a browser sends for a same-origin POST. Before E-23 the
		// default configuration answered this 403, which made the live view
		// unreachable from any browser.
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
