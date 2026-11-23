import { A2aPeerClient, type AgentPeer } from './a2a.ts';
import { DurableJsonFile } from './durable.ts';
import {
	MAX_PUSH_CONFIGS_PER_TASK,
	type PushConfig,
	pushConfigInput,
	PushDispatcher,
	type PushOptions,
	pushOrigin,
} from './push.ts';
import {
	AgentError,
	endedTaskRefusal,
	EventQueue,
	identifier,
	MCP_INVOKE_SCOPE_REQUIRED,
	MODEL_INVOKE_SCOPE_REQUIRED,
	MODEL_REQUIRES_PROVIDER,
	object,
	SANDBOX_EXECUTE_SCOPE_REQUIRED,
	terminal,
} from './util.ts';
import type { ModelProviderClient, ModelTool } from './model/transport.ts';
import { type ModelEvent, runModelTask } from './model/loop.ts';
import {
	AGENT_PROFILES,
	type AgentId,
	type AgentProfile,
	agentProfile,
	type AgentProfileId,
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
 * Re-authorizes a task against the credential that submitted it: the scopes it holds now, or `null` once revoked,
 * rotated, expired or logged out. Called at start, before every tool call and delegation, and on a credential change;
 * the runtime still narrows the answer to the submitted scopes, so a widened key never widens a task.
 */
export type AgentAuthorization = (
	owner: string,
	scopes: ReadonlySet<string>,
	credential: string | undefined,
) => ReadonlySet<string> | null;

/** Optional backends are explicit operator dependencies. */
export interface AgentRuntimeOptions {
	invoke: ToolInvocation;
	peers?: readonly AgentPeer[];
	/** Absent (stdio, tests): a task keeps its submitted scopes. */
	authorize?: AgentAuthorization;
	queueDeadlineMs?: number;
	/** Text and delegation task bound, `TTK_AGENT_TASK_TIMEOUT_S`; a tool task's comes from its tools. */
	taskTimeoutMs?: number;
	/** Finished-task retention, `TTK_AGENT_TASK_RETENTION_S`. */
	retentionMs?: number;
	/** `<TTK_DATA_DIR>/agents/tasks.json`; absent keeps tasks in memory only. */
	persistPath?: string;
	/** The operator's webhook policy; absent means push is not offered (`-32003`). */
	push?: PushOptions;
	/** Seals a webhook token for `tasks.json`; absent, a token is never written and its config is dropped on restore. */
	sealer?: SecretSealer;
	/** Persistence and delivery failures; never a credential, token or message content. */
	logger?: { warn(message: string): void };
	/**
	 * The operator's model providers, read at every use (the gateway swaps the set in place). `reachable` answers the
	 * net-grant proof per provider; `tools` is the caller's taskable list. Absent: no text tasks.
	 */
	model?: {
		readonly providers: ReadonlyMap<string, ModelProviderClient>;
		readonly default: string | null;
		readonly reachable: (id: string) => boolean;
		readonly tools: (scopes: ReadonlySet<string>) => ModelTool[];
	};
	/** Whether the coding sandbox is composed; a profile that needs it is accepted only then. */
	codingSandbox?: boolean;
	/** The administrator's per-agent settings, read at every use. */
	agents?: () => AgentSettings;
	/**
	 * Whether this deployment has `tool` and `scopes` could run it here as a task, so a delegated data part never
	 * asks a peer for what the caller could not do locally. Absent: every delegated data part is refused.
	 */
	delegableTool?: (tool: string, scopes: ReadonlySet<string>) => boolean;
}

/**
 * The only tools a delegated data part may name. The peer sees every local owner as one principal (the operator's
 * peer token), so a tool that reads or changes per-principal state there would cross owners; only stateless tools are
 * delegable. An allow-list, so a new tool is refused until judged here.
 */
const DELEGABLE_TOOLS: ReadonlySet<string> = new Set(['browser_head', 'browser_health', 'browser_file_policy']);
/** Arguments that address existing state on the peer; a delegated data part naming any of them is refused. */
const PEER_STATE_ARGUMENTS: readonly string[] = ['session_id', 'task_id', 'workspace_id', 'surface_id'];

/** A caller's choice of provider (and model) for a text task. */
export interface ModelSelection {
	readonly provider?: string;
	readonly model?: string;
}

/** `task.metadata`, on every task from submission on, so every binding reads the task's kind without parsing it. */
export interface AgentTaskMetadata extends Record<string, unknown> {
	readonly kind: 'text' | 'tool' | 'delegation';
	readonly backend?: 'model';
	readonly provider?: string;
	readonly model?: string;
	readonly steps?: number;
	readonly usage?: { readonly input: number; readonly output: number };
	/** The built-in profile that ran a text task. */
	readonly agent?: AgentProfileId;
}

/** The one text a scopeless caller ever sees about providers. */
const NO_TEXT_BACKEND = 'Text execution requires a model provider';
const NOT_OFFERED_OVER_A2A = 'The built-in agent is not offered over A2A';
const UNAUTHORIZED = 'Task credential is no longer authorized';
const QUEUE_EXPIRED = 'Task was not started before its queue deadline';
const NOT_REACHABLE = 'Model provider is not reachable: no outbound net grant';
const PUSH_UNSUPPORTED = 'Push notifications unsupported';
/** What a task that was queued or running at shutdown says after the restart. */
export const INTERRUPTED_BY_RESTART = 'interrupted by restart';

/** A queued task carries the authority of one request, so it may not wait indefinitely for a slot. */
const TASK_QUEUE_DEADLINE_MS = 120_000;
const TEXT_TASK_TIMEOUT_MS = 600_000;
const TASK_RETENTION_MS = 86_400_000;
/** A tool call whose tool names no bound of its own. */
export const TOOL_CALL_BOUND_MS = 120_000;
/** What a tool task is given beyond its tool's own bound, for dispatch, the browser lock and the result. */
export const TOOL_BOUND_MARGIN_MS = 30_000;
/** The sandbox holds a command up to two minutes for an execution slot before its own timeout starts. */
export const SANDBOX_SLOT_WAIT_MS = 120_000;
/** Tasks running at once, across every owner. */
export const TASK_SLOTS = 4;
/** Tasks one owner may run at once, so one owner's hours-long tool tasks cannot hold every slot. */
export const TASK_SLOTS_PER_OWNER = 2;
const TASKS_PER_OWNER = 32;
const TASKS_TOTAL = 256;

/**
 * How long one structured tool call of a task may take. Arguments are read before the tool validates them, so each is
 * clamped to the range the tool itself accepts: a request cannot buy a longer bound with a value the tool refuses.
 */
export function toolTaskBoundMs(tool: string, args: Readonly<Record<string, unknown>>): number {
	const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
		typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
	switch (tool) {
		case 'sandbox_exec': // the sandbox's `LIMITS`: default 5 min, 1 s – 15 min
			return bounded(args.timeout_ms, 300_000, 1_000, 900_000) + SANDBOX_SLOT_WAIT_MS + TOOL_BOUND_MARGIN_MS;
		case 'browser_wait_for': // default 10 s, 100 ms – 60 s
			return bounded(args.timeout_ms, 10_000, 100, 60_000) + TOOL_BOUND_MARGIN_MS;
		default:
			return TOOL_CALL_BOUND_MS;
	}
}

/** The supported A2A 1.0 message subset: neither the message nor its parts carry a `kind` discriminator. */
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
	metadata: AgentTaskMetadata;
}

interface TaskRecord {
	owner: string;
	scopes: ReadonlySet<string>;
	/** Opaque fingerprint of the submitting credential; re-checked, never shown or returned. */
	credential?: string;
	task: AgentTask;
	controller: AbortController;
	// No replay buffer: a subscriber receives the full task snapshot first.
	listeners: Set<EventQueue>;
	/** Immutable creation instant, the stable half of the ListTasks cursor. */
	created: number;
	finished?: number;
	timeoutMs: number;
	run: () => Promise<void>;
	push: PushConfig[];
}

/** A synchronous AES-GCM sealer; `context` is authenticated, so a token copied to another config does not open. */
export interface SecretSealer {
	seal(plain: string, context: string): string;
	/** The plain text, or `null` when the value does not open under this key and context. */
	open(sealed: string, context: string): string | null;
}

/** One task as `tasks.json` holds it — never scopes or a credential fingerprint. */
interface StoredTask {
	owner: string;
	created: number;
	finished?: number;
	task: AgentTask;
	push?: PushConfig[];
	/** Configs whose token could not be restored; dropped. */
	unrestorable?: number;
}

/** One push config as `tasks.json` holds it: the token sealed, or withheld — never plain text. */
interface StoredPush {
	id: string;
	url: string;
	sealed_token?: string;
	token_withheld?: true;
}

function pushTokenContext(taskId: string, configId: string): string {
	return `a2a-push/${taskId}/${configId}`;
}

interface TasksDocument {
	version: 1;
	tasks: StoredTask[];
	/** `[owner\0messageId, taskId]`, so a client retry after a restart still finds its task. */
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
const TASK_KINDS: ReadonlySet<string> = new Set<AgentTaskMetadata['kind']>(['text', 'tool', 'delegation']);

/**
 * A stored task as this runtime wrote it, or `null` for a hand-edited or truncated entry. A sealed token is opened
 * with `sealer`; a withheld, unopenable or plain-text token drops its config (counted in `unrestorable`).
 */
function storedTask(value: unknown, sealer: SecretSealer | undefined): StoredTask | null {
	try {
		const entry = object(value);
		const task = object(entry.task);
		const status = object(task.status);
		identifier(entry.owner);
		identifier(task.id);
		identifier(task.contextId);
		const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
		if (
			!finite(entry.created) || (entry.finished !== undefined && !finite(entry.finished)) ||
			typeof status.state !== 'string' || !TASK_STATES.has(status.state) || typeof status.timestamp !== 'string' ||
			!Array.isArray(task.artifacts) || !Array.isArray(task.history) ||
			!TASK_KINDS.has(object(task.metadata).kind as string)
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
			} else if (config.token_withheld === true || config.token !== undefined) {
				unrestorable++;
				continue;
			}
			push.push({ id, url: config.url, ...(token === undefined ? {} : { token }) });
		}
		return {
			owner: entry.owner as string,
			created: entry.created,
			...(entry.finished === undefined ? {} : { finished: entry.finished as number }),
			task: task as AgentTask,
			push,
			...(unrestorable === 0 ? {} : { unrestorable }),
		};
	} catch {
		return null;
	}
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
			// Only a new task's data is a tool call; a message to an existing task is refused by the runtime.
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
 * Owner-isolated, bounded execution shared by A2A, MCP and the SPA. With a `persistPath` it survives a restart:
 * finished tasks, push configs and idempotency keys are kept; unfinished work comes back failed and is never
 * re-executed, so a mutating tool never runs twice.
 */
export class AgentRuntime {
	#tasks = new Map<string, TaskRecord>();
	/** `owner\0messageId` -> task id; one owner's message id never finds another's task. */
	#byMessage = new Map<string, string>();
	#queue: TaskRecord[] = [];
	#running = 0;
	#runningByOwner = new Map<string, number>();
	#closed = false;
	#reaper: ReturnType<typeof setInterval>;
	#peers = new Map<string, A2aPeerClient>();
	#executions = new Set<Promise<void>>();
	readonly #file: DurableJsonFile | undefined;
	readonly #push: PushDispatcher | undefined;
	/** The document as it stood when close() began. */
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
	/** A text backend exists: at least one provider the process can reach. */
	get supportsText(): boolean {
		return this.reachableProviders > 0;
	}
	get reachableProviders(): number {
		const model = this.options.model;
		return model === undefined ? 0 : [...model.providers.keys()].filter((id) => model.reachable(id)).length;
	}
	/** Whether a built-in profile could take a text task here (drives its card; a request is judged in full). */
	profileReady(id: string): boolean {
		const profile = AGENT_PROFILES.get(id);
		if (profile === undefined) return false;
		return (!profile.needsSandbox || this.options.codingSandbox === true) && this.reachableProviders > 0;
	}
	providerReachable(id: string): boolean {
		return this.options.model?.reachable(id) === true;
	}
	agentSetting(id: AgentId): AgentSetting {
		return (this.options.agents?.() ?? DEFAULT_AGENT_SETTINGS)[id];
	}
	get peerIds(): string[] {
		return [...this.#peers.keys()];
	}
	get supportsPush(): boolean {
		return this.#push !== undefined && (this.options.push?.ready?.() ?? true);
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

	#changed(): void {
		if (!this.#closed) this.#file?.schedule(() => this.#document());
	}

	/** Everything `tasks.json` holds; once closing, the state frozen at shutdown. */
	#document(): TasksDocument {
		if (this.#final !== undefined) return this.#final;
		const tasks: StoredTask[] = [...this.#tasks.values()].map((record) => ({
			owner: record.owner,
			created: record.created,
			...(record.finished === undefined ? {} : { finished: record.finished }),
			task: record.task,
			...(record.push.length ? { push: record.push.map((config) => this.#storedPush(record.task.id, config)) } : {}),
		}));
		const idempotency: [string, string][] = [...this.#byMessage].filter(([, id]) => this.#tasks.has(id));
		return { version: 1, tasks, idempotency };
	}

	#storedPush(taskId: string, config: PushConfig): StoredPush {
		const { id, url, token } = config;
		if (token === undefined) return { id, url };
		const sealer = this.options.sealer;
		return sealer === undefined
			? { id, url, token_withheld: true }
			: { id, url, sealed_token: sealer.seal(token, pushTokenContext(taskId, id)) };
	}

	/**
	 * Loads `tasks.json`. A task unfinished at shutdown is failed with {@linkcode INTERRUPTED_BY_RESTART}: re-running
	 * it could repeat a mutation. Retention and the capacity caps apply to what was loaded.
	 */
	#restore(): void {
		const file = this.#file;
		const raw = file?.read();
		if (file === undefined || raw === undefined) return;
		let document: Record<string, unknown>;
		try {
			document = object(raw);
			if (document.version !== 1 || !Array.isArray(document.tasks)) throw new Error('version');
		} catch {
			this.options.logger?.warn(`${file.path} is not a version 1 task document; starting empty`);
			return;
		}
		const now = Date.now();
		const stored = (document.tasks as unknown[]).map((entry) => storedTask(entry, this.options.sealer));
		const skipped = stored.filter((entry) => entry === null).length;
		const perOwner = new Map<string, number>();
		const kept = (stored.filter((entry) => entry !== null) as StoredTask[])
			.filter((entry) => entry.finished === undefined || now - entry.finished < this.#retentionMs)
			.sort((a, b) => b.created - a.created)
			.filter((entry) => {
				const count = perOwner.get(entry.owner) ?? 0;
				perOwner.set(entry.owner, count + 1);
				return count < TASKS_PER_OWNER;
			})
			.slice(0, TASKS_TOTAL);
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
			};
			this.#tasks.set(entry.task.id, record);
			if (record.finished === undefined && !terminal(record.task.status.state)) interrupted.push(record);
		}
		for (const pair of Array.isArray(document.idempotency) ? document.idempotency : []) {
			if (
				Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' &&
				this.#tasks.get(pair[1])?.owner === pair[0].split('\u0000', 1)[0]
			) this.#byMessage.set(pair[0], pair[1]);
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
	 * A restored webhook is held to the push policy as it is now: one no longer allowed is dropped with its token
	 * before the restart's status update could reach it. With push not offered, configs are kept for a later policy.
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
	#expired(record: TaskRecord, now = Date.now()): boolean {
		return record.task.status.state === 'TASK_STATE_SUBMITTED' &&
			now - record.created >= (this.options.queueDeadlineMs ?? TASK_QUEUE_DEADLINE_MS);
	}
	/**
	 * The submitted scopes narrowed to what the credential holds now, or `null` once it holds nothing — including
	 * when it lost `agent:invoke`. A fault in the check fails closed.
	 */
	#rights(record: TaskRecord): ReadonlySet<string> | null {
		const authorize = this.options.authorize;
		if (authorize === undefined) return record.scopes;
		let held: ReadonlySet<string> | null;
		try {
			held = authorize(record.owner, record.scopes, record.credential);
		} catch {
			held = null;
		}
		if (held === null) return null;
		const rights = new Set([...record.scopes].filter((scope) => held.has(scope)));
		return rights.has('agent:invoke') ? rights : null;
	}
	#authorized(record: TaskRecord): ReadonlySet<string> {
		const rights = this.#rights(record);
		if (rights === null) throw new AgentError(-32600, UNAUTHORIZED);
		return rights;
	}
	/**
	 * Finished tasks never hold capacity against new work: at a cap the oldest finished tasks are evicted, the
	 * caller's own first, so only unfinished work can make #create refuse.
	 */
	#makeRoom(owner: string): void {
		const oldestFinished = (records: TaskRecord[]): TaskRecord[] =>
			records.filter((record) => record.finished !== undefined).sort((a, b) =>
				a.finished! - b.finished! || a.created - b.created
			);
		const own = [...this.#tasks.values()].filter((record) => record.owner === owner);
		for (const record of oldestFinished(own).slice(0, Math.max(0, own.length - (TASKS_PER_OWNER - 1)))) {
			this.#tasks.delete(record.task.id);
		}
		const excess = this.#tasks.size - (TASKS_TOTAL - 1);
		if (excess <= 0) return;
		const finished = oldestFinished([...this.#tasks.values()]);
		const order = [...finished.filter((r) => r.owner === owner), ...finished.filter((r) => r.owner !== owner)];
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
	#agentMessage(record: TaskRecord, parts: Record<string, unknown>[]): AgentMessage {
		return {
			messageId: crypto.randomUUID(),
			role: 'ROLE_AGENT',
			taskId: record.task.id,
			contextId: record.task.contextId,
			parts,
		};
	}
	#statusUpdate(record: TaskRecord, status: AgentTask['status']): Record<string, unknown> {
		return { statusUpdate: { taskId: record.task.id, contextId: record.task.contextId, status } };
	}
	/** A message to subscribers under the current state (streamed text or a model event); not kept on the task. */
	#note(record: TaskRecord, parts: Record<string, unknown>[]): void {
		const status = {
			state: record.task.status.state,
			timestamp: new Date().toISOString(),
			message: this.#agentMessage(record, parts),
		};
		this.#emit(record, this.#statusUpdate(record, status));
	}
	#state(record: TaskRecord, state: string, text?: string): void {
		if (terminal(record.task.status.state)) return;
		record.task.status = {
			state,
			timestamp: new Date().toISOString(),
			...(text ? { message: this.#agentMessage(record, [{ text }]) } : {}),
		};
		const update = this.#statusUpdate(record, record.task.status);
		this.#emit(record, update);
		// Never at shutdown: the restart reports it instead (see #restore).
		if (!this.#closed) this.#push?.deliver(record.task.id, record.push, structuredClone(update));
		if (terminal(state)) {
			record.finished = Date.now();
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
		this.#emit(record, {
			artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId, artifact, lastChunk: true },
		});
		this.#changed();
	}
	/**
	 * Starts queued tasks while a slot is free: the oldest whose owner runs fewer than {@linkcode TASK_SLOTS_PER_OWNER}
	 * (or one that will not run at all and only leaves the queue). An owner at its share keeps its place.
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
			// A queued task starts only inside its deadline and while its own credential still authorizes it.
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
			const timer = setTimeout(() => {
				this.#state(record, 'TASK_STATE_FAILED', 'Task execution timed out');
				record.controller.abort();
			}, record.timeoutMs);
			const execution = record.run().then(() => this.#state(record, 'TASK_STATE_COMPLETED')).catch((error) => {
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

	#create(
		owner: string,
		scopes: ReadonlySet<string>,
		credential: string | undefined,
		message: AgentMessage,
		timeoutMs: number,
		metadata: AgentTaskMetadata,
		execute: (record: TaskRecord) => Promise<void>,
		push?: unknown,
	): AgentTask {
		if (this.#closed) throw new AgentError(-32603, 'Agent runtime closed');
		if (!scopes.has('agent:invoke')) throw new AgentError(-32600, 'agent:invoke scope required');
		// Validated before anything exists, so a refused URL creates no task; never re-attached by a retry.
		const webhook = push === undefined ? undefined : this.#webhook(push);
		// A message this owner already sent (a client retry) answers with the task it started, and runs nothing.
		const key = `${owner}\u0000${message.messageId}`;
		const seen = this.#byMessage.get(key);
		if (seen !== undefined) {
			const prior = this.#tasks.get(seen);
			if (prior !== undefined && prior.owner === owner) return structuredClone(prior.task);
			this.#byMessage.delete(key);
		}
		if (message.taskId) {
			// No task here ever waits for input, so every follow-up is refused, after the identifiers are judged.
			const prior = this.#record(owner, message.taskId);
			if (message.contextId !== undefined && message.contextId !== prior.task.contextId) {
				throw new AgentError(-32602, 'Message task/context identifiers do not match');
			}
			if (terminal(prior.task.status.state)) throw new AgentError(-32004, 'Terminal task cannot accept messages');
			throw new AgentError(-32004, 'This task is not waiting for input');
		}
		this.#reap();
		this.#makeRoom(owner);
		const own = [...this.#tasks.values()].filter((record) => record.owner === owner);
		if (this.#tasks.size >= TASKS_TOTAL || own.length >= TASKS_PER_OWNER) {
			throw new AgentError(-32603, 'Task capacity reached');
		}
		// Reuse only the caller's own context; a client-chosen context id never binds another owner.
		if (message.contextId && !own.some((record) => record.task.contextId === message.contextId)) {
			throw new AgentError(-32001, 'Context not found');
		}
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
		};
		this.#tasks.set(id, record);
		this.#byMessage.set(key, id);
		this.#queue.push(record);
		queueMicrotask(() => this.#pump());
		this.#changed();
		return structuredClone(task);
	}

	/**
	 * Which provider a text task runs on, judged before any task exists so a refusal leaves nothing behind:
	 *
	 * | selection | default | `model:invoke` | result |
	 * | `model` only | any | any | `-32602 model requires provider` — before every other row |
	 * | provider | any | yes | that provider; unknown → `-32602`; unreachable → `-32004` |
	 * | provider | any | no | `-32600 model:invoke scope required` |
	 * | none | yes | yes | the agent's own default model if still listed, else the default provider |
	 * | none | yes | no / none | any | `-32004` with the unavailable text — nothing about providers |
	 *
	 * A profile's `-32004` names its own `unavailable` text; a profile that needs the sandbox is refused without one,
	 * and its grants (`mcp:invoke`, `sandbox:execute`) are checked at submit.
	 */
	#textBackend(
		scopes: ReadonlySet<string>,
		selection: ModelSelection | undefined,
		profile?: AgentProfile,
		via?: 'a2a',
	): { provider: string; model: string } {
		if (selection?.model !== undefined && selection.provider === undefined) {
			throw new AgentError(-32602, MODEL_REQUIRES_PROVIDER);
		}
		if (profile === undefined) {
			const backend = this.#modelBackend(scopes, selection, NO_TEXT_BACKEND, 'builtin');
			if (via === 'a2a' && !this.agentSetting('builtin').a2a) throw new AgentError(-32004, NOT_OFFERED_OVER_A2A);
			return backend;
		}
		if (via === 'a2a' && !this.agentSetting(profile.id).a2a) {
			throw new AgentError(-32004, `${profile.name} is not offered over A2A`);
		}
		if (profile.needsSandbox && this.options.codingSandbox !== true) {
			throw new AgentError(-32004, profile.unavailable);
		}
		const backend = this.#modelBackend(scopes, selection, profile.unavailable, profile.id);
		if (!scopes.has('mcp:invoke')) throw new AgentError(-32600, MCP_INVOKE_SCOPE_REQUIRED);
		if (profile.needsSandbox && !scopes.has('sandbox:execute')) {
			throw new AgentError(-32600, SANDBOX_EXECUTE_SCOPE_REQUIRED);
		}
		return backend;
	}

	#modelBackend(
		scopes: ReadonlySet<string>,
		selection: ModelSelection | undefined,
		unavailable: string,
		agent: AgentId,
	): { provider: string; model: string } {
		const model = this.options.model;
		const resolve = (client: ModelProviderClient, name: string | undefined): { provider: string; model: string } => {
			const chosen = name ?? client.defaultModel;
			if (!client.models.includes(chosen)) throw new AgentError(-32602, 'Unknown model for provider');
			if (!model!.reachable(client.id)) throw new AgentError(-32004, NOT_REACHABLE);
			return { provider: client.id, model: chosen };
		};
		if (selection?.provider !== undefined) {
			if (!scopes.has('model:invoke')) throw new AgentError(-32600, MODEL_INVOKE_SCOPE_REQUIRED);
			if (model === undefined || model.providers.size === 0) throw new AgentError(-32004, unavailable);
			const client = model.providers.get(selection.provider);
			if (client === undefined) throw new AgentError(-32602, 'Unknown model provider');
			return resolve(client, selection.model);
		}
		// A stale own default (provider or model gone) falls back to the providers' default rather than refusing.
		const chosen = this.agentSetting(agent).model;
		const own = chosen === null ? undefined : model?.providers.get(chosen.provider);
		if (own !== undefined && own.models.includes(chosen!.model)) {
			if (!scopes.has('model:invoke')) throw new AgentError(-32004, unavailable);
			return resolve(own, chosen!.model);
		}
		const client = model?.default == null ? undefined : model.providers.get(model.default);
		if (client === undefined || !scopes.has('model:invoke')) throw new AgentError(-32004, unavailable);
		return resolve(client, selection?.model);
	}

	/**
	 * Submit a typed tool request or a text prompt for the built-in model agent. `credential` is the gateway's
	 * fingerprint of the credential behind `owner`, handed back to `authorize` only. `options.push` attaches a webhook;
	 * `options.agent` names a built-in profile, which takes text only (`-32005` for a data part).
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
		const dataParts = message.parts.filter((part) => part.data !== undefined);
		if (profile !== undefined && dataParts.length) {
			throw new AgentError(-32005, `${profile.name} accepts text messages only`);
		}
		const backend = dataParts.length ? undefined : this.#textBackend(scopes, options.model, profile, options.via);
		// A tool task may take as long as its tools, one after another; a follow-up's data part is no tool call.
		const timeoutMs = dataParts.length && message.taskId === undefined
			? dataParts.reduce((sum, part) => {
				const data = object(part.data);
				return sum + toolTaskBoundMs(String(data.tool), object(data.arguments ?? {}));
			}, 0)
			: this.options.taskTimeoutMs ?? TEXT_TASK_TIMEOUT_MS;
		const metadata: AgentTaskMetadata = backend === undefined ? { kind: 'tool' } : {
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
				if (backend !== undefined) return await this.#model(record, message, backend, profile);
				for (const part of dataParts) {
					record.controller.signal.throwIfAborted();
					// The credential's current scopes, every call: a narrowed or revoked key never lends its old authority.
					const rights = this.#authorized(record);
					if (!rights.has('mcp:invoke')) throw new AgentError(-32600, MCP_INVOKE_SCOPE_REQUIRED);
					const data = object(part.data);
					const result = await this.options.invoke(
						identifier(data.tool),
						object(data.arguments ?? {}),
						owner,
						rights,
						record.controller.signal,
					);
					this.#artifact(record, [{ data: result }]);
					if (result.isError === true) throw new AgentError(-32603, 'Tool execution returned an error');
				}
			},
			options.push,
		);
	}

	/**
	 * Runs a text task through `runModelTask`. `refusal` → `TASK_STATE_REJECTED`; the final text becomes the
	 * `agent-response` artifact and joins the history, already redacted of the provider key.
	 */
	async #model(
		record: TaskRecord,
		message: AgentMessage,
		backend: { provider: string; model: string },
		profile?: AgentProfile,
	): Promise<void> {
		// Judged again at start against the set in force now: a provider removed while the task queued is never dialled.
		const model = this.options.model!;
		const client = model.providers.get(backend.provider);
		if (client === undefined || !client.models.includes(backend.model)) {
			throw new AgentError(-32004, 'Model provider is no longer configured');
		}
		if (!model.reachable(client.id)) throw new AgentError(-32004, NOT_REACHABLE);
		const setting = this.agentSetting(profile?.id ?? 'builtin');
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
			tools: (rights) => model.tools(rights).filter((tool) => settingAllows(setting, tool.name)),
			...(effective === undefined ? {} : { profile: effective }),
			invoke: this.options.invoke,
			emitText: (text): void => {
				bytes += new TextEncoder().encode(text).length;
				if (bytes > 1024 * 1024 || parts.length >= 4096) throw new AgentError(-32603, 'Agent output exceeds limit');
				parts.push({ text });
				this.#note(record, [{ text }]);
			},
			emitData: (event: ModelEvent): void => {
				if (terminal(record.task.status.state)) return;
				this.#note(record, [{ data: { model: event } }]);
			},
			progress: (steps, usage): void => {
				record.task.metadata = { ...record.task.metadata, steps, usage };
				this.#changed();
			},
		});
		if (parts.length) {
			this.#artifact(record, parts, 'agent-response');
			const text = parts.map((part) => String(part.text ?? '')).join('').slice(0, 65_536);
			record.task.history.push(this.#agentMessage(record, [{ text }]));
			if (record.task.history.length > 100) record.task.history.splice(0, record.task.history.length - 100);
			this.#changed();
		}
		if (outcome === 'refusal') this.#state(record, 'TASK_STATE_REJECTED');
	}

	/** Snapshot lookup conceals wrong-owner identifiers as not found. */
	get(owner: string, id: string, historyLength = 100): AgentTask {
		if (!Number.isInteger(historyLength) || historyLength < 0) throw new AgentError(-32602, 'Invalid historyLength');
		const task = structuredClone(this.#record(owner, id).task);
		task.history = historyLength === 0 ? [] : task.history.slice(-Math.min(historyLength, 100));
		return task;
	}
	/** Most recent status first; only the authenticated principal's tasks exist here. */
	list(owner: string): AgentTask[] {
		return [...this.#tasks.values()].filter((record) => record.owner === owner).map((record) =>
			structuredClone(record.task)
		).sort((a, b) => b.status.timestamp.localeCompare(a.status.timestamp) || b.id.localeCompare(a.id));
	}
	/** Newest-created first, ties by id: a stable order for page cursors. */
	listByCreation(owner: string): { created: number; task: AgentTask }[] {
		return [...this.#tasks.values()].filter((record) => record.owner === owner).sort((a, b) =>
			b.created - a.created || b.task.id.localeCompare(a.task.id)
		).map((record) => ({ created: record.created, task: structuredClone(record.task) }));
	}
	/** Re-checks every unfinished task now (a key rotated or removed, a session ended). */
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
		const state = record.task.status.state;
		if (terminal(state)) throw new AgentError(-32002, endedTaskRefusal(state, 'canceled'));
		this.#state(record, 'TASK_STATE_CANCELED');
		record.controller.abort();
		return this.get(owner, id);
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
	/**
	 * Delegation accepts a configured id, never caller-controlled URLs or tokens. The peer sees only the operator's
	 * token, so data parts are judged here, at submission and again against the current scopes before the peer is asked.
	 */
	delegate(owner: string, scopes: ReadonlySet<string>, peerId: string, value: unknown, credential?: string): AgentTask {
		const peer = this.#peers.get(peerId);
		if (!peer) throw new AgentError(-32602, 'Configured peer not found');
		const message = agentMessage(value);
		// A follow-up answers this runtime's own task; read before #create sets `taskId` on a new task's message.
		const toPeer = message.taskId === undefined;
		if (toPeer && scopes.has('agent:invoke')) this.#delegable(message.parts, scopes);
		const timeoutMs = this.options.taskTimeoutMs ?? TEXT_TASK_TIMEOUT_MS;
		return this.#create(owner, scopes, credential, message, timeoutMs, { kind: 'delegation' }, async (record) => {
			const rights = this.#authorized(record);
			if (toPeer) this.#delegable(message.parts, rights);
			const result = await peer.send(message, record.controller.signal);
			this.#artifact(record, [{ data: result }], 'delegated-task');
		});
	}

	/** Every delegated data part needs `mcp:invoke`, a delegable tool, no peer-state argument, and a local grant. */
	#delegable(parts: readonly Record<string, unknown>[], scopes: ReadonlySet<string>): void {
		for (const part of parts) {
			if (part.data === undefined) continue;
			const data = object(part.data);
			const tool = identifier(data.tool);
			if (!scopes.has('mcp:invoke')) throw new AgentError(-32600, MCP_INVOKE_SCOPE_REQUIRED);
			if (!DELEGABLE_TOOLS.has(tool)) {
				throw new AgentError(
					-32602,
					`${tool} cannot be delegated: on the peer every caller is the same principal, so it would reach work ` +
						'that is not yours',
				);
			}
			const named = PEER_STATE_ARGUMENTS.find((key) => key in object(data.arguments ?? {}));
			if (named !== undefined) {
				throw new AgentError(-32602, `a delegated tool call cannot name ${named}: the peer's state is shared`);
			}
			if (!(this.options.delegableTool?.(tool, scopes) ?? false)) {
				throw new AgentError(-32600, `this credential cannot call ${tool} here, so it cannot delegate it`);
			}
		}
	}

	/** A validated webhook configuration with an id, or `-32003` when push is not offered. */
	#webhook(value: unknown, configId?: unknown): PushConfig {
		const push = this.#push;
		if (push === undefined || !this.supportsPush) throw new AgentError(-32003, PUSH_UNSUPPORTED);
		const input = pushConfigInput(value, configId);
		push.target(input.url);
		return { ...input, id: input.id ?? crypto.randomUUID() };
	}
	/** The public view of a configuration: never its token. */
	#pushView(taskId: string, config: PushConfig): Record<string, unknown> {
		return { id: config.id, taskId, pushNotificationConfig: { id: config.id, url: config.url } };
	}
	/** The task's configs, once push is offered. */
	#pushConfigs(owner: string, taskId: string): PushConfig[] {
		if (!this.supportsPush) throw new AgentError(-32003, PUSH_UNSUPPORTED);
		return this.#record(owner, taskId).push;
	}
	/** `CreateTaskPushNotificationConfig`: an existing id is replaced; a new one past the cap is refused. */
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
	getPushConfig(owner: string, taskId: string, configId: string): Record<string, unknown> {
		const config = this.#pushConfigs(owner, taskId).find((item) => item.id === configId);
		if (config === undefined) throw new AgentError(-32001, 'Push notification config not found');
		return this.#pushView(taskId, config);
	}
	listPushConfigs(owner: string, taskId: string): Record<string, unknown>[] {
		return this.#pushConfigs(owner, taskId).map((config) => this.#pushView(taskId, config));
	}
	deletePushConfig(owner: string, taskId: string, configId: string): void {
		const configs = this.#pushConfigs(owner, taskId);
		const index = configs.findIndex((item) => item.id === configId);
		if (index < 0) throw new AgentError(-32001, 'Push notification config not found');
		configs.splice(index, 1);
		this.#changed();
	}

	/** Writes any pending change to `tasks.json` now; not needed for correctness. */
	flush(): Promise<void> {
		return this.#file?.flush() ?? Promise.resolve();
	}

	/**
	 * Stop accepting work, abort executors, and close streams, deliveries and timers. The document written last is
	 * the state before this cancels anything, so unfinished work comes back as interrupted, not cancelled.
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
