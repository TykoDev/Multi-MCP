/**
 * Every catalog tool through a real MCP client against a real Chromium, each asserted on what the browser did (a
 * recorded click coordinate, a changed `scrollY`, a value the page echoed), not on a call returning.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import { CATALOG } from '@tykotech/mcp';
import { harness, imageOf, skipUnlessBrowser, textOf } from '../support/harness.ts';
import { startFixtureSite } from '../fixtures/site.ts';

const ignore = skipUnlessBrowser('tools e2e');

type Bounds = { x: number; y: number; w: number; h: number };

interface PageState {
	session_id: string;
	url: string;
	title: string;
	human_has_control: boolean;
	tabs: Array<{ tab_id: string; url: string; title: string }>;
	viewport: { width: number; height: number };
	scroll: { x: number; y: number; pixels_above: number; pixels_below: number };
	interactive_elements: Array<{ index: number; tag: string; label?: string; href?: string }>;
	page: string;
}

/** The element index whose tag (and optionally label/href) matches. */
function indexOf(state: PageState, predicate: (element: PageState['interactive_elements'][number]) => boolean): number {
	const found = state.interactive_elements.find(predicate);
	assert(found !== undefined, `no matching element among ${JSON.stringify(state.interactive_elements)}`);
	return found.index;
}

Deno.test({
	name: 'e2e tools: navigation, perception, and interaction against a real page',
	ignore,
	async fn(t) {
		await using h = await harness();
		const html = () => h.callText('browser_get_html', {});
		const state = () => h.callJson<PageState>('browser_get_state', {});

		await t.step('browser_navigate reports the page it actually loaded', async () => {
			const result = await h.callJson<{ session_id: string; url: string; title: string }>('browser_navigate', {
				url: h.site.page('index'),
			});
			assertEquals([result.session_id, result.title], ['default', 'TykoTech Fixture Index']);
			assertStringIncludes(result.url, '127.0.0.1');
			assert(h.site.hits.includes('/'), `fixture was never requested: ${h.site.hits.join(',')}`);
		});

		await t.step('browser_wait_for selector and text match a page no tool has read yet', async () => {
			// Straight after a navigation Chromium's DOM agent had no document, and the search found nothing.
			const selector = await h.callJson<{ met: boolean; after_ms: number }>('browser_wait_for', {
				until: { selector: 'body' },
				timeout_ms: 5000,
			});
			assertEquals(selector.met, true);
			assert(selector.after_ms < 2000, `met only after ${selector.after_ms} ms`);
			const text = await h.callJson<{ met: boolean }>('browser_wait_for', {
				until: { text: 'TykoTech Fixture Index' },
				timeout_ms: 5000,
			});
			assertEquals(text.met, true);
			const missing = await h.callJson<{ met: boolean }>('browser_wait_for', {
				until: { selector: '#never-on-this-page' },
				timeout_ms: 600,
			});
			assertEquals(missing.met, false, 'a selector the page lacks still times out');
		});

		await t.step('browser_get_state carries the page text and its controls', async () => {
			const read = await state();
			assertEquals([read.title, read.human_has_control], ['TykoTech Fixture Index', false]);
			assert(read.viewport.width > 0 && read.viewport.height > 0 && read.tabs.length >= 1);
			assertStringIncludes(read.page, h.site.nonce);
			assertStringIncludes(read.page, 'The index page of the TykoTech-MCP fixture site.');
			for (const tag of ['button', 'input', 'a']) indexOf(read, (e) => e.tag === tag);
		});

		await t.step('browser_click and browser_type change the live DOM; clear replaces', async () => {
			await h.callText('browser_click', { index: indexOf(await state(), (e) => e.tag === 'button') });
			assertStringIncludes(await html(), `clicked-${h.site.nonce}`);
			const field = indexOf(await state(), (e) => e.tag === 'input');
			await h.callText('browser_type', { index: field, text: `typed-${h.site.nonce}` });
			assertStringIncludes(await html(), `typed-${h.site.nonce}</div>`);
			assertStringIncludes((await state()).page, `typed-${h.site.nonce}`, 'the value through the a11y tree');
			await h.callText('browser_type', { index: field, text: 'replaced', clear: true });
			const after = await html();
			assertStringIncludes(after, '>replaced</div>');
			assert(!after.includes(`typed-${h.site.nonce}`), 'clear:true left the old value behind');
			assertStringIncludes(after, '<title>TykoTech Fixture Index</title>');
		});

		await t.step('browser_screenshot returns PNG bytes; full_page and include_screenshot', async () => {
			await h.callText('browser_navigate', { url: h.site.page('long') });
			const shot = imageOf(await h.call('browser_screenshot', { full_page: false }));
			const full = imageOf(await h.call('browser_screenshot', { full_page: true }));
			assert(shot !== null && full !== null);
			assertEquals(shot.mimeType, 'image/png');
			assertEquals([...shot.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
			assert(full.bytes.length > shot.bytes.length, 'a 3.2-viewport page is larger in full');
			const both = await h.call('browser_get_state', { include_screenshot: true });
			assertEquals(imageOf(both)?.mimeType, 'image/png');
			assertEquals((JSON.parse(textOf(both)) as PageState).session_id, 'default');
		});

		await t.step('browser_scroll moves the real viewport', async () => {
			assertEquals((await state()).scroll.y, 0);
			await h.callText('browser_scroll', { direction: 'down', pages: 2 });
			const recorded = /<div id="scrolly">(\d+)<\/div>/.exec(await html())?.[1] ?? '0';
			assert(Number(recorded) > 100, `page reported scrollY=${recorded} after scrolling down`);
			const after = await state();
			assert(after.scroll.y > 0 && after.scroll.pixels_above > 0, JSON.stringify(after.scroll));
			await h.callText('browser_scroll', { direction: 'up', pages: 10 });
			assertMatch(await html(), /<div id="scrolly">0<\/div>/);
		});

		await t.step('browser_press_key and focused typing reach the page as real key events', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			await h.callText('browser_press_key', { key: 'Enter' });
			assertStringIncludes(await html(), '<div id="lastkey">Enter</div>');
			await h.callText('browser_press_key', { key: 'Control+a' });
			assertStringIncludes(await html(), '<div id="chord">Ctrl+a</div>');
			await h.callText('browser_click', { index: indexOf(await state(), (e) => e.tag === 'input') });
			await h.callText('browser_type', { text: 'focused-typing' });
			assertStringIncludes(await html(), 'focused-typing');
		});

		await t.step('browser_click by coordinate hits the point named', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			await h.callText('browser_click', { coordinate_x: 120, coordinate_y: 90 });
			const after = await html();
			assertStringIncludes(after, '<div id="clicks">1</div>');
			assertStringIncludes(after, '<div id="lastclick">120,90,b0</div>');
		});

		await t.step('browser_go_back returns to the previous document', async () => {
			await h.callText('browser_navigate', { url: h.site.page('index') });
			await h.callText('browser_navigate', { url: h.site.page('second') });
			assertStringIncludes(await html(), 'arrived-at-second');
			await h.callText('browser_go_back', {});
			assertEquals((await state()).title, 'TykoTech Fixture Index');
		});
	},
});

type Tab = { tab_id: string; url: string; focused: boolean };

/** Polls `browser_list_tabs` until the count settles; popups appear asynchronously. */
async function pollTabs(h: { callJson<T>(name: string): Promise<T> }, expected: number): Promise<Tab[]> {
	const deadline = Date.now() + 15_000;
	let last: Tab[] = [];
	while (Date.now() < deadline) {
		last = (await h.callJson<{ tabs: Tab[] }>('browser_list_tabs')).tabs;
		if (last.length === expected) return last;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return last;
}

Deno.test({
	name: 'e2e tools: tabs are listed, switched, and closed for real',
	ignore,
	async fn() {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('tabs') });
		const first = await pollTabs(h, 1);
		assertEquals(first[0]?.focused, true);
		assertStringIncludes(first[0]?.url ?? '', '/tabs');

		// The anchor carries target=_blank: Chromium opens a real second target.
		const state = await h.callJson<PageState>('browser_get_state', {});
		await h.callText('browser_click', { index: indexOf(state, (e) => e.tag === 'a') });
		const listed = await pollTabs(h, 2);
		const second = listed.find((tab) => tab.url.includes('/second'));
		assert(listed.length === 2 && second !== undefined, `tabs: ${JSON.stringify(listed)}`);
		const switched = await h.callJson<{ tabs: Tab[] }>('browser_switch_tab', { tab_id: second.tab_id });
		assertEquals(switched.tabs.find((tab) => tab.tab_id === second.tab_id)?.focused, true);
		assertEquals((await pollTabs(h, 2)).find((tab) => tab.tab_id === second.tab_id)?.focused, true);
		assertStringIncludes(await h.callText('browser_get_html', {}), 'arrived-at-second');
		await h.callText('browser_close_tab', { tab_id: second.tab_id });
		assertEquals((await pollTabs(h, 1)).map((tab) => tab.tab_id).includes(second.tab_id), false);
	},
});

Deno.test({
	name: 'e2e tools: session lifecycle across real browsers',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_MAX_SESSIONS: '2' } });
		const sessions = async () =>
			(await h.callJson<{ sessions: Array<{ session_id: string; tab_count: number }> }>('browser_list_sessions', {}))
				.sessions;

		await t.step('the default session is created lazily on first use', async () => {
			assertEquals(await sessions(), []);
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const listed = await sessions();
			assertEquals(listed.map((s) => s.session_id), ['default']);
			assert((listed[0]?.tab_count ?? 0) >= 1);
		});

		let extra = '';
		await t.step('new_session launches a second, independent browser, up to the cap', async () => {
			const created = await h.callJson<{ session_id: string; title: string }>('browser_navigate', {
				url: h.site.page('second'),
				new_session: true,
			});
			extra = created.session_id;
			assert(extra !== 'default' && extra.length > 0, `unexpected session id ${extra}`);
			assertEquals(created.title, 'Second Page');
			assertEquals((await h.callJson<PageState>('browser_get_state', {})).title, 'TykoTech Fixture Index');
			assertEquals((await h.callJson<PageState>('browser_get_state', { session_id: extra })).title, 'Second Page');
			const error = await h.callError('browser_navigate', { url: h.site.page('index'), new_session: true });
			assertStringIncludes(error, 'Error: session-limit');
			assertStringIncludes(error, 'at most 2 concurrent sessions');
		});

		await t.step('browser_close_session closes exactly one; an unknown id is refused, never created', async () => {
			await h.callText('browser_close_session', { session_id: extra });
			assertEquals((await sessions()).map((s) => s.session_id), ['default']);
			assertStringIncludes(await h.callError('browser_get_state', { session_id: extra }), 'Error: unknown-session');
			assertStringIncludes(
				await h.callError('browser_close_session', { session_id: 'nope' }),
				'Error: unknown-session',
			);
		});

		await t.step('browser_close_all closes the rest', async () => {
			assertStringIncludes(await h.callText('browser_close_all', {}), 'Closed 1 session');
			assertEquals(await sessions(), []);
		});
	},
});

Deno.test({
	name: 'e2e tools: failures are result-level errors a model can act on',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: 'example.com,127.0.0.1' } });

		await t.step('a blocked scheme or a host outside the allowlist never reaches the browser', async () => {
			const scheme = await h.callError('browser_navigate', { url: 'file:///etc/passwd' });
			assertStringIncludes(scheme, 'Error: navigation-blocked');
			assertStringIncludes(scheme, 'unsupported scheme: file:');
			const host = await h.callError('browser_navigate', { url: 'https://evil-example.com/' });
			assertStringIncludes(host, 'Error: navigation-blocked');
			assertStringIncludes(host, 'not in the server');
		});

		await t.step(
			'a fresh navigation holds no index table, and a stale index names the tool that refreshes',
			async () => {
				await h.callJson<{ url: string }>('browser_navigate', { url: h.site.page('index') });
				const fresh = await h.callError('browser_click', { index: 1 });
				assertStringIncludes(fresh, 'Error: element-not-found');
				assertStringIncludes(fresh, 'browser_get_state');
				await h.callJson<PageState>('browser_get_state', {});
				const stale = await h.callError('browser_click', { index: 9999 });
				assertStringIncludes(stale, 'Error: unknown-index');
				assertStringIncludes(stale, 'browser_get_state');
			},
		);

		await t.step('an index survives the secret-substitution URL read', async () => {
			// The `<secret>` placeholder issues a DOM-less state read, which must not overwrite the index cache.
			const field = indexOf(await h.callJson<PageState>('browser_get_state', {}), (e) => e.tag === 'input');
			const text = textOf(await h.call('browser_type', { index: field, text: 'plain-<secret>absent</secret>' }));
			assert(!text.includes('unknown-index') && !text.includes('element-not-found'), text);
		});

		await t.step(
			'browser_get_state publishes a state_token in structured content only; a stale one is refused',
			async () => {
				const first = await h.call('browser_get_state', {});
				const token = (first.structuredContent as { state_token?: string | null }).state_token;
				assert(typeof token === 'string' && token.includes('.'), `no state_token on the wire: ${token}`);
				assert(!('state_token' in JSON.parse(textOf(first))), 'state_token leaked into the frozen text block');
				const field = indexOf(await h.callJson<PageState>('browser_get_state', {}), (e) => e.tag === 'input');
				const error = await h.callError('browser_click', {
					index: field,
					state_token: '0000000000000000.0000000000000000',
				});
				assertStringIncludes(error, 'Error: element-not-found');
			},
		);

		await t.step('an unknown tab id is refused', async () => {
			for (const tool of ['browser_switch_tab', 'browser_close_tab']) {
				assertStringIncludes(await h.callError(tool, { tab_id: 'NOT-A-TARGET' }), 'Error: unknown-tab');
			}
		});

		await t.step('schema violations arrive as error results, not crashes', async () => {
			// `browser_click` takes an index XOR both coordinates; a bad URL fails the schema before the policy.
			for (
				const [tool, args] of [
					['browser_click', { index: 1, coordinate_x: 5, coordinate_y: 5 }],
					['browser_click', {}],
					['browser_navigate', { url: 'not a url' }],
				] as const
			) {
				assertEquals((await h.call(tool, args)).isError, true, JSON.stringify(args));
			}
		});
	},
});

Deno.test({
	name: 'e2e tools: the advertised catalog matches what a principal may call',
	ignore,
	async fn(t) {
		await using h = await harness({ scopes: ['mcp:invoke', 'view:watch'] });

		await t.step('a non-admin is not offered browser_close_all; everything unscoped and unconditional is', async () => {
			const listed = await h.client.listTools({});
			const names = listed.tools.map((tool) => tool.name);
			assert(!names.includes('browser_close_all'), 'close_all leaked into a non-admin catalog');
			for (const tool of CATALOG) {
				if (tool.scope === undefined && tool.available === undefined) assert(names.includes(tool.name), tool.name);
			}
			// Annotations match each tool's class.
			for (const tool of listed.tools) {
				const definition = CATALOG.find((entry) => entry.name === tool.name);
				assert(definition !== undefined, `tools/list offered an unknown tool ${tool.name}`);
				assertEquals(tool.annotations?.readOnlyHint, definition.mutates ? undefined : true, tool.name);
			}
		});

		await t.step('calling it answers scope-required as a result, naming no scope', async () => {
			// Not a JSON-RPC "not found", which a client would read as "this server lacks the feature".
			const refused = await h.client.callTool({ name: 'browser_close_all', arguments: {} }) as {
				isError?: boolean;
				content?: Array<{ text?: string }>;
				structuredContent?: { error?: { code?: string } };
			};
			assertEquals(refused.isError, true);
			assertStringIncludes(refused.content?.[0]?.text ?? '', 'Error: scope-required: ');
			assertEquals(refused.structuredContent?.error?.code, 'scope-required');
			assert(!JSON.stringify(refused).includes('"admin"'), 'the refusal named the scope');
		});
	},
});

interface RichState extends PageState {
	state_token: string | null;
	focused_index: number | null;
	frames: Array<{
		id: string;
		name: string;
		url: string;
		parent: string | null;
		bounds: Bounds | null;
		bounds_composed: boolean;
		is_oopif: boolean;
		captured: boolean;
	}>;
	frames_unknown: string[];
	capture_truncated: boolean;
	interactive_elements: Array<{
		index: number;
		tag: string;
		label?: string;
		href?: string;
		bounds?: Bounds | null;
		focused?: boolean;
		frame_id?: string;
		input?: { type: string; name: string; value: string | null; checked: boolean | null };
		attrs?: Record<string, string>;
	}>;
}

Deno.test({
	name: 'e2e tools: the element record, browser_find, the locator tools and frames, through an OOPIF',
	ignore,
	async fn(t) {
		// A second site on `localhost` is another site to Chromium: its frame renders out of process.
		const second = startFixtureSite({ hostname: 'localhost' });
		try {
			await using h = await harness({ site: { frameOrigin: second.url.replace(/\/$/, '') } });
			const rich = (args: Record<string, unknown>) =>
				h.call('browser_get_state', args).then((r) => r.structuredContent as unknown as RichState);

			await t.step('input.value is the live property, and the typed field is the one focused element', async () => {
				await h.callText('browser_navigate', { url: h.site.page('form') });
				const name = indexOf(await h.callJson<PageState>('browser_get_state', {}), (e) => e.label === 'your name');
				await h.callText('browser_type', { index: name, text: 'Ada' });
				const state = await rich({ fields: ['full'] });
				const field = state.interactive_elements.find((e) => e.index === name);
				assertEquals([field?.input?.value, field?.input?.name, field?.attrs?.id], ['Ada', 'name', 'name']);
				assert((field?.bounds?.w ?? 0) > 0);
				assertEquals(field?.frame_id, state.frames[0]?.id, 'the top document is the join key');
				assertEquals(state.interactive_elements.filter((e) => e.focused === true).length, 1);
				assertEquals(state.focused_index, name);
				assertEquals(state.interactive_elements.find((e) => e.attrs?.id === 'agree')?.input?.checked, false);
				await h.callText('browser_navigate', { url: h.site.page('keys') });
				const autofocused = await rich({});
				assertEquals(
					autofocused.focused_index,
					autofocused.interactive_elements.find((e) => e.label === 'focus me')?.index,
				);
			});

			await t.step('browser_find returns the same link by role+name, href_pattern, near and css', async () => {
				await h.callText('browser_navigate', { url: h.site.page('index') });
				type Find = {
					matches: Array<{ index: number; score: number; bounds?: Bounds }>;
					total: number;
					unique: boolean;
					truncated: boolean;
					state_token: string;
				};
				const find = (query: Record<string, unknown>, limit?: number) =>
					h.callJson<Find>('browser_find', { query, limit });
				const byName = await find({ role: 'link', name: 'go to second' });
				assertEquals([byName.total, byName.unique, byName.matches[0]!.score], [1, true, 1]);
				assert(typeof byName.state_token === 'string' && byName.state_token.includes('.'));
				const link = byName.matches[0]!;
				assert(link.bounds !== undefined);
				assertEquals((await find({ href_pattern: '^/second$' })).matches[0]!.index, link.index);
				assertEquals((await find({ css: '#to-second' })).matches.map((m) => m.index), [link.index]);
				const near = await find({
					near: { x: link.bounds.x + link.bounds.w / 2, y: link.bounds.y + link.bounds.h / 2 },
				}, 1);
				assertEquals([near.matches[0]!.index, near.matches[0]!.score, near.truncated], [link.index, 1, true]);
			});

			await t.step('browser_locator_candidates and browser_verify_locator agree on the page as it is', async () => {
				const link = indexOf(await h.callJson<PageState>('browser_get_state', {}), (e) => e.tag === 'a');
				const candidates = await h.callJson<{ locators: Array<{ kind: string }>; best: { value: string } | null }>(
					'browser_locator_candidates',
					{ index: link },
				);
				assertEquals(candidates.locators.map((c) => c.kind), ['id', 'aria', 'text']);
				assertEquals(candidates.best?.value, '#to-second');
				const verify = (kind: string, value: string, frame_id?: string) =>
					h.callJson<{ matches: number; unique: boolean; first: { index: number; label?: string } | null }>(
						'browser_verify_locator',
						{ locator: { kind, value }, ...(frame_id === undefined ? {} : { frame_id }) },
					);
				const byId = await verify('id', '#to-second');
				assertEquals([byId.unique, byId.first?.index], [true, link]);
				const byAria = await verify('aria', 'role=link[name="go to second"]');
				assertEquals([byAria.matches, byAria.first?.index], [1, link]);
				const nothing = await verify('css', '#no-such-element-anywhere');
				assertEquals([nothing.matches, nothing.first], [0, null], 'names nothing today: a success, not an error');

				await h.callText('browser_navigate', { url: h.site.page('oopif') });
				const { frames } = await h.callJson<{ frames: RichState['frames'] }>('browser_get_frames', {});
				const inChild = await verify('id', '#frame-btn', frames[1]!.id);
				assertEquals([inChild.matches, inChild.first?.label], [1, 'Frame button']);
			});

			await t.step('a click at the published bounds of an OOPIF button lands in the child frame', async () => {
				const state = await rich({ fields: ['full'] });
				assertEquals(state.frames.length, 2, JSON.stringify(state.frames));
				const child = state.frames[1]!;
				assertEquals(
					[child.parent, child.is_oopif, child.captured, child.bounds_composed, child.name, state.capture_truncated],
					[state.frames[0]!.id, true, true, true, 'child', false],
				);
				assertStringIncludes(child.url, 'localhost');
				const button = state.interactive_elements.find((e) => e.tag === 'button' && e.frame_id === child.id);
				assert(button?.bounds !== undefined && button.bounds !== null && child.bounds !== null, 'the frame button');
				assertEquals(button.label, 'Frame button');
				assert(button.bounds.x > child.bounds.x && button.bounds.y > child.bounds.y, 'inside the host box');
				// `bounds` is top-document viewport CSS px, the space `browser_click` takes.
				const x = button.bounds.x + button.bounds.w / 2 - state.scroll.x;
				const y = button.bounds.y + button.bounds.h / 2 - state.scroll.y;
				await h.callText('browser_click', { coordinate_x: x, coordinate_y: y });
				const after = await h.callJson<PageState>('browser_get_state', {});
				const hit = new RegExp(`clicked-in-frame-${second.nonce}-at-(\\d+),(\\d+)`).exec(after.page);
				assert(hit !== null, `the child frame's own handler did not fire: ${after.page.slice(0, 400)}`);
				// The child reports its own client space: the point minus the frame's content box (host box plus border).
				assert(Math.abs(Number(hit[1]) - (x - (child.bounds.x + 1))) <= 1.5, `x ${hit[1]}`);
				assert(Math.abs(Number(hit[2]) - (y - (child.bounds.y + 1))) <= 1.5, `y ${hit[2]}`);
			});

			await t.step('frames: top only, an unknown id reported, a bad fields member refused by name', async () => {
				const top = await rich({ frames: 'top' });
				assertEquals(top.frames.length, 2, 'the frame list is always the whole page');
				assert(top.interactive_elements.every((e) => e.frame_id === top.frames[0]!.id));
				assertEquals((await rich({ frames: ['nope'] })).frames_unknown, ['nope']);
				const error = await h.callError('browser_get_state', { fields: ['bounds', 'colour'] });
				assertStringIncludes(error, 'Error: invalid-arguments');
				assertStringIncludes(error, 'fields.1');
			});
		} finally {
			await second.close();
		}
	},
});
