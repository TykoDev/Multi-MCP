/**
 * The `input` kind's producer: an injected page listener and a CDP binding (B1.9).
 *
 * This is the one event source in the product whose *producer is the page*, and
 * everything below follows from that single fact.
 *
 * ## The rule this module is written to
 *
 * **The binding payload contributes at most a bounded, closed-enum event type.
 * Every other field of the record is minted from server-side state keyed on the
 * CDP `sessionId`.** `Runtime.bindingCalled` delivers a string the page chose,
 * on a channel any script in any frame can call as often as it likes. So:
 *
 * - `source` is **never** read from the payload. It is derived from the
 *   session's takeover lock. A page that could write `source: 'human'` would be
 *   fabricating audit evidence — a record asserting that a human operator typed
 *   into a field, replayable by every `mcp:invoke` holder from the ring's tail.
 * - `value_masked` is **never** read from the payload, and **fails closed**. It
 *   is derived by running the single password predicate over the server's own
 *   node. A page that could write `false` on its real password field would be
 *   telling a consumer the field is ordinary — that is, safe to read into an LLM
 *   transcript — which is a lure aimed squarely at the contract DD-7 publishes.
 *   When no node resolves, the answer is `true`, because `false` is the
 *   assertion that costs something.
 * - `element_index` is **never** read from the payload. A forged index points a
 *   consumer, and any tool it then calls, at an element of the page's choosing
 *   through the same index table `nodeAt` resolves against. It is derived from
 *   the server's own focus for the frame the CDP `sessionId` names, and is
 *   `null` when the server does not hold a current table. The record still
 *   mints: the *fact* of typing survives, the forgeable pointer does not.
 *
 * ## What the injected script may do, and may not
 *
 * It runs in a **named isolated world**, so it defines nothing on the page's own
 * `window` and the binding is not a function page script can call or discover.
 * The binding name and the world name are per-session random, never constants.
 *
 * The script reads **nothing**: no element value, no length, no selection, no
 * `textContent`, no cookie, no storage. It reports one event type from a closed
 * set and nothing else. It especially must never report anything whose value
 * differs by frame origin — the frame's URL, `document.referrer`,
 * `window.top === window`, an ancestor count — because the binding is a
 * server-side channel out of every cross-origin subframe, and any such read
 * would turn it into a cross-origin side channel the page could not otherwise
 * obtain.
 *
 * ## What an `input` record is not
 *
 * It is **not** an audit trail, and the documentation says so beside the record
 * rather than leaving a consumer to assume otherwise. A page can synthesise
 * `new InputEvent('input', {bubbles: true})`, and a page can register its own
 * capture listener and call `stopImmediatePropagation()` on a real one. The
 * script therefore drops any event whose `isTrusted` is false, which closes the
 * first half; the second half is not closable from inside the page at all. So
 * the presence of an `input` record is not proof that typing happened, and its
 * absence is not proof that it did not.
 */
import type { CdpClient, SessionId, TargetId } from '@tykotech/cdp';
import { isPasswordField } from '@tykotech/browser';
import type { EnhancedDomTreeNode } from '@tykotech/browser';
import { isFocused } from './element_record.ts';
import { CONTENT_RATE_PER_SECOND, RATE_WINDOW_MS } from './events.ts';
import type { SessionRecord } from './registry.ts';

/**
 * The closed `input.kind` vocabulary.
 *
 * Closed, and mapped server-side, so `kind` is not a page-authored string in a
 * cross-principal ring. Without this the design's "fixed — no variable-length
 * field" claim for the `input` payload would simply not be true.
 */
export const INPUT_EVENT_KINDS = ['input', 'change', 'submit', 'other'] as const;
export type InputEventKind = (typeof INPUT_EVENT_KINDS)[number];

/**
 * Bytes one binding call may carry.
 *
 * The transport's own inbound bound is 200 MiB and CDP dispatch is synchronous
 * on the reader loop, so an unbounded binding is a page-driven stall of the
 * screencast, the downloads and the navigation sharing that socket. The payload
 * this module needs is one short JSON object; anything larger is malformed or
 * hostile and is dropped **before** `JSON.parse`.
 */
export const MAX_BINDING_PAYLOAD_BYTES = 512;

/** Binding calls admitted per session per second, counted on calls rather than on appends. */
export const MAX_BINDING_CALLS_PER_SECOND = CONTENT_RATE_PER_SECOND;

/** CDP target types that get the injection. A worker has no DOM to type into. */
const INJECTABLE_TYPES: ReadonlySet<string> = new Set(['page', 'iframe']);

/**
 * The injected listener.
 *
 * Deliberately tiny and deliberately blind. `__TTK_BINDING__` is substituted
 * with the per-session random name before injection.
 */
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
	// The DOM-mutation half of the shared injection (D-8): a MutationObserver
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

export interface PageInputProducerOptions {
	readonly record: SessionRecord;
	readonly logger?: { warn(message: string): void };
	readonly now?: () => number;
	/**
	 * Called with the mutation count from one binding batch (D-8). The
	 * `dom.settled` producer owns the debounce and the token read; this producer
	 * only forwards the count, because the injection is shared and the input
	 * listener is where it lives.
	 */
	readonly onMutation?: (count: number) => void;
}

/** What one attached CDP session had installed, so it can be taken back off. */
interface Injected {
	/** The `Page.addScriptToEvaluateOnNewDocument` identifier, for removal. */
	readonly identifier: string | null;
}

/**
 * Installs the listener into every attachable CDP session of one browser
 * session, and mints `input` records from what comes back.
 *
 * One instance per {@linkcode SessionRecord}. {@linkcode PageInputProducer.dispose}
 * is the single removal path and is idempotent: without it the injected listener
 * and a live binding would survive in every frame for the session's life after
 * the last subscriber has gone, which is exactly the defect the ring's `console`
 * refcount exists to prevent.
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
		// Frames attached before this producer existed get the injection too, and
		// `runImmediately` is what makes it take effect on the document already
		// loaded rather than only on the next one.
		const manager = this.#record.session.sessionManager;
		if (manager === null || manager === undefined) return;
		for (const [sessionId, session] of manager.sessions) {
			if (!INJECTABLE_TYPES.has(session.type)) continue;
			void this.#install(sessionId);
		}
	}

	async #install(sessionId: SessionId): Promise<void> {
		if (this.#disposed || this.#injected.has(sessionId)) return;
		// Claimed before the awaits so two `attachedToTarget` for one session
		// cannot both install.
		this.#injected.set(sessionId, { identifier: null });
		try {
			// `Runtime.enable` is what makes `bindingCalled` flow at all. It also
			// starts `consoleAPICalled` and `exceptionThrown` flowing; nothing in
			// this build subscribes to those, and when a `console` producer is built
			// it must gate on the ring's `consoleSubscribers` refcount rather than on
			// this domain toggle — or arming would follow the input channel instead
			// of the subscriber.
			await this.#client.send.Runtime.enable(undefined, sessionId);
			// `executionContextName` is the control that keeps this out of the page's
			// own world. Without it the binding is a `window.<name>` function every
			// page script can see and call.
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
		// The mutation half (D-8): a `{d: count}` batch feeds the settle producer
		// and never mints an `input` record.
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

	/**
	 * Builds the record from server-side state alone.
	 *
	 * The frame comes from the CDP `sessionId` the client hands every listener,
	 * never from the payload — a cross-origin subframe that could name its own
	 * frame could name the top document's instead.
	 */
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
			// Derived from the lock, not from the page. This is the field the whole
			// human-takeover story rests on.
			source: this.#record.lock === null ? 'tool' : 'human',
			// Fails closed: `false` is the assertion that costs something.
			value_masked: node === null ? true : isPasswordField(node.node),
		}, targetId);
	}

	/**
	 * The server's own view of what has focus in one frame.
	 *
	 * `null` whenever the server does not hold a current index table, which is
	 * the honest answer: an index resolved against a table the browser has left
	 * is worse than no index at all (G-1).
	 */
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
