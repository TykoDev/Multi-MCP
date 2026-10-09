/**
 * Navigation readiness contract tests (ARCHITECTURE.md §7.5; COMPLETIONS-CRITERIA.md §3.2
 * "Navigation readiness" row): the `commit` path, the same-document (no `loaderId`) path, the
 * lifecycle poll with its loaderId staleness rules, and the **non-fatal** readiness timeout with its
 * `loadingStatus` payload and 3 s / 8 s heuristic.
 *
 * The readiness budget is exercised through the injected clock rather than by sleeping: the loop's
 * only time source is `options.now`, so a stepping clock proves the deadline arithmetic in zero
 * wall-clock milliseconds.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { delay } from '@std/async';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { BrowserError } from '../errors.ts';
import {
	ACCEPTABLE_LIFECYCLE_EVENTS,
	formatLoadingStatus,
	isFreshFor,
	isSameDomain,
	LIFECYCLE_POLL_INTERVAL_MS,
	NAVIGATE_TRANSITION_TYPE,
	navigateAndWait,
	READINESS_TIMEOUT_CROSS_DOMAIN_MS,
	READINESS_TIMEOUT_SAME_DOMAIN_MS,
	resolveReadinessTimeoutMs,
} from './navigation.ts';
import type { LifecycleRecord } from './session_manager.ts';
import { SessionManager } from './session_manager.ts';
import { ChromeFixture, type NavigatePlan } from './cdp_fixture_test.ts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface NavHarness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly manager: SessionManager;
	readonly targetId: string;
	readonly sessionId: string;
}

async function navHarness(plan?: NavigatePlan, startUrl = 'https://127.0.0.1/start'): Promise<NavHarness> {
	const fixture = ChromeFixture.start({ pages: [startUrl], ...(plan === undefined ? {} : { navigate: plan }) });
	const bus = new EventBus({ name: 'nav', logger: silentBusLogger });
	const client = await CdpClient.connect(fixture.wsUrl);
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	const targetId = manager.mostRecentPageTarget()?.targetId ?? '';
	const session = await manager.getOrCreateCdpSession(targetId, true);
	return {
		fixture,
		manager,
		targetId,
		sessionId: session.sessionId,
		[Symbol.asyncDispose]: async () => {
			await manager.stop();
			await client.close();
			await bus.stop();
			await fixture.close();
		},
	};
}

/** A clock that returns each step in turn and then repeats the last one. */
function steppingClock(steps: readonly number[]): () => number {
	let index = 0;
	return () => {
		const value = steps[Math.min(index, steps.length - 1)] ?? 0;
		index += 1;
		return value;
	};
}

function record(name: string, loaderId: string | null, receivedAt: number): LifecycleRecord {
	return { name, loaderId, frameId: 'F', timestamp: 1, receivedAt };
}

// ---------------------------------------------------------------------------
// constants (the R2 audit surface)
// ---------------------------------------------------------------------------

Deno.test('ARCHITECTURE §7.5/§8 navigation constants are encoded verbatim', () => {
	assertEquals(LIFECYCLE_POLL_INTERVAL_MS, 50);
	assertEquals(READINESS_TIMEOUT_SAME_DOMAIN_MS, 3_000);
	assertEquals(READINESS_TIMEOUT_CROSS_DOMAIN_MS, 8_000);
	assertEquals(NAVIGATE_TRANSITION_TYPE, 'address_bar');
});

Deno.test('the acceptance table matches §7.5 step 4 exactly', () => {
	// networkIdle always counts; load counts for load/domcontentloaded; DOMContentLoaded for
	// domcontentloaded only.
	assertEquals(ACCEPTABLE_LIFECYCLE_EVENTS.networkidle, ['networkIdle']);
	assertEquals(ACCEPTABLE_LIFECYCLE_EVENTS.load, ['load', 'networkIdle']);
	assertEquals(ACCEPTABLE_LIFECYCLE_EVENTS.domcontentloaded, ['DOMContentLoaded', 'load', 'networkIdle']);
	assertEquals(ACCEPTABLE_LIFECYCLE_EVENTS.commit, []);
	for (const level of ['load', 'domcontentloaded', 'networkidle'] as const) {
		assert(ACCEPTABLE_LIFECYCLE_EVENTS[level].includes('networkIdle'));
	}
	assert(!ACCEPTABLE_LIFECYCLE_EVENTS.load.includes('DOMContentLoaded'));
});

// ---------------------------------------------------------------------------
// step 5 heuristic + staleness, as pure functions
// ---------------------------------------------------------------------------

Deno.test('readiness budget: explicit wins, else 3 s same-domain / 8 s cross-domain', () => {
	assertEquals(resolveReadinessTimeoutMs(1_234, 'https://127.0.0.1/a', 'https://127.0.0.1/b'), 1_234);
	assertEquals(
		resolveReadinessTimeoutMs(null, 'https://127.0.0.1/a', 'https://127.0.0.1/b'),
		READINESS_TIMEOUT_SAME_DOMAIN_MS,
	);
	assertEquals(
		resolveReadinessTimeoutMs(null, 'https://127.0.0.1/a', 'https://localhost/b'),
		READINESS_TIMEOUT_CROSS_DOMAIN_MS,
	);
	// Unknown origin ⇒ the longer, safer budget.
	assertEquals(resolveReadinessTimeoutMs(null, null, 'https://127.0.0.1/b'), READINESS_TIMEOUT_CROSS_DOMAIN_MS);
	// A nonsensical explicit value falls back to the heuristic rather than making the wait instant.
	assertEquals(resolveReadinessTimeoutMs(0, 'https://127.0.0.1/a', 'https://127.0.0.1/b'), 3_000);
});

Deno.test('same-domain comparison parses, never string-matches', () => {
	assert(isSameDomain('https://127.0.0.1/a', 'https://127.0.0.1:8080/b'));
	assert(!isSameDomain('https://127.0.0.1/a', 'https://localhost/b'));
	assert(!isSameDomain('not a url', 'https://127.0.0.1/b'));
	assert(!isSameDomain('about:blank', 'https://127.0.0.1/b'));
	// Userinfo must not smuggle a host past the check.
	assert(!isSameDomain('https://127.0.0.1/a', 'https://127.0.0.1@localhost/b'));
});

Deno.test('staleness: other loaderIds ignored; loaderId-less events only count after nav start', () => {
	assert(isFreshFor(record('load', 'L1', 0), 'L1', 1_000));
	assert(!isFreshFor(record('load', 'L0', 5_000), 'L1', 1_000));
	assert(!isFreshFor(record('load', null, 999), 'L1', 1_000));
	assert(isFreshFor(record('load', null, 1_000), 'L1', 1_000));
	assert(isFreshFor(record('load', null, 1_001), 'L1', 1_000));
});

Deno.test('loadingStatus carries the budget, the level and what was seen', () => {
	assertEquals(
		formatLoadingStatus(3_000, 'load', ['init', 'DOMContentLoaded']),
		'timeout after 3s waiting for load (saw: init, DOMContentLoaded)',
	);
	assertEquals(
		formatLoadingStatus(8_000, 'networkidle', []),
		'timeout after 8s waiting for networkidle (saw: nothing)',
	);
	assertEquals(formatLoadingStatus(1_500, 'domcontentloaded', ['load']).startsWith('timeout after 1.5s'), true);
});

// ---------------------------------------------------------------------------
// steps 1–3
// ---------------------------------------------------------------------------

Deno.test('step 1: Page.navigate is issued with transitionType address_bar', async () => {
	await using h = await navHarness();
	await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next');
	const navigated = h.fixture.requestsFor('Page.navigate')[0];
	assertEquals(navigated?.params.transitionType, 'address_bar');
	assertEquals(navigated?.params.url, 'https://127.0.0.1/next');
	assertEquals(navigated?.sessionId, h.sessionId);
});

Deno.test('step 1: a CDP errorText is a hard error', async () => {
	await using h = await navHarness({ errorText: 'net::ERR_NAME_NOT_RESOLVED' });
	await assertRejects(
		() => navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/dead'),
		BrowserError,
		'net::ERR_NAME_NOT_RESOLVED',
	);
});

Deno.test("step 2: waitUntil 'commit' returns as soon as navigate returns", async () => {
	await using h = await navHarness({ lifecycle: [] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
		waitUntil: 'commit',
		// A clock that has already blown the budget: 'commit' must never consult it.
		now: steppingClock([0, 999_999]),
	});
	assertEquals(result.resolution, 'commit');
	assertEquals(result.loadingStatus, null);
	assertEquals(result.waitedMs, 0);
});

Deno.test('step 3: no loaderId ⇒ same-document navigation, done immediately', async () => {
	await using h = await navHarness({ loaderId: null, lifecycle: [] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/start#frag', {
		waitUntil: 'load',
		now: steppingClock([0, 999_999]),
	});
	assertEquals(result.resolution, 'same-document');
	assertEquals(result.sameDocument, true);
	assertEquals(result.loaderId, null);
	assertEquals(result.loadingStatus, null);
});

// ---------------------------------------------------------------------------
// step 4 — the lifecycle poll
// ---------------------------------------------------------------------------

Deno.test("step 4: 'load' satisfies waitUntil load", async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: ['init', 'DOMContentLoaded', 'load'] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
		waitUntil: 'load',
	});
	assertEquals(result.resolution, 'lifecycle');
	assertEquals(result.loaderId, 'L1');
	assertEquals(result.loadingStatus, null);
	assert(result.observed.includes('load'));
});

Deno.test("step 4: 'DOMContentLoaded' does NOT satisfy waitUntil load", async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: ['init', 'DOMContentLoaded'] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
		waitUntil: 'load',
		now: steppingClock([0, 0, 10_000]),
	});
	assertEquals(result.resolution, 'timeout');
	assertEquals(result.observed, ['init', 'DOMContentLoaded']);
});

Deno.test("step 4: 'networkIdle' always counts, including for waitUntil load", async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: ['networkIdle'] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
		waitUntil: 'load',
	});
	assertEquals(result.resolution, 'lifecycle');
});

Deno.test('step 4: an event that arrives after the first scan is picked up by the poll', async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: [] });
	const navigation = navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
		waitUntil: 'load',
	});
	// Nothing was buffered when the loop first scanned; the 50 ms poll must find this one.
	await delay(1);
	h.fixture.emitLifecycle(h.targetId, 'load', 'L1');
	const result = await navigation;
	assertEquals(result.resolution, 'lifecycle');
	assert(result.waitedMs >= 0);
});

Deno.test('step 4: a lifecycle event from a different loaderId is ignored', async () => {
	await using h = await navHarness({ loaderId: 'L2', lifecycle: [] });
	// Buffer a `load` belonging to an older navigation before this one starts.
	h.fixture.emitLifecycle(h.targetId, 'load', 'L-STALE');
	await delay(20);
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
		waitUntil: 'load',
		now: steppingClock([0, 0, 10_000]),
	});
	assertEquals(result.resolution, 'timeout');
	assertEquals(result.observed, []);
	assertEquals(result.loadingStatus, 'timeout after 8s waiting for load (saw: nothing)');
});

// ---------------------------------------------------------------------------
// step 5 — the non-fatal timeout
// ---------------------------------------------------------------------------

Deno.test('step 5: a readiness timeout SUCCEEDS carrying loadingStatus', async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: ['init'] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/slow', {
		waitUntil: 'networkidle',
		// same-domain start ⇒ the 3 s budget; the clock jumps past it on the second read.
		fromUrl: 'https://127.0.0.1/start',
		now: steppingClock([0, 0, 3_001, 3_001]),
	});
	assertEquals(result.resolution, 'timeout');
	assertEquals(result.loadingStatus, 'timeout after 3s waiting for networkidle (saw: init)');
	assertEquals(result.sameDocument, false);
	assertEquals(result.loaderId, 'L1');
});

Deno.test('step 5: the cross-domain budget is used when the origin changes', async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: [] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://localhost/elsewhere', {
		waitUntil: 'load',
		fromUrl: 'https://127.0.0.1/start',
		now: steppingClock([0, 0, 8_001, 8_001]),
	});
	assertEquals(result.loadingStatus, 'timeout after 8s waiting for load (saw: nothing)');
});

Deno.test('step 5: an explicit timeoutMs overrides the heuristic', async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: [] });
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/slow', {
		waitUntil: 'load',
		timeoutMs: 500,
		fromUrl: 'https://127.0.0.1/start',
		now: steppingClock([0, 0, 501, 501]),
	});
	assertEquals(result.loadingStatus, 'timeout after 0.5s waiting for load (saw: nothing)');
});

// ---------------------------------------------------------------------------
// cancellation — ERRATUM(E-62)
// ---------------------------------------------------------------------------

Deno.test('E-62: an already-abandoned caller never issues Page.navigate at all', async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: [] });
	const before = h.fixture.requestsFor('Page.navigate').length;
	const error = await assertRejects(() =>
		navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
			signal: AbortSignal.abort(new Error('budget blown')),
		})
	);
	assertEquals((error as Error).message, 'budget blown', 'the entry gate throws the abort reason itself');
	assertEquals(
		h.fixture.requestsFor('Page.navigate').length,
		before,
		'refusing to start is the whole of step 1 cancellation',
	);
});

Deno.test('E-62: the readiness wait is abandoned early and reports the time it actually waited', async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: [] });
	const controller = new AbortController();
	const startedAt = performance.now();
	// No lifecycle will ever arrive, and the cross-domain heuristic gives this wait 8 s of budget it
	// must not spend.
	const navigation = navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://localhost/elsewhere', {
		waitUntil: 'load',
		fromUrl: 'https://127.0.0.1/start',
		signal: controller.signal,
	});
	await delay(20);
	controller.abort(new Error('budget blown'));
	const result = await navigation;
	const elapsed = performance.now() - startedAt;

	assertEquals(result.resolution, 'abandoned', 'an abandoned wait is a result, never a rejection');
	assert(
		result.loadingStatus?.startsWith('abandoned after') === true,
		`expected an 'abandoned after …' status, got ${result.loadingStatus}`,
	);
	assert(
		result.loadingStatus?.includes('waiting for load') === true,
		'the status still names the readiness level that was not reached',
	);
	assert(
		!result.loadingStatus?.includes('8s'),
		`the status must report the time waited, not the budget: ${result.loadingStatus}`,
	);
	assert(elapsed < READINESS_TIMEOUT_CROSS_DOMAIN_MS, `the 8 s budget must not be spent; waited ${elapsed}ms`);
	assert(result.waitedMs < READINESS_TIMEOUT_CROSS_DOMAIN_MS);
});

Deno.test('E-62: a signal aborting after Page.navigate is on the wire does not fail the navigation', async () => {
	await using h = await navHarness({ loaderId: 'L1', lifecycle: ['load'] });
	const controller = new AbortController();
	// Aborts one microtask in — the navigate command has been composed and sent, and the lifecycle
	// that satisfies `waitUntil` is already buffered. Binding the signal to step 1 would turn this
	// completed navigation into a rejection; not binding it is what keeps the result honest.
	queueMicrotask(() => controller.abort(new Error('budget blown')));
	const result = await navigateAndWait(h.manager, h.targetId, h.sessionId, 'https://127.0.0.1/next', {
		waitUntil: 'load',
		signal: controller.signal,
	});
	assert(
		result.resolution === 'lifecycle' || result.resolution === 'abandoned',
		`a sent navigation must still produce a result, got ${result.resolution}`,
	);
	assertEquals(h.fixture.requestsFor('Page.navigate').length, 1, 'the navigation really was issued');
});
