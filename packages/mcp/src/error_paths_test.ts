/**
 * `dialog-open` and `download-failed`, each driven through the path that actually raises it, and the
 * `browser_get_html {frame_id}` refusals.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { ToolError } from './errors.ts';
import { downloadFailureReason } from './events.ts';
import { DEFAULT_SESSION_ID, type LaunchedSession, SessionRegistry } from './registry.ts';
import { assertNoHeldDialog, target } from './tools/shared.ts';
import { browserDownload } from './tools/files.ts';
import { browserGetHtml, HTML_LIMIT } from './tools/perception.ts';
import { errorResult } from './dispatch.ts';
import type { Scope } from './scopes.ts';
import {
	blankSession,
	CHILD_DOCUMENT,
	type FrameCdpHarness,
	frameCdpHarness,
	type FrameCdpScript,
	TOP_DOC_SENTINEL,
} from '../fixtures/capture_session.ts';
import type { ToolContext } from './types.ts';

function ctxFor(registry: SessionRegistry): ToolContext {
	return { registry, allowedDomains: [], principal: 'test' };
}

// --------------------------------------------------------------------------- dialog-open
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
				session: blankSession(),
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
		assertEquals((error as ToolError).extras.dialog_id, 'D1');
		assertEquals((error as ToolError).extras.dialog_kind, 'confirm');
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
		const record = await target(ctxFor(registry), {}, false);
		assertEquals(record.id, DEFAULT_SESSION_ID);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('dialog-open: the exemption lets browser_handle_dialog through its own refusal', async () => {
	const { registry } = await registryHoldingDialogs([{ dialogId: 'D1', dialogType: 'prompt' }]);
	try {
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
		const error = assertThrowsToolError(() => assertNoHeldDialog(record));
		assertEquals(error.extras.dialog_id, 'FIRST');
	} finally {
		await registry.shutdown();
	}
});

Deno.test('dialog-open: a session with no dialog watchdog is never refused', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(blankSession()) });
	try {
		const record = await registry.resolve(DEFAULT_SESSION_ID);
		assertEquals(record.popups, null);
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

// --------------------------------------------------------------------------- download-failed
// ---------------------------------------------------------------------------

/** A registry whose navigation makes the ledger produce one record in the state the test names. */
async function registryWhereDownloadEndsAs(state: 'canceled' | 'completed' | 'in_progress', error?: string) {
	const downloads: Array<Record<string, unknown>> = [];
	const session = blankSession();
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () =>
			Promise.resolve({
				session,
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
	session.eventBus.on(
		// deno-lint-ignore no-explicit-any -- matched by constructor name, like the real bus does.
		(await import('@tykotech/browser')).NavigateToUrlEvent as any,
		() => {
			downloads.push({
				guid: 'G1',
				url: 'https://files.test/x.bin',
				suggestedFilename: 'x.bin',
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
		assertEquals((error as ToolError).extras.reason, 'over-session-limit');
		assertEquals(downloadFailureReason('the session already tracks 20 downloads'), 'over-session-limit');
		assert(
			!JSON.stringify((error as ToolError).structuredPayload).includes('already tracks'),
			`the ledger's free text reached the wire: ${JSON.stringify((error as ToolError).structuredPayload)}`,
		);
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
		assertEquals(payload.started, true);
		assertEquals((payload.file as { status: string }).status, 'pending');
	} finally {
		await registry.shutdown();
	}
});

Deno.test('download-failed: an off-allowlist URL answers navigation-blocked, not download-failed', async () => {
	const { registry } = await registryWhereDownloadEndsAs('completed');
	try {
		const ctx: ToolContext = { registry, allowedDomains: ['example.com'], principal: 'test' };
		const error = await assertRejects(
			() => browserDownload({ url: 'https://files.test/x.bin' }, ctx),
			ToolError,
		);
		assertEquals((error as ToolError).code, 'navigation-blocked');
	} finally {
		await registry.shutdown();
	}
});

// ---------------------------------------------------------------------------
// browser_get_html {frame_id}: every refusal, and what none of them may carry
// ---------------------------------------------------------------------------

/** **Every frame-path refusal, as one table.** */
interface RefusalRow {
	/** What the row proves, carried into the test name and the assertion messages. */
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
		name: 'an id this session never held is refused at ZERO CDP cost',
		capture: 'iframe_crossorigin',
		frameId: () => 'F-FABRICATED-BY-THE-CALLER',
		code: 'invalid-arguments',
		calls: [],
	},
	{
		name: 'a frame id minted by ANOTHER session is absent, not refused by a cross-session check',
		capture: 'iframe_crossorigin',
		frameId: () => '93E5A1E8F2748C2B31E75F7B880B835E',
		code: 'invalid-arguments',
		calls: [],
	},
	{
		name: 'a frame that detached between the capture and the read is refused',
		capture: 'iframe_same_site_port',
		script: { tree: (top) => ({ frame: { id: top, url: 'https://bank.example.com/account' } }) },
		frameId: (h) => h.childFrameId,
		code: 'invalid-arguments',
		calls: ['Page.getFrameTree'],
	},
	{
		name: 'a NAMED TOP frame id absent from the live tree is refused, not silently answered',
		capture: 'iframe_same_site_port',
		script: {
			tree: () => ({ frame: { id: 'F-TOP-AFTER-A-MAIN-FRAME-SWAP', url: 'https://bank.example.com/account' } }),
		},
		frameId: (h) => h.topFrameId,
		code: 'invalid-arguments',
		calls: ['Page.getFrameTree'],
	},
	{
		name: 'a CROSS-ORIGIN SAME-PROCESS frame is refused on the default grant — origin decides, not process-ness',
		capture: 'iframe_same_site_port',
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
		name: 'a frame on another host is refused on the default grant',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('https://not-the-bank.example/collect') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		name: 'an about:blank frame fails CLOSED',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('about:blank') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		name: 'an about:srcdoc frame fails CLOSED, stricter than the web platform and deliberately so',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('about:srcdoc') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		name: 'a frame whose URL the browser reported as empty fails CLOSED',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('') },
		frameId: (h) => h.childFrameId,
		code: 'scope-required',
		calls: ['Page.getFrameTree'],
	},
	{
		name: 'a frame whose owner element cannot be read is browser-unavailable, naming the frame',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('https://bank.example.com/account/widget'), owner: 'throw' },
		frameId: (h) => h.childFrameId,
		code: 'browser-unavailable',
		calls: ['Page.getFrameTree', 'DOM.enable', 'DOM.getFrameOwner'],
	},
	{
		name: 'a frame that answers with no document is browser-unavailable, not an empty success',
		capture: 'iframe_same_site_port',
		script: { tree: childAt('https://bank.example.com/account/widget'), noDocument: true },
		frameId: (h) => h.childFrameId,
		code: 'browser-unavailable',
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
		name:
			'a frame that reports an unmeasurable length is browser-unavailable, and the bytes it DID answer with are dropped',
		capture: 'iframe_same_site_port',
		script: {
			tree: childAt('https://bank.example.com/account/widget'),
			childHtml: {
				length: Number.POSITIVE_INFINITY,
				slice: () => `<html><body>${'x'.repeat(HTML_LIMIT)}</body></html>`,
			},
		},
		frameId: (h) => h.childFrameId,
		code: 'browser-unavailable',
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
	Deno.test(`browser_get_html: ${row.name}`, async () => {
		const h = await frameCdpHarness(row.capture, row.script ?? {});
		try {
			const ctx: ToolContext = row.scopes === undefined ? h.ctx : { ...h.ctx, scopes: new Set(row.scopes) };
			const error = await assertRejects(
				() => browserGetHtml({ frame_id: row.frameId(h) }, ctx),
				ToolError,
			);
			assertEquals(error.code, row.code, `${row.name}: ${error.message}`);
			assertEquals(h.methods(), row.calls, `${row.name}: spent CDP calls it should not have`);

			const result = errorResult(error);
			assertEquals(result.isError, true);
			const rendered = JSON.stringify(result);
			assert(!rendered.includes(TOP_DOC_SENTINEL), `${row.name}: returned top-document bytes`);
			assert(!rendered.includes('<html'), `${row.name}: returned document markup`);
			assertEquals(
				h.methods().filter((method) => method === 'Runtime.evaluate'),
				[],
				`${row.name}: issued a receiver-less Runtime.evaluate, which reads the HOST document`,
			);
			assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
		} finally {
			await h.registry.shutdown();
		}
	});
}

/** A refusal is a probe result, so it names the frame and never the scope. */
Deno.test('browser_get_html: the cross-origin denial never names the scope', async () => {
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
 * The other half of the cross-origin same-process row, without which it proves only that the tool is broken: the
 * same frame, the same origin comparison, and a principal that holds `evaluate` reads it.
 */
Deno.test('browser_get_html: the SAME cross-origin same-process frame is readable WITH evaluate', async () => {
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
		const entries = h.record.audit.read({ principal: 'test', all: true }).entries;
		assertEquals(entries.length, 1);
		assertEquals(entries[0]?.kind, 'read-frame-html');
		assertEquals(result.structuredContent.audit_id, entries[0]?.audit_id);
		assert(!JSON.stringify(result).includes(TOP_DOC_SENTINEL));
	} finally {
		await h.registry.shutdown();
	}
});

// --- the origin is re-checked against the document that ANSWERED --------------------------------

/** The race, as a wire rather than as an argument. */
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

/** The full cost of a read that reached the extraction: this refusal is late, not early. */
const EXTRACTION_SPENT = [
	'Page.getFrameTree',
	'DOM.enable',
	'DOM.getFrameOwner',
	'DOM.describeNode',
	'DOM.resolveNode',
	'Runtime.callFunctionOn',
	'Runtime.releaseObjectGroup',
];

Deno.test('browser_get_html: a frame that navigates cross-origin BETWEEN the check and the read is refused, with no bytes', async () => {
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
	h.afterCall('Page.getFrameTree', () => h.navigate(h.childFrameId, NAVIGATED_URL, NAVIGATED_DOCUMENT));
	try {
		const error = await assertRejects(() => browserGetHtml({ frame_id: h.childFrameId }, h.ctx), ToolError);
		assertEquals(error.code, 'scope-required');
		assertEquals(h.methods(), EXTRACTION_SPENT);
		const rendered = JSON.stringify(errorResult(error));
		assertEquals(rendered.includes(NAVIGATED_SENTINEL), false, 'the cross-origin document reached the caller');
		assertEquals(rendered.includes('<html'), false, 'document markup reached the caller');
		assertEquals(rendered.includes(TOP_DOC_SENTINEL), false);
		assertStringIncludes(error.message, h.childFrameId);
		assertEquals(rendered.toLowerCase().includes('evaluate'), false, rendered);
		assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.length, 0);
	} finally {
		await h.registry.shutdown();
	}
});

/** The same race against the OTHER extraction shape. */
Deno.test('browser_get_html: the re-check covers the receiver-less read too — an OOPIF that navigates is refused', async () => {
	const h = await frameCdpHarness('iframe_crossorigin', SAME_ORIGIN_AT_CHECK);
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

/** The permitted half, and the ledger row that comes with it. */
Deno.test('browser_get_html: with the scope a navigated frame is read, and the ledger names the document that ANSWERED', async () => {
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
		assertEquals(entries[0]?.origin, 'https://not-the-bank.example');
		assertEquals(entries[0]?.ok, true);
		assertEquals(result.structuredContent.audit_id, entries[0]?.audit_id);
		assertEquals(JSON.stringify(entries).includes(NAVIGATED_SENTINEL), false);
	} finally {
		await h.registry.shutdown();
	}
});
