/**
 * HTTP client for the live-view SPA.
 *
 * B4 / D-097: the sign-in lives in an **HttpOnly cookie** the server sets and
 * this page cannot read, so no script running here — ours or an injected one —
 * can carry the session off. The page holds nothing secret: only the CSRF value
 * the server derived from the session, kept in memory and echoed as
 * `x-ttk-csrf` on every state-changing request, which is how the server tells
 * this page's requests from a forged one riding the same cookie. Nothing is
 * written to storage (the one key an earlier release wrote is retired at load).
 * A reload asks the server (`GET /api/v1/auth/me`) whether the cookie still
 * signs it in, and recovers the CSRF value from the answer. A raw API key or
 * password never outlives the sign-in request that sent it.
 */

import type { A2uiAction, A2uiSurface } from '@tykotech/wire';

export interface UserInfo {
	id: string;
	username?: string;
	kind?: string;
	scopes: string[];
	label?: string | null;
	/**
	 * What this browser's sign-in stands on, when known: `user` (a password), `user-key` (an account's own API key,
	 * D-146, which names the account as a password sign-in does) or `api-key` (a configured key). Read from
	 * `GET /api/v1/auth/me`'s `session.backing`, or set by the sign-in form from the path it took.
	 */
	backing?: string;
}

/** The user `GET /api/v1/auth/me` describes, with its sign-in's backing folded in. */
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
 * The key D-073 kept a `ttks_` token under. A browser upgraded from that release still holds a live token there,
 * readable by page script for the rest of its seven-day life, so it is revoked and removed once at load (B4). This
 * module reads and removes that one key and never writes storage.
 */
export const LEGACY_LOGIN_KEY = 'ttk.login';

async function retireLegacyLogin(): Promise<void> {
	let legacy: string | null = null;
	try {
		legacy = globalThis.localStorage?.getItem(LEGACY_LOGIN_KEY) ?? null;
		if (legacy !== null) globalThis.localStorage?.removeItem(LEGACY_LOGIN_KEY);
	} catch {
		// Storage absent or blocked: nothing can have been kept there either.
		return;
	}
	if (legacy === null || !/^ttks_[A-Za-z0-9_]+$/.test(legacy)) return;
	// Ended on the server too, so a copy taken before the upgrade dies with it. Best effort: a token the server no
	// longer knows answers 401, which changes nothing here. As a bearer, the logout needs no CSRF value and leaves
	// any cookie sign-in alone.
	await fetch('/api/v1/auth/logout', {
		method: 'POST',
		headers: { authorization: `Bearer ${legacy}` },
		credentials: 'omit',
	}).then((response) => response.body?.cancel()).catch(() => {});
}

/**
 * Asks the server whether this browser's cookie still signs it in, before the first render. Only an answer that
 * carries a CSRF value is a cookie sign-in: the credential-less loopback principal answers `me` too, and is not one.
 */
export async function restoreSession(): Promise<boolean> {
	await retireLegacyLogin();
	try {
		const me = await request<MeResponse>('/api/v1/auth/me');
		if (typeof me.csrf !== 'string') return false;
		setSession({ csrf: me.csrf, user: userOf(me) });
		return true;
	} catch {
		return false;
	}
}

/** Whether this page is signed in (its cookie was accepted at sign-in or at load). */
export function isSignedIn(): boolean {
	return signedIn;
}

/**
 * True when the page is signed in through a sign-in session — which, since the cookie (B4), is every sign-in this
 * page can hold: a password and an API key both open one.
 */
export function hasSession(): boolean {
	return signedIn;
}

/** Forgets the sign-in on this page. The cookie itself is the server's to clear (`POST /api/v1/auth/logout`). */
export function clearSession(): void {
	signedIn = false;
	csrf = null;
	user = null;
}

/** What a sign-out achieved (R1-3). */
export type SignOutOutcome =
	| { readonly kind: 'signed-out' }
	| { readonly kind: 'failed'; readonly message: string; readonly retryAfterMs: number | null };

/**
 * Ends this browser's sign-in, and says whether the **server** confirmed it (R1-3).
 *
 * The cookie is HttpOnly: only the server's answer can remove it, and only the server can end the session behind
 * it. So the page forgets its sign-in only when the server said so — `2xx`, or `401` (the server no longer honours
 * the cookie at all, and cleared it with the refusal). A refusal for any other reason (the rate limiter, a network
 * failure, a server error) leaves the page signed in, as the browser still is, and hands the caller what to show
 * and how long the server asked it to wait. Clearing the page regardless, as before, told the user "signed out"
 * while a reload signed them straight back in.
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

/**
 * The signed-in user, asked of the server once when a reload restored only the
 * sign-in token: screens that decide what to offer from the scopes wait for it
 * rather than read an empty cache and offer nothing.
 */
export function loadUser(): Promise<UserInfo | null> {
	if (user !== null || !signedIn) return Promise.resolve(user);
	pendingUser ??= api.me()
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
	/**
	 * `Retry-After` in milliseconds, when the server sent one (F3).
	 *
	 * Only the delta-seconds form is read. The HTTP-date form is legal but the
	 * server never sends it, and honouring a date would mean trusting the
	 * client's clock to agree with the server's about *now*.
	 */
	readonly retryAfterMs: number | null;

	constructor(status: number, problem: ProblemDetail | null, fallback: string, retryAfterMs: number | null = null) {
		super(problem?.detail ?? problem?.title ?? fallback);
		this.name = 'ApiError';
		this.status = status;
		this.problem = problem;
		this.retryAfterMs = retryAfterMs;
	}
}

/** Parses `Retry-After` delta-seconds into ms, or `null` if absent or not a delta. */
export function retryAfterMsOf(headers: Headers): number | null {
	const raw = headers.get('retry-after');
	if (raw === null) return null;
	const seconds = Number(raw.trim());
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	// A server that says "retry in an hour" is not a server this page should wait
	// an hour for; the recovery window is ten minutes and the value is advisory.
	return Math.min(seconds, 600) * 1000;
}

/** The problem type the server answers a cookie request whose CSRF proof did not match. */
const CSRF_FAILED = 'https://tykotech.eu/problems/csrf-failed';

/**
 * One authenticated request, failing with an {@linkcode ApiError} on any non-2xx.
 *
 * The single place the credential is attached: the cookie by the browser (same-origin only), the CSRF value by this
 * function on every state-changing method. The MCP client, the event streams and file downloads all go through it,
 * so the CSRF value never appears in a URL and never leaves this module's variable.
 */
export async function send(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
	const headers = new Headers(init.headers);
	// R1-6: a body the caller typed keeps its type. Overwriting it sent every share upload as JSON, which the server
	// then parsed as JSON — refusing any file that was not — and which bypassed the upload's own size cap.
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
		// A sign-in in another tab replaced this browser's cookie, so the CSRF value this page holds belongs to a
		// session the cookie no longer carries. The current value is asked for once and the request sent again.
		if (response.status === 403 && problem?.type === CSRF_FAILED && signedIn && !retried) {
			if (await restoreSession()) return await send(path, init, true);
		}
		// A refused session is gone for good — the server ended it — so it is forgotten here rather than
		// presented again on every screen. The login route itself answers 401 for a wrong password; that
		// request carries no session and must not sign anyone out.
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
 * Reads a `text/event-stream` response as it arrives, calling `onEvent` per record.
 *
 * Read from the body of an ordinary `fetch` through {@linkcode send} rather than an `EventSource`, so every request
 * this page makes is attached and refused in one place. Resolves when the server ends the stream or `signal` aborts
 * it.
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
 * Fetches an authenticated download and hands it to the browser as a file.
 *
 * The bytes go through a short-lived object URL rather than a link to the API, so a failure (a refused session, a
 * vanished file) is reported in the page instead of navigating the tab to a problem document.
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
	/**
	 * Who the session belongs to (`<kind>:<id>`, e.g. `api-key:alice`). Sent only in `TTK_SESSION_OWNERSHIP=owner` mode
	 * and only to an `admin` caller, who lists every principal's sessions (R8, RV-7); absent otherwise.
	 */
	owner?: string;
}

export interface Health {
	status: string;
	version: string;
	sessions: number;
}

export interface Ticket {
	ticket: string;
	session_id: string;
	expires_in: number;
	mode: 'watch' | 'control';
}

/**
 * D-143 (addendum A): what every task carries from `TASK_STATE_SUBMITTED` on, so a card reads its kind and backend
 * without parsing history. `provider`/`model` are the resolved ids, only when the built-in agent runs the task;
 * `steps`/`usage` are written by the model loop as it runs.
 */
export interface AgentTaskMetadata {
	kind: 'text' | 'tool' | 'delegation';
	provider?: string;
	model?: string;
	backend?: 'model' | 'acp';
	steps?: number;
	usage?: { input: number; output: number };
	/** D-156: the built-in profile that ran a text task (`sloplord`); absent for the plain built-in agent and ACP. */
	agent?: string;
}

/** A2A task data shown to its authenticated owner only. */
export interface AgentTaskSummary {
	id: string;
	status: { state: string; timestamp: string; message?: { parts: Array<{ text?: string }> } };
	artifacts: Array<{ name?: string; parts?: Array<{ text?: string; data?: unknown }> }>;
	/** The conversation, newest last: the request first, then decisions and (E-5) the agent's own reply. */
	history?: Array<{ role?: string; parts: Array<{ text?: string; data?: unknown }> }>;
	/** Absent only on a task persisted before D-143; `task_kinds.ts` then reads the kind from the history. */
	metadata?: AgentTaskMetadata;
	permission?: {
		id: string;
		params: { options?: Array<{ optionId: string; name: string; kind: string }>; toolCall?: { title?: string } };
		expires: number;
	};
}

/** One A2A message part the composer sends: text, or a structured `{tool, arguments}` data part. */
export interface AgentMessagePart {
	text?: string;
	data?: unknown;
}

/**
 * One configured model provider as `GET /api/v1/agent/providers` shows it (D-143 §3.3): never a key, a URL path or a
 * header. `host` and `reason` are told only to a caller holding `model:invoke` (`invocable`).
 */
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
	/** An ACP bridge is configured (C3) and (D-158) takes text tasks: an administrator may switch it off. */
	acp: boolean;
	default: string | null;
	/** D-158: the built-in agent's own default model, when an administrator chose one still in force. */
	agent_default?: { provider: string; model: string };
	providers: ProviderInfo[];
	/** D-156: the built-in agent profiles (SlopLord); absent from a gateway before D-156. */
	agents?: BuiltinAgentInfo[];
}

/** D-156: one built-in agent profile as `GET /api/v1/agent/providers` lists it. */
export interface BuiltinAgentInfo {
	id: string;
	name: string;
	description: string;
	/** A reachable model provider and (SlopLord) the coding sandbox exist here; the caller's scopes are judged on send. */
	available: boolean;
	/** Its public A2A card, absolute. */
	card_url: string;
}

/**
 * D-154: one model provider as the admin route shows it — every setting but a key, whose source alone is told:
 * `stored` (sealed in the database's vault, never returned), `inline`/`file` (the providers file, used as is without a
 * database) or `none`. `origin` says where the row came from: seeded from the providers file, or added here.
 */
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

/**
 * D-154: `GET /api/v1/system/model-providers` — the providers file (a seed, never written), the database that holds
 * the providers in force, its vault's state, and the providers.
 */
export interface ModelProvidersConfig {
	seed: { file: string | null; seeded_at: string | null };
	store: {
		available: boolean;
		reason?: string;
		database: string | null;
		/** `unlocked`: keys can be stored. `locked`: no TTK_DB_KEY_FILE. `none`: no database. */
		vault: 'unlocked' | 'locked' | 'none';
	};
	default: string | null;
	providers: ManagedProvider[];
}

/** D-154: how a provider's key is written — kept as sealed, typed here (sealed, never shown again), or none. */
export type ProviderKeyInput = { mode: 'keep' } | { mode: 'set'; value: string } | { mode: 'none' };

/** D-158: one agent's settings (`@tykotech/agents` `AgentSetting`). */
export interface AgentSetting {
	model: { provider: string; model: string } | null;
	a2a: boolean;
	acp: boolean;
	a2ui: boolean;
	memory: boolean;
}

/** D-158: one agent as `GET /api/v1/system/agents` lists it. */
export interface ManagedAgent {
	id: string;
	name: string;
	description: string;
	kind: 'builtin' | 'profile' | 'acp' | 'peer';
	available: boolean;
	reason?: string;
	applies: Record<keyof AgentSetting, boolean>;
	settings: AgentSetting | null;
	stale?: boolean;
}

/** D-158: `GET /api/v1/system/agents` (and the `PUT` answer). */
export interface AgentsConfig {
	store: { writable: boolean; reason?: string };
	default_model: { provider: string; model: string } | null;
	models: Array<{ provider: string; provider_label: string; model: string; reachable: boolean }>;
	memory_available: boolean;
	agents: ManagedAgent[];
}

/** D-158: a provider as the editor holds it, for `POST /api/v1/system/model-providers/models`. */
export interface ModelsProbeInput {
	id: string;
	kind: 'openai' | 'anthropic';
	base_url: string;
	headers?: Record<string, string>;
	allow_http?: boolean;
	key: ProviderKeyInput;
}

/** D-154: one provider in `PUT /api/v1/system/model-providers`. */
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

/** D-154: the whole provider list as the PUT replaces it. */
export interface ModelProvidersStoreInput {
	/** A listed provider's id, or `null` (a sole provider is then the default). */
	default?: string | null;
	providers: ProviderInput[];
}

/** D-154: `GET /api/v1/system/memory` — the default embedder, the choices, and counts per embedder (never a text). */
export interface MemoryConfig {
	embedder: string;
	embedders: Array<{ id: string; label: string; kind: 'builtin' | 'provider' }>;
	totals: Array<{ embedder: string; collections: number; items: number }>;
}

/** The public A2A agent card (`/.well-known/agent-card.json`), as far as the control plane reads it. */
export interface AgentCard {
	name?: string;
	description?: string;
	version?: string;
	supportedInterfaces?: Array<{ url?: string; protocolBinding?: string; transport?: string }>;
	capabilities?: Record<string, unknown>;
	skills?: Array<{ id: string; name?: string; description?: string; tags?: string[] }>;
	defaultInputModes?: string[];
	defaultOutputModes?: string[];
	[key: string]: unknown;
}

/** `POST /api/v1/agent/tasks` (D-143 §3.4): a text task, optionally on a named provider and model. */
export interface CreateAgentTaskBody {
	message: string;
	provider?: string;
	model?: string;
	/** D-156: a built-in profile id (`sloplord`). */
	agent?: string;
}

export interface SystemDiagnostics {
	status: string;
	version: string;
	uptimeSeconds: number;
	memory: { rss: number; heapTotal: number; heapUsed: number; external: number };
	sessions: { total: number; active: number; viewers: number };
	config: {
		host: string;
		port: number;
		publicUrl: string;
		allowedDomains: string[];
		/**
		 * D-138: what `allowedDomains` judges — `documents` or `all`. Optional: an older gateway does not report it, and
		 * the System screen then says "not reported" (`system_facts.ts` reads it defensively).
		 */
		allowedDomainsScope?: unknown;
		/** D-137: the collector origins `TTK_OTEL_ENDPOINTS` allowlists; optional for the same reason. */
		otelEndpoints?: unknown;
		allowedOrigins: string[];
		apiKeysCount: number;
		/** D-146: keys held by accounts. Absent from a gateway older than account keys. */
		accountKeysCount?: number;
		hasAdminUser: boolean;
		oauthEnabled: boolean;
		egressEnabled: boolean;
		persistenceEnabled: boolean;
		recordingEnabled: boolean;
		sandboxEnabled: boolean;
		clusterMode: string;
		/**
		 * D-143: the configured model providers — id, kind, how many models, whether the grant proof reached the host;
		 * never a key, a URL or a header — and whether the built-in agent can run (one is reachable). Optional: an older
		 * gateway does not report them, and the Configuration panel then says "not reported".
		 */
		modelProviders?: Array<{ id: string; kind: string; models: number; reachable: boolean }>;
		builtinAgent?: boolean;
	};
}

/** The per-token origin overlay, labelled with the rule each list matches by (B1.10). */
export interface OriginsInfo {
	process_wide: { rule: string; entries: string[] };
	token: { rule: string; entries: string[] };
	/** The narrower of the two, under whichever rule ends up governing it. */
	effective: { rule: string; entries: string[] };
	overlay_status: string;
	writable: boolean;
}

/** One account as the Users screen sees it: never any password material (D-074). */
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
	/** D-146: the API keys the account holds. Absent from a gateway older than account keys. */
	keys?: AccountKey[];
}

/** One API key an account holds (D-146): never its hash, and never the key itself after the response that minted it. */
export interface AccountKey {
	id: string;
	label: string | null;
	/** The key's first characters (`ttk_AbC1`), enough to tell two keys apart. */
	prefix: string;
	scopes: string[];
	created_at: string;
}

/** A key the server just minted: its record, and the key itself — present in this one response only. */
export interface MintedKey {
	key: AccountKey;
	secret: string;
}

/** What an account's new key asks for: a label, and scopes within the account's own (the account's when omitted). */
export interface NewKey {
	label?: string;
	scopes?: string[];
}

/** One scope as the server declares it: the vocabulary is never restated in the SPA. */
export interface ScopeInfo {
	scope: string;
	grants: string;
	/** Part of the default grant. */
	default: boolean;
	/** Never implied; held only when named (D-065). */
	explicit: boolean;
}

export interface UsersResponse {
	users: PublicUser[];
	store: { writable: boolean; status: string };
	login_ttl_s: number;
	vocabulary: ScopeInfo[];
}

/** A cookie sign-in's answer (B4): no token — the cookie holds it — and the CSRF value to echo. */
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

/** One entry of the file share listing (D-075). */
/**
 * D-155: `GET /api/v1/overview` — counts and byte totals of what this credential can read. A section is absent when
 * the credential holds no scope that reads it (never a zero in its place); `scope` says whether an owner-scoped count
 * is the caller's own or everyone's.
 */
export interface Overview {
	generated_at: string;
	sessions?: { scope: 'own' | 'all'; count: number; tabs: number; viewers: number; in_use: number };
	profiles?: { count: number; bytes: number; truncated: boolean };
	storage_states?: { count: number; bytes: number };
	recordings?: { scope: 'own' | 'all'; count: number; bytes: number };
	files?: { count: number; folders: number; bytes: number; truncated: boolean };
	skills?: { count: number };
	prompts?: { count: number };
	memory?: { scope: 'own' | 'all'; collections: number; items: number };
	/** `count: null`: the sandbox did not answer. */
	workspaces?: { scope: 'own'; count: number | null };
	tasks?: { scope: 'own'; count: number; active: number; by_state: Record<string, number> };
	surfaces?: { scope: 'own'; count: number };
	providers?: { count: number; reachable: number };
	disk?: { bytes: number; truncated: boolean };
}

export interface ShareEntry {
	name: string;
	path: string;
	kind: 'file' | 'directory';
	size: number;
	modified_at: string | null;
}

export const api = {
	health: () => request<Health>('/healthz'),
	/** D-155: what this credential has stored, per resource — counts and byte totals only. */
	overview: () => request<Overview>('/api/v1/overview'),
	// --- the file share (D-075): what the tools cannot carry goes over these routes ---
	shareList: (path: string) =>
		request<{ path: string; entries: ShareEntry[]; truncated: boolean }>(
			`/api/v1/share?path=${encodeURIComponent(path)}`,
		),
	shareFilePath: (path: string) => `/api/v1/share/file?path=${encodeURIComponent(path)}`,
	shareUpload: async (path: string, file: Blob): Promise<ShareEntry> => {
		const response = await send(`/api/v1/share/file?path=${encodeURIComponent(path)}`, {
			method: 'PUT',
			body: file,
			headers: { 'content-type': 'application/octet-stream' },
		});
		return await response.json() as ShareEntry;
	},
	shareMkdir: (path: string) =>
		request<ShareEntry>('/api/v1/share/mkdir', { method: 'POST', body: JSON.stringify({ path }) }),
	shareMove: (from: string, to: string) =>
		request<ShareEntry>('/api/v1/share/move', { method: 'POST', body: JSON.stringify({ from, to }) }),
	shareDelete: (path: string, recursive = false) =>
		request<void>(`/api/v1/share?path=${encodeURIComponent(path)}${recursive ? '&recursive=true' : ''}`, {
			method: 'DELETE',
		}),
	// --- live sandbox sessions (D-076) ---
	openSandboxSession: (workspaceId: string, network?: 'none' | 'registries') =>
		request<{ session_id: string; created_at: string }>('/api/v1/sandbox/sessions', {
			method: 'POST',
			body: JSON.stringify({ workspace_id: workspaceId, ...(network === undefined ? {} : { network }) }),
		}),
	sandboxSessionInput: (sessionId: string, data: string) =>
		request<{ accepted: true }>(`/api/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/input`, {
			method: 'POST',
			body: JSON.stringify({ data }),
		}),
	closeSandboxSession: (sessionId: string) =>
		request<void>(`/api/v1/sandbox/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
	sandboxSessionEventsPath: (sessionId: string, after = 0) =>
		`/api/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
	// B4: always a cookie sign-in; the browser sends this page's Origin, which the server requires for one.
	login: (credentials: { username?: string; password?: string; apiKey?: string }) =>
		request<LoginResponse>('/api/v1/auth/login', {
			method: 'POST',
			body: JSON.stringify({ ...credentials, session: 'cookie' }),
		}),
	me: () => request<MeResponse>('/api/v1/auth/me'),
	logout: () => request<void>('/api/v1/auth/logout', { method: 'POST' }),
	changePassword: (current: string, next: string) =>
		request<void>('/api/v1/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
	listUsers: () => request<UsersResponse>('/api/v1/users'),
	/** D-146: `api_key` issues the new account its first key, returned once beside any generated password. */
	createUser: (input: { username: string; password?: string; scopes?: string[]; api_key?: NewKey }) =>
		request<{ user: PublicUser; password?: string; api_key?: MintedKey }>('/api/v1/users', {
			method: 'POST',
			body: JSON.stringify(input),
		}),
	createUserKey: (username: string, input: NewKey) =>
		request<MintedKey>(`/api/v1/users/${encodeURIComponent(username)}/keys`, {
			method: 'POST',
			body: JSON.stringify(input),
		}),
	deleteUserKey: (username: string, id: string) =>
		request<void>(`/api/v1/users/${encodeURIComponent(username)}/keys/${encodeURIComponent(id)}`, {
			method: 'DELETE',
		}),
	updateUser: (username: string, patch: { scopes?: string[]; disabled?: boolean }) =>
		request<{ user: PublicUser }>(`/api/v1/users/${encodeURIComponent(username)}`, {
			method: 'PATCH',
			body: JSON.stringify(patch),
		}),
	deleteUser: (username: string) =>
		request<void>(`/api/v1/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
	resetPassword: (username: string, password?: string) =>
		request<{ password?: string }>(`/api/v1/users/${encodeURIComponent(username)}/password`, {
			method: 'POST',
			body: JSON.stringify(password === undefined ? {} : { password }),
		}),
	signOutEverywhere: (username: string) =>
		request<{ closed: number }>(`/api/v1/users/${encodeURIComponent(username)}/sessions`, { method: 'DELETE' }),
	listSessions: () => request<{ sessions: SessionSummary[] }>('/api/v1/sessions'),
	createSession: (opts?: { session_id?: string; label?: string; profile?: string }) =>
		request<{ session_id: string; created_at: string; status: string }>('/api/v1/sessions', {
			method: 'POST',
			body: JSON.stringify(opts ?? {}),
		}),
	closeSession: (sessionId: string) =>
		request<void>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
	mintTicket: (sessionId?: string) =>
		request<Ticket>('/api/v1/live/ticket', {
			method: 'POST',
			body: JSON.stringify(sessionId === undefined ? {} : { session_id: sessionId }),
		}),
	diagnostics: () => request<SystemDiagnostics>('/api/v1/system/diagnostics'),
	origins: () => request<OriginsInfo>('/api/v1/live/origins'),
	setOrigins: (origins: string[]) =>
		request<OriginsInfo>('/api/v1/live/origins', { method: 'PUT', body: JSON.stringify({ origins }) }),
	sessionFilePath: (sessionId: string, fileId: string) =>
		`/api/v1/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`,
	agentTaskEventsPath: (taskId: string) => `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/events`,
	listAgentTasks: () => request<{ tasks: AgentTaskSummary[] }>('/api/v1/agent/tasks'),
	getAgentTask: (taskId: string) =>
		request<{ task: AgentTaskSummary; permission?: AgentTaskSummary['permission'] }>(
			`/api/v1/agent/tasks/${encodeURIComponent(taskId)}`,
		),
	cancelAgentTask: (taskId: string) =>
		request<unknown>(`/api/v1/agent/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '{}' }),
	decideAgentPermission: (taskId: string, permissionId: string, optionId?: string) =>
		request<unknown>(`/api/v1/agent/tasks/${encodeURIComponent(taskId)}/permission`, {
			method: 'POST',
			body: JSON.stringify({ permissionId, ...(optionId === undefined ? {} : { optionId }) }),
		}),
	/**
	 * One A2A `SendMessage` with the given parts — a structured task is a data part `{tool, arguments}` — and, when
	 * given, request-level `metadata` (`provider`/`model`, D-143 C5). Text tasks go through `createAgentTask`.
	 */
	sendAgentMessage: async (parts: AgentMessagePart[], metadata?: Record<string, unknown>): Promise<unknown> => {
		const result = await request<{ result?: unknown; error?: { message: string } }>('/a2a', {
			method: 'POST',
			headers: { 'A2A-Version': '1.0' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: crypto.randomUUID(),
				method: 'SendMessage',
				params: {
					configuration: { returnImmediately: true },
					message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts },
					...(metadata === undefined ? {} : { metadata }),
				},
			}),
		});
		if (result.error) throw new Error(result.error.message);
		return result.result;
	},
	/** D-143 §3.4: a text task; a refusal arrives as a problem document whose `detail` is the runtime's own words. */
	createAgentTask: (body: CreateAgentTaskBody) =>
		request<{ task: AgentTaskSummary }>('/api/v1/agent/tasks', { method: 'POST', body: JSON.stringify(body) }),
	listProviders: () => request<ProvidersResponse>('/api/v1/agent/providers'),
	/** The public A2A agent card: no credential is needed, and none is refused. */
	agentCard: () => request<AgentCard>('/.well-known/agent-card.json'),
	/** D-153: the operator's file (read-only), the admin store, and the merged providers. */
	modelProviders: () => request<ModelProvidersConfig>('/api/v1/system/model-providers'),
	/** D-153: replaces the admin store (keys written write-only) and applies the merged set to the running gateway. */
	saveModelProviders: (body: ModelProvidersStoreInput) =>
		request<ModelProvidersConfig>('/api/v1/system/model-providers', { method: 'PUT', body: JSON.stringify(body) }),
	/** D-158: the agents and their settings (admin). */
	agentsConfig: () => request<AgentsConfig>('/api/v1/system/agents'),
	saveAgentSettings: (agents: Record<string, Partial<AgentSetting>>) =>
		request<AgentsConfig>('/api/v1/system/agents', { method: 'PUT', body: JSON.stringify({ agents }) }),
	/** D-158: the models a provider lists, for the editor's picker (admin); dials only a saved provider's host. */
	listProviderModels: (body: ModelsProbeInput) =>
		request<{ models: string[] }>('/api/v1/system/model-providers/models', {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	listActionNames: () => request<{ names: string[] }>('/api/v1/a2ui/actions'),
	/** D-154: the agents' memory settings (admin). */
	memoryConfig: () => request<MemoryConfig>('/api/v1/system/memory'),
	saveMemoryConfig: (embedder: string) =>
		request<MemoryConfig>('/api/v1/system/memory', { method: 'PUT', body: JSON.stringify({ embedder }) }),
	listSurfaces: () => request<{ surfaces: A2uiSurface[] }>('/api/v1/a2ui/surfaces'),
	publishSurface: (message: unknown) =>
		request<unknown>('/api/v1/a2ui/surfaces', { method: 'POST', body: JSON.stringify(message) }),
	deleteSurface: (surfaceId: string) =>
		request<unknown>(`/api/v1/a2ui/surfaces/${encodeURIComponent(surfaceId)}`, { method: 'DELETE' }),
	surfaceAction: (event: A2uiAction) =>
		request<unknown>('/api/v1/a2ui/actions', { method: 'POST', body: JSON.stringify(event) }),
};
