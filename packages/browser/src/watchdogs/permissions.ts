/**
 * @module
 * `PermissionsWatchdog` — browser-wide permission grants on connect (ARCHITECTURE.md §6.5).
 *
 * > on `BrowserConnectedEvent`, grants `profile.permissions` (default `clipboardReadWrite`,
 * > `notifications`) browser-wide via `Browser.grantPermissions`; failures are logged, non-fatal.
 *
 * The point of the grant is to make permission *prompts* impossible. A clipboard or notification
 * prompt is a modal the agent cannot see in the DOM and cannot dismiss with a click; pre-granting
 * removes the class. The point of it being non-fatal is that the grant is an ergonomic improvement,
 * not a precondition: a Chrome build that refuses one of the permission names, or a remote/cloud
 * endpoint that does not expose `Browser.grantPermissions` at all, must still yield a working
 * session. `BrowserConnectedEvent` is awaited by `start()` (§6.9 note), so throwing here would fail
 * the whole start for a nicety.
 *
 * No origin and no `browserContextId` are sent — both are optional in CDP and omitting them is what
 * "browser-wide" means (every origin in the default context).
 */

import type { HandlerContext } from '@tykotech/bus';
import { BrowserConnectedEvent } from '../events.ts';
import { BaseWatchdog } from './base.ts';

export class PermissionsWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [BrowserConnectedEvent];
	static override readonly EMITS = [];

	#granted: readonly string[] | null = null;
	#lastError: string | null = null;

	// -- public surface ----------------------------------------------------------------------------

	/** What was granted on the most recent successful grant, or `null` if none has succeeded. */
	get grantedPermissions(): readonly string[] | null {
		return this.#granted;
	}

	/** The most recent grant failure, rendered; `null` when the last attempt worked or was skipped. */
	get lastError(): string | null {
		return this.#lastError;
	}

	// -- handlers ----------------------------------------------------------------------------------

	/** Non-fatal by construction: the result is data, never a throw. */
	async onBrowserConnectedEvent(_event: BrowserConnectedEvent, context?: HandlerContext): Promise<void> {
		await this.grantConfiguredPermissions(context);
	}

	/**
	 * Grants `profile.permissions` browser-wide.
	 *
	 * @returns `true` when Chrome acknowledged the grant, `false` when it failed or there was nothing
	 * configured to grant. Never throws.
	 */
	async grantConfiguredPermissions(context?: HandlerContext): Promise<boolean> {
		const permissions = [...this.profile.permissions];
		if (permissions.length === 0) {
			// An explicitly empty list is a valid configuration ("grant nothing"), not an error.
			this.logger.debug('no permissions configured; skipping the browser-wide grant', {});
			this.#lastError = null;
			return false;
		}
		try {
			await this.cdpFor(context).send.Browser.grantPermissions({ permissions });
			this.#granted = permissions;
			this.#lastError = null;
			this.logger.debug('granted browser-wide permissions', { permissions });
			return true;
		} catch (error) {
			this.#lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.logger.warn('browser-wide permission grant failed; continuing without it (non-fatal, §6.5)', {
				permissions,
				error,
			});
			return false;
		}
	}
}
