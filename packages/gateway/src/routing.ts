/**
 * Deciding which node serves an MCP request (R10/R12).
 *
 * The decision is made from the *parsed* JSON-RPC body, before anything
 * touches a browser, because by the time a tool handler runs it is already on
 * the wrong machine. Everything here is pure apart from the store lookups, so
 * the policy can be tested without a cluster.
 */
import { CATALOG_BY_NAME, parseFileResourceUri } from '@tykotech/mcp';
import { canHostSessions, type Cluster, FORWARDED_HEADER, type NodeInfo } from './cluster.ts';

/** Where a request should be served. */
export type Route =
	/** Serve it here. */
	| { kind: 'local' }
	/** Forward it verbatim to another node. */
	| { kind: 'forward'; node: NodeInfo; reason: string }
	/** Answer it by merging every node's answer — sessions, or (R1, D-121) agent tasks. */
	| { kind: 'fan-out'; nodes: NodeInfo[]; list: FanOutList }
	/**
	 * Review R3-5 (D-121): a task id no node has recorded — yet, or ever. Serve it here; when this node does not hold
	 * the task, ask the others and answer with the first that does ({@linkcode firstFound}).
	 */
	| { kind: 'find'; nodes: NodeInfo[] }
	/** Refuse it, with a reason the caller can act on. */
	| { kind: 'refuse'; detail: string };

/** What a fan-out merges: `browser_list_sessions`' sessions, or `agent_list_tasks`' tasks (R1, D-121). */
export type FanOutList = 'sessions' | 'tasks';

/**
 * R1 (D-121): the task tools routed by the task id rather than by a session. A task lives in one node's runtime and
 * its `agents/tasks.json` (node-local by design), so the node that recorded it (`Cluster.recordTask`) answers.
 */
const TASK_ID_TOOLS = new Set(['agent_get_task', 'agent_cancel_task']);

/** The shape of the JSON-RPC messages routing cares about. */
interface ToolCall {
	method?: unknown;
	params?: { name?: unknown; arguments?: Record<string, unknown>; uri?: unknown };
}

/**
 * Tools that only *look at* a session and must never cause one to exist (E-33).
 *
 * The file tools use `peek` semantics: an unowned `default` is an unknown
 * session, not an invitation to launch a browser somewhere and answer with its
 * empty file list.
 */
const PEEK_TOOLS = new Set(['browser_list_files', 'browser_get_file']);

/** The first message of a body, which is what a batch is judged by. */
function firstMessage(parsedBody: unknown): ToolCall | undefined {
	if (Array.isArray(parsedBody)) return parsedBody[0] as ToolCall | undefined;
	if (parsedBody === null || typeof parsedBody !== 'object') return undefined;
	return parsedBody as ToolCall;
}

/**
 * Tools whose answer is about the *cluster*, not about one session.
 *
 * `browser_list_sessions` is the only one: a caller asking what sessions exist
 * means all of them, and answering with just this node's would be quietly
 * wrong in a way nothing else would reveal.
 */
const FAN_OUT_TOOLS = new Set(['browser_list_sessions']);

/**
 * Tools that act on every session this node holds and are therefore local by
 * definition — fanning `browser_close_all` out would let one caller close
 * another operator's browsers on a node they never addressed.
 */
const NODE_LOCAL_TOOLS = new Set(['browser_close_all']);

export interface RouterDeps {
	readonly cluster: Cluster;
}

export class Router {
	readonly #cluster: Cluster;

	constructor(deps: RouterDeps) {
		this.#cluster = deps.cluster;
	}

	/**
	 * Decides where a request belongs.
	 *
	 * `alreadyForwarded` short-circuits everything: a request that has been
	 * forwarded once is served here or fails, because a second hop means the
	 * cluster's view of ownership is inconsistent and bouncing the request
	 * between two nodes would turn that into an infinite loop.
	 */
	async route(parsedBody: unknown, alreadyForwarded: boolean): Promise<Route> {
		if (alreadyForwarded) return { kind: 'local' };

		const message = firstMessage(parsedBody);

		// E-33: a file resource lives on the node that holds the session's download
		// directory. It is the one `resources/*` request whose answer differs per
		// node, so it alone is routed to the owner; an unknown owner is answered
		// here as "no such session", never by placing one.
		if (message?.method === 'resources/read') {
			const parsed = typeof message.params?.uri === 'string' ? parseFileResourceUri(message.params.uri) : null;
			if (parsed === null) return { kind: 'local' };
			const owner = await this.#cluster.ownerOf(parsed.sessionId);
			if (owner === null || owner.id === this.#cluster.self.id) return { kind: 'local' };
			return { kind: 'forward', node: owner, reason: `file resource of session ${parsed.sessionId}` };
		}

		// Everything else that is not a tool call — initialize, tools/list,
		// resources/list, server/discover — describes the *server*, which every node
		// answers identically. Forwarding those would add a hop for nothing.
		if (message?.method !== 'tools/call') return { kind: 'local' };

		const name = typeof message.params?.name === 'string' ? message.params.name : '';
		if (NODE_LOCAL_TOOLS.has(name)) return { kind: 'local' };
		if (FAN_OUT_TOOLS.has(name)) return { kind: 'fan-out', nodes: await this.#cluster.nodes(), list: 'sessions' };

		const args = message.params?.arguments ?? {};

		// R1 (D-121): a caller's tasks are spread over the nodes that ran them, so the list asks every node; a task id
		// goes to the node that recorded it. Review R3-5: one nobody recorded is looked for — the record is written after
		// the task is created, so a get from another entrance node can race it, and a failed write must not orphan a
		// task. This node answers when it holds the task, and asks the others only when it does not.
		if (name === 'agent_list_tasks') return { kind: 'fan-out', nodes: await this.#cluster.nodes(), list: 'tasks' };
		if (TASK_ID_TOOLS.has(name)) {
			const taskId = typeof args.task_id === 'string' ? args.task_id : '';
			if (taskId === '') return { kind: 'local' };
			const holder = await this.#cluster.taskNode(taskId);
			if (holder === null) return { kind: 'find', nodes: await this.#cluster.nodes() };
			if (holder.id === this.#cluster.self.id) return { kind: 'local' };
			return { kind: 'forward', node: holder, reason: `task ${taskId}` };
		}
		// R1 (D-121): a browser tool run as a task must run where its session lives, so the task is routed exactly as
		// the call itself would be. Anything else (a sandbox or library tool, an unknown name the handler will refuse)
		// is served here, as every non-session extension tool is.
		if (name === 'agent_run_tool') {
			const tool = typeof args.tool === 'string' ? args.tool : '';
			const inner = args.arguments !== null && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
				? args.arguments as Record<string, unknown>
				: {};
			if (!CATALOG_BY_NAME.has(tool) || FAN_OUT_TOOLS.has(tool) || NODE_LOCAL_TOOLS.has(tool)) return { kind: 'local' };
			return await this.#bySession(tool, inner);
		}
		return await this.#bySession(name, args);
	}

	/** Where a call naming a session — explicitly, by omission, or by asking for a new one — belongs. */
	async #bySession(name: string, args: Record<string, unknown>): Promise<Route> {
		// A creation request has no session to route by, so it is placed.
		if (args.new_session === true) {
			const host = await this.#cluster.pickHost();
			if (host === null) {
				return { kind: 'refuse', detail: 'no node in the cluster can host a browser session' };
			}
			return host.id === this.#cluster.self.id
				? { kind: 'local' }
				: { kind: 'forward', node: host, reason: 'placing a new session' };
		}

		// Everything else names a session — explicitly, or by omission.
		const sessionId = typeof args.session_id === 'string' && args.session_id !== '' ? args.session_id : 'default';
		const owner = await this.#cluster.ownerOf(sessionId);
		if (owner !== null) {
			return owner.id === this.#cluster.self.id
				? { kind: 'local' }
				: { kind: 'forward', node: owner, reason: `session ${sessionId}` };
		}

		// Unowned. Only the implicit `default` session is created this way, and only
		// by a tool that would create it locally too; an explicit id nobody owns,
		// or a peek-only tool, is an unknown session, and the local handler says
		// so in the error convention the caller already understands.
		const creates = sessionId === 'default' && CATALOG_BY_NAME.has(name) && !PEEK_TOOLS.has(name);
		if (!creates) return { kind: 'local' };

		// A node that can host claims the session before creating it, so two
		// nodes racing on a first call cannot each launch a browser and each
		// believe it is *the* default one.
		if (canHostSessions(this.#cluster.self.role)) {
			const winner = await this.#cluster.claim(sessionId);
			if (winner === null) {
				return { kind: 'refuse', detail: 'no node in the cluster can host a browser session' };
			}
			return winner.id === this.#cluster.self.id
				? { kind: 'local' }
				: { kind: 'forward', node: winner, reason: `session ${sessionId} was claimed by another node` };
		}

		// A node that cannot host places the work instead, and the node that
		// receives it claims the session when it creates it. Claiming from here
		// would record an owner that is about to be wrong if the forward fails.
		const host = await this.#cluster.pickHost();
		if (host === null) {
			return { kind: 'refuse', detail: 'no node in the cluster can host a browser session' };
		}
		return { kind: 'forward', node: host, reason: `placing session ${sessionId}` };
	}
}

/**
 * Forwards a request to another node.
 *
 * The caller's own `Authorization` header goes with it, so the owning node
 * decides authorization with the same key store rather than trusting a
 * machine-to-machine secret that would let any node act as any principal.
 *
 * `path` defaults to the MCP mount; the session-file route (E-33) forwards its
 * own path and query. The target host is always the *registered* node URL,
 * never anything a client supplied.
 */
export async function forward(
	node: NodeInfo,
	request: Request,
	body: string,
	selfId: string,
	path = '/mcp',
	/**
	 * Builds the failure response when the owner cannot be reached.
	 *
	 * Defaults to a JSON-RPC error envelope, which is right for `/mcp` and wrong
	 * everywhere else: a REST or `text/event-stream` route answering with
	 * `{jsonrpc, error}` under `content-type: application/json` gives its caller
	 * a body it has no parser for. A REST caller passes a `problemResponse`
	 * instead.
	 */
	onUnreachable?: (cause: unknown) => Response,
): Promise<Response> {
	const headers = new Headers(request.headers);
	headers.set(FORWARDED_HEADER, selfId);
	// Hop-by-hop headers must not be copied onto a new request.
	for (const header of ['host', 'connection', 'content-length', 'transfer-encoding']) headers.delete(header);

	const target = new URL(path, node.url);
	try {
		const response = await fetch(target, { method: request.method, headers, body: body === '' ? null : body });
		// The response is streamed back untouched: an SSE tool result must reach
		// the client as it is produced, not after this node has buffered it.
		const out = new Headers(response.headers);
		out.set('x-ttk-served-by', node.id);
		return new Response(response.body, { status: response.status, headers: out });
	} catch (cause) {
		if (onUnreachable !== undefined) return onUnreachable(cause);
		return new Response(
			JSON.stringify({
				jsonrpc: '2.0',
				id: null,
				error: {
					code: -32_000,
					message: `the node holding this session is unreachable: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				},
			}),
			{ status: 502, headers: { 'content-type': 'application/json' } },
		);
	}
}

/**
 * Answers `browser_list_sessions` by asking every node.
 *
 * The *local* answer is served first and then reshaped, rather than a fresh
 * JSON-RPC envelope being synthesized around the merged list. That is not
 * fastidiousness: the envelope carries era-dependent fields the SDK requires
 * (`resultType` on 2026-07-28, and whatever a later revision adds), and a
 * hand-built one is wrong the day the protocol moves. Merging into the real
 * one inherits all of it.
 *
 * A node that does not answer is *reported*, not dropped: "these are the
 * sessions" is a different statement from "these are the sessions I could
 * reach", and a caller deciding whether to start a new one needs to know which
 * it is holding.
 */
export async function fanOut(
	nodes: readonly NodeInfo[],
	request: Request,
	body: string,
	self: NodeInfo,
	serveLocally: () => Promise<Response>,
	/**
	 * R1 (D-121): what the answers carry. `tasks` merges `agent_list_tasks`' `result.tasks` (each tagged `node_id`)
	 * and ORs `result.truncated`; every node applies the caller's `limit` to its own tasks, so the merged list holds
	 * up to `limit` per node, each node's slice newest first.
	 */
	list: FanOutList = 'sessions',
): Promise<Response> {
	const local = await serveLocally();
	// Read once and kept, so an answer that cannot be merged is passed through intact rather than as a used body.
	const localText = await local.text();
	const envelope = envelopeOfText(localText);
	// Not something we can merge into — or, for tasks, a refusal (no scope, no runtime) — so it passes through.
	if (envelope === null || (list === 'tasks' && isErrorResult(envelope))) {
		return new Response(localText, { status: local.status, headers: local.headers });
	}

	const items: Array<Record<string, unknown>> = itemsIn(envelope, list).map((item) => tagged(item, self, list));
	const unreachable: string[] = [];
	let truncated = truncatedIn(envelope);

	await Promise.all(
		nodes.filter((node) => node.id !== self.id).map(async (node) => {
			try {
				const response = await forward(node, request, body, self.id);
				if (!response.ok) {
					unreachable.push(node.id);
					await response.body?.cancel();
					return;
				}
				const remote = await envelopeOf(response);
				// A node that answered with an error has not told us its tasks: it is reported, not silently empty.
				if (remote === null || (list === 'tasks' && isErrorResult(remote))) {
					unreachable.push(node.id);
					return;
				}
				for (const item of itemsIn(remote, list)) items.push(tagged(item, node, list));
				truncated ||= truncatedIn(remote);
			} catch {
				unreachable.push(node.id);
			}
		}),
	);

	const unreached = unreachable.length > 0 ? { unreachable_nodes: unreachable.sort() } : {};
	// `browser_list_sessions` answers at the top level; an extension tool keeps the D-064 `{ result }` envelope, and
	// its output schema declares `unreachable_nodes` inside it.
	const payload: Record<string, unknown> = list === 'sessions'
		? { sessions: items, ...unreached }
		: { result: { tasks: items, truncated, ...unreached } };

	// Same envelope, same result shape, merged content.
	const result = envelope.result as Record<string, unknown>;
	result.structuredContent = payload;
	result.content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];

	return new Response(JSON.stringify(envelope), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Review R3-5 (D-121): answers `agent_get_task` / `agent_cancel_task` for a task id no node has recorded.
 *
 * This node is asked first, and its answer stands unless it is a tool error — the "not found" a runtime gives for an
 * id it does not hold. Then every other node is asked at once, each hop carrying the caller's own `Authorization`
 * (so each node applies its own owner isolation), and the first answer that is not an error is the answer: a task id
 * is a random UUID that one runtime holds, so at most one node can know it. When none does, the local answer is
 * returned intact. A cancel asked of a node that does not hold the task changes nothing there.
 */
export async function firstFound(
	nodes: readonly NodeInfo[],
	request: Request,
	body: string,
	self: NodeInfo,
	serveLocally: () => Promise<Response>,
): Promise<Response> {
	const local = await serveLocally();
	const localText = await local.text();
	const envelope = envelopeOfText(localText);
	const answerLocally = () => new Response(localText, { status: local.status, headers: local.headers });
	if (envelope === null || !isErrorResult(envelope)) return answerLocally();

	const others = nodes.filter((node) => node.id !== self.id);
	const answers = await Promise.all(others.map(async (node): Promise<Response | null> => {
		try {
			// `forward` reads the request's method and headers only; the body goes as `body`, already read once.
			const response = await forward(node, request, body, self.id);
			const text = await response.text();
			const remote = response.ok ? envelopeOfText(text) : null;
			if (remote === null || isErrorResult(remote)) return null;
			return new Response(text, { status: response.status, headers: response.headers });
		} catch {
			return null;
		}
	}));
	return answers.find((answer) => answer !== null) ?? answerLocally();
}

/** One node's item, tagged with where it lives: sessions carry the node's URL too (the live view connects there). */
function tagged(item: Record<string, unknown>, node: NodeInfo, list: FanOutList): Record<string, unknown> {
	return list === 'sessions' ? { ...item, node_id: node.id, node_url: node.url } : { ...item, node_id: node.id };
}

/** Whether a JSON-RPC envelope carries a tool failure (`isError: true`). */
function isErrorResult(envelope: { result?: unknown }): boolean {
	return (envelope.result as { isError?: unknown }).isError === true;
}

/** R1 (D-121): `agent_list_tasks`' `result.truncated` in one node's answer. */
function truncatedIn(envelope: { result?: unknown }): boolean {
	const structured = (envelope.result as { structuredContent?: { result?: { truncated?: unknown } } })
		.structuredContent;
	return structured?.result?.truncated === true;
}

/** The JSON-RPC envelope of a response, whether it arrived as JSON or as SSE. */
async function envelopeOf(response: Response): Promise<{ result?: unknown } & Record<string, unknown> | null> {
	return envelopeOfText(await response.text());
}

/** {@linkcode envelopeOf} on text already read. */
function envelopeOfText(raw: string): { result?: unknown } & Record<string, unknown> | null {
	// An SSE response carries the same envelope, split across `data:` lines.
	const json = raw.includes('data:')
		? raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
		: raw;
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		if (parsed === null || typeof parsed !== 'object' || parsed.result === undefined) return null;
		if (typeof parsed.result !== 'object' || parsed.result === null) return null;
		return parsed as { result?: unknown } & Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * The items inside one node's answer: `browser_list_sessions`' top-level `sessions`, or (R1) `agent_list_tasks`'
 * `result.tasks`. The structured content is preferred; the text block is the fallback a 2025 client also reads.
 */
function itemsIn(envelope: { result?: unknown }, list: FanOutList): Array<Record<string, unknown>> {
	const result = envelope.result as {
		structuredContent?: Record<string, unknown>;
		content?: Array<{ type: string; text?: string }>;
	};
	const pick = (payload: Record<string, unknown> | undefined): unknown =>
		list === 'sessions' ? payload?.sessions : (payload?.result as Record<string, unknown> | undefined)?.tasks;
	const structured = pick(result.structuredContent);
	if (Array.isArray(structured)) return structured as Array<Record<string, unknown>>;
	try {
		const text = result.content?.find((block) => block.type === 'text')?.text ?? '{}';
		const parsed = pick(JSON.parse(text) as Record<string, unknown>);
		return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
	} catch {
		return [];
	}
}

export { canHostSessions };
