/**
 * Browser outputs on real Chromium (R10, R11; design §2.7–§2.8; AC7, AC9, AC11, AC12, M7): a printed PDF inline and
 * as a session artifact, the artifact read back through `browser_get_file`, copied into the share and fetched
 * through a signed link with no bearer (a v2 link of the full 3600 s life, GET, HEAD and Range — D-140, AC23 — and a
 * 404 once its session has closed); the accessibility tree of a page with typed values; and the page's vitals,
 * read in an isolated world while a human holds the session.
 *
 * The pages are served by this file's own loopback server rather than the shared fixture site: the accessibility
 * case needs a page that does **not** echo what is typed into it (the fixture form does, deliberately, for other
 * suites), and the performance case needs a layout shift on a timer.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { encodeHex } from '@std/encoding/hex';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('media e2e');

const TYPED_PLAIN = 'Typed-Plain-Value-7Qx';
const TYPED_PASSWORD = 'Typed-Password-Value-9Wz';
const SECRET_VALUE = 'Zq8-MEDIA-SECRET-4kT';

/** One page per case; `nonce` proves the bytes came from this run's browser. */
function pages(nonce: string): Record<string, string> {
	const shell = (title: string, body: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
	return {
		'/print': shell('print', `<h1>printable ${nonce}</h1><p>${'paragraph text '.repeat(200)}</p>`),
		// Random pixels do not compress, so the printed PDF is several MiB: over the inline limit, under the cap.
		'/bigprint': shell(
			'big print',
			`<h1>big ${nonce}</h1><canvas id="c" width="1000" height="1000"></canvas><script>
const c=document.getElementById('c').getContext('2d');const img=c.createImageData(1000,1000);
for(let i=0;i<img.data.length;i++)img.data[i]=Math.floor(Math.random()*256);c.putImageData(img,0,0);
</script>`,
		),
		// AC11: an unlabeled field and a password field, and nothing on the page repeats what is typed.
		'/ax': shell(
			'ax',
			`<main><h1>ax ${nonce}</h1><input id="plain"><input id="pw" type="password" name="password">` +
				`<button id="go" type="button">Continue</button></main>`,
		),
		// AC6: a page that DOES repeat the password field into its own text — a configured secret must still not leave.
		'/echo': shell(
			'echo',
			`<main><input id="secret-field" type="password" name="password"><p id="mirror">mirror:</p></main><script>
const f=document.getElementById('secret-field');
f.addEventListener('input',()=>{document.getElementById('mirror').textContent='mirror: '+f.value;});
</script>`,
		),
		// AC12 / M7: a large text paint and a layout shift 300 ms after load.
		'/perf': shell(
			'perf',
			`<div id="top"></div><p style="font-size:64px;height:400px">perf ${nonce}</p>` +
				`<p>${'filler '.repeat(300)}</p><script>setTimeout(()=>{const d=document.createElement('div');` +
				`d.style.height='300px';d.textContent='shift';document.getElementById('top').appendChild(d);},300);</script>`,
		),
	};
}

function mediaSite(): { url: string; nonce: string; close(): Promise<void> } {
	const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
	const body = pages(nonce);
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		const page = body[new URL(request.url).pathname];
		return page === undefined
			? new Response('not found', { status: 404 })
			: new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
	});
	return { url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, nonce, close: () => server.shutdown() };
}

interface FileInfo {
	file_id: string;
	name: string;
	mime_type: string;
	size: number;
	available: boolean;
	sha256: string | null;
}

interface Element {
	index: number;
	attrs?: Record<string, string>;
}

function structuredOf<T>(
	result: { isError?: boolean; structuredContent?: unknown; content?: unknown },
	name: string,
): T {
	assert(result.isError !== true, `${name} failed: ${JSON.stringify(result.content)}`);
	return result.structuredContent as T;
}

function errorText(result: { isError?: boolean; content?: unknown }): string {
	assertEquals(result.isError, true, JSON.stringify(result.content));
	return ((result.content ?? []) as Array<{ text?: string }>)[0]?.text ?? '';
}

async function elementOf(
	h: Awaited<ReturnType<typeof harness>>,
	id: string,
): Promise<{ index: number; state_token: string }> {
	const state = structuredOf<{ interactive_elements: Element[]; state_token: string }>(
		await h.call('browser_get_state', { fields: ['core', 'attrs'] }),
		'browser_get_state',
	);
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in ${JSON.stringify(state.interactive_elements)}`);
	return { index: found.index, state_token: state.state_token };
}

async function indexOf(h: Awaited<ReturnType<typeof harness>>, id: string): Promise<number> {
	return (await elementOf(h, id)).index;
}

/**
 * Closes the browser inside the test and waits for it to exit.
 *
 * The harness's own disposal stops the gateway under a 5 s teardown budget; on the first full run of this tier, under
 * load, a Chromium that had just printed a multi-MiB PDF outlived that budget and the sanitizer reported the child
 * process against this test and the next. Closing here awaits the exit with no budget.
 */
async function closeBrowser(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
	await h.gateway.registry.close('default');
}

Deno.test({
	name: 'e2e media (R10): PDF inline and as an artifact, read back, saved to the share and fetched by signed link',
	ignore,
	async fn(t) {
		const site = mediaSite();
		const data = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'media-e2e-' });
		try {
			await using h = await harness({
				scopes: ['mcp:invoke', 'view:watch', 'view:control', 'admin', 'files:read', 'files:write'],
				env: { TTK_DATA_DIR: data, TTK_SIGNED_LINKS: 'true' },
			});

			await t.step('AC7: a small page prints inline as application/pdf', async () => {
				await h.callText('browser_navigate', { url: `${site.url}/print` });
				const result = await h.call('browser_pdf', {});
				const payload = structuredOf<{ delivery: string; bytes: number }>(result, 'browser_pdf');
				const block = (result.content as Array<{ type: string; resource?: { mimeType?: string; blob?: string } }>)
					.find((entry) => entry.type === 'resource');
				assertEquals(block?.resource?.mimeType, 'application/pdf');
				const bytes = decodeBase64(block?.resource?.blob ?? '');
				assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
				assertEquals(payload.delivery, 'inline');
				assertEquals(payload.bytes, bytes.length);
				assert(bytes.length <= 1024 * 1024);
				console.log(`[AC7] inline PDF: ${bytes.length} bytes`);
			});

			let artifact: FileInfo;
			await t.step(
				'AC7: a PDF over 1 MiB is refused inline and kept as an art- file with delivery "file"',
				async () => {
					await h.callText('browser_navigate', { url: `${site.url}/bigprint` });
					const refused = errorText(await h.call('browser_pdf', {}));
					assertStringIncludes(refused, 'Error: file-unavailable:');
					assertStringIncludes(refused, 'delivery: "file"');
					const kept = structuredOf<{ delivery: string; bytes: number; file: FileInfo }>(
						await h.call('browser_pdf', { delivery: 'file' }),
						'browser_pdf',
					);
					artifact = kept.file;
					assert(artifact.file_id.startsWith('art-'), artifact.file_id);
					assertEquals([artifact.mime_type, artifact.available], ['application/pdf', true]);
					assert(artifact.size > 1024 * 1024, `the big print is ${artifact.size} bytes`);
					console.log(`[AC7] artifact PDF: ${artifact.size} bytes, ${artifact.file_id}`);
					const listing = structuredOf<{ files: FileInfo[] }>(await h.call('browser_list_files', {}), 'list');
					const listed = listing.files.find((file) => file.file_id === artifact.file_id);
					assertEquals(listed?.sha256, artifact.sha256, 'listed by browser_list_files with its digest');
				},
			);

			await t.step('AC7: the artifact is readable through browser_get_file and its authenticated route', async () => {
				const link = structuredOf<{ http_url: string }>(
					await h.call('browser_get_file', { file_id: artifact.file_id, delivery: 'link' }),
					'browser_get_file',
				);
				const path = new URL(link.http_url).pathname;
				const response = await h.fetch(path);
				assertEquals(response.status, 200);
				const bytes = new Uint8Array(await response.arrayBuffer());
				assertEquals(bytes.length, artifact.size);
				assertEquals(encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))), artifact.sha256);
				// A small artifact comes back inline, through the same tool.
				await h.callText('browser_navigate', { url: `${site.url}/print` });
				const small = structuredOf<{ file: FileInfo }>(await h.call('browser_pdf', { delivery: 'file' }), 'pdf').file;
				const inline = await h.call('browser_get_file', { file_id: small.file_id });
				const blob = (inline.content as Array<{ type: string; resource?: { blob?: string } }>)
					.find((entry) => entry.type === 'resource')?.resource?.blob ?? '';
				assertEquals(new TextDecoder().decode(decodeBase64(blob).slice(0, 5)), '%PDF-');
			});

			await t.step('AC8: browser_save_to_share copies the artifact into the share with the right SHA-256', async () => {
				const saved = structuredOf<{ result: { path: string; size: number; sha256: string } }>(
					await h.call('browser_save_to_share', { file_id: artifact.file_id, path: 'prints/big.pdf' }),
					'browser_save_to_share',
				).result;
				assertEquals(saved, { path: 'prints/big.pdf', size: artifact.size, sha256: artifact.sha256! });
				const again = errorText(
					await h.call('browser_save_to_share', { file_id: artifact.file_id, path: 'prints/big.pdf' }),
				);
				assertStringIncludes(again, 'Error: invalid-arguments:');
			});

			let linkTarget = '';
			await t.step(
				'AC9 / AC23: browser_file_link downloads the artifact with no bearer, GET, HEAD and Range',
				async () => {
					const minted = structuredOf<{ url: string; ttl_seconds: number; expires_at: string }>(
						await h.call('browser_file_link', { file_id: artifact.file_id }),
						'browser_file_link',
					);
					// G5 (D-140): the deployment default is 3600 s.
					assertEquals(minted.ttl_seconds, 3600);
					// AC23: the full hour asked for explicitly is granted too, and the token is v2.
					const hour = structuredOf<{ url: string; ttl_seconds: number }>(
						await h.call('browser_file_link', { file_id: artifact.file_id, ttl_seconds: 3600 }),
						'browser_file_link',
					);
					assertEquals(hour.ttl_seconds, 3600);
					assert(new URL(hour.url).searchParams.get('t')?.startsWith('v2.'), 'a v2 token');
					const url = new URL(hour.url);
					const target = `${h.url}${url.pathname}${url.search}`;
					linkTarget = target;
					const response = await fetch(target);
					assertEquals(response.status, 200);
					assertEquals(response.headers.get('referrer-policy'), 'no-referrer');
					assertEquals(response.headers.get('cache-control'), 'no-store');
					const bytes = new Uint8Array(await response.arrayBuffer());
					assertEquals(encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))), artifact.sha256);
					const head = await fetch(target, { method: 'HEAD' });
					assertEquals(head.status, 200);
					assertEquals(head.headers.get('content-length'), String(artifact.size));
					await head.body?.cancel();
					// AC23: a Range request on the same link is a 206 of exactly those bytes.
					const ranged = await fetch(target, { headers: { range: 'bytes=0-4' } });
					assertEquals(ranged.status, 206);
					assertEquals(ranged.headers.get('content-range'), `bytes 0-4/${artifact.size}`);
					assertEquals(new TextDecoder().decode(await ranged.arrayBuffer()), '%PDF-');
					// Tampering with one character of the token is a bare 401 — including the MAC's last character, whose
					// two unused bits once let a flipped low bit verify (the signer now accepts one spelling only).
					const flip = (text: string, at: number) =>
						`${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`;
					const lastBitFlip = (text: string) => {
						const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
						return `${text.slice(0, -1)}${alphabet[alphabet.indexOf(text.at(-1)!) ^ 1]}`;
					};
					for (const tampered of [flip(target, target.length - 5), lastBitFlip(target)]) {
						const refused = await fetch(tampered);
						assertEquals(refused.status, 401, tampered.slice(-12));
						await refused.body?.cancel();
					}
				},
			);

			await closeBrowser(h);

			await t.step('D-140: once its session has closed, the link is a 404 — inside its hour', async () => {
				const closed = await fetch(linkTarget);
				assertEquals(closed.status, 404);
				assertEquals(closed.headers.get('cache-control'), 'no-store');
				await closed.body?.cancel();
			});
		} finally {
			await site.close();
			await Deno.remove(data, { recursive: true }).catch(() => {});
		}
	},
});

Deno.test({
	name: 'e2e media (R11): the accessibility tree carries no typed value, and a configured secret is redacted',
	ignore,
	async fn(t) {
		const site = mediaSite();
		try {
			await using h = await harness({
				env: {
					TTK_SECRETS: JSON.stringify({ media_password: { value: SECRET_VALUE, domains: ['http://127.0.0.1'] } }),
				},
			});

			await t.step('AC11: a filled unlabeled input and a password field: neither value, no value key', async () => {
				await h.callText('browser_navigate', { url: `${site.url}/ax` });
				await h.callText('browser_type', { index: await indexOf(h, 'plain'), text: TYPED_PLAIN });
				await h.callText('browser_type', { index: await indexOf(h, 'pw'), text: TYPED_PASSWORD });
				// The page really holds both values: the snapshot's silence is not an empty field.
				const result = await h.call('browser_accessibility_snapshot', {});
				const snapshot = structuredOf<{ outline: string; nodes_total: number; truncated: boolean; tree: unknown }>(
					result,
					'browser_accessibility_snapshot',
				);
				const everything = JSON.stringify(result);
				console.log(`[AC11] outline:\n${snapshot.outline}`);
				for (const typed of [TYPED_PLAIN, TYPED_PASSWORD]) {
					assert(!everything.includes(typed), `${typed} left the server`);
				}
				assert(!everything.includes('"value"'), 'no node carries a value key');
				// The page itself is there: the run's nonce in the heading, both fields, the button.
				assertStringIncludes(snapshot.outline, `heading "ax ${site.nonce}"`);
				assertEquals(snapshot.outline.split('\n').filter((line) => line.trim().startsWith('- textbox')).length, 2);
				assertStringIncludes(snapshot.outline, 'button "Continue"');
				assertEquals(snapshot.truncated, false);

				const cut = structuredOf<{ nodes_total: number; truncated: boolean; outline: string }>(
					await h.call('browser_accessibility_snapshot', { max_nodes: 2 }),
					'browser_accessibility_snapshot',
				);
				assertEquals(cut.truncated, true);
				assertEquals(cut.nodes_total, snapshot.nodes_total);
				assertEquals(cut.outline.split('\n').length, 2);
			});

			await t.step('AC11: index reads one element of the held table', async () => {
				const index = await indexOf(h, 'go');
				const one = structuredOf<{ tree: { role: string; name: string; index?: number } }>(
					await h.call('browser_accessibility_snapshot', { index }),
					'browser_accessibility_snapshot',
				);
				assertEquals([one.tree.role, one.tree.name, one.tree.index], ['button', 'Continue', index]);
			});

			await t.step('AC6: a configured secret typed into a page that repeats it is redacted in the tree', async () => {
				await h.callText('browser_navigate', { url: `${site.url}/echo` });
				const field = await elementOf(h, 'secret-field');
				const filled = await h.call('browser_fill_secret', { ...field, secret: 'media_password' });
				assertEquals(filled.isError, undefined, JSON.stringify(filled.content));
				const result = await h.call('browser_accessibility_snapshot', {});
				const everything = JSON.stringify(result);
				assert(!everything.includes(SECRET_VALUE), 'the configured secret must not leave');
				// The page did repeat it: what reached the tree is the redaction, not an empty mirror.
				assertStringIncludes(everything, 'mirror: [secret]');
			});

			await closeBrowser(h);
		} finally {
			await site.close();
		}
	},
});

Deno.test({
	name: 'e2e media (R11, M7): vitals in an isolated world and runtime metrics, while a human holds the session',
	ignore,
	async fn(t) {
		const site = mediaSite();
		try {
			await using h = await harness();
			await t.step('AC12: both groups, read while the lock is held', async () => {
				await h.callText('browser_navigate', { url: `${site.url}/perf` });
				// Long enough for the 300 ms shift and the paints to be in the browser's buffers.
				await new Promise((resolve) => setTimeout(resolve, 1200));
				const record = h.gateway.registry.peek('default');
				assert(record !== undefined);
				record.lock = { holder: 'viewer-e2e', principal: 'human', takenAt: Date.now(), holderName: null };
				try {
					// A mutating tool is refused, which is what makes the read below a test of the read.
					assertStringIncludes(errorText(await h.call('browser_scroll', { direction: 'down' })), 'human-has-control');
					const perf = structuredOf<{
						origin: string;
						vitals_world: string | null;
						vitals: Record<string, number | null>;
						runtime: Record<string, number | null>;
					}>(await h.call('browser_performance', {}), 'browser_performance');
					console.log(`[AC12/M7] ${JSON.stringify(perf)}`);
					assertEquals(perf.origin, site.url);
					// M7, as a standing check: buffered paint, LCP and layout-shift entries reach the isolated world.
					assertEquals(perf.vitals_world, 'isolated');
					for (const key of ['ttfb_ms', 'dcl_ms', 'load_ms', 'fcp_ms', 'lcp_ms']) {
						assert(typeof perf.vitals[key] === 'number', `${key} resolved in the isolated world`);
					}
					assert((perf.vitals.cls ?? 0) > 0, `the 300 ms shift is counted: cls=${perf.vitals.cls}`);
					assert((perf.runtime.nodes ?? 0) > 0 && (perf.runtime.js_heap_used_bytes ?? 0) > 0);
					assert(typeof perf.runtime.layout_count === 'number');
					// E-97: the counters count from the first call. Make the page lay out once more, and the second
					// call sees it — under the design's enable/get/disable sequence this stayed 0.
					const session = record.session;
					const page = await session.sessionManager!.getOrCreateCdpSession(session.agentFocusTargetId!, true);
					await session.cdpClient!.send.Runtime.evaluate({
						expression: "document.body.appendChild(document.createElement('div')).style.height = '50px'; " +
							'document.body.offsetHeight',
						returnByValue: true,
					}, page.sessionId);
					const again = structuredOf<{ runtime: Record<string, number> }>(
						await h.call('browser_performance', { metrics: ['runtime'] }),
						'browser_performance',
					);
					console.log(`[E-97] second call: ${JSON.stringify(again.runtime)}`);
					assert((again.runtime.layout_count ?? 0) > 0, `a forced layout is counted: ${JSON.stringify(again.runtime)}`);
				} finally {
					record.lock = null;
				}
			});

			await closeBrowser(h);
		} finally {
			await site.close();
		}
	},
});
