/**
 * R3: persistent named profiles and saved storage state.
 *
 * The assertion that matters is that state survives a *browser restart*, so
 * every case here closes the session — which really kills Chromium — and
 * launches a new one. Nothing is faked: the cookie is written by the page, the
 * profile directory is a real Chromium user-data directory on disk, and the
 * storage-state document is written by the vendored watchdog.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('persistence e2e');

/** Fails when `path` exists — the assertion a traversal test actually needs. */
async function assertMissing(path: string): Promise<void> {
	try {
		await Deno.stat(path);
	} catch {
		return;
	}
	throw new Error(`${path} exists; a profile name escaped its directory`);
}

/** A fresh data root under the scratch directory, removed afterwards. */
async function dataDir(name: string): Promise<{ path: string; [Symbol.asyncDispose](): Promise<void> }> {
	const path = join('tests', '.scratch', `data-${name}-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(path, { recursive: true });
	return {
		path,
		async [Symbol.asyncDispose]() {
			await Deno.remove(path, { recursive: true }).catch(() => {});
		},
	};
}

Deno.test({
	name: 'e2e R3: a named profile keeps cookies across a browser restart',
	ignore,
	async fn(t) {
		await using data = await dataDir('profile');
		await using h = await harness({ env: { TTK_DATA_DIR: data.path } });

		let firstSession = '';
		await t.step('a profiled session writes state the page sets', async () => {
			const created = await h.callJson<{ session_id: string; profile: string }>('browser_navigate', {
				url: h.site.page('setcookie'),
				new_session: true,
				profile: 'work',
			});
			firstSession = created.session_id;
			assertEquals(created.profile, 'work');
			assertStringIncludes(
				await h.callText('browser_get_html', { session_id: firstSession }),
				`set-${h.site.nonce}`,
			);
			// The profile directory really exists on disk.
			const stat = await Deno.stat(join(data.path, 'profiles', 'work'));
			assert(stat.isDirectory, 'the profile directory was not created');
		});

		await t.step('the profile is reported in the session listing', async () => {
			const listed = await h.callJson<{ sessions: Array<{ session_id: string; profile?: string }> }>(
				'browser_list_sessions',
				{},
			);
			assertEquals(listed.sessions.find((s) => s.session_id === firstSession)?.profile, 'work');
		});

		await t.step('one profile cannot back two live sessions at once', async () => {
			const error = await h.callError('browser_navigate', {
				url: h.site.page('index'),
				new_session: true,
				profile: 'work',
			});
			// Chromium locks a user-data directory; a second launch would look like
			// a browser crash, so it is refused with a reason instead.
			assertStringIncludes(error, 'already open as session');
		});

		await t.step('after killing the browser, a new session on the profile still has the cookie', async () => {
			await h.callText('browser_close_session', { session_id: firstSession });

			const reopened = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('showcookie'),
				new_session: true,
				profile: 'work',
			});
			assert(reopened.session_id !== firstSession, 'a new session id is expected');
			const html = await h.callText('browser_get_html', { session_id: reopened.session_id });
			// Written by the previous, now-dead browser.
			assertStringIncludes(html, `ttk=${h.site.nonce}`);
			assertStringIncludes(html, `<div id="local">${h.site.nonce}</div>`);
		});

		await t.step('a different profile starts clean', async () => {
			const other = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('showcookie'),
				new_session: true,
				profile: 'other',
			});
			const html = await h.callText('browser_get_html', { session_id: other.session_id });
			assertStringIncludes(html, '<div id="cookie">none</div>');
			assertStringIncludes(html, '<div id="local">none</div>');
		});

		await t.step('a profile name cannot escape the data directory', async () => {
			// Constrained rather than rejected: the name is reduced to one safe path
			// segment, so the traversal simply cannot be expressed.
			const created = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('index'),
				new_session: true,
				profile: '../../etc',
			});
			for await (const entry of Deno.readDir(join(data.path, 'profiles'))) {
				assert(!entry.name.includes('.'), `a profile directory escaped: ${entry.name}`);
				assert(!/[/\\]/.test(entry.name), entry.name);
			}
			// Nothing was created outside the data root.
			await assertMissing(join(data.path, '..', '..', 'etc'));
			await h.callText('browser_close_session', { session_id: created.session_id });
		});
	},
});

Deno.test({
	name: 'e2e R3: storage state moves between sessions by name, never through the model',
	ignore,
	async fn(t) {
		await using data = await dataDir('storage');
		await using h = await harness({ env: { TTK_DATA_DIR: data.path } });

		await t.step('saving reports counts and writes a document', async () => {
			await h.callText('browser_navigate', { url: h.site.page('setcookie') });
			const saved = await h.callJson<{ action: string; name: string; cookies: number }>(
				'browser_storage_state',
				{ action: 'save', name: 'session-one' },
			);
			assertEquals(saved.action, 'save');
			assert(saved.cookies >= 1, `expected at least the fixture cookie, got ${saved.cookies}`);

			// The document exists, and it really contains the cookie...
			const raw = await Deno.readTextFile(join(data.path, 'storage', 'session-one.json'));
			assertStringIncludes(raw, h.site.nonce);
			// ...but the tool result did not.
			assertEquals(JSON.stringify(saved).includes(h.site.nonce), false);
		});

		await t.step('loading it into a different browser restores the cookie', async () => {
			const fresh = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('showcookie'),
				new_session: true,
			});
			// A brand-new ephemeral browser starts with nothing.
			assertStringIncludes(
				await h.callText('browser_get_html', { session_id: fresh.session_id }),
				'<div id="cookie">none</div>',
			);

			const loaded = await h.callJson<{ cookies: number }>('browser_storage_state', {
				action: 'load',
				name: 'session-one',
				session_id: fresh.session_id,
			});
			assert(loaded.cookies >= 1);

			// Re-navigate so the page reads the now-restored cookie jar.
			await h.callText('browser_navigate', {
				url: h.site.page('showcookie'),
				session_id: fresh.session_id,
			});
			assertStringIncludes(
				await h.callText('browser_get_html', { session_id: fresh.session_id }),
				`ttk=${h.site.nonce}`,
			);
			await h.callText('browser_close_session', { session_id: fresh.session_id });
		});

		await t.step('loading an unknown name is refused', async () => {
			assertStringIncludes(
				await h.callError('browser_storage_state', { action: 'load', name: 'never-saved' }),
				'no saved storage state named never-saved',
			);
		});
	},
});

Deno.test({
	name: 'e2e R3: persistence is refused, not faked, without a data directory',
	ignore,
	async fn() {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });

		const profileError = await h.callError('browser_navigate', {
			url: h.site.page('index'),
			new_session: true,
			profile: 'work',
		});
		assertStringIncludes(profileError, 'TTK_DATA_DIR');

		// R5 withdraws the persistence tool entirely when there is nowhere to
		// persist to, which is a better answer than offering it and failing: the
		// absence is visible in `tools/list` before anything is attempted.
		const names = (await h.client.listTools({})).tools.map((tool) => tool.name);
		assert(!names.includes('browser_storage_state'), 'a tool with no data directory must not be advertised');
	},
});
