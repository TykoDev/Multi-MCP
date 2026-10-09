/**
 * @module
 * Reloading the API-key file without a restart (SR2-M3).
 *
 * `SPECS/SECURITY-AUTH.md` §2.1 says revocation "takes effect next request (no
 * cached decisions)", and `EVENT_STREAM_REVALIDATE_MS` exists so a long-lived
 * stream — which *is* a cached decision — re-earns that decision every 300 s.
 * Until this module the re-check could not deny an API-key principal at all:
 * `ApiKeyStore` was built once from configuration and never changed, so `hasId`
 * answered "still present" for every principal that had ever authenticated.
 * Revoking a key meant editing the file and restarting, and a restart terminates
 * every stream anyway — so the promise held only in the sense that revocation
 * *was* a restart.
 *
 * ## Why a file watch, and not a signal or a key-management route
 *
 * - **A route would be a new trust boundary.** Key management over HTTP means a
 *   new authenticated surface, a new scope, an admin authorization model and a
 *   write path to the credential store. That is a larger change than the finding,
 *   and it would put a write primitive next to the credentials.
 * - **A signal is not available everywhere.** Deno supports only `SIGINT` and
 *   `SIGBREAK` on Windows, so `SIGHUP` would be a mechanism that exists on one
 *   platform of the two this repository tests on, and the stdio mount has no
 *   business installing a process-wide signal handler at all.
 * - **A watch needs nothing new.** Measured, not assumed
 *   (`build/evidence/b4_1_sr2_m3_watch_permission_probe.log`): `Deno.watchFs`
 *   opens under the `--allow-read` grant alone, fires for an external write while
 *   this process's write permission is `prompt`, and is denied with `NotCapable`
 *   naming `--allow-read` when the grant is absent. The shipped container CMD
 *   already grants `--allow-read=…,/run/secrets`, which is where the compose file
 *   mounts the key secret. **No permission matrix changes.**
 *
 * ## The three refusals that make a reload safe
 *
 * 1. **Never to zero.** An empty record set would make `VerifierChain.credentialed`
 *    false, and on a loopback bind that mints an anonymous principal holding
 *    `TTK_ANON_SCOPES` for every credential-less request — so "revoke everything"
 *    would read as "allow everyone". `ApiKeyStore.replace` refuses it; this module
 *    warns and keeps what it had. Removing the last credential is a restart.
 * 2. **Never on malformed input.** A half-written editor save, a truncated file, a
 *    bad label, a duplicate id: the previous good records stand and the warning
 *    names the fault. The file is re-read on the next event, so a fix is picked up
 *    without operator action.
 * 3. **Never a raw key.** `parseApiKeys` is the same parser startup uses, and the
 *    record schema admits `id`, `sha256`, `scopes` and `label` only — an operator
 *    who pastes a raw `key` field has it stripped at parse and it never reaches
 *    this process's memory beyond the parse. DD-7.
 *
 * A file that never changes — which is the shipped Docker-secret case, since a
 * compose secret is replaced by recreating the container — costs one idle watcher
 * and nothing else.
 */
import { parseApiKeys } from './config.ts';
import type { ApiKeyRecord } from './config.ts';
import { normalizeSecret } from './secrets.ts';

/**
 * How long a burst of filesystem events is coalesced before the file is re-read.
 *
 * An editor writing a file emits several events, and a truncate-then-write leaves
 * the file momentarily empty or half-parsed. Waiting this long turns that burst
 * into one read of a settled file. It is short enough that revocation is still
 * effectively immediate against a 300 s re-check.
 */
export const KEY_RELOAD_DEBOUNCE_MS = 250;

/** The pieces the watcher needs, all injectable so the unit tier drives it without a real filesystem. */
export interface ApiKeyFileWatcherOptions {
	/** The path `TTK_API_KEYS_FILE` named. */
	readonly path: string;
	/** Applies a new record set; `false` means it was refused and the previous set stands. */
	readonly apply: (records: readonly ApiKeyRecord[]) => boolean;
	readonly logger: { info(msg: string): void; warn(msg: string): void };
	/** Defaults to `Deno.readTextFile`. */
	readonly readFile?: (path: string) => Promise<string>;
	/** Defaults to `Deno.watchFs`. */
	readonly watch?: (paths: string[]) => Deno.FsWatcher;
	readonly debounceMs?: number;
}

/**
 * Watches one key file and swaps the record set when it changes.
 *
 * Both the file and its directory are watched. The file alone is not enough: an
 * atomic save writes a new file and renames it over the old one, and an inotify
 * watch follows the *inode*, so the watch would survive attached to a file
 * nothing reads any more. The directory catches the rename. Watching the
 * directory alone is not enough either, on filesystems that report the
 * modification against the file rather than its parent — so both, and the
 * duplicate events a change produces are what the debounce is for.
 */
export class ApiKeyFileWatcher {
	readonly #options: ApiKeyFileWatcherOptions;
	readonly #debounceMs: number;
	#watcher: Deno.FsWatcher | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;
	/** Resolves when the watch loop has ended; awaited by tests and by shutdown. */
	#loop: Promise<void> = Promise.resolve();

	constructor(options: ApiKeyFileWatcherOptions) {
		this.#options = options;
		this.#debounceMs = options.debounceMs ?? KEY_RELOAD_DEBOUNCE_MS;
	}

	/** True once the watch is live. `false` means the reload is not available and the warning said why. */
	get watching(): boolean {
		return this.#watcher !== null;
	}

	/**
	 * Opens the watch.
	 *
	 * A filesystem that cannot be watched — some network and container mounts
	 * cannot — is a **warning, never a throw**: the process keeps the records it
	 * started with, which is exactly the behaviour that shipped before this module
	 * existed. Refusing to start would turn a reduced capability into an outage.
	 */
	start(): void {
		if (this.#closed || this.#watcher !== null) return;
		const open = this.#options.watch ?? ((paths: string[]) => Deno.watchFs(paths));
		const directory = directoryOf(this.#options.path);
		let watcher: Deno.FsWatcher;
		try {
			watcher = open(directory === null ? [this.#options.path] : [this.#options.path, directory]);
		} catch (cause) {
			this.#options.logger.warn(
				`cannot watch the API key file for changes (${describe(cause)}); ` +
					'key records stand until this process restarts',
			);
			return;
		}
		this.#watcher = watcher;
		this.#options.logger.info('watching the API key file: a change revokes or admits keys without a restart');
		this.#loop = this.#consume(watcher);
	}

	/**
	 * Stops the watch and drops any pending reload. Idempotent — every exit path
	 * calls it, and shutdown awaits the returned promise so no test sees a live
	 * resource or a pending timer.
	 */
	close(): Promise<void> {
		this.#closed = true;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		const watcher = this.#watcher;
		this.#watcher = null;
		try {
			watcher?.close();
		} catch {
			// A watcher whose loop already ended is already closed.
		}
		return this.#loop;
	}

	/**
	 * Re-reads the file and applies it. Exposed so a test can drive the reload
	 * without a filesystem event, and so `start` and the debounce have one body
	 * between them rather than two.
	 */
	async reload(): Promise<'applied' | 'unchanged' | 'refused' | 'failed'> {
		const read = this.#options.readFile ?? ((path: string) => Deno.readTextFile(path));
		let records: readonly ApiKeyRecord[];
		try {
			const raw = await read(this.#options.path);
			records = parseApiKeys(normalizeSecret(raw, 'TTK_API_KEYS_FILE', this.#options.path), 'TTK_API_KEYS_FILE');
		} catch (cause) {
			// The message names the variable and the fault, never a value: a parse
			// error over a credential file must not quote the credential file.
			this.#options.logger.warn(
				`the API key file could not be reloaded (${describe(cause)}); the previous key records stand`,
			);
			return 'failed';
		}
		if (!this.#options.apply(records)) {
			this.#options.logger.warn(
				'the API key file now names no keys; refusing to leave this server with no credentials, ' +
					'because a credential-less loopback bind serves anonymous principals. ' +
					'The previous key records stand — restart to remove the last credential.',
			);
			return 'refused';
		}
		// The count, never an id: a log line is not the place to enumerate who
		// holds a credential. The operator has the file.
		this.#options.logger.info(`API key records reloaded: ${records.length} in force`);
		return 'applied';
	}

	async #consume(watcher: Deno.FsWatcher): Promise<void> {
		try {
			for await (const event of watcher) {
				if (this.#closed) return;
				// `access` fires for every read of the file, this process's own reload
				// included, which would otherwise be a self-sustaining loop.
				if (event.kind === 'access' || event.kind === 'other') continue;
				if (!this.#touches(event.paths)) continue;
				this.#schedule();
			}
		} catch {
			// The watcher was closed under the loop, or the runtime dropped it. Either
			// way the process keeps the records it holds; `close()` is idempotent.
		}
	}

	/** Whether an event names the key file, rather than a sibling secret in the same directory. */
	#touches(paths: readonly string[]): boolean {
		const target = baseNameOf(this.#options.path);
		return paths.some((path) => baseNameOf(path) === target);
	}

	#schedule(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		const timer = setTimeout(() => {
			this.#timer = undefined;
			if (this.#closed) return;
			void this.reload();
		}, this.#debounceMs);
		// Never hold the runtime open for a reload nobody is waiting on.
		Deno.unrefTimer(timer as unknown as number);
		this.#timer = timer;
	}
}

/** The last path segment, separator-agnostic so Windows and Linux compare alike. */
function baseNameOf(path: string): string {
	return path.replaceAll('\\', '/').split('/').pop() ?? path;
}

/** The containing directory, or `null` when the path has no separator to split on. */
function directoryOf(path: string): string | null {
	const normalized = path.replaceAll('\\', '/');
	const at = normalized.lastIndexOf('/');
	if (at <= 0) return null;
	return normalized.slice(0, at);
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
