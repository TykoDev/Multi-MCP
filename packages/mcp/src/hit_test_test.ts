/**
 * The hit test (B2.1) over the recorded `iframe_crossorigin` capture, with a scripted CDP client.
 *
 * The capture is real (D-TEST1): the element table, the reverse map's keys, the frame list and the
 * OOPIF's own session id are what real Chromium produced against the shared corpus. Only the two
 * CDP round trips are scripted, with exactly the shapes U-2 measured on real Chromium
 * (`tests/e2e/element_at_e2e_test.ts`): the page session answers an OOPIF point with the host
 * `<iframe>` in the top document's id space, and `DOM.getNodeForLocation` takes document
 * coordinates, so the scroll offset the browser reports is added before the ask.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { EnhancedDomTreeNode } from '@tykotech/browser';
import { walkTree } from '@tykotech/browser';
import { captureHarness } from '../fixtures/capture_session.ts';
import { ToolError } from './errors.ts';
import { HIT_TEST_MAX_DESCENT, hitTest } from './hit_test.ts';
import { elementAtPoint } from './tools/perception.ts';
import { resolveFields } from './element_record.ts';
import { OUTPUT } from './schemas.ts';
import { browserElementAt } from './tools.ts';

interface Scripted {
	/** `sessionId` → what `DOM.getNodeForLocation` answers there, or an error message to throw. */
	readonly located: Record<string, { backendNodeId: number; frameId: string } | string>;
	/** `sessionId` → the layout viewport scroll the browser reports there. */
	readonly scroll?: Record<string, { pageX: number; pageY: number }>;
	/** `backendNodeId` → what `DOM.describeNode` answers on the page session. */
	readonly described?: Record<number, { nodeName: string; frameId?: string }>;
	/** The host iframe's content box origin, as `DOM.getBoxModel` reports it. */
	readonly box?: { x: number; y: number };
	/**
	 * A1: pseudo-element `backendNodeId` → the element `CSSPseudoElement.element` names in the isolated world.
	 * A node absent here resolves to an ordinary element, which is not a pseudo-element.
	 */
	readonly pseudo?: Record<number, number>;
	/** A1: how many `DOM.resolveNode` calls fail before one succeeds (a world whose document is gone). */
	readonly staleWorlds?: number;
	/**
	 * R3-2: context ids that now belong to a page's own main world (a cross-process navigation reused them). Such a
	 * context holds no brand this server defined, and its `CSSPseudoElement.element` answers the id named here.
	 */
	readonly liar?: ReadonlyMap<number, number>;
}

/**
 * The global of each context this fake has seen branded: context id → (property name → value). Shared across
 * `connect` calls on purpose — a world branded before a navigation keeps its brand in the old process only, which
 * the `liar` map models by answering for the same id without it.
 */
type Globals = Map<number, Map<string, string>>;

/** A minimal scripted client/manager pair standing in for the CDP transport. */
function connect(
	record: { session: unknown },
	script: Scripted,
	sessions: { top: string; child: string },
	globals: Globals = new Map(),
	firstWorld = 1,
) {
	const calls: Array<{ method: string; sessionId: string; params: unknown }> = [];
	let worlds = firstWorld - 1;
	let stale = script.staleWorlds ?? 0;
	const client = {
		send: {
			Page: {
				createIsolatedWorld(params: unknown, sessionId: string) {
					calls.push({ method: 'Page.createIsolatedWorld', sessionId, params });
					worlds += 1;
					return Promise.resolve({ executionContextId: 900 + worlds });
				},
				getLayoutMetrics(_params: unknown, sessionId: string) {
					calls.push({ method: 'Page.getLayoutMetrics', sessionId, params: undefined });
					const scroll = script.scroll?.[sessionId] ?? { pageX: 0, pageY: 0 };
					return Promise.resolve({
						layoutViewport: { ...scroll, clientWidth: 1280, clientHeight: 900 },
						cssLayoutViewport: { ...scroll, clientWidth: 1280, clientHeight: 900 },
						visualViewport: { ...scroll, offsetX: 0, offsetY: 0, clientWidth: 1280, clientHeight: 900, scale: 1 },
						contentSize: { x: 0, y: 0, width: 1280, height: 2000 },
					});
				},
			},
			Runtime: {
				evaluate(params: { expression: string; contextId: number }, sessionId: string) {
					calls.push({ method: 'Runtime.evaluate', sessionId, params });
					// The only evaluation the hit test makes: defining a world's brand on its global.
					const brand = /defineProperty\(globalThis, "([^"]+)", \{ value: "([^"]+)" \}\)/.exec(params.expression);
					if (brand === null) return Promise.reject(new Error(`unexpected expression ${params.expression}`));
					const global = globals.get(params.contextId) ?? new Map<string, string>();
					global.set(brand[1]!, brand[2]!);
					globals.set(params.contextId, global);
					return Promise.resolve({ result: { type: 'boolean', value: true } });
				},
				callFunctionOn(
					params: { objectId: string; functionDeclaration: string; arguments?: Array<{ value: string }> },
					sessionId: string,
				) {
					calls.push({ method: 'Runtime.callFunctionOn', sessionId, params });
					// The handle names the pseudo-element and the context it was resolved in.
					const [handle = '', context = ''] = params.objectId.split('@');
					const contextId = Number(context);
					// The brand check the function opens with, when it carries one, run against that context's global. A
					// function without one simply runs there — and a lying context answers with its lie.
					const [key, nonce] = (params.arguments ?? []).map((argument) => argument.value);
					const lying = script.liar?.get(contextId);
					if (key !== undefined && (lying === undefined ? globals.get(contextId)?.get(key) : undefined) !== nonce) {
						return Promise.resolve({
							result: { type: 'object', subtype: 'error' },
							exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: ttk-isolated-world-mismatch' } },
						});
					}
					const pseudoId = Number(handle.replace('pseudo-', ''));
					const host = lying ?? script.pseudo?.[pseudoId];
					return Promise.resolve({
						result: host === undefined
							? { type: 'object', subtype: 'null' }
							: { type: 'object', objectId: `el-${host}` },
					});
				},
				releaseObjectGroup(params: unknown, sessionId: string) {
					calls.push({ method: 'Runtime.releaseObjectGroup', sessionId, params });
					return Promise.resolve({});
				},
			},
			DOM: {
				getNodeForLocation(params: unknown, sessionId: string) {
					calls.push({ method: 'DOM.getNodeForLocation', sessionId, params });
					const answer = script.located[sessionId];
					if (answer === undefined) return Promise.reject(new Error('No node found at given location'));
					if (typeof answer === 'string') return Promise.reject(new Error(answer));
					return Promise.resolve(answer);
				},
				resolveNode(params: { backendNodeId: number; executionContextId?: number }, sessionId: string) {
					calls.push({ method: 'DOM.resolveNode', sessionId, params });
					if (stale > 0) {
						stale -= 1;
						return Promise.reject(new Error('Cannot find context with specified id'));
					}
					const isPseudo = script.pseudo?.[params.backendNodeId] !== undefined;
					return Promise.resolve({
						object: {
							type: 'object',
							className: isPseudo ? 'CSSPseudoElement' : 'HTMLDivElement',
							objectId: `pseudo-${params.backendNodeId}@${params.executionContextId}`,
						},
					});
				},
				describeNode(params: { backendNodeId?: number; objectId?: string }, sessionId: string) {
					calls.push({ method: 'DOM.describeNode', sessionId, params });
					if (params.objectId !== undefined) {
						return Promise.resolve({ node: { nodeName: 'I', backendNodeId: Number(params.objectId.slice(3)) } });
					}
					const backendNodeId = params.backendNodeId ?? 0;
					const node = script.described?.[backendNodeId] ?? { nodeName: 'BUTTON' };
					return Promise.resolve({ node: { ...node, backendNodeId } });
				},
				getBoxModel(params: unknown, sessionId: string) {
					calls.push({ method: 'DOM.getBoxModel', sessionId, params });
					const box = script.box ?? { x: 0, y: 0 };
					return Promise.resolve({
						model: { content: [box.x, box.y, box.x + 500, box.y, box.x + 500, box.y + 200, box.x, box.y + 200] },
					});
				},
			},
		},
	};
	const manager = {
		getOrCreateCdpSession(target: string | null, focus: boolean) {
			return Promise.resolve({ sessionId: focus ? sessions.top : sessions.child, targetId: target ?? 'top' });
		},
	};
	Object.assign(record.session as object, { cdpClient: client, sessionManager: manager, agentFocusTargetId: 'T-top' });
	return { calls };
}

function nodeById(root: EnhancedDomTreeNode | null, id: string): EnhancedDomTreeNode {
	assert(root !== null);
	const found = walkTree(root).find((node) => node.attributes.id === id);
	assert(found !== undefined, `#${id} not in the capture`);
	return found;
}

async function fixture() {
	const h = await captureHarness('iframe_crossorigin');
	const state = h.record.session.cachedBrowserState;
	assert(state !== null);
	const root = state.domState.root?.originalNode ?? null;
	const table = [...state.domState.selectorMap.entries()];
	const indexOf = (id: string) => {
		const entry = table.find(([, node]) => node.attributes.id === id);
		assert(entry !== undefined, `#${id} not indexed`);
		return entry[0];
	};
	const host = nodeById(root, 'host-button');
	const child = nodeById(root, 'xo-button');
	const iframe = walkTree(root as EnhancedDomTreeNode).find((node) => node.nodeName === 'IFRAME');
	assert(iframe !== undefined);
	const oopif = state.frames.find((frame) => frame.isOopif);
	assert(oopif !== undefined);
	return { h, state, root, host, child, iframe, oopif, indexOf };
}

Deno.test('hit test: a top-document hit resolves directly through the reverse map', async () => {
	const f = await fixture();
	try {
		const { calls } = connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: f.host.backendNodeId, frameId: f.host.frameId } },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const hit = await hitTest(f.h.record, 71, 133);
		assertEquals(hit.resolution, 'direct');
		assertEquals(hit.index, f.indexOf('host-button'));
		assertEquals(hit.frameId, f.host.frameId);
		assertEquals(hit.probes.length, 1);
		assertEquals(hit.probes[0]?.document, { x: 71, y: 133 });
		// The scroll is read live, per level, before the ask — never from the cached state.
		assertEquals(calls[0]?.method, 'Page.getLayoutMetrics');
		assertEquals(calls[1]?.method, 'DOM.getNodeForLocation');
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test: the viewport point is translated into document coordinates by the live scroll (U-2)', async () => {
	const f = await fixture();
	try {
		const { calls } = connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: f.host.backendNodeId, frameId: f.host.frameId } },
			scroll: { [f.host.sessionId]: { pageX: 0, pageY: 307 } },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const hit = await hitTest(f.h.record, 133, 732);
		assertEquals(hit.probes[0]?.scroll, { x: 0, y: 307 });
		assertEquals(hit.probes[0]?.document, { x: 133, y: 1039 });
		const ask = calls.find((call) => call.method === 'DOM.getNodeForLocation');
		assertEquals((ask?.params as { x: number; y: number }).y, 1039, 'the browser is asked in document space');
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test: an OOPIF point descends through the host iframe into the child session (U-2)', async () => {
	const f = await fixture();
	try {
		const { calls } = connect(f.h.record, {
			located: {
				// The page session answers the host <iframe>, in the top document's id space.
				[f.host.sessionId]: { backendNodeId: f.iframe.backendNodeId, frameId: f.host.frameId },
				// The child session answers the button, in its own id space.
				[f.child.sessionId]: { backendNodeId: f.child.backendNodeId, frameId: f.oopif.frameId },
			},
			described: { [f.iframe.backendNodeId]: { nodeName: 'IFRAME', frameId: f.oopif.frameId } },
			box: { x: 13, y: 144.28 },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const hit = await hitTest(f.h.record, 85, 210);
		assertEquals(hit.resolution, 'direct');
		assertEquals(hit.index, f.indexOf('xo-button'));
		assertEquals(hit.frameId, f.oopif.frameId, 'the frame is the OOPIF, not the host document');
		assertEquals(hit.probes.length, 2);
		assertEquals(hit.probes[1]?.session_id, f.child.sessionId);
		// The child point is the host point less the host's live content-box origin — a live read.
		assertEquals(hit.probes[1]?.x, 85 - 13);
		assertEquals(Math.round((hit.probes[1]?.y ?? 0) * 100) / 100, Math.round((210 - 144.28) * 100) / 100);
		assert(calls.some((call) => call.method === 'DOM.getBoxModel' && call.sessionId === f.host.sessionId));
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test: a hit on a non-interactive descendant resolves to its indexed ancestor, within the document', async () => {
	const f = await fixture();
	try {
		const text = f.host.childrenNodes[0];
		assert(text !== undefined, 'the host button has a text child in the capture');
		connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: text.backendNodeId, frameId: f.host.frameId } },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const hit = await hitTest(f.h.record, 71, 133);
		assertEquals(hit.resolution, 'ancestor');
		assertEquals(hit.index, f.indexOf('host-button'));
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test: a node with no indexed ancestor answers none; no node answers no-node; both are successes', async () => {
	const f = await fixture();
	try {
		const main = walkTree(f.root as EnhancedDomTreeNode).find((node) => node.nodeName === 'H1');
		assert(main !== undefined);
		connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: main.backendNodeId, frameId: f.host.frameId } },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const none = await hitTest(f.h.record, 20, 20);
		assertEquals(none.resolution, 'none');
		assertEquals(none.index, null);
		assertEquals(none.frameId, f.host.frameId, 'the browser still named the frame');

		connect(f.h.record, { located: { [f.host.sessionId]: 'No node found at given location' } }, {
			top: f.host.sessionId,
			child: f.child.sessionId,
		});
		const nothing = await hitTest(f.h.record, 5000, 5000);
		assertEquals(nothing.resolution, 'no-node');
		assertEquals(nothing.frameId, null);

		// Any other CDP failure is the browser's, reported as such.
		connect(f.h.record, { located: { [f.host.sessionId]: 'Target closed' } }, {
			top: f.host.sessionId,
			child: f.child.sessionId,
		});
		const error = await assertRejects(() => hitTest(f.h.record, 1, 1), ToolError);
		assertEquals(error.code, 'browser-unavailable');
	} finally {
		await f.h.registry.shutdown();
	}
});

/** A `backendNodeId` the capture does not hold — what the browser names for a pseudo-element. */
const PSEUDO_ID = 99_001;

Deno.test('hit test (A1): a pseudo-element resolves through the element it belongs to, asked in an isolated world', async () => {
	const f = await fixture();
	try {
		const { calls } = connect(f.h.record, {
			// The page session answers the `::before` box itself, which the merged tree never holds.
			located: { [f.host.sessionId]: { backendNodeId: PSEUDO_ID, frameId: f.host.frameId } },
			pseudo: { [PSEUDO_ID]: f.host.backendNodeId },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const hit = await hitTest(f.h.record, 71, 133);
		// A pseudo-element is its element's child, so even an indexed element answers `ancestor`.
		assertEquals(hit.resolution, 'ancestor');
		assertEquals(hit.index, f.indexOf('host-button'));
		assertEquals(hit.frameId, f.host.frameId);
		assertEquals(hit.probes[0]?.backend_node_id, PSEUDO_ID, 'the raw probe keeps what the browser named');
		assertEquals(hit.probes[0]?.pseudo_host_backend_node_id, f.host.backendNodeId);

		// Every read of the originating element happened in the isolated world, never the page's own.
		const world = calls.find((call) => call.method === 'Page.createIsolatedWorld');
		assertEquals((world?.params as { frameId: string }).frameId, f.host.frameId);
		const resolved = calls.find((call) => call.method === 'DOM.resolveNode');
		assertEquals((resolved?.params as { executionContextId?: number }).executionContextId, 901);
		const asked = calls.find((call) => call.method === 'Runtime.callFunctionOn');
		assert((asked?.params as { functionDeclaration: string }).functionDeclaration.includes('CSSPseudoElement'));
		assert(calls.some((call) => call.method === 'Runtime.releaseObjectGroup'), 'the handles are released');
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test (A1): a pseudo-element of a non-interactive element walks up from it, and can answer none', async () => {
	const f = await fixture();
	try {
		// The host button's text node stands in for "an element inside the button": its pseudo-element
		// resolves to it, and the walk continues from there to the indexed button.
		const text = f.host.childrenNodes[0];
		assert(text !== undefined);
		connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: PSEUDO_ID, frameId: f.host.frameId } },
			pseudo: { [PSEUDO_ID]: text.backendNodeId },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const inside = await hitTest(f.h.record, 71, 133);
		assertEquals(inside.resolution, 'ancestor');
		assertEquals(inside.index, f.indexOf('host-button'));

		// A backdrop drawn by a plain heading: the click lands on the heading, so nothing interactive is there.
		const heading = walkTree(f.root as EnhancedDomTreeNode).find((node) => node.nodeName === 'H1');
		assert(heading !== undefined);
		connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: PSEUDO_ID, frameId: f.host.frameId } },
			pseudo: { [PSEUDO_ID]: heading.backendNodeId },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const backdrop = await hitTest(f.h.record, 20, 20);
		assertEquals(backdrop.resolution, 'none');
		assertEquals(backdrop.index, null);
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test (A1): a node the capture predates is not a pseudo-element and still answers none', async () => {
	const f = await fixture();
	try {
		const { calls } = connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: PSEUDO_ID, frameId: f.host.frameId } },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const hit = await hitTest(f.h.record, 71, 133);
		assertEquals(hit.resolution, 'none');
		assertEquals(hit.probes[0]?.pseudo_host_backend_node_id, undefined);
		assert(!calls.some((call) => call.method === 'Runtime.callFunctionOn'), 'an element is never asked for one');
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test (A1): the isolated world is created once per frame, and recreated when its document is gone', async () => {
	const f = await fixture();
	try {
		const script = {
			located: { [f.host.sessionId]: { backendNodeId: PSEUDO_ID, frameId: f.host.frameId } },
			pseudo: { [PSEUDO_ID]: f.host.backendNodeId },
		};
		const { calls } = connect(f.h.record, script, { top: f.host.sessionId, child: f.child.sessionId });
		await hitTest(f.h.record, 71, 133);
		await hitTest(f.h.record, 71, 133);
		assertEquals(calls.filter((call) => call.method === 'Page.createIsolatedWorld').length, 1, 'reused, not leaked');

		// The cached world's document navigated away: the first read fails, a fresh world answers.
		const stale = connect(f.h.record, { ...script, staleWorlds: 1 }, {
			top: f.host.sessionId,
			child: f.child.sessionId,
		});
		const again = await hitTest(f.h.record, 71, 133);
		assertEquals(again.index, f.indexOf('host-button'));
		assertEquals(stale.calls.filter((call) => call.method === 'Page.createIsolatedWorld').length, 1);
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test (R3-2): a cached world is branded, and an id a navigation handed to a lying page is not trusted', async () => {
	const f = await fixture();
	try {
		const script = {
			located: { [f.host.sessionId]: { backendNodeId: PSEUDO_ID, frameId: f.host.frameId } },
			pseudo: { [PSEUDO_ID]: f.host.backendNodeId },
		};
		const globals: Globals = new Map();
		const first = connect(f.h.record, script, { top: f.host.sessionId, child: f.child.sessionId }, globals);
		await hitTest(f.h.record, 71, 133);
		// The world was branded at creation: a random name and a random value, defined on its own global.
		const branding = first.calls.find((call) => call.method === 'Runtime.evaluate');
		assertEquals((branding?.params as { contextId: number }).contextId, 901);
		const brand = [...(globals.get(901) ?? new Map()).entries()];
		assertEquals(brand.length, 1);
		assert(/^__ttk_[0-9a-f]{32}$/.test(brand[0]![0]) && /^[0-9a-f]{32}$/.test(brand[0]![1]), JSON.stringify(brand));
		// And the read proves it, in the same evaluation: the brand travels as the function's arguments.
		const read = first.calls.find((call) => call.method === 'Runtime.callFunctionOn');
		assertEquals((read?.params as { arguments: Array<{ value: string }> }).arguments.map((a) => a.value), brand[0]);

		// The tab navigated cross-site. The same session and frame ids survive; id 901 now names the new page's main
		// world, which answers a heading for every pseudo-element and holds no brand. The cached id resolves without
		// an error — the old code trusted it and answered the lie.
		const heading = walkTree(f.root as EnhancedDomTreeNode).find((node) => node.nodeName === 'H1');
		assert(heading !== undefined);
		const after = connect(
			f.h.record,
			{ ...script, liar: new Map([[901, heading.backendNodeId]]) },
			{ top: f.host.sessionId, child: f.child.sessionId },
			globals,
			2,
		);
		const hit = await hitTest(f.h.record, 71, 133);
		assertEquals(hit.resolution, 'ancestor', 'the true element, not the lie');
		assertEquals(hit.index, f.indexOf('host-button'));
		assertEquals(hit.probes[0]?.pseudo_host_backend_node_id, f.host.backendNodeId);
		const created = after.calls.filter((call) => call.method === 'Page.createIsolatedWorld');
		assertEquals(created.length, 1, 'the unproven world was replaced, once');
		const reads = after.calls.filter((call) => call.method === 'Runtime.callFunctionOn').map((call) =>
			(call.params as { objectId: string }).objectId.split('@')[1]
		);
		assertEquals(reads, ['901', '902'], 'tried the cached id, refused it, answered from a fresh world');
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test (R3-1): an out-of-process <object> is descended like an <iframe>', async () => {
	const f = await fixture();
	try {
		connect(f.h.record, {
			located: {
				[f.host.sessionId]: { backendNodeId: f.iframe.backendNodeId, frameId: f.host.frameId },
				[f.child.sessionId]: { backendNodeId: f.child.backendNodeId, frameId: f.oopif.frameId },
			},
			// The browser names an OBJECT as the frame owner; it carries the frame id as an iframe does.
			described: { [f.iframe.backendNodeId]: { nodeName: 'OBJECT', frameId: f.oopif.frameId } },
			box: { x: 13, y: 144.28 },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const hit = await hitTest(f.h.record, 85, 210);
		assertEquals(hit.resolution, 'direct');
		assertEquals(hit.index, f.indexOf('xo-button'));
		assertEquals(hit.probes.length, 2);
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('hit test: a disconnected session is refused, and the descent is bounded', async () => {
	const f = await fixture();
	try {
		const error = await assertRejects(() => hitTest(f.h.record, 1, 1), ToolError);
		assertEquals(error.code, 'browser-unavailable');
		assert(HIT_TEST_MAX_DESCENT >= 1 && HIT_TEST_MAX_DESCENT <= 16);
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('element at point: the record is built by the one builder, core preset, never written to the ring', async () => {
	const f = await fixture();
	try {
		connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: f.host.backendNodeId, frameId: f.host.frameId } },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		const before = f.h.record.events.highWaterMark;
		const answer = await elementAtPoint(f.h.record, 71, 133, resolveFields(['core']));
		assert(answer.element !== null);
		assertEquals(answer.element.index, f.indexOf('host-button'));
		assertEquals(answer.element.tag, 'button');
		assert(answer.element.bounds !== undefined && answer.element.bounds !== null);
		assertEquals(answer.element.frame_id, f.host.frameId);
		assertEquals(answer.stateToken, f.state.stateToken);
		assertEquals(f.h.record.events.highWaterMark, before, 'a hover/element_at is not an event');

		// `null` when nothing interactive is there, with the token still reported.
		connect(f.h.record, { located: { [f.host.sessionId]: 'No node found at given location' } }, {
			top: f.host.sessionId,
			child: f.child.sessionId,
		});
		const empty = await elementAtPoint(f.h.record, 1, 1, resolveFields(['core']));
		assertEquals(empty.element, null);
		assertEquals(empty.stateToken, f.state.stateToken);
	} finally {
		await f.h.registry.shutdown();
	}
});

Deno.test('browser_element_at: the tool answers the schema-shaped payload, null for nothing, and stays read-only under a lock', async () => {
	const f = await fixture();
	try {
		connect(f.h.record, {
			located: { [f.host.sessionId]: { backendNodeId: f.host.backendNodeId, frameId: f.host.frameId } },
		}, { top: f.host.sessionId, child: f.child.sessionId });
		// A human holding the session does not block a read.
		f.h.record.lock = { holder: 'v', principal: 'p', takenAt: 1, holderName: null };
		const result = await browserElementAt({ x: 71, y: 133, fields: ['core', 'attrs'] }, f.h.ctx) as {
			structuredContent: Record<string, unknown>;
		};
		const payload = OUTPUT.browser_element_at.parse(result.structuredContent);
		assertEquals(payload.element?.index, f.indexOf('host-button'));
		assertEquals(payload.frame_id, f.host.frameId);
		assertEquals(payload.resolution, 'direct');
		assertEquals(payload.state_token, f.state.stateToken);
		assertEquals(payload.x, 71);

		connect(f.h.record, { located: { [f.host.sessionId]: 'No node found at given location' } }, {
			top: f.host.sessionId,
			child: f.child.sessionId,
		});
		const empty = await browserElementAt({ x: 1, y: 1 }, f.h.ctx) as {
			isError?: boolean;
			structuredContent: Record<string, unknown>;
		};
		assertEquals(empty.isError, undefined);
		const parsed = OUTPUT.browser_element_at.parse(empty.structuredContent);
		assertEquals(parsed.element, null);
		assertEquals(parsed.frame_id, null);
		assertEquals(parsed.resolution, 'no-node');
	} finally {
		await f.h.registry.shutdown();
	}
});
