/**
 * R4 on real Chromium (D-116): `browser_network_log`, `browser_console_log` and `browser_har_export` against a page
 * that makes real requests, logs to its console and sets a cookie — AC5's browser half, AC6's browser half, and AC2's
 * shape on the browser tier (a refused `location =` ends in the M12 error text in the log, the tab still on-list).
 *
 * The credential holds `network:read`, so every gated field is exercised; the refusals without it are proven at the
 * unit tier (`inspection_test.ts`). Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('network log e2e');

/** Typed into the page by name only; only unreserved characters, so URL encoding leaves it as written. */
const SECRET = 'Zq8-W1-NETSECRET-3vP';
const COOKIE = 'Zq8-W1-COOKIE-3vP';

const html = (body: string): Response =>
	new Response(
		`<!doctype html><html><head><meta charset="utf-8"><title>net</title></head><body>${body}</body></html>`,
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'set-cookie': `sid=${COOKIE}; Path=/`,
			},
		},
	);

function servers(): { readonly a: string; readonly off: string; readonly offHits: string[]; close(): Promise<void> } {
	const offHits: string[] = [];
	const off = Deno.serve({ hostname: 'localhost', port: 0, onListen: () => {} }, (request) => {
		offHits.push(new URL(request.url).pathname);
		return new Response('off');
	});
	const a = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		const url = new URL(request.url);
		if (url.pathname === '/echo') {
			return Response.json({ echoed: url.searchParams.get('v') ?? '' }, {
				headers: { 'x-reflect': url.searchParams.get('v') ?? '', 'cache-control': 'no-store' },
			});
		}
		const to = url.searchParams.get('to') ?? '';
		return html(
			'<input id="field" type="text" placeholder="field">' +
				'<button id="send" type="button">send</button>' +
				'<button id="leave" type="button">leave</button>' +
				"<script>const f=document.getElementById('field');" +
				"document.getElementById('send').addEventListener('click',()=>{" +
				"console.log('typed:'+f.value);console.warn('second line');" +
				"fetch('/echo?v='+encodeURIComponent(f.value),{headers:{'x-echo':f.value}}).then((r)=>r.text());});" +
				`document.getElementById('leave').addEventListener('click',()=>{location.href=${JSON.stringify(to)};});` +
				'</script>',
		);
	});
	return {
		a: `http://127.0.0.1:${(a.addr as Deno.NetAddr).port}`,
		off: `http://localhost:${(off.addr as Deno.NetAddr).port}`,
		offHits,
		async close() {
			await a.shutdown();
			await off.shutdown();
		},
	};
}

async function structured<T>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<T> {
	const result = await h.call(name, args);
	assert(result.isError !== true, `${name} failed: ${JSON.stringify(result.content)}`);
	return result.structuredContent as T;
}

async function indexOf(h: Harness, id: string): Promise<{ index: number; token: string | null }> {
	const state = await structured<{
		state_token: string | null;
		interactive_elements: Array<{ index: number; attrs?: Record<string, string> }>;
	}>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
	const element = state.interactive_elements.find((entry) => entry.attrs?.id === id);
	assert(element !== undefined, `#${id}`);
	return { index: element.index, token: state.state_token };
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

interface Entry {
	request_id: string;
	method: string;
	origin: string;
	path: string;
	url?: string;
	resource_type: string;
	status: number | null;
	duration_ms: number | null;
	failed: boolean;
	error_text: string | null;
	request_headers?: Record<string, string>;
	response_headers?: Record<string, string>;
}

Deno.test({
	name: 'e2e network log (AC2, AC5, AC6): requests, console and HAR from a real page, secrets never leaving',
	ignore,
	async fn(t) {
		const s = servers();
		try {
			await using h = await harness({
				scopes: ['mcp:invoke', 'view:watch', 'view:control', 'network:read'],
				env: {
					TTK_ALLOWED_DOMAINS: '127.0.0.1',
					TTK_SECRETS: JSON.stringify({ site_password: { value: SECRET, domains: ['http://127.0.0.1'] } }),
				},
			});
			await h.callText('browser_navigate', { url: `${s.a}/page?to=${encodeURIComponent(`${s.off}/away?k=1`)}` });

			await t.step('the document request is logged with its status, and the cookie never is', async () => {
				const log = await structured<{ entries: Entry[]; next_since: number; dropped: number }>(
					h,
					'browser_network_log',
					{ include_headers: true },
				);
				const page = log.entries.find((entry) => entry.resource_type === 'Document' && entry.path === '/page');
				assert(page !== undefined, JSON.stringify(log.entries));
				assertEquals(page.status, 200);
				assertEquals(page.origin, s.a);
				assertEquals(page.url, undefined, 'no url field unless asked for');
				assert(!JSON.stringify(log).includes(COOKIE), 'a cookie value reached the caller');
				assertEquals(log.dropped, 0);
			});

			await t.step('console capture is claimed by the tool and reports its own coverage boundary', async () => {
				const first = await structured<{ armed_since: string; entries: unknown[]; next_cursor: string }>(
					h,
					'browser_console_log',
				);
				assert(!Number.isNaN(Date.parse(first.armed_since)), first.armed_since);
				const field = await indexOf(h, 'field');
				await h.callText('browser_type', {
					index: field.index,
					text: '<secret>site_password</secret>',
					state_token: field.token,
				});
				const send = await indexOf(h, 'send');
				await h.callText('browser_click', { index: send.index });
				const lines = await until('the console lines', async () => {
					const page = await structured<{ entries: Array<{ level: string; text: string }> }>(
						h,
						'browser_console_log',
						{ since: first.next_cursor },
					);
					return page.entries.length >= 2 ? page.entries : undefined;
				});
				console.log(`[AC5] console: ${JSON.stringify(lines)}`);
				assertEquals(lines.map((line) => line.level), ['log', 'warn']);
				assertEquals(lines[0]?.text, 'typed:[secret]', 'AC6: the typed secret is redacted on the way out');
			});

			await t.step('AC6: the echo request, its headers and its body carry [secret], never the value', async () => {
				const echo = await until('the echo request', async () => {
					const log = await structured<{ entries: Entry[] }>(h, 'browser_network_log', {
						include_headers: true,
						include_full_urls: true,
						resource_types: ['Fetch'],
					});
					// Finished, not merely answered: the browser hands out a body only once it has all of it.
					return log.entries.find((entry) =>
						entry.path === '/echo' && entry.status === 200 && entry.duration_ms !== null
					);
				});
				const withBody = await h.call('browser_network_log', {
					include_headers: true,
					include_full_urls: true,
					body_for: echo.request_id,
				});
				const text = JSON.stringify(withBody);
				console.log(`[AC6] echo entry: ${JSON.stringify(echo)}`);
				assert(!text.includes(SECRET), `the secret left through the network log: ${text.slice(0, 400)}`);
				assertStringIncludes(echo.url ?? '', '[secret]');
				assertEquals(echo.request_headers?.['x-echo'], '[secret]');
				assert(withBody.isError !== true, JSON.stringify(withBody.content));
				const body = (withBody.structuredContent as { body: { text: string } }).body;
				assertStringIncludes(body.text, '[secret]');

				const har = await h.call('browser_har_export', { include_full_urls: true });
				assert(!JSON.stringify(har).includes(SECRET), 'the secret left through the HAR');
				const console_ = await h.call('browser_console_log', {});
				assert(!JSON.stringify(console_).includes(SECRET), 'the secret left through the console log');
			});

			await t.step('AC5: the HAR is 1.2, at most 1 MiB, cookie-free, and names this server', async () => {
				const result = await h.call('browser_har_export', {});
				assert(result.isError !== true, JSON.stringify(result.content));
				const payload = result.structuredContent as { entries: number; bytes: number; truncated: boolean };
				const block = (result.content as Array<{ type: string; resource?: { mimeType: string; text: string } }>)
					.find((entry) => entry.type === 'resource');
				assertEquals(block?.resource?.mimeType, 'application/json');
				const har = JSON.parse(block?.resource?.text ?? '{}') as {
					log: {
						version: string;
						creator: { name: string };
						entries: Array<{
							request: { url: string; cookies: unknown[]; queryString: unknown[] };
							response: { cookies: unknown[] };
						}>;
					};
				};
				assertEquals(har.log.version, '1.2');
				assertEquals(har.log.creator.name, 'tykotech-mcp');
				assertEquals(har.log.entries.length, payload.entries);
				assert(payload.bytes <= 1_048_576);
				for (const entry of har.log.entries) {
					assertEquals(entry.request.cookies, []);
					assertEquals(entry.response.cookies, []);
					assertEquals(entry.request.queryString, [], 'no query without include_full_urls');
					assert(!entry.request.url.includes('?'), entry.request.url);
				}
				assert(!JSON.stringify(har).includes(COOKIE));
			});

			await t.step(
				'AC2 (browser tier): a refused location= ends in the M12 error text, the tab still on-list',
				async () => {
					const leave = await indexOf(h, 'leave');
					await h.call('browser_click', { index: leave.index });
					const refused = await until('the refused document in the log', async () => {
						const log = await structured<{ entries: Entry[] }>(h, 'browser_network_log', { failed_only: true });
						return log.entries.find((entry) => entry.origin === s.off);
					});
					console.log(`[AC2] refused entry: ${JSON.stringify(refused)}`);
					assertEquals(refused.error_text, 'net::ERR_ABORTED');
					assertEquals(refused.resource_type, 'Document');
					assertEquals(s.offHits, [], 'the off-list host received nothing');
					const state = await structured<{ url: string }>(h, 'browser_get_state', {});
					assert(state.url.startsWith(s.a), state.url);
				},
			);
		} finally {
			await s.close();
		}
	},
});
