/**
 * The registry's half of the browser policy: the deployment allowlist reaching the vendored profile, the
 * blocked-navigation records and log lines it produces, the Chromium sandbox switch and where it is reported, and
 * `accept_downloads` applied through the session's own watchdog.
 */
import { blankSession } from '../fixtures/capture_session.ts';
import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import {
	BrowserErrorEvent,
	type BrowserSession,
	compileDomainPolicy,
	createBrowserProfile,
	DEFAULT_BROWSER_PERMISSIONS,
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
	SESSION_BROWSER_PERMISSIONS,
	sessionProfile,
	SessionRegistry,
} from './registry.ts';
import { capabilitiesFor } from './server.ts';
import { browserSetSessionOptions } from './tools/session.ts';
import type { ToolContext } from './types.ts';

// --- the translation -----------------------------------------------------------------------------------

/** Hosts the two rules must agree on, for each list below. */
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
	['example.com', '::1'],
	['::1'],
	['fe80::1'],
	['2001:db8::1'],
	['[::1]'],
	['[fe80::1]'],
	['[2001:db8::1]:8443'],
	['*'],
	['*.org'],
	['example.com', '*.org'],
	['my_host.example'],
];

Deno.test('the vendored policy built from TTK_ALLOWED_DOMAINS agrees with the tools’ rule on every host', () => {
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

/** A pure model of the resolver layer (`--host-resolver-rules` under `TTK_ALLOWED_DOMAINS_SCOPE=all`). */
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

Deno.test('no host the tools refuse survives the resolver layer built from the same list', () => {
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
		assertFalse(/EXCLUDE \*(?:,|$| )/.test(rules), `${JSON.stringify(list)} wrote EXCLUDE *: ${rules}`);
		assertFalse(/EXCLUDE \*\.(?:org|\*)/.test(rules), `${JSON.stringify(list)} wrote a suffix EXCLUDE: ${rules}`);
	}
	assert(survivors >= 10, `only ${survivors} host/list pairs survived; the model is refusing everything`);
	for (const entry of ['*', '*.org', 'my_host.example']) {
		const skipped: string[] = [];
		assertEquals(resolverLayerRules([entry], [], (message) => void skipped.push(message)), 'MAP * ~NOTFOUND', entry);
		assertEquals(skipped.length, 1, entry);
	}
});

Deno.test('an entry the tools cannot read becomes a pattern the browser refuses, whatever it holds', () => {
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
	const bracketed = compileDomainPolicy({ allowedDomains: browserAllowedDomains(['[::1]']) }, { onWarn: null });
	assert(isUrlAllowed('http://[::1]:8787/', bracketed));
	assert(isHostAllowed('[::1]', ['[::1]']));
});

Deno.test('an empty allowlist stays unrestricted in the browser, and an unusable one denies everything', () => {
	assertEquals(browserAllowedDomains([]), null, 'empty → the vendored default null, which is unrestricted');
	const open = compileDomainPolicy({ allowedDomains: browserAllowedDomains([]) }, { onWarn: null });
	assert(isUrlAllowed('https://anything.test/', open));

	const junk = ['http://[bad'];
	const translated = browserAllowedDomains(junk);
	assert(translated !== null && translated.length === 1);
	const closed = compileDomainPolicy({ allowedDomains: translated }, { onWarn: null });
	assertFalse(isUrlAllowed('https://anything.test/', closed));
	assertFalse(isHostAllowed('anything.test', junk));
	assert(isUrlAllowed('about:blank', closed));
});

// --- the launch profile ---------------------------------------------------------------------------------

const BASE = {
	headless: true,
	downloadsDir: '/data/downloads/default-x',
	browserPath: null,
	browserArgs: [],
	userDataDir: null,
	storageState: null,
} as const;

Deno.test('TTK_CHROMIUM_NO_SANDBOX reaches the launch args, and only it does', () => {
	const sandboxed = sessionProfile({ ...BASE, chromiumSandbox: true, allowedDomains: [] });
	assert(!('chromiumSandbox' in sandboxed), 'a sandboxed launch carries no chromiumSandbox key');
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

Deno.test('no session grants pages the clipboard; notifications only', () => {
	assert(DEFAULT_BROWSER_PERMISSIONS.includes('clipboardReadWrite'), 'the vendored default this test guards against');
	for (const allowedDomains of [[], ['example.com']]) {
		for (const chromiumSandbox of [true, false]) {
			const profile = createBrowserProfile(sessionProfile({ ...BASE, chromiumSandbox, allowedDomains }));
			assertEquals(profile.permissions, ['notifications']);
		}
	}
	assertEquals([...SESSION_BROWSER_PERMISSIONS], ['notifications']);
	const first = sessionProfile({ ...BASE, chromiumSandbox: true, allowedDomains: [] });
	(first.permissions as string[]).push('clipboardReadWrite');
	assertEquals(sessionProfile({ ...BASE, chromiumSandbox: true, allowedDomains: [] }).permissions, ['notifications']);
});

Deno.test('a configured allowlist is in every session’s profile, translated', () => {
	const profile = sessionProfile({ ...BASE, chromiumSandbox: true, allowedDomains: ['example.com', '127.0.0.1'] });
	assertEquals(profile.allowedDomains, ['*.example.com', '127.0.0.1']);
	assertEquals(profile.downloadsPath, BASE.downloadsDir);
});

Deno.test('the registry reports the sandbox it launches with, and warns once when it is off', async () => {
	const warnings: string[] = [];
	const logger = { warn: (message: string) => void warnings.push(message), info: () => {} };
	const sandboxed = new SessionRegistry({ reapIntervalMs: 0, logger });
	const unsandboxed = new SessionRegistry({ reapIntervalMs: 0, logger, chromiumSandbox: false });
	const injected = new SessionRegistry({
		reapIntervalMs: 0,
		logger,
		chromiumSandbox: false,
		launch: () => Promise.resolve(blankSession()),
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

Deno.test('capabilities.tykotech.browser.sandboxed is told to a caller that drives the browser, and no one else', () => {
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

Deno.test('the initialize block reads the sandbox from the registry the launcher reads', async () => {
	const unsandboxed = new SessionRegistry({
		reapIntervalMs: 0,
		chromiumSandbox: false,
		launch: () => Promise.resolve(blankSession()),
	});
	const sandboxed = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(blankSession()) });
	try {
		assertEquals(capabilitiesFor({ registry: unsandboxed, version: 't' }, undefined).browser, { sandboxed: false });
		assertEquals(capabilitiesFor({ registry: sandboxed, version: 't' }, undefined).browser, { sandboxed: true });
	} finally {
		await unsandboxed.shutdown();
		await sandboxed.shutdown();
	}
});

// --- what a contained navigation leaves behind -----------------------------------------------------------

function blockedHarness() {
	let now = 10_000;
	const infos: string[] = [];
	const sessions: Array<BrowserSession & { eventBus: EventBus }> = [];
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		now: () => now,
		allowedDomains: ['example.com'],
		logger: {
			warn: () => {},
			info: (message) => void (message.includes('TTK_ALLOWED_DOMAINS') && infos.push(message)),
		},
		launch: () => {
			const session = blankSession();
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

Deno.test('a contained redirect is one navigation record, blocked and redacted, and no plain record follows', async () => {
	const h = blockedHarness();
	try {
		const record = await h.registry.resolve(DEFAULT_SESSION_ID);
		const session = h.sessions[0];
		assert(session !== undefined);
		const landed = 'https://idp.evil.test/callback?code=Zq8-OAUTH-CODE-3vP';
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

		assertEquals(h.infos.length, 1);
		assertStringIncludes(h.infos[0] ?? '', 'https://idp.evil.test');
		assert(!h.infos[0]?.includes('/callback'), h.infos[0]);
		assert(!h.infos[0]?.includes('Zq8-OAUTH-CODE'), h.infos[0]);

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

Deno.test('a closed pop-up is recorded as blocked and not committed; a veto (E1) records nothing', async () => {
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

Deno.test('a page spinning blocked pop-ups gets one log line per second, with the count carried forward', async () => {
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

// --- accept_downloads through the watchdog ---------------------------------------------------------------

Deno.test('accept_downloads is applied through the session’s own downloads watchdog, and refused honestly', async () => {
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
		launch: () => Promise.resolve({ session: blankSession(), downloads: ledger, downloadsDir: null }),
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
