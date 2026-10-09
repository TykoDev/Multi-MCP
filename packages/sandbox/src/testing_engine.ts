/**
 * Test support for the Docker backend (D-108, AC6): an in-memory byte pipe standing in for the daemon's unix socket,
 * and a fake Docker Engine that speaks HTTP/1.1 over it. It records every call with its body, keeps containers and
 * execs, and plays each exec the way a workspace container would: the wrapper's ready line, the work's output and
 * exit status, kills by process group, and the N3 cleanup of processes a command left behind.
 *
 * Not exported from mod.ts; only the package's tests import it.
 */
import { CLEANUP_SCRIPT, COMMAND_BODY, KILL_SCRIPT, READY_LINE, SESSION_BODY, WRAPPER } from './docker_spec.ts';
import type { EngineConn, EngineDial } from './engine.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Channel {
	readonly chunks: Uint8Array[] = [];
	eof = false;
	readonly #waiters: Array<() => void> = [];

	push(bytes: Uint8Array): void {
		this.chunks.push(bytes);
		this.#wake();
	}

	end(): void {
		this.eof = true;
		this.#wake();
	}

	#wake(): void {
		for (const waiter of this.#waiters.splice(0)) waiter();
	}

	async read(buffer: Uint8Array): Promise<number | null> {
		while (this.chunks.length === 0) {
			if (this.eof) return null;
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		}
		const head = this.chunks[0]!;
		const n = Math.min(buffer.length, head.length);
		buffer.set(head.subarray(0, n));
		if (n < head.length) this.chunks[0] = head.subarray(n);
		else this.chunks.shift();
		return n;
	}
}

class PipeEnd implements EngineConn {
	#closed = false;

	constructor(readonly inbound: Channel, readonly outbound: Channel) {}

	read(buffer: Uint8Array): Promise<number | null> {
		return this.#closed ? Promise.resolve(null) : this.inbound.read(buffer);
	}

	write(bytes: Uint8Array): Promise<number> {
		if (this.#closed || this.outbound.eof) return Promise.reject(new Deno.errors.BrokenPipe('pipe closed'));
		this.outbound.push(bytes.slice());
		return Promise.resolve(bytes.length);
	}

	closeWrite(): Promise<void> {
		this.outbound.end();
		return Promise.resolve();
	}

	close(): void {
		this.#closed = true;
		this.outbound.end();
		this.inbound.end();
	}
}

/** Two connected ends: what one writes, the other reads. */
export function memoryPipe(): [EngineConn, EngineConn] {
	const a = new Channel();
	const b = new Channel();
	return [new PipeEnd(a, b), new PipeEnd(b, a)];
}

export interface FakeCall {
	method: string;
	path: string;
	body: unknown;
}

export interface FakeContainer {
	id: string;
	name: string;
	body: Record<string, unknown>;
	running: boolean;
	/** Frozen by `pause` (R2-2): no exec can be created in it until `unpause`. */
	paused: boolean;
	/** The image id it was created from: what its tag pointed at then. */
	imageId: string;
	/** Processes a command left behind, by pid and session: what N3's cleanup must kill. */
	strays: Array<{ pid: number; sid: number }>;
}

/** An exec as a test's player sees it. */
export interface FakeExecView {
	container: FakeContainer;
	runId: string;
	cmd: string[];
	env: Record<string, string>;
	workdir: string;
	/** The work's script (after the wrapper), and its arguments. */
	inner: string;
	args: string[];
	stdin: string;
	pid: number;
	sid: number;
}

/** What a played exec does. */
export interface Play {
	output?: string;
	exitCode?: number;
	/** Run until killed (a time limit, a cancelled request). */
	hang?: boolean;
	/** Leave a process behind, in a session of its own, for the cleanup to find. */
	stray?: boolean;
}

export type Player = (exec: FakeExecView) => Play | Promise<Play>;

interface FakeExec {
	id: string;
	container: FakeContainer;
	body: { Cmd: string[]; Env: string[]; WorkingDir: string; AttachStdin: boolean };
	running: boolean;
	exitCode: number | null;
	pid: number;
	sid: number;
	kill: () => void;
	killed: Promise<void>;
}

export interface FakeEngineOptions {
	/** The service's work folder: the fake plays `git init` and the volume check against it. */
	workDir: string;
	volumes?: string[];
	player?: Player;
}

const hex = (n: number) =>
	crypto.getRandomValues(new Uint8Array(n)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

function frame(stream: number, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + data.length);
	out[0] = stream;
	new DataView(out.buffer).setUint32(4, data.length);
	out.set(data, 8);
	return out;
}

export class FakeEngine {
	readonly calls: FakeCall[] = [];
	readonly containers = new Map<string, FakeContainer>();
	readonly execs = new Map<string, FakeExec>();
	readonly volumes: Set<string>;
	readonly cleanups: Array<{ runId: string; keepPids: string; keepSids: string; killed: number }> = [];
	readonly kills: Array<{ runId: string; pgid: number }> = [];
	player: Player;
	/** Makes the volume check read something else: the configured volume is not the service's. */
	volumeMismatch = false;
	/** Makes the volume check's exec hang until it is killed. */
	volumeCheckHangs = false;
	/** Answers `_ping` with this status instead of 200. */
	pingStatus = 200;
	/** Answers `unpause` with this status instead of 204 (and leaves the container paused). */
	unpauseStatus = 204;
	/** The image id each tag points at now; a tag not named here points at `sha256:` + its own hex. */
	readonly images = new Map<string, string>();
	readonly workDir: string;
	#pid = 100;
	readonly #serving = new Set<Promise<void>>();

	constructor(options: FakeEngineOptions) {
		this.workDir = options.workDir;
		this.volumes = new Set(options.volumes ?? ['ttk-code', 'ttk-sandbox-sock']);
		this.player = options.player ?? (() => ({ output: '', exitCode: 0 }));
	}

	readonly dial: EngineDial = () => {
		const [client, server] = memoryPipe();
		const serving = this.#serve(server).catch(() => {});
		this.#serving.add(serving);
		void serving.finally(() => this.#serving.delete(serving));
		return Promise.resolve(client);
	};

	/** Waits for every connection the fake is still answering. */
	async settle(): Promise<void> {
		while (this.#serving.size > 0) await Promise.all([...this.#serving]);
	}

	/** Calls, as `METHOD /path` without the API version, for order assertions. */
	get trail(): string[] {
		return this.calls.map((c) => `${c.method} ${c.path.replace(/^\/v1\.45/, '').replace(/\?.*$/, '')}`);
	}

	/** Bodies of the execs created, in order. */
	get execBodies(): Array<{ Cmd: string[]; Env: string[]; WorkingDir: string; [key: string]: unknown }> {
		return this.calls.filter((c) => c.method === 'POST' && /\/exec$/.test(c.path)).map((c) => c.body as never);
	}

	/** The image id `tag` points at now. */
	imageOf(tag: string): string {
		return this.images.get(tag) ?? `sha256:${Array.from(encoder.encode(tag), (b) => b.toString(16)).join('')}`;
	}

	/**
	 * Adds a container as if an earlier run of the service had left it: by default a stand-in with one mount; with
	 * `body`, exactly that create body (as an earlier release would have sent it).
	 */
	plant(
		name: string,
		labels: Record<string, string>,
		running: boolean,
		volume = 'ttk-code',
		body?: Record<string, unknown>,
	): FakeContainer {
		const created = body ?? {
			Image: 'x:1',
			Labels: labels,
			HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: '/x' }] },
		};
		const container: FakeContainer = {
			id: hex(32),
			name,
			body: created,
			running,
			paused: false,
			imageId: this.imageOf(String(created.Image)),
			strays: [],
		};
		this.containers.set(container.id, container);
		return container;
	}

	/** The container of a workspace, by its label. */
	containerOf(runId: string): FakeContainer | undefined {
		return [...this.containers.values()].find((c) =>
			(c.body.Labels as Record<string, string> | undefined)?.['eu.tykotech.workspace'] === runId
		);
	}

	#find(idOrName: string): FakeContainer | undefined {
		return this.containers.get(idOrName) ?? [...this.containers.values()].find((c) => c.name === idOrName);
	}

	async #serve(conn: EngineConn): Promise<void> {
		let buffer = new Uint8Array(0);
		const read = async (): Promise<boolean> => {
			const chunk = new Uint8Array(65536);
			const n = await conn.read(chunk);
			if (n === null) return false;
			const next = new Uint8Array(buffer.length + n);
			next.set(buffer);
			next.set(chunk.subarray(0, n), buffer.length);
			buffer = next;
			return true;
		};
		let end = -1;
		while ((end = decoder.decode(buffer).indexOf('\r\n\r\n')) < 0) if (!(await read())) return conn.close();
		const head = decoder.decode(buffer.subarray(0, end)).split('\r\n');
		buffer = buffer.subarray(end + 4);
		const [method, path] = head[0]!.split(' ') as [string, string];
		const length = Number(head.find((h) => /^content-length:/i.test(h))?.split(':')[1]?.trim() ?? '0');
		while (buffer.length < length) if (!(await read())) return conn.close();
		const raw = decoder.decode(buffer.subarray(0, length));
		const body = raw ? JSON.parse(raw) : undefined;
		this.calls.push({ method, path, body });
		await this.#route(conn, method, path, body);
	}

	async #answer(conn: EngineConn, status: number, data?: unknown, chunked = false): Promise<void> {
		const text = data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data);
		const bytes = encoder.encode(text);
		const head = [`HTTP/1.1 ${status} X`, 'Content-Type: application/json'];
		if (chunked) {
			head.push('Transfer-Encoding: chunked', '', '');
			const half = Math.floor(bytes.length / 2);
			const parts = [bytes.subarray(0, half), bytes.subarray(half)].filter((p) => p.length > 0);
			let out = head.join('\r\n');
			for (const part of parts) out += `${part.length.toString(16)}\r\n${decoder.decode(part)}\r\n`;
			out += '0\r\n\r\n';
			await conn.write(encoder.encode(out));
		} else {
			head.push(`Content-Length: ${bytes.length}`, '', '');
			await conn.write(encoder.encode(head.join('\r\n')));
			if (bytes.length > 0) await conn.write(bytes);
		}
		conn.close();
	}

	async #route(conn: EngineConn, method: string, fullPath: string, body: unknown): Promise<void> {
		const path = fullPath.replace(/^\/v1\.45/, '');
		const [route, query = ''] = path.split('?') as [string, string?];
		let m: RegExpExecArray | null;
		if (method === 'GET' && route === '/_ping') return await this.#answer(conn, this.pingStatus, 'OK');
		if (method === 'GET' && (m = /^\/volumes\/([^/]+)$/.exec(route))) {
			return await this.#answer(conn, this.volumes.has(m[1]!) ? 200 : 404, { message: 'no such volume' });
		}
		if (method === 'GET' && route === '/containers/json') {
			const list = [...this.containers.values()].map((c) => {
				const host = (c.body.HostConfig ?? {}) as { Mounts?: Array<{ Type: string; Source: string }> };
				return {
					Id: c.id,
					Names: [`/${c.name}`],
					State: c.paused ? 'paused' : c.running ? 'running' : 'exited',
					Labels: c.body.Labels,
					Mounts: (host.Mounts ?? []).map((mount) => ({ Type: mount.Type, Name: mount.Source })),
				};
			});
			return await this.#answer(conn, 200, list, true);
		}
		if (method === 'POST' && route === '/containers/create') {
			const name = new URLSearchParams(query).get('name') ?? '';
			if (this.#find(name)) return await this.#answer(conn, 409, { message: 'name in use' });
			const created = body as Record<string, unknown>;
			const container: FakeContainer = {
				id: hex(32),
				name,
				body: created,
				running: false,
				paused: false,
				imageId: this.imageOf(String(created.Image)),
				strays: [],
			};
			this.containers.set(container.id, container);
			return await this.#answer(conn, 201, { Id: container.id, Warnings: [] });
		}
		if ((m = /^\/containers\/([^/]+)(?:\/(json|start|stop|exec|pause|unpause))?$/.exec(route))) {
			const container = this.#find(m[1]!);
			if (!container) return await this.#answer(conn, 404, { message: 'No such container' });
			const action = m[2];
			if (method === 'GET' && action === 'json') {
				const host = (container.body.HostConfig ?? {}) as Record<string, unknown>;
				return await this.#answer(conn, 200, {
					Id: container.id,
					Image: container.imageId,
					State: { Running: container.running, Paused: container.paused },
					Config: {
						Image: container.body.Image,
						Labels: { 'org.opencontainers.image.title': 'deno', ...container.body.Labels as object },
					},
					HostConfig: {
						// What Docker gives back omits false and empty values.
						Mounts: ((host.Mounts ?? []) as Array<Record<string, unknown>>).map((mount) => {
							const { ReadOnly, ...rest } = mount;
							return ReadOnly ? mount : rest;
						}),
						Privileged: host.Privileged,
						NetworkMode: host.NetworkMode,
					},
				});
			}
			if (method === 'POST' && action === 'start') {
				const was = container.running;
				container.running = true;
				return await this.#answer(conn, was ? 304 : 204);
			}
			if (method === 'POST' && action === 'stop') {
				const was = container.running;
				this.#halt(container);
				return await this.#answer(conn, was ? 204 : 304);
			}
			if (method === 'POST' && action === 'pause') {
				if (!container.running) return await this.#answer(conn, 409, { message: 'container is not running' });
				if (container.paused) return await this.#answer(conn, 409, { message: 'container is already paused' });
				container.paused = true;
				return await this.#answer(conn, 204);
			}
			if (method === 'POST' && action === 'unpause') {
				if (!container.paused) return await this.#answer(conn, 409, { message: 'container is not paused' });
				if (this.unpauseStatus !== 204) return await this.#answer(conn, this.unpauseStatus, { message: 'no' });
				container.paused = false;
				return await this.#answer(conn, 204);
			}
			if (method === 'DELETE' && action === undefined) {
				this.#halt(container);
				this.containers.delete(container.id);
				return await this.#answer(conn, 204);
			}
			if (method === 'POST' && action === 'exec') {
				if (!container.running) return await this.#answer(conn, 409, { message: 'container is not running' });
				if (container.paused) return await this.#answer(conn, 409, { message: 'container is paused' });
				const id = hex(32);
				let kill!: () => void;
				const killed = new Promise<void>((resolve) => kill = resolve);
				this.execs.set(id, {
					id,
					container,
					body: body as FakeExec['body'],
					running: false,
					exitCode: null,
					pid: this.#pid++,
					sid: this.#pid++,
					kill,
					killed,
				});
				return await this.#answer(conn, 201, { Id: id });
			}
		}
		if ((m = /^\/exec\/([0-9a-f]{64})\/(start|json)$/.exec(route))) {
			const exec = this.execs.get(m[1]!);
			if (!exec) return await this.#answer(conn, 404, { message: 'No such exec' });
			if (m[2] === 'json') {
				return await this.#answer(conn, 200, { Running: exec.running, ExitCode: exec.exitCode ?? 0 });
			}
			await conn.write(encoder.encode(
				'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
			));
			exec.running = true;
			try {
				exec.exitCode = await this.#play(exec, conn);
			} finally {
				exec.running = false;
				conn.close();
			}
			return;
		}
		return await this.#answer(conn, 404, { message: `no route ${method} ${route}` });
	}

	/** Stops a container: everything running in it is killed (a paused one is thawed to die, as Docker does). */
	#halt(container: FakeContainer): void {
		container.running = false;
		container.paused = false;
		container.strays = [];
		for (const exec of this.execs.values()) if (exec.container === container && exec.running) exec.kill();
	}

	async #play(exec: FakeExec, conn: EngineConn): Promise<number> {
		const cmd = exec.body.Cmd;
		const out = (stream: number, text: string) => conn.write(frame(stream, encoder.encode(text))).catch(() => 0);
		const runId = String(
			(exec.container.body.Labels as Record<string, string> | undefined)?.['eu.tykotech.workspace'] ?? '',
		);
		if (cmd[2] === KILL_SCRIPT) {
			const pgid = Number(cmd[4]);
			this.kills.push({ runId, pgid });
			for (const other of this.execs.values()) {
				if (other.container === exec.container && other.sid === pgid && other.running) other.kill();
			}
			return 0;
		}
		if (cmd[2] === CLEANUP_SCRIPT) {
			const keepPids = cmd[4] ?? '';
			const keepSids = cmd[5] ?? '';
			const keep = new Set(keepSids.split(' ').filter(Boolean).map(Number));
			const before = exec.container.strays.length;
			exec.container.strays = exec.container.strays.filter((stray) => keep.has(stray.sid));
			const killed = before - exec.container.strays.length;
			this.cleanups.push({ runId, keepPids, keepSids, killed });
			await out(1, `${killed}\n`);
			return 0;
		}
		if (cmd[2] !== WRAPPER) return 127;
		await out(2, `harbour-cage-ready ${exec.pid} ${exec.sid}\n`);
		const inner = cmd[4] ?? '';
		const args = cmd.slice(5);
		const env = Object.fromEntries(
			exec.body.Env.map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
		);
		if (inner.endsWith(SESSION_BODY)) return await this.#session(exec, conn, out);
		let stdin = '';
		if (exec.body.AttachStdin) {
			const chunk = new Uint8Array(65536);
			for (;;) {
				const n = await conn.read(chunk);
				if (n === null) break;
				stdin += decoder.decode(chunk.subarray(0, n));
			}
		}
		if (inner.includes('.harbour-volume-check')) {
			if (this.volumeCheckHangs) {
				await exec.killed;
				return 137;
			}
			const seen = this.volumeMismatch ? 'another volume' : await Deno.readTextFile(
				`${this.workDir}/.sandbox/${runId}/home/.harbour-volume-check`,
			).catch(() => '');
			await out(1, seen);
			return 0;
		}
		if (inner.includes('GIT_INDEX_FILE')) {
			await out(1, 'M\0a.txt\0=\0diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n');
			return 0;
		}
		const view: FakeExecView = {
			container: exec.container,
			runId,
			cmd,
			env,
			workdir: exec.body.WorkingDir,
			inner,
			args,
			stdin,
			pid: exec.pid,
			sid: exec.sid,
		};
		if (inner.endsWith(COMMAND_BODY) && (args[0] ?? '').startsWith('git init')) {
			await Deno.mkdir(`${this.workDir}/${runId}/.git/objects`, { recursive: true });
			return 0;
		}
		const play = await this.player(view);
		if (play.stray) exec.container.strays.push({ pid: this.#pid++, sid: this.#pid++ });
		if (play.output) await out(1, play.output);
		if (play.hang) {
			await exec.killed;
			return 137;
		}
		return play.exitCode ?? 0;
	}

	/** A session shell: each line of input comes back as `> line`, until its input ends or it is killed. */
	async #session(exec: FakeExec, conn: EngineConn, out: (stream: number, text: string) => Promise<unknown>) {
		let killed = false;
		void exec.killed.then(() => {
			killed = true;
			conn.close();
		});
		const chunk = new Uint8Array(65536);
		let pending = '';
		for (;;) {
			const n = await conn.read(chunk);
			if (n === null) break;
			pending += decoder.decode(chunk.subarray(0, n));
			let at: number;
			while ((at = pending.indexOf('\n')) >= 0) {
				await out(1, `> ${pending.slice(0, at)}\n`);
				pending = pending.slice(at + 1);
			}
		}
		if (!killed) exec.kill();
		return killed ? 137 : 0;
	}
}

/** The ready line the fake wrapper prints, for tests that build one by hand. */
export const readyLine = (pid: number, sid: number): string => {
	const line = `harbour-cage-ready ${pid} ${sid}`;
	if (!READY_LINE.test(line)) throw new Error('READY_LINE changed');
	return line;
};
