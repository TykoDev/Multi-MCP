/**
 * Every tool in the catalog, driven through a real MCP client against a real
 * Chromium — and every one asserted on what the *browser* did, not on the fact
 * that a call returned.
 *
 * A tool that only proves "no exception was thrown" is a tool nobody has
 * tested: this suite reads the effect back out of the live page (a recorded
 * click coordinate, a changed `scrollY`, a value the page echoed) so a
 * regression in the CDP layer cannot pass.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import { CATALOG } from '@tykotech/mcp';
import { harness, imageOf, skipUnlessBrowser, textOf } from '../support/harness.ts';

const ignore = skipUnlessBrowser('tools e2e');

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
function indexOf(
	state: PageState,
	predicate: (element: PageState['interactive_elements'][number]) => boolean,
): number {
	const found = state.interactive_elements.find(predicate);
	assert(
		found !== undefined,
		`no matching element among ${JSON.stringify(state.interactive_elements)}`,
	);
	return found.index;
}

Deno.test({
	name: 'e2e tools: navigation, perception, and interaction against a real page',
	ignore,
	async fn(t) {
		await using h = await harness();

		await t.step('browser_navigate reports the page it actually loaded', async () => {
			const result = await h.callJson<{ session_id: string; url: string; title: string }>(
				'browser_navigate',
				{ url: h.site.page('index') },
			);
			assertEquals(result.session_id, 'default');
			assertEquals(result.title, 'TykoTech Fixture Index');
			assertStringIncludes(result.url, '127.0.0.1');
			// The fixture server logged the request, so the browser really fetched it.
			assert(h.site.hits.includes('/'), `fixture was never requested: ${h.site.hits.join(',')}`);
		});

		await t.step('browser_get_state carries the page text, not just its elements', async () => {
			const state = await h.callJson<PageState>('browser_get_state', {});
			assertEquals(state.title, 'TykoTech Fixture Index');
			assertEquals(state.human_has_control, false);
			assert(state.viewport.width > 0 && state.viewport.height > 0);
			assertEquals(state.tabs.length >= 1, true);
			// The nonce exists only on this page: finding it proves the DOM
			// pipeline read the live document.
			assertStringIncludes(state.page, h.site.nonce);
			assertStringIncludes(state.page, 'The index page of the TykoTech-MCP fixture site.');
			// And the interactive elements really are the page's controls.
			indexOf(state, (e) => e.tag === 'button');
			indexOf(state, (e) => e.tag === 'input');
			indexOf(state, (e) => e.tag === 'a');
		});

		await t.step('browser_click by index changes the live DOM', async () => {
			const state = await h.callJson<PageState>('browser_get_state', {});
			const button = indexOf(state, (e) => e.tag === 'button');
			await h.callText('browser_click', { index: button });
			const html = await h.callText('browser_get_html', {});
			assertStringIncludes(html, `clicked-${h.site.nonce}`);
		});

		await t.step('browser_type puts characters into the real field', async () => {
			const state = await h.callJson<PageState>('browser_get_state', {});
			const field = indexOf(state, (e) => e.tag === 'input');
			await h.callText('browser_type', { index: field, text: `typed-${h.site.nonce}` });
			// The page's own `input` listener fired, so real key events arrived.
			assertStringIncludes(await h.callText('browser_get_html', {}), `typed-${h.site.nonce}</div>`);
			// And the value is visible to a model through the perception tool,
			// which reads it from the accessibility tree rather than the markup.
			const after = await h.callJson<PageState>('browser_get_state', {});
			assertStringIncludes(after.page, `typed-${h.site.nonce}`);
		});

		await t.step('browser_type with clear replaces rather than appends', async () => {
			const state = await h.callJson<PageState>('browser_get_state', {});
			const field = indexOf(state, (e) => e.tag === 'input');
			await h.callText('browser_type', { index: field, text: 'replaced', clear: true });
			const html = await h.callText('browser_get_html', {});
			assertStringIncludes(html, '>replaced</div>');
			assert(!html.includes(`typed-${h.site.nonce}`), 'clear:true left the old value behind');
		});

		await t.step('browser_get_html returns the document Chromium is showing', async () => {
			const html = await h.callText('browser_get_html', {});
			assertStringIncludes(html, '<title>TykoTech Fixture Index</title>');
			assertStringIncludes(html, h.site.nonce);
		});

		await t.step('browser_screenshot returns real PNG bytes', async () => {
			const shot = await h.call('browser_screenshot', {});
			assertEquals(shot.isError, undefined);
			const image = imageOf(shot);
			assert(image !== null, 'no image block in the result');
			assertEquals(image.mimeType, 'image/png');
			assertEquals([...image.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
			assert(image.bytes.length > 2000, `a real screenshot should have bytes, got ${image.bytes.length}`);
		});

		await t.step('browser_screenshot full_page captures more than the viewport', async () => {
			await h.callText('browser_navigate', { url: h.site.page('long') });
			const viewportShot = imageOf(await h.call('browser_screenshot', { full_page: false }));
			const fullShot = imageOf(await h.call('browser_screenshot', { full_page: true }));
			assert(viewportShot !== null && fullShot !== null);
			// A 3.2-viewport-tall page cannot encode to the same size both ways.
			assert(
				fullShot.bytes.length > viewportShot.bytes.length,
				`full_page (${fullShot.bytes.length}B) should exceed viewport (${viewportShot.bytes.length}B)`,
			);
		});

		await t.step('browser_get_state with include_screenshot returns both blocks', async () => {
			const result = await h.call('browser_get_state', { include_screenshot: true });
			assertEquals(result.isError, undefined);
			const image = imageOf(result);
			assert(image !== null, 'include_screenshot returned no image');
			assertEquals(image.mimeType, 'image/png');
			// The JSON preamble is still there, so a model gets both at once.
			const parsed = JSON.parse(textOf(result)) as PageState;
			assertEquals(parsed.session_id, 'default');
		});

		await t.step('browser_scroll moves the real viewport', async () => {
			await h.callText('browser_navigate', { url: h.site.page('long') });
			const before = await h.callJson<PageState>('browser_get_state', {});
			assertEquals(before.scroll.y, 0);

			await h.callText('browser_scroll', { direction: 'down', pages: 2 });
			const html = await h.callText('browser_get_html', {});
			// The page records its own scrollY, so this is the browser's opinion.
			const recorded = /<div id="scrolly">(\d+)<\/div>/.exec(html)?.[1] ?? '0';
			assert(Number(recorded) > 100, `page reported scrollY=${recorded} after scrolling down`);

			const after = await h.callJson<PageState>('browser_get_state', {});
			assert(after.scroll.y > 0, `state reported scroll.y=${after.scroll.y}`);
			assert(after.scroll.pixels_above > 0, 'pixels_above should be non-zero once scrolled');

			await h.callText('browser_scroll', { direction: 'up', pages: 10 });
			const back = await h.callText('browser_get_html', {});
			assertMatch(back, /<div id="scrolly">0<\/div>/);
		});

		await t.step('browser_press_key reaches the page as a real key event', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			await h.callText('browser_press_key', { key: 'Enter' });
			assertStringIncludes(await h.callText('browser_get_html', {}), '<div id="lastkey">Enter</div>');

			await h.callText('browser_press_key', { key: 'Control+a' });
			const html = await h.callText('browser_get_html', {});
			assertStringIncludes(html, '<div id="chord">Ctrl+a</div>');
		});

		await t.step('browser_type without an index goes to the focused element', async () => {
			await h.callText('browser_navigate', { url: h.site.page('keys') });
			const state = await h.callJson<PageState>('browser_get_state', {});
			// Focus it by clicking, then type with no index at all.
			await h.callText('browser_click', { index: indexOf(state, (e) => e.tag === 'input') });
			await h.callText('browser_type', { text: 'focused-typing' });
			assertStringIncludes(await h.callText('browser_get_html', {}), 'focused-typing');
		});

		await t.step('browser_click by coordinate hits the point named', async () => {
			await h.callText('browser_navigate', { url: h.site.page('mouse') });
			await h.callText('browser_click', { coordinate_x: 120, coordinate_y: 90 });
			const html = await h.callText('browser_get_html', {});
			assertStringIncludes(html, '<div id="clicks">1</div>');
			// The page recorded the coordinates it actually received.
			assertStringIncludes(html, '<div id="lastclick">120,90,b0</div>');
		});

		await t.step('browser_go_back returns to the previous document', async () => {
			await h.callText('browser_navigate', { url: h.site.page('index') });
			await h.callText('browser_navigate', { url: h.site.page('second') });
			assertStringIncludes(await h.callText('browser_get_html', {}), 'arrived-at-second');

			await h.callText('browser_go_back', {});
			const state = await h.callJson<PageState>('browser_get_state', {});
			assertEquals(state.title, 'TykoTech Fixture Index');
			assertStringIncludes(await h.callText('browser_get_html', {}), 'Press me');
		});
	},
});

Deno.test({
	name: 'e2e tools: tabs are listed, switched, and closed for real',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('tabs') });

		await t.step('browser_list_tabs sees the tab the browser really has', async () => {
			const listed = await h.callJson<{ tabs: Array<{ tab_id: string; url: string; focused: boolean }> }>(
				'browser_list_tabs',
				{},
			);
			assertEquals(listed.tabs.length, 1);
			assertEquals(listed.tabs[0]?.focused, true);
			assertStringIncludes(listed.tabs[0]?.url ?? '', '/tabs');
		});

		await t.step('a page-opened tab appears, and can be switched to and closed', async () => {
			const state = await h.callJson<PageState>('browser_get_state', {});
			// The anchor carries target=_blank, so clicking it makes Chromium open
			// a second target — a real popup, not a synthesized entry.
			await h.callText('browser_click', { index: indexOf(state, (e) => e.tag === 'a') });

			const listed = await pollTabs(h, 2);
			assertEquals(listed.length, 2, `tabs: ${JSON.stringify(listed)}`);
			const second = listed.find((tab) => tab.url.includes('/second'));
			assert(second !== undefined, `no /second tab among ${JSON.stringify(listed)}`);

			const switched = await h.callJson<{ tabs: Array<{ tab_id: string; focused: boolean }> }>(
				'browser_switch_tab',
				{ tab_id: second.tab_id },
			);
			// The switch reports the new focus itself, and a fresh listing agrees.
			assertEquals(switched.tabs.find((tab) => tab.tab_id === second.tab_id)?.focused, true);
			const afterSwitch = await h.callJson<{ tabs: Array<{ tab_id: string; focused: boolean }> }>(
				'browser_list_tabs',
				{},
			);
			assertEquals(afterSwitch.tabs.find((tab) => tab.tab_id === second.tab_id)?.focused, true);
			// And the focused document really is the other page.
			assertStringIncludes(await h.callText('browser_get_html', {}), 'arrived-at-second');

			await h.callText('browser_close_tab', { tab_id: second.tab_id });
			const remaining = await pollTabs(h, 1);
			assertEquals(remaining.length, 1);
			assert(!remaining.some((tab) => tab.tab_id === second.tab_id), 'the closed tab is still listed');
		});
	},
});

Deno.test({
	name: 'e2e tools: session lifecycle across real browsers',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_MAX_SESSIONS: '2' } });

		await t.step('the default session is created lazily on first use', async () => {
			const empty = await h.callJson<{ sessions: unknown[] }>('browser_list_sessions', {});
			assertEquals(empty.sessions.length, 0);
			await h.callText('browser_navigate', { url: h.site.page('index') });
			const listed = await h.callJson<{ sessions: Array<{ session_id: string; tab_count: number }> }>(
				'browser_list_sessions',
				{},
			);
			assertEquals(listed.sessions.length, 1);
			assertEquals(listed.sessions[0]?.session_id, 'default');
			assert((listed.sessions[0]?.tab_count ?? 0) >= 1);
		});

		let extra = '';
		await t.step('new_session launches a second, independent browser', async () => {
			const created = await h.callJson<{ session_id: string; title: string }>('browser_navigate', {
				url: h.site.page('second'),
				new_session: true,
			});
			extra = created.session_id;
			assert(extra !== 'default' && extra.length > 0, `unexpected session id ${extra}`);
			assertEquals(created.title, 'Second Page');

			// Independent: the two sessions are on different pages at the same time.
			const defaultState = await h.callJson<PageState>('browser_get_state', {});
			assertEquals(defaultState.title, 'TykoTech Fixture Index');
			const extraState = await h.callJson<PageState>('browser_get_state', { session_id: extra });
			assertEquals(extraState.title, 'Second Page');
		});

		await t.step('the session cap is enforced against real launches', async () => {
			const error = await h.callError('browser_navigate', {
				url: h.site.page('index'),
				new_session: true,
			});
			assertStringIncludes(error, 'Error: session-limit');
			assertStringIncludes(error, 'at most 2 concurrent sessions');
		});

		await t.step('browser_close_session closes exactly one browser', async () => {
			await h.callText('browser_close_session', { session_id: extra });
			const listed = await h.callJson<{ sessions: Array<{ session_id: string }> }>('browser_list_sessions', {});
			assertEquals(listed.sessions.map((s) => s.session_id), ['default']);
			// Its id is now unknown rather than silently re-created.
			assertStringIncludes(
				await h.callError('browser_get_state', { session_id: extra }),
				'Error: unknown-session',
			);
		});

		await t.step('browser_close_all closes the rest', async () => {
			const message = await h.callText('browser_close_all', {});
			assertStringIncludes(message, 'Closed 1 session');
			const listed = await h.callJson<{ sessions: unknown[] }>('browser_list_sessions', {});
			assertEquals(listed.sessions.length, 0);
		});
	},
});

Deno.test({
	name: 'e2e tools: failures are result-level errors a model can act on',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: 'example.com,127.0.0.1' } });

		await t.step('an unknown session id is refused, never silently created', async () => {
			assertStringIncludes(
				await h.callError('browser_get_state', { session_id: 'does-not-exist' }),
				'Error: unknown-session',
			);
		});

		await t.step('a blocked scheme never reaches the browser', async () => {
			const error = await h.callError('browser_navigate', { url: 'file:///etc/passwd' });
			assertStringIncludes(error, 'Error: navigation-blocked');
			assertStringIncludes(error, 'unsupported scheme: file:');
		});

		await t.step('a host outside the allowlist is refused', async () => {
			const error = await h.callError('browser_navigate', { url: 'https://evil-example.com/' });
			assertStringIncludes(error, 'Error: navigation-blocked');
			assertStringIncludes(error, 'not in the server');
		});

		await t.step('an allowed host still works', async () => {
			// 127.0.0.1 is on the allowlist above, so the fixture site loads.
			const result = await h.callJson<{ title: string }>('browser_navigate', { url: h.site.page('index') });
			assertEquals(result.title, 'TykoTech Fixture Index');
		});

		await t.step('a stale element index reports which tool refreshes it', async () => {
			// After a navigation and before any successful DOM read this session holds no index table
			// at all, which E-36 now says out loud instead of answering `unknown-index`. Read the
			// state first, so the code under test here is genuinely "this table has no such index".
			await h.callJson<PageState>('browser_get_state', {});
			const error = await h.callError('browser_click', { index: 9999 });
			assertStringIncludes(error, 'Error: unknown-index');
			assertStringIncludes(error, 'browser_get_state');
		});

		await t.step('G-1: a fresh navigation leaves no table, and says so (E-36)', async () => {
			await h.callJson<{ url: string }>('browser_navigate', { url: h.site.page('index') });
			const error = await h.callError('browser_click', { index: 1 });
			// The distinction the new code exists for: the model is told to read the page, not that
			// index 1 is missing from a page it never read.
			assertStringIncludes(error, 'Error: element-not-found');
			assertStringIncludes(error, 'browser_get_state');
		});

		await t.step('G-1: an index survives the secret-substitution URL read (E-36)', async () => {
			// Red-to-green over the real dispatch path. `browser_type` with a `<secret>` placeholder
			// issues a DOM-less state read to decide which secrets this origin permits; before E-36
			// that read wrote its empty selectorMap over the cache, so this call failed with
			// `unknown-index` even though the index had just been read from a good state.
			const state = await h.callJson<PageState>('browser_get_state', {});
			const field = indexOf(state, (e) => e.tag === 'input');
			const result = await h.call('browser_type', { index: field, text: 'plain-<secret>absent</secret>' });
			const text = (result.content as Array<{ type: string; text?: string }>)
				.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(' ');
			assert(!text.includes('unknown-index'), `the index was lost to the secret URL read: ${text}`);
			assert(!text.includes('element-not-found'), text);
		});

		await t.step('B1.4: browser_get_state publishes a state_token, and a stale one is refused', async () => {
			const first = await h.call('browser_get_state', {});
			const token = (first.structuredContent as { state_token?: string | null }).state_token;
			assert(typeof token === 'string' && token.includes('.'), `no state_token on the wire: ${token}`);

			// I-4: the token reaches the structured half only. A 0.1.0 client parsing the text block
			// sees exactly the JSON it saw before.
			const textPayload = JSON.parse(
				(first.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}',
			) as Record<string, unknown>;
			assert(!('state_token' in textPayload), 'state_token leaked into the frozen text block (I-4)');

			const state = await h.callJson<PageState>('browser_get_state', {});
			const field = indexOf(state, (e) => e.tag === 'input');
			// A token the server cannot be holding: the call is refused rather than resolved.
			const error = await h.callError('browser_click', {
				index: field,
				state_token: '0000000000000000.0000000000000000',
			});
			assertStringIncludes(error, 'Error: element-not-found');
		});

		await t.step('an unknown tab id is refused', async () => {
			assertStringIncludes(
				await h.callError('browser_switch_tab', { tab_id: 'NOT-A-TARGET' }),
				'Error: unknown-tab',
			);
			assertStringIncludes(
				await h.callError('browser_close_tab', { tab_id: 'NOT-A-TARGET' }),
				'Error: unknown-tab',
			);
		});

		await t.step('closing an unknown session is an error, not a silent success', async () => {
			assertStringIncludes(
				await h.callError('browser_close_session', { session_id: 'nope' }),
				'Error: unknown-session',
			);
		});

		await t.step('schema violations arrive as validation errors, not crashes', async () => {
			// `browser_click` refines to "index XOR both coordinates".
			const both = await h.call('browser_click', { index: 1, coordinate_x: 5, coordinate_y: 5 });
			assertEquals(both.isError, true);
			const neither = await h.call('browser_click', {});
			assertEquals(neither.isError, true);
			// A bad URL fails the schema before the policy ever sees it.
			const badUrl = await h.call('browser_navigate', { url: 'not a url' });
			assertEquals(badUrl.isError, true);
		});
	},
});

Deno.test({
	name: 'e2e tools: the advertised catalog matches what a principal may call',
	ignore,
	async fn(t) {
		await using h = await harness({ scopes: ['mcp:invoke', 'view:watch'] });

		await t.step('a non-admin principal is not offered browser_close_all', async () => {
			const listed = await h.client.listTools({});
			const names = listed.tools.map((tool) => tool.name);
			assert(!names.includes('browser_close_all'), 'close_all leaked into a non-admin catalog');
			// Every other catalog entry the deployment can serve is present: a
			// filtered list, not a broken one. Tools carrying an availability
			// predicate are absent for a different reason — this harness configures
			// neither a data directory nor an encoder — which R5 owns.
			for (const tool of CATALOG) {
				if (tool.scope !== undefined || tool.available !== undefined) continue;
				assert(names.includes(tool.name), `${tool.name} missing from tools/list`);
			}
		});

		await t.step('and calling it answers scope-required, naming no scope', async () => {
			// Since the D-A2 seam this is an error *result* carrying a code, not a
			// JSON-RPC error. It used to read `Tool ... not found`, which is
			// textually indistinguishable from a tool this build does not have — so
			// a client that treated "not found" as "this server lacks the feature"
			// degraded itself permanently.
			const refused = await h.client.callTool({ name: 'browser_close_all', arguments: {} }) as {
				isError?: boolean;
				content?: Array<{ text?: string }>;
				structuredContent?: { error?: { code?: string } };
			};
			assertEquals(refused.isError, true, 'browser_close_all succeeded without the admin scope');
			assertStringIncludes(refused.content?.[0]?.text ?? '', 'Error: scope-required: ');
			assertEquals(refused.structuredContent?.error?.code, 'scope-required');
			// SEC-17: the code says a grant is missing; it never says which one.
			assert(!JSON.stringify(refused).includes('"admin"'), 'the refusal named the scope');
		});

		await t.step('every listed tool advertises annotations matching its class', async () => {
			const listed = await h.client.listTools({});
			for (const tool of listed.tools) {
				const definition = CATALOG.find((entry) => entry.name === tool.name);
				assert(definition !== undefined, `tools/list offered an unknown tool ${tool.name}`);
				if (definition.mutates) {
					assertEquals(tool.annotations?.readOnlyHint, undefined, `${tool.name} is mutating`);
				} else {
					assertEquals(tool.annotations?.readOnlyHint, true, `${tool.name} is read-only`);
				}
			}
		});
	},
});

/** Polls `browser_list_tabs` until the count settles; popups appear asynchronously. */
async function pollTabs(
	h: { callJson<T>(name: string, args?: Record<string, unknown>): Promise<T> },
	expected: number,
): Promise<Array<{ tab_id: string; url: string; focused: boolean }>> {
	const deadline = Date.now() + 15_000;
	let last: Array<{ tab_id: string; url: string; focused: boolean }> = [];
	while (Date.now() < deadline) {
		last = (await h.callJson<{ tabs: Array<{ tab_id: string; url: string; focused: boolean }> }>(
			'browser_list_tabs',
			{},
		)).tabs;
		if (last.length === expected) return last;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return last;
}

// --- B1.5: the element record against a real page ---------------------------------------------------

interface RichState extends PageState {
	state_token: string | null;
	focused_index: number | null;
	elements_total: number;
	elements_truncated: boolean;
	frames: Array<{
		id: string;
		name: string;
		url: string;
		parent: string | null;
		bounds: { x: number; y: number; w: number; h: number } | null;
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
		bounds?: { x: number; y: number; w: number; h: number } | null;
		visible?: boolean;
		focused?: boolean;
		frame_id?: string;
		input?: { type: string; name: string; value: string | null; checked: boolean | null };
		attrs?: Record<string, string>;
		locator?: { kind: string; value: string; unique: boolean } | null;
	}>;
}

Deno.test({
	name: 'e2e tools: the element record — live values, focus, geometry, and a click through an OOPIF (B1.5)',
	ignore,
	async fn(t) {
		// A second fixture site on `localhost`: a different *site* to Chromium, so the frame it serves
		// renders out of process and its geometry is a real composition across a renderer boundary.
		const { startFixtureSite } = await import('../fixtures/site.ts');
		const second = startFixtureSite({ hostname: 'localhost' });
		try {
			await using h = await harness({ site: { frameOrigin: second.url.replace(/\/$/, '') } });
			const rich = (args: Record<string, unknown>) =>
				h.call('browser_get_state', args).then((r) => r.structuredContent as unknown as RichState);

			await t.step('input.value is the live property, and the typed field is the one focused element', async () => {
				await h.callText('browser_navigate', { url: h.site.page('form') });
				const before = await h.callJson<PageState>('browser_get_state', {});
				const name = indexOf(before, (e) => e.tag === 'input' && e.label === 'your name');
				await h.callText('browser_type', { index: name, text: 'Ada' });

				const state = await rich({ fields: ['full'] });
				const field = state.interactive_elements.find((e) => e.index === name);
				assert(field !== undefined);
				assertEquals(field.input?.value, 'Ada', 'the live value, which no markup attribute carries');
				assertEquals(field.input?.name, 'name');
				assertEquals(field.attrs?.id, 'name');
				assert(field.bounds !== null && field.bounds !== undefined && field.bounds.w > 0);
				assertEquals(field.frame_id, state.frames[0]?.id, 'the top document is the join key');
				// I-15, the positive case the recorded corpus cannot provide: exactly one focused element.
				const focused = state.interactive_elements.filter((e) => e.focused === true);
				assertEquals(focused.length, 1);
				assertEquals(state.focused_index, name);
				// And the checkbox reports a real checked state rather than a null.
				const agree = state.interactive_elements.find((e) => e.attrs?.id === 'agree');
				assertEquals(agree?.input?.checked, false);
			});

			await t.step('an autofocused field is focused on first read', async () => {
				await h.callText('browser_navigate', { url: h.site.page('keys') });
				const state = await rich({});
				const target = state.interactive_elements.find((e) => e.label === 'focus me');
				assert(target !== undefined);
				assertEquals(state.focused_index, target.index);
				assertEquals(target.focused, true);
			});

			await t.step(
				'A-1 live leg: a click at the published bounds of an OOPIF button lands in the child frame',
				async () => {
					await h.callText('browser_navigate', { url: h.site.page('oopif') });
					const state = await rich({ fields: ['full'] });
					assertEquals(state.frames.length, 2, JSON.stringify(state.frames));
					const child = state.frames[1]!;
					assertEquals(child.parent, state.frames[0]!.id);
					assertEquals(child.is_oopif, true, 'a localhost frame inside a 127.0.0.1 page is its own renderer');
					assertEquals(child.captured, true);
					assertEquals(child.bounds_composed, true);
					assertEquals(child.name, 'child');
					assertStringIncludes(child.url, 'localhost');
					assertEquals(state.capture_truncated, false);

					const button = state.interactive_elements.find((e) => e.tag === 'button' && e.frame_id === child.id);
					assert(button !== undefined && button.bounds !== null && button.bounds !== undefined, 'the frame button');
					assertEquals(button.label, 'Frame button');
					// The composed number is inside the host box, below its 1 px border.
					assert(child.bounds !== null);
					assert(button.bounds.x > child.bounds.x && button.bounds.y > child.bounds.y);

					// `bounds` is top-document viewport CSS px, which is the coordinate space `browser_click`
					// takes. The page is at scroll 0, so no subtraction.
					const x = button.bounds.x + button.bounds.w / 2 - state.scroll.x;
					const y = button.bounds.y + button.bounds.h / 2 - state.scroll.y;
					await h.callText('browser_click', { coordinate_x: x, coordinate_y: y });
					const after = await h.callJson<PageState>('browser_get_state', {});
					// The frame is served by the SECOND site, so it carries that site's nonce.
					const hit = new RegExp(`clicked-in-frame-${second.nonce}-at-(\\d+),(\\d+)`).exec(after.page);
					assert(hit !== null, `the child frame's own handler did not fire: ${after.page.slice(0, 400)}`);
					// The child reports the click in ITS OWN client space: the top-document point minus the
					// frame's content box origin (host box plus border). Within a pixel of the arithmetic.
					const localX = Number(hit[1]);
					const localY = Number(hit[2]);
					assert(Math.abs(localX - (x - (child.bounds.x + 1))) <= 1.5, `x ${localX} vs ${x - (child.bounds.x + 1)}`);
					assert(Math.abs(localY - (y - (child.bounds.y + 1))) <= 1.5, `y ${localY} vs ${y - (child.bounds.y + 1)}`);
				},
			);

			await t.step('frames: top only, and an unknown id is reported rather than refused', async () => {
				const top = await rich({ frames: 'top' });
				assertEquals(top.frames.length, 2, 'the frame list is always the whole page');
				assert(top.interactive_elements.every((e) => e.frame_id === top.frames[0]!.id));
				const named = await rich({ frames: ['nope'] });
				assertEquals(named.frames_unknown, ['nope']);
			});

			await t.step('a bad fields member is invalid-arguments naming it, never silently dropped', async () => {
				const error = await h.callError('browser_get_state', { fields: ['bounds', 'colour'] });
				assertStringIncludes(error, 'Error: invalid-arguments');
				// The refusal names the offending member by position and lists the vocabulary, which is
				// what the D-A2 seam gets from the `z.enum` for free.
				assertStringIncludes(error, 'fields.1');
				assertStringIncludes(error, 'Invalid option');
			});
		} finally {
			await second.close();
		}
	},
});

// --- B1.6: find, frames and the locator tools against a real page -------------------------------

Deno.test({
	name: 'e2e tools: browser_find, browser_get_frames and the locator tools (B1.6)',
	ignore,
	async fn(t) {
		const { startFixtureSite } = await import('../fixtures/site.ts');
		const second = startFixtureSite({ hostname: 'localhost' });
		try {
			await using h = await harness({ site: { frameOrigin: second.url.replace(/\/$/, '') } });
			await h.callText('browser_navigate', { url: h.site.page('index') });

			await t.step('browser_find returns the same link by role+name, by href_pattern and by near', async () => {
				type Find = {
					matches: Array<{ index: number; score: number; bounds?: { x: number; y: number; w: number; h: number } }>;
					total: number;
					unique: boolean;
					truncated: boolean;
					state_token: string;
				};
				const byName = await h.callJson<Find>('browser_find', { query: { role: 'link', name: 'go to second' } });
				assertEquals(byName.total, 1);
				assertEquals(byName.unique, true);
				assertEquals(byName.matches[0]!.score, 1);
				const link = byName.matches[0]!;
				assert(link.bounds !== undefined && link.bounds !== null);

				const byHref = await h.callJson<Find>('browser_find', { query: { href_pattern: '^/second$' } });
				assertEquals(byHref.matches[0]!.index, link.index);

				const byNear = await h.callJson<Find>('browser_find', {
					query: { near: { x: link.bounds.x + link.bounds.w / 2, y: link.bounds.y + link.bounds.h / 2 } },
					limit: 1,
				});
				assertEquals(byNear.matches[0]!.index, link.index);
				assertEquals(byNear.matches[0]!.score, 1);
				assertEquals(byNear.truncated, true, 'more than one element on the page, limit 1');

				// A CSS query is the browser's to evaluate.
				const byCss = await h.callJson<Find>('browser_find', { query: { css: '#to-second' } });
				assertEquals(byCss.matches.map((m) => m.index), [link.index]);
				assert(typeof byName.state_token === 'string' && byName.state_token.includes('.'));
			});

			await t.step('browser_locator_candidates and browser_verify_locator agree on the page as it is', async () => {
				const state = await h.callJson<PageState>('browser_get_state', {});
				const link = indexOf(state, (e) => e.tag === 'a');
				const candidates = await h.callJson<{
					locators: Array<{ kind: string; value: string; unique: boolean; matches: number }>;
					best: { kind: string; value: string } | null;
				}>('browser_locator_candidates', { index: link });
				assertEquals(candidates.locators.map((c) => c.kind), ['id', 'aria', 'text']);
				assertEquals(candidates.best?.value, '#to-second');

				const verified = await h.callJson<
					{ matches: number; unique: boolean; first: { index: number } | null; frame_id: string }
				>(
					'browser_verify_locator',
					{ locator: { kind: 'id', value: '#to-second' } },
				);
				assertEquals(verified.unique, true, 'the browser agrees the id is unique');
				assertEquals(verified.first?.index, link);

				const aria = await h.callJson<{ matches: number; first: { index: number } | null }>(
					'browser_verify_locator',
					{ locator: { kind: 'aria', value: 'role=link[name="go to second"]' } },
				);
				assertEquals(aria.matches, 1);
				assertEquals(aria.first?.index, link);

				const nothing = await h.callJson<{ matches: number; first: unknown }>(
					'browser_verify_locator',
					{ locator: { kind: 'css', value: '#no-such-element-anywhere' } },
				);
				assertEquals(nothing.matches, 0, 'names nothing today: a success, not an error');
				assertEquals(nothing.first, null);
			});

			await t.step('browser_get_frames lists the OOPIF with its own URL and the composition marker', async () => {
				await h.callText('browser_navigate', { url: h.site.page('oopif') });
				const frames = await h.callJson<{
					frames: Array<
						{
							id: string;
							name: string;
							url: string;
							parent: string | null;
							is_oopif: boolean;
							bounds_composed: boolean;
							captured: boolean;
						}
					>;
					capture_truncated: boolean;
				}>('browser_get_frames', {});
				assertEquals(frames.frames.length, 2);
				assertEquals(frames.frames[1]!.name, 'child');
				assertEquals(frames.frames[1]!.is_oopif, true);
				assertEquals(frames.frames[1]!.captured, true);
				assertEquals(frames.frames[1]!.bounds_composed, true);
				assertStringIncludes(frames.frames[1]!.url, 'localhost');
				assertEquals(frames.capture_truncated, false);

				// A search scoped to the child frame runs in the child's own session.
				const inChild = await h.callJson<{ matches: number; first: { index: number; label?: string } | null }>(
					'browser_verify_locator',
					{ locator: { kind: 'id', value: '#frame-btn' }, frame_id: frames.frames[1]!.id },
				);
				assertEquals(inChild.matches, 1);
				assertEquals(inChild.first?.label, 'Frame button');
			});
		} finally {
			await second.close();
		}
	},
});
