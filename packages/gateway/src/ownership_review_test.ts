import { assert, assertEquals } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import {
	createGatewayApp,
	createLogger,
	generateApiKey,
	loadConfig,
	type Principal,
	principalFromAuthInfo,
	VerifierChain,
} from '@tykotech/gateway';
import { registerCatalog, SessionRegistry } from '@tykotech/mcp';
import { A2UI_CATALOG_ID } from '@tykotech/wire';

// The fixture substitutes only signature verification; the real auth gate, owner composition,
// delegation, scopes and stores remain under test without a disposable JWKS server.
const OAUTH_FIXTURE = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzYW1lLWlkIn0.';
class RealmFixtureVerifier extends VerifierChain {
	override async resolve(token: string): Promise<Principal | null> {
		if (token === OAUTH_FIXTURE) {
			return {
				kind: 'oauth',
				id: 'same-id',
				scopes: new Set(['mcp:invoke', 'agent:invoke', 'sandbox:execute', 'a2ui:publish']),
				credential: `oauth:${Date.now() + 3_600_000}`,
			};
		}
		return await super.resolve(token);
	}
}

Deno.test('security review: matching OAuth/API ids stay separate through MCP and REST surface ownership', async (): Promise<void> => {
	const api = await generateApiKey('same-id', ['mcp:invoke', 'agent:invoke', 'a2ui:publish']);
	const config = loadConfig({ TTK_API_KEYS: JSON.stringify([api.record]) });
	const verifier = new RealmFixtureVerifier({ config, allowAnonymous: false });
	const apiAuth = await verifier.verifyAccessToken(api.key);
	const oauthAuth = await verifier.verifyAccessToken(OAUTH_FIXTURE);
	assertEquals(principalFromAuthInfo(apiAuth).kind, 'api-key');
	assertEquals(principalFromAuthInfo(oauthAuth).kind, 'oauth');
	const registry = new SessionRegistry();
	const apiServer = new McpServer({ name: 'realm-api-review', version: '1' });
	const oauthServer = new McpServer({ name: 'realm-oauth-review', version: '1' });
	const gateway = createGatewayApp({
		config,
		verifier,
		registry,
		version: 'review',
		logger: createLogger({ level: 'error', write: (): void => {} }),
	});
	try {
		const apiDispatch = registerCatalog(apiServer, { registry, version: 'review' }, apiAuth);
		const oauthDispatch = registerCatalog(oauthServer, { registry, version: 'review' }, oauthAuth);
		assertEquals(apiDispatch.ctx.extensionPrincipal, 'api-key:same-id');
		assertEquals(oauthDispatch.ctx.extensionPrincipal, 'oauth:same-id');
		const publish = await gateway.app.request('http://127.0.0.1:8787/api/v1/a2ui/surfaces', {
			method: 'POST',
			headers: { host: '127.0.0.1:8787', authorization: `Bearer ${api.key}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				version: 'v0.9',
				createSurface: { surfaceId: 'realm-owned', catalogId: A2UI_CATALOG_ID },
			}),
		});
		assertEquals(publish.status, 200, await publish.text());
		const foreign = await gateway.app.request('http://127.0.0.1:8787/api/v1/a2ui/surfaces', {
			headers: { host: '127.0.0.1:8787', authorization: `Bearer ${OAUTH_FIXTURE}` },
		});
		assertEquals(foreign.status, 200);
		assertEquals((await foreign.json()).surfaces, []);
		const deniedDelete = await gateway.app.request('http://127.0.0.1:8787/api/v1/a2ui/surfaces', {
			method: 'POST',
			headers: { host: '127.0.0.1:8787', authorization: `Bearer ${OAUTH_FIXTURE}`, 'content-type': 'application/json' },
			body: JSON.stringify({ version: 'v0.9', deleteSurface: { surfaceId: 'realm-owned' } }),
		});
		assertEquals(deniedDelete.status, 404);
		await deniedDelete.body?.cancel();
	} finally {
		await Promise.all([apiServer.close(), oauthServer.close()]);
		await gateway.close();
		await registry.shutdown();
	}
});

Deno.test('security review: an anonymous-looking API id preserves its verified realm', async (): Promise<void> => {
	const api = await generateApiKey('anonymous:127.0.0.1', ['mcp:invoke']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([api.record]) }),
		allowAnonymous: false,
	});
	assertEquals(principalFromAuthInfo(await verifier.verifyAccessToken(api.key)).kind, 'api-key');
});

Deno.test('security review: rotating a parent API credential revokes its delegated bearer', async (): Promise<void> => {
	const original = await generateApiKey('rotating', ['mcp:invoke', 'sandbox:execute']);
	const replacement = await generateApiKey('rotating', ['mcp:invoke', 'sandbox:execute']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([original.record]) }),
		allowAnonymous: false,
	});
	const { credential } = principalFromAuthInfo(await verifier.verifyAccessToken(original.key));
	const delegated = await verifier.delegateMcp(
		'api-key:rotating',
		new Set(['mcp:invoke', 'sandbox:execute']),
		credential,
	);
	assert(delegated);
	assert(await verifier.resolve(delegated.token));
	verifier.replaceApiKeys([replacement.record]);
	assertEquals(await verifier.resolve(original.key), null);
	assertEquals(await verifier.resolve(delegated.token), null);
	await verifier.verifyAccessToken(replacement.key);
	assertEquals(await verifier.resolve(delegated.token), null);
	delegated.close();
	verifier.closeDelegations();
});

Deno.test('security review: colliding API records cannot change OAuth delegated scopes', async (): Promise<void> => {
	const api = await generateApiKey('same-id', ['mcp:invoke']);
	const verifier = new RealmFixtureVerifier({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([api.record]) }),
		allowAnonymous: false,
	});
	const { credential } = principalFromAuthInfo(await verifier.verifyAccessToken(OAUTH_FIXTURE));
	const delegated = await verifier.delegateMcp('oauth:same-id', new Set(['mcp:invoke', 'sandbox:execute']), credential);
	assert(delegated);
	assertEquals([...(await verifier.resolve(delegated.token))!.scopes], ['mcp:invoke', 'sandbox:execute']);
	delegated.close();
	verifier.closeDelegations();
});
