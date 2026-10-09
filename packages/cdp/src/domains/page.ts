/**
 * CDP `Page` domain — navigation, lifecycle, capture, dialogs, screencast.
 *
 * Feeds the navigation readiness model (SPECS/ARCHITECTURE.md §7.5: `loaderId`-keyed lifecycle
 * events, same-document detection), ScreenshotWatchdog (§6.6), PopupsWatchdog (§6.4),
 * RecordingWatchdog (§6.12) and the print-dialog→`printToPDF` interception (§6.10).
 */

import type { EmptyResult, ExecutionContextId, FrameId, LoaderId, NoParams, Rect } from './common.ts';

/** `Page.Frame`. */
export interface Frame {
	id: FrameId;
	parentId?: FrameId;
	loaderId: LoaderId;
	name?: string;
	url: string;
	urlFragment?: string;
	domainAndRegistry?: string;
	securityOrigin: string;
	mimeType: string;
	unreachableUrl?: string;
	adFrameStatus?: Record<string, unknown>;
	secureContextType?: string;
	crossOriginIsolatedContextType?: string;
	gatedAPIFeatures?: string[];
}

/** `Page.FrameTree`. */
export interface FrameTree {
	frame: Frame;
	childFrames?: FrameTree[];
}

/** `Page.Viewport` — clip rect plus scale, in CSS px. */
export interface PageViewport extends Rect {
	scale: number;
}

/** `Page.LayoutViewport`. */
export interface LayoutViewport {
	pageX: number;
	pageY: number;
	clientWidth: number;
	clientHeight: number;
}

/** `Page.VisualViewport`. */
export interface VisualViewport {
	offsetX: number;
	offsetY: number;
	pageX: number;
	pageY: number;
	clientWidth: number;
	clientHeight: number;
	scale: number;
	zoom?: number;
}

/** `Page.NavigationEntry`. */
export interface NavigationEntry {
	id: number;
	url: string;
	userTypedURL: string;
	title: string;
	transitionType: string;
}

/** `Page.ScreencastFrameMetadata`. */
export interface ScreencastFrameMetadata {
	offsetTop: number;
	pageScaleFactor: number;
	deviceWidth: number;
	deviceHeight: number;
	scrollOffsetX: number;
	scrollOffsetY: number;
	timestamp?: number;
}

/** Lifecycle event names the readiness poller accepts (ARCHITECTURE §7.5 step 4). */
export type PageLifecycleName =
	| 'init'
	| 'firstPaint'
	| 'firstContentfulPaint'
	| 'firstMeaningfulPaint'
	| 'firstImagePaint'
	| 'DOMContentLoaded'
	| 'load'
	| 'networkAlmostIdle'
	| 'networkIdle'
	| 'commit'
	// Keeps literal autocomplete while still accepting names Chrome adds later.
	| (string & Record<never, never>);

export interface PageParams {
	'Page.addScriptToEvaluateOnNewDocument': {
		source: string;
		worldName?: string;
		includeCommandLineAPI?: boolean;
		runImmediately?: boolean;
	};
	'Page.bringToFront': NoParams;
	'Page.captureScreenshot': {
		format?: 'jpeg' | 'png' | 'webp';
		quality?: number;
		clip?: PageViewport;
		fromSurface?: boolean;
		captureBeyondViewport?: boolean;
		optimizeForSpeed?: boolean;
	};
	'Page.close': NoParams;
	'Page.createIsolatedWorld': { frameId: FrameId; worldName?: string; grantUniveralAccess?: boolean };
	'Page.disable': NoParams;
	'Page.enable': NoParams;
	'Page.getFrameTree': NoParams;
	'Page.getLayoutMetrics': NoParams;
	'Page.getNavigationHistory': NoParams;
	'Page.handleJavaScriptDialog': { accept: boolean; promptText?: string };
	'Page.navigate': {
		url: string;
		referrer?: string;
		/** BrowserSession always sends `address_bar` (ARCHITECTURE §7.5 step 1). */
		transitionType?: string;
		frameId?: FrameId;
		referrerPolicy?: string;
	};
	'Page.navigateToHistoryEntry': { entryId: number };
	'Page.printToPDF': {
		landscape?: boolean;
		displayHeaderFooter?: boolean;
		printBackground?: boolean;
		scale?: number;
		paperWidth?: number;
		paperHeight?: number;
		marginTop?: number;
		marginBottom?: number;
		marginLeft?: number;
		marginRight?: number;
		pageRanges?: string;
		headerTemplate?: string;
		footerTemplate?: string;
		preferCSSPageSize?: boolean;
		transferMode?: 'ReturnAsBase64' | 'ReturnAsStream';
		generateTaggedPDF?: boolean;
	};
	'Page.reload': { ignoreCache?: boolean; scriptToEvaluateOnLoad?: string };
	'Page.removeScriptToEvaluateOnNewDocument': { identifier: string };
	'Page.screencastFrameAck': { sessionId: number };
	'Page.setBypassCSP': { enabled: boolean };
	'Page.setInterceptFileChooserDialog': { enabled: boolean };
	'Page.setLifecycleEventsEnabled': { enabled: boolean };
	'Page.startScreencast': {
		format?: 'jpeg' | 'png';
		quality?: number;
		maxWidth?: number;
		maxHeight?: number;
		everyNthFrame?: number;
	};
	'Page.stopLoading': NoParams;
	'Page.stopScreencast': NoParams;
}

export interface PageResults {
	'Page.addScriptToEvaluateOnNewDocument': { identifier: string };
	'Page.bringToFront': EmptyResult;
	'Page.captureScreenshot': { data: string };
	'Page.close': EmptyResult;
	'Page.createIsolatedWorld': { executionContextId: ExecutionContextId };
	'Page.disable': EmptyResult;
	'Page.enable': EmptyResult;
	'Page.getFrameTree': { frameTree: FrameTree };
	'Page.getLayoutMetrics': {
		layoutViewport: LayoutViewport;
		visualViewport: VisualViewport;
		contentSize: Rect;
		cssLayoutViewport?: LayoutViewport;
		cssVisualViewport?: VisualViewport;
		cssContentSize?: Rect;
	};
	'Page.getNavigationHistory': { currentIndex: number; entries: NavigationEntry[] };
	'Page.handleJavaScriptDialog': EmptyResult;
	/** No `loaderId` ⇒ same-document navigation; `errorText` is a hard error (ARCHITECTURE §7.5). */
	'Page.navigate': { frameId: FrameId; loaderId?: LoaderId; errorText?: string };
	'Page.navigateToHistoryEntry': EmptyResult;
	'Page.printToPDF': { data: string; stream?: string };
	'Page.reload': EmptyResult;
	'Page.removeScriptToEvaluateOnNewDocument': EmptyResult;
	'Page.screencastFrameAck': EmptyResult;
	'Page.setBypassCSP': EmptyResult;
	'Page.setInterceptFileChooserDialog': EmptyResult;
	'Page.setLifecycleEventsEnabled': EmptyResult;
	'Page.startScreencast': EmptyResult;
	'Page.stopLoading': EmptyResult;
	'Page.stopScreencast': EmptyResult;
}

export interface PageEvents {
	'Page.domContentEventFired': { timestamp: number };
	'Page.fileChooserOpened': { frameId: FrameId; mode: 'selectSingle' | 'selectMultiple'; backendNodeId?: number };
	'Page.frameAttached': { frameId: FrameId; parentFrameId: FrameId; stack?: Record<string, unknown> };
	'Page.frameDetached': { frameId: FrameId; reason?: 'remove' | 'swap' };
	'Page.frameNavigated': { frame: Frame; type?: string };
	'Page.frameStartedLoading': { frameId: FrameId };
	'Page.frameStoppedLoading': { frameId: FrameId };
	'Page.javascriptDialogClosed': { result: boolean; userInput: string };
	/** PopupsWatchdog registers this per new tab (ARCHITECTURE §6.4). */
	'Page.javascriptDialogOpening': {
		url: string;
		message: string;
		type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
		hasBrowserHandler: boolean;
		defaultPrompt?: string;
	};
	/** The single global router the SessionManager keeps per D-CDP2. */
	'Page.lifecycleEvent': { frameId: FrameId; loaderId: LoaderId; name: PageLifecycleName; timestamp: number };
	'Page.loadEventFired': { timestamp: number };
	'Page.navigatedWithinDocument': { frameId: FrameId; url: string };
	'Page.screencastFrame': { data: string; metadata: ScreencastFrameMetadata; sessionId: number };
	'Page.windowOpen': { url: string; windowName: string; windowFeatures: string[]; userGesture: boolean };
}

export const PAGE_METHODS = [
	'addScriptToEvaluateOnNewDocument',
	'bringToFront',
	'captureScreenshot',
	'close',
	'createIsolatedWorld',
	'disable',
	'enable',
	'getFrameTree',
	'getLayoutMetrics',
	'getNavigationHistory',
	'handleJavaScriptDialog',
	'navigate',
	'navigateToHistoryEntry',
	'printToPDF',
	'reload',
	'removeScriptToEvaluateOnNewDocument',
	'screencastFrameAck',
	'setBypassCSP',
	'setInterceptFileChooserDialog',
	'setLifecycleEventsEnabled',
	'startScreencast',
	'stopLoading',
	'stopScreencast',
] as const;
