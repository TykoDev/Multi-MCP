/**
 * Viewport and emulation overrides for one session (B2.6).
 *
 * **Invariant I-16 lives here, at its only enforcement point.** `Emulation.setDeviceMetricsOverride`
 * carries two different scaling parameters and they mean different things:
 *
 * - `deviceScaleFactor` is **device pixel ratio**. It is divided out exactly once upstream, and the
 *   layout and visual viewports stay in agreement, so it is safe to set on demand. That is what
 *   `browser_set_viewport`'s `device_scale` maps to, and it is what `#applyViewport` in the vendored
 *   session has always sent.
 * - `scale` is **page scale** — pinch zoom. Under a page scale other than 1 the DOM merge reads
 *   `cssLayoutViewport` scroll while the action path reads `cssVisualViewport`
 *   (`extract_capture.ts:244,254-256` against `default_action_geometry.ts:67-82`), so a click point is
 *   computed from mixed coordinate spaces and can land somewhere the caller did not intend. That
 *   divergence is a **dormant** defect this delivery deliberately does not repair — and sending
 *   `scale` from a tool would make it reachable on demand, which is a different thing entirely.
 *
 * So: **the parameter object dispatched by this module never carries a `scale` key.** It is built by
 * one function, {@linkcode deviceMetrics}, and a unit test asserts the absence of the key rather than
 * trusting the reading of the call site — which is what keeps the answer true when someone later adds
 * a zoom feature and reaches for the nearest `setDeviceMetricsOverride`. SEC-24 stays Minor because
 * of this line, not in spite of it.
 */
import type { BrowserSession } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import type { SessionRecord } from './registry.ts';

/** Bounds on a tool-set viewport, matching the schema's own (design §6). */
export const VIEWPORT_MIN_PX = 200;
export const VIEWPORT_MAX_PX = 4096;
export const DEVICE_SCALE_MIN = 1;
export const DEVICE_SCALE_MAX = 4;

/** The viewport a session is currently emulating. */
export interface Viewport {
	readonly width: number;
	readonly height: number;
	readonly device_scale: number;
}

/**
 * The exact parameter object sent to `Emulation.setDeviceMetricsOverride` — **invariant I-16**.
 *
 * One builder, so "this call never sends page scale" is a property of a function a test can call
 * rather than a property of a call site someone has to re-read. `mobile: false` matches the vendored
 * `#applyViewport`, so a tool-set viewport and a profile-set one produce the same emulation.
 */
export function deviceMetrics(viewport: Viewport): {
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
} {
	return {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.device_scale,
		mobile: false,
	};
}

/** The connected session pieces, or a `browser-unavailable` refusal. */
function connected(session: BrowserSession) {
	const client = session.cdpClient;
	const manager = session.sessionManager;
	const focus = session.agentFocusTargetId;
	if (client === null || manager === null || focus === null) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	return { client, manager, focus };
}

/**
 * Applies a viewport to **every** tab of the session, and records it on the session record.
 *
 * Every tab rather than the focused one: a recording replays at the recorded viewport, and a
 * viewport that applied to whichever tab happened to be focused would be a different answer
 * depending on when it was called. The record is what a later `browser_get_session` reports and what
 * a newly created tab is re-emulated with, so the override outlives the tab it was set from.
 *
 * A tab that refuses the override is skipped rather than failing the call: the emulation is
 * cosmetic per tab, and a target mid-swap is a normal race, not a fault.
 */
export async function applyViewport(record: SessionRecord, viewport: Viewport): Promise<Viewport> {
	const { client, manager } = connected(record.session);
	const params = deviceMetrics(viewport);
	const targets = record.session.tabs.map((tab) => tab.targetId as TargetId);
	const seen = new Set<TargetId>(targets);
	const focus = record.session.agentFocusTargetId as TargetId | null;
	if (focus !== null && !seen.has(focus)) targets.push(focus);
	let applied = 0;
	for (const targetId of targets) {
		try {
			const cdp = await manager.getOrCreateCdpSession(targetId, false);
			await client.send.Emulation.setDeviceMetricsOverride(params, cdp.sessionId as SessionId);
			applied += 1;
		} catch {
			// A tab that is gone or mid-swap cannot be emulated; the others still are.
		}
	}
	if (applied === 0) {
		throw new ToolError('browser-unavailable', 'no tab of this session could take the viewport override');
	}
	record.viewport = viewport;
	return viewport;
}

/** Re-applies a session's recorded viewport override to one new tab; silent on failure. */
export async function reapplyViewport(record: SessionRecord, targetId: TargetId): Promise<void> {
	const viewport = record.viewport;
	if (viewport === undefined) return;
	const client = record.session.cdpClient;
	const manager = record.session.sessionManager;
	if (client === null || manager === null) return;
	try {
		const cdp = await manager.getOrCreateCdpSession(targetId, false);
		await client.send.Emulation.setDeviceMetricsOverride(deviceMetrics(viewport), cdp.sessionId as SessionId);
	} catch {
		// Cosmetic per tab, exactly as the vendored profile path treats it.
	}
}

/** One emulation override the session can be asked for, and whether it took. */
export interface EmulationRequest {
	readonly locale?: string;
	readonly timezone?: string;
	readonly user_agent?: string;
}

/**
 * Applies the locale, timezone and user-agent overrides that this deployment can apply.
 *
 * Each is attempted independently and reported independently, because they fail independently: an
 * unknown IANA timezone is refused by Chromium while a locale beside it is accepted, and a tool that
 * reported one verdict for three calls would be wrong about at least one of them on some input.
 */
export async function applyEmulation(
	record: SessionRecord,
	request: EmulationRequest,
): Promise<{ applied: Record<string, unknown>; unsupported: string[] }> {
	const wanted = (['locale', 'timezone', 'user_agent'] as const).filter((field) => request[field] !== undefined);
	const applied: Record<string, unknown> = {};
	const unsupported: string[] = [];
	if (wanted.length === 0) return { applied, unsupported };

	// A session with no live CDP client cannot take an override, and that is exactly what
	// `unsupported` is for: `browser_set_session_options` reports per field rather than failing the
	// whole call, so an `idle_timeout_s` beside a locale still applies. Throwing here would make the
	// tool's own contract — "what took effect, and what did not" — unreachable in the one case where
	// the answer is most obviously "it did not".
	let client;
	let manager;
	let focus;
	try {
		({ client, manager, focus } = connected(record.session));
	} catch {
		return { applied, unsupported: [...wanted] };
	}
	const page = await manager.getOrCreateCdpSession(focus as TargetId, true);

	const attempt = async (field: string, value: unknown, send: () => Promise<unknown>): Promise<void> => {
		try {
			await send();
			applied[field] = value;
		} catch {
			unsupported.push(field);
		}
	};

	if (request.timezone !== undefined) {
		await attempt(
			'timezone',
			request.timezone,
			() => client.send.Emulation.setTimezoneOverride({ timezoneId: request.timezone as string }, page.sessionId),
		);
	}

	// `locale` and `user_agent` share one dispatch, because **`Emulation.setLocaleOverride` alone does
	// not move `navigator.language`.** Measured on real Chromium: after `setLocaleOverride('fr-FR')`
	// the page still reported `navigator.language === 'en-GB'`. That command changes ICU's resolution —
	// `Intl.DateTimeFormat`, collation, number formatting — while `navigator.language` and the
	// `Accept-Language` header come from the browser's own locale, which is moved by
	// `setUserAgentOverride`'s `acceptLanguage`. A caller that asks for a French session and gets a
	// French `Intl` beside an English `navigator.language` has a session no real French user has, and
	// a page that branches on `navigator.language` would serve it the wrong content — so both are set.
	//
	// The user agent itself must be supplied to that command, so when only a locale was asked for the
	// page's **current** agent is read and sent back unchanged. Both halves are reported under the
	// field the caller named: a failure to move the language is a failure of `locale`, not of a
	// `user_agent` the caller never mentioned.
	if (request.locale !== undefined || request.user_agent !== undefined) {
		let userAgent = request.user_agent;
		if (userAgent === undefined) {
			try {
				const current = await client.send.Runtime.evaluate(
					{ expression: 'navigator.userAgent', returnByValue: true },
					page.sessionId,
				);
				userAgent = typeof current.result.value === 'string' ? current.result.value : undefined;
			} catch {
				userAgent = undefined;
			}
		}
		const send = async (): Promise<void> => {
			if (userAgent === undefined) throw new Error('the page did not report its user agent');
			await client.send.Emulation.setUserAgentOverride(
				request.locale === undefined ? { userAgent } : { userAgent, acceptLanguage: request.locale },
				page.sessionId,
			);
			if (request.locale !== undefined) {
				await client.send.Emulation.setLocaleOverride({ locale: request.locale }, page.sessionId);
			}
		};
		let ok = true;
		try {
			await send();
		} catch {
			ok = false;
		}
		for (const field of ['locale', 'user_agent'] as const) {
			if (request[field] === undefined) continue;
			if (ok) applied[field] = request[field];
			else unsupported.push(field);
		}
	}
	return { applied, unsupported };
}
