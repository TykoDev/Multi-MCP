/**
 * Click-cascade geometry contract (ARCHITECTURE.md §6.10 "scrollIntoView → geometry fallback chain →
 * occlusion check → mouse move/press/release with 3s/5s caps"; §8 timing hierarchy).
 *
 * Two tiers, no mocks (D-TEST1): the arithmetic is pinned as pure functions, and the CDP-shaped half
 * runs against `ChromeFixture` — a real `Deno.serve` listener speaking real CDP frames — so the wire
 * shape of every `Input.dispatchMouseEvent` and the order of the fallback chain are asserted on
 * actual protocol traffic. The same paths run against real Chromium in
 * `packages/core/tests/integration/watchdog_action_test.ts`.
 */

import { assert, assertEquals } from '@std/assert';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture } from '../browser/cdp_fixture_test.ts';
import {
	checkOcclusion,
	clampToViewport,
	dispatchMouseClick,
	largestQuadCentre,
	MOUSE_PRESS_TIMEOUT_MS,
	MOUSE_RELEASE_TIMEOUT_MS,
	quadCentre,
	readViewportMetrics,
	resolveClickPoint,
	scrollNodeIntoView,
	type ViewportMetrics,
} from './default_action_geometry.ts';
import type { NodeHandle } from './default_action_dom.ts';

const METRICS: ViewportMetrics = {
	width: 800,
	height: 600,
	scrollX: 0,
	scrollY: 0,
	pageWidth: 800,
	pageHeight: 2400,
};

/** A rectangle as CDP flattens it: 4 points, 8 numbers, clockwise from the top-left. */
function rectQuad(x: number, y: number, width: number, height: number): number[] {
	return [x, y, x + width, y, x + width, y + height, x, y + height];
}

// ---------------------------------------------------------------------------
// pure arithmetic
// ---------------------------------------------------------------------------

Deno.test('geometry: a quad yields its centre and its true (shoelace) area', () => {
	const centre = quadCentre(rectQuad(10, 20, 100, 40));
	assertEquals(centre, { x: 60, y: 40, area: 4000 });

	// A 45°-rotated square: the naive width×height would be wrong, the shoelace area is not.
	const rotated = quadCentre([50, 0, 100, 50, 50, 100, 0, 50]);
	assertEquals(rotated?.x, 50);
	assertEquals(rotated?.y, 50);
	assertEquals(rotated?.area, 5000);
});

Deno.test('geometry: degenerate quads are rejected rather than clicked at (0, 0)', () => {
	assertEquals(quadCentre([]), null);
	assertEquals(quadCentre([1, 2, 3, 4]), null, 'a truncated quad is not a quad');
	assertEquals(quadCentre(rectQuad(10, 10, 0, 40)), null, 'zero width has no area');
	assertEquals(largestQuadCentre([]), null);
});

Deno.test('geometry: an inline element wrapped over lines is clicked on its largest fragment', () => {
	const smallFragment = rectQuad(700, 10, 60, 20);
	const largeFragment = rectQuad(0, 34, 400, 20);
	assertEquals(largestQuadCentre([smallFragment, largeFragment]), { x: 200, y: 44 });
});

Deno.test('geometry: a point outside the viewport is pulled back inside it', () => {
	assertEquals(clampToViewport({ x: 100, y: 200 }, METRICS), { x: 100, y: 200, clamped: false });
	assertEquals(clampToViewport({ x: -5, y: 200 }, METRICS), { x: 0, y: 200, clamped: true });
	assertEquals(clampToViewport({ x: 100, y: 900 }, METRICS), { x: 100, y: 599, clamped: true });
});

Deno.test('geometry: the §8 mouse caps are 3 s press / 5 s release, verbatim', () => {
	assertEquals(MOUSE_PRESS_TIMEOUT_MS, 3_000);
	assertEquals(MOUSE_RELEASE_TIMEOUT_MS, 5_000);
});

// ---------------------------------------------------------------------------
// the fallback chain, over real CDP frames
// ---------------------------------------------------------------------------

interface Wired extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly client: CdpClient;
	readonly handle: NodeHandle;
}

async function wire(): Promise<Wired> {
	const fixture = ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	const handle: NodeHandle = { client, sessionId: 'SESSION0001', backendNodeId: 42 };
	return {
		fixture,
		client,
		handle,
		[Symbol.asyncDispose]: async () => {
			await client.close();
			await fixture.close();
		},
	};
}

/** Answers `DOM.resolveNode` + `Runtime.callFunctionOn` with one JSON value. */
function scriptPageFunction(fixture: ChromeFixture, value: unknown): void {
	fixture.script('DOM.resolveNode', (request, self) => {
		self.reply(request.id, { object: { type: 'object', objectId: 'OBJECT-1' } });
	});
	fixture.script('Runtime.callFunctionOn', (request, self) => {
		self.reply(request.id, { result: { type: 'object', value } });
	});
}

Deno.test('geometry: the chain prefers content quads', async () => {
	await using wired = await wire();
	wired.fixture.script('DOM.getContentQuads', (request, self) => {
		self.reply(request.id, { quads: [rectQuad(100, 100, 40, 20)] });
	});

	const point = await resolveClickPoint({
		handle: wired.handle,
		sameSessionAsPage: true,
		absolutePosition: null,
		metrics: METRICS,
	});
	assertEquals(point, { x: 120, y: 110, strategy: 'contentQuads', clamped: false });
});

Deno.test('geometry: quads → box model → getBoundingClientRect, in that order', async () => {
	await using wired = await wire();
	wired.fixture.script('DOM.getContentQuads', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Could not compute content quads.' });
	});
	wired.fixture.script('DOM.getBoxModel', (request, self) => {
		self.reply(request.id, { model: { content: [], padding: [], border: rectQuad(0, 0, 200, 100), margin: [] } });
	});

	const viaBox = await resolveClickPoint({
		handle: wired.handle,
		sameSessionAsPage: true,
		absolutePosition: null,
		metrics: METRICS,
	});
	assertEquals(viaBox, { x: 100, y: 50, strategy: 'boxModel', clamped: false });

	wired.fixture.script('DOM.getBoxModel', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Could not compute box model.' });
	});
	scriptPageFunction(wired.fixture, { x: 10, y: 10, width: 60, height: 40 });

	const viaRect = await resolveClickPoint({
		handle: wired.handle,
		sameSessionAsPage: true,
		absolutePosition: null,
		metrics: METRICS,
	});
	assertEquals(viaRect, { x: 40, y: 30, strategy: 'boundingClientRect', clamped: false });
});

Deno.test('geometry: an out-of-process frame skips CDP geometry and uses absolutePosition − scroll', async () => {
	await using wired = await wire();
	let quadCalls = 0;
	wired.fixture.script('DOM.getContentQuads', (request, self) => {
		quadCalls++;
		self.reply(request.id, { quads: [rectQuad(0, 0, 10, 10)] });
	});

	const point = await resolveClickPoint({
		handle: wired.handle,
		sameSessionAsPage: false,
		absolutePosition: { x: 300, y: 1000, width: 100, height: 50 },
		metrics: { ...METRICS, scrollY: 800 },
	});
	// 300 + 50 = 350 across; 1000 + 25 − 800 = 225 down.
	assertEquals(point, { x: 350, y: 225, strategy: 'absolutePosition', clamped: false });
	assertEquals(quadCalls, 0, 'an OOPIF quad is frame-local and must never be used as a click point');
});

Deno.test('geometry: an element with no geometry anywhere yields no point, never a guessed one', async () => {
	await using wired = await wire();
	for (const method of ['DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.resolveNode']) {
		wired.fixture.script(method, (request, self) => {
			self.replyError(request.id, { code: -32000, message: 'No node with given id found' });
		});
	}
	const point = await resolveClickPoint({
		handle: wired.handle,
		sameSessionAsPage: true,
		absolutePosition: null,
		metrics: METRICS,
	});
	assertEquals(point, null);
});

Deno.test('geometry: scrollIntoViewIfNeeded failure is reported, never thrown', async () => {
	await using wired = await wire();
	assertEquals(await scrollNodeIntoView(wired.handle), true);
	wired.fixture.script('DOM.scrollIntoViewIfNeeded', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Node does not have a layout object' });
	});
	assertEquals(await scrollNodeIntoView(wired.handle), false);
});

Deno.test('geometry: layout metrics prefer the css* variants over the device-pixel ones', async () => {
	await using wired = await wire();
	wired.fixture.script('Page.getLayoutMetrics', (request, self) => {
		self.reply(request.id, {
			layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1600, clientHeight: 1200 },
			visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1600, clientHeight: 1200, scale: 2 },
			contentSize: { x: 0, y: 0, width: 1600, height: 4800 },
			cssLayoutViewport: { pageX: 0, pageY: 120, clientWidth: 800, clientHeight: 600 },
			cssVisualViewport: {
				offsetX: 0,
				offsetY: 0,
				pageX: 5,
				pageY: 120,
				clientWidth: 800,
				clientHeight: 600,
				scale: 1,
			},
			cssContentSize: { x: 0, y: 0, width: 800, height: 2400 },
		});
	});
	const metrics = await readViewportMetrics(wired.client, 'SESSION0001');
	assertEquals(metrics, { width: 800, height: 600, scrollX: 5, scrollY: 120, pageWidth: 800, pageHeight: 2400 });
});

// ---------------------------------------------------------------------------
// occlusion
// ---------------------------------------------------------------------------

Deno.test('geometry: the occlusion check reports what owns the pixel', async () => {
	await using wired = await wire();
	scriptPageFunction(wired.fixture, { reason: 'ok', occluded: false, hitTag: 'button' });
	assertEquals(await checkOcclusion(wired.handle), { occluded: false, hitTag: 'button', reason: 'ok' });

	scriptPageFunction(wired.fixture, { reason: 'ok', occluded: true, hitTag: 'div' });
	assertEquals(await checkOcclusion(wired.handle), { occluded: true, hitTag: 'div', reason: 'ok' });
});

Deno.test('geometry: an inconclusive occlusion probe counts as occluded, not as clear', async () => {
	await using wired = await wire();
	scriptPageFunction(wired.fixture, { reason: 'zero-size' });
	assertEquals((await checkOcclusion(wired.handle)).occluded, true);

	scriptPageFunction(wired.fixture, { reason: 'outside-viewport' });
	assertEquals((await checkOcclusion(wired.handle)).reason, 'outside-viewport');

	wired.fixture.script('DOM.resolveNode', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'No node with given id found' });
	});
	assertEquals(await checkOcclusion(wired.handle), { occluded: true, hitTag: null, reason: 'unavailable' });
});

// ---------------------------------------------------------------------------
// mouse synthesis
// ---------------------------------------------------------------------------

Deno.test('geometry: a click is move → press → release with the right button bits', async () => {
	await using wired = await wire();
	const outcome = await dispatchMouseClick({
		client: wired.client,
		sessionId: 'SESSION0001',
		x: 120.5,
		y: 240,
		button: 'left',
	});
	assertEquals(outcome, { moveTimedOut: false, pressTimedOut: false, releaseTimedOut: false });

	const frames = wired.fixture.requestsFor('Input.dispatchMouseEvent');
	assertEquals(frames.map((frame) => frame.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
	assertEquals(frames.map((frame) => frame.params.x), [120.5, 120.5, 120.5]);
	assertEquals(frames[0]?.params.button, 'none');
	assertEquals(frames[1]?.params.button, 'left');
	assertEquals(frames[1]?.params.buttons, 1, 'the press must carry the pressed-button bitfield');
	assertEquals(frames[1]?.params.clickCount, 1);
	assertEquals(frames[2]?.params.buttons, 0, 'the release must report no button still down');
	assertEquals(frames.every((frame) => frame.sessionId === 'SESSION0001'), true);
});

Deno.test("geometry: the right button maps onto CDP's bit 2", async () => {
	await using wired = await wire();
	await dispatchMouseClick({ client: wired.client, sessionId: 'SESSION0001', x: 1, y: 1, button: 'right' });
	assertEquals(wired.fixture.requestsFor('Input.dispatchMouseEvent')[1]?.params.buttons, 2);

	await dispatchMouseClick({ client: wired.client, sessionId: 'SESSION0001', x: 1, y: 1, button: 'middle' });
	assertEquals(wired.fixture.requestsFor('Input.dispatchMouseEvent')[4]?.params.buttons, 4);
});

Deno.test('geometry: a press that never answers is data, and the release is still attempted', async () => {
	await using wired = await wire();
	// A renderer busy with the click's consequences: the press reply never comes.
	wired.fixture.script('Input.dispatchMouseEvent', (request, self) => {
		if (request.params.type === 'mousePressed') return;
		self.reply(request.id);
	});

	const outcome = await dispatchMouseClick({
		client: wired.client,
		sessionId: 'SESSION0001',
		x: 10,
		y: 10,
		button: 'left',
		pressTimeoutMs: 60,
		releaseTimeoutMs: 60,
	});
	assertEquals(outcome.pressTimedOut, true, 'ERRATUM(M1-watchdogs-action-2): an expired cap is non-fatal');
	assertEquals(outcome.releaseTimedOut, false);
	const types = wired.fixture.requestsFor('Input.dispatchMouseEvent').map((frame) => frame.params.type);
	assert(types.includes('mouseReleased'), 'an un-released button would leave the page dragging');
});
