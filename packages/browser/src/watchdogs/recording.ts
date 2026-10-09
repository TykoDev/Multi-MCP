/**
 * @module
 * `RecordingWatchdog` ○ — screencast frame capture (ARCHITECTURE.md §6.12).
 *
 * > when `recordVideoDir` is set: `Page.startScreencast` on the focused session, frame ack +
 * > buffering, restart on focus change. v1 captures and stores frames; **mp4 encoding is deferred
 * > (D-SCOPE1)**.
 *
 * So this file ends at "a directory full of numbered frames plus a manifest". There is no encoder, no
 * ffmpeg shell-out, and no dependency that would need one — D-SCOPE1 puts encoding out of v1 and
 * ARCHITECTURE.md §8 additionally forbids CPU-heavy work in the core path.
 *
 * ## The three mechanisms §6.12 names
 *
 * - **`Page.startScreencast` on the focused session.** Screencast is per-target; only the tab the
 *   agent is looking at is worth recording.
 * - **Frame ack.** Chrome throttles the screencast to one un-acked frame: without
 *   `Page.screencastFrameAck` the stream delivers a single frame and stops. The ack is therefore not
 *   bookkeeping, it is the flow-control loop.
 * - **Restart on focus change.** `AgentFocusChangedEvent` stops the old session's screencast and
 *   starts one on the new session, so the recording follows the agent across tabs.
 *
 * ## Buffering, and the bound on it (ERRATUM(M1-watchdogs-rest-9))
 *
 * §6.12 says "buffering" without a bound, a frame format, or a quality. A JPEG frame runs 30–150 kB,
 * so an unbounded buffer on a long run is an OOM with extra steps. Frames are held in memory (that is
 * what "buffering" means) up to {@linkcode RECORDING_MAX_BUFFERED_FRAMES}, oldest dropped and
 * counted, and written to disk exactly once, in {@linkcode RecordingWatchdog.flush}, from the
 * `BrowserStopEvent` handler. No background IO: a write started from a CDP callback would outlive
 * `detach()` and the op sanitizer would (correctly) call that a leak.
 */

import { decodeBase64 } from '@std/encoding/base64';
import { join } from '@std/path';
import type { HandlerContext } from '@tykotech/bus';
import type { CdpClient, CdpEventParams, SessionId, TargetId } from '@tykotech/cdp';
import { AgentFocusChangedEvent, BrowserConnectedEvent, BrowserStopEvent } from '../events.ts';
import type { BrowserProfile, ViewportSize } from '../types.ts';
import { type HandlerBudget, handlerBudget } from './handler_budget.ts';
import { BaseWatchdog } from './base.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Screencast wire format. JPEG is what Chrome streams efficiently; PNG frames are ~10× larger. */
export const RECORDING_FRAME_FORMAT = 'jpeg' as const;

/** JPEG quality of the streamed frames (see the module note on invented values). */
export const RECORDING_FRAME_QUALITY = 80;

/** In-memory frame bound. ~30–150 kB per frame, so ≈ 10–45 MB at the cap. */
export const RECORDING_MAX_BUFFERED_FRAMES = 300;

/** Manifest written beside the frames on flush. */
export const RECORDING_MANIFEST_FILENAME = 'frames.json';

/** Manifest schema version, so a later encoder can tell generations apart. */
export const RECORDING_MANIFEST_VERSION = 1;

/** `frame-000001.jpeg` — zero-padded so lexical order is capture order for any frame tool. */
export function recordingFrameFilename(index: number): string {
	return `frame-${String(index).padStart(6, '0')}.${RECORDING_FRAME_FORMAT}`;
}

/** The conditional-attachment predicate (ARCHITECTURE.md §6.12). */
export function shouldAttachRecordingWatchdog(profile: Pick<BrowserProfile, 'recordVideoDir'>): boolean {
	return profile.recordVideoDir !== null;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** One buffered screencast frame. `data` is the raw base64 Chrome sent. */
export interface RecordedFrame {
	readonly index: number;
	readonly data: string;
	readonly targetId: TargetId | null;
	readonly metadata: CdpEventParams['Page.screencastFrame']['metadata'];
	/** ISO-8601 reception time (wall clock), matching the event-envelope spelling of §5.1. */
	readonly receivedAt: string;
}

/** One frame as it appears in the on-disk manifest. */
export interface RecordingManifestFrame {
	readonly index: number;
	readonly file: string;
	readonly targetId: TargetId | null;
	readonly receivedAt: string;
	readonly metadata: CdpEventParams['Page.screencastFrame']['metadata'];
}

/** `frames.json`: everything an encoder would need, minus the encoder (D-SCOPE1). */
export interface RecordingManifest {
	readonly version: number;
	readonly format: typeof RECORDING_FRAME_FORMAT;
	/** The *intended playback* rate from `BrowserProfile.recordVideoFramerate`; see the note below. */
	readonly framerate: number;
	readonly size: ViewportSize | null;
	readonly frames: readonly RecordingManifestFrame[];
	/** Frames evicted by the buffer bound; non-zero means the recording has gaps. */
	readonly droppedFrames: number;
}

/** What {@linkcode RecordingWatchdog.flush} wrote. */
export interface RecordingFlushResult {
	readonly directory: string;
	readonly manifestPath: string;
	readonly frameFiles: readonly string[];
	readonly droppedFrames: number;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class RecordingWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [BrowserConnectedEvent, AgentFocusChangedEvent, BrowserStopEvent];
	static override readonly EMITS = [];

	readonly #frames: RecordedFrame[] = [];
	/**
	 * Frames already on disk, accumulated across flushes (ERRATUM(CANCEL-1)).
	 *
	 * A budget-truncated flush re-queues its remainder and a later flush finishes it; the manifest is
	 * rewritten each time and must describe **every** frame in the directory, not just the last pass's.
	 */
	readonly #manifestFrames: RecordingManifestFrame[] = [];
	readonly #pending = new Set<Promise<unknown>>();
	#unsubscribe: (() => void) | null = null;
	#armedClient: CdpClient | null = null;
	#castSessionId: SessionId | null = null;
	#castTargetId: TargetId | null = null;
	#captured = 0;
	#dropped = 0;

	// -- public surface ----------------------------------------------------------------------------

	/** `true` while a screencast is running on some session. */
	get recording(): boolean {
		return this.#castSessionId !== null;
	}

	/** The target currently being recorded, or `null`. */
	get recordedTargetId(): TargetId | null {
		return this.#castTargetId;
	}

	/** Buffered frames, oldest first. */
	get frames(): readonly RecordedFrame[] {
		return this.#frames;
	}

	/** Total frames received, including any the buffer bound later evicted. */
	get capturedFrames(): number {
		return this.#captured;
	}

	/** Frames evicted by {@linkcode RECORDING_MAX_BUFFERED_FRAMES}. */
	get droppedFrames(): number {
		return this.#dropped;
	}

	/** Where a flush would write. `null` when `recordVideoDir` is unset (watchdog is inert). */
	get directory(): string | null {
		return this.profile.recordVideoDir;
	}

	/** Resolves when every in-flight ack has settled. Tests await this, never a sleep. */
	async whenIdle(): Promise<void> {
		for (let guard = 0; guard < 10 && this.#pending.size > 0; guard++) {
			await Promise.allSettled([...this.#pending]);
		}
	}

	// -- handlers ----------------------------------------------------------------------------------

	/** Arms the frame listener and starts the screencast on whatever is focused right now. */
	async onBrowserConnectedEvent(_event: BrowserConnectedEvent, context?: HandlerContext): Promise<void> {
		if (!shouldAttachRecordingWatchdog(this.profile)) return;
		this.#armFrameListener();
		await this.restart(null, context);
	}

	/** "restart on focus change" (§6.12): stop the old screencast, start one on the new target. */
	async onAgentFocusChangedEvent(event: AgentFocusChangedEvent, context?: HandlerContext): Promise<void> {
		if (!shouldAttachRecordingWatchdog(this.profile)) return;
		if (event.targetId === this.#castTargetId) return;
		this.#armFrameListener();
		await this.restart(event.targetId, context);
	}

	/**
	 * Stops the screencast and writes the frames.
	 *
	 * Registered before `BrowserSession`'s own stop handler, which is what closes the socket (E-16),
	 * so `Page.stopScreencast` still has a transport to travel on.
	 *
	 * ERRATUM(CANCEL-1): the `HandlerContext` is read, for the reason ERRATUM(KILL-1) states — see
	 * {@linkcode RecordingWatchdog.flush}, which is where the 301 filesystem writes were.
	 */
	async onBrowserStopEvent(_event: BrowserStopEvent, context?: HandlerContext): Promise<void> {
		if (!shouldAttachRecordingWatchdog(this.profile)) return;
		const budget = handlerBudget(context);
		await this.stopScreencast(context);
		// Not budget-checked, unlike `HarRecordingWatchdog`'s drain: `stopScreencast()` has already run,
		// so Chrome sends no further frames and `#pending` holds at most the acks already issued — one
		// round over a bounded set, not a ladder that can outlast the budget.
		await this.whenIdle();
		try {
			await this.flush(budget);
		} catch (error) {
			this.logger.error('could not write the screencast frames', { directory: this.directory, error });
		}
	}

	protected override beforeDetach(): void {
		this.#disarmFrameListener();
		this.#castSessionId = null;
		this.#castTargetId = null;
		this.#frames.length = 0;
		this.#manifestFrames.length = 0;
	}

	// -- screencast control ------------------------------------------------------------------------

	/** Stops any running screencast and starts one on `targetId` (or the focused target). */
	async restart(targetId: TargetId | null, context?: HandlerContext): Promise<boolean> {
		await this.stopScreencast(context);
		return await this.startScreencast(targetId, context);
	}

	/** `Page.startScreencast` on the focused session. Failures are logged, never thrown. */
	async startScreencast(targetId: TargetId | null, context?: HandlerContext): Promise<boolean> {
		const manager = this.host.sessionManager;
		if (manager === null || !manager.started) return false;
		const resolved = targetId ?? manager.agentFocusTargetId ?? manager.mostRecentPageTarget()?.targetId ?? null;
		if (resolved === null) return false;
		try {
			const session = await manager.getOrCreateCdpSession(resolved, false);
			const size = this.profile.recordVideoSize;
			await this.cdpFor(context).send.Page.startScreencast({
				format: RECORDING_FRAME_FORMAT,
				quality: RECORDING_FRAME_QUALITY,
				// CDP exposes no frame *rate*; `recordVideoFramerate` is carried in the manifest as the
				// intended playback rate instead (ERRATUM(M1-watchdogs-rest-9)).
				everyNthFrame: 1,
				...(size === null ? {} : { maxWidth: size.width, maxHeight: size.height }),
			}, session.sessionId);
			this.#castSessionId = session.sessionId;
			this.#castTargetId = resolved;
			this.logger.debug('screencast started', { targetId: resolved });
			return true;
		} catch (error) {
			this.logger.warn('could not start the screencast', { targetId: resolved, error });
			return false;
		}
	}

	/** `Page.stopScreencast` on whatever session is streaming. Idempotent, never throws. */
	async stopScreencast(context?: HandlerContext): Promise<void> {
		const sessionId = this.#castSessionId;
		this.#castSessionId = null;
		this.#castTargetId = null;
		if (sessionId === null) return;
		try {
			await this.cdpFor(context).send.Page.stopScreencast(undefined, sessionId);
		} catch (error) {
			this.logger.debug('stopScreencast failed; the session is probably already gone', { error });
		}
	}

	// -- flush -------------------------------------------------------------------------------------

	/**
	 * Writes the buffered frames plus {@linkcode RECORDING_MANIFEST_FILENAME} into `recordVideoDir`
	 * and clears the buffer. The only place this module touches the filesystem.
	 *
	 * ERRATUM(CANCEL-1): this loop was up to {@linkcode RECORDING_MAX_BUFFERED_FRAMES} + 1 sequential
	 * `Deno.writeFile` calls with nothing checked between them — structurally the same defect
	 * ERRATUM(KILL-3) fixed in the profile sweep, and reached from the same 45 s `BrowserStopEvent`.
	 * The budget is now consulted **between frames**, which is the only cancellation on offer: a single
	 * `Deno.writeFile` takes no signal and racing it with a timer stops the awaiting, not the write.
	 *
	 * The deliberate asymmetry, in the shape ERRATUM(KILL-1) chose: **frames are droppable, the
	 * manifest is not.** An unwritten frame is re-queued into `#frames`, so a later flush resumes it
	 * and the recording is at worst short a few frames at the tail — which is what
	 * {@linkcode RECORDING_MAX_BUFFERED_FRAMES} already does to a long run anyway. A directory of
	 * numbered JPEGs with no `frames.json` is a different thing entirely: D-SCOPE1 defers the encoder,
	 * so the manifest *is* the deliverable, and the frames without it are undated, unsized and unowned.
	 * The manifest write is therefore started even on the abort path — one small bounded operation,
	 * the same trade `launched.close()` gets in the kill handler.
	 *
	 * `budget` defaults to unbudgeted so a direct call (a test, a caller outside a dispatch) keeps the
	 * old behaviour rather than silently receiving a zero budget.
	 */
	async flush(budget: HandlerBudget = handlerBudget(undefined)): Promise<RecordingFlushResult | null> {
		const directory = this.profile.recordVideoDir;
		if (directory === null) return null;
		const frames = this.#frames.splice(0, this.#frames.length);
		await Deno.mkdir(directory, { recursive: true });

		const written: string[] = [];
		const deferred: RecordedFrame[] = [];
		for (const frame of frames) {
			if (budget.expired()) {
				deferred.push(frame);
				continue;
			}
			const file = recordingFrameFilename(frame.index);
			await Deno.writeFile(join(directory, file), decodeBase64(frame.data));
			written.push(file);
			this.#manifestFrames.push({
				index: frame.index,
				file,
				targetId: frame.targetId,
				receivedAt: frame.receivedAt,
				metadata: frame.metadata,
			});
		}
		if (deferred.length > 0) {
			// Re-queued in capture order, ahead of anything that arrived since (nothing can, in the stop
			// path). A flush that never comes loses them at `detach()`, which is why this is a warn.
			this.#frames.unshift(...deferred);
			this.logger.warn('the stop budget was spent before every screencast frame was written', {
				directory,
				written: written.length,
				deferred: deferred.length,
				hint: 'the frames stay buffered for the next flush; the manifest describes what is on disk',
			});
		}

		const manifest: RecordingManifest = {
			version: RECORDING_MANIFEST_VERSION,
			format: RECORDING_FRAME_FORMAT,
			framerate: this.profile.recordVideoFramerate,
			size: this.profile.recordVideoSize,
			frames: [...this.#manifestFrames],
			droppedFrames: this.#dropped,
		};
		const manifestPath = join(directory, RECORDING_MANIFEST_FILENAME);
		await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
		this.logger.debug('screencast frames written', { directory, frames: written.length, dropped: this.#dropped });
		return { directory, manifestPath, frameFiles: written, droppedFrames: this.#dropped };
	}

	// -- internals ---------------------------------------------------------------------------------

	#armFrameListener(): void {
		const client = this.host.cdpClient;
		if (client === null || client.state !== 'open') return;
		if (this.#armedClient === client && this.#unsubscribe !== null) return;
		this.#disarmFrameListener();
		this.#armedClient = client;
		this.#unsubscribe = client.on('Page.screencastFrame', (params, sessionId) => {
			this.#onFrame(params, sessionId);
		});
	}

	#disarmFrameListener(): void {
		const off = this.#unsubscribe;
		this.#unsubscribe = null;
		this.#armedClient = null;
		off?.();
	}

	#onFrame(params: CdpEventParams['Page.screencastFrame'], sessionId: SessionId | undefined): void {
		this.#captured += 1;
		this.#frames.push({
			index: this.#captured,
			data: params.data,
			targetId: sessionId === undefined ? null : this.host.sessionManager?.sessionTargets.get(sessionId) ?? null,
			metadata: params.metadata,
			receivedAt: new Date().toISOString(),
		});
		if (this.#frames.length > RECORDING_MAX_BUFFERED_FRAMES) {
			this.#dropped += this.#frames.length - RECORDING_MAX_BUFFERED_FRAMES;
			this.#frames.splice(0, this.#frames.length - RECORDING_MAX_BUFFERED_FRAMES);
		}
		this.#ack(params.sessionId, sessionId);
	}

	/**
	 * The flow-control half of the loop. Chrome delivers at most one un-acked frame, so a dropped ack
	 * silently ends the recording — hence the explicit warn rather than a swallow.
	 */
	#ack(screencastSessionId: number, sessionId: SessionId | undefined): void {
		let call: Promise<unknown>;
		try {
			// Bare `this.cdp` on purpose (ERRATUM(E-52) allowlist): this runs from Chrome's
			// `Page.screencastFrame` listener, which has no dispatch and therefore no context to bind.
			// It is also the flow-control ack — a skipped one ends the stream.
			call = this.cdp.send.Page.screencastFrameAck({ sessionId: screencastSessionId }, sessionId);
		} catch (error) {
			this.logger.warn('cannot ack a screencast frame without a CDP connection', { error });
			return;
		}
		const tracked = call.then(() => {}, (error: unknown) => {
			this.logger.warn('screencast frame ack failed; the stream will stall until the next start', { error });
		});
		this.#pending.add(tracked);
		void tracked.finally(() => this.#pending.delete(tracked));
	}
}
