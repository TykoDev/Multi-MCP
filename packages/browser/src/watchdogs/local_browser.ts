/**
 * @module
 * `LocalBrowserWatchdog` — owner of the browser subprocess.
 *
 * Handles `BrowserLaunchEvent`: composes launch args from the profile, asserts `--user-data-dir` is
 * set, resolves the executable, spawns via `@tykotech/cdp`'s `launchBrowser`, polls `/json/version`
 * (100 ms cadence, 30 s cap) and returns `BrowserLaunchResult{cdpUrl}`. Retries up to 3× on a
 * profile-lock failure, each retry on a fresh temp profile dir. Handles `BrowserKillEvent` and
 * enqueues a kill on `BrowserStopEvent` for local browsers.
 *
 * Division of labour, so nothing is implemented twice:
 * - `src/browser/profile.ts` decides *which* args exist and which directories they point at.
 * - `@tykotech/cdp`'s `launchBrowser` owns the spawn, the free debug port, executable discovery, the
 *   `/json/version` poll, and the profile-lock retry ladder.
 * - This watchdog owns the *policy*: when to launch, where the temp profile lives, and how the
 *   browser dies.
 *
 * ## Windows process-tree teardown
 *
 * Deno maps **both** `SIGTERM` and `SIGKILL` to `TerminateProcess` on Windows. The
 * SIGTERM → 5 s → SIGKILL grace is therefore a no-op there, and `TerminateProcess` reaps only the
 * process it names — Chrome's renderer/GPU/utility children survive as orphans. So graceful shutdown
 * goes through CDP `Browser.close()` first, which makes Chrome tear down its **own** process tree,
 * and the process kill is the fallback for a browser that is already unreachable. What remains
 * genuinely unenforceable from Deno: if `Browser.close()` cannot be delivered (socket already dead,
 * hung renderer), the child processes are not reaped by us on Windows — no job-object API is exposed.
 * Temp profiles therefore keep the `bua-tmp-*` prefix, so a leftover is recognisable and can be swept by prefix,
 * which is the cleanup path for that case.
 *
 * **Under a deployment allowlist the profile launches with preloading off.** A speculation-rules `prefetch` — and the
 * prefetch Chrome runs ahead of a cross-site `prerender` — is sent by the browser's prefetch service, outside every
 * `Fetch` interception point, so the document veto (E0) cannot refuse it, and the navigation it then serves sends no
 * request at all: an off-list document would commit with nothing paused and nothing recorded. Measured on Chrome 154
 * with throwaway profiles: no `--disable-features` / `--disable-blink-features` switch (`Prerender2`,
 * `NoStatePrefetch`, `SpeculationRulesPrefetchFuture`, blink `SpeculationRules`) stops it, and the user preference
 * `net.network_prediction_options = 2` ("preload pages: never") does — neither the prefetch nor the prerender is sent.
 * So before the spawn, with a non-empty `allowedDomains`, that one key is merged into the profile's `Preferences`
 * file (created when absent; an existing file is rewritten through a temp file and a rename, every other key kept).
 * Without an allowlist nothing is written. A file that does not parse as a JSON object is left untouched (a warning,
 * no clobber): the main-frame commit check in `SessionManager` remains behind it, as it does for an attached browser
 * this watchdog does not launch and for a profile-lock retry, which `launchBrowser` runs on a fresh temp directory
 * this hook never sees.
 *
 * With `requestScope: 'all'` the same write also sets {@linkcode WEBRTC_UDP_OFF_PREFERENCE}, so WebRTC sends no UDP
 * at all: ICE traffic never reaches `Fetch`, so the request filter alone cannot keep it on the allowlist. The lockdown
 * script `SessionManager` registers and the host's resolver layer stand beside it (`webrtc_lockdown.ts`). A
 * profile-lock retry's fresh directory misses this preference too; those two layers do not.
 */

import type { HandlerContext } from '@tykotech/bus';
import { join } from '@std/path';
import type { BrowserLaunchResult } from '../types.ts';
import { BrowserKillEvent, BrowserLaunchEvent, BrowserStopEvent } from '../events.ts';
import { BrowserError } from '../errors.ts';
import { withTimeout } from '../browser/reconnect.ts';
import {
	assertUserDataDirPresent,
	type BrowserLaunchPlan,
	currentTargetOs,
	resolveBrowserProfile,
	type TargetOs,
	toLaunchPlan,
} from '../browser/profile.ts';
import { launchBrowser, type LaunchedBrowser, type LaunchOptions } from '@tykotech/cdp';
import { type HandlerBudget, handlerBudget } from './handler_budget.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants (load-bearing timing budgets)
// ---------------------------------------------------------------------------

/** `/json/version` readiness cadence. */
export const JSON_VERSION_POLL_INTERVAL_MS = 100;

/** Hard cap on the `/json/version` readiness wait. */
export const JSON_VERSION_TIMEOUT_MS = 30_000;

/** Attempts including the first; each retry gets a fresh temp profile dir. */
export const PROFILE_LOCK_MAX_ATTEMPTS = 3;

/**
 * The Chrome preference a deployment allowlist sets before launch — `net.network_prediction_options`,
 * where `2` is "never preload" (Chrome's `NETWORK_PREDICTION_NEVER`). It is what turns speculation-rules prefetch and
 * prerender off on Chrome 154; see the module note.
 */
export const PRELOADING_OFF_PREFERENCE = { section: 'net', key: 'network_prediction_options', value: 2 } as const;

/**
 * The Chrome preference `requestScope: 'all'` (over an allowlist) adds
 * before launch — `webrtc.ip_handling_policy = disable_non_proxied_udp`, which turns off every WebRTC UDP socket (host
 * candidates, STUN, TURN over UDP) unless a proxy carries UDP, which none does. Measured on Chromium 158: no UDP
 * packet and no host candidate under it, where a page without it sent STUN to an off-list IP literal. It is a profile
 * preference, not a switch, because `--force-webrtc-ip-handling-policy` measured inert on the branded build. What it
 * leaves — WebRTC over TCP — goes through the resolver layer; see `webrtc_lockdown.ts`.
 */
export const WEBRTC_UDP_OFF_PREFERENCE = {
	section: 'webrtc',
	key: 'ip_handling_policy',
	value: 'disable_non_proxied_udp',
} as const;

/** One profile preference this watchdog merges before a launch: `<section>.<key> = value`. */
export interface ContainmentPreference {
	readonly section: string;
	readonly key: string;
	readonly value: string | number;
}

/** The profile file the preference lives in, inside `<userDataDir>/<profileDirectory>/`. */
export const PREFERENCES_FILENAME = 'Preferences';

/** SIGTERM grace before SIGKILL. See the module note about Windows. */
export const GRACEFUL_KILL_MS = 5_000;

/** How long the CDP `Browser.close()` path waits before falling back to the process kill. */
export const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Temp profile prefix. `@tykotech/cdp` uses the same literal but does not export it (its `mod.ts` is the
 * only sanctioned import surface), and leftovers are swept by this exact prefix,
 * so the two copies are pinned equal by `local_browser_test.ts`.
 */
export const TEMP_PROFILE_PREFIX = 'bua-tmp-';

/** Environment keys the display heuristic reads (`profile.ts` `hasDisplay`). */
const DISPLAY_ENV_KEYS: readonly string[] = ['DISPLAY', 'WAYLAND_DISPLAY'];

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/**
 * Injection seams. Every default is the real implementation; they exist because the tier-1 test
 * matrix grants neither `--allow-run` nor a writable temp root,
 * so arg composition and the kill ladder are exercised without
 * a browser while `tests/integration/session_lifecycle_test.ts` covers the real spawn.
 */
export interface LocalBrowserWatchdogOptions {
	readonly launch?: ((options: LaunchOptions) => Promise<LaunchedBrowser>) | undefined;
	readonly makeTempProfileDir?: (() => Promise<string>) | undefined;
	readonly ensureDir?: ((path: string) => Promise<void>) | undefined;
	/**
	 * Removes one owned profile directory. `expired()` is the kill budget: an implementation MUST
	 * consult it between operations and stop when it returns `true`. A seam that
	 * ignores it still type-checks — a one-argument function is assignable here — which is exactly the
	 * shape a test recorder wants.
	 */
	readonly removeDir?: ((path: string, expired: () => boolean) => Promise<void>) | undefined;
	/** Overrides the running platform for arg composition; defaults to `Deno.build.os`. */
	readonly os?: TargetOs | undefined;
	/** Environment slice for display detection; defaults to a permission-tolerant read. */
	readonly env?: Readonly<Record<string, string | undefined>> | undefined;
	/** Parent directory for auto-created temp profiles. */
	readonly tempProfileRoot?: string | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class LocalBrowserWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [BrowserLaunchEvent, BrowserKillEvent, BrowserStopEvent];
	static override readonly EMITS = [BrowserKillEvent];

	readonly #options: LocalBrowserWatchdogOptions;
	readonly #ownedProfileDirs: string[] = [];
	#launched: LaunchedBrowser | null = null;
	#launchPlan: BrowserLaunchPlan | null = null;
	/**
	 * The spawn between "started" and "landed". See
	 * {@linkcode LocalBrowserWatchdog.onBrowserLaunchEvent}: without this, that window is a hole in the
	 * only record this process keeps of the subprocess.
	 */
	#launching: Promise<LaunchedBrowser> | null = null;
	/** Bumped by every launch *and* every kill, so a launch can tell whether a kill overtook it. */
	#launchGeneration = 0;

	constructor(host: WatchdogHost, options: LocalBrowserWatchdogOptions = {}) {
		super(host);
		this.#options = options;
	}

	/** The running browser, or `null` before launch and after kill. */
	get launched(): LaunchedBrowser | null {
		return this.#launched;
	}

	/** The plan the last launch was composed from — the audit surface for arg composition. */
	get launchPlan(): BrowserLaunchPlan | null {
		return this.#launchPlan;
	}

	/** `true` while a spawn is in flight — i.e. there is a browser this watchdog owns but cannot name. */
	get launching(): boolean {
		return this.#launching !== null;
	}

	// -- handlers ----------------------------------------------------------------------------------

	/**
	 * Spawns the browser and returns its CDP URL. Idempotent: a second launch on a live browser —
	 * or on one whose spawn is still in flight — returns the same URL rather than starting a second
	 * Chrome against the same profile.
	 * ## The window between "Chrome has been forked" and "we have a handle on it"
	 *
	 * `LaunchedBrowser` does not exist until the spawn resolves, so `#launched` can only be assigned
	 * *after* the spawn await. On its own that leaves a window in which the watchdog's own record says
	 * there is no browser: a `BrowserStopEvent` arriving then would read `#launched === null`, return
	 * without dispatching a kill, and leave a Chrome running with nothing in-process aware of it
	 * (the `bua-tmp-*` profile directory can be swept by prefix afterwards, but that cannot
	 * recover the process).
	 *
	 * Making the stop await the spawn would trade an orphan for a hang: the spawn is bounded by
	 * 3 × {@linkcode JSON_VERSION_TIMEOUT_MS} = 90 s, twice `BrowserStopEvent`'s 45 s budget, so the
	 * stop would become a straggler. Instead the pending spawn is tracked and reaps itself:
	 * `#launching` makes the in-flight spawn visible to the stop handler, and `#launchGeneration` lets
	 * this handler discover, when its spawn finally lands, that a kill overtook it — in which case
	 * **it** closes the browser it just created, because by then it is the only code holding the
	 * handle.
	 *
	 * That last step deliberately runs work after the dispatch may have been abandoned. It is the same
	 * asymmetry the kill handler makes: `launched.close()` is bounded by construction (it ends in
	 * SIGKILL), and an orphaned Chrome is a strictly worse outcome than one escaped bounded operation.
	 */
	async onBrowserLaunchEvent(_event: BrowserLaunchEvent, _context?: HandlerContext): Promise<BrowserLaunchResult> {
		const running = this.#launched;
		if (running !== null) return { cdpUrl: running.cdpUrl };
		// A concurrent launch joins the spawn already in flight. Without this, the second dispatch would
		// also read `#launched === null` and fork a *second* Chrome against the same profile.
		const inFlight = this.#launching;
		if (inFlight !== null) return { cdpUrl: (await inFlight).cdpUrl };

		const profile = this.profile;
		const tempProfileDir = profile.userDataDir === null ? await this.#makeTempProfileDir() : null;
		if (tempProfileDir !== null) this.#ownedProfileDirs.push(tempProfileDir);

		const resolved = resolveBrowserProfile(profile, {
			os: this.#options.os ?? currentTargetOs(),
			env: this.#options.env ?? _readDisplayEnv(),
			tempProfileDir,
			onWarn: (message) => this.logger.warn('browser profile resolution', { message }),
		});

		// The `--user-data-dir` invariant. `resolveBrowserProfile` also asserts it; the
		// second check is deliberate, because "never launch against the user's real Chrome profile" is
		// the one launch invariant whose violation is silent and destructive.
		assertUserDataDirPresent(resolved.args);
		await this.#ensureDir(resolved.downloadsPath);
		// An allowlist launches with preloading off — the one control that stops speculation-rules
		// prefetch/prerender before a request leaves (module note). Never throws: the commit check stands behind it.
		const allowed = profile.allowedDomains;
		if (allowed !== null && allowed !== undefined && allowed.length > 0) {
			// `all` also turns WebRTC's UDP off, in the same one write. Like the
			// session manager's scope, it is inert without an allowlist.
			const preferences: ContainmentPreference[] = profile.requestScope === 'all'
				? [PRELOADING_OFF_PREFERENCE, WEBRTC_UDP_OFF_PREFERENCE]
				: [PRELOADING_OFF_PREFERENCE];
			await this.#writeContainmentPreferences(join(resolved.userDataDir, resolved.profileDirectory), preferences);
		}

		const plan = toLaunchPlan(profile, resolved);
		this.#launchPlan = plan;

		const launchOptions: LaunchOptions = {
			userDataDir: plan.userDataDir,
			executablePath: plan.executablePath,
			channel: plan.channel,
			headless: plan.headless,
			args: plan.args,
			env: plan.env,
			ignoreDefaultArgs: plan.ignoreDefaultArgs,
			readinessPollIntervalMs: JSON_VERSION_POLL_INTERVAL_MS,
			readinessTimeoutMs: JSON_VERSION_TIMEOUT_MS,
			maxAttempts: PROFILE_LOCK_MAX_ATTEMPTS,
			...(this.#options.tempProfileRoot === undefined ? {} : { tempProfileRoot: this.#options.tempProfileRoot }),
			...(profile.headers === null ? {} : { headers: profile.headers }),
		};

		const generation = ++this.#launchGeneration;
		const spawn = (this.#options.launch ?? launchBrowser)(launchOptions);
		this.#launching = spawn;
		let launched: LaunchedBrowser;
		try {
			launched = await spawn;
		} finally {
			// Only ever clear our own: a later launch may already own the field.
			if (this.#launching === spawn) this.#launching = null;
		}

		if (this.#launchGeneration !== generation) {
			// A kill (or a newer launch) overtook this spawn while it was in flight. Nothing else holds
			// this handle, so nothing else can reap it.
			await this.#reapSuperseded(launched);
			throw new BrowserError('the browser launch was superseded by a stop; the spawned browser was closed');
		}

		this.#launched = launched;
		this.logger.debug('local browser launched', {
			cdpUrl: launched.cdpUrl,
			executablePath: launched.executablePath,
			userDataDir: launched.userDataDir,
		});
		return { cdpUrl: launched.cdpUrl };
	}

	/**
	 * Kills the browser and removes the temp profiles this watchdog created. Idempotent.
	 *
	 * The `HandlerContext` is **read**, not dropped. `BrowserKillEvent.timeoutSec` is 30 and the bus
	 * enforces it by aborting a signal and rejecting the dispatch — it has no way to stop the handler
	 * itself, so an unbounded teardown would simply carry on past the rejection, leaving a
	 * `Deno.remove` in flight while unrelated work runs. `context` is optional so that a direct call
	 * outside a dispatch stays unbudgeted rather than getting a zero budget.
	 */
	async onBrowserKillEvent(_event: BrowserKillEvent, context?: HandlerContext): Promise<void> {
		await this.#kill(handlerBudget(context));
	}

	/**
	 * Enqueues the kill for a locally-launched browser.
	 *
	 * `keepAlive` is honoured exactly as `BrowserSession.stop()` honours it: a non-forced stop on a
	 * keep-alive profile leaves the browser running, which is the whole point of the flag.
	 *
	 * "Is there a browser?" is `#launched !== null` **or** a spawn in flight. The second disjunct
	 * closes the spawn window — see {@linkcode LocalBrowserWatchdog.onBrowserLaunchEvent}.
	 */
	async onBrowserStopEvent(event: BrowserStopEvent, _context?: HandlerContext): Promise<void> {
		if (this.#launched === null && this.#launching === null) return;
		if (!this.host.isLocal) return;
		if (this.profile.keepAlive === true && !event.force) {
			this.logger.debug('keepAlive: leaving the local browser running on stop', {});
			return;
		}
		await this.bus.dispatch(new BrowserKillEvent());
	}

	// -- teardown ----------------------------------------------------------------------------------

	async #kill(budget: HandlerBudget): Promise<void> {
		const launched = this.#launched;
		this.#launched = null;
		// Invalidate any spawn in flight *without* waiting for it. The launch
		// handler sees the generation move and reaps its own product when it lands; waiting here would
		// put a 90 s spawn ladder inside a 30 s kill budget.
		const superseded = this.#launching !== null;
		this.#launching = null;
		this.#launchGeneration += 1;

		// The subprocess is reaped even on the abort path: `launched.close()` is bounded by
		// construction (it ends in SIGKILL), and an orphaned Chrome is a strictly worse outcome than a
		// leftover directory, which the next kill sweeps by prefix.
		if (launched !== null) await this.#closeBrowser(launched, budget);

		if (superseded) {
			// Chrome is still starting up *inside* one of these directories. Removing a live profile is
			// worse than leaving one behind, and the leftovers keep the `bua-tmp-` prefix, so the next
			// kill finishes the job.
			this.logger.warn('a browser launch was still in flight at kill time; the temp profiles stay', {
				dirs: [...this.#ownedProfileDirs],
				hint: 'left for the next kill',
			});
			return;
		}
		await this.#removeOwnedDirs(budget);
	}

	/**
	 * Closes a browser whose launch a kill overtook.
	 *
	 * No CDP `Browser.close()` first and no grace window: the session this browser was being launched
	 * for is already being torn down, nobody ever held its socket, and the point is to hold the
	 * abandoned launch open for as short a time as possible.
	 */
	async #reapSuperseded(launched: LaunchedBrowser): Promise<void> {
		this.logger.warn('a stop overtook the browser launch; closing the browser it produced', {
			cdpUrl: launched.cdpUrl,
			userDataDir: launched.userDataDir,
		});
		try {
			await launched.close({ gracefulMs: 0 });
		} catch (error) {
			this.logger.warn('the superseded browser could not be closed', {
				error,
				hint: 'stale bua-tmp-* directories are safe to remove once no browser runs',
			});
		}
	}

	/**
	 * Graceful shutdown, in the order the Windows note above justifies:
	 * 1. CDP `Browser.close()` — Chrome tears down its own process tree;
	 * 2. wait up to {@linkcode BROWSER_CLOSE_TIMEOUT_MS} for the child to exit;
	 * 3. `launched.close()` — SIGTERM → {@linkcode GRACEFUL_KILL_MS} → SIGKILL (a no-op on an
	 *    already-exited child) plus stderr-tap and retry-profile cleanup.
	 *
	 * The three 5 s caps are **ceilings**, each clamped to what the budget can still pay for, not
	 * reservations stacked unconditionally — stacked, a browser slow to die would spend 15 s of a 30 s
	 * budget here and leave the profile sweep to run outside its own dispatch. The constants
	 * themselves are fixed and `local_browser_test.ts` asserts them verbatim. The ordering is
	 * deliberate — the profile cannot be swept before the browser lets go of it, least of all on
	 * Windows.
	 */
	async #closeBrowser(launched: LaunchedBrowser, budget: HandlerBudget): Promise<void> {
		const client = this.host.cdpClient;
		const closeMs = budget.clamp(BROWSER_CLOSE_TIMEOUT_MS);
		if (client !== null && client.state === 'open' && closeMs > 0) {
			try {
				await client.send.Browser.close(undefined, undefined, { requestTimeoutMs: closeMs });
				// Recomputed rather than reused: the ack may have eaten the whole window, and
				// `withTimeout(…, 0)` waits *forever* rather than not at all.
				const statusMs = budget.clamp(BROWSER_CLOSE_TIMEOUT_MS);
				if (statusMs > 0) await withTimeout(launched.child.status, statusMs);
			} catch (error) {
				this.logger.debug('CDP Browser.close failed; falling back to the process kill', { error });
			}
		}
		try {
			await launched.close({ gracefulMs: budget.clamp(GRACEFUL_KILL_MS) });
		} catch (error) {
			this.logger.warn('browser teardown failed', { error });
		}
	}

	/**
	 * Sweeps the temp profiles this watchdog created, within whatever budget is left.
	 *
	 * A sweep the budget cannot pay for is never *started*. A directory left behind
	 * keeps its `bua-tmp-` prefix and is re-queued, so the next `BrowserKillEvent` (and
	 * a manual sweep) finishes the job — whereas a `Deno.remove` that outlives its
	 * dispatch is an escaped side effect nothing can recall.
	 */
	async #removeOwnedDirs(budget: HandlerBudget): Promise<void> {
		const dirs = this.#ownedProfileDirs.splice(0, this.#ownedProfileDirs.length);
		const remove = this.#options.removeDir ?? removeProfileTree;
		const deferred: string[] = [];
		for (const dir of dirs) {
			if (budget.expired()) {
				deferred.push(dir);
				continue;
			}
			try {
				await remove(dir, budget.expired);
			} catch (error) {
				// Never fail a stop over one directory — but never swallow it either.
				// This was a `debug`, which `silentBusLogger` discards, so a sweep that failed left a
				// profile behind and said nothing. The leftover `bua-tmp-*` directories this produces on
				// Windows — a handle still open on the profile when the sweep runs — were invisible until
				// someone counted directories on disk. A teardown whose failure escapes unobserved is the
				// same defect class as one whose side effect escapes.
				this.logger.warn('temp profile dir could not be removed', {
					dir,
					error,
					hint: 'stale bua-tmp-* directories are safe to remove once no browser runs',
				});
				continue;
			}
			// Stopped mid-tree: re-queue so a later kill resumes it. Removal is idempotent, so
			// re-queuing a directory that in fact finished costs one `lstat` and nothing else.
			if (budget.expired()) deferred.push(dir);
		}
		if (deferred.length === 0) return;
		this.#ownedProfileDirs.unshift(...deferred);
		this.logger.warn('kill budget spent before the temp profiles were swept', {
			dirs: deferred,
			hint: 'left for the next kill',
		});
	}

	// -- filesystem seams --------------------------------------------------------------------------

	/**
	 * Merges {@linkcode PRELOADING_OFF_PREFERENCE} into `<profileDir>/Preferences`. Creates the file
	 * when absent; rewrites an existing JSON object through a temp file and a rename; leaves anything else alone. A
	 * failure is a `warn` naming no path content beyond the file name — the launch goes on, with the commit check as
	 * the remaining containment.
	 *
	 * Takes the list of preferences, so `all`'s
	 * {@linkcode WEBRTC_UDP_OFF_PREFERENCE} lands in the same write; the messages name preloading because it is always
	 * in the list, and the WebRTC lockdown script and the resolver layer remain behind a failed write.
	 */
	async #writeContainmentPreferences(profileDir: string, preferences: readonly ContainmentPreference[]): Promise<void> {
		const file = join(profileDir, PREFERENCES_FILENAME);
		try {
			let prefs: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(await Deno.readTextFile(file));
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					this.logger.warn('profile Preferences is not a JSON object; preloading left as configured', {
						file: PREFERENCES_FILENAME,
					});
					return;
				}
				prefs = parsed as Record<string, unknown>;
			} catch (error) {
				if (!(error instanceof Deno.errors.NotFound)) {
					this.logger.warn('profile Preferences could not be read; preloading left as configured', {
						file: PREFERENCES_FILENAME,
						error: error instanceof Error ? error.name : 'unknown',
					});
					return;
				}
				await Deno.mkdir(profileDir, { recursive: true });
			}
			for (const { section, key, value } of preferences) {
				const current = prefs[section];
				const merged = current !== null && typeof current === 'object' && !Array.isArray(current)
					? { ...(current as Record<string, unknown>), [key]: value }
					: { [key]: value };
				prefs = { ...prefs, [section]: merged };
			}
			const temp = `${file}.ttk-${crypto.randomUUID()}`;
			await Deno.writeTextFile(temp, JSON.stringify(prefs));
			try {
				await Deno.rename(temp, file);
			} catch (error) {
				await Deno.remove(temp).catch(() => {});
				throw error;
			}
		} catch (error) {
			this.logger.warn('preloading could not be turned off for this profile; the commit check remains', {
				file: PREFERENCES_FILENAME,
				error: error instanceof Error ? error.name : 'unknown',
			});
		}
	}

	async #makeTempProfileDir(): Promise<string> {
		const make = this.#options.makeTempProfileDir;
		if (make !== undefined) return await make();
		const root = this.#options.tempProfileRoot;
		try {
			return await Deno.makeTempDir(
				root === undefined ? { prefix: TEMP_PROFILE_PREFIX } : { prefix: TEMP_PROFILE_PREFIX, dir: root },
			);
		} catch (error) {
			throw new BrowserError(
				'could not create a temp profile directory; set BrowserProfile.userDataDir or widen ' +
					`--allow-write: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

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
}

// ---------------------------------------------------------------------------
// cooperative profile removal
// ---------------------------------------------------------------------------

/**
 * Removes a profile directory as many small operations instead of one big one, stopping cleanly
 * whenever `expired()` says so.
 *
 * `Deno.remove(dir, { recursive: true })` is a **single** async op: it takes no signal, cannot be
 * observed mid-flight, and abandoning the promise does not cancel the op. On a Chromium profile it
 * can comfortably outrun a 30 s handler budget, and Deno's op sanitizer then reports the still
 * pending remove against whichever test happened to be running when it landed — the "started before
 * the test, but completed during the test" report. Walking the tree here keeps every started op
 * small enough that "stop now" genuinely means "stop with nothing in flight".
 *
 * Stopping early leaves a partially removed `bua-tmp-*` directory, which is the documented input to
 * a later sweep and to a retry, since this is idempotent.
 */
export async function removeProfileTree(path: string, expired: () => boolean = () => false): Promise<void> {
	if (expired()) return;
	let info: Deno.FileInfo;
	try {
		// `lstat`, not `stat`: a symlinked directory must be unlinked, never descended into.
		info = await Deno.lstat(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return;
		throw error;
	}
	if (!info.isDirectory) return await _removeEntry(path);
	await _removeTree(path, expired);
}

async function _removeTree(dir: string, expired: () => boolean): Promise<void> {
	const entries: Deno.DirEntry[] = [];
	try {
		// Drained before anything is removed: mutating a directory while its `readDir` handle is open
		// is not safe on Windows, and a half-consumed async iterator is itself a live resource.
		for await (const entry of Deno.readDir(dir)) entries.push(entry);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return;
		throw error;
	}
	for (const entry of entries) {
		if (expired()) return;
		const child = join(dir, entry.name);
		if (entry.isDirectory) await _removeTree(child, expired);
		else await _removeEntry(child);
	}
	if (expired()) return;
	await _removeEntry(dir);
}

async function _removeEntry(path: string): Promise<void> {
	try {
		await Deno.remove(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return;
		throw error;
	}
}

/**
 * Reads the display environment without requiring a grant for it.
 *
 * The test and CLI permission matrices scope `--allow-env` to `BUA_*` / `BROWSER_USE_*` / `TIMEOUT_*`,
 * which does not include `DISPLAY`; an unreadable variable must degrade to
 * "no display", never throw `NotCapable`.
 */
function _readDisplayEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const key of DISPLAY_ENV_KEYS) {
		try {
			env[key] = Deno.env.get(key);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotCapable)) throw error;
		}
	}
	return env;
}
