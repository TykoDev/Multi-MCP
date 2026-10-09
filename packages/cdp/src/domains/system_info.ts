/**
 * CDP `SystemInfo` domain — GPU/driver and process introspection.
 *
 * Used by `bua doctor` (SPECS/SETUP-WIZARD.md) and the diagnostics playbook
 * (SPECS/OBSERVABILITY-TESTING-CICD.md §8.4) to report what the browser actually is.
 */

import type { NoParams } from './common.ts';

/** `SystemInfo.GPUInfo`. Device/driver shapes vary by platform, so they stay indexed records. */
export interface GpuInfo {
	devices: Record<string, unknown>[];
	auxAttributes?: Record<string, unknown>;
	featureStatus?: Record<string, unknown>;
	driverBugWorkarounds: string[];
	videoDecoding?: Record<string, unknown>[];
	videoEncoding?: Record<string, unknown>[];
	imageDecoding?: Record<string, unknown>[];
}

/** `SystemInfo.ProcessInfo`. */
export interface ProcessInfo {
	type: string;
	id: number;
	cpuTime: number;
}

export interface SystemInfoParams {
	'SystemInfo.getInfo': NoParams;
	'SystemInfo.getProcessInfo': NoParams;
}

export interface SystemInfoResults {
	'SystemInfo.getInfo': {
		gpu: GpuInfo;
		modelName: string;
		modelVersion: string;
		commandLine: string;
	};
	'SystemInfo.getProcessInfo': { processInfo: ProcessInfo[] };
}

/** `SystemInfo` is query-only. */
export type SystemInfoEvents = Record<never, never>;

export const SYSTEM_INFO_METHODS = ['getInfo', 'getProcessInfo'] as const;
