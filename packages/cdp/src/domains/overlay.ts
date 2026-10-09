/**
 * CDP `Overlay` domain — the server-drawn highlight, and nothing else.
 *
 * ERRATUM(E-46). A sixteenth typed domain, added for `live.highlight` (B2.2; `report_architecture.md`
 * §8.2). The DevTools overlay draws **outside the document**: an `Overlay.highlightRect` or
 * `highlightNode` never mutates the DOM, so a highlight cannot churn `state_token`, cannot appear in
 * `browser_get_state`, and cannot be mistaken for page content — three properties the DOM-injection
 * route (`ScreenshotWatchdog`'s `bua-highlight-container`) would have to buy back with three
 * separate exclusions on the very field B1.4 made load-bearing.
 *
 * **Five of the domain's 31 commands are typed — the three highlight commands and the lifecycle
 * pair — deliberately, and the registry test pins the set.**
 * `Overlay.setInspectMode` is not typed and must not be: in inspect mode a click is consumed by the
 * inspector and turned into an `inspectNodeRequested` event instead of reaching the page, which is a
 * way to silently break the input path this delivery exists to make reliable — and server-side hit
 * testing is `DOM.getNodeForLocation` (`packages/mcp/src/hit_test.ts`), which needs no mode change.
 * The debug-border and diagnostic setters (`setShowDebugBorders`, `setShowPaintRects`,
 * `setShowFPSCounter`, `setShowLayoutShiftRegions`, `setShowHitTestBorders` and their siblings) are
 * not typed either: each paints into the frame the screencast captures and into anything
 * `Page.captureScreenshot` returns. The lifecycle pair `enable`/`disable` **is** typed, because U-7
 * measured that it is required: on real Chromium `Overlay.highlightRect` answers
 * `Overlay must be enabled before a tool can be shown`, and `Overlay.enable` in turn answers
 * `DOM should be enabled first` (`build/evidence/b2_2_u7_overlay_probe.log`). Five commands, then,
 * and `domains_test.ts` pins exactly those five; a method added here later without a decision fails
 * that test rather than arriving unnoticed.
 */

import type { EmptyResult, NodeId, NoParams, RemoteObjectId } from './common.ts';

/** `DOM.RGBA`: 0–255 channels, `a` in 0–1 and optional (opaque when absent). */
export interface RGBA {
	r: number;
	g: number;
	b: number;
	a?: number;
}

/** `Overlay.HighlightConfig` — only the colour fields a highlight needs; the diagnostic fields are omitted on purpose. */
export interface HighlightConfig {
	showInfo?: boolean;
	showStyles?: boolean;
	showRulers?: boolean;
	showExtensionLines?: boolean;
	contentColor?: RGBA;
	paddingColor?: RGBA;
	borderColor?: RGBA;
	marginColor?: RGBA;
}

export interface OverlayParams {
	/** Requires `DOM.enable` on the same session first (measured, U-7). */
	'Overlay.enable': NoParams;
	'Overlay.disable': NoParams;
	'Overlay.hideHighlight': NoParams;
	'Overlay.highlightNode': {
		highlightConfig: HighlightConfig;
		nodeId?: NodeId;
		backendNodeId?: number;
		objectId?: RemoteObjectId;
		selector?: string;
	};
	'Overlay.highlightRect': {
		x: number;
		y: number;
		width: number;
		height: number;
		color?: RGBA;
		outlineColor?: RGBA;
	};
}

export interface OverlayResults {
	'Overlay.enable': EmptyResult;
	'Overlay.disable': EmptyResult;
	'Overlay.hideHighlight': EmptyResult;
	'Overlay.highlightNode': EmptyResult;
	'Overlay.highlightRect': EmptyResult;
}

/** `Overlay` contributes no events here: `inspectNodeRequested` belongs to the mode this module refuses to type. */
export type OverlayEvents = Record<never, never>;

export const OVERLAY_METHODS = [
	'disable',
	'enable',
	'hideHighlight',
	'highlightNode',
	'highlightRect',
] as const;
