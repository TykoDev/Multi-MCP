/**
 * `HarRecordingWatchdog` contract (ARCHITECTURE.md §6.13; COMPLETIONS-CRITERIA.md §3.2 watchdog row
 * 13: "Network event capture, HAR 1.2 JSON on stop").
 *
 * Real bus, real `CdpClient`, real `Network.*` frames over `ChromeFixture`, real files in
 * `tests/.scratch`. The centrepiece is {@linkcode harProblems}: a structural validator for the HAR
 * 1.2 required-key set, run over every document these tests produce. Asserting one field at a time
 * would let an entry that no HAR viewer can open pass as "captured".
 */

import { assert, assertEquals } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { fromFileUrl, join } from '@std/path';
import { EventBus, type HandlerContext, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { BrowserConnectedEvent, BrowserStopEvent } from '../events.ts';
import { type BrowserProfileInit, createBrowserProfile } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import {
	HAR_BODY_TIMEOUT_MS,
	HAR_CONTENT_DIR_SUFFIX,
	HAR_CREATOR_NAME,
	HAR_CREATOR_VERSION,
	HAR_PAGE_ID,
	HAR_UNKNOWN,
	HAR_VERSION,
	type HarDocument,
	harEntryTime,
	HarRecordingWatchdog,
	type HarTimings,
	parseRequestCookies,
	parseResponseCookies,
	shouldAttachHarRecordingWatchdog,
	toHarHeaders,
	toHarQueryString,
	toHarTimings,
} from './har_recording.ts';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../../tests/.scratch', import.meta.url));
const PAGE = 'http://127.0.0.1:8080/index.html';

// ---------------------------------------------------------------------------
// the HAR 1.2 structural validator
// ---------------------------------------------------------------------------

const LOG_KEYS = ['version', 'creator', 'entries'] as const;
const ENTRY_KEYS = ['startedDateTime', 'time', 'request', 'response', 'cache', 'timings'] as const;
const REQUEST_KEYS = ['method', 'url', 'httpVersion', 'cookies', 'headers', 'queryString', 'headersSize', 'bodySize'];
const RESPONSE_KEYS = [
	'status',
	'statusText',
	'httpVersion',
	'cookies',
	'headers',
	'content',
	'redirectURL',
	'headersSize',
	'bodySize',
];
const TIMING_KEYS = ['send', 'wait', 'receive'] as const;

/** Every way the document departs from HAR 1.2's required-member set. Empty means conforming. */
export function harProblems(document: unknown): string[] {
	const problems: string[] = [];
	const record = (value: unknown): Record<string, unknown> | null =>
		typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;

	const root = record(document);
	const log = root === null ? null : record(root.log);
	if (log === null) return ['log: missing'];
	for (const key of LOG_KEYS) if (!(key in log)) problems.push(`log.${key}: missing`);
	if (log.version !== '1.2') problems.push(`log.version: expected 1.2, got ${String(log.version)}`);
	const creator = record(log.creator);
	if (creator === null || typeof creator.name !== 'string' || typeof creator.version !== 'string') {
		problems.push('log.creator: needs {name, version}');
	}
	if (!Array.isArray(log.entries)) return [...problems, 'log.entries: not an array'];

	const pageIds = new Set<string>();
	if (log.pages !== undefined) {
		if (!Array.isArray(log.pages)) problems.push('log.pages: not an array');
		else {
			for (const [index, raw] of log.pages.entries()) {
				const page = record(raw);
				if (page === null) {
					problems.push(`pages[${index}]: not an object`);
					continue;
				}
				for (const key of ['startedDateTime', 'id', 'title', 'pageTimings']) {
					if (!(key in page)) problems.push(`pages[${index}].${key}: missing`);
				}
				if (typeof page.id === 'string') pageIds.add(page.id);
			}
		}
	}

	for (const [index, raw] of log.entries.entries()) {
		const entry = record(raw);
		if (entry === null) {
			problems.push(`entries[${index}]: not an object`);
			continue;
		}
		for (const key of ENTRY_KEYS) if (!(key in entry)) problems.push(`entries[${index}].${key}: missing`);
		if (typeof entry.startedDateTime === 'string' && Number.isNaN(Date.parse(entry.startedDateTime))) {
			problems.push(`entries[${index}].startedDateTime: not ISO-8601`);
		}
		if (typeof entry.time !== 'number' || entry.time < 0) problems.push(`entries[${index}].time: not a number ≥ 0`);
		if (entry.pageref !== undefined && !pageIds.has(String(entry.pageref))) {
			problems.push(`entries[${index}].pageref: dangles (${String(entry.pageref)})`);
		}

		const request = record(entry.request);
		if (request === null) problems.push(`entries[${index}].request: not an object`);
		else {
			for (const key of REQUEST_KEYS) if (!(key in request)) problems.push(`entries[${index}].request.${key}: missing`);
			for (const key of ['cookies', 'headers', 'queryString']) {
				if (!Array.isArray(request[key])) problems.push(`entries[${index}].request.${key}: not an array`);
			}
		}

		const response = record(entry.response);
		if (response === null) problems.push(`entries[${index}].response: not an object`);
		else {
			for (const key of RESPONSE_KEYS) {
				if (!(key in response)) problems.push(`entries[${index}].response.${key}: missing`);
			}
			const content = record(response.content);
			if (content === null || typeof content.size !== 'number' || typeof content.mimeType !== 'string') {
				problems.push(`entries[${index}].response.content: needs {size:number, mimeType:string}`);
			}
		}

		const timings = record(entry.timings);
		if (timings === null) problems.push(`entries[${index}].timings: not an object`);
		else {
			for (const key of TIMING_KEYS) {
				if (typeof timings[key] !== 'number' || (timings[key] as number) < 0) {
					problems.push(`entries[${index}].timings.${key}: required and must be ≥ 0`);
				}
			}
			// HAR 1.2: `time` is the sum of the phases that apply (-1 = does not apply).
			const sum = Object.values(timings)
				.filter((value): value is number => typeof value === 'number' && value >= 0)
				.reduce((total, value) => total + value, 0);
			if (sum !== entry.time) problems.push(`entries[${index}].time (${String(entry.time)}) ≠ Σ timings (${sum})`);
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly client: CdpClient;
	readonly watchdog: HarRecordingWatchdog;
	readonly harPath: string;
	readonly sessionId: string;
	clock: { value: number };
	sent(method: string): FixtureRequest[];
	request(requestId: string, url: string, extra?: Record<string, unknown>): void;
	respond(requestId: string, extra?: Record<string, unknown>): void;
	finish(requestId: string, encodedDataLength?: number): void;
	settle(): Promise<void>;
}

async function harness(profile: BrowserProfileInit = {}): Promise<Harness> {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	const scratch = await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix: 'bua-har-' });
	const harPath = join(scratch, 'out', 'session.har');

	const fixture = ChromeFixture.start({ pages: [PAGE] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'har-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();
	const page = manager.mostRecentPageTarget();
	assert(page !== null);
	await manager.getOrCreateCdpSession(page.targetId, false);
	await manager.whenIdle();
	const sessionId = fixture.sessionFor(page.targetId);
	assert(sessionId !== null);

	fixture.script('Network.getResponseBody', (request, self) => {
		self.reply(request.id, { body: '<!doctype html><title>hi</title>', base64Encoded: false });
	});

	const clock = { value: Date.parse('2026-08-13T10:00:00.000Z') };
	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile({ recordHarPath: harPath, ...profile }),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new HarRecordingWatchdog(host, { now: () => clock.value });
	watchdog.attach();

	const settle = async (): Promise<void> => {
		await client.send.Browser.getVersion();
		await manager.whenIdle();
		await watchdog.whenIdle();
	};

	return {
		fixture,
		bus,
		manager,
		client,
		watchdog,
		harPath,
		sessionId,
		clock,
		sent: (method) => fixture.requestsFor(method),
		request: (requestId, url, extra = {}) => {
			fixture.emit('Network.requestWillBeSent', {
				requestId,
				loaderId: 'LOADER1',
				documentURL: PAGE,
				request: {
					url,
					method: 'GET',
					headers: { 'Cookie': 'sid=abc; theme=dark', 'User-Agent': 'bua/test' },
					initialPriority: 'VeryHigh',
					referrerPolicy: 'no-referrer',
				},
				timestamp: 1,
				wallTime: 1,
				initiator: { type: 'other' },
				type: 'Document',
				...extra,
			}, sessionId);
		},
		respond: (requestId, extra = {}) => {
			fixture.emit('Network.responseReceived', {
				requestId,
				loaderId: 'LOADER1',
				timestamp: 2,
				type: 'Document',
				response: {
					url: PAGE,
					status: 200,
					statusText: 'OK',
					headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=abc; Path=/' },
					mimeType: 'text/html',
					connectionReused: false,
					connectionId: 12,
					remoteIPAddress: '127.0.0.1',
					remotePort: 8080,
					encodedDataLength: 512,
					protocol: 'http/1.1',
					...extra,
				},
			}, sessionId);
		},
		finish: (requestId, encodedDataLength = 512) => {
			fixture.emit('Network.loadingFinished', { requestId, timestamp: 3, encodedDataLength }, sessionId);
		},
		settle,
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await manager.stop();
			await bus.stop();
			await client.close();
			await fixture.close();
			await Deno.remove(scratch, { recursive: true }).catch(() => {});
		},
	};
}

/**
 * One full request cycle, settling between frames: the injected clock only means anything if each
 * frame has actually been *processed* before it advances.
 */
async function record(h: Harness, requestId = 'REQ1'): Promise<void> {
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.request(requestId, PAGE + '?q=deno&page=2');
	await h.settle();
	h.clock.value += 40;
	h.respond(requestId);
	await h.settle();
	h.clock.value += 60;
	h.finish(requestId);
	await h.settle();
}

// ---------------------------------------------------------------------------
// conditional attachment, constants, pure helpers
// ---------------------------------------------------------------------------

Deno.test('har: the watchdog is conditional on recordHarPath', () => {
	assertEquals(shouldAttachHarRecordingWatchdog({ recordHarPath: null }), false);
	assertEquals(shouldAttachHarRecordingWatchdog({ recordHarPath: '/tmp/a.har' }), true);
	assertEquals(HAR_VERSION, '1.2');
	assertEquals(HAR_CREATOR_NAME, 'bua');
	assertEquals(HAR_CREATOR_VERSION, '0.2.0');
	assertEquals(HAR_UNKNOWN, -1);
});

Deno.test('har: the creator version tracks the package version', async () => {
	const manifest = JSON.parse(
		await Deno.readTextFile(fromFileUrl(new URL('../../deno.json', import.meta.url))),
	) as { version: string };
	assertEquals(HAR_CREATOR_VERSION, manifest.version);
});

Deno.test('har: header, query and cookie conversion follow the HAR shapes', () => {
	assertEquals(toHarHeaders({ A: '1', B: '2' }), [{ name: 'A', value: '1' }, { name: 'B', value: '2' }]);
	assertEquals(toHarHeaders(undefined), []);
	assertEquals(toHarQueryString('http://127.0.0.1/x?a=1&b=two'), [
		{ name: 'a', value: '1' },
		{ name: 'b', value: 'two' },
	]);
	assertEquals(toHarQueryString('not a url'), []);
	assertEquals(parseRequestCookies({ cookie: 'sid=abc; theme=dark' }), [
		{ name: 'sid', value: 'abc' },
		{ name: 'theme', value: 'dark' },
	]);
	assertEquals(parseResponseCookies({ 'set-cookie': 'sid=abc; Path=/; HttpOnly' }), [{ name: 'sid', value: 'abc' }]);
});

Deno.test('har: an unknown timing breakdown puts the whole duration into wait, keeping the sum invariant', () => {
	const timings = toHarTimings(undefined, 250);
	assertEquals(timings, { blocked: -1, dns: -1, connect: -1, send: 0, wait: 250, receive: 0, ssl: -1 });
	assertEquals(harEntryTime(timings), 250);
});

Deno.test('har: a real ResourceTiming decomposes into phases that still sum to time', () => {
	const timings: HarTimings = toHarTimings({
		requestTime: 100,
		proxyStart: -1,
		proxyEnd: -1,
		dnsStart: 1,
		dnsEnd: 5,
		connectStart: 5,
		connectEnd: 12,
		sslStart: 6,
		sslEnd: 11,
		sendStart: 12,
		sendEnd: 14,
		receiveHeadersEnd: 40,
	}, 60);
	assertEquals(timings.dns, 4);
	assertEquals(timings.connect, 7);
	assertEquals(timings.ssl, 5);
	assertEquals(timings.send, 2);
	assertEquals(timings.wait, 26);
	assert(timings.receive >= 0);
	assertEquals(harEntryTime(timings), 60 + Math.max(0, timings.ssl));
});

// ---------------------------------------------------------------------------
// capture → document
// ---------------------------------------------------------------------------

Deno.test('har: one request/response cycle yields one HAR 1.2-conforming entry', async () => {
	await using h = await harness();
	await record(h);

	const document = h.watchdog.buildDocument();
	assertEquals(harProblems(document), []);
	assertEquals(document.log.entries.length, 1);

	const entry = document.log.entries[0];
	assert(entry !== undefined);
	assertEquals(entry.request.method, 'GET');
	assertEquals(entry.request.queryString, [{ name: 'q', value: 'deno' }, { name: 'page', value: '2' }]);
	assertEquals(entry.request.cookies, [{ name: 'sid', value: 'abc' }, { name: 'theme', value: 'dark' }]);
	assertEquals(entry.response.status, 200);
	assertEquals(entry.response.httpVersion, 'HTTP/1.1');
	assertEquals(entry.response.cookies, [{ name: 'sid', value: 'abc' }]);
	assertEquals(entry.response.bodySize, 512);
	assertEquals(entry.serverIPAddress, '127.0.0.1');
	assertEquals(entry.connection, '12');
	assertEquals(entry._resourceType, 'Document');
	assertEquals(entry.time, 100, 'the injected clock advanced 40 + 60 ms');
	assertEquals(entry.pageref, HAR_PAGE_ID);
	assertEquals(document.log.pages[0]?.id, HAR_PAGE_ID);
});

Deno.test('har: a redirect closes the first hop and opens a second entry on the same requestId', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.request('REQ1', 'http://127.0.0.1:8080/old');
	h.clock.value += 10;
	h.request('REQ1', 'http://127.0.0.1:8080/new', {
		redirectResponse: {
			url: 'http://127.0.0.1:8080/old',
			status: 302,
			statusText: 'Found',
			headers: { Location: 'http://127.0.0.1:8080/new' },
			mimeType: '',
			connectionReused: false,
			connectionId: 1,
			encodedDataLength: 0,
			protocol: 'http/1.1',
		},
	});
	h.clock.value += 10;
	h.respond('REQ1');
	h.finish('REQ1');
	await h.settle();

	const document = h.watchdog.buildDocument();
	assertEquals(harProblems(document), []);
	assertEquals(document.log.entries.length, 2);
	assertEquals(document.log.entries[0]?.response.status, 302);
	assertEquals(document.log.entries[0]?.response.redirectURL, 'http://127.0.0.1:8080/new');
	assertEquals(document.log.entries[1]?.request.url, 'http://127.0.0.1:8080/new');
});

Deno.test('har: a failed request is still an entry, carrying the error text', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.request('REQ1', 'http://127.0.0.1:8080/dead');
	h.fixture.emit('Network.loadingFailed', {
		requestId: 'REQ1',
		timestamp: 2,
		type: 'Document',
		errorText: 'net::ERR_CONNECTION_REFUSED',
	}, h.sessionId);
	await h.settle();

	const document = h.watchdog.buildDocument();
	assertEquals(harProblems(document), []);
	assertEquals(document.log.entries[0]?.response.status, 0);
	assertEquals(document.log.entries[0]?._errorText, 'net::ERR_CONNECTION_REFUSED');
	assertEquals(h.sent('Network.getResponseBody').length, 0, 'a failed request has no body to fetch');
});

// ---------------------------------------------------------------------------
// recordHarContent / recordHarMode (ERRATUM(M1-watchdogs-rest-10))
// ---------------------------------------------------------------------------

Deno.test('har: embed puts the body inline in content.text', async () => {
	await using h = await harness({ recordHarContent: 'embed' });
	await record(h);

	assertEquals(h.sent('Network.getResponseBody').length, 1);
	const content = h.watchdog.buildDocument().log.entries[0]?.response.content;
	assertEquals(content?.text, '<!doctype html><title>hi</title>');
	assertEquals(content?.encoding, undefined, 'a text body needs no encoding marker');
	assertEquals(content?._file, undefined);
});

Deno.test('har: a body fetch that never returns is capped, and the entry survives without it', async () => {
	await using h = await harness({ recordHarContent: 'embed' });
	h.fixture.script('Network.getResponseBody', () => {
		// Never replies: without the cap this entry would be stuck behind the 60 s CDP timeout, and a
		// `BrowserStopEvent` arriving first would drop it from the document entirely.
	});
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.request('REQ1', PAGE);
	await h.settle();
	h.respond('REQ1');
	await h.settle();

	using time = new FakeTime();
	h.finish('REQ1');
	await h.client.send.Browser.getVersion();
	assertEquals(h.watchdog.entries.length, 0, 'the entry is still waiting on its body');
	await time.tickAsync(HAR_BODY_TIMEOUT_MS + 1);
	await h.watchdog.whenIdle();

	assertEquals(HAR_BODY_TIMEOUT_MS, 5_000);
	assertEquals(h.watchdog.entries.length, 1, 'the entry lands with its metadata intact');
	assertEquals(h.watchdog.entries[0]?.response.content.text, undefined);
	assertEquals(h.watchdog.entries[0]?.response.status, 200);
});

Deno.test('har: omit never asks for a body at all', async () => {
	await using h = await harness({ recordHarContent: 'omit' });
	await record(h);

	assertEquals(h.sent('Network.getResponseBody').length, 0);
	const document = h.watchdog.buildDocument();
	assertEquals(harProblems(document), []);
	assertEquals(document.log.entries[0]?.response.content.text, undefined);
});

Deno.test('har: attach writes the body beside the HAR and references it', async () => {
	await using h = await harness({ recordHarContent: 'attach' });
	await record(h);
	await h.watchdog.write();

	const entry = h.watchdog.buildDocument().log.entries[0];
	assertEquals(entry?.response.content.text, undefined);
	const file = entry?.response.content._file;
	assert(file !== undefined);
	const written = await Deno.readTextFile(join(`${h.harPath}${HAR_CONTENT_DIR_SUFFIX}`, file));
	assertEquals(written, '<!doctype html><title>hi</title>');
});

Deno.test('har: minimal drops cookies, post data and bodies but stays a valid HAR', async () => {
	await using h = await harness({ recordHarMode: 'minimal' });
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.request('REQ1', PAGE, {
		request: {
			url: PAGE,
			method: 'POST',
			headers: { 'Cookie': 'sid=abc', 'Content-Type': 'application/json' },
			postData: '{"a":1}',
			initialPriority: 'High',
			referrerPolicy: '',
		},
	});
	h.respond('REQ1');
	h.finish('REQ1');
	await h.settle();

	assertEquals(h.watchdog.content, 'omit', 'minimal implies no body fetch whatever recordHarContent says');
	assertEquals(h.sent('Network.getResponseBody').length, 0);
	const document = h.watchdog.buildDocument();
	assertEquals(harProblems(document), []);
	assertEquals(document.log.entries[0]?.request.cookies, []);
	assertEquals(document.log.entries[0]?.response.cookies, []);
	assertEquals(document.log.entries[0]?.request.postData, undefined);
	assertEquals(document.log.entries[0]?.request.headers.length, 2, 'headers stay — routing needs them');
});

// ---------------------------------------------------------------------------
// writing on stop
// ---------------------------------------------------------------------------

Deno.test('har: stop writes a parseable, conforming HAR to recordHarPath', async () => {
	await using h = await harness();
	await record(h);

	await h.bus.dispatch(new BrowserStopEvent());

	const document = JSON.parse(await Deno.readTextFile(h.harPath)) as HarDocument;
	assertEquals(harProblems(document), []);
	assertEquals(document.log.version, '1.2');
	assertEquals(document.log.creator, { name: HAR_CREATOR_NAME, version: HAR_CREATOR_VERSION });
	assertEquals(document.log.entries.length, 1);
	assertEquals(h.watchdog.armed, false, 'the listeners come off with the write');
});

Deno.test('har: an empty capture is still a valid HAR with no pages and no entries', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	await h.bus.dispatch(new BrowserStopEvent());

	const document = JSON.parse(await Deno.readTextFile(h.harPath)) as HarDocument;
	assertEquals(harProblems(document), []);
	assertEquals(document.log.entries, []);
	assertEquals(document.log.pages, []);
});

Deno.test('ERRATUM(CANCEL-3): an abandoned stop drops the body drain but still writes the HAR', async () => {
	await using h = await harness({ recordHarContent: 'embed' });
	await record(h);
	assertEquals(h.watchdog.entries.length, 1);

	// A second request whose body never comes back. Draining it would cost a 5 s cap per round, up to
	// ten rounds — which is how a 45 s stop budget gets exceeded by the drain alone.
	h.fixture.script('Network.getResponseBody', () => {});
	h.request('REQ2', PAGE);
	await h.settle();
	h.respond('REQ2');
	await h.settle();

	using time = new FakeTime();
	h.finish('REQ2');
	await h.client.send.Browser.getVersion();
	assertEquals(h.watchdog.entries.length, 1, 'REQ2 is still waiting on its body');

	const context: HandlerContext = {
		signal: AbortSignal.abort(),
		handlerName: 'HarRecordingWatchdog.onBrowserStopEvent',
		timeoutSec: 45,
	};
	await h.watchdog.onBrowserStopEvent(new BrowserStopEvent(), context);

	// The asymmetry: the drain is abandoned, the document is not. `recordHarPath` is a location the
	// caller named and nothing else will ever write it.
	const document = JSON.parse(await Deno.readTextFile(h.harPath)) as HarDocument;
	assertEquals(harProblems(document), []);
	assertEquals(document.log.entries.length, 1, 'written with what settled, rather than withheld');
	assertEquals(h.watchdog.armed, false, 'the listeners come off whatever the budget says');

	// Let the outstanding capture expire so the test owns no live op when it ends.
	await time.tickAsync(HAR_BODY_TIMEOUT_MS + 1);
	await h.watchdog.whenIdle();
});

Deno.test('har: no recordHarPath means no listeners and no file', async () => {
	await using h = await harness({ recordHarPath: null });
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.watchdog.armed, false);
	h.request('REQ1', PAGE);
	h.respond('REQ1');
	h.finish('REQ1');
	await h.settle();
	assertEquals(h.watchdog.entries, []);
	assertEquals(await h.watchdog.write(), null);
});

Deno.test('har: detach unregisters the Network listeners', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.watchdog.armed, true);
	h.watchdog.detach();
	assertEquals(h.watchdog.armed, false);

	h.request('REQ1', PAGE);
	h.respond('REQ1');
	h.finish('REQ1');
	await h.settle();
	assertEquals(h.watchdog.entries, []);
	assertEquals(h.watchdog.pendingCount, 0);
});
