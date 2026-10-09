/**
 * D-083: the identity provider's own metadata, and the keys it names.
 */
import { assert, assertEquals } from '@std/assert';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, OAuthVerifier, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { IssuerMetadata, METADATA_MAX_BYTES, METADATA_TTL_MS, metadataUrls } from './oauth_discovery.ts';

Deno.test('discovery: RFC 8414 inserts the well-known segment before the issuer path, then OIDC appends', () => {
	assertEquals(metadataUrls(new URL('https://idp.example.com/realms/x')).map((u) => u.href), [
		'https://idp.example.com/.well-known/oauth-authorization-server/realms/x',
		'https://idp.example.com/realms/x/.well-known/openid-configuration',
	]);
	assertEquals(metadataUrls(new URL('https://idp.example.com/')).map((u) => u.href), [
		'https://idp.example.com/.well-known/oauth-authorization-server',
		'https://idp.example.com/.well-known/openid-configuration',
	]);
});

Deno.test('discovery: falls through to OIDC, refuses a foreign issuer, oversize and plain http, and caches', async () => {
	const issuer = new URL('https://idp.example.com/realms/x');
	const asked: string[] = [];
	let now = 0;
	let mode: 'ok' | 'foreign' | 'big' | 'down' = 'ok';
	const fake = (input: string | URL | Request): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		asked.push(url);
		if (mode === 'down') return Promise.reject(new TypeError('connection refused'));
		if (url.includes('oauth-authorization-server')) return Promise.resolve(new Response('no', { status: 404 }));
		if (mode === 'big') return Promise.resolve(new Response('x'.repeat(METADATA_MAX_BYTES + 1)));
		return Promise.resolve(Response.json({
			issuer: mode === 'foreign' ? 'https://evil.example.com/' : issuer.href,
			authorization_endpoint: 'https://idp.example.com/realms/x/protocol/openid-connect/auth',
			token_endpoint: 'https://idp.example.com/realms/x/protocol/openid-connect/token',
			jwks_uri: 'https://idp.example.com/realms/x/protocol/openid-connect/certs',
		}));
	};
	const metadata = new IssuerMetadata(issuer, { fetch: fake as typeof fetch, now: () => now });
	const document = await metadata.get();
	assertEquals(document?.authorization_endpoint, 'https://idp.example.com/realms/x/protocol/openid-connect/auth');
	assertEquals((await metadata.jwksUri())?.href, 'https://idp.example.com/realms/x/protocol/openid-connect/certs');
	assertEquals(asked.length, 2, 'RFC 8414 location tried first, then OIDC');

	// Cached within the TTL; after it, a failed refresh keeps the last good copy.
	await metadata.get();
	assertEquals(asked.length, 2);
	now += METADATA_TTL_MS + 1;
	mode = 'down';
	assertEquals((await metadata.get())?.issuer, issuer.href);
	assert(metadata.lastError.includes('connection refused'));

	for (const bad of ['foreign', 'big'] as const) {
		mode = bad;
		const fresh = new IssuerMetadata(issuer, { fetch: fake as typeof fetch });
		assertEquals(await fresh.get(), null, `${bad} must be refused`);
		assert(fresh.lastError !== '');
	}
	const plain = new IssuerMetadata(new URL('http://idp.example.com/x'), { fetch: fake as typeof fetch });
	assertEquals(await plain.get(), null);
	assert(plain.lastError.includes('only https'));
});

/** A minimal identity provider on loopback: OIDC metadata and a JWKS. */
async function provider() {
	const { publicKey, privateKey } = await generateKeyPair('RS256');
	const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
	let base = '';
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		const path = new URL(request.url).pathname;
		if (path === '/realms/x/.well-known/openid-configuration') {
			return Response.json({
				issuer: `${base}/realms/x`,
				authorization_endpoint: `${base}/realms/x/protocol/openid-connect/auth`,
				token_endpoint: `${base}/realms/x/protocol/openid-connect/token`,
				jwks_uri: `${base}/realms/x/protocol/openid-connect/certs`,
				response_types_supported: ['code'],
			});
		}
		if (path === '/realms/x/protocol/openid-connect/certs') return Response.json({ keys: [jwk] });
		return new Response('not found', { status: 404 });
	});
	base = `http://127.0.0.1:${server.addr.port}`;
	return { base, issuer: `${base}/realms/x`, privateKey, server };
}

Deno.test('discovery: the route passes the provider document through, and tokens verify with its keys', async () => {
	const idp = await provider();
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_OAUTH_ISSUER: idp.issuer,
		TTK_OAUTH_AUDIENCE: 'http://127.0.0.1:8787/',
	});
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const gateway = createGatewayApp({
		config,
		verifier,
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
	});
	try {
		const as = await gateway.app.request('http://127.0.0.1:8787/.well-known/oauth-authorization-server', {
			headers: { host: '127.0.0.1:8787' },
		});
		assertEquals(as.status, 200);
		const document = await as.json();
		assertEquals(document.authorization_endpoint, `${idp.base}/realms/x/protocol/openid-connect/auth`);
		assertEquals(document.token_endpoint, `${idp.base}/realms/x/protocol/openid-connect/token`);

		// A token signed by the provider verifies through the discovered jwks_uri.
		const oauth = new OAuthVerifier(config.oauth!);
		const token = await new SignJWT({ scope: 'mcp:invoke files:read' })
			.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
			.setIssuer(idp.issuer)
			.setAudience('http://127.0.0.1:8787/')
			.setSubject('alice')
			.setExpirationTime('5m')
			.sign(idp.privateKey);
		const principal = await oauth.verify(token);
		assertEquals(principal?.id, 'alice');
		assertEquals([...principal!.scopes].sort(), ['files:read', 'mcp:invoke']);

		// In OAuth mode the challenge names the protected-resource metadata.
		const challenged = await gateway.app.request('http://127.0.0.1:8787/api/v1/tools', {
			headers: { host: '127.0.0.1:8787' },
		});
		assertEquals(challenged.status, 401);
		assert((challenged.headers.get('www-authenticate') ?? '').includes('resource_metadata'));
		await challenged.body?.cancel();
	} finally {
		await gateway.close();
		await idp.server.shutdown();
	}
});

Deno.test('discovery: a provider with no metadata is reported, never replaced by guessed endpoints', async () => {
	const dead = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		() => new Response('', { status: 404 }),
	);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_OAUTH_ISSUER: `http://127.0.0.1:${dead.addr.port}/realms/x`,
	});
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
	});
	try {
		const as = await gateway.app.request('http://127.0.0.1:8787/.well-known/oauth-authorization-server', {
			headers: { host: '127.0.0.1:8787' },
		});
		assertEquals(as.status, 500);
		assertEquals(as.headers.get('content-type'), 'application/problem+json');
		const body = await as.text();
		assert(!body.includes('/authorize') && !body.includes('/token'), 'no invented endpoint');
	} finally {
		await gateway.close();
		await dead.shutdown();
	}
});

Deno.test('discovery: without OAuth the challenge names no metadata document that does not exist (D-083)', async () => {
	const key = await generateApiKey('k', ['mcp:invoke']);
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', TTK_API_KEYS: JSON.stringify([key.record]) });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
	});
	try {
		const response = await gateway.app.request('http://127.0.0.1:8787/api/v1/tools', {
			headers: { host: '127.0.0.1:8787' },
		});
		assertEquals(response.status, 401);
		const challenge = response.headers.get('www-authenticate') ?? '';
		assert(challenge.toLowerCase().startsWith('bearer'), challenge);
		assert(!challenge.includes('resource_metadata'), challenge);
		await response.body?.cancel();
		const metadata = await gateway.app.request('http://127.0.0.1:8787/.well-known/oauth-protected-resource', {
			headers: { host: '127.0.0.1:8787' },
		});
		assert(metadata.status === 401 || metadata.status === 404, `got ${metadata.status}`);
		await metadata.body?.cancel();
	} finally {
		await gateway.close();
	}
});

Deno.test('BUG-3: a fractional exp gives an integer-millisecond oauth credential the link cap can read', async () => {
	// RFC 7519 §2 allows a non-integer NumericDate. `oauth:${exp * 1000}` turned exp 1791201600.1234 into
	// `oauth:1791201600123.4`, which the strict `^oauth:(\d+)$` reader (credentialNotAfterOf, packages/mcp) does not
	// match — so a valid expiring token was refused a signed link as having "no known expiry" (N3). Floored at the
	// producer; the reader stays strict.
	const idp = await provider();
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_OAUTH_ISSUER: idp.issuer,
		TTK_OAUTH_AUDIENCE: 'http://127.0.0.1:8787/',
	});
	try {
		const oauth = new OAuthVerifier(config.oauth!);
		const exp = Math.floor(Date.now() / 1000) + 600 + 0.1234;
		const token = await new SignJWT({ scope: 'mcp:invoke', exp })
			.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
			.setIssuer(idp.issuer)
			.setAudience('http://127.0.0.1:8787/')
			.setSubject('alice')
			.sign(idp.privateKey);
		const principal = await oauth.verify(token);
		assert(principal !== null, 'a token with a fractional exp verifies');
		assertEquals(principal.credential, `oauth:${Math.floor(exp * 1000)}`);
		assert(/^oauth:(\d+)$/.test(principal.credential ?? ''), `${principal.credential} is integer milliseconds`);
	} finally {
		await idp.server.shutdown();
	}
});
