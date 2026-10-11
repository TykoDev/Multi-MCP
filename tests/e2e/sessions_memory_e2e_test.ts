/**
 * Sessions › Sessions: memory per browser session against the limits, Active and Idle, and Close — in the shipped SPA,
 * against real Chromium processes, so the memory dump is Chromium's own answer for the browser this harness launched.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { harness, imageOf, skipUnlessBrowser } from '../support/harness.ts';

Deno.test({
	name: 'e2e Sessions: each browser’s memory is measured and shown against the limits; a session closes from its card',
	ignore: skipUnlessBrowser('sessions memory e2e'),
	async fn(t) {
		await using h = await harness({
			env: { TTK_MAX_SESSIONS: '4', TTK_MEMORY_LIMIT: '1536m' },
			scopes: ['mcp:invoke', 'view:watch', 'view:control', 'admin', 'evaluate'],
		});
		const watched = (await h.callJson<{ session_id: string }>('browser_navigate', {
			url: h.site.page('index'),
			new_session: true,
		})).session_id;
		const driver = (await h.callJson<{ session_id: string }>('browser_navigate', {
			url: `${h.url}/`,
			new_session: true,
		})).session_id;
		const inPage = async <T>(expression: string): Promise<T> => {
			const result = await h.call('browser_evaluate', { session_id: driver, expression });
			const payload = result.structuredContent as { ok?: boolean; value?: unknown } | undefined;
			assert(payload?.ok === true, `evaluation failed: ${JSON.stringify(result)}`);
			return payload.value as T;
		};
		const until = async (expression: string, what: string): Promise<void> => {
			const deadline = Date.now() + 25_000;
			while (Date.now() < deadline) {
				if ((await inPage<unknown>(expression)) === true) return;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			throw new Error(`the SPA never showed ${what} (${expression})`);
		};

		await t.step('the memory route measures each browser process tree and the gateway heap', async () => {
			const answer = await (await h.fetch('/api/v1/system/usage')).json();
			assertEquals(answer.measured, true);
			assertEquals(answer.limits.max_sessions, 4);
			const mine =
				(answer.sessions as Array<{ session_id: string; memory: { private_bytes: number; processes: number } | null }>)
					.find((entry) => entry.session_id === watched);
			assert(mine?.memory !== null && mine?.memory !== undefined, 'the launched browser answers a memory dump');
			assert(mine.memory.processes >= 2, `a browser, its zygote and renderers (${mine.memory.processes})`);
			assert(mine.memory.private_bytes > 10 * 1024 * 1024, `${mine.memory.private_bytes} bytes private`);
			assert(answer.gateway.heap_limit_bytes > answer.gateway.heap_used_bytes);
			assertEquals(answer.container.limit_bytes, 1536 * 1024 * 1024);
			assertEquals((await h.fetch('/api/v1/system/usage', { headers: { authorization: 'Bearer nope' } })).status, 401);
		});

		await t.step('the Sessions tab shows the meters and the sessions as Active, each with its memory', async () => {
			await until(`!!document.querySelector('input')`, 'the connect form');
			await inPage(`(() => { const i = document.querySelector('input'); i.value = ${JSON.stringify(h.key)};
				i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('button').click(); return true; })()`);
			await until(`location.hash === '#/sessions'`, 'the sessions screen');
			await until(`document.querySelectorAll('.sc-mem .sc-meter').length === 3`, 'the three meters');
			await until(
				`document.querySelectorAll('.sc-group')[0]?.querySelectorAll('.sc-card').length >= 2 &&
					[...document.querySelectorAll('.sc-mem-figure')].some((n) => /MB/.test(n.textContent))`,
				'the active sessions with their memory',
			);
			const groups = await inPage<string>(
				`JSON.stringify([...document.querySelectorAll('.sc-group')].map((g) => [g.querySelector('.sc-group-title').textContent, g.querySelectorAll('.sc-card').length]))`,
			);
			assertEquals(JSON.parse(groups)[0][0], 'Active');
			assertEquals(JSON.parse(groups)[1][0], 'Idle');
			const shot = imageOf(await h.call('browser_screenshot', { session_id: driver }));
			assert(shot);
			await Deno.mkdir('tests/.scratch', { recursive: true });
			await Deno.writeFile('tests/.scratch/sessions-memory.png', shot.bytes);
		});

		await t.step('Close on a card closes that session, after a confirmation', async () => {
			await inPage(
				`document.querySelector('[data-session="${watched}"]').closest('.sc-card').querySelector('.sc-close').click(); true`,
			);
			// The confirmation popover beside the button: Close happens only on its Confirm.
			await until(
				`!!document.querySelector('wa-popover.ttk-confirm[open] .confirm-actions .wa-danger')`,
				'the confirmation',
			);
			await inPage(`document.querySelector('wa-popover.ttk-confirm[open] .confirm-actions .wa-danger').click(); true`);
			const deadline = Date.now() + 15_000;
			let open = true;
			while (Date.now() < deadline && open) {
				const listed = await (await h.fetch('/api/v1/sessions')).json();
				open = (listed.sessions as Array<{ session_id: string }>).some((s) => s.session_id === watched);
				if (open) await new Promise((resolve) => setTimeout(resolve, 300));
			}
			assertEquals(open, false, 'the session is closed');
		});
	},
});
