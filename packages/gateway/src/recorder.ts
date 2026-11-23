/** Session recording. Why frames are repeated. Why not variable-rate timestamps. */
import type { RecordingController, RecordingInfo, SessionAccess, SessionRegistry } from '@tykotech/mcp';
import { childEnvOverrides, ToolError } from '@tykotech/mcp';
import type { Logger } from './logger.ts';

/** Frames per second written to the encoder. */
const RECORD_FPS = 5;
/** Hard cap on one recording, so a forgotten `start` cannot fill a disk. */
const MAX_RECORDING_MS = 30 * 60 * 1000;
/** How long to wait for ffmpeg to finish writing after stdin closes. */
const FLUSH_TIMEOUT_MS = 20_000;
/** How long `start` waits for the first frame. */
const FIRST_FRAME_TIMEOUT_MS = 3_000;
/**
 * How often a running recording is held to the disk budget. A walk per frame would cost more than the frame; at 1
 * Mbit/s a recording grows well under a megabyte between two checks, which is the most it can run past the budget.
 */
const BUDGET_CHECK_MS = 5_000;

/** A name that is safe as one path segment. */
function safeRecordingName(name: string): string {
	const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	if (cleaned === '') {
		throw new ToolError('invalid-arguments', `recording name ${JSON.stringify(name)} has no usable characters`);
	}
	return cleaned.slice(0, 64);
}

/**
 * The child process the recorder drives — the subset of `Deno.ChildProcess` it uses, so a test can supply an encoder
 * that is not a real `ffmpeg` (the recordings route's ownership is proven at the unit tier without `--allow-run`).
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
	/**
	 * The disk budget recordings share with the file share. Spent, `start` is refused; reached while recording, the
	 * recording is stopped and finalised, as the 30-minute cap does. Absent, only that cap bounds a recording.
	 */
	readonly budget?: { exhausted(): Promise<boolean> };
	/** Test seam: how often a running recording is checked against `budget`; {@linkcode BUDGET_CHECK_MS} by default. */
	readonly budgetCheckMs?: number;
}

/** One recording in flight. */
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
	/** When the disk budget was last asked, and whether that answer is still outstanding. */
	budgetCheckedAt: number;
	budgetChecking: boolean;
}

export class Recorder implements RecordingController {
	readonly #deps: RecorderDeps;
	readonly #active = new Map<string, ActiveRecording>();
	/**
	 * Who started each recording this process wrote, by safe name. In memory only, so after a restart no recording has
	 * a known owner, and in `owner` mode those are served to `admin` alone.
	 */
	readonly #owners = new Map<string, string>();
	/** Sessions whose `start` is in flight, reserved before its first `await` so a second start is refused. */
	readonly #starting = new Set<string>();
	/** In `owner` mode, the recording names a start in flight has claimed, so no other start can take one. */
	readonly #claimed = new Set<string>();

	constructor(deps: RecorderDeps) {
		this.#deps = deps;
	}

	get enabled(): boolean {
		return this.#deps.dir !== null;
	}

	/** Where recordings are written, for the disk budget; `null` when recording is off. */
	get dir(): string | null {
		return this.#deps.dir;
	}

	/**
	 * Whether `access` may download the recording `name`. Always in `shared` mode — a recording is the browser after
	 * the fact, and `view:watch` already watches every session there.
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

	/** `owner` binds the recording to its starter. */
	async start(sessionId: string, name: string, owner?: string): Promise<RecordingInfo> {
		const dir = this.#requireDir();
		// Every check below and its reservation run before the first `await`.
		if (this.#active.has(sessionId) || this.#starting.has(sessionId)) {
			throw new ToolError('invalid-arguments', `session ${sessionId} is already recording`);
		}
		// The session must exist: recording is about a browser, and creating one as a side effect of "start recording"
		// would be a surprise.
		if (this.#deps.registry.peek(sessionId) === undefined) {
			throw new ToolError('unknown-session', `no session with id ${sessionId}`);
		}

		const safe = safeRecordingName(name);
		const path = `${dir}/${safe}.webm`;
		const owned = this.#deps.registry.ownership === 'owner';
		const holder = this.#owners.get(safe);
		if (owned && ((holder !== undefined && holder !== owner) || this.#claimed.has(safe))) {
			throw new ToolError('invalid-arguments', `recording name ${safe} is in use; choose another name`);
		}
		this.#starting.add(sessionId);
		if (owned) this.#claimed.add(safe);
		try {
			if (owned && holder === undefined && await Deno.stat(path).then(() => true, () => false)) {
				throw new ToolError('invalid-arguments', `recording name ${safe} is in use; choose another name`);
			}
			// Asked after the reservation, so the checks above still run before the first `await`. `file-unavailable`
			// is the code a share write past the same budget already answers with.
			if (await this.#deps.budget?.exhausted()) {
				throw new ToolError(
					'file-unavailable',
					'the file share and recordings are at their disk budget (TTK_DISK_BUDGET_MB); free space to record',
				);
			}
			return await this.#begin(sessionId, safe, path, dir, owner);
		} finally {
			// Released on every path: once `#begin` succeeds, `#active` and `#owners` hold the session and the name.
			this.#starting.delete(sessionId);
			if (owned) this.#claimed.delete(safe);
		}
	}

	/** The body of {@linkcode start}, run while its session (and, in `owner` mode, its name) is reserved. */
	async #begin(
		sessionId: string,
		safe: string,
		path: string,
		dir: string,
		owner: string | undefined,
	): Promise<RecordingInfo> {
		await Deno.mkdir(dir, { recursive: true }).catch(() => {});

		let child: EncoderProcess;
		try {
			// ffmpeg gets the same blank overrides Chromium does — no exporter settings, no inline secret.
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
					// Realtime settings: this runs beside a live browser, and an encoder that pins a core would show up
					// as a slow page.
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
			budgetCheckedAt: Date.now(),
			budgetChecking: false,
		};

		// stderr is drained and kept only on failure: ffmpeg is chatty on the way down, and an undrained pipe
		// eventually blocks the child.
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

		try {
			record.detach = await this.#deps.subscribe(sessionId, (base64) => {
				const bytes = decodeJpeg(base64);
				record.last = bytes;
				write(bytes);
				sawFirstFrame?.();
				sawFirstFrame = null;
			});
		} catch (cause) {
			// The encoder is already running and nothing tracks it yet; without this it would outlive the failure.
			await writer.abort().catch(() => {});
			try {
				child.kill('SIGKILL');
			} catch { /* already gone */ }
			throw cause;
		}

		// `start` means "recording has begun", so it waits for proof of that.
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
			this.#checkBudget(sessionId, record);
		}, Math.round(1000 / RECORD_FPS));
		Deno.unrefTimer(timer);
		record.timer = timer;

		this.#active.set(sessionId, record);
		if (owner !== undefined) this.#owners.set(safe, owner);
		this.#deps.logger.info(`recording ${safe} started for session ${sessionId}`);

		// Surface an immediate ffmpeg failure (a missing codec, an unwritable path) rather than reporting success and
		// producing an empty file.
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

		// Closing stdin is what tells ffmpeg to finalise the container. A file whose moov/cues were never written is
		// not a video.
		await active.writer.close().catch(() => {});
		// The deadline timer is cleared whichever way the race goes; a 20-second timer left pending per recording is a
		// slow leak in a long-lived server and an outright test failure under the op sanitizer.
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
			// Reported as zero rather than throwing: the recording happened, and the caller needs to know it produced
			// nothing.
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

	/**
	 * Called from the repeater, at most once per {@linkcode BUDGET_CHECK_MS} and never two at once: when the disk
	 * budget is spent, the recording is stopped the way the 30-minute cap stops it, so the file is finalised and
	 * playable.
	 */
	#checkBudget(sessionId: string, record: ActiveRecording): void {
		const budget = this.#deps.budget;
		if (budget === undefined || record.budgetChecking) return;
		const now = Date.now();
		if (now - record.budgetCheckedAt < (this.#deps.budgetCheckMs ?? BUDGET_CHECK_MS)) return;
		record.budgetCheckedAt = now;
		record.budgetChecking = true;
		void budget.exhausted().then((spent) => {
			// Only the recording that asked: it may have been stopped, and the session recording again, meanwhile.
			if (!spent || this.#active.get(sessionId) !== record) return;
			this.#deps.logger.warn(`recording ${record.name} reached the disk budget (TTK_DISK_BUDGET_MB); stopping`);
			return this.stop(sessionId).then(() => {});
		}).catch(() => {}).finally(() => {
			record.budgetChecking = false;
		});
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
