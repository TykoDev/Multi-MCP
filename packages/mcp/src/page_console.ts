/**
 * The `console` kind's producer: `Runtime.consoleAPICalled` and
 * `Runtime.exceptionThrown`, armed on subscription rather than on the domain.
 *
 * ## Why arming is refcounted, not domain-driven
 *
 * `Runtime.enable` is already issued per attached session by the `input`
 * producer (B1.9), so `consoleAPICalled` and `exceptionThrown` *flow* whether or
 * not anyone wants console records. The rule the design fixes (report_design.md
 * §7.3, and the note at `page_input.ts`) is that a `console` record is minted
 * only while the ring's `consoleSubscribers` refcount is above zero: console
 * output from before the first subscription **does not exist**, because nobody
 * asked for it, and minting it would either grow the ring for an idle session or
 * — worse — let a consumer read the silence that follows an arm as "the page was
 * quiet". So this producer's listeners are attached on the arm transition and
 * removed on the disarm transition, and the ring announces both as `control`
 * records so a consumer reads a coverage boundary rather than inferring one.
 *
 * ## What reaches the ring, and what cannot
 *
 * A console record carries `{level, text, truncated}` and nothing else. The text
 * is built server-side from the CDP arguments — a page cannot choose the record
 * shape — and capped by the ring's own `console` payload cap (512), so a page
 * that logs a megabyte pays once for a truncated record rather than growing the
 * ring without bound. No `RemoteObject` handle, `objectId`, stack frame, url or
 * source position reaches the wire: a url is where a token lives (SECURITY-AUTH
 * §8.3), and a handle would be a live reference into the page. The level is
 * mapped to a closed set, so it is not page-authored text in a cross-principal
 * ring.
 */
import type { CdpClient } from '@tykotech/cdp';
import type { SessionRecord } from './registry.ts';

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
	// `description` is what devtools shows for an object/function/error without
	// dereferencing its `objectId` — a class name and the browser's own preview.
	// For an `Error` it does include the page-authored message and stack text,
	// which is page-chosen console content the contract accepts (the record's
	// text is *shaped* server-side, not censored): it is bounded at
	// `MAX_CONSOLE_TEXT` and carries nothing the page did not itself print. It is
	// never a browser-issued URL the way a navigation is (§8.3 guards those).
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

/**
 * Attaches the console listeners to one browser session's CDP client, gated by
 * the ring's console refcount.
 *
 * One instance per {@linkcode SessionRecord}, constructed unarmed. The ring's
 * `setConsoleArmed` toggles it; {@linkcode ConsoleProducer.dispose} is the
 * single teardown and is idempotent.
 */
export class ConsoleProducer {
	readonly #record: SessionRecord;
	readonly #client: CdpClient;
	/** Review R2-7: the server's secret redaction, applied before a line is capped; the identity without one. */
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

	/**
	 * The callback the ring calls on its refcount crossing zero. Attaches on the
	 * arm and removes on the disarm, so `Runtime.consoleAPICalled` is *listened
	 * to* only while a subscriber wants it, even though the domain is enabled
	 * throughout.
	 */
	setArmed = (armed: boolean): void => {
		if (this.#disposed || armed === this.#armed) return;
		this.#armed = armed;
		if (!armed) {
			for (const off of this.#offs.splice(0)) off();
			return;
		}
		this.#offs = [
			this.#client.on('Runtime.consoleAPICalled', (params) => {
				// Review R2-7: the server's secrets are redacted before the cap, never after it.
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
