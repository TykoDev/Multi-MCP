import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import {
	checkBindPolicy,
	ConfigError,
	DEFAULT_SCOPES,
	EXPLICIT_SCOPES,
	isLoopbackHost,
	isSafeKeyLabel,
	loadConfig,
	MAX_KEY_LABEL_LENGTH,
	SCOPES,
} from './config.ts';
import { ApiKeyStore, generateApiKey, keyPrefix, VerifierChain } from './auth.ts';
import { generateAdminUser } from './admin_auth.ts';
import { SCOPELESS_ACCOUNT_SCOPES } from '@tykotech/mcp';
import { RateLimiter } from './ratelimit.ts';
import {
	clampTicketTtl,
	TICKET_TTL_MAX_CONTROL_MS,
	TICKET_TTL_MAX_VIEW_MS,
	TICKET_TTL_MS,
	TicketStore,
} from './tickets.ts';
import {
	CAST_MAX_HEIGHT,
	CAST_MAX_WIDTH,
	clampQuality,
	frameScaleFor,
	framesOfTree,
	modifierBits,
	PONG_GRACE_MS,
	PONG_TIMEOUT_MS,
	pongDeadlineMs,
	resolveKeySpec,
	tabsOf,
	viewTitle,
	viewUrl,
} from './liveview.ts';
import { normalizeSecret, resolveSecrets, SecretError } from './secrets.ts';
import { ClientMsgSchema, decodeFrame, encodeFrame, ServerMsgSchema } from '@tykotech/wire';
import { createLogger } from './logger.ts';

const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost'].sort();
const keys = (...records: unknown[]) => ({ TTK_API_KEYS: JSON.stringify(records) });

// --- config -----------------------------------------------------------------

Deno.test('config: safe defaults; the Host and Origin lists follow the bind and the public URL', () => {
	const config = loadConfig({});
	assertEquals([config.host, config.port, config.browser.headless, config.apiKeys], ['127.0.0.1', 8787, true, []]);
	// The SPA is same-origin, and a same-origin POST still carries an Origin header.
	assertEquals([...config.allowedOrigins].sort(), LOOPBACK);
	assertEquals([...config.allowedHosts].sort(), LOOPBACK);
	// A wildcard bind with nothing declared answers on loopback only; a bind address is never a Host.
	const undeclared = loadConfig({ TTK_HOST: '0.0.0.0', TTK_API_KEYS: '[]' });
	assertEquals([...undeclared.allowedHosts].sort(), LOOPBACK);
	const declared = loadConfig({ TTK_HOST: '0.0.0.0', TTK_PUBLIC_URL: 'http://192.168.1.14:8787' });
	assert(declared.allowedHosts.includes('192.168.1.14') && declared.allowedHosts.includes('127.0.0.1'));
	assertEquals(declared.allowedOrigins, ['192.168.1.14']);
	assertEquals(loadConfig({ TTK_HOST: '10.0.0.5', TTK_API_KEYS: '[]' }).allowedHosts, ['10.0.0.5']);
	const bound = loadConfig({ TTK_HOST: '10.0.0.5', TTK_API_KEYS: '[]', TTK_PUBLIC_URL: 'https://browser.example/' });
	assertEquals(bound.allowedOrigins, ['browser.example']);
	// An explicit origin list replaces the default outright, loopback included.
	assertEquals(loadConfig({ TTK_ALLOWED_ORIGINS: 'app.example, console.example' }).allowedOrigins, [
		'app.example',
		'console.example',
	]);
	// The SDK compares the Host header's hostname, so an entry with a port would match nothing.
	assertEquals(
		loadConfig({ TTK_ALLOWED_HOSTS: '192.168.1.14:8787, http://box.lan:9000/, [::1]:8787' }).allowedHosts,
		['192.168.1.14', 'box.lan', '[::1]'],
	);
	for (const host of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST']) assert(isLoopbackHost(host), host);
	assert(!isLoopbackHost('0.0.0.0') && !isLoopbackHost('10.0.0.5'));
});

Deno.test('config: refusals name the variable or the key id', () => {
	for (
		const [env, name] of [
			[{ TTK_PORT: 'eighty' }, 'TTK_PORT'],
			[{ TTK_MAX_SESSIONS: '0' }, 'TTK_MAX_SESSIONS'],
			[{ TTK_HEADLESS: 'maybe' }, 'TTK_HEADLESS'],
			[{ TTK_LOG_LEVEL: 'chatty' }, 'TTK_LOG_LEVEL'],
			[{ TTK_PUBLIC_URL: 'not a url' }, 'TTK_PUBLIC_URL'],
			[{ TTK_API_KEYS: '{not json' }, 'TTK_API_KEYS'],
			// A record carries a hash, never a raw key.
			[keys({ id: 'a', sha256: 'ttk_rawkey' }), 'TTK_API_KEYS'],
			[keys({ id: 'dup', sha256: 'a'.repeat(64) }, { id: 'dup', sha256: 'a'.repeat(64) }), 'duplicate key id'],
			[keys({ id: 'k-1', sha256: 'a'.repeat(64), label: 'x'.repeat(65) }), 'key k-1'],
			[keys({ id: 'k-1', sha256: 'a'.repeat(64), label: '<script>' }), 'key k-1'],
		] as const
	) assertThrows(() => loadConfig(env), ConfigError, name);
	assertThrows(
		() => loadConfig(keys({ id: 'a', sha256: 'b'.repeat(64) }), { secrets: keys({ id: 'b', sha256: 'b'.repeat(64) }) }),
		ConfigError,
		'not both',
	);
	// The whole vocabulary, so an operator can fix TTK_ANON_SCOPES from the message alone.
	const anon = assertThrows(() => loadConfig({ TTK_ANON_SCOPES: 'mcp:invoke,nonsense' }), ConfigError) as ConfigError;
	for (const part of ['TTK_ANON_SCOPES', 'nonsense', ...SCOPES]) assertStringIncludes(anon.message, part);
	for (const label of ['ADM worker (eu-west)', 'x'.repeat(MAX_KEY_LABEL_LENGTH)]) assert(isSafeKeyLabel(label));
	for (const label of ['x'.repeat(MAX_KEY_LABEL_LENGTH + 1), 'line\nbreak', '<b>bold</b>', 'a & b', 'tab\tchar']) {
		assert(!isSafeKeyLabel(label), label);
	}
	assertEquals(
		loadConfig(keys({ id: 'k', sha256: 'a'.repeat(64), label: 'ADM worker' })).apiKeys[0]?.label,
		'ADM worker',
	);
});

Deno.test('config: the bind policy refuses an uncredentialed public bind and warns about unreachable names', () => {
	const warningsFor = (env: Record<string, string>): string[] => {
		const collected: string[] = [];
		checkBindPolicy(loadConfig(env), (m) => collected.push(m));
		return collected;
	};
	assertThrows(() => warningsFor({ TTK_HOST: '0.0.0.0' }), ConfigError, 'TTK_HOST');
	// Loopback without credentials is the dev mode; its warning states the effective grant, never "all scopes".
	const dev = warningsFor({ TTK_HOST: '127.0.0.1' }).join(' ');
	assertStringIncludes(dev, 'loopback development mode');
	assertStringIncludes(dev, 'no credentials configured');
	assert(!dev.includes('all scopes'), dev);
	for (const scope of DEFAULT_SCOPES) assertStringIncludes(dev, scope);
	for (const scope of EXPLICIT_SCOPES) assert(!dev.includes(scope), `the warning claims ${scope} is granted`);

	const keyed = keys({ id: 'k', sha256: 'd'.repeat(64) });
	assert(warningsFor({ ...keyed, TTK_HOST: '0.0.0.0' }).some((m) => m.includes('Host allowlist is loopback-only')));
	// Half declared: the page loads and every API call from it is refused.
	assert(
		warningsFor({ ...keyed, TTK_HOST: '0.0.0.0', TTK_ALLOWED_HOSTS: '192.168.1.14' }).some((m) => m.includes('Origin')),
	);
	assertEquals(warningsFor({ ...keyed, TTK_HOST: '0.0.0.0', TTK_PUBLIC_URL: 'http://192.168.1.14:8787' }), []);
	assertEquals(warningsFor({ ...keyed, TTK_HOST: '127.0.0.1' }), []);
});

// --- auth --------------------------------------------------------------------

Deno.test('auth: a generated key verifies and a near-miss does not; only its hash is stored, only its prefix logged', async () => {
	const { key, record } = await generateApiKey('k1', ['mcp:invoke']);
	assert(key.startsWith('ttk_'));
	assert(!JSON.stringify(record).includes(key) && record.sha256.length === 64);
	const plain = await generateApiKey('plain', ['view:watch']);
	const store = new ApiKeyStore([{ ...record, label: 'ADM worker' }, plain.record]);
	const principal = await store.verify(key);
	assertEquals([principal?.id, [...principal!.scopes], principal?.label], ['k1', ['mcp:invoke'], 'ADM worker']);
	assertEquals((await store.verify(plain.key))?.label, null);
	assertEquals(await store.verify(`${key}x`), null);
	assertEquals(await store.verify('ttk_wrong'), null);
	assertEquals(keyPrefix('ttk_abcdefghijklmnop'), 'ttk_abcd…');
});

Deno.test('auth: scope-less credentials get DEFAULT_SCOPES, never an explicit scope; an explicit grant works', async () => {
	const noExplicit = (scopes: ReadonlySet<string> | undefined, skip: string[] = []) => {
		for (const scope of EXPLICIT_SCOPES.filter((name) => !skip.includes(name))) {
			assert(scopes?.has(scope) === false, `granted ${scope}`);
		}
	};
	// 1. A key with no scopes array: granting the vocabulary would widen it whenever a scope is added.
	const { key, record } = await generateApiKey('k2');
	assertEquals(record.scopes, undefined);
	const keyed = await new ApiKeyStore([record]).verify(key);
	assertEquals([...keyed!.scopes].sort(), [...DEFAULT_SCOPES].sort());
	noExplicit(keyed?.scopes);
	// 2. The anonymous loopback principal: TTK_ANON_SCOPES, defaulting to DEFAULT_SCOPES; empty means none.
	const anon = (env: Record<string, string> = {}) =>
		new VerifierChain({ config: loadConfig(env), allowAnonymous: true }).anonymousPrincipal('127.0.0.1')?.scopes;
	assertEquals([...anon()!].sort(), [...DEFAULT_SCOPES].sort());
	noExplicit(anon());
	assertEquals([...anon({ TTK_ANON_SCOPES: 'mcp:invoke,evaluate' })!].sort(), ['evaluate', 'mcp:invoke']);
	assertEquals([...anon({ TTK_ANON_SCOPES: '' })!], []);
	// 3. A scope-less admin seed holds SCOPELESS_ACCOUNT_SCOPES; an explicit list is honoured whole.
	const { record: admin, password } = await generateAdminUser('admin', 'correct horse battery staple');
	assertEquals([...(admin.scopes ?? [])].sort(), [...DEFAULT_SCOPES, 'admin'].sort());
	const { scopes: _omitted, ...bare } = admin;
	const verify = async (seed: unknown) =>
		(await new VerifierChain({ config: loadConfig({ TTK_ADMIN_USER: JSON.stringify(seed) }), allowAnonymous: false })
			.verifyAdmin('admin', password))?.scopes;
	const seeded = await verify(bare);
	assertEquals([...seeded!].sort(), [...SCOPELESS_ACCOUNT_SCOPES].sort());
	noExplicit(seeded, ['admin']);
	const named = await verify({ ...bare, scopes: [...SCOPES] });
	for (const scope of EXPLICIT_SCOPES) assert(named?.has(scope), `a named ${scope} was dropped`);
	assertEquals((await generateAdminUser('admin', 'correct horse battery staple', ['agent:invoke'])).record.scopes, [
		'agent:invoke',
	]);
});

Deno.test('auth: the verifier answers in the SDK shapes, and anonymous loopback exists only with no credential', async () => {
	const { key, record } = await generateApiKey('k4', ['mcp:invoke']);
	const chain = new VerifierChain({ config: loadConfig(keys(record)), allowAnonymous: true });
	// The SDK maps only its own OAuthError to a 401, and refuses an AuthInfo without an expiry.
	const error = await assertRejects(() => chain.verifyAccessToken('ttk_nope'));
	assertEquals([(error as Error).name, (error as { code?: string }).code], ['OAuthError', 'invalid_token']);
	const info = await chain.verifyAccessToken(key);
	assert(typeof info.expiresAt === 'number' && info.expiresAt > Date.now() / 1000);
	assertEquals([chain.anonymousPrincipal('127.0.0.1'), chain.credentialed], [null, true]);
	const open = new VerifierChain({ config: loadConfig({}), allowAnonymous: true });
	assert(open.anonymousPrincipal('127.0.0.1') !== null && !open.credentialed);
});

// --- rate limiting and tickets ------------------------------------------------

Deno.test('ratelimit: a per-principal burst, then a refusal with a retry hint; remaining is floored and true', () => {
	let now = 0;
	const limiter = new RateLimiter({ rpm: 60, burst: 3, now: () => now });
	assertEquals([0, 1, 2].map(() => limiter.charge('p1').remaining), [2, 1, 0]);
	const refused = limiter.charge('p1');
	assertEquals([refused.allowed, refused.remaining], [false, 0], 'a refusal advertises no request');
	assert(refused.retryAfter >= 1);
	assertEquals(limiter.charge('p2').remaining, 2, 'buckets are per principal');
	// At 60 rpm, 1.5 s refills 1.5 tokens: one charge leaves 0.5, reported as 0.
	now += 1_500;
	assertEquals(limiter.charge('p1').remaining, 0);
	now += 60_000;
	assertEquals(limiter.charge('p1').remaining, 2, 'refill is capped at the burst');
});

Deno.test('tickets: single use, expiry, session and origin binding, the ttl clamp and the holder name', () => {
	let now = 0;
	const store = new TicketStore({ ttlMs: 1_000, now: () => now });
	const reason = (ticket: string, session = 'default', origin?: string | null) => {
		const result = store.redeem(ticket, session, origin);
		return result.ok ? 'ok' : result.reason;
	};
	const once = store.mint('p', 'default', 'control').ticket;
	assertEquals([reason(once), reason(once)], ['ok', 'consumed']);
	assertEquals(reason(store.mint('p', 'session-a', 'control').ticket, 'session-b'), 'session-mismatch');
	assertEquals(reason('lvt_never-existed'), 'unknown');
	const old = store.mint('p', 'default', 'watch').ticket;
	now = 1_001;
	assertEquals(reason(old), 'expired');
	// An origin-bound ticket redeems from that origin only; a missing Origin is not a match.
	const bound = () => store.mint('p', 'default', 'watch', { origin: 'https://adm.example' });
	assertEquals(bound().originBound, 'https://adm.example');
	assertEquals(reason(bound().ticket, 'default', 'https://evil.example'), 'origin-mismatch');
	assertEquals(reason(bound().ticket, 'default', null), 'origin-mismatch');
	assertEquals(reason(bound().ticket, 'default', 'https://adm.example'), 'ok');
	assertEquals(reason(store.mint('p', 'default', 'watch').ticket, 'default', 'https://anywhere.example'), 'ok');
	assertEquals(store.mint('p', 'default', 'control', { holderName: 'ADM worker' }).holderName, 'ADM worker');
	assertEquals(store.mint('p', 'default', 'control').holderName, null);

	// The ttl is a request clamped by the mode's ceiling (control below view), with a floor; the record carries it.
	assertEquals(clampTicketTtl(undefined, 'watch'), TICKET_TTL_MS);
	assertEquals(clampTicketTtl(500_000, 'watch'), TICKET_TTL_MAX_VIEW_MS);
	assertEquals(clampTicketTtl(500_000, 'control'), TICKET_TTL_MAX_CONTROL_MS);
	assert(TICKET_TTL_MAX_CONTROL_MS < TICKET_TTL_MAX_VIEW_MS);
	assertEquals(clampTicketTtl(0, 'watch'), 1_000);
	assertEquals(clampTicketTtl(Number.NaN, 'control'), TICKET_TTL_MS);
	now = 0;
	const granted = new TicketStore({ now: () => now }).mint('p', 'default', 'control', { ttlMs: 500_000 });
	assertEquals([granted.ttlMs, granted.expiresAt], [TICKET_TTL_MAX_CONTROL_MS, TICKET_TTL_MAX_CONTROL_MS]);
});

// --- secrets --------------------------------------------------------------------

Deno.test('secrets: one trailing newline is stripped; anything else malformed is refused, never repaired', () => {
	assertEquals(normalizeSecret('value\n', 'V', '/p'), 'value');
	assertEquals(normalizeSecret('value', 'V', '/p'), 'value');
	const json = '[\n  {"id": "a"}\n]';
	assertEquals(normalizeSecret(`${json}\n`, 'V', '/p'), json, 'multi-line JSON survives');
	for (
		const [text, why] of [
			[' value\n', 'whitespace'],
			['value \n', 'whitespace'],
			['\n', ''],
			['﻿value', 'byte-order mark'],
			[`${json}\n\n\n`, 'trailing whitespace'],
		]
	) assertThrows(() => normalizeSecret(text!, 'V', '/p'), SecretError, why);
});

Deno.test('secrets: a file is read into the logical variable; an unreadable one names the variable', async () => {
	const resolved = await resolveSecrets({
		env: { TTK_API_KEYS_FILE: '/run/secrets/keys' },
		readFile: (path) => {
			// The implicit admin-record file is looked for too; absent here, as on a fresh disk.
			if (path === 'secrets/ttk_admin_user.json') return Promise.reject(new Deno.errors.NotFound(path));
			assertEquals(path, '/run/secrets/keys');
			return Promise.resolve('[{"id":"a","sha256":"' + 'd'.repeat(64) + '"}]\n');
		},
	});
	assert(resolved.TTK_API_KEYS?.startsWith('[{"id":"a"'));
	await assertRejects(
		() => resolveSecrets({ env: { TTK_API_KEYS_FILE: '/missing' }, readFile: () => Promise.reject(new Error('no')) }),
		SecretError,
		'TTK_API_KEYS_FILE',
	);
});

// --- live-view wire -------------------------------------------------------------

Deno.test('messages: frames round-trip their envelope and scale; a truncated frame is rejected', () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const meta = { type: 'frame' as const, seq: 7, ts: 1234, w: 1280, h: 720, targetId: 'T1' };
	const decoded = decodeFrame(encodeFrame(meta, jpeg).buffer as ArrayBuffer);
	assertEquals([decoded.meta, [...decoded.jpeg]], [meta, [...jpeg]]);
	assertEquals(decodeFrame(encodeFrame({ ...meta, scale: 0.5 }, jpeg).buffer as ArrayBuffer).meta.scale, 0.5);
	assertThrows(() => decodeFrame(new Uint8Array([1, 2]).buffer as ArrayBuffer), Error, 'shorter');
});

Deno.test('messages: the client and server unions admit their members and refuse malformed ones', () => {
	const client = (msg: unknown) => ClientMsgSchema.safeParse(msg).success;
	const server = (msg: unknown) => ServerMsgSchema.safeParse(msg).success;
	const key = { type: 'input.key', kind: 'press', key: 'a' };
	const bounds = { x: 1, y: 2, w: 3, h: 4 };
	for (
		const msg of [
			{ type: 'control.take' },
			{ type: 'input.mouse', kind: 'click', x: 1, y: 2 },
			{ type: 'live.hover', id: 'h1', x: 10, y: 20 },
			{ type: 'live.highlight', index: 3 },
			{ type: 'live.highlight', bounds, ttl_ms: 100 },
			{ type: 'live.keyframe' },
			{ type: 'live.quality' },
			{ type: 'live.quality', scale: 0.5, jpeg_quality: 30, max_fps: 10 },
			key,
			{ ...key, windowsVirtualKeyCode: 65, location: 0, autoRepeat: false },
			{ ...key, modifiers: 2 },
			{ ...key, modifiers: ['ctrl', 'shift'] },
			{ ...key, modifiers: [] },
			{ type: 'pong' },
		]
	) assert(client(msg), JSON.stringify(msg));
	for (
		const msg of [
			{ type: 'input.mouse', kind: 'teleport', x: 1, y: 2 },
			{ type: 'nonsense' },
			{ type: 'input.key', kind: 'down' },
			{ type: 'live.hover', x: 10, y: 20 },
			{ type: 'live.hover', id: '', x: 10, y: 20 },
			{ type: 'live.hover', id: 'x'.repeat(65), x: 1, y: 1 },
			{ type: 'live.highlight' },
			{ type: 'live.highlight', index: 1, bounds },
			{ type: 'live.highlight', index: 1, ttl_ms: 50 },
			{ type: 'live.highlight', index: 1, ttl_ms: 60_000 },
			{ type: 'live.highlight', index: -1 },
			{ type: 'live.quality', scale: 2 },
			{ type: 'live.quality', max_fps: 120 },
			{ ...key, modifiers: ['hyper'] },
			{ ...key, windowsVirtualKeyCode: 999 },
		]
	) assert(!client(msg), JSON.stringify(msg));
	assertEquals(ClientMsgSchema.parse({ type: 'pong' }), { type: 'pong' });

	const element = { index: 3, tag: 'button', label: 'Save', bounds, visible: true, frame_id: 'F' };
	const meta = {
		type: 'meta',
		sessionId: 's',
		viewerId: 'v',
		mode: 'watch',
		viewport: { w: 1, h: 1 },
		tabs: [],
		lock: { holder: 'v', principal: 'p', takenAt: 1, holderName: 'ADM worker' },
		version: '0',
	};
	for (
		const msg of [
			{ type: 'hover', id: 'h1', element, frame_id: 'F' },
			{ type: 'hover', id: 'h1', element: null, frame_id: null },
			{ type: 'quality', scale: 0.5, jpeg_quality: 30, max_fps: 10 },
			{ type: 'viewport', w: 1920, h: 993, frame_scale: 0.6667 },
			meta,
			{ ...meta, frame_scale: 0.5 },
			{ type: 'ping' },
			{ type: 'error', code: 'input-rejected', message: 'no focused tab', reason: 'no-focused-tab' },
			{ type: 'error', code: 'bad-message', message: 'x' },
		]
	) assert(server(msg), JSON.stringify(msg));
	for (
		const msg of [
			{ type: 'hover', element, frame_id: 'F' },
			{ type: 'viewport', w: 1920, h: 993 },
			{ type: 'error', code: 'internal', message: 'x', reason: 'because' },
		]
	) assert(!server(msg), JSON.stringify(msg));
	// The hover reply carries the core preset: a value-bearing field is stripped.
	const parsed = ServerMsgSchema.parse({
		type: 'hover',
		id: 'h1',
		element: { ...element, input: { value: 'x' } },
		frame_id: 'F',
	});
	assert(!JSON.stringify(parsed).includes('"input"'));
});

// --- live view ------------------------------------------------------------------

Deno.test('liveview: frame_scale and live.quality are clamped into their bounds', () => {
	assertEquals(Math.round(frameScaleFor(1920, 993) * 10_000) / 10_000, 0.6667);
	assertEquals([frameScaleFor(1280, 720), frameScaleFor(800, 600), frameScaleFor(2560, 720)], [1, 1, 0.5]);
	assertEquals(frameScaleFor(0, 0), 1, 'an unknown viewport is unscaled rather than infinite');
	assertEquals(frameScaleFor(1920, 993, CAST_MAX_WIDTH / 2, CAST_MAX_HEIGHT / 2), 640 / 1920);
	const current = { scale: 1, jpegQuality: 60, maxFps: 60 };
	assertEquals(clampQuality(current, {}), current);
	assertEquals(clampQuality(current, { scale: 0.01, jpeg_quality: 500, max_fps: 0 }), {
		scale: 0.1,
		jpegQuality: 100,
		maxFps: 1,
	});
	assertEquals(clampQuality(current, { scale: 0.5, jpeg_quality: 20.6, max_fps: 30 }), {
		scale: 0.5,
		jpegQuality: 21,
		maxFps: 30,
	});
	// A socket that only watches sends nothing, so it gets the grace window until it has answered once.
	assertEquals([pongDeadlineMs(false), pongDeadlineMs(true)], [PONG_GRACE_MS, PONG_TIMEOUT_MS]);
	assert(PONG_GRACE_MS > PONG_TIMEOUT_MS);
});

Deno.test('liveview: every URL the socket emits — state, tabs, titles, frames — loses its query and fragment', () => {
	assertEquals(
		viewUrl('https://app.example:8443/inbox/42?token=SECRET#access_token=SECRET'),
		'https://app.example:8443/inbox/42',
	);
	assertEquals(viewUrl('about:blank'), 'about:blank');
	assertEquals(viewUrl('not a url at all'), '', 'an unparseable target reduces to nothing');
	// Chromium titles an untitled page with its URL; a real title, or one naming another URL, is the page's own.
	const url = 'https://app.example/inbox?token=SECRET#access_token=SECRET';
	assertEquals(viewTitle('app.example/inbox?token=SECRET#access_token=SECRET', url), 'app.example/inbox');
	assertEquals(viewTitle(url, url), 'https://app.example/inbox');
	for (const title of ['Inbox', 'Are you sure? — Inbox', 'other.example/page?q=1']) {
		assertEquals(viewTitle(title, url), title);
	}

	const tabs = tabsOf(
		{
			agentFocusTargetId: 'T1',
			tabs: [
				{ tabId: 'AAAA', targetId: 'T1', url: 'https://mail.example/u/0?code=SECRET', title: 'Inbox' },
				{
					tabId: 'BBBB',
					targetId: 'T2',
					url: 'https://id.example/cb#access_token=SECRET',
					title: 'id.example/cb#access_token=SECRET',
				},
			],
		} as unknown as Parameters<typeof tabsOf>[0],
	);
	assertEquals(tabs.map((tab) => [tab.url, tab.title, tab.focused]), [
		['https://mail.example/u/0', 'Inbox', true],
		['https://id.example/cb', 'id.example/cb', false],
	]);
	// Frames: top document first, then depth-first; the parent link from the tree's shape (CDP omits parentId on
	// roots).
	const frames = framesOfTree({
		frame: { id: 'F0', url: 'https://app.example/dash?session=SECRET', name: '' },
		childFrames: [
			{
				frame: { id: 'F1', url: 'https://id.example/cb#access_token=SECRET', name: 'auth' },
				childFrames: [{ frame: { id: 'F2', url: 'https://id.example/inner?t=SECRET' } }],
			},
			{ frame: { id: 'F3', url: 'https://ads.example/slot', name: 'ad' } },
		],
	});
	assertEquals(frames.map((frame) => [frame.frame_id, frame.parent_id, frame.url, frame.name]), [
		['F0', null, 'https://app.example/dash', ''],
		['F1', 'F0', 'https://id.example/cb', 'auth'],
		['F2', 'F1', 'https://id.example/inner', ''],
		['F3', 'F0', 'https://ads.example/slot', 'ad'],
	]);
	assert(!JSON.stringify([tabs, frames]).includes('SECRET'));
});

Deno.test('liveview: keys resolve to real virtual key codes, never 0, and modifiers take either shape', () => {
	// Without windowsVirtualKeyCode every human keystroke arrives with event.keyCode === 0.
	const a = resolveKeySpec('a');
	assertEquals([a?.windowsVirtualKeyCode, a?.code, a?.text], [65, 'KeyA', 'a']);
	const named = { Enter: 13, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
	for (const [name, code] of Object.entries(named)) {
		assertEquals(resolveKeySpec(name)?.windowsVirtualKeyCode, code, name);
	}
	assertEquals(resolveKeySpec('Enter')?.text, '\r', 'the keypress a form submit listens for');
	assertEquals(resolveKeySpec('NotARealKeyName'), null, 'answered, not dispatched with keyCode 0');
	assertEquals(resolveKeySpec('NotARealKeyName', 200)?.windowsVirtualKeyCode, 200);
	assertEquals(resolveKeySpec('a', 200)?.windowsVirtualKeyCode, 200, 'an override wins over the table');
	assertEquals([modifierBits(undefined), modifierBits(6), modifierBits([]), modifierBits(['ctrl'])], [0, 6, 0, 2]);
	assertEquals(modifierBits(['cmd']), modifierBits(['meta']));
	assertEquals(modifierBits(['ctrl', 'shift']), 2 | 8);
	assertEquals(modifierBits(['nonsense'] as unknown as string[]), 0);
});

Deno.test('logger: levels filter and fields merge', () => {
	const lines: string[] = [];
	const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });
	logger.info('ignored');
	logger.warn('kept', { a: 1 });
	assertEquals(lines.length, 1);
	const entry = JSON.parse(lines[0]!);
	assertEquals([entry.level, entry.msg, entry.a], ['warn', 'kept', 1]);
	logger.with({ session: 's1' }).error('boom');
	assertEquals(JSON.parse(lines[1]!).session, 's1');
});
