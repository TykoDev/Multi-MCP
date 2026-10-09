/**
 * Session handlers: tabs, session lifecycle, persistent storage state, and recording.
 *
 * The machinery these drive is the registry and the session manager rather than the page, which is
 * why they sit together: none of them reads an element or moves a document.
 */
import {
	CloseTabEvent,
	LoadStorageStateEvent,
	parseStorageState,
	SaveStorageStateEvent,
	SwitchTabEvent,
} from '@tykotech/browser';
import { ToolError } from '../errors.ts';
import { freshTabs, tabsOf } from '../observe.ts';
import { safeProfileName } from '../registry.ts';
import { applyEmulation, applyViewport } from '../page_viewport.ts';
import type { SessionRecord } from '../registry.ts';
import { json, projected, say, type ToolContext, type ToolResult } from '../types.ts';
import { assertTab, dispatch, peekSession, target } from './shared.ts';

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
	// The new focus is the point of the call, so it is reported rather than left
	// for a follow-up round trip.
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

/**
 * One session's full description (B2.6).
 *
 * The **one** builder behind both `browser_get_session` and `browser_list_sessions`, which is what
 * makes AC-P1-26's "carry the same fields" a property of the code rather than of two literals that
 * agree today. `origin_allowlist` is the list effective for **this principal**, so a caller reads
 * what actually constrains it rather than a server-wide default it may not be subject to.
 *
 * `viewport` reports the tool-set override when there is one and the profile's launch viewport
 * otherwise, and `idle_timeout_s` reports the timeout this session is actually subject to — the
 * per-session override, else the registry's. Neither is restated here: both are read from the one
 * place that owns them.
 */
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
	// I-4 / D-3: the text block keeps its frozen 0.1.0 payload byte for byte, and B2.6's fuller
	// records land in the structured half only. Doubling the largest listing in the catalog to say
	// the same thing twice would be paid on every call, by every client, for no consumer.
	// R8 (D-128): the sessions this caller may reach — all of them in `shared` mode — in the same shapes.
	const summaries = ctx.registry.listFor(ctx.access);
	return Promise.resolve(projected(
		{ sessions: summaries, details: ctx.registry.visibleTo(ctx.access).map((record) => sessionDetail(record, ctx)) },
		{ sessions: summaries },
	));
}

/**
 * `browser_get_session` — everything the server knows about one session (B2.6, AC-P1-26).
 *
 * Read-only, so it stays available while a human holds the lock: a client that cannot see who holds
 * a session is worse off than one that merely cannot act on it, and `holder` is exactly what it
 * needs to explain the refusal it just got.
 */
export async function browserGetSession(
	args: { session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	await freshTabs(record.session);
	ctx.registry.touch(record.id);
	return json(sessionDetail(record, ctx));
}

/**
 * `browser_set_viewport` — emulate a viewport for the whole session (B2.6, AC-P1-18).
 *
 * `device_scale` maps to `deviceScaleFactor` — device pixel ratio — and **never** to
 * `Emulation.setDeviceMetricsOverride`'s `scale`, which is page scale. The distinction is invariant
 * I-16 and the reason is at `page_viewport.ts`: page scale makes the dormant layout-versus-visual
 * viewport divergence reachable on demand, and this delivery does not do that. The prohibition is
 * enforced by the one builder both call sites use, and asserted by a unit test on the dispatched
 * object rather than by reading this comment.
 */
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

/**
 * `browser_set_session_options` — the options a session can be reconfigured with (B2.6, AC-P1-27).
 *
 * **`applied` and `unsupported` are the contract, not decoration.** The fields have different
 * degrees of plumbing behind them and a tool that answered "ok" for all of them would be lying about
 * at least one on some deployment. What actually took effect comes back in `applied`; what this
 * build could not apply comes back in `unsupported`, by name.
 *
 * `accept_downloads` is applied at runtime since A3 (E-77): through **the session's own downloads
 * watchdog**, which owns the download directory and the `Browser.setDownloadBehavior` state, so the
 * browser and the watchdog's profile move together — `deny` when false, the watchdog's accepting
 * behaviour when true. It lands in `applied` only when the browser accepted it; a session with no
 * watchdog, or a browser that refused, reports it in `unsupported` as before.
 */
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

/**
 * `browser_health` — is this server serving, and what can this credential do with it (B3.2, §8)?
 *
 * **A read, and only a read.** It never resolves a session and therefore never launches a browser:
 * a health check that minted Chromium the first time it was polled would be a liveness probe that
 * changed the thing it measured. It reports what the registry already holds.
 *
 * `browser_ok` is the honest half of "browser liveness", and since A4 it is measured rather than
 * inferred: a session counts only when its browser **answered** `Browser.getVersion` within
 * {@linkcode HEALTH_PROBE_TIMEOUT_MS}. An attached CDP client used to be enough, and a wedged Chromium —
 * socket open, renderer or browser process stuck — kept reporting healthy. A connected session that
 * does not answer in time, or answers with an error, is `browser_unresponsive`; a session with no client
 * at all is neither. The probes run in parallel, so one wedged browser costs the poll two seconds, not
 * two seconds per session, and `Browser.getVersion` is a browser-level read that touches no page.
 *
 * `capabilities` is the same already-scope-filtered block the `initialize` result and
 * `ttk://capabilities` carry (report_design.md §10.1 location 3), so a client that polls health also
 * learns when a deployment fact changed — a data directory mounted, an encoder installed — without a
 * reconnect.
 */
export async function browserHealth(
	_args: Record<never, never>,
	ctx: ToolContext,
): Promise<ToolResult> {
	// R8 (D-128): counts over the sessions this caller may reach, so `owner` mode does not leak how many others run.
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
	// `degraded` is a real state, not decoration: sessions exist and at least one
	// cannot be driven — no CDP client, or a browser that did not answer — so a
	// caller polling this can tell "nothing is running" from "something is
	// running and cannot be driven".
	const status = records.length > 0 && answered < records.length ? 'degraded' : 'ok';
	return json({
		status,
		version: ctx.capabilities?.version ?? null,
		sessions,
		...(ctx.capabilities === undefined ? {} : { capabilities: ctx.capabilities }),
	});
}

/** How long one session's browser has to answer `browser_health`'s probe (A4). */
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

/**
 * One session's liveness: `ok` when its browser answered `Browser.getVersion` in time, `unresponsive` when
 * it is connected and did not, `disconnected` when it has no CDP client. Never throws, never launches.
 *
 * The CDP request carries the same timeout, so the client abandons it too; the local timer is what bounds
 * a stand-in client, or one whose transport is stuck before the request is even written.
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
	// and the viewers are told why their socket ended. R8 (D-128): only a session the caller may reach is found.
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

/**
 * Saves or loads a named storage-state document (R3).
 *
 * It moves state by *name*, server-side. The obvious alternative — returning
 * the document so a caller can hand it back later — would put live session
 * cookies into a tool result, and from there into the model's context and the
 * client's transcript. That is a credential disclosure with extra steps, so
 * the contents never leave this process; the result carries counts only.
 */
export async function browserStorageState(
	args: { action: 'save' | 'load'; name: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const dir = ctx.registry.storageDir;
	if (dir === null) {
		throw new ToolError(
			'invalid-arguments',
			'storage state needs a data directory; start the server with TTK_DATA_DIR set',
		);
	}
	// Loading mutates the browser; saving only reads it.
	const record = await target(ctx, args, args.action === 'load');
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
	// B2.6 / SEC-19: which origins a load restored, by **name**. A workflow needs to assert that its
	// login is present, and a count alone cannot answer "present for which site?". Names only: no
	// cookie value, no cookie name, no localStorage key and no localStorage value ever reaches this
	// array, because the whole point of moving state by name server-side is that the document does
	// not leave the process. Load only — a save restored nothing, so the key is absent there rather
	// than an empty array a caller might read as "restored nothing".
	let restoredOrigins: string[] = [];
	try {
		const parsed = parseStorageState(await Deno.readTextFile(path));
		cookies = parsed.state.cookies?.length ?? 0;
		const list = parsed.state.origins ?? [];
		origins = list.length;
		if (args.action === 'load') restoredOrigins = list.map((entry) => entry.origin);
	} catch {
		// A state that cannot be read back is still a completed action; the counts
		// are the only thing lost.
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

/**
 * Starts, stops or reports a session recording.
 *
 * The video is written server-side and downloaded over HTTP rather than
 * returned here: a minute of screen is megabytes, and a tool result is a place
 * for facts a model can reason about, not for a payload it will only pass on.
 */
export async function browserRecord(
	args: { action: 'start' | 'stop' | 'status'; name?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const recorder = ctx.recorder;
	if (recorder === undefined) {
		throw new ToolError('invalid-arguments', 'this deployment cannot record (no data directory or no ffmpeg)');
	}
	// Recording only observes; a human holding the browser is a reason to record
	// it, not a reason to refuse.
	const record = await target(ctx, args, false);
	ctx.registry.touch(record.id);

	if (args.action === 'status') {
		const info = recorder.status(record.id);
		return json({ ...(info ?? { session_id: record.id, recording: false }) });
	}
	if (args.action === 'start') {
		const name = args.name ?? `${record.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		// R8 (D-128): the recording is bound to its starter, so the recordings route can refuse anyone else.
		return json({ ...(await recorder.start(record.id, name, ctx.access?.owner)) });
	}
	return json({ ...(await recorder.stop(record.id)) });
}

// --- B2.8: reading the audit ledger -------------------------------------------

/**
 * `browser_audit` — the record that a privileged operation happened (B2.8, SEC-08, design §6.5).
 *
 * One ledger per session, written by every `browser_evaluate` call and by every use of a server-held
 * secret; this is its only reader. Two properties decide the whole design and neither is a nicety.
 *
 * **The row filter is here, in the handler, not in `registerCatalog`.** The tool is useful to an
 * `mcp:invoke` principal — "did *my* worker spend a credential, and where" — and to an `admin` one,
 * and only its rows differ. Gating registration would take the tool away from the caller it was asked
 * for instead of narrowing what it returns. So `admin` reads everything and everyone else reads their
 * own entries, and `ctx.scopes` being absent means *not privileged*: a missing authorization fact
 * fails closed.
 *
 * **Own means this principal's, not this session's.** Sessions are shared among `mcp:invoke` holders
 * by design (`SPECS/SECURITY-AUTH.md` §8.3), so an unfiltered read under that scope would hand every
 * session-sharing principal a map of every other principal's credential use — which is the finding,
 * not a refinement of it. `dropped` is on the wire so an overflow is visible rather than inferred,
 * and the ledger is in memory, per session, and never written to disk.
 */
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
