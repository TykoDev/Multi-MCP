/**
 * `browser_request_human` (R2, design §2.12, D-124): hand a session to a person through the live view.
 *
 * Two rounds on a client that declared URL-mode elicitation, one on every other client:
 *
 * 1. **Round 1** answers `input_required` carrying a URL elicitation for the session's live view, sealed with a
 *    `requestState` of `{k: 'handoff', s: <session>}` under the factory's HMAC codec (D-126). A client that cannot
 *    open URLs for its user gets an ordinary result carrying the URL instead (`outcome: 'link-returned'`).
 * 2. **Round 2** is the client's retry once its user is done. 2026-07-28 has no completion signal for URL mode, so
 *    the retry *is* the signal; the verified state must name this session, and the answer decides the outcome:
 *    accept → `accepted` with a freshly read `state_token`, decline or cancel → `user-declined`.
 *
 * The URL is the control plane's own route, built from the configured public URL — never a request's Host — and it
 * carries no ticket and no credential: the person signs in to the SPA, which mints its own single-use ticket. In
 * `owner` session mode that person must be the session's owner or an admin, or the live view answers
 * unknown-session (documented, design §2.12). The tool never creates a session and never takes the lock: it is
 * read-only, so it answers while a human already holds the session.
 */
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { ToolError } from '../errors.ts';
import { observe } from '../observe.ts';
import type { SessionRecord } from '../registry.ts';
import { say, type ToolContext, type ToolResult } from '../types.ts';
import { heldToken, peekSession } from './shared.ts';

/** The `inputRequests` key the handoff rides under, and the one its answer comes back under. */
export const HANDOFF_KEY = 'ttk_handoff';
/** The `requestState` kind a handoff round is sealed under. */
const HANDOFF_STATE_KIND = 'handoff';

export async function browserRequestHuman(
	args: { session_id?: string; reason: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	ctx.signal?.throwIfAborted();
	// The catalog withholds the tool unless the switch is on; this is the same refusal for a caller that reaches the
	// handler some other way (a direct drive, the task executor), so the URL builder is never assumed.
	const viewUrl = ctx.viewUrl;
	if (viewUrl === undefined) {
		throw new ToolError(
			'feature-unavailable',
			'browser_request_human is off on this deployment; the operator enables it with TTK_HUMAN_HANDOFF=true',
		);
	}
	const record = peekSession(ctx, args.session_id);
	const url = viewUrl(record.id);

	// --- round 2: the person is done ------------------------------------------------------------------------------
	const answer = inputResponse(ctx.mcp?.mcpReq.inputResponses, HANDOFF_KEY);
	if (answer.kind !== 'missing') {
		assertHandoffBound(ctx, record);
		if (answer.kind !== 'elicit') {
			throw new ToolError('invalid-arguments', 'the handoff answer is not an elicitation result');
		}
		if (answer.action !== 'accept') {
			throw new ToolError(
				'user-declined',
				`the person ${answer.action === 'decline' ? 'declined' : 'cancelled'} the handoff for session ${record.id}`,
			);
		}
		return handoffResult(record, url, 'elicitation', 'accepted', await freshToken(record, ctx));
	}

	// --- round 1 ----------------------------------------------------------------------------------------------------
	if (ctx.client?.elicitUrl === true && ctx.mcp !== undefined && ctx.stateCodec !== undefined) {
		return inputRequired({
			inputRequests: { [HANDOFF_KEY]: inputRequired.elicitUrl({ message: args.reason, url }) },
			requestState: await ctx.stateCodec.mint({ k: HANDOFF_STATE_KIND, s: record.id }, ctx.mcp),
		}) as ToolResult;
	}
	return handoffResult(record, url, 'link', 'link-returned', heldToken(record));
}

/**
 * Refuses a handoff answer whose verified state does not name this session. The SDK verified the MAC, the expiry and
 * the principal binding before the handler ran; this is the comparison only the handler can make. Fail closed: a
 * round with no state, a raw string (no codec on this path) or state of another kind or session is refused.
 */
function assertHandoffBound(ctx: ToolContext, record: SessionRecord): void {
	const state = ctx.mcp?.mcpReq.requestState<unknown>?.();
	const bound = state !== null && typeof state === 'object' &&
		(state as Record<string, unknown>).k === HANDOFF_STATE_KIND &&
		(state as Record<string, unknown>).s === record.id;
	if (!bound) {
		throw new ToolError(
			'invalid-arguments',
			`this answer does not belong to a handoff of session ${record.id}; call browser_request_human again`,
		);
	}
}

/**
 * The element table's token once the person is done. Re-read rather than reported from the cache: the whole point
 * of a handoff is that someone else may have moved the page. A read that fails does not cost the caller the outcome
 * — `null` says "read the page yourself" — but a cancelled call stays cancelled.
 */
async function freshToken(record: SessionRecord, ctx: ToolContext): Promise<string | null> {
	try {
		await observe(record, { signal: ctx.signal });
	} catch {
		ctx.signal?.throwIfAborted();
		return null;
	}
	ctx.registry.touch(record.id);
	return heldToken(record);
}

function handoffResult(
	record: SessionRecord,
	url: string,
	delivery: 'elicitation' | 'link',
	outcome: 'accepted' | 'link-returned',
	stateToken: string | null,
): ToolResult {
	const humanHasControl = record.lock !== null;
	return say(
		{
			session_id: record.id,
			live_view_url: url,
			delivery,
			outcome,
			human_has_control: humanHasControl,
			state_token: stateToken,
		},
		outcome === 'accepted'
			? `The person is done with session ${record.id}${
				humanHasControl ? ' and still holds control' : ''
			}. Read the page again before acting on it.`
			: `Show the user this live view of session ${record.id} and ask them to take over: ${url}`,
	);
}
