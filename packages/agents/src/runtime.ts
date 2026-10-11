import { AgentBridgeClient, type AgentBridgeOptions } from './bridge.ts';
import { A2aPeerClient, type AgentPeer } from './peer.ts';
import { AUTH_REQUIRED } from './acp.ts';
import { DurableJsonFile } from './durable.ts';
import {
	MAX_PUSH_CONFIGS_PER_TASK,
	type PushConfig,
	pushConfigInput,
	PushDispatcher,
	type PushOptions,
	pushOrigin,
} from './push.ts';
import { AgentError, EventQueue, identifier, object } from './util.ts';
import type { ModelProviderClient, ModelTool } from './model/types.ts';
import { type ModelEvent, runModelTask } from './model/loop.ts';
import { REDACTION_MIN_LENGTH } from './model/redact.ts';
import {
	MCP_INVOKE_SCOPE_REQUIRED,
	MODEL_INVOKE_SCOPE_REQUIRED,
	MODEL_REQUIRES_PROVIDER,
	SANDBOX_EXECUTE_SCOPE_REQUIRED,
} from './model/texts.ts';
import { AGENT_PROFILES, type AgentProfile, agentProfile, type AgentProfileId } from './model/profiles.ts';
import {
	type AgentId,
	type AgentSetting,
	type AgentSettings,
	DEFAULT_AGENT_SETTINGS,
	isA2uiTool,
	settingAllows,
} from './settings.ts';

/** Principal/scopes originate in the gateway bearer gate, never message metadata. */
export type ToolInvocation = (
	toolName: string,
	args: Record<string, unknown>,
	principal: string,
	scopes: ReadonlySet<string>,
	signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

/**
 * GW-1: re-authorizes a task against the exact credential that submitted it.
 *
 * A task used to carry its owner and scopes from submission onwards and was never asked again, so a queued or
 * running task kept acting on a key that had since been removed, rotated or narrowed. The gateway injects this
 * (the agents package never imports gateway code); the runtime calls it when a task starts, before every tool
 * invocation and delegation request, and when the gateway reports a credential change. It returns the scopes the
 * credential holds **now** — the runtime still narrows them to the submitted set, so a widened key never widens a
 * task — or `null` once the credential is revoked, rotated, expired or logged out.
 */
export type AgentAuthorization = (
	owner: string,
	scopes: ReadonlySet<string>,
	credential: string | undefined,
) => ReadonlySet<string> | null;

/** Optional backends are explicit operator dependencies. */
export interface AgentRuntimeOptions {
	invoke: ToolInvocation;
	bridge?: AgentBridgeOptions;
	peers?: readonly AgentPeer[];
	/**
	 * Issue a short-lived same-owner gateway capability for this exact ACP session. GW-1: it is asked with the
	 * task's own credential fingerprint and current scopes, never by owner alone.
	 */
	sessionMcp?: (
		owner: string,
		scopes: ReadonlySet<string>,
		credential?: string,
	) => AgentSessionMcp | Promise<AgentSessionMcp>;
	/** Absent (stdio, tests): a task keeps its submitted scopes, as a credential-less mount has nothing to revoke. */
	authorize?: AgentAuthorization;
	/** How long a task may wait for an execution slot; defaults to {@linkcode TASK_QUEUE_DEADLINE_MS}. */
	queueDeadlineMs?: number;
	/**
	 * C4 / G10: how long a text (ACP) or delegation task may run, `TTK_AGENT_TASK_TIMEOUT_S`; defaults to
	 * {@linkcode TEXT_TASK_TIMEOUT_MS}. A tool task's bound comes from its tools ({@linkcode toolTaskBoundMs}).
	 */
	taskTimeoutMs?: number;
	/** B1: how long a finished task is kept, `TTK_AGENT_TASK_RETENTION_S`; defaults to {@linkcode TASK_RETENTION_MS}. */
	retentionMs?: number;
	/**
	 * B1 / G5: the task document, `<TTK_DATA_DIR>/agents/tasks.json`. Absent (no data directory, stdio, tests) keeps
	 * every task in memory only, as before.
	 */
	persistPath?: string;
	/** A11: the operator's webhook policy. Absent means push notifications are not offered (`-32003`). */
	push?: PushOptions;
	/**
	 * D-154: seals a webhook's token before `tasks.json` holds it and opens it on restore, bound to its task and config
	 * id. Absent (no `TTK_DB_KEY_FILE`), a token is never written: the config is persisted without it and dropped on
	 * restore, since a token-protected webhook cannot be honoured without its token.
	 */
	sealer?: SecretSealer;
	/** Persistence and delivery failures; never a credential, token or message content. */
	logger?: { warn(message: string): void };
	/**
	 * Review R3-5 (D-121): told the id of every task this runtime creates — over MCP, A2A, its HTTP+JSON binding or
	 * REST, submitted or delegated — once, after the task exists and before anything can read it. The gateway records
	 * the id so a cluster routes a later get or cancel to this node. Never told of a retry answered with its earlier
	 * task, a follow-up message, or a task restored from disk (its record was written when it was created). A throw is
	 * the hook's own failure: the task stands.
	 */
	onTaskCreated?: (taskId: string) => void;
	/**
	 * D-143 (model-providers-ui): the operator's model providers, built by the gateway from `TTK_MODEL_PROVIDERS_FILE`
	 * and the process's proven net grant. `reachable` answers the grant proof per provider id; `tools` is the caller's
	 * taskable tool list for a text task (the gateway's `taskableTools(scopes, true)`), so this package never imports
	 * the catalog. Absent: no built-in agent, and a text task needs the ACP `bridge` as before. S0 seam: stored and
	 * read by the routing table (§3.10) and `supportsText`; W2 adds the loop that runs the chosen provider.
	 *
	 * D-152 / D-153: `providers`, `default` and `reachable` are read at every use, never copied, so the gateway can swap
	 * the set in place (one map it clears and refills, `default` a getter) when an administrator adds or changes a
	 * provider. The object itself is fixed for the runtime's life, so the gateway passes it whenever providers could
	 * ever be added (a providers file or a data directory) — possibly empty, which routes exactly as its absence does.
	 */
	model?: {
		readonly providers: ReadonlyMap<string, ModelProviderClient>;
		readonly default: string | null;
		readonly reachable: (id: string) => boolean;
		readonly tools: (scopes: ReadonlySet<string>) => ModelTool[];
	};
	/**
	 * D-156: whether the coding sandbox is composed. A profile that needs it (SlopLord) is advertised and accepted only
	 * then; its tools' own availability (the sandbox's health) still decides each call. Absent: no sandbox.
	 */
	codingSandbox?: boolean;
	/**
	 * D-158: the administrator's per-agent settings (`settings.ts`), read at every use so a change applies to the next
	 * task. Absent: {@linkcode DEFAULT_AGENT_SETTINGS}, the behaviour before D-158.
	 */
	agents?: () => AgentSettings;
}

/** D-143: a caller's choice of provider (and model) for a text task — `provider`/`model` on the request. */
export interface ModelSelection {
	readonly provider?: string;
	readonly model?: string;
}

/**
 * D-143, addendum A: `task.metadata`, one flat object on every task from `TASK_STATE_SUBMITTED` on, so every binding
 * (REST, MCP, A2A, SSE snapshots) and the SPA read the task's kind without parsing its history. `provider`/`model`
 * are the resolved ids (default applied), only when the built-in agent runs it; `steps`/`usage` are written by the
 * loop as it runs (W2).
 */
export interface AgentTaskMetadata extends Record<string, unknown> {
	readonly kind: 'text' | 'tool' | 'delegation';
	readonly backend?: 'model' | 'acp';
	readonly provider?: string;
	readonly model?: string;
	readonly steps?: number;
	readonly usage?: { readonly input: number; readonly output: number };
	/** D-156: the built-in profile that ran a text task (`profiles.ts`); absent for the plain built-in agent and ACP. */
	readonly agent?: AgentProfileId;
}

/** §3.10 rows 5–6 and the S0 state (no provider configured): the one text the scopeless caller ever sees. */
const NO_TEXT_BACKEND = 'Text execution requires a configured ACP agent or a model provider';
/** D-158: a text task from the A2A bindings while the administrator has the built-in agent off A2A. */
const NOT_OFFERED_OVER_A2A = 'The built-in agent is not offered over A2A';

/**
 * GW-1: a queued task carries the authority of the one request that submitted it, and only four run at once, so it
 * may not wait indefinitely for a slot. Two minutes matches the gateway's cached-authority and delegation horizon
 * (`auth.ts`), so a task never starts on a decision older than the one an ACP delegation could be issued from.
 */
export const TASK_QUEUE_DEADLINE_MS = 120_000;

/** C4 / G10: the default bound for text and delegation tasks (`TTK_AGENT_TASK_TIMEOUT_S` = 600). */
export const TEXT_TASK_TIMEOUT_MS = 600_000;
/** B1: the default retention of a finished task (`TTK_AGENT_TASK_RETENTION_S` = 86 400). */
export const TASK_RETENTION_MS = 86_400_000;
/** C4: a tool call whose tool names no bound of its own (design §2.6). */
export const TOOL_CALL_BOUND_MS = 120_000;
/** C4: what a tool task is given beyond its tool's own bound, for dispatch, the browser lock and the result. */
export const TOOL_BOUND_MARGIN_MS = 30_000;
/**
 * ERRATUM(E-85). C4 (deviation, see D-105): the coding sandbox holds a command up to two minutes for one of its two execution slots
 * (`LIMITS.maxWaitMs` in `@tykotech/sandbox`) before the command's own `timeout_ms` starts to run. A bound of
 * `timeout_ms + 30 s` alone would cut a queued command the sandbox would still have run to completion.
 */
export const SANDBOX_SLOT_WAIT_MS = 120_000;

/** Tasks running at once, across every owner. */
export const TASK_SLOTS = 4;
/**
 * Review R2-7: tasks one owner may run at once. D-105 lets one tool task hold a slot for hours (64 parts of a
 * 15-minute `sandbox_exec`), so without a per-owner share one owner's long tasks could hold every slot while other
 * owners' tasks ran out their queue deadline. An owner's further tasks wait their turn behind their own.
 */
export const TASK_SLOTS_PER_OWNER = 2;

/**
 * C4 / G10: how long one structured tool call of a task may take — the tool's own maximum plus
 * {@linkcode TOOL_BOUND_MARGIN_MS} where the tool exposes one, else {@linkcode TOOL_CALL_BOUND_MS}.
 *
 * Read from the arguments before the tool validates them, so each value is clamped to the range the tool itself
 * accepts: a request cannot buy a longer bound with an argument the tool will then refuse. `browser_run_task` needs
 * a sampling client and cannot run as a task at all, so it has no entry.
 */
export function toolTaskBoundMs(tool: string, args: Readonly<Record<string, unknown>>): number {
	const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
		typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
	switch (tool) {
		case 'sandbox_exec':
			// `LIMITS` in packages/sandbox/src/limits.ts: default 5 min, 1 s – 15 min.
			return bounded(args.timeout_ms, 300_000, 1_000, 900_000) + SANDBOX_SLOT_WAIT_MS + TOOL_BOUND_MARGIN_MS;
		case 'browser_wait_for':
			// packages/mcp/src/catalog/navigation.ts: default 10 s, 100 ms – 60 s.
			return bounded(args.timeout_ms, 10_000, 100, 60_000) + TOOL_BOUND_MARGIN_MS;
		default:
			return TOOL_CALL_BOUND_MS;
	}
}

const UNAUTHORIZED = 'Task credential is no longer authorized';
const QUEUE_EXPIRED = 'Task was not started before its queue deadline';
/** B1 / G5: what a task that was queued, running or waiting for a decision at shutdown says after the restart. */
export const INTERRUPTED_BY_RESTART = 'interrupted by restart';

/** Capability credentials are passed only to the runner and revoked on session cleanup. */
export interface AgentSessionMcp {
	servers: readonly Record<string, unknown>[];
	close(): void;
}

/** The supported A2A 1.0 message subset uses no legacy kind discriminator. */
export interface AgentMessage extends Record<string, unknown> {
	messageId: string;
	role: 'ROLE_USER' | 'ROLE_AGENT';
	parts: Record<string, unknown>[];
	contextId?: string;
	taskId?: string;
}

/** A task snapshot contains protocol data only, never its owner or credentials. */
export interface AgentTask extends Record<string, unknown> {
	id: string;
	contextId: string;
	status: { state: string; timestamp: string; message?: AgentMessage };
	artifacts: Record<string, unknown>[];
	history: AgentMessage[];
	/** D-143 (addendum A): present on every task this runtime creates; absent only on a task restored from an older file. */
	metadata?: AgentTaskMetadata;
}

/** What a run-log entry records. */
export type RunLogKind =
	| 'received'
	| 'state'
	| 'model_request'
	| 'tool_call'
	| 'tool_result'
	| 'acp'
	| 'peer_request'
	| 'artifact'
	| 'truncated';

/**
 * One entry of a task's run log: when (`at`, ISO 8601), what (`kind`), and the facts of it — a provider request's
 * timing and usage, a tool call's name and (redacted, clipped) arguments, a state change. The log is what happened
 * inside a run, kept after it: the live event stream shows the same events but only to whoever was listening.
 * Never a message sent to a provider, a key or a credential.
 */
export interface RunLogEntry extends Record<string, unknown> {
	readonly at: string;
	readonly kind: RunLogKind;
}

/** A task's run log as `runLog` answers it: the task's times, its entries oldest first, and whether it was cut. */
export interface RunLog {
	readonly created_at: string;
	readonly finished_at?: string;
	readonly entries: RunLogEntry[];
	readonly truncated: boolean;
}

/** The run log's bounds per task: entries, and serialized bytes. Past either, one `truncated` entry ends it. */
export const RUN_LOG_MAX_ENTRIES = 300;
export const RUN_LOG_MAX_BYTES = 128 * 1024;
/** What one logged argument object or result text may take before it is clipped. */
export const RUN_LOG_VALUE_LIMIT = 4 * 1024;

const RUN_LOG_KINDS: ReadonlySet<string> = new Set<RunLogKind>([
	'received',
	'state',
	'model_request',
	'tool_call',
	'tool_result',
	'acp',
	'peer_request',
	'artifact',
	'truncated',
]);

/** A value as the run log keeps it: itself while its JSON fits {@linkcode RUN_LOG_VALUE_LIMIT}, else a marker. */
function logValue(value: unknown): unknown {
	const json = JSON.stringify(value ?? null);
	return json.length <= RUN_LOG_VALUE_LIMIT ? value : { truncated: true, bytes: json.length };
}

/** Text as the run log keeps it: at most {@linkcode RUN_LOG_VALUE_LIMIT} characters, marked when cut. */
function logText(text: string): string {
	return text.length <= RUN_LOG_VALUE_LIMIT ? text : `${text.slice(0, RUN_LOG_VALUE_LIMIT)}… [${text.length} chars]`;
}

/** A tool result as the run log keeps it: its text content joined, else its JSON. */
function toolText(result: Record<string, unknown>): string {
	const texts = Array.isArray(result.content)
		? result.content.flatMap((item) =>
			item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string'
				? [item.text as string]
				: []
		)
		: [];
	return texts.length > 0 ? texts.join('\n') : JSON.stringify(result) ?? '';
}

/** A stored run log re-read: well-formed entries only, within today's bounds. */
function storedLog(value: unknown): RunLogEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: RunLogEntry[] = [];
	let bytes = 0;
	for (const item of value.slice(0, RUN_LOG_MAX_ENTRIES + 1)) {
		if (
			item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.at !== 'string' ||
			typeof item.kind !== 'string' || !RUN_LOG_KINDS.has(item.kind)
		) continue;
		bytes += JSON.stringify(item).length;
		if (bytes > RUN_LOG_MAX_BYTES + 1024) break;
		entries.push(item as RunLogEntry);
	}
	return entries;
}

interface TaskRecord {
	owner: string;
	scopes: ReadonlySet<string>;
	/** GW-1: opaque fingerprint of the submitting credential; re-checked, never shown or returned. */
	credential?: string;
	task: AgentTask;
	controller: AbortController;
	// AG-10: no per-task replay buffer. A subscriber always receives the full task snapshot first, so replaying
	// buffered events would only duplicate it; the buffer held up to 256 events / 2 MiB per task with no reader.
	listeners: Set<EventQueue>;
	/** AG-14: immutable creation instant, the stable half of the ListTasks cursor (the status timestamp moves). */
	created: number;
	finished?: number;
	/** C4 / G10: this task's execution bound, fixed at submission from its kind and its tools. */
	timeoutMs: number;
	run: () => Promise<void>;
	bridge?: AgentBridgeClient;
	permission?: { id: string; params: Record<string, unknown>; expires: number };
	/** A11: at most {@linkcode MAX_PUSH_CONFIGS_PER_TASK}; persisted with the task and dropped with it. */
	push: PushConfig[];
	/** The run log, oldest first, bounded by {@linkcode RUN_LOG_MAX_ENTRIES} and {@linkcode RUN_LOG_MAX_BYTES}. */
	log: RunLogEntry[];
	/** The serialized size of `log`, kept so a bound check never re-serializes it. */
	logBytes: number;
}

/**
 * D-154: a synchronous AES-GCM sealer the gateway builds from `TTK_DB_KEY_FILE` (the task document is written
 * synchronously). `context` is authenticated: a sealed token copied to another task or config does not open.
 */
export interface SecretSealer {
	seal(plain: string, context: string): string;
	/** The plain text, or `null` when the value does not open under this key and context. */
	open(sealed: string, context: string): string | null;
}

/** B1: one task as `tasks.json` holds it — protocol data and its owner; never scopes or a credential fingerprint. */
interface StoredTask {
	owner: string;
	created: number;
	finished?: number;
	task: AgentTask;
	push?: PushConfig[];
	/** D-154: configs whose token could not be restored (withheld for want of a key, or not opening); dropped. */
	unrestorable?: number;
	/** The run log; absent on a task written before it existed. */
	log?: RunLogEntry[];
}

/** One push config as `tasks.json` holds it (D-154): the token sealed, or withheld — never plain text. */
interface StoredPush {
	id: string;
	url: string;
	sealed_token?: string;
	token_withheld?: true;
}

/** The authenticated context of a push token: its task and its config. */
function pushTokenContext(taskId: string, configId: string): string {
	return `a2a-push/${taskId}/${configId}`;
}

/** B1 / G5: `<TTK_DATA_DIR>/agents/tasks.json`. */
interface TasksDocument {
	version: 1;
	tasks: StoredTask[];
	/** E-3: `[owner\0messageId, taskId]`, so a client retry after a restart still finds its task. */
	idempotency: [string, string][];
}

const TASK_STATES = new Set([
	'TASK_STATE_SUBMITTED',
	'TASK_STATE_WORKING',
	'TASK_STATE_INPUT_REQUIRED',
	'TASK_STATE_AUTH_REQUIRED',
	'TASK_STATE_COMPLETED',
	'TASK_STATE_FAILED',
	'TASK_STATE_CANCELED',
	'TASK_STATE_REJECTED',
]);

/**
 * A stored task as written by this runtime, or `null`; a hand-edited or truncated entry is skipped, not trusted.
 * D-154: a sealed token is opened with `sealer`; a withheld one, or one that does not open, drops its config (counted
 * in `unrestorable`). A plain `token` from a document written before D-154 is read once and sealed on the next write.
 */
function storedTask(value: unknown, sealer: SecretSealer | undefined): StoredTask | null {
	try {
		const entry = object(value);
		const task = object(entry.task);
		const status = object(task.status);
		identifier(entry.owner);
		identifier(task.id);
		identifier(task.contextId);
		if (
			typeof entry.created !== 'number' || !Number.isFinite(entry.created) ||
			(entry.finished !== undefined && (typeof entry.finished !== 'number' || !Number.isFinite(entry.finished))) ||
			typeof status.state !== 'string' || !TASK_STATES.has(status.state) || typeof status.timestamp !== 'string' ||
			!Array.isArray(task.artifacts) || !Array.isArray(task.history)
		) return null;
		const push: PushConfig[] = [];
		let unrestorable = 0;
		for (const item of Array.isArray(entry.push) ? entry.push.slice(0, MAX_PUSH_CONFIGS_PER_TASK) : []) {
			const config = object(item);
			if (typeof config.url !== 'string') return null;
			const id = identifier(config.id);
			let token: string | undefined;
			if (typeof config.sealed_token === 'string') {
				token = sealer?.open(config.sealed_token, pushTokenContext(task.id as string, id)) ?? undefined;
				if (token === undefined) {
					unrestorable++;
					continue;
				}
			} else if (config.token_withheld === true) {
				unrestorable++;
				continue;
			} else if (typeof config.token === 'string') token = config.token;
			push.push({ id, url: config.url, ...(token === undefined ? {} : { token }) });
		}
		return {
			owner: entry.owner as string,
			created: entry.created,
			...(entry.finished === undefined ? {} : { finished: entry.finished as number }),
			task: task as AgentTask,
			push,
			...(unrestorable === 0 ? {} : { unrestorable }),
			log: storedLog(entry.log),
		};
	} catch {
		return null;
	}
}

/** Terminal invariants are shared by transports, UI and MCP extension tools. */
/** E-5: ACP session updates forwarded to task subscribers besides the agent's text. */
const FORWARDED_UPDATES = new Set(['tool_call', 'tool_call_update', 'plan', 'agent_thought_chunk']);

export function terminal(state: string): boolean {
	return ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(state);
}

/** Validate the advertised subset; file references are never fetched. */
export function agentMessage(value: unknown): AgentMessage {
	const message = object(value);
	identifier(message.messageId);
	if (
		message.role !== 'ROLE_USER' || !Array.isArray(message.parts) || !message.parts.length ||
		message.parts.length > 64 || message.kind !== undefined
	) {
		throw new AgentError(-32602, 'Expected an A2A 1.0 user message');
	}
	let textBytes = 0;
	for (const item of message.parts) {
		const part = object(item);
		if (part.kind !== undefined || ['text', 'data', 'raw', 'url'].filter((key) => key in part).length !== 1) {
			throw new AgentError(-32602, 'Invalid A2A part');
		}
		if (part.text !== undefined) {
			if (typeof part.text !== 'string') throw new AgentError(-32602, 'Invalid text part');
			textBytes += new TextEncoder().encode(part.text).length;
		} else if (part.data !== undefined) {
			const data = object(part.data);
			// E-5: a message to an existing task carries an answer ({optionId}); only a new task's data is a tool call.
			if (message.taskId === undefined) {
				identifier(data.tool);
				object(data.arguments ?? {});
			}
		} else throw new AgentError(-32005, 'Only text and structured tool data are supported');
	}
	if (textBytes > 64 * 1024 || new TextEncoder().encode(JSON.stringify(message)).length > 512 * 1024) {
		throw new AgentError(-32602, 'Message exceeds limit');
	}
	if (message.contextId !== undefined) identifier(message.contextId);
	if (message.taskId !== undefined) identifier(message.taskId);
	return structuredClone(message) as AgentMessage;
}

/**
 * AG-8: the delegated bearer tokens handed to a session, which agent output must never carry onwards. The threshold
 * is the loop redactor's {@linkcode REDACTION_MIN_LENGTH} (CR-8): one number for every secret the runtime redacts.
 */
function sensitive(delegation: AgentSessionMcp | undefined): string[] {
	const secrets: string[] = [];
	for (const server of delegation?.servers ?? []) {
		for (const header of Array.isArray(server.headers) ? server.headers : []) {
			const value = (header as Record<string, unknown> | null)?.value;
			if (typeof value !== 'string') continue;
			const token = value.startsWith('Bearer ') ? value.slice(7) : value;
			if (token.length >= REDACTION_MIN_LENGTH) secrets.push(token);
		}
	}
	return secrets;
}

/**
 * Owner-isolated, bounded execution shared by A2A, MCP and the SPA. In memory, and — with a `persistPath` — durable
 * across a restart (B1): finished tasks, their history, artifacts, push configurations and the idempotency keys
 * survive; work that was unfinished at shutdown comes back failed, and nothing is re-executed (G5), so a mutating
 * tool never runs twice.
 */
export class AgentRuntime {
	#tasks = new Map<string, TaskRecord>();
	/** E-3: `owner\0messageId` -> task id. Principal-local: one owner's message id never finds another's task. */
	#byMessage = new Map<string, string>();
	#queue: TaskRecord[] = [];
	#running = 0;
	/** R2-7: running tasks per owner, at most {@linkcode TASK_SLOTS_PER_OWNER} each. */
	#runningByOwner = new Map<string, number>();
	#closed = false;
	#reaper: ReturnType<typeof setInterval>;
	#peers = new Map<string, A2aPeerClient>();
	#executions = new Set<Promise<void>>();
	readonly #file: DurableJsonFile | undefined;
	readonly #push: PushDispatcher | undefined;
	/** B1: the document as it stood when close() began. */
	#final: TasksDocument | undefined;
	constructor(private readonly options: AgentRuntimeOptions) {
		for (const peer of options.peers ?? []) {
			if (this.#peers.has(peer.id)) throw new Error('Duplicate agent peer id');
			this.#peers.set(identifier(peer.id), new A2aPeerClient(peer));
		}
		this.#push = options.push === undefined ? undefined : new PushDispatcher({
			...options.push,
			...(options.push.logger === undefined && options.logger !== undefined ? { logger: options.logger } : {}),
		});
		this.#file = options.persistPath === undefined
			? undefined
			: new DurableJsonFile(options.persistPath, options.logger === undefined ? {} : { logger: options.logger });
		this.#restore();
		this.#reaper = setInterval(() => this.#reap(), 60_000);
		Deno.unrefTimer(this.#reaper as unknown as number);
	}
	/**
	 * Cards only advertise a natural-language skill when a text backend exists: an ACP bridge, or (D-143, §3.10) at
	 * least one model provider the process can reach. Drives `defaultInputModes` and `message/send` admission.
	 */
	get supportsText(): boolean {
		return this.options.bridge !== undefined || this.reachableProviders > 0;
	}
	/** Whether an ACP bridge is configured — the card's `external-agent` skill (§3.11) and the providers route's `acp`. */
	get hasBridge(): boolean {
		return this.options.bridge !== undefined;
	}
	/** D-143: how many configured providers the grant proof reached; the card's `builtin-model` skill needs one. */
	get reachableProviders(): number {
		const model = this.options.model;
		if (model === undefined) return 0;
		let count = 0;
		for (const id of model.providers.keys()) if (model.reachable(id)) count++;
		return count;
	}
	/**
	 * D-156: whether a built-in profile could take a text task here — a reachable provider (as for the card's
	 * `builtin-model` skill) and, for a profile that needs it, the coding sandbox. Drives the profile's card; a request
	 * is still judged by {@linkcode AgentRuntime.#textBackend} (a default provider, the caller's scopes).
	 */
	profileReady(id: string): boolean {
		const profile = AGENT_PROFILES.get(id);
		if (profile === undefined) return false;
		return (!profile.needsSandbox || this.options.codingSandbox === true) && this.reachableProviders > 0;
	}
	/** D-158: whether the grant proof reached provider `id` (the control plane's model choices). */
	providerReachable(id: string): boolean {
		return this.options.model?.reachable(id) === true;
	}
	/** D-158: one agent's settings as they stand now. */
	agentSetting(id: AgentId): AgentSetting {
		return (this.options.agents?.() ?? DEFAULT_AGENT_SETTINGS)[id];
	}
	/**
	 * D-158: whether the ACP bridge takes text tasks that name no provider — configured, and switched on — and, for a
	 * task from the A2A bindings, offered over A2A.
	 */
	routesToBridge(via?: 'a2a'): boolean {
		const setting = this.agentSetting('acp');
		return this.options.bridge !== undefined && setting.acp && (via !== 'a2a' || setting.a2a);
	}
	/** D-158: the configured A2A peers' ids, for the control plane's agent list. */
	get peerIds(): string[] {
		return [...this.#peers.keys()];
	}
	/** A11: push notifications exist only where the operator's policy was passed in (handoff N1). */
	get supportsPush(): boolean {
		return this.#push !== undefined && (this.options.push?.ready?.() ?? true);
	}

	get #queueDeadlineMs(): number {
		return this.options.queueDeadlineMs ?? TASK_QUEUE_DEADLINE_MS;
	}
	get #retentionMs(): number {
		return this.options.retentionMs ?? TASK_RETENTION_MS;
	}
	#reap(): void {
		const now = Date.now();
		let dropped = false;
		for (const [id, record] of this.#tasks) {
			if (record.finished && now - record.finished >= this.#retentionMs) {
				this.#tasks.delete(id);
				dropped = true;
			} else if (this.#expired(record, now)) this.#state(record, 'TASK_STATE_FAILED', QUEUE_EXPIRED);
		}
		for (const [key, id] of this.#byMessage) if (!this.#tasks.has(id)) this.#byMessage.delete(key);
		if (dropped) this.#changed();
	}

	/** B1: the state changed; the document follows within 250 ms. */
	#changed(): void {
		if (!this.#closed) this.#file?.schedule(() => this.#document());
	}

	/**
	 * B1: everything `tasks.json` holds. Scopes and credential fingerprints are deliberately not among it. Once
	 * closing, it is the state frozen at shutdown, so a write still queued then cannot record the shutdown's own
	 * cancellations.
	 */
	#document(): TasksDocument {
		if (this.#final !== undefined) return this.#final;
		const tasks: StoredTask[] = [...this.#tasks.values()].map((record) => ({
			owner: record.owner,
			created: record.created,
			...(record.finished === undefined ? {} : { finished: record.finished }),
			task: record.task,
			...(record.push.length ? { push: record.push.map((config) => this.#storedPush(record.task.id, config)) } : {}),
			...(record.log.length ? { log: record.log } : {}),
		}));
		const idempotency: [string, string][] = [...this.#byMessage].filter(([, id]) => this.#tasks.has(id));
		return { version: 1, tasks, idempotency };
	}

	/** D-154: a push config as the document holds it — its token sealed, or withheld without a sealer. */
	#storedPush(taskId: string, config: PushConfig): StoredPush {
		if (config.token === undefined) return { id: config.id, url: config.url };
		const sealer = this.options.sealer;
		return sealer === undefined ? { id: config.id, url: config.url, token_withheld: true } : {
			id: config.id,
			url: config.url,
			sealed_token: sealer.seal(config.token, pushTokenContext(taskId, config.id)),
		};
	}

	/**
	 * B1 / G5: loads `tasks.json`. A task that was submitted, working or waiting for a permission decision at
	 * shutdown is failed with {@linkcode INTERRUPTED_BY_RESTART}: its executor, its agent connection and its pending
	 * permission died with the process, and re-running it could repeat a mutation. Retention applies to what was
	 * loaded, and so do the capacity caps, so a hand-grown file cannot exceed what the runtime itself would hold.
	 */
	#restore(): void {
		const file = this.#file;
		if (file === undefined) return;
		const raw = file.read();
		if (raw === undefined) return;
		let document: Record<string, unknown>;
		try {
			document = object(raw);
			if (document.version !== 1 || !Array.isArray(document.tasks)) throw new Error('version');
		} catch {
			this.options.logger?.warn(`${file.path} is not a version 1 task document; starting empty`);
			return;
		}
		const now = Date.now();
		const stored = document.tasks.map((entry) => storedTask(entry, this.options.sealer));
		const skipped = stored.filter((entry) => entry === null).length;
		const perOwner = new Map<string, number>();
		const kept = (stored.filter((entry) => entry !== null) as StoredTask[])
			.filter((entry) => entry.finished === undefined || now - entry.finished < this.#retentionMs)
			.sort((a, b) => b.created - a.created)
			.filter((entry) => {
				const count = perOwner.get(entry.owner) ?? 0;
				perOwner.set(entry.owner, count + 1);
				return count < 32;
			})
			.slice(0, 256);
		const interrupted: TaskRecord[] = [];
		let dropped = 0;
		let unrestorable = 0;
		for (const entry of kept) {
			if (this.#tasks.has(entry.task.id)) continue;
			const push = this.#allowedPush(entry.push ?? []);
			dropped += (entry.push?.length ?? 0) - push.length + (entry.unrestorable ?? 0);
			unrestorable += entry.unrestorable ?? 0;
			const record: TaskRecord = {
				owner: entry.owner,
				// A restored task never runs again, so it holds no authority to re-check.
				scopes: new Set(),
				task: entry.task,
				controller: new AbortController(),
				listeners: new Set(),
				created: entry.created,
				...(entry.finished === undefined ? {} : { finished: entry.finished }),
				timeoutMs: 0,
				run: () => Promise.resolve(),
				push,
				log: entry.log ?? [],
				logBytes: (entry.log ?? []).reduce((sum, item) => sum + JSON.stringify(item).length, 0),
			};
			this.#tasks.set(entry.task.id, record);
			if (record.finished === undefined && !terminal(record.task.status.state)) interrupted.push(record);
		}
		if (Array.isArray(document.idempotency)) {
			for (const pair of document.idempotency) {
				if (
					Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' &&
					this.#tasks.get(pair[1])?.owner === pair[0].split('\u0000', 1)[0]
				) this.#byMessage.set(pair[0], pair[1]);
			}
		}
		// After the map is whole, so the restart's own status update reaches a push webhook like any other.
		for (const record of interrupted) this.#state(record, 'TASK_STATE_FAILED', INTERRUPTED_BY_RESTART);
		if (skipped > 0) this.options.logger?.warn(`${file.path}: ${skipped} malformed task entries were skipped`);
		if (unrestorable > 0) {
			this.options.logger?.warn(
				`${file.path}: ${unrestorable} push notification configs lost their token (no TTK_DB_KEY_FILE, or a different ` +
					'key) and were dropped',
			);
		}
		if (interrupted.length > 0 || skipped > 0 || dropped > 0 || kept.length !== document.tasks.length) {
			this.#changed();
		}
	}

	/**
	 * Review R2-4: a restored webhook is held to the operator's push policy as it is now. One whose host left
	 * `TTK_A2A_PUSH_ALLOWED_HOSTS` (or that no longer passes any other rule) is dropped with its token, before the
	 * restart's own status update could reach it, and logged by origin only. With push not offered at all nothing is
	 * ever delivered, and the configurations are kept as they are for a policy that offers it again.
	 */
	#allowedPush(configs: readonly PushConfig[]): PushConfig[] {
		const push = this.#push;
		if (push === undefined) return [...configs];
		return configs.filter((config) => {
			try {
				push.target(config.url);
				return true;
			} catch {
				this.options.logger?.warn(
					`a restored push notification config for ${pushOrigin(config.url)} is no longer allowed and was dropped`,
				);
				return false;
			}
		});
	}
	/** GW-1: still waiting for a slot past the deadline; the pump refuses it and the reaper marks it. */
	#expired(record: TaskRecord, now = Date.now()): boolean {
		return record.task.status.state === 'TASK_STATE_SUBMITTED' && now - record.created >= this.#queueDeadlineMs;
	}
	/**
	 * GW-1: the submitted scopes narrowed to what the submitting credential holds now, or `null` once it holds
	 * nothing — including when it lost `agent:invoke`, the task's own authority. A fault in the check fails closed.
	 */
	#rights(record: TaskRecord): ReadonlySet<string> | null {
		const authorize = this.options.authorize;
		if (authorize === undefined) return record.scopes;
		let current: ReadonlySet<string> | null;
		try {
			current = authorize(record.owner, record.scopes, record.credential);
		} catch {
			current = null;
		}
		if (current === null) return null;
		const held = current;
		const rights = new Set([...record.scopes].filter((scope) => held.has(scope)));
		return rights.has('agent:invoke') ? rights : null;
	}
	#authorized(record: TaskRecord): ReadonlySet<string> {
		const rights = this.#rights(record);
		if (rights === null) throw new AgentError(-32600, UNAUTHORIZED);
		return rights;
	}
	/**
	 * AG-1: finished tasks never hold capacity against new work. When a cap is reached the oldest finished tasks
	 * are evicted — the caller's own first, then anyone's — and only unfinished work can make #create refuse.
	 * Before this, 32 completed tasks refused a principal's 33rd for the full hour of retention.
	 */
	#makeRoom(owner: string): void {
		const oldestFinished = (records: TaskRecord[]): TaskRecord[] =>
			records.filter((record) => record.finished !== undefined).sort((a, b) =>
				a.finished! - b.finished! || a.created - b.created
			);
		const own = [...this.#tasks.values()].filter((record) => record.owner === owner);
		for (const record of oldestFinished(own).slice(0, Math.max(0, own.length - 31))) {
			this.#tasks.delete(record.task.id);
		}
		const excess = this.#tasks.size - 255;
		if (excess <= 0) return;
		const finished = oldestFinished([...this.#tasks.values()]);
		const order = [
			...finished.filter((record) => record.owner === owner),
			...finished.filter((r) => r.owner !== owner),
		];
		for (const record of order.slice(0, excess)) this.#tasks.delete(record.task.id);
	}
	#record(owner: string, id: string): TaskRecord {
		const record = this.#tasks.get(id);
		if (!record || record.owner !== owner) throw new AgentError(-32001, 'Task not found');
		return record;
	}
	#emit(record: TaskRecord, event: Record<string, unknown>): void {
		const copy = structuredClone(event);
		for (const listener of record.listeners) listener.push(copy);
	}
	/** Appends to the task's run log within its bounds; the entry that would cross one becomes `truncated`, once. */
	#log(record: TaskRecord, kind: RunLogKind, facts: Record<string, unknown> = {}): void {
		if (record.log.at(-1)?.kind === 'truncated') return;
		const entry: RunLogEntry = { at: new Date().toISOString(), kind, ...facts };
		const bytes = JSON.stringify(entry).length;
		if (record.log.length >= RUN_LOG_MAX_ENTRIES - 1 || record.logBytes + bytes > RUN_LOG_MAX_BYTES) {
			record.log.push({ at: entry.at, kind: 'truncated' });
		} else {
			record.log.push(entry);
			record.logBytes += bytes;
		}
		this.#changed();
	}
	#state(record: TaskRecord, state: string, text?: string): void {
		if (terminal(record.task.status.state)) return;
		record.task.status = {
			state,
			timestamp: new Date().toISOString(),
			...(text
				? {
					message: {
						messageId: crypto.randomUUID(),
						role: 'ROLE_AGENT',
						taskId: record.task.id,
						contextId: record.task.contextId,
						parts: [{ text }],
					} as AgentMessage,
				}
				: {}),
		};
		const update = {
			statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status: record.task.status },
		};
		this.#log(record, 'state', { state, ...(text ? { text: logText(text) } : {}) });
		this.#emit(record, update);
		// A11: a webhook hears every state change, never at shutdown (the restart reports it instead, see #restore).
		if (!this.#closed) this.#push?.deliver(record.task.id, record.push, structuredClone(update));
		if (terminal(state)) {
			record.finished = Date.now();
			record.permission = undefined;
			for (const listener of record.listeners) listener.close();
			record.listeners.clear();
		}
		this.#changed();
	}
	#artifact(record: TaskRecord, parts: Record<string, unknown>[], name = 'result'): void {
		if (terminal(record.task.status.state)) return;
		const artifact = { artifactId: crypto.randomUUID(), name, parts };
		const bytes = new TextEncoder().encode(JSON.stringify([...record.task.artifacts, artifact])).length;
		if (bytes > 1024 * 1024) throw new AgentError(-32603, 'Agent output exceeds artifact budget');
		record.task.artifacts.push(artifact);
		this.#log(record, 'artifact', { name, parts: parts.length, bytes: JSON.stringify(parts).length });
		this.#emit(record, {
			artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId, artifact, lastChunk: true },
		});
		this.#changed();
	}
	/**
	 * Starts queued tasks while a slot is free: the oldest a slot may go to — one whose owner runs fewer than
	 * {@linkcode TASK_SLOTS_PER_OWNER} (R2-7), or one that will not run at all (finished, expired) and only leaves the
	 * queue. An owner at its share keeps its place; another owner's later task goes first.
	 */
	#pump(): void {
		while (!this.#closed && this.#running < TASK_SLOTS) {
			const at = this.#queue.findIndex((queued) =>
				terminal(queued.task.status.state) || this.#expired(queued) ||
				(this.#runningByOwner.get(queued.owner) ?? 0) < TASK_SLOTS_PER_OWNER
			);
			if (at < 0) return;
			const record = this.#queue.splice(at, 1)[0]!;
			if (terminal(record.task.status.state)) continue;
			// GW-1: a queued task starts only inside its deadline, and only while its own credential still
			// authorizes it — never on the scopes it was submitted with after the key was removed or rotated.
			if (this.#expired(record)) {
				this.#state(record, 'TASK_STATE_FAILED', QUEUE_EXPIRED);
				continue;
			}
			if (this.#rights(record) === null) {
				this.#state(record, 'TASK_STATE_FAILED', UNAUTHORIZED);
				continue;
			}
			this.#running++;
			this.#runningByOwner.set(record.owner, (this.#runningByOwner.get(record.owner) ?? 0) + 1);
			this.#state(record, 'TASK_STATE_WORKING');
			// C4 / G10: the bound fixed at submission — the tools' own for a tool task, `TTK_AGENT_TASK_TIMEOUT_S`
			// for text and delegation. A flat 120 s cut a 15-minute `sandbox_exec` submitted as a task at 2 minutes.
			const timer = setTimeout(() => {
				this.#state(record, 'TASK_STATE_FAILED', 'Task execution timed out');
				record.controller.abort();
			}, record.timeoutMs);
			const execution = record.run().then(() => this.#state(record, 'TASK_STATE_COMPLETED')).catch((error) => {
				if (error instanceof AgentError && error.code === AUTH_REQUIRED) {
					this.#interrupt(record, 'TASK_STATE_AUTH_REQUIRED', error.message);
					return;
				}
				this.#state(
					record,
					record.controller.signal.aborted ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
					error instanceof AgentError ? error.message : 'Agent execution failed',
				);
			}).finally(() => {
				clearTimeout(timer);
				this.#running--;
				const owned = (this.#runningByOwner.get(record.owner) ?? 1) - 1;
				if (owned > 0) this.#runningByOwner.set(record.owner, owned);
				else this.#runningByOwner.delete(record.owner);
				this.#pump();
			});
			this.#executions.add(execution);
			void execution.finally(() => this.#executions.delete(execution));
		}
	}
	/**
	 * E-5: a message to an existing task. A task waiting on a permission decision takes the decision in the message:
	 * a data part `{ optionId }` choosing one of the offered once-only options, or `{ optionId: null }` to decline,
	 * and the message joins its history. Anything else is refused: a terminal task takes no messages, and a task
	 * that is not waiting has nothing to be told.
	 */
	#followUp(owner: string, key: string, message: AgentMessage): AgentTask {
		const prior = this.#record(owner, message.taskId!);
		if (message.contextId !== undefined && message.contextId !== prior.task.contextId) {
			throw new AgentError(-32602, 'Message task/context identifiers do not match');
		}
		if (terminal(prior.task.status.state)) throw new AgentError(-32004, 'Terminal task cannot accept messages');
		const permission = prior.permission;
		if (prior.task.status.state !== 'TASK_STATE_INPUT_REQUIRED' || !permission || permission.expires < Date.now()) {
			throw new AgentError(-32004, 'This task is not waiting for input');
		}
		const decision = message.parts.map((part) => part.data).find((data) => data !== undefined);
		const chosen = decision === undefined ? undefined : object(decision).optionId;
		if (chosen !== null && typeof chosen !== 'string') {
			throw new AgentError(-32602, 'Answer a permission request with a data part {optionId}');
		}
		const options = Array.isArray(permission.params.options) ? permission.params.options.map(object) : [];
		if (
			chosen !== null &&
			!options.some((option) =>
				option.optionId === chosen && ['allow_once', 'reject_once'].includes(String(option.kind))
			)
		) throw new AgentError(-32602, 'Permission option not allowed');
		message.contextId = prior.task.contextId;
		this.#remember(prior, message);
		this.#byMessage.set(key, prior.task.id);
		void this.decidePermission(owner, prior.task.id, permission.id, chosen ?? undefined).catch(() => {});
		return structuredClone(prior.task);
	}

	/** E-5: the task's conversation, newest last, at most 100 messages. */
	#remember(record: TaskRecord, message: AgentMessage): void {
		record.task.history.push(structuredClone(message));
		if (record.task.history.length > 100) record.task.history.splice(0, record.task.history.length - 100);
		this.#changed();
	}

	/**
	 * E-2: an interrupted state this runtime cannot resume (`TASK_STATE_AUTH_REQUIRED`: the agent needs credentials
	 * no client of this gateway can supply). Reported like any update, then held as finished so it is reaped and
	 * evicted like a terminal task; it can still be cancelled.
	 */
	#interrupt(record: TaskRecord, state: string, text: string): void {
		this.#state(record, state, text);
		record.finished = Date.now();
		for (const listener of record.listeners) listener.close();
		record.listeners.clear();
	}

	#create(
		owner: string,
		scopes: ReadonlySet<string>,
		credential: string | undefined,
		message: AgentMessage,
		timeoutMs: number,
		metadata: AgentTaskMetadata,
		execute: (record: TaskRecord) => Promise<void>,
		push?: unknown,
		via?: 'a2a',
	): AgentTask {
		if (this.#closed) throw new AgentError(-32603, 'Agent runtime closed');
		if (!scopes.has('agent:invoke')) throw new AgentError(-32600, 'agent:invoke scope required');
		// A11: a webhook named with the message is validated before anything is created, so a refused URL creates no
		// task; it is attached only to a new task, never re-attached by a retry of the same message.
		const webhook = push === undefined ? undefined : this.#webhook(push);
		// E-3: a message this owner already sent (a client retry) answers with the task it started, and runs nothing.
		const key = `${owner}\u0000${message.messageId}`;
		const seen = this.#byMessage.get(key);
		if (seen !== undefined) {
			const prior = this.#tasks.get(seen);
			if (prior !== undefined && prior.owner === owner) return structuredClone(prior.task);
			this.#byMessage.delete(key);
		}
		if (message.taskId) return this.#followUp(owner, key, message);
		this.#reap();
		this.#makeRoom(owner);
		if (this.#tasks.size >= 256 || [...this.#tasks.values()].filter((record) => record.owner === owner).length >= 32) {
			throw new AgentError(-32603, 'Task capacity reached');
		}
		// Reuse only the caller's context. Client-chosen context ids never bind another owner.
		if (
			message.contextId &&
			![...this.#tasks.values()].some((record) => record.owner === owner && record.task.contextId === message.contextId)
		) throw new AgentError(-32001, 'Context not found');
		const id = crypto.randomUUID();
		const contextId = message.contextId ?? crypto.randomUUID();
		message.taskId = id;
		message.contextId = contextId;
		const task: AgentTask = {
			id,
			contextId,
			status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
			artifacts: [],
			history: [message],
			// D-143 (addendum A): the kind and chosen backend from the first snapshot on; persisted whole by #document.
			metadata: { ...metadata },
		};
		const record: TaskRecord = {
			owner,
			scopes: new Set(scopes),
			...(credential === undefined ? {} : { credential }),
			task,
			controller: new AbortController(),
			listeners: new Set(),
			created: Date.now(),
			timeoutMs,
			run: () => execute(record),
			push: webhook === undefined ? [] : [webhook],
			log: [],
			logBytes: 0,
		};
		this.#tasks.set(id, record);
		// Where the request came in and what will run it; the request itself is the task's history.
		const { kind: taskKind, ...backend } = metadata;
		this.#log(record, 'received', {
			task_kind: taskKind,
			...backend,
			...(via === undefined ? {} : { via }),
			parts: message.parts.length,
		});
		this.#byMessage.set(key, id);
		try {
			this.options.onTaskCreated?.(id);
		} catch {
			this.options.logger?.warn('a task-creation listener failed; the task was created');
		}
		this.#queue.push(record);
		queueMicrotask(() => this.#pump());
		this.#changed();
		return structuredClone(task);
	}

	/**
	 * D-143, §3.10: which backend a text task runs on — the one routing table, read before any task is created so a
	 * refused request leaves nothing behind. "Selection" is a `provider` in the request; "bridge" the configured ACP
	 * backend; "default" the providers file's default; "scope" is `model:invoke` on the submitting scopes.
	 *
	 * | selection | bridge | default | scope | result |
	 * | `model` only | any | any | any | `-32602 model requires provider` (CR-1 / BUG-6) — judged before every other row |
	 * | given | any | any | yes | the selected provider; unknown → `-32602`; unreachable → `-32004` (not reachable) |
	 * | given | any | any | no | `-32600 model:invoke scope required` (the caller already named a provider) |
	 * | none | yes | any | any | ACP — a default provider never overrides a configured bridge |
	 * | none | no | yes | yes | the default provider and its default model; unreachable → `-32004` (not reachable) |
	 * | none | no | yes | no | `-32004` {@linkcode NO_TEXT_BACKEND} — nothing about providers to a scopeless caller |
	 * | none | no | no | any | `-32004` {@linkcode NO_TEXT_BACKEND} |
	 *
	 * With no `model` option at all (the S0 state) — or, D-153, one whose map is empty — a selection falls to the same
	 * `-32004`: there is no provider to be unknown or unreachable, and the text names both backends the deployment
	 * could add.
	 *
	 * D-156: a built-in `profile` (SlopLord) runs only on the built-in model loop, so the table loses its bridge row —
	 * a configured ACP agent never takes a profile's task — and every `-32004` that would name
	 * {@linkcode NO_TEXT_BACKEND} names the profile's own `unavailable` text instead (an ACP agent would not help it).
	 * A profile that needs the coding sandbox is refused with that text where none is composed, before any provider
	 * row. After the provider is resolved, the profile's own grants: `mcp:invoke` (it acts only through tools) and, for
	 * the sandbox, `sandbox:execute` — `-32600` with the fixed texts, so a caller who could never use it learns so at
	 * submit rather than from a model that has no tools.
	 */
	#textBackend(
		scopes: ReadonlySet<string>,
		selection: ModelSelection | undefined,
		profile?: AgentProfile,
		via?: 'a2a',
	): 'acp' | { provider: string; model: string } {
		// CR-1 / BUG-6: a model names nothing to run it on without a provider — refused the same way whether a bridge
		// would otherwise take the task (and silently drop the model) or the default provider would run it.
		if (selection?.model !== undefined && selection.provider === undefined) {
			throw new AgentError(-32602, MODEL_REQUIRES_PROVIDER);
		}
		if (profile === undefined) {
			const backend = this.#modelBackend(scopes, selection, NO_TEXT_BACKEND, via, 'builtin');
			// D-158: a task from the A2A bindings runs on the built-in agent only while it is offered over A2A.
			if (backend !== 'acp' && via === 'a2a' && !this.agentSetting('builtin').a2a) {
				throw new AgentError(-32004, NOT_OFFERED_OVER_A2A);
			}
			return backend;
		}
		if (via === 'a2a' && !this.agentSetting(profile.id).a2a) {
			throw new AgentError(-32004, `${profile.name} is not offered over A2A`);
		}
		if (profile.needsSandbox && this.options.codingSandbox !== true) {
			throw new AgentError(-32004, profile.unavailable);
		}
		const backend = this.#modelBackend(scopes, selection, profile.unavailable, undefined, profile.id);
		if (!scopes.has('mcp:invoke')) throw new AgentError(-32600, MCP_INVOKE_SCOPE_REQUIRED);
		if (profile.needsSandbox && !scopes.has('sandbox:execute')) {
			throw new AgentError(-32600, SANDBOX_EXECUTE_SCOPE_REQUIRED);
		}
		return backend as { provider: string; model: string };
	}

	/**
	 * The §3.10 table below the CR-1 row: `unavailable` is the `-32004` text; `agent` the agent whose settings apply
	 * (D-158): for the plain built-in agent the ACP row applies while the bridge takes text tasks
	 * ({@linkcode AgentRuntime.routesToBridge}, `via` the entrance), and with no selection the agent's own default
	 * model, when set and still listed by a provider in force, is used before the providers' default.
	 */
	#modelBackend(
		scopes: ReadonlySet<string>,
		selection: ModelSelection | undefined,
		unavailable: string,
		via: 'a2a' | undefined,
		agent: AgentId,
	): 'acp' | { provider: string; model: string } {
		const model = this.options.model;
		const resolve = (client: ModelProviderClient, name: string | undefined): { provider: string; model: string } => {
			const chosen = name ?? client.defaultModel;
			if (!client.models.includes(chosen)) throw new AgentError(-32602, 'Unknown model for provider');
			if (!model!.reachable(client.id)) {
				throw new AgentError(-32004, 'Model provider is not reachable: no outbound net grant');
			}
			return { provider: client.id, model: chosen };
		};
		if (selection?.provider !== undefined) {
			if (!scopes.has('model:invoke')) throw new AgentError(-32600, MODEL_INVOKE_SCOPE_REQUIRED);
			// D-153: an empty map is "no providers", answered as a runtime composed without one.
			if (model === undefined || model.providers.size === 0) throw new AgentError(-32004, unavailable);
			const client = model.providers.get(selection.provider);
			if (client === undefined) throw new AgentError(-32602, 'Unknown model provider');
			return resolve(client, selection.model);
		}
		if (agent === 'builtin' && this.routesToBridge(via)) return 'acp';
		// D-158: the agent's own default model. A choice whose provider or model is no longer in force falls back to the
		// providers' default rather than refusing every task (the control plane shows it as stale).
		const chosen = this.agentSetting(agent).model;
		const own = chosen === null ? undefined : model?.providers.get(chosen.provider);
		if (own !== undefined && own.models.includes(chosen!.model)) {
			if (!scopes.has('model:invoke')) throw new AgentError(-32004, unavailable);
			return resolve(own, chosen!.model);
		}
		if (model === undefined || model.default === null || !scopes.has('model:invoke')) {
			throw new AgentError(-32004, unavailable);
		}
		const client = model.providers.get(model.default);
		if (client === undefined) throw new AgentError(-32004, unavailable);
		return resolve(client, selection?.model);
	}

	/**
	 * Submit a typed tool request or a text prompt for the configured text backend (an ACP agent, or — D-143 — a model
	 * provider chosen by `options.model` or the file's default, see {@linkcode AgentRuntime.#textBackend}).
	 * `credential` is the gateway's fingerprint of the credential behind `owner` (GW-1); it is handed back to
	 * {@linkcode AgentRuntimeOptions.authorize} only. `options.push` is a webhook configuration to attach to the new
	 * task (A11, `-32003` when push is not offered). `options.agent` (D-156) names a built-in profile (`profiles.ts`):
	 * the task runs on the built-in model loop with that profile's constant system prompt and tool allowlist, and
	 * carries `metadata.agent`; a profile takes text only (`-32005` for a data part).
	 */
	submit(
		owner: string,
		scopes: ReadonlySet<string>,
		value: unknown,
		credential?: string,
		options: { push?: unknown; model?: ModelSelection; agent?: string; via?: 'a2a' } = {},
	): AgentTask {
		const profile = options.agent === undefined ? undefined : agentProfile(options.agent);
		const message = agentMessage(value);
		const text = !message.parts.some((part) => part.data !== undefined);
		// D-156: a profile is a text agent. A data part (a tool call, or a permission answer no model task ever asks for)
		// is refused rather than run as a structured task the profile's name would then wrongly label.
		if (profile !== undefined && !text) throw new AgentError(-32005, `${profile.name} accepts text messages only`);
		// §3.10: judged before anything exists, so a refused text task creates nothing and names nothing it should not.
		const backend = text ? this.#textBackend(scopes, options.model, profile, options.via) : undefined;
		// C4 / G10: a tool task may take as long as its tools, called one after another; a text task is bounded by
		// the operator's `TTK_AGENT_TASK_TIMEOUT_S`. (A follow-up's data part is an answer, not a tool call, and a
		// follow-up never creates a task.)
		const tools = message.taskId === undefined ? message.parts.filter((part) => part.data !== undefined) : [];
		const timeoutMs = tools.length
			? tools.reduce((sum, part) => {
				const data = object(part.data);
				return sum + toolTaskBoundMs(String(data.tool), object(data.arguments ?? {}));
			}, 0)
			: this.options.taskTimeoutMs ?? TEXT_TASK_TIMEOUT_MS;
		// D-143 (addendum A): the kind where the timeout is derived; `provider`/`model` are the resolved ids.
		const metadata: AgentTaskMetadata = backend === undefined
			? { kind: 'tool' }
			: backend === 'acp'
			? { kind: 'text', backend: 'acp' }
			: {
				kind: 'text',
				backend: 'model',
				provider: backend.provider,
				model: backend.model,
				...(profile === undefined ? {} : { agent: profile.id }),
			};
		return this.#create(
			owner,
			scopes,
			credential,
			message,
			timeoutMs,
			metadata,
			async (record) => {
				const dataParts = message.parts.filter((part) => part.data !== undefined);
				if (dataParts.length) {
					for (const part of dataParts) {
						record.controller.signal.throwIfAborted();
						// GW-1: every invocation re-reads the credential's CURRENT scopes. A key narrowed or revoked
						// while this task waited or ran never lends the task its submit-time authority.
						const rights = this.#authorized(record);
						if (!rights.has('mcp:invoke')) throw new AgentError(-32600, MCP_INVOKE_SCOPE_REQUIRED);
						const data = object(part.data);
						const started = performance.now();
						this.#log(record, 'tool_call', { name: String(data.tool), arguments: logValue(data.arguments ?? {}) });
						const result = await this.options.invoke(
							identifier(data.tool),
							object(data.arguments ?? {}),
							owner,
							rights,
							record.controller.signal,
						);
						this.#log(record, 'tool_result', {
							name: String(data.tool),
							isError: result.isError === true,
							duration_ms: Math.round(performance.now() - started),
							text: logText(toolText(result)),
						});
						this.#artifact(record, [{ data: result }]);
						if (result.isError === true) throw new AgentError(-32603, 'Tool execution returned an error');
					}
				} else if (backend === 'acp') await this.#prompt(record, message);
				else await this.#model(record, message, backend!, profile);
			},
			options.push,
			options.via,
		);
	}

	/** An agent text part: appended to the response and emitted to subscribers as the ACP path emits chunks. */
	#say(record: TaskRecord, text: string): void {
		this.#emit(record, {
			statusUpdate: {
				taskId: record.task.id,
				contextId: record.task.contextId,
				status: {
					state: record.task.status.state,
					timestamp: new Date().toISOString(),
					message: {
						messageId: crypto.randomUUID(),
						role: 'ROLE_AGENT',
						contextId: record.task.contextId,
						taskId: record.task.id,
						parts: [{ text }],
					},
				},
			},
		});
	}

	/**
	 * D-143 W2 (backend §2.3): runs a text task on the provider the table chose, through `runModelTask`. The loop
	 * re-checks the credential (GW-1) before every provider call and tool call, carries the task's signal into both,
	 * and reports steps and usage into `task.metadata` as it goes. Ending: `end` → completed by the pump; `refusal` →
	 * `TASK_STATE_REJECTED`; a bound → failed with the loop's fixed text; abort → cancelled by the pump. The final text
	 * becomes the `agent-response` artifact and joins the history, as the ACP path does — every string already
	 * redacted of the provider key by the client's own redactor.
	 */
	async #model(
		record: TaskRecord,
		message: AgentMessage,
		backend: { provider: string; model: string },
		profile?: AgentProfile,
	): Promise<void> {
		// D-152 / D-153: the gateway may replace the provider map live (an administrator changed the set). A task
		// that waited in the queue across such a change is judged again here, against the set in force when it starts:
		// a provider removed (or its model dropped, or its host no longer proven) is never dialled, because the set in
		// force is the only allowlist for model hosts. Once started, the task keeps this client for its whole run.
		const model = this.options.model!;
		const client = model.providers.get(backend.provider);
		if (client === undefined || !client.models.includes(backend.model)) {
			throw new AgentError(-32004, 'Model provider is no longer configured');
		}
		if (!model.reachable(client.id)) {
			throw new AgentError(-32004, 'Model provider is not reachable: no outbound net grant');
		}
		// D-158: the agent's settings as the task starts — its memory and A2UI switches narrow its tool list; SlopLord's
		// A2UI switch adds the `a2ui_*` tools to its allowlist (still intersected with the caller's rights by the loop).
		const setting = this.agentSetting(profile?.id ?? 'builtin');
		const allowed = (rights: ReadonlySet<string>): ModelTool[] =>
			model.tools(rights).filter((tool) => settingAllows(setting, tool.name));
		const effective = profile === undefined ? undefined : {
			...profile,
			tools: new Set([
				...[...profile.tools].filter((name) => settingAllows(setting, name)),
				...(setting.a2ui ? model.tools(this.#authorized(record)).map((tool) => tool.name).filter(isA2uiTool) : []),
			]),
		};
		const parts: Record<string, unknown>[] = [];
		let bytes = 0;
		const outcome = await runModelTask({
			client,
			model: backend.model,
			prompt: message.parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n'),
			owner: record.owner,
			signal: record.controller.signal,
			authorized: () => this.#authorized(record),
			tools: allowed,
			// D-156: the loop narrows `tools` to the profile's allowlist and uses its constant system prompt.
			...(effective === undefined ? {} : { profile: effective }),
			invoke: this.options.invoke,
			emitText: (text): void => {
				bytes += new TextEncoder().encode(text).length;
				if (bytes > 1024 * 1024 || parts.length >= 4096) throw new AgentError(-32603, 'Agent output exceeds limit');
				parts.push({ text });
				this.#say(record, text);
			},
			emitData: (event: ModelEvent): void => {
				if (terminal(record.task.status.state)) return;
				this.#log(record, event.kind, {
					step: event.step,
					name: event.name,
					isError: event.isError,
					...(event.arguments === undefined ? {} : { arguments: logValue(event.arguments) }),
					...(event.text === undefined ? {} : { text: logText(event.text) }),
				});
				this.#emit(record, {
					statusUpdate: {
						taskId: record.task.id,
						contextId: record.task.contextId,
						status: {
							state: record.task.status.state,
							timestamp: new Date().toISOString(),
							message: {
								messageId: crypto.randomUUID(),
								role: 'ROLE_AGENT',
								contextId: record.task.contextId,
								taskId: record.task.id,
								parts: [{ data: { model: event } }],
							},
						},
					},
				});
			},
			progress: (steps, usage): void => {
				record.task.metadata = { ...record.task.metadata!, steps, usage };
				this.#changed();
			},
			request: (request): void => this.#log(record, 'model_request', { provider: backend.provider, ...request }),
		});
		if (parts.length) {
			this.#artifact(record, parts, 'agent-response');
			this.#remember(record, {
				messageId: crypto.randomUUID(),
				role: 'ROLE_AGENT',
				contextId: record.task.contextId,
				taskId: record.task.id,
				parts: [{ text: parts.map((part) => String(part.text ?? '')).join('').slice(0, 65_536) }],
			});
		}
		if (outcome === 'refusal') this.#state(record, 'TASK_STATE_REJECTED');
	}

	async #prompt(record: TaskRecord, message: AgentMessage): Promise<void> {
		const bridge = new AgentBridgeClient(this.options.bridge!, record.owner);
		record.bridge = bridge;
		const streamController = new AbortController();
		let session: string | undefined;
		let bytes = 0;
		const parts: Record<string, unknown>[] = [];
		let resolveDrained: () => void = (): void => {};
		const drained = new Promise<void>((resolve) => resolveDrained = resolve);
		const abort = (): void => {
			if (session) void bridge.request('session/cancel', { sessionId: session }).catch(() => {});
			void bridge.close().catch(() => {});
		};
		record.controller.signal.addEventListener('abort', abort, { once: true });
		let updates: Promise<void> | undefined;
		let delegation: AgentSessionMcp | undefined;
		let promptDrained = false;
		// AG-8: the runner redacts a delegation token within one agent line, but a token split across
		// agent_message_chunk updates is only whole once joined, which happens here. So the joined text is
		// redacted, and the tail that could still be the start of a split token is held back until the next
		// chunk or the end of the prompt.
		let secrets: string[] = [];
		let held = '';
		const visible = (final: boolean): string => {
			let text = held;
			for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
			const keep = final ? 0 : Math.max(0, ...secrets.map((secret) => secret.length - 1));
			const cut = Math.max(0, text.length - keep);
			held = text.slice(cut);
			return text.slice(0, cut);
		};
		const output = (text: string): void => {
			if (!text) return;
			parts.push({ text });
			this.#emit(record, {
				statusUpdate: {
					taskId: record.task.id,
					contextId: record.task.contextId,
					status: {
						state: record.task.status.state,
						timestamp: new Date().toISOString(),
						message: {
							messageId: crypto.randomUUID(),
							role: 'ROLE_AGENT',
							contextId: record.task.contextId,
							taskId: record.task.id,
							parts: [{ text }],
						},
					},
				},
			});
		};
		try {
			// GW-1: the delegation is asked for with this task's own credential and current scopes, so a rotated
			// key's replacement can never back a task submitted before the rotation.
			delegation = await this.options.sessionMcp?.(record.owner, this.#authorized(record), record.credential);
			secrets = sensitive(delegation);
			record.controller.signal.throwIfAborted();
			await bridge.open();
			updates = (async (): Promise<void> => {
				for await (const event of bridge.events(streamController.signal)) {
					if (event.method === 'bridge/prompt_complete') {
						promptDrained = true;
						resolveDrained();
						continue;
					}
					if (terminal(record.task.status.state)) continue;
					if (event.method === 'session/request_permission') {
						const params = object(event.params);
						if (record.permission) {
							await bridge.permission(identifier(event.id), { outcome: { outcome: 'cancelled' } });
							continue;
						}
						record.permission = { id: identifier(event.id), params, expires: Date.now() + 60_000 };
						this.#state(record, 'TASK_STATE_INPUT_REQUIRED', 'Agent requests a permission decision');
					} else if (event.method === 'permission/expired') {
						if (record.permission?.id === String(object(event.params).id)) {
							record.permission = undefined;
							this.#state(record, 'TASK_STATE_WORKING');
						}
					} else if (event.method === 'session/update') {
						const update = object(object(event.params).update);
						if (FORWARDED_UPDATES.has(String(update.sessionUpdate))) {
							// E-5: tool calls, plans and thoughts reach task subscribers too, redacted like text and bounded.
							let json = JSON.stringify(update);
							for (const secret of secrets) json = json.split(secret).join('[REDACTED]');
							if (json.length <= 16_384) {
								const forwarded = JSON.parse(json) as Record<string, unknown>;
								this.#log(record, 'acp', {
									update: String(update.sessionUpdate),
									...(typeof forwarded.title === 'string' ? { title: logText(forwarded.title) } : {}),
									...(typeof forwarded.status === 'string' ? { status: forwarded.status } : {}),
									detail: logValue(forwarded),
								});
								this.#emit(record, {
									statusUpdate: {
										taskId: record.task.id,
										contextId: record.task.contextId,
										status: {
											state: record.task.status.state,
											timestamp: new Date().toISOString(),
											message: {
												messageId: crypto.randomUUID(),
												role: 'ROLE_AGENT',
												contextId: record.task.contextId,
												taskId: record.task.id,
												parts: [{ data: { acp: JSON.parse(json) } }],
											},
										},
									},
								});
							}
						} else if (update.sessionUpdate === 'agent_message_chunk') {
							const content = object(update.content);
							if (content.type === 'text' && typeof content.text === 'string') {
								bytes += new TextEncoder().encode(content.text).length;
								if (bytes > 1024 * 1024 || parts.length >= 4096) {
									throw new AgentError(-32603, 'Agent output exceeds limit');
								}
								held += content.text;
								output(visible(false));
							}
						}
					}
				}
				if (!streamController.signal.aborted && !promptDrained) {
					throw new AgentError(-32603, 'Agent stream closed before prompt completion');
				}
			})().catch((error) => {
				resolveDrained();
				if (!streamController.signal.aborted) {
					this.#state(
						record,
						'TASK_STATE_FAILED',
						error instanceof AgentError ? error.message : 'Agent update stream failed',
					);
					abort();
				}
			}).finally(resolveDrained);
			const init = await bridge.request('initialize', {
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: 'tykotech-mcp', version: '0.2.0' },
			}, record.controller.signal);
			// E-2: the agent says how it can be authenticated; the operator chose one (TTK_AGENT_AUTH_METHOD). The
			// credentials themselves live with the agent in the runner, never in a request from here.
			const methods = (Array.isArray(init.authMethods) ? init.authMethods : []).map(object).filter((method) =>
				typeof method.id === 'string'
			);
			const chosen = this.options.bridge!.authMethod;
			if (chosen !== undefined && methods.some((method) => method.id === chosen)) {
				await bridge.request('authenticate', { methodId: chosen }, record.controller.signal);
			}
			try {
				session = identifier(
					(await bridge.request(
						'session/new',
						{ cwd: bridge.cwd, mcpServers: delegation?.servers ?? [] },
						record.controller.signal,
					)).sessionId,
				);
			} catch (error) {
				if (error instanceof AgentError && error.code === AUTH_REQUIRED) {
					const names = methods.map((method) => String(method.name ?? method.id)).slice(0, 8).join(', ');
					throw new AgentError(
						AUTH_REQUIRED,
						names === ''
							? 'The agent requires authentication; configure TTK_AGENT_AUTH_METHOD for the runner'
							: `The agent requires authentication (${names}); configure TTK_AGENT_AUTH_METHOD for the runner`,
					);
				}
				throw error;
			}
			const result = await bridge.request('session/prompt', {
				sessionId: session,
				prompt: message.parts.map((part) => ({ type: 'text', text: part.text })),
			}, record.controller.signal);
			await drained;
			output(visible(true));
			if (result.stopReason === 'cancelled') this.#state(record, 'TASK_STATE_CANCELED');
			else if (result.stopReason === 'refusal') this.#state(record, 'TASK_STATE_REJECTED');
			else if (result.stopReason !== 'end_turn') {
				throw new AgentError(-32603, 'Agent stopped before completing the task');
			}
			if (parts.length) {
				this.#artifact(record, parts, 'agent-response');
				// E-5: the agent's turn joins the task's history, so a reader sees the exchange, not only the request.
				const text = parts.map((part) => String(part.text ?? '')).join('').slice(0, 65_536);
				this.#remember(record, {
					messageId: crypto.randomUUID(),
					role: 'ROLE_AGENT',
					contextId: record.task.contextId,
					taskId: record.task.id,
					parts: [{ text }],
				});
			}
		} finally {
			record.controller.signal.removeEventListener('abort', abort);
			streamController.abort();
			await bridge.close().catch(() => {});
			await updates;
			record.bridge = undefined;
			delegation?.close();
		}
	}

	/** Snapshot lookup conceals wrong-owner identifiers as not found. */
	get(owner: string, id: string, historyLength = 100): AgentTask {
		if (!Number.isInteger(historyLength) || historyLength < 0) throw new AgentError(-32602, 'Invalid historyLength');
		const task = structuredClone(this.#record(owner, id).task);
		task.history = historyLength === 0 ? [] : task.history.slice(-Math.min(historyLength, 100));
		return task;
	}
	/**
	 * The task's run log: its creation and finish times and what happened inside the run, oldest first. Owner-only,
	 * like every read; another owner's id is not found.
	 */
	runLog(owner: string, id: string): RunLog {
		const record = this.#record(owner, id);
		return {
			created_at: new Date(record.created).toISOString(),
			...(record.finished === undefined ? {} : { finished_at: new Date(record.finished).toISOString() }),
			entries: structuredClone(record.log),
			truncated: record.log.at(-1)?.kind === 'truncated',
		};
	}
	/** Most recent status first; only the authenticated principal's tasks exist here. */
	list(owner: string): AgentTask[] {
		return [...this.#tasks.values()].filter((record) => record.owner === owner).map((record) =>
			structuredClone(record.task)
		).sort((a, b) => b.status.timestamp.localeCompare(a.status.timestamp) || b.id.localeCompare(a.id));
	}
	/**
	 * AG-14: newest-created first, ties by id. Creation never changes, so a page cursor anchored on
	 * `(created, id)` neither skips nor repeats a task whose status moves between pages.
	 */
	listByCreation(owner: string): { created: number; task: AgentTask }[] {
		return [...this.#tasks.values()].filter((record) => record.owner === owner).sort((a, b) =>
			b.created - a.created || b.task.id.localeCompare(a.task.id)
		).map((record) => ({ created: record.created, task: structuredClone(record.task) }));
	}
	/**
	 * GW-1: re-checks every unfinished task now. The gateway calls this when a key is rotated or removed or a
	 * session ends, so that credential's work stops at once rather than at its next tool call or slot.
	 */
	reauthorize(): void {
		for (const record of this.#tasks.values()) {
			if (terminal(record.task.status.state) || this.#rights(record) !== null) continue;
			this.#state(record, 'TASK_STATE_FAILED', UNAUTHORIZED);
			record.controller.abort();
		}
	}
	/** Terminal cancellation fails; late executor completion cannot overwrite cancellation. */
	cancel(owner: string, id: string): AgentTask {
		const record = this.#record(owner, id);
		if (terminal(record.task.status.state)) throw new AgentError(-32002, 'Task cannot be canceled');
		this.#state(record, 'TASK_STATE_CANCELED');
		record.controller.abort();
		return this.get(owner, id);
	}
	/** Pending permission content remains owner-only and expires after one minute. */
	permission(owner: string, id: string): Record<string, unknown> | undefined {
		const permission = this.#record(owner, id).permission;
		if (!permission || permission.expires < Date.now()) return undefined;
		return structuredClone({ id: permission.id, params: permission.params, expires: permission.expires });
	}
	/** Resolve a current advertised once-only choice; replay and foreign ownership fail. */
	async decidePermission(owner: string, id: string, permissionId: string, optionId?: string): Promise<void> {
		const record = this.#record(owner, id);
		const permission = record.permission;
		if (!permission || permission.id !== permissionId || permission.expires < Date.now() || !record.bridge) {
			throw new AgentError(-32602, 'Permission is not pending');
		}
		const options = Array.isArray(permission.params.options) ? permission.params.options.map(object) : [];
		if (
			optionId !== undefined &&
			!options.some((option) =>
				option.optionId === optionId && ['allow_once', 'reject_once'].includes(String(option.kind))
			)
		) throw new AgentError(-32602, 'Permission option not allowed');
		record.permission = undefined;
		// AG-7: back to WORKING before the runner hears the decision. Set after the await, it overwrote the
		// INPUT_REQUIRED of a next request the runner raised while this one was still in flight.
		this.#state(record, 'TASK_STATE_WORKING');
		await record.bridge.permission(permissionId, {
			outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
		});
	}
	/** Disconnect removes only this event consumer, preserving independent task execution. */
	subscribe(owner: string, id: string): ReadableStream<Record<string, unknown>> {
		const record = this.#record(owner, id);
		if (record.listeners.size >= 16) throw new AgentError(-32603, 'Task subscriber limit reached');
		const queue = new EventQueue();
		queue.push({ task: structuredClone(record.task) });
		if (terminal(record.task.status.state)) queue.close();
		else record.listeners.add(queue);
		return new ReadableStream({
			async pull(controller): Promise<void> {
				const event = await queue.next();
				if (event) controller.enqueue(structuredClone(event));
				else {
					record.listeners.delete(queue);
					controller.close();
				}
			},
			cancel(): void {
				queue.close();
				record.listeners.delete(queue);
			},
		});
	}
	/** Safe peer inventory discloses identifiers only, never service credentials. */
	peers(): { id: string }[] {
		return [...this.#peers.keys()].map((id) => ({ id }));
	}
	/** Delegation accepts a configured id, never caller-controlled URLs or tokens. */
	delegate(owner: string, scopes: ReadonlySet<string>, peerId: string, value: unknown, credential?: string): AgentTask {
		const peer = this.#peers.get(peerId);
		if (!peer) throw new AgentError(-32602, 'Configured peer not found');
		const message = agentMessage(value);
		// C4 / G10: a delegation waits on a remote agent, bounded like a text task.
		const timeoutMs = this.options.taskTimeoutMs ?? TEXT_TASK_TIMEOUT_MS;
		return this.#create(owner, scopes, credential, message, timeoutMs, { kind: 'delegation' }, async (record) => {
			this.#authorized(record);
			const started = performance.now();
			this.#log(record, 'peer_request', { peer: peerId });
			const result = await peer.send(message, record.controller.signal);
			this.#log(record, 'peer_request', { peer: peerId, duration_ms: Math.round(performance.now() - started) });
			this.#artifact(record, [{ data: result }], 'delegated-task');
		});
	}

	/** A11: a validated webhook configuration with an id, or a `-32003` when push is not offered. */
	#webhook(value: unknown, configId?: unknown): PushConfig {
		const push = this.#push;
		if (push === undefined || !this.supportsPush) throw new AgentError(-32003, 'Push notifications unsupported');
		const input = pushConfigInput(value, configId);
		push.target(input.url);
		return { ...input, id: input.id ?? crypto.randomUUID() };
	}
	/** A11: the public view of a configuration: never its token (secrets never round-trip). */
	#pushView(taskId: string, config: PushConfig): Record<string, unknown> {
		return { id: config.id, taskId, pushNotificationConfig: { id: config.id, url: config.url } };
	}
	/**
	 * A11: `CreateTaskPushNotificationConfig`. A configuration with an id the task already holds replaces it; a new
	 * one past {@linkcode MAX_PUSH_CONFIGS_PER_TASK} is refused. It is persisted with the task and dropped with it.
	 */
	setPushConfig(owner: string, taskId: string, value: unknown, configId?: unknown): Record<string, unknown> {
		const record = this.#record(owner, taskId);
		const config = this.#webhook(value, configId);
		const index = record.push.findIndex((item) => item.id === config.id);
		if (index >= 0) record.push[index] = config;
		else if (record.push.length >= MAX_PUSH_CONFIGS_PER_TASK) {
			throw new AgentError(-32602, `A task holds at most ${MAX_PUSH_CONFIGS_PER_TASK} push notification configs`);
		} else record.push.push(config);
		this.#changed();
		return this.#pushView(taskId, config);
	}
	/** A11: `GetTaskPushNotificationConfig`. */
	getPushConfig(owner: string, taskId: string, configId: string): Record<string, unknown> {
		if (!this.supportsPush) throw new AgentError(-32003, 'Push notifications unsupported');
		const config = this.#record(owner, taskId).push.find((item) => item.id === configId);
		if (config === undefined) throw new AgentError(-32001, 'Push notification config not found');
		return this.#pushView(taskId, config);
	}
	/** A11: `ListTaskPushNotificationConfig`. */
	listPushConfigs(owner: string, taskId: string): Record<string, unknown>[] {
		if (!this.supportsPush) throw new AgentError(-32003, 'Push notifications unsupported');
		return this.#record(owner, taskId).push.map((config) => this.#pushView(taskId, config));
	}
	/** A11: `DeleteTaskPushNotificationConfig`. */
	deletePushConfig(owner: string, taskId: string, configId: string): void {
		if (!this.supportsPush) throw new AgentError(-32003, 'Push notifications unsupported');
		const record = this.#record(owner, taskId);
		const index = record.push.findIndex((item) => item.id === configId);
		if (index < 0) throw new AgentError(-32001, 'Push notification config not found');
		record.push.splice(index, 1);
		this.#changed();
	}

	/** B1: writes any pending change to `tasks.json` now; for tests and operators, not needed for correctness. */
	flush(): Promise<void> {
		return this.#file?.flush() ?? Promise.resolve();
	}

	/**
	 * Stop accepting work, abort executors, and close streams, deliveries and retention timers.
	 *
	 * B1: with persistence, the document written last is the state **before** this cancels anything, so work that
	 * was unfinished at shutdown comes back as {@linkcode INTERRUPTED_BY_RESTART} rather than as cancelled by a
	 * caller who never cancelled it.
	 */
	async close(): Promise<void> {
		// A copy: the loop below moves these very task objects to CANCELED before any write lands.
		const final = this.#closed || this.#file === undefined ? undefined : structuredClone(this.#document());
		this.#final ??= final;
		this.#closed = true;
		clearInterval(this.#reaper);
		const flushed = this.#file?.close(final);
		for (const record of this.#tasks.values()) {
			this.#state(record, 'TASK_STATE_CANCELED');
			record.controller.abort();
		}
		this.#queue = [];
		this.#tasks.clear();
		await Promise.allSettled([...this.#executions]);
		await this.#push?.close();
		await flushed;
	}
}
