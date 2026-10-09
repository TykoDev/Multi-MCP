import { AcpClient, type AcpCommand, AUTH_REQUIRED } from './acp.ts';
import { AgentError, EventQueue, identifier, lines, object, readJson, serviceUrl } from './util.ts';

/** The private TykoTech HTTP bridge is not an ACP transport binding. */
export interface AgentBridgeOptions {
	url: string;
	token: string;
	agent: string;
	/** E-2: the ACP auth method the operator chose (`TTK_AGENT_AUTH_METHOD`), used when the agent advertises it. */
	authMethod?: string;
}

interface Connection {
	id: string;
	owner: string;
	client: AcpClient;
	command: AcpCommand;
	events: EventQueue;
	permissions: Map<string, { resolve: (value: Record<string, unknown>) => void; params: Record<string, unknown> }>;
	lastUsed: number;
	streaming: boolean;
	/** Bridge requests currently being served for this connection, a running prompt included. */
	inflight: number;
	closing?: Promise<void>;
}

/** Runner liveness timings; the defaults are production values and tests shorten them. */
export interface AgentBridgeTimings {
	/** A connection with no consumer, no request in flight and no traffic for this long is reaped. */
	idleMs?: number;
	reapIntervalMs?: number;
	/** Blank keepalive lines let a vanished event consumer surface as a failed write, and so be dropped. */
	heartbeatMs?: number;
}

/** Longest single ACP request a bridge caller may ask the runner to wait for. */
const MAX_REQUEST_MS = 3_600_000;

/** Private runner service; caller-selected executable paths and environment are never accepted. */
export class AgentBridgeServer {
	#connections = new Map<string, Connection>();
	#commands = new Map<string, AcpCommand>();
	#reaper: ReturnType<typeof setInterval>;
	#heartbeatMs: number;
	#closed = false;
	#closing = new Set<Promise<void>>();
	constructor(commands: readonly AcpCommand[], private readonly token: string, timings: AgentBridgeTimings = {}) {
		if (token.length < 24 || /[\r\n]/.test(token)) throw new Error('Bridge token must contain at least 24 characters');
		for (const command of commands) {
			if (this.#commands.has(command.id)) throw new Error('Duplicate configured agent');
			this.#commands.set(identifier(command.id), command);
		}
		const idleMs = timings.idleMs ?? 300_000;
		this.#heartbeatMs = timings.heartbeatMs ?? 15_000;
		this.#reaper = setInterval(() => {
			for (const connection of this.#connections.values()) {
				// AG-4: an attached event stream or a request still being served is use, even when no new HTTP
				// request has arrived; reaping on request time alone killed agents mid-turn under a live consumer.
				if (connection.streaming || connection.inflight) continue;
				if (Date.now() - connection.lastUsed > idleMs) void this.#drop(connection);
			}
		}, timings.reapIntervalMs ?? 30_000);
		Deno.unrefTimer(this.#reaper as unknown as number);
	}

	#drop(connection: Connection): Promise<void> {
		if (connection.closing) return connection.closing;
		const closing = (async (): Promise<void> => {
			this.#connections.delete(connection.id);
			connection.events.close();
			for (const permission of connection.permissions.values()) {
				permission.resolve({ outcome: { outcome: 'cancelled' } });
			}
			connection.permissions.clear();
			await connection.client.close();
		})();
		connection.closing = closing;
		this.#closing.add(closing);
		void closing.finally(() => this.#closing.delete(closing));
		return closing;
	}

	async #authenticated(request: Request): Promise<boolean> {
		const value = request.headers.get('authorization') ?? '';
		const digest = async (text: string): Promise<Uint8Array> =>
			new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
		const [a, b] = await Promise.all([digest(value), digest(`Bearer ${this.token}`)]);
		let different = 0;
		for (let index = 0; index < a.length; index++) different |= a[index]! ^ b[index]!;
		return different === 0;
	}

	/** The health response reveals no paths, secrets, or subprocess diagnostics. */
	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === '/healthz') {
			return Response.json({ ready: !this.#closed && this.#commands.size > 0 }, {
				status: this.#closed || !this.#commands.size ? 503 : 200,
			});
		}
		if (!await this.#authenticated(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
		try {
			if (this.#closed) throw new AgentError(-32603, 'Runner is shutting down');
			const owner = identifier(request.headers.get('x-ttk-principal'));
			if (path === '/v1/open' && request.method === 'POST') {
				const args = object(await readJson(request.body));
				// AG-13: close() snapshots the connections while this body is still arriving; a connection created
				// after that snapshot would outlive the runner's shutdown.
				if (this.#closed) throw new AgentError(-32603, 'Runner is shutting down');
				const command = this.#commands.get(identifier(args.agent));
				if (!command) throw new AgentError(-32602, 'Configured agent not found');
				if (
					this.#connections.size >= 16 || [...this.#connections.values()].filter((c) => c.owner === owner).length >= 4
				) {
					throw new AgentError(-32603, 'Runner connection limit reached');
				}
				const id = crypto.randomUUID();
				const events = new EventQueue();
				const permissions: Connection['permissions'] = new Map();
				const client = new AcpClient(command, {
					update: (params): void => {
						events.push({ jsonrpc: '2.0', method: 'session/update', params });
					},
					permission: (params, signal): Promise<Record<string, unknown>> => {
						const permissionId = crypto.randomUUID();
						return new Promise((resolve) => {
							const settle = (value: Record<string, unknown>): void => {
								permissions.delete(permissionId);
								resolve(value);
							};
							permissions.set(permissionId, { resolve: settle, params });
							signal.addEventListener('abort', () => {
								settle({ outcome: { outcome: 'cancelled' } });
								events.push({ method: 'permission/expired', params: { id: permissionId } });
							}, { once: true });
							events.push({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params });
						});
					},
				});
				this.#connections.set(id, {
					id,
					owner,
					client,
					command,
					events,
					permissions,
					lastUsed: Date.now(),
					streaming: false,
					inflight: 0,
				});
				return Response.json({ connectionId: id, cwd: command.cwd });
			}
			const id = identifier(request.headers.get('x-ttk-connection'));
			const connection = this.#connections.get(id);
			if (!connection || connection.owner !== owner) throw new AgentError(-32001, 'Connection not found');
			connection.lastUsed = Date.now();
			connection.inflight++;
			try {
				return await this.#route(connection, path, request);
			} finally {
				connection.inflight--;
				connection.lastUsed = Date.now();
			}
		} catch (error) {
			const known = error instanceof AgentError;
			return Response.json({
				error: { code: known ? error.code : -32603, message: known ? error.message : 'Runner operation failed' },
			}, { status: known && error.code === -32001 ? 404 : 400 });
		}
	}

	/** Owner-checked operations on one open connection. */
	async #route(connection: Connection, path: string, request: Request): Promise<Response> {
		if (path === '/v1/events' && request.method === 'GET') {
			if (connection.streaming) throw new AgentError(-32600, 'Event consumer already attached');
			connection.streaming = true;
			const heartbeatMs = this.#heartbeatMs;
			let next: Promise<Record<string, unknown> | undefined> | undefined;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller): Promise<void> {
						// One queue read stays outstanding across keepalives, so no event is consumed twice or lost.
						next ??= connection.events.next();
						let timer: ReturnType<typeof setTimeout> | undefined;
						const beat = new Promise<'beat'>((resolve) => timer = setTimeout(() => resolve('beat'), heartbeatMs));
						const event = await Promise.race([next, beat]).finally(() => clearTimeout(timer));
						if (event === 'beat') {
							controller.enqueue(new TextEncoder().encode('\n'));
							return;
						}
						next = undefined;
						if (event) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
						else {
							// A closed queue leaves no consumer to protect the connection from the idle reaper.
							connection.streaming = false;
							connection.lastUsed = Date.now();
							controller.close();
						}
					},
					cancel: (): Promise<void> => this.#drop(connection),
				}),
				{ headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } },
			);
		}
		if (path === '/v1/close' && request.method === 'POST') {
			await this.#drop(connection);
			return Response.json({ closed: true });
		}
		if (path === '/v1/permission' && request.method === 'POST') {
			const args = object(await readJson(request.body));
			const permissionId = identifier(args.id);
			const permission = connection.permissions.get(permissionId);
			if (!permission) throw new AgentError(-32602, 'Permission request is no longer pending');
			const result = object(args.result);
			const outcome = object(result.outcome);
			if (outcome.outcome !== 'cancelled') {
				const options = Array.isArray(permission.params.options) ? permission.params.options.map(object) : [];
				if (
					outcome.outcome !== 'selected' ||
					!options.some((option) =>
						option.optionId === outcome.optionId && ['allow_once', 'reject_once'].includes(String(option.kind))
					)
				) {
					throw new AgentError(-32602, 'Permission option not allowed');
				}
			}
			permission.resolve(result);
			return Response.json({ resolved: true });
		}
		if (path === '/v1/rpc' && request.method === 'POST') {
			const args = object(await readJson(request.body));
			const method = identifier(args.method);
			const params = object(args.params ?? {});
			if (
				args.timeoutMs !== undefined &&
				(!Number.isInteger(args.timeoutMs) || Number(args.timeoutMs) < 1 || Number(args.timeoutMs) > MAX_REQUEST_MS)
			) {
				throw new AgentError(-32602, 'Invalid request timeout');
			}
			if (method === 'session/cancel') {
				await connection.client.cancel(identifier(params.sessionId));
				return Response.json({});
			}
			if ((method === 'session/new' || method === 'session/load') && params.cwd !== connection.command.cwd) {
				throw new AgentError(-32602, 'Cwd is not the configured agent workspace');
			}
			const result = await connection.client.request(method, params, args.timeoutMs as number | undefined);
			if (method === 'session/prompt') {
				connection.events.push({ method: 'bridge/prompt_complete', params: { sessionId: params.sessionId } });
			}
			return Response.json(result);
		}
		return Response.json({ error: 'Not found' }, { status: 404 });
	}

	/** Close every process and pending permission request on service shutdown. */
	async close(): Promise<void> {
		this.#closed = true;
		clearInterval(this.#reaper);
		await Promise.all([...this.#connections.values()].map((connection) => this.#drop(connection)));
		await Promise.all([...this.#closing]);
	}
}

/** Owner-bound client for the private configured ACP bridge. */
export class AgentBridgeClient {
	#connection?: string;
	#cwd?: string;
	#closed = false;
	#opening?: Promise<void>;
	#closing?: Promise<void>;
	constructor(private readonly options: AgentBridgeOptions, private readonly owner: string) {
		serviceUrl(options.url);
		identifier(owner);
	}
	get cwd(): string {
		if (!this.#cwd) throw new AgentError(-32600, 'Bridge connection not open');
		return this.#cwd;
	}
	async #fetch(path: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		const url = serviceUrl(this.options.url);
		url.pathname = path;
		const response = await fetch(url, {
			method: args ? 'POST' : 'GET',
			redirect: 'error',
			headers: {
				authorization: `Bearer ${this.options.token}`,
				'content-type': 'application/json',
				'x-ttk-principal': this.owner,
				...(this.#connection ? { 'x-ttk-connection': this.#connection } : {}),
			},
			...(args ? { body: JSON.stringify(args) } : {}),
			signal: signal ?? AbortSignal.timeout(125_000),
		});
		if (!response.ok) {
			// E-2: the runner's error body is read only for the one code the runtime acts on; the rest stays opaque.
			let code = -32603;
			try {
				code = Number(object(object(await readJson(response.body, 4096)).error).code);
			} catch { /* Not a runner error body. */ }
			if (code === AUTH_REQUIRED) throw new AgentError(AUTH_REQUIRED, 'Agent requires authentication');
			throw new AgentError(-32603, 'Configured ACP bridge request failed');
		}
		return response;
	}
	/** Open one allowlisted backend; no caller-provided executable is transmitted. */
	async open(): Promise<void> {
		if (this.#opening || this.#connection || this.#closed) {
			throw new AgentError(-32600, 'Bridge connection already used');
		}
		this.#opening = (async (): Promise<void> => {
			const result = object(await readJson((await this.#fetch('/v1/open', { agent: this.options.agent })).body));
			this.#connection = identifier(result.connectionId);
			this.#cwd = identifier(result.cwd);
		})();
		await this.#opening;
		// AG-6: close() ran while the runner was still creating this connection; close() releases it once the
		// open settles, so the caller must not go on to use it.
		if (this.#closed) throw new AgentError(-32600, 'Bridge connection closed');
	}
	/**
	 * Bounded ACP baseline method exchange. `timeoutMs` overrides the runner's 120 s default for this one
	 * request, up to one hour; without a caller signal the HTTP wait follows it with a small margin.
	 */
	async request(
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<Record<string, unknown>> {
		if (!this.#connection || this.#closed) throw new AgentError(-32600, 'Bridge connection unavailable');
		const args = { method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
		const deadline = signal ?? AbortSignal.timeout((timeoutMs ?? 120_000) + 5_000);
		return object(await readJson((await this.#fetch('/v1/rpc', args, deadline)).body, 1024 * 1024));
	}
	/** Stream callbacks without turning a private connection into a shared session. */
	async *events(signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
		const response = await this.#fetch('/v1/events', undefined, signal);
		if (!response.body) throw new AgentError(-32603, 'Missing bridge event stream');
		for await (const line of lines(response.body)) yield object(JSON.parse(line));
	}
	/** Resolve only the current request and an advertised once-only option. */
	async permission(id: string, result: Record<string, unknown>): Promise<void> {
		await (await this.#fetch('/v1/permission', { id, result })).body?.cancel();
	}
	/** Closing also cancels the agent prompt in the runner by terminating its process. */
	close(): Promise<void> {
		this.#closed = true;
		// AG-6: a close racing open() must wait for the runner's answer; returning early left the connection the
		// open was creating, with its agent process and one of the owner's slots, to the idle reaper.
		this.#closing ??= (async (): Promise<void> => {
			await this.#opening?.catch(() => {});
			if (this.#connection) await (await this.#fetch('/v1/close', {})).body?.cancel();
		})().catch((error) => {
			this.#closing = undefined;
			throw error;
		});
		return this.#closing;
	}
}

/** An editor's permission answer becomes a currently offered once-only choice or a denial, never an error. */
function editorDecision(params: Record<string, unknown>, reply: Record<string, unknown>): Record<string, unknown> {
	try {
		const outcome = object(object(reply.result).outcome);
		const options = Array.isArray(params.options) ? params.options.map(object) : [];
		if (
			reply.error === undefined && outcome.outcome === 'selected' &&
			options.some((option) =>
				option.optionId === outcome.optionId && ['allow_once', 'reject_once'].includes(String(option.kind))
			)
		) return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
	} catch { /* A malformed editor reply is a denial, never consent. */ }
	return { outcome: { outcome: 'cancelled' } };
}

/**
 * A12 (D-107): the capabilities an editor is told about — the runner agent's own `loadSession` and prompt content
 * kinds, read as booleans and nothing else, instead of a hard-coded "none".
 *
 * Two stay off whatever the agent says. `mcpCapabilities` is empty because an editor's MCP servers would reach the
 * agent with static credentials, which the runner refuses (no editor delegation exists). `fs` and `terminal` are
 * client capabilities this proxy never offers the agent (a non-goal), so nothing here can turn them on either.
 * Content an agent accepts — an image, audio, an embedded resource — still travels inside the runner's body and
 * line bounds (512 KiB per bridge request, 1 MiB per ACP line).
 */
function editorCapabilities(advertised: unknown): Record<string, unknown> {
	const record = (value: unknown): Record<string, unknown> =>
		value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const agent = record(advertised);
	const prompt = record(agent.promptCapabilities);
	return {
		loadSession: agent.loadSession === true,
		promptCapabilities: {
			image: prompt.image === true,
			audio: prompt.audio === true,
			embeddedContext: prompt.embeddedContext === true,
		},
		mcpCapabilities: { http: false, sse: false },
	};
}

/**
 * Standard ACP stdio entry point backed by the real private runner client. AG-4: an editor turn is bounded by
 * the editor's own `session/cancel` and `promptTimeoutMs`, not by the gateway's 120 s task budget.
 */
export async function runAcpProxy(
	options: AgentBridgeOptions,
	input: ReadableStream<Uint8Array> = Deno.stdin.readable,
	output: WritableStream<Uint8Array> = Deno.stdout.writable,
	promptTimeoutMs = MAX_REQUEST_MS,
): Promise<void> {
	const client = new AgentBridgeClient(options, `editor-${crypto.randomUUID()}`);
	await client.open();
	const writer = output.getWriter();
	let writing = Promise.resolve();
	const send = (value: Record<string, unknown>): Promise<void> => {
		const next = writing.then(() => writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`)));
		writing = next.catch(() => {});
		return next;
	};
	const controller = new AbortController();
	const permissions = new Map<string, Record<string, unknown>>();
	const active = new Set<Promise<void>>();
	let initialized = false;
	/** A12: the runner agent advertised `loadSession`, so the editor's `session/load` is relayed. */
	let loadSession = false;
	const updates = (async (): Promise<void> => {
		for await (const event of client.events(controller.signal)) {
			if (event.method === 'bridge/prompt_complete') continue;
			if (event.method === 'session/request_permission') permissions.set(identifier(event.id), object(event.params));
			if (event.method === 'permission/expired') {
				permissions.delete(String(object(event.params).id));
				continue;
			}
			await send(event);
		}
	})().finally(() => controller.abort()).catch(() => {});
	try {
		for await (const line of lines(input, 1024 * 1024, controller.signal)) {
			const value = object(JSON.parse(line));
			if (value.jsonrpc !== '2.0') throw new AgentError(-32600, 'Malformed ACP envelope');
			if (typeof value.method !== 'string') {
				const pending = typeof value.id === 'string' ? permissions.get(value.id) : undefined;
				if (typeof value.id !== 'string' || !pending) continue;
				permissions.delete(value.id);
				// AG-2: a persistent grant, a malformed result or a reply racing the runner's expiry is the editor's
				// problem, not the session's. It is forwarded as a denial, and a refused forward leaves the runner's
				// own default denial in force instead of tearing the proxy down mid-prompt.
				await client.permission(value.id, editorDecision(pending, value)).catch(() => {});
				continue;
			}
			const method = value.method;
			const params = object(value.params ?? {});
			if (active.size >= 64) {
				// AG-2: only the request over the bound is refused; the editor's other in-flight work continues.
				if (value.id !== undefined) {
					await send({ jsonrpc: '2.0', id: value.id, error: { code: -32603, message: 'ACP request limit reached' } });
				}
				continue;
			}
			const operation = (async (): Promise<void> => {
				try {
					if (method !== 'initialize' && !initialized) throw new AgentError(-32600, 'Initialize required');
					if (method === 'session/cancel') {
						await client.request(method, params);
						return;
					}
					if (value.id === undefined) throw new AgentError(-32600, 'Request id required');
					// A12: `session/load` exists for the editor exactly when the runner's agent said it does.
					if (method === 'session/load' && !loadSession) throw new AgentError(-32601, 'Method not found');
					const opensSession = method === 'session/new' || method === 'session/load';
					if (opensSession && (!Array.isArray(params.mcpServers) || params.mcpServers.length)) {
						throw new AgentError(-32602, 'Editor MCP delegation unavailable');
					}
					// AG-5: the editor's cwd names a directory on the editor's machine. The agent only ever runs in the
					// runner's configured workspace, so that path is substituted here and the runner still validates it.
					const forwarded = opensSession ? { ...params, cwd: client.cwd } : params;
					// A loaded session replays its whole conversation before answering, so it gets a prompt's patience.
					const timeoutMs = method === 'session/prompt' || method === 'session/load' ? promptTimeoutMs : undefined;
					const result = await client.request(method, forwarded, undefined, timeoutMs);
					if (method === 'initialize') {
						initialized = true;
						result.agentCapabilities = editorCapabilities(result.agentCapabilities);
						loadSession = (result.agentCapabilities as { loadSession: boolean }).loadSession;
						result.authMethods = [];
					}
					await send({ jsonrpc: '2.0', id: value.id, result });
				} catch (error) {
					if (value.id !== undefined) {
						await send({
							jsonrpc: '2.0',
							id: value.id,
							error: {
								code: error instanceof AgentError ? error.code : -32603,
								message: error instanceof AgentError ? error.message : 'ACP bridge failed',
							},
						});
					}
				}
			})().catch(() => controller.abort());
			active.add(operation);
			void operation.finally(() => active.delete(operation));
		}
	} finally {
		controller.abort();
		await client.close().catch(() => {});
		await Promise.allSettled([...active, updates]);
		await writing;
		writer.releaseLock();
	}
}
