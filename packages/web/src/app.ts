/**
 * SPA entry point and hash router (bundled as `dist/app.js`).
 *
 * Routes: `#/connect`, `#/sessions`, `#/view/:sessionId`, `#/workspaces[/:id]`, `#/resources[/:path]`,
 * `#/agents[/chat/:task | /surfaces]`, `#/users`, `#/system[/agents | /config]`. Every route but connect needs a
 * sign-in; the cookie is checked with the server at load, so a reload lands where it was. Connect, Sessions and the
 * Live View are in the entry; every other screen is a lazy chunk with its stylesheet.
 */
// First, before any chunk builds a schema: Zod's `new Function` probe is a CSP report under the page policy.
import './jitless.ts';
import { isSignedIn, loadUser, onUnauthorized, restoreSession } from './api.ts';
import { connectView } from './connect_view.ts';
import { leaveScreen, signOut } from './lifecycle.ts';
import { sessionsView } from './sessions_view.ts';
import { withSheets } from './styles.ts';
import { initTheme } from './theme.ts';
import { messageOf, toast } from './ui.ts';
import { viewerView } from './viewer_view.ts';

function navigate(route: string): void {
	if (location.hash === route) render();
	else location.hash = route;
}

/** The decoded remainder of `hash` after `prefix`, or `undefined` when empty or malformed. */
function param(hash: string, prefix: string): string | undefined {
	const rest = hash.slice(prefix.length);
	if (rest === '') return undefined;
	try {
		return decodeURIComponent(rest);
	} catch {
		return undefined;
	}
}

/** Bumped by every render, so a lazy screen that arrives after a newer navigation is dropped, not painted. */
let renderSeq = 0;

function lazy<M>(load: () => Promise<M>, show: (module: M) => void): void {
	const ticket = renderSeq;
	// After a reload only the cookie is known; a screen that reads the scopes needs the user first.
	Promise.all([load(), loadUser()]).then(([module]) => {
		if (ticket === renderSeq) show(module);
	}).catch((cause) => {
		// A chunk that cannot load (a redeploy replaced it) leaves the old screen torn down: say so.
		if (ticket === renderSeq) toast(`This screen could not load: ${messageOf(cause)}. Reload the page.`, 'error');
	});
}

function under(hash: string, base: string): boolean {
	return hash === base || hash.startsWith(`${base}/`);
}

function render(): void {
	renderSeq += 1;
	// Whatever triggered this render — a hash change or a click on the current route — the old screen stops first.
	leaveScreen();
	const hash = location.hash || '#/connect';
	if (!isSignedIn() && hash !== '#/connect') {
		navigate('#/connect');
		return;
	}
	if (hash.startsWith('#/view/')) viewerView(param(hash, '#/view/') ?? 'default', navigate);
	else if (hash === '#/sessions') sessionsView(navigate);
	else if (under(hash, '#/workspaces')) {
		lazy(
			() => withSheets(import('./workspaces_view.ts'), 'workspaces'),
			({ workspacesView }) => workspacesView(navigate, param(hash, '#/workspaces/')),
		);
	} else if (under(hash, '#/resources')) {
		lazy(
			() => withSheets(import('./resources_view.ts'), 'resources'),
			({ resourcesView }) => resourcesView(navigate, param(hash, '#/resources/') ?? ''),
		);
	} else if (under(hash, '#/agents')) {
		lazy(
			() => withSheets(import('./agent_view.ts'), 'agents'),
			({ agentView }) => agentView(navigate, hash),
		);
	} else if (hash === '#/users') {
		lazy(() => withSheets(import('./users_view.ts'), 'users'), ({ usersView }) => usersView(navigate));
	} else if (under(hash, '#/system')) {
		lazy(
			() => withSheets(import('./system_view.ts'), 'system'),
			({ systemView }) => systemView(navigate, param(hash, '#/system/')),
		);
	} else connectView(navigate);
}

// A session the server no longer honours ends here: credential-bound caches go, and the connect screen explains.
onUnauthorized(() => {
	signOut();
	navigate('#/connect');
});
initTheme();
// The kit is its own chunks, fetched in parallel with the sign-in check, so the entry stays within its budget.
await Promise.all([restoreSession(), import('./kit.ts'), import('./kit_overlay.ts'), import('./kit_forms.ts')]);
globalThis.addEventListener('hashchange', render);
render();
