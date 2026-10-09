/**
 * U-6, on a real browser: does the injected page listener reach a cross-origin
 * frame, and does it survive a navigation?
 *
 * This is B1.9's gate. Both legs run against real Chromium with a real OOPIF,
 * because the question is about Chromium's own world and frame lifetimes and
 * nothing short of Chromium answers it. The third assertion is the one SEC-03
 * turns on: a distinctive string is typed and the **whole emitted stream** is
 * searched for it, so the claim "no `input` event carries character data" is
 * checked against every byte the transport produced rather than against the
 * fields the producer happens to name.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';

/** The rich record lives in `structuredContent`; the text block is the five frozen fields. */
interface RichElement {
	index: number;
	attrs?: Record<string, string>;
}

/** Resolves an element by its `id` attribute, which only the rich record carries. */
async function elementById(h: Harness, id: string, args: Record<string, unknown> = {}): Promise<RichElement> {
	const result = await h.call('browser_get_state', { fields: ['full'], element_limit: 2000, ...args });
	const state = result.structuredContent as unknown as { interactive_elements: RichElement[] };
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `no element with id ${id}`);
	return found;
}

const ignore = skipUnlessBrowser('session events e2e');

/** A string chosen so its appearance anywhere in the stream is unambiguous. */
const TYPED = 'zzU6SENTINELzz';

interface EventRecord {
	kind: string;
	seq: number;
	at: string;
	tab_id: string | null;
	payload: Record<string, unknown>;
}

/**
 * An SSE reader that keeps every byte it saw.
 *
 * The raw text matters as much as the parsed records: the sentinel search below
 * is over `raw`, so a value smuggled into a field this test never names would
 * still be caught.
 */
class Stream implements AsyncDisposable {
	readonly records: EventRecord[] = [];
	raw = '';
	#reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	#pump: Promise<void> = Promise.resolve();

	static async open(h: Harness, query: string): Promise<Stream> {
		const stream = new Stream();
		const response = await h.fetch(`/api/v1/sessions/default/events${query}`, {
			headers: { accept: 'text/event-stream' },
		});
		assertEquals(response.status, 200, `the stream did not open: ${response.status}`);
		assert(response.body !== null);
		stream.#reader = response.body.getReader();
		stream.#pump = stream.#read();
		return stream;
	}

	async #read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const { value, done } = await this.#reader!.read();
				if (done) return;
				const text = decoder.decode(value, { stream: true });
				this.raw += text;
				buffer += text;
				let boundary = buffer.indexOf('\n\n');
				while (boundary !== -1) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					for (const line of frame.split('\n')) {
						if (!line.startsWith('data: ')) continue;
						try {
							this.records.push(JSON.parse(line.slice(6)) as EventRecord);
						} catch { /* a keep-alive comment is not data */ }
					}
					boundary = buffer.indexOf('\n\n');
				}
			}
		} catch { /* cancelled */ }
	}

	/** Waits for a record matching `predicate`, or fails with what did arrive. */
	async until(predicate: (record: EventRecord) => boolean, what: string, timeoutMs = 15_000): Promise<EventRecord> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.records.find(predicate);
			if (found !== undefined) return found;
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${what}; saw [${this.records.map((r) => r.kind).join(', ')}]`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.#reader?.cancel().catch(() => {});
		await this.#pump;
	}
}

Deno.test({
	name: 'e2e events: U-6 — the injected input listener, across frames and across navigation',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });
		await h.callText('browser_navigate', { url: h.site.page('index') });
		await using stream = await Stream.open(h, '?kinds=input,focus,navigation');

		// Every stream states its epoch before it waits.
		const open = await stream.until(
			(record) => record.payload.event === 'stream-open',
			'the stream-open control record',
		);
		assertEquals(typeof open.payload.epoch, 'string');

		await t.step('a same-origin field reports typing, with no character data', async () => {
			const field = await elementById(h, 'field');
			await h.callText('browser_type', { index: field.index, text: TYPED });

			const record = await stream.until((entry) => entry.kind === 'input', 'an input record from the top document');
			// The four fields SEC-03 fixed, and nothing else.
			assertEquals(
				Object.keys(record.payload).sort(),
				['element_index', 'kind', 'source', 'value_masked'],
			);
			// A tool typed, and the page cannot say otherwise.
			assertEquals(record.payload.source, 'tool');
			assertEquals(typeof record.payload.value_masked, 'boolean');
			// The browser really received it.
			const html = await h.callText('browser_get_html', {});
			assert(html.includes(TYPED), 'the text never reached the page, so this leg proves nothing');
		});

		await t.step('the listener is re-injected after a navigation', async () => {
			// The whole of U-6's second half: an injection that did not survive a
			// document swap would report the first page and then go quiet, and the
			// silence would read as "nobody typed".
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const before = stream.records.filter((entry) => entry.kind === 'input').length;
			const target = await elementById(h, 'target');
			await h.callText('browser_type', { index: target.index, text: TYPED });
			await stream.until(
				(entry) => entry.kind === 'input' && stream.records.indexOf(entry) >= before,
				'an input record after a navigation',
			);
			assert(
				stream.records.filter((entry) => entry.kind === 'input').length > before,
				'the listener did not survive the navigation',
			);
		});

		await t.step('a cross-origin frame reports typing too', async () => {
			// The OOPIF leg. The child is served from a second origin, so Chromium
			// puts it in its own renderer and its own CDP session: an injection that
			// only reached the top document would produce nothing here.
			await h.callText('browser_navigate', { url: h.site.page('oopif') });
			const before = stream.records.filter((entry) => entry.kind === 'input').length;
			const field = await elementById(h, 'frame-field', { frames: 'all' });
			await h.callText('browser_type', { index: field.index, text: TYPED });
			await stream.until(
				(entry) => entry.kind === 'input' && stream.records.indexOf(entry) >= before,
				'an input record from the cross-origin frame',
			);
		});

		await t.step('SEC-03: the typed string appears nowhere in the emitted stream', async () => {
			// Over the raw bytes, not over the fields this test happens to name: a
			// value smuggled into a field nobody thought to check is still caught.
			assertEquals(stream.raw.includes(TYPED), false, 'a typed value reached the event stream');
			assertEquals(stream.raw.includes(TYPED.slice(0, 6)), false, 'a prefix of a typed value reached the stream');

			// And no *length* either, which a substring search cannot decide — the
			// digits of a length collide with ordinary sequence numbers. The check
			// that actually decides it is the shape: every `input` record carries
			// exactly the four fields SEC-03 fixed, on every leg, so there is no
			// field a length could be in. A length is a password-strength oracle
			// even on a field the caller knows is not a password.
			const inputs = stream.records.filter((entry) => entry.kind === 'input');
			assert(inputs.length >= 3, `expected a record from each leg, saw ${inputs.length}`);
			for (const record of inputs) {
				assertEquals(Object.keys(record.payload).sort(), ['element_index', 'kind', 'source', 'value_masked']);
				assertEquals(typeof record.payload.value_masked, 'boolean', 'value_masked is a marker, never a quantity');
			}
			await Promise.resolve();
		});
	},
});

Deno.test({
	name: 'e2e events: focus and input are SSE-only and never reach a live-view socket',
	ignore,
	async fn() {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });
		await h.callText('browser_navigate', { url: h.site.page('index') });

		const socket = await h.live();
		await socket.ready();
		socket.send({ type: 'events.subscribe', kinds: ['input', 'focus', 'navigation'] });
		// Both content kinds are refused by name rather than dropped in silence.
		const refused: string[] = [];
		const deadline = Date.now() + 10_000;
		while (refused.length < 2 && Date.now() < deadline) {
			for (const message of socket.messages) {
				if (message.type !== 'event') continue;
				if (message.event.payload.event !== 'kind-unavailable') continue;
				const kind = message.event.payload.kind as string;
				if (!refused.includes(kind)) refused.push(kind);
			}
			if (refused.length < 2) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assertEquals(refused.sort(), ['focus', 'input']);

		// And typing really does mint records on the other transport, so this is a
		// statement about the socket rather than about an idle session.
		const field = await elementById(h, 'field');
		await h.callText('browser_type', { index: field.index, text: TYPED });
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const carried = socket.messages
			.filter((message) => message.type === 'event')
			.map((message) => (message as { event: EventRecord }).event.kind);
		assertEquals(carried.includes('input'), false, 'an input record reached a view:watch socket');
		assertEquals(carried.includes('focus'), false, 'a focus record reached a view:watch socket');
		assertEquals(JSON.stringify(socket.messages).includes(TYPED), false);
		await socket.close();
	},
});

Deno.test({
	name: 'e2e events: console records are armed on subscription and carry level and text (owner item 3)',
	ignore,
	async fn() {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });
		await h.callText('browser_navigate', { url: h.site.page('content') });
		// The stream must NAME console in its filter: the kind is refcount-armed,
		// so an unfiltered stream would not arm it and the page's console output
		// would never be minted.
		await using stream = await Stream.open(h, '?kinds=console');
		await stream.until((record) => record.payload.event === 'stream-open', 'stream-open');

		const button = await elementById(h, 'log');
		await h.callText('browser_click', { index: button.index });

		const warn = await stream.until(
			(entry) => entry.kind === 'console' && entry.payload.level === 'warn',
			'a warn console record',
		);
		assertEquals(Object.keys(warn.payload).sort(), ['level', 'text', 'truncated']);
		assert(String(warn.payload.text).startsWith('warn-'), `unexpected text ${warn.payload.text}`);
		const levels = stream.records.filter((entry) => entry.kind === 'console').map((entry) => entry.payload.level);
		assert(levels.includes('error'), `expected an error level among ${levels.join(',')}`);
		// No handle, url or source position — only the two declared fields plus the cap flag.
		for (const entry of stream.records.filter((record) => record.kind === 'console')) {
			assertEquals(Object.keys(entry.payload).sort(), ['level', 'text', 'truncated']);
		}
	},
});

Deno.test({
	name: 'e2e events: dom.settled fires after quiet and its token equals browser_get_state (owner item 3)',
	ignore,
	async fn() {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });
		await h.callText('browser_navigate', { url: h.site.page('content') });
		// dom.settled is refcount-armed for the same reason console is: minting it
		// costs a state read. The subscription names it explicitly.
		await using stream = await Stream.open(h, '?kinds=dom.settled');
		await stream.until((record) => record.payload.event === 'stream-open', 'stream-open');

		const button = await elementById(h, 'mutate');
		await h.callText('browser_click', { index: button.index });

		const settled = await stream.until((entry) => entry.kind === 'dom.settled', 'a dom.settled record', 20_000);
		assertEquals(Object.keys(settled.payload).sort(), ['mutations', 'quiet_ms', 'token']);
		assertEquals(settled.payload.quiet_ms, 500);
		assert(Number(settled.payload.mutations) > 0, 'the mutation burst was counted');
		assert(typeof settled.payload.token === 'string' && (settled.payload.token as string).length > 0);

		// The contract: the token equals the state_token browser_get_state returns
		// at that moment. The page is quiet now, so a read taken now must agree.
		const result = await h.call('browser_get_state', {});
		const state = result.structuredContent as unknown as { state_token: string };
		assertEquals(settled.payload.token, state.state_token, 'the settle token must equal the current state_token');
	},
});
