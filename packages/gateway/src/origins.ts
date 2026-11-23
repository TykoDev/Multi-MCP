/** The per-token origin overlay. It can only ever narrow, and the pipeline is why. Two matching rules, deliberately. */
import * as z from 'zod';
import { dirname, join } from '@std/path';
import { bareHostname } from './config.ts';

/** Origins one token may declare. Beyond this the write is refused, never truncated. */
export const MAX_TOKEN_ORIGINS = 64;

/** Bytes one entry may occupy. An origin is a hostname and a port; this is generous. */
export const MAX_ORIGIN_ENTRY_BYTES = 4096;

/** The overlay file's name inside `TTK_DATA_DIR`. */
export const ORIGINS_FILE = 'origins.json';

/** How a list's entries are compared against a request's `Origin`. */
export type OriginRule = 'hostname' | 'origin';

/** One labelled list as the routes return it. */
export interface OriginList {
	readonly rule: OriginRule;
	readonly entries: readonly string[];
}

/** Whether the overlay could be read. */
export type OverlayStatus = 'ok' | 'absent' | 'unreadable';

const OverlayFileSchema = z.object({
	version: z.literal(1),
	tokens: z.record(z.string().min(1).max(200), z.array(z.string()).max(MAX_TOKEN_ORIGINS)),
});
type OverlayFile = z.infer<typeof OverlayFileSchema>;

/** Why one proposed per-token entry was refused. Closed, so a caller can act on it. */
export type OriginRejection =
	| { readonly kind: 'not-an-origin'; readonly entry: string }
	| { readonly kind: 'bare-hostname'; readonly entry: string; readonly accepted: readonly string[] }
	| { readonly kind: 'too-long'; readonly entry: string; readonly bytes: number };

const ENCODER = new TextEncoder();

/** Normalises one proposed per-token entry, or says why it cannot be one. */
export function normalizeTokenOrigin(entry: string): { origin: string } | { rejected: OriginRejection } {
	const trimmed = entry.trim();
	const bytes = ENCODER.encode(trimmed).length;
	if (bytes > MAX_ORIGIN_ENTRY_BYTES) return { rejected: { kind: 'too-long', entry: trimmed.slice(0, 64), bytes } };
	if (trimmed === '') return { rejected: { kind: 'not-an-origin', entry: trimmed } };
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		return {
			rejected: {
				kind: 'bare-hostname',
				entry: trimmed.slice(0, 64),
				accepted: [`http://${trimmed.slice(0, 64)}`, `https://${trimmed.slice(0, 64)}`],
			},
		};
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { rejected: { kind: 'not-an-origin', entry: trimmed.slice(0, 64) } };
	}
	// `new URL('file:///x').origin` is the string `null`; an opaque origin can never match a browser's `Origin` header
	// and must not be stored as one.
	if (parsed.origin === 'null' || parsed.origin === '') {
		return { rejected: { kind: 'not-an-origin', entry: trimmed.slice(0, 64) } };
	}
	return { origin: parsed.origin };
}

/** The hostname a process-wide entry compares as. */
export { bareHostname as originHostname };

/** The intersection: per-token entries whose hostname the process-wide list already admits. */
export function effectiveOrigins(processWide: readonly string[], token: readonly string[]): OriginList {
	if (token.length === 0) return { rule: 'hostname', entries: [...processWide] };
	const ceiling = new Set(processWide.map(bareHostname).filter((name) => name !== ''));
	return { rule: 'origin', entries: token.filter((entry) => ceiling.has(bareHostname(entry))) };
}

/**
 * Whether a request's `Origin` header passes the effective list. **A request with no `Origin` header passes**, and that
 * is deliberate: it makes the list a *narrowing* control over browser traffic and not an authentication control.
 */
export function originAllowed(origin: string | undefined | null, effective: OriginList): boolean {
	if (origin === undefined || origin === null || origin === '') return true;
	if (effective.rule === 'hostname') {
		const name = bareHostname(origin);
		return effective.entries.some((entry) => bareHostname(entry) === name);
	}
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	return effective.entries.includes(parsed.origin);
}

export interface OriginOverlayOptions {
	/** `TTK_DATA_DIR`, or `null` on a deployment that degrades to read-only. */
	readonly dataDir: string | null;
	readonly logger?: { warn(message: string): void };
}

/** The overlay, held in memory and persisted as one file. */
export class OriginOverlay {
	readonly #path: string | null;
	readonly #logger: { warn(message: string): void } | undefined;
	#tokens = new Map<string, string[]>();
	#status: OverlayStatus = 'absent';
	/** Serializes writes; see {@linkcode OriginOverlay.set}. */
	#queue: Promise<void> = Promise.resolve();

	constructor(options: OriginOverlayOptions) {
		this.#path = options.dataDir === null ? null : join(options.dataDir, ORIGINS_FILE);
		this.#logger = options.logger;
		this.#load();
	}

	/** Whether this deployment can persist a write at all. */
	get writable(): boolean {
		return this.#path !== null;
	}

	get status(): OverlayStatus {
		return this.#status;
	}

	/** The origins one token has declared. Empty means "no narrowing". */
	forToken(principalId: string): readonly string[] {
		return this.#tokens.get(principalId) ?? [];
	}

	/** Replaces one token's list and persists the whole overlay. */
	set(principalId: string, origins: readonly string[]): Promise<void> {
		if (this.#path === null) return Promise.reject(new Error('no data directory is configured'));
		const run = this.#queue.then(async () => {
			const next = new Map(this.#tokens);
			if (origins.length === 0) next.delete(principalId);
			else next.set(principalId, [...origins]);
			await this.#persist(next);
			this.#tokens = next;
			this.#status = 'ok';
		});
		// The chain survives a failed write: without this, one rejected write would reject every write queued behind
		// it, for a fault none of them had.
		this.#queue = run.catch(() => {});
		return run;
	}

	async #persist(tokens: Map<string, string[]>): Promise<void> {
		const path = this.#path;
		if (path === null) return;
		const file: OverlayFile = { version: 1, tokens: Object.fromEntries(tokens) };
		const directory = dirname(path);
		await Deno.mkdir(directory, { recursive: true });
		// The temporary name is unique per write, so two concurrent writes cannot each rename the other's half-written
		// file into place.
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		await Deno.writeTextFile(temporary, `${JSON.stringify(file, null, '\t')}\n`);
		try {
			await Deno.rename(temporary, path);
		} catch (cause) {
			await Deno.remove(temporary).catch(() => {});
			throw cause;
		}
	}

	#load(): void {
		const path = this.#path;
		if (path === null) {
			this.#status = 'absent';
			return;
		}
		let raw: string;
		try {
			raw = Deno.readTextFileSync(path);
		} catch (cause) {
			if (cause instanceof Deno.errors.NotFound) {
				this.#status = 'absent';
				return;
			}
			// Unreadable for any other reason is degraded, not absent: an operator's narrowing that is silently not in
			// force is the failure this distinction exists to make visible.
			this.#status = 'unreadable';
			this.#logger?.warn(
				`the origin overlay at ${path} could not be read (${
					cause instanceof Error ? cause.message : String(cause)
				}); no per-token narrowing is in force`,
			);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			this.#status = 'unreadable';
			this.#logger?.warn(`the origin overlay at ${path} is not valid JSON (${(cause as Error).message})`);
			return;
		}
		const result = OverlayFileSchema.safeParse(parsed);
		if (!result.success) {
			this.#status = 'unreadable';
			this.#logger?.warn(`the origin overlay at ${path} does not match its schema; ignoring it`);
			return;
		}
		const tokens = new Map<string, string[]>();
		for (const [id, entries] of Object.entries(result.data.tokens)) {
			// Every stored entry is re-normalised on read: a file edited by hand is not a trusted input just because it
			// lives on our own volume.
			const kept: string[] = [];
			for (const entry of entries) {
				const outcome = normalizeTokenOrigin(entry);
				if ('origin' in outcome) kept.push(outcome.origin);
			}
			if (kept.length > 0) tokens.set(id, kept.slice(0, MAX_TOKEN_ORIGINS));
		}
		this.#tokens = tokens;
		this.#status = 'ok';
	}
}
