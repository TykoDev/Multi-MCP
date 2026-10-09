/**
 * R4 (sessions as MCP resources) and R5 (a tool list that changes with the
 * server's state), against a real browser.
 *
 * Both are claims about what a *client* sees, so both are checked through the
 * SDK client: `resources/list`, `resources/read`, `tools/list`. The bytes a
 * resource read returns are the bytes Chromium produced.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { CAPABILITIES_URI, resourceUri } from '@tykotech/mcp';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('resources e2e');

/**
 * The resources that describe the deployment rather than a session: `ttk://capabilities`, and — since D-150 turned MCP
 * Apps on by default wherever the embed build exists, which the browser tier always builds first — the two `ui://`
 * documents. Present before any browser exists, and after the last one closes.
 */
const DEPLOYMENT_URIS = [CAPABILITIES_URI, 'ui://tykotech/a2ui-surface', 'ui://tykotech/live-view'].sort();

/** The session resources in a listing, sorted — everything but the deployment-scoped ones. */
function sessionUris(resources: ReadonlyArray<{ uri: string }>): string[] {
	return resources.map((resource) => resource.uri).filter((uri) => !DEPLOYMENT_URIS.includes(uri)).sort();
}

/** The deployment-scoped resources in a listing, sorted. */
function deploymentUris(resources: ReadonlyArray<{ uri: string }>): string[] {
	return resources.map((resource) => resource.uri).filter((uri) => DEPLOYMENT_URIS.includes(uri)).sort();
}

Deno.test({
	name: 'e2e R4: a live session is readable as a resource',
	ignore,
	async fn(t) {
		await using h = await harness();

		await t.step('no sessions means no session resources', async () => {
			const listed = await h.client.listResources({});
			// B3.1: `ttk://capabilities` is always listed — it describes the connection,
			// not a session, so it is present before any browser exists and stays after
			// the last one closes. The claim here is about SESSION resources, so it is
			// stated that way rather than as "the list is empty".
			assertEquals(
				sessionUris(listed.resources),
				[],
				`expected no session resources: ${JSON.stringify(listed.resources)}`,
			);
			assertEquals(deploymentUris(listed.resources), DEPLOYMENT_URIS);
			assertEquals(listed.resources.length, DEPLOYMENT_URIS.length);
		});

		await t.step('a session appears with its three resources', async () => {
			await h.callText('browser_navigate', { url: h.site.page('article') });
			const listed = await h.client.listResources({});
			assertEquals(
				sessionUris(listed.resources),
				[
					resourceUri('default', 'page'),
					resourceUri('default', 'screenshot'),
					resourceUri('default', 'state'),
				].sort(),
			);
			// Each is described well enough for a host to render a picker.
			for (const resource of listed.resources) {
				assert(resource.mimeType !== undefined, `${resource.uri} has no mimeType`);
				assert((resource.description ?? '').length > 0, `${resource.uri} has no description`);
			}
		});

		await t.step('reading the state resource returns the live page', async () => {
			const read = await h.client.readResource({ uri: resourceUri('default', 'state') });
			const content = read.contents[0] as { mimeType?: string; text?: string };
			assertEquals(content.mimeType, 'application/json');
			const parsed = JSON.parse(content.text ?? '{}') as { title: string; page: string };
			assertEquals(parsed.title, 'Quarterly Report');
			assertStringIncludes(parsed.page, h.site.nonce);
		});

		await t.step('reading the page resource returns text, not JSON', async () => {
			const read = await h.client.readResource({ uri: resourceUri('default', 'page') });
			const content = read.contents[0] as { mimeType?: string; text?: string };
			assertEquals(content.mimeType, 'text/plain');
			assertStringIncludes(content.text ?? '', 'Acme Corp Q3 Report');
		});

		await t.step('reading the screenshot resource returns real PNG bytes', async () => {
			const read = await h.client.readResource({ uri: resourceUri('default', 'screenshot') });
			const content = read.contents[0] as { mimeType?: string; blob?: string };
			assertEquals(content.mimeType, 'image/png');
			const bytes = Uint8Array.from(atob(content.blob ?? ''), (c) => c.charCodeAt(0));
			assertEquals([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
			assert(bytes.length > 2000, `expected a real image, got ${bytes.length} bytes`);
		});

		await t.step('a resource read reflects the page as it is *now*', async () => {
			await h.callText('browser_navigate', { url: h.site.page('second') });
			const read = await h.client.readResource({ uri: resourceUri('default', 'state') });
			const parsed = JSON.parse((read.contents[0] as { text?: string }).text ?? '{}') as { title: string };
			// Not a cache of the last tool call: a stale screenshot is worse than
			// none, because nobody looking at it can tell.
			assertEquals(parsed.title, 'Second Page');
		});

		await t.step('reading an unknown session fails rather than launching one', async () => {
			const before = (await h.callJson<{ sessions: unknown[] }>('browser_list_sessions', {})).sessions.length;
			const failure = await h.client.readResource({ uri: resourceUri('no-such-session', 'state') })
				.then(() => null, (cause: unknown) => String(cause));
			assert(failure !== null, 'reading a non-existent session must fail');
			const after = (await h.callJson<{ sessions: unknown[] }>('browser_list_sessions', {})).sessions.length;
			assertEquals(after, before, 'a resource read must never create a browser');
		});

		await t.step('an unknown resource kind is refused', async () => {
			const failure = await h.client.readResource({ uri: 'ttk://session/default/nonsense' })
				.then(() => null, (cause: unknown) => String(cause));
			assert(failure !== null, 'an unknown kind must fail');
		});

		await t.step('closing the session withdraws its resources', async () => {
			await h.callText('browser_close_all', {});
			const listed = await h.client.listResources({});
			assertEquals(sessionUris(listed.resources), []);
			// And the deployment's resources survive, because they never described a session.
			assertEquals(deploymentUris(listed.resources), DEPLOYMENT_URIS);
			assertEquals(listed.resources.length, DEPLOYMENT_URIS.length);
		});
	},
});

Deno.test({
	name: 'e2e R5: the tool list follows the takeover lock',
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('index') });

		const namesNow = async (): Promise<string[]> => (await h.client.listTools({})).tools.map((tool) => tool.name);

		await t.step('with the browser free, the mutating tools are offered', async () => {
			const names = await namesNow();
			for (const name of ['browser_click', 'browser_type', 'browser_scroll', 'browser_press_key']) {
				assert(names.includes(name), `${name} should be offered`);
			}
		});

		const socket = await h.live();
		const meta = await socket.ready();

		await t.step('while a human holds the only session, the list does not move (G-2)', async () => {
			socket.send({ type: 'control.take' });
			await socket.waitFor('lock', (message) => message.lock?.holder === meta.viewerId);

			// Before B1.2 these were withdrawn from `tools/list` while every
			// session was held. The lock is per session and the list is per
			// connection, so withdrawing them was a lie about every other session —
			// and in the all-held case it turned a classifiable
			// `Error: human-has-control:` result into a JSON-RPC protocol error,
			// which aborts the model's turn instead of telling it to wait.
			const names = await namesNow();
			for (const name of ['browser_click', 'browser_type', 'browser_scroll', 'browser_press_key']) {
				assert(names.includes(name), `${name} must stay listed and refuse at call time`);
			}
			// Observation stays too, so a model can watch rather than go blind.
			for (const name of ['browser_get_state', 'browser_screenshot', 'browser_get_html']) {
				assert(names.includes(name), `${name} is read-only and must stay`);
			}
			assert(names.includes('browser_navigate'), 'new_session still works under a lock');
		});

		await t.step('a held session refuses a mutating tool with a readable code, not a protocol error', async () => {
			// The all-locked case, which is the half G-2 got wrong: it now answers
			// exactly as the partial-lock case always did.
			const refused = await h.client.callTool({ name: 'browser_click', arguments: { index: 0 } }) as {
				isError?: boolean;
				content?: Array<{ text?: string }>;
				structuredContent?: { error?: { code?: string } };
			};
			assertEquals(refused.isError, true, 'a held session must not run a mutating tool');
			assertStringIncludes(refused.content?.[0]?.text ?? '', 'Error: human-has-control: ');
			assertEquals(refused.structuredContent?.error?.code, 'human-has-control');
		});

		await t.step('releasing lets them succeed again', async () => {
			socket.send({ type: 'control.release' });
			await socket.waitFor('lock', (message) => message.lock === null);
			const names = await namesNow();
			assert(names.includes('browser_click'), 'the list never moved, so it is still there');
		});

		await t.step('a second, free session keeps the tools available', async () => {
			// "Every session is held" is the rule, precisely because the lock is
			// per session and the tool list is not.
			const extra = await h.callJson<{ session_id: string }>('browser_navigate', {
				url: h.site.page('index'),
				new_session: true,
			});
			socket.send({ type: 'control.take' });
			await socket.waitFor('lock', (message) => message.lock !== null);

			const names = await namesNow();
			assert(names.includes('browser_click'), 'one held session out of two must not hide the tools');
			// And it really does still work, on the session nobody holds.
			await h.callText('browser_get_state', { session_id: extra.session_id });
		});

		await socket.close();
	},
});
