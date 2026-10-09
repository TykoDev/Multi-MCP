/**
 * D-096 (A2) on real Chromium: where an index-less `<secret>` lands, and which origin it is pinned to.
 *
 * Two review findings, each a way the focus walk named the wrong frame while the keystrokes went to another:
 *
 * - **R3-1, frame owners that are not `<iframe>`.** A click inside a cross-origin `<object type=text/html>` or
 *   `<embed>` puts focus in the embedded document, and the top document's `activeElement` is then the
 *   `OBJECT`/`EMBED` element. The walk recognised only `IFRAME`/`FRAME`, pinned the secret to the top origin and
 *   typed it into the embedded one.
 * - **R3-2, a reused isolated-world id.** CDP execution-context ids are per renderer process. A world cached on
 *   one site, reused after the same tab navigated cross-site, evaluated in whatever context of the new process
 *   holds that number — measured, a page's own main world, which can redefine `activeElement`.
 *
 * The unit tier scripts both shapes (`packages/mcp/src/secret_pin_test.ts`); these legs exist because only a
 * real renderer decides what `activeElement` is after a click in an embedded document, and only a real
 * cross-process navigation reuses context ids.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { startFixtureSite } from '../fixtures/site.ts';
import { type Harness, harness, skipUnlessBrowser, textOf } from '../support/harness.ts';

const ignore = skipUnlessBrowser('secret focus e2e');

const PIN_SECRET = 'Zq8-E2E-FOCUS-SECRET-3vP';
/** Pinned to the harness site's host with an explicit scheme, because the fixture site is plaintext (SEC-FH-23). */
const SECRETS = JSON.stringify({ site_password: { value: PIN_SECRET, domains: ['http://127.0.0.1'] } });
/** `evaluate` reads the embedded documents back; `admin` reads the audit ledger. */
const SCOPES = ['mcp:invoke', 'evaluate', 'admin'] as const;

interface Frames {
	frames: Array<{ id: string; url: string; is_oopif: boolean }>;
}
interface AuditRead {
	entries: Array<Record<string, unknown>>;
}

/** One main-world expression in the named frame (or the top document), asserting that it ran. */
async function evaluate<T>(h: Harness, expression: string, frameId?: string): Promise<T> {
	const result = await h.call('browser_evaluate', {
		expression,
		...(frameId === undefined ? {} : { frame_id: frameId }),
	});
	assert(result.isError !== true, `browser_evaluate failed: ${textOf(result)}`);
	const value = result.structuredContent as { ok: boolean; value: T };
	assert(value.ok, `the expression threw: ${JSON.stringify(value)}`);
	return value.value;
}

/** Polls a top-document expression until it answers `expected`, returning the last answer either way. */
async function settle<T>(h: Harness, expression: string, expected: T): Promise<T> {
	const until = Date.now() + 5_000;
	let last = await evaluate<T>(h, expression);
	while (last !== expected && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		last = await evaluate<T>(h, expression);
	}
	return last;
}

/** The frame whose URL ends with `suffix`, polled until the browser lists it. */
async function frameEndingWith(h: Harness, suffix: string): Promise<Frames['frames'][number]> {
	const until = Date.now() + 15_000;
	let last: Frames = { frames: [] };
	while (Date.now() < until) {
		last = await h.callJson<Frames>('browser_get_frames', {});
		const found = last.frames.find((frame) => frame.url.endsWith(suffix));
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`no frame ending in ${suffix}: ${JSON.stringify(last.frames)}`);
}

/** `secret-fill` entries in the session's ledger (an evaluate writes rows of its own, which are not counted). */
async function secretFills(h: Harness): Promise<number> {
	const result = await h.call('browser_audit', {});
	assert(result.isError !== true, textOf(result));
	return (result.structuredContent as AuditRead).entries.filter((entry) => entry.kind === 'secret-fill').length;
}

Deno.test({
	name: 'e2e secret focus (R3-1): focus inside a cross-origin <object>/<embed> pins the embedded origin',
	ignore,
	async fn(t) {
		for (const page of ['objectcross', 'embedcross'] as const) {
			await t.step(`${page}: the secret is refused, nothing is typed, nothing is audited`, async () => {
				// Another SITE (localhost vs 127.0.0.1), so Chromium renders the embedded document out of process.
				const inner = startFixtureSite({ hostname: 'localhost' });
				try {
					await using h = await harness({
						scopes: SCOPES,
						env: { TTK_SECRETS: SECRETS },
						site: { frameOrigin: inner.url.replace(/\/$/, '') },
					});
					await h.callText('browser_navigate', { url: h.site.page(page) });
					// The embedded document is served by the second site; wait until it was fetched and has loaded.
					const until = Date.now() + 10_000;
					while (!inner.hits.includes('/focusframe') && Date.now() < until) {
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
					assert(inner.hits.includes('/focusframe'), `the ${page} owner never loaded its document`);
					assertEquals(await settle(h, 'document.readyState', 'complete'), 'complete');
					await new Promise((resolve) => setTimeout(resolve, 500));

					// Focus goes in the way the model would put it there: a click at viewport coordinates.
					const box = JSON.parse(
						await evaluate<string>(h, 'JSON.stringify(document.getElementById("owner").getBoundingClientRect())'),
					) as { x: number; y: number; width: number; height: number };
					await h.callText('browser_click', {
						coordinate_x: Math.round(box.x + box.width / 2),
						coordinate_y: Math.round(box.y + box.height / 2),
					});
					const active = await evaluate<string>(h, 'document.activeElement.tagName');
					console.log(`[R3-1] ${page}: the top document's activeElement after the click is ${active}`);
					assertEquals(active, page === 'objectcross' ? 'OBJECT' : 'EMBED', 'the precondition R3-1 is about');

					// The control: ordinary text with no placeholder goes where focus is, the embedded field.
					await h.callText('browser_type', { text: 'probe' });
					const echo = 'document.getElementById("inner-echo").textContent';
					assertEquals(await settle(h, echo, 'inner:5'), 'inner:5', 'the keystrokes went into the embedded document');
					assertEquals(await evaluate<number>(h, 'document.getElementById("top-field").value.length'), 0);

					// The secret is pinned to http://127.0.0.1 — the TOP document's origin. Before the fix the walk
					// stopped at the OBJECT/EMBED element, pinned the top, and typed the credential into localhost.
					const refused = await h.callError('browser_type', { text: '<secret>site_password</secret>' });
					console.log(`[R3-1] ${page}: browser_type <secret> -> ${refused}`);
					assertStringIncludes(refused, 'Error: navigation-blocked: ');
					assertStringIncludes(refused, inner.url.replace(/\/$/, ''), 'the pin is the embedded frame’s origin');
					assert(!refused.includes(PIN_SECRET));
					await new Promise((resolve) => setTimeout(resolve, 300));
					assertEquals(await evaluate<string>(h, echo), 'inner:5', 'no keystroke of the credential reached it');
					assertEquals(await secretFills(h), 0, 'a refusal writes no secret-fill entry');
				} finally {
					await inner.close();
				}
			});
		}
	},
});

Deno.test({
	name: 'e2e secret focus (R3-1): the converse — a secret pinned to an in-process <object> document is typed there',
	ignore,
	async fn() {
		// Same host, another port: the same SITE, so the embedded document renders in the top's own process (the
		// in-process branch of the walk), and another ORIGIN, so a pin that carries the port names it alone. Were the
		// walk to stop at the OBJECT element, the pin would be the top's origin and this secret would be refused.
		const inner = startFixtureSite({ hostname: '127.0.0.1' });
		try {
			const innerOrigin = inner.url.replace(/\/$/, '');
			await using h = await harness({
				scopes: SCOPES,
				env: { TTK_SECRETS: JSON.stringify({ inner_password: { value: PIN_SECRET, domains: [innerOrigin] } }) },
				site: { frameOrigin: innerOrigin },
			});
			await h.callText('browser_navigate', { url: h.site.page('objectcross') });
			const until = Date.now() + 10_000;
			while (!inner.hits.includes('/focusframe') && Date.now() < until) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assertEquals(await settle(h, 'document.readyState', 'complete'), 'complete');
			await new Promise((resolve) => setTimeout(resolve, 500));
			const box = JSON.parse(
				await evaluate<string>(h, 'JSON.stringify(document.getElementById("owner").getBoundingClientRect())'),
			) as { x: number; y: number; width: number; height: number };
			await h.callText('browser_click', {
				coordinate_x: Math.round(box.x + box.width / 2),
				coordinate_y: Math.round(box.y + box.height / 2),
			});
			assertEquals(await evaluate<string>(h, 'document.activeElement.tagName'), 'OBJECT');

			const typed = await h.callText('browser_type', { text: '<secret>inner_password</secret>' });
			console.log(`[R3-1] same-site <object>: ${typed}`);
			const echo = 'document.getElementById("inner-echo").textContent';
			assertEquals(await settle(h, echo, `inner:${PIN_SECRET.length}`), `inner:${PIN_SECRET.length}`);
			assertEquals(await evaluate<number>(h, 'document.getElementById("top-field").value.length'), 0);
			const audit = (await h.call('browser_audit', {})).structuredContent as AuditRead;
			const fills = audit.entries.filter((entry) => entry.kind === 'secret-fill');
			console.log(`[R3-1] same-site <object> audit: ${JSON.stringify(fills)}`);
			assertEquals(fills.length, 1);
			assertEquals(fills[0]?.origin, innerOrigin, 'audited with the embedded frame’s origin');
			const top = (await h.callJson<Frames>('browser_get_frames', {})).frames[0]?.id;
			assert(fills[0]?.frame_id !== top, 'and with the embedded frame, not the top document');
		} finally {
			await inner.close();
		}
	},
});

Deno.test({
	name: 'e2e secret focus (R3-2): a cross-site navigation of the same tab cannot hand the walk a lying world',
	ignore,
	async fn() {
		await using h = await harness({ scopes: SCOPES, env: { TTK_SECRETS: SECRETS } });
		// Site B frames the harness site (the pinned origin) as its "bank", and lies about focus from every main
		// world it owns.
		const liar = startFixtureSite({ hostname: 'localhost', frameOrigin: new URL(h.site.url).origin });
		try {
			// Site A: a hit test over a pseudo-element in a same-process child frame, then a real, legitimate secret
			// type at the focused field. Under the cached-world code this left an isolated-world context id cached
			// for (page session, main frame).
			//
			// The hit test is the alignment the reuse needs, measured on Chromium 154: context ids are numbered per
			// renderer process, and every document gets its main world and then the vendored per-document isolated
			// world, so on the liar page the odd ids are its lying main worlds and the even ids are honest. The tab's
			// first document contributes one context, each later one two, so without one extra world in site A's
			// process this server's own world takes an even id and the old code passes by luck.
			await h.callText('browser_navigate', { url: h.site.page('pseudoframe') });
			const deco = JSON.parse(
				await evaluate<string>(h, 'JSON.stringify(document.getElementById("deco").getBoundingClientRect())'),
			) as { x: number; y: number; width: number; height: number };
			const hit = await h.call('browser_element_at', {
				x: Math.round(deco.x + deco.width / 2),
				y: Math.round(deco.y + deco.height / 2),
			});
			assert(hit.isError !== true, textOf(hit));
			console.log(`[R3-2] element_at over the child frame's ::before -> ${textOf(hit).slice(0, 200)}`);
			const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
				'browser_get_state',
				{},
			);
			const field = state.interactive_elements.find((element) => element.tag === 'input');
			assert(field !== undefined, JSON.stringify(state.interactive_elements));
			await h.callText('browser_click', { index: field.index });
			await h.callText('browser_type', { text: '<secret>site_password</secret>' });
			assertEquals(await secretFills(h), 1, 'the legitimate type on site A was audited');
			const before = await h.callJson<Frames>('browser_get_frames', {});

			// The same tab, cross-site: a new renderer process, the same page target and CDP session.
			await h.callText('browser_navigate', { url: liar.page('liar') });
			await frameEndingWith(h, '/form');
			const after = await h.callJson<Frames>('browser_get_frames', {});
			console.log(
				`[R3-2] main frame ${before.frames[0]?.id} -> ${after.frames[0]?.id}; ${after.frames.length} frames on B`,
			);
			// The lie is live in the page's main world: that read names the bank frame, not the focused field.
			assertEquals(await evaluate<string>(h, 'document.activeElement.id'), 'bank');

			const refused = await h.callError('browser_type', { text: '<secret>site_password</secret>' });
			console.log(`[R3-2] browser_type <secret> on the liar page -> ${refused}`);
			assertStringIncludes(refused, 'Error: navigation-blocked: ');
			assertStringIncludes(refused, liar.url.replace(/\/$/, ''), 'the pin is the liar page’s own frame');
			assert(!refused.includes(PIN_SECRET));
			assertEquals(
				await evaluate<number>(h, 'document.getElementById("evil-field").value.length'),
				0,
				'no keystroke of the credential reached the liar’s field',
			);
			assertEquals(await secretFills(h), 1, 'only site A’s type was audited');
		} finally {
			await liar.close();
		}
	},
});
