/**
 * R8 — per-principal session ownership, end to end (design §2.16, D-128, AC28), with real Chromium: three principals,
 * `TTK_SESSION_OWNERSHIP=owner`, and every surface a non-owner could use to reach a session — tools, resources,
 * completions, the SSE stream, the file route, a live ticket and the live-view upgrade itself. `default` is each
 * owner's own session, which the live view's `meta.sessionId` proves on a real socket. Admin reaches all.
 *
 * It also captures the System screen's capability strip (design §5 UI evidence): the session-ownership tile reads
 * "Per principal", OpenTelemetry reads off, and the tiles of features this build's other workstreams own read
 * "not reported" until their diagnostics keys exist — in dark and light, at 1280 px and 390 px. No glyph is painted twice
 * outside the dock except a row action's (FXD-N1, which supersedes RV-3's check of the new tiles), a dimmed glyph keeps
 * 3:1 (RV-4), the Allowed-domains fact carries its scope tag (D-138), and Tab onto a tile draws its ring and tooltip
 * (RV-13). The Tools screen's selected row keeps 4.5:1 in both themes (RV-15). Bob's Live View of alice's session ends
 * on the first refused mint with one way back and an idle inspector (RV-2), with no CSP report (K-5).
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createLogger, generateApiKey, loadConfig, startGateway } from '@tykotech/gateway';
import { CHROMIUM, LiveSocket, skipUnlessBrowser, textOf } from '../support/harness.ts';
import { startFixtureSite } from '../fixtures/site.ts';

const ignore = skipUnlessBrowser('ownership e2e');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The eight capability tiles design §5 added, by name. */
const NEW_TILES = [
	'Session ownership',
	'MCP Apps',
	'Signed links',
	'Confirmations',
	'Human handoff',
	'Secret provider',
	'OpenTelemetry',
	'Git clone',
];

/**
 * FXD-N1 (D-092 amended; supersedes the RV-3 check of the eight new tiles): every sprite glyph painted on the screen
 * outside the dock — the content area and the context bar — by count, and which of them repeat. Copy buttons and the
 * overlay's Remove buttons are row actions, the only glyphs allowed to repeat, and only on such a button. A closed
 * overlay (the account popover's scope chips) and a transient toast or tooltip are not part of the screen.
 */
const PAINTED_GLYPHS = `(() => {
	const glyphOf = (use) => (use.getAttribute('href') ?? '').split('#')[1];
	const painted = (use) => {
		const svg = use.closest('svg');
		const box = svg?.getBoundingClientRect();
		return box !== undefined && box.width > 0 && box.height > 0 && getComputedStyle(svg).visibility !== 'hidden';
	};
	const uses = Array.from(document.querySelectorAll('use'))
		.filter((use) => use.closest('.dock, .toast-stack, wa-tooltip, wa-popover') === null && painted(use));
	const counts = {};
	for (const use of uses) counts[glyphOf(use)] = (counts[glyphOf(use)] ?? 0) + 1;
	const rowAction = (use) => {
		const label = use.closest('button')?.getAttribute('aria-label') ?? '';
		// D-152: a list's per-row actions — Edit, Make … the default, Remove — repeat once per row, like Copy.
		return (glyphOf(use) === 'copy' && label.startsWith('Copy')) ||
			(glyphOf(use) === 'x' && label.startsWith('Remove ')) ||
			(glyphOf(use) === 'trash' && label.startsWith('Remove ')) ||
			(glyphOf(use) === 'edit' && label.startsWith('Edit ')) ||
			(glyphOf(use) === 'check' && label.startsWith('Make ') && label.endsWith(' the default'));
	};
	return {
		counts,
		repeated: Object.entries(counts).filter(([glyph, count]) =>
			count > 1 && !uses.filter((use) => glyphOf(use) === glyph).every(rowAction)
		).map(([glyph, count]) => glyph + ' x' + count),
		tiles: Object.fromEntries(Array.from(document.querySelectorAll('.sys-cap')).map((tile) =>
			[tile.getAttribute('data-tip').split(' · ')[0], glyphOf(tile.querySelector('.sys-cap-glyph use'))]
		)),
	};
})()`;

/**
 * RV-15: the selected tool row's title against what is painted behind it, composited up the ancestors to the first
 * opaque background (WCAG ratio). Colours are read back through a 1 px canvas as sRGB with alpha.
 */
const SELECTED_ROW_CONTRAST = `(() => {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	const rgba = (colour) => {
		context.clearRect(0, 0, 1, 1);
		context.fillStyle = '#000';
		context.fillStyle = colour;
		context.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = Array.from(context.getImageData(0, 0, 1, 1).data);
		return [r, g, b, a / 255];
	};
	const channel = (value) => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
	const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
	// D-152: the tool row is a leaf of the Resources tree; its selection tint is the tree item's shadow part.
	const title = document.querySelector('.rx-tree wa-tree-item.rx-tool[selected] > .rx-name');
	if (title === null) return null;
	const layers = [];
	const part = title.parentElement?.shadowRoot?.querySelector('[part~="item"]');
	if (part) {
		const tint = rgba(getComputedStyle(part).backgroundColor);
		if (tint[3] > 0) layers.push(tint);
	}
	for (let node = title; node !== null; node = node.parentElement) {
		const colour = rgba(getComputedStyle(node).backgroundColor);
		if (colour[3] > 0) layers.push(colour);
		if (colour[3] >= 1) break;
	}
	let bg = layers.length > 0 && layers[layers.length - 1][3] >= 1 ? layers.pop().slice(0, 3) : rgba(getComputedStyle(document.body).backgroundColor).slice(0, 3);
	for (const layer of layers.reverse()) bg = bg.map((value, i) => layer[i] * layer[3] + value * (1 - layer[3]));
	const fg = rgba(getComputedStyle(title).color).slice(0, 3);
	const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
	return {
		name: title.textContent,
		fg: getComputedStyle(title).color,
		bg: 'rgb(' + bg.map(Math.round).join(',') + ')',
		ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100,
	};
})()`;

/**
 * RV-4: every off or unreported tile's glyph, composited as painted — its colour times the opacity of every ancestor,
 * over the tile's own opaque background — as a WCAG ratio. Colours are read back through a 1 px canvas as sRGB.
 */
const DIMMED_GLYPH_CONTRAST = `(() => {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	const rgb = (colour) => {
		context.clearRect(0, 0, 1, 1);
		context.fillStyle = '#000';
		context.fillStyle = colour;
		context.fillRect(0, 0, 1, 1);
		return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
	};
	const channel = (value) => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
	const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
	return Array.from(document.querySelectorAll('.sys-cap.off:not(.warn), .sys-cap.unknown')).map((tile) => {
		const svg = tile.querySelector('.sys-cap-glyph svg');
		let alpha = 1;
		for (let node = svg; node !== null && node !== tile.parentElement; node = node.parentElement) {
			alpha *= Number(getComputedStyle(node).opacity);
		}
		const fg = rgb(getComputedStyle(svg).color);
		const bg = rgb(getComputedStyle(tile).backgroundColor);
		const painted = fg.map((value, i) => value * alpha + bg[i] * (1 - alpha));
		const [light, dark] = [luminance(painted), luminance(bg)].sort((a, b) => b - a);
		return { name: tile.getAttribute('data-tip'), ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100 };
	});
})()`;

/** RV-2, K-5: the Live View's overlay, its offers, the inspector's actions, the ticket mints and CSP reports. */
const VIEW_STATE = `(() => {
	const overlay = document.querySelector('.overlay');
	return {
		title: overlay?.querySelector('.overlay-title')?.textContent ?? null,
		detail: overlay?.querySelector('.overlay-detail')?.textContent ?? null,
		buttons: overlay === null ? [] : Array.from(overlay.querySelectorAll('button')).map((button) =>
			(button.getAttribute('aria-label') ?? button.textContent).trim()
		),
		actions: Array.from(document.querySelectorAll('.insp-act')).map((button) => button.disabled),
		capture: document.querySelector('.lv-toolbar [aria-label="Screenshot"]')?.disabled ?? null,
		mints: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/v1/live/ticket')).length,
		csp: globalThis.__cspReports ?? null,
	};
})()`;

Deno.test({
	name: 'e2e R8: owner mode keeps each principal to its own sessions on every surface; admin reaches all',
	ignore,
	async fn(t) {
		const alice = await generateApiKey('alice', ['mcp:invoke', 'view:watch', 'view:control']);
		const bob = await generateApiKey('bob', ['mcp:invoke', 'view:watch', 'view:control']);
		const root = await generateApiKey('root', ['mcp:invoke', 'view:watch', 'view:control', 'admin', 'evaluate']);
		const site = startFixtureSite();
		const config = loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: '0',
			TTK_API_KEYS: JSON.stringify([alice.record, bob.record, root.record]),
			TTK_LOG_LEVEL: 'error',
			TTK_BROWSER_PATH: CHROMIUM ?? '',
			TTK_HEADLESS: 'true',
			TTK_RATE_RPM: '100000',
			TTK_MAX_SESSIONS: '4',
			TTK_SESSION_OWNERSHIP: 'owner',
		});
		const gateway = await startGateway({
			config,
			version: '0.1.0-e2e',
			logger: createLogger({ level: 'error', write: () => {} }),
		});
		const clients: Client[] = [];
		const sockets: LiveSocket[] = [];
		const connect = async (bearer: string): Promise<Client> => {
			const client = new Client({ name: 'ttk-e2e-owner', version: '0' }, { versionNegotiation: { mode: 'auto' } });
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
					fetch: (input, init) => {
						const headers = new Headers(init?.headers);
						headers.set('Authorization', `Bearer ${bearer}`);
						return fetch(input, { ...init, headers });
					},
				}),
			);
			clients.push(client);
			return client;
		};
		const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
			await client.callTool({ name, arguments: args }) as CallToolResult;
		const json = async <T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> => {
			const result = await call(client, name, args);
			assert(result.isError !== true, `${name}: ${textOf(result)}`);
			return JSON.parse(textOf(result)) as T;
		};
		const http = (bearer: string, path: string, init: RequestInit = {}) => {
			const headers = new Headers(init.headers);
			headers.set('authorization', `Bearer ${bearer}`);
			return fetch(`${gateway.url}${path}`, { ...init, headers });
		};
		const live = async (bearer: string, sessionId: string): Promise<LiveSocket> => {
			const minted = await http(bearer, '/api/v1/live/ticket', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ session_id: sessionId }),
			});
			const body = await minted.json() as { ticket: string };
			assertEquals(minted.status, 201, JSON.stringify(body));
			const socket = new LiveSocket(`${gateway.url.replace(/^http/, 'ws')}/live/${sessionId}/ws?ticket=${body.ticket}`);
			sockets.push(socket);
			return socket;
		};

		try {
			const a = await connect(alice.key);
			const b = await connect(bob.key);
			const admin = await connect(root.key);

			const aliceDefault = (await json<{ session_id: string }>(a, 'browser_navigate', { url: site.page('index') }))
				.session_id;
			const bobDefault = (await json<{ session_id: string }>(b, 'browser_navigate', { url: site.page('second') }))
				.session_id;

			await t.step('`default` is each owner’s own session', () => {
				assert(aliceDefault.startsWith('default-'), aliceDefault);
				assert(bobDefault.startsWith('default-'), bobDefault);
				assertNotEquals(aliceDefault, bobDefault);
			});

			await t.step("bob's tools never reach alice's session; his list holds only his own", async () => {
				for (const tool of ['browser_get_state', 'browser_screenshot', 'browser_get_session', 'browser_list_files']) {
					const result = await call(b, tool, { session_id: aliceDefault });
					assertEquals(result.isError, true, tool);
					assertStringIncludes(textOf(result), 'unknown-session', tool);
				}
				const closed = await call(b, 'browser_close_session', { session_id: aliceDefault });
				assertStringIncludes(textOf(closed), 'unknown-session');
				const listed = await json<{ sessions: Array<{ session_id: string }> }>(b, 'browser_list_sessions');
				assertEquals(listed.sessions.map((s) => s.session_id), [bobDefault]);
				// Alice's own read of her default still works, by alias and by id.
				const state = await call(a, 'browser_get_state', {});
				assert(state.isError !== true, textOf(state));
				assert(gateway.registry.peek(aliceDefault) !== undefined, "bob's close did not close alice's session");
			});

			await t.step("bob's resources and completions carry none of alice's ids", async () => {
				const resources = (await b.listResources()).resources.map((resource) => resource.uri);
				assert(resources.some((uri) => uri.includes(bobDefault)), resources.join(','));
				assert(!resources.some((uri) => uri.includes(aliceDefault)), resources.join(','));
				await assertRejects(() => b.readResource({ uri: `ttk://session/${aliceDefault}/state` }));
				const completed = await b.complete({
					ref: { type: 'ref/resource', uri: 'ttk://session/{sessionId}/{kind}' },
					argument: { name: 'sessionId', value: '' },
				});
				assertEquals(completed.completion.values, [bobDefault]);
			});

			await t.step("bob's SSE stream, file route and live ticket for alice's session are unknown", async () => {
				for (const path of [`/api/v1/sessions/${aliceDefault}/events`, `/api/v1/sessions/${aliceDefault}/files/x`]) {
					const response = await http(bob.key, path);
					assertEquals(response.status, 404, path);
					assertStringIncludes(await response.text(), 'unknown-session');
				}
				const ticket = await http(bob.key, '/api/v1/live/ticket', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ session_id: aliceDefault }),
				});
				assertEquals(ticket.status, 404);
				assertStringIncludes(await ticket.text(), 'unknown-session');
			});

			await t.step("a live ticket for `default` opens the redeemer's own default on the real socket", async () => {
				const aliceSocket = await live(alice.key, 'default');
				assertEquals((await aliceSocket.ready()).sessionId, aliceDefault);
				const bobSocket = await live(bob.key, 'default');
				assertEquals((await bobSocket.ready()).sessionId, bobDefault);
				const frame = await aliceSocket.waitForFrames(1);
				assert(frame.jpeg.length > 0, 'frames flow to the owner');
				await aliceSocket.close();
				await bobSocket.close();
			});

			await t.step('admin reaches every session and is told the mode', async () => {
				const listed = await json<{ sessions: Array<{ session_id: string }> }>(admin, 'browser_list_sessions');
				assertEquals(listed.sessions.map((s) => s.session_id).sort(), [aliceDefault, bobDefault].sort());
				const state = await call(admin, 'browser_get_state', { session_id: aliceDefault });
				assert(state.isError !== true, textOf(state));
				const capabilities = await admin.readResource({ uri: 'ttk://capabilities' });
				const block = JSON.parse(String((capabilities.contents[0] as { text: string }).text)) as {
					sessions?: { ownership?: string };
				};
				assertEquals(block.sessions?.ownership, 'owner');
				const rest = await http(root.key, '/api/v1/sessions');
				const ids = ((await rest.json()) as { sessions: Array<{ session_id: string }> }).sessions.map((s) =>
					s.session_id
				);
				assertEquals(ids.sort(), [aliceDefault, bobDefault].sort());
			});

			await t.step('the System screen shows the ownership and telemetry tiles, dark and light; Tools row', async () => {
				const driver = (await json<{ session_id: string }>(admin, 'browser_navigate', {
					url: `${gateway.url}/`,
					new_session: true,
				})).session_id;
				const evaluate = async <T>(expression: string): Promise<T> => {
					const result = (await call(admin, 'browser_evaluate', { session_id: driver, expression }))
						.structuredContent as { ok: boolean; value: T };
					assert(result.ok, expression);
					return result.value;
				};
				const wait = async (expression: string): Promise<void> => {
					const until = Date.now() + 20_000;
					while (Date.now() < until) {
						if (await evaluate<boolean>(expression)) return;
						await new Promise((resolve) => setTimeout(resolve, 200));
					}
					throw new Error(`UI did not satisfy ${expression}`);
				};
				await wait('!!document.getElementById("username")');
				await evaluate(
					`document.getElementById('username').value=${
						JSON.stringify(root.key)
					}; document.querySelector('button').click(); true`,
				);
				await wait('location.hash === "#/sessions"');
				await evaluate(
					`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='System').click(); true`,
				);
				await wait('document.querySelectorAll(".sys-cap").length >= 17');
				const tiles = await evaluate<Record<string, string>>(
					`Object.fromEntries(Array.from(document.querySelectorAll('.sys-cap')).map((tile) =>
						[tile.getAttribute('data-tip').split(' · ')[0], tile.className + ' | ' + tile.getAttribute('data-tip')]))`,
				);
				assertStringIncludes(tiles['Session ownership'] ?? '', 'sys-cap on');
				assertStringIncludes(tiles['Session ownership'] ?? '', 'Per principal');
				assertStringIncludes(tiles['OpenTelemetry'] ?? '', 'sys-cap off');
				for (
					const name of ['MCP Apps', 'Signed links', 'Confirmations', 'Human handoff', 'Secret provider', 'Git clone']
				) {
					assert(tiles[name] !== undefined, `${name} tile is present: ${JSON.stringify(tiles)}`);
				}
				const glyphs = await evaluate<number>(`document.querySelectorAll('.sys-cap svg use').length`);
				assert(glyphs >= 17, `every tile draws its glyph from the sprite (${glyphs})`);
				// FXD-N1 (D-092 amended): no glyph painted twice outside the dock — the strip, every panel and the context
				// bar with its page tabs — except a row action's (copy, Remove). D-149: the screen is three tabs, and the
				// rule holds on each; the MCP tab is checked once its tool access and origins have loaded.
				type Painted = { counts: Record<string, number>; repeated: string[]; tiles: Record<string, string> };
				await wait(`!!document.querySelector('.sys-network-panel') && !!document.querySelector('.sys-process-panel')`);
				const painted = await evaluate<Painted>(PAINTED_GLYPHS);
				assertEquals(NEW_TILES.filter((name) => painted.tiles[name] === undefined), [], JSON.stringify(painted));
				assertEquals(painted.repeated, [], JSON.stringify(painted.counts));
				// The capability tiles' on/off marks are drawn by the stylesheet, not the sprite.
				assertEquals(painted.counts['circle-check'] ?? 0, 0, JSON.stringify(painted.counts));
				assertEquals(painted.counts['circle-dashed'] ?? 0, 0, JSON.stringify(painted.counts));
				// D-149: an empty domain allowlist reads "Any site" with no scope tag (D-138's tag qualifies an allowlist
				// only). D-137: with telemetry off and no collectors listed there is no collectors fact (the tile says off).
				// D-147: a fact's name is its visible key, no longer only its tooltip.
				const network = await evaluate<{ reach: string | null; scope: string | null; collectors: boolean }>(`(() => {
					const reach = Array.from(document.querySelectorAll('.sys-fact')).find((fact) =>
						fact.querySelector('.sys-fact-key')?.textContent === 'Browser reach');
					return {
						reach: reach?.querySelector('.sys-entry')?.textContent ?? null,
						scope: reach?.querySelector('.sys-entry-extra')?.textContent ?? null,
						collectors: Array.from(document.querySelectorAll('.sys-fact')).some((fact) =>
							fact.querySelector('.sys-fact-key')?.textContent === 'Telemetry collectors'),
					};
				})()`);
				assertEquals(network, { reach: 'Any site', scope: null, collectors: false });
				for (
					const [route, ready] of [
						['#/system/mcp', `!!document.querySelector('.sys-chips') && !!document.querySelector('.sys-origins')`],
						// D-152: the Agents tab, once its providers panel and its side panels have answered.
						[
							'#/system/agents',
							`!!document.querySelector('.pv-status, .sys-providers .empty') && !!document.querySelector('.pv-fact')`,
						],
						['#/system/config', `document.querySelectorAll('.sys-config-card').length > 3`],
					] as const
				) {
					await evaluate(`location.hash = '${route}'; true`);
					await wait(ready);
					const tab = await evaluate<Painted>(PAINTED_GLYPHS);
					assertEquals(tab.repeated, [], `${route}: ${JSON.stringify(tab.counts)}`);
				}
				await evaluate(`location.hash = '#/system'; true`);
				await wait('document.querySelectorAll(".sys-cap").length >= 17');
				// RV-13: a tile is a tab stop; Tab onto it draws the focus ring and opens its tooltip.
				await evaluate(`document.querySelector('.sys-caps .sys-cap').focus(); true`);
				await call(admin, 'browser_press_key', { session_id: driver, key: 'Tab' });
				await sleep(500);
				const focused = await evaluate<{ tip: string | null; visible: boolean; ring: string; tooltip: string | null }>(
					`(() => {
						const tile = document.activeElement;
						const tooltip = document.querySelector('wa-tooltip.ttk-tip');
						return {
							tip: tile?.classList.contains('sys-cap') ? tile.getAttribute('data-tip') : null,
							visible: tile?.matches(':focus-visible') ?? false,
							ring: tile === null ? '' : getComputedStyle(tile).outlineStyle + ' ' + getComputedStyle(tile).outlineWidth,
							// Painted, not only \`open\`: the kit's popup must be active with a box under the tile.
							tooltip: tooltip?.open === true &&
									(tooltip.shadowRoot?.querySelector('[part~="body"]')?.getBoundingClientRect().width ?? 0) > 0
								? tooltip.textContent
								: null,
						};
					})()`,
				);
				assert(focused.tip !== null, `Tab lands on the next capability tile: ${JSON.stringify(focused)}`);
				assert(focused.visible, `the tile matches :focus-visible: ${JSON.stringify(focused)}`);
				assertEquals(focused.ring, 'solid 2px', 'a 2 px focus ring');
				assertEquals(focused.tooltip, focused.tip, 'keyboard focus shows the tile tooltip');
				await evaluate(`document.activeElement?.blur(); true`);
				await Deno.mkdir('tests/.scratch', { recursive: true });
				for (const theme of ['dark', 'light'] as const) {
					await evaluate(
						`localStorage.setItem('ttk.theme', '${theme}'); document.documentElement.classList.toggle('wa-dark', ${
							theme === 'dark'
						}); document.documentElement.classList.toggle('wa-light', ${
							theme === 'light'
						}); document.documentElement.dataset.theme='${theme}'; true`,
					);
					// RV-4: a dimmed glyph (off, or not reported) still reads at 3:1 against its tile (WCAG 1.4.11).
					await new Promise((resolve) => setTimeout(resolve, 400));
					const dimmed = await evaluate<Array<{ name: string; ratio: number }>>(DIMMED_GLYPH_CONTRAST);
					assert(dimmed.length > 0, `${theme}: some tile is off or unreported`);
					const faint = dimmed.filter(({ ratio }) => ratio < 3);
					assertEquals(faint, [], `${theme}: dimmed glyphs under 3:1`);
					for (const width of [1280, 390]) {
						await call(admin, 'browser_set_viewport', { session_id: driver, width, height: 900 });
						await evaluate(`document.querySelector('.sys-caps').scrollIntoView(); true`);
						const shot = await call(admin, 'browser_screenshot', { session_id: driver });
						const image = (shot.content as Array<{ type: string; data?: string }>).find((block) =>
							block.type === 'image'
						);
						assert(image?.data !== undefined, 'a screenshot of the strip');
						await Deno.writeFile(
							`tests/.scratch/w5-system-${theme}-${width}.png`,
							Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0)),
						);
						// The painted check agrees at every width and theme (the bar's theme glyph swaps sun and moon).
						const again = await evaluate<Painted>(PAINTED_GLYPHS);
						assertEquals(again.repeated, [], `${theme} ${width}: ${JSON.stringify(again.counts)}`);
					}
				}
				const overflow = await evaluate<boolean>(
					`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`,
				);
				assert(overflow, 'no horizontal scroll at 390 px');

				// RV-15: the Tools screen's selected row keeps 4.5:1 for its title in both themes (light was 3.63:1).
				await call(admin, 'browser_set_viewport', { session_id: driver, width: 1280, height: 900 });
				// D-152: the Tools screen is the Resources tree's tool leaves; a tool route selects its leaf.
				await evaluate(`location.hash = '#/resources/tools/browser_navigate'; true`);
				await wait(`!!document.querySelector('.rx-tree wa-tree-item.rx-tool[selected] > .rx-name')`);
				for (const theme of ['dark', 'light'] as const) {
					await evaluate(
						`document.documentElement.classList.toggle('wa-dark', ${
							theme === 'dark'
						}); document.documentElement.classList.toggle('wa-light', ${theme === 'light'}); true`,
					);
					await sleep(400);
					const row = await evaluate<{ name: string; fg: string; bg: string; ratio: number } | null>(
						SELECTED_ROW_CONTRAST,
					);
					assert(row !== null, 'a selected row');
					assert(row.ratio >= 4.5, `${theme}: the selected row's title is ${row.ratio}:1 (${JSON.stringify(row)})`);
				}
				await call(admin, 'browser_close_session', { session_id: driver });
			});

			await t.step(
				"bob's Live View of alice's session ends at once: one way back, no retry, inspector idle, no CSP report",
				async () => {
					// A browser of its own, signed in to the control plane as bob (the cookie lives in that browser).
					const driver = (await json<{ session_id: string }>(admin, 'browser_navigate', {
						url: `${gateway.url}/`,
						new_session: true,
					})).session_id;
					const evaluate = async <T>(expression: string): Promise<T> => {
						const result = (await call(admin, 'browser_evaluate', { session_id: driver, expression }))
							.structuredContent as { ok: boolean; value: T };
						assert(result.ok, expression);
						return result.value;
					};
					const wait = async (expression: string): Promise<void> => {
						const until = Date.now() + 20_000;
						while (Date.now() < until) {
							if (await evaluate<boolean>(expression)) return;
							await sleep(200);
						}
						throw new Error(`UI did not satisfy ${expression}`);
					};
					try {
						await wait('!!document.getElementById("username")');
						await evaluate(
							`document.getElementById('username').value=${
								JSON.stringify(bob.key)
							}; document.querySelector('button').click(); true`,
						);
						await wait('location.hash === "#/sessions"');
						// Listening before the viewer's lazy chunk evaluates, which is where Zod would probe for eval (K-5).
						await evaluate(`globalThis.__cspReports = [];
							document.addEventListener('securitypolicyviolation', (event) =>
								globalThis.__cspReports.push(event.effectiveDirective + ' ' + event.blockedURI));
							performance.clearResourceTimings();
							location.hash = ${JSON.stringify(`#/view/${aliceDefault}`)};
							true`);
						await wait(`!!document.querySelector('.overlay .overlay-title')`);
						await wait(`document.querySelectorAll('.insp-act').length > 0`);
						// Longer than the first three backoff steps (0.75 + 1.5 + 3 s): a retry loop would have minted again.
						await sleep(5_500);
						const state = await evaluate<{
							title: string | null;
							detail: string | null;
							buttons: string[];
							actions: boolean[];
							capture: boolean | null;
							mints: number;
							csp: string[] | null;
						}>(VIEW_STATE);
						assertEquals(state.title, 'This session does not exist for this credential', JSON.stringify(state));
						assertEquals(state.buttons, ['Back to sessions'], 'one way back, no Reconnect');
						assertEquals(state.mints, 1, 'unknown-session on the mint is final: no retry loop');
						assert(state.actions.every((disabled) => disabled), `inspector actions wait for meta: ${state.actions}`);
						assertEquals(state.capture, true, 'the toolbar screenshot waits for meta too');
						assert(!(state.detail ?? '').includes('alice'), 'nothing names the owner');
						assertEquals(state.csp, [], 'no CSP report on the first Live View (K-5)');
						await evaluate(
							`Array.from(document.querySelectorAll('.overlay button')).find((b) => b.textContent.includes('Back to sessions')).click(); true`,
						);
						await wait('location.hash === "#/sessions"');
					} finally {
						await call(admin, 'browser_close_session', { session_id: driver });
					}
				},
			);
		} finally {
			for (const socket of sockets) await socket.close();
			for (const client of clients) await client.close().catch(() => {});
			await gateway.shutdown();
			await gateway.finished;
			await site.close();
		}
	},
});
