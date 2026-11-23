/**
 * The built-in model agent's provider contract and the one HTTP transport under both clients. Every provider call is
 * a `fetch` from this process with `redirect: 'error'` (the saved `base_url` is the only host ever dialled), a
 * per-call timeout, a capped body, a `content-type` check, and one retry for 429/5xx. A failure carries the status
 * class and never the body: a 401 body may quote the key it was sent.
 */
import { AgentError, delay, readCapped } from '../util.ts';

// --- the loop–client contract ----------------------------------------------------------------------------------

/** One MCP tool as the provider sees it: its name, description and JSON Schema input, nothing of its scope. */
export interface ModelTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/** A tool call the model asked for, with the provider's own id so its result can be matched back. */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
	/** Set when the arguments were not a JSON object: the loop answers the call with an error, never invokes it. */
	readonly argumentsError?: string;
}

export interface ToolResultMessage {
	readonly id: string;
	readonly text: string;
	readonly isError: boolean;
}

/** The transcript in a wire-neutral shape; each client maps it to its provider's own format. */
export type ModelMessage =
	| { readonly role: 'system'; readonly text: string }
	| { readonly role: 'user'; readonly text: string }
	| { readonly role: 'assistant'; readonly text: string; readonly toolCalls: ToolCall[] }
	| { readonly role: 'tool'; readonly results: ToolResultMessage[] };

/** One complete assistant turn (non-streaming): the loop acts only on a whole turn. */
export interface ModelTurn {
	readonly text: string;
	readonly toolCalls: ToolCall[];
	readonly stop: 'end' | 'tool_use' | 'length' | 'refusal' | 'other';
	readonly usage: { readonly input: number; readonly output: number };
}

/** The per-provider loop bounds (`max_steps`, `max_output_tokens`, `token_budget`). */
export interface ModelBounds {
	readonly maxSteps: number;
	readonly maxOutputTokens: number;
	readonly tokenBudget: number;
}

/** A configured provider, ready to dial. Its settings (key included) stay inside the client. */
export interface ModelProviderClient {
	readonly id: string;
	readonly kind: 'openai' | 'anthropic';
	readonly models: readonly string[];
	readonly defaultModel: string;
	/** Absent (a test fake): the loop's defaults. */
	readonly bounds?: ModelBounds;
	/** Strips this provider's key out of text the loop emits; the key never leaves the client. */
	readonly redact?: (text: string) => string;
	/** The provider's model ids, for the control plane's picker. */
	listModels?(signal: AbortSignal): Promise<string[]>;
	complete(
		input: {
			readonly model: string;
			readonly messages: ModelMessage[];
			readonly tools: ModelTool[];
			readonly maxOutputTokens: number;
		},
		signal: AbortSignal,
	): Promise<ModelTurn>;
}

/**
 * What a client is built from — structurally a subset of the gateway's `ModelProviderSettings`. `apiKey` goes into
 * one request header and into the redactor, nowhere else.
 */
export interface ModelClientSettings {
	readonly id: string;
	/** Trailing slash stripped; {@linkcode providerEndpoint} resolves each call's URL from it. */
	readonly baseUrl: string;
	readonly models: readonly string[];
	readonly defaultModel: string;
	readonly apiKey: string | null;
	/** Operator headers, already refused the credential names at parse; the key header is set after them. */
	readonly headers?: Readonly<Record<string, string>>;
	/** OpenAI only: which output-token parameter the wire takes; `max_tokens` by default. */
	readonly maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
	readonly maxSteps?: number;
	readonly maxOutputTokens?: number;
	readonly tokenBudget?: number;
}

// --- redaction -------------------------------------------------------------------------------------------------

/**
 * The shortest secret that is redacted: splitting ordinary text on a short token would mangle output that merely
 * contains it, and the providers-file parser warns about such a key.
 */
export const REDACTION_MIN_LENGTH = 16;
export const REDACTED = '[REDACTED]';

/** The secrets among `candidates` long enough to be redacted. */
export function redactable(candidates: Iterable<string | null | undefined>): string[] {
	return [...candidates].filter((candidate): candidate is string =>
		typeof candidate === 'string' && candidate.length >= REDACTION_MIN_LENGTH
	);
}

/** Replaces every occurrence of every secret with {@linkcode REDACTED}; the identity with no secrets. */
export function redactor(secrets: readonly string[]): (text: string) => string {
	if (secrets.length === 0) return (text: string): string => text;
	// Longest first, so a secret that contains another is replaced whole.
	const ordered = [...secrets].sort((a, b) => b.length - a.length);
	return (text: string): string => {
		let out = text;
		for (const secret of ordered) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
		return out;
	};
}

/** Redacts every string inside a JSON value by redacting its serialized form and parsing it back. */
export function redactJson(value: unknown, redact: (text: string) => string): unknown {
	const json = JSON.stringify(value);
	if (json === undefined) return value;
	const clean = redact(json);
	return clean === json ? value : JSON.parse(clean);
}

// --- the transport ---------------------------------------------------------------------------------------------

/** The status class or transport failure of a provider call. `malformed` covers content-type, size and shape. */
export type ModelProviderErrorKind = '4xx' | '5xx' | 'timeout' | 'network' | 'malformed';

/** Per call, the same bound a tool call has (`TOOL_CALL_BOUND_MS`, pinned equal by test). */
export const PROVIDER_CALL_TIMEOUT_MS = 120_000;
/** Before the single retry of a 429 or 5xx answer. */
export const PROVIDER_RETRY_DELAY_MS = 2_000;
/** The most of a response body that is read; more is `malformed`, never buffered. */
export const PROVIDER_BODY_LIMIT = 4 * 1024 * 1024;

export const DEFAULT_MODEL_BOUNDS: ModelBounds = { maxSteps: 24, maxOutputTokens: 4096, tokenBudget: 400_000 };

const KIND_TEXT: Record<ModelProviderErrorKind, string> = {
	'4xx': 'Model provider answered 4xx',
	'5xx': 'Model provider answered 5xx',
	timeout: 'Model provider did not answer in time',
	network: 'Model provider could not be reached',
	malformed: 'Model provider answered with an unreadable response',
};

/** Names the HTTP status (no secret), and what to check for the two an operator can fix. */
function failureText(kind: ModelProviderErrorKind, status: number | undefined): string {
	if ((kind !== '4xx' && kind !== '5xx') || status === undefined) return KIND_TEXT[kind];
	const hint = status === 404
		? ": check the provider's base URL"
		: status === 401 || status === 403
		? ": check the provider's key"
		: '';
	return `Model provider answered ${status}${hint}`;
}

/**
 * The URL one provider call goes to — `resource` under the API's version root. `anthropic` adds `/v1` unless the path
 * already ends in it (SDK-style base URLs omit it); `openai` adds `/v1` only to a bare origin, because compatible APIs
 * version their roots freely (`/api/v1`, `/v1beta/openai`).
 */
export function providerEndpoint(kind: 'openai' | 'anthropic', baseUrl: string, resource: string): string {
	const root = baseUrl.replace(/\/+$/, '');
	const path = new URL(root).pathname.replace(/\/+$/, '');
	const versioned = kind === 'anthropic' ? /\/v1$/.test(path) : path !== '';
	return `${root}${versioned ? '' : '/v1'}/${resource}`;
}

/** A provider call that failed, by class only; `-32603` because the fault is the backend's. Never carries a body. */
export class ModelProviderError extends AgentError {
	constructor(
		public readonly kind: ModelProviderErrorKind,
		public readonly retryable: boolean,
		public readonly status?: number,
	) {
		super(-32603, failureText(kind, status));
		this.name = 'ModelProviderError';
	}
}

/** What both client factories take; `fetch` and the two bounds are overridden by tests only. */
export interface ModelClientOptions {
	readonly settings: ModelClientSettings;
	readonly fetch?: typeof fetch;
	readonly retryDelayMs?: number;
	readonly callTimeoutMs?: number;
}

/** Operator headers lower-cased, then the fixed ones, then the credential header — nothing can displace the key. */
export function requestHeaders(
	settings: ModelClientSettings,
	credential: Record<string, string>,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(settings.headers ?? {})) headers[name.toLowerCase()] = value;
	headers['content-type'] = 'application/json';
	headers['accept'] = 'application/json';
	return { ...headers, ...credential };
}

/** `headers` for a GET, which carries no body to describe. */
export function withoutContentType(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'content-type'));
}

/** The fields every client shares; each client adds `kind`, `complete` and `listModels`. */
export function clientBase(
	settings: ModelClientSettings,
): Pick<ModelProviderClient, 'id' | 'models' | 'defaultModel' | 'bounds' | 'redact'> {
	return {
		id: settings.id,
		models: [...settings.models],
		defaultModel: settings.defaultModel,
		bounds: {
			maxSteps: settings.maxSteps ?? DEFAULT_MODEL_BOUNDS.maxSteps,
			maxOutputTokens: settings.maxOutputTokens ?? DEFAULT_MODEL_BOUNDS.maxOutputTokens,
			tokenBudget: settings.tokenBudget ?? DEFAULT_MODEL_BOUNDS.tokenBudget,
		},
		redact: redactor(redactable([settings.apiKey])),
	};
}

/**
 * One provider call: POSTs `body` as JSON (or GETs when it is `undefined`) and returns the parsed object of a 2xx
 * answer. A 429 or 5xx is retried once; anything else fails at once. The caller's `signal` ends the call with its own
 * reason, so a cancelled task is reported as cancelled, never as a provider failure.
 */
export async function providerRequest(
	url: string,
	headers: Record<string, string>,
	body: unknown,
	signal: AbortSignal,
	options: Pick<ModelClientOptions, 'fetch' | 'retryDelayMs' | 'callTimeoutMs'>,
): Promise<Record<string, unknown>> {
	const dial = options.fetch ?? fetch;
	const init: RequestInit = body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body) };
	for (let attempt = 0;; attempt++) {
		signal.throwIfAborted();
		const bound = AbortSignal.any([signal, AbortSignal.timeout(options.callTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS)]);
		let response: Response;
		try {
			response = await dial(url, { ...init, headers, redirect: 'error', signal: bound });
		} catch {
			if (signal.aborted) throw signal.reason;
			// A refused redirect, a closed port, a TLS fault: none carries a body.
			throw new ModelProviderError(bound.aborted ? 'timeout' : 'network', false);
		}
		const malformed = new ModelProviderError('malformed', false, response.status);
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			const retryable = response.status === 429 || response.status >= 500;
			if (retryable && attempt === 0) {
				await delay(options.retryDelayMs ?? PROVIDER_RETRY_DELAY_MS, signal);
				continue;
			}
			throw new ModelProviderError(response.status >= 500 ? '5xx' : '4xx', retryable, response.status);
		}
		const declared = Number(response.headers.get('content-length') ?? '0');
		if (
			!/^application\/json\b/i.test((response.headers.get('content-type') ?? '').trim()) ||
			(Number.isFinite(declared) && declared > PROVIDER_BODY_LIMIT)
		) {
			await response.body?.cancel().catch(() => {});
			throw malformed;
		}
		let bytes: Uint8Array;
		try {
			bytes = response.body === null ? new Uint8Array() : await readCapped(response.body, PROVIDER_BODY_LIMIT, () => {
				throw malformed;
			});
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof ModelProviderError) throw error;
			throw new ModelProviderError(bound.aborted ? 'timeout' : 'network', false, response.status);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch {
			throw malformed;
		}
		const answer = plain(parsed);
		if (answer === undefined) throw malformed;
		return answer;
	}
}

/** `value` as a plain object, or `undefined`. */
export function plain(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A usage count as reported, or 0 when nothing usable was. */
export function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/** The most model ids a provider's list may name; a longer list is cut, never refused. */
export const MODEL_LIST_LIMIT = 500;

/**
 * The model ids in a `GET …/models` answer (`{ data: [{ id }] }`): trimmed, at most 256 characters, de-duplicated and
 * sorted. A body without a `data` array is `malformed`.
 */
export function modelIdsOf(body: Record<string, unknown>): string[] {
	if (!Array.isArray(body.data)) throw new ModelProviderError('malformed', false);
	const ids = new Set<string>();
	for (const entry of body.data) {
		const id = plain(entry)?.id;
		if (typeof id !== 'string') continue;
		const trimmed = id.trim();
		if (trimmed !== '' && trimmed.length <= 256) ids.add(trimmed);
		if (ids.size >= MODEL_LIST_LIMIT) break;
	}
	return [...ids].sort((a, b) => a.localeCompare(b));
}
