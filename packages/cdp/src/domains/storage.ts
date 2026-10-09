/**
 * CDP `Storage` domain — browser-wide cookie jar + per-origin data clearing.
 *
 * StorageStateWatchdog (SPECS/ARCHITECTURE.md §6.9) uses this for the cookie half of the
 * Playwright-format storage state in SPECS/DATA-MODEL.md §5.2; the localStorage half is `DOMStorage`.
 */

import type { BrowserContextId, Cookie, CookieParam, EmptyResult, FrameId } from './common.ts';

/** `Storage.StorageType`. `'all'` is the blanket value `clearDataForOrigin` usually gets. */
export type StorageType =
	| 'appcache'
	| 'cookies'
	| 'file_systems'
	| 'indexeddb'
	| 'local_storage'
	| 'shader_cache'
	| 'websql'
	| 'service_workers'
	| 'cache_storage'
	| 'interest_groups'
	| 'shared_storage'
	| 'storage_buckets'
	| 'all'
	| 'other'
	| (string & Record<never, never>);

export interface StorageParams {
	'Storage.clearCookies': { browserContextId?: BrowserContextId };
	/** `storageTypes` is a comma-separated {@linkcode StorageType} list, e.g. `'all'`. */
	'Storage.clearDataForOrigin': { origin: string; storageTypes: string };
	'Storage.clearDataForStorageKey': { storageKey: string; storageTypes: string };
	'Storage.getCookies': { browserContextId?: BrowserContextId };
	'Storage.getStorageKeyForFrame': { frameId: FrameId };
	'Storage.setCookies': { cookies: CookieParam[]; browserContextId?: BrowserContextId };
}

export interface StorageResults {
	'Storage.clearCookies': EmptyResult;
	'Storage.clearDataForOrigin': EmptyResult;
	'Storage.clearDataForStorageKey': EmptyResult;
	'Storage.getCookies': { cookies: Cookie[] };
	'Storage.getStorageKeyForFrame': { storageKey: string };
	'Storage.setCookies': EmptyResult;
}

/** `Storage` emits several quota/interest-group events; none are consumed by BUA (D-CDP2). */
export type StorageEvents = Record<never, never>;

export const STORAGE_METHODS = [
	'clearCookies',
	'clearDataForOrigin',
	'clearDataForStorageKey',
	'getCookies',
	'getStorageKeyForFrame',
	'setCookies',
] as const;
