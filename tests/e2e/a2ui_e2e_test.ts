/**
 * Real Chromium: the shipped SPA renders A2UI surfaces safely (Agents › Surfaces, over an in-memory sandbox), binds
 * inputs, runs only registered actions on an owned task, and fits narrow screens; the Agents chat lists your tasks and
 * shows one task per conversation.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { startFakeSandbox } from '../support/fake_sandbox.ts';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';

async function evaluate<T>(h: Harness, sessionId: string, expression: string): Promise<T> {
	const result = (await h.call('browser_evaluate', { session_id: sessionId, expression })).structuredContent as {
		ok: boolean;
		value: T;
	};
	assert(result.ok);
	return result.value;
}
async function wait(h: Harness, sessionId: string, expression: string): Promise<void> {
	const until = Date.now() + 20_000;
	while (Date.now() < until) {
		if (await evaluate<boolean>(h, sessionId, expression)) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`UI did not satisfy ${expression}`);
}
/** A 1×1 transparent PNG, as an agent would inline it. */
const PNG_1X1 = 'data:image/png;base64,' +
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
/** An agent's HTML document that tries every way to run: inline script, an event handler, a parent message. */
const HTML_DOCUMENT = '<h1 style="color:#2a9d8f">Agent report</h1>' +
	'<script>globalThis.a2uiHtmlRan = true; parent.postMessage("a2uiHtmlRan", "*")</script>' +
	'<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="globalThis.a2uiHtmlRan = true">';

/**
 * Makes one frame's requests carry the harness bearer, the way a cookie session makes the SPA's do, and
 * reloads it. A sandboxed frame is its own target (Chromium isolates it), so the headers go on that target.
 * Test plumbing only: `Network.setExtraHTTPHeaders` is outside the product's CDP surface; the product never sends it.
 */
async function publish(h: Harness, message: unknown): Promise<void> {
	// Every surface this suite creates belongs to the fake sandbox's workspace, which is where the SPA shows it.
	const create = (message as { createSurface?: Record<string, unknown> }).createSurface;
	if (create !== undefined && create.workspaceId === undefined) create.workspaceId = WORKSPACE_ID;
	const response = await h.fetch('/api/v1/a2ui/surfaces', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(message),
	});
	assertEquals(response.status, 200, await response.text());
}

/** The fake sandbox's one workspace, where every surface of this suite lives. */
const WORKSPACE_ID = '2276732b-a79d-436f-9cea-1a80b68a06b2';

Deno.test({
	name: 'e2e A2UI: shipped SPA safely renders, binds inputs, cancels an owned task and fits narrow screens',
	ignore: skipUnlessBrowser('A2UI SPA e2e'),
	async fn(t) {
		await using sandbox = await startFakeSandbox({ name: 'a2ui-demo', workspaceId: WORKSPACE_ID });
		await using h = await harness({
			scopes: [
				'mcp:invoke',
				'view:watch',
				'view:control',
				'admin',
				'evaluate',
				'agent:invoke',
				'a2ui:publish',
				'sandbox:execute',
			],
			env: { ...sandbox.env, TTK_MAX_SESSIONS: '4' },
			secrets: sandbox.secrets,
		});
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const driver =
			(await h.callJson<{ session_id: string }>('browser_navigate', { url: `${h.url}/`, new_session: true }))
				.session_id;
		// The connect form names its first field `username` (it takes a username or an API key).
		await wait(h, driver, '!!document.getElementById("username")');
		await evaluate(
			h,
			driver,
			`document.getElementById('username').value=${
				JSON.stringify(h.key)
			}; document.querySelector('button').click(); true`,
		);
		await wait(h, driver, 'location.hash === "#/sessions"');
		// Surfaces render on Agents › Surfaces: the suite watches them there.
		await evaluate(h, driver, `location.hash = '#/agents/surfaces'; true`);
		await wait(h, driver, '!!document.querySelector(".ws-surfaces")');
		await publish(h, { version: 'v0.9', createSurface: { surfaceId: 'ui-fixture', catalogId: A2UI_CATALOG_ID } });
		await publish(h, {
			version: 'v0.9',
			updateComponents: {
				surfaceId: 'ui-fixture',
				components: [
					{ id: 'root', component: 'Card', child: 'layout' },
					{ id: 'layout', component: 'Column', children: ['safe', 'form', 'name', 'flag', 'divider', 'disabled'] },
					{ id: 'safe', component: 'Text', text: '<script>globalThis.a2uiUnsafe=true</script>' },
					{ id: 'form', component: 'Row', children: ['input', 'check'] },
					{ id: 'input', component: 'TextField', label: 'Your name', value: { path: '/name' } },
					{ id: 'check', component: 'CheckBox', label: 'Confirmed', value: { path: '/confirmed' } },
					{ id: 'name', component: 'Text', text: { path: '/name' } },
					{ id: 'flag', component: 'Text', text: { path: '/confirmed' } },
					{ id: 'divider', component: 'Divider' },
					{
						id: 'disabled',
						component: 'Button',
						text: 'Unregistered action',
						action: { event: { name: 'arbitraryTool', context: {} } },
					},
				],
			},
		});
		await publish(h, {
			version: 'v0.9',
			updateDataModel: { surfaceId: 'ui-fixture', value: { name: 'Initial', confirmed: false } },
		});
		await wait(h, driver, '!!document.getElementById("a2ui-ui-fixture-input")');

		await t.step(
			'all eight local components render without interpreting markup; unbound actions are disabled',
			async () => {
				const state = await evaluate<{ script: boolean; unsafe: boolean; disabled: boolean; label: string }>(
					h,
					driver,
					`({script:!!document.querySelector('.a2ui-surface script'),unsafe:!!globalThis.a2uiUnsafe,disabled:Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Unregistered action').disabled,label:document.querySelector('label[for="a2ui-ui-fixture-input"]').textContent})`,
				);
				assertEquals(state, { script: false, unsafe: false, disabled: true, label: 'Your name' });
				assertStringIncludes(await h.callText('browser_get_html', { session_id: driver }), '&lt;script&gt;');
			},
		);
		await t.step('text fields and checkboxes update bound text locally and preserve input focus', async () => {
			await evaluate(
				h,
				driver,
				`const field=document.getElementById('a2ui-ui-fixture-input'); field.focus();field.value='Ada';field.dispatchEvent(new Event('input',{bubbles:true}));true`,
			);
			assertEquals(
				await evaluate(
					h,
					driver,
					`({text:document.querySelector('.a2ui-surface').textContent.includes('Ada'),focus:document.activeElement.id})`,
				),
				{ text: true, focus: 'a2ui-ui-fixture-input' },
			);
			await evaluate(h, driver, `document.getElementById('a2ui-ui-fixture-check').click();true`);
			assertEquals(
				await evaluate(h, driver, `document.querySelector('.a2ui-surface').textContent.includes('true')`),
				true,
			);
		});
		await t.step(
			'wide and narrow rendered layouts stay inside the viewport and keyboard labels remain present',
			async () => {
				for (const width of [1200, 390]) {
					await h.callText('browser_set_viewport', { session_id: driver, width, height: 900 });
					const layout = await evaluate<{ width: number; overflow: boolean; status: boolean }>(
						h,
						driver,
						`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,status:!!document.querySelector('[aria-live="polite"]')})`,
					);
					assertEquals(layout.width, width);
					assertEquals(layout.overflow, false);
					assertEquals(layout.status, true);
					await evaluate(h, driver, `document.querySelector('main.main').scrollTop=400;true`);
				}
			},
		);
		await t.step(
			'registered cancel action reaches the owned runtime and consumed actions cannot be rearmed by another surface',
			async () => {
				const response = await h.fetch('/a2a', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 'wait-task',
						method: 'SendMessage',
						params: {
							configuration: { returnImmediately: true },
							message: {
								messageId: crypto.randomUUID(),
								role: 'ROLE_USER',
								parts: [{
									data: {
										tool: 'browser_wait_for',
										arguments: { session_id: 'default', until: { selector: '#never-present-a2ui' }, timeout_ms: 60000 },
									},
								}],
							},
						},
					}),
				});
				assertEquals(response.status, 200);
				const taskId = ((await response.json()).result.task as { id: string }).id;
				await publish(h, { version: 'v0.9', createSurface: { surfaceId: 'task-actions', catalogId: A2UI_CATALOG_ID } });
				await publish(h, {
					version: 'v0.9',
					updateComponents: {
						surfaceId: 'task-actions',
						components: [{
							id: 'root',
							component: 'Button',
							text: 'Cancel owned task',
							action: { event: { name: 'cancelTask', context: { taskId } } },
						}],
					},
				});
				await wait(
					h,
					driver,
					`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Cancel owned task'&&!b.disabled)`,
				);
				await evaluate(
					h,
					driver,
					`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Cancel owned task').click();true`,
				);
				await wait(h, driver, `document.querySelector('main.main').textContent.includes('Action submitted.')`);
				const task = await h.fetch(`/api/v1/agent/tasks/${taskId}`);
				assertEquals((await task.json()).task.status.state, 'TASK_STATE_CANCELED');
				await publish(h, {
					version: 'v0.9',
					updateDataModel: { surfaceId: 'ui-fixture', path: '/name', value: 'Updated elsewhere' },
				});
				const list = await h.fetch('/api/v1/a2ui/surfaces');
				const target = (await list.json()).surfaces.find((surface: { surfaceId: string }) =>
					surface.surfaceId === 'task-actions'
				);
				assertEquals(target.availableActions, []);
			},
		);
		await t.step('the v0.9 basic catalog renders on the kit; a theme stays on its surface', async () => {
			await publish(h, {
				version: 'v0.9',
				createSurface: {
					surfaceId: 'catalog',
					catalogId: A2UI_CATALOG_ID,
					theme: { primaryColor: '#2a9d8f', font: 'serif', radius: 4, density: 'compact' },
				},
			});
			await publish(h, {
				version: 'v0.9',
				updateComponents: {
					surfaceId: 'catalog',
					components: [
						{
							id: 'root',
							component: 'Column',
							children: ['title', 'logo', 'glyph', 'items', 'tabs', 'modal', 'volume', 'level', 'when', 'frame'],
						},
						{ id: 'title', component: 'Text', text: 'Every component', variant: 'h2' },
						{ id: 'logo', component: 'Image', url: PNG_1X1, description: 'one pixel', variant: 'icon' },
						{ id: 'glyph', component: 'Icon', name: 'shield-check' },
						{ id: 'items', component: 'List', children: ['first', 'second'] },
						{ id: 'first', component: 'Text', text: 'first item' },
						{ id: 'second', component: 'Text', text: 'second item' },
						{
							id: 'tabs',
							component: 'Tabs',
							tabs: [{ title: 'One', child: 'pick' }, { title: 'Many', child: 'many' }],
						},
						{
							id: 'pick',
							component: 'ChoicePicker',
							label: 'Pick one',
							options: [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }],
							value: { path: '/one' },
						},
						{
							id: 'many',
							component: 'ChoicePicker',
							variant: 'multipleSelection',
							options: [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }],
							value: { path: '/many' },
						},
						{ id: 'modal', component: 'Modal', trigger: 'open', content: 'media' },
						{ id: 'open', component: 'Text', text: 'Open the media' },
						{ id: 'media', component: 'Column', children: ['clip', 'sound'] },
						{ id: 'clip', component: 'Video', url: `data:video/mp4;base64,${btoa('not-really-mp4')}` },
						{
							id: 'sound',
							component: 'AudioPlayer',
							url: `data:audio/ogg;base64,${btoa('ogg')}`,
							description: 'Brief',
						},
						{
							id: 'volume',
							component: 'Slider',
							label: 'Volume',
							min: 0,
							max: 10,
							step: 1,
							value: { path: '/volume' },
						},
						{ id: 'level', component: 'Text', text: { path: '/volume' } },
						{ id: 'when', component: 'DateTimeInput', label: 'When', value: { path: '/when' } },
						{ id: 'frame', component: 'Html', html: HTML_DOCUMENT, height: 120, title: 'Agent report' },
					],
				},
			});
			await publish(h, {
				version: 'v0.9',
				updateDataModel: {
					surfaceId: 'catalog',
					value: { one: ['b'], many: ['a'], volume: 4, when: '2026-10-04' },
				},
			});
			await wait(h, driver, '!!document.getElementById("a2ui-catalog-volume")');
			const state = await evaluate<Record<string, unknown>>(
				h,
				driver,
				`(() => {
					const root = document.querySelector('section[aria-label="Agent surface catalog"]');
					const frame = root.querySelector('iframe');
					return {
						image: root.querySelector('img').getAttribute('src').startsWith('data:image/png;base64,'),
						referrer: root.querySelector('img').getAttribute('referrerpolicy'),
						icon: root.querySelector('.a2ui-icon use').getAttribute('href'),
						list: root.querySelectorAll('[role=list] > [role=listitem]').length,
						tabs: root.querySelectorAll('wa-tab-group wa-tab').length,
						select: !!root.querySelector('wa-select'),
						boxes: Array.from(root.querySelectorAll('.a2ui-choices input')).map((box) => box.checked),
						range: [root.querySelector('input[type=range]').value, root.querySelector('input[type=range]').max],
						date: [root.querySelector('wa-input').getAttribute('type'), root.querySelector('wa-input').value],
						media: [!!root.querySelector('video[controls]'), !!root.querySelector('audio[controls]')],
						sandbox: frame.getAttribute('sandbox'),
						src: frame.getAttribute('src'),
						frameReferrer: frame.getAttribute('referrerpolicy'),
						themed: getComputedStyle(root).getPropertyValue('--a2ui-primary').trim(),
						shell: getComputedStyle(document.documentElement).getPropertyValue('--a2ui-primary').trim(),
						shellBrand: getComputedStyle(document.documentElement).getPropertyValue('--ttk-brand').trim(),
						markupInPage: document.documentElement.outerHTML.includes('a2uiHtmlRan'),
					};
				})()`,
			);
			assertEquals(state, {
				image: true,
				referrer: 'no-referrer',
				icon: '/assets/icons.svg#shield-check',
				list: 2,
				tabs: 2,
				select: true,
				boxes: [true, false],
				range: ['4', '10'],
				date: ['date', '2026-10-04'],
				media: [true, true],
				sandbox: '',
				src: '/api/v1/a2ui/surfaces/catalog/html/frame',
				frameReferrer: 'no-referrer',
				themed: '#2a9d8f',
				shell: '',
				shellBrand: state.shellBrand,
				markupInPage: false,
			});
			assert(state.shellBrand !== '#2a9d8f', 'the theme did not reach the shell');
			// The slider writes back to the model and the bound text follows; the modal's trigger opens the kit dialog.
			await evaluate(
				h,
				driver,
				`const range = document.getElementById('a2ui-catalog-volume'); range.value = '7';
				range.dispatchEvent(new Event('input', { bubbles: true }));
				document.querySelector('section[aria-label="Agent surface catalog"] .a2ui-modal-trigger').click(); true`,
			);
			await wait(
				h,
				driver,
				`(() => { const root = document.querySelector('section[aria-label="Agent surface catalog"]');
				return Array.from(root.querySelectorAll('.a2ui-text')).some((n) => n.textContent === '7') &&
					root.querySelector('wa-dialog').open === true; })()`,
			);
			await evaluate(
				h,
				driver,
				`document.querySelector('section[aria-label="Agent surface catalog"] wa-dialog').open = false; true`,
			);
			for (const width of [1280, 390]) {
				await h.callText('browser_set_viewport', { session_id: driver, width, height: 900 });
				const overflow = await evaluate<boolean>(h, driver, 'document.documentElement.scrollWidth > innerWidth');
				assertEquals(overflow, false, `no horizontal scroll at ${width} px`);
			}
		});
		await t.step('Html is served under the sandbox CSP and its script does not run in the frame', async () => {
			const response = await h.fetch('/api/v1/a2ui/surfaces/catalog/html/frame');
			assertEquals(response.status, 200);
			assertEquals(await response.text(), HTML_DOCUMENT);
			assertEquals(
				response.headers.get('content-security-policy'),
				"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'",
			);
			assertEquals(response.headers.get('x-content-type-options'), 'nosniff');
			assertEquals(response.headers.get('cache-control'), 'no-store');
			assertEquals(response.headers.get('cross-origin-resource-policy'), 'same-origin');
			await evaluate(
				h,
				driver,
				`globalThis.a2uiPosted = []; addEventListener('message', (event) => globalThis.a2uiPosted.push(event.data)); true`,
			);
			let frame: { id: string; is_oopif: boolean } | undefined;
			const until = Date.now() + 20_000;
			while (frame === undefined && Date.now() < until) {
				const frames = (await h.callJson<{ frames: Array<{ id: string; url: string; is_oopif: boolean }> }>(
					'browser_get_frames',
					{ session_id: driver },
				)).frames;
				frame = frames.find((entry) => entry.url.includes('/a2ui/surfaces/catalog/html/frame'));
				if (frame === undefined) await new Promise((resolve) => setTimeout(resolve, 200));
			}
			assert(frame !== undefined, 'the Html frame is in the page, pointed at its route');
			// The frame authenticates like the SPA that framed it: by the HttpOnly sign-in cookie. No credential is
			// injected here, so the document below can only have come through the cookie path.
			// Read inside the frame with the browser's own tools (CDP evaluates regardless of the frame's sandbox).
			let inside: { ran: boolean; heading: string; origin: string } | undefined;
			while (Date.now() < until) {
				const probe = (await h.call('browser_evaluate', {
					session_id: driver,
					frame_id: frame.id,
					expression:
						`({ ran: globalThis.a2uiHtmlRan === true, heading: document.querySelector('h1')?.textContent ?? '', origin: self.origin })`,
				})).structuredContent as { ok?: boolean; value?: { ran: boolean; heading: string; origin: string } };
				inside = probe.value;
				if (inside?.heading === 'Agent report') break;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			// Rendered (the heading is there), inert (neither the script nor the error handler ran), and opaque-origin.
			assertEquals(inside, { ran: false, heading: 'Agent report', origin: 'null' });
			assertEquals(await evaluate<unknown[]>(h, driver, 'globalThis.a2uiPosted'), [], 'nothing reached the parent');
		});
		await t.step(
			'the composer settles on a fresh render: without a provider nothing can be sent, and it says why',
			async () => {
				await evaluate(
					h,
					driver,
					`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Agents').click(); true`,
				);
				await wait(h, driver, '!!document.getElementById("agent-prompt")');
				assertEquals(await evaluate<string>(h, driver, 'location.hash'), '#/agents', 'a new task starts empty');
				// This gateway has no providers file, so the settled state is "nothing to send to", named.
				await wait(h, driver, `document.querySelector('.ag-reason').textContent !== ''`);
				const state = await evaluate<{ disabled: boolean; reason: string; options: Array<[string, boolean]> }>(
					h,
					driver,
					`({disabled:document.querySelector('.ag-composer button[type=submit]').disabled,reason:document.querySelector('.ag-reason').textContent,options:Array.from(document.querySelectorAll('#agent-target option')).map((o)=>[o.textContent,o.disabled])})`,
				);
				assertEquals(state, {
					disabled: true,
					reason: 'No agent or model provider is available',
					// The suite's in-memory sandbox makes SlopLord a target; without a provider it cannot run.
					options: [['SlopLord (coding) — Needs the coding sandbox and a reachable model provider', true]],
				});
			},
		);
		await t.step('the chat lists your tasks, and a task opens as its conversation', async () => {
			const tasks = (await (await h.fetch('/api/v1/agent/tasks')).json()).tasks as Array<{ id: string }>;
			assert(tasks.length >= 1, 'the cancelled wait task is listed');
			const taskId = tasks[0]!.id;
			await wait(h, driver, `document.querySelectorAll('.ag-tasks .ag-task').length === ${tasks.length}`);
			await evaluate(
				h,
				driver,
				`document.querySelector('.ag-task[href$="${encodeURIComponent(taskId)}"]').click(); true`,
			);
			await wait(h, driver, `!!document.querySelector('.ag-turn[data-task="${taskId}"]')`);
			assertEquals(await evaluate<number>(h, driver, `document.querySelectorAll('.ag-turn').length`), 1);
			assert(
				await evaluate<boolean>(
					h,
					driver,
					`document.querySelector('.ag-task.active')?.getAttribute('aria-current') === 'page'`,
				),
				'the open task is marked in the list',
			);
			for (const width of [1280, 390]) {
				await h.callText('browser_set_viewport', { session_id: driver, width, height: 900 });
				const overflow = await evaluate<boolean>(h, driver, 'document.documentElement.scrollWidth > innerWidth');
				assertEquals(overflow, false, `no horizontal scroll at ${width} px`);
			}
			await h.callText('browser_set_viewport', { session_id: driver, width: 1280, height: 900 });
		});
		await t.step("System reports Chromium's sandbox and the coding sandbox as on", async () => {
			await evaluate(
				h,
				driver,
				`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='System').click(); true`,
			);
			await wait(h, driver, '!!document.querySelector(".sys-caps")');
			const tiles = await evaluate<Record<string, string>>(
				h,
				driver,
				`Object.fromEntries(Array.from(document.querySelectorAll('.sys-cap')).map((tile) => [tile.dataset.name, tile.className]))`,
			);
			// The harness launches Chromium with its sandbox (TTK_CHROMIUM_NO_SANDBOX unset), and diagnostics say so.
			assertEquals(tiles['Sandboxed Chromium'], 'sys-cap on');
			assertEquals(tiles['Coding sandbox'], 'sys-cap on', 'the in-memory sandbox answers its health check');
		});
		// End UI polling before teardown, and join each browser's profile cleanup rather than
		// spending the shared gateway shutdown budget on two concurrent Windows removals.
		await h.callText('browser_close_session', { session_id: driver });
		await h.callText('browser_close_session', { session_id: 'default' });
	},
});
