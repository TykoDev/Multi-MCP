/**
 * CDP `Emulation` domain — device metrics, user agent, locale/timezone/geolocation, media.
 *
 * Implements the viewport half of BrowserProfile's display invariants
 * (SPECS/DATA-MODEL.md §5.2: `noViewport ⇒ viewport === null`; viewport mode ⇒
 * `deviceScaleFactor ≥ 1`), re-applied on `TabCreatedEvent`/`AgentFocusChangedEvent`.
 */

import type { EmptyResult, NoParams } from './common.ts';

/** `Emulation.ScreenOrientation`. */
export interface ScreenOrientation {
	type: 'portraitPrimary' | 'portraitSecondary' | 'landscapePrimary' | 'landscapeSecondary';
	angle: number;
}

/** `Emulation.MediaFeature`. */
export interface MediaFeature {
	name: string;
	value: string;
}

/** `Emulation.UserAgentMetadata` — Client Hints. Typed permissively; Chrome evolves this. */
export interface UserAgentMetadata {
	brands?: { brand: string; version: string }[];
	fullVersionList?: { brand: string; version: string }[];
	platform?: string;
	platformVersion?: string;
	architecture?: string;
	model?: string;
	mobile?: boolean;
	bitness?: string;
	wow64?: boolean;
	fullVersion?: string;
}

export interface EmulationParams {
	'Emulation.clearDeviceMetricsOverride': NoParams;
	'Emulation.clearGeolocationOverride': NoParams;
	'Emulation.setDeviceMetricsOverride': {
		width: number;
		height: number;
		deviceScaleFactor: number;
		mobile: boolean;
		scale?: number;
		screenWidth?: number;
		screenHeight?: number;
		positionX?: number;
		positionY?: number;
		dontSetVisibleSize?: boolean;
		screenOrientation?: ScreenOrientation;
		viewport?: { x: number; y: number; width: number; height: number; scale: number };
	};
	'Emulation.setEmulatedMedia': { media?: string; features?: MediaFeature[] };
	'Emulation.setFocusEmulationEnabled': { enabled: boolean };
	'Emulation.setGeolocationOverride': { latitude?: number; longitude?: number; accuracy?: number };
	'Emulation.setLocaleOverride': { locale?: string };
	'Emulation.setScrollbarsHidden': { hidden: boolean };
	'Emulation.setTimezoneOverride': { timezoneId: string };
	'Emulation.setUserAgentOverride': {
		userAgent: string;
		acceptLanguage?: string;
		platform?: string;
		userAgentMetadata?: UserAgentMetadata;
	};
}

export interface EmulationResults {
	'Emulation.clearDeviceMetricsOverride': EmptyResult;
	'Emulation.clearGeolocationOverride': EmptyResult;
	'Emulation.setDeviceMetricsOverride': EmptyResult;
	'Emulation.setEmulatedMedia': EmptyResult;
	'Emulation.setFocusEmulationEnabled': EmptyResult;
	'Emulation.setGeolocationOverride': EmptyResult;
	'Emulation.setLocaleOverride': EmptyResult;
	'Emulation.setScrollbarsHidden': EmptyResult;
	'Emulation.setTimezoneOverride': EmptyResult;
	'Emulation.setUserAgentOverride': EmptyResult;
}

/** `Emulation.virtualTimeBudgetExpired` exists but is unused (D-CDP2). */
export type EmulationEvents = Record<never, never>;

export const EMULATION_METHODS = [
	'clearDeviceMetricsOverride',
	'clearGeolocationOverride',
	'setDeviceMetricsOverride',
	'setEmulatedMedia',
	'setFocusEmulationEnabled',
	'setGeolocationOverride',
	'setLocaleOverride',
	'setScrollbarsHidden',
	'setTimezoneOverride',
	'setUserAgentOverride',
] as const;
