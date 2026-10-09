/**
 * `DefaultActionWatchdog` contract (ARCHITECTURE.md §6.10; COMPLETIONS-CRITERIA.md §3.2 watchdog row
 * 10: "click cascade (scrollIntoView→geometry→occlusion→mouse), per-char typing, sendKeys, scroll
 * paths, upload, scroll-to-text, dropdowns, `{validationError}`-as-data, print-dialog→printToPDF").
 *
 * Tier 1: real event bus, real `CdpClient`, real `SessionManager`, real CDP frames over
 * `ChromeFixture` — nothing mocked (D-TEST1). What this tier proves is *wire shape and control flow*:
 * which CDP calls happen, in what order, with what parameters, and which branch of each cascade ran.
 * Whether a real page reacts to them is the browser tier's job
 * (`packages/core/tests/integration/watchdog_action_test.ts`).
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { fromFileUrl } from '@std/path';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import {
	BrowserConnectedEvent,
	ClickCoordinateEvent,
	ClickElementEvent,
	GetDropdownOptionsEvent,
	GoBackEvent,
	GoForwardEvent,
	HoverEvent,
	RefreshEvent,
	ScrollEvent,
	ScrollToTextEvent,
	SelectDropdownOptionEvent,
	SendKeysEvent,
	TypeTextEvent,
	UploadFileEvent,
	WaitEvent,
} from '../events.ts';
import { createBrowserProfile } from '../types.ts';
import type { EnhancedDomTreeNode } from '../dom/types.ts';
import type { WatchdogHost } from './base.ts';
import {
	base64ByteLength,
	clickGuardRail,
	DefaultActionWatchdog,
	type DefaultActionWatchdogOptions,
	DROPDOWN_RESULT_TIMEOUT_MS,
	HISTORY_READINESS_POLL_MS,
	HISTORY_READINESS_TIMEOUT_MS,
	isPrintDialogTrigger,
	PRINT_TO_PDF_TIMEOUT_MS,
	typeGuardRail,
} from './default_action.ts';
import {
	type ClickDownloadSource,
	DOWNLOAD_COMPLETION_TIMEOUT_MS,
	DOWNLOAD_START_GRACE_MS,
} from './default_action_downloads.ts';
import { ActionError } from './default_action_dom.ts';
import {
	DOWNLOAD_COMPLETION_TIMEOUT_MS as PIPELINE_COMPLETION_MS,
	DOWNLOAD_START_GRACE_MS as PIPELINE_GRACE_MS,
	DownloadsWatchdog,
} from './downloads.ts';

const REPO_ROOT = fromFileUrl(new URL('../../../..', import.meta.url));
const THIS_FILE = fromFileUrl(import.meta.url);

// ---------------------------------------------------------------------------
// node builder
// ---------------------------------------------------------------------------

let nextBackendNodeId = 100;

/** A minimal `EnhancedDomTreeNode` (DATA-MODEL.md §6.1) for the fields the action layer reads. */
function makeNode(init: Partial<EnhancedDomTreeNode> & { nodeName: string }): EnhancedDomTreeNode {
	return {
		nodeId: 1,
		backendNodeId: nextBackendNodeId++,
		nodeType: 1,
		nodeValue: '',
		attributes: {},
		isScrollable: null,
		isVisible: true,
		absolutePosition: { x: 0, y: 0, width: 100, height: 40 },
		targetId: 'TARGET0001',
		frameId: 'FRAME-TARGET0001',
		sessionId: 'SESSION0001',
		contentDocument: null,
		shadowRootType: null,
		shadowRoots: null,
		parentNode: null,
		childrenNodes: [],
		axNode: null,
		snapshotNode: null,
		compoundChildren: [],
		hasJsClickListener: false,
		hiddenElementsInfo: [],
		hasHiddenContent: false,
		uuid: 'node-uuid',
		...init,
	};
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly client: CdpClient;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly host: WatchdogHost;
	readonly watchdog: DefaultActionWatchdog;
	readonly targetId: string;
	/** Frames of one CDP method, oldest first. */
	sent(method: string): FixtureRequest[];
	/** Answers `DOM.resolveNode` + `Runtime.callFunctionOn`, routing on the function source. */
	scriptCalls(route: PageRoute): void;
}

async function harness(options: DefaultActionWatchdogOptions = {}): Promise<Harness> {
	const fixture = ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'action-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();

	const page = manager.mostRecentPageTarget();
	assert(page !== null, 'the fixture must expose a page target');
	await manager.setAgentFocus(page.targetId, { activate: false, announce: false });

	// Real Chrome always answers this; the fixture's default `{}` would leave the viewport unknown.
	fixture.script('Page.getLayoutMetrics', (request, self) => {
		self.reply(request.id, {
			layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
			visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 1 },
			contentSize: { x: 0, y: 0, width: 800, height: 2400 },
		});
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
	const watchdog = new DefaultActionWatchdog(host, options);
	watchdog.attach();

	return {
		fixture,
		client,
		bus,
		manager,
		host,
		watchdog,
		targetId: page.targetId,
		sent: (method) => fixture.requestsFor(method),
		scriptCalls: (route) => {
			fixture.script('DOM.resolveNode', (request, self) => {
				self.reply(request.id, { object: { type: 'object', objectId: 'OBJECT-1' } });
			});
			fixture.script('Runtime.callFunctionOn', (request, self) => {
				const declaration = String(request.params.functionDeclaration ?? '');
				const args = (request.params.arguments as { value?: unknown }[] ?? []).map((entry) => entry.value);
				self.reply(request.id, { result: { type: 'object', value: route(declaration, args) } });
			});
		},
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await manager.stop();
			await bus.stop();
			await client.close();
			await fixture.close();
		},
	};
}

/** Routes one `Runtime.callFunctionOn` by the source of the function being called. */
type PageRoute = (declaration: string, args: readonly unknown[]) => unknown;

/**
 * A page that answers the action layer's probes the way a healthy document would.
 *
 * Routing on the function *source* rather than on call order is what keeps these tests readable: the
 * cascades call focus probes, occlusion probes and value reads in an order that is an implementation
 * detail, and a positional queue would encode that order as if it were the contract.
 */
function pageRouter(options: {
	values?: readonly string[];
	occluded?: boolean;
	extra?: PageRoute;
} = {}): PageRoute {
	const queue = [...(options.values ?? [''])];
	return (declaration, args) => {
		const custom = options.extra?.(declaration, args);
		if (custom !== undefined) return custom;
		if (declaration.includes('elementFromPoint')) {
			const occluded = options.occluded === true;
			return { reason: 'ok', occluded, hitTag: occluded ? 'div' : 'button' };
		}
		if (declaration.includes('activeElement')) return true;
		if (declaration.includes('_valueTracker')) return String(args[0] ?? '');
		if (declaration.includes("typeof this.value === 'string'")) {
			return queue.length > 1 ? queue.shift() : queue[0] ?? '';
		}
		if (declaration.includes('getBoundingClientRect')) return { x: 0, y: 0, width: 100, height: 40 };
		if (declaration.includes('dispatchEvent')) return true;
		return null;
	};
}

/** A host with no transport, for the handlers that must fail before touching CDP. */
function offlineHost(bus: EventBus, overrides: Partial<WatchdogHost> = {}): WatchdogHost {
	return {
		eventBus: bus,
		profile: createBrowserProfile(),
		logger: silentBusLogger,
		cdpClient: null,
		sessionManager: null,
		cdpUrl: null,
		isLocal: true,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

// ERRATUM(E-49) moved the count and this test's title with it: `HoverEvent` is the fourteenth.
Deno.test('default-action: attach subscribes all 14 command handlers of §5.1.1 (13 + E-49’s hover)', async () => {
	await using h = await harness();
	const events = [
		ClickElementEvent,
		ClickCoordinateEvent,
		HoverEvent,
		TypeTextEvent,
		ScrollEvent,
		GoBackEvent,
		GoForwardEvent,
		RefreshEvent,
		WaitEvent,
		SendKeysEvent,
		UploadFileEvent,
		GetDropdownOptionsEvent,
		SelectDropdownOptionEvent,
		ScrollToTextEvent,
	];
	assertEquals(DefaultActionWatchdog.LISTENS_TO.length, 14);
	for (const event of events) assertEquals(h.bus.handlerCount(event), 1, event.eventName);
});

// ---------------------------------------------------------------------------
// guard rails — data, not exceptions
// ---------------------------------------------------------------------------

Deno.test('default-action: clicking a <select> returns {validationError} and dispatches no input', async () => {
	await using h = await harness();
	const node = makeNode({ nodeName: 'SELECT', attributes: { id: 'country' } });

	const result = await h.bus.dispatch(new ClickElementEvent({ node }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertStringIncludes(String(result?.validationError), 'browser chrome');
	assertStringIncludes(String(result?.validationError), 'select_dropdown');
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 0, 'a guard rail must not reach the browser');
});

Deno.test('default-action: clicking a file input returns {validationError} pointing at upload_file', async () => {
	await using h = await harness();
	const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'file' } });

	const result = await h.bus.dispatch(new ClickElementEvent({ node }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertStringIncludes(String(result?.validationError), 'upload_file');
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 0);
});

Deno.test('default-action: the typing guard rails cover select, file inputs and non-text elements', () => {
	assertEquals(clickGuardRail(makeNode({ nodeName: 'BUTTON' })), null);
	assertEquals(typeGuardRail(makeNode({ nodeName: 'INPUT', attributes: { type: 'text' } })), null);
	assertEquals(typeGuardRail(makeNode({ nodeName: 'TEXTAREA' })), null);
	assertEquals(typeGuardRail(makeNode({ nodeName: 'DIV', attributes: { contenteditable: '' } })), null);
	assertEquals(typeGuardRail(makeNode({ nodeName: 'DIV', attributes: { contenteditable: 'true' } })), null);

	assertStringIncludes(String(typeGuardRail(makeNode({ nodeName: 'SELECT' }))?.validationError), 'select_dropdown');
	assertStringIncludes(
		String(typeGuardRail(makeNode({ nodeName: 'INPUT', attributes: { type: 'FILE' } }))?.validationError),
		'upload_file',
	);
	assertStringIncludes(
		String(typeGuardRail(makeNode({ nodeName: 'DIV' }))?.validationError),
		'does not accept text input',
	);
});

Deno.test('default-action: typing into a <select> never reaches the keyboard', async () => {
	await using h = await harness();
	const result = await h.bus.dispatch(new TypeTextEvent({ node: makeNode({ nodeName: 'SELECT' }), text: 'x' }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assert(result?.validationError !== undefined);
	assertEquals(h.sent('Input.dispatchKeyEvent').length, 0);
});

// ---------------------------------------------------------------------------
// print-dialog interception
// ---------------------------------------------------------------------------

Deno.test('default-action: print triggers are recognised narrowly', () => {
	const trigger = (init: Partial<EnhancedDomTreeNode> & { nodeName: string }): boolean =>
		isPrintDialogTrigger(makeNode(init));

	assertEquals(trigger({ nodeName: 'A', attributes: { onclick: 'window.print()' } }), true);
	assertEquals(trigger({ nodeName: 'BUTTON', attributes: { onclick: 'print();return false' } }), true);
	assertEquals(trigger({ nodeName: 'A', attributes: { href: 'javascript:window.print()' } }), true);
	assertEquals(trigger({ nodeName: 'BUTTON', attributes: { 'aria-label': 'Print' } }), true);
	assertEquals(trigger({ nodeName: 'DIV', attributes: { role: 'button', title: 'Print this page' } }), true);
	assertEquals(trigger({ nodeName: 'INPUT', attributes: { type: 'submit', value: 'Print' } }), true);

	// False positives silently *do not click* what the agent asked for, so the rule stays narrow.
	assertEquals(trigger({ nodeName: 'A', attributes: { 'aria-label': 'Print' } }), false, 'links need a print() call');
	assertEquals(trigger({ nodeName: 'BUTTON', attributes: { 'aria-label': '3D printing services' } }), false);
	assertEquals(trigger({ nodeName: 'BUTTON', attributes: { onclick: 'fingerprint()' } }), false);
	assertEquals(trigger({ nodeName: 'BUTTON', attributes: { onclick: 'this.blueprint(1)' } }), false);
	assertEquals(trigger({ nodeName: 'BUTTON' }), false);
});

Deno.test('default-action: a print-dialog click becomes Page.printToPDF, not a mouse press', async () => {
	await using h = await harness();
	h.fixture.script('Page.printToPDF', (request, self) => {
		self.reply(request.id, { data: 'QUJDRA==' });
	});
	const node = makeNode({ nodeName: 'BUTTON', attributes: { onclick: 'window.print()' } });

	const result = await h.bus.dispatch(new ClickElementEvent({ node }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(result?.printDialogIntercepted, true);
	assertEquals(result?.pdfBytes, 4);
	assertEquals(result?.pdfBase64, undefined, 'the payload stays out of the event result by default');
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 0);
	assertEquals(h.sent('Page.printToPDF').length, 1);
});

Deno.test('default-action: the intercepted PDF payload is available on request', async () => {
	await using h = await harness({ includePrintPdfData: true });
	h.fixture.script('Page.printToPDF', (request, self) => {
		self.reply(request.id, { data: 'QUJDRA==' });
	});
	const result = await h.bus
		.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'BUTTON', attributes: { onclick: 'print()' } }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(result?.pdfBase64, 'QUJDRA==');
});

Deno.test('default-action: base64 byte length is computed without decoding', () => {
	assertEquals(base64ByteLength(''), 0);
	assertEquals(base64ByteLength('QUJD'), 3);
	assertEquals(base64ByteLength('QUJDRA=='), 4);
	assertEquals(base64ByteLength('QUJDREU='), 5);
});

// ---------------------------------------------------------------------------
// the click cascade
// ---------------------------------------------------------------------------

/** Quads + an occlusion verdict: the ordinary click path. */
function scriptClickablePage(h: Harness, occluded = false): void {
	h.fixture.script('DOM.getContentQuads', (request, self) => {
		self.reply(request.id, { quads: [[10, 10, 110, 10, 110, 50, 10, 50]] });
	});
	h.scriptCalls(pageRouter({ occluded }));
}

Deno.test('default-action: the cascade runs scrollIntoView → geometry → occlusion → mouse', async () => {
	await using h = await harness();
	scriptClickablePage(h);

	const node = makeNode({ nodeName: 'BUTTON', attributes: { id: 'go' } });
	const result = await h.bus.dispatch(new ClickElementEvent({ node }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(h.sent('DOM.scrollIntoViewIfNeeded').length, 1, 'step 1 of §6.10');
	assertEquals(h.sent('DOM.getContentQuads').length, 1, 'step 2');
	assertEquals(h.sent('Runtime.callFunctionOn').length, 1, 'step 3: one occlusion probe');
	assertEquals(result?.clickX, 60);
	assertEquals(result?.clickY, 30);
	assertEquals(result?.strategy, 'contentQuads');
	assertEquals(result?.method, 'mouse');
	assertEquals(result?.occluded, false);
	assertEquals(
		h.sent('Input.dispatchMouseEvent').map((frame) => frame.params.type),
		['mouseMoved', 'mousePressed', 'mouseReleased'],
	);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-48) — the click-count ramp
// ---------------------------------------------------------------------------

Deno.test('E-48: a single click is unchanged — one pair, clickCount 1', async () => {
	await using h = await harness();
	scriptClickablePage(h);
	const result = await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'BUTTON' }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	const presses = h.sent('Input.dispatchMouseEvent').filter((frame) => frame.params.type === 'mousePressed');
	assertEquals(presses.length, 1);
	assertEquals(presses[0]?.params.clickCount, 1);
	assertEquals(result?.clickCount, 1);
});

Deno.test('E-48: a double click is TWO pairs, counted 1 then 2 — not one pair carrying 2', async () => {
	await using h = await harness();
	scriptClickablePage(h);
	const result = await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'BUTTON' }), clickCount: 2 }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	const frames = h.sent('Input.dispatchMouseEvent');
	assertEquals(
		frames.map((frame) => [frame.params.type, frame.params.clickCount]),
		[
			['mouseMoved', undefined],
			['mousePressed', 1],
			['mouseReleased', 1],
			['mouseMoved', undefined],
			['mousePressed', 2],
			['mouseReleased', 2],
		],
		'the page must see click at count 1 and dblclick at count 2, exactly as a human produces them',
	);
	assertEquals(result?.clickCount, 2);
});

Deno.test('E-48: the right button reaches the wire on both the press and the release', async () => {
	await using h = await harness();
	scriptClickablePage(h);
	await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'BUTTON' }), button: 'right' }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	const frames = h.sent('Input.dispatchMouseEvent');
	assertEquals(frames[1]?.params.button, 'right');
	assertEquals(frames[2]?.params.button, 'right');
});

Deno.test('E-48: the coordinate click ramps too', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter());
	await h.bus.dispatch(new ClickCoordinateEvent({ coordinateX: 10, coordinateY: 20, clickCount: 2 }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	const presses = h.sent('Input.dispatchMouseEvent').filter((frame) => frame.params.type === 'mousePressed');
	assertEquals(presses.map((frame) => frame.params.clickCount), [1, 2]);
});

Deno.test('E-48: the JavaScript occlusion fallback reports NO click count', async () => {
	await using h = await harness();
	scriptClickablePage(h, true);
	const result = await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'BUTTON' }), clickCount: 2 }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(result?.method, 'javascript');
	assertEquals(result?.clickCount, undefined, 'a JS click dispatched no mouse events, so it counted none');
});

// ---------------------------------------------------------------------------
// ERRATUM(E-49) — hover
// ---------------------------------------------------------------------------

Deno.test('E-49: an element hover runs the click geometry and then moves ONLY', async () => {
	await using h = await harness();
	scriptClickablePage(h);
	const result = await h.bus.dispatch(new HoverEvent({ node: makeNode({ nodeName: 'BUTTON' }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(h.sent('DOM.scrollIntoViewIfNeeded').length, 1, 'the same step 1 as the click');
	assertEquals(h.sent('DOM.getContentQuads').length, 1, 'the same step 2');
	assertEquals(
		h.sent('Input.dispatchMouseEvent').map((frame) => frame.params.type),
		['mouseMoved'],
		'a hover presses nothing',
	);
	assertEquals(result?.hoverX, 60);
	assertEquals(result?.hoverY, 30);
	assertEquals(result?.occluded, false);
});

Deno.test('E-49: an occluded hover still moves and reports what is on top — no JS fallback', async () => {
	await using h = await harness();
	scriptClickablePage(h, true);
	const result = await h.bus.dispatch(new HoverEvent({ node: makeNode({ nodeName: 'BUTTON' }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(result?.occluded, true);
	assertEquals(result?.hitTag, 'div');
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 1, 'the move happened');
	assertEquals(h.sent('Runtime.callFunctionOn').length, 1, 'the occlusion probe only — never a JS click');
});

Deno.test('E-49: a coordinate hover clamps to the viewport and hit-tests the point', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter());
	const result = await h.bus.dispatch(new HoverEvent({ coordinateX: 5000, coordinateY: 20 }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(result?.clamped, true);
	assertEquals(result?.hoverX, 799, 'clamped into the 800x600 fixture viewport');
	assertEquals(h.sent('Input.dispatchMouseEvent').map((frame) => frame.params.type), ['mouseMoved']);
});

Deno.test('E-49: an element with no geometry cannot be hovered, and says so', async () => {
	await using h = await harness();
	for (const method of ['DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.resolveNode']) {
		h.fixture.script(method, (request, self) => {
			self.replyError(request.id, { code: -32000, message: 'No node with given id found' });
		});
	}
	const error = await assertRejects(() =>
		h.bus.dispatch(new HoverEvent({ node: makeNode({ nodeName: 'BUTTON', absolutePosition: null }) }))
			.eventResult({ raiseIfAny: true, raiseIfNone: true })
	);
	assertStringIncludes(String(error), 'no hoverable geometry');
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 0);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-50) — a chord aimed at a named element
// ---------------------------------------------------------------------------

Deno.test('E-50: sendKeys with a node focuses it with DOM.focus and never clicks it', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter());
	h.fixture.script('DOM.focus', (request, self) => self.reply(request.id, {}));

	await h.bus.dispatch(new SendKeysEvent({ keys: 'ctrl+a', node: makeNode({ nodeName: 'INPUT' }) }))
		.eventResult({ raiseIfAny: true });

	// Twice: once to take focus, once immediately before the first dispatch. Security review
	// B2-SR4-8 — nothing re-checked between the two, so a `focus`/`focusin` handler could move focus
	// away while the result still claimed the chord landed on this element.
	assertEquals(h.sent('DOM.focus').length, 2, 'focus is moved by DOM.focus, not by a click, and re-asserted');
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 0, 'a key press must not press the mouse');
	assertEquals(h.sent('Input.dispatchKeyEvent').length, 2);
});

Deno.test('B2-SR4-8: focus lost between the take and the dispatch is an error, not a chord sent elsewhere', async () => {
	await using h = await harness();
	let focusChecks = 0;
	// The element takes focus, then loses it — the shape a page's own `focusin` handler produces.
	h.scriptCalls(pageRouter({
		extra: (declaration) => declaration.includes('activeElement') ? ++focusChecks === 1 : undefined,
	}));
	h.fixture.script('DOM.focus', (request, self) => self.reply(request.id, {}));

	const error = await assertRejects(() =>
		h.bus.dispatch(new SendKeysEvent({ keys: 'ctrl+a', node: makeNode({ nodeName: 'INPUT' }) }))
			.eventResult({ raiseIfAny: true })
	);
	assertStringIncludes(String(error), 'lost keyboard focus');
	assertEquals(h.sent('Input.dispatchKeyEvent').length, 0, 'nothing may be pressed after the check fails');
});

Deno.test('B2-SR4-8: a malformed chord is refused before focus is moved at all', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter());
	h.fixture.script('DOM.focus', (request, self) => self.reply(request.id, {}));
	await assertRejects(() =>
		h.bus.dispatch(new SendKeysEvent({ keys: 'hyper+a', node: makeNode({ nodeName: 'INPUT' }) }))
			.eventResult({ raiseIfAny: true })
	);
	// One `DOM.focus`, from taking focus — the parse happens before the re-assert, so a bad chord
	// never reaches the second check and never presses anything.
	assertEquals(h.sent('Input.dispatchKeyEvent').length, 0);
});

Deno.test('E-50: sendKeys without a node is byte-for-byte the pre-erratum path', async () => {
	await using h = await harness();
	await h.bus.dispatch(new SendKeysEvent({ keys: 'ctrl+a' })).eventResult({ raiseIfAny: true });
	assertEquals(h.sent('DOM.focus').length, 0, 'no node means no focus move at all');
	assertEquals(h.sent('Input.dispatchKeyEvent').length, 2);
});

Deno.test('E-50: an element that refuses focus is an error, not a chord sent somewhere else', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter({ extra: (declaration) => declaration.includes('activeElement') ? false : undefined }));
	h.fixture.script('DOM.focus', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'Element is not focusable' });
	});
	const error = await assertRejects(() =>
		h.bus.dispatch(new SendKeysEvent({ keys: 'Enter', node: makeNode({ nodeName: 'DIV' }) }))
			.eventResult({ raiseIfAny: true })
	);
	assertStringIncludes(String(error), 'could not take keyboard focus');
	assertEquals(h.sent('Input.dispatchKeyEvent').length, 0);
});

Deno.test('default-action: an occluded element falls back to a JS click and says so', async () => {
	await using h = await harness();
	scriptClickablePage(h, true);

	const result = await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'BUTTON' }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(result?.method, 'javascript', 'ERRATUM(M1-watchdogs-action-1)');
	assertEquals(result?.occluded, true);
	assertEquals(result?.hitTag, 'div');
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 0);
	assertEquals(h.sent('Runtime.callFunctionOn').length, 2, 'the occlusion probe, then the JS click');
});

Deno.test('default-action: click-through can be switched off, and then the mouse still clicks', async () => {
	await using h = await harness({ clickThroughOcclusion: false });
	scriptClickablePage(h, true);

	const result = await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'BUTTON' }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(result?.method, 'mouse');
	assertEquals(result?.occluded, true);
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 3);
});

Deno.test('default-action: an element with no geometry is a typed error, not a click at the origin', async () => {
	await using h = await harness();
	for (const method of ['DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.resolveNode']) {
		h.fixture.script(method, (request, self) => {
			self.replyError(request.id, { code: -32000, message: 'No node with given id found' });
		});
	}
	const node = makeNode({ nodeName: 'BUTTON', absolutePosition: null });
	await assertRejects(
		() => h.bus.dispatch(new ClickElementEvent({ node })).eventResult({ raiseIfAny: true, raiseIfNone: true }),
		ActionError,
		'no clickable geometry',
	);
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 0);
});

Deno.test('default-action: a coordinate click clamps into the viewport and hit-tests unless forced', async () => {
	await using h = await harness();
	h.fixture.script('DOM.getNodeForLocation', (request, self) => {
		self.reply(request.id, { backendNodeId: 7, frameId: 'FRAME' });
	});
	h.fixture.script('DOM.describeNode', (request, self) => {
		self.reply(request.id, {
			node: { nodeId: 7, backendNodeId: 7, nodeType: 1, nodeName: 'CANVAS', localName: 'canvas', nodeValue: '' },
		});
	});

	const result = await h.bus.dispatch(new ClickCoordinateEvent({ coordinateX: 4000, coordinateY: 12 }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(result.clickX, 799);
	assertEquals(result.clamped, true);
	assertEquals(result.hitTag, 'canvas');
	assertEquals(h.sent('DOM.getNodeForLocation').length, 1);

	await h.bus.dispatch(new ClickCoordinateEvent({ coordinateX: 10, coordinateY: 10, force: true }))
		.eventResult({ raiseIfAny: true });
	assertEquals(h.sent('DOM.getNodeForLocation').length, 1, 'force skips the hit test');
});

// ---------------------------------------------------------------------------
// download detection through the §6.8 seam
// ---------------------------------------------------------------------------

Deno.test('default-action: DownloadsWatchdog satisfies the click seam, and the timings agree', () => {
	// Compile-time proof that §6.8's watchdog is a `ClickDownloadSource` without either file
	// importing the other's interface. A shape change on either side fails `deno check`.
	const seam: (watchdog: DownloadsWatchdog) => ClickDownloadSource = (watchdog) => watchdog;
	assert(typeof seam === 'function');

	assertEquals(DOWNLOAD_START_GRACE_MS, 500, 'ARCHITECTURE.md §6.10/§8');
	assertEquals(DOWNLOAD_COMPLETION_TIMEOUT_MS, 30_000, 'ARCHITECTURE.md §6.10/§8');
	assertEquals(DOWNLOAD_START_GRACE_MS, PIPELINE_GRACE_MS, 'the click and the pipeline must not drift');
	assertEquals(DOWNLOAD_COMPLETION_TIMEOUT_MS, PIPELINE_COMPLETION_MS);
});

Deno.test('default-action: a click that starts a download reports it through the real watchdog', async () => {
	await using h = await harness();
	const downloads = new DownloadsWatchdog(h.host, {
		downloadsDir: '/downloads',
		ensureDir: () => Promise.resolve(),
		statFile: () => Promise.resolve({ size: 11, isFile: true }),
		removeFile: () => Promise.resolve(),
		realPath: (path) => Promise.resolve(path),
	});
	downloads.attach();
	h.watchdog.setDownloadChannel(downloads);
	try {
		await h.bus.dispatch(new BrowserConnectedEvent({ cdpUrl: h.fixture.wsUrl })).eventResult({ raiseIfAny: true });
		scriptClickablePage(h);
		// The download begins while the press is still in flight — the case the synchronous channel
		// exists for (ARCHITECTURE.md §6.8).
		h.fixture.script('Input.dispatchMouseEvent', (request, self) => {
			self.reply(request.id);
			if (request.params.type !== 'mousePressed') return;
			self.emit('Browser.downloadWillBegin', {
				frameId: 'FRAME',
				guid: 'GUID-1',
				url: 'http://127.0.0.1:1/report.pdf',
				suggestedFilename: 'report.pdf',
			});
			// The bytes land a beat later, as they do on a real socket.
			setTimeout(
				() =>
					self.emit('Browser.downloadProgress', {
						guid: 'GUID-1',
						totalBytes: 11,
						receivedBytes: 11,
						state: 'completed',
					}),
				20,
			);
		});

		const result = await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'A' }) }))
			.eventResult({ raiseIfAny: true, raiseIfNone: true });

		const download = result?.download as Record<string, unknown> | undefined;
		assert(download !== undefined, 'the click must report the download it caused');
		assertEquals(download.guid, 'GUID-1');
		assertEquals(download.fileName, 'report.pdf');
		assertEquals(download.completed, true);
	} finally {
		downloads.detach();
		await downloads.whenIdle();
	}
});

Deno.test('default-action: with no channel wired, a click still clicks', async () => {
	await using h = await harness();
	scriptClickablePage(h);
	assertEquals(h.watchdog.downloadChannel, null);
	const result = await h.bus.dispatch(new ClickElementEvent({ node: makeNode({ nodeName: 'A' }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(result?.download, undefined);
	assertEquals(h.sent('Input.dispatchMouseEvent').length, 3);
});

// ---------------------------------------------------------------------------
// typing + keys
// ---------------------------------------------------------------------------

Deno.test('default-action: typing is keyDown/char/keyUp per character, with VK codes (R5)', async () => {
	await using h = await harness();
	h.fixture.script('DOM.getContentQuads', (request, self) => {
		self.reply(request.id, { quads: [[0, 0, 100, 0, 100, 20, 0, 20]] });
	});
	h.scriptCalls(pageRouter({ values: ['hi'] }));
	const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'text' } });

	const result = await h.bus.dispatch(new TypeTextEvent({ node, text: 'hi', clear: false }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	const keys = h.sent('Input.dispatchKeyEvent');
	assertEquals(keys.map((frame) => frame.params.type), [
		'keyDown',
		'char',
		'keyUp',
		'keyDown',
		'char',
		'keyUp',
	]);
	assertEquals(keys[0]?.params.code, 'KeyH');
	assertEquals(keys[0]?.params.windowsVirtualKeyCode, 72);
	assertEquals(keys[0]?.params.nativeVirtualKeyCode, 72);
	assertEquals(keys[0]?.params.text, undefined, 'the keyDown must not insert text; the char event does');
	assertEquals(keys[1]?.params.text, 'h');
	assertEquals(keys[3]?.params.windowsVirtualKeyCode, 73, 'i');
	assertEquals(result?.strategy, 'perCharacter');
	assertEquals(result?.inputX, 50);
	assertEquals(result?.actualValue, undefined, 'a value that matched needs no report');
});

Deno.test('default-action: a value that did not stick is reported, and redacted when sensitive', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter({ values: ['reverted'] }));
	const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'text' } });

	const plain = await h.bus.dispatch(new TypeTextEvent({ node, text: 'wanted', clear: false }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(plain?.actualValue, 'reverted');

	const secret = await h.bus
		.dispatch(new TypeTextEvent({ node, text: 'hunter2', clear: false, isSensitive: true }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });
	assertEquals(secret?.actualValue, undefined, 'D-SEC2: a secret never travels back in a result');
	assertEquals(secret?.actualValueMatched, false);
});

Deno.test('default-action: a date input is assigned directly instead of typed character by character', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter({ values: ['2024-03-01'] }));
	const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'date' } });

	const result = await h.bus.dispatch(new TypeTextEvent({ node, text: '2024-03-01', clear: false }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(result?.strategy, 'directValue');
	assertEquals(h.sent('Input.dispatchKeyEvent').length, 0);
});

Deno.test('default-action: clearing selects all and deletes before typing', async () => {
	await using h = await harness();
	// readValue: 'old' (needs clearing) → '' (cleared) → 'new' (final read-back).
	h.scriptCalls(pageRouter({ values: ['old', '', 'new'] }));
	const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'text' } });

	const result = await h.bus.dispatch(new TypeTextEvent({ node, text: 'new', clear: true }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(result?.clearStrategy, 'selectAllDelete');
	const keys = h.sent('Input.dispatchKeyEvent');
	assertEquals(keys[0]?.params.code, 'KeyA');
	assert((keys[0]?.params.modifiers as number) > 0, 'select-all must carry its platform modifier');
	assertEquals(keys[0]?.params.text, undefined, 'a modified key must not insert its character');
	assertEquals(keys[2]?.params.code, 'Delete');
});

Deno.test('default-action: sendKeys sends a modified combo as rawKeyDown + keyUp', async () => {
	await using h = await harness();
	await h.bus.dispatch(new SendKeysEvent({ keys: 'ctrl+a' })).eventResult({ raiseIfAny: true });

	const keys = h.sent('Input.dispatchKeyEvent');
	assertEquals(keys.length, 2);
	assertEquals(keys[0]?.params.type, 'rawKeyDown');
	assertEquals(keys[0]?.params.modifiers, 2);
	assertEquals(keys[0]?.params.windowsVirtualKeyCode, 65);
	assertEquals(keys[0]?.params.text, undefined);
	assertEquals(keys[1]?.params.type, 'keyUp');
});

Deno.test('default-action: sendKeys Enter carries its text so forms submit', async () => {
	await using h = await harness();
	await h.bus.dispatch(new SendKeysEvent({ keys: 'Enter' })).eventResult({ raiseIfAny: true });
	const keys = h.sent('Input.dispatchKeyEvent');
	assertEquals(keys[0]?.params.type, 'keyDown');
	assertEquals(keys[0]?.params.text, '\r');
	assertEquals(keys[0]?.params.windowsVirtualKeyCode, 13);
});

// ---------------------------------------------------------------------------
// scrolling
// ---------------------------------------------------------------------------

Deno.test('default-action: a page scroll is a wheel gesture at the viewport centre', async () => {
	await using h = await harness();
	let offsets = 0;
	h.fixture.script('Runtime.evaluate', (request, self) => {
		const expression = String(request.params.expression);
		if (!expression.includes('scrollX')) {
			self.reply(request.id, { result: { type: 'undefined' } });
			return;
		}
		offsets += 1;
		self.reply(request.id, { result: { type: 'string', value: offsets === 1 ? '[0,0]' : '[0,300]' } });
	});

	await h.bus.dispatch(new ScrollEvent({ direction: 'down', amount: 300 })).eventResult({ raiseIfAny: true });

	const wheels = h.sent('Input.dispatchMouseEvent');
	assertEquals(wheels.length, 1);
	assertEquals(wheels[0]?.params.type, 'mouseWheel');
	assertEquals(wheels[0]?.params.deltaY, 300);
	assertEquals(wheels[0]?.params.deltaX, 0);
});

Deno.test('default-action: a page scroll that the wheel cannot move falls through to script', async () => {
	await using h = await harness();
	h.fixture.script('Runtime.evaluate', (request, self) => {
		const expression = String(request.params.expression);
		if (expression.includes('scrollX')) self.reply(request.id, { result: { type: 'string', value: '[0,0]' } });
		else self.reply(request.id, { result: { type: 'undefined' } });
	});

	await h.bus.dispatch(new ScrollEvent({ direction: 'up', amount: 120 })).eventResult({ raiseIfAny: true });

	const scripted = h.sent('Runtime.evaluate').filter((frame) => String(frame.params.expression).includes('scrollBy'));
	assertEquals(scripted.length, 1);
	assertStringIncludes(String(scripted[0]?.params.expression), 'window.scrollBy(0, -120)');
});

Deno.test('default-action: scroll-to-text that finds nothing throws with a usable memory line', async () => {
	await using h = await harness();
	h.fixture.script('DOM.performSearch', (request, self) => {
		self.reply(request.id, { searchId: 'S1', resultCount: 0 });
	});
	h.fixture.script('Runtime.evaluate', (request, self) => {
		self.reply(request.id, { result: { type: 'string', value: JSON.stringify({ found: false, candidates: 0 }) } });
	});

	const error = await assertRejects(
		() =>
			h.bus.dispatch(new ScrollToTextEvent({ text: 'nowhere' })).eventResult({ raiseIfAny: true, raiseIfNone: true }),
		ActionError,
		'was not found',
	);
	assertEquals(error.longTermMemory, "Text 'nowhere' not found or not visible on page");
});

// ---------------------------------------------------------------------------
// history + wait
// ---------------------------------------------------------------------------

Deno.test('default-action: go back/forward walk the navigation history by entry id', async () => {
	await using h = await harness();
	// The readiness wait ends on a lifecycle event, exactly as §7.5's poller does.
	h.fixture.script('Page.navigateToHistoryEntry', (request, self) => {
		self.reply(request.id);
		self.emitLifecycle(h.targetId, 'load');
	});
	h.fixture.script('Page.getNavigationHistory', (request, self) => {
		self.reply(request.id, {
			currentIndex: 1,
			entries: [
				{ id: 10, url: 'about:blank', userTypedURL: '', title: '', transitionType: 'typed' },
				{ id: 11, url: 'about:blank#a', userTypedURL: '', title: '', transitionType: 'link' },
				{ id: 12, url: 'about:blank#b', userTypedURL: '', title: '', transitionType: 'link' },
			],
		});
	});

	await h.bus.dispatch(new GoBackEvent()).eventResult({ raiseIfAny: true });
	assertEquals(h.sent('Page.navigateToHistoryEntry')[0]?.params.entryId, 10);

	await h.bus.dispatch(new GoForwardEvent()).eventResult({ raiseIfAny: true });
	assertEquals(h.sent('Page.navigateToHistoryEntry')[1]?.params.entryId, 12);
});

Deno.test('default-action: a history with nowhere to go is a no-op, not a failure', async () => {
	await using h = await harness();
	h.fixture.script('Page.getNavigationHistory', (request, self) => {
		self.reply(request.id, {
			currentIndex: 0,
			entries: [{ id: 10, url: 'about:blank', userTypedURL: '', title: '', transitionType: 'typed' }],
		});
	});
	await h.bus.dispatch(new GoBackEvent()).eventResult({ raiseIfAny: true });
	assertEquals(h.sent('Page.navigateToHistoryEntry').length, 0);
});

Deno.test('default-action: refresh reloads and the readiness wait is bounded and non-fatal', async () => {
	await using h = await harness();
	h.fixture.script('Page.reload', (request, self) => {
		self.reply(request.id);
		self.emitLifecycle(h.targetId, 'DOMContentLoaded');
	});
	await h.bus.dispatch(new RefreshEvent()).eventResult({ raiseIfAny: true });
	assertEquals(h.sent('Page.reload').length, 1);
	assertEquals(HISTORY_READINESS_TIMEOUT_MS, 3_000, 'the §7.5 same-domain heuristic, reused');
	assertEquals(HISTORY_READINESS_POLL_MS, 50, 'the §7.5 lifecycle poll cadence');
});

Deno.test('default-action: wait clamps seconds against maxSeconds', async () => {
	using time = new FakeTime();
	const bus = new EventBus({ name: 'wait-test', logger: silentBusLogger });
	const watchdog = new DefaultActionWatchdog(offlineHost(bus));
	watchdog.attach();
	try {
		const startedAt = Date.now();
		const clamped = bus.dispatch(new WaitEvent({ seconds: 60, maxSeconds: 2 }));
		await time.tickAsync(2_000);
		await clamped;
		assertEquals(Date.now() - startedAt, 2_000, 'a 60 s request must be cut to maxSeconds');

		const short = bus.dispatch(new WaitEvent({ seconds: 1, maxSeconds: 10 }));
		await time.tickAsync(1_000);
		await short;
		assertEquals(Date.now() - startedAt, 3_000);

		const negative = bus.dispatch(new WaitEvent({ seconds: -5 }));
		await time.tickAsync(0);
		await negative;
	} finally {
		watchdog.detach();
		await bus.stop();
	}
});

// ---------------------------------------------------------------------------
// dropdowns
// ---------------------------------------------------------------------------

Deno.test('default-action: dropdown options come back as short/long term memory', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter({
		extra: (declaration) =>
			declaration.includes('discover(element)')
				? {
					kind: 'native',
					multiple: false,
					expanded: null,
					options: [
						{ index: 0, text: 'Norway', value: 'no', selected: true, disabled: false },
						{ index: 1, text: 'Sweden', value: 'se', selected: false, disabled: true },
					],
				}
				: undefined,
	}));

	const result = await h.bus.dispatch(new GetDropdownOptionsEvent({ node: makeNode({ nodeName: 'SELECT' }) }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertEquals(Object.keys(result).sort(), ['longTermMemory', 'shortTermMemory']);
	assertStringIncludes(result.shortTermMemory ?? '', '0: Norway (selected)');
	assertStringIncludes(result.shortTermMemory ?? '', '1: Sweden (disabled)');
	assertStringIncludes(result.longTermMemory ?? '', 'Found 2 options');
});

Deno.test('default-action: a missed dropdown option returns the options as data, never a throw', async () => {
	await using h = await harness();
	h.scriptCalls(pageRouter({
		extra: (declaration) => {
			// `inspect` names `discover`; the native select path does not — check the narrower one first.
			if (declaration.includes('discover(element)')) {
				return {
					kind: 'native',
					multiple: false,
					expanded: null,
					options: [{ index: 0, text: 'Norway', value: 'no', selected: false, disabled: false }],
				};
			}
			if (declaration.includes('element.options')) return { selected: false, value: null, text: null, disabled: false };
			return undefined;
		},
	}));

	const result = await h.bus
		.dispatch(new SelectDropdownOptionEvent({ node: makeNode({ nodeName: 'SELECT' }), text: 'Atlantis' }))
		.eventResult({ raiseIfAny: true, raiseIfNone: true });

	assertStringIncludes(result.shortTermMemory ?? '', 'Norway');
	assertStringIncludes(result.validationError ?? '', 'no option matches');
	assertEquals(DROPDOWN_RESULT_TIMEOUT_MS, 3_000, 'AGENT-RUNTIME.md §3.1 inner op');
});

// ---------------------------------------------------------------------------
// upload containment (SECURITY-AUTH.md §8.2)
// ---------------------------------------------------------------------------

async function uploadRejects(
	options: DefaultActionWatchdogOptions,
	filePath: string,
	message: string,
	overrides: Partial<WatchdogHost> = {},
): Promise<void> {
	const bus = new EventBus({ name: 'upload-test', logger: silentBusLogger });
	const watchdog = new DefaultActionWatchdog(offlineHost(bus, overrides), options);
	watchdog.attach();
	try {
		const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'file' } });
		await assertRejects(
			() => bus.dispatch(new UploadFileEvent({ node, filePath })).eventResult({ raiseIfAny: true, raiseIfNone: true }),
			ActionError,
			message,
		);
	} finally {
		watchdog.detach();
		await bus.stop();
	}
}

Deno.test('default-action: upload refuses a relative path rather than resolving it against cwd', async () => {
	await uploadRejects({}, 'notes.txt', 'must be absolute');
});

Deno.test('default-action: upload refuses a path that does not resolve', async () => {
	await uploadRejects({}, `${REPO_ROOT}definitely-not-here-9d3f.txt`, 'could not be resolved');
});

Deno.test('default-action: upload refuses a real file outside the permitted roots', async () => {
	await uploadRejects({ uploadRoots: [`${REPO_ROOT}docs`] }, THIS_FILE, 'outside the permitted directories');
});

Deno.test('default-action: upload sets the file on the input through DOM.setFileInputFiles', async () => {
	await using h = await harness({ uploadRoots: [REPO_ROOT] });
	const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'file' } });

	await h.bus.dispatch(new UploadFileEvent({ node, filePath: THIS_FILE })).eventResult({ raiseIfAny: true });

	const frames = h.sent('DOM.setFileInputFiles');
	assertEquals(frames.length, 1);
	assertEquals(frames[0]?.params.backendNodeId, node.backendNodeId);
	assertEquals((frames[0]?.params.files as string[])[0], await Deno.realPath(THIS_FILE));
});

Deno.test("default-action: a remote browser's upload path is passed through unchecked, by spec", async () => {
	await using h = await harness();
	const remoteHost: WatchdogHost = { ...h.host, isLocal: false };
	const watchdog = new DefaultActionWatchdog(remoteHost);
	const remoteBus = new EventBus({ name: 'remote-upload', logger: silentBusLogger });
	const scoped = new DefaultActionWatchdog({ ...remoteHost, eventBus: remoteBus });
	scoped.attach();
	try {
		const node = makeNode({ nodeName: 'INPUT', attributes: { type: 'file' } });
		// SECURITY-AUTH.md §8.2: "Remote (attached-browser) sessions may pass remote-absolute paths,
		// which are outside local enforcement and documented as such."
		await remoteBus.dispatch(new UploadFileEvent({ node, filePath: '/srv/remote/only/there.csv' }))
			.eventResult({ raiseIfAny: true });
		const frames = h.sent('DOM.setFileInputFiles');
		assertEquals((frames[frames.length - 1]?.params.files as string[])[0], '/srv/remote/only/there.csv');
		assert(watchdog.downloadChannel === null);
	} finally {
		scoped.detach();
		await remoteBus.stop();
	}
});

// ---------------------------------------------------------------------------
// timing constants (COMPLETIONS-CRITERIA.md §3.2: "encoded verbatim and asserted in tests")
// ---------------------------------------------------------------------------

Deno.test("default-action: the inner-op caps are AGENT-RUNTIME §3.1's, verbatim", () => {
	assertEquals(PRINT_TO_PDF_TIMEOUT_MS, 30_000);
	assertEquals(DROPDOWN_RESULT_TIMEOUT_MS, 3_000);
});
