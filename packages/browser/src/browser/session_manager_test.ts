/**
 * `SessionManager` contract tests (ARCHITECTURE.md §7.3; COMPLETIONS-CRITERIA.md §3.2 SessionManager
 * row): single-source-of-truth maps, push-based discovery, the per-session autoAttach cascade, focus
 * recovery including the emergency-fallback tab, `getOrCreateCdpSession` as the sole accessor, the
 * maxlen-50 lifecycle ring buffers, and the 4-char `tabId` suffix resolution.
 *
 * Everything runs against the real {@linkcode ChromeFixture} over a real WebSocket — no CDP or bus
 * is mocked (D-TEST1).
 */

import { assert, assertEquals, assertLess, assertRejects, assertStrictEquals } from '@std/assert';
import { delay } from '@std/async';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { AgentFocusChangedEvent, BrowserErrorEvent, TabClosedEvent, TabCreatedEvent } from '../events.ts';
import { resolveTargetIdByTabId, tabIdFor } from '../types.ts';
import {
	ATTACH_POLL_INTERVAL_MS,
	ATTACH_WAIT_TIMEOUT_MS,
	CHAIN_MEMORY_LIMIT,
	DISCOVERY_FILTER,
	FETCH_ARM_TIMEOUT_MS,
	FETCH_UNSUPPORTED,
	JUDGED_RESOURCE_TYPES,
	LIFECYCLE_RING_CAPACITY,
	REQUEST_BLOCK_ORIGIN_LIMIT,
	REQUEST_BLOCK_TARGET_LIMIT,
	requestKindOf,
	RingBuffer,
	SessionManager,
	SUBRESOURCE_BLOCK_ERROR_REASON,
} from './session_manager.ts';
import { ChromeFixture, type ChromeFixtureOptions, type FixtureRequest } from './cdp_fixture_test.ts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly client: CdpClient;
	readonly manager: SessionManager;
	readonly seen: { type: string; targetId: string }[];
}

async function harness(options: ChromeFixtureOptions = {}): Promise<Harness> {
	const fixture = ChromeFixture.start(options);
	const bus = new EventBus({ name: 'test', logger: silentBusLogger });
	const client = await CdpClient.connect(fixture.wsUrl);
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	const seen: { type: string; targetId: string }[] = [];
	bus.on(TabCreatedEvent, (event) => void seen.push({ type: 'created', targetId: event.targetId }));
	bus.on(TabClosedEvent, (event) => void seen.push({ type: 'closed', targetId: event.targetId }));
	bus.on(AgentFocusChangedEvent, (event) => void seen.push({ type: 'focus', targetId: event.targetId }));
	await manager.start();
	return {
		fixture,
		bus,
		client,
		manager,
		seen,
		[Symbol.asyncDispose]: async () => {
			await manager.stop();
			await client.close();
			await bus.stop();
			await fixture.close();
		},
	};
}

/** Polls a predicate; CDP events cross a real socket, so arrival is genuinely asynchronous. */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// constants (COMPLETIONS-CRITERIA.md §3.2: "all timing constants encoded verbatim and asserted")
// ---------------------------------------------------------------------------

Deno.test('ARCHITECTURE §7.3/§8 constants are encoded verbatim', () => {
	assertEquals(LIFECYCLE_RING_CAPACITY, 50);
	assertEquals(ATTACH_WAIT_TIMEOUT_MS, 2_000);
	assert(ATTACH_POLL_INTERVAL_MS < ATTACH_WAIT_TIMEOUT_MS);
	assertEquals(DISCOVERY_FILTER.map((entry) => entry.type), ['page', 'iframe']);
});

Deno.test('RingBuffer keeps exactly the newest `capacity` entries', () => {
	const buffer = new RingBuffer<number>(LIFECYCLE_RING_CAPACITY);
	for (let index = 0; index < LIFECYCLE_RING_CAPACITY * 2; index++) buffer.push(index);
	assertEquals(buffer.size, LIFECYCLE_RING_CAPACITY);
	assertEquals(buffer.toArray()[0], LIFECYCLE_RING_CAPACITY);
	assertEquals(buffer.toArray().at(-1), LIFECYCLE_RING_CAPACITY * 2 - 1);
	buffer.clear();
	assertEquals(buffer.size, 0);
});

Deno.test('RingBuffer refuses a non-positive capacity', () => {
	let threw = false;
	try {
		new RingBuffer<number>(0);
	} catch {
		threw = true;
	}
	assert(threw);
});

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

Deno.test('discovery is push-based: setDiscoverTargets once, getTargets once, no polling', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });

	const discover = h.fixture.requestsFor('Target.setDiscoverTargets');
	assertEquals(discover.length, 1);
	assertEquals(discover[0]?.params.discover, true);
	assertEquals(discover[0]?.params.filter, [{ type: 'page' }, { type: 'iframe' }]);

	// Give any hypothetical poller a generous window to betray itself.
	await delay(150);
	assertEquals(h.fixture.requestsFor('Target.getTargets').length, 1);
	assertEquals(h.manager.targets.size, 2);
});

Deno.test('a target created after start is discovered without being asked for', async () => {
	await using h = await harness();
	const targetId = h.fixture.addPage('about:blank');
	await waitUntil(() => h.manager.targets.has(targetId), 'targetCreated to arrive');
	assertEquals(h.manager.targets.get(targetId)?.type, 'page');
	// Seeded targets are suppressed for the §7.4 replay; targets discovered later announce themselves.
	await waitUntil(() => h.seen.some((entry) => entry.type === 'created' && entry.targetId === targetId), 'TabCreated');
});

Deno.test('seededPageTargets carries the pre-existing tabs for the §7.4 replay', async () => {
	await using h = await harness({ pages: ['about:blank', 'https://127.0.0.1/a'] });
	assertEquals(h.manager.seededPageTargets().length, 2);
	// …and nothing was announced for them: the session replays them itself, in its own order.
	assertEquals(h.seen.filter((entry) => entry.type === 'created').length, 0);
});

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

Deno.test('attach records the maps and cascades per-session autoAttach + page domains', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	const session = await h.manager.getOrCreateCdpSession(targetId, true);

	assertEquals(h.manager.sessions.get(session.sessionId)?.targetId, targetId);
	assertEquals(h.manager.sessionTargets.get(session.sessionId), targetId);
	assert(h.manager.targetSessions.get(targetId)?.has(session.sessionId));

	await waitUntil(
		() => h.fixture.requestsFor('Page.setLifecycleEventsEnabled').length > 0,
		'per-session setup calls',
	);
	const scoped = (method: string) => h.fixture.requestsFor(method).filter((r) => r.sessionId === session.sessionId);
	assertEquals(scoped('Target.setAutoAttach').length, 1);
	assertEquals(scoped('Page.enable').length, 1);
	assertEquals(scoped('Page.setLifecycleEventsEnabled').length, 1);
	assertEquals(scoped('Network.enable').length, 1);
	// No proxy configured ⇒ Fetch is never enabled.
	assertEquals(h.fixture.requestsFor('Fetch.enable').length, 0);
});

Deno.test('a debugger-paused target is resumed on attach', async () => {
	await using h = await harness();
	h.fixture.script('Target.attachToTarget', (request, fixture) => {
		const sessionId = fixture.attachTarget(String(request.params.targetId), true);
		fixture.reply(request.id, { sessionId });
	});
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.manager.getOrCreateCdpSession(targetId, true);
	await waitUntil(
		() => h.fixture.requestsFor('Runtime.runIfWaitingForDebugger').length === 1,
		'the paused target to be resumed',
	);
});

Deno.test('proxy credentials arm Fetch.enable per session', async () => {
	const fixture = ChromeFixture.start();
	const bus = new EventBus({ name: 'proxy', logger: silentBusLogger });
	const client = await CdpClient.connect(fixture.wsUrl);
	const manager = new SessionManager(client, {
		bus,
		logger: silentBusLogger,
		proxy: { server: 'http://127.0.0.1:3128', username: 'u', password: 'p' },
	});
	try {
		await manager.start();
		manager.armProxyAuth();
		const targetId = manager.mostRecentPageTarget()?.targetId ?? '';
		const session = await manager.getOrCreateCdpSession(targetId, true);
		await waitUntil(() => fixture.requestsFor('Fetch.enable').length === 1, 'Fetch.enable');
		const enabled = fixture.requestsFor('Fetch.enable')[0];
		assertEquals(enabled?.sessionId, session.sessionId);
		assertEquals(enabled?.params.handleAuthRequests, true);

		fixture.emit('Fetch.authRequired', {
			requestId: 'REQ1',
			request: { url: 'http://127.0.0.1/x' },
			frameId: 'F',
			resourceType: 'Document',
			authChallenge: { origin: 'http://127.0.0.1:3128', scheme: 'basic', realm: 'proxy', source: 'Proxy' },
		}, session.sessionId);
		await waitUntil(() => fixture.requestsFor('Fetch.continueWithAuth').length === 1, 'continueWithAuth');
		const answered = fixture.requestsFor('Fetch.continueWithAuth')[0]?.params.authChallengeResponse as
			| Record<string, unknown>
			| undefined;
		assertEquals(answered?.response, 'ProvideCredentials');
		assertEquals(answered?.username, 'u');
	} finally {
		await manager.stop();
		await client.close();
		await bus.stop();
		await fixture.close();
	}
});

// ---------------------------------------------------------------------------
// getOrCreateCdpSession — the sole sanctioned accessor
// ---------------------------------------------------------------------------

Deno.test('getOrCreateCdpSession reuses an existing session and validates focus', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	const first = await h.manager.getOrCreateCdpSession(targetId, true);
	const second = await h.manager.getOrCreateCdpSession(targetId, true);
	assertStrictEquals(first.sessionId, second.sessionId);
	assertEquals(h.fixture.requestsFor('Target.attachToTarget').length, 1);
	assertEquals(h.manager.agentFocusTargetId, targetId);
});

Deno.test('getOrCreateCdpSession does not hand out a session whose Network.enable is unanswered', async () => {
	await using h = await harness();
	const held: FixtureRequest[] = [];
	// `Network.enable` is received and deliberately left unanswered: the attach cascade is stuck
	// exactly where the first document would otherwise slip past it (ERRATUM(M1-hardening-1)).
	h.fixture.script('Network.enable', (request) => void held.push(request));

	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	assert(targetId !== '');
	let settled = false;
	const pending = h.manager.getOrCreateCdpSession(targetId, true).then((record) => {
		settled = true;
		return record;
	});

	await waitUntil(() => held.length === 1, 'Network.enable to be issued');
	// Two full round trips on the same socket: anything the accessor was going to resolve with has
	// had every chance to arrive.
	await h.client.send.Browser.getVersion();
	await h.client.send.Browser.getVersion();
	assertEquals(settled, false, 'an un-instrumented session is not a session anyone may navigate on');

	const enable = held[0];
	assert(enable !== undefined);
	h.fixture.reply(enable.id, {}, enable.sessionId);
	assertEquals((await pending).targetId, targetId);
});

Deno.test('a navigation on a freshly attached target cannot outrun its Network.enable', async () => {
	await using h = await harness({ pages: [] });
	const created = await h.client.send.Target.createTarget({ url: 'about:blank' });
	await waitUntil(() => h.manager.targets.has(created.targetId), 'the new target to be discovered');

	// The whole point of the accessor: what it returns is safe to navigate on. Without the cascade
	// await, `Page.navigate` is issued while `Network.enable` is still in flight and the first
	// document's `Network.*` events are never emitted — an empty, green HAR.
	const session = await h.manager.getOrCreateCdpSession(created.targetId, true);
	await h.client.send.Page.navigate({ url: 'http://127.0.0.1:1/first' }, session.sessionId);

	const order = h.fixture.requests.filter((request) => request.sessionId === session.sessionId)
		.map((request) => request.method);
	const enabled = order.indexOf('Network.enable');
	const navigated = order.indexOf('Page.navigate');
	assert(enabled >= 0, `Network.enable must be issued on the session: ${order.join(', ')}`);
	assertLess(enabled, navigated, `Network.enable must precede the navigation: ${order.join(', ')}`);
});

Deno.test('only page targets may hold the agent focus', async () => {
	await using h = await harness();
	const iframeId = h.fixture.addPage('https://127.0.0.1/frame', 'iframe');
	await waitUntil(() => h.manager.targets.has(iframeId), 'the iframe target to be discovered');

	await assertRejects(
		() => h.manager.getOrCreateCdpSession(iframeId, true),
		Error,
		'cannot hold the agent',
	);
	// …but it is perfectly attachable without focus.
	const session = await h.manager.getOrCreateCdpSession(iframeId, false);
	assertEquals(session.targetId, iframeId);
});

Deno.test('getOrCreateCdpSession falls back to focus, then to the most recent page', async () => {
	await using h = await harness();
	const first = h.manager.mostRecentPageTarget()?.targetId ?? '';
	const resolved = await h.manager.getOrCreateCdpSession(null, true);
	assertEquals(resolved.targetId, first);

	const second = h.fixture.addPage('https://127.0.0.1/second');
	await waitUntil(() => h.manager.targets.has(second), 'the second page');
	// Focus is sticky: a null targetId now resolves to the focused tab, not the newest one.
	const again = await h.manager.getOrCreateCdpSession(null, true);
	assertEquals(again.targetId, first);
	assertEquals(h.manager.mostRecentPageTarget()?.targetId, second);
});

Deno.test('with no page targets at all, the accessor refuses rather than guessing', async () => {
	await using h = await harness({ pages: [] });
	await assertRejects(() => h.manager.getOrCreateCdpSession(null, true), Error, 'no page target');
});

// ---------------------------------------------------------------------------
// the global lifecycle router + ring buffers
// ---------------------------------------------------------------------------

Deno.test('one global Page.lifecycleEvent router fills per-target ring buffers, maxlen 50', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });
	const [a, b] = h.manager.pageTargets();
	assert(a !== undefined && b !== undefined);
	await h.manager.getOrCreateCdpSession(a.targetId, true);
	await h.manager.getOrCreateCdpSession(b.targetId, false);

	for (let index = 0; index < LIFECYCLE_RING_CAPACITY + 10; index++) {
		h.fixture.emitLifecycle(a.targetId, `tick${index}`, 'LOADER-A');
	}
	h.fixture.emitLifecycle(b.targetId, 'load', 'LOADER-B');

	await waitUntil(
		() => h.manager.lifecycleBufferSize(a.targetId) === LIFECYCLE_RING_CAPACITY,
		'the ring buffer to saturate',
	);
	await waitUntil(() => h.manager.lifecycleBufferSize(b.targetId) === 1, 'the second buffer');

	const records = h.manager.lifecycleEventsFor(a.targetId);
	assertEquals(records.length, LIFECYCLE_RING_CAPACITY);
	assertEquals(records[0]?.name, 'tick10');
	assertEquals(records.at(-1)?.name, `tick${LIFECYCLE_RING_CAPACITY + 9}`);
	// Routing is per session id: target B saw exactly its own event.
	assertEquals(h.manager.lifecycleEventsFor(b.targetId).map((record) => record.name), ['load']);
});

Deno.test('a lifecycle event for an unknown session is dropped, not misattributed', async () => {
	await using h = await harness();
	const targetId = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.manager.getOrCreateCdpSession(targetId, true);
	h.fixture.emit('Page.lifecycleEvent', {
		frameId: 'F',
		loaderId: 'L',
		name: 'load',
		timestamp: 1,
	}, 'SESSION-THAT-NEVER-ATTACHED');
	await delay(50);
	assertEquals(h.manager.lifecycleBufferSize(targetId), 0);
});

// ---------------------------------------------------------------------------
// detach, removal, focus recovery
// ---------------------------------------------------------------------------

Deno.test('a target dies only when its last session detaches; TabClosedEvent fires once', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });
	const [a, b] = h.manager.pageTargets();
	assert(a !== undefined && b !== undefined);
	await h.manager.getOrCreateCdpSession(a.targetId, true);
	await h.manager.getOrCreateCdpSession(b.targetId, false);

	h.fixture.removeTarget(b.targetId);
	await waitUntil(() => !h.manager.targets.has(b.targetId), 'the target to be removed');
	await h.manager.whenIdle();

	const closed = h.seen.filter((entry) => entry.type === 'closed');
	assertEquals(closed.length, 1);
	assertEquals(closed[0]?.targetId, b.targetId);
	assertEquals(h.manager.sessions.size, 1);
	assertEquals(h.manager.targetSessions.has(b.targetId), false);
});

Deno.test('an iframe target removal does NOT fire TabClosedEvent', async () => {
	await using h = await harness();
	const iframeId = h.fixture.addPage('https://127.0.0.1/frame', 'iframe');
	await waitUntil(() => h.manager.targets.has(iframeId), 'the iframe');
	h.fixture.removeTarget(iframeId);
	await waitUntil(() => !h.manager.targets.has(iframeId), 'the iframe to be removed');
	await h.manager.whenIdle();
	assertEquals(h.seen.filter((entry) => entry.type === 'closed').length, 0);
});

Deno.test('focus recovery picks the most recent surviving page and announces it', async () => {
	await using h = await harness({ pages: ['about:blank'] });
	const first = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.manager.getOrCreateCdpSession(first, true);
	const second = h.fixture.addPage('https://127.0.0.1/kept');
	await waitUntil(() => h.manager.targets.has(second), 'the survivor');

	h.fixture.removeTarget(first);
	await waitUntil(() => h.manager.agentFocusTargetId === second, 'focus to move to the survivor');
	await h.manager.whenIdle();
	assert(h.seen.some((entry) => entry.type === 'focus' && entry.targetId === second));
	assert(h.fixture.requestsFor('Target.activateTarget').some((r) => r.params.targetId === second));
});

Deno.test('the focus pointer never names a target that has already been removed', async () => {
	await using h = await harness({ pages: ['about:blank'] });
	const only = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.manager.getOrCreateCdpSession(only, true);
	const survivor = h.fixture.addPage('https://127.0.0.1/kept');
	await waitUntil(() => h.manager.targets.has(survivor), 'the survivor to be discovered');

	// What an agent's next step does, from inside the `TabClosedEvent` window — the 3 s fan-out that
	// runs *between* removal and focus recovery. The pointer used to still name the dead target for
	// that whole window, and resolving "the current tab" then failed with `Target.attachToTarget:
	// No target with given id found` (ERRATUM(M1-hardening-2)).
	const observed: { alive: boolean; resolved: string | null; error: string | null }[] = [];
	h.bus.on(TabClosedEvent, async () => {
		const focus = h.manager.agentFocusTargetId;
		let resolved: string | null = null;
		let error: string | null = null;
		try {
			resolved = (await h.manager.getOrCreateCdpSession(null, true)).targetId;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		observed.push({ alive: focus === null || h.manager.targets.has(focus), resolved, error });
	});

	h.fixture.removeTarget(only);
	await waitUntil(() => observed.length === 1, 'the TabClosedEvent handler to run');
	await h.manager.whenIdle();

	const seen = observed[0];
	assert(seen !== undefined);
	assertEquals(seen.alive, true, 'the focus pointer must never name a target the manager has removed');
	assertEquals(seen.error, null, `resolving the current tab inside the window must not fail: ${seen.error}`);
	assertEquals(seen.resolved, survivor);
});

Deno.test('with no pages left, focus recovery creates an about:blank tab', async () => {
	await using h = await harness({ pages: ['about:blank'] });
	const only = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.manager.getOrCreateCdpSession(only, true);

	h.fixture.removeTarget(only);
	await waitUntil(() => h.fixture.requestsFor('Target.createTarget').length === 1, 'the replacement tab');
	const created = h.fixture.requestsFor('Target.createTarget')[0];
	assertEquals(created?.params.url, 'about:blank');
	await waitUntil(() => h.manager.agentFocusTargetId !== null, 'focus on the replacement');
});

Deno.test('emergency fallback: a failing createTarget reports FocusRecoveryFailed instead of throwing', async () => {
	await using h = await harness({ pages: ['about:blank'] });
	const errors: BrowserErrorEvent[] = [];
	h.bus.on(BrowserErrorEvent, (event) => void errors.push(event));
	h.fixture.script('Target.createTarget', (request, fixture) => {
		fixture.replyError(request.id, { code: -32000, message: 'Cannot create target' });
	});
	const only = h.manager.mostRecentPageTarget()?.targetId ?? '';
	await h.manager.getOrCreateCdpSession(only, true);

	h.fixture.removeTarget(only);
	await waitUntil(() => errors.length === 1, 'the FocusRecoveryFailed report');
	assertEquals(errors[0]?.errorType, 'FocusRecoveryFailed');
	assertEquals(h.manager.agentFocusTargetId, null);
});

// ---------------------------------------------------------------------------
// tab identity (DATA-MODEL.md §5.4)
// ---------------------------------------------------------------------------

Deno.test('tab identity for the LLM is the 4-char targetId suffix, resolved back by suffix match', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });
	const ids = [...h.manager.targets.keys()];
	assertEquals(ids.length, 2);
	for (const id of ids) {
		assertEquals(tabIdFor(id).length, 4);
		assertEquals(resolveTargetIdByTabId(tabIdFor(id), ids), id);
	}
});

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

Deno.test('stop() detaches every listener and refuses further accessor calls', async () => {
	const fixture = ChromeFixture.start();
	const bus = new EventBus({ name: 'stop', logger: silentBusLogger });
	const client = await CdpClient.connect(fixture.wsUrl);
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	try {
		await manager.start();
		await manager.getOrCreateCdpSession(null, true);
		await manager.stop();
		assertEquals(manager.targets.size, 0);
		assertEquals(manager.sessions.size, 0);
		assertEquals(manager.started, false);
		await assertRejects(() => manager.getOrCreateCdpSession(null, true), Error, 'stopped');
		await manager.stop(); // idempotent
	} finally {
		await client.close();
		await bus.stop();
		await fixture.close();
	}
});

// ---------------------------------------------------------------------------
// CancelOptions — ERRATUM(E-62)
// ---------------------------------------------------------------------------

Deno.test('E-62: getOrCreateCdpSession refuses entry to an abandoned caller', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });
	const second = h.fixture.targets[1]?.targetId ?? '';
	const before = h.fixture.requests.length;
	const focusBefore = h.manager.agentFocusTargetId;

	const error = await assertRejects(() =>
		h.manager.getOrCreateCdpSession(second, true, { signal: AbortSignal.abort(new Error('budget blown')) })
	);
	assertEquals((error as Error).message, 'budget blown', 'the gate throws the abort reason itself');
	assertEquals(h.fixture.requests.length, before, 'no CDP command was issued');
	assertEquals(
		h.manager.agentFocusTargetId,
		focusBefore,
		'the focus pointer must not move either — the gate is above the whole transaction',
	);
});

Deno.test('E-62: setAgentFocus refuses entry, and binds the signal to activateTarget', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });
	const second = h.fixture.targets[1]?.targetId ?? '';
	const focusBefore = h.manager.agentFocusTargetId;
	const activatesBefore = h.fixture.requestsFor('Target.activateTarget').length;

	// Reached directly rather than through `onSwitchTabEvent`: that handler calls
	// `getOrCreateCdpSession` first, whose own gate fires and hides whether this one exists at all.
	// `setAgentFocus` has other callers (ScreenshotWatchdog's focus repair, SessionManager's own
	// recovery), so its gate has to be defended on its own terms.
	await assertRejects(() =>
		h.manager.setAgentFocus(second, {
			activate: true,
			announce: false,
			signal: AbortSignal.abort(new Error('budget blown')),
		})
	);
	assertEquals(
		h.fixture.requestsFor('Target.activateTarget').length,
		activatesBefore,
		'an abandoned caller must not activate a tab',
	);
	assertEquals(h.manager.agentFocusTargetId, focusBefore, 'nor move the focus pointer');
});

Deno.test('E-62: a signal that aborts mid-flight cancels activateTarget without failing the focus move', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });
	const second = h.fixture.targets[1]?.targetId ?? '';
	// Accepted and never answered: without a bound signal this waits out the CDP request timeout.
	h.fixture.script('Target.activateTarget', () => {});
	const controller = new AbortController();
	const startedAt = performance.now();
	const move = h.manager.setAgentFocus(second, { activate: true, announce: false, signal: controller.signal });
	await waitUntil(() => h.fixture.requestsFor('Target.activateTarget').length > 0, 'activateTarget to be issued');
	controller.abort(new Error('budget blown'));

	// `activateTarget` is cosmetic and its failure is already swallowed, so the abort costs nothing the
	// existing catch does not tolerate: the focus pointer still moved, which is the part that matters.
	const record = await move;
	assertEquals(record.targetId, second);
	assertEquals(h.manager.agentFocusTargetId, second);
	assertEquals(h.client.pendingRequestCount, 0, 'the abandoned request must not stay pending');

	// The load-bearing half. Unbound, this call is answered by nothing and settles only when the CDP
	// request timeout expires 60 s later — and every assertion above still passes, just a minute late.
	// The clock is what distinguishes "cancelled" from "waited it out", so the clock is asserted.
	const elapsed = performance.now() - startedAt;
	assertLess(elapsed, 5_000, `the abort must settle the request, not wait out its 60 s timeout (${elapsed}ms)`);
});

Deno.test('E-62: no signal means no cancellation — the unbudgeted path is unchanged', async () => {
	await using h = await harness({ pages: ['about:blank', 'about:blank'] });
	const second = h.fixture.targets[1]?.targetId ?? '';
	const session = await h.manager.getOrCreateCdpSession(second, true);
	assert(session.sessionId.length > 0);
	const record = await h.manager.setAgentFocus(second, { activate: true, announce: false });
	assertEquals(record.targetId, second);
	assertEquals(h.manager.agentFocusTargetId, second);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-94) — the pre-request document veto (E0, AC3)
// ---------------------------------------------------------------------------

const ON_LIST = 'http://127.0.0.1:8080/page';
const OFF_LIST = 'http://localhost:9090/exfiltrate?code=Zq8-E0-CODE';

/** A filter like `BrowserSession`'s: 127.0.0.1 only. */
const loopbackOnly = (url: string): boolean => URL.parse(url)?.hostname === '127.0.0.1';

interface FilterHarness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly manager: SessionManager;
	readonly errors: BrowserErrorEvent[];
	readonly warnings: { message: string; fields: Record<string, unknown> | undefined }[];
	readonly logged: string[];
	/** Attaches the seeded page, optionally paused for the debugger, and returns its session id. */
	attach(waitingForDebugger?: boolean): Promise<string>;
	paused(sessionId: string, params: Record<string, unknown>): void;
	/** One CDP round trip, then the manager's background work: every frame written before it has been handled. */
	settle(): Promise<void>;
	/** ERRATUM(E-114): creates a target of `type`, attaches it held for the debugger, and returns its session id. */
	attachType(type: string, waitingForDebugger?: boolean): Promise<string>;
}

async function filterHarness(
	options: {
		filter?: ((url: string) => boolean) | null;
		proxy?: boolean;
		fetchEnableFails?: boolean;
		scope?: 'documents' | 'all';
		fetchArmTimeoutMs?: number;
		fetchUnsupported?: ReadonlySet<string>;
	} = {},
): Promise<FilterHarness> {
	const fixture = ChromeFixture.start({ pages: [ON_LIST] });
	if (options.fetchEnableFails === true) {
		fixture.script(
			'Fetch.enable',
			(request, f) => f.replyError(request.id, { code: -32000, message: 'Fetch unavailable' }),
		);
	}
	const bus = new EventBus({ name: 'e0', logger: silentBusLogger });
	const client = await CdpClient.connect(fixture.wsUrl);
	const warnings: { message: string; fields: Record<string, unknown> | undefined }[] = [];
	const logged: string[] = [];
	const line = (message: string, fields?: Record<string, unknown>): void =>
		void logged.push(`${message} ${JSON.stringify(fields)}`);
	const manager = new SessionManager(client, {
		bus,
		logger: {
			debug: line,
			error: line,
			warn: (message, fields) => {
				warnings.push({ message, fields });
				line(message, fields);
			},
		},
		documentFilter: options.filter === undefined ? loopbackOnly : options.filter,
		...(options.proxy === true ? { proxy: { server: 'http://127.0.0.1:3128', username: 'u', password: 'p' } } : {}),
		...(options.scope === undefined ? {} : { requestScope: options.scope }),
		...(options.fetchArmTimeoutMs === undefined ? {} : { fetchArmTimeoutMs: options.fetchArmTimeoutMs }),
		...(options.fetchUnsupported === undefined ? {} : { fetchUnsupported: options.fetchUnsupported }),
	});
	const errors: BrowserErrorEvent[] = [];
	bus.on(BrowserErrorEvent, (event) => void errors.push(event), { wrap: null });
	await manager.start();
	if (options.proxy === true) manager.armProxyAuth();
	return {
		fixture,
		manager,
		errors,
		warnings,
		logged,
		async attach(waitingForDebugger = false) {
			if (waitingForDebugger) {
				fixture.script('Target.attachToTarget', (request, f) => {
					const sessionId = f.attachTarget(String(request.params.targetId), true);
					f.reply(request.id, { sessionId });
				});
			}
			const targetId = manager.mostRecentPageTarget()?.targetId ?? '';
			const session = await manager.getOrCreateCdpSession(targetId, true);
			await manager.whenIdle();
			return session.sessionId;
		},
		async attachType(type, waitingForDebugger = true) {
			const targetId = fixture.addPage(`https://ttk-target.test/${type}`, type);
			const sessionId = fixture.attachTarget(targetId, waitingForDebugger);
			await waitUntil(() => manager.sessions.has(sessionId), `the ${type} attach`);
			await client.send.Browser.getVersion();
			await manager.whenIdle();
			return sessionId;
		},
		paused(sessionId, params) {
			fixture.emit('Fetch.requestPaused', { frameId: 'F-main', resourceType: 'Document', ...params }, sessionId);
		},
		async settle() {
			await client.send.Browser.getVersion();
			await manager.whenIdle();
		},
		[Symbol.asyncDispose]: async () => {
			await manager.stop();
			await client.close();
			await bus.stop();
			await fixture.close();
		},
	};
}

const get = (url: string) => ({ url, method: 'GET', headers: {} });

Deno.test('E-94 (AC3): without a filter the attach path is the donor’s — no pause, no Fetch, no requestPaused answerer', async () => {
	await using h = await filterHarness({ filter: null });
	const sessionId = await h.attach();
	const autoAttach = h.fixture.requestsFor('Target.setAutoAttach').find((r) => r.sessionId === sessionId);
	assertEquals(autoAttach?.params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	assertEquals(h.fixture.requestsFor('Fetch.enable').length, 0);
	assertEquals(h.manager.filtersDocuments, false);
	// A stray pause (nothing enabled Fetch, so none should arrive) is answered by nothing at all.
	h.paused(sessionId, { requestId: 'STRAY', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').length, 0);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').length, 0);
});

Deno.test('E-94 (AC3): proxy credentials without a filter keep the donor’s Fetch.enable byte for byte', async () => {
	await using h = await filterHarness({ filter: null, proxy: true });
	const sessionId = await h.attach();
	const enabled = h.fixture.requestsFor('Fetch.enable');
	assertEquals(enabled.length, 1);
	assertEquals(enabled[0]?.params, { handleAuthRequests: true });
	// ...and every paused request is still released, now by the one shared answerer.
	h.paused(sessionId, { requestId: 'P1', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['P1']);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').length, 0);
	assertEquals(h.errors, []);
});

Deno.test('E-94 (M5), E-115: a filter pauses new targets and arms Document + Fetch before the resume', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach(true);
	const scoped = (method: string) => h.fixture.requestsFor(method).filter((r) => r.sessionId === sessionId);
	assertEquals(scoped('Target.setAutoAttach')[0]?.params, {
		autoAttach: true,
		waitForDebuggerOnStart: true,
		flatten: true,
	});
	const enabled = scoped('Fetch.enable');
	assertEquals(enabled.length, 1, 'one Fetch.enable per session: a second would replace the first');
	// ERRATUM(E-115): `Fetch` joins `Document` in the default scope — `<link rel=prefetch>` arrives as one (D-139).
	assertEquals(enabled[0]?.params, {
		patterns: [
			{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
			{ urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' },
		],
	});
	// The order measured on Chrome 154: Fetch first; the renderer-bound commands sent before the resume (awaiting
	// them first deadlocks a `noopener` pop-up, which has no renderer until it is resumed).
	const order = h.fixture.requests.filter((r) => r.sessionId === sessionId).map((r) => r.method);
	const at = (method: string) => order.indexOf(method);
	assert(at('Fetch.enable') >= 0 && at('Runtime.runIfWaitingForDebugger') >= 0, order.join(','));
	assert(at('Fetch.enable') < at('Page.enable'), order.join(','));
	assert(at('Page.enable') < at('Runtime.runIfWaitingForDebugger'), order.join(','));
	assert(at('Network.enable') < at('Runtime.runIfWaitingForDebugger'), order.join(','));
	assertEquals(h.manager.filtersDocuments, true);
});

Deno.test('E-94 (AC3): an on-list document continues, exactly once, with no block reported — no hang', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'OK1', request: get(ON_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params), [{ requestId: 'OK1' }]);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').length, 0);
	assertEquals(h.errors, []);
});

Deno.test('E-94: an off-list document is failed with Aborted before it is sent, and reported as one E0', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	const targetId = h.manager.sessionTargets.get(sessionId);
	h.paused(sessionId, { requestId: 'NO1', frameId: targetId, request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params), [
		{ requestId: 'NO1', errorReason: 'Aborted' },
	]);
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').length, 0, 'answered exactly once');
	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.errorType, 'NavigationBlocked');
	assertEquals(h.errors[0]?.details, {
		enforcementPoint: 'E0',
		url: OFF_LIST,
		targetId,
		frameId: targetId,
		containment: 'request-blocked',
		// Review R2-1 / R2-2: what was refused, and where its chain began (its own URL: no redirect before it).
		resourceType: 'Document',
		chainStart: OFF_LIST,
	});
	// E-78: the manager's own log line names the origin and nothing after it.
	const line = h.logged.find((entry) => entry.startsWith('document request refused'));
	assert(line !== undefined && line.includes('http://localhost:9090'), String(line));
	assert(!line.includes('exfiltrate') && !line.includes('Zq8-E0-CODE'), line);
});

Deno.test('E-94 (AC3): every redirect hop is judged on its own URL', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'HOP1', request: get(`${ON_LIST}/redirect`) });
	await h.settle();
	h.paused(sessionId, { requestId: 'HOP2', redirectedRequestId: 'HOP1', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['HOP1']);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['HOP2']);
	assertEquals(h.errors.map((e) => e.details.url), [OFF_LIST]);
	// Review R2-2: the refused hop names the URL its chain began at — the on-list request the tool made.
	assertEquals(h.errors.map((e) => e.details.chainStart), [`${ON_LIST}/redirect`]);
});

Deno.test('E-94 (AC3): a filter that throws fails the document closed', async () => {
	await using h = await filterHarness({
		filter: () => {
			throw new Error('matcher exploded');
		},
	});
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'BOOM', request: get(ON_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['BOOM']);
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').length, 0);
	assertEquals(h.errors[0]?.details.enforcementPoint, 'E0');
});

Deno.test('E-94 (AC3): with proxy credentials one Fetch.enable pauses everything, auth is answered, subresources pass', async () => {
	await using h = await filterHarness({ proxy: true });
	const sessionId = await h.attach();
	const enabled = h.fixture.requestsFor('Fetch.enable');
	assertEquals(enabled.length, 1);
	assertEquals(enabled[0]?.params, { patterns: [{ urlPattern: '*' }], handleAuthRequests: true });

	h.fixture.emit('Fetch.authRequired', {
		requestId: 'AUTH',
		request: { url: ON_LIST },
		frameId: 'F',
		resourceType: 'Document',
		authChallenge: { origin: 'http://127.0.0.1:3128', scheme: 'basic', realm: 'proxy', source: 'Proxy' },
	}, sessionId);
	// An off-list *script* is not a document: a navigation policy does not judge it, so it is released.
	h.paused(sessionId, { requestId: 'JS', resourceType: 'Script', request: get(OFF_LIST) });
	h.paused(sessionId, { requestId: 'DOC', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.continueWithAuth').length, 1);
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['JS']);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['DOC']);
});

Deno.test('E-94 (AC3): a failed Fetch.enable is logged at warn, by target type and without a URL', async () => {
	await using h = await filterHarness({ fetchEnableFails: true });
	await h.attach();
	const warning = h.warnings.find((entry) => entry.message.includes('document filter could not be armed'));
	assert(warning !== undefined, JSON.stringify(h.warnings));
	assertEquals(warning.fields?.targetType, 'page');
	assert(!JSON.stringify(warning).includes('127.0.0.1:8080'), JSON.stringify(warning));
	// The failure degrades containment to E2/E3; it does not fail the attach.
	assert(h.manager.sessions.size > 0);
});

Deno.test('E-94: only documents are judged — an off-list image passes the veto', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'IMG', resourceType: 'Image', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['IMG']);
	assertEquals(h.errors, []);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-94), review R2-1 / R2-2 — Prefetch judged fail-closed, chain starts, the main-frame commit check
// ---------------------------------------------------------------------------

Deno.test('R2-1: Fetch.enable never names Prefetch — Chrome 154 refuses the whole call for it', async () => {
	await using h = await filterHarness();
	await h.attach();
	const patterns = h.fixture.requestsFor('Fetch.enable').map((r) => JSON.stringify(r.params));
	assertEquals(patterns, [
		JSON.stringify({
			patterns: [
				{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
				{ urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' },
			],
		}),
	]);
	assert(!patterns.some((entry) => entry.includes('Prefetch')));
	assertEquals([...JUDGED_RESOURCE_TYPES], ['Document', 'Prefetch']);
});

Deno.test('R2-1: a Prefetch that reaches the answerer is judged like a document, fail closed', async () => {
	await using h = await filterHarness({ proxy: true });
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'PF-OFF', resourceType: 'Prefetch', request: get(OFF_LIST) });
	h.paused(sessionId, { requestId: 'PF-ON', resourceType: 'Prefetch', request: get(ON_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['PF-OFF']);
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['PF-ON']);
	assertEquals(h.errors.map((e) => e.details.resourceType), ['Prefetch']);
});

Deno.test('R2-2: a chain start survives every hop, and the memory of chains is bounded', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'C1', request: get(`${ON_LIST}/a`) });
	await h.settle();
	h.paused(sessionId, { requestId: 'C2', redirectedRequestId: 'C1', request: get(`${ON_LIST}/b`) });
	await h.settle();
	h.paused(sessionId, { requestId: 'C3', redirectedRequestId: 'C2', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.errors.map((e) => e.details.chainStart), [`${ON_LIST}/a`]);
	for (let index = 0; index < CHAIN_MEMORY_LIMIT + 8; index++) {
		h.paused(sessionId, { requestId: `M${index}`, request: get(`${ON_LIST}/${index}`) });
	}
	await h.settle();
	// The oldest chains were forgotten: a hop continuing one reads as its own start, never as someone else's.
	h.paused(sessionId, { requestId: 'LATE', redirectedRequestId: 'M0', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.errors.at(-1)?.details.chainStart, OFF_LIST);
});

/** What Chrome sends when a page target's frame commits a document. */
function committed(h: FilterHarness, sessionId: string, url: string, parentId?: string): void {
	const targetId = h.manager.sessionTargets.get(sessionId) ?? '';
	h.fixture.emit('Page.frameNavigated', {
		frame: {
			id: parentId === undefined ? targetId : 'F-child',
			...(parentId === undefined ? {} : { parentId }),
			loaderId: 'L1',
			url,
			securityOrigin: '',
			mimeType: 'text/html',
		},
		type: 'Navigation',
	}, sessionId);
}

Deno.test('R2-1: an off-list main-frame commit is parked on about:blank and reported once as E2 (trigger commit)', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	const targetId = h.manager.sessionTargets.get(sessionId);
	committed(h, sessionId, OFF_LIST);
	await h.settle();
	const parks = h.fixture.requestsFor('Page.navigate').filter((r) => r.sessionId === sessionId);
	assertEquals(parks.map((r) => r.params.url), ['about:blank']);
	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.details, {
		enforcementPoint: 'E2',
		url: OFF_LIST,
		targetId,
		containment: 'about:blank',
		trigger: 'commit',
	});
	assert(h.manager.parkedRecently(targetId ?? ''), 'remembered for the watchdog’s E2');
	// E-78: the manager's own line names the origin only.
	const line = h.logged.find((entry) => entry.startsWith('an off-list document committed'));
	assert(line !== undefined && line.includes('http://localhost:9090') && !line.includes('Zq8-E0-CODE'), String(line));
});

Deno.test('R2-1: the commit check leaves on-list pages, child frames and non-network documents alone', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	committed(h, sessionId, ON_LIST);
	committed(h, sessionId, OFF_LIST, 'PARENT');
	committed(h, sessionId, 'chrome-error://chromewebdata/');
	committed(h, sessionId, 'about:blank');
	committed(h, sessionId, 'data:text/html,hi');
	await h.settle();
	assertEquals(h.fixture.requestsFor('Page.navigate').length, 0);
	assertEquals(h.errors, []);
});

Deno.test('R2-1 (AC3): without a filter there is no commit check at all', async () => {
	await using h = await filterHarness({ filter: null });
	const sessionId = await h.attach();
	committed(h, sessionId, OFF_LIST);
	await h.settle();
	assertEquals(h.fixture.requestsFor('Page.navigate').length, 0);
	assertEquals(h.errors, []);
});

Deno.test('R2-1: a filter that throws parks the commit (fail closed)', async () => {
	await using h = await filterHarness({
		filter: () => {
			throw new Error('matcher exploded');
		},
	});
	const sessionId = await h.attach();
	committed(h, sessionId, ON_LIST);
	await h.settle();
	assertEquals(h.fixture.requestsFor('Page.navigate').map((r) => r.params.url), ['about:blank']);
	assertEquals(h.errors[0]?.details.enforcementPoint, 'E2');
});

// ---------------------------------------------------------------------------
// ERRATUM(E-114/E-115) — the request scope and hints (AC10, AC35)
// ---------------------------------------------------------------------------

const DOCUMENT_PATTERN = { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' };
const FETCH_PATTERN = { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' };
const STAR = { patterns: [{ urlPattern: '*', requestStage: 'Request' }] };
const PROXY_STAR = { patterns: [{ urlPattern: '*' }], handleAuthRequests: true };
/** Every target type Chrome 154 attached in the design probe, plus one a later Chrome might add. */
const OTHER_TYPES = ['other', 'service_worker', 'shared_worker', 'browser_ui', 'background_page', 'future_type'];
const METHOD_NOT_FOUND = { code: -32601, message: 'Fetch.enable was not found' };
const hint = (url: string, header = 'Sec-Purpose', value = 'prefetch') => ({
	url,
	method: 'GET',
	headers: { [header]: value },
});

/** The `Fetch.enable` parameters sent on one session, in order. */
function enabledOn(h: FilterHarness, sessionId: string): unknown[] {
	return h.fixture.requestsFor('Fetch.enable').filter((r) => r.sessionId === sessionId).map((r) => r.params);
}

Deno.test('E-114/E-115: requestKindOf — Sec-Purpose or Purpose prefetch* is a hint, then document, then subresource', () => {
	const kind = (resourceType: string, headers: Record<string, unknown> = {}) =>
		requestKindOf({ resourceType, request: { headers } });
	assertEquals(kind('Fetch', { 'Sec-Purpose': 'prefetch' }), 'hint');
	assertEquals(kind('Document', { 'sec-purpose': 'Prefetch;prerender' }), 'hint');
	assertEquals(kind('Fetch', { Purpose: 'prefetch' }), 'hint', 'the legacy header');
	assertEquals(kind('Document'), 'document');
	assertEquals(kind('Prefetch'), 'document');
	assertEquals(kind('Image', { 'Sec-Purpose': 'something-else' }), 'subresource');
	assertEquals(kind('XHR'), 'subresource');
	assertEquals(kind('Script', { 'Sec-Purpose': 42 }), 'subresource', 'a non-string header is no header');
	assertEquals(requestKindOf({ resourceType: 'Document', request: {} }), 'document');
});

Deno.test('E-114 (AC10/AC3): requestScope all without a filter is inert — the donor attach path, byte for byte', async () => {
	await using h = await filterHarness({ filter: null, scope: 'all' });
	const sessionId = await h.attach();
	const worker = await h.attachType('service_worker', false);
	assertEquals(h.fixture.requestsFor('Fetch.enable').length, 0);
	assertEquals(
		h.fixture.requestsFor('Target.setAutoAttach').filter((r) => r.sessionId === sessionId)[0]?.params,
		{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
	);
	assertEquals(h.manager.requestScope, 'documents');
	h.paused(worker, { requestId: 'STRAY', resourceType: 'Image', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').length, 0);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').length, 0);
});

Deno.test('E-114/E-115 (AC10): documents scope — Document+Fetch on pages/iframes, Document on other, nothing else', async () => {
	await using h = await filterHarness();
	assertEquals(enabledOn(h, await h.attach()), [{ patterns: [DOCUMENT_PATTERN, FETCH_PATTERN] }]);
	assertEquals(enabledOn(h, await h.attachType('iframe')), [{ patterns: [DOCUMENT_PATTERN, FETCH_PATTERN] }]);
	assertEquals(enabledOn(h, await h.attachType('other')), [{ patterns: [DOCUMENT_PATTERN] }]);
	for (const type of ['service_worker', 'shared_worker', 'browser_ui', 'background_page', 'future_type', 'worker']) {
		const sessionId = await h.attachType(type);
		assertEquals(enabledOn(h, sessionId), [], `${type} is not armed in documents`);
		const resumed = h.fixture.requestsFor('Runtime.runIfWaitingForDebugger').some((r) => r.sessionId === sessionId);
		assert(resumed, `${type} is still resumed`);
	}
	assertEquals(h.manager.requestScope, 'documents');
});

Deno.test('E-114 (AC10, F10): all scope — * on every type but worker, unknown types included, armed before resume', async () => {
	await using h = await filterHarness({ scope: 'all' });
	assertEquals(enabledOn(h, await h.attach()), [STAR]);
	for (const type of ['iframe', ...OTHER_TYPES]) {
		const sessionId = await h.attachType(type);
		assertEquals(enabledOn(h, sessionId), [STAR], `${type} armed with *`);
		const order = h.fixture.requests.filter((r) => r.sessionId === sessionId).map((r) => r.method);
		assert(order.indexOf('Fetch.enable') < order.indexOf('Runtime.runIfWaitingForDebugger'), `${type}: ${order}`);
	}
	const worker = await h.attachType('worker');
	assertEquals(enabledOn(h, worker), [], 'a dedicated worker is never armed (its requests pause on the page)');
	assert(h.fixture.requestsFor('Runtime.runIfWaitingForDebugger').some((r) => r.sessionId === worker));
	assertEquals(h.manager.requestScope, 'all');
});

for (const scope of ['documents', 'all'] as const) {
	Deno.test(`E-114 (AC10, AC35): proxy credentials in ${scope} — * plus auth on every armed type, one answerer`, async () => {
		await using h = await filterHarness({ scope, proxy: true });
		const page = await h.attach();
		assertEquals(enabledOn(h, page), [PROXY_STAR]);
		assertEquals(enabledOn(h, await h.attachType('other')), [PROXY_STAR]);
		const sw = await h.attachType('service_worker');
		assertEquals(enabledOn(h, sw), scope === 'all' ? [PROXY_STAR] : []);
		assertEquals(enabledOn(h, await h.attachType('worker')), []);

		h.fixture.emit('Fetch.authRequired', {
			requestId: 'AUTH',
			request: { url: ON_LIST },
			frameId: 'F',
			resourceType: 'Image',
			authChallenge: { origin: 'http://127.0.0.1:3128', scheme: 'basic', realm: 'proxy', source: 'Proxy' },
		}, page);
		const ids = ['IMG-OFF', 'IMG-ON', 'DOC-OFF', 'HINT-OFF'];
		h.paused(page, { requestId: 'IMG-OFF', resourceType: 'Image', request: get(OFF_LIST) });
		h.paused(page, { requestId: 'IMG-ON', resourceType: 'Image', request: get(ON_LIST) });
		h.paused(page, { requestId: 'DOC-OFF', request: get(OFF_LIST) });
		h.paused(page, { requestId: 'HINT-OFF', resourceType: 'Fetch', request: hint(OFF_LIST) });
		await h.settle();
		assertEquals(h.fixture.requestsFor('Fetch.continueWithAuth').length, 1, 'auth answered once');
		const failed = h.fixture.requestsFor('Fetch.failRequest').map((r) => String(r.params.requestId));
		const continued = h.fixture.requestsFor('Fetch.continueRequest').map((r) => String(r.params.requestId));
		assertEquals([...failed, ...continued].sort(), [...ids].sort(), 'every paused request answered exactly once');
		assertEquals(failed.sort(), scope === 'all' ? ['DOC-OFF', 'HINT-OFF', 'IMG-OFF'] : ['DOC-OFF', 'HINT-OFF']);
	});
}

Deno.test('E-115 (AC10): in documents a hint is refused with BlockedByClient while an XHR to the same host continues', async () => {
	await using h = await filterHarness();
	const sessionId = await h.attach();
	const targetId = h.manager.sessionTargets.get(sessionId);
	h.paused(sessionId, { requestId: 'PF', resourceType: 'Fetch', request: hint(OFF_LIST) });
	h.paused(sessionId, { requestId: 'PF-LEGACY', resourceType: 'Fetch', request: hint(`${OFF_LIST}/b`, 'Purpose') });
	h.paused(sessionId, { requestId: 'PF-ON', resourceType: 'Fetch', request: hint(ON_LIST) });
	h.paused(sessionId, { requestId: 'XHR', resourceType: 'XHR', request: get(OFF_LIST) });
	h.paused(sessionId, { requestId: 'IMG', resourceType: 'Image', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params), [
		{ requestId: 'PF', errorReason: SUBRESOURCE_BLOCK_ERROR_REASON },
		{ requestId: 'PF-LEGACY', errorReason: SUBRESOURCE_BLOCK_ERROR_REASON },
	]);
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['PF-ON', 'XHR', 'IMG']);
	// One origin, one report — the second hint to the same origin is only counted.
	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.details, {
		enforcementPoint: 'E0',
		containment: 'request-blocked',
		requestKind: 'hint',
		url: OFF_LIST,
		targetId,
		targetType: 'page',
		frameId: 'F-main',
		resourceType: 'Fetch',
	});
	assertEquals(h.manager.requestRefusals.get('page'), 2);
	// E-78: the manager's log line names the origin only.
	const line = h.logged.find((entry) => entry.startsWith('request refused before it was sent'));
	assert(line !== undefined && line.includes('http://localhost:9090') && !line.includes('Zq8-E0-CODE'), String(line));
});

Deno.test('E-115: the prerender host (other) — its hint Document is refused with Aborted, counted, never an event', async () => {
	await using h = await filterHarness();
	const other = await h.attachType('other');
	h.paused(other, {
		requestId: 'NSP',
		resourceType: 'Document',
		request: hint(OFF_LIST, 'Sec-Purpose', 'prefetch;prerender'),
	});
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params), [
		{ requestId: 'NSP', errorReason: 'Aborted' },
	]);
	assertEquals(h.errors, [], 'review N4: no per-session event for a non-page target');
	assertEquals(h.manager.requestRefusals.get('other'), 1);
	assert(h.logged.some((entry) => entry.startsWith('request refused before it was sent')), 'a debug line');
});

for (const scope of ['documents', 'all'] as const) {
	Deno.test(`E-114 (AC10): an off-list subresource in ${scope}`, async () => {
		await using h = await filterHarness({ scope });
		const sessionId = await h.attach();
		h.paused(sessionId, { requestId: 'IMG', resourceType: 'Image', request: get(OFF_LIST) });
		h.paused(sessionId, { requestId: 'BEACON', resourceType: 'Ping', request: get('http://ttk-off.test/beacon') });
		h.paused(sessionId, { requestId: 'OK', resourceType: 'Script', request: get(`${ON_LIST}/app.js`) });
		await h.settle();
		const failed = h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params);
		if (scope === 'all') {
			assertEquals(failed, [
				{ requestId: 'IMG', errorReason: 'BlockedByClient' },
				{ requestId: 'BEACON', errorReason: 'BlockedByClient' },
			]);
			assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), ['OK']);
			assertEquals(h.errors.map((e) => [e.details.requestKind, e.details.resourceType]), [
				['subresource', 'Image'],
				['subresource', 'Ping'],
			]);
		} else {
			assertEquals(failed, [], 'continued in documents (unchanged)');
			assertEquals(h.fixture.requestsFor('Fetch.continueRequest').length, 3);
			assertEquals(h.errors, []);
		}
	});
}

Deno.test('E-114 (AC10): in all a document is still Aborted, judged as before, and reported without requestKind', async () => {
	await using h = await filterHarness({ scope: 'all' });
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'DOC', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params), [
		{ requestId: 'DOC', errorReason: 'Aborted' },
	]);
	assertEquals(h.errors.length, 1);
	assertEquals(h.errors[0]?.details.requestKind, undefined, 'a document report is the E-94 report, unchanged');
	assertEquals(h.errors[0]?.details.chainStart, OFF_LIST);
});

Deno.test('E-114 (AC10): a throwing filter fails every judged kind closed', async () => {
	await using h = await filterHarness({
		scope: 'all',
		filter: () => {
			throw new Error('matcher exploded');
		},
	});
	const sessionId = await h.attach();
	h.paused(sessionId, { requestId: 'IMG', resourceType: 'Image', request: get(ON_LIST) });
	h.paused(sessionId, { requestId: 'PF', resourceType: 'Fetch', request: hint(ON_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['IMG', 'PF']);
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').length, 0);
});

Deno.test('E-114 (AC10): only network schemes are judged; ws/wss are judged as http/https', async () => {
	const seen: string[] = [];
	await using h = await filterHarness({
		scope: 'all',
		filter: (url) => {
			seen.push(url);
			return loopbackOnly(url);
		},
	});
	const sessionId = await h.attach();
	const requests: Array<[string, string]> = [
		['DATA', 'data:text/plain,hi'],
		['BLOB', 'blob:http://127.0.0.1:8080/0f1e'],
		['EXT', 'chrome-extension://abcdefghijklmnop/background.js'],
		['CHROME', 'chrome://omnibox-popup.top-chrome/x.js'],
		['WS-ON', 'ws://127.0.0.1:8080/socket'],
		['WSS-OFF', 'wss://localhost:9090/socket?code=Zq8'],
	];
	for (const [requestId, url] of requests) {
		h.paused(sessionId, { requestId, resourceType: 'Other', request: get(url) });
	}
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['WSS-OFF']);
	assertEquals(h.fixture.requestsFor('Fetch.continueRequest').map((r) => r.params.requestId), [
		'DATA',
		'BLOB',
		'EXT',
		'CHROME',
		'WS-ON',
	]);
	// The filter only ever saw http(s): the two WebSocket URLs, rewritten.
	assertEquals(seen.slice(-2), ['http://127.0.0.1:8080/socket', 'https://localhost:9090/socket?code=Zq8']);
});

Deno.test('E-114 (AC10): 100 refusals of one origin are one event', async () => {
	await using h = await filterHarness({ scope: 'all' });
	const sessionId = await h.attach();
	for (let index = 0; index < 100; index++) {
		h.paused(sessionId, { requestId: `R${index}`, resourceType: 'Image', request: get(`${OFF_LIST}&n=${index}`) });
	}
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').length, 100, 'every request is refused');
	assertEquals(h.errors.length, 1, 'one origin, one report');
	assertEquals(h.manager.requestRefusals.get('page'), 100);
});

Deno.test('E-114 (AC10): 40 origins are 32 reports plus one overflow, and a commit starts afresh', async () => {
	await using h = await filterHarness({ scope: 'all' });
	const sessionId = await h.attach();
	const targetId = h.manager.sessionTargets.get(sessionId) ?? '';
	const origin = (index: number) => `http://off-${index}.test/pixel.png`;
	for (let index = 0; index < 40; index++) {
		h.paused(sessionId, { requestId: `O${index}`, resourceType: 'Image', request: get(origin(index)) });
	}
	await h.settle();
	assertEquals(REQUEST_BLOCK_ORIGIN_LIMIT, 32);
	assertEquals(h.errors.length, REQUEST_BLOCK_ORIGIN_LIMIT + 1);
	assertEquals(h.errors.filter((e) => e.details.overflow === true).map((e) => e.details.url), [origin(32)]);
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').length, 40, 'refused all the same');

	// A child frame's commit is not the tab's new document...
	h.fixture.emit('Page.frameNavigated', {
		frame: {
			id: 'F-child',
			parentId: targetId,
			loaderId: 'L',
			url: ON_LIST,
			securityOrigin: '',
			mimeType: 'text/html',
		},
		type: 'Navigation',
	}, sessionId);
	await h.settle();
	h.paused(sessionId, { requestId: 'AGAIN0', resourceType: 'Image', request: get(origin(0)) });
	await h.settle();
	assertEquals(h.errors.length, REQUEST_BLOCK_ORIGIN_LIMIT + 1);
	// ...the main frame's is: the next document reports its own first refusals.
	h.fixture.emit('Page.frameNavigated', {
		frame: { id: targetId, loaderId: 'L2', url: ON_LIST, securityOrigin: '', mimeType: 'text/html' },
		type: 'Navigation',
	}, sessionId);
	await h.settle();
	h.paused(sessionId, { requestId: 'NEW0', resourceType: 'Image', request: get(origin(0)) });
	await h.settle();
	assertEquals(h.errors.length, REQUEST_BLOCK_ORIGIN_LIMIT + 2);
	assertEquals(h.errors.at(-1)?.details.overflow, undefined);
});

Deno.test('E-114: refused origins are remembered for at most REQUEST_BLOCK_TARGET_LIMIT targets, oldest first', async () => {
	assertEquals(REQUEST_BLOCK_TARGET_LIMIT, 64);
	await using h = await filterHarness({ scope: 'all' });
	const first = await h.attach();
	h.paused(first, { requestId: 'FIRST', resourceType: 'Image', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.errors.length, 1);
	// 64 more iframe targets, each refusing once: the first target's memory is the oldest, and is forgotten.
	for (let index = 0; index < REQUEST_BLOCK_TARGET_LIMIT; index++) {
		const frame = await h.attachType('iframe', false);
		h.paused(frame, { requestId: `F${index}`, resourceType: 'Image', request: get(OFF_LIST) });
	}
	await h.settle();
	assertEquals(h.errors.length, 1 + REQUEST_BLOCK_TARGET_LIMIT);
	h.paused(first, { requestId: 'FIRST-AGAIN', resourceType: 'Image', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.errors.length, 2 + REQUEST_BLOCK_TARGET_LIMIT, 'a forgotten target reports its origin again');
});

Deno.test('E-114 (N4): a refusal on a service worker or background_page target is counted and logged, never an event', async () => {
	await using h = await filterHarness({ scope: 'all' });
	const sw = await h.attachType('service_worker');
	const ui = await h.attachType('background_page');
	h.paused(sw, { requestId: 'SW', resourceType: 'XHR', request: get(OFF_LIST) });
	h.paused(ui, { requestId: 'UI', resourceType: 'XHR', request: get('https://update.googleapis.com/service/update2') });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params.requestId), ['SW', 'UI']);
	assertEquals(h.errors, []);
	assertEquals(h.manager.requestRefusals.get('service_worker'), 1);
	assertEquals(h.manager.requestRefusals.get('background_page'), 1);
});

Deno.test('E-114 (F10): an arming failure on an unknown type is a warn naming the type', async () => {
	await using h = await filterHarness({ scope: 'all' });
	h.fixture.script('Fetch.enable', (request, f) => f.replyError(request.id, METHOD_NOT_FOUND));
	const sessionId = await h.attachType('future_type');
	const warning = h.warnings.find((entry) => entry.message.includes('request filter could not be armed'));
	assert(warning !== undefined, JSON.stringify(h.warnings));
	assertEquals(warning.fields?.targetType, 'future_type');
	assert(h.fixture.requestsFor('Runtime.runIfWaitingForDebugger').some((r) => r.sessionId === sessionId));
	assertEquals([...FETCH_UNSUPPORTED], [], 'MB3: every type Chrome 154 attaches but worker accepts Fetch');
});

Deno.test('E-114: a -32601 on a type measured to refuse Fetch is debug, not warn', async () => {
	await using h = await filterHarness({ scope: 'all', fetchUnsupported: new Set(['future_type']) });
	h.fixture.script('Fetch.enable', (request, f) => f.replyError(request.id, METHOD_NOT_FOUND));
	await h.attachType('future_type');
	assertEquals(h.warnings, []);
	assert(h.logged.some((entry) => entry.startsWith('Fetch is unavailable on this target type')), h.logged.join('\n'));
});

Deno.test('E-114 (N4): an arming that never answers is bounded, and the target is resumed anyway', async () => {
	await using h = await filterHarness({ scope: 'all', fetchArmTimeoutMs: 50 });
	h.fixture.script('Fetch.enable', () => {/* never answered */});
	const started = Date.now();
	const sessionId = await h.attachType('browser_ui');
	assert(h.fixture.requestsFor('Runtime.runIfWaitingForDebugger').some((r) => r.sessionId === sessionId));
	assertLess(Date.now() - started, FETCH_ARM_TIMEOUT_MS, 'the injected bound, not the default, applied');
	const warning = h.warnings.find((entry) => entry.message.includes('request filter could not be armed'));
	assertEquals(warning?.fields, { targetType: 'browser_ui', error: 'no answer within 50 ms' });
});

Deno.test('E-114 (N4): a refused document on a non-page target is counted, never an event', async () => {
	await using h = await filterHarness({ scope: 'all' });
	const other = await h.attachType('other');
	h.paused(other, { requestId: 'DOC', request: get(OFF_LIST) });
	await h.settle();
	assertEquals(h.fixture.requestsFor('Fetch.failRequest').map((r) => r.params), [
		{ requestId: 'DOC', errorReason: 'Aborted' },
	]);
	assertEquals(h.errors, []);
	assertEquals(h.manager.requestRefusals.get('other'), 1);
});
