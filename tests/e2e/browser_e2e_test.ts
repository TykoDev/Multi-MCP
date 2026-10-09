/**
 * End-to-end against a real Chromium: an MCP client drives an actual browser
 * through the gateway, and a live-view socket streams real screencast frames.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`; skipped when no
 * browser could be resolved.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLogger, decodeFrame, generateApiKey, loadConfig, startGateway } from '@tykotech/gateway';
import type { RunningGateway } from '@tykotech/gateway';
import { CHROMIUM_ENV, readEnv } from '../support/browser_tier.ts';

/** Pinned by the `test:browser` task via `scripts/resolve_chromium.ts --pin`. */
const CHROMIUM = readEnv(CHROMIUM_ENV) ?? readEnv('TTK_BROWSER_PATH') ?? null;
const ignore = CHROMIUM === null || CHROMIUM === '';

/** The page body, carrying a per-run nonce so a pass proves the real chain ran. */
function fixtureHtml(nonce: string): string {
	return `<!doctype html><html><head><title>TykoTech E2E</title></head>
<body>
  <h1 id="heading">nonce ${nonce}</h1>
  <button id="btn" onclick="document.getElementById('out').textContent='clicked-${nonce}'">Press me</button>
  <div id="out">untouched</div>
  <input id="field" placeholder="type here">
</body></html>`;
}

/**
 * Serves the fixture over loopback HTTP.
 *
 * A `data:` URL would be simpler, but the navigation policy refuses every
 * scheme but http/https — correctly, since `data:` is an exfiltration vector —
 * so the fixture needs a real origin.
 */
function fixtureServer(nonce: string): { url: string; close(): Promise<void> } {
	const server = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		() => new Response(fixtureHtml(nonce), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
	);
	const { port } = server.addr as Deno.NetAddr;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: async () => {
			await server.shutdown();
		},
	};
}

interface Harness {
	gateway: RunningGateway;
	client: Client;
	/** The run's credential, used for both MCP calls and ticket minting. */
	key: string;
	[Symbol.asyncDispose](): Promise<void>;
}

async function harness(): Promise<Harness> {
	const { key, record } = await generateApiKey('e2e');
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([record]),
		TTK_LOG_LEVEL: 'error',
		TTK_BROWSER_PATH: CHROMIUM ?? '',
		TTK_HEADLESS: 'true',
	});
	const gateway = await startGateway({
		config,
		version: '0.1.0-e2e',
		logger: createLogger({ level: 'error', write: () => {} }),
	});

	const client = new Client({ name: 'e2e', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${key}`);
				return fetch(input, { ...init, headers });
			},
		}),
	);

	return {
		gateway,
		client,
		key,
		async [Symbol.asyncDispose]() {
			await client.close().catch(() => {});
			await gateway.shutdown();
			await gateway.finished;
		},
	};
}

function textOf(result: { content: unknown }): string {
	return (result.content as Array<{ type: string; text?: string }>)
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('\n');
}

Deno.test({
	name: 'e2e: an MCP client navigates a real browser and reads the page back',
	ignore,
	async fn() {
		await using h = await harness();
		const nonce = crypto.randomUUID().replaceAll('-', '');
		const page = fixtureServer(nonce);

		const navigated = await h.client.callTool({
			name: 'browser_navigate',
			arguments: { url: page.url },
		});
		assert(navigated.isError !== true, `navigate failed: ${textOf(navigated)}`);

		const state = await h.client.callTool({ name: 'browser_get_state', arguments: {} });
		assert(state.isError !== true, `get_state failed: ${textOf(state)}`);
		// The nonce exists only on the page just loaded, so seeing it here proves
		// the whole chain ran: HTTP → auth → tool → CDP → Chromium → DOM pipeline.
		assertStringIncludes(textOf(state), nonce);
		assertStringIncludes(textOf(state), 'TykoTech E2E');
		await page.close();
	},
});

Deno.test({
	name: 'e2e: a screenshot returns real PNG bytes',
	ignore,
	async fn() {
		await using h = await harness();
		const page = fixtureServer('shot');
		await h.client.callTool({ name: 'browser_navigate', arguments: { url: page.url } });

		const shot = await h.client.callTool({ name: 'browser_screenshot', arguments: {} });
		assert(shot.isError !== true, `screenshot failed: ${textOf(shot)}`);
		const image = (shot.content as Array<{ type: string; data?: string; mimeType?: string }>)
			.find((block) => block.type === 'image');
		assert(image !== undefined, 'no image block in the result');
		assertEquals(image.mimeType, 'image/png');
		const bytes = Uint8Array.from(atob(image.data ?? ''), (c) => c.charCodeAt(0));
		// PNG magic number.
		assertEquals([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
		await page.close();
	},
});

Deno.test({
	name: 'e2e: clicking by index changes the live page',
	ignore,
	async fn() {
		await using h = await harness();
		const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
		const page = fixtureServer(nonce);
		await h.client.callTool({ name: 'browser_navigate', arguments: { url: page.url } });

		const state = await h.client.callTool({ name: 'browser_get_state', arguments: {} });
		const parsed = JSON.parse(textOf(state)) as {
			interactive_elements: Array<{ index: number; tag: string }>;
		};
		const button = parsed.interactive_elements.find((element) => element.tag === 'button');
		assert(button !== undefined, `no button among ${JSON.stringify(parsed.interactive_elements)}`);

		const clicked = await h.client.callTool({
			name: 'browser_click',
			arguments: { index: button.index },
		});
		assert(clicked.isError !== true, `click failed: ${textOf(clicked)}`);

		const html = await h.client.callTool({ name: 'browser_get_html', arguments: {} });
		assertStringIncludes(textOf(html), `clicked-${nonce}`);
		await page.close();
	},
});

Deno.test({
	name: 'e2e: the live view streams real screencast frames',
	ignore,
	async fn() {
		await using h = await harness();
		const page = fixtureServer('cast');
		await h.client.callTool({ name: 'browser_navigate', arguments: { url: page.url } });

		const ticket = await ticketFor(h);
		const socket = new WebSocket(
			`${h.gateway.url.replace('http', 'ws')}/live/default/ws?ticket=${ticket}`,
		);
		socket.binaryType = 'arraybuffer';

		const frame = await new Promise<{ w: number; h: number; jpegLength: number }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('no frame within 20s')), 20_000);
			socket.onmessage = (event) => {
				if (typeof event.data === 'string') return; // meta/tabs/lock
				const { meta, jpeg } = decodeFrame(event.data as ArrayBuffer);
				clearTimeout(timer);
				resolve({ w: meta.w, h: meta.h, jpegLength: jpeg.length });
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error('socket error'));
			};
		});

		socket.close();
		assert(frame.jpegLength > 1000, `a real frame should carry bytes, got ${frame.jpegLength}`);
		await page.close();
	},
});

Deno.test({
	name: 'e2e: a human takeover refuses mutating tools but allows observation',
	ignore,
	async fn() {
		await using h = await harness();
		const page = fixtureServer('lock');
		await h.client.callTool({ name: 'browser_navigate', arguments: { url: page.url } });

		const ticket = await ticketFor(h);
		const socket = new WebSocket(`${h.gateway.url.replace('http', 'ws')}/live/default/ws?ticket=${ticket}`);

		// Wait for the lock to be granted, observed through the socket itself.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('no lock within 15s')), 15_000);
			socket.onmessage = (event) => {
				if (typeof event.data !== 'string') return;
				const message = JSON.parse(event.data) as { type: string; lock?: unknown };
				if (message.type === 'meta') socket.send(JSON.stringify({ type: 'control.take' }));
				if (message.type === 'lock' && message.lock !== null) {
					clearTimeout(timer);
					resolve();
				}
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error('socket error'));
			};
		});

		// A mutating tool no longer runs, and since G-2 both of these answer the
		// same way: an error *result* the model can read, never a protocol error.
		const blocked = await h.client.callTool({
			name: 'browser_click',
			arguments: { coordinate_x: 10, coordinate_y: 10 },
		});
		assertEquals(blocked.isError, true, 'clicking must not work under a takeover');
		assertStringIncludes(textOf(blocked), 'Error: human-has-control');

		const navigate = await h.client.callTool({ name: 'browser_navigate', arguments: { url: page.url } });
		assertEquals(navigate.isError, true);
		assertStringIncludes(textOf(navigate), 'Error: human-has-control');

		// ...while observation still works, so the model can watch rather than go blind.
		const observed = await h.client.callTool({ name: 'browser_get_state', arguments: {} });
		assert(observed.isError !== true, 'read-only tools must survive a takeover');

		socket.close();
		await page.close();
	},
});

/** Mints a control-mode live-view ticket through the HTTP API. */
async function ticketFor(h: Harness): Promise<string> {
	// The e2e key carries every scope, so the same credential mints the ticket.
	const response = await fetch(`${h.gateway.url}/api/v1/live/ticket`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${h.key}` },
		body: JSON.stringify({}),
	});
	const body = await response.json();
	assertEquals(response.status, 201, `ticket mint failed: ${JSON.stringify(body)}`);
	return body.ticket as string;
}
