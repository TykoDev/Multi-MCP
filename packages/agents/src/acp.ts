import { AgentError, identifier, lines, object } from './util.ts';

/** Operator-fixed ACP executable. Secret files are passed by reference, never their contents. */
/** ACP's error code for a request that needs the agent to be authenticated first (E-2). */
export const AUTH_REQUIRED = -32000;

export interface AcpCommand {
	id: string;
	executable: string;
	args: readonly string[];
	cwd: string;
	env?: Readonly<Record<string, string>>;
	/** Operator-fixed URL/name allowlist. It contains no static bearer credentials. */
	mcpServers?: readonly Record<string, unknown>[];
}

/** ACP duplex callbacks; omitted permission callback means unconditional denial. */
export interface AcpCallbacks {
	update?: (params: Record<string, unknown>) => void;
	permission?: (params: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Real ACP v1 client over newline JSON-RPC to one allowlisted subprocess. */
export class AcpClient {
	#child: Deno.ChildProcess;
	#writer: WritableStreamDefaultWriter<Uint8Array>;
	#pending = new Map<number, Pending>();
	#permissions = new Map<AbortController, string>();
	#next = 0;
	#closed = false;
	#writing = Promise.resolve();
	#readerDone: Promise<void>;
	#stderrDone: Promise<void>;
	#status: Promise<Deno.CommandStatus>;
	#sessions = new Set<string>();
	#prompting = new Set<string>();
	#initialized = false;
	#commandServers: readonly Record<string, unknown>[];
	#cwd: string;
	#mcpHttp = false;
	/** A12: the agent advertised `loadSession`; only then is `session/load` forwarded. */
	#loadSession = false;
	#sensitive = new Set<string>();
	#killDone: Promise<void> = Promise.resolve();
	#closing?: Promise<void>;
	#callbacks = 0;

	constructor(command: AcpCommand, private readonly callbacks: AcpCallbacks = {}) {
		this.#commandServers = command.mcpServers ?? [];
		this.#cwd = command.cwd;
		if (!/^(\/|[A-Za-z]:[\\/])/.test(command.executable) || !/^(\/|[A-Za-z]:[\\/])/.test(command.cwd)) {
			throw new AgentError(-32602, 'ACP executable and cwd must be absolute operator paths');
		}
		// The private Linux runner owns an isolated process group, so cancellation kills
		// descendants too. Both helper paths are explicit grants in D-066.
		const linux = Deno.build.os === 'linux';
		this.#child = new Deno.Command(linux ? '/usr/bin/setsid' : command.executable, {
			args: linux ? [command.executable, ...command.args] : [...command.args],
			cwd: command.cwd,
			clearEnv: true,
			env: { ...command.env },
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
		}).spawn();
		this.#writer = this.#child.stdin.getWriter();
		this.#status = this.#child.status;
		this.#readerDone = this.#read().catch(() => this.#fail(new AgentError(-32603, 'ACP transport failed')));
		// Drain, but never retain or forward potentially credential-bearing agent diagnostics. Every byte is
		// discarded as it arrives, so memory stays bounded however much is logged; AG-3: a lifetime byte budget
		// on already-discarded data only killed long-running, chatty agents.
		this.#stderrDone = this.#child.stderr.pipeTo(new WritableStream()).catch(() => {});
		void this.#status.then(() => this.#fail(new AgentError(-32603, 'ACP transport closed')));
	}

	async #send(value: Record<string, unknown>): Promise<void> {
		const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
		if (bytes.length > 1024 * 1024) throw new AgentError(-32602, 'ACP line exceeds limit');
		const next = this.#writing.then(() => this.#writer.write(bytes));
		this.#writing = next.catch(() => {});
		await next;
	}

	async #read(): Promise<void> {
		for await (const line of lines(this.#child.stdout)) {
			let safe = line;
			// Scoped delegation credentials are control-plane data, not agent output.
			for (const secret of this.#sensitive) safe = safe.split(secret).join('[REDACTED]');
			// AG-8: a JSON escape (a backslash-u code point) hides the token from the raw-line match but not the parsed
			// value, so decoded strings and keys are redacted again before anything is emitted or stored.
			const value = object(this.#sensitive.size ? this.#redact(JSON.parse(safe)) : JSON.parse(safe));
			if (value.jsonrpc !== '2.0') throw new AgentError(-32600, 'Malformed ACP envelope');
			if (typeof value.method === 'string') {
				const params = object(value.params ?? {});
				if (value.method === 'session/update' && value.id === undefined) {
					if (this.#sessions.has(String(params.sessionId))) this.callbacks.update?.(params);
				} else if (value.id !== undefined) {
					// AG-9: every agent request we still owe a reply counts against the bound, not only permission
					// prompts; replies to unsupported methods queue behind a stalled stdin just the same.
					if (this.#callbacks >= 64) throw new AgentError(-32603, 'ACP callback limit reached');
					this.#callbacks++;
					void this.#callback(value.id, value.method, params).catch(() => this.#fail(new Error('ACP callback failed')))
						.finally(() => this.#callbacks--);
				}
				continue;
			}
			if (typeof value.id !== 'number') throw new AgentError(-32600, 'Malformed ACP response');
			const pending = this.#pending.get(value.id);
			if (!pending) continue;
			this.#pending.delete(value.id);
			clearTimeout(pending.timer);
			// E-2: one agent error is kept apart from the rest — ACP's "authentication required" (-32000) — because the
			// runtime answers it differently; every other agent diagnostic stays opaque.
			if (value.error !== undefined) {
				pending.reject(
					object(value.error).code === AUTH_REQUIRED
						? new AgentError(AUTH_REQUIRED, 'Agent requires authentication')
						: new AgentError(-32603, 'External ACP request failed'),
				);
			} else {
				// ERRATUM(E-84). A12: ACP agents answer `session/load` (and older ones `authenticate`) with a `null` result; an empty
				// object is the same answer. Anything else that is not an object fails only this request — thrown
				// here, it would have taken the whole transport down.
				const result = value.result ?? {};
				if (typeof result === 'object' && !Array.isArray(result)) pending.resolve(result as Record<string, unknown>);
				else pending.reject(new AgentError(-32603, 'External ACP request failed'));
			}
			continue;
		}
		this.#fail(new AgentError(-32603, 'ACP transport closed'));
	}

	#redact(value: unknown): unknown {
		if (typeof value === 'string') {
			let text = value;
			for (const secret of this.#sensitive) text = text.split(secret).join('[REDACTED]');
			return text;
		}
		if (Array.isArray(value)) return value.map((item) => this.#redact(item));
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.#redact(key), this.#redact(item)]));
		}
		return value;
	}

	async #callback(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
		if (method !== 'session/request_permission') {
			await this.#send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Client method unavailable' } });
			return;
		}
		const controller = new AbortController();
		this.#permissions.set(controller, String(params.sessionId));
		let result: Record<string, unknown> = { outcome: { outcome: 'cancelled' } };
		try {
			if (this.#prompting.has(String(params.sessionId)) && this.callbacks.permission) {
				const timeout = setTimeout(() => controller.abort(), 60_000);
				try {
					const denied = new Promise<Record<string, unknown>>((resolve) => {
						controller.signal.addEventListener('abort', () => resolve(result), { once: true });
					});
					const chosen = await Promise.race([this.callbacks.permission(params, controller.signal), denied]);
					const outcome = object(chosen.outcome);
					if (outcome.outcome === 'selected') {
						const options = Array.isArray(params.options) ? params.options.map(object) : [];
						const option = options.find((item) => item.optionId === outcome.optionId);
						// Persistent grants are deliberately unavailable without an operator policy.
						if (option && ['allow_once', 'reject_once'].includes(String(option.kind))) result = chosen;
					}
				} finally {
					clearTimeout(timeout);
				}
			}
		} catch {
			// A failed UI/client is a denial, never consent.
		} finally {
			this.#permissions.delete(controller);
		}
		await this.#send({ jsonrpc: '2.0', id, result });
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		for (const controller of this.#permissions.keys()) controller.abort();
		if (Deno.build.os === 'linux') {
			this.#killDone = new Deno.Command('/usr/bin/kill', {
				args: ['-KILL', '--', `-${this.#child.pid}`],
				clearEnv: true,
				stdout: 'null',
				stderr: 'null',
			}).output().then(() => {}).catch(() => {
				try {
					this.#child.kill('SIGKILL');
				} catch { /* It may have already exited. */ }
			});
		} else {
			try {
				this.#child.kill('SIGKILL');
			} catch { /* It may have already exited. */ }
		}
	}

	/** Only the negotiated baseline methods are forwarded to the executable. */
	async request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = 120_000,
	): Promise<Record<string, unknown>> {
		if (this.#closed) throw new AgentError(-32603, 'ACP client closed');
		if (
			!['initialize', 'authenticate', 'session/new', 'session/prompt'].includes(method) &&
			!(method === 'session/load' && this.#loadSession)
		) {
			throw new AgentError(-32601, 'Method unavailable');
		}
		if (this.#pending.size >= 64) throw new AgentError(-32603, 'ACP request limit reached');
		if (method !== 'initialize' && !this.#initialized) throw new AgentError(-32600, 'ACP initialize required');
		let session: string | undefined;
		/** A12: a session `session/load` registered, released again if the agent refuses to load it. */
		let loading: string | undefined;
		if (method === 'initialize') {
			if (params.protocolVersion !== 1 || this.#initialized) {
				throw new AgentError(-32602, 'ACP v1 initialization required');
			}
			params = {
				...params,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			};
		}
		if (method === 'authenticate') {
			// E-2: the method id is the operator's choice, checked against what the agent advertised by the caller.
			params = { methodId: identifier(params.methodId) };
		}
		if (method === 'session/new' || method === 'session/load') {
			const resumed = method === 'session/load' ? identifier(params.sessionId) : undefined;
			if (this.#sessions.size >= 32 && (resumed === undefined || !this.#sessions.has(resumed))) {
				throw new AgentError(-32603, 'ACP session limit reached');
			}
			if (params.cwd !== this.#cwd) throw new AgentError(-32602, 'ACP cwd is not the configured workspace');
			if (!Array.isArray(params.mcpServers) || params.mcpServers.length > 8) {
				throw new AgentError(-32602, 'Invalid MCP delegation');
			}
			for (const item of params.mcpServers) {
				const server = object(item);
				if (
					!this.#mcpHttp || server.type !== 'http' ||
					!this.#commandServers.some((allowed) => allowed.name === server.name && allowed.url === server.url)
				) throw new AgentError(-32602, 'MCP delegation is not operator-allowed');
				if (!Array.isArray(server.headers) || server.headers.length !== 1) {
					throw new AgentError(-32602, 'Scoped MCP authorization required');
				}
				const header = object(server.headers[0]);
				if (
					header.name !== 'Authorization' || typeof header.value !== 'string' ||
					!/^Bearer [A-Za-z0-9_-]{24,4096}$/.test(header.value)
				) throw new AgentError(-32602, 'Invalid scoped MCP authorization');
				this.#sensitive.add(header.value.slice(7));
			}
			// A12: the agent replays the loaded conversation as `session/update` notifications before it answers, and
			// updates reach the caller only for a known session — so the id is known from the moment it is asked for.
			if (resumed !== undefined && !this.#sessions.has(resumed)) {
				this.#sessions.add(resumed);
				loading = resumed;
			}
		}
		if (method === 'session/prompt') {
			session = identifier(params.sessionId);
			if (!this.#sessions.has(session)) throw new AgentError(-32602, 'ACP session not found');
			if (this.#prompting.has(session)) throw new AgentError(-32600, 'ACP session already prompting');
			if (!Array.isArray(params.prompt) || params.prompt.length > 64) {
				throw new AgentError(-32602, 'Invalid ACP prompt');
			}
			this.#prompting.add(session);
		}
		const id = ++this.#next;
		try {
			const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
				// AG-4: a slow turn is not a broken transport. The deadline fails only this request; a timed-out
				// prompt is also cancelled at the agent, whose late reply is then dropped as an unknown id. Killing
				// the process here took every other session and the caller's connection down with it.
				const timer = setTimeout(() => {
					if (!this.#pending.delete(id)) return;
					reject(new AgentError(-32603, 'ACP request timed out'));
					if (session) void this.cancel(session).catch(() => this.#fail(new Error('ACP write failed')));
				}, timeoutMs);
				this.#pending.set(id, { resolve, reject, timer });
				void this.#send({ jsonrpc: '2.0', id, method, params }).catch(() => this.#fail(new Error('ACP write failed')));
			});
			if (method === 'initialize') {
				if (result.protocolVersion !== 1) throw new AgentError(-32602, 'External agent does not support ACP v1');
				this.#initialized = true;
				const capabilities = object(result.agentCapabilities ?? {});
				this.#mcpHttp = object(capabilities.mcpCapabilities ?? {}).http === true;
				this.#loadSession = capabilities.loadSession === true;
			}
			if (method === 'session/new') this.#sessions.add(identifier(result.sessionId));
			loading = undefined;
			return result;
		} finally {
			if (session) this.#prompting.delete(session);
			if (loading !== undefined) this.#sessions.delete(loading);
		}
	}

	/** ACP cancellation is a notification; permission requests resolve denied first. */
	async cancel(sessionId: string): Promise<void> {
		if (!this.#sessions.has(sessionId)) throw new AgentError(-32602, 'ACP session not found');
		for (const [controller, session] of this.#permissions) if (session === sessionId) controller.abort();
		await this.#send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
	}

	/** EOF and shutdown close all pipes, reject pending calls and reap the process. */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closing = (async (): Promise<void> => {
			this.#fail(new AgentError(-32603, 'ACP client closed'));
			await this.#killDone;
			await this.#writer.abort().catch(() => {});
			this.#writer.releaseLock();
			await Promise.all([this.#status.catch(() => {}), this.#readerDone, this.#stderrDone]);
		})();
		return this.#closing;
	}
}
