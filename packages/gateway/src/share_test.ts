/**
 * D-075: the file share over HTTP — streamed upload and download, scope gating, path rules.
 */
import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { LibraryStore, SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';

Deno.test('share: upload and download stream byte-identically, writes need files:write, paths are the store rules', async () => {
	const dir = join('tests/.scratch', `share-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const reader = await generateApiKey('reader', ['mcp:invoke', 'files:read']);
	const writer = await generateApiKey('writer', ['mcp:invoke', 'files:read', 'files:write']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([reader.record, writer.record]),
		TTK_DATA_DIR: dir,
	});
	const library = new LibraryStore({ dataDir: dir });
	await library.initialize();
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier,
		registry,
		version: 'test',
		logger: createLogger({ level: 'error' }),
		library,
	});
	const call = (method: string, path: string, token: string, body?: BodyInit, type?: string) =>
		gateway.app.request(`${ORIGIN}${path}`, {
			method,
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${token}`,
				...(type === undefined ? {} : { 'content-type': type }),
			},
			...(body === undefined ? {} : { body }),
		});
	try {
		// 5 MiB of pseudo-random bytes, uploaded as a raw body.
		const payload = new Uint8Array(5 * 1024 * 1024);
		for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 2654435761) >>> 24;
		const forbidden = await call(
			'PUT',
			'/api/v1/share/file?path=big.bin',
			reader.key,
			payload,
			'application/octet-stream',
		);
		assertEquals(forbidden.status, 403);
		const uploaded = await call(
			'PUT',
			'/api/v1/share/file?path=blobs/big.bin',
			writer.key,
			payload,
			'application/octet-stream',
		);
		assertEquals(uploaded.status, 201);
		assertEquals((await uploaded.json()).size, payload.length);

		const downloaded = await call('GET', '/api/v1/share/file?path=blobs/big.bin', reader.key);
		assertEquals(downloaded.status, 200);
		assertEquals(downloaded.headers.get('content-disposition')?.startsWith('attachment;'), true);
		assertEquals(downloaded.headers.get('x-content-type-options'), 'nosniff');
		const bytes = new Uint8Array(await downloaded.arrayBuffer());
		assertEquals(bytes.length, payload.length);
		let same = true;
		for (let i = 0; i < bytes.length; i += 4096) if (bytes[i] !== payload[i]) same = false;
		assert(same, 'the bytes round-tripped');

		const listing = await call('GET', '/api/v1/share?path=blobs', reader.key);
		assertEquals((await listing.json()).entries.map((entry: { name: string }) => entry.name), ['big.bin']);

		// Path rules and problems.
		assertEquals((await call('GET', '/api/v1/share/file?path=../deno.json', reader.key)).status, 400);
		assertEquals((await call('GET', '/api/v1/share/file?path=missing.bin', reader.key)).status, 404);
		assertEquals((await call('GET', '/api/v1/share/file?path=blobs', reader.key)).status, 400);
		const mkdir = await call(
			'POST',
			'/api/v1/share/mkdir',
			writer.key,
			JSON.stringify({ path: 'docs' }),
			'application/json',
		);
		assertEquals(mkdir.status, 201);
		const move = await call(
			'POST',
			'/api/v1/share/move',
			writer.key,
			JSON.stringify({ from: 'blobs/big.bin', to: 'docs/big.bin' }),
			'application/json',
		);
		assertEquals(move.status, 200);
		assertEquals((await call('DELETE', '/api/v1/share?path=docs', writer.key)).status, 409, 'not empty');
		assertEquals((await call('DELETE', '/api/v1/share?path=docs&recursive=true', writer.key)).status, 204);
		assertEquals((await call('DELETE', '/api/v1/share?path=blobs', reader.key)).status, 403);
		assertEquals((await call('GET', '/api/v1/share?path=', reader.key)).status, 200);

		// An upload that declares more than the limit is refused before any byte lands.
		const huge = await gateway.app.request(`${ORIGIN}/api/v1/share/file?path=huge.bin`, {
			method: 'PUT',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${writer.key}`,
				'content-type': 'application/octet-stream',
				'content-length': String(65 * 1024 * 1024),
			},
			body: new Uint8Array(16),
		});
		assertEquals(huge.status, 413);
	} finally {
		await gateway.close();
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('share: without a data directory the routes answer persistence-required', async () => {
	const key = await generateApiKey('writer', ['mcp:invoke', 'files:read', 'files:write']);
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_API_KEYS: JSON.stringify([key.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier,
		registry,
		version: 'test',
		logger: createLogger({ level: 'error' }),
	});
	try {
		const response = await gateway.app.request(`${ORIGIN}/api/v1/share?path=`, {
			headers: { host: '127.0.0.1:8787', authorization: `Bearer ${key.key}` },
		});
		assertEquals(response.status, 409);
		assertEquals((await response.json()).type, 'https://tykotech.eu/problems/persistence-required');
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});
