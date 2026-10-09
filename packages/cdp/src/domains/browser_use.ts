/**
 * Vendor `BrowserUse` domain — OPTIONAL, cloud-proxy-browser only.
 *
 * D-CDP2 marks this domain optional: a stock Chromium never emits these, and subscribing is
 * harmless there. CaptchaWatchdog (SPECS/ARCHITECTURE.md §6.14) listens and re-broadcasts them as
 * `CaptchaSolverStartedEvent` / `CaptchaSolverFinishedEvent` (SPECS/DATA-MODEL.md §5.1.7).
 *
 * No commands are typed: the vendor command surface is not speced, and guessing at it would be
 * worse than the honest escape hatch, `CdpClient.sendRaw()`.
 */

import type { TargetId } from './common.ts';

/** No `BrowserUse.*` commands are part of the contract. */
export type BrowserUseParams = Record<never, never>;

/** No `BrowserUse.*` commands are part of the contract. */
export type BrowserUseResults = Record<never, never>;

/**
 * Every field is optional: these frames come from a vendor surface outside our control, and a
 * missing field must degrade the captcha wait, not throw. The index signature preserves fields the
 * vendor adds without forcing a release here.
 */
export interface BrowserUseEvents {
	'BrowserUse.captchaSolverStarted': {
		targetId?: TargetId;
		vendor?: string;
		url?: string;
		startedAt?: string;
		[key: string]: unknown;
	};
	'BrowserUse.captchaSolverFinished': {
		targetId?: TargetId;
		vendor?: string;
		url?: string;
		durationMs?: number;
		finishedAt?: string;
		success?: boolean;
		[key: string]: unknown;
	};
}

export const BROWSER_USE_METHODS = [] as const;
