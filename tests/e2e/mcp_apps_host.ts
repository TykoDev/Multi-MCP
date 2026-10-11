/**
 * @module
 * An MCP Apps host, emulated for the browser tier (R9, design §5, AC39).
 *
 * Two loopback listeners stand in for a real host's two origins:
 *
 * - **the host page** (`http://127.0.0.1:<p>`) — frames the embed in a sandboxed cross-origin iframe
 *   (`allow-scripts allow-same-origin`, as SEP-1865 requires) and plays the host side of the bridge: it answers
 *   `ui/initialize` with a host context (theme from `?theme=`), relays the tool result the test hands it
 *   (`window.__deliver`), proxies the embed's `tools/call` to the gateway over its own MCP connection — a 2025-era
 *   stateless POST with the harness bearer, the shape a 2025 host sends — refuses a call to a tool whose
 *   `_meta.ui.visibility` lacks `app`, records `ui/open-link`, sends `ui/resource-teardown` on request
 *   (`window.__teardown`) and sizes the frame from `size-changed`;
 * - **the sandbox origin** (`http://localhost:<q>`) — serves the `ui://` document exactly as the gateway's
 *   `resources/read` returned it, under the CSP a host derives from the resource's `_meta.ui.csp` (the spec's host
 *   template with our `connectDomains`), so both policies apply at once as they would in a real host. A second
 *   sandbox listener (`http://localhost:<r>`) serves the same documents from an origin `TTK_ALLOWED_ORIGINS` admits
 *   (by hostname) but `TTK_MCP_APPS_ORIGINS` does not list, for the origin-refused state. Both sandbox origins are
 *   another site than the host page, so Chromium puts each frame in its own process, as a real host's would be.
 *
 * `/probe` on the host listener counts hits, for the CSP's positive control: a request the embed's policy refuses
 * must never arrive here. Test scaffolding only — no credential is ever shown to the page: the bearer stays in this
 * process and the frame only ever sees tool results.
 */
import type { Client } from '@modelcontextprotocol/client';

export type EmbedKind = 'live' | 'a2ui' | 'terminal';

const VIEW_URIS: Readonly<Record<EmbedKind, string>> = {
	live: 'ui://tykotech/live-view',
	a2ui: 'ui://tykotech/a2ui-surface',
	terminal: 'ui://tykotech/terminal',
};

export interface AppsHost extends AsyncDisposable {
	/** The host page's origin. */
	readonly hostOrigin: string;
	/** The sandbox origin the deployment lists in `TTK_MCP_APPS_ORIGINS`. */
	readonly sandboxOrigin: string;
	/** A second sandbox origin, same documents, that the deployment does not list. */
	readonly unlistedOrigin: string;
	/** The host page for one embed. */
	pageUrl(kind: EmbedKind, options?: { theme?: 'light' | 'dark'; unlisted?: boolean }): string;
	/** Where the sandbox serves one embed document. */
	viewUrl(kind: EmbedKind, unlisted?: boolean): string;
	/** Reads both documents and the tool visibility from the gateway; the host then proxies through it. */
	attach(gateway: { url: string; key: string; client: Client }): Promise<void>;
	/** Every tool the host relayed for the embed, by name. */
	readonly relayed: string[];
	/** Tools the host refused because they are not visible to apps. */
	readonly refused: string[];
	/** How many requests reached `/probe`. */
	readonly probeHits: number;
}

/** The spec's host template (SEP-1865), filled from a resource's `_meta.ui.csp`. */
function hostCsp(connectDomains: readonly string[]): string {
	return [
		"default-src 'none'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		`connect-src 'self' ${connectDomains.join(' ')}`.trim(),
		"img-src 'self' data:",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'self'",
	].join('; ');
}

function hostPage(sandboxOrigin: string, unlistedOrigin: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MCP Apps host (test)</title>
<style>
	body { margin: 0; padding: 16px; font: 13px system-ui, sans-serif; }
	body.dark { background: #0b0c10; color: #e8e8ea; }
	body.light { background: #fafafa; color: #1b1d26; }
	iframe { display: block; width: 100%; height: 420px; border: 0; }
</style></head>
<body><script>
	const q = new URLSearchParams(location.search);
	const kind = q.get('kind') || 'live';
	const theme = q.get('theme') === 'light' ? 'light' : 'dark';
	document.body.className = theme;
	const origin = q.get('unlisted') === '1' ? ${JSON.stringify(unlistedOrigin)} : ${JSON.stringify(sandboxOrigin)};
	const frame = document.createElement('iframe');
	frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
	frame.title = 'MCP App';
	frame.src = origin + '/view/' + kind;
	document.body.append(frame);
	const host = window.__host = { ready: false, inits: 0, toolResult: null, links: [], sizes: [], teardowns: 0 };
	const pending = new Map();
	let next = 0;
	const send = (message) => frame.contentWindow.postMessage(message, origin);
	const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
	const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
	const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
	window.addEventListener('message', async (event) => {
		if (event.source !== frame.contentWindow) return;
		const m = event.data;
		if (!m || m.jsonrpc !== '2.0') return;
		if (m.method === undefined) {
			const settle = pending.get(m.id);
			if (settle) { pending.delete(m.id); settle(m); }
			return;
		}
		switch (m.method) {
			case 'ui/initialize':
				host.inits += 1;
				host.ready = false;
				reply(m.id, {
					protocolVersion: '2026-01-26',
					hostInfo: { name: 'ttk-e2e-host', version: '1' },
					hostCapabilities: { openLinks: {}, serverTools: {} },
					hostContext: { theme, displayMode: 'inline' },
				});
				return;
			case 'ui/notifications/initialized':
				host.ready = true;
				if (host.toolResult) notify('ui/notifications/tool-result', host.toolResult);
				return;
			case 'ui/notifications/size-changed':
				host.sizes.push(m.params);
				if (m.params && m.params.height > 0) frame.style.height = m.params.height + 'px';
				return;
			case 'tools/call': {
				const response = await fetch('/call', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(m.params),
				});
				const body = await response.json();
				if (body.error) fail(m.id, body.error.code, body.error.message);
				else reply(m.id, body.result);
				return;
			}
			case 'ui/open-link':
				host.links.push(m.params && m.params.url);
				reply(m.id, {});
				return;
			default:
				if (m.id !== undefined) fail(m.id, -32601, 'not supported by this host');
		}
	});
	window.__deliver = (result) => {
		host.toolResult = result;
		if (host.ready) notify('ui/notifications/tool-result', result);
	};
	window.__teardown = () => new Promise((resolve) => {
		const id = 'teardown-' + (++next);
		pending.set(id, (m) => { host.teardowns += 1; resolve(m.error ? 'error' : 'ok'); });
		send({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: { reason: 'test' } });
	});
	window.__reload = () => { host.ready = false; frame.src = frame.src; };
</script></body></html>
`;
}

/** Reads a JSON-RPC reply that may arrive as JSON or as one SSE `message`. */
async function rpcReply(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').includes('event-stream')) {
		const data = text.split('\n').find((line) => line.startsWith('data:'));
		if (data === undefined) throw new Error(`no data frame: ${text.slice(0, 200)}`);
		return JSON.parse(data.slice(5)) as Record<string, unknown>;
	}
	return JSON.parse(text) as Record<string, unknown>;
}

/** Starts both listeners; call {@linkcode AppsHost.attach} once the gateway is up. */
export function startAppsHost(): AppsHost {
	const documents = new Map<EmbedKind, { html: string; csp: string }>();
	const visibility = new Map<string, readonly string[]>();
	const relayed: string[] = [];
	const refused: string[] = [];
	let gateway: { url: string; key: string } | null = null;
	let probeHits = 0;
	let nextId = 0;

	const serveView = (request: Request): Response => {
		const kind = new URL(request.url).pathname.replace(/^\/view\//, '') as EmbedKind;
		const document = documents.get(kind);
		if (document === undefined) return new Response('not attached', { status: 503 });
		return new Response(document.html, {
			headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': document.csp },
		});
	};
	const sandbox = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, serveView);
	const unlisted = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, serveView);
	const sandboxOrigin = `http://localhost:${sandbox.addr.port}`;
	const unlistedOrigin = `http://localhost:${unlisted.addr.port}`;

	const hostServer = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
		const url = new URL(request.url);
		if (url.pathname === '/probe') {
			probeHits += 1;
			return new Response('probe');
		}
		if (url.pathname === '/call' && request.method === 'POST') {
			const params = await request.json() as { name?: unknown; arguments?: unknown };
			const name = String(params.name ?? '');
			const seen = visibility.get(name);
			if (seen !== undefined && !seen.includes('app')) {
				refused.push(name);
				return Response.json({ error: { code: -32602, message: `${name} is not visible to apps` } });
			}
			if (gateway === null) return Response.json({ error: { code: -32603, message: 'not attached' } });
			relayed.push(name);
			const response = await fetch(`${gateway.url}/mcp`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${gateway.key}`,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
				},
				// No 2026 envelope: the legacy stateless path, as a 2025-era host would send it.
				body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params }),
			});
			return Response.json(await rpcReply(response));
		}
		return new Response(hostPage(sandboxOrigin, unlistedOrigin), {
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});
	});
	const hostOrigin = `http://127.0.0.1:${hostServer.addr.port}`;

	return {
		hostOrigin,
		sandboxOrigin,
		unlistedOrigin,
		get relayed() {
			return relayed;
		},
		get refused() {
			return refused;
		},
		get probeHits() {
			return probeHits;
		},
		pageUrl(kind, options = {}) {
			const query = new URLSearchParams({ kind, theme: options.theme ?? 'dark' });
			if (options.unlisted === true) query.set('unlisted', '1');
			return `${hostOrigin}/?${query}`;
		},
		viewUrl(kind, unlisted = false) {
			return `${unlisted ? unlistedOrigin : sandboxOrigin}/view/${kind}`;
		},
		async attach(target) {
			gateway = { url: target.url, key: target.key };
			const { tools } = await target.client.listTools();
			for (const tool of tools) {
				const ui = (tool._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
				if (ui?.visibility !== undefined) visibility.set(tool.name, ui.visibility);
			}
			for (const kind of ['live', 'a2ui', 'terminal'] as const) {
				const read = await target.client.readResource({ uri: VIEW_URIS[kind] });
				const content = read.contents[0] as { text?: string; _meta?: { ui?: { csp?: { connectDomains?: string[] } } } };
				if (typeof content?.text !== 'string') throw new Error(`no document for ${VIEW_URIS[kind]}`);
				documents.set(kind, { html: content.text, csp: hostCsp(content._meta?.ui?.csp?.connectDomains ?? []) });
			}
		},
		async [Symbol.asyncDispose]() {
			await hostServer.shutdown();
			await sandbox.shutdown();
			await unlisted.shutdown();
		},
	};
}
