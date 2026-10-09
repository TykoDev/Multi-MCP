/**
 * B1.12 on a real browser: `browser_download`, and `browser_head`'s fail-closed answer.
 *
 * **U-4 moved.** Until SR-HEAD-REDIRECT (D-042) this file measured what a
 * `browser_head` cost the origin through `Network.loadNetworkResource` —
 * 33 554 432 of 33 554 432 bytes. The tool is now a cookie-less HEAD issued by
 * the server process, and the measurement lives where the request does:
 * `packages/mcp/src/head_test.ts`, whose raw loopback upstream counts the
 * bytes it writes (418 for a 4 MiB resource over four hops). What the browser
 * tier proves here is the other half of the owner decision: on a deployment
 * whose allowlist names only loopback — the shape of every shipped matrix —
 * the tool is **not offered**, and a call answers `feature-unavailable
 * {feature: 'egress'}` rather than reaching anything.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';
import { startFixtureSite } from '../fixtures/site.ts';

const ignore = skipUnlessBrowser('head and download e2e');

/** Resolves an element by its `id` attribute, which only the rich record carries. */
async function elementById(h: Harness, id: string): Promise<{ index: number }> {
	const result = await h.call('browser_get_state', { fields: ['full'], element_limit: 2000 });
	const state = result.structuredContent as unknown as {
		interactive_elements: Array<{ index: number; attrs?: Record<string, string> }>;
	};
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `no element with id ${id}`);
	return found;
}

Deno.test({
	name: 'e2e head: a loopback-only deployment does not offer browser_head, and a call fails closed',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });
		await h.callText('browser_navigate', { url: h.site.page('index') });

		await t.step('the call answers feature-unavailable naming egress, and the origin sees no request', async () => {
			const before = h.site.hits.length;
			const error = await h.callError('browser_head', { url: `${h.site.url}measured` });
			assertStringIncludes(error, 'Error: feature-unavailable:');
			assertStringIncludes(error, 'egress');
			// Not a navigation-blocked and not a browser error: the tool was never
			// run, because this process holds no outbound grant beyond loopback and
			// a loopback literal on the allowlist is not an election of one.
			assertEquals(h.site.hits.length, before, 'a disabled tool still reached a server');
		});

		await t.step(
			'the browser is untouched by it: a human holding the session is irrelevant to the answer',
			async () => {
				const socket = await h.live();
				const meta = await socket.ready();
				socket.send({ type: 'control.take' });
				await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);
				const error = await h.callError('browser_head', { url: `${h.site.url}measured` });
				assertStringIncludes(
					error,
					'feature-unavailable',
					'availability is decided before any lock, since no browser is used',
				);
				await socket.close();
			},
		);
	},
});

Deno.test({
	name: 'e2e download: browser_download names the file it started',
	ignore,
	async fn(t) {
		await using h = await harness({ env: { TTK_ALLOWED_DOMAINS: '127.0.0.1,localhost' } });

		await t.step('clicking a download link returns the file_id it will be readable under', async () => {
			// The downloads fixture sets the cookie its attachment endpoints require,
			// so the download has to start from that page.
			await h.callText('browser_navigate', { url: h.site.page('downloads') });
			const state = await h.call('browser_get_state', { fields: ['full'], element_limit: 500 });
			const elements = (state.structuredContent as unknown as {
				interactive_elements: Array<{ index: number; attrs?: { id?: string } }>;
			})
				.interactive_elements;
			const link = elements.find((element) => element.attrs?.id === 'dl-first');
			assert(link !== undefined, `no #dl-first among ${JSON.stringify(elements.map((e) => e.attrs?.id))}`);

			const result = await h.callJson<{ started: boolean; file: { file_id: string; name: string } | null }>(
				'browser_download',
				{ index: link.index },
			);
			assertEquals(result.started, true);
			assert(result.file !== null);
			assert(result.file.file_id.length > 0);

			// And the id is the one the listing tool uses, which is the whole point:
			// a caller no longer has to diff `browser_list_files` to find its own file.
			const listed = await h.callJson<{ files: Array<{ file_id: string }> }>('browser_list_files', {});
			assert(
				listed.files.some((file) => file.file_id === result.file?.file_id),
				'the id browser_download returned is not one browser_list_files knows',
			);
		});

		await t.step('exactly one of index or url is required', async () => {
			assertStringIncludes(await h.callError('browser_download', {}), 'invalid-arguments');
			assertStringIncludes(
				await h.callError('browser_download', { index: 0, url: h.site.url }),
				'invalid-arguments',
			);
		});

		await t.step('the domain allowlist applies to a download by URL', async () => {
			const error = await h.callError('browser_download', { url: 'https://not-allowed.example/export.csv' });
			assertStringIncludes(error, 'navigation-blocked');
		});
	},
});

/**
 * Owner item 6 — the `TTK_ALLOWED_DOMAINS` bypasses, closed and proven on a
 * real browser. The allowlist names only `127.0.0.1`; a second fixture site on
 * `localhost` — a different host on the same port — is the off-allowlist
 * destination every leg points at.
 */
Deno.test({
	name: 'e2e egress: redirects, the index form, and script-driven downloads are gated on the final URL',
	ignore,
	async fn(t) {
		const alt = startFixtureSite({ hostname: 'localhost' });
		try {
			const altOrigin = alt.url.slice(0, -1);
			await using h = await harness({
				env: { TTK_ALLOWED_DOMAINS: '127.0.0.1' },
				site: { altOrigin },
			});
			const own = h.site.url.slice(0, -1);
			await h.callText('browser_navigate', { url: h.site.page('egress') });

			await t.step('browser_head: not offered here either, and the answer names no URL', async () => {
				// The hop-by-hop gate itself is proven at the unit tier against a
				// raw loopback upstream (head_test.ts); what this deployment proves
				// is that with only `127.0.0.1` allowlisted the tool stays off.
				const refused = await h.callError('browser_head', { url: `${own}/redirect?to=x&secret=SECRET` });
				assert(refused.startsWith('Error: feature-unavailable:'), refused);
				assertEquals(refused.includes('SECRET'), false, 'no query reaches the caller');
			});

			// R3 (D-115, E-94) moved this pin: the redirect hop is refused before its request is sent (E0), so the
			// answer is the same text, and there is no ledger row — nothing reached the network to be cancelled.
			await t.step('browser_download {url}: a redirect off the allowlist is refused before any byte', async () => {
				const to = `${altOrigin}/opendownload?name=via.txt&body=via`;
				const before = alt.hits.length;
				const error = await h.callError('browser_download', { url: `${own}/redirect?to=${encodeURIComponent(to)}` });
				assert(error.startsWith('Error: navigation-blocked:'), error);
				assert(error.includes(altOrigin), error);
				assertEquals(error.includes('opendownload'), false, 'no path of the final URL may be reported');
				assertEquals(alt.hits.length, before, 'the off-allowlist host must see no request at all');
				const files = await h.callJson<{ files: Array<{ name: string; status: string; error?: string }> }>(
					'browser_list_files',
					{},
				);
				assertEquals(
					files.files.find((file) => file.name === 'via.txt'),
					undefined,
					`no ledger row for a download that never started: ${JSON.stringify(files.files)}`,
				);
			});

			await t.step('browser_download {index}: an off-allowlist href is refused before the click', async () => {
				await h.callText('browser_navigate', { url: h.site.page('egress') });
				const link = await elementById(h, 'off-href');
				const before = alt.hits.length;
				const error = await h.callError('browser_download', { index: link.index });
				assert(error.startsWith('Error: navigation-blocked:'), error);
				assertEquals(alt.hits.length, before, 'the off-allowlist host must see no request at all');
			});

			await t.step('browser_download {index}: a relative same-origin href resolves and downloads', async () => {
				const link = await elementById(h, 'rel-href');
				const result = await h.callJson<{ started: boolean; file: { name: string } | null }>(
					'browser_download',
					{ index: link.index },
				);
				assertEquals(result.started, true);
				assertEquals(result.file?.name, 'rel.txt');
			});

			// R3 moved this one as well, for the same reason (a deviation from design §2.5's list, which named only the
			// redirect leg): the script's `location.href` to the off-allowlist host is a document request, refused
			// before it is sent; `browser_download` answers from the E0 block with the ledger's own words.
			await t.step(
				'browser_download {index}: a script-driven download with no href is refused before any byte',
				async () => {
					const button = await elementById(h, 'js-off');
					const before = alt.hits.length;
					const error = await h.callError('browser_download', { index: button.index });
					assert(error.startsWith('Error: navigation-blocked:'), error);
					assert(error.includes(altOrigin), error);
					assertEquals(alt.hits.length, before, 'the off-allowlist host must see no request at all');
					const files = await h.callJson<{ files: Array<{ name: string; status: string; error?: string }> }>(
						'browser_list_files',
						{},
					);
					assertEquals(files.files.find((file) => file.name === 'js.txt'), undefined, JSON.stringify(files.files));
				},
			);
		} finally {
			await alt.close();
		}
	},
});
