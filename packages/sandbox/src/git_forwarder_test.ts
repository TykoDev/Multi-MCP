/**
 * R12 (design §2.19, AC32, AC34, M8): the credentialed clone's forwarder against a fake TLS upstream on loopback, with
 * a throwaway CA (testing_tls.ts) and a relay in front of it that records the server name each ClientHello asks for.
 * No external network: the "public" address the forwarder dials is mapped to the relay by its `connect` dependency.
 *
 * What is proven: only upload-pack is forwarded (push and every other path 403); the credential is added service-side
 * and the cage's own Authorization, Cookie and Host never pass; only checked public literals are dialled; TLS verifies
 * the remote's name and sends it as SNI over that literal dial (M8); a 3xx is refused, never passed on; bodies are
 * bounded and forwarded by length or chunked; nothing secret reaches a log line.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { DEFAULT_GIT_USERNAME, type ForwardOrigin, GitForwarder, parseGitRemotes } from './git_forwarder.ts';
import { type ProxyDeps } from './proxy.ts';
import { clientHelloServerName, testPki } from './testing_tls.ts';

const HOST = 'git.example.test';
const TOKEN = 'ghp_test_only_token_0123456789abcdef';
const AUTHORIZATION = `Basic ${btoa(`${DEFAULT_GIT_USERNAME}:${TOKEN}`)}`;
const PUBLIC = '93.184.216.34';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One request as the fake upstream received it. */
interface Received {
	method: string;
	target: string;
	headers: Record<string, string>;
	body: string;
}

/** What the fake upstream answers: a status, headers and a body. */
type Answer = { status: number; headers?: Record<string, string>; body?: string };

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function headEndOf(bytes: Uint8Array): number {
	for (let i = 0; i + 3 < bytes.length; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
	}
	return -1;
}

/** Decodes a chunked body that arrived whole. */
function dechunk(bytes: Uint8Array): Uint8Array {
	let out: Uint8Array = new Uint8Array(0);
	let at = 0;
	for (;;) {
		let end = at;
		while (!(bytes[end] === 13 && bytes[end + 1] === 10)) end++;
		const size = parseInt(decoder.decode(bytes.subarray(at, end)), 16);
		at = end + 2;
		if (size === 0) return out;
		out = concat(out, bytes.subarray(at, at + size));
		at += size + 2;
	}
}

/** A TLS upstream for HOST with a fresh CA, behind a relay that records SNI; it answers with `answer`. */
async function upstream(answer: (request: Received) => Answer) {
	const pki = await testPki([HOST]);
	const received: Received[] = [];
	const sni: (string | null)[] = [];
	const tls = Deno.listenTls({ hostname: '127.0.0.1', port: 0, cert: pki.cert, key: pki.key });
	const tasks: Promise<unknown>[] = [];
	const serving = (async () => {
		for await (const conn of tls) {
			tasks.push((async () => {
				try {
					let bytes: Uint8Array = new Uint8Array(0);
					const buffer = new Uint8Array(65536);
					let end = -1;
					while (end < 0) {
						const n = await conn.read(buffer);
						if (n === null) return;
						bytes = concat(bytes, buffer.subarray(0, n));
						end = headEndOf(bytes);
					}
					const [first, ...lines] = decoder.decode(bytes.subarray(0, end)).split('\r\n');
					const headers: Record<string, string> = {};
					for (const line of lines) {
						const colon = line.indexOf(':');
						headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
					}
					let body: Uint8Array = bytes.subarray(end + 4);
					if (headers['content-length'] !== undefined) {
						while (body.length < Number(headers['content-length'])) {
							const n = await conn.read(buffer);
							if (n === null) break;
							body = concat(body, buffer.subarray(0, n));
						}
					} else if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
						while (!decoder.decode(body.subarray(Math.max(0, body.length - 5))).endsWith('0\r\n\r\n')) {
							const n = await conn.read(buffer);
							if (n === null) break;
							body = concat(body, buffer.subarray(0, n));
						}
						body = dechunk(body);
					}
					const [method, target] = first!.split(' ');
					const request = { method: method!, target: target!, headers, body: decoder.decode(body) };
					received.push(request);
					const reply = answer(request);
					const text = reply.body ?? '';
					const head = [`HTTP/1.1 ${reply.status} X`, `Content-Length: ${encoder.encode(text).length}`];
					for (const [name, value] of Object.entries(reply.headers ?? {})) head.push(`${name}: ${value}`);
					await conn.write(encoder.encode(`${head.join('\r\n')}\r\nConnection: close\r\n\r\n${text}`));
				} catch {
					// The forwarder refused the certificate, or went away.
				} finally {
					try {
						conn.close();
					} catch {
						// closed
					}
				}
			})());
		}
	})().catch(() => {});
	// The relay: reads the ClientHello, records the name it asks for, then pipes both ways.
	const relay = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const relaying = (async () => {
		for await (const client of relay) {
			tasks.push((async () => {
				let up: Deno.Conn | null = null;
				try {
					let hello: Uint8Array = new Uint8Array(0);
					let name: string | null | undefined;
					const buffer = new Uint8Array(4096);
					while (name === undefined) {
						const n = await client.read(buffer);
						if (n === null) return;
						hello = concat(hello, buffer.subarray(0, n));
						name = clientHelloServerName(hello);
					}
					sni.push(name);
					up = await Deno.connect({ hostname: '127.0.0.1', port: (tls.addr as Deno.NetAddr).port });
					await up.write(hello);
					const target = up;
					await Promise.all([
						client.readable.pipeTo(target.writable).catch(() => {}),
						target.readable.pipeTo(client.writable).catch(() => {}),
					]);
				} catch {
					// Either side went away.
				}
			})());
		}
	})().catch(() => {});
	return {
		pki,
		received,
		sni,
		port: (relay.addr as Deno.NetAddr).port,
		close: async () => {
			tls.close();
			relay.close();
			await serving;
			await relaying;
			await Promise.allSettled(tasks);
		},
	};
}

type Upstream = Awaited<ReturnType<typeof upstream>>;

/** A forwarder for HOST on a TCP listener (unix sockets are the service's; the code path is the same). */
function forwarder(
	up: Upstream,
	options: { resolved?: string[]; trust?: boolean; origin?: Partial<ForwardOrigin['origin']>; auth?: string | null } =
		{},
) {
	const dialled: string[] = [];
	const logged: { event: string; fields: Record<string, unknown> }[] = [];
	const deps: ProxyDeps = {
		resolve: () => Promise.resolve(options.resolved ?? ['10.0.0.5', '127.0.0.1', PUBLIC]),
		connect: (address) => {
			dialled.push(address);
			return Deno.connect({ hostname: '127.0.0.1', port: up.port });
		},
		log: (event, fields) => logged.push({ event, fields }),
		// Trusts the throwaway CA only; without it, the system's roots (which do not know it) decide.
		...(options.trust === false ? {} : {
			startTls: (conn: Deno.Conn, hostname: string) =>
				Deno.startTls(conn as Deno.TcpConn, { hostname, caCerts: [up.pki.caCert] }),
		}),
	};
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const origin: ForwardOrigin = {
		origin: { url: `https://${HOST}/acme/app.git`, host: HOST, path: '/acme/app.git', ...options.origin },
		authorization: options.auth === undefined ? AUTHORIZATION : options.auth,
	};
	const instance = new GitForwarder(listener, deps, 'run', origin);
	return { instance, dialled, logged, port: (listener.addr as Deno.NetAddr).port };
}

/** Sends `request` raw to the forwarder and reads its whole answer. */
async function ask(port: number, request: string | Uint8Array): Promise<string> {
	const conn = await Deno.connect({ hostname: '127.0.0.1', port });
	try {
		await conn.write(typeof request === 'string' ? encoder.encode(request) : request);
		let text = '';
		const buffer = new Uint8Array(65536);
		for (;;) {
			const n = await conn.read(buffer);
			if (n === null) break;
			text += decoder.decode(buffer.subarray(0, n));
		}
		return text;
	} finally {
		try {
			conn.close();
		} catch {
			// closed
		}
	}
}

const ADVERTISEMENT = '001e# service=git-upload-pack\n0000';

Deno.test('R12 forwarder: the ref advertisement reaches the remote with the credential added service-side', async () => {
	const up = await upstream(() => ({
		status: 200,
		headers: {
			'Content-Type': 'application/x-git-upload-pack-advertisement',
			'Cache-Control': 'no-cache',
			'Set-Cookie': 'session=leak',
			'WWW-Authenticate': 'Basic realm="x"',
		},
		body: ADVERTISEMENT,
	}));
	const f = forwarder(up);
	try {
		const answer = await ask(
			f.port,
			'GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: 127.0.0.1:3128\r\nGit-Protocol: version=2\r\n' +
				'Accept: */*\r\nAuthorization: Basic Y2FnZTpzdG9sZW4=\r\nCookie: a=b\r\nX-Extra: 1\r\n' +
				'User-Agent: git/2.47\r\n\r\n',
		);
		assert(answer.startsWith('HTTP/1.1 200 '), answer);
		assertStringIncludes(answer, 'content-type: application/x-git-upload-pack-advertisement');
		assertStringIncludes(answer, 'cache-control: no-cache');
		assert(!/set-cookie|www-authenticate/i.test(answer), answer);
		assert(answer.endsWith(ADVERTISEMENT), answer);
		assertEquals(up.received.length, 1);
		const [request] = up.received;
		assertEquals([request!.method, request!.target], ['GET', '/acme/app.git/info/refs?service=git-upload-pack']);
		assertEquals(request!.headers, {
			host: HOST,
			'user-agent': 'git/tykotech-sandbox-forwarder',
			// The forwarder's credential, never the one the cage sent.
			authorization: AUTHORIZATION,
			'git-protocol': 'version=2',
			accept: '*/*',
			connection: 'close',
		});
		// M8: the literal dial carried the remote's name as SNI, and its certificate was verified for that name.
		assertEquals(up.sni, [HOST]);
		// Only the public literal of the three the name resolved to was dialled.
		assertEquals(f.dialled, [PUBLIC]);
		assertEquals([...f.instance.reached], [HOST]);
		assert(!JSON.stringify(f.logged).includes(TOKEN), 'no log line carries the token');
	} finally {
		await f.instance.close();
		await up.close();
	}
});

Deno.test('R12 forwarder: upload-pack bodies pass by length or chunked; a remote without a credential gets none', async () => {
	const up = await upstream((request) => ({
		status: 200,
		headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
		body: `0008NAK\n${request.body.length}`,
	}));
	const f = forwarder(up, { auth: null });
	try {
		const body = '0032want 0123456789012345678901234567890123456789\n00000009done\n';
		const byLength = await ask(
			f.port,
			`POST /r/git-upload-pack HTTP/1.1\r\nContent-Type: application/x-git-upload-pack-request\r\n` +
				`Content-Length: ${body.length}\r\n\r\n${body}`,
		);
		assert(byLength.startsWith('HTTP/1.1 200 '), byLength);
		assert(byLength.endsWith(`0008NAK\n${body.length}`), byLength);
		const chunked = await ask(
			f.port,
			`POST /r/git-upload-pack HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Encoding: gzip\r\n` +
				`Expect: 100-continue\r\n\r\n${(10).toString(16)}\r\n${body.slice(0, 10)}\r\n` +
				`${(body.length - 10).toString(16)};ext=1\r\n${body.slice(10)}\r\n0\r\n\r\n`,
		);
		// curl's Expect: 100-continue is answered, then the answer follows.
		assert(chunked.startsWith('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 '), chunked);
		assertEquals(up.received.map((r) => [r.method, r.target, r.body]), [
			['POST', '/acme/app.git/git-upload-pack', body],
			['POST', '/acme/app.git/git-upload-pack', body],
		]);
		assertEquals(up.received[0]!.headers['content-length'], String(body.length));
		assertEquals(up.received[1]!.headers['transfer-encoding'], 'chunked');
		assertEquals(up.received[1]!.headers['content-encoding'], 'gzip');
		for (const request of up.received) assertEquals(request.headers.authorization, undefined);
	} finally {
		await f.instance.close();
		await up.close();
	}
});

Deno.test('R12 forwarder: a push, any other path and any other method are refused before the remote is dialled', async () => {
	const up = await upstream(() => ({ status: 200 }));
	const f = forwarder(up);
	try {
		for (
			const head of [
				'POST /r/git-receive-pack HTTP/1.1\r\nContent-Length: 0\r\n\r\n',
				'GET /r/info/refs?service=git-receive-pack HTTP/1.1\r\n\r\n',
				'GET /r/info/refs HTTP/1.1\r\n\r\n',
				'GET /r/HEAD HTTP/1.1\r\n\r\n',
				'GET /r/objects/info/packs HTTP/1.1\r\n\r\n',
				'POST /r/info/refs?service=git-upload-pack HTTP/1.1\r\nContent-Length: 0\r\n\r\n',
				'GET /r/git-upload-pack HTTP/1.1\r\n\r\n',
				'GET /acme/app.git/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n',
				'GET /r/../info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n',
				'CONNECT git.example.test:443 HTTP/1.1\r\n\r\n',
				'GET https://git.example.test/acme/app.git/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n',
			]
		) {
			const answer = await ask(f.port, head);
			assert(answer.startsWith('HTTP/1.1 403 '), `${head}: ${answer}`);
			assertStringIncludes(answer, 'Connection: close');
		}
		const malformed = [
			'GET /r/info/refs?service=git-upload-pack HTTP/1.0\r\n\r\n',
			'hello\r\n\r\n',
			'POST /r/git-upload-pack HTTP/1.1\r\n\r\n',
			'POST /r/git-upload-pack HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n',
			'POST /r/git-upload-pack HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n',
			'GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello',
			'GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\n folded: header\r\n\r\n',
			`GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\nGit-Protocol: ${'é'}\r\n\r\n`,
			`GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\nX: ${'a'.repeat(17 * 1024)}\r\n\r\n`,
		];
		for (const head of malformed) {
			const answer = await ask(f.port, head);
			assert(/^HTTP\/1\.1 4\d\d /.test(answer), `${head.slice(0, 80)}: ${answer}`);
		}
		const huge = await ask(f.port, 'POST /r/git-upload-pack HTTP/1.1\r\nContent-Length: 67108865\r\n\r\n');
		assert(huge.startsWith('HTTP/1.1 413 '), huge);
		assertEquals(up.received, []);
		assertEquals(f.dialled, []);
		assert(f.logged.some((line) => line.event === 'forwarder.refused'));
	} finally {
		await f.instance.close();
		await up.close();
	}
});

Deno.test('R12 forwarder: a redirect from the remote is refused, never passed on', async () => {
	const up = await upstream(() => ({ status: 301, headers: { Location: 'https://evil.example/steal' } }));
	const f = forwarder(up);
	try {
		const answer = await ask(f.port, 'GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n');
		assert(answer.startsWith('HTTP/1.1 502 '), answer);
		assert(!answer.includes('evil.example'), answer);
		assertEquals(up.received.length, 1);
		assert(f.logged.some((line) => line.event === 'forwarder.redirect_refused'));
	} finally {
		await f.instance.close();
		await up.close();
	}
});

Deno.test('R12 forwarder: a remote that resolves only inward is never dialled', async () => {
	const up = await upstream(() => ({ status: 200 }));
	const f = forwarder(up, { resolved: ['127.0.0.1', '10.1.2.3', '169.254.169.254', 'fd00::1', '::1'] });
	try {
		const answer = await ask(f.port, 'GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n');
		assert(answer.startsWith('HTTP/1.1 502 '), answer);
		assertEquals(f.dialled, []);
		assertEquals([...f.instance.refused], [HOST]);
		assertEquals(up.received, []);
	} finally {
		await f.instance.close();
		await up.close();
	}
});

Deno.test("R12 forwarder (M8): TLS verifies the remote's own name; another name or an unknown CA ends the request", async () => {
	const up = await upstream(() => ({ status: 200, body: 'never' }));
	// The certificate is for HOST; a remote of another name is refused although the connection reaches the server.
	const named = forwarder(up, { origin: { host: 'other.example.test', url: 'https://other.example.test/a.git' } });
	// The system's roots, which do not know the throwaway CA.
	const untrusted = forwarder(up, { trust: false });
	try {
		for (const f of [named, untrusted]) {
			const answer = await ask(f.port, 'GET /r/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n');
			assert(answer.startsWith('HTTP/1.1 502 '), answer);
			assert(f.logged.some((line) => line.event === 'forwarder.tls_failed'), JSON.stringify(f.logged));
			assertEquals([...f.instance.reached], []);
		}
		// Each sent the name it was verifying as SNI; neither got a request through.
		assertEquals(up.sni, ['other.example.test', HOST]);
		assertEquals(up.received, []);
	} finally {
		await named.instance.close();
		await untrusted.instance.close();
		await up.close();
	}
});

Deno.test('R12 remotes: the file is a bounded list of ids, URLs and optional credentials, refused without echoing them', () => {
	const parsed = parseGitRemotes(JSON.stringify([
		{ id: 'app', url: 'https://github.com/acme/app.git', token: TOKEN },
		{ id: 'docs.site', url: 'https://gitlab.example.org/team/docs', username: 'bot', token: 'glpat-xyz123' },
		{ id: 'public-mirror', url: 'https://git.example.test/mirror.git' },
	]));
	assertEquals(parsed.remotes.map((remote) => [remote.id, remote.origin.url]), [
		['app', 'https://github.com/acme/app.git'],
		['docs.site', 'https://gitlab.example.org/team/docs'],
		['public-mirror', 'https://git.example.test/mirror.git'],
	]);
	assertEquals(parsed.remotes[0]!.authorization, AUTHORIZATION);
	assertEquals(parsed.remotes[1]!.authorization, `Basic ${btoa('bot:glpat-xyz123')}`);
	assertEquals(parsed.remotes[2]!.authorization, null);
	// Every form the credential takes is handed back to be guarded in the log.
	for (const secret of [TOKEN, btoa(`${DEFAULT_GIT_USERNAME}:${TOKEN}`), AUTHORIZATION, 'glpat-xyz123']) {
		assert(parsed.secrets.includes(secret));
	}
	const refused: [unknown, string][] = [
		['not json', 'not JSON'],
		[{ id: 'a' }, 'list'],
		[[{ id: 'a', url: 'https://github.com/a.git', password: 'x' }], 'a field other than'],
		[[{ id: '-a', url: 'https://github.com/a.git' }], 'needs an id'],
		[[{ id: 'a', url: 'https://github.com/a.git' }, { id: 'a', url: 'https://github.com/b.git' }], 'repeats an id'],
		[[{ id: 'a', url: 'http://github.com/a.git' }], 'url must be https'],
		[[{ id: 'a', url: `https://x:${TOKEN}@github.com/a.git` }], 'url must be https'],
		[[{ id: 'a', url: 'https://github.com:8443/a.git' }], 'url must be https'],
		[[{ id: 'a', url: 'https://10.0.0.1/a.git' }], 'url must name its host by a DNS name'],
		[[{ id: 'a', url: 'https://github.com/a.git', username: 'u:v', token: TOKEN }], 'username'],
		[[{ id: 'a', url: 'https://github.com/a.git', token: `${TOKEN} x` }], 'token'],
		[[{ id: 'a', url: 'https://github.com/a.git', username: 'u' }], 'username without a token'],
		[[{ id: 'a', url: 'https://github.com/a.git', token: 'x'.repeat(70 * 1024) }], '64 KiB'],
	];
	for (const [value, why] of refused) {
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		const error = assertThrows(() => parseGitRemotes(text), Error);
		assertStringIncludes(error.message, why, text.slice(0, 80));
		assertStringIncludes(error.message, 'TTK_SANDBOX_GIT_REMOTES_FILE');
		assert(!error.message.includes(TOKEN), 'a refusal never echoes the token');
	}
});
