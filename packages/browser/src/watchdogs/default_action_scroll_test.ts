/**
 * Scroll-path contract (ARCHITECTURE.md §6.10 "scroll (page gesture / element wheel / iframe JS)" and
 * "scroll-to-text (`DOM.performSearch` + fallback)").
 *
 * The arithmetic is pure; the three paths are asserted on real CDP frames over `ChromeFixture`.
 * Whether a real document actually moves is the browser tier's job
 * (`packages/core/tests/integration/event_ScrollEvent_test.ts`).
 */

import { assertEquals } from '@std/assert';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture } from '../browser/cdp_fixture_test.ts';
import type { NodeHandle } from './default_action_dom.ts';
import {
	chooseCandidate,
	SCROLL_TO_TEXT_MAX_CANDIDATES,
	scrollDeltas,
	scrollElement,
	scrollFrame,
	scrollFrameElement,
	scrollToText,
} from './default_action_scroll.ts';

interface Wired extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly client: CdpClient;
	readonly handle: NodeHandle;
}

async function wire(): Promise<Wired> {
	const fixture = ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	return {
		fixture,
		client,
		handle: { client, sessionId: 'SESSION0001', backendNodeId: 5 },
		[Symbol.asyncDispose]: async () => {
			await client.close();
			await fixture.close();
		},
	};
}

/** Answers `DOM.resolveNode` + `Runtime.callFunctionOn` from a queue of values. */
function scriptCalls(fixture: ChromeFixture, values: readonly unknown[]): void {
	let index = 0;
	fixture.script('DOM.resolveNode', (request, self) => {
		self.reply(request.id, { object: { type: 'object', objectId: 'OBJECT-1' } });
	});
	fixture.script('Runtime.callFunctionOn', (request, self) => {
		const value = values[Math.min(index, values.length - 1)];
		index += 1;
		self.reply(request.id, { result: { type: 'object', value } });
	});
}

Deno.test('scroll: deltas point the way the content moves', () => {
	assertEquals(scrollDeltas('down', 300), { deltaX: 0, deltaY: 300 });
	assertEquals(scrollDeltas('up', 300), { deltaX: 0, deltaY: -300 });
	assertEquals(scrollDeltas('right', 120), { deltaX: 120, deltaY: 0 });
	assertEquals(scrollDeltas('left', 120), { deltaX: -120, deltaY: 0 });
	assertEquals(scrollDeltas('down', -50), { deltaX: 0, deltaY: 50 }, 'a negative amount is a magnitude');
});

Deno.test('scroll: an element wheel is dispatched over the element, then scripted if nothing moved', async () => {
	await using wired = await wire();
	// scrollTop before → after the wheel (moved), for the wheel path.
	scriptCalls(wired.fixture, [[0, 0], [0, 250]]);

	const moved = await scrollElement({
		handle: wired.handle,
		pageSessionId: 'SESSION0001',
		point: { x: 400, y: 300 },
		direction: 'down',
		amount: 250,
	});
	assertEquals(moved, { strategy: 'elementWheel', deltaX: 0, deltaY: 250, movedBy: 250 });
	const wheel = wired.fixture.requestsFor('Input.dispatchMouseEvent')[0];
	assertEquals(wheel?.params.type, 'mouseWheel');
	assertEquals([wheel?.params.x, wheel?.params.y], [400, 300], 'the wheel must land over the element');

	// A container that swallows the wheel: same offsets before and after, then the script moves it.
	scriptCalls(wired.fixture, [[0, 0], [0, 0], [0, 90]]);
	const scripted = await scrollElement({
		handle: wired.handle,
		pageSessionId: 'SESSION0001',
		point: { x: 1, y: 1 },
		direction: 'down',
		amount: 90,
	});
	assertEquals(scripted.strategy, 'elementScript');
	assertEquals(scripted.movedBy, 90);
});

Deno.test('scroll: an element with no geometry skips the wheel and goes straight to script', async () => {
	await using wired = await wire();
	scriptCalls(wired.fixture, [[0, 0], [0, 40]]);
	const outcome = await scrollElement({
		handle: wired.handle,
		pageSessionId: 'SESSION0001',
		point: null,
		direction: 'down',
		amount: 40,
	});
	assertEquals(outcome.strategy, 'elementScript');
	assertEquals(wired.fixture.requestsFor('Input.dispatchMouseEvent').length, 0);
});

Deno.test('scroll: an out-of-process frame is scrolled inside its own session', async () => {
	await using wired = await wire();
	let reads = 0;
	wired.fixture.script('Runtime.evaluate', (request, self) => {
		const expression = String(request.params.expression);
		if (!expression.includes('scrollX')) {
			self.reply(request.id, { result: { type: 'undefined' } });
			return;
		}
		reads += 1;
		self.reply(request.id, { result: { type: 'string', value: reads === 1 ? '[0,0]' : '[0,500]' } });
	});

	const outcome = await scrollFrame({
		client: wired.client,
		frameSessionId: 'CHILD-SESSION',
		direction: 'down',
		amount: 500,
	});
	assertEquals(outcome, { strategy: 'iframeScript', deltaX: 0, deltaY: 500, movedBy: 500 });
	assertEquals(wired.fixture.requestsFor('Input.dispatchMouseEvent').length, 0, 'a wheel never reaches an OOPIF');
	assertEquals(
		wired.fixture.requestsFor('Runtime.evaluate').every((frame) => frame.sessionId === 'CHILD-SESSION'),
		true,
	);
});

Deno.test('scroll: a same-process iframe element is scrolled through its contentWindow', async () => {
	await using wired = await wire();
	scriptCalls(wired.fixture, [[0, 0, 0, 300]]);
	const outcome = await scrollFrameElement(wired.handle, 'down', 300);
	assertEquals(outcome, { strategy: 'iframeScript', deltaX: 0, deltaY: 300, movedBy: 300 });
});

Deno.test('scroll: a cross-origin frame element reports "none" instead of throwing', async () => {
	await using wired = await wire();
	scriptCalls(wired.fixture, [null]);
	assertEquals((await scrollFrameElement(wired.handle, 'down', 300)).strategy, 'none');
});

Deno.test('scroll-to-text: direction orders candidates around the current scroll offset', () => {
	const candidates = [{ top: 100 }, { top: 900 }, { top: 1_800 }];
	assertEquals(chooseCandidate(candidates, 800, 'down'), { top: 900 });
	assertEquals(chooseCandidate(candidates, 800, 'up'), { top: 100 });
	assertEquals(chooseCandidate(candidates, 800, null), { top: 100 }, 'no direction means document order');
	assertEquals(chooseCandidate(candidates, 5_000, 'down'), { top: 100 }, 'nothing below: fall back to the first');
	assertEquals(chooseCandidate(candidates, 0, 'up'), { top: 100 }, 'nothing above: fall back to the first');
});

Deno.test('scroll-to-text: DOM.performSearch drives the primary path and discards its results', async () => {
	await using wired = await wire();
	wired.fixture.script('DOM.performSearch', (request, self) => {
		self.reply(request.id, { searchId: 'SEARCH-1', resultCount: 2 });
	});
	wired.fixture.script('DOM.getSearchResults', (request, self) => {
		self.reply(request.id, { nodeIds: [11, 12] });
	});
	wired.fixture.script('DOM.describeNode', (request, self) => {
		self.reply(request.id, {
			node: { nodeId: 11, backendNodeId: 21, nodeType: 3, nodeName: '#text', localName: '', nodeValue: 'hit' },
		});
	});
	wired.fixture.script('Runtime.evaluate', (request, self) => {
		self.reply(request.id, { result: { type: 'string', value: '[0,0]' } });
	});
	scriptCalls(wired.fixture, [1_200]);

	const result = await scrollToText({
		client: wired.client,
		sessionId: 'SESSION0001',
		text: 'find me',
		direction: 'down',
	});
	assertEquals(result.found, true);
	assertEquals(result.strategy, 'performSearch');
	assertEquals(wired.fixture.requestsFor('DOM.scrollIntoViewIfNeeded')[0]?.params.backendNodeId, 21);
	assertEquals(wired.fixture.requestsFor('DOM.discardSearchResults').length, 1, 'search results must not leak');
	assertEquals(SCROLL_TO_TEXT_MAX_CANDIDATES, 10);
});

Deno.test('scroll-to-text: the text walker rescues what performSearch cannot see', async () => {
	await using wired = await wire();
	wired.fixture.script('DOM.performSearch', (request, self) => {
		self.reply(request.id, { searchId: 'SEARCH-1', resultCount: 0 });
	});
	wired.fixture.script('Runtime.evaluate', (request, self) => {
		const expression = String(request.params.expression);
		if (expression.includes('createTreeWalker')) {
			self.reply(request.id, { result: { type: 'string', value: JSON.stringify({ found: true, candidates: 3 }) } });
			return;
		}
		self.reply(request.id, { result: { type: 'string', value: '[0,0]' } });
	});

	const result = await scrollToText({
		client: wired.client,
		sessionId: 'SESSION0001',
		text: 'inside a shadow root',
		direction: null,
	});
	assertEquals(result, { found: true, strategy: 'textWalker', candidates: 3 });
});
