/**
 * The typed CDP domain surface: exactly the D-CDP2 domain set, and nothing else.
 *
 * Contract: SPECS/DECISION-REGISTER.md D-CDP2, SPECS/ARCHITECTURE.md §7.2,
 * SPECS/COMPLETIONS-CRITERIA.md §3.1 ("typed wrappers for all 14 D-CDP2 domains (+ optional vendor
 * `BrowserUse`)").
 *
 * Shape: three flat maps keyed by the dotted CDP method/event name — {@linkcode CdpParams},
 * {@linkcode CdpResult}, {@linkcode CdpEventParams} — from which {@linkcode CdpSend} is derived
 * mechanically. Adding a method means adding one line to a `src/domains/*.ts` map plus its name in
 * that file's `*_METHODS` manifest; the two are cross-checked at type level (see
 * {@linkcode CdpManifestMethodName}) so they cannot drift.
 *
 * Full-protocol codegen is deliberately out of scope (D-CDP2: "maintenance surface for methods
 * never called"); hand-written types are sanctioned by ARCHITECTURE §7.2 at this stage.
 */

import {
	ACCESSIBILITY_METHODS,
	type AccessibilityEvents,
	type AccessibilityParams,
	type AccessibilityResults,
} from './domains/accessibility.ts';
import { BROWSER_METHODS, type BrowserEvents, type BrowserParams, type BrowserResults } from './domains/browser.ts';
import {
	BROWSER_USE_METHODS,
	type BrowserUseEvents,
	type BrowserUseParams,
	type BrowserUseResults,
} from './domains/browser_use.ts';
import { DOM_METHODS, type DomEvents, type DomParams, type DomResults } from './domains/dom.ts';
import {
	DOM_SNAPSHOT_METHODS,
	type DomSnapshotEvents,
	type DomSnapshotParams,
	type DomSnapshotResults,
} from './domains/dom_snapshot.ts';
import {
	DOM_STORAGE_METHODS,
	type DomStorageEvents,
	type DomStorageParams,
	type DomStorageResults,
} from './domains/dom_storage.ts';
import {
	EMULATION_METHODS,
	type EmulationEvents,
	type EmulationParams,
	type EmulationResults,
} from './domains/emulation.ts';
import { FETCH_METHODS, type FetchEvents, type FetchParams, type FetchResults } from './domains/fetch.ts';
import { INPUT_METHODS, type InputEvents, type InputParams, type InputResults } from './domains/input.ts';
import { NETWORK_METHODS, type NetworkEvents, type NetworkParams, type NetworkResults } from './domains/network.ts';
import { OVERLAY_METHODS, type OverlayEvents, type OverlayParams, type OverlayResults } from './domains/overlay.ts';
import { PAGE_METHODS, type PageEvents, type PageParams, type PageResults } from './domains/page.ts';
import { RUNTIME_METHODS, type RuntimeEvents, type RuntimeParams, type RuntimeResults } from './domains/runtime.ts';
import { STORAGE_METHODS, type StorageEvents, type StorageParams, type StorageResults } from './domains/storage.ts';
import {
	SYSTEM_INFO_METHODS,
	type SystemInfoEvents,
	type SystemInfoParams,
	type SystemInfoResults,
} from './domains/system_info.ts';
import { TARGET_METHODS, type TargetEvents, type TargetParams, type TargetResults } from './domains/target.ts';
import type { CdpSendOptions, SessionId } from './domains/common.ts';

export * from './domains/accessibility.ts';
export * from './domains/browser.ts';
export * from './domains/browser_use.ts';
export * from './domains/common.ts';
export * from './domains/dom.ts';
export * from './domains/dom_snapshot.ts';
export * from './domains/dom_storage.ts';
export * from './domains/emulation.ts';
export * from './domains/fetch.ts';
export * from './domains/input.ts';
export * from './domains/network.ts';
export * from './domains/overlay.ts';
export * from './domains/page.ts';
export * from './domains/runtime.ts';
export * from './domains/storage.ts';
export * from './domains/system_info.ts';
export * from './domains/target.ts';

/**
 * The 14 domains of D-CDP2, `Overlay` (E-46, three highlight commands only), and the optional vendor
 * `BrowserUse`.
 *
 * Ordering is alphabetical so the list reads as an audit checklist.
 */
export const CDP_DOMAINS = [
	'Accessibility',
	'Browser',
	'BrowserUse',
	'DOM',
	'DOMSnapshot',
	'DOMStorage',
	'Emulation',
	'Fetch',
	'Input',
	'Network',
	// ERRATUM(E-46): the server-drawn highlight (B2.2). See `domains/overlay.ts` for what is deliberately not typed.
	'Overlay',
	'Page',
	'Runtime',
	'Storage',
	'SystemInfo',
	'Target',
] as const;

/** Union of the 16 domain names. */
export type CdpDomainName = (typeof CDP_DOMAINS)[number];

/** The vendor domain, excluded from the "14 required domains" count. */
export const CDP_VENDOR_DOMAINS = ['BrowserUse'] as const satisfies readonly CdpDomainName[];

/** Runtime manifest of the short method names per domain. Cross-checked against the type maps. */
export const CDP_DOMAIN_METHODS = {
	Accessibility: ACCESSIBILITY_METHODS,
	Browser: BROWSER_METHODS,
	BrowserUse: BROWSER_USE_METHODS,
	DOM: DOM_METHODS,
	DOMSnapshot: DOM_SNAPSHOT_METHODS,
	DOMStorage: DOM_STORAGE_METHODS,
	Emulation: EMULATION_METHODS,
	Fetch: FETCH_METHODS,
	Input: INPUT_METHODS,
	Network: NETWORK_METHODS,
	Overlay: OVERLAY_METHODS,
	Page: PAGE_METHODS,
	Runtime: RUNTIME_METHODS,
	Storage: STORAGE_METHODS,
	SystemInfo: SYSTEM_INFO_METHODS,
	Target: TARGET_METHODS,
} as const satisfies Record<CdpDomainName, readonly string[]>;

/** Parameter type for every typed command, keyed by dotted method name. */
export type CdpParams =
	& AccessibilityParams
	& BrowserParams
	& BrowserUseParams
	& DomParams
	& DomSnapshotParams
	& DomStorageParams
	& EmulationParams
	& FetchParams
	& InputParams
	& NetworkParams
	& OverlayParams
	& PageParams
	& RuntimeParams
	& StorageParams
	& SystemInfoParams
	& TargetParams;

/** Result type for every typed command, keyed by dotted method name. */
export type CdpResult =
	& AccessibilityResults
	& BrowserResults
	& BrowserUseResults
	& DomResults
	& DomSnapshotResults
	& DomStorageResults
	& EmulationResults
	& FetchResults
	& InputResults
	& NetworkResults
	& OverlayResults
	& PageResults
	& RuntimeResults
	& StorageResults
	& SystemInfoResults
	& TargetResults;

/** Payload type for every typed event, keyed by dotted event name. */
export type CdpEventParams =
	& AccessibilityEvents
	& BrowserEvents
	& BrowserUseEvents
	& DomEvents
	& DomSnapshotEvents
	& DomStorageEvents
	& EmulationEvents
	& FetchEvents
	& InputEvents
	& NetworkEvents
	& OverlayEvents
	& PageEvents
	& RuntimeEvents
	& StorageEvents
	& SystemInfoEvents
	& TargetEvents;

/** Every typed command name, e.g. `'Page.navigate'`. */
export type CdpMethodName = keyof CdpParams & string;

/** Every typed event name, e.g. `'Page.lifecycleEvent'`. */
export type CdpEventName = keyof CdpEventParams & string;

/** Method names derived from the runtime manifest; kept equal to {@linkcode CdpMethodName}. */
export type CdpManifestMethodName = {
	[D in CdpDomainName]: `${D}.${(typeof CDP_DOMAIN_METHODS)[D][number]}`;
}[CdpDomainName];

type MethodsOfDomain<D extends CdpDomainName> = Extract<CdpMethodName, `${D}.${string}`>;
type ShortMethodName<D extends string, M extends string> = M extends `${D}.${infer N}` ? N : never;

/**
 * One typed command.
 *
 * `params` becomes optional exactly when every field of the parameter object is optional (which
 * includes the no-parameter case), so `send.Page.enable()` and `send.Page.navigate({url})` both
 * read naturally while a missing required parameter is still a type error.
 */
export type CdpSendFunction<M extends CdpMethodName> = Record<never, never> extends CdpParams[M]
	? (params?: CdpParams[M], sessionId?: SessionId, opts?: CdpSendOptions) => Promise<CdpResult[M]>
	: (params: CdpParams[M], sessionId?: SessionId, opts?: CdpSendOptions) => Promise<CdpResult[M]>;

/**
 * `client.send.Domain.method(params?, sessionId?, opts?)`.
 *
 * `sessionId` is the flat-session routing key (ARCHITECTURE §7.1); omit it for browser-level calls.
 * `BrowserUse` is present but empty — the vendor domain contributes events only; use
 * `CdpClient.sendRaw()` for vendor commands.
 */
export type CdpSend = {
	[D in CdpDomainName]: {
		[M in MethodsOfDomain<D> as ShortMethodName<D, M>]: CdpSendFunction<M>;
	};
};
