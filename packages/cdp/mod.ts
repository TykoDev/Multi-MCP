/**
 * @module
 * `@tykotech/cdp` — typed Chrome DevTools Protocol client over native `WebSocket`, plus browser
 * launch/discovery. No puppeteer, no playwright, no ws library (D-CDP1, REJ-4).
 *
 * Contract owners: SPECS/ARCHITECTURE.md §7 (transport, typed domains, launch/connect/reconnect),
 * SPECS/DECISION-REGISTER.md D-CDP1/D-CDP2/D-BROWSER1, SPECS/COMPLETIONS-CRITERIA.md §3.1.
 *
 * This file is the ONLY public export surface of the package (AGENTS.md §3: deep imports across
 * packages are forbidden). It is orchestrator-owned: the split between `src/client.ts` (transport +
 * typed domains) and `src/launch.ts` (process launch + executable discovery + handshake) is the
 * parallel-build boundary, and this file is the seam contract between them.
 */

// ---- transport + typed domain surface (src/client.ts, src/transport.ts, src/domains.ts) ----
export { CdpClient } from './src/client.ts';
export type { CdpClientOptions, CdpConnectionState, CdpSend } from './src/client.ts';
export {
	CdpConnectionClosedError,
	CdpError,
	CdpFrameTooLargeError,
	CdpProtocolError,
	CdpRequestTimeoutError,
} from './src/errors.ts';
export type { CdpCloseInfo } from './src/client.ts';
export type {
	CdpEventName,
	CdpEventParams,
	CdpMethodName,
	CdpParams,
	CdpResult,
	SessionId,
	TargetId,
} from './src/domains.ts';

// ---- launch + discovery (src/launch.ts) ----
export { fetchWebSocketDebuggerUrl, findBrowserExecutable, launchBrowser } from './src/launch.ts';
export type { BrowserChannel, LaunchedBrowser, LaunchOptions } from './src/launch.ts';
export { BrowserLaunchError, BrowserNotFoundError } from './src/launch.ts';

// ---- structured discovery (ERRATUM(SEAM-1) / owed by DECISION-REGISTER.md §9.11) ----
//
// `findBrowserExecutable` returns a bare path and throws a `BrowserNotFoundError` whose `searched`
// list is prose. That left every consumer needing E-24's not-installed/not-permitted distinction to
// substring-match `describeProbe`'s wording — which `packages/server/src/browser.ts` and
// `packages/cli/src/doctor/checks.ts` both did, and whose two copies had already drifted into
// disagreeing about the answer. Additive only: nothing above this comment changed shape.
export { classifyDiscoveryFailure, discoverBrowserExecutable } from './src/launch.ts';
export type {
	BrowserDiscovery,
	DiscoveryFailure,
	DiscoveryFailureKind,
	DiscoveryProbe,
	DiscoveryRoots,
	DiscoverySource,
	ProbeResult,
	TargetOs,
} from './src/launch.ts';
