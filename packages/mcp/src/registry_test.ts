import { assert, assertEquals, assertRejects } from '@std/assert';
import type { BrowserSession } from '@tykotech/browser';
import { BrowserErrorEvent, NavigationCompleteEvent, ReconnectController, TargetCrashedEvent } from '@tykotech/browser';
import { FakeTime } from '@std/testing/time';
import { silentBusLogger } from '@tykotech/bus';
import { EventBus } from '@tykotech/bus';
import { ToolError } from './errors.ts';
import { DEFAULT_SESSION_ID, type LiveViewerHandle, type RegistryChange, SessionRegistry } from './registry.ts';

/**
 * A stand-in for a started browser session: only what the registry touches.
 *
 * The event bus is a **real** one rather than a stub. The registry subscribes to
 * it to announce page changes (R4), and a fake that answered those calls with
 * nothing would let a broken subscription pass here and fail only in the
 * browser tier.
 */
function fakeSession(): BrowserSession & { stopped: boolean; eventBus: EventBus } {
	const session = {
		stopped: false,
		tabs: [] as unknown[],
		cachedBrowserState: null,
		eventBus: new EventBus({ name: 'fake-session' }),
		stop() {
			session.stopped = true;
			return Promise.resolve();
		},
		kill() {
			session.stopped = true;
			return Promise.resolve();
		},
	};
	return session as unknown as BrowserSession & { stopped: boolean; eventBus: EventBus };
}

interface Harness {
	registry: SessionRegistry;
	launched: string[];
	sessions: Map<string, ReturnType<typeof fakeSession>>;
	setNow(ms: number): void;
}

function harness(options: { maxSessions?: number; sessionTtlMs?: number; launchDelayMs?: number } = {}): Harness {
	const launched: string[] = [];
	const sessions = new Map<string, ReturnType<typeof fakeSession>>();
	let now = 1_000;
	const registry = new SessionRegistry({
		maxSessions: options.maxSessions ?? 8,
		sessionTtlMs: options.sessionTtlMs ?? 1_800_000,
		reapIntervalMs: 0, // no background timer in tests
		now: () => now,
		launch: async (id) => {
			launched.push(id);
			if (options.launchDelayMs !== undefined) {
				await new Promise((resolve) => setTimeout(resolve, options.launchDelayMs));
			}
			const session = fakeSession();
			sessions.set(id, session);
			return session;
		},
	});
	return { registry, launched, sessions, setNow: (ms) => (now = ms) };
}

function viewer(
	id: string,
	mode: 'watch' | 'control' = 'control',
): LiveViewerHandle & { sent: unknown[]; closed: string[] } {
	const sent: unknown[] = [];
	const closed: string[] = [];
	return {
		id,
		mode,
		principal: `principal-${id}`,
		send: (message) => void sent.push(message),
		close: (reason) => void closed.push(reason),
		sent,
		closed,
	};
}

Deno.test('registry: an omitted session id lazily creates the default session', async () => {
	const h = harness();
	const record = await h.registry.resolve(undefined);
	assertEquals(record.id, DEFAULT_SESSION_ID);
	assertEquals(h.launched, [DEFAULT_SESSION_ID]);

	// A second resolve reuses it rather than launching again.
	const again = await h.registry.resolve(undefined);
	assertEquals(again.id, DEFAULT_SESSION_ID);
	assertEquals(h.launched.length, 1);
	await h.registry.shutdown();
});

Deno.test('registry: an unknown explicit id is an error, never a fresh browser', async () => {
	const h = harness();
	const error = await assertRejects(() => h.registry.resolve('01JNOPE'), ToolError);
	assertEquals(error.code, 'unknown-session');
	assertEquals(h.launched, [], 'an unknown id must not launch anything');
	await h.registry.shutdown();
});

Deno.test('registry: concurrent first calls launch exactly one browser', async () => {
	const h = harness({ launchDelayMs: 25 });
	const [a, b, c] = await Promise.all([
		h.registry.resolve(undefined),
		h.registry.resolve(undefined),
		h.registry.resolve(undefined),
	]);
	assertEquals(h.launched.length, 1, 'the in-flight create must be shared');
	assert(a === b && b === c, 'all callers must receive the same record');
	await h.registry.shutdown();
});

Deno.test('registry: the session cap is enforced', async () => {
	const h = harness({ maxSessions: 2 });
	await h.registry.createNew();
	await h.registry.createNew();
	const error = await assertRejects(() => h.registry.createNew(), ToolError);
	assertEquals(error.code, 'session-limit');
	await h.registry.shutdown();
});

Deno.test('registry: idle sessions are reaped, active and watched ones are not', async () => {
	const h = harness({ sessionTtlMs: 1_000 });
	const idle = await h.registry.createNew();
	const active = await h.registry.createNew();
	const watched = await h.registry.createNew();
	h.registry.addViewer(watched, viewer('v1'));

	h.setNow(5_000);
	h.registry.touch(active.id);

	const reaped = await h.registry.reap();
	assertEquals(reaped, 1, 'only the idle session should be reaped');
	assertEquals(h.registry.peek(idle.id), undefined);
	assert(h.registry.peek(active.id) !== undefined, 'a touched session survives');
	assert(h.registry.peek(watched.id) !== undefined, 'a session with a viewer is never reaped');
	assert(h.sessions.get(idle.id)?.stopped === true, 'the reaped browser must be stopped');
	await h.registry.shutdown();
});

Deno.test('registry: a takeover lock refuses mutation and is released on viewer drop', async () => {
	const h = harness();
	const record = await h.registry.resolve(undefined);
	const v = viewer('v1');
	h.registry.addViewer(record, v);

	// Unlocked: mutation is permitted.
	h.registry.assertUnlocked(record);

	assert(h.registry.takeControl(record, v));
	const error = ((): ToolError => {
		try {
			h.registry.assertUnlocked(record);
			throw new Error('expected assertUnlocked to throw while locked');
		} catch (caught) {
			assert(caught instanceof ToolError, 'must be a ToolError');
			return caught;
		}
	})();
	assertEquals(error.code, 'human-has-control');

	// Viewers are told about the lock, both on take and on release.
	assertEquals(v.sent.length, 1);

	h.registry.removeViewer(record, v.id);
	assertEquals(record.lock, null, 'a dropped socket must not strand the lock');
	h.registry.assertUnlocked(record);
	await h.registry.shutdown();
});

Deno.test('registry: a second viewer cannot steal a held lock', async () => {
	const h = harness();
	const record = await h.registry.resolve(undefined);
	const first = viewer('v1');
	const second = viewer('v2');
	h.registry.addViewer(record, first);
	h.registry.addViewer(record, second);

	assert(h.registry.takeControl(record, first));
	assertEquals(h.registry.takeControl(record, second), false, 'the lock is exclusive');
	assertEquals(record.lock?.holder, 'v1');

	// A release by a non-holder is a no-op.
	h.registry.releaseControl(record, 'v2');
	assertEquals(record.lock?.holder, 'v1');

	h.registry.releaseControl(record, 'v1');
	assertEquals(record.lock, null);
	await h.registry.shutdown();
});

Deno.test('registry: closing a session stops the browser and evicts viewers', async () => {
	const h = harness();
	const record = await h.registry.createNew('demo');
	const v = viewer('v1');
	h.registry.addViewer(record, v);
	h.registry.takeControl(record, v);

	// Closing wins over a held lock: administrative intent outranks takeover.
	assertEquals(await h.registry.close(record.id), true);
	assertEquals(h.registry.peek(record.id), undefined);
	assertEquals(v.closed, ['session-closed']);
	assertEquals(h.sessions.get(record.id)?.stopped, true);
	assertEquals(await h.registry.close(record.id), false, 'closing twice is not an error');
	await h.registry.shutdown();
});

Deno.test('registry: summaries report lock and viewer state', async () => {
	const h = harness();
	const record = await h.registry.createNew('labelled');
	const v = viewer('v1');
	h.registry.addViewer(record, v);
	h.registry.takeControl(record, v);

	const [summary] = h.registry.list();
	assertEquals(summary?.session_id, record.id);
	assertEquals(summary?.label, 'labelled');
	assertEquals(summary?.viewer_count, 1);
	assertEquals(summary?.human_has_control, true);
	await h.registry.shutdown();
});

Deno.test('registry: shutdown closes every session and refuses further work', async () => {
	const h = harness();
	await h.registry.createNew();
	await h.registry.createNew();
	assertEquals(h.registry.size, 2);

	await h.registry.shutdown();
	assertEquals(h.registry.size, 0);
	for (const session of h.sessions.values()) assertEquals(session.stopped, true);

	const error = await assertRejects(() => h.registry.resolve(undefined), ToolError);
	assertEquals(error.code, 'browser-unavailable');
});

// --- change notifications (R4/R5) ------------------------------------------

Deno.test('registry: watchers see sessions appear and vanish', async () => {
	const h = harness();
	const seen: RegistryChange[] = [];
	const stop = h.registry.watch((change) => seen.push(change));

	const record = await h.registry.resolve();
	assertEquals(seen, [{ kind: 'session-added', sessionId: DEFAULT_SESSION_ID }]);

	await h.registry.close(record.id, 'test');
	assertEquals(seen.at(-1), { kind: 'session-removed', sessionId: DEFAULT_SESSION_ID });

	// Unsubscribed watchers hear nothing more.
	stop();
	await h.registry.resolve();
	assertEquals(seen.length, 2);
	await h.registry.shutdown();
});

Deno.test('registry: taking and releasing the lock is announced', async () => {
	const h = harness();
	const record = await h.registry.resolve();
	const seen: RegistryChange[] = [];
	h.registry.watch((change) => seen.push(change));

	const one = viewer('v1');
	h.registry.addViewer(record, one);
	h.registry.takeControl(record, one);
	assertEquals(seen, [{ kind: 'lock-changed', sessionId: record.id }]);

	h.registry.releaseControl(record, one.id);
	assertEquals(seen.length, 2);
	assertEquals(seen[1], { kind: 'lock-changed', sessionId: record.id });

	// A release by a viewer that does not hold it changes nothing, so it is silent.
	h.registry.releaseControl(record, 'someone-else');
	assertEquals(seen.length, 2);
	await h.registry.shutdown();
});

Deno.test('registry: a navigation on any session announces a page change', async () => {
	const h = harness();
	const record = await h.registry.resolve();
	const seen: RegistryChange[] = [];
	h.registry.watch((change) => seen.push(change));

	const session = h.sessions.get(record.id);
	assert(session !== undefined);
	await session.eventBus.dispatch(
		new NavigationCompleteEvent({ targetId: 'T' as never, url: 'https://example.test/' }),
	);
	assertEquals(seen, [{ kind: 'page-changed', sessionId: record.id }]);

	// After the session closes, its bus no longer reaches the registry.
	await h.registry.close(record.id, 'test');
	seen.length = 0;
	await session.eventBus.dispatch(
		new NavigationCompleteEvent({ targetId: 'T' as never, url: 'https://example.test/2' }),
	);
	assertEquals(seen, []);
	await h.registry.shutdown();
});

Deno.test('registry: a throwing watcher cannot break a browser operation', async () => {
	const h = harness();
	h.registry.watch(() => {
		throw new Error('a consumer exploded');
	});
	// The session is still created, and closing it still works.
	const record = await h.registry.resolve();
	assertEquals(record.id, DEFAULT_SESSION_ID);
	assertEquals(await h.registry.close(record.id, 'test'), true);
	await h.registry.shutdown();
});

// ---------------------------------------------------------------------------
// session files (E-33)
// ---------------------------------------------------------------------------

async function isPresent(path: string): Promise<boolean> {
	try {
		await Deno.stat(path);
		return true;
	} catch {
		return false;
	}
}

Deno.test('registry: a launched session carries its download directory and removes it on close', async () => {
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'reg-dl-' });
	await Deno.writeTextFile(`${dir}/G1`, 'bytes');
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session: fakeSession(), downloads: null, downloadsDir: dir }),
	});
	const record = await registry.resolve(undefined);
	assertEquals(record.files.dir, dir);
	assertEquals(record.files.list(), [], 'no ledger, no files');
	await registry.close(record.id);
	assertEquals(await isPresent(dir), false, 'closing a session removes only its own download directory');
	await registry.shutdown();
});

Deno.test('registry: a bare BrowserSession from a launcher still yields a record with (empty) files', async () => {
	const h = harness();
	const record = await h.registry.resolve(undefined);
	assertEquals(record.files.dir, null);
	assertEquals(record.files.list(), []);
	assertEquals(record.files.lookup('G1'), undefined);
	await h.registry.shutdown();
});

Deno.test('registry: the downloads root lives under the data directory and stale incarnations are swept', async () => {
	const dataDir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'reg-data-' });
	const stale = `${dataDir}/downloads/default-01stale`;
	await Deno.mkdir(stale, { recursive: true });
	await Deno.writeTextFile(`${stale}/leftover`, 'x');
	// A sibling owner's data is never touched.
	await Deno.mkdir(`${dataDir}/profiles/keep`, { recursive: true });
	try {
		const registry = new SessionRegistry({
			reapIntervalMs: 0,
			dataDir,
			launch: () => Promise.resolve(fakeSession()),
		});
		assert(registry.downloadsRoot?.endsWith('downloads'));
		// The sweep is awaited by the first launch.
		await registry.resolve(undefined);
		assertEquals(await isPresent(stale), false, 'a previous process’s download directory is gone');
		assertEquals(await isPresent(`${dataDir}/profiles/keep`), true);
		await registry.shutdown();
	} finally {
		await Deno.remove(dataDir, { recursive: true }).catch(() => {});
	}
});

Deno.test('registry: shutting down before the first launch still drains the startup sweep', async () => {
	const dataDir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'reg-sweep-' });
	const stale = `${dataDir}/downloads/default-01stale`;
	await Deno.mkdir(stale, { recursive: true });
	try {
		const registry = new SessionRegistry({
			reapIntervalMs: 0,
			dataDir,
			launch: () => Promise.resolve(fakeSession()),
		});
		// No launch: nothing else would ever await the sweep. Deno's leak detector
		// is the other half of this assertion — an unawaited `Deno.readDir` started
		// in the constructor used to surface as a failure in an unrelated later test.
		await registry.shutdown();
		assertEquals(await isPresent(stale), false, 'the sweep finished before shutdown returned');
	} finally {
		await Deno.remove(dataDir, { recursive: true }).catch(() => {});
	}
});

Deno.test('registry: peek never creates a session (the file tools’ contract)', async () => {
	const h = harness();
	assertEquals(h.registry.peek(DEFAULT_SESSION_ID), undefined);
	assertEquals(h.launched, [], 'peek must not launch');
	await h.registry.shutdown();
});

/**
 * S0 (design §2.0 item 3): the R8 seam returns today's answers. Every principal reaches every session in `shared`
 * mode, whoever asks; W5 changes these answers in `owner` mode only.
 */
Deno.test('registry: S0 access seam answers exactly as shared mode does today', async () => {
	const h = harness();
	const alice = { owner: 'api-key:alice', admin: false };
	const bob = { owner: 'api-key:bob', admin: false };
	assertEquals(h.registry.ownership, 'shared');
	assertEquals(h.registry.peekFor(undefined, alice), undefined, 'peekFor never creates a session');
	assertEquals(h.launched, []);

	const own = await h.registry.resolve(undefined, alice);
	const other = await h.registry.createNew('b', undefined, bob);
	assertEquals(own.owner, null, 'S0 never stamps an owner');
	assertEquals(other.owner, null);
	assertEquals(await h.registry.resolve(other.id, alice), other, 'resolve ignores access');

	for (const access of [alice, bob, undefined]) {
		assertEquals(h.registry.peekFor(undefined, access), h.registry.peek(DEFAULT_SESSION_ID));
		assertEquals(h.registry.peekFor(other.id, access), other);
		assertEquals(h.registry.peekFor('01JNOPE', access), undefined);
		assertEquals(h.registry.visibleTo(access), h.registry.records);
		assertEquals(h.registry.listFor(access), h.registry.list());
		assert(h.registry.canAccess(own, access));
		assert(h.registry.canAccess(other, access));
	}
	assertEquals(new SessionRegistry({ reapIntervalMs: 0, ownership: 'owner' }).ownership, 'owner');
	await h.registry.shutdown();
});

// --- the event ring on the record (B1.7) ------------------------------------

Deno.test('registry: a session record owns an event ring with its own epoch', async () => {
	const h = harness();
	try {
		const a = await h.registry.createNew();
		const b = await h.registry.createNew();
		assertEquals(a.events.highWaterMark, 0, 'a fresh ring has allocated no seq');
		assert(a.events.epoch !== b.events.epoch, 'two sessions never share an epoch');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('registry: a navigation reaches the ring as origin and path, never a URL', async () => {
	const h = harness();
	try {
		const record = await h.registry.resolve(undefined);
		const session = h.sessions.get(record.id);
		assert(session !== undefined);
		await session.eventBus.dispatch(
			new NavigationCompleteEvent({
				targetId: 'T-top' as never,
				url: 'https://shop.example.test/checkout?session=SECRET-TOKEN&step=2',
			}),
		);
		const events = record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
		assertEquals(events.length, 1);
		const [navigation] = events;
		assert(navigation !== undefined);
		assertEquals(navigation.kind, 'navigation');
		assertEquals(navigation.payload.origin, 'https://shop.example.test');
		assertEquals(navigation.payload.path, '/checkout');
		assertEquals(navigation.payload.has_query, true);
		// The whole record, not just the field: a token must not survive anywhere.
		const serialized = JSON.stringify(navigation);
		assert(!serialized.includes('SECRET-TOKEN'), `a query reached the ring: ${serialized}`);
		assert(!('url' in navigation.payload), 'a url field would defeat the whole shape');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('registry: a child-frame navigation carries the child frame id (A-2)', async () => {
	// The top URL is unchanged and only the child moved. Without the frame id on
	// the record a consumer sees a navigation it cannot attribute, which is the
	// frameset case the requirement's §1.4 exists for.
	const h = harness();
	try {
		const record = await h.registry.resolve(undefined);
		const session = h.sessions.get(record.id);
		assert(session !== undefined);
		await session.eventBus.dispatch(
			new NavigationCompleteEvent({ targetId: 'T-child' as never, url: 'https://inner.example.test/results' }),
		);
		const [event] = record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
		assert(event !== undefined);
		assertEquals(event.payload.frame_id, 'T-child');
		assertEquals(event.tab_id, 'T-child');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('registry: taking and releasing the lock lands control records on the ring', async () => {
	const h = harness();
	try {
		const record = await h.registry.resolve(undefined);
		const viewer: LiveViewerHandle = {
			id: 'v1',
			mode: 'control',
			principal: 'human@example.test',
			send: () => {},
			close: () => {},
		};
		h.registry.addViewer(record, viewer);
		assertEquals(h.registry.takeControl(record, viewer), true);
		h.registry.releaseControl(record, viewer.id);
		const events = record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
		assertEquals(events.map((event) => event.payload.event), ['taken', 'released']);
		assertEquals(events[0]?.tab_id, null, 'a control record is session-scoped');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('registry: closing a session closes its ring and releases every waiter', async () => {
	const h = harness();
	try {
		const record = await h.registry.resolve(undefined);
		const waiting = record.events.next(30_000);
		await h.registry.close(record.id, 'test');
		await waiting;
		assertEquals(record.events.closed, true);
		assertEquals(record.events.append('tab', { action: 'opened' }), null);
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * The download ledger gate (owner item 6): a download whose final URL is outside
 * `TTK_ALLOWED_DOMAINS` is cancelled with `navigation-blocked`, whatever started
 * it. Driven through the watchdog's synchronous listener channel with a fake
 * ledger, because the question is what the registry does with the signal.
 */
Deno.test('registry: the ledger gate cancels a download whose final URL is off the allowlist', async () => {
	const cancelled: Array<{ guid: string; reason: string }> = [];
	const listeners: Array<(signal: unknown) => void> = [];
	const ledger = {
		downloads: [],
		isRemoteBrowser: false,
		lookup: () => undefined,
		addDownloadListener(listener: (signal: unknown) => void) {
			listeners.push(listener);
			return () => {};
		},
		cancelDownload(guid: string, reason: string) {
			cancelled.push({ guid, reason });
			return Promise.resolve(true);
		},
	};
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		allowedDomains: ['example.com'],
		launch: () => Promise.resolve({ session: fakeSession(), downloads: ledger as never, downloadsDir: null }),
	});
	const record = await registry.resolve();
	const download = (guid: string, url: string) => ({
		guid,
		url,
		suggestedFilename: 'x.bin',
		fileName: 'x.bin',
		path: '',
		fileSize: 0,
		receivedBytes: 0,
		totalBytes: 0,
		fileType: null,
		mimeType: null,
		autoDownload: false,
		state: 'inProgress',
		startedAt: 0,
		completedAt: null,
		error: null,
	});
	for (const listener of listeners) {
		listener({ phase: 'started', download: download('g-ok', 'https://a.example.com/report.csv?token=SECRET') });
		listener({ phase: 'started', download: download('g-bad', 'https://evil.example.net/x.bin?token=SECRET') });
		listener({ phase: 'started', download: download('g-dot', 'https://EXAMPLE.com./same.bin') });
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
	assertEquals(cancelled, [{ guid: 'g-bad', reason: 'navigation-blocked' }]);
	// Only the origin is remembered — never the URL, which carried a token.
	assertEquals(record.blockedDownloads?.get('g-bad'), 'https://evil.example.net');
	assertEquals(record.blockedDownloads?.has('g-ok'), false);
	assertEquals(record.blockedDownloads?.has('g-dot'), false, 'a trailing-dot spelling of an allowed host is allowed');
	assertEquals(JSON.stringify([...record.blockedDownloads ?? []]).includes('SECRET'), false);
	// The ring saw the start and, for the refused one, nothing that names a URL.
	const entries = record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
	assertEquals(entries.filter((entry) => entry.kind === 'download.started').length, 3);
	assertEquals(JSON.stringify(entries).includes('SECRET'), false);
	await registry.shutdown();
});

/**
 * U-5 — does the ring's `seq` survive a browser crash and reconnect?
 *
 * Architecture §4.2 retires `seq` as load-bearing via the epoch and makes the
 * `browser-recovered` control record mandatory if the record does not survive.
 * Both are asserted here and the test names which was observed: the reconnect
 * ladder (`packages/browser/src/browser/reconnect.ts`) is driven on the
 * session's own bus, exactly as `CdpClient.onClose` drives it, and the ring is
 * read across the reconnect.
 *
 * Observed: the registry record — and with it the ring, its epoch and its
 * `seq` — lives in this process and is keyed by session id, not by the CDP
 * connection, so it **survives**: `seq` is continuous across the reconnect in
 * one epoch, with no `gap`. The `browser-recovered` control record is emitted
 * as well, so a consumer reads the discontinuity even though nothing was lost.
 */
Deno.test('registry: U-5 — seq is continuous across a browser reconnect, and browser-recovered is minted', async () => {
	using time = new FakeTime();
	const h = harness();
	const record = await h.registry.resolve();
	const session = h.sessions.get(record.id);
	assert(session !== undefined);
	const epochBefore = record.events.epoch;
	await session.eventBus.dispatch(
		new NavigationCompleteEvent({ targetId: 'T' as never, url: 'https://example.test/before' }),
	);
	const before = record.events.read({ kind: 'cursor', epoch: epochBefore, seq: 0 });
	const lastSeqBefore = before.at(-1)?.seq ?? -1;
	assert(lastSeqBefore >= 0, 'a navigation record was minted before the crash');

	// The browser "crashes": an unintentional close starts the ladder, whose
	// first attempt succeeds after the 1 s backoff.
	const controller = new ReconnectController({
		bus: session.eventBus,
		connect: () => Promise.resolve(),
		isConnected: () => false,
		cdpUrl: () => 'ws://127.0.0.1:9222/devtools/browser/x',
		logger: silentBusLogger,
	});
	const outcome = controller.notifyClosed({ intentional: false, code: 1006, reason: 'crash' } as never);
	assert(outcome !== null, 'an unintentional close must start the ladder');
	await time.tickAsync(1_100);
	assertEquals(await outcome, true, 'the reconnect must succeed for this test to say anything');

	await session.eventBus.dispatch(
		new NavigationCompleteEvent({ targetId: 'T' as never, url: 'https://example.test/after' }),
	);
	const after = record.events.read({ kind: 'cursor', epoch: epochBefore, seq: lastSeqBefore });
	// Observed outcome A: the record survived — same epoch, contiguous seq, no gap.
	assertEquals(record.events.epoch, epochBefore, 'the ring epoch changed: the record did not survive');
	assertEquals(after.some((entry) => entry.kind === 'gap'), false, 'a gap means seq did not survive');
	const seqs = after.map((entry) => entry.seq);
	for (let i = 1; i < seqs.length; i += 1) {
		assertEquals(seqs[i], (seqs[i - 1] ?? 0) + 1, `seq is not contiguous across the reconnect: ${seqs.join(',')}`);
	}
	// And outcome B holds as well: the control record is on the stream regardless.
	const recovered = after.find((entry) => entry.kind === 'control' && entry.payload.event === 'browser-recovered');
	assert(recovered !== undefined, 'browser-recovered was not minted');
	assert(
		after.some((entry) => entry.kind === 'navigation' && entry.seq > recovered.seq),
		'the post-reconnect navigation must follow browser-recovered in the same ring',
	);
	await h.registry.shutdown();
});

Deno.test('registry: a crash tells viewers why and tears the session down; a blocked navigation does not (F4)', async () => {
	const h = harness();
	const record = await h.registry.resolve();
	const v = viewer('v1');
	h.registry.addViewer(record, v);
	const session = h.sessions.get(record.id)!;

	// A refusal the session survives.
	await session.eventBus.dispatch(new BrowserErrorEvent({ errorType: 'NavigationBlocked', message: 'blocked' }));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert(h.registry.peek(record.id) !== undefined);

	await session.eventBus.dispatch(new TargetCrashedEvent({ targetId: 'T' as never, error: 'renderer gone' }));
	for (let i = 0; i < 50 && h.registry.peek(record.id) !== undefined; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assertEquals(h.registry.peek(record.id), undefined, 'the session was torn down');
	assert(session.stopped, 'its browser was stopped');
	const error = v.sent.find((message) => (message as { type?: string }).type === 'error') as
		| { code: string; message: string }
		| undefined;
	assertEquals(error?.code, 'browser-crashed');
	assert(error?.message.includes('renderer gone'));
	assertEquals(v.closed, ['browser-crashed']);

	// A browser that could not be reconnected ends its session the same way.
	const second = await h.registry.createNew();
	await h.sessions.get(second.id)!.eventBus.dispatch(
		new BrowserErrorEvent({ errorType: 'ReconnectionFailed', message: 'gone' }),
	);
	for (let i = 0; i < 50 && h.registry.peek(second.id) !== undefined; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assertEquals(h.registry.peek(second.id), undefined);
	await h.registry.shutdown();
});
