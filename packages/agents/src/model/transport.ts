/**
 * D-143 W2 (backend §2.2): the one HTTP transport under both provider clients. Every outbound provider call is a
 * `fetch` from this process (no SDK, G8), bounded the same way whichever wire format sits on top: `redirect: 'error'`
 * (the configured URL is the only one ever dialled, D-145), {@linkcode PROVIDER_CALL_TIMEOUT_MS} per call, a
 * {@linkcode PROVIDER_BODY_LIMIT} on the response, a `content-type` check before parsing, and one retry after
 * {@linkcode PROVIDER_RETRY_DELAY_MS} for 429 and 5xx only.
 *
 * A failure is a {@linkcode ModelProviderError} that carries the status class and nothing of the body: a provider's
 * 401 body may quote the key it was sent, so the body is never read into an error, a log line or a task message.
 */
import { AgentError } from '../util.ts';
import type { ModelBounds, ModelClientSettings, ModelProviderClient } from './types.ts';
import { redactable, redactor } from './redact.ts';

/** The status class or transport failure of a provider call. `malformed` covers content-type, size and shape. */
export type ModelProviderErrorKind = '4xx' | '5xx' | 'timeout' | 'network' | 'malformed';

/** Per call, the same bound a tool call has (`TOOL_CALL_BOUND_MS` in `runtime.ts`, pinned equal by test). */
export const PROVIDER_CALL_TIMEOUT_MS = 120_000;
/** Before the single retry of a 429 or 5xx answer. */
export const PROVIDER_RETRY_DELAY_MS = 2_000;
/** The most of a response body that is read; a provider answering more is `malformed`, never buffered. */
export const PROVIDER_BODY_LIMIT = 4 * 1024 * 1024;

/** Backend §2.1 defaults for the loop bounds a settings object leaves unset. */
export const DEFAULT_MODEL_BOUNDS: ModelBounds = { maxSteps: 24, maxOutputTokens: 4096, tokenBudget: 400_000 };

const KIND_TEXT: Record<ModelProviderErrorKind, string> = {
	'4xx': 'Model provider answered 4xx',
	'5xx': 'Model provider answered 5xx',
	timeout: 'Model provider did not answer in time',
	network: 'Model provider could not be reached',
	malformed: 'Model provider answered with an unreadable response',
};

/**
 * ERRATUM(E-120): the failure text names the HTTP status, and for the two an operator can fix in the provider's settings,
 * what to check. A status is no secret (the body still never travels); "answered 4xx" alone left a wrong `base_url`
 * (404) indistinguishable from a wrong key (401/403) or a wrong model name (400).
 */
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
 * ERRATUM(E-120): the URL one provider call goes to — `resource` (`chat/completions`, `messages`, `embeddings`) under
 * the API's version root. Providers publish their base URL in two conventions: with the version (`https://api.openai.com/v1`,
 * `http://127.0.0.1:8000/v1`) and without it, as the SDKs take it (`https://api.minimax.io/anthropic` — the Anthropic
 * SDK appends `/v1/messages`). Appending only `/messages` and `/chat/completions` sent both of the latter to a 404.
 *
 * - `anthropic`: `/v1` is added unless the path already ends in it — the Messages API has no other version root.
 * - `openai`: `/v1` is added only to a bare origin. A path is kept as written, because OpenAI-compatible APIs version
 *   their roots freely (`/api/v1`, `/openai/v1`, `/v1beta/openai`); a bare origin is a server's root, where vLLM,
 *   llama.cpp, Ollama, LiteLLM and OpenAI itself all serve under `/v1`.
 */
export function providerEndpoint(kind: 'openai' | 'anthropic', baseUrl: string, resource: string): string {
	const root = baseUrl.replace(/\/+$/, '');
	const path = new URL(root).pathname.replace(/\/+$/, '');
	const versioned = kind === 'anthropic' ? /\/v1$/.test(path) : path !== '';
	return `${root}${versioned ? '' : '/v1'}/${resource}`;
}

/**
 * A provider call that failed, by class only. `AgentError` so the runtime reports `message` as the task's failure
 * text; `-32603` because the fault is the backend's, not the caller's. The body is never attached.
 */
export class ModelProviderError extends AgentError {
	constructor(
		public readonly kind: ModelProviderErrorKind,
		public readonly retryable: boolean,
		/** The HTTP status for `4xx`/`5xx`, for a logger line; never a body. */
		public readonly status?: number,
	) {
		super(-32603, failureText(kind, status));
		this.name = 'ModelProviderError';
	}
}

/** What both client factories take. `fetch` is injected by tests; the two bounds are overridable for tests only. */
export interface ModelClientOptions {
	readonly settings: ModelClientSettings;
	readonly fetch?: typeof fetch;
	/** Tests: shorten the retry wait. Production never passes it. */
	readonly retryDelayMs?: number;
	/** Tests: shorten the per-call bound. Production never passes it. */
	readonly callTimeoutMs?: number;
}

/** The loop bounds from settings, defaults filled in. */
export function boundsOf(settings: ModelClientSettings): ModelBounds {
	return {
		maxSteps: settings.maxSteps ?? DEFAULT_MODEL_BOUNDS.maxSteps,
		maxOutputTokens: settings.maxOutputTokens ?? DEFAULT_MODEL_BOUNDS.maxOutputTokens,
		tokenBudget: settings.tokenBudget ?? DEFAULT_MODEL_BOUNDS.tokenBudget,
	};
}

/** Operator headers lower-cased, then the fixed ones, then the credential header — so nothing can displace the key. */
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

/** D-158: `headers` for a GET, which carries no body to describe. */
export function withoutContentType(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'content-type'));
}

/** The fields every client shares; each client adds `kind` and `complete`. */
export function clientBase(
	settings: ModelClientSettings,
): Pick<ModelProviderClient, 'id' | 'models' | 'defaultModel' | 'bounds' | 'redact'> {
	return {
		id: settings.id,
		models: [...settings.models],
		defaultModel: settings.defaultModel,
		bounds: boundsOf(settings),
		redact: redactor(redactable([settings.apiKey])),
	};
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500;
}

/** Waits `ms`, or throws the signal's reason first: a cancel during the retry wait ends the task at once. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, ms);
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener('abort', abort, { once: true });
	});
}

/** Reads at most {@linkcode PROVIDER_BODY_LIMIT} bytes; one more is `malformed`, and the rest is never buffered. */
async function readBody(response: Response): Promise<Uint8Array> {
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > PROVIDER_BODY_LIMIT) {
		await response.body?.cancel().catch(() => {});
		throw new ModelProviderError('malformed', false, response.status);
	}
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > PROVIDER_BODY_LIMIT) throw new ModelProviderError('malformed', false, response.status);
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

/**
 * One provider call: POSTs `body` as JSON — or, with `body` `undefined`, GETs (D-158: the model list) — and returns
 * the parsed JSON object of a 2xx answer. A 429 or 5xx is retried
 * once after the delay; a 4xx, a timeout, a network fault (a refused redirect among them) and a malformed answer are
 * thrown at once. The caller's `signal` ends the call immediately with its own reason, so a cancelled task is
 * reported as cancelled and never as a provider failure.
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
			if (bound.aborted) throw new ModelProviderError('timeout', false);
			// A refused redirect, a closed port, a TLS fault: all `TypeError`s from fetch, none carrying a body.
			throw new ModelProviderError('network', false);
		}
		if (!response.ok) {
			// The body of an error answer is never read: a 401 body may quote the credential it was sent.
			await response.body?.cancel().catch(() => {});
			const retryable = isRetryable(response.status);
			if (retryable && attempt === 0) {
				await delay(options.retryDelayMs ?? PROVIDER_RETRY_DELAY_MS, signal);
				continue;
			}
			throw new ModelProviderError(response.status >= 500 ? '5xx' : '4xx', retryable, response.status);
		}
		const type = response.headers.get('content-type') ?? '';
		if (!/^application\/json\b/i.test(type.trim())) {
			await response.body?.cancel().catch(() => {});
			throw new ModelProviderError('malformed', false, response.status);
		}
		let bytes: Uint8Array;
		try {
			bytes = await readBody(response);
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof ModelProviderError) throw error;
			throw new ModelProviderError(bound.aborted ? 'timeout' : 'network', false, response.status);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch {
			throw new ModelProviderError('malformed', false, response.status);
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new ModelProviderError('malformed', false, response.status);
		}
		return parsed as Record<string, unknown>;
	}
}

/** `value` as a plain object, or `undefined`; the clients map responses defensively and answer `malformed`. */
export function plain(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A usage count as the provider reported it, or 0 when it reported nothing usable. */
export function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/** D-158: the most model ids a provider's list may name; a longer list is cut, never refused. */
export const MODEL_LIST_LIMIT = 500;

/**
 * D-158: the model ids in a `GET …/models` answer — `{ data: [{ id }] }`, the shape OpenAI, every OpenAI-compatible
 * server and Anthropic share. Ids are trimmed, at most 256 characters, de-duplicated and sorted; anything else in an
 * entry is ignored. A body without a `data` array is `malformed`.
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
