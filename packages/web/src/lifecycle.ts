/**
 * Screen lifecycle: what to tear down when a screen is replaced, and what to forget when the credential changes.
 * The router runs every teardown before it renders, whatever caused the render: a click on the current route
 * re-renders with no hash change, and a screen that only listened for `hashchange` would leak its pollers and sockets.
 */

const leaving: Array<() => void> = [];
const signOutHooks: Array<() => void> = [];

/** Registers teardown for the screen being rendered; it runs once, when that screen is replaced. */
export function onLeave(teardown: () => void): void {
	leaving.push(teardown);
}

/** Runs and forgets every pending teardown; one that throws does not keep the others from running. */
export function leaveScreen(): void {
	for (const teardown of leaving.splice(0)) {
		try {
			teardown();
		} catch {
			// The next screen must still render.
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
			// Best-effort per hook; the others must still run.
		}
	}
}
