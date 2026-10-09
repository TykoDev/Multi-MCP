/**
 * The two error codes B3.2 adds, each driven through the path that actually raises it.
 *
 * §8 asked for eleven codes and this repository already shipped nine of them, under its own
 * spellings where the condition already had a name (`error_vocabulary_test.ts` is that mapping).
 * These are the two that were genuinely missing, and the acceptance criterion for both is the same:
 * emitted by a **real path**, not declared in an enum and left for a later delivery to produce.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { ToolError } from './errors.ts';
import { downloadFailureReason } from './events.ts';
import { DEFAULT_SESSION_ID, type LaunchedSession, SessionRegistry } from './registry.ts';
import { assertNoHeldDialog, target } from './tools/shared.ts';
import { browserDownload } from './tools/files.ts';
import { browserGetHtml, HTML_LIMIT } from './tools/perception.ts';
import { errorResult } from './dispatch.ts';
import type { Scope } from './scopes.ts';
import {
	CHILD_DOCUMENT,
	type FrameCdpHarness,
	frameCdpHarness,
	type FrameCdpScript,
	TOP_DOC_SENTINEL,
} from '../fixtures/capture_session.ts';
import type { ToolContext } from './types.ts';

function fakeSession(): BrowserSession & { eventBus: EventBus } {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'error-paths' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession & { eventBus: EventBus };
}

function ctxFor(registry: SessionRegistry): ToolContext {
	return { registry, allowedDomains: [], principal: 'test' };
}

// ---------------------------------------------------------------------------
// dialog-open
// ---------------------------------------------------------------------------

/** A popups watchdog stand-in holding the dialogs the test names. */
function fakePopups(held: Array<{ dialogId: string; dialogType: string }>) {
	return {
		pendingDialogs: held.map((entry) => ({ ...entry, message: 'ignored', url: 'x', targetId: null, expiresAt: 0 })),
		manualHandling: held.length > 0,
		answerDialog: () => true,
	};
}

async function registryHoldingDialogs(held: Array<{ dialogId: string; dialogType: string }>) {
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () =>
			Promise.resolve({
				session: fakeSession(),
				downloads: null,
				downloadsDir: null,
				// deno-lint-ignore no-explicit-any -- only `pendingDialogs` is read on this path.
				popups: fakePopups(held) as any,
			}),
	});
	const record = await registry.resolve(DEFAULT_SESSION_ID);
	return { registry, record };
}

Deno.test('dialog-open: a mutating tool is refused while a dialog is held, and carries the id to answer', async () => {
	const { registry, record } = await registryHoldingDialogs([{ dialogId: 'D1', dialogType: 'confirm' }]);
	try {
		const error = await assertRejects(() => target(ctxFor(registry), {}, true), ToolError);
		assertEquals((error as ToolError).code, 'dialog-open');
		// The remedy has to be actionable: the id is what `browser_handle_dialog`
		// takes, and without it the caller would have to go and read the event ring.
		assertEquals((error as ToolError).extras.dialog_id, 'D1');
		assertEquals((error as ToolError).extras.dialog_kind, 'confirm');
		// **Never the dialog's message.** It is page-controlled text; the `dialog`
		// event kind carries it under the caps `events.ts` applies, and this
		// envelope is not that transport.
		assert(
			!JSON.stringify((error as ToolError).structuredPayload).includes('ignored'),
			'the refusal carried the dialog message',
		);
		assert(record.popups !== null);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('dialog-open: a read is never refused, because a read is not blocked by a dialog', async () => {
	const { registry } = await registryHoldingDialogs([{ dialogId: 'D1', dialogType: 'alert' }]);
	try {
		// `mutates: false` — the guard is on the mutating path alone, exactly like
		// the takeover lock beside it.
		const record = await target(ctxFor(registry), {}, false);
		assertEquals(record.id, DEFAULT_SESSION_ID);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('dialog-open: the exemption lets browser_handle_dialog through its own refusal', async () => {
	const { registry } = await registryHoldingDialogs([{ dialogId: 'D1', dialogType: 'prompt' }]);
	try {
		// Without this, a held dialog would be unanswerable: the only tool that can
		// clear it would refuse itself with the error it exists to resolve.
		const record = await target(ctxFor(registry), {}, true, 'answer');
		assertEquals(record.id, DEFAULT_SESSION_ID);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('dialog-open: the oldest held dialog is the one named', async () => {
	const { registry, record } = await registryHoldingDialogs([
		{ dialogId: 'FIRST', dialogType: 'alert' },
		{ dialogId: 'SECOND', dialogType: 'confirm' },
	]);
	try {
		// Dialogs are answered in the order they were raised; naming the newest
		// would send the caller to answer one that is not at the front of the queue.
		const error = assertThrowsToolError(() => assertNoHeldDialog(record));
		assertEquals(error.extras.dialog_id, 'FIRST');
	} finally {
		await registry.shutdown();
	}
});

Deno.test('dialog-open: a session with no dialog watchdog is never refused', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	try {
		const record = await registry.resolve(DEFAULT_SESSION_ID);
		assertEquals(record.popups, null);
		// A deployment that never subscribes to the `dialog` kind holds nothing
		// (E-53), so it pays nothing and sees no behaviour change at all.
		assertNoHeldDialog(record);
		await target(ctxFor(registry), {}, true);
	} finally {
		await registry.shutdown();
	}
});

function assertThrowsToolError(fn: () => void): ToolError {
	try {
		fn();
	} catch (cause) {
		assert(cause instanceof ToolError, `expected a ToolError, got ${String(cause)}`);
		return cause;
	}
	throw new Error('expected a ToolError, nothing was thrown');
}

// ---------------------------------------------------------------------------
// download-failed
// ---------------------------------------------------------------------------

/**
 * A registry whose navigation makes the ledger produce one record in the state the test names.
 *
 * This is the real `browser_download` path: `assertNavigable`, then the navigate dispatch, then the
 * detection loop that looks for a file the session did not have before. What the fake controls is
 * only what the *browser* would have done.
 */
async function registryWhereDownloadEndsAs(state: 'canceled' | 'completed' | 'in_progress', error?: string) {
	const downloads: Array<Record<string, unknown>> = [];
	const session = fakeSession();
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () =>
			Promise.resolve({
				session,
				// The three members `SessionFiles` actually reads. A real `DownloadsWatchdog`
				// would need a live CDP session; `files_test.ts` fakes the ledger interface
				// the same way, for the same reason.
				downloads: {
					downloads,
					isRemoteBrowser: false,
					lookup: (guid: string) => downloads.find((r) => r.guid === guid),
				} as unknown as LaunchedSession['downloads'],
				downloadsDir: null,
				popups: null,
			}),
	});
	const record = await registry.resolve(DEFAULT_SESSION_ID);
	// The navigation is what starts a download, so the ledger gains its record
	// exactly where the browser would have added one.
	session.eventBus.on(
		// deno-lint-ignore no-explicit-any -- matched by constructor name, like the real bus does.
		(await import('@tykotech/browser')).NavigateToUrlEvent as any,
		() => {
			downloads.push({
				guid: 'G1',
				url: 'https://files.test/x.bin',
				suggestedFilename: 'x.bin',
				// Empty exactly as `#reject` leaves it: a record the ledger refused at
				// announcement never got as far as naming a file.
				fileName: state === 'canceled' ? '' : 'x.bin',
				path: '',
				fileSize: 0,
				receivedBytes: 0,
				totalBytes: 0,
				fileType: null,
				mimeType: null,
				autoDownload: false,
				state,
				startedAt: 0,
				// `completedAt: null` is what makes a record read as `pending`
				// (`fileStatusOf`), which is the whole difference between "still
				// downloading" and "the ledger is done with it".
				completedAt: state === 'in_progress' ? null : 1,
				error: error ?? null,
			});
		},
	);
	return { registry, record };
}

Deno.test('download-failed: a download the ledger refused at announcement is an error, not a false success', async () => {
	const { registry } = await registryWhereDownloadEndsAs('canceled', 'the session already tracks 20 downloads');
	try {
		const error = await assertRejects(
			() => browserDownload({ url: 'https://files.test/x.bin' }, ctxFor(registry)),
			ToolError,
		);
		assertEquals((error as ToolError).code, 'download-failed');
		assertEquals((error as ToolError).extras.file_id, 'G1');
		// **The same closed vocabulary the `download.failed` event carries**, from the
		// same classifier — a tool error and an event about one download must not
		// disagree about why it failed. `downloadFailureReason` is what keeps the
		// watchdog's free text off the wire; Chromium's own strings can hold a URL.
		assertEquals((error as ToolError).extras.reason, 'over-session-limit');
		assertEquals(downloadFailureReason('the session already tracks 20 downloads'), 'over-session-limit');
		// And the free text really is absent from the envelope, not merely unused.
		assert(
			!JSON.stringify((error as ToolError).structuredPayload).includes('already tracks'),
			`the ledger's free text reached the wire: ${JSON.stringify((error as ToolError).structuredPayload)}`,
		);
		// A rejected record has no filename, so the message names the id instead
		// of reading like a bug ("the browser announced  but…").
		assert(
			(error as ToolError).message.includes('download G1'),
			`the message should name the id when there is no filename: ${(error as ToolError).message}`,
		);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('download-failed: a download that is merely still running is the ordinary success', async () => {
	const { registry } = await registryWhereDownloadEndsAs('in_progress');
	try {
		const result = await browserDownload({ url: 'https://files.test/x.bin' }, ctxFor(registry));
		const payload = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
		// The complement matters as much as the refusal: `pending` is the ordinary
		// case, and turning it into an error would have made every large download
		// look like a failure.
		assertEquals(payload.started, true);
		assertEquals((payload.file as { status: string }).status, 'pending');
	} finally {
		await registry.shutdown();
	}
});

Deno.test('download-failed: an off-allowlist URL still answers navigation-blocked, not the new code', async () => {
	const { registry } = await registryWhereDownloadEndsAs('completed');
	try {
		const ctx: ToolContext = { registry, allowedDomains: ['example.com'], principal: 'test' };
		const error = await assertRejects(
			() => browserDownload({ url: 'https://files.test/x.bin' }, ctx),
			ToolError,
		);
		// The freeze rule, executable: this path has emitted `navigation-blocked`
		// since B1.12 and a client already matches on it. A new code here would be
		// a rename wearing an addition's clothes.
		assertEquals((error as ToolError).code, 'navigation-blocked');
	} finally {
		await registry.shutdown();
	}
});

// ---------------------------------------------------------------------------
// browser_get_html {frame_id}: every refusal, and what none of them may carry
// ---------------------------------------------------------------------------

/**
 * **I-FH-1, C-7, and the T-1…T-6 taxonomy, as one table.**
 *
 * The handler's shape is `resolve -> authorize -> extract` and the extraction is its last statement,
 * so no refusal on the frame path can carry a byte of the top document. That is a property of an
 * ordering, and an ordering is exactly the kind of thing a later edit reorders without noticing —
 * so every row here drives a real refusal against a session whose **top** document carries a unique
 * sentinel and asserts three things: the code, that the sentinel appears in no content block and no
 * `structuredContent`, and that **no receiver-less `Runtime.evaluate` was ever sent**. The third is
 * the structural half: a named child frame is only ever read through `Runtime.callFunctionOn`, so a
 * `Runtime.evaluate` on this path *is* a read of the top document, whatever came back.
 *
 * Seven conditions onto three existing `ToolErrorCode`s. No new code and no new `reason` member: each
 * condition is an already-named class and `TOOL_ERROR_CODES` is wire-stable — SEC-FH-24's unmeasurable
 * answer included, which is the same "the frame did not answer with a document" class T-5 already is.
 */
interface RefusalRow {
	/** The control and the taxonomy row this proves, carried into the assertion messages. */
	readonly id: string;
	readonly name: string;
	readonly capture: string;
	readonly script?: FrameCdpScript;
	/** The `frame_id` the caller sends; `(h) => h.childFrameId` for the capture's real child. */
	readonly frameId: (h: FrameCdpHarness) => string;
	/** Scopes the principal holds. Omitted means the default grant, which is the attacker position. */
	readonly scopes?: readonly Scope[];
	readonly code: string;
	/** The exact CDP method list the refusal is allowed to have cost. */
	readonly calls: string[];
}

/** A frame tree whose only child is at `url`, so one row can name one origin. */
function childAt(url: string) {
	return (top: string, child: string) => ({
		frame: { id: top, url: 'https://bank.example.com/account' },
		childFrames: [{ frame: { id: child, url } }],
	});
}

const REFUSALS: readonly RefusalRow[] = [
	{
		id: 'T-1 / C-6',
		name: 'an id this session never held is refused at ZERO CDP cost',
		capture: 'iframe_crossorigin',
		frameId: () => 'F-FABRICATED-BY-THE-CALLER',
		code: 'invalid-arguments',
		// Gate A is the first statement, so a mistyped id never opens a session, never reads a tree
		// and never reaches a renderer. A refusal that costs nothing is also not an enumeration probe.
		calls: [],
	},
	{
		id: 'T-1 / C-4',
		name: 'a frame id minted by ANOTHER session is absent, not refused by a cross-session check',
		capture: 'iframe_crossorigin',
		// A real id — it belongs to the `iframe_same_site_port` capture, i.e. to a different session's
		// vocabulary. There is no code path in which it is looked up at all, which is a stronger
		// property than a check that could be got wrong: `target()` resolves exactly one record and
		// Gate A reads that record's own cached frames.
		frameId: () => '93E5A1E8F2748C2B31E75F7B880B835E',
		code: 'invalid-arguments',
		calls: [],
	},
	{
		id: 'T-2 / C-5',
		name: 'a frame that detached between the capture and the read is refused',
		capture: 'iframe_same_site_port',
		script: { tree: (top) => ({ frame: { id: top, url: 'https://bank.example.com/account' } }) },
		frameId: (h) => h.childFrameId,
		code: 'invalid-arguments',
		calls: ['Page.getFrameTree'],
	},
	{
		id: 'T-2 / C-17',
		name: 'a NAMED TOP frame id the live tree no longer holds is refused, not silently answered',
		capture: 'iframe_same_site_port',
		// The id was carried across a tab switch, or Chromium replaced the main frame: the tree's root
		// is a different document from the one the caller named. Answering with it would be "you asked
		// for document X and were given document Y, with no error" — the case the plain widening of
		// `isTop` would have opened, and the reason the short-circuit is keyed on `named` instead.
		script: {
			tree: () => ({ frame: { id: 'F-TOP-AFTER-A-MAIN-FRAME-SWAP', url: 'https://bank.example.com/account' } }),
		},
		frameId: (h) => h.topFrameId,
		code: 'invalid-arguments',
		calls: ['Page.getFrameTree'],
	},
	{
		id: 'T-3 / C-1 / I-FH-2',
		name: 'a CROSS-ORIGIN SAME-PROCESS frame is refused on the default grant — origin decides, not process-ness',
		capture: 'iframe_same_site_port',
		// The counter-example the corpus already owns: one host, two ports, one renderer. An
		// implementation that gated on `isOopif` would hand this document to an unscoped principal.
		script: {
			tree: (top, child) => ({
				frame: { id: top, url: 'http://127.0.0.1:38111/iframe_same_site_port.html' },
				childFrames: [{ frame: { id: child, url: 'http://127.0.0.1:38112/frames/frame_depth2.html' } }],
			}),
		},
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		id: 'T-3',
		name: 'a frame on another host is refused on the default grant',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('https://not-the-bank.example/collect') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		id: 'T-3 / C-3',
		name: 'an about:blank frame fails CLOSED',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('about:blank') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		id: 'T-3 / C-3',
		name: 'an about:srcdoc frame fails CLOSED, stricter than the web platform and deliberately so',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('about:srcdoc') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		id: 'T-3 / C-3',
		name: 'a frame whose URL the browser reported as empty fails CLOSED',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		id: 'T-4',
		name: 'a frame whose owner element cannot be read is browser-unavailable, naming the frame',
		capture: 'iframe_same_site_port',
		// Same-origin, so the gate permits and the failure is genuinely the renderer's.
		script: { tree: childAt('https://bank.example.com/account/widget'), owner: 'throw' },
		frameId: (h) => h.childFrameId,
		code: 'browser-unavailable',
		// No `Runtime.releaseObjectGroup`, and that is correct rather than an omission: the failure is
		// before `DOM.resolveNode`, so nothing has been allocated into the group yet and a release
		// would be a call with nothing to free. The release-on-throw case lives on the path that
		// actually allocates (`page_eval_test.ts`, I-FH-7).
		calls: ['Page.getFrameTree', 'DOM.enable', 'DOM.getFrameOwner'],
	},
	{
		id: 'T-5',
		name: 'a frame that answers with no document is browser-unavailable, not an empty success',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('https://bank.example.com/account/widget'), noDocument: true },
		frameId: (h) => h.childFrameId,
		code: 'browser-unavailable',
		// One `Runtime.callFunctionOn`, not two: since REV-1 the HTML extraction runs on the document
		// handle `DOM.resolveNode` returned, so the `defaultView` hop the receiver used to take — the
		// one a page can redefine — is not on this path at all. The cost moved down, never up.
		calls: [
			'Page.getFrameTree',
			'DOM.enable',
			'DOM.getFrameOwner',
			'DOM.describeNode',
			'DOM.resolveNode',
			'Runtime.callFunctionOn',
			'Runtime.releaseObjectGroup',
		],
	},
	{
		id: 'T-6 / SEC-FH-24',
		name:
			'a frame that reports an unmeasurable length is browser-unavailable, and the bytes it DID answer with are dropped',
		capture: 'iframe_same_site_port',
		script: {
			tree: childAt('https://bank.example.com/account/widget'),
			// SEC-FH-24's hostile `outerHTML` getter, in the one shape no server-side measurement can
			// repair: `length` is `Infinity`, so there is no honest count to floor it against and no
			// integer to put on the wire. `typeof length === 'number'` is true of it, which is why the
			// check is the *shape* of a character count and not merely its type.
			//
			// The getter's `slice` still hands back real, over-limit markup, so this row is also the
			// only one in the table whose refusal is raised **after** the extraction has answered — and
			// the C-7 assertions below therefore prove something the other rows cannot: that bytes
			// already sitting in this process reach neither half of the envelope.
			childHtml: {
				length: Number.POSITIVE_INFINITY,
				slice: () => `<html><body>${'x'.repeat(HTML_LIMIT)}</body></html>`,
			},
		},
		frameId: (h) => h.childFrameId,
		code: 'browser-unavailable',
		// Identical to T-5's: the answer is rejected where it is read, so it costs the extraction and
		// its release and not one round trip more.
		calls: [
			'Page.getFrameTree',
			'DOM.enable',
			'DOM.getFrameOwner',
			'DOM.describeNode',
			'DOM.resolveNode',
			'Runtime.callFunctionOn',
			'Runtime.releaseObjectGroup',
		],
	},
];

for (const row of REFUSALS) {
	Deno.test(`browser_get_html ${row.id}: ${row.name}`, async () => {
		const h = await frameCdpHarness(row.capture, row.script ?? {});
		try {
			const ctx: ToolContext = row.scopes === undefined ? h.ctx : { ...h.ctx, scopes: new Set(row.scopes) };
			const error = await assertRejects(
				() => browserGetHtml({ frame_id: row.frameId(h) }, ctx),
				ToolError,
			);
			assertEquals(error.code, row.code, `${row.id}: ${error.message}`);
			assertEquals(h.methods(), row.calls, `${row.id} spent CDP calls it should not have`);

			// C-7, on every row: the refusal as the client actually receives it.
			const result = errorResult(error);
			assertEquals(result.isError, true);
			const rendered = JSON.stringify(result);
			assert(!rendered.includes(TOP_DOC_SENTINEL), `${row.id} returned top-document bytes`);
			assert(!rendered.includes('<html'), `${row.id} returned document markup`);
			// The structural half: a named child frame is never read through `Runtime.evaluate`, so one
			// on this path is a read of the top document whatever it returned.
			assertEquals(
				h.methods().filter((method) => method === 'Runtime.evaluate'),
				[],
				`${row.id} issued a receiver-less Runtime.evaluate, which reads the HOST document`,
			);
			// And no row wrote an audit entry: a refusal means nothing privileged happened (C-8).
			assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
		} finally {
			await h.registry.shutdown();
		}
	});
}

/**
 * SEC-17: a refusal is a probe result, so it names the frame and never the scope.
 *
 * The *tool description* names `evaluate`, exactly as `browser_evaluate`'s does — a description is
 * public documentation and an error message is something an unauthenticated-adjacent caller can
 * enumerate. The rule is about the second.
 */
Deno.test('browser_get_html T-3: the cross-origin denial never names the scope (SEC-17)', async () => {
	const h = await frameCdpHarness('iframe_same_site_port', {
		tree: childAt('https://not-the-bank.example/collect'),
	});
	try {
		const error = await assertRejects(
			() => browserGetHtml({ frame_id: h.childFrameId }, h.ctx),
			ToolError,
		);
		assertEquals(error.code, 'scope-required');
		assertStringIncludes(error.message, h.childFrameId);
		const rendered = JSON.stringify(errorResult(error)).toLowerCase();
		assert(!rendered.includes('evaluate'), `the denial named the scope: ${rendered}`);
		assert(!rendered.includes('scope-required'.replace('-required', '') + ' '), rendered);
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * The other half of C-1, without which the refusal row proves only that the tool is broken: the
 * same frame, the same origin comparison, and a principal that holds `evaluate` reads it.
 */
Deno.test('browser_get_html C-1: the SAME cross-origin same-process frame is readable WITH evaluate', async () => {
	const script = {
		tree: (top: string, child: string) => ({
			frame: { id: top, url: 'http://127.0.0.1:38111/iframe_same_site_port.html' },
			childFrames: [{ frame: { id: child, url: 'http://127.0.0.1:38112/frames/frame_depth2.html' } }],
		}),
	};
	const h = await frameCdpHarness('iframe_same_site_port', script);
	try {
		const ctx: ToolContext = { ...h.ctx, scopes: new Set(['mcp:invoke', 'evaluate'] as const) };
		const result = await browserGetHtml({ frame_id: h.childFrameId }, ctx) as {
			content: Array<{ text: string }>;
			structuredContent: { frame_id: string; url: string; audit_id?: string };
		};
		assertEquals(result.structuredContent.frame_id, h.childFrameId);
		assertEquals(result.structuredContent.url, 'http://127.0.0.1:38112/frames/frame_depth2.html');
		assertEquals(result.content[0]?.text, CHILD_DOCUMENT);
		// The grant was spent, so it is on the record and correlatable from the result.
		const entries = h.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.kind, 'read-frame-html');
		assertEquals(result.structuredContent.audit_id, entries[0]?.audit_id);
		// Still not the top document, even on the permitted path.
		assert(!JSON.stringify(result).includes(TOP_DOC_SENTINEL));
	} finally {
		await h.registry.shutdown();
	}
});

// --- SEC-FH-17: the origin is re-checked against the document that ANSWERED --------------------

/**
 * The race, as a wire rather than as an argument.
 *
 * Gate B reads the frame's origin from `Page.getFrameTree`; the bytes arrive five CDP round trips
 * later. Until this fix the verdict was never revisited, so a frame that committed a cross-origin
 * document inside that window answered with **another origin's markup under a verdict computed from
 * the URL it used to have** — reachable on the default grant, and with no ledger row, because
 * `cross` was false when it was computed.
 *
 * The rows below drive that window open in the fake browser: the frame really navigates between the
 * two round trips, and the tree, the bytes and the reported origin all move together because they
 * are one piece of state (`frameCdpHarness.navigate`). Nothing anywhere says "report a different
 * origin"; a row that could say that would be describing the fix instead of exercising it.
 */
const NAVIGATED_SENTINEL = 'DOCUMENT-COMMITTED-AFTER-THE-CHECK-9XQ2';
const NAVIGATED_DOCUMENT = `<html><body><input name="csrf" value="${NAVIGATED_SENTINEL}"></body></html>`;
const NAVIGATED_URL = 'https://not-the-bank.example/collect';

/** Same-origin with the top document at the moment Gate B looks — which is the whole premise. */
const SAME_ORIGIN_AT_CHECK: FrameCdpScript = {
	tree: (top: string, child: string) => ({
		frame: { id: top, url: 'https://bank.example.com/account' },
		childFrames: [{ frame: { id: child, url: 'https://bank.example.com/account/widget' } }],
	}),
};

/**
 * The full cost of a read that reached the extraction: this refusal is late, not early.
 *
 * Seven calls since REV-1 rather than eight. The extraction is addressed to the document handle
 * `DOM.resolveNode` produced, so the `document -> window` hop is gone from this path — and with it
 * the one step where a page chose the object the origin was read out of.
 */
const EXTRACTION_SPENT = [
	'Page.getFrameTree',
	'DOM.enable',
	'DOM.getFrameOwner',
	'DOM.describeNode',
	'DOM.resolveNode',
	'Runtime.callFunctionOn',
	'Runtime.releaseObjectGroup',
];

Deno.test('SEC-FH-17: a frame that navigates cross-origin BETWEEN the check and the read is refused, with no bytes', async () => {
	// The control first. Without the navigation this exact call succeeds on the default grant,
	// because the frame genuinely is same-origin when Gate B looks at it. Without this half the row
	// below could pass because the read was refused for some unrelated reason.
	const control = await frameCdpHarness('iframe_same_site_port', SAME_ORIGIN_AT_CHECK);
	try {
		const ok = await browserGetHtml({ frame_id: control.childFrameId }, control.ctx) as {
			content: Array<{ text: string }>;
			structuredContent: { url: string; audit_id?: string };
		};
		assertEquals(ok.content[0]?.text, CHILD_DOCUMENT);
		assertEquals(ok.structuredContent.url, 'https://bank.example.com/account/widget');
		assertEquals('audit_id' in ok.structuredContent, false, 'a same-origin read writes no row');
	} finally {
		await control.registry.shutdown();
	}

	const h = await frameCdpHarness('iframe_same_site_port', SAME_ORIGIN_AT_CHECK);
	// The instant the frame tree has answered — Gate B has its URL, the extraction has not been sent
	// — the frame commits a cross-origin document. This is the window the finding measured.
	h.afterCall('Page.getFrameTree', () => h.navigate(h.childFrameId, NAVIGATED_URL, NAVIGATED_DOCUMENT));
	try {
		const error = await assertRejects(() => browserGetHtml({ frame_id: h.childFrameId }, h.ctx), ToolError);
		assertEquals(error.code, 'scope-required');
		// Gate B PERMITTED — it saw the pre-navigation URL — so the extraction really was sent and
		// really did come back holding another origin's document. Had Gate B refused instead, this
		// list would read `['Page.getFrameTree']` and the row would prove nothing about the window
		// after it. This assertion is what makes the test about the SECOND gate.
		assertEquals(h.methods(), EXTRACTION_SPENT);
		// I-FH-1 / C-7 on the new path, over both halves of the envelope in one string: `errorResult`
		// renders `content[]` and `structuredContent` together, so a check written over only the
		// structured half could not produce these lines.
		const rendered = JSON.stringify(errorResult(error));
		assertEquals(rendered.includes(NAVIGATED_SENTINEL), false, 'the cross-origin document reached the caller');
		assertEquals(rendered.includes('<html'), false, 'document markup reached the caller');
		assertEquals(rendered.includes(TOP_DOC_SENTINEL), false);
		// SEC-17 holds on this refusal exactly as on every other: the frame is named, the scope is not.
		assertStringIncludes(error.message, h.childFrameId);
		assertEquals(rendered.toLowerCase().includes('evaluate'), false, rendered);
		// The audit decision, asserted rather than described: a Gate B-prime refusal writes no row,
		// like every other refusal, because nothing privileged reached the principal.
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * The same race against the OTHER extraction shape.
 *
 * An out-of-process frame is its own target whose default context already is its document, so it is
 * read with a receiver-less `Runtime.evaluate` and the origin comes back from `HTML_EXPRESSION`
 * rather than from `HTML_FUNCTION`. Two constants carry the re-check input; a row that exercised
 * only one of them would leave the other free to drift.
 */
Deno.test('SEC-FH-17: the re-check covers the receiver-less read too — an OOPIF that navigates is refused', async () => {
	const h = await frameCdpHarness('iframe_crossorigin', SAME_ORIGIN_AT_CHECK);
	// This path reads the tree twice — once on the page session for the top URL, once on the frame's
	// own target for its URL — so the window opens after the SECOND read, not the first. Navigating
	// after the first would be caught by Gate B and would prove nothing about the window after it.
	h.afterCall('Page.getFrameTree', (nth) => {
		if (nth === 2) h.navigate(h.childFrameId, NAVIGATED_URL, NAVIGATED_DOCUMENT);
	});
	try {
		const error = await assertRejects(() => browserGetHtml({ frame_id: h.childFrameId }, h.ctx), ToolError);
		assertEquals(error.code, 'scope-required');
		assertEquals(h.methods(), ['Page.getFrameTree', 'Page.getFrameTree', 'Runtime.evaluate']);
		const rendered = JSON.stringify(errorResult(error));
		assertEquals(rendered.includes(NAVIGATED_SENTINEL), false, 'the cross-origin document reached the caller');
		assertEquals(rendered.includes('<html'), false);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

/**
 * The permitted half, and the ledger repair that comes with it.
 *
 * Before this fix the same call wrote **no row at all** — `cross` was false, so the cross-origin
 * branch never ran — which is the "silent ledger" half of SEC-FH-17. Now the row exists, and its
 * `origin` is the document that answered rather than the URL the tree reported before the frame
 * moved, so the ledger names the document whose bytes were actually handed over.
 */
Deno.test('SEC-FH-17: with the scope the read is permitted, and the ledger names the document that ANSWERED', async () => {
	const h = await frameCdpHarness('iframe_same_site_port', SAME_ORIGIN_AT_CHECK);
	h.afterCall('Page.getFrameTree', () => h.navigate(h.childFrameId, NAVIGATED_URL, NAVIGATED_DOCUMENT));
	const ctx: ToolContext = { ...h.ctx, scopes: new Set(['mcp:invoke', 'evaluate'] as const) };
	try {
		const result = await browserGetHtml({ frame_id: h.childFrameId }, ctx) as {
			content: Array<{ text: string }>;
			structuredContent: { audit_id?: string };
		};
		assertEquals(result.content[0]?.text, NAVIGATED_DOCUMENT);
		const entries = h.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.kind, 'read-frame-html');
		assertEquals(entries[0]?.frame_id, h.childFrameId);
		// Not `https://bank.example.com`, which is what the pre-read URL would have recorded.
		assertEquals(entries[0]?.origin, 'https://not-the-bank.example');
		assertEquals(entries[0]?.ok, true);
		assertEquals(result.structuredContent.audit_id, entries[0]?.audit_id);
		// Still never a document byte, prefix or digest (I-FH-5).
		assertEquals(JSON.stringify(entries).includes(NAVIGATED_SENTINEL), false);
	} finally {
		await h.registry.shutdown();
	}
});
