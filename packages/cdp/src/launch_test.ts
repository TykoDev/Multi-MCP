/**
 * Tier 1 unit tests for the launch/discovery primitives (OBSERVABILITY-TESTING-CICD.md §4.2).
 * No `--allow-run`, no `--allow-net`, no browser: everything here is either pure or fails before it
 * can touch a permission-gated API.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import {
	BrowserLaunchError,
	BrowserNotFoundError,
	candidatePathsFor,
	CDP_PACKAGE_VERSION,
	CHROME_EXIT_PROFILE_IN_USE,
	classifyDiscoveryFailure,
	classifyLaunchFailure,
	composeLaunchArgs,
	DEFAULT_CHANNEL_ORDER,
	DEFAULT_LAUNCH_ARGS,
	discoverBrowserExecutable,
	type DiscoveryProbe,
	GRACEFUL_KILL_MS,
	jsonVersionUrl,
	launchBrowser,
	MAX_LAUNCH_ATTEMPTS,
	parseHttpResponse,
	READINESS_POLL_INTERVAL_MS,
	READINESS_TIMEOUT_MS,
	selectHandshakeTransport,
	TEMP_PROFILE_PREFIX,
} from './launch.ts';

const WINDOWS_ROOTS = {
	programFiles: 'C:\\Program Files',
	programFilesX86: 'C:\\Program Files (x86)',
	localAppData: 'C:\\Users\\tester\\AppData\\Local',
	home: 'C:\\Users\\tester',
};

Deno.test('launch: speced timing constants are the ARCHITECTURE §6.1 values', () => {
	assertEquals(READINESS_POLL_INTERVAL_MS, 100);
	assertEquals(READINESS_TIMEOUT_MS, 30_000);
	assertEquals(MAX_LAUNCH_ATTEMPTS, 3);
	assertEquals(GRACEFUL_KILL_MS, 5_000);
	assertEquals(TEMP_PROFILE_PREFIX, 'bua-tmp-');
});

Deno.test('launch: package version constant matches packages/cdp/deno.json', async () => {
	const manifest = JSON.parse(await Deno.readTextFile(new URL('../deno.json', import.meta.url)));
	assertEquals(CDP_PACKAGE_VERSION, manifest.version);
});

// --- discovery tables -------------------------------------------------------

Deno.test('discovery: windows table covers the user-local %LOCALAPPDATA% Chrome install', () => {
	const paths = candidatePathsFor('windows', 'chrome', WINDOWS_ROOTS);
	assertEquals(paths, [
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
	]);
});

Deno.test('discovery: windows tables cover chromium, edge and brave under every root', () => {
	for (const channel of ['chromium', 'msedge', 'brave'] as const) {
		const paths = candidatePathsFor('windows', channel, WINDOWS_ROOTS);
		assertEquals(paths.length, 3);
		assert(paths.some((p) => p.startsWith('C:\\Users\\tester\\AppData\\Local\\')));
		assert(paths.every((p) => p.endsWith('.exe')));
	}
});

Deno.test('discovery: windows table degrades when %LOCALAPPDATA% is unreadable', () => {
	const paths = candidatePathsFor('windows', 'chrome', {
		programFiles: 'C:\\Program Files',
		programFilesX86: 'C:\\Program Files (x86)',
	});
	assertEquals(paths.length, 2);
});

Deno.test('discovery: macOS table covers /Applications and ~/Applications', () => {
	assertEquals(candidatePathsFor('darwin', 'chrome', { home: '/Users/tester' }), [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Users/tester/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	]);
	assertEquals(candidatePathsFor('darwin', 'brave', {}), [
		'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
	]);
});

Deno.test('discovery: linux table covers /usr/bin, /usr/local/bin, /opt, snap and flatpak', () => {
	const paths = candidatePathsFor('linux', 'chrome', { home: '/home/tester' });
	assert(paths.includes('/usr/bin/google-chrome'));
	assert(paths.includes('/usr/local/bin/google-chrome'));
	assert(paths.includes('/opt/google/chrome/chrome'));
	assert(paths.includes('/snap/bin/google-chrome'));
	assert(paths.includes('/var/lib/flatpak/exports/bin/com.google.Chrome'));
	assert(paths.includes('/home/tester/.local/share/flatpak/exports/bin/com.google.Chrome'));
});

Deno.test('discovery: linux ~ candidates are dropped when HOME is unreadable', () => {
	const paths = candidatePathsFor('linux', 'chromium', {});
	assert(paths.every((p) => p.startsWith('/')));
	assert(!paths.some((p) => p.includes('~')));
});

Deno.test('discovery: every channel resolves to at least one candidate on every OS', () => {
	for (const os of ['windows', 'darwin', 'linux'] as const) {
		for (const channel of DEFAULT_CHANNEL_ORDER) {
			const paths = candidatePathsFor(
				os,
				channel,
				WINDOWS_ROOTS.home === '' ? {} : {
					...WINDOWS_ROOTS,
					home: os === 'windows' ? WINDOWS_ROOTS.home : '/home/tester',
				},
			);
			assert(paths.length > 0, `${os}/${channel} has no candidates`);
		}
	}
});

Deno.test('discovery: default scan order is Chrome -> Chromium -> Edge -> Brave', () => {
	assertEquals(DEFAULT_CHANNEL_ORDER.slice(0, 4), ['chrome', 'chromium', 'msedge', 'brave']);
});

Deno.test('discovery: BrowserNotFoundError lists what was searched and how to fix it', async () => {
	const error = await assertRejects(
		() =>
			discoverBrowserExecutable({
				channel: 'chrome',
				os: 'linux',
				roots: { home: '/nonexistent-home-for-tests' },
			}),
		BrowserNotFoundError,
	);
	assertStringIncludes(error.message, '/usr/bin/google-chrome');
	assertStringIncludes(error.message, 'BUA_BROWSER_PATH');
	assertStringIncludes(error.message, 'cdpUrl');
	assert(error.searched.length > 0);
	assertEquals(error.channel, 'chrome');
});

/**
 * ERRATUM(SEAM-1). `searched` is prose for an operator; `probes` is the structured twin consumers
 * classify from. Two properties, both load-bearing:
 *
 * 1. **They cannot drift**, because `searched` is derived from `probes` at the throw. If a future
 *    edit improves `describeProbe`'s wording — and it will, it is user-facing — the structured
 *    verdict is unaffected. That is the entire point of the export.
 * 2. **The E-24 verdict is correct under a narrow grant.** This test runs with the repo matrix's
 *    `--allow-read=.` and `--allow-env=BUA_*,…`, so `/usr/bin/google-chrome` stats as `NotCapable`
 *    and `PATH` is unreadable. Every candidate is denied and the `PATH` sweep never runs: the honest
 *    answer is "I was not allowed to look", and `not-installed` here would be the E-24 collapse.
 */
// ERRATUM(E-119): `test:unit` grants unscoped read (D-157); these two tests pin read back to `.` themselves, so the
// candidates outside it are still denials. Every other permission is revoked for them, which is what they assume.
const READ_SCOPED: Deno.TestDefinition['permissions'] = { read: ['.'] };

Deno.test('discovery: the structured probe trail is what classifies, and it cannot drift from `searched`', {
	permissions: READ_SCOPED,
}, async () => {
	const error = await assertRejects(
		() =>
			discoverBrowserExecutable({
				channel: 'chrome',
				os: 'linux',
				roots: { home: '/nonexistent-home-for-tests' },
			}),
		BrowserNotFoundError,
	);

	assertEquals(error.probes.map((probe) => probe.detail), [...error.searched], 'derived, not written twice');
	assert(error.probes.length > 0);
	assert(
		error.probes.every((probe) => probe.result !== 'executable'),
		'a pass that threw cannot contain a successful probe',
	);

	// `PATH` is outside this suite's --allow-env, so the sweep was never run. `skipped`, not `missing`:
	// a step that did not run is not evidence of absence.
	const sweep = error.probes.filter((probe) => probe.path === null);
	assertEquals(sweep.length, 1, 'the PATH sweep contributes exactly one aggregate entry');
	assertEquals(sweep[0]?.result, 'skipped');
	assertEquals(sweep[0]?.source, 'path');

	// Every table candidate lives outside `--allow-read=.`, so all of them are denials.
	const failure = classifyDiscoveryFailure(error.probes);
	assertEquals(failure.kind, 'not-permitted');
	assertEquals(failure.denied.length, error.probes.length - 1);
	assertEquals(failure.missing.length, 0);
	assertEquals(failure.skipped.length, 1);
});

Deno.test('discovery: `classifyDiscoveryFailure` answers "not installed" only from observed absence', () => {
	const at = (path: string, result: DiscoveryProbe['result']): DiscoveryProbe => ({
		path,
		result,
		source: 'table',
		detail: path,
	});

	assertEquals(classifyDiscoveryFailure([at('/usr/bin/chromium', 'missing')]).kind, 'not-installed');
	assertEquals(
		classifyDiscoveryFailure([at('/usr/bin/chromium', 'missing'), at('/opt/chrome', 'permission-denied')]).kind,
		'not-permitted',
		'one denial vetoes an absence claim, however many candidates probed clean',
	);
	assertEquals(classifyDiscoveryFailure([]).kind, 'not-permitted', 'nothing probed is not the same as nothing there');
	assertEquals(
		classifyDiscoveryFailure([{ path: null, result: 'skipped', source: 'path', detail: 'skipped' }]).kind,
		'not-permitted',
		'a skipped step is not an observation',
	);
});

Deno.test('discovery: an explicit path that does not exist fails loudly, not silently', async () => {
	// Inside the repo root so `--allow-read=.` covers the stat: an unreadable path is *trusted*
	// instead (only `--allow-run` truly gates the spawn), which is a different branch.
	const missing = new URL('./__no_such_browser__', import.meta.url).pathname.replace(/^\//, '');
	const error = await assertRejects(
		() => discoverBrowserExecutable({ executablePath: missing, os: 'linux', roots: {} }),
		BrowserNotFoundError,
	);
	assertStringIncludes(error.message, 'explicit executablePath');
});

Deno.test('discovery: an explicit path outside --allow-read is trusted, not rejected', {
	permissions: READ_SCOPED,
}, async () => {
	const found = await discoverBrowserExecutable({
		executablePath: '/nonexistent-outside-read-scope/chrome',
		os: 'linux',
		roots: {},
	});
	assertEquals(found.source, 'explicit');
});

// --- launch args ------------------------------------------------------------

Deno.test('args: mandatory args are appended last and cannot be shadowed', () => {
	const args = composeLaunchArgs({ userDataDir: '/tmp/p', port: 9333, headless: true });
	assertEquals(args.at(-1), 'about:blank');
	assert(args.includes('--remote-debugging-port=9333'));
	assert(args.includes('--user-data-dir=/tmp/p'));
	assert(args.includes('--headless=new'));
	assert(args.indexOf('--remote-debugging-port=9333') > args.indexOf('--no-first-run'));
});

Deno.test('args: headless:false omits the headless flag', () => {
	const args = composeLaunchArgs({ userDataDir: '/tmp/p', port: 1, headless: false });
	assert(!args.some((a) => a.startsWith('--headless')));
});

Deno.test('args: caller args override same-named defaults exactly once', () => {
	const args = composeLaunchArgs({
		userDataDir: '/tmp/p',
		port: 1,
		args: ['--password-store=gnome', '--window-size=800,600'],
	});
	assertEquals(args.filter((a) => a.startsWith('--password-store')), ['--password-store=gnome']);
	assert(args.includes('--window-size=800,600'));
});

Deno.test('args: ignoreDefaultArgs drops all or the named defaults', () => {
	const none = composeLaunchArgs({ userDataDir: '/tmp/p', port: 1, ignoreDefaultArgs: true });
	for (const arg of DEFAULT_LAUNCH_ARGS) assert(!none.includes(arg));
	const some = composeLaunchArgs({
		userDataDir: '/tmp/p',
		port: 1,
		ignoreDefaultArgs: ['--use-mock-keychain'],
	});
	assert(!some.includes('--use-mock-keychain'));
	assert(some.includes('--no-first-run'));
});

Deno.test('args: initialUrl null leaves the positional URL off', () => {
	const args = composeLaunchArgs({ userDataDir: '/tmp/p', port: 1, initialUrl: null });
	assert(args.every((a) => a.startsWith('--')));
});

Deno.test('args: a caller-supplied debugging port is rejected as ambiguous', () => {
	assertThrows(
		() => composeLaunchArgs({ userDataDir: '/tmp/p', port: 1, args: ['--remote-debugging-port=9222'] }),
		BrowserLaunchError,
		'--remote-debugging-port is owned by launchBrowser',
	);
});

Deno.test('args: a conflicting --user-data-dir in args is rejected', () => {
	assertThrows(
		() => composeLaunchArgs({ userDataDir: '/tmp/p', port: 1, args: ['--user-data-dir=/tmp/other'] }),
		BrowserLaunchError,
		'Conflicting --user-data-dir',
	);
});

Deno.test('args: a matching --user-data-dir in args is accepted without duplication', () => {
	const args = composeLaunchArgs({ userDataDir: '/tmp/p', port: 1, args: ['--user-data-dir=/tmp/p'] });
	assertEquals(args.filter((a) => a.startsWith('--user-data-dir')), ['--user-data-dir=/tmp/p']);
});

Deno.test('args: args must start with -- (DATA-MODEL §5.2)', () => {
	assertThrows(
		() => composeLaunchArgs({ userDataDir: '/tmp/p', port: 1, args: ['no-dashes'] }),
		BrowserLaunchError,
		"must start with '--'",
	);
});

// --- the --user-data-dir assertion ------------------------------------------

Deno.test('launch: omitting userDataDir throws before anything is spawned', async () => {
	for (const bad of [undefined, '', '   ']) {
		const error = await assertRejects(
			() => launchBrowser({ userDataDir: bad as unknown as string, executablePath: '/bin/true' }),
			BrowserLaunchError,
		);
		assertStringIncludes(error.message, 'userDataDir');
		assertStringIncludes(error.message, 'MUST always be set');
	}
});

// --- handshake plumbing -----------------------------------------------------

Deno.test('handshake: loopback hosts bypass fetch so proxy env cannot intercept them', () => {
	for (const url of ['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222/json/version']) {
		assertEquals(selectHandshakeTransport(new URL(url)), 'direct-loopback', url);
	}
	assertEquals(selectHandshakeTransport(new URL('http://127.5.5.5:9222')), 'direct-loopback');
	// test-policy-allow: transport-selection input, parsed as data and never fetched
	assertEquals(selectHandshakeTransport(new URL('http://chrome.internal:9222')), 'fetch');
	assertEquals(selectHandshakeTransport(new URL('https://127.0.0.1:9222')), 'fetch');
});

Deno.test('handshake: bare CDP URLs get the /json/version path appended', () => {
	assertEquals(jsonVersionUrl('http://127.0.0.1:9222').href, 'http://127.0.0.1:9222/json/version');
	assertEquals(jsonVersionUrl('http://127.0.0.1:9222/').href, 'http://127.0.0.1:9222/json/version');
	assertEquals(
		jsonVersionUrl('http://127.0.0.1:9222/json/version').href,
		'http://127.0.0.1:9222/json/version',
	);
});

Deno.test('handshake: a ws:// URL is rejected with an actionable message', () => {
	assertThrows(
		() => jsonVersionUrl('ws://127.0.0.1:9222/devtools/browser/abc'),
		BrowserLaunchError,
		'already a debugger endpoint',
	);
	assertThrows(() => jsonVersionUrl('not a url'), BrowserLaunchError, 'Invalid CDP URL');
});

Deno.test('handshake: raw HTTP parsing handles content-length, chunked and partial reads', () => {
	const body = '{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/x"}';
	const withLength = `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
	assertEquals(parseHttpResponse(new TextEncoder().encode(withLength)), { status: 200, body });

	const chunkA = body.slice(0, 20);
	const chunkB = body.slice(20);
	const chunked = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n` +
		`${chunkA.length.toString(16)}\r\n${chunkA}\r\n${chunkB.length.toString(16)}\r\n${chunkB}\r\n0\r\n\r\n`;
	assertEquals(parseHttpResponse(new TextEncoder().encode(chunked)), { status: 200, body });

	assertEquals(parseHttpResponse(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Len')), null);
	assertEquals(parseHttpResponse(new TextEncoder().encode(withLength.slice(0, -5))), null);
	assertEquals(
		parseHttpResponse(new TextEncoder().encode('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')),
		{ status: 404, body: '' },
	);
});

// --- retry classification ---------------------------------------------------

Deno.test('retry: SingletonLock / ProcessSingleton stderr classifies as profile-lock', () => {
	assertEquals(
		classifyLaunchFailure('[ERROR:process_singleton_posix.cc(1084)] Failed to create a ProcessSingleton'),
		'profile-lock',
	);
	assertEquals(
		classifyLaunchFailure('The profile appears to be in use by another Chrome process'),
		'profile-lock',
	);
	assertEquals(classifyLaunchFailure('SingletonLock: file exists'), 'profile-lock');
});

Deno.test('retry: devtools bind failures classify as port-conflict', () => {
	assertEquals(classifyLaunchFailure('Cannot start http server for devtools.'), 'port-conflict');
	assertEquals(classifyLaunchFailure('bind() returned an error: Address already in use'), 'port-conflict');
});

Deno.test('retry: a self-inflicted exit of 21 or 0 is a profile lock even with empty stderr', () => {
	// Windows emits neither a log line nor a stable code: 21 while the holder is starting, 0 once it
	// is up and ProcessSingleton forwards the command line. Both mean "someone else owns the profile".
	assertEquals(CHROME_EXIT_PROFILE_IN_USE, 21);
	assertEquals(classifyLaunchFailure('', CHROME_EXIT_PROFILE_IN_USE), 'profile-lock');
	assertEquals(classifyLaunchFailure('', 0), 'profile-lock');
});

Deno.test('retry: a browser that stayed alive but never became ready is not retryable', () => {
	// exitCode null ⇒ we killed it ⇒ a hang, not a lock.
	assertEquals(classifyLaunchFailure('', null), 'other');
	assertEquals(classifyLaunchFailure(''), 'other');
	assertEquals(classifyLaunchFailure('[WARNING] GPU process launch failed', 1), 'other');
});

/**
 * Regression for E-24. `discoverBrowserExecutable` must classify a plain, non-execute-bit file as a
 * usable browser **on Windows**, where `Deno.stat().mode` is a synthesized `0o100666` that never
 * carries an execute bit. The original guard tested `mode !== null` on the stated belief that
 * Windows reports `null`; it does not, so every real `.exe` was rejected and table-driven discovery
 * could never succeed on Windows at all.
 *
 * This exercises the **table** branch against the **real filesystem**, which is precisely the path
 * the original unit tests missed: they asserted the discovery *table contained* the right path
 * (data), while every integration test supplied `BUA_TEST_CHROMIUM` or an explicit path and so took
 * the earlier branches. The one code path a real user hits was the only one never run.
 */
Deno.test('discovery: a real on-disk executable is found through the table, execute bit or not (E-24)', async () => {
	// Under `tests/.scratch` on purpose: the repo's test matrix grants `--allow-read=.` +
	// `--allow-write=tests/.scratch`, so a system temp dir would probe as `permission-denied` and the
	// test would pass or fail for the wrong reason.
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const root = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'bua-tmp-e24-' });
	try {
		const windows = Deno.build.os === 'windows';
		const relative = windows
			? ['Google', 'Chrome', 'Application', 'chrome.exe']
			: ['opt', 'google', 'chrome', 'chrome'];
		const sep = windows ? String.fromCharCode(92) : '/';
		const dir = [root, ...relative.slice(0, -1)].join(sep);
		await Deno.mkdir(dir, { recursive: true });
		const exe = [dir, relative.at(-1)].join(sep);
		await Deno.writeTextFile(exe, '');

		if (windows) {
			// The file has no execute bit — Windows never grants one — and must still be found.
			const found = await discoverBrowserExecutable({
				os: 'windows',
				channel: 'chrome',
				roots: { programFiles: root, programFilesX86: undefined, localAppData: undefined, home: root },
			});
			assertEquals(found.path, exe);
			assertEquals(found.source, 'table');
		} else {
			// POSIX keeps the execute-bit rule: without it the file is not a browser…
			await Deno.chmod(exe, 0o644);
			await assertRejects(
				() => discoverBrowserExecutable({ os: 'linux', channel: 'chrome', roots: { home: root } }),
				BrowserNotFoundError,
			);
			// …and with it, it is.
			await Deno.chmod(exe, 0o755);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
