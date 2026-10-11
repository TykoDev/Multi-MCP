/**
 * Memory the operator can act on (Sessions › Sessions, `GET /api/v1/system/usage`): each browser session's Chromium
 * memory, the gateway's heap against its limit, and the container's configured limit.
 *
 * A browser's memory is Chromium's own account of it: one `Tracing.requestMemoryDump` over the session's existing CDP
 * connection (a `memory-infra` trace holding nothing but the dump), whose `process_totals` give each of its processes'
 * **private footprint** — the figure Chrome's task manager shows, shared pages not counted twice. No file is read and no
 * permission is needed: Deno refuses `/proc` and `/sys` to anything short of `--allow-all`, which this server never
 * holds. A dump takes about half a second, so each session's figure is kept for {@linkcode BROWSER_MEMORY_TTL_MS} and a
 * request never waits longer than {@linkcode BROWSER_MEMORY_WAIT_MS} for a fresh one; a browser that is already tracing
 * or does not answer reads as not measured.
 *
 * The container's limit cannot be read without `/sys` either, so it is configuration: `TTK_MEMORY_LIMIT`, which the
 * Compose file fills from the same `TTK_GATEWAY_MEMORY` it gives `mem_limit`. Its use is estimated as the gateway's
 * resident memory plus every browser's footprint — the container holds nothing else.
 */
// deno-lint-ignore no-external-import -- node: builtin (V8's own heap statistics: Deno exposes no heap limit), not a dependency; D-160
import { getHeapStatistics } from 'node:v8';

/** How long one session's measured figure is reused. */
export const BROWSER_MEMORY_TTL_MS = 15_000;
/** How long a request waits for a fresh dump before it answers with the last figure (or none). */
export const BROWSER_MEMORY_WAIT_MS = 3_000;

/** One browser's memory: the summed private footprint of its processes. */
export interface BrowserMemory {
	readonly private_bytes: number;
	readonly processes: number;
}

/** The part of a CDP client a dump needs (the session's `cdpClient`). */
export interface DumpClient {
	sendRaw<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	on(event: never, listener: never): () => void;
}

/** The memory a `memory-infra` trace's events report: the last dump per process, summed. `null` with none. */
export function footprintOf(events: readonly unknown[]): BrowserMemory | null {
	const perProcess = new Map<number, number>();
	for (const event of events) {
		const record = event as {
			ph?: unknown;
			pid?: unknown;
			args?: { dumps?: { process_totals?: Record<string, unknown> } };
		};
		const totals = record?.args?.dumps?.process_totals;
		if (record?.ph !== 'v' || typeof record.pid !== 'number' || totals === undefined) continue;
		const footprint = totals.private_footprint_bytes;
		const bytes = typeof footprint === 'string'
			? parseInt(footprint, 16)
			: typeof footprint === 'number'
			? footprint
			: NaN;
		if (Number.isFinite(bytes) && bytes >= 0) perProcess.set(record.pid, bytes);
	}
	if (perProcess.size === 0) return null;
	return { private_bytes: [...perProcess.values()].reduce((sum, bytes) => sum + bytes, 0), processes: perProcess.size };
}

/**
 * One memory dump of the browser behind `client`: start a trace of the memory-infra category alone, request a dump,
 * end it and read the events it reported. `null` when the browser refuses (already tracing) or answers nothing usable.
 */
export async function dumpBrowser(client: DumpClient, timeoutMs = 10_000): Promise<BrowserMemory | null> {
	const events: unknown[] = [];
	// Bound: the client keeps its listeners in a private field. `on` is typed to the domains the vendored client knows;
	// `Tracing` is not among them, and its events dispatch by name all the same.
	const on = (event: string, listener: (params: unknown) => void): () => void =>
		(client.on as unknown as (event: string, listener: (params: unknown) => void) => () => void).call(
			client,
			event,
			listener,
		);
	let complete!: () => void;
	const completed = new Promise<void>((resolve) => complete = resolve);
	const offData = on('Tracing.dataCollected', (params) => {
		const value = (params as { value?: unknown }).value;
		if (Array.isArray(value)) events.push(...value);
	});
	const offDone = on('Tracing.tracingComplete', () => complete());
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await client.sendRaw('Tracing.start', {
			traceConfig: {
				includedCategories: ['disabled-by-default-memory-infra'],
				excludedCategories: ['*'],
				memoryDumpConfig: { triggers: [] },
			},
			transferMode: 'ReportEvents',
		});
		try {
			const dump = await client.sendRaw<{ success?: boolean }>('Tracing.requestMemoryDump', {
				deterministic: false,
				levelOfDetail: 'background',
			});
			if (dump?.success === false) return null;
		} finally {
			await client.sendRaw('Tracing.end').catch(() => {});
		}
		const finished = await Promise.race([
			completed.then(() => true),
			new Promise<boolean>((resolve) => timer = setTimeout(() => resolve(false), timeoutMs)),
		]);
		return finished ? footprintOf(events) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		offData();
		offDone();
	}
}

/** Per-session figures, each dumped at most once per {@linkcode BROWSER_MEMORY_TTL_MS}, one dump in flight per session. */
export class BrowserMemoryCache {
	readonly #entries = new Map<string, { at: number; value: BrowserMemory | null }>();
	readonly #inFlight = new Map<string, Promise<BrowserMemory | null>>();

	constructor(
		private readonly dump: (client: DumpClient) => Promise<BrowserMemory | null> = dumpBrowser,
		private readonly now: () => number = Date.now,
	) {}

	/** The session's figure: cached while fresh, else a new dump awaited for at most `waitMs`, else the last one. */
	async get(
		sessionId: string,
		client: DumpClient | null,
		waitMs = BROWSER_MEMORY_WAIT_MS,
	): Promise<BrowserMemory | null> {
		const cached = this.#entries.get(sessionId);
		if (client === null) return cached?.value ?? null;
		if (cached !== undefined && this.now() - cached.at < BROWSER_MEMORY_TTL_MS) return cached.value;
		let pending = this.#inFlight.get(sessionId);
		if (pending === undefined) {
			pending = this.dump(client).catch(() => null).then((value) => {
				this.#entries.set(sessionId, { at: this.now(), value });
				return value;
			}).finally(() => this.#inFlight.delete(sessionId));
			this.#inFlight.set(sessionId, pending);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<undefined>((resolve) => timer = setTimeout(() => resolve(undefined), waitMs));
		const value = await Promise.race([pending, late]);
		clearTimeout(timer);
		return value === undefined ? cached?.value ?? null : value;
	}

	/** Forgets every session not in `live` (closed ones). */
	retain(live: ReadonlySet<string>): void {
		for (const id of this.#entries.keys()) if (!live.has(id)) this.#entries.delete(id);
	}
}

/** The gateway process: resident memory and its JavaScript heap against the limit V8 was started with. */
export function gatewayMemory(): {
	rss_bytes: number;
	heap_used_bytes: number;
	heap_total_bytes: number;
	heap_limit_bytes: number;
} {
	const usage = Deno.memoryUsage();
	return {
		rss_bytes: usage.rss,
		heap_used_bytes: usage.heapUsed,
		heap_total_bytes: usage.heapTotal,
		heap_limit_bytes: getHeapStatistics().heap_size_limit,
	};
}

/** A size as `TTK_MEMORY_LIMIT` and Compose's `mem_limit` write it (`1536m`, `1.5g`, `1610612736`), in bytes. */
export function parseMemorySize(text: string): number | null {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)i?b?\s*$/i.exec(text);
	if (match === null) return null;
	const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]!.toLowerCase() as '' | 'k' | 'm' | 'g'];
	const bytes = Math.round(Number(match[1]) * unit);
	return bytes > 0 ? bytes : null;
}
