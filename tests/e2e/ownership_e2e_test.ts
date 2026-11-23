/**
 * Per-principal session ownership, end to end, with real Chromium: three principals,
 * `TTK_SESSION_OWNERSHIP=owner`, and every surface a non-owner could use to reach a session — tools, resources,
 * completions, the SSE stream, the file route, a live ticket and the live-view upgrade itself. `default` is each
 * owner's own session, which the live view's `meta.sessionId` proves on a real socket. Admin reaches all.
 *
 * In the shipped SPA: the System screen's Session ownership capability reads "Per principal", and Bob's Live View of
 * alice's session ends on the first refused mint with one way back, its tool buttons idle, and no CSP report.
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

/** The Live View's overlay, its offers, the toolbar's tool buttons, the ticket mints and CSP reports. */
const VIEW_STATE = `(() => {
	const overlay = document.querySelector('.overlay');
	return {
		title: overlay?.querySelector('.overlay-title')?.textContent ?? null,
		detail: overlay?.querySelector('.overlay-detail')?.textContent ?? null,
		buttons: overlay === null ? [] : Array.from(overlay.querySelectorAll('button')).map((button) =>
			(button.getAttribute('aria-label') ?? button.textContent).trim()
		),
		record: document.querySelector('.lv-toolbar [aria-label="Record"]')?.disabled ?? null,
		mints: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/v1/live/ticket')).length,
		csp: globalThis.__cspReports ?? null,
	};
})()`;

Deno.test({
	name: 'e2e ownership: owner mode keeps each principal to its own sessions on every surface; admin reaches all',
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

			await t.step('the System screen shows Session ownership as Per principal', async () => {
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
				await wait('document.querySelectorAll(".sys-cap").length >= 14');
				const tiles = await evaluate<Record<string, string>>(
					`Object.fromEntries(Array.from(document.querySelectorAll('.sys-cap')).map((tile) =>
						[tile.dataset.name, tile.className + ' | ' + tile.textContent]))`,
				);
				assertStringIncludes(tiles['Session ownership'] ?? '', 'sys-cap on');
				assertStringIncludes(tiles['Session ownership'] ?? '', 'Per principal');
				for (
					const name of ['MCP Apps', 'Signed links', 'Confirmations', 'Human handoff', 'Secret provider', 'Git clone']
				) {
					assert(tiles[name] !== undefined, `${name} tile is present: ${JSON.stringify(tiles)}`);
				}
				await call(admin, 'browser_close_session', { session_id: driver });
			});

			await t.step(
				"bob's Live View of alice's session ends at once: one way back, no retry, tools idle, no CSP report",
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
						// Listening before the viewer's lazy chunk evaluates, which is where Zod would probe for eval.
						await evaluate(`globalThis.__cspReports = [];
							document.addEventListener('securitypolicyviolation', (event) =>
								globalThis.__cspReports.push(event.effectiveDirective + ' ' + event.blockedURI));
							performance.clearResourceTimings();
							location.hash = ${JSON.stringify(`#/view/${aliceDefault}`)};
							true`);
						await wait(`!!document.querySelector('.overlay .overlay-title')`);
						// Longer than the first three backoff steps (0.75 + 1.5 + 3 s): a retry loop would have minted again.
						await sleep(5_500);
						const state = await evaluate<{
							title: string | null;
							detail: string | null;
							buttons: string[];
							record: boolean | null;
							mints: number;
							csp: string[] | null;
						}>(VIEW_STATE);
						assertEquals(state.title, 'This session does not exist for this credential', JSON.stringify(state));
						assertEquals(state.buttons, ['Back to sessions'], 'one way back, no Reconnect');
						assertEquals(state.mints, 1, 'unknown-session on the mint is final: no retry loop');
						assertEquals(state.record, true, 'the tool buttons wait for meta');
						assert(!(state.detail ?? '').includes('alice'), 'nothing names the owner');
						assertEquals(state.csp, [], 'no CSP report on the first Live View');
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
