/**
 * The registry's half of W1: the deployment allowlist reaching the vendored profile (C1, D-095), the
 * blocked-navigation records and log lines it produces, the Chromium sandbox switch (B3, D-094) and where it
 * is reported, and `accept_downloads` applied through the session's own watchdog (A3, E-77).
 *
 * The browser-tier legs (a real redirect and a real `window.open` contained, a real download denied) are in
 * `tests/e2e/browser_policy_e2e_test.ts`; this file pins the rules those legs depend on, with no Chromium.
 */
import { assert, assertEquals, assertFalse } from '@std/assert';
import {
	BrowserErrorEvent,
	type BrowserSession,
	compileDomainPolicy,
	type DownloadsWatchdog,
	isUrlAllowed,
	NavigationCompleteEvent,
	resolveBrowserProfile,
} from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { buildCapabilities } from './capabilities.ts';
import { isHostAllowed } from './errors.ts';
import {
	browserAllowedDomains,
	DEFAULT_SESSION_ID,
	resolverLayerRules,
	sessionProfile,
	SessionRegistry,
} from './registry.ts';
import { capabilitiesFor } from './server.ts';
import { browserSetSessionOptions } from './tools/session.ts';
import type { ToolContext } from './types.ts';

function fakeSession(): BrowserSession & { eventBus: EventBus } {
	return {
		tabs: [],
		cachedBrowserState: null,
		cdpClient: null,
		sessionManager: null,
		agentFocusTargetId: null,
		eventBus: new EventBus({ name: 'policy-fake' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession & { eventBus: EventBus };
}

// --- C1: the translation -------------------------------------------------------------------------------

/**
 * Hosts the two rules must agree on, for each list below. The interesting rows are the ones where the raw
 * entries would have disagreed: subdomains (the vendored exact match), a bare-suffix lookalike, a port in
 * the entry, an IP literal (no vendored wildcard ever matches one), case and the FQDN root dot — and, since
 * review R3-3 (E-92), IPv6 literals other than loopback and a host with an empty last label (`example.com..`),
 * which the tools used to allow and the browser vetoed.
 */
const HOSTS = [
	'example.com',
	'www.example.com',
	'a.b.example.com',
	'evil-example.com',
	'example.com.evil.test',
	'EXAMPLE.com',
	'WWW.EXAMPLE.COM.',
	'example.com.',
	'example.com..',
	'a.example.com..',
	'127.0.0.1',
	'127.0.0.2',
	'localhost',
	'app.localhost',
	'[::1]',
	'[fe80::1]',
	'[2001:db8::1]',
	'docs.example',
	'other.test',
	// QR-1: the rows a wildcard or an underscore entry would reach if a layer let it through.
	'evil.org',
	'a.b.org',
	'my_host.example',
	'sub.my_host.example',
];

const LISTS: ReadonlyArray<readonly string[]> = [
	['example.com'],
	['example.com:8443'],
	['Example.COM.'],
	['EXAMPLE.COM'],
	['example.com..'],
	['127.0.0.1'],
	['localhost', '[::1]'],
	['docs.example', '127.0.0.1'],
	['www.example.com'],
	// R3-3: an unbracketed IPv6 entry is not a host to the tools' rule, so it matches nothing — and must match
	// nothing in the browser either (the matcher used to bracket and accept it).
	['example.com', '::1'],
	['::1'],
	['fe80::1'],
	['2001:db8::1'],
	['[::1]'],
	['[fe80::1]'],
	['[2001:db8::1]:8443'],
	// QR-1 (SB-1): entries no layer may widen — a lone wildcard, a public-suffix wildcard, and an underscore host the
	// resolver layer cannot carry (it is left out there, so it fails closed in that layer only).
	['*'],
	['*.org'],
	['example.com', '*.org'],
	['my_host.example'],
];

Deno.test('C1: the vendored policy built from TTK_ALLOWED_DOMAINS agrees with the tools’ rule on every host', () => {
	for (const list of LISTS) {
		const policy = compileDomainPolicy({ allowedDomains: browserAllowedDomains(list) }, { onWarn: null });
		for (const host of HOSTS) {
			for (const origin of [`http://${host}/`, `https://${host}:8443/path?q=1`]) {
				const tools = isHostAllowed(new URL(origin).hostname, list);
				assertEquals(
					isUrlAllowed(origin, policy),
					tools,
					`${JSON.stringify(list)} → ${origin}: the browser and the tools disagree`,
				);
			}
		}
	}
});

/**
 * QR-1: a pure model of the resolver layer (`--host-resolver-rules` under `TTK_ALLOWED_DOMAINS_SCOPE=all`). Chromium
 * reads the value as rules in which an `EXCLUDE` pattern takes a host out of every `MAP`, so with the layer's closing
 * `MAP * ~NOTFOUND` a host resolves exactly when some `EXCLUDE` pattern matches it. Patterns are Chromium
 * `MatchPattern` globs (`*` any run, `?` one character), compared lowercase — the same emulation as `registry.ts`
 * `operatorMapPatterns`, copied here because that helper is private. The host is the URL's hostname, lowercased, with
 * IPv6 brackets dropped (`EXCLUDE ::1`, measured C8), and the trailing FQDN dot kept: dropping it would only make
 * fewer hosts survive, never more.
 */
function survivesResolverLayer(rules: string, hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
	const tokens = rules.split(', ');
	assertEquals(tokens.at(-1), 'MAP * ~NOTFOUND', 'the layer always closes with the catch-all');
	for (const token of tokens.slice(0, -1)) {
		const match = /^EXCLUDE (\S+)$/.exec(token);
		assert(match !== null, `the layer writes only EXCLUDE rules before the catch-all: ${token}`);
		const source = match[1]!.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll(
			'?',
			'.',
		);
		if (new RegExp(`^${source}$`).test(host)) return true;
	}
	return false;
}

Deno.test('C1 (QR-1): no host the tools refuse survives the resolver layer built from the same list', () => {
	let survivors = 0;
	for (const list of LISTS) {
		const skipped: string[] = [];
		const rules = resolverLayerRules(list, [], (message) => void skipped.push(message));
		for (const host of HOSTS) {
			const hostname = new URL(`http://${host}/`).hostname;
			if (!survivesResolverLayer(rules, hostname)) continue;
			survivors++;
			assert(
				isHostAllowed(hostname, list),
				`${
					JSON.stringify(list)
				} → ${hostname}: resolves in the browser under \`all\` (${rules}) but the tools refuse it`,
			);
		}
		// SB-1: no list may write a rule whose pattern starts with a wildcard over every name or a whole suffix.
		assertFalse(/EXCLUDE \*(?:,|$| )/.test(rules), `${JSON.stringify(list)} wrote EXCLUDE *: ${rules}`);
		assertFalse(/EXCLUDE \*\.(?:org|\*)/.test(rules), `${JSON.stringify(list)} wrote a suffix EXCLUDE: ${rules}`);
	}
	// Non-vacuity: the allowed hosts of the readable lists do resolve, so the model is not refusing everything.
	assert(survivors >= 10, `only ${survivors} host/list pairs survived; the model is refusing everything`);
	// The QR-1 rows, explicitly: a wildcard entry is skipped with a warning, an underscore host too.
	for (const entry of ['*', '*.org', 'my_host.example']) {
		const skipped: string[] = [];
		assertEquals(resolverLayerRules([entry], [], (message) => void skipped.push(message)), 'MAP * ~NOTFOUND', entry);
		assertEquals(skipped.length, 1, entry);
	}
});

Deno.test('C1 (E-92): an entry the tools cannot read becomes a pattern the browser refuses, whatever it holds', () => {
	// Each of these is unreadable to `canonicalHost`; the unbracketed IPv6 ones are the measured widening (the
	// vendored matcher brackets a ≥2-colon authority and would have ACCEPTED them verbatim).
	const unreadable = ['::1', 'fe80::1', '2001:db8::1', '*.exa mple.com', 'a b', 'not a host'];
	for (const entry of unreadable) {
		const translated = browserAllowedDomains([entry]);
		assert(translated !== null && translated.length === 1, entry);
		const warnings: string[] = [];
		const policy = compileDomainPolicy({ allowedDomains: translated }, {
			onWarn: (w) => void warnings.push(w.pattern),
		});
		assertEquals(warnings, translated, `${entry}: the matcher must refuse the translation at compile time`);
		assert(warnings[0]?.includes(entry), 'the warning still names the operator’s entry');
		for (const url of ['http://[::1]:8787/', 'http://[fe80::1]/', 'http://[2001:db8::1]/', 'https://example.com/']) {
			assertFalse(isUrlAllowed(url, policy), `${entry} → ${url}`);
			assertFalse(isHostAllowed(new URL(url).hostname, [entry]), `${entry} → ${url} (tools)`);
		}
	}
	// A readable entry is untouched by the change: loopback IPv6 written the bracketed way still works in both.
	const bracketed = compileDomainPolicy({ allowedDomains: browserAllowedDomains(['[::1]']) }, { onWarn: null });
	assert(isUrlAllowed('http://[::1]:8787/', bracketed));
	assert(isHostAllowed('[::1]', ['[::1]']));
});

Deno.test('C1: an empty allowlist stays unrestricted in the browser, and an unusable one denies everything', () => {
	assertEquals(browserAllowedDomains([]), null, 'empty → the vendored default null, which is unrestricted');
	const open = compileDomainPolicy({ allowedDomains: browserAllowedDomains([]) }, { onWarn: null });
	assert(isUrlAllowed('https://anything.test/', open));

	// An entry neither rule can read matches nothing in either — and must not empty the list, which the
	// matcher would read as "no restriction" (SECURITY-AUTH.md §4.2's precedence trap).
	const junk = ['http://[bad'];
	const translated = browserAllowedDomains(junk);
	assert(translated !== null && translated.length === 1);
	const closed = compileDomainPolicy({ allowedDomains: translated }, { onWarn: null });
	assertFalse(isUrlAllowed('https://anything.test/', closed));
	assertFalse(isHostAllowed('anything.test', junk));
	// The browser can always park on a blank tab; that is the containment target.
	assert(isUrlAllowed('about:blank', closed));
});

// --- B3 + C1: the launch profile ------------------------------------------------------------------------

const BASE = {
	headless: true,
	downloadsDir: '/data/downloads/default-x',
	browserPath: null,
	browserArgs: [],
	userDataDir: null,
	storageState: null,
} as const;

Deno.test('B3: TTK_CHROMIUM_NO_SANDBOX reaches the launch args, and only it does', () => {
	const sandboxed = sessionProfile({ ...BASE, chromiumSandbox: true, allowedDomains: [] });
	assert(!('chromiumSandbox' in sandboxed), 'a sandboxed launch carries exactly the profile it did before D-094');
	assert(!('allowedDomains' in sandboxed), 'no allowlist → the vendored default, unrestricted');
	const options = { tempProfileDir: '/tmp/bua-tmp-test', os: 'linux' as const, env: {} };
	const on = resolveBrowserProfile(sandboxed, options).args;
	assertFalse(on.includes('--no-sandbox'));

	const unsandboxed = sessionProfile({ ...BASE, chromiumSandbox: false, allowedDomains: [] });
	assertEquals(unsandboxed.chromiumSandbox, false);
	const off = resolveBrowserProfile(unsandboxed, options).args;
	assert(off.includes('--no-sandbox'), off.join(' '));
	assert(off.includes('--disable-setuid-sandbox'), off.join(' '));
});

Deno.test('C1: a configured allowlist is in every session’s profile, translated', () => {
	const profile = sessionProfile({ ...BASE, chromiumSandbox: true, allowedDomains: ['example.com', '127.0.0.1'] });
	assertEquals(profile.allowedDomains, ['*.example.com', '127.0.0.1']);
	assertEquals(profile.downloadsPath, BASE.downloadsDir);
});

Deno.test('B3: the registry reports the sandbox it launches with, and warns once when it is off', async () => {
	const warnings: string[] = [];
	const logger = { warn: (message: string) => void warnings.push(message), info: () => {} };
	const sandboxed = new SessionRegistry({ reapIntervalMs: 0, logger });
	const unsandboxed = new SessionRegistry({ reapIntervalMs: 0, logger, chromiumSandbox: false });
	// An injected launcher never reaches the profile, so it is not warned about (an edge node, a test).
	const injected = new SessionRegistry({
		reapIntervalMs: 0,
		logger,
		chromiumSandbox: false,
		launch: () => Promise.resolve(fakeSession()),
	});
	try {
		assertEquals(sandboxed.chromiumSandboxed, true);
		assertEquals(unsandboxed.chromiumSandboxed, false);
		assertEquals(injected.chromiumSandboxed, false);
		assertEquals(warnings.length, 1, JSON.stringify(warnings));
		assert(warnings[0]?.includes('TTK_CHROMIUM_NO_SANDBOX'));
		assert(warnings[0]?.includes('WITHOUT its sandbox'));
	} finally {
		await sandboxed.shutdown();
		await unsandboxed.shutdown();
		await injected.shutdown();
	}
});

Deno.test('B3: capabilities.tykotech.browser.sandboxed is told to a caller that drives the browser, and no one else', () => {
	const base = { version: '0.2.0-test', availability: {} as never, tools: [] };
	const invoker = buildCapabilities({ ...base, scopes: new Set(['mcp:invoke'] as const), chromiumSandboxed: false });
	assertEquals(invoker.browser, { sandboxed: false });
	const sandboxed = buildCapabilities({ ...base, scopes: new Set(['mcp:invoke'] as const), chromiumSandboxed: true });
	assertEquals(sandboxed.browser, { sandboxed: true });
	const watcher = buildCapabilities({ ...base, scopes: new Set(['view:watch'] as const), chromiumSandboxed: false });
	assertEquals(watcher.browser, undefined, 'a watch-only credential is not handed the deployment posture');
	const unknown = buildCapabilities({ ...base, scopes: new Set(['mcp:invoke'] as const) });
	assertEquals(unknown.browser, undefined, 'no registry answered, so nothing is claimed');
});

Deno.test('B3: the initialize block reads the sandbox from the registry the launcher reads', async () => {
	const unsandboxed = new SessionRegistry({
		reapIntervalMs: 0,
		chromiumSandbox: false,
		launch: () => Promise.resolve(fakeSession()),
	});
	const sandboxed = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	try {
		// A credential-less mount holds DEFAULT_SCOPES, which carry `mcp:invoke`.
		assertEquals(capabilitiesFor({ registry: unsandboxed, version: 't' }, undefined).browser, { sandboxed: false });
		assertEquals(capabilitiesFor({ registry: sandboxed, version: 't' }, undefined).browser, { sandboxed: true });
	} finally {
		await unsandboxed.shutdown();
		await sandboxed.shutdown();
	}
});

// --- C1: what a contained navigation leaves behind -------------------------------------------------------

function blockedHarness() {
	let now = 10_000;
	const infos: string[] = [];
	const sessions: Array<BrowserSession & { eventBus: EventBus }> = [];
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		now: () => now,
		allowedDomains: ['example.com'],
		// Block lines only: the registry also says `session <id> started` at info.
		logger: {
			warn: () => {},
			info: (message) => void (message.includes('TTK_ALLOWED_DOMAINS') && infos.push(message)),
		},
		launch: () => {
			const session = fakeSession();
			sessions.push(session);
			return Promise.resolve(session);
		},
	});
	return { registry, infos, sessions, advance: (ms: number) => (now += ms) };
}

function blocked(point: 'E1' | 'E2' | 'E3', url: string, targetId: string, containment: string): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: 'NavigationBlocked',
		message: `Navigation to ${url} is not allowed by the configured domain policy`,
		details: { enforcementPoint: point, url, targetId, containment },
	});
}

Deno.test('C1: a contained redirect is one navigation record, blocked and redacted, and no plain record follows', async () => {
	const h = blockedHarness();
	try {
		const record = await h.registry.resolve(DEFAULT_SESSION_ID);
		const session = h.sessions[0];
		assert(session !== undefined);
		const landed = 'https://idp.evil.test/callback?code=Zq8-OAUTH-CODE-3vP';
		// The watchdog's E2 handler runs first and reports the block; the session's own completion follows.
		await session.eventBus.dispatch(blocked('E2', landed, 'T-top', 'about:blank'));
		await session.eventBus.dispatch(new NavigationCompleteEvent({ targetId: 'T-top' as never, url: landed }));

		const records = record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
		assertEquals(records.length, 1, `one record for one navigation: ${JSON.stringify(records)}`);
		const [navigation] = records;
		assertEquals(navigation?.kind, 'navigation');
		assertEquals(navigation?.payload.blocked, true);
		assertEquals(navigation?.payload.containment, 'about:blank');
		assertEquals(navigation?.payload.committed, true, 'the redirect reached the page before it was parked');
		assertEquals(navigation?.payload.origin, 'https://idp.evil.test');
		assertEquals(navigation?.payload.path, '/callback');
		assertEquals(navigation?.payload.has_query, true);
		assertEquals(navigation?.tab_id, 'T-top');
		assert(!JSON.stringify(records).includes('Zq8-OAUTH-CODE'), 'a token reached the ring');

		// The log line names the origin and nothing after it.
		assertEquals(h.infos.length, 1);
		assert(h.infos[0]?.includes('https://idp.evil.test'), h.infos[0]);
		assert(!h.infos[0]?.includes('/callback'), h.infos[0]);
		assert(!h.infos[0]?.includes('Zq8-OAUTH-CODE'), h.infos[0]);

		// A later, allowed navigation of the same tab is an ordinary record again.
		await session.eventBus.dispatch(
			new NavigationCompleteEvent({ targetId: 'T-top' as never, url: 'https://example.com/home' }),
		);
		const after = record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
		assertEquals(after.length, 2);
		assertEquals(after[1]?.payload.blocked, undefined);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('C1: a closed pop-up is recorded as blocked and not committed; a veto (E1) records nothing', async () => {
	const h = blockedHarness();
	try {
		const record = await h.registry.resolve(DEFAULT_SESSION_ID);
		const session = h.sessions[0];
		assert(session !== undefined);
		await session.eventBus.dispatch(blocked('E3', 'http://popup.evil.test/landing', 'T-popup', 'tab-closed'));
		await session.eventBus.dispatch(blocked('E1', 'http://veto.evil.test/', '', 'none'));
		const records = record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
		assertEquals(records.length, 1);
		assertEquals(records[0]?.payload.blocked, true);
		assertEquals(records[0]?.payload.containment, 'tab-closed');
		assertEquals(records[0]?.payload.committed, false);
		assertEquals(records[0]?.payload.frame_id, 'T-popup');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('C1: a page spinning blocked pop-ups gets one log line per second, with the count carried forward', async () => {
	const h = blockedHarness();
	try {
		await h.registry.resolve(DEFAULT_SESSION_ID);
		const session = h.sessions[0];
		assert(session !== undefined);
		for (let i = 0; i < 5; i++) {
			await session.eventBus.dispatch(blocked('E3', 'http://spin.evil.test/', `T-${i}`, 'tab-closed'));
		}
		assertEquals(h.infos.length, 1, 'the first block is reported, the rest are counted');
		h.advance(1_000);
		await session.eventBus.dispatch(blocked('E3', 'http://spin.evil.test/', 'T-5', 'tab-closed'));
		assertEquals(h.infos.length, 2);
		assert(h.infos[1]?.includes('(5 blocks since the last report)'), h.infos[1]);
	} finally {
		await h.registry.shutdown();
	}
});

// --- A3: accept_downloads through the watchdog -----------------------------------------------------------

Deno.test('A3: accept_downloads is applied through the session’s own downloads watchdog, and refused honestly', async () => {
	const switched: boolean[] = [];
	let answer = true;
	const ledger = {
		downloads: [],
		isRemoteBrowser: false,
		lookup: () => undefined,
		setAcceptDownloads: (accept: boolean) => {
			switched.push(accept);
			return Promise.resolve(answer);
		},
	} as unknown as DownloadsWatchdog;
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session: fakeSession(), downloads: ledger, downloadsDir: null }),
	});
	try {
		const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
		const on = (await browserSetSessionOptions({ accept_downloads: false }, ctx)).structuredContent as {
			applied: Record<string, unknown>;
			unsupported: string[];
		};
		assertEquals(on.applied.accept_downloads, false);
		assertEquals(on.unsupported, []);
		assertEquals(switched, [false]);

		// The browser refused: named in `unsupported`, never claimed in `applied`.
		answer = false;
		const refused = (await browserSetSessionOptions({ accept_downloads: true }, ctx)).structuredContent as {
			applied: Record<string, unknown>;
			unsupported: string[];
		};
		assertEquals(refused.applied.accept_downloads, undefined);
		assertEquals(refused.unsupported, ['accept_downloads']);
		assertEquals(switched, [false, true]);
	} finally {
		await registry.shutdown();
	}
});
