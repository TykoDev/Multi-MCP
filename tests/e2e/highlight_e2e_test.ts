/**
 * U-7 (B2.2): the server-drawn highlight, measured by pixels.
 *
 * Does an `Overlay` highlight appear in `Page.startScreencast` frames (the point) but not in
 * `Page.captureScreenshot` (what keeps `browser_screenshot` honest)? Both halves are measured on real
 * Chromium and logged: a screencast frame that arrives after the highlight and differs from the frame
 * before it, and a screenshot taken while the highlight is up compared byte for byte with one taken
 * before. Alongside, the two properties the DOM-injection route could not have had for free:
 * `state_token` is unchanged by a highlight and the document contains no injected node.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { harness, imageOf, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('highlight e2e');

function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

interface State {
	state_token: string | null;
	interactive_elements: Array<{ index: number; tag: string }>;
}

Deno.test({
	name: 'e2e highlight (U-7): a highlight reaches the screencast, never the DOM, and the screenshot answer is measured',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const before = (await h.call('browser_get_state', {})).structuredContent as State;
		const socket = await h.live();
		const meta = await socket.ready();
		assertEquals(meta.mode, 'control');
		const settled = await socket.waitForFrames(1);
		const shotBefore = imageOf(await h.call('browser_screenshot', {}));
		assert(shotBefore !== null);

		await t.step('a rect highlight produces a new, different screencast frame', async () => {
			const seen = socket.frames.length;
			socket.send({ type: 'live.highlight', bounds: { x: 20, y: 20, w: 400, h: 160 }, ttl_ms: 15_000 });
			const after = await socket.waitForFrames(seen + 1);
			const changed = !same(after.jpeg, settled.jpeg);
			console.log(
				`U-7 screencast: frame_after_highlight_differs=${changed} bytes_before=${settled.jpeg.length} bytes_after=${after.jpeg.length}`,
			);
			assert(changed, 'the highlight must reach the screencast frame');
		});

		await t.step('the screenshot half of U-7, measured and logged', async () => {
			const shotDuring = imageOf(await h.call('browser_screenshot', {}));
			assert(shotDuring !== null);
			const overlayInScreenshot = !same(shotDuring.bytes, shotBefore.bytes);
			console.log(
				`U-7 screenshot: overlay_visible_in_captureScreenshot=${overlayInScreenshot} bytes_before=${shotBefore.bytes.length} bytes_during=${shotDuring.bytes.length}`,
			);
			// The honesty contract: `browser_screenshot` shows the page, not the outline. Whichever way
			// the primitive behaves, the tool's answer must be the same bytes as before the highlight.
			assert(!overlayInScreenshot, 'browser_screenshot must not carry the overlay');
		});

		await t.step('a highlight never enters the DOM and never churns state_token', async () => {
			const during = (await h.call('browser_get_state', {})).structuredContent as State;
			assertEquals(during.state_token, before.state_token, 'the token must not move for an overlay');
			const html = await h.callText('browser_get_html', {});
			assert(!html.includes('bua-highlight'), 'no injected highlight node');
		});

		await t.step('an index highlight draws too, and the timer hides it', async () => {
			const button = before.interactive_elements.find((e) => e.tag === 'button');
			assert(button !== undefined);
			const seen = socket.frames.length;
			socket.send({ type: 'live.highlight', index: button.index, ttl_ms: 300 });
			await socket.waitForFrames(seen + 1);
			// After the TTL the outline goes; the page repaints once more.
			const hidden = await socket.waitForFrames(seen + 2);
			assert(hidden.meta.seq > seen, 'the hide repaints');
		});

		await t.step('exactly one of index or bounds, and the schema says so', async () => {
			const from = socket.messages.length;
			socket.sendRaw(JSON.stringify({ type: 'live.highlight', index: 1, bounds: { x: 0, y: 0, w: 1, h: 1 } }));
			const error = await socket.waitFor('error', () => true, from);
			assertEquals(error.code, 'bad-message');
			assertEquals(error.reason, 'schema');
		});

		await socket.close();
	},
});

Deno.test({
	name: 'e2e highlight: a watch-only viewer cannot paint the screen every viewer sees',
	ignore,
	async fn() {
		await using h = await harness({ scopes: ['mcp:invoke', 'view:watch'] });
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const socket = await h.live();
		const meta = await socket.ready();
		assertEquals(meta.mode, 'watch');
		const from = socket.messages.length;
		socket.send({ type: 'live.highlight', bounds: { x: 0, y: 0, w: 10, h: 10 } });
		const error = await socket.waitFor('error', () => true, from);
		assertEquals(error.code, 'not-holder');
		// The read half is still open to a watcher: hover needs no mode at all.
		socket.send({ type: 'live.hover', id: 'w', x: 5, y: 5 });
		await socket.waitFor('hover', (m) => m.id === 'w');
		await socket.close();
	},
});
