/**
 * @module
 * The click ↔ downloads seam, from the **consumer** side: how a click tells "this navigated" from
 * "this started a download".
 *
 * Contract owners: SPECS/ARCHITECTURE.md §6.8 ("… and offers a synchronous direct-callback channel
 * that DefaultActionWatchdog uses for click-triggered download detection") and §6.10 ("Wraps clicks
 * in download detection (0.5 s start grace, 30 s completion wait)"), restated in the §8 fine-grained
 * cap row.
 *
 * ## Why the channel is synchronous, and why it is not the bus
 *
 * `Browser.downloadWillBegin` arrives on the CDP socket while the click is still in flight. Routed
 * through the event bus, the watching click would see it only after the dispatch queue drains, and
 * the 0.5 s grace does not survive that. DownloadsWatchdog therefore invokes its listeners **from
 * inside its CDP handler, before it awaits anything**; `DownloadStartedEvent` and friends
 * (DATA-MODEL.md §5.1.6) still go out on the bus for everyone else.
 *
 * ## Why this file declares the interface instead of importing DownloadsWatchdog's
 *
 * {@linkcode ClickDownloadSource} is the *narrow structural slice* of §6.8's watchdog that the click
 * path uses: one method, one promise. Declaring it here keeps the action watchdog compilable and
 * testable independently of the downloads watchdog's full surface, and keeps the dependency pointing
 * one way. `DownloadsWatchdog` satisfies it structurally with no `implements` clause and no import —
 * `default_action_test.ts` asserts exactly that, so the two files cannot drift apart silently.
 */

/**
 * The slice of DownloadsWatchdog's `DownloadRecord` a click reports.
 *
 * Wider records satisfy it: the fields are read-only, so §6.8's full record is assignable.
 */
export interface ClickDownloadRecord {
	readonly guid: string;
	readonly url: string;
	/** Exactly as Chrome suggested it — attacker-influenced, never used as a path. */
	readonly suggestedFilename: string;
	/** The sanitized, disambiguated basename actually used (SECURITY-AUTH.md §8.3). */
	readonly fileName: string;
	/** Absolute path; synthesized and never written for a remote browser (§6.8). */
	readonly path: string;
	readonly fileSize: number;
	readonly state: string;
	readonly error: string | null;
}

/** One armed, click-scoped watch. Always disposed, including on the happy path. */
export interface ClickDownloadWatch {
	/**
	 * The download this click caused, or `null` when nothing started inside the start grace.
	 *
	 * A download that starts but does not finish inside the completion timeout resolves with its last
	 * known record rather than rejecting: "the click started a 400 MB download" is information the
	 * agent needs before the bytes land.
	 */
	readonly result: Promise<ClickDownloadRecord | null>;
	dispose(): void;
}

/** What the click path needs from §6.8's watchdog, and nothing more. */
export interface ClickDownloadSource {
	armDownloadWatch(
		options?: { readonly startGraceMs?: number; readonly completionTimeoutMs?: number },
	): ClickDownloadWatch;
}

// ---------------------------------------------------------------------------
// timings (ARCHITECTURE.md §6.10, §8 — load-bearing, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/**
 * How long after a click a download may still be attributed to it (ARCHITECTURE.md §6.10, §8).
 *
 * Restated here rather than imported from `downloads.ts` because it is §6.10's number as much as
 * §6.8's, and a click must arm its own watch with a value it owns. `default_action_test.ts` asserts
 * the two definitions are equal, which is the drift alarm.
 */
export const DOWNLOAD_START_GRACE_MS = 500;

/** How long a started download is waited on before the click reports it unfinished (§6.10, §8). */
export const DOWNLOAD_COMPLETION_TIMEOUT_MS = 30_000;

/**
 * Arms a watch, runs `click`, and reports what the click produced.
 *
 * The watch is armed **before** `click` runs — a download that begins during the dispatch must not be
 * missed — and disposed in a `finally`, so a click that throws still releases the listener.
 */
export async function withDownloadDetection<T>(
	source: ClickDownloadSource | null,
	options: { readonly graceMs?: number; readonly completionMs?: number },
	click: () => Promise<T>,
): Promise<{ value: T; download: ClickDownloadRecord | null }> {
	if (source === null) return { value: await click(), download: null };

	const watch = source.armDownloadWatch({
		startGraceMs: options.graceMs ?? DOWNLOAD_START_GRACE_MS,
		completionTimeoutMs: options.completionMs ?? DOWNLOAD_COMPLETION_TIMEOUT_MS,
	});
	try {
		const value = await click();
		const download = await watch.result;
		return { value, download };
	} finally {
		watch.dispose();
	}
}
