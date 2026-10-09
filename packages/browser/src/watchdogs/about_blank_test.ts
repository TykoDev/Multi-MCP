/**
 * `AboutBlankWatchdog` contract (ARCHITECTURE.md §6.3; COMPLETIONS-CRITERIA.md §3.2 watchdog row 3:
 * "never zero tabs: last-tab close spawns about:blank; screensaver injection is ○ droppable").
 *
 * Real bus, real `CdpClient`, real `SessionManager`, real CDP frames over `ChromeFixture` — the whole
 * `targetDestroyed → TabClosedEvent → rescue` chain runs for real, because the interesting failure
 * (racing SessionManager's own focus recovery into a *second* tab) only exists when both run.
 *
 * The dropped screensaver is pinned here too: a ○ feature that is dropped must be dropped visibly,
 * not left as an untested half.
 */

import { assert, assertEquals } from '@std/assert';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { AboutBlankDVDScreensaverShownEvent, BrowserStopEvent, TabCreatedEvent } from '../events.ts';
import { createBrowserProfile } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import {
	ABOUT_BLANK_TAB_POLL_INTERVAL_MS,
	ABOUT_BLANK_TAB_REGISTER_WAIT_MS,
	ABOUT_BLANK_URL,
	AboutBlankWatchdog,
} from './about_blank.ts';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly client: CdpClient;
	readonly watchdog: AboutBlankWatchdog;
	/** Swaps the manager the host reports, the way a reconnect/`reset()` does. */
	setManager(manager: SessionManager | null): void;
	sent(method: string): FixtureRequest[];
	settle(): Promise<void>;
}

async function harness(pages: readonly string[] = ['about:blank']): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'about-blank-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();
	for (const page of manager.pageTargets()) await manager.getOrCreateCdpSession(page.targetId, false);
	const focus = manager.mostRecentPageTarget();
	if (focus !== null) await manager.setAgentFocus(focus.targetId, { activate: false, announce: false });
	await manager.whenIdle();

	const state: { manager: SessionManager | null } = { manager };
	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(),
		logger: silentBusLogger,
		cdpClient: client,
		get sessionManager(): SessionManager | null {
			return state.manager;
		},
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new AboutBlankWatchdog(host);
	watchdog.attach();

	return {
		fixture,
		bus,
		manager,
		client,
		watchdog,
		setManager: (next) => {
			state.manager = next;
		},
		sent: (method) => fixture.requestsFor(method),
		settle: async () => {
			await client.send.Browser.getVersion();
			await manager.whenIdle();
			await client.send.Browser.getVersion();
			await manager.whenIdle();
		},
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await manager.stop();
			await bus.stop();
			await client.close();
			await fixture.close();
		},
	};
}

// ---------------------------------------------------------------------------
// registration + the dropped cosmetic
// ---------------------------------------------------------------------------

Deno.test('about-blank: LISTENS_TO is the tab-closed trigger plus the two stop signals', async () => {
	await using _h = await harness();
	assertEquals(AboutBlankWatchdog.LISTENS_TO.map((cls) => cls.eventName), [
		'TabClosedEvent',
		'BrowserStopEvent',
		'BrowserStoppedEvent',
	]);
	assertEquals(AboutBlankWatchdog.EMITS, []);
});

Deno.test('about-blank: the ○ screensaver is dropped whole — no TabCreatedEvent handler, no event', async () => {
	await using h = await harness();
	const shown: AboutBlankDVDScreensaverShownEvent[] = [];
	h.bus.on(AboutBlankDVDScreensaverShownEvent, (event) => void shown.push(event), { wrap: null });

	assertEquals(h.bus.handlerCount(TabCreatedEvent), 0, 'injection would need a TabCreatedEvent handler');
	h.fixture.addPage('about:blank');
	await h.settle();

	assertEquals(shown, [], 'ARCHITECTURE.md §6.3 marks the animation ○; it is dropped, not half-built');
	assertEquals(h.sent('Runtime.evaluate').length, 0, 'nothing is injected into a blank tab');
	assertEquals(h.sent('Page.addScriptToEvaluateOnNewDocument').length, 0);
});

// ---------------------------------------------------------------------------
// the guarantee
// ---------------------------------------------------------------------------

Deno.test('about-blank: closing the last tab opens exactly one replacement', async () => {
	await using h = await harness(['http://127.0.0.1:8080/only']);
	const only = h.manager.mostRecentPageTarget()?.targetId ?? '';
	assert(only !== '');

	h.fixture.removeTarget(only);
	await h.settle();

	// Exactly one: the rescue waits for the new target to register, so SessionManager's focus
	// recovery finds a page and does not create a second one.
	const created = h.sent('Target.createTarget');
	assertEquals(created.length, 1);
	assertEquals(created[0]?.params.url, ABOUT_BLANK_URL);
	assertEquals(h.watchdog.tabsCreated, 1);
	assertEquals(h.manager.pageTargets().length, 1);
});

Deno.test('about-blank: closing one of several tabs does nothing', async () => {
	await using h = await harness(['http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/b']);
	const victim = h.manager.pageTargets()[0]?.targetId ?? '';
	assert(victim !== '');

	h.fixture.removeTarget(victim);
	await h.settle();

	assertEquals(h.sent('Target.createTarget').length, 0);
	assertEquals(h.watchdog.tabsCreated, 0);
	assertEquals(h.manager.pageTargets().length, 1);
});

Deno.test('about-blank: concurrent rescues collapse into one tab', async () => {
	await using h = await harness([]);
	const [first, second] = await Promise.all([h.watchdog.ensurePageTarget(), h.watchdog.ensurePageTarget()]);
	assertEquals(first, second, 'two callers share one in-flight rescue');
	assertEquals(h.sent('Target.createTarget').length, 1);
	assertEquals(h.watchdog.tabsCreated, 1);
});

Deno.test('about-blank: a replacement that lands during the rescue does not become a second tab', async () => {
	await using h = await harness([]);
	let barriers = 0;
	// Chrome's own replacement tab, produced *at* the barrier — the one instant a check taken at
	// handler entry could not have seen it. One socket and ordered frames mean the `targetCreated`
	// this emits is recorded before the reply resolves the rescue's await
	// (ERRATUM(M1-hardening-3)).
	h.fixture.script('Browser.getVersion', (request, self) => {
		if (barriers++ === 0) self.addPage(ABOUT_BLANK_URL);
		self.reply(request.id, { product: 'Chrome/fixture' });
	});

	assertEquals(await h.watchdog.ensurePageTarget(), null, 'the browser rescued itself; stand down');
	assertEquals(h.sent('Target.createTarget').length, 0);
	assertEquals(h.watchdog.tabsCreated, 0);
	assertEquals(h.manager.pageTargets().length, 1, 'exactly one tab, not two');
});

Deno.test('about-blank: a browser that still has a page is left alone', async () => {
	await using h = await harness(['http://127.0.0.1:8080/live']);
	assertEquals(await h.watchdog.ensurePageTarget(), null);
	assertEquals(h.sent('Target.createTarget').length, 0);
});

Deno.test('about-blank: a createTarget failure is reported, never thrown at the notification', async () => {
	await using h = await harness([]);
	h.fixture.script('Target.createTarget', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Failed to open new tab' });
	});
	assertEquals(await h.watchdog.ensurePageTarget(), null);
	assertEquals(h.watchdog.tabsCreated, 0);
});

// ---------------------------------------------------------------------------
// arming
// ---------------------------------------------------------------------------

Deno.test('about-blank: a stop disarms the rescue so teardown cannot spawn tabs', async () => {
	await using h = await harness([]);
	assertEquals(h.watchdog.armed, true);

	await h.bus.dispatch(new BrowserStopEvent());

	assertEquals(h.watchdog.armed, false);
	assertEquals(await h.watchdog.ensurePageTarget(), null);
	assertEquals(h.sent('Target.createTarget').length, 0);
});

Deno.test('about-blank: a new SessionManager re-arms the watchdog (reset / reconnect)', async () => {
	await using h = await harness([]);
	await h.bus.dispatch(new BrowserStopEvent());
	assertEquals(h.watchdog.armed, false);

	// What `reset()` produces: the same session, a brand-new manager over a live client.
	const revived = new SessionManager(h.client, { bus: h.bus, logger: silentBusLogger });
	await revived.start();
	h.setManager(revived);
	try {
		assertEquals(h.watchdog.armed, true, 'the disarm is scoped to the manager it was observed on');
		assert(await h.watchdog.ensurePageTarget() !== null);
	} finally {
		h.setManager(h.manager);
		await revived.stop();
	}
});

Deno.test('about-blank: a session with no manager is inert rather than throwing', async () => {
	await using h = await harness([]);
	h.setManager(null);
	try {
		assertEquals(h.watchdog.armed, false);
		assertEquals(await h.watchdog.ensurePageTarget(), null);
	} finally {
		h.setManager(h.manager);
	}
});

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

Deno.test('about-blank: the registration wait fits inside the 3 s TabClosedEvent budget', () => {
	assertEquals(ABOUT_BLANK_TAB_REGISTER_WAIT_MS, 1_000);
	assertEquals(ABOUT_BLANK_TAB_POLL_INTERVAL_MS, 20);
	assertEquals(ABOUT_BLANK_URL, 'about:blank');
	assert(ABOUT_BLANK_TAB_REGISTER_WAIT_MS < 3_000, 'DATA-MODEL.md §5.1.3 gives TabClosedEvent 3 s');
});
