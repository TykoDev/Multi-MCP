/**
 * Session recording (SPECS/ROADMAP.md R7).
 *
 * The screencast already produces a JPEG per repaint; recording is what happens
 * when those frames go to an encoder instead of (or as well as) a viewer. The
 * encoder is `ffmpeg`, run as a child process reading a concatenated JPEG
 * stream on stdin — the roadmap's "ffmpeg sidecar", chosen over writing a
 * container by hand because the output has to be a file people can actually
 * open.
 *
 * ## Why frames are repeated
 *
 * Chrome emits a screencast frame when the page *paints*, so a page nobody is
 * touching emits nothing at all. Piped straight into a constant-rate encoder
 * that makes idle time vanish: a ten-minute session where someone read a page
 * for nine of them plays back in seconds, and the recording no longer shows
 * what happened when. So the last frame is re-sent on a timer, which costs
 * almost nothing (VP9 encodes a repeated frame to a handful of bytes) and buys
 * a recording whose timeline matches the session's.
 *
 * ## Why not variable-rate timestamps
 *
 * `-use_wallclock_as_timestamps` with a variable frame-rate output would be
 * exact rather than approximate, but the flag that makes it work has been
 * spelled three different ways across ffmpeg 4, 5 and 7 (`-vsync vfr`,
 * `-fps_mode vfr`). A constant rate plus a repeater behaves identically on all
 * of them, and this code cannot choose which ffmpeg a deployment has.
 */
import type { RecordingController, RecordingInfo, SessionAccess, SessionRegistry } from '@tykotech/mcp';
import { childEnvOverrides, ToolError } from '@tykotech/mcp';
import type { Logger } from './logger.ts';

/** Frames per second written to the encoder. */
const RECORD_FPS = 5;
/** Hard cap on one recording, so a forgotten `start` cannot fill a disk. */
export const MAX_RECORDING_MS = 30 * 60 * 1000;
/** How long to wait for ffmpeg to finish writing after stdin closes. */
const FLUSH_TIMEOUT_MS = 20_000;
/**
 * How long `start` waits for the first frame.
 *
 * A recording that begins on a settled page would otherwise contain nothing
 * until something moved — and a short recording of a still page would be an
 * empty file. Chrome sends a frame as soon as the screencast starts, and the
 * cast replays its last one to a late subscriber, so this normally resolves in
 * milliseconds; the bound only matters when the browser is wedged.
 */
const FIRST_FRAME_TIMEOUT_MS = 3_000;

/** A name that is safe as one path segment. */
export function safeRecordingName(name: string): string {
	const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	if (cleaned === '') {
		throw new ToolError('invalid-arguments', `recording name ${JSON.stringify(name)} has no usable characters`);
	}
	return cleaned.slice(0, 64);
}

/**
 * The child process the recorder drives — the subset of `Deno.ChildProcess` it uses, so a test can supply an encoder
 * that is not a real `ffmpeg` (F26: the recordings route's ownership is proven at the unit tier without `--allow-run`).
 */
export interface EncoderProcess {
	readonly stdin: WritableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly status: Promise<Deno.CommandStatus>;
	kill(signal?: Deno.Signal): void;
}

/** Starts the encoder: `ffmpeg` with these arguments and this environment. */
export type EncoderSpawn = (
	command: string,
	options: { args: string[]; env: Record<string, string> },
) => EncoderProcess;

/** The production {@linkcode EncoderSpawn}: a real child with piped stdin and stderr. */
const spawnEncoder: EncoderSpawn = (command, options) =>
	new Deno.Command(command, {
		args: options.args,
		env: options.env,
		stdin: 'piped',
		stdout: 'null',
		stderr: 'piped',
	}).spawn();

/** What the gateway must supply for recording to be possible. */
export interface RecorderDeps {
	readonly registry: SessionRegistry;
	/** Attaches a frame consumer to a session's shared screencast. */
	readonly subscribe: (
		sessionId: string,
		onFrame: (jpegBase64: string) => void,
	) => Promise<() => void>;
	/** Directory recordings are written into; `null` disables recording. */
	readonly dir: string | null;
	/** The `ffmpeg` executable. */
	readonly ffmpeg: string;
	readonly logger: Logger;
	/** Starts the encoder; a real `ffmpeg` child unless a test supplies one. */
	readonly spawn?: EncoderSpawn;
}

/**
 * One recording in flight.
 *
 * `detach` and `timer` are mutable because they can only exist *after* the
 * record does — the frame callback and the repeater both close over it. An
 * earlier version built the record, then spread it into a second object once
 * those were available; the closures kept writing to the first, so `frames`
 * stayed at zero while the encoder happily produced a video. The container
 * verification caught it (`0 frames, 7513 bytes`), which is exactly the shape
 * of bug a spread of a mutable object produces.
 */
interface ActiveRecording {
	readonly name: string;
	readonly path: string;
	readonly startedAt: number;
	readonly child: EncoderProcess;
	readonly writer: WritableStreamDefaultWriter<Uint8Array>;
	detach: () => void;
	timer: ReturnType<typeof setInterval> | null;
	frames: number;
	last: Uint8Array | null;
	/** Set once the writer has failed, so the repeater stops trying. */
	broken: boolean;
}

export class Recorder implements RecordingController {
	readonly #deps: RecorderDeps;
	readonly #active = new Map<string, ActiveRecording>();
	/**
	 * R8 (D-128): who started each recording this process wrote, by safe name. In memory only, so after a restart no
	 * recording has a known owner, and in `owner` mode those are served to `admin` alone.
	 */
	readonly #owners = new Map<string, string>();

	constructor(deps: RecorderDeps) {
		this.#deps = deps;
	}

	get enabled(): boolean {
		return this.#deps.dir !== null;
	}

	/** D-155: where recordings are written, for the overview's count; `null` when recording is off. */
	get dir(): string | null {
		return this.#deps.dir;
	}

	/**
	 * Whether `access` may download the recording `name` (R8, D-128). Always in `shared` mode — a recording is the
	 * browser after the fact, and `view:watch` already watches every session there. In `owner` mode only its starter
	 * or an `admin`; a recording whose starter is unknown (written before this process started) is `admin`'s alone.
	 * A name that is not a valid recording name is nobody's.
	 */
	mayRead(name: string, access: SessionAccess): boolean {
		if (this.#deps.registry.ownership !== 'owner' || access.admin) return true;
		let safe: string;
		try {
			safe = safeRecordingName(name);
		} catch {
			return false;
		}
		return this.#owners.get(safe) === access.owner;
	}

	status(sessionId: string): RecordingInfo | null {
		const active = this.#active.get(sessionId);
		if (active === undefined) return null;
		return {
			session_id: sessionId,
			name: active.name,
			recording: true,
			frames: active.frames,
			duration_ms: Date.now() - active.startedAt,
		};
	}

	list(): RecordingInfo[] {
		return [...this.#active.keys()].map((id) => this.status(id)).filter((info): info is RecordingInfo => info !== null);
	}

	/**
	 * `owner` binds the recording to its starter (R8, D-128). In `owner` mode a name another owner's recording holds —
	 * or one already on disk from before this process, whose owner is unknown — is refused: writing it would replace
	 * that recording's file and take it over. The refusal names no owner.
	 */
	async start(sessionId: string, name: string, owner?: string): Promise<RecordingInfo> {
		const dir = this.#requireDir();
		if (this.#active.has(sessionId)) {
			throw new ToolError('invalid-arguments', `session ${sessionId} is already recording`);
		}
		// The session must exist: recording is about a browser, and creating one
		// as a side effect of "start recording" would be a surprise.
		if (this.#deps.registry.peek(sessionId) === undefined) {
			throw new ToolError('unknown-session', `no session with id ${sessionId}`);
		}

		const safe = safeRecordingName(name);
		const path = `${dir}/${safe}.webm`;
		if (this.#deps.registry.ownership === 'owner') {
			const holder = this.#owners.get(safe);
			const onDisk = holder === undefined && await Deno.stat(path).then(() => true, () => false);
			if ((holder !== undefined && holder !== owner) || onDisk) {
				throw new ToolError('invalid-arguments', `recording name ${safe} is in use; choose another name`);
			}
		}
		await Deno.mkdir(dir, { recursive: true }).catch(() => {});

		let child: EncoderProcess;
		try {
			// D-127: ffmpeg gets the same blank overrides Chromium does — no exporter settings, no inline secret.
			child = (this.#deps.spawn ?? spawnEncoder)(this.#deps.ffmpeg, {
				env: childEnvOverrides(),
				args: [
					'-hide_banner',
					'-loglevel',
					'error',
					'-f',
					'image2pipe',
					'-framerate',
					String(RECORD_FPS),
					'-i',
					'pipe:0',
					'-c:v',
					'libvpx-vp9',
					// Realtime settings: this runs beside a live browser, and an
					// encoder that pins a core would show up as a slow page.
					'-deadline',
					'realtime',
					'-cpu-used',
					'8',
					'-b:v',
					'1M',
					'-pix_fmt',
					'yuv420p',
					'-y',
					path,
				],
			});
		} catch (cause) {
			throw new ToolError(
				'browser-unavailable',
				`could not start ${this.#deps.ffmpeg}: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}

		const writer = child.stdin.getWriter();
		const record: ActiveRecording = {
			name: safe,
			path,
			startedAt: Date.now(),
			child,
			writer,
			detach: () => {},
			timer: null,
			frames: 0,
			last: null,
			broken: false,
		};

		// stderr is drained and kept only on failure: ffmpeg is chatty on the way
		// down, and an undrained pipe eventually blocks the child.
		const stderr: string[] = [];
		void (async () => {
			for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) stderr.push(chunk);
		})().catch(() => {});

		const write = (jpeg: Uint8Array) => {
			if (record.broken) return;
			record.frames += 1;
			writer.write(jpeg).catch(() => {
				record.broken = true;
			});
		};

		let sawFirstFrame: (() => void) | null = null;
		const firstFrame = new Promise<void>((resolve) => (sawFirstFrame = resolve));

		record.detach = await this.#deps.subscribe(sessionId, (base64) => {
			const bytes = decodeJpeg(base64);
			record.last = bytes;
			write(bytes);
			sawFirstFrame?.();
			sawFirstFrame = null;
		});

		// `start` means "recording has begun", so it waits for proof of that. The
		// timer is always cleared: `unref` keeps it from holding the process open
		// but leaves it pending, which is a leak a test sanitizer is right to
		// flag and a slow drip in a long-lived server.
		let waitTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				firstFrame,
				new Promise<void>((resolve) => {
					waitTimer = setTimeout(resolve, FIRST_FRAME_TIMEOUT_MS);
					Deno.unrefTimer(waitTimer);
				}),
			]);
		} finally {
			clearTimeout(waitTimer);
		}
		if (record.frames === 0) {
			this.#deps.logger.warn(
				`recording ${safe}: no frame within ${FIRST_FRAME_TIMEOUT_MS}ms; the page may not be painting`,
			);
		}

		const timer = setInterval(() => {
			// The repeater: without it, idle time disappears from the timeline.
			if (record.last !== null) write(record.last);
			if (Date.now() - record.startedAt > MAX_RECORDING_MS) {
				this.#deps.logger.warn(`recording ${safe} hit its ${MAX_RECORDING_MS}ms cap; stopping`);
				void this.stop(sessionId).catch(() => {});
			}
		}, Math.round(1000 / RECORD_FPS));
		Deno.unrefTimer(timer);
		record.timer = timer;

		this.#active.set(sessionId, record);
		if (owner !== undefined) this.#owners.set(safe, owner);
		this.#deps.logger.info(`recording ${safe} started for session ${sessionId}`);

		// Surface an immediate ffmpeg failure (a missing codec, an unwritable
		// path) rather than reporting success and producing an empty file.
		let probeTimer: ReturnType<typeof setTimeout> | undefined;
		let failedEarly: Deno.CommandStatus | null;
		try {
			failedEarly = await Promise.race([
				child.status.then((status) => (status.success ? null : status)),
				new Promise<null>((resolve) => {
					probeTimer = setTimeout(() => resolve(null), 300);
				}),
			]);
		} finally {
			clearTimeout(probeTimer);
		}
		if (failedEarly !== null) {
			this.#active.delete(sessionId);
			clearInterval(timer);
			record.detach();
			await writer.close().catch(() => {});
			throw new ToolError(
				'browser-unavailable',
				`ffmpeg exited immediately (${failedEarly.code}): ${stderr.join('').slice(0, 300) || 'no output'}`,
			);
		}

		return {
			session_id: sessionId,
			name: safe,
			recording: true,
			frames: record.frames,
			duration_ms: Date.now() - record.startedAt,
		};
	}

	async stop(sessionId: string): Promise<RecordingInfo> {
		const active = this.#active.get(sessionId);
		if (active === undefined) {
			throw new ToolError('invalid-arguments', `session ${sessionId} is not recording`);
		}
		this.#active.delete(sessionId);
		if (active.timer !== null) clearInterval(active.timer);
		active.detach();

		// Closing stdin is what tells ffmpeg to finalise the container. A file
		// whose moov/cues were never written is not a video.
		await active.writer.close().catch(() => {});
		// The deadline timer is cleared whichever way the race goes; a 20-second
		// timer left pending per recording is a slow leak in a long-lived server
		// and an outright test failure under the op sanitizer.
		let flushTimer: ReturnType<typeof setTimeout> | undefined;
		let finished: Deno.CommandStatus | null;
		try {
			finished = await Promise.race([
				active.child.status,
				new Promise<null>((resolve) => {
					flushTimer = setTimeout(() => resolve(null), FLUSH_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(flushTimer);
		}
		if (finished === null) {
			this.#deps.logger.warn(`ffmpeg did not finish within ${FLUSH_TIMEOUT_MS}ms; killing it`);
			try {
				active.child.kill('SIGKILL');
			} catch { /* already gone */ }
			await active.child.status.catch(() => {});
		}

		let bytes = 0;
		try {
			bytes = (await Deno.stat(active.path)).size;
		} catch {
			// Reported as zero rather than throwing: the recording happened, and
			// the caller needs to know it produced nothing.
		}
		const info: RecordingInfo = {
			session_id: sessionId,
			name: active.name,
			recording: false,
			frames: active.frames,
			duration_ms: Date.now() - active.startedAt,
			bytes,
			url: `/api/v1/recordings/${encodeURIComponent(active.name)}`,
		};
		this.#deps.logger.info(`recording ${active.name} stopped: ${active.frames} frames, ${bytes} bytes`);
		return info;
	}

	/** Stops everything still running, for shutdown. */
	async stopAll(): Promise<void> {
		await Promise.all([...this.#active.keys()].map((id) => this.stop(id).catch(() => {})));
	}

	/** The on-disk path for a saved recording, or `null` when recording is off. */
	pathFor(name: string): string | null {
		if (this.#deps.dir === null) return null;
		return `${this.#deps.dir}/${safeRecordingName(name)}.webm`;
	}

	#requireDir(): string {
		if (this.#deps.dir === null) {
			throw new ToolError(
				'invalid-arguments',
				'recording needs a data directory; start the server with TTK_DATA_DIR set',
			);
		}
		return this.#deps.dir;
	}
}

/** Base64 → bytes, without going through a string of char codes. */
function decodeJpeg(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
