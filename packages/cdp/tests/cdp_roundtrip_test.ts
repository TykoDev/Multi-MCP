/**
 * Tier 2 — **the M0 exit criterion**: the client drives real headless Chromium through
 * navigate / screenshot / evaluate round-trips (COMPLETIONS-CRITERIA.md §3.1, ROADMAP.md M0).
 *
 * This is the one suite that imports the package's public surface (`../mod.ts`), because it is the
 * only place where the launch half and the transport half have to meet: launch → `/json/version` →
 * `CdpClient.connect(ws)` is exactly the convergence ARCHITECTURE.md §7.4 specifies.
 *
 * Every page is served from a per-test loopback fixture; no remote URL appears anywhere (D-TEST1).
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { CdpClient, fetchWebSocketDebuggerUrl } from '../mod.ts';
import { browserTest, html, startFixtureServer } from './_helpers.ts';

const PAGE = `<!doctype html>
<html><head><title>bua fixture</title></head>
<body><h1 id="heading">round trip</h1><p data-role="marker">42</p></body></html>`;

/** launch → /json/version → CdpClient.connect, then attach a flat session to a fresh page target. */
async function connectAndAttach(
	ctx: { launch: () => Promise<{ cdpUrl: string; webSocketDebuggerUrl: string }> },
	url: string,
): Promise<{ client: CdpClient; sessionId: string; targetId: string }> {
	const browser = await ctx.launch();
	const wsUrl = await fetchWebSocketDebuggerUrl(browser.cdpUrl);
	assertEquals(wsUrl, browser.webSocketDebuggerUrl);
	const client = await CdpClient.connect(wsUrl);
	const { targetId } = await client.send.Target.createTarget({ url });
	const { sessionId } = await client.send.Target.attachToTarget({ targetId, flatten: true });
	return { client, sessionId, targetId };
}

browserTest('m0: navigate / evaluate / screenshot round-trip against a real browser', async (ctx) => {
	const fixture = startFixtureServer({ '/page': () => html(PAGE) });
	ctx.defer(() => fixture.close());

	const { client, sessionId, targetId } = await connectAndAttach(ctx, 'about:blank');
	ctx.defer(() => client.close());
	assertEquals(client.state, 'open');

	// --- navigate -----------------------------------------------------------
	await client.send.Page.enable(undefined, sessionId);
	const navigation = await client.send.Page.navigate({ url: `${fixture.baseUrl}/page` }, sessionId);
	assertEquals(navigation.errorText, undefined);
	assert(navigation.frameId.length > 0);
	assert(navigation.loaderId !== undefined, 'a cross-document navigation must report a loaderId');

	// --- evaluate -----------------------------------------------------------
	// Poll until the document is parsed; the readiness state machine itself is M1's contract.
	let title = '';
	for (let attempt = 0; attempt < 100 && title !== 'bua fixture'; attempt++) {
		const evaluated = await client.send.Runtime.evaluate(
			{ expression: 'document.title', returnByValue: true },
			sessionId,
		);
		title = typeof evaluated.result.value === 'string' ? evaluated.result.value : '';
		if (title !== 'bua fixture') await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assertEquals(title, 'bua fixture');

	const heading = await client.send.Runtime.evaluate(
		{ expression: 'document.getElementById("heading").textContent', returnByValue: true },
		sessionId,
	);
	assertEquals(heading.result.value, 'round trip');

	const marker = await client.send.Runtime.evaluate(
		{ expression: 'Number(document.querySelector("[data-role=marker]").textContent) * 2', returnByValue: true },
		sessionId,
	);
	assertEquals(marker.result.value, 84);

	// --- screenshot ---------------------------------------------------------
	const shot = await client.send.Page.captureScreenshot({ format: 'png' }, sessionId);
	assert(shot.data.length > 0, 'screenshot payload was empty');
	const bytes = Uint8Array.from(atob(shot.data.slice(0, 12)), (c) => c.charCodeAt(0));
	// PNG magic: 89 50 4E 47 0D 0A 1A 0A
	assertEquals([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	// The page really was fetched from our fixture, and the browser asked for nothing beyond the
	// document and the favicon a real browser always probes.
	assertEquals(fixture.requests[0], '/page');
	assert(fixture.requests.every((path) => path === '/page' || path === '/favicon.ico'));

	await client.send.Target.closeTarget({ targetId });
});

browserTest('m0: browser-level commands work without a sessionId', async (ctx) => {
	const browser = await ctx.launch();
	const client = await CdpClient.connect(await fetchWebSocketDebuggerUrl(browser.cdpUrl));
	ctx.defer(() => client.close());

	const version = await client.send.Browser.getVersion();
	assertStringIncludes(version.protocolVersion, '1.');
	assert(version.product.length > 0);

	const targets = await client.send.Target.getTargets();
	assert(Array.isArray(targets.targetInfos));
});

browserTest('m0: events arrive with their flat-session sessionId', async (ctx) => {
	const fixture = startFixtureServer({ '/page': () => html(PAGE) });
	ctx.defer(() => fixture.close());

	const { client, sessionId, targetId } = await connectAndAttach(ctx, 'about:blank');
	ctx.defer(() => client.close());

	const seen: Array<{ name: string; sessionId: string | undefined }> = [];
	const unsubscribe = client.on('Page.frameNavigated', (_params, eventSessionId) => {
		seen.push({ name: 'Page.frameNavigated', sessionId: eventSessionId });
	});
	ctx.defer(() => unsubscribe());

	await client.send.Page.enable(undefined, sessionId);
	await client.send.Page.navigate({ url: `${fixture.baseUrl}/page` }, sessionId);
	for (let attempt = 0; attempt < 100 && seen.length === 0; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert(seen.length > 0, 'no Page.frameNavigated event was delivered');
	assertEquals(seen[0]?.sessionId, sessionId);

	await client.send.Target.closeTarget({ targetId });
});

browserTest('m0: close() leaves the client closed and the browser reapable', async (ctx) => {
	const browser = await ctx.launch();
	const client = await CdpClient.connect(await fetchWebSocketDebuggerUrl(browser.cdpUrl));
	assertEquals(client.state, 'open');
	await client.close();
	assertEquals(client.state, 'closed');
	// A closed client must not keep the browser alive: launch teardown still works.
	await browser.close();
	const status = await browser.child.status;
	assert(status.code !== undefined);
});
