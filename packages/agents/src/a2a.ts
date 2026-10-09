import { type AgentRuntime, terminal } from './runtime.ts';
import { AgentError, identifier, object, readJson, serviceUrl } from './util.ts';
import { type AgentProfile, agentProfile, profileA2aPath, SLOPLORD } from './model/profiles.ts';

/** What the composition root mounts beside the JSON-RPC endpoint; the card describes exactly that. */
export interface AgentCardOptions {
	/** A11: `GetExtendedAgentCard` is served to an authenticated caller (`capabilities.extendedAgentCard`). */
	readonly extendedCard?: boolean;
	/** A11: the HTTP+JSON binding is mounted at `<public URL>/a2a/v1` and listed in `supportedInterfaces`. */
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

/** D-156: where a profile's public card is served — the A2A well-known name below its own endpoint. */
export function profileCardUrl(publicUrl: string, profile: AgentProfile): string {
	return under(publicUrl, `${profileA2aPath(profile.id)}/.well-known/agent-card.json`);
}

/** Public A2A 1.0 card, with capabilities derived from the actual runtime. */
export function agentCard(
	publicUrl: string,
	runtime: AgentRuntime,
	options: AgentCardOptions = {},
): Record<string, unknown> {
	const at = (suffix: string): string => under(publicUrl, suffix);
	return {
		name: 'Multi-MCP agent',
		description: 'Principal-scoped browser and coding tool execution.',
		version: '0.2.0',
		supportedInterfaces: [
			{ url: at('/a2a'), protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
			...(options.httpJson === true
				? [{ url: at('/a2a/v1'), protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }]
				: []),
		],
		capabilities: {
			streaming: true,
			// A11 / N1: true only where the operator's push policy reached the runtime, never unconditionally.
			pushNotifications: runtime.supportsPush,
			extendedAgentCard: options.extendedCard === true,
			extensions: [{
				uri: 'https://tykotech.eu/a2a/tool-invocation/v1',
				description: 'Data parts carry {tool, arguments}, dispatched using current caller scopes.',
				required: false,
			}],
		},
		// §3.10 / gate F20: `text/plain` only while some text backend exists — a bridge, or a reachable provider.
		defaultInputModes: runtime.supportsText ? ['application/json', 'text/plain'] : ['application/json'],
		defaultOutputModes: ['application/json', 'text/plain'],
		securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
		securityRequirements: [{ bearer: ['agent:invoke'] }],
		// §3.11 (gate F4): each text skill is gated on its own condition; both, one or neither may be listed.
		skills: [
			{
				id: 'tool-invocation',
				name: 'Authorized tool invocation',
				description: 'Invoke enabled catalog tools with the caller’s scopes and existing browser lock checks.',
				tags: ['mcp', 'tools'],
				inputModes: ['application/json'],
			},
			// D-158: each text skill is listed only while the administrator offers its agent over A2A.
			...(runtime.routesToBridge('a2a')
				? [{
					id: 'external-agent',
					name: 'Configured external ACP agent',
					description: 'Run text prompts through the operator-configured ACP backend.',
					tags: ['acp'],
					inputModes: ['text/plain'],
				}]
				: []),
			...(runtime.reachableProviders > 0 && runtime.agentSetting('builtin').a2a
				? [{
					id: 'builtin-model',
					name: 'Built-in model agent',
					description: 'Run text prompts on an operator-configured model provider (metadata.provider, metadata.model).',
					tags: ['model'],
					inputModes: ['text/plain'],
				}]
				: []),
			// D-156: the built-in coding agent, discoverable from the main card under the same gate as its own card.
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
 * D-156: a built-in profile's own public A2A 1.0 card. Its interfaces are the profile's endpoints, which route every
 * message to the profile. It mirrors the main card's honesty (§3.10 / gate F20): while the runtime cannot run the
 * profile (`profileReady`: no reachable provider, or no coding sandbox) it accepts no input mode and lists no skill.
 * No extended card: the profile's tools are fixed and narrowed per caller at run time, not invocable one by one.
 */
export function profileAgentCard(
	publicUrl: string,
	runtime: AgentRuntime,
	profile: AgentProfile,
	options: Pick<AgentCardOptions, 'httpJson'> = {},
): Record<string, unknown> {
	const base = profileA2aPath(profile.id);
	// D-158: switched off A2A, the card stays (its URL is public) but accepts no input, as when it cannot run.
	const ready = runtime.profileReady(profile.id) && runtime.agentSetting(profile.id).a2a;
	return {
		name: profile.name,
		description: profile.description,
		version: '0.2.0',
		supportedInterfaces: [
			{ url: under(publicUrl, base), protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
			...(options.httpJson === true
				? [{ url: under(publicUrl, `${base}/v1`), protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }]
				: []),
		],
		capabilities: { streaming: true, pushNotifications: runtime.supportsPush, extendedAgentCard: false },
		defaultInputModes: ready ? ['text/plain'] : [],
		defaultOutputModes: ['text/plain', 'application/json'],
		securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
		securityRequirements: [{ bearer: ['agent:invoke'] }],
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

/**
 * A11: the authenticated extended card — the public card plus one skill per MCP tool **this caller** may invoke as a
 * structured tool task. The composition root decides which tools those are (scopes, deployment availability); this
 * only shapes them.
 */
export function extendedAgentCard(
	publicUrl: string,
	runtime: AgentRuntime,
	tools: readonly AgentToolSkill[],
	options: AgentCardOptions = {},
): Record<string, unknown> {
	const card = agentCard(publicUrl, runtime, options);
	const skills = card.skills as Record<string, unknown>[];
	card.skills = [
		...skills,
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
			} else {controller.enqueue(
					new TextEncoder().encode(
						`data: ${JSON.stringify(rpcId === undefined ? value : { jsonrpc: '2.0', id: rpcId, result: value })}\n\n`,
					),
				);}
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

/** Convert task events into A2A JSON-RPC SSE; cancel unsubscribes only this consumer. */
export function agentEvents(stream: ReadableStream<Record<string, unknown>>, rpcId?: string | number | null): Response {
	return new Response(agentEventBody(stream, rpcId), { headers: EVENT_STREAM_HEADERS });
}

/** D-143: a `metadata.provider` / `metadata.model` value — a non-empty string of at most 64 characters. */
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

/**
 * AG-14: an opaque cursor over `(created, id)`, the order `listByCreation` pages on. The id alone, over a list
 * sorted by the moving status timestamp, skipped any task whose status changed between two pages.
 */
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
	/** GW-1: the gateway's fingerprint of the credential behind `principal`, carried onto submitted tasks. */
	readonly credential?: string;
	/** A11: this caller's extended card; absent means `GetExtendedAgentCard` is unsupported (`-32004`). */
	readonly extendedCard?: () => Record<string, unknown>;
	/**
	 * D-156: the endpoint's fixed profile (a profile's own A2A mount). Every message sent there runs on it, a request
	 * `metadata.agent` naming another is `-32602`, and `ListTasks` lists only that profile's tasks.
	 */
	readonly agent?: AgentProfile;
}

/** An A2A operation's answer: a result object, or a stream of `StreamResponse` events. */
export type A2aOutcome =
	| { readonly result: Record<string, unknown> }
	| { readonly events: ReadableStream<Record<string, unknown>> };

/** A11: the push method names, so an unsupported deployment answers every one of them `-32003`. */
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

/**
 * A11: one A2A 1.0 operation, shared by the JSON-RPC endpoint and the HTTP+JSON binding so the two cannot drift.
 * Failures are `AgentError`s carrying the A2A/JSON-RPC code; each binding renders them its own way.
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
			// D-143 (C5): `provider`/`model` ride the request-level `metadata` of A2A 1.0 `SendMessageRequest` — the
			// field beside `message` and `configuration` (`SendMessageRequest.metadata`, a `Struct`), not the message's
			// own `metadata`, which a message would carry into the task's history. Read here once for both bindings.
			// Each is a string of at most 64 characters; anything else is `-32602`.
			const metadata = object(params.metadata ?? {});
			const selection = {
				...(metadata.provider === undefined ? {} : { provider: shortText(metadata.provider, 'provider') }),
				...(metadata.model === undefined ? {} : { model: shortText(metadata.model, 'model') }),
			};
			// D-156: `metadata.agent` names a built-in profile beside `provider`/`model`; a profile's own endpoint fixes it.
			const named = metadata.agent === undefined ? undefined : agentProfile(metadata.agent);
			if (named !== undefined && caller.agent !== undefined && named.id !== caller.agent.id) {
				throw new AgentError(-32602, 'metadata.agent does not match this endpoint');
			}
			const profile = caller.agent ?? named;
			const task = runtime.submit(principal, scopes, params.message, credential, {
				...(push === undefined ? {} : { push }),
				...(Object.keys(selection).length === 0 ? {} : { model: selection }),
				...(profile === undefined ? {} : { agent: profile.id }),
				// D-158: the A2A entrance, so the administrator's A2A switches apply.
				via: 'a2a',
			});
			if (method === 'SendStreamingMessage') return { events: runtime.subscribe(principal, task.id) };
			if (configuration.returnImmediately !== true && !terminal(task.status.state)) {
				const reader = runtime.subscribe(principal, task.id).getReader();
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						const state = value?.statusUpdate
							? object(object(value.statusUpdate).status).state
							: value?.task
							? object(object(value.task).status).state
							: undefined;
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
			if (terminal(runtime.get(principal, taskId).status.state)) {
				throw new AgentError(-32004, 'Terminal tasks cannot be subscribed');
			}
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
			if (
				params.statusTimestampAfter !== undefined &&
				(typeof params.statusTimestampAfter !== 'string' || !Number.isFinite(Date.parse(params.statusTimestampAfter)))
			) throw new AgentError(-32602, 'Invalid timestamp');
			const entries = runtime.listByCreation(principal).filter(({ task }) =>
				(caller.agent === undefined || task.metadata?.agent === caller.agent.id) &&
				(params.contextId === undefined || task.contextId === params.contextId) &&
				(params.status === undefined || task.status.state === params.status) &&
				(params.statusTimestampAfter === undefined ||
					Date.parse(task.status.timestamp) >= Date.parse(String(params.statusTimestampAfter)))
			);
			let start = 0;
			if (params.pageToken !== undefined && params.pageToken !== '') {
				// The cursor is a position, not a task: a task evicted since the last page cannot invalidate it.
				const cursor = pageCursor(params.pageToken);
				start = entries.findIndex(({ created, task }) =>
					created < cursor.created || (created === cursor.created && task.id.localeCompare(cursor.id) < 0)
				);
				if (start < 0) start = entries.length;
			}
			const slice = entries.slice(start, start + pageSize);
			const page = slice.map(({ task }) => {
				const view = runtime.get(principal, task.id, historyLength) as Record<string, unknown>;
				if (params.includeArtifacts !== true) delete view.artifacts;
				if (historyLength === 0) delete view.history;
				return view;
			});
			const last = slice.at(-1);
			return {
				result: {
					tasks: page,
					pageSize,
					totalSize: entries.length,
					nextPageToken: start + pageSize < entries.length && last ? pageToken(last.created, last.task.id) : '',
				},
			};
		}
		// A11: webhook configurations, owner-bound through the task they name. The token is never read back.
		case 'CreateTaskPushNotificationConfig': {
			// `{taskId, configId?, config}` or a `TaskPushNotificationConfig` `{taskId, pushNotificationConfig}`.
			const taskId = identifier(params.taskId);
			return { result: runtime.setPushConfig(principal, taskId, params.config ?? params, params.configId) };
		}
		case 'GetTaskPushNotificationConfig':
			return { result: runtime.getPushConfig(principal, identifier(params.taskId), configIdOf(params)) };
		case 'ListTaskPushNotificationConfig':
		case 'ListTaskPushNotificationConfigs': {
			integer(params.pageSize, 4, 1, 100);
			// At most four per task: one page always holds them all, so a page token has nothing to continue.
			return { result: { configs: runtime.listPushConfigs(principal, identifier(params.taskId)), nextPageToken: '' } };
		}
		case 'DeleteTaskPushNotificationConfig':
			runtime.deletePushConfig(principal, identifier(params.taskId), configIdOf(params));
			return { result: {} };
		case 'GetExtendedAgentCard':
			if (caller.extendedCard === undefined) throw new AgentError(-32004, 'Operation unsupported');
			return { result: caller.extendedCard() };
		default:
			throw new AgentError(method.includes('PushNotification') ? -32003 : -32601, 'Operation unsupported');
	}
}

/** What the composition root adds around the JSON-RPC endpoint. */
export interface A2aFetchOptions {
	/**
	 * A6: wraps a streaming response body — the gateway's `StreamGuard`, which re-checks the caller every 300 s and
	 * ends the stream at 1800 s with a terminal JSON-RPC error event carrying `rpcId`.
	 */
	readonly wrapStream?: (body: ReadableStream<Uint8Array>, rpcId: string | number | null) => ReadableStream<Uint8Array>;
	/** A11: this caller's extended card, for `GetExtendedAgentCard`. */
	readonly extendedCard?: () => Record<string, unknown>;
	/** D-156: the endpoint's fixed profile ({@linkcode A2aCaller.agent}). */
	readonly agent?: AgentProfile;
}

/**
 * Fetch adapter receives authenticated identity from its composition root. `credential` is the gateway's
 * fingerprint of the credential behind `principal`, carried onto submitted tasks so they can be re-authorized (GW-1).
 */
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
		if (!scopes.has('agent:invoke')) return Response.json({ error: 'agent:invoke scope required' }, { status: 403 });
		const version = request.headers.get('a2a-version');
		if (version !== '1.0') throw new AgentError(-32009, 'A2A-Version 1.0 required');
		const value = object(await readJson(request.body));
		if (
			value.jsonrpc !== '2.0' || typeof value.method !== 'string' ||
			(typeof value.id !== 'string' && typeof value.id !== 'number' && value.id !== null)
		) throw new AgentError(-32600, 'Request payload validation error');
		id = value.id as string | number | null;
		const params = object(value.params ?? {});
		const outcome = await a2aInvoke(value.method, params, {
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
		return Response.json({
			jsonrpc: '2.0',
			id,
			error: {
				code: error instanceof AgentError ? error.code : -32603,
				message: error instanceof AgentError ? error.message : 'Internal error',
			},
		}, { headers: { 'a2a-version': '1.0' } });
	}
}
