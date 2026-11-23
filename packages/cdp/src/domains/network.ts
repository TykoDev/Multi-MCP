/**
 * CDP `Network` domain — enable/disable, headers, bodies, cookies, request lifecycle events.
 *
 * DownloadsWatchdog sniffs `responseReceived` for PDFs/attachments;
 * HarRecordingWatchdog consumes the full request/response/timing set.
 */

import type {
	CdpTimestamp,
	Cookie,
	CookieParam,
	EmptyResult,
	FrameId,
	Headers,
	NetworkRequestId,
	NoParams,
	ResourceType,
} from './common.ts';

/** `Network.Request`. */
export interface NetworkRequest {
	url: string;
	urlFragment?: string;
	method: string;
	headers: Headers;
	postData?: string;
	hasPostData?: boolean;
	mixedContentType?: string;
	initialPriority: string;
	referrerPolicy: string;
	isLinkPreload?: boolean;
}

/** `Network.ResourceTiming` — the subset HAR export needs. */
export interface ResourceTiming {
	requestTime: number;
	proxyStart: number;
	proxyEnd: number;
	dnsStart: number;
	dnsEnd: number;
	connectStart: number;
	connectEnd: number;
	sslStart: number;
	sslEnd: number;
	sendStart: number;
	sendEnd: number;
	receiveHeadersStart?: number;
	receiveHeadersEnd: number;
}

/** `Network.Response`. */
export interface NetworkResponse {
	url: string;
	status: number;
	statusText: string;
	headers: Headers;
	mimeType: string;
	charset?: string;
	requestHeaders?: Headers;
	connectionReused: boolean;
	connectionId: number;
	remoteIPAddress?: string;
	remotePort?: number;
	fromDiskCache?: boolean;
	fromServiceWorker?: boolean;
	fromPrefetchCache?: boolean;
	encodedDataLength: number;
	timing?: ResourceTiming;
	protocol?: string;
	securityState?: string;
}

// `Network.loadNetworkResource` is deliberately not typed. Measured on real Chromium
// it follows redirects silently, reports no hop and no final URL, and transfers the
// whole body for a metadata query. `browser_head` is a cookie-less server-side HEAD
// gated at every hop (`packages/mcp/src/head.ts`), so typing the method would be an
// egress primitive with no consumer. The typed `Network` domain has no method that
// issues a request.

export interface NetworkParams {
	'Network.clearBrowserCache': NoParams;
	'Network.clearBrowserCookies': NoParams;
	'Network.deleteCookies': { name: string; url?: string; domain?: string; path?: string };
	'Network.disable': NoParams;
	'Network.enable': { maxTotalBufferSize?: number; maxResourceBufferSize?: number; maxPostDataSize?: number };
	'Network.getCookies': { urls?: string[] };
	'Network.getResponseBody': { requestId: NetworkRequestId };
	'Network.setCacheDisabled': { cacheDisabled: boolean };
	'Network.setCookies': { cookies: CookieParam[] };
	'Network.setExtraHTTPHeaders': { headers: Headers };
}

export interface NetworkResults {
	'Network.clearBrowserCache': EmptyResult;
	'Network.clearBrowserCookies': EmptyResult;
	'Network.deleteCookies': EmptyResult;
	'Network.disable': EmptyResult;
	'Network.enable': EmptyResult;
	'Network.getCookies': { cookies: Cookie[] };
	'Network.getResponseBody': { body: string; base64Encoded: boolean };
	'Network.setCacheDisabled': EmptyResult;
	'Network.setCookies': EmptyResult;
	'Network.setExtraHTTPHeaders': EmptyResult;
}

export interface NetworkEvents {
	'Network.dataReceived': {
		requestId: NetworkRequestId;
		timestamp: CdpTimestamp;
		dataLength: number;
		encodedDataLength: number;
	};
	'Network.loadingFailed': {
		requestId: NetworkRequestId;
		timestamp: CdpTimestamp;
		type: ResourceType;
		errorText: string;
		canceled?: boolean;
		blockedReason?: string;
		corsErrorStatus?: Record<string, unknown>;
	};
	'Network.loadingFinished': {
		requestId: NetworkRequestId;
		timestamp: CdpTimestamp;
		encodedDataLength: number;
	};
	'Network.requestServedFromCache': { requestId: NetworkRequestId };
	'Network.requestWillBeSent': {
		requestId: NetworkRequestId;
		loaderId: string;
		documentURL: string;
		request: NetworkRequest;
		timestamp: CdpTimestamp;
		wallTime: number;
		initiator: Record<string, unknown>;
		redirectResponse?: NetworkResponse;
		type?: ResourceType;
		frameId?: FrameId;
		hasUserGesture?: boolean;
	};
	'Network.responseReceived': {
		requestId: NetworkRequestId;
		loaderId: string;
		timestamp: CdpTimestamp;
		type: ResourceType;
		response: NetworkResponse;
		hasExtraInfo?: boolean;
		frameId?: FrameId;
	};
}

export const NETWORK_METHODS = [
	'clearBrowserCache',
	'clearBrowserCookies',
	'deleteCookies',
	'disable',
	'enable',
	'getCookies',
	'getResponseBody',
	'setCacheDisabled',
	'setCookies',
	'setExtraHTTPHeaders',
] as const;
