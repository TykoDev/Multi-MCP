/**
 * U-2 (B2.1): the hit test in the browser, against the dual-origin corpus.
 *
 * `browser_element_at` and `live.hover` must answer from `DOM.getNodeForLocation` and join the
 * browser's own `frameId` / `backendNodeId` to the LLM index through the serializer's reverse map —
 * on the top document, inside an out-of-process frame, and on the two occlusion fixtures where the
 * *topmost* element, not the deepest, is the answer. Every raw field the browser returned is logged
 * so the evidence is the measurement rather than the assertion that wrapped it.
 *
 * The corpus is served on the two pinned origins `tests/fixtures/manifest.json` records
 * (`127.0.0.1:38111` and `localhost:38112`), because `iframe_crossorigin.html` hard-codes the
 * secondary origin and site isolation keys on scheme+site: the two spellings of loopback are what
 * puts the child frame in its own renderer.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { hitTest } from '@tykotech/mcp';
import { loadFixtureRoutes } from '../../packages/browser/fixtures/dom/pages.ts';
import { harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('element_at e2e');

const PRIMARY = { hostname: '127.0.0.1', port: 38111 } as const;
const SECONDARY = { hostname: 'localhost', port: 38112 } as const;

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}
interface Element {
	index: number;
	tag: string;
	label?: string;
	bounds?: Rect | null;
	frame_id?: string;
	attrs?: Record<string, string>;
}
interface State {
	state_token: string | null;
	interactive_elements: Element[];
	frames: Array<{ id: string; is_oopif: boolean; url: string }>;
}
interface ElementAt {
	state_token: string | null;
	element: Element | null;
	frame_id: string | null;
	resolution: string;
}

/** Serves the shared corpus on both pinned origins. */
async function corpus(): Promise<{ close(): Promise<void> }> {
	const routes = await loadFixtureRoutes();
	const serve = (addr: { hostname: string; port: number }) =>
		Deno.serve({ ...addr, onListen: () => {} }, (request) => {
			const body = routes[new URL(request.url).pathname];
			return body === undefined
				? new Response('not found', { status: 404 })
				: new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
		});
	const servers = [serve(PRIMARY), serve(SECONDARY)];
	return {
		async close() {
			for (const server of servers) await server.shutdown();
		},
	};
}

/** The structured half of a result, where every field added since 0.1.0 lives (I-4). */
async function structured<T>(
	h: {
		call(
			name: string,
			args?: Record<string, unknown>,
		): Promise<{ isError?: boolean; structuredContent?: unknown; content?: unknown }>;
	},
	name: string,
	args: Record<string, unknown>,
): Promise<T> {
	const result = await h.call(name, args);
	assert(result.isError !== true, `${name} failed: ${JSON.stringify(result.content)}`);
	return result.structuredContent as T;
}

/** A page element's viewport box, read from the page itself — test input, not the tool's arithmetic. */
async function rectOf(h: { gateway: { registry: { peek(id: string): unknown } } }, id: string): Promise<Rect> {
	const record = h.gateway.registry.peek('default') as {
		session: {
			cdpClient:
				| { send: { Runtime: { evaluate(p: unknown, s: string): Promise<{ result: { value?: unknown } }> } } }
				| null;
			sessionManager: { getOrCreateCdpSession(t: unknown, f: boolean): Promise<{ sessionId: string }> } | null;
			agentFocusTargetId: string | null;
		};
	} | undefined;
	assert(record !== undefined && record.session.cdpClient !== null && record.session.sessionManager !== null);
	const cdp = await record.session.sessionManager.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
	const out = await record.session.cdpClient.send.Runtime.evaluate({
		expression: `(() => { const r = document.getElementById(${
			JSON.stringify(id)
		}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
		returnByValue: true,
	}, cdp.sessionId);
	return out.result.value as Rect;
}

/** A page element's text, read from the page — how the covers page reports which control a click reached. */
async function pageText(h: { gateway: { registry: { peek(id: string): unknown } } }, id: string): Promise<string> {
	const record = h.gateway.registry.peek('default') as {
		session: {
			cdpClient: { send: { Runtime: { evaluate(p: unknown, s: string): Promise<{ result: { value?: unknown } }> } } };
			sessionManager: { getOrCreateCdpSession(t: unknown, f: boolean): Promise<{ sessionId: string }> };
			agentFocusTargetId: string | null;
		};
	};
	const cdp = await record.session.sessionManager.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
	const out = await record.session.cdpClient.send.Runtime.evaluate({
		expression: `document.getElementById(${JSON.stringify(id)}).textContent`,
		returnByValue: true,
	}, cdp.sessionId);
	return String(out.result.value ?? '');
}

function byId(state: State, id: string): Element {
	const found = state.interactive_elements.find((element) => element.attrs?.id === id);
	assert(found !== undefined, `#${id} is not in the element table: ${JSON.stringify(state.interactive_elements)}`);
	assert(found.bounds !== null && found.bounds !== undefined, `#${id} has no bounds`);
	return found;
}

function centre(element: Element): { x: number; y: number } {
	const b = element.bounds as Rect;
	return { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) };
}

Deno.test({
	name:
		'e2e element_at (U-2): the hit test resolves through the reverse map on the OOPIF, the top document, and the occlusion fixtures',
	ignore,
	async fn(t) {
		const served = await corpus();
		try {
			await using h = await harness();
			const fields = ['core', 'attrs'];

			await t.step('the OOPIF and the top document resolve to the indexed element', async () => {
				await h.callText('browser_navigate', {
					url: `http://${PRIMARY.hostname}:${PRIMARY.port}/iframe_crossorigin.html`,
				});
				const state = await structured<State>(h, 'browser_get_state', { fields });
				const oopif = state.frames.find((frame) => frame.is_oopif);
				assert(oopif !== undefined, `no OOPIF captured: ${JSON.stringify(state.frames)}`);
				const child = byId(state, 'xo-button');
				assertEquals(child.frame_id, oopif.id, 'the child button must be attributed to the OOPIF');
				const host = byId(state, 'host-button');

				// The raw probe first: both fields as the browser returned them, per level.
				const record = h.gateway.registry.peek('default');
				assert(record !== undefined);
				const raw = await hitTest(record, centre(child).x, centre(child).y);
				console.log(
					`U-2 OOPIF probe: ${JSON.stringify({ resolution: raw.resolution, index: raw.index, probes: raw.probes })}`,
				);
				assertEquals(raw.index, child.index, 'the OOPIF hit must resolve to the indexed child element');
				assertEquals(raw.frameId, oopif.id);

				const inFrame = await structured<ElementAt>(h, 'browser_element_at', { ...centre(child), fields });
				assertEquals(inFrame.element?.index, child.index);
				assertEquals(inFrame.frame_id, oopif.id);
				assertEquals(inFrame.state_token, state.state_token);

				const top = await structured<ElementAt>(h, 'browser_element_at', { ...centre(host), fields });
				console.log(`U-2 top probe: ${JSON.stringify(top)}`);
				assertEquals(top.element?.index, host.index);
				assertEquals(top.frame_id, state.frames[0]?.id);
				assertEquals(top.resolution, 'direct');

				// The text inside the button resolves to the button: a click there is a click on it.
				const text = await structured<ElementAt>(h, 'browser_element_at', {
					x: centre(host).x,
					y: centre(host).y,
				});
				assertEquals(text.element?.index, host.index);

				// Off the document is a success with no element, never an error.
				const nothing = await structured<ElementAt>(h, 'browser_element_at', { x: 5000, y: 5000 });
				assertEquals(nothing.element, null);
				assertEquals(nothing.frame_id, null);
			});

			await t.step('live.hover answers the same element over the socket, without a lock', async () => {
				const state = await structured<State>(h, 'browser_get_state', { fields });
				const child = byId(state, 'xo-button');
				const socket = await h.live();
				socket.send({ type: 'live.hover', id: 'h1', ...centre(child) });
				const reply = await socket.waitFor('hover', (m) => m.id === 'h1');
				assertEquals(reply.element?.index, child.index);
				assertEquals(reply.frame_id, child.frame_id);
				assert(!('attrs' in (reply.element ?? {})), 'the hover reply carries the core preset only');
				await socket.close();
			});

			await t.step('occlusion_paint_order: the topmost element answers, not the deepest', async () => {
				await h.callText('browser_navigate', {
					url: `http://${PRIMARY.hostname}:${PRIMARY.port}/occlusion_paint_order.html`,
				});
				const state = await structured<State>(h, 'browser_get_state', { fields, include_hidden: true });
				// The fully covered button is not in the table at all (paint-order filtering, correctly), so
				// its point comes from the page. The opaque cover is what the pointer reaches; it is not
				// interactive, so the answer is no element — never the button underneath.
				assert(state.interactive_elements.every((e) => e.attrs?.id !== 'occluded-button'), 'occluded button filtered');
				const occluded = centre({ index: -1, tag: 'button', bounds: await rectOf(h, 'occluded-button') });
				const covered = await structured<ElementAt>(h, 'browser_element_at', { ...occluded, fields });
				console.log(`U-2 occluded probe: ${JSON.stringify(covered)}`);
				assertEquals(covered.element, null);
				assertEquals(covered.resolution, 'none');

				// The button under a pointer-events:none cover: the browser's hit test reaches it (the
				// cover is transparent to pointer events), and the raw probe says so. Until A1 the
				// serializer's paint-order filter treated that cover as an occluder and left the button out
				// of the table, so the tool answered `none` where a click lands. ERRATUM(E-76) stopped a
				// pointer-transparent element occluding: the button is in the table and resolves directly.
				const peNoneElement = byId(state, 'pe-none-covered-button');
				const peNone = centre({ index: -1, tag: 'button', bounds: await rectOf(h, 'pe-none-covered-button') });
				const record = h.gateway.registry.peek('default');
				assert(record !== undefined);
				const rawPeNone = await hitTest(record, peNone.x, peNone.y);
				const probe = rawPeNone.probes[0];
				assert(probe !== undefined);
				const cdp = record.session.cdpClient;
				assert(cdp !== null);
				const described = await cdp.send.DOM.describeNode({ backendNodeId: probe.backend_node_id }, probe.session_id);
				const attributes = described.node.attributes ?? [];
				const hitId = attributes[attributes.indexOf('id') + 1];
				console.log(
					`U-2 pointer-events:none probe: ${
						JSON.stringify({ ...probe, hit_id: hitId, resolution: rawPeNone.resolution })
					}`,
				);
				assertEquals(hitId, 'pe-none-covered-button', 'the browser hit-tests through a pointer-events:none cover');
				assertEquals(rawPeNone.resolution, 'direct', 'A1: the button a click lands on is the answer');
				const underCover = await structured<ElementAt>(h, 'browser_element_at', { ...peNone, fields });
				assertEquals(underCover.element?.index, peNoneElement.index);

				// Partly covered: the uncovered left edge is the button, the covered right edge is not.
				const partly = byId(state, 'partly-occluded-button');
				const pb = partly.bounds as Rect;
				const open = await structured<ElementAt>(h, 'browser_element_at', { x: pb.x + 10, y: pb.y + pb.h / 2, fields });
				assertEquals(open.element?.index, partly.index, 'the uncovered part of a partly covered button answers');
				const shut = await structured<ElementAt>(h, 'browser_element_at', {
					x: pb.x + pb.w - 10,
					y: pb.y + pb.h / 2,
					fields,
				});
				console.log(`U-2 partial probe: open=${open.resolution} shut=${shut.resolution}`);
				assertEquals(shut.element, null, 'the covered part of a partly covered button answers the cover');

				// The control sits below the fold: a hit test is a viewport read, so scroll first. The
				// point is then a viewport point again, and the browser answers the unoccluded button.
				await h.callText('browser_scroll', { direction: 'down', pages: 1 });
				const scrolled = await structured<State>(h, 'browser_get_state', { fields });
				const control = byId(scrolled, 'visible-control-button');
				const plain = await structured<ElementAt>(h, 'browser_element_at', { ...centre(control), fields });
				const rawControl = await hitTest(record, centre(control).x, centre(control).y);
				console.log(
					`U-2 scrolled-document probe: ${
						JSON.stringify({ point: centre(control), probes: rawControl.probes, resolution: plain.resolution })
					}`,
				);
				assert(
					(rawControl.probes[0]?.scroll.y ?? 0) > 0,
					'the document must actually be scrolled for this leg to prove anything',
				);
				assertEquals(plain.element?.index, control.index);
			});

			await t.step('stacking_contexts: z-order decides, not tree order', async () => {
				await h.callText('browser_navigate', {
					url: `http://${PRIMARY.hostname}:${PRIMARY.port}/stacking_contexts.html`,
				});
				const state = await structured<State>(h, 'browser_get_state', { fields });
				for (const id of ['sc-top', 'sc-mid', 'sc-base']) {
					const element = byId(state, id);
					const answer = await structured<ElementAt>(h, 'browser_element_at', { ...centre(element), fields });
					console.log(`U-2 stacking probe ${id}: ${JSON.stringify(answer)}`);
					assertEquals(answer.element?.index, element.index, `${id} is the topmost element at its own centre`);
				}
			});
		} finally {
			await served.close();
		}
	},
});

/**
 * A1: what lies between the pointer and a control (`tests/fixtures/element_at_covers.html`).
 *
 * Every leg asserts two things about the same point: what `browser_element_at` answers, and where a real
 * click at that point lands — the page records its own clicks. The answer is right exactly when the two
 * agree, which is the property A1 exists for.
 */
Deno.test({
	name: 'e2e element_at (A1): covers and pseudo-elements answer the element a click at the point reaches',
	ignore,
	async fn(t) {
		const html = await Deno.readTextFile(new URL('../fixtures/element_at_covers.html', import.meta.url));
		const server = Deno.serve(
			{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
			() =>
				new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }),
		);
		try {
			await using h = await harness();
			const fields = ['core', 'attrs'];
			await h.callText('browser_navigate', { url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/` });
			const state = await structured<State>(h, 'browser_get_state', { fields });
			const record = h.gateway.registry.peek('default');
			assert(record !== undefined);

			/** Clicks at a viewport point and returns which controls have recorded a click so far. */
			const clickAt = async (point: { x: number; y: number }): Promise<string> => {
				await h.callText('browser_click', { coordinate_x: point.x, coordinate_y: point.y });
				return await pageText(h, 'log');
			};

			await t.step('a control under a pointer-events:none layer is the answer, and the click reaches it', async () => {
				const button = byId(state, 'under-pe-none');
				const answer = await structured<ElementAt>(h, 'browser_element_at', { ...centre(button), fields });
				console.log(
					`A1 pointer-events:none: ${JSON.stringify({ resolution: answer.resolution, index: answer.element?.index })}`,
				);
				assertEquals(answer.resolution, 'direct');
				assertEquals(answer.element?.index, button.index);
				assert((await clickAt(centre(button))).includes('under-pe-none'), 'the click lands on the button');
			});

			await t.step('an icon drawn by ::before answers its button', async () => {
				const button = byId(state, 'icon-button');
				const raw = await hitTest(record, centre(button).x, centre(button).y);
				const probe = raw.probes[0];
				assert(probe !== undefined);
				const cdp = record.session.cdpClient;
				assert(cdp !== null);
				const described = await cdp.send.DOM.describeNode({ backendNodeId: probe.backend_node_id }, probe.session_id);
				console.log(`A1 icon probe: ${JSON.stringify({ ...probe, node: described.node.nodeName })}`);
				assertEquals(described.node.nodeName, '::before', 'the browser names the pseudo-element itself');
				assert(probe.pseudo_host_backend_node_id !== undefined, 'and its element was asked for');
				const answer = await structured<ElementAt>(h, 'browser_element_at', { ...centre(button), fields });
				assertEquals(answer.resolution, 'ancestor');
				assertEquals(answer.element?.index, button.index);
				assert((await clickAt(centre(button))).includes('icon-button'));
			});

			await t.step('a stretched link’s ::after answers the link, away from the link’s own text', async () => {
				const link = byId(state, 'card-link');
				const stage = await rectOf(h, 'stage-card');
				// Inside the card, well to the right of and above the link text: only the ::after is here.
				const point = { x: Math.round(stage.x + 330), y: Math.round(stage.y + 30) };
				const box = link.bounds as Rect;
				assert(point.x > box.x + box.w || point.y < box.y, 'the point is outside the link’s own box');
				const answer = await structured<ElementAt>(h, 'browser_element_at', { ...point, fields });
				console.log(
					`A1 stretched link: ${JSON.stringify({ resolution: answer.resolution, index: answer.element?.index })}`,
				);
				assertEquals(answer.resolution, 'ancestor');
				assertEquals(answer.element?.index, link.index);
				assert((await clickAt(point)).includes('card-link'), 'the click lands on the link');
			});

			await t.step(
				'a backdrop drawn by a plain element answers nothing, and the control beneath gets no click',
				async () => {
					const button = byId(state, 'under-backdrop');
					const answer = await structured<ElementAt>(h, 'browser_element_at', { ...centre(button), fields });
					console.log(`A1 backdrop: ${JSON.stringify({ resolution: answer.resolution, element: answer.element })}`);
					assertEquals(answer.element, null);
					assertEquals(answer.resolution, 'none');
					assert(!(await clickAt(centre(button))).includes('under-backdrop'), 'the backdrop takes the click');
				},
			);
		} finally {
			await server.shutdown();
		}
	},
});
