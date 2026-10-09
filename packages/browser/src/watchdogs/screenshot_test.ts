/**
 * `ScreenshotWatchdog` contract (ARCHITECTURE.md §6.6; COMPLETIONS-CRITERIA.md §3.2 watchdog row 6:
 * "focus validation/repair, highlight removal, PNG base64 result").
 *
 * Real bus, real `CdpClient`, real `SessionManager`, real CDP frames over `ChromeFixture` — no mocks
 * (D-TEST1). The capture is asserted on the wire: format, clip, and the highlight-removal call that
 * MUST precede it.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { ScreenshotEvent } from '../events.ts';
import { BrowserError } from '../errors.ts';
import { createBrowserProfile } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import {
	HIGHLIGHT_CONTAINER_ID,
	HIGHLIGHT_ELEMENT_ATTRIBUTE,
	MAX_SCREENSHOT_DIMENSION_PX,
	REMOVE_HIGHLIGHTS_EXPRESSION,
	ScreenshotWatchdog,
} from './screenshot.ts';

const PNG = 'iVBORw0KGgo=';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly watchdog: ScreenshotWatchdog;
	sent(method: string): FixtureRequest[];
}

async function harness(options: { pages?: readonly string[]; focus?: boolean } = {}): Promise<Harness> {
	const fixture = ChromeFixture.start(options.pages === undefined ? {} : { pages: options.pages });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'screenshot-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();

	const page = manager.mostRecentPageTarget();
	if (options.focus !== false && page !== null) {
		await manager.setAgentFocus(page.targetId, { activate: false, announce: false });
	}

	fixture.script('Page.captureScreenshot', (request, self) => {
		self.reply(request.id, { data: PNG });
	});
	fixture.script('Runtime.evaluate', (request, self) => {
		self.reply(request.id, { result: { type: 'number', value: 2 } });
	});

	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new ScreenshotWatchdog(host);
	watchdog.attach();

	return {
		fixture,
		bus,
		manager,
		watchdog,
		sent: (method) => fixture.requestsFor(method),
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await manager.stop();
			await bus.stop();
			await client.close();
			await fixture.close();
		},
	};
}

function scriptLayoutMetrics(fixture: ChromeFixture, contentHeight: number): void {
	fixture.script('Page.getLayoutMetrics', (request, self) => {
		self.reply(request.id, {
			layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
			visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 1 },
			contentSize: { x: 0, y: 0, width: 800, height: contentHeight },
			cssContentSize: { x: 0, y: 0, width: 800, height: contentHeight },
		});
	});
}

Deno.test('screenshot: LISTENS_TO is exactly ScreenshotEvent', async () => {
	await using h = await harness();
	assertEquals(ScreenshotWatchdog.LISTENS_TO.length, 1);
	assertEquals(h.bus.handlerCount(ScreenshotEvent), 1);
});

Deno.test('screenshot: a viewport capture is PNG, unclipped, and returns bare base64', async () => {
	await using h = await harness();
	const data = await h.bus.dispatch(new ScreenshotEvent()).eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(data, PNG, 'the result is the base64 payload with no data: prefix');
	const capture = h.sent('Page.captureScreenshot')[0];
	assertEquals(capture?.params.format, 'png');
	assertEquals(capture?.params.clip, undefined);
	assertEquals(capture?.params.captureBeyondViewport, false);
	assertEquals(capture?.sessionId, h.manager.sessions.keys().next().value);
});

Deno.test('screenshot: highlights are removed before the shutter, not after', async () => {
	await using h = await harness();
	await h.bus.dispatch(new ScreenshotEvent()).eventResult({ raiseIfAny: true });

	const evaluate = h.sent('Runtime.evaluate')[0];
	assert(evaluate !== undefined, 'the removal script must run');
	assertStringIncludes(String(evaluate.params.expression), HIGHLIGHT_CONTAINER_ID);
	assertStringIncludes(String(evaluate.params.expression), HIGHLIGHT_ELEMENT_ATTRIBUTE);

	const all = h.fixture.requests.map((frame) => frame.method);
	assert(
		all.indexOf('Runtime.evaluate') < all.indexOf('Page.captureScreenshot'),
		'a screenshot with numbered boxes drawn on it describes a different page than the DOM text does',
	);
});

Deno.test('screenshot: the removal script is idempotent and names both marker forms', () => {
	assertEquals(HIGHLIGHT_CONTAINER_ID, 'bua-highlight-container');
	assertEquals(HIGHLIGHT_ELEMENT_ATTRIBUTE, 'data-bua-highlight');
	assertStringIncludes(REMOVE_HIGHLIGHTS_EXPRESSION, 'getElementById');
	assertStringIncludes(REMOVE_HIGHLIGHTS_EXPRESSION, 'querySelectorAll');
});

Deno.test('screenshot: a page that refuses the removal script is still photographed', async () => {
	await using h = await harness();
	h.fixture.script('Runtime.evaluate', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Execution context was destroyed.' });
	});
	const data = await h.bus.dispatch(new ScreenshotEvent()).eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(data, PNG);
});

Deno.test('screenshot: fullPage derives its clip from the content size', async () => {
	await using h = await harness();
	scriptLayoutMetrics(h.fixture, 2_400);

	await h.bus.dispatch(new ScreenshotEvent({ fullPage: true })).eventResult({ raiseIfAny: true });

	const capture = h.sent('Page.captureScreenshot')[0];
	assertEquals(capture?.params.captureBeyondViewport, true);
	assertEquals(capture?.params.clip, { x: 0, y: 0, width: 800, height: 2_400, scale: 1 });
});

Deno.test("screenshot: an endless page is truncated at Chrome's texture limit, not failed", async () => {
	await using h = await harness();
	scriptLayoutMetrics(h.fixture, 250_000);

	await h.bus.dispatch(new ScreenshotEvent({ fullPage: true })).eventResult({ raiseIfAny: true });

	const clip = h.sent('Page.captureScreenshot')[0]?.params.clip as Record<string, number>;
	assertEquals(clip.height, MAX_SCREENSHOT_DIMENSION_PX, 'ERRATUM(M1-watchdogs-action-11)');
	assertEquals(MAX_SCREENSHOT_DIMENSION_PX, 16_384);
});

Deno.test('screenshot: an explicit clip wins over fullPage and needs no layout metrics', async () => {
	await using h = await harness();
	await h.bus
		.dispatch(new ScreenshotEvent({ fullPage: true, clip: { x: 10, y: 20, width: 30, height: 40 } }))
		.eventResult({ raiseIfAny: true });

	assertEquals(h.sent('Page.captureScreenshot')[0]?.params.clip, { x: 10, y: 20, width: 30, height: 40, scale: 1 });
	assertEquals(h.sent('Page.getLayoutMetrics').length, 0);
});

Deno.test('screenshot: an unset focus is repaired onto a live page target', async () => {
	await using h = await harness({ focus: false });
	assertEquals(h.manager.agentFocusTargetId, null);

	const data = await h.bus.dispatch(new ScreenshotEvent()).eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(data, PNG);
	assertEquals(h.manager.agentFocusTargetId, h.manager.mostRecentPageTarget()?.targetId);
	assertEquals(h.sent('Target.activateTarget').length, 1, 'the repaired tab is brought forward');
});

Deno.test('screenshot: a focus naming a dead target is repaired rather than failing the capture', async () => {
	await using h = await harness();
	const stale = h.manager.agentFocusTargetId;
	assert(stale !== null);
	const survivor = h.fixture.addPage('about:blank');
	await h.manager.whenIdle();
	h.fixture.removeTarget(stale);
	await h.manager.whenIdle();

	const data = await h.bus.dispatch(new ScreenshotEvent()).eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(data, PNG);
	assertEquals(h.manager.agentFocusTargetId, survivor);
});

Deno.test('screenshot: a browser with no page target is a typed error carrying a memory line', async () => {
	await using h = await harness({ pages: [] });
	const error = await assertRejects(
		() => h.bus.dispatch(new ScreenshotEvent()).eventResult({ raiseIfAny: true, raiseIfNone: true }),
		BrowserError,
		'no page target',
	);
	assertEquals(error.longTermMemory, 'Screenshot failed: no page was open');
});
