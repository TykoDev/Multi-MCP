/**
 * The Workspaces screen's file tree, in the shipped SPA, in a real Chromium.
 *
 * The gateway talks to an in-memory sandbox (the service's own HTTP contract: `/healthz` and `POST /v1/<operation>`
 * with `{ principal, args }`), so the test needs no cages and can assert exactly which listings the page asked for.
 * The SPA signs in with the harness key, opens a workspace, and the test drives the tree the way a person would:
 * the root is listed on open, a folder is listed on its first expand, a click opens a file into the editor, and a
 * file saved under a new folder appears in the tree, selected. No path is ever typed to open a file.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { startFakeSandbox } from '../support/fake_sandbox.ts';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('workspaces e2e');

Deno.test({
	name: 'e2e Workspaces: the file tree lists the sandbox, opens files on a click and follows a save',
	ignore,
	async fn(t) {
		const sandbox = await startFakeSandbox({
			name: 'tree-demo',
			files: {
				'README.md': '# tree demo\n',
				'src/main.py': 'print("hello from the tree")\n',
				'src/pkg/__init__.py': '',
				'src/pkg/util.py': 'def add(a, b):\n    return a + b\n',
				'tests/test_main.py': 'import unittest\n',
			},
		});
		const { files, listed } = sandbox;
		const WORKSPACE_ID = sandbox.workspaceId;
		try {
			await using h = await harness({
				env: { ...sandbox.env, TTK_MAX_SESSIONS: '3' },
				secrets: sandbox.secrets,
				scopes: ['mcp:invoke', 'view:watch', 'view:control', 'admin', 'evaluate', 'sandbox:execute'],
			});
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
			const rows = (): Promise<string[]> =>
				inPage<string>(
					`JSON.stringify([...document.querySelectorAll('.ws-tree .ws-tree-row')].map((r) => r.dataset.path))`,
				).then((text) => JSON.parse(text) as string[]);
			const clickRow = (path: string): Promise<unknown> =>
				inPage(`document.querySelector('.ws-tree-row[data-path="${path}"]').click(); true`);

			await t.step('the SPA signs in with the key', async () => {
				await until(`!!document.querySelector('input')`, 'the connect form');
				const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
					'browser_get_state',
					{ session_id: driver },
				);
				const input = state.interactive_elements.find((element) => element.tag === 'input');
				const button = state.interactive_elements.find((element) => element.tag === 'button');
				assert(input !== undefined && button !== undefined, 'the connect form has an input and a button');
				await h.callText('browser_type', { session_id: driver, index: input.index, text: h.key, clear: true });
				await h.callText('browser_click', { session_id: driver, index: button.index });
				await until(`!location.hash.startsWith('#/connect')`, 'the signed-in app');
			});

			await t.step('opening the workspace lists its root as a tree, folders first', async () => {
				await h.callText('browser_navigate', {
					session_id: driver,
					url: `${h.url}/#/workspaces/${WORKSPACE_ID}`,
				});
				await until(`document.querySelectorAll('.ws-tree .ws-tree-row').length >= 3`, 'the file tree');
				assertEquals(await rows(), ['src', 'tests', 'README.md']);
				assertEquals(await inPage<string>(`document.querySelector('.ws-tree').getAttribute('role')`), 'tree');
				assertEquals(listed, [''], 'only the root was listed');
			});

			await t.step('a folder lists on its first expand, and a click opens a file into the editor', async () => {
				await clickRow('src');
				await until(`!!document.querySelector('.ws-tree-row[data-path="src/main.py"]')`, 'the src folder');
				assertEquals(await rows(), ['src', 'src/pkg', 'src/main.py', 'tests', 'README.md']);
				assertEquals(
					await inPage<string>(
						`document.querySelector('[data-path="src"]').parentElement.getAttribute('aria-expanded')`,
					),
					'true',
				);
				await clickRow('src/pkg');
				await until(`!!document.querySelector('.ws-tree-row[data-path="src/pkg/util.py"]')`, 'the nested folder');
				await clickRow('src/pkg/util.py');
				await until(`document.querySelector('#ws-editor').value.includes('def add')`, 'the opened file');
				assertEquals(await inPage<string>(`document.querySelector('#ws-path').value`), 'src/pkg/util.py');
				assertEquals(
					await inPage<string>(
						`document.querySelector('[data-path="src/pkg/util.py"]').parentElement.getAttribute('aria-selected')`,
					),
					'true',
				);
				assertEquals(listed, ['', 'src', 'src/pkg'], 'one listing per folder opened, none repeated');
			});

			await t.step('a file saved under a new folder appears in the tree, selected', async () => {
				await inPage(`(() => {
					const path = document.querySelector('#ws-path');
					path.value = 'notes/todo.md';
					document.querySelector('#ws-editor').value = '- try the tree\\n';
					return true;
				})()`);
				await inPage(
					`document.querySelector('wa-button[aria-label="Save file"], button[aria-label="Save file"]').click(); true`,
				);
				await until(
					`!!document.querySelector('.ws-tree-row[data-path="notes/todo.md"]')`,
					'the saved file in the tree',
				);
				assertEquals(files.get('notes/todo.md'), '- try the tree\n', 'the sandbox received the write');
				assertEquals(
					await inPage<string>(
						`document.querySelector('[data-path="notes/todo.md"]').parentElement.getAttribute('aria-selected')`,
					),
					'true',
				);
				// Expanded folders stayed open across the refresh.
				assert((await rows()).includes('src/pkg/util.py'));
			});

			await t.step('the keyboard moves through the tree and opens a file', async () => {
				await inPage(`document.querySelector('.ws-tree-row[data-path="README.md"]').focus(); true`);
				const before = await inPage<string>(`document.activeElement.dataset.path`);
				assertEquals(before, 'README.md');
				await inPage(
					`document.querySelector('.ws-tree').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); true`,
				);
				assertEquals(await inPage<string>(`document.activeElement.dataset.path`), 'notes');
				await inPage(
					`document.querySelector('.ws-tree').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); true`,
				);
				await inPage(
					`document.querySelector('.ws-tree').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`,
				);
				await until(`document.querySelector('#ws-editor').value === '# tree demo\\n'`, 'README opened by Enter');
			});

			const evidence = Deno.env.get('TTK_UI_EVIDENCE_DIR');
			if (evidence !== undefined) {
				const shot = await h.call('browser_screenshot', { session_id: driver });
				const image = (shot.content as Array<{ type: string; data?: string }>).find((block) => block.type === 'image');
				if (image?.data !== undefined) {
					await Deno.writeFile(
						join(evidence, 'workspaces-tree.png'),
						Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)),
					);
				}
			}
		} finally {
			await sandbox.close();
		}
	},
});
