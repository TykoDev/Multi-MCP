/**
 * CDP `DOMStorage` domain — localStorage / sessionStorage read+write.
 *
 * The `origins[].localStorage` / `origins[].sessionStorage` half of the storage-state round-trip
 * (SPECS/DATA-MODEL.md §5.2, SPECS/ARCHITECTURE.md §6.9).
 */

import type { EmptyResult, NoParams } from './common.ts';

/** `DOMStorage.StorageId`. Exactly one of `securityOrigin` / `storageKey` is set. */
export interface StorageId {
	securityOrigin?: string;
	storageKey?: string;
	isLocalStorage: boolean;
}

/** `DOMStorage.Item` — CDP models an entry as a 2-element `[key, value]` array. */
export type DomStorageItem = string[];

export interface DomStorageParams {
	'DOMStorage.clear': { storageId: StorageId };
	'DOMStorage.disable': NoParams;
	'DOMStorage.enable': NoParams;
	'DOMStorage.getDOMStorageItems': { storageId: StorageId };
	'DOMStorage.removeDOMStorageItem': { storageId: StorageId; key: string };
	'DOMStorage.setDOMStorageItem': { storageId: StorageId; key: string; value: string };
}

export interface DomStorageResults {
	'DOMStorage.clear': EmptyResult;
	'DOMStorage.disable': EmptyResult;
	'DOMStorage.enable': EmptyResult;
	'DOMStorage.getDOMStorageItems': { entries: DomStorageItem[] };
	'DOMStorage.removeDOMStorageItem': EmptyResult;
	'DOMStorage.setDOMStorageItem': EmptyResult;
}

export interface DomStorageEvents {
	'DOMStorage.domStorageItemAdded': { storageId: StorageId; key: string; newValue: string };
	'DOMStorage.domStorageItemRemoved': { storageId: StorageId; key: string };
	'DOMStorage.domStorageItemUpdated': { storageId: StorageId; key: string; oldValue: string; newValue: string };
	'DOMStorage.domStorageItemsCleared': { storageId: StorageId };
}

export const DOM_STORAGE_METHODS = [
	'clear',
	'disable',
	'enable',
	'getDOMStorageItems',
	'removeDOMStorageItem',
	'setDOMStorageItem',
] as const;
