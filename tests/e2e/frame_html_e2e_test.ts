/**
 * S4 — `browser_get_html {frame_id}` against a real `<frameset>`, on a real Chromium.
 *
 * Everything below the browser tier can only assert what a *recorded* frame tree said. The claim
 * this delivery makes is about what a **renderer** does: that a `<frame>` inside a `<frameset>` can
 * be addressed the way an `<iframe>` can, that the bytes that come back are the child's and only the
 * child's, and that the cross-origin read is gated on origin rather than on process-ness. Those are
 * measurements, and this file is where they are taken.
 *
 * The risk this suite exists to retire (RR-2) was that Gate C — `DOM.getFrameOwner` →
 * `DOM.describeNode({pierce:true})` → `DOM.resolveNode` → `Runtime.callFunctionOn` — might not hold
 * for a frameset's `<frame>`: a `<frameset>` document has no `<body>`, its children are not
 * `<iframe>` elements, and Chromium's frameset path is old code. It was inferred for the whole
 * design phase and measured here for the first time; `build/evidence/rr2_frameset_owner_probe.log`
 * carries the measurement, and the rows below are the same chain driven through the shipped tool.
 *
 * Acceptance rows (report_plan.md §5.1) and controls (security_seed.md §8) realized here:
 *   1   the shell without the sentinel; the named content child WITH it, and its own url
 *   2a  a nested same-origin frame returns only that frame's document
 *   2b  an out-of-process frame returns only that frame's document, and ONLY under `evaluate`
 *   3b  a detached frame is refused, with no top-document bytes                        (C-5)
 *   3c  an unknown id is refused, with no top-document bytes                           (C-6, C-7)
 *   4a  truncation and size are explicit, with the TRUE total length                   (F-3)
 *   C-1 origin, not process-ness, decides the gate — the default grant is refused
 *   C-2 `evaluate` opens the cross-origin read, and it is audited
 *   C-7 NO refusal anywhere carries top-document bytes
 *   C-13 one same-process child frame read through BOTH frame-scoped tools
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { harness, skipUnlessBrowser, textOf } from '../support/harness.ts';
import {
	FRAME_NESTED_SENTINEL,
	FRAME_SENTINEL,
	FRAMESET_TOP_SENTINEL,
	HTML_LIMIT_CHARS,
	startFixtureSite,
} from '../fixtures/site.ts';

const ignore = skipUnlessBrowser('frame html e2e');

/** The default grant of `security_seed.md` §0 — every scope a principal holds WITHOUT `evaluate`. */
const DEFAULT_GRANT = ['mcp:invoke', 'view:watch', 'view:control', 'admin'] as const;

interface FrameRow {
	id: string;
	parent: string | null;
	url: string;
	name: string | null;
	is_oopif: boolean;
	captured: boolean;
}

interface FramesPayload {
	session_id: string;
	state_token: string | null;
	capture_truncated: boolean;
	frames: FrameRow[];
}

interface HtmlPayload {
	session_id: string;
	frame_id: string;
	url: string;
	state_token: string | null;
	length: number;
	truncated: boolean;
	returned_length: number;
	media_type: string;
	audit_id?: string;
}

/** The frame whose URL ends with `suffix`; fails loudly rather than returning `undefined`. */
function frameEndingWith(frames: readonly FrameRow[], suffix: string): FrameRow {
	const found = frames.find((frame) => frame.url.endsWith(suffix));
	assert(found !== undefined, `no frame whose url ends with ${suffix}: ${JSON.stringify(frames)}`);
	return found;
}

/**
 * C-7, applied to every refusal in this file.
 *
 * A refusal that carries the frameset shell's sentinel has returned the top document instead of
 * refusing, which is the failure mode I-FH-1 exists to forbid — and the one a "no bytes" claim
 * asserted only over `structuredContent` would miss, because the document travels in the text block.
 */
function refusalCarriesNoDocument(
	result: { isError?: boolean; content?: unknown; structuredContent?: unknown },
): string {
	assertEquals(result.isError, true, `expected a refusal: ${JSON.stringify(result).slice(0, 400)}`);
	const serialized = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
	assert(
		!serialized.includes(FRAMESET_TOP_SENTINEL),
		`a refusal carried the TOP document: ${serialized.slice(0, 400)}`,
	);
	assert(!serialized.includes(FRAME_SENTINEL), `a refusal carried the content document: ${serialized.slice(0, 400)}`);
	assert(
		!serialized.includes(FRAME_NESTED_SENTINEL),
		`a refusal carried the nested document: ${serialized.slice(0, 400)}`,
	);
	return textOf(result as { content?: unknown });
}

Deno.test({
	name: 'e2e frame html (S4, RR-2): a real <frameset> read frame by frame, and the cross-origin gate',
	ignore,
	async fn(t) {
		// A second fixture site on `localhost`: a different *site* to Chromium (scheme plus host, port
		// ignored), which is what puts the frame it serves in its own renderer. The `framesetcross`
		// page embeds its content child from here.
		const second = startFixtureSite({ hostname: 'localhost' });
		const secondOrigin = second.url.replace(/\/$/, '');
		try {
			await t.step('criterion 1: the default read is the SHELL, and the named child is the child', async () => {
				await using h = await harness({ scopes: DEFAULT_GRANT, site: { frameOrigin: secondOrigin } });
				await h.callText('browser_navigate', { url: h.site.page('frameset') });

				const frames = await h.callJson<FramesPayload>('browser_get_frames', {});
				console.log(
					`[S4/1] browser_get_frames over a <frameset>: ${
						frames.frames.map((f) => `${f.name || '(anon)'}@${f.url}`).join(', ')
					}`,
				);
				// The precondition Gate A depends on, and which nothing before S4 had measured: the DOM
				// capture pipeline enumerates `<frameset>` children at all. Without it every read below
				// would be refused by Gate A before Gate C was ever reached.
				assertEquals(frames.frames.length, 4, JSON.stringify(frames.frames));
				assertEquals(frames.capture_truncated, false);

				const shell = await h.call('browser_get_html', {});
				assertEquals(shell.isError, undefined, textOf(shell));
				const shellText = textOf(shell);
				const shellPayload = shell.structuredContent as unknown as HtmlPayload;
				console.log(
					`[S4/1] browser_get_html {} -> ${shellPayload.length} chars, url=${shellPayload.url}, ` +
						`truncated=${shellPayload.truncated}, audit_id=${shellPayload.audit_id ?? 'none'}`,
				);
				// The shell, and nothing but the shell: a `<frameset>` document, its own sentinel, and
				// NOT the table its content child holds. This half of criterion 1 is what the whole
				// capability is for — until now `browser_get_html` could return only this.
				assertStringIncludes(shellText, '<frameset');
				assertStringIncludes(shellText, FRAMESET_TOP_SENTINEL);
				assert(!shellText.includes(FRAME_SENTINEL), 'the shell must not carry the content child’s table');
				assert(!shellText.includes('2024M12'), 'the shell must not carry the child’s period cell');
				assertEquals(shellPayload.url, h.site.page('frameset'));
				assertEquals(shellPayload.frame_id, frames.frames[0]?.id);
				// Same-origin with itself: no scope, and no ledger row (C-8).
				assertEquals(shellPayload.audit_id, undefined);

				const content = frameEndingWith(frames.frames, '/framesetcontent');
				assertEquals(content.name, 'content');
				assertEquals(content.is_oopif, false, 'a same-origin frameset child is same-process');
				const read = await h.call('browser_get_html', { frame_id: content.id });
				assertEquals(read.isError, undefined, textOf(read));
				const text = textOf(read);
				const payload = read.structuredContent as unknown as HtmlPayload;
				console.log(
					`[S4/1] browser_get_html {frame_id: content} -> ${payload.length} chars, url=${payload.url}, ` +
						`sentinel=${text.includes(FRAME_SENTINEL)}, audit_id=${payload.audit_id ?? 'none'}`,
				);
				// MEASURED: the child's own document, from a `<frame>` in a `<frameset>`. RR-2 retired.
				assertStringIncludes(text, FRAME_SENTINEL);
				assertStringIncludes(text, '2024M12');
				assertStringIncludes(text, '2823961');
				assert(!text.includes(FRAMESET_TOP_SENTINEL), 'the child read carried the TOP document (E-75)');
				assert(!text.includes('<frameset'), 'the child read carried the shell markup');
				// Provenance is the CHILD's, which is the half a caller uses to know what it read.
				assertEquals(payload.frame_id, content.id);
				assertEquals(payload.url, h.site.page('framesetcontent'));
				assertEquals(payload.truncated, false);
				assertEquals(payload.length, payload.returned_length);
				assertEquals(payload.media_type, 'text/html');
				// Same-origin: still no scope and still no ledger row.
				assertEquals(payload.audit_id, undefined);

				const menu = frameEndingWith(frames.frames, '/framesetmenu');
				const menuText = textOf(await h.call('browser_get_html', { frame_id: menu.id }));
				console.log(`[S4/1] browser_get_html {frame_id: menu} -> ${menuText.length} chars`);
				assertStringIncludes(menuText, 'Statistics');
				assert(!menuText.includes(FRAME_SENTINEL), 'the menu read carried its sibling’s table');
				assert(!menuText.includes(FRAMESET_TOP_SENTINEL), 'the menu read carried the TOP document');
			});

			await t.step('criterion 2a + 4a: the depth-2 frame, and truncation with the TRUE length', async () => {
				await using h = await harness({ scopes: DEFAULT_GRANT, site: { frameOrigin: secondOrigin } });
				await h.callText('browser_navigate', { url: h.site.page('frameset') });
				const frames = await h.callJson<FramesPayload>('browser_get_frames', {});

				const nested = frameEndingWith(frames.frames, '/framesetnested');
				const content = frameEndingWith(frames.frames, '/framesetcontent');
				assertEquals(nested.parent, content.id, 'the leaf hangs off the content child, not off the shell');

				const read = await h.call('browser_get_html', { frame_id: nested.id });
				assertEquals(read.isError, undefined, textOf(read));
				const text = textOf(read);
				const payload = read.structuredContent as unknown as HtmlPayload;
				console.log(
					`[S4/2a,4a] browser_get_html {frame_id: nested} -> length=${payload.length} ` +
						`returned_length=${payload.returned_length} truncated=${payload.truncated} url=${payload.url}`,
				);
				// 2a: only that frame's document.
				assertStringIncludes(text, FRAME_NESTED_SENTINEL);
				assert(!text.includes(FRAME_SENTINEL), 'the depth-2 read carried its parent’s table');
				assert(!text.includes(FRAMESET_TOP_SENTINEL), 'the depth-2 read carried the TOP document');
				assertEquals(payload.url, h.site.page('framesetnested'));
				assertEquals(payload.frame_id, nested.id);

				// 4a / F-3: `length` is the document's TRUE size and `returned_length` is what crossed the
				// channel. Until 0.2.0 the cap REPLACED the length, so a caller could not tell a
				// 200 000-character document from a 40 MB one. The fixture is sized past the cap on
				// purpose, so the two numbers must differ or the field is lying.
				assertEquals(payload.truncated, true);
				assert(
					payload.length > HTML_LIMIT_CHARS,
					`the fixture must exceed the cap to test it: ${payload.length}`,
				);
				assertEquals(payload.returned_length, HTML_LIMIT_CHARS);
				assert(payload.length !== payload.returned_length, 'F-3: the true length must survive truncation');
				assertStringIncludes(text, `[truncated at ${HTML_LIMIT_CHARS} characters]`);
			});

			await t.step('3c / C-6 / C-7: an unknown frame id is refused and carries no document', async () => {
				await using h = await harness({ scopes: DEFAULT_GRANT, site: { frameOrigin: secondOrigin } });
				await h.callText('browser_navigate', { url: h.site.page('frameset') });
				await h.callJson<FramesPayload>('browser_get_frames', {});

				const refused = await h.call('browser_get_html', { frame_id: 'NOTAFRAMEIDATALL0000000000000000' });
				const text = refusalCarriesNoDocument(refused);
				console.log(`[S4/3c] an unknown frame id: ${text}`);
				assertStringIncludes(text, 'Error: invalid-arguments: ');
			});

			await t.step(
				'C-1: the cross-origin child is refused on the DEFAULT grant — origin decides, not process-ness',
				async () => {
					await using h = await harness({ scopes: DEFAULT_GRANT, site: { frameOrigin: secondOrigin } });
					await h.callText('browser_navigate', { url: h.site.page('framesetcross') });
					const frames = await h.callJson<FramesPayload>('browser_get_frames', {});
					const cross = frameEndingWith(frames.frames, '/framesetcontent');
					console.log(
						`[S4/C-1] the cross-site content child: url=${cross.url} is_oopif=${cross.is_oopif} ` +
							`captured=${cross.captured}`,
					);
					assertStringIncludes(cross.url, 'localhost');

					const refused = await h.call('browser_get_html', { frame_id: cross.id });
					const text = refusalCarriesNoDocument(refused);
					console.log(`[S4/C-1] browser_get_html {frame_id: cross} on the default grant: ${text}`);
					assertStringIncludes(text, 'Error: scope-required: ');
					// SEC-17: an error message is a probe result. It names the frame, never the scope.
					assert(!text.includes('evaluate'), `the refusal named the scope: ${text}`);

					// C-8: a refusal is not a privileged act, so it writes NO ledger row.
					const record = h.gateway.registry.peek('default');
					assert(record !== undefined);
					const ledger = record.audit.read({ principal: 'e2e', all: true });
					assertEquals(
						ledger.entries.filter((entry) => entry.kind === 'read-frame-html').length,
						0,
						`a refused read wrote a ledger row: ${JSON.stringify(ledger)}`,
					);

					// The same page's SAME-ORIGIN child stays readable on this grant: the gate is about
					// origin, and nothing else moved.
					const menu = frameEndingWith(frames.frames, '/framesetmenu');
					const allowed = await h.call('browser_get_html', { frame_id: menu.id });
					assertEquals(allowed.isError, undefined, textOf(allowed));
					console.log(`[S4/C-1] the same page’s same-origin child is still readable on the default grant`);
				},
			);

			await t.step('criterion 2b / C-2: with `evaluate`, the OOPIF read succeeds, child-only and audited', async () => {
				await using h = await harness({
					scopes: ['mcp:invoke', 'evaluate', 'admin'],
					site: { frameOrigin: secondOrigin },
				});
				await h.callText('browser_navigate', { url: h.site.page('framesetcross') });
				const frames = await h.callJson<FramesPayload>('browser_get_frames', {});
				const cross = frameEndingWith(frames.frames, '/framesetcontent');
				assertEquals(cross.is_oopif, true, 'a localhost frame inside a 127.0.0.1 frameset is its own renderer');

				const read = await h.call('browser_get_html', { frame_id: cross.id });
				assertEquals(read.isError, undefined, textOf(read));
				const text = textOf(read);
				const payload = read.structuredContent as unknown as HtmlPayload;
				console.log(
					`[S4/2b] browser_get_html {frame_id: oopif} with the grant -> ${payload.length} chars, ` +
						`url=${payload.url}, audit_id=${payload.audit_id ?? 'none'}`,
				);
				assertStringIncludes(text, FRAME_SENTINEL);
				assertStringIncludes(text, '2024M12');
				assert(!text.includes(FRAMESET_TOP_SENTINEL), 'the OOPIF read carried the TOP document');
				assertStringIncludes(payload.url, 'localhost');
				assert(payload.audit_id !== undefined, 'a cross-origin read must be audited');

				// I-FH-5 / C-9: the row records that a cross-origin document was read, and carries not one
				// byte, prefix or digest OF it. `origin` is scheme+host+port — never the path or query,
				// which is where a one-time code appears.
				const record = h.gateway.registry.peek('default');
				assert(record !== undefined);
				const ledger = record.audit.read({ principal: 'e2e', all: true });
				const rows = ledger.entries.filter((entry) => entry.kind === 'read-frame-html');
				console.log(`[S4/2b] the ledger row: ${JSON.stringify(rows)}`);
				assertEquals(rows.length, 1);
				const row = rows[0];
				assert(row !== undefined);
				assertEquals(row.audit_id, payload.audit_id);
				assertEquals(row.frame_id, cross.id);
				assertEquals(row.origin, new URL(secondOrigin).origin);
				assertEquals(row.ok, true);
				assert((row.result_bytes ?? 0) > 0);
				const serialized = JSON.stringify(ledger);
				assert(!serialized.includes(FRAME_SENTINEL), `the document reached the ledger: ${serialized}`);
				assert(!serialized.includes('2024M12'), `a document fragment reached the ledger: ${serialized}`);
			});

			await t.step('C-13: one same-process frameset child, read through BOTH frame-scoped tools', async () => {
				await using h = await harness({
					scopes: ['mcp:invoke', 'evaluate', 'admin'],
					site: { frameOrigin: secondOrigin },
				});
				await h.callText('browser_navigate', { url: h.site.page('frameset') });
				const frames = await h.callJson<FramesPayload>('browser_get_frames', {});
				const content = frameEndingWith(frames.frames, '/framesetcontent');

				const html = textOf(await h.call('browser_get_html', { frame_id: content.id }));
				assertStringIncludes(html, FRAME_SENTINEL);

				// E-75, live: before the repair this expression ran in the HOST document, where there is
				// no <caption> at all, and answered about the wrong page without saying so.
				const evaluated = await h.call('browser_evaluate', {
					frame_id: content.id,
					expression: 'document.querySelector("caption").textContent',
				});
				assertEquals(evaluated.isError, undefined, textOf(evaluated));
				const value = evaluated.structuredContent as { ok: boolean; value?: unknown; frame_id: string };
				console.log(`[S4/C-13] browser_evaluate {frame_id: content} -> ${JSON.stringify(value.value)}`);
				assertEquals(value.ok, true);
				assertEquals(value.value, FRAME_SENTINEL);
				assertEquals(value.frame_id, content.id);
				console.log('[S4/C-13] MEASURED: both frame-scoped tools reach the same frameset child document.');
			});

			await t.step('3b / C-5: a DETACHED frame is refused, with no top-document bytes', async () => {
				await using h = await harness({
					scopes: ['mcp:invoke', 'evaluate', 'admin'],
					site: { frameOrigin: secondOrigin },
				});
				await h.callText('browser_navigate', { url: h.site.page('frameset') });
				const frames = await h.callJson<FramesPayload>('browser_get_frames', {});
				const menu = frameEndingWith(frames.frames, '/framesetmenu');

				// Readable first, so the refusal below is caused by the detachment and not by anything else.
				assertEquals((await h.call('browser_get_html', { frame_id: menu.id })).isError, undefined);

				const removed = await h.call('browser_evaluate', {
					expression: 'document.querySelector(\'frame[name="menu"]\').remove(); "removed"',
				});
				assertEquals(removed.isError, undefined, textOf(removed));

				// No fresh capture in between: the id is still in the state this session holds, so Gate A
				// passes and the refusal is Gate B's — which is the gate C-5 is about.
				const refused = await h.call('browser_get_html', { frame_id: menu.id });
				const text = refusalCarriesNoDocument(refused);
				console.log(`[S4/3b] a detached frame: ${text}`);
				assertStringIncludes(text, 'Error: invalid-arguments: ');
				assertStringIncludes(text, menu.id);
			});
		} finally {
			await second.close();
		}
	},
});

/**
 * **REV-1 — the deny path for the forgery, at the only tier that can see it.**
 *
 * The finding review measured was not about `location.origin`, which is genuinely unforgeable: it
 * was about the **path** this server took to reach it. On a same-process child, `receiverFor` hopped
 * from the resolved document to its `window` through `Document.prototype.defaultView` — an ordinary
 * accessor, `configurable=true` in real Chromium — so a page that redefined it chose the object the
 * bytes *and* the authorization origin were read out of. Measured on this exact shape: the page
 * suppressed its own `read-frame-html` row while its cross-origin document was handed over, and, in
 * the other direction, minted a row naming `https://not-a-real-origin.example`.
 *
 * A unit-tier assertion cannot discharge this. The premise failed precisely where the fake wire
 * could not see it — the fake answers the `defaultView` hop itself, so no scripted row could have
 * noticed that a real page gets to answer it instead. It needs a renderer, and the shape needs a
 * **cross-origin, same-process** child: Chromium's site isolation keys on scheme+site and ignores
 * the port, so a second fixture site on the same host is a different origin in the same renderer.
 * That is the `iframe_same_site_port` shape the design names as SEC-FH-1's counter-example, and it
 * is the only path the hop was ever on — an out-of-process frame's receiver is `null`, so its
 * extraction always read its own realm's global.
 *
 * The repair is the receiver, not a check on what the receiver said: `document.location` is an own
 * **non-configurable** property of the instance (redefining it throws; patching `Document.prototype`
 * loses to the own property), so the extraction now runs on the document handle `DOM.resolveNode`
 * produced and reads the origin off it. The rows below install the forgery that worked, against the
 * fixed handler, and assert the outcome does not move.
 */
Deno.test({
	name: 'e2e frame html (REV-1): a same-process CROSS-ORIGIN child cannot choose the origin it is read as',
	ignore,
	async fn(t) {
		// The same HOST, a different PORT: a different origin, the same site, ONE renderer.
		const second = startFixtureSite({ hostname: '127.0.0.1' });
		const secondOrigin = second.url.replace(/\/$/, '');
		/** The swap that worked: `defaultView` answers with an object the page built. */
		const swapTo = (origin: string) =>
			`(() => { try { const real = window; const fake = { location: { origin: ${JSON.stringify(origin)} },` +
			` document: real.document };` +
			` Object.defineProperty(Document.prototype, 'defaultView', { get: () => fake, configurable: true });` +
			` return 'installed; defaultView.location.origin=' + document.defaultView.location.origin +` +
			` ' REAL=' + location.origin; } catch (e) { return 'THREW ' + e.name; } })()`;
		try {
			await using h = await harness({
				scopes: ['mcp:invoke', 'evaluate', 'admin'],
				site: { frameOrigin: secondOrigin },
			});
			await h.callText('browser_navigate', { url: h.site.page('framesetcross') });
			const frames = await h.callJson<FramesPayload>('browser_get_frames', {});
			const child = frameEndingWith(frames.frames, '/framesetcontent');
			const topOrigin = new URL(h.site.url).origin;
			const childOrigin = new URL(child.url).origin;
			const rowsNow = () => {
				const record = h.gateway.registry.peek('default');
				assert(record !== undefined);
				return record.audit.read({ principal: 'e2e', all: true }).entries
					.filter((entry) => entry.kind === 'read-frame-html');
			};

			await t.step('the shape: cross-origin, and in the SAME renderer as its parent', () => {
				console.log(`[REV-1] top=${topOrigin} child=${childOrigin} is_oopif=${child.is_oopif}`);
				assert(childOrigin !== topOrigin, `the child must be cross-origin: ${childOrigin}`);
				// Not skipped when false, deliberately: a branch that returned early here would make the
				// whole proof vacuous exactly as the branch that once hid E-75 did.
				assertEquals(
					child.is_oopif,
					false,
					'the proof needs the SAME-PROCESS path, which is the only one that ever hopped through defaultView',
				);
			});

			await t.step(
				'the control: an UNSCOPED principal is still refused, because Gate B reads the frame tree',
				async () => {
					await using unscoped = await harness({ scopes: DEFAULT_GRANT, site: { frameOrigin: secondOrigin } });
					await unscoped.callText('browser_navigate', { url: unscoped.site.page('framesetcross') });
					const theirs = await unscoped.callJson<FramesPayload>('browser_get_frames', {});
					const theirChild = frameEndingWith(theirs.frames, '/framesetcontent');
					const refused = await unscoped.call('browser_get_html', { frame_id: theirChild.id });
					const text = refusalCarriesNoDocument(refused);
					console.log(`[REV-1] the unscoped control: ${text}`);
					assertStringIncludes(text, 'Error: scope-required: ');
				},
			);

			await t.step('baseline: the read is permitted, audited, and the row names the CHILD’s real origin', async () => {
				const read = await h.call('browser_get_html', { frame_id: child.id });
				assertEquals(read.isError, undefined, textOf(read));
				const payload = read.structuredContent as unknown as HtmlPayload;
				assertStringIncludes(textOf(read), FRAME_SENTINEL);
				assert(payload.audit_id !== undefined, 'a cross-origin read must be audited');
				const rows = rowsNow();
				console.log(
					`[REV-1] BASELINE: audit_id=${payload.audit_id} origins=${JSON.stringify(rows.map((r) => r.origin))}`,
				);
				assertEquals(rows.length, 1);
				assertEquals(rows[0]?.origin, childOrigin);
			});

			await t.step('the forgery that suppressed the row: the page swaps defaultView to the TOP origin', async () => {
				const install = await h.call('browser_evaluate', { expression: swapTo(topOrigin), frame_id: child.id });
				assertEquals(install.isError, undefined, textOf(install));
				const installed = String((install.structuredContent as { value?: unknown })?.value ?? '');
				console.log(`[REV-1] install: ${installed}`);
				// The attack is LIVE in the page: what the page's own `document.defaultView` reports is
				// the forged origin. If that ever stops holding, the rows below stop proving anything —
				// and they say so here rather than passing quietly.
				assertStringIncludes(installed, `defaultView.location.origin=${topOrigin}`);
				assertStringIncludes(installed, `REAL=${childOrigin}`);

				const read = await h.call('browser_get_html', { frame_id: child.id });
				assertEquals(read.isError, undefined, textOf(read));
				const payload = read.structuredContent as unknown as HtmlPayload;
				const rows = rowsNow();
				console.log(
					`[REV-1] AFTER the swap: audit_id=${payload.audit_id ?? 'NONE'} rows=${rows.length} ` +
						`origins=${JSON.stringify(rows.map((r) => r.origin))}`,
				);
				// The measured failure was `audit_id=NONE` here — the page suppressing the row that
				// records that its cross-origin document was handed over.
				assert(payload.audit_id !== undefined, 'the page suppressed its own ledger row (REV-1 regressed)');
				assertEquals(rows.length, 2, 'the second read must write a second row');
				assertEquals(rows[1]?.origin, childOrigin, 'the ledger named the origin the PAGE chose');
				assertEquals(rows[1]?.audit_id, payload.audit_id);
				// And the bytes are still the child's own document, read off the document handle.
				assertStringIncludes(textOf(read), FRAME_SENTINEL);
				assert(!textOf(read).includes(FRAMESET_TOP_SENTINEL), 'the read carried the TOP document');
				assertEquals(payload.url, `${secondOrigin}/framesetcontent`);
			});

			await t.step(
				'the other direction: a FOREIGN origin the browser never reported never reaches the ledger',
				async () => {
					const install = await h.call('browser_evaluate', {
						expression: swapTo('https://not-a-real-origin.example'),
						frame_id: child.id,
					});
					assertEquals(install.isError, undefined, textOf(install));
					assertStringIncludes(
						String((install.structuredContent as { value?: unknown })?.value ?? ''),
						'defaultView.location.origin=https://not-a-real-origin.example',
					);
					const read = await h.call('browser_get_html', { frame_id: child.id });
					assertEquals(read.isError, undefined, textOf(read));
					const rows = rowsNow();
					console.log(`[REV-1] AFTER the foreign forgery: origins=${JSON.stringify(rows.map((r) => r.origin))}`);
					assertEquals(rows.length, 3);
					assertEquals(
						rows.map((r) => r.origin),
						[childOrigin, childOrigin, childOrigin],
						'the ledger named an origin the browser never reported',
					);
					console.log('[REV-1] MEASURED: three reads, three rows, one origin — the one the browser reported.');
				},
			);
		} finally {
			await second.close();
		}
	},
});
