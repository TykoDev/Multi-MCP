/** The per-token origin overlay: its two matching rules, its narrowing guarantee, its degradation, and its routes. */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { join } from '@std/path';
import { generateApiKey } from './auth.ts';
import { ConfigError, loadConfig } from './config.ts';
import { startGateway } from './server.ts';
import {
	effectiveOrigins,
	MAX_ORIGIN_ENTRY_BYTES,
	MAX_TOKEN_ORIGINS,
	normalizeTokenOrigin,
	originAllowed,
	OriginOverlay,
	ORIGINS_FILE,
} from './origins.ts';
import { fakeSession, quiet } from './support_test.ts';

/** Directories made and not yet removed; the test or rig that made one removes it. */
const made = new Set<string>();

function scratchDir(): string {
	const path = join('tests/.scratch', `origins-${crypto.randomUUID()}`);
	Deno.mkdirSync(path, { recursive: true });
	made.add(path);
	return path;
}

async function removeScratch(...paths: string[]): Promise<void> {
	for (const path of paths.length === 0 ? [...made] : paths) {
		made.delete(path);
		await Deno.remove(path, { recursive: true });
	}
}

Deno.test('origins: entries normalise to an origin; bare, opaque and over-long entries are refused', () => {
	const bare = normalizeTokenOrigin('app.example');
	assert('rejected' in bare && bare.rejected.kind === 'bare-hostname' && 'accepted' in bare.rejected);
	assertEquals(bare.rejected.accepted, ['http://app.example', 'https://app.example']);
	const full = normalizeTokenOrigin('https://app.example:3000/some/path?q=1#f');
	assert('origin' in full && full.origin === 'https://app.example:3000', 'reduced to its origin, port included');
	for (const entry of ['file:///etc/passwd', 'data:text/html,x', 'http://', '   ']) {
		assert('rejected' in normalizeTokenOrigin(entry), entry);
	}
	const long = normalizeTokenOrigin(`https://${'a'.repeat(MAX_ORIGIN_ENTRY_BYTES)}.example`);
	assert('rejected' in long && long.rejected.kind === 'too-long', 'refused rather than truncated');
});

Deno.test('origins: the overlay only narrows, by port, and a request with no Origin still reaches the handler', () => {
	assertEquals(effectiveOrigins(['127.0.0.1', 'localhost'], []), {
		rule: 'hostname',
		entries: ['127.0.0.1', 'localhost'],
	});
	const narrowed = effectiveOrigins(['127.0.0.1', 'localhost'], ['http://127.0.0.1:5173', 'https://evil.example']);
	assertEquals(
		narrowed,
		{ rule: 'origin', entries: ['http://127.0.0.1:5173'] },
		'outside the ceiling is never effective',
	);
	// The page and the server are two ports of one host, which only the per-token rule tells apart.
	assertEquals(originAllowed('http://127.0.0.1:5173', narrowed), true);
	assertEquals(originAllowed('http://127.0.0.1:8787', narrowed), false);
	assertEquals(originAllowed('http://127.0.0.1:8787', effectiveOrigins(['127.0.0.1'], [])), true);
	// A narrowing control, not an authentication control: non-browser callers send no Origin.
	for (const origin of [undefined, null, '']) assertEquals(originAllowed(origin, narrowed), true);
});

Deno.test('origins: the overlay file degrades to empty, is re-normalised on read, and persists atomically', async () => {
	try {
		const absent = new OriginOverlay({ dataDir: scratchDir() });
		assertEquals([absent.status, absent.writable, absent.forToken('anyone')], ['absent', true, []]);
		const none = new OriginOverlay({ dataDir: null });
		assertEquals([none.status, none.writable], ['absent', false]);
		// Corrupt or schema-invalid: empty plus unreadable, never a wider (or partially trusted) policy.
		for (const text of ['{ this is not json', JSON.stringify({ version: 2, tokens: {} })]) {
			const dir = scratchDir();
			await Deno.writeTextFile(join(dir, ORIGINS_FILE), text);
			const warnings: string[] = [];
			const overlay = new OriginOverlay({ dataDir: dir, logger: { warn: (m) => warnings.push(m) } });
			assertEquals([overlay.status, overlay.forToken('k1'), warnings.length], ['unreadable', [], 1]);
			assertEquals(effectiveOrigins(['127.0.0.1'], overlay.forToken('k1')).entries, ['127.0.0.1']);
		}
		const stored = scratchDir();
		await Deno.writeTextFile(
			join(stored, ORIGINS_FILE),
			JSON.stringify({ version: 1, tokens: { k1: ['app.example', 'https://ok.example:8443/x'] } }),
		);
		assertEquals(new OriginOverlay({ dataDir: stored }).forToken('k1'), ['https://ok.example:8443']);

		const dir = scratchDir();
		const overlay = new OriginOverlay({ dataDir: dir });
		await Promise.all([
			overlay.set('k1', ['http://a.example']),
			overlay.set('k2', ['http://b.example']),
			overlay.set('k3', ['http://c.example']),
		]);
		assertEquals(['k1', 'k2', 'k3'].map((k) => overlay.forToken(k)), [['http://a.example'], ['http://b.example'], [
			'http://c.example',
		]]);
		assertEquals(new OriginOverlay({ dataDir: dir }).status, 'ok', 'no torn file');
		await overlay.set('k1', []);
		assertEquals(new OriginOverlay({ dataDir: dir }).forToken('k1'), [], 'an empty list removes the token');
		for await (const entry of Deno.readDir(dir)) assert(!entry.name.endsWith('.tmp'), 'no temporary file left behind');
	} finally {
		await removeScratch();
	}
});

Deno.test('config: an origin entry that can never match, or an executable under the data root, refuses startup', () => {
	const origins = assertThrows(
		() => loadConfig({ TTK_HOST: '127.0.0.1', TTK_ALLOWED_ORIGINS: 'https://app.example:3000,127.0.0.1' }),
		ConfigError,
	);
	// The refusal prints the list the operator meant.
	for (const part of ['TTK_ALLOWED_ORIGINS', 'https://app.example:3000', '"app.example,127.0.0.1"']) {
		assertStringIncludes(origins.message, part);
	}
	assertEquals(loadConfig({ TTK_ALLOWED_ORIGINS: 'app.example,127.0.0.1' }).allowedOrigins, [
		'app.example',
		'127.0.0.1',
	]);
	const data = assertThrows(
		() => loadConfig({ TTK_DATA_DIR: '/data', TTK_FFMPEG: '/data/bin/ffmpeg' }),
		ConfigError,
	);
	assertStringIncludes(data.message, 'TTK_DATA_DIR');
	assertStringIncludes(data.message, 'TTK_FFMPEG');
	assertEquals(
		loadConfig({ TTK_DATA_DIR: '/data', TTK_FFMPEG: '/data-tools/ffmpeg' }).dataDir,
		'/data',
		'a shared prefix is not inside',
	);
});

// --- the routes -------------------------------------------------------------

async function rig(dataDir: string | null = scratchDir()) {
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'view:control', 'admin']);
	const plain = await generateApiKey('plain-key', ['mcp:invoke', 'view:watch']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([admin.record, plain.record]),
		TTK_LOG_LEVEL: 'error',
		...(dataDir === null ? {} : { TTK_DATA_DIR: dataDir }),
	});
	const gateway = await startGateway({
		config,
		version: '0.1.0-test',
		logger: quiet(),
		launch: () => Promise.resolve(fakeSession(false)),
	});
	const call = (path: string, token: string, init: { origin?: string; body?: unknown; method?: string } = {}) =>
		fetch(`${gateway.url}${path}`, {
			method: init.method ?? (init.body === undefined ? 'GET' : 'PUT'),
			headers: {
				authorization: `Bearer ${token}`,
				...(init.origin === undefined ? {} : { origin: init.origin }),
				...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});
	return {
		config,
		url: gateway.url,
		adminKey: admin.key,
		plainKey: plain.key,
		call,
		/** The status of `call`, with its body discarded. */
		status: async (...args: Parameters<typeof call>) => {
			const response = await call(...args);
			await response.body?.cancel();
			return response.status;
		},
		narrow: async (origins: string[]) => {
			const write = await call('/api/v1/live/origins', admin.key, { body: { origins } });
			assertEquals(write.status, 200);
			return await write.json() as { token: { entries: string[] }; effective: { entries: string[] } };
		},
		async [Symbol.asyncDispose]() {
			await gateway.shutdown();
			await gateway.finished;
			if (dataDir !== null) await removeScratch(dataDir);
		},
	};
}

const ORIGINS = '/api/v1/live/origins';

Deno.test('origins route: reads need admin; writes are validated, need a data directory, and never widen the gate', async () => {
	await using r = await rig();
	assertEquals(await r.status(ORIGINS, r.plainKey), 403);
	const read = await (await r.call(ORIGINS, r.adminKey)).json();
	assertEquals(
		[read.process_wide.rule, read.token.rule, read.token.entries, read.effective.rule, read.overlay_status],
		['hostname', 'origin', [], 'hostname', 'absent'],
	);
	const bare = await r.call(ORIGINS, r.adminKey, { body: { origins: ['127.0.0.1'] } });
	const problem = await bare.json();
	assertEquals(bare.status, 400);
	for (const part of ['http://127.0.0.1', 'https://127.0.0.1']) assertStringIncludes(problem.detail, part);
	assertStringIncludes(problem.type, 'invalid-request');
	const many = Array.from({ length: MAX_TOKEN_ORIGINS + 1 }, (_, i) => `http://h${i}.example`);
	assertEquals(await r.status(ORIGINS, r.adminKey, { body: { origins: many } }), 400, 'refused rather than truncated');
	// Stored, because the ceiling can change, but never effective; the adapter still refuses that origin.
	const evil = await r.narrow(['https://evil.example']);
	assertEquals([evil.token.entries, evil.effective.entries], [['https://evil.example'], []]);
	assertEquals(await r.status(ORIGINS, r.adminKey, { origin: 'https://evil.example' }), 403);

	await using none = await rig(null);
	const persistence = await none.call(ORIGINS, none.adminKey, { body: { origins: ['http://127.0.0.1:5173'] } });
	assertEquals(persistence.status, 409);
	assertStringIncludes((await persistence.json()).type, 'persistence-required');
});

Deno.test('origins route: a narrowed token is refused elsewhere — on requests and in the ticket it mints', async () => {
	await using r = await rig();
	const before = [...r.config.allowedOrigins];
	await r.narrow(['http://127.0.0.1:5173']);
	assertEquals([...r.config.allowedOrigins], before, 'the process-wide list is never mutated');
	assertEquals(
		await r.status('/healthz', r.adminKey, { origin: 'https://elsewhere.example' }),
		403,
		'and still in force',
	);
	assertEquals(await r.status(ORIGINS, r.adminKey, { origin: 'http://127.0.0.1:5173' }), 200);
	const refused = await r.call(ORIGINS, r.adminKey, { origin: 'http://127.0.0.1:9999' });
	assertEquals(refused.status, 403);
	assertStringIncludes((await refused.json()).type, 'origin-forbidden');
	assertEquals(await r.status(ORIGINS, r.adminKey), 200, 'no Origin still reaches the handler');

	const mint = (token: string, body: Record<string, unknown>) =>
		r.call('/api/v1/live/ticket', token, { method: 'POST', body });
	const ticket = await (await mint(r.adminKey, {})).json();
	assertEquals([ticket.allowed_origins, ticket.overlay_status], [
		{ rule: 'origin', entries: ['http://127.0.0.1:5173'] },
		'ok',
	]);
	// The origin a ticket binds to is narrowed by the overlay just as an Origin header is.
	const bodyOrigin = await mint(r.adminKey, { origin: 'http://127.0.0.1:9999', ttl_seconds: 120 });
	assertEquals(bodyOrigin.status, 403);
	assertStringIncludes((await bodyOrigin.json()).type, 'origin-forbidden');
	const named = await mint(r.adminKey, { origin: 'http://127.0.0.1:5173', ttl_seconds: 120 });
	assertEquals([named.status, (await named.json()).origin_bound], [201, 'http://127.0.0.1:5173']);
	const plain = await mint(r.plainKey, { origin: 'http://127.0.0.1:9999', ttl_seconds: 120 });
	assertEquals(
		[plain.status, (await plain.json()).origin_bound],
		[201, 'http://127.0.0.1:9999'],
		'others are unchanged',
	);
});
