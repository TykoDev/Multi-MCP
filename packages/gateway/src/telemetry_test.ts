/**
 * R7 — tool-call OpenTelemetry (design §2.15, D-127, AC24). With OTel off (the unit tier never sets `OTEL_DENO`)
 * nothing throws and nothing is traced; with a recording stand-in for `Deno.telemetry`, every dispatched call — over
 * `tools/call` and through an agent task's executor alike — opens one `ttk.tool` span whose attributes are `tool` and
 * `outcome` and nothing else, and counts it. The runtime's own export (URLs, console) is measured by M1–M3.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { childEnvOverrides, createToolExecutor, SessionRegistry, UNKNOWN_TOOL } from '@tykotech/mcp';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { generateApiKey } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { Recorder } from './recorder.ts';
import { startGateway } from './server.ts';
import {
	createTelemetry,
	type Telemetry,
	TELEMETRY_SCOPE,
	TELEMETRY_WARNING,
	type TelemetryApi,
	TOOL_COUNTER,
	TOOL_SPAN,
} from './telemetry.ts';

interface RecordedSpan {
	name: string;
	attributes: Record<string, string>;
	status: number | null;
	ended: number;
}

/** A recording stand-in for `Deno.telemetry`: spans and counter adds, as an exporter would see them. */
function recordingApi(options: { throwOnSpan?: boolean } = {}) {
	const spans: RecordedSpan[] = [];
	const counts: Array<{ value: number; attributes: Record<string, string> }> = [];
	const scopes: string[] = [];
	const counters: string[] = [];
	const api: TelemetryApi = {
		tracerProvider: {
			getTracer: (name) => {
				scopes.push(`tracer:${name}`);
				return {
					startSpan: (spanName, init) => {
						if (options.throwOnSpan === true) throw new Error('exporter is broken');
						const span: RecordedSpan = { name: spanName, attributes: { ...init?.attributes }, status: null, ended: 0 };
						spans.push(span);
						return {
							setAttribute: (key: string, value: string) => (span.attributes[key] = value),
							setStatus: (status: { code: number }) => (span.status = status.code),
							end: () => void (span.ended += 1),
						};
					},
				};
			},
		},
		meterProvider: {
			getMeter: (name) => {
				scopes.push(`meter:${name}`);
				return {
					createCounter: (counter) => {
						counters.push(counter);
						return { add: (value, attributes) => void counts.push({ value, attributes: { ...attributes } }) };
					},
				};
			},
		},
	};
	return { api, spans, counts, scopes, counters };
}

function silentLogger() {
	const warnings: string[] = [];
	return { warnings, logger: { warn: (message: string) => void warnings.push(message) } };
}

Deno.test('R7: with OpenTelemetry off nothing throws, nothing is traced, and nothing is said', () => {
	const { warnings, logger } = silentLogger();
	// The unit tier runs without OTEL_DENO, so the real `Deno.telemetry` answers "otel not initialized".
	const telemetry = createTelemetry(logger);
	assertEquals(telemetry.active, false);
	const trace = telemetry.traceTool('browser_navigate');
	trace.end('ok');
	trace.end('error');
	assertEquals(warnings, []);
});

Deno.test('R7: a probe that throws — the "otel not initialized" shape — yields the inactive instance', () => {
	const { warnings, logger } = silentLogger();
	const broken = {
		tracerProvider: { getTracer: () => ({ startSpan: () => ({}) }) },
		meterProvider: {
			getMeter: () => {
				throw new Error('otel not initialized');
			},
		},
	} as unknown as TelemetryApi;
	const telemetry = createTelemetry(logger, broken);
	assertEquals(telemetry.active, false);
	assertEquals(warnings, []);
});

Deno.test('R7: an active instance opens ttk.tool with tool and outcome only, counts it, and warns once (M1)', () => {
	const { warnings, logger } = silentLogger();
	const recorded = recordingApi();
	const telemetry = createTelemetry(logger, recorded.api);
	assertEquals(telemetry.active, true);
	assertEquals(warnings, [TELEMETRY_WARNING]);
	assertStringIncludes(TELEMETRY_WARNING, 'OTEL_DENO_CONSOLE=ignore');
	assertStringIncludes(TELEMETRY_WARNING, 'url.query');
	// D-137: the export goes to the allowlisted collector, the edge gate having refused any other.
	assertStringIncludes(TELEMETRY_WARNING, 'to the allowlisted collector');
	assert(!TELEMETRY_WARNING.includes('not bounded by --allow-net'), 'the destination is bounded now, by the gate');
	assertEquals(recorded.scopes.sort(), [`meter:${TELEMETRY_SCOPE}`, `tracer:${TELEMETRY_SCOPE}`]);
	assertEquals(recorded.counters, [TOOL_COUNTER]);

	const ok = telemetry.traceTool('browser_get_state');
	ok.end('ok');
	ok.end('error'); // a second end changes nothing
	const failed = telemetry.traceTool('browser_click');
	failed.end('error');
	const asked = telemetry.traceTool('browser_run_task');
	asked.end('input_required');

	assertEquals(recorded.spans.map((span) => [span.name, span.attributes, span.status, span.ended]), [
		[TOOL_SPAN, { tool: 'browser_get_state', outcome: 'ok' }, null, 1],
		[TOOL_SPAN, { tool: 'browser_click', outcome: 'error' }, 2, 1],
		[TOOL_SPAN, { tool: 'browser_run_task', outcome: 'input_required' }, null, 1],
	]);
	assertEquals(recorded.counts, [
		{ value: 1, attributes: { tool: 'browser_get_state', outcome: 'ok' } },
		{ value: 1, attributes: { tool: 'browser_click', outcome: 'error' } },
		{ value: 1, attributes: { tool: 'browser_run_task', outcome: 'input_required' } },
	]);
});

Deno.test('R7: a broken exporter never reaches the tool call', () => {
	const { logger } = silentLogger();
	const recorded = recordingApi({ throwOnSpan: true });
	const telemetry = createTelemetry(logger, recorded.api);
	const trace = telemetry.traceTool('browser_get_state');
	trace.end('ok');
	assertEquals(recorded.counts.length, 1, 'the count still lands when the span cannot open');
});

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'telemetry-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

Deno.test('R7: every tools/call through the gateway is one span with only tool and outcome', async () => {
	const key = await generateApiKey('tracer', ['mcp:invoke', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([key.record]),
		TTK_LOG_LEVEL: 'error',
	});
	const recorded = recordingApi();
	const telemetry: Telemetry = createTelemetry({ warn: () => {} }, recorded.api);
	const gateway = await startGateway({
		config,
		version: '0.0.0-test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve(fakeSession()),
		telemetry,
	});
	const client = new Client({ name: 'telemetry-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
				fetch: (input, init) => {
					const headers = new Headers(init?.headers);
					headers.set('authorization', `Bearer ${key.key}`);
					return fetch(input, { ...init, headers });
				},
			}),
		);
		await client.callTool({ name: 'browser_list_sessions', arguments: {} });
		await client.callTool({ name: 'browser_close_session', arguments: { session_id: 'secret-looking-id' } });
		await client.callTool({ name: 'no_such_tool', arguments: { url: 'https://x.test/?ticket=lvt_x' } }).catch(
			() => {},
		);
		assertEquals(recorded.spans.map((span) => span.attributes), [
			{ tool: 'browser_list_sessions', outcome: 'ok' },
			{ tool: 'browser_close_session', outcome: 'error' },
			{ tool: UNKNOWN_TOOL, outcome: 'error' },
		]);
		const exported = JSON.stringify([recorded.spans, recorded.counts]);
		assert(!exported.includes('secret-looking-id'), 'no argument value reaches an attribute');
		assert(!exported.includes('lvt_x') && !exported.includes('no_such_tool'), 'a non-catalog name never mints one');

		const diagnostics = await fetch(`${gateway.url}/api/v1/system/diagnostics`, {
			headers: { authorization: `Bearer ${key.key}` },
		});
		const body = await diagnostics.json() as { config: { telemetry?: unknown; sessionOwnership?: unknown } };
		assertEquals(body.config.telemetry, true);
		// D-150: `owner` is the single-node default.
		assertEquals(body.config.sessionOwnership, 'owner');
	} finally {
		await client.close();
		await gateway.shutdown();
		await gateway.finished;
	}
});

Deno.test('R7: an agent task executor traces its calls through the same wrapper', async () => {
	const recorded = recordingApi();
	const telemetry = createTelemetry({ warn: () => {} }, recorded.api);
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	try {
		const run = createToolExecutor(
			{ registry, version: '0', traceTool: telemetry.traceTool },
			'api-key:tracer',
			new Set(['mcp:invoke']),
		);
		await run('browser_list_sessions', {});
		assertEquals(recorded.spans.map((span) => span.attributes), [{ tool: 'browser_list_sessions', outcome: 'ok' }]);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('D-127 (AC25): the recorder spawns ffmpeg with the same blank overrides Chromium gets', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'recorder-env-' });
	const spawned: Array<{ command: string; env: Record<string, string> }> = [];
	const recorder = new Recorder({
		registry,
		// One frame at once: `start` waits for the first frame on an unref'd timer.
		subscribe: (_sessionId, onFrame) => {
			queueMicrotask(() => onFrame(btoa('ÿØÿÙ')));
			return Promise.resolve(() => {});
		},
		dir,
		ffmpeg: '/usr/bin/ffmpeg',
		logger: createLogger({ level: 'error', write: () => {} }),
		spawn: (command, options) => {
			spawned.push({ command, env: options.env });
			// An encoder that refuses at once, so `start` fails fast after the spawn this test is about.
			return {
				stdin: new WritableStream<Uint8Array>(),
				stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
				status: Promise.resolve({ success: false, code: 1, signal: null }),
				kill: () => {},
			};
		},
	});
	try {
		const record = await registry.resolve(undefined);
		const failed = await recorder.start(record.id, 'env-probe').then(() => null, (cause: unknown) => cause);
		assertStringIncludes(String(failed), 'ffmpeg exited immediately');
		assertEquals(spawned.length, 1);
		assertEquals(spawned[0]!.command, '/usr/bin/ffmpeg');
		assertEquals(spawned[0]!.env, childEnvOverrides());
		assertEquals(spawned[0]!.env.OTEL_EXPORTER_OTLP_HEADERS, '');
		assertEquals(spawned[0]!.env.TTK_API_KEYS, '');
		assertEquals('HTTPS_PROXY' in spawned[0]!.env, false, 'proxies still inherit: no clearEnv');
	} finally {
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('R7: diagnostics report telemetry off where the runtime does not export', async () => {
	const key = await generateApiKey('root', ['admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([key.record]),
		TTK_LOG_LEVEL: 'error',
		TTK_SESSION_OWNERSHIP: 'Owner',
		// AC8 (D-137, D-138): the collector list and the request scope are reported as configured.
		TTK_OTEL_ENDPOINTS: 'http://collector.test:4318, https://otel.example.test',
		TTK_ALLOWED_DOMAINS: 'example.test',
		TTK_ALLOWED_DOMAINS_SCOPE: 'all',
	});
	const gateway = await startGateway({
		config,
		version: '0.0.0-test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve(fakeSession()),
	});
	try {
		const response = await fetch(`${gateway.url}/api/v1/system/diagnostics`, {
			headers: { authorization: `Bearer ${key.key}` },
		});
		const body = await response.json() as {
			config: {
				telemetry?: unknown;
				sessionOwnership?: unknown;
				otelEndpoints?: unknown;
				allowedDomainsScope?: unknown;
			};
		};
		assertEquals(body.config.telemetry, false);
		assertEquals(body.config.sessionOwnership, 'owner', 'the value is read case-insensitively');
		assertEquals(body.config.otelEndpoints, ['http://collector.test:4318', 'https://otel.example.test']);
		assertEquals(body.config.allowedDomainsScope, 'all');
	} finally {
		await gateway.shutdown();
		await gateway.finished;
	}
});
