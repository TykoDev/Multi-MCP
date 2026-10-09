/**
 * B2.4: the pointer and keyboard tools against a real Chromium.
 *
 * Acceptance rows AC-P1-12 (a hover opens a hover-triggered menu), AC-P1-15 (a chord reaches a named
 * element), AC-P1-16 (double-click and context-menu events observed) and the AC-P0-37 half this
 * slice owns — the Live View input path and the tool path stay consistent.
 *
 * Every assertion reads something the **page** recorded, never a field the tool wrote about itself:
 * the fixture's menu opens on `mouseover` alone and records which listener opened it, so a hover
 * that secretly clicked is caught rather than passed; `#single` and `#dbl` count `click` and
 * `dblclick` separately, so the E-48 two-pair ramp is checkable from the page's side rather than from
 * the CDP frames the unit tier already pins; and `#focus-clicks` counts clicks on the chord target,
 * so E-50's "focus without clicking" is a page-observed fact.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('interaction e2e');

interface Element {
	index: number;
	tag: string;
	label?: string;
	attrs?: Record<string, string>;
	text?: string;
}
interface State {
	state_token: string | null;
	interactive_elements: Element[];
	page: string;
}

/** The structured half of a result, where every field added since 0.1.0 lives (I-4). */
async function structured<T>(
	h: {
		call(
			name: string,
			args?: Record<string, unknown>,
		): Promise<{ isError?: boolean; structuredContent?: unknown; content?: unknown }>;
	},
	name: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	const result = await h.call(name, args);
	assert(result.isError !== true, `${name} failed: ${JSON.stringify(result.content)}`);
	return result.structuredContent as T;
}

/**
 * The text of one recorder element, read through `browser_get_html`.
 *
 * `browser_get_state` would do for the interactive controls, but the recorders are plain `<div>`s
 * and the state tool indexes interactive elements. The HTML is the page's own bytes, which is the
 * point: the assertion is about what the browser did, not about what a tool said it did.
 */
async function recorded(
	h: { callText(name: string, args?: Record<string, unknown>): Promise<string> },
	id: string,
): Promise<string> {
	const html = await h.callText('browser_get_html', {});
	const match = new RegExp(`<div id="${id}"[^>]*>([^<]*)</div>`).exec(html);
	assert(match !== null, `#${id} not found in the document`);
	return match[1] ?? '';
}

function indexOf(state: State, id: string): number {
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(state.interactive_elements)}`);
	return found.index;
}

Deno.test({
	name: 'e2e B2.4: hover, double click, right click and a chord aimed at one element',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('pointer') });
		const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });

		await t.step('AC-P1-12: a hover opens a hover-triggered menu, and does NOT click it', async () => {
			assertEquals(await recorded(h, 'opened-by'), 'none', 'the menu must start closed');
			const result = await structured<{ occluded: boolean; hover_x: number; hit_tag: string | null }>(
				h,
				'browser_hover',
				{ index: indexOf(state, 'menu-trigger'), state_token: state.state_token },
			);
			assertEquals(result.occluded, false, `the trigger was covered by ${result.hit_tag}`);
			assert(result.hover_x > 0, 'the pointer landed somewhere real');
			// The page's own record. `hover` is written by the mouseover listener and `click` by the
			// click listener; a hover that pressed anything would read `click` here.
			assertEquals(await recorded(h, 'opened-by'), 'hover');
			const after = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			assert(
				after.interactive_elements.some((element) => element.attrs?.id === 'menu-item') ||
					after.page.includes(`Item `),
				`the hover-revealed menu item is not in the page: ${after.page.slice(0, 400)}`,
			);
		});

		await t.step('AC-P1-16a: a double click fires click TWICE and dblclick once (the E-48 ramp)', async () => {
			const fresh = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			await structured(h, 'browser_double_click', {
				index: indexOf(fresh, 'dblbtn'),
				state_token: fresh.state_token,
			});
			// The two counters together are what distinguishes the ramp from one pair carrying
			// clickCount 2: that would leave single at 0 while dbl still reached 1.
			assertEquals(await recorded(h, 'single'), '2', 'the page must see both clicks of the pair');
			assertEquals(await recorded(h, 'dbl'), '1');
		});

		await t.step('AC-P1-16b: a right click produces a contextmenu event on the target', async () => {
			const fresh = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			assertEquals(await recorded(h, 'ctx'), 'none');
			await structured(h, 'browser_right_click', {
				index: indexOf(fresh, 'dblbtn'),
				state_token: fresh.state_token,
			});
			// `<id>@<button>`: button 2 is the right button in a DOM MouseEvent.
			assertEquals(await recorded(h, 'ctx'), 'dblbtn@2');
		});

		await t.step('AC-P1-15: a chord reaches a NAMED element, which was focused and not clicked', async () => {
			const fresh = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			const result = await structured<{ key: string; modifiers: number; index?: number }>(
				h,
				'browser_press_key',
				{
					key: 'k',
					modifiers: ['ctrl', 'shift'],
					index: indexOf(fresh, 'chord-target'),
					state_token: fresh.state_token,
				},
			);
			assertEquals(result.key, 'ctrl+shift+k', 'the modifiers array is folded into the dispatched chord');
			assertEquals(result.modifiers, 10, 'ctrl (2) | shift (8), from the vendored table');
			// The page saw the chord, on the element that was named.
			assertEquals(await recorded(h, 'chord'), 'Ctrl+Shift+K');
			assertEquals(await recorded(h, 'chord-target-id'), 'chord-target');
			// E-50: focus was moved by DOM.focus, so the element's own click handler never ran.
			assertEquals(await recorded(h, 'focus-clicks'), '0', 'a key press must not click its target');
		});

		await t.step('a coordinate hover lands where it was asked to, without pressing', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			// The pad is viewport-fixed at the origin, so this point is certainly inside it.
			const result = await structured<{ clamped: boolean; hover_x: number; hover_y: number }>(
				h,
				'browser_hover',
				{ coordinate_x: 100, coordinate_y: 60 },
			);
			assertEquals(result.clamped, false);
			assertEquals([result.hover_x, result.hover_y], [100, 60]);
			assertEquals(await recorded(h, 'lastmove'), '100,60');
			assertEquals(await recorded(h, 'clicks'), '0', 'a hover is not a click');
		});

		await t.step('AC-P0-37: the tool path and the socket path produce the same press', async () => {
			// One human gesture — hold Ctrl and Shift, press K — expressed twice, and the page must not
			// be able to tell which producer sent it. §10's rule is checkable rather than aspirational
			// only if the same assertion passes for both.
			//
			// The two spellings differ because the two producers differ, and neither is a workaround.
			// The socket carries the browser's own `KeyboardEvent.key`, which for that gesture is `'K'`
			// on a US layout and something else on another — so the gateway trusts the client's string
			// and must not impose a shift rule of its own, or it would overwrite a correct value from a
			// layout it does not know. The tool composes the gesture from a key name plus modifier
			// names, which is where ERRATUM(E-51) has to do the shifting. This step is what caught the
			// divergence: before E-51 the tool produced `k` here and the socket produced `K`.
			await h.callText('browser_navigate', { url: h.site.page('pointer') });
			const fresh = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			await structured(h, 'browser_press_key', {
				key: 'k',
				modifiers: ['ctrl', 'shift'],
				index: indexOf(fresh, 'chord-target'),
				state_token: fresh.state_token,
			});
			const viaTool = await recorded(h, 'chord');

			const socket = await h.live();
			try {
				socket.send({ type: 'control.take' });
				await socket.waitFor('lock', (message) => message.lock !== null);
				socket.send({ type: 'input.key', kind: 'down', key: 'K', modifiers: ['ctrl', 'shift'] });
				socket.send({ type: 'input.key', kind: 'up', key: 'K', modifiers: ['ctrl', 'shift'] });
				// The socket is fire-and-forget by contract, so the page is polled rather than awaited.
				let viaSocket = '';
				for (let attempt = 0; attempt < 20 && viaSocket !== viaTool; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					viaSocket = await recorded(h, 'chord');
				}
				assertEquals(viaSocket, viaTool, 'the socket and the tool must reach the page the same way');
			} finally {
				socket.close();
			}
		});
	},
});
