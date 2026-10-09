import { assert, assertEquals, assertThrows } from '@std/assert';
import type { SerializedDomState } from './dom/types.ts';
import {
	type BrowserProfile,
	type BrowserStateSummary,
	type CaptchaWaitResult,
	createBrowserProfile,
	DEFAULT_BROWSER_PERMISSIONS,
	DEFAULT_BROWSER_PROFILE,
	DEFAULT_COOKIE_WHITELIST_DOMAINS,
	defaultBrowserProfile,
	findTargetIdsByTabId,
	type PageInfo,
	resolveIsLocal,
	resolveTargetIdByTabId,
	type StorageState,
	TAB_ID_LENGTH,
	tabIdFor,
	toTabInfo,
} from './types.ts';

// ---------------------------------------------------------------------------------------------
// §5.2 — BrowserProfile field surface and defaults
// ---------------------------------------------------------------------------------------------

Deno.test('profile: crossOriginIframes defaults to true (gate ruling I-11)', () => {
	assertEquals(DEFAULT_BROWSER_PROFILE.crossOriginIframes, true);
	assertEquals(createBrowserProfile().crossOriginIframes, true);
	assertEquals(createBrowserProfile({ crossOriginIframes: false }).crossOriginIframes, false);
});

Deno.test('profile: the §5.2 field surface is complete and every field has a defined default', () => {
	const profile = defaultBrowserProfile();
	const keys = Object.keys(profile);
	// 5 connection + 14 launch + 7 display + 9 security/domains + 1 proxy + 3 storage/downloads
	// + 4 timing + 15 observation/recording. ERRATUM(E-114) added `requestScope` to security/domains.
	assertEquals(keys.length, 58);
	for (const key of keys) {
		assert((profile as unknown as Record<string, unknown>)[key] !== undefined, `${key} has an undefined default`);
	}
});

Deno.test('profile: defaults match DATA-MODEL.md §5.2 verbatim', () => {
	const p = defaultBrowserProfile();

	// connection
	assertEquals([p.cdpUrl, p.isLocal, p.headers, p.useCloud, p.cloudBrowserParams], [null, null, null, false, null]);
	// launch
	assertEquals([p.executablePath, p.channel, p.headless, p.env], [null, null, null, null]);
	assertEquals([p.args, p.ignoreDefaultArgs], [[], []]);
	assertEquals([p.chromiumSandbox, p.devtools, p.enableDefaultExtensions], [true, false, true]);
	assertEquals([p.downloadsPath, p.tracesDir, p.userDataDir], [null, null, null]);
	assertEquals(p.profileDirectory, 'Default');
	assertEquals(p.cookieWhitelistDomains, ['nature.com', 'qatarairways.com']);
	// display / viewport
	assertEquals([p.windowSize, p.viewport, p.screen, p.noViewport, p.deviceScaleFactor, p.userAgent], [
		null,
		null,
		null,
		null,
		null,
		null,
	]);
	assertEquals(p.windowPosition, { x: 0, y: 0 });
	// security / domains
	assertEquals([p.allowedDomains, p.prohibitedDomains], [null, null]);
	assertEquals([p.blockIpAddresses, p.disableSecurity], [false, false]);
	// ERRATUM(E-114): the document veto's scope; `all` is opt-in (D-138).
	assertEquals(p.requestScope, 'documents');
	assertEquals(p.permissions, ['clipboardReadWrite', 'notifications']);
	assertEquals([p.maxIframes, p.maxIframeDepth], [100, 5]);
	// proxy + storage / downloads
	assertEquals([p.proxy, p.storageState], [null, null]);
	assertEquals([p.acceptDownloads, p.autoDownloadPdfs], [true, true]);
	// timing (load-bearing; register rule §2.5)
	assertEquals(
		[p.minimumWaitPageLoadTime, p.waitForNetworkIdlePageLoadTime, p.waitBetweenActions, p.keepAlive],
		[0.25, 0.5, 0.1, null],
	);
	// observation / recording
	assertEquals([p.recordVideoDir, p.recordVideoSize, p.recordVideoFramerate], [null, null, 30]);
	assertEquals([p.recordHarPath, p.recordHarContent, p.recordHarMode], [null, 'embed', 'full']);
	assertEquals([p.highlightElements, p.domHighlightElements, p.filterHighlightIds], [true, false, true]);
	assertEquals([p.interactionHighlightColor, p.interactionHighlightDuration], ['rgb(255,127,39)', 1.0]);
	assertEquals([p.paintOrderFiltering, p.captchaSolver, p.demoMode, p.deterministicRendering], [
		true,
		true,
		false,
		false,
	]);
});

Deno.test('profile: DEFAULT_BROWSER_PROFILE is frozen and never aliased into new profiles', () => {
	assert(Object.isFrozen(DEFAULT_BROWSER_PROFILE));
	assertThrows(() => {
		(DEFAULT_BROWSER_PROFILE as BrowserProfile).crossOriginIframes = false;
	}, TypeError);

	const first = createBrowserProfile();
	const second = createBrowserProfile();
	assert(first.args !== second.args, 'array defaults must be fresh per profile');
	first.permissions.push('geolocation');
	assertEquals(second.permissions, [...DEFAULT_BROWSER_PERMISSIONS]);
	assertEquals(DEFAULT_BROWSER_PROFILE.permissions, [...DEFAULT_BROWSER_PERMISSIONS]);
	assertEquals([...DEFAULT_COOKIE_WHITELIST_DOMAINS], second.cookieWhitelistDomains);
});

Deno.test('profile: createBrowserProfile merges overrides and ignores explicit undefined', () => {
	const headlessFlag: boolean | undefined = undefined;
	const profile = createBrowserProfile({
		cdpUrl: 'http://127.0.0.1:9222',
		headless: headlessFlag,
		allowedDomains: ['*.fixture.local'],
		ignoreDefaultArgs: true,
	});
	assertEquals(profile.cdpUrl, 'http://127.0.0.1:9222');
	assertEquals(profile.headless, null, 'explicit undefined must not clobber the default');
	assertEquals(profile.allowedDomains, ['*.fixture.local']);
	assertEquals(profile.ignoreDefaultArgs, true);
	assertEquals(profile.maxIframes, 100, 'untouched fields keep their defaults');
});

Deno.test('profile: resolveIsLocal infers from cdpUrl + useCloud, and an explicit value wins', () => {
	assertEquals(resolveIsLocal(createBrowserProfile()), true);
	assertEquals(resolveIsLocal(createBrowserProfile({ cdpUrl: 'http://127.0.0.1:9222' })), false);
	assertEquals(resolveIsLocal(createBrowserProfile({ useCloud: true })), false);
	assertEquals(resolveIsLocal(createBrowserProfile({ cdpUrl: 'http://127.0.0.1:9222', isLocal: true })), true);
	assertEquals(resolveIsLocal(createBrowserProfile({ isLocal: false })), false);
});

// ---------------------------------------------------------------------------------------------
// §5.4 — TabInfo and 4-char tab ids
// ---------------------------------------------------------------------------------------------

Deno.test('tabs: tabId is the last 4 characters of targetId', () => {
	assertEquals(TAB_ID_LENGTH, 4);
	assertEquals(tabIdFor('E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6'), 'A5B6');
	assertEquals(tabIdFor('ABC'), 'ABC', 'a short id is its own tab id');
	const info = toTabInfo({ targetId: 'TARGET-000-BEEF', url: 'http://127.0.0.1:8080/', title: 'Fixture' });
	assertEquals(info.tabId, 'BEEF');
	assertEquals(info.tabId, tabIdFor(info.targetId));
});

Deno.test('tabs: suffix resolution accepts a tabId or a full targetId', () => {
	const targets = ['AAAA1111', 'BBBB2222', 'CCCC3333'];
	assertEquals(resolveTargetIdByTabId('2222', targets), 'BBBB2222');
	assertEquals(resolveTargetIdByTabId('BBBB2222', targets), 'BBBB2222');
	assertEquals(resolveTargetIdByTabId('9999', targets), null, 'unknown suffix resolves to null');
	assertEquals(resolveTargetIdByTabId('', targets), null, 'an empty tabId never matches');
});

Deno.test('tabs: a colliding suffix is ambiguous and fails closed to null', () => {
	const targets = ['AAAA1234', 'BBBB1234'];
	assertEquals(findTargetIdsByTabId('1234', targets), ['AAAA1234', 'BBBB1234']);
	assertEquals(resolveTargetIdByTabId('1234', targets), null);
	// The collision is resolvable by disambiguating with more of the id.
	assertEquals(resolveTargetIdByTabId('A1234', targets), 'AAAA1234');
});

// ---------------------------------------------------------------------------------------------
// §5.3 / §5.1.7 — state and captcha shapes
// ---------------------------------------------------------------------------------------------

Deno.test('state: BrowserStateSummary composes the §5.3 shape including the fallback state', () => {
	const domState: SerializedDomState = { root: null, selectorMap: new Map() };
	const pageInfo: PageInfo = {
		viewportWidth: 1280,
		viewportHeight: 720,
		pageWidth: 1280,
		pageHeight: 4200,
		scrollX: 0,
		scrollY: 0,
		pixelsAbove: 0,
		pixelsBelow: 3480,
		pixelsLeft: 0,
		pixelsRight: 0,
	};
	const summary: BrowserStateSummary = {
		url: 'http://127.0.0.1:8080/page.html',
		title: 'Fixture',
		tabs: [toTabInfo({ targetId: 'TARGET-BEEF', url: 'http://127.0.0.1:8080/page.html', title: 'Fixture' })],
		screenshot: null,
		domState,
		pageInfo,
		isPdfViewer: false,
		pendingNetworkRequests: [{
			url: 'http://127.0.0.1:8080/x.js',
			method: 'GET',
			loadingDurationMs: 12,
			resourceType: 'Script',
		}],
		browserErrors: [],
		recentEvents: null,
		closedPopupMessages: ['[alert] saved'],
		paginationButtonsDetected: false,
		stateError: null,
		stateToken: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
		frames: [],
		captureTruncated: false,
	};
	assertEquals(summary.tabs[0]?.tabId, 'BEEF');
	assertEquals(summary.domState.selectorMap.size, 0, 'the fallback state carries an empty selectorMap (R6.4)');

	const storage: StorageState = {
		cookies: [{
			name: 'sid',
			value: 'x',
			domain: '127.0.0.1',
			path: '/',
			expires: -1,
			httpOnly: true,
			secure: false,
			sameSite: 'Lax',
		}],
		origins: [{ origin: 'http://127.0.0.1:8080', localStorage: [{ name: 'k', value: 'v' }], sessionStorage: [] }],
	};
	assertEquals(storage.cookies.length, 1);
});

Deno.test('captcha: CaptchaWaitResult carries the §5.1.7 outcome vocabulary', () => {
	const skipped: CaptchaWaitResult = { waited: false, result: 'unknown' };
	const solved: CaptchaWaitResult = {
		waited: true,
		vendor: 'vendor-x',
		url: 'http://127.0.0.1:8080/checkout',
		durationMs: 4200,
		result: 'success',
	};
	assertEquals(skipped.waited, false);
	assertEquals(solved.result, 'success');
});
