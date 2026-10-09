/**
 * `RecordingWatchdog` contract (ARCHITECTURE.md §6.12; COMPLETIONS-CRITERIA.md §3.2 watchdog row 12:
 * "screencast frame capture + buffering + focus-change restart (mp4 OUT, D-SCOPE1)").
 *
 * Real bus, real `CdpClient`, real `Page.screencastFrame` frames over `ChromeFixture`, real files in
 * `tests/.scratch`. The three assertions that matter are the three mechanisms: the screencast starts
 * on the *focused* session, every frame is acked (without which Chrome stops sending after one), and
 * a focus change moves the recording rather than silently continuing to film a tab nobody is on.
 */

import { assert, assertEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { fromFileUrl, join } from '@std/path';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { AgentFocusChangedEvent, BrowserConnectedEvent, BrowserStopEvent } from '../events.ts';
import { type BrowserProfileInit, createBrowserProfile } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import type { HandlerBudget } from './handler_budget.ts';
import {
	RECORDING_FRAME_FORMAT,
	RECORDING_FRAME_QUALITY,
	RECORDING_MANIFEST_FILENAME,
	RECORDING_MANIFEST_VERSION,
	RECORDING_MAX_BUFFERED_FRAMES,
	recordingFrameFilename,
	type RecordingManifest,
	RecordingWatchdog,
	shouldAttachRecordingWatchdog,
} from './recording.ts';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../../tests/.scratch', import.meta.url));
const PAGE_A = 'http://127.0.0.1:8080/a';
const PAGE_B = 'http://127.0.0.1:8080/b';
/** base64 of `hello` — small, and decodable so the written bytes can be checked. */
const FRAME = 'aGVsbG8=';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly client: CdpClient;
	readonly watchdog: RecordingWatchdog;
	readonly videoDir: string;
	readonly targets: { a: string; b: string };
	readonly sessions: { a: string; b: string };
	sent(method: string): FixtureRequest[];
	emitFrame(sessionId: string, screencastSessionId: number): void;
	settle(): Promise<void>;
}

async function harness(profile: BrowserProfileInit = {}): Promise<Harness> {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	const scratch = await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix: 'bua-rec-' });
	const videoDir = join(scratch, 'video');

	const fixture = ChromeFixture.start({ pages: [PAGE_A, PAGE_B] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'recording-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();
	const pages = manager.pageTargets().sort((left, right) => left.sequence - right.sequence);
	const a = pages[0]?.targetId ?? '';
	const b = pages[1]?.targetId ?? '';
	assert(a !== '' && b !== '');
	await manager.getOrCreateCdpSession(a, false);
	await manager.getOrCreateCdpSession(b, false);
	await manager.setAgentFocus(a, { activate: false, announce: false });
	await manager.whenIdle();
	const sessionA = fixture.sessionFor(a);
	const sessionB = fixture.sessionFor(b);
	assert(sessionA !== null && sessionB !== null);

	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile({ recordVideoDir: videoDir, ...profile }),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new RecordingWatchdog(host);
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
		videoDir,
		targets: { a, b },
		sessions: { a: sessionA, b: sessionB },
		sent: (method) => fixture.requestsFor(method),
		emitFrame: (sessionId, screencastSessionId) => {
			fixture.emit('Page.screencastFrame', {
				data: FRAME,
				sessionId: screencastSessionId,
				metadata: {
					offsetTop: 0,
					pageScaleFactor: 1,
					deviceWidth: 800,
					deviceHeight: 600,
					scrollOffsetX: 0,
					scrollOffsetY: 0,
					timestamp: 1234.5,
				},
			}, sessionId);
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

// ---------------------------------------------------------------------------
// conditional attachment + constants
// ---------------------------------------------------------------------------

Deno.test('recording: the watchdog is conditional on recordVideoDir', () => {
	assertEquals(shouldAttachRecordingWatchdog({ recordVideoDir: null }), false);
	assertEquals(shouldAttachRecordingWatchdog({ recordVideoDir: '/tmp/video' }), true);
});

Deno.test('recording: the capture parameters and buffer bound are the declared constants', () => {
	assertEquals(RECORDING_FRAME_FORMAT, 'jpeg');
	assertEquals(RECORDING_FRAME_QUALITY, 80);
	assertEquals(RECORDING_MAX_BUFFERED_FRAMES, 300);
	assertEquals(RECORDING_MANIFEST_FILENAME, 'frames.json');
	assertEquals(recordingFrameFilename(1), 'frame-000001.jpeg');
	assertEquals(recordingFrameFilename(123456), 'frame-123456.jpeg');
});

Deno.test('recording: LISTENS_TO covers connect, focus change and stop', async () => {
	await using h = await harness();
	assertEquals(RecordingWatchdog.LISTENS_TO.map((cls) => cls.eventName), [
		'BrowserConnectedEvent',
		'AgentFocusChangedEvent',
		'BrowserStopEvent',
	]);
	assertEquals(h.watchdog.directory, h.videoDir);
});

// ---------------------------------------------------------------------------
// screencast lifecycle
// ---------------------------------------------------------------------------

Deno.test('recording: connect starts the screencast on the focused session', async () => {
	await using h = await harness({ recordVideoSize: { width: 640, height: 480 } });
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));

	const starts = h.sent('Page.startScreencast');
	assertEquals(starts.length, 1);
	assertEquals(starts[0]?.sessionId, h.sessions.a, 'only the tab the agent is on is worth recording');
	assertEquals(starts[0]?.params.format, RECORDING_FRAME_FORMAT);
	assertEquals(starts[0]?.params.quality, RECORDING_FRAME_QUALITY);
	assertEquals(starts[0]?.params.maxWidth, 640);
	assertEquals(starts[0]?.params.maxHeight, 480);
	assertEquals(h.watchdog.recording, true);
	assertEquals(h.watchdog.recordedTargetId, h.targets.a);
});

Deno.test('recording: an unset recordVideoDir makes the watchdog inert', async () => {
	await using h = await harness({ recordVideoDir: null });
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	assertEquals(h.sent('Page.startScreencast').length, 0);
	assertEquals(h.watchdog.recording, false);
	assertEquals(await h.watchdog.flush(), null);
});

Deno.test('recording: a focus change restarts the screencast on the new session', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	await h.bus.dispatch(new AgentFocusChangedEvent({ targetId: h.targets.b, url: PAGE_B }));

	assertEquals(h.sent('Page.stopScreencast').map((request) => request.sessionId), [h.sessions.a]);
	assertEquals(h.sent('Page.startScreencast').map((request) => request.sessionId), [h.sessions.a, h.sessions.b]);
	assertEquals(h.watchdog.recordedTargetId, h.targets.b);

	// A focus event naming the tab we are already filming is a no-op, not a restart.
	await h.bus.dispatch(new AgentFocusChangedEvent({ targetId: h.targets.b, url: PAGE_B }));
	assertEquals(h.sent('Page.startScreencast').length, 2);
});

// ---------------------------------------------------------------------------
// frames: buffering and the ack loop
// ---------------------------------------------------------------------------

Deno.test('recording: every frame is buffered and acked — the ack is the flow control', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));

	h.emitFrame(h.sessions.a, 7);
	h.emitFrame(h.sessions.a, 8);
	await h.settle();

	assertEquals(h.watchdog.capturedFrames, 2);
	assertEquals(h.watchdog.frames.map((frame) => frame.index), [1, 2]);
	assertEquals(h.watchdog.frames[0]?.targetId, h.targets.a);
	assertEquals(h.watchdog.frames[0]?.metadata.deviceWidth, 800);

	const acks = h.sent('Page.screencastFrameAck');
	assertEquals(acks.length, 2, 'Chrome delivers one un-acked frame at a time; a missed ack ends the stream');
	assertEquals(acks.map((request) => request.params.sessionId), [7, 8]);
	assertEquals(acks[0]?.sessionId, h.sessions.a);
});

Deno.test('recording: the buffer is bounded and the loss is counted, not hidden', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));

	const total = RECORDING_MAX_BUFFERED_FRAMES + 5;
	for (let index = 0; index < total; index++) h.emitFrame(h.sessions.a, index);
	await h.settle();

	assertEquals(h.watchdog.capturedFrames, total);
	assertEquals(h.watchdog.frames.length, RECORDING_MAX_BUFFERED_FRAMES);
	assertEquals(h.watchdog.droppedFrames, 5);
	assertEquals(h.watchdog.frames[0]?.index, 6, 'oldest out first');
});

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

Deno.test('recording: stop stops the screencast and writes the frames plus a manifest', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.emitFrame(h.sessions.a, 1);
	h.emitFrame(h.sessions.a, 2);
	await h.settle();

	await h.bus.dispatch(new BrowserStopEvent());

	assertEquals(h.sent('Page.stopScreencast').length, 1);
	assertEquals(h.watchdog.recording, false);
	assertEquals(h.watchdog.frames, [], 'a flush hands the buffer over, it does not copy it');

	const written = (await Array.fromAsync(Deno.readDir(h.videoDir))).map((entry) => entry.name).sort();
	assertEquals(written, ['frame-000001.jpeg', 'frame-000002.jpeg', RECORDING_MANIFEST_FILENAME].sort());
	assertEquals(await Deno.readFile(join(h.videoDir, 'frame-000001.jpeg')), decodeBase64(FRAME));

	const manifest = JSON.parse(
		await Deno.readTextFile(join(h.videoDir, RECORDING_MANIFEST_FILENAME)),
	) as RecordingManifest;
	assertEquals(manifest.version, RECORDING_MANIFEST_VERSION);
	assertEquals(manifest.format, RECORDING_FRAME_FORMAT);
	// mp4 encoding is OUT (D-SCOPE1); the framerate is carried as intent for whatever encodes later.
	assertEquals(manifest.framerate, 30);
	assertEquals(manifest.droppedFrames, 0);
	assertEquals(manifest.frames.length, 2);
	assertEquals(manifest.frames[0]?.file, 'frame-000001.jpeg');
	assertEquals(manifest.frames[0]?.targetId, h.targets.a);
	assert(typeof manifest.frames[0]?.receivedAt === 'string');
});

// ---------------------------------------------------------------------------
// the flush budget — ERRATUM(CANCEL-1)
// ---------------------------------------------------------------------------

/** A budget that survives `n` checks and is spent thereafter. Deterministic; no clock involved. */
function budgetFor(checks: number): HandlerBudget {
	let seen = 0;
	const expired = (): boolean => ++seen > checks;
	// `context: undefined` — this budget is a counter, not a dispatch; the CDP facade it would feed
	// (ERRATUM(E-52)) is not what this test exercises.
	return { expired, clamp: (ms) => expired() ? 0 : ms, context: undefined };
}

Deno.test('ERRATUM(CANCEL-1): a flush out of budget stops between frames, keeps the rest, writes the manifest', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	for (let index = 0; index < 4; index++) h.emitFrame(h.sessions.a, index);
	await h.settle();
	assertEquals(h.watchdog.frames.length, 4);

	// Spent after two frames: 301 unchecked `Deno.writeFile` calls was the defect (E-43's twin).
	const result = await h.watchdog.flush(budgetFor(2));
	assertEquals(result?.frameFiles, ['frame-000001.jpeg', 'frame-000002.jpeg']);
	assertEquals(
		h.watchdog.frames.map((frame) => frame.index),
		[3, 4],
		'the unwritten remainder is re-queued, not dropped — a later flush resumes it',
	);

	// The asymmetry: the manifest is written even though the budget was spent, because a directory of
	// numbered JPEGs with no index is not a recording (D-SCOPE1 defers the encoder, not the manifest).
	const afterFirst = (await Array.fromAsync(Deno.readDir(h.videoDir))).map((entry) => entry.name).sort();
	assertEquals(afterFirst, ['frame-000001.jpeg', 'frame-000002.jpeg', RECORDING_MANIFEST_FILENAME].sort());
	const truncated = JSON.parse(
		await Deno.readTextFile(join(h.videoDir, RECORDING_MANIFEST_FILENAME)),
	) as RecordingManifest;
	assertEquals(truncated.frames.map((frame) => frame.index), [1, 2], 'the manifest describes what is on disk');

	// Resuming finishes the job, and the rewritten manifest covers both passes rather than clobbering.
	await h.watchdog.flush();
	assertEquals(h.watchdog.frames, []);
	const manifest = JSON.parse(
		await Deno.readTextFile(join(h.videoDir, RECORDING_MANIFEST_FILENAME)),
	) as RecordingManifest;
	assertEquals(manifest.frames.map((frame) => frame.index), [1, 2, 3, 4]);
	assertEquals(manifest.frames.map((frame) => frame.file), [
		'frame-000001.jpeg',
		'frame-000002.jpeg',
		'frame-000003.jpeg',
		'frame-000004.jpeg',
	]);
});

Deno.test('ERRATUM(CANCEL-1): a flush with nothing left to spend starts no frame write at all', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.emitFrame(h.sessions.a, 1);
	await h.settle();

	const result = await h.watchdog.flush(budgetFor(0));
	assertEquals(result?.frameFiles, [], 'a handler the bus has abandoned must not start 301 writes');
	assertEquals(h.watchdog.frames.length, 1);
	const written = (await Array.fromAsync(Deno.readDir(h.videoDir))).map((entry) => entry.name);
	assertEquals(written, [RECORDING_MANIFEST_FILENAME]);
});

Deno.test('recording: detach drops the buffer and the listener rather than leaking either', async () => {
	await using h = await harness();
	await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl }));
	h.emitFrame(h.sessions.a, 1);
	await h.settle();
	assertEquals(h.watchdog.frames.length, 1);

	h.watchdog.detach();
	assertEquals(h.watchdog.frames, []);
	assertEquals(h.watchdog.recording, false);

	h.emitFrame(h.sessions.a, 2);
	await h.settle();
	assertEquals(h.watchdog.frames, [], 'a detached watchdog must not keep filming');
});
