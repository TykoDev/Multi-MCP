/**
 * @module
 * `HarRecordingWatchdog` ○ — HTTP Archive capture (ARCHITECTURE.md §6.13).
 *
 * > **conditional: `recordHarPath`** — captures `Network.*` request/response/timing events (+ bodies
 * > when `recordHarContent='embed'`) and writes HAR 1.2 JSON on stop.
 *
 * The output conforms to the HAR 1.2 object model: `log{version,creator,pages,entries}`, each entry
 * `{startedDateTime,time,request,response,cache,timings}`, each request
 * `{method,url,httpVersion,cookies,headers,queryString,headersSize,bodySize}`, each response
 * `{status,statusText,httpVersion,cookies,headers,content,redirectURL,headersSize,bodySize}`, each
 * content `{size,mimeType}`. `har_recording_test.ts` validates a produced document against exactly
 * that required-key set rather than eyeballing one field, and pins the HAR invariant
 * `entry.time === Σ(non-negative timings)`.
 *
 * ## Timings (why `wait` absorbs the unknown case)
 *
 * `Network.ResourceTiming` is relative to `requestTime` and is absent for cached and failed requests.
 * HAR marks `blocked`/`dns`/`connect`/`ssl` optional (`-1` = "does not apply") but requires
 * `send`/`wait`/`receive`, and requires `time` to be the sum of the non-negative phases. When Chrome
 * gave us no timing breakdown the whole measured duration is therefore attributed to `wait`: the sum
 * invariant holds *and* the duration survives, where zeroing everything would silently report
 * every cached request as instantaneous.
 *
 * ## The two mode fields the spec leaves undefined (ERRATUM(M1-watchdogs-rest-10))
 *
 * DATA-MODEL.md §5.2 lists `recordHarContent: 'embed'|'attach'|'omit'` and
 * `recordHarMode: 'full'|'minimal'` with defaults and no semantics. Implemented as:
 *
 * - `content` — `embed`: body inline in `content.text` (`encoding:'base64'` for binary);
 *   `attach`: body written to `<harPath>.content/<requestId>.<ext>` and referenced from the custom
 *   `content._file` field (an `_`-prefixed key is the HAR-sanctioned extension point);
 *   `omit`: no `Network.getResponseBody` call at all.
 * - `mode` — `minimal` drops everything that is not needed to identify or replay a request: cookies,
 *   post data and response bodies (no body fetch regardless of `recordHarContent`). Headers and
 *   timings stay: they are already in hand and cost nothing, and a HAR without them is not usefully
 *   a HAR.
 */

import { decodeBase64 } from '@std/encoding/base64';
import { dirname, join } from '@std/path';
import type { HandlerContext } from '@tykotech/bus';
import type { CdpClient, CdpEventParams, SessionId } from '@tykotech/cdp';
import { BrowserConnectedEvent, BrowserStopEvent } from '../events.ts';
import type { BrowserProfile, RecordHarContent, RecordHarMode } from '../types.ts';
import { withTimeout } from '../browser/reconnect.ts';
import { type HandlerBudget, handlerBudget } from './handler_budget.ts';
import { BaseWatchdog, type WatchdogHost } from './base.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The only HAR version this writer emits. */
export const HAR_VERSION = '1.2';

/** `log.creator.name`. */
export const HAR_CREATOR_NAME = 'bua';

/** `log.creator.version` — kept equal to `packages/core/deno.json`'s `version` by the contract test. */
// ERRATUM(E-44). Moved with the nine-file 0.2.0 bump (G-9, B1.13). It appears in
// the `creator.version` field of every emitted HAR, and `har_recording_test.ts`
// already required it to track the package version.
export const HAR_CREATOR_VERSION = '0.2.0';

/** The single synthetic page every entry references. */
export const HAR_PAGE_ID = 'page_1';

/** Suffix of the sibling directory `recordHarContent: 'attach'` writes bodies into. */
export const HAR_CONTENT_DIR_SUFFIX = '.content';

/** `-1` is HAR's "this value is not available" marker. */
export const HAR_UNKNOWN = -1;

/**
 * Cap on one `Network.getResponseBody` call.
 *
 * ERRATUM(M1-watchdogs-rest-12): §6.13 states the body capture with no budget, and an entry is only
 * complete once its body fetch settles. Without a cap, one slow body defers that entry behind the
 * 60 s CDP request timeout — and if `BrowserStopEvent` arrives first the entry is lost from the HAR
 * entirely. Observed as a flaky "the stylesheet is missing" under load before the cap existed. A
 * capped fetch degrades the entry to "no body", which is what `recordHarContent: 'omit'` produces
 * anyway; an uncapped one degrades the whole document.
 */
export const HAR_BODY_TIMEOUT_MS = 5_000;

/** The conditional-attachment predicate (ARCHITECTURE.md §6.13). */
export function shouldAttachHarRecordingWatchdog(profile: Pick<BrowserProfile, 'recordHarPath'>): boolean {
	return profile.recordHarPath !== null;
}

// ---------------------------------------------------------------------------
// HAR 1.2 object model (only the members this writer emits)
// ---------------------------------------------------------------------------

/** `{name, value}` — HAR's shape for headers, cookies and query-string parameters. */
export interface HarNameValue {
	readonly name: string;
	readonly value: string;
}

export interface HarPostData {
	readonly mimeType: string;
	readonly text: string;
	readonly params: readonly HarNameValue[];
}

export interface HarRequest {
	readonly method: string;
	readonly url: string;
	readonly httpVersion: string;
	readonly cookies: readonly HarNameValue[];
	readonly headers: readonly HarNameValue[];
	readonly queryString: readonly HarNameValue[];
	readonly postData?: HarPostData;
	readonly headersSize: number;
	readonly bodySize: number;
}

export interface HarContent {
	readonly size: number;
	readonly mimeType: string;
	readonly text?: string;
	readonly encoding?: string;
	/** `recordHarContent: 'attach'` — path of the sidecar body file, relative to the HAR. */
	readonly _file?: string;
}

export interface HarResponse {
	readonly status: number;
	readonly statusText: string;
	readonly httpVersion: string;
	readonly cookies: readonly HarNameValue[];
	readonly headers: readonly HarNameValue[];
	readonly content: HarContent;
	readonly redirectURL: string;
	readonly headersSize: number;
	readonly bodySize: number;
}

export interface HarTimings {
	readonly blocked: number;
	readonly dns: number;
	readonly connect: number;
	readonly send: number;
	readonly wait: number;
	readonly receive: number;
	readonly ssl: number;
}

export interface HarEntry {
	readonly pageref?: string;
	readonly startedDateTime: string;
	readonly time: number;
	readonly request: HarRequest;
	readonly response: HarResponse;
	readonly cache: Record<string, unknown>;
	readonly timings: HarTimings;
	readonly serverIPAddress?: string;
	readonly connection?: string;
	/** Chrome's resource type — an `_`-prefixed HAR extension, as every browser exporter emits. */
	readonly _resourceType?: string;
	/** Present when the request failed; HAR has no standard field for it. */
	readonly _errorText?: string;
}

export interface HarPage {
	readonly startedDateTime: string;
	readonly id: string;
	readonly title: string;
	readonly pageTimings: { readonly onContentLoad: number; readonly onLoad: number };
}

export interface HarLog {
	readonly version: string;
	readonly creator: { readonly name: string; readonly version: string };
	readonly pages: readonly HarPage[];
	readonly entries: readonly HarEntry[];
}

/** The whole document. */
export interface HarDocument {
	readonly log: HarLog;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** CDP's `Headers` record → HAR's ordered name/value list. */
export function toHarHeaders(headers: Record<string, string> | undefined): HarNameValue[] {
	if (headers === undefined) return [];
	return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

/** `?a=1&b=2` → `[{name:'a',value:'1'},{name:'b',value:'2'}]`. Unparseable URLs yield `[]`. */
export function toHarQueryString(url: string): HarNameValue[] {
	const parsed = URL.parse(url);
	if (parsed === null) return [];
	return [...parsed.searchParams].map(([name, value]) => ({ name, value }));
}

/** `Cookie: a=1; b=2` → HAR cookies. Only name/value; CDP does not give us the rest here. */
export function parseRequestCookies(headers: Record<string, string> | undefined): HarNameValue[] {
	const raw = _headerValue(headers, 'cookie');
	if (raw === null) return [];
	const cookies: HarNameValue[] = [];
	for (const part of raw.split(';')) {
		const index = part.indexOf('=');
		if (index <= 0) continue;
		cookies.push({ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() });
	}
	return cookies;
}

/** `Set-Cookie: a=1; Path=/` → HAR cookies (the attribute segments are dropped). */
export function parseResponseCookies(headers: Record<string, string> | undefined): HarNameValue[] {
	const raw = _headerValue(headers, 'set-cookie');
	if (raw === null) return [];
	const cookies: HarNameValue[] = [];
	for (const line of raw.split('\n')) {
		const first = line.split(';')[0] ?? '';
		const index = first.indexOf('=');
		if (index <= 0) continue;
		cookies.push({ name: first.slice(0, index).trim(), value: first.slice(index + 1).trim() });
	}
	return cookies;
}

/**
 * Timings from `Network.ResourceTiming` (ms, relative to `requestTime`), with the whole measured
 * duration falling into `wait` when Chrome reported no breakdown. See the module note.
 */
export function toHarTimings(
	timing: CdpEventParams['Network.responseReceived']['response']['timing'] | undefined,
	totalMs: number,
): HarTimings {
	if (timing === undefined) {
		return {
			blocked: HAR_UNKNOWN,
			dns: HAR_UNKNOWN,
			connect: HAR_UNKNOWN,
			send: 0,
			wait: Math.max(0, totalMs),
			receive: 0,
			ssl: HAR_UNKNOWN,
		};
	}
	const span = (
		start: number,
		end: number,
	): number => (start < 0 || end < 0 || end < start ? HAR_UNKNOWN : end - start);
	const headersEnd = timing.receiveHeadersEnd;
	const dns = span(timing.dnsStart, timing.dnsEnd);
	const connect = span(timing.connectStart, timing.connectEnd);
	const ssl = span(timing.sslStart, timing.sslEnd);
	const send = Math.max(0, span(timing.sendStart, timing.sendEnd));
	const wait = Math.max(0, span(timing.sendEnd, headersEnd));
	const blocked = timing.sendStart < 0 ? HAR_UNKNOWN : Math.max(0, timing.sendStart - Math.max(0, timing.proxyEnd));
	const accounted = [blocked, dns, connect, send, wait].reduce((sum, value) => sum + Math.max(0, value), 0);
	const receive = Math.max(0, totalMs - accounted);
	return { blocked, dns, connect, send, wait, receive, ssl };
}

/** HAR requires `time` to be the sum of the phases that apply. */
export function harEntryTime(timings: HarTimings): number {
	return [timings.blocked, timings.dns, timings.connect, timings.send, timings.wait, timings.receive, timings.ssl]
		.filter((value) => value >= 0)
		.reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// in-flight record
// ---------------------------------------------------------------------------

interface PendingEntry {
	readonly requestId: string;
	readonly sessionId: SessionId | undefined;
	readonly startedAt: number;
	readonly startedDateTime: string;
	request: CdpEventParams['Network.requestWillBeSent']['request'];
	resourceType: string;
	response: CdpEventParams['Network.responseReceived']['response'] | null;
	fromCache: boolean;
	receivedBytes: number;
	decodedBytes: number;
	errorText: string | null;
}

/** Injection seams; every default is the real implementation. */
export interface HarRecordingWatchdogOptions {
	/** Overrides the profile's `recordHarPath`. */
	readonly path?: string | undefined;
	/** Injected clock, so entry durations are drivable by `FakeTime`. */
	readonly now?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class HarRecordingWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [BrowserConnectedEvent, BrowserStopEvent];
	static override readonly EMITS = [];

	readonly #options: HarRecordingWatchdogOptions;
	readonly #now: () => number;
	readonly #pending = new Map<string, PendingEntry>();
	readonly #entries: HarEntry[] = [];
	readonly #bodies = new Map<string, { body: string; base64Encoded: boolean }>();
	readonly #inflight = new Set<Promise<unknown>>();
	#unsubscribes: (() => void)[] = [];
	#armedClient: CdpClient | null = null;

	constructor(host: WatchdogHost, options: HarRecordingWatchdogOptions = {}) {
		super(host);
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	// -- public surface ----------------------------------------------------------------------------

	/** Where the HAR will be written, or `null` when unconfigured (the watchdog is then inert). */
	get path(): string | null {
		return this.#options.path ?? this.profile.recordHarPath;
	}

	get mode(): RecordHarMode {
		return this.profile.recordHarMode;
	}

	get content(): RecordHarContent {
		return this.mode === 'minimal' ? 'omit' : this.profile.recordHarContent;
	}

	/** `true` while the `Network.*` listeners are registered. */
	get armed(): boolean {
		return this.#unsubscribes.length > 0;
	}

	/** Completed entries so far. */
	get entries(): readonly HarEntry[] {
		return this.#entries;
	}

	/** Requests still in flight. */
	get pendingCount(): number {
		return this.#pending.size;
	}

	/**
	 * Resolves when every in-flight body fetch has settled. Tests await this, never a sleep.
	 *
	 * ERRATUM(CANCEL-3): this drain is the part of the stop handler that can outlast its budget, and it
	 * is worth stating the arithmetic because it is not close. Each body fetch is capped at
	 * {@linkcode HAR_BODY_TIMEOUT_MS} (5 s), the listeners are still armed while draining so newly
	 * finished requests keep joining `#inflight`, and the guard allows 10 rounds — up to 50 s against
	 * `BrowserStopEvent`'s 45 s. The budget is consulted **between rounds**, which is the honest place:
	 * the fetches inside a round are already running and already capped, and abandoning the round would
	 * not cancel them.
	 *
	 * `budget` defaults to unbudgeted so a direct call keeps the old behaviour.
	 */
	async whenIdle(budget: HandlerBudget = handlerBudget(undefined)): Promise<void> {
		for (let guard = 0; guard < 10 && this.#inflight.size > 0; guard++) {
			if (budget.expired()) return;
			await Promise.allSettled([...this.#inflight]);
		}
	}

	// -- handlers ----------------------------------------------------------------------------------

	onBrowserConnectedEvent(_event: BrowserConnectedEvent, _context?: HandlerContext): void {
		if (this.path === null) return;
		this.arm();
	}

	/**
	 * Writes the HAR. Registered before `BrowserSession`'s own stop handler (E-16), so the body
	 * fetches this awaits still have a socket.
	 *
	 * ERRATUM(CANCEL-3): the deliberate asymmetry, and it is the **opposite** of the one
	 * ERRATUM(CANCEL-2) chose for the storage state. There, the write is skipped when the budget is
	 * spent, because a good file already exists on disk and a partial overwrite would destroy it. Here
	 * nothing exists yet: `recordHarPath` is a location the caller named and the document is the
	 * watchdog's entire deliverable, so skipping the write means the user asked for a HAR and silently
	 * received nothing. The drain is what gets abandoned — it is the unbounded part — and the write is
	 * one small `Deno.writeTextFile` over a fresh path that can corrupt nothing, which is the same
	 * trade `launched.close()` gets in ERRATUM(KILL-1).
	 */
	async onBrowserStopEvent(_event: BrowserStopEvent, context?: HandlerContext): Promise<void> {
		if (this.path === null) return;
		const budget = handlerBudget(context);
		await this.whenIdle(budget);
		// Never conditional: listeners that outlive the stop are a leak whatever the budget says.
		this.disarm();
		if (this.#inflight.size > 0) {
			this.logger.warn('response bodies were still in flight when the HAR was written', {
				path: this.path,
				outstanding: this.#inflight.size,
				hint: 'their entries carry metadata without a body',
			});
		}
		try {
			await this.write();
		} catch (error) {
			this.logger.error('could not write the HAR file', { path: this.path, error });
		}
	}

	protected override beforeDetach(): void {
		this.disarm();
	}

	// -- arming ------------------------------------------------------------------------------------

	arm(): void {
		const client = this.host.cdpClient;
		if (client === null || client.state !== 'open') return;
		if (this.#armedClient === client && this.armed) return;
		this.disarm();
		this.#armedClient = client;
		this.#unsubscribes = [
			client.on('Network.requestWillBeSent', (params, sessionId) => this.#onRequest(params, sessionId)),
			client.on('Network.responseReceived', (params) => this.#onResponse(params)),
			client.on('Network.dataReceived', (params) => this.#onData(params)),
			client.on('Network.requestServedFromCache', (params) => this.#onServedFromCache(params.requestId)),
			client.on('Network.loadingFinished', (params) => this.#onFinished(params)),
			client.on('Network.loadingFailed', (params) => this.#onFailed(params)),
		];
	}

	disarm(): void {
		for (const off of this.#unsubscribes) off();
		this.#unsubscribes = [];
		this.#armedClient = null;
	}

	// -- document assembly -------------------------------------------------------------------------

	/** The HAR 1.2 document for everything captured so far. Pure: it writes nothing. */
	buildDocument(): HarDocument {
		const first = this.#entries[0];
		const pages: HarPage[] = first === undefined ? [] : [{
			startedDateTime: first.startedDateTime,
			id: HAR_PAGE_ID,
			title: first.request.url,
			pageTimings: { onContentLoad: HAR_UNKNOWN, onLoad: HAR_UNKNOWN },
		}];
		return {
			log: {
				version: HAR_VERSION,
				creator: { name: HAR_CREATOR_NAME, version: HAR_CREATOR_VERSION },
				pages,
				entries: this.#entries.map((entry) => (pages.length === 0 ? entry : { ...entry, pageref: HAR_PAGE_ID })),
			},
		};
	}

	/** Writes the document to {@linkcode path}, creating the directory and any body sidecars. */
	async write(): Promise<string | null> {
		const path = this.path;
		if (path === null) return null;
		await Deno.mkdir(dirname(path), { recursive: true });
		const document = this.buildDocument();
		await Deno.writeTextFile(path, `${JSON.stringify(document, null, '\t')}\n`);
		this.logger.debug('HAR written', { path, entries: document.log.entries.length });
		return path;
	}

	// -- CDP handlers ------------------------------------------------------------------------------

	#onRequest(params: CdpEventParams['Network.requestWillBeSent'], sessionId: SessionId | undefined): void {
		// A redirect reuses the requestId: close the previous hop as its own entry first.
		const previous = this.#pending.get(params.requestId);
		if (previous !== undefined && params.redirectResponse !== undefined) {
			previous.response = params.redirectResponse;
			this.#complete(previous);
		}
		this.#pending.set(params.requestId, {
			requestId: params.requestId,
			sessionId,
			startedAt: this.#now(),
			startedDateTime: new Date(this.#now()).toISOString(),
			request: params.request,
			resourceType: params.type ?? 'Other',
			response: null,
			fromCache: false,
			receivedBytes: 0,
			decodedBytes: 0,
			errorText: null,
		});
	}

	#onResponse(params: CdpEventParams['Network.responseReceived']): void {
		const entry = this.#pending.get(params.requestId);
		if (entry === undefined) return;
		entry.response = params.response;
		entry.resourceType = params.type;
	}

	#onData(params: CdpEventParams['Network.dataReceived']): void {
		const entry = this.#pending.get(params.requestId);
		if (entry === undefined) return;
		entry.receivedBytes += params.encodedDataLength;
		entry.decodedBytes += params.dataLength;
	}

	#onServedFromCache(requestId: string): void {
		const entry = this.#pending.get(requestId);
		if (entry !== undefined) entry.fromCache = true;
	}

	#onFinished(params: CdpEventParams['Network.loadingFinished']): void {
		const entry = this.#pending.get(params.requestId);
		if (entry === undefined) return;
		if (params.encodedDataLength > 0) entry.receivedBytes = params.encodedDataLength;
		if (this.content === 'omit') {
			this.#complete(entry);
			return;
		}
		this.#track(this.#captureBody(entry));
	}

	#onFailed(params: CdpEventParams['Network.loadingFailed']): void {
		const entry = this.#pending.get(params.requestId);
		if (entry === undefined) return;
		entry.errorText = params.errorText;
		this.#complete(entry);
	}

	// -- bodies ------------------------------------------------------------------------------------

	async #captureBody(entry: PendingEntry): Promise<void> {
		try {
			// Mapped to a non-rejecting promise before the race: `withTimeout` leaves the loser running,
			// and a CDP call rejecting after its cap expired would be an unhandled rejection.
			// Bare `this.cdp` on purpose (ERRATUM(E-52) allowlist): body capture runs from the
			// `Network.loadingFinished` listener, which has no dispatch and no context to bind. Its bound is
			// `HAR_BODY_TIMEOUT_MS` below, and `disarm()` drops the listener.
			const call = this.cdp.send.Network.getResponseBody({ requestId: entry.requestId }, entry.sessionId)
				.then((body) => body, () => null);
			const outcome = await withTimeout(call, HAR_BODY_TIMEOUT_MS);
			const body = outcome.timedOut ? null : outcome.value ?? null;
			if (body !== null) this.#bodies.set(entry.requestId, { body: body.body, base64Encoded: body.base64Encoded });
			else if (outcome.timedOut) {
				this.logger.debug('response body fetch exceeded its cap; the entry keeps its metadata', {
					requestId: entry.requestId,
					capMs: HAR_BODY_TIMEOUT_MS,
				});
			}
		} catch (error) {
			// Bodies expire with the renderer's resource cache; a miss is normal, not a failure.
			this.logger.debug('response body unavailable for the HAR', { requestId: entry.requestId, error });
		} finally {
			this.#complete(entry);
		}
	}

	// -- entry finalization ------------------------------------------------------------------------

	#complete(entry: PendingEntry): void {
		this.#pending.delete(entry.requestId);
		const response = entry.response;
		const minimal = this.mode === 'minimal';
		const totalMs = Math.max(0, this.#now() - entry.startedAt);
		const timings = toHarTimings(response?.timing, totalMs);
		const body = this.#bodies.get(entry.requestId) ?? null;
		this.#bodies.delete(entry.requestId);

		const request: HarRequest = {
			method: entry.request.method,
			url: entry.request.url,
			httpVersion: _httpVersion(response?.protocol),
			cookies: minimal ? [] : parseRequestCookies(entry.request.headers),
			headers: toHarHeaders(entry.request.headers),
			queryString: toHarQueryString(entry.request.url),
			...(minimal || entry.request.postData === undefined ? {} : {
				postData: {
					mimeType: _headerValue(entry.request.headers, 'content-type') ?? '',
					text: entry.request.postData,
					params: [],
				},
			}),
			headersSize: HAR_UNKNOWN,
			bodySize: entry.request.postData === undefined ? 0 : entry.request.postData.length,
		};

		const content: HarContent = {
			size: entry.decodedBytes > 0 ? entry.decodedBytes : (body === null ? 0 : body.body.length),
			mimeType: response?.mimeType ?? '',
			...(body === null || this.content !== 'embed'
				? {}
				: { text: body.body, ...(body.base64Encoded ? { encoding: 'base64' } : {}) }),
			...(body === null || this.content !== 'attach' ? {} : { _file: this.#sidecarName(entry.requestId) }),
		};

		const harResponse: HarResponse = {
			status: response?.status ?? 0,
			statusText: response?.statusText ?? '',
			httpVersion: _httpVersion(response?.protocol),
			cookies: minimal || response === undefined ? [] : parseResponseCookies(response?.headers),
			headers: toHarHeaders(response?.headers),
			content,
			redirectURL: _headerValue(response?.headers, 'location') ?? '',
			headersSize: HAR_UNKNOWN,
			bodySize: entry.receivedBytes,
		};

		this.#entries.push({
			startedDateTime: entry.startedDateTime,
			time: harEntryTime(timings),
			request,
			response: harResponse,
			cache: entry.fromCache ? { beforeRequest: null, afterRequest: null } : {},
			timings,
			...(response?.remoteIPAddress === undefined ? {} : { serverIPAddress: response.remoteIPAddress }),
			...(response?.connectionId === undefined ? {} : { connection: String(response.connectionId) }),
			_resourceType: entry.resourceType,
			...(entry.errorText === null ? {} : { _errorText: entry.errorText }),
		});

		if (body !== null && this.content === 'attach') this.#track(this.#writeSidecar(entry.requestId, body));
	}

	#sidecarName(requestId: string): string {
		return `${requestId.replaceAll(/[^A-Za-z0-9._-]/g, '_')}.bin`;
	}

	async #writeSidecar(requestId: string, body: { body: string; base64Encoded: boolean }): Promise<void> {
		const path = this.path;
		if (path === null) return;
		const directory = `${path}${HAR_CONTENT_DIR_SUFFIX}`;
		await Deno.mkdir(directory, { recursive: true });
		const target = join(directory, this.#sidecarName(requestId));
		if (body.base64Encoded) {
			await Deno.writeFile(target, decodeBase64(body.body));
			return;
		}
		await Deno.writeTextFile(target, body.body);
	}

	#track(promise: Promise<unknown>): void {
		this.#inflight.add(promise);
		promise
			.then(() => {}, (error: unknown) => this.logger.debug('HAR background task failed', { error }))
			.finally(() => this.#inflight.delete(promise));
	}
}

// ---------------------------------------------------------------------------
// module helpers
// ---------------------------------------------------------------------------

function _headerValue(headers: Record<string, string> | undefined, name: string): string | null {
	if (headers === undefined) return null;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return String(value);
	}
	return null;
}

/** CDP's `protocol` (`h2`, `http/1.1`) → HAR's `httpVersion`. Unknown protocols pass through. */
function _httpVersion(protocol: string | undefined): string {
	if (protocol === undefined || protocol === '') return 'HTTP/1.1';
	if (protocol === 'h2') return 'HTTP/2.0';
	if (protocol === 'h3') return 'HTTP/3.0';
	return protocol.toUpperCase().startsWith('HTTP') ? protocol.toUpperCase() : protocol;
}
