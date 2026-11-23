/** Navigation handlers: moving the focused tab between documents. */
import { GoBackEvent, NavigateToUrlEvent, waitForNetworkStability } from '@tykotech/browser';
import { delay } from '@std/async/delay';
import type { EventKind, EventRecord } from '@tykotech/wire';
import { assertNavigable, ToolError } from '../errors.ts';
import type { ParsedCursor } from '../events.ts';
import { observe } from '../observe.ts';
import { blockedSince, type SessionRecord } from '../registry.ts';
import { json, type ToolContext, type ToolResult } from '../types.ts';
import { performSearch } from './perception.ts';
import { dispatch, heldToken, identify, target } from './shared.ts';

/**
 * Dispatches a navigation this tool issues and answers `navigation-blocked` when the browser refused one of its
 * document requests before sending it — the initial request or any redirect hop.
 */
async function navigateWatchingBlocks(
	record: SessionRecord,
	ctx: ToolContext,
	event: object,
	requested: string | null,
): Promise<void> {
	const targetId = record.session.agentFocusTargetId;
	const since = ctx.registry.now();
	const refuse = (): void => {
		const origin = blockedSince(record, targetId ?? record.session.agentFocusTargetId, since, requested);
		if (origin !== null) {
			throw new ToolError('navigation-blocked', `${origin} is not in the server's allowed-domain list`);
		}
	};
	try {
		await dispatch(record.session, event);
	} catch (cause) {
		refuse();
		throw cause;
	}
	refuse();
}

export async function browserNavigate(
	args: { url: string; session_id?: string; new_session?: boolean; profile?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const url = assertNavigable(args.url, ctx.allowedDomains);
	if (args.profile !== undefined && args.new_session !== true) {
		throw new ToolError('invalid-arguments', 'profile only applies when new_session is true');
	}
	const record = args.new_session === true
		// The new session belongs to the caller in `owner` mode.
		? await ctx.registry.createNew(undefined, args.profile, ctx.access)
		: await target(ctx, args, true);
	if (args.new_session === true) ctx.registry.assertUnlocked(record);

	await navigateWatchingBlocks(record, ctx, new NavigateToUrlEvent({ url: url.href }), url.href);
	ctx.registry.touch(record.id);
	const page = await identify(record, url.href);
	return json({
		session_id: record.id,
		url: page.url,
		title: page.title,
		...(record.profile === undefined ? {} : { profile: record.profile }),
	});
}

export async function browserGoBack(
	args: { session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	// A history navigation that has to fetch its document is judged like any other (a back/forward-cache restore
	// sends no request and is out of reach).
	await navigateWatchingBlocks(record, ctx, new GoBackEvent(), null);
	ctx.registry.touch(record.id);
	// Where "back" landed is the only interesting part of the answer, and the caller cannot know it in advance.
	const page = await identify(record, record.session.cachedBrowserState?.url ?? '');
	return json({ session_id: record.id, url: page.url, title: page.title });
}

// --- browser_wait_for -------------------------------------------------------

/** `browser_wait_for`'s budget when the caller names none. */
export const WAIT_FOR_DEFAULT_TIMEOUT_MS = 10_000;

/** Minimum interval between the two predicates the ring cannot answer. */
const WAIT_SEARCH_POLL_MS = 250;

/** Tick for `state_token_changes`. */
const WAIT_TOKEN_POLL_MS = 1000;

/** What a caller may wait for. Exactly one key, enforced by the schema and re-checked here. */
export interface WaitUntil {
	navigation?: true;
	selector?: string;
	text?: string;
	network_idle?: number;
	download?: true;
	dialog?: true;
	state_token_changes?: string;
}

/** The ring kinds each `until` key is satisfied by, or `null` when the ring cannot answer it. */
function ringKindsFor(until: WaitUntil): ReadonlySet<EventKind> | null {
	if (until.navigation === true) return new Set<EventKind>(['navigation']);
	if (until.dialog === true) return new Set<EventKind>(['dialog']);
	if (until.download === true) {
		return new Set<EventKind>(['download.started', 'download.done', 'download.failed']);
	}
	return null;
}

/** `browser_wait_for`: block until one condition holds, or say it did not. */
export async function browserWaitFor(
	args: { until: WaitUntil; timeout_ms?: number; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	ctx.signal?.throwIfAborted();
	const until = args.until ?? {};
	const named = Object.entries(until).filter(([, value]) => value !== undefined);
	if (named.length !== 1) {
		throw new ToolError('invalid-arguments', 'until must name exactly one condition');
	}
	const record = await target(ctx, args, false);
	ctx.registry.touch(record.id);
	const timeoutMs = args.timeout_ms ?? WAIT_FOR_DEFAULT_TIMEOUT_MS;
	// Progress is elapsed against the timeout; the heartbeat counts the seconds, the handler names the bound and the wait.
	ctx.progress?.({ total: timeoutMs / 1000, message: `waiting for ${named[0]?.[0] ?? 'a condition'}` });
	const startedAt = Date.now();
	const deadline = startedAt + timeoutMs;
	const ring = record.events;
	const answer = (met: boolean, event: EventRecord | null): ToolResult =>
		json({
			session_id: record.id,
			met,
			after_ms: Math.max(0, Date.now() - startedAt),
			event,
			state_token: heldToken(record),
		});

	if (until.network_idle !== undefined) {
		const client = record.session.cdpClient;
		if (client === null) throw new ToolError('browser-unavailable', 'the session is not connected');
		const probe = await waitForNetworkStability({
			client,
			stableMs: until.network_idle,
			maxMs: timeoutMs,
			signal: ctx.signal,
		});
		ctx.signal?.throwIfAborted();
		return answer(probe.stable, null);
	}

	const kinds = ringKindsFor(until);
	let cursor: ParsedCursor = { kind: 'cursor', epoch: ring.epoch, seq: ring.highWaterMark };
	let nextTokenCheck = 0;
	let nextSearchAt = 0;
	for (;;) {
		ctx.signal?.throwIfAborted();
		if (kinds !== null) {
			// The mark is taken *before* the read, so a record appended during the
			// read is re-seen next tick rather than skipped.
			const mark = ring.highWaterMark;
			const page = ring.read(cursor, kinds);
			cursor = { kind: 'cursor', epoch: ring.epoch, seq: mark };
			// The gap is checked **before** the hit.
			const lost = page.find((entry) => entry.kind === 'gap');
			if (lost !== undefined) return answer(false, lost);
			const hit = page.find((entry) => kinds.has(entry.kind as EventKind));
			if (hit !== undefined) return answer(true, hit);
		}
		if ((until.selector !== undefined || until.text !== undefined) && Date.now() >= nextSearchAt) {
			nextSearchAt = Date.now() + WAIT_SEARCH_POLL_MS;
			const query = until.selector ?? until.text ?? '';
			// `countOnly`: this predicate needs existence, not indices.
			const found = await performSearch(record, query, '', { frames: [] }, { countOnly: true })
				.catch(() => null);
			if (found !== null && found.count > 0) return answer(true, null);
		}
		if (until.state_token_changes !== undefined && Date.now() >= nextTokenCheck) {
			nextTokenCheck = Date.now() + WAIT_TOKEN_POLL_MS;
			const observation = await observe(record, { fields: new Set(), elementLimit: 1 }).catch(() => null);
			if (observation !== null && observation.stateToken !== until.state_token_changes) {
				return answer(true, null);
			}
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return answer(false, null);
		// A ring-backed predicate can sleep the whole remaining budget because an append is exactly what wakes it. A
		// polled predicate sleeps to its own next due time, so an unrelated wake costs nothing.
		const tick = kinds !== null ? remaining : Math.min(remaining, pollFor(until));
		const wokeAt = Date.now();
		await ring.next(tick, ctx.signal);
		// `ring.next` resolves on *any* append, and a page can append at its own rate, so a polled predicate would
		// otherwise re-enter the loop hundreds of times a second for the whole budget.
		if (kinds === null) {
			const slept = Date.now() - wokeAt;
			if (slept < tick) await delay(Math.min(tick - slept, remaining), { signal: ctx.signal });
		}
		if (ring.closed) return answer(false, null);
	}
}

/** How long a predicate the ring cannot answer sleeps between evaluations. */
function pollFor(until: WaitUntil): number {
	return until.state_token_changes !== undefined ? WAIT_TOKEN_POLL_MS : WAIT_SEARCH_POLL_MS;
}
