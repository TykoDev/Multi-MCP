/**
 * SPA entry point and hash router (the bundle entry, emitted as `dist/app.js`).
 *
 * Routes: `#/connect`, `#/sessions`, `#/view/:sessionId`,
 * `#/resources[/:uri | /:group[/:rest]]` (`resources_route.ts` tells the two
 * apart), `#/workspaces[/:id]`, `#/agents`, `#/users`,
 * `#/system[/mcp|/agents|/config]`; `#/library[/:tab]` redirects to
 * `#/resources/:tab` and `#/tools[/:name]` to `#/resources/tools[/:name]` (D-152). Sessions, the viewer and
 * the workspaces are the three tabs of the Sessions section (D-147), each still
 * its own route. Every route but connect requires a sign-in; the sign-in cookie
 * is checked with the server at load (B4, D-097), so a reload lands where it
 * was, and a session the server refuses lands on connect.
 *
 * The component kit (D-089) is defined before the first render, so no screen
 * ever paints an undefined custom element. Connect, Sessions and the viewer are
 * in the entry; every other screen is a lazy chunk (D-069, D-090).
 */
// First, before any chunk builds a schema: Zod's `new Function` probe is a CSP report under the page policy (K-5).
import './jitless.ts';
import { isSignedIn, loadUser, onUnauthorized, restoreSession } from './api.ts';
import { leaveScreen, signOut } from './lifecycle.ts';
import { installPalette } from './palette.ts';
import { initTheme } from './theme.ts';
import { installTooltips, messageOf, toast } from './ui.ts';
import { connectView, sessionsView, viewerView } from './views.ts';

function navigate(route: string): void {
	if (location.hash === route) render();
	else location.hash = route;
}

/** The decoded remainder of `hash` after `prefix`, or `undefined` when empty. */
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

/** Renders a lazily loaded screen unless the route moved on while its chunk was loading. */
function lazy<M>(load: () => Promise<M>, show: (module: M) => void): void {
	const ticket = renderSeq;
	// After a reload only the token is known; a screen that reads the scopes needs the user first.
	Promise.all([load(), loadUser()]).then(([module]) => {
		if (ticket === renderSeq) show(module);
	}).catch((cause) => {
		// A chunk that cannot load (a redeploy replaced it, the network dropped) leaves the previous screen torn down;
		// say so rather than leave it silently inert. A reload fetches the current bundle.
		if (ticket === renderSeq) toast(`This screen could not load: ${messageOf(cause)}. Reload the page.`, 'error');
	});
}

function render(): void {
	renderSeq += 1;
	// Whatever triggered this render — a hash change or a click on the current
	// route — the screen being replaced stops its work first (G-1).
	leaveScreen();
	const hash = location.hash || '#/connect';

	if (!isSignedIn() && hash !== '#/connect') {
		navigate('#/connect');
		return;
	}

	if (hash.startsWith('#/view/')) {
		viewerView(param(hash, '#/view/') ?? 'default', navigate);
		return;
	}
	if (hash === '#/sessions') {
		sessionsView(navigate);
		return;
	}
	// D-152: the Tools console is absorbed by Resources — every tool is a leaf of the one tree, beside the resources of
	// the server it belongs to. The old route still answers, without a history entry; the name passes through as it is.
	if (hash === '#/tools' || hash.startsWith('#/tools/')) {
		const name = hash.slice('#/tools/'.length);
		location.replace('#/resources/tools' + (name === '' ? '' : `/${name}`));
		return;
	}
	if (hash === '#/resources' || hash.startsWith('#/resources/')) {
		lazy(
			() => import('./resources_view.ts'),
			({ resourcesView }) => resourcesView(navigate, param(hash, '#/resources/')),
		);
		return;
	}
	if (hash === '#/agents') {
		lazy(() => import('./agent_view.ts'), ({ agentView }) => agentView(navigate));
		return;
	}
	if (hash === '#/users') {
		lazy(() => import('./users_view.ts'), ({ usersView }) => usersView(navigate));
		return;
	}
	// The Library screen is absorbed by Resources: its tabs are the Files, Skills and Prompts groups of the one tree.
	// `replace` rewrites the fragment without a history entry, so Back does not bounce through the old route; the
	// hashchange it raises renders the Resources route. The tab is passed through undecoded: it is already a fragment.
	if (hash === '#/library' || hash.startsWith('#/library/')) {
		const tab = hash.slice('#/library/'.length);
		location.replace('#/resources/' + (tab || 'files'));
		return;
	}
	// The workspace screen is a lazy chunk (D-069): it carries editors and a terminal that most visits never open,
	// and the entry budget is what keeps the connect screen light.
	if (hash === '#/workspaces' || hash.startsWith('#/workspaces/')) {
		lazy(
			() => import('./workspaces_view.ts'),
			({ workspacesView }) => workspacesView(navigate, param(hash, '#/workspaces/')),
		);
		return;
	}
	// D-149: the System screen's three tabs are routes of their own (`#/system`, `#/system/mcp`, `#/system/config`).
	if (hash === '#/system' || hash.startsWith('#/system/')) {
		lazy(() => import('./system_view.ts'), ({ systemView }) => systemView(navigate, param(hash, '#/system/')));
		return;
	}
	connectView(navigate);
}

// A session the server no longer honours ends here: credential-bound caches go, and the connect screen explains.
onUnauthorized(() => {
	signOut();
	navigate('#/connect');
});
initTheme();
installTooltips();
installPalette(navigate);
// Dynamic so the kit is its own chunks, fetched in parallel, and the entry stays within its budget (D-090). The
// sign-in cookie is checked alongside (B4): the first render already knows whether this browser is signed in.
await Promise.all([
	restoreSession(),
	import('./kit.ts'),
	import('./kit_overlay.ts'),
	import('./kit_forms.ts'),
	import('./kit_more.ts'),
]);
globalThis.addEventListener('hashchange', render);
render();
