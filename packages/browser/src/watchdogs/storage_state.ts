/**
 * @module
 * `StorageStateWatchdog` — cookie/localStorage persistence (ARCHITECTURE.md §6.9, DATA-MODEL.md
 * §5.1.5, §5.2 "Storage / downloads", §9 R9.2).
 *
 * **Conditional watchdog**: attached only when `storageState` or `userDataDir` is configured — see
 * {@linkcode shouldAttachStorageStateWatchdog}. A session with neither has nothing to persist and
 * must not pay for a 60 s timer.
 *
 * What it does:
 *
 * - **Load before the first navigation.** `BrowserConnectedEvent` (which `start()` awaits) dispatches
 *   `LoadStorageStateEvent`, so cookies are in the jar before anything is fetched. Cookies go in
 *   browser-wide via `Storage.setCookies`; localStorage cannot be written for an origin that is not
 *   loaded, so per-origin items are held and applied when a navigation lands on that origin.
 * - **Save on a 60 s monitor loop diffing cookies** ({@linkcode STORAGE_MONITOR_INTERVAL_MS}). The
 *   diff is over a fingerprint of the jar, so an idle session writes nothing.
 * - **Merge with the existing file, then write atomically** through `.tmp` → `.bak` → rename.
 *
 * ## The cookie-leak prevention rule (§6.9: "in-memory dicts are never stringified")
 *
 * Two distinct obligations, both tested:
 *
 * 1. A `storageState` supplied as an **object** stays in memory. It is never serialized to disk —
 *    not to the configured path, not to a temp file, not to a `.bak`. The caller handed us a value,
 *    not a location, and inventing a location for it is how session cookies end up in a repo.
 * 2. **No cookie value or name ever reaches a log record.** Every log call in this module carries
 *    counts, produced by {@linkcode describeStorageState}, and nothing else. `JSON.stringify` appears
 *    exactly once, in {@linkcode StorageStateWatchdog} `#writeAtomic`, which is only reachable when a
 *    file path was explicitly configured.
 */

import { dirname, join } from '@std/path';
import type { HandlerContext } from '@tykotech/bus';
import type { CdpParams, SessionId, TargetId } from '@tykotech/cdp';
import {
	BrowserConnectedEvent,
	BrowserStopEvent,
	LoadStorageStateEvent,
	NavigationCompleteEvent,
	SaveStorageStateEvent,
	StorageStateLoadedEvent,
	StorageStateSavedEvent,
} from '../events.ts';
import { BrowserError } from '../errors.ts';
import type { BrowserProfile, Cookie, StorageOriginState, StorageState } from '../types.ts';
import { containedJoin, isContainedIn } from '../security/containment.ts';
import { type HandlerBudget, handlerBudget } from './handler_budget.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants (ARCHITECTURE.md §6.9 — load-bearing, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/** Cookie-diff monitor cadence (ARCHITECTURE.md §6.9: "saves on a 60 s monitor loop"). */
export const STORAGE_MONITOR_INTERVAL_MS = 60_000;

/** Suffix of the temp file the atomic write goes through. */
export const STORAGE_TMP_SUFFIX = '.tmp';

/** Suffix of the previous generation kept beside the file. */
export const STORAGE_BACKUP_SUFFIX = '.bak';

/**
 * File name used when only `userDataDir` is configured.
 *
 * ERRATUM(M1-watchdogs-data-3): §6.9 makes the watchdog conditional on "`storageState` **or**
 * `userDataDir` configured" but never says where it saves in the `userDataDir`-only case. It is
 * placed inside the profile directory (through the containment join, so a hostile `userDataDir`
 * cannot redirect it) under a `bua_`-prefixed name that cannot collide with Chrome's own files.
 */
export const DEFAULT_STORAGE_STATE_FILENAME = 'bua_storage_state.json';

/** An empty, well-formed storage state. */
export function emptyStorageState(): StorageState {
	return { cookies: [], origins: [] };
}

/**
 * The conditional-attachment predicate (ARCHITECTURE.md §6.9).
 *
 * `BrowserSession` consults this before constructing the watchdog; it is exported so the decision is
 * testable, and greppable, on its own.
 */
export function shouldAttachStorageStateWatchdog(
	profile: Pick<BrowserProfile, 'storageState' | 'userDataDir'>,
): boolean {
	return profile.storageState !== null || profile.userDataDir !== null;
}

// ---------------------------------------------------------------------------
// pure helpers — the storage-state document algebra
// ---------------------------------------------------------------------------

/** Counts only. The one shape allowed into a log record from this module. */
export function describeStorageState(state: StorageState): { cookiesCount: number; originsCount: number } {
	return { cookiesCount: state.cookies.length, originsCount: state.origins.length };
}

/** Identity of a cookie for merge and diff purposes: RFC 6265's `(name, domain, path)` triple. */
export function cookieKey(cookie: Pick<Cookie, 'name' | 'domain' | 'path'>): string {
	return `${cookie.name} ${cookie.domain} ${cookie.path}`;
}

/**
 * A stable fingerprint of the jar, used by the 60 s loop to decide whether anything changed.
 *
 * It includes the value, because a refreshed session token is exactly the change worth persisting.
 * It is a *comparison* key held in memory, never logged and never written.
 */
export function cookieFingerprint(cookies: readonly Cookie[]): string {
	return cookies
		.map((cookie) => `${cookieKey(cookie)} ${cookie.value} ${cookie.expires}`)
		.sort()
		.join('');
}

/** CDP `Network.Cookie` → the Playwright-format cookie of DATA-MODEL.md §5.2. */
export function toStorageCookie(cdp: {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	session?: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
}): Cookie {
	return {
		name: cdp.name,
		value: cdp.value,
		domain: cdp.domain,
		path: cdp.path,
		// §5.2: `-1` marks a session cookie. CDP reports `session: true` with an unusable `expires`.
		expires: cdp.session === true ? -1 : cdp.expires,
		httpOnly: cdp.httpOnly,
		secure: cdp.secure,
		sameSite: cdp.sameSite ?? 'Lax',
	};
}

/** `Network.CookieParam` as the typed CDP surface spells it (no deep import — D-CDP2 via `CdpParams`). */
export type StorageCookieParam = CdpParams['Storage.setCookies']['cookies'][number];

/** The write-side shape (`Network.CookieParam`); `expires` is omitted for session cookies. */
export function toCookieParam(cookie: Cookie): StorageCookieParam {
	const param: StorageCookieParam = {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		httpOnly: cookie.httpOnly,
		secure: cookie.secure,
		sameSite: cookie.sameSite,
	};
	if (cookie.expires >= 0) param.expires = cookie.expires;
	return param;
}

/**
 * Merges a freshly-read state over one already on disk (ARCHITECTURE.md §6.9 "merges with the
 * existing file").
 *
 * Live wins on collision: the browser's jar is the newer truth. Entries only present in the file are
 * preserved, because a run that only visited one site must not wipe another site's login.
 */
export function mergeStorageState(existing: StorageState, live: StorageState): StorageState {
	const cookies = new Map<string, Cookie>();
	for (const cookie of existing.cookies) cookies.set(cookieKey(cookie), cookie);
	for (const cookie of live.cookies) cookies.set(cookieKey(cookie), cookie);

	const origins = new Map<string, StorageOriginState>();
	for (const origin of existing.origins) origins.set(origin.origin, origin);
	for (const origin of live.origins) {
		const previous = origins.get(origin.origin);
		origins.set(
			origin.origin,
			previous === undefined ? origin : {
				origin: origin.origin,
				localStorage: mergeItems(previous.localStorage, origin.localStorage),
				sessionStorage: mergeItems(previous.sessionStorage, origin.sessionStorage),
			},
		);
	}

	return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

function mergeItems(
	existing: readonly { name: string; value: string }[],
	live: readonly { name: string; value: string }[],
): { name: string; value: string }[] {
	const merged = new Map<string, string>();
	for (const item of existing) merged.set(item.name, item.value);
	for (const item of live) merged.set(item.name, item.value);
	return [...merged].map(([name, value]) => ({ name, value }));
}

/**
 * Parses a storage-state document defensively.
 *
 * A malformed or partial file yields the empty state plus a reason rather than throwing: a corrupt
 * cookie jar must degrade to "no saved session", never to "the browser will not start".
 */
export function parseStorageState(text: string): { state: StorageState; error: string | null } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// ERRATUM(E-109), review R1-1: the reason is logged, and a cookie jar is a credential store. V8's own message
		// quotes the document's text — all of it when short, its start otherwise — so a truncated or corrupted file put
		// a cookie value into the log. A fixed phrase, and the position when the parser reports one.
		const at = error instanceof SyntaxError ? /\bat position (\d+)\b/.exec(error.message)?.[1] : undefined;
		return {
			state: emptyStorageState(),
			error: at === undefined ? 'storage state is not valid JSON' : `storage state is not valid JSON at position ${at}`,
		};
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return { state: emptyStorageState(), error: 'storage state is not an object' };
	}
	const record = parsed as { cookies?: unknown; origins?: unknown };
	const cookies = Array.isArray(record.cookies) ? record.cookies.filter(isCookieLike).map(normalizeCookie) : [];
	const origins = Array.isArray(record.origins) ? record.origins.filter(isOriginLike).map(normalizeOrigin) : [];
	return { state: { cookies, origins }, error: null };
}

function isCookieLike(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string';
}

function normalizeCookie(value: Record<string, unknown>): Cookie {
	const sameSite = value.sameSite;
	return {
		name: String(value.name ?? ''),
		value: String(value.value ?? ''),
		domain: String(value.domain ?? ''),
		path: String(value.path ?? '/'),
		expires: typeof value.expires === 'number' ? value.expires : -1,
		httpOnly: value.httpOnly === true,
		secure: value.secure === true,
		sameSite: sameSite === 'Strict' || sameSite === 'None' ? sameSite : 'Lax',
	};
}

function isOriginLike(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && typeof (value as { origin?: unknown }).origin === 'string';
}

function normalizeOrigin(value: Record<string, unknown>): StorageOriginState {
	return {
		origin: String(value.origin ?? ''),
		localStorage: normalizeItems(value.localStorage),
		sessionStorage: normalizeItems(value.sessionStorage),
	};
}

function normalizeItems(value: unknown): { name: string; value: string }[] {
	if (!Array.isArray(value)) return [];
	const items: { name: string; value: string }[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) continue;
		const item = entry as { name?: unknown; value?: unknown };
		if (typeof item.name !== 'string') continue;
		items.push({ name: item.name, value: String(item.value ?? '') });
	}
	return items;
}

/** The origin of a URL, or `null` for non-http(s) URLs (about:blank has no storage). */
export function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

function describeError(value: unknown): string {
	return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/** Injection seams; every default is the real filesystem. */
export interface StorageStateWatchdogOptions {
	/** Overrides the path derived from the profile. */
	readonly path?: string | null | undefined;
	/** Injected clock, so `FakeTime` drives the monitor loop. */
	readonly now?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class StorageStateWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [
		BrowserConnectedEvent,
		LoadStorageStateEvent,
		SaveStorageStateEvent,
		NavigationCompleteEvent,
		BrowserStopEvent,
	];

	static override readonly EMITS = [
		LoadStorageStateEvent,
		SaveStorageStateEvent,
		StorageStateLoadedEvent,
		StorageStateSavedEvent,
	];

	readonly #options: StorageStateWatchdogOptions;
	readonly #now: () => number;
	/** localStorage/sessionStorage waiting for a navigation to their origin. */
	readonly #pendingOrigins = new Map<string, StorageOriginState>();
	/** Origins a page in this session has actually loaded — the only ones we can read back. */
	readonly #seenOrigins = new Map<string, TargetId>();

	#monitorTimer: ReturnType<typeof setInterval> | null = null;
	/**
	 * Cancellation for work the 60 s loop started (ERRATUM(CANCEL-2)).
	 *
	 * The monitor is the one write path with no dispatch behind it, so it has no `HandlerContext` and
	 * no deadline — but it does have a lifetime, and `detach()` ends it. Aborted there so a tick caught
	 * between its CDP reads and its write does not commit one after the watchdog is gone.
	 */
	#monitorAbort: AbortController | null = null;
	#lastFingerprint: string | null = null;
	#saving: Promise<void> | null = null;
	#loaded = false;

	constructor(host: WatchdogHost, options: StorageStateWatchdogOptions = {}) {
		super(host);
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	// -- public surface ----------------------------------------------------------------------------

	/**
	 * Where state is persisted, or `null` when it lives in memory only.
	 *
	 * `null` is the cookie-leak-prevention path: an in-memory `storageState` object has no file, and
	 * this watchdog will not invent one for it.
	 */
	get storagePath(): string | null {
		return this.#resolvePath();
	}

	/** `true` while the 60 s cookie-diff loop is armed. */
	get monitoring(): boolean {
		return this.#monitorTimer !== null;
	}

	/** Origins whose localStorage is still waiting for a navigation to land on them. */
	get pendingOrigins(): readonly string[] {
		return [...this.#pendingOrigins.keys()];
	}

	// -- handlers ----------------------------------------------------------------------------------

	/**
	 * Loads before the first navigation and arms the monitor loop.
	 *
	 * `BrowserSession.start()` awaits `BrowserConnectedEvent`, so by the time `start()` returns the
	 * cookies are in the jar — that ordering is the whole point of dispatching the load from here
	 * rather than from the session (ARCHITECTURE.md §6.9).
	 */
	async onBrowserConnectedEvent(_event: BrowserConnectedEvent, _context?: HandlerContext): Promise<void> {
		await this.bus.dispatch(new LoadStorageStateEvent());
		this.#startMonitor();
	}

	/** Reads the document (file or in-memory object) and applies it to the browser. */
	async onLoadStorageStateEvent(event: LoadStorageStateEvent, context?: HandlerContext): Promise<void> {
		const path = event.path ?? this.#resolvePath();
		const source = await this.#read(path);
		const state = source.state;
		this.#loaded = true;

		let applied = 0;
		if (state.cookies.length > 0) {
			try {
				await this.cdpFor(context).send.Storage.setCookies({ cookies: state.cookies.map(toCookieParam) });
				applied = state.cookies.length;
			} catch (error) {
				// A rejected jar is a degraded session, not a dead one.
				this.logger.warn('cookies could not be applied', { error, cookiesCount: state.cookies.length });
			}
		}

		this.#pendingOrigins.clear();
		for (const origin of state.origins) this.#pendingOrigins.set(origin.origin, origin);
		// A page may already be parked on one of these origins (a reconnect, or a pre-existing tab).
		await this.#applyPendingForKnownOrigins(context);

		this.#lastFingerprint = cookieFingerprint(state.cookies);
		this.logger.debug('storage state loaded', {
			path: path ?? '<memory>',
			appliedCookies: applied,
			...describeStorageState(state),
		});
		await this.bus.dispatch(
			new StorageStateLoadedEvent({
				path: path ?? '',
				cookiesCount: state.cookies.length,
				originsCount: state.origins.length,
			}),
		);
	}

	/**
	 * Reads the live browser state, merges it over what is stored, and persists it.
	 *
	 * ERRATUM(CANCEL-2): the `HandlerContext` is read — see {@linkcode StorageStateWatchdog} `#saveOnce`
	 * for what the budget gates and why the write itself is not interruptible once begun.
	 */
	async onSaveStorageStateEvent(event: SaveStorageStateEvent, context?: HandlerContext): Promise<void> {
		await this.#save(event.path ?? this.#resolvePath(), handlerBudget(context));
	}

	/** Applies any localStorage held for the origin the page just landed on, and remembers the origin. */
	async onNavigationCompleteEvent(event: NavigationCompleteEvent, context?: HandlerContext): Promise<void> {
		const origin = originOf(event.url);
		if (origin === null) return;
		this.#seenOrigins.set(origin, event.targetId);
		const pending = this.#pendingOrigins.get(origin);
		if (pending === undefined) return;
		const ok = await this.#applyOrigin(pending, event.targetId, context);
		if (ok) this.#pendingOrigins.delete(origin);
	}

	/**
	 * Final save, then the loop is disarmed. Registered before the session's socket teardown.
	 *
	 * ERRATUM(CANCEL-2): this is the **first** `BrowserStopEvent` handler in the attach order
	 * (`attach_order.ts`), so an overrun here is not litter — the bus moves on to
	 * `LocalBrowserWatchdog` (which kills Chrome) and `BrowserSession` (which closes the socket) while
	 * this handler's four filesystem operations are still running. Reading the context is what stops a
	 * save assembled from a half-dead browser from landing on top of a good file.
	 */
	async onBrowserStopEvent(_event: BrowserStopEvent, context?: HandlerContext): Promise<void> {
		this.#stopMonitor();
		if (!this.#loaded) return;
		try {
			await this.#save(this.#resolvePath(), handlerBudget(context));
		} catch (error) {
			this.logger.warn('final storage-state save failed', { error });
		}
	}

	/** Timer hygiene: the 60 s loop must not outlive the watchdog (the op sanitizer proves it). */
	protected override beforeDetach(): void {
		this.#stopMonitor();
		// ERRATUM(CANCEL-2): the timer is only half of it. A tick already past its `setInterval`
		// callback holds no timer and would still commit its write after `detach()`; the abort is what
		// reaches that one. The controller is kept, not nulled — a tick suspended on a CDP read has to
		// find an *aborted* signal when it resumes, not the absence of one, which would read as
		// "unbudgeted". `#startMonitor` replaces it on re-attach.
		this.#monitorAbort?.abort();
	}

	// -- monitor loop ------------------------------------------------------------------------------

	#startMonitor(): void {
		if (this.#monitorTimer !== null) return;
		// A fresh controller per arming, so a re-attached watchdog is not born already cancelled.
		if (this.#monitorAbort === null || this.#monitorAbort.signal.aborted) this.#monitorAbort = new AbortController();
		this.#monitorTimer = setInterval(() => {
			void this.#monitorTick();
		}, STORAGE_MONITOR_INTERVAL_MS);
	}

	#stopMonitor(): void {
		if (this.#monitorTimer === null) return;
		clearInterval(this.#monitorTimer);
		this.#monitorTimer = null;
	}

	/**
	 * One cookie-diff pass. Never throws: it runs off a timer, where a rejection has nobody to catch
	 * it and would surface as an unhandled rejection that kills the process.
	 */
	async #monitorTick(): Promise<void> {
		try {
			if (this.#saving !== null) return;
			const budget = this.#monitorBudget();
			const cookies = await this.#readCookies(budget.context);
			const fingerprint = cookieFingerprint(cookies);
			if (fingerprint === this.#lastFingerprint) return;
			await this.#save(this.#resolvePath(), budget, cookies);
		} catch (error) {
			this.logger.debug('storage-state monitor pass failed', { error });
		}
	}

	/**
	 * The tick's budget: no deadline, but cancellable (ERRATUM(CANCEL-2)).
	 *
	 * `timeoutSec: 0` is the bus's own spelling of "timeout disabled", which is the honest description
	 * of a timer callback — nothing is waiting on it, so nothing is being made late. What it does have
	 * is a lifetime, and `beforeDetach` ends it.
	 */
	#monitorBudget(): HandlerBudget {
		const signal = this.#monitorAbort?.signal;
		if (signal === undefined) return handlerBudget(undefined);
		return handlerBudget({ signal, handlerName: 'StorageStateWatchdog.monitorTick', timeoutSec: 0 });
	}

	/** Exposed for the contract test: runs exactly what the 60 s timer runs. */
	monitorTick(): Promise<void> {
		return this.#monitorTick();
	}

	// -- save / load -------------------------------------------------------------------------------

	async #save(path: string | null, budget: HandlerBudget, cookiesHint?: readonly Cookie[]): Promise<void> {
		const inflight = this.#saving;
		if (inflight !== null) {
			await inflight;
			return;
		}
		const run = this.#saveOnce(path, budget, cookiesHint).finally(() => {
			this.#saving = null;
		});
		this.#saving = run;
		await run;
	}

	/**
	 * ERRATUM(CANCEL-2): the budget gates the **decision** to write, immediately before the write and
	 * after the CDP reads that are what actually consume it. Nothing gates the write itself.
	 *
	 * That asymmetry is the point, and it is the opposite of the one ERRATUM(KILL-3) chose for the
	 * profile sweep. There, stopping between directories is free — the leftovers keep their prefix and
	 * a later pass finishes them. Here the four operations of `#writeAtomic` are a transaction over a
	 * file that is *already good*: stopping after the `.tmp` write leaves litter, and stopping between
	 * the `.bak` copy and the rename rotates a generation without landing the new one. So the sequence
	 * either does not start or runs to completion. A save skipped at the gate costs the newest cookies;
	 * a save abandoned mid-flight can cost the previous session as well, and it is the one whose damage
	 * is not recoverable by simply saving again later.
	 *
	 * `#lastFingerprint` therefore moved **after** the write. It used to be assigned before it, which
	 * meant a save that was skipped — or one that threw — still told the 60 s loop the jar was
	 * persisted, suppressing the next legitimate save. A save that did not happen must leave the diff
	 * looking dirty.
	 */
	async #saveOnce(path: string | null, budget: HandlerBudget, cookiesHint?: readonly Cookie[]): Promise<void> {
		// ERRATUM(E-52): the two browser reads below now travel on the handler's own signal, so on a
		// spent budget they *reject* instead of returning a jar read from a browser that is about to be
		// killed. Deciding here keeps that as the documented skip — one warn, previous generation intact
		// — rather than an `AbortError` escaping a save the system had already given up on. It is also
		// strictly better than the old order, which asked a dying browser for data it then discarded.
		//
		// The check below survives too: it is the one that catches a budget spent *during* the reads,
		// which is still ERRATUM(CANCEL-2)'s case — the decision to write is cancellable, the write is
		// not.
		if (budget.expired()) {
			this.#logSkippedSave(path);
			return;
		}
		const cookies = cookiesHint ?? await this.#readCookies(budget.context);
		const origins = await this.#readOrigins(budget.context);
		const live: StorageState = { cookies: [...cookies], origins };

		const existing = await this.#read(path);
		const merged = mergeStorageState(existing.state, live);

		if (path === null) {
			// The cookie-leak prevention rule: an in-memory storage state is updated in place and is
			// NEVER serialized. No temp file, no backup, no `JSON.stringify` on this path at all. No
			// budget check either: this touches no filesystem and cannot escape anywhere.
			const target = this.profile.storageState;
			if (typeof target === 'object' && target !== null) {
				target.cookies = merged.cookies;
				target.origins = merged.origins;
			}
			this.#lastFingerprint = cookieFingerprint(cookies);
			this.logger.debug('storage state kept in memory (no path configured)', describeStorageState(merged));
			return;
		}

		if (budget.expired()) {
			this.#logSkippedSave(path, describeStorageState(merged));
			return;
		}

		await this.#writeAtomic(path, merged);
		this.#lastFingerprint = cookieFingerprint(cookies);
		this.logger.debug('storage state saved', { path, ...describeStorageState(merged) });
		await this.bus.dispatch(
			new StorageStateSavedEvent({
				path,
				cookiesCount: merged.cookies.length,
				originsCount: merged.origins.length,
			}),
		);
	}

	/**
	 * The one wording for "the budget was spent, so nothing was written" — ERRATUM(CANCEL-2).
	 *
	 * Both skip sites share it deliberately: two spellings of one condition is how a log line that
	 * something greps for quietly stops matching on one of its paths.
	 */
	#logSkippedSave(path: string | null, extra: Record<string, unknown> = {}): void {
		this.logger.warn('storage-state save skipped: the handler budget was spent before the write began', {
			path: path ?? '<memory>',
			...extra,
			hint: 'the previous generation is intact; the next save or `SaveStorageStateEvent` writes it',
		});
	}

	/**
	 * The atomic write of §6.9: `path.tmp` → copy the previous generation to `path.bak` → rename.
	 *
	 * `rename` within one directory is the atomic step; the `.bak` copy happens first so the previous
	 * generation is never the thing that is missing if the process dies mid-write.
	 *
	 * Deliberately takes **no** budget: see `#saveOnce`. Once this is entered it runs to completion,
	 * because a half-applied atomic write is worse than a late one.
	 */
	async #writeAtomic(path: string, state: StorageState): Promise<void> {
		const tmp = `${path}${STORAGE_TMP_SUFFIX}`;
		const backup = `${path}${STORAGE_BACKUP_SUFFIX}`;
		await Deno.mkdir(dirname(path), { recursive: true }).catch((error: unknown) => {
			if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
		});
		// The one `JSON.stringify` in this module — reachable only with an explicitly configured path.
		await Deno.writeTextFile(tmp, `${JSON.stringify(state, null, '\t')}\n`);
		try {
			await Deno.copyFile(path, backup);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) {
				this.logger.debug('previous storage state could not be backed up', { path, error });
			}
		}
		try {
			await Deno.rename(tmp, path);
		} catch (error) {
			await Deno.remove(tmp).catch(() => {});
			throw new BrowserError(`storage state could not be written to ${path}: ${describeError(error)}`, {
				cause: error,
			});
		}
	}

	/** Reads the configured document: the in-memory object, the file, or the empty state. */
	async #read(path: string | null): Promise<{ state: StorageState; error: string | null }> {
		const configured = this.profile.storageState;
		if (path === null) {
			if (typeof configured === 'object' && configured !== null) {
				return { state: { cookies: [...configured.cookies], origins: [...configured.origins] }, error: null };
			}
			return { state: emptyStorageState(), error: null };
		}
		try {
			const text = await Deno.readTextFile(path);
			const parsed = parseStorageState(text);
			if (parsed.error !== null) this.logger.warn('storage state file is unusable', { path, error: parsed.error });
			return parsed;
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) {
				this.logger.warn('storage state file could not be read', { path, error });
			}
			return { state: emptyStorageState(), error: null };
		}
	}

	// -- browser reads / writes --------------------------------------------------------------------

	async #readCookies(context: HandlerContext | undefined): Promise<Cookie[]> {
		const result = await this.cdpFor(context).send.Storage.getCookies({});
		return result.cookies.map(toStorageCookie);
	}

	/** Reads localStorage/sessionStorage for every origin a page in this session actually loaded. */
	async #readOrigins(context: HandlerContext | undefined): Promise<StorageOriginState[]> {
		const origins: StorageOriginState[] = [];
		for (const [origin, targetId] of this.#seenOrigins) {
			try {
				const sessionId = (await this.sessions.getOrCreateCdpSession(targetId, false)).sessionId;
				origins.push({
					origin,
					localStorage: await this.#readStorage(origin, sessionId, true, context),
					sessionStorage: await this.#readStorage(origin, sessionId, false, context),
				});
			} catch (error) {
				this.logger.debug('origin storage could not be read', { origin, error });
			}
		}
		// Origins we never landed on keep whatever was loaded for them, so a partial run does not
		// silently drop another site's data at merge time.
		for (const [origin, pending] of this.#pendingOrigins) {
			if (this.#seenOrigins.has(origin)) continue;
			origins.push(pending);
		}
		return origins;
	}

	async #readStorage(
		origin: string,
		sessionId: SessionId,
		isLocalStorage: boolean,
		context: HandlerContext | undefined,
	): Promise<{ name: string; value: string }[]> {
		await this.#enableDomStorage(sessionId, context);
		const result = await this.cdpFor(context).send.DOMStorage.getDOMStorageItems({
			storageId: { securityOrigin: origin, isLocalStorage },
		}, sessionId);
		const items: { name: string; value: string }[] = [];
		for (const entry of result.entries) {
			const name = entry[0];
			if (name === undefined) continue;
			items.push({ name, value: entry[1] ?? '' });
		}
		return items;
	}

	async #applyPendingForKnownOrigins(context: HandlerContext | undefined): Promise<void> {
		for (const [origin, state] of [...this.#pendingOrigins]) {
			const targetId = this.#seenOrigins.get(origin);
			if (targetId === undefined) continue;
			if (await this.#applyOrigin(state, targetId, context)) this.#pendingOrigins.delete(origin);
		}
	}

	/**
	 * Writes one origin's localStorage/sessionStorage.
	 *
	 * ERRATUM(M1-watchdogs-data-4): §6.9 says localStorage is loaded "before first navigation", but
	 * CDP cannot write DOM storage for an origin no renderer has loaded — `DOMStorage` addresses a
	 * live storage area, not the on-disk database. Cookies genuinely go in before the first
	 * navigation (`Storage.setCookies` is browser-wide); per-origin items are held and applied on the
	 * `NavigationCompleteEvent` that lands on their origin, which is the earliest moment the write is
	 * possible at all. The observable contract — "a page on origin X sees the saved localStorage" —
	 * is preserved.
	 */
	async #applyOrigin(
		state: StorageOriginState,
		targetId: TargetId,
		context: HandlerContext | undefined,
	): Promise<boolean> {
		try {
			const sessionId = (await this.sessions.getOrCreateCdpSession(targetId, false)).sessionId;
			await this.#enableDomStorage(sessionId, context);
			for (const item of state.localStorage) {
				await this.cdpFor(context).send.DOMStorage.setDOMStorageItem({
					storageId: { securityOrigin: state.origin, isLocalStorage: true },
					key: item.name,
					value: item.value,
				}, sessionId);
			}
			for (const item of state.sessionStorage) {
				await this.cdpFor(context).send.DOMStorage.setDOMStorageItem({
					storageId: { securityOrigin: state.origin, isLocalStorage: false },
					key: item.name,
					value: item.value,
				}, sessionId);
			}
			this.logger.debug('origin storage applied', {
				origin: state.origin,
				localStorageCount: state.localStorage.length,
				sessionStorageCount: state.sessionStorage.length,
			});
			return true;
		} catch (error) {
			this.logger.debug('origin storage could not be applied', { origin: state.origin, error });
			return false;
		}
	}

	async #enableDomStorage(sessionId: SessionId, context: HandlerContext | undefined): Promise<void> {
		try {
			await this.cdpFor(context).send.DOMStorage.enable(undefined, sessionId);
		} catch (error) {
			this.logger.debug('DOMStorage.enable failed', { error });
		}
	}

	// -- path resolution ---------------------------------------------------------------------------

	/**
	 * The configured file, or `null` for the in-memory case.
	 *
	 * The `userDataDir` fallback goes through {@linkcode containedJoin}, and an explicit
	 * `storageState` path is checked against its own parent directory — a storage-state path is
	 * user-supplied config, and "user-supplied" is the same trust level as "attacker-supplied" once
	 * a config file is shared (SECURITY-AUTH.md §8).
	 */
	#resolvePath(): string | null {
		const override = this.#options.path;
		if (override !== undefined) return override;

		const configured = this.profile.storageState;
		if (typeof configured === 'string' && configured !== '') return configured;
		if (configured !== null) return null; // an in-memory object: no file, ever.

		const userDataDir = this.profile.userDataDir;
		if (userDataDir === null || userDataDir === '') return null;
		const joined = containedJoin(userDataDir, DEFAULT_STORAGE_STATE_FILENAME);
		if (joined === null || !isContainedIn(userDataDir, joined)) {
			this.logger.warn('userDataDir does not admit a storage-state file', { userDataDir });
			return null;
		}
		return joined;
	}

	/** The default path for a profile, exposed for callers that want it without a live watchdog. */
	static defaultPathFor(profile: Pick<BrowserProfile, 'storageState' | 'userDataDir'>): string | null {
		if (typeof profile.storageState === 'string' && profile.storageState !== '') return profile.storageState;
		if (profile.storageState !== null) return null;
		if (profile.userDataDir === null || profile.userDataDir === '') return null;
		return containedJoin(profile.userDataDir, DEFAULT_STORAGE_STATE_FILENAME) ??
			join(profile.userDataDir, DEFAULT_STORAGE_STATE_FILENAME);
	}
}
