/** A2A 1.0: the agent cards, the operations shared by both bindings, the JSON-RPC endpoint and the peer client. */
import type { AgentMessage, AgentRuntime } from './runtime.ts';
import { AgentError, delay, endedTaskRefusal, identifier, object, readJson, serviceUrl, terminal } from './util.ts';
import { type AgentProfile, agentProfile, profileA2aPath, SLOPLORD } from './settings.ts';

/** What the composition root mounts beside the JSON-RPC endpoint; the card describes exactly that. */
export interface AgentCardOptions {
	/** `GetExtendedAgentCard` is served to an authenticated caller. */
	readonly extendedCard?: boolean;
	/** The HTTP+JSON binding is mounted at `<public URL>/a2a/v1`. */
	readonly httpJson?: boolean;
}

/** One MCP tool as the extended card lists it: a skill the caller may invoke as a structured tool task. */
export interface AgentToolSkill {
	readonly name: string;
	readonly title?: string;
	readonly description: string;
}

/** `publicUrl` with `suffix` appended to its path. */
function under(publicUrl: string, suffix: string): string {
	const url = serviceUrl(publicUrl);
	url.pathname = `${url.pathname.replace(/\/$/, '')}${suffix}`;
	return url.href;
}

/** The JSON-RPC interface at `base`, and the HTTP+JSON one at `base/v1` when mounted. */
function interfaces(publicUrl: string, base: string, httpJson: boolean | undefined): Record<string, unknown>[] {
	return [
		{ url: under(publicUrl, base), protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
		...(httpJson === true
			? [{ url: under(publicUrl, `${base}/v1`), protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }]
			: []),
	];
}

const SECURITY = {
	securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
	securityRequirements: [{ bearer: ['agent:invoke'] }],
};

/** Where a profile's public card is served — the A2A well-known name below its own endpoint. */
export function profileCardUrl(publicUrl: string, profile: AgentProfile): string {
	return under(publicUrl, `${profileA2aPath(profile.id)}/.well-known/agent-card.json`);
}

/**
 * Public A2A 1.0 card, its capabilities derived from the runtime: push only where the operator's policy reached it,
 * `text/plain` only while a provider is reachable, and each text skill only while its agent is offered over A2A.
 */
export function agentCard(
	publicUrl: string,
	runtime: AgentRuntime,
	options: AgentCardOptions = {},
): Record<string, unknown> {
	return {
		name: 'Multi-MCP agent',
		description: 'Principal-scoped browser and coding tool execution.',
		version: '0.2.0',
		supportedInterfaces: interfaces(publicUrl, '/a2a', options.httpJson),
		capabilities: {
			streaming: true,
			pushNotifications: runtime.supportsPush,
			extendedAgentCard: options.extendedCard === true,
			extensions: [{
				uri: 'https://tykotech.eu/a2a/tool-invocation/v1',
				description: 'Data parts carry {tool, arguments}, dispatched using current caller scopes.',
				required: false,
			}],
		},
		defaultInputModes: runtime.supportsText ? ['application/json', 'text/plain'] : ['application/json'],
		defaultOutputModes: ['application/json', 'text/plain'],
		...SECURITY,
		skills: [
			{
				id: 'tool-invocation',
				name: 'Authorized tool invocation',
				description: 'Invoke enabled catalog tools with the caller’s scopes and existing browser lock checks.',
				tags: ['mcp', 'tools'],
				inputModes: ['application/json'],
			},
			...(runtime.reachableProviders > 0 && runtime.agentSetting('builtin').a2a
				? [{
					id: 'builtin-model',
					name: 'Built-in model agent',
					description: 'Run text prompts on an operator-configured model provider (metadata.provider, metadata.model).',
					tags: ['model'],
					inputModes: ['text/plain'],
				}]
				: []),
			...(runtime.profileReady(SLOPLORD.id) && runtime.agentSetting(SLOPLORD.id).a2a
				? [{
					id: SLOPLORD.id,
					name: SLOPLORD.name,
					description: `${SLOPLORD.description} Send metadata.agent "${SLOPLORD.id}" here, or use its own card: ` +
						profileCardUrl(publicUrl, SLOPLORD),
					tags: ['coding', 'sandbox', 'model'],
					inputModes: ['text/plain'],
				}]
				: []),
		],
	};
}

/**
 * A built-in profile's own public card, its interfaces the profile's endpoints. While the profile cannot run here, or
 * is switched off A2A, it accepts no input mode and lists no skill. No extended card: its tools are fixed.
 */
export function profileAgentCard(
	publicUrl: string,
	runtime: AgentRuntime,
	profile: AgentProfile,
	options: Pick<AgentCardOptions, 'httpJson'> = {},
): Record<string, unknown> {
	const ready = runtime.profileReady(profile.id) && runtime.agentSetting(profile.id).a2a;
	return {
		name: profile.name,
		description: profile.description,
		version: '0.2.0',
		supportedInterfaces: interfaces(publicUrl, profileA2aPath(profile.id), options.httpJson),
		capabilities: { streaming: true, pushNotifications: runtime.supportsPush, extendedAgentCard: false },
		defaultInputModes: ready ? ['text/plain'] : [],
		defaultOutputModes: ['text/plain', 'application/json'],
		...SECURITY,
		skills: ready
			? [{
				id: 'sandbox-coding',
				name: 'Coding in the private sandbox',
				description: `${profile.description} Needs model:invoke, mcp:invoke and sandbox:execute; ` +
					'metadata.provider and metadata.model choose the model as for the built-in agent.',
				tags: ['coding', 'sandbox', 'model'],
				inputModes: ['text/plain'],
				outputModes: ['text/plain', 'application/json'],
			}]
			: [],
	};
}

/** The authenticated extended card: the public card plus one skill per MCP tool this caller may invoke. */
export function extendedAgentCard(
	publicUrl: string,
	runtime: AgentRuntime,
	tools: readonly AgentToolSkill[],
	options: AgentCardOptions = {},
): Record<string, unknown> {
	const card = agentCard(publicUrl, runtime, options);
	card.skills = [
		...card.skills as Record<string, unknown>[],
		...tools.map((tool) => ({
			id: tool.name,
			name: tool.title ?? tool.name,
			description: tool.description,
			tags: ['mcp-tool'],
			inputModes: ['application/json'],
			outputModes: ['application/json'],
		})),
	];
	return card;
}

/** The SSE body of a task event stream: one `data:` line per event, JSON-RPC wrapped when an id is given. */
export function agentEventBody(
	stream: ReadableStream<Record<string, unknown>>,
	rpcId?: string | number | null,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				reader.releaseLock();
				return;
			}
			const event = rpcId === undefined ? value : { jsonrpc: '2.0', id: rpcId, result: value };
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
		},
		async cancel(): Promise<void> {
			await reader.cancel();
			reader.releaseLock();
		},
	});
}

/** The headers every task event stream carries. */
export const EVENT_STREAM_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/event-stream',
	'cache-control': 'no-store',
};

/** A `metadata.provider` / `metadata.model` value — a non-empty string of at most 64 characters. */
function shortText(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
		throw new AgentError(-32602, `Invalid ${name}`);
	}
	return value;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new AgentError(-32602, 'Invalid integer parameter');
	}
	return value;
}

/** An opaque cursor over `(created, id)`: creation order never moves, so no task is skipped or listed twice. */
function pageToken(created: number, id: string): string {
	return btoa(JSON.stringify([created, id])).replace(/=+$/, '');
}
function pageCursor(value: unknown): { created: number; id: string } {
	try {
		const [created, id] = JSON.parse(atob(identifier(value))) as unknown[];
		if (typeof created === 'number' && Number.isSafeInteger(created)) return { created, id: identifier(id) };
	} catch { /* Every malformed token is the same invalid parameter. */ }
	throw new AgentError(-32602, 'Invalid pageToken');
}

/** Who is calling, as the composition root authenticated them; never read from the message. */
export interface A2aCaller {
	readonly principal: string;
	readonly scopes: ReadonlySet<string>;
	readonly runtime: AgentRuntime;
	/** The gateway's fingerprint of the credential behind `principal`, carried onto submitted tasks. */
	readonly credential?: string;
	/** This caller's extended card; absent means `GetExtendedAgentCard` is unsupported. */
	readonly extendedCard?: () => Record<string, unknown>;
	/** The endpoint's fixed profile: every message runs on it, and `ListTasks` lists only its tasks. */
	readonly agent?: AgentProfile;
}

/** An A2A operation's answer: a result object, or a stream of `StreamResponse` events. */
export type A2aOutcome =
	| { readonly result: Record<string, unknown> }
	| { readonly events: ReadableStream<Record<string, unknown>> };

const PUSH_METHODS = new Set([
	'CreateTaskPushNotificationConfig',
	'GetTaskPushNotificationConfig',
	'ListTaskPushNotificationConfig',
	'ListTaskPushNotificationConfigs',
	'DeleteTaskPushNotificationConfig',
]);

/** The config id a Get or Delete names, in the spellings A2A 1.0 clients use. */
function configIdOf(params: Record<string, unknown>): string {
	return identifier(params.id ?? params.pushNotificationConfigId ?? params.configId);
}

/** The state an event carries, from a status update or a task snapshot. */
function stateOf(event: Record<string, unknown> | undefined): unknown {
	if (event?.statusUpdate) return object(object(event.statusUpdate).status).state;
	if (event?.task) return object(object(event.task).status).state;
	return undefined;
}

/**
 * One A2A 1.0 operation, shared by the JSON-RPC endpoint and the HTTP+JSON binding so the two cannot drift.
 * Failures are `AgentError`s carrying the A2A/JSON-RPC code.
 */
export async function a2aInvoke(
	method: string,
	params: Record<string, unknown>,
	caller: A2aCaller,
): Promise<A2aOutcome> {
	const { principal, scopes, runtime, credential } = caller;
	if (PUSH_METHODS.has(method) && !runtime.supportsPush) {
		throw new AgentError(-32003, 'Push notifications unsupported');
	}
	switch (method) {
		case 'SendMessage':
		case 'SendStreamingMessage': {
			const configuration = object(params.configuration ?? {});
			const push = configuration.taskPushNotificationConfig ?? configuration.pushNotificationConfig;
			if (push !== undefined && !runtime.supportsPush) throw new AgentError(-32003, 'Push notifications unsupported');
			if (configuration.returnImmediately !== undefined && typeof configuration.returnImmediately !== 'boolean') {
				throw new AgentError(-32602, 'Invalid returnImmediately');
			}
			const historyLength = integer(configuration.historyLength, 100, 0, 10000);
			// `provider`/`model`/`agent` ride the request-level `SendMessageRequest.metadata`, not the message's own.
			const metadata = object(params.metadata ?? {});
			const selection = {
				...(metadata.provider === undefined ? {} : { provider: shortText(metadata.provider, 'provider') }),
				...(metadata.model === undefined ? {} : { model: shortText(metadata.model, 'model') }),
			};
			const named = metadata.agent === undefined ? undefined : agentProfile(metadata.agent);
			if (named !== undefined && caller.agent !== undefined && named.id !== caller.agent.id) {
				throw new AgentError(-32602, 'metadata.agent does not match this endpoint');
			}
			const profile = caller.agent ?? named;
			const task = runtime.submit(principal, scopes, params.message, credential, {
				...(push === undefined ? {} : { push }),
				...(Object.keys(selection).length === 0 ? {} : { model: selection }),
				...(profile === undefined ? {} : { agent: profile.id }),
				via: 'a2a',
			});
			if (method === 'SendStreamingMessage') return { events: runtime.subscribe(principal, task.id) };
			if (configuration.returnImmediately !== true && !terminal(task.status.state)) {
				const reader = runtime.subscribe(principal, task.id).getReader();
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						const state = stateOf(value);
						if (
							typeof state === 'string' &&
							(terminal(state) || ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'].includes(state))
						) break;
					}
				} finally {
					await reader.cancel();
					reader.releaseLock();
				}
			}
			return { result: { task: runtime.get(principal, task.id, historyLength) } };
		}
		case 'GetTask':
			return {
				result: runtime.get(principal, identifier(params.id), integer(params.historyLength, 100, 0, 10000)),
			};
		case 'CancelTask':
			return { result: runtime.cancel(principal, identifier(params.id)) };
		case 'SubscribeToTask': {
			const taskId = identifier(params.id);
			const state = runtime.get(principal, taskId).status.state;
			if (terminal(state)) throw new AgentError(-32004, endedTaskRefusal(state, 'subscribed to'));
			return { events: runtime.subscribe(principal, taskId) };
		}
		case 'ListTasks': {
			const pageSize = integer(params.pageSize, 50, 1, 100);
			const historyLength = integer(params.historyLength, 100, 0, 10000);
			if (params.includeArtifacts !== undefined && typeof params.includeArtifacts !== 'boolean') {
				throw new AgentError(-32602, 'Invalid includeArtifacts');
			}
			if (params.contextId !== undefined) identifier(params.contextId);
			if (
				params.status !== undefined &&
				!/^TASK_STATE_(SUBMITTED|WORKING|COMPLETED|FAILED|CANCELED|INPUT_REQUIRED|AUTH_REQUIRED|REJECTED)$/.test(
					String(params.status),
				)
			) throw new AgentError(-32602, 'Invalid task status');
			const after = params.statusTimestampAfter;
			if (after !== undefined && (typeof after !== 'string' || !Number.isFinite(Date.parse(after)))) {
				throw new AgentError(-32602, 'Invalid timestamp');
			}
			const entries = runtime.listByCreation(principal).filter(({ task }) =>
				(caller.agent === undefined || task.metadata.agent === caller.agent.id) &&
				(params.contextId === undefined || task.contextId === params.contextId) &&
				(params.status === undefined || task.status.state === params.status) &&
				(after === undefined || Date.parse(task.status.timestamp) >= Date.parse(String(after)))
			);
			let start = 0;
			if (params.pageToken !== undefined && params.pageToken !== '') {
				// A position, not a task: a task evicted since the last page cannot invalidate it.
				const cursor = pageCursor(params.pageToken);
				start = entries.findIndex(({ created, task }) =>
					created < cursor.created || (created === cursor.created && task.id.localeCompare(cursor.id) < 0)
				);
				if (start < 0) start = entries.length;
			}
			const slice = entries.slice(start, start + pageSize);
			const last = slice.at(-1);
			return {
				result: {
					tasks: slice.map(({ task }) => {
						const view = runtime.get(principal, task.id, historyLength) as Record<string, unknown>;
						if (params.includeArtifacts !== true) delete view.artifacts;
						if (historyLength === 0) delete view.history;
						return view;
					}),
					pageSize,
					totalSize: entries.length,
					nextPageToken: start + pageSize < entries.length && last ? pageToken(last.created, last.task.id) : '',
				},
			};
		}
		// Webhook configurations, owner-bound through the task they name. The token is never read back.
		case 'CreateTaskPushNotificationConfig':
			// `{taskId, configId?, config}` or a `TaskPushNotificationConfig` `{taskId, pushNotificationConfig}`.
			return {
				result: runtime.setPushConfig(principal, identifier(params.taskId), params.config ?? params, params.configId),
			};
		case 'GetTaskPushNotificationConfig':
			return { result: runtime.getPushConfig(principal, identifier(params.taskId), configIdOf(params)) };
		case 'ListTaskPushNotificationConfig':
		case 'ListTaskPushNotificationConfigs':
			integer(params.pageSize, 4, 1, 100);
			// At most four per task: one page always holds them all.
			return { result: { configs: runtime.listPushConfigs(principal, identifier(params.taskId)), nextPageToken: '' } };
		case 'DeleteTaskPushNotificationConfig':
			runtime.deletePushConfig(principal, identifier(params.taskId), configIdOf(params));
			return { result: {} };
		case 'GetExtendedAgentCard':
			if (caller.extendedCard === undefined) throw new AgentError(-32007, 'Extended agent card not configured');
			return { result: caller.extendedCard() };
		default:
			if (method.includes('PushNotification')) throw new AgentError(-32003, 'Push notifications unsupported');
			throw new AgentError(-32601, 'Method not found');
	}
}

// --- errors: one table, so the JSON-RPC and HTTP+JSON bindings (and the gateway's task routes) cannot drift ------

/** A2A 1.0 §5.4: each A2A error's HTTP status, its `google.rpc` code, and its `ErrorInfo` reason (§11.6). */
const A2A_ERRORS: ReadonlyMap<number, readonly [status: number, rpc: string, reason: string]> = new Map([
	[-32001, [404, 'NOT_FOUND', 'TASK_NOT_FOUND']],
	[-32002, [400, 'FAILED_PRECONDITION', 'TASK_NOT_CANCELABLE']],
	[-32003, [400, 'FAILED_PRECONDITION', 'PUSH_NOTIFICATION_NOT_SUPPORTED']],
	[-32004, [400, 'FAILED_PRECONDITION', 'UNSUPPORTED_OPERATION']],
	[-32005, [400, 'INVALID_ARGUMENT', 'CONTENT_TYPE_NOT_SUPPORTED']],
	[-32006, [500, 'INTERNAL', 'INVALID_AGENT_RESPONSE']],
	[-32007, [400, 'FAILED_PRECONDITION', 'EXTENDED_AGENT_CARD_NOT_CONFIGURED']],
	[-32008, [400, 'FAILED_PRECONDITION', 'EXTENSION_SUPPORT_REQUIRED']],
	[-32009, [400, 'FAILED_PRECONDITION', 'VERSION_NOT_SUPPORTED']],
]);

/** The `google.rpc` code for every other status these bindings answer with. */
const RPC_STATUS: Readonly<Record<number, string>> = {
	400: 'INVALID_ARGUMENT',
	401: 'UNAUTHENTICATED',
	403: 'PERMISSION_DENIED',
	404: 'NOT_FOUND',
	409: 'FAILED_PRECONDITION',
	413: 'INVALID_ARGUMENT',
	429: 'RESOURCE_EXHAUSTED',
	500: 'INTERNAL',
	503: 'UNAVAILABLE',
};

/**
 * The HTTP status for an A2A or JSON-RPC error code. Past an operation's start the runtime raises `-32600` only to
 * refuse a credential its scopes do not cover (403), and `-32603` only when it cannot take the work now — capacity,
 * subscriber limit, shutdown — which a client may retry (503).
 */
export function a2aHttpStatus(code: number): number {
	return A2A_ERRORS.get(code)?.[0] ?? (code === -32600 ? 403 : code === -32603 ? 503 : code === -32601 ? 404 : 400);
}

/** The `google.rpc.ErrorInfo` A2A 1.0 attaches to an A2A-specific error (JSON-RPC `data`, HTTP+JSON `details`). */
function errorDetails(code: number | undefined): Record<string, unknown>[] {
	const reason = code === undefined ? undefined : A2A_ERRORS.get(code)?.[2];
	return reason === undefined
		? []
		: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }];
}

/** An HTTP+JSON error (A2A 1.0 §11.6): `status`, and a `google.rpc.Status` body naming the A2A error when there is one. */
export function a2aHttpError(status: number, message: string, code?: number): Response {
	const rpc = (code === undefined ? undefined : A2A_ERRORS.get(code)?.[1]) ?? RPC_STATUS[status] ?? 'UNKNOWN';
	return Response.json(
		{ error: { code: status, status: rpc, message, details: errorDetails(code) } },
		{ status, headers: { 'a2a-version': '1.0' } },
	);
}

/** A failed A2A operation as the HTTP+JSON binding answers it: the runtime's public message, never an internal one. */
export function a2aHttpFailure(error: unknown): Response {
	return error instanceof AgentError
		? a2aHttpError(a2aHttpStatus(error.code), error.message, error.code)
		: a2aHttpError(500, 'Internal error');
}

/** What the composition root adds around the JSON-RPC endpoint. */
export interface A2aFetchOptions {
	/** Wraps a streaming body — the gateway's `StreamGuard`, which re-checks the caller and caps the stream. */
	readonly wrapStream?: (body: ReadableStream<Uint8Array>, rpcId: string | number | null) => ReadableStream<Uint8Array>;
	readonly extendedCard?: () => Record<string, unknown>;
	/** The endpoint's fixed profile ({@linkcode A2aCaller.agent}). */
	readonly agent?: AgentProfile;
}

/** The JSON-RPC endpoint; identity comes from the composition root, never from the message. */
export async function a2aFetch(
	request: Request,
	principal: string,
	scopes: ReadonlySet<string>,
	runtime: AgentRuntime,
	credential?: string,
	options: A2aFetchOptions = {},
): Promise<Response> {
	let id: string | number | null = null;
	try {
		if (request.method !== 'POST') throw new AgentError(-32600, 'POST required');
		if (!scopes.has('agent:invoke')) return a2aHttpError(403, 'agent:invoke scope required');
		if (request.headers.get('a2a-version') !== '1.0') throw new AgentError(-32009, 'A2A-Version 1.0 required');
		const value = object(await readJson(request.body));
		if (
			value.jsonrpc !== '2.0' || typeof value.method !== 'string' ||
			(typeof value.id !== 'string' && typeof value.id !== 'number' && value.id !== null)
		) throw new AgentError(-32600, 'Request payload validation error');
		id = value.id as string | number | null;
		const outcome = await a2aInvoke(value.method, object(value.params ?? {}), {
			principal,
			scopes,
			runtime,
			...(credential === undefined ? {} : { credential }),
			...(options.extendedCard === undefined ? {} : { extendedCard: options.extendedCard }),
			...(options.agent === undefined ? {} : { agent: options.agent }),
		});
		if ('events' in outcome) {
			const body = agentEventBody(outcome.events, id);
			return new Response(options.wrapStream?.(body, id) ?? body, { headers: EVENT_STREAM_HEADERS });
		}
		return Response.json({ jsonrpc: '2.0', id, result: outcome.result }, { headers: { 'a2a-version': '1.0' } });
	} catch (error) {
		const code = error instanceof AgentError ? error.code : -32603;
		const details = errorDetails(code);
		return Response.json({
			jsonrpc: '2.0',
			id,
			error: {
				code,
				message: error instanceof AgentError ? error.message : 'Internal error',
				...(details.length === 0 ? {} : { data: details }),
			},
		}, { headers: { 'a2a-version': '1.0' } });
	}
}

// --- the peer client -------------------------------------------------------------------------------------------

/** Peer destinations and bearer references are operator-fixed configuration. */
export interface AgentPeer {
	id: string;
	url: string;
	token?: string;
}

/** Strict A2A 1.0 client; named peers cannot become general SSRF endpoints. */
export class A2aPeerClient {
	#base: URL;
	constructor(private readonly peer: AgentPeer) {
		identifier(peer.id);
		this.#base = serviceUrl(peer.url);
	}
	#auth(): Record<string, string> {
		return this.peer.token ? { authorization: `Bearer ${this.peer.token}` } : {};
	}
	async #interface(signal: AbortSignal): Promise<URL> {
		const cardUrl = new URL('/.well-known/agent-card.json', this.#base);
		const response = await fetch(cardUrl, { redirect: 'error', signal, headers: this.#auth() });
		if (!response.ok) {
			await response.body?.cancel();
			throw new AgentError(-32006, 'Peer card unavailable');
		}
		const card = object(await readJson(response.body, 256 * 1024));
		const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces.map(object) : [];
		const supported = interfaces.find((item) => item.protocolBinding === 'JSONRPC' && item.protocolVersion === '1.0');
		if (!supported || typeof supported.url !== 'string') {
			throw new AgentError(-32009, 'Peer does not support A2A 1.0 JSONRPC');
		}
		const endpoint = serviceUrl(supported.url);
		if (endpoint.origin !== this.#base.origin) {
			throw new AgentError(-32006, 'Peer card endpoint origin differs from configured origin');
		}
		return endpoint;
	}
	async #rpc(
		url: URL,
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const id = crypto.randomUUID();
		const response = await fetch(url, {
			method: 'POST',
			redirect: 'error',
			signal: signal ?? AbortSignal.timeout(10_000),
			headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...this.#auth() },
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new AgentError(-32006, 'Peer request failed');
		}
		const raw = await readJson(response.body, 1024 * 1024);
		const envelope = object(
			this.peer.token ? JSON.parse(JSON.stringify(raw).split(this.peer.token).join('[REDACTED]')) : raw,
		);
		if (envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error !== undefined) {
			throw new AgentError(-32006, 'Peer returned an invalid or failed response');
		}
		return object(envelope.result);
	}
	/** Polls the returned remote task, propagating local cancellation to CancelTask. */
	async send(message: AgentMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
		const endpoint = await this.#interface(signal);
		let remoteId: string | undefined;
		const cancel = (): void => {
			if (remoteId) void this.#rpc(endpoint, 'CancelTask', { id: remoteId }).catch(() => {});
		};
		signal.addEventListener('abort', cancel, { once: true });
		try {
			// Local task/context ids have no meaning at the peer and never leave this owner boundary.
			const result = await this.#rpc(endpoint, 'SendMessage', {
				message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: message.parts },
				configuration: { returnImmediately: true },
			}, signal);
			if (result.message !== undefined) return result;
			let task = object(result.task);
			remoteId = identifier(task.id);
			while (true) {
				signal.throwIfAborted();
				const state = String(object(task.status).state);
				if (state === 'TASK_STATE_COMPLETED') return { task };
				if (['TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(state)) {
					throw new AgentError(-32006, 'Delegated task did not complete');
				}
				if (['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'].includes(state)) {
					throw new AgentError(-32004, 'Peer requires an interactive decision');
				}
				await delay(500, signal);
				task = await this.#rpc(endpoint, 'GetTask', { id: remoteId }, signal);
			}
		} finally {
			signal.removeEventListener('abort', cancel);
		}
	}
}
