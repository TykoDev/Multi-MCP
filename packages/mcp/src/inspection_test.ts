/**
 * R4 (D-116): the three inspection handlers against a real registry, a real event ring and a real request log,
 * fed by a stand-in CDP client. Every success is parsed with the tool's own output schema, so a field the handler
 * emits that the schema strips fails here rather than at the SDK seam.
 *
 * AC4 (redaction, scope gating), AC5 (bounds at the handler, the console claim's arm/idle/close, HAR 1.2 and its
 * 1 MiB cap) and AC6's unit half (a configured secret, as written, never leaves through any of the three).
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { encodeBase64 } from '@std/encoding/base64';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { INSPECTION_OUTPUT } from './catalog/inspection.ts';
import { isToolError } from './errors.ts';
import { HAR_MAX_BYTES } from './har.ts';
import { CONSOLE_CLAIM_IDLE_MS, DEFAULT_SESSION_ID, type SessionRecord, SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';
import { SecretStore } from './secrets.ts';
import {
	browserConsoleLog,
	browserHarExport,
	browserNetworkLog,
	NETWORK_BODY_LIMIT_BYTES,
} from './tools/inspection.ts';
import type { ToolContext, ToolResult } from './types.ts';

type Listener = (params: unknown, sessionId?: string) => void;

const SECRET = 'Zq8-TYPED-SECRET-3vP';

interface FakeClient {
	on(event: string, listener: Listener): () => void;
	emit(event: string, params: unknown, sessionId?: string): void;
	bodies: Map<string, { body: string; base64Encoded: boolean }>;
	bodySessions: Array<string | undefined>;
	send: { Network: { getResponseBody(p: { requestId: string }, sessionId?: string): Promise<unknown> } };
}

function fakeClient(): FakeClient {
	const listeners = new Map<string, Set<Listener>>();
	const bodies = new Map<string, { body: string; base64Encoded: boolean }>();
	const bodySessions: Array<string | undefined> = [];
	return {
		bodies,
		bodySessions,
		on(event, listener) {
			const set = listeners.get(event) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
		emit(event, params, sessionId) {
			for (const listener of listeners.get(event) ?? []) listener(params, sessionId);
		},
		send: {
			Network: {
				getResponseBody({ requestId }, sessionId) {
					bodySessions.push(sessionId);
					const body = bodies.get(requestId);
					return body === undefined
						? Promise.reject(new Error('No resource with given identifier found'))
						: Promise.resolve(body);
				},
			},
		},
	};
}

interface Fixture extends AsyncDisposable {
	readonly registry: SessionRegistry;
	readonly record: SessionRecord;
	readonly client: FakeClient;
	ctx(scopes?: readonly Scope[]): ToolContext;
	request(id: string, url: string, options?: {
		requestHeaders?: Record<string, string>;
		responseHeaders?: Record<string, string>;
		type?: string;
	}): void;
	console(level: string, text: string): void;
}

async function fixture(now?: () => number): Promise<Fixture> {
	const client = fakeClient();
	const session = {
		cdpClient: client,
		sessionManager: null,
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: 'T-top',
		eventBus: new EventBus({ name: 'inspection' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		...(now === undefined ? {} : { now }),
		launch: () => Promise.resolve(session),
	});
	const record = await registry.resolve(DEFAULT_SESSION_ID);
	const secrets = new SecretStore([{ name: 'site_password', value: SECRET, domains: [] }]);
	return {
		registry,
		record,
		client,
		ctx: (scopes = ['mcp:invoke']) => ({
			registry,
			allowedDomains: [],
			principal: 'test',
			scopes: new Set(scopes),
			secrets,
			capabilities: { version: '9.9.9-test' } as ToolContext['capabilities'],
		}),
		request(id, url, options = {}) {
			client.emit('Network.requestWillBeSent', {
				requestId: id,
				request: { url, method: 'GET', headers: options.requestHeaders ?? {} },
				timestamp: 10,
				wallTime: 1_767_225_600,
				type: options.type ?? 'Document',
				frameId: 'T-top',
			}, 'S-page');
			client.emit('Network.responseReceived', {
				requestId: id,
				timestamp: 10.01,
				type: options.type ?? 'Document',
				response: {
					url,
					status: 200,
					headers: options.responseHeaders ?? { 'content-type': 'text/html' },
					mimeType: 'text/html',
					encodedDataLength: 100,
				},
			});
			client.emit('Network.loadingFinished', { requestId: id, timestamp: 10.02, encodedDataLength: 300 });
		},
		console(level, text) {
			client.emit('Runtime.consoleAPICalled', { type: level, args: [{ type: 'string', value: text }] });
		},
		[Symbol.asyncDispose]: async () => {
			await registry.shutdown();
		},
	};
}

function structured<T>(result: ToolResult): T {
	return (result as { structuredContent: T }).structuredContent;
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
	const error = await assertRejects(run);
	assert(isToolError(error), String(error));
	return { code: error.code, message: error.message };
}

// --- browser_network_log -------------------------------------------------------------------------------

Deno.test('inspection (AC4): full URLs and bodies need network:read, and the refusal names no scope', async () => {
	await using f = await fixture();
	f.request('R1', 'https://app.example/a?token=Zq8');
	for (const args of [{ include_full_urls: true }, { body_for: 'R1' }]) {
		const refused = await refusal(() => browserNetworkLog(args, f.ctx()));
		assertEquals(refused.code, 'scope-required');
		assert(!refused.message.includes('network:read') && !refused.message.includes(':read'), refused.message);
	}
	const plain = structured<{ entries: Array<Record<string, unknown>> }>(await browserNetworkLog({}, f.ctx()));
	assertEquals(plain.entries[0]?.url, undefined, 'no url field without the scope');
	assertEquals(plain.entries[0]?.has_query, true);
	assertEquals(plain.entries[0]?.path, '/a');
	assert(!JSON.stringify(plain).includes('token=Zq8'));

	const full = await browserNetworkLog({ include_full_urls: true }, f.ctx(['mcp:invoke', 'network:read']));
	INSPECTION_OUTPUT.browser_network_log.parse(structured(full));
	assertEquals(
		structured<{ entries: Array<{ url?: string }> }>(full).entries[0]?.url,
		'https://app.example/a?token=Zq8',
	);
	// The scope alone does not put the url on the wire: the caller must ask.
	const asked = structured<{ entries: Array<{ url?: string }> }>(
		await browserNetworkLog({}, f.ctx(['mcp:invoke', 'network:read'])),
	);
	assertEquals(asked.entries[0]?.url, undefined);
});

Deno.test('inspection (AC4/F3): headers are redacted by name, and URL values are cut without the scope', async () => {
	await using f = await fixture();
	f.request('R1', 'https://app.example/next', {
		requestHeaders: {
			Authorization: 'Bearer Zq8-BEARER',
			Cookie: 'sid=Zq8-COOKIE',
			Referer: 'https://app.example/prev?session=Zq8-REF',
			'X-Session-Token': 'Zq8-TOKEN',
		},
		responseHeaders: {
			Location: '/cb?code=Zq8-CODE',
			Link: '<https://cdn.example/a.css?v=Zq8-LINK>; rel=preload',
			Refresh: '0; url=https://app.example/r?s=Zq8-REFRESH',
			'Content-Location': 'https://app.example/c?q=Zq8-CL',
			'Set-Cookie': 'sid=Zq8-SETCOOKIE',
		},
	});
	const result = await browserNetworkLog({ include_headers: true }, f.ctx());
	const payload = structured<{ entries: Array<Record<string, Record<string, string>>> }>(result);
	INSPECTION_OUTPUT.browser_network_log.parse(payload);
	const entry = payload.entries[0];
	assert(entry !== undefined);
	assertEquals(entry.request_headers, {
		Authorization: '[redacted]',
		Cookie: '[redacted]',
		Referer: 'https://app.example/prev',
		'X-Session-Token': '[redacted]',
	});
	assertEquals(entry.response_headers, {
		Location: '/cb',
		Link: '<https://cdn.example/a.css>; rel=preload',
		Refresh: '0; url=https://app.example/r',
		'Content-Location': 'https://app.example/c',
		'Set-Cookie': '[redacted]',
	});
	const text = JSON.stringify(result);
	assert(!/Zq8-[A-Z]/.test(text), `a credential or query reached the caller: ${text}`);

	// With the scope the URL values are whole; credentials stay redacted regardless.
	const privileged = structured<{ entries: Array<Record<string, Record<string, string>>> }>(
		await browserNetworkLog({ include_headers: true }, f.ctx(['mcp:invoke', 'network:read'])),
	);
	assertEquals(privileged.entries[0]?.request_headers?.Referer, 'https://app.example/prev?session=Zq8-REF');
	assertEquals(privileged.entries[0]?.request_headers?.Authorization, '[redacted]');
	// Headers appear only when asked for.
	const bare = structured<{ entries: Array<Record<string, unknown>> }>(await browserNetworkLog({}, f.ctx()));
	assertEquals(bare.entries[0]?.request_headers, undefined);
});

Deno.test('inspection (AC6): a configured secret, as written, never leaves through the network log', async () => {
	await using f = await fixture();
	f.request('R1', `https://app.example/u/${SECRET}?p=${SECRET}`, {
		requestHeaders: { 'x-echo': `value ${SECRET}` },
		responseHeaders: { 'x-reflect': SECRET },
	});
	f.client.bodies.set('R1', { body: `<p>${SECRET}</p>`, base64Encoded: false });
	const result = await browserNetworkLog(
		{ include_headers: true, include_full_urls: true, body_for: 'R1' },
		f.ctx(['mcp:invoke', 'network:read']),
	);
	const text = JSON.stringify(result);
	assert(!text.includes(SECRET), text);
	assertStringIncludes(text, '[secret]');
});

Deno.test('inspection: body_for returns text or base64, bounded at 256 KiB, from the session that loaded it', async () => {
	await using f = await fixture();
	const privileged = f.ctx(['mcp:invoke', 'network:read']);
	f.request('TXT', 'https://app.example/t');
	f.request('BIG', 'https://app.example/big');
	f.request('BIN', 'https://app.example/b.png', { type: 'Image' });
	f.client.bodies.set('TXT', { body: 'hello', base64Encoded: false });
	f.client.bodies.set('BIG', { body: 'x'.repeat(NETWORK_BODY_LIMIT_BYTES + 10), base64Encoded: false });
	f.client.bodies.set('BIN', { body: encodeBase64(new Uint8Array([1, 2, 3])), base64Encoded: true });

	const body = (result: ToolResult) =>
		structured<{ body: { text: string; base64: boolean; bytes: number; truncated: boolean } }>(result).body;
	assertEquals(body(await browserNetworkLog({ body_for: 'TXT' }, privileged)), {
		request_id: 'TXT',
		mime_type: 'text/html',
		base64: false,
		text: 'hello',
		bytes: 5,
		truncated: false,
	} as never);
	const big = body(await browserNetworkLog({ body_for: 'BIG' }, privileged));
	assertEquals(big.truncated, true);
	assertEquals(big.text.length, NETWORK_BODY_LIMIT_BYTES);
	assertEquals(big.bytes, NETWORK_BODY_LIMIT_BYTES + 10);
	const binary = body(await browserNetworkLog({ body_for: 'BIN' }, privileged));
	assertEquals(binary.base64, true);
	assertEquals(binary.text, encodeBase64(new Uint8Array([1, 2, 3])));
	assertEquals(f.client.bodySessions, ['S-page', 'S-page', 'S-page']);

	assertEquals((await refusal(() => browserNetworkLog({ body_for: 'NOPE' }, privileged))).code, 'invalid-arguments');
	f.request('GONE', 'https://app.example/g');
	assertEquals((await refusal(() => browserNetworkLog({ body_for: 'GONE' }, privileged))).code, 'file-unavailable');
});

Deno.test('R2-7: a text body is redacted whole, then cut — a secret straddling the 256 KiB cap leaves no prefix', async () => {
	await using f = await fixture();
	const privileged = f.ctx(['mcp:invoke', 'network:read']);
	f.request('EDGE', 'https://app.example/edge');
	// The secret starts four bytes before the cap: cut-then-redact would hand back its first four characters.
	f.client.bodies.set('EDGE', {
		body: `${'x'.repeat(NETWORK_BODY_LIMIT_BYTES - 4)}${SECRET}${'y'.repeat(16)}`,
		base64Encoded: false,
	});
	const body = structured<{ body: { text: string; bytes: number; truncated: boolean } }>(
		await browserNetworkLog({ body_for: 'EDGE' }, privileged),
	).body;
	assert(!body.text.endsWith(SECRET.slice(0, 4)), body.text.slice(-8));
	assertStringIncludes(body.text.slice(-8), '[sec');
	assertEquals(body.truncated, true);
	assertEquals(body.bytes, NETWORK_BODY_LIMIT_BYTES - 4 + SECRET.length + 16, 'bytes is the body’s own size');
});

Deno.test('inspection: the log is read through peek — no session, no browser', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('never')) });
	try {
		const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test', scopes: new Set(['mcp:invoke']) };
		for (const run of [browserNetworkLog, browserConsoleLog, browserHarExport]) {
			assertEquals((await refusal(() => run({}, ctx))).code, 'unknown-session');
		}
		assertEquals(registry.size, 0);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('inspection (AC5): the log is armed on launch, paged with since, and its bounds hold at the handler', async () => {
	await using f = await fixture();
	for (let index = 0; index < 600; index++) f.request(`R${index}`, `https://app.example/${index}`);
	const first = structured<{ entries: Array<{ seq: number }>; next_since: number; dropped: number }>(
		await browserNetworkLog({ limit: 500 }, f.ctx()),
	);
	assert(first.entries.length <= 500);
	assert(first.dropped > 0);
	assert(f.record.network.bytes <= 524_288);
	const next = structured<{ entries: unknown[]; dropped: number }>(
		await browserNetworkLog({ since: first.next_since }, f.ctx()),
	);
	assertEquals(next.entries, []);
	assertEquals(next.dropped, 0, 'nothing was evicted after the cursor');
});

// --- browser_console_log -------------------------------------------------------------------------------

Deno.test('inspection (AC5): the console claim arms capture, reports armed_since, and pages with since', async () => {
	let now = 1_767_225_600_000;
	await using f = await fixture(() => now);
	const first = structured<{ armed_since: string; entries: unknown[]; next_cursor: string; gap: unknown }>(
		await browserConsoleLog({}, f.ctx()),
	);
	INSPECTION_OUTPUT.browser_console_log.parse(first);
	assertEquals(first.armed_since, new Date(now).toISOString());
	assertEquals(first.entries, []);
	assertEquals(f.record.events.consoleSubscribers, 1);

	now += 1000;
	f.console('log', 'one');
	f.console('warning', `two ${SECRET}`);
	f.console('error', 'three');
	const all = structured<{ entries: Array<{ level: string; text: string }>; next_cursor: string }>(
		await browserConsoleLog({}, f.ctx()),
	);
	assertEquals(all.entries.map((entry) => entry.level), ['log', 'warn', 'error'], 'omitted since: from the claim');
	assert(!JSON.stringify(all).includes(SECRET), 'AC6: the secret never leaves through the console');
	assertEquals(all.entries[1]?.text, 'two [secret]');
	assertEquals(f.record.events.consoleSubscribers, 1, 'a second call refreshes the claim, it does not stack');

	const paged = structured<{ entries: Array<{ text: string }>; next_cursor: string }>(
		await browserConsoleLog({ since: first.next_cursor, limit: 1 }, f.ctx()),
	);
	assertEquals(paged.entries.map((entry) => entry.text), ['one']);
	const rest = structured<{ entries: Array<{ text: string }> }>(
		await browserConsoleLog({ since: paged.next_cursor, levels: ['error'] }, f.ctx()),
	);
	assertEquals(rest.entries.map((entry) => entry.text), ['three']);
	const after = structured<{ entries: unknown[] }>(await browserConsoleLog({ since: all.next_cursor }, f.ctx()));
	assertEquals(after.entries, []);
});

Deno.test('inspection (AC5): the console claim disarms after 10 minutes without a call, and at close', async () => {
	await using f = await fixture();
	using time = new FakeTime();
	await browserConsoleLog({}, f.ctx());
	assertEquals(f.record.events.consoleSubscribers, 1);
	time.tick(CONSOLE_CLAIM_IDLE_MS - 1);
	await browserConsoleLog({}, f.ctx());
	time.tick(CONSOLE_CLAIM_IDLE_MS - 1);
	assertEquals(f.record.events.consoleSubscribers, 1, 'each call restarts the idle window');
	time.tick(2);
	assertEquals(f.record.events.consoleSubscribers, 0);
	assertEquals(f.record.consoleClaim, undefined);

	await browserConsoleLog({}, f.ctx());
	assertEquals(f.record.events.consoleSubscribers, 1);
	await f.registry.close(f.record.id);
	assertEquals(f.record.consoleClaim, undefined, 'closing the session releases the claim and its timer');
	assertEquals(CONSOLE_CLAIM_IDLE_MS, 600_000);
});

Deno.test('inspection: a console cursor from another incarnation reads as a gap, never as silence', async () => {
	await using f = await fixture();
	await browserConsoleLog({}, f.ctx());
	f.console('log', 'kept');
	const page = structured<{ gap: { reason: string } | null; entries: Array<{ text: string }> }>(
		await browserConsoleLog({ since: 'OTHER-EPOCH:4' }, f.ctx()),
	);
	assertEquals(page.gap?.reason, 'epoch-changed');
	assertEquals(page.entries.map((entry) => entry.text), ['kept']);
});

// --- browser_har_export --------------------------------------------------------------------------------

interface Har {
	log: {
		version: string;
		creator: { name: string; version: string };
		entries: Array<{
			startedDateTime: string;
			time: number;
			request: {
				method: string;
				url: string;
				httpVersion: string;
				cookies: unknown[];
				headers: Array<{ name: string; value: string }>;
				queryString: unknown[];
				headersSize: number;
				bodySize: number;
			};
			response: {
				status: number;
				statusText: string;
				httpVersion: string;
				cookies: unknown[];
				headers: Array<{ name: string; value: string }>;
				content: { size: number; mimeType: string };
				redirectURL: string;
				headersSize: number;
				bodySize: number;
			};
			cache: Record<string, unknown>;
			timings: { send: number; wait: number; receive: number };
		}>;
	};
}

function harOf(result: ToolResult): Har {
	const block = (result as { content: Array<{ type: string; resource?: { mimeType: string; text: string } }> })
		.content.find((entry) => entry.type === 'resource');
	assertEquals(block?.resource?.mimeType, 'application/json');
	return JSON.parse(block?.resource?.text ?? '{}') as Har;
}

/** The HAR 1.2 members the specification requires, checked by type on every entry. */
function assertHar12(har: Har): void {
	assertEquals(har.log.version, '1.2');
	assertEquals(typeof har.log.creator.name, 'string');
	assertEquals(typeof har.log.creator.version, 'string');
	for (const entry of har.log.entries) {
		assert(!Number.isNaN(Date.parse(entry.startedDateTime)), entry.startedDateTime);
		assertEquals(typeof entry.time, 'number');
		for (const key of ['method', 'url', 'httpVersion'] as const) assertEquals(typeof entry.request[key], 'string');
		for (const key of ['cookies', 'headers', 'queryString'] as const) assert(Array.isArray(entry.request[key]));
		for (const key of ['headersSize', 'bodySize'] as const) assertEquals(typeof entry.request[key], 'number');
		assertEquals(typeof entry.response.status, 'number');
		for (const key of ['statusText', 'httpVersion', 'redirectURL'] as const) {
			assertEquals(typeof entry.response[key], 'string');
		}
		for (const key of ['cookies', 'headers'] as const) assert(Array.isArray(entry.response[key]));
		assertEquals(typeof entry.response.content.size, 'number');
		assertEquals(typeof entry.response.content.mimeType, 'string');
		assertEquals(typeof entry.cache, 'object');
		for (const key of ['send', 'wait', 'receive'] as const) assert(entry.timings[key] >= -1, key);
	}
}

Deno.test('inspection (AC4/AC5): the HAR is 1.2, cookie-free, and origin+path only without full-URL permission', async () => {
	await using f = await fixture();
	f.client.emit('Network.requestWillBeSent', {
		requestId: 'H',
		request: { url: 'https://app.example/start?x=1', method: 'GET', headers: { Cookie: 'sid=Zq8-C' } },
		timestamp: 1,
		wallTime: 1_767_225_600,
		type: 'Document',
	});
	f.client.emit('Network.requestWillBeSent', {
		requestId: 'H',
		request: { url: 'https://app.example/landing?code=Zq8-CODE', method: 'GET', headers: {} },
		timestamp: 1.1,
		wallTime: 1_767_225_600.1,
		type: 'Document',
		redirectResponse: {
			url: 'https://app.example/start?x=1',
			status: 302,
			headers: { Location: 'https://app.example/landing?code=Zq8-CODE', 'Set-Cookie': 'a=Zq8-SC' },
			mimeType: '',
		},
	});
	f.request('S', `https://app.example/s?q=${SECRET}`);
	const result = await browserHarExport({}, f.ctx());
	const payload = structured<{ entries: number; bytes: number; truncated: boolean }>(result);
	INSPECTION_OUTPUT.browser_har_export.parse(payload);
	const har = harOf(result);
	assertHar12(har);
	assertEquals(har.log.creator, { name: 'tykotech-mcp', version: '9.9.9-test' });
	assertEquals(payload.entries, har.log.entries.length);
	assertEquals(payload.truncated, false);
	assert(payload.bytes <= HAR_MAX_BYTES);
	const [first] = har.log.entries;
	assertEquals(first?.request.url, 'https://app.example/start');
	assertEquals(first?.request.queryString, []);
	assertEquals(first?.response.status, 302);
	assertEquals(first?.response.redirectURL, 'https://app.example/landing');
	for (const entry of har.log.entries) {
		assertEquals(entry.request.cookies, []);
		assertEquals(entry.response.cookies, []);
	}
	const text = JSON.stringify(result);
	assert(!/Zq8-[A-Z]/.test(text), text);
	assert(!text.includes(SECRET), 'AC6: the secret never leaves through the HAR');

	// Full-URL permission: the scope and the ask, together.
	assertEquals((await refusal(() => browserHarExport({ include_full_urls: true }, f.ctx()))).code, 'scope-required');
	const full = harOf(await browserHarExport({ include_full_urls: true }, f.ctx(['mcp:invoke', 'network:read'])));
	assertEquals(full.log.entries[0]?.request.url, 'https://app.example/start?x=1');
	assertEquals(full.log.entries[0]?.request.queryString, [{ name: 'x', value: '1' }]);
	assertEquals(full.log.entries[0]?.response.redirectURL, 'https://app.example/landing?code=Zq8-CODE');
	assertEquals(full.log.entries[0]?.request.cookies, []);
	assert(!JSON.stringify(full).includes(SECRET), 'redaction holds with full URLs too');
});

Deno.test('inspection (AC5): HAR max_entries keeps the newest, truncated says so, and over 1 MiB is refused', async () => {
	await using f = await fixture();
	for (let index = 0; index < 5; index++) f.request(`R${index}`, `https://app.example/${index}`);
	const two = await browserHarExport({ max_entries: 2 }, f.ctx());
	assertEquals(structured<{ entries: number; truncated: boolean }>(two), {
		session_id: f.record.id,
		entries: 2,
		bytes: structured<{ bytes: number }>(two).bytes,
		truncated: true,
	} as never);
	assertEquals(harOf(two).log.entries.map((entry) => entry.request.url), [
		'https://app.example/3',
		'https://app.example/4',
	]);

	// The log's own 512 KiB bound keeps most HARs far under 1 MiB; many tiny headers are where HAR's per-header
	// `{"name":…,"value":…}` overhead triples the size, which is the case the cap exists for.
	const fat: Record<string, string> = {};
	for (let index = 0; index < 600; index++) fat[`h${index}`] = 'v';
	for (let index = 0; index < 200; index++) {
		f.request(`F${index}`, `https://app.example/f/${index}`, { requestHeaders: fat });
	}
	const over = await refusal(() => browserHarExport({}, f.ctx()));
	assertEquals(over.code, 'file-unavailable');
	assertStringIncludes(over.message, 'max_entries');
});
