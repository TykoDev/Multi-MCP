/**
 * R12 (design §2.19, D-132): the credentialed clone's transport, and the operator's remotes it serves.
 *
 * With the CONNECT proxy, TLS runs end to end from the cage, so any credential would have to be inside the cage. The
 * forwarder keeps it out: the clone step's git talks plain http to `http://127.0.0.1:3128/r` (the cage's socat to this
 * per-run unix socket), and the forwarder makes its own TLS connection to the remote, adding `Authorization`
 * service-side. Nothing secret is ever in the cage's environment, files, `/proc` or output, and nothing secret is
 * logged: every token and header value is registered with `guardSecret` the moment it is read.
 *
 * What it serves, and nothing else (403 otherwise — `git-receive-pack`, so no push, and every other path):
 *
 * - `GET /r/info/refs?service=git-upload-pack` and `POST /r/git-upload-pack`, mapped onto the remote's own path;
 * - request heads up to 16 KiB and bodies up to 64 MiB (by length or chunked, re-sent chunked);
 * - `Git-Protocol`, `Content-Type`, `Content-Encoding` and `Accept` passed on; `Host`, a fixed `User-Agent`, the
 *   credential and `Connection: close` set by the forwarder;
 * - the remote is dialled at an address the forwarder resolved and checked itself (`isPublicAddress`, as the
 *   registry proxy does), then TLS is run with the remote's host name, verified and sent as SNI (M8, measured on Deno
 *   2.9.7); a redirect (3xx) is refused, never followed; the answer is streamed back with a small header allowlist.
 *
 * The remotes come from one operator file (`TTK_SANDBOX_GIT_REMOTES_FILE`, `/run/secrets/ttk_git_remotes`), read once
 * at start-up, after which the service gives up its read grant on it — the token.ts (SB-5) pattern, copied rather
 * than imported, since token.ts is kept import-free for the Linux tier.
 */
import { type GitOrigin, gitOrigin } from './clone.ts';
import { LIMITS } from './limits.ts';
import { guardSecret } from './log.ts';
import { headEnd, isPublicAddress, type ProxyDeps, type ProxyHandle } from './proxy.ts';

/** The only path `TTK_SANDBOX_GIT_REMOTES_FILE` may name (a compose secret); the matrices grant it alone. */
export const GIT_REMOTES_FILE = '/run/secrets/ttk_git_remotes';
/** The remotes file's bound. */
export const REMOTES_BYTES = 64 * 1024;

const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USERNAME = /^[\x21-\x39\x3b-\x7e]{1,256}$/; // printable ASCII, no space, no ':'
const TOKEN = /^[\x21-\x7e]{1,4096}$/; // printable ASCII, no whitespace
/** The user name sent with a token when the remote names none: what GitHub expects for a token. */
export const DEFAULT_GIT_USERNAME = 'x-access-token';

/** One operator-fixed remote: an id a caller names, its public origin, and the credential the forwarder adds. */
export interface GitRemote {
	readonly id: string;
	readonly origin: GitOrigin;
	/** `Basic …`, added service-side by the forwarder; null for a remote reached without a credential. */
	readonly authorization: string | null;
}

/** The remotes file, parsed; `secrets` are the values the caller must guard before anything else runs. */
export interface ParsedRemotes {
	readonly remotes: readonly GitRemote[];
	readonly secrets: readonly string[];
}

const encoder = new TextEncoder();

function base64(text: string): string {
	let binary = '';
	for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Parses the remotes file: a JSON list of `{id, url, username?, token?}`, ids unique, every URL of the shape §2.19
 * fixes for a clone URL (its host need not be on `TTK_SANDBOX_GIT_HOSTS`: a remote is operator-fixed and reached only
 * through the forwarder). Throws naming the file and the rule broken, never a value from it.
 */
export function parseGitRemotes(text: string): ParsedRemotes {
	const refuse = (why: string): never => {
		throw new Error(`TTK_SANDBOX_GIT_REMOTES_FILE: ${why}.`);
	};
	if (encoder.encode(text).length > REMOTES_BYTES) refuse('the file is over 64 KiB');
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return refuse('the file is not JSON');
	}
	if (!Array.isArray(parsed)) refuse('the file must hold a JSON list of remotes');
	const remotes: GitRemote[] = [];
	const secrets: string[] = [];
	const ids = new Set<string>();
	for (const [index, entry] of (parsed as unknown[]).entries()) {
		const at = `remote ${index + 1}`;
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) refuse(`${at} must be an object`);
		const row = entry as Record<string, unknown>;
		for (const key of Object.keys(row)) {
			if (!['id', 'url', 'username', 'token'].includes(key)) {
				refuse(`${at} has a field other than id, url, username, token`);
			}
		}
		if (typeof row.id !== 'string' || !REMOTE_ID.test(row.id)) {
			refuse(`${at} needs an id of letters, digits and . _ - (at most 64)`);
		}
		const id = row.id as string;
		if (ids.has(id)) refuse(`${at} repeats an id`);
		ids.add(id);
		const origin = gitOrigin(row.url);
		if ('refused' in origin) return refuse(`${at} url ${origin.refused}`);
		if (row.username !== undefined && (typeof row.username !== 'string' || !USERNAME.test(row.username))) {
			refuse(`${at} username must be printable, without spaces or ':'`);
		}
		if (row.token !== undefined && (typeof row.token !== 'string' || !TOKEN.test(row.token))) {
			refuse(`${at} token must be printable, without whitespace`);
		}
		if (row.username !== undefined && row.token === undefined) refuse(`${at} names a username without a token`);
		let authorization: string | null = null;
		if (typeof row.token === 'string') {
			const credential = base64(`${(row.username as string | undefined) ?? DEFAULT_GIT_USERNAME}:${row.token}`);
			authorization = `Basic ${credential}`;
			secrets.push(row.token, credential, authorization);
		}
		remotes.push({ id, origin, authorization });
	}
	return { remotes, secrets };
}

/**
 * Reads the remotes file once, gives up the grant to read it again, registers every credential with the log guard,
 * and checks the folders the service still needs are readable after the revoke (a file kept inside one of them is
 * refused, as SB-5 refuses the token there). Throws, naming the file only, on anything it cannot use.
 */
export async function loadGitRemotes(path: string, keep: readonly string[]): Promise<GitRemote[]> {
	const info = await Deno.lstat(path).catch((error) => {
		// The matrices grant this one path (D-131); an overlay that does not cannot start with the remotes set.
		if (error instanceof Deno.errors.NotCapable) {
			throw new Error(`TTK_SANDBOX_GIT_REMOTES_FILE is set, but this process holds no read grant for ${path}.`);
		}
		return null;
	});
	if (info === null || !info.isFile || info.isSymlink || info.size > REMOTES_BYTES) {
		throw new Error('TTK_SANDBOX_GIT_REMOTES_FILE must name a regular file of at most 64 KiB.');
	}
	const text = await Deno.readTextFile(path);
	await Deno.permissions.revoke({ name: 'read', path });
	if ((await Deno.permissions.query({ name: 'read', path })).state === 'granted') {
		throw new Error('The git remotes file is still readable after its grant was revoked.');
	}
	for (const folder of keep) {
		if ((await Deno.permissions.query({ name: 'read', path: folder })).state !== 'granted') {
			throw new Error(`Grant read access to the git remotes file on its own, outside ${folder}.`);
		}
	}
	const { remotes, secrets } = parseGitRemotes(text);
	for (const secret of secrets) guardSecret(secret);
	return [...remotes];
}

/** What one forwarder serves: the remote's origin and the credential added to every request for it. */
export type ForwardOrigin = Pick<GitRemote, 'origin' | 'authorization'>;

const HEAD_BYTES = 16 * 1024;
const BODY_BYTES = 64 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const TLS_TIMEOUT_MS = 15_000;
const UPSTREAM_HEAD_TIMEOUT_MS = 60_000;
const READ_CHUNK = 64 * 1024;
/** Request headers passed on from the cage's git; everything else is dropped. */
const PASSED_REQUEST = ['git-protocol', 'content-type', 'content-encoding', 'accept'] as const;
/** Response headers passed back; `Location`, `Set-Cookie` and `WWW-Authenticate` never are. */
const PASSED_RESPONSE = [
	'content-type',
	'content-encoding',
	'content-length',
	'transfer-encoding',
	'cache-control',
	'expires',
	'pragma',
] as const;
const HEADER_VALUE = /^[\x20-\x7e]{0,1024}$/;
const USER_AGENT = 'git/tykotech-sandbox-forwarder';
const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; suffix: string }>> = {
	'GET /r/info/refs?service=git-upload-pack': { method: 'GET', suffix: '/info/refs?service=git-upload-pack' },
	'POST /r/git-upload-pack': { method: 'POST', suffix: '/git-upload-pack' },
};

/** A refusal or failure with the status the cage's git is answered with. */
class Refusal extends Error {
	constructor(readonly status: number, readonly reason: string, message: string) {
		super(message);
		this.name = 'Refusal';
	}
}

/** Buffered reads over one connection: the head, lines, and bytes as they come. */
class Reader {
	#buffer = new Uint8Array(0);
	#start = 0;
	#eof = false;

	constructor(readonly conn: Deno.Conn) {}

	get buffered(): number {
		return this.#buffer.length - this.#start;
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

	/** The head up to its blank line (not included), as Latin-1 text; null when it does not fit or never ends. */
	async head(max: number): Promise<string | null> {
		for (;;) {
			const view = this.#buffer.subarray(this.#start);
			const end = headEnd(view);
			if (end >= 0) {
				if (end > max) return null;
				this.#start += end + 4;
				return new TextDecoder('latin1').decode(view.subarray(0, end));
			}
			if (view.length > max) return null;
			if (!(await this.#fill())) return null;
		}
	}

	/** One CRLF-terminated line (a chunk size or trailer), without its CRLF. */
	async line(max: number): Promise<string> {
		for (;;) {
			const view = this.#buffer.subarray(this.#start);
			for (let i = 0; i + 1 < view.length; i++) {
				if (view[i] === 13 && view[i + 1] === 10) {
					this.#start += i + 2;
					return new TextDecoder('latin1').decode(view.subarray(0, i));
				}
			}
			if (view.length > max) throw new Refusal(400, 'Bad Request', 'a body line is too long');
			if (!(await this.#fill())) throw new Refusal(400, 'Bad Request', 'the body ended early');
		}
	}

	/** Up to `max` bytes, whatever is buffered first; null at the end of the stream. */
	async some(max: number): Promise<Uint8Array | null> {
		if (this.buffered === 0 && !(await this.#fill())) return null;
		const n = Math.min(max, this.buffered);
		const out = this.#buffer.slice(this.#start, this.#start + n);
		this.#start += n;
		return out;
	}

	/** Whatever is buffered and not yet read, handed over. */
	take(): Uint8Array {
		const rest = this.#buffer.slice(this.#start);
		this.#buffer = new Uint8Array(0);
		this.#start = 0;
		return rest;
	}
}

/** A parsed HTTP head: its first line's parts and its header fields, names lower-cased. */
interface Head {
	first: string[];
	fields: Map<string, string[]>;
}

function parseHead(text: string): Head | null {
	const [first, ...lines] = text.split('\r\n');
	const fields = new Map<string, string[]>();
	for (const line of lines) {
		const colon = line.indexOf(':');
		// Folded continuation lines and nameless fields are not HTTP/1.1 any more; refuse rather than guess.
		if (colon <= 0 || /^[ \t]/.test(line)) return null;
		const name = line.slice(0, colon).trim().toLowerCase();
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) return null;
		fields.set(name, [...(fields.get(name) ?? []), line.slice(colon + 1).trim()]);
	}
	return { first: (first ?? '').split(' '), fields };
}

/** One value of a field that may appear once at most, or undefined; a repeated one is refused. */
function single(head: Head, name: string): string | undefined {
	const values = head.fields.get(name);
	if (values === undefined) return undefined;
	if (values.length !== 1) throw new Refusal(400, 'Bad Request', `${name} is repeated`);
	return values[0];
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
	let written = 0;
	while (written < bytes.length) written += await conn.write(bytes.subarray(written));
}

async function reply(conn: Deno.Conn, status: number, reason: string, message: string): Promise<void> {
	const body = encoder.encode(`${message}\n`);
	await writeAll(
		conn,
		encoder.encode(
			`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
				`Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
		),
	);
	await writeAll(conn, body);
}

function closeQuietly(conn: Deno.Conn | null): void {
	try {
		conn?.close();
	} catch {
		// Already closed.
	}
}

/** Runs `work`, closing `conn` (so the read in it ends) when it takes longer than `ms`. */
async function bounded<T>(conn: Deno.Conn, ms: number, work: () => Promise<T>): Promise<T> {
	const timer = setTimeout(() => closeQuietly(conn), ms);
	try {
		return await work();
	} finally {
		clearTimeout(timer);
	}
}

/** One clone step's forwarder: a unix socket in the run's socket folder, and the requests made through it. */
export class GitForwarder implements ProxyHandle {
	/** The remote's host, once a connection to it was made. */
	readonly reached = new Set<string>();
	/** The remote's host, when it had no public address or could not be reached. */
	readonly refused = new Set<string>();
	readonly #listener: Deno.Listener;
	readonly #conns = new Set<Deno.Conn>();
	readonly #serving = new Set<Promise<void>>();
	readonly #deps: ProxyDeps;
	readonly #runId: string;
	readonly #origin: ForwardOrigin;
	readonly #accepting: Promise<void>;
	#clients = 0;

	/** Serves requests arriving on `listener` (a unix socket in use; a TCP one in tests) for `origin`. */
	constructor(listener: Deno.Listener, deps: ProxyDeps, runId: string, origin: ForwardOrigin) {
		this.#listener = listener;
		this.#deps = deps;
		this.#runId = runId;
		this.#origin = origin;
		this.#accepting = this.#accept();
	}

	static open(path: string, deps: ProxyDeps, runId: string, origin: ForwardOrigin): GitForwarder {
		return new GitForwarder(Deno.listen({ transport: 'unix', path }), deps, runId, origin);
	}

	/** Stops listening and closes every connection: called when the clone step ends. */
	async close(): Promise<void> {
		try {
			this.#listener.close();
		} catch {
			// Already closed.
		}
		for (const conn of this.#conns) closeQuietly(conn);
		await this.#accepting;
		await Promise.allSettled([...this.#serving]);
	}

	async #accept(): Promise<void> {
		try {
			for await (const conn of this.#listener) {
				this.#conns.add(conn);
				const serving: Promise<void> = this.#serve(conn).finally(() => {
					this.#conns.delete(conn);
					this.#serving.delete(serving);
				});
				this.#serving.add(serving);
			}
		} catch {
			// The listener was closed.
		}
	}

	async #serve(client: Deno.Conn): Promise<void> {
		let upstream: Deno.Conn | null = null;
		this.#clients++;
		try {
			if (this.#clients > LIMITS.proxyTunnels) {
				return await reply(client, 429, 'Too Many Requests', 'Too many connections at once.');
			}
			const reader = new Reader(client);
			const text = await bounded(client, HEAD_TIMEOUT_MS, () => reader.head(HEAD_BYTES));
			const head = text === null ? null : parseHead(text);
			if (head === null || head.first.length !== 3 || head.first[2] !== 'HTTP/1.1') {
				return await reply(client, 400, 'Bad Request', 'No HTTP/1.1 request arrived.');
			}
			const route = ROUTES[`${head.first[0]} ${head.first[1]}`];
			if (route === undefined) {
				// git-receive-pack (a push), the dumb protocol, and anything else.
				this.#deps.log('forwarder.refused', { runId: this.#runId, method: head.first[0]!.slice(0, 16) });
				return await reply(client, 403, 'Forbidden', 'The sandbox forwards git-upload-pack only.');
			}
			const passed: string[] = [];
			for (const name of PASSED_REQUEST) {
				const value = single(head, name);
				if (value === undefined) continue;
				if (!HEADER_VALUE.test(value)) return await reply(client, 400, 'Bad Request', `${name} is not plain text.`);
				passed.push(`${name}: ${value}`);
			}
			const length = single(head, 'content-length');
			const chunked = /^chunked$/i.test(single(head, 'transfer-encoding') ?? '');
			if (head.fields.has('transfer-encoding') && !chunked) {
				return await reply(client, 400, 'Bad Request', 'Only chunked transfer coding is forwarded.');
			}
			let size = 0;
			if (length !== undefined) {
				if (chunked || !/^\d{1,12}$/.test(length)) return await reply(client, 400, 'Bad Request', 'Bad length.');
				size = Number(length);
				if (size > BODY_BYTES) return await reply(client, 413, 'Payload Too Large', 'The request is over 64 MiB.');
			}
			if (route.method === 'GET' && (chunked || size > 0)) {
				return await reply(client, 400, 'Bad Request', 'A ref advertisement has no body.');
			}
			if (route.method === 'POST' && !chunked && length === undefined) {
				return await reply(client, 411, 'Length Required', 'The request has no length.');
			}
			upstream = await this.#dial();
			if (upstream === null) return await reply(client, 502, 'Bad Gateway', 'The remote could not be reached.');
			if (route.method === 'POST' && /100-continue/i.test(single(head, 'expect') ?? '')) {
				await writeAll(client, encoder.encode('HTTP/1.1 100 Continue\r\n\r\n'));
			}
			const origin = this.#origin.origin;
			const lines = [
				`${route.method} ${origin.path}${route.suffix} HTTP/1.1`,
				`Host: ${origin.host}`,
				`User-Agent: ${USER_AGENT}`,
				...(this.#origin.authorization === null ? [] : [`Authorization: ${this.#origin.authorization}`]),
				...passed,
				...(route.method === 'POST' ? [chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${size}`] : []),
				'Connection: close',
				'',
				'',
			];
			await writeAll(upstream, encoder.encode(lines.join('\r\n')));
			if (route.method === 'POST') {
				if (chunked) await forwardChunked(reader, upstream);
				else await forwardLength(reader, upstream, size);
			}
			const answer = new Reader(upstream);
			const answerText = await bounded(upstream, UPSTREAM_HEAD_TIMEOUT_MS, () => answer.head(HEAD_BYTES));
			const answered = answerText === null ? null : parseHead(answerText);
			const status = Number(answered?.first[1]);
			if (answered === null || !/^HTTP\/1\.[01]$/.test(answered.first[0] ?? '') || !(status >= 200 && status < 600)) {
				return await reply(client, 502, 'Bad Gateway', 'The remote did not answer in HTTP/1.1.');
			}
			if (status >= 300 && status < 400) {
				// http.followRedirects=false in the cage too; here a redirect is not even passed on.
				this.#deps.log('forwarder.redirect_refused', { runId: this.#runId, status });
				return await reply(client, 502, 'Bad Gateway', 'The remote redirected; redirects are refused.');
			}
			const back = [`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Upstream'}`];
			for (const name of PASSED_RESPONSE) {
				for (const value of answered.fields.get(name) ?? []) {
					if (HEADER_VALUE.test(value)) back.push(`${name}: ${value}`);
				}
			}
			back.push('Connection: close', '', '');
			await writeAll(client, encoder.encode(back.join('\r\n')));
			// Both sides close after this answer, so its bytes pass through whatever framing it has.
			const rest = answer.take();
			if (rest.length > 0) await writeAll(client, rest);
			for (;;) {
				const chunk = await answer.some(READ_CHUNK);
				if (chunk === null) break;
				await writeAll(client, chunk);
			}
		} catch (error) {
			if (error instanceof Refusal) {
				await reply(client, error.status, error.reason, `${error.message}.`).catch(() => {});
			}
			// Otherwise either side went away; nothing to report.
		} finally {
			this.#clients--;
			closeQuietly(client);
			if (upstream !== null) {
				closeQuietly(upstream);
				this.#conns.delete(upstream);
			}
		}
	}

	/**
	 * A TLS connection to the remote: its name resolved here, only public addresses dialled (IPv4 first), then TLS with
	 * the remote's host name verified and sent as SNI. A certificate that does not verify ends the attempt: another
	 * address of the same name is not tried. Null when nothing could be reached.
	 */
	async #dial(): Promise<Deno.Conn | null> {
		const host = this.#origin.origin.host;
		const addresses = (await this.#deps.resolve(host)).filter(isPublicAddress);
		if (addresses.length === 0) {
			this.refused.add(host);
			this.#deps.log('forwarder.no_public_address', { runId: this.#runId, host });
			return null;
		}
		addresses.sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
		for (const address of addresses.slice(0, 4)) {
			let tcp: Deno.Conn;
			try {
				tcp = await this.#deps.connect(address, 443);
			} catch {
				continue;
			}
			let tls: Deno.Conn | null = null;
			// The TCP connection becomes the TLS one; a handshake that stalls is ended by closing both.
			const timer = setTimeout(() => {
				closeQuietly(tls);
				closeQuietly(tcp);
			}, TLS_TIMEOUT_MS);
			try {
				const startTls = this.#deps.startTls ??
					((conn: Deno.Conn, hostname: string) => Deno.startTls(conn as Deno.TcpConn, { hostname }));
				tls = await startTls(tcp, host);
				const handshake = (tls as Partial<Deno.TlsConn>).handshake;
				if (handshake !== undefined) await handshake.call(tls);
				this.#conns.add(tls);
				this.reached.add(host);
				return tls;
			} catch (error) {
				closeQuietly(tls);
				closeQuietly(tcp);
				this.#deps.log('forwarder.tls_failed', {
					runId: this.#runId,
					host,
					error: error instanceof Error ? error.name : 'error',
				});
				return null;
			} finally {
				clearTimeout(timer);
			}
		}
		this.refused.add(host);
		return null;
	}
}

/** A body of known length, `size` bytes, passed on as it arrives. */
async function forwardLength(reader: Reader, upstream: Deno.Conn, size: number): Promise<void> {
	let left = size;
	while (left > 0) {
		const chunk = await reader.some(Math.min(left, READ_CHUNK));
		if (chunk === null) throw new Refusal(400, 'Bad Request', 'the body ended early');
		await writeAll(upstream, chunk);
		left -= chunk.length;
	}
}

/** A chunked body, decoded and re-sent chunked, refused past 64 MiB in all. */
async function forwardChunked(reader: Reader, upstream: Deno.Conn): Promise<void> {
	let total = 0;
	for (;;) {
		const sizeLine = (await reader.line(1024)).split(';')[0]!.trim();
		if (!/^[0-9a-fA-F]{1,8}$/.test(sizeLine)) throw new Refusal(400, 'Bad Request', 'a bad chunk');
		const size = parseInt(sizeLine, 16);
		if (size === 0) {
			while ((await reader.line(HEAD_BYTES)) !== '');
			await writeAll(upstream, encoder.encode('0\r\n\r\n'));
			return;
		}
		total += size;
		if (total > BODY_BYTES) throw new Refusal(413, 'Payload Too Large', 'the request is over 64 MiB');
		await writeAll(upstream, encoder.encode(`${size.toString(16)}\r\n`));
		await forwardLength(reader, upstream, size);
		if ((await reader.line(2)) !== '') throw new Refusal(400, 'Bad Request', 'a bad chunk');
		await writeAll(upstream, encoder.encode('\r\n'));
	}
}
