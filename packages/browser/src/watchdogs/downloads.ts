/**
 * @module
 * `DownloadsWatchdog` — the downloads pipeline (ARCHITECTURE.md §6.8, DATA-MODEL.md §5.1.6,
 * SECURITY-AUTH.md §8.3).
 *
 * Responsibilities, in the order they happen:
 *
 * 1. `Browser.setDownloadBehavior` with the profile's downloads dir and `eventsEnabled: true` (the
 *    flag without which `downloadWillBegin`/`downloadProgress` never fire at all). A local browser
 *    gets `allowAndName`, so Chromium writes every file under its **download guid** (E-33);
 * 2. `Browser.downloadWillBegin` → install the record **synchronously**, sanitize the
 *    attacker-influenced `suggestedFilename` into a display name → `DownloadStartedEvent`;
 * 3. `Browser.downloadProgress` → `DownloadProgressEvent`, transfer-limit enforcement, and on
 *    `completed` a containment- and regular-file-checked `FileDownloadedEvent`;
 * 4. an optional `Network.responseReceived` sniffer that auto-downloads PDFs and attachments in-page
 *    (`autoDownloadPdfs`, default `true`), including the PDF-viewer navigation case;
 * 5. the **synchronous direct-callback channel** DefaultActionWatchdog uses for click-triggered
 *    download detection — {@linkcode DownloadsWatchdog.addDownloadListener} and the convenience
 *    {@linkcode DownloadsWatchdog.armDownloadWatch} built on it.
 *
 * ## ERRATUM(E-33): the file on disk is named by guid, never by the suggested filename
 *
 * The original pipeline used `behavior: 'allow'` and then *predicted* the name Chromium would write:
 * sanitize, ` (n)`-disambiguate against a directory listing, and hope. Measured against real Chrome
 * (Windows, 2026-09-05): the second `report.txt` of a session was recorded as `report (1).txt` while
 * Chromium overwrote `report.txt` in place — the first record then pointed at the *second* payload,
 * and the second record pointed at a file that did not exist. `allowAndName` removes the guess:
 * the storage name is the guid Chromium itself announced, the sanitized human name is metadata, and
 * a record can only be published once the file at `<dir>/<guid>` has been realpath'ed, contained and
 * stat'ed as a regular file. The same change removed the directory listing that used to sit between
 * `downloadWillBegin` and the record being installed, which is the gap a tiny download's
 * `completed` progress could fall into.
 *
 * ## Two rules that are security contracts, not conveniences
 *
 * - **Never guess a filename.** A guid that is not usable as a path component, or a suggested name
 *   that sanitizes to nothing, is a *rejection* with a `Browser.cancelDownload`: this module never
 *   falls back to a name of its own invention. Sanitisation and the containment predicate live in
 *   `src/security/containment.ts` — none of it is reimplemented here.
 * - **Remote browsers never touch the local filesystem.** When the session is attached to a browser
 *   this process does not own (`host.isLocal === false`), the download lives on the remote host: no
 *   directory is created, no file is stat'ed, no path is realpath'ed, nothing is removed. The
 *   reported path is *synthesized* from the sanitized name and `fileSize` is `0` (ARCHITECTURE.md
 *   §6.8). A remote browser that could make us write locally would be a sandbox escape with extra
 *   steps.
 *
 * ## Why the callback channel is synchronous
 *
 * A click that triggers a download races the bus: `DownloadStartedEvent` is dispatched
 * asynchronously and its handlers are wrapped by the circuit breaker, so a `ClickElementEvent`
 * handler awaiting the bus could miss its own download. Listeners registered through
 * {@linkcode DownloadsWatchdog.addDownloadListener} are invoked **directly from the CDP listener**,
 * before any dispatch, so the click path observes the download the moment Chrome announces it.
 */

import { basename, extname, join } from '@std/path';
import type { HandlerContext } from '@tykotech/bus';
import type { SessionId, TargetId } from '@tykotech/cdp';
import {
	BrowserConnectedEvent,
	BrowserErrorEvent,
	BrowserStateRequestEvent,
	BrowserStoppedEvent,
	DownloadProgressEvent,
	DownloadStartedEvent,
	FileDownloadedEvent,
	NavigationCompleteEvent,
} from '../events.ts';
import type { DownloadState } from '../types.ts';
import { isContainedIn, sanitizeFilename, uniqueFilename } from '../security/containment.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants (ARCHITECTURE.md §6.8, §6.10, §8 — load-bearing, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/**
 * Grace period a click waits for `downloadWillBegin` before concluding nothing was downloaded
 * (ARCHITECTURE.md §6.10 / §8 "0.5 s/30 s download start/complete").
 *
 * Exported here rather than in `default_action.ts` because this watchdog owns the download clock;
 * the click path consumes it through {@linkcode DownloadsWatchdog.armDownloadWatch}.
 */
export const DOWNLOAD_START_GRACE_MS = 500;

/** How long a click waits for a started download to finish (ARCHITECTURE.md §6.10, §8). */
export const DOWNLOAD_COMPLETION_TIMEOUT_MS = 30_000;

/**
 * How long the `BrowserStateRequestEvent` side handler lets an in-flight download settle before the
 * state is assembled. Deliberately the same 0.5 s as the click grace: a download that started
 * milliseconds ago should appear in `downloadedFiles`, but state capture must never wait on a
 * multi-megabyte transfer.
 */
export const DOWNLOAD_SETTLE_GRACE_MS = 500;

/** MIME types that always mean "download this instead of rendering it". */
export const AUTO_DOWNLOAD_MIME_TYPES: readonly string[] = ['application/pdf', 'application/x-pdf'];

/**
 * A MIME type that means "download" only when the URL also names a file.
 *
 * Servers use `application/octet-stream` as a catch-all for resources a page fetches and handles
 * itself, so the type alone is not evidence.
 */
export const AMBIGUOUS_DOWNLOAD_MIME_TYPE = 'application/octet-stream';

// ---------------------------------------------------------------------------
// transfer limits (E-33; fixed initial values, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/** Downloads one session may track, in-flight and finished together. */
export const MAX_TRACKED_DOWNLOADS = 100;

/** Bytes one download may reach before it is cancelled and its partial removed. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** Bytes one session may hold across every tracked download. */
export const MAX_SESSION_DOWNLOAD_BYTES = 500 * 1024 * 1024;

/** How long a single transfer may run before it is cancelled as hung. */
export const DOWNLOAD_TRANSFER_DEADLINE_MS = 5 * 60_000;

/**
 * ERRATUM(E-54). Attempts to remove a cancelled download's partial, and the wait between them.
 *
 * A cancellation is asynchronous inside Chromium, so for a moment the browser still holds the
 * `.crdownload` handle — harmless on POSIX, a `PermissionDenied` on Windows. Five attempts over
 * roughly half a second covers the window that was measured without turning a leaked file into a
 * stuck cancellation.
 */
export const PARTIAL_REMOVE_ATTEMPTS = 5;
export const PARTIAL_REMOVE_RETRY_MS = 100;

/**
 * The shape a CDP download guid must have to become a path component. Chromium emits UUIDs; anything
 * else is refused rather than joined onto the downloads directory.
 */
const SAFE_GUID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** `true` when `guid` may be used verbatim as a file name under the downloads directory. */
export function isSafeDownloadGuid(guid: string): boolean {
	return SAFE_GUID.test(guid);
}

// ---------------------------------------------------------------------------
// the DefaultActionWatchdog seam
// ---------------------------------------------------------------------------

/** Lifecycle phase of a tracked download, as the direct-callback channel reports it. */
export type DownloadPhase = 'started' | 'progress' | 'completed' | 'canceled' | 'failed';

/** One download this watchdog is tracking. Immutable snapshot; never a live reference. */
export interface DownloadRecord {
	/** CDP download guid. Stable across `downloadWillBegin` and every `downloadProgress`. */
	readonly guid: string;
	readonly url: string;
	/** Exactly as Chrome suggested it — attacker-influenced, never used as a path. */
	readonly suggestedFilename: string;
	/**
	 * The sanitized, ` (n)`-disambiguated **display** name. Metadata only: the file on disk is named
	 * by {@linkcode DownloadRecord.guid} (E-33).
	 */
	readonly fileName: string;
	/** Absolute path, `<downloadsDir>/<guid>`. Synthesized (never written) for remote browsers. */
	readonly path: string;
	/** Bytes on disk once complete; always `0` for remote browsers (ARCHITECTURE.md §6.8). */
	readonly fileSize: number;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	/** Lower-case extension of the display name without the dot; `null` when it has none. */
	readonly fileType: string | null;
	readonly mimeType: string | null;
	/** `true` when the PDF/attachment sniffer started this rather than a click. */
	readonly autoDownload: boolean;
	readonly state: DownloadState;
	readonly startedAt: number;
	/** Set once the record is terminal — completed, canceled or failed. */
	readonly completedAt: number | null;
	/** Set when the download was refused, cancelled or could not be validated; the file is then unusable. */
	readonly error: string | null;
}

/**
 * `true` when a record names a validated, retrievable local file: the transfer completed, the
 * completion path finished its containment and regular-file checks, and nothing went wrong.
 *
 * `state === 'completed'` alone is **not** enough: the progress record carries that state before
 * validation runs, and a validation failure leaves it there with `error` set.
 */
export function isDownloadRetrievable(record: DownloadRecord): boolean {
	return record.state === 'completed' && record.completedAt !== null && record.error === null && record.path !== '';
}

/** What a direct listener is handed, synchronously, from the CDP listener. */
export interface DownloadSignal {
	readonly phase: DownloadPhase;
	readonly download: DownloadRecord;
}

/**
 * The synchronous direct-callback channel (ARCHITECTURE.md §6.8).
 *
 * Invoked from the CDP event listener before any bus dispatch. A listener MUST NOT throw and MUST
 * NOT block: it is on the transport's read path. Throwing is caught and logged, never propagated.
 */
export type DownloadListener = (signal: DownloadSignal) => void;

/** One-shot click-scoped download watch, returned by {@linkcode DownloadsWatchdog.armDownloadWatch}. */
export interface DownloadWatch extends Disposable {
	/**
	 * Resolves with the finished download, or `null` when nothing started inside the start grace.
	 *
	 * A download that starts but does not finish inside the completion timeout resolves with its
	 * last known record (`state: 'inProgress'`) rather than rejecting — a slow download is data the
	 * click handler should report, not an error that fails the action.
	 */
	readonly result: Promise<DownloadRecord | null>;
	/** Unsubscribes and settles `result` immediately. Idempotent. */
	dispose(): void;
}

/** Options for {@linkcode DownloadsWatchdog.armDownloadWatch}. */
export interface DownloadWatchOptions {
	/** Defaults to {@linkcode DOWNLOAD_START_GRACE_MS}. */
	readonly startGraceMs?: number;
	/** Defaults to {@linkcode DOWNLOAD_COMPLETION_TIMEOUT_MS}. */
	readonly completionTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/** What the completion path needs to know about the file Chromium wrote. */
export interface DownloadFileStat {
	readonly size: number;
	readonly isFile: boolean;
}

/** The transfer limits in force. */
export interface DownloadLimits {
	readonly maxTracked: number;
	readonly maxFileBytes: number;
	readonly maxSessionBytes: number;
	readonly transferDeadlineMs: number;
}

export const DEFAULT_DOWNLOAD_LIMITS: DownloadLimits = {
	maxTracked: MAX_TRACKED_DOWNLOADS,
	maxFileBytes: MAX_DOWNLOAD_BYTES,
	maxSessionBytes: MAX_SESSION_DOWNLOAD_BYTES,
	transferDeadlineMs: DOWNLOAD_TRANSFER_DEADLINE_MS,
};

/**
 * Injection seams. Every default is the real implementation; they exist because the tier-1 matrix
 * grants `--allow-write` only for `tests/.scratch` (OBSERVABILITY-TESTING-CICD.md §4.6) and because
 * the remote-browser contract is precisely "these functions are never called".
 */
export interface DownloadsWatchdogOptions {
	/** Overrides `profile.downloadsPath`. */
	readonly downloadsDir?: string | undefined;
	readonly ensureDir?: ((path: string) => Promise<void>) | undefined;
	/** Stat of the completed file; `null` when nothing is there. */
	readonly statFile?: ((path: string) => Promise<DownloadFileStat | null>) | undefined;
	/** Symlink-resolving realpath; `null` when the path does not exist. */
	readonly realPath?: ((path: string) => Promise<string | null>) | undefined;
	/** Removes one file; a missing file is not an error. Used for cancelled partials. */
	readonly removeFile?: ((path: string) => Promise<void>) | undefined;
	/** Injected clock, so `FakeTime` drives the watch timers. */
	readonly now?: (() => number) | undefined;
	/** Overrides the transfer limits; tests shrink them, production leaves them alone. */
	readonly limits?: Partial<DownloadLimits> | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class DownloadsWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [
		BrowserConnectedEvent,
		BrowserStoppedEvent,
		NavigationCompleteEvent,
		BrowserStateRequestEvent,
	];

	static override readonly EMITS = [
		DownloadStartedEvent,
		DownloadProgressEvent,
		FileDownloadedEvent,
		BrowserErrorEvent,
	];

	readonly #options: DownloadsWatchdogOptions;
	readonly #limits: DownloadLimits;
	readonly #now: () => number;
	readonly #listeners = new Set<DownloadListener>();
	readonly #cdpUnsubscribes: (() => void)[] = [];
	readonly #downloads = new Map<string, DownloadRecord>();
	/** Completed downloads, in completion order (the `upload_file` chain's `downloadedFiles`). */
	readonly #completed: string[] = [];
	/** URLs the sniffer has already auto-downloaded, so one PDF is not fetched twice. */
	readonly #autoDownloaded = new Set<string>();
	/** In-flight bookkeeping started from a synchronous CDP listener; awaited by `whenIdle()`. */
	readonly #pending = new Set<Promise<unknown>>();
	/** Per-download transfer deadline timers, cleared on every terminal transition. */
	readonly #deadlines = new Map<string, ReturnType<typeof setTimeout>>();

	#downloadsDir: string | null = null;
	#armed = false;
	/** The sniffer's own unsubscribe (ERRATUM(E-77)), kept apart so it can be armed after connect. */
	#snifferOff: (() => void) | null = null;

	constructor(host: WatchdogHost, options: DownloadsWatchdogOptions = {}) {
		super(host);
		this.#options = options;
		this.#limits = { ...DEFAULT_DOWNLOAD_LIMITS, ...options.limits };
		this.#now = options.now ?? Date.now;
	}

	// -- public surface ----------------------------------------------------------------------------

	/** Absolute directory downloads land in, or `null` before `BrowserConnectedEvent`. */
	get downloadsDir(): string | null {
		return this.#downloadsDir;
	}

	/** `true` when the browser is remote: nothing here may touch the local filesystem (§6.8). */
	get isRemoteBrowser(): boolean {
		return !this.host.isLocal;
	}

	/** The limits in force. */
	get limits(): DownloadLimits {
		return this.#limits;
	}

	/** Every tracked download, oldest first. */
	get downloads(): readonly DownloadRecord[] {
		return [...this.#downloads.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	/** One tracked download by guid, or `undefined`. */
	lookup(guid: string): DownloadRecord | undefined {
		return this.#downloads.get(guid);
	}

	/**
	 * Absolute paths of completed downloads, in completion order.
	 *
	 * This is the session's CDP-tracked `downloadedFiles` list that the `upload_file` authorization
	 * chain consults as its second link (SECURITY-AUTH.md §8.2). Every entry is a real, validated
	 * `<downloadsDir>/<guid>` path.
	 */
	get downloadedFiles(): readonly string[] {
		return [...this.#completed];
	}

	/**
	 * Registers a synchronous download listener. Returns the unsubscribe function.
	 *
	 * **This is the DefaultActionWatchdog seam.** Called directly from the CDP event listener, before
	 * any bus dispatch, so a click handler cannot miss the download it caused.
	 */
	addDownloadListener(listener: DownloadListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Arms a one-shot watch for a click-triggered download (ARCHITECTURE.md §6.10).
	 *
	 * Arm it *before* dispatching the click, `await` its `result` after, and always `dispose()` —
	 * `using watch = downloads.armDownloadWatch()` does that for you.
	 */
	armDownloadWatch(options: DownloadWatchOptions = {}): DownloadWatch {
		const startGraceMs = options.startGraceMs ?? DOWNLOAD_START_GRACE_MS;
		const completionTimeoutMs = options.completionTimeoutMs ?? DOWNLOAD_COMPLETION_TIMEOUT_MS;

		let settle: (value: DownloadRecord | null) => void = () => {};
		const result = new Promise<DownloadRecord | null>((resolve) => {
			settle = resolve;
		});

		let guid: string | null = null;
		let latest: DownloadRecord | null = null;
		let startTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
			startTimer = undefined;
			if (guid === null) finish(null);
		}, startGraceMs);
		let completionTimer: ReturnType<typeof setTimeout> | undefined;

		const clearTimers = (): void => {
			if (startTimer !== undefined) clearTimeout(startTimer);
			if (completionTimer !== undefined) clearTimeout(completionTimer);
			startTimer = undefined;
			completionTimer = undefined;
		};

		let done = false;
		const finish = (record: DownloadRecord | null): void => {
			if (done) return;
			done = true;
			clearTimers();
			off();
			settle(record);
		};

		const off = this.addDownloadListener((signal) => {
			if (guid === null && signal.phase === 'started') {
				guid = signal.download.guid;
				if (startTimer !== undefined) clearTimeout(startTimer);
				startTimer = undefined;
				completionTimer = setTimeout(() => finish(latest), completionTimeoutMs);
			}
			if (signal.download.guid !== guid) return;
			latest = signal.download;
			if (signal.phase === 'started' || signal.phase === 'progress') return;
			finish(signal.download);
		});

		return {
			result,
			dispose: () => finish(latest),
			[Symbol.dispose]: () => finish(latest),
		};
	}

	/**
	 * Cancels one in-flight download through `Browser.cancelDownload` and removes its partial file.
	 *
	 * Returns `false` when the guid is unknown or already terminal. The record becomes a
	 * `canceled` entry carrying `reason` as its error, so a later `downloadProgress` for the same
	 * guid is ignored rather than resurrecting it.
	 */
	async cancelDownload(guid: string, reason = 'canceled by the server'): Promise<boolean> {
		const known = this.#downloads.get(guid);
		if (known === undefined || known.completedAt !== null) return false;
		await this.#abort(known, reason);
		return true;
	}

	/**
	 * Re-applies `acceptDownloads` to the connected browser at runtime: `Browser.setDownloadBehavior` with
	 * `deny`, or with the behaviour {@linkcode onBrowserConnectedEvent} would have chosen for an accepting
	 * profile (`allowAndName` into the downloads directory locally, `allow` for a remote browser).
	 *
	 * ERRATUM(E-77). The donor read `profile.acceptDownloads` once, at connect, and offered no way to change
	 * it afterwards — so `browser_set_session_options {accept_downloads}` could only answer `unsupported`, and
	 * re-issuing the CDP command from outside this class would have moved the browser without moving the
	 * profile this watchdog (and its PDF sniffer) reads. The change goes through here so the two stay one
	 * fact: the profile is updated **only after** the browser accepted the new behaviour, and on a
	 * reconnect `onBrowserConnectedEvent` re-applies whatever was last set.
	 *
	 * @returns `true` when the browser now has the requested behaviour; `false` when this watchdog is not
	 * armed (no connected browser) or the call failed — in which case nothing changed, the profile included.
	 */
	async setAcceptDownloads(accept: boolean): Promise<boolean> {
		if (!this.#armed || this.host.cdpClient === null) return false;
		const dir = this.#downloadsDir;
		let behavior: { behavior: 'deny' | 'allow' | 'allowAndName'; downloadPath?: string; eventsEnabled: true };
		if (!accept) behavior = { behavior: 'deny', eventsEnabled: true };
		else if (this.isRemoteBrowser) behavior = { behavior: 'allow', eventsEnabled: true };
		else if (dir === null) return false;
		else {
			// A session that connected denying never created its directory (`onBrowserConnectedEvent` returns
			// before `#ensureDir` on that branch), so it is created now, before Chromium is told to write there.
			try {
				await this.#ensureDir(dir);
			} catch (error) {
				this.logger.warn('downloads directory could not be created', { error });
				return false;
			}
			behavior = { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true };
		}
		try {
			await this.cdp.send.Browser.setDownloadBehavior(behavior);
		} catch (error) {
			this.logger.warn('downloads CDP call failed', { call: 'Browser.setDownloadBehavior(runtime)', error });
			return false;
		}
		this.profile.acceptDownloads = accept;
		// The PDF sniffer is registered at connect only when downloads are accepted; turning them on later
		// must arm it too, or `autoDownloadPdfs` would silently stay off for this session. Turning them off
		// needs nothing: `#autoDownloadInPage` re-reads the profile on every call.
		if (accept) this.#registerSniffer();
		return true;
	}

	/** Resolves the bookkeeping started from CDP listeners. Tests await this instead of sleeping. */
	async whenIdle(): Promise<void> {
		for (let guard = 0; guard < 100 && this.#pending.size > 0; guard += 1) {
			await Promise.allSettled([...this.#pending]);
		}
	}

	// -- handlers ----------------------------------------------------------------------------------

	/**
	 * Arms the pipeline: resolve the downloads dir, set the download behavior, register the CDP
	 * listeners. Failures are logged and non-fatal — a session that cannot download is still a
	 * usable session.
	 */
	async onBrowserConnectedEvent(_event: BrowserConnectedEvent, context?: HandlerContext): Promise<void> {
		if (this.#armed) return;
		this.#armed = true;
		this.#downloadsDir = this.#resolveDownloadsDir();
		this.#registerCdpListeners();

		if (!this.profile.acceptDownloads) {
			await this.#safe(
				'Browser.setDownloadBehavior(deny)',
				() => this.cdpFor(context).send.Browser.setDownloadBehavior({ behavior: 'deny', eventsEnabled: true }),
			);
			return;
		}

		// A remote browser writes on its own host: handing it a path from *our* filesystem is exactly
		// the confusion §6.8 forbids, so it gets `allow` with no `downloadPath` at all.
		if (this.isRemoteBrowser) {
			await this.#safe(
				'Browser.setDownloadBehavior(remote)',
				() => this.cdpFor(context).send.Browser.setDownloadBehavior({ behavior: 'allow', eventsEnabled: true }),
			);
			return;
		}

		const dir = this.#downloadsDir;
		if (dir === null) return;
		await this.#ensureDir(dir);
		// E-33: `allowAndName` makes Chromium write `<dir>/<guid>`, so the path this watchdog records
		// is the path Chromium uses, by construction rather than by prediction.
		await this.#safe('Browser.setDownloadBehavior', () =>
			this.cdpFor(context).send.Browser.setDownloadBehavior({
				behavior: 'allowAndName',
				downloadPath: dir,
				eventsEnabled: true,
			}));
	}

	/** Drops the CDP listeners; the tracked records survive so history stays readable. */
	async onBrowserStoppedEvent(_event: BrowserStoppedEvent, _context?: HandlerContext): Promise<void> {
		this.#unregisterCdpListeners();
		this.#armed = false;
		this.#clearDeadlines();
		await this.whenIdle();
	}

	/**
	 * The PDF-viewer navigation case (ARCHITECTURE.md §6.8): Chrome *renders* a PDF instead of
	 * downloading it, so a navigation that lands on one is auto-downloaded in-page.
	 */
	async onNavigationCompleteEvent(event: NavigationCompleteEvent, context?: HandlerContext): Promise<void> {
		if (!this.#autoDownloadEnabled()) return;
		if (event.errorMessage !== null) return;
		if (!looksLikePdfUrl(event.url)) return;
		await this.#autoDownloadInPage(event.url, event.targetId, undefined, context);
	}

	/**
	 * The `BrowserStateRequestEvent` side handler (DATA-MODEL.md §5.1.1 "+ DownloadsWatchdog side
	 * handler").
	 *
	 * Lets a download that started moments ago settle so it appears in `downloadedFiles` before the
	 * agent sees the state. Returns `undefined` — DOMWatchdog owns the result — and never throws:
	 * `getBrowserStateSummary` awaits with `raiseIfAny`, so a throw here would turn every state
	 * request into a non-actionable state.
	 */
	async onBrowserStateRequestEvent(_event: BrowserStateRequestEvent, _context?: HandlerContext): Promise<void> {
		try {
			await this.#settleRecentDownloads();
		} catch (error) {
			this.logger.debug('download settle probe failed', { error });
		}
	}

	protected override beforeDetach(): void {
		this.#unregisterCdpListeners();
		this.#armed = false;
		this.#clearDeadlines();
	}

	// -- CDP wiring --------------------------------------------------------------------------------

	#registerCdpListeners(): void {
		if (this.#cdpUnsubscribes.length > 0) return;
		const client = this.host.cdpClient;
		if (client === null) return;

		this.#cdpUnsubscribes.push(
			client.on('Browser.downloadWillBegin', (params) => {
				this.#track(this.#handleWillBegin(params));
			}),
			client.on('Browser.downloadProgress', (params) => {
				this.#track(this.#handleProgress(params));
			}),
		);

		this.#registerSniffer();
	}

	/**
	 * The PDF/attachment sniffer, armed only while auto-download is on. Idempotent, and separate from the
	 * download listeners since ERRATUM(E-77): {@linkcode setAcceptDownloads} can turn downloads on after
	 * connect, and the sniffer has to follow.
	 */
	#registerSniffer(): void {
		if (this.#snifferOff !== null || !this.#autoDownloadEnabled()) return;
		const client = this.host.cdpClient;
		if (client === null) return;
		this.#snifferOff = client.on('Network.responseReceived', (params, sessionId) => {
			if (
				!shouldAutoDownload(params.response.mimeType, params.response.headers, params.response.url, params.type)
			) return;
			this.#track(this.#autoDownloadInPage(params.response.url, null, sessionId));
		});
	}

	#unregisterCdpListeners(): void {
		for (const off of this.#cdpUnsubscribes) off();
		this.#cdpUnsubscribes.length = 0;
		this.#snifferOff?.();
		this.#snifferOff = null;
	}

	// -- the download pipeline ---------------------------------------------------------------------

	/**
	 * `Browser.downloadWillBegin`.
	 *
	 * Everything up to the first `await` is synchronous on purpose: the record must be in the map
	 * before this listener yields, or a `downloadProgress` for a tiny file — which Chromium can emit
	 * immediately after — finds an unknown guid and the download is never tracked (E-33).
	 */
	async #handleWillBegin(params: { guid: string; url: string; suggestedFilename: string }): Promise<void> {
		const autoDownload = this.#autoDownloaded.has(params.url);
		const dir = this.#downloadsDir;
		if (dir === null) {
			await this.#reject(params, 'no downloads directory is configured', autoDownload);
			return;
		}
		if (!isSafeDownloadGuid(params.guid)) {
			await this.#reject(params, 'the browser announced a download id that cannot name a file', autoDownload);
			return;
		}
		const sanitized = sanitizeFilename(params.suggestedFilename);
		if (sanitized === null) {
			await this.#reject(params, 'the suggested filename could not be sanitized safely', autoDownload);
			return;
		}
		if (this.#downloads.size >= this.#limits.maxTracked) {
			await this.#reject(params, `the session already tracks ${this.#limits.maxTracked} downloads`, autoDownload);
			return;
		}

		// Display-name disambiguation is against the *ledger*, not the directory: the disk name is the
		// guid, so two downloads called `report.txt` cannot collide on disk and the ` (1)` exists only
		// so a listing tells them apart.
		const taken = new Set([...this.#downloads.values()].map((record) => record.fileName));
		const fileName = uniqueFilename(sanitized, (candidate) => taken.has(candidate)) ?? sanitized;
		// Remote: a synthesized path for reporting, never written (§6.8). Local: the guid path Chromium
		// writes under `allowAndName`.
		const path = this.isRemoteBrowser ? join(dir, fileName) : join(dir, params.guid);

		const record: DownloadRecord = {
			guid: params.guid,
			url: params.url,
			suggestedFilename: params.suggestedFilename,
			fileName,
			path,
			fileSize: 0,
			receivedBytes: 0,
			totalBytes: 0,
			fileType: fileTypeOf(fileName),
			mimeType: null,
			autoDownload,
			state: 'inProgress',
			startedAt: this.#now(),
			completedAt: null,
			error: null,
		};
		this.#downloads.set(params.guid, record);
		this.#armDeadline(params.guid);
		this.#emitToListeners('started', record);

		await this.bus.dispatch(
			new DownloadStartedEvent({
				guid: params.guid,
				url: params.url,
				suggestedFilename: params.suggestedFilename,
				autoDownload,
			}),
		);
	}

	async #handleProgress(
		params: { guid: string; receivedBytes: number; totalBytes: number; state: DownloadState },
	): Promise<void> {
		const known = this.#downloads.get(params.guid);
		if (known === undefined) {
			// A download Chrome never announced through `downloadWillBegin`: re-broadcast the progress so
			// the agent still sees it, but there is no vetted path to report a file at.
			await this.bus.dispatch(new DownloadProgressEvent({ ...params }));
			return;
		}
		// Terminal already — cancelled by a limit, or refused at start. Chromium's own `canceled`
		// echo must not resurrect it, and a stray `completed` must not publish a file we removed.
		if (known.completedAt !== null) {
			if (params.state !== 'inProgress' && !this.isRemoteBrowser) await this.#removePartials(known.path);
			return;
		}

		const progressed: DownloadRecord = {
			...known,
			receivedBytes: params.receivedBytes,
			totalBytes: params.totalBytes,
			state: params.state,
		};

		if (!this.isRemoteBrowser) {
			const breach = this.#limitBreach(progressed);
			if (breach !== null) {
				await this.#abort(progressed, breach);
				return;
			}
		}

		this.#downloads.set(params.guid, progressed);
		this.#emitToListeners('progress', progressed);
		await this.bus.dispatch(new DownloadProgressEvent({ ...params }));

		if (params.state === 'inProgress') return;
		this.#disarmDeadline(params.guid);
		if (params.state === 'canceled') {
			const canceled: DownloadRecord = { ...progressed, completedAt: this.#now(), error: 'the download was canceled' };
			this.#downloads.set(params.guid, canceled);
			if (!this.isRemoteBrowser) await this.#removePartials(canceled.path);
			this.#emitToListeners('canceled', canceled);
			return;
		}
		await this.#complete(progressed);
	}

	/**
	 * Finishes a download: containment check, regular-file check, size probe, `FileDownloadedEvent`.
	 *
	 * The containment check exists even though `<dir>/<guid>` cannot leave `dir` by construction,
	 * because between `downloadWillBegin` and here the *browser* wrote the file — and a symlink
	 * planted at the destination is exactly the case `Deno.realPath` exists to catch
	 * (SECURITY-AUTH.md §8.3). A zero-byte regular file is a valid download; a missing file, a
	 * directory or a device is not.
	 */
	async #complete(record: DownloadRecord): Promise<void> {
		const dir = this.#downloadsDir;
		let path = record.path;
		let fileSize = 0;
		let error: string | null = null;

		if (this.isRemoteBrowser) {
			// §6.8: the path is synthesized and the size is 0. No stat, no realpath, no local write.
			this.logger.debug('remote download: path synthesized, local filesystem untouched', {
				fileName: record.fileName,
			});
		} else if (dir === null) {
			error = 'no downloads directory is configured';
		} else {
			const realDir = await this.#realPath(dir) ?? dir;
			const realFile = await this.#realPath(record.path);
			if (realFile === null) {
				error = `the browser reported ${record.fileName} as complete but no file exists at the vetted path`;
			} else if (!isContainedIn(realDir, realFile)) {
				error = `${record.fileName} resolved outside the downloads directory and was refused`;
			} else {
				const stat = await this.#statFile(realFile);
				if (stat === null) {
					error = `the browser reported ${record.fileName} as complete but no file exists at the vetted path`;
				} else if (!stat.isFile) {
					error = `${record.fileName} is not a regular file and was refused`;
				} else {
					path = realFile;
					fileSize = stat.size;
				}
			}
		}

		const completed: DownloadRecord = {
			...record,
			path,
			fileSize,
			state: 'completed',
			completedAt: this.#now(),
			error,
		};
		this.#downloads.set(record.guid, completed);

		if (error !== null) {
			this.#emitToListeners('failed', completed);
			await this.bus.dispatch(
				new BrowserErrorEvent({
					errorType: 'DownloadContainmentFailed',
					message: error,
					details: { guid: record.guid, fileName: record.fileName, url: record.url },
				}),
			);
			return;
		}

		this.#completed.push(path);
		this.#emitToListeners('completed', completed);
		await this.bus.dispatch(
			new FileDownloadedEvent({
				guid: completed.guid,
				url: completed.url,
				path: completed.path,
				fileName: completed.fileName,
				fileSize: completed.fileSize,
				fileType: completed.fileType,
				mimeType: completed.mimeType,
				fromCache: false,
				autoDownload: completed.autoDownload,
			}),
		);
	}

	/**
	 * Refuses a download at `downloadWillBegin`. The record is installed synchronously so a progress
	 * event for the same guid is ignored; the browser is then told to stop.
	 */
	async #reject(
		params: { guid: string; url: string; suggestedFilename: string },
		reason: string,
		autoDownload: boolean,
	): Promise<void> {
		const rejected: DownloadRecord = {
			guid: params.guid,
			url: params.url,
			suggestedFilename: params.suggestedFilename,
			fileName: '',
			path: '',
			fileSize: 0,
			receivedBytes: 0,
			totalBytes: 0,
			fileType: null,
			mimeType: null,
			autoDownload,
			state: 'canceled',
			startedAt: this.#now(),
			completedAt: this.#now(),
			error: reason,
		};
		this.#downloads.set(params.guid, rejected);
		this.#emitToListeners('failed', rejected);
		await this.#cancelViaCdp(params.guid);
		// Chromium may already have started writing `<dir>/<guid>` under `allowAndName`.
		if (!this.isRemoteBrowser && this.#downloadsDir !== null && isSafeDownloadGuid(params.guid)) {
			await this.#removePartials(join(this.#downloadsDir, params.guid));
		}
		await this.bus.dispatch(
			new BrowserErrorEvent({
				errorType: 'DownloadRejected',
				message: `refused to download ${params.suggestedFilename}: ${reason}`,
				details: { guid: params.guid, url: params.url, suggestedFilename: params.suggestedFilename },
			}),
		);
	}

	/** Cancels an in-flight download, removes its partial, and records why. */
	async #abort(record: DownloadRecord, reason: string): Promise<void> {
		this.#disarmDeadline(record.guid);
		const aborted: DownloadRecord = {
			...record,
			state: 'canceled',
			completedAt: this.#now(),
			error: reason,
		};
		this.#downloads.set(record.guid, aborted);
		this.#emitToListeners('failed', aborted);
		await this.#cancelViaCdp(record.guid);
		if (!this.isRemoteBrowser) await this.#removePartials(record.path);
		await this.bus.dispatch(
			new BrowserErrorEvent({
				errorType: 'DownloadCanceled',
				message: `canceled download ${record.fileName}: ${reason}`,
				details: { guid: record.guid, fileName: record.fileName, url: record.url },
			}),
		);
	}

	/** The limit a progress snapshot breaks, or `null`. Progress-based, so it can overshoot slightly. */
	#limitBreach(record: DownloadRecord): string | null {
		const { maxFileBytes, maxSessionBytes, transferDeadlineMs } = this.#limits;
		const claimed = Math.max(record.receivedBytes, record.totalBytes);
		if (claimed > maxFileBytes) {
			return `the download exceeds the per-file limit of ${maxFileBytes} bytes`;
		}
		let session = claimed;
		for (const other of this.#downloads.values()) {
			if (other.guid === record.guid || other.error !== null) continue;
			session += other.state === 'completed' ? other.fileSize : other.receivedBytes;
		}
		if (session > maxSessionBytes) {
			return `the session's downloads exceed the per-session limit of ${maxSessionBytes} bytes`;
		}
		if (this.#now() - record.startedAt > transferDeadlineMs) {
			return `the transfer exceeded the ${transferDeadlineMs} ms deadline`;
		}
		return null;
	}

	#armDeadline(guid: string): void {
		if (this.isRemoteBrowser) return;
		const timer = setTimeout(() => {
			this.#deadlines.delete(guid);
			const record = this.#downloads.get(guid);
			if (record === undefined || record.completedAt !== null) return;
			this.#track(this.#abort(record, `the transfer exceeded the ${this.#limits.transferDeadlineMs} ms deadline`));
		}, this.#limits.transferDeadlineMs);
		// A hung transfer must not pin the process, only the download.
		Deno.unrefTimer(timer);
		this.#deadlines.set(guid, timer);
	}

	#disarmDeadline(guid: string): void {
		const timer = this.#deadlines.get(guid);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#deadlines.delete(guid);
	}

	#clearDeadlines(): void {
		for (const timer of this.#deadlines.values()) clearTimeout(timer);
		this.#deadlines.clear();
	}

	async #cancelViaCdp(guid: string): Promise<void> {
		await this.#safe('Browser.cancelDownload', () => this.cdp.send.Browser.cancelDownload({ guid }));
	}

	// -- auto-download (ARCHITECTURE.md §6.8) ------------------------------------------------------

	#autoDownloadEnabled(): boolean {
		return this.profile.acceptDownloads && this.profile.autoDownloadPdfs;
	}

	/**
	 * Turns a rendered resource into a download by clicking a synthetic `<a download>` in the page.
	 *
	 * `Page.navigate` would just render the PDF again; the anchor is what makes Chrome route the
	 * resource through the download pipeline, which is what `downloadWillBegin` observes. The URL is
	 * passed as a `Runtime.evaluate` *argument-free* expression with a JSON-encoded literal, so a URL
	 * containing quotes cannot break out of the expression.
	 */
	async #autoDownloadInPage(
		url: string,
		targetId: TargetId | null,
		sessionId?: SessionId,
		context?: HandlerContext,
	): Promise<void> {
		if (!this.#autoDownloadEnabled()) return;
		if (this.#autoDownloaded.has(url)) return;
		this.#autoDownloaded.add(url);
		try {
			const resolved = sessionId ?? (await this.sessions.getOrCreateCdpSession(targetId, false)).sessionId;
			await this.cdpFor(context).send.Runtime.evaluate({
				expression: autoDownloadExpression(url),
				awaitPromise: false,
				returnByValue: true,
			}, resolved);
			this.logger.debug('auto-download triggered in page', { url });
		} catch (error) {
			this.#autoDownloaded.delete(url);
			this.logger.debug('auto-download could not be triggered', { url, error });
		}
	}

	// -- helpers -----------------------------------------------------------------------------------

	/** Waits out the settle grace for downloads that started but have not finished. */
	async #settleRecentDownloads(): Promise<void> {
		await this.whenIdle();
		const unsettled = [...this.#downloads.values()].filter((record) => record.state === 'inProgress');
		if (unsettled.length === 0) return;
		const deadline = this.#now() + DOWNLOAD_SETTLE_GRACE_MS;
		while (this.#now() < deadline) {
			await this.whenIdle();
			if (![...this.#downloads.values()].some((record) => record.state === 'inProgress')) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}
	}

	#emitToListeners(phase: DownloadPhase, download: DownloadRecord): void {
		if (this.#listeners.size === 0) return;
		const signal: DownloadSignal = { phase, download };
		for (const listener of [...this.#listeners]) {
			try {
				listener(signal);
			} catch (error) {
				// A listener on the transport read path must never take the read loop down with it.
				this.logger.warn('a download listener threw', { phase, error });
			}
		}
	}

	#resolveDownloadsDir(): string | null {
		const configured = this.#options.downloadsDir ?? this.profile.downloadsPath;
		return configured === null || configured === '' ? null : configured;
	}

	#track(promise: Promise<unknown>): void {
		this.#pending.add(promise);
		promise
			.then(() => {}, (error: unknown) => this.logger.warn('downloads bookkeeping failed', { error }))
			.finally(() => this.#pending.delete(promise));
	}

	async #safe(label: string, run: () => Promise<unknown>): Promise<void> {
		try {
			await run();
		} catch (error) {
			this.logger.warn('downloads CDP call failed', { call: label, error });
		}
	}

	// -- filesystem seams (never reached on the remote-browser path) -------------------------------

	async #ensureDir(path: string): Promise<void> {
		const ensure = this.#options.ensureDir;
		if (ensure !== undefined) {
			await ensure(path);
			return;
		}
		try {
			await Deno.mkdir(path, { recursive: true });
		} catch (error) {
			if (error instanceof Deno.errors.AlreadyExists) return;
			this.logger.warn('downloads directory could not be created', { path, error });
		}
	}

	async #statFile(path: string): Promise<DownloadFileStat | null> {
		const probe = this.#options.statFile;
		if (probe !== undefined) return await probe(path);
		try {
			const info = await Deno.stat(path);
			return { size: info.size, isFile: info.isFile };
		} catch {
			return null;
		}
	}

	async #realPath(path: string): Promise<string | null> {
		const probe = this.#options.realPath;
		if (probe !== undefined) return await probe(path);
		try {
			return await Deno.realPath(path);
		} catch {
			return null;
		}
	}

	/**
	 * Removes a cancelled download's partial: the guid file and Chromium's `.crdownload` sibling.
	 * Only paths inside the downloads directory are ever removed; a missing file is not an error.
	 */
	async #removePartials(path: string): Promise<void> {
		const dir = this.#downloadsDir;
		if (dir === null || path === '' || !isContainedIn(dir, path)) return;
		for (const candidate of [path, `${path}.crdownload`]) {
			try {
				await this.#removeFile(candidate);
			} catch (error) {
				this.logger.debug('partial download could not be removed', { path: candidate, error });
			}
		}
	}

	/**
	 * ERRATUM(E-54). **A cancelled download's partial could survive its own cleanup on Windows.**
	 *
	 * `#abort` cancels through CDP and then removes the partial, but the cancellation is asynchronous
	 * inside Chromium: for a moment after `Browser.cancelDownload` returns, the browser process still
	 * holds the `.crdownload` handle. On a POSIX host that is harmless — the unlink succeeds and the
	 * file goes when the last handle closes — but on Windows `Deno.remove` fails with
	 * `PermissionDenied`, which this method rethrew, `#removePartials` logged at debug, and nothing
	 * retried. The partial then sat in the session's download directory until the session was reaped,
	 * against E-33's stated contract that a cancelled transfer leaves nothing behind.
	 *
	 * Found on the browser tier by `tests/e2e/files_e2e_test.ts` ("an export over the per-file limit is
	 * cancelled in the browser, leaving nothing behind"), which failed twice and then passed — the
	 * signature of a race rather than of a leak, and the reason a bounded retry is the fix rather than
	 * a longer single wait.
	 *
	 * Bounded on purpose: {@linkcode PARTIAL_REMOVE_ATTEMPTS} attempts spaced
	 * {@linkcode PARTIAL_REMOVE_RETRY_MS} apart, after which the failure is reported to the caller
	 * exactly as before. A cleanup that retried indefinitely would turn a leaked file into a stuck
	 * cancellation, which is worse. The retry applies only to the real `Deno.remove` path: an injected
	 * `removeFile` keeps its exact previous semantics, so a test that supplies a failing remover still
	 * observes one call.
	 */
	async #removeFile(path: string): Promise<void> {
		const remove = this.#options.removeFile;
		if (remove !== undefined) {
			await remove(path);
			return;
		}
		await removeWithRetry((target) => Deno.remove(target), path);
	}
}

// ---------------------------------------------------------------------------
// module helpers (pure — unit-testable without a browser)
// ---------------------------------------------------------------------------

/** Lower-case extension without the dot, or `null`. */
export function fileTypeOf(fileName: string): string | null {
	const extension = extname(fileName).replace(/^\./, '').toLowerCase();
	return extension === '' ? null : extension;
}

/**
 * The PDF URL heuristic shared by the navigation and sniffer paths.
 *
 * Path-based only: a query string is not evidence, and Chrome's own PDF viewer keeps the `.pdf`
 * path when it renders one.
 */
export function looksLikePdfUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
		return parsed.pathname.toLowerCase().endsWith('.pdf');
	} catch {
		return false;
	}
}

/**
 * `true` when a response should be downloaded **by this watchdog** rather than rendered.
 *
 * Two independent signals: a `Content-Disposition: attachment` header (the server said so), or a
 * download-ish MIME type on a URL that is not already being handled. Header names are matched
 * case-insensitively — CDP passes them through exactly as the server wrote them.
 *
 * ERRATUM(E-33). An attachment that arrived as a **navigation** (`resourceType: 'Document'`) is
 * already Chromium's download: the browser never renders it, it routes it straight to the download
 * pipeline and announces it through `downloadWillBegin`. Re-triggering it in page produced a second
 * download of the same URL for every clicked attachment — measured as five records for three clicks,
 * three of them pointing at files that did not exist. The sniffer therefore leaves Document
 * attachments to Chromium and keeps its job for the cases the browser does *not* download on its own:
 * an inline PDF the viewer would render, and attachments a page fetched for itself.
 */
export function shouldAutoDownload(
	mimeType: string,
	headers: Record<string, string>,
	url: string,
	resourceType?: string,
): boolean {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== 'content-disposition') continue;
		if (value.toLowerCase().includes('attachment')) return resourceType !== 'Document';
	}
	const mime = mimeType.toLowerCase();
	if (AUTO_DOWNLOAD_MIME_TYPES.includes(mime)) return true;
	if (mime === AMBIGUOUS_DOWNLOAD_MIME_TYPE) return looksLikeFileUrl(url);
	return false;
}

function looksLikeFileUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const name = basename(parsed.pathname);
		return name !== '' && name.includes('.');
	} catch {
		return false;
	}
}

/**
 * The in-page auto-download expression.
 *
 * `JSON.stringify` is the injection guard: the URL only ever appears as a JSON string literal, so
 * quotes, backslashes and newlines in an attacker-chosen URL cannot escape into code.
 */
export function autoDownloadExpression(url: string): string {
	return `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(url)}; ` +
		`a.download = ''; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); return true; })()`;
}

/**
 * ERRATUM(E-54). Removes a file, retrying a bounded number of times when the host refuses.
 *
 * Exported as a function rather than left inside the watchdog because the watchdog's own filesystem
 * seam is injected by every unit test — an injected remover keeps its exact previous semantics, so
 * the retry would otherwise be reachable only from a real Windows race. Here it can be driven
 * directly with a remover that fails a stated number of times.
 *
 * A missing file is success, not an error: the point is that nothing is left behind, and something
 * else having removed it first satisfies that. Anything else is retried, and the last failure is
 * rethrown so a caller that cannot proceed still learns why.
 */
export async function removeWithRetry(
	remove: (path: string) => Promise<void>,
	path: string,
	attempts = PARTIAL_REMOVE_ATTEMPTS,
	retryMs = PARTIAL_REMOVE_RETRY_MS,
): Promise<void> {
	for (let attempt = 1;; attempt++) {
		try {
			await remove(path);
			return;
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return;
			if (attempt >= attempts) throw error;
			await new Promise((resolve) => setTimeout(resolve, retryMs));
		}
	}
}
