/** Composes optional coding services and agent protocols behind the gateway's existing guards. */
import {
	a2aFetch,
	a2aHttpError,
	a2aHttpFailure,
	a2aHttpStatus,
	a2aInvoke,
	AGENT_PROFILES,
	agentCard,
	AgentError,
	agentEventBody,
	type AgentMessage,
	type AgentProfile,
	agentProfile,
	AgentRuntime,
	type AgentRuntimeOptions,
	type AgentToolSkill,
	anthropicClient,
	EVENT_STREAM_HEADERS,
	extendedAgentCard,
	MODEL_REQUIRES_PROVIDER,
	type ModelProviderClient,
	type ModelTool,
	openAiClient,
	profileA2aPath,
	profileAgentCard,
	profileCardUrl,
	type PushOptions,
	type SecretSealer,
	terminal,
} from '@tykotech/agents';
import type { AgentSettings } from '@tykotech/agents';
import { SandboxClient } from '@tykotech/sandbox';
import {
	availabilityOf,
	CATALOG,
	createToolExecutor,
	type ExtensionActions,
	extensionTools,
	isForbiddenLiteralHost,
	LibraryError,
	libraryTools,
	type McpDeps,
	type Scope,
	type ToolContext,
	type ToolDefinition,
	ToolError,
} from '@tykotech/mcp';
import { join } from '@std/path';
import type { Context, Hono } from 'hono';
import * as z from 'zod';
import type { AppVariables } from './app.ts';
import { expansionOwner, type Principal } from './auth.ts';
import type { ExpansionConfig } from './expansion_config.ts';
import { a2aStreamFarewell, A2uiStore, attachA2uiRoutes, StreamGuard } from './a2ui.ts';
import { type EmbedStreamCaller, EmbedStreams, type EmbedStreamsOptions } from './embed_streams.ts';
import type { ModelProvidersConfig, ModelProviderSettings, ProviderView } from './model_providers.ts';
import { HttpProblem, problemResponse, type ProblemSlug } from './problem.ts';
import { MODEL_EXCLUDED, NOT_TASKABLE, notTaskable } from './taskable.ts';
import type { MemoryStore } from './memory.ts';
import { memoryActions } from './memory_tools.ts';

export interface ExpansionServices {
	readonly runtime: AgentRuntime;
	readonly surfaces: A2uiStore;
	readonly tools: readonly ToolDefinition[];
	readonly publish: (owner: string, message: unknown) => Record<string, unknown>;
	/** Every open A2UI and A2A event stream, re-checked on credential changes and ended at shutdown. */
	readonly streams: StreamGuard;
	/** The MCP tools a caller holding `scopes` may invoke as structured A2A tool tasks, for the extended card. */
	readonly invocableTools: (scopes: ReadonlySet<string>) => readonly AgentToolSkill[];
	/**
	 * The tools a task submitted by a caller holding `scopes` could run — the one predicate behind {@linkcode
	 * invocableTools} and the built-in model agent's tool list (`forModel` also subtracts `MODEL_EXCLUDED`).
	 */
	readonly taskableTools: (scopes: ReadonlySet<string>, forModel?: boolean) => ToolDefinition[];
	/**
	 * The configured providers as the route and the diagnostics show them, with the grant proof applied — built at
	 * startup from `ExpansionOptions.modelProviders` and {@linkcode modelGrantProven}, and rebuilt by {@linkcode
	 * applyModelProviders}, so read it at each use rather than keeping it.
	 */
	readonly modelProviders: { readonly default: string | null; readonly providers: readonly ProviderView[] };
	/**
	 * Installs a new providers set in the running process — one client per provider, the grant proof recomputed against
	 * the same permissions API, the runtime's map and default swapped in place and {@linkcode modelProviders} replaced
	 * — so the next task, route read, diagnostics read and agent card see it with no restart.
	 */
	readonly applyModelProviders?: (next: ModelProvidersConfig) => void;
	/**
	 * The MCP Apps terminal and surface streams (`embed_streams.ts`), present when `ExpansionOptions.embeds` is: their
	 * sockets are attached by the gateway, their tickets minted by `sandbox_session_ticket` and `a2ui_surface_ticket`.
	 */
	readonly embedStreams?: EmbedStreams;
	close(): Promise<void>;
}

/** What the composition root adds beyond configuration. */
export interface ExpansionOptions {
	/** Tasks and surfaces persist under `<dataDir>/agents/`; `null` or absent keeps them in memory. */
	readonly dataDir?: string | null;
	readonly logger?: { warn(message: string): void; info(message: string): void };
	/** What the push gate probes; `Deno.permissions` unless a test injects a fake. */
	readonly permissions?: Pick<Deno.Permissions, 'querySync'>;
	/** Tests only: overrides of the push policy (a resolver, a fetch, loopback http). Never from configuration. */
	readonly push?: Partial<PushOptions>;
	/** Tests only: the one-time DNS resolver probe; {@linkcode resolverPermitted} unless injected. */
	readonly resolverProbe?: (host: string) => Promise<boolean>;
	/**
	 * The model providers in force at startup — the operator's `TTK_MODEL_PROVIDERS_FILE` as the CLI resolved it,
	 * followed by the providers the control plane's store adds. `null` or absent: none yet, and a text task is refused;
	 * with `dataDir` set the runtime can still gain some (`applyModelProviders`).
	 */
	readonly modelProviders?: ModelProvidersConfig | null;
	/** The agents' vector memory in the database. */
	readonly memory?: MemoryStore;
	/**
	 * Seals an A2A push webhook's token in `agents/tasks.json` (`syncSealer` over `TTK_DB_KEY_FILE`). Absent, a token
	 * is never written: it lives in memory only and its config does not survive a restart.
	 */
	readonly sealer?: SecretSealer;
	/** The administrator's per-agent settings, read at every use (`AgentSettingsStore.current`). */
	readonly agents?: () => AgentSettings;
	/**
	 * MCP Apps is on (`TTK_MCP_APPS`): the socket origin, the embed origin gate and the shared connection ceiling the
	 * terminal and surface streams need. Absent, neither stream nor its ticket tool exists.
	 */
	readonly embeds?: Pick<EmbedStreamsOptions, 'socketBase' | 'admitOrigin' | 'connections'>;
}

/** Whether this process may use the system DNS resolver. */
async function resolverPermitted(host: string): Promise<boolean> {
	try {
		await Deno.resolveDns(host, 'A');
		return true;
	} catch (error) {
		return !(error instanceof Deno.errors.NotCapable || error instanceof Deno.errors.PermissionDenied);
	}
}

/** Whether the process holds an unscoped `--allow-net` (then the resolver is covered too). */
function netUnscoped(permissions: Pick<Deno.Permissions, 'querySync'> = Deno.permissions): boolean {
	try {
		return permissions.querySync({ name: 'net' }).state === 'granted';
	} catch {
		return false;
	}
}

/** The directory, under the data root, that holds `tasks.json` and `surfaces.json`. */
export const AGENT_STATE_DIR = 'agents';

/**
 * `agent_list_tasks`' `active` filter — every state a task can still leave: "not terminal" (`terminal()`, the runtime's
 * own definition).
 */
function activeTask(state: string): boolean {
	return !terminal(state);
}

/**
 * Whether this process holds an outbound net grant for **every** host `TTK_A2A_PUSH_ALLOWED_HOSTS` names, proven
 * through the permissions API the way `browser_head`'s grant is (`probeEgressGrant`), never declared.
 */
export function pushGrantProven(
	hosts: readonly string[],
	permissions: Pick<Deno.Permissions, 'querySync'> = Deno.permissions,
): boolean {
	if (hosts.length === 0) return false;
	const granted = (descriptor: Deno.NetPermissionDescriptor): boolean => {
		try {
			return permissions.querySync(descriptor).state === 'granted';
		} catch {
			return false;
		}
	};
	if (granted({ name: 'net' })) return true;
	return hosts.every((host) => {
		const hasPort = host.startsWith('[') ? /\]:\d+$/.test(host) : host.includes(':');
		return granted({ name: 'net', host: hasPort ? host : `${host}:443` });
	});
}

/**
 * The `--allow-net` spelling of one provider's host — `host:port`, the WHATWG host with the default port the URL parser
 * dropped put back by scheme (443 for `https:`, 80 for `http:`).
 */
export function providerNetHost(settings: Pick<ModelProviderSettings, 'host' | 'baseUrl'>): string {
	const host = settings.host;
	const hasPort = host.startsWith('[') ? /\]:\d+$/.test(host) : host.includes(':');
	if (hasPort) return host;
	return `${host}:${new URL(settings.baseUrl).protocol === 'http:' ? 80 : 443}`;
}

/**
 * Whether this process holds an outbound net grant for each configured model provider, proven through the permissions
 * API the way the push gate proves its hosts ({@linkcode pushGrantProven}), never declared.
 */
export function modelGrantProven(
	providers: readonly ModelProviderSettings[],
	permissions: Pick<Deno.Permissions, 'querySync'> = Deno.permissions,
): ReadonlyMap<string, boolean> {
	const granted = (descriptor: Deno.NetPermissionDescriptor): boolean => {
		try {
			return permissions.querySync(descriptor).state === 'granted';
		} catch {
			return false;
		}
	};
	const unscoped = providers.length > 0 && granted({ name: 'net' });
	return new Map(
		providers.map((settings) => [settings.id, unscoped || granted({ name: 'net', host: providerNetHost(settings) })]),
	);
}

/** `agent_default` for the providers route — the built-in agent's chosen model while a provider lists it. */
function builtinDefault(services: ExpansionServices): { agent_default?: { provider: string; model: string } } {
	const chosen = services.runtime.agentSetting('builtin').model;
	if (chosen === null) return {};
	const listed = services.modelProviders.providers.some((view) =>
		view.id === chosen.provider && view.models.includes(chosen.model)
	);
	return listed ? { agent_default: { provider: chosen.provider, model: chosen.model } } : {};
}

/** One client per provider, by `kind`; the settings (key included) go in by argument and stay inside. */
function modelClient(settings: ModelProviderSettings): ModelProviderClient {
	return settings.kind === 'anthropic' ? anthropicClient({ settings }) : openAiClient({ settings });
}

/** One taskable tool as the provider sees it — name, description, JSON Schema input; never its scope. */
function modelTool(tool: ToolDefinition): ModelTool {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<string, unknown>,
	};
}

function message(text: string): AgentMessage {
	return { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }] };
}

/** `agent_delegate` sends text, or structured A2A parts as given (the runtime validates and bounds them). */
function delegatedMessage(args: Record<string, unknown>): AgentMessage {
	if (Array.isArray(args.parts)) {
		return { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: structuredClone(args.parts) };
	}
	return message(String(args.message));
}

/** The tool error an A2UI store refusal becomes. */
function a2uiToolError(cause: unknown, surfaceId: string | undefined): ToolError {
	if (cause instanceof ToolError) return cause;
	if (cause instanceof HttpProblem) {
		if (cause.slug === 'not-found') {
			return new ToolError(
				'invalid-arguments',
				`you have no A2UI surface ${JSON.stringify(surfaceId ?? '')}: create it first with a2ui_publish ` +
					'{ version: "v0.9", createSurface: { surfaceId, catalogId } }',
			);
		}
		if (cause.slug === 'rate-limited') {
			return new ToolError(
				'feature-unavailable',
				`${cause.detail ?? 'A2UI surface limit reached'}: delete a surface you no longer need with a2ui_delete`,
			);
		}
		return new ToolError('invalid-arguments', cause.detail ?? 'the A2UI message was refused');
	}
	if (cause instanceof z.ZodError) {
		return new ToolError(
			'invalid-arguments',
			cause.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
		);
	}
	return new ToolError('invalid-arguments', cause instanceof Error ? cause.message : 'the A2UI message was refused');
}

/** The surface an A2UI message names, for the refusal's wording. */
function a2uiSurfaceOf(message: unknown): string | undefined {
	if (typeof message !== 'object' || message === null) return undefined;
	for (const operation of Object.values(message as Record<string, unknown>)) {
		const id = (operation as { surfaceId?: unknown } | null)?.surfaceId;
		if (typeof id === 'string') return id;
	}
	return undefined;
}

/**
 * The credential fingerprint the bearer gate stamped on this MCP call's `AuthInfo`, so a task an extension tool submits
 * is re-authorized against the same credential as one submitted over REST or A2A.
 */
function credentialOf(ctx: ToolContext): string | undefined {
	const value = ctx.mcp?.http?.authInfo?.extra?.credential;
	return typeof value === 'string' ? value : undefined;
}

/** Builds dependency-injected clients; the gateway never launches coding commands. */
export function createExpansionServices(
	config: ExpansionConfig,
	core: McpDeps,
	sandbox?: SandboxClient,
	/** Re-authorizes tasks against their submitting credential; the gateway passes its verifier's check. */
	authorize?: AgentRuntimeOptions['authorize'],
	options: ExpansionOptions = {},
): ExpansionServices {
	let tools: readonly ToolDefinition[] = [];
	const logger = options.logger;
	const stateDir = options.dataDir ? join(options.dataDir, AGENT_STATE_DIR) : undefined;
	// Push is offered only with an operator host list AND a proven grant for every host on it.
	const pushHosts = config.pushAllowedHosts ?? [];
	const pushOffered = pushGrantProven(pushHosts, options.permissions);
	if (pushHosts.length > 0 && !pushOffered) {
		logger?.warn(
			'A2A push notifications are not offered: TTK_A2A_PUSH_ALLOWED_HOSTS names a host this process holds no ' +
				'outbound net grant for; add each host (and the DNS resolver) to --allow-net to offer them',
		);
	} else if (pushOffered) logger?.info(`A2A push notifications are offered for ${pushHosts.join(', ')}`);
	// A scoped grant must also cover the DNS resolver every delivery consults. Until a one-time probe proves it, push
	// is not offered (card, methods); an unscoped grant covers the resolver and needs no probe.
	let resolverReady = pushOffered && netUnscoped(options.permissions);
	if (pushOffered && !resolverReady) {
		const probe = options.resolverProbe ?? resolverPermitted;
		void probe(pushHosts[0]!.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')).then((ok) => {
			resolverReady = ok;
			if (!ok) {
				logger?.warn(
					'A2A push notifications are not offered: the DNS resolver is outside --allow-net; grant the ' +
						"resolver's address so each delivery can check the webhook's addresses",
				);
			}
		});
	}
	const push: PushOptions | undefined = pushOffered
		? {
			ready: () => resolverReady,
			allowedHosts: pushHosts,
			// The same address classifier `browser_head` dials through, on a bare address (IPv6 bracketed for it).
			forbiddenAddress: (address) => isForbiddenLiteralHost(address.includes(':') ? `[${address}]` : address, []),
			...(logger === undefined ? {} : { logger }),
			...options.push,
		}
		: undefined;
	// The providers file, the grant proof, one client per provider, and the views the route and the diagnostics show.
	const providersConfig = options.modelProviders ?? null;
	const providersManaged = providersConfig !== null || (options.dataDir ?? null) !== null;
	const providerClients = new Map<string, ModelProviderClient>();
	const reachability = new Map<string, boolean>();
	let providerDefault: string | null = null;
	let providerSnapshot: ExpansionServices['modelProviders'] = Object.freeze({
		default: null,
		providers: Object.freeze([]),
	});
	const installProviders = (next: ModelProvidersConfig | null): void => {
		const proof = modelGrantProven(next?.providers ?? [], options.permissions);
		const clients: Array<[string, ModelProviderClient]> = [];
		const views: ProviderView[] = [];
		for (const settings of next?.providers ?? []) {
			const reachable = proof.get(settings.id) === true;
			clients.push([settings.id, modelClient(settings)]);
			views.push({
				id: settings.id,
				kind: settings.kind,
				label: settings.label,
				host: providerNetHost(settings),
				models: [...settings.models],
				default_model: settings.defaultModel,
				reachable,
				...(reachable ? {} : { reason: 'no-net-grant' as const }),
			});
			if (!reachable) {
				const entry = providerNetHost(settings);
				logger?.warn(
					`model provider ${settings.id} is not reachable: this process holds no outbound net grant for ${entry}; ` +
						`add ${entry} (and the DNS resolver for a named host) to --allow-net to offer it`,
				);
			}
		}
		// Every client is built before anything is swapped, so a throw above leaves the set in force untouched.
		providerClients.clear();
		for (const [id, client] of clients) providerClients.set(id, client);
		reachability.clear();
		for (const [id, reachable] of proof) reachability.set(id, reachable);
		providerDefault = next?.default ?? null;
		// Frozen; `default` is the file's (a sole provider, or `null` for several without one).
		providerSnapshot = Object.freeze({ default: providerDefault, providers: Object.freeze(views) });
	};
	installProviders(providersConfig);
	const runtime = new AgentRuntime({
		...(authorize === undefined ? {} : { authorize }),
		// Absent when no provider can ever exist, so the runtime refuses a text task without model routing; present but
		// empty answers the same.
		...(!providersManaged ? {} : {
			model: {
				providers: providerClients,
				// Read at every use, so a live swap moves the default with the set.
				get default(): string | null {
					return providerDefault;
				},
				reachable: (id: string): boolean => reachability.get(id) === true,
				tools: (scopes: ReadonlySet<string>): ModelTool[] => taskableTools(scopes, true).map(modelTool),
			},
		}),
		invoke: async (name, args, owner, scopes, signal): Promise<Record<string, unknown>> => {
			// The one door every structured task's tool call passes, whichever entrance submitted it. The refusal fails
			// the task before the tool runs, so nothing it would have returned is kept as an artifact.
			if (NOT_TASKABLE.has(name)) throw new AgentError(-32602, notTaskable(name));
			const call = createToolExecutor({ ...core, extraTools: tools }, owner, scopes as ReadonlySet<Scope>, signal);
			const result = await call(name, args);
			return result as Record<string, unknown>;
		},
		// A delegated data part must be a tool this caller could run here as a task — the same composed list a
		// structured task dispatches from (`taskableTools`, declared below and read only when a delegation is
		// submitted).
		delegableTool: (tool: string, scopes: ReadonlySet<string>): boolean =>
			taskableTools(scopes).some((candidate) => candidate.name === tool),
		// SlopLord works only in the coding sandbox; its card and its tasks follow whether one is composed.
		codingSandbox: sandbox !== undefined,
		...(options.agents === undefined ? {} : { agents: options.agents }),
		peers: config.peers,
		...(config.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: config.taskTimeoutMs }),
		...(config.taskRetentionMs === undefined ? {} : { retentionMs: config.taskRetentionMs }),
		...(stateDir === undefined ? {} : { persistPath: join(stateDir, 'tasks.json') }),
		...(options.sealer === undefined ? {} : { sealer: options.sealer }),
		...(push === undefined ? {} : { push }),
		...(logger === undefined ? {} : { logger }),
	});
	const configured = new Map((config.a2uiActions ?? []).map((action) => [action.name, action]));
	const surfaces = new A2uiStore({
		...(stateDir === undefined ? {} : { persistPath: join(stateDir, 'surfaces.json') }),
		...(logger === undefined ? {} : { logger }),
		// The operator's tool, the operator's fixed arguments, and only the declared context keys — scalars resolved
		// from the surface's server-side state.
		toolAction: async (owner, scopes, name, context): Promise<Record<string, unknown>> => {
			const action = configured.get(name);
			if (action === undefined) throw new HttpProblem('not-found', 'no such configured action');
			// `expansionConfig()` already refuses such an action at startup; this is the second line, for a
			// configuration that reached the store some other way.
			if (NOT_TASKABLE.has(action.tool)) throw new ToolError('invalid-arguments', notTaskable(action.tool));
			const args: Record<string, unknown> = structuredClone(action.arguments) as Record<string, unknown>;
			for (const key of action.context) {
				const value = context[key];
				if (!['string', 'number', 'boolean'].includes(typeof value)) {
					throw new HttpProblem('invalid-request', `action context ${key} must be a string, number or boolean`);
				}
				args[key] = value;
			}
			const call = createToolExecutor({ ...core, extraTools: tools }, owner, scopes as ReadonlySet<Scope>);
			return { tool: action.tool, result: await call(action.tool, args) };
		},
		cancelTask: (owner, _scopes, id): Promise<Record<string, unknown>> =>
			Promise.resolve({ task: runtime.cancel(owner, id) }),
	});
	const publish = (owner: string, value: unknown): Record<string, unknown> => {
		const result = surfaces.publish(owner, value);
		// Bind only actions whose target is live and owned. Declarative context cannot choose a tool. Publishing
		// another surface must not re-arm an already consumed one-shot action.
		for (
			const surface of (result.surface ? [result.surface] : []) as Array<{
				surfaceId: string;
				components: Array<
					{ id: string; component: string; action?: { event?: { name?: string; context?: Record<string, unknown> } } }
				>;
			}>
		) {
			for (const component of surface.components) {
				const event = component.action?.event;
				if (component.component !== 'Button' || !event) continue;
				if (event.name === 'cancelTask' && typeof event.context?.taskId === 'string') {
					try {
						if (terminal(runtime.get(owner, event.context.taskId).status.state)) continue;
						surfaces.registerAction(owner, surface.surfaceId, component.id, event.name, {
							kind: 'cancelTask',
							taskId: event.context.taskId,
						});
					} catch { /* Foreign and expired targets receive no action authority. */ }
				} else if (configured.has(event.name ?? '')) {
					// Bound only when the button declares exactly the context the operator allowed.
					const action = configured.get(event.name!)!;
					const keys = Object.keys(event.context ?? {}).sort();
					if (JSON.stringify(keys) !== JSON.stringify([...action.context].sort())) continue;
					surfaces.registerAction(owner, surface.surfaceId, component.id, action.name, {
						kind: 'toolAction',
						name: action.name,
					});
				}
			}
		}
		return result;
	};
	const actions: Record<string, ExtensionActions[string]> = {
		agent_peers: (): Promise<Record<string, unknown>> => Promise.resolve({ peers: runtime.peers() }),
		// One tool call as a background task, through the same runtime (and credential re-authorization before the
		// call) as an A2A structured task. Refusals come first and name only the tool the caller gave.
		agent_run_tool: (args, ctx): Promise<Record<string, unknown>> => {
			const tool = String(args.tool);
			if (NOT_TASKABLE.has(tool)) throw new ToolError('invalid-arguments', notTaskable(tool));
			const target = [...CATALOG, ...tools, ...libraryTools(core.library ?? null)].find((t) => t.name === tool);
			if (target === undefined) throw new ToolError('invalid-arguments', `there is no tool named ${tool}`);
			// Checked now so a missing grant fails the call rather than a task; the runtime re-checks before running.
			if (target.scope !== undefined && ctx.scopes?.has(target.scope) !== true) {
				throw new ToolError('scope-required', `this credential cannot call ${tool}`);
			}
			const task = runtime.submit(
				ctx.principal,
				ctx.scopes ?? new Set(),
				{
					messageId: crypto.randomUUID(),
					role: 'ROLE_USER',
					parts: [{ data: { tool, arguments: structuredClone(args.arguments ?? {}) } }],
				},
				credentialOf(ctx),
			);
			return Promise.resolve({ task });
		},
		// This owner's tasks only (`listByCreation` filters by owner), newest-created first, no history.
		agent_list_tasks: (args, ctx): Promise<Record<string, unknown>> => {
			const limit = typeof args.limit === 'number' ? args.limit : 20;
			const matching = runtime.listByCreation(ctx.principal).map((entry) => entry.task).filter((task) =>
				args.state === undefined || (args.state === 'active') === activeTask(task.status.state)
			);
			return Promise.resolve({
				tasks: matching.slice(0, limit).map((task) => ({ ...task, history: [] })),
				truncated: matching.length > limit,
			});
		},
		agent_get_task: (args, ctx): Promise<Record<string, unknown>> =>
			Promise.resolve({ task: taskRefusal(() => runtime.get(ctx.principal, String(args.task_id))) }),
		agent_cancel_task: (args, ctx): Promise<Record<string, unknown>> =>
			Promise.resolve({ task: taskRefusal(() => runtime.cancel(ctx.principal, String(args.task_id))) }),
		a2ui_publish: (args, ctx): Promise<Record<string, unknown>> => {
			try {
				return Promise.resolve(publish(ctx.principal, args.message));
			} catch (cause) {
				throw a2uiToolError(cause, a2uiSurfaceOf(args.message));
			}
		},
		a2ui_delete: (args, ctx): Promise<Record<string, unknown>> => {
			try {
				return Promise.resolve(surfaces.delete(ctx.principal, String(args.surface_id)));
			} catch (cause) {
				throw a2uiToolError(cause, String(args.surface_id));
			}
		},
	};
	if (config.peers.length) {
		actions.agent_delegate = (args, ctx): Promise<Record<string, unknown>> =>
			Promise.resolve({
				task: runtime.delegate(
					ctx.principal,
					ctx.scopes ?? new Set(),
					String(args.peer),
					delegatedMessage(args),
					credentialOf(ctx),
				),
			});
	}
	if (sandbox !== undefined) {
		const operations = {
			sandbox_create: 'create',
			// Offered only while the sandbox's /healthz says it clones (`availability.sandboxClone`).
			sandbox_clone: 'clone',
			sandbox_list: 'list',
			sandbox_read: 'read',
			sandbox_write: 'write',
			sandbox_exec: 'exec',
			sandbox_diff: 'diff',
			sandbox_delete: 'remove',
			// A live shell session over a workspace.
			sandbox_session_open: 'session_open',
			sandbox_session_input: 'session_input',
			sandbox_session_read: 'session_read',
			sandbox_session_close: 'session_close',
		} as const;
		for (const [name, operation] of Object.entries(operations)) {
			actions[name] = async (args, ctx): Promise<Record<string, unknown>> =>
				await sandbox.call(
					ctx.principal,
					operation,
					name === 'sandbox_create' ? await seedFromShare(core, args, ctx) : args,
					ctx.signal,
				);
		}
	}
	// The agents' memory, wherever there is a database to hold it.
	if (options.memory !== undefined) Object.assign(actions, memoryActions(options.memory));
	// MCP Apps streams: the terminal of a shell session and the live surface, behind app-only ticket tools.
	const embedStreams = options.embeds === undefined ? undefined : new EmbedStreams({
		...options.embeds,
		surfaces,
		...(sandbox === undefined ? {} : { sandbox }),
		...(authorize === undefined ? {} : { authorize }),
		...(logger === undefined ? {} : { logger }),
	});
	if (embedStreams !== undefined) {
		const callerOf = (ctx: ToolContext): EmbedStreamCaller => {
			const credential = credentialOf(ctx);
			return {
				principal: ctx.callerPrincipal ?? ctx.principal,
				owner: ctx.principal,
				scopes: ctx.scopes ?? new Set(),
				...(credential === undefined ? {} : { credential }),
			};
		};
		if (embedStreams.offers('terminal')) {
			actions.sandbox_session_ticket = async (args, ctx): Promise<Record<string, unknown>> => ({
				...await embedStreams.mintTerminal(callerOf(ctx), String(args.session_id), String(args.origin)),
			});
		}
		actions.a2ui_surface_ticket = async (args, ctx): Promise<Record<string, unknown>> => ({
			...await embedStreams.mintSurface(callerOf(ctx), String(args.surface_id), String(args.origin)),
		});
	}
	tools = extensionTools(actions);
	const streams = new StreamGuard();
	/**
	 * Exactly the tools a structured task submitted by this caller could run — the composed catalog the task executor
	 * dispatches from, filtered by the caller's scopes and by what this deployment can offer right now, and without the
	 * tools `invoke` refuses (the whole of `NOT_TASKABLE`, the sampling tools a task can never satisfy among them).
	 */
	const taskableTools = (scopes: ReadonlySet<string>, forModel = false): ToolDefinition[] => {
		if (!scopes.has('mcp:invoke')) return [];
		const availability = availabilityOf({ ...core, extraTools: tools });
		return [...CATALOG, ...tools, ...libraryTools(core.library ?? null)]
			.filter((tool) => !NOT_TASKABLE.has(tool.name) && !(forModel && MODEL_EXCLUDED.has(tool.name)))
			.filter((tool) => tool.scope === undefined || scopes.has(tool.scope))
			.filter((tool) => tool.available === undefined || tool.available(availability));
	};
	const invocableTools = (scopes: ReadonlySet<string>): readonly AgentToolSkill[] =>
		taskableTools(scopes).map((tool) => ({ name: tool.name, title: tool.title, description: tool.description }));
	return {
		runtime,
		surfaces,
		tools,
		publish,
		streams,
		...(embedStreams === undefined ? {} : { embedStreams }),
		invocableTools,
		taskableTools,
		// The views in force — a getter, so every reader (the providers route, the diagnostics, the
		// `capabilities.tykotech.model` counts) sees a live swap on its next read.
		get modelProviders(): ExpansionServices['modelProviders'] {
			return providerSnapshot;
		},
		// Only where the runtime holds a `model` option to swap; one info line per apply, never a value.
		...(!providersManaged ? {} : {
			applyModelProviders: (next: ModelProvidersConfig): void => {
				installProviders(next);
				logger?.info(`model providers updated: ${next.providers.length} providers`);
			},
		}),
		close: async (): Promise<void> => {
			streams.closeAll();
			embedStreams?.closeAll();
			// Both stores write their state before they let go of it.
			await Promise.all([surfaces.close(), runtime.close()]);
		},
	};
}

/** Mounts routes after bearer, host/origin, and rate guards; public card is metadata only. */
export function attachExpansionRoutes(
	app: Hono<{ Variables: AppVariables }>,
	services: ExpansionServices,
	publicUrl: string,
	authorized: (principal: Principal) => boolean = (principal) => principal.scopes.has('agent:invoke'),
): void {
	const owner = (principal: Principal | undefined): Principal => {
		if (!principal) throw new HttpProblem('unauthenticated');
		if (!principal.scopes.has('agent:invoke')) throw new HttpProblem('forbidden-scope');
		return principal;
	};
	/** A refusal on either A2A binding, before the operation (`owner`, the body bound) or inside it, as A2A shapes it. */
	const bindingFailure = (cause: unknown): Response =>
		cause instanceof HttpProblem ? a2aHttpError(cause.status, cause.message) : a2aHttpFailure(cause);
	// What this mount serves beyond JSON-RPC, so the card describes exactly that.
	const cardOptions = { extendedCard: true, httpJson: true };
	const extendedCard = (principal: Principal) => () =>
		extendedAgentCard(publicUrl, services.runtime, services.invocableTools(principal.scopes), cardOptions);
	/**
	 * An A2A event stream re-earns its authorization like every other long-lived stream: the caller's credential and
	 * `agent:invoke` are re-checked every 300 s and on every key reload or logout, and the stream ends at 1800 s — each
	 * time with a terminal JSON-RPC error event instead of an SSE `bye` an A2A client would not recognize.
	 */
	const guarded =
		(principal: Principal) =>
		(body: ReadableStream<Uint8Array>, rpcId: string | number | null | undefined): ReadableStream<Uint8Array> =>
			services.streams.wrap(body, () => authorized(principal), a2aStreamFarewell(rpcId));
	app.get('/.well-known/agent-card.json', (c) => c.json(agentCard(publicUrl, services.runtime, cardOptions)));
	/**
	 * The JSON-RPC endpoint: one handler for the main agent and for each built-in profile's own endpoint (`agent`
	 * fixed), so auth, bounds, streams, push and ownership cannot drift between them.
	 */
	const jsonRpc = (agent?: AgentProfile) => async (c: Context<{ Variables: AppVariables }>): Promise<Response> => {
		try {
			const principal = owner(c.get('principal'));
			const card = agent === undefined ? extendedCard(principal) : undefined;
			return await a2aFetch(
				c.req.raw,
				expansionOwner(principal),
				principal.scopes,
				services.runtime,
				principal.credential,
				{
					wrapStream: guarded(principal),
					...(card === undefined ? {} : { extendedCard: card }),
					...(agent === undefined ? {} : { agent }),
				},
			);
		} catch (cause) {
			return bindingFailure(cause);
		}
	};
	/** The HTTP+JSON binding below `root`, on the same handlers as JSON-RPC (`a2aInvoke`), for the main agent and each profile. */
	const httpJson =
		(root: string, agent?: AgentProfile) => async (c: Context<{ Variables: AppVariables }>): Promise<Response> => {
			try {
				const principal = owner(c.get('principal'));
				if (c.req.header('a2a-version') !== '1.0') throw new AgentError(-32009, 'A2A-Version 1.0 required');
				const route = await restOperation(c, root);
				if (route === null) {
					return a2aHttpError(404, `No A2A operation at ${c.req.method} ${new URL(c.req.url).pathname}`);
				}
				const card = agent === undefined ? extendedCard(principal) : undefined;
				const outcome = await a2aInvoke(route.method, route.params, {
					principal: expansionOwner(principal),
					scopes: principal.scopes,
					runtime: services.runtime,
					...(principal.credential === undefined ? {} : { credential: principal.credential }),
					...(card === undefined ? {} : { extendedCard: card }),
					...(agent === undefined ? {} : { agent }),
				});
				if ('events' in outcome) {
					return new Response(guarded(principal)(agentEventBody(outcome.events), undefined), {
						headers: { ...EVENT_STREAM_HEADERS, 'x-content-type-options': 'nosniff' },
					});
				}
				return c.json(outcome.result, 200, { 'a2a-version': '1.0' });
			} catch (cause) {
				return bindingFailure(cause);
			}
		};
	app.post('/a2a', jsonRpc());
	app.all(`${A2A_REST_ROOT}/*`, httpJson(A2A_REST_ROOT));
	// Each built-in profile (SlopLord) as its own A2A agent — a public card (`PUBLIC_PATHS` in `app.ts`) and the two
	// bindings, every message routed to the profile.
	for (const profile of AGENT_PROFILES.values()) {
		const base = profileA2aPath(profile.id);
		app.get(
			`${base}/.well-known/agent-card.json`,
			(c) => c.json(profileAgentCard(publicUrl, services.runtime, profile, { httpJson: true })),
		);
		app.post(base, jsonRpc(profile));
		app.all(`${base}/v1/*`, httpJson(`${base}/v1`, profile));
	}
	app.get('/api/v1/agent/tasks', (c): Response => {
		try {
			// Newest-created first, ties by id, each task carrying `created_at`.
			const tasks = services.runtime.listByCreation(expansionOwner(owner(c.get('principal'))))
				.map((entry) => ({ ...entry.task, created_at: new Date(entry.created).toISOString() }));
			return c.json({ tasks });
		} catch (cause) {
			return taskFailure(cause, c.get('requestId'));
		}
	});
	/**
	 * The configured providers, keys and URL paths never among them. `invocable` is the caller's own `model:invoke`.
	 */
	app.get('/api/v1/agent/providers', (c): Response => {
		try {
			const principal = owner(c.get('principal'));
			const invocable = principal.scopes.has('model:invoke');
			return c.json({
				invocable,
				default: services.modelProviders.default,
				// The built-in agent's own default model, when an administrator chose one still in force.
				...builtinDefault(services),
				providers: services.modelProviders.providers.map((view) => providerView(view, invocable)),
				// The built-in profiles, whether this deployment can run each (`profileReady`) and its card.
				agents: [...AGENT_PROFILES.values()].map((profile) => ({
					id: profile.id,
					name: profile.name,
					description: profile.description,
					available: services.runtime.profileReady(profile.id),
					card_url: profileCardUrl(publicUrl, profile),
				})),
			});
		} catch (cause) {
			return taskFailure(cause, c.get('requestId'));
		}
	});
	app.post('/api/v1/agent/tasks', async (c): Promise<Response> => {
		try {
			const principal = owner(c.get('principal'));
			const raw = await boundedBody(c.req.raw);
			// `provider` and `model` join `message`; each `undefined` or a string of at most 64 characters. Naming a
			// provider without `model:invoke` is refused here, before any task exists.
			if (
				typeof raw.message !== 'string' || raw.message.length > 65_536 ||
				Object.keys(raw).some((key) => !['message', 'provider', 'model', 'agent'].includes(key)) ||
				!selectionText(raw.provider) || !selectionText(raw.model) ||
				(raw.agent !== undefined && !AGENT_PROFILES.has(String(raw.agent)))
			) throw new HttpProblem('invalid-request');
			if (raw.provider !== undefined && !principal.scopes.has('model:invoke')) throw new HttpProblem('forbidden-scope');
			// A model without a provider is refused here too, before any task exists, with the runtime's own text as
			// `detail` — the same answer the runtime and the A2A binding give (`-32602`).
			if (raw.model !== undefined && raw.provider === undefined) {
				throw new HttpProblem('invalid-request', MODEL_REQUIRES_PROVIDER);
			}
			const selection = {
				...(raw.provider === undefined ? {} : { provider: raw.provider as string }),
				...(raw.model === undefined ? {} : { model: raw.model as string }),
			};
			return c.json({
				task: services.runtime.submit(
					expansionOwner(principal),
					principal.scopes,
					message(raw.message),
					principal.credential,
					{
						...(Object.keys(selection).length === 0 ? {} : { model: selection }),
						...(raw.agent === undefined ? {} : { agent: agentProfile(raw.agent).id }),
					},
				),
			}, 202);
		} catch (cause) {
			// The runtime's `-32602`/`-32004` reach the SPA as `400 invalid-request` with the text as `detail`
			// (`taskFailure`, at the status the A2A bindings give the same error).
			return taskFailure(cause, c.get('requestId'));
		}
	});
	app.get('/api/v1/agent/tasks/:id', (c): Response => {
		try {
			return c.json({
				task: services.runtime.get(expansionOwner(owner(c.get('principal'))), c.req.param('id')),
			});
		} catch (cause) {
			return taskFailure(cause, c.get('requestId'));
		}
	});
	app.post('/api/v1/agent/tasks/:id/cancel', (c): Response => {
		try {
			return c.json({ task: services.runtime.cancel(expansionOwner(owner(c.get('principal'))), c.req.param('id')) });
		} catch (cause) {
			return taskFailure(cause, c.get('requestId'));
		}
	});
	attachA2uiRoutes(app, services.surfaces, services.publish, { streams: services.streams, authorized });
}

/** A `provider`/`model` body value — absent, or a string of at most 64 characters. */
function selectionText(value: unknown): boolean {
	return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 64);
}

/** One provider as the caller may see it — `host` and `reason` only with `model:invoke`. */
function providerView(view: ProviderView, invocable: boolean): Record<string, unknown> {
	const { host, reason, ...shared } = view;
	return invocable ? { ...shared, host, ...(reason === undefined ? {} : { reason }) } : shared;
}

/** Where the HTTP+JSON binding is mounted; the card lists it as the `HTTP+JSON` interface URL. */
const A2A_REST_ROOT = '/a2a/v1';

/** The A2A JSON-RPC body bound (`readJson` in `@tykotech/agents`), so both bindings take the same messages. */
const A2A_BODY_BYTES = 512 * 1024;

/**
 * One HTTP+JSON request as the A2A operation and parameters the JSON-RPC binding would carry, or `null` for a path or
 * method the binding does not define.
 */
async function restOperation(
	c: Context<{ Variables: AppVariables }>,
	root: string,
): Promise<{ method: string; params: Record<string, unknown> } | null> {
	const url = new URL(c.req.url);
	const path = url.pathname.slice(root.length);
	const verb = c.req.method;
	const segment = (raw: string): string => {
		try {
			return decodeURIComponent(raw);
		} catch {
			throw new AgentError(-32602, 'Invalid path identifier');
		}
	};
	const integer = (name: string): number | undefined => {
		const raw = url.searchParams.get(name);
		if (raw === null) return undefined;
		if (!/^\d{1,9}$/.test(raw)) throw new AgentError(-32602, `Invalid ${name}`);
		return Number(raw);
	};
	const text = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
	const defined = (params: Record<string, unknown>): Record<string, unknown> =>
		Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
	const body = async (): Promise<Record<string, unknown>> => await boundedBody(c.req.raw, A2A_BODY_BYTES);
	if (verb === 'POST' && path === '/message:send') return { method: 'SendMessage', params: await body() };
	if (verb === 'POST' && path === '/message:stream') return { method: 'SendStreamingMessage', params: await body() };
	if (verb === 'GET' && path === '/extendedAgentCard') return { method: 'GetExtendedAgentCard', params: {} };
	if (verb === 'GET' && path === '/tasks') {
		const includeArtifacts = text('includeArtifacts');
		if (includeArtifacts !== undefined && !['true', 'false'].includes(includeArtifacts)) {
			throw new AgentError(-32602, 'Invalid includeArtifacts');
		}
		return {
			method: 'ListTasks',
			params: defined({
				contextId: text('contextId'),
				status: text('status'),
				pageSize: integer('pageSize'),
				pageToken: text('pageToken'),
				historyLength: integer('historyLength'),
				statusTimestampAfter: text('statusTimestampAfter'),
				includeArtifacts: includeArtifacts === undefined ? undefined : includeArtifacts === 'true',
			}),
		};
	}
	let match = /^\/tasks\/([^/:]+)(?::(cancel|subscribe))?$/.exec(path);
	if (match !== null) {
		const id = segment(match[1]!);
		if (match[2] === undefined && verb === 'GET') {
			return { method: 'GetTask', params: defined({ id, historyLength: integer('historyLength') }) };
		}
		if (match[2] === 'cancel' && verb === 'POST') return { method: 'CancelTask', params: { id } };
		// The binding is GET; POST is accepted too, as some A2A HTTP+JSON clients send it.
		if (match[2] === 'subscribe' && (verb === 'GET' || verb === 'POST')) {
			return { method: 'SubscribeToTask', params: { id } };
		}
		return null;
	}
	match = /^\/tasks\/([^/:]+)\/pushNotificationConfigs(?:\/([^/:]+))?$/.exec(path);
	if (match !== null) {
		const taskId = segment(match[1]!);
		const configId = match[2] === undefined ? undefined : segment(match[2]);
		if (configId === undefined && verb === 'POST') {
			return { method: 'CreateTaskPushNotificationConfig', params: { ...await body(), taskId } };
		}
		if (configId === undefined && verb === 'GET') {
			return { method: 'ListTaskPushNotificationConfig', params: defined({ taskId, pageSize: integer('pageSize') }) };
		}
		if (configId !== undefined && verb === 'GET') {
			return { method: 'GetTaskPushNotificationConfig', params: { taskId, id: configId } };
		}
		if (configId !== undefined && verb === 'DELETE') {
			return { method: 'DeleteTaskPushNotificationConfig', params: { taskId, id: configId } };
		}
	}
	return null;
}

/**
 * The task runtime's own refusals over MCP: an id this owner does not hold (`-32001`) or a task that has already ended
 * (`-32002`) is the caller's to fix, so it is `invalid-arguments` with the runtime's public message.
 */
function taskRefusal<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof AgentError && (error.code === -32001 || error.code === -32002)) {
			throw new ToolError('invalid-arguments', error.message);
		}
		throw error;
	}
}

/**
 * A failure on the web app's task routes as problem+json: the status the A2A bindings give the same error
 * (`a2aHttpStatus`), and the runtime's public message as `detail`, so all three surfaces say the same thing.
 */
function taskFailure(cause: unknown, requestId: string): Response {
	if (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId, cause.detail);
	if (!(cause instanceof AgentError)) return problemResponse('internal', requestId);
	const slug = TASK_PROBLEMS[a2aHttpStatus(cause.code)] ?? 'invalid-request';
	return problemResponse(slug, requestId, cause.message);
}

/** The problem for each status `a2aHttpStatus` gives; every other one is 400 `invalid-request`. */
const TASK_PROBLEMS: Readonly<Record<number, ProblemSlug>> = {
	403: 'forbidden-scope',
	404: 'not-found',
	500: 'internal',
	503: 'service-unavailable',
};

/** Bounded non-stream operation reader. Long-lived stream cleanup is handled by stream.cancel(). */
async function boundedBody(request: Request, limit = 256 * 1024): Promise<Record<string, unknown>> {
	const reader = request.body?.getReader();
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (reader) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > limit) throw new HttpProblem('payload-too-large');
			chunks.push(chunk.value);
		}
	} finally {
		await reader?.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
		return value as Record<string, unknown>;
	} catch {
		throw new HttpProblem('invalid-request');
	}
}

/** The seed bounds the sandbox itself enforces on `create` (64 files, 256 KiB in all). */
const SEED_LIMITS = { maxFiles: 64, maxBytes: 256 * 1024 } as const;

/** `sandbox_create { from_share }` seeds the workspace from a folder of the library's file share. */
async function seedFromShare(
	core: McpDeps,
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<Record<string, unknown>> {
	if (args.from_share === undefined) return args;
	const { from_share, ...rest } = args;
	if (ctx.scopes?.has('files:read') !== true) {
		throw new ToolError('scope-required', 'this credential cannot read the file share');
	}
	if (core.library === undefined) throw new ToolError('feature-unavailable', 'this deployment has no file share');
	let seeded: Record<string, string>;
	try {
		seeded = await core.library.collectText(from_share, SEED_LIMITS);
	} catch (cause) {
		if (cause instanceof LibraryError) {
			throw new ToolError(cause.code === 'not-found' ? 'file-unavailable' : 'invalid-arguments', cause.message);
		}
		throw cause;
	}
	return { ...rest, files: { ...seeded, ...(rest.files as Record<string, string> | undefined ?? {}) } };
}
