/**
 * @module
 * The canonical watchdog **attach order** of ARCHITECTURE.md §6, as data.
 *
 * > Attach order is significant (LocalBrowserWatchdog must exist before `BrowserLaunchEvent` is
 * > dispatched): Downloads, StorageState (conditional), LocalBrowser, Security, AboutBlank, Popups,
 * > Permissions, DefaultAction, Screenshot, DOM, Recording, HarRecording (conditional), Captcha
 * > (conditional). CrashWatchdog is defined but not attached by default.
 *
 * Order is load-bearing twice over:
 *
 * 1. **Handlers of one event run in registration order** (build-run erratum E-2). `BrowserStartEvent`
 *    dispatches `BrowserLaunchEvent` and awaits its result, so `LocalBrowserWatchdog` must already be
 *    subscribed when `start()` runs — hence "LocalBrowser before `BrowserLaunchEvent`".
 * 2. **`BrowserSession` registers last** (E-16). Its `BrowserStopEvent` handler closes the CDP socket
 *    that `StorageStateWatchdog`'s final cookie save, `RecordingWatchdog`'s `Page.stopScreencast` and
 *    `HarRecordingWatchdog`'s body fetches all still need. `BrowserSession.attach()` is therefore
 *    called *after* everything in this list — see `browser/session.ts`'s "Attach order" note.
 *
 * The list holds **constructors**, not names: a watchdog that has not been written yet is a
 * compile error at the import above, never a silently missing row. Conditional entries carry their
 * predicate, so {@linkcode watchdogsForProfile} is the single place that decides what a given profile
 * actually attaches.
 *
 * ERRATUM(M1-watchdogs-rest-11): this file did not exist in the module plan — §6's ordering was prose
 * inside ARCHITECTURE.md and nothing owned it in code. It cannot live inside one of the fourteen
 * watchdog modules without making a leaf watchdog import its thirteen peers, so it is its own module,
 * imported by `mod.ts` and by whatever wires a session.
 */

import type { EventClass } from '@tykotech/bus';
import type { BrowserProfile } from '../types.ts';
import type { BaseWatchdog, WatchdogHost } from './base.ts';

import { DownloadsWatchdog } from './downloads.ts';
import { shouldAttachStorageStateWatchdog, StorageStateWatchdog } from './storage_state.ts';
import { LocalBrowserWatchdog } from './local_browser.ts';
import { SecurityWatchdog } from './security.ts';
import { AboutBlankWatchdog } from './about_blank.ts';
import { PopupsWatchdog } from './popups.ts';
import { PermissionsWatchdog } from './permissions.ts';
import { DefaultActionWatchdog } from './default_action.ts';
import { ScreenshotWatchdog } from './screenshot.ts';
import { DOMWatchdog } from './dom.ts';
import { RecordingWatchdog, shouldAttachRecordingWatchdog } from './recording.ts';
import { HarRecordingWatchdog, shouldAttachHarRecordingWatchdog } from './har_recording.ts';
import { CaptchaWatchdog, shouldAttachCaptchaWatchdog } from './captcha.ts';
import { CrashWatchdog } from './crash.ts';

/**
 * A watchdog class as this list needs to see it: constructible from a {@linkcode WatchdogHost} and
 * carrying the two static declarations `registerHandlers` asserts at attach time.
 */
export interface WatchdogConstructor {
	new (host: WatchdogHost): BaseWatchdog;
	readonly LISTENS_TO: readonly EventClass[];
	readonly EMITS: readonly EventClass[];
}

/** One row of the attach order. */
export interface WatchdogAttachEntry {
	/** The class name, matching ARCHITECTURE.md §6's numbered list. */
	readonly name: string;
	readonly watchdog: WatchdogConstructor;
	/** `null` for the unconditional rows; otherwise the §6 attachment predicate. */
	readonly attachIf: ((profile: BrowserProfile) => boolean) | null;
}

/**
 * The thirteen watchdogs a session attaches, in order.
 *
 * `CrashWatchdog` is deliberately absent — see {@linkcode UNATTACHED_WATCHDOGS}.
 */
export const WATCHDOG_ATTACH_ORDER: readonly WatchdogAttachEntry[] = [
	{ name: 'DownloadsWatchdog', watchdog: DownloadsWatchdog, attachIf: null },
	{ name: 'StorageStateWatchdog', watchdog: StorageStateWatchdog, attachIf: shouldAttachStorageStateWatchdog },
	// ERRATUM(E-21). `AboutBlankWatchdog` moved ahead of `LocalBrowserWatchdog`.
	// Handler order is registration order, and `LocalBrowserWatchdog`'s
	// `BrowserStopEvent` handler *awaits* the kill it dispatches — so with the
	// spec's order the browser is already dying, and its tabs already closing,
	// before `AboutBlankWatchdog` has seen the stop event and disarmed. Its
	// `TabClosedEvent` handler then tried to rescue a browser on its way out,
	// past its own barrier (Chrome still answers `Browser.getVersion` for a
	// moment after it stops accepting `Target.createTarget`), and every single
	// shutdown logged `ERROR could not open a replacement about:blank tab`.
	// The two have no ordering relationship other than this one: the moved
	// handler is a pure disarm, and the never-zero-tabs guarantee is not owed to
	// a browser that is being killed.
	{ name: 'AboutBlankWatchdog', watchdog: AboutBlankWatchdog, attachIf: null },
	{ name: 'LocalBrowserWatchdog', watchdog: LocalBrowserWatchdog, attachIf: null },
	{ name: 'SecurityWatchdog', watchdog: SecurityWatchdog, attachIf: null },
	{ name: 'PopupsWatchdog', watchdog: PopupsWatchdog, attachIf: null },
	{ name: 'PermissionsWatchdog', watchdog: PermissionsWatchdog, attachIf: null },
	{ name: 'DefaultActionWatchdog', watchdog: DefaultActionWatchdog, attachIf: null },
	{ name: 'ScreenshotWatchdog', watchdog: ScreenshotWatchdog, attachIf: null },
	{ name: 'DOMWatchdog', watchdog: DOMWatchdog, attachIf: null },
	{ name: 'RecordingWatchdog', watchdog: RecordingWatchdog, attachIf: shouldAttachRecordingWatchdog },
	{ name: 'HarRecordingWatchdog', watchdog: HarRecordingWatchdog, attachIf: shouldAttachHarRecordingWatchdog },
	{ name: 'CaptchaWatchdog', watchdog: CaptchaWatchdog, attachIf: shouldAttachCaptchaWatchdog },
];

/**
 * Watchdogs of §6 that exist but are not attached by default. `CrashWatchdog` is the only one
 * (§6.11: "defined, not attached"); `WATCHDOG_ATTACH_ORDER.length + UNATTACHED_WATCHDOGS.length`
 * is the fourteen of §6.
 */
export const UNATTACHED_WATCHDOGS: readonly WatchdogAttachEntry[] = [
	{ name: 'CrashWatchdog', watchdog: CrashWatchdog, attachIf: null },
];

/** All fourteen, attached and not. */
export const ALL_WATCHDOGS: readonly WatchdogAttachEntry[] = [...WATCHDOG_ATTACH_ORDER, ...UNATTACHED_WATCHDOGS];

/** The rows a given profile attaches, in order. Conditional rows are filtered by their predicate. */
export function watchdogsForProfile(profile: BrowserProfile): readonly WatchdogAttachEntry[] {
	return WATCHDOG_ATTACH_ORDER.filter((entry) => entry.attachIf === null || entry.attachIf(profile));
}

/**
 * Constructs and attaches every watchdog the profile calls for, in order, and returns them.
 *
 * The caller attaches `BrowserSession` afterwards (E-16) and is responsible for detaching these in
 * reverse on teardown — this helper deliberately owns construction order and nothing else.
 */
export function attachWatchdogs(host: WatchdogHost): BaseWatchdog[] {
	const attached: BaseWatchdog[] = [];
	for (const entry of watchdogsForProfile(host.profile)) {
		const watchdog = new entry.watchdog(host);
		watchdog.attach();
		attached.push(watchdog);
	}

	// ERRATUM(E-28): wire the click→download seam. `DefaultActionWatchdog` detects click-triggered
	// downloads through a channel it *declares* structurally rather than imports, so the two watchdogs
	// stay independently compilable (ARCHITECTURE §6.8/§6.10). Late binding means nothing forces a
	// construction order — but it also means the join belongs to whoever constructs both, i.e. here.
	// Without this, every watchdog attaches and self-tests green while click-download detection is
	// silently inert: clicks still work, downloads simply are never noticed. Both halves were built and
	// tested correctly; the join was nobody's file.
	const downloads = attached.find((w): w is DownloadsWatchdog => w instanceof DownloadsWatchdog);
	const defaultAction = attached.find((w): w is DefaultActionWatchdog => w instanceof DefaultActionWatchdog);
	if (downloads !== undefined && defaultAction !== undefined) {
		defaultAction.setDownloadChannel(downloads);
	}

	return attached;
}
