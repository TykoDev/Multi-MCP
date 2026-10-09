/**
 * `PopupsWatchdog` contract (ARCHITECTURE.md §6.4; COMPLETIONS-CRITERIA.md §3.2 watchdog row 4:
 * "alert/confirm/beforeunload accepted, prompt dismissed; two 0.5 s-capped attempts; message
 * surfaced in BrowserStateSummary").
 *
 * Real bus, real `CdpClient`, real CDP frames over `ChromeFixture`: the dialog arrives as an actual
 * `Page.javascriptDialogOpening` frame on the wire and the answer is asserted as an actual
 * `Page.handleJavaScriptDialog` frame, because "did it answer?" is the entire contract — an
 * unanswered dialog wedges the CDP channel for that target.
 */

import { assert, assertEquals } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { EventBus, silentBusLogger } from '@tykotech/bus';
import { CdpClient } from '@tykotech/cdp';
import { ChromeFixture, type FixtureRequest } from '../browser/cdp_fixture_test.ts';
import { SessionManager } from '../browser/session_manager.ts';
import { DialogOpenedEvent, TabCreatedEvent } from '../events.ts';
import { createBrowserProfile, type DialogType } from '../types.ts';
import type { WatchdogHost } from './base.ts';
import {
	DIALOG_HANDLE_ATTEMPTS,
	DIALOG_HANDLE_TIMEOUT_MS,
	DIALOG_MANUAL_TIMEOUT_MS,
	formatPopupMessage,
	MAX_RETAINED_POPUP_MESSAGES,
	normalizeDialogType,
	PopupsWatchdog,
	shouldAcceptDialog,
} from './popups.ts';

const PAGE = 'http://127.0.0.1:8080/dialogs';

interface Harness extends AsyncDisposable {
	readonly fixture: ChromeFixture;
	readonly bus: EventBus;
	readonly manager: SessionManager;
	readonly client: CdpClient;
	readonly watchdog: PopupsWatchdog;
	readonly opened: DialogOpenedEvent[];
	readonly targetId: string;
	readonly sessionId: string;
	sent(method: string): FixtureRequest[];
	/** Emits a real dialog frame and waits for it to be handled. */
	openDialog(type: string, message: string): Promise<void>;
	settle(): Promise<void>;
}

async function harness(): Promise<Harness> {
	const fixture = ChromeFixture.start({ pages: [PAGE] });
	const client = await CdpClient.connect(fixture.wsUrl);
	const bus = new EventBus({ name: 'popups-test', logger: silentBusLogger });
	const manager = new SessionManager(client, { bus, logger: silentBusLogger });
	await manager.start();
	await client.send.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await manager.whenIdle();
	const page = manager.mostRecentPageTarget();
	assert(page !== undefined && page !== null);
	await manager.getOrCreateCdpSession(page.targetId, false);
	await manager.whenIdle();
	const sessionId = fixture.sessionFor(page.targetId);
	assert(sessionId !== null);

	const host: WatchdogHost = {
		eventBus: bus,
		profile: createBrowserProfile(),
		logger: silentBusLogger,
		cdpClient: client,
		sessionManager: manager,
		cdpUrl: fixture.wsUrl,
		isLocal: true,
	};
	const watchdog = new PopupsWatchdog(host);
	watchdog.attach();

	const opened: DialogOpenedEvent[] = [];
	bus.on(DialogOpenedEvent, (event) => void opened.push(event), { wrap: null });

	// The §7.4 step-7 replay: pre-existing tabs are announced after connect, which is what arms us.
	await bus.dispatch(new TabCreatedEvent({ targetId: page.targetId, url: PAGE }));

	const settle = async (): Promise<void> => {
		await client.send.Browser.getVersion();
		await manager.whenIdle();
		await watchdog.whenIdle();
	};

	return {
		fixture,
		bus,
		manager,
		client,
		watchdog,
		opened,
		targetId: page.targetId,
		sessionId,
		sent: (method) => fixture.requestsFor(method),
		openDialog: async (type, message) => {
			fixture.emit('Page.javascriptDialogOpening', {
				url: PAGE,
				message,
				type,
				hasBrowserHandler: false,
			}, sessionId);
			await settle();
		},
		settle,
		[Symbol.asyncDispose]: async () => {
			watchdog.detach();
			await manager.stop();
			await bus.stop();
			await client.close();
			await fixture.close();
		},
	};
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

Deno.test('popups: the disposition table is accept-everything-but-prompt', () => {
	assertEquals(shouldAcceptDialog('alert'), true);
	assertEquals(shouldAcceptDialog('confirm'), true);
	assertEquals(shouldAcceptDialog('beforeunload'), true);
	assertEquals(shouldAcceptDialog('prompt'), false);
	// An unknown kind accepts: an unanswered dialog blocks the whole CDP channel.
	assertEquals(normalizeDialogType('somethingNew'), 'alert');
	assertEquals(normalizeDialogType('prompt'), 'prompt');
});

Deno.test('popups: the message rendering is the `[type] message` of §6.4/§5.3', () => {
	assertEquals(formatPopupMessage('alert', 'saved!'), '[alert] saved!');
	assertEquals(formatPopupMessage('beforeunload', ''), '[beforeunload] ');
});

Deno.test('popups: the two-attempt 0.5 s cap is the speced pair', () => {
	assertEquals(DIALOG_HANDLE_TIMEOUT_MS, 500);
	assertEquals(DIALOG_HANDLE_ATTEMPTS, 2);
	assertEquals(MAX_RETAINED_POPUP_MESSAGES, 100);
});

// ---------------------------------------------------------------------------
// arming
// ---------------------------------------------------------------------------

Deno.test('popups: LISTENS_TO is TabCreatedEvent, and arming is idempotent across tabs', async () => {
	await using h = await harness();
	assertEquals(PopupsWatchdog.LISTENS_TO.map((cls) => cls.eventName), ['TabCreatedEvent']);
	assertEquals(h.watchdog.armed, true);

	// Ten more tabs must not mean ten answers per dialog (ERRATUM(M1-watchdogs-rest-5)).
	for (let index = 0; index < 10; index++) {
		await h.bus.dispatch(new TabCreatedEvent({ targetId: `T${index}`, url: PAGE }));
	}
	await h.openDialog('alert', 'once');
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 1);
});

Deno.test('popups: detach disarms — a dialog after detach is nobody’s business', async () => {
	await using h = await harness();
	h.watchdog.detach();
	assertEquals(h.watchdog.armed, false);
	await h.openDialog('alert', 'ignored');
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 0);
	assertEquals(h.opened, []);
});

// ---------------------------------------------------------------------------
// dispositions
// ---------------------------------------------------------------------------

for (const [type, accept] of [['alert', true], ['confirm', true], ['beforeunload', true], ['prompt', false]] as const) {
	Deno.test(`popups: a ${type} is ${accept ? 'accepted' : 'dismissed'} and recorded`, async () => {
		await using h = await harness();
		await h.openDialog(type, `${type}-body`);

		const answers = h.sent('Page.handleJavaScriptDialog');
		assertEquals(answers.length, 1);
		assertEquals(answers[0]?.params.accept, accept);
		assertEquals(answers[0]?.sessionId, h.sessionId);

		assertEquals(h.watchdog.closedPopupMessages, [formatPopupMessage(type as DialogType, `${type}-body`)]);
		assertEquals(h.watchdog.dialogs[0]?.handled, true);
		assertEquals(h.watchdog.dialogs[0]?.attempts, 1);
		assertEquals(h.watchdog.dialogs[0]?.targetId, h.targetId);
	});
}

Deno.test('popups: the message reaches BrowserStateSummary through DialogOpenedEvent', async () => {
	await using h = await harness();
	await h.openDialog('confirm', 'delete everything?');

	// §5.3's `closedPopupMessages` is assembled by DOMWatchdog from this event
	// (ERRATUM(M1-watchdogs-rest-6)); the rendering is shared so the two cannot drift.
	assertEquals(h.opened.length, 1);
	assertEquals(h.opened[0]?.dialogType, 'confirm');
	assertEquals(h.opened[0]?.message, 'delete everything?');
	assertEquals(h.opened[0]?.url, PAGE);
	assertEquals(h.opened[0]?.frameId, null);
	assertEquals(
		formatPopupMessage(h.opened[0]?.dialogType ?? 'alert', h.opened[0]?.message ?? ''),
		h.watchdog.closedPopupMessages[0],
	);
});

// ---------------------------------------------------------------------------
// ERRATUM(E-53) — the manual hold
// ---------------------------------------------------------------------------

/** Emits a dialog frame without waiting for it to be answered, and waits until it is held. */
async function openHeld(h: Harness, type: string, message: string): Promise<string> {
	h.fixture.emit('Page.javascriptDialogOpening', { url: PAGE, message, type, hasBrowserHandler: false }, h.sessionId);
	for (let attempt = 0; attempt < 200 && h.watchdog.pendingDialogs.length === 0; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const pending = h.watchdog.pendingDialogs[0];
	assert(pending !== undefined, 'the dialog was not held');
	return pending.dialogId;
}

Deno.test('E-53: manual handling is OFF by default, and off is the pre-erratum path exactly', async () => {
	await using h = await harness();
	assertEquals(h.watchdog.manualHandling, false);
	await h.openDialog('prompt', 'your name?');
	// Answered immediately by policy, with no id and no hold — byte for byte what 0.1.0 did.
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 1);
	assertEquals(h.sent('Page.handleJavaScriptDialog')[0]?.params.accept, false);
	assertEquals(h.watchdog.pendingDialogs, []);
	assertEquals(h.opened[0]?.dialogId, '');
	assertEquals(h.watchdog.dialogs[0]?.dialogId, undefined);
});

Deno.test('E-53: an armed watchdog HOLDS a dialog, and a caller can accept it with prompt text', async () => {
	await using h = await harness();
	h.watchdog.setManualHandling(true, 5_000);
	const dialogId = await openHeld(h, 'prompt', 'your name?');

	// The announcement carries the id, and nothing has been answered yet.
	assertEquals(h.opened[0]?.dialogId, dialogId);
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 0, 'a held dialog is not answered by policy');

	assertEquals(h.watchdog.answerDialog(dialogId, { accept: true, promptText: 'Ada' }), true);
	await h.settle();

	const answers = h.sent('Page.handleJavaScriptDialog');
	assertEquals(answers.length, 1);
	// The policy would have DISMISSED a prompt. The caller's answer overrode it, and the caller's text
	// reached the page — neither of which was reachable before this erratum.
	assertEquals(answers[0]?.params.accept, true);
	assertEquals(answers[0]?.params.promptText, 'Ada');
	assertEquals(h.watchdog.dialogs[0]?.answeredByCaller, true);
	assertEquals(h.watchdog.dialogs[0]?.autoFallback, false);
	assertEquals(h.watchdog.pendingDialogs, [], 'the hold is released once answered');
});

Deno.test('E-53: a caller can DISMISS a confirm, which the automatic policy would have accepted', async () => {
	await using h = await harness();
	h.watchdog.setManualHandling(true, 5_000);
	const dialogId = await openHeld(h, 'confirm', 'delete everything?');
	assertEquals(h.watchdog.answerDialog(dialogId, { accept: false }), true);
	await h.settle();
	assertEquals(h.sent('Page.handleJavaScriptDialog')[0]?.params.accept, false);
	// `promptText` is absent, not empty: a confirm has no text and an empty string would be a value.
	assertEquals(h.sent('Page.handleJavaScriptDialog')[0]?.params.promptText, undefined);
});

Deno.test('E-53: an unknown or already-answered id answers false rather than throwing', async () => {
	await using h = await harness();
	h.watchdog.setManualHandling(true, 5_000);
	assertEquals(h.watchdog.answerDialog('d99', { accept: true }), false);
	const dialogId = await openHeld(h, 'alert', 'hi');
	assertEquals(h.watchdog.answerDialog(dialogId, { accept: true }), true);
	await h.settle();
	assertEquals(h.watchdog.answerDialog(dialogId, { accept: true }), false, 'the same id cannot be answered twice');
});

Deno.test('E-53: disarming releases a held dialog to the policy rather than freezing the page', async () => {
	await using h = await harness();
	h.watchdog.setManualHandling(true, 5_000);
	await openHeld(h, 'prompt', 'your name?');
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 0);

	// The only possible answerer just went away. A dialog left held would block the CDP channel for
	// this target for the rest of its 20 s hold, so the policy takes over immediately.
	h.watchdog.setManualHandling(false);
	await h.settle();
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 1);
	assertEquals(h.sent('Page.handleJavaScriptDialog')[0]?.params.accept, false, 'the prompt policy dismisses');
	assertEquals(h.watchdog.dialogs[0]?.autoFallback, true);
	assertEquals(h.watchdog.pendingDialogs, []);
});

Deno.test('E-53: the hold is BOUNDED — it expires into the policy and says so', async () => {
	await using h = await harness();
	// The expiry is the safety property that makes arming safe at all — an unanswered dialog blocks
	// the CDP channel for the whole target — so it is proven by letting it happen, at a hold short
	// enough to test in real time. Faking the clock is not an option here: the same fake would stop
	// the live CDP fixture's own timers.
	h.watchdog.setManualHandling(true, 60);
	const dialogId = await openHeld(h, 'confirm', 'proceed?');
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 0, 'nothing answered while it is held');

	await h.settle();
	assertEquals(h.watchdog.pendingDialogs, [], 'the hold expired');
	assertEquals(h.watchdog.answerDialog(dialogId, { accept: false }), false, 'and cannot be answered late');
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 1);
	assertEquals(h.sent('Page.handleJavaScriptDialog')[0]?.params.accept, true, 'the confirm policy accepts');
	assertEquals(h.watchdog.dialogs[0]?.autoFallback, true);
	assertEquals(h.watchdog.dialogs[0]?.answeredByCaller, false);
});

Deno.test('E-53: the hold cap is 20 s — long enough for a round trip, short enough not to wedge a tab', () => {
	assertEquals(DIALOG_MANUAL_TIMEOUT_MS, 20_000);
});

Deno.test('popups: draining the list hands the messages over exactly once', async () => {
	await using h = await harness();
	await h.openDialog('alert', 'one');
	await h.openDialog('alert', 'two');
	assertEquals(h.watchdog.drainClosedPopupMessages(), ['[alert] one', '[alert] two']);
	assertEquals(h.watchdog.closedPopupMessages, []);
});

Deno.test('popups: the retained list is bounded, oldest first out', async () => {
	await using h = await harness();
	for (let index = 0; index < MAX_RETAINED_POPUP_MESSAGES + 5; index++) {
		await h.openDialog('alert', `m${index}`);
	}
	assertEquals(h.watchdog.closedPopupMessages.length, MAX_RETAINED_POPUP_MESSAGES);
	assertEquals(h.watchdog.closedPopupMessages[0], '[alert] m5');
});

// ---------------------------------------------------------------------------
// the two attempts
// ---------------------------------------------------------------------------

Deno.test('popups: a rejected answer is retried once, then reported', async () => {
	await using h = await harness();
	h.fixture.script('Page.handleJavaScriptDialog', (request, self) => {
		self.replyError(request.id, { code: -32000, message: 'No dialog is showing' });
	});

	await h.openDialog('alert', 'gone already');

	assertEquals(h.sent('Page.handleJavaScriptDialog').length, DIALOG_HANDLE_ATTEMPTS);
	assertEquals(h.watchdog.dialogs[0]?.handled, false);
	assertEquals(h.watchdog.dialogs[0]?.attempts, DIALOG_HANDLE_ATTEMPTS);
	// The message is still recorded: the agent needs to know a dialog appeared even if we lost it.
	assertEquals(h.watchdog.closedPopupMessages, ['[alert] gone already']);
});

Deno.test('popups: an answer that never returns is capped at 0.5 s per attempt', async () => {
	await using h = await harness();

	// Captured before `FakeTime` takes the globals: a real-time guard below, so a regression that
	// stops answering dialogs fails this test instead of parking the runner on a clock that only
	// `tickAsync` can move.
	const realSetTimeout = globalThis.setTimeout.bind(globalThis);
	const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
	let received = 0;
	let arrival: (() => void) | null = null;
	h.fixture.script('Page.handleJavaScriptDialog', () => {
		// Never replies: only the cap can end this attempt. Being *called* is the arrival — the
		// fixture records the command before handing it here.
		received += 1;
		arrival?.();
	});

	/**
	 * Resolves once Chrome has received attempt `count`.
	 *
	 * ERRATUM(LAST-3): the sync point was one `Browser.getVersion()` round trip, on the reasoning
	 * that a round trip is long enough for the answer to have crossed in the other direction. That is
	 * not a happens-before, it is a wall-clock guess: the answer is written by an async handler a bus
	 * dispatch and a socket read away, so on a loaded machine it lands *after* the round trip it was
	 * racing and `attempt 1 is in flight` reads 0 — about one run in forty, measured. The dialog
	 * frame and the answer travel in opposite directions on one socket and nothing orders them, so
	 * the wait has to end on the arrival itself.
	 */
	const attemptReaches = (count: number): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const guard = realSetTimeout(() => reject(new Error(`attempt ${count} never reached Chrome`)), 5_000);
			const settle = (): void => {
				if (received < count) return;
				arrival = null;
				realClearTimeout(guard);
				resolve();
			};
			arrival = settle;
			settle();
		});

	using time = new FakeTime();
	h.fixture.emit('Page.javascriptDialogOpening', {
		url: PAGE,
		message: 'wedged',
		type: 'confirm',
		hasBrowserHandler: false,
	}, h.sessionId);
	await attemptReaches(1);
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 1, 'attempt 1 is in flight');

	// The negative is asserted the other way round, and can only ever miss a violation rather than
	// invent one: a round trip of real time for an early attempt 2 to show up, and it must not have.
	await time.tickAsync(DIALOG_HANDLE_TIMEOUT_MS - 1);
	await h.client.send.Browser.getVersion();
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 1, 'the cap has not elapsed yet');
	await time.tickAsync(2);
	await attemptReaches(2);
	assertEquals(h.sent('Page.handleJavaScriptDialog').length, 2, 'attempt 2 starts as soon as 1 caps');

	await time.tickAsync(DIALOG_HANDLE_TIMEOUT_MS + 1);
	await h.watchdog.whenIdle();
	assertEquals(h.watchdog.dialogs[0]?.handled, false);
	assertEquals(h.watchdog.dialogs[0]?.attempts, DIALOG_HANDLE_ATTEMPTS);
});
