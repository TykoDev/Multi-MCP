/**
 * The plumbing every handler module shares: session resolution, event dispatch, the one index resolver, and the live
 * page-identity read.
 */
import type { BrowserSession, EnhancedDomTreeNode } from '@tykotech/browser';
import type { TargetId } from '@tykotech/cdp';
import { ToolError } from '../errors.ts';
import { DEFAULT_SESSION_ID, type SessionRecord } from '../registry.ts';
import type { ToolContext } from '../types.ts';

interface SessionArgs {
	session_id?: string | undefined;
}

/** What a caller may do despite a held dialog. */
type DialogExemption = 'answer';

/**
 * Resolves the target session, refuses mutation while a human holds it, and refuses mutation while a JavaScript
 * dialog is holding the page (`dialog-open`).
 */
export async function target(
	ctx: ToolContext,
	args: SessionArgs,
	mutates: boolean,
	exemption?: DialogExemption,
): Promise<SessionRecord> {
	// The caller's access rides every lookup; `shared` mode ignores it.
	const record = await ctx.registry.resolve(args.session_id, ctx.access);
	if (mutates) {
		ctx.registry.assertUnlocked(record);
		if (exemption === undefined) assertNoHeldDialog(record);
	}
	return record;
}

/** Refuses when a dialog is being held open for a caller to answer. */
export function assertNoHeldDialog(record: SessionRecord): void {
	const pending = record.popups?.pendingDialogs ?? [];
	const held = pending[0];
	if (held === undefined) return;
	throw new ToolError(
		'dialog-open',
		`a ${held.dialogType} dialog is open and holding the page; answer it with browser_handle_dialog ` +
			`(dialog_id ${held.dialogId}) or wait for its hold to expire`,
		// The message is deliberately absent: it is page-controlled text, and the
		// `dialog` event kind already carries it under the per-kind caps.
		{ dialog_id: held.dialogId, dialog_kind: held.dialogType },
	);
}

/** The shared abort race, re-exported for the handler modules. */
export { untilAborted } from '../errors.ts';

/** Dispatches a core event and surfaces handler failures as tool errors. */
export async function dispatch<T>(
	session: BrowserSession,
	event: object,
	opts?: { raiseIfNone?: boolean },
): Promise<T> {
	try {
		return await (session.eventBus.dispatch(event as never) as {
			eventResult(o: { raiseIfAny: boolean; raiseIfNone?: boolean }): Promise<T>;
		}).eventResult({ raiseIfAny: true, ...(opts?.raiseIfNone === true ? { raiseIfNone: true } : {}) });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		if (/timeout|timed out/i.test(message)) throw new ToolError('timeout', message);
		if (/crash/i.test(message)) throw new ToolError('browser-crashed', message);
		throw new ToolError('browser-unavailable', message);
	}
}

/** The one index resolver in the product. */
export function nodeAt(session: BrowserSession, index: number, expectedToken?: string): EnhancedDomTreeNode {
	const state = session.cachedBrowserState;
	const held = state?.stateToken ?? null;
	if (state === null || state === undefined || state.domState.selectorMap.size === 0) {
		throw new ToolError(
			'element-not-found',
			`no element table is held for this session; call browser_get_state before acting on index ${index}`,
			{ index, state_token: null, reason: 'no-state' },
		);
	}
	if (expectedToken !== undefined && expectedToken !== held) {
		throw new ToolError(
			'element-not-found',
			`index ${index} was read from a different page state; call browser_get_state and retry`,
			{ index, state_token: held, reason: 'stale-token' },
		);
	}
	const node = state.domState.selectorMap.get(index);
	if (node === undefined) {
		throw new ToolError(
			'unknown-index',
			`no interactive element with index ${index}; call browser_get_state for current indices`,
			{ index },
		);
	}
	return node;
}

/** The token of the table a result was computed against, or `null` when none is held. */
export function heldToken(record: SessionRecord): string | null {
	return record.session.cachedBrowserState?.stateToken ?? null;
}

function tabTargets(session: BrowserSession): Set<string> {
	return new Set(session.tabs.map((tab) => String(tab.tabId)));
}

export function assertTab(session: BrowserSession, tabId: string): TargetId {
	if (!tabTargets(session).has(tabId)) {
		throw new ToolError('unknown-tab', `no tab with id ${tabId}`);
	}
	// The short form is what the model was given; the session resolves either spelling, so it is passed through
	// unchanged (`@tykotech/browser` `findTargetIdsByTabId`).
	return tabId as TargetId;
}

/** Reads the page identity a navigation actually produced. */
export async function identify(record: SessionRecord, fallbackUrl: string): Promise<{ url: string; title: string }> {
	try {
		const state = await record.session.getBrowserStateSummary({ includeDom: false });
		return { url: state.url === '' ? fallbackUrl : state.url, title: state.title };
	} catch {
		// Never fail a completed navigation because the follow-up read did.
		return { url: fallbackUrl, title: '' };
	}
}

/** Resolves a session **without creating one**. */
export function peekSession(ctx: ToolContext, sessionId: string | undefined): SessionRecord {
	const id = sessionId ?? DEFAULT_SESSION_ID;
	// In `owner` mode another owner's session is not found, and `default` is the caller's own.
	const record = ctx.registry.peekFor(sessionId, ctx.access);
	if (record === undefined) {
		// A read-only tool never launches a browser, so "the default session, created on first use" (the parameter's own
		// description) is not created here: say so, or a caller reads `no session with id default` as a broken server.
		throw new ToolError(
			'unknown-session',
			sessionId === undefined
				? 'you have no default session yet: it is created by the first tool that opens a page (browser_navigate); ' +
					'this tool only reads a session and never creates one'
				: `no session with id ${id}`,
		);
	}
	// The record's own id: in `owner` mode `default` names `default-<ulid>`, which is what has to be kept alive.
	ctx.registry.touch(record.id);
	return record;
}
