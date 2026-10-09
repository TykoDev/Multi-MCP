/**
 * The per-token origin overlay (B1.10) — its two matching rules, its narrowing
 * guarantee, its degradation, and the routes that expose it.
 *
 * The pure functions are exercised directly; the routes run against a real
 * gateway on an ephemeral port, because what is being asserted about them is the
 * *order* of two middlewares and that is a property of the assembled app.
 *
 * Every file this writes lives under `tests/.scratch`, which is the only path
 * the unit tier grants `--allow-write` for.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import type { BrowserSession } from '@tykotech/browser';
import { generateApiKey } from './auth.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { type RunningGateway, startGateway } from './server.ts';
import {
	effectiveOrigins,
	MAX_ORIGIN_ENTRY_BYTES,
	MAX_TOKEN_ORIGINS,
	normalizeTokenOrigin,
	originAllowed,
	OriginOverlay,
	ORIGINS_FILE,
} from './origins.ts';

const SCRATCH = 'tests/.scratch';

function scratchDir(): string {
	const path = join(SCRATCH, `origins-${crypto.randomUUID()}`);
	Deno.mkdirSync(path, { recursive: true });
	return path;
}

// --- the two matching rules -------------------------------------------------

Deno.test('origins: a bare hostname is refused at write time, naming both spellings that work', () => {
	const outcome = normalizeTokenOrigin('app.example');
	assert('rejected' in outcome);
	assertEquals(outcome.rejected.kind, 'bare-hostname');
	assert('accepted' in outcome.rejected);
	assertEquals(outcome.rejected.accepted, ['http://app.example', 'https://app.example']);
});

Deno.test('origins: a per-token entry is reduced to its origin, port included', () => {
	const outcome = normalizeTokenOrigin('https://app.example:3000/some/path?q=1#f');
	assert('origin' in outcome);
	assertEquals(outcome.origin, 'https://app.example:3000');
});

Deno.test('origins: an opaque or unparseable entry is not an origin', () => {
	for (const entry of ['file:///etc/passwd', 'data:text/html,x', 'http://', '   ']) {
		const outcome = normalizeTokenOrigin(entry);
		assert('rejected' in outcome, `${entry} was accepted`);
	}
});

Deno.test('origins: an over-long entry is refused rather than truncated', () => {
	const outcome = normalizeTokenOrigin(`https://${'a'.repeat(MAX_ORIGIN_ENTRY_BYTES)}.example`);
	assert('rejected' in outcome);
	assertEquals(outcome.rejected.kind, 'too-long');
});

Deno.test('origins: the overlay can only narrow — an entry outside the ceiling is never effective', () => {
	const processWide = ['127.0.0.1', 'localhost'];
	const effective = effectiveOrigins(processWide, ['http://127.0.0.1:5173', 'https://evil.example']);
	assertEquals(effective.rule, 'origin');
	assertEquals(effective.entries, ['http://127.0.0.1:5173']);
});

Deno.test('origins: a token declaring nothing is unchanged, and says which rule applies', () => {
	const effective = effectiveOrigins(['127.0.0.1', 'localhost'], []);
	assertEquals(effective.rule, 'hostname');
	assertEquals(effective.entries, ['127.0.0.1', 'localhost']);
});

Deno.test('origins: the per-token rule is port-sensitive and the process-wide rule is not', () => {
	const narrowed = effectiveOrigins(['127.0.0.1'], ['http://127.0.0.1:5173']);
	assertEquals(originAllowed('http://127.0.0.1:5173', narrowed), true);
	// The whole reason §3 needs a second rule: the page and the server are two
	// ports of one host, and a hostname rule cannot tell them apart.
	assertEquals(originAllowed('http://127.0.0.1:8787', narrowed), false);
	assertEquals(originAllowed('http://127.0.0.1:8787', effectiveOrigins(['127.0.0.1'], [])), true);
});

Deno.test('origins: a request with NO Origin header reaches the handler — this is a narrowing control, not an authentication control', () => {
	// SEC-06. Every non-browser caller sends no `Origin`, and every one of them
	// already presented a credential. A list that refused them would be an
	// authentication control wearing an origin list's clothes.
	const narrowed = effectiveOrigins(['127.0.0.1'], ['http://127.0.0.1:5173']);
	assertEquals(originAllowed(undefined, narrowed), true);
	assertEquals(originAllowed(null, narrowed), true);
	assertEquals(originAllowed('', narrowed), true);
});

// --- the file ---------------------------------------------------------------

Deno.test('origins: an absent overlay is absent, not unreadable', () => {
	const overlay = new OriginOverlay({ dataDir: scratchDir() });
	assertEquals(overlay.status, 'absent');
	assertEquals(overlay.writable, true);
	assertEquals(overlay.forToken('anyone'), []);
});

Deno.test('origins: no data directory means the overlay cannot be written at all (D-A3)', () => {
	const overlay = new OriginOverlay({ dataDir: null });
	assertEquals(overlay.writable, false);
	assertEquals(overlay.status, 'absent');
});

Deno.test('origins: a corrupt overlay degrades to empty plus unreadable, never to a wider policy', () => {
	const dir = scratchDir();
	Deno.writeTextFileSync(join(dir, ORIGINS_FILE), '{ this is not json');
	const warnings: string[] = [];
	const overlay = new OriginOverlay({ dataDir: dir, logger: { warn: (m) => warnings.push(m) } });
	assertEquals(overlay.status, 'unreadable');
	assertEquals(overlay.forToken('k1'), []);
	assertEquals(warnings.length, 1);
	// And an empty overlay narrows nothing, so the process-wide ceiling still
	// stands: degrading must never *widen*, and here it cannot.
	assertEquals(effectiveOrigins(['127.0.0.1'], overlay.forToken('k1')).entries, ['127.0.0.1']);
});

Deno.test('origins: a schema-invalid overlay is unreadable too, not partially trusted', () => {
	const dir = scratchDir();
	Deno.writeTextFileSync(join(dir, ORIGINS_FILE), JSON.stringify({ version: 2, tokens: {} }));
	const overlay = new OriginOverlay({ dataDir: dir, logger: { warn: () => {} } });
	assertEquals(overlay.status, 'unreadable');
});

Deno.test('origins: a stored entry is re-normalised on read — the file is not a trusted input', () => {
	const dir = scratchDir();
	Deno.writeTextFileSync(
		join(dir, ORIGINS_FILE),
		JSON.stringify({ version: 1, tokens: { k1: ['app.example', 'https://ok.example:8443/x'] } }),
	);
	const overlay = new OriginOverlay({ dataDir: dir });
	assertEquals(overlay.status, 'ok');
	// The bare hostname is dropped rather than kept as an entry that matches
	// nothing, and the full origin is reduced.
	assertEquals(overlay.forToken('k1'), ['https://ok.example:8443']);
});

Deno.test('origins: a write persists atomically and survives a reload', async () => {
	const dir = scratchDir();
	const overlay = new OriginOverlay({ dataDir: dir });
	await overlay.set('k1', ['http://127.0.0.1:5173']);
	assertEquals(overlay.status, 'ok');
	const reloaded = new OriginOverlay({ dataDir: dir });
	assertEquals(reloaded.forToken('k1'), ['http://127.0.0.1:5173']);
	// No temporary file is left behind.
	const leftovers: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		if (entry.name.endsWith('.tmp')) leftovers.push(entry.name);
	}
	assertEquals(leftovers, []);
});

Deno.test('origins: concurrent writes do not lose one', async () => {
	const dir = scratchDir();
	const overlay = new OriginOverlay({ dataDir: dir });
	await Promise.all([
		overlay.set('k1', ['http://a.example']),
		overlay.set('k2', ['http://b.example']),
		overlay.set('k3', ['http://c.example']),
	]);
	const reloaded = new OriginOverlay({ dataDir: dir });
	// Each write persists the whole overlay, so the last rename wins the file —
	// what must not happen is a *torn* file or a lost in-memory entry.
	assertEquals(reloaded.status, 'ok');
	assertEquals(overlay.forToken('k1'), ['http://a.example']);
	assertEquals(overlay.forToken('k2'), ['http://b.example']);
	assertEquals(overlay.forToken('k3'), ['http://c.example']);
});

Deno.test('origins: an empty list removes the token rather than storing an empty narrowing', async () => {
	const dir = scratchDir();
	const overlay = new OriginOverlay({ dataDir: dir });
	await overlay.set('k1', ['http://a.example']);
	await overlay.set('k1', []);
	assertEquals(new OriginOverlay({ dataDir: dir }).forToken('k1'), []);
});

// --- configuration ----------------------------------------------------------

Deno.test('config: a TTK_ALLOWED_ORIGINS entry that can never match is refused at startup, with the corrected list', () => {
	let raised: unknown;
	try {
		loadConfig({ TTK_HOST: '127.0.0.1', TTK_ALLOWED_ORIGINS: 'https://app.example:3000,127.0.0.1' });
	} catch (error) {
		raised = error;
	}
	assert(raised instanceof ConfigError, `expected a ConfigError, got ${String(raised)}`);
	assertStringIncludes(raised.message, 'TTK_ALLOWED_ORIGINS');
	assertStringIncludes(raised.message, 'https://app.example:3000');
	// The refusal prints the list the operator meant. That is the whole
	// mitigation for RR-3: the deployments that break are exactly the ones whose
	// policy already did nothing, and each is told what to write instead.
	assertStringIncludes(raised.message, '"app.example,127.0.0.1"');
});

Deno.test('config: a list of bare hostnames is accepted unchanged', () => {
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_ALLOWED_ORIGINS: 'app.example,127.0.0.1' });
	assertEquals(config.allowedOrigins, ['app.example', '127.0.0.1']);
});

Deno.test('config: a data root holding an executable this server may run is refused', () => {
	let raised: unknown;
	try {
		loadConfig({ TTK_HOST: '127.0.0.1', TTK_DATA_DIR: '/data', TTK_FFMPEG: '/data/bin/ffmpeg' });
	} catch (error) {
		raised = error;
	}
	assert(raised instanceof ConfigError, `expected a ConfigError, got ${String(raised)}`);
	assertStringIncludes(raised.message, 'TTK_DATA_DIR');
	assertStringIncludes(raised.message, 'TTK_FFMPEG');
	// A path merely *sharing a prefix* is not inside it, and must not be refused.
	const ok = loadConfig({ TTK_HOST: '127.0.0.1', TTK_DATA_DIR: '/data', TTK_FFMPEG: '/data-tools/ffmpeg' });
	assertEquals(ok.dataDir, '/data');
});

// --- the routes -------------------------------------------------------------

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: undefined,
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

interface Rig {
	gateway: RunningGateway;
	config: Config;
	url: string;
	adminKey: string;
	plainKey: string;
	dataDir: string | null;
	[Symbol.asyncDispose](): Promise<void>;
}

async function rig(options: { dataDir?: string | null } = {}): Promise<Rig> {
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'view:control', 'admin']);
	const plain = await generateApiKey('plain-key', ['mcp:invoke', 'view:watch']);
	const dataDir = options.dataDir === undefined ? scratchDir() : options.dataDir;
	const env: Record<string, string | undefined> = {
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([admin.record, plain.record]),
		TTK_LOG_LEVEL: 'error',
		...(dataDir === null ? {} : { TTK_DATA_DIR: dataDir }),
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
		config,
		url: gateway.url,
		adminKey: admin.key,
		plainKey: plain.key,
		dataDir,
		async [Symbol.asyncDispose]() {
			await gateway.shutdown();
			await gateway.finished;
		},
	};
}

/**
 * Auth, and an `Origin` when the test is about one.
 *
 * No `content-type` on a GET: the adapter parses a body whenever one is
 * declared, and a declared-but-absent JSON body is a 400 before any route runs.
 */
function headers(token: string, origin?: string): Record<string, string> {
	const out: Record<string, string> = { authorization: `Bearer ${token}` };
	if (origin !== undefined) out.origin = origin;
	return out;
}

/** Auth plus the JSON content type, for the writes. */
function jsonHeaders(token: string, origin?: string): Record<string, string> {
	return { ...headers(token, origin), 'content-type': 'application/json' };
}

Deno.test('origins route: reading needs admin, and both lists arrive labelled with their rule', async () => {
	await using r = await rig();
	const denied = await fetch(`${r.url}/api/v1/live/origins`, { headers: headers(r.plainKey) });
	assertEquals(denied.status, 403);
	await denied.body?.cancel();

	const response = await fetch(`${r.url}/api/v1/live/origins`, { headers: headers(r.adminKey) });
	assertEquals(response.status, 200);
	const body = await response.json() as {
		process_wide: { rule: string; entries: string[] };
		token: { rule: string; entries: string[] };
		effective: { rule: string; entries: string[] };
		overlay_status: string;
	};
	assertEquals(body.process_wide.rule, 'hostname');
	assertEquals(body.token.rule, 'origin');
	assertEquals(body.token.entries, []);
	assertEquals(body.effective.rule, 'hostname');
	assertEquals(body.overlay_status, 'absent');
});

Deno.test('origins route: a write naming an origin outside the process-wide list has no effect on the gate', async () => {
	await using r = await rig();
	const write = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: ['https://evil.example'] }),
	});
	assertEquals(write.status, 200);
	const body = await write.json() as { token: { entries: string[] }; effective: { entries: string[] } };
	// Stored, because the ceiling is operator state that can change — but never
	// effective, which is the property that matters.
	assertEquals(body.token.entries, ['https://evil.example']);
	assertEquals(body.effective.entries, []);

	// And the gate really is unchanged: the adapter still refuses that origin.
	const probe = await fetch(`${r.url}/api/v1/live/origins`, {
		headers: headers(r.adminKey, 'https://evil.example'),
	});
	assertEquals(probe.status, 403);
	await probe.body?.cancel();
});

Deno.test('origins route: a bare hostname is refused with invalid-request naming both spellings', async () => {
	await using r = await rig();
	const response = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: ['127.0.0.1'] }),
	});
	assertEquals(response.status, 400);
	const body = await response.json() as { type: string; detail: string };
	assertStringIncludes(body.type, 'invalid-request');
	assertStringIncludes(body.detail, 'http://127.0.0.1');
	assertStringIncludes(body.detail, 'https://127.0.0.1');
});

Deno.test('origins route: a write with no data directory is persistence-required, not a lie', async () => {
	await using r = await rig({ dataDir: null });
	const response = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: ['http://127.0.0.1:5173'] }),
	});
	assertEquals(response.status, 409);
	const body = await response.json() as { type: string };
	assertStringIncludes(body.type, 'persistence-required');
});

Deno.test('origins route: an over-long list is refused rather than truncated', async () => {
	await using r = await rig();
	const many = Array.from({ length: MAX_TOKEN_ORIGINS + 1 }, (_, i) => `http://h${i}.example`);
	const response = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: many }),
	});
	assertEquals(response.status, 400);
	await response.body?.cancel();
});

Deno.test('origins route: a narrowed token is refused on a process-wide origin it did not name', async () => {
	await using r = await rig();
	// `127.0.0.1` is in the default process-wide list, so both ports pass the
	// adapter. The overlay then narrows to one of them.
	const write = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: ['http://127.0.0.1:5173'] }),
	});
	assertEquals(write.status, 200);
	await write.body?.cancel();

	const allowed = await fetch(`${r.url}/api/v1/live/origins`, {
		headers: headers(r.adminKey, 'http://127.0.0.1:5173'),
	});
	assertEquals(allowed.status, 200);
	await allowed.body?.cancel();

	const refused = await fetch(`${r.url}/api/v1/live/origins`, {
		headers: headers(r.adminKey, 'http://127.0.0.1:9999'),
	});
	assertEquals(refused.status, 403);
	const body = await refused.json() as { type: string };
	assertStringIncludes(body.type, 'origin-forbidden');

	// A request with no Origin header still reaches the handler.
	const noOrigin = await fetch(`${r.url}/api/v1/live/origins`, { headers: headers(r.adminKey) });
	assertEquals(noOrigin.status, 200);
	await noOrigin.body?.cancel();

	// And another principal is untouched by this one's narrowing.
	const other = await fetch(`${r.url}/api/v1/live/origins`, {
		headers: headers(r.plainKey, 'http://127.0.0.1:9999'),
	});
	assertEquals(other.status, 403, 'the plain key lacks admin, which is a 403 for a different reason');
	await other.body?.cancel();
});

Deno.test('origins route: the ticket response echoes the effective list and the overlay status', async () => {
	await using r = await rig();
	const write = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: ['http://127.0.0.1:5173'] }),
	});
	assertEquals(write.status, 200);
	await write.body?.cancel();

	const response = await fetch(`${r.url}/api/v1/live/ticket`, {
		method: 'POST',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({}),
	});
	assertEquals(response.status, 201);
	const body = await response.json() as {
		allowed_origins: { rule: string; entries: string[] };
		overlay_status: string;
	};
	assertEquals(body.allowed_origins.rule, 'origin');
	assertEquals(body.allowed_origins.entries, ['http://127.0.0.1:5173']);
	assertEquals(body.overlay_status, 'ok');
});

Deno.test('R1-3: the ticket mint narrows a body origin by the overlay, as the front narrows an Origin header', async () => {
	await using r = await rig();
	const write = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: ['http://127.0.0.1:5173'] }),
	});
	assertEquals(write.status, 200);
	await write.body?.cancel();
	const mint = (token: string, origin: string) =>
		fetch(`${r.url}/api/v1/live/ticket`, {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({ origin, ttl_seconds: 120 }),
		});

	// No Origin header, so the front lets it through; the origin the ticket would be bound to is named in the body
	// instead, and the overlay this credential carries does not name it.
	const refused = await mint(r.adminKey, 'http://127.0.0.1:9999');
	assertEquals(refused.status, 403);
	assertStringIncludes((await refused.json() as { type: string }).type, 'origin-forbidden');

	const named = await mint(r.adminKey, 'http://127.0.0.1:5173');
	assertEquals(named.status, 201);
	assertEquals((await named.json() as { origin_bound: string }).origin_bound, 'http://127.0.0.1:5173');

	// A credential with no narrowing is unchanged.
	const plain = await mint(r.plainKey, 'http://127.0.0.1:9999');
	assertEquals(plain.status, 201);
	assertEquals((await plain.json() as { origin_bound: string }).origin_bound, 'http://127.0.0.1:9999');
});

Deno.test('origins route: I-13 — the adapter option array is never mutated and never omitted', async () => {
	await using r = await rig();
	const before = r.config.allowedOrigins;
	const snapshot = [...before];
	const write = await fetch(`${r.url}/api/v1/live/origins`, {
		method: 'PUT',
		headers: jsonHeaders(r.adminKey),
		body: JSON.stringify({ origins: ['http://127.0.0.1:5173'] }),
	});
	assertEquals(write.status, 200);
	await write.body?.cancel();
	assertEquals([...r.config.allowedOrigins], snapshot, 'the process-wide list moved');

	// The option is not merely unmutated: it is still *in force*. An origin
	// outside the process-wide list is refused by the adapter, before this
	// repository's middleware runs at all — proven here by a public route, which
	// our own narrowing never reaches because it requires a principal.
	const outside = await fetch(`${r.url}/healthz`, { headers: { origin: 'https://elsewhere.example' } });
	assertEquals(outside.status, 403);
	await outside.body?.cancel();
});
