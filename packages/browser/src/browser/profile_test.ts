/**
 * Tier-1 profile suite: launch-arg composition/dedup, display resolution, directory resolution
 * (DATA-MODEL.md §5.2, ARCHITECTURE.md §6.1, ROADMAP.md R8). Pure — no filesystem, no environment
 * read, no process spawn, so it runs under the §3.6 test matrix with nothing but `--allow-read=.`.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import type { LaunchOptions } from '@tykotech/cdp';
import { createBrowserProfile } from '../types.ts';
import {
	argKey,
	assertUserDataDirPresent,
	BrowserProfileError,
	type BrowserProfileLaunchInput,
	currentTargetOs,
	dedupeArgs,
	DEFAULT_DOWNLOADS_DIRNAME,
	DEFAULT_PROFILE_DIRECTORY,
	DEFAULT_SCREEN,
	hasDisplay,
	resolveBrowserProfile,
	targetOsFor,
	toLaunchPlan,
} from './profile.ts';

const PROFILE_DIR = '/tmp/bua-tmp-abc';

function resolve(
	profile: BrowserProfileLaunchInput = {},
	options: Parameters<typeof resolveBrowserProfile>[1] = {},
) {
	return resolveBrowserProfile({ userDataDir: PROFILE_DIR, ...profile }, { os: 'linux', ...options });
}

function valueOf(args: readonly string[], name: string): string | null {
	for (const arg of args) {
		if (argKey(arg) === name) return arg.slice(name.length + 1);
	}
	return null;
}

function has(args: readonly string[], name: string): boolean {
	return args.some((arg) => argKey(arg) === name);
}

// ---------------------------------------------------------------------------
// dedup precedence
// ---------------------------------------------------------------------------

Deno.test('dedupe: a later occurrence wins the value and keeps the first position', () => {
	assertEquals(
		dedupeArgs(['--a=1', '--b', '--a=2', '--c=3', '--b', '--a=3']),
		['--a=3', '--b', '--c=3'],
	);
	// Valueless and valued spellings of one switch are the same switch.
	assertEquals(dedupeArgs(['--headless', '--headless=new']), ['--headless=new']);
	assertEquals(dedupeArgs([]), []);
});

Deno.test('dedupe: argKey splits on the first "=" only', () => {
	assertEquals(argKey('--user-agent=Mozilla/5.0 (X=Y)'), '--user-agent');
	assertEquals(argKey('--no-sandbox'), '--no-sandbox');
});

Deno.test('args: an explicit profile arg beats the composed default, in the default position', () => {
	const resolved = resolve({ headless: true, args: ['--window-size=800,600'] });
	assertEquals(valueOf(resolved.args, '--window-size'), '800,600');
	assertEquals(resolved.args.filter((arg) => argKey(arg) === '--window-size').length, 1);
	// Position: still the third arg, where the default sat — overriding a value must not reorder.
	assertEquals(resolved.args.indexOf('--window-size=800,600'), 2);
	assertEquals(resolved.args[0], `--user-data-dir=${PROFILE_DIR}`);
});

// ---------------------------------------------------------------------------
// --user-data-dir (ARCHITECTURE.md §6.1)
// ---------------------------------------------------------------------------

Deno.test('user-data-dir: always present, even when all defaults are ignored', () => {
	for (const ignoreDefaultArgs of [undefined, true, ['--window-size', '--profile-directory']]) {
		const resolved = resolve({ headless: true, ignoreDefaultArgs });
		assertEquals(valueOf(resolved.args, '--user-data-dir'), PROFILE_DIR);
	}
	const dropped = resolve({ headless: true, ignoreDefaultArgs: true });
	assertEquals(dropped.args, [`--user-data-dir=${PROFILE_DIR}`]);
	const named = resolve({ headless: true, ignoreDefaultArgs: ['--window-position'] });
	assert(!has(named.args, '--window-position'));
	assert(has(named.args, '--window-size'));
});

Deno.test('user-data-dir: the assertion is a real check, not a comment', () => {
	assertUserDataDirPresent(['--foo', '--user-data-dir=/x']);
	const error = assertThrows(() => assertUserDataDirPresent(['--foo']), BrowserProfileError);
	assertStringIncludes(error.message, '--user-data-dir');
});

Deno.test('user-data-dir: a profile with neither a dir nor a temp dir is refused', () => {
	const error = assertThrows(
		() => resolveBrowserProfile({}, { os: 'linux' }),
		BrowserProfileError,
	);
	assertStringIncludes(error.message, 'no userDataDir');
	// The caller-minted temp dir is the sanctioned fallback.
	assertEquals(
		resolveBrowserProfile({}, { os: 'linux', tempProfileDir: '/tmp/bua-tmp-1' }).userDataDir,
		'/tmp/bua-tmp-1',
	);
});

Deno.test('args: profile args cannot smuggle in owned switches', () => {
	assertThrows(() => resolve({ args: ['-headless'] }), BrowserProfileError, "must start with '--'");
	assertThrows(() => resolve({ args: ['--user-data-dir=/elsewhere'] }), BrowserProfileError, 'owned by the profile');
	assertThrows(() => resolve({ args: ['--remote-debugging-port=9222'] }), BrowserProfileError, 'launchBrowser');
});

// ---------------------------------------------------------------------------
// headless / display detection (ROADMAP.md R8)
// ---------------------------------------------------------------------------

Deno.test.each([
	{ name: 'linux with no environment is headless', os: 'linux' as const, env: {}, headless: true },
	{ name: 'linux with X11 is headful', os: 'linux' as const, env: { DISPLAY: ':0' }, headless: false },
	{ name: 'linux with an empty DISPLAY is headless', os: 'linux' as const, env: { DISPLAY: '' }, headless: true },
	{
		name: 'linux with Wayland is headful',
		os: 'linux' as const,
		env: { WAYLAND_DISPLAY: 'wayland-0' },
		headless: false,
	},
	{ name: 'macOS is assumed headful', os: 'darwin' as const, env: {}, headless: false },
	{ name: 'windows is assumed headful', os: 'windows' as const, env: {}, headless: false },
])('headless: $name', (row) => {
	assertEquals(hasDisplay(row.os, row.env), !row.headless);
	assertEquals(resolve({}, { os: row.os, env: row.env }).headless, row.headless);
});

Deno.test('headless: an explicit setting overrides display detection in both directions', () => {
	assertEquals(resolve({ headless: false }, { os: 'linux', env: {} }).headless, false);
	assertEquals(resolve({ headless: true }, { os: 'darwin' }).headless, true);
});

Deno.test('headless: the OS defaults to the running platform', () => {
	assertEquals(targetOsFor('windows'), 'windows');
	assertEquals(targetOsFor('darwin'), 'darwin');
	assertEquals(targetOsFor('linux'), 'linux');
	assertEquals(targetOsFor('freebsd'), 'linux');
	assertEquals(currentTargetOs(), targetOsFor(Deno.build.os));
	assertEquals(resolveBrowserProfile({ userDataDir: PROFILE_DIR, headless: true }).headless, true);
});

// ---------------------------------------------------------------------------
// viewport / screen invariants (DATA-MODEL.md §5.2)
// ---------------------------------------------------------------------------

Deno.test('display: headless defaults to 1920x1080 in viewport mode (R8)', () => {
	const resolved = resolve({ headless: true });
	assertEquals(DEFAULT_SCREEN, { width: 1920, height: 1080 });
	assertEquals(resolved.screen, DEFAULT_SCREEN);
	assertEquals(resolved.viewport, DEFAULT_SCREEN);
	assertEquals(resolved.noViewport, false);
	assertEquals(resolved.deviceScaleFactor, 1);
	assertEquals(valueOf(resolved.args, '--window-size'), '1920,1080');
	assertEquals(valueOf(resolved.args, '--window-position'), '0,0');
	assertEquals(valueOf(resolved.args, '--force-device-scale-factor'), '1');
});

Deno.test('display: headful defaults to the real window (noViewport ⇒ viewport === null)', () => {
	const resolved = resolve({ headless: false });
	assertEquals(resolved.noViewport, true);
	assertEquals(resolved.viewport, null);
	assertEquals(resolved.deviceScaleFactor, null);
	assertEquals(resolved.windowSize, null);
	assert(!has(resolved.args, '--window-size'));
	assert(!has(resolved.args, '--force-device-scale-factor'));
});

Deno.test('display: headless ∧ noViewport is impossible — it is coerced and reported', () => {
	const warnings: string[] = [];
	const resolved = resolve({ headless: true, noViewport: true }, { onWarn: (message) => warnings.push(message) });
	assertEquals(resolved.noViewport, false);
	assertEquals(resolved.viewport, DEFAULT_SCREEN);
	assertEquals(warnings.length, 1);
	assertStringIncludes(warnings[0] ?? '', 'noViewport: true was overridden');
	assertEquals(resolved.warnings, warnings);
});

Deno.test('display: deviceScaleFactor forces viewport mode and must be >= 1', () => {
	const resolved = resolve({ headless: false, deviceScaleFactor: 2 });
	assertEquals(resolved.noViewport, false);
	assertEquals(resolved.deviceScaleFactor, 2);
	assertEquals(resolved.viewport, DEFAULT_SCREEN);
	assertEquals(valueOf(resolved.args, '--force-device-scale-factor'), '2');
	assertThrows(() => resolve({ deviceScaleFactor: 0.5 }), BrowserProfileError, 'deviceScaleFactor must be >= 1');
});

Deno.test('display: an explicit viewport forces viewport mode on a headful profile', () => {
	const resolved = resolve({ headless: false, viewport: { width: 800, height: 600 } });
	assertEquals(resolved.noViewport, false);
	assertEquals(resolved.viewport, { width: 800, height: 600 });
	assertEquals(resolved.deviceScaleFactor, 1);
	// The screen stays the R8 default: a viewport is emulation, not a display measurement.
	assertEquals(resolved.screen, DEFAULT_SCREEN);
});

Deno.test('display: windowSize seeds the screen, and an explicit screen wins over it', () => {
	assertEquals(resolve({ headless: true, windowSize: { width: 1280, height: 720 } }).screen, {
		width: 1280,
		height: 720,
	});
	const both = resolve({
		headless: true,
		windowSize: { width: 1280, height: 720 },
		screen: { width: 2560, height: 1440 },
	});
	assertEquals(both.screen, { width: 2560, height: 1440 });
	assertEquals(valueOf(both.args, '--window-size'), '1280,720');
});

Deno.test('display: an explicit window position is emitted verbatim', () => {
	const resolved = resolve({ headless: false, windowPosition: { x: 40, y: 60 } });
	assertEquals(valueOf(resolved.args, '--window-position'), '40,60');
});

// ---------------------------------------------------------------------------
// directories
// ---------------------------------------------------------------------------

Deno.test.each([
	{ name: 'explicit downloadsPath wins', profile: { downloadsPath: '/dl' }, options: {}, expected: '/dl' },
	{
		name: 'caller default is next',
		profile: {},
		options: { defaultDownloadsDir: '/var/tmp/dl' },
		expected: '/var/tmp/dl',
	},
	{
		name: 'otherwise it lands under the profile dir',
		profile: {},
		options: {},
		expected: `${PROFILE_DIR}/${DEFAULT_DOWNLOADS_DIRNAME}`,
	},
])('downloads: $name', (row) => {
	assertEquals(resolve(row.profile, row.options).downloadsPath, row.expected);
});

Deno.test('downloads: the fallback follows the profile dir separator style', () => {
	const windowsProfile = resolveBrowserProfile(
		{ userDataDir: 'C:\\Users\\t\\bua-tmp-1' },
		{ os: 'windows' },
	);
	assertEquals(windowsProfile.downloadsPath, `C:\\Users\\t\\bua-tmp-1\\${DEFAULT_DOWNLOADS_DIRNAME}`);
	const trailing = resolveBrowserProfile({ userDataDir: '/tmp/p/' }, { os: 'linux' });
	assertEquals(trailing.downloadsPath, `/tmp/p/${DEFAULT_DOWNLOADS_DIRNAME}`);
});

Deno.test('profile-directory: defaults to Default and is emitted as an arg', () => {
	assertEquals(resolve().profileDirectory, DEFAULT_PROFILE_DIRECTORY);
	assertEquals(valueOf(resolve().args, '--profile-directory'), 'Default');
	assertEquals(valueOf(resolve({ profileDirectory: 'Profile 2' }).args, '--profile-directory'), 'Profile 2');
});

// ---------------------------------------------------------------------------
// the rest of the §5.2 arg surface
// ---------------------------------------------------------------------------

Deno.test('args: sandbox, devtools, and user agent', () => {
	const sandboxOff = resolve({ chromiumSandbox: false });
	assert(has(sandboxOff.args, '--no-sandbox'));
	assert(has(sandboxOff.args, '--disable-setuid-sandbox'));
	assert(!has(resolve({ chromiumSandbox: true }).args, '--no-sandbox'));

	const devtools = resolve({ headless: false, devtools: true });
	assert(has(devtools.args, '--auto-open-devtools-for-tabs'));
	assertThrows(
		() => resolve({ headless: true, devtools: true }),
		BrowserProfileError,
		'incompatible with headless',
	);

	assertEquals(valueOf(resolve({ userAgent: 'bua/1.0' }).args, '--user-agent'), 'bua/1.0');
	assert(!has(resolve().args, '--user-agent'));
});

// test-policy-allow: a proxy server URL is command-line *data*; nothing in this file opens a socket.
const PROXY_SERVER = 'http://proxy.test:3128';

Deno.test('args: proxy server and bypass are emitted, credentials never are', () => {
	const resolved = resolve({
		proxy: { server: PROXY_SERVER, bypass: '<-loopback>', username: 'u', password: 'hunter2' },
	});
	assertEquals(valueOf(resolved.args, '--proxy-server'), PROXY_SERVER);
	assertEquals(valueOf(resolved.args, '--proxy-bypass-list'), '<-loopback>');
	for (const arg of resolved.args) {
		assert(!arg.includes('hunter2'), `credential leaked into ${arg}`);
		assert(!arg.includes('u:'), `credential leaked into ${arg}`);
	}
	assert(!has(resolve({ proxy: { server: PROXY_SERVER } }).args, '--proxy-bypass-list'));
});

Deno.test('args: the disable-security group and the cross-origin-iframe switch share one feature list', () => {
	const insecure = resolve({ disableSecurity: true });
	assert(has(insecure.args, '--disable-web-security'));
	assert(has(insecure.args, '--allow-running-insecure-content'));
	assert(has(insecure.args, '--ignore-certificate-errors'));
	assert(has(insecure.args, '--disable-site-isolation-trials'));
	assertEquals(valueOf(insecure.args, '--disable-features'), 'IsolateOrigins,site-per-process');

	const noOopif = resolve({ crossOriginIframes: false });
	assert(!has(noOopif.args, '--disable-web-security'));
	assertEquals(valueOf(noOopif.args, '--disable-features'), 'IsolateOrigins,site-per-process');

	// Both at once still emit exactly one --disable-features (Chrome honours only the last).
	const both = resolve({ disableSecurity: true, crossOriginIframes: false });
	assertEquals(both.args.filter((arg) => argKey(arg) === '--disable-features').length, 1);

	// The I-11 default (crossOriginIframes: true) touches nothing.
	assert(!has(resolve().args, '--disable-features'));
	assert(!has(resolve({ crossOriginIframes: true }).args, '--disable-site-isolation-trials'));
});

Deno.test('args: deterministicRendering pins rendering flags and says so', () => {
	const warnings: string[] = [];
	const resolved = resolve({ deterministicRendering: true }, { onWarn: (message) => warnings.push(message) });
	assert(has(resolved.args, '--deterministic-mode'));
	assertEquals(valueOf(resolved.args, '--force-color-profile'), 'srgb');
	assertEquals(warnings.length, 1);
	assertStringIncludes(warnings[0] ?? '', 'deterministicRendering');
});

Deno.test('args: extensions are loaded only when directories are supplied and not disabled', () => {
	const dirs = ['/ext/ublock', '/ext/cookies'];
	const loaded = resolve({}, { extensionDirs: dirs });
	assertEquals(valueOf(loaded.args, '--load-extension'), '/ext/ublock,/ext/cookies');
	assertEquals(valueOf(loaded.args, '--disable-extensions-except'), '/ext/ublock,/ext/cookies');
	assert(!has(resolve({ enableDefaultExtensions: false }, { extensionDirs: dirs }).args, '--load-extension'));
	// Provisioning has not landed: with no directories there is nothing to load, and that is not an error.
	assert(!has(resolve({ enableDefaultExtensions: true }).args, '--load-extension'));
});

// ---------------------------------------------------------------------------
// the launch seam
// ---------------------------------------------------------------------------

Deno.test('launch plan: is accepted by @tykotech/cdp LaunchOptions and carries the profile decisions', () => {
	const profile: BrowserProfileLaunchInput = {
		userDataDir: PROFILE_DIR,
		headless: true,
		executablePath: '/usr/bin/chromium',
		channel: 'chromium',
		env: { LANG: 'C' },
		ignoreDefaultArgs: ['--window-position'],
	};
	const resolved = resolveBrowserProfile(profile, { os: 'linux' });
	const plan: LaunchOptions = toLaunchPlan(profile, resolved);
	assertEquals(plan.userDataDir, PROFILE_DIR);
	assertEquals(plan.executablePath, '/usr/bin/chromium');
	assertEquals(plan.channel, 'chromium');
	assertEquals(plan.headless, true);
	assertEquals(plan.env, { LANG: 'C' });
	assertEquals(plan.ignoreDefaultArgs, ['--window-position']);
	assertEquals(plan.args, resolved.args);
	// `--headless=new` and `--remote-debugging-port` stay @tykotech/cdp's to append.
	assert(!has(resolved.args, '--headless'));
	assert(!has(resolved.args, '--remote-debugging-port'));
});

Deno.test('seam: a full BrowserProfile from types.ts resolves without adaptation', () => {
	// Compile-time half: the peer-owned §5.2 declaration must satisfy this module's input type.
	const profile: BrowserProfileLaunchInput = createBrowserProfile({
		userDataDir: PROFILE_DIR,
		headless: true,
		allowedDomains: ['example.com'],
	});
	const resolved = resolveBrowserProfile(profile, { os: 'linux' });
	assertEquals(resolved.headless, true);
	assertEquals(resolved.profileDirectory, DEFAULT_PROFILE_DIRECTORY);
	assertEquals(valueOf(resolved.args, '--user-data-dir'), PROFILE_DIR);
	// The default `ignoreDefaultArgs: []` (types.ts ERRATUM M1-events-types-3) drops nothing.
	assert(has(resolved.args, '--window-size'));
	// chromiumSandbox defaults to true, so no --no-sandbox unless the docker probe flips it.
	assert(!has(resolved.args, '--no-sandbox'));
});

Deno.test('launch plan: unset optional fields become undefined rather than null', () => {
	const profile: BrowserProfileLaunchInput = {
		userDataDir: PROFILE_DIR,
		executablePath: null,
		channel: null,
		env: null,
	};
	const plan = toLaunchPlan(profile, resolveBrowserProfile(profile, { os: 'linux' }));
	assertEquals(plan.executablePath, undefined);
	assertEquals(plan.channel, undefined);
	assertEquals(plan.env, undefined);
	assertEquals(plan.ignoreDefaultArgs, undefined);
});
