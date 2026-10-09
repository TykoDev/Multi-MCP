/**
 * `PermissionsWatchdog` contract (ARCHITECTURE.md §6.5; COMPLETIONS-CRITERIA.md §3.2 watchdog row 5:
 * "default grants (clipboardReadWrite, notifications) on connect; failure non-fatal").
 *
 * Real bus, real `CdpClient`, real CDP frames over `ChromeFixture`. The failure test is the one that
 * matters: `BrowserConnectedEvent` is awaited by `start()`, so a throwing grant handler would fail
 * the whole session start over an ergonomic nicety.
 */

import { assertEquals } from '@std/assert';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { BrowserConnectedEvent } from '../events.ts';
import { type BrowserProfileInit, createBrowserProfile, DEFAULT_BROWSER_PERMISSIONS } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import { PermissionsWatchdog } from './permissions.ts';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly watchdog: PermissionsWatchdog;
	sent(method: string): FixtureRequest[];
}

async function harness(profile: BrowserProfileInit = {}): Promise<Harness> {
	const fixture = ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'permissions-test', logger: silentBusLogger });
	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(profile),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: null,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new PermissionsWatchdog(host);
	watchdog.attach();
	return {
		fixture,
		bus,
		watchdog,
		sent: (method) => fixture.requestsFor(method),
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await bus.stop();
			await client.close();
			await fixture.close();
		},
	};
}

Deno.test('permissions: LISTENS_TO is exactly BrowserConnectedEvent', async () => {
	await using h = await harness();
	assertEquals(PermissionsWatchdog.LISTENS_TO.map((cls) => cls.eventName), ['BrowserConnectedEvent']);
	assertEquals(PermissionsWatchdog.EMITS, []);
	assertEquals(h.bus.handlerCount(BrowserConnectedEvent), 1);
});

Deno.test('permissions: connect grants the §5.2 defaults browser-wide', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));

	const grants = h.sent('Browser.grantPermissions');
	assertEquals(grants.length, 1);
	assertEquals(grants[0]?.params.permissions, ['clipboardReadWrite', 'notifications']);
	assertEquals(grants[0]?.params.permissions, [...DEFAULT_BROWSER_PERMISSIONS]);
	// Browser-wide means: no origin, no browserContextId — every origin in the default context.
	assertEquals(grants[0]?.params.origin, undefined);
	assertEquals(grants[0]?.params.browserContextId, undefined);
	assertEquals(grants[0]?.sessionId, undefined, 'a per-session grant would only cover one tab');

	assertEquals(h.watchdog.grantedPermissions, ['clipboardReadWrite', 'notifications']);
	assertEquals(h.watchdog.lastError, null);
});

Deno.test('permissions: a configured list replaces the defaults verbatim', async () => {
	await using h = await harness({ permissions: ['geolocation', 'midi'] });
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.sent('Browser.grantPermissions')[0]?.params.permissions, ['geolocation', 'midi']);
});

Deno.test('permissions: an explicitly empty list grants nothing and is not an error', async () => {
	await using h = await harness({ permissions: [] });
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.sent('Browser.grantPermissions').length, 0);
	assertEquals(h.watchdog.grantedPermissions, null);
	assertEquals(h.watchdog.lastError, null);
});

Deno.test('permissions: a CDP failure is logged and does not break the connect path', async () => {
	await using h = await harness();
	h.fixture.script('Browser.grantPermissions', (request, self) => {
		self.replyError(request.id, { code: -32602, message: 'Invalid PermissionType: notifications' });
	});

	// Awaiting the handle rejects with the first handler error — so a throw here would surface as a
	// failed `start()`. It must resolve.
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));

	assertEquals(h.watchdog.grantedPermissions, null);
	assertEquals(typeof h.watchdog.lastError, 'string');
	assertEquals(await h.watchdog.grantConfiguredPermissions(), false);
});

Deno.test('permissions: a dead transport is non-fatal too', async () => {
	await using _h = await harness();
	const bus = new EventBus({ name: 'permissions-disconnected', logger: silentBusLogger });
	const watchdog = new PermissionsWatchdog({
		eventBus: bus,
		profile: createBrowserProfile(),
		logger: silentBusLogger,
		cdpClient: null,
		sessionManager: null,
		cdpUrl: null,
		isLocal: true,
	});
	watchdog.attach();
	try {
		// `this.cdp` throws CdpDisconnectedError; the handler swallows it like any other grant failure.
		await bus.dispatch(new BrowserConnectedEvent({ cdpUrl: 'ws://127.0.0.1:9/none' }));
		assertEquals(watchdog.grantedPermissions, null);
		assertEquals(typeof watchdog.lastError, 'string');
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});
