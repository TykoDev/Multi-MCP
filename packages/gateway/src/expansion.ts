/** Composes optional coding services and agent protocols behind the gateway's existing guards. */
import {
	a2aFetch,
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
import { HttpProblem, problemResponse } from './problem.ts';
import { MODEL_EXCLUDED, NOT_TASKABLE, notTaskable } from './taskable.ts';
import type { MemoryStore } from './memory.ts';
import { memoryActions } from './memory_tools.ts';

export interface ExpansionServices {
	readonly runtime: AgentRuntime;
	readonly surfaces: A2uiStore;
	readonly tools: readonly ToolDefinition[];
	readonly publish: (owner: string, message: unknown) => Record<string, unknown>;
	/** GW-3: every open A2UI and task event stream, re-checked on credential changes and ended at shutdown. */
	readonly streams: StreamGuard;
	/**
	 * A11: the MCP tools a caller holding `scopes` may invoke as structured A2A tool tasks, for the extended card.
	 * Absent: the extended card is not served (`-32004`) and the card says `extendedAgentCard: false`.
	 */
	readonly invocableTools?: (scopes: ReadonlySet<string>) => readonly AgentToolSkill[];
	/**
	 * D-143: the tools a task submitted by a caller holding `scopes` could run — the one predicate behind
	 * {@linkcode invocableTools} and the built-in model agent's tool list (`forModel` also subtracts `MODEL_EXCLUDED`).
	 */
	readonly taskableTools: (scopes: ReadonlySet<string>, forModel?: boolean) => ToolDefinition[];
	/**
	 * D-143 (addendum B): every A2UI action name a surface may bind — the two built-ins plus the operator's
	 * `TTK_A2UI_ACTIONS` names — sorted, computed once (actions are fail-fast configuration). Names only, never the
	 * tool behind a configured one.
	 */
	readonly actionNames: readonly string[];
	/** D-143 (C3): whether an ACP bridge is configured, for `GET /api/v1/agent/providers`. */
	readonly acp: boolean;
	/**
	 * D-143 (§3.3, §3.7): the configured providers as the route and the diagnostics show them, with the grant proof
	 * applied — built at startup from `ExpansionOptions.modelProviders` and {@linkcode modelGrantProven}, and rebuilt by
	 * {@linkcode applyModelProviders} (D-152, D-153), so read it at each use rather than keeping it. A view carries no
	 * key, no URL path and no header; the route strips `host`/`reason` for a caller without `model:invoke`. Empty with
	 * no provider configured.
	 */
	readonly modelProviders: { readonly default: string | null; readonly providers: readonly ProviderView[] };
	/**
	 * D-152 / D-153: installs a new providers set in the running process — one client per provider, the grant proof
	 * recomputed against the same permissions API, the runtime's map and default swapped in place and
	 * {@linkcode modelProviders} replaced — so the next task, route read, diagnostics read and agent card see it with no
	 * restart. A task already running keeps the client it started with. Present whenever providers could ever be added
	 * — a providers file or a data directory (`ExpansionOptions.dataDir`) — because the runtime's `model` option is
	 * fixed at construction; absent otherwise (stdio without a file), where nothing is managed.
	 */
	readonly applyModelProviders?: (next: ModelProvidersConfig) => void;
	/**
	 * The MCP Apps terminal and surface streams (`embed_streams.ts`), present when `ExpansionOptions.embeds` is: their
	 * sockets are attached by the gateway, their tickets minted by `sandbox_session_ticket` and `a2ui_surface_ticket`.
	 */
	readonly embedStreams?: EmbedStreams;
	close(): Promise<void>;
}

/** The two action names every deployment binds (`A2uiToolActionsSchema` reserves them; `publish` registers them). */
const BUILTIN_ACTION_NAMES = ['cancelTask', 'permissionDecision'] as const;

/** What the composition root adds beyond configuration. */
export interface ExpansionOptions {
	/**
	 * B1 / G5: tasks and surfaces persist under `<dataDir>/agents/`; `null` or absent keeps them in memory. D-153: set,
	 * the model providers are managed (the control plane's store lives there), so the runtime is composed able to gain
	 * providers even when it starts with none.
	 */
	readonly dataDir?: string | null;
	readonly logger?: { warn(message: string): void; info(message: string): void };
	/** A11: what the push gate probes; `Deno.permissions` unless a test injects a fake. */
	readonly permissions?: Pick<Deno.Permissions, 'querySync'>;
	/** A11, tests only: overrides of the push policy (a resolver, a fetch, loopback http). Never from configuration. */
	readonly push?: Partial<PushOptions>;
	/** B-6, tests only: the one-time DNS resolver probe; {@linkcode resolverPermitted} unless injected. */
	readonly resolverProbe?: (host: string) => Promise<boolean>;
	/**
	 * R1 (D-121): told the id of every task created here, so a cluster can record which node holds it and route
	 * `agent_get_task` / `agent_cancel_task` there. Review R3-5: every task the runtime creates — by an MCP tool
	 * (`agent_run_tool`, `agent_prompt`, `agent_delegate`), over A2A or its HTTP+JSON binding, or over REST — not only
	 * the MCP ones (the runtime's `onTaskCreated`). Must not throw; the gateway's callback records asynchronously and
	 * swallows a store failure, and a get that races the record is looked for across the cluster (`firstFound`).
	 */
	readonly onToolTask?: (taskId: string) => void;
	/**
	 * D-143 (W3): the model providers in force at startup — the operator's `TTK_MODEL_PROVIDERS_FILE` as the CLI
	 * resolved it, followed (D-153) by the providers the control plane's store adds. `null` or absent: none yet, and a
	 * text task needs the ACP bridge; with `dataDir` set the runtime can still gain some (`applyModelProviders`). The key
	 * on each entry reaches its client by argument here and is read nowhere else in this module.
	 */
	readonly modelProviders?: ModelProvidersConfig | null;
	/**
	 * D-154: the agents' vector memory in the database. Present, the four `memory_*` tools are offered (reading needs
	 * `files:read`, changing `files:write`), owner-scoped like every other owned resource; absent (no data directory),
	 * they are not.
	 */
	readonly memory?: MemoryStore;
	/**
	 * D-154: seals an A2A push webhook's token in `agents/tasks.json` (`syncSealer` over `TTK_DB_KEY_FILE`). Absent, a
	 * token is never written: it lives in memory only and its config does not survive a restart.
	 */
	readonly sealer?: SecretSealer;
	/** D-158: the administrator's per-agent settings, read at every use (`AgentSettingsStore.current`). */
	readonly agents?: () => AgentSettings;
	/**
	 * MCP Apps is on (`TTK_MCP_APPS`): the socket origin, the embed origin gate and the shared connection ceiling the
	 * terminal and surface streams need. Absent, neither stream nor its ticket tool exists.
	 */
	readonly embeds?: Pick<EmbedStreamsOptions, 'socketBase' | 'admitOrigin' | 'connections'>;
}

/**
 * Build gate B-6: whether this process may use the system DNS resolver. Under a scoped `--allow-net`, Deno checks the
 * resolver's own address against the grant before any query, so a refusal arrives as `NotCapable` (or
 * `PermissionDenied`) without network traffic; any other outcome — an answer, NXDOMAIN, a timeout — proves the
 * permission. Push deliveries re-resolve every webhook host, so without this a scoped grant would advertise push and
 * then fail every delivery.
 */
export async function resolverPermitted(host: string): Promise<boolean> {
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

/**
 * B1: the directory, under the data root, that holds `tasks.json` and `surfaces.json`. Node-local by design (G8):
 * cluster nodes must not share one data directory's agent files.
 */
export const AGENT_STATE_DIR = 'agents';

/**
 * X-1 (D-141): the taskable set and its refusal live in the leaf `taskable.ts`, which configuration can import without
 * this module's graph; re-exported here so every importer of `expansion.ts` is unchanged.
 */
export { NOT_TASKABLE, notTaskable, SAMPLING_TOOLS } from './taskable.ts';

/**
 * R1 (D-121): `agent_list_tasks`' `active` filter — every state a task can still leave.
 *
 * ERRATUM(E-100). Design §2.9 listed submitted, working and input-required. The runtime also has
 * `TASK_STATE_AUTH_REQUIRED`, which is not terminal; a closed list of three would show such a task under neither
 * `active` nor `finished`. "Not terminal" (`terminal()`, the runtime's own definition) is that list plus it.
 */
function activeTask(state: string): boolean {
	return !terminal(state);
}

/**
 * A11 / N1: whether this process holds an outbound net grant for **every** host `TTK_A2A_PUSH_ALLOWED_HOSTS` names,
 * proven through the permissions API the way `browser_head`'s grant is (`probeEgressGrant`), never declared. An
 * unscoped `--allow-net` proves it outright; otherwise each host is queried at its port (443 unless named). An empty
 * list proves nothing, and push is then not offered at all.
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
 * D-143 (backend §3): the `--allow-net` spelling of one provider's host — `host:port`, the WHATWG host with the
 * default port the URL parser dropped put back by scheme (443 for `https:`, 80 for `http:`). An IPv6 literal keeps
 * its brackets, as `--allow-net` spells it.
 */
export function providerNetHost(settings: Pick<ModelProviderSettings, 'host' | 'baseUrl'>): string {
	const host = settings.host;
	const hasPort = host.startsWith('[') ? /\]:\d+$/.test(host) : host.includes(':');
	if (hasPort) return host;
	return `${host}:${new URL(settings.baseUrl).protocol === 'http:' ? 80 : 443}`;
}

/**
 * D-143 (backend §3, gate condition 3): whether this process holds an outbound net grant for each configured model
 * provider, proven through the permissions API the way the push gate proves its hosts ({@linkcode pushGrantProven}),
 * never declared. An unscoped `--allow-net` reaches every provider; otherwise each is queried at
 * {@linkcode providerNetHost}. Computed at startup and again for each set the control plane installs (D-153) — the
 * matrix itself is immutable while the process runs — and fail-closed: a `querySync` throw is `false`. A provider the proof does not reach is listed `reachable: false` and
 * never dialled (the runtime refuses it with `-32004` before any request).
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

/** D-158: `agent_default` for the providers route — the built-in agent's chosen model while a provider lists it. */
function builtinDefault(services: ExpansionServices): { agent_default?: { provider: string; model: string } } {
	const chosen = services.runtime.agentSetting('builtin').model;
	if (chosen === null) return {};
	const listed = services.modelProviders.providers.some((view) =>
		view.id === chosen.provider && view.models.includes(chosen.model)
	);
	return listed ? { agent_default: { provider: chosen.provider, model: chosen.model } } : {};
}

/** D-143 (W3): one client per provider, by `kind`; the settings (key included) go in by argument and stay inside. */
function modelClient(settings: ModelProviderSettings): ModelProviderClient {
	return settings.kind === 'anthropic' ? anthropicClient({ settings }) : openAiClient({ settings });
}

/** D-143 (W3): one taskable tool as the provider sees it — name, description, JSON Schema input; never its scope. */
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

/** E-7: `agent_delegate` sends text, or structured A2A parts as given (the runtime validates and bounds them). */
function delegatedMessage(args: Record<string, unknown>): AgentMessage {
	if (Array.isArray(args.parts)) {
		return { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: structuredClone(args.parts) };
	}
	return message(String(args.message));
}

/**
 * The tool error an A2UI store refusal becomes. The store speaks the REST problem vocabulary, whose generic mapping
 * (`extension_tools.ts`) turned every refusal into "could not complete; check the service configuration" — a missing
 * surface read as a broken server. Every detail here is the store's or the wire validator's own fixed text (no
 * upstream service is involved), so it is passed on; a missing surface names what to do instead.
 */
export function a2uiToolError(cause: unknown, surfaceId: string | undefined): ToolError {
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
 * GW-1: the credential fingerprint the bearer gate stamped on this MCP call's `AuthInfo`, so a task an extension
 * tool submits is re-authorized against the same credential as one submitted over REST or A2A. Absent on stdio,
 * whose runtime has no `authorize` and keeps submitted scopes.
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
	sessionMcp?: AgentRuntimeOptions['sessionMcp'],
	/** GW-1: re-authorizes tasks against their submitting credential; the gateway passes its verifier's check. */
	authorize?: AgentRuntimeOptions['authorize'],
	options: ExpansionOptions = {},
): ExpansionServices {
	let tools: readonly ToolDefinition[] = [];
	const logger = options.logger;
	const stateDir = options.dataDir ? join(options.dataDir, AGENT_STATE_DIR) : undefined;
	// A11 / N1: push is offered only with an operator host list AND a proven grant for every host on it.
	const pushHosts = config.pushAllowedHosts ?? [];
	const pushOffered = pushGrantProven(pushHosts, options.permissions);
	if (pushHosts.length > 0 && !pushOffered) {
		logger?.warn(
			'A2A push notifications are not offered: TTK_A2A_PUSH_ALLOWED_HOSTS names a host this process holds no ' +
				'outbound net grant for; add each host (and the DNS resolver) to --allow-net to offer them',
		);
	} else if (pushOffered) logger?.info(`A2A push notifications are offered for ${pushHosts.join(', ')}`);
	// B-6: a scoped grant must also cover the DNS resolver every delivery consults. Until a one-time probe proves it,
	// push is not offered (card, methods); an unscoped grant covers the resolver and needs no probe.
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
	// D-143 (W3, backend §3): the providers file, the grant proof, one client per provider, and the views the route
	// and the diagnostics show. An unreachable provider is still a client in the map — the routing table (§3.10) tells
	// "unknown" (`-32602`) from "not reachable" (`-32004`) by its presence — but `reachable` keeps it from being dialled.
	// The CLI already warned per `allow_http` provider; only the `no-net-grant` warning is this module's.
	//
	// D-152 / D-153: the set can be replaced while the process runs (`applyModelProviders`). The runtime holds
	// `providerClients` and `reachability` by reference and reads `default` through a getter, so a swap clears and
	// refills these in one synchronous step — no task can observe a half-built set — and the routing semantics stay the
	// runtime's own. The permissions matrix is still immutable while the process runs; the proof is recomputed because
	// the hosts changed. D-153: managed whenever providers could ever exist — the operator's file, or a data directory
	// holding the control plane's store — so a gateway started with neither file nor store providers can gain some.
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
		// D-143 (W3): frozen; `default` is the file's (a sole provider, or `null` for several without one).
		providerSnapshot = Object.freeze({ default: providerDefault, providers: Object.freeze(views) });
	};
	installProviders(providersConfig);
	const runtime = new AgentRuntime({
		...(sessionMcp === undefined ? {} : { sessionMcp }),
		...(authorize === undefined ? {} : { authorize }),
		// D-143: absent when no provider can ever exist, so the runtime's text-task answers stay the S0 ones (§3.10 rows
		// 5–6); D-153: present but empty answers the same.
		// `tools` is the built-in agent's list — `taskableTools(scopes, true)`, declared below and read only once a task
		// runs — in the provider-facing shape. `invoke` below is shared with the structured tool-task path: the executor
		// answers a scope or availability refusal as an `isError` result, never a throw, so the loop feeds it back to
		// the model as a tool failure; `NOT_TASKABLE` never reaches it from the loop, whose list leaves those out.
		...(!providersManaged ? {} : {
			model: {
				providers: providerClients,
				// D-152 / D-153: read at every use, so a live swap moves the default with the set.
				get default(): string | null {
					return providerDefault;
				},
				reachable: (id: string): boolean => reachability.get(id) === true,
				tools: (scopes: ReadonlySet<string>): ModelTool[] => taskableTools(scopes, true).map(modelTool),
			},
		}),
		invoke: async (name, args, owner, scopes, signal): Promise<Record<string, unknown>> => {
			// Review R1-3: the one door every structured task's tool call passes, whichever entrance submitted it. The
			// refusal fails the task before the tool runs, so nothing it would have returned is kept as an artifact.
			if (NOT_TASKABLE.has(name)) throw new AgentError(-32602, notTaskable(name));
			const call = createToolExecutor({ ...core, extraTools: tools }, owner, scopes as ReadonlySet<Scope>, signal);
			const result = await call(name, args);
			return result as Record<string, unknown>;
		},
		...(config.bridge === null ? {} : { bridge: config.bridge }),
		// D-156: SlopLord works only in the coding sandbox; its card and its tasks follow whether one is composed.
		codingSandbox: sandbox !== undefined,
		...(options.agents === undefined ? {} : { agents: options.agents }),
		peers: config.peers,
		...(config.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: config.taskTimeoutMs }),
		...(config.taskRetentionMs === undefined ? {} : { retentionMs: config.taskRetentionMs }),
		...(stateDir === undefined ? {} : { persistPath: join(stateDir, 'tasks.json') }),
		...(options.sealer === undefined ? {} : { sealer: options.sealer }),
		...(push === undefined ? {} : { push }),
		...(logger === undefined ? {} : { logger }),
		// Review R3-5 (D-121): every task the runtime creates is reported — over MCP, A2A, its HTTP+JSON binding and
		// REST alike — so a cluster routes its id to this node whichever entrance created it.
		...(options.onToolTask === undefined ? {} : { onTaskCreated: options.onToolTask }),
	});
	const configured = new Map((config.a2uiActions ?? []).map((action) => [action.name, action]));
	const surfaces = new A2uiStore({
		...(stateDir === undefined ? {} : { persistPath: join(stateDir, 'surfaces.json') }),
		...(logger === undefined ? {} : { logger }),
		// E-4: the operator's tool, the operator's fixed arguments, and only the declared context keys — scalars
		// resolved from the surface's server-side state. Dispatched through the same executor as an agent's tool
		// call, so the target tool's own scope is checked against the clicking principal's current scopes.
		toolAction: async (owner, scopes, name, context): Promise<Record<string, unknown>> => {
			const action = configured.get(name);
			if (action === undefined) throw new HttpProblem('not-found', 'no such configured action');
			// X-1 (D-141): `expansionConfig()` already refuses such an action at startup; this is the second line, for
			// a configuration that reached the store some other way. A click has no MCP context to confirm through and
			// no caller to hand a link or ticket to, so it is refused before the executor is even built.
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
		permissionDecision: async (owner, _scopes, requestId, optionId): Promise<Record<string, unknown>> => {
			for (const task of runtime.list(owner)) {
				const pending = runtime.permission(owner, task.id);
				if (pending?.id === requestId) {
					await runtime.decidePermission(owner, task.id, requestId, optionId);
					return { resolved: true };
				}
			}
			throw new HttpProblem('not-found', 'permission is no longer pending');
		},
	});
	const publish = (owner: string, value: unknown): Record<string, unknown> => {
		const result = surfaces.publish(owner, value);
		// Bind only actions whose target is live and owned. Declarative context cannot choose a tool.
		// Publishing another surface must not re-arm an already consumed one-shot action.
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
					// E-4: bound only when the button declares exactly the context the operator allowed.
					const action = configured.get(event.name!)!;
					const keys = Object.keys(event.context ?? {}).sort();
					if (JSON.stringify(keys) !== JSON.stringify([...action.context].sort())) continue;
					surfaces.registerAction(owner, surface.surfaceId, component.id, action.name, {
						kind: 'toolAction',
						name: action.name,
					});
				} else if (
					event.name === 'permissionDecision' && typeof event.context?.requestId === 'string' &&
					typeof event.context?.optionId === 'string'
				) {
					for (const task of runtime.list(owner)) {
						const pending = runtime.permission(owner, task.id);
						const options = (pending?.params as Record<string, unknown> | undefined)?.options;
						if (
							pending?.id === event.context.requestId && Array.isArray(options) &&
							options.some((option: unknown) =>
								option !== null && typeof option === 'object' &&
								(option as Record<string, unknown>).optionId === event.context?.optionId &&
								['allow_once', 'reject_once'].includes(String((option as Record<string, unknown>).kind))
							)
						) {
							surfaces.registerAction(owner, surface.surfaceId, component.id, event.name, {
								kind: 'permissionDecision',
								requestId: event.context.requestId,
								optionId: event.context.optionId,
							});
						}
					}
				}
			}
		}
		return result;
	};
	// R1 (D-121): a task created here is reported for cluster routing by the runtime itself (`onTaskCreated` above,
	// review R3-5), so the MCP actions below report nothing of their own and no task is recorded twice.
	const actions: Record<string, ExtensionActions[string]> = {
		agent_peers: (): Promise<Record<string, unknown>> => Promise.resolve({ peers: runtime.peers() }),
		// R1 (D-121): one tool call as a background task, through the same runtime (and GW-1 re-authorization before
		// the call) as an A2A structured task. Refusals come first and name only the tool the caller gave.
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
		// R1 (D-121): this owner's tasks only (`listByCreation` filters by owner), newest-created first, no history.
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
	if (config.bridge !== null) {
		actions.agent_prompt = (args, ctx): Promise<Record<string, unknown>> =>
			Promise.resolve({
				task: runtime.submit(
					ctx.principal,
					ctx.scopes ?? new Set(),
					message(String(args.message)),
					credentialOf(ctx),
				),
			});
	}
	if (sandbox !== undefined) {
		const operations = {
			sandbox_create: 'create',
			// R12 (design §2.19): offered only while the sandbox's /healthz says it clones (`availability.sandboxClone`).
			sandbox_clone: 'clone',
			sandbox_list: 'list',
			sandbox_read: 'read',
			sandbox_write: 'write',
			sandbox_exec: 'exec',
			sandbox_diff: 'diff',
			sandbox_delete: 'remove',
			// D-076: a live shell session over a workspace.
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
	// D-154: the agents' memory, wherever there is a database to hold it.
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
	 * A11 / D-143: exactly the tools a structured task submitted by this caller could run — the composed catalog the
	 * task executor dispatches from, filtered by the caller's scopes and by what this deployment can offer right now,
	 * and without the tools `invoke` refuses (review R1-3: the whole of `NOT_TASKABLE`, the sampling tools a task can
	 * never satisfy among them). A task needs `mcp:invoke` before any tool at all. The built-in model agent's list
	 * (`forModel`) also leaves out `MODEL_EXCLUDED`, so a model never fans out into another text task.
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
	// D-143 (addendum B): static per process; `TTK_A2UI_ACTIONS` is fail-fast configuration (`expansion_config.ts`).
	const actionNames: readonly string[] = Object.freeze([...BUILTIN_ACTION_NAMES, ...configured.keys()].sort());
	return {
		runtime,
		surfaces,
		tools,
		publish,
		streams,
		...(embedStreams === undefined ? {} : { embedStreams }),
		invocableTools,
		taskableTools,
		actionNames,
		acp: config.bridge !== null,
		// D-143 (W3) / D-152 / D-153: the views in force — a getter, so every reader (the providers route, the diagnostics, the
		// `capabilities.tykotech.model` counts) sees a live swap on its next read.
		get modelProviders(): ExpansionServices['modelProviders'] {
			return providerSnapshot;
		},
		// D-152 / D-153: only where the runtime holds a `model` option to swap; one info line per apply, never a value.
		...(!providersManaged ? {} : {
			applyModelProviders: (next: ModelProvidersConfig): void => {
				installProviders(next);
				logger?.info(`model providers updated: ${next.providers.length} providers`);
			},
		}),
		close: async (): Promise<void> => {
			streams.closeAll();
			embedStreams?.closeAll();
			// B1: both stores write their state before they let go of it.
			await Promise.all([surfaces.close(), runtime.close()]);
		},
	};
}

/**
 * Mounts routes after bearer, host/origin, and rate guards; public card is metadata only.
 *
 * `authorized` (GW-3) re-checks the principal behind a long-lived stream: its credential is still in force and
 * still holds `agent:invoke`. The gateway passes its verifier's live check; without one only the lifetime applies.
 */
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
	const failure = (cause: unknown, requestId: string): Response => {
		if (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId);
		const code = (cause as { code?: number })?.code;
		return problemResponse(code === -32001 ? 'not-found' : 'invalid-request', requestId);
	};
	// A11: what this mount serves beyond JSON-RPC, so the card describes exactly that.
	const cardOptions = { extendedCard: services.invocableTools !== undefined, httpJson: true };
	const extendedCard = (principal: Principal) =>
		services.invocableTools === undefined
			? undefined
			: () => extendedAgentCard(publicUrl, services.runtime, services.invocableTools!(principal.scopes), cardOptions);
	/**
	 * A6 (D-106): an A2A event stream re-earns its authorization like every other long-lived stream (GW-3): the
	 * caller's credential and `agent:invoke` are re-checked every 300 s and on every key reload or logout, and the
	 * stream ends at 1800 s — each time with a terminal JSON-RPC error event instead of an SSE `bye` an A2A client
	 * would not recognize. Before this, a second credential of the task's owner kept receiving for the task's life.
	 */
	const guarded =
		(principal: Principal) =>
		(body: ReadableStream<Uint8Array>, rpcId: string | number | null | undefined): ReadableStream<Uint8Array> =>
			services.streams.wrap(body, () => authorized(principal), a2aStreamFarewell(rpcId));
	app.get('/.well-known/agent-card.json', (c) => c.json(agentCard(publicUrl, services.runtime, cardOptions)));
	/**
	 * The JSON-RPC endpoint. D-156: one handler for the main agent and for each built-in profile's own endpoint
	 * (`agent` fixed), so auth, bounds, streams, push and ownership cannot drift between them. A profile endpoint
	 * serves no extended card (its card says `extendedAgentCard: false`).
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
			return failure(cause, c.get('requestId'));
		}
	};
	/** A11: the HTTP+JSON binding below `root`, on the same handlers as JSON-RPC (`a2aInvoke`); D-156 as above. */
	const httpJson =
		(root: string, agent?: AgentProfile) => async (c: Context<{ Variables: AppVariables }>): Promise<Response> => {
			const requestId = c.get('requestId');
			try {
				const principal = owner(c.get('principal'));
				if (c.req.header('a2a-version') !== '1.0') throw new AgentError(-32009, 'A2A-Version 1.0 required');
				const route = await restOperation(c, root);
				if (route === null) return problemResponse('not-found', requestId);
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
				return restFailure(cause, requestId);
			}
		};
	app.post('/a2a', jsonRpc());
	app.all(`${A2A_REST_ROOT}/*`, httpJson(A2A_REST_ROOT));
	// D-156: each built-in profile (SlopLord) as its own A2A agent — a public card (`PUBLIC_PATHS` in `app.ts`) and the
	// two bindings, every message routed to the profile. Registered after `/a2a/v1/*`, which never matches below
	// `/a2a/agents/`.
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
			// D-146 (amendment): newest-created first, ties by id (AG-14's order), each task carrying `created_at`. The
			// control plane threads an owner's tasks as chat turns, and a task's status timestamp cannot order those — it
			// moves with every update, so a long-running turn would jump past later ones. Creation never changes.
			const principal = expansionOwner(owner(c.get('principal')));
			// `?workspace_id=<id>`: the tasks that touched one coding workspace — its id in the request, the history, the
			// artifacts or the run log (a tool call's arguments, a sandbox_create result). A workspace id is a UUID, so a
			// textual match names that workspace and no other.
			const workspace = c.req.query('workspace_id');
			if (workspace !== undefined && !UUID.test(workspace)) {
				throw new HttpProblem('invalid-request', 'workspace_id must be a workspace id (a UUID)');
			}
			const needle = workspace?.toLowerCase();
			const tasks = services.runtime.listByCreation(principal).filter((entry) =>
				needle === undefined || JSON.stringify(entry.task).toLowerCase().includes(needle) ||
				JSON.stringify(services.runtime.runLog(principal, entry.task.id).entries).toLowerCase().includes(needle)
			).map((entry) => ({ ...entry.task, created_at: new Date(entry.created).toISOString() }));
			return c.json({ tasks });
		} catch (cause) {
			return failure(cause, c.get('requestId'));
		}
	});
	/**
	 * D-143 (§3.3): the configured providers, keys and URL paths never among them. `invocable` is the caller's own
	 * `model:invoke`; `acp` says whether a bridge exists. `host` and `reason` are told only to a caller who could use
	 * the provider (gate F9, SEC-16): a caller without the scope sees the list, not the map of the hosts behind it.
	 */
	app.get('/api/v1/agent/providers', (c): Response => {
		try {
			const principal = owner(c.get('principal'));
			const invocable = principal.scopes.has('model:invoke');
			return c.json({
				invocable,
				// D-158: whether the bridge takes text tasks now (configured, and not switched off by an administrator).
				acp: services.runtime.routesToBridge(),
				default: services.modelProviders.default,
				// D-158: the built-in agent's own default model, when an administrator chose one still in force.
				...builtinDefault(services),
				providers: services.modelProviders.providers.map((view) => providerView(view, invocable)),
				// D-156: the built-in profiles, whether this deployment can run each (`profileReady`) and its card.
				agents: [...AGENT_PROFILES.values()].map((profile) => ({
					id: profile.id,
					name: profile.name,
					description: profile.description,
					available: services.runtime.profileReady(profile.id),
					card_url: profileCardUrl(publicUrl, profile),
				})),
			});
		} catch (cause) {
			return failure(cause, c.get('requestId'));
		}
	});
	app.post('/api/v1/agent/tasks', async (c): Promise<Response> => {
		try {
			const principal = owner(c.get('principal'));
			const raw = await boundedBody(c.req.raw);
			// D-143 (§3.4, addendum C): `provider` and `model` join `message`; each `undefined` or a string of at most
			// 64 characters. Naming a provider without `model:invoke` is refused here, before any task exists.
			// D-156: `agent` names a built-in profile (SlopLord); anything but a known id is `invalid-request`.
			if (
				typeof raw.message !== 'string' || raw.message.length > 65_536 ||
				Object.keys(raw).some((key) => !['message', 'provider', 'model', 'agent'].includes(key)) ||
				!selectionText(raw.provider) || !selectionText(raw.model) ||
				(raw.agent !== undefined && !AGENT_PROFILES.has(String(raw.agent)))
			) throw new HttpProblem('invalid-request');
			if (raw.provider !== undefined && !principal.scopes.has('model:invoke')) throw new HttpProblem('forbidden-scope');
			// CR-1 / BUG-6: a model without a provider is refused here too, before any task exists, with the runtime's
			// own text as `detail` — the same answer the runtime and the A2A binding give (`-32602`).
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
			// §3.4 (gate F18): the runtime's `-32602`/`-32004` reach the SPA as `400 invalid-request` with the text as
			// `detail`, through the mapper the HTTP+JSON binding already uses — which is itself unchanged.
			return restFailure(cause, c.get('requestId'));
		}
	});
	app.get('/api/v1/agent/tasks/:id', (c): Response => {
		try {
			return c.json({
				task: services.runtime.get(expansionOwner(owner(c.get('principal'))), c.req.param('id')),
				permission: services.runtime.permission(expansionOwner(owner(c.get('principal'))), c.req.param('id')),
			});
		} catch (cause) {
			return failure(cause, c.get('requestId'));
		}
	});
	// A task's run history: its times and the bounded, redacted run log (provider requests, tool calls, states).
	app.get('/api/v1/agent/tasks/:id/log', (c): Response => {
		try {
			return c.json(services.runtime.runLog(expansionOwner(owner(c.get('principal'))), c.req.param('id')));
		} catch (cause) {
			return failure(cause, c.get('requestId'));
		}
	});
	app.post('/api/v1/agent/tasks/:id/cancel', (c): Response => {
		try {
			return c.json({ task: services.runtime.cancel(expansionOwner(owner(c.get('principal'))), c.req.param('id')) });
		} catch (cause) {
			return failure(cause, c.get('requestId'));
		}
	});
	app.post('/api/v1/agent/tasks/:id/permission', async (c): Promise<Response> => {
		try {
			const principal = owner(c.get('principal'));
			const raw = await boundedBody(c.req.raw);
			if (
				typeof raw.permissionId !== 'string' || (raw.optionId !== undefined && typeof raw.optionId !== 'string') ||
				Object.keys(raw).some((key) => !['permissionId', 'optionId'].includes(key))
			) throw new HttpProblem('invalid-request');
			await services.runtime.decidePermission(
				expansionOwner(principal),
				c.req.param('id'),
				raw.permissionId,
				raw.optionId as string | undefined,
			);
			return c.json({ resolved: true });
		} catch (cause) {
			return failure(cause, c.get('requestId'));
		}
	});
	app.get('/api/v1/agent/tasks/:id/events', (c): Response => {
		try {
			const principal = owner(c.get('principal'));
			const events = services.runtime.subscribe(expansionOwner(principal), c.req.param('id')).getReader();
			const body = new ReadableStream<Uint8Array>({
				async pull(controller): Promise<void> {
					const next = await events.read();
					if (next.done) controller.close();
					else controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(next.value)}\n\n`));
				},
				cancel: (): Promise<void> => events.cancel(),
			});
			// GW-3: the subscription re-earns its authorization on the gateway's horizon and ends at a lifetime.
			return new Response(
				services.streams.wrap(body, () => authorized(principal)),
				{
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-store',
						'x-content-type-options': 'nosniff',
					},
				},
			);
		} catch (cause) {
			return failure(cause, c.get('requestId'));
		}
	});
	attachA2uiRoutes(app, services.surfaces, services.publish, {
		streams: services.streams,
		authorized,
		actionNames: services.actionNames,
	});
}

/** A coding workspace id as `sandbox_create` issues it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** D-143 (§3.4): a `provider`/`model` body value — absent, or a string of at most 64 characters. */
function selectionText(value: unknown): boolean {
	return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 64);
}

/** D-143 (§3.3, gate F9): one provider as the caller may see it — `host` and `reason` only with `model:invoke`. */
function providerView(view: ProviderView, invocable: boolean): Record<string, unknown> {
	const { host, reason, ...shared } = view;
	return invocable ? { ...shared, host, ...(reason === undefined ? {} : { reason }) } : shared;
}

/** A11: where the HTTP+JSON binding is mounted; the card lists it as the `HTTP+JSON` interface URL. */
export const A2A_REST_ROOT = '/a2a/v1';

/** The A2A JSON-RPC body bound (`readJson` in `@tykotech/agents`), so both bindings take the same messages. */
const A2A_BODY_BYTES = 512 * 1024;

/**
 * A11: one HTTP+JSON request as the A2A operation and parameters the JSON-RPC binding would carry, or `null` for a
 * path or method the binding does not define. Path ids are decoded once; query values are typed as JSON-RPC would
 * send them, so `a2aInvoke` validates both bindings with the same checks.
 */
async function restOperation(
	c: Context<{ Variables: AppVariables }>,
	root: string = A2A_REST_ROOT,
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
		// The design names GET; POST is accepted too, as some A2A HTTP+JSON clients send it.
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
 * The task runtime's own refusals over MCP: an id this owner does not hold (`-32001`) or a task that has already
 * ended (`-32002`) is the caller's to fix, so it is `invalid-arguments` with the runtime's public message. Without
 * this the extension wrapper, which reads only an HTTP `status`, reported both as a service fault.
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
 * A11: an HTTP+JSON failure as problem+json. The A2A code chooses the status — `-32001` not found, `-32002` (not
 * cancelable) a conflict, `-32603` (runtime closed, capacity, subscriber limit) unavailable, every other code a
 * request the caller can fix — and its public, credential-free message is the detail.
 */
function restFailure(cause: unknown, requestId: string): Response {
	if (cause instanceof HttpProblem) return problemResponse(cause.slug, requestId, cause.detail);
	if (cause instanceof AgentError) {
		const slug = cause.code === -32001
			? 'not-found'
			: cause.code === -32002
			? 'conflict'
			: cause.code === -32603
			? 'service-unavailable'
			: 'invalid-request';
		return problemResponse(slug, requestId, cause.message);
	}
	return problemResponse('internal', requestId);
}

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

/**
 * E-6 / D6: `sandbox_create { from_share }` seeds the workspace from a folder of the library's file share. The share
 * is read here, in the gateway that owns it, and handed to the sandbox as ordinary seed files, so the sandbox never
 * sees the data volume. Reading the share is its own grant: the caller needs `files:read` as well as
 * `sandbox:execute`. Files named in `files` win over the share's copy of the same path.
 */
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
