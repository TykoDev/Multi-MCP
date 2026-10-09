/**
 * `StorageStateWatchdog` contract tests (ARCHITECTURE.md §6.9; COMPLETIONS-CRITERIA.md §3.2 watchdog
 * row 9: "load before first nav, 60 s diff-save loop, atomic `.tmp`/`.bak` write, no cookie
 * stringification"; DATA-MODEL.md §5.1.5, §5.2, §9 R9.2).
 *
 * Real throughout: a `Deno.serve` CDP endpoint answering `Storage.getCookies` / `Storage.setCookies`
 * / `DOMStorage.*`, a real `BrowserSession`, a real `EventBus`, and real files under
 * `tests/.scratch`. The 60 s loop is driven by `FakeTime`, never by a wall-clock wait — and the op
 * sanitizer is what proves the timer does not outlive `detach()`.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { fromFileUrl, join } from '@std/path';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import type { BusLogger, HandlerContext } from '@tykotech/bus';
import { BrowserStopEvent, NavigationCompleteEvent, SaveStorageStateEvent, StorageStateSavedEvent } from '../events.ts';
import { type Cookie, createBrowserProfile, type StorageState } from '../types.ts';
import { BrowserSession } from '../browser/session.ts';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import {
	cookieFingerprint,
	cookieKey,
	DEFAULT_STORAGE_STATE_FILENAME,
	describeStorageState,
	emptyStorageState,
	mergeStorageState,
	originOf,
	parseStorageState,
	shouldAttachStorageStateWatchdog,
	STORAGE_BACKUP_SUFFIX,
	STORAGE_MONITOR_INTERVAL_MS,
	STORAGE_TMP_SUFFIX,
	StorageStateWatchdog,
	toCookieParam,
	toStorageCookie,
} from './storage_state.ts';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../../tests/.scratch', import.meta.url));

async function scratchDir(prefix: string): Promise<string> {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	return await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix });
}

/** A CDP cookie as Chrome reports it. */
function cdpCookie(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		name: 'session',
		value: 'abc123',
		domain: '127.0.0.1',
		path: '/',
		expires: 1893456000,
		size: 12,
		httpOnly: true,
		secure: false,
		session: false,
		sameSite: 'Lax',
		...overrides,
	};
}

function storageCookie(overrides: Partial<Cookie> = {}): Cookie {
	return {
		name: 'session',
		value: 'abc123',
		domain: '127.0.0.1',
		path: '/',
		expires: 1893456000,
		httpOnly: true,
		secure: false,
		sameSite: 'Lax',
		...overrides,
	};
}

interface LogRecord {
	readonly level: string;
	readonly message: string;
	readonly fields: Record<string, unknown>;
}

function recordingLogger(sink: LogRecord[]): BusLogger {
	return {
		debug: (message, fields) => sink.push({ level: 'debug', message, fields: fields ?? {} }),
		warn: (message, fields) => sink.push({ level: 'warn', message, fields: fields ?? {} }),
		error: (message, fields) => sink.push({ level: 'error', message, fields: fields ?? {} }),
	};
}

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly session: BrowserSession;
	readonly watchdog: StorageStateWatchdog;
	readonly logs: LogRecord[];
	readonly saved: StorageStateSavedEvent[];
	/** Replaces what `Storage.getCookies` answers with. */
	setJar(cookies: Record<string, unknown>[]): void;
}

async function harness(options: {
	profile?: Record<string, unknown>;
	jar?: Record<string, unknown>[];
	localStorage?: string[][];
	watchdogPath?: string | null;
	autoStart?: boolean;
} = {}): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages: ['http://127.0.0.1:1/index.html'] });
	let jar = options.jar ?? [];
	fixture.script('Storage.getCookies', (request: FixtureRequest) => fixture.reply(request.id, { cookies: jar }));
	fixture.script(
		'DOMStorage.getDOMStorageItems',
		(request: FixtureRequest) => fixture.reply(request.id, { entries: options.localStorage ?? [] }, request.sessionId),
	);

	const logs: LogRecord[] = [];
	const session = new BrowserSession({
		profile: createBrowserProfile({ cdpUrl: fixture.wsUrl, ...options.profile }),
		logger: recordingLogger(logs),
	});
	const watchdog = new StorageStateWatchdog(
		session,
		options.watchdogPath === undefined ? {} : { path: options.watchdogPath },
	);
	const saved: StorageStateSavedEvent[] = [];
	session.eventBus.on(StorageStateSavedEvent, (event) => void saved.push(event), { wrap: null });
	watchdog.attach();
	if (options.autoStart !== false) await session.start();

	return {
		fixture,
		session,
		watchdog,
		logs,
		saved,
		setJar: (cookies) => {
			jar = cookies;
		},
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await session.stop({ force: true });
			await session.eventBus.stop();
			await fixture.close();
		},
	};
}

// ---------------------------------------------------------------------------
// constants + conditional attachment
// ---------------------------------------------------------------------------

Deno.test('storage-state: the ARCHITECTURE §6.9 constants are encoded verbatim', () => {
	assertEquals(STORAGE_MONITOR_INTERVAL_MS, 60_000);
	assertEquals(STORAGE_TMP_SUFFIX, '.tmp');
	assertEquals(STORAGE_BACKUP_SUFFIX, '.bak');
	assertEquals(DEFAULT_STORAGE_STATE_FILENAME, 'bua_storage_state.json');
});

Deno.test('storage-state: the watchdog is conditional on storageState or userDataDir', () => {
	assertEquals(shouldAttachStorageStateWatchdog({ storageState: null, userDataDir: null }), false);
	assertEquals(shouldAttachStorageStateWatchdog({ storageState: '/tmp/state.json', userDataDir: null }), true);
	assertEquals(shouldAttachStorageStateWatchdog({ storageState: emptyStorageState(), userDataDir: null }), true);
	assertEquals(shouldAttachStorageStateWatchdog({ storageState: null, userDataDir: '/tmp/profile' }), true);
});

Deno.test('storage-state: the path is the file, the userDataDir default, or nothing at all', () => {
	assertEquals(
		StorageStateWatchdog.defaultPathFor({ storageState: '/a/state.json', userDataDir: '/p' }),
		'/a/state.json',
	);
	assertEquals(
		StorageStateWatchdog.defaultPathFor({ storageState: null, userDataDir: join('/p', 'profile') }),
		join('/p', 'profile', DEFAULT_STORAGE_STATE_FILENAME),
	);
	// An in-memory document has no file, ever: that is the cookie-leak prevention rule.
	assertEquals(StorageStateWatchdog.defaultPathFor({ storageState: emptyStorageState(), userDataDir: '/p' }), null);
	assertEquals(StorageStateWatchdog.defaultPathFor({ storageState: null, userDataDir: null }), null);
});

// ---------------------------------------------------------------------------
// load before the first navigation
// ---------------------------------------------------------------------------

Deno.test('storage-state: cookies are applied before anything can navigate', async () => {
	const dir = await scratchDir('bua-ss-load-');
	const path = join(dir, 'state.json');
	try {
		await Deno.writeTextFile(
			path,
			JSON.stringify({ cookies: [storageCookie()], origins: [] }),
		);
		await using h = await harness({ profile: { storageState: path } });

		const setCookies = h.fixture.requestsFor('Storage.setCookies');
		assertEquals(setCookies.length, 1);
		const applied = setCookies[0]?.params.cookies as Record<string, unknown>[];
		assertEquals(applied.length, 1);
		assertEquals(applied[0]?.name, 'session');
		assertEquals(applied[0]?.expires, 1893456000);

		// `start()` awaits `BrowserConnectedEvent`, and that event is what dispatches the load — so by
		// the time `start()` has returned the jar is primed and *no* navigation has happened yet. That
		// ordering is the whole contract: a cookie applied after the first request is a cookie the
		// login never saw.
		assertEquals(h.fixture.requestsFor('Page.navigate').length, 0);
		const setIndex = h.fixture.requests.findIndex((request) => request.method === 'Storage.setCookies');
		assert(setIndex >= 0, 'the load ran inside start(), not after it');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('storage-state: a missing or corrupt file degrades to the empty state, never a failed start', async () => {
	const dir = await scratchDir('bua-ss-corrupt-');
	const path = join(dir, 'state.json');
	try {
		await Deno.writeTextFile(path, '{ not json');
		await using h = await harness({ profile: { storageState: path } });
		assertEquals(h.fixture.requestsFor('Storage.setCookies').length, 0, 'nothing usable, nothing applied');
		assert(h.logs.some((record) => record.message === 'storage state file is unusable'));
		assertEquals(h.watchdog.storagePath, path);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('storage-state: localStorage is applied when a navigation lands on its origin', async () => {
	const dir = await scratchDir('bua-ss-origin-');
	const path = join(dir, 'state.json');
	try {
		const state: StorageState = {
			cookies: [],
			origins: [{
				origin: 'http://127.0.0.1:1',
				localStorage: [{ name: 'token', value: 'xyz' }],
				sessionStorage: [],
			}],
		};
		await Deno.writeTextFile(path, JSON.stringify(state));
		await using h = await harness({ profile: { storageState: path } });

		// Before the navigation the origin is pending: CDP cannot write storage for an unloaded origin.
		assertEquals(h.watchdog.pendingOrigins, ['http://127.0.0.1:1']);
		assertEquals(h.fixture.requestsFor('DOMStorage.setDOMStorageItem').length, 0);

		const targetId = h.fixture.targets[0]?.targetId;
		assert(targetId !== undefined);
		await h.session.eventBus.dispatch(
			new NavigationCompleteEvent({ targetId, url: 'http://127.0.0.1:1/index.html' }),
		);

		const writes = h.fixture.requestsFor('DOMStorage.setDOMStorageItem');
		assertEquals(writes.length, 1);
		assertEquals(writes[0]?.params.key, 'token');
		assertEquals(writes[0]?.params.value, 'xyz');
		assertEquals(h.watchdog.pendingOrigins, [], 'an applied origin stops being pending');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// the 60 s cookie-diff monitor loop
// ---------------------------------------------------------------------------

Deno.test('storage-state: the monitor loop fires at 60 s and only saves when the jar changed', async () => {
	const dir = await scratchDir('bua-ss-monitor-');
	const path = join(dir, 'state.json');
	using time = new FakeTime();
	try {
		await using h = await harness({ profile: { storageState: path }, jar: [cdpCookie()] });
		assertEquals(h.watchdog.monitoring, true);
		// The load primed the fingerprint from the (empty) file; make it match the live jar first.
		await h.session.eventBus.dispatch(new SaveStorageStateEvent());
		const savesAfterLoad = h.saved.length;

		await time.tickAsync(STORAGE_MONITOR_INTERVAL_MS - 1);
		await h.watchdog.monitorTick.call(h.watchdog); // no-op guard: the tick has not been scheduled yet
		assertEquals(h.saved.length, savesAfterLoad, 'an unchanged jar writes nothing');

		// A refreshed session token is exactly the change worth persisting.
		h.setJar([cdpCookie({ value: 'rotated' })]);
		await time.tickAsync(2);
		await h.watchdog.monitorTick();
		assert(h.saved.length > savesAfterLoad, 'a changed jar triggers a save');

		const written = JSON.parse(await Deno.readTextFile(path)) as StorageState;
		assertEquals(written.cookies.length, 1);
		assertEquals(written.cookies[0]?.value, 'rotated');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('storage-state: detach disarms the 60 s timer (the op sanitizer is the second witness)', async () => {
	const dir = await scratchDir('bua-ss-detach-');
	try {
		const h = await harness({ profile: { storageState: join(dir, 'state.json') } });
		assertEquals(h.watchdog.monitoring, true);
		h.watchdog.detach();
		assertEquals(h.watchdog.monitoring, false);
		await h.session.stop({ force: true });
		await h.session.eventBus.stop();
		await h.fixture.close();
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// atomic write + merge
// ---------------------------------------------------------------------------

Deno.test('storage-state: the write is atomic — .tmp is consumed and .bak keeps the previous generation', async () => {
	const dir = await scratchDir('bua-ss-atomic-');
	const path = join(dir, 'state.json');
	try {
		await using h = await harness({ profile: { storageState: path }, jar: [cdpCookie()] });
		await h.session.eventBus.dispatch(new SaveStorageStateEvent());
		const first = await Deno.readTextFile(path);
		assertStringIncludes(first, '"session"');

		h.setJar([cdpCookie({ value: 'second' })]);
		await h.session.eventBus.dispatch(new SaveStorageStateEvent());

		const names = new Set<string>();
		for await (const entry of Deno.readDir(dir)) names.add(entry.name);
		assertEquals(names.has('state.json'), true);
		assertEquals(names.has(`state.json${STORAGE_BACKUP_SUFFIX}`), true, 'the previous generation is kept');
		assertEquals(names.has(`state.json${STORAGE_TMP_SUFFIX}`), false, 'the temp file is consumed by the rename');
		assertEquals(await Deno.readTextFile(`${path}${STORAGE_BACKUP_SUFFIX}`), first);

		const current = JSON.parse(await Deno.readTextFile(path)) as StorageState;
		assertEquals(current.cookies[0]?.value, 'second');
		assertEquals(h.saved.length, 2);
		assertEquals(h.saved[0]?.cookiesCount, 1);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('storage-state: a save merges over the existing file rather than replacing it', async () => {
	const dir = await scratchDir('bua-ss-merge-');
	const path = join(dir, 'state.json');
	try {
		// A login for another site, recorded on a previous run.
		await Deno.writeTextFile(
			path,
			JSON.stringify({
				cookies: [storageCookie({ name: 'other', domain: 'other.test', value: 'keepme' })],
				// test-policy-allow: a storage-state *origin key* on disk — merge-map data, never fetched.
				origins: [{ origin: 'http://other.test', localStorage: [{ name: 'a', value: '1' }], sessionStorage: [] }],
			}),
		);
		await using h = await harness({ profile: { storageState: path }, jar: [cdpCookie()] });
		await h.session.eventBus.dispatch(new SaveStorageStateEvent());

		const merged = JSON.parse(await Deno.readTextFile(path)) as StorageState;
		const names = merged.cookies.map((cookie) => cookie.name).sort();
		assertEquals(names, ['other', 'session'], 'a run that visited one site must not wipe another');
		assertEquals(merged.origins.length, 1);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('storage-state: BrowserStopEvent takes a final save before the socket goes away', async () => {
	const dir = await scratchDir('bua-ss-stop-');
	const path = join(dir, 'state.json');
	try {
		const h = await harness({ profile: { storageState: path }, jar: [cdpCookie()] });
		try {
			await h.session.eventBus.dispatch(new BrowserStopEvent());
			assertEquals(h.saved.length, 1);
			assertEquals(h.watchdog.monitoring, false, 'the loop is disarmed on stop');
		} finally {
			h.watchdog.detach();
			await h.session.eventBus.stop();
			await h.fixture.close();
		}
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// the save budget — ERRATUM(CANCEL-2)
// ---------------------------------------------------------------------------

/** The context the bus hands a stop handler, with the signal the test wants. */
function stopContext(signal: AbortSignal, timeoutSec = 45): HandlerContext {
	return { signal, handlerName: 'StorageStateWatchdog.onBrowserStopEvent', timeoutSec };
}

async function entriesOf(dir: string): Promise<string[]> {
	const names: string[] = [];
	for await (const entry of Deno.readDir(dir)) names.push(entry.name);
	return names.sort();
}

Deno.test('ERRATUM(CANCEL-2): an abandoned stop never starts the write, so the good file survives', async () => {
	const dir = await scratchDir('bua-ss-cancel-stop-');
	const path = join(dir, 'state.json');
	try {
		await using h = await harness({ profile: { storageState: path }, jar: [cdpCookie()] });
		await h.session.eventBus.dispatch(new SaveStorageStateEvent());
		const good = await Deno.readTextFile(path);
		const before = await entriesOf(dir);

		// The dangerous case the audit names: a save assembled from a half-dead browser landing on top
		// of a good file, while the bus has already moved on to killing Chrome and closing the socket.
		h.setJar([cdpCookie({ value: 'from-a-dying-browser' })]);
		await h.watchdog.onBrowserStopEvent(new BrowserStopEvent(), stopContext(AbortSignal.abort()));

		assertEquals(await Deno.readTextFile(path), good, 'the previous generation is what a skipped save protects');
		assertEquals(await entriesOf(dir), before, 'no .tmp, no rotated .bak — the transaction never began');
		const skipped = h.logs.find((record) => record.message.startsWith('storage-state save skipped'));
		assert(skipped !== undefined, 'a save that did not happen must be audible');
		assertEquals(skipped.level, 'warn');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('ERRATUM(CANCEL-2): a skipped save leaves the diff dirty, so the next pass still writes', async () => {
	const dir = await scratchDir('bua-ss-cancel-diff-');
	const path = join(dir, 'state.json');
	try {
		await using h = await harness({ profile: { storageState: path }, jar: [cdpCookie()] });
		await h.watchdog.onSaveStorageStateEvent(new SaveStorageStateEvent(), stopContext(AbortSignal.abort()));
		assertEquals(await entriesOf(dir), [], 'nothing was written');
		assertEquals(h.saved.length, 0);

		// `#lastFingerprint` must NOT have advanced: a save that did not happen cannot be allowed to
		// tell the 60 s cookie diff that the jar is persisted.
		await h.watchdog.monitorTick();
		assertEquals(h.saved.length, 1, "the suppressed save is the next tick's job, not a lost one");
		assertStringIncludes(await Deno.readTextFile(path), '"session"');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('ERRATUM(CANCEL-2): detach cancels a monitor tick caught between its read and its write', async () => {
	const dir = await scratchDir('bua-ss-cancel-tick-');
	const path = join(dir, 'state.json');
	try {
		await using h = await harness({ profile: { storageState: path }, jar: [cdpCookie()] });
		// The tick suspends on `Storage.getCookies`; detaching here is the second entry point to the
		// same writes, the one no `HandlerContext` reaches because no dispatch is behind it.
		const tick = h.watchdog.monitorTick();
		h.watchdog.detach();
		await tick;

		assertEquals(await entriesOf(dir), [], 'a write must not outlive the watchdog that started it');
		assertEquals(h.saved.length, 0);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// the cookie-leak prevention rule (§6.9: "in-memory dicts are never stringified")
// ---------------------------------------------------------------------------

Deno.test('storage-state: an in-memory storageState is never written to disk and never logged', async () => {
	const dir = await scratchDir('bua-ss-memory-');
	try {
		const secret = 'tOpS3cr3t-session-token';
		const inMemory: StorageState = { cookies: [storageCookie({ value: secret })], origins: [] };
		await using h = await harness({
			// `userDataDir` is set too, so the only reason no file appears is the in-memory rule itself.
			profile: { storageState: inMemory, userDataDir: dir },
			jar: [cdpCookie({ value: secret })],
		});
		assertEquals(h.watchdog.storagePath, null, 'an object is a value, not a location');

		await h.session.eventBus.dispatch(new SaveStorageStateEvent());
		await h.watchdog.monitorTick();

		const entries: string[] = [];
		for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
		assertEquals(entries, [], 'nothing — not the file, not a .tmp, not a .bak — reached the disk');
		assertEquals(h.saved.length, 0, 'no path means no StorageStateSavedEvent');

		// The document was updated in place, so a caller holding the object sees the live jar.
		assertEquals(inMemory.cookies.length, 1);
		assertEquals(inMemory.cookies[0]?.value, secret);

		// And no log record anywhere carries a cookie name or value — only counts.
		const dump = JSON.stringify(h.logs);
		assertEquals(dump.includes(secret), false, 'a cookie value must never reach a log record');
		assertEquals(dump.includes('"session"'), false, 'nor a cookie name');
		const memoryLog = h.logs.find((record) => record.message === 'storage state kept in memory (no path configured)');
		assert(memoryLog !== undefined);
		assertEquals(memoryLog.fields, { cookiesCount: 1, originsCount: 0 });
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

Deno.test('storage-state: CDP cookies round-trip through the Playwright format (§9 R9.2)', () => {
	const persistent = toStorageCookie({
		name: 'a',
		value: 'b',
		domain: 'x.test',
		path: '/',
		expires: 1893456000,
		httpOnly: true,
		secure: true,
		session: false,
		sameSite: 'Strict',
	});
	assertEquals(persistent.expires, 1893456000);
	assertEquals(persistent.sameSite, 'Strict');
	assertEquals(toCookieParam(persistent).expires, 1893456000);

	// §5.2: `-1` marks a session cookie, and a session cookie is written back without an expiry.
	const sessionCookie = toStorageCookie({
		name: 'a',
		value: 'b',
		domain: 'x.test',
		path: '/',
		expires: -1,
		httpOnly: false,
		secure: false,
		session: true,
	});
	assertEquals(sessionCookie.expires, -1);
	assertEquals(sessionCookie.sameSite, 'Lax', 'CDP omits sameSite far more often than it sets None');
	assertEquals('expires' in toCookieParam(sessionCookie), false);
});

Deno.test('storage-state: the diff key is (name, domain, path) and the fingerprint includes the value', () => {
	const base = storageCookie();
	assertEquals(cookieKey(base), 'session 127.0.0.1 /');
	assertEquals(cookieFingerprint([base]), cookieFingerprint([base]));
	assertEquals(
		cookieFingerprint([base]) === cookieFingerprint([{ ...base, value: 'rotated' }]),
		false,
		'a rotated token must look different or it is never persisted',
	);
	// Order must not matter: CDP does not promise one.
	const other = storageCookie({ name: 'other' });
	assertEquals(cookieFingerprint([base, other]), cookieFingerprint([other, base]));
});

Deno.test('storage-state: merge keeps file-only entries and lets the live browser win', () => {
	const existing: StorageState = {
		cookies: [storageCookie({ name: 'old', value: 'keep' }), storageCookie({ value: 'stale' })],
		// test-policy-allow: origin keys for the pure merge algebra — strings compared, never fetched.
		origins: [{ origin: 'http://a.test', localStorage: [{ name: 'k', value: 'old' }], sessionStorage: [] }],
	};
	const live: StorageState = {
		cookies: [storageCookie({ value: 'fresh' })],
		// test-policy-allow: same origin key on the live side of the merge.
		origins: [{ origin: 'http://a.test', localStorage: [{ name: 'k', value: 'new' }], sessionStorage: [] }],
	};
	const merged = mergeStorageState(existing, live);
	assertEquals(merged.cookies.length, 2);
	assertEquals(merged.cookies.find((cookie) => cookie.name === 'session')?.value, 'fresh');
	assertEquals(merged.cookies.find((cookie) => cookie.name === 'old')?.value, 'keep');
	assertEquals(merged.origins[0]?.localStorage[0]?.value, 'new');
});

Deno.test('storage-state: parsing is defensive — junk degrades, it does not throw', () => {
	assertEquals(parseStorageState('[]').state, emptyStorageState());
	assertEquals(parseStorageState('null').error, 'storage state is not an object');
	assert(parseStorageState('{oops').error?.includes('not valid JSON'));

	const partial = parseStorageState(JSON.stringify({
		cookies: [{ name: 'a' }, { nope: true }, 'string'],
		// test-policy-allow: malformed-document parser input — a string in a JSON blob, never fetched.
		origins: [{ origin: 'http://a.test', localStorage: [{ name: 'k' }, 7] }],
	}));
	assertEquals(partial.error, null);
	assertEquals(partial.state.cookies.length, 1);
	assertEquals(partial.state.cookies[0]?.path, '/');
	assertEquals(partial.state.cookies[0]?.expires, -1);
	assertEquals(partial.state.origins[0]?.localStorage, [{ name: 'k', value: '' }]);
	assertEquals(partial.state.origins[0]?.sessionStorage, []);
});

Deno.test('R1-1, ERRATUM(E-109): an unparseable document is reported without quoting any of it', () => {
	// The reason is logged, and a cookie jar is a credential store. V8's own message quotes the document's text — all of
	// it when short, its start otherwise — so a truncated or corrupted file would put a cookie value into the log.
	for (const text of ['Q7SENTINEL-session-cookie', '{"cookies": [{"name": "s", "value": "Q7SENTINEL"},, ]}']) {
		const error = parseStorageState(text).error ?? '';
		assert(!error.includes('Q7SENTINEL') && !error.includes('Unexpected token'), error);
		assert(/^storage state is not valid JSON( at position \d+)?$/.test(error), error);
	}
});

Deno.test('storage-state: origins are http(s) only, and descriptions carry counts only', () => {
	assertEquals(originOf('http://127.0.0.1:1/a/b?c=1'), 'http://127.0.0.1:1');
	assertEquals(originOf('about:blank'), null);
	assertEquals(originOf('chrome://newtab'), null);
	assertEquals(originOf('nonsense'), null);

	const described = describeStorageState({ cookies: [storageCookie()], origins: [] });
	assertEquals(described, { cookiesCount: 1, originsCount: 0 });
	assertEquals(JSON.stringify(described).includes('abc123'), false);
});

Deno.test('storage-state: a watchdog with nothing configured has no path and writes nothing', async () => {
	const bus = new EventBus({ name: 'ss', logger: silentBusLogger });
	try {
		const watchdog = new StorageStateWatchdog({
			eventBus: bus,
			profile: createBrowserProfile(),
			logger: silentBusLogger,
			cdpClient: null,
			sessionManager: null,
			cdpUrl: null,
			isLocal: true,
		});
		assertEquals(watchdog.storagePath, null);
		assertEquals(watchdog.monitoring, false);
		// A stop before any load is a no-op, not a crash on the missing CDP client.
		await watchdog.onBrowserStopEvent(new BrowserStopEvent());
	} finally {
		await bus.stop();
	}
});
