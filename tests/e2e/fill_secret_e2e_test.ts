/**
 * B2.8 / SEC-07 / SEC-08 / SEC-24 — `browser_fill_secret` on real Chromium.
 *
 * Every refusal here is a deny path, and the unit tier proves each of them against a scripted frame
 * tree. This file exists because two of them cannot be proven anywhere else: **a genuinely
 * out-of-process frame** — the page can only be built by a second origin and a real renderer — and
 * **a genuinely scaled visual viewport**, which needs `Emulation.setDeviceMetricsOverride`'s page
 * `scale` and a browser to apply it. The tool itself never sends `scale` (invariant I-16); this test
 * does, from outside the product, which is exactly the configuration I-16 exists to keep the product
 * out of.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('fill_secret e2e');

const BANK_SECRET = 'Zq8-E2E-BANK-SECRET-3vP';
const ALT_SECRET = 'Zq8-E2E-ALT-SECRET-3vP';

/**
 * The secrets the server holds: one pinned to the fixture host, one deliberately unpinned, and one
 * pinned to the same host by a **scheme-less** pattern.
 *
 * `site_password` carries an explicit `http://` because the fixture site is plaintext and SEC-FH-23
 * made the pin https-only for a scheme-less pattern — the escape hatch of SECURITY-AUTH.md §4.1 M4,
 * which is how an operator says "yes, over plaintext" out loud. `https_only_password` is the same
 * host written the ordinary way, and it exists so this suite proves the downgrade is refused on the
 * real browser, not only against a scripted frame tree: the two differ by nothing but the scheme.
 */
const HTTPS_ONLY_SECRET = 'Zq8-E2E-HTTPS-ONLY-SECRET-3vP';
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
	/** Omitted entirely when no configured secret is usable here, which is itself the assertion. */
	available_secrets?: string[];
	url?: string;
}
interface Filled {
	session_id: string;
	index: number;
	secret: string;
	frame_id: string;
	origin: string;
	state_token: string | null;
	audit_id: string;
}
interface AuditRead {
	session_id: string;
	entries: Array<Record<string, unknown>>;
	dropped: number;
	scope: string;
}

/**
 * The structured half of a result, where every field added since 0.1.0 lives (I-4).
 *
 * `callJson` parses the **text block**, which is the frozen 0.1.0 projection and carries only the
 * minimal element record — no `attrs`, no `frames`. Reading the state through it is how this suite
 * first failed, which is worth a sentence: the two halves differ on purpose (D-3).
 */
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

function byId(state: State, id: string): Element {
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(state.interactive_elements)}`);
	return found;
}

/** A second origin serving one page with a password field, so a real OOPIF can be built. */
function altOriginServer(): { origin: string; close(): Promise<void> } {
	const server = Deno.serve({ hostname: 'localhost', port: 0, onListen: () => {} }, () =>
		new Response(
			'<!doctype html><meta charset="utf-8"><title>alt frame</title>' +
				'<input id="alt-password" name="password" type="password" placeholder="password">' +
				'<div id="alt-marker">alt-frame</div>',
			{ headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
		));
	return {
		origin: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
		close: () => server.shutdown(),
	};
}

/**
 * Sets the page scale factor directly through CDP, and MEASURES that it moved.
 *
 * Two commands were tried and only one works, which is worth recording rather than discovering
 * twice. `Emulation.setDeviceMetricsOverride`'s `scale` is a scale applied to the resulting *view
 * image*: it changes what a screenshot looks like and leaves `Page.getLayoutMetrics`'s visual
 * viewport reporting `scale: 1`, so the guard did not fire and the fill succeeded — measured, first
 * pass. `Emulation.setPageScaleFactor` is the page scale factor itself, which is the quantity SEC-24
 * is about and the one `getLayoutMetrics` reports. It is outside the typed D-CDP2 surface, so the
 * test reaches it through `sendRaw`; the product never sends either (invariant I-16), and this test
 * creating the condition from outside is exactly what I-16 keeps the product out of.
 *
 * The read-back is an assertion, not a log line: a probe that could not create the condition would
 * otherwise "prove" the guard by never triggering it.
 */
async function setPageScale(h: { gateway: { registry: { peek(id: string): unknown } } }, scale: number): Promise<void> {
	const record = h.gateway.registry.peek('default') as {
		session: {
			cdpClient: {
				sendRaw(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
				send: {
					Page: {
						getLayoutMetrics(params: unknown, sessionId: string): Promise<{
							visualViewport: { scale: number };
							cssVisualViewport?: { scale: number };
						}>;
					};
				};
			} | null;
			sessionManager: { getOrCreateCdpSession(t: unknown, f: boolean): Promise<{ sessionId: string }> } | null;
			agentFocusTargetId: string | null;
		};
	} | undefined;
	assert(record !== undefined && record.session.cdpClient !== null && record.session.sessionManager !== null);
	const cdp = await record.session.sessionManager.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
	await record.session.cdpClient.sendRaw('Emulation.setPageScaleFactor', { pageScaleFactor: scale }, cdp.sessionId);
	const metrics = await record.session.cdpClient.send.Page.getLayoutMetrics({}, cdp.sessionId);
	const observed = metrics.cssVisualViewport?.scale ?? metrics.visualViewport.scale;
	console.log(
		`[B2.8/SEC-24] Emulation.setPageScaleFactor(${scale}) -> getLayoutMetrics visualViewport.scale=` +
			`${metrics.visualViewport.scale} cssVisualViewport.scale=${metrics.cssVisualViewport?.scale}`,
	);
	assertEquals(observed, scale, 'the probe must actually create the condition the guard is asserted against');
}

Deno.test({
	name: 'e2e fill_secret (SEC-07, SEC-08, SEC-24): the credential lands, and every refusal fires',
	ignore,
	async fn(t) {
		await t.step('a pinned secret fills a real password field, and nothing carries the value', async () => {
			await using h = await harness({ env: { TTK_SECRETS: SECRETS } });
			await h.callText('browser_navigate', { url: h.site.page('form') });
			const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			const field = byId(state, 'password');
			assert(state.state_token !== null);

			const result = await h.call('browser_fill_secret', {
				index: field.index,
				secret: 'site_password',
				state_token: state.state_token,
			});
			assertEquals(result.isError, undefined, `fill refused: ${JSON.stringify(result.content)}`);
			const filled = result.structuredContent as Filled;
			console.log(`[B2.8] fill result: ${JSON.stringify(filled)}`);
			assertEquals(filled.secret, 'site_password');
			assertEquals(filled.origin, new URL(h.site.url).origin);

			// The page saw the whole value: the fixture reports its LENGTH, deliberately, so proving the
			// fill landed does not require putting a credential into the page's own text.
			const after = await structured<State>(h, 'browser_get_state', {});
			assertStringIncludes(after.page, `pwlen:${BANK_SECRET.length}`);

			// And the value is in none of the places a caller or an operator reads.
			const audit = await structured<AuditRead>(h, 'browser_audit', {});
			const everything = JSON.stringify(result) + JSON.stringify(audit);
			assert(!everything.includes(BANK_SECRET), everything);
			assert(!everything.includes(BANK_SECRET.slice(0, 8)), `a prefix leaked: ${everything}`);
			console.log(`[B2.8] audit after one fill: ${JSON.stringify(audit)}`);
			assertEquals(audit.entries.length, 1);
			assertEquals(audit.entries[0]?.kind, 'secret-fill');
			assertEquals(audit.entries[0]?.secret, 'site_password');
			assertEquals(audit.entries[0]?.audit_id, filled.audit_id);
			assertEquals(audit.scope, 'all', 'the harness credential holds admin');
			// A length-shaped field, checked structurally: a two-digit number occurs by chance in an id.
			for (const [key, value] of Object.entries(audit.entries[0] ?? {})) {
				assert(
					typeof value !== 'number' || value !== BANK_SECRET.length || key === 'index',
					`${key} carries the secret's length`,
				);
			}
		});

		await t.step('an unpinned secret, a stale token and a non-fillable element are each refused', async () => {
			await using h = await harness({ env: { TTK_SECRETS: SECRETS } });
			await h.callText('browser_navigate', { url: h.site.page('form') });
			const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			const field = byId(state, 'password');
			const token = state.state_token as string;

			const unpinned = await h.callError('browser_fill_secret', {
				index: field.index,
				secret: 'unpinned_password',
				state_token: token,
			});
			console.log(`[B2.8] unpinned secret: ${unpinned}`);
			assertStringIncludes(unpinned, 'Error: navigation-blocked: ');
			assert(!unpinned.includes(ALT_SECRET));

			const stale = await h.callError('browser_fill_secret', {
				index: field.index,
				secret: 'site_password',
				state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
			});
			console.log(`[B2.8] stale state_token: ${stale}`);
			assertStringIncludes(stale, 'Error: element-not-found: ');

			const submit = byId(state, 'submit');
			const notInput = await h.callError('browser_fill_secret', {
				index: submit.index,
				secret: 'site_password',
				state_token: token,
			});
			console.log(`[B2.8] a <button> target: ${notInput}`);
			assertStringIncludes(notInput, 'Error: element-not-interactable: ');

			const notText = await h.callError('browser_fill_secret', {
				index: byId(state, 'email').index,
				secret: 'site_password',
				state_token: token,
			});
			console.log(`[B2.8] a type=email target: ${notText}`);
			assertStringIncludes(notText, 'Error: element-not-interactable: ');

			// Nothing was typed by any of the four, so the ledger is empty.
			const audit = await structured<AuditRead>(h, 'browser_audit', {});
			assertEquals(audit.entries.length, 0, `a refusal must write no audit entry: ${JSON.stringify(audit)}`);
		});

		await t.step('SEC-FH-23: a scheme-less pin is refused over plaintext http, and not advertised there', async () => {
			// Two secrets, the same host, differing by nothing but the scheme in the pattern. The
			// fixture site is plaintext, so `https_only_password` must be refused here and
			// `site_password` — pinned with an explicit `http://` — must not be. That is the whole rule,
			// measured on the real browser rather than against a scripted frame tree: before SEC-FH-23
			// the pin ran through the navigation predicate, where a scheme-less pattern covers `http:`
			// too, and a credential pinned to a bank followed a downgrade onto plaintext.
			await using h = await harness({ env: { TTK_SECRETS: SECRETS } });
			await h.callText('browser_navigate', { url: h.site.page('form') });
			const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			const field = byId(state, 'password');

			console.log(`[SEC-FH-23] url=${state.url} available_secrets=${JSON.stringify(state.available_secrets ?? [])}`);
			const advertised = state.available_secrets ?? [];
			assert(
				!advertised.includes('https_only_password'),
				`browser_get_state advertised an https-only secret on a plaintext page: ${JSON.stringify(advertised)}`,
			);
			assert(
				advertised.includes('site_password'),
				`the explicitly-http pin must still be offered: ${JSON.stringify(advertised)}`,
			);

			const refused = await h.callError('browser_fill_secret', {
				index: field.index,
				secret: 'https_only_password',
				state_token: state.state_token,
			});
			console.log(`[SEC-FH-23] an https-only secret on a plaintext page: ${refused}`);
			assertStringIncludes(refused, 'Error: navigation-blocked: ');
			assert(!refused.includes(HTTPS_ONLY_SECRET), refused);

			// Nothing typed: the page's own report of the field's length is the proof, not an inference.
			const after = await structured<State>(h, 'browser_get_state', {});
			assertStringIncludes(after.page, 'pwlen:0');
			assertEquals((await structured<AuditRead>(h, 'browser_audit', {})).entries.length, 0);
		});

		await t.step('SEC-07: a password field in a genuinely out-of-process frame is refused', async () => {
			const alt = altOriginServer();
			try {
				await using h = await harness({
					env: { TTK_SECRETS: SECRETS },
					// The host page embeds the second origin, so Chromium puts the child in its own renderer.
					site: { frameOrigin: alt.origin },
				});
				await h.callText('browser_navigate', { url: h.site.page('oopif') });
				const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
				console.log(`[B2.8/SEC-07] frames: ${JSON.stringify(state.frames)}`);
				const oopif = state.frames.find((frame) => frame.is_oopif);
				assert(oopif !== undefined, `no out-of-process frame captured: ${JSON.stringify(state.frames)}`);
				const field = byId(state, 'alt-password');
				assertEquals(field.frame_id, oopif.id, 'the password field must be attributed to the OOPIF');

				const refused = await h.callError('browser_fill_secret', {
					index: field.index,
					secret: 'site_password',
					state_token: state.state_token,
				});
				console.log(`[B2.8/SEC-07] a password field inside a cross-origin frame: ${refused}`);
				assertStringIncludes(refused, 'Error: navigation-blocked: ');
				assert(!refused.includes(BANK_SECRET));
				assertEquals((await structured<AuditRead>(h, 'browser_audit', {})).entries.length, 0);
			} finally {
				await alt.close();
			}
		});

		await t.step('SEC-24: both secret-bearing paths refuse under a scaled visual viewport', async () => {
			await using h = await harness({ env: { TTK_SECRETS: SECRETS } });
			await h.callText('browser_navigate', { url: h.site.page('form') });
			const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			const field = byId(state, 'password');
			const token = state.state_token as string;

			await setPageScale(h, 2);
			const filled = await h.callError('browser_fill_secret', {
				index: field.index,
				secret: 'site_password',
				state_token: token,
			});
			console.log(`[B2.8/SEC-24] browser_fill_secret under page scale 2: ${filled}`);
			assertStringIncludes(filled, 'Error: browser-unavailable: ');
			assertStringIncludes(filled, 'scaled');

			const typed = await h.callError('browser_type', {
				index: field.index,
				text: '<secret>site_password</secret>',
			});
			console.log(`[B2.8/SEC-24] browser_type with a placeholder under page scale 2: ${typed}`);
			assertStringIncludes(typed, 'Error: browser-unavailable: ');

			// The guard is on the *secret* path only: an ordinary type still works under the same scale.
			const ordinary = await h.call('browser_type', { index: field.index, text: 'ordinary' });
			assertEquals(ordinary.isError, undefined, `an ordinary type must not be blocked: ${JSON.stringify(ordinary)}`);

			// Back to scale 1, and the fill goes through — so the refusal was the scale and not something
			// else about this session.
			await setPageScale(h, 1);
			const again = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			const ok = await h.call('browser_fill_secret', {
				index: byId(again, 'password').index,
				secret: 'site_password',
				state_token: again.state_token,
			});
			assertEquals(ok.isError, undefined, `the fill must succeed at scale 1: ${JSON.stringify(ok.content)}`);
			console.log('[B2.8/SEC-24] scale restored to 1: the same fill succeeds');
		});

		await t.step('SEC-08: a non-admin principal reads only its OWN entries, over the wire', async () => {
			// The credential holds `mcp:invoke` and nothing else, which is the shape SEC-08 is about:
			// sessions are shared among every `mcp:invoke` holder (SEC-22), so an unfiltered read under
			// that scope would hand each of them a map of the others' credential use.
			await using h = await harness({ scopes: ['mcp:invoke'], env: { TTK_SECRETS: SECRETS } });
			await h.callText('browser_navigate', { url: h.site.page('form') });
			const state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			await h.call('browser_fill_secret', {
				index: byId(state, 'password').index,
				secret: 'site_password',
				state_token: state.state_token,
			});

			// Another principal's entry, written into the same shared session's ledger.
			const record = h.gateway.registry.peek('default');
			assert(record !== undefined);
			record.audit.append({
				session_id: 'default',
				principal: 'another-worker',
				kind: 'secret-fill',
				frame_id: 'F',
				origin: 'https://elsewhere.example',
				secret: 'someone_elses_credential',
				ok: true,
			});

			const own = await structured<AuditRead>(h, 'browser_audit', {});
			console.log(`[B2.8/SEC-08] non-admin read: scope=${own.scope} entries=${JSON.stringify(own.entries)}`);
			assertEquals(own.scope, 'own', 'a principal without admin must be told which filter answered');
			assertEquals(own.entries.length, 1, 'exactly its own entry');
			assert(
				!JSON.stringify(own.entries).includes('someone_elses_credential'),
				'another principal’s credential use must not be readable under mcp:invoke',
			);
			// The ledger really does hold both, so the narrowing is the filter and not an empty ledger.
			assertEquals(record.audit.read({ principal: 'x', all: true }).entries.length, 2);
		});
	},
});

/**
 * **SEC-FH-23, the reachability leg — the page moves ITSELF out from under the pin.**
 *
 * The unit tier drives every fail-open frame tree deterministically; this exists because one of
 * those trees is reachable without any exotic step, and that is what made the finding Critical
 * rather than theoretical. A page does `location.href = URL.createObjectURL(new Blob([html]))` — a
 * same-origin top-level `blob:` navigation, which Chromium permits — and against the shipped code
 * the pin stopped applying from that moment: `browser_get_state` advertised the pinned credential on
 * an attacker-authored document, which is the server *inviting* the spend, and `browser_fill_secret`
 * then typed it, with the ledger recording the origin as the blob's inner origin.
 *
 * Both halves are asserted here, because closing only the fill would leave the server telling the
 * model a lie it would then refuse to act on. The secret is pinned to the fixture host over
 * plaintext, so the baseline is a real "yes" and an empty list afterwards cannot be a pin that never
 * bound in the first place — the step asserts that baseline before it asserts anything else.
 *
 * `evaluate` is a scope the harness must ask for, and it is the attacker's stand-in: any page script
 * can do this, and the equivalent runs without it whenever the page itself is hostile.
 */
Deno.test({
	name: 'e2e fill_secret (SEC-FH-23): a page that navigates itself to a blob: is not the pinned origin',
	ignore,
	async fn() {
		await using h = await harness({
			scopes: ['mcp:invoke', 'admin', 'evaluate'],
			env: { TTK_SECRETS: SECRETS },
		});
		await h.callText('browser_navigate', { url: h.site.page('form') });

		const baseline = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
		console.log(
			`[SEC-FH-23] baseline url=${baseline.url} advertised=${JSON.stringify(baseline.available_secrets ?? [])}`,
		);
		assert(
			(baseline.available_secrets ?? []).includes('site_password'),
			'the pin must bind on the fixture host first, or an empty list later proves nothing',
		);

		// The page navigates itself. Same origin, top level, no user gesture, nothing exotic.
		const moved = await h.call('browser_evaluate', {
			expression: "(() => { const html = '<!doctype html><title>attacker</title><form>" +
				'<input id="p" type="password" name="p"></form>\';' +
				" const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));" +
				' setTimeout(() => { location.href = url; }, 0); return url.slice(0, 5); })()',
		});
		assertEquals(moved.isError, undefined, `the page could not move itself: ${JSON.stringify(moved.content)}`);

		// Wait for the move to COMMIT AND PARSE, reading the live state rather than trusting a fixed
		// sleep: the first read after `location.href` lands can catch the new document before its form
		// exists, and an empty element table would then look like a refusal it is not.
		let state = baseline;
		for (let attempt = 0; attempt < 40; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
			if ((state.url ?? '').startsWith('blob:')) break;
		}
		assert((state.url ?? '').startsWith('blob:'), `the page never reached a blob: URL: ${state.url}`);
		// Committed. Give the document a bounded chance to publish a form before reading the table.
		for (let attempt = 0; attempt < 8 && state.interactive_elements.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			state = await structured<State>(h, 'browser_get_state', { fields: ['core', 'attrs'] });
		}
		console.log(`[SEC-FH-23] after the page navigated ITSELF: url=${state.url}`);

		// (1) The invitation is withdrawn.
		const advertised = state.available_secrets ?? [];
		console.log(`[SEC-FH-23] available_secrets on the attacker's document: ${JSON.stringify(advertised)}`);
		assertEquals(
			advertised.includes('site_password'),
			false,
			`the server still offers the pinned credential on a blob: document: ${JSON.stringify(advertised)}`,
		);

		// (2) And the spend itself, asked for anyway — *if* the document can be addressed at all.
		//
		// Measured on this tier and worth stating plainly rather than leaving as a silent branch: a
		// self-navigated `blob:` document publishes NO element table (`interactive_elements: []`,
		// `frames: []`) even though `browser_get_html` reads its bytes, so there is no index for a
		// model to pass and the fill is unreachable by the ordinary route. That is a second barrier,
		// not the one under test, and it is not the one to rely on — the pin is. The deterministic
		// proof that the blob: frame tree refuses and dispatches nothing is the unit-tier matrix
		// ("SEC-FH-23: the credential is refused at every opaque and plaintext frame tree"), which
		// drives the tree directly; this branch fires if the product ever starts indexing such a
		// document, which is exactly when it would need to.
		const field = state.interactive_elements.find((element) => element.attrs?.id === 'p');
		if (field === undefined) {
			console.log('[SEC-FH-23] the blob: document publishes no element table, so no index reaches the fill at all');
		} else {
			const refused = await h.callError('browser_fill_secret', {
				index: field.index,
				secret: 'site_password',
				state_token: state.state_token,
			});
			console.log(`[SEC-FH-23] browser_fill_secret on the blob: document: ${refused}`);
			assertStringIncludes(refused, 'Error: navigation-blocked: ');
			assert(!refused.includes(BANK_SECRET), refused);
		}

		// Nothing typed and nothing recorded, either way. `secret-fill` is the kind that matters: the
		// ledger legitimately holds the `evaluate` row for the navigation this test performed itself,
		// and against the shipped code it also held a `secret-fill` row naming the blob's origin as the
		// place the bank credential was spent.
		const audit = await structured<AuditRead>(h, 'browser_audit', {});
		const spends = audit.entries.filter((entry) => entry.kind === 'secret-fill');
		assertEquals(spends, [], `a refusal must write no secret-fill entry: ${JSON.stringify(audit.entries)}`);
	},
});
