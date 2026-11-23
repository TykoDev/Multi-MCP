/** Gateway end-to-end tests: the auth matrix, guards and a real MCP client round-trip, over a faked browser. */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { EventBus } from '@tykotech/bus';
import { generateApiKey } from './auth.ts';
import { loadConfig } from './config.ts';
import { type RunningGateway, startGateway } from './server.ts';
import { fakeSession, quiet } from './support_test.ts';

interface Fixture {
	gateway: RunningGateway;
	url: string;
	key: string;
	adminKey: string;
	[Symbol.asyncDispose](): Promise<void>;
}

async function fixture(
	overrides: Record<string, string> = {},
	launch: Parameters<typeof startGateway>[0]['launch'] = () => Promise.resolve(fakeSession(false)),
	extraKeys: { record: unknown }[] = [],
): Promise<Fixture> {
	const scoped = await generateApiKey('test-key', ['mcp:invoke', 'view:watch']);
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'view:control', 'admin']);
	const gateway = await startGateway({
		config: loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: '0',
			TTK_API_KEYS: JSON.stringify([scoped.record, admin.record, ...extraKeys.map((k) => k.record)]),
			TTK_LOG_LEVEL: 'error',
			...overrides,
		}),
		version: '0.1.0-test',
		logger: quiet(),
		launch,
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

async function rpc(url: string, token: string | null, body: unknown, origin?: string): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		...(token === null ? {} : { authorization: `Bearer ${token}` }),
		...(origin === undefined ? {} : { origin }),
	};
	return await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function status(f: Fixture, path: string, init?: RequestInit): Promise<number> {
	const response = await fetch(`${f.url}${path}`, init);
	await response.body?.cancel();
	return response.status;
}

async function connect(f: Fixture, token: string): Promise<Client> {
	const client = new Client({ name: 'gateway-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), { fetch: authed(token) }));
	return client;
}

/** A raw request with a chosen Host header (`fetch` replaces it); the status and the lower-cased head. */
async function rawHost(f: Fixture, host: string): Promise<{ status: number; raw: string }> {
	const conn = await Deno.connect({ hostname: '127.0.0.1', port: f.gateway.port });
	try {
		await conn.write(new TextEncoder().encode(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
		const buffer = new Uint8Array(4096);
		const raw = new TextDecoder().decode(buffer.subarray(0, (await conn.read(buffer)) ?? 0)).toLowerCase();
		return { status: Number(raw.split(' ')[1] ?? 0), raw };
	} finally {
		conn.close();
	}
}

Deno.test('gateway: public routes, the request id and the rate-limit budget', async () => {
	await using f = await fixture();
	const health = await fetch(`${f.url}/healthz`);
	assertEquals(await health.json(), { status: 'ok', version: '0.1.0-test', sessions: 0 });
	assert(health.headers.get('x-request-id') !== null, 'every response carries a request id');
	assertEquals(health.headers.get('x-ratelimit-remaining'), null, 'a public route charges no budget');
	// The browser asks for the favicon on its own; it must not draw a bearer challenge.
	const favicon = await fetch(`${f.url}/favicon.ico`);
	assertEquals([favicon.status, favicon.headers.get('www-authenticate'), await favicon.text()], [204, null, '']);
	const remaining = async () => {
		const response = await authed(f.key)(`${f.url}/api/v1/sessions`);
		await response.body?.cancel();
		return Number(response.headers.get('x-ratelimit-remaining'));
	};
	const first = await remaining();
	assert((await remaining()) < first, 'the budget falls as it is spent');
});

Deno.test('gateway: the SPA is unframable, never served from /assets/, and always revalidated', async () => {
	await using f = await fixture();
	const page = await fetch(`${f.url}/`);
	await page.body?.cancel();
	// A checkout without `deno task build:web` serves the shell; the headers are the route's either way.
	assert(page.status === 200 || page.status === 503, `unexpected ${page.status}`);
	assertEquals(page.headers.get('x-frame-options'), 'DENY');
	assertStringIncludes(page.headers.get('content-security-policy') ?? '', "frame-ancestors 'none'");
	for (const path of ['/assets/index.html', '/assets/', '/assets/INDEX.HTM', '/assets/brand/']) {
		assertEquals(await status(f, path), 404, `${path} must not serve a document`);
	}
	assertEquals(await status(f, '/assets/%69ndex.html'), 400, 'an encoded spelling never reaches the static handler');
	const asset = await fetch(`${f.url}/assets/brand/favicon-32.png`);
	await asset.body?.cancel();
	assertEquals([asset.status, asset.headers.get('x-frame-options')], [200, 'DENY']);
	// The bundle names are not content-hashed, so a cached bundle would outlive an upgrade.
	const built = await Deno.stat(new URL('../../web/dist/app.css', import.meta.url)).then(() => true, () => false);
	for (const path of ['/', '/assets/brand/favicon-32.png', ...(built ? ['/assets/app.css'] : [])]) {
		const response = await fetch(`${f.url}${path}`);
		await response.body?.cancel();
		assertEquals(response.headers.get('cache-control'), 'no-cache', path);
	}
});

Deno.test('gateway: the auth matrix — 401 with a challenge, 401 never 500, 403 by scope, Origin refused', async () => {
	await using f = await fixture();
	const anonymous = await rpc(f.url, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	await anonymous.body?.cancel();
	assertEquals(anonymous.status, 401);
	assertStringIncludes(anonymous.headers.get('www-authenticate') ?? '', 'Bearer');
	assertEquals(
		await status(f, '/mcp', { method: 'POST', headers: { authorization: 'Bearer ttk_not-a-real-key' } }),
		401,
	);
	for (const path of ['/api/v1/sessions', '/api/v1/system/diagnostics']) {
		assertEquals(await status(f, path), 401, path);
		const denied = await authed(f.key)(`${f.url}${path}`);
		const problem = await denied.json();
		assertEquals([denied.status, problem.type], [403, 'https://tykotech.eu/problems/forbidden-scope'], path);
		assert(typeof problem['x-request-id'] === 'string');
		assertEquals(problem.config, undefined, 'a refusal carries no part of the posture');
		const allowed = await authed(f.adminKey)(`${f.url}${path}`);
		await allowed.body?.cancel();
		assertEquals(allowed.status, 200, path);
	}
	const listed = await rpc(f.url, f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	await listed.body?.cancel();
	assertEquals(listed.status, 200, 'no Origin: accepted');
	const browser = await rpc(f.url, f.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'https://evil.example.com');
	await browser.body?.cancel();
	assertEquals(browser.status, 403, 'browser origins are denied unless allowlisted');
});

Deno.test('gateway: the Host guard admits loopback and the declared public address, and refuses the rest', async () => {
	// The bind stays on loopback; the allowlist follows the declaration, not a wildcard bind.
	await using f = await fixture({ TTK_PUBLIC_URL: 'http://192.168.1.14:8787' });
	for (const host of ['192.168.1.14:8787', '192.168.1.14', `127.0.0.1:${f.gateway.port}`]) {
		assertEquals((await rawHost(f, host)).status, 200, host);
	}
	const refused = await rawHost(f, 'evil.example.com');
	assertEquals(refused.status, 400, 'DNS rebinding guard');
	for (const part of ['content-type: application/problem+json', 'x-request-id:', 'problems/host-forbidden']) {
		assertStringIncludes(refused.raw, part);
	}
});

Deno.test('gateway: an MCP client lists the admin catalog, reads capabilities and gets result-level errors', async () => {
	await using f = await fixture();
	const health = await (await fetch(`${f.url}/healthz`)).json();
	// The vendor block is on the raw initialize frame (the SDK client strips unknown capability keys).
	const init = await rpc(f.url, f.key, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gateway-test', version: '0' } },
	});
	const text = await init.text();
	const frame = JSON.parse(
		text.includes('data:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text,
	);
	const block = frame.result.capabilities.tykotech as { version: string; live_view?: { ticket_ttl_max_s: unknown } };
	assertEquals(block.version, health.version);
	assertEquals(block.live_view?.ticket_ttl_max_s, { view: 300, control: 60 }, 'the clamp ceilings, not a copy');

	const client = await connect(f, f.adminKey);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		assertEquals(names.length, 49, `expected the admin catalog, got ${names.join(',')}`);
		// No task/evaluate grant, no data directory, no ffmpeg, no provable outbound grant, no signed links.
		const absent = ['browser_evaluate', 'browser_file_link', 'browser_head', 'browser_record', 'browser_run_task'];
		assertEquals([...absent, 'browser_storage_state'].filter((name) => names.includes(name)), []);
		for (const name of ['browser_close_all', 'browser_navigate', 'browser_get_file', 'browser_fill_secret']) {
			assert(names.includes(name), name);
		}
		// A model's mistake and a deployment's missing feature are both results it can read, never protocol errors.
		const unknown = await client.callTool({ name: 'browser_list_tabs', arguments: { session_id: '01JDOESNOTEXIST' } });
		assertEquals(unknown.isError, true);
		assertStringIncludes((unknown.content as Array<{ text?: string }>)[0]?.text ?? '', 'Error: unknown-session');
		const disabled = await client.callTool({
			name: 'browser_storage_state',
			arguments: { action: 'save', name: 'x' },
		}) as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { error?: unknown } };
		assertEquals(disabled.isError, true);
		assertStringIncludes(disabled.content?.[0]?.text ?? '', 'Error: feature-unavailable: ');
		assertEquals(disabled.structuredContent?.error, {
			code: 'feature-unavailable',
			message: 'browser_storage_state needs persistence on this deployment',
			feature: 'persistence',
		});
	} finally {
		await client.close();
	}
});

Deno.test('gateway: a principal without admin lists what it may use, and tools_withheld names exactly the rest', async () => {
	// MCP Apps is pinned off so the count is the same on a built tree and a bare one.
	await using f = await fixture({ TTK_MCP_APPS: 'off' });
	const client = await connect(f, f.key);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		assertEquals(names.length, 47, `got ${names.join(',')}`);
		const resource = await client.readResource({ uri: 'ttk://capabilities' });
		const withheld = (JSON.parse((resource.contents[0] as { text: string }).text) as {
			tools_withheld?: Array<{ name: string; reason: string }>;
		}).tools_withheld ?? [];
		assertEquals(withheld.map((row) => row.name).sort(), [
			'a2ui_delete',
			'a2ui_publish',
			'agent_cancel_task',
			'agent_get_task',
			'agent_list_tasks',
			'agent_peers',
			'agent_run_tool',
			'browser_close_all',
			'browser_evaluate',
			'browser_file_link',
			'browser_head',
			'browser_live_ticket',
			'browser_live_view',
			'browser_record',
			'browser_request_human',
			'browser_run_task',
			'browser_storage_state',
		]);
		assertEquals(withheld.find((row) => row.name === 'browser_close_all')?.reason, 'scope-required');
		assertEquals(withheld.find((row) => row.name === 'browser_record')?.reason, 'feature-unavailable');
		assertEquals(withheld.find((row) => row.name === 'browser_live_view')?.reason, 'feature-unavailable');
		for (const row of withheld) assert(!names.includes(row.name), `${row.name} is both listed and withheld`);
	} finally {
		await client.close();
	}
});

Deno.test('gateway: the navigation allowlist refuses a host outside it; a data directory adds persistence', async () => {
	await using f = await fixture({ TTK_ALLOWED_DOMAINS: 'example.com', TTK_DATA_DIR: 'tests/.scratch' });
	const client = await connect(f, f.adminKey);
	try {
		const result = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://evil.example.net/' } });
		assertEquals(result.isError, true);
		assertStringIncludes((result.content as Array<{ text?: string }>)[0]?.text ?? '', 'navigation-blocked');
		assert((await client.listTools()).tools.some((tool) => tool.name === 'browser_storage_state'));
	} finally {
		await client.close();
	}
});

Deno.test('gateway: live tickets — mode by scope, unknown session refused, single use, unknown never upgrades', async () => {
	await using f = await fixture();
	const mint = async (token: string, body: Record<string, unknown> = {}) =>
		await authed(token)(`${f.url}/api/v1/live/ticket`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	const watch = await mint(f.key);
	const watchBody = await watch.json();
	assertEquals([watch.status, watchBody.mode, watchBody.session_id], [201, 'watch', 'default']);
	assert(String(watchBody.ticket).startsWith('lvt_'));
	const { ticket, mode } = await (await mint(f.adminKey)).json();
	assertEquals(mode, 'control');
	const unknown = await mint(f.adminKey, { session_id: '01JNOPE' });
	assertEquals([unknown.status, (await unknown.json()).type], [404, 'https://tykotech.eu/problems/unknown-session']);

	// A non-upgrade request is answered 426 before the ticket is read, so it burns nothing.
	for (let i = 0; i < 2; i += 1) assertEquals(await status(f, `/live/default/ws?ticket=${ticket}`), 426);
	const upgrade = { headers: { upgrade: 'websocket', connection: 'upgrade' } };
	assert((await status(f, `/live/default/ws?ticket=${ticket}`, upgrade)) !== 403, 'the first upgrade passes the gate');
	for (const [id, slug] of [[ticket, 'ticket-consumed'], ['lvt_bogus', 'ticket-invalid']]) {
		const refused = await fetch(`${f.url}/live/default/ws?ticket=${id}`, upgrade);
		assertEquals([refused.status, (await refused.json()).type], [403, `https://tykotech.eu/problems/${slug}`]);
	}
});

// --- session files over HTTP -------------------------------------------------

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

/** A gateway whose shared `default` session has one real downloaded file and one pending record. */
async function fileFixture(): Promise<Fixture & { viewKey: string; dir: string; payload: Uint8Array }> {
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
	// Every scope but `mcp:invoke`: a viewer cannot carry documents off.
	const view = await generateApiKey('view-key', ['view:watch', 'view:control', 'task', 'admin']);
	// The registry subscribes to the bus for file change announcements.
	const session = Object.assign(fakeSession(false), { eventBus: new EventBus({ name: 'gw-files' }) });
	const f = await fixture(
		{ TTK_PUBLIC_URL: 'https://mcp.example.test/', TTK_SESSION_OWNERSHIP: 'shared' },
		() => Promise.resolve({ session, downloads: ledger as never, downloadsDir: dir }),
		[view],
	);
	await f.gateway.registry.resolve(undefined);
	return {
		...f,
		viewKey: view.key,
		dir,
		payload,
		async [Symbol.asyncDispose]() {
			await f[Symbol.asyncDispose]();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

Deno.test('gateway: a session file is streamed byte-for-byte, gated on mcp:invoke, with ranges and no leaks', async () => {
	await using f = await fileFixture();
	const file = `${f.url}/api/v1/sessions/default/files/G1`;
	const response = await authed(f.key)(file);
	assertEquals(response.status, 200);
	for (
		const [name, value] of [
			['content-type', 'text/plain'],
			['content-length', String(f.payload.length)],
			['cache-control', 'no-store'],
			['x-content-type-options', 'nosniff'],
			['accept-ranges', 'bytes'],
			['content-range', null],
			['access-control-allow-origin', null],
		] as const
	) assertEquals(response.headers.get(name), value, name);
	const disposition = response.headers.get('content-disposition') ?? '';
	assertStringIncludes(disposition, 'attachment; filename="quarterly r_sum_.txt"');
	assertStringIncludes(disposition, "filename*=UTF-8''quarterly%20r%C3%A9sum%C3%A9.txt");
	assertEquals(new Uint8Array(await response.arrayBuffer()), f.payload);

	assertEquals(await status(f, '/api/v1/sessions/default/files/G1'), 401);
	const viewer = await authed(f.viewKey)(file);
	assertEquals(viewer.status, 403);
	assertStringIncludes(await viewer.text(), 'mcp:invoke');

	for (const [id, code, expect] of [['NOPE', 404, 'no file with id'], ['P1', 404, 'still downloading']] as const) {
		const refused = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/${id}`);
		const text = await refused.text();
		assertEquals(refused.status, code, id);
		assertStringIncludes(text, expect);
		assert(!text.includes(f.dir), `no path leaks for ${id}`);
	}
	// Traversal spellings are refused by the front, before routing, and name no path either.
	for (const id of ['..%2FG1', '%2e%2e%2FG1', '..%5CG1']) {
		const refused = await authed(f.key)(`${f.url}/api/v1/sessions/default/files/${id}`);
		const text = await refused.text();
		assertEquals(refused.status, 400, id);
		assertStringIncludes(text, 'invalid-request');
		assert(!text.includes(f.dir), `no path leaks for ${id}`);
	}
	const missing = await authed(f.key)(`${f.url}/api/v1/sessions/nobody/files/G1`);
	assertEquals(missing.status, 404);
	assertStringIncludes(await missing.text(), 'unknown-session');

	const size = f.payload.length;
	for (
		const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=4-', 4, size - 1], ['bytes=-5', size - 5, size - 1]]
	) {
		const part = await authed(f.key)(file, { headers: { range: String(range) } });
		assertEquals(part.status, 206, String(range));
		assertEquals(part.headers.get('content-range'), `bytes ${start}-${end}/${size}`);
		assertEquals(part.headers.get('content-length'), String(Number(end) - Number(start) + 1));
		// Byte equality against the slice: an off-by-one in the seek keeps the length and changes the bytes.
		assertEquals(new Uint8Array(await part.arrayBuffer()), f.payload.slice(Number(start), Number(end) + 1));
	}
	// Past the end is 416 with the size, never a clamped 206 that would truncate a resumed download.
	const past = await authed(f.key)(file, { headers: { range: `bytes=${size + 10}-${size + 20}` } });
	await past.body?.cancel();
	assertEquals([past.status, past.headers.get('content-range')], [416, `bytes */${size}`]);
	// A multi-range request this server does not implement is answered with the whole file (RFC 9110).
	const multi = await authed(f.key)(file, { headers: { range: 'bytes=0-1,4-5' } });
	await multi.arrayBuffer();
	assertEquals([multi.status, multi.headers.get('content-range')], [200, null]);
});

Deno.test('gateway: browser_get_file over MCP returns the same bytes inline and a link with the public URL', async () => {
	await using f = await fileFixture();
	const client = await connect(f, f.key);
	try {
		const listed = await client.callTool({ name: 'browser_list_files', arguments: {} }) as {
			structuredContent?: { files: Array<{ file_id: string; available: boolean; status: string }> };
		};
		assertEquals(listed.structuredContent?.files.map((file) => [file.file_id, file.status, file.available]), [
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
		// Built from the configured public URL, never the Host header.
		assertEquals(link.structuredContent?.http_url, 'https://mcp.example.test/api/v1/sessions/default/files/G1');
		assertEquals(link.structuredContent?.resource_uri, 'ttk://session/default/files/G1');
		const resourceLink = link.content.find((block) => block.type === 'resource_link');
		assertEquals([resourceLink?.uri, resourceLink?.size], ['ttk://session/default/files/G1', f.payload.length]);

		const inline = await client.callTool({ name: 'browser_get_file', arguments: { file_id: 'G1' } }) as {
			content: Array<{ type: string; resource?: { blob?: string; mimeType?: string } }>;
		};
		const embedded = inline.content.find((block) => block.type === 'resource')?.resource;
		assertEquals(embedded?.mimeType, 'text/plain');
		assertEquals(Uint8Array.from(atob(embedded?.blob ?? ''), (c) => c.charCodeAt(0)), f.payload);
		const read = await client.readResource({ uri: 'ttk://session/default/files/G1' });
		assertEquals((read.contents[0] as { blob?: string }).blob, embedded?.blob);
		const uris = (await client.listResources({})).resources.map((r) => r.uri);
		assert(uris.includes('ttk://session/default/files/G1') && !uris.includes('ttk://session/default/files/P1'));
	} finally {
		await client.close();
	}
});

Deno.test('gateway: a client that abandons a download releases the lease so the session can close cleanly', async () => {
	await using f = await fileFixture();
	const record = f.gateway.registry.peek('default');
	assert(record !== undefined);
	const reader = (await authed(f.key)(`${f.url}/api/v1/sessions/default/files/G1`)).body!.getReader();
	await reader.read();
	await reader.cancel();
	for (let i = 0; i < 100 && record.files.openReads > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
	assertEquals(record.files.openReads, 0);
	await f.gateway.registry.close('default');
	assertEquals(await Deno.stat(f.dir).then(() => true, () => false), false, 'the directory went with the session');
});
