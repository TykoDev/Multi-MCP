/**
 * The action, session and viewport tools against a real Chromium. Every assertion reads what the page recorded:
 * `#changed`/`#change-count` by the select's own change handler, `#drag-moves` by mousemove with the button down,
 * `#uploaded` by the file input's change handler.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { EventStream, harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('actions e2e');

interface Element {
	index: number;
	attrs?: Record<string, string>;
	visible?: boolean;
}
interface State {
	state_token: string | null;
	interactive_elements: Element[];
}

function find(state: State, id: string): Element {
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(state.interactive_elements)}`);
	return found;
}

Deno.test({
	name: 'e2e actions: select, fill, scrolling, upload, drag, dialogs, viewport and session options',
	ignore,
	async fn(t) {
		await using h = await harness();
		const state = (args: Record<string, unknown> = {}) =>
			h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'], ...args });
		const argsFor = async (id: string, args: Record<string, unknown> = {}) => {
			const read = await state();
			return { index: find(read, id).index, state_token: read.state_token, ...args };
		};
		/** Calls a tool on one element of a fresh state read. */
		const on = async <T>(tool: string, id: string, args: Record<string, unknown> = {}) =>
			await h.callStructured<T>(tool, await argsFor(id, args));
		/** The text of one recorder `<div>`, read from the page's own bytes. */
		const recorded = async (id: string): Promise<string> => {
			const match = new RegExp(`<div id="${id}"[^>]*>([^<]*)</div>`).exec(await h.callText('browser_get_html', {}));
			assert(match !== null, `#${id} not found in the document`);
			return match[1] ?? '';
		};
		const go = (page: 'actions' | 'form' | 'downloads') => h.callText('browser_navigate', { url: h.site.page(page) });
		await go('actions');

		await t.step('a select is set by value, by label and by position, and change fires each time', async () => {
			type Selected = { selected: { value: string; label: string; index_in_list: number } };
			assertEquals((await on<Selected>('browser_select_option', 'colour', { value: 'b' })).selected, {
				value: 'b',
				label: 'Bleu',
				index_in_list: 2,
			});
			assertEquals([await recorded('changed'), await recorded('change-count')], ['b', '1']);
			const byLabel = await on<Selected>('browser_select_option', 'colour', { label: 'Vert' });
			assertEquals([byLabel.selected.value, byLabel.selected.index_in_list], ['g', 1]);
			assertEquals(await recorded('change-count'), '2');
			const byPosition = await on<Selected>('browser_select_option', 'colour', { index_in_list: 0 });
			assertEquals([byPosition.selected.value, byPosition.selected.label], ['r', 'Rouge']);
			assertEquals(await recorded('change-count'), '3');

			const read = await state();
			const missed = await h.callError('browser_select_option', {
				index: find(read, 'colour').index,
				value: 'no-such-value',
				state_token: read.state_token,
			});
			assertStringIncludes(missed, 'element-not-interactable');
			assertStringIncludes(missed, '3 options', 'the count, never the option text');
			const notASelect = await h.callError('browser_select_option', {
				index: find(read, 'slider').index,
				value: 'x',
				state_token: read.state_token,
			});
			assertStringIncludes(notASelect, 'not a <select>');
		});

		await t.step('fill replaces a remembered value where type appends', async () => {
			await go('form');
			await on('browser_type', 'name', { text: 'Ada' });
			await on('browser_type', 'name', { text: 'Grace' });
			assertStringIncludes(await h.callText('browser_get_html', {}), '"name":"AdaGrace"', 'type appends');
			const filled = await on<{ cleared: boolean; typed_length?: number }>('browser_fill', 'name', { text: 'Hopper' });
			assertEquals([filled.cleared, filled.typed_length], [true, 'Hopper'.length]);
			const echo = await h.callText('browser_get_html', {});
			assert(echo.includes('"name":"Hopper"') && !echo.includes('AdaGrace'), 'the remembered value must be gone');
		});

		await t.step('scroll_to lands at a named point and scroll_into_view brings an element into view', async () => {
			await go('actions');
			const to = await h.callStructured<{ scroll: { y: number }; state_token: null }>('browser_scroll_to', {
				x: 0,
				y: 900,
			});
			assertEquals(to.scroll.y, 900);
			assertEquals(to.state_token, null, 'a scroll can reveal unindexed elements, so no token is claimed');
			assertEquals(await recorded('scrolly'), '900', 'the page saw the scroll');
			await h.callStructured('browser_scroll_to', { x: 0, y: 0 });
			const read = await state({ include_hidden: true });
			assertEquals(find(read, 'deep').visible, false, 'the fixture control starts below the fold');
			const into = await h.callStructured<{ bounds: { y: number } | null }>('browser_scroll_into_view', {
				index: find(read, 'deep').index,
				state_token: read.state_token,
			});
			assert(into.bounds !== null && into.bounds.y >= 0, `in the viewport: ${JSON.stringify(into.bounds)}`);
			assertEquals(find(await state(), 'deep').visible, true);
		});

		await t.step('a drag moves a slider, and the page sees the intermediate moves', async () => {
			await go('actions');
			// From the slider's centre (value 50) to a point well to its right.
			const dragged = await h.callStructured<{ steps: number }>('browser_drag', {
				from: { index: find(await state(), 'slider').index },
				to: { x: 900, y: 0 },
				steps: 12,
			});
			assertEquals(dragged.steps, 12);
			assert(Number(await recorded('slider-value')) > 50, 'the slider moved to the right');
			assert(Number(await recorded('drag-moves')) > 0, 'mousemove with the button down: a press/release would not');
		});

		await t.step('a confirm and a prompt are answered by the caller, not by the policy', async () => {
			await go('actions');
			// Subscribing to `dialog` arms the hold; without it the policy answers (accept a confirm, dismiss a prompt).
			await using stream = await EventStream.open(h, '?kinds=dialog');
			const clicking = h.call('browser_click', await argsFor('confirmbtn'));
			const confirm = await stream.until((record) => record.kind === 'dialog', 'the confirm');
			assertEquals(confirm.payload.kind, 'confirm');
			const answered = await h.callStructured<{ accepted: boolean }>('browser_handle_dialog', {
				dialog_id: String(confirm.payload.dialog_id),
				accept: false,
			});
			assertEquals(answered.accepted, false);
			await clicking;
			assertEquals(await recorded('dialog-result'), 'dismissed', 'the page took the caller’s answer');

			const prompting = h.call('browser_click', await argsFor('promptbtn'));
			const prompt = await stream.until((r) => r.kind === 'dialog' && r.payload.kind === 'prompt', 'the prompt');
			await h.callStructured('browser_handle_dialog', {
				dialog_id: String(prompt.payload.dialog_id),
				accept: true,
				prompt_text: 'Ada',
			});
			await prompting;
			assertEquals(await recorded('dialog-result'), 'hello Ada');
			assert(!stream.raw.includes('Ada'), 'prompt_text leaked into the stream');
		});

		await t.step('with no dialog subscriber the server answers by policy, and the tool says so', async () => {
			await go('actions');
			await on('browser_click', 'confirmbtn');
			assertEquals(await recorded('dialog-result'), 'confirmed', 'the automatic policy answered');
			const refusal = await h.callError('browser_handle_dialog', { dialog_id: 'd1', accept: true });
			assertStringIncludes(refusal, 'element-not-found');
			assertStringIncludes(refusal, 'subscribe to the dialog event kind');
		});

		await t.step('a session file is uploaded by file_id, and a foreign id is refused', async () => {
			// `browser_upload_file` takes only ids this session's own ledger holds: download one first.
			await go('downloads');
			const started = await on<{ started: boolean; file: { file_id: string; name: string; size: number } | null }>(
				'browser_download',
				'dl-first',
			);
			assert(started.started && started.file !== null, 'the download produced a ledger record');
			const file = started.file;
			await go('actions');
			const uploaded = await on<{ filename: string; bytes: number }>('browser_upload_file', 'upload', {
				file_id: file.file_id,
			});
			assertEquals([uploaded.filename, uploaded.bytes], [file.name, file.size]);
			assertEquals(await recorded('uploaded'), `${file.name}:${file.size}`);
			const read = await state();
			const foreign = await h.callError('browser_upload_file', {
				index: find(read, 'upload').index,
				file_id: 'not-this-sessions-file',
				state_token: read.state_token,
			});
			assertStringIncludes(foreign, 'unknown-file');
		});

		await t.step('a viewport set by tool is the viewport the next state, the page and the session report', async () => {
			await go('actions');
			const expected = { width: 900, height: 640, device_scale: 2 };
			assertEquals(
				(await h.callStructured<{ viewport: unknown }>('browser_set_viewport', expected)).viewport,
				expected,
			);
			// The state reports the layout viewport: the emulated width less a scrollbar, the exact height.
			const { viewport } = await h.callStructured<{ viewport: { width: number; height: number } }>(
				'browser_get_state',
				{},
			);
			assertEquals(viewport.height, 640);
			assert(viewport.width <= 900 && viewport.width >= 900 - 24, `layout viewport ${viewport.width}`);
			// devicePixelRatio proves device_scale mapped to deviceScaleFactor, not page scale.
			assertEquals(
				await h.pageValue('[innerWidth, innerHeight, devicePixelRatio, visualViewport.scale]'),
				[900, 640, 2, 1],
			);
			assertEquals((await h.callStructured<{ viewport: unknown }>('browser_get_session')).viewport, expected);
		});

		await t.step('locale, timezone and user agent are observable in the page', async () => {
			const options = {
				locale: 'fr-FR',
				timezone: 'Australia/Sydney',
				user_agent: 'TykoTechProbe/1.0',
				accept_downloads: true,
				idle_timeout_s: 600,
			};
			const applied = await h.callStructured<{ applied: Record<string, unknown>; unsupported: string[] }>(
				'browser_set_session_options',
				options,
			);
			for (const [key, value] of Object.entries(options)) assertEquals(applied.applied[key], value, key);
			assertEquals(applied.unsupported, []);
			await go('actions'); // an override applies to what the page evaluates from now on
			assertEquals(
				await h.pageValue(
					'[navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.userAgent]',
				),
				['fr-FR', 'Australia/Sydney', 'TykoTechProbe/1.0'],
			);
			assertEquals((await h.callStructured<{ idle_timeout_s: number }>('browser_get_session')).idle_timeout_s, 600);
		});
	},
});
