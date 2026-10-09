/**
 * The live view, end to end: real tickets, a real WebSocket, real JPEG frames
 * off a real Chromium, and human input that the page records receiving.
 *
 * The completion criteria call the live view "required", and a live view is not
 * a feature you can test with a mock: every assertion here is about what the
 * browser did — a click the page counted, a wheel delta it measured, a tab
 * switch the frame stream followed.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { harness, type LiveSocket, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('live view e2e');

/** JPEG SOI marker: proof the payload is an image, not a placeholder. */
function isJpeg(bytes: Uint8Array): boolean {
	return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Takes control and waits for the lock to be granted to this viewer. */
async function take(socket: LiveSocket): Promise<void> {
	const meta = await socket.ready();
	socket.send({ type: 'control.take' });
	await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);
}

Deno.test({
	name: 'e2e live: tickets, frames, and the meta contract',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });

		await t.step("a ticket is minted with the principal's mode and a short life", async () => {
			const response = await h.fetch('/api/v1/live/ticket', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			assertEquals(response.status, 201);
			const body = await response.json() as { ticket: string; mode: string; expires_in: number; session_id: string };
			assertStringIncludes(body.ticket, 'lvt_');
			assertEquals(body.mode, 'control');
			assertEquals(body.session_id, 'default');
			assert(body.expires_in > 0 && body.expires_in <= 30, `expires_in was ${body.expires_in}`);
		});

		await t.step('a ticket is single-use', async () => {
			const ticket = await h.ticket();
			const socket = new WebSocket(`${h.url.replace(/^http/, 'ws')}/live/default/ws?ticket=${ticket}`);
			await new Promise<void>((resolve) => {
				socket.onopen = () => resolve();
				socket.onerror = () => resolve();
			});
			// The same ticket a second time is refused, and says why.
			const replay = await fetch(`${h.url}/live/default/ws?ticket=${ticket}`, {
				headers: { upgrade: 'websocket', connection: 'Upgrade' },
			});
			const problem = await replay.json() as { type: string };
			assertStringIncludes(problem.type, 'ticket-consumed');
			socket.close();
		});

		await t.step('a ticket for one session cannot open another', async () => {
			const created = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('second'),
				new_session: true,
			});
			const ticket = await h.ticket('default');
			const response = await fetch(
				`${h.url}/live/${created.session_id}/ws?ticket=${ticket}`,
				{ headers: { upgrade: 'websocket', connection: 'Upgrade' } },
			);
			// A mismatch is reported as an unauthenticated ticket, never honoured.
			assertEquals(response.status >= 400, true);
			await response.body?.cancel();
			await h.callText('browser_close_session', { session_id: created.session_id });
		});

		await t.step('a non-WebSocket request to the socket path is refused', async () => {
			const ticket = await h.ticket();
			const response = await fetch(`${h.url}/live/default/ws?ticket=${ticket}`);
			assertEquals(response.status, 426);
			await response.body?.cancel();
		});

		await t.step('meta describes the session the viewer actually attached to', async () => {
			const socket = await h.live();
			const meta = await socket.ready();
			assertEquals(meta.sessionId, 'default');
			assertEquals(meta.mode, 'control');
			assertEquals(meta.lock, null);
			assert(meta.viewerId.length > 0, 'meta must name this viewer, or it cannot tell whose lock is whose');
			assert(meta.viewport.w > 0 && meta.viewport.h > 0);
			assertEquals(meta.tabs.length >= 1, true);
			assertEquals(meta.tabs[0]?.focused, true);
			await socket.close();
		});

		await t.step('the socket streams real JPEG frames', async () => {
			const socket = await h.live();
			const frame = await socket.waitForFrames(1);
			assert(isJpeg(frame.jpeg), `payload is not a JPEG: ${[...frame.jpeg.subarray(0, 4)]}`);
			assert(frame.jpeg.length > 1000, `a real frame carries bytes, got ${frame.jpeg.length}`);
			assert(frame.meta.w > 0 && frame.meta.h > 0, `frame reported ${frame.meta.w}x${frame.meta.h}`);
			assert(frame.meta.targetId.length > 0);

			// The stream is live, not a one-shot. Chrome emits a screencast frame
			// when the page *paints*, so an idle page legitimately goes quiet —
			// changing it is what proves frames keep coming.
			const seen = socket.frames.length;
			const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
				'browser_get_state',
				{},
			);
			const button = state.interactive_elements.find((element) => element.tag === 'button');
			assert(button !== undefined);
			await h.callText('browser_click', { index: button.index });

			const later = await socket.waitForFrames(seen + 1);
			assert(later.meta.seq > frame.meta.seq, 'seq must advance across frames');
			assert(isJpeg(later.jpeg));
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

		await t.step('taking control is broadcast to every viewer', async () => {
			first.send({ type: 'control.take' });
			const mine = await first.waitFor('lock', (m) => m.lock !== null);
			assertEquals(mine.lock?.holder, firstMeta.viewerId);
			// The other viewer learns about it without asking.
			const theirs = await second.waitFor('lock', (m) => m.lock !== null);
			assertEquals(theirs.lock?.holder, firstMeta.viewerId);
		});

		await t.step('a second viewer cannot steal the lock', async () => {
			const before = second.messages.length;
			second.send({ type: 'control.take' });
			const error = await second.waitFor('error', () => true, before);
			assertEquals(error.code, 'lock-held');
		});

		await t.step('input without the lock is refused', async () => {
			const before = second.messages.length;
			second.send({ type: 'input.mouse', kind: 'click', x: 10, y: 10 });
			const error = await second.waitFor('error', () => true, before);
			assertEquals(error.code, 'not-holder');
		});

		await t.step("the model's mutating tools are refused while a human holds control", async () => {
			// Both refuse at call time with the readable code. Before G-2 only
			// `browser_navigate` did: `browser_click` was withdrawn from the list
			// and answered `disabled`, which on the all-held path was a JSON-RPC
			// error rather than something the model could respond to.
			const alsoBlocked = await h.callError('browser_navigate', { url: h.site.page('second') });
			assertStringIncludes(alsoBlocked, 'Error: human-has-control');
			const clicked = await h.callError('browser_click', { coordinate_x: 10, coordinate_y: 10 });
			assertStringIncludes(clicked, 'Error: human-has-control');
		});

		await t.step('but observation keeps working, so the model can watch', async () => {
			const state = await h.callJson<{ human_has_control: boolean; title: string }>('browser_get_state', {});
			assertEquals(state.human_has_control, true);
			assertEquals(state.title, 'TykoTech Fixture Index');
			await h.callText('browser_screenshot', {});
			await h.callText('browser_list_tabs', {});
		});

		await t.step("releasing restores the model's access", async () => {
			first.send({ type: 'control.release' });
			await first.waitFor('lock', (m) => m.lock === null);
			const navigated = await h.callJson<{ title: string }>('browser_navigate', { url: h.site.page('second') });
			assertEquals(navigated.title, 'Second Page');
		});

		await t.step('a dropped socket releases the lock it held', async () => {
			await take(second);
			assertEquals((await h.callJson<{ human_has_control: boolean }>('browser_get_state', {})).human_has_control, true);
			await second.close();
			// The lock is gone with the socket, so the model is unblocked again.
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const state = await h.callJson<{ human_has_control: boolean }>('browser_get_state', {});
				if (!state.human_has_control) break;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			assertEquals(
				(await h.callJson<{ human_has_control: boolean }>('browser_get_state', {})).human_has_control,
				false,
			);
		});

		await first.close();
	},
});

Deno.test({
	name: 'e2e live: human input reaches the real page',
	ignore,
	async fn(t) {
		await using h = await harness();

		await t.step('a click lands where the human clicked', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			const socket = await h.live();
			await take(socket);

			socket.send({ type: 'input.mouse', kind: 'click', x: 140, y: 70 });
			await waitForHtml(h, '<div id="lastclick">140,70,b0</div>');
			assertStringIncludes(await h.callText('browser_get_html', {}), '<div id="clicks">1</div>');
			await socket.close();
		});

		await t.step('a mouse move is reported to the page', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			const socket = await h.live();
			await take(socket);
			socket.send({ type: 'input.mouse', kind: 'move', x: 200, y: 150 });
			await waitForHtml(h, '<div id="lastmove">200,150</div>');
			await socket.close();
		});

		await t.step('a wheel gesture scrolls the real page', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			const socket = await h.live();
			await take(socket);
			socket.send({ type: 'input.wheel', x: 200, y: 150, deltaX: 0, deltaY: 240 });
			await waitForHtml(h, '<div id="wheel">240</div>');
			await socket.close();
		});

		await t.step('separate down and up events make a click', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			const socket = await h.live();
			await take(socket);
			socket.send({ type: 'input.mouse', kind: 'down', x: 60, y: 60 });
			socket.send({ type: 'input.mouse', kind: 'up', x: 60, y: 60 });
			await waitForHtml(h, '<div id="clicks">1</div>');
			await socket.close();
		});

		await t.step('typed keys arrive as real key events', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);
			// The fixture input carries `autofocus`, so keys go straight to it.
			for (const character of 'hello') {
				socket.send({
					type: 'input.key',
					kind: 'press',
					key: character,
					code: `Key${character.toUpperCase()}`,
					text: character,
				});
			}
			await waitForHtml(h, '<div id="typed">hello</div>');
			await socket.close();
		});

		await t.step('a named key is delivered without inserting text', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);
			socket.send({ type: 'input.key', kind: 'press', key: 'Enter', code: 'Enter' });
			await waitForHtml(h, '<div id="lastkey">Enter</div>');
			assertStringIncludes(await h.callText('browser_get_html', {}), '<div id="typed"></div>');
			await socket.close();
		});

		await t.step('a key arrives with a real keyCode, not 0 (B1.11)', async () => {
			// The defect this closes: the Live-View path set no
			// `windowsVirtualKeyCode`, so every keystroke a human sent reached the
			// page with `event.keyCode === 0` — invisible to any page that switches
			// on it, which is most pages with a keyboard shortcut and every
			// `Enter`-to-submit handler predating `event.key`. The agent's own typing
			// path never had this; the socket simply never reached the key tables.
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);
			socket.send({ type: 'input.key', kind: 'press', key: 'a', text: 'a' });
			await waitForHtml(h, '<div id="keycode">65/65/KeyA</div>');
			// And the `keypress` a form handler listens for really fires.
			await waitForHtml(h, '<div id="keypress">a</div>');
			await socket.close();
		});

		await t.step('the named keys carry their native codes, Enter its carriage return', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);
			for (const [key, expected] of [['Enter', '13/13/Enter'], ['Tab', '9/9/Tab'], ['Backspace', '8/8/Backspace']]) {
				socket.send({ type: 'input.key', kind: 'press', key: key as string });
				await waitForHtml(h, `<div id="keycode">${expected}</div>`);
			}
			for (const [key, expected] of [['ArrowUp', '38/38/ArrowUp'], ['ArrowDown', '40/40/ArrowDown']]) {
				socket.send({ type: 'input.key', kind: 'press', key: key as string });
				await waitForHtml(h, `<div id="keycode">${expected}</div>`);
			}
			await socket.close();
		});

		await t.step('a modifier array is accepted, and a chord types nothing', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);
			socket.send({ type: 'input.key', kind: 'press', key: 'a', text: 'a', modifiers: ['ctrl'] });
			await waitForHtml(h, '<div id="chord">Ctrl+a</div>');
			// Ctrl+A selects; it does not type an 'a'.
			assertStringIncludes(await h.callText('browser_get_html', {}), '<div id="typed"></div>');
			await socket.close();
		});

		await t.step('a key this server cannot describe is answered, never dropped (G-7)', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);
			const before = socket.messages.length;
			socket.send({ type: 'input.key', kind: 'press', key: 'NotARealKeyName' });
			const error = await socket.waitFor('error', () => true, before);
			assertEquals(error.code, 'input-rejected');
			assertEquals(error.reason, 'unsupported-key');
			await socket.close();
		});

		await t.step('a pointer far outside the viewport is answered rather than swallowed', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			// The bound is checked only when a viewport is known, and the server
			// learns one from a state read — so this reads first, deliberately: a
			// test that passed because nothing was known would prove nothing.
			await h.callJson<{ viewport: { width: number } }>('browser_get_state', {});
			const socket = await h.live();
			await take(socket);
			const before = socket.messages.length;
			socket.send({ type: 'input.mouse', kind: 'click', x: 99_999, y: 99_999 });
			const error = await socket.waitFor('error', () => true, before);
			assertEquals(error.code, 'input-rejected');
			assertEquals(error.reason, 'out-of-range');
			await socket.close();
		});

		await t.step('an IME composition reaches the page as a composition', async () => {
			// R13. Without this, taking control is unusable in every language that
			// composes: the page would receive the Latin keystrokes used to *pick*
			// a character rather than the character itself.
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);

			// The in-progress reading, then the chosen text.
			socket.send({ type: 'input.composition', kind: 'update', text: 'にほん' });
			socket.send({ type: 'input.composition', kind: 'commit', text: '日本語' });

			// The page's own `compositionend` handler fired with the committed data.
			await waitForHtml(h, '<div id="composed">日本語</div>');
			// And the text really landed in the field.
			assertStringIncludes(await h.callText('browser_get_html', {}), '<div id="typed">日本語</div>');
			await socket.close();
		});

		await t.step('a cancelled composition inserts nothing', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);

			socket.send({ type: 'input.composition', kind: 'update', text: 'かんじ' });
			socket.send({ type: 'input.composition', kind: 'cancel', text: '' });
			// Chrome ends a cancelled composition with empty data, so the page's
			// `compositionend` fires with nothing. What matters is the field: an
			// abandoned reading must leave no text behind.
			await new Promise((resolve) => setTimeout(resolve, 800));
			assertStringIncludes(await h.callText('browser_get_html', {}), '<div id="typed"></div>');
			await socket.close();
		});

		await t.step('a modifier chord is delivered with its modifier bits', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const socket = await h.live();
			await take(socket);
			// Bit 2 is Ctrl in the CDP modifier bitfield.
			socket.send({ type: 'input.key', kind: 'down', key: 'a', code: 'KeyA', modifiers: 2 });
			socket.send({ type: 'input.key', kind: 'up', key: 'a', code: 'KeyA', modifiers: 2 });
			await waitForHtml(h, '<div id="chord">Ctrl+a</div>');
			await socket.close();
		});
	},
});

Deno.test({
	name: 'e2e live: navigation and tabs from the viewer',
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

			// The other viewer's address bar follows without it asking.
			const state = await watcher.waitFor(
				'state',
				(message) => message.url.includes('/article'),
				before,
			);
			assertStringIncludes(state.url, '/article');
			// And the browser really is there.
			assertEquals((await h.callJson<{ title: string }>('browser_get_state', {})).title, 'Quarterly Report');
			await driver.close();
			await watcher.close();
		});

		await t.step('no query string or fragment reaches a view:watch socket (SR1-A5)', async () => {
			// The socket is minted on `view:watch`/`view:control`, neither of which
			// carries `mcp:invoke`, and a navigation URL is exactly where an OAuth
			// implicit fragment or a magic-link code lives. Until SR1-A5 the full
			// URL was broadcast verbatim beside `navigation` records that were
			// already redacted on the same process.
			const sentinel = 'zzsr1a5secretzz';
			const socket = await h.live();
			await socket.ready();
			const before = socket.messages.length;
			await h.callText('browser_navigate', {
				url: `${h.site.page('article')}?token=${sentinel}#access_token=${sentinel}`,
			});
			const state = await socket.waitFor('state', (message) => message.url.includes('/article'), before);
			assertEquals(state.url.includes('?'), false, `state.url kept a query: ${state.url}`);
			assertEquals(state.url.includes('#'), false, `state.url kept a fragment: ${state.url}`);
			// And nothing else on the connection carried it either — the tab list is
			// URL-bearing too, so a rule covering only `state` would leak the same
			// secret through `tabs`.
			const offending = socket.messages.filter((message) => JSON.stringify(message).includes(sentinel));
			assertEquals(offending.length, 0, `a redacted URL part reached the socket: ${JSON.stringify(offending)}`);
			// The browser really did go there, query and all: what narrowed is the
			// wire, not the navigation.
			assertStringIncludes(
				(await h.callJson<{ url: string }>('browser_get_state', {})).url,
				'/article',
			);
			await socket.close();
		});

		await t.step('the same navigation policy applies to a human', async () => {
			const socket = await h.live();
			await take(socket);
			const before = socket.messages.length;
			socket.send({ type: 'navigate', url: 'https://not-allowed.example/' });
			const error = await socket.waitFor('error', () => true, before);
			assertEquals(error.code, 'navigation-blocked');
			// The browser did not move.
			assertStringIncludes(
				(await h.callJson<{ url: string }>('browser_get_state', {})).url,
				'127.0.0.1',
			);
			await socket.close();
		});

		await t.step('a file: URL is refused from the viewer too', async () => {
			const socket = await h.live();
			await take(socket);
			const before = socket.messages.length;
			socket.send({ type: 'navigate', url: 'file:///etc/passwd' });
			const error = await socket.waitFor('error', () => true, before);
			assertEquals(error.code, 'navigation-blocked');
			await socket.close();
		});

		await t.step('an unknown tab id is refused', async () => {
			const socket = await h.live();
			await take(socket);
			const before = socket.messages.length;
			socket.send({ type: 'tab.switch', tabId: 'ZZZZ' });
			const error = await socket.waitFor('error', () => true, before);
			assertEquals(error.code, 'bad-message');
			await socket.close();
		});

		await t.step('a malformed message is reported, not ignored', async () => {
			const socket = await h.live();
			const before = socket.messages.length;
			socket.sendRaw('{"type":"not-a-real-message"}');
			const error = await socket.waitFor('error', () => true, before);
			assertEquals(error.code, 'bad-message');
			await socket.close();
		});

		await t.step('switching tabs moves the stream to the new tab', async () => {
			await h.callText('browser_navigate', { url: h.site.page('tabs') });
			const socket = await h.live();
			await socket.ready();
			await socket.waitForFrames(1);

			// Open a second tab through the model *before* taking control: while a
			// human holds the lock the model's mutating tools are refused, which is
			// the whole point of the lock.
			const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
				'browser_get_state',
				{},
			);
			const anchor = state.interactive_elements.find((element) => element.tag === 'a');
			assert(anchor !== undefined);
			const seen = socket.messages.length;
			await h.callText('browser_click', { index: anchor.index });
			await take(socket);

			// The viewer learns a tab appeared, without polling. A popup is announced
			// before it has navigated, so the wait is for the tab *with a URL* —
			// which is also the assertion that the later refresh really happens.
			const tabs = await socket.waitFor(
				'tabs',
				(message) => message.tabs.some((tab) => tab.url.includes('/second')),
				seen,
			);
			const second = tabs.tabs.find((tab) => tab.url.includes('/second'));
			assert(second !== undefined, `no /second among ${JSON.stringify(tabs.tabs)}`);

			// Switch to it from the viewer, and the frames follow the focus.
			const framesBefore = socket.frames.length;
			socket.send({ type: 'tab.switch', tabId: second.tabId });
			const focused = await socket.waitFor(
				'tabs',
				(message) => message.tabs.find((tab) => tab.tabId === second.tabId)?.focused === true,
			);
			assertEquals(focused.tabs.find((tab) => tab.tabId === second.tabId)?.focused, true);

			// And the stream itself moves: a frame arrives that Chrome painted from
			// the *new* target. Before E-15 this never happened — the viewer kept
			// watching the tab it had left.
			const fromNewTab = await socket.until(
				() =>
					socket.frames
						.slice(framesBefore)
						.find((frame) => frame.meta.targetId.endsWith(second.tabId)),
				`a frame from the newly focused tab ${second.tabId}`,
			);
			assert(isJpeg(fromNewTab.jpeg), 'the retargeted stream must still carry JPEGs');
			await socket.close();
		});
	},
});

Deno.test({
	name: 'e2e live: events.subscribe over the live-view socket',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1' } });
		await h.callText('browser_navigate', { url: h.site.page('index') });

		await t.step('a subscription states its epoch, then carries what happens', async () => {
			const socket = await h.live();
			await socket.ready();
			const before = socket.messages.length;
			socket.send({ type: 'events.subscribe' });

			// Every stream states its epoch before it waits, or a client with
			// nothing to receive could never learn which epoch it is waiting on.
			const open = await socket.waitFor(
				'event',
				(message) => message.event.payload.event === 'stream-open',
				before,
			);
			assertEquals(typeof open.event.payload.epoch, 'string');
			assertEquals(typeof open.event.payload.seq, 'number');

			const seen = socket.messages.length;
			await h.callText('browser_navigate', { url: h.site.page('article') });
			const navigation = await socket.waitFor('event', (message) => message.event.kind === 'navigation', seen);
			// The record is the same envelope the SSE transport carries, and it is
			// redacted at mint: origin and path, never a URL string.
			assertEquals(navigation.event.payload.path, '/article');
			assertEquals('url' in navigation.event.payload, false);
			await socket.close();
		});

		await t.step('a content kind is refused on this transport, and said so', async () => {
			// A live-view ticket is minted on `view:watch`/`view:control` and carries
			// no `mcp:invoke`, so page content never reaches it. Refusing in silence
			// would leave the consumer reading the silence as "nothing happened".
			const socket = await h.live();
			await socket.ready();
			const before = socket.messages.length;
			socket.send({ type: 'events.subscribe', kinds: ['console', 'navigation'] });
			const refused = await socket.waitFor(
				'event',
				(message) => message.event.payload.event === 'kind-unavailable',
				before,
			);
			assertEquals(refused.event.payload.kind, 'console');
			await socket.close();
		});

		await t.step('unsubscribing stops delivery and leaves the socket open', async () => {
			const socket = await h.live();
			await socket.ready();
			socket.send({ type: 'events.subscribe' });
			await socket.waitFor('event', (message) => message.event.payload.event === 'stream-open');
			socket.send({ type: 'events.unsubscribe' });
			// A frame still arrives, which is what proves the socket itself survived
			// the unsubscribe rather than the delivery merely having stopped.
			await socket.waitForFrames(1);
			await socket.close();
		});
	},
});

Deno.test({
	name: 'e2e live: limits, scopes, and shutdown',
	ignore,
	async fn(t) {
		await t.step('a watch-only principal gets a watch ticket and cannot take control', async () => {
			await using h = await harness({ scopes: ['mcp:invoke', 'view:watch'] });
			await h.callText('browser_navigate', { url: h.site.page('index') });

			const response = await h.fetch('/api/v1/live/ticket', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			assertEquals(response.status, 201);
			assertEquals((await response.json()).mode, 'watch');

			const socket = await h.live();
			const meta = await socket.ready();
			assertEquals(meta.mode, 'watch');
			// It still receives frames — watching is the point.
			assert(isJpeg((await socket.waitForFrames(1)).jpeg));

			const before = socket.messages.length;
			socket.send({ type: 'control.take' });
			const error = await socket.waitFor('error', () => true, before);
			assertEquals(error.code, 'not-holder');
			await socket.close();
		});

		await t.step('a principal with neither view scope is refused a ticket', async () => {
			await using h = await harness({ scopes: ['mcp:invoke'] });
			const response = await h.fetch('/api/v1/live/ticket', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			assertEquals(response.status, 403);
			assertStringIncludes((await response.json()).type, 'forbidden-scope');
		});

		await t.step('a ticket for an unknown session is refused at mint time', async () => {
			await using h = await harness();
			const response = await h.fetch('/api/v1/live/ticket', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ session_id: 'no-such-session' }),
			});
			assertEquals(response.status, 404);
			assertStringIncludes((await response.json()).type, 'unknown-session');
		});

		await t.step('the per-session viewer cap is enforced', async () => {
			await using h = await harness({ env: { TTK_MAX_VIEWERS: '1' } });
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const first = await h.live();
			await first.ready();

			const ticket = await h.ticket();
			const response = await fetch(`${h.url}/live/default/ws?ticket=${ticket}`, {
				headers: { upgrade: 'websocket', connection: 'Upgrade' },
			});
			assertEquals(response.status, 429);
			assertStringIncludes((await response.json()).type, 'rate-limited');
			await first.close();
		});

		await t.step('closing a session says goodbye to its viewers', async () => {
			await using h = await harness();
			const created = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('index'),
				new_session: true,
			});
			const socket = await h.live(created.session_id);
			await socket.ready();
			await socket.waitForFrames(1);

			await h.callText('browser_close_session', { session_id: created.session_id });
			const bye = await socket.waitFor('bye');
			assertEquals(bye.reason, 'session-closed');
			const closed = await socket.waitForClose();
			assertEquals(closed.code, 1000);
		});

		await t.step('shutdown closes live sockets rather than dropping them', async () => {
			const h = await harness();
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const socket = await h.live();
			await socket.ready();
			await socket.waitForFrames(1);

			await h.gateway.shutdown();
			const bye = await socket.waitFor('bye');
			assertEquals(bye.reason, 'server-shutdown');
			await socket.close();
			await h.gateway.finished;
			await h.site.close();
			await h.client.close().catch(() => {});
		});
	},
});

/** Polls `browser_get_html` until the fragment appears, so tests never sleep blind. */
async function waitForHtml(
	h: { callText(name: string, args?: Record<string, unknown>): Promise<string> },
	fragment: string,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = '';
	while (Date.now() < deadline) {
		last = await h.callText('browser_get_html', {});
		if (last.includes(fragment)) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`the page never showed ${JSON.stringify(fragment)}; last body was:\n${last.slice(0, 1200)}`);
}
