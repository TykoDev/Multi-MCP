/**
 * The server-drawn highlight (B2.2) with a scripted CDP client: the enable order U-7 measured, the
 * replace-before-draw rule, the bounded life, and the session an OOPIF node is drawn in.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { captureHarness } from '../fixtures/capture_session.ts';
import { ToolError } from './errors.ts';
import {
	clampTtl,
	hideHighlight,
	highlight,
	HIGHLIGHT_TTL_DEFAULT_MS,
	HIGHLIGHT_TTL_MAX_MS,
	HIGHLIGHT_TTL_MIN_MS,
} from './highlight.ts';

function connect(record: { session: unknown }, sessions: { top: string; child: string }, focus = 'T-top') {
	const calls: Array<{ method: string; sessionId: string; params: unknown }> = [];
	const log = (method: string) => (params: unknown, sessionId: string) => {
		calls.push({ method, sessionId, params });
		return Promise.resolve({});
	};
	const client = {
		send: {
			DOM: { enable: log('DOM.enable') },
			Overlay: {
				enable: log('Overlay.enable'),
				disable: log('Overlay.disable'),
				hideHighlight: log('Overlay.hideHighlight'),
				highlightNode: log('Overlay.highlightNode'),
				highlightRect: log('Overlay.highlightRect'),
			},
		},
	};
	const manager = {
		getOrCreateCdpSession(target: string | null, focus: boolean) {
			return Promise.resolve({ sessionId: focus ? sessions.top : sessions.child, targetId: target ?? 'top' });
		},
	};
	Object.assign(record.session as object, { cdpClient: client, sessionManager: manager, agentFocusTargetId: focus });
	return { calls, methods: () => calls.map((call) => call.method) };
}

Deno.test('highlight: ttl is clamped into the contract bounds and defaults when absent', () => {
	assertEquals(clampTtl(undefined), HIGHLIGHT_TTL_DEFAULT_MS);
	assertEquals(clampTtl(Number.NaN), HIGHLIGHT_TTL_DEFAULT_MS);
	assertEquals(clampTtl(1), HIGHLIGHT_TTL_MIN_MS);
	assertEquals(clampTtl(10_000_000), HIGHLIGHT_TTL_MAX_MS);
	assertEquals(clampTtl(2500.4), 2500);
});

Deno.test('highlight: a rect is drawn in the page session after DOM.enable and Overlay.enable, in that order (U-7)', async () => {
	const h = await captureHarness('iframe_crossorigin');
	using time = new FakeTime();
	try {
		const { calls, methods } = connect(h.record, { top: 'S-top', child: 'S-child' });
		const outcome = await highlight(h.record, { bounds: { x: 10.4, y: 20, w: 0.2, h: 30 } }, 500);
		assertEquals(outcome, { ttlMs: 500, sessionId: 'S-top' });
		assertEquals(methods(), ['DOM.enable', 'Overlay.enable', 'Overlay.highlightRect']);
		const rect = calls[2]?.params as { x: number; y: number; width: number; height: number };
		assertEquals([rect.x, rect.y, rect.width, rect.height], [10, 20, 1, 30], 'rounded, never zero-sized');
		assert(h.record.highlight !== undefined);

		// The bounded life: after the TTL the outline is hidden and the domain disabled.
		time.tick(499);
		assertEquals(methods().length, 3);
		time.tick(2);
		await time.runMicrotasks();
		assertEquals(methods().slice(3), ['Overlay.hideHighlight', 'Overlay.disable']);
		assertEquals(h.record.highlight, undefined);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('highlight: a node is drawn in its own session, and a second highlight hides the first before drawing', async () => {
	const h = await captureHarness('iframe_crossorigin');
	using _time = new FakeTime();
	try {
		const state = h.record.session.cachedBrowserState;
		assert(state !== null);
		// The focus is the capture's own top target, so a top-document node is recognised as the page's.
		const topTarget = [...state.domState.selectorMap.values()].find((node) => node.attributes.id === 'host-button')
			?.targetId;
		assert(topTarget !== undefined);
		const { calls, methods } = connect(h.record, { top: 'S-top', child: 'S-child' }, topTarget);
		const [top] = [...state.domState.selectorMap.entries()].find(([, node]) => node.attributes.id === 'host-button') ??
			[];
		const [child] = [...state.domState.selectorMap.entries()].find(([, node]) => node.attributes.id === 'xo-button') ??
			[];
		assert(top !== undefined && child !== undefined);

		// The top-document node: the page session. The OOPIF node has a different targetId from the
		// focus, so its overlay is drawn in the child session (the ids only mean something there).
		const first = await highlight(h.record, { index: top });
		assertEquals(first.sessionId, 'S-top');
		assertEquals(methods(), ['DOM.enable', 'Overlay.enable', 'Overlay.highlightNode']);
		const second = await highlight(h.record, { index: child }, 1000);
		assertEquals(second.sessionId, 'S-child');
		assertEquals(methods().slice(3), [
			'Overlay.hideHighlight',
			'Overlay.disable',
			'DOM.enable',
			'Overlay.enable',
			'Overlay.highlightNode',
		]);
		assertEquals(calls[3]?.sessionId, 'S-top', 'the first outline is hidden where it was drawn');
		assertEquals(calls[7]?.sessionId, 'S-child');
		assertEquals(
			(calls[7]?.params as { backendNodeId: number }).backendNodeId,
			state.domState.selectorMap.get(child)?.backendNodeId,
		);

		await hideHighlight(h.record);
		assertEquals(h.record.highlight, undefined);
		// Idempotent: nothing to hide is not an error.
		await hideHighlight(h.record);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('highlight: refusals — both or neither target, an unknown index, a disconnected session', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		const disconnected = await assertRejects(
			() => highlight(h.record, { bounds: { x: 0, y: 0, w: 1, h: 1 } }),
			ToolError,
		);
		assertEquals(disconnected.code, 'browser-unavailable');
		connect(h.record, { top: 'S-top', child: 'S-child' });
		const both = await assertRejects(
			() => highlight(h.record, { index: 1, bounds: { x: 0, y: 0, w: 1, h: 1 } }),
			ToolError,
		);
		assertEquals(both.code, 'invalid-arguments');
		const neither = await assertRejects(() => highlight(h.record, {}), ToolError);
		assertEquals(neither.code, 'invalid-arguments');
		const unknown = await assertRejects(() => highlight(h.record, { index: 999_999 }), ToolError);
		assertEquals(unknown.code, 'unknown-index');
		assertEquals(h.record.highlight, undefined, 'a refused highlight arms no timer');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('highlight: closing the session disarms the timer', async () => {
	const h = await captureHarness('iframe_crossorigin');
	using time = new FakeTime();
	const { methods } = connect(h.record, { top: 'S-top', child: 'S-child' });
	await highlight(h.record, { bounds: { x: 0, y: 0, w: 5, h: 5 } }, 5000);
	assert(h.record.highlight !== undefined);
	await h.registry.close('default');
	assertEquals(h.record.highlight, undefined);
	time.tick(6000);
	await time.runMicrotasks();
	assert(!methods().includes('Overlay.hideHighlight'), 'no hide after close: the timer was cleared');
	await h.registry.shutdown();
});
