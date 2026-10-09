/**
 * Multi-node operation (SPECS/ROADMAP.md R10) and the edge/browser split (R12).
 *
 * A browser session is not a row in a database. It is a running Chromium with
 * open sockets, a profile directory and a screencast, and it exists on exactly
 * one machine. So "scale out" here cannot mean replicating state — it means
 * knowing *which node* a session lives on and getting the request there.
 *
 * That is the whole design:
 *
 * - every node publishes itself into a shared Deno KV store, with a heartbeat;
 * - a session's owner is claimed in the same store, atomically, so two nodes
 *   racing to create the implicit `default` session cannot both win;
 * - a request naming a session this node does not own is forwarded to the node
 *   that does, carrying the caller's own credential so authorization is decided
 *   by the owner and not delegated to a machine-to-machine secret.
 *
 * R12 falls out of it: a node with `role: 'edge'` claims nothing and hosts
 * nothing, so it needs no Chromium, no `--allow-run` and no writable profile
 * directory — it is a router with a live view attached. A node with
 * `role: 'browser'` owns sessions and can sit on a private network.
 *
 * ## Why Deno KV, and what it costs
 *
 * It is the only shared store in the platform that needs no server, no driver
 * and no FFI (which this deployment denies outright), and it is the same API
 * backed by a file locally and by a hosted store on Deno Deploy — which is what
 * makes R12's edge posture reachable at all. The cost is a runtime flag:
 * `Deno.openKv` needs `--unstable-kv`, so clustering has its own launch line
 * and the default single-node path stays flag-free.
 *
 * The second cost is measured rather than assumed: the local backing store is
 * SQLite, and two writers contending for one file get `TypeError: database is
 * locked` rather than being serialised for them. That is not an error condition
 * — it is what contention *looks like* here, and it is most likely at exactly
 * the moment the design cares about, two nodes claiming the same session at
 * once. Every write therefore retries; see {@linkcode withLockRetry}.
 */
import type { Logger } from './logger.ts';

/** What a node is willing to do. */
export const NODE_ROLES = ['all', 'edge', 'browser'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/** Header marking a request that has already been forwarded once. */
export const FORWARDED_HEADER = 'x-ttk-forwarded-by';

/** How often a node refreshes its registration. */
const HEARTBEAT_MS = 5_000;
/**
 * How long a registration survives without a heartbeat.
 *
 * Three missed beats: long enough that a garbage-collection pause does not
 * evict a healthy node, short enough that a dead one stops receiving work
 * before a user notices.
 */
const NODE_TTL_MS = HEARTBEAT_MS * 3;

/** One node, as its peers see it. */
export interface NodeInfo {
	readonly id: string;
	/** Absolute URL peers use to reach it. */
	readonly url: string;
	readonly role: NodeRole;
	readonly version: string;
}

export interface ClusterOptions {
	/** Path (or Deno Deploy binding) for the shared store. */
	readonly kvPath: string;
	readonly nodeId: string;
	/** This node's URL, as peers must call it. Empty for an edge-only node. */
	readonly nodeUrl: string;
	readonly role: NodeRole;
	readonly version: string;
	readonly logger: Logger;
	/** Injected clock, so expiry is testable without waiting. */
	readonly now?: () => number;
	/**
	 * R1 (D-121): how long a finished agent task is kept (`TTK_AGENT_TASK_RETENTION_S`), which bounds how long its
	 * node record is worth keeping. Defaults to the runtime's own default.
	 */
	readonly taskRetentionMs?: number;
}

/**
 * ERRATUM(E-99). Design §2.9 set the record's `expireIn` to the task retention alone; retention counts from a task's
 * *finish*, so a record written at creation would expire while a long task still ran or was still retained.
 *
 * R1 (D-121): the longest a task can exist before it finishes — the ceiling of `TTK_AGENT_TASK_TIMEOUT_S` (24 h,
 * beyond any single tool task's own bound) plus the two minutes a task may wait for a slot. A task's node record is
 * kept for this plus the retention, so it outlives the task it points at. Outliving it is harmless (the node answers
 * "not found"); expiring first would only send a late lookup to the local node, which answers the same.
 */
const TASK_RUN_CEILING_MS = 86_400_000 + 120_000;
/** The agent runtime's default retention (`TASK_RETENTION_MS` in `@tykotech/agents`, `TTK_AGENT_TASK_RETENTION_S`). */
const DEFAULT_TASK_RETENTION_MS = 86_400_000;

/** Attempts, and the backoff between them, for a write that hit a locked store. */
const LOCK_RETRIES = 12;
const LOCK_BACKOFF_MS = 15;

/** True when an error is the store telling us to try again, not to give up. */
function isLockContention(cause: unknown): boolean {
	const message = cause instanceof Error ? cause.message : String(cause);
	return /database is locked|database table is locked|busy/i.test(message);
}

/**
 * Runs a store write, retrying while the store reports contention.
 *
 * Bounded and jittered: unbounded retries would turn a genuinely wedged store
 * into a hang, and a fixed delay would have every contending node wake at the
 * same instant and collide again.
 */
export async function withLockRetry<T>(work: () => Promise<T>): Promise<T> {
	for (let attempt = 0;; attempt++) {
		try {
			return await work();
		} catch (cause) {
			if (attempt >= LOCK_RETRIES || !isLockContention(cause)) throw cause;
			const delay = LOCK_BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * LOCK_BACKOFF_MS);
			// Deliberately *not* unref'd. This timer is the continuation of work a
			// caller is awaiting, so a runtime that let the loop drain while it was
			// pending would leave that caller hanging forever — which is what an
			// unref'd version of this did, and what the op sanitizer reported as
			// "Promise resolution is still pending but the event loop has already
			// resolved". The heartbeat interval is unref'd; this is not the same
			// kind of timer.
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

/** True when a role is allowed to host browser sessions. */
export function canHostSessions(role: NodeRole): boolean {
	return role === 'all' || role === 'browser';
}

/**
 * This node's membership and the shared session index.
 */
export class Cluster {
	readonly #kv: Deno.Kv;
	readonly #options: ClusterOptions;
	readonly #now: () => number;
	#heartbeat: ReturnType<typeof setInterval> | null = null;
	#closed = false;

	private constructor(kv: Deno.Kv, options: ClusterOptions) {
		this.#kv = kv;
		this.#options = options;
		this.#now = options.now ?? (() => Date.now());
	}

	/**
	 * Opens the shared store and registers this node.
	 *
	 * @throws when the runtime was not started with `--unstable-kv`, with the
	 * flag named — a cluster that silently degraded to single-node would be a
	 * much worse failure than one that refuses to start.
	 */
	/** D-084: the shared store, for the account and sign-in replicas (`KvReplica`). */
	get kv(): Deno.Kv {
		return this.#kv;
	}

	static async open(options: ClusterOptions): Promise<Cluster> {
		if (typeof Deno.openKv !== 'function') {
			throw new Error(
				'clustering needs Deno KV: start the server with --unstable-kv (see `deno task serve:cluster`)',
			);
		}
		if (canHostSessions(options.role) && options.nodeUrl.trim() === '') {
			throw new Error(`a ${options.role} node must set TTK_NODE_URL so its peers can reach it`);
		}
		const kv = await Deno.openKv(options.kvPath);
		const cluster = new Cluster(kv, options);
		await cluster.#register();
		cluster.#heartbeat = setInterval(() => void cluster.#register().catch(() => {}), HEARTBEAT_MS);
		// The heartbeat must never be the reason the process stays alive.
		Deno.unrefTimer(cluster.#heartbeat);
		options.logger.info(`cluster: node ${options.nodeId} (${options.role}) joined at ${options.nodeUrl || '(no url)'}`);
		return cluster;
	}

	get self(): NodeInfo {
		return {
			id: this.#options.nodeId,
			url: this.#options.nodeUrl,
			role: this.#options.role,
			version: this.#options.version,
		};
	}

	get role(): NodeRole {
		return this.#options.role;
	}

	/** Publishes this node, with a TTL the heartbeat keeps refreshing. */
	async #register(): Promise<void> {
		if (this.#closed) return;
		await withLockRetry(() =>
			this.#kv.set(['ttk', 'nodes', this.#options.nodeId], {
				...this.self,
				at: this.#now(),
			}, { expireIn: NODE_TTL_MS })
		);
	}

	/** Every node currently registered, this one included. */
	async nodes(): Promise<NodeInfo[]> {
		const found: NodeInfo[] = [];
		for await (const entry of this.#kv.list<NodeInfo & { at: number }>({ prefix: ['ttk', 'nodes'] })) {
			if (entry.value === null) continue;
			found.push({ id: entry.value.id, url: entry.value.url, role: entry.value.role, version: entry.value.version });
		}
		return found;
	}

	/** The node that owns `sessionId`, or `null` when nobody does. */
	async ownerOf(sessionId: string): Promise<NodeInfo | null> {
		const entry = await this.#kv.get<{ nodeId: string }>(['ttk', 'sessions', sessionId]);
		if (entry.value === null) return null;
		const nodeId = entry.value.nodeId;
		if (nodeId === this.#options.nodeId) return this.self;
		const node = await this.#kv.get<NodeInfo>(['ttk', 'nodes', nodeId]);
		if (node.value === null) {
			// The owner is gone. Its sessions died with it, so the claim is stale
			// and is cleared rather than left to route requests into a void.
			await withLockRetry(() => this.#kv.delete(['ttk', 'sessions', sessionId])).catch(() => {});
			return null;
		}
		return node.value;
	}

	/**
	 * Claims `sessionId` for this node if nobody holds it.
	 *
	 * Atomic on purpose. The implicit `default` session is the contended case:
	 * two nodes receiving a first call at the same moment would otherwise each
	 * launch a browser and each believe it was *the* default, and a client would
	 * see a different page depending on which node its next request landed on.
	 *
	 * @returns the winner — this node when the claim succeeded, the existing
	 * owner when it did not.
	 */
	async claim(sessionId: string): Promise<NodeInfo | null> {
		if (!canHostSessions(this.#options.role)) return await this.ownerOf(sessionId);
		const result = await withLockRetry(() =>
			this.#kv.atomic()
				.check({ key: ['ttk', 'sessions', sessionId], versionstamp: null })
				.set(['ttk', 'sessions', sessionId], { nodeId: this.#options.nodeId, at: this.#now() })
				.commit()
		);
		if (result.ok) return this.self;
		return await this.ownerOf(sessionId);
	}

	/** Records this node as the owner, whoever held it before. */
	async adopt(sessionId: string): Promise<void> {
		if (!canHostSessions(this.#options.role)) return;
		await withLockRetry(() =>
			this.#kv.set(['ttk', 'sessions', sessionId], { nodeId: this.#options.nodeId, at: this.#now() })
		);
	}

	/** Drops a claim this node holds. */
	async release(sessionId: string): Promise<void> {
		const entry = await this.#kv.get<{ nodeId: string }>(['ttk', 'sessions', sessionId]);
		if (entry.value?.nodeId !== this.#options.nodeId) return;
		await withLockRetry(() => this.#kv.delete(['ttk', 'sessions', sessionId]));
	}

	/**
	 * R1 (D-121): records that an agent task lives on this node, so `agent_get_task` and `agent_cancel_task` reach it
	 * from any node. A task's file (`agents/tasks.json`) is node-local by design (G8), so its id is the only thing a
	 * peer can route by. Any role records: an edge node runs tasks whose tool needs no browser.
	 */
	async recordTask(taskId: string): Promise<void> {
		await withLockRetry(() =>
			this.#kv.set(['ttk', 'tasks', taskId], { nodeId: this.#options.nodeId, at: this.#now() }, {
				expireIn: (this.#options.taskRetentionMs ?? DEFAULT_TASK_RETENTION_MS) + TASK_RUN_CEILING_MS,
			})
		);
	}

	/**
	 * R1 (D-121): the node holding `taskId`, or `null` when no node recorded it or the recorded node is not registered
	 * right now. Unlike a session claim, a stale task record is **not** cleared: with a data directory the task
	 * survives its node's restart (B1), so the record becomes right again when the node rejoins under the same id.
	 */
	async taskNode(taskId: string): Promise<NodeInfo | null> {
		const entry = await this.#kv.get<{ nodeId: string }>(['ttk', 'tasks', taskId]);
		if (entry.value === null) return null;
		if (entry.value.nodeId === this.#options.nodeId) return this.self;
		const node = await this.#kv.get<NodeInfo>(['ttk', 'nodes', entry.value.nodeId]);
		return node.value;
	}

	/** Every claimed session and the node holding it. */
	async sessions(): Promise<Array<{ sessionId: string; nodeId: string }>> {
		const found: Array<{ sessionId: string; nodeId: string }> = [];
		for await (const entry of this.#kv.list<{ nodeId: string }>({ prefix: ['ttk', 'sessions'] })) {
			const sessionId = entry.key[entry.key.length - 1];
			if (typeof sessionId !== 'string' || entry.value === null) continue;
			found.push({ sessionId, nodeId: entry.value.nodeId });
		}
		return found;
	}

	/**
	 * Picks a node to create a new session on.
	 *
	 * This node first when it can host one — work that can stay local should,
	 * because a proxied request pays a hop for nothing. Otherwise the least
	 * loaded peer, counting claimed sessions, which is the only load signal the
	 * shared store actually has.
	 */
	async pickHost(): Promise<NodeInfo | null> {
		if (canHostSessions(this.#options.role)) return this.self;
		const candidates = (await this.nodes()).filter((node) => canHostSessions(node.role) && node.url !== '');
		if (candidates.length === 0) return null;
		const load = new Map<string, number>();
		for (const { nodeId } of await this.sessions()) load.set(nodeId, (load.get(nodeId) ?? 0) + 1);
		return candidates.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0] ?? null;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#heartbeat !== null) {
			clearInterval(this.#heartbeat);
			this.#heartbeat = null;
		}
		// Deregister rather than waiting for the TTL: a clean shutdown should not
		// leave peers routing to a process that has exited.
		await this.#kv.delete(['ttk', 'nodes', this.#options.nodeId]).catch(() => {});
		for (const { sessionId, nodeId } of await this.sessions().catch(() => [])) {
			if (nodeId === this.#options.nodeId) await this.#kv.delete(['ttk', 'sessions', sessionId]).catch(() => {});
		}
		this.#kv.close();
	}
}
