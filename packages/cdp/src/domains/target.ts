/**
 * CDP `Target` domain — discovery, attach/detach, browser contexts.
 *
 * Drives the SessionManager contract in SPECS/ARCHITECTURE.md §7.3: push-based discovery via
 * `setDiscoverTargets`, flat-session attach via `attachToTarget({flatten: true})`, cascading
 * OOPIF/worker attach via per-session `setAutoAttach`.
 */

import type { BrowserContextId, EmptyResult, SessionId, TargetId } from './common.ts';

/** `Target.TargetInfo`. */
export interface TargetInfo {
	targetId: TargetId;
	/** `page`, `iframe`, `worker`, `service_worker`, `browser`, `other`, … */
	type: string;
	title: string;
	url: string;
	attached: boolean;
	openerId?: TargetId;
	canAccessOpener?: boolean;
	openerFrameId?: string;
	browserContextId?: BrowserContextId;
	subtype?: string;
}

/** `Target.FilterEntry` — `{type, exclude?}`; an empty filter means "everything". */
export interface TargetFilterEntry {
	type?: string;
	exclude?: boolean;
}

export interface TargetParams {
	'Target.activateTarget': { targetId: TargetId };
	'Target.attachToTarget': { targetId: TargetId; flatten?: boolean };
	'Target.closeTarget': { targetId: TargetId };
	'Target.createBrowserContext': {
		disposeOnDetach?: boolean;
		proxyServer?: string;
		proxyBypassList?: string;
		originsWithUniversalNetworkAccess?: string[];
	};
	'Target.createTarget': {
		url: string;
		width?: number;
		height?: number;
		browserContextId?: BrowserContextId;
		enableBeginFrameControl?: boolean;
		newWindow?: boolean;
		background?: boolean;
		forTab?: boolean;
	};
	'Target.detachFromTarget': { sessionId?: SessionId; targetId?: TargetId };
	'Target.disposeBrowserContext': { browserContextId: BrowserContextId };
	'Target.getBrowserContexts': Record<never, never>;
	'Target.getTargetInfo': { targetId?: TargetId };
	'Target.getTargets': { filter?: TargetFilterEntry[] };
	'Target.setAutoAttach': {
		autoAttach: boolean;
		waitForDebuggerOnStart: boolean;
		flatten?: boolean;
		filter?: TargetFilterEntry[];
	};
	'Target.setDiscoverTargets': { discover: boolean; filter?: TargetFilterEntry[] };
}

export interface TargetResults {
	'Target.activateTarget': EmptyResult;
	'Target.attachToTarget': { sessionId: SessionId };
	'Target.closeTarget': { success?: boolean };
	'Target.createBrowserContext': { browserContextId: BrowserContextId };
	'Target.createTarget': { targetId: TargetId };
	'Target.detachFromTarget': EmptyResult;
	'Target.disposeBrowserContext': EmptyResult;
	'Target.getBrowserContexts': { browserContextIds: BrowserContextId[] };
	'Target.getTargetInfo': { targetInfo: TargetInfo };
	'Target.getTargets': { targetInfos: TargetInfo[] };
	'Target.setAutoAttach': EmptyResult;
	'Target.setDiscoverTargets': EmptyResult;
}

export interface TargetEvents {
	'Target.attachedToTarget': { sessionId: SessionId; targetInfo: TargetInfo; waitingForDebugger: boolean };
	'Target.detachedFromTarget': { sessionId: SessionId; targetId?: TargetId };
	'Target.receivedMessageFromTarget': { sessionId: SessionId; message: string; targetId?: TargetId };
	'Target.targetCrashed': { targetId: TargetId; status: string; errorCode: number };
	'Target.targetCreated': { targetInfo: TargetInfo };
	'Target.targetDestroyed': { targetId: TargetId };
	'Target.targetInfoChanged': { targetInfo: TargetInfo };
}

export const TARGET_METHODS = [
	'activateTarget',
	'attachToTarget',
	'closeTarget',
	'createBrowserContext',
	'createTarget',
	'detachFromTarget',
	'disposeBrowserContext',
	'getBrowserContexts',
	'getTargetInfo',
	'getTargets',
	'setAutoAttach',
	'setDiscoverTargets',
] as const;
