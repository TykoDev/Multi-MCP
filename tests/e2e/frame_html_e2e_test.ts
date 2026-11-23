/**
 * `browser_get_html {frame_id}` against a real `<frameset>`: a `<frame>` is addressable like an `<iframe>`, the bytes
 * returned are the child's only, the cross-origin read is gated on origin (not process-ness) and audited, and no
 * refusal carries a document. Only a real renderer can show the frameset path holds.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { type Harness, harness, skipUnlessBrowser, textOf } from '../support/harness.ts';
import {
	FRAME_NESTED_SENTINEL,
	FRAME_SENTINEL,
	FRAMESET_TOP_SENTINEL,
	HTML_LIMIT_CHARS,
	startFixtureSite,
} from '../fixtures/site.ts';

const ignore = skipUnlessBrowser('frame html e2e');

/** Every scope a principal holds without `evaluate`. */
const DEFAULT_GRANT = ['mcp:invoke', 'view:watch', 'view:control', 'admin'] as const;
const EVALUATE_GRANT = ['mcp:invoke', 'evaluate', 'admin'] as const;

interface FrameRow {
	id: string;
	parent: string | null;
	url: string;
	name: string | null;
	is_oopif: boolean;
}

interface HtmlPayload {
	frame_id: string;
	url: string;
	length: number;
	truncated: boolean;
	returned_length: number;
	media_type: string;
	audit_id?: string;
}

async function frames(h: Harness, page: 'frameset' | 'framesetcross'): Promise<FrameRow[]> {
	await h.callText('browser_navigate', { url: h.site.page(page) });
	return (await h.callJson<{ frames: FrameRow[]; capture_truncated: boolean }>('browser_get_frames', {})).frames;
}

/** The frame whose URL ends with `suffix`. */
function frameEndingWith(rows: readonly FrameRow[], suffix: string): FrameRow {
	const found = rows.find((frame) => frame.url.endsWith(suffix));
	assert(found !== undefined, `no frame whose url ends with ${suffix}: ${JSON.stringify(rows)}`);
	return found;
}

async function read(h: Harness, frameId?: string): Promise<{ text: string; payload: HtmlPayload }> {
	const result = await h.call('browser_get_html', frameId === undefined ? {} : { frame_id: frameId });
	assertEquals(result.isError, undefined, textOf(result));
	return { text: textOf(result), payload: result.structuredContent as unknown as HtmlPayload };
}

/** A refusal that carries no document, checked over content and structured content alike; returns its text. */
async function refused(h: Harness, frameId: string): Promise<string> {
	const result = await h.call('browser_get_html', { frame_id: frameId });
	assertEquals(result.isError, true, `expected a refusal: ${JSON.stringify(result).slice(0, 400)}`);
	const serialized = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
	for (const sentinel of [FRAMESET_TOP_SENTINEL, FRAME_SENTINEL, FRAME_NESTED_SENTINEL]) {
		assert(!serialized.includes(sentinel), `a refusal carried a document: ${serialized.slice(0, 400)}`);
	}
	return textOf(result);
}

function readRows(h: Harness) {
	return h.gateway.registry.peek('default')!.audit.read({ principal: 'e2e', all: true }).entries
		.filter((entry) => entry.kind === 'read-frame-html');
}

Deno.test({
	name: 'e2e frame html: a real <frameset> read frame by frame, and the cross-origin gate',
	ignore,
	async fn(t) {
		// A second site on `localhost` is another site to Chromium: `framesetcross` embeds its content child from it.
		const second = startFixtureSite({ hostname: 'localhost' });
		const site = { frameOrigin: second.url.replace(/\/$/, '') };
		try {
			await t.step('default grant: the shell, each child, the depth-2 frame and truncation; the gate', async () => {
				await using h = await harness({ scopes: DEFAULT_GRANT, site });
				const rows = await frames(h, 'frameset');
				assertEquals(rows.length, 4, 'the DOM capture enumerates <frameset> children');

				const shell = await read(h);
				assertStringIncludes(shell.text, '<frameset');
				assertStringIncludes(shell.text, FRAMESET_TOP_SENTINEL);
				assert(!shell.text.includes(FRAME_SENTINEL), 'the shell carried the content child');
				assertEquals([shell.payload.url, shell.payload.frame_id], [h.site.page('frameset'), rows[0]?.id]);
				assertEquals(shell.payload.audit_id, undefined, 'same-origin: no ledger row');

				const content = frameEndingWith(rows, '/framesetcontent');
				assertEquals([content.name, content.is_oopif], ['content', false]);
				const child = await read(h, content.id);
				assertStringIncludes(child.text, FRAME_SENTINEL);
				assertStringIncludes(child.text, '2823961');
				assert(!child.text.includes(FRAMESET_TOP_SENTINEL) && !child.text.includes('<frameset'), 'shell bytes');
				assertEquals(
					[child.payload.frame_id, child.payload.url, child.payload.truncated, child.payload.media_type],
					[content.id, h.site.page('framesetcontent'), false, 'text/html'],
				);
				assertEquals(child.payload.length, child.payload.returned_length);
				assertEquals(child.payload.audit_id, undefined);

				const menu = await read(h, frameEndingWith(rows, '/framesetmenu').id);
				assertStringIncludes(menu.text, 'Statistics');
				assert(!menu.text.includes(FRAME_SENTINEL) && !menu.text.includes(FRAMESET_TOP_SENTINEL), 'sibling bytes');

				const nested = frameEndingWith(rows, '/framesetnested');
				assertEquals(nested.parent, content.id, 'the leaf hangs off the content child');
				const leaf = await read(h, nested.id);
				assertStringIncludes(leaf.text, FRAME_NESTED_SENTINEL);
				assert(!leaf.text.includes(FRAME_SENTINEL) && !leaf.text.includes(FRAMESET_TOP_SENTINEL), 'parent bytes');
				// `length` is the true size, so a caller can tell a capped document from a small one.
				assertEquals([leaf.payload.truncated, leaf.payload.returned_length], [true, HTML_LIMIT_CHARS]);
				assert(leaf.payload.length > HTML_LIMIT_CHARS, `the fixture must exceed the cap: ${leaf.payload.length}`);
				assertStringIncludes(leaf.text, `[truncated at ${HTML_LIMIT_CHARS} characters]`);

				assertStringIncludes(await refused(h, 'NOTAFRAMEIDATALL0000000000000000'), 'Error: invalid-arguments: ');

				// The cross-site child is refused on this grant, naming no scope and writing no ledger row.
				const cross = await frames(h, 'framesetcross');
				const crossChild = frameEndingWith(cross, '/framesetcontent');
				assertStringIncludes(crossChild.url, 'localhost');
				const text = await refused(h, crossChild.id);
				assertStringIncludes(text, 'Error: scope-required: ');
				assert(!text.includes('evaluate'), `the refusal named the scope: ${text}`);
				assertEquals(readRows(h), [], 'a refusal is not a privileged act');
				await read(h, frameEndingWith(cross, '/framesetmenu').id); // the same-origin sibling stays readable
			});

			await t.step(
				'with `evaluate`: the OOPIF read, child-only and audited; both frame tools; a detached frame',
				async () => {
					await using h = await harness({ scopes: EVALUATE_GRANT, site });
					const cross = frameEndingWith(await frames(h, 'framesetcross'), '/framesetcontent');
					assertEquals(cross.is_oopif, true);
					const child = await read(h, cross.id);
					assertStringIncludes(child.text, FRAME_SENTINEL);
					assert(!child.text.includes(FRAMESET_TOP_SENTINEL), 'the OOPIF read carried the TOP document');
					assert(child.payload.audit_id !== undefined, 'a cross-origin read must be audited');
					// The row records the read and its origin (never the path, where a one-time code lives), not the bytes.
					const rows = readRows(h);
					assertEquals(rows.length, 1);
					assertEquals(
						[rows[0]?.audit_id, rows[0]?.frame_id, rows[0]?.origin, rows[0]?.ok],
						[child.payload.audit_id, cross.id, site.frameOrigin, true],
					);
					assert((rows[0]?.result_bytes ?? 0) > 0);
					assert(!JSON.stringify(rows).includes(FRAME_SENTINEL), 'the document reached the ledger');

					const rows2 = await frames(h, 'frameset');
					const content = frameEndingWith(rows2, '/framesetcontent');
					const evaluated = await h.call('browser_evaluate', {
						frame_id: content.id,
						expression: 'document.querySelector("caption").textContent',
					});
					const value = evaluated.structuredContent as { ok: boolean; value?: unknown; frame_id: string };
					assertEquals([value.ok, value.value, value.frame_id], [true, FRAME_SENTINEL, content.id]);

					const menu = frameEndingWith(rows2, '/framesetmenu');
					await read(h, menu.id);
					await h.call('browser_evaluate', {
						expression: 'document.querySelector(\'frame[name="menu"]\').remove(); 1',
					});
					// No fresh capture: the id is still in this session's state, so the refusal is the detachment's.
					const text = await refused(h, menu.id);
					assertStringIncludes(text, 'Error: invalid-arguments: ');
					assertStringIncludes(text, menu.id);
				},
			);
		} finally {
			await second.close();
		}
	},
});

/**
 * A same-process cross-origin child (same host, another port) once chose the origin it was read as, by redefining
 * `Document.prototype.defaultView`: it could suppress its own `read-frame-html` row or name a foreign origin. The
 * extraction now reads the origin off the resolved document's own non-configurable `location`.
 */
Deno.test({
	name: 'e2e frame html (origin forgery): a same-process CROSS-ORIGIN child cannot choose the origin it is read as',
	ignore,
	async fn(t) {
		const second = startFixtureSite({ hostname: '127.0.0.1' });
		const site = { frameOrigin: second.url.replace(/\/$/, '') };
		const swapTo = (origin: string) =>
			`(() => { try { const real = window; const fake = { location: { origin: ${JSON.stringify(origin)} },` +
			` document: real.document };` +
			` Object.defineProperty(Document.prototype, 'defaultView', { get: () => fake, configurable: true });` +
			` return 'installed; defaultView.location.origin=' + document.defaultView.location.origin +` +
			` ' REAL=' + location.origin; } catch (e) { return 'THREW ' + e.name; } })()`;
		try {
			await t.step('the control: an unscoped principal is refused, because the gate reads the frame tree', async () => {
				await using unscoped = await harness({ scopes: DEFAULT_GRANT, site });
				const child = frameEndingWith(await frames(unscoped, 'framesetcross'), '/framesetcontent');
				assertStringIncludes(await refused(unscoped, child.id), 'Error: scope-required: ');
			});

			await t.step('baseline, then both forgeries: every row names the child’s real origin', async () => {
				await using h = await harness({ scopes: EVALUATE_GRANT, site });
				const child = frameEndingWith(await frames(h, 'framesetcross'), '/framesetcontent');
				const topOrigin = new URL(h.site.url).origin;
				const childOrigin = new URL(child.url).origin;
				assert(childOrigin !== topOrigin, `the child must be cross-origin: ${childOrigin}`);
				assertEquals(child.is_oopif, false, 'the proof needs the same-process path');
				for (const forged of [null, topOrigin, 'https://not-a-real-origin.example']) {
					if (forged !== null) {
						const install = await h.call('browser_evaluate', { expression: swapTo(forged), frame_id: child.id });
						const installed = String((install.structuredContent as { value?: unknown })?.value ?? '');
						// The attack is live in the page, or the rows below would prove nothing.
						assertStringIncludes(installed, `defaultView.location.origin=${forged}`);
						assertStringIncludes(installed, `REAL=${childOrigin}`);
					}
					const result = await read(h, child.id);
					assertStringIncludes(result.text, FRAME_SENTINEL);
					assert(!result.text.includes(FRAMESET_TOP_SENTINEL), 'the read carried the TOP document');
					assert(result.payload.audit_id !== undefined, 'the page suppressed its own ledger row');
					assertEquals(readRows(h).at(-1)?.audit_id, result.payload.audit_id);
				}
				assertEquals(readRows(h).map((row) => row.origin), [childOrigin, childOrigin, childOrigin]);
			});
		} finally {
			await second.close();
		}
	},
});
