/**
 * R10 (multi-node) and R12 (the edge/browser split), with two real gateways.
 *
 * Two nodes share a Deno KV store: one runs in `edge` mode and hosts no
 * browsers at all, the other in `browser` mode and owns the sessions. The
 * assertions are made through the *edge* node's `/mcp`, and verified against
 * the browser node directly — so a pass means a request really crossed a
 * process boundary and drove a Chromium that the node answering could not
 * possibly have launched.
 *
 * Browser tier, and needs `--unstable-kv`; the task grants it.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createLogger, generateApiKey, loadConfig, type RunningGateway, startGateway } from '@tykotech/gateway';
import { announceSkip } from '../support/browser_tier.ts';
import { CHROMIUM, skipUnlessBrowser, textOf } from '../support/harness.ts';
import { type FixtureSite, startFixtureSite } from '../fixtures/site.ts';

const HAS_KV = typeof Deno.openKv === 'function';
const ignore = skipUnlessBrowser('cluster e2e') ||
	(!HAS_KV && announceSkip('cluster e2e', 'Deno KV is unavailable — run with --unstable-kv'));

interface ClusterFixture extends AsyncDisposable {
	readonly edge: RunningGateway;
	readonly browserNode: RunningGateway;
	/** An MCP client talking to the *edge* node. */
	readonly client: Client;
	readonly key: string;
	readonly site: FixtureSite;
}

async function cluster(): Promise<ClusterFixture> {
	const kvDir = join('tests', '.scratch', `kv-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(kvDir, { recursive: true });
	const kvPath = join(kvDir, 'cluster.kv');
	const site = startFixtureSite({});
	// C7 / D-098: `admin` is no longer a default, and `sessionsOn` lists a node's sessions through an admin route.
	const { key, record } = await generateApiKey('cluster', [
		'mcp:invoke',
		'view:watch',
		'view:control',
		'files:read',
		'admin',
	]);
	const keys = JSON.stringify([record]);
	const quiet = createLogger({ level: 'error', write: () => {} });

	// The browser node comes up first and publishes its URL, so the edge node
	// has somewhere to place work the moment it starts.
	const browserNode = await startGateway({
		config: loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: '0',
			TTK_API_KEYS: keys,
			TTK_LOG_LEVEL: 'error',
			TTK_RATE_RPM: '100000',
			TTK_BROWSER_PATH: CHROMIUM ?? '',
			TTK_HEADLESS: 'true',
			TTK_CLUSTER_KV: kvPath,
			TTK_ROLE: 'browser',
			TTK_NODE_ID: 'browser-1',
			// Bound to an ephemeral port, so the URL peers use is only known after
			// listen — which is why this is re-registered below.
			TTK_NODE_URL: 'http://127.0.0.1:1',
		}),
		version: '0.1.0-cluster',
		logger: quiet,
	});

	// Re-open the browser node now its real port is known. Two starts is the
	// price of ephemeral ports in a test; a deployment knows its own URL.
	await browserNode.shutdown();
	await browserNode.finished;
	const realBrowserNode = await startGateway({
		config: loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: String(browserNode.port),
			TTK_API_KEYS: keys,
			TTK_LOG_LEVEL: 'error',
			TTK_RATE_RPM: '100000',
			TTK_BROWSER_PATH: CHROMIUM ?? '',
			TTK_HEADLESS: 'true',
			TTK_CLUSTER_KV: kvPath,
			TTK_ROLE: 'browser',
			TTK_NODE_ID: 'browser-1',
			TTK_NODE_URL: `http://127.0.0.1:${browserNode.port}`,
		}),
		version: '0.1.0-cluster',
		logger: quiet,
	});

	const edge = await startGateway({
		config: loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: '0',
			TTK_API_KEYS: keys,
			TTK_LOG_LEVEL: 'error',
			TTK_RATE_RPM: '100000',
			// Deliberately no TTK_BROWSER_PATH: an edge node must not need one.
			TTK_CLUSTER_KV: kvPath,
			TTK_ROLE: 'edge',
			TTK_NODE_ID: 'edge-1',
		}),
		version: '0.1.0-cluster',
		logger: quiet,
	});

	const client = new Client({ name: 'cluster-e2e', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${edge.url}/mcp`), {
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${key}`);
				return fetch(input, { ...init, headers });
			},
		}),
	);

	return {
		edge,
		browserNode: realBrowserNode,
		client,
		key,
		site,
		async [Symbol.asyncDispose]() {
			await client.close().catch(() => {});
			await edge.shutdown();
			await edge.finished;
			await realBrowserNode.shutdown();
			await realBrowserNode.finished;
			await site.close();
			await Deno.remove(kvDir, { recursive: true }).catch(() => {});
		},
	};
}

function call(c: ClusterFixture, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return c.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
}

async function callJson<T>(c: ClusterFixture, name: string, args: Record<string, unknown> = {}): Promise<T> {
	const result = await call(c, name, args);
	if (result.isError === true) throw new Error(`${name} failed: ${textOf(result)}`);
	return JSON.parse(textOf(result)) as T;
}

Deno.test({
	name: 'e2e R10/R12: an edge node drives a browser it cannot launch',
	ignore,
	async fn(t) {
		await using c = await cluster();

		await t.step('the edge node serves the catalog without any browser', async () => {
			const names = (await c.client.listTools({})).tools.map((tool) => tool.name);
			// Describing the server needs no session, so it is answered locally.
			assert(names.includes('browser_navigate'), `catalog: ${names.join(',')}`);
			assert(names.includes('browser_get_state'));
		});

		await t.step('a first call places the session on the browser node', async () => {
			const navigated = await callJson<{ session_id: string; title: string }>(c, 'browser_navigate', {
				url: c.site.page('index'),
			});
			assertEquals(navigated.session_id, 'default');
			assertEquals(navigated.title, 'TykoTech Fixture Index');

			// The edge node has no sessions of its own; the browser node has one.
			// This is the claim the whole feature rests on, checked from outside.
			const edgeSessions = await sessionsOn(c.edge.url, c.key);
			const browserSessions = await sessionsOn(c.browserNode.url, c.key);
			assertEquals(edgeSessions.length, 0, 'the edge node launched a browser it should not have');
			assertEquals(browserSessions.length, 1, `browser node: ${JSON.stringify(browserSessions)}`);
			assertEquals(browserSessions[0]?.session_id, 'default');
		});

		await t.step('the page really loaded, seen through the edge node', async () => {
			const state = await callJson<{ page: string; title: string }>(c, 'browser_get_state', {});
			// The nonce exists only on the fixture page this run served, so the
			// request crossed to the browser node and came back with real content.
			assertStringIncludes(state.page, c.site.nonce);
			assertEquals(state.title, 'TykoTech Fixture Index');
		});

		await t.step('an interaction forwarded through the edge changes the real page', async () => {
			const state = await callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
				c,
				'browser_get_state',
				{},
			);
			const button = state.interactive_elements.find((element) => element.tag === 'button');
			assert(button !== undefined);
			await call(c, 'browser_click', { index: button.index });

			const html = textOf(await call(c, 'browser_get_html', {}));
			assertStringIncludes(html, `clicked-${c.site.nonce}`);
		});

		await t.step('a downloaded file is fetched through the edge from the node that holds it (E-33)', async () => {
			await callJson(c, 'browser_navigate', { url: c.site.page('downloads') });
			const state = await callJson<{ interactive_elements: Array<{ index: number; tag: string; href?: string }> }>(
				c,
				'browser_get_state',
				{},
			);
			const link = state.interactive_elements.find((e) => e.tag === 'a' && (e.href ?? '').includes('body=first'));
			assert(link !== undefined);
			await call(c, 'browser_click', { index: link.index });

			let files: Array<{ file_id: string; status: string; name: string }> = [];
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				files = (await callJson<{ files: typeof files }>(c, 'browser_list_files', {})).files;
				if (files.length > 0 && files.every((f) => f.status !== 'pending')) break;
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			assertEquals(files.length, 1, JSON.stringify(files));
			const file = files[0] as { file_id: string; status: string; name: string };
			assertEquals(file.status, 'completed');

			// The edge node owns no browser and no files: the bytes came over one hop.
			const response = await fetch(`${c.edge.url}/api/v1/sessions/default/files/${file.file_id}`, {
				headers: { authorization: `Bearer ${c.key}` },
			});
			assertEquals(response.status, 200);
			assertEquals(response.headers.get('x-ttk-served-by'), 'browser-1');
			assertEquals(await response.text(), 'first');

			// The same through the MCP resource, routed by its URI.
			const read = await c.client.readResource({ uri: `ttk://session/default/files/${file.file_id}` });
			const content = read.contents[0] as { blob?: string };
			assertEquals(atob(content.blob ?? ''), 'first');
		});

		await t.step('a second session is placed on a browser node too', async () => {
			const created = await callJson<{ session_id: string; title: string }>(c, 'browser_navigate', {
				url: c.site.page('second'),
				new_session: true,
			});
			assertEquals(created.title, 'Second Page');
			const browserSessions = await sessionsOn(c.browserNode.url, c.key);
			assertEquals(browserSessions.length, 2);
			assertEquals(await sessionsOn(c.edge.url, c.key), []);

			// And it is addressable through the edge by its id.
			const state = await callJson<{ title: string }>(c, 'browser_get_state', {
				session_id: created.session_id,
			});
			assertEquals(state.title, 'Second Page');
		});

		await t.step('browser_list_sessions is answered for the whole cluster', async () => {
			const listed = await callJson<{ sessions: Array<{ session_id: string; node_id?: string }> }>(
				c,
				'browser_list_sessions',
				{},
			);
			assertEquals(listed.sessions.length, 2, JSON.stringify(listed));
			// Each carries the node it lives on, which is what makes the answer
			// actionable rather than merely bigger.
			for (const session of listed.sessions) {
				assertEquals(session.node_id, 'browser-1', JSON.stringify(session));
			}
		});

		await t.step('an unknown session is still an unknown session', async () => {
			const result = await call(c, 'browser_get_state', { session_id: 'not-a-session' });
			assertEquals(result.isError, true);
			assertStringIncludes(textOf(result), 'Error: unknown-session');
		});

		await t.step('closing through the edge really closes the remote browser', async () => {
			await call(c, 'browser_close_session', { session_id: 'default' });
			const remaining = await sessionsOn(c.browserNode.url, c.key);
			assertEquals(remaining.length, 1);
			assert(!remaining.some((s) => s.session_id === 'default'));
		});
	},
});

Deno.test({
	name: 'e2e R12: an edge node refuses to host rather than pretending it cannot',
	ignore,
	async fn() {
		const kvDir = join('tests', '.scratch', `kv-${crypto.randomUUID().slice(0, 8)}`);
		await Deno.mkdir(kvDir, { recursive: true });
		const site = startFixtureSite({});
		const { key, record } = await generateApiKey('lonely-edge');

		// An edge node with *no* browser node in the cluster.
		const edge = await startGateway({
			config: loadConfig({
				TTK_HOST: '127.0.0.1',
				TTK_PORT: '0',
				TTK_API_KEYS: JSON.stringify([record]),
				TTK_LOG_LEVEL: 'error',
				TTK_CLUSTER_KV: join(kvDir, 'lonely.kv'),
				TTK_ROLE: 'edge',
				TTK_NODE_ID: 'edge-alone',
			}),
			version: '0.1.0-cluster',
			logger: createLogger({ level: 'error', write: () => {} }),
		});

		try {
			const response = await fetch(`${edge.url}/mcp`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'browser_navigate', arguments: { url: site.page('index'), new_session: true } },
				}),
			});
			const body = await response.text();
			// It says there is nowhere to put the work, rather than launching a
			// browser it was configured not to have.
			assertStringIncludes(body, 'no node in the cluster can host a browser session');
		} finally {
			await edge.shutdown();
			await edge.finished;
			await site.close();
			await Deno.remove(kvDir, { recursive: true }).catch(() => {});
		}
	},
});

/** The sessions a node holds, asked of that node directly. */
async function sessionsOn(url: string, key: string): Promise<Array<{ session_id: string }>> {
	const response = await fetch(`${url}/api/v1/sessions`, { headers: { authorization: `Bearer ${key}` } });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`listing ${url} answered ${response.status}`);
	}
	return (await response.json()).sessions as Array<{ session_id: string }>;
}
