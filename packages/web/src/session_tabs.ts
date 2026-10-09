/**
 * The Sessions section's views as page tabs (D-147): the browser sessions, the Live View of one of them, and the
 * coding workspaces. They were three dock items; they are one place now, and each keeps its route so a link, Back
 * and a reload still land where they say.
 *
 * The tabs remember where each view last was: the Live View tab returns to the session last watched (not to
 * `default`), and the Workspaces tab to the workspace last open, so moving between the tabs does not lose the place.
 * Module state, reset by nothing but a newer visit: neither id is a credential, and an id that no longer exists is
 * answered by its own screen (the viewer's "does not exist" overlay, the workspace list).
 */
import type { PageTab, ShellOptions } from './shell.ts';

export type SessionTab = 'sessions' | 'view' | 'workspaces';

let watched = 'default';
let workspace: string | null = null;

/** The viewer calls this with the id the ticket resolved, so `default` becomes the session it actually named. */
export function rememberWatched(sessionId: string): void {
	watched = sessionId;
}

/** The workspace now open, or `null` once none is. */
export function rememberWorkspace(workspaceId: string | null): void {
	workspace = workspaceId;
}

/** The tab strip for one of the three views. */
export function sessionTabs(active: SessionTab): NonNullable<ShellOptions['tabs']> {
	const items: PageTab[] = [
		{ id: 'sessions', label: 'Sessions', glyph: 'sessions', route: '#/sessions' },
		{ id: 'view', label: 'Live View', glyph: 'live', route: `#/view/${encodeURIComponent(watched)}` },
		{
			id: 'workspaces',
			label: 'Workspaces',
			glyph: 'workspace',
			route: workspace === null ? '#/workspaces' : `#/workspaces/${encodeURIComponent(workspace)}`,
		},
	];
	return { label: 'Sessions views', items, active };
}
