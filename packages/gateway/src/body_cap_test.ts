/**
 * A5 (D-100, AC12): `TTK_MAX_BODY_KB` is enforced on `/api/v1/*` and `/a2a` bodies — by the declared length and by
 * the counted stream — while the share upload keeps its 64 MiB, sign-in keeps its 16 KiB, and `/mcp` gets the 4 MiB
 * the project believed the SDK applied (E-83).
 */
import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { LibraryStore, SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { isJsonContentType } from '@modelcontextprotocol/server';
import {
	bodyCapOf,
	capRequestBody,
	isJsonFamily,
	LOGIN_BODY_BYTES,
	MCP_BODY_BYTES,
	readCappedBody,
} from './body_cap.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const KIB = 1024;

/** A body that arrives as a stream with no declared length, so only counting can catch it. */
function streamed(bytes: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= bytes) return controller.close();
			const size = Math.min(4 * KIB, bytes - sent);
			sent += size;
			controller.enqueue(new Uint8Array(size).fill(0x61));
		},
	});
}

/** {@linkcode streamed}, with a count of the bytes the reader actually pulled. */
function counted(bytes: number): { body: ReadableStream<Uint8Array>; pulled: () => number } {
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= bytes) return controller.close();
			const size = Math.min(4 * KIB, bytes - sent);
			sent += size;
			controller.enqueue(new Uint8Array(size).fill(0x61));
		},
	}, { highWaterMark: 0 });
	return { body, pulled: () => sent };
}

/** A JSON object of roughly `bytes` bytes. */
function jsonOf(bytes: number): string {
	return JSON.stringify({ path: 'p', pad: 'x'.repeat(Math.max(0, bytes - 24)) });
}

Deno.test('A5: bodyCapOf names the cap for every route class', () => {
	const max = 256 * KIB;
	assertEquals(bodyCapOf('POST', '/api/v1/users', max), max);
	assertEquals(bodyCapOf('PATCH', '/api/v1/users/a', max), max);
	assertEquals(bodyCapOf('post', '/a2a', max), max, 'methods compare case-insensitively');
	assertEquals(bodyCapOf('POST', '/a2a/v1/message:send', max), max, 'the A2A HTTP+JSON binding too');
	assertEquals(bodyCapOf('POST', '/api/v1/auth/login', max), LOGIN_BODY_BYTES, 'sign-in keeps D-078');
	assertEquals(bodyCapOf('PUT', '/api/v1/share/file', max), null, 'the upload route streams under its own cap');
	assertEquals(bodyCapOf('POST', '/api/v1/share/mkdir', max), max, 'only the upload itself is exempt');
	assertEquals(bodyCapOf('POST', '/mcp', max), MCP_BODY_BYTES, '/mcp is bounded by E-83, not by TTK_MAX_BODY_KB');
	assertEquals(bodyCapOf('GET', '/api/v1/share', max), null);
	assertEquals(bodyCapOf('HEAD', '/api/v1/share', max), null);
	assertEquals(bodyCapOf('POST', '/assets/app.js', max), null, 'outside the capped prefixes nothing changes');
	assertEquals(bodyCapOf('POST', '/a2ax', max), null, 'a prefix match, not a substring match');
});

Deno.test('R1-1: a JSON-typed body is capped on every path and method, the share upload included', () => {
	const max = 256 * KIB;
	const json = 'application/json';
	// The adapter parses any `application/json` body, on any path, before authentication: so the cap follows the
	// content type, not the path.
	for (const path of ['/', '/healthz', '/mcp/', '//api/v1/x', '/.well-known/x', '/live/x', '/assets/app.js', '/nope']) {
		assertEquals(bodyCapOf('POST', path, max, json), max, `POST ${path}`);
	}
	for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PROPFIND']) {
		assertEquals(bodyCapOf(method, '/', max, json), max, `${method} / with a JSON body`);
	}
	// The per-path caps still apply to a JSON body.
	assertEquals(bodyCapOf('POST', '/mcp', max, json), MCP_BODY_BYTES);
	assertEquals(bodyCapOf('POST', '/api/v1/auth/login', max, json), LOGIN_BODY_BYTES);
	// The share upload is exempt only while it is not JSON: a JSON-typed upload is capped like any JSON body.
	assertEquals(bodyCapOf('PUT', '/api/v1/share/file', max, json), max);
	assertEquals(bodyCapOf('PUT', '/api/v1/share/file', max, 'application/octet-stream'), null);
	assertEquals(bodyCapOf('PUT', '/api/v1/share/file', max, null), null);
	// Every spelling of the JSON family, and anything the adapter's own predicate calls JSON.
	for (
		const type of [
			'application/json',
			'Application/JSON; charset=utf-8',
			'application/json;',
			' application/json ',
			'application/merge-patch+json',
			'application/ld+json',
			'application/jsonl',
			'application/json, text/plain',
			'text/plain, application/json',
		]
	) {
		assert(isJsonFamily(type), type);
		assertEquals(bodyCapOf('POST', '/', max, type), max, type);
	}
	for (const type of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON;foo']) {
		assert(isJsonContentType(type), `the adapter's predicate parses ${type}`);
		assert(isJsonFamily(type), `so the cap covers ${type}`);
	}
	for (const type of [null, undefined, '', 'text/plain', 'application/octet-stream', 'multipart/form-data']) {
		assert(!isJsonFamily(type), String(type));
	}
	// A non-JSON body keeps the per-path rules: outside the capped prefixes nothing changes.
	assertEquals(bodyCapOf('POST', '/', max, 'text/plain'), null);
	assertEquals(bodyCapOf('POST', '/api/v1/users', max, 'text/plain'), max);
});

Deno.test('A5: readCappedBody refuses by declared length without reading, and by count otherwise', async () => {
	let pulled = false;
	const lying = new Request(`${ORIGIN}/x`, {
		method: 'POST',
		headers: { 'content-length': String(2 * KIB) },
		body: new ReadableStream({
			pull() {
				pulled = true;
			},
		}),
	});
	assertEquals(await readCappedBody(lying, KIB), 'too-large');
	assertEquals(pulled, false, 'an over-declared body is cancelled, never read');

	const counted = new Request(`${ORIGIN}/x`, { method: 'POST', body: streamed(KIB + 1) });
	assertEquals(await readCappedBody(counted, KIB), 'too-large');

	const exact = await readCappedBody(new Request(`${ORIGIN}/x`, { method: 'POST', body: streamed(KIB) }), KIB);
	assert(exact instanceof Uint8Array && exact.length === KIB, 'exactly the cap passes');
	assertEquals(await readCappedBody(new Request(`${ORIGIN}/x`, { method: 'POST' }), KIB), null);
});

Deno.test('A5: a passed body reaches the handler intact, with method, headers and URL preserved', async () => {
	const original = new Request(`${ORIGIN}/api/v1/x?y=1`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-test': 'kept' },
		body: streamed(300),
	});
	const capped = await capRequestBody(original, KIB);
	assert(capped.kind === 'pass');
	assertEquals(capped.request.method, 'POST');
	assertEquals(capped.request.url, `${ORIGIN}/api/v1/x?y=1`);
	assertEquals(capped.request.headers.get('x-test'), 'kept');
	assertEquals((await capped.request.arrayBuffer()).byteLength, 300);
});

Deno.test('A5 (AC12): the gateway answers 413 over TTK_MAX_BODY_KB and leaves the routes with their own caps alone', async () => {
	const dir = join('tests/.scratch', `bodycap-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const writer = await generateApiKey('writer', ['mcp:invoke', 'files:read', 'files:write', 'agent:invoke']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([writer.record]),
		TTK_DATA_DIR: dir,
		TTK_MAX_BODY_KB: '1',
	});
	const library = new LibraryStore({ dataDir: dir });
	await library.initialize();
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
		library,
	});
	const send = async (
		method: string,
		path: string,
		body: BodyInit,
		headers: Record<string, string> = {},
		token: string | null = writer.key,
	): Promise<{ status: number; type?: string; detail?: string }> => {
		const response = await gateway.app.request(`${ORIGIN}${path}`, {
			method,
			headers: {
				host: '127.0.0.1:8787',
				'content-type': 'application/json',
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
				...headers,
			},
			body,
		});
		const text = await response.text();
		let parsed: { type?: string; detail?: string } = {};
		try {
			parsed = JSON.parse(text);
		} catch {
			// Not every answer is JSON.
		}
		return { status: response.status, ...parsed };
	};
	try {
		// By declared length: refused before a byte is read.
		const declared = await send('POST', '/api/v1/share/mkdir', jsonOf(2 * KIB), { 'content-length': String(2 * KIB) });
		assertEquals(declared.status, 413);
		assertEquals(declared.type, 'https://tykotech.eu/problems/payload-too-large');
		assertEquals(declared.detail, `the request body is over ${KIB} bytes`);

		// By counted stream: no declared length, so only counting can catch it.
		assertEquals((await send('POST', '/api/v1/share/mkdir', streamed(2 * KIB))).status, 413);
		assertEquals((await send('POST', '/a2a', streamed(2 * KIB))).status, 413, '/a2a is capped too');

		// The cap stands in front of the credential check: an over-cap body is never buffered for anyone.
		assertEquals((await send('POST', '/api/v1/share/mkdir', streamed(2 * KIB), {}, null)).status, 413);

		// Under the cap, the body reaches the route intact through the rebuilt request.
		const made = await send('POST', '/api/v1/share/mkdir', JSON.stringify({ path: 'kept' }));
		assertEquals(made.status, 201);
		assert((await Deno.stat(join(dir, 'share', 'kept'))).isDirectory);

		// The share upload keeps its own 64 MiB cap: 64 KiB is far over TTK_MAX_BODY_KB and still lands.
		const upload = await gateway.app.request(`${ORIGIN}/api/v1/share/file?path=big.bin`, {
			method: 'PUT',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${writer.key}`,
				'content-type': 'application/octet-stream',
			},
			body: new Uint8Array(64 * KIB).fill(7),
		});
		assertEquals(upload.status, 201, await upload.text());
		assertEquals((await Deno.stat(join(dir, 'share', 'big.bin'))).size, 64 * KIB);

		// Sign-in keeps its 16 KiB: 4 KiB is over TTK_MAX_BODY_KB and is still read (and refused as a credential) ...
		const login = await send('POST', '/api/v1/auth/login', jsonOf(4 * KIB), {}, null);
		assertEquals(login.status, 400, 'parsed and answered by the route, not refused by size');
		// ... and past 16 KiB it is refused before the adapter's JSON parse could buffer it.
		assertEquals((await send('POST', '/api/v1/auth/login', streamed(LOGIN_BODY_BYTES + 1), {}, null)).status, 413);

		// `/mcp` is not bound by TTK_MAX_BODY_KB (a 4 KiB call is answered by MCP) but by E-83's 4 MiB.
		const call = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'browser_list_sessions', arguments: { pad: 'x'.repeat(4 * KIB) } },
		});
		const mcp = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${writer.key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: call,
		});
		assertEquals(mcp.status, 200);
		await mcp.body?.cancel();
		assertEquals((await send('POST', '/mcp', streamed(MCP_BODY_BYTES + 1))).status, 413);
	} finally {
		await gateway.close();
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('R1-1: an anonymous JSON body is refused at the cap on every path, before the adapter can buffer it', async () => {
	const dir = join('tests/.scratch', `bodycap-json-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const writer = await generateApiKey('writer', ['mcp:invoke', 'files:read', 'files:write']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([writer.record]),
		TTK_DATA_DIR: dir,
		TTK_MAX_BODY_KB: '1',
	});
	const library = new LibraryStore({ dataDir: dir });
	await library.initialize();
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
		library,
	});
	const total = 64 * KIB;
	try {
		const cases: Array<[string, string, number]> = [
			['POST', '/', 413],
			['POST', '/healthz', 413],
			['POST', '/mcp/', 413],
			// A non-canonical path is refused before its body is looked at (R1-5); either way nothing is buffered.
			['POST', '//api/v1/x', 400],
			['POST', '/.well-known/x', 413],
			['POST', '/live/x', 413],
			['PATCH', '/nope', 413],
			['PUT', '/api/v1/share/file?path=big.json', 413],
		];
		for (const [method, path, status] of cases) {
			const { body, pulled } = counted(total);
			const response = await gateway.app.request(`${ORIGIN}${path}`, {
				method,
				headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' },
				body,
			});
			const text = await response.text();
			assertEquals(response.status, status, `${method} ${path}: ${text}`);
			assert(pulled() <= 8 * KIB, `${method} ${path}: ${pulled()} of ${total} bytes were read; the cap is ${KIB}`);
		}
		// The same upload as a file, not as JSON, still streams to the route under its own 64 MiB cap.
		const upload = await gateway.app.request(`${ORIGIN}/api/v1/share/file?path=big.bin`, {
			method: 'PUT',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${writer.key}`,
				'content-type': 'application/octet-stream',
			},
			body: new Uint8Array(total).fill(7),
		});
		assertEquals(upload.status, 201, await upload.text());
	} finally {
		await gateway.close();
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});
