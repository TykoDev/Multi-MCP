/**
 * @module
 * `@tykotech/cdp` — typed Chrome DevTools Protocol client over native `WebSocket`, plus browser
 * launch/discovery. No puppeteer, no playwright, no ws library.
 *
 * This file is the ONLY public export surface of the package: deep imports across packages are
 * forbidden. The split between `src/client.ts` (transport + typed domains) and `src/launch.ts`
 * (process launch + executable discovery + handshake) is the package's internal boundary, and this
 * file is the seam contract between them.
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

// ---- structured discovery ----
//
// `findBrowserExecutable` returns a bare path and throws a `BrowserNotFoundError` whose `searched`
// list is prose. A consumer that needs the not-installed/not-permitted distinction reads the
// structured result here instead of substring-matching that prose.
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
