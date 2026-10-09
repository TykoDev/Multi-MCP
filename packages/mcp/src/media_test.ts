/**
 * The browser-output handlers (R10, R11; design §2.7–§2.8): `browser_pdf`, `browser_file_link`,
 * `browser_accessibility_snapshot` and `browser_performance`, against a capture-backed session (D-TEST1) whose CDP
 * round trips are scripted and recorded — the content of these tests is what was sent where, and what came back
 * out of the tool. The browser tier (`tests/e2e/media_e2e_test.ts`) drives the same handlers on Chrome 154.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { encodeBase64 } from '@std/encoding/base64';
import { fromFileUrl } from '@std/path';
import { NavigateToUrlEvent } from '@tykotech/browser';
import { captureSession, loadCapture } from '../fixtures/capture_session.ts';
import { MEDIA_OUTPUT } from './catalog/media.ts';
import { CATALOG_BY_NAME } from './catalog.ts';
import { ToolError } from './errors.ts';
import { INLINE_FILE_LIMIT_BYTES } from './files.ts';
import { type SessionRecord, SessionRegistry } from './registry.ts';
import { SecretStore } from './secrets.ts';
import {
	browserAccessibilitySnapshot,
	browserFileLink,
	browserPdf,
	browserPerformance,
	PDF_MAX_BYTES,
	PDF_READ_CHUNK_BYTES,
	PDF_TIMEOUT_MS,
	runtimeOf,
	VITALS_SCRIPT,
	vitalsOf,
} from './tools/media.ts';
import type { SignedLinkMinter, ToolContext, ToolResult } from './types.ts';
import { browserDownload } from './tools/files.ts';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));

interface Call {
	method: string;
	sessionId: string;
	params: Record<string, unknown>;
	opts?: Record<string, unknown>;
}

interface Script {
	pdf?: (params: Record<string, unknown>) => Promise<{ data: string; stream?: string }>;
	/** Review R2-7: `IO.read` / `IO.close` on a streamed print. */
	io?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
	evaluate?: (params: Record<string, unknown>) => Promise<unknown>;
	metrics?: () => Promise<unknown>;
	axFull?: (params: Record<string, unknown>) => Promise<{ nodes: unknown[] }>;
	axPartial?: (params: Record<string, unknown>) => Promise<{ nodes: unknown[] }>;
}

/** A capture-backed session with a download directory, wired to a scripted CDP client. */
async function harness(page = 'live_value_vs_attribute', script: Script = {}) {
	const capture = await loadCapture(page);
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	const dir = await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix: 'media-' });
	const session = captureSession(capture);
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session, downloads: null, downloadsDir: dir }),
	});
	const record = await registry.resolve(undefined);
	const root = capture.sessions[0]!;
	const pageSession = root.sessionId;
	const calls: Call[] = [];
	const push = (method: string, params: unknown, sessionId: unknown, opts?: unknown) =>
		calls.push({
			method,
			sessionId: String(sessionId),
			params: (params ?? {}) as Record<string, unknown>,
			...(opts === undefined ? {} : { opts: opts as Record<string, unknown> }),
		});
	const client = {
		send: {
			Page: {
				printToPDF(params: Record<string, unknown>, sessionId: string, opts: unknown) {
					push('Page.printToPDF', params, sessionId, opts);
					return script.pdf?.(params) ?? Promise.resolve({ data: encodeBase64('%PDF-1.7 small') });
				},
				getFrameTree(params: unknown, sessionId: string) {
					push('Page.getFrameTree', params, sessionId);
					return Promise.resolve({ frameTree: { frame: { id: root.frameId, url: root.url } } });
				},
				createIsolatedWorld(params: Record<string, unknown>, sessionId: string) {
					push('Page.createIsolatedWorld', params, sessionId);
					return Promise.resolve({ executionContextId: 77 });
				},
			},
			Runtime: {
				evaluate(params: Record<string, unknown>, sessionId: string, opts: unknown) {
					push('Runtime.evaluate', params, sessionId, opts);
					return script.evaluate?.(params) ??
						Promise.resolve({
							result: {
								type: 'object',
								value: {
									ttfb_ms: 3.456,
									dcl_ms: 10,
									load_ms: 11,
									fcp_ms: 90,
									lcp_ms: 120,
									cls: 0.123456,
									inp_ms: null,
								},
							},
						});
				},
			},
			Accessibility: {
				getFullAXTree(params: Record<string, unknown>, sessionId: string) {
					push('Accessibility.getFullAXTree', params, sessionId);
					return script.axFull?.(params) ?? Promise.resolve({ nodes: root.axNodes as unknown[] });
				},
				getPartialAXTree(params: Record<string, unknown>, sessionId: string) {
					push('Accessibility.getPartialAXTree', params, sessionId);
					const backend = params.backendNodeId;
					return script.axPartial?.(params) ??
						Promise.resolve({
							nodes: root.axNodes.filter((node) => node.backendDOMNodeId === backend),
						});
				},
			},
		},
		sendRaw(method: string, params: unknown, sessionId: string) {
			push(method, params, sessionId);
			if (method.startsWith('IO.')) {
				return script.io?.(method, (params ?? {}) as Record<string, unknown>) ?? Promise.resolve({});
			}
			if (method === 'Performance.getMetrics') {
				return script.metrics?.() ??
					Promise.resolve({
						metrics: [
							{ name: 'JSHeapUsedSize', value: 1_234_567 },
							{ name: 'Nodes', value: 321 },
							{ name: 'LayoutCount', value: 4 },
							{ name: 'RecalcStyleCount', value: 5 },
							{ name: 'ScriptDuration', value: 0.25 },
							{ name: 'TaskDuration', value: 0.5 },
							{ name: 'Timestamp', value: 99 },
						],
					});
			}
			return Promise.resolve({});
		},
	};
	const manager = {
		getOrCreateCdpSession(target: string, _focus: boolean) {
			return Promise.resolve({ sessionId: pageSession, targetId: target });
		},
	};
	Object.assign(session as object, { cdpClient: client, sessionManager: manager, agentFocusTargetId: root.targetId });
	const ctx: ToolContext = {
		registry,
		allowedDomains: [],
		principal: 'test',
		access: { owner: 'api-key:test', admin: false },
	};
	return {
		capture,
		registry,
		record,
		ctx,
		calls,
		dir,
		pageSession,
		methods: () => calls.map((call) => call.method),
		async [Symbol.asyncDispose]() {
			await registry.shutdown();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

/** The success's structured payload, after asserting it round-trips its declared schema without losing a field. */
function structured(name: keyof typeof MEDIA_OUTPUT, result: ToolResult): Record<string, unknown> {
	const call = result as { isError?: boolean; structuredContent?: Record<string, unknown> };
	assertEquals(call.isError, undefined);
	const payload = call.structuredContent;
	assert(payload !== undefined, `${name} returned no structuredContent`);
	assertEquals(CATALOG_BY_NAME.get(name)?.outputSchema, MEDIA_OUTPUT[name], 'the catalog declares this schema');
	assertEquals(MEDIA_OUTPUT[name].parse(payload), payload, `${name} emits a field its schema does not declare`);
	return payload;
}

function hold(record: SessionRecord): void {
	record.lock = { holder: 'viewer-1', principal: 'human', takenAt: 0, holderName: null };
}

// --- browser_pdf ------------------------------------------------------------------------------------------------

Deno.test('R10: browser_pdf prints with no header or footer, A4 and backgrounds by default, under the 30 s cap', async () => {
	await using h = await harness();
	// A read: it works while a human holds the session.
	hold(h.record);
	const result = await browserPdf({}, h.ctx);
	const payload = structured('browser_pdf', result);
	assertEquals(payload, { session_id: 'default', delivery: 'inline', bytes: '%PDF-1.7 small'.length });
	const block = (result as { content: Array<{ type: string; resource?: { mimeType?: string; blob?: string } }> })
		.content[1];
	assertEquals(block?.type, 'resource');
	assertEquals(block?.resource?.mimeType, 'application/pdf');
	assertEquals(atob(block?.resource?.blob ?? ''), '%PDF-1.7 small');
	const sent = h.calls.find((call) => call.method === 'Page.printToPDF');
	assert(sent !== undefined);
	assertEquals(sent.sessionId, h.pageSession);
	assertEquals(sent.params, {
		landscape: false,
		printBackground: true,
		paperWidth: 8.27,
		paperHeight: 11.69,
		displayHeaderFooter: false,
		transferMode: 'ReturnAsStream',
	});
	assertEquals(sent.opts, { requestTimeoutMs: PDF_TIMEOUT_MS });
	assertEquals(PDF_TIMEOUT_MS, 30_000);
	// Never a template: they are HTML rendered with the page's privileges.
	assert(!('headerTemplate' in sent.params) && !('footerTemplate' in sent.params));
});

Deno.test('R10: browser_pdf passes the caller’s layout through, and a bad range is the caller’s argument', async () => {
	await using h = await harness('live_value_vs_attribute', {
		pdf: (params) =>
			params.pageRanges === '9-9'
				? Promise.reject(new Error('Page range exceeds page count'))
				: Promise.resolve({ data: encodeBase64('%PDF') }),
	});
	await browserPdf(
		{ landscape: true, print_background: false, scale: 0.5, page_ranges: ' 1-2, 4 ', paper: 'Letter' },
		h.ctx,
	);
	const sent = h.calls.find((call) => call.method === 'Page.printToPDF')?.params;
	assertEquals(sent, {
		landscape: true,
		printBackground: false,
		scale: 0.5,
		pageRanges: '1-2, 4',
		paperWidth: 8.5,
		paperHeight: 11,
		displayHeaderFooter: false,
		transferMode: 'ReturnAsStream',
	});
	const error = await assertRejects(() => browserPdf({ page_ranges: '9-9' }, h.ctx), ToolError);
	assertEquals(error.code, 'invalid-arguments');
	assertStringIncludes(error.message, 'Page range exceeds page count');
});

Deno.test('R10: an inline PDF over 1 MiB is refused naming delivery "file", which keeps it as an art- file', async () => {
	const big = new Uint8Array(INLINE_FILE_LIMIT_BYTES + 1).fill(0x41);
	await using h = await harness('live_value_vs_attribute', { pdf: () => Promise.resolve({ data: encodeBase64(big) }) });
	const refused = await assertRejects(() => browserPdf({}, h.ctx), ToolError);
	assertEquals(refused.code, 'file-unavailable');
	assertStringIncludes(refused.message, 'delivery: "file"');
	assertEquals(h.record.files.list(), [], 'a refused inline print keeps nothing');

	const result = await browserPdf({ delivery: 'file' }, h.ctx);
	const payload = structured('browser_pdf', result);
	const file = payload.file as { file_id: string; name: string; mime_type: string; size: number; available: boolean };
	assert(file.file_id.startsWith('art-'), file.file_id);
	assertEquals([file.name, file.mime_type, file.size, file.available], [
		'page.pdf',
		'application/pdf',
		big.length,
		true,
	]);
	assertEquals(payload.bytes, big.length);
	const link = (result as { content: Array<{ type: string; uri?: string }> }).content[1];
	assertEquals(link?.type, 'resource_link');
	assertEquals(link?.uri, `ttk://session/default/files/${file.file_id}`);
	// Readable through the file tools' own path, byte for byte.
	const opened = await h.record.files.open(file.file_id);
	assertEquals((await new Response(opened.stream).bytes()).length, big.length);
});

Deno.test('R10: a PDF over 64 MiB is refused whatever the delivery, never truncated', async () => {
	assertEquals(PDF_MAX_BYTES, 64 * 1024 * 1024);
	// Base64 of PDF_MAX_BYTES + 3 bytes: measured from the length, never decoded.
	const data = 'A'.repeat(((PDF_MAX_BYTES + 3) / 3) * 4);
	await using h = await harness('live_value_vs_attribute', { pdf: () => Promise.resolve({ data }) });
	for (const delivery of ['inline', 'file'] as const) {
		const error = await assertRejects(() => browserPdf({ delivery }, h.ctx), ToolError);
		assertEquals(error.code, 'file-unavailable');
		assertStringIncludes(error.message, `${PDF_MAX_BYTES}-byte limit`);
	}
	assertEquals(h.record.files.list(), []);
});

Deno.test('R10: a browser that cannot print is browser-unavailable, a slow one timeout', async () => {
	let answer = 'Printing is not available';
	await using h = await harness('live_value_vs_attribute', { pdf: () => Promise.reject(new Error(answer)) });
	assertEquals((await assertRejects(() => browserPdf({}, h.ctx), ToolError)).code, 'browser-unavailable');
	answer = 'CDP request Page.printToPDF timed out after 30000ms';
	assertEquals((await assertRejects(() => browserPdf({}, h.ctx), ToolError)).code, 'timeout');
});

// --- browser_file_link ------------------------------------------------------------------------------------------

Deno.test('R10: browser_file_link mints for the caller’s owner, only for a file that can be served now', async () => {
	await using h = await harness();
	const art = await h.record.files.addArtifact({
		name: 'a.pdf',
		mimeType: 'application/pdf',
		bytes: new Uint8Array(4),
	});
	const asked: Parameters<SignedLinkMinter>[0][] = [];
	const signedLink: SignedLinkMinter = (input) => {
		asked.push(input);
		return Promise.resolve({
			url: 'https://gw.test/api/v1/links/file?t=v1.x.y',
			expiresAt: '2026-10-04T00:01:00.000Z',
			ttlSeconds: 45,
		});
	};
	const off = await assertRejects(() => browserFileLink({ file_id: art.file_id }, h.ctx), ToolError);
	assertEquals(off.code, 'feature-unavailable');
	assertStringIncludes(off.message, 'TTK_SIGNED_LINKS');

	const ctx: ToolContext = { ...h.ctx, signedLink };
	const result = await browserFileLink({ file_id: art.file_id, ttl_seconds: 45 }, ctx);
	assertEquals(structured('browser_file_link', result), {
		session_id: 'default',
		file_id: art.file_id,
		url: 'https://gw.test/api/v1/links/file?t=v1.x.y',
		expires_at: '2026-10-04T00:01:00.000Z',
		ttl_seconds: 45,
	});
	// D-140: the session's incarnation rides along, so the link dies with this session; an API-key call carries no
	// credential expiry, so there is no notAfter.
	assertEquals(asked, [{
		sessionId: 'default',
		fileId: art.file_id,
		owner: 'api-key:test',
		incarnation: h.record.incarnation,
		ttlSeconds: 45,
	}]);
	// F1: an OAuth call's own expiry (`credentialNotAfter`, set by the mount from `oauth:<ms>`) is handed to the minter
	// as notAfter, which caps the link.
	await browserFileLink({ file_id: art.file_id }, { ...ctx, credentialNotAfter: 1_900_000_000 });
	assertEquals(asked[1], {
		sessionId: 'default',
		fileId: art.file_id,
		owner: 'api-key:test',
		incarnation: h.record.incarnation,
		notAfter: 1_900_000_000,
	});

	// An unknown file and an unknown session are refused before anything is signed.
	assertEquals(
		(await assertRejects(() => browserFileLink({ file_id: 'art-nope' }, ctx), ToolError)).code,
		'unknown-file',
	);
	assertEquals(
		(await assertRejects(() => browserFileLink({ file_id: art.file_id, session_id: 'other' }, ctx), ToolError)).code,
		'unknown-session',
	);
	assertEquals(asked.length, 2);
});

Deno.test('AC18 / D-140: browser_file_link takes ttl_seconds 10 to 3600 and says a link never outlives its OAuth token', () => {
	const entry = CATALOG_BY_NAME.get('browser_file_link');
	assert(entry !== undefined);
	const parse = (ttl_seconds: unknown) => entry.inputSchema.safeParse({ file_id: 'art-1', ttl_seconds }).success;
	assertEquals([parse(10), parse(3600), parse(undefined)], [true, true, true]);
	assertEquals([parse(9), parse(3601), parse(60.5)], [false, false, false]);
	assertStringIncludes(entry.description, 'default 3600, at most 3600');
	const ttl = (entry.inputSchema as unknown as { shape: { ttl_seconds: { description?: string } } }).shape.ttl_seconds;
	assertEquals(
		ttl.description,
		'10 to 3600 seconds. Default: the deployment’s, 3600 unless the operator changed it. A link never outlives the ' +
			'OAuth access token it was minted under.',
	);
});

// --- browser_accessibility_snapshot ----------------------------------------------------------------------------

Deno.test('R11: the snapshot reads a fresh tree from the page session, with indices and no value', async () => {
	await using h = await harness();
	hold(h.record);
	const result = await browserAccessibilitySnapshot({}, h.ctx);
	const payload = structured('browser_accessibility_snapshot', result);
	const ax = h.calls.find((call) => call.method === 'Accessibility.getFullAXTree');
	assertEquals(ax?.sessionId, h.pageSession);
	assertEquals(ax?.params, {}, 'the top document is its session’s own root: no frameId');
	assertEquals(payload.frame_id, h.capture.sessions[0]!.frameId);
	assertEquals(payload.state_token, h.record.session.cachedBrowserState?.stateToken ?? null);
	assertEquals(payload.truncated, false);
	const everything = JSON.stringify(result);
	assert(!everything.includes('live-typed-value'), 'the typed value never leaves, in either half of the result');
	assert(!everything.includes('"value"'));
	// The held table's indices are joined by backend node id.
	const selector = h.record.session.cachedBrowserState!.domState.selectorMap;
	const tail = [...selector].find(([, node]) => node.axNode?.name === 'Tail control');
	assert(tail !== undefined);
	assertStringIncludes(String(payload.outline), `- button "Tail control" [${tail[0]}]`);
	const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
	assertStringIncludes(text, `accessibility tree of frame ${payload.frame_id}`);
	assertStringIncludes(text, '- button "Tail control"');
});

Deno.test('R11: max_nodes bounds the tree and a configured secret is redacted wherever it appears', async () => {
	await using h = await harness();
	const ctx: ToolContext = {
		...h.ctx,
		secrets: new SecretStore([{ name: 'tail', value: 'Tail control', domains: [] }]),
	};
	const payload = structured('browser_accessibility_snapshot', await browserAccessibilitySnapshot({}, ctx));
	assert(!JSON.stringify(payload).includes('Tail control'));
	assertStringIncludes(String(payload.outline), '- button "[secret]"');
	const cut = structured('browser_accessibility_snapshot', await browserAccessibilitySnapshot({ max_nodes: 3 }, h.ctx));
	assertEquals(cut.truncated, true);
	assertEquals(String(cut.outline).split('\n').length, 3);
	assert((cut.nodes_total as number) > 3);
});

Deno.test('R11: index reads one element through its own session with getPartialAXTree; frame_id and index exclude', async () => {
	await using h = await harness();
	const selector = h.record.session.cachedBrowserState!.domState.selectorMap;
	const [index, node] = [...selector].find(([, n]) => n.axNode?.name === 'Tail control')!;
	const payload = structured(
		'browser_accessibility_snapshot',
		await browserAccessibilitySnapshot({ index, state_token: h.record.session.cachedBrowserState!.stateToken! }, h.ctx),
	);
	const partial = h.calls.find((call) => call.method === 'Accessibility.getPartialAXTree');
	assertEquals(partial?.params, { backendNodeId: node.backendNodeId, fetchRelatives: false });
	assertEquals(partial?.sessionId, node.sessionId);
	assertEquals((payload.tree as { role: string; name: string; index?: number }).role, 'button');
	assertEquals((payload.tree as { index?: number }).index, index);

	const both = await assertRejects(() => browserAccessibilitySnapshot({ index, frame_id: 'F' }, h.ctx), ToolError);
	assertEquals(both.code, 'invalid-arguments');
	const stale = await assertRejects(
		() => browserAccessibilitySnapshot({ index, state_token: 'nope' }, h.ctx),
		ToolError,
	);
	assertEquals(stale.code, 'element-not-found');
});

// --- browser_performance --------------------------------------------------------------------------------------

Deno.test('R11: vitals come from one fixed evaluation in a fresh isolated world, runtime through sendRaw', async () => {
	await using h = await harness();
	hold(h.record);
	const payload = structured('browser_performance', await browserPerformance({}, h.ctx));
	assertEquals(payload, {
		session_id: 'default',
		origin: 'http://127.0.0.1:38111',
		vitals: { ttfb_ms: 3.46, dcl_ms: 10, load_ms: 11, fcp_ms: 90, lcp_ms: 120, cls: 0.1235, inp_ms: null },
		vitals_world: 'isolated',
		runtime: {
			js_heap_used_bytes: 1_234_567,
			nodes: 321,
			layout_count: 4,
			recalc_style_count: 5,
			script_duration_s: 0.25,
			task_duration_s: 0.5,
		},
	});
	const world = h.calls.find((call) => call.method === 'Page.createIsolatedWorld');
	assertEquals(world?.params.frameId, h.capture.sessions[0]!.frameId);
	const evaluated = h.calls.find((call) => call.method === 'Runtime.evaluate');
	assertEquals(evaluated?.params.contextId, 77, 'evaluated in the world just created, never the main world');
	assertEquals(evaluated?.params.expression, VITALS_SCRIPT, 'one fixed expression with no caller text');
	assertEquals(
		h.methods().filter((method) => method.startsWith('Performance.')),
		['Performance.enable', 'Performance.getMetrics'],
	);
	// E-97: the domain stays on, because Chromium counts layouts and script time only while it is — a second call
	// reads the counters accumulated since the first, and enables nothing.
	await browserPerformance({ metrics: ['runtime'] }, h.ctx);
	assertEquals(
		h.methods().filter((method) => method.startsWith('Performance.')),
		['Performance.enable', 'Performance.getMetrics', 'Performance.getMetrics'],
	);
	assert(!h.methods().includes('Performance.disable'));
});

Deno.test('R11: metrics picks the groups, and a page session that failed a read is enabled again', async () => {
	await using h = await harness('live_value_vs_attribute', {
		metrics: () => Promise.reject(new Error('target closed')),
	});
	const vitalsOnly = structured('browser_performance', await browserPerformance({ metrics: ['vitals'] }, h.ctx));
	assertEquals(vitalsOnly.runtime, null);
	assert(!h.methods().some((method) => method.startsWith('Performance.')));
	const error = await assertRejects(() => browserPerformance({ metrics: ['runtime'] }, h.ctx), ToolError);
	assertEquals(error.code, 'browser-unavailable');
	await assertRejects(() => browserPerformance({ metrics: ['runtime'] }, h.ctx), ToolError);
	assertEquals(
		h.methods().filter((method) => method.startsWith('Performance.')),
		['Performance.enable', 'Performance.getMetrics', 'Performance.enable', 'Performance.getMetrics'],
	);
	assertEquals(
		h.methods().filter((method) => method === 'Runtime.evaluate').length,
		1,
		'runtime alone reads no vitals',
	);
});

Deno.test('R11: whatever the page answers, a vital is a non-negative finite number or null', () => {
	assertEquals(
		vitalsOf({
			ttfb_ms: -1,
			dcl_ms: Number.NaN,
			load_ms: 'fast',
			fcp_ms: 1.23456,
			lcp_ms: Infinity,
			cls: 0.000049,
			x: 1,
		}),
		{ ttfb_ms: null, dcl_ms: null, load_ms: null, fcp_ms: 1.23, lcp_ms: null, cls: 0, inp_ms: null },
	);
	assertEquals(vitalsOf('spoofed'), {
		ttfb_ms: null,
		dcl_ms: null,
		load_ms: null,
		fcp_ms: null,
		lcp_ms: null,
		cls: null,
		inp_ms: null,
	});
	assertEquals(runtimeOf('nope').nodes, null);
	assertEquals(runtimeOf([{ name: 'Nodes', value: 'many' }, { name: 'LayoutCount', value: 2 }]).layout_count, 2);
});

// --- review R2-7: the print is streamed and its read bounded -------------------------------------------------------

Deno.test('R2-7: a streamed print is read in chunks and its handle closed', async () => {
	const first = new TextEncoder().encode('%PDF-1.7 ');
	const second = new TextEncoder().encode('streamed');
	const reads = [first, second];
	await using h = await harness('live_value_vs_attribute', {
		pdf: () => Promise.resolve({ data: '', stream: 'H-1' }),
		io: (method) => {
			if (method === 'IO.close') return Promise.resolve({});
			const next = reads.shift();
			return Promise.resolve(
				next === undefined
					? { data: '', eof: true, base64Encoded: true }
					: { data: encodeBase64(next), eof: reads.length === 0, base64Encoded: true },
			);
		},
	});
	const result = await browserPdf({}, h.ctx);
	const payload = structured('browser_pdf', result);
	assertEquals(payload.bytes, first.length + second.length);
	const block = (result as { content: Array<{ resource?: { blob?: string } }> }).content[1];
	assertEquals(atob(block?.resource?.blob ?? ''), '%PDF-1.7 streamed');
	const io = h.calls.filter((call) => call.method.startsWith('IO.'));
	assertEquals(io.map((call) => call.method), ['IO.read', 'IO.read', 'IO.close']);
	assertEquals(io[0]?.params, { handle: 'H-1', size: PDF_READ_CHUNK_BYTES });
	assertEquals(io.at(-1)?.params, { handle: 'H-1' });
	assertEquals(io.every((call) => call.sessionId === h.pageSession), true);
});

Deno.test('R2-7: a streamed print over 64 MiB stops reading at the cap, closes the handle and keeps nothing', async () => {
	const chunk = encodeBase64(new Uint8Array(PDF_READ_CHUNK_BYTES));
	let reads = 0;
	await using h = await harness('live_value_vs_attribute', {
		pdf: () => Promise.resolve({ data: '', stream: 'H-big' }),
		// An endless print: the reader, not the stream, has to end it.
		io: (method) => {
			if (method === 'IO.close') return Promise.resolve({});
			reads += 1;
			return Promise.resolve({ data: chunk, eof: false, base64Encoded: true });
		},
	});
	const error = await assertRejects(() => browserPdf({ delivery: 'file' }, h.ctx), ToolError);
	assertEquals(error.code, 'file-unavailable');
	assertStringIncludes(error.message, `${PDF_MAX_BYTES}-byte limit`);
	assertEquals(reads, PDF_MAX_BYTES / PDF_READ_CHUNK_BYTES + 1, 'one chunk past the cap, never more');
	assertEquals(h.calls.filter((call) => call.method === 'IO.close').length, 1);
	assertEquals(h.record.files.list(), []);
});

// --- K-1 / K-3: server-made files and the download ledger ----------------------------------------------------------

Deno.test('K-3: a server-made file announces files-changed, as a finished download does', async () => {
	await using h = await harness();
	const changes: string[] = [];
	const unwatch = h.registry.watch((change) => {
		if (change.kind === 'files-changed') changes.push(change.sessionId);
	});
	try {
		await browserPdf({ delivery: 'file' }, h.ctx);
	} finally {
		unwatch();
	}
	assertEquals(changes, ['default']);
});

Deno.test('K-1: a server-made file appearing while browser_download waits is never taken for the download', async () => {
	await using h = await harness();
	// A concurrent `browser_pdf {delivery:'file'}` lands while the navigation this call issued is in flight.
	h.record.session.eventBus.on(NavigateToUrlEvent, async () => {
		await h.record.files.addArtifact({ name: 'page.pdf', mimeType: 'application/pdf', bytes: new Uint8Array(8) });
	});
	const result = await browserDownload({ url: 'https://files.example/export.csv' }, h.ctx);
	const payload = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
	assertEquals(payload?.started, false, JSON.stringify(payload));
	assertEquals(payload?.file, null);
	assertEquals(
		h.record.files.list().filter((file) => file.file_id.startsWith('art-')).length,
		1,
		'the artifact is kept',
	);
});
