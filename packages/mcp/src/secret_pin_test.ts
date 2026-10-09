/**
 * A2 / D-096: a `<secret>` placeholder in `browser_type` and `browser_fill` is pinned to the frame the
 * keystrokes land in, not to the top document.
 *
 * The element table is a real capture (`form_attributes`, D-TEST1); the browser around it is scripted, with
 * the frameset shape SEC-07 names — a top document and a child frame holding the field, at different
 * origins in either direction. The index-less path's focus walk is scripted per frame, and every read it
 * makes is asserted to have happened in an isolated world rather than in the page's own.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { captureHarness } from '../fixtures/capture_session.ts';
import { ToolError } from './errors.ts';
import { SecretStore } from './secrets.ts';
import type { ToolContext } from './types.ts';
import * as tools from './tools.ts';

/** The capture's password input, and the frame the capture holds it in. */
const PASSWORD_INDEX = 6;
const FORM_FRAME = 'A4B12682576331EE39AA9EFE83F974E0';

const BANK_SECRET = 'Zq8-PIN-BANK-SECRET-3vP';
const BANK = 'https://bank.example.com/login';
const EVIL = 'https://evil.example/frame';

/** What one frame's `document.activeElement` is, for the index-less walk. */
type Active =
	| { readonly nodeName: 'INPUT' }
	/**
	 * A frame owner. `frameId` absent: the browser names no frame for it (R3-1). `<object>` and `<embed>` carry a
	 * `frameId` exactly as `<iframe>` does (measured, Chromium 154).
	 */
	| { readonly nodeName: 'IFRAME' | 'OBJECT' | 'EMBED'; readonly frameId?: string; readonly inProcess: boolean }
	/** A closed-shadow host; `false` holds a plain field, otherwise the frame owner its shadow tree holds. */
	| { readonly nodeName: 'DIV'; readonly closedShadowFrame: false | 'IFRAME' | 'OBJECT' | 'EMBED' }
	| null;

/** The scripted browser. Mutable, so a test can navigate it between two calls (R3-2). */
interface Wire {
	topUrl: string;
	/** `FORM_FRAME`'s live URL, a child of the top document. */
	formUrl?: string;
	/** Frame id → URL of further frames under the top document (same process). */
	children?: Record<string, string>;
	/** Out-of-process frames: frame id → URL, each the root of its own session's tree. */
	oopifs?: Record<string, string>;
	/** Frame id → that document's active element. A frame absent here has nothing focused. */
	active?: Record<string, Active>;
	/** Out-of-process frame ids the session manager cannot attach to. */
	unattachable?: readonly string[];
	/**
	 * R3-2: execution-context ids that, after a cross-process navigation, belong to a page's own main world. A read
	 * in one answers the `active` entry named here — the page's lie — whatever frame the id was created for.
	 */
	liar?: ReadonlyMap<number, string>;
}

function wire(record: { session: unknown }, w: Wire) {
	const calls: Array<{ method: string; sessionId?: string; params?: unknown }> = [];
	let worlds = 0;
	const worldFrame = new Map<number, string>();
	let keys = 0;
	const session = record.session as Record<string, unknown>;
	session.cdpClient = {
		send: {
			Page: {
				getFrameTree: (_params: unknown, sessionId: string) => {
					calls.push({ method: 'Page.getFrameTree', sessionId });
					const oopif = Object.entries(w.oopifs ?? {}).find(([id]) => `S-${id}` === sessionId);
					if (oopif !== undefined) return Promise.resolve({ frameTree: { frame: { id: oopif[0], url: oopif[1] } } });
					const childFrames = [
						{ frame: { id: FORM_FRAME, url: w.formUrl ?? w.topUrl } },
						...Object.entries(w.children ?? {}).map(([id, url]) => ({ frame: { id, url } })),
					];
					return Promise.resolve({ frameTree: { frame: { id: 'TOP', url: w.topUrl }, childFrames } });
				},
				getLayoutMetrics: () => {
					const viewport = { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 };
					return Promise.resolve({
						layoutViewport: viewport,
						visualViewport: { ...viewport, scale: 1 },
						cssVisualViewport: { ...viewport, scale: 1 },
						contentSize: { x: 0, y: 0, width: 1280, height: 2000 },
					});
				},
				createIsolatedWorld: (params: { frameId: string; worldName?: string }, sessionId: string) => {
					calls.push({ method: 'Page.createIsolatedWorld', sessionId, params });
					worlds += 1;
					worldFrame.set(worlds, params.frameId);
					return Promise.resolve({ executionContextId: worlds });
				},
			},
			Runtime: {
				evaluate: (params: { expression: string; contextId?: number }, sessionId: string) => {
					calls.push({ method: 'Runtime.evaluate', sessionId, params });
					const frame = params.contextId === undefined
						? undefined
						: w.liar?.get(params.contextId) ?? worldFrame.get(params.contextId);
					const active = frame === undefined ? null : w.active?.[frame] ?? null;
					return Promise.resolve({
						result: active === null
							? { type: 'object', subtype: 'null' }
							: { type: 'object', objectId: `active-${frame}` },
					});
				},
				releaseObjectGroup: () => Promise.resolve({}),
			},
			DOM: {
				describeNode: (params: { objectId: string; depth?: number }, sessionId: string) => {
					calls.push({ method: 'DOM.describeNode', sessionId, params });
					const frame = params.objectId.replace('active-', '');
					const active = w.active?.[frame] ?? null;
					if (active === null || active.nodeName === 'INPUT') {
						return Promise.resolve({ node: { nodeName: 'INPUT', backendNodeId: 1 } });
					}
					if (active.nodeName !== 'DIV') {
						const named = active.frameId !== undefined;
						return Promise.resolve({
							node: {
								nodeName: active.nodeName,
								backendNodeId: 2,
								...(named ? { frameId: active.frameId } : {}),
								...(named && active.inProcess ? { contentDocument: { nodeName: '#document', backendNodeId: 3 } } : {}),
							},
						});
					}
					// A host with a closed shadow root; the deep read shows what the shadow tree holds.
					const inner = active.closedShadowFrame === false
						? [{ nodeName: 'INPUT', backendNodeId: 6 }]
						: [{ nodeName: active.closedShadowFrame, backendNodeId: 5, frameId: 'HIDDEN' }];
					return Promise.resolve({
						node: {
							nodeName: 'DIV',
							backendNodeId: 4,
							shadowRoots: [{
								nodeName: '#document-fragment',
								backendNodeId: 7,
								shadowRootType: 'closed',
								...(params.depth === -1 ? { children: inner } : {}),
							}],
						},
					});
				},
			},
			Input: {
				dispatchKeyEvent: () => {
					keys += 1;
					return Promise.resolve({});
				},
			},
		},
	};
	session.sessionManager = {
		getOrCreateCdpSession: (target: string, focus: boolean) =>
			!focus && (w.unattachable ?? []).includes(target)
				? Promise.reject(new Error(`no target ${target}`))
				: Promise.resolve({ sessionId: focus ? 'S1' : `S-${target}`, targetId: target }),
	};
	session.agentFocusTargetId = 'T';
	return { calls, keys: () => keys };
}

async function harness(w: Wire) {
	const h = await captureHarness('form_attributes');
	const wired = wire(h.record, w);
	const secrets = new SecretStore([{ name: 'bank_password', value: BANK_SECRET, domains: ['bank.example.com'] }]);
	const dispatched: Array<Record<string, unknown>> = [];
	const bus = h.record.session.eventBus as unknown as { dispatch(event: unknown): unknown };
	bus.dispatch = (event: Record<string, unknown>) => {
		dispatched.push(event);
		return { eventResult: () => Promise.resolve('ok') };
	};
	const token = h.record.session.cachedBrowserState?.stateToken as string;
	const ctx: ToolContext = { ...h.ctx, secrets };
	return { ...h, ...wired, ctx, dispatched, token };
}

Deno.test('A2: an index inside a cross-origin frame of the pinned top is refused — the frame is the pin', async () => {
	// The frameset hole: the top document is the bank, the field is in someone else's frame. Before D-096
	// the pin read the top URL and typed the bank's credential into the other origin's document.
	const f = await harness({ topUrl: BANK, formUrl: EVIL });
	try {
		const error = await assertRejects(
			() =>
				tools.browserType(
					{ index: PASSWORD_INDEX, text: '<secret>bank_password</secret>', state_token: f.token },
					f.ctx,
				),
			ToolError,
		);
		assertEquals(error.code, 'navigation-blocked');
		assert(error.message.includes('https://evil.example'), error.message);
		assert(!error.message.includes(BANK_SECRET));
		assertEquals(f.dispatched.length, 0, 'nothing was typed');
		assertEquals(f.record.audit.read({ principal: 'test', all: true }).entries.length, 0);

		// `browser_fill` delegates, so it carries the same pin.
		const fill = await assertRejects(
			() =>
				tools.browserFill(
					{ index: PASSWORD_INDEX, text: '<secret>bank_password</secret>', state_token: f.token },
					f.ctx,
				),
			ToolError,
		);
		assertEquals(fill.code, 'navigation-blocked');
		assertEquals(f.dispatched.length, 0);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('A2: the converse — the pinned origin in a frame under another top fills, audited with that frame', async () => {
	const f = await harness({ topUrl: EVIL, formUrl: BANK });
	try {
		await tools.browserType(
			{ index: PASSWORD_INDEX, text: '<secret>bank_password</secret>', state_token: f.token },
			f.ctx,
		);
		assertEquals(f.dispatched.length, 1);
		assertEquals((f.dispatched[0] as { text?: string }).text, BANK_SECRET);
		const entries = f.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.frame_id, FORM_FRAME);
		assertEquals(entries[0]?.origin, 'https://bank.example.com');
		assert(!JSON.stringify(entries).includes(BANK_SECRET));
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('A2: without an index, the focused element’s frame is the pin, found in isolated worlds', async () => {
	// Focus went from the top document into a same-process child frame at another origin.
	const f = await harness({
		topUrl: BANK,
		children: { CHILD: EVIL },
		active: { TOP: { nodeName: 'IFRAME', frameId: 'CHILD', inProcess: true }, CHILD: { nodeName: 'INPUT' } },
	});
	try {
		const error = await assertRejects(
			() => tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx),
			ToolError,
		);
		assertEquals(error.code, 'navigation-blocked');
		assertEquals(f.keys(), 0, 'no keystroke left the server');

		// Each document's active element was read in that frame's isolated world, never the main world.
		const worlds = f.calls.filter((call) => call.method === 'Page.createIsolatedWorld');
		assertEquals(worlds.map((call) => (call.params as { frameId: string }).frameId), ['TOP', 'CHILD']);
		const reads = f.calls.filter((call) => call.method === 'Runtime.evaluate');
		assertEquals(reads.length, 2);
		for (const read of reads) {
			assert((read.params as { contextId?: number }).contextId !== undefined, 'a main-world read');
		}
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('A2: without an index, focus in the top document pins the top, and the keys go out', async () => {
	const f = await harness({ topUrl: BANK, active: { TOP: { nodeName: 'INPUT' } } });
	try {
		await tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx);
		assert(f.keys() > 0, 'the substitution was typed at the focus');
		const entries = f.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.frame_id, 'TOP');
		assertEquals(entries[0]?.origin, 'https://bank.example.com');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('A2: focus in an out-of-process frame is followed into that frame’s own session', async () => {
	const f = await harness({
		topUrl: BANK,
		oopifs: { OOP: EVIL },
		active: { TOP: { nodeName: 'IFRAME', frameId: 'OOP', inProcess: false }, OOP: { nodeName: 'INPUT' } },
	});
	try {
		const error = await assertRejects(
			() => tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx),
			ToolError,
		);
		assertEquals(error.code, 'navigation-blocked');
		assert(error.message.includes('https://evil.example'), error.message);
		// The child's world was created on the child's session, and its URL read from the child's tree.
		const childWorld = f.calls.find((call) =>
			call.method === 'Page.createIsolatedWorld' && (call.params as { frameId: string }).frameId === 'OOP'
		);
		assertEquals(childWorld?.sessionId, 'S-OOP');
		assert(f.calls.some((call) => call.method === 'Page.getFrameTree' && call.sessionId === 'S-OOP'));
		assertEquals(f.keys(), 0);
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('A2: a focused closed-shadow host that holds a frame is refused rather than guessed at', async () => {
	// R3-1: any frame owner in the shadow tree, not only an <iframe>.
	for (const owner of ['IFRAME', 'OBJECT', 'EMBED'] as const) {
		const holding = await harness({ topUrl: BANK, active: { TOP: { nodeName: 'DIV', closedShadowFrame: owner } } });
		try {
			const error = await assertRejects(
				() => tools.browserType({ text: '<secret>bank_password</secret>' }, holding.ctx),
				ToolError,
			);
			assertEquals(error.code, 'navigation-blocked', owner);
			assert(error.message.includes('closed shadow root'), error.message);
			assertEquals(holding.keys(), 0);
		} finally {
			await holding.registry.shutdown();
		}
	}
	// A closed shadow host with no frame inside is an ordinary field in the top document.
	const plain = await harness({ topUrl: BANK, active: { TOP: { nodeName: 'DIV', closedShadowFrame: false } } });
	try {
		await tools.browserType({ text: '<secret>bank_password</secret>' }, plain.ctx);
		assert(plain.keys() > 0);
	} finally {
		await plain.registry.shutdown();
	}
});

// --- R3-1: every frame owner is a frame boundary ------------------------------------------------------------

Deno.test('R3-1: focus in an <object>/<embed> showing another origin is followed into it, in and out of process', async () => {
	// The top is the bank; focus went into an embedded document at another origin. Before the fix the walk knew
	// only IFRAME/FRAME, stopped at the OBJECT/EMBED element, pinned the top and typed the credential into it.
	for (const nodeName of ['OBJECT', 'EMBED'] as const) {
		for (const inProcess of [true, false]) {
			const f = await harness({
				topUrl: BANK,
				...(inProcess ? { children: { EMBEDDED: EVIL } } : { oopifs: { EMBEDDED: EVIL } }),
				active: { TOP: { nodeName, frameId: 'EMBEDDED', inProcess }, EMBEDDED: { nodeName: 'INPUT' } },
			});
			try {
				const error = await assertRejects(
					() => tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx),
					ToolError,
				);
				assertEquals(error.code, 'navigation-blocked', `${nodeName} inProcess=${inProcess}`);
				assert(error.message.includes('https://evil.example'), error.message);
				assertEquals(f.keys(), 0, 'no keystroke left the server');
				const world = f.calls.find((call) =>
					call.method === 'Page.createIsolatedWorld' && (call.params as { frameId: string }).frameId === 'EMBEDDED'
				);
				assertEquals(world?.sessionId, inProcess ? 'S1' : 'S-EMBEDDED', 'the embedded document was read itself');
			} finally {
				await f.registry.shutdown();
			}
		}
	}
});

Deno.test('R3-1: the converse — the pinned origin inside an <object> under another top types, audited with that frame', async () => {
	const f = await harness({
		topUrl: EVIL,
		oopifs: { EMBEDDED: BANK },
		active: { TOP: { nodeName: 'OBJECT', frameId: 'EMBEDDED', inProcess: false }, EMBEDDED: { nodeName: 'INPUT' } },
	});
	try {
		await tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx);
		assert(f.keys() > 0);
		const entries = f.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.frame_id, 'EMBEDDED');
		assertEquals(entries[0]?.origin, 'https://bank.example.com');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('R3-1: a frame owner whose frame cannot be named or entered is refused, never pinned to the document around it', async () => {
	// No frame id: an <object>/<embed>/<iframe> the browser gives no frame for.
	for (const nodeName of ['OBJECT', 'EMBED', 'IFRAME'] as const) {
		const f = await harness({ topUrl: BANK, active: { TOP: { nodeName, inProcess: false } } });
		try {
			const error = await assertRejects(
				() => tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx),
				ToolError,
			);
			assertEquals(error.code, 'navigation-blocked', nodeName);
			assertEquals(f.keys(), 0);
		} finally {
			await f.registry.shutdown();
		}
	}
	// An out-of-process frame the session manager cannot attach to.
	const detached = await harness({
		topUrl: BANK,
		oopifs: { EMBEDDED: EVIL },
		unattachable: ['EMBEDDED'],
		active: { TOP: { nodeName: 'OBJECT', frameId: 'EMBEDDED', inProcess: false }, EMBEDDED: { nodeName: 'INPUT' } },
	});
	try {
		const error = await assertRejects(
			() => tools.browserType({ text: '<secret>bank_password</secret>' }, detached.ctx),
			ToolError,
		);
		assertEquals(error.code, 'navigation-blocked');
		assertEquals(detached.keys(), 0);
	} finally {
		await detached.registry.shutdown();
	}
});

// --- R3-2: no isolated world outlives the read that made it ---------------------------------------------------

Deno.test('R3-2: a context id from before a cross-site navigation cannot answer the walk afterwards', async () => {
	// Site A: the bank, focus in its own field. A legitimate secret type pins the top and goes out.
	const w: Wire = { topUrl: BANK, active: { TOP: { nodeName: 'INPUT' } } };
	const f = await harness(w);
	try {
		await tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx);
		const first = f.calls.filter((call) => call.method === 'Page.createIsolatedWorld').length;
		assertEquals(first, 1);
		const keysOnA = f.keys();
		assert(keysOnA > 0);

		// The same tab navigates to site B, cross-site: a new renderer process in which the context ids site A's
		// reads used now belong to B's own main worlds — and B lies from them that focus is in a frame of the bank.
		w.topUrl = EVIL;
		w.oopifs = { BANKFRAME: BANK };
		w.active = {
			TOP: { nodeName: 'INPUT' },
			LIE: { nodeName: 'IFRAME', frameId: 'BANKFRAME', inProcess: false },
			BANKFRAME: null,
		};
		w.liar = new Map(Array.from({ length: first }, (_, i) => [i + 1, 'LIE']));

		const error = await assertRejects(
			() => tools.browserType({ text: '<secret>bank_password</secret>' }, f.ctx),
			ToolError,
		);
		assertEquals(error.code, 'navigation-blocked');
		assert(error.message.includes('https://evil.example'), `the pin must be B's own frame: ${error.message}`);
		assertEquals(f.keys(), keysOnA, 'nothing was typed on B');
		// A fresh world per read: B's read used an id no earlier read had.
		assertEquals(f.calls.filter((call) => call.method === 'Page.createIsolatedWorld').length, first + 1);
		const reads = f.calls.filter((call) => call.method === 'Runtime.evaluate').map((call) =>
			(call.params as { contextId?: number }).contextId
		);
		assertEquals(reads, [1, 2], 'every read in a world created for it');
	} finally {
		await f.registry.shutdown();
	}
});

Deno.test('A2: a browser_type with no placeholder reads no frame and creates no world', async () => {
	const f = await harness({ topUrl: BANK, formUrl: EVIL });
	try {
		await tools.browserType({ index: PASSWORD_INDEX, text: 'ordinary text', state_token: f.token }, f.ctx);
		await tools.browserType({ text: 'ordinary text' }, f.ctx);
		assertEquals(f.calls, [], 'a type with no placeholder must not pay for the pin');
	} finally {
		await f.registry.shutdown();
	}
});
