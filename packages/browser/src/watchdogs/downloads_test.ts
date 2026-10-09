/**
 * `DownloadsWatchdog` contract tests (ARCHITECTURE.md §6.8; COMPLETIONS-CRITERIA.md §3.2 watchdog
 * row 8; SECURITY-AUTH.md §8.3 download containment; DATA-MODEL.md §5.1.6).
 *
 * Row 8 asks for: `setDownloadBehavior`, filename sanitization, Started/Progress/FileDownloaded
 * events, the click-download sync callback, auto-PDF (default on), and remote-browser no-local-write.
 * Each has a test below whose name says so.
 *
 * Everything is real: a `Deno.serve` CDP endpoint (`ChromeFixture`) pushing real
 * `Browser.downloadWillBegin` / `downloadProgress` frames over a real socket into a real
 * `BrowserSession`, and — for the completion path — real files under `tests/.scratch`, the only
 * directory the tier-1 matrix grants `--allow-write` for.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { exists } from '@std/fs';
import { basename, dirname, join } from '@std/path';
import { fromFileUrl } from '@std/path';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import {
	BrowserErrorEvent,
	BrowserStateRequestEvent,
	DownloadProgressEvent,
	DownloadStartedEvent,
	FileDownloadedEvent,
	NavigationCompleteEvent,
} from '../events.ts';
import { createBrowserProfile } from '../types.ts';
import { isContainedIn } from '../security/containment.ts';
import { BrowserSession } from '../browser/session.ts';
import { ChromeFixture } from '../browser/cdp_fixture_test.ts';
import {
	autoDownloadExpression,
	DOWNLOAD_COMPLETION_TIMEOUT_MS,
	DOWNLOAD_SETTLE_GRACE_MS,
	DOWNLOAD_START_GRACE_MS,
	type DownloadRecord,
	type DownloadSignal,
	DownloadsWatchdog,
	type DownloadsWatchdogOptions,
	fileTypeOf,
	isDownloadRetrievable,
	isSafeDownloadGuid,
	looksLikePdfUrl,
	PARTIAL_REMOVE_ATTEMPTS,
	removeWithRetry,
	shouldAutoDownload,
} from './downloads.ts';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../../tests/.scratch', import.meta.url));

async function scratchDir(prefix: string): Promise<string> {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	return await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix });
}

/** Records every filesystem call so the remote-browser contract can assert "none happened". */
interface FsRecorder {
	readonly ensured: string[];
	readonly stated: string[];
	readonly removed: string[];
	readonly realPathed: string[];
	readonly options: DownloadsWatchdogOptions;
}

function fsRecorder(overrides: Partial<DownloadsWatchdogOptions> = {}): FsRecorder {
	const ensured: string[] = [];
	const stated: string[] = [];
	const removed: string[] = [];
	const realPathed: string[] = [];
	return {
		ensured,
		stated,
		removed,
		realPathed,
		options: {
			ensureDir: (path) => {
				ensured.push(path);
				return Promise.resolve();
			},
			statFile: (path) => {
				stated.push(path);
				return Promise.resolve({ size: 0, isFile: true });
			},
			removeFile: (path) => {
				removed.push(path);
				return Promise.resolve();
			},
			realPath: (path) => {
				realPathed.push(path);
				return Promise.resolve(path);
			},
			...overrides,
		},
	};
}

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly session: BrowserSession;
	readonly watchdog: DownloadsWatchdog;
	readonly events: {
		started: DownloadStartedEvent[];
		progress: DownloadProgressEvent[];
		done: FileDownloadedEvent[];
		errors: BrowserErrorEvent[];
	};
	willBegin(init: { guid: string; url: string; suggestedFilename: string }): Promise<void>;
	progress(
		init: { guid: string; receivedBytes: number; totalBytes: number; state: 'inProgress' | 'completed' | 'canceled' },
	): Promise<void>;
	/** Pushes a raw CDP event and waits until the watchdog has finished reacting to it. */
	push(method: 'Network.responseReceived', params: Record<string, unknown>, sessionId?: string): Promise<void>;
}

async function harness(options: {
	downloadsDir?: string | null;
	isLocal?: boolean;
	profile?: Record<string, unknown>;
	watchdogOptions?: DownloadsWatchdogOptions;
} = {}): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages: ['http://127.0.0.1:1/index.html'] });
	const session = new BrowserSession({
		profile: createBrowserProfile({
			cdpUrl: fixture.wsUrl,
			// Attaching to a CDP URL infers a *remote* browser (`resolveIsLocal`, DATA-MODEL.md §5.2);
			// the local-browser tests say so explicitly rather than relying on that inference.
			isLocal: options.isLocal ?? true,
			downloadsPath: options.downloadsDir ?? null,
			...options.profile,
		}),
		logger: silentBusLogger,
	});
	const watchdog = new DownloadsWatchdog(session, options.watchdogOptions ?? {});
	const events = {
		started: [] as DownloadStartedEvent[],
		progress: [] as DownloadProgressEvent[],
		done: [] as FileDownloadedEvent[],
		errors: [] as BrowserErrorEvent[],
	};
	session.eventBus.on(DownloadStartedEvent, (event) => void events.started.push(event), { wrap: null });
	session.eventBus.on(DownloadProgressEvent, (event) => void events.progress.push(event), { wrap: null });
	session.eventBus.on(FileDownloadedEvent, (event) => void events.done.push(event), { wrap: null });
	session.eventBus.on(BrowserErrorEvent, (event) => void events.errors.push(event), { wrap: null });
	watchdog.attach();
	await session.start();

	/**
	 * The delivery barrier.
	 *
	 * `fixture.emit()` only *writes* a frame; the client has not seen it when `emit` returns. A CDP
	 * command issued afterwards cannot be answered before the earlier frame has been delivered (one
	 * socket, ordered), so a round trip is a precise "the event has been processed" barrier — and a
	 * far better one than a sleep, which would be a race with a longer fuse.
	 */
	const flush = async (): Promise<void> => {
		const client = session.cdpClient;
		assert(client !== null);
		await client.send.Target.getTargets({});
		await watchdog.whenIdle();
	};

	return {
		fixture,
		session,
		watchdog,
		events,
		willBegin: async (init) => {
			fixture.emit('Browser.downloadWillBegin', { frameId: 'FRAME-1', ...init });
			await flush();
		},
		progress: async (init) => {
			fixture.emit('Browser.downloadProgress', init);
			await flush();
		},
		push: async (method, params, sessionId) => {
			fixture.emit(method, params, sessionId);
			await flush();
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
// constants
// ---------------------------------------------------------------------------

Deno.test('downloads: the ARCHITECTURE §6.8/§6.10 download clock is encoded verbatim', () => {
	assertEquals(DOWNLOAD_START_GRACE_MS, 500);
	assertEquals(DOWNLOAD_COMPLETION_TIMEOUT_MS, 30_000);
	assertEquals(DOWNLOAD_SETTLE_GRACE_MS, 500);
});

// ---------------------------------------------------------------------------
// setDownloadBehavior
// ---------------------------------------------------------------------------

Deno.test('downloads: setDownloadBehavior points at the profile dir with events enabled', async () => {
	const dir = await scratchDir('bua-dl-behavior-');
	try {
		await using h = await harness({ downloadsDir: dir });
		const calls = h.fixture.requestsFor('Browser.setDownloadBehavior');
		assertEquals(calls.length, 1);
		// E-33: `allowAndName` — Chromium names the file by guid, so the recorded path is the written path.
		assertEquals(calls[0]?.params.behavior, 'allowAndName');
		assertEquals(calls[0]?.params.downloadPath, dir);
		// Without `eventsEnabled` Chrome never fires downloadWillBegin/downloadProgress at all.
		assertEquals(calls[0]?.params.eventsEnabled, true);
		assertEquals(h.watchdog.downloadsDir, dir);
		assertEquals(h.watchdog.isRemoteBrowser, false);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: acceptDownloads=false denies downloads outright', async () => {
	await using h = await harness({ profile: { acceptDownloads: false } });
	const calls = h.fixture.requestsFor('Browser.setDownloadBehavior');
	assertEquals(calls[0]?.params.behavior, 'deny');
});

/** A PDF document response on the fixture's first target, for the sniffer legs. */
function pdfResponse(h: Harness, url: string): { params: Record<string, unknown>; sessionId: string } {
	const targetId = h.fixture.targets[0]?.targetId;
	assert(targetId !== undefined);
	const sessionId = h.fixture.sessionFor(targetId);
	assert(sessionId !== null);
	return {
		sessionId,
		params: {
			requestId: `R-${url}`,
			loaderId: 'L1',
			timestamp: 1,
			type: 'Document',
			response: { url, status: 200, statusText: 'OK', headers: {}, mimeType: 'application/pdf' },
		},
	};
}

Deno.test('downloads: ERRATUM(E-77) acceptDownloads is re-applied at runtime both ways, and the profile follows', async () => {
	const recorder = fsRecorder();
	await using h = await harness({
		downloadsDir: '/local/downloads',
		profile: { acceptDownloads: false },
		watchdogOptions: recorder.options,
	});
	assertEquals(h.fixture.requestsFor('Browser.setDownloadBehavior')[0]?.params.behavior, 'deny');
	assertEquals(recorder.ensured, [], 'a denying connect creates no directory');

	// Off → on: the behaviour an accepting profile gets at connect, into the same directory, created first.
	assertEquals(await h.watchdog.setAcceptDownloads(true), true);
	const on = h.fixture.requestsFor('Browser.setDownloadBehavior')[1];
	assertEquals(on?.params.behavior, 'allowAndName');
	assertEquals(on?.params.downloadPath, '/local/downloads');
	assertEquals(on?.params.eventsEnabled, true);
	assertEquals(recorder.ensured, ['/local/downloads']);
	assertEquals(h.session.profile.acceptDownloads, true, 'the profile follows the browser');

	// The sniffer was not armed at a denying connect; it must be now, or auto-PDF silently stays off.
	const pdf = pdfResponse(h, 'http://127.0.0.1:1/late.pdf');
	await h.push('Network.responseReceived', pdf.params, pdf.sessionId);
	assertEquals(h.fixture.requestsFor('Runtime.evaluate').length, 1, 'the PDF sniffer is armed after the switch');

	// On → off.
	assertEquals(await h.watchdog.setAcceptDownloads(false), true);
	assertEquals(h.fixture.requestsFor('Browser.setDownloadBehavior')[2]?.params.behavior, 'deny');
	assertEquals(h.session.profile.acceptDownloads, false);
	const another = pdfResponse(h, 'http://127.0.0.1:1/after.pdf');
	await h.push('Network.responseReceived', another.params, another.sessionId);
	assertEquals(h.fixture.requestsFor('Runtime.evaluate').length, 1, 'nothing is auto-downloaded while denying');
});

Deno.test('downloads: ERRATUM(E-77) a remote browser is switched without a local path', async () => {
	const recorder = fsRecorder();
	await using h = await harness({
		downloadsDir: '/remote/downloads',
		isLocal: false,
		profile: { acceptDownloads: false },
		watchdogOptions: recorder.options,
	});
	assertEquals(await h.watchdog.setAcceptDownloads(true), true);
	const on = h.fixture.requestsFor('Browser.setDownloadBehavior')[1];
	assertEquals(on?.params.behavior, 'allow');
	assertEquals(on?.params.downloadPath, undefined, 'a remote browser is never handed one of our paths');
	assertEquals(recorder.ensured, [], 'and nothing is created locally for it');
});

Deno.test('downloads: ERRATUM(E-77) an unarmed watchdog changes nothing, the profile included', async () => {
	const fixture = ChromeFixture.start({ pages: ['http://127.0.0.1:1/index.html'] });
	try {
		const session = new BrowserSession({
			profile: createBrowserProfile({ cdpUrl: fixture.wsUrl, isLocal: true, acceptDownloads: true }),
			logger: silentBusLogger,
		});
		const watchdog = new DownloadsWatchdog(session, fsRecorder().options);
		// Never connected: there is no browser to tell, so the answer is "not applied" and the profile stands.
		assertEquals(await watchdog.setAcceptDownloads(false), false);
		assertEquals(session.profile.acceptDownloads, true);
		assertEquals(fixture.requestsFor('Browser.setDownloadBehavior'), []);
		await session.eventBus.stop();
	} finally {
		await fixture.close();
	}
});

Deno.test('downloads: ERRATUM(E-77) a refused runtime switch leaves the profile as it was', async () => {
	await using h = await harness({ downloadsDir: '/local/downloads', watchdogOptions: fsRecorder().options });
	assertEquals(h.session.profile.acceptDownloads, true);
	h.fixture.script('Browser.setDownloadBehavior', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Browser context management is not supported.' });
	});
	assertEquals(await h.watchdog.setAcceptDownloads(false), false);
	assertEquals(h.session.profile.acceptDownloads, true, 'the browser did not change, so neither does the profile');
});

// ---------------------------------------------------------------------------
// filename sanitization + containment (SECURITY-AUTH.md §8.3)
// ---------------------------------------------------------------------------

Deno.test('downloads: a traversal filename is reduced to a contained basename', async () => {
	const dir = await scratchDir('bua-dl-traversal-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({
			guid: 'G1',
			url: 'http://127.0.0.1:1/evil',
			suggestedFilename: '../../../../etc/passwd',
		});

		assertEquals(h.events.started.length, 1);
		assertEquals(h.events.started[0]?.suggestedFilename, '../../../../etc/passwd');
		const record = h.watchdog.downloads[0];
		assert(record !== undefined);
		assertEquals(record.fileName, 'passwd', 'sanitization reduces the name to a basename');
		assertEquals(dirname(record.path), dir);
		assertEquals(basename(record.path), 'G1', 'E-33: the disk name is the guid, never the suggested name');
		assert(isContainedIn(dir, record.path), 'the vetted path must resolve inside the downloads dir');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a name that cannot be sanitized is refused, never guessed', async () => {
	const dir = await scratchDir('bua-dl-refused-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/x', suggestedFilename: '..' });

		assertEquals(h.events.started.length, 0, 'a refused download never announces a start');
		assertEquals(h.events.errors.length, 1);
		assertEquals(h.events.errors[0]?.errorType, 'DownloadRejected');
		assertStringIncludes(h.events.errors[0]?.message ?? '', 'could not be sanitized');
		assertEquals(h.watchdog.downloadedFiles, []);
		// The browser is told to stop, since under `allowAndName` it would otherwise keep writing.
		assertEquals(h.fixture.requestsFor('Browser.cancelDownload').map((r) => r.params.guid), ['G1']);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a guid that cannot name a file is refused, never joined onto the directory', async () => {
	const dir = await scratchDir('bua-dl-badguid-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: '../escape', url: 'http://127.0.0.1:1/x', suggestedFilename: 'a.txt' });
		assertEquals(h.events.started.length, 0);
		assertEquals(h.events.errors[0]?.errorType, 'DownloadRejected');
		assertStringIncludes(h.events.errors[0]?.message ?? '', 'cannot name a file');
		assertEquals(h.watchdog.downloads[0]?.path, '', 'no path is ever synthesized for a refused guid');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: two downloads with the same suggested name get distinct display names and distinct files', async () => {
	const dir = await scratchDir('bua-dl-collide-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/r?first', suggestedFilename: 'report.pdf' });
		await h.willBegin({ guid: 'G2', url: 'http://127.0.0.1:1/r?second', suggestedFilename: 'report.pdf' });

		// The display names tell the two apart in a listing…
		assertEquals(h.watchdog.downloads.map((record) => record.fileName), ['report.pdf', 'report (1).pdf']);
		// …and the disk names are the guids, so neither can overwrite the other (the E-33 defect).
		assertEquals(h.watchdog.downloads.map((record) => basename(record.path)), ['G1', 'G2']);

		await Deno.writeTextFile(join(dir, 'G1'), 'first');
		await Deno.writeTextFile(join(dir, 'G2'), 'second');
		await h.progress({ guid: 'G1', receivedBytes: 5, totalBytes: 5, state: 'completed' });
		await h.progress({ guid: 'G2', receivedBytes: 6, totalBytes: 6, state: 'completed' });
		assertEquals(h.watchdog.downloads.map((record) => record.fileSize), [5, 6]);
		assertEquals(await Deno.readTextFile(h.watchdog.downloads[0]?.path ?? ''), 'first', 'the first payload survives');
		assertEquals(h.watchdog.downloads.every(isDownloadRetrievable), true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a progress event arriving right behind downloadWillBegin is not lost (E-33)', async () => {
	const dir = await scratchDir('bua-dl-fast-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await Deno.writeTextFile(join(dir, 'G1'), 'x');
		// Both frames are written back to back, with no barrier between them: the record must be
		// installed synchronously or the completion finds an unknown guid.
		h.fixture.emit('Browser.downloadWillBegin', {
			frameId: 'FRAME-1',
			guid: 'G1',
			url: 'http://127.0.0.1:1/tiny',
			suggestedFilename: 'tiny.txt',
		});
		await h.progress({ guid: 'G1', receivedBytes: 1, totalBytes: 1, state: 'completed' });

		assertEquals(h.events.done.length, 1, 'the tiny download completed and was tracked');
		assertEquals(h.watchdog.downloadedFiles.length, 1);
		assertEquals(isDownloadRetrievable(h.watchdog.downloads[0] as DownloadRecord), true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// the event trio
// ---------------------------------------------------------------------------

Deno.test('downloads: Started → Progress → FileDownloaded, with the real file size', async () => {
	const dir = await scratchDir('bua-dl-events-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		// The browser writes the file under its guid; the watchdog reads back what is actually there.
		await Deno.writeTextFile(join(dir, 'G1'), 'hello world');
		// Before completion the record is not retrievable, whatever its state says.
		assertEquals(isDownloadRetrievable(h.watchdog.downloads[0] as DownloadRecord), false);
		await h.progress({ guid: 'G1', receivedBytes: 6, totalBytes: 11, state: 'inProgress' });
		await h.progress({ guid: 'G1', receivedBytes: 11, totalBytes: 11, state: 'completed' });

		assertEquals(h.events.started.length, 1);
		assertEquals(h.events.progress.length, 2);
		assertEquals(h.events.done.length, 1);
		const done = h.events.done[0];
		assert(done !== undefined);
		assertEquals(done.fileName, 'a.txt');
		assertEquals(done.fileType, 'txt');
		assertEquals(done.fileSize, 11);
		assertEquals(done.autoDownload, false);
		assertEquals(basename(done.path), 'G1');
		assertEquals(h.watchdog.downloadedFiles, [done.path], 'downloadedFiles carries the real guid path');
		assertEquals(isDownloadRetrievable(h.watchdog.lookup('G1') as DownloadRecord), true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a completed download whose file is missing is a containment failure, not a file', async () => {
	const dir = await scratchDir('bua-dl-missing-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		await h.progress({ guid: 'G1', receivedBytes: 1, totalBytes: 1, state: 'completed' });

		assertEquals(h.events.done.length, 0);
		assertEquals(h.events.errors[0]?.errorType, 'DownloadContainmentFailed');
		assertEquals(h.watchdog.downloadedFiles, []);
		// `state` reads completed, `error` is set: the record is terminal and NOT retrievable.
		const record = h.watchdog.lookup('G1');
		assertEquals(record?.state, 'completed');
		assert(record?.error !== null);
		assertEquals(isDownloadRetrievable(record as DownloadRecord), false);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a completed download that is not a regular file is refused', async () => {
	const dir = await scratchDir('bua-dl-notfile-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		// Something planted a directory where the file should be.
		await Deno.mkdir(join(dir, 'G1'));
		await h.progress({ guid: 'G1', receivedBytes: 1, totalBytes: 1, state: 'completed' });

		assertEquals(h.events.done.length, 0);
		assertStringIncludes(h.events.errors[0]?.message ?? '', 'not a regular file');
		assertEquals(isDownloadRetrievable(h.watchdog.lookup('G1') as DownloadRecord), false);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a zero-byte regular file is a valid download', async () => {
	const dir = await scratchDir('bua-dl-empty-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/empty.txt', suggestedFilename: 'empty.txt' });
		await Deno.writeTextFile(join(dir, 'G1'), '');
		await h.progress({ guid: 'G1', receivedBytes: 0, totalBytes: 0, state: 'completed' });

		assertEquals(h.events.done[0]?.fileSize, 0);
		assertEquals(isDownloadRetrievable(h.watchdog.lookup('G1') as DownloadRecord), true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a file that resolves outside the downloads dir is refused', async () => {
	const dir = await scratchDir('bua-dl-escape-');
	const outside = await scratchDir('bua-dl-outside-');
	try {
		// The vetted path was inside; realpath says otherwise — the symlink case §8.3 exists for.
		const recorder = fsRecorder({
			realPath: (path) => Promise.resolve(path.endsWith('G1') ? join(outside, 'a.txt') : path),
		});
		await using h = await harness({ downloadsDir: dir, watchdogOptions: recorder.options });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		await h.progress({ guid: 'G1', receivedBytes: 1, totalBytes: 1, state: 'completed' });

		assertEquals(h.events.done.length, 0);
		assertEquals(h.events.errors[0]?.errorType, 'DownloadContainmentFailed');
		assertStringIncludes(h.events.errors[0]?.message ?? '', 'outside the downloads directory');
	} finally {
		await Deno.remove(dir, { recursive: true });
		await Deno.remove(outside, { recursive: true });
	}
});

Deno.test('downloads: a canceled download settles without producing a file', async () => {
	const dir = await scratchDir('bua-dl-cancel-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		// Chromium leaves a partial behind; the watchdog removes it.
		await Deno.writeTextFile(join(dir, 'G1.crdownload'), 'par');
		await h.progress({ guid: 'G1', receivedBytes: 3, totalBytes: 11, state: 'canceled' });
		assertEquals(h.events.done.length, 0);
		assertEquals(h.watchdog.downloads[0]?.state, 'canceled');
		assertEquals(h.watchdog.downloadedFiles, []);
		assertEquals(isDownloadRetrievable(h.watchdog.downloads[0] as DownloadRecord), false);
		assertEquals(await exists(join(dir, 'G1.crdownload')), false, 'the partial was removed');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// transfer limits and cancellation (E-33)
// ---------------------------------------------------------------------------

Deno.test('downloads: a download over the per-file limit is cancelled and its partial removed', async () => {
	const dir = await scratchDir('bua-dl-limit-file-');
	try {
		await using h = await harness({ downloadsDir: dir, watchdogOptions: { limits: { maxFileBytes: 100 } } });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/big.bin', suggestedFilename: 'big.bin' });
		await Deno.writeTextFile(join(dir, 'G1'), 'partial');
		await Deno.writeTextFile(join(dir, 'G1.crdownload'), 'partial');
		await h.progress({ guid: 'G1', receivedBytes: 50, totalBytes: 1_000, state: 'inProgress' });

		const record = h.watchdog.lookup('G1');
		assertEquals(record?.state, 'canceled');
		assertStringIncludes(record?.error ?? '', 'per-file limit');
		assertEquals(h.fixture.requestsFor('Browser.cancelDownload').map((r) => r.params.guid), ['G1']);
		assertEquals(h.events.errors[0]?.errorType, 'DownloadCanceled');
		assertEquals(await exists(join(dir, 'G1')), false);
		assertEquals(await exists(join(dir, 'G1.crdownload')), false);

		// Chromium's own `canceled` echo, and even a stray `completed`, cannot resurrect it.
		await Deno.writeTextFile(join(dir, 'G1'), 'late');
		await h.progress({ guid: 'G1', receivedBytes: 1_000, totalBytes: 1_000, state: 'completed' });
		assertEquals(h.watchdog.lookup('G1')?.state, 'canceled');
		assertEquals(h.events.done.length, 0);
		assertEquals(h.watchdog.downloadedFiles, []);
		assertEquals(await exists(join(dir, 'G1')), false, 'a late write is removed too');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: the per-session limit counts finished files and in-flight bytes together', async () => {
	const dir = await scratchDir('bua-dl-limit-session-');
	try {
		await using h = await harness({ downloadsDir: dir, watchdogOptions: { limits: { maxSessionBytes: 10 } } });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a', suggestedFilename: 'a.bin' });
		await Deno.writeTextFile(join(dir, 'G1'), '123456');
		await h.progress({ guid: 'G1', receivedBytes: 6, totalBytes: 6, state: 'completed' });
		assertEquals(isDownloadRetrievable(h.watchdog.lookup('G1') as DownloadRecord), true);

		await h.willBegin({ guid: 'G2', url: 'http://127.0.0.1:1/b', suggestedFilename: 'b.bin' });
		await h.progress({ guid: 'G2', receivedBytes: 5, totalBytes: 5, state: 'inProgress' });
		assertStringIncludes(h.watchdog.lookup('G2')?.error ?? '', 'per-session limit');
		assertEquals(h.fixture.requestsFor('Browser.cancelDownload').map((r) => r.params.guid), ['G2']);
		// The finished file is untouched.
		assertEquals(await Deno.readTextFile(join(dir, 'G1')), '123456');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: the tracked-download cap refuses the next download at start', async () => {
	const dir = await scratchDir('bua-dl-limit-count-');
	try {
		await using h = await harness({ downloadsDir: dir, watchdogOptions: { limits: { maxTracked: 1 } } });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a', suggestedFilename: 'a.bin' });
		await h.willBegin({ guid: 'G2', url: 'http://127.0.0.1:1/b', suggestedFilename: 'b.bin' });
		assertEquals(h.events.started.length, 1);
		assertEquals(h.events.errors[0]?.errorType, 'DownloadRejected');
		assertStringIncludes(h.events.errors[0]?.message ?? '', 'already tracks 1 downloads');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a transfer past its deadline is cancelled on the next progress report', async () => {
	const dir = await scratchDir('bua-dl-deadline-');
	try {
		let now = 1_000;
		await using h = await harness({
			downloadsDir: dir,
			watchdogOptions: { now: () => now, limits: { transferDeadlineMs: 60_000 } },
		});
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/slow', suggestedFilename: 'slow.bin' });
		now += 30_000;
		await h.progress({ guid: 'G1', receivedBytes: 1, totalBytes: 100, state: 'inProgress' });
		assertEquals(h.watchdog.lookup('G1')?.state, 'inProgress', 'inside the deadline the transfer continues');
		now += 31_000;
		await h.progress({ guid: 'G1', receivedBytes: 2, totalBytes: 100, state: 'inProgress' });
		assertStringIncludes(h.watchdog.lookup('G1')?.error ?? '', 'deadline');
		assertEquals(h.fixture.requestsFor('Browser.cancelDownload').length, 1);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a hung transfer that reports nothing is cancelled by the deadline timer', async () => {
	const dir = await scratchDir('bua-dl-hung-');
	try {
		await using h = await harness({ downloadsDir: dir, watchdogOptions: { limits: { transferDeadlineMs: 40 } } });
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/hung', suggestedFilename: 'hung.bin' });
		await Deno.writeTextFile(join(dir, 'G1.crdownload'), 'stuck');
		// No progress ever arrives. The timer, not a progress report, has to end it.
		const deadline = Date.now() + 5_000;
		while (h.watchdog.lookup('G1')?.state === 'inProgress' && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			await h.watchdog.whenIdle();
		}
		assertEquals(h.watchdog.lookup('G1')?.state, 'canceled');
		assertStringIncludes(h.watchdog.lookup('G1')?.error ?? '', 'deadline');
		assertEquals(h.fixture.requestsFor('Browser.cancelDownload').map((r) => r.params.guid), ['G1']);
		assertEquals(await exists(join(dir, 'G1.crdownload')), false);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: cancelDownload refuses unknown and finished guids', async () => {
	const dir = await scratchDir('bua-dl-cancel-api-');
	try {
		await using h = await harness({ downloadsDir: dir });
		assertEquals(await h.watchdog.cancelDownload('nope'), false);
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a', suggestedFilename: 'a.bin' });
		await Deno.writeTextFile(join(dir, 'G1'), 'a');
		await h.progress({ guid: 'G1', receivedBytes: 1, totalBytes: 1, state: 'completed' });
		assertEquals(await h.watchdog.cancelDownload('G1'), false, 'a finished download is not cancellable');
		await h.willBegin({ guid: 'G2', url: 'http://127.0.0.1:1/b', suggestedFilename: 'b.bin' });
		assertEquals(await h.watchdog.cancelDownload('G2', 'operator asked'), true);
		assertEquals(h.watchdog.lookup('G2')?.error, 'operator asked');
		assertEquals(h.fixture.requestsFor('Browser.cancelDownload').map((r) => r.params.guid), ['G2']);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: progress for an untracked guid is re-broadcast but produces no file', async () => {
	const dir = await scratchDir('bua-dl-untracked-');
	try {
		await using h = await harness({ downloadsDir: dir });
		await h.progress({ guid: 'GHOST', receivedBytes: 1, totalBytes: 1, state: 'completed' });
		assertEquals(h.events.progress.length, 1);
		assertEquals(h.events.done.length, 0);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// the synchronous direct-callback channel (the DefaultActionWatchdog seam)
// ---------------------------------------------------------------------------

Deno.test('downloads: addDownloadListener fires synchronously, ahead of the bus', async () => {
	const dir = await scratchDir('bua-dl-sync-');
	try {
		await using h = await harness({ downloadsDir: dir });
		const order: string[] = [];
		const signals: DownloadSignal[] = [];
		const off = h.watchdog.addDownloadListener((signal) => {
			signals.push(signal);
			order.push(`direct:${signal.phase}`);
		});
		h.session.eventBus.on(DownloadStartedEvent, () => void order.push('bus:started'), { wrap: null });

		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		assertEquals(order, ['direct:started', 'bus:started'], 'the click path must never lose the race to the bus');
		assertEquals(signals[0]?.download.fileName, 'a.txt');

		off();
		await h.willBegin({ guid: 'G2', url: 'http://127.0.0.1:1/b.txt', suggestedFilename: 'b.txt' });
		assertEquals(signals.length, 1, 'unsubscribing actually unsubscribes');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: a listener that throws is contained, not propagated to the read loop', async () => {
	const dir = await scratchDir('bua-dl-throw-');
	try {
		await using h = await harness({ downloadsDir: dir });
		h.watchdog.addDownloadListener(() => {
			throw new Error('listener bug');
		});
		let sawSecond = false;
		h.watchdog.addDownloadListener(() => {
			sawSecond = true;
		});
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		assertEquals(sawSecond, true);
		assertEquals(h.events.started.length, 1);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: armDownloadWatch resolves null when nothing starts inside the 0.5 s grace', async () => {
	using time = new FakeTime();
	const bus = new EventBus({ name: 'dl', logger: silentBusLogger });
	try {
		const watchdog = new DownloadsWatchdog({
			eventBus: bus,
			profile: createBrowserProfile(),
			logger: silentBusLogger,
			cdpClient: null,
			sessionManager: null,
			cdpUrl: null,
			isLocal: true,
		});
		using watch = watchdog.armDownloadWatch();
		let settled: DownloadRecord | null | 'pending' = 'pending';
		void watch.result.then((value) => {
			settled = value;
		});

		await time.tickAsync(DOWNLOAD_START_GRACE_MS - 1);
		assertEquals(settled, 'pending', 'the grace has not elapsed yet');
		await time.tickAsync(2);
		assertEquals(settled, null, 'no download started: the click simply did not download anything');
	} finally {
		await bus.stop();
	}
});

Deno.test('downloads: armDownloadWatch resolves with the completed download', async () => {
	const dir = await scratchDir('bua-dl-watch-');
	try {
		await using h = await harness({ downloadsDir: dir });
		using watch = h.watchdog.armDownloadWatch();
		await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
		await Deno.writeTextFile(join(dir, 'G1'), 'xy');
		await h.progress({ guid: 'G1', receivedBytes: 2, totalBytes: 2, state: 'completed' });

		const record = await watch.result;
		assert(record !== null);
		assertEquals(record.fileName, 'a.txt');
		assertEquals(record.state, 'completed');
		assertEquals(record.fileSize, 2);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// remote browsers never touch the local filesystem (ARCHITECTURE.md §6.8)
// ---------------------------------------------------------------------------

Deno.test('downloads: a remote browser gets no local path and writes nothing locally', async () => {
	const recorder = fsRecorder();
	await using h = await harness({
		downloadsDir: '/remote/downloads',
		isLocal: false,
		watchdogOptions: recorder.options,
	});
	assertEquals(h.watchdog.isRemoteBrowser, true);

	const behavior = h.fixture.requestsFor('Browser.setDownloadBehavior')[0];
	assertEquals(behavior?.params.behavior, 'allow');
	assertEquals(
		behavior?.params.downloadPath,
		undefined,
		'handing a remote browser one of our paths is how a sandbox escape starts',
	);

	await h.willBegin({ guid: 'G1', url: 'http://127.0.0.1:1/a.txt', suggestedFilename: 'a.txt' });
	await h.progress({ guid: 'G1', receivedBytes: 9, totalBytes: 9, state: 'completed' });

	const done = h.events.done[0];
	assert(done !== undefined);
	assertEquals(done.fileSize, 0, '§6.8: remote downloads report size 0');
	assertEquals(done.fileName, 'a.txt');
	assert(done.path.includes('a.txt'), 'the path is synthesized for reporting');

	assertEquals(recorder.ensured, [], 'no directory was created');
	assertEquals(recorder.stated, [], 'nothing was stat-ed');
	assertEquals(recorder.removed, [], 'nothing was removed');
	assertEquals(h.fixture.requestsFor('Browser.cancelDownload'), [], 'no limit was enforced on a remote host');
	assertEquals(recorder.realPathed, [], 'nothing was realpath-ed');
});

// ---------------------------------------------------------------------------
// auto-download (PDFs / attachments), default on
// ---------------------------------------------------------------------------

Deno.test('downloads: a PDF response is auto-downloaded in-page exactly once', async () => {
	const dir = await scratchDir('bua-dl-pdf-');
	try {
		await using h = await harness({ downloadsDir: dir });
		assertEquals(createBrowserProfile().autoDownloadPdfs, true, 'autoDownloadPdfs defaults to true');

		const targetId = h.fixture.targets[0]?.targetId;
		assert(targetId !== undefined);
		const sessionId = h.fixture.sessionFor(targetId);
		assert(sessionId !== null);
		const response = {
			requestId: 'R1',
			loaderId: 'L1',
			timestamp: 1,
			type: 'Document',
			response: {
				url: 'http://127.0.0.1:1/manual.pdf',
				status: 200,
				statusText: 'OK',
				headers: {},
				mimeType: 'application/pdf',
			},
		};
		await h.push('Network.responseReceived', response, sessionId);
		await h.push('Network.responseReceived', response, sessionId);

		const evaluates = h.fixture.requestsFor('Runtime.evaluate');
		assertEquals(evaluates.length, 1, 'the same URL is auto-downloaded once, not on every response');
		assertStringIncludes(String(evaluates[0]?.params.expression), 'manual.pdf');
		assertStringIncludes(String(evaluates[0]?.params.expression), 'a.download');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: the PDF-viewer navigation case triggers the same in-page download', async () => {
	const dir = await scratchDir('bua-dl-nav-');
	try {
		await using h = await harness({ downloadsDir: dir });
		const targetId = h.fixture.targets[0]?.targetId;
		assert(targetId !== undefined);
		await h.session.eventBus.dispatch(
			new NavigationCompleteEvent({ targetId, url: 'http://127.0.0.1:1/manual.pdf' }),
		);
		assertEquals(h.fixture.requestsFor('Runtime.evaluate').length, 1);

		// A normal page is left alone.
		await h.session.eventBus.dispatch(
			new NavigationCompleteEvent({ targetId, url: 'http://127.0.0.1:1/index.html' }),
		);
		assertEquals(h.fixture.requestsFor('Runtime.evaluate').length, 1);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: autoDownloadPdfs=false leaves PDFs rendered', async () => {
	const dir = await scratchDir('bua-dl-nopdf-');
	try {
		await using h = await harness({ downloadsDir: dir, profile: { autoDownloadPdfs: false } });
		const targetId = h.fixture.targets[0]?.targetId;
		assert(targetId !== undefined);
		await h.session.eventBus.dispatch(
			new NavigationCompleteEvent({ targetId, url: 'http://127.0.0.1:1/manual.pdf' }),
		);
		assertEquals(h.fixture.requestsFor('Runtime.evaluate').length, 0);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// the BrowserStateRequestEvent side handler (DATA-MODEL.md §5.1.1)
// ---------------------------------------------------------------------------

Deno.test('downloads: the state-request side handler returns nothing and never throws', async () => {
	const dir = await scratchDir('bua-dl-state-');
	try {
		await using h = await harness({ downloadsDir: dir });
		// No DOMWatchdog is attached, so this watchdog is the only handler: its "no opinion" return is
		// what keeps `eventResult` from picking a non-summary value.
		const outcome = await h.session.eventBus
			.dispatch(new BrowserStateRequestEvent())
			.eventResult({ raiseIfAny: true });
		assertEquals(outcome, undefined);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

Deno.test('downloads: the auto-download response predicate', () => {
	assertEquals(shouldAutoDownload('application/pdf', {}, 'http://127.0.0.1:1/a'), true);
	assertEquals(shouldAutoDownload('application/x-pdf', {}, 'http://127.0.0.1:1/a'), true);
	assertEquals(
		shouldAutoDownload('text/html', { 'Content-Disposition': 'attachment; filename="x.csv"' }, 'http://127.0.0.1:1/a'),
		true,
	);
	assertEquals(shouldAutoDownload('text/html', { 'content-disposition': 'ATTACHMENT' }, 'http://127.0.0.1:1/a'), true);
	// E-33: a navigation to an attachment is already Chromium's own download — never re-triggered.
	assertEquals(
		shouldAutoDownload(
			'text/plain',
			{ 'Content-Disposition': 'attachment; filename="r.txt"' },
			'http://x/r',
			'Document',
		),
		false,
	);
	assertEquals(
		shouldAutoDownload('text/plain', { 'Content-Disposition': 'attachment; filename="r.txt"' }, 'http://x/r', 'XHR'),
		true,
	);
	// An inline PDF navigation is still auto-downloaded: the viewer would render it otherwise.
	assertEquals(shouldAutoDownload('application/pdf', {}, 'http://x/manual.pdf', 'Document'), true);
	assertEquals(shouldAutoDownload('text/html', { 'Content-Disposition': 'inline' }, 'http://127.0.0.1:1/a'), false);
	assertEquals(shouldAutoDownload('application/octet-stream', {}, 'http://127.0.0.1:1/blob.bin'), true);
	assertEquals(shouldAutoDownload('application/octet-stream', {}, 'http://127.0.0.1:1/stream'), false);
	assertEquals(shouldAutoDownload('text/html', {}, 'http://127.0.0.1:1/index.html'), false);
});

Deno.test('downloads: the PDF URL heuristic is path-based', () => {
	assertEquals(looksLikePdfUrl('http://127.0.0.1:1/a.pdf'), true);
	assertEquals(looksLikePdfUrl('http://127.0.0.1:1/a.PDF?x=1'), true);
	assertEquals(looksLikePdfUrl('http://127.0.0.1:1/a.html?file=b.pdf'), false);
	assertEquals(looksLikePdfUrl('about:blank'), false);
	assertEquals(looksLikePdfUrl('nonsense'), false);
});

Deno.test('downloads: only guid-shaped ids may become file names', () => {
	assertEquals(isSafeDownloadGuid('b61d5943-1086-4a5b-bc70-fdd8144a25ca'), true);
	assertEquals(isSafeDownloadGuid('G1'), true);
	assertEquals(isSafeDownloadGuid(''), false);
	assertEquals(isSafeDownloadGuid('../x'), false);
	assertEquals(isSafeDownloadGuid('a/b'), false);
	assertEquals(isSafeDownloadGuid('a b'), false);
	assertEquals(isSafeDownloadGuid('-leading'), false);
	assertEquals(isSafeDownloadGuid('x'.repeat(129)), false);
});

Deno.test('downloads: a Document attachment response is left to Chromium, an inline PDF is not', async () => {
	const dir = await scratchDir('bua-dl-sniff-');
	try {
		await using h = await harness({ downloadsDir: dir });
		const targetId = h.fixture.targets[0]?.targetId;
		assert(targetId !== undefined);
		const sessionId = h.fixture.sessionFor(targetId);
		assert(sessionId !== null);
		await h.push('Network.responseReceived', {
			requestId: 'R1',
			loaderId: 'L1',
			timestamp: 1,
			type: 'Document',
			response: {
				url: 'http://127.0.0.1:1/download?body=first',
				status: 200,
				statusText: 'OK',
				headers: { 'Content-Disposition': 'attachment; filename="report.txt"' },
				mimeType: 'text/plain',
			},
		}, sessionId);
		assertEquals(h.fixture.requestsFor('Runtime.evaluate').length, 0, 'E-33: no second download of a navigation');
		await h.push('Network.responseReceived', {
			requestId: 'R2',
			loaderId: 'L2',
			timestamp: 2,
			type: 'Document',
			response: {
				url: 'http://127.0.0.1:1/manual.pdf',
				status: 200,
				statusText: 'OK',
				headers: {},
				mimeType: 'application/pdf',
			},
		}, sessionId);
		assertEquals(h.fixture.requestsFor('Runtime.evaluate').length, 1, 'the rendered PDF is still captured');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('downloads: fileTypeOf reports a lower-case extension or null', () => {
	assertEquals(fileTypeOf('report.PDF'), 'pdf');
	assertEquals(fileTypeOf('archive.tar.gz'), 'gz');
	assertEquals(fileTypeOf('README'), null);
});

Deno.test('downloads: the in-page expression cannot be escaped by a hostile URL', () => {
	const hostile = `http://127.0.0.1:1/x'; fetch('http://127.0.0.1:1/exfil'); //`;
	const expression = autoDownloadExpression(hostile);
	// The URL appears exactly once, as a JSON string literal — never as bare code.
	assertStringIncludes(expression, JSON.stringify(hostile));
	assertEquals(expression.includes(`= '${hostile}'`), false);
	assertEquals(expression.split(JSON.stringify(hostile)).length, 2);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-54): a cancelled download's partial survives a host that is still holding it
// ---------------------------------------------------------------------------

Deno.test('E-54: a removal the host refuses is retried, and succeeds once the handle is released', async () => {
	// The Windows shape: `Browser.cancelDownload` has returned, but Chromium has not yet closed the
	// `.crdownload` handle, so the first removals fail with PermissionDenied. Before E-54 the first
	// failure was logged at debug and the partial stayed in the session's directory until the session
	// was reaped, against E-33's contract that a cancelled transfer leaves nothing behind.
	let calls = 0;
	await removeWithRetry(
		(path) => {
			calls += 1;
			if (calls < 3) return Promise.reject(new Deno.errors.PermissionDenied(`still open: ${path}`));
			return Promise.resolve();
		},
		'partial.crdownload',
		PARTIAL_REMOVE_ATTEMPTS,
		1,
	);
	assertEquals(calls, 3);
});

Deno.test('E-54: a file that is already gone is success, and a persistent refusal still throws', async () => {
	// Something else removing it first satisfies the contract — the point is that nothing is left
	// behind, not that this caller is the one who removed it.
	let notFoundCalls = 0;
	await removeWithRetry(
		(path) => {
			notFoundCalls += 1;
			return Promise.reject(new Deno.errors.NotFound(path));
		},
		'gone',
		PARTIAL_REMOVE_ATTEMPTS,
		1,
	);
	assertEquals(notFoundCalls, 1, 'a missing file is not retried');

	// And the retry is bounded: a cleanup that never gave up would turn a leaked file into a stuck
	// cancellation, which is the worse failure.
	let stubborn = 0;
	await assertRejects(
		() =>
			removeWithRetry(
				() => {
					stubborn += 1;
					return Promise.reject(new Deno.errors.PermissionDenied('locked'));
				},
				'locked.crdownload',
				PARTIAL_REMOVE_ATTEMPTS,
				1,
			),
		Deno.errors.PermissionDenied,
	);
	assertEquals(stubborn, PARTIAL_REMOVE_ATTEMPTS);
});
