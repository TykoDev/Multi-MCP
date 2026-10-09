/**
 * `browser_head` as a server-side HEAD (SR-HEAD-REDIRECT, D-042), proven on loopback.
 *
 * The upstream here is a **raw** `Deno.listen` HTTP/1.1 responder rather than
 * `Deno.serve`, for a measured reason: `Deno.serve` drains a streaming
 * response body on a HEAD request even though it writes none of it to the
 * socket (`build/evidence/b1_12_sr_head_egress_probe.log`: 196 608 bytes
 * pulled, 0 sent), so a `pull`-counting fixture would over-report. This one
 * counts the bytes it actually writes, records every request line and header
 * it received, and can misbehave on request — a redirect loop, a `Location`
 * off the allowlist, a private-address `Location`, a stall.
 *
 * Runs under the unit tier's own grant, `--allow-net=127.0.0.1,localhost`,
 * which is exactly the shape of an operator-elected grant: `127.0.0.1` is on
 * the allowlist here **by exact name**, so the loopback deny is lifted for it
 * and for nothing else.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { attachmentDisposition } from './files.ts';
import { ToolError } from './errors.ts';
import {
	browserProxyFlag,
	CHROMIUM_PROXY_FLAGS,
	dispositionFilename,
	FAILURE_CAUSE_DEPTH,
	failureReason,
	gateHop,
	HEAD_MAX_HOPS,
	headRoutingRefusal,
	headWalk,
	isForbiddenLiteralHost,
	privateLiteralEntries,
	probeEgressGrant,
} from './head.ts';
import { SessionRegistry } from './registry.ts';
import { browserHead } from './tools/files.ts';

interface Seen {
	readonly method: string;
	readonly path: string;
	readonly headers: Record<string, string>;
}

interface Upstream {
	readonly origin: string;
	/**
	 * The allowlist a test uses against this upstream: the loopback literal by
	 * exact name (lifting the address deny for it alone) and, because the port
	 * is ephemeral, the exact `host:port` the non-default-port rule requires.
	 */
	readonly allow: string[];
	readonly seen: Seen[];
	/** Bytes this process wrote to sockets, all responses together. */
	bytesWritten: number;
	close(): Promise<void>;
}

interface Reply {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body?: Uint8Array;
}
type Route = (path: string, origin: string) => Reply;

/** A minimal HTTP/1.1 responder: one request per connection, then close. */
function startUpstream(route: Route, options: { stallMs?: number } = {}): Upstream {
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const { port } = listener.addr as Deno.NetAddr;
	const origin = `http://127.0.0.1:${port}`;
	const seen: Seen[] = [];
	const closing = new AbortController();
	const upstream: Upstream = {
		origin,
		allow: ['127.0.0.1', `127.0.0.1:${port}`],
		seen,
		bytesWritten: 0,
		close: async () => {
			closing.abort();
			listener.close();
			await accepting;
		},
	};
	const accepting = (async () => {
		for await (const conn of listener) {
			(async () => {
				try {
					const buffer = new Uint8Array(65_536);
					let text = '';
					while (!text.includes('\r\n\r\n')) {
						const n = await conn.read(buffer);
						if (n === null) return;
						text += new TextDecoder().decode(buffer.subarray(0, n));
					}
					const [head] = text.split('\r\n\r\n');
					const lines = (head ?? '').split('\r\n');
					const [method = '', target = ''] = (lines[0] ?? '').split(' ');
					const headers: Record<string, string> = {};
					for (const line of lines.slice(1)) {
						const index = line.indexOf(':');
						if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
					}
					seen.push({ method, path: target, headers });
					if (options.stallMs !== undefined) {
						// Tied to close(), so a stall never outlives the test that asked for it.
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, options.stallMs);
							closing.signal.addEventListener('abort', () => {
								clearTimeout(timer);
								resolve();
							});
						});
					}
					// The request target carries the query; routes see the path alone.
					const reply = route(new URL(target, origin).pathname, origin);
					const body = method === 'HEAD' ? new Uint8Array(0) : (reply.body ?? new Uint8Array(0));
					let raw = `HTTP/1.1 ${reply.status} X\r\nconnection: close\r\n`;
					for (const [name, value] of Object.entries(reply.headers)) raw += `${name}: ${value}\r\n`;
					raw += '\r\n';
					const bytes = new Uint8Array([...new TextEncoder().encode(raw), ...body]);
					let written = 0;
					while (written < bytes.length) {
						written += await conn.write(bytes.subarray(written));
					}
					upstream.bytesWritten += written;
				} catch {
					// A peer that went away mid-exchange is not this test's concern.
				} finally {
					try {
						conn.close();
					} catch {
						// already closed
					}
				}
			})();
		}
	})();
	return upstream;
}

const BIG = 4 * 1024 * 1024;

const plainRoute: Route = (path, origin): Reply => {
	if (path === '/big') {
		return {
			status: 200,
			headers: {
				'content-type': 'application/octet-stream',
				'content-length': String(BIG),
				'content-disposition': attachmentDisposition('résumé (final).pdf'),
			},
			body: new Uint8Array(BIG),
		};
	}
	if (path === '/nolength') return { status: 200, headers: { 'content-type': 'text/html' } };
	if (path.startsWith('/hop/')) {
		const n = Number(path.slice(5));
		return { status: 302, headers: { location: n <= 1 ? `${origin}/big?token=SECRET#frag` : `/hop/${n - 1}` } };
	}
	if (path === '/loop') return { status: 302, headers: { location: '/loop' } };
	if (path === '/off') return { status: 302, headers: { location: 'https://evil.example/exfil?token=SECRET' } };
	if (path === '/private') return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } };
	if (path === '/localhost') return { status: 302, headers: { location: 'http://localhost:9/x' } };
	if (path === '/nolocation') return { status: 302, headers: { 'content-type': 'text/plain' } };
	if (path === '/badlocation') return { status: 302, headers: { location: 'http://[bad' } };
	if (path === '/joined') return { status: 302, headers: { location: `${origin}/a, ${origin}/b` } };
	if (path === '/port') return { status: 302, headers: { location: 'http://127.0.0.1:8443/x' } };
	if (path === '/notfollowed') return { status: 300, headers: { location: '/big' } };
	return { status: 404, headers: { 'content-type': 'text/plain' } };
};

Deno.test('head: a HEAD walk transfers no body, forwards no credential, and reports the final URL stripped', async () => {
	const up = startUpstream(plainRoute);
	try {
		const result = await headWalk(`${up.origin}/hop/3?q=1`, up.allow);
		assertEquals(result.status, 200);
		assertEquals(result.content_type, 'application/octet-stream');
		assertEquals(result.content_length, BIG);
		assertEquals(result.filename, 'résumé (final).pdf');
		assertEquals(result.final_url, `${up.origin}/big`, 'origin plus path, no query, no fragment');
		assertEquals(result.hops, 3);
		// What the upstream measured: every request was a HEAD, and the bytes it
		// wrote are headers only — a 4 MiB resource cost it well under a kilobyte
		// per response. This is the number U-4 used to be 33 554 432.
		assertEquals(up.seen.length, 4);
		for (const request of up.seen) {
			assertEquals(request.method, 'HEAD');
			assertEquals(request.headers['cookie'], undefined, 'no Cookie may reach the upstream');
			assertEquals(request.headers['authorization'], undefined, 'no Authorization may reach the upstream');
			assert(!Object.keys(request.headers).some((name) => name.startsWith('x-forwarded')), 'nothing forwarded');
		}
		assert(up.bytesWritten < 4 * 1024, `the upstream wrote ${up.bytesWritten} bytes for four HEAD responses`);
		console.log(`SR-HEAD-REDIRECT: upstream wrote ${up.bytesWritten} bytes for a ${BIG}-byte resource over 4 hops`);
	} finally {
		await up.close();
	}
});

Deno.test('head: content_length is null when absent, never guessed', async () => {
	const up = startUpstream(plainRoute);
	try {
		const result = await headWalk(`${up.origin}/nolength`, up.allow);
		assertEquals(result.content_length, null);
		assertEquals(result.filename, null);
		assertEquals(result.hops, 0);
	} finally {
		await up.close();
	}
});

Deno.test('head: a hop off the allowlist stops the walk and names only the blocked origin', async () => {
	const up = startUpstream(plainRoute);
	try {
		const error = await assertRejects(() => headWalk(`${up.origin}/off`, up.allow), ToolError);
		assertEquals(error.code, 'navigation-blocked');
		assertStringIncludes(error.message, 'https://evil.example');
		assertEquals(error.message.includes('exfil'), false, 'the Location path must not be reported');
		assertEquals(error.message.includes('SECRET'), false, 'the Location query must not be reported');
		assertEquals(up.seen.length, 1, 'the blocked hop was never requested');
	} finally {
		await up.close();
	}
});

Deno.test('head: a hop to a private literal address is refused even though the allowlist is empty', async () => {
	const up = startUpstream(plainRoute);
	try {
		// The allowlist names the upstream and nothing else, and no name entry
		// could lift an address deny anyway.
		const error = await assertRejects(() => headWalk(`${up.origin}/private`, up.allow), ToolError);
		assertEquals(error.code, 'navigation-blocked');
		assertStringIncludes(error.message, 'http://169.254.169.254');
		assertEquals(error.message.includes('meta-data'), false);
		assertEquals(up.seen.length, 1);
	} finally {
		await up.close();
	}
});

Deno.test('head: localhost is refused unless named exactly; a suffix entry does not lift it', async () => {
	const up = startUpstream(plainRoute);
	try {
		const refused = await assertRejects(() => headWalk(`${up.origin}/localhost`, up.allow), ToolError);
		assertEquals(refused.code, 'navigation-blocked');
		assertStringIncludes(refused.message, 'http://localhost:9');
		// Named exactly: the deny lifts, the walk proceeds, and the next gate —
		// the permission query for localhost:9 — is what answers (granted in this
		// tier), after which the closed port is a coded error rather than a hang.
		const reached = await assertRejects(
			() => headWalk(`${up.origin}/localhost`, [...up.allow, 'localhost', 'localhost:9'], { hopTimeoutMs: 2_000 }),
			ToolError,
		);
		assert(reached.code === 'browser-error' || reached.code === 'timeout', reached.message);
	} finally {
		await up.close();
	}
});

Deno.test('head: the hop cap ends a redirect loop', async () => {
	const up = startUpstream(plainRoute);
	try {
		const error = await assertRejects(() => headWalk(`${up.origin}/loop`, up.allow), ToolError);
		assertEquals(error.code, 'browser-error');
		assertStringIncludes(error.message, `${HEAD_MAX_HOPS} hops`);
		assertEquals(up.seen.length, HEAD_MAX_HOPS + 1);
	} finally {
		await up.close();
	}
});

Deno.test('head: a 3xx without Location is the final answer; a malformed Location is a coded error', async () => {
	const up = startUpstream(plainRoute);
	try {
		const result = await headWalk(`${up.origin}/nolocation`, up.allow);
		assertEquals(result.status, 302);
		assertEquals(result.hops, 0);
		const error = await assertRejects(() => headWalk(`${up.origin}/badlocation`, up.allow), ToolError);
		assertEquals(error.code, 'browser-error');
		// Two joined `Location` values are not a redirect either (m2), and a 300
		// is an answer, not a hop (m3).
		const joined = await assertRejects(() => headWalk(`${up.origin}/joined`, up.allow), ToolError);
		assertEquals(joined.code, 'browser-error');
		const choice = await headWalk(`${up.origin}/notfollowed`, up.allow);
		assertEquals(choice.status, 300);
		assertEquals(choice.hops, 0);
	} finally {
		await up.close();
	}
});

Deno.test('head: the permission-denied path is feature-unavailable {egress}, and nothing is requested', async () => {
	const up = startUpstream(plainRoute);
	try {
		// The real permissions API, under this tier's real grant: a public name
		// is on the allowlist but the process holds no grant for it.
		const error = await assertRejects(() => headWalk('https://docs.example/file.pdf', ['docs.example']), ToolError);
		assertEquals(error.code, 'feature-unavailable');
		assertEquals(error.extras.feature, 'egress');
		assertStringIncludes(error.message, 'docs.example:443');
		assertEquals(up.seen.length, 0);
		// And the belt behind the braces: a `NotCapable` thrown by the runtime is
		// mapped, not propagated, should a query ever disagree with a dial.
		const lying = { query: () => Promise.resolve({ state: 'granted' as const }) };
		const denied = await assertRejects(
			() =>
				headWalk('https://docs.example/file.pdf', ['docs.example'], {
					permissions: lying,
					fetch: () => Promise.reject(new Deno.errors.NotCapable('Requires net access to "docs.example:443"')),
				}),
			ToolError,
		);
		assertEquals(denied.code, 'feature-unavailable');
		assertEquals(denied.extras.feature, 'egress');
	} finally {
		await up.close();
	}
});

Deno.test('head: a stalled upstream is a timeout, not a hang', async () => {
	const up = startUpstream(plainRoute, { stallMs: 5_000 });
	try {
		const started = Date.now();
		const error = await assertRejects(
			() => headWalk(`${up.origin}/nolength`, up.allow, { hopTimeoutMs: 300 }),
			ToolError,
		);
		assertEquals(error.code, 'timeout');
		assert(Date.now() - started < 4_000, 'the per-hop budget must be what ends the wait');
	} finally {
		await up.close();
	}
});

Deno.test('head: userinfo, non-http schemes, the first hop off the allowlist and a stray port are refused before any request', () => {
	const allow = ['127.0.0.1'];
	const userinfo = assertThrowsTool(() => gateHop('http://user:pw@127.0.0.1/x', allow));
	assertEquals(userinfo.code, 'invalid-arguments');
	assertEquals(userinfo.message.includes('pw'), false, 'the credential is not echoed');
	assertEquals((assertThrowsTool(() => gateHop('ftp://127.0.0.1/x', allow))).code, 'navigation-blocked');
	const off = assertThrowsTool(() => gateHop('https://evil.example/path?token=SECRET', allow));
	assertEquals(off.code, 'navigation-blocked');
	assertStringIncludes(off.message, 'https://evil.example');
	assertEquals(off.message.includes('SECRET'), false);
	// A non-default port needs an exact host:port entry (m5): the allowlist
	// ignores ports and a bare-host grant covers all of them.
	const port = assertThrowsTool(() => gateHop('http://127.0.0.1:8443/x', allow));
	assertEquals(port.code, 'navigation-blocked');
	assertStringIncludes(port.message, 'non-default port');
	assertEquals(gateHop('http://127.0.0.1:8443/x', ['127.0.0.1', '127.0.0.1:8443']).port, '8443');
	assertEquals(gateHop('https://127.0.0.1/x', allow).port, '', 'the scheme default needs no entry');
});

Deno.test('head: a hop to a non-default port is refused at the hop, and no connection is attempted', async () => {
	const up = startUpstream(plainRoute);
	try {
		const error = await assertRejects(() => headWalk(`${up.origin}/port`, up.allow), ToolError);
		assertEquals(error.code, 'navigation-blocked');
		assertStringIncludes(error.message, 'http://127.0.0.1:8443');
		assertEquals(up.seen.length, 1);
	} finally {
		await up.close();
	}
});

Deno.test('head: runtime failures are reported as a closed reason, never as the runtime text', () => {
	assertEquals(failureReason(new TypeError('Fetch failed: Requests to port 1 are blocked')), 'bad-port');
	assertEquals(
		failureReason(new TypeError('error sending request for url (http://x/): dns error: failed to lookup')),
		'dns',
	);
	assertEquals(failureReason(new TypeError('error sending request: tcp connect error: Connection refused')), 'refused');
	assertEquals(failureReason(new TypeError('invalid peer certificate: UnknownIssuer')), 'tls');
	assertEquals(failureReason(new TypeError('error sending request: connection reset')), 'reset');
	assertEquals(failureReason(new TypeError('fetch failed')), 'protocol');
	assertEquals(failureReason('not an error'), 'unknown');
});

function assertThrowsTool(fn: () => unknown): ToolError {
	try {
		fn();
	} catch (cause) {
		assert(cause instanceof ToolError, String(cause));
		return cause;
	}
	throw new Error('expected a ToolError');
}

Deno.test('head: the literal-address deny covers every measured spelling, and an exact entry lifts only itself', () => {
	// The forms WHATWG folds before the gate sees them (measured in the probe log).
	for (
		const url of [
			'http://2130706433/',
			'http://0x7f.1/',
			'http://127.1/',
			'http://0177.0.0.1/',
			'http://[::ffff:127.0.0.1]/',
			'http://[::1]/',
			'http://[0:0:0:0:0:0:0:1]/',
			'http://LOCALHOST./',
			'http://a.localhost/',
			'http://0/',
			'http://[::]/',
			'http://[64:ff9b::7f00:1]/',
			'http://[::ffff:a9fe:a9fe]/',
			'http://[::ffff:0:7f00:1]/',
			'http://[2002:7f00:1::]/',
			'http://[2002:a9fe:a9fe::1]/',
			'http://10.0.0.1/',
			'http://172.16.5.5/',
			'http://172.31.255.255/',
			'http://192.168.1.1/',
			'http://169.254.169.254/',
			'http://100.64.0.1/',
			'http://100.127.255.255/',
			'http://192.0.0.8/',
			'http://198.18.0.1/',
			'http://224.0.0.1/',
			'http://255.255.255.255/',
			'http://[fe80::1]/',
			'http://[fc00::1]/',
			'http://[fd12::1]/',
			'http://[ff02::1]/',
		]
	) {
		const hostname = new URL(url).hostname;
		assert(isForbiddenLiteralHost(hostname, []), `${url} (${hostname}) must be refused`);
		assert(isForbiddenLiteralHost(hostname, ['example.com', 'localhost.example']), `${url} not lifted by names`);
	}
	// Public addresses and names pass the address gate (the allowlist is a separate gate).
	for (
		const url of [
			'http://8.8.8.8/',
			'http://172.15.0.1/',
			'http://172.32.0.1/',
			'http://[2001:db8::1]/',
			'http://example.com/',
		]
	) {
		assertEquals(isForbiddenLiteralHost(new URL(url).hostname, []), false, url);
	}
	// An exact entry lifts exactly that host.
	assertEquals(isForbiddenLiteralHost('127.0.0.1', ['127.0.0.1']), false);
	assertEquals(isForbiddenLiteralHost('127.0.0.2', ['127.0.0.1']), true);
	assertEquals(isForbiddenLiteralHost('localhost', ['localhost']), false);
	assertEquals(isForbiddenLiteralHost('a.localhost', ['localhost']), true, 'suffix never lifts');
	assertEquals(isForbiddenLiteralHost('localhost', ['LOCALHOST.']), false, 'canonical comparison');
	assertEquals(isForbiddenLiteralHost('[::1]', ['[::1]']), false);
});

Deno.test('head: availability is proven by the permissions API, never declared, and loopback proves nothing', async () => {
	// Under this tier's real grant (`127.0.0.1,localhost`): a loopback-only
	// allowlist is granted and still proves nothing, because the shipped
	// matrices grant loopback for the browser connection and that is not an
	// election of outbound net (M4); a public-only allowlist proves none; an
	// empty allowlist cannot be proven without an unscoped grant.
	assertEquals(await probeEgressGrant(['127.0.0.1']), false);
	assertEquals(await probeEgressGrant(['localhost', '[::1]']), false);
	assertEquals(await probeEgressGrant(['docs.example']), false);
	assertEquals(await probeEgressGrant([]), false);
	// A real grant on a public name, through the injectable seam (the tier
	// holds none, by construction); the stdio tier proves the same in a real
	// process with a real flag.
	const scoped = {
		query: (desc: Deno.NetPermissionDescriptor) =>
			Promise.resolve({ state: desc.host === 'docs.example:443' ? 'granted' as const : 'prompt' as const }),
	};
	assertEquals(await probeEgressGrant(['docs.example'], scoped), true);
	assertEquals(await probeEgressGrant(['cdn.example'], scoped), false, 'a grant on another host proves nothing');
	// A host-scoped grant that happens to cover loopback proves nothing either.
	const loopbackOnly = {
		query: (desc: Deno.NetPermissionDescriptor) =>
			Promise.resolve({ state: desc.host?.startsWith('127.0.0.1:') ? 'granted' as const : 'prompt' as const }),
	};
	assertEquals(await probeEgressGrant(['127.0.0.1'], loopbackOnly), false);
	const unscoped = {
		query: (desc: Deno.NetPermissionDescriptor) =>
			Promise.resolve({ state: desc.host === undefined ? 'granted' as const : 'prompt' as const }),
	};
	assertEquals(await probeEgressGrant([], unscoped), true);
	assertEquals(privateLiteralEntries(['docs.example', '127.0.0.1', '[::1]', '10.0.0.5', 'localhost.']), [
		'127.0.0.1',
		'[::1]',
		'10.0.0.5',
		'localhost.',
	]);
	// A query that throws is a refusal, not a crash.
	const broken = { query: () => Promise.reject(new Error('no permissions API')) };
	assertEquals(await probeEgressGrant(['127.0.0.1'], broken), false);
});

Deno.test('head: Content-Disposition names decode through the same form this server emits, and are sanitised', () => {
	assertEquals(dispositionFilename(attachmentDisposition('résumé (final).pdf')), 'résumé (final).pdf');
	assertEquals(dispositionFilename('attachment; filename="report.csv"'), 'report.csv');
	assertEquals(dispositionFilename('attachment; filename=plain.txt'), 'plain.txt');
	assertEquals(dispositionFilename("attachment; filename*=UTF-8''a%20b.txt"), 'a b.txt');
	assertEquals(dispositionFilename("attachment; filename*=iso-8859-1''caf%E9.txt"), 'café.txt');
	assertEquals(dispositionFilename("attachment; filename*=utf-16''x"), null, 'an unsupported charset yields nothing');
	assertEquals(dispositionFilename('attachment; filename="../../etc/passwd"'), 'passwd');
	assertEquals(dispositionFilename('attachment; filename="C:\\\\Users\\\\x\\\\evil.exe"'), 'evil.exe');
	assertEquals(dispositionFilename('attachment; filename="bad\r\nx-injected: 1"'), 'badx-injected: 1');
	assertEquals(dispositionFilename('attachment; filename=".."'), null);
	assertEquals(dispositionFilename('attachment; filename=".hidden"'), 'hidden', 'leading dots are not a file name');
	assertEquals(dispositionFilename("attachment; filename*=UTF-8''%zz"), null, 'a malformed escape yields nothing');
	assertEquals(dispositionFilename("attachment; filename*=UTF-8''e%CC%81.txt"), '\u00e9.txt', 'NFC');
	assertEquals(dispositionFilename('inline'), null);
	assertEquals(dispositionFilename(undefined), null);
	assertEquals(dispositionFilename(`attachment; filename="${'a'.repeat(400)}"`)?.length, 255);
});

// --- SR3-M2: two egress paths, and the tool refuses rather than answer about the wrong one ---

Deno.test('head: any Chromium proxy flag makes browser_head refuse (SR3-M2)', () => {
	// The server's HEAD is a `fetch` and follows the process proxy environment;
	// the browser follows its flag. A deployment configuring the browser's route
	// separately gets two network paths from one tool surface, and an answer about
	// the wrong one is wrong in the shape of being right.
	for (const flag of CHROMIUM_PROXY_FLAGS) {
		const args = flag === '--proxy-auto-detect' || flag === '--no-proxy-server'
			? [flag]
			: [`${flag}=http://proxy.internal:3128`];
		assertEquals(browserProxyFlag(args), flag);
		const refusal = headRoutingRefusal(args);
		assert(refusal !== null, `${flag} must refuse`);
		assertStringIncludes(refusal, flag);
		// The remedy is a configuration where the divergence cannot arise, not a
		// restatement of the problem.
		assertStringIncludes(refusal, 'TTK_BROWSER_ARGS');
		assertStringIncludes(refusal, 'network-level egress control');
	}
});

Deno.test('head: the refusal names the flag and never its value (DD-7)', () => {
	// A `--proxy-server` value can carry userinfo, and a proxy password is a
	// password. The message names what the operator edits, never what it holds.
	const secret = 'http://ops:hunter2@proxy.internal:3128';
	const refusal = headRoutingRefusal([`--proxy-server=${secret}`, '--window-size=800,600']);
	assert(refusal !== null);
	assertEquals(refusal.includes('hunter2'), false, 'no proxy credential in the message');
	assertEquals(refusal.includes('ops:'), false);
	assertEquals(refusal.includes('proxy.internal'), false, 'not even the host: the flag name is the fact');
	assertStringIncludes(refusal, '--proxy-server');
});

Deno.test('head: a deployment with no browser proxy flag is not refused', () => {
	// Refusing every deployment would be a cure worse than the finding: with no
	// flag, Chromium and this process both follow whatever the environment says,
	// and the tool answers about the path the browser uses.
	assertEquals(browserProxyFlag([]), null);
	assertEquals(headRoutingRefusal([]), null);
	assertEquals(headRoutingRefusal(['--window-size=1280,720', '--lang=en-GB']), null);
	// A flag that merely *mentions* a proxy in a value is not a proxy flag: the
	// match is on the argument name, before the `=`, exactly.
	assertEquals(headRoutingRefusal(['--user-agent=proxy-server/1.0']), null);
	assertEquals(headRoutingRefusal(['--host-resolver-rules=MAP * --proxy-server']), null);
});

Deno.test('head: browser_head refuses at the handler, not only at availability (SR3-M2)', async () => {
	// A control that lives only in `tools/list` is one an out-of-band call walks
	// past, and this repository already proves a hidden tool can be called
	// (`tests/.scratch/runtime_smoke.ts`). So the handler holds it alone.
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		browserArgs: ['--proxy-server=http://proxy.internal:3128'],
		launch: () => Promise.reject(new Error('no browser is launched by this test')),
	});
	try {
		assertEquals(registry.browserArgs, ['--proxy-server=http://proxy.internal:3128']);
		const error = await assertRejects(
			() =>
				browserHead({ url: 'https://docs.example/x' }, { registry, allowedDomains: ['docs.example'], principal: 'p' }),
			ToolError,
		);
		assertEquals(error.code, 'feature-unavailable');
		assertEquals(error.extras.feature, 'egress');
		assertStringIncludes(error.message, '--proxy-server');
		// It refused **before** any outbound request: the message is about routing,
		// never about a host that was dialled.
		assertEquals(error.message.includes('docs.example'), false);
	} finally {
		await registry.shutdown('server-shutdown');
	}
});

Deno.test('head: the same deployment without the flag reaches the walk (SR3-M2)', async () => {
	// The complement of the test above: with no proxy flag the refusal is not the
	// thing that stops the call, so a green refusal test cannot be passing for the
	// wrong reason.
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.reject(new Error('no browser is launched by this test')),
	});
	try {
		const error = await assertRejects(
			() =>
				browserHead({ url: 'https://docs.example/x' }, { registry, allowedDomains: ['docs.example'], principal: 'p' }),
			ToolError,
		);
		// It got as far as the permission gate, which is the next control in line.
		assertEquals(error.code, 'feature-unavailable');
		assertStringIncludes(error.message, 'outbound net access');
	} finally {
		await registry.shutdown('server-shutdown');
	}
});

// --- K-8 / review R3-3: the cause chain -----------------------------------------------------------------------------

Deno.test('K-8: failureReason reads the cause chain — refused, tls and dns are no longer protocol', () => {
	const failed = (detail: string) => new TypeError('fetch failed', { cause: new Error(detail) });
	assertEquals(failureReason(failed('tcp connect error: Connection refused (os error 10061)')), 'refused');
	assertEquals(failureReason(failed('client error (Connect): invalid peer certificate: UnknownIssuer')), 'tls');
	assertEquals(failureReason(failed('dns error: failed to lookup address information: No such host is known.')), 'dns');
	assertEquals(failureReason(failed('connection reset by peer')), 'reset');
	// Two levels down still counts; a bare top message with nothing under it is still protocol.
	assertEquals(
		failureReason(
			new TypeError('fetch failed', { cause: new Error('client error', { cause: new Error('Connection refused') }) }),
		),
		'refused',
	);
	assertEquals(failureReason(new TypeError('fetch failed')), 'protocol');
	// The walk is bounded: a reason buried past FAILURE_CAUSE_DEPTH errors is not read.
	assertEquals(FAILURE_CAUSE_DEPTH, 5);
	let deep: Error = new Error('Connection refused');
	for (let level = 0; level < FAILURE_CAUSE_DEPTH; level++) deep = new Error(`layer ${level}`, { cause: deep });
	assertEquals(failureReason(deep), 'unknown');
});

Deno.test('K-8: a real refused connection on this runtime classifies as refused', async () => {
	// A port nothing listens on: bind one, learn its number, close it.
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const port = (listener.addr as Deno.NetAddr).port;
	listener.close();
	const error = await fetch(`http://127.0.0.1:${port}/`).then(() => null, (cause: unknown) => cause);
	assert(error instanceof Error, 'the connection was expected to fail');
	assertEquals(failureReason(error), 'refused');
});
