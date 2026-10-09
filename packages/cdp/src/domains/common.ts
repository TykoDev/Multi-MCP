/**
 * Primitives shared across the typed CDP domain surface.
 *
 * Contract: SPECS/ARCHITECTURE.md §7.2 (D-CDP2), SPECS/DATA-MODEL.md §6.
 * Hand-written types are explicitly sanctioned at this stage; the rule is only that nothing is
 * typed as bare `any` — unknown-but-plausible fields are `unknown` or indexed records.
 */

/** Flat-session id (`Target.attachToTarget({flatten: true})` — ARCHITECTURE §7.1). */
export type SessionId = string;
/** Stable per-target id; the LLM-facing `tabId` is its 4-char suffix (ARCHITECTURE §7.3). */
export type TargetId = string;
export type BrowserContextId = string;
export type FrameId = string;
export type LoaderId = string;
/** Session-scoped, reusable (DATA-MODEL §6.1). */
export type NodeId = number;
/** The stable action handle; valid ONLY in its originating session (DATA-MODEL §6.1). */
export type BackendNodeId = number;
export type ExecutionContextId = number;
export type RemoteObjectId = string;
export type NetworkRequestId = string;
export type FetchRequestId = string;
export type InterceptionId = string;
export type WindowId = number;
/** Monotonic CDP timestamp, seconds since an arbitrary epoch. */
export type CdpTimestamp = number;

/** Marker for commands that take no parameters. */
export type NoParams = Record<never, never>;
/** Marker for commands whose CDP result is the empty object `{}`. */
export type EmptyResult = Record<never, never>;

/** Per-call overrides on every typed `send.Domain.method(...)`. */
export interface CdpSendOptions {
	/**
	 * Overrides the client default and the `BUA_CDP_TIMEOUT_S` env value for this one call.
	 * Precedence: call opts → client opts → env → 60 s built-in (ARCHITECTURE §8).
	 */
	requestTimeoutMs?: number;
	/** Caller cancellation, composed with the timeout and the socket lifetime via `AbortSignal.any`. */
	signal?: AbortSignal;
}

/** CSS-pixel rectangle. */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Quad of 4 points, flattened to 8 numbers (`DOM.getContentQuads`). */
export type Quad = number[];

/** `Runtime.RemoteObject`. `value` is `unknown`; callers narrow with their own schema. */
export interface RemoteObject {
	type: 'object' | 'function' | 'undefined' | 'string' | 'number' | 'boolean' | 'symbol' | 'bigint';
	subtype?: string;
	className?: string;
	value?: unknown;
	unserializableValue?: string;
	description?: string;
	objectId?: RemoteObjectId;
	preview?: Record<string, unknown>;
	deepSerializedValue?: Record<string, unknown>;
}

/** `Runtime.CallArgument`. */
export interface CallArgument {
	value?: unknown;
	unserializableValue?: string;
	objectId?: RemoteObjectId;
}

/** `Runtime.PropertyDescriptor` (the subset the DOM layer reads). */
export interface PropertyDescriptor {
	name: string;
	value?: RemoteObject;
	writable?: boolean;
	get?: RemoteObject;
	set?: RemoteObject;
	configurable: boolean;
	enumerable: boolean;
	wasThrown?: boolean;
	isOwn?: boolean;
	symbol?: RemoteObject;
}

/** `Runtime.StackTrace`. */
export interface StackTrace {
	description?: string;
	callFrames: {
		functionName: string;
		scriptId: string;
		url: string;
		lineNumber: number;
		columnNumber: number;
	}[];
	parent?: StackTrace;
}

/** `Runtime.ExceptionDetails`. */
export interface ExceptionDetails {
	exceptionId: number;
	text: string;
	lineNumber: number;
	columnNumber: number;
	scriptId?: string;
	url?: string;
	stackTrace?: StackTrace;
	exception?: RemoteObject;
	executionContextId?: ExecutionContextId;
	exceptionMetaData?: Record<string, unknown>;
}

/** `Network.Cookie`. Round-trips through the Playwright-format storage state (DATA-MODEL §5.2). */
export interface Cookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	size: number;
	httpOnly: boolean;
	secure: boolean;
	session: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
	priority?: 'Low' | 'Medium' | 'High';
	sameParty?: boolean;
	sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
	sourcePort?: number;
	partitionKey?: unknown;
	partitionKeyOpaque?: boolean;
}

/** `Network.CookieParam` — the write-side shape. */
export interface CookieParam {
	name: string;
	value: string;
	url?: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
	expires?: number;
	priority?: 'Low' | 'Medium' | 'High';
	sameParty?: boolean;
	sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
	sourcePort?: number;
	partitionKey?: unknown;
}

/** HTTP headers as CDP models them: a flat string map. */
export type Headers = Record<string, string>;

/** `Network.ResourceType`. */
export type ResourceType =
	| 'Document'
	| 'Stylesheet'
	| 'Image'
	| 'Media'
	| 'Font'
	| 'Script'
	| 'TextTrack'
	| 'XHR'
	| 'Fetch'
	| 'Prefetch'
	| 'EventSource'
	| 'WebSocket'
	| 'Manifest'
	| 'SignedExchange'
	| 'Ping'
	| 'CSPViolationReport'
	| 'Preflight'
	| 'Other';
