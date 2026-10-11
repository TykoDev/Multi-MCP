/**
 * Real Chromium: scoped SPA rendering, input reactivity, bounded actions and narrow-screen layout. Surfaces render under
 * their workspace (Sessions › Workspaces, over an in-memory sandbox); the Agents chat shows one task per conversation,
 * and the Tasks tab its run history.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { startFakeSandbox } from '../support/fake_sandbox.ts';
import { type Harness, harness, imageOf, skipUnlessBrowser } from '../support/harness.ts';

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
 * Makes one frame's requests carry the harness bearer, the way a cookie session (B4) makes the SPA's do, and
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
		// Surfaces live with their workspace: the suite watches them on its page.
		await evaluate(h, driver, `location.hash = '#/workspaces/${WORKSPACE_ID}/surfaces'; true`);
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
					const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
					assert(shot);
					await Deno.mkdir('tests/.scratch', { recursive: true });
					await Deno.writeFile(`tests/.scratch/a2ui-${width}.png`, shot.bytes);
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
		await t.step('D-111: the v0.9 basic catalog renders on the kit; a theme stays on its surface', async () => {
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
				await evaluate(
					h,
					driver,
					`document.querySelector('section[aria-label="Agent surface catalog"]').scrollIntoView(); true`,
				);
				const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
				assert(shot);
				await Deno.writeFile(`tests/.scratch/a2ui-catalog-${width}.png`, shot.bytes);
			}
		});
		await t.step('AC5: Html is served under the sandbox CSP and its script does not run in the frame', async () => {
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
			// The frame authenticates like the SPA that framed it: by the HttpOnly sign-in cookie (D-097). No credential is
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
			await evaluate(
				h,
				driver,
				`document.querySelector('section[aria-label="Agent surface catalog"] iframe').scrollIntoView(); true`,
			);
			const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
			assert(shot);
			await Deno.writeFile('tests/.scratch/a2ui-html-frame.png', shot.bytes);
		});
		await t.step(
			'F-01: a fresh render settles the target select and the submit without the select being touched',
			async () => {
				await evaluate(
					h,
					driver,
					// The rail items are icon buttons; their name is the accessible label, not text content.
					`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Agents').click(); true`,
				);
				await wait(h, driver, '!!document.getElementById("agent-prompt")');
				assertEquals(await evaluate<string>(h, driver, 'location.hash'), '#/agents', 'a new task starts empty');
				// This gateway has no providers file and no ACP bridge (`harness()` builds its config with no
				// `modelProviders`, and `loadConfig` never reads `TTK_MODEL_PROVIDERS_FILE` from `env`), so the settled
				// state is "nothing to send to", named — not the "Loading the targets…" the composer starts on, and not a
				// select that reads as chosen while the submit says otherwise. The reachable-provider case (submit enabled
				// on a fresh render) is proved over a stubbed providers answer in `task_composer_test.ts`.
				await wait(
					h,
					driver,
					`document.querySelector('.ag-composer button[type=submit]').getAttribute('data-tip') !== 'Loading the targets…'`,
				);
				const state = await evaluate<{
					disabled: boolean;
					tip: string | null;
					options: Array<{ disabled: boolean; tip: string | null; hidden: string }>;
					retryHidden: boolean;
					chosen: boolean;
				}>(
					h,
					driver,
					`({disabled:document.querySelector('.ag-composer button[type=submit]').disabled,tip:document.querySelector('.ag-composer button[type=submit]').getAttribute('data-tip'),options:Array.from(document.querySelectorAll('#agent-target wa-option')).map((o)=>({disabled:o.hasAttribute('disabled'),tip:o.getAttribute('data-tip'),hidden:(o.querySelector('.sr-only')||{textContent:''}).textContent})),retryHidden:document.querySelector('.ag-target-retry').hidden,chosen:!!document.getElementById('agent-target').value})`,
				);
				assertEquals(state, {
					disabled: true,
					tip: 'No coding agent or model provider is available',
					options: [
						{ disabled: true, tip: 'No ACP agent configured', hidden: ' — No ACP agent configured' },
						// The suite's in-memory sandbox makes SlopLord a target; without a provider it cannot run.
						{
							disabled: true,
							tip: 'Needs the coding sandbox and a reachable model provider',
							hidden: ' — Needs the coding sandbox and a reachable model provider',
						},
					],
					retryHidden: true,
					chosen: false,
				});
			},
		);
		await t.step(
			'F4: the composer offers three kinds; Run tool with browser_navigate renders a url field and submits a tool task',
			async () => {
				await h.callText('browser_set_viewport', { session_id: driver, width: 1280, height: 900 });
				const tabs = await evaluate<string[]>(
					h,
					driver,
					`Array.from(document.querySelectorAll('.ag-composer .ag-kinds [role=tab]')).map((b) => b.textContent.trim())`,
				);
				assertEquals(tabs, ['Ask agent', 'Run tool', 'Delegate']);
				assertEquals(
					await evaluate<number>(h, driver, `document.querySelectorAll('.ag-composer [role=tablist]').length`),
					1,
				);
				await evaluate(h, driver, `document.querySelectorAll('.ag-composer .ag-kinds [role=tab]')[1].click(); true`);
				await wait(h, driver, `!!document.querySelector('#agent-tool wa-option[value="browser_navigate"]')`);
				// The excluded set is never offered (D-141: a task cannot run them).
				assertEquals(
					await evaluate<string[]>(
						h,
						driver,
						`Array.from(document.querySelectorAll('#agent-tool wa-option')).map((o) => o.getAttribute('value')).filter((v) => /^(browser_run_task|agent_run_tool|browser_live_ticket|browser_file_link|a2ui_delete)$/.test(v))`,
					),
					[],
				);
				await evaluate(
					h,
					driver,
					`const s = document.getElementById('agent-tool'); s.value = 'browser_navigate'; s.dispatchEvent(new Event('change', { bubbles: true })); true`,
				);
				await wait(h, driver, `!!document.getElementById('task-arg-url')`);
				await evaluate(
					h,
					driver,
					`const u = document.getElementById('task-arg-url'); u.value = ${
						JSON.stringify(h.site.page('index'))
					}; u.dispatchEvent(new Event('input', { bubbles: true }));
					document.querySelector('.ag-composer button[type=submit]').click(); true`,
				);
				// A request is a task of its own: the chat moves to it, and shows that one task with its id.
				await wait(h, driver, `location.hash.startsWith('#/agents/chat/')`);
				await wait(h, driver, `!!document.querySelector('.ag-turn[data-kind="tool"]')`);
				const tasks = await h.fetch('/api/v1/agent/tasks');
				const created = ((await tasks.json()).tasks as Array<{ id: string; metadata?: { kind?: string } }>).filter((
					task,
				) => task.metadata?.kind === 'tool');
				assert(created.length >= 1, 'the tool task was accepted with metadata.kind = tool');
				const shown = decodeURIComponent(
					(await evaluate<string>(h, driver, 'location.hash')).slice('#/agents/chat/'.length),
				);
				assert(created.some((task) => task.id === shown), 'the chat shows the task it created');
				assertEquals(await evaluate<number>(h, driver, `document.querySelectorAll('.ag-turn').length`), 1);
				assertEquals(
					await evaluate<string>(h, driver, `document.querySelector('.ag-task-bar .ag-task-id').textContent`),
					shown,
				);
				const chat = imageOf(await h.call('browser_screenshot', { session_id: driver }));
				assert(chat);
				await Deno.writeFile('tests/.scratch/agents-chat-1280.png', chat.bytes);
				// The earlier wait-task is not in this conversation: every task keeps its own.
				assertEquals(
					await evaluate<boolean>(
						h,
						driver,
						`document.querySelector('.ag-thread').textContent.includes('browser_wait_for')`,
					),
					false,
				);
				// Back to the first kind: the prompt is still there, with its id.
				await evaluate(h, driver, `document.querySelectorAll('.ag-composer .ag-kinds [role=tab]')[0].click(); true`);
				await wait(
					h,
					driver,
					`!!document.getElementById('agent-prompt') && !document.getElementById('agent-prompt').closest('[hidden]')`,
				);
			},
		);
		await t.step('Tasks: the list holds every task, and a task opens its run history with the tool call', async () => {
			const toolTask = decodeURIComponent(
				(await evaluate<string>(h, driver, 'location.hash')).slice('#/agents/chat/'.length),
			);
			await evaluate(
				h,
				driver,
				`Array.from(document.querySelectorAll('.ag-task-bar button')).find((b) => b.textContent.trim() === 'Run history').click(); true`,
			);
			await wait(h, driver, `location.hash === '#/agents/tasks/' + ${JSON.stringify(encodeURIComponent(toolTask))}`);
			await wait(h, driver, `document.querySelectorAll('.tk-timeline .tk-entry').length >= 4`);
			const view = await evaluate<{ rows: number; selected: string | null; kinds: string[]; facts: boolean }>(
				h,
				driver,
				`({
					rows: document.querySelectorAll('.rx-tree wa-tree-item').length,
					selected: document.querySelector('.rx-tree wa-tree-item[selected]')?.getAttribute('data-key') ?? null,
					kinds: Array.from(document.querySelectorAll('.tk-timeline .tk-entry')).map((e) => e.className.replace('tk-entry ', '')),
					facts: document.querySelector('.rx-viewer').textContent.includes(${JSON.stringify(toolTask)}),
				})`,
			);
			assert(view.rows >= 2, `every task is listed (${view.rows})`);
			assertEquals(view.selected, `task:${toolTask}`);
			assertEquals(view.kinds.slice(0, 4), ['received', 'state', 'tool_call', 'tool_result']);
			assert(view.facts, 'the overview names the task id');
			await evaluate(
				h,
				driver,
				`document.querySelector('.tk-entry.tool_call details')?.setAttribute('open', ''); true`,
			);
			assert(
				await evaluate<boolean>(h, driver, `document.querySelector('.tk-entry.tool_call').textContent.includes('url')`),
				'the tool call shows its arguments',
			);
			for (const width of [1280, 390]) {
				await h.callText('browser_set_viewport', { session_id: driver, width, height: 900 });
				const overflow = await evaluate<boolean>(h, driver, 'document.documentElement.scrollWidth > innerWidth');
				assertEquals(overflow, false, `no horizontal scroll at ${width} px`);
				const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
				assert(shot);
				await Deno.writeFile(`tests/.scratch/agents-tasks-${width}.png`, shot.bytes);
			}
			await h.callText('browser_set_viewport', { session_id: driver, width: 1280, height: 900 });
		});
		await t.step('F4: the builder publishes a Status card from its template and it renders as a surface', async () => {
			await evaluate(h, driver, `location.hash = '#/workspaces/${WORKSPACE_ID}/surfaces'; true`);
			await wait(h, driver, '!!document.querySelector(".ws-surface")');
			// Surfaces exist, so the one "New surface" action is in the Surfaces header, not in an empty state.
			assertEquals(
				await evaluate<number>(
					h,
					driver,
					`Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === 'New surface').length`,
				),
				1,
			);
			await evaluate(
				h,
				driver,
				`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'New surface').click(); true`,
			);
			await wait(h, driver, `document.querySelector('wa-drawer.ag-builder')?.open === true`);
			assertEquals(
				await evaluate<string[]>(
					h,
					driver,
					`Array.from(document.querySelectorAll('.ag-builder-tabs wa-tab')).map((t) => t.textContent.trim())`,
				),
				['Template', 'Edit', 'Preview', 'Advanced'],
			);
			assertEquals(
				await evaluate<number>(h, driver, `document.querySelectorAll('.ag-templates .ag-template').length`),
				5,
			);
			assert(
				await evaluate<boolean>(h, driver, `!!document.getElementById('a2ui-publish')`),
				'the raw JSON textarea keeps its id',
			);
			await evaluate(h, driver, `document.getElementById('ag-template-status').click(); true`);
			await wait(
				h,
				driver,
				`!!document.getElementById('ag-surface-id') && document.querySelector('.ag-builder-tabs').active === 'edit'`,
			);
			await evaluate(
				h,
				driver,
				`const id = document.getElementById('ag-surface-id'); id.value = 'built-status'; id.dispatchEvent(new Event('input', { bubbles: true })); true`,
			);
			// The preview is the real renderer over the current values.
			await evaluate(h, driver, `document.querySelector('.ag-builder-tabs wa-tab[panel="preview"]').click(); true`);
			await wait(h, driver, `!!document.querySelector('.ag-builder .ag-preview .a2ui-surface')`);
			assert(
				await evaluate<boolean>(
					h,
					driver,
					`document.querySelector('.ag-builder .ag-preview .a2ui-surface').textContent.includes('Build finished')`,
				),
			);
			await evaluate(
				h,
				driver,
				`Array.from(document.querySelectorAll('wa-drawer.ag-builder button')).find((b) => b.textContent.trim() === 'Publish').click(); true`,
			);
			await wait(
				h,
				driver,
				`Array.from(document.querySelectorAll('.ws-surface')).some((s) => s.textContent.includes('built-status') && !!s.querySelector('.a2ui-surface'))`,
			);
			await wait(h, driver, `!document.querySelector('wa-drawer.ag-builder')`);
			const list = await h.fetch('/api/v1/a2ui/surfaces');
			const built = (await list.json()).surfaces.find((surface: { surfaceId: string }) =>
				surface.surfaceId === 'built-status'
			) as { workspaceId?: string; components: Array<{ id: string; component: string; text?: string }> } | undefined;
			assert(built !== undefined, 'the surface was published');
			assertEquals(built.workspaceId, WORKSPACE_ID, 'the builder creates the surface in the open workspace');
			assertEquals(built.components.find((c) => c.id === 'title')?.text, 'Build finished');
			assertEquals(built.components.find((c) => c.id === 'root')?.component, 'Card');
			for (const width of [1280, 390]) {
				await h.callText('browser_set_viewport', { session_id: driver, width, height: 900 });
				const overflow = await evaluate<boolean>(h, driver, 'document.documentElement.scrollWidth > innerWidth');
				assertEquals(overflow, false, `no horizontal scroll at ${width} px`);
				const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
				assert(shot);
				await Deno.writeFile(`tests/.scratch/workspace-surfaces-${width}.png`, shot.bytes);
			}
		});
		await t.step(
			'workspace tabs switch in place; the task icon counts the workspace’s tasks and opens them',
			async () => {
				// A task that touched this workspace (its tool call names it).
				const response = await h.fetch('/a2a', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 'ws-task',
						method: 'SendMessage',
						params: {
							message: {
								messageId: crypto.randomUUID(),
								role: 'ROLE_USER',
								parts: [{ data: { tool: 'sandbox_list', arguments: { workspace_id: WORKSPACE_ID } } }],
							},
						},
					}),
				});
				const wsTask = ((await response.json()).result.task as { id: string }).id;
				await h.callText('browser_set_viewport', { session_id: driver, width: 1280, height: 900 });
				// The Surfaces tab is on screen (the route named it); Files & shell is one click away, without a navigation.
				const tabs = await evaluate<
					{ current: string | null; filesHidden: boolean; surfacesHidden: boolean; badge: string }
				>(
					h,
					driver,
					`({ current: document.querySelector('.ws-tabs [aria-current="page"]')?.dataset.tab ?? null,
					filesHidden: document.querySelector('.ws-view[data-view="files"]').hidden,
					surfacesHidden: document.querySelector('.ws-view[data-view="surfaces"]').hidden,
					badge: document.querySelector('.ws-tab-count').textContent })`,
				);
				assertEquals(tabs.current, 'surfaces');
				assertEquals([tabs.filesHidden, tabs.surfacesHidden], [true, false]);
				assert(Number(tabs.badge) >= 3, `the Surfaces tab counts the workspace's surfaces (${tabs.badge})`);
				await evaluate(
					h,
					driver,
					`globalThis.__sameScreen = true; document.querySelector('.ws-tabs [data-tab="files"]').click(); true`,
				);
				assertEquals(
					await evaluate<{ hash: string; same: boolean; files: boolean }>(
						h,
						driver,
						`({ hash: location.hash, same: globalThis.__sameScreen === true && !!document.querySelector('.ws-tree'),
						files: !document.querySelector('.ws-view[data-view="files"]').hidden })`,
					),
					{ hash: `#/workspaces/${WORKSPACE_ID}`, same: true, files: true },
				);
				const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
				assert(shot);
				await Deno.writeFile('tests/.scratch/workspace-tabs-files.png', shot.bytes);
				// The task icon: the count of tasks that touched the workspace, and a click opens them, the newest selected.
				await wait(
					h,
					driver,
					`!document.querySelector('.ws-tasks').hidden && document.querySelector('.ws-task-count').textContent === '1'`,
				);
				await evaluate(h, driver, `document.querySelector('.ws-tasks').click(); true`);
				await wait(
					h,
					driver,
					`location.hash === ${JSON.stringify(`#/agents/tasks/${wsTask}?workspace=${WORKSPACE_ID}`)}`,
				);
				await wait(
					h,
					driver,
					`document.querySelectorAll('.rx-tree wa-tree-item').length === 1 && !!document.querySelector('.tk-filter')`,
				);
				assertStringIncludes(
					await evaluate<string>(h, driver, `document.querySelector('.tk-filter').textContent`),
					'a2ui-demo',
				);
				const filtered = imageOf(await h.call('browser_screenshot', { session_id: driver }));
				assert(filtered);
				await Deno.writeFile('tests/.scratch/agents-tasks-workspace.png', filtered.bytes);
				// Clearing the filter shows every task again.
				await evaluate(h, driver, `document.querySelector('.tk-filter button').click(); true`);
				await wait(
					h,
					driver,
					`!location.hash.includes('workspace=') && document.querySelectorAll('.rx-tree wa-tree-item').length > 1`,
				);
			},
		);
		await t.step("C12: System reports Chromium's sandbox and the coding sandbox as two tiles", async () => {
			await h.callText('browser_set_viewport', { session_id: driver, width: 1280, height: 900 });
			await evaluate(
				h,
				driver,
				`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='System').click(); true`,
			);
			await wait(h, driver, '!!document.querySelector(".sys-caps")');
			const tiles = await evaluate<Record<string, string>>(
				h,
				driver,
				`Object.fromEntries(Array.from(document.querySelectorAll('.sys-cap')).map((tile) =>
					[tile.getAttribute('data-tip').split(' · ')[0], tile.className]))`,
			);
			// The harness launches Chromium with its sandbox (TTK_CHROMIUM_NO_SANDBOX unset), and diagnostics say so.
			assertEquals(tiles['Sandboxed Chromium'], 'sys-cap on');
			assertEquals(tiles['Coding sandbox'], 'sys-cap on', 'the in-memory sandbox answers its health check');
			for (const width of [1280, 390]) {
				await h.callText('browser_set_viewport', { session_id: driver, width, height: 900 });
				const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
				assert(shot);
				await Deno.writeFile(`tests/.scratch/system-${width}.png`, shot.bytes);
			}
		});
		// End UI polling before teardown, and join each browser's profile cleanup rather than
		// spending the shared gateway shutdown budget on two concurrent Windows removals.
		await h.callText('browser_close_session', { session_id: driver });
		await h.callText('browser_close_session', { session_id: 'default' });
	},
});
