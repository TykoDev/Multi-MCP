/**
 * Screen lifecycle: what to tear down when a screen is replaced, and what to
 * forget when the credential changes.
 *
 * Screens used to tear themselves down on `hashchange`, but the router also
 * re-renders a route *without* a hash change — clicking the rail item for the
 * screen already open calls `navigate` with the current hash. That re-render
 * replaced the DOM and left the old screen's work running: the Agents poller
 * (two requests every three seconds, against a 120-per-minute budget) and the
 * Live View socket, canvas and reconnect loop. The router now runs every
 * registered teardown before it renders anything, whatever caused the render.
 */

const leaving: Array<() => void> = [];
const signOutHooks: Array<() => void> = [];

/** Registers teardown for the screen being rendered; it runs once, when that screen is replaced. */
export function onLeave(teardown: () => void): void {
	leaving.push(teardown);
}

/** Runs and forgets every pending teardown. Called by the router before each render. */
export function leaveScreen(): void {
	for (const teardown of leaving.splice(0)) {
		try {
			teardown();
		} catch {
			// One screen's failed teardown must not keep the next screen from rendering.
		}
	}
}

/** Registers state that belongs to one credential and must not outlive it. */
export function onSignOut(forget: () => void): void {
	signOutHooks.push(forget);
}

/** Forgets every credential-bound cache: on sign-out, and before a new credential is used. */
export function signOut(): void {
	for (const forget of signOutHooks) {
		try {
			forget();
		} catch {
			// Forgetting is best-effort per hook; the others must still run.
		}
	}
}
