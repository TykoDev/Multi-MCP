/**
 * B2.5 and B2.6: the action, session and viewport tools against a real Chromium.
 *
 * Acceptance rows AC-P1-13 (`browser_select_option` by value, label and position, with the change
 * handler firing for each), AC-P1-14 (`browser_fill` replaces rather than appends), AC-P1-17
 * (`browser_scroll_into_view` and `browser_scroll_to`), AC-P1-19 (`browser_handle_dialog` on a
 * `confirm` and a `prompt`), AC-P1-20 (`browser_upload_file` by `file_id`) and AC-P1-21
 * (`browser_drag` moves a slider); and from B2.6, AC-P1-18 (`browser_set_viewport` is the viewport
 * the next state reports) and AC-P1-27 (`browser_set_session_options`' locale, timezone and user
 * agent observable in the page, and — since A3 — `accept_downloads` applied at runtime).
 *
 * Every assertion reads what the **page** recorded. `#changed` and `#change-count` are written by the
 * `<select>`'s own change handler, so "the value is set" and "the page knows the value is set" are
 * distinguished — only the second is what a replay needs. `#drag-moves` counts `mousemove` events
 * seen with the button down, so a drag that pressed and released without moving between is caught
 * rather than passing. `#uploaded` is written by the file input's own change handler.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('actions e2e');

interface Element {
	index: number;
	tag: string;
	attrs?: Record<string, string>;
	visible?: boolean;
}
interface State {
	state_token: string | null;
	interactive_elements: Element[];
}

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

/** The text of one recorder `<div>`, read from the page's own bytes. */
async function recorded(
	h: { callText(name: string, args?: Record<string, unknown>): Promise<string> },
	id: string,
): Promise<string> {
	const html = await h.callText('browser_get_html', {});
	const match = new RegExp(`<div id="${id}"[^>]*>([^<]*)</div>`).exec(html);
	assert(match !== null, `#${id} not found in the document`);
	return match[1] ?? '';
}

function find(state: State, id: string): Element {
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(state.interactive_elements)}`);
	return found;
}

Deno.test({
	name: 'e2e B2.5/B2.6: select, fill, scrolling, upload, drag, dialogs, viewport and session options',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('actions') });
		const fields = ['core', 'attrs'];

		await t.step(
			'AC-P1-13: a select is set by value, by label and by position, and change fires each time',
			async () => {
				const state = await structured<State>(h, 'browser_get_state', { fields });
				const colour = find(state, 'colour').index;

				const byValue = await structured<{ selected: { value: string; label: string; index_in_list: number } }>(
					h,
					'browser_select_option',
					{ index: colour, value: 'b', state_token: state.state_token },
				);
				assertEquals(byValue.selected, { value: 'b', label: 'Bleu', index_in_list: 2 });
				assertEquals(await recorded(h, 'changed'), 'b', 'the page’s own change handler ran');
				assertEquals(await recorded(h, 'change-count'), '1');

				const fresh = await structured<State>(h, 'browser_get_state', { fields });
				const byLabel = await structured<{ selected: { value: string; index_in_list: number } }>(
					h,
					'browser_select_option',
					{ index: find(fresh, 'colour').index, label: 'Vert', state_token: fresh.state_token },
				);
				assertEquals(byLabel.selected.value, 'g');
				assertEquals(byLabel.selected.index_in_list, 1);
				assertEquals(await recorded(h, 'change-count'), '2');

				const third = await structured<State>(h, 'browser_get_state', { fields });
				const byPosition = await structured<{ selected: { value: string; label: string } }>(
					h,
					'browser_select_option',
					{ index: find(third, 'colour').index, index_in_list: 0, state_token: third.state_token },
				);
				assertEquals(byPosition.selected.value, 'r');
				assertEquals(byPosition.selected.label, 'Rouge');
				assertEquals(await recorded(h, 'change-count'), '3');
			},
		);

		await t.step('a select that matches nothing, and a non-select, are element-not-interactable', async () => {
			const state = await structured<State>(h, 'browser_get_state', { fields });
			const missed = await h.callError('browser_select_option', {
				index: find(state, 'colour').index,
				value: 'no-such-value',
				state_token: state.state_token,
			});
			assertStringIncludes(missed, 'element-not-interactable');
			// The count, never the option text: a miss must not become a way to read the list.
			assertStringIncludes(missed, '3 options');

			const notASelect = await h.callError('browser_select_option', {
				index: find(state, 'slider').index,
				value: 'x',
				state_token: state.state_token,
			});
			assertStringIncludes(notASelect, 'element-not-interactable');
			assertStringIncludes(notASelect, 'not a <select>');
		});

		await t.step('AC-P1-14: fill REPLACES a remembered value where type appends', async () => {
			await h.callText('browser_navigate', { url: h.site.page('form') });
			const state = await structured<State>(h, 'browser_get_state', { fields });
			const name = find(state, 'name').index;

			await structured(h, 'browser_type', { index: name, text: 'Ada', state_token: state.state_token });
			let echo = await h.callText('browser_get_html', {});
			assertStringIncludes(echo, '"name":"Ada"');

			// The defect this tool exists for: `browser_type` on a field that already holds a value
			// appends to it. The same call as `browser_fill` must end holding only the new text.
			const again = await structured<State>(h, 'browser_get_state', { fields });
			await structured(h, 'browser_type', {
				index: find(again, 'name').index,
				text: 'Grace',
				state_token: again.state_token,
			});
			echo = await h.callText('browser_get_html', {});
			assertStringIncludes(echo, '"name":"AdaGrace"', 'type appends — this is the behaviour fill exists to fix');

			const third = await structured<State>(h, 'browser_get_state', { fields });
			const filled = await structured<{ cleared: boolean; typed_length?: number }>(h, 'browser_fill', {
				index: find(third, 'name').index,
				text: 'Hopper',
				state_token: third.state_token,
			});
			assertEquals(filled.cleared, true);
			assertEquals(filled.typed_length, 'Hopper'.length);
			echo = await h.callText('browser_get_html', {});
			assertStringIncludes(echo, '"name":"Hopper"');
			assert(!echo.includes('AdaGrace'), 'the remembered value must be gone');
		});

		await t.step(
			'AC-P1-17: scroll_to lands at a named point and scroll_into_view brings an element into view',
			async () => {
				await h.callText('browser_navigate', { url: h.site.page('actions') });
				assertEquals(await recorded(h, 'scrolly'), '0');

				const to = await structured<{ scroll: { y: number }; state_token: null }>(h, 'browser_scroll_to', {
					x: 0,
					y: 900,
				});
				assertEquals(to.scroll.y, 900, 'the document is where it was told to be');
				assertEquals(to.state_token, null, 'a scroll can reveal unindexed elements, so no token is claimed');
				assertEquals(await recorded(h, 'scrolly'), '900', 'the page saw the scroll');

				// Back to the top, then let the tool find the below-the-fold control.
				await structured(h, 'browser_scroll_to', { x: 0, y: 0 });
				const state = await structured<State>(h, 'browser_get_state', { fields, include_hidden: true });
				const deep = find(state, 'deep');
				assertEquals(deep.visible, false, 'the fixture control starts below the fold');

				const into = await structured<{ bounds: { y: number; h: number } | null }>(h, 'browser_scroll_into_view', {
					index: deep.index,
					state_token: state.state_token,
				});
				assert(into.bounds !== null, 'a top-document element reports its live box');
				assert(into.bounds.y >= 0, `the element is in the viewport, not above it: ${JSON.stringify(into.bounds)}`);
				const after = await structured<State>(h, 'browser_get_state', { fields });
				assertEquals(find(after, 'deep').visible, true, 'and the next state agrees it is visible');
			},
		);

		await t.step('AC-P1-21: a drag moves a slider, and the page sees the intermediate moves', async () => {
			await h.callText('browser_navigate', { url: h.site.page('actions') });
			const state = await structured<State>(h, 'browser_get_state', { fields });
			const slider = find(state, 'slider');
			assertEquals(await recorded(h, 'slider-value'), '0');

			// From the slider itself (its centre, which is value 50) to a point well to its right, so the
			// thumb has to travel. Both endpoints go through the click cascade's geometry.
			const dragged = await structured<{ from: { x: number }; to: { x: number }; steps: number }>(h, 'browser_drag', {
				from: { index: slider.index },
				to: { x: 900, y: 0 },
				steps: 12,
				state_token: state.state_token,
			});
			assertEquals(dragged.steps, 12);
			const value = Number(await recorded(h, 'slider-value'));
			assert(value > 50, `the slider moved to the right: ${value}`);
			const moves = Number(await recorded(h, 'drag-moves'));
			assert(moves > 0, 'the page saw mousemove with the button down — a press/release pair would not');
		});

		await t.step('AC-P1-19: a confirm and a prompt are answered BY THE CALLER, not by the policy', async () => {
			await h.callText('browser_navigate', { url: h.site.page('actions') });
			// Subscribing to the `dialog` kind is what arms the hold. Without it the server answers by
			// policy — accept a confirm, dismiss a prompt — and neither answer below is reachable.
			await using stream = await Stream.open(h, '?kinds=dialog');
			await stream.until((record) => record.kind === 'control' && record.payload.event === 'stream-open', 'the open');

			// A confirm the policy would have ACCEPTED, dismissed by the caller.
			const state = await structured<State>(h, 'browser_get_state', { fields });
			const clicking = h.call('browser_click', {
				index: find(state, 'confirmbtn').index,
				state_token: state.state_token,
			});
			const confirmEvent = await stream.until((record) => record.kind === 'dialog', 'the confirm');
			assertEquals(confirmEvent.payload.kind, 'confirm');
			const confirmId = String(confirmEvent.payload.dialog_id);
			assert(confirmId !== '', 'a held dialog is announced with an id');
			const answered = await structured<{ accepted: boolean }>(h, 'browser_handle_dialog', {
				dialog_id: confirmId,
				accept: false,
			});
			assertEquals(answered.accepted, false);
			await clicking;
			assertEquals(await recorded(h, 'dialog-result'), 'dismissed', 'the page took the caller’s answer');

			// A prompt the policy would have DISMISSED, accepted with the caller's own text.
			const second = await structured<State>(h, 'browser_get_state', { fields });
			const prompting = h.call('browser_click', {
				index: find(second, 'promptbtn').index,
				state_token: second.state_token,
			});
			const promptEvent = await stream.until(
				(record) => record.kind === 'dialog' && record.payload.kind === 'prompt',
				'the prompt',
			);
			await structured(h, 'browser_handle_dialog', {
				dialog_id: String(promptEvent.payload.dialog_id),
				accept: true,
				prompt_text: 'Ada',
			});
			await prompting;
			assertEquals(await recorded(h, 'dialog-result'), 'hello Ada', 'the caller’s text reached the page');

			// DD-7's shape here: the caller-supplied text is nowhere in the event stream. It was never a
			// disclosure — the caller sent it — but a second copy in a transcript buys no capability.
			assert(!stream.raw.includes('Ada'), `prompt_text leaked into the stream: ${stream.raw.slice(0, 800)}`);
		});

		await t.step('with NO dialog subscriber the server answers by policy, and the tool says so', async () => {
			await h.callText('browser_navigate', { url: h.site.page('actions') });
			const state = await structured<State>(h, 'browser_get_state', { fields });
			// No stream is open, so nothing is held: the policy accepts a confirm immediately.
			await structured(h, 'browser_click', {
				index: find(state, 'confirmbtn').index,
				state_token: state.state_token,
			});
			assertEquals(await recorded(h, 'dialog-result'), 'confirmed', 'the automatic policy answered');
			const refusal = await h.callError('browser_handle_dialog', { dialog_id: 'd1', accept: true });
			assertStringIncludes(refusal, 'element-not-found');
			assertStringIncludes(refusal, 'subscribe to the dialog event kind');
		});

		await t.step('AC-P1-20: a session file is uploaded by file_id, and a foreign id is refused', async () => {
			// A real download first: `browser_upload_file` takes only ids this session's own ledger holds,
			// so the file has to come from the browser rather than from the test.
			await h.callText('browser_navigate', { url: h.site.page('downloads') });
			const state0 = await structured<State>(h, 'browser_get_state', { fields });
			const link = find(state0, 'dl-first');
			const started = await structured<
				{ started: boolean; file: { file_id: string; name: string; size: number } | null }
			>(
				h,
				'browser_download',
				{ index: link.index, state_token: state0.state_token },
			);
			assertEquals(started.started, true);
			assert(started.file !== null, 'the download produced a ledger record');
			const downloaded = started.file;
			assert(downloaded.file_id.length > 0, 'the download produced a file id');

			await h.callText('browser_navigate', { url: h.site.page('actions') });
			const state = await structured<State>(h, 'browser_get_state', { fields });
			const uploaded = await structured<{ filename: string; bytes: number }>(h, 'browser_upload_file', {
				index: find(state, 'upload').index,
				file_id: downloaded.file_id,
				state_token: state.state_token,
			});
			assertEquals(uploaded.filename, downloaded.name);
			assertEquals(uploaded.bytes, downloaded.size);
			// The page's own change handler is what proves the file reached the form.
			assertEquals(await recorded(h, 'uploaded'), `${downloaded.name}:${downloaded.size}`);

			// SEC-09: an id this session's ledger never tracked is refused before anything is dispatched.
			const fresh = await structured<State>(h, 'browser_get_state', { fields });
			const foreign = await h.callError('browser_upload_file', {
				index: find(fresh, 'upload').index,
				file_id: 'not-this-sessions-file',
				state_token: fresh.state_token,
			});
			assertStringIncludes(foreign, 'unknown-file');
		});

		await t.step('AC-P1-18: a viewport set by tool is the viewport the next state reports', async () => {
			await h.callText('browser_navigate', { url: h.site.page('actions') });
			const set = await structured<{ viewport: { width: number; height: number; device_scale: number } }>(
				h,
				'browser_set_viewport',
				{ width: 900, height: 640, device_scale: 2 },
			);
			assertEquals(set.viewport, { width: 900, height: 640, device_scale: 2 });

			// `browser_get_state`'s `viewport` is the **layout** viewport — what the content is laid out
			// into — so a page with a vertical scrollbar reports a width narrower than the emulated one
			// by the scrollbar's width (measured: 885 against 900 on this fixture). Both numbers are
			// true and they are not the same number; asserting equality here would have been asserting
			// that this page has no scrollbar. The height, which no scrollbar takes from, is exact.
			const state = await structured<{ viewport: { width: number; height: number } }>(
				h,
				'browser_get_state',
				{ fields },
			);
			assertEquals(state.viewport.height, 640, 'the state reports the height the tool set');
			assert(
				state.viewport.width <= 900 && state.viewport.width >= 900 - 24,
				`the layout viewport is the emulated one less a scrollbar: ${state.viewport.width}`,
			);

			// The page's own view of it, which is the only reading that is not the server quoting itself
			// back. `devicePixelRatio` is the half that proves `device_scale` mapped to deviceScaleFactor
			// rather than to page scale.
			const measured = await measure(h, '[innerWidth, innerHeight, devicePixelRatio, visualViewport.scale]');
			assertEquals(measured, [900, 640, 2, 1], 'and the page agrees — with a visual viewport scale of 1');

			// `browser_get_session` reports the override rather than the launch profile.
			const session = await structured<
				{ viewport: { width: number; height: number; device_scale: number } | null }
			>(h, 'browser_get_session');
			assertEquals(session.viewport, { width: 900, height: 640, device_scale: 2 });
		});

		await t.step('AC-P1-27: locale, timezone and user agent are observable in the page', async () => {
			const applied = await structured<{ applied: Record<string, unknown>; unsupported: string[] }>(
				h,
				'browser_set_session_options',
				{
					locale: 'fr-FR',
					timezone: 'Australia/Sydney',
					user_agent: 'TykoTechProbe/1.0',
					accept_downloads: true,
					idle_timeout_s: 600,
				},
			);
			assertEquals(applied.applied.locale, 'fr-FR');
			assertEquals(applied.applied.timezone, 'Australia/Sydney');
			assertEquals(applied.applied.user_agent, 'TykoTechProbe/1.0');
			assertEquals(applied.applied.idle_timeout_s, 600);
			// A3 (E-77): applied at runtime through the session's downloads watchdog, so a real browser
			// takes it and nothing is left in `unsupported`.
			assertEquals(applied.applied.accept_downloads, true);
			assertEquals(applied.unsupported, []);

			// A reload, because an override applies to what the page evaluates from now on.
			await h.callText('browser_navigate', { url: h.site.page('actions') });
			const observed = await measure(
				h,
				'[navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.userAgent]',
			);
			assertEquals(observed[0], 'fr-FR');
			assertEquals(observed[1], 'Australia/Sydney');
			assertEquals(observed[2], 'TykoTechProbe/1.0');

			// And the session reports the timeout it is actually subject to.
			const session = await structured<{ idle_timeout_s: number }>(h, 'browser_get_session');
			assertEquals(session.idle_timeout_s, 600);
		});
	},
});

/**
 * Evaluates a fixed expression in the page and returns its value.
 *
 * Reaches into the registry rather than going through a tool: `browser_evaluate` is B2.7 and does not
 * exist yet, and the point of these two steps is to read what the **page** believes rather than what
 * the server just told us it set.
 */
async function measure(
	h: { gateway: { registry: { peek(id: string): unknown } } },
	expression: string,
): Promise<unknown[]> {
	const record = h.gateway.registry.peek('default') as {
		session: {
			cdpClient:
				| { send: { Runtime: { evaluate(p: unknown, s: string): Promise<{ result: { value?: unknown } }> } } }
				| null;
			sessionManager: { getOrCreateCdpSession(t: unknown, f: boolean): Promise<{ sessionId: string }> } | null;
			agentFocusTargetId: string | null;
		};
	} | undefined;
	assert(record !== undefined && record.session.cdpClient !== null && record.session.sessionManager !== null);
	const cdp = await record.session.sessionManager.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
	const out = await record.session.cdpClient.send.Runtime.evaluate(
		{ expression, returnByValue: true },
		cdp.sessionId,
	);
	return out.result.value as unknown[];
}

/**
 * A minimal SSE reader.
 *
 * Kept here rather than shared with `events_e2e_test.ts`: that suite's reader exists to prove what a
 * stream must *not* contain and carries its own sentinel machinery, and one class serving two
 * different claims is how a test file stops saying what it checks.
 */
class Stream implements AsyncDisposable {
	readonly records: Array<{ kind: string; payload: Record<string, unknown> }> = [];
	raw = '';
	#reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	static async open(
		h: { fetch(path: string, init?: RequestInit): Promise<Response> },
		query: string,
	): Promise<Stream> {
		const stream = new Stream();
		const response = await h.fetch(`/api/v1/sessions/default/events${query}`, {
			headers: { accept: 'text/event-stream' },
		});
		assertEquals(response.status, 200, `the stream did not open: ${response.status}`);
		assert(response.body !== null);
		stream.#reader = response.body.getReader();
		void stream.#read();
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
					for (const line of buffer.slice(0, boundary).split('\n')) {
						if (!line.startsWith('data: ')) continue;
						try {
							this.records.push(JSON.parse(line.slice(6)));
						} catch { /* a keep-alive comment is not data */ }
					}
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf('\n\n');
				}
			}
		} catch { /* cancelled */ }
	}

	async until(
		predicate: (record: { kind: string; payload: Record<string, unknown> }) => boolean,
		what: string,
		timeoutMs = 15_000,
	): Promise<{ kind: string; payload: Record<string, unknown> }> {
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
	}
}
