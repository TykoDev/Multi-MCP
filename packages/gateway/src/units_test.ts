import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import {
	checkBindPolicy,
	ConfigError,
	DEFAULT_SCOPES,
	EXPLICIT_SCOPES,
	isLoopbackHost,
	loadConfig,
	SCOPES,
} from './config.ts';
import { ApiKeyStore, generateApiKey, keyPrefix, VerifierChain } from './auth.ts';
import { generateAdminUser } from './admin_auth.ts';
import { LEGACY_DEFAULT_SCOPES } from '@tykotech/mcp';
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
	PONG_GRACE_MS,
	PONG_TIMEOUT_MS,
	pongDeadlineMs,
} from './liveview.ts';
import { isSafeKeyLabel, MAX_KEY_LABEL_LENGTH } from './config.ts';
import { normalizeSecret, resolveSecrets, SecretError } from './secrets.ts';
import { ClientMsgSchema, decodeFrame, encodeFrame, ServerMsgSchema, WS_ERROR_CODES } from '@tykotech/wire';
import { createLogger } from './logger.ts';
import { framesOfTree, modifierBits, resolveKeySpec, tabsOf, viewTitle, viewUrl } from './liveview.ts';

// --- config -----------------------------------------------------------------

Deno.test('config: defaults are safe — loopback bind, same-origin only, headless', () => {
	const config = loadConfig({});
	assertEquals(config.host, '127.0.0.1');
	assertEquals(config.port, 8787);
	assertEquals(config.browser.headless, true);
	assertEquals(config.oauth, null);
	assertEquals(config.apiKeys, []);
});

Deno.test('config: the default origin list is this server, and only this server (E-23)', () => {
	// The SPA is served by this process from this origin, and a same-origin POST
	// still carries an Origin header — so denying every browser origin denied the
	// live view itself.
	const loopback = loadConfig({});
	assertEquals([...loopback.allowedOrigins].sort(), ['127.0.0.1', '[::1]', 'localhost'].sort());

	// A non-loopback bind allows only the name it is actually reachable under.
	const bound = loadConfig({ TTK_HOST: '10.0.0.5', TTK_API_KEYS: '[]', TTK_PUBLIC_URL: 'https://browser.example/' });
	assertEquals(bound.allowedOrigins, ['browser.example']);

	// Nothing else is permitted by default.
	for (const config of [loopback, bound]) {
		assert(!config.allowedOrigins.includes('evil.example'));
	}
});

Deno.test('config: an explicit origin list replaces the default outright', () => {
	const config = loadConfig({ TTK_ALLOWED_ORIGINS: 'app.example, console.example' });
	assertEquals(config.allowedOrigins, ['app.example', 'console.example']);
	// Replaced, not extended: a deployment that names its front end is not also
	// asking to trust whatever loopback page happens to be open.
	assert(!config.allowedOrigins.includes('localhost'));
});

Deno.test('config: invalid values name the offending variable', () => {
	assertThrows(() => loadConfig({ TTK_PORT: 'eighty' }), ConfigError, 'TTK_PORT');
	assertThrows(() => loadConfig({ TTK_MAX_SESSIONS: '0' }), ConfigError, 'TTK_MAX_SESSIONS');
	assertThrows(() => loadConfig({ TTK_HEADLESS: 'maybe' }), ConfigError, 'TTK_HEADLESS');
	assertThrows(() => loadConfig({ TTK_LOG_LEVEL: 'chatty' }), ConfigError, 'TTK_LOG_LEVEL');
	assertThrows(() => loadConfig({ TTK_PUBLIC_URL: 'not a url' }), ConfigError, 'TTK_PUBLIC_URL');
	assertThrows(() => loadConfig({ TTK_API_KEYS: '{not json' }), ConfigError, 'TTK_API_KEYS');
});

Deno.test('config: a key record must carry a well-formed hash, never a raw key', () => {
	assertThrows(
		() => loadConfig({ TTK_API_KEYS: JSON.stringify([{ id: 'a', sha256: 'ttk_rawkey' }]) }),
		ConfigError,
		'TTK_API_KEYS',
	);
});

Deno.test('config: duplicate key ids are refused', () => {
	const hash = 'a'.repeat(64);
	assertThrows(
		() =>
			loadConfig({
				TTK_API_KEYS: JSON.stringify([{ id: 'dup', sha256: hash }, { id: 'dup', sha256: hash }]),
			}),
		ConfigError,
		'duplicate key id',
	);
});

Deno.test('config: supplying keys both inline and by file is refused', () => {
	const hash = 'b'.repeat(64);
	assertThrows(
		() =>
			loadConfig(
				{ TTK_API_KEYS: JSON.stringify([{ id: 'a', sha256: hash }]) },
				{ secrets: { TTK_API_KEYS: JSON.stringify([{ id: 'b', sha256: hash }]) } },
			),
		ConfigError,
		'not both',
	);
});

Deno.test('config: OAuth mode leaves the JWKS URL to discovery unless one is named (D-083)', () => {
	const config = loadConfig({ TTK_OAUTH_ISSUER: 'https://idp.example.com/realms/x' });
	assert(config.oauth !== null);
	assertEquals(config.oauth.jwksUrl, null, 'discovered from the provider metadata at first use');
	const named = loadConfig({
		TTK_OAUTH_ISSUER: 'https://idp.example.com/realms/x',
		TTK_OAUTH_JWKS_URL: 'https://keys.example.com/jwks',
	});
	assertEquals(named.oauth?.jwksUrl?.href, 'https://keys.example.com/jwks');
	assertEquals(config.oauth.audience, config.publicUrl.href, 'the audience defaults to this server');
});

Deno.test('config: the bind policy refuses an uncredentialed public bind', () => {
	const warnings: string[] = [];
	const publicNoCreds = loadConfig({ TTK_HOST: '0.0.0.0' });
	assertThrows(() => checkBindPolicy(publicNoCreds, (m) => warnings.push(m)), ConfigError, 'TTK_HOST');

	// Loopback without credentials is a supported dev mode, but it must warn.
	const loopback = loadConfig({ TTK_HOST: '127.0.0.1' });
	checkBindPolicy(loopback, (m) => warnings.push(m));
	assert(warnings.some((m) => m.includes('loopback development mode')));

	// With credentials and a declared public name, a public bind is fine and silent.
	const before = warnings.length;
	const credentialed = loadConfig({
		TTK_HOST: '0.0.0.0',
		TTK_PUBLIC_URL: 'http://192.168.1.10:8787',
		TTK_API_KEYS: JSON.stringify([{ id: 'k', sha256: 'c'.repeat(64) }]),
	});
	checkBindPolicy(credentialed, (m) => warnings.push(m));
	assertEquals(warnings.length, before);
});

Deno.test('config: the Host allowlist follows the bind and the public URL (E-32)', () => {
	// The default bind answers to the three loopback spellings.
	assertEquals(
		[...loadConfig({}).allowedHosts].sort(),
		['127.0.0.1', '[::1]', 'localhost'].sort(),
	);

	// A wildcard bind still answers on loopback — but nothing has said what
	// address a remote client reaches it under, so nothing else is allowed.
	// This is the container image's own default, and it is why a client on
	// another machine connected and listed no tools.
	const undeclared = loadConfig({ TTK_HOST: '0.0.0.0', TTK_API_KEYS: '[]' });
	assertEquals([...undeclared.allowedHosts].sort(), ['127.0.0.1', '[::1]', 'localhost'].sort());
	assert(!undeclared.allowedHosts.includes('0.0.0.0'), 'a bind address is never a Host a client sends');

	// Declaring the public URL is what opens the LAN path, and it opens the
	// matching origin too, so the live view works at the same address.
	const declared = loadConfig({ TTK_HOST: '0.0.0.0', TTK_PUBLIC_URL: 'http://192.168.1.14:8787' });
	assert(declared.allowedHosts.includes('192.168.1.14'));
	assert(declared.allowedHosts.includes('127.0.0.1'), 'a wildcard bind still answers on loopback');
	assertEquals(declared.allowedOrigins, ['192.168.1.14']);

	// A bind to one specific address answers under that name, not loopback's.
	const specific = loadConfig({ TTK_HOST: '10.0.0.5', TTK_API_KEYS: '[]' });
	assertEquals(specific.allowedHosts, ['10.0.0.5']);
});

Deno.test('config: Host allowlist entries are reduced to bare hostnames (E-32)', () => {
	// The SDK's validateHostHeader parses the Host header and compares
	// `hostname`, so the match is port-agnostic and an entry carrying a port
	// matches nothing at all. The default this replaced shipped
	// `127.0.0.1:8787` and `localhost:8787`; neither had ever matched.
	const withPorts = loadConfig({ TTK_ALLOWED_HOSTS: '192.168.1.14:8787, http://box.lan:9000/, [::1]:8787' });
	assertEquals(withPorts.allowedHosts, ['192.168.1.14', 'box.lan', '[::1]']);
	for (const entry of withPorts.allowedHosts) {
		assert(!/:\d+$/.test(entry), `${entry} carries a port and could never match`);
	}
});

Deno.test('config: a bind beyond loopback warns when no reachable name is declared (E-32)', () => {
	const warningsFor = (env: Record<string, string>): string[] => {
		const collected: string[] = [];
		checkBindPolicy(
			loadConfig({ TTK_API_KEYS: JSON.stringify([{ id: 'k', sha256: 'd'.repeat(64) }]), ...env }),
			(m) => collected.push(m),
		);
		return collected;
	};

	// Nothing declared: the API is unreachable from anywhere but loopback.
	assert(
		warningsFor({ TTK_HOST: '0.0.0.0' }).some((m) => m.includes('Host allowlist is loopback-only')),
		'an undeclared public bind must say so at startup, not one 403 at a time',
	);

	// Half declared: the Host list reaches, the Origin list does not — the page
	// loads and every API call from it is refused.
	assert(
		warningsFor({ TTK_HOST: '0.0.0.0', TTK_ALLOWED_HOSTS: '192.168.1.14' })
			.some((m) => m.includes('Origin')),
		'a reachable Host list with an unreachable Origin list must warn',
	);

	// Fully declared: silent.
	assertEquals(warningsFor({ TTK_HOST: '0.0.0.0', TTK_PUBLIC_URL: 'http://192.168.1.14:8787' }), []);
	// Loopback binds are not the subject of either warning.
	assertEquals(warningsFor({ TTK_HOST: '127.0.0.1' }), []);
});

Deno.test('config: loopback detection covers the usual spellings', () => {
	for (const host of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST']) {
		assert(isLoopbackHost(host), `${host} should count as loopback`);
	}
	assert(!isLoopbackHost('0.0.0.0'));
	assert(!isLoopbackHost('10.0.0.5'));
});

// --- auth --------------------------------------------------------------------

Deno.test('auth: a generated key verifies, a near-miss does not', async () => {
	const { key, record } = await generateApiKey('k1', ['mcp:invoke']);
	assert(key.startsWith('ttk_'));
	const store = new ApiKeyStore([record]);

	const principal = await store.verify(key);
	assert(principal !== null);
	assertEquals(principal.id, 'k1');
	assertEquals([...principal.scopes], ['mcp:invoke']);

	assertEquals(await store.verify(`${key}x`), null);
	assertEquals(await store.verify('ttk_wrong'), null);
});

/**
 * SEC-01, deny path 1 of 4. Before B1.3 a record that named no scopes was
 * granted the whole vocabulary, so adding a scope to `SCOPES` granted it
 * retroactively to every scope-less key that had ever been issued.
 *
 * The assertion is the *whole* resulting set, not merely the absence of an
 * explicit scope: an absence-only test passes an implementation that grants
 * some other wrong superset.
 */
Deno.test('auth: a key with no scopes array is granted DEFAULT_SCOPES, never an explicit scope', async () => {
	const { key, record } = await generateApiKey('k2');
	assertEquals(record.scopes, undefined);
	const principal = await new ApiKeyStore([record]).verify(key);
	assertEquals([...(principal?.scopes ?? [])].sort(), [...DEFAULT_SCOPES].sort());
	for (const scope of EXPLICIT_SCOPES) {
		assert(principal?.scopes.has(scope) === false, `a scope-less key was granted ${scope}`);
	}
});

/** SEC-01, deny path 2 of 4: the anonymous loopback principal. */
Deno.test('auth: the anonymous loopback principal holds TTK_ANON_SCOPES, defaulting to DEFAULT_SCOPES', () => {
	const chain = (env: Record<string, string> = {}) =>
		new VerifierChain({ config: loadConfig(env), allowAnonymous: true });

	const fallback = chain().anonymousPrincipal('127.0.0.1');
	assertEquals([...(fallback?.scopes ?? [])].sort(), [...DEFAULT_SCOPES].sort());
	for (const scope of EXPLICIT_SCOPES) {
		assert(fallback?.scopes.has(scope) === false, `the anonymous principal was granted ${scope}`);
	}

	// An operator's deliberate opt-in has to *work*, not merely fail closed.
	const widened = chain({ TTK_ANON_SCOPES: 'mcp:invoke,evaluate' }).anonymousPrincipal('127.0.0.1');
	assertEquals([...(widened?.scopes ?? [])].sort(), ['evaluate', 'mcp:invoke']);

	// And an explicitly empty value means exactly that. Reading it as "unset"
	// would turn a request for a powerless principal into the maximum grant.
	const empty = chain({ TTK_ANON_SCOPES: '' }).anonymousPrincipal('127.0.0.1');
	assertEquals([...(empty?.scopes ?? [])], []);
});

/**
 * SEC-01, deny path 5: the administrator record (GW-2, D-065). `verifyAdmin` used to fall back to the whole
 * vocabulary and `doctor --new-admin` materialised it, so every administrator held `sandbox:execute`,
 * `agent:invoke`, `a2ui:publish`, `evaluate` and `task` without anyone naming them.
 */
Deno.test('auth: a scope-less admin seed keeps the legacy grant, never another explicit scope (GW-2, G15)', async () => {
	const { record, password } = await generateAdminUser('admin', 'correct horse battery staple');
	// C7 / D-098: the generator names `admin` explicitly, beside the default grant — never the vocabulary.
	assertEquals([...(record.scopes ?? [])].sort(), [...DEFAULT_SCOPES, 'admin'].sort(), 'the generator names admin');
	const { scopes: _omitted, ...bare } = record;
	const chain = (admin: unknown) =>
		new VerifierChain({ config: loadConfig({ TTK_ADMIN_USER: JSON.stringify(admin) }), allowAnonymous: false });

	// G15: a seed written before `admin` left the defaults meant the old default grant, and seeds the store with it
	// written out — so the administrator keeps `admin`, and gains nothing else nobody named.
	const fallback = await chain(bare).verifyAdmin('admin', password);
	assertEquals([...(fallback?.scopes ?? [])].sort(), [...LEGACY_DEFAULT_SCOPES].sort());
	for (const scope of EXPLICIT_SCOPES.filter((name) => name !== 'admin')) {
		assert(fallback?.scopes.has(scope) === false, `a scope-less admin record was granted ${scope}`);
	}

	// An explicit list is honoured whole: the owner restores full access by naming it.
	const named = await chain({ ...bare, scopes: [...SCOPES] }).verifyAdmin('admin', password);
	for (const scope of EXPLICIT_SCOPES) assert(named?.scopes.has(scope), `a named ${scope} was dropped`);
	const explicit = await generateAdminUser('admin', 'correct horse battery staple', ['agent:invoke']);
	assertEquals(explicit.record.scopes, ['agent:invoke']);
});

Deno.test('config: TTK_ANON_SCOPES refuses an unknown name and names the vocabulary', () => {
	const error = assertThrows(
		() => loadConfig({ TTK_ANON_SCOPES: 'mcp:invoke,nonsense' }),
		ConfigError,
	) as ConfigError;
	assertStringIncludes(error.message, 'TTK_ANON_SCOPES');
	assertStringIncludes(error.message, 'nonsense');
	// The whole vocabulary, so an operator can fix it from the message alone.
	for (const scope of SCOPES) assertStringIncludes(error.message, scope);
});

Deno.test('config: the loopback-dev warning prints the effective scopes, not "all scopes"', () => {
	const warnings: string[] = [];
	checkBindPolicy(loadConfig({}), (message) => warnings.push(message));
	const warning = warnings.join(' ');
	assertStringIncludes(warning, 'no credentials configured');
	// The old text said "every request is granted all scopes", which stopped
	// being true when SEC-01 split the vocabulary. A warning that misstates the
	// grant is worse than none, because an operator acts on it.
	assert(!warning.includes('all scopes'), warning);
	for (const scope of DEFAULT_SCOPES) assertStringIncludes(warning, scope);
	for (const scope of EXPLICIT_SCOPES) assert(!warning.includes(scope), `the warning claims ${scope} is granted`);
});

Deno.test('auth: the raw key is never stored', async () => {
	const { key, record } = await generateApiKey('k3');
	assert(!JSON.stringify(record).includes(key));
	assertEquals(record.sha256.length, 64);
});

Deno.test('auth: credentials are logged by prefix only', () => {
	const key = 'ttk_abcdefghijklmnop';
	const rendered = keyPrefix(key);
	assert(!rendered.includes('ijklmnop'), 'the tail must never reach a log');
	assertEquals(rendered, 'ttk_abcd…');
});

Deno.test('auth: an invalid token throws the SDK OAuthError so it renders as 401', async () => {
	const { record } = await generateApiKey('k4');
	const chain = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([record]) }),
		allowAnonymous: false,
	});
	// A plain Error here would surface to the client as a 500 rather than a 401;
	// the SDK maps only its own OAuthError with code `invalid_token`.
	const error = await assertRejects(() => chain.verifyAccessToken('ttk_nope'));
	assertEquals((error as Error).name, 'OAuthError');
	assertEquals((error as { code?: string }).code, 'invalid_token');
});

Deno.test('auth: AuthInfo always carries an expiry', async () => {
	const { key, record } = await generateApiKey('k5', ['mcp:invoke']);
	const chain = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([record]) }),
		allowAnonymous: false,
	});
	const info = await chain.verifyAccessToken(key);
	// The SDK rejects an AuthInfo without expiresAt, turning valid keys into 401s.
	assert(typeof info.expiresAt === 'number' && info.expiresAt > Date.now() / 1000);
});

Deno.test('auth: anonymous loopback is offered only when nothing is configured', async () => {
	const open = new VerifierChain({ config: loadConfig({}), allowAnonymous: true });
	assert(open.anonymousPrincipal('127.0.0.1') !== null);
	assertEquals(open.credentialed, false);

	const { record } = await generateApiKey('k6');
	const closed = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([record]) }),
		allowAnonymous: true,
	});
	assertEquals(closed.anonymousPrincipal('127.0.0.1'), null, 'a configured key disables anonymous access');
	assertEquals(closed.credentialed, true);
});

// --- rate limiting ------------------------------------------------------------

Deno.test('ratelimit: a burst is allowed, then refused with a retry hint', () => {
	let now = 0;
	const limiter = new RateLimiter({ rpm: 60, burst: 3, now: () => now });
	for (let i = 0; i < 3; i++) assert(limiter.charge('p1').allowed, `request ${i} should pass`);

	const refused = limiter.charge('p1');
	assertEquals(refused.allowed, false);
	assert(refused.retryAfter >= 1);

	// Buckets are per principal.
	assert(limiter.charge('p2').allowed);

	// And they refill over time.
	now += 60_000;
	assert(limiter.charge('p1').allowed);
});

Deno.test('ratelimit: `remaining` counts down with the bucket and is the limiter’s own accounting (B3.2)', () => {
	let now = 0;
	const limiter = new RateLimiter({ rpm: 60, burst: 3, now: () => now });

	// A fresh bucket holds `burst`; each charge spends one, so the header a
	// caller reads is exactly the number of further requests it may make.
	assertEquals(limiter.charge('p1').remaining, 2);
	assertEquals(limiter.charge('p1').remaining, 1);
	assertEquals(limiter.charge('p1').remaining, 0);

	// The claim `remaining: 0` makes must be true: the very next charge is refused.
	const refused = limiter.charge('p1');
	assertEquals(refused.allowed, false);
	assertEquals(refused.remaining, 0, 'a refusal must not advertise a request the caller cannot make');

	// Buckets are per principal, and so is the count.
	assertEquals(limiter.charge('p2').remaining, 2);

	// Floored, never fractional: at 60 rpm a second of refill is one token, so
	// half a second is 0.5 and a caller must not be told it has a request it
	// cannot make. After 1500 ms the bucket holds 1.5 and one charge leaves 0.5.
	now += 1_500;
	assertEquals(limiter.charge('p1').remaining, 0);
	now += 60_000;
	assertEquals(limiter.charge('p1').remaining, 2, 'refill is capped at the burst');
});

// --- tickets -------------------------------------------------------------------

Deno.test('tickets: a ticket is single-use', () => {
	const store = new TicketStore();
	const { ticket } = store.mint('principal', 'default', 'control');
	assertEquals(store.redeem(ticket, 'default').ok, true);
	const replay = store.redeem(ticket, 'default');
	assertEquals(replay.ok, false);
	assert(!replay.ok && replay.reason === 'consumed');
});

Deno.test('tickets: a ticket expires', () => {
	let now = 0;
	const store = new TicketStore({ ttlMs: 1_000, now: () => now });
	const { ticket } = store.mint('principal', 'default', 'watch');
	now = 1_001;
	const result = store.redeem(ticket, 'default');
	assert(!result.ok && result.reason === 'expired');
});

Deno.test('tickets: a ticket is bound to its session', () => {
	const store = new TicketStore();
	const { ticket } = store.mint('principal', 'session-a', 'control');
	const result = store.redeem(ticket, 'session-b');
	assert(!result.ok && result.reason === 'session-mismatch');
});

Deno.test('tickets: an unknown ticket is reported as unknown', () => {
	const store = new TicketStore();
	const result = store.redeem('lvt_never-existed', 'default');
	assert(!result.ok && result.reason === 'unknown');
});

// --- B2.3 ticket options (SEC-18) -------------------------------------------------

Deno.test('tickets (SEC-18): ttl is a request, clamped by the mode ceiling, and the control ceiling is below the view ceiling', () => {
	assertEquals(clampTicketTtl(undefined, 'watch'), TICKET_TTL_MS);
	assertEquals(clampTicketTtl(500_000, 'watch'), TICKET_TTL_MAX_VIEW_MS);
	assertEquals(clampTicketTtl(500_000, 'control'), TICKET_TTL_MAX_CONTROL_MS);
	assert(TICKET_TTL_MAX_CONTROL_MS < TICKET_TTL_MAX_VIEW_MS);
	assertEquals(clampTicketTtl(0, 'watch'), 1_000, 'a floor, so a ticket can survive a round trip');
	assertEquals(clampTicketTtl(Number.NaN, 'control'), TICKET_TTL_MS);
	// The granted value is what the record carries, so the route echoes it rather than the request.
	let now = 0;
	const store = new TicketStore({ now: () => now });
	const granted = store.mint('p', 'default', 'control', { ttlMs: 500_000 });
	assertEquals(granted.ttlMs, TICKET_TTL_MAX_CONTROL_MS);
	assertEquals(granted.expiresAt, TICKET_TTL_MAX_CONTROL_MS);
	now = TICKET_TTL_MAX_CONTROL_MS + 1;
	const late = store.redeem(granted.ticket, 'default');
	assert(!late.ok && late.reason === 'expired');
});

Deno.test('tickets (SEC-18): an origin-bound ticket is redeemable from that origin only, and a missing Origin is not a match', () => {
	const store = new TicketStore();
	const bound = store.mint('p', 'default', 'watch', { origin: 'https://adm.example' });
	assertEquals(bound.originBound, 'https://adm.example');
	const other = store.redeem(bound.ticket, 'default', 'https://evil.example');
	assert(!other.ok && other.reason === 'origin-mismatch');
	const again = store.mint('p', 'default', 'watch', { origin: 'https://adm.example' });
	const none = store.redeem(again.ticket, 'default', null);
	assert(!none.ok && none.reason === 'origin-mismatch', 'no Origin header is not the bound origin');
	const third = store.mint('p', 'default', 'watch', { origin: 'https://adm.example' });
	assert(store.redeem(third.ticket, 'default', 'https://adm.example').ok);
	// An unbound ticket is indifferent to the header, as every 0.1.0 ticket was.
	const free = store.mint('p', 'default', 'watch');
	assertEquals(free.originBound, null);
	assert(store.redeem(free.ticket, 'default', 'https://anywhere.example').ok);
});

Deno.test('tickets (B2.3): the holder name rides on the record, null when the credential has none', () => {
	const store = new TicketStore();
	assertEquals(store.mint('p', 'default', 'control', { holderName: 'ADM worker' }).holderName, 'ADM worker');
	assertEquals(store.mint('p', 'default', 'control').holderName, null);
});

// --- B2.3 holder_name at config parse (SEC-15) --------------------------------------

Deno.test('config (SEC-15): a key label is capped and printable, refused at parse naming the key id', () => {
	assert(isSafeKeyLabel('ADM worker (eu-west)'));
	assert(isSafeKeyLabel('x'.repeat(MAX_KEY_LABEL_LENGTH)));
	assert(!isSafeKeyLabel('x'.repeat(MAX_KEY_LABEL_LENGTH + 1)));
	assert(!isSafeKeyLabel('line\nbreak'));
	assert(!isSafeKeyLabel('<b>bold</b>'));
	assert(!isSafeKeyLabel('a & b'));
	assert(!isSafeKeyLabel('tab\tchar'));
	const record = { id: 'k-1', sha256: 'a'.repeat(64) };
	assertThrows(
		() => loadConfig({ TTK_API_KEYS: JSON.stringify([{ ...record, label: 'x'.repeat(65) }]) }),
		ConfigError,
		'key k-1',
	);
	assertThrows(
		() => loadConfig({ TTK_API_KEYS: JSON.stringify([{ ...record, label: '<script>' }]) }),
		ConfigError,
		'key k-1',
	);
	const fine = loadConfig({ TTK_API_KEYS: JSON.stringify([{ ...record, label: 'ADM worker' }]) });
	assertEquals(fine.apiKeys[0]?.label, 'ADM worker');
});

Deno.test('auth (B2.3): the verified principal carries the label, null when absent', async () => {
	const labelled = await generateApiKey('with-label', ['view:watch']);
	const plain = await generateApiKey('plain', ['view:watch']);
	const store = new ApiKeyStore([{ ...labelled.record, label: 'ADM worker' }, plain.record]);
	assertEquals((await store.verify(labelled.key))?.label, 'ADM worker');
	assertEquals((await store.verify(plain.key))?.label, null);
});

// --- B2.3 frame_scale and quality arithmetic (D-A6, AC-P0-38) --------------------------

Deno.test('liveview (AC-P0-38): frame_scale is min(1280/w, 720/h), never above 1, from the viewport not the JPEG', () => {
	assertEquals(Math.round(frameScaleFor(1920, 993) * 10_000) / 10_000, 0.6667);
	assertEquals(frameScaleFor(1280, 720), 1);
	assertEquals(frameScaleFor(800, 600), 1, 'no upscaling');
	assertEquals(frameScaleFor(2560, 720), 0.5);
	assertEquals(frameScaleFor(0, 0), 1, 'an unknown viewport is unscaled rather than infinite');
	assertEquals(frameScaleFor(1920, 993, CAST_MAX_WIDTH / 2, CAST_MAX_HEIGHT / 2), 640 / 1920);
});

Deno.test('liveview (B2.3): live.quality is clamped into its bounds and absent fields keep their values', () => {
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
});

// --- secrets --------------------------------------------------------------------

Deno.test('secrets: exactly one trailing newline is stripped', () => {
	assertEquals(normalizeSecret('value\n', 'V', '/p'), 'value');
	assertEquals(normalizeSecret('value', 'V', '/p'), 'value');
});

Deno.test('secrets: malformed files are refused, never silently repaired', () => {
	assertThrows(() => normalizeSecret(' value\n', 'V', '/p'), SecretError, 'whitespace');
	assertThrows(() => normalizeSecret('value \n', 'V', '/p'), SecretError, 'whitespace');
	assertThrows(() => normalizeSecret('\n', 'V', '/p'), SecretError);
	assertThrows(() => normalizeSecret('﻿value', 'V', '/p'), SecretError, 'byte-order mark');
});

Deno.test('secrets: multi-line JSON survives, trailing junk does not', () => {
	const json = '[\n  {"id": "a"}\n]';
	assertEquals(normalizeSecret(`${json}\n`, 'V', '/p'), json);
	assertThrows(() => normalizeSecret(`${json}\n\n\n`, 'V', '/p'), SecretError, 'trailing whitespace');
});

Deno.test('secrets: a file is read into the logical variable name', async () => {
	const resolved = await resolveSecrets({
		env: { TTK_API_KEYS_FILE: '/run/secrets/keys' },
		readFile: (path) => {
			// C6: the implicit admin-record file is looked for too; here, as on a fresh disk, it is absent.
			if (path === 'secrets/ttk_admin_user.json') return Promise.reject(new Deno.errors.NotFound(path));
			assertEquals(path, '/run/secrets/keys');
			return Promise.resolve('[{"id":"a","sha256":"' + 'd'.repeat(64) + '"}]\n');
		},
	});
	assert(resolved.TTK_API_KEYS?.startsWith('[{"id":"a"'));
});

Deno.test('secrets: an unreadable file names the variable and path', async () => {
	await assertRejects(
		() =>
			resolveSecrets({
				env: { TTK_API_KEYS_FILE: '/missing' },
				readFile: () => Promise.reject(new Error('no such file')),
			}),
		SecretError,
		'TTK_API_KEYS_FILE',
	);
});

// --- live-view wire -------------------------------------------------------------

Deno.test('messages: a frame round-trips through its envelope', () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const meta = { type: 'frame' as const, seq: 7, ts: 1234, w: 1280, h: 720, targetId: 'T1' };
	const { meta: decoded, jpeg: payload } = decodeFrame(encodeFrame(meta, jpeg).buffer as ArrayBuffer);
	assertEquals(decoded, meta);
	assertEquals([...payload], [...jpeg]);
});

Deno.test('messages: a truncated frame is rejected rather than misread', () => {
	assertThrows(() => decodeFrame(new Uint8Array([1, 2]).buffer as ArrayBuffer), Error, 'shorter');
});

Deno.test('messages: client messages are validated', () => {
	assert(ClientMsgSchema.safeParse({ type: 'control.take' }).success);
	assert(ClientMsgSchema.safeParse({ type: 'input.mouse', kind: 'click', x: 1, y: 2 }).success);
	assert(!ClientMsgSchema.safeParse({ type: 'input.mouse', kind: 'teleport', x: 1, y: 2 }).success);
	assert(!ClientMsgSchema.safeParse({ type: 'nonsense' }).success);
	assert(!ClientMsgSchema.safeParse({ type: 'input.key', kind: 'down' }).success, 'key is required');
});

// --- B2.1: the hover round trip on the wire ---------------------------------------

Deno.test('messages (B2.1): live.hover and its hover reply are members of both unions, with the id echoed', () => {
	assert(ClientMsgSchema.safeParse({ type: 'live.hover', id: 'h1', x: 10, y: 20 }).success);
	assert(!ClientMsgSchema.safeParse({ type: 'live.hover', x: 10, y: 20 }).success, 'the correlation id is required');
	assert(
		!ClientMsgSchema.safeParse({ type: 'live.hover', id: '', x: 10, y: 20 }).success,
		'an empty id correlates nothing',
	);
	assert(
		!ClientMsgSchema.safeParse({ type: 'live.hover', id: 'x'.repeat(65), x: 1, y: 1 }).success,
		'the id is capped',
	);

	const element = {
		index: 3,
		tag: 'button',
		label: 'Save',
		bounds: { x: 1, y: 2, w: 3, h: 4 },
		visible: true,
		frame_id: 'F',
	};
	assert(ServerMsgSchema.safeParse({ type: 'hover', id: 'h1', element, frame_id: 'F' }).success);
	assert(
		ServerMsgSchema.safeParse({ type: 'hover', id: 'h1', element: null, frame_id: null }).success,
		'null is a success',
	);
	assert(
		!ServerMsgSchema.safeParse({ type: 'hover', element, frame_id: 'F' }).success,
		'a reply without the id is not a reply',
	);
	// The reply carries the core preset: a value-bearing field has no place in it.
	const parsed = ServerMsgSchema.safeParse({
		type: 'hover',
		id: 'h1',
		element: { ...element, input: { value: 'x' } },
		frame_id: 'F',
	});
	assert(parsed.success);
	assert(!JSON.stringify(parsed.data).includes('"input"'), 'unknown keys are stripped by the schema');
});

Deno.test('messages (B2.2): live.highlight takes exactly one of index or bounds and a bounded ttl', () => {
	assert(ClientMsgSchema.safeParse({ type: 'live.highlight', index: 3 }).success);
	assert(
		ClientMsgSchema.safeParse({ type: 'live.highlight', bounds: { x: 1, y: 2, w: 3, h: 4 }, ttl_ms: 100 }).success,
	);
	assert(!ClientMsgSchema.safeParse({ type: 'live.highlight' }).success, 'neither target');
	assert(
		!ClientMsgSchema.safeParse({ type: 'live.highlight', index: 1, bounds: { x: 1, y: 2, w: 3, h: 4 } }).success,
		'both targets',
	);
	assert(!ClientMsgSchema.safeParse({ type: 'live.highlight', index: 1, ttl_ms: 50 }).success, 'below the floor');
	assert(!ClientMsgSchema.safeParse({ type: 'live.highlight', index: 1, ttl_ms: 60_000 }).success, 'above the ceiling');
	assert(!ClientMsgSchema.safeParse({ type: 'live.highlight', index: -1 }).success);
});

Deno.test('messages (B2.3): keyframe, quality and viewport are members of the unions; meta and frames carry the scale', () => {
	assert(ClientMsgSchema.safeParse({ type: 'live.keyframe' }).success);
	assert(ClientMsgSchema.safeParse({ type: 'live.quality', scale: 0.5, jpeg_quality: 30, max_fps: 10 }).success);
	assert(ClientMsgSchema.safeParse({ type: 'live.quality' }).success, 'every field optional');
	assert(!ClientMsgSchema.safeParse({ type: 'live.quality', scale: 2 }).success);
	assert(!ClientMsgSchema.safeParse({ type: 'live.quality', max_fps: 120 }).success);
	assert(ServerMsgSchema.safeParse({ type: 'quality', scale: 0.5, jpeg_quality: 30, max_fps: 10 }).success);
	assert(ServerMsgSchema.safeParse({ type: 'viewport', w: 1920, h: 993, frame_scale: 0.6667 }).success);
	assert(
		!ServerMsgSchema.safeParse({ type: 'viewport', w: 1920, h: 993 }).success,
		'frame_scale is required on viewport',
	);
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
	assert(ServerMsgSchema.safeParse(meta).success, 'frame_scale is optional on meta');
	assert(ServerMsgSchema.safeParse({ ...meta, frame_scale: 0.5 }).success);
	const encoded = encodeFrame(
		{ type: 'frame', seq: 1, ts: 2, w: 3, h: 4, targetId: 't', scale: 0.5 },
		new Uint8Array([1]),
	);
	assertEquals(decodeFrame(encoded.buffer as ArrayBuffer).meta.scale, 0.5);
	const legacy = encodeFrame({ type: 'frame', seq: 1, ts: 2, w: 3, h: 4, targetId: 't' }, new Uint8Array([1]));
	assertEquals(decodeFrame(legacy.buffer as ArrayBuffer).meta.scale, undefined, 'an older frame still decodes');
});

// --- the live-view URL redaction (SR1-A5) ---------------------------------------

Deno.test('liveview: the socket carries origin plus path, never the query or the fragment (SR1-A5)', () => {
	assertEquals(
		viewUrl('https://app.example:8443/inbox/42?token=SECRET#access_token=SECRET'),
		'https://app.example:8443/inbox/42',
	);
	assertEquals(viewUrl('http://127.0.0.1:5555/article'), 'http://127.0.0.1:5555/article');
	// A scheme with no origin reports its scheme rather than the literal `null`.
	assertEquals(viewUrl('about:blank'), 'about:blank');
	// An unparseable target reduces to nothing: the raw string is the one thing
	// that must not reach a `view:watch` holder.
	assertEquals(viewUrl('not a url at all'), '');
});

Deno.test('liveview: a title that IS the URL is redacted too (SR1-A5)', () => {
	// Chromium gives a page with no `<title>` a fallback title that is its URL,
	// query and fragment included — so redacting `url` alone left the whole thing
	// on the socket in the field beside it. The browser tier caught this after the
	// first two fields were already clean.
	const url = 'https://app.example/inbox?token=SECRET#access_token=SECRET';
	assertEquals(viewTitle('app.example/inbox?token=SECRET#access_token=SECRET', url), 'app.example/inbox');
	assertEquals(viewTitle(url, url), 'https://app.example/inbox');
	// A real title is untouched, including one that merely contains a question mark.
	assertEquals(viewTitle('Inbox', url), 'Inbox');
	assertEquals(viewTitle('Are you sure? — Inbox', url), 'Are you sure? — Inbox');
	// And a title naming some *other* URL is the page's own content, not this
	// server disclosing a navigation it performed.
	const other = 'other.example/page?q=1';
	assertEquals(viewTitle(other, url), other);
});

Deno.test('liveview: every URL the socket emits is redacted, the tab list included (SR1-A5)', () => {
	// `state` and `tabs` are both URL-bearing, so a rule that covered one and not
	// the other would leak the same secret through the list instead.
	const session = {
		agentFocusTargetId: 'T1',
		tabs: [
			{ tabId: 'AAAA', targetId: 'T1', url: 'https://mail.example/u/0?code=SECRET', title: 'Inbox' },
			{
				tabId: 'BBBB',
				targetId: 'T2',
				url: 'https://id.example/cb#access_token=SECRET',
				// The untitled-page case, as Chromium actually spells it.
				title: 'id.example/cb#access_token=SECRET',
			},
		],
	};
	// deno-lint-ignore no-explicit-any
	const tabs = tabsOf(session as any);
	assertEquals(tabs.map((tab) => tab.url), ['https://mail.example/u/0', 'https://id.example/cb']);
	assertEquals(tabs.map((tab) => tab.title), ['Inbox', 'id.example/cb']);
	assertEquals(tabs.map((tab) => tab.focused), [true, false]);
	assert(!JSON.stringify(tabs).includes('SECRET'), 'no part of a query or fragment may reach the socket');
});

Deno.test('liveview: the state frame list flattens the tree and is redacted like every other URL (B3.3)', () => {
	// SR1-A5 governs *every* URL the socket emits, and B3.3 adds a third kind.
	// A frame URL carries a magic-link token exactly as readily as a top-level
	// one — more readily, in the OAuth callback case, which is usually the frame.
	const tree = {
		frame: { id: 'F0', url: 'https://app.example/dash?session=SECRET', name: '' },
		childFrames: [
			{
				frame: { id: 'F1', url: 'https://id.example/cb#access_token=SECRET', name: 'auth' },
				childFrames: [
					{ frame: { id: 'F2', url: 'https://id.example/inner?t=SECRET' } },
				],
			},
			{ frame: { id: 'F3', url: 'https://ads.example/slot', name: 'ad' } },
		],
	};
	const frames = framesOfTree(tree);

	// Top document first, then depth-first — the order a reader expects an
	// address row in.
	assertEquals(frames.map((frame) => frame.frame_id), ['F0', 'F1', 'F2', 'F3']);
	// The parent link comes from the tree's shape, not from `Frame.parentId`,
	// which CDP omits on the root and does not always populate on children.
	assertEquals(frames.map((frame) => frame.parent_id), [null, 'F0', 'F1', 'F0']);
	assertEquals(frames.map((frame) => frame.url), [
		'https://app.example/dash',
		'https://id.example/cb',
		'https://id.example/inner',
		'https://ads.example/slot',
	]);
	// A frame with no `name` attribute reads as an empty string, never `undefined`:
	// a consumer must not have to tell "absent" from "unnamed".
	assertEquals(frames.map((frame) => frame.name), ['', 'auth', '', 'ad']);
	assert(!JSON.stringify(frames).includes('SECRET'), 'no part of a query or fragment may reach the socket');
});

// --- the live-view key path (B1.11) ---------------------------------------------

Deno.test('liveview: a printable key resolves to a real virtual key code, never 0 (B1.11)', () => {
	// The whole defect: this path forwarded `{key, code?}` and set no
	// `windowsVirtualKeyCode`, so every keystroke a human sent arrived with
	// `event.keyCode === 0` — which a page switching on `keyCode` does not
	// recognise at all.
	const a = resolveKeySpec('a');
	assert(a !== null);
	assertEquals(a.windowsVirtualKeyCode, 65);
	assertEquals(a.code, 'KeyA');
	assertEquals(a.text, 'a');
});

Deno.test('liveview: the named keys carry their native codes, Enter its carriage return', () => {
	const expected: Array<[string, number]> = [
		['Enter', 13],
		['Tab', 9],
		['Backspace', 8],
		['ArrowUp', 38],
		['ArrowDown', 40],
		['ArrowLeft', 37],
		['ArrowRight', 39],
	];
	for (const [name, code] of expected) {
		const spec = resolveKeySpec(name);
		assert(spec !== null, `${name} resolved to nothing`);
		assertEquals(spec.windowsVirtualKeyCode, code, name);
	}
	// Enter carries text, which is what turns a `keyDown` into the `keypress` a
	// form's submit handler listens for.
	assertEquals(resolveKeySpec('Enter')?.text, '\r');
});

Deno.test('liveview: a key this server cannot describe is answered, not dispatched with keyCode 0', () => {
	assertEquals(resolveKeySpec('NotARealKeyName'), null);
	// Unless the client says what it is, in which case its own value is used.
	assertEquals(resolveKeySpec('NotARealKeyName', 200)?.windowsVirtualKeyCode, 200);
	// And an override wins over the table for a key the table does know.
	assertEquals(resolveKeySpec('a', 200)?.windowsVirtualKeyCode, 200);
});

Deno.test('liveview: modifiers accept a bitmask or an array, and an empty array is legal', () => {
	assertEquals(modifierBits(undefined), 0);
	assertEquals(modifierBits(6), 6);
	assertEquals(modifierBits([]), 0, 'an empty array means no modifiers, not a malformed message');
	assertEquals(modifierBits(['ctrl']), 2);
	// Aliases fold through the one table rather than a second copy of it.
	assertEquals(modifierBits(['cmd']), modifierBits(['meta']));
	assertEquals(modifierBits(['ctrl', 'shift']), 2 | 8);
	assertEquals(modifierBits(['nonsense'] as unknown as string[]), 0);
});

Deno.test('messages: input.key accepts the three new optional fields and both modifier shapes', () => {
	const base = { type: 'input.key', kind: 'press', key: 'a' };
	assert(ClientMsgSchema.safeParse(base).success);
	assert(ClientMsgSchema.safeParse({ ...base, windowsVirtualKeyCode: 65, location: 0, autoRepeat: false }).success);
	assert(ClientMsgSchema.safeParse({ ...base, modifiers: 2 }).success);
	assert(ClientMsgSchema.safeParse({ ...base, modifiers: ['ctrl', 'shift'] }).success);
	assert(ClientMsgSchema.safeParse({ ...base, modifiers: [] }).success);
	assert(!ClientMsgSchema.safeParse({ ...base, modifiers: ['hyper'] }).success, 'the alias list is closed');
	assert(!ClientMsgSchema.safeParse({ ...base, windowsVirtualKeyCode: 999 }).success);
});

Deno.test('messages: pong is a member of the client union (B6.1, F1)', () => {
	// The keep-alive is an application-level JSON frame, not a WebSocket control
	// frame, so the peer's browser never answers it automatically. Without this
	// member the SPA's answer would be refused as `bad-message` instead of
	// refreshing the liveness the server reaps on.
	assert(ClientMsgSchema.safeParse({ type: 'pong' }).success);
	// It carries nothing: its arrival is the whole payload.
	assertEquals(ClientMsgSchema.parse({ type: 'pong' }), { type: 'pong' });
});

Deno.test('liveview: a socket that has never ponged gets the grace window, one that has does not (B6.1, F1)', () => {
	// The defect this encodes: `#lastPongAt` is refreshed only by an inbound
	// message, so before 0.2.0 a viewer that merely *watched* sent nothing for 45
	// seconds and was closed as unresponsive every time — the live view could not
	// be left watching, which is the one thing a live view is for.
	assertEquals(pongDeadlineMs(false), PONG_GRACE_MS);
	assertEquals(pongDeadlineMs(true), PONG_TIMEOUT_MS);
	// Asserted by value as well as by name: the grace window is the number the
	// owner chose, and the tight tier is still three ping intervals.
	assertEquals(PONG_GRACE_MS, 300_000);
	assertEquals(PONG_TIMEOUT_MS, 45_000);
	assert(
		PONG_GRACE_MS > PONG_TIMEOUT_MS,
		'a socket that has proven it answers must be reaped sooner, not later: it holds a capped slot',
	);
});

Deno.test('messages: ping is a member of the union, and input-rejected carries a closed reason (G-6, G-7)', () => {
	// G-6: the server has always sent this frame; it was simply absent from the
	// union, so a strict client rejected the stream.
	assert(ServerMsgSchema.safeParse({ type: 'ping' }).success);
	assert((WS_ERROR_CODES as readonly string[]).includes('input-rejected'));
	assert(
		ServerMsgSchema.safeParse({
			type: 'error',
			code: 'input-rejected',
			message: 'no focused tab',
			reason: 'no-focused-tab',
		}).success,
	);
	// The reason is optional, so nothing existing changes shape.
	assert(ServerMsgSchema.safeParse({ type: 'error', code: 'bad-message', message: 'x' }).success);
	// And closed, so a client can enumerate it.
	assert(!ServerMsgSchema.safeParse({ type: 'error', code: 'internal', message: 'x', reason: 'because' }).success);
});

// --- logging ---------------------------------------------------------------------

Deno.test('logger: levels filter and fields merge', () => {
	const lines: string[] = [];
	const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });
	logger.info('ignored');
	logger.warn('kept', { a: 1 });
	assertEquals(lines.length, 1);
	const entry = JSON.parse(lines[0]!);
	assertEquals(entry.level, 'warn');
	assertEquals(entry.msg, 'kept');
	assertEquals(entry.a, 1);

	const child = logger.with({ session: 's1' });
	child.error('boom');
	assertEquals(JSON.parse(lines[1]!).session, 's1');
});
