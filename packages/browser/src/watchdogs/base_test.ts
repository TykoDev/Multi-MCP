/**
 * `BaseWatchdog` contract tests (ARCHITECTURE.md §4.5–§4.7, §6; AGENTS.md §3 watchdog checklist).
 *
 * This is the seam the remaining 13 watchdogs inherit, so the tests pin the properties they will all
 * depend on: `on<EventName>` auto-registration, the `LISTENS_TO`/`EMITS` assertion, detach hygiene,
 * typed accessors that fail loudly instead of handing back `null`, and the fact that handlers run
 * through the bus-level circuit breaker without the watchdog doing anything.
 */

import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { type ConnectionPolicy, EventBus, type HandlerContext, resilientWrapper, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { BrowserConnectedEvent, BrowserErrorEvent, BrowserStartEvent, TabCreatedEvent, WaitEvent } from '../events.ts';
import { CdpDisconnectedError } from '../errors.ts';
import { createBrowserProfile } from '../types.ts';
import { ChromeFixture } from '../browser/cdp_fixture_test.ts';
import { BaseWatchdog, WatchdogError, type WatchdogHost } from './base.ts';

function testHost(bus: EventBus, overrides: Partial<WatchdogHost> = {}): WatchdogHost {
	return {
		eventBus: bus,
		profile: createBrowserProfile(),
		logger: silentBusLogger,
		cdpClient: null,
		sessionManager: null,
		cdpUrl: null,
		isLocal: true,
		...overrides,
	};
}

class CountingWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [TabCreatedEvent, BrowserConnectedEvent];
	static override readonly EMITS = [BrowserErrorEvent];

	tabs = 0;
	connections = 0;
	attachHooks = 0;
	detachHooks = 0;

	onTabCreatedEvent(_event: TabCreatedEvent): void {
		this.tabs += 1;
	}

	onBrowserConnectedEvent(_event: BrowserConnectedEvent): void {
		this.connections += 1;
	}

	protected override afterAttach(): void {
		this.attachHooks += 1;
	}

	protected override beforeDetach(): void {
		this.detachHooks += 1;
	}
}

/** Declares an event it has no handler for. */
class StaleDeclarationWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [TabCreatedEvent, BrowserConnectedEvent];

	onTabCreatedEvent(_event: TabCreatedEvent): void {}
}

/** Handles an event it never declared. */
class UndeclaredHandlerWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [TabCreatedEvent];

	onTabCreatedEvent(_event: TabCreatedEvent): void {}
	onBrowserConnectedEvent(_event: BrowserConnectedEvent): void {}
}

/** The naming trap the base class documents: `on<Word>` is read as an event handler. */
class BadlyNamedHookWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [TabCreatedEvent];

	onTabCreatedEvent(_event: TabCreatedEvent): void {}
	onStartup(): void {}
}

class BreakerWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [WaitEvent, BrowserStartEvent];

	ran: string[] = [];

	onWaitEvent(_event: WaitEvent): void {
		this.ran.push('wait');
	}

	onBrowserStartEvent(_event: BrowserStartEvent): { cdpUrl: string } {
		this.ran.push('start');
		return { cdpUrl: 'ws://127.0.0.1:9222/x' };
	}
}

Deno.test('attach subscribes every on<EventName> method; detach removes them all', async () => {
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	const watchdog = new CountingWatchdog(testHost(bus));
	try {
		assertEquals(watchdog.attached, false);
		watchdog.attach();
		assertEquals(watchdog.attached, true);
		assertEquals(watchdog.name, 'CountingWatchdog');
		assertEquals(bus.handlerCount(TabCreatedEvent), 1);
		assertEquals(bus.handlerCount(BrowserConnectedEvent), 1);
		assertEquals(watchdog.attachHooks, 1);

		await bus.dispatch(new TabCreatedEvent({ targetId: 'T1', url: 'about:blank' }));
		await bus.dispatch(new BrowserConnectedEvent({ cdpUrl: 'ws://127.0.0.1:9222/x' }));
		assertEquals(watchdog.tabs, 1);
		assertEquals(watchdog.connections, 1);

		watchdog.detach();
		assertEquals(watchdog.attached, false);
		assertEquals(watchdog.detachHooks, 1);
		assertEquals(bus.handlerCount(TabCreatedEvent), 0);
		await bus.dispatch(new TabCreatedEvent({ targetId: 'T2', url: 'about:blank' }));
		assertEquals(watchdog.tabs, 1, 'a detached watchdog must not keep handling events');

		watchdog.detach(); // idempotent
		assertEquals(watchdog.detachHooks, 1);
	} finally {
		await bus.stop();
	}
});

Deno.test('attaching twice throws (D-BUS1: duplicate registration is an error)', async () => {
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	const watchdog = new CountingWatchdog(testHost(bus));
	try {
		watchdog.attach();
		assertThrows(() => watchdog.attach(), WatchdogError, 'already attached');
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('a stale LISTENS_TO declaration fails at attach time, not in production', async () => {
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	try {
		assertThrows(
			() => new StaleDeclarationWatchdog(testHost(bus)).attach(),
			Error,
			'has no onBrowserConnectedEvent method',
		);
		assertThrows(
			() => new UndeclaredHandlerWatchdog(testHost(bus)).attach(),
			Error,
			'missing from its LISTENS_TO declaration',
		);
		assertEquals(bus.handlerCount(TabCreatedEvent), 0, 'a failed attach leaves nothing half-registered');
	} finally {
		await bus.stop();
	}
});

Deno.test('a helper named on<Word> is rejected — the trap afterAttach/beforeDetach exists to avoid', async () => {
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	try {
		assertThrows(() => new BadlyNamedHookWatchdog(testHost(bus)).attach(), Error, 'Startup');
	} finally {
		await bus.stop();
	}
});

Deno.test('cdp and sessions fail loudly rather than handing back null', async () => {
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	class ProbeWatchdog extends BaseWatchdog {
		static override readonly LISTENS_TO = [];
		readCdp(): unknown {
			return this.cdp;
		}
		readSessions(): unknown {
			return this.sessions;
		}
		readProfile(): unknown {
			return this.profile;
		}
	}
	const watchdog = new ProbeWatchdog(testHost(bus));
	try {
		watchdog.attach();
		assertThrows(() => watchdog.readCdp(), CdpDisconnectedError, 'needs a CDP connection');
		assertThrows(() => watchdog.readSessions(), CdpDisconnectedError, 'needs an active SessionManager');
		assert(watchdog.readProfile() !== null);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

Deno.test('watchdog handlers run through the bus circuit breaker without opting in', async () => {
	const connection: ConnectionPolicy = {
		isConnected: () => false,
		isReconnecting: () => false,
		waitForReconnect: () => Promise.resolve(false),
		isLifecycleEvent: (event) => event.eventType === BrowserStartEvent.eventName,
	};
	const bus = new EventBus({
		name: 'wd',
		logger: silentBusLogger,
		wrapHandler: resilientWrapper({ connection, logger: silentBusLogger }),
	});
	const watchdog = new BreakerWatchdog(testHost(bus));
	try {
		watchdog.attach();
		await bus.dispatch(new WaitEvent({ seconds: 0 }));
		assertEquals(watchdog.ran, [], 'a non-lifecycle handler is skipped while disconnected');
		await bus.dispatch(new BrowserStartEvent());
		assertEquals(watchdog.ran, ['start'], 'lifecycle handlers always run');
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// cdpFor(context) — the E-52 cancellation facade
// ---------------------------------------------------------------------------

/** Exposes the protected accessors so the facade can be exercised without a real dispatch. */
class CdpProbeWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [];

	bare(): CdpClient {
		return this.cdp;
	}

	bound(context: HandlerContext | undefined): CdpClient {
		return this.cdpFor(context);
	}
}

function handlerContext(signal: AbortSignal, timeoutSec = 5): HandlerContext {
	return { signal, handlerName: 'CdpProbeWatchdog.probe', timeoutSec };
}

Deno.test('cdpFor: a CDP call issued after the budget blows never reaches the wire (E-52)', async () => {
	await using fixture = await ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	const watchdog = new CdpProbeWatchdog(testHost(bus, { cdpClient: client }));
	const controller = new AbortController();
	const context = handlerContext(controller.signal);
	try {
		// One call before the abort proves the fixture answers this method at all.
		await watchdog.bound(context).send.Browser.getVersion();
		assertEquals(fixture.requestsFor('Browser.getVersion').length, 1);

		controller.abort(new Error('budget blown'));
		// The rejection carries the handler's own abort reason, not a generic transport error.
		await assertRejects(
			() => watchdog.bound(context).send.Browser.getVersion(),
			Error,
			'budget blown',
		);
		assertEquals(
			fixture.requestsFor('Browser.getVersion').length,
			1,
			'a handler that overran its budget must not keep talking to the browser',
		);

		// The unbound accessor is unchanged — a direct (non-dispatch) call still works.
		await watchdog.bare().send.Browser.getVersion();
		assertEquals(fixture.requestsFor('Browser.getVersion').length, 2);
	} finally {
		await client.close();
		await bus.stop();
	}
});

Deno.test('cdpFor: an in-flight CDP call is settled by the abort, not left to its own timeout', async () => {
	await using fixture = await ChromeFixture.start();
	// Accepted and never answered: without cancellation this waits out the 60 s request timeout.
	fixture.script('Browser.getVersion', () => {});
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	const watchdog = new CdpProbeWatchdog(testHost(bus, { cdpClient: client }));
	const controller = new AbortController();
	try {
		const inFlight = watchdog.bound(handlerContext(controller.signal)).send.Browser.getVersion();
		await until(() => fixture.requestsFor('Browser.getVersion').length === 1);
		assertEquals(client.pendingRequestCount, 1);
		controller.abort(new Error('budget blown'));
		await assertRejects(() => inFlight, Error, 'budget blown');
		assertEquals(client.pendingRequestCount, 0, 'the abandoned request must not stay pending');
	} finally {
		await client.close();
		await bus.stop();
	}
});

Deno.test('cdpFor(undefined) is the bare client — a direct call keeps the unbudgeted behaviour', async () => {
	await using fixture = await ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	const watchdog = new CdpProbeWatchdog(testHost(bus, { cdpClient: client }));
	try {
		assertEquals(watchdog.bound(undefined), client, 'no context means no signal to bind');
		await watchdog.bound(undefined).send.Browser.getVersion();
		assertEquals(fixture.requestsFor('Browser.getVersion').length, 1);
	} finally {
		await client.close();
		await bus.stop();
	}
});

Deno.test('cdpFor: the bound view forwards the rest of the client and composes a caller signal', async () => {
	await using fixture = await ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	const watchdog = new CdpProbeWatchdog(testHost(bus, { cdpClient: client }));
	const controller = new AbortController();
	const bound = watchdog.bound(handlerContext(controller.signal));
	try {
		// Non-`send` members must still work through the facade, including ones reading private state.
		assertEquals(bound.state, 'open');
		assertEquals(bound.url, client.url);
		assertEquals(bound.listenerCount('Target.targetCreated'), 0);
		const off = bound.on('Target.targetCreated', () => {});
		assertEquals(client.listenerCount('Target.targetCreated'), 1, 'listeners must land on the real client');
		off();

		// A signal supplied by the call site is composed with the handler's, never replaced by it.
		const own = new AbortController();
		own.abort(new Error('call-site cancellation'));
		await assertRejects(() => bound.send.Browser.getVersion(undefined, undefined, { signal: own.signal }));
		assertEquals(fixture.requestsFor('Browser.getVersion').length, 0);
	} finally {
		await client.close();
		await bus.stop();
	}
});

Deno.test('cdpFor: a handler that overruns its bus budget stops talking to CDP (E-52 end to end)', async () => {
	await using fixture = await ChromeFixture.start();
	fixture.script('Browser.getVersion', () => {});
	const client = await CdpClient.connect(fixture.wsUrl);
	// A 50 ms budget for TabCreatedEvent, read through the bus's injected env getter (D-CFG1).
	const bus = new EventBus({
		name: 'wd',
		logger: silentBusLogger,
		env: (name) => name === 'TIMEOUT_TabCreatedEvent' ? '0.05' : undefined,
	});

	const seen: string[] = [];
	class OverrunWatchdog extends BaseWatchdog {
		static override readonly LISTENS_TO = [TabCreatedEvent];

		async onTabCreatedEvent(_event: TabCreatedEvent, context?: HandlerContext): Promise<void> {
			const cdp = this.cdpFor(context);
			// Blows the budget: the fixture never answers this one.
			await cdp.send.Browser.getVersion().catch(() => seen.push('first:aborted'));
			// The escaping step. Before the facade this reached the wire regardless.
			await cdp.send.Browser.getWindowForTarget().catch(() => seen.push('second:aborted'));
		}
	}
	const watchdog = new OverrunWatchdog(testHost(bus, { cdpClient: client }));
	try {
		watchdog.attach();
		const handle = bus.dispatch(new TabCreatedEvent({ targetId: 'T1', url: 'about:blank' }));
		await handle.outcomes();
		await until(() => seen.length === 2);
		assertEquals(seen, ['first:aborted', 'second:aborted']);
		assertEquals(
			fixture.requestsFor('Browser.getWindowForTarget').length,
			0,
			'E-52: the post-budget CDP call must never reach the browser',
		);
	} finally {
		watchdog.detach();
		await client.close();
		await bus.stop();
	}
});

/** Polls a condition on the real clock; the tests above race a socket, not a timer. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('condition not met within the test budget');
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

Deno.test('a throwing handler surfaces through eventResult without aborting its siblings (E-3)', async () => {
	const bus = new EventBus({ name: 'wd', logger: silentBusLogger });
	class ThrowingWatchdog extends BaseWatchdog {
		static override readonly LISTENS_TO = [TabCreatedEvent];
		onTabCreatedEvent(_event: TabCreatedEvent): void {
			throw new WatchdogError('nope');
		}
	}
	let siblingRan = false;
	const watchdog = new ThrowingWatchdog(testHost(bus));
	try {
		watchdog.attach();
		bus.on(TabCreatedEvent, () => {
			siblingRan = true;
		}, { wrap: null });
		const handle = bus.dispatch(new TabCreatedEvent({ targetId: 'T1', url: 'about:blank' }));
		await assertRejects(() => handle.eventResult({ raiseIfAny: true }), WatchdogError, 'nope');
		assertEquals(siblingRan, true, 'E-3: a throwing handler does NOT abort its siblings');
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});
