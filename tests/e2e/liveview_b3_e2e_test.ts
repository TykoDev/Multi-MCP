/**
 * B3.3 on real Chromium: the live view's address row.
 *
 * Three acceptance rows meet here (AC-P2-06, AC-P2-07, AC-P2-08) and all three are about the same
 * question — can a viewer tell *where* it is looking? A frame list read from a scripted tree, a tab
 * list built from a fake session and a viewport number computed from a literal would each pass a
 * unit test and tell nobody whether the browser agrees. So: a genuinely out-of-process frame, a
 * second tab the page opens itself, and a resize driven through the real tool.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { frameScaleFor } from '@tykotech/gateway';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('liveview B3 e2e');

Deno.test({
	name: 'e2e live (B3.3): state carries the frame list, tabs carry url and title, a tool resize announces the viewport',
	ignore,
	async fn(t) {
		// A second origin for the child frame. `localhost` and `127.0.0.1` are
		// different *sites* to Chromium (scheme plus host; the port is ignored), so
		// the frame lands in its own renderer process — which is the case a frame
		// list has to survive, and the one a same-origin iframe would not have
		// tested. Without this the fixture serves the child from its own origin and
		// the step would pass while proving something weaker than it claims.
		const alt = altOriginServer();
		await using h = await harness({ site: { frameOrigin: alt.origin } });
		const socket = await h.live();
		await socket.ready();
		// The `viewport` message and the event stream both reach only sockets that
		// opted in — a 0.1.0 client receives nothing it did not know.
		socket.send({ type: 'events.subscribe' });
		await socket.waitFor('event', (m) => m.event.kind === 'control');

		await t.step(
			'AC-P2-06: a page with an out-of-process frame emits a state message carrying both frames',
			async () => {
				const from = socket.messages.length;
				await h.callText('browser_navigate', { url: h.site.page('oopif') });
				const state = await socket.waitFor('state', (m) => m.frames !== undefined && m.frames.length > 1, from);

				// **First prove the fixture built what the step needs.** `browser_get_frames`
				// is the authority on whether Chromium really put the child in its own
				// process; asserting it here means a fixture change that quietly makes the
				// frame same-origin fails loudly instead of weakening this step in silence.
				const tree = await h.callJson<{ frames: Array<{ id: string; is_oopif: boolean; url: string }> }>(
					'browser_get_frames',
					{},
				);
				assert(
					tree.frames.some((frame) => frame.is_oopif),
					`the fixture did not produce an out-of-process frame: ${JSON.stringify(tree.frames)}`,
				);

				const frames = state.frames ?? [];
				console.log(`[B3.3] state.frames = ${JSON.stringify(frames)}`);
				assert(frames.length >= 2, `expected the host and the child frame, got ${JSON.stringify(frames)}`);

				// Exactly one root, and it is the page the tool navigated to.
				const roots = frames.filter((frame) => frame.parent_id === null);
				assertEquals(roots.length, 1, 'a frame list has exactly one top document');
				assert(roots[0]?.url.endsWith('/oopif'), `the root is the navigated page: ${roots[0]?.url}`);

				// The child is present, is parented to the root, and carries its OWN url —
				// which is the whole of §1.4's ask: a top URL does not change when an
				// inner frame navigates, so a per-frame URL is the only way to say where
				// the user really is.
				const child = frames.find((frame) => frame.parent_id === roots[0]?.frame_id && frame.name === 'child');
				assert(child !== undefined, `the named child frame is missing: ${JSON.stringify(frames)}`);
				assert(child.url.endsWith('/frame'), `the child carries its own url, not the host's: ${child.url}`);
				assert(child.url !== roots[0]?.url, 'a frame list whose entries all share the top URL says nothing');

				// SR1-A5 on the new field: no query, no fragment, on any frame.
				for (const frame of frames) {
					assert(!frame.url.includes('?') && !frame.url.includes('#'), `${frame.url} carries a query or fragment`);
				}
			},
		);

		await t.step('AC-P2-07: a second tab appears in the tab list with its own url and title', async () => {
			await h.callText('browser_navigate', { url: h.site.page('tabs') });
			const from = socket.messages.length;
			// The page opens the tab itself, through `target="_blank"` — the case the
			// session's own events do not cover and `Target.targetInfoChanged` does.
			await h.callText('browser_click', { index: await indexOfLink(h) });

			const tabs = await socket.waitFor(
				'tabs',
				(m) => m.tabs.length >= 2 && m.tabs.every((tab) => tab.url !== '' && tab.title !== ''),
				from,
			);
			console.log(`[B3.3] tabs = ${JSON.stringify(tabs.tabs)}`);
			assert(tabs.tabs.length >= 2, `expected two tabs, got ${JSON.stringify(tabs.tabs)}`);

			// By name, not by count: the two tabs are the opener and the page it opened.
			const urls = tabs.tabs.map((tab) => tab.url);
			assert(urls.some((url) => url.endsWith('/tabs')), `the opener is missing: ${JSON.stringify(urls)}`);
			assert(urls.some((url) => url.endsWith('/second')), `the opened tab is missing: ${JSON.stringify(urls)}`);
			// And every tab has a real title, not the URL Chromium substitutes for an
			// untitled page and not an empty string.
			for (const tab of tabs.tabs) {
				assert(tab.title.trim() !== '', `tab ${tab.tabId} has no title`);
				assert(!tab.url.includes('?') && !tab.url.includes('#'), `${tab.url} carries a query or fragment`);
			}
			assertEquals(tabs.tabs.filter((tab) => tab.focused).length, 1, 'exactly one tab is focused');
		});

		await t.step('AC-P2-08: browser_set_viewport announces the new viewport and the recomputed scale', async () => {
			await h.callText('browser_navigate', { url: h.site.page('long') });
			await socket.waitForFrames(1);
			const from = socket.messages.length;

			// Through the real tool, not through a raw CDP call: the acceptance row is
			// "when the page **or a tool** resizes it", and a probe that drove CDP
			// directly would prove the notification fires for a caller nobody has.
			await h.callText('browser_set_viewport', { width: 900, height: 600 });

			const viewport = await socket.waitFor('viewport', () => true, from);
			console.log(`[B3.3] viewport = ${JSON.stringify(viewport)}`);
			// The frames really are that size now — the notification is not a
			// restatement of what the tool was asked for.
			assert(viewport.w > 0 && viewport.h > 0);
			assertEquals(
				viewport.frame_scale,
				frameScaleFor(viewport.w, viewport.h),
				'the announced scale is the one the cast computes, not a second calculation',
			);

			// And the frame that follows carries the same scale in its own metadata,
			// so a client that never subscribed still has the factor per frame.
			const frame = await socket.until(
				() => socket.frames.find((f) => f.meta.w === viewport.w && f.meta.h === viewport.h),
				'a frame at the announced viewport',
				async () => {
					// A screencast frame arrives only when the page paints, so it needs a
					// reason to.
					await h.callText('browser_scroll', { direction: 'down' });
				},
			);
			assertEquals(frame.meta.scale, viewport.frame_scale);
		});

		await socket.close();
		await alt.close();
	},
});

/** A second origin serving the child frame, so a real OOPIF can be built. */
function altOriginServer(): { origin: string; close(): Promise<void> } {
	const server = Deno.serve({ hostname: 'localhost', port: 0, onListen: () => {} }, () =>
		new Response(
			'<!doctype html><meta charset="utf-8"><title>alt frame</title><div id="alt-marker">alt-frame</div>',
			{ headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
		));
	return {
		origin: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
		close: () => server.shutdown(),
	};
}

/** The index of the fixture's `#open` link, read from the live element table. */
async function indexOfLink(
	h: { callJson<T>(name: string, args?: Record<string, unknown>): Promise<T> },
): Promise<number> {
	const state = await h.callJson<{ interactive_elements?: Array<{ index: number; tag: string }> }>(
		'browser_get_state',
		{},
	);
	const link = (state.interactive_elements ?? []).find((element) => element.tag === 'a');
	if (link === undefined) throw new Error(`no link in ${JSON.stringify(state.interactive_elements)}`);
	return link.index;
}
