/**
 * CDP `Browser` domain — version handshake, permissions, downloads, window bounds.
 *
 * Feeds PermissionsWatchdog (`grantPermissions` on connect — SPECS/ARCHITECTURE.md §6.5) and the
 * DownloadsWatchdog pipeline (`setDownloadBehavior` + `downloadWillBegin`/`downloadProgress` — §6.8,
 * mapping onto `DownloadStartedEvent`/`DownloadProgressEvent` in SPECS/DATA-MODEL.md §5.1.6).
 */

import type { BrowserContextId, EmptyResult, NoParams, Rect, TargetId, WindowId } from './common.ts';

/** `Browser.PermissionType`. Profile default is `['clipboardReadWrite', 'notifications']`. */
export type PermissionType =
	| 'accessibilityEvents'
	| 'audioCapture'
	| 'backgroundSync'
	| 'backgroundFetch'
	| 'clipboardReadWrite'
	| 'clipboardSanitizedWrite'
	| 'displayCapture'
	| 'durableStorage'
	| 'geolocation'
	| 'idleDetection'
	| 'localFonts'
	| 'midi'
	| 'midiSysex'
	| 'nfc'
	| 'notifications'
	| 'paymentHandler'
	| 'periodicBackgroundSync'
	| 'protectedMediaIdentifier'
	| 'sensors'
	| 'storageAccess'
	| 'topLevelStorageAccess'
	| 'videoCapture'
	| 'videoCapturePanTiltZoom'
	| 'wakeLockScreen'
	| 'wakeLockSystem'
	| 'windowManagement'
	| (string & Record<never, never>);

/** `Browser.Bounds`. */
export interface WindowBounds {
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	windowState?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
}

/** `Browser.DownloadProgress.state`. */
export type DownloadState = 'inProgress' | 'completed' | 'canceled';

export interface BrowserParams {
	/**
	 * ERRATUM(E-33). Added to the typed surface for the download transfer limits (ARCHITECTURE.md §6.8):
	 * a download that outgrows its per-file or per-session budget, or outlives its transfer deadline,
	 * is cancelled by guid rather than left to fill the disk. Experimental in the protocol; the
	 * watchdog treats a failure as "the browser kept going" and still refuses to publish the file.
	 */
	'Browser.cancelDownload': { guid: string; browserContextId?: BrowserContextId };
	'Browser.close': NoParams;
	'Browser.getVersion': NoParams;
	'Browser.getWindowForTarget': { targetId?: TargetId };
	'Browser.getWindowBounds': { windowId: WindowId };
	'Browser.grantPermissions': {
		permissions: PermissionType[];
		origin?: string;
		browserContextId?: BrowserContextId;
	};
	'Browser.resetPermissions': { browserContextId?: BrowserContextId };
	'Browser.setDownloadBehavior': {
		behavior: 'deny' | 'allow' | 'allowAndName' | 'default';
		browserContextId?: BrowserContextId;
		downloadPath?: string;
		/** MUST be `true` for `downloadWillBegin`/`downloadProgress` to fire. */
		eventsEnabled?: boolean;
	};
	'Browser.setWindowBounds': { windowId: WindowId; bounds: WindowBounds };
}

export interface BrowserResults {
	'Browser.cancelDownload': EmptyResult;
	'Browser.close': EmptyResult;
	'Browser.getVersion': {
		protocolVersion: string;
		product: string;
		revision: string;
		userAgent: string;
		jsVersion: string;
	};
	'Browser.getWindowForTarget': { windowId: WindowId; bounds: WindowBounds };
	'Browser.getWindowBounds': { bounds: WindowBounds };
	'Browser.grantPermissions': EmptyResult;
	'Browser.resetPermissions': EmptyResult;
	'Browser.setDownloadBehavior': EmptyResult;
	'Browser.setWindowBounds': EmptyResult;
}

export interface BrowserEvents {
	'Browser.downloadWillBegin': { frameId: string; guid: string; url: string; suggestedFilename: string };
	'Browser.downloadProgress': {
		guid: string;
		totalBytes: number;
		receivedBytes: number;
		state: DownloadState;
		filePath?: string;
	};
}

/** Re-exported so `@tykotech/browser` can bound a viewport clip without redeclaring the shape. */
export type BrowserWindowRect = Rect;

export const BROWSER_METHODS = [
	'cancelDownload',
	'close',
	'getVersion',
	'getWindowBounds',
	'getWindowForTarget',
	'grantPermissions',
	'resetPermissions',
	'setDownloadBehavior',
	'setWindowBounds',
] as const;
