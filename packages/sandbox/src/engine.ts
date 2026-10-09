/**
 * D-108: a minimal Docker Engine API client — HTTP/1.1 over the daemon's unix socket, no dependency.
 *
 * Only the calls the Docker backend makes exist here, each with its path built from validated ids, so nothing a
 * caller sends can reach another endpoint: `_ping`, `volumes/{name}`, `containers/json` (by label),
 * `containers/create`, `containers/{id}/{json,start,stop,pause,unpause}`, `DELETE containers/{id}`,
 * `containers/{id}/exec`, `exec/{id}/start` (the attached, multiplexed raw stream) and `exec/{id}/json`. Create and
 * exec bodies are checked against their allowlists (docker_spec.ts) inside the methods that send them, before a
 * connection is opened.
 *
 * ERRATUM(E-91): `pause` and `unpause` are beyond the design's endpoint list (review R2-2). They freeze and thaw a
 * workspace container's processes (the cgroup freezer) while the service measures its files from its own side of the
 * volume, so a process of the workspace cannot change the tree under the measurement. They take no body, change no
 * configuration and grant nothing; a paused container that is stopped or removed is unpaused by the daemon itself.
 *
 * Every call has a deadline and a response-size bound, and opens its own connection (`Connection: close`), so a
 * stuck daemon costs one call, not the client. The API version is pinned to 1.45 (Engine 26), the first with
 * volume subpaths; an older daemon refuses it, and the backend then refuses to start.
 */
import { checkCreateBody, checkExecBody, type CreateFor, EXEC_START, LABEL_SANDBOX } from './docker_spec.ts';

export const ENGINE_API = '/v1.45';

/** A byte stream to the daemon: a `Deno.UnixConn` in production, an in-memory pipe in tests. */
export interface EngineConn {
	read(buffer: Uint8Array): Promise<number | null>;
	write(bytes: Uint8Array): Promise<number>;
	closeWrite(): Promise<void>;
	close(): void;
}

export type EngineDial = () => Promise<EngineConn>;

/** Connects to the daemon's socket; Deno asks for read and write access to its path. */
export const unixDial = (path: string): EngineDial => () => Deno.connect({ transport: 'unix', path });

/** A daemon answer other than the expected one; `message` is for the log, never for a client. */
export class EngineError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = 'EngineError';
	}
}

export interface EngineOptions {
	/** Per-call deadline for everything but an attached exec stream. */
	timeoutMs?: number;
	/** The most a JSON answer may take. */
	maxResponseBytes?: number;
}

/** What the backend reads of a container. */
export interface ContainerInfo {
	id: string;
	/** Docker's `State.Running`, which a paused container also has. */
	running: boolean;
	/** Frozen by `pause` (R2-2): its processes run again only once it is unpaused. */
	paused: boolean;
	/** The image as the body named it (`Config.Image`): a tag or digest. */
	image: string;
	/** R2-6: the image it was created from, by id (`Image`), whatever its tag points at now. */
	imageId: string;
	labels: Record<string, string>;
	/** `HostConfig.Mounts`, as created. */
	mounts: unknown[];
	privileged: boolean;
	networkMode: string;
}

/** What the backend reads of a listed container. */
export interface ContainerSummary {
	id: string;
	/** Running or paused: it has processes, frozen or not. */
	running: boolean;
	labels: Record<string, string>;
	/** The named volumes it mounts. */
	volumes: string[];
}

const HEAD_BYTES = 16 * 1024;
const LIST_BYTES = 8 * 1024 * 1024;
const FRAME_BYTES = 16 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const EXEC_ID = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function checkName(value: string, what: string): string {
	if (!NAME.test(value)) throw new EngineError(400, `${what} is not a Docker name or id`);
	return value;
}

async function writeAll(conn: EngineConn, bytes: Uint8Array): Promise<void> {
	let written = 0;
	while (written < bytes.length) written += await conn.write(bytes.subarray(written));
}

/** Buffered reads over a connection: lines, exact lengths, and the rest. */
class ConnReader {
	#buffer = new Uint8Array(0);
	#start = 0;
	#eof = false;

	constructor(readonly conn: EngineConn) {}

	get buffered(): number {
		return this.#buffer.length - this.#start;
	}

	/** What is buffered and not yet read, handed over (to the exec stream after the head). */
	take(): Uint8Array {
		const rest = this.#buffer.slice(this.#start);
		this.#buffer = new Uint8Array(0);
		this.#start = 0;
		return rest;
	}

	async #fill(): Promise<boolean> {
		if (this.#eof) return false;
		const chunk = new Uint8Array(READ_CHUNK);
		const n = await this.conn.read(chunk);
		if (n === null) {
			this.#eof = true;
			return false;
		}
		const next = new Uint8Array(this.buffered + n);
		next.set(this.#buffer.subarray(this.#start));
		next.set(chunk.subarray(0, n), this.buffered);
		this.#buffer = next;
		this.#start = 0;
		return true;
	}

	/** One CRLF-terminated line, without its CRLF. */
	async line(max: number): Promise<string> {
		for (;;) {
			const view = this.#buffer.subarray(this.#start);
			for (let i = 0; i + 1 < view.length; i++) {
				if (view[i] === 13 && view[i + 1] === 10) {
					const text = decoder.decode(view.subarray(0, i));
					this.#start += i + 2;
					return text;
				}
			}
			if (view.length > max) throw new EngineError(502, 'a Docker answer line is too long');
			if (!(await this.#fill())) throw new EngineError(502, 'the Docker answer ended early');
		}
	}

	async exact(n: number): Promise<Uint8Array> {
		while (this.buffered < n) {
			if (!(await this.#fill())) throw new EngineError(502, 'the Docker answer ended early');
		}
		const out = this.#buffer.slice(this.#start, this.#start + n);
		this.#start += n;
		return out;
	}

	/** Exactly `n` bytes, or null when the stream ends cleanly before the first of them. */
	async exactOrEnd(n: number): Promise<Uint8Array | null> {
		while (this.buffered < n) {
			if (!(await this.#fill())) {
				if (this.buffered === 0) return null;
				throw new EngineError(502, 'the Docker stream ended inside a frame');
			}
		}
		return await this.exact(n);
	}

	async rest(max: number): Promise<Uint8Array> {
		while (await this.#fill()) {
			if (this.buffered > max) throw new EngineError(502, 'the Docker answer is too large');
		}
		return this.take();
	}
}

interface Answer {
	status: number;
	headers: Map<string, string>;
	body: Uint8Array;
}

async function readHead(reader: ConnReader): Promise<{ status: number; headers: Map<string, string> }> {
	const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(await reader.line(HEAD_BYTES));
	if (!status) throw new EngineError(502, 'the Docker answer is not HTTP/1.1');
	const headers = new Map<string, string>();
	let size = 0;
	for (;;) {
		const line = await reader.line(HEAD_BYTES);
		if (line === '') break;
		size += line.length;
		if (size > HEAD_BYTES) throw new EngineError(502, 'the Docker answer head is too large');
		const colon = line.indexOf(':');
		if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
	}
	return { status: Number(status[1]), headers };
}

async function readBody(reader: ConnReader, status: number, headers: Map<string, string>, max: number) {
	if (status === 204 || status === 304) return new Uint8Array(0);
	if (/chunked/i.test(headers.get('transfer-encoding') ?? '')) {
		const parts: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const sizeLine = (await reader.line(1024)).split(';')[0]!.trim();
			if (!/^[0-9a-fA-F]{1,8}$/.test(sizeLine)) throw new EngineError(502, 'a bad chunk in the Docker answer');
			const n = parseInt(sizeLine, 16);
			if (n === 0) {
				while ((await reader.line(HEAD_BYTES)) !== '');
				break;
			}
			size += n;
			if (size > max) throw new EngineError(502, 'the Docker answer is too large');
			parts.push(await reader.exact(n));
			if ((await reader.line(2)) !== '') throw new EngineError(502, 'a bad chunk in the Docker answer');
		}
		const body = new Uint8Array(size);
		let at = 0;
		for (const part of parts) {
			body.set(part, at);
			at += part.length;
		}
		return body;
	}
	const length = headers.get('content-length');
	if (length !== undefined) {
		const n = Number(length);
		if (!Number.isSafeInteger(n) || n < 0) throw new EngineError(502, 'a bad length in the Docker answer');
		if (n > max) throw new EngineError(502, 'the Docker answer is too large');
		return await reader.exact(n);
	}
	return await reader.rest(max);
}

/** The daemon's own words for a failure, cut short and stripped of control characters, for the log. */
function said(body: Uint8Array): string {
	let text = decoder.decode(body.subarray(0, 2048));
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed.message === 'string') text = parsed.message;
	} catch {
		// Not JSON: keep the text.
	}
	let plain = '';
	for (const char of text) {
		const code = char.codePointAt(0)!;
		plain += code < 0x20 || code === 0x7f ? ' ' : char;
	}
	return plain.trim().slice(0, 300);
}

/** One frame of an attached exec's output: stream 1 is stdout, 2 stderr (3: the daemon's own error). */
export interface ExecFrame {
	stream: number;
	data: Uint8Array;
}

/**
 * An attached exec: the hijacked connection, demultiplexed. Standard input is written raw; closing the write half
 * is the process's end of input.
 */
export class ExecStream {
	readonly #reader: ConnReader;
	readonly #conn: EngineConn;
	#closed = false;

	constructor(conn: EngineConn, reader: ConnReader) {
		this.#conn = conn;
		this.#reader = reader;
	}

	/** The next frame, or null once the daemon closed the stream (or `close` was called). */
	async next(): Promise<ExecFrame | null> {
		if (this.#closed) return null;
		try {
			const head = await this.#reader.exactOrEnd(8);
			if (head === null) return null;
			const size = new DataView(head.buffer, head.byteOffset, 8).getUint32(4);
			if (size > FRAME_BYTES) throw new EngineError(502, 'a Docker stream frame is too large');
			return { stream: head[0]!, data: await this.#reader.exact(size) };
		} catch (error) {
			if (this.#closed) return null;
			throw error;
		}
	}

	async write(bytes: Uint8Array): Promise<void> {
		await writeAll(this.#conn, bytes);
	}

	async closeWrite(): Promise<void> {
		await this.#conn.closeWrite();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#conn.close();
		} catch {
			// Already closed.
		}
	}
}

/** The Engine API, as far as the Docker backend uses it. */
export class Engine {
	readonly #dial: EngineDial;
	readonly #timeoutMs: number;
	readonly #maxBytes: number;

	constructor(dial: EngineDial, options: EngineOptions = {}) {
		this.#dial = dial;
		this.#timeoutMs = options.timeoutMs ?? 60_000;
		this.#maxBytes = options.maxResponseBytes ?? 1024 * 1024;
	}

	/**
	 * Sends one request on a connection of its own. With `upgrade`, the daemon's 101 (or 200) leaves the connection
	 * open as an exec stream; otherwise the answer is read whole, within the bound, and the connection closed.
	 */
	async #send(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown,
		options: { maxBytes?: number; upgrade?: boolean } = {},
	): Promise<Answer | ExecStream> {
		const payload = body === undefined ? null : encoder.encode(JSON.stringify(body));
		const head = [
			`${method} ${ENGINE_API}${path} HTTP/1.1`,
			'Host: docker',
			'User-Agent: tykotech-sandbox',
			...(payload ? ['Content-Type: application/json', `Content-Length: ${payload.length}`] : []),
			...(method === 'POST' && !payload ? ['Content-Length: 0'] : []),
			...(options.upgrade ? ['Connection: Upgrade', 'Upgrade: tcp'] : ['Connection: close']),
			'',
			'',
		].join('\r\n');
		let timedOut = false;
		let conn: EngineConn | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				try {
					conn?.close();
				} catch {
					// Already closed.
				}
				reject(new EngineError(504, `Docker did not answer ${method} ${path} in time`));
			}, this.#timeoutMs);
		});
		let keep = false;
		try {
			const exchange = (async (): Promise<Answer | ExecStream> => {
				conn = await this.#dial();
				if (timedOut) conn.close();
				await writeAll(conn, encoder.encode(head));
				if (payload) await writeAll(conn, payload);
				const reader = new ConnReader(conn);
				const { status, headers } = await readHead(reader);
				if (options.upgrade && (status === 101 || status === 200)) {
					keep = true;
					return new ExecStream(conn, reader);
				}
				return { status, headers, body: await readBody(reader, status, headers, options.maxBytes ?? this.#maxBytes) };
			})();
			exchange.catch(() => {});
			return await Promise.race([exchange, deadline]);
		} catch (error) {
			if (timedOut) throw new EngineError(504, `Docker did not answer ${method} ${path} in time`);
			if (error instanceof EngineError) throw error;
			throw new EngineError(503, `Docker could not be reached: ${error instanceof Error ? error.name : 'error'}`);
		} finally {
			clearTimeout(timer);
			deadline.catch(() => {});
			if (!keep) {
				try {
					(conn as EngineConn | null)?.close();
				} catch {
					// Already closed.
				}
			}
		}
	}

	async #call(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		ok: number[],
		body?: unknown,
		maxBytes?: number,
	): Promise<Answer> {
		const answer = await this.#send(method, path, body, { maxBytes }) as Answer;
		if (!ok.includes(answer.status)) throw new EngineError(answer.status, said(answer.body));
		return answer;
	}

	#json(answer: Answer): Record<string, unknown> {
		try {
			const parsed = JSON.parse(decoder.decode(answer.body));
			if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
		} catch {
			// Fall through.
		}
		throw new EngineError(502, 'Docker sent an answer that is not JSON');
	}

	/** The daemon answers, at API 1.45 or later (an older one refuses the versioned path). */
	async ping(): Promise<void> {
		await this.#call('GET', '/_ping', [200]);
	}

	async volumeExists(name: string): Promise<boolean> {
		const answer = await this.#send('GET', `/volumes/${checkName(name, 'volume')}`) as Answer;
		if (answer.status === 404) return false;
		if (answer.status !== 200) throw new EngineError(answer.status, said(answer.body));
		return true;
	}

	/** Every container, running or not, carrying the sandbox's label. */
	async listContainers(): Promise<ContainerSummary[]> {
		const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL_SANDBOX}=1`] }));
		const answer = await this.#call(
			'GET',
			`/containers/json?all=true&filters=${filters}`,
			[200],
			undefined,
			LIST_BYTES,
		);
		const parsed = JSON.parse(decoder.decode(answer.body));
		if (!Array.isArray(parsed)) throw new EngineError(502, 'Docker sent a container list that is not a list');
		return parsed.flatMap((entry): ContainerSummary[] => {
			if (!entry || typeof entry.Id !== 'string') return [];
			const mounts: unknown[] = Array.isArray(entry.Mounts) ? entry.Mounts : [];
			return [{
				id: entry.Id,
				running: entry.State === 'running' || entry.State === 'paused',
				labels: entry.Labels && typeof entry.Labels === 'object' ? entry.Labels : {},
				volumes: mounts.flatMap((m) =>
					m && typeof m === 'object' && (m as Record<string, unknown>).Type === 'volume' &&
						typeof (m as Record<string, unknown>).Name === 'string'
						? [(m as Record<string, string>).Name!]
						: []
				),
			}];
		});
	}

	async inspectContainer(idOrName: string): Promise<ContainerInfo | null> {
		const answer = await this.#send('GET', `/containers/${checkName(idOrName, 'container')}/json`) as Answer;
		if (answer.status === 404) return null;
		if (answer.status !== 200) throw new EngineError(answer.status, said(answer.body));
		const info = this.#json(answer);
		const state = (info.State ?? {}) as Record<string, unknown>;
		const config = (info.Config ?? {}) as Record<string, unknown>;
		const host = (info.HostConfig ?? {}) as Record<string, unknown>;
		return {
			id: String(info.Id ?? ''),
			running: state.Running === true,
			paused: state.Paused === true,
			image: String(config.Image ?? ''),
			imageId: String(info.Image ?? ''),
			labels: (config.Labels && typeof config.Labels === 'object' ? config.Labels : {}) as Record<string, string>,
			mounts: Array.isArray(host.Mounts) ? host.Mounts : [],
			privileged: host.Privileged === true,
			networkMode: String(host.NetworkMode ?? ''),
		};
	}

	/** Creates a workspace container from a body checked against `target` first; refused bodies are never sent. */
	async createContainer(name: string, body: unknown, target: CreateFor): Promise<string> {
		const checked = checkCreateBody(body, target);
		const answer = await this.#call(
			'POST',
			`/containers/create?name=${checkName(name, 'container')}`,
			[201],
			checked,
		);
		const id = this.#json(answer).Id;
		if (typeof id !== 'string' || !NAME.test(id)) throw new EngineError(502, 'Docker sent no container id');
		return id;
	}

	async startContainer(id: string): Promise<void> {
		await this.#call('POST', `/containers/${checkName(id, 'container')}/start`, [204, 304]);
	}

	async stopContainer(id: string, seconds = 5): Promise<void> {
		await this.#call('POST', `/containers/${checkName(id, 'container')}/stop?t=${Math.trunc(seconds)}`, [
			204,
			304,
			404,
		]);
	}

	/** R2-2 (E-91): freezes every process in a running container; 409 when it is not running or already paused. */
	async pauseContainer(id: string): Promise<void> {
		await this.#call('POST', `/containers/${checkName(id, 'container')}/pause`, [204]);
	}

	/** Thaws a paused container; 409 when it is not paused. */
	async unpauseContainer(id: string): Promise<void> {
		await this.#call('POST', `/containers/${checkName(id, 'container')}/unpause`, [204]);
	}

	/** Removes a container, running or not; its named volumes are never removed. */
	async removeContainer(id: string): Promise<void> {
		await this.#call('DELETE', `/containers/${checkName(id, 'container')}?force=true`, [204, 404]);
	}

	/** Creates an exec from a body checked first; refused bodies are never sent. */
	async createExec(containerId: string, body: unknown): Promise<string> {
		const checked = checkExecBody(body);
		const answer = await this.#call('POST', `/containers/${checkName(containerId, 'container')}/exec`, [201], checked);
		const id = this.#json(answer).Id;
		if (typeof id !== 'string' || !EXEC_ID.test(id)) throw new EngineError(502, 'Docker sent no exec id');
		return id;
	}

	/** Starts an exec attached; the stream carries its multiplexed output and takes its standard input. */
	async startExec(execId: string): Promise<ExecStream> {
		if (!EXEC_ID.test(execId)) throw new EngineError(400, 'not an exec id');
		const answer = await this.#send('POST', `/exec/${execId}/start`, EXEC_START, { upgrade: true });
		if (answer instanceof ExecStream) return answer;
		throw new EngineError(answer.status, said(answer.body));
	}

	async inspectExec(execId: string): Promise<{ running: boolean; exitCode: number | null }> {
		if (!EXEC_ID.test(execId)) throw new EngineError(400, 'not an exec id');
		const info = this.#json(await this.#call('GET', `/exec/${execId}/json`, [200]));
		return {
			running: info.Running === true,
			exitCode: typeof info.ExitCode === 'number' ? info.ExitCode : null,
		};
	}
}
