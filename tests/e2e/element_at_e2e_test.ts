/**
 * The hit test in the browser: `browser_element_at` and `live.hover` answer from `DOM.getNodeForLocation` and join
 * the browser's `frameId`/`backendNodeId` to the element index through the serializer's reverse map, on the top
 * document, inside an out-of-process frame, and where the topmost element (not the deepest) is the answer. The corpus
 * is served on the two pinned origins (`iframe_crossorigin.html` hard-codes the second), which are different sites.
 */
import { assert, assertEquals } from '@std/assert';
import { hitTest } from '@tykotech/mcp';
import { loadFixtureRoutes } from '../../packages/browser/fixtures/dom/pages.ts';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';
import { jsLiteral } from '../support/js_literal.ts';

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

/** A page element's viewport box, read from the page itself: test input, not the tool's arithmetic. */
const rectOf = (h: Harness, id: string): Promise<Rect> =>
	h.pageValue<Rect>(
		`(() => { const r = document.getElementById(${jsLiteral(id)}).getBoundingClientRect(); ` +
			'return { x: r.x, y: r.y, w: r.width, h: r.height }; })()',
	);

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
		'e2e element_at: the hit test resolves through the reverse map on the OOPIF, the top document, and the occlusion fixtures',
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
				const state = await h.callStructured<State>('browser_get_state', { fields });
				const oopif = state.frames.find((frame) => frame.is_oopif);
				assert(oopif !== undefined, `no OOPIF captured: ${JSON.stringify(state.frames)}`);
				const child = byId(state, 'xo-button');
				assertEquals(child.frame_id, oopif.id, 'the child button must be attributed to the OOPIF');
				const host = byId(state, 'host-button');

				// The raw probe first: both fields as the browser returned them, per level.
				const record = h.gateway.registry.peek('default');
				assert(record !== undefined);
				const raw = await hitTest(record, centre(child).x, centre(child).y);
				assertEquals(raw.index, child.index, 'the OOPIF hit must resolve to the indexed child element');
				assertEquals(raw.frameId, oopif.id);

				const inFrame = await h.callStructured<ElementAt>('browser_element_at', { ...centre(child), fields });
				assertEquals(inFrame.element?.index, child.index);
				assertEquals(inFrame.frame_id, oopif.id);
				assertEquals(inFrame.state_token, state.state_token);

				const top = await h.callStructured<ElementAt>('browser_element_at', { ...centre(host), fields });
				assertEquals(top.element?.index, host.index);
				assertEquals(top.frame_id, state.frames[0]?.id);
				assertEquals(top.resolution, 'direct');

				// Off the document is a success with no element, never an error.
				const nothing = await h.callStructured<ElementAt>('browser_element_at', { x: 5000, y: 5000 });
				assertEquals(nothing.element, null);
				assertEquals(nothing.frame_id, null);
			});

			await t.step('live.hover answers the same element over the socket, without a lock', async () => {
				const state = await h.callStructured<State>('browser_get_state', { fields });
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
				const state = await h.callStructured<State>('browser_get_state', { fields, include_hidden: true });
				// The fully covered button is filtered from the table; the opaque cover the pointer reaches is not
				// interactive, so the answer is no element, never the button underneath.
				assert(state.interactive_elements.every((e) => e.attrs?.id !== 'occluded-button'), 'occluded button filtered');
				const occluded = centre({ index: -1, tag: 'button', bounds: await rectOf(h, 'occluded-button') });
				const covered = await h.callStructured<ElementAt>('browser_element_at', { ...occluded, fields });
				assertEquals(covered.element, null);
				assertEquals(covered.resolution, 'none');

				// A pointer-events:none cover does not occlude: the browser hit-tests through it to the button.
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
				assertEquals(hitId, 'pe-none-covered-button', 'the browser hit-tests through a pointer-events:none cover');
				assertEquals(rawPeNone.resolution, 'direct', 'the button a click lands on is the answer');
				const underCover = await h.callStructured<ElementAt>('browser_element_at', { ...peNone, fields });
				assertEquals(underCover.element?.index, peNoneElement.index);

				// Partly covered: the uncovered left edge is the button, the covered right edge is not.
				const partly = byId(state, 'partly-occluded-button');
				const pb = partly.bounds as Rect;
				const open = await h.callStructured<ElementAt>('browser_element_at', {
					x: pb.x + 10,
					y: pb.y + pb.h / 2,
					fields,
				});
				assertEquals(open.element?.index, partly.index, 'the uncovered part of a partly covered button answers');
				const shut = await h.callStructured<ElementAt>('browser_element_at', {
					x: pb.x + pb.w - 10,
					y: pb.y + pb.h / 2,
					fields,
				});
				assertEquals(shut.element, null, 'the covered part of a partly covered button answers the cover');

				// Below the fold: a hit test is a viewport read, so scroll first.
				await h.callText('browser_scroll', { direction: 'down', pages: 1 });
				const scrolled = await h.callStructured<State>('browser_get_state', { fields });
				const control = byId(scrolled, 'visible-control-button');
				const plain = await h.callStructured<ElementAt>('browser_element_at', { ...centre(control), fields });
				const rawControl = await hitTest(record, centre(control).x, centre(control).y);
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
				const state = await h.callStructured<State>('browser_get_state', { fields });
				for (const id of ['sc-top', 'sc-mid', 'sc-base']) {
					const element = byId(state, id);
					const answer = await h.callStructured<ElementAt>('browser_element_at', { ...centre(element), fields });
					assertEquals(answer.element?.index, element.index, `${id} is the topmost element at its own centre`);
				}
			});
		} finally {
			await served.close();
		}
	},
});

/** What lies between the pointer and a control: the answer is right exactly when a real click at the point agrees. */
Deno.test({
	name: 'e2e element_at (covers): covers and pseudo-elements answer the element a click at the point reaches',
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
			const state = await h.callStructured<State>('browser_get_state', { fields });
			const record = h.gateway.registry.peek('default');
			assert(record !== undefined);

			/** Clicks at a viewport point and returns which controls have recorded a click so far. */
			const clickAt = async (point: { x: number; y: number }): Promise<string> => {
				await h.callText('browser_click', { coordinate_x: point.x, coordinate_y: point.y });
				return await h.pageValue<string>("document.getElementById('log').textContent");
			};

			await t.step('a control under a pointer-events:none layer is the answer, and the click reaches it', async () => {
				const button = byId(state, 'under-pe-none');
				const answer = await h.callStructured<ElementAt>('browser_element_at', { ...centre(button), fields });
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
				assertEquals(described.node.nodeName, '::before', 'the browser names the pseudo-element itself');
				assert(probe.pseudo_host_backend_node_id !== undefined, 'and its element was asked for');
				const answer = await h.callStructured<ElementAt>('browser_element_at', { ...centre(button), fields });
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
				const answer = await h.callStructured<ElementAt>('browser_element_at', { ...point, fields });
				assertEquals(answer.resolution, 'ancestor');
				assertEquals(answer.element?.index, link.index);
				assert((await clickAt(point)).includes('card-link'), 'the click lands on the link');
			});

			await t.step(
				'a backdrop drawn by a plain element answers nothing, and the control beneath gets no click',
				async () => {
					const button = byId(state, 'under-backdrop');
					const answer = await h.callStructured<ElementAt>('browser_element_at', { ...centre(button), fields });
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
