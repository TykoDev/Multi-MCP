/**
 * The pointer and keyboard tools against a real Chromium, each asserted on what the page recorded: the menu opens on
 * `mouseover` only and records which listener opened it (a hover that clicked is caught), `#single`/`#dbl` count
 * `click` and `dblclick` separately (the two-pair double-click ramp), and `#focus-clicks` counts clicks on the chord
 * target (focus without clicking).
 */
import { assert, assertEquals } from '@std/assert';
import { harness, poll, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('interaction e2e');

interface State {
	state_token: string | null;
	interactive_elements: Array<{ index: number; attrs?: Record<string, string> }>;
	page: string;
}

Deno.test({
	name: 'e2e interaction: hover, double click, right click and a chord aimed at one element',
	ignore,
	async fn(t) {
		await using h = await harness();
		/** The text of one recorder `<div>`, from the page's own bytes. */
		const recorded = async (id: string): Promise<string> => {
			const match = new RegExp(`<div id="${id}"[^>]*>([^<]*)</div>`).exec(await h.callText('browser_get_html', {}));
			assert(match !== null, `#${id} not found in the document`);
			return match[1] ?? '';
		};
		/** Calls a tool on one element of a fresh state read. */
		const on = async <T>(tool: string, id: string, args: Record<string, unknown> = {}): Promise<T> => {
			const state = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
			const found = state.interactive_elements.find((element) => element.attrs?.id === id);
			assert(found !== undefined, `#${id} is not in the element table`);
			return await h.callStructured<T>(tool, { index: found.index, state_token: state.state_token, ...args });
		};
		await t.step('a coordinate hover lands where it was asked to, without pressing', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			const result = await h.callStructured<{ clamped: boolean; hover_x: number; hover_y: number }>('browser_hover', {
				coordinate_x: 100,
				coordinate_y: 60,
			});
			assertEquals([result.clamped, result.hover_x, result.hover_y], [false, 100, 60]);
			assertEquals(await recorded('lastmove'), '100,60');
			assertEquals(await recorded('clicks'), '0', 'a hover is not a click');
		});
		await h.callText('browser_navigate', { url: h.site.page('pointer') });

		await t.step('a hover opens a hover-triggered menu, and does not click it', async () => {
			assertEquals(await recorded('opened-by'), 'none');
			const result = await on<{ occluded: boolean; hover_x: number; hit_tag: string | null }>(
				'browser_hover',
				'menu-trigger',
			);
			assertEquals(result.occluded, false, `the trigger was covered by ${result.hit_tag}`);
			assert(result.hover_x > 0);
			assertEquals(await recorded('opened-by'), 'hover');
			const after = await h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
			assert(
				after.interactive_elements.some((element) => element.attrs?.id === 'menu-item') || after.page.includes('Item '),
				'the hover-revealed menu item is not in the page',
			);
		});

		await t.step('a double click fires click twice and dblclick once; a right click fires contextmenu', async () => {
			await on('browser_double_click', 'dblbtn');
			// One pair carrying clickCount 2 would leave single at 0.
			assertEquals([await recorded('single'), await recorded('dbl')], ['2', '1']);
			assertEquals(await recorded('ctx'), 'none');
			await on('browser_right_click', 'dblbtn');
			assertEquals(await recorded('ctx'), 'dblbtn@2', 'button 2 is the right button');
		});

		await t.step('a chord reaches a named element, focused and not clicked, as the socket path does', async () => {
			const result = await on<{ key: string; modifiers: number }>('browser_press_key', 'chord-target', {
				key: 'k',
				modifiers: ['ctrl', 'shift'],
			});
			assertEquals([result.key, result.modifiers], ['ctrl+shift+k', 10], 'ctrl (2) | shift (8)');
			assertEquals(await recorded('chord'), 'Ctrl+Shift+K');
			assertEquals(await recorded('chord-target-id'), 'chord-target');
			assertEquals(await recorded('focus-clicks'), '0', 'a key press must not click its target');

			// The same gesture over the socket must reach the page identically. The socket carries the browser's own
			// `KeyboardEvent.key` ('K' on a US layout), so the tool, composing from names, does the shifting itself.
			await h.pageValue("document.getElementById('chord').textContent = 'none'");
			const socket = await h.live();
			try {
				socket.send({ type: 'control.take' });
				await socket.waitFor('lock', (message) => message.lock !== null);
				socket.send({ type: 'input.key', kind: 'down', key: 'K', modifiers: ['ctrl', 'shift'] });
				socket.send({ type: 'input.key', kind: 'up', key: 'K', modifiers: ['ctrl', 'shift'] });
				await poll('the socket chord', async () => (await recorded('chord')) === 'Ctrl+Shift+K' || undefined, 2_000);
			} finally {
				await socket.close();
			}
		});
	},
});
