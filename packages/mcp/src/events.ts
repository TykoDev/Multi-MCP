/**
 * @module
 * The per-session event ring (report_design.md §7, SPECS/DATA-MODEL.md §4).
 *
 * The ring is the **primitive**; the SSE route, the live-view socket and
 * `browser_wait_for` are three views of it. That is why the tool works
 * unchanged on the stdio mount, which hosts neither transport.
 *
 * It lives on the `SessionRegistry` record beside `record.files` because
 * `SessionRegistry.#launch` is the one place in the tree where a per-session
 * subscription already outlives its viewers. Deliberately **not** `SessionCast`
 * (its bus subscriptions die with the last viewer), not the session `EventBus`
 * (`EventBus.on` is handler registration with a per-handler timeout, so a slow
 * subscriber becomes a dispatch failure inside the browser layer) and not
 * `SessionRegistry.#watchers` (no payload, no timestamp, no sequence, no
 * buffer).
 *
 * ## Three bounds, and the third is what makes the first two a guarantee
 *
 * | Bound | Value | Enforced |
 * | --- | ---: | --- |
 * | Entries per session | 512 | oldest-evicting at append |
 * | Serialized bytes per event | 1 KiB | at append; an over-length entry is truncated at its one variable-length field and flagged, **never dropped** |
 * | Serialized bytes per session | 256 KiB | at append, oldest-evicting until it fits |
 *
 * At 512 entries the byte total binds first, which is why the published figure
 * is 256 KiB per session — 2 MiB at the 8-session cap. An entry cap alone does
 * not bound a ring whose entries can each be a kilobyte, and `console.text` and
 * `dialog.message` are **page-controlled**, so an untrusted page would otherwise
 * choose the multiplicand.
 *
 * ## The redaction contract is a security control, not a convenience
 *
 * Every retained entry is replayable to any `mcp:invoke` holder, so the ring is
 * cross-principal by construction. Invariant I-8: an event carries nothing a
 * principal could not already obtain from `browser_get_state` on the same
 * session, and **no event embeds an element record**. The three deliberate
 * divergences from `needed-browser-functions.md` §2.1 are enforced here at mint
 * time rather than at the transport, so no transport can reintroduce them:
 * `download.*` carries no `url`, `navigation` carries origin plus path with the
 * query removed, and `focus` carries a five-field descriptor. `input` never
 * carries a value, a length or a prefix — a length is a password-strength
 * oracle (SEC-03, DD-7).
 *
 * ## `seq` is allocated over the unfiltered stream
 *
 * Per record, from 1, monotonic, never reused. A subscriber that filtered
 * `kinds` therefore sees **non-contiguous `seq`, and that is not a gap**. The
 * only signal of loss is a `gap` record, which is mandatory and **first**,
 * because a consumer that cannot tolerate a gap must learn it before it
 * processes anything.
 */
import { ulid } from '@std/ulid';
import { EVENT_RECORD_KINDS } from '@tykotech/wire';
import type { ControlEvent, EventKind, EventRecord, EventRecordKind } from '@tykotech/wire';

/** Entries retained per session before the oldest is evicted (report_design.md §7.3). */
export const RING_CAPACITY = 512;

/** Serialized bytes one record may occupy. Over-length records are shrunk, never dropped. */
export const MAX_EVENT_BYTES = 1024;

/** Serialized bytes one session's ring may occupy. Binds before {@linkcode RING_CAPACITY}. */
export const MAX_RING_BYTES = 256 * 1024;

/**
 * The emission rate cap for content-bearing kinds, per session (SEC-11).
 *
 * The ring is the **memory** bound; this is the CPU and CDP-reader bound, and
 * it is what stops a page in a `console.log` loop turning an untrusted page's
 * log volume into server work. Structural kinds are never capped, because a
 * page cannot spin them and losing one is worse than the work it costs.
 */
export const CONTENT_RATE_PER_SECOND = 50;

/**
 * The budget for the structural kinds.
 *
 * The design reasoned that structural kinds need no cap "because a page cannot
 * spin them". **That premise is false**, and a security review proved it: a page
 * can spin `dialog` (`alert()` in a loop, which the popups watchdog
 * auto-answers), `tab` (`window.open`/`close`) and `navigation` (reassigning an
 * iframe `src`). Uncapped, that is not merely load — it is **event blinding**:
 * 512 synthetic records evict the one real `download.done` a consumer was
 * waiting for, so the page chooses which events an `mcp:invoke` principal is
 * allowed to observe.
 *
 * So the answer is a larger budget rather than no budget. "Losing one is worse
 * than the work it costs" still holds up to this bound, and past it the exact
 * loss is reported by a `rate-capped` record rather than being silent.
 *
 * **The window slides (SR1-A1b), and that is not a refinement.** It used to be a
 * fixed window re-anchored to `now` at each roll, which a page defeated by
 * straddling a boundary: 250 `dialog` records at 900 ms and 250 more at 1000 ms
 * is 500 admitted in 100 ms against a budget that reads as 250 per second.
 * Measured at 1500 records across six kinds in one nominal window, sustaining
 * 2.9 ring turnovers per second. {@linkcode SessionEventRing} now charges each
 * kind the **weighted sum of the previous window and the current one**, so any
 * 1000 ms interval is bounded by the budget rather than only the intervals that
 * happen to align with a boundary.
 *
 * **A rate cap still does not, by itself, close event blinding, and must not be
 * described as if it does.** A page permitted 250 structural records a second
 * still turns a 512-entry ring over, and a consumer offline for two seconds
 * still loses records. What changed in SR1-A1b is that the loss is now
 * **attributable**: the mandatory `gap` record carries a per-kind breakdown of
 * exactly what was evicted, so a consumer can tell "the page flooded `dialog`"
 * from "you were away too long" and act differently on each. Enlarging the ring
 * was rejected as an answer — a bigger buffer moves the threshold without
 * changing the property.
 */
export const STRUCTURAL_RATE_PER_SECOND = 250;

/**
 * The window the rate cap is measured over.
 *
 * It **slides**: the charge for a kind is `previous × (1 − elapsed/window) +
 * current`, the standard sliding-window counter. That costs two integers per
 * kind rather than a timestamp per record, which matters because this runs on
 * the CDP reader's path, and it bounds every 1000 ms interval rather than only
 * the aligned ones.
 */
export const RATE_WINDOW_MS = 1000;

/**
 * Evicted records whose **kind** is still remembered, so a `gap` can attribute
 * the loss it reports (SR1-A1b).
 *
 * The ring's own contents answer "what is still here"; nothing answered "what
 * went, and what was it" — so a consumer reading `dropped: 900` could not tell a
 * page flooding one kind from its own two-second absence, which is the whole
 * difference between "re-read state" and "this page is hostile".
 *
 * One **byte** per evicted record, an index into `EVENT_RECORD_KINDS`, in a
 * circular buffer: eight ring-fulls of history for 4 KiB per session, against
 * the 256 KiB the ring itself may hold. Beyond that reach the breakdown is
 * `null` rather than approximate — the same convention `dropped: null` already
 * uses for a count that is unknowable, because a fabricated attribution is worse
 * than an admitted one.
 */
export const EVICTION_LEDGER_CAPACITY = RING_CAPACITY * 8;

/**
 * The kinds a page can spin cheaply, held to the tighter budget.
 *
 * **This set must contain every kind `SSE_ONLY_EVENT_KINDS` names**, and
 * `events_test.ts` asserts the containment. The two lists answer different
 * questions — "may a `view:watch` holder see this" and "how fast may a page mint
 * it" — but a kind that is page *content* is by construction a kind a page can
 * spin, so a kind in one and not the other is a drift defect rather than a
 * design choice. `focus` was in exactly that state: withheld from the socket as
 * content, and budgeted at the structural 250/s while carrying page-authored
 * strings, which turns a 512-entry ring over in about two seconds.
 */
const CONTENT_KINDS: ReadonlySet<string> = new Set<string>(['console', 'input', 'dom.settled', 'focus']);

/**
 * The kinds no cap applies to.
 *
 * `control` is minted by this server alone — a page cannot reach it — and the
 * `rate-capped` record is itself a `control`, so capping it could suppress the
 * report of a cap. `gap` and `bye` are synthesized per read, never appended.
 */
const UNCAPPED_KINDS: ReadonlySet<string> = new Set<string>(['control', 'gap', 'bye']);

/** The budget for one kind in one window. */
function budgetFor(kind: string): number {
	return CONTENT_KINDS.has(kind) ? CONTENT_RATE_PER_SECOND : STRUCTURAL_RATE_PER_SECOND;
}

/**
 * A kind's position in `EVENT_RECORD_KINDS`, which is what the eviction ledger
 * stores. `0xff` is the "not a known kind" marker, and it can only arise if a
 * record is minted with a kind outside the vocabulary — which the type system
 * forbids and the ledger therefore records as unattributable rather than
 * mis-attributing it to whatever sits at that index.
 */
const KIND_INDEX: ReadonlyMap<string, number> = new Map(EVENT_RECORD_KINDS.map((kind, index) => [kind, index]));
const UNKNOWN_KIND_INDEX = 0xff;

/**
 * Per-field character caps (report_design.md §7.3).
 *
 * Applied at mint time so the 1 KiB per-record cap is satisfiable by
 * construction rather than by truncation. A payload absent from this table has
 * no variable-length field at all — only identifiers, enums and numbers — so
 * its serialized length is bounded by the identifier widths alone.
 */
const PAYLOAD_CAPS: Readonly<Partial<Record<EventRecordKind, Readonly<Record<string, number>>>>> = {
	navigation: { origin: 256, path: 256 },
	// `label` is 121 rather than 120 because `labelOf` appends an ellipsis to a
	// 120-character slice, so a capped label is 121 characters by construction; a
	// cap of 120 would re-truncate every long label, drop the ellipsis, and set a
	// spurious `truncated` flag on a record that was already correctly bounded.
	// `tag` and `role` are page-authored too — a custom-element name is whatever
	// the page calls it — and the design's "bounded size: label 120" was not true
	// of the payload until they were capped as well.
	focus: { label: 121, tag: 32, role: 64 },
	'download.started': { filename: 255 },
	'download.done': { filename: 255 },
	'download.failed': { filename: 255 },
	dialog: { message: 512 },
	console: { text: 512 },
	control: { holder_name: 64, principal: 64, kind: 64 },
};

/**
 * The one field per kind the byte cap may shrink at.
 *
 * "Truncated at its one variable-length field and flagged, never dropped" needs
 * a single named field per kind, because shrinking an arbitrary field would
 * make which fact was lost unknowable to the consumer.
 */
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

/**
 * Shrinks one record to {@linkcode MAX_EVENT_BYTES}, preferring its single named
 * variable-length field.
 *
 * Halving rather than walking, because this runs on the CDP reader's path: a
 * 512-character field reaches empty in ten iterations.
 *
 * **The named field alone is not a bound.** `SHRINK_FIELD` and `PAYLOAD_CAPS`
 * only describe the fields each kind is *supposed* to carry, so a producer that
 * passes a field the table does not name — a refactor that widens a payload, a
 * new kind wired before its caps are added — would sail past both and put an
 * unbounded, page-controlled string in a cross-principal ring. A defence that
 * works only when the producer is already correct is not a defence, so the
 * second pass shrinks whatever remains longest until the record fits. The
 * contract stays "never dropped": the record always survives, flagged.
 */
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
		// No string left to shrink and still over cap: the bloat is a nested
		// object or array, which is exactly the "a refactor widened a payload"
		// case this pass exists for. Drop the non-primitive fields rather than
		// return an unbounded record; the flag says something was lost.
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
		// Nothing left to shrink and still over cap: the bulk is in the field
		// *names*, which no shrink touches. The record still survives — the
		// contract is "never dropped" — but it survives as the fact that it
		// happened, rather than as an unbounded entry in a bounded ring.
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
export interface SessionEventRingOptions {
	/** Injected clock, so the rate cap and `at` are deterministic under test. */
	readonly now?: () => number;
	readonly capacity?: number;
	readonly maxRingBytes?: number;
	/**
	 * Toggles `Runtime.enable` for the session when the `console` refcount
	 * crosses zero. Absent on a session with no CDP client attached; the
	 * refcount and its control records exist either way, so a consumer always
	 * reads a coverage boundary rather than inferring one from silence.
	 */
	readonly setConsoleArmed?: (armed: boolean) => void;
	readonly logger?: { warn(msg: string): void };
}

/**
 * A cursor as the client stores and returns it: `<epoch>:<seq>`, opaque.
 *
 * The epoch half is what makes a restart visible. A bare integer with no epoch
 * is treated as an epoch mismatch rather than as a `seq`, so a naive client
 * gets the truth rather than a silent wait against a ring that no longer holds
 * what it is asking for.
 */
export function formatCursor(epoch: string, seq: number): string {
	return `${epoch}:${seq}`;
}

/** The three things a `since` value can mean. */
export type ParsedCursor =
	| { readonly kind: 'from-now' }
	| { readonly kind: 'cursor'; readonly epoch: string; readonly seq: number }
	| { readonly kind: 'epoch-mismatch' };

/**
 * Parses a `?since=` value or `Last-Event-ID` header.
 *
 * Omitted means **from now**, not from the beginning: replaying a session's
 * whole retained history to a consumer that just connected is a surprise, not
 * a service.
 */
export function parseCursor(raw: string | null | undefined): ParsedCursor {
	if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'from-now' };
	const at = raw.lastIndexOf(':');
	if (at <= 0) return { kind: 'epoch-mismatch' };
	const epoch = raw.slice(0, at);
	const tail = raw.slice(at + 1);
	// Decimal digits only: bare `Number` would accept `0x10` as 16, ` 12` as 12
	// and the empty string as 0, so a malformed cursor would silently become a
	// plausible one instead of the epoch mismatch it is.
	if (!/^\d+$/.test(tail)) return { kind: 'epoch-mismatch' };
	const seq = Number(tail);
	if (!Number.isSafeInteger(seq)) return { kind: 'epoch-mismatch' };
	return { kind: 'cursor', epoch, seq };
}

/**
 * The per-session sequenced event ring.
 *
 * One instance per `SessionRecord`. It is in memory, dies with the session, is
 * never written under `TTK_DATA_DIR` and is never included in a recording
 * artefact.
 */
export class SessionEventRing {
	/**
	 * This incarnation's identity, minted at construction.
	 *
	 * A cursor carrying any other epoch is a gap whatever its `seq`, older or
	 * newer alike, with `dropped: null` — **not** zero, because the previous
	 * incarnation's ring is gone and the count is unknowable. Reporting an
	 * unknown as zero is the exact failure the gap record exists to prevent.
	 */
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
	/**
	 * What the window before this one admitted, per kind.
	 *
	 * The second half of the sliding-window counter (SR1-A1b): a boundary
	 * straddle is charged the part of the previous window that is still inside
	 * the last 1000 ms, so 250 records at 900 ms do not stop counting the instant
	 * a boundary passes.
	 */
	readonly #previousCounts = new Map<string, number>();
	readonly #windowDropped = new Map<string, number>();
	/** One byte per evicted record: its index in `EVENT_RECORD_KINDS`. Circular. */
	readonly #evictedKinds: Uint8Array;
	/** Records evicted since this epoch, which is also the highest evicted `seq`. */
	#evictedCount = 0;
	#consoleSubscribers = 0;
	#domSettledSubscribers = 0;
	/** B2.5 / E-53: subscribers holding the `dialog` kind, and with it manual dialog handling. */
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

	/**
	 * Installs the `console` arm/disarm callback after construction.
	 *
	 * The producer needs the record — and thus this ring — to exist before it can
	 * be built (its listeners mint into this ring), so the toggle cannot always be
	 * passed at construction; the registry sets it once the producer is attached.
	 * If a subscriber has already armed console before the callback is installed,
	 * it is armed immediately so it does not miss the current subscription.
	 */
	setConsoleArmed(callback: (armed: boolean) => void): void {
		this.#setConsoleArmed = callback;
		if (this.#consoleSubscribers > 0) callback(true);
	}

	/**
	 * Subscribers currently holding the `dom.settled` kind armed.
	 *
	 * Unlike `console`, minting `dom.settled` needs a state read to obtain the
	 * token, so a settle event genuinely costs a capture. The producer therefore
	 * reads this count and mints **only** while a subscriber wants the kind; an
	 * idle session observes mutations (the injection is shared with `input` and
	 * always on) but does no reads. There is no arm/disarm control record and no
	 * coverage boundary, because the DOM is fully re-readable through
	 * `browser_get_state` at any moment — a missed settle is not a silence a
	 * consumer can misread.
	 */
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

	/**
	 * Installs the manual-dialog arm/disarm callback after construction (B2.5, E-53).
	 *
	 * Same shape and same reason as {@linkcode SessionEventRing.setConsoleArmed}: the producer needs
	 * this ring to exist before it can be wired, and a subscriber that arrived first must not be lost.
	 */
	setDialogArmed(callback: (armed: boolean) => void): void {
		this.#setDialogArmed = callback;
		if (this.#dialogSubscribers > 0) callback(true);
	}

	/** Subscribers currently holding the `dialog` kind — and with it, manual dialog handling. */
	get dialogSubscribers(): number {
		return this.#dialogSubscribers;
	}

	/**
	 * Claims the `dialog` kind for one subscriber, arming manual handling on the transition from zero.
	 *
	 * **Why arming is keyed on subscription and not on a session option.** A held dialog blocks the
	 * whole CDP channel for its target, so holding one for a client that is not listening would stop
	 * a session for nobody; and a client that asked to be told about dialogs is by construction a
	 * client that can answer one. The precedent is `console`, armed the same way for the same class of
	 * reason. Without a subscriber the watchdog answers by policy exactly as it did in 0.1.0.
	 */
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

	/**
	 * Releases one `dialog` claim, disarming on the transition to zero.
	 *
	 * Disarming releases every dialog the watchdog is still holding to the automatic policy, because
	 * the alternative is a page frozen behind a dialog whose only possible answerer has just left.
	 */
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

	/**
	 * Mints one record and retains it, or returns `null` when the rate cap
	 * dropped it.
	 *
	 * `tabId` is `null` for a session-scoped record and is never omitted, so a
	 * consumer never has to tell "absent" from "not applicable".
	 */
	append(kind: EventRecordKind, payload: Record<string, unknown>, tabId: string | null = null): EventRecord | null {
		if (this.#closed) return null;
		const now = this.#now();
		this.#rollRateWindow(now);
		if (!UNCAPPED_KINDS.has(kind)) {
			// The sliding charge, not the current window's raw count: the fixed
			// window this replaced admitted two full budgets across a boundary
			// straddle, which is the defect SR1-A1b measured.
			if (this.#chargeFor(kind, now) >= budgetFor(kind)) {
				this.#windowDropped.set(kind, (this.#windowDropped.get(kind) ?? 0) + 1);
				return null;
			}
			this.#windowCounts.set(kind, (this.#windowCounts.get(kind) ?? 0) + 1);
		}
		return this.#push(kind, payload, tabId, now);
	}

	/**
	 * Appends a `control` record. Never rate-capped: a page cannot mint one, and
	 * the `rate-capped` report is itself a control record.
	 *
	 * Returns `null` on a closed ring rather than fabricating a record at an
	 * already-allocated `seq`, which would break "never reused" at exactly the
	 * moment a consumer is trying to reconcile what it missed.
	 */
	appendControl(
		event: ControlEvent,
		extra: Record<string, unknown> = {},
		tabId: string | null = null,
	): EventRecord | null {
		return this.#push('control', { event, ...extra }, tabId, this.#now());
	}

	/**
	 * Records after `cursor`, oldest first, with a mandatory leading `gap` when
	 * the cursor has fallen off the tail or names another epoch.
	 *
	 * A `kinds` filter never removes `gap` or `bye`: a stream that could suppress
	 * its own loss record would be worse than one carrying none.
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

	/**
	 * Resolves on the next append, on close, or after `timeoutMs`.
	 *
	 * The timer is cleared on every exit so a test under `sanitizeOps` does not
	 * see a pending op.
	 */
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

	/**
	 * Claims the `console` kind for one subscriber, arming `Runtime.enable` on
	 * the transition from zero.
	 *
	 * Console events from before the first subscription **do not exist** — they
	 * were never minted — so the transition is announced on the stream and a
	 * consumer reads a coverage boundary rather than inferring that silence
	 * meant quiet.
	 */
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

	/**
	 * Releases one `console` claim, disarming on the transition to zero.
	 *
	 * Called from the **one** subscriber-removal path every exit route uses —
	 * stream `cancel()`, WebSocket close and graceful shutdown alike — so no
	 * exit path can leave the domain enabled for the session's life after its
	 * subscriber has gone.
	 */
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

	/**
	 * Mints a gap record.
	 *
	 * **`seq` is `oldest - 1`, deliberately one below the design's figure.** The
	 * design specified the oldest retained seq, but SSE publishes each record's
	 * `seq` as its `id:` — which is the value a client returns as
	 * `Last-Event-ID` after a reconnect. A gap sharing a seq with the record that
	 * follows it therefore made that record unreachable: resuming from the gap's
	 * own id skipped it, silently and with no second gap to say so. Every record
	 * on the stream now means the same thing — "the cursor you have consumed
	 * through" — and `dropped_to` equals the gap's own seq, which reads directly.
	 */
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
			// `by_kind` is what makes the loss **attributable** rather than merely
			// reported (SR1-A1b): with it a consumer tells "the page flooded
			// `dialog`" from "you were away too long", and the two want different
			// responses. `null` means the span reaches beyond the eviction ledger,
			// or the epoch changed and the previous incarnation is gone — the same
			// honesty `dropped: null` already carries. Its size is bounded by
			// construction: at most one entry per kind in `EVENT_RECORD_KINDS`.
			payload: {
				reason,
				dropped_from: from,
				dropped_to: to,
				dropped,
				by_kind: from === null || to === null ? null : this.#attribute(from, to),
			},
		};
	}

	/**
	 * The per-kind breakdown of an evicted span, or `null` when it cannot be
	 * known exactly.
	 *
	 * Evicted seqs are `1 … #evictedCount`, contiguous, because every minted
	 * record is pushed and eviction only ever takes the oldest. So a span is
	 * answerable exactly when it lies inside the ledger's reach, and the answer
	 * is a count rather than an estimate.
	 */
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

	/**
	 * What one kind is charged right now: the sliding-window counter.
	 *
	 * `previous × (1 − elapsed/window) + current`. At the instant a window turns
	 * the previous one still counts in full, and its weight decays to zero across
	 * the new window — so a burst placed either side of a boundary is charged
	 * once, which is exactly what the fixed window failed to do.
	 */
	#chargeFor(kind: string, now: number): number {
		const carried = this.#previousCounts.get(kind) ?? 0;
		const current = this.#windowCounts.get(kind) ?? 0;
		if (carried === 0) return current;
		const weight = Math.max(0, Math.min(1, 1 - (now - this.#windowStart) / RATE_WINDOW_MS));
		return carried * weight + current;
	}

	/**
	 * Advances the rate window and emits one `rate-capped` control record per
	 * capped kind per window.
	 *
	 * **The window advances to a boundary; it is not re-anchored to `now`.** The
	 * previous code set `#windowStart = now`, which meant the grid moved to
	 * whenever traffic happened to arrive and a page could place a burst either
	 * side of a boundary it controlled. Advancing by whole windows keeps the grid
	 * fixed, and carrying the previous window's counts forward as a weighted
	 * charge is what bounds the straddle itself.
	 *
	 * Rolling on read as well as on append is what stops a burst that ends the
	 * session's traffic from leaving its own drop count unreported.
	 */
	#rollRateWindow(now: number): void {
		const elapsed = now - this.#windowStart;
		if (elapsed < RATE_WINDOW_MS) return;
		const windows = Math.floor(elapsed / RATE_WINDOW_MS);
		this.#windowStart += windows * RATE_WINDOW_MS;
		this.#previousCounts.clear();
		// Only an immediately preceding window still overlaps the last 1000 ms; a
		// longer silence carries nothing, or the cap would charge a page for
		// traffic that is already outside the window it is measured over.
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

	/**
	 * Oldest-evicting until both the entry and the byte bound hold.
	 *
	 * Every eviction writes one byte to the ledger before the record is dropped:
	 * that byte is the only thing that survives it, and it is what lets a later
	 * `gap` say which kind took the ring rather than only how much was lost.
	 */
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
 * The `path` a log entry or a navigation record keeps for a URL (review R2-3, NF-2): the pathname without
 * `;matrix=params` in any segment — a `;jsessionid=` is a session — and, for a `data:` URL, only the media type before
 * its first `;` or `,` (the rest is the payload, which the "path" of a `data:` URL otherwise is). `''` when the URL
 * does not parse.
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

/** A path with every segment's `;params` removed (review R2-3). */
export function stripMatrixParams(path: string): string {
	return path.replace(/;[^/]*/g, '');
}

/**
 * Splits a URL into the three fields a `navigation` payload may carry.
 *
 * **A field named `url` carrying a truncated URL would be the lie this shape
 * exists to avoid.** `SPECS/SECURITY-AUTH.md` §8.3 already refuses to put
 * source URLs on the wire "(which may carry tokens)", and a navigation URL is
 * exactly where a one-time code or session token appears. `origin` is scheme,
 * host and port; `path` has the query and fragment removed, and is cut as the
 * request log cuts it ({@linkcode loggedPath}: no matrix parameters, a `data:`
 * URL's media type only — NF-2).
 *
 * `has_query` carries no part of what was removed — only the fact that
 * something was. Without it a consumer that concatenates `origin + path` cannot
 * tell apart two pages differing only in their query, which is the motivating
 * case of a frameset whose search changes only the query string.
 *
 * A scheme with no origin (`about:`, `data:`, `blob:`) reports its scheme
 * rather than the literal string `null`, which would read as a missing value.
 */
export function navigationTarget(url: string): { origin: string; path: string; has_query: boolean } {
	try {
		const parsed = new URL(url);
		return {
			origin: parsed.origin === 'null' ? parsed.protocol : parsed.origin,
			// NF-2: the path the request log keeps (review R2-3) — no `;matrix=params`, where a `;jsessionid=` is a
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

/**
 * The five fields a `focus` payload may carry (report_design.md §7.2).
 *
 * **A descriptor, never an element record.** The requirement asked for the
 * record; a record is 307 bytes in the default preset and 891 in `full`, and it
 * would be retained in a 512-entry cross-principal ring — roughly 456 KB per
 * session against the 256 KiB this design publishes. The byte arithmetic and
 * the security rule reach the same answer, which is the strongest kind of
 * constraint. A consumer that wants the record calls `browser_element_at` or
 * `browser_get_state`.
 *
 * `label` is resolved through `labelOf`, which is the **gated** path: for a
 * field the single password predicate fires on, the `value` candidate is
 * removed outright rather than masked, so nothing derived from it — not a
 * prefix, not a length — can reach this payload. Passing `axNode.name` or the
 * raw attributes here instead would be the defect BF-8's surface matrix exists
 * to catch, which is why that matrix now feeds this function directly.
 *
 * Every field is server-derived. Nothing a page says reaches a `focus` record.
 */
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

/** The closed `download.failed` reason vocabulary (report_design.md §7.2). */
export type DownloadFailureReason =
	| 'canceled'
	| 'over-file-limit'
	| 'over-session-limit'
	| 'interrupted'
	| 'navigation-blocked'
	| 'browser-error';

/**
 * Classifies a download failure into the closed enum.
 *
 * The watchdog's `error` field is **free text** and must never reach the wire:
 * Chromium's own error strings can contain a URL, and even this repository's
 * strings are prose a consumer cannot enumerate. Every unmatched reason becomes
 * `browser-error`, which is the safe answer — a misclassification costs a
 * consumer one branch, whereas passing the text through would cost the URL rule
 * (`SPECS/SECURITY-AUTH.md` §8.3).
 *
 * **The patterns are anchored, and that is a control rather than tidiness.**
 * Several of the watchdog's own strings interpolate the download's **display
 * name**, which the page chooses (`downloads.ts`: "the browser reported
 * `<name>` as complete but no file exists…"). Under substring matching a file
 * named `deadline.pdf` reported `interrupted` and `cancel.txt` reported
 * `canceled` — the enum stayed closed, but the page picked the value out of it.
 * Anchoring at the start of the string puts the choice back with the watchdog.
 */
/**
 * Anchored at **both** ends, which is what makes them a control.
 *
 * Two of the watchdog's own templates interpolate the download's display name
 * at position 0 ("<name> resolved outside the downloads directory and was
 * refused"), and the page chooses that name. A start anchor alone therefore
 * still let the page pick the value out of the closed enum: a file named
 * `the session already tracks 0 downloads.pdf` classified as
 * `over-session-limit`. Anchoring the end too means the trailing prose of the
 * real template no longer matches, and the choice returns to the watchdog.
 */
const FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, DownloadFailureReason]> = [
	[/^the download exceeds the per-file limit of \d+ bytes$/, 'over-file-limit'],
	[/^the session's downloads exceed the per-session limit of \d+ bytes$/, 'over-session-limit'],
	[/^the session already tracks \d+ downloads$/, 'over-session-limit'],
	[/^the transfer exceeded the \d+ ms deadline$/, 'interrupted'],
	[/^the download was canceled$/, 'canceled'],
	[/^canceled by the server$/, 'canceled'],
	// The ledger gate (B1.12, owner item 6): a download whose *final* URL — after
	// every redirect the browser followed — is outside TTK_ALLOWED_DOMAINS is
	// cancelled with this exact reason, and it is its own enum member because a
	// consumer must be able to tell "the policy refused it" from "it was canceled".
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

/** The fields a download event may carry. Deliberately no `url` — SECURITY-AUTH §8.3. */
export interface DownloadEventSource {
	readonly guid: string;
	readonly fileName: string;
	readonly mimeType: string | null;
	readonly fileSize: number;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly state: string;
	readonly error: string | null;
}

/**
 * Builds the payload for one `download.*` kind.
 *
 * The requirement's §2.1 payload table lists a `url`; the frozen security
 * specification forbids one in that document's own words. Two rules, and the
 * security rule wins — recorded as a deliberate deviation. Building the payload
 * here rather than at each transport is what stops a later transport
 * reintroducing the field.
 */
export function downloadPayload(
	kind: 'download.started' | 'download.done' | 'download.failed',
	source: DownloadEventSource,
): Record<string, unknown> {
	const base = { file_id: source.guid, filename: source.fileName, status: source.state };
	// The watchdog's containment-failure path sets `state: 'completed'` and then
	// emits the `failed` phase, so passing the state through reported a failed
	// download as complete — the one field a consumer uses to decide whether to
	// fetch the bytes.
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
export const NETWORK_IDLE_QUIET_MS = 500;

/**
 * Requests tracked at once before the oldest is forgotten.
 *
 * Matches `PENDING_NETWORK_TRACKER_LIMIT` in the DOM watchdog: an untrusted page
 * can open requests faster than they finish, and an unbounded set of ids is a
 * memory bound a page chooses.
 */
const NETWORK_TRACKER_LIMIT = 500;

export interface NetworkIdleCounterOptions {
	/** Milliseconds at zero in flight before a record is minted. */
	readonly quietMs?: number;
	/** Called once per quiet transition. */
	readonly emit: (inflight: number, quietMs: number) => void;
}

/**
 * Counts in-flight requests and mints one `network.idle` record per quiet transition.
 *
 * The shape is the pending-network tracker that already exists twice — in the
 * DOM watchdog and in `waitForNetworkStability` — rather than a third: the same
 * three CDP events, the same restart-on-request quiet window. "Quiet" means
 * `quietMs` with nothing in flight, not "nothing in flight right now", which a
 * page firing a request every 200 ms would satisfy constantly.
 *
 * One record per transition, not one per tick: a page that stays quiet emits
 * once and then nothing, so a subscriber reads an edge rather than a heartbeat.
 */
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
