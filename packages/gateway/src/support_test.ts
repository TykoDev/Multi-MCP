/** Helpers the gateway's unit tests share. */
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { createLogger, type Logger } from './logger.ts';

/** A browser session that holds nothing and stops at once; `bus: false` leaves it without an event bus. */
export function fakeSession(bus = true): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: bus ? new EventBus({ name: 'fake-session' }) : undefined,
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

/** A fresh directory under `tests/.scratch`. */
export async function scratch(prefix = 'gateway-'): Promise<string> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	return await Deno.makeTempDir({ dir: 'tests/.scratch', prefix });
}

/** A logger that writes nothing. */
export const quiet = (): Logger => createLogger({ level: 'error', write: () => {} });
