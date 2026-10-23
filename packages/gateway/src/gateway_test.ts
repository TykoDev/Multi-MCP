/**
 * Gateway end-to-end tests: the auth matrix, guards, and a real MCP client
 * round-trip. The browser is faked so these stay in the unit tier.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { generateApiKey } from './auth.ts';
import { type Config, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { type RunningGateway, startGateway } from './server.ts';

const KEY_ID = 'test-key';

/** A browser stand-in: only the surface the registry and tools touch. */
function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

interface Fixture {
	gateway: RunningGateway;
	url: string;
	key: string;
	adminKey: string;
	[Symbol.asyncDispose](): Promise<void>;
}

async function fixture(overrides: Partial<Record<string, string>> = {}): Promise<Fixture> {
	const scoped = await generateApiKey(KEY_ID, ['mcp:invoke', 'view:watch']);
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'view:control', 'admin']);

	const env: Record<string, string | undefined> = {
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0', // ephemeral
		TTK_API_KEYS: JSON.stringify([scoped.record, admin.record]),
		TTK_LOG_LEVEL: 'error',
		...overrides,
	};
	const config: Config = loadConfig(env);
	const gateway = await startGateway({
		config,
		version: '0.1.0-test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve(fakeSession()),
	});

	return {
		gateway,
		url: gateway.url,
		key: scoped.key,
		adminKey: admin.key,
		async [Symbol.asyncDispose]() {
			await gateway.shutdown();
			await gateway.finished;
		},
	};
}

function authed(token: string): typeof fetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set('Authorization', `Bearer ${token}`);
		return fetch(input, { ...init, headers });
	};
}

async function rpc(url: string, token: string | null, body: unknown): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (token !== null) headers.authorization = `Bearer ${token}`;
	return await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// --- health -----------------------------------------------------------------

Deno.test('gateway: /healthz is public and reports version and session count', async () => {
	await using f = await fixture();
	const response = await fetch(`${f.url}/healthz`);
	assertEquals(response.status, 200);
	const body = await response.json();
	assertEquals(body.status, 'ok');
	assertEquals(body.version, '0.1.0-test');
	assertEquals(body.sessions, 0);
	assert(response.headers.get('x-request-id') !== null, 'every response carries a request id');
});

Deno.test('gateway: /favicon.ico is public and empty, not an OAuth challenge (F6)', async () => {
	// The browser issues this on its own the moment the SPA loads. The catch-all
	// bearer gate used to answer it 401 with `WWW-Authenticate: Bearer`, which put
	// an auth error in the console of every single page load for a request the
	// page never made. D-052 widens the public set by this one path; the handler
	// reads no state and returns no body, which is what makes that safe.
	await using f = await fixture();
	const response = await fetch(`${f.url}/favicon.ico`);
	assertEquals(response.status, 204);
	assertEquals(response.headers.get('www-authenticate'), null, 'no challenge on a path the page never asked for');
	assertEquals(await response.text(), '');
});

Deno.test('gateway: the SPA is served with the anti-framing headers in force (F5)', async () => {
	// `static/index.html` has declared `frame-ancestors 'none'` in a meta tag
	// since 0.1.0 and browsers ignore it there, so the page holding a live
	// credential in memory was framable. The directive is only enforceable from a
	// response header. Asserted on the shipped route rather than on the file.
	await using f = await fixture();
	const response = await fetch(`${f.url}/`);
	await response.body?.cancel();
	// A checkout without `deno task build:web` still serves the shell; either way
	// the headers are the route's, not the bundle's.
	assert(response.status === 200 || response.status === 503, `unexpected ${response.status}`);
	assertEquals(response.headers.get('x-frame-options'), 'DENY');
	assertStringIncludes(response.headers.get('content-security-policy') ?? '', "frame-ancestors 'none'");
});

Deno.test('gateway: the SPA and its assets are revalidated, never reused blind (B6.3)', async () => {
	// The bundle filenames are not content-hashed, and `serveDir` sends ETag and
	// Last-Modified but no Cache-Control — so a browser applies heuristic caching
	// and a viewer who loaded the page before an upgrade keeps the old bundle.
	// Observed during B6's own container verification, where a stylesheet cached
	// from the previous image made the fix under test look broken. It matters most
	// for this release: a cached 0.1.0 bundle does not answer the keep-alive ping.
	// Both asset roots answer through the one `/assets/*` route: a hand-written file is always there, and the bundle's
	// stylesheet is checked whenever `deno task build:web` has run — `ok` and CI's unit job never build it, and a 404
	// carries no caching policy to assert.
	const built = await Deno.stat(new URL('../../web/dist/app.css', import.meta.url)).then(() => true, () => false);
	await using f = await fixture();
	for (const path of ['/', '/assets/brand/favicon-32.png', ...(built ? ['/assets/app.css'] : [])]) {
		const response = await fetch(`${f.url}${path}`);
		await response.body?.cancel();
		assertEquals(
			response.headers.get('cache-control'),
			'no-cache',
			`${path} must be revalidated rather than reused from cache`,
		);
	}
});

Deno.test('gateway: /healthz and capabilities.tykotech report the same version (SEC-16)', async () => {
	// **AC-SEC-19's second half.** `version` is the one member of the capability
	// block that is present for every principal, and the argument for that is
	// that it discloses nothing `/healthz` does not already serve with no
	// credential at all. That argument is only true while the two strings are the
	// same, so it is asserted rather than asserted-about: both sides are read
	// from the same running gateway in one test.
	await using f = await fixture();
	const health = await (await fetch(`${f.url}/healthz`)).json();

	const response = await rpc(f.url, f.key, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'gateway-test', version: '0' },
		},
	});
	const text = await response.text();
	const frame = text.includes('data:')
		? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '{}')
		: JSON.parse(text);
	const capabilities = (frame.result as { capabilities?: Record<string, unknown> })?.capabilities ?? {};
	assert(
		Object.hasOwn(capabilities, 'tykotech'),
		`the vendor capability block did not reach the gateway wire: ${JSON.stringify(capabilities)}`,
	);
	const block = capabilities.tykotech as { version: string; live_view?: { ticket_ttl_max_s: unknown } };
	assertEquals(block.version, health.version);

	// And this key holds `view:watch`, so the live-view ceilings are present and
	// are the ones the ticket clamp itself enforces — not a second copy.
	assertEquals(block.live_view?.ticket_ttl_max_s, { view: 300, control: 60 });
});

Deno.test('gateway: x-ratelimit-remaining is on an authenticated route and counts down (B3.2)', async () => {
	// §8 asks for the header "on the HTTP routes". The two things worth proving
	// are that it is actually there on a real response — a header set after
	// `next()` in a middleware is a place this could silently not happen — and
	// that it *moves*, because a constant would satisfy a presence assertion
	// while telling a client nothing.
	await using f = await fixture();
	const first = await fetch(`${f.url}/api/v1/sessions`, { headers: { authorization: `Bearer ${f.key}` } });
	await first.body?.cancel();
	const firstRemaining = first.headers.get('x-ratelimit-remaining');
	assert(firstRemaining !== null, 'an authenticated route carries the budget header');

	const second = await fetch(`${f.url}/api/v1/sessions`, { headers: { authorization: `Bearer ${f.key}` } });
	await second.body?.cancel();
	const secondRemaining = second.headers.get('x-ratelimit-remaining');
	assert(secondRemaining !== null);
	assert(
		Number(secondRemaining) < Number(firstRemaining),
		`the budget must fall as it is spent: ${firstRemaining} then ${secondRemaining}`,
	);

	// `/healthz` is public, so no principal exists and nothing is charged. A
	// header there would be a budget for a caller that has none.
	const health = await fetch(`${f.url}/healthz`);
	await health.body?.cancel();
	assertEquals(health.headers.get('x-ratelimit-remaining'), null);
});

// --- auth matrix ------------------------------------------------------------

Deno.test('gateway: /mcp without a credential is 401 with a bearer challenge', async () => {
	await using f = await fixture();
	const response = await rpc(f.url, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	await response.body?.cancel();
	assertEquals(response.status, 401);
	assertStringIncludes(response.headers.get('www-authenticate') ?? '', 'Bearer');
});

Deno.test('gateway: an invalid credential is 401, never 500', async () => {
	await using f = await fixture();
	const response = await rpc(f.url, 'ttk_not-a-real-key', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	await response.body?.cancel();
	// A verifier that threw a plain Error would surface here as a 500.
	assertEquals(response.status, 401);
});

Deno.test('gateway: admin routes require the admin scope', async () => {
	await using f = await fixture();

	const denied = await fetch(`${f.url}/api/v1/sessions`, { headers: { authorization: `Bearer ${f.key}` } });
	const problem = await denied.json();
	assertEquals(denied.status, 403);
	assertEquals(problem.type, 'https://tykotech.eu/problems/forbidden-scope');
	assert(typeof problem['x-request-id'] === 'string');

	const allowed = await fetch(`${f.url}/api/v1/sessions`, { headers: { authorization: `Bearer ${f.adminKey}` } });
	assertEquals(allowed.status, 200);
	assertEquals((await allowed.json()).sessions, []);
});

Deno.test('gateway: system diagnostics require the admin scope (D-070)', async () => {
	// The deployment posture — bind, public URL, allow-lists, key count, which
	// defences are disabled — was readable by any authenticated principal, while
	// the SPA told operators the route was admin-only.
	await using f = await fixture();

	const denied = await fetch(`${f.url}/api/v1/system/diagnostics`, { headers: { authorization: `Bearer ${f.key}` } });
	const problem = await denied.json();
	assertEquals(denied.status, 403);
	assertEquals(problem.type, 'https://tykotech.eu/problems/forbidden-scope');
	assertEquals(problem.config, undefined, 'a refusal carries no part of the posture');

	const unauthenticated = await fetch(`${f.url}/api/v1/system/diagnostics`);
	await unauthenticated.body?.cancel();
	assertEquals(unauthenticated.status, 401);

	const allowed = await fetch(`${f.url}/api/v1/system/diagnostics`, {
		headers: { authorization: `Bearer ${f.adminKey}` },
	});
	assertEquals(allowed.status, 200);
	assertEquals((await allowed.json()).status, 'ok');
});

Deno.test('gateway: an unauthenticated admin route is 401', async () => {
	await using f = await fixture();
	const response = await fetch(`${f.url}/api/v1/sessions`);
	await response.body?.cancel();
	assertEquals(response.status, 401);
});

// --- guards ------------------------------------------------------------------

Deno.test('gateway: a foreign Host header is refused (DNS rebinding guard)', async () => {
	await using f = await fixture();
	// `fetch` silently drops a caller-supplied Host (a forbidden header), so the
	// guard can only be exercised over a raw socket.
	const status = async (host: string): Promise<number> => {
		const conn = await Deno.connect({ hostname: '127.0.0.1', port: f.gateway.port });
		try {
			await conn.write(
				new TextEncoder().encode(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
			);
			const buffer = new Uint8Array(256);
			const read = await conn.read(buffer);
			const head = new TextDecoder().decode(buffer.subarray(0, read ?? 0));
			return Number(head.split(' ')[1] ?? 0);
		} finally {
			conn.close();
		}
	};

	assertEquals(await status(`127.0.0.1:${f.gateway.port}`), 200, 'the real host is accepted');
	assert((await status('evil.example.com')) >= 400, 'a foreign Host must be refused');
});

Deno.test('gateway: the declared public address is a Host the guard accepts (E-32)', async () => {
	// The bind stays on loopback so the test opens nothing on the LAN; the
	// allowlist does not depend on the bind being a wildcard, only on the
	// declaration. Before E-32 the Host list ignored TTK_PUBLIC_URL entirely,
	// so a container published to a LAN answered 403 "Invalid Host" to every
	// client that was not on the same machine — which a client reports as
	// connecting successfully and finding no tools.
	await using f = await fixture({ TTK_PUBLIC_URL: 'http://192.168.1.14:8787' });

	const status = async (host: string): Promise<number> => {
		const conn = await Deno.connect({ hostname: '127.0.0.1', port: f.gateway.port });
		try {
			await conn.write(
				new TextEncoder().encode(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
			);
			const buffer = new Uint8Array(256);
			const read = await conn.read(buffer);
			return Number(new TextDecoder().decode(buffer.subarray(0, read ?? 0)).split(' ')[1] ?? 0);
		} finally {
			conn.close();
		}
	};

	assertEquals(await status('192.168.1.14:8787'), 200, 'the declared address is accepted');
	// The match is port-agnostic (SDK validateHostHeader), so the port a client
	// happens to reach it on does not have to be the one that was declared.
	assertEquals(await status('192.168.1.14'), 200, 'and accepted without a port');
	assertEquals(await status(`127.0.0.1:${f.gateway.port}`), 200, 'loopback keeps working');
	// The guard is still a guard, and answers in the contract's shape (F3): 400 host-forbidden, with a request id.
	assertEquals(await status('evil.example.com'), 400, 'a foreign Host is still refused');
	// fetch() replaces a custom Host with the URL's, so the refusal is read off the same raw socket.
	const conn = await Deno.connect({ hostname: '127.0.0.1', port: f.gateway.port });
	try {
		await conn.write(
			new TextEncoder().encode('GET /healthz HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'),
		);
		const buffer = new Uint8Array(4096);
		const read = await conn.read(buffer);
		const raw = new TextDecoder().decode(buffer.subarray(0, read ?? 0)).toLowerCase();
		assert(raw.includes('content-type: application/problem+json'), raw);
		assert(raw.includes('x-request-id:'), raw);
		assert(raw.includes('problems/host-forbidden'), raw);
	} finally {
		conn.close();
	}
});

Deno.test('gateway: a browser Origin is refused by default', async () => {
	await using f = await fixture();
	const response = await rpc(f.url, f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	await response.body?.cancel();
	// Sanity: without an Origin the same call is accepted.
	assertEquals(response.status, 200);

	const withOrigin = await fetch(`${f.url}/mcp`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${f.key}`,
			origin: 'https://evil.example.com',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
	});
	await withOrigin.body?.cancel();
	assertEquals(withOrigin.status, 403, 'browser origins are denied unless allowlisted');
});

// --- MCP round-trip ----------------------------------------------------------

Deno.test('gateway: an MCP client lists the catalog over Streamable HTTP', async () => {
	await using f = await fixture();
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(f.adminKey) }),
	);
	try {
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name).sort();
		// 47 in the catalog, minus five the caller cannot use here: `browser_run_task`
		// (this key holds admin but not `task`), `browser_evaluate` (B2.7 — this key holds admin but
		// not `evaluate`, which is the whole point of EXPLICIT_SCOPES), `browser_storage_state` (this
		// fixture configures no data directory, so R5 disables it),
		// `browser_record` (no ffmpeg either) and `browser_head` (no outbound net
		// grant beyond loopback is provable here — the unit tier's own grant is
		// loopback, which is exactly the shipped shape; SR-HEAD-REDIRECT).
		//
		// **The five absences are asserted by name below and the count is kept as a
		// second, weaker check.** B3.2 stopped trusting counts alone here: this
		// number was stale in three other places in this delivery and each time it
		// hid a real change until a tier was run by hand.
		// mcp-recommendations: +3 inspection reads (W1) and +3 always-on browser outputs (W2: browser_pdf,
		// browser_accessibility_snapshot, browser_performance). D-150: +1, browser_request_human, whose
		// TTK_HUMAN_HANDOFF is now on by default. browser_file_link stays off (no data directory, so no signing key),
		// and the two MCP Apps tools need view:watch, which this key does not hold.
		assertEquals(names.length, 49, `expected the admin catalog, got ${names.join(',')}`);
		assertEquals(
			[
				'browser_evaluate',
				// W2: gated on TTK_SIGNED_LINKS, off in this fixture.
				'browser_file_link',
				'browser_head',
				'browser_record',
				'browser_run_task',
				'browser_storage_state',
			].filter((name) => names.includes(name)),
			[],
			`these tools must be absent for this principal on this deployment: ${names.join(',')}`,
		);
		assert(names.includes('browser_health'), 'B3.2 health tool');
		assert(
			names.includes('browser_pdf') && names.includes('browser_accessibility_snapshot') &&
				names.includes('browser_performance'),
			'W2 browser outputs (R10/R11)',
		);
		assert(!names.includes('browser_evaluate'), 'the evaluate scope is never held by an admin key by default');
		assert(names.includes('browser_fill_secret') && names.includes('browser_audit'), 'B2.8 tools');
		assert(names.includes('browser_element_at'), 'B2.1 hit-test tool');
		assert(
			names.includes('browser_hover') && names.includes('browser_double_click') &&
				names.includes('browser_right_click'),
			'B2.4 pointer tools',
		);
		assert(names.includes('browser_find') && names.includes('browser_verify_locator'), 'B1.6 perception tools');
		assert(names.includes('browser_wait_for'), 'B1.7 event-ring tool');
		assert(names.includes('browser_list_files') && names.includes('browser_get_file'), 'E-33 file tools');
		assert(names.includes('browser_download'), 'B1.12 download tool');
		assert(!names.includes('browser_head'), 'browser_head needs a proven outbound grant (SR-HEAD-REDIRECT)');
		assert(!names.includes('browser_run_task'), 'the task scope is separate from admin');
		assert(!names.includes('browser_storage_state'), 'persistence tools need a data directory');
		assert(names.includes('browser_navigate'));
		assert(
			names.includes('browser_network_log') && names.includes('browser_console_log') &&
				names.includes('browser_har_export'),
			'R4 inspection tools (D-116)',
		);
		assert(names.includes('browser_close_all'), 'an admin principal sees the admin tool');
	} finally {
		await client.close();
	}
});

Deno.test('gateway: a principal without admin never sees browser_close_all', async () => {
	// D-150: MCP Apps is on by default only where `build:web` left its embeds, which the unit tier does not run, and
	// this key holds view:watch — so it is pinned off here and the count is the same on a built tree and a bare one.
	await using f = await fixture({ TTK_MCP_APPS: 'off' });
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(f.key) }),
	);
	try {
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name);
		// 41: the admin catalog above less browser_close_all; browser_head and
		// browser_evaluate are absent for the same reasons as there (no provable outbound grant, and
		// no explicit evaluate grant).
		// mcp-recommendations: +6 (see above). D-150's browser_request_human needs view:control, which this key lacks.
		assertEquals(names.length, 47, `got ${names.join(',')}`);
		assert(!names.includes('browser_close_all'), 'an unusable tool must not be advertised');

		// **U-8b, pinned.** The SDK *client* parses the initialize result through
		// the same `ServerCapabilitiesSchema` the server declines to parse it
		// with, and that schema is `$strip` — so `getServerCapabilities()` drops
		// the vendor key even though the gateway demonstrably put it on the wire
		// (`/healthz and capabilities.tykotech report the same version` asserts the
		// raw frame). This is why `report_design.md` §10.1 specified three
		// locations rather than one, and why the documentation tells a client
		// using the official SDK to read `ttk://capabilities` instead.
		//
		// Asserted rather than lamented: if a future SDK stops stripping, this
		// fails and the documentation gets to become simpler.
		assertEquals(
			(client.getServerCapabilities() as Record<string, unknown> | undefined)?.tykotech,
			undefined,
			'the SDK client no longer strips the vendor key — B3.1’s documentation can be simplified',
		);

		// So the readable location is the resource, and `tools_withheld` there
		// must name exactly the tools `tools/list` withheld. The list a client
		// reads and the list the server refuses have to be the same list.
		const resource = await client.readResource({ uri: 'ttk://capabilities' });
		const block = JSON.parse((resource.contents[0] as { text: string }).text) as {
			tools_withheld?: Array<{ name: string; reason: string }>;
		};
		const withheld = block.tools_withheld ?? [];
		// D-081: the extension tools this deployment composes are reported too, not only the browser catalog.
		assertEquals(
			withheld.map((row) => row.name).sort(),
			[
				'a2ui_delete',
				'a2ui_publish',
				'agent_cancel_task',
				'agent_get_task',
				'agent_list_tasks',
				'agent_peers',
				'agent_run_tool',
				'browser_close_all',
				'browser_evaluate',
				// W2: gated on TTK_SIGNED_LINKS, off here (`feature-unavailable`).
				'browser_file_link',
				'browser_head',
				// R9 (W7): MCP Apps is off by default, so the live view and its ticket are withheld as unavailable.
				'browser_live_ticket',
				'browser_live_view',
				'browser_record',
				// mcp-recommendations W4 (D-124): the handoff needs `view:control`, which this key does not hold.
				'browser_request_human',
				'browser_run_task',
				'browser_storage_state',
			],
			`tools_withheld disagrees with tools/list: ${JSON.stringify(withheld)}`,
		);
		assertEquals(withheld.find((row) => row.name === 'browser_close_all')?.reason, 'scope-required');
		assertEquals(withheld.find((row) => row.name === 'browser_record')?.reason, 'feature-unavailable');
		assertEquals(withheld.find((row) => row.name === 'browser_live_view')?.reason, 'feature-unavailable');
		// The complement: every withheld name is one `tools/list` really omitted.
		for (const row of withheld) assert(!names.includes(row.name), `${row.name} is both listed and withheld`);
	} finally {
		await client.close();
	}
});

Deno.test('gateway: a tool failure is a result-level error, not a protocol error', async () => {
	await using f = await fixture();
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(f.adminKey) }),
	);
	try {
		// An unknown session id is the model's mistake to correct, so it comes
		// back as an error *result* it can read, not a transport failure.
		const result = await client.callTool({
			name: 'browser_list_tabs',
			arguments: { session_id: '01JDOESNOTEXIST' },
		});
		assertEquals(result.isError, true);
		const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
		assertStringIncludes(text, 'Error: unknown-session');
	} finally {
		await client.close();
	}
});

Deno.test('gateway: the navigation allowlist refuses a host outside it', async () => {
	await using f = await fixture({ TTK_ALLOWED_DOMAINS: 'example.com' });
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(f.adminKey) }),
	);
	try {
		const result = await client.callTool({
			name: 'browser_navigate',
			arguments: { url: 'https://evil.example.net/' },
		});
		assertEquals(result.isError, true);
		assertStringIncludes((result.content as Array<{ text?: string }>)[0]?.text ?? '', 'navigation-blocked');
	} finally {
		await client.close();
	}
});

// --- live-view tickets --------------------------------------------------------

Deno.test('gateway: a ticket is minted with the mode the scope allows', async () => {
	await using f = await fixture();

	const watch = await fetch(`${f.url}/api/v1/live/ticket`, {
		method: 'POST',
		headers: { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	assertEquals(watch.status, 201);
	const watchBody = await watch.json();
	assertEquals(watchBody.mode, 'watch', 'view:watch alone must not grant control');
	assert(String(watchBody.ticket).startsWith('lvt_'));
	assertEquals(watchBody.session_id, 'default');

	const control = await fetch(`${f.url}/api/v1/live/ticket`, {
		method: 'POST',
		headers: { authorization: `Bearer ${f.adminKey}`, 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	assertEquals((await control.json()).mode, 'control');
});

Deno.test('gateway: a ticket for an unknown session is refused at mint time', async () => {
	await using f = await fixture();
	const response = await fetch(`${f.url}/api/v1/live/ticket`, {
		method: 'POST',
		headers: { authorization: `Bearer ${f.adminKey}`, 'content-type': 'application/json' },
		body: JSON.stringify({ session_id: '01JNOPE' }),
	});
	const problem = await response.json();
	assertEquals(response.status, 404);
	assertEquals(problem.type, 'https://tykotech.eu/problems/unknown-session');
});

Deno.test('gateway: a ticket is single-use and cannot be replayed', async () => {
	await using f = await fixture();
	const minted = await fetch(`${f.url}/api/v1/live/ticket`, {
		method: 'POST',
		headers: { authorization: `Bearer ${f.adminKey}`, 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	const { ticket } = await minted.json();

	// F2: a request that is not an upgrade is answered 426 before the ticket is looked at, so it burns nothing.
	for (let i = 0; i < 2; i += 1) {
		const plain = await fetch(`${f.url}/live/default/ws?ticket=${ticket}`);
		await plain.body?.cancel();
		assertEquals(plain.status, 426);
	}

	// An upgrade redeems it once: past the ticket check (this fixture has no browser, so the session lookup
	// answers, not the ticket gate)...
	const first = await fetch(`${f.url}/live/default/ws?ticket=${ticket}`, {
		headers: { upgrade: 'websocket', connection: 'upgrade' },
	});
	await first.body?.cancel();
	assert(first.status !== 403, `the first upgrade was refused at the ticket gate (${first.status})`);

	// ...and a replay is refused before any upgrade.
	const replay = await fetch(`${f.url}/live/default/ws?ticket=${ticket}`, {
		headers: { upgrade: 'websocket', connection: 'upgrade' },
	});
	const problem = await replay.json();
	assertEquals(replay.status, 403);
	assertEquals(problem.type, 'https://tykotech.eu/problems/ticket-consumed');
});

Deno.test('gateway: an unknown ticket never reaches the upgrade', async () => {
	await using f = await fixture();
	const response = await fetch(`${f.url}/live/default/ws?ticket=lvt_bogus`, {
		headers: { upgrade: 'websocket', connection: 'upgrade' },
	});
	const problem = await response.json();
	assertEquals(response.status, 403);
	assertEquals(problem.type, 'https://tykotech.eu/problems/ticket-invalid');
});

Deno.test('gateway: configuring a data directory makes the persistence tool appear (R5)', async () => {
	await using f = await fixture({ TTK_DATA_DIR: 'tests/.scratch' });
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(f.adminKey) }),
	);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		// The same server, the same principal: only the configuration differs.
		assert(names.includes('browser_storage_state'), `expected browser_storage_state in ${names.join(',')}`);
	} finally {
		await client.close();
	}
});

Deno.test('gateway: a disabled tool is reported as disabled, not as unknown', async () => {
	await using f = await fixture();
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(f.adminKey) }),
	);
	try {
		// The distinction still matters to a caller — "this deployment has no
		// persistence" says come back to an operator, "not found" says you were
		// wrong about this server — but since the D-A2 seam it is carried by a
		// *code* on an `isError` result rather than by a JSON-RPC error. That is
		// the direction `SPECS/AGENTS.md` §2 already required: a JSON-RPC error
		// aborts the model's turn, and a tool being absent from this deployment is
		// something the model can act on.
		const result = await client.callTool({
			name: 'browser_storage_state',
			arguments: { action: 'save', name: 'x' },
		}) as {
			isError?: boolean;
			content?: Array<{ text?: string }>;
			structuredContent?: { error?: Record<string, unknown> };
		};
		assertEquals(result.isError, true, 'a disabled tool must not run');
		assertStringIncludes(result.content?.[0]?.text ?? '', 'Error: feature-unavailable: ');
		assertEquals(result.structuredContent?.error, {
			code: 'feature-unavailable',
			message: 'browser_storage_state needs persistence on this deployment',
			feature: 'persistence',
		});
	} finally {
		await client.close();
	}
});

// --- session files over HTTP (E-33) -------------------------------------------

/** A completed-download ledger entry pointing at a real file the test wrote. */
function ledgerRecord(dir: string, guid: string, name: string, size: number) {
	return {
		guid,
		url: 'http://127.0.0.1:1/export?token=secret',
		suggestedFilename: name,
		fileName: name,
		path: `${dir}/${guid}`,
		fileSize: size,
		receivedBytes: size,
		totalBytes: size,
		fileType: 'txt',
		mimeType: null,
		autoDownload: false,
		state: 'completed' as const,
		startedAt: 1,
		completedAt: 2,
		error: null,
	};
}

interface FileFixture extends Fixture {
	/** A credential holding every scope but `mcp:invoke`. */
	viewKey: string;
	dir: string;
	payload: Uint8Array;
}

/** A gateway whose fake session has one real downloaded file and one pending record. */
async function fileFixture(): Promise<FileFixture> {
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'gw-files-' });
	const payload = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
	await Deno.writeFile(`${dir}/G1`, payload);
	const records = [
		ledgerRecord(dir, 'G1', 'quarterly résumé.txt', payload.length),
		{ ...ledgerRecord(dir, 'P1', 'pending.txt', 0), state: 'inProgress' as const, completedAt: null },
	];
	const ledger = {
		downloads: records,
		isRemoteBrowser: false,
		lookup: (g: string) => records.find((r) => r.guid === g),
	};

	const scoped = await generateApiKey(KEY_ID, ['mcp:invoke', 'view:watch']);
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'view:control', 'admin']);
	const view = await generateApiKey('view-key', ['view:watch', 'view:control', 'task', 'admin']);
	const config: Config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([scoped.record, admin.record, view.record]),
		TTK_LOG_LEVEL: 'error',
		TTK_PUBLIC_URL: 'https://mcp.example.test/',
		// D-150: `owner` is the default now; the fixture creates the `default` session with no caller below, so the
		// file route is proven on a shared session (ownership's own refusals are session_ownership_test.ts's).
		TTK_SESSION_OWNERSHIP: 'shared',
	});
	// A real bus underneath the fake: the registry subscribes to it for page and
	// file change announcements, and a fake without one fails on the first session.
	const session = Object.assign(fakeSession(), { eventBus: new EventBus({ name: 'gw-files' }) });
	const gateway = await startGateway({
		config,
		version: '0.1.0-test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve({ session, downloads: ledger as never, downloadsDir: dir }),
	});
	// The session has to exist before a file can be read from it.
	await gateway.registry.resolve(undefined);

	return {
		gateway,
		url: gateway.url,
		key: scoped.key,
		adminKey: admin.key,
		viewKey: view.key,
		dir,
		payload,
		async [Symbol.asyncDispose]() {
			await gateway.shutdown();
			await gateway.finished;
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

Deno.test('gateway: a session file is streamed byte-for-byte with attachment headers and no CORS', async () => {
	await using f = await fileFixture();
	const response = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/G1`);
	assertEquals(response.status, 200);
	assertEquals(response.headers.get('content-type'), 'text/plain');
	assertEquals(response.headers.get('content-length'), String(f.payload.length));
	assertEquals(response.headers.get('cache-control'), 'no-store');
	assertEquals(response.headers.get('x-content-type-options'), 'nosniff');
	assertStringIncludes(
		response.headers.get('content-disposition') ?? '',
		'attachment; filename="quarterly r_sum_.txt"',
	);
	assertStringIncludes(
		response.headers.get('content-disposition') ?? '',
		"filename*=UTF-8''quarterly%20r%C3%A9sum%C3%A9.txt",
	);
	assertEquals(response.headers.get('access-control-allow-origin'), null, 'same-origin posture: no CORS');
	const body = new Uint8Array(await response.arrayBuffer());
	assertEquals(body.length, f.payload.length);
	assertEquals(body.every((value, i) => value === f.payload[i]), true, 'byte equality');
});

Deno.test('gateway: the file route needs a credential with mcp:invoke, not view:watch', async () => {
	await using f = await fileFixture();
	const anonymous = await fetch(`${f.url}/api/v1/sessions/default/files/G1`);
	assertEquals(anonymous.status, 401);
	await anonymous.body?.cancel();
	// Every scope except the one that matters: a viewer cannot carry documents off.
	const viewer = await authed(f.viewKey)(`${f.url}/api/v1/sessions/default/files/G1`);
	assertEquals(viewer.status, 403);
	assertStringIncludes(await viewer.text(), 'mcp:invoke');
});

Deno.test('gateway: unknown and pending file ids are 404, traversal ids 400, none with a path in the answer', async () => {
	await using f = await fileFixture();
	for (const [id, expect] of [['NOPE', 'no file with id'], ['P1', 'still downloading']]) {
		const response = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/${id}`);
		assertEquals(response.status, 404, id);
		const text = await response.text();
		assertStringIncludes(text, expect ?? '');
		assert(!text.includes(f.dir), `no path leaks for ${id}`);
	}
	// R1-5: a traversal spelling never reaches the route at all — the front refuses an encoded slash or a dot segment
	// before authentication and routing — and the refusal names no path either.
	for (const id of ['..%2FG1', '%2e%2e%2FG1', '..%5CG1']) {
		const response = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/${id}`);
		assertEquals(response.status, 400, id);
		const text = await response.text();
		assertStringIncludes(text, 'invalid-request');
		assert(!text.includes(f.dir), `no path leaks for ${id}`);
	}
	const missingSession = await authed(f.key)(`${f.url}/api/v1/sessions/nobody/files/G1`);
	assertEquals(missingSession.status, 404);
	assertStringIncludes(await missingSession.text(), 'unknown-session');
});

Deno.test('gateway: a client that abandons a download releases the lease so the session can close cleanly', async () => {
	await using f = await fileFixture();
	const record = f.gateway.registry.peek('default');
	assert(record !== undefined);
	const response = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/G1`);
	const reader = response.body?.getReader();
	assert(reader !== undefined);
	await reader.read();
	await reader.cancel();
	for (let i = 0; i < 100 && record.files.openReads > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
	assertEquals(record.files.openReads, 0);
	await f.gateway.registry.close('default');
	let present = true;
	try {
		await Deno.stat(f.dir);
	} catch {
		present = false;
	}
	assertEquals(present, false, 'the directory went with the session');
});

Deno.test('gateway: browser_get_file over MCP returns the same bytes inline and a link with the public URL', async () => {
	await using f = await fileFixture();
	// A small second file so the inline path can be exercised alongside the link path.
	await Deno.writeTextFile(`${f.dir}/G2`, 'inline-bytes');
	const record = f.gateway.registry.peek('default');
	assert(record !== undefined);
	const ledger = record.files as unknown as { ledger?: unknown };
	assert(ledger !== undefined);
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(f.key) }));
	try {
		const listed = await client.callTool({ name: 'browser_list_files', arguments: {} }) as {
			structuredContent?: { files: Array<{ file_id: string; available: boolean; status: string }> };
		};
		const files = listed.structuredContent?.files ?? [];
		assertEquals(files.map((file) => [file.file_id, file.status, file.available]), [
			['G1', 'completed', true],
			['P1', 'pending', false],
		]);

		const link = await client.callTool({
			name: 'browser_get_file',
			arguments: { file_id: 'G1', delivery: 'link' },
		}) as {
			isError?: boolean;
			content: Array<{ type: string; uri?: string; size?: number }>;
			structuredContent?: { http_url?: string; resource_uri?: string };
		};
		assertEquals(link.isError, undefined);
		assertEquals(
			link.structuredContent?.http_url,
			'https://mcp.example.test/api/v1/sessions/default/files/G1',
			'built from the configured public URL, not the Host header',
		);
		assertEquals(link.structuredContent?.resource_uri, 'ttk://session/default/files/G1');
		const resourceLink = link.content.find((block) => block.type === 'resource_link');
		assertEquals(resourceLink?.uri, 'ttk://session/default/files/G1');
		assertEquals(resourceLink?.size, f.payload.length);

		const inline = await client.callTool({ name: 'browser_get_file', arguments: { file_id: 'G1' } }) as {
			isError?: boolean;
			content: Array<{ type: string; resource?: { blob?: string; mimeType?: string } }>;
		};
		assertEquals(inline.isError, undefined);
		const embedded = inline.content.find((block) => block.type === 'resource');
		assertEquals(embedded?.resource?.mimeType, 'text/plain');
		const bytes = Uint8Array.from(atob(embedded?.resource?.blob ?? ''), (c) => c.charCodeAt(0));
		assertEquals(bytes.length, f.payload.length);
		assertEquals(bytes.every((value, i) => value === f.payload[i]), true, 'inline bytes equal the HTTP bytes');

		// The same file as a resource read.
		const read = await client.readResource({ uri: 'ttk://session/default/files/G1' });
		const content = read.contents[0] as { blob?: string; mimeType?: string };
		assertEquals(content.mimeType, 'text/plain');
		assertEquals(content.blob, embedded?.resource?.blob);

		// And the file resources are listed alongside the session resources.
		const resources = await client.listResources({});
		assert(resources.resources.some((r) => r.uri === 'ttk://session/default/files/G1'), 'completed file listed');
		assert(!resources.resources.some((r) => r.uri === 'ttk://session/default/files/P1'), 'pending file not listed');
	} finally {
		await client.close();
	}
});

Deno.test('B2.9: the file endpoint serves a Range byte-for-byte, and advertises that it can', async () => {
	await using f = await fileFixture();
	// Advertised on the whole-file response too, because a client deciding whether it *can* resume
	// asks for the whole file first.
	const whole = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/G1`);
	assertEquals(whole.status, 200);
	assertEquals(whole.headers.get('accept-ranges'), 'bytes');
	assertEquals(whole.headers.get('content-range'), null, 'a whole-file answer must not claim to be partial');
	await whole.body?.cancel();

	for (
		const [header, start, end] of [['bytes=0-3', 0, 3], ['bytes=4-', 4, f.payload.length - 1], [
			'bytes=-5',
			f.payload.length - 5,
			f.payload.length - 1,
		]] as const
	) {
		const response = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/G1`, {
			headers: { range: header },
		});
		assertEquals(response.status, 206, header);
		assertEquals(response.headers.get('content-range'), `bytes ${start}-${end}/${f.payload.length}`, header);
		assertEquals(response.headers.get('content-length'), String(end - start + 1), header);
		assertEquals(response.headers.get('accept-ranges'), 'bytes', header);
		const body = new Uint8Array(await response.arrayBuffer());
		// Byte equality against the slice, not merely the right length: an off-by-one in the seek keeps
		// the length and changes the bytes, which is exactly the bug a resumed download cannot survive.
		assertEquals(body, f.payload.slice(start, end + 1), header);
	}
});

Deno.test('B2.9: a range past the end is 416 with the size, never a clamped 206', async () => {
	await using f = await fileFixture();
	const response = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/G1`, {
		headers: { range: `bytes=${f.payload.length + 10}-${f.payload.length + 20}` },
	});
	// A clamp would tell the caller its request succeeded while handing it different bytes, which is
	// how a resumed download silently produces a truncated file.
	assertEquals(response.status, 416);
	assertEquals(response.headers.get('content-range'), `bytes */${f.payload.length}`);
	assertEquals(response.headers.get('accept-ranges'), 'bytes');
	await response.body?.cancel();
});

Deno.test('B2.9: a multi-range request is answered with the whole file rather than an error', async () => {
	await using f = await fileFixture();
	const response = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/G1`, {
		headers: { range: 'bytes=0-1,4-5' },
	});
	assertEquals(response.status, 200, 'RFC 9110 permits ignoring a range this server does not implement');
	assertEquals(response.headers.get('content-length'), String(f.payload.length));
	assertEquals(response.headers.get('content-range'), null);
	const _ = await response.arrayBuffer();
});
