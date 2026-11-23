import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	checkTarget,
	clientHelloSni,
	isPublicAddress,
	type ProxyDeps,
	REGISTRY_HOSTS,
	RegistryProxy,
} from './proxy.ts';
import { LIMITS } from './limits.ts';

Deno.test('proxy: only a listed registry, by name, on 443', () => {
	assertEquals(checkTarget('registry.npmjs.org:443'), { host: 'registry.npmjs.org', port: 443 });
	assertEquals(checkTarget('PyPI.org.:443'), { host: 'pypi.org', port: 443 });
	const refused = (target: string) => {
		const result = checkTarget(target);
		assert('refused' in result, target);
		return result.refused;
	};
	assertStringIncludes(refused('example.com:443'), 'not a package registry');
	assertStringIncludes(refused('github.com:443'), 'not a package registry');
	// A subdomain, or a name that only ends like a registry, is not the registry.
	assertStringIncludes(refused('evil.registry.npmjs.org:443'), 'not a package registry');
	assertStringIncludes(refused('registry.npmjs.org.evil.com:443'), 'not a package registry');
	assertStringIncludes(refused('registry.npmjs.org:80'), 'port 443');
	assertStringIncludes(refused('registry.npmjs.org:22'), 'port 443');
	assertStringIncludes(refused('104.16.0.35:443'), 'by name');
	assertStringIncludes(refused('[2606:4700::6810:84e5]:443'), 'host and a port');
	assertStringIncludes(refused('registry.npmjs.org'), 'host and a port');
	assertStringIncludes(refused('user@registry.npmjs.org:443'), 'not a package registry');
});

Deno.test('proxy: the allow-list is what the docs promise', () => {
	assertEquals([...REGISTRY_HOSTS.keys()].sort(), [
		'crates.io',
		'deno.land',
		'dl.deno.land',
		'files.pythonhosted.org',
		'index.crates.io',
		'jsr.io',
		'npm.jsr.io',
		'proxy.golang.org',
		'pypi.org',
		'registry.npmjs.org',
		'registry.yarnpkg.com',
		'static.crates.io',
		'sum.golang.org',
	]);
	for (const reason of REGISTRY_HOSTS.values()) assert(reason.length > 5);
});

Deno.test('proxy: only public addresses are reached, after resolving', () => {
	const refused = [
		'0.0.0.0',
		'10.1.2.3',
		'100.64.0.1',
		'100.127.255.254',
		'127.0.0.1',
		'127.8.8.8',
		'169.254.169.254', // cloud metadata
		'169.254.0.1',
		'172.16.0.1',
		'172.17.0.2', // Docker's default bridge
		'172.31.255.255',
		'192.168.1.217', // the LAN
		'192.0.0.8',
		'192.0.2.1',
		'198.18.0.1',
		'198.51.100.7',
		'203.0.113.9',
		'224.0.0.251',
		'239.255.255.250',
		'240.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'fe80::1',
		'fe80::1%eth0',
		'fc00::1',
		'fd00:ec2::254', // AWS metadata over IPv6
		'ff02::1',
		'::ffff:127.0.0.1',
		'::ffff:8.8.8.8', // IPv4-mapped: never an answer a registry gives
		'64:ff9b::a00:1', // NAT64 of 10.0.0.1
		'64:ff9b::7f00:1', // NAT64 of 127.0.0.1
		'64:ff9b:1::1', // local-use NAT64
		'2001::1', // Teredo
		'2001:db8::1',
		'2002:a00:1::1', // 6to4 of 10.0.0.1
		'3fff::1',
		'not an address',
		'1.2.3',
		'1.2.3.256',
		'1:2:3:4:5:6:7:8:9',
		'1::2::3',
	];
	for (const address of refused) assertEquals(isPublicAddress(address), false, address);
	const allowed = [
		'104.16.0.35', // registry.npmjs.org, Cloudflare
		'151.101.0.223', // pypi.org, Fastly
		'8.8.8.8',
		'100.63.255.255', // just below carrier-grade NAT
		'172.15.255.255', // just outside 172.16/12
		'172.32.0.1',
		'2606:4700::6810:84e5',
		'2a04:4e42::223',
		'64:ff9b::6810:23', // NAT64 of 104.16.0.35
	];
	for (const address of allowed) assertEquals(isPublicAddress(address), true, address);
});

/** A proxy on a TCP port, whose "registry" is a local echo server, whatever the name resolves to. */
async function withProxy(
	resolved: string[],
	test: (port: number, proxy: RegistryProxy, dialled: string[]) => Promise<void>,
) {
	const echo = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const handlers: Promise<void>[] = [];
	const echoing = (async () => {
		for await (const conn of echo) {
			handlers.push((async () => {
				const buffer = new Uint8Array(1024);
				try {
					for (;;) {
						const n = await conn.read(buffer);
						if (n === null) break;
						await conn.write(buffer.subarray(0, n));
					}
				} catch {
					// closed
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
	const dialled: string[] = [];
	const logged: string[] = [];
	const deps: ProxyDeps = {
		resolve: () => Promise.resolve(resolved),
		connect: (address) => {
			dialled.push(address);
			return Deno.connect({ hostname: '127.0.0.1', port: (echo.addr as Deno.NetAddr).port });
		},
		log: (event) => logged.push(event),
	};
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const proxy = new RegistryProxy(listener, deps, 'run');
	try {
		await test((listener.addr as Deno.NetAddr).port, proxy, dialled);
	} finally {
		await proxy.close();
		echo.close();
		await echoing;
		await Promise.allSettled(handlers);
	}
}

async function ask(port: number, head: string | Uint8Array, then?: string | Uint8Array): Promise<string> {
	const conn = await Deno.connect({ hostname: '127.0.0.1', port });
	await conn.write(typeof head === 'string' ? new TextEncoder().encode(head) : head);
	let text = '';
	const buffer = new Uint8Array(4096);
	try {
		for (;;) {
			const n = await conn.read(buffer);
			if (n === null) break;
			text += new TextDecoder().decode(buffer.subarray(0, n));
			if (then !== undefined && text.includes('\r\n\r\n')) {
				await conn.write(typeof then === 'string' ? new TextEncoder().encode(then) : then);
				then = undefined;
			} else if (text.includes('\r\n\r\n') && text.includes('pong')) {
				break;
			}
		}
	} finally {
		conn.close();
	}
	return text;
}

Deno.test('proxy: a registry gets a tunnel, to the address that was checked', async () => {
	await withProxy(['10.0.0.5', '104.16.0.35'], async (port, proxy, dialled) => {
		const text = await ask(
			port,
			'CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n',
			join(clientHello(['registry.npmjs.org']), 'pong'),
		);
		assertStringIncludes(text, 'HTTP/1.1 200 Connection established\r\n\r\n');
		assertStringIncludes(text, 'pong');
		// The private address the name also resolved to was never dialled.
		assertEquals(dialled, ['104.16.0.35']);
		assertEquals([...proxy.reached], ['registry.npmjs.org']);
	});
});

Deno.test('proxy: bytes sent with the request reach the registry too', async () => {
	await withProxy(['104.16.0.35'], async (port) => {
		const text = await ask(port, join('CONNECT jsr.io:443 HTTP/1.1\r\n\r\n', clientHello(['jsr.io']), 'pong'));
		assertStringIncludes(text, '200 Connection established');
		assertStringIncludes(text, 'pong');
	});
});

Deno.test('proxy: everything else is refused, and the refusals are listed', async () => {
	await withProxy(['104.16.0.35'], async (port, proxy, dialled) => {
		const cases: [string, string][] = [
			['CONNECT example.com:443 HTTP/1.1\r\n\r\n', '403'],
			['CONNECT registry.npmjs.org:80 HTTP/1.1\r\n\r\n', '403'],
			['CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n', '403'],
			['GET http://registry.npmjs.org/left-pad HTTP/1.1\r\n\r\n', '405'],
			['hello\r\n\r\n', '405'],
		];
		for (const [head, status] of cases) {
			const text = await ask(port, head);
			assert(text.startsWith(`HTTP/1.1 ${status} `), `${head}: ${text}`);
			assertStringIncludes(text, 'Connection: close');
		}
		assertEquals(dialled, []);
		assertEquals([...proxy.refused].sort(), [
			'169.254.169.254:443',
			'example.com:443',
			'registry.npmjs.org:80',
		]);
	});
});

Deno.test('proxy: a registry that resolves only inward is not reached', async () => {
	await withProxy(['127.0.0.1', '169.254.169.254', 'fd00::1'], async (port, proxy, dialled) => {
		const text = await ask(port, 'CONNECT pypi.org:443 HTTP/1.1\r\n\r\n');
		assert(text.startsWith('HTTP/1.1 502 '), text);
		assertStringIncludes(text, 'no public address');
		assertEquals(dialled, []);
		assertEquals([...proxy.refused], ['pypi.org']);
	});
});

Deno.test('proxy: a command refused over and over logs the first few, then totals', async () => {
	const logged: { event: string; fields: Record<string, unknown> }[] = [];
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const proxy = new RegistryProxy(listener, {
		resolve: () => Promise.resolve([]),
		connect: () => Promise.reject(new Error('never dialled')),
		log: (event, fields) => logged.push({ event, fields }),
	}, 'run');
	const port = (listener.addr as Deno.NetAddr).port;
	try {
		for (let i = 0; i < LIMITS.refusalsLogged + 15; i++) {
			assert((await ask(port, `CONNECT host${i}.example:443 HTTP/1.1\r\n\r\n`)).startsWith('HTTP/1.1 403 '));
		}
	} finally {
		await proxy.close();
	}
	const events = logged.map((line) => line.event);
	assertEquals(events.filter((event) => event === 'proxy.refused').length, LIMITS.refusalsLogged);
	// One running total once past the first few (at most one a minute), and the final one at the end.
	assertEquals(events.filter((event) => event === 'proxy.refused_total').length, 2);
	assertEquals(logged.at(-1)!.fields, { runId: 'run', refused: LIMITS.refusalsLogged + 15, final: true });
	assertEquals(proxy.refused.size, LIMITS.refusedHostsListed);
});

Deno.test('proxy: a clone step admits its git hosts only, and registries mode never a git host', () => {
	const git = new Set(['github.com', 'git.example.test']);
	assertEquals(checkTarget('github.com:443', git), { host: 'github.com', port: 443 });
	assertEquals(checkTarget('GitHub.com.:443', git), { host: 'github.com', port: 443 });
	const refused = (target: string, hosts?: Set<string>) => {
		const result = checkTarget(target, hosts);
		assert('refused' in result, target);
		return result.refused;
	};
	// The registries are not reachable from a clone's step...
	assertStringIncludes(refused('registry.npmjs.org:443', git), 'not a git host');
	assertStringIncludes(refused('api.github.com:443', git), 'not a git host');
	assertStringIncludes(refused('github.com:22', git), 'port 443');
	assertStringIncludes(refused('140.82.112.3:443', git), 'by name');
	// ...and no git host from a registries-mode command (the default set).
	assertStringIncludes(refused('github.com:443'), 'not a package registry');
	assertStringIncludes(refused('git.example.test:443'), 'not a package registry');
});

Deno.test('proxy: a proxy opened with the git hosts tunnels to them and refuses a registry', async () => {
	const echo = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const serving = (async () => {
		for await (const conn of echo) {
			const buffer = new Uint8Array(64);
			const n = await conn.read(buffer).catch(() => null);
			if (n !== null) await conn.write(buffer.subarray(0, n)).catch(() => {});
			conn.close();
		}
	})().catch(() => {});
	const dialled: string[] = [];
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const proxy = new RegistryProxy(
		listener,
		{
			resolve: () => Promise.resolve(['10.0.0.1', '140.82.112.3']),
			connect: (address) => {
				dialled.push(address);
				return Deno.connect({ hostname: '127.0.0.1', port: (echo.addr as Deno.NetAddr).port });
			},
			log: () => {},
		},
		'clone',
		new Set(['github.com']),
	);
	const port = (listener.addr as Deno.NetAddr).port;
	try {
		const tunnel = await ask(
			port,
			'CONNECT github.com:443 HTTP/1.1\r\n\r\n',
			join(clientHello(['github.com']), 'pong'),
		);
		assertStringIncludes(tunnel, '200 Connection established');
		const npm = await ask(port, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n');
		assert(npm.startsWith('HTTP/1.1 403 '), npm);
		assertEquals(dialled, ['140.82.112.3']);
		assertEquals([...proxy.reached], ['github.com']);
		assertEquals([...proxy.refused], ['registry.npmjs.org:443']);
	} finally {
		await proxy.close();
		echo.close();
		await serving;
	}
});

/** Bytes and text, end to end. */
function join(...parts: Array<string | Uint8Array>): Uint8Array {
	const bytes = parts.map((part) => typeof part === 'string' ? new TextEncoder().encode(part) : part);
	const out = new Uint8Array(bytes.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of bytes) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * A TLS 1.3 ClientHello as a client sends it — a 32-byte session id, two suites, null compression,
 * supported_versions, then (with `names`) a server_name list of host_name entries — in records of at most `split`
 * handshake bytes each.
 */
function clientHello(names: string[] | null, options: { split?: number; extensions?: number[] } = {}): Uint8Array {
	const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
	const extensions: number[] = [...u16(0x002b), ...u16(3), 2, 0x03, 0x04, ...(options.extensions ?? [])];
	if (names !== null) {
		const list: number[] = [];
		for (const name of names) {
			const bytes = [...new TextEncoder().encode(name)];
			list.push(0, ...u16(bytes.length), ...bytes);
		}
		extensions.push(...u16(0), ...u16(list.length + 2), ...u16(list.length), ...list);
	}
	const body = [
		0x03,
		0x03,
		...Array(32).fill(7),
		32,
		...Array(32).fill(9),
		...u16(4),
		0x13,
		0x01,
		0x13,
		0x02,
		1,
		0,
		...u16(extensions.length),
		...extensions,
	];
	const handshake = [1, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
	const split = options.split ?? handshake.length;
	const out: number[] = [];
	for (let i = 0; i < handshake.length; i += split) {
		const part = handshake.slice(i, i + split);
		out.push(0x16, 0x03, 0x01, ...u16(part.length), ...part);
	}
	return new Uint8Array(out);
}

Deno.test('proxy: the ClientHello server_name is read strictly', () => {
	assertEquals(clientHelloSni(clientHello(['registry.npmjs.org'])), { sni: 'registry.npmjs.org' });
	// Case and one trailing dot do not make another name.
	assertEquals(clientHelloSni(clientHello(['Registry.NPMjs.org.'])), { sni: 'registry.npmjs.org' });
	// Split over several handshake records, as RFC 8446 allows.
	assertEquals(clientHelloSni(clientHello(['jsr.io'], { split: 7 })), { sni: 'jsr.io' });
	// Another extension after server_name is walked past.
	assertEquals(clientHelloSni(clientHello(['jsr.io'], { extensions: [0x00, 0x17, 0x00, 0x00] })), { sni: 'jsr.io' });
	assertEquals(clientHelloSni(clientHello(null)), { sni: null });
	// More bytes after the ClientHello (a client that does not wait) change nothing.
	assertEquals(clientHelloSni(join(clientHello(['jsr.io']), 'more')), { sni: 'jsr.io' });
});

Deno.test('proxy: a truncated ClientHello is incomplete, never a name', () => {
	const whole = clientHello(['registry.npmjs.org'], { split: 50 });
	for (let cut = 0; cut < whole.length; cut++) {
		assertEquals(clientHelloSni(whole.subarray(0, cut)), { need: true }, `cut at ${cut}`);
	}
});

Deno.test('proxy: what is not one well-formed ClientHello is invalid', () => {
	const invalid = (bytes: Uint8Array, label: string): void => {
		assert('invalid' in clientHelloSni(bytes), label);
	};
	invalid(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'), 'plain http');
	invalid(new Uint8Array([0x17, 0x03, 0x03, 0x00, 0x01, 0x00]), 'application data first');
	invalid(new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x00]), 'an empty record');
	invalid(new Uint8Array([0x16, 0x03, 0x01, 0x40, 0x01]), 'a record over 2^14');
	invalid(new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]), 'a ServerHello');
	// Two host_name entries could disagree: refused, not one picked.
	invalid(clientHello(['registry.npmjs.org', 'evil.example']), 'two host names');
	// Two server_name extensions, likewise.
	invalid(
		clientHello(['jsr.io'], {
			extensions: [0x00, 0x00, 0x00, 0x09, 0x00, 0x07, 0x00, 0x00, 0x04, 0x65, 0x2e, 0x69, 0x6f],
		}),
		'two server_name extensions',
	);
	invalid(clientHello(['bad name']), 'a name that is not a host name');
	// An extensions block whose length runs past the message.
	const broken = clientHello(['jsr.io']);
	const body = broken.slice();
	// The extensions length sits right after compression: record 5 + handshake 4 + 34 + 1 + 32 + 2 + 4 + 1 + 1.
	body[5 + 4 + 34 + 1 + 32 + 2 + 4 + 2] = 0xff;
	invalid(body, 'an extensions length past the message');
	// Random bytes behind a valid header never throw and never yield a name.
	for (let i = 0; i < 200; i++) {
		const noise = crypto.getRandomValues(new Uint8Array(64));
		const bytes = join(new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x44, 0x01, 0x00, 0x00, 0x40]), noise);
		const seen = clientHelloSni(bytes);
		assert(!('sni' in seen) || seen.sni === null || typeof seen.sni === 'string');
	}
});

/** A proxy whose "registry" records what reached it, for the tunnels the ClientHello check must close unforwarded. */
async function withRecordingProxy(test: (port: number, proxy: RegistryProxy, received: () => number) => Promise<void>) {
	const upstream = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	let received = 0;
	const serving = (async () => {
		for await (const conn of upstream) {
			void (async () => {
				const buffer = new Uint8Array(4096);
				try {
					for (;;) {
						const n = await conn.read(buffer);
						if (n === null) break;
						received += n;
					}
				} catch {
					// closed
				} finally {
					try {
						conn.close();
					} catch {
						// closed
					}
				}
			})();
		}
	})().catch(() => {});
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const proxy = new RegistryProxy(listener, {
		resolve: () => Promise.resolve(['104.16.0.35']),
		connect: () => Deno.connect({ hostname: '127.0.0.1', port: (upstream.addr as Deno.NetAddr).port }),
		log: () => {},
	}, 'run');
	try {
		await test((listener.addr as Deno.NetAddr).port, proxy, () => received);
	} finally {
		await proxy.close();
		upstream.close();
		await serving;
	}
}

Deno.test('proxy: a tunnel whose ClientHello names another host, or none, is closed unforwarded', async () => {
	await withRecordingProxy(async (port, proxy, received) => {
		const cases: [string, Uint8Array][] = [
			['another host on the same CDN', clientHello(['www.example.com'])],
			['a subdomain of the registry', clientHello(['evil.registry.npmjs.org'])],
			['no server_name', clientHello(null)],
			['plain bytes', new TextEncoder().encode('GET / HTTP/1.1\r\nHost: www.example.com\r\n\r\n')],
		];
		for (const [label, hello] of cases) {
			const text = await ask(port, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n', join(hello, 'pong'));
			assertStringIncludes(text, '200 Connection established', label);
			assert(!text.includes('pong'), label);
		}
		assertEquals(received(), 0);
		assertEquals([...proxy.reached], []);
		assertEquals([...proxy.refused], ['registry.npmjs.org']);
	});
});
