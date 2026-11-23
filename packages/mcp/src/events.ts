/**
 * The per-session event ring; the SSE route, the live-view socket and `browser_wait_for` are three views of it.
 *
 * Bounded by entries (512) and by bytes per event (1 KiB, truncated, never dropped) and per session (256 KiB), since
 * page-controlled text would otherwise choose the multiplicand. Every entry is replayable to any `mcp:invoke` holder,
 * so payloads are redacted at mint: no `url` on `download.*`, no query on `navigation`, never a value, length or prefix
 * on `input`, no element record anywhere. `seq` counts the unfiltered stream, so a filtered view is non-contiguous
 * without a gap; loss is signalled only by a leading `gap` record.
 */
import { ulid } from '@std/ulid';
import {
	type ControlEvent,
	EVENT_RECORD_KINDS,
	type EventKind,
	type EventRecord,
	type EventRecordKind,
} from '@tykotech/wire';

/** Entries retained per session before the oldest is evicted. */
export const RING_CAPACITY = 512;

/** Serialized bytes one record may occupy. Over-length records are shrunk, never dropped. */
export const MAX_EVENT_BYTES = 1024;

/** Serialized bytes one session's ring may occupy. Binds before {@linkcode RING_CAPACITY}. */
export const MAX_RING_BYTES = 256 * 1024;

/** The emission rate cap for content-bearing kinds, per session. */
export const CONTENT_RATE_PER_SECOND = 50;

/** The budget for the structural kinds. */
export const STRUCTURAL_RATE_PER_SECOND = 250;

/** The window the rate cap is measured over. */
export const RATE_WINDOW_MS = 1000;

/** Evicted records whose **kind** is still remembered, so a `gap` can attribute the loss it reports. */
const EVICTION_LEDGER_CAPACITY = RING_CAPACITY * 8;

/** The kinds a page can spin cheaply, held to the tighter budget. */
const CONTENT_KINDS: ReadonlySet<string> = new Set<string>(['console', 'input', 'dom.settled', 'focus']);

/** The kinds no cap applies to. */
const UNCAPPED_KINDS: ReadonlySet<string> = new Set<string>(['control', 'gap', 'bye']);

/** The budget for one kind in one window. */
function budgetFor(kind: string): number {
	return CONTENT_KINDS.has(kind) ? CONTENT_RATE_PER_SECOND : STRUCTURAL_RATE_PER_SECOND;
}

/** A kind's position in `EVENT_RECORD_KINDS`, which is what the eviction ledger stores. */
const KIND_INDEX: ReadonlyMap<string, number> = new Map(EVENT_RECORD_KINDS.map((kind, index) => [kind, index]));
const UNKNOWN_KIND_INDEX = 0xff;

/** Per-field character caps. */
const PAYLOAD_CAPS: Readonly<Partial<Record<EventRecordKind, Readonly<Record<string, number>>>>> = {
	navigation: { origin: 256, path: 256 },
	// `label` is 121 rather than 120 because `labelOf` appends an ellipsis to a 120-character slice, so a capped
	// label is 121 characters by construction; a cap of 120 would re-truncate every long label, drop the ellipsis,
	// and set a spurious `truncated` flag on a record that was already correctly bounded.
	focus: { label: 121, tag: 32, role: 64 },
	'download.started': { filename: 255 },
	'download.done': { filename: 255 },
	'download.failed': { filename: 255 },
	dialog: { message: 512 },
	console: { text: 512 },
	control: { holder_name: 64, principal: 64, kind: 64 },
};

/** The one field per kind the byte cap may shrink at. */
const SHRINK_FIELD: Readonly<Partial<Record<EventRecordKind, string>>> = {
	navigation: 'path',
	focus: 'label',
	'download.started': 'filename',
	'download.done': 'filename',
	'download.failed': 'filename',
	dialog: 'message',
	console: 'text',
	control: 'holder_name',
};

const ENCODER = new TextEncoder();

/** Serialized length of one record, which is what both byte bounds are measured in. */
function byteLengthOf(record: EventRecord): number {
	return ENCODER.encode(JSON.stringify(record)).length;
}

/** Caps every field this kind declares a character limit for. Pure; returns a new payload. */
function capFields(kind: EventRecordKind, payload: Record<string, unknown>): Record<string, unknown> {
	const caps = PAYLOAD_CAPS[kind];
	if (caps === undefined) return payload;
	let out = payload;
	for (const [field, limit] of Object.entries(caps)) {
		const value = out[field];
		if (typeof value !== 'string' || value.length <= limit) continue;
		out = { ...out, [field]: value.slice(0, limit), truncated: true };
	}
	return out;
}

/** Halves one string field of a payload, flagging the record as truncated. */
function halveField(record: EventRecord, field: string, text: string): EventRecord {
	return {
		...record,
		payload: { ...record.payload, [field]: text.slice(0, Math.floor(text.length / 2)), truncated: true },
	};
}

/** Shrinks one record to {@linkcode MAX_EVENT_BYTES}, preferring its single named variable-length field. */
function fitToByteCap(record: EventRecord): { record: EventRecord; bytes: number } {
	let bytes = byteLengthOf(record);
	if (bytes <= MAX_EVENT_BYTES) return { record, bytes };
	let current = record;
	const named = SHRINK_FIELD[record.kind];
	if (named !== undefined) {
		let text = current.payload[named];
		while (bytes > MAX_EVENT_BYTES && typeof text === 'string' && text.length > 0) {
			current = halveField(current, named, text);
			text = current.payload[named];
			bytes = byteLengthOf(current);
		}
	}
	// Whatever is still oversized, longest first, regardless of which kind declared it.
	while (bytes > MAX_EVENT_BYTES) {
		let longest: string | undefined;
		let longestLength = 0;
		for (const [field, value] of Object.entries(current.payload)) {
			if (typeof value === 'string' && value.length > longestLength) {
				longest = field;
				longestLength = value.length;
			}
		}
		if (longest !== undefined && longestLength > 0) {
			current = halveField(current, longest, current.payload[longest] as string);
			bytes = byteLengthOf(current);
			continue;
		}
		// No string left to shrink and still over cap: the bloat is a nested object or array, which is exactly the "a
		// refactor widened a payload" case this pass exists for.
		const primitives: Record<string, unknown> = { truncated: true };
		let dropped = false;
		for (const [field, value] of Object.entries(current.payload)) {
			if (value === null || typeof value !== 'object') primitives[field] = value;
			else dropped = true;
		}
		if (dropped) {
			current = { ...current, payload: primitives };
			bytes = byteLengthOf(current);
			continue;
		}
		// Nothing left to shrink and still over cap: the bulk is in the field *names*, which no shrink touches.
		current = { ...current, payload: { truncated: true } };
		bytes = byteLengthOf(current);
		break;
	}
	return { record: current, bytes };
}

/** What the ring retains: the record plus the byte figure the session bound is kept against. */
interface RingEntry {
	readonly record: EventRecord;
	readonly bytes: number;
}

/** Construction-time knobs. Every one has a production default; tests inject the clock. */
interface SessionEventRingOptions {
	/** Injected clock, so the rate cap and `at` are deterministic under test. */
	readonly now?: () => number;
	readonly capacity?: number;
	readonly maxRingBytes?: number;
	/** Toggles `Runtime.enable` for the session when the `console` refcount crosses zero. */
	readonly setConsoleArmed?: (armed: boolean) => void;
	readonly logger?: { warn(msg: string): void };
}

/** A cursor as the client stores and returns it: `<epoch>:<seq>`, opaque. */
export function formatCursor(epoch: string, seq: number): string {
	return `${epoch}:${seq}`;
}

/** The three things a `since` value can mean. */
export type ParsedCursor =
	| { readonly kind: 'from-now' }
	| { readonly kind: 'cursor'; readonly epoch: string; readonly seq: number }
	| { readonly kind: 'epoch-mismatch' };

/** Parses a `?since=` value or `Last-Event-ID` header. */
export function parseCursor(raw: string | null | undefined): ParsedCursor {
	if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'from-now' };
	const at = raw.lastIndexOf(':');
	if (at <= 0) return { kind: 'epoch-mismatch' };
	const epoch = raw.slice(0, at);
	const tail = raw.slice(at + 1);
	// Decimal digits only: bare `Number` would accept `0x10` as 16, ` 12` as 12 and the empty string as 0, so a
	// malformed cursor would silently become a plausible one instead of the epoch mismatch it is.
	if (!/^\d+$/.test(tail)) return { kind: 'epoch-mismatch' };
	const seq = Number(tail);
	if (!Number.isSafeInteger(seq)) return { kind: 'epoch-mismatch' };
	return { kind: 'cursor', epoch, seq };
}

/** The per-session sequenced event ring. */
export class SessionEventRing {
	/** This incarnation's identity, minted at construction. */
	readonly epoch: string;
	readonly #now: () => number;
	readonly #capacity: number;
	readonly #maxRingBytes: number;
	#setConsoleArmed: ((armed: boolean) => void) | undefined;
	readonly #logger: SessionEventRingOptions['logger'];
	#entries: RingEntry[] = [];
	#bytes = 0;
	#seq = 0;
	readonly #waiters = new Set<() => void>();
	#windowStart = 0;
	readonly #windowCounts = new Map<string, number>();
	/** What the window before this one admitted, per kind. */
	readonly #previousCounts = new Map<string, number>();
	readonly #windowDropped = new Map<string, number>();
	/** One byte per evicted record: its index in `EVENT_RECORD_KINDS`. Circular. */
	readonly #evictedKinds: Uint8Array;
	/** Records evicted since this epoch, which is also the highest evicted `seq`. */
	#evictedCount = 0;
	#consoleSubscribers = 0;
	#domSettledSubscribers = 0;
	/** Subscribers holding the `dialog` kind, and with it manual dialog handling. */
	#dialogSubscribers = 0;
	#setDialogArmed: ((armed: boolean) => void) | undefined;
	#closed = false;

	constructor(options: SessionEventRingOptions = {}) {
		this.epoch = ulid();
		this.#now = options.now ?? Date.now;
		this.#capacity = options.capacity ?? RING_CAPACITY;
		this.#maxRingBytes = options.maxRingBytes ?? MAX_RING_BYTES;
		this.#setConsoleArmed = options.setConsoleArmed;
		this.#logger = options.logger;
		this.#windowStart = this.#now();
		// Sized against the ring this instance actually holds, so a test that
		// shrinks `capacity` gets a proportionate ledger rather than the default's.
		this.#evictedKinds = new Uint8Array(
			Math.max(this.#capacity, Math.min(EVICTION_LEDGER_CAPACITY, this.#capacity * 8)),
		);
	}

	/** The highest `seq` allocated so far. `0` means nothing has been appended. */
	get highWaterMark(): number {
		return this.#seq;
	}

	/** The oldest retained `seq`, or `null` when the ring is empty. */
	get oldestSeq(): number | null {
		return this.#entries[0]?.record.seq ?? null;
	}

	/** Records retained right now. */
	get size(): number {
		return this.#entries.length;
	}

	/** Serialized bytes retained right now, which is the bound that binds first. */
	get bytes(): number {
		return this.#bytes;
	}

	/** Subscribers currently holding the `console` kind armed. */
	get consoleSubscribers(): number {
		return this.#consoleSubscribers;
	}

	/** Installs the `console` arm/disarm callback after construction. */
	setConsoleArmed(callback: (armed: boolean) => void): void {
		this.#setConsoleArmed = callback;
		if (this.#consoleSubscribers > 0) callback(true);
	}

	/** Subscribers currently holding the `dom.settled` kind armed. */
	get domSettledSubscribers(): number {
		return this.#domSettledSubscribers;
	}

	/** Claims the `dom.settled` kind for one subscriber. */
	armDomSettled(): void {
		this.#domSettledSubscribers += 1;
	}

	/** Releases one `dom.settled` claim. */
	disarmDomSettled(): void {
		if (this.#domSettledSubscribers > 0) this.#domSettledSubscribers -= 1;
	}

	/** Installs the manual-dialog arm/disarm callback after construction. */
	setDialogArmed(callback: (armed: boolean) => void): void {
		this.#setDialogArmed = callback;
		if (this.#dialogSubscribers > 0) callback(true);
	}

	/** Subscribers currently holding the `dialog` kind — and with it, manual dialog handling. */
	get dialogSubscribers(): number {
		return this.#dialogSubscribers;
	}

	/** Claims the `dialog` kind for one subscriber, arming manual handling on the transition from zero. */
	armDialog(): void {
		this.#dialogSubscribers += 1;
		if (this.#dialogSubscribers !== 1) return;
		try {
			this.#setDialogArmed?.(true);
		} catch (error) {
			this.#logger?.warn(`dialog arming failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.appendControl('dialog-manual-armed');
	}

	/** Releases one `dialog` claim, disarming on the transition to zero. */
	disarmDialog(): void {
		if (this.#dialogSubscribers === 0) return;
		this.#dialogSubscribers -= 1;
		if (this.#dialogSubscribers !== 0) return;
		try {
			this.#setDialogArmed?.(false);
		} catch (error) {
			this.#logger?.warn(`dialog disarming failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.appendControl('dialog-manual-disarmed');
	}

	/** The cursor a consumer starting from now should hold. */
	get cursor(): string {
		return formatCursor(this.epoch, this.#seq);
	}

	/** Mints one record and retains it, or returns `null` when the rate cap dropped it. */
	append(kind: EventRecordKind, payload: Record<string, unknown>, tabId: string | null = null): EventRecord | null {
		if (this.#closed) return null;
		const now = this.#now();
		this.#rollRateWindow(now);
		if (!UNCAPPED_KINDS.has(kind)) {
			// The sliding charge, not the current window's raw count: a fixed
			// window admits two full budgets across a boundary straddle.
			if (this.#chargeFor(kind, now) >= budgetFor(kind)) {
				this.#windowDropped.set(kind, (this.#windowDropped.get(kind) ?? 0) + 1);
				return null;
			}
			this.#windowCounts.set(kind, (this.#windowCounts.get(kind) ?? 0) + 1);
		}
		return this.#push(kind, payload, tabId, now);
	}

	/** Appends a `control` record. */
	appendControl(
		event: ControlEvent,
		extra: Record<string, unknown> = {},
		tabId: string | null = null,
	): EventRecord | null {
		return this.#push('control', { event, ...extra }, tabId, this.#now());
	}

	/**
	 * Records after `cursor`, oldest first, with a mandatory leading `gap` when the cursor has fallen off the tail or
	 * names another epoch.
	 */
	read(cursor: ParsedCursor, kinds?: ReadonlySet<EventKind>): EventRecord[] {
		this.#rollRateWindow(this.#now());
		if (cursor.kind === 'from-now') return [];
		const out: EventRecord[] = [];
		const oldest = this.oldestSeq;
		if (cursor.kind === 'epoch-mismatch' || cursor.epoch !== this.epoch) {
			out.push(this.#gap(Math.max(0, (oldest ?? this.#seq) - 1), null, null, null, 'epoch-changed'));
			for (const entry of this.#entries) out.push(entry.record);
			return kinds === undefined ? out : out.filter((r) => keepsKind(r, kinds));
		}
		const since = cursor.seq;
		if (oldest !== null && since + 1 < oldest) {
			out.push(this.#gap(oldest - 1, since + 1, oldest - 1, oldest - since - 1, 'ring-overrun'));
		}
		for (const entry of this.#entries) {
			if (entry.record.seq > since) out.push(entry.record);
		}
		return kinds === undefined ? out : out.filter((r) => keepsKind(r, kinds));
	}

	/** Resolves on the next append, on close, or after `timeoutMs`. */
	next(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#closed) return Promise.resolve();
		let settle: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		return new Promise<void>((resolve, reject) => {
			settle = resolve;
			this.#waiters.add(resolve);
			timer = setTimeout(resolve, timeoutMs);
			abort = (): void => reject(signal?.reason);
			signal?.addEventListener('abort', abort, { once: true });
		}).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
			if (settle !== undefined) this.#waiters.delete(settle);
			if (abort !== undefined) signal?.removeEventListener('abort', abort);
		});
	}

	/** Claims the `console` kind for one subscriber, arming `Runtime.enable` on the transition from zero. */
	armConsole(): void {
		this.#consoleSubscribers += 1;
		if (this.#consoleSubscribers !== 1) return;
		try {
			this.#setConsoleArmed?.(true);
		} catch (error) {
			this.#logger?.warn(`console arming failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.appendControl('console-armed');
	}

	/** Releases one `console` claim, disarming on the transition to zero. */
	disarmConsole(): void {
		if (this.#consoleSubscribers === 0) return;
		this.#consoleSubscribers -= 1;
		if (this.#consoleSubscribers !== 0) return;
		try {
			this.#setConsoleArmed?.(false);
		} catch (error) {
			this.#logger?.warn(`console disarming failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.appendControl('console-disarmed');
	}

	/** Stops accepting records and releases every waiter. Idempotent. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of [...this.#waiters]) waiter();
		this.#waiters.clear();
	}

	/** True once {@linkcode SessionEventRing.close} has run. */
	get closed(): boolean {
		return this.#closed;
	}

	#isoNow(): string {
		return new Date(this.#now()).toISOString();
	}

	/** Mints a gap record. */
	#gap(
		seq: number,
		from: number | null,
		to: number | null,
		dropped: number | null,
		reason: 'ring-overrun' | 'epoch-changed',
	): EventRecord {
		return {
			kind: 'gap',
			seq,
			at: this.#isoNow(),
			tab_id: null,
			// `by_kind` is what makes the loss **attributable** rather than merely reported: with it a consumer tells
			// "the page flooded `dialog`" from "you were away too long", and the two want different responses.
			payload: {
				reason,
				dropped_from: from,
				dropped_to: to,
				dropped,
				by_kind: from === null || to === null ? null : this.#attribute(from, to),
			},
		};
	}

	/** The per-kind breakdown of an evicted span, or `null` when it cannot be known exactly. */
	#attribute(from: number, to: number): Record<string, number> | null {
		if (to > this.#evictedCount || from < 1 || from > to) return null;
		const reach = this.#evictedKinds.length;
		const oldestRemembered = Math.max(1, this.#evictedCount - reach + 1);
		if (from < oldestRemembered) return null;
		const counts: Record<string, number> = {};
		for (let seq = from; seq <= to; seq += 1) {
			const index = this.#evictedKinds[(seq - 1) % reach] ?? UNKNOWN_KIND_INDEX;
			const kind = EVENT_RECORD_KINDS[index];
			if (kind === undefined) return null;
			counts[kind] = (counts[kind] ?? 0) + 1;
		}
		return counts;
	}

	/** What one kind is charged right now: the sliding-window counter. */
	#chargeFor(kind: string, now: number): number {
		const carried = this.#previousCounts.get(kind) ?? 0;
		const current = this.#windowCounts.get(kind) ?? 0;
		if (carried === 0) return current;
		const weight = Math.max(0, Math.min(1, 1 - (now - this.#windowStart) / RATE_WINDOW_MS));
		return carried * weight + current;
	}

	/** Advances the rate window and emits one `rate-capped` control record per capped kind per window. */
	#rollRateWindow(now: number): void {
		const elapsed = now - this.#windowStart;
		if (elapsed < RATE_WINDOW_MS) return;
		const windows = Math.floor(elapsed / RATE_WINDOW_MS);
		this.#windowStart += windows * RATE_WINDOW_MS;
		this.#previousCounts.clear();
		// Only an immediately preceding window still overlaps the last 1000 ms; a longer silence carries nothing, or
		// the cap would charge a page for traffic that is already outside the window it is measured over.
		if (windows === 1) {
			for (const [kind, count] of this.#windowCounts) this.#previousCounts.set(kind, count);
		}
		this.#windowCounts.clear();
		if (this.#windowDropped.size === 0) return;
		const dropped = [...this.#windowDropped];
		this.#windowDropped.clear();
		for (const [kind, count] of dropped) {
			this.#push('control', { event: 'rate-capped', kind, dropped: count }, null, now);
		}
	}

	#push(
		kind: EventRecordKind,
		payload: Record<string, unknown>,
		tabId: string | null,
		now: number,
	): EventRecord | null {
		if (this.#closed) return null;
		this.#seq += 1;
		const minted: EventRecord = {
			kind,
			seq: this.#seq,
			at: new Date(now).toISOString(),
			tab_id: tabId,
			payload: capFields(kind, payload),
		};
		const { record, bytes } = fitToByteCap(minted);
		this.#entries.push({ record, bytes });
		this.#bytes += bytes;
		this.#evict();
		for (const waiter of [...this.#waiters]) waiter();
		this.#waiters.clear();
		return record;
	}

	/** Oldest-evicting until both the entry and the byte bound hold. */
	#evict(): void {
		while (this.#entries.length > this.#capacity || (this.#bytes > this.#maxRingBytes && this.#entries.length > 1)) {
			const gone = this.#entries.shift();
			if (gone === undefined) return;
			this.#bytes -= gone.bytes;
			const reach = this.#evictedKinds.length;
			this.#evictedKinds[(gone.record.seq - 1) % reach] = KIND_INDEX.get(gone.record.kind) ?? UNKNOWN_KIND_INDEX;
			this.#evictedCount = gone.record.seq;
		}
	}
}

/** `gap` and `bye` are never filtered out; every other kind honours the `kinds` request. */
function keepsKind(record: EventRecord, kinds: ReadonlySet<EventKind>): boolean {
	if (record.kind === 'gap' || record.kind === 'bye') return true;
	return kinds.has(record.kind);
}

// --- payload builders: the redaction contract, enforced at mint -------------

/**
 * The `path` a log entry or a navigation record keeps for a URL: the pathname without `;matrix=params` in any segment
 * — a `;jsessionid=` is a session — and, for a `data:` URL, only the media type before its first `;` or `,` (the rest
 * is the payload, which the "path" of a `data:` URL otherwise is).
 */
export function loggedPath(url: string): string {
	const parsed = URL.parse(url);
	if (parsed === null) return '';
	if (parsed.protocol === 'data:') return dataMediaType(parsed.pathname);
	return stripMatrixParams(parsed.pathname);
}

/** A `data:` URL body's media type: what precedes its first `;` or `,`, trimmed and lower-cased. */
function dataMediaType(body: string): string {
	const at = body.search(/[;,]/);
	return (at === -1 ? body : body.slice(0, at)).trim().toLowerCase();
}

/** A path with every segment's `;params` removed. */
export function stripMatrixParams(path: string): string {
	return path.replace(/;[^/]*/g, '');
}

/** Splits a URL into the three fields a `navigation` payload may carry. */
export function navigationTarget(url: string): { origin: string; path: string; has_query: boolean } {
	try {
		const parsed = new URL(url);
		return {
			origin: parsed.origin === 'null' ? parsed.protocol : parsed.origin,
			// The path the request log keeps — no `;matrix=params`, where a `;jsessionid=` is a
			// session, and only a `data:` URL's media type, whose "path" is otherwise its payload.
			path: loggedPath(url),
			has_query: parsed.search !== '',
		};
	} catch {
		// An unparseable target is reported as one rather than passed through: the
		// raw string is the one thing that must not reach the wire.
		return { origin: '', path: '', has_query: false };
	}
}

/** The five fields a `focus` payload may carry. */
export function focusPayload(
	elementIndex: number | null,
	node: { readonly nodeName: string; readonly axNode?: { readonly role?: string | null } | null },
	frameId: string | null,
	label: string,
): Record<string, unknown> {
	const role = node.axNode?.role;
	return {
		element_index: elementIndex,
		tag: node.nodeName.toLowerCase(),
		role: typeof role === 'string' && role !== '' ? role : null,
		label,
		frame_id: frameId,
	};
}

/** The closed `download.failed` reason vocabulary. */
export type DownloadFailureReason =
	| 'canceled'
	| 'over-file-limit'
	| 'over-session-limit'
	| 'interrupted'
	| 'navigation-blocked'
	| 'browser-error';

// --- Classifies a download failure into the closed enum. ---------------------------------------------------------

/** Anchored at **both** ends, which is what makes them a control. */
const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, DownloadFailureReason]> = [
	[/^the download exceeds the per-file limit of \d+ bytes$/, 'over-file-limit'],
	[/^the session's downloads exceed the per-session limit of \d+ bytes$/, 'over-session-limit'],
	[/^the session already tracks \d+ downloads$/, 'over-session-limit'],
	[/^the transfer exceeded the \d+ ms deadline$/, 'interrupted'],
	[/^the download was canceled$/, 'canceled'],
	[/^canceled by the server$/, 'canceled'],
	// The ledger gate: a download whose *final* URL — after every redirect the browser followed — is outside
	// TTK_ALLOWED_DOMAINS is cancelled with this exact reason, and it is its own enum member because a consumer must
	// be able to tell "the policy refused it" from "it was canceled".
	[/^navigation-blocked$/, 'navigation-blocked'],
];

export function downloadFailureReason(error: string | null): DownloadFailureReason {
	if (error === null) return 'browser-error';
	const text = error.toLowerCase().trim();
	for (const [pattern, reason] of FAILURE_PATTERNS) {
		if (pattern.test(text)) return reason;
	}
	return 'browser-error';
}

/** The fields a download event may carry. Deliberately no `url`: a source URL may carry a token. */
interface DownloadEventSource {
	readonly guid: string;
	readonly fileName: string;
	readonly mimeType: string | null;
	readonly fileSize: number;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly state: string;
	readonly error: string | null;
}

/** Builds the payload for one `download.*` kind. */
export function downloadPayload(
	kind: 'download.started' | 'download.done' | 'download.failed',
	source: DownloadEventSource,
): Record<string, unknown> {
	const base = { file_id: source.guid, filename: source.fileName, status: source.state };
	// The watchdog's containment-failure path sets `state: 'completed'` and then emits the `failed` phase, so passing
	// the state through would report a failed download as complete — the one field a consumer uses to decide whether
	// to fetch the bytes.
	if (kind === 'download.failed') {
		return { ...base, status: 'failed', reason: downloadFailureReason(source.error) };
	}
	if (kind === 'download.started') {
		return {
			...base,
			content_type: source.mimeType,
			bytes_expected: source.totalBytes > 0 ? source.totalBytes : null,
		};
	}
	return { ...base, content_type: source.mimeType, bytes: source.fileSize };
}

// --- the `network.idle` source ---------------------------------------------

/** The quiet window a `network.idle` record is minted after. */
const NETWORK_IDLE_QUIET_MS = 500;

/** Requests tracked at once before the oldest is forgotten. */
const NETWORK_TRACKER_LIMIT = 500;

interface NetworkIdleCounterOptions {
	/** Milliseconds at zero in flight before a record is minted. */
	readonly quietMs?: number;
	/** Called once per quiet transition. */
	readonly emit: (inflight: number, quietMs: number) => void;
}

/** Counts in-flight requests and mints one `network.idle` record per quiet transition. */
export class NetworkIdleCounter {
	readonly #quietMs: number;
	readonly #emit: (inflight: number, quietMs: number) => void;
	readonly #inflight = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#quiet = true;
	#disposed = false;

	constructor(options: NetworkIdleCounterOptions) {
		this.#quietMs = options.quietMs ?? NETWORK_IDLE_QUIET_MS;
		this.#emit = options.emit;
	}

	/** Requests in flight right now. */
	get inflight(): number {
		return this.#inflight.size;
	}

	/** True while the counter considers the page quiet. */
	get quiet(): boolean {
		return this.#quiet;
	}

	started(requestId: string): void {
		if (this.#disposed) return;
		if (this.#inflight.size >= NETWORK_TRACKER_LIMIT) {
			const oldest = this.#inflight.values().next();
			if (!oldest.done) this.#inflight.delete(oldest.value);
		}
		this.#inflight.add(requestId);
		this.#quiet = false;
		this.#disarm();
	}

	finished(requestId: string): void {
		if (this.#disposed) return;
		if (!this.#inflight.delete(requestId)) return;
		if (this.#inflight.size === 0) this.#arm();
	}

	/** Forgets every tracked request — a navigation or a reconnect starts a new page's traffic. */
	reset(): void {
		this.#inflight.clear();
		this.#disarm();
		this.#quiet = true;
	}

	/** Clears the pending timer. Idempotent; safe to call from a detach path. */
	dispose(): void {
		this.#disposed = true;
		this.#disarm();
		this.#inflight.clear();
	}

	#arm(): void {
		this.#disarm();
		const timer = setTimeout(() => {
			this.#timer = undefined;
			if (this.#disposed || this.#quiet) return;
			this.#quiet = true;
			this.#emit(0, this.#quietMs);
		}, this.#quietMs);
		// Never hold the process open for a page that went quiet: the record is
		// worth minting when the runtime is alive anyway, not worth a live op.
		Deno.unrefTimer(timer as unknown as number);
		this.#timer = timer;
	}

	#disarm(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
