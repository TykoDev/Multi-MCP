/**
 * Session events on real Chromium: the injected input listener reaches a cross-origin frame and survives a
 * navigation, no typed character, prefix or length reaches the stream (searched over every byte), the content kinds
 * never reach a live-view socket, and the refcount-armed `console` and `dom.settled` kinds.
 */
import { assert, assertEquals } from '@std/assert';
import { EventStream, type Harness, harness, skipUnlessBrowser, type StreamRecord } from '../support/harness.ts';

const ignore = skipUnlessBrowser('session events e2e');

/** A string whose appearance anywhere in the stream is unambiguous. */
const TYPED = 'zzU6SENTINELzz';
const INPUT_FIELDS = ['element_index', 'kind', 'source', 'value_masked'];

/** Resolves an element by its `id` attribute, which only the structured record carries. */
async function elementById(h: Harness, id: string, args: Record<string, unknown> = {}): Promise<number> {
	const state = await h.callStructured<
		{ interactive_elements: Array<{ index: number; attrs?: Record<string, string> }> }
	>(
		'browser_get_state',
		{ fields: ['full'], element_limit: 2000, ...args },
	);
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `no element with id ${id}`);
	return found.index;
}

Deno.test({
	name: 'e2e events: the injected input listener, across frames and across navigation, and never on a socket',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });
		await h.callText('browser_navigate', { url: h.site.page('index') });
		await using stream = await EventStream.open(h, '?kinds=input,focus,navigation');
		const socket = await h.live();
		socket.send({ type: 'events.subscribe', kinds: ['input', 'focus', 'navigation'] });
		const inputs = () => stream.records.filter((entry) => entry.kind === 'input');
		/** Types the sentinel into an element and waits for a new input record. */
		const typeAndWait = async (index: number, what: string): Promise<StreamRecord> => {
			const before = inputs().length;
			await h.callText('browser_type', { index, text: TYPED });
			return await stream.until((entry) => entry.kind === 'input' && inputs().indexOf(entry) >= before, what);
		};

		await t.step('a same-origin field reports typing, with no character data', async () => {
			const record = await typeAndWait(await elementById(h, 'field'), 'an input record from the top document');
			assertEquals(Object.keys(record.payload).sort(), INPUT_FIELDS);
			assertEquals([record.payload.source, typeof record.payload.value_masked], ['tool', 'boolean']);
			assert((await h.callText('browser_get_html', {})).includes(TYPED), 'the text never reached the page');
		});

		await t.step('the listener is re-injected after a navigation, and reaches a cross-origin frame', async () => {
			// An injection lost on a document swap, or confined to the top renderer, would read as "nobody typed".
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			await typeAndWait(await elementById(h, 'target'), 'an input record after a navigation');
			await h.callText('browser_navigate', { url: h.site.page('oopif') });
			await typeAndWait(await elementById(h, 'frame-field', { frames: 'all' }), 'an input record from the OOPIF');
		});

		await t.step('the typed string, a prefix or a length appears nowhere in the stream', () => {
			assertEquals(stream.raw.includes(TYPED.slice(0, 6)), false, 'a typed value reached the event stream');
			// A length (a password-strength oracle) cannot be found by substring; the fixed shape rules it out.
			assert(inputs().length >= 3, `expected a record from each leg, saw ${inputs().length}`);
			for (const record of inputs()) {
				assertEquals(Object.keys(record.payload).sort(), INPUT_FIELDS);
				assertEquals(typeof record.payload.value_masked, 'boolean');
			}
		});

		await t.step('focus and input are refused by name on a live-view socket, and none arrived there', () => {
			const events = socket.messages.flatMap((message) => message.type === 'event' ? [message.event] : []);
			const refused = events.filter((event) => event.payload.event === 'kind-unavailable').map((e) => e.payload.kind);
			assertEquals([...new Set(refused)].sort(), ['focus', 'input']);
			assert(
				!events.some((event) => event.kind === 'input' || event.kind === 'focus'),
				'a content kind reached a socket',
			);
			assertEquals(JSON.stringify(socket.messages).includes(TYPED), false);
		});
		await socket.close();
	},
});

Deno.test({
	name: 'e2e events: console and dom.settled are armed on subscription; the settle token equals the state token',
	ignore,
	async fn() {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });
		await h.callText('browser_navigate', { url: h.site.page('content') });
		// Both kinds are refcount-armed (minting costs a read), so the stream must name them.
		await using stream = await EventStream.open(h, '?kinds=console,dom.settled');

		await h.callText('browser_click', { index: await elementById(h, 'log') });
		const warn = await stream.until((e) => e.kind === 'console' && e.payload.level === 'warn', 'a warn record');
		assert(String(warn.payload.text).startsWith('warn-'), `unexpected text ${warn.payload.text}`);
		await stream.until((e) => e.kind === 'console' && e.payload.level === 'error', 'an error record');
		for (const entry of stream.records.filter((record) => record.kind === 'console')) {
			assertEquals(Object.keys(entry.payload).sort(), ['level', 'text', 'truncated'], 'no handle, url or position');
		}

		await h.callText('browser_click', { index: await elementById(h, 'mutate') });
		const settled = await stream.until(
			(entry) => entry.kind === 'dom.settled' && Number(entry.payload.mutations) > 0,
			'a dom.settled record counting the mutation burst',
			20_000,
		);
		assertEquals(Object.keys(settled.payload).sort(), ['mutations', 'quiet_ms', 'token']);
		assertEquals(settled.payload.quiet_ms, 500);
		// The page is quiet now, so a read taken now must agree.
		const state = await h.callStructured<{ state_token: string }>('browser_get_state', {});
		assertEquals(settled.payload.token, state.state_token);
	},
});
