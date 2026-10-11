/**
 * Active or idle (Sessions › Sessions): which group a browser session is listed in, how long it has been idle and
 * when the reaper closes it, and the share of a limit a figure takes. Pure — the screen reads it, the tests pin it.
 */
import type { SessionSummary, SystemMemory } from './api.ts';

/** A session used within this many seconds is active, however nobody watches it. */
export const ACTIVE_WINDOW_S = 300;

export interface Activity {
	readonly active: boolean;
	/** Seconds since its last tool call or viewer action. */
	readonly idleSeconds: number;
	/** Seconds until the idle reaper closes it; `null` while a viewer holds it open (it is never reaped then). */
	readonly closesIn: number | null;
	/** Why it is in its group, in words: the tooltip of its state. */
	readonly reason: string;
}

/**
 * A session is active while a person watches it or holds its control, or within {@linkcode ACTIVE_WINDOW_S} of its last
 * use; otherwise idle. The idle time is the server's own (`memory`) when known, else from `last_used_at` and `now`.
 */
export function activityOf(
	session: Pick<SessionSummary, 'viewer_count' | 'human_has_control' | 'last_used_at'>,
	memory: Pick<SystemMemory['sessions'][number], 'idle_seconds' | 'idle_timeout_s'> | undefined,
	now: number = Date.now(),
): Activity {
	const lastUsed = Date.parse(session.last_used_at);
	const idleSeconds = memory?.idle_seconds ??
		(Number.isFinite(lastUsed) ? Math.max(0, Math.round((now - lastUsed) / 1000)) : 0);
	const watched = session.viewer_count > 0;
	const closesIn = watched || memory === undefined ? null : Math.max(0, memory.idle_timeout_s - idleSeconds);
	if (session.human_has_control) return { active: true, idleSeconds, closesIn, reason: 'A person holds control' };
	if (watched) return { active: true, idleSeconds, closesIn, reason: 'Being watched' };
	if (idleSeconds < ACTIVE_WINDOW_S) {
		return { active: true, idleSeconds, closesIn, reason: 'Used in the last 5 minutes' };
	}
	return { active: false, idleSeconds, closesIn, reason: `Idle for ${duration(idleSeconds)}` };
}

/** A span of seconds as people read it: `45 s`, `12 min`, `2 h 5 min`. */
export function duration(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** `part` as a share of `whole`, clamped to 0–1; `0` when either is unknown. */
export function share(part: number | null | undefined, whole: number | null | undefined): number {
	if (part === null || part === undefined || whole === null || whole === undefined || whole <= 0) return 0;
	return Math.min(1, Math.max(0, part / whole));
}

/** How full a meter is, as its tone: calm below 70 %, a warning to 90 %, danger above. */
export function meterTone(fraction: number): 'ok' | 'warn' | 'danger' {
	return fraction >= 0.9 ? 'danger' : fraction >= 0.7 ? 'warn' : 'ok';
}
