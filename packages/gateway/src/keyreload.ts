/**
 * @module
 * Reloading the API-key file without a restart.
 */
import { parseApiKeys } from './config.ts';
import type { ApiKeyRecord } from './config.ts';
import { normalizeSecret } from './secrets.ts';

/** How long a burst of filesystem events is coalesced before the file is re-read. */
const KEY_RELOAD_DEBOUNCE_MS = 250;

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

/** Watches one key file and swaps the record set when it changes. */
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

	/** Opens the watch. */
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
	 * Stops the watch and drops any pending reload. Idempotent — every exit path calls it, and shutdown awaits the
	 * returned promise so no test sees a live resource or a pending timer.
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
	 * Re-reads the file and applies it. Exposed so a test can drive the reload without a filesystem event, and so
	 * `start` and the debounce have one body between them rather than two.
	 */
	async reload(): Promise<'applied' | 'unchanged' | 'refused' | 'failed'> {
		const read = this.#options.readFile ?? ((path: string) => Deno.readTextFile(path));
		let records: readonly ApiKeyRecord[];
		try {
			const raw = await read(this.#options.path);
			records = parseApiKeys(normalizeSecret(raw, 'TTK_API_KEYS_FILE', this.#options.path), 'TTK_API_KEYS_FILE');
		} catch (cause) {
			// The message names the variable and the fault, never a value: a parse error over a credential file must
			// not quote the credential file.
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
		// The count, never an id: a log line is not the place to enumerate who holds a credential. The operator has the
		// file.
		this.#options.logger.info(`API key records reloaded: ${records.length} in force`);
		return 'applied';
	}

	async #consume(watcher: Deno.FsWatcher): Promise<void> {
		try {
			for await (const event of watcher) {
				if (this.#closed) return;
				// `access` fires for every read of the file, this process's own reload included, which would otherwise
				// be a self-sustaining loop.
				if (event.kind === 'access' || event.kind === 'other') continue;
				if (!this.#touches(event.paths)) continue;
				this.#schedule();
			}
		} catch {
			// The watcher was closed under the loop, or the runtime dropped it. Either way the process keeps the
			// records it holds; `close()` is idempotent.
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
