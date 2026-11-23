/**
 * The MCP Apps embeds in a real Chromium, framed by an emulated host in a sandboxed cross-origin iframe:
 *
 * - the live embed opens its socket only on the Watch click, takes and releases control, and closes on
 *   `visibilitychange: hidden` and `ui/resource-teardown`;
 * - CSP is observed, not reported: the frame's own CDP session sees requests for its document only and sockets for the
 *   declared ws origin only, a `securitypolicyviolation` listener installed first stays silent, and a positive control
 *   proves the listener is not deaf;
 * - a host origin `TTK_MCP_APPS_ORIGINS` does not list is refused a ticket;
 * - the A2UI embed renders every component read-only and follows live revisions; the terminal embed opens nothing.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { Client } from '@modelcontextprotocol/client';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('MCP Apps e2e');

/** The CDP surface this suite reaches through the harness's own session (test plumbing; the product sends none). */
interface Cdp {
	sendRaw<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
	on(event: string, listener: (params: never, sessionId?: string) => void): () => void;
}

interface DriverRecord {
	session: {
		cdpClient: Cdp | null;
		sessionManager: { getOrCreateCdpSession(target: unknown, focus: boolean): Promise<{ sessionId: string }> } | null;
		agentFocusTargetId: string | null;
	};
}

/** Installed in the embed's main world before its own script: records every CSP violation the document sees. */
const VIOLATION_PROBE = `
	window.__violations = [];
	document.addEventListener('securitypolicyviolation', (event) => {
		window.__violations.push(event.effectiveDirective + ' ' + (event.blockedURI || '-').slice(0, 80));
	});
	window.__probeInstalled = true;
`;

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
	const deadline = Date.now() + 25_000;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined && value !== false) return value;
		} catch (cause) {
			last = cause;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
}

/** A URL without its query: a ticket must never reach an assertion message. */
function bare(url: string): string {
	const parsed = URL.parse(url);
	return parsed === null ? url.split('?')[0]! : `${parsed.origin}${parsed.pathname}`;
}

/** Every component of the v0.9 basic catalog plus `Html`, as one surface. */
const SURFACE_COMPONENTS = [
	{ id: 'root', component: 'Card', child: 'layout' },
	{
		id: 'layout',
		component: 'Column',
		children: ['title', 'row', 'divider', 'image', 'icon', 'list', 'tabs', 'modal', 'slider', 'when', 'html'],
	},
	{ id: 'title', component: 'Text', text: 'Quarterly review', variant: 'h2' },
	{ id: 'row', component: 'Row', children: ['name', 'agree', 'go'] },
	{ id: 'name', component: 'TextField', label: 'Name', value: { path: '/name' } },
	{ id: 'agree', component: 'CheckBox', label: 'Agree', value: { path: '/agree' } },
	{ id: 'go', component: 'Button', text: 'Approve', action: { event: { name: 'approve', context: {} } } },
	{ id: 'divider', component: 'Divider' },
	{
		id: 'image',
		component: 'Image',
		url:
			'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
		variant: 'icon',
	},
	{ id: 'icon', component: 'Icon', name: 'shield-check' },
	{ id: 'list', component: 'List', children: ['one', 'two'] },
	{ id: 'one', component: 'Text', text: 'First' },
	{ id: 'two', component: 'Text', text: 'Second' },
	{ id: 'tabs', component: 'Tabs', tabs: [{ title: 'Pick', child: 'pick' }, { title: 'Many', child: 'many' }] },
	{
		id: 'pick',
		component: 'ChoicePicker',
		label: 'One',
		options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
		value: { path: '/one' },
	},
	{
		id: 'many',
		component: 'ChoicePicker',
		variant: 'multipleSelection',
		options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
		value: { path: '/many' },
	},
	{ id: 'modal', component: 'Modal', trigger: 'open', content: 'media' },
	{ id: 'open', component: 'Button', text: 'Media', action: { event: { name: 'noop', context: {} } } },
	{ id: 'media', component: 'Column', children: ['clip', 'sound', 'shared'] },
	{ id: 'clip', component: 'Video', url: 'data:video/mp4;base64,AAAA' },
	{ id: 'sound', component: 'AudioPlayer', url: 'data:audio/ogg;base64,AAAA', description: 'Briefing' },
	{ id: 'shared', component: 'Image', url: 'ttk://share/charts/q3.png' },
	{ id: 'slider', component: 'Slider', label: 'Volume', min: 0, max: 10, value: { path: '/volume' } },
	{ id: 'when', component: 'DateTimeInput', label: 'When', value: { path: '/when' } },
	{ id: 'html', component: 'Html', html: '<script>parent.postMessage("ran","*")</script><p>Report</p>' },
];

/** Starts the host, then a gateway with MCP Apps in `control` mode that lists the host's sandbox origin. */
async function appsHarness(): Promise<{ h: Harness; host: AppsHost; wsOrigin: string; driver: string }> {
	const host = startAppsHost();
	const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const port = (probe.addr as Deno.NetAddr).port;
	probe.close();
	const h = await harness({
		scopes: ['mcp:invoke', 'view:watch', 'view:control', 'admin', 'agent:invoke', 'a2ui:publish'],
		env: {
			TTK_PORT: String(port),
			TTK_PUBLIC_URL: `http://127.0.0.1:${port}`,
			TTK_MAX_SESSIONS: '4',
			TTK_MCP_APPS: 'control',
			TTK_MCP_APPS_ORIGINS: host.sandboxOrigin,
		},
	});
	await host.attach({ url: h.url, key: h.key, client: h.client });
	await h.callText('browser_navigate', { url: h.site.page('index') });
	const driver = (await h.callJson<{ session_id: string }>('browser_navigate', {
		url: h.site.page('index'),
		new_session: true,
	})).session_id;
	return { h, host, wsOrigin: `ws://127.0.0.1:${port}`, driver };
}

/** Loads the host page for one embed in the driver, attaches to the embed frame and reloads it observed. */
async function observedEmbed(h: Harness, host: AppsHost, driver: string, kind: EmbedKind, unlisted = false) {
	await h.callText('browser_navigate', { session_id: driver, url: host.pageUrl(kind, unlisted) });
	const record = h.gateway.registry.peek(driver) as unknown as DriverRecord;
	const cdp = record.session.cdpClient!;
	const page = await record.session.sessionManager!.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
	const evaluate = async <T>(expression: string, sessionId: string): Promise<T> => {
		const out = await cdp.sendRaw<{ result: { value?: T }; exceptionDetails?: { text?: string } }>(
			'Runtime.evaluate',
			{ expression, returnByValue: true, awaitPromise: true },
			sessionId,
		);
		if (out.exceptionDetails !== undefined) throw new Error(`evaluate failed: ${out.exceptionDetails.text}`);
		return out.result.value as T;
	};
	const origin = unlisted ? host.unlistedOrigin : host.sandboxOrigin;
	const targetId = await until(async () => {
		const { targetInfos } = await cdp.sendRaw<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
			'Target.getTargets',
		);
		return targetInfos.find((info) => info.type === 'iframe' && info.url.startsWith(origin))?.targetId;
	}, `the embed frame from ${origin}`);
	const { sessionId: frame } = await cdp.sendRaw<{ sessionId: string }>('Target.attachToTarget', {
		targetId,
		flatten: true,
	});
	const requests: string[] = [];
	/** `data:`/`blob:` loads: inline bytes, never a request to any origin. */
	const inline: string[] = [];
	const sockets: string[] = [];
	const offs = [
		cdp.on('Network.requestWillBeSent', (params: { request: { url: string } }, sessionId?: string) => {
			if (sessionId !== frame) return;
			const url = params.request.url;
			if (url.startsWith('data:') || url.startsWith('blob:')) inline.push(url.slice(0, url.indexOf(',') + 1));
			else requests.push(bare(url));
		}),
		cdp.on('Network.webSocketCreated', (params: { url: string }, sessionId?: string) => {
			if (sessionId === frame) sockets.push(bare(params.url));
		}),
	];
	await cdp.sendRaw('Network.enable', {}, frame);
	await cdp.sendRaw('Page.enable', {}, frame);
	await cdp.sendRaw('Page.addScriptToEvaluateOnNewDocument', { source: VIOLATION_PROBE }, frame);
	const inPage = <T>(expression: string) => evaluate<T>(expression, page.sessionId);
	const inEmbed = <T>(expression: string) => evaluate<T>(expression, frame);
	// The first document ran before the probe was installed; the observed run starts with a reload.
	await inPage('window.__reload(); true');
	await until(() => inEmbed<boolean>('window.__probeInstalled === true && !!document.querySelector("main")'), 'reload');
	await until(() => inPage<boolean>('window.__host.ready'), 'the bridge handshake');
	return {
		requests,
		inline,
		sockets,
		inPage,
		inEmbed,
		/** Waits until an expression in the embed is truthy, and returns it. */
		when: <T>(expression: string, what: string) => until(() => inEmbed<T>(expression), what),
		phase: () => inEmbed<string>('document.querySelector("main").dataset.phase'),
		click: (selector: string) => inEmbed(`document.querySelector(${JSON.stringify(selector)}).click(); true`),
		violations: () => inEmbed<string[]>('window.__violations'),
		deliver: (result: unknown) => inPage(`window.__deliver(${JSON.stringify(result)}); true`),
		stop: () => offs.forEach((off) => off()),
	};
}

const WATCH = '.e-btn.primary';
const CONTROL = '.e-btn.icon:not(.corner)';

Deno.test({
	name: 'e2e MCP Apps: the live embed watches on a click, takes control, closes on hide and teardown, under CSP',
	ignore,
	async fn(t) {
		const { h, host, wsOrigin, driver } = await appsHarness();
		await using _host = host;
		await using _h = h;
		const viewed = h.gateway.registry.peek('default')!;
		const view = await h.call('browser_live_view', { session_id: 'default' });
		assertEquals(view.isError, undefined, JSON.stringify(view.content));
		const embed = await observedEmbed(h, host, driver, 'live');
		try {
			await t.step('the embed is idle with one Watch button, and no socket exists', async () => {
				await embed.deliver({ content: view.content, structuredContent: view.structuredContent });
				assertEquals(await embed.when(`document.querySelector("${WATCH}")?.textContent`, 'Watch'), 'Watch');
				assertEquals(await embed.phase(), 'idle');
				assertEquals(await embed.inEmbed('document.querySelectorAll("button:not([hidden])").length'), 1);
				await new Promise((resolve) => setTimeout(resolve, 500));
				assertEquals([embed.sockets, viewed.viewers.size], [[], 0], 'no socket before the click');
				// The style applied (its hash matched) and the script ran (so did its hash).
				assert(await embed.inEmbed<boolean>('document.querySelector("style").sheet !== null'));
			});

			await t.step('Watch mints a ticket through the host and paints frames', async () => {
				await embed.click(WATCH);
				await until(async () => (await embed.phase()) === 'live', 'the live phase');
				assertEquals([viewed.viewers.size, host.relayed], [1, ['browser_live_ticket']]);
				await embed.when<boolean>(
					`(() => {
						const canvas = document.querySelector('canvas');
						const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
						for (let i = 0; i < data.length; i += 4 * 61) if (data[i + 3] !== 0) return true;
						return false;
					})()`,
					'painted frames',
				);
				assertEquals(embed.sockets, [`${wsOrigin}/live/default/ws`]);
				assertEquals(await embed.inEmbed('document.querySelector(".e-btn.corner").hidden'), false);
			});

			await t.step('Take control mints a control ticket on its own click, and Release gives it back', async () => {
				await embed.click(CONTROL);
				await until(() => viewed.lock !== null, 'the takeover lock');
				assertEquals(host.relayed, ['browser_live_ticket', 'browser_live_ticket']);
				await embed.when('document.querySelector(".e-dot").className.includes("driving")', 'driving');
				await embed.click(CONTROL);
				await until(() => viewed.lock === null, 'the lock released');
			});

			await t.step('hiding the view closes the socket, and nothing reopens it on its own', async () => {
				await embed.inEmbed(`(() => {
					Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
					document.dispatchEvent(new Event('visibilitychange'));
					return true;
				})()`);
				await until(() => viewed.viewers.size === 0, 'the viewer to leave on hide');
				await embed.inEmbed('delete document.visibilityState; true');
				assertEquals(await embed.phase(), 'idle');
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				assertEquals(viewed.viewers.size, 0, 'coming back does not reconnect without a click');
			});

			await t.step('ui/resource-teardown closes a running socket before the host removes the frame', async () => {
				await embed.click(WATCH);
				await until(() => viewed.viewers.size === 1, 'a second watch');
				assertEquals(await embed.inPage('window.__teardown()'), 'ok');
				await until(() => viewed.viewers.size === 0, 'the viewer to leave on teardown');
			});

			await t.step('the frame reached only its document and the declared ws origin; no CSP violation', async () => {
				assertEquals(embed.requests.filter((url) => url !== host.viewUrl('live')), []);
				assert(embed.sockets.length >= 3, `three watches were opened: ${embed.sockets.length}`);
				for (const url of embed.sockets) assert(url.startsWith(`${wsOrigin}/live/`), url);
				assertEquals(await embed.violations(), []);
				assertEquals(host.refused, []);
			});

			await t.step('positive control: the listener reports what the policy refuses, and nothing arrives', async () => {
				await embed.inEmbed(`(async () => {
					await fetch(${JSON.stringify(`${host.hostOrigin}/probe`)}).catch(() => {});
					const image = new Image();
					image.src = ${JSON.stringify(`${host.hostOrigin}/probe?img`)};
					await new Promise((resolve) => { image.onerror = resolve; image.onload = resolve; });
					return true;
				})()`);
				const violations = await until(async () => {
					const seen = await embed.violations();
					return seen.length >= 2 ? seen : undefined;
				}, 'the refused requests to be reported');
				assert(violations.some((entry) => entry.startsWith('connect-src')), violations.join(' | '));
				assert(violations.some((entry) => entry.startsWith('img-src')), violations.join(' | '));
				assertEquals(host.probeHits, 0, 'a refused request reached the network');
			});
		} finally {
			embed.stop();
		}
	},
});

Deno.test({
	name: 'e2e MCP Apps: an unlisted host origin is refused a ticket; the A2UI and terminal embeds',
	ignore,
	async fn(t) {
		const { h, host, wsOrigin, driver } = await appsHarness();
		await using _host = host;
		await using _h = h;

		await t.step('origin-refused: the frame says its origin is not admitted, and no socket opens', async () => {
			const view = await h.call('browser_live_view', { session_id: 'default' });
			const embed = await observedEmbed(h, host, driver, 'live', true);
			try {
				await embed.deliver({ content: view.content, structuredContent: view.structuredContent });
				await embed.when(`document.querySelector("${WATCH}")?.textContent`, 'the Watch button');
				await embed.click(WATCH);
				await until(async () => (await embed.phase()) === 'refused', 'the refused phase');
				// The chat user reads a sentence; the origin and the variable are the operator's, behind a disclosure.
				const message = await embed.inEmbed<string>('document.querySelector(".e-message-text").textContent');
				for (const leak of ['TTK_', host.unlistedOrigin, 'invalid-arguments']) assert(!message.includes(leak), message);
				assertStringIncludes(
					await embed.inEmbed('document.querySelector(".e-detail").textContent'),
					'TTK_MCP_APPS_ORIGINS',
				);
				assertEquals(await embed.inEmbed(`document.querySelector("${WATCH}").hidden`), true, 'no retry that must fail');
				assertEquals([embed.sockets, h.gateway.registry.peek('default')!.viewers.size], [[], 0]);
				assertEquals(await embed.violations(), []);
			} finally {
				embed.stop();
			}
		});

		await t.step('A2UI: every component renders read-only, fetching nothing', async () => {
			const publish = (message: Record<string, unknown>) =>
				h.call('a2ui_publish', { message: { version: 'v0.9', ...message } });
			await publish({ createSurface: { surfaceId: 'review', catalogId: A2UI_CATALOG_ID } });
			await publish({
				updateDataModel: {
					surfaceId: 'review',
					value: { name: 'Ada', agree: true, one: ['b'], many: ['a'], volume: 7, when: '2026-10-04' },
				},
			});
			const published = await publish({ updateComponents: { surfaceId: 'review', components: SURFACE_COMPONENTS } });
			assertEquals(published.isError, undefined, JSON.stringify(published.content));
			const embed = await observedEmbed(h, host, driver, 'a2ui');
			try {
				await embed.deliver({ content: published.content, structuredContent: published.structuredContent });
				await embed.when('!!document.querySelector(".a2ui-surface")', 'the surface');
				const report = await embed.inEmbed<Record<string, unknown>>(`(() => {
					const q = (s) => document.querySelectorAll(s);
					const one = (s) => document.querySelector(s);
					return {
						frames: q('iframe').length,
						buttons: [...q('.a2ui-button')].map((b) => b.disabled),
						text: [one('.a2ui-input[type=text]').value, one('.a2ui-input[type=text]').readOnly],
						checks: [...q('.a2ui-check')].every((c) => c.disabled),
						select: [one('select').value, one('select').disabled],
						range: [one('.a2ui-range').value, one('.a2ui-range').disabled],
						when: [one('.a2ui-datetime').value, one('.a2ui-datetime').readOnly],
						tabs: [...q('.a2ui-tab > summary')].map((s) => s.textContent),
						html: one('.a2ui-html').textContent.length > 0,
						players: q('video, audio').length,
						images: [...q('img')].map((i) => i.hasAttribute('src')),
					};
				})()`);
				assertEquals(report, {
					frames: 0,
					buttons: [true],
					text: ['Ada', true],
					checks: true,
					select: ['1', true],
					range: ['7', true],
					when: ['2026-10-04', true],
					tabs: ['Pick', 'Many'],
					html: true,
					players: 0, // players and the share file are notes; a share file has no credential here
					images: [true],
				});
				assertEquals(embed.requests.filter((url) => url !== host.viewUrl('a2ui')), []);
				for (const url of embed.inline) assert(url.startsWith('data:image/'), url);
				assertEquals(embed.sockets, []);
				assertEquals(await embed.violations(), []);
				assertEquals(host.relayed, ['browser_live_ticket'], 'the A2UI embed called no tool');
			} finally {
				embed.stop();
			}
		});

		await t.step('A2UI: Follow live streams each new revision over a ticketed socket, and the removal', async () => {
			const current = await h.call('a2ui_publish', {
				message: { version: 'v0.9', updateDataModel: { surfaceId: 'review', path: '/name', value: 'Grace' } },
			});
			const embed = await observedEmbed(h, host, driver, 'a2ui');
			try {
				await embed.deliver({ content: current.content, structuredContent: current.structuredContent });
				const caption = () => embed.inEmbed<string>('document.querySelector(".e-caption").textContent');
				await until(async () => (await caption()).includes('revision'), 'the surface');
				const before = await caption();
				assertEquals(embed.sockets, [], 'no socket until the press');
				await embed.click(WATCH);
				await embed.when('document.querySelector(".e-dot").className.includes("live")', 'the stream going live');
				assertEquals(embed.sockets, [`${wsOrigin}/live/surface/review/ws`]);
				assert(host.relayed.includes('a2ui_surface_ticket'), 'the ticket was minted through the host');
				await h.call('a2ui_publish', {
					message: {
						version: 'v0.9',
						updateComponents: {
							surfaceId: 'review',
							components: [{ id: 'title', component: 'Text', text: 'Quarterly review (live)', variant: 'h2' }],
						},
					},
				});
				await embed.when(
					'[...document.querySelectorAll(".a2ui-text")].some((n) => n.textContent === "Quarterly review (live)")',
					'the live revision',
				);
				assert((await caption()) !== before, 'the caption names the new revision');
				await h.call('a2ui_delete', { surface_id: 'review' });
				await embed.when('document.querySelector(".e-message-text").textContent.includes("was removed")', 'removal');
				assertEquals(await embed.violations(), []);
			} finally {
				embed.stop();
			}
		});

		await t.step('terminal: the embed renders a session under CSP and opens nothing before Attach', async () => {
			const embed = await observedEmbed(h, host, driver, 'terminal');
			try {
				await embed.deliver({
					content: [{ type: 'text', text: '{}' }],
					structuredContent: {
						result: { session_id: '00000000-0000-4000-8000-000000000009', created_at: '2026-10-11T00:00:00Z' },
					},
				});
				await embed.when(`document.querySelector("${WATCH}:not([hidden])")?.textContent`, 'the Attach button');
				assertStringIncludes(await embed.inEmbed<string>('document.querySelector(".e-origin").textContent'), '0009');
				assertEquals(embed.sockets, []);
				assertEquals(await embed.violations(), []);
			} finally {
				embed.stop();
			}
		});
	},
});

// --- the emulated MCP Apps host ----------------------------------------------------------------------------------

/**
 * Two origins stand in for a real host's: the host page (`127.0.0.1`) frames the embed in a sandboxed iframe
 * (`allow-scripts allow-same-origin`, SEP-1865), answers `ui/initialize`, relays the tool result the test hands it
 * (`window.__deliver`), proxies the embed's `tools/call` to the gateway as a 2025-era stateless POST (refusing a tool
 * whose `_meta.ui.visibility` lacks `app`) and sends `ui/resource-teardown` (`window.__teardown`). The sandbox origin
 * (`localhost`, so each frame is its own process) serves the `ui://` document under the CSP a host derives from
 * `_meta.ui.csp`; a second, unlisted one serves the same documents. `/probe` counts hits for the CSP positive
 * control. The bearer stays in this process; the frame only sees tool results.
 */
type EmbedKind = 'live' | 'a2ui' | 'terminal';

interface AppsHost extends AsyncDisposable {
	readonly hostOrigin: string;
	/** The sandbox origin the deployment lists in `TTK_MCP_APPS_ORIGINS`. */
	readonly sandboxOrigin: string;
	/** A second sandbox origin, same documents, that the deployment does not list. */
	readonly unlistedOrigin: string;
	pageUrl(kind: EmbedKind, unlisted?: boolean): string;
	viewUrl(kind: EmbedKind): string;
	attach(gateway: { url: string; key: string; client: Client }): Promise<void>;
	/** Every tool the host relayed for the embed, and those refused as not visible to apps. */
	readonly relayed: string[];
	readonly refused: string[];
	readonly probeHits: number;
}

const VIEW_URIS: Readonly<Record<EmbedKind, string>> = {
	live: 'ui://tykotech/live-view',
	a2ui: 'ui://tykotech/a2ui-surface',
	terminal: 'ui://tykotech/terminal',
};

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
<style>body { margin: 0; padding: 16px; } iframe { display: block; width: 100%; height: 420px; border: 0; }</style></head>
<body><script>
	const q = new URLSearchParams(location.search);
	const origin = q.get('unlisted') === '1' ? ${JSON.stringify(unlistedOrigin)} : ${JSON.stringify(sandboxOrigin)};
	const frame = document.createElement('iframe');
	frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
	frame.title = 'MCP App';
	frame.src = origin + '/view/' + (q.get('kind') || 'live');
	document.body.append(frame);
	const host = window.__host = { ready: false, toolResult: null };
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
				host.ready = false;
				reply(m.id, {
					protocolVersion: '2026-01-26',
					hostInfo: { name: 'ttk-e2e-host', version: '1' },
					hostCapabilities: { openLinks: {}, serverTools: {} },
					hostContext: { theme: 'dark', displayMode: 'inline' },
				});
				return;
			case 'ui/notifications/initialized':
				host.ready = true;
				if (host.toolResult) notify('ui/notifications/tool-result', host.toolResult);
				return;
			case 'ui/notifications/size-changed':
				if (m.params && m.params.height > 0) frame.style.height = m.params.height + 'px';
				return;
			case 'tools/call': {
				const response = await fetch('/call', { method: 'POST', body: JSON.stringify(m.params) });
				const body = await response.json();
				if (body.error) fail(m.id, body.error.code, body.error.message);
				else reply(m.id, body.result);
				return;
			}
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
		pending.set(id, (m) => resolve(m.error ? 'error' : 'ok'));
		send({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: { reason: 'test' } });
	});
	window.__reload = () => { host.ready = false; frame.src = frame.src; };
</script></body></html>
`;
}

function startAppsHost(): AppsHost {
	const documents = new Map<EmbedKind, { html: string; csp: string }>();
	const visibility = new Map<string, readonly string[]>();
	const relayed: string[] = [];
	const refused: string[] = [];
	let gateway: { url: string; key: string } | null = null;
	let probeHits = 0;
	let nextId = 0;

	const serveView = (request: Request): Response => {
		const document = documents.get(new URL(request.url).pathname.replace(/^\/view\//, '') as EmbedKind);
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
		if (url.pathname !== '/call' || request.method !== 'POST') {
			return new Response(hostPage(sandboxOrigin, unlistedOrigin), {
				headers: { 'content-type': 'text/html; charset=utf-8' },
			});
		}
		const params = await request.json() as { name?: unknown };
		const name = String(params.name ?? '');
		if (visibility.get(name)?.includes('app') === false) {
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
			body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params }),
		});
		// The reply arrives as JSON or as one SSE `message`.
		const text = await response.text();
		const data = (response.headers.get('content-type') ?? '').includes('event-stream')
			? text.split('\n').find((line) => line.startsWith('data:'))?.slice(5) ?? 'null'
			: text;
		return Response.json(JSON.parse(data));
	});
	const hostOrigin = `http://127.0.0.1:${hostServer.addr.port}`;

	return {
		hostOrigin,
		sandboxOrigin,
		unlistedOrigin,
		relayed,
		refused,
		get probeHits() {
			return probeHits;
		},
		pageUrl: (kind, unlisted = false) => `${hostOrigin}/?kind=${kind}${unlisted ? '&unlisted=1' : ''}`,
		viewUrl: (kind) => `${sandboxOrigin}/view/${kind}`,
		async attach(target) {
			gateway = { url: target.url, key: target.key };
			for (const tool of (await target.client.listTools()).tools) {
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
