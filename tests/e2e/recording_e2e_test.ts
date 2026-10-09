/**
 * R7: recording a session to a real video file.
 *
 * The frames come from the same screencast the live view uses, so a passing run
 * proves the whole chain: Chromium paints, CDP delivers, the shared cast fans
 * out, ffmpeg encodes, and the result is a WebM a player can open. The file is
 * checked by its container magic and its size, not by the exit code — an
 * encoder that "succeeded" and wrote nothing is the failure worth catching.
 *
 * Browser tier, and additionally needs ffmpeg. Without one it skips loudly;
 * `tests/container/verify_container.ts` covers the same ground inside the
 * image, where ffmpeg is always present.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { harness, skipUnlessBrowser } from '../support/harness.ts';
import { announceSkip, readEnv } from '../support/browser_tier.ts';

/**
 * The ffmpeg the task pinned, or `null`.
 *
 * Read from the environment rather than probed here, for the same reason the
 * Chromium path is: the *task* has to grant `--allow-run` for exactly this
 * executable, so the task is the only place that can decide which one it is.
 */
const FFMPEG = readEnv('TTK_FFMPEG') ?? null;
const ignore = skipUnlessBrowser('recording e2e') ||
	(FFMPEG === null &&
		announceSkip('recording e2e', 'no ffmpeg found — set TTK_FFMPEG=<path> to run it (the container leg always does)'));

/** WebM/Matroska starts with the EBML magic `1A 45 DF A3`. */
function isWebm(bytes: Uint8Array): boolean {
	return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

interface Recording {
	session_id: string;
	name: string;
	recording: boolean;
	frames: number;
	duration_ms: number;
	bytes?: number;
	url?: string;
}

Deno.test({
	name: 'e2e R7: a session records to a playable WebM',
	ignore,
	async fn(t) {
		const dir = join('tests', '.scratch', `rec-${crypto.randomUUID().slice(0, 8)}`);
		await Deno.mkdir(dir, { recursive: true });
		try {
			await using h = await harness({ env: { TTK_DATA_DIR: dir, TTK_FFMPEG: FFMPEG ?? '' } });
			await h.callText('browser_navigate', { url: h.site.page('index') });

			await t.step('the tool is offered once a deployment can encode', async () => {
				const names = (await h.client.listTools({})).tools.map((tool) => tool.name);
				assert(names.includes('browser_record'), `browser_record missing from ${names.join(',')}`);
			});

			await t.step('status on an idle session says so', async () => {
				const status = await h.callJson<Recording>('browser_record', { action: 'status' });
				assertEquals(status.recording, false);
			});

			await t.step('a recording captures the page changing', async () => {
				const started = await h.callJson<Recording>('browser_record', {
					action: 'start',
					name: 'demo',
				});
				assertEquals(started.recording, true);
				assertEquals(started.name, 'demo');
				// `start` waits for the first frame, so a recording always contains
				// at least the screen as it was when it began.
				assert(started.frames > 0, 'start returned before any frame was captured');

				// Make the page paint repeatedly: an encoder fed a static screen is
				// not proof that frames are flowing.
				for (let i = 0; i < 6; i++) {
					const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
						'browser_get_state',
						{},
					);
					const button = state.interactive_elements.find((element) => element.tag === 'button');
					if (button !== undefined) await h.callText('browser_click', { index: button.index });
					await h.callText('browser_scroll', { direction: 'down', pages: 0.2 });
					await new Promise((resolve) => setTimeout(resolve, 250));
				}

				const mid = await h.callJson<Recording>('browser_record', { action: 'status' });
				assertEquals(mid.recording, true);
				assert(mid.frames > 0, 'no frames reached the encoder');

				const stopped = await h.callJson<Recording>('browser_record', { action: 'stop' });
				assertEquals(stopped.recording, false);
				assert(stopped.frames >= mid.frames, 'the frame count went backwards');
				assert((stopped.bytes ?? 0) > 0, 'the encoder produced an empty file');
				assert(stopped.duration_ms > 500, `the recording claims ${stopped.duration_ms}ms`);
				assertStringIncludes(stopped.url ?? '', '/api/v1/recordings/demo');
			});

			await t.step('the file on disk is a real WebM', async () => {
				const bytes = await Deno.readFile(join(dir, 'recordings', 'demo.webm'));
				assert(isWebm(bytes), `not a WebM container: ${[...bytes.subarray(0, 4)]}`);
				assert(bytes.length > 1000, `suspiciously small: ${bytes.length} bytes`);
			});

			await t.step('it downloads over HTTP with the right type', async () => {
				const response = await h.fetch('/api/v1/recordings/demo');
				assertEquals(response.status, 200);
				assertEquals(response.headers.get('content-type'), 'video/webm');
				assertStringIncludes(response.headers.get('content-disposition') ?? '', 'demo.webm');
				const bytes = new Uint8Array(await response.arrayBuffer());
				assert(isWebm(bytes));
			});

			await t.step('an unknown recording is a 404, not an empty file', async () => {
				const response = await h.fetch('/api/v1/recordings/never-made');
				assertEquals(response.status, 404);
				await response.body?.cancel();
			});

			await t.step('a second start on the same session is refused', async () => {
				await h.callText('browser_record', { action: 'start', name: 'twice' });
				assertStringIncludes(
					await h.callError('browser_record', { action: 'start', name: 'again' }),
					'already recording',
				);
				await h.callText('browser_record', { action: 'stop' });
			});

			await t.step('stopping when nothing is recording is refused', async () => {
				assertStringIncludes(
					await h.callError('browser_record', { action: 'stop' }),
					'is not recording',
				);
			});

			await t.step('recording survives a human takeover, because it only watches', async () => {
				await h.callText('browser_record', { action: 'start', name: 'during-takeover' });
				const socket = await h.live();
				const meta = await socket.ready();
				socket.send({ type: 'control.take' });
				await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);

				// A human driving is exactly when a recording is worth having, so
				// what the human does must end up in the file.
				socket.send({ type: 'input.wheel', x: 200, y: 200, deltaX: 0, deltaY: 300 });
				await new Promise((resolve) => setTimeout(resolve, 600));

				const status = await h.callJson<Recording>('browser_record', { action: 'status' });
				assertEquals(status.recording, true);
				assert(status.frames > 0, 'the recording saw nothing while the human drove');

				const stopped = await h.callJson<Recording>('browser_record', { action: 'stop' });
				assert((stopped.bytes ?? 0) > 0, `the encoder produced ${stopped.bytes ?? 0} bytes`);
				await socket.close();
			});
		} finally {
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		}
	},
});

Deno.test({
	name: 'e2e R7: without ffmpeg the tool is not offered at all',
	ignore: skipUnlessBrowser('recording e2e (disabled path)'),
	async fn() {
		// No TTK_FFMPEG: R5 withdraws the tool rather than offering one that
		// would fail on a PATH lookup the server never made.
		await using h = await harness({ env: { TTK_DATA_DIR: 'tests/.scratch' } });
		const names = (await h.client.listTools({})).tools.map((tool) => tool.name);
		assert(!names.includes('browser_record'), 'recording must not be advertised without an encoder');
	},
});
