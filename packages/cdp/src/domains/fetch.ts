/**
 * CDP `Fetch` domain — request interception and proxy auth.
 *
 * `Fetch.enable({handleAuthRequests: true})` is how proxy credentials are armed on attach
 * (SPECS/ARCHITECTURE.md §7.3, SPECS/DATA-MODEL.md §5.2 `ProxySettings`). `authRequired` is
 * answered with `continueWithAuth`; every other paused request is passed through with
 * `continueRequest`.
 */

import type { EmptyResult, FetchRequestId, FrameId, Headers, NoParams, ResourceType } from './common.ts';
import type { NetworkRequest } from './network.ts';

/** `Fetch.RequestPattern`. */
export interface RequestPattern {
	urlPattern?: string;
	resourceType?: ResourceType;
	requestStage?: 'Request' | 'Response';
}

/** `Fetch.HeaderEntry`. */
export interface HeaderEntry {
	name: string;
	value: string;
}

/** `Fetch.AuthChallenge`. */
export interface AuthChallenge {
	source?: 'Server' | 'Proxy';
	origin: string;
	scheme: string;
	realm: string;
}

/** `Fetch.AuthChallengeResponse`. */
export interface AuthChallengeResponse {
	response: 'Default' | 'CancelAuth' | 'ProvideCredentials';
	username?: string;
	password?: string;
}

export interface FetchParams {
	'Fetch.continueRequest': {
		requestId: FetchRequestId;
		url?: string;
		method?: string;
		postData?: string;
		headers?: HeaderEntry[];
		interceptResponse?: boolean;
	};
	'Fetch.continueWithAuth': { requestId: FetchRequestId; authChallengeResponse: AuthChallengeResponse };
	'Fetch.disable': NoParams;
	'Fetch.enable': { patterns?: RequestPattern[]; handleAuthRequests?: boolean };
	'Fetch.failRequest': { requestId: FetchRequestId; errorReason: string };
	'Fetch.fulfillRequest': {
		requestId: FetchRequestId;
		responseCode: number;
		responseHeaders?: HeaderEntry[];
		binaryResponseHeaders?: string;
		body?: string;
		responsePhrase?: string;
	};
	'Fetch.getResponseBody': { requestId: FetchRequestId };
}

export interface FetchResults {
	'Fetch.continueRequest': EmptyResult;
	'Fetch.continueWithAuth': EmptyResult;
	'Fetch.disable': EmptyResult;
	'Fetch.enable': EmptyResult;
	'Fetch.failRequest': EmptyResult;
	'Fetch.fulfillRequest': EmptyResult;
	'Fetch.getResponseBody': { body: string; base64Encoded: boolean };
}

export interface FetchEvents {
	'Fetch.authRequired': {
		requestId: FetchRequestId;
		request: NetworkRequest;
		frameId: FrameId;
		resourceType: ResourceType;
		authChallenge: AuthChallenge;
	};
	'Fetch.requestPaused': {
		requestId: FetchRequestId;
		request: NetworkRequest;
		frameId: FrameId;
		resourceType: ResourceType;
		responseErrorReason?: string;
		responseStatusCode?: number;
		responseStatusText?: string;
		responseHeaders?: HeaderEntry[];
		networkId?: string;
		redirectedRequestId?: string;
	};
}

/** Re-exported for symmetry with `Network`; `Fetch` headers are entry arrays, not maps. */
export type FetchHeaderMap = Headers;

export const FETCH_METHODS = [
	'continueRequest',
	'continueWithAuth',
	'disable',
	'enable',
	'failRequest',
	'fulfillRequest',
	'getResponseBody',
] as const;
