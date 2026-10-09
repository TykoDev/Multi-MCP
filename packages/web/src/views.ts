/**
 * The core screens, re-exported from their own modules (D-089 split the former
 * single file): the shell, connect, sessions and the live viewer.
 */
export {
	type Navigate,
	type PageTab,
	renderShell,
	type Section,
	sectionRoute,
	setDockBadge,
	type ShellOptions,
} from './shell.ts';
export { connectView } from './connect_view.ts';
export { sessionsView } from './sessions_view.ts';
export { nextRetryDelayMs, RECOVERY_WINDOW_MS, viewerView } from './viewer_view.ts';
// The System screen is a lazy chunk; `app.ts` imports `system_view.ts` itself.
