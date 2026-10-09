/**
 * The registry proxy: how a cage that asked for `network: "registries"` downloads packages.
 *
 * The cage still has no network interface of its own. For each such command the service opens a
 * unix socket, binds it into the cage, and a forwarder inside the cage (socat) turns it into
 * 127.0.0.1:3128, which the cage's proxy variables name. What arrives here is an HTTP proxy
 * request, and only one kind is served:
 *
 * - `CONNECT host:443`, a tunnel for https. Plain http, other ports, and IP addresses are refused.
 * - The host must be on REGISTRY_HOSTS, exactly.
 * - The proxy resolves the name itself and connects to an address it checked: private, loopback,
 *   link-local (and so cloud metadata), carrier-grade NAT, multicast and reserved addresses are
 *   refused, so a name that resolves inward leads nowhere.
 *
 * TLS runs end to end between the program in the cage and the registry; the proxy sees names, not
 * content. So it limits where a cage can connect, not what it sends there: a command holding a
 * registry token of its own could still publish to that registry. Nothing secret belongs in a
 * checkout.
 *
 * R12 (design §2.19, D-131): the same proxy serves a public git clone's one step, opened with the
 * operator's git hosts (`TTK_SANDBOX_GIT_HOSTS`) in place of the registries. That host set is chosen
 * by the service for the clone step alone (the internal `git` network, request.ts); no caller can
 * ask for it, and a registries-mode command never reaches a git host through it.
 */
import { LIMITS } from './limits.ts';

/**
 * Where a cage may download from, and why each is here. Names match exactly: a subdomain of a
 * listed host is not listed.
 */
export const REGISTRY_HOSTS: ReadonlyMap<string, string> = new Map([
	['registry.npmjs.org', 'npm: package metadata and tarballs'],
	['registry.yarnpkg.com', 'npm again, under the name yarn.lock files record'],
	['jsr.io', 'JSR: packages for Deno and npm'],
	['npm.jsr.io', 'JSR packages installed through npm or pnpm'],
	['deno.land', 'deno.land/x and deno.land/std modules'],
	['dl.deno.land', "Deno's own downloads, such as the runtime deno compile embeds"],
	['pypi.org', 'PyPI: the package index'],
	['files.pythonhosted.org', 'PyPI: the package files the index points to'],
	['crates.io', 'Rust crates: the API, which redirects downloads to static.crates.io'],
	['static.crates.io', 'Rust crates: the downloads'],
	['index.crates.io', 'Rust crates: the sparse index cargo reads'],
	['proxy.golang.org', 'Go modules'],
	['sum.golang.org', "Go's checksum database, which go verifies modules against"],
]);

export type Target = { host: string; port: number } | { refused: string };

/**
 * The exact host names one proxy admits: REGISTRY_HOSTS for a registries-mode command, the operator's git hosts for
 * a public clone's step (R12). Only membership is read, so a `Map` of reasons and a plain `Set` both serve.
 */
export type HostSet = { has(host: string): boolean };

/** The host and port a CONNECT names, or why it is refused; `hosts` is the set this proxy admits. */
export function checkTarget(target: string, hosts: HostSet = REGISTRY_HOSTS): Target {
	const registries = hosts === REGISTRY_HOSTS;
	const match = /^([^\s:[\]]+):(\d{1,5})$/.exec(target);
	if (!match) return { refused: 'name a host and a port, like registry.npmjs.org:443' };
	const host = match[1]!.toLowerCase().replace(/\.$/, '');
	const port = Number(match[2]);
	if (/^[\d.]+$/.test(host)) return { refused: 'connect to a registry by name, not by address' };
	if (!hosts.has(host)) {
		return { refused: registries ? `${host} is not a package registry` : `${host} is not a git host` };
	}
	if (port !== 443) return { refused: 'registries are reached over https, on port 443' };
	return { host, port };
}

/** IPv4 ranges a registry never lives in (RFC 6890 and its successors), as [address, bits]. */
const V4_REFUSED: [string, number][] = [
	['0.0.0.0', 8], // "this network"
	['10.0.0.0', 8], // private
	['100.64.0.0', 10], // carrier-grade NAT
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local, and so cloud metadata at 169.254.169.254
	['172.16.0.0', 12], // private, and Docker's own networks
	['192.0.0.0', 24], // IETF protocol assignments
	['192.0.2.0', 24], // documentation
	['192.31.196.0', 24], // AS112
	['192.52.193.0', 24], // AMT
	['192.88.99.0', 24], // 6to4 relays
	['192.168.0.0', 16], // private
	['192.175.48.0', 24], // AS112
	['198.18.0.0', 15], // benchmarking
	['198.51.100.0', 24], // documentation
	['203.0.113.0', 24], // documentation
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4], // reserved, and broadcast
];

/** IPv6 ranges refused inside global unicast (2000::/3); everything outside it is refused too. */
const V6_REFUSED: [string, number][] = [
	['2001::', 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
	['2001:db8::', 32], // documentation
	['2002::', 16], // 6to4, which would carry any IPv4 address inside it
	['3fff::', 20], // documentation
];

function parseV4(text: string): Uint8Array | null {
	const parts = text.split('.');
	if (parts.length !== 4) return null;
	const out = new Uint8Array(4);
	for (const [i, part] of parts.entries()) {
		if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
		out[i] = Number(part);
	}
	return out;
}

function parseV6(text: string): Uint8Array | null {
	if (text.includes('%')) return null;
	let body = text;
	let tail: Uint8Array | null = null;
	const lastColon = body.lastIndexOf(':');
	if (body.includes('.')) {
		tail = parseV4(body.slice(lastColon + 1));
		if (!tail) return null;
		body = `${body.slice(0, lastColon + 1)}0:0`;
	}
	const halves = body.split('::');
	if (halves.length > 2) return null;
	const groups = (s: string) => (s === '' ? [] : s.split(':'));
	const left = groups(halves[0]!);
	const right = halves.length === 2 ? groups(halves[1]!) : [];
	const missing = 8 - left.length - right.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const all = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
	const out = new Uint8Array(16);
	for (const [i, group] of all.entries()) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		const value = parseInt(group, 16);
		out[i * 2] = value >> 8;
		out[i * 2 + 1] = value & 0xff;
	}
	if (tail) out.set(tail, 12);
	return out;
}

function within(address: Uint8Array, prefix: Uint8Array, bits: number): boolean {
	for (let i = 0; i < bits; i++) {
		const mask = 0x80 >> (i % 8);
		if ((address[i >> 3]! & mask) !== (prefix[i >> 3]! & mask)) return false;
	}
	return true;
}

const V4_TABLE = V4_REFUSED.map(([a, bits]) => [parseV4(a)!, bits] as const);
const V6_TABLE = V6_REFUSED.map(([a, bits]) => [parseV6(a)!, bits] as const);
const NAT64 = parseV6('64:ff9b::')!;

function publicV4(address: Uint8Array): boolean {
	return !V4_TABLE.some(([prefix, bits]) => within(address, prefix, bits));
}

/** Whether the proxy may connect to this address: a public one, and nothing else. */
export function isPublicAddress(text: string): boolean {
	const v4 = parseV4(text);
	if (v4) return publicV4(v4);
	const v6 = parseV6(text);
	if (!v6) return false;
	// NAT64 (64:ff9b::/96) carries an IPv4 address, which decides; on an IPv6-only host with DNS64,
	// that is how every registry looks.
	if (within(v6, NAT64, 96)) return publicV4(v6.subarray(12));
	if ((v6[0]! & 0xe0) !== 0x20) return false;
	return !V6_TABLE.some(([prefix, bits]) => within(v6, prefix, bits));
}

export interface ProxyDeps {
	/** Every address a name resolves to, IPv4 and IPv6. */
	resolve(host: string): Promise<string[]>;
	connect(address: string, port: number): Promise<Deno.Conn>;
	log(event: string, fields: Record<string, unknown>): void;
	/**
	 * R12 (M8): TLS over a connection already dialled to a checked literal, verifying the certificate for `hostname`
	 * and sending it as SNI — the credentialed clone forwarder's upstream (git_forwarder.ts). `Deno.startTls` unless a
	 * test names a client that trusts its own throwaway CA. The CONNECT proxy never terminates TLS and never calls it.
	 */
	startTls?(conn: Deno.Conn, hostname: string): Promise<Deno.Conn>;
}

/**
 * What a command's proxy socket is served by while the command runs: the registry proxy, or for a clone's step the
 * git-host proxy or the credentialed forwarder (git_forwarder.ts). Each records the hosts it reached and refused, for
 * the reply, and is closed when the command ends.
 */
export interface ProxyHandle {
	readonly reached: ReadonlySet<string>;
	readonly refused: ReadonlySet<string>;
	close(): Promise<void>;
}

/**
 * R12: opens what serves a clone step's proxy socket at `path` (the internal `git` network, request.ts), with the
 * backend's own proxy dependencies. Built by the workspace service for one clone, never from a request.
 */
export type OpenEgress = (path: string, deps: ProxyDeps, runId: string) => ProxyHandle;

const HEAD_BYTES = 8 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const REFUSAL_TOTAL_EVERY_MS = 60_000;
const encoder = new TextEncoder();

export const defaultProxyDeps = (log: ProxyDeps['log']): ProxyDeps => ({
	async resolve(host) {
		const signal = AbortSignal.timeout(5_000);
		const answers = await Promise.allSettled([
			Deno.resolveDns(host, 'A', { signal }),
			Deno.resolveDns(host, 'AAAA', { signal }),
		]);
		return answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : []));
	},
	async connect(address, port) {
		const attempt = Deno.connect({ hostname: address, port });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('connect timed out')), CONNECT_TIMEOUT_MS);
		});
		try {
			return await Promise.race([attempt, late]);
		} catch (err) {
			attempt.then((conn) => conn.close(), () => {});
			throw err;
		} finally {
			clearTimeout(timer);
		}
	},
	// M8 (measured on Deno 2.9.7): verifies the certificate for `hostname` and sends it as SNI over a literal dial.
	startTls: (conn, hostname) => Deno.startTls(conn as Deno.TcpConn, { hostname }),
	log,
});

/** One command's proxy: a unix socket, and the tunnels opened through it. */
export class RegistryProxy implements ProxyHandle {
	/** Hosts a command asked for and was refused, for the reply. */
	readonly refused = new Set<string>();
	/** Hosts a tunnel was opened to. */
	readonly reached = new Set<string>();
	readonly #listener: Deno.Listener;
	readonly #conns = new Set<Deno.Conn>();
	readonly #serving = new Set<Promise<void>>();
	#clients = 0;
	/** SB-9: refusals so far, and when a running total was last logged. */
	#refusals = 0;
	#totalLoggedAt = 0;
	readonly #deps: ProxyDeps;
	readonly #runId: string;
	readonly #hosts: HostSet;
	readonly #accepting: Promise<void>;

	/**
	 * Serves proxy requests arriving on `listener`, a unix socket in use (a TCP one in tests), admitting `hosts`: the
	 * registries, unless a clone's step opened it with the git hosts (R12).
	 */
	constructor(listener: Deno.Listener, deps: ProxyDeps, runId: string, hosts: HostSet = REGISTRY_HOSTS) {
		this.#listener = listener;
		this.#deps = deps;
		this.#runId = runId;
		this.#hosts = hosts;
		this.#accepting = this.#accept();
	}

	static open(path: string, deps: ProxyDeps, runId: string, hosts: HostSet = REGISTRY_HOSTS): RegistryProxy {
		return new RegistryProxy(Deno.listen({ transport: 'unix', path }), deps, runId, hosts);
	}

	/** Stops listening and closes every tunnel: called when the command ends. */
	async close(): Promise<void> {
		try {
			this.#listener.close();
		} catch {
			// Already closed.
		}
		for (const conn of this.#conns) closeQuietly(conn);
		await this.#accepting;
		await Promise.allSettled([...this.#serving]);
		if (this.#refusals > LIMITS.refusalsLogged) {
			this.#deps.log('proxy.refused_total', { runId: this.#runId, refused: this.#refusals, final: true });
		}
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
			const head = await readHead(client);
			if (!head) return await reply(client, 400, 'Bad Request', 'No proxy request arrived.');
			const [method, target] = head.text.split('\r\n', 1)[0]!.split(' ');
			if (method !== 'CONNECT' || !target) {
				return await reply(
					client,
					405,
					'Method Not Allowed',
					"The sandbox's proxy only opens https tunnels (CONNECT) to package registries.",
				);
			}
			const checked = checkTarget(target, this.#hosts);
			if ('refused' in checked) return await this.#refuse(client, target, checked.refused);
			const addresses = (await this.#deps.resolve(checked.host)).filter(isPublicAddress);
			if (addresses.length === 0) {
				return await this.#refuse(
					client,
					checked.host,
					`${checked.host} has no public address`,
					502,
				);
			}
			// IPv4 first: a Docker network often has no IPv6 route at all.
			addresses.sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
			for (const address of addresses.slice(0, 4)) {
				try {
					upstream = await this.#deps.connect(address, checked.port);
					break;
				} catch {
					// Try the next address.
				}
			}
			if (!upstream) {
				return await reply(
					client,
					502,
					'Bad Gateway',
					`${checked.host} did not answer from any of its addresses.`,
				);
			}
			this.#conns.add(upstream);
			this.reached.add(checked.host);
			await writeAll(client, encoder.encode('HTTP/1.1 200 Connection established\r\n\r\n'));
			if (head.rest.length > 0) await writeAll(upstream, head.rest);
			await Promise.all([pump(client, upstream), pump(upstream, client)]);
		} catch {
			// Either side went away; nothing to report.
		} finally {
			this.#clients--;
			closeQuietly(client);
			if (upstream) {
				closeQuietly(upstream);
				this.#conns.delete(upstream);
			}
		}
	}

	async #refuse(client: Deno.Conn, host: string, why: string, status = 403): Promise<void> {
		if (this.refused.size < LIMITS.refusedHostsListed) this.refused.add(host.slice(0, 255));
		// SB-9: a command can ask as often as it likes; the log gets the first few, then a total at most
		// once a minute and once more when the command ends.
		this.#refusals++;
		if (this.#refusals <= LIMITS.refusalsLogged) {
			this.#deps.log('proxy.refused', { runId: this.#runId, host: host.slice(0, 255), why });
		} else if (Date.now() - this.#totalLoggedAt >= REFUSAL_TOTAL_EVERY_MS) {
			this.#totalLoggedAt = Date.now();
			this.#deps.log('proxy.refused_total', { runId: this.#runId, refused: this.#refusals, final: false });
		}
		await reply(client, status, status === 403 ? 'Forbidden' : 'Bad Gateway', `${why}.`);
	}
}

async function readHead(conn: Deno.Conn): Promise<{ text: string; rest: Uint8Array } | null> {
	const buffer = new Uint8Array(HEAD_BYTES);
	let length = 0;
	const timer = setTimeout(() => closeQuietly(conn), HEAD_TIMEOUT_MS);
	try {
		while (length < buffer.length) {
			const n = await conn.read(buffer.subarray(length));
			if (n === null) return null;
			length += n;
			const end = headEnd(buffer.subarray(0, length));
			if (end >= 0) {
				return {
					text: new TextDecoder('latin1').decode(buffer.subarray(0, end)),
					rest: buffer.slice(end + 4, length),
				};
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Where the blank line that ends an HTTP head starts, or -1. */
export function headEnd(bytes: Uint8Array): number {
	for (let i = 0; i + 3 < bytes.length; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
			return i;
		}
	}
	return -1;
}

async function pump(from: Deno.Conn, to: Deno.Conn): Promise<void> {
	const buffer = new Uint8Array(64 * 1024);
	try {
		for (;;) {
			const n = await from.read(buffer);
			if (n === null) break;
			await writeAll(to, buffer.subarray(0, n));
		}
		// Half-close: the other direction may still be talking.
		await to.closeWrite();
	} catch {
		closeQuietly(from);
		closeQuietly(to);
	}
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
	let written = 0;
	while (written < bytes.length) written += await conn.write(bytes.subarray(written));
}

async function reply(conn: Deno.Conn, status: number, reason: string, message: string) {
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

function closeQuietly(conn: Deno.Conn): void {
	try {
		conn.close();
	} catch {
		// Already closed.
	}
}
