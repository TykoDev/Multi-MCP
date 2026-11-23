/**
 * HTTP client for the SPA.
 *
 * The sign-in lives in an **HttpOnly cookie** this page cannot read, so no script here — ours or an injected one —
 * can carry the session off. The page holds only the CSRF value the server derived from the session, in memory,
 * echoed as `x-ttk-csrf` on every state-changing request. Nothing is read from or written to storage. A reload asks
 * `GET /api/v1/auth/me` whether the cookie still signs it in and recovers the CSRF value from the answer.
 */

import type { A2uiAction, A2uiSurface } from '@tykotech/wire';

export interface UserInfo {
	id: string;
	username?: string;
	kind?: string;
	scopes: string[];
	label?: string | null;
	/** What the sign-in stands on, when known: `user` (a password), `user-key` (an account's key) or `api-key`. */
	backing?: string;
}

function userOf(me: MeResponse): UserInfo {
	return me.session === undefined ? me.user : { ...me.user, backing: me.session.backing };
}

/** The header the server checks a cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` for. */
export const CSRF_HEADER = 'x-ttk-csrf';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let signedIn = false;
let csrf: string | null = null;
let user: UserInfo | null = null;
const unauthorizedHooks: Array<() => void> = [];

/** Records a cookie sign-in: the CSRF value the server derived from it and, when known, who it is. */
export function setSession(session: { csrf: string; user?: UserInfo | null }): void {
	signedIn = true;
	csrf = session.csrf;
	if (session.user !== undefined) user = session.user;
}

/**
 * Asks whether this browser's cookie still signs it in. Only an answer carrying a CSRF value is a cookie sign-in: the
 * credential-less loopback principal answers `me` too, and is not one.
 */
export async function restoreSession(): Promise<boolean> {
	try {
		const me = await request<MeResponse>('/api/v1/auth/me');
		if (typeof me.csrf !== 'string') return false;
		setSession({ csrf: me.csrf, user: userOf(me) });
		return true;
	} catch {
		return false;
	}
}

export function isSignedIn(): boolean {
	return signedIn;
}

/** True when the page holds a sign-in session — every sign-in it can hold, by password or by key. */
export function hasSession(): boolean {
	return signedIn;
}

/** Forgets the sign-in on this page. The cookie itself is the server's to clear. */
export function clearSession(): void {
	signedIn = false;
	csrf = null;
	user = null;
}

export type SignOutOutcome =
	| { readonly kind: 'signed-out' }
	| { readonly kind: 'failed'; readonly message: string; readonly retryAfterMs: number | null };

/**
 * Ends the sign-in, and says whether the **server** confirmed it. The cookie is HttpOnly: only the server's answer
 * removes it. So the page forgets its sign-in only on `2xx` or `401`; any other refusal (rate limit, network, server
 * error) leaves it signed in, as the browser still is — clearing it anyway would say "signed out" while a reload
 * signed straight back in.
 */
export async function endSession(): Promise<SignOutOutcome> {
	try {
		await send('/api/v1/auth/logout', { method: 'POST' });
	} catch (cause) {
		if (cause instanceof ApiError && cause.status === 401) {
			clearSession();
			return { kind: 'signed-out' };
		}
		return {
			kind: 'failed',
			message: cause instanceof Error ? cause.message : String(cause),
			retryAfterMs: cause instanceof ApiError ? cause.retryAfterMs : null,
		};
	}
	clearSession();
	return { kind: 'signed-out' };
}

/** Registers what to do when the held session is refused (expired, revoked, or the account is gone). */
export function onUnauthorized(hook: () => void): void {
	unauthorizedHooks.push(hook);
}

export function getUser(): UserInfo | null {
	return user;
}

export function setUser(u: UserInfo | null): void {
	user = u;
}

let pendingUser: Promise<UserInfo | null> | null = null;

/** The signed-in user, asked of the server once when a reload restored only the sign-in. */
export function loadUser(): Promise<UserInfo | null> {
	if (user !== null || !signedIn) return Promise.resolve(user);
	pendingUser ??= request<MeResponse>('/api/v1/auth/me')
		.then((me) => {
			user = userOf(me);
			return user;
		})
		.catch(() => null)
		.finally(() => {
			pendingUser = null;
		});
	return pendingUser;
}

export interface ProblemDetail {
	type?: string;
	title?: string;
	status?: number;
	detail?: string;
}

/** An HTTP failure carrying the server's problem document when there was one. */
export class ApiError extends Error {
	readonly status: number;
	readonly problem: ProblemDetail | null;
	/** `Retry-After` in milliseconds, when the server sent one. */
	readonly retryAfterMs: number | null;

	constructor(status: number, problem: ProblemDetail | null, fallback: string, retryAfterMs: number | null = null) {
		super(problem?.detail ?? problem?.title ?? fallback);
		this.name = 'ApiError';
		this.status = status;
		this.problem = problem;
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * `Retry-After` delta-seconds in ms, capped at the ten-minute recovery window; `null` if absent or not a delta. The
 * HTTP-date form is not honoured: it would mean trusting this browser's clock to agree with the server's.
 */
export function retryAfterMsOf(headers: Headers): number | null {
	const raw = headers.get('retry-after');
	if (raw === null) return null;
	const seconds = Number(raw.trim());
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return Math.min(seconds, 600) * 1000;
}

const CSRF_FAILED = 'https://tykotech.eu/problems/csrf-failed';

/**
 * One authenticated request, failing with an {@linkcode ApiError} on any non-2xx — the single place the credential
 * is attached: the cookie by the browser (same-origin only), the CSRF value here on every state-changing method.
 */
export async function send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
	const headers = new Headers(init.headers);
	// A typed body keeps its type: a share upload sent as JSON would be parsed as JSON and skip the upload's own cap.
	if (init.body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
	const method = (init.method ?? 'GET').toUpperCase();
	if (csrf !== null && UNSAFE_METHODS.has(method)) headers.set(CSRF_HEADER, csrf);

	const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
	if (!response.ok) {
		let problem: ProblemDetail | null = null;
		try {
			problem = await response.json() as ProblemDetail;
		} catch {
			// Not every failure carries a problem document.
		}
		// A sign-in in another tab replaced the cookie, so this page's CSRF value is stale: ask once and resend.
		if (response.status === 403 && problem?.type === CSRF_FAILED && signedIn && !retried) {
			if (await restoreSession()) return await send(path, init, true);
		}
		// A refused session is gone for good. The login route answers 401 for a wrong password, which signs nobody out.
		if (response.status === 401 && signedIn && path !== '/api/v1/auth/login') {
			clearSession();
			for (const hook of unauthorizedHooks) hook();
		}
		throw new ApiError(
			response.status,
			problem,
			`${response.status} ${response.statusText}`,
			retryAfterMsOf(response.headers),
		);
	}
	return response;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await send(path, init);
	if (response.status === 204) return undefined as T;
	return await response.json() as T;
}

/**
 * Reads a `text/event-stream` response as it arrives, calling `onEvent` per record — through {@linkcode send}, not
 * an `EventSource`, so every request is attached and refused in one place. Resolves when the stream ends or aborts.
 */
export async function streamEvents(
	path: string,
	onEvent: (kind: string, data: string, id: string | null) => void,
	signal: AbortSignal,
): Promise<void> {
	const response = await send(path, { signal, headers: { accept: 'text/event-stream' } });
	const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
	if (reader === undefined) return;
	let buffer = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += value;
			let end: number;
			while ((end = buffer.indexOf('\n\n')) !== -1) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				let kind = 'message';
				let id: string | null = null;
				const data: string[] = [];
				for (const line of block.split('\n')) {
					if (line.startsWith('event:')) kind = line.slice(6).trim();
					else if (line.startsWith('id:')) id = line.slice(3).trim();
					else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
				}
				if (data.length > 0) onEvent(kind, data.join('\n'), id);
			}
		}
	} catch (cause) {
		if (!signal.aborted) throw cause;
	}
}

/**
 * Fetches an authenticated download and hands it to the browser as a file, through a short-lived object URL, so a
 * failure is reported in the page instead of navigating the tab to a problem document.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
	const response = await send(path);
	const disposition = response.headers.get('content-disposition') ?? '';
	const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
	const url = URL.createObjectURL(await response.blob());
	const link = document.createElement('a');
	link.href = url;
	link.download = named === undefined ? fallbackName : decodeURIComponent(named);
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export interface SessionSummary {
	session_id: string;
	label?: string;
	created_at: string;
	last_used_at: string;
	tab_count: number;
	viewer_count: number;
	human_has_control: boolean;
	/** `<kind>:<id>`; sent only in owner mode, to an admin. */
	owner?: string;
}

export interface Ticket {
	ticket: string;
	session_id: string;
	expires_in: number;
	mode: 'watch' | 'control';
}

/** What every task carries: its kind, and for the built-in agent the provider and model it ran on. */
export interface AgentTaskMetadata {
	kind: 'text' | 'tool' | 'delegation';
	provider?: string;
	model?: string;
	backend?: 'model';
	steps?: number;
	usage?: { input: number; output: number };
	/** The built-in profile that ran a text task (`sloplord`). */
	agent?: string;
}

/** A2A task data shown to its owner only. */
export interface AgentTaskSummary {
	id: string;
	contextId?: string;
	status: { state: string; timestamp: string; message?: { parts: Array<{ text?: string }> } };
	artifacts: Array<{ name?: string; parts?: Array<{ text?: string; data?: unknown }> }>;
	/** The conversation, newest last: the request first, then the agent's own reply. */
	history?: Array<{ role?: string; parts: Array<{ text?: string; data?: unknown }> }>;
	metadata?: AgentTaskMetadata;
}

/** One model provider as `GET /api/v1/agent/providers` shows it: never a key, a URL path or a header. */
export interface ProviderInfo {
	id: string;
	kind: string;
	label: string;
	models: string[];
	default_model: string | null;
	reachable: boolean;
	host?: string;
	reason?: string;
}

export interface ProvidersResponse {
	/** The caller's own `model:invoke`. */
	invocable: boolean;
	default: string | null;
	/** The built-in agent's own default model, when an administrator chose one still in force. */
	agent_default?: { provider: string; model: string };
	providers: ProviderInfo[];
	/** The built-in agent profiles (SlopLord). */
	agents?: Array<{ id: string; name: string; description: string; available: boolean; card_url: string }>;
}

/** One model provider as the admin route shows it — every setting but a key, whose source alone is told. */
export interface ManagedProvider {
	id: string;
	kind: 'openai' | 'anthropic';
	label: string;
	base_url: string;
	models: string[];
	default_model: string;
	headers: Record<string, string>;
	allow_http: boolean;
	max_tokens_param: 'max_tokens' | 'max_completion_tokens';
	max_steps: number;
	max_output_tokens: number;
	token_budget: number;
	origin: 'seed' | 'admin';
	key: { source: 'stored' | 'file' | 'inline' | 'none' };
	host: string;
	reachable: boolean;
	reason?: string;
}

/** `GET /api/v1/system/model-providers`: the seed file, the database that holds the providers, and the providers. */
export interface ModelProvidersConfig {
	seed: { file: string | null; seeded_at: string | null };
	store: { available: boolean; reason?: string; database: string | null; vault: 'unlocked' | 'locked' | 'none' };
	default: string | null;
	providers: ManagedProvider[];
}

/** How a provider's key is written — kept as sealed, typed here (sealed, never shown again), or none. */
export type ProviderKeyInput = { mode: 'keep' } | { mode: 'set'; value: string } | { mode: 'none' };

/** A provider as the editor holds it, for `POST /api/v1/system/model-providers/models`. */
export interface ModelsProbeInput {
	id: string;
	kind: 'openai' | 'anthropic';
	base_url: string;
	headers?: Record<string, string>;
	allow_http?: boolean;
	key: ProviderKeyInput;
}

/** One provider in `PUT /api/v1/system/model-providers`. */
export interface ProviderInput {
	id: string;
	kind: 'openai' | 'anthropic';
	label?: string;
	base_url: string;
	models: string[];
	default_model?: string;
	headers?: Record<string, string>;
	allow_http?: boolean;
	max_tokens_param?: 'max_tokens' | 'max_completion_tokens';
	max_steps?: number;
	max_output_tokens?: number;
	token_budget?: number;
	key: ProviderKeyInput;
}

/** The whole provider list as the PUT replaces it. */
export interface ModelProvidersStoreInput {
	default?: string | null;
	providers: ProviderInput[];
}

/** `POST /api/v1/agent/tasks`: a text task, optionally on a named provider and model, or a built-in profile. */
export interface CreateAgentTaskBody {
	message: string;
	provider?: string;
	model?: string;
	agent?: string;
}

/** `GET /api/v1/system/usage`: each browser's memory against the limits. */
export interface SystemMemory {
	/** False while no browser has answered a memory dump. */
	measured: boolean;
	container: { limit_bytes: number | null; used_bytes: number | null };
	gateway: { rss_bytes: number; heap_used_bytes: number; heap_total_bytes: number; heap_limit_bytes: number };
	browsers_private_bytes: number;
	limits: { max_sessions: number; session_ttl_s: number };
	sessions: Array<{
		session_id: string;
		idle_seconds: number;
		idle_timeout_s: number;
		memory: { private_bytes: number; processes: number } | null;
	}>;
}

/** `GET /api/v1/system/diagnostics`, as far as the System screen reads it; newer keys are read defensively. */
export interface SystemDiagnostics {
	version: string;
	uptimeSeconds: number;
	sessions: { total: number };
	config: {
		publicUrl: string;
		apiKeysCount: number;
		accountKeysCount?: number;
		hasAdminUser: boolean;
		egressEnabled: boolean;
		persistenceEnabled: boolean;
		recordingEnabled: boolean;
		sandboxEnabled: boolean;
	};
}

/** One account as the Users screen sees it: never any password material. */
export interface PublicUser {
	username: string;
	scopes: string[];
	disabled: boolean;
	created_at: string;
	updated_at: string;
	/** Open sign-ins. */
	sessions: number;
	/** The caller's own account. */
	self: boolean;
	keys?: AccountKey[];
}

/** One API key an account holds: never its hash, and never the key itself after the response that minted it. */
export interface AccountKey {
	id: string;
	label: string | null;
	/** The key's first characters, enough to tell two keys apart. */
	prefix: string;
	scopes: string[];
	created_at: string;
}

/** A key the server just minted: its record, and the key itself — present in this one response only. */
export interface MintedKey {
	key: AccountKey;
	secret: string;
}

export interface NewKey {
	label?: string;
	scopes?: string[];
}

/** One scope as the server declares it: the vocabulary is never restated in the SPA. */
export interface ScopeInfo {
	scope: string;
	grants: string;
	default: boolean;
	/** Never implied; held only when named. */
	explicit: boolean;
}

export interface UsersResponse {
	users: PublicUser[];
	store: { writable: boolean; status: string };
	login_ttl_s: number;
	vocabulary: ScopeInfo[];
}

/** A cookie sign-in's answer: no token — the cookie holds it — and the CSRF value to echo. */
export interface LoginResponse {
	expires?: number;
	user: UserInfo;
	csrf?: string;
}

export interface MeResponse {
	user: UserInfo;
	session?: { expires: number; backing: string };
	/** Present only when the request was authenticated by the sign-in cookie. */
	csrf?: string;
}

/** One entry of the file share listing. */
export interface ShareEntry {
	name: string;
	path: string;
	kind: 'file' | 'directory';
	size: number;
	modified_at: string | null;
}

const enc = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
	shareList: (path: string) =>
		request<{ path: string; entries: ShareEntry[]; truncated: boolean }>(`/api/v1/share?path=${enc(path)}`),
	shareFilePath: (path: string) => `/api/v1/share/file?path=${enc(path)}`,
	shareUpload: async (path: string, file: Blob): Promise<ShareEntry> => {
		const response = await send(`/api/v1/share/file?path=${enc(path)}`, {
			method: 'PUT',
			body: file,
			headers: { 'content-type': 'application/octet-stream' },
		});
		return await response.json() as ShareEntry;
	},
	shareMkdir: (path: string) => request<ShareEntry>('/api/v1/share/mkdir', json('POST', { path })),
	shareMove: (from: string, to: string) => request<ShareEntry>('/api/v1/share/move', json('POST', { from, to })),
	shareDelete: (path: string, recursive = false) =>
		request<void>(`/api/v1/share?path=${enc(path)}${recursive ? '&recursive=true' : ''}`, { method: 'DELETE' }),
	openSandboxSession: (workspaceId: string, network: 'none' | 'registries') =>
		request<{ session_id: string; created_at: string }>(
			'/api/v1/sandbox/sessions',
			json('POST', { workspace_id: workspaceId, network }),
		),
	sandboxSessionInput: (sessionId: string, data: string) =>
		request<{ accepted: true }>(`/api/v1/sandbox/sessions/${enc(sessionId)}/input`, json('POST', { data })),
	closeSandboxSession: (sessionId: string) =>
		request<void>(`/api/v1/sandbox/sessions/${enc(sessionId)}`, { method: 'DELETE' }),
	sandboxSessionEventsPath: (sessionId: string, after = 0) =>
		`/api/v1/sandbox/sessions/${enc(sessionId)}/events?after=${after}`,
	// Always a cookie sign-in; the browser sends this page's Origin, which the server requires for one.
	login: (credentials: { username?: string; password?: string; apiKey?: string }) =>
		request<LoginResponse>('/api/v1/auth/login', json('POST', { ...credentials, session: 'cookie' })),
	changePassword: (current: string, next: string) =>
		request<void>('/api/v1/auth/password', json('POST', { current, next })),
	listUsers: () => request<UsersResponse>('/api/v1/users'),
	/** `api_key` issues the new account its first key, returned once beside any generated password. */
	createUser: (input: { username: string; password?: string; scopes?: string[]; api_key?: NewKey }) =>
		request<{ user: PublicUser; password?: string; api_key?: MintedKey }>('/api/v1/users', json('POST', input)),
	createUserKey: (username: string, input: NewKey) =>
		request<MintedKey>(`/api/v1/users/${enc(username)}/keys`, json('POST', input)),
	deleteUserKey: (username: string, id: string) =>
		request<void>(`/api/v1/users/${enc(username)}/keys/${enc(id)}`, { method: 'DELETE' }),
	updateUser: (username: string, patch: { scopes?: string[]; disabled?: boolean }) =>
		request<{ user: PublicUser }>(`/api/v1/users/${enc(username)}`, json('PATCH', patch)),
	deleteUser: (username: string) => request<void>(`/api/v1/users/${enc(username)}`, { method: 'DELETE' }),
	resetPassword: (username: string, password?: string) =>
		request<{ password?: string }>(
			`/api/v1/users/${enc(username)}/password`,
			json('POST', password === undefined ? {} : { password }),
		),
	signOutEverywhere: (username: string) =>
		request<{ closed: number }>(`/api/v1/users/${enc(username)}/sessions`, { method: 'DELETE' }),
	listSessions: () => request<{ sessions: SessionSummary[] }>('/api/v1/sessions'),
	createSession: () =>
		request<{ session_id: string; created_at: string; status: string }>('/api/v1/sessions', json('POST', {})),
	closeSession: (sessionId: string) => request<void>(`/api/v1/sessions/${enc(sessionId)}`, { method: 'DELETE' }),
	mintTicket: (sessionId?: string) =>
		request<Ticket>('/api/v1/live/ticket', json('POST', sessionId === undefined ? {} : { session_id: sessionId })),
	diagnostics: () => request<SystemDiagnostics>('/api/v1/system/diagnostics'),
	systemMemory: () => request<SystemMemory>('/api/v1/system/usage'),
	/** Your tasks, newest first. */
	listAgentTasks: () => request<{ tasks: AgentTaskSummary[] }>('/api/v1/agent/tasks'),
	getAgentTask: (taskId: string) => request<{ task: AgentTaskSummary }>(`/api/v1/agent/tasks/${enc(taskId)}`),
	cancelAgentTask: (taskId: string) => request<unknown>(`/api/v1/agent/tasks/${enc(taskId)}/cancel`, json('POST', {})),
	/** A text task; a refusal arrives as a problem document whose `detail` is the runtime's own words. */
	createAgentTask: (body: CreateAgentTaskBody) =>
		request<{ task: AgentTaskSummary }>('/api/v1/agent/tasks', json('POST', body)),
	listProviders: () => request<ProvidersResponse>('/api/v1/agent/providers'),
	modelProviders: () => request<ModelProvidersConfig>('/api/v1/system/model-providers'),
	/** Replaces the provider list (keys written write-only) and applies it to the running gateway. */
	saveModelProviders: (body: ModelProvidersStoreInput) =>
		request<ModelProvidersConfig>('/api/v1/system/model-providers', json('PUT', body)),
	/** The models a provider lists (admin); dials only a saved provider's host. */
	listProviderModels: (body: ModelsProbeInput) =>
		request<{ models: string[] }>('/api/v1/system/model-providers/models', json('POST', body)),
	listSurfaces: () => request<{ surfaces: A2uiSurface[] }>('/api/v1/a2ui/surfaces'),
	deleteSurface: (surfaceId: string) =>
		request<unknown>(`/api/v1/a2ui/surfaces/${enc(surfaceId)}`, { method: 'DELETE' }),
	surfaceAction: (event: A2uiAction) => request<unknown>('/api/v1/a2ui/actions', json('POST', event)),
};
