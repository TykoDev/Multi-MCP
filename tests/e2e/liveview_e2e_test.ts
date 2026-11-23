/**
 * The live view end to end: real tickets, a real WebSocket, real JPEG frames off a real Chromium, and human input
 * the page records receiving.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { type Harness, harness, type LiveSocket, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('live view e2e');

/** JPEG SOI marker: proof the payload is an image, not a placeholder. */
const isJpeg = (bytes: Uint8Array): boolean => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Takes control and waits for the lock to be granted to this viewer. */
async function take(socket: LiveSocket): Promise<void> {
	const meta = await socket.ready();
	socket.send({ type: 'control.take' });
	await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);
}

/** Sends a message and returns the next `error` it provokes. */
function provoke(socket: LiveSocket, message: Parameters<LiveSocket['send']>[0]) {
	const before = socket.messages.length;
	socket.send(message);
	return socket.waitFor('error', () => true, before);
}

const upgrade = { headers: { upgrade: 'websocket', connection: 'Upgrade' } };
const mint = (h: Harness, body: Record<string, unknown> = {}) =>
	h.fetch('/api/v1/live/ticket', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

/** Polls `browser_get_html` until the fragment appears. */
async function waitForHtml(h: Harness, fragment: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	let last = '';
	while (Date.now() < deadline) {
		last = await h.callText('browser_get_html', {});
		if (last.includes(fragment)) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`the page never showed ${JSON.stringify(fragment)}; last body was:\n${last.slice(0, 1200)}`);
}

Deno.test({
	name: 'e2e live: tickets, frames, and the meta contract',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });

		await t.step("a ticket carries the principal's mode and a short life, and is single-use", async () => {
			const response = await mint(h);
			assertEquals(response.status, 201);
			const body = await response.json() as { ticket: string; mode: string; expires_in: number; session_id: string };
			assertStringIncludes(body.ticket, 'lvt_');
			assertEquals([body.mode, body.session_id], ['control', 'default']);
			assert(body.expires_in > 0 && body.expires_in <= 30, `expires_in was ${body.expires_in}`);

			const ticket = await h.ticket();
			const socket = new WebSocket(`${h.url.replace(/^http/, 'ws')}/live/default/ws?ticket=${ticket}`);
			await new Promise<void>((resolve) => {
				socket.onopen = () => resolve();
				socket.onerror = () => resolve();
			});
			const replay = await fetch(`${h.url}/live/default/ws?ticket=${ticket}`, upgrade);
			assertStringIncludes((await replay.json() as { type: string }).type, 'ticket-consumed');
			socket.close();
		});

		await t.step('a ticket for one session cannot open another; a plain request is refused', async () => {
			const created = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('second'),
				new_session: true,
			});
			const mismatch = await fetch(
				`${h.url}/live/${created.session_id}/ws?ticket=${await h.ticket('default')}`,
				upgrade,
			);
			assert(mismatch.status >= 400, `a mismatched ticket was honoured: ${mismatch.status}`);
			await mismatch.body?.cancel();
			await h.callText('browser_close_session', { session_id: created.session_id });
			const plain = await fetch(`${h.url}/live/default/ws?ticket=${await h.ticket()}`);
			assertEquals(plain.status, 426);
			await plain.body?.cancel();
		});

		await t.step('meta describes the attached session, and the socket streams live JPEG frames', async () => {
			const socket = await h.live();
			const meta = await socket.ready();
			assertEquals([meta.sessionId, meta.mode, meta.lock], ['default', 'control', null]);
			assert(meta.viewerId.length > 0, 'meta names this viewer, or it cannot tell whose lock is whose');
			assert(meta.viewport.w > 0 && meta.viewport.h > 0 && meta.tabs[0]?.focused === true);
			const frame = await socket.waitForFrames(1);
			assert(isJpeg(frame.jpeg) && frame.jpeg.length > 1000, `not a real JPEG: ${[...frame.jpeg.subarray(0, 4)]}`);
			assert(frame.meta.w > 0 && frame.meta.h > 0 && frame.meta.targetId.length > 0);
			// Chrome paints a frame only when the page changes: a click proves the stream is live.
			const seen = socket.frames.length;
			const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
				'browser_get_state',
				{},
			);
			await h.callText('browser_click', { index: state.interactive_elements.find((e) => e.tag === 'button')!.index });
			const later = await socket.waitForFrames(seen + 1);
			assert(later.meta.seq > frame.meta.seq && isJpeg(later.jpeg), 'seq must advance across frames');
			await socket.close();
		});
	},
});

Deno.test({
	name: 'e2e live: the takeover lock, across viewers and against the model',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const first = await h.live();
		const second = await h.live();
		const firstMeta = await first.ready();
		const humanHasControl = async () =>
			(await h.callJson<{ human_has_control: boolean }>('browser_get_state', {})).human_has_control;

		await t.step('taking control is broadcast; another viewer can neither steal it nor send input', async () => {
			first.send({ type: 'control.take' });
			assertEquals((await first.waitFor('lock', (m) => m.lock !== null)).lock?.holder, firstMeta.viewerId);
			assertEquals((await second.waitFor('lock', (m) => m.lock !== null)).lock?.holder, firstMeta.viewerId);
			assertEquals((await provoke(second, { type: 'control.take' })).code, 'lock-held');
			assertEquals((await provoke(second, { type: 'input.mouse', kind: 'click', x: 10, y: 10 })).code, 'not-holder');
		});

		await t.step("the model's mutating tools are refused while a human holds control; observation works", async () => {
			// Refused at call time with a readable code, never by withdrawing the tool from the list.
			assertStringIncludes(
				await h.callError('browser_navigate', { url: h.site.page('second') }),
				'Error: human-has-control',
			);
			assertStringIncludes(
				await h.callError('browser_click', { coordinate_x: 10, coordinate_y: 10 }),
				'Error: human-has-control',
			);
			assertEquals(await humanHasControl(), true);
			await h.callText('browser_screenshot', {});
			await h.callText('browser_list_tabs', {});
			// The holder's input reaches the page, and the session says when: the agent's cue that a person is at work.
			const lastInput = async () =>
				(await h.callJson<{ last_input_at: string | null }>('browser_get_session', {})).last_input_at;
			assertEquals(await lastInput(), null, 'no input yet');
			first.send({ type: 'input.mouse', kind: 'move', x: 20, y: 20 });
			const deadline = Date.now() + 10_000;
			while ((await lastInput()) === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
			assert((await lastInput()) !== null, 'last_input_at records the holder’s input');
		});

		await t.step("releasing restores the model's access; a dropped socket releases the lock it held", async () => {
			first.send({ type: 'control.release' });
			await first.waitFor('lock', (m) => m.lock === null);
			assertEquals(
				(await h.callJson<{ title: string }>('browser_navigate', { url: h.site.page('second') })).title,
				'Second Page',
			);
			await take(second);
			assertEquals(await humanHasControl(), true);
			await second.close();
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && await humanHasControl()) await new Promise((resolve) => setTimeout(resolve, 200));
			assertEquals(await humanHasControl(), false);
		});
		await first.close();
	},
});

Deno.test({
	name: 'e2e live: human input reaches the real page',
	ignore,
	async fn(t) {
		await using h = await harness();
		/** Navigates, opens a socket and takes control. */
		const controlling = async (page: 'mouse' | 'keys'): Promise<LiveSocket> => {
			await h.callText('browser_navigate', { url: h.site.page(page) });
			// A state read teaches the server the viewport, which the pointer bound needs.
			await h.callJson('browser_get_state', {});
			const socket = await h.live();
			await take(socket);
			return socket;
		};
		const key = (socket: LiveSocket, key: string, extra: Record<string, unknown> = {}) =>
			socket.send({ type: 'input.key', kind: 'press', key, ...extra } as Parameters<LiveSocket['send']>[0]);

		await t.step('mouse: move, wheel, click, down and up land where sent; far outside is answered', async () => {
			const socket = await controlling('mouse');
			socket.send({ type: 'input.mouse', kind: 'move', x: 200, y: 150 });
			await waitForHtml(h, '<div id="lastmove">200,150</div>');
			socket.send({ type: 'input.wheel', x: 200, y: 150, deltaX: 0, deltaY: 240 });
			await waitForHtml(h, '<div id="wheel">240</div>');
			socket.send({ type: 'input.mouse', kind: 'click', x: 140, y: 70 });
			await waitForHtml(h, '<div id="lastclick">140,70,b0</div>');
			socket.send({ type: 'input.mouse', kind: 'down', x: 60, y: 60 });
			socket.send({ type: 'input.mouse', kind: 'up', x: 60, y: 60 });
			await waitForHtml(h, '<div id="clicks">2</div>');
			const error = await provoke(socket, { type: 'input.mouse', kind: 'click', x: 99_999, y: 99_999 });
			assertEquals([error.code, error.reason], ['input-rejected', 'out-of-range']);
			await socket.close();
		});

		await t.step('keys: text, named keys without text, real keyCodes and keypress', async () => {
			const socket = await controlling('keys'); // the input is autofocused
			for (const character of 'hello') {
				key(socket, character, { code: `Key${character.toUpperCase()}`, text: character });
			}
			await waitForHtml(h, '<div id="typed">hello</div>');
			key(socket, 'Enter', { code: 'Enter' });
			await waitForHtml(h, '<div id="lastkey">Enter</div>');
			// A key without a windowsVirtualKeyCode once reached the page with keyCode 0.
			key(socket, 'a', { text: 'a' });
			await waitForHtml(h, '<div id="keycode">65/65/KeyA</div>');
			await waitForHtml(h, '<div id="keypress">a</div>');
			assertStringIncludes(
				await h.callText('browser_get_html', {}),
				'<div id="typed">helloa</div>',
				'Enter typed nothing',
			);
			for (
				const [name, expected] of [
					['Enter', '13/13/Enter'],
					['Tab', '9/9/Tab'],
					['Backspace', '8/8/Backspace'],
					['ArrowUp', '38/38/ArrowUp'],
					['ArrowDown', '40/40/ArrowDown'],
				]
			) {
				key(socket, name!);
				await waitForHtml(h, `<div id="keycode">${expected}</div>`);
			}
			await socket.close();
		});

		await t.step(
			'keys: chords type nothing, IME compositions commit or cancel, an unknown key is answered',
			async () => {
				const socket = await controlling('keys');
				key(socket, 'a', { text: 'a', modifiers: ['ctrl'] });
				await waitForHtml(h, '<div id="chord">Ctrl+a</div>');
				// Bit 2 is Ctrl in the CDP modifier bitfield.
				socket.send({ type: 'input.key', kind: 'down', key: 'b', code: 'KeyB', modifiers: 2 });
				socket.send({ type: 'input.key', kind: 'up', key: 'b', code: 'KeyB', modifiers: 2 });
				await waitForHtml(h, '<div id="chord">Ctrl+b</div>');
				assertStringIncludes(await h.callText('browser_get_html', {}), '<div id="typed"></div>', 'a chord typed text');
				// The page receives the composed character, not the Latin keystrokes used to pick it.
				socket.send({ type: 'input.composition', kind: 'update', text: 'にほん' });
				socket.send({ type: 'input.composition', kind: 'commit', text: '日本語' });
				await waitForHtml(h, '<div id="composed">日本語</div>');
				await waitForHtml(h, '<div id="typed">日本語</div>');
				socket.send({ type: 'input.composition', kind: 'update', text: 'かんじ' });
				socket.send({ type: 'input.composition', kind: 'cancel', text: '' });
				await new Promise((resolve) => setTimeout(resolve, 800));
				assertStringIncludes(
					await h.callText('browser_get_html', {}),
					'<div id="typed">日本語</div>',
					'cancel left text',
				);
				const error = await provoke(socket, { type: 'input.key', kind: 'press', key: 'NotARealKeyName' });
				assertEquals([error.code, error.reason], ['input-rejected', 'unsupported-key']);
				await socket.close();
			},
		);
	},
});

Deno.test({
	name: 'e2e live: navigation, tabs and event subscriptions from the viewer',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1' } });
		await h.callText('browser_navigate', { url: h.site.page('index') });

		await t.step('a human can navigate, and other viewers are told', async () => {
			const driver = await h.live();
			const watcher = await h.live();
			await take(driver);
			const before = watcher.messages.length;
			driver.send({ type: 'navigate', url: h.site.page('article') });
			await watcher.waitFor('state', (message) => message.url.includes('/article'), before);
			assertEquals((await h.callJson<{ title: string }>('browser_get_state', {})).title, 'Quarterly Report');
			await driver.close();
			await watcher.close();
		});

		await t.step('no query string or fragment reaches a view:watch socket', async () => {
			// A navigation URL is where an OAuth fragment or a magic-link code lives; tickets carry no mcp:invoke.
			const sentinel = 'zzredactsecretzz';
			const socket = await h.live();
			const before = socket.messages.length;
			await h.callText('browser_navigate', {
				url: `${h.site.page('article')}?token=${sentinel}#access_token=${sentinel}`,
			});
			const state = await socket.waitFor('state', (message) => message.url.includes('/article'), before);
			assert(!state.url.includes('?') && !state.url.includes('#'), state.url);
			// The tab list is URL-bearing too.
			assertEquals(socket.messages.filter((message) => JSON.stringify(message).includes(sentinel)), []);
			await socket.close();
		});

		await t.step('a subscription states its epoch, carries redacted records, and refuses content kinds', async () => {
			const socket = await h.live();
			let before = socket.messages.length;
			socket.send({ type: 'events.subscribe' });
			const open = await socket.waitFor('event', (message) => message.event.payload.event === 'stream-open', before);
			assertEquals([typeof open.event.payload.epoch, typeof open.event.payload.seq], ['string', 'number']);
			before = socket.messages.length;
			await h.callText('browser_navigate', { url: h.site.page('second') });
			const navigation = await socket.waitFor('event', (message) => message.event.kind === 'navigation', before);
			assertEquals(navigation.event.payload.path, '/second');
			assertEquals('url' in navigation.event.payload, false, 'origin and path, never a URL string');
			// Unsubscribing stops delivery and leaves the socket open: a frame still arrives.
			socket.send({ type: 'events.unsubscribe' });
			before = socket.frames.length;
			await h.callText('browser_navigate', { url: h.site.page('index') });
			await socket.waitForFrames(before + 1);
			// Page content never reaches a view-scoped ticket, and the refusal is said out loud.
			before = socket.messages.length;
			socket.send({ type: 'events.subscribe', kinds: ['console', 'navigation'] });
			const refused = await socket.waitFor(
				'event',
				(message) => message.event.payload.event === 'kind-unavailable',
				before,
			);
			assertEquals(refused.event.payload.kind, 'console');
			await socket.close();
		});

		await t.step('switching tabs moves the stream to the new tab', async () => {
			await h.callText('browser_navigate', { url: h.site.page('tabs') });
			const socket = await h.live();
			await socket.waitForFrames(1);
			// The model opens the tab before the human takes control, which would refuse it.
			const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
				'browser_get_state',
				{},
			);
			const seen = socket.messages.length;
			await h.callText('browser_click', { index: state.interactive_elements.find((e) => e.tag === 'a')!.index });
			await take(socket);
			// A popup is announced before it has navigated: wait for the tab with a URL.
			const tabs = await socket.waitFor('tabs', (m) => m.tabs.some((tab) => tab.url.includes('/second')), seen);
			const second = tabs.tabs.find((tab) => tab.url.includes('/second'))!;
			const framesBefore = socket.frames.length;
			socket.send({ type: 'tab.switch', tabId: second.tabId });
			await socket.waitFor('tabs', (m) => m.tabs.find((tab) => tab.tabId === second.tabId)?.focused === true);
			const fromNewTab = await socket.until(
				() => socket.frames.slice(framesBefore).find((frame) => frame.meta.targetId.endsWith(second.tabId)),
				`a frame from the newly focused tab ${second.tabId}`,
			);
			assert(isJpeg(fromNewTab.jpeg));
			await socket.close();
		});

		await t.step('the navigation policy applies to a human; bad and unknown messages are reported', async () => {
			const socket = await h.live();
			await take(socket);
			for (const url of ['https://not-allowed.example/', 'file:///etc/passwd']) {
				assertEquals((await provoke(socket, { type: 'navigate', url })).code, 'navigation-blocked', url);
			}
			assertStringIncludes((await h.callJson<{ url: string }>('browser_get_state', {})).url, '127.0.0.1');
			assertEquals((await provoke(socket, { type: 'tab.switch', tabId: 'ZZZZ' })).code, 'bad-message');
			const before = socket.messages.length;
			socket.sendRaw('{"type":"not-a-real-message"}');
			assertEquals((await socket.waitFor('error', () => true, before)).code, 'bad-message');
			await socket.close();
		});
	},
});

Deno.test({
	name: 'e2e live: scopes, limits, and closing',
	ignore,
	async fn(t) {
		await t.step('a watch-only principal gets a watch ticket, frames, and no control', async () => {
			await using h = await harness({ scopes: ['mcp:invoke', 'view:watch'] });
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const response = await mint(h);
			assertEquals([response.status, (await response.json()).mode], [201, 'watch']);
			const socket = await h.live();
			assertEquals((await socket.ready()).mode, 'watch');
			assert(isJpeg((await socket.waitForFrames(1)).jpeg));
			assertEquals((await provoke(socket, { type: 'control.take' })).code, 'not-holder');
			await socket.close();
		});

		await t.step('a principal with neither view scope is refused a ticket', async () => {
			await using h = await harness({ scopes: ['mcp:invoke'] });
			const response = await mint(h);
			assertEquals(response.status, 403);
			assertStringIncludes((await response.json()).type, 'forbidden-scope');
		});

		await t.step('the per-session viewer cap is enforced', async () => {
			await using h = await harness({ env: { TTK_MAX_VIEWERS: '1' } });
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const first = await h.live();
			const response = await fetch(`${h.url}/live/default/ws?ticket=${await h.ticket()}`, upgrade);
			assertEquals(response.status, 429);
			assertStringIncludes((await response.json()).type, 'rate-limited');
			await first.close();
		});

		await t.step('an unknown session is refused at mint; closing a session and shutdown say goodbye', async () => {
			const h = await harness();
			const unknown = await mint(h, { session_id: 'no-such-session' });
			assertEquals(unknown.status, 404);
			assertStringIncludes((await unknown.json()).type, 'unknown-session');

			const created = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('index'),
				new_session: true,
			});
			const closing = await h.live(created.session_id);
			await closing.waitForFrames(1);
			await h.callText('browser_close_session', { session_id: created.session_id });
			assertEquals((await closing.waitFor('bye')).reason, 'session-closed');
			assertEquals((await closing.waitForClose()).code, 1000);

			await h.callText('browser_navigate', { url: h.site.page('index') });
			const socket = await h.live();
			await socket.waitForFrames(1);
			await h.gateway.shutdown();
			assertEquals((await socket.waitFor('bye')).reason, 'server-shutdown');
			await socket.close();
			await h.gateway.finished;
			await h.site.close();
			await h.client.close().catch(() => {});
		});
	},
});
