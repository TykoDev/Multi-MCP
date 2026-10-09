import { assert, assertEquals, assertInstanceOf, assertRejects, assertStrictEquals } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import {
	BaseEvent,
	DEFAULT_EVENT_TIMEOUT_SEC,
	EventBus,
	EventNameRegistry,
	EventTimeoutError,
	globalEventRegistry,
	setDefaultEnvSource,
	silentBusLogger,
} from '@tykotech/bus';
import type { EnhancedDomTreeNode } from './dom/types.ts';
import {
	AboutBlankDVDScreensaverShownEvent,
	AgentFocusChangedEvent,
	BROWSER_EVENTS,
	BrowserConnectedEvent,
	BrowserErrorEvent,
	BrowserKillEvent,
	BrowserLaunchEvent,
	BrowserReconnectedEvent,
	BrowserReconnectingEvent,
	BrowserStartEvent,
	BrowserStateRequestEvent,
	BrowserStopEvent,
	BrowserStoppedEvent,
	CaptchaSolverFinishedEvent,
	CaptchaSolverStartedEvent,
	ClickCoordinateEvent,
	ClickElementEvent,
	CloseTabEvent,
	COMMAND_EVENTS,
	DialogOpenedEvent,
	DOWNLOAD_EVENTS,
	DownloadProgressEvent,
	DownloadStartedEvent,
	ElementSelectedEvent,
	ERROR_EVENTS,
	FileDownloadedEvent,
	GetDropdownOptionsEvent,
	GoBackEvent,
	GoForwardEvent,
	HoverEvent,
	LIFECYCLE_EVENTS,
	LoadStorageStateEvent,
	MISC_EVENTS,
	NavigateToUrlEvent,
	NavigationCompleteEvent,
	NavigationStartedEvent,
	NOTIFICATION_EVENTS,
	RefreshEvent,
	sanitizeNodeForEvent,
	SaveStorageStateEvent,
	ScreenshotEvent,
	ScrollEvent,
	ScrollToTextEvent,
	SelectDropdownOptionEvent,
	SendKeysEvent,
	STORAGE_EVENTS,
	StorageStateLoadedEvent,
	StorageStateSavedEvent,
	SwitchTabEvent,
	TabClosedEvent,
	TabCreatedEvent,
	TargetCrashedEvent,
	TypeTextEvent,
	UploadFileEvent,
	WaitEvent,
} from './events.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const FIXTURE_URL = 'http://127.0.0.1:8080/page.html';

function buildNode(overrides: Partial<EnhancedDomTreeNode> = {}): EnhancedDomTreeNode {
	return {
		nodeId: 7,
		backendNodeId: 1423,
		nodeType: 1,
		nodeName: 'BUTTON',
		nodeValue: '',
		attributes: { type: 'submit', id: 'go' },
		isScrollable: false,
		isVisible: true,
		absolutePosition: { x: 10, y: 20, width: 100, height: 30 },
		targetId: 'TARGET-AAAA-BEEF',
		frameId: 'FRAME-1',
		sessionId: 'SESSION-1',
		contentDocument: null,
		shadowRootType: null,
		shadowRoots: null,
		parentNode: null,
		childrenNodes: [],
		axNode: null,
		snapshotNode: null,
		compoundChildren: [{ name: 'slider', role: 'slider' }],
		hasJsClickListener: true,
		hiddenElementsInfo: [{ tagName: 'button', text: 'Submit form', pagesAway: 2.3 }],
		hasHiddenContent: false,
		uuid: '0192f0c4-0000-7000-8000-000000000001',
		...overrides,
	};
}

/** A node wired into every cycle the DOM IR can produce: parent, children, iframe doc, shadow root. */
function buildCyclicNode(): EnhancedDomTreeNode {
	const host = buildNode({ nodeName: 'DIV', shadowRootType: 'open' });
	const child = buildNode({ nodeId: 8, backendNodeId: 1424, nodeName: 'SPAN' });
	const parent = buildNode({ nodeId: 6, backendNodeId: 1422, nodeName: 'FORM' });
	const iframeDoc = buildNode({ nodeId: 9, backendNodeId: 1425, nodeType: 9, nodeName: '#document' });
	const shadow = buildNode({ nodeId: 10, backendNodeId: 1426, nodeType: 11, nodeName: '#document-fragment' });

	host.parentNode = parent;
	parent.childrenNodes = [host];
	host.childrenNodes = [child];
	child.parentNode = host;
	host.contentDocument = iframeDoc;
	iframeDoc.parentNode = host;
	host.shadowRoots = [shadow];
	shadow.parentNode = host;
	host.axNode = {
		axNodeId: 'ax-1',
		ignored: false,
		role: 'button',
		name: 'Go',
		description: null,
		properties: null,
		childIds: null,
	};
	host.snapshotNode = {
		bounds: { x: 0, y: 0, width: 1, height: 1 },
		computedStyles: { display: 'block' },
		cursorStyle: 'pointer',
		paintOrder: 3,
		clientRects: null,
		scrollRects: null,
		stackingContexts: null,
		isClickable: true,
		inputValue: null,
		inputChecked: null,
		optionSelected: null,
		textValue: null,
	};
	return host;
}

/**
 * The DATA-MODEL.md §5.1 timeout tables, transcribed. `null` = the `—` rows, which MUST inherit
 * `DEFAULT_EVENT_TIMEOUT_SEC` rather than restate it (build-run erratum E-1).
 */
const TIMEOUT_TABLE: readonly (readonly [string, number | null])[] = [
	// §5.1.1 commands (18)
	['NavigateToUrlEvent', 30],
	['ClickElementEvent', 15],
	['ClickCoordinateEvent', 15],
	// ERRATUM(E-49). Not in the §5.1 table: the hover is this delivery's addition and takes the click
	// pair's 15 s, because it runs the same geometry resolution and differs only in not pressing.
	['HoverEvent', 15],
	['TypeTextEvent', 60],
	['ScrollEvent', 8],
	['SwitchTabEvent', 10],
	['CloseTabEvent', 10],
	['ScreenshotEvent', 15],
	['BrowserStateRequestEvent', 30],
	['GoBackEvent', 15],
	['GoForwardEvent', 15],
	['RefreshEvent', 15],
	['WaitEvent', 60],
	['SendKeysEvent', 60],
	['UploadFileEvent', 30],
	['GetDropdownOptionsEvent', 15],
	['SelectDropdownOptionEvent', 8],
	['ScrollToTextEvent', 15],
	// §5.1.2 lifecycle (4)
	['BrowserStartEvent', 30],
	['BrowserStopEvent', 45],
	['BrowserLaunchEvent', 30],
	['BrowserKillEvent', 30],
	// §5.1.3 notifications (8)
	['BrowserConnectedEvent', null],
	['BrowserStoppedEvent', null],
	['TabCreatedEvent', null],
	['TabClosedEvent', 3],
	['AgentFocusChangedEvent', 10],
	['TargetCrashedEvent', 10],
	['NavigationStartedEvent', null],
	['NavigationCompleteEvent', null],
	// §5.1.4 error / reconnect (3) — the table carries no timeout column at all
	['BrowserErrorEvent', null],
	['BrowserReconnectingEvent', null],
	['BrowserReconnectedEvent', null],
	// §5.1.5 storage (4)
	['SaveStorageStateEvent', 45],
	['LoadStorageStateEvent', 45],
	['StorageStateSavedEvent', null],
	['StorageStateLoadedEvent', null],
	// §5.1.6 downloads (3)
	['DownloadStartedEvent', 5],
	['DownloadProgressEvent', 5],
	['FileDownloadedEvent', 30],
	// §5.1.7 misc (4)
	['AboutBlankDVDScreensaverShownEvent', null],
	['DialogOpenedEvent', null],
	['CaptchaSolverStartedEvent', 5],
	['CaptchaSolverFinishedEvent', 5],
];

// ---------------------------------------------------------------------------------------------
// Catalog conformance (COMPLETIONS-CRITERIA.md §3.2 M1 event-catalog row)
// ---------------------------------------------------------------------------------------------

// ERRATUM(E-49) moved this test's own name: the specification's 18 command events became 19 when
// `HoverEvent` was added, so 44 became 45. The name moves with the numbers deliberately — a count
// assertion whose title still claims the old total is a test that has stopped saying what it checks.
Deno.test('catalog: 19 + 4 + 8 + 3 + 4 + 3 + 4 = 45 events, grouped per ARCHITECTURE.md §5', () => {
	assertEquals(COMMAND_EVENTS.length, 19, 'E-49 added HoverEvent to the specification’s 18');
	assertEquals(LIFECYCLE_EVENTS.length, 4);
	assertEquals(NOTIFICATION_EVENTS.length, 8);
	assertEquals(ERROR_EVENTS.length, 3);
	assertEquals(STORAGE_EVENTS.length, 4);
	assertEquals(DOWNLOAD_EVENTS.length, 3);
	assertEquals(MISC_EVENTS.length, 4);
	assertEquals(BROWSER_EVENTS.length, 45);
	assertEquals(new Set(BROWSER_EVENTS.map((cls) => cls.eventName)).size, 45);
});

Deno.test('catalog: every class is registered globally at import time (D-BUS1)', () => {
	for (const cls of BROWSER_EVENTS) {
		assert(globalEventRegistry.has(cls), `${cls.eventName} is not registered`);
	}
});

Deno.test('catalog: no event name is a substring of another (the bus registry rule, held true)', () => {
	const names = BROWSER_EVENTS.map((cls) => cls.eventName);
	for (const name of names) {
		assert(/^[A-Z][A-Za-z0-9]*Event$/.test(name), `${name} is not a PascalCase *Event name`);
		for (const other of names) {
			if (other === name) continue;
			assert(!other.includes(name), `${name} is a substring of ${other}`);
		}
	}
});

Deno.test('catalog: per-class timeoutSec matches DATA-MODEL.md §5.1 verbatim', () => {
	assertEquals(TIMEOUT_TABLE.length, 45, 'the transcribed table must cover the whole catalog');
	const byName = new Map(BROWSER_EVENTS.map((cls) => [cls.eventName, cls]));
	assertEquals([...byName.keys()].sort(), TIMEOUT_TABLE.map(([name]) => name).sort());

	for (const [name, expected] of TIMEOUT_TABLE) {
		const cls = byName.get(name);
		assert(cls !== undefined, `${name} missing from the catalog`);
		if (expected === null) {
			// E-1: `—` rows inherit the bus default; they must NOT restate it as a literal.
			assertEquals(
				Object.hasOwn(cls, 'timeoutSec'),
				false,
				`${name} restates the bus default instead of inheriting it`,
			);
			assertEquals(cls.timeoutSec, DEFAULT_EVENT_TIMEOUT_SEC, `${name} default timeout`);
		} else {
			assertEquals(Object.hasOwn(cls, 'timeoutSec'), true, `${name} must pin its own timeout`);
			assertEquals(cls.timeoutSec, expected, `${name} timeout`);
		}
	}
});

Deno.test('catalog: exactly 12 events inherit the 30 s bus default (nine `—` rows + §5.1.4)', () => {
	const inherited = BROWSER_EVENTS.filter((cls) => !Object.hasOwn(cls, 'timeoutSec'));
	assertEquals(inherited.length, 12);
	assertEquals(DEFAULT_EVENT_TIMEOUT_SEC, 30);
});

Deno.test('catalog: TIMEOUT_<EventClassName> overrides a class default (D-BUS1)', () => {
	try {
		setDefaultEnvSource((name) => (name === 'TIMEOUT_ScrollEvent' ? '21' : undefined));
		assertEquals(new ScrollEvent({ direction: 'down', amount: 500 }).eventTimeout, 21);
		// An inherited default is overridable too.
		assertEquals(new TabCreatedEvent({ targetId: 'T1', url: FIXTURE_URL }).eventTimeout, DEFAULT_EVENT_TIMEOUT_SEC);
	} finally {
		setDefaultEnvSource(null);
	}
	assertEquals(new ScrollEvent({ direction: 'down', amount: 500 }).eventTimeout, 8);
});

Deno.test('catalog: the bus enforces the per-class budget on a real dispatch', async () => {
	using time = new FakeTime();
	const bus = new EventBus({ registry: new EventNameRegistry(), logger: silentBusLogger });
	const releases: (() => void)[] = [];
	bus.on(ScrollEvent, () => new Promise<void>((resolve) => releases.push(resolve)));
	bus.on(TabCreatedEvent, () => new Promise<void>((resolve) => releases.push(resolve)));

	const scroll = bus.dispatch(new ScrollEvent({ direction: 'down', amount: 100 }));
	const created = bus.dispatch(new TabCreatedEvent({ targetId: 'T1', url: FIXTURE_URL }));

	await time.tickAsync(8_000);
	assertEquals((await assertRejects(async () => await scroll, EventTimeoutError)).timeoutSec, 8);
	let settled = false;
	created.outcomes().then(() => (settled = true));
	await time.tickAsync(0);
	assertEquals(settled, false, 'the inherited 30 s budget must still be running');

	await time.tickAsync(22_000);
	assertEquals((await assertRejects(async () => await created, EventTimeoutError)).timeoutSec, 30);
	for (const release of releases) release();
});

// ---------------------------------------------------------------------------------------------
// ElementSelectedEvent — the serialization rule (DATA-MODEL.md §5.1, R9.4)
// ---------------------------------------------------------------------------------------------

Deno.test('element events: a cyclic node survives JSON.stringify with the five refs nulled', () => {
	const node = buildCyclicNode();
	const event = new ClickElementEvent({ node });

	assertEquals(event.node.parentNode, null);
	assertEquals(event.node.childrenNodes, []);
	assertEquals(event.node.contentDocument, null);
	assertEquals(event.node.axNode, null);
	assertEquals(event.node.snapshotNode, null);

	const json = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
	assertEquals(json.eventType, 'ClickElementEvent');
	assertEquals(json.button, 'left');
	const serializedNode = json.node as Record<string, unknown>;
	assertEquals(serializedNode.backendNodeId, node.backendNodeId);
	assertEquals(serializedNode.parentNode, null);
});

Deno.test('element events: shadow roots are sanitized recursively, not dropped', () => {
	const node = buildCyclicNode();
	const event = new ClickElementEvent({ node });
	const roots = event.node.shadowRoots;
	assert(roots !== null && roots.length === 1);
	assertEquals(roots[0]?.parentNode, null);
	assertEquals(roots[0]?.backendNodeId, 1426);
	JSON.stringify(event);
});

Deno.test('element events: a self-referencing shadow root terminates instead of overflowing', () => {
	const node = buildNode();
	node.shadowRoots = [node];
	const sanitized = sanitizeNodeForEvent(node);
	assertEquals(sanitized.shadowRoots?.length, 1);
	assertEquals(sanitized.shadowRoots?.[0]?.shadowRoots, null);
	JSON.stringify(sanitized);
});

Deno.test('element events: the copy is deep — the live IR is never mutated or aliased', () => {
	const node = buildCyclicNode();
	const event = new ClickElementEvent({ node });

	assert(event.node !== node, 'the event must hold a copy');
	assertEquals(node.childrenNodes.length, 1, 'the original keeps its children');
	assert(node.axNode !== null, 'the original keeps its AX node');

	event.node.attributes.id = 'mutated';
	assertEquals(node.attributes.id, 'go');
	assert(event.node.absolutePosition !== node.absolutePosition);
	assert(event.node.compoundChildren[0] !== node.compoundChildren[0]);
	assert(event.node.hiddenElementsInfo[0] !== node.hiddenElementsInfo[0]);
});

Deno.test('element events: all eight element-targeted commands share the base and its rule (six + E-49, E-50)', () => {
	const node = buildCyclicNode();
	const events = [
		new ClickElementEvent({ node }),
		new TypeTextEvent({ node, text: 'hello' }),
		new ScrollEvent({ direction: 'down', amount: 100, node }),
		new UploadFileEvent({ node, filePath: '/tmp/a.png' }),
		new GetDropdownOptionsEvent({ node }),
		new SelectDropdownOptionEvent({ node, text: 'Option A' }),
		// ERRATUM(E-49) and ERRATUM(E-50): both take a node, so both must survive the cycle strip.
		new HoverEvent({ node }),
		new SendKeysEvent({ keys: 'Enter', node }),
	];
	assertEquals(events.length, 8);
	for (const event of events) {
		// `assertInstanceOf` needs a public constructor; the base deliberately keeps its own protected.
		assert(event instanceof ElementSelectedEvent, `${event.eventType} must extend ElementSelectedEvent`);
		assertEquals(event.node?.parentNode ?? null, null);
		JSON.stringify(event);
	}
});

Deno.test('element events: ScrollEvent targets the page when node is omitted', () => {
	const pageScroll = new ScrollEvent({ direction: 'up', amount: 250 });
	assertEquals(pageScroll.node, null);
	assertEquals(pageScroll.direction, 'up');
	assertEquals(pageScroll.amount, 250);
	assertEquals(JSON.parse(JSON.stringify(pageScroll)).node, null);
});

// ---------------------------------------------------------------------------------------------
// Field + default parity with §5.1 (spot-checked where the spec states a default)
// ---------------------------------------------------------------------------------------------

Deno.test('fields: command-event defaults match §5.1.1', () => {
	const navigate = new NavigateToUrlEvent({ url: FIXTURE_URL });
	assertEquals([navigate.waitUntil, navigate.timeoutMs, navigate.newTab], ['load', null, false]);
	assertEquals(new NavigateToUrlEvent({ url: FIXTURE_URL, waitUntil: 'commit', newTab: true }).waitUntil, 'commit');

	assertEquals(new ClickElementEvent({ node: buildNode() }).button, 'left');
	const coordinate = new ClickCoordinateEvent({ coordinateX: 12, coordinateY: 34 });
	assertEquals([coordinate.coordinateX, coordinate.coordinateY, coordinate.button, coordinate.force], [
		12,
		34,
		'left',
		false,
	]);

	const type = new TypeTextEvent({ node: buildNode(), text: 'secret' });
	assertEquals([type.clear, type.isSensitive, type.sensitiveKeyName], [true, false, null]);

	assertEquals(new SwitchTabEvent().targetId, null);
	assertEquals(new SwitchTabEvent({ targetId: 'T9' }).targetId, 'T9');
	assertEquals(new CloseTabEvent({ targetId: 'T9' }).targetId, 'T9');

	const shot = new ScreenshotEvent();
	assertEquals([shot.fullPage, shot.clip], [false, null]);

	const state = new BrowserStateRequestEvent();
	assertEquals([state.includeDom, state.includeScreenshot, state.includeRecentEvents], [true, true, false]);

	const wait = new WaitEvent();
	assertEquals([wait.seconds, wait.maxSeconds], [3, 10]);
	assertEquals(new SendKeysEvent({ keys: 'ctrl+a' }).keys, 'ctrl+a');
	assertEquals(new ScrollToTextEvent({ text: 'Submit' }).direction, null);
	assertEquals(new UploadFileEvent({ node: buildNode(), filePath: '/tmp/a.png' }).filePath, '/tmp/a.png');
	assertEquals(new SelectDropdownOptionEvent({ node: buildNode(), text: 'A' }).text, 'A');
	for (const event of [new GoBackEvent(), new GoForwardEvent(), new RefreshEvent()]) {
		assertEquals(Object.keys(event.toJSON()).includes('eventId'), true);
	}
});

Deno.test('fields: lifecycle, notification and error events match §5.1.2–§5.1.4', () => {
	const start = new BrowserStartEvent();
	assertEquals([start.cdpUrl, start.launchOptions], [null, null]);
	assertEquals(new BrowserStartEvent({ cdpUrl: FIXTURE_URL, launchOptions: { headless: true } }).launchOptions, {
		headless: true,
	});
	assertEquals(new BrowserStopEvent().force, false);
	assertEquals(new BrowserStopEvent({ force: true }).force, true);
	assertEquals(BrowserLaunchEvent.eventName, 'BrowserLaunchEvent');
	assertEquals(BrowserKillEvent.eventName, 'BrowserKillEvent');

	assertEquals(new BrowserConnectedEvent({ cdpUrl: FIXTURE_URL }).cdpUrl, FIXTURE_URL);
	assertEquals(new BrowserStoppedEvent({ reason: 'agent finished' }).reason, 'agent finished');
	assertEquals(new TabClosedEvent({ targetId: 'T1' }).targetId, 'T1');
	assertEquals(new AgentFocusChangedEvent({ targetId: 'T1', url: FIXTURE_URL }).url, FIXTURE_URL);
	assertEquals(new TargetCrashedEvent({ targetId: 'T1', error: 'oom' }).error, 'oom');
	assertEquals(new NavigationStartedEvent({ targetId: 'T1', url: FIXTURE_URL }).url, FIXTURE_URL);

	const complete = new NavigationCompleteEvent({ targetId: 'T1', url: FIXTURE_URL });
	assertEquals([complete.status, complete.errorMessage, complete.loadingStatus], [null, null, null]);
	const slow = new NavigationCompleteEvent({
		targetId: 'T1',
		url: FIXTURE_URL,
		status: 200,
		loadingStatus: 'timeout after 8s waiting for load (saw: commit)',
	});
	assertEquals(slow.status, 200);

	const error = new BrowserErrorEvent({ errorType: 'NavigationBlocked', message: 'blocked' });
	assertEquals(error.details, {});
	assertEquals(new BrowserReconnectingEvent({ cdpUrl: FIXTURE_URL, attempt: 1, maxAttempts: 3 }).maxAttempts, 3);
	assertEquals(
		new BrowserReconnectedEvent({ cdpUrl: FIXTURE_URL, attempt: 2, downtimeSeconds: 3.5 }).downtimeSeconds,
		3.5,
	);
});

Deno.test('fields: storage, download and misc events match §5.1.5–§5.1.7', () => {
	assertEquals(new SaveStorageStateEvent().path, null);
	assertEquals(new LoadStorageStateEvent({ path: '/tmp/state.json' }).path, '/tmp/state.json');
	assertEquals(new StorageStateSavedEvent({ path: '/tmp/s.json', cookiesCount: 3, originsCount: 1 }).cookiesCount, 3);
	assertEquals(new StorageStateLoadedEvent({ path: '/tmp/s.json', cookiesCount: 0, originsCount: 0 }).originsCount, 0);

	const started = new DownloadStartedEvent({ guid: 'g1', url: FIXTURE_URL, suggestedFilename: 'a.pdf' });
	assertEquals(started.autoDownload, false);
	assertEquals(
		new DownloadProgressEvent({ guid: 'g1', receivedBytes: 10, totalBytes: 20, state: 'inProgress' }).state,
		'inProgress',
	);
	const downloaded = new FileDownloadedEvent({ url: FIXTURE_URL, path: '/tmp/a.pdf', fileName: 'a.pdf', fileSize: 9 });
	assertEquals([downloaded.guid, downloaded.fileType, downloaded.mimeType], [null, null, null]);
	assertEquals([downloaded.fromCache, downloaded.autoDownload], [false, false]);

	assertEquals(new AboutBlankDVDScreensaverShownEvent({ targetId: 'T1' }).error, null);
	const dialog = new DialogOpenedEvent({ dialogType: 'confirm', message: 'sure?', url: FIXTURE_URL });
	assertEquals([dialog.dialogType, dialog.frameId], ['confirm', null]);
	const captchaStart = new CaptchaSolverStartedEvent({
		targetId: 'T1',
		vendor: 'vendor-x',
		url: FIXTURE_URL,
		startedAt: '2026-08-13T00:00:00.000Z',
	});
	assertEquals(captchaStart.vendor, 'vendor-x');
	const captchaEnd = new CaptchaSolverFinishedEvent({
		targetId: 'T1',
		durationMs: 1200,
		finishedAt: '2026-08-13T00:00:01.200Z',
		success: true,
	});
	assertEquals([captchaEnd.vendor, captchaEnd.url, captchaEnd.success], [null, null, true]);
});

Deno.test('envelope: events carry the bus envelope and serialize it', () => {
	const event = new NavigateToUrlEvent({ url: FIXTURE_URL });
	assertInstanceOf(event, BaseEvent);
	assertEquals(event.eventType, 'NavigateToUrlEvent');
	assertEquals(event.eventParentId, null);
	assertEquals(event.eventTimeout, 30);
	const json = event.toJSON();
	assertStrictEquals(json.url, FIXTURE_URL);
	assertStrictEquals(json.eventTimeout, 30);
});
