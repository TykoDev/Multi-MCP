/**
 * MCP Apps handlers (R9, design §2.20, D-134): `browser_live_view` and `browser_live_ticket`.
 *
 * Neither reaches the browser beyond reading what the registry already holds, and neither launches one:
 * `browser_live_view` is read-only and a read-only tool that spawned Chromium as a side effect would be lying about
 * itself. The ticket comes from the gateway (`McpAppsDeps.mintTicket`), which owns the ticket store and the origin
 * policy; this layer only says who is asking, for which session, in which mode and from which origin.
 */
import { ToolError } from '../errors.ts';
import { freshTabs, tabsOf } from '../observe.ts';
import type { Scope } from '../scopes.ts';
import type { McpAppsDeps, ToolContext, ToolResult } from '../types.ts';
import { say } from '../types.ts';
import { peekSession } from './shared.ts';

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

/**
 * `browser_live_view` — what the embedded live view shows, and whether it may offer control.
 *
 * The result carries no URL path and no credential: the embed needs the session id to ask for a ticket, and the
 * model needs the origin and title to say what is on screen. `control_available` is the deployment ceiling
 * (`TTK_MCP_APPS=control`) and this credential's `view:control` together, so the embed never offers a button the
 * mint would refuse.
 */
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

/**
 * `browser_live_ticket` — a single-use, 30-second ticket bound to the embed's origin (app-only).
 *
 * No client-capability gate (design §2.22, F5): a 2025-era host on the stateless mount declares no capabilities,
 * and a declaration is spoofable anyway. The authority is exactly the REST mint's for the same credential; what
 * the gateway adds is the origin rule and the mode ceiling. The ticket stays in `structuredContent`: the text a
 * model may read names the session, the mode and the binding, never the ticket itself.
 */
export async function browserLiveTicket(
	args: { session_id?: string; mode?: 'watch' | 'control'; origin: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const apps = appsOf(ctx, 'browser_live_ticket');
	// Review R1-3: the ticket is issued to the principal *id* — the per-token origin overlay and the per-principal
	// connection ceiling both key on it — while the session is looked up by the realm-qualified *owner*. An MCP call
	// carries both, as `principal` and `extensionPrincipal`. A tool executor (an agent task) is handed the owner alone,
	// as `principal`, so it has no id to issue a ticket to: refused, rather than minting one keyed on the owner string,
	// outside the overlay and in a second connection bucket. (The gateway refuses this tool for every task before it
	// gets here; this holds wherever an executor runs.)
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
		// F21: the label is the credential's, and only the gateway holds the key records it is declared in; `null`
		// asks the gateway's mint to resolve it.
		holderName: null,
	});
	return say(
		{ ...minted },
		`Minted a single-use ${minted.mode} ticket for session ${minted.session_id}, bound to ${minted.origin_bound}; ` +
			`it expires in ${minted.expires_in} s.`,
	);
}
