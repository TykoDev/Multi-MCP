/**
 * `LocalBrowserWatchdog` contract tests (ARCHITECTURE.md §6.1; COMPLETIONS-CRITERIA.md §3.2
 * watchdog row 1): launch-arg composition, the `--user-data-dir` assertion, the `/json/version`
 * poll parameters (100 ms × 30 s), the 3× profile-lock retry budget, and the kill ladder — CDP
 * `Browser.close()` first, process kill as the fallback.
 *
 * The tier-1 permission matrix grants neither `--allow-run` nor a writable temp root, so the launch
 * *policy* is exercised through the watchdog's declared injection seams while the real spawn is
 * covered by `packages/core/tests/integration/session_lifecycle_test.ts`. The event bus, the profile
 * resolver and the CDP client are all real.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { fromFileUrl, join } from '@std/path';
import { type BusLogger, EventBus, type HandlerContext, silentBusLogger } from '@tykotech/bus';
import type { LaunchedBrowser, LaunchOptions } from '@tykotech/cdp';
import { BrowserKillEvent, BrowserLaunchEvent, BrowserStopEvent } from '../events.ts';
import { createBrowserProfile } from '../types.ts';
import { assertUserDataDirPresent } from '../browser/profile.ts';
import { BrowserSession } from '../browser/session.ts';
import { ChromeFixture } from '../browser/cdp_fixture_test.ts';
import type { WatchdogHost } from './base.ts';
import { HANDLER_BUDGET_RESERVE_MS } from './handler_budget.ts';
import {
	BROWSER_CLOSE_TIMEOUT_MS,
	GRACEFUL_KILL_MS,
	JSON_VERSION_POLL_INTERVAL_MS,
	JSON_VERSION_TIMEOUT_MS,
	LocalBrowserWatchdog,
	PREFERENCES_FILENAME,
	PRELOADING_OFF_PREFERENCE,
	PROFILE_LOCK_MAX_ATTEMPTS,
	removeProfileTree,
	TEMP_PROFILE_PREFIX,
} from './local_browser.ts';

// ---------------------------------------------------------------------------
// seams
// ---------------------------------------------------------------------------

interface LaunchRecorder {
	readonly calls: LaunchOptions[];
	readonly closed: { gracefulMs: number | undefined }[];
	readonly launch: (options: LaunchOptions) => Promise<LaunchedBrowser>;
	exitedAt: number | null;
}

/**
 * A launcher that records what it was asked for and hands back a `LaunchedBrowser` whose child has
 * already exited. `child` is the one Deno runtime type a test cannot construct without
 * `--allow-run`; only `status` is ever read on this path.
 */
function launchRecorder(cdpUrl: string): LaunchRecorder {
	const calls: LaunchOptions[] = [];
	const closed: { gracefulMs: number | undefined }[] = [];
	const recorder: LaunchRecorder = {
		calls,
		closed,
		exitedAt: null,
		launch: (options) => {
			calls.push(options);
			const child = {
				status: Promise.resolve<Deno.CommandStatus>({ success: true, code: 0, signal: null }),
			} as unknown as Deno.ChildProcess;
			const launched: LaunchedBrowser = {
				cdpUrl,
				webSocketDebuggerUrl: `${cdpUrl.replace('http', 'ws')}/devtools/browser/x`,
				child,
				executablePath: '/nonexistent/chrome',
				userDataDir: options.userDataDir,
				port: 9222,
				args: options.args ?? [],
				close: (closeOpts) => {
					closed.push({ gracefulMs: closeOpts?.gracefulMs });
					recorder.exitedAt = Date.now();
					return Promise.resolve();
				},
				[Symbol.asyncDispose]: () => Promise.resolve(),
			};
			return Promise.resolve(launched);
		},
	};
	return recorder;
}

function testHost(bus: EventBus, overrides: Partial<WatchdogHost> = {}): WatchdogHost {
	return {
		eventBus: bus,
		profile: createBrowserProfile({ userDataDir: '/tmp/bua-test-profile', headless: true }),
		logger: silentBusLogger,
		cdpClient: null,
		sessionManager: null,
		cdpUrl: null,
		isLocal: true,
		...overrides,
	};
}

const noopDirs = {
	ensureDir: () => Promise.resolve(),
	removeDir: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

Deno.test('ARCHITECTURE §6.1 launch constants are encoded verbatim', () => {
	assertEquals(JSON_VERSION_POLL_INTERVAL_MS, 100);
	assertEquals(JSON_VERSION_TIMEOUT_MS, 30_000);
	assertEquals(PROFILE_LOCK_MAX_ATTEMPTS, 3);
	assertEquals(GRACEFUL_KILL_MS, 5_000);
	assertEquals(BROWSER_CLOSE_TIMEOUT_MS, 5_000);
	// `bua doctor --kill-zombies` sweeps this glob (SETUP-WIZARD.md §4.4).
	assertEquals(TEMP_PROFILE_PREFIX, 'bua-tmp-');
});

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

Deno.test('launch composes profile args, asserts --user-data-dir, and pins the readiness poll', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(testHost(bus), {
		launch: recorder.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		const result = await bus.dispatch(new BrowserLaunchEvent())
			.eventResult({ raiseIfAny: true, raiseIfNone: true });
		assertEquals(result.cdpUrl, 'http://127.0.0.1:9222');

		assertEquals(recorder.calls.length, 1);
		const options = recorder.calls[0];
		assert(options !== undefined);
		assertEquals(options.userDataDir, '/tmp/bua-test-profile');
		assertEquals(options.headless, true);
		assertEquals(options.readinessPollIntervalMs, JSON_VERSION_POLL_INTERVAL_MS);
		assertEquals(options.readinessTimeoutMs, JSON_VERSION_TIMEOUT_MS);
		assertEquals(options.maxAttempts, PROFILE_LOCK_MAX_ATTEMPTS);
		// The normative §6.1 assertion, re-checked on the composed argv the watchdog handed over.
		assertUserDataDirPresent(options.args ?? []);
		assert((options.args ?? []).some((arg) => arg.startsWith('--user-data-dir=')));
		assertEquals(watchdog.launchPlan?.userDataDir, '/tmp/bua-test-profile');
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('launch is idempotent: a live browser is not launched twice', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(testHost(bus), {
		launch: recorder.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		assertEquals(recorder.calls.length, 1);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('a profile with no userDataDir gets a fresh bua-tmp-* directory, removed on kill', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const created: string[] = [];
	const removed: string[] = [];
	const watchdog = new LocalBrowserWatchdog(
		testHost(bus, { profile: createBrowserProfile({ headless: true }) }),
		{
			launch: recorder.launch,
			os: 'linux',
			env: {},
			makeTempProfileDir: () => {
				const dir = `/tmp/${TEMP_PROFILE_PREFIX}abc123`;
				created.push(dir);
				return Promise.resolve(dir);
			},
			ensureDir: () => Promise.resolve(),
			removeDir: (path) => {
				removed.push(path);
				return Promise.resolve();
			},
		},
	);
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		assertEquals(created.length, 1);
		assert(created[0]?.includes(TEMP_PROFILE_PREFIX));
		assertEquals(recorder.calls[0]?.userDataDir, created[0]);

		await bus.dispatch(new BrowserKillEvent());
		assertEquals(removed, created);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// kill
// ---------------------------------------------------------------------------

Deno.test('kill falls back to the process ladder when there is no CDP connection', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(testHost(bus), {
		launch: recorder.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await bus.dispatch(new BrowserKillEvent());
		assertEquals(recorder.closed, [{ gracefulMs: GRACEFUL_KILL_MS }]);
		assertEquals(watchdog.launched, null);
		await bus.dispatch(new BrowserKillEvent()); // idempotent
		assertEquals(recorder.closed.length, 1);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('kill prefers CDP Browser.close so Chrome tears down its own process tree', async () => {
	const fixture = ChromeFixture.start();
	const session = new BrowserSession({
		profile: { cdpUrl: fixture.wsUrl, userDataDir: '/tmp/bua-test-profile', headless: true },
		logger: silentBusLogger,
	});
	const recorder = launchRecorder(fixture.httpUrl);
	const watchdog = new LocalBrowserWatchdog(session, {
		launch: recorder.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		await session.start();
		await session.eventBus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await session.eventBus.dispatch(new BrowserKillEvent());

		assertEquals(fixture.requestsFor('Browser.close').length, 1, 'the graceful path is CDP, not a signal');
		// The process ladder still runs afterwards: it reaps the child and cleans the stderr tap.
		assertEquals(recorder.closed, [{ gracefulMs: GRACEFUL_KILL_MS }]);
	} finally {
		watchdog.detach();
		await session.stop({ force: true });
		await session.eventBus.stop();
		await fixture.close();
	}
});

// ---------------------------------------------------------------------------
// stop → kill
// ---------------------------------------------------------------------------

Deno.test('BrowserStopEvent enqueues the kill for a local browser', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(testHost(bus), {
		launch: recorder.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await bus.dispatch(new BrowserStopEvent());
		assertEquals(recorder.closed.length, 1);
		assertEquals(watchdog.launched, null);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('keepAlive leaves the browser running on a non-forced stop; force overrides', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(
		testHost(bus, { profile: createBrowserProfile({ userDataDir: '/tmp/p', headless: true, keepAlive: true }) }),
		{ launch: recorder.launch, os: 'linux', env: {}, ...noopDirs },
	);
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await bus.dispatch(new BrowserStopEvent());
		assertEquals(recorder.closed.length, 0, 'keepAlive is the whole point of the flag');
		assert(watchdog.launched !== null);

		await bus.dispatch(new BrowserStopEvent({ force: true }));
		assertEquals(recorder.closed.length, 1);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// kill budget — ERRATUM(KILL-1/2/3)
// ---------------------------------------------------------------------------

function killContext(signal: AbortSignal, timeoutSec = 30): HandlerContext {
	return { signal, handlerName: 'LocalBrowserWatchdog.onBrowserKillEvent', timeoutSec };
}

Deno.test('ERRATUM(KILL-1): an aborted kill reaps the process but starts no filesystem sweep', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const removed: string[] = [];
	const tempDir = `/tmp/${TEMP_PROFILE_PREFIX}aborted`;
	const watchdog = new LocalBrowserWatchdog(
		testHost(bus, { profile: createBrowserProfile({ headless: true }) }),
		{
			launch: recorder.launch,
			os: 'linux',
			env: {},
			makeTempProfileDir: () => Promise.resolve(tempDir),
			ensureDir: () => Promise.resolve(),
			removeDir: (path) => {
				removed.push(path);
				return Promise.resolve();
			},
		},
	);
	try {
		await watchdog.onBrowserLaunchEvent(new BrowserLaunchEvent());

		await watchdog.onBrowserKillEvent(new BrowserKillEvent(), killContext(AbortSignal.abort()));
		// The child is still reaped — an orphaned Chrome is worse than a leftover directory — but with
		// no grace window, because there is no budget left to wait in.
		assertEquals(recorder.closed, [{ gracefulMs: 0 }]);
		assertEquals(removed, [], 'a handler the bus has abandoned must not start filesystem work');

		// …and the directory is not forgotten. Idempotent teardown means the next kill finishes it.
		await watchdog.onBrowserKillEvent(new BrowserKillEvent(), killContext(new AbortController().signal));
		assertEquals(removed, [tempDir]);
	} finally {
		await bus.stop();
	}
});

Deno.test('ERRATUM(KILL-2): the close ladder is clamped to the budget, not stacked on top of it', async () => {
	// `TIMEOUT_BrowserKillEvent=3` leaves 2 s spendable after the reserve, so the 5 s graceful window
	// must come back reduced rather than honoured in full. The env source is injected, so this needs
	// no `--allow-env` and no real sleeping (D-TEST1 §4.1.4).
	const bus = new EventBus({
		name: 'lb',
		logger: silentBusLogger,
		env: (name) => name === 'TIMEOUT_BrowserKillEvent' ? '3' : undefined,
	});
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(testHost(bus), {
		launch: recorder.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await bus.dispatch(new BrowserKillEvent());
		const graceful = recorder.closed[0]?.gracefulMs ?? -1;
		assert(
			graceful > 0 && graceful <= 3_000 - HANDLER_BUDGET_RESERVE_MS,
			`gracefulMs was ${graceful}, so the 5 s cap was reserved rather than clamped`,
		);
		// The other direction is pinned by 'kill falls back to the process ladder', which asserts the
		// full GRACEFUL_KILL_MS under the real 30 s budget: a ceiling, not a reduction.
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('ERRATUM(KILL-3): the profile sweep stops between entries and resumes on the next pass', async () => {
	// Real files in the one writable root the §3.6 test matrix grants; `makeTempDir` is atomic, so a
	// --parallel sibling cannot collide with this tree.
	const scratchRoot = fromFileUrl(new URL('../../../../tests/.scratch', import.meta.url));
	await Deno.mkdir(scratchRoot, { recursive: true });
	const root = await Deno.makeTempDir({ dir: scratchRoot, prefix: 'bua-killsweep-' });
	try {
		await Deno.mkdir(join(root, 'Default', 'Cache'), { recursive: true });
		for (const name of ['a', 'b', 'c', 'd']) await Deno.writeTextFile(join(root, 'Default', 'Cache', name), name);
		await Deno.writeTextFile(join(root, 'lock'), '');
		assertEquals(await countEntries(root), 7);

		// Stop partway. The threshold is deliberately loose: entry order is the filesystem's business.
		let checks = 0;
		await removeProfileTree(root, () => ++checks > 6);
		const survived = await Deno.stat(root).then(() => true, () => false);
		assert(survived, 'an interrupted sweep must leave the bua-tmp-* root for the retry, not delete the tree');
		const left = await countEntries(root);
		assert(left > 0 && left < 7, `an interrupted sweep left ${left} of 7 entries`);

		// Resuming finishes the job, and a third pass over nothing is a no-op rather than a throw.
		await removeProfileTree(root);
		await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
		await removeProfileTree(root);
	} finally {
		await Deno.remove(root, { recursive: true }).catch(() => {});
	}
});

Deno.test('ERRATUM(KILL-5): a sweep that fails says so, instead of into a discarded debug line', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const warnings: { message: string; fields: Record<string, unknown> | undefined }[] = [];
	const logger: BusLogger = {
		debug: () => {},
		warn: (message, fields) => void warnings.push({ message, fields }),
		error: () => {},
	};
	const dir = `/tmp/${TEMP_PROFILE_PREFIX}locked`;
	const watchdog = new LocalBrowserWatchdog(
		testHost(bus, { profile: createBrowserProfile({ headless: true }), logger }),
		{
			launch: recorder.launch,
			os: 'linux',
			env: {},
			makeTempProfileDir: () => Promise.resolve(dir),
			ensureDir: () => Promise.resolve(),
			// The Windows case: the browser has exited but a handle on the profile has not been released.
			removeDir: () => Promise.reject(new Deno.errors.PermissionDenied('handle still open')),
		},
	);
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		// Still non-fatal: a stop is never failed over one directory.
		await bus.dispatch(new BrowserKillEvent());
		assertEquals(watchdog.launched, null);

		const warned = warnings.find((entry) => entry.message === 'temp profile dir could not be removed');
		assert(warned !== undefined, 'a failed sweep must be audible at a level the default logger keeps');
		assertEquals(warned.fields?.dir, dir);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// the launch/stop window — ERRATUM(CANCEL-4)
// ---------------------------------------------------------------------------

/** Holds a spawn open until the test releases it, so the launch/stop window is addressable. */
function gatedLaunch(recorder: LaunchRecorder): {
	launch: (options: LaunchOptions) => Promise<LaunchedBrowser>;
	release: () => void;
} {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		launch: async (options) => {
			await gate;
			return await recorder.launch(options);
		},
		release: () => release(),
	};
}

/** Spins the microtask queue until the watchdog reports a spawn in flight. */
async function whenLaunching(watchdog: LocalBrowserWatchdog): Promise<void> {
	for (let guard = 0; guard < 100 && !watchdog.launching; guard++) await Promise.resolve();
	assert(watchdog.launching, 'the spawn should be in flight');
}

Deno.test('ERRATUM(CANCEL-4): a stop mid-spawn kills the browser the spawn goes on to produce', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const gated = gatedLaunch(recorder);
	const removed: string[] = [];
	const tempDir = `/tmp/${TEMP_PROFILE_PREFIX}midspawn`;
	const watchdog = new LocalBrowserWatchdog(
		testHost(bus, { profile: createBrowserProfile({ headless: true }) }),
		{
			launch: gated.launch,
			os: 'linux',
			env: {},
			makeTempProfileDir: () => Promise.resolve(tempDir),
			ensureDir: () => Promise.resolve(),
			removeDir: (path) => {
				removed.push(path);
				return Promise.resolve();
			},
		},
	);
	try {
		watchdog.attach();
		const launching = bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await whenLaunching(watchdog);

		// The defect: `#launched` was still null here, so the stop used to return without a kill and
		// leave a Chrome running that nothing in this process could name.
		assertEquals(watchdog.launched, null);
		await bus.dispatch(new BrowserStopEvent());
		assertEquals(recorder.closed, [], 'the kill cannot close a handle that does not exist yet');
		assertEquals(removed, [], 'Chrome is still starting up inside that directory');

		// …and when the spawn finally lands, the launch reaps its own product.
		gated.release();
		await assertRejects(() => launching, Error, 'superseded');
		assertEquals(recorder.closed, [{ gracefulMs: 0 }], 'the orphan is closed by the only code holding it');
		assertEquals(watchdog.launched, null);
		assertEquals(watchdog.launching, false);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('ERRATUM(CANCEL-4): concurrent launches join one spawn instead of forking a second Chrome', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const gated = gatedLaunch(recorder);
	const watchdog = new LocalBrowserWatchdog(testHost(bus), {
		launch: gated.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		const first = watchdog.onBrowserLaunchEvent(new BrowserLaunchEvent());
		await whenLaunching(watchdog);
		const second = watchdog.onBrowserLaunchEvent(new BrowserLaunchEvent());

		gated.release();
		assertEquals((await first).cdpUrl, 'http://127.0.0.1:9222');
		assertEquals((await second).cdpUrl, 'http://127.0.0.1:9222');
		assertEquals(recorder.calls.length, 1, 'two Chromes against one profile is the profile-lock failure');
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

async function countEntries(dir: string): Promise<number> {
	let count = 0;
	for await (const entry of Deno.readDir(dir)) {
		count += 1;
		if (entry.isDirectory) count += await countEntries(join(dir, entry.name));
	}
	return count;
}

Deno.test('a remote (attached) browser is never killed by this watchdog', async () => {
	const bus = new EventBus({ name: 'lb', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(testHost(bus, { isLocal: false }), {
		launch: recorder.launch,
		os: 'linux',
		env: {},
		...noopDirs,
	});
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true });
		await bus.dispatch(new BrowserStopEvent({ force: true }));
		assertEquals(recorder.closed.length, 0);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// ERRATUM(E-110) (review R2-1): an allowlist launches the profile with preloading off
// ---------------------------------------------------------------------------

const FXB_SCRATCH = fromFileUrl(new URL('../../../../tests/.scratch', import.meta.url));

/** Launches once against a real profile directory under `tests/.scratch` and returns what the launcher left there. */
async function launchWithProfile(
	init: { allowedDomains?: string[] },
	seed: string | null,
): Promise<{ prefs: string | null; warnings: string[] }> {
	await Deno.mkdir(FXB_SCRATCH, { recursive: true });
	const dir = await Deno.makeTempDir({ dir: FXB_SCRATCH, prefix: 'fxb-e110-' });
	const file = join(dir, 'Default', PREFERENCES_FILENAME);
	if (seed !== null) {
		await Deno.mkdir(join(dir, 'Default'), { recursive: true });
		await Deno.writeTextFile(file, seed);
	}
	const warnings: string[] = [];
	const logger: BusLogger = { ...silentBusLogger, warn: (message) => void warnings.push(message) };
	const bus = new EventBus({ name: 'lb-e110', logger: silentBusLogger });
	const recorder = launchRecorder('http://127.0.0.1:9222');
	const watchdog = new LocalBrowserWatchdog(
		testHost(bus, { profile: createBrowserProfile({ userDataDir: dir, headless: true, ...init }), logger }),
		{ launch: recorder.launch, os: 'linux', env: {}, ...noopDirs },
	);
	try {
		watchdog.attach();
		await bus.dispatch(new BrowserLaunchEvent()).eventResult({ raiseIfAny: true, raiseIfNone: true });
		assertEquals(recorder.calls.length, 1, 'the launch went ahead');
		const prefs = await Deno.readTextFile(file).catch(() => null);
		const leftovers: string[] = [];
		try {
			for await (const entry of Deno.readDir(join(dir, 'Default'))) {
				if (entry.name !== PREFERENCES_FILENAME) leftovers.push(entry.name);
			}
		} catch {
			// No profile directory: nothing was written at all.
		}
		assertEquals(leftovers, [], 'no temp file is left beside Preferences');
		return { prefs, warnings };
	} finally {
		watchdog.detach();
		await bus.stop();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
}

Deno.test('E-110: with an allowlist the launcher writes preloading off into a fresh profile', async () => {
	assertEquals(PRELOADING_OFF_PREFERENCE, { section: 'net', key: 'network_prediction_options', value: 2 });
	const { prefs } = await launchWithProfile({ allowedDomains: ['*.example.com'] }, null);
	assertEquals(JSON.parse(prefs ?? 'null'), { net: { network_prediction_options: 2 } });
});

Deno.test('E-110: an existing Preferences file is merged, every other key kept', async () => {
	const seed = JSON.stringify({ net: { other: true, network_prediction_options: 0 }, profile: { name: 'kept' } });
	const { prefs } = await launchWithProfile({ allowedDomains: ['*.example.com'] }, seed);
	assertEquals(JSON.parse(prefs ?? 'null'), {
		net: { other: true, network_prediction_options: 2 },
		profile: { name: 'kept' },
	});
});

Deno.test('E-110: a Preferences file that is not a JSON object is left untouched, with a warning', async () => {
	const { prefs, warnings } = await launchWithProfile({ allowedDomains: ['*.example.com'] }, '[1,2]');
	assertEquals(prefs, '[1,2]');
	assert(warnings.some((message) => message.includes('not a JSON object')), JSON.stringify(warnings));
});

Deno.test('E-110 (AC3): without an allowlist nothing is written', async () => {
	const { prefs } = await launchWithProfile({}, null);
	assertEquals(prefs, null);
});
