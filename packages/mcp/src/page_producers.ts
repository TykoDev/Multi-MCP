/** The page-side producers of the event ring's `input`, `console` and `dom.settled` kinds. */
import type { CdpClient, SessionId, TargetId } from '@tykotech/cdp';
import { type EnhancedDomTreeNode, isPasswordField } from '@tykotech/browser';
import { isFocused } from './element_record.ts';
import { CONTENT_RATE_PER_SECOND, RATE_WINDOW_MS } from './events.ts';
import type { SessionRecord } from './registry.ts';

// --- `input`: an injected page listener and a CDP binding ---------------------------------------------------------

/** The closed `input.kind` vocabulary. */
export const INPUT_EVENT_KINDS = ['input', 'change', 'submit', 'other'] as const;
type InputEventKind = (typeof INPUT_EVENT_KINDS)[number];

/** Bytes one binding call may carry. */
export const MAX_BINDING_PAYLOAD_BYTES = 512;

/** Binding calls admitted per session per second, counted on calls rather than on appends. */
const MAX_BINDING_CALLS_PER_SECOND = CONTENT_RATE_PER_SECOND;

/** CDP target types that get the injection. A worker has no DOM to type into. */
const INJECTABLE_TYPES: ReadonlySet<string> = new Set(['page', 'iframe']);

/** The injected listener. */
const LISTENER_SOURCE = `(() => {
	const send = globalThis['__TTK_BINDING__'];
	if (typeof send !== 'function') return;
	if (globalThis['__TTK_BINDING__armed']) return;
	globalThis['__TTK_BINDING__armed'] = true;
	const report = (kind) => {
		try { send(JSON.stringify({ k: kind })); } catch (_) { /* a torn-down binding is not an error */ }
	};
	const listen = (type, kind) => {
		try {
			addEventListener(type, (event) => {
				// A page can synthesise an untrusted event; a synthesised one is not
				// evidence of a human or a tool typing, so it is not reported.
				if (event && event.isTrusted) report(kind);
			}, true);
		} catch (_) { /* a frame torn down mid-injection is not an error */ }
	};
	listen('input', 'input');
	listen('change', 'change');
	listen('submit', 'submit');
	// The DOM-mutation half of the shared injection: a MutationObserver
	// that reports only a *count* of mutations, throttled, and never any node,
	// attribute name, value or text — the same blindness the input listener
	// keeps. The count feeds the server's settle debounce; the server, not the
	// page, decides when the page is quiet and holds the token.
	try {
		let pending = 0;
		let scheduled = false;
		const flush = () => {
			scheduled = false;
			const count = pending;
			pending = 0;
			if (count > 0) {
				try { send(JSON.stringify({ d: count })); } catch (_) { /* torn-down binding */ }
			}
		};
		const observer = new MutationObserver((records) => {
			pending += records.length;
			if (scheduled) return;
			scheduled = true;
			// One report per animation frame at most, so a mutation storm is one
			// binding call per frame rather than one per node.
			(globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 16)))(flush);
		});
		observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	} catch (_) { /* a document not ready for observation is not an error */ }
})();`;

interface PageInputProducerOptions {
	readonly record: SessionRecord;
	readonly logger?: { warn(message: string): void };
	readonly now?: () => number;
	/**
	 * Called with the mutation count from one binding batch. The `dom.settled` producer owns the debounce and the
	 * token read; this producer only forwards the count, because the injection is shared and the input listener is
	 * where it lives.
	 */
	readonly onMutation?: (count: number) => void;
}

/** What one attached CDP session had installed, so it can be taken back off. */
interface Injected {
	/** The `Page.addScriptToEvaluateOnNewDocument` identifier, for removal. */
	readonly identifier: string | null;
}

/**
 * Installs the listener into every attachable CDP session of one browser session, and mints `input` records from what
 * comes back.
 */
export class PageInputProducer {
	readonly #record: SessionRecord;
	readonly #client: CdpClient;
	readonly #logger: { warn(message: string): void } | undefined;
	readonly #now: () => number;
	readonly #onMutation: ((count: number) => void) | undefined;
	readonly #bindingName: string;
	readonly #worldName: string;
	readonly #injected = new Map<SessionId, Injected>();
	readonly #unsubscribes: Array<() => void> = [];
	#windowStart = 0;
	#windowCalls = 0;
	#windowDropped = 0;
	#disposed = false;

	private constructor(options: PageInputProducerOptions, client: CdpClient) {
		this.#record = options.record;
		this.#client = client;
		this.#logger = options.logger;
		this.#now = options.now ?? (() => Date.now());
		this.#onMutation = options.onMutation;
		// Per session and random, never a constant: a constant name is a stable
		// automation fingerprint and, worse, something a page could look for.
		const seed = crypto.randomUUID().replaceAll('-', '');
		this.#bindingName = `ttkb_${seed}`;
		this.#worldName = `ttkw_${seed}`;
	}

	/** The isolated world this session's listener runs in. Exposed for tests. */
	get worldName(): string {
		return this.#worldName;
	}

	/** The per-session binding name. Exposed for tests; never a constant. */
	get bindingName(): string {
		return this.#bindingName;
	}

	/** CDP sessions currently carrying the injection. */
	get injectedSessions(): number {
		return this.#injected.size;
	}

	/**
	 * Attaches to a session, or returns `null` when there is no CDP client to
	 * attach to (a remote-attached or not-yet-started session).
	 */
	static attach(options: PageInputProducerOptions): PageInputProducer | null {
		const client = options.record.session.cdpClient;
		if (client === null || client === undefined) return null;
		const producer = new PageInputProducer(options, client);
		producer.#start();
		return producer;
	}

	#start(): void {
		this.#unsubscribes.push(
			this.#client.on('Runtime.bindingCalled', (params, sessionId) => this.#onBinding(params, sessionId)),
			this.#client.on('Target.attachedToTarget', (params) => {
				if (!INJECTABLE_TYPES.has(params.targetInfo.type)) return;
				void this.#install(params.sessionId);
			}),
			this.#client.on('Target.detachedFromTarget', (params) => {
				// A detached session's script and binding went with it; forgetting the
				// record is the whole cleanup, and doing it here keeps the map bounded
				// by the number of live frames rather than by the session's lifetime.
				this.#injected.delete(params.sessionId);
			}),
		);
		// Frames attached before this producer existed get the injection too, and `runImmediately` is what makes it
		// take effect on the document already loaded rather than only on the next one.
		const manager = this.#record.session.sessionManager;
		if (manager === null || manager === undefined) return;
		for (const [sessionId, session] of manager.sessions) {
			if (!INJECTABLE_TYPES.has(session.type)) continue;
			void this.#install(sessionId);
		}
	}

	async #install(sessionId: SessionId): Promise<void> {
		if (this.#disposed || this.#injected.has(sessionId)) return;
		// Claimed before the awaits so two `attachedToTarget` for one session cannot both install.
		this.#injected.set(sessionId, { identifier: null });
		try {
			// `Runtime.enable` is what makes `bindingCalled` flow at all.
			await this.#client.send.Runtime.enable(undefined, sessionId);
			// `executionContextName` is the control that keeps this out of the page's own world. Without it the
			// binding is a `window.<name>` function every page script can see and call.
			await this.#client.send.Runtime.addBinding(
				{ name: this.#bindingName, executionContextName: this.#worldName },
				sessionId,
			);
			const result = await this.#client.send.Page.addScriptToEvaluateOnNewDocument(
				{
					source: LISTENER_SOURCE.replaceAll('__TTK_BINDING__', this.#bindingName),
					worldName: this.#worldName,
					runImmediately: true,
				},
				sessionId,
			);
			this.#injected.set(sessionId, { identifier: result.identifier });
		} catch (cause) {
			// A frame that went away mid-install is ordinary, not an error worth a
			// line per frame. The entry is dropped so a later attach can retry.
			this.#injected.delete(sessionId);
			this.#logger?.warn(
				`input listener could not be installed on ${sessionId}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
	}

	#onBinding(params: { name: string; payload: string }, sessionId: SessionId | undefined): void {
		if (this.#disposed) return;
		// (a) Not ours. A page cannot guess the name, but a second producer's
		// binding on the same client would otherwise be read as this one's.
		if (params.name !== this.#bindingName) return;
		// (b) Bounded before anything is parsed: the parse is the cost a page
		// would otherwise choose for us, synchronously, on the CDP reader loop.
		if (params.payload.length > MAX_BINDING_PAYLOAD_BYTES) {
			this.#chargeDrop();
			return;
		}
		// (c) Counted on calls rather than on appends, so a page cannot pay only
		// for the records that survive the ring's own cap.
		if (!this.#charge()) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(params.payload);
		} catch {
			// Never logged per call: a listener that logged would turn the binding
			// into a page-driven log amplifier, one line per call.
			return;
		}
		// The mutation half: a `{d: count}` batch feeds the settle producer and never mints an `input` record.
		const mutations = (parsed as { d?: unknown } | null)?.d;
		if (typeof mutations === 'number' && Number.isFinite(mutations) && mutations > 0) {
			// Floored so a fractional count a hostile page might send never reaches the
			// wire as a non-integer mutation total.
			this.#onMutation?.(Math.min(Math.floor(mutations), 100_000));
			return;
		}
		const raw = (parsed as { k?: unknown } | null)?.k;
		const kind: InputEventKind = typeof raw === 'string' && (INPUT_EVENT_KINDS as readonly string[]).includes(raw)
			? raw as InputEventKind
			: 'other';
		this.#mint(kind, sessionId);
	}

	/** Builds the record from server-side state alone. */
	#mint(kind: InputEventKind, sessionId: SessionId | undefined): void {
		const targetId = sessionId === undefined
			? null
			: this.#record.session.sessionManager?.sessionTargets.get(sessionId) ?? null;
		const node = this.#focusedNode(targetId);
		this.#record.events.append('input', {
			// `null` rather than an index the page chose. A consumer that needs the
			// element reads `browser_get_state`, whose index table it can trust.
			element_index: node?.index ?? null,
			kind,
			// Derived from the lock, not from the page. This is the field the whole human-takeover story rests on.
			source: this.#record.lock === null ? 'tool' : 'human',
			// Fails closed: `false` is the assertion that costs something.
			value_masked: node === null ? true : isPasswordField(node.node),
		}, targetId);
	}

	/** The server's own view of what has focus in one frame. */
	#focusedNode(targetId: TargetId | null): { index: number; node: EnhancedDomTreeNode } | null {
		const map = this.#record.session.cachedBrowserState?.domState?.selectorMap;
		if (map === undefined || map === null) return null;
		let fallback: { index: number; node: EnhancedDomTreeNode } | null = null;
		for (const [index, node] of map.entries()) {
			if (!isFocused(node)) continue;
			const entry = { index, node };
			if (targetId !== null && node.frameId === targetId) return entry;
			fallback ??= entry;
		}
		// With no frame to match on, the single focused node is the answer; with a
		// frame that holds no focused node, so is the session's only focus.
		return fallback;
	}

	#rollWindow(): void {
		const now = this.#now();
		if (now - this.#windowStart < RATE_WINDOW_MS) return;
		if (this.#windowDropped > 0) {
			// One control record per window, never one per dropped call.
			this.#record.events.appendControl('rate-capped', { kind: 'input', dropped: this.#windowDropped });
		}
		this.#windowStart = now;
		this.#windowCalls = 0;
		this.#windowDropped = 0;
	}

	#charge(): boolean {
		this.#rollWindow();
		if (this.#windowCalls >= MAX_BINDING_CALLS_PER_SECOND) {
			this.#windowDropped += 1;
			return false;
		}
		this.#windowCalls += 1;
		return true;
	}

	#chargeDrop(): void {
		this.#rollWindow();
		this.#windowDropped += 1;
	}

	/**
	 * The single removal path: takes the script and the binding back off every
	 * session that has them, and stops listening. Idempotent.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const off of this.#unsubscribes.splice(0)) off();
		const entries = [...this.#injected.entries()];
		this.#injected.clear();
		for (const [sessionId, injected] of entries) {
			if (injected.identifier !== null) {
				await this.#client.send.Page.removeScriptToEvaluateOnNewDocument(
					{ identifier: injected.identifier },
					sessionId,
				).catch(() => {});
			}
			await this.#client.send.Runtime.removeBinding({ name: this.#bindingName }, sessionId).catch(() => {});
		}
	}
}

// --- `console`: `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`, armed on subscription ------------------

/** The closed `console.level` vocabulary. Every CDP console type maps into it. */
export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** Longest text this producer hands the ring; the ring caps at 512 as well, this bounds the join. */
export const MAX_CONSOLE_TEXT = 512;

/** One `RemoteObject` rendered to a short string, without dereferencing a handle. */
function renderArg(arg: {
	type?: string;
	subtype?: string;
	value?: unknown;
	description?: string;
	unserializableValue?: string;
}): string {
	if (arg.type === 'string') return String(arg.value ?? '');
	if (arg.value !== undefined && arg.value !== null && typeof arg.value !== 'object') return String(arg.value);
	if (arg.unserializableValue !== undefined) return arg.unserializableValue;
	// `description` is what devtools shows for an object/function/error without dereferencing its `objectId` — a
	// class name and the browser's own preview.
	if (arg.description !== undefined) return arg.description;
	return arg.subtype ?? arg.type ?? '';
}

/** The CDP console `type` mapped to the closed level set. */
export function consoleLevelOf(type: string): ConsoleLevel {
	switch (type) {
		case 'error':
		case 'assert':
			return 'error';
		case 'warning':
			return 'warn';
		case 'debug':
		case 'trace':
			return 'debug';
		case 'info':
		case 'count':
		case 'timeEnd':
			return 'info';
		default:
			return 'log';
	}
}

/** Attaches the console listeners to one browser session's CDP client, gated by the ring's console refcount. */
export class ConsoleProducer {
	readonly #record: SessionRecord;
	readonly #client: CdpClient;
	/** The server's secret redaction, applied before a line is capped; the identity without one. */
	readonly #redact: (text: string) => string;
	#offs: Array<() => void> = [];
	#armed = false;
	#disposed = false;

	private constructor(record: SessionRecord, client: CdpClient, redact: (text: string) => string) {
		this.#record = record;
		this.#client = client;
		this.#redact = redact;
	}

	/** Whether the listeners are currently attached. Exposed for tests. */
	get armed(): boolean {
		return this.#armed;
	}

	/**
	 * Builds a producer, or returns `null` when the session has no CDP client to
	 * attach to (a remote-attached or not-yet-started session).
	 */
	static attach(record: SessionRecord, redact?: (text: string) => string): ConsoleProducer | null {
		const client = record.session.cdpClient;
		if (client === null || client === undefined) return null;
		return new ConsoleProducer(record, client, redact ?? ((text) => text));
	}

	/** The callback the ring calls on its refcount crossing zero. */
	setArmed = (armed: boolean): void => {
		if (this.#disposed || armed === this.#armed) return;
		this.#armed = armed;
		if (!armed) {
			for (const off of this.#offs.splice(0)) off();
			return;
		}
		this.#offs = [
			this.#client.on('Runtime.consoleAPICalled', (params) => {
				// The server's secrets are redacted before the cap, never after it.
				const joined = this.#redact((params.args ?? []).map(renderArg).join(' '));
				const text = joined.slice(0, MAX_CONSOLE_TEXT);
				this.#record.events.append('console', {
					level: consoleLevelOf(params.type),
					text,
					truncated: joined.length > MAX_CONSOLE_TEXT,
				});
			}),
			this.#client.on('Runtime.exceptionThrown', (params) => {
				const details = params.exceptionDetails;
				const joined = this.#redact(
					[details.text, details.exception?.description]
						.filter((part): part is string => typeof part === 'string' && part !== '')
						.join(' '),
				);
				const text = joined.slice(0, MAX_CONSOLE_TEXT);
				this.#record.events.append('console', { level: 'error', text, truncated: joined.length > MAX_CONSOLE_TEXT });
			}),
		];
	};

	/** Removes the listeners and stops responding to arm/disarm. Idempotent. */
	dispose(): void {
		this.#disposed = true;
		this.#armed = false;
		for (const off of this.#offs.splice(0)) off();
	}
}

// --- `dom.settled` ------------------------------------------------------------------------------------------------

/** The quiet window a `dom.settled` record is minted after, by default. */
export const DOM_SETTLE_QUIET_MS = 500;

interface DomSettleProducerOptions {
	readonly record: SessionRecord;
	/** Milliseconds of quiet before a settle. Defaults to {@linkcode DOM_SETTLE_QUIET_MS}. */
	readonly quietMs?: number;
	readonly logger?: { warn(message: string): void };
}

/** Debounces mutation batches into one `dom.settled` per quiet transition. */
export class DomSettleProducer {
	readonly #record: SessionRecord;
	readonly #quietMs: number;
	readonly #logger: { warn(message: string): void } | undefined;
	#pending = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#minting = false;
	#disposed = false;

	constructor(options: DomSettleProducerOptions) {
		this.#record = options.record;
		this.#quietMs = options.quietMs ?? DOM_SETTLE_QUIET_MS;
		this.#logger = options.logger;
	}

	/** Mutations accumulated toward the next settle. Exposed for tests. */
	get pending(): number {
		return this.#pending;
	}

	/** True while a settle read is in flight. Exposed for tests. */
	get minting(): boolean {
		return this.#minting;
	}

	/** Records one batch of mutations and restarts the quiet window. */
	onMutation = (count: number): void => {
		if (this.#disposed) return;
		this.#pending += count;
		this.#arm();
	};

	#arm(): void {
		this.#disarm();
		const timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#settle();
		}, this.#quietMs);
		// Never the reason the runtime stays alive: a settle is worth minting when
		// the process is up anyway, not worth holding it open.
		Deno.unrefTimer(timer as unknown as number);
		this.#timer = timer;
	}

	#disarm(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	async #settle(): Promise<void> {
		if (this.#disposed || this.#minting) return;
		const mutations = this.#pending;
		this.#pending = 0;
		// The gate: no subscriber, no read. The mutations were observed for free;
		// the token is what costs, so it is paid only when someone wants the kind.
		if (mutations === 0 || this.#record.events.domSettledSubscribers === 0) return;
		this.#minting = true;
		try {
			// The token must equal what `browser_get_state` would return now, so it comes from an actual read rather
			// than a cached value that predates the settle. `includeDom: true` is the single-writer path that mints
			// the token.
			const summary = await this.#record.session.getBrowserStateSummary({ includeDom: true });
			if (this.#disposed) return;
			this.#record.events.append('dom.settled', {
				token: summary.stateToken ?? null,
				mutations,
				quiet_ms: this.#quietMs,
			});
		} catch (error) {
			// A read that failed is not a settle worth minting a token for; the next quiet window will try again.
			// Never per-batch, so a failing read cannot become a log amplifier.
			this.#logger?.warn(`dom.settled read failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#minting = false;
		}
	}

	/** Clears the pending timer and stops accepting batches. Idempotent. */
	dispose(): void {
		this.#disposed = true;
		this.#disarm();
	}
}
