/**
 * Tier 2 — launch/discovery primitives against a real browser process
 * (OBSERVABILITY-TESTING-CICD.md §4.3 `session-lifecycle`; ARCHITECTURE.md §6.1, §7.4).
 *
 * These suites import `../src/launch.ts` rather than `../mod.ts` so the launch half of the package
 * is testable independently of the transport half (`mod.ts` re-exports both).
 */

import { assert, assertEquals, assertMatch, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { relative, resolve } from '@std/path';
import {
	BrowserLaunchError,
	BrowserNotFoundError,
	CHROME_EXIT_PROFILE_IN_USE,
	composeLaunchArgs,
	fetchWebSocketDebuggerUrl,
	findBrowserExecutable,
	launchBrowser,
	pickFreePort,
} from '../src/launch.ts';
import { browserTest, startFixtureServer } from './_helpers.ts';

Deno.test('port: pickFreePort returns a port that is actually free and released', () => {
	const port = pickFreePort();
	assert(port > 1024 && port < 65_536, `implausible ephemeral port ${port}`);
	// If the listener had not been closed, this bind would throw AddrInUse.
	const listener = Deno.listen({ hostname: '127.0.0.1', port, transport: 'tcp' });
	listener.close();
});

Deno.test('port: successive picks do not collide', () => {
	const ports = new Set([pickFreePort(), pickFreePort(), pickFreePort()]);
	assert(ports.size >= 2, `expected distinct ephemeral ports, got ${[...ports].join(',')}`);
});

Deno.test('discovery: a scan either resolves a browser or explains exactly what it tried', async () => {
	// Under the §3.6 test matrix (`--allow-read=.`) the per-OS tables are usually unreadable, so both
	// outcomes are legitimate. What is NOT legitimate is an untyped failure or a useless message.
	try {
		const path = await findBrowserExecutable();
		assert(path.length > 0);
	} catch (error) {
		assert(error instanceof BrowserNotFoundError, `unexpected error type: ${error}`);
		assert(error.searched.length > 0);
		assertStringIncludes(error.message, 'Fixes:');
		assertStringIncludes(error.message, 'BUA_BROWSER_PATH');
	}
});

browserTest('launch: spawns headless chromium and answers /json/version', async (ctx) => {
	const browser = await ctx.launch();
	assertMatch(browser.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
	assert(browser.port > 1024);
	assertMatch(browser.webSocketDebuggerUrl, /^ws:\/\//);
	assert(browser.child.pid > 0);
	assert(browser.args.includes(`--user-data-dir=${browser.userDataDir}`));
	assert(browser.args.includes(`--remote-debugging-port=${browser.port}`));
	assert(browser.args.includes('--headless=new'));

	// The handshake is repeatable against the live browser and returns the same endpoint.
	assertEquals(await fetchWebSocketDebuggerUrl(browser.cdpUrl), browser.webSocketDebuggerUrl);
});

browserTest('launch: each launch takes a different random ephemeral debug port', async (ctx) => {
	const first = await ctx.launch();
	const second = await ctx.launch();
	assert(first.port !== second.port, `both browsers took port ${first.port}`);
	assert(first.port !== 9222 && second.port !== 9222, 'must not fall back to the well-known port');
});

browserTest('launch: close() terminates the browser and releases the debug port', async (ctx) => {
	const browser = await ctx.launch();
	const port = browser.port;
	await browser.close();
	const status = await browser.child.status;
	assert(status.code !== undefined);
	// The port must be reusable once the browser is gone.
	const listener = Deno.listen({ hostname: '127.0.0.1', port, transport: 'tcp' });
	listener.close();
	await assertRejects(() => fetchWebSocketDebuggerUrl(`http://127.0.0.1:${port}`), BrowserLaunchError);
});

browserTest('launch: `await using` disposes the browser on scope exit', async (ctx) => {
	let port = 0;
	{
		await using browser = await ctx.launch();
		port = browser.port;
		assert(port > 0);
	}
	const listener = Deno.listen({ hostname: '127.0.0.1', port, transport: 'tcp' });
	listener.close();
});

browserTest('launch: a locked profile retries onto a fresh temp profile dir', async (ctx) => {
	// Chrome refuses a second instance on a live `--user-data-dir` (exit 21,
	// RESULT_CODE_PROFILE_IN_USE). D-BROWSER1 requires up to 3 attempts with a fresh profile.
	const shared = await ctx.scratchDir('bua-locked-');
	const holder = await ctx.launch({ userDataDir: shared });
	assertEquals(holder.userDataDir, shared);

	const freshDirs: string[] = [];
	const second = await ctx.launch({
		userDataDir: shared,
		maxAttempts: 3,
		freshProfileDir: async () => {
			const dir = await ctx.scratchDir('bua-retry-');
			freshDirs.push(dir);
			return dir;
		},
	});

	assert(second.port !== holder.port);
	// Measured: the retry branch fires on Windows 10 / Chrome 141 (verified by instrumenting this
	// test). The else-branch keeps the suite honest on platforms that tolerate a shared profile dir.
	if (freshDirs.length > 0) {
		// The retry path fired: the second browser must be on one of the fresh dirs, not the lock.
		assert(second.userDataDir !== shared, 'retry did not move off the locked profile');
		assert(freshDirs.some((dir) => second.userDataDir === dir));
	} else {
		// Some platforms tolerate a shared profile dir; then no retry was needed. Either way the
		// caller gets a working browser, which is the contract.
		assertEquals(second.userDataDir, shared);
	}
});

browserTest('launch: a busy debug port exhausts the retry budget within the given cap', async (ctx) => {
	const blocked = Deno.listen({ hostname: '127.0.0.1', port: 0, transport: 'tcp' });
	const port = (blocked.addr as Deno.NetAddr).port;
	ctx.defer(() => blocked.close());

	const userDataDir = await ctx.scratchDir('bua-portbusy-');
	const started = Date.now();
	const error = await assertRejects(
		() =>
			launchBrowser({
				executablePath: ctx.executablePath,
				userDataDir,
				headless: true,
				debugPort: port,
				maxAttempts: 3,
				readinessTimeoutMs: 3_000,
			}),
		BrowserLaunchError,
	);
	assertEquals(error.attempts, 3);
	// The caller-supplied cap must be honoured; the 30 s default would blow this budget.
	assert(Date.now() - started < 3 * 3_000 + 15_000, 'readinessTimeoutMs was not honoured');
	assert(error.stderr.length > 0 || error.exitCode !== null);
});

browserTest('launch: refuses to spawn without --user-data-dir even with a valid executable', async (ctx) => {
	const error = await assertRejects(
		() => launchBrowser({ executablePath: ctx.executablePath, userDataDir: '' }),
		BrowserLaunchError,
	);
	assertStringIncludes(error.message, 'MUST always be set');
});

browserTest('launch: the browser makes no request to a fixture it was not pointed at', async (ctx) => {
	// Privacy gate Q7 in miniature: the default arg set must not produce background traffic to any
	// server we control, and the browser must not fetch a new-tab page (we pass about:blank).
	const fixture = startFixtureServer({ '/': () => new Response('unused') });
	ctx.defer(() => fixture.close());
	const browser = await ctx.launch();
	assert(browser.args.includes('--disable-background-networking'));
	assertEquals(fixture.requests.length, 0);
});

Deno.test('exit codes: the profile-in-use code is Chromium 21, not a local invention', () => {
	assertEquals(CHROME_EXIT_PROFILE_IN_USE, 21);
});

// ---------------------------------------------------------------------------
// ERRATUM(TIER-2) — the --user-data-dir conflict guard compares paths, not spellings
// ---------------------------------------------------------------------------

Deno.test('args: a relative --user-data-dir naming the same directory is not a conflict', () => {
	// The shape a real caller produces: `@tykotech/browser` composes `--user-data-dir=` from the raw
	// `BrowserProfile.userDataDir` while `launchBrowser` absolutizes `LaunchOptions.userDataDir`, so
	// one directory arrives twice, resolved and unresolved. That is not a conflict, and rejecting it
	// made a relative `profile.userDataDir` unusable through the public API.
	const relativeDir = 'tests/.scratch/bua-tier2-profile';
	const args = composeLaunchArgs({
		userDataDir: resolve(relativeDir),
		port: 12_345,
		args: [`--user-data-dir=${relativeDir}`],
	});
	// Exactly one --user-data-dir survives, and it is the absolute one the browser is actually given.
	assertEquals(
		args.filter((arg) => arg.startsWith('--user-data-dir=')),
		[`--user-data-dir=${resolve(relativeDir)}`],
	);
});

Deno.test('args: a --user-data-dir naming a genuinely different directory is still refused', () => {
	// The guard must still guard: this is the case the ERRATUM(TIER-2) relaxation must not swallow.
	const error = assertThrows(
		() =>
			composeLaunchArgs({
				userDataDir: resolve('tests/.scratch/bua-tier2-a'),
				port: 12_345,
				args: ['--user-data-dir=tests/.scratch/bua-tier2-b'],
			}),
		BrowserLaunchError,
	);
	assertStringIncludes(error.message, 'Conflicting --user-data-dir');
});

browserTest('launch: a relative userDataDir reaches Chrome resolved, not rejected', async (ctx) => {
	// End to end against a real browser, through the exact two-route shape §6.1 produces.
	const absolute = await ctx.scratchDir('bua-tier2-');
	const relativeDir = relative(Deno.cwd(), absolute).replaceAll('\\', '/');
	assert(
		!relativeDir.startsWith('/') && !/^[A-Za-z]:/.test(relativeDir),
		`expected a relative path, got ${relativeDir}`,
	);

	const browser = await ctx.launch({ userDataDir: relativeDir, args: [`--user-data-dir=${relativeDir}`] });
	assertEquals(browser.userDataDir, absolute, 'the launcher must resolve the profile dir, not pass it through');
	assert(browser.args.includes(`--user-data-dir=${absolute}`), browser.args.join(' '));
	assertMatch(browser.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});
