import { assert, assertEquals } from '@std/assert';
import { assertType, type IsExact } from '@std/testing/types';

import { CdpClient } from './client.ts';
import {
	CDP_DOMAIN_METHODS,
	CDP_DOMAINS,
	CDP_VENDOR_DOMAINS,
	type CdpDomainName,
	type CdpEventName,
	type CdpManifestMethodName,
	type CdpMethodName,
	type CdpParams,
	type CdpResult,
} from './domains.ts';
import { CdpFixtureServer } from './testing/cdp_fixture.ts';

/** The D-CDP2 domain set, verbatim from DECISION-REGISTER.md, plus `Overlay` (E-46, B2.2). */
const REQUIRED_DOMAINS = [
	'Target',
	'Page',
	'Browser',
	'Network',
	'Storage',
	'DOMStorage',
	'DOM',
	'DOMSnapshot',
	'Accessibility',
	'Runtime',
	'Input',
	'Emulation',
	'Fetch',
	'SystemInfo',
	'Overlay',
] as const;

/** Methods the rest of the system is speced to call (ARCHITECTURE §6/§7, DATA-MODEL §5.1/§6). */
const REQUIRED_METHODS = [
	'Target.attachToTarget',
	'Target.setDiscoverTargets',
	'Target.setAutoAttach',
	'Target.createTarget',
	'Target.closeTarget',
	'Target.activateTarget',
	'Page.navigate',
	'Page.enable',
	'Page.setLifecycleEventsEnabled',
	'Page.captureScreenshot',
	'Page.getLayoutMetrics',
	'Page.printToPDF',
	'Page.startScreencast',
	'Page.stopScreencast',
	'Page.screencastFrameAck',
	'Page.handleJavaScriptDialog',
	'Page.getNavigationHistory',
	'Page.navigateToHistoryEntry',
	'Runtime.evaluate',
	'Runtime.callFunctionOn',
	'Input.dispatchMouseEvent',
	'Input.dispatchKeyEvent',
	'Input.insertText',
	'DOM.getDocument',
	'DOM.performSearch',
	'DOM.getSearchResults',
	'DOM.setFileInputFiles',
	'DOM.scrollIntoViewIfNeeded',
	'DOM.getContentQuads',
	'DOM.getBoxModel',
	'DOMSnapshot.captureSnapshot',
	'Accessibility.getFullAXTree',
	'Network.enable',
	'Browser.grantPermissions',
	'Browser.setDownloadBehavior',
	'Browser.cancelDownload',
	'Browser.getVersion',
	'Storage.getCookies',
	'Storage.setCookies',
	'DOMStorage.getDOMStorageItems',
	'DOMStorage.setDOMStorageItem',
	'Fetch.enable',
	'Fetch.continueWithAuth',
	'Emulation.setDeviceMetricsOverride',
	'Emulation.setUserAgentOverride',
	'SystemInfo.getInfo',
	'Overlay.highlightRect',
	'Overlay.highlightNode',
	'Overlay.hideHighlight',
] as const satisfies readonly CdpMethodName[];

/** Events the watchdog layer subscribes to. */
const REQUIRED_EVENTS = [
	'Target.attachedToTarget',
	'Target.detachedFromTarget',
	'Target.targetInfoChanged',
	'Target.targetCreated',
	'Target.targetDestroyed',
	'Target.targetCrashed',
	'Page.lifecycleEvent',
	'Page.javascriptDialogOpening',
	'Page.frameNavigated',
	'Page.navigatedWithinDocument',
	'Page.screencastFrame',
	'Network.responseReceived',
	'Network.requestWillBeSent',
	'Network.loadingFinished',
	'Browser.downloadWillBegin',
	'Browser.downloadProgress',
	'Fetch.authRequired',
	'Fetch.requestPaused',
	'Runtime.bindingCalled',
	'DOMStorage.domStorageItemAdded',
	'BrowserUse.captchaSolverStarted',
	'BrowserUse.captchaSolverFinished',
] as const satisfies readonly CdpEventName[];

Deno.test('cdp domains: exactly the 14 D-CDP2 domains plus Overlay (E-46) plus the optional vendor BrowserUse', () => {
	assertEquals(CDP_DOMAINS.length, 16);
	assertEquals(CDP_VENDOR_DOMAINS, ['BrowserUse']);

	const required = new Set<string>(REQUIRED_DOMAINS);
	const vendor = new Set<string>(CDP_VENDOR_DOMAINS);
	assertEquals(required.size, 15);
	for (const domain of REQUIRED_DOMAINS) {
		assert(CDP_DOMAINS.includes(domain), `missing D-CDP2 domain ${domain}`);
	}
	// Nothing beyond the 15 + the declared vendor domain — D-CDP2 covers "only what the system uses".
	for (const domain of CDP_DOMAINS) {
		assert(required.has(domain) || vendor.has(domain), `undeclared domain ${domain}`);
	}
});

/**
 * E-46 (B2.2, architecture §8.2). The `Overlay` domain has 31 commands; exactly the three highlight
 * commands plus the lifecycle pair are typed. `setInspectMode` consumes clicks in inspect mode and
 * would silently break the input path; the debug-border and diagnostic setters paint into every
 * screencast frame and every screenshot. The lifecycle pair is present because U-7 measured that
 * `highlightRect` refuses until `Overlay.enable` has run (`build/evidence/b2_2_u7_overlay_probe.log`).
 * A method added here without a decision fails this test rather than arriving unnoticed.
 */
Deno.test('cdp domains: Overlay types exactly the three highlight commands plus enable/disable, and nothing else (E-46)', () => {
	assertEquals([...CDP_DOMAIN_METHODS.Overlay].sort(), [
		'disable',
		'enable',
		'hideHighlight',
		'highlightNode',
		'highlightRect',
	]);
	for (
		const forbidden of [
			'setInspectMode',
			'setShowDebugBorders',
			'setShowPaintRects',
			'setShowFPSCounter',
			'setShowLayoutShiftRegions',
			'setShowHitTestBorders',
			'setShowAdHighlights',
			'setPausedInDebuggerMessage',
		]
	) {
		assert(
			!(CDP_DOMAIN_METHODS.Overlay as readonly string[]).includes(forbidden),
			`Overlay.${forbidden} must not be typed`,
		);
	}
});

Deno.test('cdp domains: the runtime manifest and the typed command map cannot drift', () => {
	// Compile-time: the union derived from CDP_DOMAIN_METHODS equals keyof CdpParams exactly.
	assertType<IsExact<CdpManifestMethodName, CdpMethodName>>(true);
	// And the two type maps agree on their key sets.
	assertType<IsExact<keyof CdpParams, keyof CdpResult>>(true);

	assertEquals(Object.keys(CDP_DOMAIN_METHODS).sort(), [...CDP_DOMAINS].sort());
	// The vendor domain contributes events only; commands go through sendRaw().
	assertEquals(CDP_DOMAIN_METHODS.BrowserUse.length, 0);
});

Deno.test('cdp domains: every speced method and event name is part of the typed surface', () => {
	const manifest = new Set<string>();
	for (const domain of CDP_DOMAINS) {
		for (const method of CDP_DOMAIN_METHODS[domain] as readonly string[]) {
			manifest.add(`${domain}.${method}`);
		}
	}
	for (const method of REQUIRED_METHODS) {
		assert(manifest.has(method), `typed surface is missing ${method}`);
	}
	// REQUIRED_EVENTS is validated at compile time by `satisfies readonly CdpEventName[]`; the runtime
	// assertion just pins the count so a deletion is loud.
	assertEquals(REQUIRED_EVENTS.length, 22);
});

Deno.test('cdp domains: client.send exposes every manifest method as a callable', async () => {
	await using fixture = CdpFixtureServer.start();
	const client = await CdpClient.connect(fixture.url);
	try {
		const send = client.send as unknown as Record<string, Record<string, unknown>>;
		assertEquals(Object.keys(send).sort(), [...CDP_DOMAINS].sort());

		let total = 0;
		for (const domain of CDP_DOMAINS) {
			const surface = send[domain];
			assert(surface !== undefined, `send.${domain} is missing`);
			for (const method of CDP_DOMAIN_METHODS[domain] as readonly string[]) {
				assertEquals(typeof surface[method], 'function', `send.${domain}.${method} is not callable`);
				total++;
			}
		}
		// A floor, not an exact count: adding methods is expected, silently losing them is not.
		assert(total >= 120, `expected ≥120 typed methods, found ${total}`);
	} finally {
		await client.close();
	}
});

Deno.test('cdp domains: typed calls carry their params and results end to end', async () => {
	await using fixture = CdpFixtureServer.start();
	fixture.on('Target.attachToTarget', (request, server) => server.reply(request.id, { sessionId: 'S-42' }));
	fixture.on('Page.getLayoutMetrics', (request, server) =>
		server.reply(request.id, {
			layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
			visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720, scale: 1 },
			contentSize: { x: 0, y: 0, width: 1280, height: 4000 },
		}));

	const client = await CdpClient.connect(fixture.url);
	try {
		const attached = await client.send.Target.attachToTarget({ targetId: 'T1', flatten: true });
		assertEquals(attached.sessionId, 'S-42');

		const metrics = await client.send.Page.getLayoutMetrics(undefined, attached.sessionId);
		assertEquals(metrics.contentSize.height, 4000);

		const attachRequest = fixture.requests[0];
		assertEquals(attachRequest?.params, { targetId: 'T1', flatten: true });
		assertEquals(attachRequest?.sessionId, undefined);
		// A no-params command must not put a `params` key on the wire at all.
		assertEquals(fixture.requests[1]?.params, undefined);
		assertEquals(fixture.requests[1]?.sessionId, 'S-42');
	} finally {
		await client.close();
	}
});

Deno.test('cdp domains: domain names are a closed union, not an open string', () => {
	assertType<IsExact<CdpDomainName, (typeof CDP_DOMAINS)[number]>>(true);
	const domain: CdpDomainName = 'Page';
	assertEquals(domain, 'Page');
});
