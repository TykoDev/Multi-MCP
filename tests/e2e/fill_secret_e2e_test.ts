/**
 * `browser_fill_secret` on real Chromium. The unit tier proves each refusal against a scripted frame tree; this file
 * adds what only a renderer can show: a genuinely out-of-process frame, a genuinely scaled visual viewport, and a
 * page that navigates itself to a `blob:`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { type Harness, harness, pageCdp, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('fill_secret e2e');

const BANK_SECRET = 'Zq8-E2E-BANK-SECRET-3vP';
const ALT_SECRET = 'Zq8-E2E-ALT-SECRET-3vP';
const HTTPS_ONLY_SECRET = 'Zq8-E2E-HTTPS-ONLY-SECRET-3vP';
/**
 * One secret pinned to the plaintext fixture host with an explicit `http://`, one unpinned, and one pinned to the same
 * host scheme-less, which pins https only: the two pins differ by nothing but the scheme.
 */
const SECRETS = JSON.stringify({
	site_password: { value: BANK_SECRET, domains: ['http://127.0.0.1'] },
	unpinned_password: ALT_SECRET,
	https_only_password: { value: HTTPS_ONLY_SECRET, domains: ['127.0.0.1'] },
});

interface Element {
	index: number;
	tag: string;
	attrs?: Record<string, string>;
	frame_id?: string;
}
interface State {
	state_token: string | null;
	interactive_elements: Element[];
	page: string;
	frames: Array<{ id: string; is_oopif: boolean; url: string }>;
	/** Omitted when no configured secret is usable here. */
	available_secrets?: string[];
	url?: string;
}
interface AuditRead {
	entries: Array<Record<string, unknown>>;
	scope: string;
}

// The structured half: the text block is the frozen projection, without `attrs` or `frames`.
const state = (h: Harness) => h.callStructured<State>('browser_get_state', { fields: ['core', 'attrs'] });
const audit = (h: Harness) => h.callStructured<AuditRead>('browser_audit', {});

function byId(read: State, id: string): Element {
	const found = read.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(read.interactive_elements)}`);
	return found;
}

const fill = (h: Harness, read: State, id: string, secret: string, token = read.state_token) =>
	h.call('browser_fill_secret', { index: byId(read, id).index, secret, state_token: token });

/** The refusal text of a fill, which must carry no secret value. */
async function refusedFill(h: Harness, read: State, id: string, secret: string, token?: string): Promise<string> {
	const result = await fill(h, read, id, secret, token);
	assertEquals(result.isError, true, `the fill was not refused: ${JSON.stringify(result.content)}`);
	const text = JSON.stringify(result.content);
	for (const value of [BANK_SECRET, ALT_SECRET, HTTPS_ONLY_SECRET]) assert(!text.includes(value), text);
	return text;
}

/**
 * Sets the page scale factor through CDP and measures that it moved. `Emulation.setPageScaleFactor` is the quantity
 * the guard reads (`setDeviceMetricsOverride`'s `scale` only scales the view image); the product never sends it.
 */
async function setPageScale(h: Harness, scale: number): Promise<void> {
	const { cdp, page } = await pageCdp(h.gateway);
	await cdp.sendRaw('Emulation.setPageScaleFactor', { pageScaleFactor: scale }, page);
	const metrics = await cdp.sendRaw('Page.getLayoutMetrics', {}, page) as {
		visualViewport: { scale: number };
		cssVisualViewport?: { scale: number };
	};
	assertEquals(metrics.cssVisualViewport?.scale ?? metrics.visualViewport.scale, scale, 'the probe set the condition');
}

Deno.test({
	name: 'e2e fill_secret: the credential lands, and every refusal fires',
	ignore,
	async fn(t) {
		await t.step('a pinned secret fills a real password field, and nothing carries the value', async () => {
			await using h = await harness({ env: { TTK_SECRETS: SECRETS } });
			await h.callText('browser_navigate', { url: h.site.page('form') });
			const result = await fill(h, await state(h), 'password', 'site_password');
			assertEquals(result.isError, undefined, `fill refused: ${JSON.stringify(result.content)}`);
			const filled = result.structuredContent as { secret: string; origin: string; audit_id: string };
			assertEquals([filled.secret, filled.origin], ['site_password', new URL(h.site.url).origin]);
			// The fixture reports the field's length, so proving the fill needs no credential in the page text.
			assertStringIncludes((await state(h)).page, `pwlen:${BANK_SECRET.length}`);
			const ledger = await audit(h);
			const everything = JSON.stringify(result) + JSON.stringify(ledger);
			assert(!everything.includes(BANK_SECRET.slice(0, 8)), `a prefix leaked: ${everything}`);
			assertEquals(ledger.scope, 'all', 'the harness credential holds admin');
			assertEquals(ledger.entries.length, 1);
			assertEquals(
				[ledger.entries[0]?.kind, ledger.entries[0]?.secret, ledger.entries[0]?.audit_id],
				['secret-fill', 'site_password', filled.audit_id],
			);
			for (const [key, value] of Object.entries(ledger.entries[0] ?? {})) {
				assert(value !== BANK_SECRET.length || key === 'index', `${key} carries the secret's length`);
			}
		});

		await t.step(
			'unpinned, https-only on plaintext, stale and non-fillable targets are refused; nothing typed',
			async () => {
				await using h = await harness({ env: { TTK_SECRETS: SECRETS } });
				await h.callText('browser_navigate', { url: h.site.page('form') });
				const read = await state(h);
				// A scheme-less pin must not follow a downgrade onto plaintext: neither advertised nor filled here.
				assert(!(read.available_secrets ?? []).includes('https_only_password'), JSON.stringify(read.available_secrets));
				assert((read.available_secrets ?? []).includes('site_password'), 'the explicit-http pin is still offered');
				assertStringIncludes(
					await refusedFill(h, read, 'password', 'https_only_password'),
					'Error: navigation-blocked: ',
				);
				assertStringIncludes(
					await refusedFill(h, read, 'password', 'unpinned_password'),
					'Error: navigation-blocked: ',
				);
				assertStringIncludes(
					await refusedFill(h, read, 'password', 'site_password', 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb'),
					'Error: element-not-found: ',
				);
				for (const id of ['submit', 'email']) {
					assertStringIncludes(await refusedFill(h, read, id, 'site_password'), 'Error: element-not-interactable: ');
				}
				assertStringIncludes((await state(h)).page, 'pwlen:0');
				assertEquals((await audit(h)).entries.length, 0, 'a refusal writes no audit entry');
			},
		);

		await t.step('a password field in a genuinely out-of-process frame is refused', async () => {
			const alt = Deno.serve({ hostname: 'localhost', port: 0, onListen: () => {} }, () =>
				new Response(
					'<!doctype html><meta charset="utf-8"><title>alt frame</title>' +
						'<input id="alt-password" name="password" type="password" placeholder="password">',
					{ headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
				));
			try {
				await using h = await harness({
					env: { TTK_SECRETS: SECRETS },
					site: { frameOrigin: `http://localhost:${alt.addr.port}` },
				});
				await h.callText('browser_navigate', { url: h.site.page('oopif') });
				const read = await state(h);
				const oopif = read.frames.find((frame) => frame.is_oopif);
				assert(oopif !== undefined, `no out-of-process frame captured: ${JSON.stringify(read.frames)}`);
				assertEquals(byId(read, 'alt-password').frame_id, oopif.id);
				assertStringIncludes(
					await refusedFill(h, read, 'alt-password', 'site_password'),
					'Error: navigation-blocked: ',
				);
				assertEquals((await audit(h)).entries.length, 0);
			} finally {
				await alt.shutdown();
			}
		});

		await t.step(
			'both secret-bearing paths refuse under a scaled visual viewport; ordinary typing does not',
			async () => {
				await using h = await harness({ env: { TTK_SECRETS: SECRETS } });
				await h.callText('browser_navigate', { url: h.site.page('form') });
				const read = await state(h);
				await setPageScale(h, 2);
				const filled = await refusedFill(h, read, 'password', 'site_password');
				assertStringIncludes(filled, 'Error: browser-unavailable: ');
				assertStringIncludes(filled, 'scaled');
				const index = byId(read, 'password').index;
				assertStringIncludes(
					await h.callError('browser_type', { index, text: '<secret>site_password</secret>' }),
					'Error: browser-unavailable: ',
				);
				assertEquals((await h.call('browser_type', { index, text: 'ordinary' })).isError, undefined);
				// Back at scale 1 the same fill goes through: the refusal was the scale.
				await setPageScale(h, 1);
				const ok = await fill(h, await state(h), 'password', 'site_password');
				assertEquals(ok.isError, undefined, JSON.stringify(ok.content));
			},
		);

		await t.step('a non-admin principal reads only its own ledger entries, over the wire', async () => {
			// Sessions are shared among `mcp:invoke` holders: an unfiltered read would map the others' credential use.
			await using h = await harness({ scopes: ['mcp:invoke'], env: { TTK_SECRETS: SECRETS } });
			await h.callText('browser_navigate', { url: h.site.page('form') });
			await fill(h, await state(h), 'password', 'site_password');
			const record = h.gateway.registry.peek('default')!;
			record.audit.append({
				session_id: 'default',
				principal: 'another-worker',
				kind: 'secret-fill',
				frame_id: 'F',
				origin: 'https://elsewhere.example',
				secret: 'someone_elses_credential',
				ok: true,
			});
			const own = await audit(h);
			assertEquals([own.scope, own.entries.length], ['own', 1]);
			assert(!JSON.stringify(own.entries).includes('someone_elses_credential'));
			assertEquals(
				record.audit.read({ principal: 'x', all: true }).entries.length,
				2,
				'the filter, not an empty ledger',
			);
		});
	},
});

/**
 * A page that moves itself to a same-origin top-level `blob:` (permitted, no gesture) is not the pinned origin: the
 * credential is no longer advertised, and is not filled. `evaluate` stands in for any hostile page script.
 */
Deno.test({
	name: 'e2e fill_secret (blob: navigation): a page that navigates itself to a blob: is not the pinned origin',
	ignore,
	async fn() {
		await using h = await harness({ scopes: ['mcp:invoke', 'admin', 'evaluate'], env: { TTK_SECRETS: SECRETS } });
		await h.callText('browser_navigate', { url: h.site.page('form') });
		assert(
			((await state(h)).available_secrets ?? []).includes('site_password'),
			'the pin binds on the fixture host first, or an empty list later proves nothing',
		);
		const moved = await h.call('browser_evaluate', {
			expression: "(() => { const html = '<!doctype html><title>attacker</title><form>" +
				'<input id="p" type="password" name="p"></form>\';' +
				" const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));" +
				' setTimeout(() => { location.href = url; }, 0); return url.slice(0, 5); })()',
		});
		assertEquals(moved.isError, undefined, JSON.stringify(moved.content));
		// Wait for the move to commit and parse; an empty element table must not pass for a refusal.
		let read = await state(h);
		for (let attempt = 0; attempt < 40 && !(read.url ?? '').startsWith('blob:'); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			read = await state(h);
		}
		assert((read.url ?? '').startsWith('blob:'), `the page never reached a blob: URL: ${read.url}`);
		for (let attempt = 0; attempt < 8 && read.interactive_elements.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			read = await state(h);
		}
		assert(!(read.available_secrets ?? []).includes('site_password'), 'the credential is offered on a blob: document');
		// Measured: such a document publishes no element table, so no index reaches the fill; if one ever does, the
		// fill must still refuse.
		if (read.interactive_elements.some((element) => element.attrs?.id === 'p')) {
			assertStringIncludes(await refusedFill(h, read, 'p', 'site_password'), 'Error: navigation-blocked: ');
		}
		assertEquals((await audit(h)).entries.filter((entry) => entry.kind === 'secret-fill'), []);
	},
});
