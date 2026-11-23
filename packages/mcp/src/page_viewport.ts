/** Viewport and emulation overrides for one session. */
import type { BrowserSession } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import type { SessionRecord } from './registry.ts';

/** The viewport a session is currently emulating. */
export interface Viewport {
	readonly width: number;
	readonly height: number;
	readonly device_scale: number;
}

/** The exact parameter object sent to `Emulation.setDeviceMetricsOverride` — **never a `scale` key**. */
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

/** Applies a viewport to **every** tab of the session, and records it on the session record. */
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
interface EmulationRequest {
	readonly locale?: string;
	readonly timezone?: string;
	readonly user_agent?: string;
}

/** Applies the locale, timezone and user-agent overrides that this deployment can apply. */
export async function applyEmulation(
	record: SessionRecord,
	request: EmulationRequest,
): Promise<{ applied: Record<string, unknown>; unsupported: string[] }> {
	const wanted = (['locale', 'timezone', 'user_agent'] as const).filter((field) => request[field] !== undefined);
	const applied: Record<string, unknown> = {};
	const unsupported: string[] = [];
	if (wanted.length === 0) return { applied, unsupported };

	// A session with no live CDP client cannot take an override, and that is exactly what
	// `unsupported` is for: `browser_set_session_options` reports per field rather than failing the whole call, so an
	// `idle_timeout_s` beside a locale still applies.
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

	// `locale` and `user_agent` share one dispatch, because
	// **`Emulation.setLocaleOverride` alone does not move `navigator.language`.** Measured on real Chromium: after
	// `setLocaleOverride('fr-FR')` the page still reported `navigator.language === 'en-GB'`.
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
