/**
 * The §6 attach order, as a contract (ARCHITECTURE.md §6 intro; COMPLETIONS-CRITERIA.md §3.2:
 * "All 14 watchdogs of ARCHITECTURE.md §6 … attach order verified (LocalBrowserWatchdog before
 * `BrowserLaunchEvent`); CrashWatchdog is speced defined-not-attached").
 *
 * The order is prose in the spec and data here; this file is what stops the two drifting. It runs on
 * a real bus with a real `ChromeFixture` behind the host, because `attachWatchdogs` really attaches
 * all thirteen and the registration order it produces is the thing under test.
 */

import { assert, assertEquals } from '@std/assert';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { BROWSER_EVENTS, BrowserLaunchEvent, BrowserStopEvent } from '../events.ts';
import { type BrowserProfileInit, createBrowserProfile } from '../types.ts';
import type { BaseWatchdog, WatchdogHost } from './base.ts';
import { DefaultActionWatchdog } from './default_action.ts';
import { DownloadsWatchdog } from './downloads.ts';
import {
	ALL_WATCHDOGS,
	attachWatchdogs,
	UNATTACHED_WATCHDOGS,
	WATCHDOG_ATTACH_ORDER,
	watchdogsForProfile,
} from './attach_order.ts';

/**
 * ARCHITECTURE.md §6 intro, transcribed — with the one documented deviation.
 *
 * ERRATUM(E-21): `AboutBlankWatchdog` runs before `LocalBrowserWatchdog` rather
 * than after `SecurityWatchdog`. Handler order is registration order, and
 * `LocalBrowserWatchdog` awaits the kill it dispatches from its own
 * `BrowserStopEvent` handler — so in the spec's order the browser is already
 * dying, and its tabs already closing, before `AboutBlankWatchdog` disarms.
 * See the comment at the deviation site.
 */
const SPEC_ORDER = [
	'DownloadsWatchdog',
	'StorageStateWatchdog',
	'AboutBlankWatchdog',
	'LocalBrowserWatchdog',
	'SecurityWatchdog',
	'PopupsWatchdog',
	'PermissionsWatchdog',
	'DefaultActionWatchdog',
	'ScreenshotWatchdog',
	'DOMWatchdog',
	'RecordingWatchdog',
	'HarRecordingWatchdog',
	'CaptchaWatchdog',
];

/** Everything §6.9/§6.12/§6.13/§6.14 makes conditional. */
const EVERYTHING_ON: BrowserProfileInit = {
	storageState: '/does/not/need/to/exist.json',
	recordVideoDir: '/does/not/need/to/exist',
	recordHarPath: '/does/not/need/to/exist.har',
	captchaSolver: true,
};

Deno.test('attach order: the list is ARCHITECTURE.md §6 verbatim', () => {
	assertEquals(WATCHDOG_ATTACH_ORDER.map((entry) => entry.name), SPEC_ORDER);
	// The class is carried, not just the name, so a missing watchdog is a compile error in
	// `attach_order.ts` rather than a row that quietly disappears.
	for (const entry of WATCHDOG_ATTACH_ORDER) {
		assertEquals(entry.watchdog.name, entry.name);
	}
});

Deno.test('attach order: fourteen watchdogs, thirteen attached and Crash defined-not-attached', () => {
	assertEquals(ALL_WATCHDOGS.length, 14, 'ARCHITECTURE.md §6 heading: "Watchdogs (14)"');
	assertEquals(WATCHDOG_ATTACH_ORDER.length, 13);
	assertEquals(UNATTACHED_WATCHDOGS.map((entry) => entry.name), ['CrashWatchdog']);
	assertEquals(new Set(ALL_WATCHDOGS.map((entry) => entry.name)).size, 14, 'no duplicates');
});

Deno.test('attach order: LocalBrowserWatchdog is subscribed before anything can dispatch BrowserLaunchEvent', () => {
	const index = WATCHDOG_ATTACH_ORDER.findIndex((entry) => entry.name === 'LocalBrowserWatchdog');
	assert(index >= 0);
	const listens = WATCHDOG_ATTACH_ORDER[index]?.watchdog.LISTENS_TO ?? [];
	assert(
		listens.some((cls) => cls === BrowserLaunchEvent),
		'the ordering constraint of §6 only means anything because this watchdog handles the event',
	);
	// Nothing earlier in the list handles it, so its position cannot be an accident of another row.
	for (const entry of WATCHDOG_ATTACH_ORDER.slice(0, index)) {
		assertEquals(entry.watchdog.LISTENS_TO.includes(BrowserLaunchEvent), false);
	}
	// It is unconditional: a profile could otherwise legally drop the launcher.
	assertEquals(WATCHDOG_ATTACH_ORDER[index]?.attachIf, null);
});

Deno.test('attach order: exactly the four conditional rows carry predicates', () => {
	const conditional = WATCHDOG_ATTACH_ORDER.filter((entry) => entry.attachIf !== null).map((entry) => entry.name);
	assertEquals(conditional, [
		'StorageStateWatchdog',
		'RecordingWatchdog',
		'HarRecordingWatchdog',
		'CaptchaWatchdog',
	]);
});

Deno.test('attach order: a default profile attaches ten of the thirteen', () => {
	const names = watchdogsForProfile(createBrowserProfile()).map((entry) => entry.name);
	assertEquals(names, [
		'DownloadsWatchdog',
		'AboutBlankWatchdog',
		'LocalBrowserWatchdog',
		'SecurityWatchdog',
		'PopupsWatchdog',
		'PermissionsWatchdog',
		'DefaultActionWatchdog',
		'ScreenshotWatchdog',
		'DOMWatchdog',
		// Captcha survives: `captchaSolver` defaults to `true` (DATA-MODEL.md §5.2).
		'CaptchaWatchdog',
	]);
});

Deno.test('attach order: turning every conditional on yields the full thirteen, in order', () => {
	const names = watchdogsForProfile(createBrowserProfile(EVERYTHING_ON)).map((entry) => entry.name);
	assertEquals(names, SPEC_ORDER);
});

Deno.test('attach order: switching every conditional off drops exactly the four', () => {
	const profile = createBrowserProfile({
		storageState: null,
		userDataDir: null,
		recordVideoDir: null,
		recordHarPath: null,
		captchaSolver: false,
	});
	const names = watchdogsForProfile(profile).map((entry) => entry.name);
	assertEquals(names.includes('StorageStateWatchdog'), false);
	assertEquals(names.includes('RecordingWatchdog'), false);
	assertEquals(names.includes('HarRecordingWatchdog'), false);
	assertEquals(names.includes('CaptchaWatchdog'), false);
	assertEquals(names.length, 9);
});

Deno.test('attach order: every declared event belongs to the 44-event catalog', () => {
	const catalog = new Set(BROWSER_EVENTS);
	for (const entry of ALL_WATCHDOGS) {
		for (const cls of [...entry.watchdog.LISTENS_TO, ...entry.watchdog.EMITS]) {
			assert(catalog.has(cls), `${entry.name} references ${cls.eventName}, which is not in the catalog`);
		}
	}
});

Deno.test('attach order: attachWatchdogs subscribes them in order, on a real bus', async () => {
	await using fixture = ChromeFixture.start({ pages: ['about:blank'] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'attach-order-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await manager.whenIdle();

	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(EVERYTHING_ON),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};

	let attached: BaseWatchdog[] = [];
	try {
		attached = attachWatchdogs(host);
		assertEquals(attached.map((watchdog) => watchdog.name), SPEC_ORDER);
		assertEquals(attached.every((watchdog) => watchdog.attached), true);

		// E-16: `BrowserStopEvent`'s handler list is a set, not an order — but every watchdog that
		// declares it must be registered before `BrowserSession`, which closes the socket. Here that
		// means: the session is not in this list, and the stop handlers that exist are all watchdogs'.
		const stopHandlers = watchdogsForProfile(host.profile)
			.filter((entry) => entry.watchdog.LISTENS_TO.includes(BrowserStopEvent))
			.map((entry) => entry.name);
		assertEquals(bus.handlerCount(BrowserStopEvent), stopHandlers.length);
		assert(
			['LocalBrowserWatchdog', 'StorageStateWatchdog', 'AboutBlankWatchdog', 'RecordingWatchdog']
				.every((name) => stopHandlers.includes(name)),
			`DATA-MODEL.md §5.1.2 names these as BrowserStopEvent handlers; got ${stopHandlers.join(', ')}`,
		);
	} finally {
		for (const watchdog of [...attached].reverse()) watchdog.detach();
		await manager.stop();
		await bus.stop();
		await client.close();
	}
});

Deno.test('attach order: attachWatchdogs wires the click→download seam (E-28)', async () => {
	// Regression for a seam gap that self-tested green on BOTH sides. DefaultActionWatchdog declares
	// the download channel structurally instead of importing DownloadsWatchdog — deliberately, so the
	// two stay independently compilable — which means neither builder's suite could observe that
	// nobody ever joined them. Click-download detection was silently inert: clicks worked, downloads
	// were simply never noticed. A default profile attaches both, so the wiring must be live with no
	// opt-in.
	await using fixture = ChromeFixture.start({ pages: ['about:blank'] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'download-seam-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await manager.whenIdle();

	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile({}),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};

	let attached: BaseWatchdog[] = [];
	try {
		attached = attachWatchdogs(host);
		const downloads = attached.find((w) => w instanceof DownloadsWatchdog);
		const defaultAction = attached.find((w) => w instanceof DefaultActionWatchdog);
		assert(downloads !== undefined, 'the default profile must attach DownloadsWatchdog');
		assert(defaultAction !== undefined, 'the default profile must attach DefaultActionWatchdog');

		// The assertion that matters is identity, not presence: a channel set to some *other*
		// DownloadsWatchdog instance would receive no CDP frames and fail exactly as silently.
		assertEquals(
			defaultAction.downloadChannel,
			downloads,
			'the channel must be the attached DownloadsWatchdog instance itself',
		);
	} finally {
		for (const watchdog of attached) watchdog.detach();
		await bus.stop();
		await manager.stop();
		await client.close();
	}
});
