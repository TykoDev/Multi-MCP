/** Session handlers: tabs, session lifecycle, persistent storage state, and recording. */
import {
	CloseTabEvent,
	LoadStorageStateEvent,
	parseStorageState,
	SaveStorageStateEvent,
	SwitchTabEvent,
} from '@tykotech/browser';
import { ToolError } from '../errors.ts';
import { freshTabs, observe, tabsOf } from '../observe.ts';
import { safeProfileName, type SessionRecord } from '../registry.ts';
import { applyEmulation, applyViewport } from '../page_viewport.ts';
import { json, type McpAppsDeps, projected, say, type ToolContext, type ToolResult } from '../types.ts';
import { assertTab, dispatch, heldToken, peekSession, target } from './shared.ts';
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { Scope } from '../scopes.ts';

export async function browserListTabs(
	args: { session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	await freshTabs(record.session);
	ctx.registry.touch(record.id);
	return json({ session_id: record.id, tabs: tabsOf(record.session) });
}

export async function browserSwitchTab(
	args: { tab_id: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const targetId = assertTab(record.session, args.tab_id);
	await dispatch(record.session, new SwitchTabEvent({ targetId }));
	await freshTabs(record.session);
	ctx.registry.touch(record.id);
	// The new focus is the point of the call, so it is reported rather than left for a follow-up round trip.
	return json({ session_id: record.id, focused_tab_id: args.tab_id, tabs: tabsOf(record.session) });
}

export async function browserCloseTab(
	args: { tab_id: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const targetId = assertTab(record.session, args.tab_id);
	await dispatch(record.session, new CloseTabEvent({ targetId }));
	await freshTabs(record.session);
	ctx.registry.touch(record.id);
	return json({ session_id: record.id, closed_tab_id: args.tab_id, tabs: tabsOf(record.session) });
}

/** One session's full description. */
export function sessionDetail(record: SessionRecord, ctx: ToolContext): Record<string, unknown> {
	const profile = record.session.profile as {
		viewport?: { width: number; height: number } | null;
		deviceScaleFactor?: number;
	} | undefined;
	const launched = profile?.viewport ?? null;
	const viewport = record.viewport ?? (launched === null ? null : {
		width: launched.width,
		height: launched.height,
		device_scale: profile?.deviceScaleFactor ?? 1,
	});
	return {
		session_id: record.id,
		profile: record.profile ?? null,
		created_at: new Date(record.createdAt).toISOString(),
		last_used_at: new Date(record.lastUsedAt).toISOString(),
		// Null, not the creation time: "never driven" and "driven when it was made" are different
		// facts, and a client deciding whether a session is abandoned needs to tell them apart.
		last_input_at: record.lastInputAt === undefined ? null : new Date(record.lastInputAt).toISOString(),
		viewport,
		tabs: tabsOf(record.session),
		holder: record.lock === null ? null : {
			principal: record.lock.principal,
			holder_name: record.lock.holderName,
			taken_at: new Date(record.lock.takenAt).toISOString(),
		},
		human_has_control: record.lock !== null,
		idle_timeout_s: Math.round((record.idleTimeoutMs ?? ctx.registry.sessionTtlMs) / 1000),
		origin_allowlist: [...ctx.allowedDomains],
		viewers: record.viewers.size,
		files: record.files.list().length,
		state_token: record.session.cachedBrowserState?.stateToken ?? null,
	};
}

export function browserListSessions(_args: Record<never, never>, ctx: ToolContext): Promise<ToolResult> {
	// The text block keeps its frozen payload byte for byte, and the fuller records land in the structured half only.
	const summaries = ctx.registry.listFor(ctx.access);
	return Promise.resolve(projected(
		{ sessions: summaries, details: ctx.registry.visibleTo(ctx.access).map((record) => sessionDetail(record, ctx)) },
		{ sessions: summaries },
	));
}

/** `browser_get_session` — everything the server knows about one session. */
export async function browserGetSession(
	args: { session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	await freshTabs(record.session);
	ctx.registry.touch(record.id);
	return json(sessionDetail(record, ctx));
}

/** `browser_set_viewport` — emulate a viewport for the whole session. */
export async function browserSetViewport(
	args: { width: number; height: number; device_scale?: number; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const viewport = await applyViewport(record, {
		width: args.width,
		height: args.height,
		device_scale: args.device_scale ?? 1,
	});
	ctx.registry.touch(record.id);
	return say(
		{ session_id: record.id, viewport, state_token: null },
		`Set the viewport of session ${record.id} to ${viewport.width}x${viewport.height} at ${viewport.device_scale}x.`,
	);
}

/** `browser_set_session_options` — the options a session can be reconfigured with. */
export async function browserSetSessionOptions(
	args: {
		viewport?: { width: number; height: number };
		locale?: string;
		timezone?: string;
		user_agent?: string;
		accept_downloads?: boolean;
		idle_timeout_s?: number;
		session_id?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, true);
	const applied: Record<string, unknown> = {};
	const unsupported: string[] = [];

	if (args.viewport !== undefined) {
		applied.viewport = await applyViewport(record, {
			width: args.viewport.width,
			height: args.viewport.height,
			device_scale: record.viewport?.device_scale ?? 1,
		});
	}
	const emulation = await applyEmulation(record, args);
	Object.assign(applied, emulation.applied);
	unsupported.push(...emulation.unsupported);

	if (args.accept_downloads !== undefined) {
		// Guarded rather than called through the declared type, as the registry guards the download listener:
		// an injected launcher may hand back a ledger stand-in with no runtime switch, which costs this field.
		const downloads = record.downloads;
		const switched = typeof downloads?.setAcceptDownloads === 'function' &&
			await downloads.setAcceptDownloads(args.accept_downloads);
		if (switched) applied.accept_downloads = args.accept_downloads;
		else unsupported.push('accept_downloads');
	}
	if (args.idle_timeout_s !== undefined) {
		record.idleTimeoutMs = args.idle_timeout_s * 1000;
		applied.idle_timeout_s = args.idle_timeout_s;
	}

	ctx.registry.touch(record.id);
	const count = Object.keys(applied).length;
	const tail = unsupported.length === 0 ? '' : `; ${unsupported.join(', ')} not supported here`;
	return say(
		{ session_id: record.id, applied, unsupported, state_token: null },
		`Applied ${count} option${count === 1 ? '' : 's'} to session ${record.id}${tail}.`,
	);
}

/** `browser_health` — is this server serving, and what can this credential do with it? */
export async function browserHealth(
	_args: Record<never, never>,
	ctx: ToolContext,
): Promise<ToolResult> {
	// Counts over the sessions this caller may reach, so `owner` mode does not leak how many others run.
	const records = ctx.registry.visibleTo(ctx.access);
	const probes = await Promise.all(records.map((record) => probeBrowser(record)));
	const answered = probes.filter((probe) => probe === 'ok').length;
	const sessions = {
		total: records.length,
		browser_ok: answered,
		browser_unresponsive: probes.filter((probe) => probe === 'unresponsive').length,
		human_has_control: records.filter((record) => record.lock !== null).length,
		viewers: records.reduce((sum, record) => sum + record.viewers.size, 0),
		tabs: records.reduce((sum, record) => sum + record.session.tabs.length, 0),
	};
	// `degraded` is a real state, not decoration: sessions exist and at least one cannot be driven — no CDP client,
	// or a browser that did not answer — so a caller polling this can tell "nothing is running" from "something is
	// running and cannot be driven".
	const status = records.length > 0 && answered < records.length ? 'degraded' : 'ok';
	return json({
		status,
		version: ctx.capabilities?.version ?? null,
		sessions,
		...(ctx.capabilities === undefined ? {} : { capabilities: ctx.capabilities }),
	});
}

/** How long one session's browser has to answer `browser_health`'s probe. */
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

/**
 * One session's liveness: `ok` when its browser answered `Browser.getVersion` in time, `unresponsive` when it is
 * connected and did not, `disconnected` when it has no CDP client. Never throws, never launches.
 */
async function probeBrowser(record: SessionRecord): Promise<'ok' | 'unresponsive' | 'disconnected'> {
	const client = record.session.cdpClient;
	if (client === null) return 'disconnected';
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<'unresponsive'>((resolve) => {
		timer = setTimeout(() => resolve('unresponsive'), HEALTH_PROBE_TIMEOUT_MS);
	});
	const answer = (async () => {
		await client.send.Browser.getVersion(undefined, undefined, { requestTimeoutMs: HEALTH_PROBE_TIMEOUT_MS });
		return 'ok' as const;
	})().catch(() => 'unresponsive' as const);
	try {
		return await Promise.race([answer, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

export async function browserCloseSession(
	args: { session_id: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	// Closing is administrative: it succeeds even while a human holds the lock,
	// and the viewers are told why their socket ended. Only a session the caller may reach is found.
	const record = ctx.registry.peekFor(args.session_id, ctx.access);
	const closed = record !== undefined && await ctx.registry.close(record.id, 'session-closed');
	if (!closed) throw new ToolError('unknown-session', `no session with id ${args.session_id}`);
	return say({ session_id: args.session_id, closed: true }, `Closed session ${args.session_id}.`);
}

export async function browserCloseAll(
	_args: Record<never, never>,
	ctx: ToolContext,
): Promise<ToolResult> {
	const count = await ctx.registry.closeAll('session-closed');
	return say({ closed: count }, `Closed ${count} session${count === 1 ? '' : 's'}.`);
}

/** Saves or loads a named storage-state document. */
export async function browserStorageState(
	args: { action: 'save' | 'load'; name: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	if (ctx.registry.storageDir === null) {
		throw new ToolError(
			'invalid-arguments',
			'storage state needs a data directory; start the server with TTK_DATA_DIR set',
		);
	}
	// Loading mutates the browser; saving only reads it.
	const record = await target(ctx, args, args.action === 'load');
	// In `owner` mode the name is the *caller's* — its own directory — so another owner's saved login can be
	// neither loaded nor overwritten by naming it. `shared` mode keeps the flat directory.
	const dir = (await ctx.registry.storageDirFor(ctx.access))!;
	const path = `${dir}/${safeProfileName(args.name)}.json`;

	if (args.action === 'save') {
		await Deno.mkdir(dir, { recursive: true }).catch(() => {});
		await dispatch(record.session, new SaveStorageStateEvent({ path }));
	} else {
		try {
			await Deno.stat(path);
		} catch {
			throw new ToolError('invalid-arguments', `no saved storage state named ${args.name}`);
		}
		await dispatch(record.session, new LoadStorageStateEvent({ path }));
	}

	// Counts, never contents.
	let cookies = 0;
	let origins = 0;
	// Which origins a load restored, by **name**. A workflow needs to assert that its login is present, and a count
	// alone cannot answer "present for which site?".
	let restoredOrigins: string[] = [];
	try {
		const parsed = parseStorageState(await Deno.readTextFile(path));
		cookies = parsed.state.cookies?.length ?? 0;
		const list = parsed.state.origins ?? [];
		origins = list.length;
		if (args.action === 'load') restoredOrigins = list.map((entry) => entry.origin);
	} catch {
		// A state that cannot be read back is still a completed action; the counts are the only thing lost.
	}
	ctx.registry.touch(record.id);
	return json({
		session_id: record.id,
		action: args.action,
		name: args.name,
		cookies,
		origins,
		...(args.action === 'load' ? { restored_origins: restoredOrigins } : {}),
	});
}

/** Starts, stops or reports a session recording. */
export async function browserRecord(
	args: { action: 'start' | 'stop' | 'status'; name?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const recorder = ctx.recorder;
	if (recorder === undefined) {
		throw new ToolError('invalid-arguments', 'this deployment cannot record (no data directory or no ffmpeg)');
	}
	// Recording only observes; a human holding the browser is a reason to record it, not a reason to refuse.
	const record = await target(ctx, args, false);
	ctx.registry.touch(record.id);

	if (args.action === 'status') {
		const info = recorder.status(record.id);
		return json({ ...(info ?? { session_id: record.id, recording: false }) });
	}
	if (args.action === 'start') {
		const name = args.name ?? `${record.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		// The recording is bound to its starter, so the recordings route can refuse anyone else.
		return json({ ...(await recorder.start(record.id, name, ctx.access?.owner)) });
	}
	return json({ ...(await recorder.stop(record.id)) });
}

// --- reading the audit ledger -------------------------------------------------

/** `browser_audit` — the record that a privileged operation happened. */
// deno-lint-ignore require-await -- a handler is always awaited; a synchronous throw would escape the result mapping.
export async function browserAudit(
	args: { since?: string; limit?: number; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = peekSession(ctx, args.session_id);
	const read = record.audit.read({
		principal: ctx.principal,
		all: ctx.scopes?.has('admin') === true,
		...(args.since === undefined ? {} : { since: args.since }),
		...(args.limit === undefined ? {} : { limit: args.limit }),
	});
	return json({
		session_id: record.id,
		entries: read.entries,
		dropped: read.dropped,
		scope: read.scope,
	});
}

// --- `browser_request_human`: hand a session to a person through the live view. ----------------------------------

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

/** Refuses a handoff answer whose verified state does not name this session. */
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
 * The element table's token once the person is done. Re-read rather than reported from the cache: the whole point of
 * a handoff is that someone else may have moved the page.
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

// --- MCP Apps handlers: `browser_live_view` and `browser_live_ticket`. -------------------------------------------

/** The longest page title the live view reports; the embed shows one line of it. */
const MAX_TITLE_CHARS = 512;

/** The deployment's MCP Apps, or the same refusal the dispatcher gives when the feature is off. */
function appsOf(ctx: ToolContext, name: string): McpAppsDeps {
	if (ctx.mcpApps === undefined) {
		throw new ToolError(
			'feature-unavailable',
			`${name} needs MCP Apps, which is off on this deployment; set TTK_MCP_APPS=watch or control`,
		);
	}
	return ctx.mcpApps;
}

/** The origin of an `http(s)` page, or `null` for a page with none (`about:blank`, `data:`, a browser page). */
function originOf(url: string): string | null {
	const parsed = URL.parse(url);
	if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
	return parsed.origin;
}

/** `browser_live_view` — what the embedded live view shows, and whether it may offer control. */
export async function browserLiveView(args: { session_id?: string }, ctx: ToolContext): Promise<ToolResult> {
	const apps = appsOf(ctx, 'browser_live_view');
	const record = peekSession(ctx, args.session_id);
	await freshTabs(record.session);
	const tabs = tabsOf(record.session);
	const focused = tabs.find((tab) => tab.focused === true) ?? tabs[0];
	const origin = originOf(typeof focused?.url === 'string' ? focused.url : '');
	const title = (typeof focused?.title === 'string' ? focused.title : '').slice(0, MAX_TITLE_CHARS);
	const payload = {
		session_id: record.id,
		origin,
		title,
		viewers: record.viewers.size,
		human_has_control: record.lock !== null,
		control_available: apps.mode === 'control' && ctx.scopes?.has('view:control') === true,
	};
	return say(
		payload,
		`Showing session ${record.id} (${origin ?? 'no page origin'}) in the live view. It connects only when the user ` +
			`presses Watch${record.lock === null ? '' : '; a human holds control of it right now'}.`,
	);
}

/** `browser_live_ticket` — a single-use, 30-second ticket bound to the embed's origin (app-only). */
export async function browserLiveTicket(
	args: { session_id?: string; mode?: 'watch' | 'control'; origin: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const apps = appsOf(ctx, 'browser_live_ticket');
	// The ticket is issued to the principal *id* — the per-token origin overlay and the per-principal connection
	// ceiling both key on it — while the session is looked up by the realm-qualified *owner*.
	const owner = ctx.extensionPrincipal;
	if (owner === undefined) {
		throw new ToolError('invalid-arguments', 'call browser_live_ticket directly; it cannot run as a background task');
	}
	const scopes: ReadonlySet<Scope> = ctx.scopes ?? new Set<Scope>();
	const access = ctx.access ?? { owner, admin: scopes.has('admin') };
	const minted = await apps.mintTicket({
		principal: ctx.principal,
		access,
		scopes,
		...(args.session_id === undefined ? {} : { sessionId: args.session_id }),
		mode: args.mode ?? 'watch',
		origin: args.origin,
		// The label is the credential's, and only the gateway holds the key records it is declared in; `null`
		// asks the gateway's mint to resolve it.
		holderName: null,
	});
	return say(
		{ ...minted },
		`Minted a single-use ${minted.mode} ticket for session ${minted.session_id}, bound to ${minted.origin_bound}; ` +
			`it expires in ${minted.expires_in} s.`,
	);
}
