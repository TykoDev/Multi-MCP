/**
 * R9 (W7, D-134 – D-136): MCP Apps in the gateway — the startup refusals of design §2.1 (AC36), the embed documents
 * and their connect-src substitution, the embed-ticket mint (origin list ∩ per-token overlay, mode ceiling, 30 s,
 * origin-bound, single use; F10, F21), and AC37 end to end through the real middleware: a 2025-era client on the
 * default stateless mount — no capabilities declared — gets a ticket that redeems only from its origin, while an
 * upgrade from an origin `TTK_ALLOWED_ORIGINS` does not admit is refused before the ticket is looked at.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { join } from '@std/path';
import { type EmbedTicketInput, type Scope, SessionRegistry, ToolError } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { type ApiKeyRecord, ConfigError, ENV_NAMES, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import {
	CONNECT_SRC_PLACEHOLDER,
	createMcpApps,
	EMBED_A2UI_FILE,
	EMBED_LIVE_FILE,
	EMBED_TICKET_TTL_MS,
	loadEmbedDocuments,
	socketOrigin,
} from './mcp_apps.ts';
import { TicketStore } from './tickets.ts';

const HOST_ORIGIN = 'https://abc123.host.example';
const BASE_ENV = {
	TTK_HOST: '127.0.0.1',
	TTK_PORT: '8787',
	TTK_PUBLIC_URL: 'https://gw.example.test',
	TTK_ALLOWED_ORIGINS: '127.0.0.1,localhost,abc123.host.example',
} as const;

/** A web root holding two synthetic embeds, built the way `build_embed.ts` leaves the placeholder. */
async function embedRoot(files: readonly string[] = [EMBED_LIVE_FILE, EMBED_A2UI_FILE]): Promise<string> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const root = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'embeds-' });
	await Deno.mkdir(join(root, 'dist'));
	for (const file of files) {
		await Deno.writeTextFile(
			join(root, 'dist', file),
			`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
				`connect-src ${CONNECT_SRC_PLACEHOLDER}; base-uri 'none'"><title>${file}</title>`,
		);
	}
	return root;
}

// --- AC36: every refusal of design §2.1 fires at start ------------------------------------------------------------

Deno.test('AC36: TTK_MCP_APPS* refusals fire at start, and the names are read (ENV_NAMES)', () => {
	for (const name of ['TTK_MCP_APPS', 'TTK_MCP_APPS_ORIGINS', 'TTK_MCP_APPS_DOMAIN']) {
		assert((ENV_NAMES as readonly string[]).includes(name), `${name} is read only if it is in ENV_NAMES`);
	}
	// `off` is off (D-150: unset is `control`; its own test below).
	assertEquals(loadConfig({ TTK_MCP_APPS: 'OFF' }).mcpApps, null);
	// Not an enum member.
	assertThrows(() => loadConfig({ TTK_MCP_APPS: 'on' }), ConfigError, 'TTK_MCP_APPS: expected off|watch|control');
	// D-150: on with no origins is no longer refused — the mint admits by the effective allowed origins instead.
	assertEquals(loadConfig({ ...BASE_ENV, TTK_MCP_APPS: 'watch' }).mcpApps, {
		mode: 'watch',
		origins: [],
		domain: null,
		defaulted: false,
	});
	// On in a cluster, named: still refused.
	assertThrows(
		() =>
			loadConfig({
				...BASE_ENV,
				TTK_MCP_APPS: 'watch',
				TTK_MCP_APPS_ORIGINS: HOST_ORIGIN,
				TTK_CLUSTER_KV: 'tests/.scratch/never.kv',
			}),
		ConfigError,
		'cannot run in a cluster',
	);
	// A listed hostname TTK_ALLOWED_ORIGINS does not admit.
	assertThrows(
		() => loadConfig({ ...BASE_ENV, TTK_MCP_APPS: 'watch', TTK_MCP_APPS_ORIGINS: 'https://other.host.example' }),
		ConfigError,
		'not admitted by TTK_ALLOWED_ORIGINS',
	);
	// The default TTK_ALLOWED_ORIGINS admits only this server's own names, so a host origin always needs widening.
	assertThrows(
		() =>
			loadConfig({
				TTK_PUBLIC_URL: 'https://gw.example.test',
				TTK_MCP_APPS: 'watch',
				TTK_MCP_APPS_ORIGINS: HOST_ORIGIN,
			}),
		ConfigError,
		'add abc123.host.example to TTK_ALLOWED_ORIGINS',
	);
	// Malformed origins: a path, a trailing slash, no scheme, an opaque origin, plain http beyond loopback.
	for (const bad of [`${HOST_ORIGIN}/app`, `${HOST_ORIGIN}/`, 'abc123.host.example', 'data:text/html,x', 'null']) {
		assertThrows(
			() => loadConfig({ ...BASE_ENV, TTK_MCP_APPS_ORIGINS: bad }),
			ConfigError,
			'TTK_MCP_APPS_ORIGINS',
			`${bad} must be refused`,
		);
	}
	assertThrows(
		() => loadConfig({ ...BASE_ENV, TTK_MCP_APPS: 'watch', TTK_MCP_APPS_ORIGINS: 'http://abc123.host.example' }),
		ConfigError,
		'must be https://',
	);
	// Domain: control characters and length.
	assertThrows(
		() => loadConfig({ ...BASE_ENV, TTK_MCP_APPS_DOMAIN: 'abc\u0007.example' }),
		ConfigError,
		'TTK_MCP_APPS_DOMAIN: must not contain control characters',
	);
	assertThrows(
		() => loadConfig({ ...BASE_ENV, TTK_MCP_APPS_DOMAIN: 'a'.repeat(254) }),
		ConfigError,
		'TTK_MCP_APPS_DOMAIN: at most 253',
	);

	// And a valid deployment: the mode, the origins as written, the domain passed through; http only for loopback.
	const on = loadConfig({
		...BASE_ENV,
		TTK_MCP_APPS: 'Control',
		TTK_MCP_APPS_ORIGINS: `${HOST_ORIGIN}, http://localhost:5173, ${HOST_ORIGIN}`,
		TTK_MCP_APPS_DOMAIN: 'abc123.host.example',
	});
	assertEquals(on.mcpApps, {
		mode: 'control',
		origins: [HOST_ORIGIN, 'http://localhost:5173'],
		domain: 'abc123.host.example',
		defaulted: false,
	});
});

Deno.test('D-150: TTK_MCP_APPS unset is control on a single node, and off with a note in a cluster', () => {
	const single = loadConfig({});
	assertEquals(single.mcpApps, { mode: 'control', origins: [], domain: null, defaulted: true });
	assertEquals(single.featureNotes.filter((note) => note.includes('TTK_MCP_APPS')), []);
	// An empty value is unset.
	assertEquals(loadConfig({ TTK_MCP_APPS: '  ' }).mcpApps?.defaulted, true);
	// A listed origin narrows the default exactly as it narrows a named mode, and is checked against the admission
	// list the same way.
	assertEquals(loadConfig({ ...BASE_ENV, TTK_MCP_APPS_ORIGINS: HOST_ORIGIN }).mcpApps?.origins, [HOST_ORIGIN]);
	assertThrows(
		() => loadConfig({ TTK_PUBLIC_URL: 'https://gw.example.test', TTK_MCP_APPS_ORIGINS: HOST_ORIGIN }),
		ConfigError,
		'not admitted by TTK_ALLOWED_ORIGINS',
	);
	// Clustered: off, not refused, and one note says why.
	const clustered = loadConfig({
		...BASE_ENV,
		TTK_MCP_APPS_ORIGINS: HOST_ORIGIN,
		TTK_CLUSTER_KV: 'tests/.scratch/x.kv',
	});
	assertEquals(clustered.mcpApps, null);
	const notes = clustered.featureNotes.filter((note) => note.includes('TTK_MCP_APPS'));
	assertEquals(notes.length, 1);
	assertStringIncludes(notes[0] ?? '', 'TTK_MCP_APPS is unset and stays off');
	assertStringIncludes(notes[0] ?? '', 'cannot run in a cluster');
});

// --- the embed documents -------------------------------------------------------------------------------------------

Deno.test('R9: the embeds load from the web root with the socket origin of TTK_PUBLIC_URL in connect-src', async () => {
	const root = await embedRoot();
	try {
		assertEquals(socketOrigin(new URL('https://gw.example.test/base/')), 'wss://gw.example.test');
		assertEquals(socketOrigin(new URL('http://127.0.0.1:8787')), 'ws://127.0.0.1:8787');
		const https = loadEmbedDocuments(new URL('https://gw.example.test:8443'), root);
		assertStringIncludes(https.liveViewHtml, 'connect-src wss://gw.example.test:8443;');
		assertStringIncludes(https.a2uiHtml, 'connect-src wss://gw.example.test:8443;');
		assert(!https.liveViewHtml.includes(CONNECT_SRC_PLACEHOLDER) && !https.a2uiHtml.includes(CONNECT_SRC_PLACEHOLDER));
		const http = loadEmbedDocuments(new URL('http://127.0.0.1:8787'), root);
		assertStringIncludes(http.liveViewHtml, 'connect-src ws://127.0.0.1:8787;');
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('AC36: an embed missing from the build, or built without the placeholder, refuses startup', async () => {
	const apiKey = await generateApiKey('key-1', ['mcp:invoke', 'view:watch']);
	const partial = await embedRoot([EMBED_LIVE_FILE]);
	const stale = await embedRoot();
	try {
		assertThrows(
			() => loadEmbedDocuments(new URL('https://gw.example.test'), partial),
			ConfigError,
			`TTK_MCP_APPS: the MCP Apps embed ${EMBED_A2UI_FILE} is missing`,
		);
		await Deno.writeTextFile(join(stale, 'dist', EMBED_LIVE_FILE), '<!doctype html><p>no policy</p>');
		assertThrows(
			() => loadEmbedDocuments(new URL('https://gw.example.test'), stale),
			ConfigError,
			'carries no connect-src placeholder',
		);
		// Through the app: the refusal is the first thing `createGatewayApp` does, before anything is allocated.
		const config = loadConfig({ ...BASE_ENV, TTK_MCP_APPS: 'watch', TTK_MCP_APPS_ORIGINS: HOST_ORIGIN });
		const registry = new SessionRegistry({ reapIntervalMs: 0 });
		try {
			assertThrows(
				() =>
					createGatewayApp({
						config,
						verifier: new VerifierChain({ config, allowAnonymous: false }),
						registry,
						version: 'test',
						logger: createLogger({ level: 'error', write: () => {} }),
						webRoot: partial,
					}),
				ConfigError,
				'is missing from packages/web/dist',
			);
			// D-150: the default does not refuse a build without the embeds — it stays off, says so once, and the
			// tools, the resources and the diagnostics all read off.
			const defaulted = loadConfig({ ...BASE_ENV, TTK_API_KEYS: JSON.stringify([apiKey.record]) });
			assertEquals(defaulted.mcpApps?.defaulted, true);
			const warnings: string[] = [];
			const app = createGatewayApp({
				config: defaulted,
				verifier: new VerifierChain({ config: defaulted, allowAnonymous: false }),
				registry,
				version: 'test',
				logger: { ...createLogger({ level: 'error', write: () => {} }), warn: (line) => warnings.push(line) },
				webRoot: partial,
			});
			try {
				assertEquals(warnings.filter((line) => line.includes('TTK_MCP_APPS')).length, 1, warnings.join(' | '));
				assertStringIncludes(warnings.find((line) => line.includes('TTK_MCP_APPS')) ?? '', 'is unset and stays off');
				const listed = await app.app.request('https://gw.example.test/mcp', {
					method: 'POST',
					headers: {
						host: 'gw.example.test',
						authorization: `Bearer ${apiKey.key}`,
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
					},
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
				});
				const body = await listed.text();
				assert(body.includes('browser_list_sessions'), 'the listing is the real catalog');
				assert(!body.includes('browser_live_view') && !body.includes('browser_live_ticket'), body.slice(0, 200));
			} finally {
				await app.close();
			}
		} finally {
			await registry.shutdown();
		}
	} finally {
		await Deno.remove(partial, { recursive: true });
		await Deno.remove(stale, { recursive: true });
	}
});

// --- the embed-ticket mint -------------------------------------------------------------------------------------------

function mintFixture(options: {
	/** `null` leaves `TTK_MCP_APPS` unset — D-150's default, `control`. */
	mode?: 'watch' | 'control' | null;
	overlay?: readonly string[];
	publicUrl?: string;
	records?: readonly ApiKeyRecord[];
	/** `TTK_MCP_APPS_ORIGINS`; `''` leaves the list empty (D-150). */
	appsOrigins?: string;
} = {}) {
	const clock = { now: 1_000_000 };
	const tickets = new TicketStore({ now: () => clock.now });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const warnings: string[] = [];
	const infos: string[] = [];
	const config = loadConfig({
		...BASE_ENV,
		...(options.publicUrl === undefined ? {} : { TTK_PUBLIC_URL: options.publicUrl }),
		...(options.mode === null ? {} : { TTK_MCP_APPS: options.mode ?? 'watch' }),
		TTK_MCP_APPS_ORIGINS: options.appsOrigins ?? `${HOST_ORIGIN},http://localhost:5173`,
	});
	const apps = createMcpApps({
		config,
		registry,
		tickets,
		origins: { forToken: () => options.overlay ?? [] },
		keyRecords: () => options.records ?? [],
		logger: { warn: (message) => warnings.push(message), info: (message) => infos.push(message) },
		embeds: { liveViewHtml: 'live', a2uiHtml: 'a2ui' },
	});
	assert(apps !== undefined);
	const all: ReadonlySet<Scope> = new Set<Scope>(['mcp:invoke', 'view:watch', 'view:control']);
	const mint = (input: Partial<EmbedTicketInput>) =>
		apps.mintTicket({
			principal: 'key-1',
			access: { owner: 'api-key:key-1', admin: false },
			scopes: all,
			mode: 'watch',
			origin: HOST_ORIGIN,
			holderName: null,
			...input,
		});
	return { apps, tickets, clock, warnings, infos, registry, mint };
}

Deno.test('R9 (AC37): an embed ticket is origin-bound, 30 s, single use, and named for TTK_PUBLIC_URL', async () => {
	const f = mintFixture();
	try {
		assertEquals(f.apps.connectDomains, ['wss://gw.example.test']);
		assertEquals(f.warnings, [], 'an https public URL draws no reachability warning');
		const minted = await f.mint({});
		assertEquals(minted.session_id, 'default');
		assertEquals(minted.mode, 'watch');
		assertEquals(minted.origin_bound, HOST_ORIGIN);
		assertEquals(minted.expires_in, EMBED_TICKET_TTL_MS / 1000);
		assertEquals(minted.expires_in, 30);
		assertEquals(minted.ws_url, 'wss://gw.example.test/live/default/ws');
		assertEquals(minted.control_plane_url, 'https://gw.example.test/#/view/default');
		// Bound: another origin — or none — cannot redeem it, and the failed attempt spends it.
		assertEquals(f.tickets.redeem(minted.ticket, 'default', 'https://evil.example'), {
			ok: false,
			reason: 'origin-mismatch',
		});
		assertEquals(f.tickets.redeem(minted.ticket, 'default', HOST_ORIGIN), { ok: false, reason: 'consumed' });
		// Single use from the right origin too.
		const second = await f.mint({});
		assertEquals(f.tickets.redeem(second.ticket, 'default', HOST_ORIGIN).ok, true);
		assertEquals(f.tickets.redeem(second.ticket, 'default', HOST_ORIGIN), { ok: false, reason: 'consumed' });
		// 30 s, by the store's clock.
		const third = await f.mint({});
		f.clock.now += EMBED_TICKET_TTL_MS;
		assertEquals(f.tickets.redeem(third.ticket, 'default', HOST_ORIGIN), { ok: false, reason: 'expired' });
		// A loopback http host origin is a listed origin too (a desktop host or a harness on this machine)…
		const local = await f.mint({ origin: 'http://localhost:5173' });
		assertEquals(local.origin_bound, 'http://localhost:5173');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('R9 (AC37, F10): an origin not listed, or one the per-token overlay excludes, is refused', async () => {
	const f = mintFixture();
	const narrowed = mintFixture({ overlay: ['http://localhost:5173'] });
	try {
		for (const origin of ['https://evil.example', `${HOST_ORIGIN}/`, 'null', HOST_ORIGIN.toUpperCase()]) {
			const refused = await assertRejects(() => f.mint({ origin }), ToolError);
			assertEquals(refused.code, 'invalid-arguments', origin);
			assertStringIncludes(refused.message, 'TTK_MCP_APPS_ORIGINS');
		}
		assertEquals(f.tickets.size, 0, 'a refused origin mints nothing');
		// The overlay narrows to localhost:5173 for this credential: the host origin is listed but no longer allowed.
		const excluded = await assertRejects(() => narrowed.mint({}), ToolError);
		assertEquals(excluded.code, 'invalid-arguments');
		assertEquals((await narrowed.mint({ origin: 'http://localhost:5173' })).origin_bound, 'http://localhost:5173');
	} finally {
		await f.registry.shutdown();
		await narrowed.registry.shutdown();
	}
});

Deno.test('D-150: with no TTK_MCP_APPS_ORIGINS an https origin TTK_ALLOWED_ORIGINS admits is bound exactly', async () => {
	// BASE_ENV admits 127.0.0.1, localhost and abc123.host.example by hostname; the default mode is `control`.
	const f = mintFixture({ mode: null, appsOrigins: '' });
	const narrowed = mintFixture({ mode: null, appsOrigins: '', overlay: ['http://localhost:5173'] });
	try {
		assertEquals(f.apps.mode, 'control');
		assertEquals(f.apps.origins, []);
		// Admitted by hostname, any port, and bound to exactly the origin named — 30 s, single use, as ever.
		for (const origin of [HOST_ORIGIN, 'https://abc123.host.example:8443', 'http://localhost:5173']) {
			const minted = await f.mint({ origin });
			assertEquals(minted.origin_bound, origin);
			assertEquals(minted.expires_in, 30);
			assertEquals(f.tickets.redeem(minted.ticket, 'default', 'https://evil.example'), {
				ok: false,
				reason: 'origin-mismatch',
			});
		}
		const exact = await f.mint({});
		assertEquals(f.tickets.redeem(exact.ticket, 'default', HOST_ORIGIN).ok, true);
		assertEquals(f.tickets.redeem(exact.ticket, 'default', HOST_ORIGIN), { ok: false, reason: 'consumed' });
		// Refused: a hostname the admission list does not hold, plain http beyond loopback, anything that is not
		// exactly an origin (a path, a trailing slash, case, an opaque origin), and no origin at all — `originAllowed`
		// passes a missing Origin header, which a binding must never be.
		const before = f.tickets.size;
		for (
			const origin of [
				'https://evil.example',
				'http://abc123.host.example',
				`${HOST_ORIGIN}/`,
				`${HOST_ORIGIN}/app`,
				HOST_ORIGIN.toUpperCase(),
				'null',
				'data:text/html,x',
				'',
			]
		) {
			const refused = await assertRejects(() => f.mint({ origin }), ToolError, undefined, origin);
			assertEquals(refused.code, 'invalid-arguments', origin);
			assertStringIncludes(refused.message, 'whose hostname TTK_ALLOWED_ORIGINS admits', origin);
		}
		assertEquals(f.tickets.size, before, 'a refused origin mints nothing');
		// The per-token overlay still narrows (F10): only its exact origins pass for this credential.
		const excluded = await assertRejects(() => narrowed.mint({}), ToolError);
		assertEquals(excluded.code, 'invalid-arguments');
		assertEquals((await narrowed.mint({ origin: 'http://localhost:5173' })).origin_bound, 'http://localhost:5173');
		// The default ceiling is control, and a control ticket still needs view:control.
		assertEquals((await f.mint({ mode: 'control' })).mode, 'control');
		const unscoped = await assertRejects(
			() => f.mint({ mode: 'control', scopes: new Set<Scope>(['mcp:invoke', 'view:watch']) }),
			ToolError,
		);
		assertEquals(unscoped.code, 'scope-required');
	} finally {
		await f.registry.shutdown();
		await narrowed.registry.shutdown();
	}
});

Deno.test('D-150: a named mode with no TTK_MCP_APPS_ORIGINS admits the same way, and a list still narrows', async () => {
	const named = mintFixture({ mode: 'watch', appsOrigins: '' });
	const listed = mintFixture({ mode: null, appsOrigins: HOST_ORIGIN });
	try {
		assertEquals((await named.mint({ origin: 'https://abc123.host.example:9443' })).mode, 'watch');
		// A non-empty list narrows the default exactly as it narrows a named mode: an admitted hostname is not enough.
		const refused = await assertRejects(() => listed.mint({ origin: 'https://abc123.host.example:9443' }), ToolError);
		assertEquals(refused.code, 'invalid-arguments');
		assertStringIncludes(refused.message, 'TTK_MCP_APPS_ORIGINS');
		assertEquals((await listed.mint({})).origin_bound, HOST_ORIGIN);
	} finally {
		await named.registry.shutdown();
		await listed.registry.shutdown();
	}
});

Deno.test('R9 (AC37): control needs TTK_MCP_APPS=control AND view:control, and never names the scope', async () => {
	const watchOnly = mintFixture();
	const control = mintFixture({ mode: 'control' });
	try {
		const ceiling = await assertRejects(() => watchOnly.mint({ mode: 'control' }), ToolError);
		assertEquals(ceiling.code, 'feature-unavailable');
		assertStringIncludes(ceiling.message, 'TTK_MCP_APPS=control');

		const unscoped = await assertRejects(
			() => control.mint({ mode: 'control', scopes: new Set<Scope>(['mcp:invoke', 'view:watch']) }),
			ToolError,
		);
		assertEquals(unscoped.code, 'scope-required');
		assert(!unscoped.message.includes('view:'), `the refusal names a scope: ${unscoped.message}`);

		const granted = await control.mint({ mode: 'control' });
		assertEquals(granted.mode, 'control');
		assertEquals(granted.expires_in, 30, 'a control ticket is no longer-lived than a watch one');
		// A watch request from a control-capable credential stays a watch ticket (the REST mint's narrowing).
		assertEquals((await control.mint({ mode: 'watch' })).mode, 'watch');
		// A credential without any view scope gets nothing.
		const blind = await assertRejects(() => control.mint({ scopes: new Set<Scope>(['mcp:invoke']) }), ToolError);
		assertEquals(blind.code, 'scope-required');
	} finally {
		await watchOnly.registry.shutdown();
		await control.registry.shutdown();
	}
});

Deno.test('R9: an unknown session is refused; the holder label comes from the key records, for API keys only (F21)', async () => {
	const labelled = mintFixture({
		records: [{ id: 'key-1', sha256: '0'.repeat(64), label: 'Claude host' }],
	});
	try {
		const unknown = await assertRejects(() => labelled.mint({ sessionId: 'nope' }), ToolError);
		assertEquals(unknown.code, 'unknown-session');
		const minted = await labelled.mint({});
		assertEquals(labelled.tickets.redeem(minted.ticket, 'default', HOST_ORIGIN).ok, true);
		const record = (await labelled.mint({})).ticket;
		const redeemed = labelled.tickets.redeem(record, 'default', HOST_ORIGIN);
		assert(redeemed.ok);
		assertEquals(redeemed.record.holderName, 'Claude host');
		assertEquals(redeemed.record.access, { owner: 'api-key:key-1', admin: false });
		// An OAuth subject that happens to spell a key id is not that key.
		const oauth = await labelled.mint({ access: { owner: 'oauth:key-1', admin: false } });
		const asOauth = labelled.tickets.redeem(oauth.ticket, 'default', HOST_ORIGIN);
		assert(asOauth.ok);
		assertEquals(asOauth.record.holderName, null);
		// A label the caller already resolved wins.
		const named = await labelled.mint({ holderName: 'Given' });
		const asNamed = labelled.tickets.redeem(named.ticket, 'default', HOST_ORIGIN);
		assert(asNamed.ok);
		assertEquals(asNamed.record.holderName, 'Given');
	} finally {
		await labelled.registry.shutdown();
	}
});

Deno.test('B4: an administrator account gets the label the REST mint shows; another realm spelling one does not', async () => {
	const f = mintFixture();
	try {
		// A password login is an `api-key` principal `admin:<username>` (GW-4 keeps that prefix off every key id), and
		// its label never survives the trip through the SDK's AuthInfo — so the mint derives it, as the REST mint shows.
		const admin = await f.mint({ principal: 'admin:root', access: { owner: 'api-key:admin:root', admin: true } });
		const asAdmin = f.tickets.redeem(admin.ticket, 'default', HOST_ORIGIN);
		assert(asAdmin.ok);
		assertEquals(asAdmin.record.holderName, 'Administrator (root)');
		assertEquals(asAdmin.record.principal, 'admin:root');
		const oauth = await f.mint({ principal: 'admin:root', access: { owner: 'oauth:admin:root', admin: false } });
		const asOauth = f.tickets.redeem(oauth.ticket, 'default', HOST_ORIGIN);
		assert(asOauth.ok);
		assertEquals(asOauth.record.holderName, null);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('R9: a public URL that is not https draws one reachability warning, and off means no deployment', async () => {
	const f = mintFixture({ publicUrl: 'http://127.0.0.1:8787' });
	// D-150: the default draws the same line at `info`, not `warn` — every plain-http deployment now starts with it.
	const defaulted = mintFixture({ publicUrl: 'http://127.0.0.1:8787', mode: null });
	try {
		assertEquals(f.warnings.length, 1);
		assertStringIncludes(f.warnings[0]!, 'TTK_PUBLIC_URL');
		assertEquals(f.infos, []);
		assertEquals(defaulted.warnings, []);
		assertEquals(defaulted.infos.length, 1);
		assertStringIncludes(defaulted.infos[0]!, 'TTK_MCP_APPS is on by default but TTK_PUBLIC_URL');
		assertEquals(f.apps.connectDomains, ['ws://127.0.0.1:8787']);
		assertEquals(
			createMcpApps({
				config: loadConfig({ TTK_MCP_APPS: 'off' }),
				registry: f.registry,
				tickets: f.tickets,
				origins: { forToken: () => [] },
				keyRecords: () => [],
			}),
			undefined,
		);
	} finally {
		await f.registry.shutdown();
		await defaulted.registry.shutdown();
	}
});

// --- AC37 through the real middleware ---------------------------------------------------------------------------------

Deno.test('AC37: a 2025-era client on the default stateless mount mints an embed ticket; the upgrade front still rules', async () => {
	const root = await embedRoot();
	const key = await generateApiKey('key-1', ['mcp:invoke', 'view:watch']);
	const config = loadConfig({
		...BASE_ENV,
		TTK_API_KEYS: JSON.stringify([key.record]),
		TTK_MCP_APPS: 'watch',
		TTK_MCP_APPS_ORIGINS: HOST_ORIGIN,
		TTK_MCP_APPS_DOMAIN: 'abc123.host.example',
	});
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
		webRoot: root,
	});
	const base = 'http://127.0.0.1:8787';
	const headers = {
		host: '127.0.0.1:8787',
		authorization: `Bearer ${key.key}`,
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	try {
		// No `initialize`, no capabilities, no 2026 envelope: the legacy stateless path a 2025 host takes.
		const response = await gateway.app.request(`${base}/mcp`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'browser_live_ticket', arguments: { origin: HOST_ORIGIN } },
			}),
		});
		assertEquals(response.status, 200);
		const text = await response.text();
		const reply = JSON.parse(
			(response.headers.get('content-type') ?? '').includes('event-stream')
				? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5)
				: text,
		) as { result: { isError?: boolean; structuredContent: Record<string, string> } };
		assertEquals(reply.result.isError, undefined, JSON.stringify(reply.result));
		const minted = reply.result.structuredContent;
		assertEquals(minted.origin_bound, HOST_ORIGIN);
		assertEquals(minted.ws_url, 'wss://gw.example.test/live/default/ws');
		assertEquals(gateway.tickets.size, 1);

		// An upgrade whose Origin TTK_ALLOWED_ORIGINS does not admit is answered by the front — 403 origin-forbidden —
		// before the ticket is examined, so the ticket is still there for the frame it was minted for.
		const refused = await gateway.app.request(`${base}/live/default/ws?ticket=${minted.ticket}`, {
			headers: { host: '127.0.0.1:8787', upgrade: 'websocket', origin: 'https://evil.example' },
		});
		assertEquals(refused.status, 403);
		assertEquals((await refused.json()).type, 'https://tykotech.eu/problems/origin-forbidden');
		assertEquals(gateway.tickets.size, 1, 'the refused upgrade did not touch the ticket');
		// It redeems only from the origin it was minted for — issued to the principal id, never the owner string (R1-3).
		const redeemed = gateway.tickets.redeem(minted.ticket!, 'default', HOST_ORIGIN);
		assert(redeemed.ok);
		assertEquals(redeemed.record.principal, 'key-1');
		assertEquals(redeemed.record.access?.owner, 'api-key:key-1');

		// The documents the gateway serves carry this deployment's socket origin and the operator's domain.
		const list = await gateway.app.request(`${base}/mcp`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'resources/read',
				params: { uri: 'ui://tykotech/live-view' },
			}),
		});
		const listed = await list.text();
		assertStringIncludes(listed, 'connect-src wss://gw.example.test;');
		assertStringIncludes(listed, 'abc123.host.example');
		// And they are never served as pages of this origin.
		const asset = await gateway.app.request(`${base}/assets/${EMBED_LIVE_FILE}`, {
			headers: { host: '127.0.0.1:8787' },
		});
		assertEquals(asset.status, 404);
		await asset.body?.cancel();
	} finally {
		await gateway.close();
		await registry.shutdown();
		await Deno.remove(root, { recursive: true });
	}
});
