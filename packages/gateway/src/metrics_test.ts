/**
 * C11 (D-101, AC8): `GET /metrics` serves Prometheus text 0.0.4 to `metrics:read` or `admin`, 403 to anyone else,
 * and does not exist at all (404) unless `TTK_METRICS` is on. Labels are route patterns and catalog names, never
 * paths or arguments.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { SCOPES, SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import {
	escapeLabel,
	GatewayMetrics,
	MAX_SERIES,
	mayReadMetrics,
	METRICS_SCOPE,
	PROMETHEUS_CONTENT_TYPE,
	toolOutcome,
} from './metrics.ts';

const ORIGIN = 'http://127.0.0.1:8787';

Deno.test('C11: the exposition is well-formed text 0.0.4 with every family typed', () => {
	const metrics = new GatewayMetrics();
	metrics.observeRequest('GET', '/healthz', 200);
	metrics.observeRequest('GET', '/healthz', 200);
	metrics.observeRequest('POST', '/api/v1/auth/login', 401);
	metrics.observeRequest('GET', '/api/v1/sessions', 429);
	metrics.observeToolCall('browser_navigate', 'ok');
	metrics.observeToolCall('browser_navigate', 'error');
	const text = metrics.render({
		sessions: [
			{ tab_count: 1, viewer_count: 2, human_has_control: false },
			{ tab_count: 0, viewer_count: 0, human_has_control: false },
			{ tab_count: 1, viewer_count: 1, human_has_control: true },
		],
		memory: { rss: 10, heapTotal: 8, heapUsed: 4, external: 2 },
	});
	assert(text.endsWith('\n'), 'the format ends every line, the last included');
	for (
		const [name, type] of [
			['ttk_http_requests_total', 'counter'],
			['ttk_tool_calls_total', 'counter'],
			['ttk_sessions', 'gauge'],
			['ttk_viewers', 'gauge'],
			['ttk_rate_limited_total', 'counter'],
			['ttk_login_failures_total', 'counter'],
			['ttk_process_resident_memory_bytes', 'gauge'],
			['ttk_process_heap_used_bytes', 'gauge'],
		] as const
	) {
		assertStringIncludes(text, `# TYPE ${name} ${type}\n`);
		assertStringIncludes(text, `# HELP ${name} `);
	}
	assertStringIncludes(text, 'ttk_http_requests_total{route="/healthz",status="200"} 2\n');
	assertStringIncludes(text, 'ttk_tool_calls_total{tool="browser_navigate",outcome="error"} 1\n');
	assertStringIncludes(text, 'ttk_sessions{state="active"} 1\n');
	assertStringIncludes(text, 'ttk_sessions{state="idle"} 1\n');
	assertStringIncludes(text, 'ttk_sessions{state="human_control"} 1\n');
	assertStringIncludes(text, 'ttk_viewers 3\n');
	assertStringIncludes(text, 'ttk_rate_limited_total 1\n');
	assertStringIncludes(text, 'ttk_login_failures_total 1\n');
	assertStringIncludes(text, 'ttk_process_resident_memory_bytes 10\n');
	// Every sample line is `name{labels} value` or `name value`; nothing else may appear outside a comment.
	for (const line of text.trimEnd().split('\n')) {
		if (line.startsWith('# ')) continue;
		assert(/^[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? \d+$/.test(line), line);
	}
	// Without a memory reading the process gauges are absent rather than zero.
	assertEquals(metrics.render({ sessions: [], memory: null }).includes('ttk_process_'), false);
});

Deno.test('C11: label values are escaped, and a family past MAX_SERIES folds into one other series', () => {
	assertEquals(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
	const metrics = new GatewayMetrics();
	for (let i = 0; i < MAX_SERIES + 10; i += 1) metrics.observeRequest('GET', `/r${i}`, 200);
	const lines = metrics.render({ sessions: [], memory: null }).split('\n')
		.filter((line) => line.startsWith('ttk_http_requests_total{'));
	assertEquals(lines.length, MAX_SERIES + 1);
	assert(lines.includes('ttk_http_requests_total{route="other",status="other"} 10'), lines.slice(-2).join('\n'));
});

Deno.test('C11: the scope rule and the tool outcome', () => {
	assertEquals(mayReadMetrics(new Set([METRICS_SCOPE])), true);
	assertEquals(mayReadMetrics(new Set(['admin'])), true);
	assertEquals(mayReadMetrics(new Set(['mcp:invoke', 'view:watch', 'files:read'])), false);
	assertEquals(toolOutcome({ content: [] }), 'ok');
	assertEquals(toolOutcome({ isError: true, content: [] }), 'error');
});

interface Fixture {
	readonly request: (path: string, token: string | null, init?: RequestInit) => Promise<Response>;
	readonly admin: string;
	readonly plain: string;
	readonly close: () => Promise<void>;
}

async function fixture(env: Record<string, string>): Promise<Fixture> {
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'admin']);
	const plain = await generateApiKey('plain-key', ['mcp:invoke', 'view:watch']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([admin.record, plain.record]),
		...env,
	});
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
	});
	return {
		request: async (path, token, init = {}) =>
			await gateway.app.request(`${ORIGIN}${path}`, {
				...init,
				headers: {
					host: '127.0.0.1:8787',
					...(token === null ? {} : { authorization: `Bearer ${token}` }),
					...(init.headers as Record<string, string> | undefined),
				},
			}),
		admin: admin.key,
		plain: plain.key,
		close: async () => {
			await gateway.close();
			await registry.shutdown();
		},
	};
}

Deno.test('C11 (AC8): /metrics is 404 while TTK_METRICS is off, even for an administrator', async () => {
	const f = await fixture({});
	try {
		const response = await f.request('/metrics', f.admin);
		assertEquals(response.status, 404);
		await response.body?.cancel();
	} finally {
		await f.close();
	}
});

Deno.test('C11 (AC8): /metrics serves admin, refuses a credential without the scope, and counts by pattern', async () => {
	const f = await fixture({ TTK_METRICS: 'true' });
	try {
		const refused = await f.request('/metrics', f.plain);
		assertEquals(refused.status, 403);
		assertStringIncludes((await refused.json()).detail, METRICS_SCOPE);
		const anonymous = await f.request('/metrics', null);
		assertEquals(anonymous.status, 401);
		await anonymous.body?.cancel();

		// Traffic to count: a session-addressed route (labelled by its pattern, not its ids), an unmatched path, a
		// failed sign-in, and two tool calls — one served, one refused as a result.
		for (
			const [path, token, init] of [
				['/api/v1/sessions/s-123/files/f-456', f.plain, {}],
				['/no/such/route', f.plain, {}],
				['/api/v1/auth/login', null, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ apiKey: 'ttk_wrong' }),
				}],
			] as const
		) {
			await (await f.request(path, token, init)).body?.cancel();
		}
		const call = async (name: string): Promise<void> => {
			const response = await f.request('/mcp', f.plain, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
			});
			assertEquals(response.status, 200);
			await response.body?.cancel();
		};
		await call('browser_list_sessions');
		await call('browser_evaluate');

		const response = await f.request('/metrics', f.admin);
		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), PROMETHEUS_CONTENT_TYPE);
		assertEquals(response.headers.get('cache-control'), 'no-store');
		const text = await response.text();
		assertStringIncludes(text, 'ttk_http_requests_total{route="/api/v1/sessions/:sessionId/files/:fileId",status="');
		assertEquals(text.includes('s-123'), false, 'a path segment never becomes a label');
		assertStringIncludes(text, 'ttk_http_requests_total{route="unmatched",status="404"} 1');
		assertStringIncludes(text, 'ttk_http_requests_total{route="/metrics",status="403"} 1');
		assertStringIncludes(text, 'ttk_login_failures_total 1');
		assertStringIncludes(text, 'ttk_tool_calls_total{tool="browser_list_sessions",outcome="ok"} 1');
		assertStringIncludes(text, 'ttk_tool_calls_total{tool="browser_evaluate",outcome="error"} 1');
		assertStringIncludes(text, 'ttk_sessions{state="active"} 0');
		assertStringIncludes(text, 'ttk_process_resident_memory_bytes ');
		assertEquals(text.includes('ttk_wrong'), false, 'no credential reaches the exposition');
	} finally {
		await f.close();
	}
});

// `metrics:read` joins the vocabulary in `scopes.ts` (W2); until it does no credential can hold it, and this test
// says so instead of passing vacuously.
const vocabularyHasMetricsScope = (SCOPES as readonly string[]).includes(METRICS_SCOPE);
Deno.test({
	name: 'C11 (AC8): a credential holding only metrics:read reads /metrics',
	ignore: !vocabularyHasMetricsScope,
	async fn() {
		const scraper = await generateApiKey('scraper', [METRICS_SCOPE] as never);
		const config = loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: '8787',
			TTK_API_KEYS: JSON.stringify([scraper.record]),
			TTK_METRICS: 'true',
		});
		const registry = new SessionRegistry({ reapIntervalMs: 0 });
		const gateway = createGatewayApp({
			config,
			verifier: new VerifierChain({ config, allowAnonymous: false }),
			registry,
			version: 'test',
			logger: createLogger({ level: 'error', write: () => {} }),
		});
		try {
			const response = await gateway.app.request(`${ORIGIN}/metrics`, {
				headers: { host: '127.0.0.1:8787', authorization: `Bearer ${scraper.key}` },
			});
			assertEquals(response.status, 200);
			assertStringIncludes(await response.text(), '# TYPE ttk_http_requests_total counter');
		} finally {
			await gateway.close();
			await registry.shutdown();
		}
	},
});
