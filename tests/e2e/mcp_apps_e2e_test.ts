/**
 * R9 (W7, AC39): the MCP Apps embeds in a real Chromium, framed by an emulated host (`mcp_apps_host.ts`) in a
 * sandboxed cross-origin iframe.
 *
 * What is proven, and how:
 *
 * - **The socket opens only on the Watch click**: before the click the viewed session has no viewer and the frame
 *   has created no WebSocket; after it, one viewer, frames painted into the canvas (pixels read back).
 * - **Control** is offered in `TTK_MCP_APPS=control` with `view:control`, takes the lock on a click with its own
 *   control ticket, and releases it.
 * - **`visibilitychange: hidden` and `ui/resource-teardown` close the socket** (the viewer leaves the session).
 * - **CSP, observed rather than reported**: the frame's own CDP session sees `Network.requestWillBeSent` for its
 *   document only and `Network.webSocketCreated` for the declared ws origin only, and a `securitypolicyviolation`
 *   listener installed before the document's own script stays silent. A positive control then has the frame try a
 *   fetch and an image from another loopback origin: both are reported as violations and neither reaches the probe
 *   listener — so the silence above is the policy holding, not the listener being deaf. The embed running at all is
 *   the proof that its inline script's hash matches the meta CSP; its stylesheet applying is the style's.
 * - **The origin-refused state**: the same document framed from an origin `TTK_MCP_APPS_ORIGINS` does not list asks
 *   for a ticket and is refused (`invalid-arguments`), and says so.
 * - **The A2UI embed** renders a surface with every component, read-only, under the same observation.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { type Harness, harness, imageOf, skipUnlessBrowser } from '../support/harness.ts';
import { readEnv } from '../support/browser_tier.ts';
import { type AppsHost, type EmbedKind, startAppsHost } from './mcp_apps_host.ts';

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
		window.__violations.push(
			event.effectiveDirective + ' ' + (event.blockedURI || '-').slice(0, 80) + ' (' + event.disposition + ')',
		);
	});
	window.__probeInstalled = true;
`;

/**
 * RV-1: the primary button's label against its fill, as the document paints them — both computed colours drawn to a
 * 1 px canvas and read back as sRGB, then the WCAG ratio.
 */
const PRIMARY_CONTRAST = `(() => {
	const button = document.querySelector('.e-btn.primary');
	const style = getComputedStyle(button);
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	const rgb = (colour) => {
		context.clearRect(0, 0, 1, 1);
		context.fillStyle = '#000';
		context.fillStyle = colour;
		context.fillRect(0, 0, 1, 1);
		return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
	};
	const channel = (value) => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
	const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
	const fg = rgb(style.color);
	const bg = rgb(style.backgroundColor);
	const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
	return {
		ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100,
		fg: fg.join(','),
		bg: bg.join(','),
		theme: document.documentElement.dataset.theme ?? null,
	};
})()`;

function reservePort(): number {
	const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const port = (probe.addr as Deno.NetAddr).port;
	probe.close();
	return port;
}

async function until<T>(
	probe: () => T | undefined | Promise<T | undefined>,
	what: string,
	timeoutMs = 25_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined) return value;
		} catch (cause) {
			last = cause;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
}

/** CDP access to one driver session: its page, and the embed frame inside it. */
async function driverCdp(h: Harness, driver: string) {
	const record = h.gateway.registry.peek(driver) as unknown as DriverRecord | undefined;
	assert(record?.session.cdpClient !== null && record?.session.sessionManager !== null && record !== undefined);
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
	return {
		cdp,
		inPage: <T>(expression: string) => evaluate<T>(expression, page.sessionId),
		inFrame: <T>(expression: string, sessionId: string) => evaluate<T>(expression, sessionId),
		/** Attaches to the embed's out-of-process frame, by the origin it was framed from. */
		async frame(origin: string): Promise<string> {
			const targetId = await until(async () => {
				const { targetInfos } = await cdp.sendRaw<
					{ targetInfos: Array<{ targetId: string; type: string; url: string }> }
				>(
					'Target.getTargets',
				);
				return targetInfos.find((info) => info.type === 'iframe' && info.url.startsWith(origin))?.targetId;
			}, `the embed frame from ${origin}`);
			const { sessionId } = await cdp.sendRaw<{ sessionId: string }>('Target.attachToTarget', {
				targetId,
				flatten: true,
			});
			return sessionId;
		},
	};
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
async function appsHarness(): Promise<{ h: Harness; host: AppsHost; wsOrigin: string }> {
	const host = startAppsHost();
	const port = reservePort();
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
	return { h, host, wsOrigin: `ws://127.0.0.1:${port}` };
}

/** Loads the host page for one embed in the driver, attaches to the embed frame and (re)loads it observed. */
async function observedEmbed(
	h: Harness,
	host: AppsHost,
	driver: string,
	kind: EmbedKind,
	options: { theme?: 'light' | 'dark'; unlisted?: boolean } = {},
) {
	await h.callText('browser_navigate', { session_id: driver, url: host.pageUrl(kind, options) });
	const cdp = await driverCdp(h, driver);
	const origin = options.unlisted === true ? host.unlistedOrigin : host.sandboxOrigin;
	const frame = await cdp.frame(origin);
	const requests: string[] = [];
	/** `data:` and `blob:` loads — inline bytes, never a request to any origin (a native date input's own icon is one). */
	const inline: string[] = [];
	const sockets: string[] = [];
	const offs = [
		cdp.cdp.on('Network.requestWillBeSent', (params: { request: { url: string } }, sessionId?: string) => {
			if (sessionId !== frame) return;
			const url = params.request.url;
			if (url.startsWith('data:') || url.startsWith('blob:')) inline.push(url.slice(0, url.indexOf(',') + 1));
			else requests.push(bare(url));
		}),
		cdp.cdp.on('Network.webSocketCreated', (params: { url: string }, sessionId?: string) => {
			if (sessionId === frame) sockets.push(bare(params.url));
		}),
	];
	await cdp.cdp.sendRaw('Network.enable', {}, frame);
	await cdp.cdp.sendRaw('Page.enable', {}, frame);
	await cdp.cdp.sendRaw('Page.addScriptToEvaluateOnNewDocument', { source: VIOLATION_PROBE }, frame);
	// The first document ran before the probe could be installed; the observed run starts with a reload.
	await cdp.inPage('window.__reload(); true');
	await until(
		async () =>
			(await cdp.inFrame<boolean>('window.__probeInstalled === true && !!document.querySelector("main")', frame)) ||
			undefined,
		'the reloaded embed',
	);
	await until(async () => (await cdp.inPage<boolean>('window.__host.ready')) || undefined, 'the bridge handshake');
	return {
		...cdp,
		frameSession: frame,
		requests,
		inline,
		sockets,
		violations: () => cdp.inFrame<string[]>('window.__violations', frame),
		inEmbed: <T>(expression: string) => cdp.inFrame<T>(expression, frame),
		deliver: (result: unknown) => cdp.inPage(`window.__deliver(${JSON.stringify(result)}); true`),
		stop: () => offs.forEach((off) => off()),
	};
}

Deno.test({
	name: 'e2e MCP Apps (AC39): the live embed watches on a click, takes control, closes on hide and teardown, under CSP',
	ignore,
	async fn(t) {
		const { h, host, wsOrigin } = await appsHarness();
		await using _host = host;
		await using _h = h;
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const viewed = h.gateway.registry.peek('default')!;
		const driver =
			(await h.callJson<{ session_id: string }>('browser_navigate', { url: h.site.page('index'), new_session: true }))
				.session_id;
		const view = await h.call('browser_live_view', { session_id: 'default' });
		assertEquals(view.isError, undefined, JSON.stringify(view.content));
		const embed = await observedEmbed(h, host, driver, 'live');

		try {
			await t.step('the embed is idle with one Watch button, and no socket exists', async () => {
				await embed.deliver({ content: view.content, structuredContent: view.structuredContent });
				const label = await until(
					async () =>
						(await embed.inEmbed<string | null>('document.querySelector(".e-btn.primary")?.textContent ?? null')) ??
							undefined,
					'the Watch button',
				);
				assertEquals(label, 'Watch');
				assertEquals(await embed.inEmbed('document.querySelector("main").dataset.phase'), 'idle');
				// One home per control: no Take control, no control-plane link before there is a ticket.
				assertEquals(await embed.inEmbed('document.querySelectorAll("button:not([hidden])").length'), 1);
				await new Promise((resolve) => setTimeout(resolve, 500));
				assertEquals(embed.sockets, [], 'no socket before the click');
				assertEquals(viewed.viewers.size, 0);
				// The style applied (its hash matched) and the script ran (so did its hash).
				assert(await embed.inEmbed<boolean>('document.querySelector("style").sheet !== null'));
				assertEquals(
					await embed.inEmbed('getComputedStyle(document.querySelector(".e-btn.primary")).borderRadius'),
					'8px',
				);
			});

			await t.step('Watch mints a ticket through the host and paints frames', async () => {
				await embed.inEmbed('document.querySelector(".e-btn.primary").click(); true');
				await until(
					async () =>
						(await embed.inEmbed<string>('document.querySelector("main").dataset.phase')) === 'live' || undefined,
					'the live phase',
				);
				assertEquals(viewed.viewers.size, 1);
				assertEquals(host.relayed, ['browser_live_ticket']);
				const painted = await until(async () => {
					const lit = await embed.inEmbed<number>(`(() => {
						const canvas = document.querySelector('canvas');
						const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
						let lit = 0;
						for (let i = 0; i < data.length; i += 4 * 61) if (data[i + 3] !== 0) lit += 1;
						return lit;
					})()`);
					return lit > 0 ? lit : undefined;
				}, 'painted frames');
				assert(painted > 0);
				assertEquals(embed.sockets, [`${wsOrigin}/live/default/ws`]);
				// The control-plane link is offered once a ticket named it, in the corner.
				assertEquals(await embed.inEmbed('document.querySelector(".e-btn.corner").hidden'), false);
			});

			await t.step('Take control mints a control ticket on its own click, and Release gives it back', async () => {
				await embed.inEmbed('document.querySelector(".e-btn.icon:not(.corner)").click(); true');
				await until(() => viewed.lock !== null || undefined, 'the takeover lock');
				assertEquals(host.relayed, ['browser_live_ticket', 'browser_live_ticket']);
				await until(
					async () =>
						(await embed.inEmbed<string>('document.querySelector(".e-dot").className')).includes('driving') ||
						undefined,
					'the driving state',
				);
				await embed.inEmbed('document.querySelector(".e-btn.icon:not(.corner)").click(); true');
				await until(() => viewed.lock === null || undefined, 'the lock released');
			});

			await t.step('hiding the view closes the socket, and nothing reopens it on its own', async () => {
				await embed.inEmbed(`(() => {
					Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
					document.dispatchEvent(new Event('visibilitychange'));
					return true;
				})()`);
				await until(() => viewed.viewers.size === 0 || undefined, 'the viewer to leave on hide');
				await embed.inEmbed('delete document.visibilityState; true');
				assertEquals(await embed.inEmbed('document.querySelector("main").dataset.phase'), 'idle');
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				assertEquals(viewed.viewers.size, 0, 'coming back does not reconnect without a click');
			});

			await t.step('ui/resource-teardown closes a running socket before the host removes the frame', async () => {
				await embed.inEmbed('document.querySelector(".e-btn.primary").click(); true');
				await until(() => viewed.viewers.size === 1 || undefined, 'a second watch');
				assertEquals(await embed.inPage('window.__teardown()'), 'ok');
				await until(() => viewed.viewers.size === 0 || undefined, 'the viewer to leave on teardown');
			});

			await t.step(
				'the frame reached nothing but its document and the declared ws origin; no CSP violation',
				async () => {
					const offOrigin = embed.requests.filter((url) => url !== host.viewUrl('live'));
					assertEquals(offOrigin, [], 'requestWillBeSent outside the document');
					assert(embed.sockets.length >= 3, `three watches were opened: ${embed.sockets.length}`);
					for (const url of embed.sockets) assert(url.startsWith(`${wsOrigin}/live/`), url);
					assertEquals(await embed.violations(), []);
					// The host never relayed anything but the app tool, and refused nothing.
					assertEquals(host.refused, []);
				},
			);

			await t.step(
				'positive control: the same listener reports what the policy refuses, and nothing arrives',
				async () => {
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
				},
			);
		} finally {
			embed.stop();
		}
	},
});

Deno.test({
	name: 'e2e MCP Apps (AC39): an unlisted host origin is refused a ticket, and the A2UI embed renders read-only',
	ignore,
	async fn(t) {
		const { h, host, wsOrigin } = await appsHarness();
		await using _host = host;
		await using _h = h;
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const driver =
			(await h.callJson<{ session_id: string }>('browser_navigate', { url: h.site.page('index'), new_session: true }))
				.session_id;

		await t.step('RV-1: the Watch label reads at 4.5:1 on its fill, dark and light', async () => {
			const view = await h.call('browser_live_view', { session_id: 'default' });
			for (const theme of ['dark', 'light'] as const) {
				const embed = await observedEmbed(h, host, driver, 'live', { theme });
				try {
					await embed.deliver({ content: view.content, structuredContent: view.structuredContent });
					await until(
						async () =>
							(await embed.inEmbed<boolean>('!!document.querySelector(".e-btn.primary:not([hidden])")')) ||
							undefined,
						'the Watch button',
					);
					const pair = await embed.inEmbed<{ ratio: number; fg: string; bg: string; theme: string | null }>(
						PRIMARY_CONTRAST,
					);
					assertEquals(pair.theme, theme, 'the host theme reached the document');
					assert(pair.ratio >= 4.5, `${theme}: Watch is ${pair.ratio}:1, rgb(${pair.fg}) on rgb(${pair.bg})`);
					assertEquals(await embed.violations(), []);
				} finally {
					embed.stop();
				}
			}
		});

		await t.step('origin-refused: the frame says its origin is not admitted, and no socket opens', async () => {
			const view = await h.call('browser_live_view', { session_id: 'default' });
			const embed = await observedEmbed(h, host, driver, 'live', { unlisted: true });
			try {
				await embed.deliver({ content: view.content, structuredContent: view.structuredContent });
				await until(
					async () =>
						(await embed.inEmbed<string | null>('document.querySelector(".e-btn.primary")?.textContent ?? null')) ??
							undefined,
					'the Watch button',
				);
				await embed.inEmbed('document.querySelector(".e-btn.primary").click(); true');
				const message = await until(async () => {
					const phase = await embed.inEmbed<string>('document.querySelector("main").dataset.phase');
					return phase === 'refused'
						? await embed.inEmbed<string>('document.querySelector(".e-message-text").textContent')
						: undefined;
				}, 'the refused phase');
				// RV-10: the person in the chat reads a sentence; the origin and the variable to set are the operator's,
				// behind a closed disclosure.
				for (const leak of ['TTK_', host.unlistedOrigin, 'invalid-arguments']) {
					assert(!message.includes(leak), `the chat user is shown ${leak}: ${message}`);
				}
				const detail = await embed.inEmbed<{ text: string; open: boolean; hidden: boolean } | null>(`(() => {
					const details = document.querySelector('.e-detail');
					return details === null ? null : { text: details.textContent, open: details.open, hidden: details.hidden };
				})()`);
				assert(detail !== null, 'the operator detail is on the page');
				assertEquals([detail.hidden, detail.open], [false, false]);
				assertStringIncludes(detail.text, 'TTK_MCP_APPS_ORIGINS');
				// A press that can only fail again is not offered (no idle control).
				assertEquals(await embed.inEmbed('document.querySelector(".e-btn.primary").hidden'), true);
				assertEquals(embed.sockets, []);
				assertEquals(h.gateway.registry.peek('default')!.viewers.size, 0);
				assertEquals(await embed.violations(), []);
			} finally {
				embed.stop();
			}
		});

		await t.step('A2UI: every component renders read-only, fetching nothing', async () => {
			const created = await h.call('a2ui_publish', {
				message: { version: 'v0.9', createSurface: { surfaceId: 'review', catalogId: A2UI_CATALOG_ID } },
			});
			assertEquals(created.isError, undefined, JSON.stringify(created.content));
			await h.call('a2ui_publish', {
				message: {
					version: 'v0.9',
					updateDataModel: {
						surfaceId: 'review',
						value: { name: 'Ada', agree: true, one: ['b'], many: ['a'], volume: 7, when: '2026-10-04' },
					},
				},
			});
			const published = await h.call('a2ui_publish', {
				message: { version: 'v0.9', updateComponents: { surfaceId: 'review', components: SURFACE_COMPONENTS } },
			});
			assertEquals(published.isError, undefined, JSON.stringify(published.content));
			const embed = await observedEmbed(h, host, driver, 'a2ui');
			try {
				await embed.deliver({ content: published.content, structuredContent: published.structuredContent });
				await until(
					async () => (await embed.inEmbed<boolean>('!!document.querySelector(".a2ui-surface")')) || undefined,
					'the surface',
				);
				const report = await embed.inEmbed<Record<string, unknown>>(`(() => {
					const q = (s) => document.querySelectorAll(s);
					return {
						kit: q('[class^="wa-"], wa-tab-group, wa-select, wa-input, wa-dialog').length,
						frames: q('iframe').length,
						buttons: [...q('.a2ui-button')].map((b) => [b.disabled, b.title !== '']),
						text: [document.querySelector('.a2ui-input[type=text]').value, document.querySelector('.a2ui-input[type=text]').readOnly],
						checks: [...q('.a2ui-check')].map((c) => c.disabled),
						select: [document.querySelector('select').value, document.querySelector('select').disabled],
						range: [document.querySelector('.a2ui-range').value, document.querySelector('.a2ui-range').disabled],
						when: [document.querySelector('.a2ui-datetime').value, document.querySelector('.a2ui-datetime').readOnly],
						tabs: [...q('.a2ui-tab > summary')].map((s) => s.textContent),
						html: document.querySelector('.a2ui-html').textContent.length > 0,
						players: q('video, audio').length,
						notes: q('.a2ui-media-placeholder[data-unavailable]').length,
						images: [...q('img')].map((i) => i.hasAttribute('src')),
						shareNote: document.querySelector('.a2ui-media-placeholder.image')?.textContent ?? null,
						audioCaption: document.querySelector('.a2ui-media-placeholder.audio .a2ui-caption')?.textContent ?? null,
						caption: document.querySelector('.e-caption').textContent,
					};
				})()`);
				assertEquals(report.kit, 0, 'no kit element');
				assertEquals(report.frames, 0, 'no frame over this origin');
				assertEquals(report.buttons, [[true, true]], 'one Button; the Modal trigger is a native summary');
				assertEquals(report.text, ['Ada', true]);
				assert((report.checks as boolean[]).every((disabled) => disabled));
				assertEquals(report.select, ['1', true]);
				assertEquals(report.range, ['7', true]);
				assertEquals(report.when, ['2026-10-04', true]);
				assertEquals(report.tabs, ['Pick', 'Many']);
				assertEquals(report.html, true);
				assertEquals([report.players, report.notes], [0, 3], 'players and the share file are notes');
				// RV-6: no blank <img> for a share file the embed has no credential to read; a note says where it shows.
				assertEquals(report.images, [true], 'the inline image shows');
				assertStringIncludes(String(report.shareNote), 'Image is shown in the control plane');
				assertEquals(report.audioCaption, 'Briefing', "the player's caption sits inside its note");
				assertStringIncludes(String(report.caption), 'read-only');
				assertEquals(embed.requests.filter((url) => url !== host.viewUrl('a2ui')), []);
				// Inline loads only (the agent's data: image, the browser's own date-picker glyph): none reaches an origin.
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
			assertEquals(current.isError, undefined, JSON.stringify(current.content));
			const embed = await observedEmbed(h, host, driver, 'a2ui');
			try {
				await embed.deliver({ content: current.content, structuredContent: current.structuredContent });
				const caption = () => embed.inEmbed<string>('document.querySelector(".e-caption").textContent');
				await until(async () => (await caption()).includes('revision') || undefined, 'the surface');
				const before = await caption();
				// No socket until the press.
				assertEquals(embed.sockets, []);
				await embed.inEmbed('document.querySelector(".e-btn.primary").click(); true');
				await until(
					async () =>
						(await embed.inEmbed<string>('document.querySelector(".e-dot").className')).includes('live') ||
						undefined,
					'the stream going live',
				);
				assertEquals(embed.sockets, [`${wsOrigin}/live/surface/review/ws`]);
				assert(host.relayed.includes('a2ui_surface_ticket'), 'the ticket was minted through the host');
				// The agent publishes; the embed draws it without another tool result.
				await h.call('a2ui_publish', {
					message: {
						version: 'v0.9',
						updateComponents: {
							surfaceId: 'review',
							components: [{ id: 'title', component: 'Text', text: 'Quarterly review (live)', variant: 'h2' }],
						},
					},
				});
				await until(
					async () =>
						(await embed.inEmbed<boolean>(
							'[...document.querySelectorAll(".a2ui-text")].some((n) => n.textContent === "Quarterly review (live)")',
						)) || undefined,
					'the live revision',
				);
				assert((await caption()) !== before, 'the caption names the new revision');
				await h.call('a2ui_delete', { surface_id: 'review' });
				await until(
					async () =>
						(await embed.inEmbed<string>('document.querySelector(".e-message-text").textContent')).includes(
							'was removed',
						) || undefined,
					'the removal',
				);
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
				await until(
					async () =>
						(await embed.inEmbed<string | null>(
							'document.querySelector(".e-btn.primary:not([hidden])")?.textContent ?? null',
						)) ?? undefined,
					'the Attach button',
				);
				assertStringIncludes(await embed.inEmbed<string>('document.querySelector(".e-origin").textContent'), '0009');
				assertEquals(embed.sockets, []);
				assertEquals(await embed.violations(), []);
			} finally {
				embed.stop();
			}
		});
	},
});

/**
 * UI evidence (design §5): each embed state in dark and light, at 1280 and 390 px. Written only when
 * `TTK_UI_EVIDENCE_DIR` names a directory under the tier's write grant; the full tier skips it.
 */
const EVIDENCE_DIR = readEnv('TTK_UI_EVIDENCE_DIR');

Deno.test({
	name: 'e2e MCP Apps: UI evidence for the embeds (dark and light, 1280 and 390 px)',
	ignore: ignore || EVIDENCE_DIR === undefined,
	async fn() {
		const dir = EVIDENCE_DIR!;
		await Deno.mkdir(dir, { recursive: true });
		const { h, host } = await appsHarness();
		await using _host = host;
		await using _h = h;
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const driver =
			(await h.callJson<{ session_id: string }>('browser_navigate', { url: h.site.page('index'), new_session: true }))
				.session_id;
		const view = await h.call('browser_live_view', { session_id: 'default' });
		await h.call('a2ui_publish', {
			message: { version: 'v0.9', createSurface: { surfaceId: 'review', catalogId: A2UI_CATALOG_ID } },
		});
		await h.call('a2ui_publish', {
			message: {
				version: 'v0.9',
				updateDataModel: {
					surfaceId: 'review',
					value: { name: 'Ada', agree: true, one: ['b'], many: ['a'], volume: 7, when: '2026-10-04' },
				},
			},
		});
		const published = await h.call('a2ui_publish', {
			message: { version: 'v0.9', updateComponents: { surfaceId: 'review', components: SURFACE_COMPONENTS } },
		});
		const shoot = async (name: string): Promise<void> => {
			const image = imageOf(await h.call('browser_screenshot', { session_id: driver }));
			assert(image !== null, `no screenshot for ${name}`);
			await Deno.writeFile(`${dir}/${name}.${image.mimeType.endsWith('png') ? 'png' : 'jpg'}`, image.bytes);
		};
		for (const [width, height] of [[1280, 800], [390, 844]] as const) {
			await h.call('browser_set_viewport', { session_id: driver, width, height });
			for (const theme of ['dark', 'light'] as const) {
				const tag = `${theme}-${width}`;
				const live = await observedEmbed(h, host, driver, 'live', { theme });
				await live.deliver({ content: view.content, structuredContent: view.structuredContent });
				await until(
					async () =>
						(await live.inEmbed<boolean>('!!document.querySelector(".e-btn.primary:not([hidden])")')) || undefined,
					'idle',
				);
				await shoot(`live-idle-${tag}`);
				await live.inEmbed('document.querySelector(".e-btn.primary").click(); true');
				await until(
					async () =>
						(await live.inEmbed<string>('document.querySelector("main").dataset.phase')) === 'live' || undefined,
					'live',
				);
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				await shoot(`live-streaming-${tag}`);
				await live.inEmbed('document.querySelector(".e-btn.icon:not(.corner)").click(); true');
				await until(
					async () =>
						(await live.inEmbed<string>('document.querySelector(".e-dot").className')).includes('driving') || undefined,
					'driving',
				);
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				await shoot(`live-control-${tag}`);
				await live.inPage('window.__teardown()');
				live.stop();

				const refused = await observedEmbed(h, host, driver, 'live', { theme, unlisted: true });
				await refused.deliver({ content: view.content, structuredContent: view.structuredContent });
				await until(
					async () =>
						(await refused.inEmbed<boolean>('!!document.querySelector(".e-btn.primary:not([hidden])")')) || undefined,
					'idle',
				);
				await refused.inEmbed('document.querySelector(".e-btn.primary").click(); true');
				await until(
					async () =>
						(await refused.inEmbed<string>('document.querySelector("main").dataset.phase')) === 'refused' || undefined,
					'refused',
				);
				await shoot(`live-origin-refused-${tag}`);
				refused.stop();

				const a2ui = await observedEmbed(h, host, driver, 'a2ui', { theme });
				await a2ui.deliver({ content: published.content, structuredContent: published.structuredContent });
				await until(
					async () => (await a2ui.inEmbed<boolean>('!!document.querySelector(".a2ui-surface")')) || undefined,
					'surface',
				);
				await a2ui.inEmbed('document.querySelectorAll("details").forEach((d) => { d.open = true; }); true');
				await new Promise((resolve) => setTimeout(resolve, 300));
				await shoot(`a2ui-${tag}`);
				a2ui.stop();
			}
		}
	},
});
