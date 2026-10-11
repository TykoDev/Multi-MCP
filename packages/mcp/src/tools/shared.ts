/**
 * The plumbing every handler module shares: session resolution, event dispatch, the one index
 * resolver, and the live page-identity read.
 *
 * Internal to `tools/` — nothing here is exported from `packages/mcp/mod.ts`. A helper that lands
 * here is one that at least two handler modules need; a helper used by one module lives in that
 * module.
 */
import type { BrowserSession, EnhancedDomTreeNode } from '@tykotech/browser';
import type { TargetId } from '@tykotech/cdp';
import { ToolError } from '../errors.ts';
import { DEFAULT_SESSION_ID, type SessionRecord } from '../registry.ts';
import type { ToolContext } from '../types.ts';

export interface SessionArgs {
	session_id?: string | undefined;
}

/**
 * What a caller may do despite a held dialog (B3.2).
 *
 * One value, and one caller: `browser_handle_dialog`, which *is* the remedy and would otherwise
 * refuse itself. The session-closing tools need no exemption because they never reach this function —
 * they go straight to the registry, deliberately, so that giving up on a wedged page works while a
 * human holds the lock too.
 */
export type DialogExemption = 'answer';

/**
 * Resolves the target session, refuses mutation while a human holds it, and refuses mutation while a
 * JavaScript dialog is holding the page (B3.2, §8 `dialog-open`).
 *
 * **The dialog check is here rather than in each handler** for the same reason `assertUnlocked` is:
 * every mutating tool passes through this function, so a tool added later is covered by construction
 * rather than by its author remembering. It fires only while manual dialog handling is armed — with
 * no `dialog` subscriber the watchdog answers every dialog by its own policy and nothing is ever held
 * (E-53), so a deployment that never subscribes pays nothing and sees no behaviour change.
 *
 * What it replaces is a hang. A held dialog blocks the CDP channel for its target, so a
 * `browser_click` during the hold used to sit until the 20 s expiry and then surface as a `timeout`
 * that named nothing the caller could act on. Now it is immediate and carries the `dialog_id`.
 */
export async function target(
	ctx: ToolContext,
	args: SessionArgs,
	mutates: boolean,
	exemption?: DialogExemption,
): Promise<SessionRecord> {
	// R8 (D-128): the caller's access rides every lookup; `shared` mode ignores it.
	const record = await ctx.registry.resolve(args.session_id, ctx.access);
	if (mutates) {
		ctx.registry.assertUnlocked(record);
		if (exemption === undefined) assertNoHeldDialog(record);
	}
	return record;
}

/**
 * Refuses when a dialog is being held open for a caller to answer.
 *
 * The oldest held dialog is the one named: dialogs are answered in the order they were raised, and
 * naming the newest would send the caller to answer one that is not at the front of the queue.
 */
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

/** A10: the shared abort race, re-exported for the handler modules. */
export { untilAborted } from '../cancel.ts';

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

/**
 * The one index resolver in the product (G-1, invariant I-1).
 *
 * Three outcomes, deliberately not two. The caller's `state_token` names the table it read the index
 * from; the server holds at most one table of its own. Before B1.4 every miss was `unknown-index`,
 * which told a client nothing about whether to retry the index or re-read the page.
 *
 * - **no table at all** — `element-not-found`, `reason: 'no-state'`, `state_token: null`. Nothing is
 *   resolvable until a `browser_get_state` succeeds.
 * - **a different table** — `element-not-found`, `reason: 'stale-token'`, carrying the token the
 *   server actually holds. The page moved; the index may be fine against the new table.
 * - **this table, no such index** — `unknown-index`, unchanged wording and unchanged meaning, so a
 *   client that already matches on it keeps working.
 */
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

export function tabTargets(session: BrowserSession): Set<string> {
	return new Set(session.tabs.map((tab) => String(tab.tabId)));
}

export function assertTab(session: BrowserSession, tabId: string): TargetId {
	if (!tabTargets(session).has(tabId)) {
		throw new ToolError('unknown-tab', `no tab with id ${tabId}`);
	}
	// The short form is what the model was given; the session resolves either
	// spelling, so it is passed through unchanged (`@tykotech/browser`
	// `findTargetIdsByTabId`).
	return tabId as TargetId;
}

/**
 * Reads the page identity a navigation actually produced.
 *
 * ERRATUM(E-13). These handlers used to answer from
 * `session.cachedBrowserState`, which is only ever written by
 * `getBrowserStateSummary`. On the first navigation of a session that cache is
 * null, so the tool reported `title: ''`; on every later one it still held the
 * *previous* page, so the tool confidently reported the URL and title the
 * browser had just left. A DOM-less state request is the cheap live read: it
 * skips the DOM build and the network-stability wait, and answers from
 * `location.href` and the live title.
 */
export async function identify(record: SessionRecord, fallbackUrl: string): Promise<{ url: string; title: string }> {
	try {
		const state = await record.session.getBrowserStateSummary({ includeDom: false });
		return { url: state.url === '' ? fallbackUrl : state.url, title: state.title };
	} catch {
		// Never fail a completed navigation because the follow-up read did.
		return { url: fallbackUrl, title: '' };
	}
}

/**
 * Resolves a session **without creating one**.
 *
 * The file tools are reads over what a browser already did. `resolve` would mint the default session
 * on a stale or mistyped id and hand the caller a blank browser with no files in it, which is a worse
 * answer than "no such session".
 */
export function peekSession(ctx: ToolContext, sessionId: string | undefined): SessionRecord {
	const id = sessionId ?? DEFAULT_SESSION_ID;
	// R8 (D-128): in `owner` mode another owner's session is not found, and `default` is the caller's own.
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
